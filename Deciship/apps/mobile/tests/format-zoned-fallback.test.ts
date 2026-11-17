// Cihazın Intl biçimleyicisi saat dilimini kabul edip günü okunur vermezse (Hermes sürüm farkı) "bugün" telefonun gece
// yarısından başlar; eskiden arama 30 saat geriye kayıyor, dünkü ölçümler de "Bugün"de görünüyordu.
process.env.TZ = 'UTC';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sellerondata/format/zoned', () => ({ isTimeZone: (v: unknown) => typeof v === 'string' && v.length > 0, zonedDay: () => '' }));

import * as lib from '../src/lib/format';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
});

afterEach(() => {
  lib.setFormatTimeZone(null);
  vi.useRealTimers();
});

describe('firma saat dilimi okunamıyor', () => {
  it('gün başı telefonun gece yarısı; dünkü ölçüm bugün sayılmaz; çökme yok', () => {
    lib.setFormatTimeZone('Europe/Istanbul');
    expect(lib.startOfToday().toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(lib.isToday('2026-11-11T20:00:00Z')).toBe(false);
    expect(lib.isToday('2026-11-12T01:00:00Z')).toBe(true);
    expect(() => lib.fmtDayTitle('2026-11-11T20:00:00Z')).not.toThrow();
  });
});
