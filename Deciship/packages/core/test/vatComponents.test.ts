// Denetim 04-B5: "Tutarlar KDV dahil" yalnız net tutarı (KDV dahil toplam sütunu) KDV'den arındırır. Bileşen sütunları
// (navlun, indirim, yakıt, ek ücretler) Aras gibi faturalarda KDV hariçtir; onları da 1,2'ye bölmek ek ücreti küçültür,
// varsayılan ayarda uyumlu satırı sahte "Fiyat farkı" yapar ve tarifedeki ek ücretin fazlasını gizler.
import { describe, expect, it } from 'vitest';
import { compareLine, emptyMapping, parseRows, type ColumnMapping, type MeasurementInput } from '../src/index';
import { ARAS, TOL } from './fixtures';

const ARAS_HEADERS = ['Gönderi No', 'Desi', 'Kapıda Ödeme Bedeli', 'Adres Düzeltme Bedeli', 'KDV', 'Toplam'];
const ARAS_MAPPING: ColumnMapping = {
  ...emptyMapping(),
  trackingNo: 'Gönderi No',
  netAmount: 'Toplam',
  billedKg: 'Desi',
  desiAsWeight: true,
  amountsIncludeVat: true,
  vatPct: 20,
  surchargeColumns: [
    { header: 'Kapıda Ödeme Bedeli', code: 'KAPIDA_ODEME' },
    { header: 'Adres Düzeltme Bedeli', code: 'ADRES_DUZELTME' },
  ],
};

describe('04-B5 KDV dahil toplam, KDV hariç bileşenler', () => {
  it('ek ücret sütunları bölünmez; yalnız net tutar KDV\'den arındırılır', () => {
    // Aras örneği (samples/aras-ARS-2026-004871.xlsx satır 2 ve 6): kapıda ödeme 14,50, adres düzeltme 38,00 (KDV hariç)
    const { lines, errors } = parseRows(
      {
        headers: ARAS_HEADERS,
        rows: [
          ['3412550010242', '3', '14,50', '', '18,61', '111,66'],
          ['3412550010286', '5', '', '38,00', '26,59', '159,56'],
        ],
      },
      ARAS_MAPPING,
    );
    expect(errors).toEqual([]);
    expect(lines[0]!.netAmount).toBe(93.05);
    expect(lines[0]!.surcharges).toEqual([{ code: 'KAPIDA_ODEME', name: 'Kapıda Ödeme Bedeli', amount: 14.5 }]);
    expect(lines[1]!.netAmount).toBe(132.97);
    expect(lines[1]!.surcharges).toEqual([{ code: 'ADRES_DUZELTME', name: 'Adres Düzeltme Bedeli', amount: 38 }]);
  });

  it('varsayılan ayarda (tarifede olmayan ek ücret fark sayılmaz) adres düzeltmeli Aras satırı uyumlu', () => {
    const { lines } = parseRows({ headers: ARAS_HEADERS, rows: [['3412550010286', '5', '', '38,00', '26,59', '159,56']] }, ARAS_MAPPING);
    const measurement: MeasurementInput = { id: 'm', dims: { l: 32, w: 22, h: 18 }, actualKg: 3, measuredAt: '2026-10-23T15:10:00+03:00' };
    const line = { ...lines[0]!, destCountry: 'TR' };
    const r = compareLine({ line, measurement, tariff: ARAS, tol: TOL, isDuplicate: false });
    // beklenen = 5 desi taşıma (100 − %10 = 90) + faturadaki adres düzeltme 38 → 128; fatura 132,97 − 128 = 4,97 ≤ tolerans 5
    expect({ status: r.status, diffTypes: r.diffTypes, expected: r.expectedAmount }).toEqual({ status: 'MATCH', diffTypes: [], expected: 128 });
  });

  it('bileşenler veride KDV dahilse (navlun + ek ücret = KDV dahil toplam) onlar da bölünür', () => {
    const headers = ['Takip No', 'Navlun', 'Ek Ücret', 'Toplam (KDV Dahil)'];
    const m: ColumnMapping = {
      ...emptyMapping(),
      trackingNo: 'Takip No',
      netAmount: 'Toplam (KDV Dahil)',
      baseAmount: 'Navlun',
      amountsIncludeVat: true,
      vatPct: 20,
      surchargeColumns: [{ header: 'Ek Ücret', code: 'ADDRESS_CORRECTION' }],
    };
    const { lines } = parseRows(
      { headers, rows: [['1234567890', '120,00', '24,00', '144,00'], ['1234567891', '60,00', '', '60,00']] },
      m,
    );
    expect(lines.map((l) => [l.baseAmount, l.surcharges.map((s) => s.amount), l.netAmount])).toEqual([
      [100, [20], 120],
      [50, [], 50],
    ]);
  });

  it('bileşenler veride KDV hariçse (navlun + ek ücret = KDV hariç toplam) bölünmez', () => {
    const headers = ['Takip No', 'Navlun', 'Ek Ücret', 'Toplam'];
    const m: ColumnMapping = {
      ...emptyMapping(),
      trackingNo: 'Takip No',
      netAmount: 'Toplam',
      baseAmount: 'Navlun',
      amountsIncludeVat: true,
      vatPct: 20,
      surchargeColumns: [{ header: 'Ek Ücret', code: 'ADDRESS_CORRECTION' }],
    };
    const { lines } = parseRows({ headers, rows: [['1234567890', '100,00', '20,00', '144,00']] }, m);
    expect([lines[0]!.baseAmount, lines[0]!.surcharges[0]!.amount, lines[0]!.netAmount]).toEqual([100, 20, 120]);
  });

  it('componentsIncludeVat açıkça verilirse veriye bakılmaz', () => {
    const rows = [['3412550010286', '5', '', '38,00', '26,59', '159,56']];
    const incl = parseRows({ headers: ARAS_HEADERS, rows }, { ...ARAS_MAPPING, componentsIncludeVat: true });
    expect(incl.lines[0]!.surcharges[0]!.amount).toBe(31.67);
    const excl = parseRows({ headers: ARAS_HEADERS, rows }, { ...ARAS_MAPPING, componentsIncludeVat: false });
    expect(excl.lines[0]!.surcharges[0]!.amount).toBe(38);
  });

  it('KDV dahil işaretli değilse hiçbir sütun bölünmez (değişmedi)', () => {
    const { lines } = parseRows(
      { headers: ARAS_HEADERS, rows: [['3412550010286', '5', '', '38,00', '26,59', '132,97']] },
      { ...ARAS_MAPPING, amountsIncludeVat: false, componentsIncludeVat: true },
    );
    expect([lines[0]!.netAmount, lines[0]!.surcharges[0]!.amount]).toEqual([132.97, 38]);
  });
});
