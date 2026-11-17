import { OVERCHARGE_NOTE, cleanZoneLabel } from '@deciship/core';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPdfText } from '../src/services/tariffPdf.ts';
import { getApp, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/**
 * Tarife ve karşılaştırma uç durumları (gece ekibi A2; uydurma sayılar, yapay zekâ çağrısı yok):
 * Excel şablonu gidiş-dönüş, ülke adlı bölge eşleme, DHL tipi libre PDF + "From | To" ilave ücret tablosu,
 * geçerlilik günleri ve saat dilimi, yeniden karşılaştırmada karar/elle not, itiraz ve rapor tutarlılığı.
 */

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
const postJob = (url: string, payload: unknown) => viaJob(app, { method: 'POST', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const upload = (url: string, filename: string, data: Buffer, fields: { name: string; value: string }[] = []) => {
  const contentType = filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.csv') ? 'text/csv' : XLSX_MIME;
  const form = multipart([...fields, { name: 'file', filename, contentType, data }]);
  return app.inject({ method: 'POST', url, headers: { ...auth, ...form.headers }, payload: form.payload });
};

async function carrier(code: string) {
  const r = await post('/api/deciship/carriers', { code, name: uniq(code) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

async function createTariff(body: Record<string, unknown>) {
  const r = await post('/api/deciship/tariffs', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff as Record<string, unknown> & { id: string };
}

type Z = { zone: string };
/** Bölge adı içe aktarmada sadeleşir ("Zone 1" → "1"; SPEC 5.7, aynı bölge) — karşılaştırmada sadeleşmiş ad. */
const clean = <T extends Z>(xs: unknown) => (xs as T[]).map((x) => ({ ...x, zone: cleanZoneLabel(x.zone) }));
/** Karşılaştırma için tarifenin içerik alanları (kimlik/zaman damgası hariç). */
const content = (t: Record<string, unknown>) => ({
  currency: t.currency,
  weightSteps: t.weightSteps,
  zones: clean(t.zones),
  rates: clean(t.rates),
  overflow: clean(t.overflow),
  surcharges: t.surcharges,
});

async function sheetValues(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => ({ name: ws.name, rows: (ws.getSheetValues() as unknown[]).filter(Boolean) }));
}

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'A2 Uç Durum')).auth;
});

describe('Excel şablonu gidiş-dönüş: indir → içe aktar → uygula → tekrar indir', () => {
  it('kısa tablo + aşım: ağırlık basamakları, bölgeler (küçük harf bölge adı), aşım ve ek ücretler değişmez', async () => {
    const carrierId = await carrier('fedex');
    const t = await createTariff({
      carrierId,
      name: 'GD 1',
      currency: 'TRY',
      divisor: 5000,
      weightSteps: [
        { upto: 20, step: 0.5 },
        { upto: null, step: 1 },
      ],
      discountPct: 38,
      fuelPct: 25,
      isDefault: true,
      zones: [
        { country: 'DE', zone: 'A' },
        { country: 'GB', zone: 'b' },
      ],
      rates: [
        { zone: 'A', weightUpto: 5.5, price: 1400 },
        { zone: 'A', weightUpto: 6, price: 1527.75 },
        { zone: 'B', weightUpto: 6, price: 1800 },
      ],
      overflow: [{ zone: 'A', perUnit: 100 }],
      surcharges: [
        { code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'PER_KG', amount: 18.5 },
        { code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', kind: 'FIXED', amount: 285 },
        { code: 'INSURANCE', name: 'Sigorta', kind: 'PCT', amount: 1 },
      ],
    });
    const before = content(t);
    const tpl1 = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`);
    // "A" ile eşlemedeki "b"/"B" aynı bölge: tek sütun (önceden boş "b" sütunu yinelenen bölge uyarısı veriyordu)
    expect((await sheetValues(tpl1.rawPayload))[0]!.rows[0]).toEqual([undefined, 'Ağırlık (kg/desi) ≤', 'A', 'B', 'İndirim %']);

    const pv = await upload(`/api/deciship/tariffs/${t.id}/import`, 'gidis.xlsx', tpl1.rawPayload);
    expect(pv.statusCode, pv.body).toBe(200);
    const draft = pv.json();
    expect(draft.checks.filter((c: { severity: string }) => c.severity !== 'info')).toEqual([]);
    expect(draft.canApply).toBe(true);
    const ap = await post(`/api/deciship/tariff-imports/${draft.draftId}/apply`, { options: {} });
    expect(ap.statusCode, ap.body).toBe(200);
    // önceden basamaklar [{upto:null, step:0.5}] oluyordu → 20 kg üstü de 0,5'e yuvarlanır, aşım birimi yarıya inerdi
    expect(content(ap.json().tariff)).toEqual(before);

    const q = await post(`/api/deciship/tariffs/${t.id}/quote`, { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 25, destCountry: 'DE' });
    expect(q.json()).toMatchObject({ ok: true, chargeableKg: 25, base: 1527.75 + 19 * 100 });

    const tpl2 = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`);
    expect(await sheetValues(tpl2.rawPayload)).toEqual(await sheetValues(tpl1.rawPayload));
  });

  it('kg başı bantlar + açık uç ("1000+") + "İlave" ile üretilmiş satırlar: ikinci gidiş-dönüşte hiçbir değer değişmez', async () => {
    const carrierId = await carrier('ups');
    const flat = Array.from({ length: 6 }, (_, i) => ({ zone: 'Zone 1', weightUpto: (i + 1) / 2, price: 10 + i * 2.15 }));
    const t = await createTariff({
      carrierId,
      name: 'GD 2',
      currency: 'USD',
      divisor: 5000,
      weightSteps: [
        { upto: 3, step: 0.5 },
        { upto: null, step: 1 },
      ],
      zones: [{ country: 'US', zone: 'Zone 1' }],
      rates: [
        ...flat,
        { zone: 'Zone 1', weightUpto: 70, price: 4.35, perKg: true },
        { zone: 'Zone 1', weightUpto: 99999, price: 3.99, perKg: true },
      ],
      overflow: [],
      surcharges: [],
    });
    const before = content(t);
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`);
    const pv = (await upload(`/api/deciship/tariffs/${t.id}/import`, 'kg.xlsx', tpl.rawPayload)).json();
    expect(pv.checks.filter((c: { severity: string }) => c.severity !== 'info')).toEqual([]);
    const ap = await post(`/api/deciship/tariff-imports/${pv.draftId}/apply`, { options: {} });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(content(ap.json().tariff)).toEqual(before);
    const q = await post(`/api/deciship/tariffs/${t.id}/quote`, { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 45.2, destCountry: 'US' });
    expect(q.json()).toMatchObject({ ok: true, chargeableKg: 46, base: 200.1 });
    // ikinci tur: sadeleşmiş adlarla dosya aynen geri okunur
    const tpl2 = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`);
    const pv2 = (await upload(`/api/deciship/tariffs/${t.id}/import`, 'kg2.xlsx', tpl2.rawPayload)).json();
    const ap2 = await post(`/api/deciship/tariff-imports/${pv2.draftId}/apply`, { options: {} });
    expect(ap2.json().tariff.rates).toEqual(ap.json().tariff.rates);
    expect(await sheetValues((await get(`/api/deciship/tariffs/template.xlsx?tariffId=${t.id}`)).rawPayload)).toEqual(await sheetValues(tpl2.rawPayload));
  });

  it('Bölgeler sayfasında ülke adları (TR/EN) ve ISO kodu; aynı ülke iki farklı bölgede → uyarı, ilk satır geçerli', async () => {
    const carrierId = await carrier('dhl');
    const t = await createTariff({ carrierId, name: 'Adlar', currency: 'TRY', divisor: 5000, rates: [{ zone: 'A', weightUpto: 1, price: 1 }] });
    const wb = new ExcelJS.Workbook();
    const p = wb.addWorksheet('Fiyatlar');
    p.addRow(['Ağırlık (kg) ≤', 'A', 'B']);
    p.addRow([0.5, 10, 20]);
    p.addRow([1, 15, 25]);
    const z = wb.addWorksheet('Bölgeler');
    z.addRow(['Ülke', 'Bölge']);
    for (const r of [
      ['Almanya', 'A'],
      ['France', 'A'],
      ['Birleşik Krallık', 'B'],
      ['us', 'B'],
      ['Germany', 'B'],
    ]) {
      z.addRow(r);
    }
    const pv = (await upload(`/api/deciship/tariffs/${t.id}/import`, 'adlar.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))).json();
    expect(pv.zones).toEqual([
      { country: 'DE', zone: 'A' },
      { country: 'FR', zone: 'A' },
      { country: 'GB', zone: 'B' },
      { country: 'US', zone: 'B' },
    ]);
    const w = pv.checks.find((c: { code: string }) => c.code === 'SHEET_ROWS_SKIPPED');
    expect(w).toMatchObject({ severity: 'warning' });
    expect(w.detail).toContain('DE zaten A bölgesinde');
  });
});

// ---------------------------------------------------------------------------------------------

/** DHL tipi herkese açık liste fiyatı yapısı (uydurma sayılar): ülke listesi + "LB | Zone 1…" + "From | To" ilave ücret tablosu. */
async function dhlLikePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const SIZE = 8;
  const at = (p: PDFPage, f: PDFFont, text: string, x: number, y: number) => p.drawText(text, { x, y, size: SIZE, font: f });
  const c = doc.addPage([595, 842]);
  at(c, font, 'Countries & Territories', 60, 760);
  at(c, font, 'Zone', 220, 760);
  [
    ['Germany', '1'],
    ['France', '1'],
    ['United Kingdom', '2'],
    ['United States of America', '3'],
    ['Canada', '3'],
  ].forEach(([n, z], i) => {
    at(c, font, n!, 60, 745 - i * 12);
    at(c, font, z!, 222, 745 - i * 12);
  });
  const p = doc.addPage([595, 842]);
  const ZX = [230, 290, 350];
  let y = 800;
  const text = (t: string, x = 60) => {
    at(p, font, t, x, y);
    y -= 12;
  };
  const row = (label: string[], vals: string[]) => {
    label.forEach((l, i) => at(p, font, l, 60 + i * 60, y));
    vals.forEach((v, i) => at(p, font, v, ZX[i]!, y));
    y -= 12;
  };
  text('ORNEK EXPRESS WORLDWIDE EXPORT');
  text('All rates are in USD.');
  text('Non-documents from 1.0 LB');
  row(['LB'], ['Zone 1', 'Zone 2', 'Zone 3']);
  row(['1.0'], ['51.00', '61.00', '71.00']);
  row(['2.0'], ['56.00', '67.00', '78.00']);
  row(['3.0'], ['61.00', '73.00', '85.00']);
  row(['10.0'], ['96.00', '115.00', '134.00']);
  row(['20.0'], ['146.00', '175.00', '204.00']);
  text('Adder rate per additional 1 LB from 3.1 LB');
  row(['From', 'To'], ['Zone 1', 'Zone 2', 'Zone 3']);
  row(['3.1', '99 999'], ['5.00', '6.00', '7.00']);
  return Buffer.from(await doc.save());
}

describe('PDF (kodla, yapay zekâsız): DHL tipi libre tarife', () => {
  it('lb tablo → "lb" uyarısı ve lb→kg düzeltmesi; ilave ücret tablosu ara ağırlıkları üretir; İngilizce ülke listesi okunur', async () => {
    const carrierId = await carrier('dhl');
    const t = await createTariff({ carrierId, name: 'DHL lb', currency: 'USD', divisor: 5000, rates: [{ zone: '1', weightUpto: 1, price: 1 }] });
    const up = (await upload(`/api/deciship/tariffs/${t.id}/import`, 'dhl.pdf', await dhlLikePdf())).json();
    expect(up.kind).toBe('pdf');
    const sc = await post(`/api/deciship/tariff-documents/${up.documentId}/scan`, { mode: 'code' });
    expect(sc.statusCode, sc.body).toBe(200);
    const scan = sc.json();
    // önceden: weightUnit "kg" ve başlık "1–20 kg" → libre ağırlıklar kg diye uyarısız içe aktarılırdı
    expect(scan.document).toMatchObject({ weightUnit: 'lb', currency: 'USD', countryZonePages: [1] });
    expect(scan.sections).toHaveLength(1);
    expect(scan.sections[0].title).toContain('1–20 lb');
    expect(scan.sections[0].hasAdditionalStep).toBe(true);

    const ex = await postJob(`/api/deciship/tariff-documents/${up.documentId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId: t.id } });
    expect(ex.statusCode, ex.body).toBe(200);
    const d = ex.json();
    expect(d.checks.filter((c: { severity: string }) => c.severity === 'error').map((c: { code: string }) => c.code)).toEqual(['WEIGHT_UNIT_LB']);
    expect(d.fixes.map((f: { id: string }) => f.id)).toContain('convertLbToKg');
    expect(d.zones).toEqual(
      expect.arrayContaining([
        { country: 'DE', zone: '1' },
        { country: 'GB', zone: '2' },
        { country: 'US', zone: '3' },
      ]),
    );

    const re = (await post(`/api/deciship/tariff-imports/${d.draftId}/recheck`, { options: { convertLbToKg: true } })).json();
    expect(re.canApply).toBe(true);
    expect(re.checks.map((c: { code: string }) => c.code)).not.toContain('STEP_MISMATCH');
    const ap = await post(`/api/deciship/tariff-imports/${d.draftId}/apply`, { options: { convertLbToKg: true }, acknowledged: true });
    expect(ap.statusCode, ap.body).toBe(200);
    const rates = ap.json().tariff.rates as { zone: string; weightUpto: number; price: number }[];
    // 7 lb = 3,175 kg → 61 + 4 × 5 = 81; 15 lb = 6,804 kg → 96 + 5 × 7 = 169 (bölge 3: 134 + 35)
    expect(rates.find((r) => r.zone === '1' && r.weightUpto === 3.175)?.price).toBe(81);
    expect(rates.find((r) => r.zone === '3' && r.weightUpto === 6.804)?.price).toBe(169);
    expect(rates.filter((r) => r.zone === '1')).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------------------------

async function measurement(trackingRaw: string) {
  // 30×20×15 / 3000 = 3 desi, 2 kg → ücretli 3
  const p = measurementPayload({ trackingRaw, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.trackingNo as string;
}

describe('geçerlilik günleri, yeniden karşılaştırma, itiraz ve rapor', () => {
  it('saatli/saat dilimli tarih bir önceki güne kaymaz; sınır günleri; karar ve elle not korunur; itiraz ve rapor ekranla aynı', async () => {
    const carrierId = await carrier('aras');
    const desiRates = (perDesi: number) => Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * perDesi }));
    const base = {
      carrierId,
      name: 'Aras Ekim',
      currency: 'TRY',
      divisor: 3000,
      weightSteps: [{ upto: null, step: 1 }],
      isDefault: true,
      // Türkiye saatiyle 1 Ekim gece yarısı = 30 Eylül 21:00 UTC; ISO "Z" ile de aynı gün
      validFrom: '2026-10-01T00:00:00+03:00',
      validTo: '2026-10-30T21:00:00.000Z',
      zones: [{ country: '*', zone: 'TR' }],
    };
    const t = await createTariff({ ...base, rates: desiRates(10) });
    expect(t).toMatchObject({ validFrom: '2026-10-01', validTo: '2026-10-31' });

    const [a, b] = [await measurement(uniq('7001')), await measurement(uniq('7002'))];
    const csv = [
      'Takip No;Gönderi Tarihi;Desi;Tutar',
      `${a};30.09.2026;3;50`, // geçerlilik öncesi gün; beklenen 30 → +20
      `${b};01.10.2026;3;30`, // ilk gün → uyumlu, uyarısız
      `${uniq('7003')};31.10.2026;3;99`, // son gün; ölçüm yok
    ].join('\n');
    const pv = await upload('/api/deciship/invoices/preview', 'f.csv', Buffer.from(csv), [{ name: 'carrierId', value: carrierId }]);
    expect(pv.statusCode, pv.body).toBe(200);
    const inv = await post('/api/deciship/invoices', {
      fileId: pv.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-11-01T00:00:00+03:00',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', shipDate: 'Gönderi Tarihi', billedKg: 'Desi', netAmount: 'Tutar' },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    const invoice = inv.json().invoice;
    // önceden 2026-10-31 (UTC'ye çevrilip bir gün geri) kaydediliyordu
    expect(invoice.invoiceDate).toBe('2026-11-01');

    type L = { id: string; trackingNo: string; status: string; decision: string; note: string | null; diffAmount: number | null };
    const lines = async () => (await get(`/api/deciship/invoices/${invoice.id}/lines`)).json().items as L[];
    let ls = await lines();
    const la = ls.find((l) => l.trackingNo === a)!;
    const lb = ls.find((l) => l.trackingNo === b)!;
    expect(la).toMatchObject({ status: 'DIFF', diffAmount: 20 });
    expect(la.note).toContain('2026-09-30 tarihinde geçerli değil (geçerlilik: 2026-10-01 – 2026-10-31)');
    expect(lb).toMatchObject({ status: 'MATCH', note: null });
    expect(ls.find((l) => l.trackingNo !== a && l.trackingNo !== b)).toMatchObject({ status: 'UNMATCHED', note: 'Bu takip no için ölçüm yok' });

    const patch = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${la.id}`, headers: auth, payload: { decision: 'VERIFIED', note: 'Kargo ile görüşüldü' } });
    expect(patch.statusCode, patch.body).toBe(200);
    const d1 = (await get(`/api/deciship/invoices/${invoice.id}/dispute`)).json();
    expect(d1).toMatchObject({ lineCount: 1, total: 20 });

    // Fazla ödeme (20) = Faturalanan − Beklenen (80 − 60): ekrandaki gibi raporlarda açıklama yok
    const ozetOf = async () =>
      (await sheetValues((await get(`/api/deciship/invoices/${invoice.id}/report.xlsx`)).rawPayload)).find((s) => s.name === 'Özet')!.rows as unknown[][];
    const pdfText = async () => {
      const r = await get(`/api/deciship/invoices/${invoice.id}/report.pdf`);
      expect(r.statusCode).toBe(200);
      return (await readPdfText(r.rawPayload, { companyId: 'test' })).pages.join(' ').replace(/\s+/g, ' ');
    };
    const noteRow = (rows: unknown[][]) => rows.find((r) => r[1] === 'Not');
    expect(noteRow(await ozetOf())).toBeUndefined();
    expect(await pdfText()).not.toContain('Fazla ödeme yalnız');

    // tarife düzeltilir (3 desi = 50): yeniden karşılaştırma → satır uyumlu; karar ve elle not korunur
    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${t.id}`, headers: auth, payload: { ...base, rates: desiRates(50 / 3) } });
    expect(put.statusCode, put.body).toBe(200);
    // Mesaj 4: toplu yeniden karşılaştırma önizleme + özet (token) ister
    // Y83: toplu yeniden karşılaştırma yalnız arka planda (`postJob` → `?async=1`, iş sonucu eski yanıt biçiminde)
    const bulkPreview = await postJob(`/api/deciship/tariffs/${t.id}/recompare-invoices/preview`, {});
    expect((await postJob(`/api/deciship/tariffs/${t.id}/recompare-invoices`, { token: bulkPreview.json().token })).json()).toMatchObject({ invoices: 1, lines: 3 });
    ls = await lines();
    expect(ls.find((l) => l.id === la.id)).toMatchObject({ status: 'MATCH', decision: 'VERIFIED', note: 'Kargo ile görüşüldü', diffAmount: 0 });
    expect(ls.find((l) => l.id === lb.id)).toMatchObject({ status: 'MATCH', diffAmount: -20, note: 'Lehimize fark' });

    const h = (await get(`/api/deciship/invoices/${invoice.id}`)).json().invoice;
    expect(h.totals).toMatchObject({ verifiedTotal: 0, overchargeTotal: 0, comparedBilledTotal: 80, billedTotal: 179, expectedTotal: 100 });
    // itiraz ekrandaki "İtiraz listesinde 0,00" ile aynı: artık talep edilecek satır yok (önceden 0,00 ₺'lik itiraz metni çıkıyordu)
    const d2 = await get(`/api/deciship/invoices/${invoice.id}/dispute`);
    expect(d2.statusCode).toBe(400);
    expect(d2.json().error.code).toBe('NO_VERIFIED_LINES');

    // Excel raporu: Faturalanan ile Beklenen aynı (karşılaştırılan) satırlar üzerinden, fatura toplamı ayrıca
    const rep = await get(`/api/deciship/invoices/${invoice.id}/report.xlsx`);
    expect(rep.statusCode).toBe(200);
    const ozet = (await sheetValues(rep.rawPayload)).find((s) => s.name === 'Özet')!.rows as unknown[][];
    const val = (k: string) => ozet.find((r) => r[1] === k)?.[2];
    expect(val('Faturalanan toplam (karşılaştırılan satırlar)')).toBe(80);
    expect(val('Beklenen toplam (karşılaştırılan satırlar)')).toBe(100);
    expect(val('Fatura toplamı (tüm satırlar)')).toBe(179);
    expect(val('İtiraz listesinde')).toBe(0);
    // Fazla ödeme 0 ama Faturalanan − Beklenen −20 (lehe fark): ekran, Excel ve PDF aynı tek satırlık açıklamayı gösterir
    expect(h.totals.overchargeTotal).toBe(0);
    expect(val('Not')).toBe(OVERCHARGE_NOTE);
    expect(noteRow(await ozetOf())?.[2]).toBe(OVERCHARGE_NOTE);
    expect(await pdfText()).toContain(OVERCHARGE_NOTE);
  });
});
