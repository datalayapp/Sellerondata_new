import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { assertConfig, assertProductionConfig } from '../src/env.ts';
import { ipBucket } from '../src/lib/identity.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import {
  addMember,
  API,
  cookieHeader,
  errorCode,
  getApp,
  login,
  parseSetCookies,
  PASSWORD,
  randomIp,
  registerOrg,
  webHeaders,
  type Ctx,
} from './helpers.ts';
import { TEST_ORIGIN, TEST_SITE_ORIGIN } from './testEnv.ts';

/**
 * Tek hesap: tanıtım sitesinin "kimim" yoklaması (`GET /auth/site-session`) ve siteden çıkış (ARCHITECTURE §5 "Tek hesap").
 * Uç salt okunurdur: jeton döndürmez, satıra yazmaz, aileyi düşürmez. Site kökeni yalnız bu iki uçta CORS ve CSRF'i geçer.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const SITE_URL = `${API}/auth/site-session`;

type Web = { owner: Ctx; cookies: ReturnType<typeof parseSetCookies>; rt: string; cookie: string; personId: string };

/** Firma + OWNER, ardından web girişi: yenileme çerezi elde. */
async function webOwner(): Promise<Web> {
  const owner = await registerOrg(app);
  return { owner, ...(await webLoginOf(owner.email as string, owner.personId)) };
}

async function webLoginOf(email: string, personId: string) {
  const res = await login(app, email, PASSWORD, 'web');
  expect(res.statusCode, res.body).toBe(200);
  const cookies = parseSetCookies(res);
  return { cookies, rt: cookies.sod_rt.value, cookie: cookieHeader({ sod_at: cookies.sod_at, sod_rt: cookies.sod_rt }), personId };
}

function probe(headers: Record<string, string> = {}, remoteAddress = randomIp()) {
  return app.inject({ method: 'GET', url: SITE_URL, remoteAddress, headers });
}
const withRt = (rt: string, extra: Record<string, string> = {}) => probe({ cookie: `sod_rt=${rt}`, ...extra });

/** Kişinin bütün oturum satırları: yoklama hiçbirini değiştirmemeli (lastUsedAt dahil). */
function sessionRows(personId: string) {
  return prisma.session.findMany({ where: { personId }, orderBy: { id: 'asc' } });
}

async function rotate(cookie: string) {
  const res = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(cookie), payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return parseSetCookies(res);
}

function varyOf(res: { headers: Record<string, unknown> }) {
  return String(res.headers.vary ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase());
}

describe('site-session: yanıt biçimi', () => {
  it('çerez yok: signedIn false, önbelleğe girmez, Vary Origin ve Cookie', async () => {
    const res = await probe();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signedIn: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(varyOf(res)).toEqual(expect.arrayContaining(['origin', 'cookie']));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('geçerli web oturumu: ad, firma, yönetim; jeton yok, çerez yazılmaz, satır değişmez', async () => {
    const w = await webOwner();
    const before = await sessionRows(w.personId);
    const audits = await prisma.auditLog.count({ where: { actorPersonId: w.personId } });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: w.owner.orgId } });

    const res = await withRt(w.rt);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signedIn: true, name: 'Sahip Kişi', orgName: org.name, canManageOrg: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    for (const secret of [w.rt, w.cookies.sod_at.value, w.personId, w.owner.orgId, w.owner.email as string]) expect(res.body).not.toContain(secret);

    // Birkaç yoklama daha: satır, denetim izi, epoch aynı kalır.
    for (let i = 0; i < 3; i++) await withRt(w.rt);
    expect(await sessionRows(w.personId)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { actorPersonId: w.personId } })).toBe(audits);
  });

  it('erişim çerezi tek başına yetmez: yalnız yenileme çerezine bakılır', async () => {
    const w = await webOwner();
    const res = await probe({ cookie: cookieHeader({ sod_at: w.cookies.sod_at }) });
    expect(res.json()).toEqual({ signedIn: false });
  });

  it('Bearer yok sayılır: mobil jeton siteye oturum açtırmaz', async () => {
    const owner = await registerOrg(app);
    const res = await probe({ ...owner.headers });
    expect(res.json()).toEqual({ signedIn: false });
    // Mobil yenileme jetonu çereze konsa da web oturumu sayılmaz.
    expect((await withRt(owner.refreshToken)).json()).toEqual({ signedIn: false });
  });

  it('bozuk ve aşırı uzun çerez: signedIn false', async () => {
    expect((await withRt('uydurma')).json()).toEqual({ signedIn: false });
    expect((await withRt('x'.repeat(5000))).json()).toEqual({ signedIn: false });
  });
});

