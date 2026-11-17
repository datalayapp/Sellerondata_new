/**
 * Mesaj 4, toplu "eski faturaları yeni dayanağa geçir" (services/bulkRecalc.ts):
 *  - `POST /tariffs/:id/recompare-invoices/preview` → `POST /tariffs/:id/recompare-invoices { token }`
 *  - `POST /settings/recompare-invoices/preview` → `POST /settings/recompare-invoices { token }`
 * Y83: uçlar yalnız arka planda çalışır; testler `viaJob` ile `?async=1` yolundan gider (yanıt eski eşzamanlı biçime
 * çevrilir, beklentiler aynı). Eski eşzamanlı yol kapalıdır: `async` olmadan 400 `ASYNC_REQUIRED` (son testte).
 * Önizleme yazmaz; onay önizlemenin özetiyle gelir. Dayanak (tarife sürümü, ayar) değiştiyse ya da özet bilinmiyorsa 409
 * PREVIEW_STALE; K4: önizlemeden sonra değişen tek fatura atlanır ve listelenir (`staleInvoices`), kalanı yazılır. Etkin
 * itirazı olan fatura atlanır ve sayılır. Ülke istisnası ve ayar kaydı faturayı hesaplamaz.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { currencyTotals } from '../src/services/bulkRecalc.ts';
import { recompareInvoice } from '../src/services/compare.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { digestOf, trDay } from './disputeHelpers.ts';
import { createMember, createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { expectAsyncRequired, viaJob } from './jobHelpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

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

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Toplu '));
  const worker = await createWorker(app, admin.auth);
  const carrierId = await carrier(app, admin.auth);
  const tariffId = await tariff(app, admin.auth, carrierId, 10);
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, carrierId, tariffId };
}

async function carrier(app: FastifyInstance, auth: Auth) {
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  return c.json().carrier.id as string;
}

async function tariff(app: FastifyInstance, auth: Auth, carrierId: string, perKg: number, over: Record<string, unknown> = {}) {
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: auth, payload: tariffOf(carrierId, perKg, over) });
  expect(t.statusCode, t.body).toBe(201);
  return t.json().tariff.id as string;
}

const putTariff = async (f: Firm, perKg: number, over: Record<string, unknown> & { id?: string; carrierId?: string } = {}) => {
  const { id = f.tariffId, carrierId = f.carrierId, ...rest } = over;
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${id}`, headers: f.auth, payload: tariffOf(carrierId, perKg, rest) });
  expect(r.statusCode, r.body).toBe(200);
};

/** 30×20×15 cm, 2 kg = 3 desi. Faturada 5 desi, 50 TL: 10 TL/desi tarifeyle beklenen 30, fark 20. */
async function measure(f: Firm, tracking: string, dims = { lengthCm: 30, widthCm: 20, heightCm: 15 }) {
  const p = measurementPayload({ trackingRaw: tracking, ...dims, weightKg: 2 });
  const r = await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
}

