/**
 * Y102: İngilizce Excel ve PDF raporunda tarih panelle aynı biçimde, ay adıyla ("5 Oct 2026"). "10/05/2026" yazımı
 * 5 Ekim mi 10 Mayıs mı karışıyordu; panel İngilizcede zaten "5 Oct 2026" gösterir. Türkçe rapor değişmez ("05.10.2026").
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { withLocale } from '../src/i18n/index.ts';
import { buildReportPdf, buildReportXlsx, type ReportInput } from '../src/services/reports.ts';

function input(): ReportInput {
  const line = {
    id: 'l1',
    rowIndex: 0,
    trackingNo: 'TRK1',
    shipDate: '2026-10-03',
    destCountry: 'DE',
    service: 'IP',
    status: 'DIFF',
    diffTypes: ['WEIGHT'],
    decision: 'OPEN',
    confidence: 'HIGH',
    dims: { l: 40, w: 30, h: 20 },
    billedChargeableKg: 12,
    ourChargeableKg: 10,
    netAmount: 120,
    expectedAmount: 100,
    diffAmount: 20,
    fx: null,
    pricingBasis: 'TARIFF',
    note: '',
    parseFlags: [],
    // 2026-10-04 08:30 İstanbul
    measurement: { measuredAt: '2026-10-04T05:30:00.000Z', lengthCm: 40, widthCm: 30, heightCm: 20, dimMethod: 'MANUAL', weightMethod: null, photoCount: 0 },
  };
  const totals = { lines: 1, match: 0, diff: 1, unmatched: 0, noTariff: 0, overchargeTotal: 20, verifiedTotal: 0, billedTotal: 120, expectedTotal: 100 };
  return {
    companyName: 'Demo',
    carrierName: 'FedEx',
    invoiceNo: 'F-1',
    invoiceDate: '2026-10-05',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-02',
    currency: 'TRY',
    totals,
    lines: [line],
    timeZone: 'Europe/Istanbul',
  } as never;
}

async function xlsxText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const cells: string[] = [];
  for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ''))));
  return cells.join(' | ');
}

async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++)
    text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + ' ';
  return text.replace(/\s+/g, ' ');
}

describe('rapor tarihi (Y102)', () => {
  it('İngilizce Excel: fatura tarihi, dönem, gönderim günü ve ölçüm zamanı ay adıyla', async () => {
    const text = await withLocale('en', async () => xlsxText(await buildReportXlsx(input(), { inMemory: true })));
    expect(text).toContain('5 Oct 2026');
    expect(text).toContain('1 Oct 2026 – 2 Oct 2026');
    expect(text).toContain('3 Oct 2026');
    expect(text).toContain('4 Oct 2026 08:30');
    expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('İngilizce PDF: fatura satırı ay adıyla', async () => {
    const text = await withLocale('en', async () => pdfText(await buildReportPdf(input())));
    expect(text).toContain('5 Oct 2026');
    expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  }, 60_000);

  it('Türkçe rapor değişmez: GG.AA.YYYY', async () => {
    const text = await xlsxText(await buildReportXlsx(input(), { inMemory: true }));
    expect(text).toContain('05.10.2026');
    expect(text).toContain('01.10.2026 – 02.10.2026');
    expect(text).toContain('04.10.2026 08:30');
  });
});
