import crypto from 'node:crypto';
import { runEpochRaceCheck } from '@sellerondata/auth-kit/testing';
import type { FastifyInstance } from 'fastify';
import type { PlatformEvent } from '@sellerondata/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { loadMemberAccess, memberPermissions } from '../src/lib/access.ts';
import { getApp, getAuthority, issueIdentity, registerCompany, sendEvent } from './helpers.ts';

const memberRow = (companyId: string, id: string) => withCompany(companyId, () => prisma.member.findFirst({ where: { id } }));
/** `Member.permissions` ham SQL ile okunur: Prisma liste alanında NULL ile boş listeyi ayırmaz (şemada `String[]`). */
const accessRow = async (companyId: string, id: string) => (await withCompany(companyId, () => loadMemberAccess(companyId, [id])))[0];
const CUSTOM = 'custom:0193a1b2-0000-7000-8000-00000000c0de';

function upserted(orgId: string, membershipId: string, over: Partial<Extract<PlatformEvent, { type: 'member.upserted' }>> = {}): PlatformEvent {
  return {
    eventId: crypto.randomUUID(),
    type: 'member.upserted',
    orgId,
    product: 'deciship',
    membershipId,
    personId: 'kisi-1',
    name: 'Olay Kişi',
    orgRole: 'MEMBER',
    role: 'AUDITOR',
    active: true,
    epoch: 1,
    ...over,
  };
}

function removed(orgId: string, membershipId: string, epoch: number, over: Partial<Extract<PlatformEvent, { type: 'member.removed' }>> = {}): PlatformEvent {
  return { eventId: crypto.randomUUID(), type: 'member.removed', orgId, product: 'deciship', membershipId, epoch, ...over };
}

function orgUpdated(orgId: string, name: string, version?: number): PlatformEvent {
  return { eventId: crypto.randomUUID(), type: 'org.updated', orgId, product: 'deciship', name, ...(version === undefined ? {} : { version }) };
}

describe('olay alıcısı: doğrulama', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('imza, hedef, süre, ürün, kimlik eşleşmesi: geçersiz olay işlenmez', async () => {
    const authority = await getAuthority();
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const post = (token: unknown) => app.inject({ method: 'POST', url: '/api/deciship/internal/events', payload: { token } as object });
    const event = upserted(orgId, mid);

    expect((await post(await authority.eventToken(event, { foreignKey: true }))).statusCode).toBe(401);
    expect((await post(await authority.eventToken(event, { audience: 'sellerondata' }))).statusCode).toBe(401);
    expect((await post(await authority.eventToken(event, { expiresInSeconds: -300 }))).statusCode).toBe(401);
    // erişim jetonu olay yerine geçmez
    expect((await post(await authority.accessToken({ orgId, membershipId: mid }))).statusCode).toBe(401);
    expect((await post(await authority.eventToken(event, { jti: crypto.randomUUID() }))).statusCode).toBe(400);
    expect((await post(await authority.eventToken({ ...event, product: 'orderloom' }))).statusCode).toBe(400);
    expect((await post('')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/deciship/internal/events', payload: {} })).statusCode).toBe(400);

    expect(await memberRow(orgId, mid)).toBeNull();
  });

  it('aynı olay ikinci kez işlenmez; bilinmeyen tür 422 alır ve işaretlenmez', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const event = upserted(orgId, mid, { name: 'İlk' });
    expect((await sendEvent(app, event)).json()).toEqual({ ok: true, outcome: 'processed' });
    await withCompany(orgId, () => prisma.member.update({ where: { id: mid }, data: { name: 'Sonradan' } }));
    expect((await sendEvent(app, event)).json()).toEqual({ ok: true, outcome: 'duplicate' });
    expect((await memberRow(orgId, mid))!.name).toBe('Sonradan');
    const unknown = { eventId: crypto.randomUUID(), type: 'yeni.olay', orgId, product: 'deciship' } as unknown as PlatformEvent;
    for (let i = 0; i < 2; i++) {
      const res = await sendEvent(app, unknown);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('UNKNOWN_EVENT_TYPE');
    }
    expect(await prisma.processedEvent.count({ where: { eventId: unknown.eventId } })).toBe(0);
  });

  it('işlenemeyen olay işlendi sayılmaz: işlem geri alınır, yeniden denenince uygulanır', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    // personId alanına NUL: Postgres reddeder
    const bad = upserted(orgId, mid, { personId: 'a\u0000b' });
    const first = await sendEvent(app, bad);
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(await memberRow(orgId, mid)).toBeNull();
    const fixed = await sendEvent(app, { ...bad, personId: 'kisi-1' } as PlatformEvent);
    expect(fixed.json()).toEqual({ ok: true, outcome: 'processed' });
  });
});

