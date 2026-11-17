/**
 * Mesaj 14 (08-B1): toplu karar, `POST /invoices/:id/lines/decide` (services/bulkDecide.ts).
 *
 *  - Uygunluk: `VERIFIED` yalnız açık, "Fark var", işaretsiz ve kesin satıra; `ACCEPTED` "İncele" işaretliye de; `OPEN`
 *    yalnız kararı verilmiş satıra. Etkin itirazdaki satıra hiçbir kararda dokunulmaz. Atlananlar nedenine göre sayılır.
 *  - Süzgeçle seçimde `expectedCount` ve küme özeti (`selectionDigest`, Y127) kilit altında denetlenir (409
 *    SELECTION_CHANGED, hiçbir şey yazılmaz). Süzgecin tanımı liste ucuyla aynıdır (`buildLineWhere`).
 *  - Toplam kararla aynı işlemde yazılır, satırlarla tutar; son hesap anı ilerlemez. Satır başına ve fatura için denetim kaydı.
 *  - Geri al: işaretli (`recalcPending`) satır tek satır kuralıyla, faturanın sabit dayanağıyla hesaplanır.
 *  - Merkez etkinliği: fatura başına tek satır, sayıyla; satır izleri akışta yok.
 */
import type { FastifyInstance } from 'fastify';
import type { HubActivityPage } from '@sellerondata/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { buildLineWhere, bulkSkipReason, SELECTION_DIGEST_SELECT, selectionDigest, type LineFilter } from '../src/services/bulkDecide.ts';
import { computeTotals } from '../src/services/compare.ts';
import { caller, digestOf, disputeCompany, invoiceWithDiffs, trDay } from './disputeHelpers.ts';
import { createWorker, findMoneyKeys, getApp, inCompany, issueIdentity, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { authHeader, buildHubApp, ROLE } from './hub/harness.ts';

const API = '/api/deciship';
type Auth = { authorization: string };
type Dims = { lengthCm: number; widthCm: number; heightCm: number };

/** Yalnız rakam: normalleştirme numarayı değiştirmez. */
const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** Desi başına `perKg` TL; yakıt ve ek ücret yok: 3 desi → 3 × perKg (recalculate.test.ts ile aynı). */
const tariffOf = (carrierId: string, perKg: number) => ({
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
});

/** 30×20×15 cm = 3 desi; 26×25×16 = 4 desi (kenar payıyla da). */
const THREE_DESI: Dims = { lengthCm: 30, widthCm: 20, heightCm: 15 };
const FOUR_DESI: Dims = { lengthCm: 26, widthCm: 25, heightCm: 16 };

type Firm = { app: FastifyInstance; auth: Auth; worker: Auth; companyId: string; userId: string; orgName: string; carrierId: string; tariffId: string };

async function firm(app: FastifyInstance): Promise<Firm> {
  const admin = await registerCompany(app, uniq('Toplu '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
  expect(c.statusCode, c.body).toBe(201);
  const carrierId = c.json().carrier.id as string;
  const t = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: admin.auth, payload: tariffOf(carrierId, 10) });
  expect(t.statusCode, t.body).toBe(201);
  return { app, auth: admin.auth, worker: worker.auth, companyId: admin.companyId, userId: admin.userId, orgName: admin.orgName, carrierId, tariffId: t.json().tariff.id };
}

async function measure(f: Firm, tracking: string, dims: Dims = THREE_DESI) {
  const p = measurementPayload({ trackingRaw: tracking, ...dims, weightKg: 2 });
  const r = await f.app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...f.worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.id as string;
}

async function correct(f: Firm, tracking: string, dims: Dims) {
  const head = await inCompany(f.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: tracking, supersededById: null, deletedAt: null } }));
  const r = await f.app.inject({ method: 'PATCH', url: `${API}/measurements/${head.id}`, headers: f.worker, payload: dims });
  expect(r.statusCode, r.body).toBe(200);
}

async function reprice(f: Firm, perKg: number) {
  const r = await f.app.inject({ method: 'PUT', url: `${API}/tariffs/${f.tariffId}`, headers: f.auth, payload: tariffOf(f.carrierId, perKg) });
  expect(r.statusCode, r.body).toBe(200);
}

