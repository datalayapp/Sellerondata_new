import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './helpers';

/**
 * Mesaj 13 M1: sürüm bilgisi, "en düşük sürüm" politikası ve güncelleme bayrağı.
 * Kurallar: ağ hatası asla engellemez; bayrak sürüm değişince ya da sunucu "gerek yok" deyince kalkar.
 */

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void store.set(k, v),
  deleteItemAsync: async (k: string) => void store.delete(k),
}));

type Cfg = { version?: string; android?: { versionCode?: number }; extra?: { sod?: { appEnv?: string; apiUrl?: string; versionCode?: number | null } } };
const constants = vi.hoisted(() => ({ expoConfig: null as Cfg | null, platform: { android: {} } as Record<string, unknown> | undefined }));
vi.mock('expo-constants', () => ({ default: constants }));

const K = 'sod_upgrade_required';

function setConfig(cfg: Cfg | null) {
  constants.expoConfig = cfg;
}

const v110: Cfg = { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: 2 } } };

async function fresh() {
  vi.resetModules();
  const client = await import('../src/version/client');
  const policy = await import('../src/version/policy');
  return { client, policy };
}

const policyRes = (minVersion: string | null, updateUrl: string | null = 'https://example.com/apk') =>
  async () => jsonResponse(200, { mobile: { minVersion, latestVersion: null, updateUrl } });

beforeEach(() => {
  store.clear();
  setConfig(v110);
  constants.platform = { android: {} };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('src/version/client', () => {
  it('sürüm, derleme numarası ve ortam yapılandırmadan okunur; başlık sözleşme biçiminde', async () => {
    const { client } = await fresh();
    expect(client.APP_VERSION).toBe('1.1.0');
    expect(client.BUILD).toBe(2);
    expect(client.APP_ENV).toBe('development');
    expect(client.clientHeader()).toBe('mobile/1.1.0+2 (android)');
  });

  it('derleme numarası android alanında yoksa extra.sod.versionCode', async () => {
    setConfig({ version: '1.2.0', extra: { sod: { appEnv: 'production', versionCode: 7 } } });
    const { client } = await fresh();
    expect(client.BUILD).toBe(7);
    expect(client.APP_ENV).toBe('production');
    expect(client.clientHeader()).toBe('mobile/1.2.0+7 (android)');
  });

  it('platform bilinmiyorsa parantez yazılmaz', async () => {
    constants.platform = undefined;
    const { client } = await fresh();
    expect(client.clientHeader()).toBe('mobile/1.1.0+2');
  });

  it('yapılandırma yoksa: geliştirme, sürüm bilinmiyor, başlık gönderilmez (yanlışlıkla 426 almasın)', async () => {
    setConfig(null);
    const { client } = await fresh();
    expect(client.APP_VERSION).toBe('0.0.0');
    expect(client.BUILD).toBeNull();
    expect(client.APP_ENV).toBe('development');
    expect(client.VERSION_KNOWN).toBe(false);
    expect(client.clientHeader()).toBeNull();
  });

  it('tanınmayan APP_ENV geliştirme sayılmaz (adres alanı açılmasın)', async () => {
    setConfig({ ...v110, extra: { sod: { appEnv: 'staging' } } });
    const { client } = await fresh();
    expect(client.APP_ENV).toBe('production');
  });
});

describe('güncelleme bayrağı: açılış', () => {
  it('aynı sürüm için kayıtlı bayrak açılışta geri gelir', async () => {
    store.set(K, JSON.stringify({ minVersion: '1.2.0', updateUrl: 'https://example.com/apk', forVersion: '1.1.0' }));
    const { policy } = await fresh();
    await policy.loadUpgradeFlag();
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '1.2.0', updateUrl: 'https://example.com/apk' });
    expect(policy.isUpgradeRequired()).toBe(true);
  });

  it('güncelleme kurulduysa (sürüm değişti) bayrak silinir', async () => {
    store.set(K, JSON.stringify({ minVersion: '1.1.0', updateUrl: null, forVersion: '1.0.0' }));
    const { policy } = await fresh();
    await policy.loadUpgradeFlag();
    expect(policy.getUpgradeState()).toEqual({ required: false });
    expect(store.has(K)).toBe(false);
  });

  it('bozuk kayıt silinir, engellemez', async () => {
    store.set(K, '{bozuk');
    const { policy } = await fresh();
    await policy.loadUpgradeFlag();
    expect(policy.isUpgradeRequired()).toBe(false);
    expect(store.has(K)).toBe(false);
  });

  it('okuma sürerken gelen 426 sonucu ezilmez', async () => {
    const { policy } = await fresh();
    const loading = policy.loadUpgradeFlag();
    policy.setUpgradeRequired({ minVersion: '9.0.0', updateUrl: null });
    await loading;
    expect(policy.isUpgradeRequired()).toBe(true);
  });
});

