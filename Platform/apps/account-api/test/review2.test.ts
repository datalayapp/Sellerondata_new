import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { prisma } from '../src/db.ts';
import { assertProductionConfig } from '../src/env.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { normalizeEmail } from '../src/lib/identity.ts';
import { lockPerson } from '../src/lib/members.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import { newPassword } from '../src/lib/schemas.ts';
import { releasePhone } from '../src/lib/support.ts';
import {
  addMember,
  API,
  errorCode,
  getApp,
  login,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg, asWeb, webHeadersFrom, isOrgWrite } from './helpers.ts';
import { SUPER_URL, TEST_DB_NAME } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });

/** Kişi satırını tutar, işi yapar, bırakır: giriş doğrulamayı geçmiş ve kilitte bekliyor olur. */
async function withPersonLocked(personId: string, whileHeld: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>, started: Promise<unknown>) {
  await prisma.$transaction(async (tx) => {
    await lockPerson(tx, personId);
    await started;
    await sleep(400); // Şifre doğrulaması (argon2) bitip kilitte beklemeye geçsin.
    await whileHeld(tx);
  });
}

describe('B2: giriş ile şifre değişimi yarışı', () => {
  it('doğrulanan özet değiştiyse giriş reddedilir, oturum açılmaz', async () => {
    const owner = await registerOrg(app);
    const newHash = await hashPassword('CokYeniSifre123!');
    const sessionsBefore = await prisma.session.count({ where: { personId: owner.personId } });
    let requested = () => {};
    const started = new Promise<void>((r) => (requested = r));
    const loginRes = (async () => {
      requested();
      return login(app, owner.email as string);
    })();
    await withPersonLocked(owner.personId, async (tx) => {
      await tx.person.update({ where: { id: owner.personId }, data: { passwordHash: newHash } });
    }, started);
    const res = await loginRes;
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
    expect(await prisma.session.count({ where: { personId: owner.personId } })).toBe(sessionsBefore);
  });

  it('yeniden özetleme yeni şifreyi ezemez', async () => {
    const owner = await registerOrg(app);
    // Eski parametreli özet: girişte yeniden özetleme tetiklenir.
    const argon2 = (await import('argon2')).default;
    const weak = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 8192, timeCost: 2, parallelism: 1 });
    await prisma.person.update({ where: { id: owner.personId }, data: { passwordHash: weak } });
    const newHash = await hashPassword('CokYeniSifre123!');
    let requested = () => {};
    const started = new Promise<void>((r) => (requested = r));
    const loginRes = (async () => {
      requested();
      return login(app, owner.email as string);
    })();
    await withPersonLocked(owner.personId, async (tx) => {
      await tx.person.update({ where: { id: owner.personId }, data: { passwordHash: newHash } });
    }, started);
    expect((await loginRes).statusCode).toBe(401);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).passwordHash).toBe(newHash);
  });

  it('katılımda var olan kişi: şifre kilit altında doğrulanır, değişmiş şifreyle üyelik açılmaz', async () => {
    const firm = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, firm.orgId, { email: null, phone });
    const inviter = await registerOrg(app);
    const { code } = (await post('/org/members/invite', inviter.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).json();
    const newHash = await hashPassword('CokYeniSifre123!');
    let requested = () => {};
    const started = new Promise<void>((r) => (requested = r));
    const accept = (async () => {
      requested();
      return post('/auth/join/accept', {}, { phone, code, password: PASSWORD, client: 'mobile' });
    })();
    await withPersonLocked(worker.personId, async (tx) => {
      await tx.person.update({ where: { id: worker.personId }, data: { passwordHash: newHash } });
    }, started);
    const res = await accept;
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
    expect(await prisma.membership.count({ where: { personId: worker.personId, orgId: inviter.orgId } })).toBe(0);
  });

  it('sahiplik devri onaylanan şifre değiştiyse yapılmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const newHash = await hashPassword('CokYeniSifre123!');
    let requested = () => {};
    const started = new Promise<void>((r) => (requested = r));
    const transfer = (async () => {
      requested();
      return post('/org/transfer-ownership', owner.headers, { membershipId: member.membershipId, password: PASSWORD });
    })();
    await withPersonLocked(owner.personId, async (tx) => {
      await tx.person.update({ where: { id: owner.personId }, data: { passwordHash: newHash } });
    }, started);
    expect(errorCode(await transfer)).toBe('INVALID_CREDENTIALS');
    expect(await prisma.membership.count({ where: { id: owner.membershipId, orgRole: 'OWNER' } })).toBe(1);
  });
});