/** Her satır `desi` ve `amount` ile. Ölçülmüş 3 desi + faturada 5 desi 50 TL = Fark var (beklenen 30, fark 20). */
async function importRows(f: Firm, rows: { tracking: string; desi: number; amount: number }[]) {
  const csv = ['Takip No;Desi;Tutar', ...rows.map((r) => `${r.tracking};${r.desi};${r.amount}`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
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
      carrierId: f.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return { id: inv.json().invoice.id as string, invoiceNo: inv.json().invoice.invoiceNo as string };
}

type Line = { id: string; rowIndex: number; trackingNo: string; status: string; decision: string; expectedAmount: number | null; diffAmount: number | null; recalcPending: string | null; prevResult: { expectedAmount: number | null; diffAmount: number | null; cause: string } | null };

async function lines(f: { app: FastifyInstance; auth: Auth }, invoiceId: string, query = '') {
  const r = await f.app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines${query}`, headers: f.auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Line[]; total: number; selectionDigest: string | null };
}

type Skipped = { inDispute: number; noGap: number; review: number; decided: number; pending: number; notDecided: number; noClaim: number; changedSince: number };
type DecideResult = { opId: string; decision: string; changed: number; changedLineIds: string[]; decidedAt: string | null; skipped: Skipped; totals: Record<string, number> };
const NONE: Skipped = { inDispute: 0, noGap: 0, review: 0, decided: 0, pending: 0, notDecided: 0, noClaim: 0, changedSince: 0 };

const decideMany = (f: { app: FastifyInstance; auth: Auth }, invoiceId: string, payload: Record<string, unknown>) =>
  f.app.inject({ method: 'POST', url: `${API}/invoices/${invoiceId}/lines/decide`, headers: f.auth, payload });

async function decided(f: { app: FastifyInstance; auth: Auth }, invoiceId: string, payload: Record<string, unknown>): Promise<DecideResult> {
  const r = await decideMany(f, invoiceId, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as DecideResult;
}

const patchLine = (f: { app: FastifyInstance; auth: Auth }, lineId: string, payload: Record<string, unknown>) =>
  f.app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: f.auth, payload });

const errorOf = (r: { statusCode: number; json: () => { error?: { code?: string } } }) => [r.statusCode, r.json().error?.code];

const invoiceRow = (auth: Auth, id: string) => inCompany(auth, () => prisma.invoice.findUniqueOrThrow({ where: { id } }));
const lineRows = (auth: Auth, invoiceId: string) => inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }));
const audits = (auth: Auth, action: string, entityIds: string[]) =>
  inCompany(auth, () => prisma.auditLog.findMany({ where: { action, entityId: { in: entityIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));

/** Faturanın ve satırlarının hâli: "hiçbir şey yazılmadı" karşılaştırması için. */
const dbState = (auth: Auth, invoiceId: string) =>
  inCompany(auth, async () =>
    JSON.stringify({
      invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
      lines: await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' } }),
      audits: await prisma.auditLog.count({ where: { action: { in: ['invoiceLine.bulkDecision', 'invoice.linesDecided'] } } }),
    }),
  );

/** Kayıtlı toplam satırlardan yeniden hesaplananla aynı (toplam hiçbir an satırlarla çelişmez). */
async function expectTotalsConsistent(auth: Auth, invoiceId: string) {
  const stored = (await invoiceRow(auth, invoiceId)).totals;
  expect(stored).toEqual(JSON.parse(JSON.stringify(computeTotals(await lineRows(auth, invoiceId)))));
  return stored as Record<string, number>;
}

/**
 * Yedi satır: A, B açık fark (uygun); C fark, önceden itiraz listesinde (kararlı); D uyumlu (3 desi faturalı); E fark,
 * "İncele" işaretli (tahmini); F fark, açık ama yeniden hesap bekliyor; G ölçümsüz (eşleşmedi).
 */
async function mixedInvoice(app: FastifyInstance) {
  const f = await firm(app);
  const t = Array.from({ length: 7 }, trackingNo);
  for (const tr of t.slice(0, 6)) await measure(f, tr);
  const inv = await importRows(f, [
    { tracking: t[0]!, desi: 5, amount: 50 },
    { tracking: t[1]!, desi: 5, amount: 50 },
    { tracking: t[2]!, desi: 5, amount: 50 },
    { tracking: t[3]!, desi: 3, amount: 30 },
    { tracking: t[4]!, desi: 5, amount: 50 },
    { tracking: t[5]!, desi: 5, amount: 50 },
    { tracking: t[6]!, desi: 5, amount: 50 },
  ]);
  const [A, B, C, D, E, F, G] = (await lines(f, inv.id)).items;
  expect([A, B, C, D, E, F, G].map((l) => l!.status)).toEqual(['DIFF', 'DIFF', 'DIFF', 'MATCH', 'DIFF', 'DIFF', 'UNMATCHED']);
  expect((await patchLine(f, C!.id, { decision: 'VERIFIED' })).statusCode).toBe(200);
  // "İncele" ve "yeniden hesap bekliyor" durumları uçtan kurulmaz (güven tarifeden, işaret yalnız donmuş satırda doğar):
  // kural yalnız bu sütunları okur, toplam karar yazımında satırlardan yeniden kurulur.
  await inCompany(f.auth, async () => {
    const e = await prisma.invoiceLine.findUniqueOrThrow({ where: { id: E!.id } });
    await prisma.invoiceLine.update({ where: { id: E!.id }, data: { pricing: { ...((e.pricing as object | null) ?? {}), confidence: 'LOW' } } });
    await prisma.invoiceLine.update({ where: { id: F!.id }, data: { recalcPending: 'OTHER', recalcPendingAt: new Date() } });
  });
  return { f, inv, A: A!, B: B!, C: C!, D: D!, E: E!, F: F!, G: G! };
}

describe('toplu karar: uygunluk', () => {
  it('VERIFIED yalnız açık, fark var, işaretsiz ve kesin satıra; atlananlar nedenine göre; toplam satırlarla tutar', async () => {
    const app = await getApp();
    const { f, inv, A, B, C, D, E, F, G } = await mixedInvoice(app);
    const all = [A, B, C, D, E, F, G].map((l) => l.id);
    const before = await invoiceRow(f.auth, inv.id);

    const r = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: all });
    expect(r).toMatchObject({ decision: 'VERIFIED', changed: 2, changedLineIds: [A.id, B.id] });
    expect(r.skipped).toEqual({ ...NONE, decided: 1, noGap: 2, review: 1, pending: 1 });
    expect(r.opId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await lineRows(f.auth, inv.id);
    const byId = new Map(rows.map((l) => [l.id, l]));
    for (const id of [A.id, B.id]) {
      expect(byId.get(id)).toMatchObject({ decision: 'VERIFIED', decidedById: f.userId, decisionReason: null });
      expect(byId.get(id)!.decidedAt).toBeInstanceOf(Date);
    }
    // atlanan satırların kararı ve rakamı değişmedi
    expect([D, E, F, G].map((l) => byId.get(l.id)!.decision)).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN']);
    expect(byId.get(C.id)!.decision).toBe('VERIFIED');
    expect(rows.map((l) => [l.id, Number(l.expectedAmount), Number(l.diffAmount), l.status])).toEqual(
      [A, B, C, D, E, F, G].map((l) => [l.id, Number(l.expectedAmount), Number(l.diffAmount), l.status]),
    );

    // toplam aynı işlemde: yanıt = kayıtlı = satırlardan; itiraz listesi A + B + C (3 × 20)
    const stored = await expectTotalsConsistent(f.auth, inv.id);
    expect(r.totals).toEqual(stored);
    expect(stored.verifiedTotal).toBe(60);
    // karar son hesap anını ilerletmez
    const after = await invoiceRow(f.auth, inv.id);
    expect(after.calculatedAt?.toISOString()).toBe(before.calculatedAt?.toISOString());

    // "İncele" işaretli satır uyumlu sayılabilir; açık kalan F ise yeniden hesap beklediği için atlanır
    const acc = await decided(f, inv.id, { decision: 'ACCEPTED', reason: 'taşıyıcıyla anlaşıldı', lineIds: [E.id, F.id, D.id] });
    expect(acc).toMatchObject({ changed: 1, changedLineIds: [E.id], skipped: { ...NONE, pending: 1, noGap: 1 } });
    const e = (await lineRows(f.auth, inv.id)).find((l) => l.id === E.id)!;
    expect([e.decision, e.decisionReason]).toEqual(['ACCEPTED', 'taşıyıcıyla anlaşıldı']);
    await expectTotalsConsistent(f.auth, inv.id);

    // kararlı satıra ikinci karar uygulanmaz (uyumlu say A: kararı verilmiş)
    const again = await decided(f, inv.id, { decision: 'ACCEPTED', reason: 'x', lineIds: [A.id] });
    expect(again).toMatchObject({ changed: 0, changedLineIds: [], skipped: { ...NONE, decided: 1 } });
    expect((await lineRows(f.auth, inv.id)).find((l) => l.id === A.id)!.decision).toBe('VERIFIED');
  });

  it('denetim kaydı: satır başına invoiceLine.bulkDecision, fatura için tek invoice.linesDecided (aynı opId); hiçbir satır değişmezse kayıt yok', async () => {
    const app = await getApp();
    const { f, inv, A, B, D } = await mixedInvoice(app);
    const r = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, B.id, D.id] });
    const lineLogs = await audits(f.auth, 'invoiceLine.bulkDecision', [A.id, B.id, D.id]);
    expect(lineLogs.map((a) => a.entityId).sort()).toEqual([A.id, B.id].sort());
    for (const a of lineLogs) {
      expect(a).toMatchObject({ entity: 'InvoiceLine', userId: f.userId, data: { decision: 'VERIFIED', reason: null, previous: 'OPEN', opId: r.opId } });
      expect(findMoneyKeys(a.data)).toEqual([]);
    }
    const invLogs = await audits(f.auth, 'invoice.linesDecided', [inv.id]);
    expect(invLogs).toHaveLength(1);
    expect(invLogs[0]).toMatchObject({ entity: 'Invoice', userId: f.userId, data: { decision: 'VERIFIED', count: 2, opId: r.opId } });
    expect(findMoneyKeys(invLogs[0]!.data)).toEqual([]);

    const none = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [D.id] });
    expect(none.changed).toBe(0);
    expect(await audits(f.auth, 'invoice.linesDecided', [inv.id])).toHaveLength(1);
  });

  it('kural tablosu (saf işlev): sıra itiraz > karar > fark > işaret > talep > İncele; geri alma yalnız o işlemin kararını', () => {
    const base = { decision: 'OPEN', status: 'DIFF', recalcPending: null, pricing: null, inDispute: false, diffTypes: ['DIMENSION'], netAmount: 50, diffAmount: 20 };
    const low = { confidence: 'LOW' };
    expect(bulkSkipReason('VERIFIED', base)).toBeNull();
    expect(bulkSkipReason('ACCEPTED', { ...base, pricing: low })).toBeNull();
    expect(bulkSkipReason('VERIFIED', { ...base, pricing: low })).toBe('review');
    expect(bulkSkipReason('VERIFIED', { ...base, recalcPending: 'MEASUREMENT', pricing: low })).toBe('pending');
    expect(bulkSkipReason('VERIFIED', { ...base, status: 'MATCH', recalcPending: 'OTHER' })).toBe('noGap');
    expect(bulkSkipReason('ACCEPTED', { ...base, decision: 'VERIFIED', status: 'MATCH' })).toBe('decided');
    expect(bulkSkipReason('VERIFIED', { ...base, decision: 'VERIFIED', inDispute: true })).toBe('inDispute');
    // talebi sıfır (fark ≤ 0, mükerrer değil): itiraz listesine girmez, uyumlu sayılabilir; mükerrerde talep faturalanan tutar
    expect(bulkSkipReason('VERIFIED', { ...base, diffAmount: 0, pricing: low })).toBe('noClaim');
    expect(bulkSkipReason('VERIFIED', { ...base, diffAmount: -4 })).toBe('noClaim');
    expect(bulkSkipReason('VERIFIED', { ...base, diffAmount: null })).toBe('noClaim');
    expect(bulkSkipReason('ACCEPTED', { ...base, diffAmount: 0 })).toBeNull();
    expect(bulkSkipReason('VERIFIED', { ...base, diffTypes: ['DUPLICATE'], diffAmount: 0 })).toBeNull();
    expect(bulkSkipReason('OPEN', { ...base, decision: 'ACCEPTED' })).toBeNull();
    expect(bulkSkipReason('OPEN', { ...base, decision: 'ACCEPTED', status: 'MATCH', recalcPending: 'OTHER' })).toBeNull();
    expect(bulkSkipReason('OPEN', base)).toBe('notDecided');
    expect(bulkSkipReason('OPEN', { ...base, decision: 'VERIFIED', inDispute: true })).toBe('inDispute');
    const at = new Date('2026-11-11T10:00:00.123Z');
    const mine = { ...base, decision: 'VERIFIED', decidedById: 'u1', decidedAt: new Date(+at) };
    expect(bulkSkipReason('OPEN', mine, { userId: 'u1', decidedAt: at })).toBeNull();
    expect(bulkSkipReason('OPEN', { ...mine, decidedById: 'u2' }, { userId: 'u1', decidedAt: at })).toBe('changedSince');
    expect(bulkSkipReason('OPEN', { ...mine, decidedAt: new Date(+at + 1) }, { userId: 'u1', decidedAt: at })).toBe('changedSince');
    expect(bulkSkipReason('OPEN', { ...mine, decision: 'OPEN', decidedById: null, decidedAt: null }, { userId: 'u1', decidedAt: at })).toBe('notDecided');
  });
});

describe('toplu karar: gövde ve sınırlar', () => {
  it('gerekçe, seçim biçimi, satır sınırı, başka fatura ve firma: hata, hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const { f, inv, A, B } = await mixedInvoice(app);
    const state = await dbState(f.auth, inv.id);
    const unchanged = async () => expect(await dbState(f.auth, inv.id)).toBe(state);

    expect(errorOf(await decideMany(f, inv.id, { decision: 'ACCEPTED', lineIds: [A.id] }))).toEqual([400, 'REASON_REQUIRED']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'ACCEPTED', reason: '   ', lineIds: [A.id] }))).toEqual([400, 'REASON_REQUIRED']);
    // gerekçe sınırı tek satır kararıyla aynı (1.000)
    expect(errorOf(await decideMany(f, inv.id, { decision: 'ACCEPTED', reason: 'x'.repeat(1001), lineIds: [A.id] }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await patchLine(f, A.id, { decision: 'ACCEPTED', reason: 'x'.repeat(1001) }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED' }))).toEqual([400, 'VALIDATION']);
    const selectionDigest = (await lines(f, inv.id, '?status=DIFF')).selectionDigest;
    expect(selectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id], filter: { status: 'DIFF' }, expectedCount: 1, selectionDigest }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', filter: { status: 'DIFF' }, selectionDigest }))).toEqual([400, 'VALIDATION']);
    // süzgeçle seçimde küme özeti zorunlu (Y127); biçimi bozuk özet de 400
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', filter: { status: 'DIFF' }, expectedCount: 5 }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', filter: { status: 'DIFF' }, expectedCount: 5, selectionDigest: 'dün' }))).toEqual([400, 'VALIDATION']);
    // eski istemci (özet yok, yalnız liste anı): reddedilir, liste anına geri düşülmez
    const old = await decideMany(f, inv.id, { decision: 'VERIFIED', filter: { status: 'DIFF' }, expectedCount: 5, listedAt: new Date().toISOString() });
    expect(errorOf(old)).toEqual([400, 'VALIDATION']);
    expect(old.json().error.details).toEqual([expect.objectContaining({ path: 'selectionDigest' })]);
    // undoOf yalnız geri almada ve kimliklerle
    const undoOf = { opId: crypto.randomUUID(), decidedAt: new Date().toISOString() };
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id], undoOf }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'OPEN', filter: { status: 'DIFF' }, expectedCount: 5, selectionDigest, undoOf }))).toEqual([400, 'VALIDATION']);
    // sunucunun tanımadığı süzgeç alanı yok sayılmaz (seçim ekrandakinden geniş olmasın)
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', filter: { status: 'DIFF', carrier: 'x' }, expectedCount: 5, selectionDigest }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', lineIds: [] }))).toEqual([400, 'VALIDATION']);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'MAYBE', lineIds: [A.id] }))).toEqual([400, 'VALIDATION']);
    const tooMany = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const big = await decideMany(f, inv.id, { decision: 'VERIFIED', lineIds: tooMany });
    expect(errorOf(big)).toEqual([400, 'BULK_TOO_MANY']);
    await unchanged();

    // başka faturanın satırı: 404, bu faturanın satırı da yazılmaz
    const other = await importRows(f, [{ tracking: trackingNo(), desi: 5, amount: 50 }]);
    const [foreign] = (await lines(f, other.id)).items;
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', lineIds: [B.id, foreign!.id] }))).toEqual([404, 'NOT_FOUND']);
    await unchanged();

    // başka firma: fatura yok sayılır (404)
    const stranger = await registerCompany(app, uniq('Yabancı '));
    expect(errorOf(await decideMany({ app, auth: stranger.auth }, inv.id, { decision: 'VERIFIED', lineIds: [B.id] }))).toEqual([404, 'NOT_FOUND']);
    await unchanged();

    // tekrar eden kimlik tek sayılır (5.000 sınırı tekil kimliklere)
    const dup = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, A.id] });
    expect(dup.changedLineIds).toEqual([A.id]);

    // silinmiş fatura
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${other.id}`, headers: f.auth });
    expect(del.statusCode, del.body).toBe(204);
    expect(errorOf(await decideMany(f, other.id, { decision: 'VERIFIED', lineIds: [foreign!.id] }))).toEqual([404, 'NOT_FOUND']);
  });

  it('yetki: deciship.lines.decide (denetleyici evet; muhasebe ve ölçüm 403)', async () => {
    const app = await getApp();
    const { f, inv, A } = await mixedInvoice(app);
    const member = (role: string) => issueIdentity({ companyId: f.companyId, orgName: f.orgName, role, name: `Rol ${role}` });
    const state = await dbState(f.auth, inv.id);
    for (const role of ['ACCOUNTING', 'MEASURE']) {
      const m = await member(role);
      expect(errorOf(await decideMany({ app, auth: m.auth }, inv.id, { decision: 'VERIFIED', lineIds: [A.id] })), role).toEqual([403, 'FORBIDDEN']);
    }
    expect(await dbState(f.auth, inv.id)).toBe(state);
    const auditor = await member('AUDITOR');
    const ok = await decided({ app, auth: auditor.auth }, inv.id, { decision: 'VERIFIED', lineIds: [A.id] });
    expect(ok.changedLineIds).toEqual([A.id]);
  });

  it('yanıtta satır tutarı yok: para alanı yalnız fatura toplamında (fiyat izni olmayana app.ts siler)', async () => {
    const app = await getApp();
    const { f, inv, A, B } = await mixedInvoice(app);
    const r = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, B.id] });
    expect(Object.keys(r).sort()).toEqual(['changed', 'changedLineIds', 'decidedAt', 'decision', 'opId', 'skipped', 'totals']);
    // `totals` dışında hiçbir ad para sözcüğü taşımaz (atlama nedenleri dahil: fiyat izni olmayana silinmesinler)
    expect(findMoneyKeys(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'totals')))).toEqual([]);
    expect(Object.keys(r.skipped).sort()).toEqual(Object.keys(NONE).sort());

    // fiyat izni olmayan rol (denetleyici; kural kaynağında prices.view yoksa): sayaçların hepsi gelir, toplam gelmez
    const auditor = await issueIdentity({ companyId: f.companyId, orgName: f.orgName, role: 'AUDITOR', name: 'Denetleyici' });
    const viaAuditor = await decided({ app, auth: auditor.auth }, inv.id, { decision: 'OPEN', lineIds: [A.id, B.id] });
    expect(Object.keys(viaAuditor.skipped).sort()).toEqual(Object.keys(NONE).sort());
  });
});