/** Düzeltme: 26×25×16 → 4 desi. */
async function correct(f: Firm, tracking: string) {
  const head = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }));
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/measurements/${head.id}`, headers: f.worker, payload: { lengthCm: 26, widthCm: 25, heightCm: 16 } });
  expect(r.statusCode, r.body).toBe(200);
}

/** Ölçülmüş satırlarla fatura (her satır 5 desi, 50 TL). Dayanağı yazılmamış eski yol da güncel dayanağa bağlanır. */
async function invoice(f: Firm, opts: { carrierId?: string; tariffId?: string; country?: string; measured?: number; currency?: string } = {}) {
  const tracking = Array.from({ length: opts.measured ?? 1 }, trackingNo);
  for (const t of tracking) await measure(f, t);
  const header = opts.country ? 'Takip No;Ülke;Desi;Tutar' : 'Takip No;Desi;Tutar';
  const csv = [header, ...tracking.map((t) => (opts.country ? `${t};${opts.country};5;50` : `${t};5;50`))].join('\n');
  const carrierId = opts.carrierId ?? f.carrierId;
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
      currency: opts.currency ?? 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar', ...(opts.country ? { destCountry: 'Ülke' } : {}) },
      acknowledgeIssues: true,
      ...(opts.tariffId ? { tariffId: opts.tariffId } : {}),
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const id = inv.json().invoice.id as string;
  await inCompany(f.auth, () => recompareInvoice(id));
  return { id, tracking, invoiceNo: inv.json().invoice.invoiceNo as string };
}

const invoiceRow = (f: Firm, id: string) => inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { id } }));
const lineRows = (f: Firm, invoiceId: string) => inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }));
const money = (l: { status: string; expectedAmount: unknown; diffAmount: unknown }) => [l.status, l.expectedAmount == null ? null : Number(l.expectedAmount), l.diffAmount == null ? null : Number(l.diffAmount)];
const moneyOf = async (f: Firm, id: string) => (await lineRows(f, id)).map(money);
const currentRevision = async (f: Firm, tariffId = f.tariffId) => (await inCompany(f.auth, () => prisma.tariff.findFirstOrThrow({ where: { id: tariffId } }))).currentRevisionId;

/** Fatura ve satırları yazıldı mı: değişme anları, dayanak, tutarlar. */
async function fingerprint(f: Firm, id: string) {
  const inv = await invoiceRow(f, id);
  const lines = await lineRows(f, id);
  return {
    invoice: [+inv.updatedAt, inv.tariffRevisionId, JSON.stringify(inv.compareSettings), JSON.stringify(inv.totals)],
    lines: lines.map((l) => [l.id, +l.updatedAt, ...money(l), l.tariffRevisionId, l.recalcPending, JSON.stringify(l.prevResult)]),
  };
}

type BulkPreview = {
  token: string;
  invoices: { id: string; invoiceNo: string; carrierName: string; currency: string; before: { overchargeTotal: number }; after: { overchargeTotal: number }; changedLines: number }[];
  totalsByCurrency: { currency: string; invoices: number; before: { overchargeTotal: number }; after: { overchargeTotal: number } }[];
  changedInvoices: number;
  skippedInDispute: number;
};

const tariffUrl = (id: string) => `${API}/tariffs/${id}/recompare-invoices`;
const SETTINGS_URL = `${API}/settings/recompare-invoices`;

async function preview(f: Firm, url: string, auth: Auth = f.auth): Promise<BulkPreview> {
  const r = await viaJob(f.app, { method: 'POST', url: `${url}/preview`, headers: auth, payload: {} });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const confirm = (f: Firm, url: string, token: unknown, auth: Auth = f.auth) =>
  viaJob(f.app, { method: 'POST', url, headers: auth, payload: token === undefined ? {} : { token } });

const EMPTY = { invoices: [], totalsByCurrency: [], changedInvoices: 0, skippedInDispute: 0 };

describe('tarife için toplu geçiş', () => {
  it('fiyat değişir: önizleme etkilenen faturaları ve önce/sonra fazla ödemeyi verir, yazmaz; onay yazar, ikinci önizleme boş', async () => {
    const app = await getApp();
    const f = await firm(app);
    const economy = await tariff(app, f.auth, f.carrierId, 9, { name: 'Economy', isDefault: false });
    const otherCarrier = await carrier(app, f.auth);
    await tariff(app, f.auth, otherCarrier, 10);
    const one = await invoice(f);
    const two = await invoice(f);
    const onEconomy = await invoice(f, { tariffId: economy });
    const onOther = await invoice(f, { carrierId: otherCarrier });
    expect(await moneyOf(f, one.id)).toEqual([['DIFF', 30, 20]]);
    expect(await moneyOf(f, onEconomy.id)).toEqual([['DIFF', 27, 23]]);
    const rev1 = await currentRevision(f);

    // tarife ucuzlar (8 TL/desi → beklenen 24, fark 26; fiyat sapması büyürse satır tahmini olur, Fazla ödeme'ye girmez); öbür tarife de değişir ama bu tarifenin kapsamına girmez
    await putTariff(f, 8);
    await putTariff(f, 8, { id: economy, name: 'Economy', isDefault: false });
    const rev2 = await currentRevision(f);
    expect(rev2).not.toBe(rev1);
    const ids = [one.id, two.id, onEconomy.id, onOther.id];
    const before = await Promise.all(ids.map((id) => fingerprint(f, id)));

    const p = await preview(f, tariffUrl(f.tariffId));
    expect(p).toMatchObject({ changedInvoices: 2, skippedInDispute: 0, totalsByCurrency: [{ currency: 'TRY', invoices: 2, before: { overchargeTotal: 40 }, after: { overchargeTotal: 52 } }] });
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
    const carrierName = (await inCompany(f.auth, () => prisma.carrier.findFirstOrThrow({ where: { id: f.carrierId } }))).name;
    expect(p.invoices).toEqual([
      { id: one.id, invoiceNo: one.invoiceNo, carrierName, currency: 'TRY', before: { overchargeTotal: 20 }, after: { overchargeTotal: 26 }, changedLines: 1 },
      { id: two.id, invoiceNo: two.invoiceNo, carrierName, currency: 'TRY', before: { overchargeTotal: 20 }, after: { overchargeTotal: 26 }, changedLines: 1 },
    ]);
    // önizleme hiçbir şey yazmaz
    expect(await Promise.all(ids.map((id) => fingerprint(f, id)))).toEqual(before);
    // aynı durumda ikinci önizleme aynı özeti verir
    expect((await preview(f, tariffUrl(f.tariffId))).token).toBe(p.token);

    const r = await confirm(f, tariffUrl(f.tariffId), p.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    for (const inv of [one, two]) {
      expect((await invoiceRow(f, inv.id)).tariffRevisionId).toBe(rev2);
      const [l] = await lineRows(f, inv.id);
      expect([...money(l!), l!.tariffRevisionId, l!.decision]).toEqual(['DIFF', 24, 26, rev2, 'OPEN']);
      expect(l!.prevResult).toMatchObject({ status: 'DIFF', expectedAmount: 30, diffAmount: 20, tariffRevisionId: rev1 });
    }
    // başka tarifenin ve başka taşıyıcının faturası yerinde
    expect(await fingerprint(f, onEconomy.id)).toEqual(before[2]);
    expect(await fingerprint(f, onOther.id)).toEqual(before[3]);

    // her fatura için denetim kaydı, toplu kayıt da ayrıca
    const logs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: { in: ['invoice.recalculate', 'tariff.recompare'] } } }));
    const recalc = logs.filter((x) => x.action === 'invoice.recalculate');
    expect(recalc.map((x) => x.entityId).sort()).toEqual([one.id, two.id].sort());
    expect(recalc[0]!.data).toMatchObject({ basis: 'tariff', revisionFrom: rev1, revisionTo: rev2, changedLines: 1, totalsBefore: { overchargeTotal: 20 }, totalsAfter: { overchargeTotal: 26 }, via: { kind: 'tariff', tariffId: f.tariffId } });
    expect(logs.filter((x) => x.action === 'tariff.recompare').map((x) => x.data)).toEqual([{ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, jobId: expect.any(String) }]);

    // güncel olan fatura kapsamda değil
    const again = await preview(f, tariffUrl(f.tariffId));
    expect(again).toMatchObject(EMPTY);
    expect(await confirm(f, tariffUrl(f.tariffId), again.token).then((x) => x.json())).toEqual({ invoices: 0, lines: 0, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });

    // öbür tarifenin toplu işlemi yalnız kendi faturasını görür
    const eco = await preview(f, tariffUrl(economy));
    expect(eco.invoices.map((i) => i.id)).toEqual([onEconomy.id]);
    expect(eco.invoices[0]).toMatchObject({ before: { overchargeTotal: 23 }, after: { overchargeTotal: 26 } });
  });

  it('bayat dayanak: 409 PREVIEW_STALE, hiçbir fatura yazılmaz; özetsiz onay 400; K4: önizlemeden sonra değişen fatura atlanır ve listelenir, kalanı yazılır', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const two = await invoice(f);
    await putTariff(f, 8);
    const before = await Promise.all([one, two].map((x) => fingerprint(f, x.id)));

    expect((await confirm(f, tariffUrl(f.tariffId), undefined)).statusCode).toBe(400);
    const bogus = await confirm(f, tariffUrl(f.tariffId), 'a'.repeat(64));
    expect(bogus.statusCode, bogus.body).toBe(409);
    expect(bogus.json().error.code).toBe('PREVIEW_STALE');

    // tarife önizlemeden sonra yine değişti
    const p1 = await preview(f, tariffUrl(f.tariffId));
    await putTariff(f, 9);
    const stale = await confirm(f, tariffUrl(f.tariffId), p1.token);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'PREVIEW_STALE', message: expect.any(String) });
    expect(await Promise.all([one, two].map((x) => fingerprint(f, x.id)))).toEqual(before);

    // K4: ölçüm önizlemeden sonra düzeltildi: açık satır eski sürümle (10 TL/desi) yeniden hesaplanır, o faturanın kendi
    // özeti tutmaz. Değişmeyen fatura yazılır; değişen atlanır (`stale`) ve listelenir, dokunulmaz.
    const p2 = await preview(f, tariffUrl(f.tariffId));
    expect(p2.invoices.map((i) => i.after.overchargeTotal)).toEqual([23, 23]);
    await correct(f, one.tracking[0]!);
    expect(await moneyOf(f, one.id)).toEqual([['DIFF', 40, 10]]);
    const oneChanged = await fingerprint(f, one.id);
    const partial = await confirm(f, tariffUrl(f.tariffId), p2.token);
    expect(partial.statusCode, partial.body).toBe(200);
    const carrierName = (await inCompany(f.auth, () => prisma.carrier.findFirstOrThrow({ where: { id: f.carrierId } }))).name;
    expect(partial.json()).toEqual({
      invoices: 1,
      lines: 1,
      skipped: { inDispute: 0, stale: 1 },
      stopped: 0,
      staleInvoices: [{ id: one.id, invoiceNo: one.invoiceNo, carrierName }],
      remaining: 1,
    });
    expect(await fingerprint(f, one.id)).toEqual(oneChanged);
    expect(await moneyOf(f, two.id)).toEqual([['DIFF', 27, 23]]);
    expect((await invoiceRow(f, two.id)).tariffRevisionId).toBe(await currentRevision(f));

    // yeni önizleme yalnız atlanan faturayı içerir; onayı onu da geçirir
    const p3 = await preview(f, tariffUrl(f.tariffId));
    expect(p3.invoices.map((i) => [i.id, i.before.overchargeTotal, i.after.overchargeTotal])).toEqual([[one.id, 10, 14]]);
    expect((await confirm(f, tariffUrl(f.tariffId), p3.token)).json()).toEqual({ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(await moneyOf(f, one.id)).toEqual([['DIFF', 36, 14]]);
  });

  it('etkin itirazı olan fatura atlanır ve sayılır; rakamı ve dayanağı değişmez', async () => {
    const app = await getApp();
    const f = await firm(app);
    const free = await invoice(f);
    const disputed = await invoice(f, { measured: 2 });
    const [first] = await lineRows(f, disputed.id);
    const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${first!.id}`, headers: f.auth, payload: { decision: 'VERIFIED' } });
    expect(v.statusCode, v.body).toBe(200);
    const sent = await app.inject({ method: 'POST', url: `${API}/invoices/${disputed.id}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, disputed.id) } });
    expect(sent.statusCode, sent.body).toBe(201);
    await putTariff(f, 8);
    const held = await fingerprint(f, disputed.id);

    const p = await preview(f, tariffUrl(f.tariffId));
    expect(p).toMatchObject({ changedInvoices: 1, skippedInDispute: 1 });
    expect(p.invoices.map((i) => i.id)).toEqual([free.id]);
    const r = await confirm(f, tariffUrl(f.tariffId), p.token);
    expect(r.json()).toEqual({ invoices: 1, lines: 1, skipped: { inDispute: 1, stale: 0 }, stopped: 0 });
    expect(await moneyOf(f, free.id)).toEqual([['DIFF', 24, 26]]);
    expect(await fingerprint(f, disputed.id)).toEqual(held);
    expect(await moneyOf(f, disputed.id)).toEqual([
      ['DIFF', 30, 20],
      ['DIFF', 30, 20],
    ]);
    // itiraz sürdükçe kapsamda kalır, yine atlanır
    expect(await preview(f, tariffUrl(f.tariffId))).toMatchObject({ changedInvoices: 0, skippedInDispute: 1 });
  });

  it('tarife kaydı sonrası sayı toplu önizlemenin kapsamıdır: güncel sürümdeki fatura sayılmaz, itirazdaki sayılır', async () => {
    const app = await getApp();
    const f = await firm(app);
    const economy = await tariff(app, f.auth, f.carrierId, 9, { name: 'Economy', isDefault: false });
    const free = await invoice(f);
    const disputed = await invoice(f, { measured: 2 });
    await invoice(f, { tariffId: economy });
    const [first] = await lineRows(f, disputed.id);
    expect((await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${first!.id}`, headers: f.auth, payload: { decision: 'VERIFIED' } })).statusCode).toBe(200);
    const sent = await app.inject({ method: 'POST', url: `${API}/invoices/${disputed.id}/disputes`, headers: f.auth, payload: { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.auth, disputed.id) } });
    expect(sent.statusCode, sent.body).toBe(201);
    const put = (perKg: number, name = 'Sabit') =>
      app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg, { name }) });
    const scopeOf = (p: BulkPreview) => p.changedInvoices + p.skippedInDispute;

    // fiyat değişti: iki fatura eski sürümde (biri itirazda, toplu işlem atlar); Economy'deki fatura "başka tarife"
    const r1 = await put(8);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ affectedInvoices: 2, otherInvoices: 1 });
    const p1 = await preview(f, tariffUrl(f.tariffId));
    expect(p1).toMatchObject({ changedInvoices: 1, skippedInDispute: 1 });
    expect(scopeOf(p1)).toBe(r1.json().affectedInvoices);
    expect((await confirm(f, tariffUrl(f.tariffId), p1.token)).json()).toMatchObject({ invoices: 1 });
    expect((await invoiceRow(f, free.id)).tariffRevisionId).toBe(await currentRevision(f));

    // yalnız ad değişti (yeni sürüm yok): geçirilmiş fatura artık sayılmaz (eski kural taşıyıcının bu tarifedeki iki faturasını sayardı)
    const r2 = await put(8, 'Sabit yeni ad');
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json()).toMatchObject({ affectedInvoices: 1, otherInvoices: 1 });
    expect(scopeOf(await preview(f, tariffUrl(f.tariffId)))).toBe(1);

    // geri yükleme de aynı kaynaktan sayar: fiyat 8'den önceki hâle (10) döner, iki fatura yeni sürümde değil
    const versions = (await app.inject({ method: 'GET', url: `${API}/tariffs/${f.tariffId}/versions`, headers: f.auth })).json().items as { id: string }[];
    const restore = await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/versions/${versions.at(-1)!.id}/restore`, headers: f.auth, payload: {} });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json()).toMatchObject({ affectedInvoices: 2, otherInvoices: 1 });
    expect(scopeOf(await preview(f, tariffUrl(f.tariffId)))).toBe(2);
  });

  it('ülke istisnası faturayı hesaplamaz (totals null); toplu onaydan sonra fatura yeni sürümle hesaplanır', async () => {
    const app = await getApp();
    const f = await firm(app);
    const de = await invoice(f, { country: 'DE' });
    expect(await moneyOf(f, de.id)).toEqual([['DIFF', 30, 20]]);
    const rev1 = await currentRevision(f);
    const before = await fingerprint(f, de.id);

    const adj = await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/country-adjustments`, headers: f.auth, payload: { country: 'DE', pct: -20, source: 'invoice', invoiceId: de.id } });
    expect(adj.statusCode, adj.body).toBe(200);
    expect(adj.json()).toMatchObject({ totals: null, versionId: expect.any(String), health: expect.any(Object) });
    expect(adj.json().tariff.countryAdjustments).toMatchObject([{ country: 'DE', pct: -20 }]);
    expect(await currentRevision(f)).not.toBe(rev1);
    expect(await fingerprint(f, de.id)).toEqual(before);

    const p = await preview(f, tariffUrl(f.tariffId));
    expect(p.invoices).toMatchObject([{ id: de.id, before: { overchargeTotal: 20 }, after: { overchargeTotal: 26 }, changedLines: 1 }]);
    expect((await confirm(f, tariffUrl(f.tariffId), p.token)).json()).toMatchObject({ invoices: 1, lines: 1 });
    expect(await moneyOf(f, de.id)).toEqual([['DIFF', 24, 26]]);

    // kaldırmak da hesaplamaz
    const afterApply = await fingerprint(f, de.id);
    const del = await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/country-adjustments`, headers: f.auth, payload: { country: 'DE', pct: 0 } });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toMatchObject({ totals: null, health: null });
    expect(await fingerprint(f, de.id)).toEqual(afterApply);
    expect((await preview(f, tariffUrl(f.tariffId))).invoices).toMatchObject([{ id: de.id, before: { overchargeTotal: 26 }, after: { overchargeTotal: 20 } }]);
  });

  it('K4: kapsamın tamamı geçince `remaining` yok: örnek fatura geçer, silinen ve başka tarifeye düşen sayılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const sample = await invoice(f);
    const gone = await invoice(f);
    const elsewhere = await invoice(f);
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id: sample.id }, data: { isSample: true } }));
    expect((await app.inject({ method: 'DELETE', url: `${API}/invoices/${gone.id}`, headers: f.auth })).statusCode).toBeLessThan(300);
    // aynı taşıyıcının ikinci tarifesi bu faturada seçili: bu tarifenin toplu geçişi onu taşımaz
    const other = await tariff(app, f.auth, f.carrierId, 10, { isDefault: false, name: 'İkinci' });
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id: elsewhere.id }, data: { tariffId: other } }));
    await putTariff(f, 8);
    const p = await preview(f, tariffUrl(f.tariffId));
    expect(p.invoices.map((i) => i.id).sort()).toEqual([one.id, sample.id].sort());
    const r = await confirm(f, tariffUrl(f.tariffId), p.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ invoices: 2, lines: 2, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(await preview(f, tariffUrl(f.tariffId))).toMatchObject(EMPTY);
  });
});

describe('ayar için toplu geçiş', () => {
  it('ayar kaydı hesaplamaz; önizleme yazmaz; onay yeni ayara geçirir; örnek ve silinmiş fatura kapsam dışı', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const gone = await invoice(f);
    const sample = await invoice(f);
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${gone.id}`, headers: f.auth });
    expect(del.statusCode, del.body).toBeLessThan(300);
    await inCompany(f.auth, () => prisma.invoice.update({ where: { id: sample.id }, data: { isSample: true } }));
    expect(await preview(f, SETTINGS_URL)).toMatchObject(EMPTY);
    const before = await fingerprint(f, one.id);
    const sampleBefore = await fingerprint(f, sample.id);

    // tutar toleransı 5 → 25: fark (20) tolerans içine girer; kayıt faturayı hesaplamaz
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } });
    expect(set.statusCode, set.body).toBe(200);
    expect(await fingerprint(f, one.id)).toEqual(before);

    const p = await preview(f, SETTINGS_URL);
    expect(p).toMatchObject({ changedInvoices: 1, skippedInDispute: 0, totalsByCurrency: [{ currency: 'TRY', invoices: 1, before: { overchargeTotal: 20 }, after: { overchargeTotal: 0 } }] });
    expect(p.invoices).toMatchObject([{ id: one.id, invoiceNo: one.invoiceNo, currency: 'TRY', before: { overchargeTotal: 20 }, after: { overchargeTotal: 0 }, changedLines: 1 }]);
    expect(await fingerprint(f, one.id)).toEqual(before);
    // tarife değişmedi: tarifenin toplu işlemi bu faturayı kapsamaz
    expect(await preview(f, tariffUrl(f.tariffId))).toMatchObject(EMPTY);

    const stale = await confirm(f, SETTINGS_URL, 'b'.repeat(64));
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'PREVIEW_STALE']);
    const r = await confirm(f, SETTINGS_URL, p.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ invoices: 1, lines: 1, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
    expect(await moneyOf(f, one.id)).toEqual([['MATCH', 30, 20]]);
    // yalnız ayar değişti: önceki sonucun nedeni RULES
    expect((await lineRows(f, one.id))[0]!.prevResult).toMatchObject({ status: 'DIFF', cause: 'RULES' });
    expect(((await invoiceRow(f, one.id)).compareSettings as { amountTol: number }).amountTol).toBe(25);
    expect(await fingerprint(f, sample.id)).toEqual(sampleBefore);
    expect(await preview(f, SETTINGS_URL)).toMatchObject(EMPTY);
    const logs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { companyId: f.companyId, action: { in: ['invoice.recalculate', 'settings.recompare'] } } }));
    expect(logs.map((x) => [x.action, x.entityId]).sort()).toEqual([
      ['invoice.recalculate', one.id],
      ['settings.recompare', f.companyId],
    ]);
    expect(logs.find((x) => x.action === 'invoice.recalculate')!.data).toMatchObject({ via: { kind: 'settings' } });
  });

  it('her toplu geçiş yalnız adındaki parçayı günceller: ayar geçişi tarife sürümünü, tarife geçişi (ayar yetkisi olmayan denetleyici de) toleransı taşımaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const rev1 = await currentRevision(f);
    await putTariff(f, 8);
    const rev2 = await currentRevision(f);
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } });
    expect(set.statusCode, set.body).toBe(200);
    const amountTol = async () => ((await invoiceRow(f, one.id)).compareSettings as { amountTol: number }).amountTol;

    // önce tarife geçişi (denetleyici: tarife izni var, ayar izni yok): yalnız sürüm; tolerans faturadaki (5) kalır
    const auditor = await createMember(app, f.auth, 'AUDITOR');
    const pt = await preview(f, tariffUrl(f.tariffId), auditor.auth);
    // eski tolerans (5) ile yeni fiyat: fark 26
    expect(pt.invoices).toMatchObject([{ id: one.id, before: { overchargeTotal: 20 }, after: { overchargeTotal: 26 } }]);
    expect((await confirm(f, tariffUrl(f.tariffId), pt.token, auditor.auth)).json()).toMatchObject({ invoices: 1 });
    expect([(await invoiceRow(f, one.id)).tariffRevisionId, await amountTol()]).toEqual([rev2, 5]);
    expect(await moneyOf(f, one.id)).toEqual([['DIFF', 24, 26]]);
    expect((await lineRows(f, one.id))[0]!.prevResult).toMatchObject({ expectedAmount: 30, cause: 'TARIFF' });
    const recalcs = await inCompany(f.auth, () => prisma.auditLog.findMany({ where: { entityId: one.id, action: 'invoice.recalculate' }, orderBy: { createdAt: 'asc' } }));
    expect(recalcs.at(-1)!.data).toMatchObject({ basis: 'tariff', cause: 'TARIFF', revisionFrom: rev1, revisionTo: rev2 });

    // ardından ayar geçişi: yalnız tolerans; sürüm aynı kalır (26 > 25: fark sürer)
    const ps = await preview(f, SETTINGS_URL);
    expect(ps.invoices).toMatchObject([{ id: one.id, before: { overchargeTotal: 26 }, after: { overchargeTotal: 26 } }]);
    expect((await confirm(f, SETTINGS_URL, ps.token)).json()).toMatchObject({ invoices: 1 });
    expect([(await invoiceRow(f, one.id)).tariffRevisionId, await amountTol()]).toEqual([rev2, 25]);
    expect(await preview(f, tariffUrl(f.tariffId))).toMatchObject(EMPTY);
    expect(await preview(f, SETTINGS_URL)).toMatchObject(EMPTY);
  });

  it('ters sıra: ayar geçişi tarifesi değişmiş faturayı eski sürümde bırakır; neden RULES; tarife geçişi sonra sorar', async () => {
    const app = await getApp();
    const f = await firm(app);
    const one = await invoice(f);
    const rev1 = await currentRevision(f);
    await putTariff(f, 8);
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } });
    expect(set.statusCode, set.body).toBe(200);
    // eski fiyatla fark 20, yeni tolerans 25: uyumlu
    const p = await preview(f, SETTINGS_URL);
    expect(p.invoices).toMatchObject([{ id: one.id, before: { overchargeTotal: 20 }, after: { overchargeTotal: 0 } }]);
    expect((await confirm(f, SETTINGS_URL, p.token)).json()).toMatchObject({ invoices: 1 });
    const inv = await invoiceRow(f, one.id);
    expect([inv.tariffRevisionId, (inv.compareSettings as { amountTol: number }).amountTol]).toEqual([rev1, 25]);
    expect((await lineRows(f, one.id))[0]!.prevResult).toMatchObject({ status: 'DIFF', cause: 'RULES' });
    expect((await preview(f, tariffUrl(f.tariffId))).invoices.map((i) => i.id)).toEqual([one.id]);
  });
});

