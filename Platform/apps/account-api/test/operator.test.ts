/**
 * Platform yöneticisi ve adım artırma (YAPAY-ZEKA-GECIDI §2, §7 H1; contracts `tokens.ts`).
 * Kural: e-posta `PLATFORM_OPERATORS` listesinde VE doğrulanmış VE kişi askıda değil. Jeton `op: true`, `/me` `platformOperator`.
 * `POST /operator/step-up`: yalnız tarayıcı oturumu ve şu an yönetici olan kişi; yanlış şifre 401 + şifre onayı kovası; jeton 5 dk,
 * tek amaçlı (`aud: ai-admin`), oturum ailesine bağlı (`fid`; yenilemeden sağ çıkar), erişim jetonu yerine geçmez.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, jwtVerify } from 'jose';
import {
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  TOKEN_ALG,
  TOKEN_ISSUER,
  type MeResponse,
  type OperatorStepUpClaims,
  type OperatorStepUpResponse,
  stepUpMatchesSession,
} from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { parsePlatformOperators } from '../src/env.ts';
import { keys } from '../src/lib/keys.ts';
import { verifyAccessToken } from '../src/lib/tokens.ts';
import { API, PASSWORD, bearer, claimsOf, cookieWriteHeaders, errorCode, getApp, login, randomEmail, randomIp, registerOrg, webHeaders, type Ctx } from './helpers.ts';

let app: FastifyInstance;
const saved = process.env.PLATFORM_OPERATORS;

/** Listede, doğrulanmış (asıl yönetici). */
const OP_EMAIL = randomEmail('yonetici');
/** Listede, doğrulanmamış. */
const UNVERIFIED_EMAIL = randomEmail('dogrulanmamis');
/** Listede, kova testi için ayrı kişi (kovası öbür testleri etkilemesin). */
const BUCKET_EMAIL = randomEmail('kova');
/** Listede, askıya alınacak. */
const SUSPENDED_EMAIL = randomEmail('askida');
/** Listede; kişinin kendisinde yalnız onay bekleyen adres olarak duracak. */
const PENDING_EMAIL = randomEmail('bekleyen');

let op: Ctx;
let bucket: Ctx;
let suspended: Ctx;
let outsider: Ctx;
let pendingOnly: Ctx;

async function verifyEmail(personId: string) {
  await prisma.person.update({ where: { id: personId }, data: { emailVerifiedAt: new Date() } });
}

/** Gerçek tarayıcı girişi: oturum satırı `web`, jeton çerezde. */
async function webLogin(identifier: string): Promise<string> {
  const res = await login(app, identifier, PASSWORD, 'web');
  expect(res.statusCode, res.body).toBe(200);
  const token = res.cookies.find((c) => c.name === 'sod_at')?.value;
  if (!token) throw new Error('sod_at çerezi yok');
  return token;
}

async function me(token: string): Promise<MeResponse> {
  const res = await app.inject({ method: 'GET', url: `${API}/me`, headers: { cookie: `sod_at=${token}` } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as MeResponse;
}

async function stepUp(token: string, password: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `${API}/operator/step-up`,
    remoteAddress: randomIp(),
    headers: { ...cookieWriteHeaders(token), ...extra },
    payload: { password },
  });
}

beforeAll(async () => {
  app = await getApp();
  // Büyük harfle yazılmış girdi de tanınır (liste küçük harfe çevrilir).
  process.env.PLATFORM_OPERATORS = [OP_EMAIL.toUpperCase(), UNVERIFIED_EMAIL, BUCKET_EMAIL, SUSPENDED_EMAIL, PENDING_EMAIL].join(', ');
  op = await registerOrg(app, { email: OP_EMAIL });
  await registerOrg(app, { email: UNVERIFIED_EMAIL });
  bucket = await registerOrg(app, { email: BUCKET_EMAIL });
  suspended = await registerOrg(app, { email: SUSPENDED_EMAIL });
  outsider = await registerOrg(app);
  pendingOnly = await registerOrg(app);
  for (const c of [op, bucket, suspended, outsider, pendingOnly]) await verifyEmail(c.personId);
  await prisma.person.update({ where: { id: pendingOnly.personId }, data: { pendingEmail: PENDING_EMAIL } });
});

