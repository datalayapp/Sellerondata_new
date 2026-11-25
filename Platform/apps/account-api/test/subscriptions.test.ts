import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlatformEvent, SubscriptionStatus } from '@sellerondata/contracts';
import { prisma, type Tx } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { PRODUCT_LAUNCH_ENV } from '../src/lib/launch.ts';
import {
  announceMembers,
  closeOrg,
  isOrgClosed,
  launchProduct,
  listOrgs,
  previewCloseOrg,
  reopenOrg,
  setSubscription,
  type SubscriptionChange,
} from '../src/lib/subscriptions.ts';
import { API, addMember, claimsOf, getApp, randomEmail, randomIp, registerOrg, asWeb } from './helpers.ts';

const DAY = 86_400_000;
const OP = 'destek-ayse';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const savedLaunch = process.env[PRODUCT_LAUNCH_ENV];
afterEach(() => {
  if (savedLaunch === undefined) delete process.env[PRODUCT_LAUNCH_ENV];
  else process.env[PRODUCT_LAUNCH_ENV] = savedLaunch;
});

function set(orgId: string, change: SubscriptionChange, audit: { operator?: string; reason?: string; via?: 'set' | 'launch' | 'close' | 'reopen' } = {}) {
  return prisma.$transaction((tx) =>
    setSubscription(tx, orgId, 'deciship', change, { operator: audit.operator ?? OP, reason: audit.reason, via: audit.via ?? 'set' }),
  );
}

/** Sahip + rolü olan üye + askıdaki üye + rolsüz üye. */
async function orgWithMembers() {
  const owner = await registerOrg(app);
  const measure = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
  const suspended = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
  await prisma.membership.update({ where: { id: suspended.membershipId }, data: { status: 'SUSPENDED' } });
  const noRole = await addMember(app, owner.orgId, { deciship: null });
  return { owner, measure, suspended, noRole, ids: [owner.membershipId, measure.membershipId, suspended.membershipId, noRole.membershipId] };
}

/** Eski firma: DeciShip aboneliği ve sahibin DeciShip rolü yok (Mesaj 11 öncesi açılmış bir aracın yokluğu gibi). Yalnız test verisi. */
async function legacyOrg() {
  const org = await orgWithMembers();
  await prisma.subscription.deleteMany({ where: { orgId: org.owner.orgId, product: 'deciship' } });
  await prisma.productAccess.deleteMany({ where: { membershipId: org.owner.membershipId, product: 'deciship' } });
  return org;
}

async function outboxIds(orgId: string) {
  return new Set((await prisma.outbox.findMany({ where: { orgId }, select: { id: true } })).map((r) => r.id));
}

async function eventsSince(orgId: string, before: Set<string>) {
  const rows = await prisma.outbox.findMany({ where: { orgId }, include: { deliveries: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.filter((r) => !before.has(r.id)).map((r) => ({ ...(r.payload as PlatformEvent), targets: r.deliveries.map((d) => d.target) }));
}

async function epochs(ids: string[]) {
  const rows = await prisma.membership.findMany({ where: { id: { in: ids } }, select: { id: true, epoch: true } });
  return Object.fromEntries(rows.map((r) => [r.id, r.epoch]));
}

async function sub(orgId: string) {
  return prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'deciship' } } });
}

