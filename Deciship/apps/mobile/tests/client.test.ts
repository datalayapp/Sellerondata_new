import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void store.set(k, v),
  deleteItemAsync: async (k: string) => void store.delete(k),
}));
const constants = vi.hoisted(() => ({
  expoConfig: {
    version: '1.1.0',
    android: { versionCode: 2 },
    extra: { sod: { appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: 2 } },
  },
  platform: { android: {} },
}));
vi.mock('expo-constants', () => ({ default: constants }));

import {
  accountFetch,
  accountJson,
  ApiError,
  applyAuthResponse,
  currentSessionScope,
  getRefreshToken,
  hasSession,
  loadSession,
  onForcedLogout,
  productFetch,
  productJson,
  recoverOrgSession,
  SCOPE_MISMATCH,
  setServerUrl,
  fetchClientPolicy,
  pingServer,
  setTokens,
} from '../src/api/client';
import { i18n, setLocale } from '../src/i18n';
import { clearUpgradeRequired, getUpgradeState, K_UPGRADE } from '../src/version/policy';

const AT_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AT_A2 = fakeToken({ sub: 'ayse', org: 'firmaA', ep: 2 });
const AT_B = fakeToken({ sub: 'ayse', org: 'firmaB' });
const scopeA = { personId: 'ayse', orgId: 'firmaA' };

type Call = { url: string; auth: string | null; lang: string | null; client: string | null; method: string; cache: RequestCache | undefined; body: unknown; sentAt: string | null; at: number };
let calls: Call[];
let handler: (url: string, call: Call) => Response | Promise<Response>;

beforeEach(async () => {
  store.clear();
  calls = [];
  handler = () => jsonResponse(200, { ok: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      url,
      auth: headers.get('Authorization'),
      lang: headers.get('Accept-Language'),
      client: headers.get('X-SOD-Client'),
      method: init.method ?? 'GET',
      cache: init.cache,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      sentAt: headers.get('X-SOD-Sent-At'),
      at: Date.now(),
    };
    calls.push(call);
    return handler(url, call);
  });
  await setServerUrl('http://gw:8088');
  await setTokens(AT_A, 'rt1');
  await clearUpgradeRequired();
});

afterEach(() => vi.unstubAllGlobals());

const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');

describe('kökler', () => {
  it('accountFetch /api/account, productFetch /api/<ürün> altına gider', async () => {
    await accountFetch('/me');
    await productFetch('deciship', '/measurements');
    expect(calls.map((c) => c.url)).toEqual(['http://gw:8088/api/account/me', 'http://gw:8088/api/deciship/measurements']);
  });

  it('fetch gibi davranır: hata yanıtını atmaz, Response döner', async () => {
    handler = () => errorResponse(403, 'FORBIDDEN');
    const res = await accountFetch('/org/members');
    expect(res.status).toBe(403);
  });

  it('Bearer ve Accept-Language her isteğe gider, dil değişimini izler', async () => {
    await setLocale('en');
    await productFetch('deciship', '/x');
    await setLocale('tr');
    await productFetch('deciship', '/x');
    expect(calls[0]?.auth).toBe(`Bearer ${AT_A}`);
    expect(calls[0]?.lang).toBe('en');
    expect(calls[1]?.lang).toBe('tr');
    expect(i18n.language).toBe('tr');
  });

  it('çağıranın Accept-Language başlığı önceliklidir, çift başlık olmaz', async () => {
    await accountFetch('/me', { headers: { 'Accept-Language': 'en' } });
    expect(calls[0]?.lang).toBe('en');
  });
});

