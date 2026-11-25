// Mesaj 12 Tur 0 (G): kabuk (shell) biçimleme işlevlerinin BUGÜNKÜ çıktısı. Güncelleme yalnız orkestratör onayıyla (-u).
process.env.TZ = 'Europe/Istanbul';
import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDays,
  formatHubValue,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
} from '../src/format.ts';

const LOCALES = ['tr', 'en'];
const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'XXX1'];
const NUMBERS = [-1234.567, -0.004, 0, 0.005, 2.5, 1234567.891];
const DATES = ['2026-10-27', '2026-10-27T14:32:10+03:00', 'abc'];
const NOW = Date.parse('2026-10-27T15:00:00+03:00');

const lines: string[] = [];
function rec(name: string, args: unknown[], fn: () => unknown): void {
  let out: string;
  try {
    out = JSON.stringify(fn());
  } catch {
    out = `THROWS: ${name}`;
  }
  lines.push(`${name}(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')}) => ${out}`);
}

describe('shell format golden', () => {
  it('matris', async () => {
    for (const loc of LOCALES) {
      for (const n of NUMBERS) {
        rec('formatNumber', [n, loc], () => formatNumber(n, loc));
        rec('formatNumber', [n, loc, { maximumFractionDigits: 2 }], () => formatNumber(n, loc, { maximumFractionDigits: 2 }));
        for (const c of CURRENCIES) {
          rec('formatMoney', [n, c, loc], () => formatMoney(n, c, loc));
          rec('formatMoney', [n, c, loc, { signed: true }], () => formatMoney(n, c, loc, { signed: true }));
          rec('formatMoney', [n, c, loc, { compact: true }], () => formatMoney(n, c, loc, { compact: true }));
        }
        rec('formatMoney', [n, undefined, loc], () => formatMoney(n, undefined, loc));
        rec('formatPercent', [n, loc], () => formatPercent(n, loc));
        rec('formatPercent', [n, loc, 0], () => formatPercent(n, loc, 0));
        rec('formatDays', [n, loc], () => formatDays(n, loc));
      }
      for (const d of DATES) {
        rec('formatDate', [d, loc], () => formatDate(d, loc));
        rec('formatDateTime', [d, loc], () => formatDateTime(d, loc));
        rec('formatRelative', [d, loc, 'NOW'], () => formatRelative(d, loc, NOW));
        for (const d2 of DATES) rec('formatDateRange', [d, d2, loc], () => formatDateRange(d, d2, loc));
      }
      rec('formatRelative', ['2026-10-27T14:00:00+03:00', loc, 'NOW'], () => formatRelative('2026-10-27T14:00:00+03:00', loc, NOW));
      rec('formatRelative', ['2026-10-24T15:00:00+03:00', loc, 'NOW'], () => formatRelative('2026-10-24T15:00:00+03:00', loc, NOW));
      rec('formatRelative', ['2026-08-24T15:00:00+03:00', loc, 'NOW'], () => formatRelative('2026-08-24T15:00:00+03:00', loc, NOW));
      for (const [format, value, currency] of [
        ['money', 1234.5, 'TRY'],
        ['money', -0.004, 'USD'],
        ['money', 5, 'CHF'],
        ['money', 5, 'XXX1'],
        ['number', 1234567.891, undefined],
        ['percent', 86.4, undefined],
        ['duration_days', 2.5, undefined],
        ['date', '2026-10-27', undefined],
        ['datetime', '2026-10-27T14:32:10+03:00', undefined],
        ['date', 'abc', undefined],
        ['money', null, 'TRY'],
        ['money', 'x', 'TRY'],
        ['text', 'merhaba', undefined],
      ] as const) {
        const v = { value, format, currency } as never;
        rec('formatHubValue', [{ value, format, currency }, loc], () => formatHubValue(v, loc));
      }
    }
    // Mesaj 12 R4: yarım kuruş (ikili gösterimde yarımın altında kalan) değerler hesap motorunun round2'si gibi yukarı.
    for (const loc of LOCALES) {
      for (const n of [1.005, -1.005, 2.675, 0.285, 580.545, 9.995]) {
        rec('formatMoney', [n, 'TRY', loc], () => formatMoney(n, 'TRY', loc));
        rec('formatNumber', [n, loc, { maximumFractionDigits: 2 }], () => formatNumber(n, loc, { maximumFractionDigits: 2 }));
        rec('formatPercent', [n, loc, 2], () => formatPercent(n, loc, 2));
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__golden__/formatGolden.shell.txt');
  });
});
