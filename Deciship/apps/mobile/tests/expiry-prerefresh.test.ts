import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

/**
 * Gezide: jetonun süresi dolmuşken kuyruk fotoğraflı ölçümü bir kez boşuna yüklüyordu (401, yenileme, 201). Jetonun süresi
 * yerelde biliniyorsa (exp) çok parçalı gönderimden önce yenilenir.
 */
const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void store.set(k, v),
  deleteItemAsync: async (k: string) => void store.delete(k),
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: 2 } } },
    platform: { android: {} },
  },
}));

import { loadSession, productFetch, setServerUrl, setTokens } from '../src/api/client';
import { clearUpgradeRequired } from '../src/version/policy';

const TTL_S = 600;
const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');
const isUpload = (url: string) => url.endsWith('/api/deciship/measurements');

/** Şimdi verilmiş, `TTL_S` saniyelik jeton. `shiftS`: sunucu saatinin telefona göre farkı. */
const tokenNow = (ep: number, shiftS = 0) => {
  const iat = Math.floor(Date.now() / 1000) + shiftS;
  return fakeToken({ sub: 'ayse', org: 'firmaA', ep, iat, exp: iat + TTL_S });
};

type Call = { url: string; auth: string | null };
let calls: Call[];
let fresh: string;
let refreshAnswer: () => Response;

const upload = () => {
  const form = new FormData();
  form.append('data', '{}');
  return productFetch('deciship', '/measurements', { method: 'POST', form, requireScope: { personId: 'ayse', orgId: 'firmaA' } });
};

beforeEach(async () => {
  vi.useFakeTimers();
  store.clear();
  calls = [];
  refreshAnswer = () => {
    fresh = tokenNow(2);
    return jsonResponse(200, { expiresIn: TTL_S, activeOrgId: 'firmaA', accessToken: fresh, refreshToken: 'rt2' });
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('Authorization');
    calls.push({ url, auth });
    if (isRefresh(url)) return refreshAnswer();
    // Sunucu yalnız yenilenmiş jetonu kabul eder.
    return auth === `Bearer ${fresh}` ? jsonResponse(201, { measurement: { id: 'm1' } }) : errorResponse(401, 'TOKEN_EXPIRED');
  });
  await setServerUrl('http://gw:8088');
  await clearUpgradeRequired();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('süresi dolmuş jetonla fotoğraflı gönderim', () => {
  it('süre doldu: önce yenilenir, fotoğraf bir kez yüklenir', async () => {
    const old = tokenNow(1);
    fresh = 'henuz-yok';
    await setTokens(old, 'rt1');
    await vi.advanceTimersByTimeAsync((TTL_S + 1) * 1000);
    const res = await upload();
    expect(res.status).toBe(201);
    expect(calls.map((c) => (isRefresh(c.url) ? 'refresh' : isUpload(c.url) ? 'upload' : c.url))).toEqual(['refresh', 'upload']);
  });

  it('süre dolmadı: yenileme yok', async () => {
    fresh = tokenNow(1);
    await setTokens(fresh, 'rt1');
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await upload();
    expect(res.status).toBe(201);
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(0);
  });

  it('telefon saati sunucudan bir saat ileride: yeni gelen jeton süresi dolmuş sayılmaz (ömür telefona geliş anından)', async () => {
    fresh = tokenNow(1, -3600);
    await setTokens(fresh, 'rt1');
    const res = await upload();
    expect(res.status).toBe(201);
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(0);
  });

  it('açılışta depodan okunan süresi geçmiş jeton: önce yenilenir', async () => {
    const old = tokenNow(1);
    fresh = 'henuz-yok';
    await setTokens(old, 'rt1');
    await vi.advanceTimersByTimeAsync((TTL_S + 1) * 1000);
    await loadSession();
    const res = await upload();
    expect(res.status).toBe(201);
    expect(calls.filter((c) => isUpload(c.url))).toHaveLength(1);
  });

  it('yenileme sunucusu yanıt vermiyor: fotoğraf boşuna yüklenmez, çağıran geçici hata (503) görür', async () => {
    const old = tokenNow(1);
    fresh = 'henuz-yok';
    await setTokens(old, 'rt1');
    await vi.advanceTimersByTimeAsync((TTL_S + 1) * 1000);
    refreshAnswer = () => errorResponse(503, 'DB_UNAVAILABLE');
    const res = await upload();
    expect(res.status).toBe(503);
    expect(calls.filter((c) => isUpload(c.url))).toHaveLength(0);
  });

  it('süresi bilinmeyen jeton (exp yok): bugünkü gibi 401 sonra yenileme', async () => {
    const old = fakeToken({ sub: 'ayse', org: 'firmaA' });
    fresh = 'henuz-yok';
    await setTokens(old, 'rt1');
    const res = await upload();
    expect(res.status).toBe(201);
    expect(calls.map((c) => (isRefresh(c.url) ? 'refresh' : 'upload'))).toEqual(['upload', 'refresh', 'upload']);
  });

  it('JSON istekleri ön yenileme yapmaz (yalnız çok parçalı yükleme)', async () => {
    const old = tokenNow(1);
    fresh = 'henuz-yok';
    await setTokens(old, 'rt1');
    await vi.advanceTimersByTimeAsync((TTL_S + 1) * 1000);
    await productFetch('deciship', '/x', { method: 'POST', json: {} });
    expect(calls.map((c) => (isRefresh(c.url) ? 'refresh' : 'other'))).toEqual(['other', 'refresh', 'other']);
  });
});
