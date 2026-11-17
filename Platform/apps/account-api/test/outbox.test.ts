import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import type { PlatformEvent } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import {
  backoffMs,
  DISPATCH_LEASE_SECONDS,
  DISPATCH_GIVE_UP_AFTER_MS,
  dispatchOnce,
} from '../src/lib/dispatcher.ts';
import { applyMemberUpdate } from '../src/lib/members.ts';
import { runMaintenance } from '../src/lib/maintenance.ts';
import { addMember, API, epochOf, getApp, outboxFor, registerOrg, asWeb } from './helpers.ts';
import { TEST_EVENT_URL } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

/** Her test temiz kuyrukla başlar: dağıtıcı tüm bekleyenlere bakar. */
beforeEach(async () => {
  await prisma.outboxDelivery.deleteMany({});
  await prisma.outbox.deleteMany({});
});

type Sent = { url: string; event: PlatformEvent; claims: Record<string, unknown> };

function fakeFetch(respond: (sent: Sent) => number | Promise<number>) {
  const sent: Sent[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const { token } = JSON.parse(init.body as string) as { token: string };
    const claims = decodeJwt(token) as Record<string, unknown>;
    const entry = { url, event: claims.event as PlatformEvent, claims };
    sent.push(entry);
    return new Response(null, { status: await respond(entry) });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

async function pending() {
  return prisma.outboxDelivery.findMany({ where: { status: 'PENDING' }, include: { outbox: true } });
}

/** Geri çekilmeyi beklemeden bir sonraki denemeyi çağırır. */
async function makeDue() {
  await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

describe('rol değişimi: epoch + Outbox aynı işlemde', () => {
  it('rol değişince epoch artar, olay güncel rol ve epoch taşır', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const before = await epochOf(member.membershipId);

    const res = await app.inject({
      method: 'PATCH',
      url: `${API}/org/members/${member.membershipId}`,
      headers: await asWeb(owner),
      payload: { productRoles: { deciship: 'AUDITOR' } },
    });
    expect(res.statusCode).toBe(200);
    expect(await epochOf(member.membershipId)).toBe(before + 1);

    const events = await outboxFor(member.membershipId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      type: 'member.upserted',
      eventId: events[0].id,
      orgId: owner.orgId,
      product: 'deciship',
      membershipId: member.membershipId,
      personId: member.personId,
      orgRole: 'MEMBER',
      role: 'AUDITOR',
      active: true,
      epoch: before + 1,
    });
    expect(events[0].deliveries).toHaveLength(1);
    expect(events[0].deliveries[0]).toMatchObject({ target: 'deciship', status: 'PENDING', attempts: 0 });
  });

  it('değişiklik yoksa epoch artmaz, olay yazılmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const before = await epochOf(member.membershipId);
    const res = await app.inject({
      method: 'PATCH',
      url: `${API}/org/members/${member.membershipId}`,
      headers: await asWeb(owner),
      payload: { orgRole: 'MEMBER', status: 'ACTIVE', productRoles: { deciship: 'MEASURE' } },
    });
    expect(res.json().changed).toEqual([]);
    expect(await epochOf(member.membershipId)).toBe(before);
    expect(await outboxFor(member.membershipId)).toHaveLength(0);
  });

  it('işlem geri alınırsa ne epoch ne rol ne olay kalır', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const before = await epochOf(member.membershipId);

    await expect(
      prisma.$transaction(async (tx) => {
        const changed = await applyMemberUpdate(tx, member.membershipId, { productRoles: { deciship: 'ADMIN' } });
        expect(changed).toEqual(['productRoles']);
        // İşlem içinde üçü birden görünür.
        const inside = await tx.membership.findUniqueOrThrow({ where: { id: member.membershipId } });
        expect(inside.epoch).toBe(before + 1);
        throw new Error('sonradan patladı');
      }),
    ).rejects.toThrow('sonradan patladı');

    expect(await epochOf(member.membershipId)).toBe(before);
    expect(await outboxFor(member.membershipId)).toHaveLength(0);
    const access = await prisma.productAccess.findFirstOrThrow({ where: { membershipId: member.membershipId } });
    expect(access.role).toBe('MEASURE');
  });

  it('askı, şifre değişimi ve çıkarma da olay üretir', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });
    expect((await outboxFor(member.membershipId)).at(-1)?.payload).toMatchObject({ type: 'member.upserted', active: false });

    await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'ACTIVE' } });
    await app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) });
    expect((await outboxFor(member.membershipId)).at(-1)?.payload).toMatchObject({ type: 'member.removed' });
  });

  it('hedefi tanımsız ürün için de teslim satırı açılır (dağıtıcı bekletir, olay kaybolmaz)', async () => {
    const saved = process.env.PRODUCT_EVENT_TARGETS;
    process.env.PRODUCT_EVENT_TARGETS = '';
    try {
      const owner = await registerOrg(app);
      const events = await outboxFor(owner.membershipId);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].deliveries).toHaveLength(1);
      expect(events[0].deliveries[0]).toMatchObject({ target: 'deciship', status: 'PENDING' });
    } finally {
      process.env.PRODUCT_EVENT_TARGETS = saved;
    }
  });
});

