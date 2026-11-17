// Bağımsız inceleme (2026-11-10) bulguları: B1 başlıktaki KDV ibaresi okunmuyordu (regex'te \b yerine backspace karakteri),
// B4 ülke istisnası UK/GB takma adını tanımıyordu.
import { describe, expect, it } from 'vitest';
import { emptyMapping, findCountryAdjustment, parseRows, type ColumnMapping } from '../src/index';

const base: ColumnMapping = { ...emptyMapping(), trackingNo: 'Takip', netAmount: 'Toplam', amountsIncludeVat: true, vatPct: 20 };

describe('B1 sütun başlığındaki KDV ibaresi', () => {
  it('"Ek (KDV Hariç)" başlıklı ek ücret bölünmez', () => {
    const { lines, errors } = parseRows(
      { headers: ['Takip', 'Ek (KDV Hariç)', 'Toplam'], rows: [['T1', '20,00', '144,00']] },
      { ...base, surchargeColumns: [{ header: 'Ek (KDV Hariç)', code: 'EK' }] },
    );
    expect(errors).toEqual([]);
    expect(lines[0]!.netAmount).toBe(120);
    expect(lines[0]!.surcharges?.[0]?.amount).toBe(20);
  });

  it('"Ek (KDV Dahil)" başlıklı ek ücret KDV\'den arındırılır', () => {
    const { lines, errors } = parseRows(
      { headers: ['Takip', 'Ek (KDV Dahil)', 'Toplam'], rows: [['T1', '24,00', '144,00']] },
      { ...base, surchargeColumns: [{ header: 'Ek (KDV Dahil)', code: 'EK' }] },
    );
    expect(errors).toEqual([]);
    expect(lines[0]!.surcharges?.[0]?.amount).toBe(20);
  });
});

describe('B4 ülke istisnasında takma ad', () => {
  const tariff = { countryAdjustments: [{ country: 'GB', pct: -10, source: 'manual' as const }] };
  it('tarifede GB, varış UK → istisna bulunur', () => {
    expect(findCountryAdjustment(tariff, 'UK')?.pct).toBe(-10);
    expect(findCountryAdjustment(tariff, ' uk ')?.pct).toBe(-10);
  });
  it('tarifede UK, varış GB → istisna bulunur', () => {
    expect(findCountryAdjustment({ countryAdjustments: [{ country: 'UK', pct: 5, source: 'manual' as const }] }, 'GB')?.pct).toBe(5);
  });
  it('boş varışta istisna yok', () => {
    expect(findCountryAdjustment(tariff, '')).toBeUndefined();
    expect(findCountryAdjustment(tariff, null)).toBeUndefined();
  });
});
