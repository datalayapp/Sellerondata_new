/**
 * Büyük faturada veri erişimi: yeniden karşılaştırma toplu yazılır (satır başına sorgu yok) ve sonuçları
 * aynı dosyanın sıfırdan içe aktarılmasıyla birebir aynıdır. Sorgu sayısı satır sayısından bağımsızdır.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import ExcelJS from 'exceljs';
import { lineInclude, serializeLine } from '../src/services/invoiceSerialize.ts';
import { buildReportXlsx } from '../src/services/reports.ts';
import { applyRecalc, previewRecalc } from './recalcHelpers.ts';
import { getApp, inCompany, measurementPayload, multipart, seedIdentity } from './helpers.ts';
import { bigCsv } from '../../../packages/core/test/fixtures/robustness/build.ts';

const pg = createRequire(import.meta.url)('pg') as { Client: { prototype: { query: (...a: unknown[]) => unknown } } };
let queries = 0;
const origQuery = pg.Client.prototype.query;

const N = 3000;
const RESULT_KEYS = ['rowIndex', 'trackingNo', 'status', 'diffTypes', 'ourChargeableKg', 'billedChargeableKg', 'expectedAmount', 'diffAmount', 'breakdown', 'note', 'measurementId', 'tariffId'] as const;

describe('büyük fatura: toplu karşılaştırma yazımı', () => {
  let auth: { authorization: string };
  let fedex = '';

  beforeAll(async () => {
    pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
      // RLS bağlamının denetim ifadeleri (BEGIN, set_config, COMMIT) iş sorgusu değil; satır sayısıyla da büyümez.
      const text = String((args[0] as { text?: string } | string | undefined) && ((args[0] as { text?: string }).text ?? args[0]));
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(text)) queries++;
      return origQuery.apply(this, args);
    };
    const app = await getApp();
    await seed({ reset: true, samples: true, log: () => {} });
    const admin = await seedIdentity('ADMIN');
    auth = admin.auth;
    fedex = (await app.inject({ method: 'GET', url: '/api/deciship/carriers', headers: auth })).json().items.find((c: { code: string }) => c.code === 'fedex').id;
    // satırların yarısına ölçüm; her 7.'sinde uzunluk farklı (boyut farkı)
    const company = { id: admin.companyId };
    const data = Array.from({ length: N / 2 }, (_, i) => {
      const idx = i * 2;
      const t = `7951${String(idx).padStart(8, '0')}`;
      return {
        companyId: company.id,
        clientId: `perf-${idx}`,
        trackingRaw: t,
        trackingNo: t,
        lengthCm: 20 + (idx % 40) + (i % 7 === 0 ? 10 : 0),
        widthCm: 15 + (idx % 30),
        heightCm: 10 + (idx % 20),
        weightKg: 1 + (i % 20),
        dimMethod: 'MANUAL' as const,
        weightMethod: 'MANUAL' as const,
        measuredById: admin.userId,
        measuredAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 10)),
      };
    });
    await withCompany(company.id, () => prisma.measurement.createMany({ data }));
  });

  afterAll(() => {
    pg.Client.prototype.query = origQuery;
  });

  async function importBig(invoiceNo: string) {
    const app = await getApp();
    const form = multipart([
      { name: 'carrierId', value: fedex },
      { name: 'file', filename: 'fedex-buyuk.csv', contentType: 'text/csv', data: Buffer.from(bigCsv(N)) },
    ]);
    const p = (await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload })).json();
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.fileId, carrierId: fedex, invoiceNo, invoiceDate: '2026-10-31', currency: 'TRY', mapping: p.suggestedMapping, acknowledgeIssues: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().invoice as { id: string; totals: Record<string, number> };
  }

  async function lines(id: string) {
    const app = await getApp();
    const out: Record<string, unknown>[] = [];
    for (let page = 1; out.length < N; page++) {
      const r = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?pageSize=1000&page=${page}`, headers: auth })).json();
      out.push(...r.items);
      if (!r.items.length) break;
    }
    return out.map((l) => Object.fromEntries(RESULT_KEYS.map((k) => [k, l[k]])));
  }

  it('yeniden karşılaştırma büyük faturada çalışır, sonuç sıfırdan içe aktarmayla aynıdır, sorgu sayısı sabit', async () => {
    const app = await getApp();
    const first = await importBig('PERF-1');
    const imported = await lines(first.id);
    expect(imported).toHaveLength(N);
    expect(new Set(imported.map((l) => l.status)).size).toBeGreaterThan(1);

    // değişiklik yokken yeniden karşılaştırma aynı sonucu verir
    let q0 = queries;
    const same = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${first.id}/recompare`, headers: auth });
    expect(same.statusCode, same.body).toBe(200);
    expect(queries - q0).toBeLessThan(40);
    expect(await lines(first.id)).toEqual(imported);
    expect(same.json().invoice.totals).toEqual(first.totals);

    // toleranslar değişince tüm satırlar toplu yazılır (eskiden 5 sn işlem süresini aşıp 500 dönüyordu)
    await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { edgeTolCm: 0, weightTolKg: 0, amountTol: 0 } });
// KARARLAR "Geçmiş sonuçlar donar" (2026-11-10): ayar/tarife değişince fatura eski dayanağıyla kalır; yeni dayanağa recalculate ile geçilir.
    q0 = queries;
    // iki adım (önizleme + onay): toplam sorgu sayısı satır sayısından (3000) bağımsız. Y11: iki istek birlikte yine eski tek
    // adımlı sınırın (40) altında (sadeleştirmeden önce ~70; geçici gevşek sınır 120 idi, sıkılaştırıldı)
    const prev = await previewRecalc(app, auth, first.id, { basis: 'rules' });
    expect(prev.statusCode, prev.body).toBe(200);
    const applied = await applyRecalc(app, auth, first.id, { basis: 'rules', token: prev.json().token });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(queries - q0).toBeLessThan(40);
    const changed = { invoice: applied.json().invoice };
    const recompared = await lines(first.id);
    expect(recompared).not.toEqual(imported);

    // aynı dosya aynı ayarlarla sıfırdan: satır sonuçları ve toplamlar birebir aynı
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${first.id}`, headers: auth })).statusCode).toBe(204);
    const fresh = await importBig('PERF-2');
    expect(await lines(fresh.id)).toEqual(recompared);
    expect(fresh.totals).toEqual(changed.invoice.totals);
  }, 180_000);

  it('elle eşleme (sabitleme) satır sayısı kadar sorgu atmaz', async () => {
    const app = await getApp();
    const inv = (await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth })).json().items[0];
    const unmatched = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?status=UNMATCHED&pageSize=12`, headers: auth })).json().items;
    const ms = (await app.inject({ method: 'GET', url: '/api/deciship/measurements?pageSize=12', headers: auth })).json().items;
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      const q0 = queries;
      const r = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${unmatched[i].id}`, headers: auth, payload: { measurementId: ms[i].id } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().line.measurementPinned).toBe(true);
      counts.push(queries - q0);
    }
    // 1 ve 12 sabitlenmiş satırda aynı sayıda sorgu (sürüm zinciri toplu çözülür)
    expect(counts[11]).toBe(counts[0]);
    expect(counts[0]).toBeLessThan(45);
  }, 180_000);

  it("ölçüm takip no'nun son 10 hanesiyle gelince ilgili fatura indeksli aramayla bulunup yeniden karşılaştırılır", async () => {
    const app = await getApp();
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'InvoiceLine_companyId_trackingSuffix_idx'`;
    expect(idx[0]?.indexdef).toContain('"right"');
    const inv = (await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth })).json().items[0];
    const line = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?status=UNMATCHED&pageSize=1`, headers: auth })).json().items[0];
    expect(line.trackingNo).toHaveLength(12);
    // ölçümde yalnız son 10 hane var: tam eşitlik yok, "sonu şununla biten" eşleşmesi gerekir
    const m = measurementPayload({ trackingRaw: line.trackingNo.slice(-10) }, 1);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...m.headers }, payload: m.payload });
    expect(created.statusCode, created.body).toBe(201);
    const after = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?q=${line.trackingNo}`, headers: auth })).json().items[0];
    expect(after.status).not.toBe('UNMATCHED');
    expect(after.measurement.id).toBe(created.json().measurement.id);
  }, 180_000);

  it('Excel raporu akışlı yazıcıyla bellekteki çalışma kitabıyla aynı hücre değerlerini ve biçimlerini üretir', async () => {
    const inv = await inCompany(auth, () => prisma.invoice.findFirstOrThrow({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }));
    const rows = await inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId: inv.id }, include: lineInclude, orderBy: { rowIndex: 'asc' } }));
    const lines = rows.map((l) => serializeLine(l, null));
    lines[0] = { ...lines[0]!, decisionReason: 'deneme', note: 'not' };
    const input = {
      companyName: 'Demo',
      carrierName: 'FedEx',
      tariffSummary: 'FedEx IP 2025',
      invoiceNo: inv.invoiceNo,
      invoiceDate: '2026-10-31',
      periodFrom: '2026-10-01',
      periodTo: null,
      currency: 'TRY',
      totals: { ...(inv.totals as Record<string, number>), uncheckedSurchargeTotal: 12.5 } as never,
      lines,
    };
    const dump = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as never);
      const out: unknown[] = [wb.creator];
      wb.eachSheet((ws) => {
        out.push(ws.name, ws.rowCount, ws.views, ws.autoFilter, ws.columns?.map((c) => [c.width, c.numFmt ?? null]));
        ws.eachRow({ includeEmpty: true }, (row, r) =>
          row.eachCell((c, col) => out.push([r, col, c.value, c.numFmt ?? null, c.font ?? null, c.fill ?? null, c.alignment ?? null, c.border ?? null])),
        );
      });
      return out;
    };
    const streamed = await dump(await buildReportXlsx(input));
    const inMemory = await dump(await buildReportXlsx(input, { inMemory: true }));
    expect(streamed.length).toBeGreaterThan(rows.length * 10);
    expect(streamed).toEqual(inMemory);
  }, 180_000);
});