afterAll(() => {
  if (saved === undefined) delete process.env.PLATFORM_OPERATORS;
  else process.env.PLATFORM_OPERATORS = saved;
});

describe('platform yöneticisi: jeton ve /me', () => {
  it('listede ve doğrulanmış: jetonda op, /me platformOperator true (firmadan bağımsız)', async () => {
    const token = await webLogin(OP_EMAIL);
    expect(claimsOf(token).op).toBe(true);
    expect((await me(token)).platformOperator).toBe(true);
    // Mobil giriş de aynı kişidir: yetki kişiye bağlı.
    const mobile = await login(app, OP_EMAIL);
    expect(claimsOf(mobile.json().accessToken).op).toBe(true);
  });

  it('listede ama e-posta doğrulanmamış: yetki yok', async () => {
    const token = await webLogin(UNVERIFIED_EMAIL);
    expect(claimsOf(token)).not.toHaveProperty('op');
    expect((await me(token)).platformOperator).toBe(false);
  });

  it('listede değil: yetki yok, /me false', async () => {
    const token = await webLogin(outsider.email as string);
    expect(claimsOf(token)).not.toHaveProperty('op');
    expect((await me(token)).platformOperator).toBe(false);
  });

  it('listedeki adres yalnız onay bekleyen yeni adres: yetki yok', async () => {
    const token = await webLogin(pendingOnly.email as string);
    expect(claimsOf(token)).not.toHaveProperty('op');
    expect((await me(token)).platformOperator).toBe(false);
  });

  it('liste boşken hiç kimse yönetici değil, jetonda op alanı hiç yok', async () => {
    const before = process.env.PLATFORM_OPERATORS;
    process.env.PLATFORM_OPERATORS = '';
    try {
      const token = await webLogin(OP_EMAIL);
      expect(claimsOf(token)).not.toHaveProperty('op');
      expect((await me(token)).platformOperator).toBe(false);
    } finally {
      process.env.PLATFORM_OPERATORS = before;
    }
  });

  it('liste biçimi: e-posta olmayan girdi açılışı durdurur, büyük harf küçültülür', () => {
    expect([...parsePlatformOperators(' A@Ornek.Test , b@ornek.test ')]).toEqual(['a@ornek.test', 'b@ornek.test']);
    expect(parsePlatformOperators(undefined).size).toBe(0);
    for (const bad of ['yonetici', 'a@b', 'a b@ornek.test', '@ornek.test']) {
      expect(() => parsePlatformOperators(bad), bad).toThrow(/PLATFORM_OPERATORS/);
    }
  });
});

