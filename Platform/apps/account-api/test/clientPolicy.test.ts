import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API, errorCode, getApp, login, randomIp, registerOrg, webHeaders } from './helpers.ts';
import { assertMobileVersions } from '../src/env.ts';

const NAMES = ['MIN_MOBILE_VERSION', 'MOBILE_LATEST_VERSION', 'MOBILE_UPDATE_URL', 'NODE_ENV'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
  for (const k of ['MIN_MOBILE_VERSION', 'MOBILE_LATEST_VERSION', 'MOBILE_UPDATE_URL']) delete process.env[k];
});
afterEach(() => {
  for (const k of NAMES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const OLD = { 'x-sod-client': 'mobile/1.0.0+1 (android)' };

describe('GET /client-policy ve 426', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `${API}${url}`, headers, remoteAddress: randomIp() });

  // Mesaj 13 inceleme: önbellekte tutulan yanıt "Yeniden denetle"yi yanıltıyordu (Android OkHttp 60 sn). Sözleşme: no-cache.
  it('ortam yoksa üç alan null, önbelleğe alınmaz', async () => {
    const res = await get('/client-policy');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mobile: { minVersion: null, latestVersion: null, updateUrl: null } });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('ortam doluysa değerler döner', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    process.env.MOBILE_LATEST_VERSION = '1.2.0';
    process.env.MOBILE_UPDATE_URL = 'https://example.com/apk';
    const res = await get('/client-policy');
    expect(res.json()).toEqual({ mobile: { minVersion: '1.1.0', latestVersion: '1.2.0', updateUrl: 'https://example.com/apk' } });
  });

  it('başlıksız istek geçer (min dolu)', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    expect((await get('/catalog')).statusCode).toBe(200);
    expect((await get('/me')).statusCode).toBe(401);
  });

  it('düşük sürüm 426, ileti isteğin dilinde, ayrıntı dolu', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    process.env.MOBILE_UPDATE_URL = 'https://example.com/apk';
    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const tr = await get('/me', { ...OLD, 'accept-language': 'tr' });
    expect(tr.statusCode).toBe(426);
    expect(tr.json().error).toMatchObject({ code: 'UPGRADE_REQUIRED', details: { minVersion: '1.1.0', updateUrl: 'https://example.com/apk' } });
    expect(tr.json().error.message).toMatch(/güncelleyin/);
    const en = await get('/me', { ...OLD, 'accept-language': 'en' });
    expect(en.json().error.message).toMatch(/update/i);
  });

  it('sürüm eşitse ya da üstündeyse geçer; 1.10.0 > 1.9.3', async () => {
    process.env.MIN_MOBILE_VERSION = '1.9.3';
    expect((await get('/me', { 'x-sod-client': 'mobile/1.9.3' })).statusCode).toBe(401);
    expect((await get('/me', { 'x-sod-client': 'mobile/1.10.0' })).statusCode).toBe(401);
    expect((await get('/me', { 'x-sod-client': 'mobile/1.9.2' })).statusCode).toBe(426);
  });

  it('muaf yollar eski sürümde de açılır', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    for (const url of ['/client-policy', '/health', '/catalog', '/.well-known/jwks.json']) {
      expect((await get(url, OLD)).statusCode, url).toBe(200);
    }
    expect((await get('/client-policy?x=1', OLD)).statusCode).toBe(200);
  });

  it('bozuk ya da yabancı başlık denetlenmez', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    for (const h of ['bozuk', 'mobile/', 'mobile/abc', 'web/0.0.1', 'mobile/1.0.0 (']) {
      expect((await get('/me', { 'x-sod-client': h })).statusCode, h).toBe(401);
    }
  });

  it('min yoksa eski sürüm de geçer', async () => {
    expect((await get('/me', OLD)).statusCode).toBe(401);
  });

  it('geliştirmede bozuk ayar (x.y.z değil) denetimi kapatır: 426 yok, politika null', async () => {
    process.env.NODE_ENV = 'development';
    for (const bad of ['1.1', '2', 'bozuk', '1.1.0.0']) {
      process.env.MIN_MOBILE_VERSION = bad;
      expect((await get('/me', OLD)).statusCode, bad).toBe(401);
      expect((await get('/client-policy')).json().mobile.minVersion, bad).toBeNull();
    }
  });

  it('web oturumu etkilenmez (başlıksız, min dolu)', async () => {
    const ctx = await registerOrg(app);
    process.env.MIN_MOBILE_VERSION = '9.0.0';
    const res = await login(app, ctx.email as string, undefined, 'web');
    expect(res.statusCode).toBe(200);
    expect(res.cookies.length).toBeGreaterThan(0);
  });

  it('426 çerezi silmez ve oturumu yenileme ucunda da yazmaz', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/refresh`,
      headers: { ...webHeaders('sod_rt=abc'), ...OLD },
      remoteAddress: randomIp(),
      payload: {},
    });
    expect(res.statusCode).toBe(426);
    expect(errorCode(res)).toBe('UPGRADE_REQUIRED');
    expect(res.headers['set-cookie']).toBeUndefined();
    const out = await app.inject({ method: 'POST', url: `${API}/auth/logout`, headers: { ...webHeaders('sod_rt=abc'), ...OLD }, remoteAddress: randomIp(), payload: {} });
    expect(out.statusCode).toBe(426);
    expect(out.headers['set-cookie']).toBeUndefined();
  });
});

describe('sürüm ayarı biçim denetimi', () => {
  it('üretimde bozuk değer fırlatır, geçerli ve boş geçer', () => {
    process.env.NODE_ENV = 'production';
    process.env.MIN_MOBILE_VERSION = '1.1';
    expect(() => assertMobileVersions()).toThrow(/MIN_MOBILE_VERSION/);
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    process.env.MOBILE_LATEST_VERSION = 'x';
    expect(() => assertMobileVersions()).toThrow(/MOBILE_LATEST_VERSION/);
    process.env.MOBILE_LATEST_VERSION = '1.2.0';
    expect(() => assertMobileVersions()).not.toThrow();
    delete process.env.MIN_MOBILE_VERSION;
    expect(() => assertMobileVersions()).not.toThrow();
  });

  it('geliştirmede yalnız uyarır', () => {
    process.env.NODE_ENV = 'development';
    process.env.MIN_MOBILE_VERSION = 'bozuk';
    expect(() => assertMobileVersions()).not.toThrow();
  });
});
