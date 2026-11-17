import { describe, expect, it } from 'vitest';
import { excelSerialToIso, fmtDate, fmtDims, fmtKg, fmtMoney, fmtMoneyEn, fmtNumber, fmtPct, parseTrDate, parseTrNumber } from '../src/index';

describe('fmtMoney / fmtKg', () => {
  it.each([
    [1184, undefined, '1.184,00 ₺'],
    [458.5, 'TRY', '458,50 ₺'],
    [-458.5, 'TRY', '-458,50 ₺'],
    [1234567.891, 'TRY', '1.234.567,89 ₺'],
    [0, 'TRY', '0,00 ₺'],
    [12.5, 'EUR', '12,50 €'],
    [12.5, 'USD', '12,50 $'],
    [12.5, 'CHF', '12,50 CHF'],
    [1.005, 'TRY', '1,01 ₺'],
  ])('fmtMoney(%s, %s) = %s', (n, c, s) => {
    expect(fmtMoney(n, c)).toBe(s);
  });
  it('fmtMoneyEn', () => {
    expect(fmtMoneyEn(2143.2)).toBe('2,143.20 TRY');
  });
  it.each([
    [4.02, '4,02 kg'],
    [6, '6,0 kg'],
    [9.5, '9,5 kg'],
    [4.025, '4,025 kg'],
    [1250, '1.250,0 kg'],
  ])('fmtKg(%s) = %s', (n, s) => {
    expect(fmtKg(n)).toBe(s);
  });
  it('diğer biçimler', () => {
    expect(fmtNumber(1234.5)).toBe('1.234,50');
    expect(fmtNumber(1234.5, 0)).toBe('1.235');
    expect(fmtDims({ l: 40, w: 30.5, h: 25 })).toBe('40×30,5×25');
    expect(fmtPct(27.5)).toBe('%27,5');
    expect(fmtDate('2026-10-27')).toBe('27.10.2026');
  });
});

describe('parseTrNumber', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1234.56', 1234.56],
    ['4,0', 4],
    ['4,02', 4.02],
    ['1,234.56', 1234.56],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1234,56', 1234.56],
    ['1.234', 1234],
    ['0.500', 0.5],
    ['4.8', 4.8],
    ['12', 12],
    ['-805,35', -805.35],
    ['-805.35', -805.35],
    ['(12,50)', -12.5],
    ['12,50-', -12.5],
    ['1.184,00 ₺', 1184],
    ['₺1.184,00', 1184],
    ['1 184,00 TL', 1184],
    ['1.642,50 TRY', 1642.5],
    ['4,0 kg', 4],
    ['%25', 25],
    ['+3,5', 3.5],
    [',5', 0.5],
    ['1 234,5', 1234.5],
  ])('%s → %s', (s, n) => {
    expect(parseTrNumber(s)).toBe(n);
  });
  it.each([[''], ['  '], ['abc'], ['1.2.3,4.5'], ['12a'], ['1,2,3'], ['-']])('%j → null', (s) => {
    expect(parseTrNumber(s)).toBeNull();
  });
  it('sayı ve null girdileri', () => {
    expect(parseTrNumber(12.5)).toBe(12.5);
    expect(parseTrNumber(null)).toBeNull();
    expect(parseTrNumber(undefined)).toBeNull();
    expect(parseTrNumber(Number.NaN)).toBeNull();
  });
});

describe('parseTrDate', () => {
  it.each([
    ['27.10.2026', '2026-10-27'],
    ['2026-10-27', '2026-10-27'],
    ['2026-10-27T14:12:00+03:00', '2026-10-27'],
    ['2026/10/27', '2026-10-27'],
    ['10/27/2026', '2026-10-27'],
    ['27/10/2026', '2026-10-27'],
    ['05/06/2026', '2026-06-05'],
    ['5.6.2026', '2026-06-05'],
    ['27.10.26', '2026-10-27'],
    ['27.10.2026 09:42', '2026-10-27'],
    ['27-10-2026', '2026-10-27'],
    ['20261027', '2026-10-27'],
    ['27 Ekim 2026', '2026-10-27'],
    ['27 Şubat 2026', '2026-02-27'],
    ['Oct 27, 2026', '2026-10-27'],
    ['27-Oct-2026', '2026-10-27'],
    ['46322', '2026-10-27'],
    ['46322,5', '2026-10-27'],
  ])('%s → %s', (s, d) => {
    expect(parseTrDate(s)).toBe(d);
  });
  it('Excel seri sayısı (number)', () => {
    expect(parseTrDate(46322)).toBe('2026-10-27');
    expect(excelSerialToIso(45658)).toBe('2025-01-01');
    expect(excelSerialToIso(61)).toBe('1900-03-01');
  });
  it('Date nesnesi', () => {
    expect(parseTrDate(new Date(Date.UTC(2026, 9, 27)))).toBe('2026-10-27');
  });
  it.each([['31.02.2026'], ['13/13/2026'], ['abc'], [''], ['12']])('%j → null', (s) => {
    expect(parseTrDate(s)).toBeNull();
  });
  it('küçük sayılar tarih değildir', () => {
    expect(parseTrDate(12)).toBeNull();
  });
});
