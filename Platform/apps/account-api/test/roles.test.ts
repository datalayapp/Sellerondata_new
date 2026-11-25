import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { customRoleIdOf, type OrgProductRole, type OrgRolesResponse } from '@sellerondata/contracts';
import pg from 'pg';
import { prisma } from '../src/db.ts';
import { addMember, API, bearer, claimsOf, epochOf, errorCode, getApp, outboxFor, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, asWeb, type Ctx } from './helpers.ts';
import { SUPER_URL, TEST_DB_NAME } from './testEnv.ts';

/**
 * Özel roller ve hazır rol düzenleme: uçlar, güvenlik kuralları (risk tablosu),
 * bağımlılık, sürüm, epoch + olay, jeton `perms` ve `/me` `roleLabel`.
 */

let app: FastifyInstance;

const D = 'deciship';
const P = {
  web: 'deciship.web.access',
  settings: 'deciship.settings.manage',
  tariffsView: 'deciship.tariffs.view',
  upload: 'deciship.invoices.upload',
  invoicesView: 'deciship.invoices.view',
  disputes: 'deciship.disputes.manage',
  reports: 'deciship.reports.view',
  capture: 'deciship.measurements.capture',
  viewAll: 'deciship.measurements.view_all',
  prices: 'deciship.prices.view',
} as const;

/** Okuma mobil oturumla (Bearer), firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"). */
async function call(ctx: Ctx | null, method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url: `${API}${path}`,
    remoteAddress: randomIp(),
    headers: !ctx ? {} : method === 'GET' || !path.startsWith('/org') ? ctx.headers : await asWeb(ctx),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Epoch artınca eski jeton TOKEN_STALE alır: aynı kişi yenileyip devam eder. */
async function refresh(ctx: Ctx): Promise<Ctx> {
  const res = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: ctx.refreshToken } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  return { ...ctx, accessToken: body.accessToken, refreshToken: body.refreshToken ?? ctx.refreshToken, headers: bearer(body.accessToken) };
}

async function rolesOf(ctx: Ctx) {
  const res = await call(ctx, 'GET', '/org/roles');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as OrgRolesResponse).products.find((p) => p.key === D)!;
}

async function createRole(ctx: Ctx, body: Record<string, unknown>) {
  return call(ctx, 'POST', '/org/roles', { product: D, ...body });
}

async function createdRole(ctx: Ctx, body: Record<string, unknown>): Promise<OrgProductRole> {
  const res = await createRole(ctx, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().role;
}

const idOf = (key: string) => customRoleIdOf(key) as string;

function forbiddenReason(res: { json: () => unknown }) {
  return (res.json() as { error?: { details?: { reason?: string; permissions?: string[] } } }).error?.details;
}

/** Firma: sahip, firma yöneticisi (DeciShip Denetleyici), çalışan (Ölçüm). */
async function world() {
  const owner = await registerOrg(app);
  const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'AUDITOR' });
  const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
  return { owner, admin, member };
}

beforeAll(async () => {
  app = await getApp();
});

