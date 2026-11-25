// G6(b): Merkez > Ekip'teki web bağlantısı geliştirme derlemesinde yerel sunucuya gider (gateway Merkez'i de sunar);
// üretimde ve önizlemede bugünkü adres.
import { describe, expect, it } from 'vitest';
import { WEB_ORIGIN, webOriginFor } from '../src/hub/links';

describe('webOriginFor', () => {
  it('geliştirmede sunucu adresinin kökü', () => {
    expect(webOriginFor({ development: true, serverUrl: 'http://10.0.2.2:8088' })).toBe('http://10.0.2.2:8088');
    expect(webOriginFor({ development: true, serverUrl: 'http://127.0.0.1:8088/' })).toBe('http://127.0.0.1:8088');
    expect(webOriginFor({ development: true, serverUrl: 'https://test.example.com/yol?x=1' })).toBe('https://test.example.com');
  });

  it('üretimde ve önizlemede bugünkü adres', () => {
    expect(webOriginFor({ development: false, serverUrl: 'http://10.0.2.2:8088' })).toBe(WEB_ORIGIN);
    expect(webOriginFor({ development: false, serverUrl: null })).toBe(WEB_ORIGIN);
  });

  it('elle verilen EXPO_PUBLIC_WEB_ORIGIN önce gelir', () => {
    expect(webOriginFor({ envOrigin: 'http://192.168.1.5:8088/', development: true, serverUrl: 'http://10.0.2.2:8088' })).toBe('http://192.168.1.5:8088');
    expect(webOriginFor({ envOrigin: 'https://staging.example.com', development: false })).toBe('https://staging.example.com');
  });

  it('geçersiz sunucu adresi bugünkü adrese düşer', () => {
    expect(webOriginFor({ development: true, serverUrl: 'javascript:alert(1)' })).toBe(WEB_ORIGIN);
    expect(webOriginFor({ development: true, serverUrl: '' })).toBe(WEB_ORIGIN);
    expect(webOriginFor({ envOrigin: '   ', development: true, serverUrl: 'http://10.0.2.2:8088' })).toBe('http://10.0.2.2:8088');
  });
});
