// DENETIM-2 01-B4: XLSX'te gerçek sayı hücreleri (ör. lb'den çevrilmiş 0,453 kg) sayı biçimine bakılmadan okunur.
// Eskiden metin tutarlar "1,639.15" (İngilizce) olunca ya da eşleme `numberFormat: 'en'` deyince 0,453 kg → 453 kg oluyordu.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { detectTableNumberFormat, parseRows } from '../src/invoice/parse';
import { mappingDiagnostics } from '../src/invoice/diagnostics';
import { readTable, tableFromMatrix } from '../src/invoice/read';
import type { ColumnMapping } from '../src/invoice/types';

async function xlsx(rows: unknown[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fatura');
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const base: ColumnMapping = {
  trackingNo: 'Tracking ID',
  netAmount: 'Net Charge',
  actualKg: 'Weight',
  billedKg: 'Billed Weight',
  fuelAmount: 'Fuel',
  surchargeColumns: [],
  chargePairs: [],
  amountsIncludeVat: false,
  vatPct: 20,
  desiAsWeight: false,
};

/** Tutarlar metin ve İngilizce ("1,639.15"), ağırlıklar ve yakıt 3 ondalıklı gerçek sayı. */
const ROWS: unknown[][] = [
  ['Tracking ID', 'Net Charge', 'Weight', 'Billed Weight', 'Fuel'],
  ['794800000011', '1,639.15', 0.453, 1.5, 2.125],
  ['794800000012', '12.50', 1.234, 2, 0.375],
  ['794800000013', '2,001.40', 12.345, 13, 1.5],
];

describe('01-B4: XLSX sayı hücresi sayı biçimine bakılmadan okunur', () => {
  it('otomatik tespit: metin tutarlar İngilizce okunur, gerçek sayı ağırlıklar bin kat olmaz', async () => {
    const t = await readTable('fedex.xlsx', await xlsx(ROWS));
    expect(detectTableNumberFormat(t, base)).toBe('en');
    const r = parseRows(t, base);
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.netAmount, l.actualKg, l.billedKg, l.fuelAmount])).toEqual([
      [1639.15, 0.453, 1.5, 2.13],
      [12.5, 1.234, 2, 0.38],
      [2001.4, 12.345, 13, 1.5],
    ]);
    const d = mappingDiagnostics(t, base);
    expect(d.numberFormat).toBe('en');
    expect(d.verification.fields.actualKg?.status).toBe('ok');
    expect(d.verification.flagCounts.WEIGHT_RANGE).toBeUndefined();
  });

  it("eşleme `numberFormat: 'en'` zorlasa da gerçek sayılar olduğu gibi; okuma kontrolü ağırlığı aralıkta görür", async () => {
    const t = await readTable('fedex.xlsx', await xlsx(ROWS));
    const m = { ...base, numberFormat: 'en' as const };
    const r = parseRows(t, m);
    expect(r.lines.map((l) => [l.netAmount, l.actualKg, l.fuelAmount])).toEqual([
      [1639.15, 0.453, 2.13],
      [12.5, 1.234, 0.38],
      [2001.4, 12.345, 1.5],
    ]);
    const d = mappingDiagnostics(t, m, { parsed: r });
    // KALANLAR 1.4: metin tutarlarda İngilizce kanıt var: kaynak dosya (ipucu yalnız kanıt yokken)
    expect(d.numberFormatSource).toBe('detected');
    expect(d.verification.fields.actualKg).toMatchObject({ status: 'ok' });
    expect(d.verification.fields.fuelAmount).toMatchObject({ status: 'ok' });
    expect(d.verification.rowFlags).toEqual([]);
  });

  it("`numberFormat: 'tr'` zorlanınca da gerçek sayılar değişmez (metin tutarlar Türkçe okunur)", async () => {
    const t = await readTable('a.xlsx', await xlsx([
      ['Tracking ID', 'Net Charge', 'Weight'],
      ['794800000011', '1.639,15', 0.453],
      ['794800000012', '12,50', 1234.5],
    ]));
    const r = parseRows(t, { ...base, numberFormat: 'tr' });
    expect(r.lines.map((l) => [l.netAmount, l.actualKg])).toEqual([
      [1639.15, 0.453],
      [12.5, 1234.5],
    ]);
  });

  it('tespit yalnız metin hücrelerine bakar: gerçek sayı "1234,5" Türkçe kanıt sayılmaz', async () => {
    const t = await readTable('a.xlsx', await xlsx([
      ['Tracking ID', 'Net Charge', 'Weight'],
      ['794800000011', '1,639.15', 1234.5],
      ['794800000012', '12.50', 2.25],
    ]));
    expect(detectTableNumberFormat(t, base)).toBe('en');
    // yalnız gerçek sayılar: metin kanıtı yok
    const n = await readTable('b.xlsx', await xlsx([
      ['Tracking ID', 'Net Charge', 'Weight'],
      ['794800000011', 1639.15, 1.5],
      ['794800000012', 12.5, 2.25],
    ]));
    expect(detectTableNumberFormat(n, base)).toBe('auto');
    expect(parseRows(n, { ...base, numberFormat: 'en' }).lines.map((l) => [l.netAmount, l.actualKg])).toEqual([
      [1639.15, 1.5],
      [12.5, 2.25],
    ]);
  });

  it('ücret çifti tutarı ve fatura toplamı da sayı hücresinden biçimsiz okunur', () => {
    // tableFromMatrix ile: XLSX okuyucusunun yazdığı biçim ("1,651" = 1,651 gerçek sayı)
    const t = tableFromMatrix(
      [
        ['Tracking ID', 'Net Charge', 'Charge Description', 'Charge Amount', 'Invoice Total'],
        ['794800000011', '1.25', 'Fuel Surcharge', '0,125', '1,651'],
        ['794800000012', '0.401', 'Fuel Surcharge', '0,375', '1,651'],
      ],
      [[], [false, false, false, true, true], [false, false, false, true, true]],
    );
    const m: ColumnMapping = { ...base, actualKg: undefined, billedKg: undefined, fuelAmount: undefined, numberFormat: 'en', chargePairs: [{ label: 'Charge Description', amount: 'Charge Amount' }], invoiceTotal: 'Invoice Total' };
    const r = parseRows(t, m);
    expect(r.lines.map((l) => [l.netAmount, l.fuelAmount])).toEqual([
      [1.25, 0.13],
      [0.4, 0.38],
    ]);
    const d = mappingDiagnostics(t, m, { parsed: r });
    expect(d.invoiceTotal).toMatchObject({ value: 1.651 });
    expect(d.verification.checks.invoiceTotal).toMatchObject({ value: 1.651 });
    expect(d.charges.labels).toEqual([{ label: 'Fuel Surcharge', kind: 'fuel', rows: 2 }]);
  });

  it('CSV yolu değişmez: aynı metinler sayı biçimiyle okunur', () => {
    const t = tableFromMatrix([
      ['Tracking ID', 'Net Charge', 'Weight'],
      ['794800000011', '1,639.15', '0.453'],
      ['794800000012', '12.50', '1,234'],
    ]);
    expect(detectTableNumberFormat(t, base)).toBe('en');
    expect(parseRows(t, base).lines.map((l) => [l.netAmount, l.actualKg])).toEqual([
      [1639.15, 0.453],
      [12.5, 1234],
    ]);
  });
});
