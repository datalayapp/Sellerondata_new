import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsOf, PRODUCTS, type PlatformEvent } from '@sellerondata/contracts';
import { createJwksClient, registerEventReceiver, registerProductAuth, type MemberProjection, type ProductAuthOptions } from '../src/index.ts';
import { createTestAuthority, TEST_ORIGIN, type TestAuthority } from '../src/testing.ts';

let authority: TestAuthority;
let app: FastifyInstance;
let members: Map<string, MemberProjection>;

async function build(overrides: Partial<ProductAuthOptions> = {}) {
  app = Fastify();
  registerProductAuth(app, {
    product: 'deciship',
    ...authority.authOptions,
    allowedOrigins: [TEST_ORIGIN],
    loadMember: async (mid) => members.get(mid) ?? { epoch: 0, active: true },
    ...overrides,
  });
  app.get('/any', { preHandler: app.authenticate }, async () => ({ ok: true }));
  app.post(
    '/schema',
    {
      onRequest: app.authenticate,
      schema: { body: { type: 'object', required: ['gizliAlan'], properties: { gizliAlan: { type: 'string' } } } },
    },
    async () => ({ ok: true }),
  );
  app.post('/search', { config: { readOnlyExempt: true }, preHandler: [app.authenticate, app.requirePermission('deciship.invoices.view')] }, async () => ({ ok: true }));
  await app.ready();
}

beforeEach(async () => {
  authority = await createTestAuthority();
  members = new Map();
  await build();
});
afterEach(async () => {
  await app.close();
});

const code = (res: { json: () => unknown }) => (res.json() as { error: { code: string } }).error.code;