async function audits(orgId: string, action: string) {
  return prisma.auditLog.findMany({ where: { orgId, action }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

describe('subscription:set durum geçişleri', () => {
  it('ACTIVE → READ_ONLY: sürüm artar, olay, her üyeliğin epoch artışı, denetim izi', async () => {
    const { owner, ids } = await orgWithMembers();
    const before = await outboxIds(owner.orgId);
    const ep0 = await epochs(ids);
    const r = await set(owner.orgId, { status: 'READ_ONLY' }, { reason: 'ödeme gecikti' });
    expect(r).toMatchObject({ changed: true, from: 'ACTIVE', to: 'READ_ONLY', version: 2, firstOpen: false, bumped: 4 });
    expect(await sub(owner.orgId)).toMatchObject({ status: 'READ_ONLY', version: 2, canceledAt: null, deleteAfter: null, plan: 'early_access' });

    const ep1 = await epochs(ids);
    for (const id of ids) expect(ep1[id]).toBe(ep0[id] + 1);
    const events = await eventsSince(owner.orgId, before);
    const subEvents = events.filter((e) => e.type === 'subscription.updated');
    expect(subEvents).toEqual([expect.objectContaining({ status: 'READ_ONLY', plan: 'early_access', version: 2, product: 'deciship', targets: ['deciship'] })]);
    const memberEvents = events.filter((e) => e.type === 'member.upserted') as Extract<PlatformEvent, { type: 'member.upserted' }>[];
    expect(new Set(memberEvents.map((e) => e.membershipId))).toEqual(new Set(ids));
    for (const e of memberEvents) expect(e.epoch).toBe(ep1[e.membershipId]);

    const [a] = await audits(owner.orgId, 'support.subscription_changed');
    expect(a.meta).toEqual({ product: 'deciship', from: 'ACTIVE', to: 'READ_ONLY', plan: 'early_access', via: 'set', operator: OP, reason: 'ödeme gecikti' });
  });

  it('aynı durum ve aynı plan: değişiklik yok (olay, sürüm, epoch, denetim yok)', async () => {
    const { owner, ids } = await orgWithMembers();
    const before = await outboxIds(owner.orgId);
    const ep0 = await epochs(ids);
    for (const change of [{ status: 'ACTIVE' }, { status: 'ACTIVE', plan: 'early_access' }] as SubscriptionChange[]) {
      const r = await set(owner.orgId, change);
      expect(r).toMatchObject({ changed: false, from: 'ACTIVE', to: 'ACTIVE', version: 1, bumped: 0 });
    }
    expect((await sub(owner.orgId)).version).toBe(1);
    expect(await eventsSince(owner.orgId, before)).toEqual([]);
    expect(await epochs(ids)).toEqual(ep0);
    expect(await audits(owner.orgId, 'support.subscription_changed')).toHaveLength(0);
  });

  it('yalnız plan değişirse sürüm artar, olay gider, jetonlar bayatlamaz', async () => {
    const { owner, ids } = await orgWithMembers();
    const before = await outboxIds(owner.orgId);
    const ep0 = await epochs(ids);
    const r = await set(owner.orgId, { status: 'ACTIVE', plan: 'pro_2027' });
    expect(r).toMatchObject({ changed: true, from: 'ACTIVE', to: 'ACTIVE', version: 2, bumped: 0, plan: 'pro_2027' });
    expect(await epochs(ids)).toEqual(ep0);
    const events = await eventsSince(owner.orgId, before);
    expect(events.map((e) => e.type)).toEqual(['subscription.updated']);
    expect((await audits(owner.orgId, 'support.subscription_changed'))[0].meta).toMatchObject({ from: 'ACTIVE', to: 'ACTIVE', plan: 'pro_2027' });
  });

  it('CANCELED: canceledAt şimdi, deleteAfter tam gün sonra (varsayılan 90, --days N)', async () => {
    const a = await registerOrg(app);
    const t0 = Date.now();
    const r = await set(a.orgId, { status: 'CANCELED' });
    const s = await sub(a.orgId);
    expect(s.status).toBe('CANCELED');
    expect(s.canceledAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(s.deleteAfter!.getTime() - s.canceledAt!.getTime()).toBe(90 * DAY);
    expect(r.deleteAfter?.getTime()).toBe(s.deleteAfter!.getTime());

    const b = await registerOrg(app);
    await set(b.orgId, { status: 'READ_ONLY' });
    await set(b.orgId, { status: 'CANCELED', days: 1 });
    const sb = await sub(b.orgId);
    expect(sb.deleteAfter!.getTime() - sb.canceledAt!.getTime()).toBe(DAY);
    expect(sb.version).toBe(3);
  });

  it('--days sınırı: 0, kesirli, 3650 üstü ve CANCELED dışında reddedilir; hiçbir şey değişmez', async () => {
    const owner = await registerOrg(app);
    for (const days of [0, -1, 1.5, 3651]) {
      await expect(set(owner.orgId, { status: 'CANCELED', days })).rejects.toThrow(/--days/);
    }
    await expect(set(owner.orgId, { status: 'READ_ONLY', days: 5 })).rejects.toThrow(/yalnız CANCELED/);
    expect(await sub(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    await expect(set(owner.orgId, { status: 'CANCELED', days: 3650 })).resolves.toMatchObject({ changed: true });
  });

  it('CANCELED → READ_ONLY yok; CANCELED → ACTIVE süresi geçmiş olsa da açar ve iptal alanlarını temizler', async () => {
    const owner = await registerOrg(app);
    await set(owner.orgId, { status: 'CANCELED', days: 5 });
    await expect(set(owner.orgId, { status: 'READ_ONLY' })).rejects.toThrow(/Önce ACTIVE/);
    expect((await sub(owner.orgId)).version).toBe(2);
    await prisma.subscription.update({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } }, data: { deleteAfter: new Date(Date.now() - DAY) } });
    const r = await set(owner.orgId, { status: 'ACTIVE' });
    expect(r).toMatchObject({ changed: true, from: 'CANCELED', to: 'ACTIVE', version: 3 });
    expect(await sub(owner.orgId)).toMatchObject({ status: 'ACTIVE', canceledAt: null, deleteAfter: null });
  });

  it('operatör zorunlu, plan biçimi denetlenir, bilinmeyen firma ve kapalı ürün reddedilir', async () => {
    const owner = await registerOrg(app);
    await expect(set(owner.orgId, { status: 'READ_ONLY' }, { operator: '   ' })).rejects.toThrow(/operator zorunlu/);
    for (const plan of ['Pro', '1x', 'a', 'pro-1', 'x'.repeat(41)]) {
      await expect(set(owner.orgId, { status: 'READ_ONLY', plan })).rejects.toThrow(/Plan geçersiz/);
    }
    await expect(set(crypto.randomUUID(), { status: 'READ_ONLY' })).rejects.toThrow(/Firma bulunamadı/);
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=off';
    await expect(set(owner.orgId, { status: 'READ_ONLY' })).rejects.toThrow(/PRODUCT_LAUNCH/);
    expect(await sub(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(await audits(owner.orgId, 'support.subscription_changed')).toHaveLength(0);
  });

  it('eşzamanlı değişimlerde sürüm kilit altında artar: tekrar yok, son olay veritabanındaki durumu taşır', async () => {
    const owner = await registerOrg(app);
    const before = await outboxIds(owner.orgId);
    const statuses: SubscriptionStatus[] = ['READ_ONLY', 'ACTIVE', 'READ_ONLY', 'ACTIVE', 'READ_ONLY', 'ACTIVE', 'READ_ONLY'];
    const results = await Promise.all(statuses.map((status) => set(owner.orgId, { status })));
    const s = await sub(owner.orgId);
    const changed = results.filter((r) => r.changed);
    expect(s.version).toBe(1 + changed.length);
    const versions = (await eventsSince(owner.orgId, before))
      .filter((e) => e.type === 'subscription.updated')
      .map((e) => e as Extract<PlatformEvent, { type: 'subscription.updated' }>)
      .sort((x, y) => x.version! - y.version!);
    expect(versions.map((e) => e.version)).toEqual(changed.map((_, i) => i + 2));
    expect(versions.at(-1)?.status).toBe(s.status);
  });
});

describe('ilk açılış', () => {
  it('satır yoksa ACTIVE açar: abonelik ve firma olayı, sahibe sahip rolü, bütün üyeler yalnız bu ürüne duyurulur', async () => {
    const { owner, measure, suspended, noRole, ids } = await legacyOrg();
    const org0 = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    const ep0 = await epochs(ids);
    const before = await outboxIds(owner.orgId);
    const r = await set(owner.orgId, { status: 'ACTIVE' }, { via: 'launch' });
    expect(r).toMatchObject({ changed: true, from: null, to: 'ACTIVE', version: 1, firstOpen: true, plan: 'early_access', ownerRoleGranted: 1, announced: 4, bumped: 0 });
    expect(await sub(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1, plan: 'early_access' });

    // Firma sürümü artmaz; olay güncel değerleri taşır.
    const org1 = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(org1.version).toBe(org0.version);
    // Sahibe rol: rol değişimi yolu, epoch artar. Diğerlerinin epoch'u değişmez.
    expect(await prisma.productAccess.findUnique({ where: { membershipId_product: { membershipId: owner.membershipId, product: 'deciship' } } })).toMatchObject({ role: 'ADMIN' });
    const ep1 = await epochs(ids);
    expect(ep1[owner.membershipId]).toBe(ep0[owner.membershipId] + 1);
    for (const id of [measure.membershipId, suspended.membershipId, noRole.membershipId]) expect(ep1[id]).toBe(ep0[id]);

    const events = await eventsSince(owner.orgId, before);
    for (const e of events) expect(e.targets).toEqual(['deciship']);
    expect(events.filter((e) => e.type === 'subscription.updated')).toEqual([
      expect.objectContaining({ status: 'ACTIVE', plan: 'early_access', version: 1 }),
    ]);
    expect(events.filter((e) => e.type === 'org.updated')).toEqual([
      expect.objectContaining({ name: org1.name, country: org1.country, currency: org1.currency, version: org1.version }),
    ]);
    const upserts = events.filter((e) => e.type === 'member.upserted') as Extract<PlatformEvent, { type: 'member.upserted' }>[];
    // Her üyelik bir kez (sahibinki rol değişimi olayıdır).
    expect(upserts.map((e) => e.membershipId).sort()).toEqual([...ids].sort());
    const by = Object.fromEntries(upserts.map((e) => [e.membershipId, e]));
    expect(by[owner.membershipId]).toMatchObject({ role: 'ADMIN', active: true, orgRole: 'OWNER', epoch: ep1[owner.membershipId] });
    expect(by[measure.membershipId]).toMatchObject({ role: 'MEASURE', active: true, epoch: ep1[measure.membershipId] });
    expect(by[suspended.membershipId]).toMatchObject({ role: 'AUDITOR', active: false });
    expect(by[noRole.membershipId]).toMatchObject({ role: null, active: true });

    const [a] = await audits(owner.orgId, 'support.subscription_changed');
    expect(a.meta).toEqual({ product: 'deciship', from: null, to: 'ACTIVE', plan: 'early_access', via: 'launch', operator: OP });
  });

  it('satır yokken READ_ONLY ya da CANCELED açılmaz', async () => {
    const { owner } = await legacyOrg();
    await expect(set(owner.orgId, { status: 'READ_ONLY' })).rejects.toThrow(/abonelik yok/);
    await expect(set(owner.orgId, { status: 'CANCELED' })).rejects.toThrow(/abonelik yok/);
    expect(await prisma.subscription.count({ where: { orgId: owner.orgId } })).toBe(0);
  });

  it('aynı firmaya aynı anda iki açılış: tek satır, tek olay, biri değişiklik yok döner', async () => {
    const { owner } = await legacyOrg();
    const before = await outboxIds(owner.orgId);
    const results = await Promise.all([set(owner.orgId, { status: 'ACTIVE' }), set(owner.orgId, { status: 'ACTIVE' })]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.filter((r) => r.firstOpen)).toHaveLength(1);
    expect(await sub(owner.orgId)).toMatchObject({ version: 1 });
    const events = await eventsSince(owner.orgId, before);
    expect(events.filter((e) => e.type === 'subscription.updated')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'org.updated')).toHaveLength(1);
    expect(await audits(owner.orgId, 'support.subscription_changed')).toHaveLength(1);
  });
});

describe('product:launch', () => {
  it('yalnız satırı olmayan firmalara açar; durdurulmuş, iptal ve kapatılmış firmaya dokunmaz; ikinci koşu 0 açar', async () => {
    const fresh = await legacyOrg();
    const paused = await registerOrg(app);
    await set(paused.orgId, { status: 'READ_ONLY' });
    const canceled = await registerOrg(app);
    await set(canceled.orgId, { status: 'CANCELED' });
    const closed = await legacyOrg();
    // Kapatılmış firma: kayıt kapatma ve iptal edilmemiş abonelik yok.
    await prisma.auditLog.create({ data: { orgId: closed.owner.orgId, action: 'support.org_closed', target: closed.owner.orgId, meta: { subscriptions: [], days: 90, operator: OP } } });
    const pausedV = (await sub(paused.orgId)).version;
    const canceledV = (await sub(canceled.orgId)).version;

    const dry = await launchProduct('deciship', { operator: OP, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.orgs.map((o) => o.id)).toContain(fresh.owner.orgId);
    expect(dry.orgs.map((o) => o.id)).not.toContain(closed.owner.orgId);
    expect(await prisma.subscription.count({ where: { orgId: fresh.owner.orgId } })).toBe(0);

    const first = await launchProduct('deciship', { operator: OP });
    expect(first.orgs.map((o) => o.id)).toContain(fresh.owner.orgId);
    expect(first.opened).toBe(first.orgs.length);
    expect(first.closed).toBeGreaterThanOrEqual(1);
    expect(await sub(fresh.owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(await prisma.subscription.count({ where: { orgId: closed.owner.orgId } })).toBe(0);
    expect(await sub(paused.orgId)).toMatchObject({ status: 'READ_ONLY', version: pausedV });
    expect(await sub(canceled.orgId)).toMatchObject({ status: 'CANCELED', version: canceledV });
    expect((await audits(fresh.owner.orgId, 'support.subscription_changed'))[0].meta).toMatchObject({ via: 'launch', from: null });

    const second = await launchProduct('deciship', { operator: OP });
    expect(second.opened).toBe(0);
  });

  it('public olmayan araçta, operatörsüz ve geçersiz planla çalışmaz', async () => {
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=pilot';
    await expect(launchProduct('deciship', { operator: OP })).rejects.toThrow(/yalnız public/);
    delete process.env[PRODUCT_LAUNCH_ENV];
    await expect(launchProduct('orderloom', { operator: OP })).rejects.toThrow(/yalnız public/);
    await expect(launchProduct('deciship', { operator: '' })).rejects.toThrow(/operator zorunlu/);
    await expect(launchProduct('deciship', { operator: OP, plan: 'Kötü Plan' })).rejects.toThrow(/Plan geçersiz/);
  });

  it('eşzamanlı launch ve elle açılış aynı firmada tek satır üretir', async () => {
    const { owner } = await legacyOrg();
    const before = await outboxIds(owner.orgId);
    await Promise.all([launchProduct('deciship', { operator: OP }), set(owner.orgId, { status: 'ACTIVE' })]);
    expect(await sub(owner.orgId)).toMatchObject({ version: 1, status: 'ACTIVE' });
    expect((await eventsSince(owner.orgId, before)).filter((e) => e.type === 'subscription.updated')).toHaveLength(1);
  });
});

describe('org:close ve org:reopen', () => {
  async function pendingInvite(orgId: string, invitedById: string) {
    return prisma.invitation.create({
      data: { orgId, kind: 'EMAIL', email: `${crypto.randomUUID()}@test.sellerondata.com`, tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + DAY), invitedById },
    });
  }

  it('kapatma: abonelikler iptal, davetler düşer, epoch bir kez artar, hiçbir veri silinmez; denetim izi', async () => {
    const { owner, ids, noRole } = await orgWithMembers();
    const noRolePersonId = noRole.personId;
    await pendingInvite(owner.orgId, owner.membershipId);
    await pendingInvite(owner.orgId, owner.membershipId);
    // Şifre kodu kişiye aittir: kapatma onu düşürmez (R1 bulgu 4).
    const reset = await prisma.invitation.create({
      data: {
        orgId: owner.orgId,
        kind: 'PHONE_RESET',
        phone: '+905320000000',
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + DAY),
        invitedById: owner.membershipId,
        targetPersonId: noRolePersonId,
      },
    });
    const counts = async () => ({
      memberships: await prisma.membership.count({ where: { orgId: owner.orgId } }),
      access: await prisma.productAccess.count({ where: { membership: { orgId: owner.orgId } } }),
      subs: await prisma.subscription.count({ where: { orgId: owner.orgId } }),
      invitations: await prisma.invitation.count({ where: { orgId: owner.orgId } }),
      org: await prisma.organization.count({ where: { id: owner.orgId } }),
    });
    const c0 = await counts();
    const ep0 = await epochs(ids);

    const preview = await previewCloseOrg(owner.orgId, { days: 30 });
    expect(preview).toMatchObject({ subscriptions: [{ product: 'deciship', from: 'ACTIVE' }], pendingInvitations: 2, days: 30 });
    expect((await sub(owner.orgId)).status).toBe('ACTIVE');

    const r = await closeOrg(owner.orgId, { operator: OP, days: 30, reason: 'müşteri istedi' });
    expect(r).toMatchObject({ changed: true, canceled: ['deciship'], invitationsRevoked: 2, bumped: 4 });
    const s = await sub(owner.orgId);
    expect(s).toMatchObject({ status: 'CANCELED', version: 2 });
    expect(s.deleteAfter!.getTime() - s.canceledAt!.getTime()).toBe(30 * DAY);
    expect(await counts()).toEqual(c0);
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId, kind: { in: ['EMAIL', 'PHONE_CODE'] }, revokedAt: null } })).toBe(0);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: reset.id } })).toMatchObject({ revokedAt: null });
    const ep1 = await epochs(ids);
    for (const id of ids) expect(ep1[id]).toBe(ep0[id] + 1);

    const [closedAudit] = await audits(owner.orgId, 'support.org_closed');
    expect(closedAudit.meta).toEqual({ subscriptions: [{ product: 'deciship', from: 'ACTIVE' }], days: 30, operator: OP, reason: 'müşteri istedi' });
    expect((await audits(owner.orgId, 'support.subscription_changed'))[0].meta).toMatchObject({ via: 'close', from: 'ACTIVE', to: 'CANCELED' });

    // İkinci kapatma: değişiklik yok, kapatma kaydı ezilmez.
    expect(await closeOrg(owner.orgId, { operator: OP })).toMatchObject({ changed: false, canceled: [] });
    expect(await audits(owner.orgId, 'support.org_closed')).toHaveLength(1);
    expect((await sub(owner.orgId)).version).toBe(2);
  });

  it('yeniden açma eski durumu geri yükler (READ_ONLY dahil), süresi geçmiş olsa da; davetler geri gelmez; ikinci kez değişiklik yok', async () => {
    const { owner, ids } = await orgWithMembers();
    await set(owner.orgId, { status: 'READ_ONLY' });
    await pendingInvite(owner.orgId, owner.membershipId);
    await closeOrg(owner.orgId, { operator: OP, days: 1 });
    await prisma.subscription.update({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } }, data: { deleteAfter: new Date(Date.now() - DAY) } });
    const ep0 = await epochs(ids);

    const r = await reopenOrg(owner.orgId, { operator: OP });
    expect(r).toMatchObject({ restored: ['deciship'], details: [{ product: 'deciship', to: 'READ_ONLY' }], skipped: [], bumped: 4 });
    expect(await sub(owner.orgId)).toMatchObject({ status: 'READ_ONLY', canceledAt: null, deleteAfter: null, version: 4 });
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId, revokedAt: null } })).toBe(0);
    const ep1 = await epochs(ids);
    for (const id of ids) expect(ep1[id]).toBe(ep0[id] + 1);
    const [reopened] = await audits(owner.orgId, 'support.org_reopened');
    expect(reopened.meta).toMatchObject({ restored: [{ product: 'deciship', to: 'READ_ONLY' }], operator: OP });

    const again = await reopenOrg(owner.orgId, { operator: OP });
    expect(again.restored).toEqual([]);
    expect(await audits(owner.orgId, 'support.org_reopened')).toHaveLength(1);
    expect((await sub(owner.orgId)).version).toBe(4);
  });

  it('araya elle subscription:set girerse yeniden açma o aboneliğe dokunmaz', async () => {
    // Kapat → elle ACTIVE → elle CANCELED: hâlâ iptal ama kapatmanın yaptığı değil.
    const a = await registerOrg(app);
    await closeOrg(a.orgId, { operator: OP });
    await set(a.orgId, { status: 'ACTIVE' });
    await set(a.orgId, { status: 'CANCELED', days: 10 });
    const va = (await sub(a.orgId)).version;
    const ra = await reopenOrg(a.orgId, { operator: OP });
    expect(ra).toMatchObject({ restored: [], skipped: [{ product: 'deciship', reason: 'changed_after_close' }] });
    expect(await sub(a.orgId)).toMatchObject({ status: 'CANCELED', version: va });
    expect(await audits(a.orgId, 'support.org_reopened')).toHaveLength(0);

    // Kapat → elle ACTIVE: iptal değil, atlanır.
    const b = await registerOrg(app);
    await closeOrg(b.orgId, { operator: OP });
    await set(b.orgId, { status: 'ACTIVE' });
    const rb = await reopenOrg(b.orgId, { operator: OP });
    expect(rb).toMatchObject({ restored: [], skipped: [{ product: 'deciship', reason: 'not_canceled' }] });
  });

  it('kapatma kaydı olmayan firma yeniden açılmaz; operatör zorunlu; kapatma --days sınırı', async () => {
    const owner = await registerOrg(app);
    await expect(reopenOrg(owner.orgId, { operator: OP })).rejects.toThrow(/kapatma kaydı yok/);
    await expect(closeOrg(owner.orgId, { operator: ' ' })).rejects.toThrow(/operator zorunlu/);
    await expect(reopenOrg(owner.orgId, { operator: '' })).rejects.toThrow(/operator zorunlu/);
    await expect(closeOrg(owner.orgId, { operator: OP, days: 0 })).rejects.toThrow(/--days/);
    expect(await sub(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
  });
});

