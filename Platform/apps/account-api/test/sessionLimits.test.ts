import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REFRESH_TTL_SECONDS } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { sha256 } from '../src/lib/crypto.ts';
import {
  API,
  cookieHeader,
  epochOf,
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
import { TEST_SITE_ORIGIN } from './testEnv.ts';

/**
 * 02-B5: çıkış ürünlerdeki erişim jetonunu da düşürür (epoch). 02-B10: oturum ailesinin üst yaşı (`SESSION_MAX_AGE_DAYS`, 90 gün).
 * Sözleşme: `POST /auth/refresh` ve `POST /auth/logout`.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.SESSION_MAX_AGE_DAYS;
});

const DAY = 24 * 3600_000;
const post = (url: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers, payload });
const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });

async function rowOf(refreshToken: string) {
  return prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(refreshToken) } });
}

/** Ailenin bütün satırlarını geçmişe iter: aile `days` gün önce açılmış olur. */
async function ageFamily(ctx: Ctx, days: number) {
  const row = await rowOf(ctx.refreshToken);
  await prisma.session.updateMany({ where: { familyId: row.familyId }, data: { familyCreatedAt: new Date(Date.now() - days * DAY) } });
  return row.familyId;
}

async function webSession() {
  const owner = await registerOrg(app);
  const res = await login(app, owner.email as string, PASSWORD, 'web');
  expect(res.statusCode).toBe(200);
  const cookies = parseSetCookies(res);
  return { owner, rt: cookies.sod_rt.value, cookie: cookieHeader({ sod_at: cookies.sod_at, sod_rt: cookies.sod_rt }) };
}

describe('çıkış epoch artırır (02-B5)', () => {
  it('Bearer ve yenileme jetonuyla çıkış: aile düşer, kişinin bütün üyeliklerinin epoch\'u artar', async () => {
    const owner = await registerOrg(app);
    const second = await registerOrg(app);
    const extra = await prisma.membership.create({ data: { personId: owner.personId, orgId: second.orgId } });
    const before = [await epochOf(owner.membershipId), await epochOf(extra.id)];
    const res = await post('/auth/logout', { refreshToken: owner.refreshToken }, owner.headers);
    expect(res.statusCode).toBe(200);
    expect([await epochOf(owner.membershipId), await epochOf(extra.id)]).toEqual(before.map((e) => e + 1));
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
  });

  it('yalnız sod_rt ile gelen site çıkışı kişiyi yenileme satırından bulur', async () => {
    const w = await webSession();
    const before = await epochOf(w.owner.membershipId);
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      remoteAddress: randomIp(),
      headers: { cookie: `sod_rt=${w.rt}`, 'x-sod-csrf': '1', origin: TEST_SITE_ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await epochOf(w.owner.membershipId)).toBe(before + 1);
    expect((await rowOf(w.rt)).revokedAt).not.toBeNull();
  });

  it('bilinmeyen jeton ve kimliksiz çıkış kimsenin epoch\'una dokunmaz', async () => {
    const owner = await registerOrg(app);
    const before = await epochOf(owner.membershipId);
    expect((await post('/auth/logout', { refreshToken: 'uydurma' })).statusCode).toBe(200);
    expect((await post('/auth/logout')).statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(before);
  });

  it('süresi geçmiş erişim jetonuyla gelen çıkış o jetonun sahibini etkilemez', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const before = await epochOf(owner.membershipId);
    const otherBefore = await epochOf(other.membershipId);
    // Oturum satırı sona ermiş: erişim jetonu Hesap'ta geçersiz (TOKEN_EXPIRED yolu ile aynı sonuç: principal yok).
    const row = await rowOf(owner.refreshToken);
    await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post('/auth/logout', { refreshToken: other.refreshToken }, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(before);
    expect(await epochOf(other.membershipId)).toBe(otherBefore + 1);
    expect((await rowOf(other.refreshToken)).revokedAt).not.toBeNull();
  });

  it('iptal edilmiş ailenin eski jetonuyla tekrarlanan çıkış epoch artırmaz', async () => {
    const owner = await registerOrg(app);
    const before = await epochOf(owner.membershipId);
    expect((await post('/auth/logout', { refreshToken: owner.refreshToken })).statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(before + 1);
    for (let i = 0; i < 4; i++) expect((await post('/auth/logout', { refreshToken: owner.refreshToken })).statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(before + 1);
  });

  it('kapatılmış oturumu yeniden kapatmak epoch artırmaz', async () => {
    const owner = await registerOrg(app);
    const other = await login(app, owner.email as string);
    const otherRow = await rowOf(other.json().refreshToken);
    const del = () => app.inject({ method: 'DELETE', url: `${API}/me/sessions/${otherRow.id}`, remoteAddress: randomIp(), headers: owner.headers });
    const before = await epochOf(owner.membershipId);
    expect((await del()).statusCode).toBe(200);
    // Epoch arttı: bu oturumun erişim jetonu bayat, yenilenir.
    const fresh = await refresh(owner.refreshToken);
    const headers = { authorization: `Bearer ${fresh.json().accessToken}` };
    expect(await epochOf(owner.membershipId)).toBe(before + 1);
    expect((await app.inject({ method: 'DELETE', url: `${API}/me/sessions/${otherRow.id}`, remoteAddress: randomIp(), headers })).statusCode).toBe(200);
    expect(await epochOf(owner.membershipId)).toBe(before + 1);
  });

  it('çerez ve Bearer farklı kişilerdense ikisi de çıkar', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const before = [await epochOf(a.membershipId), await epochOf(b.membershipId)];
    expect((await post('/auth/logout', { refreshToken: b.refreshToken }, a.headers)).statusCode).toBe(200);
    expect([await epochOf(a.membershipId), await epochOf(b.membershipId)]).toEqual(before.map((e) => e + 1));
  });
});

describe('oturum üst sınırı (02-B10)', () => {
  it('üst yaşa ulaşan aile yenilenemez: aile iptal, session.expired bir kez, 401 ve çerezler silinir', async () => {
    const w = await webSession();
    const familyId = await ageFamily({ ...w.owner, refreshToken: w.rt }, 90);
    const res = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(w.cookie), payload: {} });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('UNAUTHORIZED');
    const cleared = parseSetCookies(res);
    expect(cleared.sod_rt?.value).toBe('');
    expect(cleared.sod_at?.value).toBe('');
    expect(await prisma.session.count({ where: { familyId, revokedAt: null } })).toBe(0);
    expect((await refresh(w.rt)).statusCode).toBe(401);
    const audits = await prisma.auditLog.findMany({ where: { action: 'session.expired', target: familyId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].orgId).toBeNull();
  });

  it('ailenin ilk satırında createdAt ve familyCreatedAt birebir aynı (saat kaynağı tek)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(app, (await registerOrg(app)).email as string);
      const row = await rowOf(res.json().refreshToken);
      expect(row.createdAt.getTime()).toBe(row.familyCreatedAt.getTime());
    }
  });

  it('döndürme aile başlangıcını taşır; bitiş min(şimdi + 30 gün, başlangıç + üst sınır)', async () => {
    const owner = await registerOrg(app);
    const first = await rowOf(owner.refreshToken);
    expect(first.familyCreatedAt.getTime()).toBe(first.createdAt.getTime());
    expect(Math.abs(first.expiresAt.getTime() - (first.familyCreatedAt.getTime() + REFRESH_TTL_SECONDS * 1000))).toBeLessThan(1000);

    await ageFamily(owner, 80);
    const familyCreatedAt = (await rowOf(owner.refreshToken)).familyCreatedAt;
    const res = await refresh(owner.refreshToken);
    expect(res.statusCode, res.body).toBe(200);
    const next = await rowOf(res.json().refreshToken);
    expect(next.familyCreatedAt.getTime()).toBe(familyCreatedAt.getTime());
    expect(next.expiresAt.getTime()).toBe(familyCreatedAt.getTime() + 90 * DAY);

    // Taze aile: 30 günlük bitiş.
    await prisma.session.update({ where: { id: next.id }, data: { familyCreatedAt: new Date() } });
    const again = await refresh(res.json().refreshToken);
    const fresh = await rowOf(again.json().refreshToken);
    expect(Math.abs(fresh.expiresAt.getTime() - (Date.now() + REFRESH_TTL_SECONDS * 1000))).toBeLessThan(5000);
  });

  it('tolerans içindeki mobil tekrar da aile başlangıcını taşır ve üst sınırı aşamaz', async () => {
    const owner = await registerOrg(app);
    await ageFamily(owner, 85);
    const familyCreatedAt = (await rowOf(owner.refreshToken)).familyCreatedAt;
    const first = await refresh(owner.refreshToken);
    expect(first.statusCode).toBe(200);
    const replay = await refresh(owner.refreshToken);
    expect(replay.statusCode).toBe(200);
    const row = await rowOf(replay.json().refreshToken);
    expect(row.familyCreatedAt.getTime()).toBe(familyCreatedAt.getTime());
    expect(row.expiresAt.getTime()).toBe(familyCreatedAt.getTime() + 90 * DAY);
  });

  it('tolerans içinde eski jetonla gelen istek de üst yaşta reddedilir', async () => {
    const owner = await registerOrg(app);
    const first = await refresh(owner.refreshToken);
    expect(first.statusCode).toBe(200);
    await ageFamily({ ...owner, refreshToken: first.json().refreshToken }, 91);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { familyId: (await rowOf(owner.refreshToken)).familyId, revokedAt: null } })).toBe(0);
  });

  it('SESSION_MAX_AGE_DAYS ayarı: 1 gün', async () => {
    process.env.SESSION_MAX_AGE_DAYS = '1';
    const res = await login(app, (await registerOrg(app)).email as string);
    expect(res.statusCode).toBe(200);
    const row = await rowOf(res.json().refreshToken);
    expect(row.expiresAt.getTime()).toBe(row.familyCreatedAt.getTime() + DAY);
  });

  it('üst yaşı geçmiş aile başsızdır: site yoklaması giriş yapılmamış der, profil yazması 401', async () => {
    const w = await webSession();
    const probe = () =>
      app.inject({ method: 'GET', url: `${API}/auth/site-session`, remoteAddress: randomIp(), headers: { cookie: `sod_rt=${w.rt}` } });
    expect((await probe()).json().signedIn).toBe(true);
    // Göçten önceki satır gibi: bitiş üst sınırla kırpılmamış, aile yaşlı.
    await ageFamily({ ...w.owner, refreshToken: w.rt }, 95);
    expect((await probe()).json()).toEqual({ signedIn: false });
    const patch = await app.inject({ method: 'PATCH', url: `${API}/me`, remoteAddress: randomIp(), headers: w.owner.headers, payload: { name: 'Yeni' } });
    // Bearer oturumu (kayıt) ayrı aile: etkilenmez.
    expect(patch.statusCode).toBe(200);
    const cookiePatch = await app.inject({
      method: 'PATCH',
      url: `${API}/me`,
      remoteAddress: randomIp(),
      headers: webHeaders(w.cookie),
      payload: { name: 'Yeni' },
    });
    expect(cookiePatch.statusCode).toBe(401);
  });
});
