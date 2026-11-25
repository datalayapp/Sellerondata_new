// Panel tarihleri ve "bugün" firma saat diliminde (rapor Y132). Cihaz saati bilerek Tokyo: firma saati atanınca sonuç
// cihaza bakmamalı; atanmamışken bugünkü gibi cihaza bakmalı.
process.env.TZ = 'Asia/Tokyo';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, describe, it } from 'node:test';

// `@deciship/core` kök dosyası uzantısız içe aktarma yapar (Vite çözer, düz Node çözmez): format-golden testindeki kanca.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const f = await import('../src/lib/format.ts');
const { setShellTimeZone } = await import('@sellerondata/shell/time-zone');

afterEach(() => setShellTimeZone(undefined));

const AT = '2026-10-27T14:32:10+03:00'; // 11:32Z

/** Eski ay listesi (Pano, tarayıcı saati): saat dilimi atanmamışken sonuç bununla aynı kalmalı. */
function oldLastMonths(n: number, now: Date): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

describe('saat dilimi atanmamışken bugünkü davranış', () => {
  it('tarih-saat ve gün tarayıcı saatinde', () => {
    f.setFormatLocale('tr');
    assert.equal(f.fmtDateTime(AT), '27 Eki 2026 20:32'); // Tokyo +09:00
    const now = new Date('2026-10-31T16:30:00Z'); // Tokyo 01:30, 1 Kasım
    assert.equal(f.isoDate(now), '2026-11-01');
    assert.equal(f.monthKey(now), '2026-11');
  });
  it('ay listesi eski hesapla aynı', () => {
    for (const at of ['2026-11-12T03:00:00Z', '2026-10-31T16:30:00Z', '2026-10-31T14:59:00Z', '2026-01-15T00:00:00Z', '2026-03-31T20:00:00Z']) {
      assert.deepEqual(f.recentMonthKeys(12, new Date(at)), oldLastMonths(12, new Date(at)), at);
    }
  });
});

describe('firma saat dilimi', () => {
  it('tarih-saat firma saatinde', () => {
    f.setFormatLocale('tr');
    setShellTimeZone('Europe/Istanbul');
    assert.equal(f.fmtDateTime(AT), '27 Eki 2026 14:32');
    f.setFormatLocale('en');
    assert.equal(f.fmtDateTime(AT), '27 Oct 2026, 14:32');
    f.setFormatLocale('tr');
  });

  it('gün kayması: gece yarısına yakın an firmanın gününe düşer', () => {
    f.setFormatLocale('tr');
    const late = '2026-10-27T22:30:00Z';
    setShellTimeZone('Europe/Istanbul');
    assert.equal(f.fmtDate(late), '28 Eki 2026'); // 01:30 TSİ
    setShellTimeZone('America/Los_Angeles');
    assert.equal(f.fmtDate(late), '27 Eki 2026'); // 15:30 PDT
    assert.equal(f.fmtDate(new Date(late)), '27 Eki 2026');
  });

  it('yalnız gün olan değer hiçbir saat diliminde kaymaz', () => {
    f.setFormatLocale('tr');
    for (const tz of [undefined, 'Europe/Istanbul', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      setShellTimeZone(tz);
      assert.equal(f.fmtDate('2026-10-27'), '27 Eki 2026', String(tz));
      assert.equal(f.fmtDateTime('2026-10-27'), '27 Eki 2026 00:00', String(tz));
    }
  });

  it('ay sınırında "bu ay" firma saatinde', () => {
    const now = new Date('2026-10-31T21:30:00Z'); // İstanbul 00:30, 1 Kasım; Los Angeles 14:30, 31 Ekim
    setShellTimeZone('Europe/Istanbul');
    assert.equal(f.isoDate(now), '2026-11-01');
    assert.equal(f.monthKey(now), '2026-11');
    assert.deepEqual(f.recentMonthKeys(3, now), ['2026-11', '2026-10', '2026-09']);
    setShellTimeZone('America/Los_Angeles');
    assert.equal(f.isoDate(now), '2026-10-31');
    assert.deepEqual(f.recentMonthKeys(3, now), ['2026-10', '2026-09', '2026-08']);
    // Yıl dönümü.
    setShellTimeZone('Europe/Istanbul');
    assert.deepEqual(f.recentMonthKeys(2, new Date('2026-12-31T21:00:00Z')), ['2027-01', '2026-12']);
    assert.deepEqual(f.recentMonthKeys(0, now), []);
  });

  it('yaz saatine geçiş: 2026-03-29 Berlin', () => {
    f.setFormatLocale('en');
    setShellTimeZone('Europe/Berlin');
    assert.equal(f.fmtDateTime('2026-03-29T00:30:00Z'), '29 Mar 2026, 01:30');
    assert.equal(f.fmtDateTime('2026-03-29T01:30:00Z'), '29 Mar 2026, 03:30');
    assert.equal(f.isoDate(new Date('2026-03-28T22:59:59Z')), '2026-03-28');
    assert.equal(f.isoDate(new Date('2026-03-28T23:00:00Z')), '2026-03-29');
    assert.equal(f.isoDate(new Date('2026-03-29T22:00:00Z')), '2026-03-30');
    assert.equal(f.monthKey(new Date('2026-03-31T21:59:59Z')), '2026-03');
    assert.equal(f.monthKey(new Date('2026-03-31T22:00:00Z')), '2026-04');
    f.setFormatLocale('tr');
  });

  it('kış saatine dönüş: 2026-11-01 New York', () => {
    f.setFormatLocale('tr');
    setShellTimeZone('America/New_York');
    assert.equal(f.fmtDateTime('2026-11-01T05:30:00Z'), '1 Kas 2026 01:30');
    assert.equal(f.fmtDateTime('2026-11-01T06:30:00Z'), '1 Kas 2026 01:30');
    assert.equal(f.isoDate(new Date('2026-11-01T03:59:59Z')), '2026-10-31');
    assert.equal(f.isoDate(new Date('2026-11-01T04:00:00Z')), '2026-11-01');
    assert.equal(f.isoDate(new Date('2026-11-02T04:59:59Z')), '2026-11-01');
    assert.equal(f.isoDate(new Date('2026-11-02T05:00:00Z')), '2026-11-02');
    assert.equal(f.monthKey(new Date('2026-11-01T03:59:59Z')), '2026-10');
    assert.equal(f.monthKey(new Date('2026-11-01T04:00:00Z')), '2026-11');
  });
});
