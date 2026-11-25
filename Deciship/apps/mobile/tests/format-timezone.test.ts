// 11-B7: "Bugün" günü ve gösterilen saat firmanın saat dilimiyle. Telefonun saat dilimi UTC'de kalmış (ikinci el telefon),
// firma İstanbul'da: gece 00:00-03:00 arası ölçümler Bugün'de görünmeli, saatler İstanbul saatiyle yazılmalı.
// Firma saat dilimi bilinmiyorsa (eski sunucu) bugünkü gibi telefonun saati.
process.env.TZ = 'UTC';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../src/i18n';
import * as lib from '../src/lib/format';

const ISTANBUL = 'Europe/Istanbul';
/** İstanbul'da 12 Kasım Perşembe 01:30; UTC'de hâlâ 11 Kasım 22:30. */
const NIGHT = '2026-11-12T01:30:00+03:00';

beforeAll(async () => {
  await i18n.changeLanguage('tr');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NIGHT));
});

afterEach(() => {
  lib.setFormatTimeZone(null);
  vi.useRealTimers();
});

describe('firma saat dilimi (telefon UTC, firma İstanbul)', () => {
  it('gün başı firmanın gece yarısı', () => {
    lib.setFormatTimeZone(ISTANBUL);
    expect(lib.getFormatTimeZone()).toBe(ISTANBUL);
    expect(lib.startOfToday().toISOString()).toBe('2026-11-11T21:00:00.000Z');
  });

  it('gece 00:15 ölçümü bugün, dün 23:50 ölçümü bugün değil', () => {
    lib.setFormatTimeZone(ISTANBUL);
    expect(lib.isToday('2026-11-12T00:15:00+03:00')).toBe(true);
    expect(lib.isToday('2026-11-11T23:50:00+03:00')).toBe(false);
  });

  it('saat, gün anahtarı, gün başlığı ve başlık tarihi firma saatiyle', () => {
    lib.setFormatTimeZone(ISTANBUL);
    expect(lib.fmtTime('2026-11-12T00:15:00+03:00')).toBe('00:15');
    expect(lib.fmtWhen('2026-11-12T00:15:00+03:00')).toBe('00:15');
    expect(lib.fmtDateTime('2026-11-12T00:15:00+03:00')).toBe('12 Kas 2026 00:15');
    expect(lib.dayKey('2026-11-12T00:15:00+03:00')).toBe('2026-11-12');
    expect(lib.dayKey('2026-11-11T23:50:00+03:00')).toBe('2026-11-11');
    expect(lib.fmtDayTitle('2026-11-12T00:15:00+03:00')).toBe('Bugün');
    expect(lib.fmtDayTitle('2026-11-11T23:50:00+03:00')).toBe('Dün');
    expect(lib.fmtDayTitle('2026-11-06T10:00:00+03:00')).toBe('Cuma, 6 Kasım');
    expect(lib.fmtDayTitle('2025-12-31T23:59:00+03:00')).toBe('Çarşamba, 31 Aralık 2025');
    expect(lib.fmtToday()).toBe('Perşembe, 12 Kasım');
  });

  it('saat dilimi yoksa telefonun saati (bugünkü davranış)', () => {
    expect(lib.getFormatTimeZone()).toBeUndefined();
    expect(lib.startOfToday().toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(lib.fmtTime('2026-11-12T00:15:00+03:00')).toBe('21:15');
    expect(lib.dayKey('2026-11-12T00:15:00+03:00')).toBe('2026-11-11');
    expect(lib.fmtToday()).toBe('Çarşamba, 11 Kasım');
  });

  it('geçersiz ya da boş saat dilimi telefonun saatine düşer', () => {
    lib.setFormatTimeZone('Mars/Olympus');
    expect(lib.getFormatTimeZone()).toBeUndefined();
    expect(lib.startOfToday().toISOString()).toBe('2026-11-11T00:00:00.000Z');
    lib.setFormatTimeZone(ISTANBUL);
    lib.setFormatTimeZone('');
    expect(lib.getFormatTimeZone()).toBeUndefined();
  });

  it('isteğe bağlı parametre modül ayarını ezer', () => {
    lib.setFormatTimeZone(ISTANBUL);
    expect(lib.startOfToday('UTC').toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(lib.startOfToday().toISOString()).toBe('2026-11-11T21:00:00.000Z');
  });

  it('gün değişince gün başı da değişir', () => {
    lib.setFormatTimeZone(ISTANBUL);
    expect(lib.startOfToday().toISOString()).toBe('2026-11-11T21:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-13T00:05:00+03:00'));
    expect(lib.startOfToday().toISOString()).toBe('2026-11-12T21:00:00.000Z');
    expect(lib.isToday('2026-11-12T23:59:00+03:00')).toBe(false);
  });

  it('yaz saatine geçilen gün gece yarısı doğru (Berlin, 29 Mart 2026)', () => {
    lib.setFormatTimeZone('Europe/Berlin');
    vi.setSystemTime(new Date('2026-03-29T12:00:00+02:00'));
    expect(lib.startOfToday().toISOString()).toBe('2026-03-28T23:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-25T12:00:00+01:00'));
    expect(lib.startOfToday().toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});
