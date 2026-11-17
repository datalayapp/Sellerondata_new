/**
 * Uçtan uca dayanıklılık: farklı kodlama / sayfa düzeni / boyuttaki dosyalar yükleme → eşleme → içe aktarma →
 * karşılaştırma zincirinde, özgün örnek faturayla aynı sonucu verir (samples/expected.json).
 * Fikstürler: packages/core/test/fixtures/robustness (uydurma veri).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../src/seed.ts';
import { getApp, multipart, SAMPLES, samplesExist, seedIdentity } from './helpers.ts';
import { bigCsv } from '../../../packages/core/test/fixtures/robustness/build.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../packages/core/test/fixtures/robustness');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ExpectedLine = { trackingNo: string; status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null; confidence?: 'LOW' };
type ExpectedInvoice = {
  id: string;
  file: string;
  carrierCode: string;
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  lines: ExpectedLine[];
  totals: Record<string, number>;
  reviewTotals: { estimatedOverchargeTotal: number; estimatedLines: number };
};
type Line = { trackingNo: string; status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null; confidence?: string };

describe('fatura okuma dayanıklılığı (uçtan uca)', () => {
  // Örnek klasörü depoda izlenir; yoksa takım sessizce atlanmaz, kırılır.
  it('samples/ klasörü yerinde', () => {
    expect(samplesExist, 'Deciship/samples/expected.json yok').toBe(true);
  });

  const expected: { invoices: ExpectedInvoice[] } = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8'));
  const inv = (file: string) => expected.invoices.find((i) => i.file.endsWith(file))!;
  let auth: { authorization: string };
  const carriers = new Map<string, string>();

  beforeAll(async () => {
    const app = await getApp();
    await seed({ reset: true, samples: true, log: () => {} });
    auth = (await seedIdentity('ADMIN')).auth;
    for (const c of (await app.inject({ method: 'GET', url: '/api/deciship/carriers', headers: auth })).json().items) carriers.set(c.code, c.id);
    // Altın sonuçlar katı kuralla yazıldı (bkz. invoices.test.ts).
    await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: auth, payload: { unknownSurchargesAsDiff: true } });
  });

  async function preview(carrier: string, fileName: string, data: Buffer) {
    const app = await getApp();
    const form = multipart([
      { name: 'carrierId', value: carriers.get(carrier)! },
      { name: 'file', filename: fileName, contentType: fileName.endsWith('.xlsx') ? XLSX_MIME : 'text/csv', data },
    ]);
    return app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  }

  async function importFile(carrier: string, fileName: string, data: Buffer, meta: { invoiceNo: string; invoiceDate: string; currency: string }) {
    const app = await getApp();
    const p = await preview(carrier, fileName, data);
    expect(p.statusCode, p.body).toBe(200);
    const pv = p.json();
    expect(pv.missing).toEqual([]);
    // KALANLAR 6.18: eşiği (`INVOICE_IMPORT_QUEUE_ROWS`, 5.000) aşan dosya iş kuyruğuna gider (202 + iş; testte iş satır içi
    // koşar), küçük dosya bugünkü gibi 201. Panel gibi her zaman `?async=1` gönderilir.
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices?async=1',
      headers: auth,
      payload: {
        fileId: pv.fileId,
        carrierId: carriers.get(carrier),
        invoiceNo: meta.invoiceNo,
        invoiceDate: meta.invoiceDate,
        currency: meta.currency,
        mapping: pv.suggestedMapping,
      },
    });
    let invoice;
    if (res.statusCode === 202) {
      const job = (await app.inject({ method: 'GET', url: `/api/deciship/jobs/${res.json().job.id}`, headers: auth })).json();
      expect(job.status, JSON.stringify(job.error)).toBe('SUCCEEDED');
      invoice = job.result.invoice;
    } else {
      expect(res.statusCode, res.body).toBe(201);
      invoice = res.json().invoice;
    }
    const lines = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoice.id}/lines?pageSize=500`, headers: auth })).json().items as Line[];
    return { preview: pv, invoice, lines };
  }

  function expectGolden(lines: Line[], exp: ExpectedInvoice) {
    exp.lines.forEach((e, i) => {
      const got = lines[i]!;
      const label = `${exp.id} ${i + 1} ${e.trackingNo}`;
      expect(got.trackingNo, label).toBe(e.trackingNo);
      expect(got.status, label).toBe(e.status);
      expect(got.diffTypes, label).toEqual(e.diffTypes);
      expect(got.diffAmount, label).toBe(e.diffAmount);
      if (!e.diffTypes.includes('DUPLICATE')) expect(got.expectedAmount, label).toBe(e.expectedAmount);
      // KALANLAR 1.8: aynı dosyada tekrarlanan takip no'nun mükerreri "İncele"
      expect(got.confidence === 'LOW' ? 'LOW' : undefined, label).toBe(e.confidence);
    });
  }

  it('Windows-1254 MNG CSV ("TL" ekli tutarlar) → özgün örnekle aynı karşılaştırma', async () => {
    const exp = inv('mng-MNG-2026-77120.csv');
    const data = fs.readFileSync(path.join(FIXTURES, 'enc-cp1254-mng.csv'));
    const { preview: pv, invoice, lines } = await importFile('mng', 'mng-1254.csv', data, exp);
    expect(pv.headers).toContain('Alıcı Adı');
    expect(pv.headers).toContain('Kapıda Ödeme');
    expect(lines).toHaveLength(exp.lines.length);
    expectGolden(lines, exp);
    const { acceptedLines: _ac, flaggedLines: _f, uncheckedSurchargeTotal: _u, comparedBilledTotal: _c, fxMissing: _x, pakUnmatched: _pu, pakNoTariff: _pt, estimatedOverchargeTotal, estimatedLines, pendingLines, reconciliation: _rc, overchargeByType: _ob, ...totals } = invoice.totals;
    expect(pendingLines).toBe(0); // Mesaj 4: yeni faturada bekleyen satır yok
    expect(totals).toEqual(exp.totals);
    expect({ estimatedOverchargeTotal, estimatedLines }).toEqual(exp.reviewTotals);
  });

  let multiSheetId = '';
  it('çok sayfalı XLSX (önde Özet sayfası, birleşik başlık, alt toplam) → FedEx 11735 sonuçları', async () => {
    const exp = inv('fedex-9-482-11735.csv');
    const data = fs.readFileSync(path.join(FIXTURES, 'xlsx-multi-sheet.xlsx'));
    const { preview: pv, invoice, lines } = await importFile('fedex', 'fedex-cok-sayfa.xlsx', data, exp);
    // Y32 (Mesaj 14): TOPLAM satırı önizlemenin satır sayısına girmez (içe aktarmada da atlanır)
    expect(pv.rowCount).toBe(exp.lines.length);
    expect(pv.suggestedMapping.trackingNo).toBe('Tracking ID');
    expect(lines).toHaveLength(exp.lines.length);
    expectGolden(lines, exp);
    const { acceptedLines: _ac, flaggedLines: _f, uncheckedSurchargeTotal: _u, comparedBilledTotal: _c, fxMissing: _x, pakUnmatched: _pu, pakNoTariff: _pt, estimatedOverchargeTotal, estimatedLines, pendingLines, reconciliation: _rc, overchargeByType: _ob, ...totals } = invoice.totals;
    expect(pendingLines).toBe(0); // Mesaj 4: yeni faturada bekleyen satır yok
    expect(totals).toEqual(exp.totals);
    expect({ estimatedOverchargeTotal, estimatedLines }).toEqual(exp.reviewTotals);
    multiSheetId = invoice.id;
  });

  it('5.000+ satırlık CSV: FedEx 11735 satırları aynı sonucu, geri kalanı eşleşmeyen', async () => {
    const app = await getApp();
    // Önceki içe aktarma silinir ki aynı takip numaraları "önceki faturada" sayılmasın.
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${multiSheetId}`, headers: auth })).statusCode).toBe(204);
    const exp = inv('fedex-9-482-11735.csv');
    const t0 = Date.now();
    const { invoice } = await importFile('fedex', 'fedex-5000.csv', Buffer.from(bigCsv(5000, { prefixFedex11735: true })), { ...exp, invoiceNo: '9-000-05000' });
    const ms = Date.now() - t0;
    console.log(`[süre] API önizleme + içe aktarma + karşılaştırma, 5.018 satır: ${ms} ms`);
    const t = invoice.totals;
    expect(t.lines).toBe(5018);
    expect(t.match).toBe(exp.totals.match);
    expect(t.diff).toBe(exp.totals.diff);
    expect(t.unmatched).toBe(exp.totals.unmatched + 5000);
    expect(t.overchargeTotal).toBe(exp.totals.overchargeTotal);
    expect(t.estimatedOverchargeTotal).toBe(exp.reviewTotals.estimatedOverchargeTotal);
    expect(t.flaggedLines).toBe(0);
    const first = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoice.id}/lines?pageSize=18`, headers: auth })).json().items as Line[];
    expectGolden(first, exp);
  }, 180_000);

  it('okunamayan dosyalarda ne olduğunu ve ne yapılacağını söyler', async () => {
    const cases: [string, Buffer, number, string, RegExp][] = [
      // sıfır baytlık dosyayı API, biçim tespitinden önce ortak EMPTY_FILE hatasıyla reddeder
      ['bos.csv', Buffer.alloc(0), 400, 'EMPTY_FILE', /^Dosya boş/],
      ['bos-satirlar.csv', fs.readFileSync(path.join(FIXTURES, 'content-blank-lines.csv')), 400, 'INVALID_FILE', /^Dosya boş\./],
      ['baslik.csv', fs.readFileSync(path.join(FIXTURES, 'content-header-only.csv')), 400, 'INVALID_FILE', /fatura satırı yok/],
      ['baslik.xlsx', fs.readFileSync(path.join(FIXTURES, 'xlsx-header-only.xlsx')), 400, 'INVALID_FILE', /fatura satırı yok/],
      ['eski.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 400, 'UNSUPPORTED_FORMAT', /\.xlsx/],
      ['rapor.xls', Buffer.from('<html><table><tr><td>Takip No</td></tr></table></html>'), 400, 'UNSUPPORTED_FORMAT', /web sayfası/],
      ['bozuk.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 400, 'INVALID_FILE', /açılamadı/],
    ];
    for (const [name, data, status, code, msg] of cases) {
      const res = await preview('fedex', name, data);
      expect(res.statusCode, `${name} ${res.body}`).toBe(status);
      expect(res.json().error.code, name).toBe(code);
      expect(res.json().error.message, name).toMatch(msg);
    }
  });
});