describe('güncelleme bayrağı: setUpgradeRequired', () => {
  it('ayrıntıyı saklar, dinleyiciye haber verir; güvensiz bağlantı atılır', async () => {
    const { policy } = await fresh();
    const seen: unknown[] = [];
    const off = policy.onUpgradeChange((s) => seen.push(s));
    policy.setUpgradeRequired({ minVersion: '9.0.0', updateUrl: 'javascript:alert(1)' });
    off();
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '9.0.0', updateUrl: null });
    expect(seen).toEqual([{ required: true, minVersion: '9.0.0', updateUrl: null }]);
    await vi.waitFor(() => expect(store.has(K)).toBe(true));
    expect(JSON.parse(store.get(K)!)).toEqual({ minVersion: '9.0.0', updateUrl: null, forVersion: '1.1.0' });
  });

  it('yeni 426 bağlantıyı ya da sürümü boş gönderirse bilinen değer korunur (DeciShip 426 updateUrl null)', async () => {
    const { policy } = await fresh();
    policy.setUpgradeRequired({ minVersion: '1.2.0', updateUrl: 'https://example.com/apk' });
    policy.setUpgradeRequired({ minVersion: null, updateUrl: null });
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '1.2.0', updateUrl: 'https://example.com/apk' });
    policy.setUpgradeRequired({ minVersion: '1.3.0', updateUrl: null });
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '1.3.0', updateUrl: 'https://example.com/apk' });
    await vi.waitFor(() => expect(JSON.parse(store.get(K) ?? '{}').minVersion).toBe('1.3.0'));
    expect(JSON.parse(store.get(K)!).updateUrl).toBe('https://example.com/apk');
    // Bayrak tamamen kalkınca bilinen değerler de gider.
    await policy.clearUpgradeRequired();
    policy.setUpgradeRequired({ minVersion: null, updateUrl: null });
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: null, updateUrl: null });
  });

  it('ayrıntı yoksa da durum açılır', async () => {
    const { policy } = await fresh();
    policy.setUpgradeRequired(undefined);
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: null, updateUrl: null });
  });
});