describe('O1: yinelenen oturum çerezi', () => {
  it('aynı adlı iki sod_at gelirse 401: hangisinin geçerli olduğu seçilmez', async () => {
    const attacker = await authority.accessToken({ orgId: 'saldirgan', membershipId: 'm-s' });
    const victim = await authority.accessToken({ orgId: 'kurban', membershipId: 'm-k' });
    const res = await app.inject({ url: '/any', headers: { cookie: `sod_at=${attacker}; sod_at=${victim}` } });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('UNAUTHORIZED');
  });

  it('tek sod_at ve başka çerezler sorun değil', async () => {
    const token = await authority.accessToken();
    const res = await app.inject({ url: '/any', headers: { cookie: `sod_lang=tr; sod_at=${token}; sod_rt=x` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('O4: pasif kayıt kapısı', () => {
  it('jeton yeni, syncMember yok: pasif üye geçemez', async () => {
    members.set('m-1', { epoch: 5, active: false });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 6 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('jeton yeni, syncMember void döner: pasif üye geçemez', async () => {
    await app.close();
    await build({ syncMember: async () => undefined });
    members.set('m-1', { epoch: 5, active: false });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 6 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
  });

  it('sync daha yeni epoch döndürürse (araya olay girdi) jeton bayattır', async () => {
    await app.close();
    await build({ syncMember: async () => ({ epoch: 7, active: false }) });
    members.set('m-1', { epoch: 5, active: true });
    const token = await authority.accessToken({ membershipId: 'm-1', epoch: 6 });
    const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('TOKEN_STALE');
  });
});

describe('O5: onRequest', () => {
  it('kimliksiz istek gövde şeması hatası almaz, alan adı sızmaz', async () => {
    const res = await app.inject({ method: 'POST', url: '/schema', payload: { baska: 1 } });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('gizliAlan');
  });
});

describe('B2: üye kancalarına firma bağlamı', () => {
  it('withOrgContext loadMember, provisionMember ve syncMember etrafında çalışır', async () => {
    await app.close();
    const seen: string[] = [];
    let current: string | null = null;
    const stored = new Map<string, MemberProjection>();
    await build({
      withOrgContext: async (orgId, work) => {
        seen.push(orgId);
        current = orgId;
        try {
          return await work();
        } finally {
          current = null;
        }
      },
      loadMember: async (mid) => {
        expect(current).toBe('org-a');
        return stored.get(mid) ?? null;
      },
      provisionMember: async ({ auth }) => {
        expect(current).toBe('org-a');
        const m = { epoch: auth.epoch, active: true };
        stored.set(auth.membershipId, m);
        return m;
      },
      syncMember: async ({ auth }) => {
        expect(current).toBe('org-a');
        const m = { epoch: auth.epoch, active: true };
        stored.set(auth.membershipId, m);
        return m;
      },
    });
    const first = await authority.accessToken({ orgId: 'org-a', membershipId: 'm-1', epoch: 1 });
    expect((await app.inject({ url: '/any', headers: authority.bearer(first) })).statusCode).toBe(200);
    const second = await authority.accessToken({ orgId: 'org-a', membershipId: 'm-1', epoch: 2 });
    expect((await app.inject({ url: '/any', headers: authority.bearer(second) })).statusCode).toBe(200);
    expect(stored.get('m-1')?.epoch).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });
});

describe('runInContext hatası', () => {
  it('fırlatırsa istek asılı kalmaz, 500 döner, unhandledRejection üretmez', async () => {
    await app.close();
    await build({
      runInContext: () => {
        throw new Error('bağlam kurulamadı');
      },
    });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const token = await authority.accessToken();
      const res = await Promise.race([
        app.inject({ url: '/any', headers: authority.bearer(token) }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('asılı kaldı')), 1500)),
      ]);
      expect(res.statusCode).toBe(500);
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('izin dizileri', () => {
  it('katalog izinleri değiştirilemez: istek içi kod rolü yükseltemez', async () => {
    expect(Object.isFrozen(permissionsOf('deciship', 'MEASURE'))).toBe(true);
    expect(Object.isFrozen(permissionsOf('deciship', 'YOK'))).toBe(true);
    for (const role of PRODUCTS.deciship.roles) expect(Object.isFrozen(role.permissions)).toBe(true);
    expect(() => (permissionsOf('deciship', 'MEASURE') as string[]).push('deciship.settings.manage')).toThrow();
  });
});

describe('readOnlyExempt', () => {
  it('rota ayarı authenticate zincirinde de geçerli', async () => {
    const token = await authority.accessToken({ role: 'ACCOUNTING', status: 'READ_ONLY' });
    const res = await app.inject({ method: 'POST', url: '/search', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(200);
  });
});

describe('önbellek başlığı', () => {
  it('kimlikli GET yanıtı no-store; hata yanıtı da', async () => {
    const token = await authority.accessToken();
    const ok = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(ok.headers['cache-control']).toBe('no-store');
    const denied = await app.inject({ url: '/any' });
    expect(denied.headers['cache-control']).toBe('no-store');
  });
});

describe('JWKS sertleştirme', () => {
  function rawToken(header: Record<string, unknown>) {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc(header)}.${enc({ sub: 'x' })}.${Buffer.alloc(64).toString('base64url')}`;
  }

  it('nesne kid 500 değil 401', async () => {
    const res = await app.inject({ url: '/any', headers: authority.bearer(rawToken({ alg: 'EdDSA', kid: { toString: 1, valueOf: 1 } })) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('UNAUTHORIZED');
  });

  it('yönlendirme izlenmez', async () => {
    let redirect: RequestRedirect | undefined;
    const jwks = createJwksClient({
      url: authority.jwksUrl,
      fetch: (async (input: string, init: RequestInit) => {
        redirect = init.redirect;
        return authority.fetch(input);
      }) as typeof fetch,
    });
    await jwks.refresh();
    expect(redirect).toBe('error');
  });

  it('listedeki tek bozuk anahtar tazelemeyi düşürmez', async () => {
    const { publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const good = { ...(await exportJWK(publicKey)), kid: 'iyi', use: 'sig' };
    const bad = { kty: 'OKP', crv: 'Ed25519', x: '!!!bozuk!!!', kid: 'bozuk', use: 'sig' };
    const jwks = createJwksClient({
      url: 'http://x/jwks',
      fetch: (async () => new Response(JSON.stringify({ keys: [bad, good] }))) as unknown as typeof fetch,
    });
    await jwks.refresh();
    expect(jwks.knownKids()).toEqual(['iyi']);
  });

  it('önbelleğin azami yaşı var: Hesap kesikken süresiz geçerli olmaz, dönünce iyileşir', async () => {
    const jwks = createJwksClient({
      url: authority.jwksUrl,
      fetch: authority.fetch,
      maxStaleMs: 20,
      cooldownMs: 0,
      failureBackoffMs: 0,
    });
    await app.close();
    await build({ jwks });
    const token = await authority.accessToken();
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    authority.setOffline(true);
    await new Promise((r) => setTimeout(r, 30));
    const stale = await app.inject({ url: '/any', headers: authority.bearer(token) });
    expect(stale.statusCode).toBe(503);
    expect(code(stale)).toBe('AUTH_UNAVAILABLE');
    authority.setOffline(false);
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
  });

  it('varsayılan azami yaş içinde Hesap kesikken bilinen anahtar çalışır', async () => {
    const token = await authority.accessToken();
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
    authority.setOffline(true);
    expect((await app.inject({ url: '/any', headers: authority.bearer(token) })).statusCode).toBe(200);
  });

  it('sahte kid yeni döndürülen anahtara 503 yedirmez: kısa aralıkta 401, sonra geçer', async () => {
    const jwks = createJwksClient({ url: authority.jwksUrl, fetch: authority.fetch, cooldownMs: 40 });
    await app.close();
    await build({ jwks });
    const fake = await authority.accessToken({ kid: 'uydurma' });
    expect((await app.inject({ url: '/any', headers: authority.bearer(fake) })).statusCode).toBe(401);

    await authority.rotateKey();
    const real = await authority.accessToken();
    const within = await app.inject({ url: '/any', headers: authority.bearer(real) });
    expect(within.statusCode).toBe(401); // 503 alarmı değil; istemci yeniler
    await new Promise((r) => setTimeout(r, 50));
    expect((await app.inject({ url: '/any', headers: authority.bearer(real) })).statusCode).toBe(200);
  });

  it('Hesap kesikken bilinmeyen kid kısa geri çekilmeyle 503, Hesap\'ı yormaz', async () => {
    const jwks = createJwksClient({ url: authority.jwksUrl, fetch: authority.fetch, failureBackoffMs: 60_000 });
    await app.close();
    await build({ jwks });
    authority.setOffline(true);
    const token = await authority.accessToken();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ url: '/any', headers: authority.bearer(token) });
      expect(res.statusCode).toBe(503);
    }
    expect(authority.fetchCount()).toBe(1);
  });
});

describe('olay alıcısı sertleştirme', () => {
  let receiver: FastifyInstance;
  let applied: PlatformEvent[];
  let order: string[];

  async function buildReceiver(extra: Record<string, unknown> = {}) {
    receiver = Fastify();
    applied = [];
    order = [];
    registerEventReceiver<null>(receiver, {
      product: 'deciship',
      ...authority.authOptions,
      transaction: (work) => work(null),
      claimEvent: async () => {
        order.push('claim');
        return true;
      },
      memberEpoch: async () => {
        order.push('epoch');
        return 5;
      },
      onEvent: async (_tx, e) => {
        order.push('apply');
        applied.push(e);
      },
      ...extra,
    });
    await receiver.ready();
  }
  afterEach(async () => {
    await receiver?.close();
  });

  const send = (token: string) => receiver.inject({ method: 'POST', url: '/api/deciship/internal/events', payload: { token } });
  const base = { eventId: 'e', orgId: 'org-a', product: 'deciship', personId: 'p', name: 'A', orgRole: 'MEMBER', role: 'ADMIN', active: true };

  it('epoch veya membershipId eksik imzalı üye olayı 400', async () => {
    await buildReceiver();
    const cases = [
      { ...base, eventId: randomUUID(), type: 'member.upserted', membershipId: 'm' },
      { ...base, eventId: randomUUID(), type: 'member.upserted', epoch: 9 },
      { ...base, eventId: randomUUID(), type: 'member.upserted', membershipId: 'm', epoch: '9' },
      { ...base, eventId: randomUUID(), type: 'member.removed', membershipId: 'm', epoch: 1.5 },
      { ...base, eventId: randomUUID(), type: 'member.removed', epoch: 9 },
      { eventId: randomUUID(), type: 'org.updated', product: 'deciship', name: 'x' },
      { eventId: randomUUID(), type: 'org.updated', orgId: 'o', product: 'deciship' },
      { eventId: randomUUID(), type: 'subscription.updated', orgId: 'o', product: 'deciship', status: 'ACTIVE' },
    ];
    for (const event of cases) {
      const res = await send(await authority.eventToken(event as unknown as PlatformEvent));
      expect(res.statusCode, JSON.stringify(event)).toBe(400);
      expect(code(res)).toBe('INVALID_EVENT');
    }
    expect(applied).toEqual([]);
  });

  it('bağlam kancası her adımdan önce, event.orgId ile çalışır', async () => {
    const contexts: string[] = [];
    await buildReceiver({
      eventContext: async (_tx: null, event: PlatformEvent) => {
        order.push('context');
        contexts.push(event.orgId);
      },
    });
    const event = { ...base, eventId: randomUUID(), type: 'member.upserted', membershipId: 'm', epoch: 9 } as unknown as PlatformEvent;
    expect((await send(await authority.eventToken(event))).statusCode).toBe(200);
    expect(contexts).toEqual(['org-a']);
    expect(order).toEqual(['context', 'claim', 'epoch', 'apply']);
  });

  it('sürümlü olay: eski sürüm uygulanmaz, eşit ve yeni uygulanır', async () => {
    let current: number | null = 5;
    await buildReceiver({ currentVersion: async () => current });
    const org = (version: number) =>
      ({ eventId: randomUUID(), type: 'org.updated', orgId: 'o', product: 'deciship', name: `v${version}`, version }) as PlatformEvent;
    expect((await send(await authority.eventToken(org(4)))).json().outcome).toBe('stale');
    expect((await send(await authority.eventToken(org(5)))).json().outcome).toBe('processed');
    expect((await send(await authority.eventToken(org(6)))).json().outcome).toBe('processed');
    current = null;
    expect((await send(await authority.eventToken(org(1)))).json().outcome).toBe('processed');
    const sub = { eventId: randomUUID(), type: 'subscription.updated', orgId: 'o', product: 'deciship', status: 'CANCELED', plan: 'x', version: 2 } as PlatformEvent;
    current = 3;
    expect((await send(await authority.eventToken(sub))).json().outcome).toBe('stale');
  });

  it('büyük gövde 413', async () => {
    await buildReceiver();
    const res = await send('x'.repeat(40_000));
    expect(res.statusCode).toBe(413);
  });

  it('%69nternal yolu da imza ister', async () => {
    await buildReceiver();
    const res = await receiver.inject({
      method: 'POST',
      url: '/api/deciship/%69nternal/events',
      payload: { token: await authority.accessToken() },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('auth-kit/testing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('üretimde içe aktarılırsa fırlatır', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    await expect(import('../src/testing.ts')).rejects.toThrow(/üretim/i);
  });
});

// Yanlışlıkla kullanılmayan içe aktarım kalmasın.
void SignJWT;

describe('O13: X-SOD-Org', () => {
  it('çerezli yazmada başlık yok veya uyuşmuyorsa 409, uyuşuyorsa geçer; Bearer ve okuma muaf', async () => {
    await app.close();
    await build();
    app = Fastify();
    registerProductAuth(app, { product: 'deciship', ...authority.authOptions, allowedOrigins: [TEST_ORIGIN], loadMember: async () => ({ epoch: 0, active: true }) });
    app.get('/r', { onRequest: app.authenticate }, async () => ({ ok: true }));
    app.post('/w', { onRequest: app.authenticate }, async () => ({ ok: true }));
    await app.ready();
    const token = await authority.accessToken({ orgId: 'org-b' });
    const base = { cookie: `sod_at=${token}`, 'x-sod-csrf': '1', origin: TEST_ORIGIN };

    const none = await app.inject({ method: 'POST', url: '/w', headers: base });
    expect(none.statusCode).toBe(409);
    expect(code(none)).toBe('ORG_MISMATCH');
    const wrong = await app.inject({ method: 'POST', url: '/w', headers: { ...base, 'x-sod-org': 'org-a' } });
    expect(code(wrong)).toBe('ORG_MISMATCH');
    const ok = await app.inject({ method: 'POST', url: '/w', headers: { ...base, 'x-sod-org': 'org-b' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: '/r', headers: { cookie: base.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/w', headers: authority.bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/w', headers: authority.cookie(token, { write: true }) })).statusCode).toBe(200);
  });
});

describe('B2: geri verilen rol', () => {
  async function appWith(members: Map<string, MemberProjection>, provisioned: string[], contexts: string[] = []) {
    await app.close();
    app = Fastify();
    registerProductAuth(app, {
      product: 'deciship',
      ...authority.authOptions,
      allowedOrigins: [TEST_ORIGIN],
      withOrgContext: async (orgId, work) => {
        contexts.push(orgId);
        return work();
      },
      loadMember: async (mid) => members.get(mid) ?? null,
      provisionMember: async ({ auth }) => {
        provisioned.push(auth.membershipId);
        return { epoch: auth.epoch, active: true };
      },
    });
    app.get('/r', { onRequest: app.authenticate }, async () => ({ ok: true }));
    await app.ready();
  }

  it('jetonda ürün yok ama yerel epoch daha yeni: 401 TOKEN_STALE, istemci yeniler', async () => {
    const contexts: string[] = [];
    await appWith(new Map([['m-1', { epoch: 7, active: true }]]), [], contexts);
    const token = await authority.accessToken({ role: null, orgId: 'org-a', membershipId: 'm-1', epoch: 6 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe('TOKEN_STALE');
    // RLS altında da görülsün: üye bağlam içinde okunur.
    expect(contexts).toEqual(['org-a']);
  });

  it('projeksiyon yok (ilk kez verilen rol): 403, bir kez sessiz yenilenebilir, JIT açılmaz', async () => {
    const provisioned: string[] = [];
    await appWith(new Map(), provisioned);
    const token = await authority.accessToken({ role: null, membershipId: 'yeni' });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'NO_PRODUCT_ACCESS', details: { refreshable: true } });
    expect(provisioned).toEqual([]);
  });

  it('epoch eşit (olay gecikmiş olabilir): 403, yenilenebilir; döngü yok, TOKEN_STALE değil', async () => {
    await appWith(new Map([['m-1', { epoch: 7, active: true }]]), []);
    const token = await authority.accessToken({ role: null, membershipId: 'm-1', epoch: 7 });
    const res = await app.inject({ url: '/r', headers: authority.bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'NO_PRODUCT_ACCESS', details: { refreshable: true } });
  });

  it('yerel kayıt eskiyse de TOKEN_STALE değil', async () => {
    await appWith(new Map([['m-1', { epoch: 3, active: true }]]), []);
    const token = await authority.accessToken({ role: null, membershipId: 'm-1', epoch: 7 });
    expect(code(await app.inject({ url: '/r', headers: authority.bearer(token) }))).toBe('NO_PRODUCT_ACCESS');
  });

  it('firmasız jeton üye okumaz, ORG_REQUIRED kalır', async () => {
    await appWith(new Map(), []);
    const token = await authority.accessToken({ orgId: null });
    expect(code(await app.inject({ url: '/r', headers: authority.bearer(token) }))).toBe('ORG_REQUIRED');
  });
});