describe('dağıtıcı', () => {
  it('imzalı olay hedefe gider, teslim edildi olur, ikinci turda gönderilmez', async () => {
    await registerOrg(app);
    const count = (await pending()).length;
    expect(count).toBeGreaterThan(0);
    const { impl, sent } = fakeFetch(() => 200);

    const result = await dispatchOnce({ fetch: impl });
    expect(result).toMatchObject({ claimed: count, delivered: count, failed: 0 });
    expect(sent).toHaveLength(count);
    expect(sent[0].url).toBe(TEST_EVENT_URL);
    expect(sent[0].claims).toMatchObject({ iss: 'sellerondata-account', aud: 'product-events' });
    expect(sent[0].claims.jti).toBe(sent[0].event.eventId);
    expect(sent[0].claims.occurredAt).toBeTruthy();

    expect(await pending()).toHaveLength(0);
    const again = await dispatchOnce({ fetch: impl });
    expect(again.claimed).toBe(0);
    expect(sent).toHaveLength(count);
  });

  it('hata alınca geri çekilir, aynı eventId ile yeniden dener, jeton taze imzalanır', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
    await app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });

    let status = 503;
    const { impl, sent } = fakeFetch(() => status);
    const first = await dispatchOnce({ fetch: impl });
    expect(first).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });

    const [row] = await pending();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('HTTP 503');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Geri çekilme dolmadan yeniden gönderilmez.
    expect((await dispatchOnce({ fetch: impl })).claimed).toBe(0);

    await makeDue();
    status = 200;
    const second = await dispatchOnce({ fetch: impl });
    expect(second).toMatchObject({ claimed: 1, delivered: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[0].event.eventId).toBe(sent[1].event.eventId);
    const done = await prisma.outboxDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(done).toMatchObject({ status: 'DELIVERED', attempts: 2, lastError: null });
    expect(done.deliveredAt).not.toBeNull();
  });

  it('ağ hatası da yeniden denenir', async () => {
    await registerOrg(app);
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await dispatchOnce({ fetch: impl });
    expect(result.delivered).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect((await pending()).every((d) => d.lastError === 'fetch failed')).toBe(true);
  });

  it('yönlendirme izlenmez: imzalı olay başka adrese taşınmaz', async () => {
    await registerOrg(app);
    let redirect: RequestRedirect | undefined;
    const impl = (async (_url: string, init: RequestInit) => {
      redirect = init.redirect;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await dispatchOnce({ fetch: impl });
    expect(redirect).toBe('error');
  });

  it('üst sınırdan sonra DEAD olur, tekrar denenmez', async () => {
    await registerOrg(app);
    await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { createdAt: new Date(Date.now() - DISPATCH_GIVE_UP_AFTER_MS - 1000) } });
    const { impl } = fakeFetch(() => 500);
    const result = await dispatchOnce({ fetch: impl });
    expect(result.dead).toBeGreaterThan(0);
    expect(await pending()).toHaveLength(0);
    expect(await prisma.outboxDelivery.count({ where: { status: 'DEAD' } })).toBe(result.dead);
  });

  it('bakım turu DEAD olayı kurtarma komutuyla uyarır; üyelik olayları ayrıca sayılır (Y146)', async () => {
    const owner = await registerOrg(app);
    await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { status: 'DEAD' } });
    const dead = await prisma.outboxDelivery.count({ where: { status: 'DEAD' } });
    const deadMembers = await prisma.outboxDelivery.count({ where: { status: 'DEAD', outbox: { type: { in: ['member.upserted', 'member.removed'] } } } });
    expect(deadMembers).toBeGreaterThan(0);
    const warns: { obj: unknown; msg?: string }[] = [];
    await runMaintenance(new Date(), { warn: (obj, msg) => void warns.push({ obj, msg }), error: () => {} });
    const warning = warns.find((w) => w.msg?.includes('DEAD'));
    expect(warning?.obj).toEqual({ dead, deadMembers });
    expect(warning?.msg).toContain('outbox-requeue');
  });

  it('iki kopya aynı anda çalışsa da her teslim bir kez sahiplenilir', async () => {
    for (let i = 0; i < 3; i++) await registerOrg(app);
    const total = (await pending()).length;
    const { impl, sent } = fakeFetch(() => 200);
    const results = await Promise.all([dispatchOnce({ fetch: impl }), dispatchOnce({ fetch: impl }), dispatchOnce({ fetch: impl })]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(total);
    expect(new Set(sent.map((s) => s.event.eventId)).size).toBe(total);
    expect(sent).toHaveLength(total);
  });

  it('gönderim sürerken süreç ölürse kira bitince yeniden denenir (en az bir kez)', async () => {
    await registerOrg(app);
    const { impl: firstRun } = fakeFetch(() => 200);
    // Sahiplenildi ama sonuç yazılamadı: süreç öldü.
    await prisma.$executeRaw`
      UPDATE "platform"."OutboxDelivery"
      SET "attempts" = "attempts" + 1, "nextAttemptAt" = now() + make_interval(secs => ${DISPATCH_LEASE_SECONDS}::double precision)
      WHERE "status" = 'PENDING'`;
    expect((await dispatchOnce({ fetch: firstRun })).claimed).toBe(0);
    await makeDue();
    const result = await dispatchOnce({ fetch: firstRun });
    expect(result.delivered).toBeGreaterThan(0);
  });

  it('hedef sonradan kaldırılırsa kayıp olmaz: bekler ve hata yazar', async () => {
    await registerOrg(app);
    const saved = process.env.PRODUCT_EVENT_TARGETS;
    process.env.PRODUCT_EVENT_TARGETS = '';
    try {
      const { impl, sent } = fakeFetch(() => 200);
      await dispatchOnce({ fetch: impl });
      expect(sent).toHaveLength(0);
      const rows = await pending();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].lastError).toContain('hedef tanımsız');
    } finally {
      process.env.PRODUCT_EVENT_TARGETS = saved;
    }
  });

  it('geri çekilme üsteldir ve bir saatle sınırlıdır', () => {
    const none = () => 0;
    expect(backoffMs(1, none)).toBe(2_000);
    expect(backoffMs(2, none)).toBe(4_000);
    expect(backoffMs(5, none)).toBe(32_000);
    expect(backoffMs(30, none)).toBe(3_600_000);
    expect(backoffMs(1, () => 1)).toBe(2_400);
  });
});