describe('B3 azaltma: numara kapma kabul edilen risk, SMS ile kapanır', () => {
  it('sınır: yeni firma saatte 10 telefon daveti', () => {
    expect(RATE_RULES.phoneInviteNewOrg.limit).toBe(10);
  });

  it('kabul denetim izine son 4 haneyle yazılır, numaranın tamamı yazılmaz', async () => {
    const owner = await registerOrg(app);
    const linker = await registerOrg(app);
    const phone = randomTrPhone();
    const { code } = (await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).json();
    const res = await post('/auth/join/accept', linker.headers, { phone, code, password: PASSWORD, client: 'mobile', linkCurrentAccount: true });
    expect(res.statusCode).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'person.phone_linked', actorPersonId: linker.personId } });
    expect(row.orgId).toBe(owner.orgId);
    expect((row.meta as { phoneLast4: string }).phoneLast4).toBe(phone.slice(-4));
    expect(JSON.stringify(row.meta)).not.toContain(phone);
  });

  it('phone:release: başka girişi olan kişiden numarayı ayırır, askıya almaz, numara yeniden alınabilir', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const result = await releasePhone(phone, { operator: 'test' });
    expect(result).toEqual({ personId: member.personId, suspended: false });
    const person = await prisma.person.findUniqueOrThrow({ where: { id: member.personId } });
    expect(person.phone).toBeNull();
    expect(person.suspendedAt).toBeNull();
    expect((await login(app, member.email as string)).statusCode).toBe(200);
    expect((await login(app, phone)).statusCode).toBe(401);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'support.phone_released', target: member.personId } });
    expect((audit.meta as { phoneLast4: string; operator: string })).toMatchObject({ phoneLast4: phone.slice(-4), operator: 'test' });
    expect(JSON.stringify(audit.meta)).not.toContain(phone);
  });

  it('phone:release: başka girişi yoksa kişi askıya alınır, oturumlar düşer, üyelikler askıda, olay gider', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone, deciship: 'MEASURE' });
    const before = (await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } })).epoch;
    const result = await releasePhone(phone, { operator: 'test' });
    expect(result.suspended).toBe(true);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } });
    expect(person.phone).toBeNull();
    expect(person.suspendedAt).not.toBeNull();
    const m = await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } });
    expect(m.status).toBe('SUSPENDED');
    expect(m.epoch).toBe(before + 1);
    expect(await prisma.session.count({ where: { personId: worker.personId, revokedAt: null } })).toBe(0);
    expect((await login(app, phone)).statusCode).toBe(401);
    // Numara yeni kişiye açılabilir.
    const invite = await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'Gerçek Sahip' });
    expect(invite.statusCode).toBe(201);
    const accept = await post('/auth/join/accept', {}, { phone, code: invite.json().code, password: 'MaviKedi-4729', client: 'mobile' });
    expect(accept.statusCode).toBe(201);
  });

  it('phone:release: kimliksiz kalacak OWNER için durur, devir ister; bilinmeyen numara hata', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    await prisma.person.update({ where: { id: owner.personId }, data: { email: null, phone } });
    await expect(releasePhone(phone, { operator: 'test' })).rejects.toThrow(/OWNER/);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).phone).toBe(phone);
    await expect(releasePhone(randomTrPhone(), { operator: 'test' })).rejects.toThrow(/bulunamadı/);
    await expect(releasePhone('kimlik-degil', { operator: 'test' })).rejects.toThrow(/geçersiz/);
  });

  it('veritabanı: kimliksiz kişi yalnız askıdaysa olur; doğrulama sütunu hazır ve boş', async () => {
    await expect(prisma.person.create({ data: { name: 'x', passwordHash: 'x' } })).rejects.toThrow();
    const row = await prisma.person.create({ data: { name: 'x', passwordHash: 'x', suspendedAt: new Date() } });
    expect(row.phoneVerifiedAt).toBeNull();
    await prisma.person.delete({ where: { id: row.id } });
  });
});

