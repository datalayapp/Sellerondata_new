// Mesaj 12 Tur 0 (G): mobil biçimleme dosyalarının (src/lib/format.ts ve src/hub/format.ts) BUGÜNKÜ çıktısı.
// Güncelleme yalnız orkestratör onayıyla (-u).
process.env.TZ = 'Europe/Istanbul';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '../src/i18n';
import * as lib from '../src/lib/format';
import * as hub from '../src/hub/format';

const LOCALES = ['tr', 'en'] as const;
const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'XXX1'];
const NUMBERS = [-1234.567, -0.004, 0, 0.005, 2.5, 1234567.891];
const DATES = ['2026-10-27', '2026-10-27T14:32:10+03:00', 'abc'];
const NOW = Date.parse('2026-11-11T12:00:00+03:00');

function line(name: string, args: unknown[], fn: () => unknown): string {
  let out: string;
  try {
    out = JSON.stringify(fn());
  } catch {
    out = `THROWS: ${name}`;
  }
  return `${name}(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')}) => ${out}`;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

describe('mobil format golden', () => {
  it('src/lib/format.ts', async () => {
    const lines: string[] = [];
    const rec = (name: string, args: unknown[], fn: () => unknown) => lines.push(line(name, args, fn));
    for (const loc of LOCALES) {
      await i18n.changeLanguage(loc);
      lines.push(`# lib locale=${loc} getFormatLocale=${lib.getFormatLocale()}`);
      for (const n of [...NUMBERS, null, undefined, Number.NaN]) {
        rec('lib.fmtNum', [n], () => lib.fmtNum(n));
        rec('lib.fmtNum', [n, 2], () => lib.fmtNum(n, 2));
        rec('lib.fmtNum', [n, 0], () => lib.fmtNum(n, 0));
        rec('lib.fmtNum', [n, 1, true], () => lib.fmtNum(n, 1, true));
        rec('lib.fmtInput', [n], () => lib.fmtInput(n));
        rec('lib.fmtInput', [n, 1], () => lib.fmtInput(n, 1));
        rec('lib.fmtKg', [n], () => lib.fmtKg(n));
        if (typeof n === 'number') rec('lib.fmtDims', [n, 2.5, 40.05], () => lib.fmtDims(n, 2.5, 40.05));
      }
      for (const s of ['4,5', '4.5', '', '1234']) rec('lib.showDecimal', [s], () => lib.showDecimal(s));
      const moments = [...DATES, '2026-11-11T09:05:00+03:00', '2026-11-10T23:59:00+03:00', '2025-12-31T23:59:00+03:00', '2026-11-11T00:00:00+03:00', '2026-11-11T15:00:00+03:00'];
      for (const d of moments) {
        rec('lib.fmtTime', [d], () => lib.fmtTime(d));
        rec('lib.fmtWhen', [d], () => lib.fmtWhen(d));
        rec('lib.fmtDateTime', [d], () => lib.fmtDateTime(d));
        rec('lib.dayKey', [d], () => lib.dayKey(d));
        rec('lib.fmtDayTitle', [d], () => lib.fmtDayTitle(d));
        rec('lib.isToday', [d], () => lib.isToday(d));
      }
      rec('lib.fmtToday', ['NOW'], () => lib.fmtToday());
      rec('lib.fmtToday', ['2026-01-01T12:00'], () => lib.fmtToday(new Date('2026-01-01T12:00:00+03:00')));
      for (const m of ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET', 'OTHER']) rec('lib.dimMethodLabel', [m], () => lib.dimMethodLabel(m));
      for (const k of ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER', 'X']) rec('lib.kindLabel', [k], () => lib.kindLabel(k));
    }
    await i18n.changeLanguage('tr');
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__golden__/formatGolden.mobile-lib.txt');
  });

  it('src/hub/format.ts', async () => {
    const out: string[] = [];
    const r = (name: string, args: unknown[], fn: () => unknown) => out.push(line(name, args, fn));
    for (const loc of LOCALES) {
      const en = loc === 'en';
      const ctx = { lng: loc, units: { days: en ? 'days' : 'gün', points: en ? 'pts' : 'puan', thousand: en ? 'K' : 'B', million: en ? 'M' : 'Mn' } };
      out.push(`# hub locale=${loc}`);
      for (const n of NUMBERS) {
        r('hub.number', [n, loc], () => hub.number(n, loc));
        r('hub.number', [n, loc, 1, 1], () => hub.number(n, loc, 1, 1));
        for (const c of CURRENCIES) r('hub.money', [n, c, loc], () => hub.money(n, c, loc));
        r('hub.money', [n, undefined, loc], () => hub.money(n, undefined, loc));
        r('hub.percent', [n, loc], () => hub.percent(n, loc));
        r('hub.percent', [n, loc, 0], () => hub.percent(n, loc, 0));
        for (const f of ['money', 'number', 'percent', 'duration_days'] as const) {
          r('hub.hubValue', [{ value: n, format: f, currency: 'USD' }], () => hub.hubValue({ value: n, format: f, currency: 'USD' } as never, ctx));
        }
        for (const f of ['money', 'number', 'percent'] as const) r('hub.axisValue', [n, f], () => hub.axisValue(n, f, ctx));
      }
      for (const v of [null, '', Number.NaN, 'x']) r('hub.hubValue', [v], () => hub.hubValue({ value: v, format: 'money', currency: 'TRY' } as never, ctx));
      for (const f of ['date', 'datetime'] as const) for (const d of DATES) r('hub.hubValue', [{ value: d, format: f }], () => hub.hubValue({ value: d, format: f } as never, ctx));
      for (const d of DATES) {
        r('hub.date', [d, loc], () => hub.date(d, loc));
        r('hub.dateTime', [d, loc], () => hub.dateTime(d, loc));
        r('hub.dayMonth', [d, loc], () => hub.dayMonth(d, loc));
        r('hub.ago', [d, loc, 'NOW'], () => hub.ago(d, loc, NOW));
        for (const d2 of DATES) r('hub.dateRange', [d, d2, loc], () => hub.dateRange(d, d2, loc));
      }
      for (const iso of ['2026-11-11T11:30:00+03:00', '2026-11-11T11:59:30+03:00', '2026-11-11T05:00:00+03:00', '2026-11-01T12:00:00+03:00', '2026-08-01T12:00:00+03:00']) {
        r('hub.ago', [iso, loc, 'NOW'], () => hub.ago(iso, loc, NOW));
        r('hub.updatedAt', [Date.parse(iso), loc, 'NOW'], () => hub.updatedAt(Date.parse(iso), loc, NOW));
      }
      for (const [value, previous, format] of [[120, 100, 'number'], [80, 100, 'money'], [5, 0, 'money'], [60, 55.5, 'percent'], [100, 100, 'number']] as const) {
        const k = { value, previous, format, goodDirection: 'up', currency: 'TRY' };
        r('hub.kpiDelta', [k], () => hub.kpiDelta(k as never, ctx));
      }
    }
    await expect(out.join('\n') + '\n').toMatchFileSnapshot('./__golden__/formatGolden.mobile-hub.txt');
  });
});
