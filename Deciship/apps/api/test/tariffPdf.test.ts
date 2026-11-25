import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, multipart, registerCompany, inCompany } from './helpers.ts';
import { expectAsyncRequired, viaJob } from './jobHelpers.ts';

/**
 * PDF tarife içe aktarma (sentetik PDF, uydurma sayılar): yükleme taramasız → tuşla kod taraması (yapay zekâsız) →
 * belirlenimci çıkarma → temiz dosya onaysız uygulanır; yapay zekâ taraması/incelemesi yalnız istenince (sahte yapay zekâ).
 */

const calls: { system: string; params: Record<string, unknown> }[] = [];
let discoveryText = '';
let extractionText = '';
let reviewText = '';

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          const system = String(params.system ?? '');
          calls.push({ system, params });
          const text = system.startsWith('You analyse') ? discoveryText : system.startsWith('You transcribe') ? extractionText : reviewText;
          return {
            finalMessage: async () => ({
              model: 'claude-sonnet-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1000, output_tokens: 300 },
              content: [{ type: 'text', text }],
            }),
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

type Auth = { authorization: string };

const SIZE = 8;
const ZONE_X = [230, 290, 350];

/** 4 sayfa: 1 koşullar, 2 IP (zarf/pak/kutu + kg başı), 3 IPE, 4 ülke listesi. Hücreler ayrı ayrı yazılır (gerçek PDF gibi). */
async function syntheticPdf(): Promise<Buffer<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const at = (p: PDFPage, f: PDFFont, text: string, x: number, y: number, centered = false) =>
    p.drawText(text, { x: centered ? x - f.widthOfTextAtSize(text, SIZE) / 2 : x, y, size: SIZE, font: f });
  const terms = doc.addPage([595, 842]);
  ['Genel Sartlar', 'Tum fiyatlar USD cinsinden verilmistir (KDV haric).', 'Boyutsal agirlik orani 1:5, DIM 5000 (cm).', 'Yakit tanimi', 'FIXED 5%'].forEach((l, i) =>
    at(terms, font, l, 40, 800 - i * 14),
  );
  const pricePage = (service: string, base: number) => {
    const p = doc.addPage([595, 842]);
    let y = 800;
    const text = (t: string, x = 140) => {
      at(p, font, t, x, y);
      y -= 11;
    };
    const row = (label: string, vals: string[]) => {
      at(p, font, label, 150, y);
      vals.forEach((v, i) => at(p, font, v, ZONE_X[i]!, y, true));
      y -= 11;
    };
    const k = (n: number) => (n * base).toFixed(2);
    text("DUNYA GENELI / IHRACAT UCRETLERI   2 Haziran 2026'dan itibaren gecerlidir.");
    text('Ekspres teslimat icin:');
    text(service);
    text('- Net Ucretler');
    at(p, font, 'AGIRLIK (KG)', 150, y);
    ['A BOLGESI', 'B BOLGESI', 'ZONE C'].forEach((z, i) => at(p, font, z, ZONE_X[i]!, y, true));
    y -= 11;
    row('', ['USD', 'USD', 'USD']);
    text('FedEx Envelope/FedEx Pak (0,5 - 2,5kg) kullanildiginda ucretler');
    text('FedEx Envelope');
    row('0.5', [k(9.1), k(9.9), k(10.4)]);
    text('FedEx Pak');
    row('0.5', [k(9.2), k(9.95), k(10.45)]);
    text('Diger ambalaj malzemeleri kullanildiginda ucretler (0,5 - 70,5kg)');
    row('0.5', [k(11.1), k(15.3), '#REF!']);
    row('1', [k(12.4), k(16.8), '#REF!']);
    row('10.5', [k(31.5), k(27.2), '#REF!']);
    row('Ilave 0,5kg', [k(3.1), k(3.4), '#REF!']);
    row('21', [k(96.6), k(98.6), '#REF!']);
    text('Kg basina ucret (toplam gonderi agirligiyla carpiniz)');
    row('71-99', [k(5.2), k(5.1), '#REF!']);
    row('1000 +', [k(5.2), k(5.1), '#REF!']);
    at(p, font, 'Page 2', 290, 30);
  };
  pricePage('FedEx International Priority (IP)', 1);
  pricePage('FedEx International Priority Express (IPE)', 1.2);
  const c = doc.addPage([595, 842]);
  at(c, font, 'ULKE', 100, 700);
  at(c, font, 'BOLGE', 160, 700);
  const list: [string, string][] = [
    ['ALMANYA', 'A'],
    ['ITALYA', 'B'],
    ['KANADA', 'B'],
    ['ATLANTIS', 'B'],
    ['FRANSA', 'D'],
  ];
  let y = 685;
  for (const [name, zone] of list) {
    at(c, font, name, 100, y);
    at(c, font, zone, 172, y, true);
    y -= 12;
  }
  // çok satırlı ad: bölge kodu orta satırda
  at(c, font, 'AMERIKA', 100, y);
  at(c, font, 'BIRLESIK', 100, y - 7);
  at(c, font, 'A', 172, y - 7, true);
  at(c, font, 'DEVLETLERI', 100, y - 14);
  return Buffer.from(await doc.save());
}