describe('durum değişimi sürerken katılım (R1 bulgu 2)', () => {
  const INVITE_PASSWORD = 'DavetSifre123!';

  /** Sahip API'den e-posta daveti açar; bağlantıdaki jeton döner. */
  async function emailInvite(owner: { accessToken: string }) {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'EMAIL', email: randomEmail('davetli'), name: 'Davetli Kişi', productRoles: { deciship: 'MEASURE' } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return /invite\/(\S+)$/.exec(res.json().link)![1];
  }

  function accept(token: string) {
    return app.inject({ method: 'POST', url: `${API}/invites/${token}/accept`, remoteAddress: randomIp(), payload: { client: 'mobile', password: INVITE_PASSWORD } });
  }

  /** İşlemi açık tutar: iş bitince bekler, `release` ile kapanır. */
  async function holdOpen<T>(work: (tx: Tx) => Promise<T>) {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (ready = r));
    const done = prisma.$transaction(async (tx) => {
      const r = await work(tx);
      ready();
      await gate;
      return r;
    });
    done.catch(() => ready());
    await started;
    return { release, done };
  }

  /** Kabul jetonu ya yeni durumu taşır ya da bayattır (ep < epoch): eski durumla geçerli jeton yok. */
  async function assertTokenNotStale(res: { json: () => unknown }, status: SubscriptionStatus | null) {
    const claims = claimsOf((res.json() as { accessToken: string }).accessToken);
    const db = await prisma.membership.findUniqueOrThrow({ where: { id: claims.mid! } });
    const carried = claims.prod.deciship?.status ?? null;
    expect(carried === status || claims.ep < db.epoch, `jeton ${carried} ep ${claims.ep}, veritabanı epoch ${db.epoch}`).toBe(true);
  }

  it('subscription:set işlemi açıkken başlayan kabul ya bekler ve yeni durumu alır ya da jetonu bayatlar', async () => {
    const owner = await registerOrg(app);
    const token = await emailInvite(owner);
    const { release, done } = await holdOpen((tx) => setSubscription(tx, owner.orgId, 'deciship', { status: 'READ_ONLY' }, { operator: OP, via: 'set' }));
    const pending = accept(token);
    await new Promise((r) => setTimeout(r, 400));
    release();
    expect((await done).changed).toBe(true);
    const res = await pending;
    expect(res.statusCode, res.body).toBe(201);
    await assertTokenNotStale(res, 'READ_ONLY');
  });

  it('ilk açılış sürerken katılan üye de araca duyurulur', async () => {
    const { owner } = await legacyOrg();
    const token = await emailInvite(owner);
    const { release, done } = await holdOpen((tx) => setSubscription(tx, owner.orgId, 'deciship', { status: 'ACTIVE' }, { operator: OP, via: 'set' }));
    const pending = accept(token);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await done;
    const res = await pending;
    expect(res.statusCode, res.body).toBe(201);
    const mid = claimsOf(res.json().accessToken).mid!;
    const rows = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'member.upserted' }, include: { deliveries: true } });
    const forJoiner = rows.filter((r) => (r.payload as { membershipId: string }).membershipId === mid);
    expect(forJoiner.flatMap((r) => r.deliveries.map((d) => d.target))).toContain('deciship');
  });

  it('org:close ile eşzamanlı kabul: ölü kilit (40P01) yok; kabul ya düşer ya da jetonu bayatlar/iptali taşır', async () => {
    for (let round = 0; round < 3; round += 1) {
      const owner = await registerOrg(app);
      await flushMail();
      const token = await emailInvite(owner);
      const [closed, res] = await Promise.allSettled([closeOrg(owner.orgId, { operator: OP }), accept(token)]);
      expect(closed.status, closed.status === 'rejected' ? String(closed.reason) : '').toBe('fulfilled');
      expect(res.status).toBe('fulfilled');
      const r = (res as PromiseFulfilledResult<Awaited<ReturnType<typeof accept>>>).value;
      if (r.statusCode === 400) expect(r.json().error.code).toBe('INVITE_INVALID');
      else {
        expect(r.statusCode, r.body).toBe(201);
        await assertTokenNotStale(r, 'CANCELED');
      }
    }
  });
});

