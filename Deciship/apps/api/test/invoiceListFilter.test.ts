/**
 * Mesaj 14 (08-B9): `GET /invoices` arama ve durum süzgeci.
 *
 *  - `q`: fatura no parça eşleşir (büyük-küçük harf duyarsız); takip no normalleştirilip tam eşleşir (4+ karakter).
 *  - `status`: `DIFF` (fark satırı var), `UNMATCHED` (ölçümü eksik satır var), `TO_DISPUTE` (fazla ödeme var ve etkin
 *    itiraz turu yok). Kayıtlı toplamdan okunur.
 *  - Taşıyıcı ve tarih süzgeciyle birlikte çalışır; örnek ve silinmiş fatura, başka firma görünmez; yanıt şekli aynı.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { caller, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { getApp, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

/** Ölçümsüz satırlarla fatura: hepsi "Eşleşmedi" (fark yok, fazla ödeme yok). */
async function unmatchedInvoice(app: FastifyInstance, c: DisputeCompany, trackings: string[]) {
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;50`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: c.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: c.admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: c.carrierId,
      invoiceNo: uniq('U'),
      invoiceDate: trDay(-10),
      currency: c.currency,
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return { invoiceId: inv.json().invoice.id as string, invoiceNo: inv.json().invoice.invoiceNo as string };
}

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

/** `tariffPayload`'ın 5 desideki fiyatı (50 + %10 yakıt): faturada bu tutar kesin fark verir (ölçü 3 desi → beklenen 33). */
const EXACT = 55;

async function list(app: FastifyInstance, auth: Auth, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ pageSize: '100', ...query }).toString();
  const r = await app.inject({ method: 'GET', url: `${API}/invoices?${qs}`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: { id: string; invoiceNo: string; disputeStatus: string }[]; total: number; page: number; pageSize: number };
}

const ids = (p: { items: { id: string }[] }) => p.items.map((i) => i.id).sort();

describe('GET /invoices: arama ve durum', () => {
  let app: FastifyInstance;
  let c: DisputeCompany;
  /** fark var, itirazsız */
  let open: { invoiceId: string; invoiceNo: string; lines: { id: string; trackingNo: string }[] };
  /** fark var, itirazı gönderilmiş */
  let sent: { invoiceId: string; invoiceNo: string };
  /** fark var, itirazı geri çekilmiş (yeniden itiraz bekliyor) */
  let withdrawn: { invoiceId: string; invoiceNo: string };
  /** fark var, hepsi uyumlu sayılmış (fazla ödeme yok) */
  let accepted: { invoiceId: string; invoiceNo: string };
  /** yalnız ölçümsüz satır */
  let unmatched: { invoiceId: string; invoiceNo: string };
  let unmatchedTracking: string;

  beforeAll(async () => {
    app = await getApp();
    c = await disputeCompany(app);
    const call = caller(app);
    // 55 TL = tarifenin faturadaki 5 desideki fiyatı: kesin fark (Fazla ödeme'ye girer). 100 TL tarifeden %82 sapar ve
    // satır "İncele" (tahmini) olur: fazla ödeme 0, "İtiraz bekliyor" süzgecine hiç girmez (kurulum hatasıydı).
    open = await invoiceWithDiffs(app, c, [EXACT, EXACT], { verify: 0 });
    sent = await invoiceWithDiffs(app, c, [EXACT], { verify: 1 });
    expect((await call(c.admin.auth, 'POST', `/invoices/${sent.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, sent.invoiceId) })).statusCode).toBe(201);
    withdrawn = await invoiceWithDiffs(app, c, [EXACT], { verify: 1 });
    const w = await call(c.admin.auth, 'POST', `/invoices/${withdrawn.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, withdrawn.invoiceId) });
    expect(w.statusCode, w.body).toBe(201);
    const active = w.json().dispute.active as { id: string; version: number };
    const back = await call(c.admin.auth, 'POST', `/disputes/${active.id}/withdraw`, { version: active.version, reason: 'yanlış' });
    expect(back.statusCode, back.body).toBe(200);
    accepted = await invoiceWithDiffs(app, c, [EXACT], { verify: 0 });
    const [line] = (await call(c.admin.auth, 'GET', `/invoices/${accepted.invoiceId}/lines`)).json().items as { id: string }[];
    expect((await call(c.admin.auth, 'PATCH', `/invoice-lines/${line!.id}`, { decision: 'ACCEPTED', reason: 'tamam' })).statusCode).toBe(200);
    unmatchedTracking = trackingNo();
    unmatched = await unmatchedInvoice(app, c, [unmatchedTracking, trackingNo()]);
  });

  it('durum: fark var, ölçümü eksik, itiraz bekliyor', async () => {
    const all = await list(app, c.admin.auth);
    expect(all.total).toBe(5);
    expect(ids(await list(app, c.admin.auth, { status: 'DIFF' }))).toEqual([open.invoiceId, sent.invoiceId, withdrawn.invoiceId, accepted.invoiceId].sort());
    expect(ids(await list(app, c.admin.auth, { status: 'UNMATCHED' }))).toEqual([unmatched.invoiceId]);
    // fazla ödeme var ve etkin tur yok: geri çekilen itiraz yeniden bekler; uyumlu sayılan fatura beklemez
    const toDispute = await list(app, c.admin.auth, { status: 'TO_DISPUTE' });
    expect(ids(toDispute)).toEqual([open.invoiceId, withdrawn.invoiceId].sort());
    expect(toDispute.total).toBe(2);
    expect(errorCode(await app.inject({ method: 'GET', url: `${API}/invoices?status=OPEN`, headers: c.admin.auth }))).toEqual([400, 'VALIDATION']);
  });

  it('arama: fatura no parça ve harf duyarsız; takip no tam ve normalleştirilmiş; kısa takip no aranmaz', async () => {
    expect(ids(await list(app, c.admin.auth, { q: open.invoiceNo }))).toEqual([open.invoiceId]);
    expect(ids(await list(app, c.admin.auth, { q: open.invoiceNo.toUpperCase().slice(1) }))).toEqual([open.invoiceId]);
    expect(ids(await list(app, c.admin.auth, { q: `  ${open.invoiceNo.toLowerCase()}  ` }))).toEqual([open.invoiceId]);
    // takip no: tam eşleşme (boşluk ve küçük harf normalleştirilir); parçası bulmaz
    const t = open.lines[1]!.trackingNo;
    expect(ids(await list(app, c.admin.auth, { q: t }))).toEqual([open.invoiceId]);
    expect(ids(await list(app, c.admin.auth, { q: `${t.slice(0, 4)} ${t.slice(4)}` }))).toEqual([open.invoiceId]);
    expect((await list(app, c.admin.auth, { q: t.slice(0, -1) })).total).toBe(0);
    expect(ids(await list(app, c.admin.auth, { q: unmatchedTracking }))).toEqual([unmatched.invoiceId]);
    expect((await list(app, c.admin.auth, { q: 'yok-boyle-fatura' })).total).toBe(0);
    // boş arama süzmez
    expect((await list(app, c.admin.auth, { q: '   ' })).total).toBe(5);
    // LIKE joker karakterleri kaçışlanır (Prisma `contains` kaçışlamaz): `%` ve `_` bütün faturaları getirmez
    for (const q of ['%', '_', '%%%%', '\\']) expect((await list(app, c.admin.auth, { q })).total, q).toBe(0);
    expect(ids(await list(app, c.admin.auth, { q: `${open.invoiceNo.slice(0, 3)}%` }))).toEqual([]);
    expect(errorCode(await app.inject({ method: 'GET', url: `${API}/invoices?q=${'x'.repeat(65)}`, headers: c.admin.auth }))).toEqual([400, 'VALIDATION']);
  });

  it('arama ve durum birlikte, taşıyıcı ve tarihle; yanıt şekli aynı', async () => {
    const t = open.lines[0]!.trackingNo;
    expect(ids(await list(app, c.admin.auth, { q: t, status: 'TO_DISPUTE' }))).toEqual([open.invoiceId]);
    expect((await list(app, c.admin.auth, { q: t, status: 'UNMATCHED' })).total).toBe(0);
    expect(ids(await list(app, c.admin.auth, { q: t, carrierId: c.carrierId }))).toEqual([open.invoiceId]);
    expect((await list(app, c.admin.auth, { q: t, carrierId: 'baska-tasiyici' })).total).toBe(0);
    // ölçümsüz fatura 10 gün önce, öbürleri 3 gün önce tarihli
    expect(ids(await list(app, c.admin.auth, { status: 'UNMATCHED', from: trDay(-5) }))).toEqual([]);
    expect(ids(await list(app, c.admin.auth, { status: 'UNMATCHED', to: trDay(-5) }))).toEqual([unmatched.invoiceId]);
    const page = await list(app, c.admin.auth, { status: 'DIFF', pageSize: '2' });
    expect([page.total, page.items.length, page.page, page.pageSize]).toEqual([4, 2, 1, 2]);
    const plain = (await list(app, c.admin.auth, { q: open.invoiceNo })).items[0]!;
    expect(Object.keys(plain).sort()).toEqual(['carrier', 'createdAt', 'currency', 'disputeStatus', 'disputeSums', 'id', 'invoiceDate', 'invoiceNo', 'totals']);
  });

  it('silinmiş fatura ve başka firma görünmez', async () => {
    const gone = await invoiceWithDiffs(app, c, [EXACT], { verify: 0 });
    const t = gone.lines[0]!.trackingNo;
    expect(ids(await list(app, c.admin.auth, { q: t }))).toEqual([gone.invoiceId]);
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${gone.invoiceId}`, headers: c.admin.auth });
    expect(del.statusCode, del.body).toBe(204);
    expect((await list(app, c.admin.auth, { q: t })).total).toBe(0);
    expect((await list(app, c.admin.auth, { q: gone.invoiceNo })).total).toBe(0);

    const stranger = await registerCompany(app, uniq('Yabancı '));
    expect((await list(app, stranger.auth, { q: open.lines[0]!.trackingNo })).total).toBe(0);
    expect((await list(app, stranger.auth, { q: open.invoiceNo })).total).toBe(0);
    expect((await list(app, stranger.auth, { status: 'DIFF' })).total).toBe(0);
  });
});

function errorCode(r: { statusCode: number; json: () => { error?: { code?: string } } }) {
  return [r.statusCode, r.json().error?.code];
}
