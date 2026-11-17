/**
 * Merkez'in kayıtlı gerçek yanıtları (Mesaj 10, 15-B2): `Platform/apps/hub-web/e2e/fixtures/deciship-real/*.json`.
 * Bu test gerçek Merkez uçlarının yanıtını üretir ve depodaki kayıtla birebir karşılaştırır; DeciShip Merkez uçları
 * değişince burada kırılır. Merkez tarafında `npm test` (hub-web `test/deciship-contract.test.mjs`) sahte API'yi bu
 * kayda karşı sınar: kayıt yenilenince orada kırılır, sahte API gerçeğe uydurulur.
 *
 * Bilerek yenileme (Deciship/apps/api, test veritabanı açıkken):
 *   npx vitest run test/hub/hubWebFixtures.test.ts -u
 * sonra `git diff Platform/apps/hub-web/e2e/fixtures/deciship-real` ile bak ve Merkez'de `npm test` koş.
 *
 * Değişkenler sabit: saat (Merkez uçlarının "bugün"ü, `ctx.now`) `NOW`'a dondurulur; kimlikler `<id>`, kayıt anları
 * `<zaman>` yazılır. Senaryo: numbers.test.ts "README örnek senaryosu" (örnek veri + fedex-9-482-11735.csv, 27.10.2026)
 * + Sürat taşıyıcısı (tarifesiz) üzerinde K-1 (8 satır), USD-1 (USD) ve önceki dönem için EYLUL. İtiraz: K-1'deki
 * listedeki satır gönderilir ve alacak dekontuyla kısmen geri alınır; FedEx'te bir satır listeye alınıp gönderilir,
 * sonucu bekler. Böylece `recovered` ve `disputePending` sıfırdan farklı, etkinlikte itiraz izleri var. Sahte API'nin
 * taşıdığı seçimli parçalar gerçekte de görünsün diye: K-2 (Kasım, itirazsız: son gün uyarısı `at`/`dueAt` ile), K-3
 * (tarifeden %6 pahalı üç satır: "Tarife sapmaları" tablosu), yapay zekâ çağrıları (biri silinmiş kişiden: `memberId` null;
 * biri reddedilmiş, fatura dosyasına bağlı: ayrıntılı dökümde kayıt adı ve bağlantı; biri geçen ay).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCompany } from '../../src/db.ts';
import { loadSampleData } from '../../src/services/companyData.ts';
import { refreshTotals } from '../../src/services/compare.ts';
import { prisma, ROLE, authHeader, buildHubApp, createCompany, createMember, importSample, insertCarrier, insertInvoice, type Actor } from './harness.ts';

const OUT = path.resolve(import.meta.dirname, '../../../../../Platform/apps/hub-web/e2e/fixtures/deciship-real');
const OCT = 'from=2026-10-01&to=2026-10-31';
/** Yanıtların "bugün"ü: senaryonun bütün tarihlerinden sonra, itiraz süreleri dolmadan. */
const NOW = new Date('2026-11-05T09:00:00.000Z');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Koşudan koşuya değişen değerler: kimlik (bağlantı içinde de) ve kayıt anı. Anahtarlar da aynı kurala uyar. */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') return STAMP.test(value) ? '<zaman>' : value.replace(UUID, '<id>');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(UUID, '<id>'), normalize(v)]));
  return value;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildHubApp();
});
afterAll(async () => {
  await app.close();
});

