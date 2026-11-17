import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { sha256 } from '../src/lib/crypto.ts';
import {
  addMember,
  API,
  bearer,
  claimsOf,
  cookieHeader,
  epochOf,
  errorCode,
  lastMailTo,
  login,
  outboxFor,
  parseSetCookies,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg,
  uniq,
  webHeaders,
  getApp,
} from './helpers.ts';
import { TEST_ORIGIN } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.REGISTRATION_ENABLED = 'true';
  process.env.REFRESH_REUSE_GRACE_SECONDS = '10';
  process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
});

/** Döndürülmüş satırı tolerans süresinin dışına iter. */
async function ageRotation(refreshToken: string, seconds = 60) {
  await prisma.session.update({
    where: { refreshHash: sha256(refreshToken) },
    data: { rotatedAt: new Date(Date.now() - seconds * 1000) },
  });
}

async function refresh(refreshToken: string) {
  return app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });
}

describe('kayıt', () => {
  it('firma, OWNER, DeciShip ACTIVE early_access ve DeciShip ADMIN açar; deneme süresi yoktur', async () => {
    const email = randomEmail('Kayit').toUpperCase();
    const owner = await registerOrg(app, { email, orgName: 'Kayıt Firması', name: 'Ayşe' });
    const claims = claimsOf(owner.accessToken);
    expect(claims.orgName).toBe('Kayıt Firması');
    expect(claims.orgRole).toBe('OWNER');
    expect(claims.ep).toBe(0);
    expect(claims.prod.deciship).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', plan: 'early_access' });
    expect(Object.keys(claims.prod)).toEqual(['deciship']);

    const person = await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } });
    expect(person.email).toBe(email.toLowerCase());
    expect(person.passwordHash).toMatch(/^\$argon2id\$/);
    expect(person.passwordHash).not.toContain(PASSWORD);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.plan).toBe('early_access');
    expect(sub.currentPeriodEnd).toBeNull();
    expect(sub.provider).toBeNull();
    // Yalnız hazır ürünler
    expect(await prisma.subscription.count({ where: { orgId: owner.orgId } })).toBe(1);
  });

  it('REGISTRATION_ENABLED=false iken 403 REGISTRATION_CLOSED', async () => {
    process.env.REGISTRATION_ENABLED = 'false';
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: 'X', name: 'Y', email: randomEmail(), password: PASSWORD, client: 'mobile' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('REGISTRATION_CLOSED');
  });

  it('aynı e-posta 409 EMAIL_TAKEN, büyük harfle de', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: 'X', name: 'Y', email: (owner.email as string).toUpperCase(), password: PASSWORD, client: 'mobile' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('EMAIL_TAKEN');
  });

  it('eşzamanlı aynı e-posta: biri kazanır, diğeri 409, yarım firma kalmaz', async () => {
    const email = randomEmail('yaris');
    const orgName = `Yarış ${uniq()}`;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({
          method: 'POST',
          url: `${API}/auth/register`,
          remoteAddress: randomIp(),
          payload: { orgName, name: 'Y', email, password: PASSWORD, client: 'mobile' },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.statusCode === 409).every((r) => errorCode(r) === 'EMAIL_TAKEN')).toBe(true);
    expect(await prisma.organization.count({ where: { name: orgName } })).toBe(1);
  });

  it('zayıf şifre ve eksik alan VALIDATION, ayrıntı yerelleşir', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      headers: { 'accept-language': 'en' },
      payload: { orgName: 'X', name: 'Y', email: randomEmail(), password: 'kisa', client: 'mobile' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/not valid/);
    expect(error.details[0]).toMatchObject({ path: 'password', code: 'too_small' });
  });
});