describe('toplu önizleme toplamı para birimine göre (inceleme 9)', () => {
  afterEach(() => setFxService(null));

  it('farklı para birimindeki faturalar toplanmaz: her para birimi ayrı satır, geçecek TÜM faturalardan', async () => {
    // 1 USD = 40,05 TRY (orta kur): firmanın TL toleransı dolarlı satıra çevrilir
    const fetcher: FxFetcher = async (url) =>
      url === tcmbUrl('2026-10-15')
        ? { status: 200, text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>' }
        : { status: 404, text: '' };
    setFxService(new FxService({ fetcher, cacheDir: null, now: () => new Date('2026-11-04T12:00:00Z') }));
    const app = await getApp();
    const f = await firm(app);
    const usdCarrier = await carrier(app, f.auth);
    await tariff(app, f.auth, usdCarrier, 10, { currency: 'USD' });
    const tl = await invoice(f);
    const usd = await invoice(f, { carrierId: usdCarrier, currency: 'USD' });
    expect(await moneyOf(f, usd.id)).toEqual([['DIFF', 30, 20]]);
    const set = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.auth, payload: { amountTol: 25 } });
    expect(set.statusCode, set.body).toBe(200);

    const p = await preview(f, SETTINGS_URL);
    expect(p.invoices.map((i) => [i.id, i.currency]).sort()).toEqual([[tl.id, 'TRY'], [usd.id, 'USD']].sort());
    // 25 TL tolerans 20 TL'lik farkı kapatır; 20 USD'lik farkı (≈ 800 TL) kapatmaz
    expect(p.totalsByCurrency).toEqual([
      { currency: 'TRY', invoices: 1, before: { overchargeTotal: 20 }, after: { overchargeTotal: 0 } },
      { currency: 'USD', invoices: 1, before: { overchargeTotal: 20 }, after: { overchargeTotal: 20 } },
    ]);
    expect(p).not.toHaveProperty('totals');
  });

  it('currencyTotals: kuruşla toplar, para birimi sırasıyla; boş kapsamda boş liste', () => {
    expect(currencyTotals([])).toEqual([]);
    expect(
      currencyTotals([
        { currency: 'USD', before: 0.1, after: 0.2 },
        { currency: 'TRY', before: 10.005, after: 1 },
        { currency: 'USD', before: 0.2, after: 0.1 },
      ]),
    ).toEqual([
      { currency: 'TRY', invoices: 1, before: { overchargeTotal: 10.01 }, after: { overchargeTotal: 1 } },
      { currency: 'USD', invoices: 2, before: { overchargeTotal: 0.3 }, after: { overchargeTotal: 0.3 } },
    ]);
  });
});

