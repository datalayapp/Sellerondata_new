// Tur 2 regresyonları: istenen davranışı doğrular. Düşen test bulgudur.
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { assertProductionConfig } from '../src/env.ts';
import { normalizeEmail } from '../src/lib/identity.ts';
import { lockMemberships, removeMembership } from '../src/lib/members.ts';
import { newPassword } from '../src/lib/schemas.ts';
import { addMember, API, bearer, cookieHeader, errorCode, getApp, login, parseSetCookies, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, webHeaders, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function web(email: string) {
  const c = parseSetCookies(await login(app, email, PASSWORD, 'web'));
  return cookieHeader({ sod_at: c.sod_at });
}

describe('X-SOD-Org', () => {
  it('çerezli her firma yazması başlıksız 409, CSRF eksikse önce 403', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const cookie = await web(owner.email as string);
    const id = admin.membershipId;
    const routes: [string, string, unknown][] = [
      ['PATCH', '/org', { name: 'Yeni' }],
      ['POST', '/org/leave', {}],
      ['POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail() }],
      ['PATCH', `/org/members/${id}`, { status: 'SUSPENDED' }],
      ['DELETE', `/org/members/${id}`, undefined],
      ['POST', `/org/members/${id}/reset-code`, {}],
      ['POST', '/org/transfer-ownership', { membershipId: id, password: PASSWORD }],
      ['POST', '/org/invitations/yok/resend', {}],
      ['DELETE', '/org/invitations/yok', undefined],
      ['POST', '/org/billing/checkout', {}],
    ];
    for (const [m, u, p] of routes) {
      const noHeader = await call(m, u, webHeaders(cookie), p);
      expect(errorCode(noHeader), `${m} ${u}`).toBe('ORG_MISMATCH');
      const noCsrf = await call(m, u, { cookie }, p);
      expect(errorCode(noCsrf), `${m} ${u} csrf`).toBe('CSRF_FAILED');
    }
    const row = await prisma.membership.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('GET uçları başlık istemez ve yan etki yazmaz', async () => {
    const owner = await registerOrg(app);
    const cookie = await web(owner.email as string);
    const counts = async () => [await prisma.auditLog.count({ where: { orgId: owner.orgId } }), await prisma.outbox.count({ where: { orgId: owner.orgId } }), await prisma.invitation.count({ where: { orgId: owner.orgId } })];
    const before = await counts();
    for (const u of ['/org', '/org/members', '/org/invitations', '/org/subscriptions', '/org/audit']) {
      expect((await call('GET', u, { cookie })).statusCode, u).toBe(200);
    }
    expect(await counts()).toEqual(before);
  });

  it('Bearer çerezi yok sayar, boş Authorization muafiyet vermez', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const cookieA = await web(a.email as string);
    // Kişi ucunda Bearer geçerli: yazma B kişisine gider, A'nın çerezi yok sayılır.
    const me = await call('PATCH', '/me', { ...b.headers, cookie: cookieA }, { locale: 'en' });
    expect(me.statusCode, me.body).toBe(200);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: b.personId } })).locale).toBe('en');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: a.personId } })).locale).toBe('tr');
    // Firma yazması tarayıcı oturumu ister (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer reddedilir, yanındaki çerez de onu kurtarmaz.
    const withBearer = await call('PATCH', '/org', { ...b.headers, cookie: cookieA }, { locale: 'en' });
    expect(withBearer.statusCode).toBe(403);
    expect(withBearer.json().error.details).toEqual({ reason: 'WEB_SESSION_REQUIRED' });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.orgId } })).locale).toBe('tr');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.orgId } })).locale).toBe('tr');
    const empty = await call('PATCH', '/org', { ...webHeaders(cookieA), authorization: '' }, { locale: 'en' });
    expect(empty.statusCode).toBe(401);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.orgId } })).locale).toBe('tr');
  });

  it('switch-org başlık istemez, CSRF ister; yinelenen başlık uyuşmaz; bayat üye TOKEN_STALE alır', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const p = await addMember(app, a.orgId, { orgRole: 'ADMIN' });
    await prisma.membership.create({ data: { personId: p.personId, orgId: b.orgId, orgRole: 'MEMBER' } });
    const cookie = await web(p.email as string);
    expect(errorCode(await call('POST', '/auth/switch-org', { cookie }, { orgId: b.orgId }))).toBe('CSRF_FAILED');
    const sw = await call('POST', '/auth/switch-org', webHeaders(cookie), { orgId: b.orgId });
    expect(sw.statusCode).toBe(200);
    const cookieA = await web(p.email as string);
    const dup = await call('PATCH', '/org', { ...webHeaders(cookieA), 'x-sod-org': `${a.orgId}, ${a.orgId}` }, { locale: 'en' });
    expect(errorCode(dup)).toBe('ORG_MISMATCH');
  });
});