describe('roller: liste ve oluşturma', () => {
  it('GET /org/roles: kümeler, izinler (geçişli gereksinim, sahibe özel), hazır roller, sınır', async () => {
    const { owner } = await world();
    const d = await rolesOf(owner);
    expect(d.groups.map((g) => g.key)).toEqual(['web', 'invoices', 'reports', 'tariffs', 'measurements', 'prices', 'settings']);
    const upload = d.permissions.find((p) => p.key === P.upload)!;
    expect(upload.group).toBe('invoices');
    expect(upload.requires).toEqual(expect.arrayContaining([P.web, P.invoicesView, P.prices]));
    expect(d.permissions.find((p) => p.key === P.settings)!.ownerOnly).toBe(true);
    expect(d.roles.map((r) => r.key)).toEqual(['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE']);
    const admin = d.roles.find((r) => r.key === 'ADMIN')!;
    expect(admin).toMatchObject({ kind: 'builtin', permissionsLocked: true, deletable: false, editable: true, edited: false, version: 0, memberCount: 1 });
    expect(d.roles.find((r) => r.key === 'MEASURE')).toMatchObject({ memberCount: 1, deletable: true, permissionsLocked: false });
    expect(d.hiddenBuiltins).toEqual([]);
    expect(d.customRoleLimit).toBe(20);
  });

  it('OWNER özel rol açar: 201, katalog sırası, denetim izi; çalışan (MEMBER) liste ve yazma alamaz', async () => {
    const { owner, member } = await world();
    const role = await createdRole(owner, { name: '  Depo şefi ', description: 'Depo', permissions: [P.viewAll, P.capture], basedOn: 'MEASURE' });
    expect(role).toMatchObject({ kind: 'custom', name: 'Depo şefi', description: 'Depo', permissions: [P.capture, P.viewAll], basedOn: 'MEASURE', version: 1, edited: false, memberCount: 0 });
    expect(role.key).toMatch(/^custom:[0-9a-f-]{36}$/);
    const d = await rolesOf(owner);
    expect(d.roles.at(-1)!.key).toBe(role.key);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'role.created' } });
    expect(audit?.meta).toMatchObject({ product: D, role: role.key, kind: 'custom', name: 'Depo şefi', permissions: [P.capture, P.viewAll], basedOn: 'MEASURE' });
    expect(errorCode(await call(member, 'GET', '/org/roles'))).toBe('FORBIDDEN');
    expect(errorCode(await createRole(member, { name: 'X', permissions: [] }))).toBe('FORBIDDEN');
  });

  it('bağımlılık: eksik gereksinim ve bilinmeyen izin 400 INVALID_ROLE_PERMISSIONS, kendiliğinden eklenmez', async () => {
    const { owner } = await world();
    const res = await createRole(owner, { name: 'Yükleyici', permissions: [P.upload, 'deciship.yok', 'orderloom.x'] });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('INVALID_ROLE_PERMISSIONS');
    const details = res.json().error.details;
    expect(details.unknown).toEqual(['deciship.yok', 'orderloom.x']);
    expect(details.missing).toEqual([{ perm: P.upload, requires: expect.arrayContaining([P.web, P.invoicesView, P.prices]) }]);
    // v1 para sızıntısı kuralı: fatura görme fiyat ister.
    const view = await createRole(owner, { name: 'Fatura', permissions: [P.invoicesView] });
    expect(view.json().error.details.missing).toEqual([{ perm: P.invoicesView, requires: [P.prices] }]);
    expect(await prisma.productRole.count({ where: { orgId: owner.orgId } })).toBe(0);
  });

  it('ad tekil: büyük/küçük harf duyarsız, katalog adları (iki dil) dahil; sınır 20', async () => {
    const { owner } = await world();
    await createdRole(owner, { name: 'Depo', permissions: [] });
    expect(errorCode(await createRole(owner, { name: 'DEPO', permissions: [] }))).toBe('ROLE_NAME_TAKEN');
    expect(errorCode(await createRole(owner, { name: 'ölçüm', permissions: [] }))).toBe('ROLE_NAME_TAKEN');
    expect(errorCode(await createRole(owner, { name: 'Measurement', permissions: [] }))).toBe('ROLE_NAME_TAKEN');
    for (let i = 1; i < 20; i++) await createdRole(owner, { name: `Rol ${i}`, permissions: [] });
    expect(errorCode(await createRole(owner, { name: 'Rol 21', permissions: [] }))).toBe('ROLE_LIMIT');
  });

  it('ADMIN yetki yükseltemez: kendinde olmayan izin 403 escalation; kendi izinleriyle açabilir', async () => {
    const { admin } = await world();
    const res = await createRole(admin, { name: 'İtirazcı', permissions: [P.disputes, P.invoicesView, P.prices] });
    expect(errorCode(res)).toBe('ROLE_FORBIDDEN');
    expect(forbiddenReason(res)).toEqual({ reason: 'escalation', permissions: [P.disputes] });
    expect(res.json().error.message).toMatch(/Kendinizde olmayan|you do not have/i);
    expect((await createRole(admin, { name: 'Faturacı', permissions: [P.invoicesView, P.prices] })).statusCode).toBe(201);
  });
});

