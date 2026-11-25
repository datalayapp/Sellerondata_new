import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { retentionCutoff, runMaintenance } from '../src/maintenance/index.ts';
import { closeSuper, superClient } from './helpers.ts';
import { resetG4, seedCalls } from './g4Helpers.ts';

/**
 * Bakım turu (G4): günlük özet (yeniden hesap, tekrarında aynı), `pending` dışarıda, saklama süresi (24 ay; özete yazılıp silinir),
 * eski olay kimlikleri.
 */

afterAll(async () => {
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetG4);

const prisma = () => getPrisma();
const daily = () => prisma().aiSpendDaily.findMany({ orderBy: [{ day: 'asc' }, { orgId: 'asc' }, { status: 'asc' }] });
const brief = (rows: Awaited<ReturnType<typeof daily>>) =>
  rows.map((d) => [d.day.toISOString().slice(0, 10), d.orgId, d.product, d.model, d.status, d.calls, Number(d.costMicroUsd)]);

describe('günlük özet', () => {
  it('son günler yeniden hesaplanır; tekrar koşu aynı sonucu verir; pending girmez, kapanınca girer', async () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const [pending] = await seedCalls([{ orgId: 'org-a', startedAt: new Date('2026-11-20T08:00:00Z'), status: 'pending' }]);
    await seedCalls([
      { orgId: 'org-a', startedAt: new Date('2026-11-20T09:00:00Z'), costMicroUsd: 10_000 },
      { orgId: 'org-a', startedAt: new Date('2026-11-20T09:30:00Z'), costMicroUsd: 5_000, servedModel: 'claude-sonnet-5', model: 'claude-sonnet-5-5' },
      { orgId: 'org-b', startedAt: new Date('2026-11-18T23:59:00Z'), costMicroUsd: 1_000, status: 'failed' },
      // Pencere dışı (3 günden eski): bu tur yazmaz.
      { orgId: 'org-a', startedAt: new Date('2026-11-10T10:00:00Z'), costMicroUsd: 2_000 },
    ]);
    await runMaintenance(prisma(), { now });
    const first = brief(await daily());
    expect(first).toEqual(
      [
        ['2026-11-18', 'org-b', 'deciship', 'claude-sonnet-5-5', 'failed', 1, 1_000],
        ['2026-11-20', 'org-a', 'deciship', 'claude-sonnet-5', 'ok', 1, 5_000],
        ['2026-11-20', 'org-a', 'deciship', 'claude-sonnet-5-5', 'ok', 1, 10_000],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[4]).localeCompare(String(b[4]))),
    );
    await runMaintenance(prisma(), { now });
    expect(brief(await daily())).toEqual(first);

    const c = await superClient();
    await c.query(`UPDATE ai."AiCall" SET "status" = 'ok', "costMicroUsd" = 3000, "reservedMicroUsd" = 0, "servedModel" = "requestedModel" WHERE "id" = $1`, [
      pending,
    ]);
    await runMaintenance(prisma(), { now });
    const row = (await daily()).find((d) => d.orgId === 'org-a' && d.model === 'claude-sonnet-5-5');
    expect([row?.calls, Number(row?.costMicroUsd)]).toEqual([2, 13_000]);
  });
});

describe('saklama süresi', () => {
  it('24 aydan eski ayrıntılı satır özete yazılır ve silinir; yenisi kalır', async () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const cutoff = retentionCutoff(now);
    expect(cutoff.toISOString()).toBe('2024-11-20T00:00:00.000Z');
    await seedCalls([
      { orgId: 'org-a', startedAt: new Date('2024-11-19T23:00:00Z'), costMicroUsd: 4_000, memberId: 'mem-1' },
      { orgId: 'org-a', startedAt: new Date('2024-11-19T01:00:00Z'), costMicroUsd: 6_000, memberId: 'mem-2' },
      { orgId: 'org-a', startedAt: new Date('2024-11-20T00:00:00Z'), costMicroUsd: 1_000 },
    ]);
    const r = await runMaintenance(prisma(), { now });
    expect(r.expiredRows).toBe(2);
    const left = await prisma().aiCall.findMany({ select: { startedAt: true } });
    expect(left.map((x) => x.startedAt.toISOString())).toEqual(['2024-11-20T00:00:00.000Z']);
    expect(brief(await daily())).toEqual([['2024-11-19', 'org-a', 'deciship', 'claude-sonnet-5-5', 'ok', 2, 10_000]]);
    // Tekrar koşu özeti bozmaz.
    await runMaintenance(prisma(), { now });
    expect(brief(await daily())).toEqual([['2024-11-19', 'org-a', 'deciship', 'claude-sonnet-5-5', 'ok', 2, 10_000]]);
  });
});

describe('olay kimlikleri', () => {
  it('30 günden eski işlenmiş olay kimliği silinir', async () => {
    const now = new Date();
    await prisma().processedEvent.createMany({
      data: [
        { eventId: 'eski', processedAt: new Date(now.getTime() - 31 * 86_400_000) },
        { eventId: 'yeni', processedAt: new Date(now.getTime() - 29 * 86_400_000) },
      ],
    });
    const r = await runMaintenance(prisma(), { now });
    expect(r.expiredEvents).toBe(1);
    expect((await prisma().processedEvent.findMany()).map((e) => e.eventId)).toEqual(['yeni']);
  });
});
