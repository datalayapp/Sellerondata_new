import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { FxService, setFxService } from '../src/services/fx.ts';
import { getApp, multipart, registerCompany, inCompany } from './helpers.ts';

/** SPEC §11: yapay zekâ ile eşleme (Claude sahte), okuma kontrolü kapısı, satır bayrakları. */

const calls: Record<string, unknown>[] = [];
let nextText = '';

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
            finalMessage: async () => ({
              model: 'claude-sonnet-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1234, output_tokens: 567 },
              content: [{ type: 'text', text: nextText }],
            }),
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

type Auth = { authorization: string };

// Sahte veri: Almanca başlıklar, AB sayı biçimi, kalıbı olmayan "generic" taşıyıcı.
const DE_CSV = [
  'Rechnungsnummer;Sendungsnummer;Versanddatum;Empfängerland;Gewicht (kg);Abrechnungsgewicht (kg);Länge;Breite;Höhe;Fracht;Treibstoffzuschlag;Nettobetrag;Rechnungsbetrag',
  'RE-7781;JD014600003311;14.10.2026;Frankreich;4,2;6;40;30;25;20,00;3,50;23,50;99,40',
  'RE-7781;JD014600003322;15.10.2026;Niederlande;1,1;2;20;20;10;12,00;2,10;14,10;99,40',
  'RE-7781;JD014600003333;15.10.2026;Österreich;2,8;3;30;20;15;15,00;2,60;17,60;99,40',
  'RE-7781;JD014600003344;16.10.2026;Belgien;7,9;9;50;40;20;30,00;5,20;35,20;99,40',
  'RE-7781;JD014600003355;16.10.2026;Italien;0,4;1;20;15;5;8,00;1,00;9,00;99,40',
].join('\n');

const pick = (header: string | null, confidence = 0.9, reason = 'test') => ({ header, confidence, reason });
function aiAnswer(over: Record<string, unknown> = {}) {
  const fields: Record<string, ReturnType<typeof pick>> = {
    trackingNo: pick('Sendungsnummer', 0.97),
    netAmount: pick('Nettobetrag', 0.93),
    shipDate: pick('Versanddatum', 0.9),
    service: pick(null, 0.8),
    destCountry: pick('Empfängerland', 0.9),
    actualKg: pick('Gewicht (kg)', 0.9),
    billedKg: pick('Abrechnungsgewicht (kg)', 0.9),
    dimL: pick('Länge', 0.85),
    dimW: pick('Breite', 0.85),
    dimH: pick('Höhe', 0.85),
    dims: pick(null, 0.8),
    billedDivisor: pick(null, 0.8),
    baseAmount: pick('Fracht', 0.85),
    discountAmount: pick(null, 0.8),
    fuelAmount: pick('Treibstoffzuschlag', 0.88),
    currency: pick('Währung', 0.6), // dosyada yok → atılmalı
    reference: pick('Kundenreferenz', 0.5), // dosyada yok → atılmalı
    dimUnit: pick(null, 0.8),
    actualKgUnit: pick(null, 0.8),
    billedKgUnit: pick(null, 0.8),
    invoiceNo: pick('Rechnungsnummer', 0.95),
    invoiceDate: pick(null, 0.7),
    invoiceTotal: pick('Rechnungsbetrag', 0.9),
  };
  return {
    fields,
    chargePairs: [],
    chargeLabels: [],
    surchargeColumns: [{ header: 'Inselzuschlag', code: 'ISLAND' }], // dosyada yok → atılmalı
    defaultDimUnit: 'cm',
    defaultWeightUnit: 'kg',
    numberFormat: 'tr',
    dateOrder: 'dmy',
    amountsIncludeVat: false,
    desiAsWeight: false,
    ...over,
  };
}