describe('roller: sahibe özel izin (beş yol)', () => {
  it('oluşturma: ayar izni yalnız OWNER (ADMIN kendinde olsa da)', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
    const perms = [P.settings, P.web, P.prices];
    const res = await createRole(admin, { name: 'Ayarcı', permissions: perms });
    expect(forbiddenReason(res)).toEqual({ reason: 'owner_only', permissions: [P.settings] });
    expect((await createRole(owner, { name: 'Ayarcı', permissions: perms })).statusCode).toBe(201);
  });

  it('düzenleme: ADMIN role ayar izni ekleyemez; ayar izinli rolü adını bile değiştiremez', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
    const plain = await createdRole(owner, { name: 'Düz', permissions: [P.web, P.prices] });
    const add = await call(admin, 'PATCH', `/org/roles/${idOf(plain.key)}`, { permissions: [P.web, P.prices, P.settings], version: 1 });
    expect(forbiddenReason(add)?.reason).toBe('owner_only');
    const settings = await createdRole(owner, { name: 'Ayar', permissions: [P.settings, P.web, P.prices] });
    expect((await rolesOf(admin)).roles.find((r) => r.key === settings.key)).toMatchObject({ editable: false, deletable: false });
    expect(forbiddenReason(await call(admin, 'PATCH', `/org/roles/${idOf(settings.key)}`, { name: 'Yeni', version: 1 }))?.reason).toBe('owner_only');
    expect(forbiddenReason(await call(admin, 'DELETE', `/org/roles/${idOf(settings.key)}`))?.reason).toBe('owner_only');
    // Hazır sahip rolü (DeciShip Yönetici) ayar izni taşır ve sahipte (ve bu yöneticinin kendisinde): ADMIN adını değiştiremez.
    const builtin = await call(admin, 'PATCH', '/org/roles/builtin/deciship/ADMIN', { name: 'Patron', version: 0 });
    expect(errorCode(builtin)).toBe('ROLE_FORBIDDEN');
    expect((await rolesOf(admin)).roles.find((r) => r.key === 'ADMIN')).toMatchObject({ editable: false, deletable: false });
  });

  it('atama: ADMIN ayar izinli rolü (özel ya da hazır Yönetici) çalışana veremez; OWNER verir; değişmeyen rol engel değil', async () => {
    const { owner, admin, member } = await world();
    const settings = await createdRole(owner, { name: 'Ayar', permissions: [P.settings, P.web, P.prices] });
    for (const role of [settings.key, 'ADMIN']) {
      const res = await call(admin, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: role } });
      expect(forbiddenReason(res), role).toEqual({ reason: 'owner_only', permissions: [P.settings] });
    }
    const ok = await call(owner, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: settings.key } });
    expect(ok.json().changed).toEqual(['productRoles']);
    // Yönetici, sahibin verdiği rolü taşıyan çalışanı askıya alabilir (rol değişmiyor).
    const again = await call(admin, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: settings.key }, status: 'SUSPENDED' });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('davet: ADMIN ayar izinli rolle davet açamaz; OWNER açar', async () => {
    const { owner, admin } = await world();
    const settings = await createdRole(owner, { name: 'Ayar', permissions: [P.settings, P.web, P.prices] });
    for (const role of [settings.key, 'ADMIN']) {
      const res = await call(admin, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('ayar'), productRoles: { deciship: role } });
      expect(forbiddenReason(res), role).toEqual({ reason: 'owner_only', permissions: [P.settings] });
    }
    const ok = await call(owner, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('ayar'), productRoles: { deciship: settings.key } });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('davet kabulü: ADMIN daveti bekleyen role ayar izni eklenmez (KALANLAR 6.11); izin yine de role girerse davet geçersiz (önizleme ve kabul)', async () => {
    const { owner, admin } = await world();
    const role = await createdRole(owner, { name: 'Büyüyen', permissions: [P.web, P.prices] });
    const email = randomEmail('kabul');
    const invite = await call(admin, 'POST', '/org/members/invite', { kind: 'EMAIL', email, name: 'Yeni', productRoles: { deciship: role.key } });
    expect(invite.statusCode, invite.body).toBe(201);
    const token = String(invite.json().link).split('/invite/')[1];
    expect((await call(null, 'GET', `/invites/${token}`)).statusCode).toBe(200);
    // Birinci kat: sahip de ekleyemez, davet kabul edilebilir kalır (`roles.ts` `assertInvitesKeepInviter`).
    const edit = await call(owner, 'PATCH', `/org/roles/${idOf(role.key)}`, { permissions: [P.web, P.prices, P.settings], version: 1 });
    expect(forbiddenReason(edit), edit.body).toMatchObject({ reason: 'pending_admin_invites', permissions: [P.settings], invitations: [{ id: invite.json().invitation.id }] });
    expect((await call(null, 'GET', `/invites/${token}`)).statusCode).toBe(200);
    // İkinci kat: izin role başka yoldan girse (doğrudan veritabanı) kabulde açanın bugünkü yetkisi yine denetlenir.
    await prisma.productRole.update({ where: { id: idOf(role.key) }, data: { permissions: [P.web, P.prices, P.settings] } });
    expect(errorCode(await call(null, 'GET', `/invites/${token}`))).toBe('INVITE_INVALID');
    const accept = await call(null, 'POST', `/invites/${token}/accept`, { name: 'Yeni Kişi', password: 'MaviKedi-9137-uzun', client: 'mobile' });
    expect(errorCode(accept)).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { email } })).toBe(0);
  });
});