describe('yenileme', () => {
  for (const code of ['TOKEN_STALE', 'TOKEN_EXPIRED']) {
    it(`${code}: bir kez yeniler, yeni jetonu saklar, isteği bir kez tekrarlar`, async () => {
      let first = true;
      handler = (url) => {
        if (isRefresh(url)) return jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' });
        if (first) {
          first = false;
          return errorResponse(401, code);
        }
        return jsonResponse(200, { ok: true });
      };
      const out = await productJson<{ ok: boolean }>('deciship', '/x');
      expect(out.ok).toBe(true);
      expect(calls.map((c) => isRefresh(c.url))).toEqual([false, true, false]);
      // Tekrar anahtarı (6.8): 32 rastgele bayt, onaltılık.
      expect(calls[1]?.body).toEqual({ refreshToken: 'rt1', retryKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(calls[2]?.auth).toBe(`Bearer ${AT_A2}`);
      expect(getRefreshToken()).toBe('rt2');
      expect([...store.values()]).toContain('rt2');
    });
  }

  it('KALANLAR 6.7-b: stampSentAt: gönderim saati her denemede, jeton yenilemesinden sonra, istek çıkarken yazılır', async () => {
    let first = true;
    handler = async (url) => {
      if (isRefresh(url)) {
        await new Promise((r) => setTimeout(r, 60));
        return jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' });
      }
      if (first) {
        first = false;
        return errorResponse(401, 'TOKEN_EXPIRED');
      }
      return jsonResponse(200, { ok: true });
    };
    await productJson('deciship', '/measurements', { method: 'POST', json: {}, stampSentAt: true });
    const sends = calls.filter((c) => !isRefresh(c.url));
    expect(sends).toHaveLength(2);
    for (const c of sends) expect(Math.abs(Date.parse(c.sentAt!) - c.at)).toBeLessThan(20);
    expect(Date.parse(sends[1]!.sentAt!) - Date.parse(sends[0]!.sentAt!)).toBeGreaterThanOrEqual(50);
    expect(calls.find((c) => isRefresh(c.url))?.sentAt).toBeNull();
    // istemeyen istekte başlık yok
    await productFetch('deciship', '/x');
    expect(calls.at(-1)?.sentAt).toBeNull();
  });

  it('tekrar da 401 ise döngüye girmez', async () => {
    handler = (url) => (isRefresh(url) ? jsonResponse(200, { accessToken: AT_A2, refreshToken: 'rt2' }) : errorResponse(401, 'TOKEN_STALE'));
    const res = await productFetch('deciship', '/x');
    expect(res.status).toBe(401);
    expect(calls.filter((c) => isRefresh(c.url)).length).toBe(1);
    expect(calls.length).toBe(3);
  });

  it('aynı anda gelen 401ler tek yenileme yapar (jeton döner, ikinci yenileme aileyi düşürürdü)', async () => {
    handler = (url, call) => {
      if (isRefresh(url)) return jsonResponse(200, { accessToken: AT_A2, refreshToken: 'rt2' });
      return call.auth === `Bearer ${AT_A2}` ? jsonResponse(200, {}) : errorResponse(401, 'TOKEN_EXPIRED');
    };
    await Promise.all([productFetch('deciship', '/a'), productFetch('deciship', '/b'), accountFetch('/me')]);
    expect(calls.filter((c) => isRefresh(c.url)).length).toBe(1);
  });

  it('yanıtta refreshToken yoksa elimizdeki korunur', async () => {
    let first = true;
    handler = (url) => {
      if (isRefresh(url)) return jsonResponse(200, { accessToken: AT_A2 });
      if (first) {
        first = false;
        return errorResponse(401, 'TOKEN_EXPIRED');
      }
      return jsonResponse(200, {});
    };
    await productFetch('deciship', '/x');
    expect(getRefreshToken()).toBe('rt1');
  });

  it('yenileme 401: oturum kapanır, dinleyici haber alır', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? errorResponse(401, 'UNAUTHORIZED') : errorResponse(401, 'TOKEN_EXPIRED'));
    const res = await productFetch('deciship', '/x');
    off();
    expect(res.status).toBe(401);
    expect(forced).toHaveBeenCalledOnce();
    expect(hasSession()).toBe(false);
  });

  it('yenileme 403 EMAIL_NOT_VERIFIED: oturum kapanır, dinleyici haber alır, yeniden denenmez (Y35)', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? errorResponse(403, 'EMAIL_NOT_VERIFIED') : errorResponse(401, 'TOKEN_EXPIRED'));
    const res = await productFetch('deciship', '/x');
    expect(res.status).toBe(401);
    expect(forced).toHaveBeenCalledOnce();
    expect(hasSession()).toBe(false);
    expect(getRefreshToken()).toBeNull();
    // Oturum yok: sonraki istek yenileme ucuna gitmez.
    await productFetch('deciship', '/y');
    off();
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(1);
  });

  it('yenileme başka 403 alırsa oturum kapanmaz', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? errorResponse(403, 'FORBIDDEN') : errorResponse(401, 'TOKEN_EXPIRED'));
    await productFetch('deciship', '/x');
    off();
    expect(forced).not.toHaveBeenCalled();
    expect(hasSession()).toBe(true);
    expect(getRefreshToken()).toBe('rt1');
  });

  it('INVALID_CREDENTIALS yenileme tetiklemez', async () => {
    handler = () => errorResponse(401, 'INVALID_CREDENTIALS');
    const res = await accountFetch('/me/password', { method: 'POST', json: {} });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
    expect(hasSession()).toBe(true);
  });

  it('çıkış sonrası gelen yenileme yanıtı oturumu geri getirmez', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    handler = async (url) => {
      if (isRefresh(url)) {
        await gate;
        return jsonResponse(200, { accessToken: AT_A2, refreshToken: 'rt2' });
      }
      return errorResponse(401, 'TOKEN_EXPIRED');
    };
    const pending = productFetch('deciship', '/x');
    await vi.waitFor(() => expect(calls.some((c) => isRefresh(c.url))).toBe(true));
    await setTokens(null, null);
    release();
    await pending;
    expect(hasSession()).toBe(false);
    expect(getRefreshToken()).toBeNull();
  });
});