describe('POST /operator/step-up', () => {
  it('doğru şifre: 5 dakikalık, tek amaçlı, bu oturuma bağlı jeton; denetim izi jetonu taşımaz', async () => {
    const access = await webLogin(OP_EMAIL);
    const res = await stepUp(access, PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as OperatorStepUpResponse;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);

    const { payload, protectedHeader } = await jwtVerify(body.token, keys().verifierKeySet, {
      issuer: TOKEN_ISSUER,
      audience: OPERATOR_STEP_UP_AUDIENCE,
      algorithms: [TOKEN_ALG],
    });
    const claims = payload as unknown as OperatorStepUpClaims;
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(claims.aud).toBe('ai-admin');
    expect(claims.sub).toBe(op.personId);
    expect(claims.sid).toBe(claimsOf(access).sid);
    expect(claims.op).toBe(true);
    expect(claims.exp - claims.iat).toBe(OPERATOR_STEP_UP_TTL_SECONDS);
    expect(OPERATOR_STEP_UP_TTL_SECONDS).toBe(300);
    expect(new Date(body.expiresAt).getTime()).toBe(claims.exp * 1000);
    // Erişim jetonunun alanları yok: yerine geçemez.
    expect(claims).not.toHaveProperty('org');
    expect(claims).not.toHaveProperty('prod');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'operator.step_up', actorPersonId: op.personId }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ orgId: null, target: op.personId });
    expect(audit?.meta).toMatchObject({ jti: claims.jti, expiresAt: body.expiresAt });
    expect(JSON.stringify(audit)).not.toContain(body.token);
  });

  it('adım artırma jetonu erişim jetonu olarak geçmez (Hesap da reddeder)', async () => {
    const access = await webLogin(OP_EMAIL);
    const { token } = (await stepUp(access, PASSWORD)).json() as OperatorStepUpResponse;
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const asBearer = await app.inject({ method: 'GET', url: `${API}/me`, headers: bearer(token) });
    expect(asBearer.statusCode).toBe(401);
    const asCookie = await app.inject({ method: 'GET', url: `${API}/me`, headers: { cookie: `sod_at=${token}` } });
    expect(asCookie.statusCode).toBe(401);
    // Erişim jetonu da adım artırma jetonu yerine geçmez: kitle farklı.
    await expect(jwtVerify(access, keys().verifierKeySet, { audience: OPERATOR_STEP_UP_AUDIENCE })).rejects.toThrow();
    expect(decodeJwt(token).aud).toBe('ai-admin');
  });

  it('yanlış şifre 401 INVALID_CREDENTIALS, jeton yok', async () => {
    const access = await webLogin(OP_EMAIL);
    const res = await stepUp(access, 'YanlisSifre-123');
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
    expect(res.body).not.toMatch(/token/);
  });

  it('şifre onayı kovası: 10 denemeden sonra doğru şifre de 429', async () => {
    const access = await webLogin(BUCKET_EMAIL);
    for (let i = 0; i < 10; i++) {
      const res = await stepUp(access, `YanlisSifre-${i}`);
      expect(res.statusCode, res.body).toBe(401);
    }
    const blocked = await stepUp(access, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('listede olmayan kişi: gövdeye bakılmadan 403, kova dolmaz', async () => {
    const access = await webLogin(outsider.email as string);
    const res = await stepUp(access, PASSWORD);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
    // Bozuk gövde de 403 (400 değil): yönetici olmayan uç hakkında hiçbir şey öğrenmez.
    const bad = await app.inject({ method: 'POST', url: `${API}/operator/step-up`, headers: cookieWriteHeaders(access), payload: {} });
    expect(bad.statusCode).toBe(403);
    expect(await prisma.rateBucket.count({ where: { key: `password:person:${outsider.personId}` } })).toBe(0);
  });

  it('doğrulanmamış e-posta: 403', async () => {
    const access = await webLogin(UNVERIFIED_EMAIL);
    expect((await stepUp(access, PASSWORD)).statusCode).toBe(403);
  });

  it('yetki veritabanından okunur: jetonda op olsa da listeden çıkarılan, askıya alınan ya da adresi değişen kişi 403', async () => {
    const access = await webLogin(SUSPENDED_EMAIL);
    expect(claimsOf(access).op).toBe(true);
    const before = process.env.PLATFORM_OPERATORS;
    process.env.PLATFORM_OPERATORS = OP_EMAIL;
    try {
      expect((await stepUp(access, PASSWORD)).statusCode).toBe(403);
    } finally {
      process.env.PLATFORM_OPERATORS = before;
    }
    expect((await stepUp(access, PASSWORD)).statusCode).toBe(200);
    await prisma.person.update({ where: { id: suspended.personId }, data: { emailVerifiedAt: null } });
    expect((await stepUp(access, PASSWORD)).statusCode).toBe(403);
    await verifyEmail(suspended.personId);
    // Askı: oturumlar da düşer (destek komutu); burada yalnız kural sınanır, oturum satırına dokunulmaz.
    await prisma.person.update({ where: { id: suspended.personId }, data: { suspendedAt: new Date() } });
    expect((await stepUp(access, PASSWORD)).statusCode).toBe(403);
    expect((await me(access)).platformOperator).toBe(false);
  });

  it('yalnız tarayıcı oturumu: mobil (Bearer) oturum 403 WEB_SESSION_REQUIRED', async () => {
    const mobile = await login(app, OP_EMAIL);
    const res = await app.inject({
      method: 'POST',
      url: `${API}/operator/step-up`,
      remoteAddress: randomIp(),
      headers: bearer(mobile.json().accessToken),
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toMatchObject({ reason: 'WEB_SESSION_REQUIRED' });
  });

  it('çerezli istek CSRF ister; oturumsuz 401', async () => {
    const access = await webLogin(OP_EMAIL);
    const noCsrf = await app.inject({ method: 'POST', url: `${API}/operator/step-up`, headers: { cookie: `sod_at=${access}` }, payload: { password: PASSWORD } });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorCode(noCsrf)).toBe('CSRF_FAILED');
    const anon = await app.inject({ method: 'POST', url: `${API}/operator/step-up`, payload: { password: PASSWORD } });
    expect(anon.statusCode).toBe(401);
  });

  it('oturum ailesine bağlı: /auth/refresh sonrası yeni erişim jetonu (yeni sid, aynı fid) adım artırma jetonuyla eşleşir; başka aile eşleşmez', async () => {
    const res = await login(app, OP_EMAIL, PASSWORD, 'web');
    expect(res.statusCode, res.body).toBe(200);
    const access = res.cookies.find((c) => c.name === 'sod_at')!.value;
    const refresh = res.cookies.find((c) => c.name === 'sod_rt')!.value;
    const su = await stepUp(access, PASSWORD);
    expect(su.statusCode, su.body).toBe(200);
    const stepClaims = decodeJwt((su.json() as OperatorStepUpResponse).token) as unknown as OperatorStepUpClaims;
    const row = await prisma.session.findUniqueOrThrow({ where: { id: claimsOf(access).sid }, select: { familyId: true } });
    expect(claimsOf(access).fid).toBe(row.familyId);
    expect(stepClaims.fid).toBe(row.familyId);
    expect(stepClaims.sid).toBe(claimsOf(access).sid);

    const rf = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: webHeaders(`sod_at=${access}; sod_rt=${refresh}`), payload: {} });
    expect(rf.statusCode, rf.body).toBe(200);
    const renewed = rf.cookies.find((c) => c.name === 'sod_at')!.value;
    // Yenileme yeni satır açar (sid değişir), aile aynı kalır: geçidin kuralı (`stepUpMatchesSession`) eşleşme verir.
    expect(claimsOf(renewed).sid).not.toBe(stepClaims.sid);
    expect(claimsOf(renewed).fid).toBe(row.familyId);
    expect(stepUpMatchesSession(stepClaims, claimsOf(renewed))).toBe(true);

    // Aynı kişinin başka girişi başka ailedir: adım artırma jetonu oraya taşınamaz.
    const other = await webLogin(OP_EMAIL);
    expect(claimsOf(other).fid).not.toBe(row.familyId);
    expect(stepUpMatchesSession(stepClaims, claimsOf(other))).toBe(false);

    // Çıkış aileyi toptan düşürür: Hesap eski erişim jetonunu ve yenileme jetonunu reddeder. (Geçit durumsuzdur: eski erişim
    // jetonu ve adım artırma jetonu orada kendi süreleri dolana kadar, en çok OPERATOR_STEP_UP_TTL_SECONDS, imzaca geçerli kalır.)
    const out = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: webHeaders(`sod_at=${renewed}; sod_rt=${rf.cookies.find((c) => c.name === 'sod_rt')!.value}`), payload: {} });
    expect(out.statusCode, out.body).toBe(200);
    expect(await prisma.session.count({ where: { familyId: row.familyId, revokedAt: null } })).toBe(0);
    expect((await stepUp(renewed, PASSWORD)).statusCode).toBe(401);
    const again = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, headers: webHeaders(`sod_rt=${refresh}`), payload: {} });
    expect(again.statusCode).toBe(401);
  });

  it('kapatılmış oturumun jetonu: 401', async () => {
    const access = await webLogin(OP_EMAIL);
    await prisma.session.update({ where: { id: claimsOf(access).sid }, data: { revokedAt: new Date() } });
    expect((await stepUp(access, PASSWORD)).statusCode).toBe(401);
  });
});