describe('toplu karar: süzgeçle "tümünü seç"', () => {
  it('expectedCount tutmazsa 409 SELECTION_CHANGED (beklenen ve bugünkü sayı), hiçbir şey yazılmaz; tutarsa süzgecin satırları', async () => {
    const app = await getApp();
    const { f, inv, A, B, C, E, F } = await mixedInvoice(app);
    const filter = { status: 'DIFF', decision: ['OPEN'] };
    const listed = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    expect(listed.items.map((l) => l.id)).toEqual([A.id, B.id, E.id, F.id]);
    const state = await dbState(f.auth, inv.id);

    const stale = await decideMany(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: listed.total + 1, selectionDigest: listed.selectionDigest });
    expect(errorOf(stale)).toEqual([409, 'SELECTION_CHANGED']);
    // ayrıntı adlarında para sözcüğü yok ("expected" fiyat izni olmayana silinirdi)
    expect(stale.json().error.details).toEqual({ listed: listed.total + 1, current: listed.total, changed: 0 });
    expect(await dbState(f.auth, inv.id)).toBe(state);

    // arada bir satıra tek tek karar verildi: ekrandaki sayı artık tutmaz
    expect((await patchLine(f, A.id, { decision: 'VERIFIED' })).statusCode).toBe(200);
    expect(errorOf(await decideMany(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: listed.total, selectionDigest: listed.selectionDigest }))).toEqual([409, 'SELECTION_CHANGED']);

    const fresh = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    const r = await decided(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: fresh.total, selectionDigest: fresh.selectionDigest });
    expect(r).toMatchObject({ changed: 1, changedLineIds: [B.id], skipped: { ...NONE, review: 1, pending: 1 } });
    expect((await lineRows(f.auth, inv.id)).filter((l) => l.decision === 'VERIFIED').map((l) => l.id).sort()).toEqual([A.id, B.id, C.id].sort());
    await expectTotalsConsistent(f.auth, inv.id);

    // süzgeçte 5.000'den çok satır olamaz (sayı kontrolünden sonra): burada küçük; sınır gövde testinde
    expect(errorOf(await decideMany(f, inv.id, { decision: 'OPEN', filter: { decision: ['VERIFIED'] }, expectedCount: 0, selectionDigest: fresh.selectionDigest }))).toEqual([409, 'SELECTION_CHANGED']);
  });

  it('sayı aynı kalsa da küme değiştiyse 409: liste anından sonra bir satır süzgeçten çıktı, biri girdi; hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const { f, inv, A, B, C, E, F } = await mixedInvoice(app);
    const filter = { status: 'DIFF', decision: ['OPEN'] };
    const listed = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    expect(listed.items.map((l) => l.id)).toEqual([A.id, B.id, E.id, F.id]);
    expect(listed.selectionDigest).toMatch(/^[0-9a-f]{64}$/);

    // A karara girdi (süzgeçten çıktı), C'nin kararı geri alındı (süzgece girdi): toplam yine 4
    expect((await patchLine(f, A.id, { decision: 'VERIFIED' })).statusCode).toBe(200);
    expect((await patchLine(f, C.id, { decision: 'OPEN' })).statusCode).toBe(200);
    expect((await lines(f, inv.id, '?status=DIFF&decision=OPEN')).total).toBe(listed.total);
    const state = await dbState(f.auth, inv.id);

    const r = await decideMany(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: listed.total, selectionDigest: listed.selectionDigest });
    expect(errorOf(r)).toEqual([409, 'SELECTION_CHANGED']);
    expect(r.json().error.details).toMatchObject({ listed: listed.total, current: listed.total });
    expect(r.json().error.details.changed).toBeGreaterThanOrEqual(1);
    expect(await dbState(f.auth, inv.id)).toBe(state);

    // yeni listeyle geçer: C ve B itiraz listesine
    const fresh = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    const ok = await decided(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: fresh.total, selectionDigest: fresh.selectionDigest });
    expect(ok.changedLineIds).toEqual([B.id, C.id]);
  });

  it('Y127: listeden sonra commit edilen ama damgası liste anından önce olan yazım da yakalanır (saatten bağımsız özet)', async () => {
    const app = await getApp();
    const { f, inv, A, C, F } = await mixedInvoice(app);
    const filter = { status: 'DIFF', decision: ['OPEN'] };
    const listed = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    expect(listed.total).toBe(4);
    // Eski denetimin kaçırdığı sıra: yazım işlem içinde liste anından ÖNCEKİ bir damgayla yapılır, commit listeden sonra
    // gelir. Burada damga elle geriye alınır (Prisma açıkça verilen `updatedAt`'i yazar): A süzgeçten çıkar, C girer,
    // sayı yine 4; her iki satırın `updatedAt`'i liste anından önce.
    const past = new Date(Date.now() - 60_000);
    await inCompany(f.auth, async () => {
      await prisma.invoiceLine.update({ where: { id: A.id }, data: { decision: 'VERIFIED', decidedById: f.userId, decidedAt: past, updatedAt: past } });
      await prisma.invoiceLine.update({ where: { id: C.id }, data: { decision: 'OPEN', decidedById: null, decidedAt: null, updatedAt: past } });
    });
    const after = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    expect(after.total).toBe(listed.total);
    const state = await dbState(f.auth, inv.id);
    const r = await decideMany(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: listed.total, selectionDigest: listed.selectionDigest });
    expect(errorOf(r)).toEqual([409, 'SELECTION_CHANGED']);
    expect(r.json().error.details).toEqual({ listed: 4, current: 4, changed: 1 });
    expect(await dbState(f.auth, inv.id)).toBe(state);

    // küme aynı kalsa da kümedeki bir satıra yazım (ör. yeniden hesap; damgası yine geçmişte) özeti değiştirir
    const again = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    await inCompany(f.auth, () => prisma.invoiceLine.update({ where: { id: F.id }, data: { recalcPending: null, updatedAt: new Date(Date.now() - 30_000) } }));
    const state2 = await dbState(f.auth, inv.id);
    const r2 = await decideMany(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: again.total, selectionDigest: again.selectionDigest });
    expect(errorOf(r2)).toEqual([409, 'SELECTION_CHANGED']);
    expect(await dbState(f.auth, inv.id)).toBe(state2);

    // hiçbir şey değişmediyse özet aynıdır ve karar geçer
    const fresh = await lines(f, inv.id, '?status=DIFF&decision=OPEN');
    expect((await lines(f, inv.id, '?status=DIFF&decision=OPEN')).selectionDigest).toBe(fresh.selectionDigest);
    const ok = await decided(f, inv.id, { decision: 'VERIFIED', filter, expectedCount: fresh.total, selectionDigest: fresh.selectionDigest });
    expect(ok.changed).toBeGreaterThan(0);
  });

  it('Y127: özet süzgecin bütün satırlarını kapsar (sayfadan bağımsız); karar izni olmayana özet yok', async () => {
    const app = await getApp();
    const { f, inv, A, B, E, F } = await mixedInvoice(app);
    const q = '?status=DIFF&decision=OPEN';
    const whole = await lines(f, inv.id, `${q}&pageSize=1000`);
    const first = await lines(f, inv.id, `${q}&pageSize=1&page=1`);
    const second = await lines(f, inv.id, `${q}&pageSize=1&page=2`);
    expect(first.items).toHaveLength(1);
    expect([first.selectionDigest, second.selectionDigest]).toEqual([whole.selectionDigest, whole.selectionDigest]);
    expect(first.total).toBe(4);
    // kilit altındaki kümenin özetiyle aynı işlev
    const rows = await inCompany(f.auth, () =>
      prisma.invoiceLine.findMany({ where: buildLineWhere(inv.id, { status: 'DIFF', decision: ['OPEN'] }), select: SELECTION_DIGEST_SELECT }),
    );
    expect(rows.map((l) => l.id).sort()).toEqual([A.id, B.id, E.id, F.id].sort());
    expect(selectionDigest(rows)).toBe(whole.selectionDigest);
    // tek sayfadan seçilen "tümü" bütün süzgece uygulanır
    const r = await decided(f, inv.id, { decision: 'ACCEPTED', reason: 'tümü', filter: { status: 'DIFF', decision: ['OPEN'] }, expectedCount: first.total, selectionDigest: first.selectionDigest });
    expect(r.changedLineIds.sort()).toEqual([A.id, B.id, E.id].sort());

    // karar izni olmayan rol (muhasebe) listeyi görür, özet almaz
    const accounting = await issueIdentity({ companyId: f.companyId, orgName: f.orgName, role: 'ACCOUNTING', name: 'Muhasebe' });
    const seen = await lines({ app, auth: accounting.auth }, inv.id, q);
    expect(seen.selectionDigest).toBeNull();
  });

  it('Y127: özet işlevi sıradan bağımsız, her alana duyarlı', () => {
    const at = new Date('2026-11-12T08:00:00.000Z');
    const a = { id: 'a', updatedAt: at, decision: 'OPEN', status: 'DIFF', recalcPending: null };
    const b = { id: 'b', updatedAt: at, decision: 'OPEN', status: 'DIFF', recalcPending: null };
    const base = selectionDigest([a, b]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(selectionDigest([b, a])).toBe(base);
    for (const changed of [
      { ...b, id: 'c' },
      { ...b, updatedAt: new Date(+at + 1) },
      { ...b, decision: 'VERIFIED' },
      { ...b, status: 'MATCH' },
      { ...b, recalcPending: 'OTHER' },
    ]) {
      expect(selectionDigest([a, changed]), JSON.stringify(changed)).not.toBe(base);
    }
    expect(selectionDigest([a])).not.toBe(base);
    expect(selectionDigest([])).not.toBe(selectionDigest([a]));
  });

  it('itiraz listesine eklemede talebi sıfır olan satır atlanır (noClaim); aynı satır uyumlu sayılabilir', async () => {
    const app = await getApp();
    const { f, inv, A, B } = await mixedInvoice(app);
    // B: "Fark var" ama talep yok (fark 0; ör. yalnız ölçü farkı, tutar tutuyor). Kural yalnız sütunları okur.
    await inCompany(f.auth, () => prisma.invoiceLine.update({ where: { id: B.id }, data: { diffAmount: 0 } }));
    const r = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, B.id] });
    expect(r).toMatchObject({ changed: 1, changedLineIds: [A.id], skipped: { ...NONE, noClaim: 1 } });
    const acc = await decided(f, inv.id, { decision: 'ACCEPTED', reason: 'tutar aynı', lineIds: [B.id] });
    expect(acc.changedLineIds).toEqual([B.id]);
    await expectTotalsConsistent(f.auth, inv.id);
  });

  it('tek satırlık "İtiraz listesine ekle" de aynı kuralla (Y126): talebi sıfır ya da "Fark var" olmayan satır 409 NO_CLAIM, hiçbir şey yazılmaz', async () => {
    const app = await getApp();
    const { f, inv, A, B, D, G } = await mixedInvoice(app);
    await inCompany(f.auth, () => prisma.invoiceLine.update({ where: { id: B.id }, data: { diffAmount: 0 } }));
    const before = await dbState(f.auth, inv.id);
    for (const l of [B, D, G]) {
      const r = await patchLine(f, l.id, { decision: 'VERIFIED' });
      expect(errorOf(r), l.status).toEqual([409, 'NO_CLAIM']);
      expect(r.json().error.message).toBe('Bu satırda talep edilecek tutar yok; itiraz listesine eklenemez');
    }
    expect(await dbState(f.auth, inv.id)).toEqual(before);
    // aynı satır uyumlu sayılabilir; talebi olan satır listeye girer
    expect((await patchLine(f, B.id, { decision: 'ACCEPTED', reason: 'tutar aynı' })).statusCode).toBe(200);
    expect((await patchLine(f, A.id, { decision: 'VERIFIED' })).statusCode).toBe(200);
    await expectTotalsConsistent(f.auth, inv.id);
  });

  it('süzgecin tek tanımı: liste ucu ile buildLineWhere aynı satırları seçer', async () => {
    const app = await getApp();
    const { f, inv, A } = await mixedInvoice(app);
    const cases: [string, LineFilter][] = [
      ['', {}],
      ['?status=DIFF', { status: 'DIFF' }],
      ['?status=MATCH', { status: 'MATCH' }],
      ['?decision=OPEN,VERIFIED', { decision: ['OPEN', 'VERIFIED'] }],
      ['?decision=VERIFIED', { decision: ['VERIFIED'] }],
      ['?review=true', { review: true }],
      ['?review=false', { review: false }],
      ['?recalcPending=true', { recalcPending: true }],
      ['?flagged=true', { flagged: true }],
      ['?diffType=DIMENSION', { diffType: 'DIMENSION' }],
      [`?q=${A.trackingNo.slice(-6)}`, { q: A.trackingNo.slice(-6) }],
      ['?status=DIFF&decision=OPEN&review=true', { status: 'DIFF', decision: ['OPEN'], review: true }],
    ];
    for (const [query, filter] of cases) {
      const listed = await lines(f, inv.id, `${query}${query ? '&' : '?'}pageSize=1000`);
      const direct = await inCompany(f.auth, () => prisma.invoiceLine.findMany({ where: buildLineWhere(inv.id, filter), orderBy: { rowIndex: 'asc' }, select: { id: true } }));
      expect(direct.map((l) => l.id), query).toEqual(listed.items.map((l) => l.id));
      expect(direct.length, query).toBe(listed.total);
    }
    // LIKE joker karakterleri kaçışlanır: `%` ve `_` her satırı bulmaz (Prisma `contains` kaçışlamaz)
    for (const q of ['%', '_', '%%', '\\']) {
      expect((await lines(f, inv.id, `?q=${encodeURIComponent(q)}`)).total, q).toBe(0);
      const direct = await inCompany(f.auth, () => prisma.invoiceLine.count({ where: buildLineWhere(inv.id, { q }) }));
      expect(direct, q).toBe(0);
    }
  });
});