describe('olay alıcısı: uygulama (FORCE RLS altında)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('member.upserted: bilinmeyen firma ve üye açılır, sonraki olay günceller; firma adı jetondan tamamlanır', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    expect((await sendEvent(app, upserted(orgId, mid, { epoch: 3 }))).json().outcome).toBe('processed');
    expect(await memberRow(orgId, mid)).toMatchObject({ companyId: orgId, personId: 'kisi-1', name: 'Olay Kişi', role: 'AUDITOR', active: true, epoch: 3 });
    const company = await withCompany(orgId, () => prisma.company.findFirstOrThrow({ where: { id: orgId } }));
    expect(company.name).toBe('');
    expect(await withCompany(orgId, () => prisma.boxPreset.count())).toBe(3);

    expect((await sendEvent(app, upserted(orgId, mid, { epoch: 4, name: 'Yeni Ad', role: 'ACCOUNTING' }))).json().outcome).toBe('processed');
    expect(await memberRow(orgId, mid)).toMatchObject({ name: 'Yeni Ad', role: 'ACCOUNTING', epoch: 4 });
    // ad değişikliği epoch artırmaz: eşit epoch uygulanır
    expect((await sendEvent(app, upserted(orgId, mid, { epoch: 4, name: 'Bir Daha', role: 'ACCOUNTING' }))).json().outcome).toBe('processed');
    expect((await memberRow(orgId, mid))!.name).toBe('Bir Daha');

    const member = await issueIdentity({ companyId: orgId, orgName: 'Jetondaki Ad', userId: mid, role: 'ACCOUNTING', epoch: 4 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: member.auth })).json().company.name).toBe('Jetondaki Ad');
  });

  it('askı olayı gerçekten uygulanır; eski olay yeni durumu ezmez', async () => {
    const admin = await registerCompany(app);
    const m = await issueIdentity({ companyId: admin.companyId, role: 'AUDITOR', epoch: 5 });
    await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });

    const suspend = upserted(admin.companyId, m.userId, { active: false, epoch: 7, role: 'AUDITOR' });
    expect((await sendEvent(app, suspend)).json().outcome).toBe('processed');
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ active: false, epoch: 7 });

    // geç gelen ep6 rol değişimi
    const old = upserted(admin.companyId, m.userId, { active: true, epoch: 6, role: 'ADMIN' });
    expect((await sendEvent(app, old)).json().outcome).toBe('stale');
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ active: false, epoch: 7, role: 'AUDITOR' });

    // eski jeton yenilemeye zorlanır; aynı epoch'lu jeton pasif üyeyi açmaz
    const stale = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('TOKEN_STALE');
    const same = await m.token({ epoch: 7 });
    const blocked = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: same.auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('FORBIDDEN');
  });

  it('member.removed: tanınmayan üyeye pasif kayıt açılır, eski jeton JIT ile üyeyi geri açamaz', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const res = await sendEvent(app, removed(orgId, mid, 4, { personId: 'kisi-9', name: 'Çıkan' }));
    expect(res.json().outcome).toBe('processed');
    expect(await memberRow(orgId, mid)).toMatchObject({ active: false, epoch: 4, role: null, personId: 'kisi-9', name: 'Çıkan' });

    const late = await issueIdentity({ companyId: orgId, userId: mid, role: 'ADMIN', epoch: 3 });
    const r = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: late.auth });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('TOKEN_STALE');
    expect((await memberRow(orgId, mid))!.active).toBe(false);
  });

  it('org.updated: adı günceller; eski olay yeni adı ezmez, sırası bozuk gelse de son ad kalır', async () => {
    const admin = await registerCompany(app, 'İlk Ad');
    const name = () => withCompany(admin.companyId, async () => (await prisma.company.findFirstOrThrow({ where: { id: admin.companyId } })).name);

    await sendEvent(app, orgUpdated(admin.companyId, 'Yeni Ad', 10));
    expect(await name()).toBe('Yeni Ad');
    const late = await sendEvent(app, orgUpdated(admin.companyId, 'Eski Ad', 5));
    expect(late.json()).toEqual({ ok: true, outcome: 'stale' });
    expect(await name()).toBe('Yeni Ad');
    // sürümsüz olay sıralanamaz: sürümlü adı ezmez
    await sendEvent(app, orgUpdated(admin.companyId, 'Sürümsüz'));
    expect(await name()).toBe('Yeni Ad');
    await sendEvent(app, orgUpdated(admin.companyId, 'Daha Yeni', 20));
    expect(await name()).toBe('Daha Yeni');
    // paralel gelenler: en yeni kazanır
    await Promise.all([30, 35, 40, 32, 38].map((v) => sendEvent(app, orgUpdated(admin.companyId, `Ad ${v}`, v))));
    expect(await name()).toBe('Ad 40');
    // firma adı tanınmayan firma için de açılır
    const fresh = crypto.randomUUID();
    await sendEvent(app, orgUpdated(fresh, 'Olayla Açıldı'));
    expect((await withCompany(fresh, () => prisma.company.findFirstOrThrow({ where: { id: fresh } }))).name).toBe('Olayla Açıldı');
    expect(await withCompany(fresh, () => prisma.boxPreset.count())).toBe(3);
  });

  it('subscription.updated: yerelde durum yok, işlenir; READ_ONLY jetondan gelir', async () => {
    const admin = await registerCompany(app);
    const res = await sendEvent(app, { eventId: crypto.randomUUID(), type: 'subscription.updated', orgId: admin.companyId, product: 'deciship', status: 'READ_ONLY', plan: 'early_access' });
    expect(res.json().outcome).toBe('processed');
    expect((await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: admin.auth, payload: { desiDivisor: 3100 } })).statusCode).toBe(200);
    const readOnly = await admin.token({ status: 'READ_ONLY' });
    const r = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: readOnly.auth, payload: { desiDivisor: 3200 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('READ_ONLY');
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: readOnly.auth })).statusCode).toBe(200);
  });
});

