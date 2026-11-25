/**
 * Mesaj 5 (Y15, 08-B10): "Son hesap" anı (`Invoice.calculatedAt`) yalnız hesap motoru koşunca ilerler.
 *
 *  - Yazar: yeniden karşılaştırma (`applyRecompare`; önizlemeli onay, servis çağrısı, başlıkta hesabı değiştiren alan).
 *  - Yazmaz: karar, not (yazma ve silme: karşılaştırma notu geri gelse de), "Kontrol ettim", fatura no, yalnız toplam yazan
 *    `refreshTotals`.
 *  - `GET /invoices/:id` `basis.calculatedAt` sütundan; sütun boşsa `updatedAt`.
 *  - Satır yanıtında ölçümün tartı yöntemi ve fotoğraf sayısı; toplamlarda fazla ödemenin açıklaması (fiyat izni olmayana gitmez).
 *
 * Oluşturmada (`POST /invoices`) damgayı rota yazar (P2); burada her sınama damgayı bilinen bir geçmiş ana kurar.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { stripMoney } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { recompareInvoice, refreshTotals, type InvoiceTotals } from '../src/services/compare.ts';
import { serializeImportReport } from '../src/services/invoiceSerialize.ts';
import { API, disputeCompany, invoiceWithDiffs, type DisputeCompany } from './disputeHelpers.ts';
import { findMoneyKeys, getApp, inCompany } from './helpers.ts';
import { patchInvoice, recalculate } from './recalcHelpers.ts';

type Auth = { authorization: string };

const PAST = new Date('2026-01-02T03:04:05.000Z');

const row = (c: DisputeCompany, id: string) => inCompany(c.admin.auth, () => prisma.invoice.findFirstOrThrow({ where: { id } }));
/** Damgayı bilinen geçmiş ana kurar (yazan yolu ayırt etmek için). */
const stamp = (c: DisputeCompany, id: string, at: Date | null = PAST) =>
  inCompany(c.admin.auth, () => prisma.invoice.update({ where: { id }, data: { calculatedAt: at } }));
const calcAt = async (c: DisputeCompany, id: string) => (await row(c, id)).calculatedAt?.toISOString() ?? null;

async function patchLine(app: FastifyInstance, auth: Auth, lineId: string, payload: Record<string, unknown>) {
  const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: auth, payload });
  expect(r.statusCode, r.body).toBe(200);
}

