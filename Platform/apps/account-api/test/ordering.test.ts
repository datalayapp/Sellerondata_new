import crypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import type { PlatformEvent } from '@sellerondata/contracts';
import { assertProductionConfig } from '../src/env.ts';
import { prisma } from '../src/db.ts';
import { dispatchOnce } from '../src/lib/dispatcher.ts';
import { closeOrg, reopenOrg } from '../src/lib/subscriptions.ts';
import { addMember, API, errorCode, getApp, login, parseSetCookies, PASSWORD, randomIp, registerOrg, webHeaders, asWeb, webHeadersFrom } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
beforeEach(async () => {
  await prisma.outboxDelivery.deleteMany({});
  await prisma.outbox.deleteMany({});
});

describe('dağıtıcı sırası', () => {
  /** Yanıtı geciktirir: paralel gönderilirse çakışma görünür. */
  function slowFetch(delayMs = 15) {
    const started: PlatformEvent[] = [];
    let inFlightByKey = new Map<string, number>();
    let overlap = 0;
    const key = (e: PlatformEvent) => ('membershipId' in e ? e.membershipId : `${e.orgId}:${e.type}`);
    const impl = (async (_url: string, init: RequestInit) => {
      const { token } = JSON.parse(init.body as string) as { token: string };
      const event = decodeJwt(token).event as PlatformEvent;
      started.push(event);
      const k = key(event);
      const now = (inFlightByKey.get(k) ?? 0) + 1;
      inFlightByKey.set(k, now);
      if (now > 1) overlap += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      inFlightByKey.set(k, (inFlightByKey.get(k) ?? 1) - 1);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, started, overlap: () => overlap, reset: () => (inFlightByKey = new Map()) };
  }

  it('aynı üyenin olayları aynı turda sırayla, epoch sırasıyla gider', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    for (const payload of [{ productRoles: { deciship: 'AUDITOR' } }, { status: 'SUSPENDED' }, { status: 'ACTIVE' }, { productRoles: { deciship: 'ACCOUNTING' } }]) {
      const res = await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload });
      expect(res.statusCode).toBe(200);
    }
    // createdAt eşitliği sırayı bozmasın.
    await prisma.outbox.updateMany({ data: { createdAt: new Date() } });

    const fetcher = slowFetch();
    const result = await dispatchOnce({ fetch: fetcher.impl });
    expect(result.delivered).toBe(4);
    expect(fetcher.overlap()).toBe(0);
    const epochs = fetcher.started.map((e) => (e as { epoch: number }).epoch);
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b));
  });

  it('farklı üyeler birbirini bekletmez', async () => {
    const owner = await registerOrg(app);
    const members = await Promise.all([1, 2, 3].map(() => addMember(app, owner.orgId, { deciship: 'MEASURE' })));
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    for (const m of members) {
      await app.inject({ method: 'PATCH', url: `${API}/org/members/${m.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });
    }
    let concurrent = 0;
    let peak = 0;
    const impl = (async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent -= 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await dispatchOnce({ fetch: impl });
    expect(peak).toBeGreaterThan(1);
  });

  it('sırada biri başarısızsa sonrakiler yine denenir, başarısız olan geri çekilir', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });
    await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'ACTIVE' } });
    const seen: number[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      const { token } = JSON.parse(init.body as string) as { token: string };
      const event = decodeJwt(token).event as { epoch: number };
      seen.push(event.epoch);
      return new Response(null, { status: seen.length === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const result = await dispatchOnce({ fetch: impl });
    expect(result).toMatchObject({ delivered: 1, failed: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeLessThan(seen[1]);
  });
});

describe('sürümlü firma olayları', () => {
  it('org.updated sürüm taşır ve her ad değişiminde artar', async () => {
    const owner = await registerOrg(app);
    const first = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'org.updated' } });
    const v0 = (first.at(-1)?.payload as { version: number }).version;
    expect(v0).toBeGreaterThanOrEqual(1);
    for (const name of ['İkinci Ad', 'Üçüncü Ad']) {
      await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name } });
    }
    const rows = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'org.updated' } });
    const versions = rows.map((r) => (r.payload as { version: number }).version).sort((a, b) => a - b);
    expect(versions).toEqual([v0, v0 + 1, v0 + 2]);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(org.version).toBe(v0 + 2);
  });

  it('eşzamanlı ad değişiminde sürümler tekrarlanmaz, son sürüm veritabanındaki adı taşır', async () => {
    const owner = await registerOrg(app);
    const headers = await asWeb(owner);
    await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) => app.inject({ method: 'PATCH', url: `${API}/org`, headers, payload: { name } })),
    );
    const rows = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'org.updated' } });
    const payloads = rows.map((r) => r.payload as { version: number; name: string });
    expect(new Set(payloads.map((p) => p.version)).size).toBe(payloads.length);
    const last = payloads.sort((a, b) => b.version - a.version)[0];
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    expect(last.name).toBe(org.name);
    expect(last.version).toBe(org.version);
  });

  it('subscription.updated sürüm taşır', async () => {
    const owner = await registerOrg(app);
    const [row] = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'subscription.updated' } });
    expect((row.payload as { version: number }).version).toBe(1);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } } });
    expect(sub.version).toBe(1);
  });
});

describe('abonelik kilit sırası (firma → abonelik → kişi → üyelik → davet)', () => {
  type MemberEvent = Extract<PlatformEvent, { type: 'member.upserted' }>;
  async function memberEvents(membershipId: string) {
    const rows = await prisma.outbox.findMany({ where: { type: 'member.upserted' } });
    return rows.map((r) => r.payload as MemberEvent).filter((e) => e.membershipId === membershipId);
  }

  it('aynı anda org:close, üye rol değişimi, davet ve firma adı değişimi ölü kilide girmez; son olay son epoch', async () => {
    for (let round = 0; round < 4; round += 1) {
      const owner = await registerOrg(app);
      const members = await Promise.all([1, 2].map(() => addMember(app, owner.orgId, { deciship: 'MEASURE' })));
      const results = await Promise.allSettled([
        closeOrg(owner.orgId, { operator: 'destek-ali', days: 5 }),
        app.inject({ method: 'PATCH', url: `${API}/org/members/${members[0].membershipId}`, headers: await asWeb(owner), payload: { productRoles: { deciship: 'AUDITOR' } } }),
        app.inject({ method: 'PATCH', url: `${API}/org/members/${members[1].membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } }),
        app.inject({ method: 'POST', url: `${API}/org/members/invite`, headers: await asWeb(owner), payload: { kind: 'EMAIL', email: `${crypto.randomUUID()}@test.sellerondata.com` } }),
        app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name: `Yeni Ad ${round}` } }),
      ]);
      // Ölü kilit Postgres'te birini 500 ile düşürürdü. Kapatma önce biterse sahibin jetonu bayattır: 401 TOKEN_STALE doğru sonuçtur.
      const ok: boolean[] = [];
      for (const r of results) {
        expect(r.status, r.status === 'rejected' ? String(r.reason) : '').toBe('fulfilled');
        const value = (r as PromiseFulfilledResult<unknown>).value as { statusCode?: number; body?: string; json?: () => unknown };
        if (value.statusCode === undefined) continue;
        // Kapatma önce biterse davet `409 ORG_CLOSED` alır (kapalı firmada davet yok).
        if (value.statusCode === 401) expect(errorCode(value as { json: () => unknown })).toBe('TOKEN_STALE');
        else if (value.statusCode === 409) expect(errorCode(value as { json: () => unknown })).toBe('ORG_CLOSED');
        else expect(value.statusCode, value.body).toBeLessThan(300);
        ok.push(value.statusCode < 300);
      }
      expect((await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } } })).status).toBe('CANCELED');
      for (const [i, m] of members.entries()) {
        const db = await prisma.membership.findUniqueOrThrow({ where: { id: m.membershipId } });
        const events = await memberEvents(m.membershipId);
        expect(new Set(events.map((e) => e.epoch)).size).toBe(events.length);
        expect(Math.max(...events.map((e) => e.epoch))).toBe(db.epoch);
        // Kapatma ve (geçtiyse) üye değişimi: ayrı artışlar.
        expect(db.epoch).toBe(1 + (ok[i] ? 1 : 0));
      }
    }
  });

  it('kapatma sahibin jetonunu Hesap servisinde de bayatlatır; aynı anda org:reopen ve rol değişimi epoch tekrar etmez', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await closeOrg(owner.orgId, { operator: 'destek-ali' });
    const stale = await app.inject({ method: 'GET', url: `${API}/org/members`, headers: owner.headers });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const relogin = await login(app, owner.email as string);
    expect(relogin.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${(relogin.json() as { accessToken: string }).accessToken}` };
    const ownerWeb = await webHeadersFrom(headers);
    const [reopen, patch] = await Promise.all([
      reopenOrg(owner.orgId, { operator: 'destek-ali' }),
      app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: ownerWeb, payload: { productRoles: { deciship: 'ACCOUNTING' } } }),
    ]);
    expect(reopen.restored).toEqual(['deciship']);
    if (patch.statusCode === 401) expect(errorCode(patch)).toBe('TOKEN_STALE');
    else expect(patch.statusCode, patch.body).toBe(200);
    const patched = patch.statusCode === 200;
    const db = await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } });
    expect(db.epoch).toBe(patched ? 3 : 2);
    const events = await memberEvents(member.membershipId);
    expect(new Set(events.map((e) => e.epoch)).size).toBe(events.length);
    expect(Math.max(...events.map((e) => e.epoch))).toBe(db.epoch);
  });
});

describe('yinelenen oturum çerezi', () => {
  it('iki sod_at veya iki sod_rt: 401, kimlik seçilmez', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const a = parseSetCookies(await login(app, owner.email as string, PASSWORD, 'web'));
    const b = parseSetCookies(await login(app, other.email as string, PASSWORD, 'web'));

    const me = await app.inject({ url: `${API}/me`, headers: { cookie: `sod_at=${a.sod_at.value}; sod_at=${b.sod_at.value}` } });
    expect(me.statusCode).toBe(401);
    expect(errorCode(me)).toBe('UNAUTHORIZED');

    const refresh = await app.inject({
      method: 'POST',
      url: `${API}/auth/refresh`,
      remoteAddress: randomIp(),
      headers: webHeaders(`sod_rt=${a.sod_rt.value}; sod_rt=${b.sod_rt.value}`),
      payload: {},
    });
    expect(refresh.statusCode).toBe(401);
    // Ne hırsızlık sayılır ne döner.
    const ok = await app.inject({
      method: 'POST',
      url: `${API}/auth/refresh`,
      remoteAddress: randomIp(),
      headers: webHeaders(`sod_rt=${a.sod_rt.value}`),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('üretimde geliştirme parolası', () => {
  it('*_dev parolalı DATABASE_URL ile başlamaz', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_ORIGINS = 'https://a';
      process.env.APP_BASE_URL = 'https://a';
      process.env.ACCOUNT_CODE_PEPPER = 'x'.repeat(40);
      process.env.SMTP_URL = 'smtp://mail:25';
      process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
      process.env.DATABASE_URL = 'postgresql://sod_platform:sod_platform_dev@db/sellerondata';
      expect(() => assertProductionConfig()).toThrow(/geliştirme parolası/);
      process.env.DATABASE_URL = 'postgresql://sod_platform:gercek-parola@db/sellerondata';
      expect(() => assertProductionConfig()).not.toThrow();
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      process.env.ALLOWED_ORIGINS = saved.ALLOWED_ORIGINS;
      process.env.APP_BASE_URL = saved.APP_BASE_URL;
      process.env.DATABASE_URL = saved.DATABASE_URL;
      process.env.EMAIL_VERIFICATION_REQUIRED = saved.EMAIL_VERIFICATION_REQUIRED;
      delete process.env.ACCOUNT_CODE_PEPPER;
      process.env.SMTP_URL = '';
    }
  });
});
