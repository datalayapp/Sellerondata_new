/**
 * Karar 2026-11-12: çok büyük faturada PDF raporu yalnız en büyük `REPORT_PDF_MAX_ROWS` (varsayılan 1.000) fark satırını
 * listeler; tamamı Excel'de. Denenen:
 * - sınır aşılmadıysa (eşitse de) PDF sınırsız üretilenle aynıdır (dosyadaki sıra, not yok);
 * - aşıldıysa en büyük Fark tutarından küçüğe ilk N fark satırı, raporun başında ve tablonun sonunda not;
 * - üstteki sayılar ve tablonun altındaki toplamlar bütün faturadır (gizlenen satırlar dahil: para);
 * - varsayılan 1.000; sınır çocuk sürece görevle gider (çocuk ortam okumaz).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.ts';
import { m, withLocale } from '../src/i18n/index.ts';
import { closeFileWorkers, renderReport } from '../src/lib/fileWorkers.ts';
import { buildReportPdf, diffReconciliation, pdfDiffRows, pdfMoney, REPORT_PDF_MAX_ROWS_DEFAULT, type ReportInput } from '../src/services/reports.ts';

const KEYS = ['FILE_WORKER_MODE', 'REPORT_PDF_MAX_ROWS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(async () => {
  await closeFileWorkers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const trk = (i: number) => `TRK${String(i).padStart(5, '0')}X`;

function line(i: number, status: string, diffAmount: number | null) {
  return {
    id: `l${i}`,
    rowIndex: i,
    trackingNo: trk(i),
    shipDate: '2026-10-01',
    destCountry: 'DE',
    service: 'IP',
    status,
    diffTypes: status === 'DIFF' ? ['WEIGHT'] : [],
    decision: 'OPEN',
    confidence: 'HIGH',
    dims: { l: 40, w: 30, h: 20 },
    billedChargeableKg: 12,
    ourChargeableKg: 10,
    netAmount: 100 + (diffAmount ?? 0),
    expectedAmount: 100,
    diffAmount,
    fx: null,
    pricingBasis: 'TARIFF',
    note: '',
    parseFlags: [],
    measurement: null,
  };
}

/**
 * `n` fark satırı: i. satırın farkı (i+1) × 10,25 (büyükler dosyanın sonunda: kısaltılınca sıra değişir); ardından lehe bir
 * fark satırı (−7,50, en küçük: kısaltılınca gizlenir), 3 uyumlu ve 1 eşleşmeyen satır. Toplamlar bütün satırlardan.
 */
function input(n: number): ReportInput {
  const lines = [
    ...Array.from({ length: n }, (_, i) => line(i, 'DIFF', (i + 1) * 10.25)),
    line(n, 'DIFF', -7.5),
    line(n + 1, 'MATCH', 0),
    line(n + 2, 'MATCH', 0),
    line(n + 3, 'MATCH', 0),
    line(n + 4, 'UNMATCHED', null),
  ];
  const overcharge = (10.25 * n * (n + 1)) / 2;
  const totals = { lines: lines.length, match: 3, diff: n + 1, unmatched: 1, noTariff: 0, overchargeTotal: overcharge, verifiedTotal: 0, billedTotal: 5000, expectedTotal: 4000 };
  return { companyName: 'Demo', carrierName: 'FedEx', invoiceNo: 'F-1', invoiceDate: '2026-10-31', periodFrom: null, periodTo: null, currency: 'TRY', totals, lines, timeZone: 'Europe/Istanbul' } as never;
}

/** PDF'te üretim anı ve kimliği her üretimde değişir; içerik karşılaştırması onsuz (reportWorker.test.ts ile aynı). */
function normalizePdf(buf: Buffer): string {
  return buf.toString('latin1').replace(/\(D:\d{14}Z\)/g, '(D:)').replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/gi, '/ID []');
}

const norm = (s: string) => s.replace(/\s+/g, ' ');

async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + ' ';
  return norm(text);
}

const count = (text: string, part: string) => text.split(part).length - 1;
const money = (n: number) => norm(pdfMoney(n, 'TRY', 'tr'));

