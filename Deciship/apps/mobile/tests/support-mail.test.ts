// 11-B16: destek e-postası uygulama sürümünü ve cihaz modelini taşır; Hesap ekranı sürümü gösterir.
import { describe, expect, it } from 'vitest';
import { SUPPORT_EMAIL } from '@sellerondata/contracts';
import { deviceLabel, supportMailto, versionLabel } from '../src/lib/supportMail';

const bodyOf = (url: string) => {
  const m = /[?&]body=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
};

describe('supportMailto', () => {
  it('konu ve gövdede sürüm ile cihaz', () => {
    const url = supportMailto(['Yardım ve destek', 'Demo Lojistik'], ['Sürüm: 1.1.0 (2)', 'Cihaz: samsung SM-A515F · Android 13']);
    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
    expect(decodeURIComponent(/subject=([^&]*)/.exec(url)![1]!)).toBe('Yardım ve destek · Demo Lojistik');
    expect(bodyOf(url)).toBe('\n\nSürüm: 1.1.0 (2)\nCihaz: samsung SM-A515F · Android 13');
  });

  it('boş gövde satırları atılır; hiç yoksa gövde yok', () => {
    expect(supportMailto(['Destek'], [null, '  ', undefined])).toBe(supportMailto(['Destek']));
    expect(bodyOf(supportMailto(['Destek']))).toBeNull();
  });

  it('konu yoksa gövde ilk parametre olur', () => {
    const url = supportMailto([], ['Sürüm: 1.1.0']);
    expect(url).toBe(`mailto:${SUPPORT_EMAIL}?body=${encodeURIComponent('\n\nSürüm: 1.1.0')}`);
  });

  it('gövdedeki & ve = adresi bozmaz', () => {
    const url = supportMailto(['A'], ['x&y=z']);
    expect(bodyOf(url)).toBe('\n\nx&y=z');
  });
});

describe('versionLabel', () => {
  it('derleme numarası parantezde', () => {
    expect(versionLabel('1.1.0', 2)).toBe('1.1.0 (2)');
    expect(versionLabel('1.1.0', null)).toBe('1.1.0');
  });
});

describe('deviceLabel', () => {
  it('Android: üretici, model, sürüm', () => {
    expect(deviceLabel({ OS: 'android', Version: 33, constants: { Manufacturer: 'samsung', Model: 'SM-A515F', Release: '13' } })).toBe('samsung SM-A515F · Android 13');
  });

  it('Android: model üreticiyle başlıyorsa tekrar yazılmaz', () => {
    expect(deviceLabel({ OS: 'android', Version: 34, constants: { Manufacturer: 'Google', Model: 'Google Pixel 7', Release: '14' } })).toBe('Google Pixel 7 · Android 14');
  });

  it('Android: sürüm metni yoksa API düzeyi', () => {
    expect(deviceLabel({ OS: 'android', Version: 34, constants: { Model: 'sdk_gphone64_x86_64' } })).toBe('sdk_gphone64_x86_64 · Android API 34');
  });

  it('iOS: sistem sürümü', () => {
    expect(deviceLabel({ OS: 'ios', Version: '18.1', constants: { systemName: 'iOS', interfaceIdiom: 'phone' } })).toBe('iPhone · iOS 18.1');
  });

  it('bilgi yoksa null', () => {
    expect(deviceLabel({ OS: 'web' })).toBeNull();
  });
});
