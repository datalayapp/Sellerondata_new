import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { prisma } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';
import {
  explainSignupPurge,
  findSignupPurgeCandidates,
  maskEmail,
  purgeSignupCandidate,
  purgeSignups,
  SIGNUP_PURGE_DAYS_MIN,
} from '../src/lib/signupPurge.ts';
import { closeOrg } from '../src/lib/subscriptions.ts';
import { addMember, API, getApp, PASSWORD, randomEmail, randomIp, randomTrPhone, recreateMembershipOrgFk, registerOrg, uniq } from './helpers.ts';
import { TEST_APP_URL } from './testEnv.ts';

/**
 * 04-B8: e-postasını hiç doğrulamamış, hiç giriş yapmamış eski kayıtları temizleyen destek komutu (`signup:purge`).
 * Aday koşulu dardır; her dışlama ayrı sınanır. Zaman: kayıt tarihi veritabanında geriye yazılır, bekleme yok.
 */

const OP = 'destek-ayse';
const DAY = 86_400_000;
const API_ROOT = path.resolve(import.meta.dirname, '..');
const TSX = path.join(API_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
});

type Signup = { personId: string; orgId: string; membershipId: string; email: string };

/** Üretimdeki yol: doğrulama zorunluyken kayıt (oturum yok, 202). */
async function signup(): Promise<Signup> {
  const email = randomEmail('kayit');
  process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
  try {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: `Firma ${uniq()}`, name: 'Sahip', email, password: PASSWORD, country: 'TR', client: 'mobile' },
    });
    expect(res.statusCode, res.body).toBe(202);
  } finally {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
  }
  await flushMail();
  const person = await prisma.person.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const [m] = person.memberships;
  return { personId: person.id, orgId: m.orgId, membershipId: m.id, email };
}

/** Kaydı geçmişe iter: kişi ve kayıtta üretilen doğrulama jetonu aynı ana (gerçekte ikisi kayıt anında yazılır). */
async function age(personId: string, days = 8) {
  const at = new Date(Date.now() - days * DAY);
  await prisma.person.update({ where: { id: personId }, data: { createdAt: at } });
  await prisma.oneTimeToken.updateMany({ where: { personId }, data: { createdAt: at } });
}

/** Eski, doğrulanmamış, hiç giriş yapmamış kayıt: aday. */
async function staleSignup(): Promise<Signup> {
  const s = await signup();
  await age(s.personId);
  return s;
}

