import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, Prisma } from '../src/db.ts';
import { runJobInline } from '../src/services/jobs/runner.ts';
import { getApp, multipart, registerCompany, SAMPLES, inCompany } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/** Güvenli tarife içe aktarma: önizleme/kontrol, seçenekler, onay, yapay zekâ (sahte), sürümler, geri yükleme, yeniden karşılaştırma. */

const calls: Record<string, unknown>[] = [];
let nextText = '';
/** KALANLAR 6.18: yanıttan hemen önce (çağrı sürerken) çalışır */
let duringCall: (() => Promise<void>) | null = null;

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            finalMessage: async () => {
              if (duringCall) await duringCall();
              return {
                model: 'claude-sonnet-5-5',
                stop_reason: 'end_turn',
                usage: { input_tokens: 1000, output_tokens: 300 },
                content: [{ type: 'text', text: nextText }],
              };
            },
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IPE = fs.readFileSync(path.join(SAMPLES, 'tariffs/fedex-us-list-ipe.csv'));
const TEMPLATE = fs.readFileSync(path.join(SAMPLES, 'tariff-template-example.xlsx'));

/** İndirim sütunu dolu örnek: kodla temiz dosya. */
async function templateWithDiscount() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(TEMPLATE as never);
  const prices = wb.worksheets[0]!;
  const col = prices.getRow(1).cellCount + 1;
  prices.getRow(1).getCell(col).value = 'İndirim %';
  prices.getRow(2).getCell(col).value = 0;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function aiAnswer(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    verdict: 'reject',
    summary: 'Bu dosya ABD çıkışlı genel liste fiyatı.',
    issues: [
      { severity: 'error', code: 'WRONG_ORIGIN', title: 'Fiyatlar ABD çıkışlı', detail: 'Satır 1: "U.S. Package"', suggestion: null },
      { severity: 'warning', code: 'AI_LIST_RATES', title: 'Liste fiyatı', detail: null, suggestion: 'Sözleşme fiyatını yükleyin.' },
    ],
    detected: { carrier: 'FedEx', service: 'International Priority Express', origin: 'ABD', weightUnit: 'lb', currency: 'usd', effectiveDate: '2026-01-05', isListRate: true },
    identity: {
      description: 'FedEx International Priority Express için ABD çıkışlı genel liste fiyatları (05.01.2026’dan itibaren)',
      suggestedName: 'FedEx International Priority — ABD liste fiyatı 2026',
      suggestedService: 'International Priority Express',
      suggestedValidFrom: '2026-01-05',
      suggestedValidTo: 'bilinmiyor',
    },
    ...over,
  });
}

function tariffPayload(carrierId: string) {
  return {
    carrierId,
    name: 'FedEx IE 2026',
    service: 'International Economy',
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }],
    discountPct: 38,
    fuelPct: 25,
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    isDefault: true,
    zones: [
      { country: 'FR', zone: 'A' },
      { country: 'DE', zone: 'A' },
      { country: 'GB', zone: 'B' },
    ],
    rates: [
      { zone: 'A', weightUpto: 6, price: 1527.75 },
      { zone: 'A', weightUpto: 9.5, price: 2119.35 },
      { zone: 'B', weightUpto: 6, price: 1800 },
    ],
    overflow: [],
    surcharges: [],
  };
}

async function upload(app: FastifyInstance, auth: Auth, tariffId: string, name: string, data: Buffer) {
  const form = multipart([{ name: 'file', filename: name, contentType: name.endsWith('.csv') ? 'text/csv' : XLSX_MIME, data }]);
  return app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
}

const codes = (checks: { code: string; severity: string }[], sev: string) => checks.filter((c) => c.severity === sev).map((c) => c.code);

