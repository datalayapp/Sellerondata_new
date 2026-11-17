/**
 * Firmayı kapatma, geri açma ve kalıcı silme (kullanıcı kararı 2026-11-13).
 * `POST /org/close` (yalnız OWNER, ad + şifre), `POST /org/reopen` (sahip, saklama süresi içinde), kapalı firmanın erişim kuralları
 * (`/me`, jeton, firma değiştirme, yazma) ve saatlik bakımın kalıcı silme adımı (`purgeClosedOrg`, `purgeDueOrgs`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ORG_PURGE_DAYS_DEFAULT, type MeResponse } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { assertConfig } from '../src/env.ts';
import { DISPATCH_GIVE_UP_AFTER_MS, dispatchOnce } from '../src/lib/dispatcher.ts';
import { runMaintenance } from '../src/lib/maintenance.ts';
import { purgeClosedOrg, purgeDueOrgs } from '../src/lib/orgClosure.ts';
import { LIFECYCLE_EVENT_TYPES } from '../src/lib/outbox.ts';
import { noticeBodySchema, sendProductNotice } from '../src/lib/productNotice.ts';
import { API, PASSWORD, addMember, bearer, claimsOf, errorCode, getApp, randomEmail, randomIp, recreateMembershipOrgFk, registerOrg, type Ctx, asWeb, webHeadersFrom, withCookieToken } from './helpers.ts';

const DAY = 86_400_000;
let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  delete process.env.ORG_PURGE_DAYS;
  delete process.env.PRODUCT_LAUNCH;
});
// Yaşam döngüsü olayları testte hiç teslim edilmez ve hiç bırakılmaz: başka dosyanın kuyruk sayımına karışmasın.
afterAll(async () => {
  await prisma.outbox.deleteMany({ where: { type: { in: [...LIFECYCLE_EVENT_TYPES] } } });
});

/** Saklama süresini doldurur (silme ve geri açma veritabanı saatine bakar; `closedAt` da oradan yazıldı). */
async function expire(orgId: string) {
  await prisma.$executeRaw`UPDATE "platform"."Organization" SET "purgeAfter" = "closedAt" - interval '1 second' WHERE "id" = ${orgId}`;
}
const dbNow = async () => (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`)[0].now;

const orgName = (orgId: string) => prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }).then((o) => o.name);

async function close(who: Ctx, payload: Record<string, unknown>) {
  return withCookieToken(await app.inject({ method: 'POST', url: `${API}/org/close`, headers: await asWeb(who), remoteAddress: randomIp(), payload }));
}
async function reopen(headers: Record<string, string>, payload: Record<string, unknown>) {
  return withCookieToken(await app.inject({ method: 'POST', url: `${API}/org/reopen`, headers: await webHeadersFrom(headers), remoteAddress: randomIp(), payload }));
}
const getMe = async (headers: Record<string, string>) => (await app.inject({ url: `${API}/me`, headers })).json() as MeResponse;
const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });

async function eventsOf(orgId: string, type: string) {
  return (await prisma.outbox.findMany({ where: { orgId, type }, orderBy: { createdAt: 'asc' } })).map((r) => r.payload as Record<string, unknown>);
}

/** Sahip + yönetici + çalışan, firmada bekleyen bir e-posta daveti. */
async function team() {
  const owner = await registerOrg(app);
  const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
  const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/org/members/invite`,
    headers: await asWeb(owner),
    payload: { kind: 'EMAIL', email: randomEmail('davet'), name: 'Davetli', orgRole: 'MEMBER' },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return { owner, admin, member, name: await orgName(owner.orgId) };
}