describe('503 AUTH_UNAVAILABLE oturumu kapatmaz', () => {
  it('ürün 503 döndürürse (POST) yenileme denenmez, oturum durur', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = () => errorResponse(503, 'AUTH_UNAVAILABLE');
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    off();
    expect(res.status).toBe(503);
    expect(calls.length).toBe(1);
    expect(forced).not.toHaveBeenCalled();
    expect(hasSession()).toBe(true);
  });

  it('GET bir kez daha dener', async () => {
    let n = 0;
    handler = () => (n++ === 0 ? errorResponse(503, 'AUTH_UNAVAILABLE') : jsonResponse(200, { ok: 1 }));
    const res = await productFetch('deciship', '/x');
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  }, 5000);

  it('jeton süresi dolmuş ve hesap servisi 5xx: oturum kapanmaz, çağıran 503 görür', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? errorResponse(502, 'BAD_GATEWAY') : errorResponse(401, 'TOKEN_EXPIRED'));
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    off();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_UNAVAILABLE');
    expect(forced).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('rt1');
  });

  it('yenileme ağda koparsa da oturum kapanmaz', async () => {
    handler = (url) => {
      if (isRefresh(url)) throw new TypeError('Network request failed');
      return errorResponse(401, 'TOKEN_EXPIRED');
    };
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    expect(res.status).toBe(503);
    expect(hasSession()).toBe(true);
  });
});

describe('requirePerson: kişi ayarı yalnız sahibinin jetonuyla çıkar', () => {
  it('jeton uyuyorsa gider', async () => {
    await accountFetch('/me', { method: 'PATCH', json: {}, requirePerson: 'ayse' });
    expect(calls.length).toBe(1);
  });

  it('401 tekrarı başka kişinin jetonuyla gitmez', async () => {
    handler = (url) => {
      if (isRefresh(url)) return jsonResponse(200, { activeOrgId: 'firmaA', accessToken: fakeToken({ sub: 'mehmet', org: 'firmaA' }), refreshToken: 'rt2' });
      return errorResponse(401, 'TOKEN_STALE');
    };
    await expect(accountFetch('/me', { method: 'PATCH', json: {}, requirePerson: 'ayse' })).rejects.toMatchObject({ code: SCOPE_MISMATCH });
    expect(calls.filter((c) => c.url.endsWith('/me')).length).toBe(1);
  });
});