describe('PDF fark satırı sınırı: seçim', () => {
  it('fark satırı = durumu DIFF; sınır aşılmadıysa dosyadaki sıra, aşıldıysa en büyük farktan küçüğe (eşitse dosya sırası)', () => {
    const r = input(12);
    const all = pdfDiffRows(r.lines);
    expect(all.truncated).toBe(false);
    expect(all.rows.map((l) => l.rowIndex)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(pdfDiffRows(r.lines, 13)).toEqual(all);
    const cut = pdfDiffRows(r.lines, 5);
    expect(cut).toMatchObject({ total: 13, truncated: true });
    expect(cut.rows.map((l) => l.rowIndex)).toEqual([11, 10, 9, 8, 7]);
    // eşit farkta dosyadaki sıra; tutarı boş fark satırı 0 sayılır
    const tie = [line(0, 'DIFF', 5), line(1, 'DIFF', 9), line(2, 'DIFF', 5), line(3, 'DIFF', null), line(4, 'MATCH', 50)] as never;
    expect(pdfDiffRows(tie, 3).rows.map((l) => l.rowIndex)).toEqual([1, 0, 2]);
  });

  it('inceleme 6: sınır verilmemiş ya da geçersizse (0, eksi, NaN, sonsuz) sınırsız değil, varsayılan 1.000; kesir aşağı yuvarlanır', () => {
    const big = input(1100).lines; // 1.101 fark satırı
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const r = pdfDiffRows(big, bad);
      expect(r, String(bad)).toMatchObject({ total: 1101, truncated: true });
      expect(r.rows).toHaveLength(REPORT_PDF_MAX_ROWS_DEFAULT);
    }
    expect(REPORT_PDF_MAX_ROWS_DEFAULT).toBe(1000);
    const small = input(12).lines;
    expect(pdfDiffRows(small, 2.5).rows.map((l) => l.rowIndex)).toEqual([11, 10]);
    expect(pdfDiffRows(small, Number.NaN)).toMatchObject({ total: 13, truncated: false });
  });
});

