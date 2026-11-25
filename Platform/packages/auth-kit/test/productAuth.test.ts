import { AsyncLocalStorage } from 'node:async_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProductAuth, type MemberProjection, type ProductAuthOptions } from '../src/index.ts';
import { createTestAuthority, TEST_ORIGIN, type TestAuthority } from '../src/testing.ts';

let authority: TestAuthority;
let app: FastifyInstance;
let members: Map<string, MemberProjection>;
let provisioned: string[];
let synced: string[];

const store = new AsyncLocalStorage<{ companyId: string }>();

async function build(overrides: Partial<ProductAuthOptions> = {}) {
  app = Fastify();
  registerProductAuth(app, {
    product: 'deciship',
    ...authority.authOptions,
    allowedOrigins: [TEST_ORIGIN],
    loadMember: async (mid) => members.get(mid) ?? null,
    provisionMember: async ({ auth }) => {
      provisioned.push(auth.membershipId);
      const m = { epoch: auth.epoch, active: true };
      members.set(auth.membershipId, m);
      return m;
    },
    syncMember: async ({ auth }) => {
      synced.push(auth.membershipId);
      const m = { epoch: auth.epoch, active: true };
      members.set(auth.membershipId, m);
      return m;
    },
    runInContext: (auth, next) => store.run({ companyId: auth.orgId }, next),
    ...overrides,
  });
  app.get('/any', { preHandler: app.authenticate }, async (req) => ({ auth: req.auth, ctx: store.getStore() }));
  app.post('/write-auth', { preHandler: app.authenticate }, async () => ({ ok: true }));
  app.get('/invoices', { preHandler: app.requirePermission('deciship.invoices.view') }, async () => ({ ok: true }));
  app.post('/invoices', { preHandler: app.requirePermission('deciship.invoices.upload') }, async () => ({ ok: true }));
  app.post(
    '/search',
    { preHandler: app.requirePermission('deciship.invoices.view', { readOnlyExempt: true }) },
    async () => ({ ok: true }),
  );
  await app.ready();
}

beforeEach(async () => {
  authority = await createTestAuthority();
  members = new Map();
  provisioned = [];
  synced = [];
  await build();
});

afterEach(async () => {
  await app.close();
});

const code = (res: { json: () => unknown }) => (res.json() as { error: { code: string } }).error.code;

