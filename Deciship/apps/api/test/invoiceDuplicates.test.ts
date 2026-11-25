/**
 * Mükerrer satır kuralları (KARARLAR 2026-11-10): birebir aynı satır atlanmaz, içeri alınır ve "Mükerrer" olur; aynı
 * dosyanın yeniden yüklenmesi açık onay ister (409 INVOICE_OVERLAP → confirmOverlap). Aynı taşıyıcı + aynı tutar kesin,
 * tutar farklıysa "İncele". Yalnız silinmemiş faturalar sayılır, başka şirketin satırları sayılmaz, yeniden
 * karşılaştırmada yalnız daha önceki faturalar sayılır.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { bigCsv } from '../../../packages/core/test/fixtures/robustness/build.ts';
import { getApp, multipart, registerCompany, uniq } from './helpers.ts';
import { patchInvoice } from './recalcHelpers.ts';

type Auth = { authorization: string };
type Line = { trackingNo: string; diffTypes: string[]; status: string; confidence?: string | null; confidenceReason?: string | null; pricing?: { confidence?: string; confidenceReason?: string | null; reviewCode?: string } | null };
const confidenceOf = (l: Line) => l.pricing?.confidence ?? l.confidence ?? null;

const N = 12;
const base = Buffer.from(bigCsv(N)).toString('utf8');
/** İlk veri satırında yalnız müşteri referansı farklı: aynı takip no, farklı satır (farklı rawHash). */
const changedFirst = base.replace(',SIP-0\r\n', ',SIP-0-B\r\n');

let app: FastifyInstance;

async function setup() {
  const admin = await registerCompany(app);
  const r = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'fedex', name: 'FedEx Test' } });
  expect(r.statusCode, r.body).toBe(201);
  return { auth: admin.auth, carrierId: r.json().carrier.id as string };
}

async function importCsv(c: { auth: Auth; carrierId: string }, csv: string, opts: { confirmOverlap?: boolean; invoiceNo?: string } = {}) {
  const invoiceNo = opts.invoiceNo ?? uniq('INV-');
  const form = multipart([
    { name: 'carrierId', value: c.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv, 'utf8') },
  ]);
  const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...c.auth, ...form.headers }, payload: form.payload });
  expect(p.statusCode, p.body).toBe(200);
  return app.inject({
    method: 'POST',
    url: '/api/deciship/invoices',
    headers: c.auth,
    payload: { fileId: p.json().fileId, carrierId: c.carrierId, invoiceNo, invoiceDate: '2026-10-31', currency: 'TRY', mapping: p.json().suggestedMapping, acknowledgeIssues: true, ...(opts.confirmOverlap ? { confirmOverlap: true } : {}) },
  });
}

