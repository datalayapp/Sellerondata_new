/**
 * Ürün dışı hizmet olayları (yapay zekâ geçidi; contracts `events.ts` `ServiceEvent`, YAPAY-ZEKA-GECIDI §7 H1).
 * Hedef `PLATFORM_SERVICE_TARGETS=ai=…`. Her olay hizmete ayrı `Outbox` satırıyla ve kendi `eventId`'siyle gider; firma olayı değişiklik
 * başına bir kez (ürün başına değil), aboneliği olmayan firmada da; `subscription.updated` ürünlü ve `limits` taşır; üye olayı gitmez.
 * Jeton `aud: service-events`, `sub: ai`. Yaşam döngüsü olayı (`org.purged` dahil) hizmette de hiç DEAD olmaz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, jwtVerify } from 'jose';
import { EVENT_AUDIENCE, SERVICE_EVENT_AUDIENCE, TOKEN_ISSUER, type ServiceEvent, type ServiceEventClaims } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { assertProductionConfig, parseServiceTargets } from '../src/env.ts';
import { DISPATCH_GIVE_UP_AFTER_MS, dispatchOnce } from '../src/lib/dispatcher.ts';
import { keys } from '../src/lib/keys.ts';
import { runMaintenance } from '../src/lib/maintenance.ts';
import { purgeClosedOrg } from '../src/lib/orgClosure.ts';
import { enqueueEvent, enqueueServiceEvents, orgUpdatedEvent } from '../src/lib/outbox.ts';
import { API, PASSWORD, addMember, asWeb, getApp, randomIp, registerOrg, type Ctx } from './helpers.ts';
import { TEST_EVENT_URL } from './testEnv.ts';

const AI_URL = 'http://ai.test/api/ai/internal/events';
const saved = process.env.PLATFORM_SERVICE_TARGETS;
let app: FastifyInstance;

beforeAll(async () => {
  app = await getApp();
  process.env.PLATFORM_SERVICE_TARGETS = `ai=${AI_URL}`;
});

// Hizmet satırları başka dosyada (hedef tanımsız) teslim edilemez, yaşam döngüsü olanı hiç bırakılmaz: kuyruk temiz bırakılır.
beforeEach(async () => {
  await prisma.outboxDelivery.deleteMany({});
  await prisma.outbox.deleteMany({});
});
afterAll(async () => {
  await prisma.outboxDelivery.deleteMany({});
  await prisma.outbox.deleteMany({});
  if (saved === undefined) delete process.env.PLATFORM_SERVICE_TARGETS;
  else process.env.PLATFORM_SERVICE_TARGETS = saved;
});

type Row = { id: string; type: string; orgId: string | null; payload: Record<string, unknown>; target: string; status: string };

async function rows(orgId: string, target?: string): Promise<Row[]> {
  const list = await prisma.outbox.findMany({ where: { orgId }, include: { deliveries: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return list
    .flatMap((o) => o.deliveries.map((d) => ({ id: o.id, type: o.type, orgId: o.orgId, payload: o.payload as Record<string, unknown>, target: d.target, status: d.status })))
    .filter((r) => !target || r.target === target);
}

async function close(owner: Ctx) {
  const name = (await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId }, select: { name: true } })).name;
  const res = await app.inject({
    method: 'POST',
    url: `${API}/org/close`,
    remoteAddress: randomIp(),
    headers: await asWeb(owner),
    payload: { confirmName: name, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
}

type Sent = { url: string; token: string; claims: Record<string, unknown> };
function fakeFetch(respond: (sent: Sent) => number) {
  const sent: Sent[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const { token } = JSON.parse(init.body as string) as { token: string };
    const entry = { url, token, claims: decodeJwt(token) as Record<string, unknown> };
    sent.push(entry);
    return new Response(null, { status: respond(entry) });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

describe('hizmet olayları: hangi olay, kaç satır', () => {
  it('firma açılışı: ai hedefine abonelik (ürünlü, limits) ve firma olayı (ürünsüz) ayrı satırlarla; üye olayı gitmez', async () => {
    const owner = await registerOrg(app);
    const ai = await rows(owner.orgId, 'ai');
    expect(ai.map((r) => r.type).sort()).toEqual(['org.updated', 'subscription.updated']);
    const sub = ai.find((r) => r.type === 'subscription.updated')!;
    expect(sub.payload).toMatchObject({ type: 'subscription.updated', orgId: owner.orgId, product: 'deciship', status: 'ACTIVE', version: 1, limits: {} });
    const org = ai.find((r) => r.type === 'org.updated')!;
    expect(org.payload).not.toHaveProperty('product');
    expect(org.payload).toMatchObject({ type: 'org.updated', orgId: owner.orgId, timeZone: 'Europe/Istanbul', companyConfirmed: false, version: 1 });
    // Her satır kendi eventId'si; ürün kopyaları ayrı satır ve kendi hedefinde.
    for (const r of ai) expect(r.payload.eventId).toBe(r.id);
    const products = await rows(owner.orgId, 'deciship');
    expect(products.map((r) => r.type).sort()).toEqual(['member.upserted', 'org.updated', 'subscription.updated']);
    expect(new Set([...ai, ...products].map((r) => r.id)).size).toBe(ai.length + products.length);
    // Hizmet satırının teslimi yalnız hizmete: tek teslim satırı.
    const deliveries = await prisma.outboxDelivery.findMany({ where: { outboxId: { in: ai.map((r) => r.id) } } });
    expect(deliveries.map((d) => d.target)).toEqual(['ai', 'ai']);
  });

  it('üye değişimi hizmete gitmez; firma adı değişimi bir kez gider', async () => {
    const owner = await registerOrg(app);
    await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    const patch = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name: 'Yeni Ad Ltd' } });
    expect(patch.statusCode, patch.body).toBe(200);
    const ai = await rows(owner.orgId, 'ai');
    expect(ai.map((r) => [r.type, r.payload.name])).toEqual([['org.updated', 'Yeni Ad Ltd']]);
    expect((await rows(owner.orgId)).filter((r) => r.type.startsWith('member.') && r.target === 'ai')).toEqual([]);
  });

  it('aynı işlemde birden çok ürün kopyası: firma olayı hizmete bir kez, abonelik olayı ürün başına', async () => {
    const owner = await registerOrg(app);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await prisma.$transaction(async (tx) => {
      await enqueueEvent(tx, orgUpdatedEvent(org, 'deciship'));
      await enqueueEvent(tx, orgUpdatedEvent(org, 'tagpress'));
      await enqueueEvent(tx, { type: 'org.closed', orgId: org.id, product: 'deciship', closedAt: 'x', purgeAfter: 'y', version: 9 });
      await enqueueEvent(tx, { type: 'org.closed', orgId: org.id, product: 'tagpress', closedAt: 'x', purgeAfter: 'y', version: 9 });
      await enqueueEvent(tx, { type: 'subscription.updated', orgId: org.id, product: 'deciship', status: 'ACTIVE', plan: 'p', version: 2 });
      await enqueueEvent(tx, { type: 'subscription.updated', orgId: org.id, product: 'tagpress', status: 'ACTIVE', plan: 'p', version: 2 });
    });
    const ai = await rows(owner.orgId, 'ai');
    expect(ai.map((r) => [r.type, r.payload.product ?? null])).toEqual([
      ['org.updated', null],
      ['org.closed', null],
      ['subscription.updated', 'deciship'],
      ['subscription.updated', 'tagpress'],
    ]);
    // Ayrı işlemde aynı olay yeniden yazılır (yeniden duyuru zararsız; alıcı eventId ve sürümle eler).
    await prisma.$transaction(async (tx) => enqueueEvent(tx, orgUpdatedEvent(org, 'deciship')));
    expect((await rows(owner.orgId, 'ai')).filter((r) => r.type === 'org.updated')).toHaveLength(2);
  });

  it('subscription.updated abonelik satırının güncel limits değerini taşır (yalnız sayı ve mantıksal)', async () => {
    const owner = await registerOrg(app);
    await prisma.subscription.update({
      where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } },
      data: { limits: { aiSpendCapMonthlyUsd: 25, aiEnabled: true, note: 'yazı' } },
    });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await prisma.$transaction(async (tx) =>
      enqueueEvent(tx, { type: 'subscription.updated', orgId: owner.orgId, product: 'deciship', status: 'READ_ONLY', plan: 'early_access', version: 5 }),
    );
    const [ai] = await rows(owner.orgId, 'ai');
    expect(ai.payload).toEqual({
      type: 'subscription.updated',
      orgId: owner.orgId,
      product: 'deciship',
      status: 'READ_ONLY',
      plan: 'early_access',
      version: 5,
      limits: { aiSpendCapMonthlyUsd: 25, aiEnabled: true },
      eventId: ai.id,
    });
    // Ürün kopyası limits taşımaz (ürün olayı sözleşmesi değişmez).
    const [product] = await rows(owner.orgId, 'deciship');
    expect(product.payload).not.toHaveProperty('limits');
  });

  it('kapatma, geri açma, kalıcı silme: hizmete birer kez, ürünsüz; aboneliği olmayan firmada da', async () => {
    const owner = await registerOrg(app);
    // Firmanın hiç aboneliği ve geçmiş teslimi yok: ürünlere olay gitmez, hizmete gider.
    await prisma.subscription.deleteMany({ where: { orgId: owner.orgId } });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await close(owner);
    const reopen = await app.inject({
      method: 'POST',
      url: `${API}/org/reopen`,
      remoteAddress: randomIp(),
      headers: await asWeb(owner),
      payload: { orgId: owner.orgId, password: PASSWORD },
    });
    expect(reopen.statusCode, reopen.body).toBe(200);
    await prisma.organization.update({ where: { id: owner.orgId }, data: { closedAt: new Date(Date.now() - 2000), purgeAfter: new Date(Date.now() - 1000) } });
    expect(await purgeClosedOrg(owner.orgId)).toMatchObject({ purged: true, products: [] });

    const all = await rows(owner.orgId);
    expect(all.filter((r) => r.target !== 'ai')).toEqual([]);
    const ai = all.filter((r) => ['org.closed', 'org.reopened', 'org.purged'].includes(r.type));
    expect(ai.map((r) => r.type)).toEqual(['org.closed', 'org.reopened', 'org.purged']);
    for (const r of ai) expect(r.payload).not.toHaveProperty('product');
    expect(ai[0].payload).toMatchObject({ orgId: owner.orgId, closedAt: expect.any(String), purgeAfter: expect.any(String), version: expect.any(Number) });
    expect(ai[2].payload).toEqual({ type: 'org.purged', orgId: owner.orgId, eventId: ai[2].id });
  });

  it('abonelikli firma kapatılınca ürün ve hizmet ayrı satır alır (ürün başına çoğalmaz)', async () => {
    const owner = await registerOrg(app);
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await close(owner);
    const closed = (await rows(owner.orgId)).filter((r) => r.type === 'org.closed');
    expect(closed.map((r) => r.target).sort()).toEqual(['ai', 'deciship']);
    expect(closed[0].id).not.toBe(closed[1].id);
  });

  it('hizmet adresi yoksa hizmete satır açılmaz (geçitsiz kurulum bugünkü gibi)', async () => {
    process.env.PLATFORM_SERVICE_TARGETS = '';
    try {
      const owner = await registerOrg(app);
      expect((await rows(owner.orgId)).filter((r) => r.target === 'ai')).toEqual([]);
      await prisma.$transaction(async (tx) => enqueueServiceEvents(tx, { type: 'org.purged', orgId: owner.orgId }));
      expect((await rows(owner.orgId)).filter((r) => r.target === 'ai')).toEqual([]);
    } finally {
      process.env.PLATFORM_SERVICE_TARGETS = `ai=${AI_URL}`;
    }
  });
});

describe('hizmet olayları: teslim', () => {
  it('ai adresine hizmet jetonuyla gider: aud service-events, sub ai, jti eventId, imza doğrulanır, ürün jetonu değil', async () => {
    const owner = await registerOrg(app);
    const { impl, sent } = fakeFetch(() => 200);
    const result = await dispatchOnce({ fetch: impl });
    const ai = sent.filter((s) => s.url === AI_URL);
    expect(ai).toHaveLength(2);
    expect(sent.filter((s) => s.url === TEST_EVENT_URL).length).toBeGreaterThan(0);
    for (const s of ai) {
      const { payload } = await jwtVerify(s.token, keys().verifierKeySet, { issuer: TOKEN_ISSUER, audience: SERVICE_EVENT_AUDIENCE, subject: 'ai' });
      const claims = payload as unknown as ServiceEventClaims;
      expect(claims.jti).toBe(claims.event.eventId);
      expect(claims.event.orgId).toBe(owner.orgId);
      expect(typeof claims.occurredAt).toBe('string');
      // Ürün kitlesiyle doğrulanmaz: araç alıcısında geçmez.
      await expect(jwtVerify(s.token, keys().verifierKeySet, { audience: EVENT_AUDIENCE })).rejects.toThrow();
    }
    // Ürün jetonu hizmet kitlesinde geçmez.
    for (const s of sent.filter((x) => x.url === TEST_EVENT_URL)) {
      await expect(jwtVerify(s.token, keys().verifierKeySet, { audience: SERVICE_EVENT_AUDIENCE })).rejects.toThrow();
      expect(s.claims.sub).toBeUndefined();
    }
    expect(result.delivered).toBe(sent.length);
    expect((await rows(owner.orgId, 'ai')).every((r) => r.status === 'DELIVERED')).toBe(true);
  });

  it('org.purged ai hedefine teslim edilir; pencere dolsa da DEAD olmaz, bakım bırakmaz', async () => {
    const owner = await registerOrg(app);
    await close(owner);
    await prisma.organization.update({ where: { id: owner.orgId }, data: { closedAt: new Date(Date.now() - 2000), purgeAfter: new Date(Date.now() - 1000) } });
    await purgeClosedOrg(owner.orgId);
    await prisma.outboxDelivery.deleteMany({ where: { outbox: { type: { not: 'org.purged' } } } });
    // Teslim satırı 72 saatten eski: yaşam döngüsü dışı olay olsa DEAD olurdu.
    await prisma.outboxDelivery.updateMany({ data: { createdAt: new Date(Date.now() - DISPATCH_GIVE_UP_AFTER_MS - 3_600_000) } });

    const down = fakeFetch(() => 503);
    const failed = await dispatchOnce({ fetch: down.impl });
    expect(down.sent.filter((s) => s.url === AI_URL).map((s) => (s.claims.event as ServiceEvent).type)).toEqual(['org.purged']);
    expect(failed.dead).toBe(0);
    let [ai] = await rows(owner.orgId, 'ai');
    expect(ai).toMatchObject({ type: 'org.purged', status: 'PENDING' });
    await runMaintenance(new Date());
    [ai] = await rows(owner.orgId, 'ai');
    expect(ai.status).toBe('PENDING');

    await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const up = fakeFetch(() => 200);
    await dispatchOnce({ fetch: up.impl });
    const purged = up.sent.find((s) => s.url === AI_URL);
    expect((purged?.claims.event as ServiceEvent)).toEqual({ type: 'org.purged', orgId: owner.orgId, eventId: ai.id });
    [ai] = await rows(owner.orgId, 'ai');
    expect(ai.status).toBe('DELIVERED');
  });

  it('adres sonradan kaldırılırsa satır bekler (hata, geri çekilme), kaybolmaz', async () => {
    const owner = await registerOrg(app);
    process.env.PLATFORM_SERVICE_TARGETS = '';
    try {
      const { impl, sent } = fakeFetch(() => 200);
      const result = await dispatchOnce({ fetch: impl });
      expect(sent.every((s) => s.url !== AI_URL)).toBe(true);
      expect(result.failed).toBe(2);
      expect((await rows(owner.orgId, 'ai')).map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    } finally {
      process.env.PLATFORM_SERVICE_TARGETS = `ai=${AI_URL}`;
    }
  });
});

describe('PLATFORM_SERVICE_TARGETS biçimi', () => {
  it('geçerli girdi, bilinmeyen hizmet, tekrar, boş adres', () => {
    expect([...parseServiceTargets(`ai=${AI_URL}/`)]).toEqual([['ai', AI_URL]]);
    expect(parseServiceTargets(undefined).size).toBe(0);
    expect(() => parseServiceTargets('deciship=http://x')).toThrow(/bilinmeyen hizmet: "deciship"/);
    expect(() => parseServiceTargets('ai=http://a,ai=http://b')).toThrow(/iki kez/);
    expect(() => parseServiceTargets('ai=')).toThrow(/adresi boş/);
    expect(() => parseServiceTargets('ai')).toThrow(/hizmet=adres/);
    // Hata metni adresi içermez (parola taşıyabilir).
    expect(() => parseServiceTargets('gizli=http://kullanici:parola@x')).toThrow(/^(?!.*parola).*$/);
  });

  it('üretimde adres yalın http(s) olmalı', () => {
    const env = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://app.ornek.test',
        APP_BASE_URL: 'https://app.ornek.test',
        DATABASE_URL: 'postgresql://sod_platform:gercek-parola@db:5432/sellerondata',
        SITE_ORIGINS: 'https://ornek.test',
        ACCOUNT_CODE_PEPPER: 'x'.repeat(40),
        SMTP_URL: 'smtp://posta.ornek.test',
        EMAIL_VERIFICATION_REQUIRED: 'true',
        COOKIE_SECURE: 'true',
        PRODUCT_NOTIFY_SECRETS: '',
        PRODUCT_EVENT_TARGETS: 'deciship=http://deciship-api:4000/api/deciship/internal/events,tagpress=http://tagpress-api:4200/api/tagpress/internal/events',
        PLATFORM_SERVICE_TARGETS: 'ai=http://kullanici:parola@ai-api:4300/api/ai/internal/events',
      });
      expect(() => assertProductionConfig()).toThrow(/PLATFORM_SERVICE_TARGETS içinde ai adresi geçersiz/);
      process.env.PLATFORM_SERVICE_TARGETS = 'ai=http://ai-api:4300/api/ai/internal/events';
      expect(() => assertProductionConfig()).not.toThrow();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
    }
  });
});