describe('requireScope: kuyruk kaydı yalnız sahibinin jetonuyla çıkar', () => {
  it('jeton uyuyorsa gider', async () => {
    await productFetch('deciship', '/measurements', { method: 'POST', json: {}, requireScope: scopeA });
    expect(calls.length).toBe(1);
  });

  it('başka firmanın jetonuyla ağa çıkmaz', async () => {
    await setTokens(AT_B, 'rt1');
    await expect(productFetch('deciship', '/measurements', { method: 'POST', json: {}, requireScope: scopeA })).rejects.toMatchObject({ code: SCOPE_MISMATCH });
    expect(calls.length).toBe(0);
  });

  it('başka kişinin jetonuyla ağa çıkmaz', async () => {
    await setTokens(fakeToken({ sub: 'mehmet', org: 'firmaA' }), 'rt9');
    await expect(productFetch('deciship', '/measurements', { method: 'POST', requireScope: scopeA })).rejects.toBeInstanceOf(ApiError);
    expect(calls.length).toBe(0);
  });

  it('oturum yokken ağa çıkmaz', async () => {
    await setTokens(null, null);
    await expect(productFetch('deciship', '/measurements', { method: 'POST', requireScope: scopeA })).rejects.toMatchObject({ code: SCOPE_MISMATCH });
    expect(calls.length).toBe(0);
  });

  it('yenileme firmayı değiştirirse tekrar deneme gitmez (üyelik bitti, sunucu başka firma seçti)', async () => {
    handler = (url) => {
      if (isRefresh(url)) return jsonResponse(200, { activeOrgId: 'firmaB', accessToken: AT_B, refreshToken: 'rt2' });
      return errorResponse(401, 'TOKEN_STALE');
    };
    await expect(productFetch('deciship', '/measurements', { method: 'POST', json: {}, requireScope: scopeA })).rejects.toMatchObject({ code: SCOPE_MISMATCH });
    expect(calls.filter((c) => c.url.endsWith('/measurements')).length).toBe(1);
    expect(currentSessionScope()).toEqual({ personId: 'ayse', orgId: 'firmaB' });
  });
});

