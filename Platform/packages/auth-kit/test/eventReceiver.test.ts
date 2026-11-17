import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PlatformEvent, PlatformEventType } from '@sellerondata/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerEventReceiver } from '../src/index.ts';
import { KNOWN_EVENT_TYPES } from '../src/eventReceiver.ts';
import { createTestAuthority, type TestAuthority } from '../src/testing.ts';

type FakeTx = { processed: Set<string>; applied: PlatformEvent[]; epochs: Map<string, number> };

let authority: TestAuthority;
let app: FastifyInstance;
let db: FakeTx;
let failNext: boolean;
let transactions: number;

const URL_PATH = '/api/deciship/internal/events';

function memberEvent(over: Partial<Extract<PlatformEvent, { type: 'member.upserted' }>> = {}): PlatformEvent {
  return {
    eventId: randomUUID(),
    type: 'member.upserted',
    orgId: 'org-a',
    product: 'deciship',
    membershipId: 'm-1',
    personId: 'p-1',
    name: 'Ali',
    orgRole: 'MEMBER',
    role: 'AUDITOR',
    active: true,
    epoch: 2,
    ...over,
  };
}

beforeEach(async () => {
  authority = await createTestAuthority();
  db = { processed: new Set(), applied: [], epochs: new Map() };
  failNext = false;
  transactions = 0;
  app = Fastify();
  registerEventReceiver<FakeTx>(app, {
    product: 'deciship',
    ...authority.authOptions,
    // Gerçek işlem gibi: `work` fırlatırsa kopya üzerindeki değişiklikler geri alınır.
    transaction: async (work) => {
      transactions++;
      const copy: FakeTx = { processed: new Set(db.processed), applied: [...db.applied], epochs: new Map(db.epochs) };
      const result = await work(copy);
      db = copy;
      return result;
    },
    claimEvent: async (tx, eventId) => {
      if (tx.processed.has(eventId)) return false;
      tx.processed.add(eventId);
      return true;
    },
    memberEpoch: async (tx, mid) => tx.epochs.get(mid) ?? null,
    onEvent: async (tx, event) => {
      if (failNext) {
        failNext = false;
        throw new Error('uygulama hatası');
      }
      tx.applied.push(event);
      if (event.type === 'member.upserted' || event.type === 'member.removed') tx.epochs.set(event.membershipId, event.epoch);
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function post(token: unknown) {
  return app.inject({ method: 'POST', url: URL_PATH, payload: { token } });
}

describe('imzalı olay alıcısı', () => {
  it('geçerli olay işlenir', async () => {
    const event = memberEvent();
    const res = await post(await authority.eventToken(event));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, outcome: 'processed' });
    expect(db.applied).toEqual([event]);
  });

  it('yanlış imza 401, olay işlenmez', async () => {
    const res = await post(await authority.eventToken(memberEvent(), { foreignKey: true }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_EVENT');
    expect(db.applied).toEqual([]);
  });

  it('yanlış aud reddedilir: erişim jetonu olay yerine geçmez', async () => {
    const wrongAud = await post(await authority.eventToken(memberEvent(), { audience: 'sellerondata' }));
    expect(wrongAud.statusCode).toBe(401);
    const access = await post(await authority.accessToken());
    expect(access.statusCode).toBe(401);
    expect(db.applied).toEqual([]);
  });

  it('yanlış iss ve süresi dolmuş jeton reddedilir', async () => {
    expect((await post(await authority.eventToken(memberEvent(), { issuer: 'sahte' }))).statusCode).toBe(401);
    expect((await post(await authority.eventToken(memberEvent(), { expiresInSeconds: -120 }))).statusCode).toBe(401);
  });

  it('başka ürünün olayı reddedilir', async () => {
    const res = await post(await authority.eventToken(memberEvent({ product: 'orderloom' })));
    expect(res.statusCode).toBe(400);
    expect(db.applied).toEqual([]);
  });

  it('jti ile eventId uyuşmazsa reddedilir', async () => {
    const res = await post(await authority.eventToken(memberEvent(), { jti: 'baska' }));
    expect(res.statusCode).toBe(400);
  });

  it('token yoksa 400', async () => {
    expect((await post(undefined)).statusCode).toBe(400);
    expect((await post(123)).statusCode).toBe(400);
  });

  it('idempotens: aynı eventId iki kez uygulanmaz', async () => {
    const event = memberEvent();
    const first = await post(await authority.eventToken(event));
    const second = await post(await authority.eventToken(event));
    expect(first.json().outcome).toBe('processed');
    expect(second.statusCode).toBe(200);
    expect(second.json().outcome).toBe('duplicate');
    expect(db.applied).toHaveLength(1);
  });

  it('işlenemeyen olay işlendi sayılmaz, yeniden deneme uygular', async () => {
    const event = memberEvent();
    failNext = true;
    const first = await post(await authority.eventToken(event));
    expect(first.statusCode).toBe(500);
    expect(db.processed.has(event.eventId)).toBe(false);
    const retry = await post(await authority.eventToken(event));
    expect(retry.json().outcome).toBe('processed');
    expect(db.applied).toHaveLength(1);
  });

  it('epoch kuralı: küçük epoch uygulanmaz, eşit uygulanır', async () => {
    db.epochs.set('m-1', 5);
    const older = await post(await authority.eventToken(memberEvent({ epoch: 4 })));
    expect(older.json().outcome).toBe('stale');
    expect(db.applied).toHaveLength(0);
    const same = await post(await authority.eventToken(memberEvent({ epoch: 5, name: 'Yeni Ad' })));
    expect(same.json().outcome).toBe('processed');
    const newer = await post(await authority.eventToken(memberEvent({ epoch: 6 })));
    expect(newer.json().outcome).toBe('processed');
    expect(db.epochs.get('m-1')).toBe(6);
  });

  it('member.upserted.permissions: katalogla kesişir, katalog sırası; alansız olay alansız kalır', async () => {
    const custom = memberEvent({ role: 'custom:0193a1b2-0000-7000-8000-000000000001', permissions: ['deciship.prices.view', 'orderloom.orders.write', 'deciship.invoices.view', 'deciship.yok'] });
    expect((await post(await authority.eventToken(custom))).json().outcome).toBe('processed');
    expect(db.applied.at(-1)).toEqual({ ...custom, permissions: ['deciship.invoices.view', 'deciship.prices.view'] });
    const old = memberEvent({ epoch: 3 });
    await post(await authority.eventToken(old));
    expect(db.applied.at(-1)).toEqual(old);
    expect(db.applied.at(-1)).not.toHaveProperty('permissions');
    const empty = memberEvent({ epoch: 4, permissions: [] });
    await post(await authority.eventToken(empty));
    expect((db.applied.at(-1) as { permissions?: string[] }).permissions).toEqual([]);
  });

  it('rolsüz üye olayında izin listesi atılır; bozuk liste 400 INVALID_EVENT, işlenmez', async () => {
    const noRole = memberEvent({ role: null, active: true, permissions: ['deciship.invoices.view'] });
    await post(await authority.eventToken(noRole));
    expect(db.applied.at(-1)).not.toHaveProperty('permissions');
    for (const bad of ['deciship.invoices.view', [1, 2], null, { a: 1 }]) {
      const res = await post(await authority.eventToken(memberEvent({ epoch: 9, permissions: bad as unknown as string[] })));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_EVENT');
    }
    expect(db.applied).toHaveLength(1);
  });

  it('member.removed da epoch kuralına tabidir', async () => {
    db.epochs.set('m-1', 5);
    const event: PlatformEvent = {
      eventId: randomUUID(),
      type: 'member.removed',
      orgId: 'org-a',
      product: 'deciship',
      membershipId: 'm-1',
      epoch: 4,
    };
    expect((await post(await authority.eventToken(event))).json().outcome).toBe('stale');
  });

  it('bilinmeyen olay türü: 422 UNKNOWN_EVENT_TYPE, işaretlenmez, işlem açılmaz', async () => {
    const event = { eventId: randomUUID(), type: 'gelecek.olay', orgId: 'o', product: 'deciship' } as unknown as PlatformEvent;
    const res = await post(await authority.eventToken(event));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNKNOWN_EVENT_TYPE');
    expect(db.applied).toEqual([]);
    expect(db.processed.has(event.eventId)).toBe(false);
    expect(transactions).toBe(0);
    // ürün güncellenince aynı olay kimliği tanınan türle gelirse işlenir
    const known = memberEvent({ eventId: event.eventId });
    const retry = await post(await authority.eventToken(known));
    expect(retry.json()).toEqual({ ok: true, outcome: 'processed' });
  });

  it('firma kapatma olayları: biçim denetlenir, geçerli olay işlenir', async () => {
    const base = { orgId: 'org-a', product: 'deciship' };
    const closed = { eventId: randomUUID(), type: 'org.closed', ...base, closedAt: '2026-11-13T10:00:00.000Z', purgeAfter: '2026-12-13T10:00:00.000Z', version: 4 };
    const reopened = { eventId: randomUUID(), type: 'org.reopened', ...base, version: 5 };
    const purged = { eventId: randomUUID(), type: 'org.purged', ...base };
    for (const event of [closed, reopened, purged]) {
      const res = await post(await authority.eventToken(event as PlatformEvent));
      expect(res.json(), event.type).toEqual({ ok: true, outcome: 'processed' });
    }
    expect(db.applied.map((e) => e.type)).toEqual(['org.closed', 'org.reopened', 'org.purged']);
    // sürümsüz kapatma ya da geri açma sıralanamaz; bozuk an kabul edilmez
    const bad = [
      { ...closed, eventId: randomUUID(), version: undefined },
      { ...closed, eventId: randomUUID(), closedAt: 'dün' },
      { ...closed, eventId: randomUUID(), purgeAfter: undefined },
      { ...reopened, eventId: randomUUID(), version: -1 },
      { ...purged, eventId: randomUUID(), orgId: '' },
    ];
    for (const event of bad) {
      const res = await post(await authority.eventToken(event as unknown as PlatformEvent));
      expect(res.statusCode, JSON.stringify(event)).toBe(400);
    }
    expect(db.applied).toHaveLength(3);
  });

  it('imzası bozuk bilinmeyen tür imza hatası alır, 422 almaz', async () => {
    const event = { eventId: randomUUID(), type: 'gelecek.olay', orgId: 'o', product: 'deciship' } as unknown as PlatformEvent;
    const res = await post(await authority.eventToken(event, { foreignKey: true }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_EVENT');
    expect(transactions).toBe(0);
  });

  it('Hesap servisinin ürettiği her olay türü alıcıda tanınır', () => {
    const libDir = fileURLToPath(new URL('../../../apps/account-api/src/lib/', import.meta.url));
    const produced = new Set<string>();
    for (const f of readdirSync(libDir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(libDir + f, 'utf8');
      for (const m of src.matchAll(/type:\s*'((?:member|org|subscription)\.[a-z]+)'/g)) produced.add(m[1]!);
    }
    expect(produced.size).toBeGreaterThanOrEqual(4);
    for (const type of produced) expect(KNOWN_EVENT_TYPES.has(type), type).toBe(true);
    // sözleşmedeki her tür de tanınır (PlatformEvent'e tür eklenirse bu satır derlenmez)
    const contract: Record<PlatformEventType, true> = {
      'member.upserted': true,
      'member.removed': true,
      'org.updated': true,
      'org.closed': true,
      'org.reopened': true,
      'org.purged': true,
      'subscription.updated': true,
    };
    for (const type of Object.keys(contract)) expect(KNOWN_EVENT_TYPES.has(type), type).toBe(true);
  });

  it('Hesap kesikken bilinmeyen anahtar: 503, dağıtıcı yeniden dener', async () => {
    authority.setOffline(true);
    const res = await post(await authority.eventToken(memberEvent()));
    expect(res.statusCode).toBe(503);
  });
});
