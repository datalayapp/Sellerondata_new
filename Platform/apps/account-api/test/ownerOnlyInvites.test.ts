import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { permissionsOf, type OrgProductRole, type OrgRolesResponse } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { lockRoleProducts } from '../src/lib/roleBook.ts';
import { addMember, API, asWeb, bearer, errorCode, getApp, randomIp, randomTrPhone, registerOrg, type Ctx } from './helpers.ts';

/**
 * KALANLAR 6.11: rol sahibe özel izin (`ownerOnlyPermissions`, DeciShip "Ayarlar") alırsa o roldeki firma yöneticisi davetleri
 * kabulde ölüyordu (`inviterStillAuthorized`: sahibe özel izinli rolü yalnız OWNER davetle verir). Karar: izin eklenirken reddedilir,
 * davet kabul edilebilir kalır (rol silerken başka role taşımanın kuralıyla aynı, `roles.ts` `deleteRole`).
 */

let app: FastifyInstance;
const D = 'deciship';
const SETTINGS = 'deciship.settings.manage';

beforeAll(async () => {
  app = await getApp();
});

async function call(ctx: Ctx, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url: `${API}${path}`,
    remoteAddress: randomIp(),
    headers: method === 'GET' ? ctx.headers : await asWeb(ctx),
    ...(payload ? { payload } : {}),
  });
}

async function roleOf(ctx: Ctx, key: string): Promise<OrgProductRole> {
  const res = await call(ctx, 'GET', '/org/roles');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as OrgRolesResponse).products.find((p) => p.key === D)!.roles.find((r) => r.key === key)!;
}

/** Telefon davetini açar; kod ve davet kimliği döner. */
async function phoneInvite(actor: Ctx, role: string) {
  const phone = randomTrPhone();
  const res = await call(actor, 'POST', '/org/members/invite', { kind: 'PHONE_CODE', phone, name: 'Davetli', productRoles: { [D]: role } });
  expect(res.statusCode, res.body).toBe(201);
  return { phone, code: res.json().code as string, id: res.json().invitation.id as string };
}

/** Yeni kişi açılır: `201`. */
async function accept(invite: { phone: string; code: string }) {
  return app.inject({
    method: 'POST',
    url: `${API}/auth/join/accept`,
    remoteAddress: randomIp(),
    payload: { phone: invite.phone, code: invite.code, password: 'YeniMavi-Kedi-81', client: 'mobile' },
  });
}

async function world() {
  const owner = await registerOrg(app);
  // Firma yöneticisi, kendisinde olan Denetleyici rolüyle davet açabilir.
  const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'AUDITOR' });
  return { owner, admin };
}

