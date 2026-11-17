/**
 * Mesaj 4, geçmiş sonuçlar donsun: fatura uçları (routes/invoices.ts).
 *
 *  - İçe aktarılan fatura (örnek fatura dahil) dayanağını taşır: tarife sürümü + o günkü ayar; satırlar aynı sürümü.
 *  - `POST /invoices/:id/recalculate/preview` yazmaz; `POST /invoices/:id/recalculate` önizlemenin `token`'ıyla yazar,
 *    eski rakam `prevResult`'ta kalır; arada bir şey değiştiyse 409 PREVIEW_STALE.
 *  - Etkin itiraz: `tariff`, `rules` ve `patch` 409 INVOICE_HAS_DISPUTE; `pinned` serbest, itirazdaki satır yazılmaz;
 *    `lineIds` içinde itirazdaki satır 409 LINE_IN_DISPUTE. `PATCH /invoices/:id` dört alanı kilitler.
 *  - Donmuş (kararlı) satır ölçüm değişince yazılmaz, işaretlenir; "yeni ölçümle hesapla" kararı korur.
 *  - Fiyat izni olmayan kişiye eski rakamlar da gitmez.
 *
 * Hesap motorunun kendi sınamaları: frozenResults.test.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { stripMoney } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { applyRecompare } from '../src/services/compare.ts';
import { lineInclude, serializeLine } from '../src/services/invoiceSerialize.ts';
import { caller, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { createWorker, findMoneyKeys, getApp, inCompany, issueIdentity, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { applyRecalc, patchInvoice, previewRecalc, recalculate, type RecalcPreview } from './recalcHelpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
type Dims = { lengthCm: number; widthCm: number; heightCm: number };

/** Yalnız rakam: normalleştirme numarayı değiştirmez. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** Desi başına `perKg` TL; yakıt ve ek ücret yok: 3 desi → 3 × perKg. */
const tariffOf = (carrierId: string, perKg: number, over: Record<string, unknown> = {}) => ({
  carrierId,
  name: 'Sabit',
  currency: 'TRY',
  divisor: 3000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [{ upto: null, step: 1 }],
  discountPct: 0,
  fuelPct: 0,
  active: true,
  isDefault: true,
  zones: [{ country: '*', zone: 'TR' }],
  rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * perKg })),
  overflow: [],
  surcharges: [],
  ...over,
});

/** 30×20×15 cm = 3 desi; 26×25×16 = 4 desi (kenar payıyla da). Fatura satırı 5 desi, 50 TL: 10 TL/desi tarifede beklenen 30 / 40. */
const THREE_DESI: Dims = { lengthCm: 30, widthCm: 20, heightCm: 15 };
const FOUR_DESI: Dims = { lengthCm: 26, widthCm: 25, heightCm: 16 };

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; orgName: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance, opts: { tariff?: boolean } = {}): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Hesap '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  let tariffId = '';
  if (opts.tariff !== false) tariffId = await addTariff({ app, auth: admin.auth }, carrierId, 10);
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, orgName: admin.orgName, carrierId, tariffId };
}

async function addTariff(f: { app: FastifyInstance; auth: Auth }, carrierId: string, perKg: number, over: Record<string, unknown> = {}) {
  const t = await f.app.inject({ method: 'POST', url: `${API}/tariffs`, headers: f.auth, payload: tariffOf(carrierId, perKg, over) });
  expect(t.statusCode, t.body).toBe(201);
  return t.json().tariff.id as string;
}

/** Tarifeyi yerinde değiştirir (yeni sürüm doğar). Ucuzlatınca beklenen düşer; pahalanınca değişmez (SPEC §3.8). */
async function reprice(f: Firm, perKg: number) {
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg) });
  expect(r.statusCode, r.body).toBe(200);
}

async function measure(f: { app: FastifyInstance; worker: Auth }, tracking: string, dims: Dims = THREE_DESI) {
  const p = measurementPayload({ trackingRaw: tracking, ...dims, weightKg: 2 });
  const r = await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.id as string;
}

/** Düzeltme: yeni sürüm doğar, eskisinin yerini alır. Yeni sürümün kimliğini döndürür. */
async function correct(f: { app: FastifyInstance; auth: Auth; worker: Auth }, tracking: string, dims: Dims) {
  const head = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }));
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/measurements/${head.id}`, headers: f.worker, payload: dims });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().measurement.id as string;
}

async function importInvoice(f: Firm, trackings: string[], opts: { carrierId?: string; tariffId?: string } = {}) {
  const carrierId = opts.carrierId ?? f.carrierId;
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;50`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await f.app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await f.app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: f.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      ...(opts.tariffId ? { tariffId: opts.tariffId } : {}),
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice.id as string;
}

type Line = {
  id: string;
  rowIndex: number;
  trackingNo: string;
  status: string;
  decision: string;
  expectedAmount: number | null;
  diffAmount: number | null;
  measurementId: string | null;
  tariffId: string | null;
  prevResult: { status: string; diffTypes: string[]; expectedAmount: number | null; diffAmount: number | null; ourChargeableKg: number | null; at: string; cause: string } | null;
  recalcPending: string | null;
  note: string | null;
  recalcPendingAt: string | null;
};
async function lines(f: { app: FastifyInstance; auth: Auth }, invoiceId: string, query = '') {
  const r = await f.app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines${query}`, headers: f.auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as Line[];
}
async function detail(f: { app: FastifyInstance; auth: Auth }, invoiceId: string) {
  const r = await f.app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}`, headers: f.auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().invoice;
}
async function decide(f: { app: FastifyInstance; auth: Auth }, lineId: string, decision: 'VERIFIED' | 'OPEN' = 'VERIFIED') {
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: f.auth, payload: { decision } });
  expect(r.statusCode, r.body).toBe(200);
}
/** Faturanın ve satırlarının veritabanındaki hâli: "hiçbir şey yazılmadı" karşılaştırması için. */
const dbState = (auth: Auth, invoiceId: string) =>
  inCompany(auth, async () =>
    JSON.stringify({
      invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
      lines: await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }),
    }),
  );
const audits = (auth: Auth, invoiceId: string, action: string) =>
  inCompany(auth, () => prisma.auditLog.findMany({ where: { entityId: invoiceId, action }, orderBy: { createdAt: 'asc' } }));
const errorOf = (r: { statusCode: number; json: () => { error?: { code?: string } } }) => [r.statusCode, r.json().error?.code];