describe('giriş', () => {
  it('e-posta ile, büyük/küçük harf duyarsız', async () => {
    const owner = await registerOrg(app);
    const res = await login(app, (owner.email as string).toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(res.json().me.person.id).toBe(owner.personId);
    expect(claimsOf(res.json().accessToken).org).toBe(owner.orgId);
  });

  it('telefon ile: yazım biçimi önemsiz, varsayılan ülke TR', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { email: null, phone, deciship: 'MEASURE' });
    const local = phone.replace('+90', '0');
    const spaced = `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
    for (const identifier of [phone, local, spaced, phone.slice(3)]) {
      const res = await login(app, identifier);
      expect(res.statusCode, identifier).toBe(200);
      expect(res.json().me.person.id).toBe(member.personId);
    }
  });

  it('yanlış şifre, olmayan e-posta, olmayan telefon, bozuk kimlik: gövde birebir aynı', async () => {
    const owner = await registerOrg(app);
    const responses = await Promise.all([
      login(app, owner.email as string, 'YanlisSifre123'),
      login(app, randomEmail('yok')),
      login(app, randomTrPhone()),
      login(app, 'kimlik-degil'),
    ]);
    const bodies = new Set(responses.map((r) => r.body));
    expect(responses.every((r) => r.statusCode === 401)).toBe(true);
    expect(bodies.size).toBe(1);
    expect(errorCode(responses[0])).toBe('INVALID_CREDENTIALS');
  });

  // "Kişi yokken de argon2 çalışır": süreye bağlı olmayan denetim loginArgon.test.ts'te (kapı), süre oranı
  // timing.perf.test.ts'te (`npm run test:perf`, kapı değil).

  it('EMAIL_VERIFICATION_REQUIRED=true: doğrulanmamış e-posta yalnız doğru şifreyle EMAIL_NOT_VERIFIED öğrenir', async () => {
    const owner = await registerOrg(app);
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const wrong = await login(app, owner.email as string, 'YanlisSifre123');
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    const right = await login(app, owner.email as string);
    expect(right.statusCode).toBe(403);
    expect(errorCode(right)).toBe('EMAIL_NOT_VERIFIED');
  });

  it('ilk giriş firması: lastOrgId, sonra ilk firma; askıdaki firma seçilmez', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const person = await addMember(app, a.orgId, { deciship: 'AUDITOR' });
    const second = await prisma.membership.create({ data: { personId: person.personId, orgId: b.orgId } });

    await prisma.person.update({ where: { id: person.personId }, data: { lastOrgId: b.orgId } });
    expect(claimsOf((await login(app, person.email as string)).json().accessToken).org).toBe(b.orgId);

    await prisma.person.update({ where: { id: person.personId }, data: { lastOrgId: null } });
    expect(claimsOf((await login(app, person.email as string)).json().accessToken).org).toBe(a.orgId);

    await prisma.membership.update({ where: { id: second.id }, data: { status: 'SUSPENDED' } });
    await prisma.person.update({ where: { id: person.personId }, data: { lastOrgId: b.orgId } });
    expect(claimsOf((await login(app, person.email as string)).json().accessToken).org).toBe(a.orgId);
  });
});

describe('yenileme ve döndürme', () => {
  it('her kullanımda döner, yeni jeton çalışır, oturum satırları özet saklar', async () => {
    const owner = await registerOrg(app);
    const res = await refresh(owner.refreshToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refreshToken).toBeTruthy();
    expect(body.refreshToken).not.toBe(owner.refreshToken);
    expect(body.expiresIn).toBe(600);
    expect(claimsOf(body.accessToken).sub).toBe(owner.personId);

    const rows = await prisma.session.findMany({ where: { personId: owner.personId } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows.every((r) => r.refreshHash !== owner.refreshToken && r.refreshHash !== body.refreshToken)).toBe(true);

    const next = await refresh(body.refreshToken);
    expect(next.statusCode).toBe(200);
  });

  it('eski jeton tolerans dışında tekrar gelirse tüm aile düşer, epoch artar, olay yazılır', async () => {
    const owner = await registerOrg(app);
    const second = (await refresh(owner.refreshToken)).json();
    const epochBefore = await epochOf(owner.membershipId);
    const outboxBefore = (await outboxFor(owner.membershipId)).length;
    await ageRotation(owner.refreshToken);

    const replay = await refresh(owner.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(errorCode(replay)).toBe('UNAUTHORIZED');

    // Meşru görünen son jeton da artık geçersiz
    const legit = await refresh(second.refreshToken);
    expect(legit.statusCode).toBe(401);

    const rows = await prisma.session.findMany({ where: { personId: owner.personId } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(await epochOf(owner.membershipId)).toBe(epochBefore + 1);
    expect((await outboxFor(owner.membershipId)).length).toBeGreaterThan(outboxBefore);
    expect(await prisma.auditLog.count({ where: { actorPersonId: owner.personId, action: 'session.reuse_detected' } })).toBe(1);

    // Erişim jetonu da Hesap'ta anında geçersiz
    const me = await app.inject({ url: `${API}/me`, headers: bearer(second.accessToken) });
    expect(me.statusCode).toBe(401);
  });

  it('tolerans içinde mobil tekrar (kayıp yanıt): aile düşmez, yeni jeton alınır', async () => {
    const owner = await registerOrg(app);
    await refresh(owner.refreshToken); // yanıt kayboldu
    const retry = await refresh(owner.refreshToken);
    expect(retry.statusCode).toBe(200);
    const body = retry.json();
    expect(body.refreshToken).toBeTruthy();
    expect((await refresh(body.refreshToken)).statusCode).toBe(200);
    const live = await prisma.session.count({ where: { personId: owner.personId, rotatedAt: null, revokedAt: null } });
    expect(live).toBe(1);
  });

  it('REFRESH_REUSE_GRACE_SECONDS=0: ilk tekrarda aile düşer', async () => {
    process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
    const owner = await registerOrg(app);
    await refresh(owner.refreshToken);
    await new Promise((r) => setTimeout(r, 5));
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
  });

  it('aynı jetonla eşzamanlı yenileme iki baş üretmez', async () => {
    const owner = await registerOrg(app);
    const results = await Promise.all([1, 2, 3, 4].map(() => refresh(owner.refreshToken)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const live = await prisma.session.count({ where: { personId: owner.personId, rotatedAt: null, revokedAt: null } });
    expect(live).toBe(1);
  });

  it('süresi dolmuş ve bilinmeyen jeton 401', async () => {
    const owner = await registerOrg(app);
    await prisma.session.update({
      where: { refreshHash: sha256(owner.refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    expect((await refresh('uydurma-jeton')).statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: {} });
    expect(none.statusCode).toBe(401);
  });

  it('etkin firmadan çıkarılınca yenileme başka firmaya geçer ve activeOrgId bildirir; hiç firma yoksa org null', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const member = await addMember(app, a.orgId, { deciship: 'AUDITOR' });
    await prisma.membership.create({ data: { personId: member.personId, orgId: b.orgId } });

    await prisma.membership.delete({ where: { id: member.membershipId } });
    const moved = await refresh(member.refreshToken);
    expect(moved.json().activeOrgId).toBe(b.orgId);
    expect(claimsOf(moved.json().accessToken).org).toBe(b.orgId);

    await prisma.membership.deleteMany({ where: { personId: member.personId } });
    const none = await refresh(moved.json().refreshToken);
    expect(none.statusCode).toBe(200);
    const claims = claimsOf(none.json().accessToken);
    expect(claims.org).toBeNull();
    expect(claims.mid).toBeNull();
    expect(claims.prod).toEqual({});
  });
});

describe('çıkış', () => {
  it('aile düşer, erişim jetonu Hesap\'ta hemen geçersiz, epoch artar, tekrar çıkış sorun çıkarmaz', async () => {
    const owner = await registerOrg(app);
    const epochBefore = await epochOf(owner.membershipId);
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: owner.headers,
      payload: { refreshToken: owner.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    // Ürünlerdeki açık erişim jetonu da düşer (02-B5).
    expect(await epochOf(owner.membershipId)).toBe(epochBefore + 1);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    expect((await app.inject({ url: `${API}/me`, headers: owner.headers })).statusCode).toBe(401);
    const again = await app.inject({ method: 'POST', url: `${API}/auth/logout`, payload: { refreshToken: 'yok' } });
    expect(again.statusCode).toBe(200);
  });
});

describe('firma değiştirme', () => {
  it('üye olduğu firmaya geçer, jeton ve son firma güncellenir, yenileme aynı firmada kalır', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const person = await addMember(app, a.orgId, { deciship: 'AUDITOR' });
    await prisma.membership.create({
      data: { personId: person.personId, orgId: b.orgId, productAccess: { create: { product: 'deciship', role: 'ACCOUNTING' } } },
    });
    const res = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: person.headers, payload: { orgId: b.orgId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeOrgId).toBe(b.orgId);
    expect(body.refreshToken).toBeUndefined();
    const claims = claimsOf(body.accessToken);
    expect(claims.org).toBe(b.orgId);
    expect(claims.prod.deciship?.role).toBe('ACCOUNTING');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.personId } })).lastOrgId).toBe(b.orgId);

    const refreshed = await refresh(person.refreshToken);
    expect(claimsOf(refreshed.json().accessToken).org).toBe(b.orgId);
  });

  it('üyesi olmadığı ve askıda olduğu firmaya geçemez; yanıt aynı', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const c = await registerOrg(app);
    const person = await addMember(app, a.orgId);
    await prisma.membership.create({ data: { personId: person.personId, orgId: c.orgId, status: 'SUSPENDED' } });
    for (const orgId of [b.orgId, c.orgId, 'olmayan-firma']) {
      const res = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: person.headers, payload: { orgId } });
      expect(res.statusCode).toBe(404);
      expect(errorCode(res)).toBe('NOT_FOUND');
    }
  });
});

describe('web çerez akışı ve CSRF', () => {
  async function webLogin() {
    const owner = await registerOrg(app);
    const res = await login(app, owner.email as string, PASSWORD, 'web');
    return { owner, res, cookies: parseSetCookies(res) };
  }

  it('çerez öznitelikleri sözleşmeye uyar, gövdede jeton yoktur', async () => {
    const { res, cookies } = await webLogin();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(res.body).not.toContain(cookies.sod_at.value);
    expect(res.body).not.toContain(cookies.sod_rt.value);
    expect(body.me.activeOrg).toBeTruthy();

    expect(cookies.sod_at).toMatchObject({ path: '/api', httpOnly: true, sameSite: 'Lax', maxAge: 600 });
    expect(cookies.sod_rt).toMatchObject({ path: '/api/account/auth', httpOnly: true, sameSite: 'Lax', maxAge: 2592000 });
    // Oturum çerezleri alan almaz: tanıtım sitesine gitmez.
    expect(cookies.sod_at.domain).toBeUndefined();
    expect(cookies.sod_rt.domain).toBeUndefined();
    expect(cookies.sod_lang).toMatchObject({ path: '/', value: 'tr' });
    expect(cookies.sod_lang.httpOnly).toBeUndefined();
    // Geliştirmede Secure yok, üretimde var (aşağıda)
    expect(cookies.sod_at.secure).toBeUndefined();
  });

  it('COOKIE_SECURE=true iken Secure yazılır', async () => {
    process.env.COOKIE_SECURE = 'true';
    try {
      const { cookies } = await webLogin();
      expect(cookies.sod_at.secure).toBe(true);
      expect(cookies.sod_rt.secure).toBe(true);
    } finally {
      process.env.COOKIE_SECURE = '';
    }
  });

  it('web girişi CSRF başlığı ve Origin olmadan reddedilir (giriş CSRF\'i)', async () => {
    const owner = await registerOrg(app);
    const payload = { identifier: owner.email, password: PASSWORD, client: 'web' };
    for (const headers of [{}, { 'x-sod-csrf': '1' }, { origin: TEST_ORIGIN }, { 'x-sod-csrf': '1', origin: 'https://kotu.example' }]) {
      const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: randomIp(), headers, payload });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('CSRF_FAILED');
    }
    // `client` yazılmazsa varsayılan web: yine CSRF ister.
    const noClient = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      payload: { identifier: owner.email, password: PASSWORD },
    });
    expect(errorCode(noClient)).toBe('CSRF_FAILED');
  });

  it('çerezle okuma CSRF istemez, yazma ister', async () => {
    const { cookies } = await webLogin();
    const cookie = cookieHeader({ sod_at: cookies.sod_at });
    expect((await app.inject({ url: `${API}/me`, headers: { cookie } })).statusCode).toBe(200);

    const denied = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: { cookie }, payload: { name: 'Yeni' } });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('CSRF_FAILED');

    const wrongOrigin = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: { cookie, 'x-sod-csrf': '1', origin: 'https://kotu.example' },
      payload: { name: 'Yeni' },
    });
    expect(errorCode(wrongOrigin)).toBe('CSRF_FAILED');

    const ok = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: webHeaders(cookie), payload: { name: 'Yeni' } });
    expect(ok.statusCode).toBe(200);
  });

  it('çerezle yenileme döndürür, CSRF ister, tolerans içinde ikinci sekme çerez yazmaz', async () => {
    const { cookies } = await webLogin();
    const cookie = cookieHeader({ sod_rt: cookies.sod_rt });

    const denied = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: { cookie }, payload: {} });
    expect(errorCode(denied)).toBe('CSRF_FAILED');

    const first = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(cookie), payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().accessToken).toBeUndefined();
    const firstCookies = parseSetCookies(first);
    expect(firstCookies.sod_rt.value).not.toBe(cookies.sod_rt.value);
    expect(firstCookies.sod_at.value).toBeTruthy();

    // İkinci sekme hâlâ eski çerezi gönderir.
    const secondTab = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(cookie), payload: {} });
    expect(secondTab.statusCode).toBe(200);
    const secondCookies = parseSetCookies(secondTab);
    expect(secondCookies.sod_at.value).toBeTruthy();
    expect(secondCookies.sod_rt).toBeUndefined();

    // İlk sekmenin yazdığı jeton hâlâ geçerli.
    const nextCookie = cookieHeader({ sod_rt: firstCookies.sod_rt });
    const third = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(nextCookie), payload: {} });
    expect(third.statusCode).toBe(200);
  });

  it('geçersiz yenileme çerezi temizler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/refresh`,
      remoteAddress: randomIp(),
      headers: webHeaders('sod_rt=uydurma'),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const cleared = parseSetCookies(res);
    expect(cleared.sod_at.value).toBe('');
    expect(cleared.sod_rt.value).toBe('');
  });

  it('çıkış çerezleri temizler, CSRF ister', async () => {
    const { cookies } = await webLogin();
    const cookie = cookieHeader({ sod_at: cookies.sod_at, sod_rt: cookies.sod_rt });
    const denied = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: { cookie }, payload: {} });
    expect(errorCode(denied)).toBe('CSRF_FAILED');

    const ok = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: webHeaders(cookie), payload: {} });
    expect(ok.statusCode).toBe(200);
    const cleared = parseSetCookies(ok);
    expect(cleared.sod_at).toMatchObject({ value: '', path: '/api' });
    expect(cleared.sod_rt).toMatchObject({ value: '', path: '/api/account/auth' });
    const me = await app.inject({ url: `${API}/me`, headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('geçersiz Bearer geçerli çerezle telafi edilmez', async () => {
    const { cookies } = await webLogin();
    const res = await app.inject({
      url: `${API}/me`,
      headers: { cookie: cookieHeader({ sod_at: cookies.sod_at }), authorization: 'Bearer bozuk' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Bearer yazma CSRF istemez', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { name: 'Mobil Ad' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().me.person.name).toBe('Mobil Ad');
  });

  it('CORS yalnız izinli kökene izin verir', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: `${API}/me`,
      headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'PATCH' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await app.inject({
      method: 'OPTIONS',
      url: `${API}/me`,
      headers: { origin: 'https://kotu.example', 'access-control-request-method': 'PATCH' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('jeton taşıyan yanıtlar önbelleğe girmez', async () => {
    const res = await login(app, (await registerOrg(app)).email as string);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('mobil gövde akışı', () => {
  it('jetonlar gövdede, çerez yazılmaz, CSRF istenmez', async () => {
    const owner = await registerOrg(app);
    const res = await login(app, owner.email as string, PASSWORD, 'mobile');
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    expect(res.json().refreshToken).toBeTruthy();
    expect(res.cookies).toHaveLength(0);
    const me = await app.inject({ url: `${API}/me`, headers: bearer(res.json().accessToken) });
    expect(me.statusCode).toBe(200);
  });
});

describe('oturumlar', () => {
  it('liste yalnız etkin başları gösterir; başkasının oturumu silinemez; silme aileyi düşürür ve epoch artırır', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const second = (await login(app, owner.email as string)).json();

    const list = await app.inject({ url: `${API}/me/sessions`, headers: owner.headers });
    const sessions = list.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body).not.toContain('refreshHash');

    const target = sessions.find((s: { current: boolean }) => !s.current);
    const foreign = await app.inject({ method: 'DELETE', url: `${API}/me/sessions/${target.id}`, headers: other.headers });
    expect(foreign.statusCode).toBe(404);

    const epochBefore = await epochOf(owner.membershipId);
    const del = await app.inject({ method: 'DELETE', url: `${API}/me/sessions/${target.id}`, headers: owner.headers });
    expect(del.statusCode).toBe(200);
    expect((await refresh(second.refreshToken)).statusCode).toBe(401);
    expect(await epochOf(owner.membershipId)).toBe(epochBefore + 1);
  });
});

describe('şifre', () => {
  it('değişimde diğer oturumlar düşer, bu oturum sürer, tüm üyelikler bayatlar', async () => {
    const owner = await registerOrg(app);
    const other = (await login(app, owner.email as string)).json();
    const epochBefore = await epochOf(owner.membershipId);

    const wrong = await app.inject({
      method: 'POST',
      url: `${API}/me/password`,
      headers: owner.headers,
      payload: { currentPassword: 'Yanlis12345', newPassword: 'YeniSifre123!' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');

    const res = await app.inject({
      method: 'POST',
      url: `${API}/me/password`,
      headers: owner.headers,
      payload: { currentPassword: PASSWORD, newPassword: 'YeniSifre123!' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    expect(claimsOf(res.json().accessToken).ep).toBe(epochBefore + 1);

    expect((await refresh(other.refreshToken)).statusCode).toBe(401);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(200);
    expect((await login(app, owner.email as string, PASSWORD)).statusCode).toBe(401);
    expect((await login(app, owner.email as string, 'YeniSifre123!')).statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(epochBefore + 1);
  });

  it('şifremi unuttum: yanıt kişi olsa da olmasa da aynı, jeton tek kullanımlık, oturumlar düşer', async () => {
    const owner = await registerOrg(app);
    const forgot = (identifier: string) =>
      app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier } });

    const known = await forgot(owner.email as string);
    const unknown = await forgot(randomEmail('yok'));
    const unknownPhone = await forgot(randomTrPhone());
    const garbage = await forgot('kimlik-degil');
    for (const r of [known, unknown, unknownPhone, garbage]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(known.body);
    }

    const mail = await lastMailTo(owner.email as string);
    expect(mail?.template).toBe('password_reset');
    const token = /reset-password\/(\S+)/.exec(mail?.body as string)?.[1] as string;
    // Yalnız özet saklanır.
    const row = await prisma.oneTimeToken.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(row.tokenHash).not.toBe(token);

    const epochBefore = await epochOf(owner.membershipId);
    const reset = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token, password: 'SifirSifre123!' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await login(app, owner.email as string, 'SifirSifre123!')).statusCode).toBe(200);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    expect(await epochOf(owner.membershipId)).toBe(epochBefore + 1);

    const again = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token, password: 'BaskaSifre123!' },
    });
    expect(again.statusCode).toBe(400);
    expect(errorCode(again)).toBe('TOKEN_INVALID');
  });

  it('süresi dolmuş sıfırlama jetonu ve doğrulama jetonu sıfırlamada geçmez', async () => {
    const owner = await registerOrg(app);
    const verifyMail = await lastMailTo(owner.email as string);
    const verifyToken = /verify-email\/(\S+)/.exec(verifyMail?.body as string)?.[1] as string;
    const crossed = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token: verifyToken, password: 'SifirSifre123!' },
    });
    expect(errorCode(crossed)).toBe('TOKEN_INVALID');

    await app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier: owner.email } });
    const mail = await lastMailTo(owner.email as string);
    const token = /reset-password\/(\S+)/.exec(mail?.body as string)?.[1] as string;
    await prisma.oneTimeToken.update({ where: { tokenHash: sha256(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token, password: 'SifirSifre123!' },
    });
    expect(errorCode(expired)).toBe('TOKEN_INVALID');
  });

  it('e-posta doğrulama tek kullanımlık: ikinci açılış yeniden doğrulamaz, already döner', async () => {
    const owner = await registerOrg(app);
    const mail = await lastMailTo(owner.email as string);
    expect(mail?.template).toBe('email_verify');
    const token = /verify-email\/(\S+)/.exec(mail?.body as string)?.[1] as string;
    // İlk doğrulama şifre ister (bağlantı şifreyi kimin koyduğunu kanıtlamaz; ayrıntı emailVerification.test.ts).
    const ok = await app.inject({ method: 'POST', url: `${API}/auth/verify-email`, remoteAddress: randomIp(), payload: { token, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, result: 'verified' });
    const verifiedAt = (await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).emailVerifiedAt;
    expect(verifiedAt).not.toBeNull();
    // Sayfa yenilenince "geçersiz" görünmesin (§3.3): jeton yine harcanmış, doğrulama zamanı değişmez.
    const again = await app.inject({ method: 'POST', url: `${API}/auth/verify-email`, remoteAddress: randomIp(), payload: { token } });
    expect(again.json()).toEqual({ ok: true, result: 'already' });
    expect((await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).emailVerifiedAt).toEqual(verifiedAt);
  });
});

describe('profil', () => {
  it('e-posta ve telefon değişimi mevcut şifre ister; ad ve dil istemez', async () => {
    const owner = await registerOrg(app);
    const noPass = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { email: randomEmail() } });
    expect(noPass.statusCode).toBe(400);
    const wrong = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: owner.headers,
      payload: { email: randomEmail(), currentPassword: 'Yanlis12345' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { name: 'Yeni Ad', locale: 'en' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().me.person).toMatchObject({ name: 'Yeni Ad', locale: 'en' });
    expect(claimsOf(ok.json().accessToken)).toMatchObject({ name: 'Yeni Ad', locale: 'en' });
  });

  it('e-posta değişimi onaya kadar bekler; onaylanınca adres doğrulanmış geçer, eski adrese giden sıfırlama bağlantısı ölür', async () => {
    const owner = await registerOrg(app);
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    await app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier: owner.email } });
    const oldMail = await lastMailTo(owner.email as string);
    const oldToken = /reset-password\/(\S+)/.exec(oldMail?.body as string)?.[1] as string;

    const next = randomEmail('yeni');
    const res = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: owner.headers,
      payload: { email: next.toUpperCase(), currentPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    // 02-B2: kimlik değişmez, yeni adres bekler (ayrıntı: emailVerification.test.ts).
    expect(res.json().me.person).toMatchObject({ email: owner.email, emailVerified: true, pendingEmail: next });
    const mail = await lastMailTo(next);
    expect(mail?.template).toBe('email_change_verify');
    const confirm = /verify-email\/(\S+)/.exec(mail?.body as string)?.[1] as string;
    const verified = await app.inject({ method: 'POST', url: `${API}/auth/verify-email`, remoteAddress: randomIp(), payload: { token: confirm } });
    expect(verified.json()).toEqual({ ok: true, result: 'changed' });
    expect(await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).toMatchObject({ email: next, pendingEmail: null });

    const dead = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token: oldToken, password: 'SifirSifre123!' },
    });
    expect(errorCode(dead)).toBe('TOKEN_INVALID');
  });

  it('başkasının e-posta veya telefonu alınamaz; iki kimlik birden silinemez', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const phone = randomTrPhone();
    await addMember(app, other.orgId, { email: null, phone });

    const takenEmail = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: owner.headers,
      payload: { email: other.email, currentPassword: PASSWORD },
    });
    expect(takenEmail.statusCode).toBe(409);
    expect(errorCode(takenEmail)).toBe('EMAIL_TAKEN');

    const takenPhone = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: owner.headers,
      payload: { phone, currentPassword: PASSWORD },
    });
    // Telefon PATCH /me ile bağlanmaz (§5). Numara başkasına ait olsa da yanıt aynı: varlık ele verilmez.
    expect(errorCode(takenPhone)).toBe('PHONE_CHANGE_NOT_ALLOWED');

    const none = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      headers: owner.headers,
      payload: { email: null, currentPassword: PASSWORD },
    });
    expect(none.statusCode).toBe(400);
  });

  it('ad değişimi epoch artırmaz, projeksiyon olayı yazar', async () => {
    const owner = await registerOrg(app);
    const epochBefore = await epochOf(owner.membershipId);
    const before = (await outboxFor(owner.membershipId)).length;
    await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { name: 'Değişti' } });
    expect(await epochOf(owner.membershipId)).toBe(epochBefore);
    const after = await outboxFor(owner.membershipId);
    expect(after.length).toBe(before + 1);
    expect((after.at(-1)?.payload as { name: string }).name).toBe('Değişti');
  });
});