describe('toplu karar: itiraz', () => {
  it('gönderilmiş itirazdaki satıra hiçbir kararda dokunulmaz', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [100, 100, 100, 100], { verify: 2 });
    const sent = await caller(app)(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const f = { app, auth: c.admin.auth };
    const [A, B, C, D] = inv.lines;
    const ids = [A!.id, B!.id, C!.id, D!.id];

    const back = await decided(f, inv.invoiceId, { decision: 'OPEN', lineIds: ids });
    expect(back).toMatchObject({ changed: 0, skipped: { ...NONE, inDispute: 2, notDecided: 2 } });
    const acc = await decided(f, inv.invoiceId, { decision: 'ACCEPTED', reason: 'x', lineIds: ids });
    expect(acc).toMatchObject({ changed: 2, changedLineIds: [C!.id, D!.id], skipped: { ...NONE, inDispute: 2 } });
    const rows = await lineRows(c.admin.auth, inv.invoiceId);
    expect(rows.map((l) => l.decision)).toEqual(['VERIFIED', 'VERIFIED', 'ACCEPTED', 'ACCEPTED']);
    await expectTotalsConsistent(c.admin.auth, inv.invoiceId);
  });

  it('yarış: itiraz gönderimi ile toplu "Geri al" aynı anda; ya itiraz satırları korur ya geri alma itirazı boşa düşürür, ikisi birden olmaz', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [100, 100], { verify: 2 });
    const f = { app, auth: c.admin.auth };
    const selectionDigest = await digestOf(app, c.admin.auth, inv.invoiceId);
    const [send, undo] = await Promise.all([
      caller(app)(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest }),
      decideMany(f, inv.invoiceId, { decision: 'OPEN', lineIds: inv.lines.map((l) => l.id) }),
    ]);
    expect(undo.statusCode, undo.body).toBe(200);
    const r = undo.json() as DecideResult;
    const rows = await lineRows(c.admin.auth, inv.invoiceId);
    if (send.statusCode === 201) {
      // itiraz önce kilidi aldı: satırlar pakette, karar değişmedi
      expect(r).toMatchObject({ changed: 0, skipped: { ...NONE, inDispute: 2 } });
      expect(rows.map((l) => l.decision)).toEqual(['VERIFIED', 'VERIFIED']);
    } else {
      // geri alma önce: gönderilecek satır kalmadı
      expect(errorOf(send)).toEqual([400, 'NO_SENDABLE_LINES']);
      expect(r.changed).toBe(2);
      expect(rows.map((l) => l.decision)).toEqual(['OPEN', 'OPEN']);
    }
    // pakete giren her satır itiraz listesinde
    const inPack = await inCompany(c.admin.auth, () => prisma.disputeLine.findMany({ where: { dispute: { invoiceId: inv.invoiceId } }, select: { invoiceLineId: true } }));
    for (const d of inPack) expect(rows.find((l) => l.id === d.invoiceLineId)!.decision).toBe('VERIFIED');
    await expectTotalsConsistent(c.admin.auth, inv.invoiceId);
  });

  it('yarış: aynı satıra tek satır kararı ve toplu karar aynı anda; toplam satırlarla tutar', async () => {
    const app = await getApp();
    const c = await disputeCompany(app);
    // 55 TL = tarifenin faturadaki 5 desideki fiyatı (50 + %10 yakıt): kesin fark (22). 100 TL tarifeden %82 sapar,
    // satır "İncele" (tahmini) olur ve toplu "İtiraz listesine ekle" onu atlar (kurulum hatasıydı, beklenti aynı).
    const inv = await invoiceWithDiffs(app, c, [55, 55, 55], { verify: 0 });
    const f = { app, auth: c.admin.auth };
    const [A, B] = inv.lines;
    const [single, bulk] = await Promise.all([
      patchLine(f, A!.id, { decision: 'ACCEPTED', reason: 'yarış' }),
      decideMany(f, inv.invoiceId, { decision: 'VERIFIED', lineIds: [A!.id, B!.id] }),
    ]);
    expect(single.statusCode, single.body).toBe(200);
    expect(bulk.statusCode, bulk.body).toBe(200);
    const rows = await lineRows(c.admin.auth, inv.invoiceId);
    // tek satır kararı her sırada son sözü söyler (toplu karar kararlı satıra dokunmaz; önce gelirse tekli üstüne yazar)
    expect(rows.map((l) => l.decision)).toEqual(['ACCEPTED', 'VERIFIED', 'OPEN']);
    expect([1, 2]).toContain((bulk.json() as DecideResult).changed);
    await expectTotalsConsistent(c.admin.auth, inv.invoiceId);
  });
});

