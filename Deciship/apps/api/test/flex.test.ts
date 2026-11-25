import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { createWorker, findMoneyKeys, getApp, JPEG, measurementPayload, multipart, registerCompany, uniq, type Part, inCompany } from './helpers.ts';
import { patchInvoice, recalculate } from './recalcHelpers.ts';

type Auth = { authorization: string };

async function createMeasurement(app: FastifyInstance, auth: Auth, over: Record<string, unknown> = {}, photos = 1) {
  const p = measurementPayload(over, photos);
  const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement as { id: string; trackingNo: string; version: number };
}

function patchMultipart(data: Record<string, unknown>, photos = 0) {
  const parts: Part[] = [{ name: 'data', value: JSON.stringify(data) }];
  for (let i = 0; i < photos; i++) parts.push({ name: 'photos', filename: `n${i}.jpg`, contentType: 'image/jpeg', data: JPEG });
  return multipart(parts);
}

/** Company with two carriers; only `carrierId` has a (desi) tariff, `otherCarrierId` has none. */
async function invoiceFixture(app: FastifyInstance, auth: Auth) {
  const c1 = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'aras', name: 'Aras Test' } });
  const c2 = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'mng', name: 'MNG Test' } });
  const carrierId = c1.json().carrier?.id ?? c1.json().id;
  const otherCarrierId = c2.json().carrier?.id ?? c2.json().id;
  const tariff = await app.inject({
    method: 'POST',
    url: '/api/deciship/tariffs',
    headers: auth,
    payload: {
      carrierId,
      name: 'Aras Desi Test',
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'TR' }],
      rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * 10 })),
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return { carrierId, otherCarrierId };
}