/** Kapatır; başarıyı denetler, yanıtı döner. */
async function closeOk(owner: Ctx, name: string) {
  const res = await close(owner, { confirmName: name, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { closedAt: string; purgeAfter: string; activeOrgId: string | null; accessToken: string; me: MeResponse };
}

describe('POST /org/close: kim, hangi onayla', () => {
  it('yalnız OWNER: yönetici ve çalışan 403, firma açık kalır', async () => {
    const { owner, admin, member, name } = await team();
    for (const who of [admin, member]) {
      const res = await close(who, { confirmName: name, password: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).closedAt).toBeNull();
  });

  it('yanlış ad 400 CONFIRM_NAME_MISMATCH; şifre kovasını harcamaz', async () => {
    const { owner, name } = await team();
    for (const confirmName of [`${name}x`, '', name.slice(0, -1)]) {
      const res = await close(owner, { confirmName, password: PASSWORD });
      expect(res.statusCode, confirmName).toBe(400);
      expect(errorCode(res)).toBe('CONFIRM_NAME_MISMATCH');
    }
    expect(await prisma.rateBucket.count({ where: { key: `password:person:${owner.personId}` } })).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).closedAt).toBeNull();
  });

  it('yanlış şifre 401; şifre onayı kovası dolunca doğru şifre de 429', async () => {
    const { owner, name } = await team();
    const wrong = await close(owner, { confirmName: name, password: 'Yanlis-Sifre-123' });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    for (let i = 1; i < 10; i += 1) expect((await close(owner, { confirmName: name, password: 'Yanlis-Sifre-123' })).statusCode).toBe(401);
    const blocked = await close(owner, { confirmName: name, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).closedAt).toBeNull();
  });

  it('ad büyük/küçük harf ve baş/son boşluk farkıyla da kabul edilir', async () => {
    const owner = await registerOrg(app, { orgName: 'İstanbul Kargo Ticaret' });
    const res = await closeOk(owner, '  istanbul kargo TİCARET ');
    expect(res.closedAt).toBeTruthy();
  });
});

describe('kapatma: ne değişir', () => {
  it('alanlar, sürüm, epoch, davet, denetim ve olay tek işlemde; saklama 30 gün', async () => {
    const { owner, admin, member, name } = await team();
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    const epochs = await prisma.membership.findMany({ where: { orgId: owner.orgId }, select: { id: true, epoch: true } });

    const t0 = await dbNow();
    const body = await closeOk(owner, name);
    const t1 = await dbNow();
    const closedAt = new Date(body.closedAt);
    // Kapanış anı veritabanı saatinden (milisaniyeye kırpılmış).
    expect(closedAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1);
    expect(closedAt.getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(new Date(body.purgeAfter).getTime() - closedAt.getTime()).toBe(ORG_PURGE_DAYS_DEFAULT * DAY);
    // Sahibin başka firması yok: firmasız kalır, jeton firma ve ürün vermez.
    expect(body.activeOrgId).toBeNull();
    expect(claimsOf(body.accessToken).org).toBeNull();
    expect(claimsOf(body.accessToken).prod).toEqual({});

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(org.closedAt?.toISOString()).toBe(body.closedAt);
    expect(org.purgeAfter?.toISOString()).toBe(body.purgeAfter);
    expect(org.closedById).toBe(owner.personId);
    expect(org.version).toBe(before.version + 1);
    for (const e of epochs) {
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: e.id } })).epoch).toBe(e.epoch + 1);
    }
    // Bekleyen katılma daveti düşer.
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId, revokedAt: null } })).toBe(0);
    // Kişilerin son firma tercihi boşalır.
    for (const who of [owner, admin, member]) {
      expect((await prisma.person.findUniqueOrThrow({ where: { id: who.personId } })).lastOrgId).toBeNull();
    }

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: owner.orgId, action: 'org.closed' } });
    expect(audit.actorPersonId).toBe(owner.personId);
    expect(audit.meta).toMatchObject({ closedAt: body.closedAt, purgeAfter: body.purgeAfter, members: 3 });
    const events = await eventsOf(owner.orgId, 'org.closed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'org.closed', orgId: owner.orgId, product: 'deciship', closedAt: body.closedAt, purgeAfter: body.purgeAfter, version: org.version });
  });

  it('ORG_PURGE_DAYS yanlış yazılırsa açılış durur', () => {
    for (const bad of ['0', '3651', 'otuz', '1.5']) {
      process.env.ORG_PURGE_DAYS = bad;
      expect(() => assertConfig(), bad).toThrow(/ORG_PURGE_DAYS/);
    }
    process.env.ORG_PURGE_DAYS = '45';
    assertConfig();
  });

  it('ORG_PURGE_DAYS saklama süresini değiştirir', async () => {
    process.env.ORG_PURGE_DAYS = '5';
    const owner = await registerOrg(app);
    const body = await closeOk(owner, await orgName(owner.orgId));
    expect(new Date(body.purgeAfter).getTime() - new Date(body.closedAt).getTime()).toBe(5 * DAY);
  });

  it('sahibin başka açık firması varsa ona geçer; kapalı firma /me listesinde tarihleri ve kendi saat dilimiyle yalnız sahipte', async () => {
    const { owner, member, name } = await team();
    // Kapalı firmanın tarihleri etkin firmanın değil, kendi saat diliminde yazılır (Merkez).
    await prisma.organization.update({ where: { id: owner.orgId }, data: { timeZone: 'Europe/London' } });
    const second = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: owner.headers, payload: { name: 'Öbür Firma', country: 'TR' } });
    expect(second.statusCode, second.body).toBe(201);
    const secondOrgId = second.json().activeOrgId as string;
    // Kapatılacak firmaya geri dön.
    const back = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: bearer(second.json().accessToken), payload: { orgId: owner.orgId } });
    expect(back.statusCode, back.body).toBe(200);
    const ownerCtx = { ...owner, headers: bearer(back.json().accessToken) };

    const body = await closeOk(ownerCtx, name);
    expect(body.activeOrgId).toBe(secondOrgId);
    const ownerMe = await getMe(bearer(body.accessToken));
    expect(ownerMe.activeOrg?.id).toBe(secondOrgId);
    const entry = ownerMe.orgs.find((o) => o.id === owner.orgId);
    expect(entry).toMatchObject({ orgStatus: 'CLOSED', closedAt: body.closedAt, purgeAfter: body.purgeAfter, orgRole: 'OWNER', timeZone: 'Europe/London' });
    // Açık firmanın biçimi değişmez (alan yok).
    expect(ownerMe.orgs.find((o) => o.id === secondOrgId)).not.toHaveProperty('orgStatus');
    expect(ownerMe.orgs.find((o) => o.id === secondOrgId)).not.toHaveProperty('timeZone');

    // Çalışan: eski jeton düşer, yenileme firmasız jeton verir, /me'de firma hiç yok.
    const stale = await app.inject({ url: `${API}/org`, headers: member.headers });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const r = await refresh(member.refreshToken);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().activeOrgId).toBeNull();
    expect(claimsOf(r.json().accessToken).org).toBeNull();
    const memberMe = await getMe(bearer(r.json().accessToken));
    expect(memberMe.orgs).toEqual([]);
    expect(memberMe.activeOrg).toBeNull();
    expect(memberMe.account?.suspendedOrgCount).toBe(0);
  });
});

