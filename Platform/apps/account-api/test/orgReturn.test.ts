import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ORG_HEADER, type AuthResponse, type MeResponse } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import {
  addMember,
  API,
  bearer,
  claimsOf,
  cookieHeader,
  errorCode,
  getApp,
  login,
  parseSetCookies,
  PASSWORD,
  randomIp,
  randomTrPhone,
  registerOrg,
  webHeaders,
  type Ctx, asWeb } from './helpers.ts';

/**
 * Jetonun firması gerçeğin gerisinde kaldığında kişi "Firma oluşturun" ekranına düşmez:
 * etkin üyeliği varken `/me` ve firma uçları `TOKEN_STALE` der, istemci yeniler, firmasına döner (ARCHITECTURE §5).
 */
let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

async function setStatus(owner: Ctx, membershipId: string, status: 'ACTIVE' | 'SUSPENDED') {
  return app.inject({ method: 'PATCH', url: `${API}/org/members/${membershipId}`, headers: await asWeb(owner), payload: { status } });
}

function getMe(token: string) {
  return app.inject({ url: `${API}/me`, headers: bearer(token) });
}

function refreshMobile(refreshToken: string) {
  return app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });
}

function refreshWeb(cookie: string) {
  return app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), headers: webHeaders(cookie), payload: {} });
}

function members(token: string) {
  return app.inject({ url: `${API}/org/members`, headers: bearer(token) });
}

/** Mobil girişin jetonları. */
async function mobileLogin(identifier: string) {
  const res = await login(app, identifier);
  expect(res.statusCode).toBe(200);
  const body = res.json<AuthResponse>();
  return { accessToken: body.accessToken as string, refreshToken: body.refreshToken as string };
}

async function webLogin(identifier: string) {
  const res = await login(app, identifier, PASSWORD, 'web');
  expect(res.statusCode).toBe(200);
  return cookieHeader(parseSetCookies(res));
}