const AI_DISCOVERY = {
  document: {
    carrier: 'FedEx',
    validFrom: '2026-06-02',
    currency: 'USD',
    weightUnit: 'kg',
    dimDivisor: 5000,
    fuel: { kind: 'FIXED_PCT', pct: 5 },
    surchargeNotes: [],
    countryZonePages: [4],
    discountPages: [],
    notes: [],
  },
  sections: [
    {
      title: 'IP pak',
      service: 'FedEx International Priority',
      direction: 'export',
      priceType: 'net',
      packaging: 'pak',
      zones: ['A', 'B', 'C'],
      weightMin: 0.5,
      weightMax: 2.5,
      currency: 'USD',
      pages: [2],
      hasAdditionalStep: false,
      hasPerKgBands: false,
    },
    {
      title: 'IP ihracat · Dünya · kutu · net',
      service: 'FedEx International Priority (IP)',
      direction: 'export',
      priceType: 'net',
      packaging: 'box',
      zones: ['A BÖLGESİ', 'B BÖLGESİ', 'ZONE C'],
      weightMin: 0.5,
      weightMax: 1000,
      currency: 'usd',
      pages: [2, 99],
      hasAdditionalStep: true,
      hasPerKgBands: true,
    },
  ],
};

function aiExtraction(over: { a1?: string } = {}) {
  const row = (kind: string, label: string, weight: number | null, cells: string[], extra: Record<string, unknown> = {}) => ({
    kind,
    label,
    weight,
    from: null,
    step: null,
    cells,
    page: 2,
    ...extra,
  });
  return {
    tables: [
      {
        sectionId: 's2',
        zones: ['A', 'B', 'C'],
        rows: [
          row('weight', '0.5', 0.5, ['11.10', '15.30', '#REF!']),
          row('weight', '1', 1, [over.a1 ?? '12.40', '16.80', '#REF!']),
          row('weight', '10.5', 10.5, ['31.50', '27.20', '#REF!']),
          row('additional', 'İlave 0,5kg', null, ['3.10', '3.40', '#REF!'], { step: 0.5 }),
          row('weight', '21', 21, ['96.60', '98.60', '#REF!']),
          row('perKg', '71-99', 99, ['5.20', '5.10', '#REF!'], { from: 71 }),
          row('perKg', '1000 +', null, ['5.20', '5.10', '#REF!'], { from: 1000 }),
        ],
      },
    ],
    countries: [
      { name: 'ALMANYA', zone: 'A', page: 4 },
      { name: 'İTALYA', zone: 'B', page: 4 },
    ],
    notes: [],
  };
}

const review = (verdict: string) =>
  JSON.stringify({
    verdict,
    summary: verdict === 'ok' ? 'Uygun.' : 'Dikkat.',
    issues: [],
    detected: { carrier: 'FedEx', service: null, origin: 'Türkiye', weightUnit: 'kg', currency: 'USD', effectiveDate: null, isListRate: false },
    identity: { description: 'FedEx', suggestedName: 'FedEx IP 2026', suggestedService: null, suggestedValidFrom: null, suggestedValidTo: null },
  });

function tariffPayload(carrierId: string, over: Record<string, unknown> = {}) {
  return {
    carrierId,
    name: 'FedEx IP',
    service: 'FedEx Intl Priority',
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }],
    discountPct: 38,
    fuelPct: 25,
    isDefault: true,
    zones: [
      { country: 'FR', zone: 'A' },
      { country: 'DE', zone: 'A' },
    ],
    rates: [
      { zone: 'A', weightUpto: 1, price: 500 },
      { zone: 'A', weightUpto: 2, price: 600 },
    ],
    overflow: [{ zone: 'A', perUnit: 40 }],
    surcharges: [],
    ...over,
  };
}

const codes = (checks: { code: string; severity: string }[], sev: string) => checks.filter((c) => c.severity === sev).map((c) => c.code);

/** Yurt içi desi listesi (uydurma sayılar): "Desi/Kg | Fiyat (TL)", Dosya satırı, 1…30 desi, "30 desi üzeri her desi". */
async function domesticPdf(): Promise<Buffer<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  let y = 800;
  const line = (cells: [number, string][]) => {
    for (const [x, t] of cells) p.drawText(t, { x, y, size: SIZE, font });
    y -= 12;
  };
  line([[60, 'ORNEK KARGO 2026 YURT ICI STANDART DESI FIYAT LISTESI']]);
  line([[60, 'Fiyatlara KDV dahil degildir.']]);
  line([[60, 'Desi/Kg'], [190, 'Fiyat (TL)']]);
  line([[60, 'Dosya'], [200, '81,40']]);
  ([['1', '96,10'], ['2', '104,30'], ['5', '128,90'], ['10', '170,00'], ['30', '355,20']] as const).forEach(([w, v]) => line([[60, w], [200, v]]));
  line([[60, '30 desi üzeri her desi için'], [200, '11,70']]);
  return Buffer.from(await doc.save());
}