describe('kapalı firma: erişim kuralları', () => {
  it('etkin yapılamaz: firma değiştirme 409 ORG_CLOSED, giriş başka firmayı ya da firmasızı seçer', async () => {
    const { owner, member, name } = await team();
    const body = await closeOk(owner, name);
    const sw = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: bearer(body.accessToken), payload: { orgId: owner.orgId } });
    expect(sw.statusCode).toBe(409);
    expect(errorCode(sw)).toBe('ORG_CLOSED');
    // Üye için firma yok sayılır (görmez).
    const r = await refresh(member.refreshToken);
    const swMember = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: bearer(r.json().accessToken), payload: { orgId: owner.orgId } });
    expect(swMember.statusCode).toBe(409);
    // Yeniden giriş: kapalı firma seçilmez, ürün erişimi yok.
    const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: randomIp(), payload: { identifier: owner.email, password: PASSWORD, client: 'mobile' } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().activeOrgId).toBeNull();
    expect(claimsOf(login.json().accessToken).prod).toEqual({});
    expect(login.json().me.activeOrg).toBeNull();
    // Firmasız jetonla firma ucu: yenileme döngüsü (TOKEN_STALE) değil, 403 ORG_REQUIRED.
    const noOrg = await app.inject({ url: `${API}/org`, headers: bearer(login.json().accessToken) });
    expect(noOrg.statusCode).toBe(403);
    expect(errorCode(noOrg)).toBe('ORG_REQUIRED');
  });

  it('kapanışla yarışan güncel jeton: okuma da yazma da 409 ORG_CLOSED (çift güvence)', async () => {
    const { owner, admin } = await team();
    // Yarış benzetimi: firma kapalı ama epoch artmamış (jeton hâlâ güncel).
    await prisma.organization.update({ where: { id: owner.orgId }, data: { closedAt: new Date(), purgeAfter: new Date(Date.now() + 30 * DAY) } });
    const read = await app.inject({ url: `${API}/org`, headers: owner.headers });
    expect(read.statusCode).toBe(409);
    expect(errorCode(read)).toBe('ORG_CLOSED');
    const write = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(admin), payload: { name: 'Yeni Ad' } });
    expect(write.statusCode).toBe(409);
    expect(errorCode(write)).toBe('ORG_CLOSED');
    // Zaten kapalı firmayı yeniden kapatma da 409.
    const again = await close(owner, { confirmName: await orgName(owner.orgId), password: PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('ORG_CLOSED');
    // Yenileme: kapalı firma jetona girmez.
    const r = await refresh(owner.refreshToken);
    expect(claimsOf(r.json().accessToken).org).toBeNull();
  });

  it('araç bildirim postası kapalı firmaya gitmez', async () => {
    const owner = await registerOrg(app);
    await closeOk(owner, await orgName(owner.orgId));
    const text = { subject: 'Konu', lines: ['Bir satır'] };
    const res = await sendProductNotice(
      noticeBodySchema.parse({
        product: 'deciship',
        orgId: owner.orgId,
        dedupeKey: 'ttk:2026-11-13',
        audience: { permission: 'deciship.web.access' },
        message: { tr: text, en: text },
      }),
    );
    expect(res.status).toBe('disabled');
  });
});

