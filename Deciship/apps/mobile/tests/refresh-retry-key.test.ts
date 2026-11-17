import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

/**
 * KALANLAR 6.8: yenilemenin tekrar anahtarı. Hesap servisi döndürülmüş eski jetonu, yeni jeton henüz kullanılmadıysa, aynı anahtarla
 * geldiğinde süre aramadan kabul eder (`Platform/apps/account-api/src/lib/sessions.ts` `refreshSession`). Telefon anahtarı eski
 * jetonla birlikte saklar ve jeton değişene dek her denemede (sonraki istek, uygulamanın yeniden açılışı) aynısını gönderir.
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

const K_RETRY = 'sod_refresh_retry';
/** Depodaki kayıt: `<jetonun SHA-256 özeti>:<anahtar>`. */
const tagOf = (token: string) => createHash('sha256').update(token).digest('hex');
const stored = (token: string, key: string | undefined) => `${tagOf(token)}:${key}`;
const K_REFRESH = 'sod_refresh_token';
const AT_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AT_A2 = fakeToken({ sub: 'ayse', org: 'firmaA', ep: 2 });

type Body = { refreshToken?: string; retryKey?: string };
type Call = { url: string; at: number; auth: string | null; body: Body | undefined; storedKey: string | undefined };
let calls: Call[];
let handler: (url: string, call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');
const refreshCalls = () => calls.filter((c) => isRefresh(c.url));
const hang = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
const rotated = (rt = 'rt2') => jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: rt });
const productOk = (call: Call) => (call.auth === `Bearer ${AT_A2}` ? jsonResponse(200, { ok: true }) : errorResponse(401, 'TOKEN_EXPIRED'));

type Client = typeof import('../src/api/client');
let client: Client;

/** Uygulamanın (yeniden) açılışı: modül durumu sıfırlanır, güvenli depo kalır. */
async function boot(): Promise<Client> {
  vi.resetModules();
  client = await import('../src/api/client');
  await client.setServerUrl('http://gw:8088');
  return client;
}