describe('Merkez kayıtlı gerçek yanıtlar (hub-web e2e/fixtures/deciship-real)', () => {
  let a: Actor;

  beforeAll(async () => {
    a = await createCompany('Örnek Şirket');
    const worker = await createMember(a.companyId, 'Mehmet Demir', 'worker', 'MEASURE');
    await withCompany(a.companyId, () => loadSampleData(a.companyId, { fallbackUserId: worker.id }));
    const fedex = await prisma.carrier.findFirstOrThrow({ where: { companyId: a.companyId, code: 'fedex' } });
    const fedexInvoice = await importSample(app, a, 'fedex-9-482-11735.csv', fedex.id, { invoiceNo: '9-482-11735', invoiceDate: '2026-10-27' });

    // Örnek veride tarifeli bir Aras var; aynı adlı ikinci taşıyıcı sırayı kimliğe bırakırdı (kayıt koşudan koşuya değişirdi).
    const surat = (await insertCarrier(a.companyId, 'surat', 'Sürat Kargo')).id;
    const k1 = await insertInvoice(a, {
      carrierId: surat,
      invoiceNo: 'K-1',
      date: '2026-10-10',
      lines: [
        { status: 'MATCH', net: 100, expected: 100, diff: 0 },
        { status: 'DIFF', net: 300, expected: 200, diff: 100, diffTypes: ['DIMENSION', 'SURCHARGE'], service: 'Economy', country: 'DE' },
        { status: 'DIFF', net: 150, expected: 120, diff: 30, diffTypes: ['WEIGHT'], decision: 'VERIFIED', service: 'Economy', country: 'FR' },
        { status: 'DIFF', net: 80, expected: 60, diff: 20, diffTypes: ['PRICE'], decision: 'ACCEPTED', service: 'Priority', country: 'FR' },
        { status: 'DIFF', net: 70, expected: 60, diff: 10, diffTypes: ['PRICE'], low: true, service: 'Priority', country: 'FR' },
        { status: 'UNMATCHED', net: 11 },
        { status: 'UNMATCHED', net: 22, note: 'Pak/zarf gönderisi — kapsam dışı' },
        { status: 'NO_TARIFF', net: 33 },
      ],
    });
    await insertInvoice(a, { carrierId: surat, invoiceNo: 'USD-1', date: '2026-10-06', currency: 'USD', lines: [{ status: 'DIFF', net: 100, expected: 70, diff: 30, diffTypes: ['WEIGHT'] }, { status: 'UNMATCHED', net: 50 }] });
    await insertInvoice(a, { carrierId: surat, invoiceNo: 'EYLUL', date: '2026-09-20', lines: [{ status: 'DIFF', net: 500, expected: 100, diff: 400, diffTypes: ['PRICE'] }] });

    // İtiraz: K-1 gönderilir, alacak dekontuyla kısmen geri alınır (30 talep, 20 geri).
    const accounting = authHeader(a, ROLE.ACCOUNTING);
    const digest1 = (await app.inject({ method: 'GET', url: `/api/invoices/${k1.id}`, headers: accounting })).json().invoice.dispute.selectionDigest as string;
    const sent = await app.inject({ method: 'POST', url: `/api/invoices/${k1.id}/disputes`, headers: accounting, payload: { sentOn: '2026-10-15', channel: 'EMAIL', selectionDigest: digest1 } });
    expect(sent.statusCode, sent.body).toBe(201);
    const round = sent.json().dispute.active as { id: string; version: number; lines: { id: string }[] };
    const result = await app.inject({
      method: 'POST',
      url: `/api/disputes/${round.id}/results`,
      headers: accounting,
      payload: { version: round.version, kind: 'RECOVERED', resultOn: '2026-10-25', creditNoteNo: 'AD-2026-001', lines: [{ disputeLineId: round.lines[0]!.id, amount: 20 }] },
    });
    expect(result.statusCode, result.body).toBe(200);
    // FedEx: boyut farkı listeye alınır ve gönderilir, sonuç bekler.
    const dim = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: fedexInvoice.id, status: 'DIFF', diffTypes: { has: 'DIMENSION' } } });
    const decided = await app.inject({ method: 'PATCH', url: `/api/invoice-lines/${dim.id}`, headers: authHeader(a, ROLE.ADMIN), payload: { decision: 'VERIFIED' } });
    expect(decided.statusCode, decided.body).toBe(200);
    const digest2 = (await app.inject({ method: 'GET', url: `/api/invoices/${fedexInvoice.id}`, headers: accounting })).json().invoice.dispute.selectionDigest as string;
    const pending = await app.inject({ method: 'POST', url: `/api/invoices/${fedexInvoice.id}/disputes`, headers: accounting, payload: { sentOn: '2026-10-28', channel: 'PORTAL', selectionDigest: digest2 } });
    expect(pending.statusCode, pending.body).toBe(201);
    // Son gün uyarısı: NOW'dan önce kesilmiş, itirazı gönderilmemiş, TTK süresi dolmamış fatura.
    await insertInvoice(a, { carrierId: surat, invoiceNo: 'K-2', date: '2026-11-02', lines: [{ status: 'DIFF', net: 140, expected: 100, diff: 40, diffTypes: ['WEIGHT'], service: 'Economy', country: 'DE' }] });
    // Tarife sapması: aynı ülke, bölge ve hizmette üç satır tarifeden %6-8 pahalı (core tariffHealth "pricier").
    // Tutarlar ayrı: eşit satırların sırası kimliğe kalır, kayıt koşudan koşuya değişirdi.
    const DEV = [6, 7, 8];
    const k3 = await insertInvoice(a, {
      carrierId: surat,
      invoiceNo: 'K-3',
      date: '2026-10-12',
      lines: DEV.map((d) => ({ status: 'DIFF' as const, net: 100 + d, expected: 100, diff: d, diffTypes: ['PRICE'], service: 'Express', country: 'DE' })),
    });
    for (const [i, d] of DEV.entries()) {
      await prisma.invoiceLine.updateMany({
        where: { invoiceId: k3.id, rowIndex: i + 1 },
        data: { pricing: { confidence: 'HIGH', basis: 'TARIFF', rateDeviationPct: d, confidenceReason: null, zone: '3', rateKg: null, mode: null, adjustmentPct: 0 } },
      });
    }
    await withCompany(a.companyId, () => refreshTotals(k3.id));
    // Yapay zekâ kullanımı, NOW ayında: yöneticinin bir tartı okuması, silinmiş kişiden kalan bir sütun eşleme ve FedEx
    // faturasının dosyasında reddedilen bir PDF okuma (ayrıntılı dökümde kayıt adı ve fatura bağlantısı); geçen ay bir okuma
    // (karşılaştırma ve ay listesi). Anlar sabit: döküm sırası koşudan koşuya değişmesin. Firmanın açılışı sabit: seçilebilir
    // aylar (`firstPeriod`, `months`) gerçek takvime bağlı kalmasın.
    await prisma.company.update({ where: { id: a.companyId }, data: { createdAt: new Date('2026-09-01T09:00:00.000Z') } });
    const fedexFile = (await prisma.invoice.findFirstOrThrow({ where: { id: fedexInvoice.id }, select: { sourceFileId: true } })).sourceFileId;
    await prisma.aiUsage.createMany({
      data: [
        { companyId: a.companyId, memberId: a.userId, kind: 'SCALE_READ', status: 'OK', period: '2026-11', model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 80, cost: '0.012000', priceVersion: 'fixture', durationMs: 900, createdAt: new Date('2026-11-03T08:00:00.000Z') },
        { companyId: a.companyId, memberId: null, kind: 'INVOICE_MAPPING', status: 'OK', period: '2026-11', model: 'claude-sonnet-5-5', inputTokens: 3000, outputTokens: 400, cost: '0.030000', priceVersion: 'fixture', durationMs: 2100, createdAt: new Date('2026-11-02T08:00:00.000Z') },
        { companyId: a.companyId, memberId: a.userId, kind: 'INVOICE_PDF', status: 'FAILED', errorCode: 'AI_REFUSED', period: '2026-11', model: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', inputTokens: 5000, outputTokens: 20, cost: '0.020000', priceVersion: 'r42.5:fixture', durationMs: 3000, refType: 'File', refId: fedexFile, createdAt: new Date('2026-11-04T08:00:00.000Z') },
        { companyId: a.companyId, memberId: a.userId, kind: 'SCALE_READ', status: 'OK', period: '2026-10', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 50, cost: '0.010000', priceVersion: 'fixture', durationMs: 800, createdAt: new Date('2026-10-02T08:00:00.000Z') },
      ],
    });
  });

  /** Merkez'in kullandığı uçlar: dosya adı -> [yol, izinler, dil, beklenen durum]. */
  const CASES: [string, string, readonly string[], string, number][] = [
    ['overview.tr', `/platform/overview?${OCT}`, ROLE.ADMIN, 'tr', 200],
    ['overview.en', `/platform/overview?${OCT}`, ROLE.ADMIN, 'en', 200],
    ['overview.measure.tr', `/platform/overview?${OCT}`, ROLE.MEASURE, 'tr', 403],
    ['analytics.tr', `/platform/analytics?${OCT}&compare=previous`, ROLE.ADMIN, 'tr', 200],
    ['datasets.tr', '/platform/datasets', ROLE.ADMIN, 'tr', 200],
    ['datasets.accounting.tr', '/platform/datasets', ROLE.ACCOUNTING, 'tr', 200],
    ['activity.tr', '/platform/activity?page=1&pageSize=5', ROLE.ADMIN, 'tr', 200],
    ['ai-usage.tr', '/platform/ai-usage', ROLE.ADMIN, 'tr', 200],
    ['ai-usage-calls.tr', '/platform/ai-usage/calls?page=1&pageSize=50', ROLE.ADMIN, 'tr', 200],
  ];

  it('yanıtlar kayıtla aynı (bilerek değişiklikte -u ile yenilenir)', async () => {
    const written = new Set<string>();
    const record = async (name: string, url: string, perms: readonly string[], locale: string, status: number) => {
      const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: authHeader(a, perms, locale) });
      expect(res.statusCode, `${name}: ${res.body}`).toBe(status);
      written.add(`${name}.json`);
      await expect.soft(`${JSON.stringify({ status: res.statusCode, body: normalize(res.json()) }, null, 2)}\n`, name).toMatchFileSnapshot(path.join(OUT, `${name}.json`));
      return res;
    };

    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      for (const c of CASES) await record(...c);
      const list = await app.inject({ method: 'GET', url: '/api/platform/datasets', headers: authHeader(a, ROLE.ADMIN) });
      for (const d of (list.json() as { datasets: { id: string }[] }).datasets) {
        await record(`dataset.${d.id}.tr`, `/platform/datasets/${d.id}?page=1&pageSize=4`, ROLE.ADMIN, 'tr', 200);
      }
    } finally {
      vi.useRealTimers();
    }
    // Uç kalkınca kaydı da kalkmalı: klasörde üretilmeyen dosya kalmaz.
    expect(fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).sort()).toEqual([...written].sort());
  });
});
