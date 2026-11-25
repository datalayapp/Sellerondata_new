// Mesaj 12 Tur 0 (G): çekirdek biçimleme işlevlerinin BUGÜNKÜ çıktısı. Geçişten sonra fark çıkarsa kayıt değil kod incelenir.
// Güncelleme yalnız orkestratör onayıyla: `npx vitest run -u test/formatGolden.test.ts`.
process.env.TZ = 'Europe/Istanbul';
import { describe, expect, it } from 'vitest';
import {
  currencySymbol,
  fmtDate,
  fmtDims,
  fmtKg,
  fmtLongDay,
  fmtMoney,
  fmtMoneyEn,
  fmtNumber,
  fmtNumberInput,
  fmtPct,
  fmtWeightNumber,
} from '../src/format';

const LOCALES = ['tr', 'en'] as const;
const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'XXX1'];
const NUMBERS = [-1234.567, -0.004, 0, 0.005, 2.5, 1234567.891];
const DATES = ['2026-10-27', '2026-10-27T14:32:10+03:00', 'abc'];

const lines: string[] = [];
function rec(name: string, args: unknown[], fn: () => unknown): void {
  let out: string;
  try {
    out = JSON.stringify(fn());
  } catch {
    out = `THROWS: ${name}`;
  }
  lines.push(`${name}(${args.map((a) => (a === undefined ? 'undefined' : typeof a === 'number' && !Number.isFinite(a) ? String(a) : JSON.stringify(a))).join(', ')}) => ${out}`);
}

describe('core format golden', () => {
  it('matris', async () => {
    for (const c of CURRENCIES) rec('currencySymbol', [c], () => currencySymbol(c));
    rec('currencySymbol', [], () => currencySymbol());
    for (const loc of LOCALES) {
      for (const n of NUMBERS) {
        for (const d of [0, 1, 2, 3]) rec('fmtNumber', [n, d, loc], () => fmtNumber(n, d, loc));
        for (const c of CURRENCIES) rec('fmtMoney', [n, c, loc], () => fmtMoney(n, c, loc));
        rec('fmtMoney', [n, undefined, loc], () => fmtMoney(n, undefined, loc));
        rec('fmtWeightNumber', [n, loc], () => fmtWeightNumber(n, loc));
        rec('fmtKg', [n, loc], () => fmtKg(n, loc));
        rec('fmtDims', [{ l: n, w: 2.5, h: 40.05 }, loc], () => fmtDims({ l: n, w: 2.5, h: 40.05 }, loc));
        rec('fmtPct', [n, loc], () => fmtPct(n, loc));
        for (const k of [0, 1, 3]) rec('fmtNumberInput', [n, k, loc], () => fmtNumberInput(n, k, loc));
      }
      for (const d of DATES) {
        rec('fmtDate', [d, loc], () => fmtDate(d, loc));
        rec('fmtLongDay', [d, loc], () => fmtLongDay(d, loc));
      }
    }
    for (const n of NUMBERS) for (const c of CURRENCIES) rec('fmtMoneyEn', [n, c], () => fmtMoneyEn(n, c));
    rec('fmtMoneyEn', [1234.5], () => fmtMoneyEn(1234.5));
    // Mesaj 12 R4: kenar durumlar bugünkü çıktıyla sabitlenir (sonlu olmayan, çok büyük, yarım kuruş, para kodu yazımı).
    const EDGE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21, 1.005, -1.005, 2.675, 580.545];
    for (const loc of LOCALES) {
      for (const n of EDGE) {
        for (const d of [0, 2, 3]) rec('fmtNumber', [n, d, loc], () => fmtNumber(n, d, loc));
        rec('fmtMoney', [n, 'TRY', loc], () => fmtMoney(n, 'TRY', loc));
        rec('fmtPct', [n, loc], () => fmtPct(n, loc));
      }
      for (const c of ['', ' TRY', 'try', 'chf']) rec('fmtMoney', [12.5, c, loc], () => fmtMoney(12.5, c, loc));
    }
    for (const n of EDGE) rec('fmtMoneyEn', [n, 'TRY'], () => fmtMoneyEn(n, 'TRY'));
    for (const c of ['', ' TRY', 'try']) rec('currencySymbol', [c], () => currencySymbol(c));
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__golden__/formatGolden.core.txt');
  });
});