describe('roller: yönetilemeyen sahip', () => {
  it('ADMIN kendi rolünü, OWNER’ın ya da başka ADMIN’in rolünü düzenleyemez ve silemez; OWNER kendi rolünü düzenler', async () => {
    const { owner, admin } = await world();
    const mine = await createdRole(owner, { name: 'Yöneticinin', permissions: [P.capture] });
    await call(owner, 'PATCH', `/org/members/${admin.membershipId}`, { productRoles: { deciship: mine.key } });
    const adminFresh = await refresh(admin);
    const own = await call(adminFresh, 'PATCH', `/org/roles/${idOf(mine.key)}`, { name: 'Benim', version: 1 });
    expect(forbiddenReason(own)?.reason).toBe('unmanageable_holder');
    expect(forbiddenReason(await call(adminFresh, 'DELETE', `/org/roles/${idOf(mine.key)}?reassignTo=MEASURE`))?.reason).toBe('unmanageable_holder');

    const owners = await createdRole(owner, { name: 'Sahibin', permissions: [P.capture] });
    const self = await call(owner, 'PATCH', `/org/members/${owner.membershipId}`, { productRoles: { deciship: owners.key } });
    expect(self.statusCode, self.body).toBe(200);
    const ownerFresh = await refresh(owner);
    expect(forbiddenReason(await call(adminFresh, 'PATCH', `/org/roles/${idOf(owners.key)}`, { name: 'X', version: 1 }))?.reason).toBe('unmanageable_holder');
    // OWNER kendi taşıdığı rolü düzenleyebilir (kendi araç rolünü değiştirebildiği gibi).
    expect((await call(ownerFresh, 'PATCH', `/org/roles/${idOf(owners.key)}`, { name: 'Sahip rolü', version: 1 })).statusCode).toBe(200);

    // Başka bir ADMIN'in taşıdığı rol.
    const admin2 = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const theirs = await createdRole(ownerFresh, { name: 'Diğer yönetici', permissions: [P.capture] });
    expect((await call(ownerFresh, 'PATCH', `/org/members/${admin2.membershipId}`, { productRoles: { deciship: theirs.key } })).statusCode).toBe(200);
    expect(forbiddenReason(await call(adminFresh, 'PATCH', `/org/roles/${idOf(theirs.key)}`, { permissions: [], version: 1 }))?.reason).toBe('unmanageable_holder');

    // Çalışan rolü (Ölçüm) yalnız çalışanda: ADMIN yönetir. ADMIN'in davet ettiği bir yönetici daveti rolü yönetilemez yapar.
    expect((await rolesOf(adminFresh)).roles.find((r) => r.key === 'MEASURE')!.editable).toBe(true);
    await call(ownerFresh, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('yon'), orgRole: 'ADMIN', productRoles: { deciship: 'MEASURE' } });
    const measure = (await rolesOf(adminFresh)).roles.find((r) => r.key === 'MEASURE')!;
    expect(measure).toMatchObject({ editable: false, inviteCount: 1, memberCount: 1 });
    expect(forbiddenReason(await call(adminFresh, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'Sayım', version: 0 }))?.reason).toBe('unmanageable_holder');
  });
});