describe('askıdayken açılan oturum, askı kalkınca', () => {
  it('Bearer: /me önce bayat der, yenilemeden sonra firmasına döner, yeniden giriş gerekmez', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');

    const session = await mobileLogin(member.email as string);
    expect(claimsOf(session.accessToken).org).toBeNull();
    const suspended = await getMe(session.accessToken);
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json<MeResponse>().activeOrg).toBeNull();
    expect(suspended.json<MeResponse>().account?.suspendedOrgCount).toBe(1);

    await setStatus(owner, member.membershipId, 'ACTIVE');
    const stale = await getMe(session.accessToken);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');

    const refreshed = await refreshMobile(session.refreshToken);
    expect(refreshed.statusCode).toBe(200);
    const token = refreshed.json<AuthResponse>().accessToken as string;
    expect(claimsOf(token).org).toBe(owner.orgId);
    expect(claimsOf(token).mid).toBe(member.membershipId);
    const me = await getMe(token);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.id).toBe(owner.orgId);
    expect(me.json<MeResponse>().account?.suspendedOrgCount).toBe(0);
    expect((await members(token)).statusCode).not.toBe(401);
  });

  it('çerez: aynı akış, yenilenen çerezle /me firmayı getirir ve X-SOD-Org ile yazma çalışır', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const cookie = await webLogin(member.email as string);
    expect((await app.inject({ url: `${API}/me`, headers: { cookie } })).json<MeResponse>().activeOrg).toBeNull();

    await setStatus(owner, member.membershipId, 'ACTIVE');
    const stale = await app.inject({ url: `${API}/me`, headers: { cookie } });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');

    const refreshed = await refreshWeb(cookie);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<AuthResponse>().activeOrgId).toBe(owner.orgId);
    const fresh = cookieHeader(parseSetCookies(refreshed));
    const me = await app.inject({ url: `${API}/me`, headers: { cookie: fresh } });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.id).toBe(owner.orgId);
  });

  it('tolerans içinde ikinci sekme (web): baş satır firmasızsa jeton firmalı döner, döngü olmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const cookie = await webLogin(member.email as string);
    const first = await refreshWeb(cookie);
    expect(first.statusCode).toBe(200);
    expect(first.json<AuthResponse>().activeOrgId).toBeNull();

    await setStatus(owner, member.membershipId, 'ACTIVE');
    const second = await refreshWeb(cookie);
    expect(second.statusCode).toBe(200);
    expect(second.json<AuthResponse>().activeOrgId).toBe(owner.orgId);
    const cookies = parseSetCookies(second);
    expect(cookies.sod_rt).toBeUndefined();
    const access = claimsOf(cookies.sod_at!.value);
    expect(access.org).toBe(owner.orgId);
    const me = await app.inject({ url: `${API}/me`, headers: { cookie: `sod_at=${cookies.sod_at!.value}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.id).toBe(owner.orgId);

    // Baş satır da güncellendi: sonraki gerçek yenileme aynı firmada kalır.
    const firstCookies = parseSetCookies(first);
    const third = await refreshWeb(`sod_rt=${firstCookies.sod_rt!.value}`);
    expect(third.json<AuthResponse>().activeOrgId).toBe(owner.orgId);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: member.personId } })).lastOrgId).toBe(owner.orgId);
  });

  it('tolerans içinde ikinci sekme (web): baş satırın firması askıdaysa etkin firmaya geçer', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await addMember(app, other.orgId, { personId: member.personId });
    await prisma.person.update({ where: { id: member.personId }, data: { lastOrgId: owner.orgId } });
    const cookie = await webLogin(member.email as string);
    expect(claimsOf(parseSetCookies(await refreshWeb(cookie)).sod_at!.value).org).toBe(owner.orgId);

    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const second = await refreshWeb(cookie);
    expect(second.statusCode).toBe(200);
    expect(second.json<AuthResponse>().activeOrgId).toBe(other.orgId);
  });

  it('tolerans içinde mobil tekrar da firmalı jeton üretir', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const session = await mobileLogin(member.email as string);
    expect((await refreshMobile(session.refreshToken)).statusCode).toBe(200);
    await setStatus(owner, member.membershipId, 'ACTIVE');
    const again = await refreshMobile(session.refreshToken);
    expect(again.statusCode).toBe(200);
    expect(claimsOf(again.json<AuthResponse>().accessToken as string).org).toBe(owner.orgId);
  });

  it('firma ucu da bayat der: ORG_REQUIRED kişiyi yanlış yola sokmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const session = await mobileLogin(member.email as string);
    expect(errorCode(await members(session.accessToken))).toBe('ORG_REQUIRED');

    await setStatus(owner, member.membershipId, 'ACTIVE');
    const stale = await members(session.accessToken);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
  });

  it('çerezli firma yazması başlıksız da önce bayat der; yenilemeden sonra başlık kuralı aynen geçerli', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const cookie = await webLogin(member.email as string);
    await setStatus(owner, member.membershipId, 'ACTIVE');

    const url = `${API}/org/members/invite`;
    const payload = { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Yeni Kişi', orgRole: 'MEMBER' };
    const stale = await app.inject({ method: 'POST', url, headers: webHeaders(cookie), payload });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');

    const fresh = cookieHeader(parseSetCookies(await refreshWeb(cookie)));
    const noHeader = await app.inject({ method: 'POST', url, headers: webHeaders(fresh), payload });
    expect(noHeader.statusCode).toBe(409);
    expect(errorCode(noHeader)).toBe('ORG_MISMATCH');
    const wrong = await app.inject({ method: 'POST', url, headers: { ...webHeaders(fresh), [ORG_HEADER]: 'baska-firma' }, payload });
    expect(errorCode(wrong)).toBe('ORG_MISMATCH');
    const ok = await app.inject({ method: 'POST', url, headers: { ...webHeaders(fresh), [ORG_HEADER]: owner.orgId }, payload });
    expect(ok.statusCode).toBe(201);
  });
});

describe('etkin üyelik gerçekten yoksa ekran doğru kalır', () => {
  it('hâlâ askıda: /me 200, firma yok, askı sayısı dolu, yenileme de firma vermez', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const session = await mobileLogin(member.email as string);
    const me = await getMe(session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg).toBeNull();
    expect(me.json<MeResponse>().account?.suspendedOrgCount).toBe(1);
    const refreshed = await refreshMobile(session.refreshToken);
    expect(claimsOf(refreshed.json<AuthResponse>().accessToken as string).org).toBeNull();
  });

  it('firmalı jetonla askıya alınan tek firmalı kişi: /me 200 ve firma yok (askı ekranı, yenileme döngüsü değil)', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const me = await getMe(member.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg).toBeNull();
    expect(me.json<MeResponse>().account?.suspendedOrgCount).toBe(1);
  });

  it('üyeliği olmayan kişi: /me 200, firma oluştur açık, firma uçları ORG_REQUIRED', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const removed = await app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    expect(removed.statusCode).toBeLessThan(300);

    const session = await mobileLogin(member.email as string);
    expect(claimsOf(session.accessToken).org).toBeNull();
    const me = await getMe(session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg).toBeNull();
    expect(me.json<MeResponse>().orgs).toEqual([]);
    expect(me.json<MeResponse>().account?.canCreateOrg).toBe(true);
    const denied = await members(session.accessToken);
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('ORG_REQUIRED');
  });

  it('güncel jetonlu üye: /me hiç bayat demez', async () => {
    const owner = await registerOrg(app);
    const me = await getMe(owner.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.id).toBe(owner.orgId);
  });
});

describe('aynı durumun diğer biçimleri', () => {
  it('çıkarılıp yeniden eklenen, çıkarılmışken giriş yapan kişi firmasına döner', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    const session = await mobileLogin(member.email as string);
    expect(claimsOf(session.accessToken).org).toBeNull();

    const back = await addMember(app, owner.orgId, { personId: member.personId });
    expect(back.membershipId).not.toBe(member.membershipId);
    const stale = await getMe(session.accessToken);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const token = (await refreshMobile(session.refreshToken)).json<AuthResponse>().accessToken as string;
    expect(claimsOf(token).mid).toBe(back.membershipId);
    expect((await getMe(token)).json<MeResponse>().activeOrg?.membershipId).toBe(back.membershipId);
  });

  it('çıkarılıp yeniden eklenen, eski firmalı jetonu duran kişi: eski üyelik kimliği kabul edilmez', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    const back = await addMember(app, owner.orgId, { personId: member.personId });
    // Yeni satırın epoch'u baştan başlar: eski jeton yalnız üyelik kimliğinden anlaşılır.
    expect(claimsOf(member.accessToken).ep).toBeGreaterThanOrEqual((await prisma.membership.findUniqueOrThrow({ where: { id: back.membershipId } })).epoch);

    const firmEndpoint = await members(member.accessToken);
    expect(firmEndpoint.statusCode).toBe(401);
    expect(errorCode(firmEndpoint)).toBe('TOKEN_STALE');
    const me = await getMe(member.accessToken);
    expect(me.statusCode).toBe(401);
    expect(errorCode(me)).toBe('TOKEN_STALE');

    const token = (await refreshMobile(member.refreshToken)).json<AuthResponse>().accessToken as string;
    expect(claimsOf(token).mid).toBe(back.membershipId);
    expect((await app.inject({ url: `${API}/org`, headers: bearer(token) })).statusCode).toBe(200);
  });

  it('davetle ilk üyeliği başka cihazda etkinleşen kişi: bu cihaz da firmasına geçer', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const first = await addMember(app, owner.orgId, { email: null, phone });
    await app.inject({ method: 'DELETE', url: `${API}/org/members/${first.membershipId}`, headers: await asWeb(owner) });
    const device = await mobileLogin(phone);
    expect(claimsOf(device.accessToken).org).toBeNull();
    expect((await getMe(device.accessToken)).statusCode).toBe(200);

    const inviter = await registerOrg(app);
    const invite = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(inviter),
      payload: { kind: 'PHONE_CODE', phone, name: 'Davetli Kişi', orgRole: 'MEMBER' },
    });
    expect(invite.statusCode).toBe(201);
    // Kabul başka cihazda: yalnız o oturumun firması değişir, bu cihazın jetonu firmasız kalır.
    const accepted = await app.inject({
      method: 'POST',
      url: `${API}/auth/join/accept`,
      remoteAddress: randomIp(),
      payload: { phone, code: invite.json().code, password: PASSWORD, client: 'mobile' },
    });
    expect(accepted.statusCode).toBeLessThan(300);

    const stale = await getMe(device.accessToken);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const token = (await refreshMobile(device.refreshToken)).json<AuthResponse>().accessToken as string;
    expect(claimsOf(token).org).toBe(inviter.orgId);
    expect((await getMe(token)).json<MeResponse>().activeOrg?.id).toBe(inviter.orgId);
  });

  it('bir firmada askıya alınan, başka firmada etkin kişi: firma oluştur yerine öbür firmasına geçer', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await addMember(app, other.orgId, { personId: member.personId });
    await prisma.person.update({ where: { id: member.personId }, data: { lastOrgId: owner.orgId } });
    const session = await mobileLogin(member.email as string);
    expect(claimsOf(session.accessToken).org).toBe(owner.orgId);

    await setStatus(owner, member.membershipId, 'SUSPENDED');
    const stale = await getMe(session.accessToken);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const token = (await refreshMobile(session.refreshToken)).json<AuthResponse>().accessToken as string;
    expect(claimsOf(token).org).toBe(other.orgId);
    const me = await getMe(token);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.id).toBe(other.orgId);
  });

  it('eski firmalı jetonla, firma hâlâ etkinken /me değişmez: rol değişimi /me isteğini bayat yapmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const patched = await app.inject({
      method: 'PATCH',
      url: `${API}/org/members/${member.membershipId}`,
      headers: await asWeb(owner),
      payload: { orgRole: 'ADMIN' },
    });
    expect(patched.statusCode).toBe(200);
    const me = await getMe(member.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().activeOrg?.orgRole).toBe('ADMIN');
  });
});