describe('POST /org/reopen', () => {
  it('sahip saklama süresinde geri açar: alanlar boşalır, sürüm ve epoch artar, firma etkin olur, ekip geri döner', async () => {
    const { owner, member, name } = await team();
    const closed = await closeOk(owner, name);
    const v = (await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version;
    const memberEpoch = (await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).epoch;

    const res = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().activeOrgId).toBe(owner.orgId);
    expect(claimsOf(res.json().accessToken).org).toBe(owner.orgId);
    expect(claimsOf(res.json().accessToken).prod).toHaveProperty('deciship');
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(org).toMatchObject({ closedAt: null, purgeAfter: null, closedById: null, version: v + 1 });
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).epoch).toBe(memberEpoch + 1);
    expect(await prisma.auditLog.count({ where: { orgId: owner.orgId, action: 'org.reopened' } })).toBe(1);
    const events = await eventsOf(owner.orgId, 'org.reopened');
    expect(events).toEqual([expect.objectContaining({ type: 'org.reopened', product: 'deciship', version: v + 1 })]);
    // Çalışan yeniden girince firma ve rolü aynen döner.
    const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: randomIp(), payload: { identifier: member.email, password: PASSWORD, client: 'mobile' } });
    expect(login.json().activeOrgId).toBe(owner.orgId);
    expect(claimsOf(login.json().accessToken).prod.deciship?.role).toBe('MEASURE');
  });

  it('sahip olmayan 404, yanlış şifre 401, açık firma 409, bilinmeyen firma 404', async () => {
    const { owner, admin, name } = await team();
    const closed = await closeOk(owner, name);
    const adminFresh = await refresh(admin.refreshToken);
    const byAdmin = await reopen(bearer(adminFresh.json().accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(byAdmin.statusCode).toBe(404);
    expect(errorCode(byAdmin)).toBe('ORG_NOT_FOUND');
    const stranger = await registerOrg(app);
    expect((await reopen(stranger.headers, { orgId: owner.orgId, password: PASSWORD })).statusCode).toBe(404);
    const wrong = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: 'Yanlis-Sifre-123' });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).closedAt).not.toBeNull();
    const open = await reopen(stranger.headers, { orgId: stranger.orgId, password: PASSWORD });
    expect(open.statusCode).toBe(409);
    expect(errorCode(open)).toBe('CONFLICT');
    expect((await reopen(stranger.headers, { orgId: '00000000-0000-7000-8000-000000000000', password: PASSWORD })).statusCode).toBe(404);
  });

  it('saklama süresi dolduysa (henüz silinmemiş olsa da) 410 ORG_PURGED', async () => {
    const owner = await registerOrg(app);
    const closed = await closeOk(owner, await orgName(owner.orgId));
    await prisma.organization.update({ where: { id: owner.orgId }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    const res = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(res.statusCode).toBe(410);
    expect(errorCode(res)).toBe('ORG_PURGED');
  });
});