async function detail(app: FastifyInstance, auth: Auth, id: string) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${id}`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().invoice;
}

describe('calculatedAt: yalnız motor koşunca ilerler', () => {
  it('karar, not, not silme, "Kontrol ettim", fatura no ve yalnız toplam yazan yol damgayı ilerletmez', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const { invoiceId, lines } = await invoiceWithDiffs(app, c, [50, 60], { verify: 0 });
    await stamp(c, invoiceId);
    const before = await row(c, invoiceId);
    const [a, b] = lines;

    await patchLine(app, c.admin.auth, a!.id, { decision: 'VERIFIED' });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    await patchLine(app, c.admin.auth, b!.id, { decision: 'ACCEPTED', reason: 'Taşıyıcıyla anlaşıldı' });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    await patchLine(app, c.admin.auth, b!.id, { decision: 'OPEN' });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    // elle not ve silinmesi (karşılaştırma notu geri gelir: `restoreComparisonNote`)
    await patchLine(app, c.admin.auth, a!.id, { note: 'Kargoya soruldu' });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    await patchLine(app, c.admin.auth, a!.id, { note: '' });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    await patchLine(app, c.admin.auth, b!.id, { parseChecked: true });
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    // başlıkta hesabı değiştirmeyen alan
    const p = await patchInvoice(app, c.admin.auth, invoiceId, { invoiceNo: `${before.invoiceNo}-D` });
    expect(p.statusCode, p.body).toBe(200);
    expect(await calcAt(c, invoiceId)).toBe(PAST.toISOString());
    // yalnız toplam yazan yol
    await inCompany(c.admin.auth, () => refreshTotals(invoiceId));
    const after = await row(c, invoiceId);
    expect(after.calculatedAt?.toISOString()).toBe(PAST.toISOString());
    // fatura bu arada yazıldı (toplam, başlık): "son değişme" ilerledi, "son hesap" ilerlemedi
    expect(+after.updatedAt).toBeGreaterThan(+before.updatedAt);
    expect((await detail(app, c.admin.auth, invoiceId)).basis.calculatedAt).toBe(PAST.toISOString());
  });

  it('yeniden karşılaştırma (önizlemeli onay, servis, hesabı değiştiren başlık alanı) damgayı toplamla aynı işlemde yazar', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const { invoiceId } = await invoiceWithDiffs(app, c, [50], { verify: 0 });

    const inWindow = async (run: () => Promise<unknown>) => {
      await stamp(c, invoiceId);
      const t0 = Date.now();
      await run();
      const r = await row(c, invoiceId);
      expect(r.calculatedAt, 'calculatedAt').not.toBeNull();
      expect(+r.calculatedAt!).toBeGreaterThanOrEqual(t0 - 1000);
      expect(+r.calculatedAt!).toBeLessThanOrEqual(Date.now() + 1000);
      // aynı yazımın toplamı (refreshTotals ile aynı update): damga toplamdan sonra ayrıca yazılmadı
      expect(+r.updatedAt).toBeGreaterThanOrEqual(+r.calculatedAt!);
      expect((await detail(app, c.admin.auth, invoiceId)).basis.calculatedAt).toBe(r.calculatedAt!.toISOString());
    };

    // hiçbir satır değişmese de motor koştu
    await inWindow(() => recalculate(app, c.admin.auth, invoiceId, { basis: 'pinned' }));
    await inWindow(() => inCompany(c.admin.auth, () => recompareInvoice(invoiceId)));
    await inWindow(async () => {
      const r = await patchInvoice(app, c.admin.auth, invoiceId, { invoiceDate: '2026-10-01' });
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  it('sütun boşsa basis.calculatedAt = updatedAt (eski satır için düşüş yolu)', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const { invoiceId } = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    await stamp(c, invoiceId, null);
    const r = await row(c, invoiceId);
    expect(r.calculatedAt).toBeNull();
    expect((await detail(app, c.admin.auth, invoiceId)).basis.calculatedAt).toBe(r.updatedAt.toISOString());
  });
});

describe('satır ve toplam yanıtı: Mesaj 5 alanları', () => {
  it('satır ölçümü tartı yöntemini ve fotoğraf sayısını taşır', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const { invoiceId } = await invoiceWithDiffs(app, c, [50], { verify: 0 });
    const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: c.admin.auth });
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json().items[0].measurement;
    // measurementPayload: elle ölçü, elle ağırlık, 1 fotoğraf
    expect(m).toMatchObject({ dimMethod: 'MANUAL', weightMethod: 'MANUAL', photoCount: 1 });
    expect(m.photos).toHaveLength(1);
  });

  it('toplamlarda açıklama: adımlar = fazla ödeme = türlere göre; fiyat izni olmayana toplamlar hiç gitmez', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const { invoiceId } = await invoiceWithDiffs(app, c, [50, 60.55], { verify: 1 });
    // açıklama her toplam yazan yolda: karar (refreshTotals) sonrası kayıtlı toplam
    const t = (await row(c, invoiceId)).totals as InvoiceTotals;
    const kr = (n: number) => Math.round(n * 100);
    expect(t.overchargeTotal).toBeGreaterThan(0);
    expect(t.reconciliation!.steps.reduce((a, s) => a + kr(s.amount), 0)).toBe(kr(t.overchargeTotal));
    expect(kr(t.reconciliation!.overchargeTotal)).toBe(kr(t.overchargeTotal));
    expect(t.overchargeByType!.reduce((a, s) => a + kr(s.amount), 0)).toBe(kr(t.overchargeTotal));
    const priced = await detail(app, c.admin.auth, invoiceId);
    expect(priced.totals.reconciliation).toEqual(t.reconciliation);
    expect(priced.totals.overchargeByType).toEqual(t.overchargeByType);

    // fiyat izni olmayan: son güvence (app.ts `stripMoney`) toplamları bütünüyle siler, açıklama da gider
    const bare = stripMoney({ invoice: priced }) as { invoice: Record<string, unknown> };
    expect(bare.invoice.totals).toBeUndefined();
    expect(findMoneyKeys(bare.invoice.basis)).toEqual([]);
    expect(JSON.stringify(bare)).not.toMatch(/reconciliation|overchargeByType/);
  });
});

describe('serializeImportReport', () => {
  const reqWith = (permissions: string[]) => ({ auth: { permissions } }) as unknown as FastifyRequest;
  const report = {
    version: 1,
    source: 'table',
    rowsInFile: 5,
    linesImported: 2,
    skippedCount: 3,
    byReason: { BAD_TRACKING: 1, BAD_NET: 1, NO_TRACKING: 1 },
    skippedRows: [
      { row: 2, reason: 'BAD_TRACKING', trackingRaw: '??', rawNet: '12,50' },
      { row: 3, reason: 'BAD_NET', trackingRaw: '7948', rawNet: 'abc' },
      { row: 4, reason: 'NO_TRACKING', amount: 45 },
    ],
    noTrackingAmount: 45,
  };

  it('eski fatura (null) ve tanınmayan sürüm: null', () => {
    expect(serializeImportReport(null, null)).toBeNull();
    expect(serializeImportReport({ version: 2 }, null)).toBeNull();
    expect(serializeImportReport([], null)).toBeNull();
  });

  it('fiyat izni olan ve rapor (req yok): olduğu gibi; olmayan: tutarlar yazılmaz, sayılar ve nedenler gider', () => {
    expect(serializeImportReport(report, null)).toEqual(report);
    expect(serializeImportReport(report, reqWith(['deciship.invoices.view', 'deciship.prices.view']))).toEqual(report);
    const bare = serializeImportReport(report, reqWith(['deciship.invoices.view']))!;
    // `byReason.BAD_NET` bir sayıdır (neden adı): kalır; tutar alanları yok
    expect(findMoneyKeys(bare).filter((k) => k !== '$.byReason.BAD_NET')).toEqual([]);
    expect(bare).toMatchObject({ rowsInFile: 5, linesImported: 2, skippedCount: 3, byReason: report.byReason });
    expect(bare.skippedRows).toEqual([
      { row: 2, reason: 'BAD_TRACKING', trackingRaw: '??' },
      { row: 3, reason: 'BAD_NET', trackingRaw: '7948' },
      { row: 4, reason: 'NO_TRACKING' },
    ]);
  });

  it('son güvence (stripMoney) nedene göre sayıyı silmez, tutarı siler', () => {
    const out = stripMoney({ importReport: report }) as { importReport: Record<string, unknown> };
    expect(out.importReport.byReason).toEqual(report.byReason);
    expect(out.importReport.noTrackingAmount).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/"amount"|"rawNet"/);
  });
});
