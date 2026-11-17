import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cameraPermAction, cameraPermButtonKey, cameraPermTextKey } from '../src/lib/cameraPermission';

const dict = (lng: 'tr' | 'en') => JSON.parse(readFileSync(new URL(`../src/locales/${lng}/measure.json`, import.meta.url), 'utf8'));
const lookup = (d: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);

describe('kamera izni istemi (G2 / 11-B6)', () => {
  it('izin okunmadıysa ya da verildiyse istem yok', () => {
    expect(cameraPermAction(null)).toBeNull();
    expect(cameraPermAction(undefined)).toBeNull();
    expect(cameraPermAction({ granted: true, canAskAgain: true })).toBeNull();
    expect(cameraPermAction({ granted: true, canAskAgain: false })).toBeNull();
  });

  it('yeniden sorulabiliyorsa düğme izni ister', () => {
    const a = cameraPermAction({ granted: false, canAskAgain: true });
    expect(a).toBe('ask');
    expect(cameraPermButtonKey(a!)).toBe('scan.permButton');
    expect(cameraPermTextKey(a!, 'scan')).toBe('scan.permText');
    expect(cameraPermTextKey(a!, 'photo')).toBe('ui.cameraPerm');
  });

  it('kalıcı reddedildiyse düğme ayarları açar ve metin yolu söyler', () => {
    const a = cameraPermAction({ granted: false, canAskAgain: false });
    expect(a).toBe('settings');
    expect(cameraPermButtonKey(a!)).toBe('scan.permSettingsButton');
    expect(cameraPermTextKey(a!, 'scan')).toBe('scan.permSettingsText');
    expect(cameraPermTextKey(a!, 'photo')).toBe('ui.cameraPermSettings');
  });

  it('her anahtar TR ve EN sözlükte var; ayarlar metni ayarlar yolunu söyler', () => {
    const keys = [
      ...(['ask', 'settings'] as const).flatMap((a) => [cameraPermButtonKey(a), cameraPermTextKey(a, 'scan'), cameraPermTextKey(a, 'photo')]),
      'ui.shootNeedsCamera',
    ];
    for (const lng of ['tr', 'en'] as const) {
      const d = dict(lng);
      for (const k of keys) expect(typeof lookup(d, k), `${lng}:${k}`).toBe('string');
    }
    expect(lookup(dict('tr'), 'scan.permSettingsButton')).toBe('Ayarlarda izin ver');
    expect(lookup(dict('tr'), 'ui.cameraPermSettings')).toMatch(/Ayarlar › İzinler › Kamera/);
    expect(lookup(dict('en'), 'ui.cameraPermSettings')).toMatch(/Settings › Permissions › Camera/);
  });
});
