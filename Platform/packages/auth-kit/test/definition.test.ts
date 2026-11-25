import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, PlatformEvent } from '@sellerondata/contracts';
import { registerEventReceiver, registerProductAuth, resolveProductDefinition, type ProductDefinitionSeam } from '../src/index.ts';
import { createTestAuthority, TEST_ORIGIN, type TestAuthority } from '../src/testing.ts';

/** `definition` dikişi (Mesaj 11 P): kayıtta olmayan araç yalnız açıkça verilen tanımla ve yalnız test koşusunda (NODE_ENV=test). */

const FIXTURE: ProductDefinitionSeam = {
  key: 'denemearac',
  roles: [
    { key: 'ADMIN', label: { tr: 'Y', en: 'A' }, description: { tr: 'Y', en: 'A' }, permissions: ['denemearac.items.write', 'denemearac.items.view'] },
    { key: 'VIEWER', label: { tr: 'G', en: 'V' }, description: { tr: 'G', en: 'V' }, permissions: ['denemearac.items.view'] },
  ],
};

let authority: TestAuthority;
const savedEnv = process.env.NODE_ENV;

beforeAll(async () => {
  authority = await createTestAuthority();
});

/** `undefined` atamak metin 'undefined' yazar: boş ortam için değişken silinir. */
function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
}

afterEach(() => {
  setEnv(savedEnv);
});

const noop = {
  loadMember: async () => ({ epoch: 0, active: true }),
};
const receiverBase = {
  transaction: async <R>(work: (tx: null) => Promise<R>) => work(null),
  claimEvent: async () => true,
  memberEpoch: async () => null,
  onEvent: async () => {},
};

describe('resolveProductDefinition', () => {
  it('tanımsız: kayıttaki girdi döner', () => {
    expect(resolveProductDefinition('deciship', undefined, 't').key).toBe('deciship');
  });

  it('kayıtta olmayan anahtar tanımsız verilirse açılış durur', () => {
    expect(() => resolveProductDefinition('denemearac', undefined, 't')).toThrow(/kaydında yok/);
    expect(() => registerProductAuth(Fastify(), { product: 'denemearac', ...authority.authOptions, allowedOrigins: [], ...noop })).toThrow(/kaydında yok/);
    expect(() => registerEventReceiver(Fastify(), { product: 'denemearac', ...authority.authOptions, ...receiverBase })).toThrow(/kaydında yok/);
  });

  it('anahtarı tutmayan tanım reddedilir', () => {
    expect(() => resolveProductDefinition('deciship', FIXTURE, 't')).toThrow(/aynı değil/);
  });

  it('test koşusu dışında tanım kabul edilmez (izin listesi: yalnız NODE_ENV=test)', () => {
    for (const env of [undefined, '', 'development', 'staging', 'production', 'TEST', 'test ']) {
      setEnv(env);
      expect(() => resolveProductDefinition('denemearac', FIXTURE, 't'), String(env)).toThrow(/NODE_ENV=test/);
      // Kayıttaki anahtarla bile: tanım kayıttaki izinleri ezemez.
      expect(() => resolveProductDefinition('deciship', { key: 'deciship', roles: [] }, 't'), String(env)).toThrow(/NODE_ENV=test/);
      expect(() =>
        registerProductAuth(Fastify(), { product: 'denemearac', definition: FIXTURE, ...authority.authOptions, allowedOrigins: [], ...noop }),
      ).toThrow(/NODE_ENV=test/);
      expect(() => registerEventReceiver(Fastify(), { product: 'denemearac', definition: FIXTURE, ...authority.authOptions, ...receiverBase })).toThrow(
        /NODE_ENV=test/,
      );
      // Kayıttaki araç tanımsız olarak çalışmaya devam eder.
      expect(resolveProductDefinition('deciship', undefined, 't').key).toBe('deciship');
    }
  });

  it('NODE_ENV=test iken tanım kabul edilir', () => {
    setEnv('test');
    expect(resolveProductDefinition('denemearac', FIXTURE, 't')).toBe(FIXTURE);
  });
});

describe('fikstür araçla kimlik', () => {
  async function build() {
    const app = Fastify();
    registerProductAuth(app, { product: 'denemearac', definition: FIXTURE, ...authority.authOptions, allowedOrigins: [TEST_ORIGIN], ...noop });
    app.get('/me', { onRequest: app.authenticate }, async (req) => ({ permissions: req.auth.permissions, role: req.auth.productRole }));
    app.post('/items', { onRequest: app.requirePermission('denemearac.items.write' as Permission) }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('izinler tanımdaki rolden türer', async () => {
    const app = await build();
    const token = await authority.accessToken({ product: 'denemearac', role: 'VIEWER' });
    const res = await app.inject({ url: '/me', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ permissions: ['denemearac.items.view'], role: 'VIEWER' });
    const write = await app.inject({ method: 'POST', url: '/items', headers: authority.bearer(token) });
    expect(write.statusCode).toBe(403);
    const admin = await authority.accessToken({ product: 'denemearac', role: 'ADMIN' });
    expect((await app.inject({ method: 'POST', url: '/items', headers: authority.bearer(admin) })).statusCode).toBe(200);
    await app.close();
  });

  it('jetonda yalnız başka ürün varsa 403 NO_PRODUCT_ACCESS; tanımda olmayan rol izin vermez', async () => {
    const app = await build();
    const other = await authority.accessToken({ product: 'deciship', role: 'ADMIN' });
    const res = await app.inject({ url: '/me', headers: authority.bearer(other) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NO_PRODUCT_ACCESS');
    const unknownRole = await authority.accessToken({ product: 'denemearac', role: 'AUDITOR' });
    expect((await app.inject({ url: '/me', headers: authority.bearer(unknownRole) })).json()).toEqual({ permissions: [], role: 'AUDITOR' });
    await app.close();
  });

  it('olay alıcısı yalnız kendi ürününün olayını kabul eder', async () => {
    const app = Fastify();
    const seen: string[] = [];
    registerEventReceiver(app, {
      product: 'denemearac',
      definition: FIXTURE,
      ...authority.authOptions,
      ...receiverBase,
      onEvent: async (_tx, e) => {
        seen.push(e.eventId);
      },
    });
    await app.ready();
    const event = (product: string) =>
      ({ eventId: randomUUID(), type: 'org.updated', orgId: 'org-a', product, name: 'Firma', version: 1 }) as PlatformEvent;
    const own = event('denemearac');
    const ok = await app.inject({ method: 'POST', url: '/api/denemearac/internal/events', payload: { token: await authority.eventToken(own) } });
    expect(ok.json()).toEqual({ ok: true, outcome: 'processed' });
    const foreign = await app.inject({ method: 'POST', url: '/api/denemearac/internal/events', payload: { token: await authority.eventToken(event('deciship')) } });
    expect(foreign.statusCode).toBe(400);
    expect(seen).toEqual([own.eventId]);
    await app.close();
  });
});
