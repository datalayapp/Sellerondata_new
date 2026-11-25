import { describe, expect, it } from 'vitest';
import { checkTariffImport, convertPastedNumber, isAmbiguousNumberText, otherCurrencyCheckSection, parseTariffImport, parseTrNumber, readPastedNumbers, type Locale } from '../src/index';

describe('otherCurrencyCheckSection', () => {
  const issue = (locale: Locale, ctx: { currentSurcharges?: { code: string; name: string; kind: string; amount: number }[]; currentOverflow?: { zone: string; perUnit: number }[] }) => {
    const parsed = parseTariffImport({ fileName: 'x.xlsx', kind: 'xlsx', prices: [['Ağırlık', 'A'], ['1', '10'], ['2', '20']], zones: null, surcharges: null });
    return checkTariffImport(parsed, { tariffCurrency: 'TRY', currentZones: [{ country: 'DE', zone: 'A' }], currentRates: [], ...ctx }, { currency: 'USD' }, locale).find((i) => i.code === 'SURCHARGES_OTHER_CURRENCY')!;
  };
  const sc = [{ code: 'A', name: 'Ad', kind: 'FIXED', amount: 5 }];
  const of = [{ zone: 'A', perUnit: 3 }];
  it.each(['tr', 'en'] as const)('%s: üretilen başlıktan doğru bölüm', (locale) => {
    expect(otherCurrencyCheckSection(issue(locale, { currentSurcharges: sc }))).toBe('surcharges');
    expect(otherCurrencyCheckSection(issue(locale, { currentSurcharges: sc, currentOverflow: of }))).toBe('surcharges');
    expect(otherCurrencyCheckSection(issue(locale, { currentOverflow: of }))).toBe('overflow');
  });
  it('başka kontrol için sonuç yok', () => {
    expect(otherCurrencyCheckSection({ code: 'PRICE_JUMP', title: 'ek ücretleri kontrol edin' })).toBeNull();
  });
});

describe('isAmbiguousNumberText', () => {
  it.each(['1.234', '1,234', '2.500', '999,125', '-1.234', '1.234 ₺'])('%s belirsiz', (s) => {
    expect(isAmbiguousNumberText(s)).toBe(true);
  });
  it.each(['12', '12,5', '12.5', '1,23', '0.500', '0,500', '1234.567', '1.234,50', '1,234.50', '1.234.567', '1,234,567', 'abc', '', '1.2.3'])('%s belirsiz değil', (s) => {
    expect(isAmbiguousNumberText(s)).toBe(false);
  });
});

describe('readPastedNumbers', () => {
  it.each([
    [['1.234', '0,5'], 'tr'],
    [['1.234', '1.234,50'], 'tr'],
    [['2.500', '1.234.567'], 'tr'],
    [['2.500', '0,500'], 'tr'],
    [['1,234', '0.5'], 'en'],
    [['1,234', '1,234.50'], 'en'],
    [['2,500', '1,234,567'], 'en'],
    [['2,500', '0.500'], 'en'],
    [['2,500', '1234.567'], 'en'],
    [['1.234 ₺', '12,50 ₺'], 'tr'],
    [['$1,234', '$12.50'], 'en'],
  ])('%j → %s', (cells, format) => {
    expect(readPastedNumbers(cells)).toEqual({ format, ambiguous: [] });
  });
  it('kanıt yok, belirsiz hücreler listelenir', () => {
    expect(readPastedNumbers(['1.234', '100', '', ' 2,500 ', 'yok'])).toEqual({ format: null, ambiguous: ['1.234', '2,500'] });
  });
  it('iki yönde kanıt: biçim yok; belirsiz hücre varsa sorulur', () => {
    expect(readPastedNumbers(['1,5', '1.5', '1.234'])).toEqual({ format: null, ambiguous: ['1.234'] });
    expect(readPastedNumbers(['12,50', '12.50', '1.234'])).toEqual({ format: null, ambiguous: ['1.234'] });
    expect(readPastedNumbers(['12,50', '12.50'])).toEqual({ format: null, ambiguous: [] });
  });
  it('sayı yoksa sorulmaz', () => {
    expect(readPastedNumbers(['A', 'B', ''])).toEqual({ format: null, ambiguous: [] });
    expect(readPastedNumbers([])).toEqual({ format: null, ambiguous: [] });
  });
});

describe('convertPastedNumber', () => {
  it('biçim etkin dille aynıysa metne dokunmaz', () => {
    expect(convertPastedNumber('1.234,50', 'tr', 'tr')).toBe('1.234,50');
    expect(convertPastedNumber('1,234.50', 'en', 'en')).toBe('1,234.50');
  });
  it.each([
    ['1.234', 'tr', 'en', '1234'],
    ['1.234,50', 'tr', 'en', '1234.5'],
    ['0,5', 'tr', 'en', '0.5'],
    ['1,234', 'tr', 'en', '1.234'],
    ['1,234', 'en', 'tr', '1234'],
    ['1.234', 'en', 'tr', '1,234'],
    ['1,234.50', 'en', 'tr', '1234,5'],
    ['0.5', 'en', 'tr', '0,5'],
  ] as const)('%s (%s) → %s: %s', (cell, from, to, out) => {
    expect(convertPastedNumber(cell, from, to)).toBe(out);
  });
  it('sayı olmayan hücre korunur', () => {
    expect(convertPastedNumber('yok', 'tr', 'en')).toBe('yok');
    expect(convertPastedNumber('1000+', 'tr', 'en')).toBe('1000+');
    expect(convertPastedNumber('-', 'en', 'tr')).toBe('-');
  });
  it('gidiş-dönüş: kaynak biçimdeki değer etkin dilde aynı sayıya döner', () => {
    const fmt = (v: number, l: Locale) => new Intl.NumberFormat(l === 'en' ? 'en-US' : 'tr-TR', { maximumFractionDigits: 3 }).format(v);
    let s = 7;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 4000; i++) {
      const v = Math.round(rnd() * [10, 1000, 1000000][i % 3]! * 1000) / 1000;
      for (const [from, to] of [['tr', 'en'], ['en', 'tr']] as const) {
        expect(parseTrNumber(convertPastedNumber(fmt(v, from), from, to), to), `${v} ${from}→${to}`).toBeCloseTo(v, 9);
      }
    }
  });
});