async function snapshot(s: Signup) {
  return {
    person: await prisma.person.count({ where: { id: s.personId } }),
    org: await prisma.organization.count({ where: { id: s.orgId } }),
    membership: await prisma.membership.count({ where: { orgId: s.orgId } }),
    subscription: await prisma.subscription.count({ where: { orgId: s.orgId } }),
    tokens: await prisma.oneTimeToken.count({ where: { personId: s.personId } }),
    outbox: await prisma.outbox.count({ where: { orgId: s.orgId } }),
    audit: await prisma.auditLog.count({ where: { OR: [{ orgId: s.orgId }, { target: s.personId }] } }),
  };
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX, 'scripts/signup-purge.ts', ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

describe('aday seçimi', () => {
  it('eski, doğrulanmamış, hiç giriş yapmamış kayıt adaydır', async () => {
    const s = await staleSignup();
    expect(await explainSignupPurge(s.personId)).toBeNull();
    const list = await findSignupPurgeCandidates();
    const mine = list.find((c) => c.personId === s.personId);
    expect(mine).toMatchObject({ personId: s.personId, orgIds: [s.orgId], maskedEmail: maskEmail(s.email) });
  });

  it('doğrulanmış kişi aday değil', async () => {
    const s = await staleSignup();
    await prisma.person.update({ where: { id: s.personId }, data: { emailVerifiedAt: new Date() } });
    expect(await explainSignupPurge(s.personId)).toBe('email_verified');
    expect((await findSignupPurgeCandidates()).map((c) => c.personId)).not.toContain(s.personId);
  });

  it('süreden genç kayıt aday değil; süre uzayınca eskisi de dışarıda kalır', async () => {
    const s = await signup();
    expect(await explainSignupPurge(s.personId)).toBe('too_recent');
    await age(s.personId, 10);
    expect(await explainSignupPurge(s.personId, { days: 30 })).toBe('too_recent');
    expect(await explainSignupPurge(s.personId, { days: 7 })).toBeNull();
    expect((await findSignupPurgeCandidates({ days: 30 })).map((c) => c.personId)).not.toContain(s.personId);
  });

  it('oturum satırı olan kişi aday değil', async () => {
    // Doğrulama zorunlu değilken kayıt oturum açar.
    const owner = await registerOrg(app);
    await age(owner.personId);
    expect(await prisma.session.count({ where: { personId: owner.personId } })).toBeGreaterThan(0);
    expect(await explainSignupPurge(owner.personId)).toBe('has_session');
    expect((await findSignupPurgeCandidates()).map((c) => c.personId)).not.toContain(owner.personId);
  });

  it('oturum satırı kalmasa da denetim izinde session.created varsa aday değil', async () => {
    const s = await staleSignup();
    await prisma.auditLog.create({ data: { actorPersonId: s.personId, action: 'session.created', target: crypto.randomUUID() } });
    expect(await explainSignupPurge(s.personId)).toBe('person_activity');
    expect((await findSignupPurgeCandidates()).map((c) => c.personId)).not.toContain(s.personId);
  });

  it('süre içinde doğru şifreyle giriş denemiş (yeni doğrulama bağlantısı almış) kişi aday değil; iz bırakmayan ilgi de korunur', async () => {
    const s = await staleSignup();
    expect(await explainSignupPurge(s.personId)).toBeNull();
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      payload: { identifier: s.email, password: PASSWORD, client: 'mobile' },
    });
    expect(res.statusCode, res.body).toBe(403);
    await flushMail();
    // Giriş denemesi oturum ve denetim izi bırakmaz; yalnız yeni doğrulama jetonu üretir.
    expect(await prisma.session.count({ where: { personId: s.personId } })).toBe(0);
    expect(await explainSignupPurge(s.personId)).toBe('recent_token');
    expect((await findSignupPurgeCandidates()).map((c) => c.personId)).not.toContain(s.personId);
    expect(await purgeSignupCandidate(s.personId, { operator: OP })).toEqual({ purged: false, reason: 'recent_token' });
    expect(await prisma.person.count({ where: { id: s.personId } })).toBe(1);
  });

  it('firmasında ikinci üye olan kişi aday değil', async () => {
    const s = await staleSignup();
    await addMember(app, s.orgId);
    expect(await explainSignupPurge(s.personId)).toBe('shared_org');
  });

  it('firmasında davet (geri alınmış olsa da) olan kişi aday değil', async () => {
    const s = await staleSignup();
    await prisma.invitation.create({
      data: {
        orgId: s.orgId,
        kind: 'EMAIL',
        email: randomEmail('davet'),
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + DAY),
        invitedById: s.membershipId,
        revokedAt: new Date(),
      },
    });
    expect(await explainSignupPurge(s.personId)).toBe('org_invitations');
  });

  it('telefonu olan kişi aday değil', async () => {
    const s = await staleSignup();
    await prisma.person.update({ where: { id: s.personId }, data: { phone: randomTrPhone() } });
    expect(await explainSignupPurge(s.personId)).toBe('has_phone');
  });

  it('başka firmada üyeliği olan kişi aday değil', async () => {
    const s = await staleSignup();
    const other = await registerOrg(app);
    await prisma.membership.create({ data: { personId: s.personId, orgId: other.orgId, orgRole: 'MEMBER' } });
    expect(await explainSignupPurge(s.personId)).toBe('membership_count');
  });

  it('bekleyen e-posta, askı, destek kaydı ya da başka firmadan e-posta daveti varsa aday değil', async () => {
    const a = await staleSignup();
    await prisma.person.update({ where: { id: a.personId }, data: { pendingEmail: randomEmail('yeni') } });
    expect(await explainSignupPurge(a.personId)).toBe('pending_email');

    const b = await staleSignup();
    await prisma.person.update({ where: { id: b.personId }, data: { suspendedAt: new Date() } });
    expect(await explainSignupPurge(b.personId)).toBe('suspended');

    const c = await staleSignup();
    await closeOrg(c.orgId, { operator: OP });
    expect(await explainSignupPurge(c.personId)).toBe('org_activity');

    const d = await staleSignup();
    const other = await registerOrg(app);
    await prisma.invitation.create({
      data: {
        orgId: other.orgId,
        kind: 'EMAIL',
        email: d.email,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + DAY),
        invitedById: other.membershipId,
      },
    });
    expect(await explainSignupPurge(d.personId)).toBe('invited_elsewhere');
  });

  it('süre sınırı: en az 7 gün', async () => {
    expect(SIGNUP_PURGE_DAYS_MIN).toBe(7);
    await expect(findSignupPurgeCandidates({ days: 3 })).rejects.toThrow(/--days/);
  });

  it('e-posta maskelenir', () => {
    expect(maskEmail('ali.veli@alan.com')).toBe('a***@alan.com');
    expect(maskEmail('x@y.org')).toBe('x***@y.org');
  });
});

