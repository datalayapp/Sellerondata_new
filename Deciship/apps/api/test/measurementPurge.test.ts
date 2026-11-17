/**
 * Silinmiş ölçümün elle kalıcı silinmesi (kullanıcı kararı 2026-11-13; `services/measurementPurge.ts`, SPEC §10.1 ve
 * §5.13). Asıl soru veri kaybı: itiraz kanıtı ve kararlı satırın ölçümü hiçbir yoldan silinmemeli, canlı ölçüm ve başka
 * ölçümün dosyası etkilenmemeli; silinen ölçümün bütün sürümleri ve fotoğrafları ise gerçekten gitmeli, fatura satırlarının
 * sonucu silinen ölçüme dayanmamalı. Eşzamanlı geri yükleme ile yarış kilitle sıraya girer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '../src/db.ts';
import { env } from '../src/env.ts';
import { purgeMeasurementPhoto } from '../src/services/deletedPurge.ts';
import { drainMeasurementQueue } from '../src/services/measurementQueue.ts';
import { setFxService } from '../src/services/fx.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { anyDayFx } from './fxFake.ts';
import { getApp, measurementPayload } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

const API = '/api/deciship';
type Auth = { authorization: string };

describe('silinmiş ölçümün kalıcı silinmesi', () => {
  let app: FastifyInstance;
  let B: Fixture;
  let sup: pg.Client;

  const onDisk = (rel: string) => fs.existsSync(path.join(env.storageDir, rel));
  const call = (auth: Auth | Record<string, string>, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `${API}${url}`, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
  const count = async (sql: string, params: unknown[]) => (await sup.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
  const photoRows = async (measurementId: string) =>
    (await sup.query<{ id: string; path: string; kind: string }>(`SELECT id, path, kind FROM "File" WHERE "measurementId" = $1 ORDER BY "createdAt", id`, [measurementId])).rows;
  const measurementExists = (id: string) => count(`"Measurement" WHERE id = $1`, [id]).then((n) => n === 1);
  const line = async (id: string) =>
    (await sup.query<{ measurementId: string | null; measurementPinned: boolean; status: string; decision: string }>(`SELECT "measurementId", "measurementPinned", status, decision FROM "InvoiceLine" WHERE id = $1`, [id])).rows[0]!;

  async function measure(c: DisputeCompany, photos = 2, over: Record<string, unknown> = {}) {
    const p = measurementPayload(over, photos);
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode, r.body).toBe(201);
    await drainMeasurementQueue(10_000);
    const id = r.json().measurement.id as string;
    return { id, trackingNo: r.json().measurement.trackingNo as string, trackingRaw: (over.trackingRaw as string | undefined) ?? p.data.trackingRaw, files: await photoRows(id) };
  }
  const del = async (c: DisputeCompany, id: string) => {
    const r = await call(c.admin.auth, 'DELETE', `/measurements/${id}`);
    expect(r.statusCode, r.body).toBe(204);
    await drainMeasurementQueue(10_000);
  };
  const purge = (auth: Auth, id: string) => call(auth, 'POST', `/measurements/${id}/purge`);
  const detail = (auth: Auth, id: string) => call(auth, 'GET', `/measurements/${id}`);
  const lineMeasurement = async (lineId: string) => (await line(lineId)).measurementId;
  const sendDispute = async (auth: Auth, invoiceId: string) => {
    const r = await call(auth, 'POST', `/invoices/${invoiceId}/disputes`, { sentOn: trDay(-2), channel: 'EMAIL', selectionDigest: await digestOf(app, auth, invoiceId) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().dispute.active as { id: string; version: number; lines: { id: string }[] };
  };
  /** Korunan ölçüm: ayrıntı nedeni söyler, istek 409 döner, hiçbir şey silinmez. */
  async function expectProtected(c: DisputeCompany, id: string, reason: 'DISPUTE' | 'DECIDED_LINE') {
    const files = await photoRows(id);
    const d = await detail(c.admin.auth, id);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().measurement.purge).toEqual({ allowed: false, reason });
    const r = await purge(c.admin.auth, id);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: 'MEASUREMENT_PROTECTED', details: { reason } } });
    expect(await measurementExists(id)).toBe(true);
    expect(await photoRows(id)).toEqual(files);
    for (const f of files) expect(onDisk(f.path)).toBe(true);
  }
  /** Kilit bekleyen bağlantı sayısı (eşzamanlılık testinde sıra için). */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 200; i++) {
      const w = (await sup.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n;
      if (w >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${n} kilit bekleyen bağlantı görülmedi`);
  }

  beforeAll(async () => {
    app = await getApp();
    B = await companyFixture(app);
    sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
    await sup.connect();
  });
  afterAll(async () => {
    await sup?.end();
  });

  it('bütün sürümler, fotoğraf satırları ve diskleri gider; denetim izi ve Merkez akışı; ayrıntı ve sonraki istekler 404', async () => {
    const c = await disputeCompany(app);
    const v1 = await measure(c, 2);
    const scale = v1.files.find((f) => f.kind === 'PHOTO_SCALE')!;
    const box = v1.files.find((f) => f.kind === 'PHOTO_BOX')!;
    const r = await call(c.admin.auth, 'PATCH', `/measurements/${v1.id}`, { weightKg: 5, removePhotoIds: [scale.id] });
    expect(r.statusCode, r.body).toBe(200);
    const v2 = r.json().measurement.id as string;
    await drainMeasurementQueue(10_000);
    expect((await photoRows(v2)).map((f) => f.path)).toEqual([box.path]);
    await del(c, v2);

    const before = await detail(c.admin.auth, v2);
    expect(before.json().measurement.purge).toEqual({ allowed: true, reason: null });
    const res = await purge(c.admin.auth, v2);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: { id: v2, trackingNo: v1.trackingNo, versions: 2, photos: 3 } });
    expect(await measurementExists(v1.id)).toBe(false);
    expect(await measurementExists(v2)).toBe(false);
    expect(await count(`"File" WHERE path = ANY($1)`, [[box.path, scale.path]])).toBe(0);
    expect(onDisk(box.path)).toBe(false);
    expect(onDisk(scale.path)).toBe(false);

    const audit = (await sup.query(`SELECT "userId", entity, "entityId", data FROM "AuditLog" WHERE action = 'measurement.purge' AND "companyId" = $1`, [c.admin.companyId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: c.admin.userId, entity: 'Measurement', entityId: v2, data: { trackingNo: v1.trackingNo, versions: 2, photos: 3, unlinkedLines: 0 } });
    const feed = await call(c.admin.auth, 'GET', '/platform/activity?pageSize=50');
    expect(feed.statusCode, feed.body).toBe(200);
    expect(feed.json().items).toContainEqual(expect.objectContaining({ action: 'silinen ölçümü kalıcı olarak sildi', target: v1.trackingNo }));
    const en = await call({ ...c.admin.auth, 'accept-language': 'en' }, 'GET', '/platform/activity?pageSize=50');
    expect((en.json().items as { action: string }[]).map((i) => i.action)).toContain('permanently deleted a measurement');

    expect((await detail(c.admin.auth, v2)).statusCode).toBe(404);
    expect((await purge(c.admin.auth, v2)).statusCode).toBe(404);
    expect((await call(c.admin.auth, 'POST', `/measurements/${v2}/restore`)).statusCode).toBe(404);
    // eski denetim kayıtları kalır
    expect(await count(`"AuditLog" WHERE "entityId" = ANY($1) AND action <> 'measurement.purge'`, [[v1.id, v2]])).toBeGreaterThanOrEqual(3);
  });

  it('başka ölçümün aynı yolu gösteren dosya satırı ve diski kalır; diskte bulunamayan dosya silmeyi durdurmaz', async () => {
    const c = await disputeCompany(app);
    const m = await measure(c, 2);
    const other = await measure(c, 0);
    const [shared, gone] = m.files;
    await sup.query(
      `INSERT INTO "File" (id, "companyId", kind, mime, size, path, sha256, "measurementId", "createdById", "updatedAt")
       SELECT gen_random_uuid()::text, "companyId", kind, mime, size, path, sha256, $2, "createdById", now() FROM "File" WHERE id = $1`,
      [shared!.id, other.id],
    );
    fs.unlinkSync(path.join(env.storageDir, gone!.path));
    await del(c, m.id);
    const res = await purge(c.admin.auth, m.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().purged).toMatchObject({ versions: 1, photos: 2 });
    expect(await photoRows(m.id)).toEqual([]);
    expect((await photoRows(other.id)).map((f) => f.path)).toEqual([shared!.path]);
    expect(onDisk(shared!.path)).toBe(true);
    expect(await measurementExists(other.id)).toBe(true);
  });

  it('silinmemiş ölçüm, eski sürüm, bilinmeyen ve başka firmanın ölçümü: silinmez; ayrıntıda kalıcı silme bilgisi yok', async () => {
    const c = await disputeCompany(app);
    const live = await measure(c, 1);
    const d = await detail(c.admin.auth, live.id);
    expect(d.statusCode).toBe(200);
    expect(d.json().measurement).not.toHaveProperty('purge');
    const r = await purge(c.admin.auth, live.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('NOT_DELETED');
    expect(await photoRows(live.id)).toEqual(live.files);

    const p = await call(c.admin.auth, 'PATCH', `/measurements/${live.id}`, { weightKg: 6 });
    expect(p.statusCode, p.body).toBe(200);
    const head = p.json().measurement.id as string;
    await drainMeasurementQueue(10_000);
    await del(c, head);
    const old = await purge(c.admin.auth, live.id);
    expect(old.statusCode, old.body).toBe(409);
    expect(old.json().error.code).toBe('NOT_LATEST_VERSION');
    expect(await measurementExists(live.id)).toBe(true);
    expect(await measurementExists(head)).toBe(true);

    expect((await purge(c.admin.auth, crypto.randomUUID())).statusCode).toBe(404);
    // başka firmanın (silinmiş) ölçümü: 404, dokunulmaz
    await sup.query(`UPDATE "Measurement" SET "deletedAt" = now() WHERE id = $1`, [B.measurement.id]);
    try {
      expect((await purge(c.admin.auth, B.measurement.id)).statusCode).toBe(404);
      expect(await measurementExists(B.measurement.id)).toBe(true);
    } finally {
      await sup.query(`UPDATE "Measurement" SET "deletedAt" = NULL WHERE id = $1`, [B.measurement.id]);
    }
  });

  it('yetki: yalnız ölçüm yönetme izni; kendi silinmiş ölçümü için ölçüm izni yetmez (403), kayıt kalır', async () => {
    const c = await disputeCompany(app);
    const m = await measure(c, 1);
    const own = await call(c.worker.auth, 'DELETE', `/measurements/${m.id}`);
    expect(own.statusCode, own.body).toBe(204);
    await drainMeasurementQueue(10_000);
    const r = await purge(c.worker.auth, m.id);
    expect(r.statusCode, r.body).toBe(403);
    expect(await measurementExists(m.id)).toBe(true);
    expect(await photoRows(m.id)).toEqual(m.files);
    // çalışan kendi ayrıntısında kalıcı silme bilgisini görmez
    const d = await detail(c.worker.auth, m.id);
    expect(d.statusCode).toBe(200);
    expect(d.json().measurement).not.toHaveProperty('purge');
  });

  it('koruma: kararlı satırın ölçümü (itiraz listesi, uyumlu; faturası silinse de) DECIDED_LINE', async () => {
    const d = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, d, [80, 90], { verify: 1 });
    const accepted = await call(d.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'ACCEPTED', reason: 'kabul' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const mListed = (await lineMeasurement(inv.lines[0]!.id))!;
    const mAccepted = (await lineMeasurement(inv.lines[1]!.id))!;
    for (const id of [mListed, mAccepted]) {
      await del(d, id);
      await expectProtected(d, id, 'DECIDED_LINE');
    }
    // silinmiş faturanın kararlı satırı da korur (kuşkuda silinmez)
    expect((await call(d.admin.auth, 'DELETE', `/invoices/${inv.invoiceId}`)).statusCode).toBe(204);
    await drainMeasurementQueue(10_000);
    await expectProtected(d, mAccepted, 'DECIDED_LINE');
  });

  it('koruma: gönderilmiş itirazın kanıtı ve itirazdaki satırın ölçümü DISPUTE (karar varken de itiraz önce söylenir)', async () => {
    const d = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, d, [80]);
    const round = await sendDispute(d.admin.auth, inv.invoiceId);
    const m = (await lineMeasurement(inv.lines[0]!.id))!;
    expect((await sup.query(`SELECT "measurementId" FROM "DisputeLine" WHERE id = $1`, [round.lines[0]!.id])).rows[0].measurementId).toBe(m);
    await del(d, m);
    await expectProtected(d, m, 'DISPUTE');
    // satırın bağı ve kararı kalksa da itiraz satırının gönderim anındaki ölçümü tek başına korur
    await sup.query(`UPDATE "DisputeLine" SET "trackingNo" = 'BASKA-NO' WHERE id = $1`, [round.lines[0]!.id]);
    await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = NULL, decision = 'OPEN' WHERE id = $1`, [inv.lines[0]!.id]);
    await expectProtected(d, m, 'DISPUTE');
  });

  it('koruma: bağı belirsiz eski itiraz satırı takip no ile korur DISPUTE', async () => {
    const d = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, d, [80]);
    const round = await sendDispute(d.admin.auth, inv.invoiceId);
    const m = (await lineMeasurement(inv.lines[0]!.id))!;
    await sup.query(`UPDATE "DisputeLine" SET "measurementId" = NULL WHERE id = $1`, [round.lines[0]!.id]);
    await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = NULL, decision = 'OPEN' WHERE id = $1`, [inv.lines[0]!.id]);
    await sup.query(`UPDATE "Measurement" SET "deletedAt" = now() WHERE id = $1`, [m]);
    await expectProtected(d, m, 'DISPUTE');
  });

  it('koruma: zincirin eski sürümü geri çekilmiş turun kanıtıysa son sürüm de silinmez (bütün zincir korunur)', async () => {
    const d = await disputeCompany(app);
    const a = d.admin.auth;
    const inv = await invoiceWithDiffs(app, d, [80]);
    const r1 = await sendDispute(a, inv.invoiceId);
    expect((await call(a, 'POST', `/disputes/${r1.id}/withdraw`, { version: r1.version, reason: 'yanlış' })).statusCode).toBe(200);
    const L = inv.lines[0]!.id;
    const m1 = (await lineMeasurement(L))!;
    expect((await call(a, 'PATCH', `/invoice-lines/${L}`, { decision: 'OPEN' })).statusCode).toBe(200);
    const trackingRaw = (await sup.query(`SELECT "trackingRaw" FROM "Measurement" WHERE id = $1`, [m1])).rows[0].trackingRaw as string;
    const m2 = await measure(d, 1, { trackingRaw, lengthCm: 30, widthCm: 20, heightCm: 16, weightKg: 2 });
    expect((await sup.query(`SELECT "supersededById" FROM "Measurement" WHERE id = $1`, [m1])).rows[0].supersededById).toBe(m2.id);
    await del(d, m2.id);
    await expectProtected(d, m2.id, 'DISPUTE');
    expect(await measurementExists(m1)).toBe(true);
  });

  it('fatura satırları: bağı kalkar, satır güncel ölçüme göre yeniden hesaplanır; elle eşleştirme kalkar; işaret kalmaz', async () => {
    const d = await disputeCompany(app);
    const a = d.admin.auth;
    const inv = await invoiceWithDiffs(app, d, [80, 90], { verify: 0 });
    const [stale, pinned] = [inv.lines[0]!, inv.lines[1]!];
    const mStale = (await lineMeasurement(stale.id))!;
    const mPinned = (await lineMeasurement(pinned.id))!;

    // 1) karşılaştırması yetişmemiş silme: satır hâlâ silinen ölçüme bağlı ve onun sonucunu taşıyor
    await del(d, mStale);
    const settled = await line(stale.id);
    expect(settled).toMatchObject({ measurementId: null, status: 'UNMATCHED' });

    // 2) elle eşleştirilmiş ölçüm silindi, aynı koli yeniden ölçüldü (yeni zincir): satır sabitlemede, eşleşmesiz
    const pin = await call(a, 'PATCH', `/invoice-lines/${pinned.id}`, { measurementId: mPinned });
    expect(pin.statusCode, pin.body).toBe(200);
    await del(d, mPinned);
    expect(await line(pinned.id)).toMatchObject({ measurementId: mPinned, measurementPinned: true, status: 'UNMATCHED' });
    const trackingRaw = (await sup.query(`SELECT "trackingRaw" FROM "Measurement" WHERE id = $1`, [mPinned])).rows[0].trackingRaw as string;
    const fresh = await measure(d, 1, { trackingRaw, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    expect(await line(pinned.id)).toMatchObject({ measurementId: mPinned, measurementPinned: true, status: 'UNMATCHED' });

    // (faturanın her yeniden hesabı bağı düzeltir: bayat bağ kalıcı silmeden hemen önce kurulur)
    await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = $2, status = 'DIFF' WHERE id = $1`, [stale.id, mStale]);
    const r1 = await purge(a, mStale);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(await line(stale.id)).toMatchObject({ measurementId: null, measurementPinned: false, status: 'UNMATCHED', decision: 'OPEN' });
    const r2 = await purge(a, mPinned);
    expect(r2.statusCode, r2.body).toBe(200);
    // sabitleme kalktı, satır takip no ile yeni ölçüme eşleşti ve onunla hesaplandı
    expect(await line(pinned.id)).toMatchObject({ measurementId: fresh.id, measurementPinned: false, status: 'DIFF', decision: 'OPEN' });
    expect(await count(`"InvoiceRecheck" WHERE "invoiceId" = $1`, [inv.invoiceId])).toBe(0);
    const audits = (await sup.query(`SELECT data FROM "AuditLog" WHERE action = 'measurement.purge' AND "entityId" = ANY($1) ORDER BY "createdAt"`, [[mStale, mPinned]])).rows;
    expect(audits.map((x) => x.data.unlinkedLines)).toEqual([1, 1]);
    // denetim izi silinen sürüm kimliklerini ve bağı kalkan satırların faturalarını taşır
    expect(audits.map((x) => [x.data.versionIds, x.data.invoiceIds])).toEqual([
      [[mStale], [inv.invoiceId]],
      [[mPinned], [inv.invoiceId]],
    ]);
    // panelin okuduğu satır listesi de aynı: silinen ölçüm hiçbir satırda görünmez
    const lines = (await call(a, 'GET', `/invoices/${inv.invoiceId}/lines`)).json().items as { id: string; status: string; measurement: { id: string } | null }[];
    expect(lines.find((l) => l.id === stale.id)).toMatchObject({ status: 'UNMATCHED', measurement: null });
    expect(lines.find((l) => l.id === pinned.id)).toMatchObject({ status: 'DIFF', measurement: expect.objectContaining({ id: fresh.id }) });
  });

  it('eşzamanlı geri yükleme: önce gelen kazanır; kalıcı silme önceyse geri yükleme 404, geri yükleme önceyse silme 409', async () => {
    const c = await disputeCompany(app);
    const companyId = c.admin.companyId;

    // a) kalıcı silme kilidi önce alır (ölçüm satırını bekler), geri yükleme takip no kilidinde bekler
    const m = await measure(c, 1);
    await del(c, m.id);
    await sup.query('BEGIN');
    await sup.query(`SELECT id FROM "Measurement" WHERE id = $1 FOR UPDATE`, [m.id]);
    const purging = purge(c.admin.auth, m.id);
    await waitForLockWaiters(1);
    const restoring = call(c.admin.auth, 'POST', `/measurements/${m.id}/restore`);
    await waitForLockWaiters(2);
    await sup.query('COMMIT');
    const [p, r] = await Promise.all([purging, restoring]);
    expect(p.statusCode, p.body).toBe(200);
    expect(r.statusCode, r.body).toBe(404);
    expect(await measurementExists(m.id)).toBe(false);
    for (const f of m.files) expect(onDisk(f.path)).toBe(false);

    // b) geri yükleme önce: kalıcı silme silinmemiş kaydı görür, dokunmaz
    const n = await measure(c, 1);
    await del(c, n.id);
    await sup.query('BEGIN');
    await sup.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`measurement:${companyId}:${n.trackingNo}`]);
    const restoring2 = call(c.admin.auth, 'POST', `/measurements/${n.id}/restore`);
    await waitForLockWaiters(1);
    const purging2 = purge(c.admin.auth, n.id);
    await waitForLockWaiters(2);
    await sup.query('COMMIT');
    const [r2, p2] = await Promise.all([restoring2, purging2]);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(p2.statusCode, p2.body).toBe(409);
    expect(p2.json().error.code).toBe('NOT_DELETED');
    expect(await photoRows(n.id)).toEqual(n.files);
    for (const f of n.files) expect(onDisk(f.path)).toBe(true);

    // c) iki kalıcı silme aynı anda: biri siler, öbürü 404
    const o = await measure(c, 1);
    await del(c, o.id);
    const both = await Promise.all([purge(c.admin.auth, o.id), purge(c.admin.auth, o.id)]);
    expect(both.map((x) => x.statusCode).sort()).toEqual([200, 404]);
    expect(await count(`"AuditLog" WHERE action = 'measurement.purge' AND "entityId" = $1`, [o.id])).toBe(1);
  });

  it('karşılaştırması bitmemiş zincir (silme sonrası işaret dolu, eski sürüm dahil) silinmez: 409 MEASUREMENT_CHANGED; bitince silinir', async () => {
    const c = await disputeCompany(app);
    const v1 = await measure(c, 1);
    const p = await call(c.admin.auth, 'PATCH', `/measurements/${v1.id}`, { weightKg: 6 });
    expect(p.statusCode, p.body).toBe(200);
    const head = p.json().measurement.id as string;
    await drainMeasurementQueue(10_000);
    await del(c, head);
    for (const id of [head, v1.id]) {
      await sup.query(`UPDATE "Measurement" SET "recomparePendingAt" = now() WHERE id = $1`, [id]);
      const r = await purge(c.admin.auth, head);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatchObject({ code: 'MEASUREMENT_CHANGED', message: expect.stringContaining('biraz sonra yeniden deneyin') });
      expect(await measurementExists(head)).toBe(true);
      expect(await measurementExists(v1.id)).toBe(true);
      expect(await photoRows(head)).toHaveLength(1);
      await sup.query(`UPDATE "Measurement" SET "recomparePendingAt" = NULL WHERE id = $1`, [id]);
    }
    expect((await purge(c.admin.auth, head)).statusCode).toBe(200);
  });

  it('kilitlenme (40P01): işlem geri alınır ve bir kez yeniden denenir; sonuç tek silme', async () => {
    const c = await disputeCompany(app);
    const m = await measure(c, 1);
    await del(c, m.id);
    await sup.query('BEGIN');
    // karşı taraf geç fark etsin: kilitlenmeyi kalıcı silme bulur ve kendi işlemi geri alınır
    await sup.query(`SET LOCAL deadlock_timeout = '20s'`);
    await sup.query(`SELECT id FROM "Measurement" WHERE id = $1 FOR UPDATE`, [m.id]);
    const purging = purge(c.admin.auth, m.id);
    await waitForLockWaiters(1); // kalıcı silme dosya satırını tuttu, ölçüm satırını bekliyor
    // ters sıra: dosya satırını iste → kilitlenme; kurban kalıcı silme olur, bu sorgu onun geri alınmasıyla açılır
    await sup.query(`SELECT id FROM "File" WHERE id = $1 FOR UPDATE`, [m.files[0]!.id]);
    await sup.query('COMMIT');
    const r = await purging;
    expect(r.statusCode, r.body).toBe(200);
    expect(await measurementExists(m.id)).toBe(false);
    expect(await count(`"AuditLog" WHERE action = 'measurement.purge' AND "entityId" = $1`, [m.id])).toBe(1);
  });

  it('elle eşleştirme: son sürümü silinmiş zincirin eski sürümüne bağlanamaz (404)', async () => {
    const d = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, d, [80], { verify: 0 });
    const v1 = await measure(d, 1);
    const p = await call(d.admin.auth, 'PATCH', `/measurements/${v1.id}`, { weightKg: 6 });
    expect(p.statusCode, p.body).toBe(200);
    const head = p.json().measurement.id as string;
    await drainMeasurementQueue(10_000);
    await del(d, head);
    const before = await line(inv.lines[0]!.id);
    const r = await call(d.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[0]!.id}`, { measurementId: v1.id });
    expect(r.statusCode, r.body).toBe(404);
    expect(await line(inv.lines[0]!.id)).toEqual(before);
    // canlı zincirin eski sürümü kabul edilir (güncel sürüme bağlanır)
    const w1 = await measure(d, 1);
    const q = await call(d.admin.auth, 'PATCH', `/measurements/${w1.id}`, { weightKg: 7 });
    const wHead = q.json().measurement.id as string;
    await drainMeasurementQueue(10_000);
    const ok = await call(d.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[0]!.id}`, { measurementId: w1.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await line(inv.lines[0]!.id)).toMatchObject({ measurementPinned: true, measurementId: wHead });
  });

  it("koruma: itiraz satırının takip no'su zincirinkiyle yalnız son 10 karakterde aynıysa da korur (kalıcı silme ve 30 günlük fotoğraf temizliği)", async () => {
    const d = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, d, [80]);
    const round = await sendDispute(d.admin.auth, inv.invoiceId);
    const m = (await lineMeasurement(inv.lines[0]!.id))!;
    // bağ yok, takip no başka önekle: tam eşleşme yok, karşılaştırmanın son 10 karakter eşleşmesi var
    await sup.query(`UPDATE "DisputeLine" SET "measurementId" = NULL, "trackingNo" = 'ZZ' || right("trackingNo", 10) WHERE id = $1`, [round.lines[0]!.id]);
    await sup.query(`UPDATE "InvoiceLine" SET "measurementId" = NULL, decision = 'OPEN' WHERE id = $1`, [inv.lines[0]!.id]);
    await sup.query(`UPDATE "Measurement" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - interval '400 days' WHERE id = $1`, [m]);
    const files = await photoRows(m);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(await withCompany(d.admin.companyId, () => purgeMeasurementPhoto(d.admin.companyId, f.id, { days: 7 }))).toBe(false);
    await expectProtected(d, m, 'DISPUTE');
    // son 10 karakter de farklıysa koruma kalkar (koruma gerçekten bu eşleşmeden geliyor)
    await sup.query(`UPDATE "DisputeLine" SET "trackingNo" = 'BASKA-NO' WHERE id = $1`, [round.lines[0]!.id]);
    expect((await detail(d.admin.auth, m)).json().measurement.purge).toEqual({ allowed: true, reason: null });
  });
});