describe('jeton doğrulama', () => {
  it('geçerli Bearer jeton §5 bağlamını kurar', async () => {
    const token = await authority.accessToken({
      role: 'AUDITOR',
      orgId: 'org-a',
      membershipId: 'm-a',
      personId: 'p-a',
      orgRole: 'ADMIN',
      name: 'Ali',
      locale: 'en',
      epoch: 3,
      limits: { seats: 5 },
    });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    const { auth, ctx } = res.json();
    expect(auth).toMatchObject({
      personId: 'p-a',
      membershipId: 'm-a',
      orgId: 'org-a',
      orgRole: 'ADMIN',
      productRole: 'AUDITOR',
      subscription: { status: 'ACTIVE', plan: 'early_access', limits: { seats: 5 } },
      name: 'Ali',
      locale: 'en',
      epoch: 3,
    });
    expect(auth.permissions).toContain('deciship.lines.decide');
    expect(auth.permissions).not.toContain('deciship.settings.manage');
    // runInContext: işleyici AsyncLocalStorage bağlamı içinde çalışır (RLS için)
    expect(ctx).toEqual({ companyId: 'org-a' });
  });

  it('bağlam jetonun bitiş anını taşır (expiresAt = exp × 1000)', async () => {
    const before = Date.now();
    const token = await authority.accessToken({ role: 'AUDITOR', orgId: 'org-a', membershipId: 'm-a', expiresInSeconds: 90 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    const { auth } = res.json();
    const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).exp as number;
    expect(auth.expiresAt).toBe(exp * 1000);
    expect(auth.expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 89_000);
    expect(auth.expiresAt).toBeLessThanOrEqual(before + 91_000);
  });

  it('çerezle gelen jeton da geçerlidir', async () => {
    const token = await authority.accessToken({ membershipId: 'm-c' });
    const res = await app.inject({ url: '/any', headers: authority.cookie(token) });
    expect(res.statusCode).toBe(200);
  });

  it('jeton yoksa 401 UNAUTHORIZED, mesaj Accept-Language ile yerelleşir', async () => {
    const tr = await app.inject({ url: '/any', headers: { 'accept-language': 'tr-TR' } });
    expect(tr.statusCode).toBe(401);
    expect(code(tr)).toBe('UNAUTHORIZED');
    expect(tr.json().error.message).toMatch(/Oturum/);
    const en = await app.inject({ url: '/any', headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(en.json().error.message).toMatch(/session/);
    // Kullanıcı kararı 2026-11-12: başlık yoksa (oturum da yok) İngilizce; eskiden Türkçe.
    const none = await app.inject({ url: '/any' });
    expect(none.json().error.message).toMatch(/session/);
  });

  it('süresi dolmuş jeton 401 TOKEN_EXPIRED', async () => {
    const token = await authority.accessToken({ expiresInSeconds: -60 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('TOKEN_EXPIRED');
  });

  it('yanlış imza 401 UNAUTHORIZED', async () => {
    const token = await authority.accessToken({ foreignKey: true });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('UNAUTHORIZED');
  });

  it('yanlış aud ve iss reddedilir', async () => {
    for (const input of [{ audience: 'product-events' }, { audience: 'baska' }, { issuer: 'sahte' }]) {
      const token = await authority.accessToken(input);
      const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('UNAUTHORIZED');
    }
  });

  it('alg=none ve bozuk jeton reddedilir', async () => {
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${encode({ alg: 'none', kid: authority.kid() })}.${encode({ sub: 'x', org: 'o', mid: 'm', orgRole: 'OWNER', ep: 0, prod: { deciship: { role: 'ADMIN', status: 'ACTIVE', plan: 'x' } }, iss: 'sellerondata-account', aud: 'sellerondata', exp: 9999999999, iat: 1 })}.`;
    for (const bad of [none, 'bozuk', 'a.b.c']) {
      const res = await app.inject({ url: '/any', headers: authority.bearer(bad) });
      expect(res.statusCode).toBe(401);
    }
  });

  it('geçersiz Bearer geçerli çerezle telafi edilmez', async () => {
    const good = await authority.accessToken({ membershipId: 'm-c' });
    const res = await app.inject({
      url: '/any',
      headers: { authorization: 'Bearer bozuk', cookie: `sod_at=${good}` },
    });
    expect(res.statusCode).toBe(401);
    const notBearer = await app.inject({
      url: '/any',
      headers: { authorization: 'Basic abc', cookie: `sod_at=${good}` },
    });
    expect(notBearer.statusCode).toBe(401);
  });
});

describe('§5 denetim sırası', () => {
  it('org null: 403 ORG_REQUIRED', async () => {
    const token = await authority.accessToken({ orgId: null });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('ORG_REQUIRED');
  });

  it('prod içinde ürün yok: 403 NO_PRODUCT_ACCESS, JIT çalışmaz', async () => {
    const token = await authority.accessToken({ role: null, membershipId: 'm-x' });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('NO_PRODUCT_ACCESS');
    expect(provisioned).toEqual([]);
  });

  it('başka ürünün talebi bu ürüne erişim vermez', async () => {
    const token = await authority.accessToken({ product: 'orderloom', role: 'ADMIN' });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(code(res)).toBe('NO_PRODUCT_ACCESS');
  });

  it('izin yok: 403 FORBIDDEN', async () => {
    const token = await authority.accessToken({ role: 'MEASURE' });
    const res = await app.inject({ url: '/invoices', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('katalogda olmayan rol hiçbir izin vermez', async () => {
    const token = await authority.accessToken({ role: 'SUPERUSER' });
    const res = await app.inject({ url: '/invoices', headers: authority.bearer(token) });
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('izin var: geçer', async () => {
    const token = await authority.accessToken({ role: 'ACCOUNTING' });
    const res = await app.inject({ url: '/invoices', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
  });

  it('READ_ONLY: okuma geçer, yazma 403 READ_ONLY', async () => {
    for (const status of ['READ_ONLY', 'CANCELED'] as const) {
      const token = await authority.accessToken({ role: 'ADMIN', status, membershipId: `m-${status}` });
      const read = await app.inject({ url: '/invoices', headers: authority.bearer(token) });
      expect(read.statusCode).toBe(200);
      const write = await app.inject({ method: 'POST', url: '/invoices', headers: authority.bearer(token) });
      expect(write.statusCode).toBe(403);
      expect(code(write)).toBe('READ_ONLY');
      const plain = await app.inject({ method: 'POST', url: '/write-auth', headers: authority.bearer(token) });
      expect(code(plain)).toBe('READ_ONLY');
    }
  });

  it('READ_ONLY firmada izni olmayan yine FORBIDDEN alır (sıra: izin, sonra abonelik)', async () => {
    // Muhasebe artık fatura yükleyebilir (Y123); yükleme izni olmayan rol: Ölçüm.
    const token = await authority.accessToken({ role: 'MEASURE', status: 'READ_ONLY' });
    const res = await app.inject({ method: 'POST', url: '/invoices', headers: authority.bearer(token) });
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('readOnlyExempt: durum değiştirmeyen POST READ_ONLY firmada çalışır', async () => {
    const token = await authority.accessToken({ role: 'ACCOUNTING', status: 'READ_ONLY' });
    const res = await app.inject({ method: 'POST', url: '/search', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
  });
});

describe('özel roller: jetondaki izin listesi (perms)', () => {
  const me = async (input: Parameters<TestAuthority['accessToken']>[0]) =>
    (await app.inject({ url: '/any', headers: authority.bearer(await authority.accessToken(input)) })).json().auth as {
      permissions: string[];
      permissionsSource: string;
      productRole: string;
    };

  it('perms varsa izinler ondan: rol adına bakılmaz, katalog sırası, tekil', async () => {
    const auth = await me({
      role: 'custom:0193a1b2-0000-7000-8000-000000000001',
      perms: ['deciship.prices.view', 'deciship.invoices.view', 'deciship.invoices.view'],
    });
    expect(auth.permissions).toEqual(['deciship.invoices.view', 'deciship.prices.view']);
    expect(auth.permissionsSource).toBe('token');
    expect(auth.productRole).toBe('custom:0193a1b2-0000-7000-8000-000000000001');
  });

  it('düzenlenmiş hazır rol: rol adı MEASURE olsa da izinler perms ile daralır ya da genişler', async () => {
    const narrowed = await me({ role: 'ADMIN', perms: ['deciship.measurements.capture'] });
    expect(narrowed.permissions).toEqual(['deciship.measurements.capture']);
    const widened = await me({ role: 'MEASURE', perms: ['deciship.measurements.capture', 'deciship.invoices.view', 'deciship.prices.view'] });
    expect(widened.permissions).toEqual(['deciship.invoices.view', 'deciship.measurements.capture', 'deciship.prices.view']);
    const token = await authority.accessToken({ role: 'MEASURE', perms: ['deciship.invoices.view', 'deciship.prices.view'] });
    expect((await app.inject({ url: '/invoices', headers: authority.bearer(token) })).statusCode).toBe(200);
    const adminNarrow = await authority.accessToken({ role: 'ADMIN', perms: ['deciship.measurements.capture'] });
    expect(code(await app.inject({ url: '/invoices', headers: authority.bearer(adminNarrow) }))).toBe('FORBIDDEN');
  });

  it('bilinmeyen ve başka aracın izni düşer', async () => {
    const auth = await me({ role: 'custom:0193a1b2-0000-7000-8000-000000000002', perms: ['deciship.invoices.view', 'orderloom.orders.write', 'deciship.uydurma', 'settings.manage'] });
    expect(auth.permissions).toEqual(['deciship.invoices.view']);
  });

  it('boş perms hiçbir izin vermez (rolden türetilmez)', async () => {
    const auth = await me({ role: 'ADMIN', perms: [] });
    expect(auth.permissions).toEqual([]);
    expect(auth.permissionsSource).toBe('token');
  });

  it('perms yoksa (eski jeton) rolden türer; katalogda olmayan özel rol boş liste', async () => {
    const old = await me({ role: 'ACCOUNTING' });
    expect(old.permissionsSource).toBe('role');
    expect(old.permissions).toContain('deciship.invoices.view');
    expect((await me({ role: 'custom:0193a1b2-0000-7000-8000-000000000003' })).permissions).toEqual([]);
  });

  it('bozuk perms (null ya da dizi değil): boş liste, kaynak token, rolden türetilmez', async () => {
    for (const [i, bad] of [null, 'deciship.invoices.view', { a: 1 }, 5].entries()) {
      const token = await authority.accessToken({
        membershipId: `m-bozuk-${i}`,
        prod: { deciship: { role: 'ADMIN', perms: bad as unknown as string[], status: 'ACTIVE', plan: 'early_access' } },
      });
      const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(200);
      expect(res.json().auth.permissions, JSON.stringify(bad)).toEqual([]);
      expect(res.json().auth.permissionsSource, JSON.stringify(bad)).toBe('token');
    }
  });
});

describe('epoch ve JIT', () => {
  it('ep < Member.epoch: 401 TOKEN_STALE', async () => {
    members.set('m-1', { epoch: 5, active: true });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 4 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('TOKEN_STALE');
  });

  it('ep == Member.epoch: geçer, senkron çalışmaz', async () => {
    members.set('m-1', { epoch: 5, active: true });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 5 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(synced).toEqual([]);
  });

  it('ep > Member.epoch: yerel kayıt jetondan güncellenir (kayıp olay)', async () => {
    members.set('m-1', { epoch: 5, active: false });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 6 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(synced).toEqual(['m-1']);
    expect(members.get('m-1')).toEqual({ epoch: 6, active: true });
  });

  it('yerelde pasif ve epoch eşit: 403, istemci döngüye girmez', async () => {
    members.set('m-1', { epoch: 5, active: false });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 5 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('kapalı firma: kayıtlı üye de JIT ile gelen de 409 ORG_CLOSED; geri açılınca geçer', async () => {
    members.set('m-1', { epoch: 5, active: true, orgClosed: true });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 5 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('ORG_CLOSED');
    // jeton yeniyse de (eşitleme) geçmez
    const newer = await app.inject({ url: '/any', headers: authority.bearer(await authority.accessToken({ membershipId: 'm-1', epoch: 9 })) });
    expect(code(newer)).toBe('ORG_CLOSED');
    expect(synced).toEqual([]);
    members.set('m-1', { epoch: 5, active: true });
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);

    await app.close();
    await build({ provisionMember: async () => ({ epoch: 0, active: false, orgClosed: true }) });
    const jit = await app.inject({ url: '/any', headers: authority.bearer(await authority.accessToken({ membershipId: 'yeni' })) });
    expect(jit.statusCode).toBe(409);
    expect(code(jit)).toBe('ORG_CLOSED');
  });

  it('tanınmayan üye JIT ile açılır', async () => {
    const token = await authority.accessToken({ membershipId: 'yeni', epoch: 2 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(provisioned).toEqual(['yeni']);
  });

  it('JIT kancası yoksa tanınmayan üye reddedilir', async () => {
    await app.close();
    await build({ provisionMember: undefined });
    const token = await authority.accessToken({ membershipId: 'yeni' });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(code(res)).toBe('NO_PRODUCT_ACCESS');
  });

  it('kanca hatası uygulamanın hata işleyicisine gider', async () => {
    await app.close();
    await build({
      loadMember: async () => {
        throw new Error('veritabanı yok');
      },
    });
    const token = await authority.accessToken();
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(500);
  });
});

describe('CSRF ve Origin', () => {
  it('çerezli yazma: başlık ve Origin ikisi de doğruysa geçer', async () => {
    const token = await authority.accessToken();
    const res = await app.inject({ method: 'POST', url: '/write-auth', headers: authority.cookie(token, { write: true }) });
    expect(res.statusCode).toBe(200);
  });

  it('başlık eksik, Origin eksik, Origin yanlış ya da null: 403 CSRF_FAILED', async () => {
    const token = await authority.accessToken();
    const cookie = `sod_at=${token}`;
    const cases: Record<string, string>[] = [
      { cookie },
      { cookie, 'x-sod-csrf': '1' },
      { cookie, origin: TEST_ORIGIN },
      { cookie, 'x-sod-csrf': '1', origin: 'https://kotu.example' },
      { cookie, 'x-sod-csrf': '1', origin: 'null' },
      { cookie, 'x-sod-csrf': '0', origin: TEST_ORIGIN },
    ];
    for (const headers of cases) {
      const res = await app.inject({ method: 'POST', url: '/write-auth', headers });
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('CSRF_FAILED');
    }
  });

  it('Bearer yazma CSRF istemez', async () => {
    const token = await authority.accessToken();
    const res = await app.inject({ method: 'POST', url: '/write-auth', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
  });

  it('çerezli okuma CSRF istemez', async () => {
    const token = await authority.accessToken();
    const res = await app.inject({ url: '/any', headers: authority.cookie(token) });
    expect(res.statusCode).toBe(200);
  });
});

describe('JWKS önbelleği', () => {
  it('her istekte getirmez', async () => {
    const token = await authority.accessToken();
    for (let i = 0; i < 5; i++) await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(authority.fetchCount()).toBe(1);
  });

  it('Hesap kesikken bilinen anahtarla çalışmaya devam eder', async () => {
    const token = await authority.accessToken();
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    authority.setOffline(true);
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
  });

  it('kid değişince yeniden getirir, eski anahtarlı jeton da geçerli kalır', async () => {
    await app.close();
    const { createJwksClient } = await import('../src/jwks.ts');
    const jwks = createJwksClient({ ...authority.authOptions, url: authority.jwksUrl, cooldownMs: 0 });
    await build({ jwks });
    const oldToken = await authority.accessToken({ membershipId: 'm-1' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(oldToken) })).statusCode).toBe(200);

    await authority.rotateKey();
    const newToken = await authority.accessToken({ membershipId: 'm-1' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(newToken) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/any', headers: authority.bearer(oldToken) })).statusCode).toBe(200);
    expect(authority.fetchCount()).toBe(2);
  });

  it('JWKS listesinden çıkan anahtar tazelemeden sonra reddedilir', async () => {
    await app.close();
    const { createJwksClient } = await import('../src/jwks.ts');
    const jwks = createJwksClient({ url: authority.jwksUrl, fetch: authority.fetch, cooldownMs: 0 });
    await build({ jwks });
    const oldToken = await authority.accessToken({ membershipId: 'm-1' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(oldToken) })).statusCode).toBe(200);
    await authority.rotateKey({ dropPrevious: true });
    await jwks.refresh();
    const res = await app.inject({ url: '/any', headers: authority.bearer(oldToken) });
    expect(res.statusCode).toBe(401);
  });

  it('bilinmeyen kid + Hesap kesik: 503 AUTH_UNAVAILABLE (oturum kapanmaz)', async () => {
    authority.setOffline(true);
    const token = await authority.accessToken();
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(503);
    expect(code(res)).toBe('AUTH_UNAVAILABLE');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('bilinmeyen kid + taze liste: 401', async () => {
    const token = await authority.accessToken({ kid: 'uydurma' });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
  });

  it('sahte kid yağmuru Hesap\'ı yormaz (bekleme süresi)', async () => {
    for (let i = 0; i < 10; i++) {
      const token = await authority.accessToken({ kid: `uydurma-${i}` });
      await app.inject({ url: '/any', headers: authority.bearer(token) });
    }
    expect(authority.fetchCount()).toBe(1);
  });

  it('süresi geçen önbellek arkada tazelenir, başarısızlık doğrulamayı düşürmez', async () => {
    await app.close();
    const { createJwksClient } = await import('../src/jwks.ts');
    const errors: unknown[] = [];
    const jwks = createJwksClient({
      url: authority.jwksUrl,
      fetch: authority.fetch,
      refreshAfterMs: 0,
      cooldownMs: 0,
      onRefreshError: (e) => errors.push(e),
    });
    await build({ jwks });
    const token = await authority.accessToken({ membershipId: 'm-1' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    authority.setOffline(true);
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThan(0);
    expect(jwks.knownKids()).toEqual([authority.kid()]);
  });

  it('boş veya bozuk JWKS önbelleği silmez', async () => {
    await app.close();
    const { createJwksClient } = await import('../src/jwks.ts');
    let mode: 'real' | 'empty' | 'html' = 'real';
    const jwks = createJwksClient({
      url: authority.jwksUrl,
      cooldownMs: 0,
      fetch: (async (input: string) => {
        if (mode === 'empty') return new Response('{"keys":[]}', { status: 200 });
        if (mode === 'html') return new Response('<html>', { status: 200 });
        return authority.fetch(input);
      }) as typeof fetch,
    });
    await build({ jwks });
    const token = await authority.accessToken({ membershipId: 'm-1' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    mode = 'empty';
    await expect(jwks.refresh()).rejects.toThrow();
    mode = 'html';
    await expect(jwks.refresh()).rejects.toThrow();
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
  });
});
