// Merkez dönemleri firma saat diliminde (rapor Y132). Cihaz saati bilerek Tokyo.
process.env.TZ = 'Asia/Tokyo';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setShellTimeZone } from '@sellerondata/shell/time-zone';
import { DUE_DATE_TIME_ZONE, daysUntil, isoDay, rangeDates } from './period.ts';

afterEach(() => setShellTimeZone(undefined));

/** Eski hesap (tarayıcı saati, yerel takvim aritmetiği): saat dilimi atanmamışken sonuç bununla aynı kalmalı. */
function oldRangeDates(key, now) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const start = new Date(now);
  if (key === 'mtd') start.setDate(1);
  else start.setDate(start.getDate() - ((key === '7d' ? 7 : key === '90d' ? 90 : 30) - 1));
  return { from: day(start), to: day(now) };
}

test('saat dilimi atanmamışsa eski hesapla aynı (tarayıcı saati)', () => {
  for (const at of [
    '2026-11-11T21:30:00Z',
    '2026-11-11T14:59:59Z',
    '2026-11-11T15:00:00Z',
    '2026-03-01T00:00:00Z',
    '2026-12-31T16:00:00Z',
    '2026-03-29T01:30:00Z',
  ]) {
    for (const key of ['7d', '30d', 'mtd', '90d']) {
      assert.deepEqual(rangeDates(key, new Date(at)), oldRangeDates(key, new Date(at)), `${key} ${at}`);
    }
  }
});

test('gün kayması: aynı an firmanın gününe düşer', () => {
  const now = new Date('2026-11-11T21:30:00Z'); // İstanbul 00:30, 12 Kasım; Los Angeles 13:30, 11 Kasım
  assert.equal(isoDay(now, 'Europe/Istanbul'), '2026-11-12');
  assert.equal(isoDay(now, 'America/Los_Angeles'), '2026-11-11');
  assert.deepEqual(rangeDates('7d', now, 'Europe/Istanbul'), { from: '2026-11-06', to: '2026-11-12' });
  assert.deepEqual(rangeDates('30d', now, 'Europe/Istanbul'), { from: '2026-10-14', to: '2026-11-12' });
  assert.deepEqual(rangeDates('90d', now, 'Europe/Istanbul'), { from: '2026-08-15', to: '2026-11-12' });
  assert.deepEqual(rangeDates('mtd', now, 'Europe/Istanbul'), { from: '2026-11-01', to: '2026-11-12' });
  assert.deepEqual(rangeDates('7d', now, 'America/Los_Angeles'), { from: '2026-11-05', to: '2026-11-11' });
});

test('varsayılan saat dilimi kabuktan (setShellTimeZone)', () => {
  const now = new Date('2026-11-11T21:30:00Z');
  assert.equal(isoDay(now), '2026-11-12'); // Tokyo 06:30
  setShellTimeZone('America/Los_Angeles');
  assert.equal(isoDay(now), '2026-11-11');
  assert.deepEqual(rangeDates('mtd', now), { from: '2026-11-01', to: '2026-11-11' });
  setShellTimeZone('Europe/Istanbul');
  assert.deepEqual(rangeDates('7d', now), { from: '2026-11-06', to: '2026-11-12' });
});

test('yaz saatine geçiş: 2026-03-29 Berlin', () => {
  assert.equal(isoDay(new Date('2026-03-28T22:59:59Z'), 'Europe/Berlin'), '2026-03-28');
  assert.equal(isoDay(new Date('2026-03-28T23:00:00Z'), 'Europe/Berlin'), '2026-03-29');
  assert.equal(isoDay(new Date('2026-03-29T21:59:59Z'), 'Europe/Berlin'), '2026-03-29');
  const now = new Date('2026-03-29T22:30:00Z'); // 00:30 CEST, 30 Mart
  assert.deepEqual(rangeDates('7d', now, 'Europe/Berlin'), { from: '2026-03-24', to: '2026-03-30' });
  assert.deepEqual(rangeDates('30d', now, 'Europe/Berlin'), { from: '2026-03-01', to: '2026-03-30' });
  assert.deepEqual(rangeDates('mtd', now, 'Europe/Berlin'), { from: '2026-03-01', to: '2026-03-30' });
});

test('kış saatine dönüş: 2026-11-01 New York', () => {
  assert.equal(isoDay(new Date('2026-11-01T03:59:59Z'), 'America/New_York'), '2026-10-31');
  assert.equal(isoDay(new Date('2026-11-01T04:00:00Z'), 'America/New_York'), '2026-11-01');
  const now = new Date('2026-11-02T04:30:00Z'); // 23:30 EST, 1 Kasım
  assert.deepEqual(rangeDates('mtd', now, 'America/New_York'), { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(rangeDates('7d', now, 'America/New_York'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(rangeDates('mtd', new Date('2026-11-01T03:30:00Z'), 'America/New_York'), { from: '2026-10-01', to: '2026-10-31' });
});

test('itiraz son günü firma saatinden bağımsız, sabit Türkiye günü', () => {
  assert.equal(DUE_DATE_TIME_ZONE, 'Europe/Istanbul');
  const now = new Date('2026-11-11T21:30:00Z'); // İstanbul 12 Kasım
  for (const tz of [undefined, 'America/Los_Angeles', 'Asia/Tokyo']) {
    setShellTimeZone(tz);
    assert.equal(daysUntil('2026-11-13T10:00:00Z', now), 1);
    assert.equal(daysUntil('2026-11-12', now), 0);
    assert.equal(daysUntil('2026-11-11T20:59:00Z', now), -1); // 23:59 TSİ, 11 Kasım: dün
  }
});
