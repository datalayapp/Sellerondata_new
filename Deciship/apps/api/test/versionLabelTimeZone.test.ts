// Tarife geri alma etiketindeki saat firmanın saat diliminde (rapor Y132). Yalnız gösterim; kayıtta an durur.
import { describe, expect, it } from 'vitest';
import { readVersionLabel, versionLabel } from '../src/services/tariffs.ts';

const restore = (at: string) => versionLabel('version.restore', { at });

describe('geri alma etiketi saati', () => {
  it('saat dilimi verilmezse eskisi gibi İstanbul', () => {
    expect(readVersionLabel(restore('2026-03-29T01:30:00Z'), 'tr')).toContain('29.03.2026 04:30');
  });

  it('firmanın saat diliminde; yaz saatine geçiş (2026-03-29 Berlin)', () => {
    expect(readVersionLabel(restore('2026-03-29T00:30:00Z'), 'tr', 'Europe/Berlin')).toContain('29.03.2026 01:30');
    expect(readVersionLabel(restore('2026-03-29T01:30:00Z'), 'tr', 'Europe/Berlin')).toContain('29.03.2026 03:30');
  });

  it('kış saatine dönüş (2026-11-01 New York) ve gün kayması', () => {
    expect(readVersionLabel(restore('2026-11-01T05:30:00Z'), 'tr', 'America/New_York')).toContain('01.11.2026 01:30');
    expect(readVersionLabel(restore('2026-11-01T06:30:00Z'), 'tr', 'America/New_York')).toContain('01.11.2026 01:30');
    expect(readVersionLabel(restore('2026-11-01T03:30:00Z'), 'tr', 'America/New_York')).toContain('31.10.2026 23:30');
  });

  it('geçersiz saat dilimi hata vermez, İstanbul yazılır', () => {
    expect(readVersionLabel(restore('2026-03-29T01:30:00Z'), 'tr', 'Mars/Olympus')).toContain('29.03.2026 04:30');
  });
});