describe('ACCOUNT_CODE_PEPPER', () => {
  it('biber dönünce doğru kod ölür ama deneme hakkı yakmaz', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const inv = await call('POST', '/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'Çalışan' });
    const { code, invitation } = inv.json();
    const saved = process.env.ACCOUNT_CODE_PEPPER;
    process.env.ACCOUNT_CODE_PEPPER = 'yeni-biber-yeni-biber-yeni-biber-1234';
    try {
      const res = await call('POST', '/auth/join/preview', {}, { phone, code });
      console.log('[KANIT] biber dönünce doğru kod:', res.statusCode, errorCode(res));
      expect(errorCode(res)).toBe('INVITE_INVALID');
      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
      console.log('[KANIT] biber dönünce attempts:', row.attempts);
      const re = await call('POST', `/org/invitations/${invitation.id}/resend`, await asWeb(owner), {});
      expect(re.statusCode).toBe(200);
      expect((await call('POST', '/auth/join/preview', {}, { phone, code: re.json().code })).statusCode).toBe(200);
      expect(row.attempts).toBe(0);
    } finally {
      process.env.ACCOUNT_CODE_PEPPER = saved;
    }
  });

  it('üretimde geliştirme biberi reddedilir', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://a',
        APP_BASE_URL: 'https://a',
        DATABASE_URL: 'postgresql://sod_platform:gercek-parola@db/sellerondata',
        ACCOUNT_CODE_PEPPER: 'sod-gelistirme-biberi-uretimde-kullanilmaz',
      });
      expect(() => assertProductionConfig()).toThrow();
    } finally {
      for (const k of ['NODE_ENV', 'ALLOWED_ORIGINS', 'APP_BASE_URL', 'DATABASE_URL', 'ACCOUNT_CODE_PEPPER']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('şifre kuralı ve İ', () => {
  it('yaygın şifreler reddedilir', () => {
    for (const p of ['1234567890', 'Password123', 'PASSWORD1234', 'qwertyuiop', 'SIFRE123456', 'Galatasaray', 'aaaaaaaaaa', '1212121212', 'abcabcabca']) {
      expect(newPassword.safeParse(p).success, p).toBe(false);
    }
  });

  it('İ normalizasyonu', async () => {
    expect(normalizeEmail('ALİ@X.COM')).toBe('ali@x.com');
    expect(normalizeEmail('İbrahim@x.com')).toBe('ibrahim@x.com');
    console.log('[KANIT] ayrışık i + U+0307:', JSON.stringify(normalizeEmail('ali̇@x.com')));
    const local = `ali${Date.now()}`;
    const email = `${local}@test.sellerondata.com`;
    await registerOrg(app, { email: `${local.toUpperCase().replace('I', 'İ')}@test.sellerondata.com` }).catch((e) => {
      throw e;
    });
    const person = await prisma.person.findUnique({ where: { email } });
    expect(person).not.toBeNull();
    expect((await login(app, `${local.toUpperCase().replace('I', 'İ')}@TEST.SELLERONDATA.COM`)).statusCode).toBe(200);
    expect((await login(app, `${local.toUpperCase()}@test.sellerondata.com`)).statusCode).toBe(200);
    const dotless = await call('POST', '/auth/register', {}, { orgName: 'F', name: 'A', email: `alı${Date.now()}@x.com`, password: 'Sifre12345!', client: 'mobile' });
    expect(dotless.statusCode).toBe(400);
  });
});

describe('kilit sırası', () => {
  it('şifre değişimi ile üye çıkarma karşılıklı beklemez', async () => {
    const owner = await registerOrg(app);
    const m = await addMember(app, owner.orgId);
    let locked = () => {};
    const gate = new Promise<void>((r) => (locked = r));
    const removal = prisma
      .$transaction(async (tx) => {
        await lockMemberships(tx, [m.membershipId]);
        locked();
        await sleep(1200);
        const row = await tx.membership.findUniqueOrThrow({ where: { id: m.membershipId }, include: { person: true } });
        await removeMembership(tx, row);
      })
      .then(
        () => 'ok',
        (e: Error) => `HATA ${/deadlock|40P01/i.test(e.message) ? 'deadlock' : e.message.slice(0, 120)}`,
      );
    await gate;
    const change = await call('POST', '/me/password', m.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' });
    const outcome = await removal;
    console.log('[KANIT] kilit: şifre', change.statusCode, errorCode(change) ?? '', '| çıkarma', outcome);
    expect(change.statusCode).toBeLessThan(500);
    expect(outcome).toBe('ok');
    expect(change.statusCode).toBe(200);
  }, 60_000);

  it('gerçek uçlarla eşzamanlı şifre değişimi ve çıkarma: 500 yok', async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 14; i++) {
      const owner = await registerOrg(app);
      const m = await addMember(app, owner.orgId);
      const change = call('POST', '/me/password', m.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' });
      await sleep(40 + i * 25);
      const rm = await call('DELETE', `/org/members/${m.membershipId}`, owner.headers);
      const ch = await change;
      for (const r of [ch, rm]) {
        const k = `${r.statusCode}${errorCode(r) ? ` ${errorCode(r)}` : ''}`;
        tally[k] = (tally[k] ?? 0) + 1;
      }
    }
    console.log('[KANIT] eşzamanlı şifre+çıkarma:', JSON.stringify(tally));
    expect(Object.keys(tally).filter((k) => k.startsWith('5'))).toEqual([]);
  }, 180_000);

  it('devir ile e-posta silme yarışı e-postasız OWNER bırakmaz', async () => {
    let bad = 0;
    const tally: Record<string, number> = {};
    for (let i = 0; i < 14; i++) {
      const owner = await registerOrg(app);
      const t = await addMember(app, owner.orgId, { phone: randomTrPhone() });
      const drop = call('PATCH', '/me', t.headers, { email: null, currentPassword: PASSWORD });
      await sleep(40 + i * 20);
      const tr = await call('POST', '/org/transfer-ownership', owner.headers, { membershipId: t.membershipId, password: PASSWORD });
      const d = await drop;
      const k = `${tr.statusCode}/${d.statusCode}`;
      tally[k] = (tally[k] ?? 0) + 1;
      const row = await prisma.membership.findUniqueOrThrow({ where: { id: t.membershipId }, include: { person: true } });
      if (row.orgRole === 'OWNER' && !row.person.email) bad += 1;
    }
    console.log('[KANIT] devir/e-posta silme durumları:', JSON.stringify(tally), 'e-postasız OWNER:', bad);
    expect(bad).toBe(0);
  }, 180_000);
});

describe('şifre değişimi ile eşzamanlı giriş', () => {
  it('değişim sırasında başlayan eski şifreli giriş oturum bırakmaz', async () => {
    let survivors = 0;
    let rounds = 0;
    for (let i = 0; i < 16; i++) {
      const owner = await registerOrg(app);
      const change = call('POST', '/me/password', owner.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' });
      await sleep(60 + i * 20);
      const l = await login(app, owner.email as string);
      const ch = await change;
      expect(ch.statusCode).toBe(200);
      if (l.statusCode !== 200) continue;
      rounds += 1;
      const r = await call('POST', '/auth/refresh', {}, { refreshToken: l.json().refreshToken });
      if (r.statusCode === 200) survivors += 1;
    }
    console.log('[KANIT] eski şifreyle başarılı giriş:', rounds, 'değişimden sonra yaşayan oturum:', survivors);
    expect(survivors).toBe(0);
  }, 180_000);
});

void bearer;
