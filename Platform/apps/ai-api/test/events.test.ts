import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HubAnalytics } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { orgUsage } from '../src/limits/usage.ts';
import { runMaintenance } from '../src/maintenance/index.ts';
import { closeSuper, superClient } from './helpers.ts';
import { auth, createG4Account, makeG4App, resetG4, seedCalls, thisMonth, type G4Account } from './g4Helpers.ts';

/**
 * Hesap hizmet olay alıcısı (G4): imza, kitle ve hedef; yinelenen teslim; sürüm kuralları (ürün olaylarıyla aynı); firma bilgisi ve
 * tavan satırları (G3 okur); kalıcı silme: ayrıntılı satır yok, günlük özet var (ad ve kişi yok), sonra gelen olay firmayı kurmaz.
 */

let account: G4Account;
let app: FastifyInstance;

beforeAll(async () => {
  account = await createG4Account();
  app = await makeG4App(account);
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetG4);

const URL = '/api/ai/internal/events';
const post = (token: unknown) => app.inject({ method: 'POST', url: URL, headers: { 'content-type': 'application/json' }, payload: { token } as object });
async function send(event: Record<string, unknown>, opts: Parameters<G4Account['serviceEvent']>[1] = {}) {
  const { token, eventId } = await account.serviceEvent(event, opts);
  const res = await post(token);
  return { res, eventId, outcome: res.statusCode === 200 ? (res.json().outcome as string) : null };
}
const org = (id = 'org-a') => getPrisma().org.findUnique({ where: { id } });

describe('doğrulama', () => {
  it('jetonsuz 400, yabancı imza 401, ürün olay kitlesi 401, başka hedef 400, jti uyuşmazlığı 400, bozuk biçim 400', async () => {
    expect((await post(undefined)).statusCode).toBe(400);
    expect((await post('a.b.c')).statusCode).toBe(401);
    const ev = { type: 'org.updated', orgId: 'org-a', name: 'A', version: 1 };
    expect((await send(ev, { foreign: true })).res.statusCode).toBe(401);
    const asProduct = await send(ev, { aud: account.PRODUCT_EVENT_AUDIENCE });
    expect(asProduct.res.statusCode).toBe(401);
    expect(asProduct.res.json().error.code).toBe('INVALID_EVENT');
    expect((await send(ev, { sub: 'deciship' })).res.statusCode).toBe(400);
    expect((await send(ev, { jti: 'baska' })).res.statusCode).toBe(400);
    for (const bad of [
      { type: 'org.updated', orgId: 'org-a' },
      { type: 'org.updated', orgId: '../x', name: 'A' },
      { type: 'org.closed', orgId: 'org-a', closedAt: 'dün', purgeAfter: new Date().toISOString(), version: 2 },
      { type: 'org.reopened', orgId: 'org-a' },
      { type: 'subscription.updated', orgId: 'org-a', product: 'deciship', status: 'ACTIVE', plan: 'pro', limits: [1] },
    ]) {
      expect((await send(bad)).res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await org()).toBeNull();
    expect(await getPrisma().processedEvent.count()).toBe(0);
  });

  it('tanınmayan tür 422 ve işaretlenmez; yinelenen teslim duplicate', async () => {
    const unknown = await send({ type: 'member.upserted', orgId: 'org-a' });
    expect(unknown.res.statusCode).toBe(422);
    expect(unknown.res.json().error.code).toBe('UNKNOWN_EVENT_TYPE');
    expect(await getPrisma().processedEvent.count()).toBe(0);

    const { token } = await account.serviceEvent({ type: 'org.updated', orgId: 'org-a', name: 'İlk', version: 3 });
    expect((await post(token)).json()).toEqual({ ok: true, outcome: 'processed' });
    await getPrisma().org.update({ where: { id: 'org-a' }, data: { name: 'Elle' } });
    expect((await post(token)).json()).toEqual({ ok: true, outcome: 'duplicate' });
    expect((await org())?.name).toBe('Elle');
  });
});

describe('firma olayları', () => {
  it('org.updated: ad ve saat dilimi; küçük sürüm stale, eşit uygulanır; geçersiz saat dilimi kayıtlı değeri bırakır; sürümsüz yalnız ilk', async () => {
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'A1' })).outcome).toBe('processed');
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'A2', timeZone: 'Europe/London', version: 4 })).outcome).toBe('processed');
    expect(await org()).toMatchObject({ name: 'A2', timeZone: 'Europe/London', version: 4 });
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'eski', version: 3 })).outcome).toBe('stale');
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'surumsuz' })).outcome).toBe('stale');
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'A3', timeZone: 'Mars/Olympus', version: 4 })).outcome).toBe('processed');
    expect(await org()).toMatchObject({ name: 'A3', timeZone: 'Europe/London', version: 4 });
  });

  it('org.closed / org.reopened: eşit ya da küçük sürüm uygulanmaz; G3 kapalı firmayı görür', async () => {
    const closedAt = new Date('2026-11-01T10:00:00Z').toISOString();
    const purgeAfter = new Date('2026-12-01T10:00:00Z').toISOString();
    expect((await send({ type: 'org.closed', orgId: 'org-a', closedAt, purgeAfter, version: 5 })).outcome).toBe('processed');
    expect((await org())?.closedAt?.toISOString()).toBe(closedAt);
    expect((await orgUsage(getPrisma(), 'org-a', 'deciship', new Date())).closed).toBe(true);
    expect((await send({ type: 'org.reopened', orgId: 'org-a', version: 5 })).outcome).toBe('stale');
    expect((await send({ type: 'org.reopened', orgId: 'org-a', version: 6 })).outcome).toBe('processed');
    expect((await org())?.closedAt).toBeNull();
    expect((await send({ type: 'org.closed', orgId: 'org-a', closedAt, purgeAfter, version: 4 })).outcome).toBe('stale');
    expect(await org()).toMatchObject({ closedAt: null, stateVersion: 6 });
    // Ad sürümü ayrı sayaçtır (ürün alıcısında `nameVersion` / `closedVersion` gibi).
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'A', version: 2 })).outcome).toBe('processed');
  });

  it('subscription.updated: firma × araç tavanı (sayı, false, yok); limits alanı yoksa dokunulmaz; küçük sürüm stale; geçitsiz ürün yazılmaz', async () => {
    const sub = (v: number, limits?: Record<string, unknown>, product = 'deciship') => ({
      type: 'subscription.updated',
      orgId: 'org-a',
      product,
      status: 'ACTIVE',
      plan: 'pro',
      version: v,
      ...(limits ? { limits } : {}),
    });
    const cap = async () => (await getPrisma().orgProductCap.findUnique({ where: { orgId_product: { orgId: 'org-a', product: 'deciship' } } }))?.capMicroUsd;
    expect((await send(sub(1, { aiSpendCapMonthlyUsd: 7.5 }))).outcome).toBe('processed');
    expect(await cap()).toBe(7_500_000n);
    expect((await orgUsage(getPrisma(), 'org-a', 'deciship', new Date())).tool.cap).toBe(7_500_000);
    expect((await send(sub(2))).outcome).toBe('processed');
    expect(await cap()).toBe(7_500_000n);
    expect((await send(sub(3, { aiSpendCapMonthlyUsd: false }))).outcome).toBe('processed');
    expect(await cap()).toBe(0n);
    expect((await send(sub(2, { aiSpendCapMonthlyUsd: 99 }))).outcome).toBe('stale');
    expect((await send(sub(4, { aiCreditMonthly: 2500 }))).outcome).toBe('processed');
    expect(await cap()).toBeNull();
    // Kayıttaki varsayılan (15 $) geçerli.
    expect((await orgUsage(getPrisma(), 'org-a', 'deciship', new Date())).tool.cap).toBe(15_000_000);
    expect((await send(sub(1, { aiSpendCapMonthlyUsd: 1 }, 'orderloom'))).outcome).toBe('processed');
    expect(await getPrisma().orgProductCap.count()).toBe(1);
  });
});