describe('sahibe özel izin role eklenirken yönetici davetleri', () => {
  it('hazır rol: yöneticinin bekleyen daveti varken sahip izni ekleyemez, davet kabul edilebilir kalır', async () => {
    const { owner, admin } = await world();
    const invite = await phoneInvite(admin, 'AUDITOR');
    const before = await roleOf(owner, 'AUDITOR');

    const res = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { permissions: [...before.permissions, SETTINGS], version: before.version });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorCode(res)).toBe('ROLE_FORBIDDEN');
    // Sahibe "yalnız sahip verebilir" denmez: engel olan davetler ve ne yapılacağı söylenir.
    expect(res.json().error.details).toEqual({ reason: 'pending_admin_invites', permissions: [SETTINGS], invitations: [{ id: invite.id, name: 'Davetli', contact: invite.phone }] });
    expect(res.json().error.message).toMatch(/cancel|resend/i);
    // Rol değişmedi.
    expect((await roleOf(owner, 'AUDITOR')).permissions).toEqual(before.permissions);

    const accepted = await accept(invite);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const membership = await prisma.membership.findFirstOrThrow({ where: { orgId: owner.orgId, person: { phone: invite.phone } }, include: { productAccess: true } });
    expect(membership.productAccess.map((a) => a.role)).toEqual(['AUDITOR']);
  });

  it('özel rol: aynı kural; daveti iptal edince izin eklenir', async () => {
    const { owner, admin } = await world();
    const created = await call(owner, 'POST', '/org/roles', { product: D, name: 'Denetim Ekibi', permissions: [...permissionsOf(D, 'AUDITOR')] });
    expect(created.statusCode, created.body).toBe(201);
    const role = created.json().role as OrgProductRole;
    const invite = await phoneInvite(admin, role.key);
    const path = `/org/roles/${role.key.slice('custom:'.length)}`;

    const denied = await call(owner, 'PATCH', path, { permissions: [...role.permissions, SETTINGS], version: role.version });
    expect(errorCode(denied), denied.body).toBe('ROLE_FORBIDDEN');
    expect(denied.json().error.details).toMatchObject({ reason: 'pending_admin_invites', permissions: [SETTINGS], invitations: [{ id: invite.id }] });

    const revoked = await call(owner, 'DELETE', `/org/invitations/${invite.id}`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    const ok = await call(owner, 'PATCH', path, { permissions: [...role.permissions, SETTINGS], version: role.version });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().role.permissions).toContain(SETTINGS);
  });

  it('sahibin kendi daveti engel değil; izin eklendikten sonra sahibin daveti kabul edilir', async () => {
    const { owner } = await world();
    const invite = await phoneInvite(owner, 'AUDITOR');
    const before = await roleOf(owner, 'AUDITOR');
    const res = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { permissions: [...before.permissions, SETTINGS], version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    const accepted = await accept(invite);
    expect(accepted.statusCode, accepted.body).toBe(201);
  });

  it('yalnız ad değişimi ve izin çıkarma etkilenmez; yöneticinin daveti açıkken de yapılır', async () => {
    const { owner, admin } = await world();
    await phoneInvite(admin, 'AUDITOR');
    const before = await roleOf(owner, 'AUDITOR');
    const renamed = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { name: 'Denetçi', version: before.version });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const fewer = before.permissions.filter((p) => p !== 'deciship.reports.view');
    const removed = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { permissions: fewer, version: renamed.json().role.version });
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('süresi geçmiş yönetici daveti engel değil (kabul edilemez; yeniden gönderen yetkisiyle sınanır): düzenleme ve silmede taşıma', async () => {
    const { owner, admin } = await world();
    const invite = await phoneInvite(admin, 'AUDITOR');
    await prisma.invitation.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = await roleOf(owner, 'AUDITOR');
    const res = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { permissions: [...before.permissions, SETTINGS], version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    // Yönetici artık onu yeniden gönderemez (sahibe özel izin). Rolü değişen yöneticinin jetonu bayatladı: önce yeniler.
    const refreshed = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: admin.refreshToken } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const fresh = { ...admin, accessToken: refreshed.json().accessToken as string, refreshToken: refreshed.json().refreshToken as string, headers: bearer(refreshed.json().accessToken) };
    const resent = await call(fresh, 'POST', `/org/invitations/${invite.id}/resend`);
    expect(errorCode(resent)).toBe('ROLE_FORBIDDEN');

    const created = await call(owner, 'POST', '/org/roles', { product: D, name: 'Geçici Ekip', permissions: ['deciship.measurements.capture'] });
    const role = created.json().role as OrgProductRole;
    const old = await phoneInvite(fresh, role.key);
    await prisma.invitation.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const del = await call(owner, 'DELETE', `/org/roles/${role.key.slice('custom:'.length)}?reassignTo=ADMIN`);
    expect(del.statusCode, del.body).toBe(200);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: old.id } })).productRoles).toEqual({ [D]: 'ADMIN' });
  });

  it('yöneticiden sahibe geçen davet (sahip yeniden gönderdi) engel değil', async () => {
    const { owner, admin } = await world();
    const invite = await phoneInvite(admin, 'AUDITOR');
    // Yeniden gönderen davetin sahibi olur (`invitedById`).
    const resent = await call(owner, 'POST', `/org/invitations/${invite.id}/resend`);
    expect(resent.statusCode, resent.body).toBe(200);
    const before = await roleOf(owner, 'AUDITOR');
    const res = await call(owner, 'PATCH', `/org/roles/builtin/${D}/AUDITOR`, { permissions: [...before.permissions, SETTINGS], version: before.version });
    expect(res.statusCode, res.body).toBe(200);
    const accepted = await accept({ phone: invite.phone, code: resent.json().code });
    expect(accepted.statusCode, accepted.body).toBe(201);
  });
});

describe('yeniden gönderme rol kilidini alır (inceleme: rol düzenlemesiyle yarış)', () => {
  it('rol düzenlemesi ürün kilidini tutarken yöneticinin yeniden göndermesi bekler, sonra biter', async () => {
    const { owner, admin } = await world();
    const invite = await phoneInvite(admin, 'AUDITOR');
    const adminWeb = await asWeb(admin);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    // Rol düzenlemesinin ilk kilidi (`patchRole`: `lockRoleProducts` özel). Yeniden gönderme rolün bugünkü iznini okumadan önce bekler.
    const holder = prisma.$transaction(
      async (tx) => {
        await lockRoleProducts(tx, owner.orgId, [D], 'exclusive');
        markLocked();
        await hold;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await locked;
    let finished = false;
    const pending = app
      .inject({ method: 'POST', url: `${API}/org/invitations/${invite.id}/resend`, remoteAddress: randomIp(), headers: adminWeb })
      .finally(() => (finished = true));
    let blocked = false;
    while (!finished && !blocked) {
      const waiting = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      blocked = waiting[0]!.n > 0;
      await new Promise((r) => setImmediate(r));
    }
    release();
    await holder;
    const res = await pending;
    expect(blocked).toBe(true);
    expect(res.statusCode, res.body).toBe(200);
  });
});
