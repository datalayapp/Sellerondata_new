// Denetim 14-B1: elle ölçüm girişi (kenar cm, ağırlık kg) binlik ayırıcı tanımaz; nokta da virgül de ondalıktır.
// TR arayüzde "2.500" kg 2,5 kg'dır, 2500 değil. Fatura/tarife okuma `parseTrNumber`da kalır (orada binlik anlamlıdır).
// Mobil `parseNum` ile aynı sonucu verir.
import { describe, expect, it } from 'vitest';
import { ambiguousWeightText, uiAmbiguousSeparator, parseMeasureNumber, measureEdgeOk, measureWeightOk, MAX_EDGE_CM, MAX_WEIGHT_KG } from '../src/measureInput';
import { parseMeasureNumber as fromIndex, parseTrNumber } from '../src/index';
import { parseNum as mobileParseNum } from '../../../apps/mobile/src/lib/parseNum';

const CASES: [string, number | null][] = [
  ['2.500', 2.5],
  ['2,500', 2.5],
  ['1.250', 1.25],
  ['4,02', 4.02],
  ['4.02', 4.02],
  ['12.5', 12.5],
  ['40', 40],
  [' 40 ', 40],
  ['1.234,5', 1234.5],
  ['1,234.5', 1234.5],
  ['', null],
  ['   ', null],
  ['abc', null],
  ['4,5 ', 4.5],
];

describe('14-B1 ölçü/ağırlık girişi', () => {
  it.each(CASES)('parseMeasureNumber(%j) = %j', (s, n) => {
    expect(parseMeasureNumber(s)).toBe(n);
  });

  it('mobil parseNum ile aynı sonuç', () => {
    for (const [s] of CASES) expect({ s, n: parseMeasureNumber(s) }).toEqual({ s, n: mobileParseNum(s) });
  });

  it('index üzerinden de dışa açık', () => {
    expect(fromIndex('2.500')).toBe(2.5);
  });

  it('fatura okuması değişmedi: parseTrNumber "2.500" binlik okur', () => {
    expect(parseTrNumber('2.500')).toBe(2500);
  });

  it('sınırlar mobil ile aynı: kenar 0 < x ≤ 400 cm, ağırlık 0 < x < 1000 kg', () => {
    expect([MAX_EDGE_CM, MAX_WEIGHT_KG]).toEqual([400, 1000]);
    expect(measureEdgeOk('40')).toBe(true);
    expect(measureEdgeOk('400')).toBe(true);
    expect(measureEdgeOk('400,1')).toBe(false);
    expect(measureEdgeOk('1250')).toBe(false);
    expect(measureEdgeOk('0')).toBe(false);
    expect(measureEdgeOk('-3')).toBe(false);
    expect(measureEdgeOk('')).toBe(false);
    expect(measureWeightOk('2.500')).toBe(true);
    expect(measureWeightOk('999,9')).toBe(true);
    expect(measureWeightOk('1000')).toBe(false);
    expect(measureWeightOk('2500')).toBe(false);
    expect(measureWeightOk('0')).toBe(false);
  });
});

// K36 (kullanıcı kararı 2026-11-14): nokta ve tam üç hane ağırlıkta iki türlü okunur; koli ölçümünde ondalık, tarife ve faturada sorulur.
describe('K36 ağırlıkta "1.500"', () => {
  it('koli ölçümünde sorulmadan ondalık: "1.500" = 1,5 kg', () => {
    expect(parseMeasureNumber('1.500')).toBe(1.5);
    expect(parseMeasureNumber('12.000')).toBe(12);
    expect(mobileParseNum('1.500')).toBe(1.5);
  });

  it.each([
    ['1.500', { decimal: 1.5, thousands: 1500 }],
    ['2.250', { decimal: 2.25, thousands: 2250 }],
    ['12.000', { decimal: 12, thousands: 12000 }],
    ['999.999', { decimal: 999.999, thousands: 999999 }],
    [' 1.500 kg', { decimal: 1.5, thousands: 1500 }],
    ['1.500KG', { decimal: 1.5, thousands: 1500 }],
    ['1.500 desi', { decimal: 1.5, thousands: 1500 }],
  ])('ambiguousWeightText(%j) iki okuma verir', (s, r) => {
    expect(ambiguousWeightText(s)).toEqual(r);
  });

  // K36 öncesi de okunmayan birimler (lb, lbs, kgs, kilo) belirsiz sayılmaz: lb hücresi kg sanılmasın
  it.each(['1,500', '1500', '1.5', '1.25', '0.500', '1234.500', '1.500.000', '1.500,5', '1,234.5', '', 'abc', '1.5000', '1.500 lb', '1.500 lbs', '1.500 kgs', '1.500 kilo'])(
    'ambiguousWeightText(%j) belirsiz değil',
    (s) => {
      expect(ambiguousWeightText(s)).toBeNull();
    },
  );

  it('belirsiz olmayan yazımların okuması değişmedi', () => {
    expect(parseMeasureNumber('1,500')).toBe(1.5);
    expect(parseMeasureNumber('1500')).toBe(1500);
    expect(parseMeasureNumber('1.5')).toBe(1.5);
    expect(parseTrNumber('1,500')).toBe(1.5);
    expect(parseTrNumber('1500')).toBe(1500);
    expect(parseTrNumber('1.5')).toBe(1.5);
  });
});

// Kullanıcı kararı 2026-11-14: İngilizcede "1,500" Türkçedeki "1.500"ın aynası; dosya ve PDF ikisini de (kanıt yoksa) sorar.
describe('K36: ayırıcıya göre iki türlü okunan ağırlık', () => {
  it('virgül: "1,500" İngilizce arayüzün sorusu; nokta varsayılan (Türkçe arayüz)', () => {
    expect(ambiguousWeightText('1,500', ',')).toEqual({ decimal: 1.5, thousands: 1500 });
    expect(ambiguousWeightText('12,000 kg', ',')).toEqual({ decimal: 12, thousands: 12000 });
    expect(ambiguousWeightText('1.500', ',')).toBeNull();
    expect(ambiguousWeightText('1,500')).toBeNull();
    expect(ambiguousWeightText('1,500', 'any')).toEqual({ decimal: 1.5, thousands: 1500 });
    expect(ambiguousWeightText('1.500', 'any')).toEqual({ decimal: 1.5, thousands: 1500 });
    for (const s of ['1,5', '0,500', '1,500.5', '1,500 lb', '1500']) expect(ambiguousWeightText(s, 'any'), s).toBeNull();
    expect(uiAmbiguousSeparator('tr')).toBe('.');
    expect(uiAmbiguousSeparator('en')).toBe(',');
  });

  it('koli ölçümü her iki dilde sorulmadan 1,5 kg (dil almaz): "1,500" ve "1.500"', () => {
    expect(parseMeasureNumber('1,500')).toBe(1.5);
    expect(parseMeasureNumber('1.500')).toBe(1.5);
    expect(mobileParseNum('1,500')).toBe(1.5);
  });
});
