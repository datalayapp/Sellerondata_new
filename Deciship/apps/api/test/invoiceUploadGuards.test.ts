/** Yükleme korumaları: aynı gönderilerin ikinci faturası uyarısı, fatura no normalleştirme, imkânsız takvim günü. */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { bigCsv } from '../../../packages/core/test/fixtures/robustness/build.ts';
import { invoiceNoKey, normInvoiceNo, parseDateInput } from '../src/lib/util.ts';
import { getApp, multipart, registerCompany } from './helpers.ts';

type Auth = { authorization: string };
const API = '/api/deciship';
const N = 12;
const base = Buffer.from(bigCsv(N)).toString('utf8');
const refChanged = base.replace(/,SIP-(\d+)/g, ',REF-$1');

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

async function setup() {
  const admin = await registerCompany(app);
  const r = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: 'FedEx Test' } });
  expect(r.statusCode, r.body).toBe(201);
  return { auth: admin.auth as Auth, carrierId: r.json().carrier.id as string };
}
async function preview(c: { auth: Auth; carrierId: string }, csv: string) {
  const form = multipart([
    { name: 'carrierId', value: c.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv, 'utf8') },
  ]);
  const p = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.auth, ...form.headers }, payload: form.payload });
  expect(p.statusCode, p.body).toBe(200);
  return p.json();
}
async function create(c: { auth: Auth; carrierId: string }, csv: string, over: Record<string, unknown>) {
  const p = await preview(c, csv);
  return app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: c.auth,
    payload: { fileId: p.fileId, carrierId: c.carrierId, invoiceNo: 'X-1', invoiceDate: '2026-10-31', currency: 'TRY', mapping: p.suggestedMapping, acknowledgeIssues: true, ...over },
  });
}

describe('aynı gönderilerin ikinci faturası uyarısı', () => {
  it('önizleme ve eşleme kontrolü örtüşmeyi döner; örtüşme yoksa null', async () => {
    const c = await setup();
    expect((await preview(c, base)).overlap).toBeNull();
    const first = await create(c, base, { invoiceNo: 'MNG-OVERLAP-1' });
    expect(first.statusCode, first.body).toBe(201);

    const again = await preview(c, refChanged);
    expect(again.overlap).toMatchObject({ total: N, matched: N, invoiceNo: 'MNG-OVERLAP-1', invoiceId: first.json().invoice.id });

    const v = await app.inject({ method: 'POST', url: `${API}/invoices/preview/verify`, headers: c.auth, payload: { fileId: again.fileId, carrierId: c.carrierId, mapping: again.suggestedMapping } });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().overlap).toMatchObject({ matched: N, invoiceNo: 'MNG-OVERLAP-1' });

    // fatura silinince uyarı kalkar; başka şirkette hiç görünmez
    expect((await app.inject({ method: 'DELETE', url: `${API}/invoices/${first.json().invoice.id}`, headers: c.auth })).statusCode).toBe(204);
    expect((await preview(c, refChanged)).overlap).toBeNull();
    const other = await setup();
    expect((await preview(other, base)).overlap).toBeNull();
  });
});

describe('fatura numarası normalleştirme', () => {
  it('anahtar: İ/ı, büyük/küçük harf, sıfır genişlikli karakter ve NFKC', () => {
    expect(invoiceNoKey('FATURA-I9')).toBe(invoiceNoKey('fatura-ı9'));
    expect(invoiceNoKey('FATURA-İ9')).toBe(invoiceNoKey('fatura-i9'));
    expect(invoiceNoKey('AB\u200B-12\uFEFF')).toBe(invoiceNoKey('ab-12'));
    expect(normInvoiceNo(' ＡＢ-１２ \u200D')).toBe('AB-12');
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): aynı gönderiler başka numarayla yüklenince artık 409 INVOICE_OVERLAP döner; onayla (confirmOverlap) yüklenir.
  it('içe aktarma ve düzenleme: aynı numara sayılır, kaydedilen numara temizlenir', async () => {
    const c = await setup();
    const a = await create(c, base, { invoiceNo: 'FATURA-I9' });
    expect(a.statusCode, a.body).toBe(201);
    const b = await create(c, refChanged, { invoiceNo: 'fatura-ı9' });
    expect(b.statusCode, b.body).toBe(409);
    expect(b.json().error.code).toBe('INVOICE_EXISTS');
    const z = await create(c, refChanged, { invoiceNo: 'FATURA\u200B-I9' });
    expect(z.statusCode, z.body).toBe(409);

    // numara serbest ama gönderiler ilk faturada: onaysız yüklenmez (numara denetimi çakışma denetiminden önce gelir: üstteki 409'lar)
    const unconfirmed = await create(c, refChanged, { invoiceNo: 'B\u200B-77 ' });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(409);
    expect(unconfirmed.json().error).toMatchObject({ code: 'INVOICE_OVERLAP', details: { overlap: { total: N, matched: N, invoiceId: a.json().invoice.id, invoiceNo: 'FATURA-I9' } } });

    const ok = await create(c, refChanged, { invoiceNo: 'B\u200B-77 ', confirmOverlap: true });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().invoice.invoiceNo).toBe('B-77');
    const patch = await app.inject({ method: 'PATCH', url: `${API}/invoices/${ok.json().invoice.id}`, headers: c.auth, payload: { invoiceNo: 'fatura-ı9' } });
    expect(patch.statusCode, patch.body).toBe(409);
  });
});

describe('imkânsız takvim günü', () => {
  it('parseDateInput 2026-02-31 değerini reddeder, 2028-02-29 kabul eder', () => {
    expect(parseDateInput('2026-02-31')).toBeUndefined();
    expect(parseDateInput('2026-04-31T00:00:00.000Z')).toBeUndefined();
    expect(parseDateInput('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('içe aktarma ve fatura düzenleme 400 VALIDATION döner', async () => {
    const c = await setup();
    const bad = await create(c, base, { invoiceNo: 'D-1', invoiceDate: '2026-02-31' });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION');
    const badPeriod = await create(c, base, { invoiceNo: 'D-2', periodFrom: '2026-02-31' });
    expect(badPeriod.statusCode, badPeriod.body).toBe(400);

    const ok = await create(c, base, { invoiceNo: 'D-3' });
    expect(ok.statusCode, ok.body).toBe(201);
    for (const payload of [{ invoiceDate: '2026-02-31' }, { periodTo: '2026-06-31' }]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/invoices/${ok.json().invoice.id}`, headers: c.auth, payload });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
  });
});
