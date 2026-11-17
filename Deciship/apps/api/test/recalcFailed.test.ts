/**
 * K37 (Y26, kullanıcı kararı 2026-11-13): arka plandaki yeniden hesap 5 kez üst üste düşüp taramadan çıkınca fatura bunu
 * gösterir (`invoice.recalcFailed`), Merkez bekleyenlerinde de çıkar; elle "Yeniden karşılaştır" işareti temizler.
 * Düşen denemeler doğrudan yazılır (deneme sayacı ve geri çekilme `measurementQueueBatch`, `invoiceRecheck` testlerinde).
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { RECOMPARE_MAX_ATTEMPTS } from '../src/services/maintenance.ts';
import { caller, disputeCompany, invoiceWithDiffs } from './disputeHelpers.ts';
import { getApp, inCompany } from './helpers.ts';

let app: FastifyInstance;
let call: ReturnType<typeof caller>;
beforeAll(async () => {
  app = await getApp();
  call = caller(app);
});

type Auth = { authorization: string };
const detail = async (auth: Auth, id: string) => {
  const r = await call(auth, 'GET', `/invoices/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().invoice as { recalcFailed?: boolean };
};
const alertsOf = async (auth: Auth) => {
  const r = await call(auth, 'GET', '/platform/overview');
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().alerts as { id: string; href?: string }[]).filter((a) => a.id === 'recalc-failed');
};

describe('K37: yeniden hesap 5 kez düştü', () => {
  it('ölçümün işareti bitince ölçümün faturası uyarır; Yeniden karşılaştır temizler, ölçümün sayacı baştan başlar', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    const other = await invoiceWithDiffs(app, c, [60], { verify: 0 });
    expect(await detail(c.admin.auth, inv.invoiceId)).not.toHaveProperty('recalcFailed');
    expect(await alertsOf(c.admin.auth)).toEqual([]);

    const measurementId = await inCompany(c.admin.auth, async () => {
      const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv.invoiceId }, select: { measurementId: true } });
      const pendingAt = new Date(Date.now() - 3_600_000);
      // taramada hakkı bitmemiş işaret uyarmaz
      await prisma.measurement.update({ where: { id: line.measurementId! }, data: { recomparePendingAt: pendingAt, recompareAttempts: RECOMPARE_MAX_ATTEMPTS - 1 } });
      return line.measurementId!;
    });
    expect(await detail(c.admin.auth, inv.invoiceId)).not.toHaveProperty('recalcFailed');

    await inCompany(c.admin.auth, () => prisma.measurement.update({ where: { id: measurementId }, data: { recompareAttempts: RECOMPARE_MAX_ATTEMPTS } }));
    expect((await detail(c.admin.auth, inv.invoiceId)).recalcFailed).toBe(true);
    // ölçümün dokunmadığı fatura uyarmaz
    expect(await detail(c.admin.auth, other.invoiceId)).not.toHaveProperty('recalcFailed');
    const alerts = await alertsOf(c.admin.auth);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.href).toContain(inv.invoiceId);

    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/recompare`);
    expect(r.statusCode, r.body).toBe(200);
    expect(await detail(c.admin.auth, inv.invoiceId)).not.toHaveProperty('recalcFailed');
    expect(await alertsOf(c.admin.auth)).toEqual([]);
    const m = await inCompany(c.admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: measurementId }, select: { recomparePendingAt: true, recompareAttempts: true } }));
    // işaret kalır (öbür faturalar için), sayaç sıfırlanır: tarama baştan dener
    expect(m.recomparePendingAt).not.toBeNull();
    expect(m.recompareAttempts).toBe(0);
  });

  it('faturanın "Mükerrer" işareti bitince uyarır; tüm faturanın yeniden hesabı (recalculate) işareti siler', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    await inCompany(c.admin.auth, () =>
      prisma.invoiceRecheck.create({ data: { invoiceId: inv.invoiceId, companyId: c.admin.companyId, pendingAt: new Date(Date.now() - 3_600_000), attempts: RECOMPARE_MAX_ATTEMPTS } }),
    );
    expect((await detail(c.admin.auth, inv.invoiceId)).recalcFailed).toBe(true);
    expect(await alertsOf(c.admin.auth)).toHaveLength(1);

    const p = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/recalculate/preview`, { basis: 'pinned' });
    expect(p.statusCode, p.body).toBe(200);
    const r = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/recalculate`, { basis: 'pinned', token: p.json().token });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().invoice).not.toHaveProperty('recalcFailed');
    expect(await inCompany(c.admin.auth, () => prisma.invoiceRecheck.count({ where: { invoiceId: inv.invoiceId } }))).toBe(0);
  });

  it('silinmiş fatura Merkez bekleyenlerinde sayılmaz', async () => {
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    await inCompany(c.admin.auth, () =>
      prisma.invoiceRecheck.create({ data: { invoiceId: inv.invoiceId, companyId: c.admin.companyId, pendingAt: new Date(Date.now() - 3_600_000), attempts: RECOMPARE_MAX_ATTEMPTS } }),
    );
    expect(await alertsOf(c.admin.auth)).toHaveLength(1);
    const del = await call(c.admin.auth, 'DELETE', `/invoices/${inv.invoiceId}`);
    expect(del.statusCode, del.body).toBe(204);
    expect(await alertsOf(c.admin.auth)).toEqual([]);
  });
});
