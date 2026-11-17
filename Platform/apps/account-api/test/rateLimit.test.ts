import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { enforceRateLimit, identityKey, RATE_RULES } from '../src/lib/rateLimit.ts';
import { API, errorCode, getApp, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, uniq } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.TRUST_PROXY_HOPS = '0';
});

const loginAttempt = (identifier: string, ip: string, password = 'YanlisSifre123') =>
  app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: ip, payload: { identifier, password, client: 'mobile' } });

describe('hız sınırı veritabanında', () => {
  it('sayaç RateBucket tablosunda, kimlik özeti ile; ham e-posta yazılmaz', async () => {
    const email = randomEmail('kova');
    const ip = randomIp();
    await loginAttempt(email, ip);
    const buckets = await prisma.rateBucket.findMany({ where: { key: { contains: identityKey(email) } } });
    expect(buckets.length).toBe(2);
    expect(buckets.every((b) => !b.key.includes(email))).toBe(true);
    expect(buckets.every((b) => b.count === 1 && b.windowEnd > new Date())).toBe(true);
  });

  it('kişi + IP ikilisi: 10 denemeden sonra doğru şifre de 429, Retry-After ile; başka IP sürer', async () => {
    const owner = await registerOrg(app);
    const ip = randomIp();
    for (let i = 0; i < RATE_RULES.loginPair.limit; i++) {
      expect((await loginAttempt(owner.email as string, ip)).statusCode).toBe(401);
    }
    const blocked = await loginAttempt(owner.email as string, ip, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const otherIp = await loginAttempt(owner.email as string, randomIp(), PASSWORD);
    expect(otherIp.statusCode).toBe(200);
  });

  it('kişi tek başına: IP değiştirerek sınırsız deneme yok', async () => {
    const owner = await registerOrg(app);
    for (let i = 0; i < RATE_RULES.loginIdentity.limit; i++) await loginAttempt(owner.email as string, randomIp());
    const res = await loginAttempt(owner.email as string, randomIp());
    expect(res.statusCode).toBe(429);
  });

  it('IP tek başına: kimlik değiştirerek sınırsız deneme yok', async () => {
    const ip = randomIp();
    let last = await loginAttempt(randomEmail('tara'), ip);
    for (let i = 0; i < RATE_RULES.loginIp.limit; i++) last = await loginAttempt(randomEmail('tara'), ip);
    expect(last.statusCode).toBe(429);
  });

  it('başarılı giriş ikili sayacı sıfırlar', async () => {
    const owner = await registerOrg(app);
    const ip = randomIp();
    for (let i = 0; i < 5; i++) await loginAttempt(owner.email as string, ip);
    expect((await loginAttempt(owner.email as string, ip, PASSWORD)).statusCode).toBe(200);
    const pair = await prisma.rateBucket.findUnique({ where: { key: `login:pair:${identityKey(owner.email as string)}:${ip}` } });
    expect(pair).toBeNull();
  });

  it('bilinmeyen ve bilinen kimlik aynı anda aynı sınıra takılır: sınır varlığı ele vermez', async () => {
    const owner = await registerOrg(app);
    const unknown = randomEmail('yok');
    const ip1 = randomIp();
    const ip2 = randomIp();
    for (let i = 0; i < RATE_RULES.loginPair.limit; i++) {
      await loginAttempt(owner.email as string, ip1);
      await loginAttempt(unknown, ip2);
    }
    const a = await loginAttempt(owner.email as string, ip1);
    const b = await loginAttempt(unknown, ip2);
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(a.body).toBe(b.body);
  });

  it('pencere bitince sıfırlanır', async () => {
    const key = `test:${uniq()}`;
    const rule = { limit: 2, windowSeconds: 60 };
    await enforceRateLimit([{ key, rule }]);
    await enforceRateLimit([{ key, rule }]);
    await expect(enforceRateLimit([{ key, rule }])).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS', statusCode: 429 });
    await prisma.rateBucket.update({ where: { key }, data: { windowEnd: new Date(Date.now() - 1000) } });
    await enforceRateLimit([{ key, rule }]);
    expect((await prisma.rateBucket.findUniqueOrThrow({ where: { key } })).count).toBe(1);
  });

  it('eşzamanlı isteklerde sayaç kaybolmaz', async () => {
    const key = `test:${uniq()}`;
    const rule = { limit: 1000, windowSeconds: 60 };
    await Promise.all(Array.from({ length: 30 }, () => enforceRateLimit([{ key, rule }])));
    expect((await prisma.rateBucket.findUniqueOrThrow({ where: { key } })).count).toBe(30);
  });

  it('kayıt IP başına sınırlı', async () => {
    const ip = randomIp();
    const register = () =>
      app.inject({
        method: 'POST',
        url: `${API}/auth/register`,
        remoteAddress: ip,
        payload: { orgName: 'X', name: 'Y', email: randomEmail(), password: PASSWORD, client: 'mobile' },
      });
    for (let i = 0; i < RATE_RULES.registerIp.limit; i++) expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(429);
  });

  it('şifremi unuttum: üçten sonra sessiz 200 ve posta yok, kişi olsa da olmasa da aynı', async () => {
    const owner = await registerOrg(app);
    const forgot = (identifier: string) =>
      app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier } });
    const unknown = randomEmail('yok');
    for (let i = 0; i < RATE_RULES.forgotIdentity.limit; i++) {
      expect((await forgot(owner.email as string)).statusCode).toBe(200);
      expect((await forgot(unknown)).statusCode).toBe(200);
    }
    await flushMail();
    const sent = await prisma.mailLog.count({ where: { to: owner.email as string, template: 'password_reset' } });
    // Sınır aşılınca hata değil aynı yanıt (02-B3): kurban 429 görmez, saldırgan sınırı ölçemez.
    const a = await forgot(owner.email as string);
    const b = await forgot(unknown);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
    await flushMail();
    expect(await prisma.mailLog.count({ where: { to: owner.email as string, template: 'password_reset' } })).toBe(sent);
  });

  it('kod denemesi telefon + IP başına sınırlı', async () => {
    const phone = randomTrPhone();
    const ip = randomIp();
    const attempt = () =>
      app.inject({ method: 'POST', url: `${API}/auth/join/preview`, remoteAddress: ip, payload: { phone, code: 'ABCD2345' } });
    for (let i = 0; i < RATE_RULES.joinPair.limit; i++) expect((await attempt()).statusCode).toBe(400);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('davet bağlantısı tahmini IP başına sınırlı', async () => {
    const ip = randomIp();
    let last = await app.inject({ url: `${API}/invites/uydurma`, remoteAddress: ip });
    for (let i = 0; i < RATE_RULES.inviteTokenIp.limit; i++) last = await app.inject({ url: `${API}/invites/uydurma${i}`, remoteAddress: ip });
    expect(last.statusCode).toBe(429);
  });
});