describe('kalıcı silme (saatlik bakım)', () => {
  it('süresi gelmeyen ve açık firma silinmez', async () => {
    const owner = await registerOrg(app);
    expect(await purgeClosedOrg(owner.orgId)).toEqual({ purged: false, reason: 'not_closed' });
    await closeOk(owner, await orgName(owner.orgId));
    expect(await purgeClosedOrg(owner.orgId)).toEqual({ purged: false, reason: 'not_due' });
    expect(await prisma.organization.count({ where: { id: owner.orgId } })).toBe(1);
  });

  it('firmayı, üyelikleri ve davetleri siler, kişileri silmez; org.purged bir kez, tekrar zararsız', async () => {
    const { owner, admin, member, name } = await team();
    const closed = await closeOk(owner, name);
    await expire(owner.orgId);
    const memberships = await prisma.membership.findMany({ where: { orgId: owner.orgId }, select: { id: true } });
    expect(memberships).toHaveLength(3);
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId } })).toBe(1);

    const r = await purgeClosedOrg(owner.orgId);
    expect(r).toMatchObject({ purged: true, orgId: owner.orgId, products: ['deciship'], memberships: 3, invitations: 1 });
    expect(await prisma.organization.count({ where: { id: owner.orgId } })).toBe(0);
    expect(await prisma.membership.count({ where: { id: { in: memberships.map((m) => m.id) } } })).toBe(0);
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { orgId: owner.orgId } })).toBe(0);
    expect(await prisma.person.count({ where: { id: { in: [owner.personId, admin.personId, member.personId] } } })).toBe(3);

    const events = await eventsOf(owner.orgId, 'org.purged');
    expect(events).toEqual([expect.objectContaining({ type: 'org.purged', orgId: owner.orgId, product: 'deciship' })]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'org.purged', target: owner.orgId } });
    expect(audit.orgId).toBeNull();
    expect(audit.meta).toMatchObject({ orgId: owner.orgId, ownerPersonId: owner.personId, memberships: 3, invitations: 1 });
    // Önceki denetim kayıtları kalır.
    expect(await prisma.auditLog.count({ where: { orgId: owner.orgId, action: 'org.closed' } })).toBe(1);

    // Tekrar: bulunamaz, ikinci olay yazılmaz.
    expect(await purgeClosedOrg(owner.orgId)).toEqual({ purged: false, reason: 'not_found' });
    expect(await eventsOf(owner.orgId, 'org.purged')).toHaveLength(1);

    // Silinmiş firmayı geri açma: sahibe 410, başkasına 404.
    const ownerReopen = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(ownerReopen.statusCode).toBe(410);
    expect(errorCode(ownerReopen)).toBe('ORG_PURGED');
    const adminLogin = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: randomIp(), payload: { identifier: admin.email, password: PASSWORD, client: 'mobile' } });
    expect(adminLogin.statusCode, adminLogin.body).toBe(200);
    expect(adminLogin.json().activeOrgId).toBeNull();
    const adminReopen = await reopen(bearer(adminLogin.json().accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(adminReopen.statusCode).toBe(404);
  });

  it('purgeDueOrgs yalnız süresi dolanları siler; iki kopya aynı anda çalışsa da olay bir kez', async () => {
    const due = await registerOrg(app);
    const notDue = await registerOrg(app);
    const c1 = await closeOk(due, await orgName(due.orgId));
    await closeOk(notDue, await orgName(notDue.orgId));
    // `due` firmasının süresi dolmuş olsun; `notDue` 30 gün daha bekler.
    await prisma.organization.update({ where: { id: due.orgId }, data: { purgeAfter: new Date(new Date(c1.closedAt).getTime() - 1000) } });
    const [a, b] = await Promise.all([purgeDueOrgs(), purgeDueOrgs()]);
    expect([...a.purged, ...b.purged].filter((id) => id === due.orgId)).toHaveLength(1);
    expect([...a.failed, ...b.failed]).not.toContain(due.orgId);
    expect(await prisma.organization.count({ where: { id: due.orgId } })).toBe(0);
    expect(await prisma.organization.count({ where: { id: notDue.orgId } })).toBe(1);
    expect(await eventsOf(due.orgId, 'org.purged')).toHaveLength(1);
  });
});

