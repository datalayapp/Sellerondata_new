import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { getApp, multipart, registerCompany, SAMPLES } from './helpers.ts';

type Auth = { authorization: string };

const FIXTURE = path.join(SAMPLES, 'invoices', 'fedex-fbo-tr-sample.csv');
const fixtureExists = fs.existsSync(FIXTURE);

async function preview(app: FastifyInstance, auth: Auth, carrierId: string, data: Buffer, filename = 'invoice_2026-11-01_23_53.csv') {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename, contentType: 'text/csv', data },
  ]);
  const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe('FedEx Billing Online (TR) içe aktarma', () => {
  // Örnek dosya depoda izlenir; yoksa takım sessizce atlanmaz, kırılır.
  it('örnek dosya yerinde', () => {
    expect(fixtureExists, FIXTURE).toBe(true);
  });

  let app: FastifyInstance;
  let auth: Auth;
  let carrierId: string;
  const data = fs.readFileSync(FIXTURE);

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app, 'FBO Test')).auth;
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: 'FedEx FBO' } });
    expect(c.statusCode, c.body).toBe(201);
    carrierId = c.json().carrier.id;
  });

  it('bozuk kayıtlı eşleme 0 takip no bulursa kalıba düşer; tanılama ve meta döner', async () => {
    const bad = {
      trackingNo: 'MPS Paketi Takip Numarası',
      netAmount: 'Orijinal Ödenecek Tutar',
      surchargeColumns: [],
      amountsIncludeVat: false,
      vatPct: 20,
      desiAsWeight: false,
    };
    const patch = await app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${carrierId}`, headers: auth, payload: { defaultMapping: bad } });
    expect(patch.statusCode, patch.body).toBe(200);

    const p = await preview(app, auth, carrierId, data);
    expect(p.mappingSource).toBe('preset');
    expect(p.missing).toEqual([]);
    expect(p.headers).toHaveLength(78);
    expect(p.rowCount).toBe(8);
    expect(p.suggestedMapping.trackingNo).toBe('Havayolu Konşimentosu Numarası');
    expect(p.suggestedMapping.netAmount).toBe('Havayolu Konşimentosu Toplam Tutar');
    expect(p.suggestedMapping.chargePairs).toHaveLength(6);
    expect(p.guessedMeta).toEqual({ invoiceNo: '999000111', invoiceDate: '2026-10-28', currency: 'TRY' });
    expect(p.diagnostics).toMatchObject({ rowCount: 8, trackingFilled: 8, parsedLines: 8, netTotal: 10180, charges: { pairs: 6, rowsMatchingNet: 8 }, invoiceTotal: { value: 10180, difference: 0 } });
    expect(p.diagnostics.fields.trackingNo).toMatchObject({ filled: 8 });
    expect(p.diagnostics.warnings.map((w: { code: string }) => w.code)).toEqual(['SAVED_MAPPING_FALLBACK']);
    expect(p.columnFill).toHaveLength(78);
    expect(p.columnFill[56]).toBe(0);
    expect(p.columnFill[16]).toBe(8);
  });

  it('0 satır okunan içe aktarmayı 400 NO_LINES ile reddeder', async () => {
    const p = await preview(app, auth, carrierId, data);
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: {
        fileId: p.fileId,
        carrierId,
        invoiceNo: 'FBO-EMPTY',
        invoiceDate: '2026-10-28',
        currency: 'TRY',
        mapping: { ...p.suggestedMapping, trackingNo: 'MPS Paketi Takip Numarası' },
        acknowledgeIssues: true,
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('NO_LINES');
    expect(res.json().error.message).toMatch(/hiç fatura satırı okunamadı/);
    const list = await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth });
    expect(list.json().items.find((i: { invoiceNo: string }) => i.invoiceNo === 'FBO-EMPTY')).toBeUndefined();
  });

  it('önerilen eşleme + meta ile içe aktarır; çiftler ve birimler satırlara yansır', async () => {
    const p = await preview(app, auth, carrierId, data);
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.fileId, carrierId, ...p.guessedMeta, mapping: p.suggestedMapping, saveMapping: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const inv = res.json().invoice;
    expect(inv.invoiceNo).toBe('999000111');
    expect(inv.totals.lineCount ?? inv.totals.lines ?? 8).toBe(8);

    const lines = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?pageSize=100`, headers: auth })).json().items as {
      trackingNo: string;
      status: string;
      netAmount: number;
      surcharges: { code: string; amount: number }[];
      billedKg: number | null;
    }[];
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l.status === 'UNMATCHED')).toBe(true);
    expect(Math.round(lines.reduce((s, l) => s + Number(l.netAmount), 0) * 100) / 100).toBe(10180);
    const first = lines.find((l) => l.trackingNo === '870000000011')!;
    expect(first.surcharges.map((s) => s.code)).toEqual(['ITHALAT_HIZMET_UCRETI', 'EPH_UCRETI', 'PEAK']);
    expect(Number(lines.find((l) => l.trackingNo === '870000000022')!.billedKg)).toBe(3.175);

    // kaydedilen eşleme tekrar kullanılır (ücret çiftleri dahil)
    const again = await preview(app, auth, carrierId, data);
    expect(again.mappingSource).toBe('saved');
    expect(again.suggestedMapping.chargePairs).toHaveLength(6);
    expect(again.diagnostics.trackingFilled).toBe(8);

    // KARARLAR "Birebir aynı satır" (2026-11-10): birebir aynı satırlar artık atlanmaz (eskiden 400 NO_LINES); başka numarayla yeniden yükleme
    // açık onay ister, onayla yüklenince bütün satırlar "Mükerrer" olur.
    expect(again.overlap).toMatchObject({ total: 8, matched: 8, invoiceId: inv.id, invoiceNo: '999000111' });
    const dupPayload = { fileId: again.fileId, carrierId, invoiceNo: '999000111-B', invoiceDate: '2026-10-28', currency: 'TRY', mapping: again.suggestedMapping };
    const dup = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: dupPayload });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'INVOICE_OVERLAP', details: { overlap: { total: 8, matched: 8, invoiceId: inv.id, invoiceNo: '999000111' } } });
    const listed = await app.inject({ method: 'GET', url: '/api/deciship/invoices', headers: auth });
    expect(listed.json().items.find((i: { invoiceNo: string }) => i.invoiceNo === '999000111-B')).toBeUndefined();

    const confirmed = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { ...dupPayload, confirmOverlap: true } });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    // Y28: eski 'skipped' alanı (hep 0) yanıttan kalktı
    expect(confirmed.json()).not.toHaveProperty('skipped');
    const dupLines = (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${confirmed.json().invoice.id}/lines?pageSize=100`, headers: auth })).json().items as {
      diffTypes: string[];
      pricing?: { confidence?: string } | null;
    }[];
    expect(dupLines).toHaveLength(8);
    expect(dupLines.every((l) => l.diffTypes.includes('DUPLICATE'))).toBe(true);
    // aynı taşıyıcı + aynı tutar: kesin mükerrer ("İncele" değil)
    expect(dupLines.every((l) => l.pricing?.confidence !== 'LOW')).toBe(true);
    expect(confirmed.json().invoice.totals.overchargeTotal).toBeCloseTo(10180, 2);
  });
});