describe('checkPolicy', () => {
  it('sürüm en düşük sürümün altındaysa durum açılır ve saklanır', async () => {
    const { policy } = await fresh();
    await policy.checkPolicy(policyRes('1.10.0'));
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '1.10.0', updateUrl: 'https://example.com/apk' });
    await vi.waitFor(() => expect(store.has(K)).toBe(true));
  });

  it('"gerek yok" (eşit, üstünde ya da min yok) bayrağı kaldırır, kaydı siler', async () => {
    for (const min of ['1.1.0', '1.0.9', '1.1', null]) {
      store.set(K, JSON.stringify({ minVersion: '9.0.0', updateUrl: null, forVersion: '1.1.0' }));
      const { policy } = await fresh();
      await policy.loadUpgradeFlag();
      expect(policy.isUpgradeRequired()).toBe(true);
      await policy.checkPolicy(policyRes(min));
      expect(policy.getUpgradeState()).toEqual({ required: false });
      expect(store.has(K)).toBe(false);
    }
  });

  it('ağ hatası hiçbir zaman engellemez ve var olan durumu değiştirmez', async () => {
    const { policy } = await fresh();
    await policy.checkPolicy(async () => {
      throw new Error('network');
    });
    expect(policy.isUpgradeRequired()).toBe(false);
    policy.setUpgradeRequired({ minVersion: '9.0.0', updateUrl: null });
    await policy.checkPolicy(async () => {
      throw new Error('network');
    });
    expect(policy.isUpgradeRequired()).toBe(true);
  });

  it('başarısız yanıt (404, 500, 426) ya da bozuk gövde durumu değiştirmez', async () => {
    const { policy } = await fresh();
    for (const res of [
      jsonResponse(404, { error: { code: 'NOT_FOUND' } }),
      jsonResponse(500, {}),
      jsonResponse(426, { error: { code: 'UPGRADE_REQUIRED' } }),
      new Response('<html/>', { status: 200 }),
      jsonResponse(200, { mobile: 'x' }),
      jsonResponse(200, null),
    ]) {
      await policy.checkPolicy(async () => res);
      expect(policy.isUpgradeRequired()).toBe(false);
    }
  });

  it('politika yanıtı beklenirken 426 gelirse "gerek yok" yanıtı bayrağı kaldırmaz', async () => {
    const { policy } = await fresh();
    await policy.checkPolicy(async () => {
      policy.setUpgradeRequired({ minVersion: '9.0.0', updateUrl: null });
      return jsonResponse(200, { mobile: { minVersion: null, latestVersion: null, updateUrl: null } });
    });
    expect(policy.getUpgradeState()).toEqual({ required: true, minVersion: '9.0.0', updateUrl: null });
  });

  it('bozuk en düşük sürüm engellemez', async () => {
    const { policy } = await fresh();
    await policy.checkPolicy(policyRes('bir.iki'));
    expect(policy.isUpgradeRequired()).toBe(false);
  });

  it('kendi sürümü bilinmeyen uygulama kendini kilitlemez', async () => {
    setConfig(null);
    const { policy } = await fresh();
    await policy.checkPolicy(policyRes('1.1.0'));
    expect(policy.isUpgradeRequired()).toBe(false);
  });

  it('sürüm karşılaştırması sayısal: 1.10.0 > 1.9.3', async () => {
    setConfig({ ...v110, version: '1.10.0' });
    const { policy } = await fresh();
    await policy.checkPolicy(policyRes('1.9.3'));
    expect(policy.isUpgradeRequired()).toBe(false);
    await policy.checkPolicy(policyRes('1.10.1'));
    expect(policy.isUpgradeRequired()).toBe(true);
  });
});

describe('sunucu adresi (src/api/serverUrl)', () => {
  async function serverUrl(appEnv: string | undefined, env: string, apiUrl?: string) {
    setConfig({ ...v110, extra: { sod: { appEnv, apiUrl } } });
    vi.stubEnv('EXPO_PUBLIC_API_URL', env);
    vi.resetModules();
    return import('../src/api/serverUrl');
  }

  it('üretimde alan kapalı, adres derleme adresi, yazılan adres yok sayılır', async () => {
    const m = await serverUrl('production', 'https://app.sellerondata.com');
    expect(m.SERVER_EDITABLE).toBe(false);
    expect(m.DEFAULT_SERVER_URL).toBe('https://app.sellerondata.com');
    expect(m.serverCandidates('http://evil.example')).toEqual(['https://app.sellerondata.com']);
    expect(m.normalizeServerUrl('http://evil.example')).toBe('https://app.sellerondata.com');
  });

  it('üretimde EXPO_PUBLIC_API_URL satır içine gömülmediyse extra.sod.apiUrl kullanılır', async () => {
    const m = await serverUrl('production', '', 'https://app.sellerondata.com/');
    expect(m.DEFAULT_SERVER_URL).toBe('https://app.sellerondata.com');
  });

  it('geliştirmede adres verilmiş olsa da alan görünür (plan §7-6)', async () => {
    const m = await serverUrl('development', 'http://192.168.1.5:8088');
    expect(m.SERVER_EDITABLE).toBe(true);
    expect(m.DEFAULT_SERVER_URL).toBe('http://192.168.1.5:8088');
    expect(m.normalizeServerUrl('10.0.0.2:8088')).toBe('http://10.0.0.2:8088');
  });
});

describe('kuyruk deposu değişmez (göç yok)', () => {
  it('SQLite adı deciship.db, şema sürümü 1', async () => {
    const { SCHEMA_VERSION } = await import('../src/queue/schema');
    expect(SCHEMA_VERSION).toBe(1);
    expect(readFileSync(new URL('../src/queue/db.ts', import.meta.url), 'utf8')).toContain("openDatabaseAsync('deciship.db')");
  });
});
