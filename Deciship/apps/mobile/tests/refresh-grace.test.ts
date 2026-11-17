import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

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

import {
  ACCESS_REFRESH_INTERVAL_MS,
  getRefreshToken,
  hasSession,
  onForcedLogout,
  productFetch,
  REFRESH_RETRY_WINDOW_MS,
  REFRESH_TIMEOUT_MS,
  setServerUrl,
  setTokens,
} from '../src/api/client';
import { clearUpgradeRequired } from '../src/version/policy';

const AT_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AT_A2 = fakeToken({ sub: 'ayse', org: 'firmaA', ep: 2 });

/** Hesap servisinin hoşgörüsü (`REFRESH_REUSE_GRACE_SECONDS` varsayılanı, `Platform/apps/account-api/src/env.ts`). */
const SERVER_GRACE_MS = 10_000;

type Call = { url: string; at: number; auth: string | null; body: { refreshToken?: string } | undefined };
let calls: Call[];
/** `signal` iptal edilince reddedilen söz döndürmek için `hang` kullanılır: yanıt yolda kayboldu. */
let handler: (url: string, call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');
const refreshCalls = () => calls.filter((c) => isRefresh(c.url));
const hang = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
const rotated = () => jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' });

beforeEach(async () => {
  vi.useFakeTimers();
  store.clear();
  calls = [];
  handler = () => jsonResponse(200, { ok: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      url,
      at: Date.now(),
      auth: headers.get('Authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(url, call, init.signal ?? undefined);
  });
  await setServerUrl('http://gw:8088');
  await setTokens(AT_A, 'rt1');
  await clearUpgradeRequired();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Bayat jetonla gelen ürün isteği 401 alır; yeni jetonla gelen geçer. */
const productOk = (call: Call) => (call.auth === `Bearer ${AT_A2}` ? jsonResponse(200, { ok: true }) : errorResponse(401, 'TOKEN_EXPIRED'));

async function run<T>(p: Promise<T>, ms = 30_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe('11-B3 / 04-B1: yanıtı kaybolan yenileme hoşgörü süresi içinde tekrarlanır', () => {
  it('yanıt yolda kayboldu (zaman aşımı): aynı eski jetonla hoşgörü içinde bir kez daha; oturum sürer, istek geçer', async () => {
    let serverRotatedAt = 0;
    handler = (url, call, signal) => {
      if (!isRefresh(url)) return productOk(call);
      if (refreshCalls().length === 1) {
        // Sunucu jetonu döndürdü ama yanıt telefona ulaşmıyor.
        serverRotatedAt = Date.now();
        return hang(signal);
      }
      // Sunucu: eski jeton hoşgörü içinde geldi, baş satırı yeniden döndürür; dışında gelseydi hırsızlık sayılırdı.
      if (Date.now() - serverRotatedAt > SERVER_GRACE_MS) return errorResponse(401, 'UNAUTHORIZED');
      return rotated();
    };
    const res = await run(productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(res.status).toBe(200);
    const r = refreshCalls();
    expect(r).toHaveLength(2);
    expect(r.map((c) => c.body?.refreshToken)).toEqual(['rt1', 'rt1']);
    expect(r[1]!.at - r[0]!.at).toBeLessThan(SERVER_GRACE_MS - 2000);
    expect(r[1]!.at - r[0]!.at).toBeGreaterThanOrEqual(REFRESH_TIMEOUT_MS);
    expect(getRefreshToken()).toBe('rt2');
    expect(hasSession()).toBe(true);
  });

  it('ilk yenilemenin bekleme süresi hoşgörüden kısa (eskiden 15 sn)', () => {
    expect(REFRESH_TIMEOUT_MS).toBeLessThan(SERVER_GRACE_MS);
    expect(REFRESH_RETRY_WINDOW_MS).toBeLessThanOrEqual(SERVER_GRACE_MS - 3000);
  });

  it('bağlantı koptu (ağ hatası): kısa aralıkla aynı jetonla yeniden dener', async () => {
    handler = (url, call) => {
      if (!isRefresh(url)) return productOk(call);
      if (refreshCalls().length === 1) throw new TypeError('Network request failed');
      return rotated();
    };
    // POST: GET'in "meşgulse bir kez daha" tekrarı burada yok; tekrarı yenileme kendisi yapmalı.
    const res = await run(productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(res.status).toBe(200);
    expect(refreshCalls().map((c) => c.body?.refreshToken)).toEqual(['rt1', 'rt1']);
    expect(refreshCalls()[1]!.at - refreshCalls()[0]!.at).toBeLessThan(2000);
  });

  it('ağ geçidi 502/504 de belirsizdir: tekrarlanır', async () => {
    for (const status of [502, 504]) {
      calls = [];
      await setTokens(AT_A, 'rt1');
      handler = (url, call) => {
        if (!isRefresh(url)) return productOk(call);
        return refreshCalls().length === 1 ? errorResponse(status, 'HTTP_' + status) : rotated();
      };
      const res = await run(productFetch('deciship', '/x', { method: 'POST', json: {} }));
      expect(res.status, String(status)).toBe(200);
      expect(refreshCalls(), String(status)).toHaveLength(2);
    }
  });

  it('kesin cevaplar tekrarlanmaz (500, 503, 429): sunucu döndürmedi; oturum kapanmaz, çağıran 503 görür', async () => {
    for (const [status, code] of [
      [500, 'INTERNAL'],
      [503, 'DB_UNAVAILABLE'],
      [429, 'TOO_MANY_REQUESTS'],
    ] as const) {
      calls = [];
      handler = (url) => (isRefresh(url) ? errorResponse(status, code) : errorResponse(401, 'TOKEN_EXPIRED'));
      const res = await run(productFetch('deciship', '/measurements', { method: 'POST', json: {} }));
      expect(res.status, code).toBe(503);
      expect(refreshCalls(), code).toHaveLength(1);
      expect(getRefreshToken()).toBe('rt1');
    }
  });

  it('hoşgörü penceresi geçtikten sonra aynı uçuşta eski jeton bir daha gönderilmez', async () => {
    handler = (url, call, signal) => (isRefresh(url) ? hang(signal) : productOk(call));
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    const res = await run(productFetch('deciship', '/measurements', { method: 'POST', json: {} }), 60_000);
    off();
    expect(res.status).toBe(503);
    const r = refreshCalls();
    expect(r.length).toBeGreaterThanOrEqual(2);
    for (const c of r) expect(c.at - r[0]!.at).toBeLessThan(REFRESH_RETRY_WINDOW_MS);
    // Oturum silinmez: kuyruk ve taslak durur, sonraki istekte yeniden denenir.
    expect(forced).not.toHaveBeenCalled();
    expect(hasSession()).toBe(true);
  });

  it('çıkış yapıldıysa tekrar gönderilmez', async () => {
    handler = (url, call) => {
      if (!isRefresh(url)) return productOk(call);
      void setTokens(null, null);
      throw new TypeError('Network request failed');
    };
    await run(productFetch('deciship', '/x'));
    expect(refreshCalls()).toHaveLength(1);
    expect(hasSession()).toBe(false);
  });

  it('aynı anda gelen 401ler belirsiz yenilemede de tek uçuşu bekler (iki ayrı yenileme yok)', async () => {
    handler = (url, call) => {
      if (!isRefresh(url)) return productOk(call);
      if (refreshCalls().length === 1) throw new TypeError('Network request failed');
      return rotated();
    };
    const post = { method: 'POST', json: {} } as const;
    const all = Promise.all([productFetch('deciship', '/a', post), productFetch('deciship', '/b', post), productFetch('deciship', '/c', post)]);
    const out = await run(all);
    expect(out.map((r) => r.status)).toEqual([200, 200, 200]);
    // Biri belirsiz ilk deneme, biri onun tekrarı: üç istek için yine tek uçuş.
    expect(refreshCalls()).toHaveLength(2);
  });
});

describe('04-B11: "yenilenebilir" erişim reddinde jeton bir kez yenilenir', () => {
  const refreshable = () => errorResponse403Refreshable();
  function errorResponse403Refreshable() {
    return jsonResponse(403, { error: { code: 'NO_PRODUCT_ACCESS', message: 'x', details: { refreshable: true } } });
  }

  // Önceki testin 30 sn'lik aralığı bu testi etkilemesin: sahte saat her testte öncekinden ileride başlar.
  let shift = 0;
  beforeEach(() => {
    shift += 10 * ACCESS_REFRESH_INTERVAL_MS;
    vi.setSystemTime(Date.now() + shift);
  });

  it('tek yenileme, istek bir kez tekrarlanır ve geçer', async () => {
    handler = (url, call) => {
      if (isRefresh(url)) return rotated();
      return call.auth === `Bearer ${AT_A2}` ? jsonResponse(200, { ok: true }) : refreshable();
    };
    const res = await run(productFetch('deciship', '/measurements', { method: 'POST', json: {} }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => isRefresh(c.url))).toEqual([false, true, false]);
  });

  it('yenilemeden sonra da 403 ise çağırana döner; 30 sn içinde ikinci kez yenilemez', async () => {
    handler = (url) => (isRefresh(url) ? rotated() : refreshable());
    const first = await run(productFetch('deciship', '/a'), 100);
    expect(first.status).toBe(403);
    expect(refreshCalls()).toHaveLength(1);
    await setTokens(AT_A, 'rt2');
    const second = await run(productFetch('deciship', '/b'), 100);
    expect(second.status).toBe(403);
    expect(refreshCalls()).toHaveLength(1);
    vi.advanceTimersByTime(ACCESS_REFRESH_INTERVAL_MS);
    await run(productFetch('deciship', '/c'), 100);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('yenilenebilir işareti olmayan NO_PRODUCT_ACCESS yenileme tetiklemez', async () => {
    handler = () => errorResponse(403, 'NO_PRODUCT_ACCESS');
    const res = await run(productFetch('deciship', '/x'), 100);
    expect(res.status).toBe(403);
    expect(refreshCalls()).toHaveLength(0);
  });
});