describe('O6: e-posta davetinde personExists', () => {
  it('yeni firma saatte sınırlı e-posta daveti açar', async () => {
    const owner = await registerOrg(app);
    let last = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: randomEmail(), name: 'X' });
    for (let i = 0; i < RATE_RULES.emailInviteNewOrg.limit; i++) {
      last = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: randomEmail(), name: 'X' });
    }
    expect(last.statusCode).toBe(429);
  });
});

describe('küçükler', () => {
  it('biber dönüşü: PREVIOUS ile eski kod çalışır, hak yakmaz; yanlış kod iki biberle de eşleşmez', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { code, invitation } = (await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).json();
    const saved = { p: process.env.ACCOUNT_CODE_PEPPER, q: process.env.ACCOUNT_CODE_PEPPER_PREVIOUS };
    const current = process.env.ACCOUNT_CODE_PEPPER ?? 'sod-gelistirme-biberi-uretimde-kullanilmaz';
    process.env.ACCOUNT_CODE_PEPPER = 'yeni-biber-yeni-biber-yeni-biber-1234';
    process.env.ACCOUNT_CODE_PEPPER_PREVIOUS = current;
    try {
      const pv = await post('/auth/join/preview', {}, { phone, code });
      expect(pv.statusCode).toBe(200);
      const wrong = code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`;
      expect(errorCode(await post('/auth/join/preview', {}, { phone, code: wrong }))).toBe('INVITE_INVALID');
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).attempts).toBe(1);
    } finally {
      if (saved.p === undefined) delete process.env.ACCOUNT_CODE_PEPPER;
      else process.env.ACCOUNT_CODE_PEPPER = saved.p;
      if (saved.q === undefined) delete process.env.ACCOUNT_CODE_PEPPER_PREVIOUS;
      else process.env.ACCOUNT_CODE_PEPPER_PREVIOUS = saved.q;
    }
  });

  it('üretimde geliştirme biberi, önceki biber olarak da reddedilir', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://a',
        APP_BASE_URL: 'https://a',
        DATABASE_URL: 'postgresql://a:gercek@db/x',
        ACCOUNT_CODE_PEPPER: 'g'.repeat(40),
        ACCOUNT_CODE_PEPPER_PREVIOUS: 'sod-gelistirme-biberi-uretimde-kullanilmaz',
      });
      expect(() => assertProductionConfig()).toThrow(/biber/i);
    } finally {
      for (const k of ['NODE_ENV', 'ALLOWED_ORIGINS', 'APP_BASE_URL', 'DATABASE_URL', 'ACCOUNT_CODE_PEPPER', 'ACCOUNT_CODE_PEPPER_PREVIOUS']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('bakım iletisi imajda çalışan komutu söyler', async () => {
    await registerOrg(app);
    const delivery = await prisma.outboxDelivery.findFirstOrThrow({ where: { status: 'PENDING' } });
    await prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'DEAD' } });
    const { runMaintenance } = await import('../src/lib/maintenance.ts');
    const lines: string[] = [];
    await runMaintenance(new Date(), { warn: (_o, m) => lines.push(m ?? ''), error: () => {} });
    expect(lines.join()).toContain('node dist/outbox-requeue.js');
    await prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED' } });
  });

  it('kişi başına kova: e-posta ve telefon ayrı sayılmaz, davet kabulü de aynı kovada', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const attempt = (identifier: string) => post('/auth/login', {}, { identifier, password: 'Yanlis12345', client: 'mobile' });
    await prisma.rateBucket.upsert({
      where: { key: `login:person:${member.personId}` },
      create: { key: `login:person:${member.personId}`, count: RATE_RULES.loginIdentity.limit - 1, windowEnd: new Date(Date.now() + 600_000) },
      update: { count: RATE_RULES.loginIdentity.limit - 1, windowEnd: new Date(Date.now() + 600_000) },
    });
    expect((await attempt(member.email as string)).statusCode).toBe(401);
    expect((await attempt(phone)).statusCode).toBe(429);
    // Var olmayan kimlik aynı sayıda denemede kendi kovasına takılır: fark ele verilmez.
    const stranger = randomEmail('yok');
    expect((await attempt(stranger)).statusCode).toBe(401);
  });

  it('yaygın şifre örüntüleri', () => {
    for (const p of [
      '1234567890', 'Password123', 'PASSWORD1234', 'qwertyuiop', 'SIFRE123456', 'Galatasaray', 'aaaaaaaaaa', '1212121212', 'abcabcabca',
      'Password12345', 'qwertyuiop1', 'abcdefghij', 'abc1234567', '1234512345', 'asdfghjkl;', 'istanbul34', 'Istanbul1453', 'sifre123456',
      'Fenerbahce1907!', 'Şifre123456', 'Galatasaray1905', 'Besiktas1903', 'Trabzonspor61', '1q2w3e4r5t', 'zxcvbnm123',
    ]) {
      expect(newPassword.safeParse(p).success, p).toBe(false);
    }
    for (const p of ['Demo12345!', 'MaviKedi-4729', 'Otobus ile Ankara', 'tR7!kLm2pQ', 'SifirSifre123!', 'CokYeniSifre123!']) {
      expect(newPassword.safeParse(p).success, p).toBe(true);
    }
  });

  it('ayrışık i + U+0307 ve bileşik İ aynı adrese iner', () => {
    expect(normalizeEmail('ali̇@x.com')).toBe('ali@x.com');
    expect(normalizeEmail('ALİ@X.COM')).toBe('ali@x.com');
    expect(normalizeEmail('ALİ@X.COM')).toBe('ali@x.com');
    expect(normalizeEmail('é@x.com')).toBe('é@x.com');
  });
});

describe('kilit sırası: kişi, sonra üyelik', () => {
  it('kaynakta üyelik satırını kilitleyen tek yer lockMemberships', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'generated') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(src);
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return /"Membership"[^`]*FOR (NO KEY )?UPDATE/.test(text) && !f.endsWith('members.ts');
    });
    expect(offenders).toEqual([]);
    // lockMemberships'in kişiyi kilitlediği davranışla sınanır: review3.test.ts.
  });

  it('karışık eşzamanlı akışta kilitlenme yok: şifre, çıkarma, rol, devir, ayrılma, yenileme', async () => {
    const deadlocks = async () => {
      const url = new URL(SUPER_URL);
      url.pathname = `/${TEST_DB_NAME}`;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      await sleep(1500); // İstatistik gecikmeli yazılır.
      const { rows } = await c.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()');
      await c.end();
      return Number(rows[0].deadlocks);
    };
    const before = await deadlocks();
    const tally: Record<string, number> = {};
    const note = (r: { statusCode: number; json: () => unknown }) => {
      const code = r.statusCode >= 400 ? errorCode(r) : '';
      const k = `${r.statusCode} ${code ?? ''}`.trim();
      tally[k] = (tally[k] ?? 0) + 1;
    };
    for (let i = 0; i < 12; i++) {
      const owner = await registerOrg(app);
      const a = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
      const b = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
      const results = await Promise.all([
        post('/me/password', a.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' }),
        app.inject({ method: 'PATCH', url: `${API}/org/members/${a.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } }),
        post('/auth/refresh', {}, { refreshToken: a.refreshToken }),
        post('/org/leave', b.headers, {}),
        app.inject({ method: 'PATCH', url: `${API}/org/members/${b.membershipId}`, headers: await asWeb(owner), payload: { orgRole: 'ADMIN' } }),
        post('/me/password', b.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' }),
        post('/org/transfer-ownership', owner.headers, { membershipId: a.membershipId, password: PASSWORD }),
        app.inject({ method: 'DELETE', url: `${API}/org/members/${b.membershipId}`, headers: await asWeb(owner) }),
      ]);
      results.forEach(note);
    }
    expect(Object.keys(tally).filter((k) => k.startsWith('5'))).toEqual([]);
    // Postgres'in kendi sayacı: CONFLICT yanıtı devrin askıdaki hedefe çarpması da olabilir, kilitlenme burada görünür.
    expect((await deadlocks()) - before, JSON.stringify(tally)).toBe(0);
  }, 240_000);
});