describe('toplu karar: geri al ve yeniden hesap bekleyen satır', () => {
  it('geri alınan işaretli satır faturanın sabit dayanağıyla hesaplanır; işaretsiz satır hesaplanmaz; Geri al yanıttaki kimliklerle', async () => {
    const app = await getApp();
    const f = await firm(app);
    const [t1, t2, t3] = [trackingNo(), trackingNo(), trackingNo()];
    for (const t of [t1, t2, t3]) await measure(f, t);
    const inv = await importRows(f, [t1, t2, t3].map((tracking) => ({ tracking, desi: 5, amount: 50 })));
    const all = (await lines(f, inv.id)).items;
    const pinnedRev = (await invoiceRow(f.auth, inv.id)).tariffRevisionId;

    const v = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: all.map((l) => l.id) });
    expect(v.changed).toBe(3);
    // tarife ucuzladı (sabit dayanak eski fiyatta kalmalı); iki onaylı satırın ölçümü düzeltildi
    await reprice(f, 8);
    await correct(f, t1, FOUR_DESI);
    await correct(f, t2, FOUR_DESI);
    expect((await lines(f, inv.id)).items.map((l) => [l.expectedAmount, l.recalcPending])).toEqual([
      [30, 'MEASUREMENT'],
      [30, 'MEASUREMENT'],
      [30, null],
    ]);

    const undo = await decided(f, inv.id, { decision: 'OPEN', lineIds: v.changedLineIds });
    expect(undo).toMatchObject({ changed: 3, skipped: NONE });
    const after = (await lines(f, inv.id)).items;
    // 4 desi × 10 (faturanın sürümü, bugünkü 8 değil) = 40
    for (const l of after.slice(0, 2)) {
      expect(l).toMatchObject({ decision: 'OPEN', expectedAmount: 40, diffAmount: 10, recalcPending: null, prevResult: { expectedAmount: 30, diffAmount: 20, cause: 'MEASUREMENT' } });
    }
    expect(after[2]).toMatchObject({ decision: 'OPEN', expectedAmount: 30, diffAmount: 20, recalcPending: null, prevResult: null });
    expect(undo.totals).toMatchObject({ pendingLines: 0, expectedTotal: 110, overchargeTotal: 40, verifiedTotal: 0 });
    const stored = await expectTotalsConsistent(f.auth, inv.id);
    expect(undo.totals).toEqual(stored);
    const rows = await lineRows(f.auth, inv.id);
    expect(rows.every((l) => l.tariffRevisionId === pinnedRev)).toBe(true);
    expect((await invoiceRow(f.auth, inv.id)).tariffRevisionId).toBe(pinnedRev);
    expect(rows.every((l) => l.decidedById === null && l.decidedAt === null && l.decisionReason === null)).toBe(true);
  });

  it('toplu Geri al (undoOf) yalnız o işlemin kararını açar: arada başkasının ya da sonraki kararı kalır, sayısı döner', async () => {
    const app = await getApp();
    const { f, inv, A, B, D } = await mixedInvoice(app);
    const first = await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, B.id] });
    expect(first.changedLineIds).toEqual([A.id, B.id]);
    expect(first.decidedAt).not.toBeNull();
    const undoOf = { opId: first.opId, decidedAt: first.decidedAt };

    // arada denetleyici B'yi yeniden karara bağladı (aç + uyumlu say): artık onun kararı
    const auditor = await issueIdentity({ companyId: f.companyId, orgName: f.orgName, role: 'AUDITOR', name: 'Denetleyici' });
    const other = { app, auth: auditor.auth };
    expect((await patchLine(other, B.id, { decision: 'OPEN' })).statusCode).toBe(200);
    expect((await patchLine(other, B.id, { decision: 'ACCEPTED', reason: 'denetleyici' })).statusCode).toBe(200);
    // D işlemde hiç yoktu: kendi tek satır kararı (uyumlu satır itiraz listesine giremez, Y126: uyumlu sayılır)
    expect((await patchLine(f, D.id, { decision: 'ACCEPTED', reason: 'tek satır' })).statusCode).toBe(200);

    const undo = await decided(f, inv.id, { decision: 'OPEN', lineIds: first.changedLineIds.concat(D.id), undoOf });
    expect(undo).toMatchObject({ changed: 1, changedLineIds: [A.id], decidedAt: null, skipped: { ...NONE, changedSince: 2 } });
    const rows = new Map((await lineRows(f.auth, inv.id)).map((l) => [l.id, l]));
    expect(rows.get(A.id)).toMatchObject({ decision: 'OPEN', decidedById: null, decidedAt: null });
    expect(rows.get(B.id)).toMatchObject({ decision: 'ACCEPTED', decisionReason: 'denetleyici', decidedById: auditor.userId });
    expect(rows.get(D.id)!.decision).toBe('ACCEPTED');
    await expectTotalsConsistent(f.auth, inv.id);
    // denetim izi geri alınan işleme bağlı
    const logs = await audits(f.auth, 'invoice.linesDecided', [inv.id]);
    expect(logs.at(-1)!.data).toMatchObject({ decision: 'OPEN', count: 1, opId: undo.opId, undoOf: first.opId });

    // aynı kişinin sonraki kararı da korunur (an farklı): A yeniden işaretlenip ikinci kez geri alınmaz
    expect((await patchLine(f, A.id, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const again = await decided(f, inv.id, { decision: 'OPEN', lineIds: [A.id], undoOf });
    expect(again).toMatchObject({ changed: 0, skipped: { ...NONE, changedSince: 1 } });
    expect((await lineRows(f.auth, inv.id)).find((l) => l.id === A.id)!.decision).toBe('VERIFIED');
  });

  it('tek satırlık Geri al da aynı kuralla (ortak işlev): işaret silinir, eski rakam prevResult’ta', async () => {
    const app = await getApp();
    const f = await firm(app);
    const t1 = trackingNo();
    await measure(f, t1);
    const inv = await importRows(f, [{ tracking: t1, desi: 5, amount: 50 }]);
    const [l1] = (await lines(f, inv.id)).items;
    expect((await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [l1!.id] })).changed).toBe(1);
    await correct(f, t1, FOUR_DESI);
    const r = await patchLine(f, l1!.id, { decision: 'OPEN' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().line).toMatchObject({ decision: 'OPEN', expectedAmount: 40, diffAmount: 10, recalcPending: null, prevResult: { expectedAmount: 30, diffAmount: 20, cause: 'MEASUREMENT' } });
    expect(r.json().totals).toMatchObject({ pendingLines: 0 });
    await expectTotalsConsistent(f.auth, inv.id);
  });
});