async function importInvoice(
  app: FastifyInstance,
  auth: Auth,
  carrierId: string,
  rows: { tracking: string; kg: number; amount: number }[],
  invoiceNo = uniq('F'),
) {
  const csv = ['Takip No;Desi;Tutar', ...rows.map((r) => `${r.tracking};${r.kg};${r.amount}`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const res = await app.inject({
    method: 'POST',
    url: '/api/deciship/invoices',
    headers: auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo,
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      saveMapping: false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const invoiceId = res.json().invoice.id as string;
  return { invoiceId, invoiceNo };
}

async function lines(app: FastifyInstance, auth: Auth, invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.json().items as {
    id: string;
    trackingNo: string;
    originalTrackingNo: string | null;
    status: string;
    measurementId: string | null;
    measurementPinned: boolean;
    note: string | null;
    measurement: { id: string; weightKg: number } | null;
  }[];
}

describe('flex v2 — measurements (SPEC 10.1)', () => {
  it('WORKER edits own measurement → new version with detail shape and no money fields; others → 404', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const other = await createWorker(app, admin.auth);
    const mine = await createMeasurement(app, worker.auth);
    const theirs = await createMeasurement(app, other.auth);

    const r = await app.inject({
      method: 'PATCH',
      url: `/api/deciship/measurements/${mine.id}`,
      headers: worker.auth,
      payload: { lengthCm: 50, weightKg: 7.25, note: 'düzeltildi', measuredAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json().measurement;
    expect(m).toMatchObject({ version: 2, lengthCm: 50, weightKg: 7.25, note: 'düzeltildi', dimMethod: 'MANUAL', dimConfidence: null, canEdit: true });
    expect(m.id).not.toBe(mine.id);
    expect(m.measuredAt.startsWith('2020')).toBe(false); // worker cannot move measuredAt
    expect(m.history.map((h: { id: string }) => h.id)).toEqual([mine.id]);
    expect(m.photos).toHaveLength(1);
    expect(findMoneyKeys(r.json())).toEqual([]);
    expect(m.invoiceLines).toBeUndefined();

    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth });
    expect(detail.json().measurement.canEdit).toBe(true);
    expect(findMoneyKeys(detail.json())).toEqual([]);
    const old = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${mine.id}`, headers: worker.auth });
    expect(old.json().measurement.canEdit).toBe(false);

    for (const [method, url] of [
      ['PATCH', `/api/deciship/measurements/${theirs.id}`],
      ['DELETE', `/api/deciship/measurements/${theirs.id}`],
      ['POST', `/api/deciship/measurements/${theirs.id}/restore`],
      ['GET', `/api/deciship/measurements/${theirs.id}`],
    ] as const) {
      const x = await app.inject({ method, url, headers: worker.auth, payload: method === 'PATCH' ? { weightKg: 1 } : undefined });
      expect(x.statusCode, `${method} ${url}`).toBe(404);
    }

    // admin may edit anyone's, and set measuredAt
    const a = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${theirs.id}`, headers: admin.auth, payload: { measuredAt: '2026-10-01T10:00:00.000Z' } });
    expect(a.statusCode).toBe(200);
    expect(a.json().measurement).toMatchObject({ version: 2, measuredAt: '2026-10-01T10:00:00.000Z', canEdit: true });
    expect(a.json().measurement.measuredBy.id).toBe(other.userId);
  });

  it('preset selection sets PRESET and fills dimensions', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const presets = (await app.inject({ method: 'GET', url: '/api/deciship/box-presets', headers: worker.auth })).json().items;
    const k1 = presets.find((p: { name: string }) => p.name === 'K1');
    const m = await createMeasurement(app, worker.auth, { dimMethod: 'LIDAR', dimConfidence: 0.9 });
    const r = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth, payload: { boxPresetId: k1.id } });
    expect(r.json().measurement).toMatchObject({ dimMethod: 'PRESET', boxPresetId: k1.id, lengthCm: 30, widthCm: 20, heightCm: 15, dimConfidence: null });
    const r2 = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${r.json().measurement.id}`, headers: worker.auth, payload: { heightCm: 16 } });
    expect(r2.json().measurement).toMatchObject({ dimMethod: 'MANUAL', boxPresetId: null, heightCm: 16 });
  });

  it('multipart edit removes and adds photos; PHOTO_REQUIRED guards the box photo', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const m = await createMeasurement(app, worker.auth, {}, 2); // PHOTO_BOX + PHOTO_SCALE
    const detail = (await app.inject({ method: 'GET', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth })).json().measurement;
    const box = detail.photos.find((p: { kind: string }) => p.kind === 'PHOTO_BOX');
    const scale = detail.photos.find((p: { kind: string }) => p.kind === 'PHOTO_SCALE');

    const bad = patchMultipart({ removePhotoIds: [box.id] });
    const r400 = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${m.id}`, headers: { ...worker.auth, ...bad.headers }, payload: bad.payload });
    expect(r400.statusCode).toBe(400);
    expect(r400.json().error.code).toBe('PHOTO_REQUIRED');

    const ok = patchMultipart({ removePhotoIds: [box.id, scale.id], photoKinds: ['PHOTO_BOX', 'PHOTO_LABEL'], weightKg: 3 }, 2);
    const r = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${m.id}`, headers: { ...worker.auth, ...ok.headers }, payload: ok.payload });
    expect(r.statusCode, r.body).toBe(200);
    const next = r.json().measurement;
    expect(next).toMatchObject({ version: 2, weightKg: 3, weightMethod: 'MANUAL', photoCount: 2 });
    expect(next.photos.map((p: { kind: string }) => p.kind).sort()).toEqual(['PHOTO_BOX', 'PHOTO_LABEL']);
    expect(next.photos.map((p: { id: string }) => p.id)).not.toContain(box.id);
    // the previous version keeps its photos
    expect(next.history[0].photoCount).toBe(2);

    const img = new URL(next.photos[0].url);
    expect((await app.inject({ method: 'GET', url: img.pathname + img.search })).statusCode).toBe(200);
  });

  it('delete → restore, deleted list (ADMIN only), NEWER_EXISTS, no 7-day cap for workers', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const oldOne = await createMeasurement(app, worker.auth, { measuredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    const list = await app.inject({ method: 'GET', url: '/api/deciship/measurements', headers: worker.auth });
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(oldOne.id);

    const tracking = uniq('7948');
    const m = await createMeasurement(app, worker.auth, { trackingRaw: tracking });
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${tracking}`, headers: worker.auth })).json().total).toBe(0);

    expect((await app.inject({ method: 'GET', url: '/api/deciship/measurements?deleted=true', headers: worker.auth })).statusCode).toBe(403);
    const deleted = await app.inject({ method: 'GET', url: '/api/deciship/measurements?deleted=true', headers: admin.auth });
    expect(deleted.json().total).toBe(1);
    expect(deleted.json().items[0]).toMatchObject({ id: m.id, deleted: true });
    expect(typeof deleted.json().items[0].deletedAt).toBe('string');

    const restored = await app.inject({ method: 'POST', url: `/api/deciship/measurements/${m.id}/restore`, headers: worker.auth });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().measurement).toMatchObject({ id: m.id, deleted: false, deletedAt: null, canEdit: true });
    expect(findMoneyKeys(restored.json())).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/measurements?q=${tracking}`, headers: worker.auth })).json().total).toBe(1);

    // delete again, then a new measurement of the same tracking no arrives → restore is refused
    await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth });
    await createMeasurement(app, worker.auth, { trackingRaw: tracking });
    const conflict = await app.inject({ method: 'POST', url: `/api/deciship/measurements/${m.id}/restore`, headers: worker.auth });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('NEWER_EXISTS');

    const audits = await inCompany(admin.auth, () => prisma.auditLog.findMany({ where: { entityId: m.id }, select: { action: true } }));
    expect(audits.map((a) => a.action).sort()).toEqual(['measurement.create', 'measurement.delete', 'measurement.delete', 'measurement.restore']);
  });
});

describe('flex v2 — invoices (SPEC 10.2)', () => {
  it('edits invoice meta; duplicate number → 409; carrier change recompares', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const { carrierId, otherCarrierId } = await invoiceFixture(app, admin.auth);
    const m = await createMeasurement(app, admin.auth, { lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const a = await importInvoice(app, admin.auth, carrierId, [{ tracking: m.trackingNo, kg: 2, amount: 20 }]);
    const b = await importInvoice(app, admin.auth, carrierId, [{ tracking: uniq('X1'), kg: 1, amount: 10 }]);
    expect((await lines(app, admin.auth, a.invoiceId))[0]!.status).toBe('MATCH');

    const dup = await app.inject({ method: 'PATCH', url: `/api/deciship/invoices/${b.invoiceId}`, headers: admin.auth, payload: { invoiceNo: a.invoiceNo } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('INVOICE_EXISTS');

    // tarih hesabı değiştiren alan: önce önizleme, kayıt onun token'ıyla (patchInvoice)
    const meta = await patchInvoice(app, admin.auth, a.invoiceId, { invoiceNo: `${a.invoiceNo}-D`, invoiceDate: '2026-10-20', periodFrom: '2026-10-01', periodTo: '2026-10-31' });
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.json().invoice).toMatchObject({
      id: a.invoiceId,
      invoiceNo: `${a.invoiceNo}-D`,
      invoiceDate: '2026-10-20',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
      carrier: { id: carrierId },
      totals: { lines: 1, match: 1 },
    });
    expect(meta.json().invoice.fileUrl).toBeTruthy();
    const get = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${a.invoiceId}`, headers: admin.auth });
    expect(Object.keys(meta.json().invoice).sort()).toEqual(Object.keys(get.json().invoice).sort());

    const cleared = await app.inject({ method: 'PATCH', url: `/api/deciship/invoices/${a.invoiceId}`, headers: admin.auth, payload: { periodFrom: null } });
    expect(cleared.json().invoice.periodFrom).toBeNull();

    // same number is fine on another carrier; carrier without tariff → NO_TARIFF
    const moved = await patchInvoice(app, admin.auth, b.invoiceId, { invoiceNo: a.invoiceNo, carrierId: otherCarrierId });
    expect(moved.statusCode, moved.body).toBe(200);
    const carrierChange = await patchInvoice(app, admin.auth, a.invoiceId, { carrierId: otherCarrierId });
    expect(carrierChange.statusCode).toBe(200);
    expect(carrierChange.json().invoice).toMatchObject({ carrier: { id: otherCarrierId }, totals: { noTariff: 1, match: 0 } });

    const worker = await createWorker(app, admin.auth);
    expect((await app.inject({ method: 'PATCH', url: `/api/deciship/invoices/${a.invoiceId}`, headers: worker.auth, payload: { currency: 'USD' } })).statusCode).toBe(403);
    const audits = await inCompany(admin.auth, () => prisma.auditLog.count({ where: { entityId: a.invoiceId, action: 'invoice.update' } }));
    expect(audits).toBe(3);
  });

  it('line tracking-no fix re-matches; pin / unpin; pin follows new versions and survives delete', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const { carrierId } = await invoiceFixture(app, admin.auth);
    const m = await createMeasurement(app, worker.auth, { lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 5 });
    const typo = `${m.trackingNo.slice(0, -3)}999`;
    const unrelated = uniq('ZZ');
    const { invoiceId } = await importInvoice(app, admin.auth, carrierId, [
      { tracking: typo, kg: 5, amount: 50 },
      { tracking: unrelated, kg: 5, amount: 50 },
    ]);
    let [l1, l2] = await lines(app, admin.auth, invoiceId);
    expect(l1!.status).toBe('UNMATCHED');
    expect(l1!).toMatchObject({ measurementPinned: false, originalTrackingNo: null });

    // tracking-no fix
    const fix = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l1!.id}`, headers: admin.auth, payload: { trackingNo: ` ${m.trackingNo.toLowerCase()} ` } });
    expect(fix.statusCode, fix.body).toBe(200);
    expect(fix.json().line).toMatchObject({ trackingNo: m.trackingNo, originalTrackingNo: typo, status: 'MATCH', measurementId: m.id, measurementPinned: false });
    expect(fix.json().totals).toMatchObject({ lines: 2, match: 1, unmatched: 1 });
    // a second fix keeps the printed original
    const fix2 = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l1!.id}`, headers: admin.auth, payload: { trackingNo: `${m.trackingNo}1` } });
    expect(fix2.json().line).toMatchObject({ originalTrackingNo: typo, status: 'UNMATCHED' });
    await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l1!.id}`, headers: admin.auth, payload: { trackingNo: m.trackingNo } });

    // pin the unrelated line to the measurement + note + decision in one call
    const pin = await app.inject({
      method: 'PATCH',
      url: `/api/deciship/invoice-lines/${l2!.id}`,
      headers: admin.auth,
      payload: { measurementId: m.id, note: 'Etiket yanlış basılmış', decision: 'VERIFIED' },
    });
    expect(pin.statusCode, pin.body).toBe(200);
    expect(pin.json().line).toMatchObject({ measurementPinned: true, measurementId: m.id, status: 'MATCH', note: 'Etiket yanlış basılmış', decision: 'VERIFIED' });
    expect(pin.json().line.measurement.id).toBe(m.id);

    // worker corrects the measurement → pinned line follows the new version and is recompared
    const corrected = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${m.id}`, headers: worker.auth, payload: { weightKg: 2 } }); // desi 3 < billed 5 → overcharge
    const v2 = corrected.json().measurement;
    [l1, l2] = await lines(app, admin.auth, invoiceId);
    // Mesaj 4: karar verilmiş satır donar; ölçüm değişince eski rakamında kalır ve "ölçüm değişti" diye işaretlenir, açık satır yeni ölçümü izler.
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: m.id, status: 'MATCH', note: 'Etiket yanlış basılmış', decision: 'VERIFIED', recalcPending: 'MEASUREMENT' });
    expect(l1).toMatchObject({ measurementId: v2.id, status: 'DIFF', recalcPending: null });
    // kullanıcı donmuş satırda "yeni ölçümle hesapla" der: sabit eşleşme yeni sürümü izler, karar korunur
    await recalculate(app, admin.auth, invoiceId, { basis: 'pinned', lineIds: [l2!.id] });
    [l1, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, status: 'DIFF', note: 'Etiket yanlış basılmış', decision: 'VERIFIED', recalcPending: null });
    expect(l2!.measurement!.weightKg).toBe(2);

    // deleting the measurement: pinned line becomes unmatched but keeps the pin; restore brings it back
    // (donmuş satırda silme rakamı değiştirmez: satır işaretlenir; "yeni ölçümle hesapla" eşleşmeyi koparır ama sabitleme durur)
    await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${v2.id}`, headers: worker.auth });
    [l1, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, status: 'DIFF', recalcPending: 'MEASUREMENT', measurement: null });
    expect(l1).toMatchObject({ measurementId: null, status: 'UNMATCHED' });
    await recalculate(app, admin.auth, invoiceId, { basis: 'pinned', lineIds: [l2!.id] });
    [, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, status: 'UNMATCHED', measurement: null, decision: 'VERIFIED', recalcPending: null });
    await app.inject({ method: 'POST', url: `/api/deciship/measurements/${v2.id}/restore`, headers: worker.auth });
    [, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, status: 'UNMATCHED', recalcPending: 'MEASUREMENT' });
    await recalculate(app, admin.auth, invoiceId, { basis: 'pinned', lineIds: [l2!.id] });
    [, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, status: 'DIFF', recalcPending: null });

    // a full invoice recompare keeps the pin
    await app.inject({ method: 'POST', url: `/api/deciship/invoices/${invoiceId}/recompare`, headers: admin.auth });
    [, l2] = await lines(app, admin.auth, invoiceId);
    expect(l2).toMatchObject({ measurementPinned: true, measurementId: v2.id, note: 'Etiket yanlış basılmış', decision: 'VERIFIED' });

    // unpin → back to tracking-number matching (none for this tracking no)
    const unpin = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l2!.id}`, headers: admin.auth, payload: { measurementId: null, note: null } });
    expect(unpin.json().line).toMatchObject({ measurementPinned: false, measurementId: null, status: 'UNMATCHED' });
    expect(unpin.json().line.note).not.toBe('Etiket yanlış basılmış');

    const missing = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l2!.id}`, headers: admin.auth, payload: { measurementId: 'nope' } });
    expect(missing.statusCode).toBe(404);
    const accepted = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${l2!.id}`, headers: admin.auth, payload: { decision: 'ACCEPTED' } });
    expect(accepted.json().error.code).toBe('REASON_REQUIRED');

    const actions = (await inCompany(admin.auth, () => prisma.auditLog.findMany({ where: { entityId: l2!.id }, select: { action: true } }))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['invoiceLine.pin', 'invoiceLine.unpin']));
    expect((await inCompany(admin.auth, () => prisma.auditLog.count({ where: { entityId: l1!.id, action: 'invoiceLine.trackingFix' } })))).toBe(3);
  });
});
