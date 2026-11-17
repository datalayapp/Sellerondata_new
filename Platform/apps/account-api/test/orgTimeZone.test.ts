/**
 * Firma saat dilimi ve dili (Mesaj 15 §4.1): alan, PATCH /org, GET /org, /me ve `org.updated` olayı.
 * Varsayılan saat dilimi (göçün yazdığı değer) yalnız gerçekten söylendiğinde olaya girer: firma açılışı ve saat dilimini
 * değiştiren PATCH. Yeniden duyurular varsayılanı göndermez, araçtaki değer ezilmez (`orgUpdatedEvent`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ORG_TIME_ZONE, TIME_ZONES } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { announceAllOrgs } from '../src/lib/orgs.ts';
import { orgUpdatedEvent } from '../src/lib/outbox.ts';
import { announceMembers } from '../src/lib/subscriptions.ts';
import { API, addMember, getApp, lastMailTo, randomEmail, registerOrg, type Ctx, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

type Payload = { type: string; name: string; currency?: string; country?: string; timeZone?: string; version: number };

async function orgEvents(orgId: string) {
  const rows = await prisma.outbox.findMany({ where: { orgId, type: 'org.updated' } });
  return rows.map((r) => r.payload as Payload).sort((a, b) => a.version - b.version);
}

async function patchOrg(who: Ctx, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(who), payload });
}

const storedOrg = (orgId: string) => prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

describe('firma açılışı', () => {
  it.each([
    ['TR', 'Europe/Istanbul'],
    ['US', 'America/New_York'],
    ['DE', 'Europe/Berlin'],
    ['GB', 'Europe/London'],
    ['FR', 'Europe/Paris'],
    ['NL', 'Europe/Amsterdam'],
  ])('kayıtta ülke %s: saat dilimi %s, ilk olay saat dilimini taşır', async (country, zone) => {
    const owner = await registerOrg(app, { country });
    expect((await storedOrg(owner.orgId)).timeZone).toBe(zone);
    expect((await orgEvents(owner.orgId))[0]).toMatchObject({ country, timeZone: zone, version: 1 });
  });

  it('varsayılan saat dilimli (TR) firmanın ilk olayı da saat dilimini söyler', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    expect((await orgEvents(owner.orgId))[0]).toHaveProperty('timeZone', DEFAULT_ORG_TIME_ZONE);
  });

  it('sonradan açılan firma (POST /orgs) ülkesinin saat dilimiyle açılır', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: owner.headers, payload: { name: 'Londra Şubesi', country: 'GB' } });
    expect(res.statusCode).toBe(201);
    const second = await prisma.organization.findFirstOrThrow({ where: { name: 'Londra Şubesi', memberships: { some: { personId: owner.personId } } } });
    expect(second.timeZone).toBe('Europe/London');
    expect((await orgEvents(second.id))[0]).toMatchObject({ timeZone: 'Europe/London', version: 1 });
  });
});

describe('GET /org, PATCH /org ve /me', () => {
  it('GET /org ve /me saat dilimini ve firma dilini verir', async () => {
    const owner = await registerOrg(app, { country: 'US' });
    const org = (await app.inject({ url: `${API}/org`, headers: owner.headers })).json();
    expect(org).toMatchObject({ timeZone: 'America/New_York', locale: 'tr' });
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.activeOrg).toMatchObject({ id: owner.orgId, timeZone: 'America/New_York', locale: 'tr' });
  });

  it('PATCH saat dilimi: yanıt ve GET yeni değeri verir, olay gider, sürüm artar', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    const res = await patchOrg(owner, { timeZone: 'Asia/Tokyo' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: owner.orgId, timeZone: 'Asia/Tokyo', locale: 'tr', country: 'TR', currency: 'TRY' });
    expect((await app.inject({ url: `${API}/org`, headers: owner.headers })).json().timeZone).toBe('Asia/Tokyo');
    expect((await app.inject({ url: `${API}/me`, headers: owner.headers })).json().activeOrg.timeZone).toBe('Asia/Tokyo');
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ timeZone: 'Asia/Tokyo', country: 'TR', currency: 'TRY', version: 2 });
    expect((await storedOrg(owner.orgId)).version).toBe(2);
  });

  it('varsayılana dönüş de söylenir: olay varsayılan saat dilimini taşır', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await patchOrg(owner, { timeZone: 'UTC' });
    await patchOrg(owner, { timeZone: DEFAULT_ORG_TIME_ZONE });
    const events = await orgEvents(owner.orgId);
    expect(events.map((e) => [e.version, e.timeZone])).toEqual([
      [1, DEFAULT_ORG_TIME_ZONE],
      [2, 'UTC'],
      [3, DEFAULT_ORG_TIME_ZONE],
    ]);
  });

  it('değişmeyen saat dilimi olay üretmez, sürüm artmaz', async () => {
    const owner = await registerOrg(app, { country: 'US' });
    expect((await patchOrg(owner, { timeZone: 'America/New_York' })).statusCode).toBe(200);
    expect(await orgEvents(owner.orgId)).toHaveLength(1);
    expect((await storedOrg(owner.orgId)).version).toBe(1);
  });

  it('başka alan değişince olay güncel saat dilimini taşır; varsayılan saat dilimi söylenmez', async () => {
    const us = await registerOrg(app, { country: 'US' });
    await patchOrg(us, { name: 'Yeni Ad' });
    expect((await orgEvents(us.orgId)).at(-1)).toMatchObject({ name: 'Yeni Ad', timeZone: 'America/New_York', version: 2 });

    const tr = await registerOrg(app, { country: 'TR' });
    await patchOrg(tr, { name: 'Yeni Ad' });
    const last = (await orgEvents(tr.orgId)).at(-1)!;
    expect(last).toMatchObject({ name: 'Yeni Ad', version: 2 });
    expect(last).not.toHaveProperty('timeZone');
  });

  it('ülke değişimi saat dilimini değiştirmez (öneri ekranın işi)', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await patchOrg(owner, { country: 'US' });
    expect((await storedOrg(owner.orgId)).timeZone).toBe(DEFAULT_ORG_TIME_ZONE);
  });

  it('ülke ve saat dilimi birlikte: tek olay, tek sürüm', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await patchOrg(owner, { country: 'DE', timeZone: 'Europe/Berlin' });
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ country: 'DE', timeZone: 'Europe/Berlin', version: 2 });
  });

  it.each(['Mars/Olympus', 'Asia/Kolkata', 'europe/istanbul', '+03:00', '', 12, null])('geçersiz saat dilimi %s: 400 VALIDATION, değer ve sürüm değişmez', async (timeZone) => {
    const owner = await registerOrg(app, { country: 'TR' });
    const res = await patchOrg(owner, { timeZone });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    const org = await storedOrg(owner.orgId);
    expect(org.timeZone).toBe(DEFAULT_ORG_TIME_ZONE);
    expect(org.version).toBe(1);
  });

  it('listedeki her saat dilimi kabul edilir', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    for (const zone of TIME_ZONES) {
      const res = await patchOrg(owner, { timeZone: zone });
      expect(res.statusCode, zone).toBe(200);
      expect(res.json().timeZone).toBe(zone);
    }
  });

  it('yetki değişmez: üye yazamaz (403), yönetici yazar', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    expect((await patchOrg(member, { timeZone: 'UTC' })).statusCode).toBe(403);
    expect((await storedOrg(owner.orgId)).timeZone).toBe(DEFAULT_ORG_TIME_ZONE);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    expect((await patchOrg(admin, { timeZone: 'UTC' })).statusCode).toBe(200);
    expect((await storedOrg(owner.orgId)).timeZone).toBe('UTC');
  });

  it('dil değişimi olay üretmez; saat dilimiyle birlikte gelince tek olay', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    expect((await patchOrg(owner, { locale: 'en' })).json().locale).toBe('en');
    expect(await orgEvents(owner.orgId)).toHaveLength(1);
    expect((await app.inject({ url: `${API}/me`, headers: owner.headers })).json().activeOrg.locale).toBe('en');
    await patchOrg(owner, { locale: 'tr', timeZone: 'Europe/London' });
    const events = await orgEvents(owner.orgId);
    expect(events).toHaveLength(2);
    expect(events[1]).not.toHaveProperty('locale');
  });

  it('eşzamanlı saat dilimi değişiminde sürümler tekrarlanmaz, en büyük sürüm veritabanındaki değeri taşır', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await Promise.all([
      patchOrg(owner, { timeZone: 'UTC' }),
      patchOrg(owner, { timeZone: 'Asia/Tokyo' }),
      patchOrg(owner, { name: 'Saatli Ad' }),
      patchOrg(owner, { timeZone: 'Europe/London' }),
    ]);
    const events = await orgEvents(owner.orgId);
    expect(new Set(events.map((e) => e.version)).size).toBe(events.length);
    const org = await storedOrg(owner.orgId);
    expect(events.at(-1)).toMatchObject({ name: org.name, version: org.version });
    // Son olay saat dilimini taşıyorsa veritabanındakini taşır; varsayılan değilse taşımak zorundadır.
    expect(org.timeZone).not.toBe(DEFAULT_ORG_TIME_ZONE);
    expect(events.at(-1)!.timeZone).toBe(org.timeZone);
  });
});

describe('firma dili davet postasında', () => {
  it('firma dili değişince davet postası yeni dille gider', async () => {
    const owner = await registerOrg(app, { country: 'TR' });
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const invite = async (email: string) =>
      app.inject({ method: 'POST', url: `${API}/org/members/invite`, headers: await asWeb(owner), payload: { kind: 'EMAIL', email, name: 'Davetli' } });

    const trMail = randomEmail('davetli');
    expect((await invite(trMail)).json().mailSent).toBe(true);
    expect((await lastMailTo(trMail))?.subject).toBe('SellerOnData üzerinde bir firmaya davet edildiniz');

    expect((await patchOrg(owner, { locale: 'en' })).statusCode).toBe(200);
    const enMail = randomEmail('davetli');
    expect((await invite(enMail)).json().mailSent).toBe(true);
    const en = await lastMailTo(enMail);
    expect(en?.template).toBe('invitation');
    expect(en?.subject).not.toBe('SellerOnData üzerinde bir firmaya davet edildiniz');
    expect(en?.body).toContain('invited you to join');
  });
});

describe('yeniden duyurular varsayılan saat dilimini göndermez', () => {
  it('org:announce: varsayılan saat dilimli firma alansız gider, seçilmiş saat dilimi gider', async () => {
    const tr = await registerOrg(app, { country: 'TR' });
    const us = await registerOrg(app, { country: 'US' });
    await announceAllOrgs();
    const trLast = (await orgEvents(tr.orgId)).at(-1)!;
    expect(trLast.version).toBe(2);
    expect(trLast).not.toHaveProperty('timeZone');
    expect((await orgEvents(us.orgId)).at(-1)).toMatchObject({ timeZone: 'America/New_York', version: 2 });
  });

  it('members:announce: sürüm artmaz; varsayılan saat dilimi gitmez, seçilmiş saat dilimi gider', async () => {
    const tr = await registerOrg(app, { country: 'TR' });
    await announceMembers('deciship', { orgId: tr.orgId });
    // Açılış olayı ve duyuru aynı sürümde (1); yalnız açılış saat dilimini söyler.
    const trEvents = await orgEvents(tr.orgId);
    expect(trEvents.map((e) => e.version)).toEqual([1, 1]);
    expect(trEvents.filter((e) => e.timeZone === undefined)).toHaveLength(1);
    expect(trEvents.filter((e) => e.timeZone === DEFAULT_ORG_TIME_ZONE)).toHaveLength(1);

    const tokyo = await registerOrg(app, { country: 'TR' });
    await patchOrg(tokyo, { timeZone: 'Asia/Tokyo' });
    await announceMembers('deciship', { orgId: tokyo.orgId });
    expect((await orgEvents(tokyo.orgId)).at(-1)).toMatchObject({ timeZone: 'Asia/Tokyo', version: 2 });
  });

  it('göçten kalan firma (varsayılan saat dilimi) ad değişiminde saat dilimi söylemez', async () => {
    const owner = await registerOrg(app, { country: 'US' });
    // Göç öncesi firma: ülke US, saat dilimi göçün varsayılanı.
    await prisma.organization.update({ where: { id: owner.orgId }, data: { timeZone: DEFAULT_ORG_TIME_ZONE } });
    await patchOrg(owner, { name: 'Göçten Kalan' });
    const last = (await orgEvents(owner.orgId)).at(-1)!;
    expect(last).toMatchObject({ name: 'Göçten Kalan', country: 'US' });
    expect(last).not.toHaveProperty('timeZone');
  });

  it('orgUpdatedEvent: listede olmayan kayıtlı değer gönderilmez', () => {
    const base = { id: 'o', name: 'F', country: 'TR', currency: 'TRY' as const, companyConfirmedAt: null, version: 3 };
    expect(orgUpdatedEvent({ ...base, timeZone: 'Asia/Tokyo' }, 'deciship')).toMatchObject({ timeZone: 'Asia/Tokyo', version: 3 });
    expect(orgUpdatedEvent({ ...base, timeZone: DEFAULT_ORG_TIME_ZONE }, 'deciship')).not.toHaveProperty('timeZone');
    expect(orgUpdatedEvent({ ...base, timeZone: DEFAULT_ORG_TIME_ZONE }, 'deciship', { sayTimeZone: true })).toHaveProperty('timeZone', DEFAULT_ORG_TIME_ZONE);
    expect(orgUpdatedEvent({ ...base, timeZone: 'Mars/Olympus' }, 'deciship', { sayTimeZone: true })).not.toHaveProperty('timeZone');
  });
});