describe('özel roller: member.upserted.permissions ve Member.permissions', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('olaydaki liste katalogla kesişip katalog sırasıyla yazılır; eski biçim olay, rolsüz olay ve çıkarma NULL yazar', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const perms = ['deciship.prices.view', 'orderloom.orders.write', 'deciship.measurements.capture', 'deciship.uydurma', 'deciship.invoices.view'];
    expect((await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: perms, epoch: 2 }))).json().outcome).toBe('processed');
    const custom = await accessRow(orgId, mid);
    expect(custom).toMatchObject({ role: CUSTOM, permissions: ['deciship.invoices.view', 'deciship.measurements.capture', 'deciship.prices.view'], epoch: 2 });
    expect(memberPermissions(custom!)).toEqual(['deciship.invoices.view', 'deciship.measurements.capture', 'deciship.prices.view']);

    // eski biçim olay (alan yok): NULL, izinler rolden
    await sendEvent(app, upserted(orgId, mid, { role: 'MEASURE', epoch: 3 }));
    const old = await accessRow(orgId, mid);
    expect(old).toMatchObject({ role: 'MEASURE', permissions: null });
    expect(memberPermissions(old!)).toEqual(['deciship.measurements.capture']);

    // boş liste NULL değildir: hiçbir izin
    await sendEvent(app, upserted(orgId, mid, { role: 'ADMIN', permissions: [], epoch: 4 }));
    const empty = await accessRow(orgId, mid);
    expect(empty).toMatchObject({ role: 'ADMIN', permissions: [] });
    expect(memberPermissions(empty!)).toEqual([]);

    // rolsüz olay listeyi taşımaz
    await sendEvent(app, upserted(orgId, mid, { role: null, permissions: ['deciship.prices.view'], epoch: 5 }));
    expect(await accessRow(orgId, mid)).toMatchObject({ role: null, permissions: null });
    expect(memberPermissions((await accessRow(orgId, mid))!)).toEqual([]);

    await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.reports.view'], epoch: 6 }));
    await sendEvent(app, removed(orgId, mid, 7));
    expect(await accessRow(orgId, mid)).toMatchObject({ role: null, permissions: null, active: false });
  });

  it('eski olay yeni listeyi ezmez (rol ve liste birlikte, epoch sırası)', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.measurements.capture'], epoch: 5 }));
    const late = await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.invoices.view', 'deciship.prices.view'], epoch: 4 }));
    expect(late.json().outcome).toBe('stale');
    expect(await accessRow(orgId, mid)).toMatchObject({ permissions: ['deciship.measurements.capture'], epoch: 5 });
    // eşit epoch uygulanır (ad değişikliği gibi): Hesap rol düzenlemesinde epoch'u artırır
    await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.measurements.view_all'], epoch: 5 }));
    expect(await accessRow(orgId, mid)).toMatchObject({ permissions: ['deciship.measurements.view_all'] });
  });

  it('JIT ve jeton eşitlemesi listeyi jetondan yazar; eski biçim jeton NULL yazar; istekte yetki jetondaki listeden', async () => {
    const admin = await registerCompany(app);
    const m = await issueIdentity({ companyId: admin.companyId, role: CUSTOM, perms: ['deciship.measurements.capture', 'yabanci.izin'], epoch: 2 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })).statusCode).toBe(200);
    expect(await accessRow(admin.companyId, m.userId)).toMatchObject({ role: CUSTOM, permissions: ['deciship.measurements.capture'], epoch: 2 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: m.auth })).statusCode).toBe(403);

    // rol düzenlendi (epoch 3): yeni jeton kaydı eşitler, fatura listesi açılır
    const edited = await m.token({ epoch: 3, perms: ['deciship.invoices.view', 'deciship.prices.view'] });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: edited.auth })).statusCode).toBe(200);
    expect(await accessRow(admin.companyId, m.userId)).toMatchObject({ permissions: ['deciship.invoices.view', 'deciship.prices.view'], epoch: 3 });
    // eski jeton bayattır
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })).json().error.code).toBe('TOKEN_STALE');

    // eski biçim jetonla JIT: Prisma ile açılan satırda liste NULL kalır (boş liste değil)
    const plain = await issueIdentity({ companyId: admin.companyId, role: 'ACCOUNTING', epoch: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: plain.auth })).statusCode).toBe(200);
    expect(await accessRow(admin.companyId, plain.userId)).toMatchObject({ role: 'ACCOUNTING', permissions: null });

    // bozuk jeton (perms: null): boş liste yazılır, rol varsayılanına dönmez
    const broken = await issueIdentity({ companyId: admin.companyId, role: 'ADMIN', epoch: 1 });
    const brokenToken = await broken.token({ prod: { deciship: { role: 'ADMIN', perms: null as unknown as string[], status: 'ACTIVE', plan: 'early_access' } } });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: brokenToken.auth })).statusCode).toBe(403);
    expect(await accessRow(admin.companyId, broken.userId)).toMatchObject({ role: 'ADMIN', permissions: [] });

    // hazır role dönüş, eski biçim jeton: NULL
    const builtin = await issueIdentity({ companyId: admin.companyId, userId: m.userId, personId: m.personId, role: 'AUDITOR', epoch: 4 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: builtin.auth })).statusCode).toBe(200);
    expect(await accessRow(admin.companyId, m.userId)).toMatchObject({ role: 'AUDITOR', permissions: null, epoch: 4 });

    // olay daha yeni listeyi yazdıysa eski jeton ona dokunmaz
    await sendEvent(app, upserted(admin.companyId, m.userId, { role: CUSTOM, permissions: ['deciship.reports.view'], epoch: 9 }));
    const older = await m.token({ epoch: 8, perms: ['deciship.invoices.view', 'deciship.prices.view'] });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: older.auth })).statusCode).toBe(401);
    expect(await accessRow(admin.companyId, m.userId)).toMatchObject({ permissions: ['deciship.reports.view'], epoch: 9 });
  });

  it('liste değişimi ep6 + askı ep7 paralel: son liste ep7 olayınınki (10 tur, iki sıra)', async () => {
    for (let round = 0; round < 10; round++) {
      const orgId = crypto.randomUUID();
      const mid = crypto.randomUUID();
      await sendEvent(app, upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.measurements.capture'], epoch: 5 }));
      const widen = upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.invoices.view', 'deciship.prices.view'], epoch: 6 });
      const suspend = upserted(orgId, mid, { role: CUSTOM, permissions: ['deciship.reports.view'], epoch: 7, active: false });
      const events = round % 2 ? [widen, suspend] : [suspend, widen];
      for (const r of await Promise.all(events.map((e) => sendEvent(app, e)))) expect(r.statusCode, r.body).toBe(200);
      expect(await accessRow(orgId, mid), `tur ${round}`).toMatchObject({ epoch: 7, active: false, permissions: ['deciship.reports.view'] });
    }
  }, 60_000);
});