describe('ORG_REQUIRED: firmasız jetondan toparlanma', () => {
  const NO_ORG = fakeToken({ sub: 'ayse', org: null });

  beforeEach(async () => {
    await setTokens(NO_ORG, 'rt1');
  });

  it('bir kez yeniler, firma geldiyse isteği bir kez daha dener', async () => {
    handler = (url, call) => {
      if (isRefresh(url)) return jsonResponse(200, { activeOrgId: 'firmaA', accessToken: AT_A, refreshToken: 'rt2' });
      return call.auth === `Bearer ${AT_A}` ? jsonResponse(200, { ok: 1 }) : errorResponse(403, 'ORG_REQUIRED');
    };
    const res = await productFetch('deciship', '/measurements');
    expect(res.status).toBe(200);
    expect(calls.map((c) => isRefresh(c.url))).toEqual([false, true, false]);
    expect(currentSessionScope()).toEqual(scopeA);
  });

  it('kişide firma yoksa tekrar denemez, 403 çağırana döner, oturum kapanmaz', async () => {
    handler = (url) => (isRefresh(url) ? jsonResponse(200, { activeOrgId: null, accessToken: NO_ORG, refreshToken: 'rt2' }) : errorResponse(403, 'ORG_REQUIRED'));
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    expect(res.status).toBe(403);
    expect(calls.map((c) => isRefresh(c.url))).toEqual([false, true]);
    expect(hasSession()).toBe(true);
  });

  it('döngü yok: firma yokken art arda istekler jetonu her seferinde döndürmez', async () => {
    handler = (url) => (isRefresh(url) ? jsonResponse(200, { activeOrgId: null, accessToken: NO_ORG, refreshToken: 'rt2' }) : errorResponse(403, 'ORG_REQUIRED'));
    await productFetch('deciship', '/a');
    await productFetch('deciship', '/b');
    await productFetch('deciship', '/c');
    expect(calls.filter((c) => isRefresh(c.url)).length).toBe(1);
    expect(calls.filter((c) => !isRefresh(c.url)).length).toBe(3);
  });

  it('hesap servisi yoksa oturum kapanmaz, çağıran 503 görür', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? errorResponse(503, 'DB_UNAVAILABLE') : errorResponse(403, 'ORG_REQUIRED'));
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    off();
    expect(res.status).toBe(503);
    expect(forced).not.toHaveBeenCalled();
    expect(hasSession()).toBe(true);
  });

  it('kapsam bozulmaz: yenileme başka firma verirse kuyruk isteği ağa çıkmaz', async () => {
    await setTokens(AT_A, 'rt1');
    let first = true;
    handler = (url) => {
      if (isRefresh(url)) return jsonResponse(200, { activeOrgId: 'firmaB', accessToken: AT_B, refreshToken: 'rt2' });
      if (first) {
        first = false;
        return errorResponse(403, 'ORG_REQUIRED');
      }
      return jsonResponse(201, {});
    };
    await expect(productFetch('deciship', '/measurements', { method: 'POST', json: {}, requireScope: scopeA })).rejects.toMatchObject({ code: SCOPE_MISMATCH });
    expect(calls.filter((c) => c.url.endsWith('/measurements')).length).toBe(1);
  });

  it('başka 403 yenileme tetiklemez', async () => {
    handler = () => errorResponse(403, 'READ_ONLY');
    await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    expect(calls.length).toBe(1);
  });

  it('recoverOrgSession: firma gelirse kapsamı döner, kısa sürede ikinci yenileme yapmaz', async () => {
    handler = (url) => (isRefresh(url) ? jsonResponse(200, { activeOrgId: null, accessToken: NO_ORG, refreshToken: 'rt2' }) : jsonResponse(200, {}));
    await expect(recoverOrgSession()).resolves.toBeNull();
    await expect(recoverOrgSession()).resolves.toBeNull();
    expect(calls.filter((c) => isRefresh(c.url)).length).toBe(1);
  });

  it('recoverOrgSession: firması olan oturumda ağa çıkmaz', async () => {
    await setTokens(AT_A, 'rt1');
    await expect(recoverOrgSession()).resolves.toEqual(scopeA);
    expect(calls.length).toBe(0);
  });

  it('recoverOrgSession: firma gelince kapsamı döner', async () => {
    handler = () => jsonResponse(200, { activeOrgId: 'firmaA', accessToken: AT_A, refreshToken: 'rt2' });
    await expect(recoverOrgSession()).resolves.toEqual(scopeA);
  });
});

describe('oturum kalıcılığı', () => {
  it('firma değişimi yanıtında refreshToken yoksa elimizdeki korunur', async () => {
    await applyAuthResponse({ expiresIn: 600, activeOrgId: 'firmaB', accessToken: AT_B });
    expect(getRefreshToken()).toBe('rt1');
    expect(currentSessionScope()).toEqual({ personId: 'ayse', orgId: 'firmaB' });
  });

  it('SecureStore\'dan yüklenir', async () => {
    await loadSession();
    expect(hasSession()).toBe(true);
    expect(currentSessionScope()).toEqual(scopeA);
  });

  it('hata gövdesi ApiError olur: code + yerelleşmiş message', async () => {
    handler = () => errorResponse(403, 'READ_ONLY', 'Abonelik salt okunur');
    await expect(accountJson('/x')).rejects.toMatchObject({ status: 403, code: 'READ_ONLY', message: 'Abonelik salt okunur' });
  });
});

