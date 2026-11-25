// Mesaj 10 (15-B2, 10-B16): panelin kullandığı ana uçların gerçek yanıt ŞEKLİ (alan adları ve türleri, değerler değil)
// `test/__contract__/<ad>.json` dosyalarına yazılır. Panelin sahte API'si (`Deciship/apps/web/src/mocks`) bu dosyalara karşı
// sınanır (`Deciship/apps/web/test/mock-contract.test.ts`). Gerçek şekil değişince bu test kırılır; değişiklik bilerek
// yapıldıysa dosyalar `npx vitest run test/contract.test.ts -u` ile yenilenir, ardından panel testi sahte API'yi uydurmayı ister.
import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { mergeShapes, shapeOf, type Shape, type ShapeOptions } from '../../../../scripts/lib/shape.mjs';
import { companyFixture, tariffPayload, type Fixture } from './fixtures.ts';
import { getApp, measurementPayload, multipart, uniq } from './helpers.ts';
import { API, caller, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';

type Contract = { endpoint: string; status: number; code?: string; shape: Shape };
const contracts = new Map<string, Contract>();

/** Bir ucun bir örneğini kaydeder; aynı ada gelen örnekler birleşir (ör. itirazlı ve itirazsız fatura). */
function record(name: string, endpoint: string, res: { statusCode: number; body: string; json: () => unknown }, status: number, opts: ShapeOptions = {}) {
  expect(res.statusCode, `${name}: ${res.body.slice(0, 300)}`).toBe(status);
  const body = res.json() as { error?: { code?: string } };
  const shape = shapeOf(body, opts);
  const prev = contracts.get(name);
  if (prev) {
    expect(prev.endpoint).toBe(endpoint);
    prev.shape = mergeShapes(prev.shape, shape);
  } else contracts.set(name, { endpoint, status, ...(status >= 400 ? { code: body.error?.code } : {}), shape });
}

/** Kimlik, tarih, para kodu dışında anahtarlı kayıtlar (değer kümesi veriye göre değişir). */
const INVOICE_RECORDS = ['$.invoice.importReport.byReason'];
const DASHBOARD_RECORDS = ['$.measurements.byMethod'];
/** İçine bakılmayan yerler: sütun eşlemesi dosyaya göre değişen alanlar taşır (alanın kendisi sözleşmede). */
const INVOICE_OPAQUE = ['$.invoice.mapping'];

/** Atlanan satırlı fatura: iki ölçülmüş fark satırı, bir eşleşmeyen satır, takip nosuz bir satır, tutarı okunamayan bir satır. */
async function invoiceWithSkips(app: FastifyInstance, c: DisputeCompany) {
  const tracking: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    tracking.push(m.json().measurement.trackingNo);
  }
  const csv = ['Takip No;Desi;Tutar', `${tracking[0]};5;50`, `${tracking[1]};5;30`, `${uniq('9')};3;30`, ';3;45', `${uniq('9')};3;abc`].join('\n');
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
      invoiceNo: uniq('F'),
      invoiceDate: trDay(-3),
      currency: c.currency,
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice.id as string;
}