describe('roller: düzenleme, sürüm, epoch ve olay', () => {
  it('izin değişimi her sahibin epoch’unu artırır ve izinli member.upserted yazar; yalnız ad değişimi artırmaz; eski sürüm 409', async () => {
    const owner = await registerOrg(app);
    const role = await createdRole(owner, { name: 'Sayım', permissions: [P.capture] });
    const a = await addMember(app, owner.orgId);
    const b = await addMember(app, owner.orgId);
    for (const m of [a, b]) expect((await call(owner, 'PATCH', `/org/members/${m.membershipId}`, { productRoles: { deciship: role.key } })).statusCode).toBe(200);
    const before = { a: await epochOf(a.membershipId), b: await epochOf(b.membershipId) };
    const eventsBefore = (await outboxFor(a.membershipId)).length;

    const res = await call(owner, 'PATCH', `/org/roles/${idOf(role.key)}`, { permissions: [P.capture, P.viewAll], version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().role).toMatchObject({ version: 2, permissions: [P.capture, P.viewAll], memberCount: 2 });
    expect(await epochOf(a.membershipId)).toBe(before.a + 1);
    expect(await epochOf(b.membershipId)).toBe(before.b + 1);
    for (const m of [a, b]) {
      const last = (await outboxFor(m.membershipId)).at(-1)!.payload as { type: string; role: string; permissions: string[]; epoch: number };
      expect(last).toMatchObject({ type: 'member.upserted', role: role.key, permissions: [P.capture, P.viewAll], epoch: await epochOf(m.membershipId) });
    }
    expect((await outboxFor(a.membershipId)).length).toBe(eventsBefore + 1);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'role.updated' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.meta).toMatchObject({ role: role.key, name: 'Sayım', added: [P.viewAll] });

    expect(errorCode(await call(owner, 'PATCH', `/org/roles/${idOf(role.key)}`, { name: 'Eski', version: 1 }))).toBe('ROLE_VERSION');
    const renamed = await call(owner, 'PATCH', `/org/roles/${idOf(role.key)}`, { name: 'Sayım ekibi', description: 'Depo', version: 2 });
    expect(renamed.json().role).toMatchObject({ name: 'Sayım ekibi', description: 'Depo', version: 3 });
    expect(await epochOf(a.membershipId)).toBe(before.a + 1);
    const cleared = await call(owner, 'PATCH', `/org/roles/${idOf(role.key)}`, { description: null, version: 3 });
    expect(cleared.json().role.description).toBeUndefined();
    const renameAudit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'role.updated' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 1 });
    expect(renameAudit?.meta).toMatchObject({ name: 'Sayım ekibi', previousName: 'Sayım', descriptionChanged: true });
  });

  it('jeton perms ve /me: özel rol (roleLabel, roleKind) ve düzenlenmiş hazır rol', async () => {
    const owner = await registerOrg(app);
    const role = await createdRole(owner, { name: 'Depo şefi', permissions: [P.capture, P.viewAll] });
    const m = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await call(owner, 'PATCH', `/org/members/${m.membershipId}`, { productRoles: { deciship: role.key } });
    const fresh = await refresh(m);
    const claim = claimsOf(fresh.accessToken).prod.deciship!;
    expect(claim).toMatchObject({ role: role.key, perms: [P.capture, P.viewAll], status: 'ACTIVE' });
    const me = (await call(fresh, 'GET', '/me')).json().products.find((p: { key: string }) => p.key === D);
    expect(me).toMatchObject({ role: role.key, roleLabel: 'Depo şefi', roleKind: 'custom', permissions: [P.capture, P.viewAll] });
    const access = await prisma.productAccess.findUniqueOrThrow({ where: { membershipId_product: { membershipId: m.membershipId, product: D } } });
    expect(access.customRoleId).toBe(idOf(role.key));

    // Hazır rol düzenlenir: anahtar aynı kalır, ad ve izin firmanınki olur.
    const m2 = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const edit = await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'Sayımcı', permissions: [P.capture, P.viewAll], version: 0 });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().role).toMatchObject({ key: 'MEASURE', kind: 'builtin', name: 'Sayımcı', edited: true, version: 1 });
    const fresh2 = await refresh(m2);
    expect(claimsOf(fresh2.accessToken).prod.deciship).toMatchObject({ role: 'MEASURE', perms: [P.capture, P.viewAll] });
    const me2 = (await call(fresh2, 'GET', '/me')).json().products.find((p: { key: string }) => p.key === D);
    expect(me2).toMatchObject({ role: 'MEASURE', roleLabel: 'Sayımcı', roleKind: 'builtin', permissions: [P.capture, P.viewAll] });
    // Düzenlenmemiş hazır rol: katalog adı kişinin dilinde.
    const me3 = (await call(owner, 'GET', '/me')).json().products.find((p: { key: string }) => p.key === D);
    expect(me3).toMatchObject({ role: 'ADMIN', roleLabel: 'Yönetici', roleKind: 'builtin' });
    expect(claimsOf(owner.accessToken).prod.deciship?.perms).toContain(P.settings);
  });

  it('sahip rolü kilitli: izin değişmez (ROLE_LOCKED), adı değişir, silinemez', async () => {
    const owner = await registerOrg(app);
    const lock = await call(owner, 'PATCH', '/org/roles/builtin/deciship/ADMIN', { permissions: [P.web], version: 0 });
    expect(errorCode(lock)).toBe('ROLE_LOCKED');
    const rename = await call(owner, 'PATCH', '/org/roles/builtin/deciship/ADMIN', { name: 'Patron', version: 0 });
    expect(rename.json().role).toMatchObject({ name: 'Patron', permissionsLocked: true, edited: true });
    expect(errorCode(await call(owner, 'DELETE', '/org/roles/builtin/deciship/ADMIN?reassignTo=AUDITOR'))).toBe('ROLE_LOCKED');
    const fresh = await refresh(owner);
    expect(claimsOf(fresh.accessToken).prod.deciship?.perms).toContain(P.settings);
    // Varsayılana dönüş adı katalog adına çevirir.
    const reset = await call(fresh, 'POST', '/org/roles/builtin/deciship/ADMIN/reset');
    // Yanıt isteğin dilinde (Accept-Language yok: İngilizce).
    // Sürüm geri gitmez: ad değişimi 1, dönüş 2.
    expect(reset.json().role).toMatchObject({ name: 'Admin', edited: false, version: 2 });
  });
});