const upgradeBody = (details: unknown = { minVersion: '9.0.0', updateUrl: 'https://example.com/android' }) =>
  jsonResponse(426, { error: { code: 'UPGRADE_REQUIRED', message: 'eski', details } });

describe('X-SOD-Client sürüm başlığı (Mesaj 13 §3.3)', () => {
  it('her isteğe gider: ürün, hesap, oturumsuz istek ve yenileme', async () => {
    let first = true;
    handler = (url) => {
      if (isRefresh(url)) return jsonResponse(200, { accessToken: AT_A2, refreshToken: 'rt2' });
      if (first) {
        first = false;
        return errorResponse(401, 'TOKEN_EXPIRED');
      }
      return jsonResponse(200, {});
    };
    await productFetch('deciship', '/x');
    await accountFetch('/auth/login', { method: 'POST', json: {}, auth: false });
    await productFetch('deciship', '/measurements', { method: 'POST', form: new FormData() });
    expect(calls.length).toBe(5);
    for (const c of calls) expect(c.client).toBe('mobile/1.1.0+2 (android)');
  });

  it('çağıran başlığı ezemez', async () => {
    await accountFetch('/me', { headers: { 'X-SOD-Client': 'mobile/99.0.0' } });
    expect(calls[0]?.client).toBe('mobile/1.1.0+2 (android)');
  });
});

describe('426 UPGRADE_REQUIRED', () => {
  it('yanıt güncelleme durumunu açar ve telefona yazar (sürümüyle)', async () => {
    handler = () => upgradeBody();
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    expect(res.status).toBe(426);
    expect(getUpgradeState()).toEqual({ required: true, minVersion: '9.0.0', updateUrl: 'https://example.com/android' });
    await vi.waitFor(() => expect(store.get(K_UPGRADE)).toBeDefined());
    expect(JSON.parse(store.get(K_UPGRADE)!)).toEqual({ minVersion: '9.0.0', updateUrl: 'https://example.com/android', forVersion: '1.1.0' });
  });

  it('productJson ApiError(426, UPGRADE_REQUIRED) atar', async () => {
    handler = () => upgradeBody();
    await expect(productJson('deciship', '/measurements', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 426, code: 'UPGRADE_REQUIRED' });
  });

  it('başka hata ya da JSON olmayan 426 durumu açmaz', async () => {
    handler = () => errorResponse(400, 'VALIDATION');
    await productFetch('deciship', '/x');
    handler = () => new Response('<html>426</html>', { status: 426 });
    await productFetch('deciship', '/x');
    expect(getUpgradeState()).toEqual({ required: false });
  });

  it('yenileme ucu 426 alırsa oturum silinmez, çağıran 426 görür, durum açılır', async () => {
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    handler = (url) => (isRefresh(url) ? upgradeBody({ minVersion: '9.0.0', updateUrl: null }) : errorResponse(401, 'TOKEN_EXPIRED'));
    await expect(productJson('deciship', '/measurements', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 426, code: 'UPGRADE_REQUIRED' });
    off();
    expect(forced).not.toHaveBeenCalled();
    expect(hasSession()).toBe(true);
    expect(getRefreshToken()).toBe('rt1');
    expect(store.get('sod_refresh_token')).toBe('rt1');
    expect(getUpgradeState()).toEqual({ required: true, minVersion: '9.0.0', updateUrl: null });
    // İstek yenilemeden sonra bir daha gönderilmedi.
    expect(calls.filter((c) => !isRefresh(c.url)).length).toBe(1);
  });

  it('firmasız jetonda ORG_REQUIRED yenilemesi 426 alırsa da oturum kalır', async () => {
    await setTokens(fakeToken({ sub: 'ayse', org: null }), 'rt1');
    handler = (url) => (isRefresh(url) ? upgradeBody() : errorResponse(403, 'ORG_REQUIRED'));
    const res = await productFetch('deciship', '/measurements', { method: 'POST', json: {} });
    expect(res.status).toBe(426);
    expect(hasSession()).toBe(true);
  });
});