describe('isOrgClosed (A1 davet yolu için)', () => {
  it('kapatma sonrası true; yeniden açma ya da elle açma sonrası false; işlem istemcisiyle de çalışır', async () => {
    const owner = await registerOrg(app);
    expect(await isOrgClosed(prisma, owner.orgId)).toBe(false);
    await closeOrg(owner.orgId, { operator: OP });
    expect(await isOrgClosed(prisma, owner.orgId)).toBe(true);
    expect(await prisma.$transaction((tx) => isOrgClosed(tx, owner.orgId))).toBe(true);
    await reopenOrg(owner.orgId, { operator: OP });
    expect(await isOrgClosed(prisma, owner.orgId)).toBe(false);
    await closeOrg(owner.orgId, { operator: OP });
    await set(owner.orgId, { status: 'ACTIVE' });
    expect(await isOrgClosed(prisma, owner.orgId)).toBe(false);
    // Yalnız iptal edilmiş (kapatılmamış) firma kapalı sayılmaz.
    const canceled = await registerOrg(app);
    await set(canceled.orgId, { status: 'CANCELED' });
    expect(await isOrgClosed(prisma, canceled.orgId)).toBe(false);
  });
});

describe('members:announce ve org:list', () => {
  it('yalnız bu ürüne firma ve üyeleri duyurur; epoch ve sürüm artmaz; kapalı üründe çalışmaz', async () => {
    const { owner, ids } = await orgWithMembers();
    const org0 = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    const ep0 = await epochs(ids);
    const before = await outboxIds(owner.orgId);
    const r = await announceMembers('deciship', { orgId: owner.orgId });
    expect(r).toMatchObject({ orgs: 1, members: 4, orgName: org0.name });
    expect(await epochs(ids)).toEqual(ep0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })).version).toBe(org0.version);
    const events = await eventsSince(owner.orgId, before);
    expect(events.map((e) => e.type).sort()).toEqual(['member.upserted', 'member.upserted', 'member.upserted', 'member.upserted', 'org.updated']);
    for (const e of events) expect(e.targets).toEqual(['deciship']);

    const legacy = await legacyOrg();
    await expect(announceMembers('deciship', { orgId: legacy.owner.orgId })).rejects.toThrow(/aboneliği yok/);
    await expect(announceMembers('orderloom')).rejects.toThrow(/kapalı/);
  });

  it('org:list süzer ve satırda sahip, üye sayısı, abonelik verir', async () => {
    const { owner } = await orgWithMembers();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    const [row] = await listOrgs({ q: org.name.slice(-8).toUpperCase() });
    expect(row).toMatchObject({
      id: owner.orgId,
      name: org.name,
      country: 'TR',
      members: { active: 3, total: 4 },
      ownerEmail: owner.email,
      subscriptions: [{ product: 'deciship', status: 'ACTIVE', plan: 'early_access', version: 1, deleteAfter: null }],
    });
    const legacy = await legacyOrg();
    const none = await listOrgs({ product: 'deciship', status: 'none', limit: 500 });
    expect(none.map((o) => o.id)).toContain(legacy.owner.orgId);
    expect(none.map((o) => o.id)).not.toContain(owner.orgId);
    await set(owner.orgId, { status: 'READ_ONLY' });
    const paused = await listOrgs({ product: 'deciship', status: 'READ_ONLY', limit: 500 });
    expect(paused.map((o) => o.id)).toContain(owner.orgId);
    expect(await listOrgs({ limit: 1 })).toHaveLength(1);
    await expect(listOrgs({ limit: 0 })).rejects.toThrow(/--limit/);
  });
});