describe('PDF tarife içe aktarma', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let carrierId: string;
  let tariffId: string;
  let pdf: Buffer<ArrayBuffer>;

  const uploadTo = (url: string, name: string, data: Buffer, fields: { name: string; value: string }[] = [], h: Auth = auth) => {
    const form = multipart([...fields, { name: 'file', filename: name, contentType: name.endsWith('.pdf') ? 'application/pdf' : 'text/csv', data }]);
    return app.inject({ method: 'POST', url, headers: { ...h, ...form.headers }, payload: form.payload });
  };
  const post = (url: string, payload: unknown, h: Auth = auth) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });
  const postJob = (url: string, payload: unknown, h: Auth = auth) => viaJob(app, { method: 'POST', url, headers: h, payload: payload as object });

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app, 'PDF Tarife')).auth;
    carrierId = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex' } })).json().carrier.id;
    const t = await post('/api/deciship/tariffs', tariffPayload(carrierId));
    expect(t.statusCode, t.body).toBe(201);
    tariffId = t.json().tariff.id;
    pdf = await syntheticPdf();
    discoveryText = JSON.stringify(AI_DISCOVERY);
    extractionText = JSON.stringify(aiExtraction());
    reviewText = review('ok');
  });
  afterAll(() => {
    process.env.ANTHROPIC_API_KEY = '';
  });

  it('yükleme taramasız ve yapay zekâsız; yapay zekâ taraması anahtarsız 503; bozuk PDF 400', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const up = await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'fedex.pdf', pdf);
    expect(up.statusCode, up.body).toBe(200);
    const d = up.json();
    expect(d).toEqual({ kind: 'pdf', documentId: expect.any(String), fileName: 'fedex.pdf', pages: 4, textLayer: true, aiAvailable: false, target: { kind: 'existing', tariffId } });
    const doc = await inCompany(auth, () => prisma.tariffDocument.findUniqueOrThrow({ where: { id: d.documentId } }));
    expect(doc).toMatchObject({ pages: 4, textLayer: true, tariffId, carrierId, discovery: {} });
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariff-documents/${d.documentId}`, headers: auth })).json().lastScan).toBeNull();
    const ai = await postJob(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'ai' });
    expect(ai.statusCode).toBe(503);
    expect(ai.json().error.code).toBe('AI_DISABLED');
    expect(ai.json().error.message).toContain('yalnızca otomatik taranabilir');
    // metin katmanı yoksa kodla tarama da işe yaramaz: Excel/CSV'ye yönlendir (iki ekran arasında döndürme)
    await inCompany(auth, () => prisma.tariffDocument.update({ where: { id: d.documentId }, data: { textLayer: false } }));
    const scanned = await postJob(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'ai' });
    expect(scanned.statusCode).toBe(503);
    expect(scanned.json().error.message).toContain('Excel (.xlsx) ya da CSV');
    await inCompany(auth, () => prisma.tariffDocument.update({ where: { id: d.documentId }, data: { textLayer: true } }));
    expect((await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'x' })).statusCode).toBe(400);
    const bad = await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'x.pdf', Buffer.from('%PDF-1.4 bozuk'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_FILE');
  });

  it('kod taraması → belirlenimci çıkarma → temiz dosya onaysız uygulanır (net → indirim %0, yakıt belgeden)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // anahtar olsa da yapay zekâ çağrılmamalı
    calls.length = 0;
    const d = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'fedex.pdf', pdf)).json();
    const sc = await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'code' });
    expect(sc.statusCode, sc.body).toBe(200);
    const scan = sc.json();
    expect(scan).toMatchObject({
      mode: 'code',
      document: { carrier: 'FedEx', validFrom: '2026-06-02', currency: 'USD', weightUnit: 'kg', dimDivisor: 5000, fuel: { kind: 'FIXED_PCT', pct: 5 }, countryZonePages: [4] },
      hasCountryZones: true,
      message: null,
    });
    // koli bölümleri önce ve kimlikleri değişmez; zarf / pak ayrı bölümler (ardından); tarifedeki "FedEx Intl Priority" → IP (IPE değil)
    const sections = scan.sections as { id: string; service: string; packaging: string; zones: string[]; pages: number[] }[];
    expect(sections.filter((s) => s.packaging === 'box').map((s) => [s.id, s.service, s.packaging, s.zones.join(''), s.pages])).toEqual([
      ['c1', 'FedEx International Priority (IP)', 'box', 'ABC', [2]],
      ['c2', 'FedEx International Priority Express (IPE)', 'box', 'ABC', [3]],
    ]);
    expect(sections.slice(0, 2).map((s) => s.id)).toEqual(['c1', 'c2']);
    expect(sections.filter((s) => s.packaging === 'pak').map((s) => s.pages)).toEqual([[2], [3]]);
    expect(sections.filter((s) => s.packaging === 'envelope').map((s) => s.pages)).toEqual([[2], [3]]);
    expect(scan.sections[0]).not.toHaveProperty('table');
    // IP koli bölümü önce; ardından yalnız aynı hizmetin zarf / pak bölümleri (IPE önerilmez)
    expect(scan.suggestedSectionIds[0]).toBe('c1');
    expect(scan.suggestedSectionIds).not.toContain('c2');
    for (const id of scan.suggestedSectionIds.slice(1)) expect(sections.find((s) => s.id === id)?.service).toBe('FedEx International Priority (IP)');
    expect(scan.suggestionSource).toBe('tariff'); // taşıyıcının faturası yok → tarifenin hizmeti
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariff-documents/${d.documentId}`, headers: auth })).json().lastScan.mode).toBe('code');

    const ex = await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId } });
    expect(ex.statusCode, ex.body).toBe(200);
    const p = ex.json();
    expect(p).toMatchObject({ kind: 'pdf', target: { kind: 'existing', tariffId }, source: { documentId: d.documentId, pages: [2, 4] } });
    expect(p.verification).toEqual({ method: 'code', checked: 14, matched: 14, unmatched: [] });
    // indirim/yakıt/bölen otomatik uygulanır → öneri olarak tekrar gönderilmez; geçerlilik öneri
    // hizmet adı da öneri ("Kullan" ile alınır; mevcut ad olduğu gibi kalır)
    expect(p.suggestedMeta).toEqual({ validFrom: '2026-06-02', currency: 'USD', service: 'FedEx International Priority (IP)' });
    expect(p.summary).toMatchObject({ weightCount: 24, perKgBandCount: 2, generatedCount: 40, zoneCount: 2, countryCount: 4, maxWeight: 21, detectedCurrency: 'USD' });
    expect(codes(p.checks, 'error')).toEqual(['CURRENCY_MISMATCH']);
    expect(p.checks.find((c: { code: string }) => c.code === 'CURRENCY_MISMATCH').title).toBe('Belgedeki fiyatlar USD, tarife TRY');
    expect(p.headline).toMatchObject({ status: 'error', title: 'Bu haliyle yüklenemez' });
    expect(p.zones).toEqual(
      expect.arrayContaining([
        { country: 'DE', zone: 'A' },
        { country: 'IT', zone: 'B' },
        { country: 'US', zone: 'A' },
        { country: 'CA', zone: 'B' },
      ]),
    );
    expect(p.rates.find((r: { zone: string; weightUpto: number }) => r.zone === 'A' && r.weightUpto === 11)).toEqual({ zone: 'A', weightUpto: 11, price: 34.6, perKg: false });
    expect(p.rates.find((r: { zone: string; weightUpto: number }) => r.zone === 'B' && r.weightUpto === 99999)).toEqual({ zone: 'B', weightUpto: 99999, price: 5.1, perKg: true });
    // kg başı açık bant tüm ağırlıkları kapsıyor → eski aşım kaldırılır
    expect(p.overflow).toEqual([]);

    const options = { currency: 'USD' };
    const re = (await post(`/api/deciship/tariff-imports/${p.draftId}/recheck`, { options })).json();
    expect(re.canApply).toBe(true);
    expect(codes(re.checks, 'warning')).toEqual([]);
    // sütunu bozuk C bölgesine ülke atanmamış, tanınmayan ad, seçilmeyen bölge → yalnız bilgi notu
    const notes = re.checks.find((c: { code: string }) => c.code === 'PDF_NOTES').detail;
    for (const t of ["C sütunu PDF'te bozuk", 'ATLANTIS', 'D: FR']) expect(notes).toContain(t);
    expect(re.headline.status).toBe('ok');
    expect(re.headline.title).toBe('Dosya uygun');
    expect(re.headline.lines[0]).toBe('2 bölge, 0,5–21,0 kg, 21,0 kg üstü kg başı fiyat · 4 ülke eşlemesi · USD');
    expect(re.headline.lines[1]).toBe('Net fiyat: indirim %0 · yakıt %5 belgeden alındı');
    expect(codes(re.checks, 'info')).toContain('PDF_SETTINGS');
    expect(re.checks.find((c: { code: string }) => c.code === 'SUMMARY').detail).toContain(
      "Ağırlık yuvarlama tablodan alındı: 21 kg'a kadar 0,5 kg, üstü 1 kg",
    );

    const ok = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(calls).toHaveLength(0);
    const applied = ok.json();
    expect(applied.versionId).toEqual(expect.any(String));
    expect(applied.tariff).toMatchObject({ currency: 'USD', fuelPct: 5, discountPct: 0, divisor: 5000, name: 'FedEx IP', overflow: [] });
    expect(applied.tariff.zones).toHaveLength(4);
    expect(applied.tariff.weightSteps).toEqual([{ upto: 21, step: 0.5 }, { upto: null, step: 1 }]);

    const quote = (weightKg: number, destCountry: string) =>
      post(`/api/deciship/tariffs/${tariffId}/quote`, { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg, destCountry }).then((r) => r.json());
    expect(await quote(75, 'US')).toMatchObject({ ok: true, base: 390, chargeableKg: 75 });
    expect(await quote(11, 'IT')).toMatchObject({ ok: true, base: 30.6 });

    // şablon kg başı bantları geri okunabilir biçimde yazar
    const tpl = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/template.xlsx?tariffId=${tariffId}`, headers: auth });
    expect(tpl.statusCode).toBe(200);
    const back = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'geri.xlsx', tpl.rawPayload)).json();
    expect(back.kind).toBe('table');
    expect(back.summary.perKgBandCount).toBe(2);
    expect(back.comparison.every((c: { ratio: number }) => c.ratio === 1)).toBe(true);
    expect(back.headline.status).toBe('ok');

    const restore = await post(`/api/deciship/tariffs/${tariffId}/versions/${applied.versionId}/restore`, {});
    expect(restore.json().tariff).toMatchObject({ currency: 'TRY', discountPct: 38, overflow: [{ zone: 'A', perUnit: 40 }] });
  });

  it('bozuk sütundaki bölgeye ülke atanmışsa uyarı → onay gerekir; geçersiz bölüm 400; başka şirket 404', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const t = await post('/api/deciship/tariffs', tariffPayload(carrierId, { name: 'C bölgeli', isDefault: false, currency: 'USD', zones: [{ country: 'GB', zone: 'C' }, { country: 'DE', zone: 'A' }] }));
    const id = t.json().tariff.id;
    const d = (await uploadTo(`/api/deciship/tariffs/${id}/import`, 'fedex.pdf', pdf)).json();
    await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'code' });
    const p = (await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: false, target: { tariffId: id } })).json();
    expect(codes(p.checks, 'warning')).toContain('PDF_COLUMN_DROPPED');
    expect(codes(p.checks, 'error')).toContain('ZONE_MAPPING_MISSING');
    expect(p.summary.countryCount).toBe(2);
    expect((await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c9'], includeCountryZones: false, target: { tariffId: id } })).statusCode).toBe(400);
    expect((await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['s1'], includeCountryZones: false, target: { tariffId: id } })).statusCode).toBe(400);
    const other = (await registerCompany(app, 'Başka PDF')).auth;
    expect((await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: false, target: { tariffId: id } }, other)).statusCode).toBe(404);
    expect((await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'code' }, other)).statusCode).toBe(404);

    // uyarı + hata yok hâli: ülke listesiyle (GB listede yok → mevcut eşleme değişir) ve onaysız 409
    const p2 = (await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId: id } })).json();
    expect(codes(p2.checks, 'error')).toEqual([]);
    const csv = Buffer.from('Ağırlık,A\n1,10\n2,12\n', 'utf8');
    const w = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'kisa.csv', csv)).json();
    expect(w.headline).toMatchObject({ status: 'warning', title: expect.stringMatching(/uyarıya bakın$/) });
    const noAck = await post(`/api/deciship/tariff-imports/${w.draftId}/apply`, { options: {} });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().error.code).toBe('ACK_REQUIRED');
  });

  it('yapay zekâ yalnız istenince: tarama (pak ayrı bölüm) → çıkarma + metin doğrulaması; inceleme "caution" ise onay gerekir', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    calls.length = 0;
    const d = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'fedex.pdf', pdf)).json();
    expect(calls).toHaveLength(0);
    const sc = (await postJob(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'ai' })).json();
    expect(calls).toHaveLength(1);
    expect(sc.mode).toBe('ai');
    // poşet / zarf bölümü artık atılmaz: kendi bölümü olur (içe aktarmada tarifenin Pak satırları)
    expect(sc.sections.map((s: { id: string; packaging: string }) => [s.id, s.packaging])).toEqual([
      ['s1', 'pak'],
      ['s2', 'box'],
    ]);
    expect(sc.sections[1]).toMatchObject({ zones: ['A', 'B', 'C'], pages: [2], currency: 'USD' });
    // koli bölümü önce önerilir; Pak bölümü yalnız başına önerilmez
    expect(sc.suggestedSectionIds[0]).toBe('s2');
    expect(sc.hasCountryZones).toBe(true);
    const disc = calls[0]!.params as { messages: { content: { type: string }[] }[] };
    expect(disc.messages[0]!.content[0]!.type).toBe('document');

    // yanlış okunan fiyat → doğrulama hatası
    extractionText = JSON.stringify(aiExtraction({ a1: '12.04' }));
    const bad = (await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['s2'], includeCountryZones: false, target: { tariffId } })).json();
    expect(bad.verification).toMatchObject({ method: 'ai', checked: 14, matched: 13, unmatched: [{ zone: 'A', weight: 1, price: 12.04, page: 2 }] });
    expect(codes(bad.checks, 'error')).toContain('PDF_VALUES_UNVERIFIED');
    extractionText = JSON.stringify(aiExtraction());

    // arka plan işi, yeni tarife hedefi (ad henüz yok); ülkeler yapay zekâdan (kod taraması yapılmadı)
    calls.length = 0;
    const started = await postJob(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['s2'], includeCountryZones: true, target: { newTariff: { name: null, service: null } } });
    expect(started.start.statusCode, started.start.body).toBe(202);
    const job = started.job!;
    expect(job.status).toBe('SUCCEEDED');
    const exCall = calls[0]!.params as { messages: { content: { type: string; text?: string }[] }[] };
    expect(exCall.messages[0]!.content[2]!.text).toContain('"originalPage":4');
    const p = job.result as { draftId: string; target: unknown; suggestedDefaults: Record<string, unknown>; checks: { code: string; severity: string }[]; comparison: unknown; verification: { method: string } };
    expect(p.target).toEqual({ kind: 'new', carrierId });
    expect(p.verification.method).toBe('ai');
    expect(p.suggestedDefaults).toMatchObject({ currency: 'USD', divisor: 5000, discountPct: 0, fuelPct: 5 });
    expect(p.comparison).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariff-documents/${d.documentId}/jobs/nope`, headers: auth })).statusCode).toBe(404);

    // istek üzerine inceleme: "caution" → uyarı olmasa da onay gerekir; "ok" → onaysız
    reviewText = review('caution');
    expect((await postJob(`/api/deciship/tariff-imports/${p.draftId}/review`, { options: {} })).statusCode).toBe(200);
    const meta = { name: 'FedEx IP 2026', service: 'FedEx Intl Priority' };
    const need = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, meta });
    expect(need.statusCode, need.body).toBe(409);
    expect(need.json().error.details).toMatchObject({ warnings: [], aiVerdict: 'caution', aiReviewed: true });
    reviewText = review('ok');
    await postJob(`/api/deciship/tariff-imports/${p.draftId}/review`, { options: {} });
    expect((await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {} })).statusCode).toBe(400); // yeni tarifede ad zorunlu
    const created = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, meta });
    expect(created.statusCode, created.body).toBe(200);
    const c = created.json();
    expect(c.versionId).toBeNull();
    expect(c.tariff).toMatchObject({ name: 'FedEx IP 2026', currency: 'USD', divisor: 5000, discountPct: 0, fuelPct: 5, isDefault: false, carrierId });
    // ağırlık yuvarlama tablodan: 0,5 kg satırlar 21 kg'a kadar, üstü kg başı → 1 kg
    expect(c.tariff.weightSteps).toEqual([{ upto: 21, step: 0.5 }, { upto: null, step: 1 }]);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${tariffId}`, headers: auth })).json().tariff.currency).toBe('TRY');
  });

  it('eski eşzamanlı yol kapalı: async olmadan yapay zekâ taraması ve tablo okuma 400 ASYNC_REQUIRED', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    calls.length = 0;
    const d = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'fedex.pdf', pdf)).json();
    const sc = await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'code' });
    expect(sc.statusCode, sc.body).toBe(200);
    const countJobs = () => inCompany(auth, () => prisma.job.count({ where: { kind: 'TARIFF_PDF_EXTRACT' } }));
    const countDrafts = () => inCompany(auth, () => prisma.tariffImportDraft.count());
    const jobsBefore = await countJobs();
    const draftsBefore = await countDrafts();
    expectAsyncRequired(await post(`/api/deciship/tariff-documents/${d.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId } }));
    expectAsyncRequired(await post(`/api/deciship/tariff-documents/${d.documentId}/scan`, { mode: 'ai' }));
    expect(await countJobs()).toBe(jobsBefore);
    expect(await countDrafts()).toBe(draftsBefore);
    expect(calls).toHaveLength(0);
  });

  it('"Yeni tarife" ekranından: POST /tariff-imports (tablo ve PDF), ad zorunlu, başka şirketin taşıyıcısı 404', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const { auth: a2 } = await registerCompany(app, 'Yeni Tarife Şirketi');
    const aras = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: a2, payload: { code: 'aras' } })).json().carrier.id;
    const csv = Buffer.from('Desi,TR\n1,90\n2,102,5\n3,115\n', 'utf8');
    const send = (fields: { name: string; value: string }[], name = 'aras.csv', data: Buffer = csv) => uploadTo('/api/deciship/tariff-imports', name, data, fields, a2);
    expect((await send([])).statusCode).toBe(400);
    expect((await send([{ name: 'carrierId', value: carrierId }])).statusCode).toBe(404);
    const r = await send([{ name: 'carrierId', value: aras }]);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ kind: 'table', target: { kind: 'new', carrierId: aras }, suggestedDefaults: { currency: 'TRY', divisor: 3000 }, comparison: null });
    // KALANLAR 1.2: tek bölgeli tabloda bölge eşlemesi yoksa * kendiliğinden (eskiden NO_COUNTRY_MAPPING uyarısı)
    expect(codes(p.checks, 'warning')).not.toContain('NO_COUNTRY_MAPPING');
    expect(codes(p.checks, 'info')).toContain('ZONE_STAR_AUTO');
    expect((await inCompany(a2, () => prisma.tariffImportDraft.findUniqueOrThrow({ where: { id: p.draftId } }))).tariffId).toBeNull();
    const noName = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: true, meta: {} }, a2);
    expect(noName.json().error.code).toBe('VALIDATION');
    // kod uyarısı var → onaysız uygulanmaz
    const noAck = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, meta: { name: 'Aras 2026' } }, a2);
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().error.details).toMatchObject({ warnings: expect.arrayContaining(['NO_DISCOUNT']), aiReviewed: false, aiAvailable: false });
    const ok = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: true, meta: { name: 'Aras 2026', validFrom: '2026-01-01', fuelPct: 12 } }, a2);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().tariff).toMatchObject({ name: 'Aras 2026', currency: 'TRY', divisor: 3000, isDefault: true, fuelPct: 12, validFrom: '2026-01-01', carrierId: aras });
    expect((await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${ok.json().tariff.id}`, headers: a2 })).json().tariff.zones).toMatchObject([{ country: '*', zone: 'TR' }]);
    const other = (await registerCompany(app, 'Üçüncü')).auth;
    expect((await post(`/api/deciship/tariff-imports/${p.draftId}/recheck`, {}, other)).statusCode).toBe(404);

    // PDF → yeni tarife; yapay zekâ kapalıyken kodla; temiz → onaysız
    const fx = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: a2, payload: { code: 'fedex' } })).json().carrier.id;
    const up = await send([{ name: 'carrierId', value: fx }], 'fedex.pdf', pdf);
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json()).toMatchObject({ kind: 'pdf', target: { kind: 'new', carrierId: fx }, suggestedDefaults: { currency: 'USD', divisor: 5000 } });
    const docId = up.json().documentId;
    const sc = (await post(`/api/deciship/tariff-documents/${docId}/scan`, { mode: 'code' }, a2)).json();
    // bağlam yok → ilk hizmet; ardından yalnız aynı hizmetin zarf / pak bölümleri
    expect(sc.suggestedSectionIds).toEqual(['c1', 'c3', 'c4']);
    expect(sc.sections.filter((s: { id: string }) => ['c3', 'c4'].includes(s.id)).map((s: { packaging: string; service: string }) => [s.packaging, s.service]).sort()).toEqual([
      ['envelope', sc.sections[0].service],
      ['pak', sc.sections[0].service],
    ]);
    const wrongTarget = await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId: ok.json().tariff.id } }, a2);
    expect(wrongTarget.statusCode).toBe(400);
    const ex = await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { newTariff: { name: null, service: null } } }, a2);
    expect(ex.statusCode, ex.body).toBe(200);
    expect(ex.json().headline.status).toBe('ok');
    const made = await post(`/api/deciship/tariff-imports/${ex.json().draftId}/apply`, { options: {}, meta: { name: 'FedEx IP 2026', validFrom: '2026-06-02' } }, a2);
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().tariff).toMatchObject({ currency: 'USD', isDefault: true, fuelPct: 5, divisor: 5000, discountPct: 0, validFrom: '2026-06-02' });
    expect(made.json().tariff.zones).toHaveLength(4);
  });

  it('taranmış (metinsiz) PDF: kod taraması mesaj döner', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const up = (await uploadTo(`/api/deciship/tariffs/${tariffId}/import`, 'tarama.pdf', Buffer.from(await doc.save()))).json();
    expect(up.textLayer).toBe(false);
    const sc = (await post(`/api/deciship/tariff-documents/${up.documentId}/scan`, { mode: 'code' })).json();
    expect(sc).toMatchObject({ sections: [], suggestedSectionIds: [], hasCountryZones: false, message: 'PDF taranmış görüntü; yalnızca yapay zekâ ile okunabilir.' });
  });

  it('QA: aşım korunur (uyarı); para birimi değişince sabit ek ücret uyarısı; farklı seçenekle yapılmış inceleme sayılmaz', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const t = await post(
      '/api/deciship/tariffs',
      tariffPayload(carrierId, { name: 'Aşımlı', isDefault: false, overflow: [{ zone: 'A', perUnit: 30 }], surcharges: [{ code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'FIXED', amount: 250 }] }),
    );
    const id = t.json().tariff.id;
    const csv = Buffer.from('Ağırlık,A\n1,510\n2,610\n', 'utf8');
    const p = (await uploadTo(`/api/deciship/tariffs/${id}/import`, 'yeni.csv', csv)).json();
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 30 }]);
    expect(codes(p.checks, 'warning')).toContain('OVERFLOW_KEPT');
    const usd = (await post(`/api/deciship/tariff-imports/${p.draftId}/recheck`, { options: { currency: 'USD' } })).json();
    expect(codes(usd.checks, 'warning')).toContain('SURCHARGES_OTHER_CURRENCY');

    reviewText = review('ok');
    await postJob(`/api/deciship/tariff-imports/${p.draftId}/review`, { options: {} });
    const stale = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: { currency: 'USD' }, acknowledged: false });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toMatchObject({ aiReviewed: false, aiStale: true });
    const ok = await post(`/api/deciship/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().tariff.overflow).toEqual([{ zone: 'A', perUnit: 30 }]);
  });

  it('yurt içi tek sütunlu desi listesi kodla okunur: tek bölge (*), Dosya zarf bölümü, bölen 3000, son satır üstü aşım', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const { auth: a3 } = await registerCompany(app, 'Yurt İçi PDF');
    const aras = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: a3, payload: { code: 'aras' } })).json().carrier.id;
    const file = await domesticPdf();
    const up = await uploadTo('/api/deciship/tariff-imports', 'aras.pdf', file, [{ name: 'carrierId', value: aras }], a3);
    expect(up.statusCode, up.body).toBe(200);
    const docId = up.json().documentId;
    const sc = (await post(`/api/deciship/tariff-documents/${docId}/scan`, { mode: 'code' }, a3)).json();
    expect(sc.message).toBeNull();
    expect(sc.document).toMatchObject({ dimDivisor: 3000, currency: 'TRY', weightUnit: 'kg' });
    // "Dosya" satırı artık atılmaz: koli bölümünden sonra zarf bölümü
    expect(sc.sections.map((s: { id: string; packaging: string }) => [s.id, s.packaging])).toEqual([
      ['c1', expect.anything()],
      ['c2', 'envelope'],
    ]);
    expect(sc.sections[0]).toMatchObject({ id: 'c1', zones: ['TR'], direction: 'domestic', weightMin: 1, weightMax: 30, hasAdditionalStep: true });
    expect(sc.suggestedSectionIds[0]).toBe('c1');

    const ex = await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { newTariff: { name: null, service: null } } }, a3);
    expect(ex.statusCode, ex.body).toBe(200);
    const d = ex.json();
    expect(d.zones).toEqual([{ country: '*', zone: 'TR' }]);
    expect(d.overflow).toEqual([{ zone: 'TR', perUnit: 11.7 }]);
    expect(d.verification).toMatchObject({ method: 'code', unmatched: [] });
    expect(codes(d.checks, 'error')).toEqual([]);
    expect(codes(d.checks, 'warning')).toEqual([]);
    // yalnız koli bölümü seçildi: zarf fiyatı taslağa girmez
    expect(d.packagingRates).toEqual([]);
    expect(d.headline.status).toBe('ok');


    const made = await post(`/api/deciship/tariff-imports/${d.draftId}/apply`, { options: {}, meta: { name: 'Aras Desi 2026' } }, a3);
    expect(made.statusCode, made.body).toBe(200);
    const t = made.json().tariff;
    expect(t).toMatchObject({ currency: 'TRY', divisor: 3000, overflow: [{ zone: 'TR', perUnit: 11.7 }], zones: [{ country: '*', zone: 'TR' }] });
    expect(t.weightSteps.at(-1)).toEqual({ upto: null, step: 1 });
    const quote = (weightKg: number) =>
      post(`/api/deciship/tariffs/${t.id}/quote`, { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg, destCountry: 'TR' }, a3).then((r) => r.json());
    // 35 desi = 30 desi fiyatı + 5 × 11,70 (önceden "Tarife yok")
    expect(await quote(35)).toMatchObject({ ok: true, base: 413.7 });
    expect(await quote(4)).toMatchObject({ ok: true, base: 128.9 });

    // zarf bölümü de seçilince "Dosya" fiyatı taslağın zarf satırı olur (PDF taslağında ambalaj etiketiyle yazılır)
    const both = (await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1', 'c2'], includeCountryZones: true, target: { newTariff: { name: null, service: null } } }, a3)).json();
    expect(both.packagingRates).toEqual([expect.objectContaining({ zone: 'TR', price: 81.4, perKg: false, packaging: 'ENVELOPE' })]);
    expect(both.rates.every((r: { packaging?: string }) => r.packaging == null || r.packaging === 'OWN')).toBe(true);

    // mevcut tarifenin "*" bölgesi başka adla ("Yurt içi"): fiyatlar o adla yazılır, eşleme korunur
    const named = await post('/api/deciship/tariffs', tariffPayload(aras, { name: 'Eski desi', service: null, divisor: 3000, isDefault: false, zones: [{ country: '*', zone: 'Yurt içi' }], rates: [{ zone: 'Yurt içi', weightUpto: 1, price: 90 }], overflow: [] }), a3);
    expect(named.statusCode, named.body).toBe(201);
    const tid = named.json().tariff.id;
    const up2 = (await uploadTo(`/api/deciship/tariffs/${tid}/import`, 'aras.pdf', file, [], a3)).json();
    await post(`/api/deciship/tariff-documents/${up2.documentId}/scan`, { mode: 'code' }, a3);
    const ex2 = (await postJob(`/api/deciship/tariff-documents/${up2.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId: tid } }, a3)).json();
    expect([...new Set(ex2.rates.map((r: { zone: string }) => r.zone))]).toEqual(['Yurt içi']);
    expect(ex2.zones).toEqual([]); // dosyada eşleme yok → mevcut (* → Yurt içi) korunur
    expect(codes(ex2.checks, 'error')).toEqual([]);
    expect(codes(ex2.checks, 'warning')).not.toContain('NO_COUNTRY_MAPPING');
  });
});