describe('kalıcı silme (org.purged)', () => {
  it('ayrıntılı satır kalmaz, günlük özet kalır (ad ve kişi yok); sonraki olay firmayı kurmaz; artık satır özete eklenir', async () => {
    // Bugün (bakım turunun özet penceresinde): silmeden önce özet yazılır, silme onu ikiye katlamamalı.
    const day = thisMonth(31, 0, 5);
    await seedCalls([
      { orgId: 'org-a', startedAt: day, costMicroUsd: 10_000, memberId: 'mem-1' },
      { orgId: 'org-a', startedAt: day, costMicroUsd: 20_000, memberId: 'mem-2' },
      { orgId: 'org-a', startedAt: day, status: 'failed', costMicroUsd: 0 },
      { orgId: 'org-b', startedAt: day, costMicroUsd: 5_000 },
    ]);
    const [pendingId] = await seedCalls([{ orgId: 'org-a', startedAt: day, status: 'pending' }]);
    await send({ type: 'org.updated', orgId: 'org-a', name: 'Silinecek Firma', version: 1 });
    await send({
      type: 'subscription.updated',
      orgId: 'org-a',
      product: 'deciship',
      status: 'ACTIVE',
      plan: 'pro',
      version: 1,
      limits: { aiSpendCapMonthlyUsd: 3 },
    });
    await getPrisma().org.update({ where: { id: 'org-a' }, data: { capOverrideMicroUsd: 1n, capOverriddenBy: 'Yönetici Adı', capOverriddenAt: new Date() } });
    // Bakım turu silmeden önce özet yazmış olsun: silme bunu ikiye katlamamalı.
    await runMaintenance(getPrisma());

    expect((await send({ type: 'org.purged', orgId: 'org-a' })).outcome).toBe('processed');
    const prisma = getPrisma();
    expect(await prisma.aiCall.findMany({ where: { orgId: 'org-a' }, select: { id: true } })).toEqual([{ id: pendingId }]);
    expect(await prisma.aiCall.count({ where: { orgId: 'org-b' } })).toBe(1);
    const daily = await prisma.aiSpendDaily.findMany({ where: { orgId: 'org-a' }, orderBy: { status: 'asc' } });
    expect(daily.map((d) => [d.status, d.calls, Number(d.costMicroUsd)])).toEqual([
      ['failed', 1, 0],
      ['ok', 2, 30_000],
    ]);
    expect(Object.keys(daily[0]!)).not.toContain('memberId');
    expect(await org()).toMatchObject({ name: null, capOverrideMicroUsd: null, capOverriddenBy: null });
    expect((await org())?.purgedAt).not.toBeNull();
    expect(await prisma.orgProductCap.count({ where: { orgId: 'org-a' } })).toBe(0);
    expect((await orgUsage(prisma, 'org-a', 'deciship', new Date())).closed).toBe(true);

    // Gecikmiş olaylar firmayı yeniden kurmaz.
    expect((await send({ type: 'org.updated', orgId: 'org-a', name: 'Geri', version: 9 })).outcome).toBe('stale');
    expect((await send({ type: 'org.reopened', orgId: 'org-a', version: 9 })).outcome).toBe('stale');
    expect((await send({ type: 'subscription.updated', orgId: 'org-a', product: 'deciship', status: 'ACTIVE', plan: 'pro', version: 9 })).outcome).toBe(
      'stale',
    );
    expect(await org()).toMatchObject({ name: null });
    expect((await org())?.purgedAt).not.toBeNull();

    // Silme anında süren çağrı sonra kapanır: bakım onu özete EKLER (ezmez) ve siler.
    const c = await superClient();
    await c.query(`UPDATE ai."AiCall" SET "status" = 'ok', "costMicroUsd" = 7000, "reservedMicroUsd" = 0 WHERE "id" = $1`, [pendingId]);
    const m = await runMaintenance(prisma);
    expect(m.sweptRows).toBe(1);
    expect(await prisma.aiCall.count({ where: { orgId: 'org-a' } })).toBe(0);
    const ok = await prisma.aiSpendDaily.findMany({ where: { orgId: 'org-a', status: 'ok' } });
    expect(ok.map((d) => [d.calls, Number(d.costMicroUsd)])).toEqual([[3, 37_000]]);
    // Tekrar gelen silme olayı zararsız: toplamlar aynı.
    expect((await send({ type: 'org.purged', orgId: 'org-a' })).outcome).toBe('processed');
    expect((await prisma.aiSpendDaily.findMany({ where: { orgId: 'org-a', status: 'ok' } })).map((d) => d.calls)).toEqual([3]);
    await runMaintenance(prisma);
    expect((await prisma.aiSpendDaily.findMany({ where: { orgId: 'org-a', status: 'ok' } })).map((d) => d.calls)).toEqual([3]);

    // Platform görünümü silinmiş firmanın günlük özetini sayar (adsız); ayrıntılı listede satırı yok.
    const op = auth(await account.access({ op: true }));
    const s = (await app.inject({ method: 'GET', url: '/api/ai/spend/summary?scope=platform', headers: op })).json() as HubAnalytics;
    const kpis = s.sections[0]!.widgets[0]!;
    expect(kpis.kind === 'kpis' && kpis.items.find((k) => k.id === 'spend')?.value).toBe(4.2);
    const byOrg = s.sections.flatMap((x) => x.widgets).find((w) => w.id === 'by_org');
    expect(byOrg?.kind === 'breakdown' && byOrg.items.find((i) => i.key === 'org-a')).toMatchObject({ label: '', value: 3.7 });
    const calls = (await app.inject({ method: 'GET', url: '/api/ai/spend/calls?scope=platform&org=org-a', headers: op })).json();
    expect(calls.total).toBe(0);
    const filtered = (await app.inject({ method: 'GET', url: '/api/ai/spend/summary?scope=platform&org=org-a', headers: op })).json() as HubAnalytics;
    const fk = filtered.sections[0]!.widgets[0]!;
    expect(fk.kind === 'kpis' && fk.items.find((k) => k.id === 'calls')?.value).toBe(4);
  });
});