describe('yetki ve firma ayrımı', () => {
  it('tarife: tarife düzenleme izni; ayar: ayar yönetme izni; başka firmanın faturası etkilenmez', async () => {
    const app = await getApp();
    const a = await firm(app);
    const b = await firm(app);
    const aInv = await invoice(a);
    const bInv = await invoice(b);
    await putTariff(a, 8);
    await putTariff(b, 8);
    for (const x of [a, b]) expect((await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: x.auth, payload: { amountTol: 25 } })).statusCode).toBe(200);
    const bBefore = await fingerprint(b, bInv.id);

    const auditor = await createMember(app, a.auth, 'AUDITOR');
    const accounting = await createMember(app, a.auth, 'ACCOUNTING');
    const worker = { auth: a.worker };
    // Denetleyici tarifeyi düzenler: tarife toplu işlemi açık, ayar değil
    expect((await preview(a, tariffUrl(a.tariffId), auditor.auth)).changedInvoices).toBe(1);
    for (const who of [auditor, accounting, worker]) {
      for (const url of [`${SETTINGS_URL}/preview`, SETTINGS_URL]) {
        expect((await viaJob(app, { method: 'POST', url, headers: who.auth, payload: { token: 'x' } })).statusCode, `${url}`).toBe(403);
      }
    }
    for (const who of [accounting, worker]) {
      for (const url of [`${tariffUrl(a.tariffId)}/preview`, tariffUrl(a.tariffId)]) {
        expect((await viaJob(app, { method: 'POST', url, headers: who.auth, payload: { token: 'x' } })).statusCode, url).toBe(403);
      }
    }

    // A, B'nin tarifesine ulaşamaz
    for (const url of [`${tariffUrl(b.tariffId)}/preview`, tariffUrl(b.tariffId)]) {
      const r = await viaJob(app, { method: 'POST', url, headers: a.auth, payload: { token: 'x' } });
      expect(r.statusCode, r.body).toBe(404);
    }
    // A'nın önizlemesi yalnız kendi faturası
    const ps = await preview(a, SETTINGS_URL);
    expect(ps.invoices.map((i) => i.id)).toEqual([aInv.id]);
    expect(JSON.stringify(ps)).not.toContain(bInv.id);
    expect((await confirm(a, SETTINGS_URL, ps.token)).json()).toMatchObject({ invoices: 1 });
    const pt = await preview(a, tariffUrl(a.tariffId));
    expect((await confirm(a, tariffUrl(a.tariffId), pt.token)).statusCode).toBe(200);
    expect(await fingerprint(b, bInv.id)).toEqual(bBefore);
    expect((await preview(b, SETTINGS_URL)).invoices.map((i) => i.id)).toEqual([bInv.id]);
  });
});

