import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import appJson from '../app.json';

const require = createRequire(import.meta.url);
const { allowsCleartext, withCleartextPolicy, buildConfig } = require('../app.config.js') as {
  allowsCleartext: (url?: string) => boolean;
  buildConfig: (config: typeof appJson.expo, env?: Record<string, string | undefined>) => {
    plugins: unknown[];
    ios?: { infoPlist?: { NSAppTransportSecurity?: { NSAllowsArbitraryLoads?: boolean } } };
    extra: { sod: { appEnv: string; apiUrl: string; versionCode: number | null } };
  };
  withCleartextPolicy: (config: typeof appJson.expo, url?: string) => { plugins: unknown[] };
};

const buildProps = (url?: string) => {
  const plugin = withCleartextPolicy(appJson.expo, url).plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties') as [string, { android: { usesCleartextTraffic: boolean } }];
  return plugin[1].android.usesCleartextTraffic;
};

const cleartextOf = (cfg: { plugins: unknown[] }) => {
  const plugin = cfg.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties') as [string, { android: { usesCleartextTraffic: boolean } }];
  return plugin[1].android.usesCleartextTraffic;
};

describe('açık metin HTTP', () => {
  it('https adresine derlenen üretim paketinde kapalı', () => {
    expect(allowsCleartext('https://app.sellerondata.com')).toBe(false);
    expect(allowsCleartext(' HTTPS://app.sellerondata.com ')).toBe(false);
    expect(buildProps('https://app.sellerondata.com')).toBe(false);
  });

  it('geliştirme ve http test paketinde açık', () => {
    expect(buildProps(undefined)).toBe(true);
    expect(buildProps('http://10.0.2.2:8088')).toBe(true);
  });

  it('kimlik: SellerOnData, com.sellerondata.app', () => {
    expect(appJson.expo.name).toBe('SellerOnData');
    expect(appJson.expo.android.package).toBe('com.sellerondata.app');
    expect(appJson.expo.ios.bundleIdentifier).toBe('com.sellerondata.app');
  });
});

describe('derleme profili (APP_ENV)', () => {
  const vc = appJson.expo.android.versionCode;

  it('production adressiz derlenmez', () => {
    expect(() => buildConfig(appJson.expo, { APP_ENV: 'production' })).toThrow('APP_ENV=production: EXPO_PUBLIC_API_URL zorunlu ve https:// ile başlamalı');
  });

  it('preview ve production http adresiyle derlenmez', () => {
    expect(() => buildConfig(appJson.expo, { APP_ENV: 'production', EXPO_PUBLIC_API_URL: 'http://app.sellerondata.com' })).toThrow('https://');
    expect(() => buildConfig(appJson.expo, { APP_ENV: 'preview', EXPO_PUBLIC_API_URL: 'http://10.0.2.2:8088' })).toThrow('APP_ENV=preview');
  });

  it('bilinmeyen APP_ENV derlenmez', () => {
    expect(() => buildConfig(appJson.expo, { APP_ENV: 'staging' })).toThrow('APP_ENV=staging');
  });

  it('production https adresiyle derlenir, şifresiz HTTP kapalı', () => {
    const cfg = buildConfig(appJson.expo, { APP_ENV: 'production', EXPO_PUBLIC_API_URL: 'https://app.sellerondata.com' });
    expect(cleartextOf(cfg)).toBe(false);
    expect(cfg.extra.sod).toEqual({ appEnv: 'production', apiUrl: 'https://app.sellerondata.com', versionCode: vc });
  });

  it('development (varsayılan) açık ve varsayılan adres dolu', () => {
    const cfg = buildConfig(appJson.expo, {});
    expect(cleartextOf(cfg)).toBe(true);
    expect(cfg.extra.sod).toEqual({ appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: vc });
    expect(cleartextOf(buildConfig(appJson.expo, { APP_ENV: 'development', EXPO_PUBLIC_API_URL: 'http://10.0.2.2:8088' }))).toBe(true);
  });

  it('development https adresine derlenirse şifresiz HTTP kapalı', () => {
    expect(cleartextOf(buildConfig(appJson.expo, { APP_ENV: 'development', EXPO_PUBLIC_API_URL: 'https://x.example' }))).toBe(false);
  });

  it('sürüm 1.1.0, versionCode 2', () => {
    expect(appJson.expo.version).toBe('1.1.0');
    expect(vc).toBe(2);
  });
});

describe('iOS açık metin HTTP (ATS)', () => {
  const atsOf = (env: Record<string, string | undefined>) => buildConfig(appJson.expo, env).ios?.infoPlist?.NSAppTransportSecurity;

  it('development http adresine derlenirse ATS istisnası açık', () => {
    expect(atsOf({})).toEqual({ NSAllowsArbitraryLoads: true });
  });

  it('preview, production ve https development paketinde istisna yok', () => {
    expect(atsOf({ APP_ENV: 'production', EXPO_PUBLIC_API_URL: 'https://app.sellerondata.com' })).toBeUndefined();
    expect(atsOf({ APP_ENV: 'preview', EXPO_PUBLIC_API_URL: 'https://app.sellerondata.com' })).toBeUndefined();
    expect(atsOf({ APP_ENV: 'development', EXPO_PUBLIC_API_URL: 'https://x.example' })).toBeUndefined();
  });

  it('şifreleme beyanı app.json içinde', () => {
    expect(appJson.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
  });
});