describe('Merkez etkinliği (Y14)', () => {
  let hub: FastifyInstance;
  beforeAll(async () => {
    hub = await buildHubApp();
  });

  it('toplu karar fatura başına tek satır ve sayıyla; satır izi akışta yok; toplu geçiş etiketi; ayar geçişi Ayarlar’a bağlanır', async () => {
    const app = await getApp();
    const { f, inv, A, B, E } = await mixedInvoice(app);
    await decided(f, inv.id, { decision: 'VERIFIED', lineIds: [A.id, B.id] });
    await decided(f, inv.id, { decision: 'ACCEPTED', reason: 'x', lineIds: [E.id] });
    await inCompany(f.auth, async () => {
      await prisma.auditLog.create({ data: { companyId: f.companyId, userId: f.userId, action: 'invoice.recalculate', entity: 'Invoice', entityId: inv.id, data: { via: { kind: 'settings' } } } });
      await prisma.auditLog.create({ data: { companyId: f.companyId, userId: f.userId, action: 'settings.recompare', entity: 'Company', entityId: f.companyId, data: { invoices: 1, lines: 3, jobId: 'x' } } });
    });
    const actor = { companyId: f.companyId, userId: f.userId };
    const page = async (locale: string, perms: readonly string[] = ROLE.ADMIN) => {
      const res = await hub.inject({ method: 'GET', url: '/api/platform/activity?pageSize=100', headers: authHeader(actor, perms, locale) });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as HubActivityPage).items;
    };
    const tr = await page('tr');
    const actions = tr.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['2 farkı itiraz listesine aldı', '1 farkı uyumlu saydı', 'faturayı toplu geçişte yeniden hesapladı', 'eski faturaları yeni ayara geçirdi']));
    expect(actions.filter((a) => a.includes('bulkDecision') || a.includes('{n}'))).toEqual([]);
    const linesDecided = tr.find((i) => i.action === '2 farkı itiraz listesine aldı')!;
    expect(linesDecided.href).toBe(`/deciship/invoices/${inv.id}?tab=ALL`);
    expect(tr.find((i) => i.action === 'eski faturaları yeni ayara geçirdi')!.href).toBe('/deciship/settings');

    const en = (await page('en')).map((i) => i.action);
    expect(en).toEqual(expect.arrayContaining(['added 2 discrepancies to the dispute list', 'marked 1 discrepancy as matching', 'recalculated an invoice in a bulk update']));

    // ayar izni olmayan (denetleyici) ayar geçişini hiç görmez
    const auditor = (await page('tr', ROLE.AUDITOR)).map((i) => i.action);
    expect(auditor).toContain('2 farkı itiraz listesine aldı');
    expect(auditor).not.toContain('eski faturaları yeni ayara geçirdi');
  });
});
