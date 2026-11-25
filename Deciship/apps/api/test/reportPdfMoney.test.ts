import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildReportXlsx, pdfMoney } from '../src/services/reports.ts';
import { m } from '../src/i18n/index.ts';

// Denetim 01-B9, karar (a): tutarlar KDV hariç saklanır; rapor bunu söyler (Excel özet sayfası, PDF açıklama satırı).
describe('rapor: tutarlar KDV hariç', () => {
  it('Excel özet sayfası ve PDF açıklaması "KDV hariç" yazar', async () => {
    const totals = { lines: 0, match: 0, diff: 0, unmatched: 0, noTariff: 0, overchargeTotal: 0, verifiedTotal: 0, billedTotal: 0, expectedTotal: 0 };
    const buf = await buildReportXlsx(
      { companyName: 'Demo', carrierName: 'FedEx', invoiceNo: 'F-1', invoiceDate: '2026-10-31', periodFrom: null, periodTo: null, currency: 'TRY', totals: totals as never, lines: [] },
      { inMemory: true },
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const keys: string[] = [];
    wb.worksheets[0]!.eachRow((row) => keys.push(String(row.getCell(1).value ?? '')));
    expect(keys).toContain('Para birimi (tutarlar KDV hariç)');
    expect(m('report.pdf.basisNote')).toContain('Tutarlar KDV hariçtir');
  });
});

describe('PDF tutar biçimi', () => {
  it('tutar ile simge arasında bölünmez boşluk kullanır (TRY, USD, EUR; TR ve EN)', () => {
    for (const locale of ['tr', 'en'] as const) {
      for (const cur of ['TRY', 'USD', 'EUR']) {
        const s = pdfMoney(1234.5, cur, locale);
        expect(s).not.toContain(' ');
        expect(s).toMatch(/\d/);
      }
    }
    expect(pdfMoney(1234.5, 'TRY', 'tr')).toMatch(/\u00a0₺$/);
    expect(pdfMoney(1234.5, 'USD', 'tr')).toMatch(/\u00a0\$$/);
    expect(pdfMoney(1234.5, 'EUR', 'tr')).toMatch(/\u00a0€$/);
  });
});
