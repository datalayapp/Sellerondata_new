import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { hitRateLimit, identityKey, isKnownDevice, RATE_RULES, refundRateLimit } from '../src/lib/rateLimit.ts';
import { MAX_ACTIVE_TOKENS } from '../src/routes/auth.ts';
import { addMember, API, errorCode, getApp, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, uniq, type Ctx, asWeb } from './helpers.ts';

/**
 * 02-B3: hız sınırı kurbanı kilitlememeli (ARCHITECTURE §11).
 * - Tek IP kimlik kovasına pencerede en çok `loginPair` deneme ekler.
 * - Kimlik ve kişi kovası önce atomik sayar, şifre doğruysa payı geri verir: net sayı yalnız başarısız denemeler.
 * - Dolu kovada kişinin bilinen cihazı (daha önce oturum açtığı IP birimi) geçer.
 * - Şifremi unuttum: kimlik sınırı aşılınca sessiz yanıt, eski bağlantı yeni istekle ölmez.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const LIMIT = RATE_RULES.loginIdentity.limit;
const attempt = (identifier: string, ip: string, password = 'YanlisSifre123') =>
  app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: ip, payload: { identifier, password, client: 'mobile' } });

async function countOf(key: string) {
  return (await prisma.rateBucket.findUnique({ where: { key } }))?.count ?? 0;
}

async function fill(key: string, count: number) {
  await prisma.rateBucket.upsert({
    where: { key },
    create: { key, count, windowEnd: new Date(Date.now() + 600_000) },
    update: { count, windowEnd: new Date(Date.now() + 600_000) },
  });
}

/** Kişinin bu IP'den açılmış oturumu var: bilinen cihaz. */
async function signInFrom(ctx: Ctx, ip: string) {
  const res = await attempt(ctx.email as string, ip, PASSWORD);
  expect(res.statusCode, res.body).toBe(200);
}

