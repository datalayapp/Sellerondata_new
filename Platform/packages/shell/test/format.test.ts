import { formatMoney, safeHref } from '../src/format.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('formatMoney', () => {
  it('geçersiz para kodunda hata fırlatmaz; sayı ve kod yazılır', () => {
    expect(() => formatMoney(1234.5, 'XXX1', 'tr')).not.toThrow();
    expect(formatMoney(1234.5, 'XXX1', 'tr')).toBe('1.234,50 XXX1');
    // Y72-3: bilinmeyen kod ile tutar arası boşluk (eskiden 'XXX11,234.50' bitişikti); ekranda bölünmez boşluk.
    expect(formatMoney(1234.5, 'XXX1', 'en')).toBe(`XXX1${String.fromCharCode(0xa0)}1,234.50`);
    expect(formatMoney(-5, 'XXX1', 'tr', { signed: true })).toBe('−5,00 XXX1');
  });
  it('geçerli kodda eski biçim', () => {
    expect(formatMoney(2143.2, 'TRY', 'tr')).toBe('2.143,20 ₺');
    expect(formatMoney(2143.2, 'TRY', 'en')).toBe('₺2,143.20');
  });
});

describe('safeHref', () => {
  it('ters bölü, //, denetim karakteri reddedilir', () => {
    expect(safeHref('/\\kotu.site')).toBeUndefined();
    expect(safeHref('//x')).toBeUndefined();
    expect(safeHref('/a\tb')).toBeUndefined();
    expect(safeHref('https://x.com')).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });
  it('aynı kökenli yol geçer', () => {
    expect(safeHref('/home?x=1')).toBe('/home?x=1');
    expect(safeHref('/home', 'https://app.sellerondata.com')).toBe('/home');
  });
});
