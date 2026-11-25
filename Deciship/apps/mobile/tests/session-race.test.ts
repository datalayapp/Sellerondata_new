import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, jsonResponse } from './helpers';

/** Güvenli depo: her yazım ayrı bir sözle, testin seçtiği sırada biter (yerel modülde çağrılar sırayla bitmeyebilir). */
const store = new Map<string, string>();
const pendingWrites: { key: string; run: () => void }[] = [];
let holdWrites = false;
let failWrites = false;
const write = (key: string, apply: () => void) =>
  new Promise<void>((resolve, reject) => {
    const run = () => {
      if (failWrites) return reject(new Error('disk full'));
      apply();
      resolve();
    };
    if (holdWrites) pendingWrites.push({ key, run });
    else run();
  });
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: (k: string, v: string) => write(k, () => store.set(k, v)),
  deleteItemAsync: (k: string) => write(k, () => store.delete(k)),
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development', apiUrl: 'http://127.0.0.1:8088', versionCode: 2 } } },
    platform: { android: {} },
  },
}));

import { getRefreshToken, hasSession, productFetch, setServerUrl, setTokens } from '../src/api/client';
import { clearUpgradeRequired } from '../src/version/policy';

const AT_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AT_A2 = fakeToken({ sub: 'ayse', org: 'firmaA', ep: 2 });
const isRefresh = (url: string) => url.endsWith('/api/account/auth/refresh');

let handler: (url: string, auth: string | null) => Response | Promise<Response>;

beforeEach(async () => {
  store.clear();
  pendingWrites.length = 0;
  holdWrites = false;
  failWrites = false;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => handler(url, new Headers(init.headers).get('Authorization')));
  await setServerUrl('http://gw:8088');
  await setTokens(AT_A, 'rt1');
  await clearUpgradeRequired();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('çıkış sırasında süren yenileme: çıkılmış oturum geri gelmez (hayalet oturum)', () => {
  it('yenileme yanıtının gövdesi okunurken çıkış yapıldı: yeni jeton belleğe de depoya da yazılmaz', async () => {
    let releaseBody!: () => void;
    const bodyRead = new Promise<void>((r) => (releaseBody = r));
    let inBody!: () => void;
    const reachedBody = new Promise<void>((r) => (inBody = r));
    handler = (url, auth) => {
      if (isRefresh(url)) {
        // Başlık geldi, gövde henüz okunuyor.
        const res = jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' });
        const json = res.json.bind(res);
        return Object.assign(res, {
          json: async () => {
            inBody();
            await bodyRead;
            return json();
          },
        });
      }
      return auth === `Bearer ${AT_A2}` ? jsonResponse(200, { ok: true }) : errorResponse(401, 'TOKEN_EXPIRED');
    };
    const req = productFetch('deciship', '/x');
    // Yenileme başladı, gövde bekleniyor: kişi çıkış yaptı.
    await reachedBody;
    await setTokens(null, null);
    releaseBody();
    const res = await req;
    expect(res.status).toBe(401);
    expect(hasSession()).toBe(false);
    expect(getRefreshToken()).toBeNull();
    expect(store.has('sod_refresh_token')).toBe(false);
    expect(store.has('sod_access_token')).toBe(false);
  });

  it('depo yazımları sırayla: önceki yazım geç bitse de son çağrının durumu kalır (çıkıştan sonra depoda jeton yok)', async () => {
    holdWrites = true;
    const a = setTokens(AT_A2, 'rt2');
    const b = setTokens(null, null);
    // Yerel modül çağrıları ters sırada bitirse bile ikinci çağrının yazımı birincininkinden sonra başlar.
    for (let round = 0; round < 10; round++) {
      while (pendingWrites.length) pendingWrites.pop()!.run();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([a, b]);
    expect(store.has('sod_refresh_token')).toBe(false);
    expect(store.has('sod_access_token')).toBe(false);
    expect(hasSession()).toBe(false);
  });

  it('bir yazım hatası yalnız o çağrıya döner, sonraki yazımlar sürer', async () => {
    failWrites = true;
    await expect(setTokens(AT_A2, 'rt2')).rejects.toThrow('disk full');
    failWrites = false;
    await setTokens(AT_A, 'rt3');
    expect(store.get('sod_refresh_token')).toBe('rt3');
  });

  it('yenilenen jeton depoya yazılamadı (depolama dolu): istek yine yeni jetonla geçer, 503 görmez', async () => {
    handler = (url, auth) => {
      if (isRefresh(url)) return jsonResponse(200, { expiresIn: 600, activeOrgId: 'firmaA', accessToken: AT_A2, refreshToken: 'rt2' });
      return auth === `Bearer ${AT_A2}` ? jsonResponse(200, { ok: true }) : errorResponse(401, 'TOKEN_EXPIRED');
    };
    failWrites = true;
    // POST: GET'in "meşgul" tekrarı sonucu örtmesin (kuyruk gönderimi de POST'tur ve tekrarlanmaz).
    const res = await productFetch('deciship', '/x', { method: 'POST', json: {} });
    failWrites = false;
    expect(res.status).toBe(200);
    expect(getRefreshToken()).toBe('rt2');
  });
});
