import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

/**
 * Kişinin kendi çıkışı (emülatör gezisi: `POST /auth/logout 499`, ardından `GET /api/account/me 200`). Telefondaki jetonlar
 * sunucunun yanıtını beklemeden silinir; sunucuya bildirim ayrıca, en iyi çabayla gider.
 */
const store = new Map<string, string>();
const pendingWrites: { key: string; run: () => void }[] = [];
let holdWrites = false;
let failDeletes = false;
/** Yalnız bu anahtarın silinmesi hata verir. */
let failDeleteKey: string | null = null;
const write = (key: string, apply: () => void, isDelete: boolean) =>
  new Promise<void>((resolve, reject) => {
    const run = () => {
      if (isDelete && (failDeletes || failDeleteKey === key)) return reject(new Error('keystore'));
      apply();
      resolve();
    };
    if (holdWrites) pendingWrites.push({ key, run });
    else run();
  });
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: (k: string, v: string) => write(k, () => store.set(k, v), false),
  deleteItemAsync: (k: string) => write(k, () => store.delete(k), true),
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: 2 } } },
    platform: { android: {} },
  },
}));

import { getRefreshToken, hasSession, loadSession, onForcedLogout, productFetch, setServerUrl, setTokens, signOut, signOutCount } from '../src/api/client';
import { clearUpgradeRequired } from '../src/version/policy';

const AT_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AT_A2 = fakeToken({ sub: 'ayse', org: 'firmaA', ep: 2 });
const isLogout = (url: string) => url.endsWith('/api/account/auth/logout');
const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');

type Call = { url: string; auth: string | null; body: { refreshToken?: string } | undefined };
let calls: Call[];
let handler: (url: string, signal: AbortSignal | undefined) => Response | Promise<Response>;
/** Yanıt hiç gelmez; yalnız zaman aşımı (iptal) düşürür. */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

beforeEach(async () => {
  vi.useFakeTimers();
  // Başarısız bir testin bekletilen yazımları sırayı tıkamasın.
  holdWrites = false;
  failDeletes = false;
  failDeleteKey = null;
  while (pendingWrites.length) pendingWrites.shift()!.run();
  store.clear();
  calls = [];
  handler = () => jsonResponse(204, {});
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('Authorization'), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return handler(url, init.signal ?? undefined);
  });
  await setServerUrl('http://gw:8088');
  await setTokens(AT_A, 'rt1');
  await clearUpgradeRequired();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('çıkış: telefondaki jetonlar sunucuyu beklemeden silinir', () => {
  it('sunucu yanıt vermiyor, uygulama hemen kapatıldı: güvenli depoda jeton kalmaz, yeniden açılışta oturum yok', async () => {
    handler = (url, signal) => (isLogout(url) ? hang(signal) : jsonResponse(200, { ok: true }));
    let done = false;
    void signOut().then(() => (done = true));
    // Sunucu yanıtı yok, zaman aşımı da dolmadı: "uygulama öldü".
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(store.has('sod_access_token')).toBe(false);
    expect(store.has('sod_refresh_token')).toBe(false);
    expect(hasSession()).toBe(false);
    // Yeniden açılış: bellek yeniden depodan okunur.
    const s = await loadSession();
    expect(s.refreshToken).toBeNull();
    expect(s.accessToken).toBeNull();
    expect(hasSession()).toBe(false);
  });

  it('sunucuya bildirim silinmeden önce alınan jetonla gider; Bearer eklenmez', async () => {
    await signOut();
    await vi.advanceTimersByTimeAsync(0);
    const logout = calls.filter((c) => isLogout(c.url));
    expect(logout).toHaveLength(1);
    expect(logout[0]!.body).toEqual({ refreshToken: 'rt1' });
    expect(logout[0]!.auth).toBeNull();
  });

  it('sunucu kapalı (ağ hatası): çıkış yine tamamlanır, hata dönmez', async () => {
    handler = (url) => {
      if (isLogout(url)) throw new TypeError('Network request failed');
      return jsonResponse(200, {});
    };
    await expect(signOut()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hasSession()).toBe(false);
    expect(store.has('sod_refresh_token')).toBe(false);
  });

  it('oturum yoksa sunucuya istek gitmez', async () => {
    await setTokens(null, null);
    calls = [];
    await signOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });

  it('güvenli depodan silme hata verdi: bellek yine boş, sunucuya bildirim yine gider, çıkış hata atmaz', async () => {
    failDeletes = true;
    await expect(signOut()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSession()).toBe(false);
    expect(calls.filter((c) => isLogout(c.url))).toHaveLength(1);
  });

  it('erişim jetonu depodan silinemedi: yenileme jetonu yine silinir, yeniden açılışta oturum geri gelmez', async () => {
    failDeleteKey = 'sod_access_token';
    await expect(signOut()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.has('sod_refresh_token')).toBe(false);
    await loadSession();
    expect(hasSession()).toBe(false);
  });

  it('bildirim yerel silmeden sonra çıkar: depo silmesi bitmeden sunucu jetonu iptal etmez', async () => {
    holdWrites = true;
    const out = signOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => isLogout(c.url))).toHaveLength(0);
    while (pendingWrites.length) {
      pendingWrites.shift()!.run();
      await vi.advanceTimersByTimeAsync(0);
    }
    await out;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => isLogout(c.url))).toHaveLength(1);
    expect(store.has('sod_refresh_token')).toBe(false);
  });

  it('çıkış sayacı artar (yolda kalan firma değişimi yanıtı çıkıştan sonra yazılmasın)', async () => {
    const before = signOutCount();
    await signOut();
    expect(signOutCount()).toBe(before + 1);
  });
});

