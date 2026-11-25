import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getApp, registerCompany } from './helpers.ts';
import { missingProductionEnv } from '../src/env.ts';

const OLD = { 'x-sod-client': 'mobile/1.0.0+1 (android)' };
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MIN_MOBILE_VERSION;
  delete process.env.MIN_MOBILE_VERSION;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MIN_MOBILE_VERSION;
  else process.env.MIN_MOBILE_VERSION = saved;
});

describe('mobil en düşük sürüm (426)', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app)).auth;
  });
  const me = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/deciship/me', headers: { ...auth, ...headers } });

  it('min yoksa eski sürüm de geçer', async () => {
    expect((await me(OLD)).statusCode).toBe(200);
  });

  it('başlıksız istek geçer (web, curl, eski uygulama)', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    expect((await me({})).statusCode).toBe(200);
  });

  it('düşük sürüm 426, ileti isteğin dilinde, updateUrl null', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    const tr = await me({ ...OLD, 'accept-language': 'tr' });
    expect(tr.statusCode).toBe(426);
    expect(tr.json().error).toMatchObject({ code: 'UPGRADE_REQUIRED', details: { minVersion: '1.1.0', updateUrl: null } });
    expect(tr.json().error.message).toMatch(/güncelleyin/);
    const en = await me({ ...OLD, 'accept-language': 'en' });
    expect(en.json().error.message).toMatch(/update/i);
    // Denetim kimlikten önce çalışır: başlık yoksa oturumun dili de bilinmez, İngilizce (KARARLAR, ilk açılış dili 2026-11-12)
    expect((await me(OLD)).json().error.message).toMatch(/update/i);
  });

  it('kimliksiz istekte de 426 (kimlikten önce çalışır); yeterli sürüm geçer; 1.10.0 > 1.9.3', async () => {
    process.env.MIN_MOBILE_VERSION = '1.9.3';
    const anon = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: { 'x-sod-client': 'mobile/1.9.2' } });
    expect(anon.statusCode).toBe(426);
    expect((await me({ 'x-sod-client': 'mobile/1.10.0' })).statusCode).toBe(200);
    expect((await me({ 'x-sod-client': 'mobile/1.9.3' })).statusCode).toBe(200);
  });

  it('sağlık ucu muaf', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    expect((await app.inject({ method: 'GET', url: '/api/deciship/health', headers: OLD })).statusCode).toBe(200);
  });

  it('bozuk ya da yabancı başlık denetlenmez; bozuk ayar denetimi kapatır', async () => {
    process.env.MIN_MOBILE_VERSION = '1.1.0';
    for (const h of ['bozuk', 'mobile/', 'mobile/abc', 'web/0.0.1']) {
      expect((await me({ 'x-sod-client': h })).statusCode, h).toBe(200);
    }
    process.env.MIN_MOBILE_VERSION = 'x.y';
    expect((await me(OLD)).statusCode).toBe(200);
  });
});

describe('MIN_MOBILE_VERSION biçimi (hesap servisiyle aynı kural)', () => {
  const full = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x', APP_BASE_URL: 'https://app.example.test' };

  it('üretimde bozuk değer açılışı durdurur; geçerli ve boş geçer', () => {
    for (const bad of ['1.1', 'bozuk', '1.1.0.0']) {
      expect(missingProductionEnv({ ...full, MIN_MOBILE_VERSION: bad }), bad).toEqual(['MIN_MOBILE_VERSION (x.y.z olmalı)']);
    }
    expect(missingProductionEnv({ ...full, MIN_MOBILE_VERSION: '1.1.0' })).toEqual([]);
    expect(missingProductionEnv({ ...full, MIN_MOBILE_VERSION: ' ' })).toEqual([]);
  });

  it('geliştirmede bozuk değer açılışı durdurmaz', () => {
    expect(missingProductionEnv({ NODE_ENV: 'development', MIN_MOBILE_VERSION: '1.1' })).toEqual([]);
  });
});