describe('kimlik kovası', () => {
  it('tek IP kimlik kovasına en çok loginPair deneme ekler', async () => {
    const owner = await registerOrg(app);
    const ip = randomIp();
    for (let i = 0; i < RATE_RULES.loginPair.limit + 5; i++) await attempt(owner.email as string, ip);
    expect(await countOf(`login:id:${identityKey(owner.email as string)}`)).toBe(RATE_RULES.loginPair.limit);
    expect(await countOf(`login:person:${owner.personId}`)).toBe(RATE_RULES.loginPair.limit);
  });

  it('başarılı giriş kendi payını geri verir: kovada yalnız başarısızlar kalır', async () => {
    const owner = await registerOrg(app);
    const ip = randomIp();
    for (let i = 0; i < 4; i++) await attempt(owner.email as string, ip);
    expect((await attempt(owner.email as string, ip, PASSWORD)).statusCode).toBe(200);
    expect(await countOf(`login:id:${identityKey(owner.email as string)}`)).toBe(4);
    expect(await countOf(`login:person:${owner.personId}`)).toBe(4);
    // Başarısız deneme geri verilmez.
    await attempt(owner.email as string, randomIp());
    expect(await countOf(`login:person:${owner.personId}`)).toBe(5);
  });

  it('dolu kovada bilinen cihaz girer; bilinmeyen IP doğru şifreyle de 429 alır', async () => {
    const owner = await registerOrg(app);
    const home = randomIp();
    await signInFrom(owner, home);
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT);
    await fill(`login:person:${owner.personId}`, LIMIT);

    const stranger = await attempt(owner.email as string, randomIp(), PASSWORD);
    expect(stranger.statusCode).toBe(429);
    expect(errorCode(stranger)).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(stranger.headers['retry-after'])).toBeGreaterThan(0);

    expect((await attempt(owner.email as string, home, PASSWORD)).statusCode).toBe(200);
    // Bilinen cihazdan yanlış şifre de denenebilir (ikili kovayla sınırlı) ama sayılır.
    expect((await attempt(owner.email as string, home)).statusCode).toBe(401);
  });

  it('bilinen cihaz IP birimine göre: IPv6 /64 içinde başka adres de bilinir', async () => {
    const owner = await registerOrg(app);
    const prefix = `2001:db8:${crypto.randomInt(1, 0xffff).toString(16)}:${crypto.randomInt(1, 0xffff).toString(16)}`;
    await signInFrom(owner, `${prefix}::1`);
    expect(await isKnownDevice(owner.personId, `${prefix}::abcd`)).toBe(true);
    expect(await isKnownDevice(owner.personId, `::ffff:${randomIp()}`)).toBe(false);
    expect(await isKnownDevice(null, `${prefix}::1`)).toBe(false);
    // Bilinen IP'nin IPv4 eşlemeli yazımı da aynı birim.
    const v4 = randomIp();
    await signInFrom(owner, v4);
    expect(await isKnownDevice(owner.personId, `::ffff:${v4}`)).toBe(true);
  });

  it('bilinen cihaz yalnız şifreyle açılmış, iptal edilmemiş oturumdan: döndürmeyle gelen IP ve iptal edilmiş oturum sayılmaz', async () => {
    const owner = await registerOrg(app);
    // Çalınmış yenileme jetonu başka IP'den döndürülür: o IP bilinen cihaz olmaz.
    const thief = randomIp();
    const rotated = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: thief, payload: { refreshToken: owner.refreshToken } });
    expect(rotated.statusCode).toBe(200);
    expect(await isKnownDevice(owner.personId, thief)).toBe(false);

    const home = randomIp();
    await signInFrom(owner, home);
    expect(await isKnownDevice(owner.personId, home)).toBe(true);
    await prisma.session.updateMany({ where: { personId: owner.personId, ip: home }, data: { revokedAt: new Date() } });
    expect(await isKnownDevice(owner.personId, home)).toBe(false);
  });

  it('bilinen cihazdan geçen denemeler kendi kovasında: 30/15 dk sonra bilinen cihaz da 429', async () => {
    const owner = await registerOrg(app);
    const home = randomIp();
    await signInFrom(owner, home);
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT);
    await fill(`login:known:${owner.personId}`, RATE_RULES.loginKnownDevice.limit - 1);
    // Ikili kova ilgisiz: her denemede temizlenir.
    const pair = `login:pair:${identityKey(owner.email as string)}:${home}`;
    expect((await attempt(owner.email as string, home)).statusCode).toBe(401);
    await prisma.rateBucket.deleteMany({ where: { key: pair } });
    const blocked = await attempt(owner.email as string, home, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(await countOf(`login:known:${owner.personId}`)).toBe(RATE_RULES.loginKnownDevice.limit + 1);
  });

  it('bilinen cihaz kovası başarıda geri verilir, kova dolu değilken hiç yazılmaz', async () => {
    const owner = await registerOrg(app);
    const home = randomIp();
    await signInFrom(owner, home);
    expect(await countOf(`login:known:${owner.personId}`)).toBe(0);
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT);
    expect((await attempt(owner.email as string, home, PASSWORD)).statusCode).toBe(200);
    expect(await countOf(`login:known:${owner.personId}`)).toBe(0);
  });

  it('bilinen cihaz son 90 günün oturumlarından: eski oturum sayılmaz', async () => {
    const owner = await registerOrg(app);
    const ip = randomIp();
    await signInFrom(owner, ip);
    const old = new Date(Date.now() - 91 * 24 * 3600_000);
    await prisma.session.updateMany({ where: { personId: owner.personId }, data: { createdAt: old, familyCreatedAt: old } });
    expect(await isKnownDevice(owner.personId, ip)).toBe(false);
  });

  it('bilinmeyen kimlik ve bilinmeyen cihazdaki kişi aynı yanıtı alır', async () => {
    const owner = await registerOrg(app);
    const unknown = randomEmail('yok');
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT);
    await fill(`login:id:${identityKey(unknown)}`, LIMIT);
    const a = await attempt(owner.email as string, randomIp());
    const b = await attempt(unknown, randomIp());
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(a.body).toBe(b.body);
  });

  it('kişi kovası e-posta ve telefonu birlikte sayar; dolunca bilinen cihaz telefonla da girer', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const home = randomIp();
    await signInFrom(member, home);
    await fill(`login:person:${member.personId}`, LIMIT);
    expect((await attempt(phone, randomIp(), PASSWORD)).statusCode).toBe(429);
    expect((await attempt(phone, home, PASSWORD)).statusCode).toBe(200);
  });

  it('eşzamanlı denemeler sınırı delemez: pencerede tam LIMIT başarısız deneme şifreye ulaşır', async () => {
    const owner = await registerOrg(app);
    const results = await Promise.all(Array.from({ length: LIMIT + 8 }, () => attempt(owner.email as string, randomIp())));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(8);
  });

  it('kilitlenme denetim izine pencere başına bir kez yazılır', async () => {
    const owner = await registerOrg(app);
    const home = randomIp();
    await signInFrom(owner, home);
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT - 1);
    for (let i = 0; i < 3; i++) await attempt(owner.email as string, randomIp());
    // Bilinen cihazdan başarılı giriş sayacı sınırın altına indirir; yeniden aşılınca ikinci kayıt yazılmaz.
    expect((await attempt(owner.email as string, home, PASSWORD)).statusCode).toBe(200);
    await fill(`login:id:${identityKey(owner.email as string)}`, LIMIT);
    await attempt(owner.email as string, randomIp());
    const rows = await prisma.auditLog.findMany({ where: { action: 'login.locked', target: owner.personId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBeNull();
  });

  it('başarılı giriş session.created yazar (kişi düzeyinde, firmasız)', async () => {
    const owner = await registerOrg(app);
    const before = await prisma.auditLog.count({ where: { action: 'session.created', actorPersonId: owner.personId } });
    await signInFrom(owner, randomIp());
    const rows = await prisma.auditLog.findMany({ where: { action: 'session.created', actorPersonId: owner.personId } });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.orgId).toBeNull();
  });

  it('geri verme sıfırın altına inmez, süresi geçmiş pencereye dokunmaz', async () => {
    const key = `test:${uniq()}`;
    const rule = { limit: 5, windowSeconds: 60 };
    await hitRateLimit(key, rule);
    await refundRateLimit(key);
    await refundRateLimit(key);
    expect(await countOf(key)).toBe(0);
    await fill(key, 3);
    await prisma.rateBucket.update({ where: { key }, data: { windowEnd: new Date(Date.now() - 1000) } });
    await refundRateLimit(key);
    expect(await countOf(key)).toBe(3);
  });
});

