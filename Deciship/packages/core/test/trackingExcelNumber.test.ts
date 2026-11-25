// KALANLAR 5.19 (B4.20): Excel uzun takip no'yu sayıya çevirince 15 haneden sonrasını sıfırlar (19 haneli iki farklı numara
// aynı sayı olur). Okuma kontrolü bunu sezer ve tek bir uyarı yazar; değer düzeltilmez (veri uydurulmaz).
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { suggestMapping } from '../src/invoice/mapping';
import { readTable } from '../src/invoice/read';
import type { Table } from '../src/invoice/types';
import { excelNumberTrackingRows, verifyMapping } from '../src/invoice/verify';

const TR = "Takip numaraları Excel'de sayıya çevrilmiş görünüyor; son haneler bozulmuş olabilir. Dosyayı CSV olarak dışa aktarın ya da sütunu Metin yapın.";
const EN = 'Tracking numbers look like Excel turned them into numbers; the last digits may be damaged. Export the file as CSV or set the column to Text.';

async function xlsx(rows: unknown[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fatura');
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const table = (rows: string[][]): Table => ({ headers: ['Takip No', 'Tarih', 'Tutar'], rows });

describe('5.19 Excel sayıya çevirmiş uzun takip no', () => {
  it('XLSX sayı hücresinde 16+ hane: uyarı, onay ister; değer olduğu gibi kalır', async () => {
    // Excel 15 hane saklar: 1234567890123456789 → 1234567890123450000 (dosyada çift duyarlıklı sayı; okununca son haneler başka).
    const a = 1234567890123450000;
    const b = Number('96123456789012340000');
    const bytes = await xlsx([
      ['Takip No', 'Tarih', 'Tutar'],
      [a, '05.11.2026', '100,00'],
      [b, '05.11.2026', '50,00'],
      ['794800000011', '05.11.2026', '20,00'],
    ]);
    const t = await readTable('fatura.xlsx', bytes);
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(mapping.trackingNo).toBe('Takip No');
    expect(excelNumberTrackingRows(t, mapping)).toEqual({ count: 2, sample: a.toFixed(0) });
    const v = verifyMapping(t, mapping);
    expect(v.verdict).toBe('check');
    expect(v.issues.filter((i) => i === TR)).toHaveLength(1);
    expect(verifyMapping(t, mapping, { locale: 'en' }).issues).toContain(EN);
    // Düzeltme yok: takip no dosyadaki gibi okunur.
    expect(t.rows.map((r) => r[0])).toEqual([a.toFixed(0), b.toFixed(0), '794800000011']);
  });

  it('XLSX sayı hücresinde 15 ve daha kısa hane bozulmaz: uyarı yok', async () => {
    const bytes = await xlsx([
      ['Takip No', 'Tarih', 'Tutar'],
      [794800000012, '05.11.2026', '100,00'],
      [123456789012345, '05.11.2026', '50,00'],
    ]);
    const t = await readTable('fatura.xlsx', bytes);
    const { mapping } = suggestMapping(t.headers, 'generic', t.rows);
    expect(excelNumberTrackingRows(t, mapping)).toBeNull();
    expect(verifyMapping(t, mapping).issues).not.toContain(TR);
  });

  it('metin hücresi (CSV): 15. haneden sonrası hep sıfırsa uyarı; gerçek uzun numaralar arasında tek tük sıfırla biten uyarmaz', () => {
    const m = { trackingNo: 'Takip No' };
    expect(
      excelNumberTrackingRows(
        table([
          ['1234567890123450000', '05.11.2026', '100,00'],
          ['12345678901234500000', '05.11.2026', '50,00'],
          ['794800000011', '05.11.2026', '20,00'],
        ]),
        m,
      ),
    ).toEqual({ count: 2, sample: '1234567890123450000' });
    // Gerçek 20 haneli numaralar: biri tesadüfen 0 ile bitiyor, 15. haneden sonrası sıfır değil → uyarı yok.
    expect(
      excelNumberTrackingRows(
        table([
          ['61299995669352455120', '05.11.2026', '100,00'],
          ['61299995669352455137', '05.11.2026', '50,00'],
          ['00340434161094042557', '05.11.2026', '20,00'],
        ]),
        m,
      ),
    ).toBeNull();
    // Harfli ya da kısa numara, bilimsel yazım (o ayrı uyarıdır) sayılmaz.
    expect(
      excelNumberTrackingRows(
        table([
          ['JJD0000000000000000000', '', ''],
          ['1,23457E+18', '', ''],
          ['794800000000', '', ''],
        ]),
        m,
      ),
    ).toBeNull();
  });
});