async function run<T>(p: Promise<T>, ms = 30_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

/**
 * Sunucu benzeri: ilk yenileme döndürülür, anahtarı kaydedilir; ilk dakika boyunca hiçbir yanıt telefona ulaşmaz (uçuş içindeki
 * tekrarlar dahil). Sonra gelen eski jeton ancak aynı anahtarla kabul edilir (süre penceresi geçti sayılır).
 */
function lossyServer() {
  let rotatedKey: string | undefined;
  let lostUntil = 0;
  handler = (url, call, signal) => {
    if (!isRefresh(url)) return productOk(call);
    if (call.body?.refreshToken !== 'rt1') return errorResponse(401, 'UNAUTHORIZED');
    if (rotatedKey === undefined) {
      rotatedKey = call.body.retryKey ?? '';
      lostUntil = Date.now() + 60_000;
    }
    if (Date.now() < lostUntil) return hang(signal);
    return call.body.retryKey && call.body.retryKey === rotatedKey ? rotated() : errorResponse(401, 'UNAUTHORIZED');
  };
}

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
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Body) : undefined,
      storedKey: store.get(K_RETRY),
    };
    calls.push(call);
    return handler(url, call, init.signal ?? undefined);
  });
  await boot();
  await client.setTokens(AT_A, 'rt1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('6.8: yenilemenin tekrar anahtarı', () => {
  it('anahtar istek çıkmadan güvenli depoya yazılır; uçuş içindeki tekrarlar aynı anahtarı taşır', async () => {
    handler = (url, call) => {
      if (!isRefresh(url)) return productOk(call);
      if (refreshCalls().length === 1) throw new TypeError('Network request failed');
      return rotated();
    };
    const res = await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(res.status).toBe(200);
    const [first, second] = refreshCalls();
    expect(first?.body?.retryKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.storedKey).toBe(stored('rt1', first?.body?.retryKey));
    expect(second?.body).toEqual(first?.body);
  });

  it('yanıt kayboldu, pencere geçti: dakikalar sonraki istek aynı jeton ve anahtarla yeniler, oturum sürer', async () => {
    lossyServer();
    const forced = vi.fn();
    const off = client.onForcedLogout(forced);
    const lost = await run(client.productFetch('deciship', '/measurements', { method: 'POST', json: {} }), 60_000);
    expect(lost.status).toBe(503);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const later = await run(client.productFetch('deciship', '/measurements', { method: 'POST', json: {} }));
    off();
    expect(later.status).toBe(200);
    const keys = new Set(refreshCalls().map((c) => c.body?.retryKey));
    expect(keys.size).toBe(1);
    expect(forced).not.toHaveBeenCalled();
    expect(client.getRefreshToken()).toBe('rt2');
  });

  it('uygulama yeniden açıldı (yanıt depoya yazılamadan kapandı): depodaki jeton anahtarıyla birlikte gider', async () => {
    lossyServer();
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }), 60_000);
    const sentKey = refreshCalls()[0]?.body?.retryKey;
    expect(store.get(K_RETRY)).toBe(stored('rt1', sentKey));
    await boot();
    await client.loadSession();
    expect(client.getRefreshToken()).toBe('rt1');
    const res = await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(res.status).toBe(200);
    expect(refreshCalls().at(-1)?.body).toEqual({ refreshToken: 'rt1', retryKey: sentKey });
  });

  it('açılışta başka jetona ait ya da bozuk anahtar kaydı atılır; yeni anahtar üretilir', async () => {
    for (const bad of [stored('rt0', 'a'.repeat(64)), 'bozuk', `:${'b'.repeat(64)}`]) {
      calls = [];
      store.set(K_REFRESH, 'rt1');
      store.set('sod_access_token', AT_A);
      store.set(K_RETRY, bad);
      await boot();
      await client.loadSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.has(K_RETRY), bad).toBe(false);
      handler = (url, call) => (isRefresh(url) ? rotated() : productOk(call));
      await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
      const key = refreshCalls()[0]?.body?.retryKey;
      expect(key, bad).toMatch(/^[0-9a-f]{64}$/);
      expect(bad.endsWith(key as string), bad).toBe(false);
    }
  });

  it('yeni jeton yazılınca anahtar silinir; sonraki yenileme yeni anahtar üretir', async () => {
    let n = 0;
    handler = (url, call) => (isRefresh(url) ? rotated(`rt${(n += 1) + 1}`) : productOk(call));
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(client.getRefreshToken()).toBe('rt2');
    expect(store.get(K_REFRESH)).toBe('rt2');
    expect(store.has(K_RETRY)).toBe(false);
    // Erişim jetonu bayatlasın: ikinci yenileme.
    await client.setTokens(AT_A, 'rt2');
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
    const [a, b] = refreshCalls();
    expect(b?.body?.refreshToken).toBe('rt2');
    expect(b?.body?.retryKey).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.body?.retryKey).not.toBe(a?.body?.retryKey);
  });

  it('firma değişimi gibi jetonu korumayan yanıt anahtarı silmez', async () => {
    lossyServer();
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }), 60_000);
    const key = store.get(K_RETRY);
    expect(key).toBeTruthy();
    await client.applyAuthResponse({ accessToken: AT_A, expiresIn: 600, activeOrgId: 'firmaA' } as never);
    expect(store.get(K_RETRY)).toBe(key);
  });

  it('çıkış anahtarı da siler; başka hesapla girişte eski anahtar gönderilmez', async () => {
    lossyServer();
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }), 60_000);
    const oldKey = store.get(K_RETRY);
    await client.signOut();
    expect(store.has(K_RETRY)).toBe(false);
    await client.setTokens(AT_A, 'rt1');
    handler = (url, call) => (isRefresh(url) ? rotated() : productOk(call));
    await run(client.productFetch('deciship', '/x', { method: 'POST', json: {} }));
    expect(refreshCalls().at(-1)?.body?.retryKey).not.toBe(oldKey);
  });
});