async function lines(auth: Auth, id: string): Promise<Line[]> {
  const r = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines?pageSize=100`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items;
}
const dupes = (ls: Line[]) => ls.filter((l) => l.diffTypes.includes('DUPLICATE')).map((l) => l.trackingNo);
const del = async (auth: Auth, id: string) => expect((await app.inject({ method: 'DELETE', url: `/api/deciship/invoices/${id}`, headers: auth })).statusCode).toBe(204);

describe('mükerrer satırlar: yalnız silinmemiş faturalar', () => {
  beforeAll(async () => {
    app = await getApp();
  });

  // KARARLAR "Birebir aynı satır": eskiden bu satırlar sessizce atlanıyordu (ikinci yükleme 400 NO_LINES).
  it('aynı dosya ikinci kez: onay ister; onayla yüklenince satırlar atlanmaz, kesin mükerrer olur; silinince sayılmaz', async () => {
    const c = await setup();
    const first = await importCsv(c, base);
    expect(first.statusCode, first.body).toBe(201);
    const firstNo = first.json().invoice.invoiceNo as string;

    // aynı dosya ikinci kez, onaysız: fatura oluşmaz, hangi faturayla çakıştığı döner
    const again = await importCsv(c, base);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'INVOICE_OVERLAP', details: { overlap: { total: N, matched: N, invoiceId: first.json().invoice.id, invoiceNo: firstNo } } });

    // "yine de yükle": bütün satırlar içeri alınır ve aynı taşıyıcı + aynı tutar olduğu için kesin mükerrerdir
    const confirmed = await importCsv(c, base, { confirmOverlap: true });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const confirmedLines = await lines(c.auth, confirmed.json().invoice.id);
    expect(confirmedLines).toHaveLength(N);
    expect(dupes(confirmedLines)).toHaveLength(N);
    expect(confirmedLines.every((l) => confidenceOf(l) !== 'LOW')).toBe(true);
    expect(confirmed.json().invoice.totals).toMatchObject({ lines: N, diff: N, estimatedLines: 0 });
    expect(confirmed.json().invoice.totals.overchargeTotal).toBeCloseTo(confirmed.json().invoice.totals.billedTotal, 2);

    // yalnız bir satırın referansı farklı dosya: o da çakışır; onayla hepsi içeri alınır
    const partialNo = await importCsv(c, changedFirst);
    expect(partialNo.statusCode, partialNo.body).toBe(409);
    const partial = await importCsv(c, changedFirst, { confirmOverlap: true });
    expect(partial.statusCode, partial.body).toBe(201);
    const partialLines = await lines(c.auth, partial.json().invoice.id);
    expect(partialLines).toHaveLength(N);
    expect(dupes(partialLines)).toHaveLength(N);

    // faturalar silinir (aynı dosya defalarca yüklenip silinmiş gibi): satırları artık sayılmaz, onay da istenmez
    await del(c.auth, first.json().invoice.id);
    await del(c.auth, confirmed.json().invoice.id);
    await del(c.auth, partial.json().invoice.id);
    for (let k = 0; k < 2; k++) {
      const re = await importCsv(c, base);
      expect(re.statusCode, re.body).toBe(201);
      const ls = await lines(c.auth, re.json().invoice.id);
      expect(ls).toHaveLength(N);
      expect(dupes(ls)).toEqual([]);
      await del(c.auth, re.json().invoice.id);
    }
  });

  it('başka şirketin aynı satırları ve takip no\'ları sayılmaz', async () => {
    const a = await setup();
    const b = await setup();
    expect((await importCsv(a, base)).statusCode).toBe(201);
    const res = await importCsv(b, base);
    expect(res.statusCode, res.body).toBe(201);
    expect(dupes(await lines(b.auth, res.json().invoice.id))).toEqual([]);
  });

  it('aynı takip no farklı tutarla: "İncele" (ek fatura olabilir), tutarı Fazla ödeme\'ye girmez', async () => {
    const c = await setup();
    const first = await importCsv(c, base);
    expect(first.statusCode, first.body).toBe(201);
    const firstNo = first.json().invoice.invoiceNo as string;
    // tek satırlık ek fatura: ilk gönderinin takip no'su, tutarı farklı
    const [header, row0] = base.split('\r\n');
    const cells = row0!.split(',');
    cells[16] = '99.50';
    cells[10] = '';
    cells[11] = '';
    cells[12] = '';
    const extra = await importCsv(c, [header, cells.join(',')].join('\r\n') + '\r\n', { confirmOverlap: true });
    expect(extra.statusCode, extra.body).toBe(201);
    const [l] = await lines(c.auth, extra.json().invoice.id);
    expect(l).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'] });
    expect(confidenceOf(l!)).toBe('LOW');
    expect(JSON.stringify(l)).toContain(firstNo);
    expect(extra.json().invoice.totals).toMatchObject({ overchargeTotal: 0, estimatedOverchargeTotal: 99.5, estimatedLines: 1 });
  });

  it('yeniden karşılaştırma: yalnız daha önceki ve silinmemiş faturalar sayılır', async () => {
    const c = await setup();
    const older = await importCsv(c, base);
    expect(older.statusCode, older.body).toBe(201);
    const newer = await importCsv(c, changedFirst, { confirmOverlap: true });
    expect(newer.statusCode, newer.body).toBe(201);
    const newerId = newer.json().invoice.id;
    const olderId = older.json().invoice.id;
    expect(dupes(await lines(c.auth, newerId))).toHaveLength(N);

    // eski faturayı yeniden karşılaştırmak sonraki faturaya bakmaz
    expect((await app.inject({ method: 'POST', url: `/api/deciship/invoices/${olderId}/recompare`, headers: c.auth })).statusCode).toBe(200);
    expect(dupes(await lines(c.auth, olderId))).toEqual([]);
    // yeni fatura kendini saymaz, eskisini sayar
    expect((await app.inject({ method: 'POST', url: `/api/deciship/invoices/${newerId}/recompare`, headers: c.auth })).statusCode).toBe(200);
    expect(dupes(await lines(c.auth, newerId))).toHaveLength(N);

    // eski fatura silinince yeni faturadaki satır artık mükerrer değil
    await del(c.auth, olderId);
    expect((await app.inject({ method: 'POST', url: `/api/deciship/invoices/${newerId}/recompare`, headers: c.auth })).statusCode).toBe(200);
    expect(dupes(await lines(c.auth, newerId))).toEqual([]);
  });

  // Bağımsız inceleme (2026-11-10): mükerrer kararı önceki faturanın taşıyıcısına bakar; o değişince sonraki fatura da yenilenmeli.
  it('önceki faturanın taşıyıcısı değişince sonraki faturadaki kesin mükerrer "İncele" olur', async () => {
    const c = await setup();
    const older = await importCsv(c, base);
    expect(older.statusCode, older.body).toBe(201);
    const newer = await importCsv(c, base, { confirmOverlap: true });
    expect(newer.statusCode, newer.body).toBe(201);
    const newerId = newer.json().invoice.id as string;
    expect((await lines(c.auth, newerId)).every((l) => l.diffTypes.includes('DUPLICATE') && confidenceOf(l) !== 'LOW')).toBe(true);

    const other = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: c.auth, payload: { code: 'ups', name: 'UPS Test' } });
    expect(other.statusCode, other.body).toBe(201);
    const moved = await patchInvoice(app, c.auth, older.json().invoice.id, { carrierId: other.json().carrier.id });
    expect(moved.statusCode, moved.body).toBe(200);

    const after = await lines(c.auth, newerId);
    expect(after).toHaveLength(N);
    expect(after.every((l) => l.diffTypes.includes('DUPLICATE') && confidenceOf(l) === 'LOW')).toBe(true);
    const inv = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${newerId}`, headers: c.auth });
    expect(inv.json().invoice.totals).toMatchObject({ overchargeTotal: 0, estimatedLines: N });
  });
});