describe('vekil arkasında IP', () => {
  it('X-Forwarded-For sahteciliği hız sınırını atlatmaz: yalnız gateway\'in eklediği değer sayılır', async () => {
    process.env.TRUST_PROXY_HOPS = '1';
    const proxied = await buildApp();
    await proxied.ready();
    try {
      const realClient = randomIp();
      const email = randomEmail('vekil');
      const attempt = (spoof: string) =>
        proxied.inject({
          method: 'POST',
          url: `${API}/auth/login`,
          remoteAddress: '172.18.0.5', // gateway
          // nginx $proxy_add_x_forwarded_for: istemcinin yazdığına gerçek IP'yi ekler.
          headers: { 'x-forwarded-for': `${spoof}, ${realClient}` },
          payload: { identifier: email, password: 'YanlisSifre123', client: 'mobile' },
        });
      for (let i = 0; i < RATE_RULES.loginPair.limit; i++) await attempt(randomIp());
      const res = await attempt(randomIp());
      expect(res.statusCode).toBe(429);
      const bucket = await prisma.rateBucket.findUnique({ where: { key: `login:ip:${realClient}` } });
      expect(bucket).not.toBeNull();
    } finally {
      await proxied.close();
    }
  });

  it('varsayılan: başlık yok sayılır', async () => {
    const realClient = randomIp();
    const spoofed = randomIp();
    await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: realClient,
      headers: { 'x-forwarded-for': spoofed },
      payload: { identifier: randomEmail('x'), password: 'YanlisSifre123', client: 'mobile' },
    });
    expect(await prisma.rateBucket.findUnique({ where: { key: `login:ip:${spoofed}` } })).toBeNull();
    expect(await prisma.rateBucket.findUnique({ where: { key: `login:ip:${realClient}` } })).not.toBeNull();
  });
});
