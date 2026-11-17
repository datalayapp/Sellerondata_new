// DENETIM-2 Mesaj 3 (01-B4, 01-B6, 01-B12) ortak altyapısı: XLSX'te gerçek sayı hücreleri işaretlenir, metni
// sayı biçimine bakılmadan okunur; tarife okuyucusu için yüzde biçimi de taşınır.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { isNumericCell, numericCellValue, readTable, readXlsxSheets, tableFromMatrix } from '../src/invoice/read';

async function xlsx(build: (ws: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('Fatura'));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('XLSX sayı hücresi işareti', () => {
  it('fatura tablosu: gerçek sayı hücresi işaretli, metin hücresi işaretsiz; metinler eskisi gibi', async () => {
    const bytes = await xlsx((ws) => {
      ws.addRow(['ÖRNEK KARGO']);
      ws.addRow(['Takip No', 'Tutar', 'Ağırlık']);
      ws.addRow(['794800000011', '1,639.15', 0.453]);
      ws.addRow([794800000012, '12.50', 1.234]);
      ws.addRow([]);
      ws.addRow(['794800000013', '7.00', { formula: '1+0.125', result: 1.125 }]);
    });
    const t = await readTable('a.xlsx', bytes);
    expect(t.headers).toEqual(['Takip No', 'Tutar', 'Ağırlık']);
    expect(t.rows).toEqual([
      ['794800000011', '1,639.15', '0,453'],
      ['794800000012', '12.50', '1,234'],
      ['794800000013', '7.00', '1,125'],
    ]);
    expect(t.rows.map((_, r) => t.headers.map((__, c) => isNumericCell(t, r, c)))).toEqual([
      [false, false, true],
      [true, false, true],
      [false, false, true],
    ]);
    expect(t.rows.map((r) => numericCellValue(r[2]!))).toEqual([0.453, 1.234, 1.125]);
  });

  it('CSV ve elle kurulan tablo işaretsiz; sınır dışı erişim false', () => {
    const t = tableFromMatrix([
      ['Takip No', 'Tutar'],
      ['794800000011', '1,234'],
    ]);
    expect(t.numeric).toBeUndefined();
    expect(isNumericCell(t, 0, 1)).toBe(false);
    const m = tableFromMatrix(
      [
        ['Takip No', 'Tutar'],
        ['794800000011', '1,234'],
      ],
      [[], [false, true]],
    );
    expect(isNumericCell(m, 0, 1)).toBe(true);
    expect(isNumericCell(m, 0, 2)).toBe(false);
    expect(isNumericCell(m, 1, 0)).toBe(false);
    expect(isNumericCell(m, -1, 0)).toBe(false);
  });

  it('numericCellValue: numberToCell biçimleri', () => {
    expect(numericCellValue('0,453')).toBe(0.453);
    expect(numericCellValue('1234,5')).toBe(1234.5);
    expect(numericCellValue('12')).toBe(12);
    expect(numericCellValue('-0,125')).toBe(-0.125);
    expect(numericCellValue('1,5e-7')).toBe(1.5e-7);
    expect(numericCellValue('')).toBeNull();
    expect(numericCellValue('abc')).toBeNull();
  });

  it('tarife sayfaları: numeric ve percent matrisleri satırlarla aynı biçimde', async () => {
    const bytes = await xlsx((ws) => {
      ws.addRow(['Ağırlık', 'Fiyat', 'İndirim']);
      const r = ws.addRow([1.5, '1,250', 0.005]);
      r.getCell(3).numFmt = '0.00%';
      ws.addRow(['31+', 8, '%5']);
    });
    const [s] = await readXlsxSheets(bytes);
    expect(s!.rows).toEqual([
      ['Ağırlık', 'Fiyat', 'İndirim'],
      ['1,5', '1,250', '0,005'],
      ['31+', '8', '%5'],
    ]);
    expect(s!.numeric).toEqual([
      [false, false, false],
      [true, false, true],
      [false, true, false],
    ]);
    expect(s!.percent).toEqual([
      [false, false, false],
      [false, false, true],
      [false, false, false],
    ]);
  });
});