// Mesaj 5 Y5: "yine de yükle" onayı birleşik paya bakar; gönderiler iki eski faturaya yayılmış olsa da sorulur.
describe('çakışma onayı: birden çok eski fatura', () => {
  beforeAll(async () => {
    app = await getApp();
  });
  const [header, ...rows] = base.split('\r\n').filter(Boolean);
  const part = (from: number, to: number) => [header, ...rows.slice(from, to)].join('\r\n') + '\r\n';
  async function previewOverlap(c: { auth: Auth; carrierId: string }, csv: string) {
    const form = multipart([
      { name: 'carrierId', value: c.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv, 'utf8') },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...c.auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    return p.json().overlap;
  }

  it('%33 + %33 iki faturada: tek fatura yarıya varmasa da onay istenir; ayrıntıda öbür fatura, metinde ikisi', async () => {
    const c = await setup();
    const a = await importCsv(c, part(0, 4), { invoiceNo: 'ESKI-A' });
    expect(a.statusCode, a.body).toBe(201);
    const b = await importCsv(c, part(4, 8), { invoiceNo: 'ESKI-B' });
    expect(b.statusCode, b.body).toBe(201);
    const expected = {
      total: N,
      matched: 8,
      invoiceId: a.json().invoice.id,
      invoiceNo: 'ESKI-A',
      otherInvoices: [{ invoiceId: b.json().invoice.id, invoiceNo: 'ESKI-B', matched: 4 }],
    };

    // önizleme uyarısı ve sunucu denetimi aynı kural
    expect(await previewOverlap(c, base)).toEqual(expected);
    const unconfirmed = await importCsv(c, base);
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(409);
    const err = unconfirmed.json().error;
    expect(err).toMatchObject({ code: 'INVOICE_OVERLAP', details: { overlap: expected } });
    expect(err.message).toContain('ESKI-A, ESKI-B');

    const ok = await importCsv(c, base, { confirmOverlap: true });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(dupes(await lines(c.auth, ok.json().invoice.id))).toHaveLength(8);
  });

  it('birleşik pay yarının altındaysa (%25 + %17) sorulmaz', async () => {
    const c = await setup();
    expect((await importCsv(c, part(0, 3))).statusCode).toBe(201);
    expect((await importCsv(c, part(3, 5))).statusCode).toBe(201);
    expect(await previewOverlap(c, base)).toBeNull();
    const res = await importCsv(c, base);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('tek fatura: ayrıntı eski biçimde kalır (otherInvoices yok)', async () => {
    const c = await setup();
    const a = await importCsv(c, part(0, 7), { invoiceNo: 'TEK-A' });
    expect(a.statusCode, a.body).toBe(201);
    expect(await previewOverlap(c, base)).toEqual({ total: N, matched: 7, invoiceId: a.json().invoice.id, invoiceNo: 'TEK-A' });
  });
});