describe('gerçek API yanıt şekilleri (sözleşme dosyaları)', () => {
  let app: FastifyInstance;
  let c: DisputeCompany;
  let fx: Fixture;

  beforeAll(async () => {
    app = await getApp();
    const call = caller(app);
    c = await disputeCompany(app);
    fx = await companyFixture(app);
    const a = c.admin.auth;

    // Faturalar: itirazsız (atlanan satırlı), taslak itirazlı (satırlar listede), gönderilmiş ve kısmen geri alınmış itirazlı
    const plain = await invoiceWithSkips(app, c);
    const draft = await invoiceWithDiffs(app, c, [55, 45]);
    const sent = await invoiceWithDiffs(app, c, [60, 50, 40]);
    const send = await call(a, 'POST', `/invoices/${sent.invoiceId}/disputes`, { selectionDigest: await digestOf(app, a, sent.invoiceId), sentOn: trDay(-1), channel: 'EMAIL', channelNote: 'efatura@ornek.test' });
    record('dispute-send', 'POST /api/deciship/invoices/:id/disputes', send, 201);
    const round = send.json().dispute.active as { id: string; version: number; lines: { id: string; claimedAmount: number }[] };
    const result = await call(a, 'POST', `/disputes/${round.id}/results`, {
      version: round.version,
      kind: 'RECOVERED',
      resultOn: trDay(0),
      creditNoteNo: 'AD-1',
      lines: [{ disputeLineId: round.lines[0]!.id, amount: round.lines[0]!.claimedAmount }],
    });
    record('dispute-result', 'POST /api/deciship/disputes/:id/results', result, 200);
    const again = await call(a, 'POST', `/invoices/${sent.invoiceId}/disputes`, { selectionDigest: await digestOf(app, a, sent.invoiceId), sentOn: trDay(0), channel: 'EMAIL' });
    record('error-409-dispute-active', 'POST /api/deciship/invoices/:id/disputes', again, 409);

    // Durum çeşidi: bir satırı geri alınmış tur yeniden gönderilip yeni tur geri çekilir. Etkin tur yok (NONE) ama geri alınan
    // satır geçerli kalır: listede `disputeSums` dolu (spec/itiraz.md "geçerli satır"). Bu çeşit karışık örnekte (null | nesne)
    // görünmez; ayrı dosyada tek örnek olarak durur.
    const wd = await invoiceWithDiffs(app, c, [58, 48]);
    const s1 = await call(a, 'POST', `/invoices/${wd.invoiceId}/disputes`, { selectionDigest: await digestOf(app, a, wd.invoiceId), sentOn: trDay(-2), channel: 'EMAIL' });
    expect(s1.statusCode, s1.body).toBe(201);
    const r1 = s1.json().dispute.active as typeof round;
    const rec1 = await call(a, 'POST', `/disputes/${r1.id}/results`, { version: r1.version, kind: 'RECOVERED', resultOn: trDay(-1), creditNoteNo: 'AD-2', lines: [{ disputeLineId: r1.lines[0]!.id, amount: r1.lines[0]!.claimedAmount }] });
    expect(rec1.statusCode, rec1.body).toBe(200);
    const s2 = await call(a, 'POST', `/disputes/${r1.id}/resend`, { selectionDigest: await digestOf(app, a, wd.invoiceId), version: rec1.json().dispute.active.version, sentOn: trDay(0), channel: 'EMAIL' });
    expect(s2.statusCode, s2.body).toBe(200);
    const r2 = s2.json().dispute.active as typeof round;
    const w = await call(a, 'POST', `/disputes/${r2.id}/withdraw`, { version: r2.version, reason: 'sözleşme' });
    expect(w.statusCode, w.body).toBe(200);
    const wdList = (await call(a, 'GET', `/invoices?q=${encodeURIComponent(wd.invoiceNo)}`)).json() as { items: { id: string; disputeStatus: string }[] };
    const wdItems = wdList.items.filter((i) => i.id === wd.invoiceId);
    expect(wdItems.map((i) => i.disputeStatus)).toEqual(['NONE']);
    record('invoices-list-withdrawn-after-recovery', 'GET /api/deciship/invoices', { statusCode: 200, body: '', json: () => ({ ...wdList, items: wdItems }) }, 200);

    // Taşıyıcı süresi olan (FedEx) ve kanal notsuz gönderilmiş fatura: `deadlines.carrier` ve boş `channelNote` örneği
    const fedex = await call(a, 'POST', '/carriers', { code: 'fedex', name: uniq('FedEx ') });
    expect(fedex.statusCode, fedex.body).toBe(201);
    const fedexId = fedex.json().carrier.id as string;
    const ft = await call(a, 'POST', '/tariffs', tariffPayload(fedexId, { currency: c.currency }));
    expect(ft.statusCode, ft.body).toBe(201);
    const fdx = await invoiceWithDiffs(app, { ...c, carrierId: fedexId }, [57, 47]);
    const fs1 = await call(a, 'POST', `/invoices/${fdx.invoiceId}/disputes`, { selectionDigest: await digestOf(app, a, fdx.invoiceId), sentOn: trDay(0), channel: 'PORTAL' });
    expect(fs1.statusCode, fs1.body).toBe(201);
    // Gönderilmemiş FedEx faturası: süresi yaklaşanlar (`summary.dueSoon`) taşıyıcı süresiyle
    await invoiceWithDiffs(app, { ...c, carrierId: fedexId }, [56, 46]);
    // Hiçbir faturaya girmemiş ölçüm (`invoiceStatus: null`)
    const lone = measurementPayload();
    const lm = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...lone.headers }, payload: lone.payload });
    expect(lm.statusCode, lm.body).toBe(201);

    // Kimlik, ayarlar, kurulum, ön tanımlı koliler, taşıyıcılar
    record('me', 'GET /api/deciship/me', await call(a, 'GET', '/me'), 200);
    record('settings', 'GET /api/deciship/settings', await call(a, 'GET', '/settings'), 200);
    record('settings-onboarding', 'GET /api/deciship/settings/onboarding', await call(a, 'GET', '/settings/onboarding'), 200);
    record('box-presets', 'GET /api/deciship/box-presets', await call(a, 'GET', '/box-presets'), 200);
    record('carriers', 'GET /api/deciship/carriers', await call(a, 'GET', '/carriers'), 200);

    // Tarifeler
    const tariffs = await call(a, 'GET', '/tariffs');
    record('tariffs-list', 'GET /api/deciship/tariffs', tariffs, 200);
    record('tariffs-list', 'GET /api/deciship/tariffs', await call(fx.admin.auth, 'GET', '/tariffs'), 200);
    const tariffId = tariffs.json().items[0].id as string;
    record('tariff', 'GET /api/deciship/tariffs/:id', await call(a, 'GET', `/tariffs/${tariffId}`), 200);
    record('tariff', 'GET /api/deciship/tariffs/:id', await call(fx.admin.auth, 'GET', `/tariffs/${fx.tariffId}`), 200);
    record('tariff-versions', 'GET /api/deciship/tariffs/:id/versions', await call(fx.admin.auth, 'GET', `/tariffs/${fx.tariffId}/versions`), 200);
    record('tariff-quote', 'POST /api/deciship/tariffs/:id/quote', await call(a, 'POST', `/tariffs/${tariffId}/quote`, { lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4 }), 200);
    const dup = tariffPayload(c.carrierId, { rates: [{ zone: 'TR', weightUpto: 1, price: 10 }, { zone: 'TR', weightUpto: 1, price: 12 }] });
    record('error-400-validation', 'POST /api/deciship/tariffs', await call(a, 'POST', '/tariffs', dup), 400);

    // Ölçümler
    record('measurements-list', 'GET /api/deciship/measurements', await call(a, 'GET', '/measurements'), 200);
    record('measurements-list', 'GET /api/deciship/measurements', await call(fx.admin.auth, 'GET', '/measurements'), 200);
    record('measurement', 'GET /api/deciship/measurements/:id', await call(fx.admin.auth, 'GET', `/measurements/${fx.measurement.id}`), 200);

    // Fatura listesi, ayrıntı, satırlar (bütün örnekler birleşir)
    record('invoices-list', 'GET /api/deciship/invoices', await call(a, 'GET', '/invoices'), 200);
    record('invoices-list', 'GET /api/deciship/invoices', await call(fx.admin.auth, 'GET', '/invoices'), 200);
    for (const [who, id] of [[a, plain], [a, draft.invoiceId], [a, sent.invoiceId], [a, wd.invoiceId], [a, fdx.invoiceId], [fx.admin.auth, fx.invoiceId]] as const) {
      record('invoice', 'GET /api/deciship/invoices/:id', await call(who, 'GET', `/invoices/${id}`), 200, { records: INVOICE_RECORDS, opaque: INVOICE_OPAQUE });
      record('invoice-lines', 'GET /api/deciship/invoices/:id/lines', await call(who, 'GET', `/invoices/${id}/lines`), 200);
    }
    record('invoice-dispute-text', 'GET /api/deciship/invoices/:id/dispute', await call(a, 'GET', `/invoices/${draft.invoiceId}/dispute?lang=tr`), 200);
    record('invoice-tariff-health', 'GET /api/deciship/invoices/:id/tariff-health', await call(a, 'GET', `/invoices/${plain}/tariff-health`), 200);
    const plainLine = (await call(a, 'GET', `/invoices/${plain}/lines?status=DIFF`)).json().items[0] as { id: string };
    record('invoice-line-patch', 'PATCH /api/deciship/invoice-lines/:id', await call(a, 'PATCH', `/invoice-lines/${plainLine.id}`, { decision: 'VERIFIED' }), 200);

    // İtiraz listesi ve pano
    record('disputes-list', 'GET /api/deciship/disputes', await call(a, 'GET', '/disputes'), 200);
    record('dashboard', 'GET /api/deciship/dashboard', await call(a, 'GET', `/dashboard?month=${trDay(-3).slice(0, 7)}`), 200, { records: DASHBOARD_RECORDS });

    // En sık hata gövdeleri
    record('error-404', 'GET /api/deciship/invoices/:id', await call(a, 'GET', `/invoices/${crypto.randomUUID()}`), 404);
    record('error-403', 'GET /api/deciship/invoices', await call(c.worker.auth, 'GET', '/invoices'), 403);
  });

  const NAMES = [
    'me',
    'settings',
    'settings-onboarding',
    'box-presets',
    'carriers',
    'tariffs-list',
    'tariff',
    'tariff-versions',
    'tariff-quote',
    'measurements-list',
    'measurement',
    'invoices-list',
    'invoices-list-withdrawn-after-recovery',
    'invoice',
    'invoice-lines',
    'invoice-line-patch',
    'invoice-dispute-text',
    'invoice-tariff-health',
    'disputes-list',
    'dispute-send',
    'dispute-result',
    'dashboard',
    'error-400-validation',
    'error-403',
    'error-404',
    'error-409-dispute-active',
  ];

  it('her sözleşmenin örneği alındı', () => {
    expect([...contracts.keys()].sort()).toEqual([...NAMES].sort());
  });

  for (const name of NAMES) {
    it(`şekil: ${name}`, async () => {
      const c = contracts.get(name);
      expect(c, name).toBeDefined();
      await expect(`${JSON.stringify(c, null, 2)}\n`).toMatchFileSnapshot(`./__contract__/${name}.json`);
    });
  }
});