describe('kalıcı silme: özel rol', () => {
  it('özel roldeki üyesi olan firma silinir (araç erişimi firmadan önce açıkça silinir)', async () => {
    await recreateMembershipOrgFk();
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const created = await app.inject({
      method: 'POST',
      url: `${API}/org/roles`,
      headers: await asWeb(owner),
      payload: { product: 'deciship', name: 'Sayım ekibi', permissions: ['deciship.measurements.capture'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const roleKey = created.json().role.key as string;
    const assign = await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { productRoles: { deciship: roleKey } } });
    expect(assign.statusCode, assign.body).toBe(200);
    const roleId = roleKey.slice('custom:'.length);
    expect(await prisma.productAccess.count({ where: { membershipId: member.membershipId, customRoleId: roleId } })).toBe(1);

    await closeOk(owner, await orgName(owner.orgId));
    await expire(owner.orgId);
    expect(await purgeClosedOrg(owner.orgId)).toMatchObject({ purged: true, memberships: 2 });
    expect(await prisma.organization.count({ where: { id: owner.orgId } })).toBe(0);
    expect(await prisma.productRole.count({ where: { orgId: owner.orgId } })).toBe(0);
    expect(await prisma.productAccess.count({ where: { membershipId: member.membershipId } })).toBe(0);
  });
});

describe('yaşam döngüsü olayları: hangi ürünlere, hiç bırakılmaz', () => {
  beforeEach(async () => {
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
  });

  /** Firmaya kapalı (`off`) bir ürünün aboneliğini ve aboneliği olmayan bir ürüne geçmiş olayı ekler. */
  async function withOffAndPastProducts(orgId: string) {
    await prisma.subscription.create({ data: { orgId, product: 'orderloom', plan: 'pilot' } });
    await prisma.outbox.create({
      data: {
        type: 'org.updated',
        orgId,
        payload: { type: 'org.updated', orgId, product: 'tagpress' },
        deliveries: { create: { target: 'tagpress', status: 'DELIVERED' } },
      },
    });
  }
  const productsOf = async (orgId: string, type: string) => (await eventsOf(orgId, type)).map((e) => e.product as string).sort();

  it('kapatma, geri açma ve silme: abonelikli ya da önceden olay almış her ürüne, ürün kapalı (off) olsa da', async () => {
    const owner = await registerOrg(app);
    await withOffAndPastProducts(owner.orgId);
    const closed = await closeOk(owner, await orgName(owner.orgId));
    expect(await productsOf(owner.orgId, 'org.closed')).toEqual(['deciship', 'orderloom', 'tagpress']);

    const res = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(await productsOf(owner.orgId, 'org.reopened')).toEqual(['deciship', 'orderloom', 'tagpress']);

    const again = await close({ ...owner, headers: bearer(res.json().accessToken) }, { confirmName: await orgName(owner.orgId), password: PASSWORD });
    expect(again.statusCode, again.body).toBe(200);
    await expire(owner.orgId);
    // Silme anında ana ürün de kapalıya alınmış olsun.
    process.env.PRODUCT_LAUNCH = 'deciship=off';
    const r = await purgeClosedOrg(owner.orgId);
    expect(r).toMatchObject({ purged: true, products: ['deciship', 'orderloom', 'tagpress'] });
    expect(await productsOf(owner.orgId, 'org.purged')).toEqual(['deciship', 'orderloom', 'tagpress']);
    // Teslim satırları açık: hedefi tanımsız ürünün teslimi adres yazılana kadar bekler.
    const deliveries = await prisma.outboxDelivery.findMany({ where: { outbox: { orgId: owner.orgId, type: 'org.purged' } } });
    expect(deliveries.map((d) => `${d.target}:${d.status}`).sort()).toEqual(['deciship:PENDING', 'orderloom:PENDING', 'tagpress:PENDING']);
  });

  it('dağıtıcı yaşam döngüsü olayını pencere dolsa da bırakmaz; üyelik olayı DEAD olur', async () => {
    const owner = await registerOrg(app);
    await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const closed = await closeOk(owner, await orgName(owner.orgId));
    const reopened = await reopen(bearer(closed.accessToken), { orgId: owner.orgId, password: PASSWORD });
    expect(reopened.statusCode, reopened.body).toBe(200);
    await closeOk({ ...owner, headers: bearer(reopened.json().accessToken) }, await orgName(owner.orgId));
    await expire(owner.orgId);
    expect((await purgeClosedOrg(owner.orgId)).purged).toBe(true);
    await prisma.outboxDelivery.updateMany({ data: { createdAt: new Date(Date.now() - DISPATCH_GIVE_UP_AFTER_MS - 1000), attempts: 60 } });

    const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const result = await dispatchOnce({ fetch: failing });
    expect(result.dead).toBeGreaterThan(0);
    const rows = await prisma.outboxDelivery.findMany({ include: { outbox: { select: { type: true } } } });
    const lifecycle = rows.filter((d) => LIFECYCLE_EVENT_TYPES.includes(d.outbox.type));
    expect(lifecycle.map((d) => d.outbox.type).sort()).toEqual(['org.closed', 'org.closed', 'org.purged', 'org.reopened']);
    for (const d of lifecycle) {
      expect(d.status, d.outbox.type).toBe('PENDING');
      expect(d.lastError, d.outbox.type).toBe('HTTP 503');
      // Kapaklı geri çekilme: en çok bir saat (+%20 sarsıntı) sonra yeniden denenir.
      expect(d.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(1.2 * 3600_000 + 5_000);
    }
    const members = rows.filter((d) => d.outbox.type.startsWith('member.'));
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((d) => d.status === 'DEAD')).toBe(true);
  });

  it('bakım DEAD yaşam döngüsü olayını yeniden kuyruğa alır, teslim edilmemişi 30 günden sonra da silmez', async () => {
    const owner = await registerOrg(app);
    await closeOk(owner, await orgName(owner.orgId));
    await expire(owner.orgId);
    expect((await purgeClosedOrg(owner.orgId)).purged).toBe(true);
    // Eski sürümden kalmış ya da elle DEAD yapılmış; 40 günlük.
    await prisma.outboxDelivery.updateMany({ data: { status: 'DEAD' } });
    await prisma.outbox.updateMany({ data: { createdAt: new Date(Date.now() - 40 * DAY) } });

    await runMaintenance(new Date(), { warn: () => {}, error: () => {} });
    const left = await prisma.outbox.findMany({ include: { deliveries: true } });
    // Kayıt olayları (DEAD, yaşam döngüsü değil) silindi; kapatma ve silme olayları kaldı ve yeniden bekliyor.
    expect(left.map((o) => o.type).sort()).toEqual(['org.closed', 'org.purged']);
    for (const o of left) expect(o.deliveries.map((d) => d.status)).toEqual(['PENDING']);

    // Teslim edilince olağan saklama kuralı işler.
    await prisma.outboxDelivery.updateMany({ data: { status: 'DELIVERED' } });
    await runMaintenance();
    expect(await prisma.outbox.count()).toBe(0);
  });
});