describe('site-session: döndürme, iptal, süre', () => {
  it('döndürülmüş eski jeton tolerans içinde bile false; aile düşmez, ardından normal yenileme çalışır', async () => {
    const w = await webOwner();
    const next = await rotate(w.cookie);
    const beforeRows = await sessionRows(w.personId);

    // Tolerans süresi (10 sn) içinde.
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
    // Yeni baş geçerli.
    expect((await withRt(next.sod_rt.value)).json()).toMatchObject({ signedIn: true });
    expect(await sessionRows(w.personId)).toEqual(beforeRows);

    // Yoklama tolerans hakkını da yemez: eski çerezle ikinci sekme hâlâ yenileyebilir (aile iptal edilmedi).
    const secondTab = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(w.cookie), payload: {} });
    expect(secondTab.statusCode).toBe(200);
    // Yeni baş ile normal yenileme.
    const third = await rotate(cookieHeader({ sod_rt: next.sod_rt }));
    expect((await withRt(third.sod_rt.value)).json()).toMatchObject({ signedIn: true });
  });

  it('tolerans dışındaki eski jeton: false, hırsızlık sayılmaz (aile, epoch, denetim izi aynı)', async () => {
    const w = await webOwner();
    const next = await rotate(w.cookie);
    // Eski satırı bir saat önce döndürülmüş gibi göster: /auth/refresh bunu hırsızlık sayardı.
    const { sha256 } = await import('../src/lib/crypto.ts');
    await prisma.session.update({ where: { refreshHash: sha256(w.rt) }, data: { rotatedAt: new Date(Date.now() - 60 * 60_000) } });
    const rows = await sessionRows(w.personId);
    const epoch = (await prisma.membership.findUniqueOrThrow({ where: { id: w.owner.membershipId } })).epoch;

    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });

    expect(await sessionRows(w.personId)).toEqual(rows);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: w.owner.membershipId } })).epoch).toBe(epoch);
    expect(await prisma.auditLog.count({ where: { actorPersonId: w.personId, action: 'session.reuse_detected' } })).toBe(0);
    expect((await withRt(next.sod_rt.value)).json()).toMatchObject({ signedIn: true });
    await rotate(cookieHeader({ sod_rt: next.sod_rt }));
  });

  it('çıkıştan sonra false', async () => {
    const w = await webOwner();
    expect((await withRt(w.rt)).json()).toMatchObject({ signedIn: true });
    const out = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: webHeaders(w.cookie), payload: {} });
    expect(out.statusCode).toBe(200);
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
  });

  it('başka cihazdan oturum kapatma (DELETE /me/sessions/:id) sonrası false', async () => {
    const w = await webOwner();
    const web = await prisma.session.findFirstOrThrow({ where: { personId: w.personId, client: 'web', rotatedAt: null, revokedAt: null } });
    const res = await app.inject({ method: 'DELETE', url: `${API}/me/sessions/${web.id}`, headers: w.owner.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
  });

  it('şifre değişimi (başka oturumdan) sonrası false', async () => {
    const w = await webOwner();
    const res = await app.inject({
      method: 'POST',
      url: `${API}/me/password`,
      headers: w.owner.headers,
      payload: { currentPassword: PASSWORD, newPassword: 'YeniMavi-Kedi-81' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
  });

  it('süresi geçmiş oturum: false', async () => {
    const w = await webOwner();
    const { sha256 } = await import('../src/lib/crypto.ts');
    await prisma.session.update({ where: { refreshHash: sha256(w.rt) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
  });

  it('yinelenen sod_rt çerezi: false (alt alan adından yazılmış olabilir)', async () => {
    const w = await webOwner();
    expect((await probe({ cookie: `sod_rt=${w.rt}; sod_rt=${w.rt}` })).json()).toEqual({ signedIn: false });
    expect((await probe({ cookie: `sod_rt=uydurma; sod_rt=${w.rt}` })).json()).toEqual({ signedIn: false });
  });
});

describe('site-session: kişi ve üyelik', () => {
  it('askıdaki kişi: false', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const w = await webLoginOf(member.email as string, member.personId);
    expect((await withRt(w.rt)).json()).toMatchObject({ signedIn: true });
    await prisma.person.update({ where: { id: member.personId }, data: { suspendedAt: new Date() } });
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
  });

  describe('EMAIL_VERIFICATION_REQUIRED', () => {
    afterEach(() => {
      process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    });

    it('açıkken doğrulanmamış e-posta false, doğrulanınca true', async () => {
      const w = await webOwner();
      process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
      expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
      await prisma.person.update({ where: { id: w.personId }, data: { emailVerifiedAt: new Date() } });
      expect((await withRt(w.rt)).json()).toMatchObject({ signedIn: true });
    });
  });

  it('canManageOrg: OWNER ve ADMIN true, MEMBER false', async () => {
    const w = await webOwner();
    expect((await withRt(w.rt)).json().canManageOrg).toBe(true);
    const admin = await addMember(app, w.owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
    const adminWeb = await webLoginOf(admin.email as string, admin.personId);
    expect((await withRt(adminWeb.rt)).json()).toMatchObject({ signedIn: true, canManageOrg: true });
    const member = await addMember(app, w.owner.orgId, { deciship: 'AUDITOR' });
    const memberWeb = await webLoginOf(member.email as string, member.personId);
    const body = (await withRt(memberWeb.rt)).json();
    expect(body).toMatchObject({ signedIn: true, canManageOrg: false });
    expect(body.orgName).toBeTruthy();
  });

  it('askıya alınan üyelik: orgName null, canManageOrg false, oturum yine açık', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const w = await webLoginOf(admin.email as string, admin.personId);
    await prisma.membership.update({ where: { id: admin.membershipId }, data: { status: 'SUSPENDED' } });
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: true, name: expect.any(String), orgName: null, canManageOrg: false });
  });

  it('firması kalmamış kişi: orgName null', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const w = await webLoginOf(member.email as string, member.personId);
    await prisma.membership.delete({ where: { id: member.membershipId } });
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: true, name: expect.any(String), orgName: null, canManageOrg: false });
  });
});

