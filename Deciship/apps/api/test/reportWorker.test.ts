/**
 * Mesaj 6 (19-B1, 06-B2): fatura raporu (PDF ve Excel) API sürecinde değil dosya çalışanında (çocuk süreç) üretilir.
 * Denenen: çok satırlı faturanın raporu hazırlanırken API'nin olay döngüsü kilitlenmez (başka istekler yanıt alır) ve
 * çocuktan gelen rapor ana süreçte üretilenle aynıdır (PDF'te yalnız üretim anı farklı; Excel'de hücreler aynı).
 *
 * Süre sınırı sabit milisaniye değildir (makineye göre ölçeklenir): raporun kendi süresiyle karşılaştırılır. Raporu ana
 * süreçte üreten eski kodda en uzun kesinti raporun süresinin neredeyse tamamıydı.
 */
import ExcelJS from 'exceljs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { closeFileWorkers, fileWorkerStats } from '../src/lib/fileWorkers.ts';
import { seed } from '../src/seed.ts';
import { bigCsv } from '../../../packages/core/test/fixtures/robustness/build.ts';
import { getApp, multipart, seedIdentity } from './helpers.ts';

const N = 3000;
const KEYS = ['FILE_WORKER_MODE', 'REPORT_WORKER_HEAP_MB', 'REPORT_WORKER_TIMEOUT_MS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

/** PDF'te üretim anı (pdfkit `CreationDate`) her üretimde değişir; içerik karşılaştırması onsuz. */
function normalizePdf(buf: Buffer): string {
  return buf.toString('latin1').replace(/\(D:\d{14}Z\)/g, '(D:)').replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/gi, '/ID []');
}

async function xlsxCells(buf: Buffer): Promise<unknown[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const out: unknown[] = [];
  wb.eachSheet((ws) => {
    out.push(ws.name, ws.rowCount);
    ws.eachRow({ includeEmpty: true }, (row, r) => row.eachCell((c, col) => out.push([r, col, c.value instanceof Date ? 'date' : c.value, c.numFmt ?? null])));
  });
  return out;
}

describe('rapor dosya çalışanında', () => {
  let auth: { authorization: string };
  let invoiceId = '';

  beforeAll(async () => {
    const app = await getApp();
    await seed({ reset: true, samples: true, log: () => {} });
    const admin = await seedIdentity('ADMIN');
    auth = admin.auth;
    const fedex = (await app.inject({ method: 'GET', url: '/api/deciship/carriers', headers: auth })).json().items.find((c: { code: string }) => c.code === 'fedex').id;
    const form = multipart([
      { name: 'carrierId', value: fedex },
      { name: 'file', filename: 'fedex-rapor.csv', contentType: 'text/csv', data: Buffer.from(bigCsv(N)) },
    ]);
    const p = (await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload })).json();
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.fileId, carrierId: fedex, invoiceNo: 'RAPOR-1', invoiceDate: '2026-10-31', currency: 'TRY', mapping: p.suggestedMapping, acknowledgeIssues: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    invoiceId = res.json().invoice.id;
    // Bütün satırlar fark: PDF'in fark tablosu N satır (raporun en pahalı hâli).
    await withCompany(admin.companyId, () =>
      prisma.invoiceLine.updateMany({ where: { invoiceId }, data: { status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 100, diffAmount: 12.5 } }),
    );
  }, 180_000);

  afterEach(async () => {
    await closeFileWorkers();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  afterAll(() => closeFileWorkers());

  /** İsteği atar; sürerken olay döngüsünün en uzun kesintisini ve aynı anda atılan sağlık isteğinin süresini ölçer. */
  async function timedReport(kind: 'pdf' | 'xlsx') {
    const app = await getApp();
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    const report = app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/report.${kind}`, headers: auth });
    // rapor hazırlanırken (veritabanı okuması bittikten sonra) sağlık ucu
    await new Promise((r) => setTimeout(r, 300));
    const h0 = performance.now();
    const health = await app.inject({ method: 'GET', url: '/api/deciship/health' });
    const healthMs = performance.now() - h0;
    const res = await report;
    const totalMs = performance.now() - t0;
    clearInterval(tick);
    maxGap = Math.max(maxGap, performance.now() - last);
    expect(health.statusCode).toBe(200);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return { res, totalMs, maxGap, healthMs };
  }

  it('PDF raporu hazırlanırken API yanıt verir; çıktı ana süreçte üretilenle aynı', async () => {
    process.env.FILE_WORKER_MODE = 'inline';
    const inline = await timedReport('pdf');
    process.env.FILE_WORKER_MODE = 'process';
    const child = await timedReport('pdf');
    expect(child.res.headers['content-type']).toBe('application/pdf');
    expect(normalizePdf(child.res.rawPayload)).toBe(normalizePdf(inline.res.rawPayload));
    // Ana süreçte üretim olay döngüsünü raporun neredeyse tamamı boyunca tutar (bu ölçümün kendisi bunu gösterir);
    // çocukta en uzun kesinti raporun süresinin küçük bir parçasıdır ve sağlık isteği rapor bitmeden döner.
    expect(inline.maxGap).toBeGreaterThan(inline.totalMs / 4);
    expect(child.maxGap, JSON.stringify({ child: { gap: child.maxGap, total: child.totalMs }, inline: { gap: inline.maxGap, total: inline.totalMs } })).toBeLessThan(child.totalMs / 4);
    expect(child.healthMs).toBeLessThan(child.totalMs / 4);
    // büyük yığınlı rapor çocuğu iş bitince kapanır: sonraki dosya okumaları olağan yığınla çalışır
    expect(fileWorkerStats().busy).toBe(0);
  }, 180_000);

  it('Excel raporu çocukta üretilir; hücreler ana süreçte üretilenle aynı', async () => {
    process.env.FILE_WORKER_MODE = 'inline';
    const inline = await timedReport('xlsx');
    process.env.FILE_WORKER_MODE = 'process';
    const child = await timedReport('xlsx');
    expect(child.res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(await xlsxCells(child.res.rawPayload)).toEqual(await xlsxCells(inline.res.rawPayload));
    expect(child.maxGap, JSON.stringify({ child: { gap: child.maxGap, total: child.totalMs } })).toBeLessThan(child.totalMs / 4);
  }, 180_000);

  it('raporu bellek ya da süre sınırında düşen çocuk API süreci yerine yalnız o isteği bozar: 422 REPORT_TOO_LARGE', async () => {
    process.env.FILE_WORKER_MODE = 'process';
    // 1 ms: çocuk açılıp raporu bitiremez
    process.env.REPORT_WORKER_TIMEOUT_MS = '1';
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/report.pdf`, headers: { ...auth, 'accept-language': 'en' } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('REPORT_TOO_LARGE');
    expect(res.json().error.message).toMatch(/^The report/);
    delete process.env.REPORT_WORKER_TIMEOUT_MS;
    // sonraki istek yeni çocukla çalışır
    const ok = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/report.pdf`, headers: auth });
    expect(ok.statusCode).toBe(200);
  }, 180_000);
});