describe('Güvenli tarife içe aktarma', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let carrierId: string;
  let tariffId: string;
  let invoiceLines = 0;

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app, 'Tarife İçe Aktarma')).auth;
    carrierId = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex' } })).json().carrier.id;
    const t = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariffPayload(carrierId) });
    expect(t.statusCode, t.body).toBe(201);
    tariffId = t.json().tariff.id;

    // bir fatura: son faturaların ülke/para birimi bağlamı + yeniden karşılaştırma için
    const file = 'fedex-9-482-11735.csv';
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: file, contentType: 'text/csv', data: fs.readFileSync(path.join(SAMPLES, 'invoices', file)) },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    const inv = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.json().fileId, carrierId, invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', mapping: p.json().suggestedMapping },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    invoiceLines = await inCompany(auth, () => prisma.invoiceLine.count({ where: { invoiceId: inv.json().invoice.id } }));
  });
  afterAll(() => {
    process.env.ANTHROPIC_API_KEY = '';
  });

  it('IPE.csv önizlemesi lb + USD yüzünden engellenir; bölgeler A..O', async () => {
    const r = await upload(app, auth, tariffId, 'IPE.csv', IPE);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.canApply).toBe(false);
    expect(p.aiAvailable).toBe(false);
    expect(codes(p.checks, 'error')).toEqual(expect.arrayContaining(['WEIGHT_UNIT_LB', 'CURRENCY_MISMATCH']));
    expect(codes(p.checks, 'error')).not.toContain('ZONE_MAPPING_MISSING');
    expect(p.summary).toMatchObject({ detectedWeightUnit: 'lb', detectedCurrency: 'USD', tariffCurrency: 'TRY', zoneCount: 15, weightCount: 100 });
    expect([...new Set(p.rates.map((x: { zone: string }) => x.zone))]).toEqual('ABCDEFGHIJKLMNO'.split(''));
    expect(p.rates[0]).not.toHaveProperty('row');
    expect(p.fixes).toEqual([
      expect.objectContaining({ id: 'convertLbToKg', resolves: ['WEIGHT_UNIT_LB'] }),
      expect.objectContaining({ id: 'setCurrency', value: 'USD', resolves: ['CURRENCY_MISMATCH'] }),
    ]);
    expect(p.comparison).toEqual(expect.arrayContaining([expect.objectContaining({ zone: 'A' })]));

    const blocked = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: true } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('IMPORT_BLOCKED');
    expect(codes(blocked.json().error.details.checks, 'error')).toContain('WEIGHT_UNIT_LB');
    // tarife değişmedi
    const t = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}`, headers: auth })).json().tariff;
    expect(t.rates).toHaveLength(3);
  });

  it('seçeneklerle yeniden kontrol → hatalar kalkar; onaysız 409, onaylı uygular ve sürüm oluşturur; geri yükleme eskiyi getirir', async () => {
    const p = (await upload(app, auth, tariffId, 'IPE.csv', IPE)).json();
    const options = { convertLbToKg: true, currency: 'usd' };
    const re = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/recheck`, headers: auth, payload: { options } });
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json().draftId).toBe(p.draftId);
    expect(re.json().canApply).toBe(true);
    expect(re.json().summary.tariffCurrency).toBe('USD');
    expect(re.json().summary.maxWeight).toBe(45.359);
    expect(codes(re.json().checks, 'info')).toContain('CURRENCY_VS_INVOICES');

    const noAck = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/apply`, headers: auth, payload: { options, acknowledged: false } });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().error.code).toBe('ACK_REQUIRED');

    const badMeta = await app.inject({
      method: 'POST',
      url: `/api/deciship/tariff-imports/${p.draftId}/apply`,
      headers: auth,
      payload: { options, acknowledged: true, meta: { validFrom: '2026-12-31', validTo: '2026-01-01' } },
    });
    expect(badMeta.statusCode).toBe(400);
    const badDate = await app.inject({
      method: 'POST',
      url: `/api/deciship/tariff-imports/${p.draftId}/apply`,
      headers: auth,
      payload: { options, acknowledged: true, meta: { validFrom: '05.01.2026' } },
    });
    expect(badDate.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/deciship/tariff-imports/${p.draftId}/apply`,
      headers: auth,
      payload: {
        options,
        acknowledged: true,
        meta: { name: '  FedEx International Priority — ABD liste fiyatı 2026 ', service: 'International Priority Express', validFrom: '2026-01-05', validTo: null },
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const applied = ok.json();
    expect(applied.affectedInvoices).toBe(1);
    expect(applied.tariff).toMatchObject({
      currency: 'USD',
      name: 'FedEx International Priority — ABD liste fiyatı 2026',
      service: 'International Priority Express',
      validFrom: '2026-01-05',
      validTo: null,
      discountPct: 38,
      zones: [{ country: 'DE', zone: 'A' }, { country: 'FR', zone: 'A' }, { country: 'GB', zone: 'B' }],
    });
    expect(applied.tariff.rates).toHaveLength(1500);
    expect(applied.tariff.rates.find((r: { zone: string; weightUpto: number }) => r.zone === 'A' && r.weightUpto === 0.454).price).toBe(132.61);

    // taslak uygulandıktan sonra kullanılamaz
    const gone = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/recheck`, headers: auth, payload: { options: {} } });
    expect(gone.statusCode).toBe(404);

    const versions = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: auth })).json().items;
    expect(versions[0]).toMatchObject({ id: applied.versionId, reason: 'IMPORT', label: 'IPE.csv içe aktarılmadan önceki sürüm', rateCount: 3, zoneCount: 2, countryCount: 3, currency: 'TRY', user: { name: 'Yönetici Test' } });

    const restore = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/versions/${applied.versionId}/restore`, headers: auth });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json().affectedInvoices).toBe(1);
    expect(restore.json().tariff).toMatchObject({ name: 'FedEx IE 2026', currency: 'TRY', service: 'International Economy', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(restore.json().tariff.rates).toEqual(
      tariffPayload(carrierId).rates.map((r) => ({ ...r, perKg: false })).sort((a, b) => a.zone.localeCompare(b.zone) || a.weightUpto - b.weightUpto),
    );

    const after = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: auth })).json().items;
    expect(after[0]).toMatchObject({ id: restore.json().versionId, reason: 'RESTORE', currency: 'USD', rateCount: 1500 });
    // geri yüklemeyi de geri alabilir
    const redo = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/versions/${restore.json().versionId}/restore`, headers: auth });
    expect(redo.json().tariff.currency).toBe('USD');
    await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/versions/${applied.versionId}/restore`, headers: auth });
  });

  it('PUT bir EDIT sürümü oluşturur; yeniden karşılaştırma taşıyıcının faturalarını günceller', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${tariffId}`, headers: auth, payload: { ...tariffPayload(carrierId), fuelPct: 20 } });
    expect(put.statusCode, put.body).toBe(200);
    const v = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: auth })).json().items[0];
    expect(v).toMatchObject({ reason: 'EDIT', label: 'Elle düzenlenmeden önceki sürüm' });
    const snap = await inCompany(auth, () => prisma.tariffVersion.findUnique({ where: { id: v.id } }));
    expect((snap!.snapshot as { fuelPct: number }).fuelPct).toBe(25);

    // Mesaj 4: toplu yeniden karşılaştırma önizleme + özet (token) ister
    // Y83: yalnız arka planda (`viaJob` işin sonucunu eski yanıt biçiminde verir); işin sonucu `stopped` sayısını da taşır
    const pv = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices/preview`, headers: auth, payload: {} });
    expect(pv.statusCode, pv.body).toBe(200);
    const rc = await viaJob(app, { method: 'POST', url: `/api/deciship/tariffs/${tariffId}/recompare-invoices`, headers: auth, payload: { token: pv.json().token } });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(rc.json()).toEqual({ invoices: 1, lines: invoiceLines, skipped: { inDispute: 0, stale: 0 }, stopped: 0 });
  });

  it('başka şirketin taslağı / sürümü 404; çalışan erişemez', async () => {
    const p = (await upload(app, auth, tariffId, 'ornek.xlsx', TEMPLATE)).json();
    const other = (await registerCompany(app, 'Başka')).auth;
    expect((await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/recheck`, headers: other, payload: { options: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/apply`, headers: other, payload: { options: {}, acknowledged: true } })).statusCode).toBe(404);
    const vId = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: auth })).json().items[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/versions/${vId}/restore`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}/versions`, headers: other })).statusCode).toBe(404);
    const bad = await upload(app, auth, tariffId, 'x.pdf', Buffer.from('%PDF-1.4 nope'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_FILE');
    // eski taslaklar 24 saat sonra geçersiz
    await inCompany(auth, () => prisma.tariffImportDraft.update({ where: { id: p.draftId }, data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } }));
    expect((await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/recheck`, headers: auth, payload: { options: {} } })).statusCode).toBe(404);
  });

  it('yapay zekâ incelemesi (sahte): kapalıyken 503; açıkken saklanır, temiz dosya incelemesiz uygulanır, olumsuz inceleme onay ister', async () => {
    const p0 = (await upload(app, auth, tariffId, 'ornek.xlsx', TEMPLATE)).json();
    const off = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p0.draftId}/review`, headers: auth, payload: {} });
    expect(off.statusCode).toBe(503);
    expect(off.json().error.code).toBe('AI_DISABLED');

    process.env.ANTHROPIC_API_KEY = 'test-key';
    const clean = (await upload(app, auth, tariffId, 'ornek.xlsx', await templateWithDiscount())).json();
    expect(clean.aiAvailable).toBe(true);
    expect(codes(clean.checks, 'warning')).toEqual([]);
    expect(clean.headline).toMatchObject({ status: 'ok', title: 'Dosya uygun' });
    // kodla temiz dosya: yapay zekâ incelemesi gerekmez → onaysız uygulanır, yapay zekâ çağrılmaz
    calls.length = 0;
    const noReview = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${clean.draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: false } });
    expect(noReview.statusCode, noReview.body).toBe(200);
    expect(calls).toHaveLength(0);
    const p = (await upload(app, auth, tariffId, 'ornek.xlsx', await templateWithDiscount())).json();

    nextText = aiAnswer();
    calls.length = 0;
    // KALANLAR 6.18: inceleme yalnız arka planda; `async` yoksa 400 ASYNC_REQUIRED, yapay zekâ çağrılmaz, taslağa yazılmaz
    const sync = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/review`, headers: auth, payload: { options: {} } });
    expect(sync.statusCode, sync.body).toBe(400);
    expect(sync.json().error.code).toBe('ASYNC_REQUIRED');
    expect(calls).toHaveLength(0);
    expect((await inCompany(auth, () => prisma.tariffImportDraft.findUnique({ where: { id: p.draftId } })))!.aiReview).toBeNull();
    const rev = await viaJob(app, { method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/review`, headers: auth, payload: { options: {} } });
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.start.statusCode).toBe(202);
    expect(rev.job).toMatchObject({ kind: 'TARIFF_IMPORT_REVIEW', status: 'SUCCEEDED' });
    const r = rev.json();
    expect(r).toMatchObject({ verdict: 'reject', model: 'claude-sonnet-5-5', detected: { currency: 'USD', isListRate: true } });
    expect(r.issues.map((i: { code: string }) => i.code)).toEqual(['AI_WRONG_ORIGIN', 'AI_LIST_RATES']);
    expect(r.issues[0]).not.toHaveProperty('suggestion');
    expect(r.identity).toMatchObject({ suggestedName: 'FedEx International Priority — ABD liste fiyatı 2026', suggestedValidFrom: '2026-01-05', suggestedValidTo: null });
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain('FedEx IE 2026');
    expect(sent).toContain('1: Ağırlık (kg/desi)'); // ham satırlar gönderildi
    expect((calls[0] as { output_config: { effort: string } }).output_config.effort).toBe('medium');
    const stored = await inCompany(auth, () => prisma.tariffImportDraft.findUnique({ where: { id: p.draftId } }));
    expect((stored!.aiReview as { verdict: string }).verdict).toBe('reject');
    // yeniden deneme (bitiş yazılmadan süreç ölmüş gibi) incelemeyi taslaktan alır: ikinci çağrı ve ikinci ücret yok
    const jobId = rev.job!.id;
    await inCompany(auth, () => prisma.job.update({ where: { id: jobId }, data: { status: 'QUEUED', result: Prisma.DbNull, finishedAt: null, lockedBy: null, lockedUntil: null } }));
    expect(await runJobInline(jobId)).toBe(true);
    const retried = (await app.inject({ method: 'GET', url: `/api/deciship/jobs/${jobId}`, headers: auth })).json();
    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.result).toEqual(r);
    expect(calls).toHaveLength(1);
    // inceleme 3: ödenmiş çağrıdan sonra taslağa yazılmadan süreç öldü: yeniden deneme işe özgü önbellekten alır, ikinci ücret yok
    await inCompany(auth, async () => {
      await prisma.tariffImportDraft.update({ where: { id: p.draftId }, data: { aiReview: Prisma.DbNull } });
      await prisma.job.update({ where: { id: jobId }, data: { status: 'QUEUED', result: Prisma.DbNull, finishedAt: null, lockedBy: null, lockedUntil: null } });
    });
    expect(await runJobInline(jobId)).toBe(true);
    const cached = (await app.inject({ method: 'GET', url: `/api/deciship/jobs/${jobId}`, headers: auth })).json();
    expect(cached.status).toBe('SUCCEEDED');
    expect(cached.result).toEqual(r);
    expect(calls).toHaveLength(1);
    expect(((await inCompany(auth, () => prisma.tariffImportDraft.findUnique({ where: { id: p.draftId } })))!.aiReview as { verdict: string }).verdict).toBe('reject');
    // inceleme 4: inceleme sürerken taslak uygulanıp silinirse iş 404 ile biter (iç hata değil)
    const gone = (await upload(app, auth, tariffId, 'ornek.xlsx', await templateWithDiscount())).json();
    duringCall = () => inCompany(auth, () => prisma.tariffImportDraft.deleteMany({ where: { id: gone.draftId } })).then(() => undefined);
    try {
      const lost = await viaJob(app, { method: 'POST', url: `/api/deciship/tariff-imports/${gone.draftId}/review`, headers: auth, payload: { options: {} } });
      expect(lost.statusCode, lost.body).toBe(404);
      expect(lost.json().error.code).toBe('NOT_FOUND');
    } finally {
      duringCall = null;
    }

    const noAck = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: false } });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().error.details.aiVerdict).toBe('reject');

    // olumlu inceleme + uyarı yok → onaysız uygulanır
    nextText = aiAnswer({ verdict: 'ok', issues: [] });
    expect((await viaJob(app, { method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/review`, headers: auth, payload: {} })).statusCode).toBe(200);
    const ok = await app.inject({ method: 'POST', url: `/api/deciship/tariff-imports/${p.draftId}/apply`, headers: auth, payload: { options: {}, acknowledged: false } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().tariff.rates.length).toBeGreaterThan(50);
  });
});