describe('içe aktarma dayanağı yazar', () => {
  it('fatura tarifenin bugünkü sürümünü ve o günkü ayarı, satırlar aynı sürümü taşır; durum CURRENT', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t, trackingNo()]);
    const { inv, rows, tariff } = await inCompany(f.auth, async () => ({
      inv: await prisma.invoice.findUniqueOrThrow({ where: { id } }),
      rows: await prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { rowIndex: 'asc' } }),
      tariff: await prisma.tariff.findUniqueOrThrow({ where: { id: f.tariffId } }),
    }));
    expect(tariff.currentRevisionId).toBeTruthy();
    expect(inv.tariffRevisionId).toBe(tariff.currentRevisionId);
    expect(inv.compareSettings).toMatchObject({ edgeTolCm: expect.any(Number), weightTolKg: expect.any(Number), amountTol: expect.any(Number), fxTolerancePct: expect.any(Number), unknownSurchargesAsDiff: expect.any(Boolean), companyCurrency: 'TRY' });
    expect(rows.map((l) => [l.status, l.tariffRevisionId])).toEqual([
      ['DIFF', tariff.currentRevisionId],
      ['UNMATCHED', tariff.currentRevisionId],
    ]);
    const d = await detail(f, id);
    expect(d.basis).toMatchObject({ state: 'CURRENT', tariffName: 'Sabit' });
    expect(typeof d.basis.calculatedAt).toBe('string');
    expect(d.totals.pendingLines).toBe(0);
    const [l] = await lines(f, id);
    expect(l).toMatchObject({ expectedAmount: 30, diffAmount: 20, prevResult: null, recalcPending: null, recalcPendingAt: null });
  });

  it('örnek fatura (kurulum) da dayanağını taşır', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'ornek.csv', contentType: 'text/csv', data: Buffer.from(['Takip No;Desi;Tutar', `${t};5;50`, `${trackingNo()};3;30`].join('\n')) },
    ]);
    const r = await app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().invoice.id as string;
    const { inv, rows, tariff } = await inCompany(f.auth, async () => ({
      inv: await prisma.invoice.findUniqueOrThrow({ where: { id } }),
      rows: await prisma.invoiceLine.findMany({ where: { invoiceId: id } }),
      tariff: await prisma.tariff.findUniqueOrThrow({ where: { id: f.tariffId } }),
    }));
    expect(inv.isSample).toBe(true);
    expect(inv.tariffRevisionId).toBe(tariff.currentRevisionId);
    expect(inv.compareSettings).toMatchObject({ companyCurrency: 'TRY' });
    expect(rows.length).toBe(2);
    expect(rows.every((l) => l.tariffRevisionId === tariff.currentRevisionId)).toBe(true);
  });

  it('tarifesiz taşıyıcının faturası dayanaksızdır (NONE); tarife gelince "Yeniden karşılaştır" onu benimser', async () => {
    const app = await getApp();
    const f = await firm(app, { tariff: false });
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const before = await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
    expect(before.tariffRevisionId).toBeNull();
    expect(before.compareSettings).toMatchObject({ companyCurrency: 'TRY' });
    expect((await detail(f, id)).basis).toMatchObject({ state: 'NONE', tariffName: null });
    expect((await lines(f, id))[0]).toMatchObject({ status: 'NO_TARIFF' });

    const tariffId = await addTariff(f, f.carrierId, 10);
    // ölçüm değişikliği (otomatik tetikleyici) dayanağı benimsemez
    await correct(f, t, FOUR_DESI);
    expect((await lines(f, id))[0]).toMatchObject({ status: 'NO_TARIFF' });
    // kullanıcının başlattığı yeniden karşılaştırma benimser
    const rc = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recompare`, headers: f.auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(rc.json()).toMatchObject({ pendingLines: 0, invoice: { basis: { state: 'CURRENT', tariffName: 'Sabit' } } });
    expect((await lines(f, id))[0]).toMatchObject({ status: 'DIFF', expectedAmount: 40, tariffId });
  });
});

describe('recalculate: önizleme → onay', () => {
  it('önizleme yazmaz; onay yazar, fatura yeni sürüme bağlanır, eski rakam prevResult’ta kalır, denetim kaydı düşer', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2, trackingNo()]);
    const oldRev = (await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId;
    await reprice(f, 8);
    // tarife değişti: fatura hesaplandığı sürümle duruyor
    expect((await detail(f, id)).basis.state).toBe('TARIFF_CHANGED');
    expect((await lines(f, id)).map((l) => l.expectedAmount)).toEqual([30, 30, null]);

    const state = await dbState(f.auth, id);
    const p = await previewRecalc(app, f.auth, id, { basis: 'tariff' });
    expect(p.statusCode, p.body).toBe(200);
    const preview = p.json() as RecalcPreview;
    const newRev = (await inCompany(f.auth, () => prisma.tariff.findUniqueOrThrow({ where: { id: f.tariffId } }))).currentRevisionId;
    expect(newRev).not.toBe(oldRev);
    expect(preview.token).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.basis).toMatchObject({
      from: { tariffId: f.tariffId, tariffName: 'Sabit', revisionId: oldRev, revisionAt: expect.any(String) },
      to: { tariffId: f.tariffId, tariffName: 'Sabit', revisionId: newRev, revisionAt: expect.any(String) },
      rulesChanged: false,
    });
    expect(preview).toMatchObject({ changedLines: 2, frozenChanged: 0, skippedInDispute: 0 });
    expect(preview.totals.before).toMatchObject({ overchargeTotal: 40, expectedTotal: 60 });
    expect(preview.totals.after).toMatchObject({ overchargeTotal: 52, expectedTotal: 48 });
    expect(preview.lines.map((l) => [l.trackingNo, l.decision, l.before, l.after])).toEqual([
      [t1, 'OPEN', { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 30, diffAmount: 20 }, { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 24, diffAmount: 26 }],
      [t2, 'OPEN', { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 30, diffAmount: 20 }, { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 24, diffAmount: 26 }],
    ]);
    // önizleme hiçbir şey yazmadı; aynı istek aynı özeti verir
    expect(await dbState(f.auth, id)).toBe(state);
    expect((await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json().token).toBe(preview.token);
    expect(await audits(f.auth, id, 'invoice.recalculate')).toHaveLength(0);

    const r = await applyRecalc(app, f.auth, id, { basis: 'tariff', token: preview.token });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().invoice).toMatchObject({ id, basis: { state: 'CURRENT' }, totals: { overchargeTotal: 52, expectedTotal: 48, pendingLines: 0 } });
    const after = await lines(f, id);
    expect(after.map((l) => [l.expectedAmount, l.diffAmount])).toEqual([[24, 26], [24, 26], [null, null]]);
    for (const l of after.slice(0, 2)) {
      expect(l.prevResult).toEqual({ status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 30, diffAmount: 20, ourChargeableKg: 3, at: expect.any(String), cause: 'TARIFF' });
    }
    expect(after[2]!.prevResult).toBeNull();
    const stored = await inCompany(f.auth, async () => ({
      inv: await prisma.invoice.findUniqueOrThrow({ where: { id } }),
      rows: await prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { rowIndex: 'asc' } }),
    }));
    expect(stored.inv.tariffRevisionId).toBe(newRev);
    expect(stored.rows.map((l) => l.tariffRevisionId)).toEqual([newRev, newRev, newRev]);

    const log = await audits(f.auth, id, 'invoice.recalculate');
    expect(log).toHaveLength(1);
    expect(log[0]!.data).toMatchObject({
      basis: 'tariff',
      cause: 'TARIFF',
      revisionFrom: oldRev,
      revisionTo: newRev,
      changedLines: 2,
      totalsBefore: { overchargeTotal: 40 },
      totalsAfter: { overchargeTotal: 52 },
    });
    // artık güncel: önizlemede değişen satır yok
    expect((await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json()).toMatchObject({ changedLines: 0, lines: [] });
  });

  it('bayat token: önizlemeden sonra karar ya da ölçüm değiştiyse 409 PREVIEW_STALE, hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    await reprice(f, 8);
    const first = (await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json() as RecalcPreview;

    // uydurma özet
    expect(errorOf(await applyRecalc(app, f.auth, id, { basis: 'tariff', token: 'x'.repeat(64) }))).toEqual([409, 'PREVIEW_STALE']);
    // başka dayanağın özeti
    expect(errorOf(await applyRecalc(app, f.auth, id, { basis: 'pinned', token: first.token }))).toEqual([409, 'PREVIEW_STALE']);

    // önizlemeden sonra ölçüm değişti (açık satır yeni ölçümle hesaplandı): eski önizleme geçersiz
    await correct(f, t1, FOUR_DESI);
    const state = await dbState(f.auth, id);
    const stale = await applyRecalc(app, f.auth, id, { basis: 'tariff', token: first.token });
    expect(errorOf(stale)).toEqual([409, 'PREVIEW_STALE']);
    expect(await dbState(f.auth, id)).toBe(state);
    expect(await audits(f.auth, id, 'invoice.recalculate')).toHaveLength(0);

    // önizlemeden sonra tarife yeniden değişti: hedef sürüm başka, eski önizleme geçersiz
    const second = (await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json() as RecalcPreview;
    expect(second.token).not.toBe(first.token);
    await reprice(f, 7);
    expect(errorOf(await applyRecalc(app, f.auth, id, { basis: 'tariff', token: second.token }))).toEqual([409, 'PREVIEW_STALE']);
    expect(await dbState(f.auth, id)).toBe(state);

    // Önizlemeden sonra verilen karar özeti bozmaz: yazılacak rakamlar aynıdır, karar korunur (tümü kipinde kararlı satır da yazılır).
    const third = (await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json() as RecalcPreview;
    expect(third).toMatchObject({ changedLines: 2, frozenChanged: 0 });
    await decide(f, (await lines(f, id))[1]!.id);
    const done = await applyRecalc(app, f.auth, id, { basis: 'tariff', token: third.token });
    expect(done.statusCode, done.body).toBe(200);
    // 7 TL/desi: 4 desi → 28, 3 desi → 21
    expect((await lines(f, id)).map((l) => [l.decision, l.expectedAmount])).toEqual([['OPEN', 28], ['VERIFIED', 21]]);
    expect(await audits(f.auth, id, 'invoice.recalculate')).toHaveLength(1);
  });

  it('tarifesi boş fatura: tariff onayı bağlandığı tarifeyi yeniden hesapla aynı işlemde yazar; hesap yazılmazsa tarife de yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app, { tariff: false });
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const tariffId = await addTariff(f, f.carrierId, 10);
    const rev = (await inCompany(f.auth, () => prisma.tariff.findUniqueOrThrow({ where: { id: tariffId } }))).currentRevisionId;
    const row = () => inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
    expect(await row()).toMatchObject({ tariffId: null, tariffRevisionId: null });

    // motor: onWrite yazılacak dayanağı alır ve aynı işlemdedir: sonradan hata olursa tarife ataması da geri alınır
    let seen: unknown = null;
    await expect(
      inCompany(f.auth, () =>
        applyRecompare(id, {
          basis: 'tariff',
          scope: 'all',
          onWrite: async (tx, target) => {
            seen = target;
            await tx.invoice.updateMany({ where: { id, tariffId: null }, data: { tariffId } });
            throw new Error('geri al');
          },
        }),
      ),
    ).rejects.toThrow('geri al');
    expect(seen).toMatchObject({ tariffRevisionId: rev });
    expect(await row()).toMatchObject({ tariffId: null, tariffRevisionId: null });

    // bayat önizleme: hiçbir şey yazılmaz, tarife de
    const stale = (await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json() as RecalcPreview;
    await correct(f, t, FOUR_DESI);
    const state = await dbState(f.auth, id);
    expect(errorOf(await applyRecalc(app, f.auth, id, { basis: 'tariff', token: stale.token }))).toEqual([409, 'PREVIEW_STALE']);
    expect(await dbState(f.auth, id)).toBe(state);

    // onay: dayanak, satırlar ve tarife birlikte
    const done = await recalculate(app, f.auth, id, { basis: 'tariff' });
    expect(done.invoice).toMatchObject({ tariffId, basis: { state: 'CURRENT' } });
    expect(await row()).toMatchObject({ tariffId, tariffRevisionId: rev });
    expect((await lines(f, id))[0]).toMatchObject({ status: 'DIFF', expectedAmount: 40, tariffId });
  });

  it('gövde doğrulaması: dayanak ve token zorunlu; başka faturanın satırı ve başka firmanın faturası 404', async () => {
    const app = await getApp();
    const f = await firm(app);
    const other = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const elsewhere = await importInvoice(f, [trackingNo()]);
    const foreign = (await lines(f, elsewhere))[0]!.id;
    const post = (url: string, payload: unknown, auth = f.auth) => app.inject({ method: 'POST', url: `${API}/invoices/${id}/${url}`, headers: auth, payload: payload as object });

    expect((await post('recalculate/preview', {})).statusCode).toBe(400);
    expect((await post('recalculate/preview', { basis: 'yeni' })).statusCode).toBe(400);
    expect((await post('recalculate/preview', { basis: 'pinned', lineIds: [] })).statusCode).toBe(400);
    expect((await post('recalculate', { basis: 'pinned' })).statusCode).toBe(400);
    expect((await post('recalculate/preview', { basis: 'pinned', lineIds: [foreign] })).statusCode).toBe(404);
    expect((await post('recalculate', { basis: 'pinned', lineIds: [foreign], token: 'x' })).statusCode).toBe(404);
    expect((await post('recalculate/preview', { basis: 'pinned' }, other.auth)).statusCode).toBe(404);
    expect((await post('recalculate', { basis: 'pinned', token: 'x' }, other.auth)).statusCode).toBe(404);
    // önizlemedeki başka firmanın tarifesi / taşıyıcısı
    expect((await post('recalculate/preview', { basis: 'pinned', patch: { tariffId: other.tariffId } })).statusCode).toBe(404);
    expect((await post('recalculate/preview', { basis: 'pinned', patch: { carrierId: other.carrierId } })).statusCode).toBe(404);
    // eski kip adı yok
    expect((await post('recalculate/preview', { basis: 'current' })).statusCode).toBe(400);
  });

  it('satır seçimi ve düzenleme önizlemesi yalnız pinned ile: tariff / rules ile 400, hiçbir şey yazılmaz (inceleme 1)', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    const [l1] = await lines(f, id);
    await reprice(f, 8);
    const state = await dbState(f.auth, id);
    for (const basis of ['tariff', 'rules'] as const) {
      const p = await previewRecalc(app, f.auth, id, { basis, lineIds: [l1!.id] });
      expect(errorOf(p), basis).toEqual([400, 'VALIDATION']);
      expect(p.json().error.details[0]).toMatchObject({ path: 'lineIds' });
      expect(errorOf(await applyRecalc(app, f.auth, id, { basis, lineIds: [l1!.id], token: 'x' })), basis).toEqual([400, 'VALIDATION']);
      expect(errorOf(await previewRecalc(app, f.auth, id, { basis, patch: { invoiceDate: '2026-10-14' } })), basis).toEqual([400, 'VALIDATION']);
    }
    expect(await dbState(f.auth, id)).toBe(state);
    // pinned satır seçimi faturanın dayanağını değiştirmez: fatura eski sürümde kalır, durum TARIFF_CHANGED
    await recalculate(app, f.auth, id, { basis: 'pinned', lineIds: [l1!.id] });
    expect((await detail(f, id)).basis.state).toBe('TARIFF_CHANGED');
  });

  it('yetki: yalnız satır kararı izni (deciship.lines.decide); muhasebe ve ölçüm rolü 403', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const member = (role: string) => issueIdentity({ companyId: f.companyId, orgName: f.orgName, role, name: `Rol ${role}` });
    const state = await dbState(f.auth, id);
    for (const role of ['ACCOUNTING', 'MEASURE']) {
      const m = await member(role);
      const p = await previewRecalc(app, m.auth, id, { basis: 'pinned' });
      expect(errorOf(p), role).toEqual([403, 'FORBIDDEN']);
      const a = await applyRecalc(app, m.auth, id, { basis: 'pinned', token: 'x' });
      expect(errorOf(a), role).toEqual([403, 'FORBIDDEN']);
    }
    expect(await dbState(f.auth, id)).toBe(state);
    const auditor = await member('AUDITOR');
    const ok = await recalculate(app, auditor.auth, id, { basis: 'pinned' });
    expect(ok.preview.changedLines).toBe(0);
    expect(ok.invoice.id).toBe(id);
  });
});

describe('donmuş satır: ölçüm değişince', () => {
  it('kararlı satır yazılmaz, işaretlenir; ?recalcPending=true süzer; "yeni ölçümle hesapla" kararı korur', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    const m1 = await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    const [l1, l2] = await lines(f, id);
    await decide(f, l1!.id);

    const m1v2 = await correct(f, t1, FOUR_DESI);
    await correct(f, t2, FOUR_DESI);
    const now = await lines(f, id);
    // kararlı satır eski ölçümde ve eski rakamda; açık satır yeni ölçümle, eski rakamı bir adım geride
    expect(now[0]).toMatchObject({ decision: 'VERIFIED', measurementId: m1, expectedAmount: 30, diffAmount: 20, recalcPending: 'MEASUREMENT', prevResult: null });
    expect(typeof now[0]!.recalcPendingAt).toBe('string');
    expect(now[1]).toMatchObject({ decision: 'OPEN', expectedAmount: 40, diffAmount: 10, recalcPending: null, prevResult: { expectedAmount: 30, diffAmount: 20, cause: 'MEASUREMENT' } });
    expect((await detail(f, id)).totals.pendingLines).toBe(1);

    // süzgeç
    expect((await lines(f, id, '?recalcPending=true')).map((l) => l.id)).toEqual([l1!.id]);
    expect((await lines(f, id, '?recalcPending=false')).map((l) => l.id)).toEqual([l1!.id, l2!.id]);
    expect((await lines(f, id, '?recalcPending=true&decision=OPEN'))).toEqual([]);

    // plan riski 4: ölçümün yeni sürümü, donmuş satır eski sürümde kalsa da faturasını gösterir
    const mDetail = await app.inject({ method: 'GET', url: `${API}/measurements/${m1v2}`, headers: f.auth });
    expect(mDetail.json().measurement).toMatchObject({ invoiceStatus: 'DIFF' });
    expect(mDetail.json().measurement.invoiceLines.map((x: { id: string }) => x.id)).toEqual([l1!.id]);
    const mList = await app.inject({ method: 'GET', url: `${API}/measurements?q=${t1}`, headers: f.auth });
    expect(mList.json().items).toHaveLength(1);
    expect(mList.json().items[0]).toMatchObject({ id: m1v2, invoiceStatus: 'DIFF' });

    // "Yeniden karşılaştır" donmuş satırı yazmaz, bekleyeni sayar
    const rc = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recompare`, headers: f.auth });
    expect(rc.json()).toMatchObject({ pendingLines: 1, invoice: { totals: { pendingLines: 1 } } });
    expect((await lines(f, id))[0]).toMatchObject({ expectedAmount: 30, recalcPending: 'MEASUREMENT' });

    // "yeni ölçümle hesapla": yalnız o satır, karar korunur
    const done = await recalculate(app, f.auth, id, { basis: 'pinned', lineIds: [l1!.id] });
    expect(done.preview).toMatchObject({ changedLines: 1, frozenChanged: 1, skippedInDispute: 0 });
    expect(done.preview.lines).toEqual([
      { id: l1!.id, rowIndex: l1!.rowIndex, trackingNo: t1, decision: 'VERIFIED', before: { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 30, diffAmount: 20 }, after: { status: 'DIFF', diffTypes: expect.any(Array), expectedAmount: 40, diffAmount: 10 } },
    ]);
    expect(done.invoice.totals.pendingLines).toBe(0);
    const [after] = await lines(f, id);
    expect(after).toMatchObject({ decision: 'VERIFIED', measurementId: m1v2, expectedAmount: 40, diffAmount: 10, recalcPending: null, recalcPendingAt: null, prevResult: { expectedAmount: 30, diffAmount: 20, ourChargeableKg: 3, cause: 'MEASUREMENT' } });
    expect(await lines(f, id, '?recalcPending=true')).toEqual([]);
    expect((await audits(f.auth, id, 'invoice.recalculate')).at(-1)!.data).toMatchObject({ basis: 'pinned', cause: 'MEASUREMENT', changedLines: 1, lineIds: 1 });
  });

  it('satır düzeltmesi (takip no, elle eşleştirme) kararlı satırı da hesaplar; karar korunur, eski rakam prevResult’ta', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2, other] = [trackingNo(), trackingNo(), trackingNo()];
    const m1 = await measure(f, t1);
    const m2 = await measure(f, t2, FOUR_DESI);
    await measure(f, other);
    const id = await importInvoice(f, [t1, other]);
    const [l1, l2] = await lines(f, id);
    await decide(f, l1!.id);
    await decide(f, l2!.id);
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l1!.id}`, headers: f.auth, payload });

    // takip no düzeltmesi: satır yeni numaranın ölçümüyle (4 desi) hesaplanır
    const fix = await patch({ trackingNo: t2 });
    expect(fix.statusCode, fix.body).toBe(200);
    expect(fix.json().line).toMatchObject({ trackingNo: t2, decision: 'VERIFIED', measurementId: m2, expectedAmount: 40, diffAmount: 10, recalcPending: null, prevResult: { expectedAmount: 30, diffAmount: 20, cause: 'TRACKING' } });
    expect(fix.json().totals).toMatchObject({ pendingLines: 0, verifiedTotal: 30 });

    // elle eşleştirme: ilk ölçüme sabitlenir (3 desi)
    const pin = await patch({ measurementId: m1 });
    expect(pin.statusCode, pin.body).toBe(200);
    expect(pin.json().line).toMatchObject({ decision: 'VERIFIED', measurementPinned: true, measurementId: m1, expectedAmount: 30, diffAmount: 20, prevResult: { expectedAmount: 40, diffAmount: 10, cause: 'MATCH' } });

    // öbür kararlı satıra dokunulmadı
    expect((await lines(f, id))[1]).toMatchObject({ id: l2!.id, decision: 'VERIFIED', expectedAmount: 30, prevResult: null, recalcPending: null });
  });
});

describe('itirazı gönderilmiş faturada kilit', () => {
  /** Dört "Fark var" satır: ikisi gönderilmiş itirazda (A, B), biri sonradan listeye alınmış (C), biri açık (D). */
  async function disputed(app: FastifyInstance) {
    const c = await disputeCompany(app);
    const call = caller(app);
    const inv = await invoiceWithDiffs(app, c, [100, 100, 100, 100], { verify: 2 });
    const sent = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const [A, B, C, D] = inv.lines;
    const f = { app, auth: c.admin.auth, worker: c.worker.auth };
    await decide(f, C!.id);
    return { c, call, f, id: inv.invoiceId, A: A!, B: B!, C: C!, D: D!, dispute: sent.json().dispute as { active: { id: string; version: number } } };
  }
  const invoiceRow = (c: DisputeCompany, id: string) => inCompany(c.admin.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));

  it('tariff, rules ve patch 409 INVOICE_HAS_DISPUTE; pinned serbest, itirazdaki satır yazılmaz; lineIds içinde itirazlı satır 409 LINE_IN_DISPUTE', async () => {
    const app = await getApp();
    const { c, call, f, id, A, B, C, D, dispute } = await disputed(app);
    const before = (await lines(f, id)).map((l) => l.expectedAmount);

    // ölçümler değişti: itirazdaki A ve kararlı C donmuş (işaretlenir), açık D yeni ölçümle
    await correct(f, A.trackingNo, FOUR_DESI);
    await correct(f, C.trackingNo, FOUR_DESI);
    await correct(f, D.trackingNo, FOUR_DESI);
    let now = await lines(f, id);
    expect(now.map((l) => l.recalcPending)).toEqual(['MEASUREMENT', null, 'MEASUREMENT', null]);
    expect(now.map((l) => l.expectedAmount)).toEqual([before[0], before[1], before[2], now[3]!.expectedAmount]);
    expect(now[3]!.expectedAmount).toBeGreaterThan(before[3]!);
    const fourDesi = now[3]!.expectedAmount;

    // plan riski 6: gönderilecek satırlardan yeniden hesap bekleyenler sayılır (gönderim engellenmez)
    expect((await detail(f, id)).dispute).toMatchObject({ status: 'SENT', recalcPendingLines: 2 });

    // tariff, rules ve patch: 409, önizlemede de onayda da
    const state = await dbState(c.admin.auth, id);
    for (const basis of ['tariff', 'rules'] as const) {
      expect(errorOf(await previewRecalc(app, c.admin.auth, id, { basis }))).toEqual([409, 'INVOICE_HAS_DISPUTE']);
      expect(errorOf(await applyRecalc(app, c.admin.auth, id, { basis, token: 'x' }))).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    }
    expect(errorOf(await previewRecalc(app, c.admin.auth, id, { basis: 'pinned', patch: { invoiceDate: trDay(-5) } }))).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    // lineIds içinde itirazdaki satır: 409, önce itiraz geri çekilir
    expect(errorOf(await previewRecalc(app, c.admin.auth, id, { basis: 'pinned', lineIds: [A.id] }))).toEqual([409, 'LINE_IN_DISPUTE']);
    expect(errorOf(await previewRecalc(app, c.admin.auth, id, { basis: 'pinned', lineIds: [C.id, A.id] }))).toEqual([409, 'LINE_IN_DISPUTE']);
    expect(errorOf(await applyRecalc(app, c.admin.auth, id, { basis: 'pinned', lineIds: [A.id], token: 'x' }))).toEqual([409, 'LINE_IN_DISPUTE']);
    expect(await dbState(c.admin.auth, id)).toBe(state);

    // pinned (tümü) serbest: kararlı C yazılır, itirazdaki A yazılmaz ve sayılır
    const done = await recalculate(app, c.admin.auth, id, { basis: 'pinned' });
    expect(done.preview).toMatchObject({ changedLines: 1, frozenChanged: 1, skippedInDispute: 1 });
    expect(done.preview.lines.map((l) => l.id)).toEqual([C.id]);
    now = await lines(f, id);
    expect(now[0]).toMatchObject({ id: A.id, decision: 'VERIFIED', expectedAmount: before[0], recalcPending: 'MEASUREMENT', prevResult: null });
    expect(now[1]).toMatchObject({ id: B.id, expectedAmount: before[1], recalcPending: null });
    expect(now[2]).toMatchObject({ id: C.id, decision: 'VERIFIED', expectedAmount: fourDesi, recalcPending: null, prevResult: { expectedAmount: before[2], cause: 'OTHER' } });
    expect(done.invoice.totals.pendingLines).toBe(1);
    expect(done.invoice.dispute.recalcPendingLines).toBe(1);

    // itiraz geri çekilince A da "yeni ölçümle hesapla" ile geçer; karar korunur
    const w = await call(c.admin.auth, 'POST', `/disputes/${dispute.active.id}/withdraw`, { version: dispute.active.version, reason: 'ölçüm düzeltildi' });
    expect(w.statusCode, w.body).toBe(200);
    const again = await recalculate(app, c.admin.auth, id, { basis: 'pinned', lineIds: [A.id] });
    expect(again.preview).toMatchObject({ changedLines: 1, frozenChanged: 1 });
    expect((await lines(f, id))[0]).toMatchObject({ decision: 'VERIFIED', expectedAmount: fourDesi, recalcPending: null, prevResult: { expectedAmount: before[0], cause: 'MEASUREMENT' } });
    expect((await detail(f, id)).dispute.recalcPendingLines).toBe(0);
  });

  it('PATCH /invoices/:id: taşıyıcı, tarih, tarife ve para birimi ayrı ayrı 409; fatura no ve dönem serbest', async () => {
    const app = await getApp();
    const { c, call, id } = await disputed(app);
    const otherCarrier = await call(c.admin.auth, 'POST', '/carriers', { code: 'mng', name: uniq('MNG ') });
    expect(otherCarrier.statusCode, otherCarrier.body).toBe(201);
    const otherTariff = await addTariff({ app, auth: c.admin.auth }, c.carrierId, 7, { name: 'İkinci', isDefault: false });
    const state = await dbState(c.admin.auth, id);

    const locked: Record<string, unknown>[] = [{ carrierId: otherCarrier.json().carrier.id }, { invoiceDate: trDay(-6) }, { tariffId: otherTariff }, { currency: 'EUR' }];
    for (const payload of locked) {
      const r = await call(c.admin.auth, 'PATCH', `/invoices/${id}`, payload);
      expect(errorOf(r), JSON.stringify(payload)).toEqual([409, 'INVOICE_HAS_DISPUTE']);
      expect(r.json().error.message, JSON.stringify(payload)).toContain('itiraz geri çekilene dek değişmez');
      // serbest alanla birlikte gelse de hiçbiri yazılmaz
      const mixed = await call(c.admin.auth, 'PATCH', `/invoices/${id}`, { ...payload, invoiceNo: uniq('KARMA') });
      expect(errorOf(mixed), JSON.stringify(payload)).toEqual([409, 'INVOICE_HAS_DISPUTE']);
    }
    expect(await dbState(c.admin.auth, id)).toBe(state);
    expect(await audits(c.admin.auth, id, 'invoice.update')).toHaveLength(0);
    const en = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: { ...c.admin.auth, 'accept-language': 'en' }, payload: { currency: 'EUR' } });
    expect(en.json().error.message).toBe('This invoice has a sent dispute. Carrier, date, tariff and currency cannot change until the dispute is withdrawn');

    // değeri aynı kalan kilitli alan değişiklik değildir; fatura no ve dönem serbest
    const row = await invoiceRow(c, id);
    const no = uniq('YENI');
    const free = await call(c.admin.auth, 'PATCH', `/invoices/${id}`, { invoiceNo: no, periodFrom: trDay(-20), periodTo: trDay(-10), currency: row.currency, carrierId: row.carrierId, tariffId: row.tariffId, invoiceDate: row.invoiceDate.toISOString().slice(0, 10) });
    expect(free.statusCode, free.body).toBe(200);
    expect(free.json().invoice).toMatchObject({ invoiceNo: no, periodFrom: trDay(-20), periodTo: trDay(-10) });
    const log = await audits(c.admin.auth, id, 'invoice.update');
    expect(log).toHaveLength(1);
    expect(log[0]!.data).toMatchObject({ recompared: false, changes: { invoiceNo: { to: no } } });
    // satırlar ve dayanak yerinde
    const after = await invoiceRow(c, id);
    expect([after.tariffRevisionId, after.carrierId, after.currency, +after.invoiceDate]).toEqual([row.tariffRevisionId, row.carrierId, row.currency, +row.invoiceDate]);
  });
});

describe('PATCH /invoices/:id: yeniden hesap', () => {
  it('tarife değişince yeni tarifenin bugünkü sürümüyle (kararlı satır dahil); yalnız tarih değişince sabit dayanakla', async () => {
    const app = await getApp();
    const f = await firm(app);
    const ucuz = await addTariff(f, f.carrierId, 5, { name: 'Ucuz', isDefault: false });
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    const [l1] = await lines(f, id);
    await decide(f, l1!.id);
    const pinnedRev = (await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId;

    // tarife yerinde ucuzladı; yalnız tarih değişen düzeltme faturayı yeni sürüme TAŞIMAZ (sabit dayanak)
    await reprice(f, 8);
    const dated = await patchInvoice(app, f.auth, id, { invoiceDate: '2026-10-16' });
    expect(dated.statusCode, dated.body).toBe(200);
    expect(dated.json().invoice).toMatchObject({ invoiceDate: '2026-10-16', basis: { state: 'TARIFF_CHANGED' } });
    expect((await lines(f, id)).map((l) => l.expectedAmount)).toEqual([30, 30]);
    expect((await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId).toBe(pinnedRev);

    // önizleme (düzenleme penceresi): tarife değişikliği yazılmadan gösterilir
    const state = await dbState(f.auth, id);
    const p = await previewRecalc(app, f.auth, id, { basis: 'pinned', patch: { tariffId: ucuz } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ changedLines: 2, frozenChanged: 1, basis: { from: { tariffId: f.tariffId, tariffName: 'Sabit' }, to: { tariffId: ucuz, tariffName: 'Ucuz' }, rulesChanged: false } });
    expect((p.json() as RecalcPreview).lines.map((l) => [l.decision, l.before.expectedAmount, l.after.expectedAmount])).toEqual([['VERIFIED', 30, 15], ['OPEN', 30, 15]]);
    expect(await dbState(f.auth, id)).toBe(state);

    // kaydet: yeni tarifeyle hesap, fatura ve satırlar onun sürümünde; karar korunur, eski rakam geride
    const set = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: f.auth, payload: { tariffId: ucuz, token: (p.json() as RecalcPreview).token } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().invoice).toMatchObject({ tariffId: ucuz, basis: { state: 'CURRENT', tariffName: 'Ucuz' }, totals: { pendingLines: 0 } });
    const ucuzRev = (await inCompany(f.auth, () => prisma.tariff.findUniqueOrThrow({ where: { id: ucuz } }))).currentRevisionId;
    const stored = await inCompany(f.auth, async () => ({
      inv: await prisma.invoice.findUniqueOrThrow({ where: { id } }),
      rows: await prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { rowIndex: 'asc' } }),
    }));
    expect(stored.inv.tariffRevisionId).toBe(ucuzRev);
    expect(stored.rows.map((l) => [l.tariffId, l.tariffRevisionId])).toEqual([[ucuz, ucuzRev], [ucuz, ucuzRev]]);
    expect((await lines(f, id)).map((l) => [l.decision, l.expectedAmount, l.prevResult?.expectedAmount, l.prevResult?.cause])).toEqual([
      ['VERIFIED', 15, 30, 'TARIFF'],
      ['OPEN', 15, 30, 'TARIFF'],
    ]);
    const recalcs = await audits(f.auth, id, 'invoice.recalculate');
    expect(recalcs.map((a) => (a.data as { basis: string; cause: string }).basis)).toEqual(['pinned', 'tariff']);
    expect(recalcs[1]!.data).toMatchObject({ cause: 'TARIFF', revisionFrom: pinnedRev, revisionTo: ucuzRev, changedLines: 2, via: 'invoice.update' });
  });

  it('tarifesi olmayan taşıyıcıya taşınan fatura eski taşıyıcının fiyatıyla kalmaz: dayanaksız olur', async () => {
    const app = await getApp();
    const f = await firm(app);
    const bare = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: f.auth, payload: { code: 'yurtici', name: uniq('Tarifesiz ') } });
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const moved = await patchInvoice(app, f.auth, id, { carrierId: bare.json().carrier.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().invoice).toMatchObject({ tariffId: null, basis: { state: 'NONE' }, totals: { noTariff: 1 } });
    expect((await lines(f, id))[0]).toMatchObject({ status: 'NO_TARIFF', expectedAmount: null, tariffId: null });
    expect((await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId).toBeNull();
  });
});

describe('fiyat izni olmayana tutar sızmaz', () => {
  it('satırın eski sonucu (prevResult) yalnız durum, an ve nedenle gider; önizlemede tutar kalmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t, trackingNo()]);
    await correct(f, t, FOUR_DESI);
    const row = await inCompany(f.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id, trackingNo: t }, include: lineInclude }));
    expect(row.prevResult).toMatchObject({ expectedAmount: 30, diffAmount: 20 });

    const reqWith = (permissions: string[]) => ({ auth: { permissions }, protocol: 'http', host: 'localhost', headers: {} }) as unknown as FastifyRequest;
    // fiyat izni olan: eski rakamlar
    const priced = serializeLine({ ...row, measurement: null }, reqWith(['deciship.invoices.view', 'deciship.prices.view']));
    expect(priced.prevResult).toEqual({ status: 'DIFF', at: expect.any(String), cause: 'MEASUREMENT', diffTypes: expect.any(Array), expectedAmount: 30, diffAmount: 20, ourChargeableKg: 3 });
    // fiyat izni olmayan: açık alan seti (yalnız durum, an, neden); son güvence (stripMoney) öncesinde de tutar yok
    const bare = serializeLine({ ...row, measurement: null }, reqWith(['deciship.invoices.view']));
    expect(bare.prevResult).toEqual({ status: 'DIFF', at: expect.any(String), cause: 'MEASUREMENT' });
    expect(JSON.stringify(bare.prevResult)).not.toMatch(/Amount|Kg|diffTypes/);
    expect(bare).toMatchObject({ recalcPending: null, recalcPendingAt: null });
    const sent = stripMoney(bare) as Record<string, unknown>;
    for (const key of ['netAmount', 'expectedAmount', 'diffAmount', 'diffTypes', 'breakdown', 'pricingBasis', 'rateDeviationPct', 'fx']) expect(sent, key).not.toHaveProperty(key);
    expect(sent.prevResult).toEqual(bare.prevResult);

    // önizleme yanıtı: fiyat izni olmayan oturumda uygulanan süzgeçten sonra hiçbir para alanı kalmaz
    await reprice(f, 8);
    const preview = (await previewRecalc(app, f.auth, id, { basis: 'tariff' })).json() as RecalcPreview;
    expect(preview.lines[0]!.after.expectedAmount).toBe(32);
    const stripped = stripMoney(preview) as { lines: { before: Record<string, unknown>; after: Record<string, unknown> }[] };
    expect(findMoneyKeys(stripped)).toEqual([]);
    expect(stripped).not.toHaveProperty('totals');
    expect(stripped.lines[0]).toMatchObject({ before: { status: 'DIFF' }, after: { status: 'DIFF' } });
    expect(Object.keys(stripped.lines[0]!.after)).toEqual(['status']);
    expect(JSON.stringify(stripped)).not.toMatch(/overcharge|expected|"32"|:32[,}]|:40[,}]/i);

    // ölçüm rolü (fiyat izni olmayan tek rol) faturaya ve bu uçlara hiç giremez; kendi ölçümünde fatura bilgisi yok
    const worker = { app, auth: f.worker };
    expect((await app.inject({ method: 'GET', url: `${API}/invoices/${id}/lines`, headers: f.worker })).statusCode).toBe(403);
    expect((await previewRecalc(app, f.worker, id, { basis: 'pinned' })).statusCode).toBe(403);
    const mine = await app.inject({ method: 'GET', url: `${API}/measurements?q=${t}`, headers: worker.auth });
    expect(mine.statusCode).toBe(200);
    expect(findMoneyKeys(mine.json())).toEqual([]);
    expect(mine.json().items[0]).not.toHaveProperty('invoiceStatus');
  });
});

describe('PATCH /invoices/:id önizlemeye bağlı (inceleme 2)', () => {
  it('hesabı değiştiren alanda token zorunlu (400); önizlemeden sonra ölçüm değişirse 409 PREVIEW_STALE, hiçbir şey yazılmaz; fatura no tokensız serbest', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    const [l1] = await lines(f, id);
    await decide(f, l1!.id);

    // token yok: 400, alan adı token; serbest alanla birlikte gelse de hiçbiri yazılmaz
    const state = await dbState(f.auth, id);
    for (const payload of [{ invoiceDate: '2026-10-16' }, { currency: 'EUR' }, { invoiceDate: '2026-10-16', invoiceNo: uniq('N') }]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: f.auth, payload });
      expect(errorOf(r), JSON.stringify(payload)).toEqual([400, 'VALIDATION']);
      expect(r.json().error.details[0]).toMatchObject({ path: 'token' });
    }
    expect(await dbState(f.auth, id)).toBe(state);
    expect(await audits(f.auth, id, 'invoice.update')).toHaveLength(0);

    // önizleme "değişiklik yok" der (tarih rakamı etkilemiyor); arada onaylı satırın ölçümü düzeltilir
    const p = await previewRecalc(app, f.auth, id, { basis: 'pinned', patch: { invoiceDate: '2026-10-16' } });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as RecalcPreview).changedLines).toBe(0);
    await correct(f, t1, FOUR_DESI);
    expect((await lines(f, id))[0]).toMatchObject({ decision: 'VERIFIED', expectedAmount: 30, recalcPending: 'MEASUREMENT' });
    const mid = await dbState(f.auth, id);
    const stale = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: f.auth, payload: { invoiceDate: '2026-10-16', token: (p.json() as RecalcPreview).token } });
    expect(errorOf(stale)).toEqual([409, 'PREVIEW_STALE']);
    expect(await dbState(f.auth, id)).toBe(mid);
    expect(await audits(f.auth, id, 'invoice.update')).toHaveLength(0);

    // taze önizleme onaylı satırın yeni rakamını gösterir; onun token'ıyla kaydedilir
    const fresh = (await previewRecalc(app, f.auth, id, { basis: 'pinned', patch: { invoiceDate: '2026-10-16' } })).json() as RecalcPreview;
    expect(fresh.lines.map((l) => [l.id, l.decision, l.before.expectedAmount, l.after.expectedAmount])).toEqual([[l1!.id, 'VERIFIED', 30, 40]]);
    const saved = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: f.auth, payload: { invoiceDate: '2026-10-16', token: fresh.token } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await lines(f, id))[0]).toMatchObject({ decision: 'VERIFIED', expectedAmount: 40, recalcPending: null, prevResult: { expectedAmount: 30 } });

    // fatura no / dönem: hesap yok, token gerekmez
    const no = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: f.auth, payload: { invoiceNo: uniq('NO') } });
    expect(no.statusCode, no.body).toBe(200);
  });

  it('taşıyıcı / tarife değişimi yalnız tarife parçasını günceller, ayar faturadaki kalır (inceleme 4)', async () => {
    const app = await getApp();
    const f = await firm(app);
    const ucuz = await addTariff(f, f.carrierId, 5, { name: 'Ucuz', isDefault: false });
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const before = await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
    const s = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 9 } });
    expect(s.statusCode, s.body).toBe(200);
    const p = (await previewRecalc(app, f.auth, id, { basis: 'pinned', patch: { tariffId: ucuz } })).json() as RecalcPreview;
    expect(p.basis.rulesChanged).toBe(false);
    const r = await patchInvoice(app, f.auth, id, { tariffId: ucuz });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().invoice.basis.state).toBe('RULES_CHANGED');
    const after = await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
    expect(after.compareSettings).toEqual(before.compareSettings);
    expect(after.tariffRevisionId).not.toBe(before.tariffRevisionId);
  });
});

describe('tek fatura: tarife ve ayar ayrı ayrı (inceleme 4)', () => {
  it('ikisi de değişti: "Yeni tarifeyle" yalnız sürümü, ardından "Yeni ayarla" yalnız ayarı günceller; yetki lines.decide (denetleyici de)', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t = trackingNo();
    await measure(f, t);
    const id = await importInvoice(f, [t]);
    const row = () => inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
    const before = await row();
    await reprice(f, 8);
    const s = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 9 } });
    expect(s.statusCode, s.body).toBe(200);
    expect((await detail(f, id)).basis.state).toBe('TARIFF_CHANGED');

    const auditor = await issueIdentity({ companyId: f.companyId, orgName: f.orgName, role: 'AUDITOR', name: 'Denetleyici' });
    const tariff = await recalculate(app, auditor.auth, id, { basis: 'tariff' });
    expect(tariff.preview.basis.rulesChanged).toBe(false);
    expect(tariff.invoice.basis.state).toBe('RULES_CHANGED');
    const mid = await row();
    expect(mid.tariffRevisionId).not.toBe(before.tariffRevisionId);
    expect(mid.compareSettings).toEqual(before.compareSettings);

    // ayar kipi tarife sürümünü taşımaz
    const rules = await recalculate(app, auditor.auth, id, { basis: 'rules' });
    expect(rules.preview.basis).toMatchObject({ rulesChanged: true, from: { revisionId: mid.tariffRevisionId }, to: { revisionId: mid.tariffRevisionId } });
    expect(rules.invoice.basis.state).toBe('CURRENT');
    const end = await row();
    expect(end.tariffRevisionId).toBe(mid.tariffRevisionId);
    expect(end.compareSettings).toMatchObject({ amountTol: 9 });
    const log = (await audits(f.auth, id, 'invoice.recalculate')).map((a) => [(a.data as { basis: string }).basis, (a.data as { cause: string }).cause]);
    expect(log.slice(-2)).toEqual([
      ['tariff', 'TARIFF'],
      ['rules', 'RULES'],
    ]);
  });
});

describe('satır düzeltmesi ve not (inceleme 3, 5)', () => {
  it('not yazmak / silmek hiçbir satırın rakamını değiştirmez: onaylı ve işaretli satırda işaret ve rakam kalır; sonuç aynıysa karşılaştırma notu geri gelir', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2, t3] = [trackingNo(), trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2, t3]);
    const [l1, , l3] = await lines(f, id);
    await decide(f, l1!.id);
    // onaylı satırın ölçümü düzeltildi: yazılmadı, işaretli
    await correct(f, t1, FOUR_DESI);
    const frozen = (await lines(f, id))[0]!;
    expect(frozen).toMatchObject({ decision: 'VERIFIED', expectedAmount: 30, recalcPending: 'MEASUREMENT' });
    const patch = (lineId: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: f.auth, payload });
    const money = async () => (await lines(f, id)).map((l) => [l.id, l.expectedAmount, l.diffAmount, l.measurementId, l.recalcPending, JSON.stringify(l.prevResult)]);

    const wrote = await patch(l1!.id, { note: 'taşıyıcıyla konuşuldu' });
    expect(wrote.statusCode, wrote.body).toBe(200);
    const state = await money();
    const cleared = await patch(l1!.id, { note: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().line).toMatchObject({ decision: 'VERIFIED', expectedAmount: 30, diffAmount: 20, measurementId: frozen.measurementId, recalcPending: 'MEASUREMENT', prevResult: null });
    expect(await money()).toEqual(state);
    expect(cleared.json().totals).toMatchObject({ pendingLines: 1 });
    expect(await audits(f.auth, id, 'invoice.recalculate')).toHaveLength(0);

    // ölçümsüz açık satır: sonuç aynı, karşılaştırma notu geri gelir
    const original = l3!.note;
    expect(original).toBeTruthy();
    expect((await patch(l3!.id, { note: 'elle' })).statusCode).toBe(200);
    expect((await lines(f, id))[2]!.note).toBe('elle');
    const back = await patch(l3!.id, { note: '' });
    expect(back.statusCode, back.body).toBe(200);
    expect((await lines(f, id))[2]).toMatchObject({ note: original, status: 'UNMATCHED' });
    expect(await money()).toEqual(state);
  });

  it('kararı geri alınan işaretli satır aynı istekte güncel ölçüm ve sabit dayanakla hesaplanır; işaret silinir, eski rakam prevResult’ta', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2] = [trackingNo(), trackingNo()];
    await measure(f, t1);
    await measure(f, t2);
    const id = await importInvoice(f, [t1, t2]);
    const [l1, l2] = await lines(f, id);
    await decide(f, l1!.id);
    await decide(f, l2!.id);
    const pinnedRev = (await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId;
    // tarife değişti (sabit dayanak eski fiyatta kalmalı), onaylı satırın ölçümü düzeltildi
    await reprice(f, 8);
    await correct(f, t1, FOUR_DESI);
    expect((await lines(f, id))[0]).toMatchObject({ expectedAmount: 30, recalcPending: 'MEASUREMENT' });

    const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l1!.id}`, headers: f.auth, payload: { decision: 'OPEN' } });
    expect(r.statusCode, r.body).toBe(200);
    // 4 desi × 10 (faturanın sürümü, bugünkü 8 değil) = 40
    expect(r.json().line).toMatchObject({ decision: 'OPEN', expectedAmount: 40, diffAmount: 10, recalcPending: null, prevResult: { expectedAmount: 30, diffAmount: 20, cause: 'MEASUREMENT' } });
    expect(r.json().totals).toMatchObject({ pendingLines: 0, expectedTotal: 70 });
    const stored = await inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { rowIndex: 'asc' } }));
    expect(stored[0]!.tariffRevisionId).toBe(pinnedRev);
    // öbür onaylı satıra dokunulmadı; fatura sürümü aynı
    expect((await lines(f, id))[1]).toMatchObject({ decision: 'VERIFIED', expectedAmount: 30, prevResult: null });
    expect((await inCompany(f.auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }))).tariffRevisionId).toBe(pinnedRev);

    // işaretsiz satırın kararını geri almak hesap yapmaz
    const plain = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l2!.id}`, headers: f.auth, payload: { decision: 'OPEN' } });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json().line).toMatchObject({ decision: 'OPEN', expectedAmount: 30, prevResult: null });
  });

  it('itirazdaki satırın kararı geri alınamaz (409 LINE_IN_DISPUTE); rakam ve işaret kalır', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [100], { verify: 1 });
    const sent = await caller(app)(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const f = { app, auth: c.admin.auth, worker: c.worker.auth };
    await correct(f, inv.lines[0]!.trackingNo, FOUR_DESI);
    const [before] = await lines(f, inv.invoiceId);
    expect(before!.recalcPending).toBe('MEASUREMENT');
    const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${before!.id}`, headers: c.admin.auth, payload: { decision: 'OPEN' } });
    expect(errorOf(r)).toEqual([409, 'LINE_IN_DISPUTE']);
    expect((await lines(f, inv.invoiceId))[0]).toMatchObject({ decision: 'VERIFIED', expectedAmount: before!.expectedAmount, recalcPending: 'MEASUREMENT' });
  });
});
