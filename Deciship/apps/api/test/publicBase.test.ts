import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { missingProductionEnv } from '../src/env.ts';
import { fileUrl, publicBase } from '../src/lib/storage.ts';

/**
 * Dosya bağlantısının kökü (KALANLAR 3.2). Üretimde `APP_BASE_URL`'den: Host ve X-Forwarded-* başlıklarına bakılmaz, telefon
 * bağlantıyı https ile ve uygulamanın adıyla alır. Geliştirmede istekten (telefon bilgisayarın ağ adresiyle bağlanır).
 */
const req = (headers: Record<string, string>, protocol = 'http') =>
  ({ headers, protocol, auth: { membershipId: 'uye', epoch: 1 } }) as unknown as FastifyRequest;

const saved = { node: process.env.NODE_ENV, base: process.env.APP_BASE_URL };
afterEach(() => {
  for (const [k, v] of [['NODE_ENV', saved.node], ['APP_BASE_URL', saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const spoofed = { host: 'gateway', 'x-forwarded-host': 'kotu.example', 'x-forwarded-proto': 'http', authorization: 'Bearer x' };

describe('publicBase', () => {
  it('üretimde APP_BASE_URL: istemcinin ya da vekilin başlığı adresi değiştiremez', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://app.example.test/';
    expect(publicBase(req(spoofed))).toBe('https://app.example.test');
    const url = new URL(fileUrl(req(spoofed), 'dosya', 'firma'));
    expect(url.origin).toBe('https://app.example.test');
    expect(url.pathname).toBe('/api/deciship/files/dosya');
    expect(url.searchParams.get('t')).toBeTruthy();
  });

  it('geliştirmede istekten: gateway başlığı, yoksa Host', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_BASE_URL = 'https://app.example.test';
    expect(publicBase(req({ host: 'gateway', 'x-forwarded-host': '192.168.1.5:8088', 'x-forwarded-proto': 'http' }))).toBe('http://192.168.1.5:8088');
    expect(publicBase(req({ host: 'localhost:4000' }))).toBe('http://localhost:4000');
  });
});

describe('üretimde APP_BASE_URL zorunlu ve yalın https kökeni', () => {
  const full = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x' };
  const MSG = 'APP_BASE_URL (must be a bare https:// origin, e.g. https://app.sellerondata.com)';

  it('eksik, http, yol ya da kullanıcı adı taşıyan adres açılışı durdurur', () => {
    expect(missingProductionEnv(full)).toEqual(['APP_BASE_URL']);
    expect(missingProductionEnv({ ...full, APP_BASE_URL: ' ' })).toEqual(['APP_BASE_URL']);
    for (const bad of ['http://app.example.test', 'app.example.test', 'https://app.example.test/deciship', 'https://a:b@app.example.test', 'https://app.example.test/?x=1', 'ftp://app.example.test']) {
      expect(missingProductionEnv({ ...full, APP_BASE_URL: bad }), bad).toEqual([MSG]);
    }
  });

  it('https kökeni geçer; yerel üretim sınaması için localhost http serbest', () => {
    for (const ok of ['https://app.example.test', 'https://app.example.test/', 'https://app.example.test:8443', 'http://localhost:8088', 'http://127.0.0.1:8088']) {
      expect(missingProductionEnv({ ...full, APP_BASE_URL: ok }), ok).toEqual([]);
    }
    expect(missingProductionEnv({ NODE_ENV: 'development' })).toEqual([]);
  });
});