describe('roller: silme ve taşıma', () => {
  it('kullanımdaki rol reassignTo olmadan 409 ROLE_IN_USE; taşımayla üyelik ve davetler yeni role geçer', async () => {
    const owner = await registerOrg(app);
    const role = await createdRole(owner, { name: 'Geçici', permissions: [P.capture] });
    const m = await addMember(app, owner.orgId);
    await call(owner, 'PATCH', `/org/members/${m.membershipId}`, { productRoles: { deciship: role.key } });
    const invite = await call(owner, 'POST', '/org/members/invite', { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Telefonlu', productRoles: { deciship: role.key } });
    expect(invite.statusCode, invite.body).toBe(201);

    const inUse = await call(owner, 'DELETE', `/org/roles/${idOf(role.key)}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toMatchObject({ code: 'ROLE_IN_USE', details: { members: 1, invites: 1 } });
    // Veritabanı da engeller: kullanılan özel rol satırı doğrudan silinemez.
    await expect(prisma.productRole.delete({ where: { id: idOf(role.key) } })).rejects.toThrow();
    expect(errorCode(await call(owner, 'DELETE', `/org/roles/${idOf(role.key)}?reassignTo=${role.key}`))).toBe('INVALID_PRODUCT_ROLE');

    const epoch = await epochOf(m.membershipId);
    const del = await call(owner, 'DELETE', `/org/roles/${idOf(role.key)}?reassignTo=AUDITOR`);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ ok: true, reassigned: { members: 1, invites: 1 } });
    expect(await prisma.productRole.count({ where: { id: idOf(role.key) } })).toBe(0);
    const access = await prisma.productAccess.findUniqueOrThrow({ where: { membershipId_product: { membershipId: m.membershipId, product: D } } });
    expect(access).toMatchObject({ role: 'AUDITOR', customRoleId: null });
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: invite.json().invitation.id } });
    expect(inv.productRoles).toEqual({ deciship: 'AUDITOR' });
    expect(await epochOf(m.membershipId)).toBe(epoch + 1);
    const last = (await outboxFor(m.membershipId)).at(-1)!.payload as { role: string; permissions: string[] };
    expect(last.role).toBe('AUDITOR');
    expect(last.permissions).toContain(P.upload);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'role.deleted' } });
    expect(audit?.meta).toMatchObject({ role: role.key, kind: 'custom', name: 'Geçici', reassignTo: 'AUDITOR', reassignToLabel: 'Denetleyici', members: 1, invites: 1 });
    // Kim taşındı: üyelik ve davet kimlikleri, eski/yeni anahtar ve ad.
    const move = { from: role.key, to: 'AUDITOR', fromLabel: 'Geçici', toLabel: 'Denetleyici' };
    expect((audit?.meta as { moved: unknown[] }).moved).toEqual([
      { kind: 'member', id: m.membershipId, ...move },
      { kind: 'invitation', id: invite.json().invitation.id, ...move },
    ]);
  });

  it('hazır rol silinir (gizlenir): atanamaz, davetle verilemez, listede gizli; varsayılana dönüş geri getirir', async () => {
    const { owner, member } = await world();
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ACCOUNTING' });
    const del = await call(owner, 'DELETE', '/org/roles/builtin/deciship/MEASURE?reassignTo=ACCOUNTING');
    expect(del.json()).toEqual({ ok: true, reassigned: { members: 1, invites: 0 } });
    const d = await rolesOf(owner);
    expect(d.roles.map((r) => r.key)).toEqual(['ADMIN', 'AUDITOR', 'ACCOUNTING']);
    expect(d.hiddenBuiltins).toEqual([{ key: 'MEASURE', name: 'Measurement' }]);
    expect(errorCode(await call(owner, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: 'MEASURE' } }))).toBe('INVALID_PRODUCT_ROLE');
    expect(errorCode(await call(owner, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('gizli'), productRoles: { deciship: 'MEASURE' } }))).toBe('INVALID_PRODUCT_ROLE');
    expect(errorCode(await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'X', version: 1 }))).toBe('NOT_FOUND');
    // Taşınan çalışanın jetonu Muhasebe izinlerini taşır.
    const fresh = await refresh(member);
    expect(claimsOf(fresh.accessToken).prod.deciship?.role).toBe('ACCOUNTING');

    // ADMIN (Muhasebe) Ölçüm'ün tek iznine sahip değil: geri getirmek yetki yükseltmesi olurdu.
    expect(forbiddenReason(await call(admin, 'POST', '/org/roles/builtin/deciship/MEASURE/reset'))?.reason).toBe('escalation');
    const reset = await call(owner, 'POST', '/org/roles/builtin/deciship/MEASURE/reset');
    expect(reset.statusCode, reset.body).toBe(200);
    // Silme gölge satırı 1 ile açtı, dönüş 2 yapar (sürüm geri gitmez).
    expect(reset.json().role).toMatchObject({ key: 'MEASURE', edited: false, version: 2, permissions: [P.capture] });
    expect((await rolesOf(owner)).hiddenBuiltins).toEqual([]);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: owner.orgId, action: 'role.reset' } });
    expect(audit?.meta).toMatchObject({ role: 'MEASURE', kind: 'builtin', unhidden: true });
    expect((await call(owner, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: 'MEASURE' } })).statusCode).toBe(200);
  });

  it('başka firmanın özel rolü: atanamaz (INVALID_PRODUCT_ROLE), uçlarda 404; veritabanı da bağlamaz', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const role = await createdRole(a, { name: 'A rolü', permissions: [P.capture] });
    const bm = await addMember(app, b.orgId);
    expect(errorCode(await call(b, 'PATCH', `/org/members/${bm.membershipId}`, { productRoles: { deciship: role.key } }))).toBe('INVALID_PRODUCT_ROLE');
    expect(errorCode(await call(b, 'PATCH', `/org/roles/${idOf(role.key)}`, { name: 'X', version: 1 }))).toBe('NOT_FOUND');
    expect(errorCode(await call(b, 'DELETE', `/org/roles/${idOf(role.key)}`))).toBe('NOT_FOUND');
    // Tetikleyici: özel rol yalnız kendi firmasının üyeliğine bağlanır.
    await expect(prisma.productAccess.create({ data: { membershipId: bm.membershipId, product: D, role: role.key, customRoleId: idOf(role.key) } })).rejects.toThrow(
      /baska firmanin|check/i,
    );
    // CHECK: özel rol anahtarı yabancı anahtarsız yazılamaz.
    const am = await addMember(app, a.orgId);
    await expect(prisma.productAccess.create({ data: { membershipId: am.membershipId, product: D, role: role.key } })).rejects.toThrow();
  });

  it('davetle özel rol: kabul özel rolü ve yabancı anahtarı yazar, jeton perms taşır', async () => {
    const owner = await registerOrg(app);
    const role = await createdRole(owner, { name: 'Sayım', permissions: [P.capture] });
    const phone = randomTrPhone();
    const invite = await call(owner, 'POST', '/org/members/invite', { kind: 'PHONE_CODE', phone, name: 'Sayımcı', productRoles: { deciship: role.key } });
    const accept = await call(null, 'POST', '/auth/join/accept', { phone, code: invite.json().code, password: PASSWORD, name: 'Sayımcı', client: 'mobile' });
    expect(accept.statusCode, accept.body).toBe(201);
    const claims = claimsOf(accept.json().accessToken);
    expect(claims.prod.deciship).toMatchObject({ role: role.key, perms: [P.capture] });
    const access = await prisma.productAccess.findUniqueOrThrow({ where: { membershipId_product: { membershipId: claims.mid as string, product: D } } });
    expect(access.customRoleId).toBe(idOf(role.key));
  });
});

describe('roller: güvenlik incelemesi düzeltmeleri', () => {
  it('karar: yetki yükseltme yalnız rol tanımını korur; var olan rolü atamak hedefi yönetmek + sahibe özel kuralıyla sınırlı', async () => {
    const { admin, member } = await world();
    // Denetleyici olan yöneticide itiraz izni yok; Muhasebe rolünde var.
    const assign = await call(admin, 'PATCH', `/org/members/${member.membershipId}`, { productRoles: { deciship: 'ACCOUNTING' } });
    expect(assign.statusCode, assign.body).toBe(200);
    const define = await createRole(admin, { name: 'İtiraz', permissions: [P.disputes, P.invoicesView, P.prices] });
    expect(forbiddenReason(define)).toEqual({ reason: 'escalation', permissions: [P.disputes] });
  });

  it('ad ve açıklama: sıfır genişlik, bidi ve kontrol karakteri 400; ad NFC ile tekil', async () => {
    const { owner } = await world();
    for (const name of ['Yönetici\u200B', '\u202EDepo', 'Depo\u0007', 'De\u200Dpo']) {
      expect(errorCode(await createRole(owner, { name, permissions: [] })), JSON.stringify(name)).toBe('VALIDATION');
    }
    expect(errorCode(await createRole(owner, { name: 'Depo', description: 'a\u200Fb', permissions: [] }))).toBe('VALIDATION');
    const ok = await createdRole(owner, { name: 'Depo', description: 'Satır 1\nSatır 2', permissions: [] });
    expect(ok.description).toBe('Satır 1\nSatır 2');
    // Ayrık aksanla yazılmış "Ölçüm" katalog adıyla aynıdır; ayrık "Şef" saklanırken birleşik yazıma çevrilir.
    expect(errorCode(await createRole(owner, { name: 'O\u0308lc\u0327u\u0308m', permissions: [] }))).toBe('ROLE_NAME_TAKEN');
    const chef = await createdRole(owner, { name: 'S\u0327ef', permissions: [] });
    expect(chef.name).toBe('Şef');
    expect(errorCode(await createRole(owner, { name: 'şef', permissions: [] }))).toBe('ROLE_NAME_TAKEN');
  });

  it('yeniden gönderme: sahibin sahibe özel izinli davetini yönetici yeniden gönderemez (sessizce ölmesin)', async () => {
    const { owner, admin } = await world();
    const settings = await createdRole(owner, { name: 'Ayar', permissions: [P.settings, P.web, P.prices] });
    const invite = await call(owner, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('yg'), productRoles: { deciship: settings.key } });
    const id = invite.json().invitation.id;
    const res = await call(admin, 'POST', `/org/invitations/${id}/resend`);
    expect(forbiddenReason(res)).toEqual({ reason: 'owner_only', permissions: [P.settings] });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id } })).invitedById).toBe(owner.membershipId);
    expect((await call(owner, 'POST', `/org/invitations/${id}/resend`)).statusCode).toBe(200);
    // Sahibe özel izni olmayan davet yönetici tarafından yeniden gönderilir.
    const plain = await call(owner, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('yg'), productRoles: { deciship: 'MEASURE' } });
    expect((await call(admin, 'POST', `/org/invitations/${plain.json().invitation.id}/resend`)).statusCode).toBe(200);
  });

  it('silmede taşıma: yöneticinin açtığı davet sahibe özel izinli role taşınamaz (ret, davet kalır)', async () => {
    const { owner, admin } = await world();
    const role = await createdRole(owner, { name: 'Taşınan', permissions: [P.capture] });
    const invite = await call(admin, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('ts'), productRoles: { deciship: role.key } });
    expect(invite.statusCode, invite.body).toBe(201);
    const res = await call(owner, 'DELETE', `/org/roles/${idOf(role.key)}?reassignTo=ADMIN`);
    expect(forbiddenReason(res)).toMatchObject({ reason: 'pending_admin_invites', permissions: [P.settings], invitations: [{ id: invite.json().invitation.id }] });
    expect(await prisma.productRole.count({ where: { id: idOf(role.key) } })).toBe(1);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invite.json().invitation.id } })).productRoles).toEqual({ deciship: role.key });
    expect((await call(owner, 'DELETE', `/org/roles/${idOf(role.key)}?reassignTo=AUDITOR`)).statusCode).toBe(200);
  });

  it('sürüm tekdüze: düzenle (1) → varsayılana dön (2) → A düzenler (3) → eski 1 ile yazan ROLE_VERSION alır', async () => {
    const owner = await registerOrg(app);
    const v1 = await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'Sayım', version: 0 });
    expect(v1.json().role.version).toBe(1);
    const reset = await call(owner, 'POST', '/org/roles/builtin/deciship/MEASURE/reset');
    expect(reset.json().role).toMatchObject({ version: 2, edited: false, name: 'Measurement' });
    // Dokunulmamış hale dönen rolde yeniden dönüş bir şey yapmaz (sürüm artmaz).
    expect((await call(owner, 'POST', '/org/roles/builtin/deciship/MEASURE/reset')).json().role.version).toBe(2);
    const a = await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'A', version: 2 });
    expect(a.json().role).toMatchObject({ version: 3, name: 'A' });
    expect(errorCode(await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'Eski', version: 1 }))).toBe('ROLE_VERSION');
    expect(errorCode(await call(owner, 'PATCH', '/org/roles/builtin/deciship/MEASURE', { name: 'Eski', version: 0 }))).toBe('ROLE_VERSION');
  });

  /**
   * Kilit sırası (ölü kilit, 40P01): kabul ürün rol kilidini kişi ve davet satırından ÖNCE alır. Rol yazımının özel kilidi
   * tutulurken başlayan kabul bu kilitte bekler ve davet satırını henüz kilitlememiştir; rol silme davet satırını yazabilir.
   */
  describe('davet kabulü kilit sırası: ürün rol kilidi davet satırından önce', () => {
    async function withHeldRoleLock(orgId: string, invitationId: string, start: () => Promise<{ statusCode: number; body: string }>) {
      const url = new URL(SUPER_URL);
      url.pathname = `/${TEST_DB_NAME}`;
      const holder = new pg.Client({ connectionString: url.toString() });
      const probe = new pg.Client({ connectionString: url.toString() });
      await holder.connect();
      await probe.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`product-role:${orgId}:deciship`]);
        const pending = start();
        // Kabul kilitte beklemeye girene kadar.
        let waiting = 0;
        for (let i = 0; i < 100 && !waiting; i++) {
          const { rows } = await probe.query(
            `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
             WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`,
          );
          waiting = rows[0].n;
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting).toBeGreaterThan(0);
        // Davet satırı boşta: rol silme onu yazabilir (eski sırada kabul satırı tutup bu kilidi beklerdi).
        await probe.query('BEGIN');
        await expect(probe.query('SELECT 1 FROM "platform"."Invitation" WHERE "id" = $1 FOR UPDATE NOWAIT', [invitationId])).resolves.toBeTruthy();
        await probe.query('ROLLBACK');
        await holder.query('COMMIT');
        return await pending;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await probe.end();
      }
    }

    it('e-posta daveti', async () => {
      const owner = await registerOrg(app);
      const invite = await call(owner, 'POST', '/org/members/invite', { kind: 'EMAIL', email: randomEmail('kilit'), productRoles: { deciship: 'MEASURE' } });
      const token = String(invite.json().link).split('/invite/')[1];
      const res = await withHeldRoleLock(owner.orgId, invite.json().invitation.id, () =>
        call(null, 'POST', `/invites/${token}/accept`, { name: 'Kilit', password: 'MaviKedi-9137-uzun', client: 'mobile' }),
      );
      expect(res.statusCode, res.body).toBe(201);
    });

    it('telefon kodu', async () => {
      const owner = await registerOrg(app);
      const phone = randomTrPhone();
      const invite = await call(owner, 'POST', '/org/members/invite', { kind: 'PHONE_CODE', phone, name: 'Kilit', productRoles: { deciship: 'MEASURE' } });
      const res = await withHeldRoleLock(owner.orgId, invite.json().invitation.id, () =>
        call(null, 'POST', '/auth/join/accept', { phone, code: invite.json().code, password: PASSWORD, name: 'Kilit', client: 'mobile' }),
      );
      expect(res.statusCode, res.body).toBe(201);
    });
  });
});