describe('kuru çalışma', () => {
  it('--yes yoksa hiçbir satır değişmez, çıkış 2, adres maskeli', async () => {
    const s = await staleSignup();
    const before = await snapshot(s);
    const res = runCli(['--operator', OP]);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(2);
    expect(res.stdout).toContain(s.personId);
    expect(res.stdout).toContain(s.orgId);
    expect(res.stdout).toContain(maskEmail(s.email));
    expect(`${res.stdout}${res.stderr}`).not.toContain(s.email);
    expect(res.stderr).toContain('--yes');
    expect(await snapshot(s)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'support.signup_purged', target: s.personId } })).toBe(0);
  });

  it('operatörsüz ya da kısa süreyle kullanım hatası (çıkış 2), değişiklik yok', async () => {
    const s = await staleSignup();
    const before = await snapshot(s);
    const noOp = runCli(['--yes']);
    expect(noOp.status).toBe(2);
    expect(noOp.stderr).toContain('--operator');
    const short = runCli(['--operator', OP, '--days', '3', '--yes']);
    expect(short.status).toBe(2);
    expect(short.stderr).toContain('--days');
    expect(await snapshot(s)).toEqual(before);
  });
});

describe('silme', () => {
  it('--yes kişi, firma, üyelik, abonelik satırlarını siler; olaylar Outbox’ta kalır; denetim kaydı yazılır; başkalarına dokunulmaz', async () => {
    const s = await staleSignup();
    const membership = await prisma.membership.findUniqueOrThrow({ where: { id: s.membershipId } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId: s.orgId, product: 'deciship' } } });
    // Başkaları: oturumlu firma (ikinci üyesiyle) ve aday olmayan doğrulanmış kayıt.
    const other = await registerOrg(app);
    const otherMember = await addMember(app, other.orgId);
    const verified = await staleSignup();
    await prisma.person.update({ where: { id: verified.personId }, data: { emailVerifiedAt: new Date() } });
    const otherBefore = await snapshot({ ...other, email: other.email as string });
    const verifiedBefore = await snapshot(verified);
    const otherOutbox = await prisma.outbox.count({ where: { orgId: { in: [other.orgId, verified.orgId] } } });

    const result = await purgeSignups({ operator: OP });
    const done = result.purged.find((p) => p.personId === s.personId);
    expect(done).toMatchObject({ personId: s.personId, orgIds: [s.orgId], maskedEmail: maskEmail(s.email) });
    expect(result.failed).toEqual([]);
    expect(result.purged.map((p) => p.personId)).not.toContain(verified.personId);

    expect(await prisma.person.count({ where: { id: s.personId } })).toBe(0);
    expect(await prisma.organization.count({ where: { id: s.orgId } })).toBe(0);
    expect(await prisma.membership.count({ where: { id: s.membershipId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { orgId: s.orgId } })).toBe(0);
    expect(await prisma.oneTimeToken.count({ where: { personId: s.personId } })).toBe(0);

    // Ürünlere bildirim: firma silindikten sonra da kuyrukta, teslim satırıyla.
    const removed = await prisma.outbox.findMany({ where: { orgId: s.orgId, type: 'member.removed' }, include: { deliveries: true } });
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({ membershipId: s.membershipId, personId: s.personId, product: 'deciship', epoch: membership.epoch + 1 });
    expect(removed[0].deliveries.map((d) => [d.target, d.status])).toEqual([['deciship', 'PENDING']]);
    const canceled = await prisma.outbox.findMany({ where: { orgId: s.orgId, type: 'subscription.updated' }, include: { deliveries: true } });
    const last = canceled.map((r) => r.payload as { status: string; version: number }).sort((a, b) => b.version - a.version)[0];
    expect(last).toMatchObject({ status: 'CANCELED', version: sub.version + 1, plan: sub.plan });
    expect(canceled.every((r) => r.deliveries.length === 1)).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { action: 'support.signup_purged', target: s.personId } });
    expect(audit).toHaveLength(1);
    expect(audit[0].orgId).toBeNull();
    expect(audit[0].meta).toEqual({ personId: s.personId, orgIds: [s.orgId], operator: OP, days: 7 });
    expect(JSON.stringify(audit[0])).not.toContain(s.email);

    expect(await snapshot({ ...other, email: other.email as string })).toEqual(otherBefore);
    expect(await prisma.membership.count({ where: { id: otherMember.membershipId } })).toBe(1);
    expect(await snapshot(verified)).toEqual(verifiedBefore);
    expect(await prisma.outbox.count({ where: { orgId: { in: [other.orgId, verified.orgId] } } })).toBe(otherOutbox);
  });

  it('komutla --yes: siler, çıktıda adres maskeli', async () => {
    const s = await staleSignup();
    const res = runCli(['--operator', OP, '--yes']);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain(s.personId);
    expect(res.stdout).toContain(maskEmail(s.email));
    expect(`${res.stdout}${res.stderr}`).not.toContain(s.email);
    expect(await prisma.person.count({ where: { id: s.personId } })).toBe(0);
    expect(await prisma.organization.count({ where: { id: s.orgId } })).toBe(0);
  });

  it('sıra: firma önce silinir; sahip tetikleyicisi yalnız üyelik silinince devreye girer', async () => {
    const s = await staleSignup();
    // Tetikleyici etkin: firma dururken tek sahibin üyeliği silinemez.
    await expect(prisma.$transaction((tx) => tx.membership.delete({ where: { id: s.membershipId } }))).rejects.toThrow(/sahibi kalmaz/);
    expect(await prisma.membership.count({ where: { id: s.membershipId } })).toBe(1);
    const r = await purgeSignupCandidate(s.personId, { operator: OP });
    expect(r).toMatchObject({ purged: true });
    expect(await prisma.person.count({ where: { id: s.personId } })).toBe(0);
  });

  it('özel roldeki sahip: araç erişimi firmadan önce açıkça silinir, zincirleme sırası yabancı anahtara takılmaz', async () => {
    await recreateMembershipOrgFk();
    const s = await staleSignup();
    const role = await prisma.productRole.create({ data: { orgId: s.orgId, product: 'deciship', name: 'Özel', permissions: ['deciship.web.access'] } });
    await prisma.productAccess.upsert({
      where: { membershipId_product: { membershipId: s.membershipId, product: 'deciship' } },
      create: { membershipId: s.membershipId, product: 'deciship', role: `custom:${role.id}`, customRoleId: role.id },
      update: { role: `custom:${role.id}`, customRoleId: role.id },
    });
    const r = await purgeSignupCandidate(s.personId, { operator: OP });
    expect(r).toMatchObject({ purged: true });
    expect(await prisma.organization.count({ where: { id: s.orgId } })).toBe(0);
    expect(await prisma.productRole.count({ where: { id: role.id } })).toBe(0);
  });

  it('liste ile silme arasında doğrulayan kişi silinmez', async () => {
    const s = await staleSignup();
    expect((await findSignupPurgeCandidates()).map((c) => c.personId)).toContain(s.personId);
    await prisma.person.update({ where: { id: s.personId }, data: { emailVerifiedAt: new Date() } });
    const r = await purgeSignupCandidate(s.personId, { operator: OP });
    expect(r).toEqual({ purged: false, reason: 'email_verified' });
    const after = await snapshot(s);
    expect(after).toMatchObject({ person: 1, org: 1, membership: 1, subscription: 1 });
    expect(await prisma.outbox.count({ where: { orgId: s.orgId, type: 'member.removed' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'support.signup_purged', target: s.personId } })).toBe(0);
  });

  it('kişi kilidini tutan doğrulama bitene kadar bekler, sonra yeniden denetleyip silmez', async () => {
    const s = await staleSignup();
    const client = new pg.Client({ connectionString: TEST_APP_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // Doğrulama ucu gibi: kişi satırı kilitli, emailVerifiedAt yazıldı, işlem henüz bitmedi.
      await client.query(`UPDATE platform."Person" SET "emailVerifiedAt" = now() WHERE id = $1`, [s.personId]);
      let settled = false;
      const pending = purgeSignupCandidate(s.personId, { operator: OP }).finally(() => {
        settled = true;
      });
      // Silme işlemi kişi kilidinde beklemeye girene kadar (koşula bağlı yoklama, sabit bekleme yok). Kilit beklemeden biterse
      // döngüden çıkılır ve aşağıdaki beklenti kırılır.
      let waited = false;
      while (!settled) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        );
        if (rows[0].n > 0) {
          waited = true;
          break;
        }
        await new Promise((r) => setImmediate(r));
      }
      expect(waited).toBe(true);
      await client.query('COMMIT');
      expect(await pending).toEqual({ purged: false, reason: 'email_verified' });
    } finally {
      await client.end();
    }
    expect(await prisma.person.count({ where: { id: s.personId } })).toBe(1);
    expect(await prisma.organization.count({ where: { id: s.orgId } })).toBe(1);
  });
});
