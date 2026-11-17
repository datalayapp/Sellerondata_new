import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerEventReceiver, registerProductAuth, type MemberProjection } from '@sellerondata/auth-kit';
import type { PlatformEvent } from '@sellerondata/contracts';
import { buildApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { dispatchOnce } from '../src/lib/dispatcher.ts';
import { addMember, API, bearer, errorCode, parseSetCookies, PASSWORD, randomIp, registerOrg, asWeb, withCookieToken } from './helpers.ts';
import { TEST_ORIGIN } from './testEnv.ts';

/**
 * Gerçek Hesap + gerçek auth-kit: ürün jetonu gerçek HTTP'den alınan JWKS ile doğrular,
 * olaylar gerçek HTTP ile gerçek alıcıya gider. Sahte yok, kablo uyumu burada kanıtlanır.
 */

type Member = MemberProjection & { name: string; role: string | null; orgId: string };

let account: FastifyInstance;
let product: FastifyInstance;
let accountUrl: string;
let productUrl: string;
let members: Map<string, Member>;
let processed: Set<string>;

beforeAll(async () => {
  account = await buildApp();
  accountUrl = await account.listen({ host: '127.0.0.1', port: 0 });

  product = Fastify();
  registerProductAuth(product, {
    product: 'deciship',
    jwksUrl: `${accountUrl}${API}/.well-known/jwks.json`,
    allowedOrigins: [TEST_ORIGIN],
    loadMember: async (mid) => members.get(mid) ?? null,
    provisionMember: async ({ auth }) => {
      const m: Member = { epoch: auth.epoch, active: true, name: auth.name, role: auth.productRole, orgId: auth.orgId };
      members.set(auth.membershipId, m);
      return m;
    },
    syncMember: async ({ auth }, current) => {
      const m: Member = { ...(current as Member), epoch: auth.epoch, active: true, role: auth.productRole };
      members.set(auth.membershipId, m);
      return m;
    },
  });
  registerEventReceiver<null>(product, {
    product: 'deciship',
    transaction: (work) => work(null),
    claimEvent: async (_tx, id) => {
      if (processed.has(id)) return false;
      processed.add(id);
      return true;
    },
    memberEpoch: async (_tx, mid) => members.get(mid)?.epoch ?? null,
    onEvent: async (_tx, event: PlatformEvent) => {
      if (event.type === 'member.upserted') {
        members.set(event.membershipId, { epoch: event.epoch, active: event.active, name: event.name, role: event.role, orgId: event.orgId });
      } else if (event.type === 'member.removed') {
        members.set(event.membershipId, { epoch: event.epoch, active: false, name: event.name ?? '', role: null, orgId: event.orgId });
      }
    },
  });
  product.get('/api/deciship/invoices', { preHandler: product.requirePermission('deciship.invoices.view') }, async (req) => ({
    org: req.auth.orgId,
    role: req.auth.productRole,
  }));
  product.post('/api/deciship/invoices', { preHandler: product.requirePermission('deciship.invoices.upload') }, async () => ({ ok: true }));
  productUrl = await product.listen({ host: '127.0.0.1', port: 0 });
  process.env.PRODUCT_EVENT_TARGETS = `deciship=${productUrl}/api/deciship/internal/events`;
});

afterAll(async () => {
  process.env.PRODUCT_EVENT_TARGETS = 'deciship=http://deciship.test/api/deciship/internal/events';
  await product.close();
  await account.close();
});

beforeEach(async () => {
  members = new Map();
  processed = new Set();
  await prisma.outboxDelivery.deleteMany({});
  await prisma.outbox.deleteMany({});
});

const productGet = (headers: Record<string, string>) => product.inject({ url: '/api/deciship/invoices', headers });

describe('Hesap + auth-kit uçtan uca', () => {
  it('Hesap jetonu üründe doğrulanır, JIT projeksiyon açılır', async () => {
    const owner = await registerOrg(account);
    const res = await productGet(owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ org: owner.orgId, role: 'ADMIN' });
    expect(members.get(owner.membershipId)).toMatchObject({ epoch: 0, active: true, role: 'ADMIN' });
  });

  it('rol değişimi: olay gerçek HTTP ile iner, eski jeton TOKEN_STALE, yenilenince yeni rol', async () => {
    const owner = await registerOrg(account);
    const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
    expect((await productGet(member.headers)).statusCode).toBe(200);

    const change = await account.inject({
      method: 'PATCH',
      url: `${API}/org/members/${member.membershipId}`,
      headers: await asWeb(owner),
      payload: { productRoles: { deciship: 'MEASURE' } },
    });
    expect(change.statusCode).toBe(200);

    // Olay inmeden eski jeton hâlâ geçer: üst sınır jeton ömrüdür.
    expect((await productGet(member.headers)).statusCode).toBe(200);

    const dispatched = await dispatchOnce();
    expect(dispatched.delivered).toBeGreaterThan(0);
    expect(dispatched.failed).toBe(0);
    expect(members.get(member.membershipId)).toMatchObject({ role: 'MEASURE' });

    const stale = await productGet(member.headers);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('TOKEN_STALE');

    const refreshed = await account.inject({
      method: 'POST',
      url: `${API}/auth/refresh`,
      remoteAddress: randomIp(),
      payload: { refreshToken: member.refreshToken },
    });
    const fresh = await productGet(bearer(refreshed.json().accessToken));
    // Yeni rol MEASURE: fatura görme izni yok.
    expect(fresh.statusCode).toBe(403);
    expect(fresh.json().error.code).toBe('FORBIDDEN');
  });

  describe('geri verilen rol', () => {
    const refreshed = async (refreshToken: string) => {
      const res = await account.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });
      expect(res.statusCode).toBe(200);
      return res.json() as { accessToken: string; refreshToken: string };
    };
    const setRole = async (owner: { accessToken: string }, id: string, role: string | null) =>
      account.inject({ method: 'PATCH', url: `${API}/org/members/${id}`, headers: await asWeb(owner), payload: { productRoles: { deciship: role } } });

    it('rol kapat, işlem, rol geri ver: bir sonraki istek yenilemeyle çalışır, 10 dakika beklenmez', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
      expect((await productGet(member.headers)).statusCode).toBe(200);

      await setRole(owner, member.membershipId, null);
      await dispatchOnce();
      let tokens = await refreshed(member.refreshToken);
      const denied = await productGet(bearer(tokens.accessToken));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('NO_PRODUCT_ACCESS');

      await setRole(owner, member.membershipId, 'ACCOUNTING');
      await dispatchOnce();
      const stale = await productGet(bearer(tokens.accessToken));
      expect(stale.statusCode).toBe(401);
      expect(stale.json().error.code).toBe('TOKEN_STALE');

      tokens = await refreshed(tokens.refreshToken);
      const ok = await productGet(bearer(tokens.accessToken));
      expect(ok.statusCode).toBe(200);
      expect(ok.json().role).toBe('ACCOUNTING');
    });

    it('olay henüz inmediyse 403 yenilenebilir der, yenileyince açılır', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
      await productGet(member.headers);
      await setRole(owner, member.membershipId, null);
      await dispatchOnce();
      const tokens = await refreshed(member.refreshToken);
      await setRole(owner, member.membershipId, 'ACCOUNTING'); // Olay dağıtılmadı.
      const res = await productGet(bearer(tokens.accessToken));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toEqual({ refreshable: true });
      const again = await refreshed(tokens.refreshToken);
      expect((await productGet(bearer(again.accessToken))).statusCode).toBe(200);
    });

    it('ilk kez verilen rol: projeksiyon yok, 403 yenilenebilir, yenileyince JIT açılır', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: null });
      const res = await productGet(member.headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'NO_PRODUCT_ACCESS', details: { refreshable: true } });
      await setRole(owner, member.membershipId, 'AUDITOR');
      const tokens = await refreshed(member.refreshToken);
      expect((await productGet(bearer(tokens.accessToken))).statusCode).toBe(200);
    });

    it('rolü olmayan kişi yenilese de reddedilir: tek sessiz yenileme, döngü yok', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: null });
      const tokens = await refreshed(member.refreshToken);
      const res = await productGet(bearer(tokens.accessToken));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NO_PRODUCT_ACCESS');
    });

    it('askı hâlâ reddedilir: rol geri verilse de askıdaki kişi giremez', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
      await productGet(member.headers);
      await account.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });
      await dispatchOnce();
      expect((await productGet(member.headers)).json().error.code).toBe('TOKEN_STALE');
      const tokens = await refreshed(member.refreshToken);
      const res = await productGet(bearer(tokens.accessToken));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORG_REQUIRED');
    });

    it('TOKEN_STALE sonrası yenilenen jeton bir daha bayat değildir', async () => {
      const owner = await registerOrg(account);
      const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
      await productGet(member.headers);
      await setRole(owner, member.membershipId, 'AUDITOR');
      await dispatchOnce();
      expect((await productGet(member.headers)).json().error.code).toBe('TOKEN_STALE');
      const tokens = await refreshed(member.refreshToken);
      const res = await productGet(bearer(tokens.accessToken));
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('AUDITOR');
    });
  });

  it('olay kaybolsa da yeni jeton projeksiyonu günceller (ep > epoch)', async () => {
    const owner = await registerOrg(account);
    const member = await addMember(account, owner.orgId, { deciship: 'ACCOUNTING' });
    await productGet(member.headers);
    await account.inject({
      method: 'PATCH',
      url: `${API}/org/members/${member.membershipId}`,
      headers: await asWeb(owner),
      payload: { productRoles: { deciship: 'AUDITOR' } },
    });
    const refreshed = await account.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: member.refreshToken } });
    const res = await productGet(bearer(refreshed.json().accessToken));
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('AUDITOR');
    expect(members.get(member.membershipId)?.role).toBe('AUDITOR');
  });

  it('çıkarılan üye: olaydan sonra eski jeton reddedilir, JIT geri açamaz', async () => {
    const owner = await registerOrg(account);
    const member = await addMember(account, owner.orgId, { deciship: 'AUDITOR' });
    await productGet(member.headers);
    await account.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    await dispatchOnce();
    expect(members.get(member.membershipId)).toMatchObject({ active: false });
    const res = await productGet(member.headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_STALE');
  });

  it('kişi firmadan ayrılınca olay iner, eski jeton üründe bayat, JIT geri açamaz', async () => {
    const owner = await registerOrg(account);
    const member = await addMember(account, owner.orgId, { deciship: 'AUDITOR' });
    await productGet(member.headers);
    const res = withCookieToken(await account.inject({ method: 'POST', url: `${API}/org/leave`, headers: await asWeb(member), payload: {} }));
    expect(res.statusCode).toBe(200);
    await dispatchOnce();
    expect(members.get(member.membershipId)).toMatchObject({ active: false });
    expect((await productGet(member.headers)).json().error.code).toBe('TOKEN_STALE');
    expect((await productGet(bearer(res.json().accessToken))).json().error.code).toBe('ORG_REQUIRED');
  });

  it('POST /orgs ile açılan firma üründe JIT ile çalışır', async () => {
    const owner = await registerOrg(account);
    const created = await account.inject({
      method: 'POST',
      url: `${API}/orgs`,
      remoteAddress: randomIp(),
      headers: owner.headers,
      payload: { name: 'Yeni İş', country: 'TR' },
    });
    expect(created.statusCode).toBe(201);
    const res = await productGet(bearer(created.json().accessToken));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ org: created.json().activeOrgId, role: 'ADMIN' });
  });

  it('şifre değişimi anında tüm firmalardaki açık jetonları düşürür', async () => {
    const owner = await registerOrg(account);
    await productGet(owner.headers);
    const res = await account.inject({
      method: 'POST',
      url: `${API}/me/password`,
      headers: owner.headers,
      payload: { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' },
    });
    expect(res.statusCode).toBe(200);
    await dispatchOnce();
    expect((await productGet(owner.headers)).json().error.code).toBe('TOKEN_STALE');
    expect((await productGet(bearer(res.json().accessToken))).statusCode).toBe(200);
  });

  it('web akışı: Hesap çerezi ürünü de açar; yazma CSRF ister', async () => {
    const owner = await registerOrg(account);
    const res = await account.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      headers: { 'x-sod-csrf': '1', origin: TEST_ORIGIN },
      payload: { identifier: owner.email, password: PASSWORD, client: 'web' },
    });
    const at = parseSetCookies(res).sod_at.value;
    const cookie = `sod_at=${at}`;
    expect((await productGet({ cookie })).statusCode).toBe(200);
    const denied = await product.inject({ method: 'POST', url: '/api/deciship/invoices', headers: { cookie } });
    expect(denied.json().error.code).toBe('CSRF_FAILED');
    const ok = await product.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: { cookie, 'x-sod-csrf': '1', origin: TEST_ORIGIN, 'x-sod-org': owner.orgId },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('abonelik READ_ONLY: jetona yansır, üründe yazma kapanır, okuma sürer', async () => {
    const owner = await registerOrg(account);
    await prisma.subscription.update({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } }, data: { status: 'READ_ONLY' } });
    const refreshed = await account.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: owner.refreshToken } });
    const headers = bearer(refreshed.json().accessToken);
    expect((await productGet(headers)).statusCode).toBe(200);
    const write = await product.inject({ method: 'POST', url: '/api/deciship/invoices', headers });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('READ_ONLY');
  });

  it('Hesap\'ın imzası dışında olay kabul edilmez, tekrar gönderim idempotenttir', async () => {
    const owner = await registerOrg(account);
    const forged = await product.inject({
      method: 'POST',
      url: '/api/deciship/internal/events',
      payload: { token: owner.accessToken },
    });
    expect(forged.statusCode).toBe(401);

    const sent: string[] = [];
    const recording = (async (url: string, init: RequestInit) => {
      sent.push(init.body as string);
      return fetch(url, init);
    }) as unknown as typeof fetch;
    await dispatchOnce({ fetch: recording });
    expect(sent.length).toBeGreaterThan(0);
    const replay = await product.inject({
      method: 'POST',
      url: '/api/deciship/internal/events',
      headers: { 'content-type': 'application/json' },
      payload: sent[0],
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().outcome).toBe('duplicate');
  });

  it('org null jeton ürüne giremez', async () => {
    const owner = await registerOrg(account);
    const member = await addMember(account, owner.orgId, { deciship: 'AUDITOR' });
    await prisma.membership.delete({ where: { id: member.membershipId } });
    const refreshed = await account.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: member.refreshToken } });
    const res = await productGet(bearer(refreshed.json().accessToken));
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('ORG_REQUIRED');
  });

  it('A firmasının jetonu B kaydına kapsam vermez: req.auth.orgId jetondan gelir', async () => {
    const a = await registerOrg(account);
    const b = await registerOrg(account);
    const res = await productGet(a.headers);
    expect(res.json().org).toBe(a.orgId);
    expect(res.json().org).not.toBe(b.orgId);
    expect(randomUUID()).toBeTruthy();
  });
});