describe('olay yarışları (gerçek Postgres, paralel)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('rol değişimi ep6 + askı ep7 paralel: son durum daima ep7 pasif (20 tur, iki sıra)', async () => {
    for (let round = 0; round < 20; round++) {
      const admin = await registerCompany(app);
      const m = await issueIdentity({ companyId: admin.companyId, role: 'AUDITOR', epoch: 5 });
      // tek turlarda üye önceden yok: ilk ekleme de yarışır
      if (round % 2 === 0) await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });
      const roleChange = upserted(admin.companyId, m.userId, { epoch: 6, role: 'ADMIN', active: true });
      const suspend = upserted(admin.companyId, m.userId, { epoch: 7, role: 'AUDITOR', active: false });
      const events = round % 4 < 2 ? [roleChange, suspend] : [suspend, roleChange];
      const results = await Promise.all(events.map((e) => sendEvent(app, e)));
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      expect(await memberRow(admin.companyId, m.userId), `tur ${round}`).toMatchObject({ epoch: 7, active: false, role: 'AUDITOR' });
    }
  }, 120_000);

  it('auth-kit runEpochRaceCheck: gerçek Postgres, FORCE RLS altında sıfır hata', async () => {
    const admin = await registerCompany(app);
    const authority = await getAuthority();
    const orgId = admin.companyId;
    const result = await runEpochRaceCheck({
      app,
      authority,
      orgId,
      rounds: 30,
      seedMember: async (id, epoch) => {
        await withCompany(orgId, () => prisma.member.create({ data: { id, companyId: orgId, personId: 'yaris-kisi', name: 'Yarış', role: 'AUDITOR', epoch } }));
      },
      readMember: (id) => withCompany(orgId, () => prisma.member.findFirstOrThrow({ where: { id }, select: { epoch: true, active: true } })),
    });
    expect(result).toEqual({ rounds: 30, wrong: 0 });
  }, 120_000);

  it('olay ve eş zamanlı jeton eşitlemesi (sync) askıyı geri almaz', async () => {
    for (let round = 0; round < 10; round++) {
      const admin = await registerCompany(app);
      const m = await issueIdentity({ companyId: admin.companyId, role: 'AUDITOR', epoch: 5 });
      await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });
      const newer = await m.token({ epoch: 6 });
      await Promise.all([
        sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 7, active: false })),
        app.inject({ method: 'GET', url: '/api/deciship/me', headers: newer.auth }),
      ]);
      expect(await memberRow(admin.companyId, m.userId), `tur ${round}`).toMatchObject({ epoch: 7, active: false });
    }
  }, 60_000);

  it('aynı olay aynı anda iki kez: tek uygulanır', async () => {
    const orgId = crypto.randomUUID();
    const mid = crypto.randomUUID();
    const event = upserted(orgId, mid);
    const results = await Promise.all(Array.from({ length: 6 }, () => sendEvent(app, event)));
    expect(results.map((r) => r.json().outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed']);
  });
});