describe('çıkış ile güvenli depo yazım sırası tutarlı', () => {
  it('yolda kalan yenileme yazımı geç bitse de çıkıştan sonra depoda jeton kalmaz', async () => {
    holdWrites = true;
    // Yenileme yanıtı yazılıyor (yerel modül yavaş), kişi çıkış yaptı.
    const refreshWrite = setTokens(AT_A2, 'rt2');
    const out = signOut();
    // Yerel modül çağrıları ters sırada bitirse bile.
    for (let round = 0; round < 10; round++) {
      while (pendingWrites.length) pendingWrites.pop()!.run();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all([refreshWrite, out]);
    expect(store.has('sod_refresh_token')).toBe(false);
    expect(store.has('sod_access_token')).toBe(false);
    // Bildirim çıkış anındaki (döndürülmüş) jetonla gider.
    expect(calls.filter((c) => isLogout(c.url)).map((c) => c.body?.refreshToken)).toEqual(['rt2']);
  });

  it('çıkış sırasında süren yenileme sunucudan 401 aldı: jeton geri gelmez, "Oturum sona erdi" olayı çıkmaz', async () => {
    let answerRefresh!: (r: Response) => void;
    handler = (url, signal) => {
      if (isRefresh(url)) return new Promise<Response>((r) => (answerRefresh = r));
      if (isLogout(url)) return hang(signal);
      return errorResponse(401, 'TOKEN_EXPIRED');
    };
    const forced = vi.fn();
    const off = onForcedLogout(forced);
    const req = productFetch('deciship', '/x');
    await vi.advanceTimersByTimeAsync(0);
    await signOut();
    // Sunucu jetonu iptal etti; yolda kalan yenileme 401 döner.
    answerRefresh(errorResponse(401, 'REFRESH_INVALID'));
    await req;
    await vi.advanceTimersByTimeAsync(0);
    off();
    expect(forced).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBeNull();
    expect(store.has('sod_refresh_token')).toBe(false);
  });

  it('çıkış sırasında süren yenileme başarılı döndü: yeni jeton yazılmaz', async () => {
    let answerRefresh!: (r: Response) => void;
    handler = (url, signal) => {
      if (isRefresh(url)) return new Promise<Response>((r) => (answerRefresh = r));
      if (isLogout(url)) return hang(signal);
      return errorResponse(401, 'TOKEN_EXPIRED');
    };
    const req = productFetch('deciship', '/x');
    await vi.advanceTimersByTimeAsync(0);
    await signOut();
    answerRefresh(jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' }));
    await req;
    await vi.advanceTimersByTimeAsync(0);
    expect(getRefreshToken()).toBeNull();
    expect(store.has('sod_refresh_token')).toBe(false);
    expect(store.has('sod_access_token')).toBe(false);
  });
});

describe('AuthContext çıkışı', () => {
  const src = readFileSync('src/auth/AuthContext.tsx', 'utf8');
  const logoutBody = src.slice(src.indexOf('const logout = useCallback'), src.indexOf('const access = useMemo'));

  it('sunucu yanıtını beklemez: yerel silme `signOut` ile, istek doğrudan atılmaz', () => {
    expect(logoutBody).toContain('await signOut()');
    expect(logoutBody).not.toContain("'/auth/logout'");
    expect(logoutBody).not.toContain('setTokens(');
  });

  it('kendi isteğiyle çıkan kişiye "Oturum sona erdi" gösterilmez', () => {
    expect(logoutBody).toContain('setExpired(false)');
  });

  it('profil okuması sürerken çıkılıp başka hesapla girildiyse eski yanıt yeni oturuma yazılmaz', () => {
    const body = src.slice(src.indexOf('const refreshProfile = useCallback'), src.indexOf('useEffect(() => {', src.indexOf('const refreshProfile = useCallback')));
    expect(body).toMatch(/const signOutsAtStart = signOutCount\(\);/);
    expect(body).toMatch(/if \(stale\(\) \|\| fetched\.person\.id !== currentPersonId\(\)\) return;/);
    // Eski isteğin hatası yeni kişiye "profil okunamadı" göstermez.
    expect(body.slice(body.indexOf('catch (e)'))).toMatch(/^catch \(e\) \{\s*if \(stale\(\)\) return;/);
  });

  it('firma değişimi yanıtı çıkıştan sonra geldiyse oturuma yazılmaz', () => {
    const switchBody = src.slice(src.indexOf('const switchOrg = useCallback'), src.indexOf('const logout = useCallback'));
    expect(switchBody).toContain('signOutCount()');
  });
});