describe('eski eşzamanlı yol (Y83)', () => {
  it('eski eşzamanlı yol kapalı: async olmadan 400 ASYNC_REQUIRED, hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const f = await firm(app);
    await invoice(f);
    await putTariff(f, 8);
    const pt = await preview(f, tariffUrl(f.tariffId));
    const ps = await preview(f, SETTINGS_URL);
    const fingerprintBefore = await fingerprint(f, (await inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { companyId: f.companyId } }))).id);
    const counts = () =>
      inCompany(f.auth, async () => ({
        jobs: await prisma.job.count({ where: { companyId: f.companyId } }),
        audits: await prisma.auditLog.count({ where: { companyId: f.companyId, action: { in: ['tariff.recompare', 'settings.recompare', 'invoice.recalculate'] } } }),
      }));
    const before = await counts();

    const calls: [string, unknown][] = [
      [`${tariffUrl(f.tariffId)}/preview`, {}],
      [tariffUrl(f.tariffId), { token: pt.token }],
      [`${SETTINGS_URL}/preview`, {}],
      [SETTINGS_URL, { token: ps.token }],
    ];
    for (const [url, payload] of calls) {
      const r = await app.inject({ method: 'POST', url, headers: f.auth, payload: payload as Record<string, unknown> });
      expectAsyncRequired(r);
    }

    expect(await counts()).toEqual(before);
    const inv = await inCompany(f.auth, () => prisma.invoice.findFirstOrThrow({ where: { companyId: f.companyId } }));
    expect(await fingerprint(f, inv.id)).toEqual(fingerprintBefore);
  });
});
