// Saat dilimindeki takvim günü (rapor Y132). Cihaz saati bilerek firmanınkinden farklı: sonuç cihaza değil verilen saat dilimine bakmalı.
process.env.TZ = 'Asia/Tokyo';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, addMonths, isTimeZone, zonedDay } from '../src/zoned.ts';

describe('zonedDay', () => {
  it('gün kayması: aynı an farklı saat diliminde farklı gün', () => {
    const at = new Date('2026-10-27T22:30:00Z');
    assert.equal(zonedDay(at, 'UTC'), '2026-10-27');
    assert.equal(zonedDay(at, 'Europe/Istanbul'), '2026-10-28'); // 01:30 TSİ
    assert.equal(zonedDay(at, 'America/Los_Angeles'), '2026-10-27');
    assert.equal(zonedDay(new Date('2026-10-28T06:30:00Z'), 'America/Los_Angeles'), '2026-10-27'); // 23:30 PDT
    assert.equal(zonedDay(new Date('2026-10-28T07:00:00Z'), 'America/Los_Angeles'), '2026-10-28');
    assert.equal(zonedDay(new Date('2026-12-31T21:00:00Z'), 'Europe/Istanbul'), '2027-01-01'); // yıl dönümü
    assert.equal(zonedDay(new Date('2026-12-31T20:59:59Z'), 'Europe/Istanbul'), '2026-12-31');
  });

  it('Türkiye gece yarısı sınırı', () => {
    assert.equal(zonedDay(new Date('2026-11-11T20:59:59.999Z'), 'Europe/Istanbul'), '2026-11-11');
    assert.equal(zonedDay(new Date('2026-11-11T21:00:00Z'), 'Europe/Istanbul'), '2026-11-12');
  });

  it('yaz saatine geçiş: 2026-03-29 Berlin (02:00 → 03:00)', () => {
    // Geçişten önce +01:00: yerel gece yarısı 23:00Z.
    assert.equal(zonedDay(new Date('2026-03-28T22:59:59Z'), 'Europe/Berlin'), '2026-03-28');
    assert.equal(zonedDay(new Date('2026-03-28T23:00:00Z'), 'Europe/Berlin'), '2026-03-29');
    // Geçiş anı ve sonrası aynı gün.
    assert.equal(zonedDay(new Date('2026-03-29T00:59:59Z'), 'Europe/Berlin'), '2026-03-29');
    assert.equal(zonedDay(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin'), '2026-03-29');
    // Geçişten sonra +02:00: yerel gece yarısı 22:00Z.
    assert.equal(zonedDay(new Date('2026-03-29T21:59:59Z'), 'Europe/Berlin'), '2026-03-29');
    assert.equal(zonedDay(new Date('2026-03-29T22:00:00Z'), 'Europe/Berlin'), '2026-03-30');
  });

  it('kış saatine dönüş: 2026-11-01 New York (02:00 → 01:00)', () => {
    // Dönüşten önce −04:00: yerel gece yarısı 04:00Z.
    assert.equal(zonedDay(new Date('2026-11-01T03:59:59Z'), 'America/New_York'), '2026-10-31');
    assert.equal(zonedDay(new Date('2026-11-01T04:00:00Z'), 'America/New_York'), '2026-11-01');
    // 01:xx iki kez yaşanır (05:30Z ve 06:30Z); ikisi de 1 Kasım.
    assert.equal(zonedDay(new Date('2026-11-01T05:30:00Z'), 'America/New_York'), '2026-11-01');
    assert.equal(zonedDay(new Date('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01');
    // Dönüşten sonra −05:00: yerel gece yarısı 05:00Z.
    assert.equal(zonedDay(new Date('2026-11-02T04:59:59Z'), 'America/New_York'), '2026-11-01');
    assert.equal(zonedDay(new Date('2026-11-02T05:00:00Z'), 'America/New_York'), '2026-11-02');
  });

  it('saat dilimi yoksa cihazın saati (bugünkü davranış)', () => {
    const at = new Date('2026-10-27T16:00:00Z'); // Tokyo 01:00, 28 Ekim
    assert.equal(zonedDay(at), '2026-10-28');
    assert.equal(zonedDay(at, undefined), `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`);
  });

  it('girdi biçimleri', () => {
    assert.equal(zonedDay('2026-10-27', 'America/Los_Angeles'), '2026-10-27'); // yalnız gün: kaydırılmaz
    assert.equal(zonedDay('2026-10-27T22:30:00Z', 'Europe/Istanbul'), '2026-10-28');
    assert.equal(zonedDay(Date.parse('2026-10-27T22:30:00Z'), 'Europe/Istanbul'), '2026-10-28');
    assert.equal(zonedDay('abc', 'UTC'), '');
    assert.equal(zonedDay(new Date(Number.NaN), 'UTC'), '');
    assert.equal(zonedDay(new Date('0999-06-15T12:00:00Z'), 'UTC'), '0999-06-15');
  });

  it('geçersiz saat dilimi hata fırlatır', () => {
    assert.throws(() => zonedDay(new Date(), 'Mars/Olympus'), RangeError);
  });
});

describe('isTimeZone', () => {
  it('geçerli ve geçersiz adlar', () => {
    for (const z of ['Europe/Istanbul', 'America/New_York', 'UTC', 'Asia/Tokyo']) assert.equal(isTimeZone(z), true, z);
    for (const z of ['Mars/Olympus', '', '  ', null, undefined, 3, {}]) assert.equal(isTimeZone(z), false, String(z));
  });
});

describe('addDays / addMonths', () => {
  it('gün ekleme yaz saatinden etkilenmez', () => {
    assert.equal(addDays('2026-03-28', 1), '2026-03-29');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(addDays('2026-11-01', -1), '2026-10-31');
    assert.equal(addDays('2026-11-01', -29), '2026-10-03');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-10-27', 0), '2026-10-27');
  });
  it('geçersiz gün', () => {
    assert.equal(addDays('2026-02-30', 1), '');
    assert.equal(addDays('abc', 1), '');
    assert.equal(addDays('2026-10-27', Number.NaN), '');
  });
  it('ay ekleme', () => {
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(addMonths('2026-11', -11), '2025-12');
    assert.equal(addMonths('2026-11', 2), '2027-01');
    assert.equal(addMonths('2026-13', 0), '');
    assert.equal(addMonths('2026-1', 0), '');
  });
});
