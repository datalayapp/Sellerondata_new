import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { env, missingProductionEnv } from '../src/env.ts';
import { readSettings, settingsFor } from '../src/lib/settings.ts';

/** Veritabanı istemez: Mesaj 14 Parça 0a'nın ortam ve ayar iskeleti. */
const PROD = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x', APP_BASE_URL: 'https://app.example.test' };
const reqWith = (...permissions: string[]) => ({ auth: { permissions } }) as unknown as FastifyRequest;

describe('bildirim ortamı (Mesaj 14 §4.4)', () => {
  const saved = { url: process.env.ACCOUNT_NOTIFY_URL, secret: process.env.PRODUCT_NOTIFY_SECRET, demo: process.env.DEMO_TOUR };
  afterEach(() => {
    for (const [k, v] of [['ACCOUNT_NOTIFY_URL', saved.url], ['PRODUCT_NOTIFY_SECRET', saved.secret], ['DEMO_TOUR', saved.demo]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('adres boşsa hatırlatma kapalı: üretimde anahtar istenmez', () => {
    expect(missingProductionEnv(PROD)).toEqual([]);
    expect(missingProductionEnv({ ...PROD, PRODUCT_NOTIFY_SECRET: 'kisa' })).toEqual([]);
  });

  it('adres doluysa üretimde anahtar en az 32 karakter olmalı', () => {
    const url = 'http://account-api:4100/api/account/internal/notify';
    expect(missingProductionEnv({ ...PROD, ACCOUNT_NOTIFY_URL: url })).toHaveLength(1);
    expect(missingProductionEnv({ ...PROD, ACCOUNT_NOTIFY_URL: url, PRODUCT_NOTIFY_SECRET: 'a'.repeat(31) })).toHaveLength(1);
    expect(missingProductionEnv({ ...PROD, ACCOUNT_NOTIFY_URL: url, PRODUCT_NOTIFY_SECRET: 'a'.repeat(32) })).toEqual([]);
    // geliştirmede denetim yok
    expect(missingProductionEnv({ NODE_ENV: 'development', ACCOUNT_NOTIFY_URL: url })).toEqual([]);
  });

  it('notifyUrl ve notifySecret kırpılır; yoksa boş', () => {
    delete process.env.ACCOUNT_NOTIFY_URL;
    delete process.env.PRODUCT_NOTIFY_SECRET;
    expect(env.notifyUrl).toBe('');
    expect(env.notifySecret).toBe('');
    process.env.ACCOUNT_NOTIFY_URL = ' http://x/y ';
    process.env.PRODUCT_NOTIFY_SECRET = ' s ';
    expect(env.notifyUrl).toBe('http://x/y');
    expect(env.notifySecret).toBe('s');
  });

  it('DEMO_TOUR=off deneme turunu kapatır; yoksa ya da tanınmayan değerde açık', () => {
    delete process.env.DEMO_TOUR;
    expect(env.demoTourEnabled).toBe(true);
    process.env.DEMO_TOUR = 'off';
    expect(env.demoTourEnabled).toBe(false);
    process.env.DEMO_TOUR = 'ofF ';
    expect(env.demoTourEnabled).toBe(false);
    process.env.DEMO_TOUR = 'bilinmeyen';
    expect(env.demoTourEnabled).toBe(true);
  });
});

describe('ayarlar: hatırlatma ve deneme (Mesaj 14 §4.3, §4.4)', () => {
  it('hatırlatma varsayılan açık; kayıtlı kapalı değeri korunur', () => {
    expect(readSettings({}).disputeReminders).toBe(true);
    expect(readSettings({ disputeReminders: false }).disputeReminders).toBe(false);
    expect(readSettings({}).demo).toBeUndefined();
  });

  it('ayar yetkisi olan hepsini görür; diğerleri yalnız deneme başlangıcını (kim başlattığı olmadan), hatırlatmayı değil', () => {
    const s = readSettings({ demo: { startedAt: '2026-11-15T10:00:00.000Z', byMemberId: 'uye-1' }, disputeReminders: false });
    const manager = settingsFor(reqWith('deciship.settings.manage'), s, 'TR') as Record<string, unknown>;
    expect(manager.demo).toEqual({ startedAt: '2026-11-15T10:00:00.000Z', byMemberId: 'uye-1' });
    expect(manager.disputeReminders).toBe(false);
    const other = settingsFor(reqWith('deciship.measurements.capture'), s, 'TR') as Record<string, unknown>;
    expect(other.demo).toEqual({ startedAt: '2026-11-15T10:00:00.000Z' });
    expect('disputeReminders' in other).toBe(false);
    // deneme kapalıyken alan hiç yok
    expect('demo' in (settingsFor(reqWith('deciship.measurements.capture'), readSettings({}), 'TR') as object)).toBe(false);
  });
});
