// Mesaj 12 Tur 0 (G): DeciShip panelinin biçimleme işlevlerinin (src/lib/format.ts) BUGÜNKÜ çıktısı.
// Beklenen çıktı `format-golden.snapshot.json` dosyasındadır. Varsayılan yalnız karşılaştırır;
// dosyayı yazmak/güncellemek için UPDATE_GOLDEN=1 (yalnız orkestratör onayıyla).
process.env.TZ = 'Europe/Istanbul';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { describe, it } from 'node:test';

// `@deciship/core` kök dosyası uzantısız içe aktarma yapar (Vite çözer, düz Node çözmez): yalnız bu test için çözümleyici kancası.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const f = await import('../src/lib/format.ts');

const SNAPSHOT = path.resolve(import.meta.dirname, 'format-golden.snapshot.json');
const LOCALES = ['tr', 'en'];
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
  lines.push(`${name}(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')}) => ${out}`);
}

describe('web format golden', () => {
  it('matris', () => {
    for (const loc of LOCALES) {
      f.setFormatLocale(loc);
      lines.push(`# locale=${loc} getFormatLocale=${f.getFormatLocale()}`);
      for (const n of [...NUMBERS, null, undefined, Number.NaN]) {
        rec('fmtNum', [n], () => f.fmtNum(n));
        rec('fmtNum', [n, 2, 2], () => f.fmtNum(n, 2, 2));
        rec('fmtNum', [n, 0, 0], () => f.fmtNum(n, 0, 0));
        rec('fmtNum', [n, 0, 3], () => f.fmtNum(n, 0, 3));
        for (const c of CURRENCIES) {
          rec('fmtMoney', [n, c], () => f.fmtMoney(n, c));
          rec('fmtMoneySigned', [n, c], () => f.fmtMoneySigned(n, c));
        }
        rec('fmtMoney', [n], () => f.fmtMoney(n));
        rec('fmtMoney', [n, null], () => f.fmtMoney(n, null));
        rec('fmtMoneySigned', [n], () => f.fmtMoneySigned(n));
        rec('fmtKg', [n], () => f.fmtKg(n));
        rec('fmtDims', [n, 2.5, 40.05], () => f.fmtDims(n, 2.5, 40.05));
        rec('fmtPct', [n], () => f.fmtPct(n));
        rec('numToInput', [n], () => f.numToInput(n));
        rec('numToInput', [n, 1], () => f.numToInput(n, 1));
      }
      rec('fmtDims', [null, 1, 1], () => f.fmtDims(null, 1, 1));
      for (const d of [...DATES, null, undefined, '', '2026-10-27T23:30:00+00:00']) {
        rec('fmtDate', [d], () => f.fmtDate(d));
        rec('fmtDateTime', [d], () => f.fmtDateTime(d));
      }
      rec('fmtDate', ['Date(2026-10-27T14:32:10+03:00)'], () => f.fmtDate(new Date('2026-10-27T14:32:10+03:00')));
      rec('fmtDateTime', ['Date(2026-10-27T14:32:10+03:00)'], () => f.fmtDateTime(new Date('2026-10-27T14:32:10+03:00')));
      rec('fmtDateTime', ['Date(Invalid)'], () => f.fmtDateTime(new Date('abc')));
      rec('isoDate', ['Date(2026-10-27T23:30:00+03:00)'], () => f.isoDate(new Date('2026-10-27T23:30:00+03:00')));
      rec('monthKey', ['Date(2026-10-27T23:30:00+03:00)'], () => f.monthKey(new Date('2026-10-27T23:30:00+03:00')));
      for (const k of ['2026-10', '2026-01', 'abc', '']) rec('monthLabel', [k], () => f.monthLabel(k));
    }
    f.setFormatLocale('tr');

    const actual = JSON.stringify(lines, null, 1) + '\n';
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.writeFileSync(SNAPSHOT, actual);
      return;
    }
    assert.ok(fs.existsSync(SNAPSHOT), 'format-golden.snapshot.json yok; UPDATE_GOLDEN=1 ile üret (orkestratör onayıyla)');
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as string[];
    assert.equal(lines.length, expected.length, 'satır sayısı değişti');
    lines.forEach((l, i) => assert.equal(l, expected[i], `satır ${i + 1}`));
  });
});