describe('PDF fark satırı sınırı: rapor', () => {
  it('sınır aşılmadıysa (eşitse de) PDF sınırsız üretilenle bayt bayt aynı; not yok', async () => {
    const r = input(12);
    const plain = normalizePdf(await buildReportPdf(r));
    expect(normalizePdf(await buildReportPdf(r, { maxRows: 13 }))).toBe(plain);
    expect(normalizePdf(await buildReportPdf(r, { maxRows: 1000 }))).toBe(plain);
    expect(await pdfText(await buildReportPdf(r, { maxRows: 13 }))).not.toContain('Bu PDF en büyük');
  });

  it('aşıldıysa en büyük N satır sırasıyla; not başta ve tablonun sonunda; toplamlar bütün fatura', async () => {
    const r = input(12);
    const text = await pdfText(await buildReportPdf(r, { maxRows: 5 }));
    const note = norm(m('report.pdf.truncatedNote', { shown: '5', total: '13' }));
    expect(note).toBe('Bu PDF en büyük 5 fark satırını gösterir (toplam 13 satır). Toplamlar tüm satırları kapsar. Tamamı Excel raporundadır.');
    expect(count(text, note)).toBe(2);
    // not, raporun başında (KPI'lardan önce) ve tablonun sonunda (son toplam satırından sonra)
    expect(text.indexOf(note)).toBeLessThan(text.indexOf(m('report.pdf.kpi.lines')));
    expect(text.lastIndexOf(note)).toBeGreaterThan(text.lastIndexOf(m('report.sum.diffColumn')));

    const shown = [11, 10, 9, 8, 7].map(trk);
    const pos = shown.map((s) => text.indexOf(s));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    for (const i of [0, 1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16]) expect(text).not.toContain(trk(i));

    // Para: toplamlar gizlenen satırlar dahil bütün faturadan. Fazla ödeme 12 satırın tamamı (799,50), lehe fark yalnız
    // gizlenen satırdan (−7,50), Fark sütunu toplamı 792,00. Gösterilen 5 satırın toplamı (512,50) hiçbir yerde yazmaz.
    const rec = diffReconciliation(r.lines);
    expect(rec).toMatchObject({ overcharge: 799.5, favorable: -7.5, total: 792 });
    expect(r.totals.overchargeTotal).toBe(799.5);
    expect(count(text, money(799.5))).toBe(2); // KPI + tablo altındaki Fazla ödeme
    expect(text).toContain(`${m('report.sum.favorable')} ${money(-7.5)}`);
    expect(text).toContain(`${m('report.sum.diffColumn')} ${money(792)}`);
    expect(text).not.toContain(money(512.5));
    // KPI sayıları da bütün fatura
    expect(text).toContain(`${m('report.pdf.kpi.lines')} 17`);
    expect(text).toContain(`${m('report.pdf.kpi.diff')} 13`);
  });

  it('inceleme 5: not, tablo altı toplamlarının görünen satırların değil tüm satırların toplamı olduğunu söyler (TR+EN)', async () => {
    expect(m('report.pdf.truncatedNote', { shown: '5', total: '13' })).toContain('Toplamlar tüm satırları kapsar.');
    expect(await withLocale('en', async () => m('report.pdf.truncatedNote', { shown: '5', total: '13' }))).toContain('Totals cover all lines.');
    const text = await pdfText(await buildReportPdf(input(12), { maxRows: 5 }));
    expect(count(text, 'Toplamlar tüm satırları kapsar.')).toBe(2);
  });

  it('İngilizce not, sayılar raporun dilinde', async () => {
    const text = await withLocale('en', async () => pdfText(await buildReportPdf(input(1200), { maxRows: 1000 })));
    expect(count(text, 'This PDF shows the 1,000 largest discrepancy lines (1,201 lines in total). Totals cover all lines. The full list is in the Excel report.')).toBe(2);
  }, 60_000);

  it('varsayılan sınır 1.000 (REPORT_PDF_MAX_ROWS yok): 1.000 fark satırı kısalmaz, 1.001 kısalır; toplamlar bütün fatura', async () => {
    delete process.env.REPORT_PDF_MAX_ROWS;
    process.env.FILE_WORKER_MODE = 'inline';
    expect(env.reportPdfMaxRows).toBe(1000);
    // 999 + lehe satır = 1.000 fark satırı: sınırsız PDF ile aynı
    const at = input(999);
    expect(normalizePdf(await renderReport('pdf', at, { companyId: 'A' }))).toBe(normalizePdf(await buildReportPdf(at)));

    const over = input(1000);
    const text = await pdfText(await renderReport('pdf', over, { companyId: 'A' }));
    expect(count(text, 'Bu PDF en büyük 1.000 fark satırını gösterir (toplam 1.001 satır). Toplamlar tüm satırları kapsar. Tamamı Excel raporundadır.')).toBe(2);
    const rec = diffReconciliation(over.lines);
    expect(text).toContain(`${m('report.sum.diffColumn')} ${money(rec.total)}`);
    expect(text).toContain(`${m('report.sum.favorable')} ${money(-7.5)}`);
    expect(text).not.toContain(trk(1000)); // gizlenen lehe satır
  }, 120_000);

  it('sınır çocuk sürece görevle gider (çocuğa ortam geçmez); Excel kısalmaz', async () => {
    process.env.FILE_WORKER_MODE = 'process';
    process.env.REPORT_PDF_MAX_ROWS = '5';
    expect(env.reportPdfMaxRows).toBe(5);
    const r = input(12);
    const text = await pdfText(await renderReport('pdf', r, { companyId: 'A' }));
    expect(count(text, 'Bu PDF en büyük 5 fark satırını gösterir (toplam 13 satır). Toplamlar tüm satırları kapsar. Tamamı Excel raporundadır.')).toBe(2);
    // Excel çocuktan sınırsız (sınır yalnız PDF görevine verilir): içerik ana süreçte sınırsız üretilenle aynı
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderReport('xlsx', r, { companyId: 'A' })) as never);
    expect(wb.getWorksheet(m('report.sheet.diffs'))!.rowCount).toBe(14);
  }, 120_000);
});