describe('davet kabulünde şifre denemesi', () => {
  const invitePhone = async (actor: Ctx, phone: string) =>
    app.inject({ method: 'POST', url: `${API}/org/members/invite`, remoteAddress: randomIp(), headers: await asWeb(actor), payload: { kind: 'PHONE_CODE', phone, name: 'Çalışan' } });
  const accept = (phone: string, code: string, password: string) =>
    app.inject({ method: 'POST', url: `${API}/auth/join/accept`, remoteAddress: randomIp(), payload: { phone, code, password, client: 'mobile' } });

  it('doğru şifre payını geri verir, yanlış şifre sayılır; bilinen cihaz istisnası yok', async () => {
    const firmA = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, firmA.orgId, { email: null, phone });
    const key = `login:person:${worker.personId}`;
    const firmB = await registerOrg(app);
    await prisma.organization.update({ where: { id: firmB.orgId }, data: { createdAt: new Date(Date.now() - 40 * 3600_000) } });

    const first = (await invitePhone(firmB, phone)).json();
    const before = await countOf(key);
    expect((await accept(phone, first.code, 'Tahmin12345!')).statusCode).toBe(401);
    expect(await countOf(key)).toBe(before + 1);
    expect((await accept(phone, first.code, PASSWORD)).statusCode).toBe(200);
    expect(await countOf(key)).toBe(before + 1);

    const firmC = await registerOrg(app);
    await prisma.organization.update({ where: { id: firmC.orgId }, data: { createdAt: new Date(Date.now() - 40 * 3600_000) } });
    const second = (await invitePhone(firmC, phone)).json();
    await fill(key, LIMIT);
    const blocked = await accept(phone, second.code, PASSWORD);
    expect(blocked.statusCode).toBe(429);
  });
});

describe('şifremi unuttum', () => {
  const forgot = (identifier: string) =>
    app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier } });

  async function resetMails(to: string) {
    await flushMail();
    return prisma.mailLog.findMany({ where: { to, template: 'password_reset' }, orderBy: { createdAt: 'asc' } });
  }

  it('kimlik sınırı aşılınca sessiz 200 ve posta yok; kişi olsa da olmasa da aynı', async () => {
    const owner = await registerOrg(app);
    const unknown = randomEmail('yok');
    const first = await forgot(owner.email as string);
    for (let i = 1; i < RATE_RULES.forgotIdentity.limit; i++) await forgot(owner.email as string);
    for (let i = 0; i < RATE_RULES.forgotIdentity.limit; i++) await forgot(unknown);
    const a = await forgot(owner.email as string);
    const b = await forgot(unknown);
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(first.body);
    }
    expect(await resetMails(owner.email as string)).toHaveLength(RATE_RULES.forgotIdentity.limit);
  });

  it('IP sınırı 429 kalır', async () => {
    const ip = randomIp();
    const send = () => app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: ip, payload: { identifier: randomEmail('ip') } });
    for (let i = 0; i < RATE_RULES.forgotIp.limit; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
  });

  it('yeni istek eski bağlantıyı öldürmez; en çok 3 etkin bağlantı', async () => {
    const owner = await registerOrg(app);
    for (let i = 0; i < MAX_ACTIVE_TOKENS + 1; i++) {
      await prisma.rateBucket.deleteMany({ where: { key: `forgot:id:${identityKey(owner.email as string)}` } });
      await forgot(owner.email as string);
    }
    const mails = await resetMails(owner.email as string);
    expect(mails).toHaveLength(MAX_ACTIVE_TOKENS);
    expect(await prisma.oneTimeToken.count({ where: { personId: owner.personId, kind: 'PASSWORD_RESET', usedAt: null } })).toBe(MAX_ACTIVE_TOKENS);
    const oldest = /reset-password\/(\S+)/.exec(mails[0].body)?.[1] as string;
    const reset = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token: oldest, password: 'SifirSifre123!' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    // Kullanılan sıfırlama diğer bekleyen jetonları siler (değişmez).
    expect(await prisma.oneTimeToken.count({ where: { personId: owner.personId, usedAt: null } })).toBe(0);
  });
});