describe('site-session: CORS ve Sec-Fetch-Site', () => {
  it('site kökeni kimlikli CORS yanıtı alır; bilinmeyen köken almaz; uygulama kökeni alır', async () => {
    const w = await webOwner();
    const site = await withRt(w.rt, { origin: TEST_SITE_ORIGIN });
    expect(site.headers['access-control-allow-origin']).toBe(TEST_SITE_ORIGIN);
    expect(site.headers['access-control-allow-credentials']).toBe('true');
    expect(varyOf(site)).toEqual(expect.arrayContaining(['origin', 'cookie']));
    expect(site.json()).toMatchObject({ signedIn: true });

    for (const origin of ['https://kotu.example', 'http://localhost:8089.kotu.example', 'null']) {
      const denied = await withRt(w.rt, { origin });
      expect(denied.headers['access-control-allow-origin'], origin).toBeUndefined();
      expect(denied.headers['access-control-allow-credentials'], origin).toBeUndefined();
      expect(varyOf(denied)).toContain('origin');
    }

    const appRes = await withRt(w.rt, { origin: TEST_ORIGIN });
    expect(appRes.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
  });

  it('Sec-Fetch-Site: cross-site her zaman false; same-site ve same-origin normal', async () => {
    const w = await webOwner();
    expect((await withRt(w.rt, { 'sec-fetch-site': 'cross-site', origin: TEST_SITE_ORIGIN })).json()).toEqual({ signedIn: false });
    expect((await withRt(w.rt, { 'sec-fetch-site': 'same-site', origin: TEST_SITE_ORIGIN })).json()).toMatchObject({ signedIn: true });
    expect((await withRt(w.rt, { 'sec-fetch-site': 'same-origin' })).json()).toMatchObject({ signedIn: true });
  });
});

describe('site kökeni: yalnız site-session ve logout', () => {
  it('siteden çıkış: ön uçuş izinli, CSRF başlığıyla çalışır, oturum gerçekten düşer', async () => {
    const w = await webOwner();
    const pre = await app.inject({
      method: 'OPTIONS',
      url: `${API}/auth/logout`,
      headers: { origin: TEST_SITE_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sod-csrf' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(TEST_SITE_ORIGIN);
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    const allowHeaders = String(pre.headers['access-control-allow-headers']).toLowerCase();
    expect(allowHeaders).toContain('x-sod-csrf');
    expect(allowHeaders).not.toContain('authorization');
    expect(allowHeaders).not.toContain('x-sod-org');
    expect(String(pre.headers['access-control-allow-methods'])).not.toMatch(/PATCH|DELETE/);

    const res = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: { cookie: w.cookie, 'x-sod-csrf': '1', origin: TEST_SITE_ORIGIN } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_SITE_ORIGIN);
    const cleared = parseSetCookies(res);
    expect(cleared.sod_rt).toMatchObject({ value: '' });
    expect((await withRt(w.rt)).json()).toEqual({ signedIn: false });
    expect((await app.inject({ url: `${API}/me`, headers: { cookie: w.cookie } })).statusCode).toBe(401);
    const live = await prisma.session.count({ where: { personId: w.personId, client: 'web', revokedAt: null } });
    expect(live).toBe(0);
  });

  it('siteden çıkış CSRF başlıksız veya yanlış kökenle 403, oturum açık kalır', async () => {
    const w = await webOwner();
    for (const headers of [
      { cookie: w.cookie, origin: TEST_SITE_ORIGIN },
      { cookie: w.cookie, 'x-sod-csrf': '1', origin: 'https://kotu.example' },
      { cookie: w.cookie, 'x-sod-csrf': '1' },
    ]) {
      const res = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('CSRF_FAILED');
    }
    expect((await withRt(w.rt)).json()).toMatchObject({ signedIn: true });
  });

  it('bilinmeyen kökenden çıkış ön uçuşu: 404, CORS başlığı yok', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: `${API}/auth/logout`,
      headers: { origin: 'https://kotu.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sod-csrf' },
    });
    expect(pre.statusCode).toBe(404);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uygulama kökeni çıkış ön uçuşunu bugünkü gibi geçer', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: `${API}/auth/logout`,
      headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sod-csrf, x-sod-org, content-type' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(String(pre.headers['access-control-allow-headers']).toLowerCase()).toContain('x-sod-org');
  });

  it('site kökeni diğer uçlarda CSRF_FAILED alır ve ön uçuşta CORS başlığı almaz', async () => {
    const w = await webOwner();
    const siteHeaders = { cookie: w.cookie, 'x-sod-csrf': '1', origin: TEST_SITE_ORIGIN };
    const writes: { method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: Record<string, unknown>; headers?: Record<string, string> }[] = [
      { method: 'POST', url: '/auth/login', payload: { identifier: w.owner.email, password: PASSWORD, client: 'web' }, headers: { 'x-sod-csrf': '1', origin: TEST_SITE_ORIGIN } },
      { method: 'POST', url: '/auth/register', payload: { orgName: 'Site Firma', name: 'Site Kişi', email: 'site-kayit@test.sellerondata.com', password: PASSWORD }, headers: { 'x-sod-csrf': '1', origin: TEST_SITE_ORIGIN } },
      { method: 'POST', url: '/auth/refresh', payload: {} },
      { method: 'POST', url: '/auth/switch-org', payload: { orgId: w.owner.orgId } },
      { method: 'PATCH', url: '/me', payload: { name: 'Siteden Değişti' } },
      { method: 'POST', url: '/me/password', payload: { currentPassword: PASSWORD, newPassword: 'YeniMavi-Kedi-81' } },
      { method: 'DELETE', url: '/me/sessions/yok' },
      { method: 'POST', url: '/orgs', payload: { name: 'Siteden Firma' } },
      { method: 'PATCH', url: '/org', payload: { name: 'Siteden Firma' }, headers: { ...siteHeaders, 'x-sod-org': w.owner.orgId } },
      { method: 'POST', url: '/org/members/invite', payload: { kind: 'EMAIL', email: 'siteden@test.sellerondata.com', name: 'Siteden' }, headers: { ...siteHeaders, 'x-sod-org': w.owner.orgId } },
      { method: 'POST', url: '/org/leave', payload: {}, headers: { ...siteHeaders, 'x-sod-org': w.owner.orgId } },
    ];
    for (const write of writes) {
      const res = await app.inject({ method: write.method, url: `${API}${write.url}`, remoteAddress: randomIp(), headers: write.headers ?? siteHeaders, payload: write.payload });
      expect(res.statusCode, `${write.method} ${write.url}: ${res.body}`).toBe(403);
      expect(errorCode(res), `${write.method} ${write.url}`).toBe('CSRF_FAILED');
      expect(res.headers['access-control-allow-origin'], `${write.method} ${write.url}`).toBeUndefined();

      const pre = await app.inject({
        method: 'OPTIONS',
        url: `${API}${write.url}`,
        headers: { origin: TEST_SITE_ORIGIN, 'access-control-request-method': write.method, 'access-control-request-headers': 'x-sod-csrf, content-type' },
      });
      expect(pre.headers['access-control-allow-origin'], `ön uçuş ${write.url}`).toBeUndefined();
      expect(pre.headers['access-control-allow-credentials'], `ön uçuş ${write.url}`).toBeUndefined();
      expect(pre.statusCode, `ön uçuş ${write.url}`).toBe(404);
    }
    // Hiçbiri iş yapmadı: ad, firma ve oturum aynı.
    const person = await prisma.person.findUniqueOrThrow({ where: { id: w.personId } });
    expect(person.name).toBe('Sahip Kişi');
    expect((await withRt(w.rt)).json()).toMatchObject({ signedIn: true });
  });

  it('site kökeniyle okuma uçları CORS başlığı almaz: sitedeki betik /me yanıtını okuyamaz', async () => {
    const w = await webOwner();
    for (const url of ['/me', '/me/sessions', '/org', '/org/members', '/catalog']) {
      const res = await app.inject({ url: `${API}${url}`, headers: { cookie: w.cookie, origin: TEST_SITE_ORIGIN } });
      expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
    }
    // Uygulama kökeni bugünkü gibi alır.
    const appRes = await app.inject({ url: `${API}/me`, headers: { cookie: w.cookie, origin: TEST_ORIGIN } });
    expect(appRes.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
  });
});

describe('site-session: hız sınırı', () => {
  it('IP başına sayılır, aşınca 429; başka IP etkilenmez', async () => {
    const ip = randomIp();
    const key = `site-session:ip:${ipBucket(ip)}`;
    expect((await probe({}, ip)).statusCode).toBe(200);
    expect((await prisma.rateBucket.findUniqueOrThrow({ where: { key } })).count).toBe(1);

    await prisma.rateBucket.update({ where: { key }, data: { count: RATE_RULES.siteSessionIp.limit } });
    const limited = await probe({ origin: TEST_SITE_ORIGIN }, ip);
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe('TOO_MANY_ATTEMPTS');
    expect(limited.headers['retry-after']).toBeTruthy();
    // Site 429'u okuyabilir ve "giriş yapılmamış"a düşer; tarayıcı CORS hatası görmez.
    expect(limited.headers['access-control-allow-origin']).toBe(TEST_SITE_ORIGIN);

    expect((await probe({}, randomIp())).statusCode).toBe(200);
  });

  it('sınır cömert: tek sayfa ziyaretlerini kesmez', () => {
    expect(RATE_RULES.siteSessionIp.limit).toBeGreaterThanOrEqual(300);
  });
});

describe('SITE_ORIGINS ayarı', () => {
  const base = {
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://app.test',
    APP_BASE_URL: 'https://app.test',
    DATABASE_URL: 'postgresql://sod_platform:gercek-parola@db:5432/sellerondata',
    ACCOUNT_CODE_PEPPER: 'p'.repeat(40),
    SMTP_URL: 'smtp://mail:25',
    SITE_ORIGINS: 'https://site.test',
    // Üretimde doğrulama zorunlu (02-B1): taban geçerli üretim ayarıdır.
    EMAIL_VERIFICATION_REQUIRED: 'true',
  };
  function withEnv(over: Record<string, string | undefined>, fn: () => void) {
    const merged = { ...base, ...over };
    const saved = Object.fromEntries(Object.keys(merged).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(merged)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('üretimde https kökenle açılır', () => {
    withEnv({}, () => expect(() => assertProductionConfig()).not.toThrow());
    withEnv({ SITE_ORIGINS: 'https://site.test, https://www.site.test/' }, () => expect(() => assertProductionConfig()).not.toThrow());
  });

  it('üretimde SITE_ORIGINS yoksa başlamaz; geliştirme varsayılanına düşmez', () => {
    withEnv({ SITE_ORIGINS: undefined }, () => expect(() => assertProductionConfig()).toThrow(/SITE_ORIGINS/));
    withEnv({ SITE_ORIGINS: ' , ' }, () => expect(() => assertProductionConfig()).toThrow(/SITE_ORIGINS/));
  });

  it('üretimde https değilse başlamaz (yalnız localhost serbest)', () => {
    withEnv({ SITE_ORIGINS: 'http://site.test' }, () => expect(() => assertProductionConfig()).toThrow(/SITE_ORIGINS.*https/));
    withEnv({ SITE_ORIGINS: 'https://site.test,http://www.site.test' }, () => expect(() => assertProductionConfig()).toThrow(/https/));
    withEnv({ SITE_ORIGINS: 'http://localhost:8089' }, () => expect(() => assertProductionConfig()).not.toThrow());
  });

  it('yalın köken değilse (yol, joker, şema yok) her ortamda başlamaz', () => {
    for (const value of ['https://site.test/yol', '*', 'site.test', 'ftp://site.test', 'null', 'https://*.site.test']) {
      withEnv({ SITE_ORIGINS: value }, () => expect(() => assertProductionConfig(), value).toThrow(/SITE_ORIGINS/));
      withEnv({ NODE_ENV: 'development', SITE_ORIGINS: value }, () => expect(() => assertConfig(), value).toThrow(/SITE_ORIGINS/));
    }
  });

  it('ALLOWED_ORIGINS ile çakışırsa başlamaz: site uygulama kökeni sayılmaz', () => {
    withEnv({ SITE_ORIGINS: 'https://app.test' }, () => expect(() => assertProductionConfig()).toThrow(/çakışıyor/));
    withEnv({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://localhost:8089', SITE_ORIGINS: undefined }, () =>
      expect(() => assertConfig()).toThrow(/çakışıyor/),
    );
  });
});