describe('fetchClientPolicy', () => {
  it('oturumsuz, sürüm başlığıyla hesap servisinin politika ucuna gider', async () => {
    handler = () => jsonResponse(200, { mobile: { minVersion: null, latestVersion: null, updateUrl: null } });
    const res = await fetchClientPolicy();
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe('http://gw:8088/api/account/client-policy');
    expect(calls[0]?.auth).toBeNull();
    expect(calls[0]?.client).toBe('mobile/1.1.0+2 (android)');
  });

  it('önbellekten okunmaz (cache: no-store): "Yeniden denetle" sunucunun son kararını görür', async () => {
    handler = () => jsonResponse(200, { mobile: { minVersion: null, latestVersion: null, updateUrl: null } });
    await fetchClientPolicy();
    expect(calls[0]?.cache).toBe('no-store');
  });

  it('5 sn içinde yanıt yoksa vazgeçer (TIMEOUT), uygulamayı bekletmez', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      );
      const p = fetchClientPolicy();
      const check = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(5001);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pingServer: sunucuya ulaşılıyor mu (KALANLAR 4.9)', () => {
  it('DeciShip sağlık ucuna oturumsuz, önbelleksiz gider; yalnız { ok: true } ulaşıldı sayılır', async () => {
    handler = () => jsonResponse(200, { ok: true });
    expect(await pingServer()).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'http://gw:8088/api/deciship/health', auth: null, cache: 'no-store', method: 'GET' });
  });

  it('karşılama sayfası (200 HTML), ağ geçidinin 502’si ve ağ hatası: ulaşılamıyor', async () => {
    handler = () => new Response('<html>Wi-Fi giriş</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    expect(await pingServer()).toBe(false);
    handler = () => errorResponse(502, 'BAD_GATEWAY');
    expect(await pingServer()).toBe(false);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Network request failed');
    });
    expect(await pingServer()).toBe(false);
  });

  it('zaman aşımında vazgeçer, atmaz', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      );
      const p = pingServer(1000);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sunucu adresi: geliştirme dışında değiştirilemez (09-B2)', () => {
  afterEach(() => {
    constants.expoConfig.extra.sod.appEnv = 'development';
    constants.expoConfig.extra.sod.apiUrl = 'http://127.0.0.1:8088';
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshClient(appEnv: string, apiUrl: string) {
    constants.expoConfig.extra.sod.appEnv = appEnv;
    constants.expoConfig.extra.sod.apiUrl = apiUrl;
    vi.stubEnv('EXPO_PUBLIC_API_URL', apiUrl);
    vi.resetModules();
    return import('../src/api/client');
  }

  it('üretimde kayıtlı adres okunmaz, setServerUrl adresi değiştirmez', async () => {
    store.set('sod_gateway_url', 'http://evil.example:8088');
    const m = await freshClient('production', 'https://app.sellerondata.com');
    expect(m.SERVER_EDITABLE).toBe(false);
    await m.loadSession();
    expect(m.getServerUrl()).toBe('https://app.sellerondata.com');
    await m.setServerUrl('http://evil.example:8088');
    expect(m.getServerUrl()).toBe('https://app.sellerondata.com');
  });

  it('preview de üretim gibi', async () => {
    const m = await freshClient('preview', 'https://app.sellerondata.com');
    expect(m.SERVER_EDITABLE).toBe(false);
  });

  it('geliştirmede kayıtlı adres okunur ve değiştirilebilir', async () => {
    store.set('sod_gateway_url', 'http://10.0.2.2:8088');
    const m = await freshClient('development', 'http://127.0.0.1:8088');
    expect(m.SERVER_EDITABLE).toBe(true);
    await m.loadSession();
    expect(m.getServerUrl()).toBe('http://10.0.2.2:8088');
  });
});