async function preview(app: FastifyInstance, auth: Auth, carrierId: string, csv: string, name = 'de-rechnung.csv') {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: name, contentType: 'text/csv', data: Buffer.from(csv, 'utf8') },
  ]);
  const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe('Yapay zekâ ile eşleme ve okuma kontrolü', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let carrierId: string;

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app, 'AI Map Test')).auth;
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'generic', name: 'Paketdienst' } });
    expect(c.statusCode, c.body).toBe(201);
    carrierId = c.json().carrier.id;
  });
  afterAll(() => {
    process.env.ANTHROPIC_API_KEY = '';
    setFxService(null);
  });
  // Mesaj 6: aynı tablo aynı firmada önceki eşlemeyi ücretsiz alır. Testler aynı dosyayı farklı sahte yanıtla yeniden eşler.
  beforeEach(() => inCompany(auth, () => prisma.aiResultCache.deleteMany({})));

  it('kalıbı olmayan taşıyıcıda önizleme yapay zekâ önerir; anahtar yoksa 503 AI_DISABLED', async () => {
    const p = await preview(app, auth, carrierId, DE_CSV);
    expect(p.suggestAi).toBe(true);
    expect(p.diagnostics.verification).toBeDefined();
    expect(p.fieldSources).toBeTypeOf('object');
    process.env.ANTHROPIC_API_KEY = '';
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/ai-mapping', headers: auth, payload: { fileId: p.fileId, carrierId } });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error.code).toBe('AI_DISABLED');
  });

  it('yapay zekâ eşlemesi: uydurma başlıklar atılır, eşleme doğrulanır, kaynak "ai" yazılır', async () => {
    const p = await preview(app, auth, carrierId, DE_CSV);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    nextText = JSON.stringify(aiAnswer());
    calls.length = 0;
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/ai-mapping', headers: auth, payload: { fileId: p.fileId, carrierId } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.mapping.trackingNo).toBe('Sendungsnummer');
    expect(body.mapping.netAmount).toBe('Nettobetrag');
    expect(body.mapping.currency).toBeUndefined();
    expect(body.mapping.reference).toBeUndefined();
    expect(body.mapping.surchargeColumns).toEqual([]);
    expect(body.dropped).toEqual(
      expect.arrayContaining([
        { field: 'currency', header: 'Währung' },
        { field: 'reference', header: 'Kundenreferenz' },
        { field: 'surchargeColumns', header: 'Inselzuschlag' },
      ]),
    );
    expect(body.aiConfidence.currency).toMatchObject({ header: null, confidence: 0, dropped: 'Währung' });
    expect(body.fieldSources.netAmount).toBe('ai');
    expect(body.diagnostics.verification.verdict, body.diagnostics.verification.issues.join(' | ')).toBe('ok');
    expect(body.diagnostics.verification.fields.netAmount.status).toBe('ok');
    expect(body.diagnostics.verification.checks.invoiceTotal).toMatchObject({ value: 99.4, difference: 0 });
    expect(body.guessedMeta.invoiceNo).toBe('RE-7781');
    expect(body.usage).toEqual({ model: 'claude-sonnet-5-5', inputTokens: 1234, outputTokens: 567 });

    // İstem: dile bağımsız, yapılandırılmış çıktı, en fazla 12 örnek satır.
    const params = calls[0]!;
    expect((params.output_config as { format: { type: string }; effort: string }).format.type).toBe('json_schema');
    expect(['low', 'medium']).toContain((params.output_config as { effort: string }).effort);
    expect(String(params.system)).toContain('any language');
    expect(String(params.system)).toContain('Invoice-level values repeat');
    const text = ((params.messages as { content: { text: string }[] }[])[0]!.content[0]!).text;
    expect(text).toContain('"Sendungsnummer"');
    expect(text).toContain('distinct 1');
  });

  // Kullanıcı kararı 2026-11-12 (denetim 18-B1, 05-B8): kişisel veri biçimi korunarak maskelenir; eşleme sonucu aynı kalır.
  it('sağlayıcıya giden istemde alıcının adı, adresi, telefonu ve e-postası yok; tutar, ağırlık, tarih, para birimi aynen', async () => {
    const rows = [
      ['794612345678', 'Ayse Kurgu', 'Kurgu Sk. No 12 Daire 3', '+90 555 000 11 22', 'ayse@kurgu.example', '34710', '03.11.2026', 'TRY', '1,5', '1.234,56'],
      ['794612345679', 'Mehmet Ornek', 'Ornek Cad. 45/7 Kadikoy', '+90 555 000 33 44', 'mehmet@ornek.example', '34720', '04.11.2026', 'TRY', '2,25', '98,10'],
      ['794612345680', 'Zeynep Deneme', 'Deneme Mah. 8. Sokak No 2', '+90 555 000 55 66', 'zeynep@deneme.example', '34730', '05.11.2026', 'TRY', '0,4', '75,00'],
    ];
    const csv = ['Tracking Number;Recipient Name;Recipient Address;Recipient Phone;E-mail;Posta Kodu;Ship Date;Currency;Weight (kg);Net Charge', ...rows.map((r) => r.join(';'))].join('\n');
    const p = await preview(app, auth, carrierId, csv, 'kisisel.csv');
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const a = aiAnswer();
    const fields = Object.fromEntries(Object.keys(a.fields).map((f) => [f, pick(null, 0.8)]));
    Object.assign(fields, {
      trackingNo: pick('Tracking Number', 0.95),
      netAmount: pick('Net Charge', 0.9),
      shipDate: pick('Ship Date', 0.9),
      currency: pick('Currency', 0.9),
      actualKg: pick('Weight (kg)', 0.9),
    });
    nextText = JSON.stringify({ ...a, fields, surchargeColumns: [] });
    calls.length = 0;
    const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/ai-mapping', headers: auth, payload: { fileId: p.fileId, carrierId } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mapping).toMatchObject({ trackingNo: 'Tracking Number', netAmount: 'Net Charge', shipDate: 'Ship Date', currency: 'Currency', actualKg: 'Weight (kg)' });
    expect(r.json().dropped).toEqual([]);

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    const text = ((params.messages as { content: { text: string }[] }[])[0]!.content[0]!).text;
    for (const row of rows) for (const v of row.slice(0, 6)) expect(text).not.toContain(v);
    for (const leak of ['Ayse', 'Kurgu', 'Mehmet', 'Ornek', 'Zeynep', 'Deneme', 'Kadikoy', 'Sokak', '555', '7946', '3471', 'example']) expect(text).not.toContain(leak);
    // başlıklar aynen, kişisel değerler biçimiyle
    for (const h of ['Tracking Number', 'Recipient Name', 'Recipient Address', 'Recipient Phone', 'E-mail', 'Posta Kodu']) expect(text).toContain(JSON.stringify(h));
    expect(text).toContain('Aaaa Aaaaa | Aaaaaa Aaaaa | Aaaaaa Aaaaaa');
    expect(text).toContain('+99 999 999 99 99 | +99 999 999 99 99 | +99 999 999 99 99');
    expect(text).toContain('99999 | 99999 | 99999');
    // sayısal, tarih ve para birimi değerleri aynen
    expect(text).toContain('03.11.2026 | 04.11.2026 | 05.11.2026');
    expect(text).toContain('1,5 | 2,25 | 0,4');
    expect(text).toContain('1.234,56 | 98,10 | 75,00');
    expect(text).toMatch(/"Currency" — filled 3\/3, distinct 1: TRY\n/);
    // istem modele maskeyi anlatır
    expect(String(params.system)).toContain('masked by shape');
  });

  it('kullanıcının doğrulanmış seçimi, daha az emin yapay zekâ önerisine karşı korunur', async () => {
    const p = await preview(app, auth, carrierId, DE_CSV);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const a = aiAnswer();
    (a.fields as Record<string, unknown>).netAmount = pick('Fracht', 0.3);
    (a.fields as Record<string, unknown>).baseAmount = pick(null, 0.5);
    nextText = JSON.stringify(a);
    const mine = { ...p.suggestedMapping, trackingNo: 'Sendungsnummer', netAmount: 'Nettobetrag' };
    const r = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices/preview/ai-mapping',
      headers: auth,
      payload: { fileId: p.fileId, carrierId, mapping: mine, sources: { netAmount: 'user', trackingNo: 'user' } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mapping.netAmount).toBe('Nettobetrag');
    expect(r.json().fieldSources.netAmount).toBe('user');
    expect(r.json().decisions.netAmount).toBe('kept');
  });

  // KARARLAR "Tutar toleransı" (2026-11-10): tolerans firma para biriminde (TRY) olduğu için EUR fatura artık TRY→EUR kuru ister;
  // test ağa (TCMB) gitmesin diye kur servisi sahtedir (kur yok → sabit karşılık kullanılır).
  it('okuma kontrolü sorunluysa içe aktarma 409 MAPPING_UNVERIFIED; onayla içe aktarılır ve bayraklar satırda kalır', async () => {
    setFxService(new FxService({ fetcher: async () => ({ status: 404, text: '' }), cacheDir: null }));
    // 2. satırda ağırlık 1500 kg, 3. satırda tarih okunamıyor.
    const bad = DE_CSV.replace(';1,1;2;', ';1500;2;').replace('15.10.2026;Österreich', '45.13.2026;Österreich');
    const p = await preview(app, auth, carrierId, bad, 'de-bad.csv');
    const mapping = {
      ...p.suggestedMapping,
      trackingNo: 'Sendungsnummer',
      netAmount: 'Nettobetrag',
      shipDate: 'Versanddatum',
      actualKg: 'Gewicht (kg)',
      baseAmount: 'Fracht',
      fuelAmount: 'Treibstoffzuschlag',
      invoiceTotal: 'Rechnungsbetrag',
    };
    const v = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/verify', headers: auth, payload: { fileId: p.fileId, carrierId, mapping } });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().diagnostics.verification.verdict).toBe('check');
    expect(v.json().diagnostics.verification.flaggedRows).toBe(2);

    const payload = { fileId: p.fileId, carrierId, invoiceNo: 'RE-7781', invoiceDate: '2026-10-31', currency: 'EUR', mapping };
    const r1 = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload });
    expect(r1.statusCode, r1.body).toBe(409);
    const err = r1.json().error;
    expect(err.code).toBe('MAPPING_UNVERIFIED');
    expect(err.details.flaggedRows).toBe(2);
    expect(err.details.issues.join(' ')).toContain('okuma sorunu');
    expect(err.details.examples.map((e: { rowIndex: number }) => e.rowIndex)).toEqual([1, 2]);

    const r2 = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { ...payload, acknowledgeIssues: true } });
    expect(r2.statusCode, r2.body).toBe(201);
    const inv = r2.json().invoice;
    expect(inv.totals.flaggedLines).toBe(2);

    const flagged = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?flagged=true`, headers: auth });
    const items = flagged.json().items as { id: string; rowIndex: number; parseFlags: string[]; parseChecked: boolean }[];
    expect(items.map((l) => l.rowIndex)).toEqual([1, 2]);
    expect(items[0]!.parseFlags).toContain('WEIGHT_RANGE');
    expect(items[1]!.parseFlags).toContain('DATE_PARSE');

    // "Kontrol ettim": bayrak saklanır, sayı düşer, süzgeçten çıkar.
    const patch = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${items[0]!.id}`, headers: auth, payload: { parseChecked: true } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().line).toMatchObject({ parseChecked: true, parseFlags: expect.arrayContaining(['WEIGHT_RANGE']) });
    expect(patch.json().totals.flaggedLines).toBe(1);

    // Yeniden karşılaştırma bayrakları kaynak dosyadan yeniden hesaplar ve "Kontrol ettim"i korur.
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${inv.id}/recompare`, headers: auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(rc.json().invoice.totals.flaggedLines).toBe(1);
    const after = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${inv.id}/lines?flagged=true`, headers: auth });
    expect(after.json().items.map((l: { rowIndex: number }) => l.rowIndex)).toEqual([2]);

    const logged = await inCompany(auth, () => prisma.auditLog.findFirst({ where: { entityId: inv.id, action: 'invoice.importUnverified' } }));
    expect(logged?.data).toMatchObject({ verdict: 'check', flaggedRows: 2 });
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): aynı takip numaraları önceki testin faturasında olduğu için 409 INVOICE_OVERLAP dönerdi (eskiden rawHash
  // farkı yetiyordu); test okuma kontrolü onayını sınadığından farklı gönderiler kullanılır. Kur servisi de sahte (üstteki not).
  it('sorunsuz eşlemede onay gerekmez', async () => {
    setFxService(new FxService({ fetcher: async () => ({ status: 404, text: '' }), cacheDir: null }));
    const p = await preview(app, auth, carrierId, DE_CSV.replaceAll('RE-7781', 'RE-7782').replaceAll('JD0146000033', 'JD0146000044'), 'de-ok.csv');
    const mapping = {
      ...p.suggestedMapping,
      trackingNo: 'Sendungsnummer',
      netAmount: 'Nettobetrag',
      baseAmount: 'Fracht',
      fuelAmount: 'Treibstoffzuschlag',
      invoiceTotal: 'Rechnungsbetrag',
    };
    // Ne okuma kontrolü onayı (acknowledgeIssues) ne çakışma onayı (confirmOverlap) gönderilir.
    const r = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: p.fileId, carrierId, invoiceNo: 'RE-7782', invoiceDate: '2026-10-31', currency: 'EUR', mapping },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().invoice.totals.flaggedLines).toBe(0);
  });
});