describe('bakım', () => {
  it('eski kayıtları temizler, bekleyen teslime dokunmaz', async () => {
    await registerOrg(app);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await prisma.outbox.updateMany({ data: { createdAt: old } });
    const before = await prisma.outbox.count();
    await runMaintenance();
    expect(await prisma.outbox.count()).toBe(before); // hâlâ bekliyor
    await prisma.outboxDelivery.updateMany({ data: { status: 'DELIVERED' } });
    await runMaintenance();
    expect(await prisma.outbox.count()).toBe(0);
  });
});

describe('olay yayını çalışırken duruma bakar (PRODUCT_LAUNCH)', () => {
  async function withLaunch<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PRODUCT_LAUNCH;
    process.env.PRODUCT_LAUNCH = value;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.PRODUCT_LAUNCH;
      else process.env.PRODUCT_LAUNCH = saved;
    }
  }

  it('kapalı ürüne olay gitmez (epoch yine artar); pilot ve aboneliği olan ürüne gider', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    const before = await epochOf(member.membershipId);

    await withLaunch('deciship=off', async () => {
      await prisma.$transaction((tx) => applyMemberUpdate(tx, member.membershipId, { orgRole: 'ADMIN' }));
      expect(await epochOf(member.membershipId)).toBe(before + 1);
      expect(await outboxFor(member.membershipId)).toEqual([]);
    });

    await withLaunch('deciship=pilot', async () => {
      await prisma.$transaction((tx) => applyMemberUpdate(tx, member.membershipId, { orgRole: 'MEMBER' }));
      const rows = await outboxFor(member.membershipId);
      expect(rows.map((r) => [r.type, r.deliveries.map((d) => d.target)])).toEqual([['member.upserted', ['deciship']]]);
      expect((rows[0].payload as { epoch: number }).epoch).toBe(before + 2);
    });
  });

  it('kayıtta olmayan ürünün abonelik satırı olay almaz, yayını bozmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.subscription.create({ data: { orgId: owner.orgId, product: 'eskiurun', status: 'ACTIVE', plan: 'early_access' } });
    await prisma.subscription.create({ data: { orgId: owner.orgId, product: 'orderloom', status: 'ACTIVE', plan: 'early_access' } });
    await prisma.$transaction((tx) => applyMemberUpdate(tx, member.membershipId, { orgRole: 'ADMIN' }));
    const rows = await outboxFor(member.membershipId);
    expect(rows.flatMap((r) => r.deliveries.map((d) => d.target))).toEqual(['deciship']);
  });
});