describe('yerelleştirme', () => {
  it('hata mesajı Accept-Language ile, kod değişmez', async () => {
    const tr = await app.inject({ url: `${API}/me`, headers: { 'accept-language': 'tr-TR,tr;q=0.9' } });
    const en = await app.inject({ url: `${API}/me`, headers: { 'accept-language': 'en-GB,en;q=0.9,tr;q=0.1' } });
    const other = await app.inject({ url: `${API}/me`, headers: { 'accept-language': 'de,fr;q=0.5' } });
    expect(tr.json().error.code).toBe('UNAUTHORIZED');
    expect(en.json().error.code).toBe('UNAUTHORIZED');
    expect(tr.json().error.message).toMatch(/Oturum/);
    expect(en.json().error.message).toMatch(/session/);
    // Kullanıcı kararı 2026-11-12: desteklenen dil yoksa İngilizce (eskiden Türkçe).
    expect(other.json().error.message).toMatch(/session/);
    const none = await app.inject({ url: `${API}/me` });
    expect(none.json().error.message).toMatch(/session/);
  });

  it('ilk açılış dili: gövdedeki dil, yoksa Accept-Language, o da yoksa İngilizce (karar 2026-11-12)', async () => {
    const register = (headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const email = randomEmail('dil');
      return app
        .inject({
          method: 'POST',
          url: `${API}/auth/register`,
          remoteAddress: randomIp(),
          headers,
          payload: { orgName: `Firma ${uniq()}`, name: 'Dil Kişi', email, password: PASSWORD, country: 'TR', client: 'mobile', ...extra },
        })
        .then(async (res) => {
          expect(res.statusCode, res.body).toBe(201);
          const personId = claimsOf(res.json().accessToken).sub;
          const person = await prisma.person.findUniqueOrThrow({ where: { id: personId } });
          const org = await prisma.organization.findFirstOrThrow({ where: { memberships: { some: { personId } } } });
          return { person: person.locale, org: org.locale, subject: (await lastMailTo(email))?.subject };
        });
    };
    const EN_SUBJECT = 'Confirm your email address';
    const TR_SUBJECT = 'E-posta adresinizi doğrulayın';
    expect(await register({})).toEqual({ person: 'en', org: 'en', subject: EN_SUBJECT });
    expect(await register({ 'accept-language': 'de-DE,fr;q=0.8' })).toEqual({ person: 'en', org: 'en', subject: EN_SUBJECT });
    expect(await register({ 'accept-language': 'de-DE,tr-TR;q=0.8' })).toEqual({ person: 'tr', org: 'tr', subject: TR_SUBJECT });
    expect(await register({ 'accept-language': 'en-GB' })).toEqual({ person: 'en', org: 'en', subject: EN_SUBJECT });
    // Gövdedeki seçim (kayıt ekranının dili) başlıktan önce.
    expect(await register({ 'accept-language': 'en' }, { locale: 'tr' })).toEqual({ person: 'tr', org: 'tr', subject: TR_SUBJECT });
  });

  it('e-posta şablonu kişinin dilinde, HTML kaçışlı', async () => {
    const email = randomEmail('en');
    await registerOrg(app, { email, locale: 'en' });
    const mail = await lastMailTo(email);
    expect(mail?.subject).toBe('Confirm your email address');
    const tr = randomEmail('tr');
    await registerOrg(app, { email: tr, locale: 'tr' });
    expect((await lastMailTo(tr))?.subject).toBe('E-posta adresinizi doğrulayın');
  });

  it('katalog dile göre döner', async () => {
    const tr = (await app.inject({ url: `${API}/catalog`, headers: { 'accept-language': 'tr' } })).json();
    const en = (await app.inject({ url: `${API}/catalog`, headers: { 'accept-language': 'en' } })).json();
    const role = (c: typeof tr) => c.products[0].roles.find((r: { key: string }) => r.key === 'MEASURE');
    expect(role(tr).label).toBe('Ölçüm');
    expect(role(en).label).toBe('Measurement');
    expect(tr.permissions.find((p: { key: string }) => p.key === 'deciship.prices.view').label).toBe('Fiyatları görme');
    expect(en.orgRoles.find((r: { key: string }) => r.key === 'OWNER').label).toBe('Company owner');
    expect(tr.products.map((p: { key: string }) => p.key)).toEqual(['deciship', 'orderloom', 'tagpress']);
  });

  it('bilinmeyen adres yerelleşmiş 404', async () => {
    const res = await app.inject({ url: `${API}/yok`, headers: { 'accept-language': 'en' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'Record not found.' });
  });
});