describe('JIT ve epoch', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('JIT yarışı: yeni firmaya aynı anda 30 istek. Hepsi 200, tek firma, üç koli, tek üye', async () => {
    for (let round = 0; round < 5; round++) {
      const m = await issueIdentity({ orgName: 'Yarış Firması', role: 'ADMIN', epoch: 2 });
      const results = await Promise.all(Array.from({ length: 30 }, () => app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })));
      expect(results.map((r) => r.statusCode).filter((s) => s !== 200)).toEqual([]);
      const counts = await withCompany(m.companyId, async () => ({
        companies: await prisma.company.count(),
        members: await prisma.member.count(),
        presets: await prisma.boxPreset.count(),
      }));
      expect(counts).toEqual({ companies: 1, members: 1, presets: 3 });
    }
  }, 60_000);

  it('aynı firmaya farklı üyeler ve olay aynı anda: koliler iki kez eklenmez', async () => {
    const orgId = crypto.randomUUID();
    const a = await issueIdentity({ companyId: orgId, role: 'ADMIN' });
    const b = await issueIdentity({ companyId: orgId, role: 'MEASURE' });
    const mid = crypto.randomUUID();
    const results = await Promise.all([
      app.inject({ method: 'GET', url: '/api/deciship/me', headers: a.auth }),
      app.inject({ method: 'GET', url: '/api/deciship/me', headers: b.auth }),
      sendEvent(app, upserted(orgId, mid)),
      sendEvent(app, orgUpdated(orgId, 'Olaydan')),
    ]);
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(await withCompany(orgId, async () => ({ m: await prisma.member.count(), p: await prisma.boxPreset.count() }))).toEqual({ m: 3, p: 3 });
  });

  it('JIT var olan satırı ezmez: olay daha yüksek epoch yazdıysa eski jeton TOKEN_STALE alır', async () => {
    const orgId = crypto.randomUUID();
    const m = await issueIdentity({ companyId: orgId, role: 'ADMIN', epoch: 1 });
    await sendEvent(app, upserted(orgId, m.userId, { epoch: 9, role: 'MEASURE' }));
    const r = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('TOKEN_STALE');
    expect(await memberRow(orgId, m.userId)).toMatchObject({ epoch: 9, role: 'MEASURE' });
  });

  it('eski epoch 401 TOKEN_STALE; yeni jeton yerel kaydı eşitler; askıdan sonra basılan jeton pasif kaydı açar', async () => {
    const admin = await registerCompany(app);
    const m = await issueIdentity({ companyId: admin.companyId, role: 'AUDITOR', epoch: 3, name: 'Eski Ad' });
    await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth });

    const older = await m.token({ epoch: 2 });
    const stale = await app.inject({ method: 'GET', url: '/api/deciship/dashboard', headers: older.auth });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toMatchObject({ code: 'TOKEN_STALE' });

    const newer = await m.token({ epoch: 8, role: 'ACCOUNTING', name: 'Yeni Ad' });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: newer.auth })).statusCode).toBe(200);
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 8, role: 'ACCOUNTING', name: 'Yeni Ad', active: true });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })).statusCode).toBe(401);

    // pasif üye: aynı epoch'lu jeton açmaz (askıyı yazan olayla aynı an); askıdan sonra basılmış (daha yeni) jeton açar
    await sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 9, active: false, role: 'ACCOUNTING' }));
    const sameAsSuspend = await m.token({ epoch: 9, role: 'ACCOUNTING' });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: sameAsSuspend.auth })).statusCode).toBe(403);
    const afterSuspend = await m.token({ epoch: 10, role: 'ACCOUNTING' });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: afterSuspend.auth })).statusCode).toBe(200);
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 10, active: true });
    await sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 10, active: true, role: 'ACCOUNTING' }));
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: afterSuspend.auth })).statusCode).toBe(200);
  });

  it('askıdan dönüş olayı hiç gelmese de (DEAD) çalışan kendiliğinden döner: Hesap jetonu yalnız etkin üyeliğe basar', async () => {
    const admin = await registerCompany(app);
    const m = await issueIdentity({ companyId: admin.companyId, role: 'MEASURE', epoch: 3 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })).statusCode).toBe(200);

    // askı (ep4) teslim edildi; askıdan dönüş (ep5) teslim edilemedi
    await sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 4, active: false, role: 'MEASURE' }));
    const suspendedToken = await m.token({ epoch: 4 });
    const blocked = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: suspendedToken.auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('FORBIDDEN');

    // askıdan dönüşten sonra basılan jeton (ep5): kayıt eşitlenir, çalışan girer
    const back = await m.token({ epoch: 5 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: back.auth })).statusCode).toBe(200);
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 5, active: true, role: 'MEASURE' });

    // gecikmiş eski askı olayı (ep4) dönüşü geri almaz; yeni askı (ep6) yine kapatır, eski jeton yenilemeye zorlanır
    expect((await sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 4, active: false, role: 'MEASURE' }))).json().outcome).toBe('stale');
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 5, active: true });
    await sendEvent(app, upserted(admin.companyId, m.userId, { epoch: 6, active: false, role: 'MEASURE' }));
    const again = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: back.auth });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('TOKEN_STALE');

    // çıkarılan üyenin kaydı (member.removed) eski jetonla açılmaz
    await sendEvent(app, removed(admin.companyId, m.userId, 7));
    const removedStale = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: (await m.token({ epoch: 6 })).auth });
    expect(removedStale.statusCode).toBe(401);
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 7, active: false });
  });

  it('çıkarma kalıcı: çıkarılmış üyeliğin daha büyük epoch\'lu jetonu (yedekten geri yükleme, tohum) kaydı açmaz', async () => {
    const admin = await registerCompany(app);
    const m = await issueIdentity({ companyId: admin.companyId, role: 'AUDITOR', epoch: 3 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: m.auth })).statusCode).toBe(200);
    await sendEvent(app, removed(admin.companyId, m.userId, 4));
    const later = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: (await m.token({ epoch: 9 })).auth });
    expect(later.statusCode).toBe(403);
    expect(later.json().error.code).toBe('FORBIDDEN');
    expect(await memberRow(admin.companyId, m.userId)).toMatchObject({ epoch: 4, active: false });

    // tanınmayan üyenin çıkarılması da kalıcı (pasif kayıt açılır)
    const orgId = admin.companyId;
    const mid = crypto.randomUUID();
    await sendEvent(app, removed(orgId, mid, 5, { personId: 'kisi-c', name: 'Çıkan' }));
    const stranger = await issueIdentity({ companyId: orgId, userId: mid, role: 'AUDITOR', epoch: 8 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: stranger.auth })).statusCode).toBe(403);
    expect(await memberRow(orgId, mid)).toMatchObject({ epoch: 5, active: false });
  });
});
