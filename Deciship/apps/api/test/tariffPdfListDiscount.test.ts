import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyListDiscountSelection, type StoredScan } from '../src/services/tariffPdf.ts';
import { getApp, multipart, registerCompany } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/**
 * Liste fiyatı × indirim tablosu (sentetik PDF, uydurma sayılar): kod taraması indirim tablosunu okur, net tabloyu liste
 * karşılığına bağlar ve "liste × indirim" önerir; çıkarma `pricing:'listDiscount'` ile liste fiyatından net hesaplar.
 */

type Auth = { authorization: string };
const SIZE = 8;
const ZONE_X = [230, 290, 350];

async function contractPdf(): Promise<Buffer<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const at = (p: PDFPage, f: PDFFont, text: string, x: number, y: number, centered = false) =>
    p.drawText(text, { x: centered ? x - f.widthOfTextAtSize(text, SIZE) / 2 : x, y, size: SIZE, font: f });
  const terms = doc.addPage([595, 842]);
  ['Genel Sartlar', 'Tum fiyatlar USD cinsinden verilmistir (KDV haric).', 'Boyutsal agirlik orani 1:5, DIM 5000 (cm).', 'FIXED 5%'].forEach((l, i) =>
    at(terms, font, l, 40, 800 - i * 14),
  );
  // net: liste × 0,4 (indirim tablosundaki %60 ile aynı) ama ilave tutarı ayrı yuvarlanmış → ara ağırlıklar kuruş farklı
  const pricePage = (net: boolean) => {
    const p = doc.addPage([595, 842]);
    let y = 800;
    const text = (t: string) => {
      at(p, font, t, 140, y);
      y -= 11;
    };
    const row = (label: string, vals: string[]) => {
      at(p, font, label, 150, y);
      vals.forEach((v, i) => at(p, font, v, ZONE_X[i]!, y, true));
      y -= 11;
    };
    text("DUNYA GENELI / IHRACAT UCRETLERI   2 Haziran 2026'dan itibaren gecerlidir.");
    text('FedEx International Priority (IP)');
    text(net ? '- Net Ucretler' : '- Liste Fiyati');
    at(p, font, 'AGIRLIK (KG)', 150, y);
    ['A BOLGESI', 'B BOLGESI', 'ZONE C'].forEach((z, i) => at(p, font, z, ZONE_X[i]!, y, true));
    y -= 11;
    row('', ['USD', 'USD', 'USD']);
    text('Diger ambalaj malzemeleri kullanildiginda ucretler (0,5 - 70,5kg)');
    if (net) {
      row('0.5', ['12.00', '16.00', '20.00']);
      row('10.5', ['40.03', '44.00', '48.00']);
      row('Ilave 0,5kg', ['4.03', '4.40', '4.80']);
      row('21', ['120.40', '132.00', '144.00']);
      text('Kg basina ucret (toplam gonderi agirligiyla carpiniz)');
      row('71-99', ['6.00', '6.40', '6.80']);
    } else {
      row('0.5', ['30.00', '40.00', '50.00']);
      row('10.5', ['100.07', '110.00', '120.00']);
      row('Ilave 0,5kg', ['10.07', '11.00', '12.00']);
      row('21', ['301.00', '330.00', '360.00']);
      text('Kg basina ucret (toplam gonderi agirligiyla carpiniz)');
      row('71-99', ['15.00', '16.00', '17.00']);
    }
  };
  pricePage(true);
  const d = doc.addPage([595, 842]);
  at(d, font, 'IHRACAT Indirimi', 70, 800);
  at(d, font, 'Asagidaki degerler indirim yuzdeleridir; liste fiyatlarina uygulayiniz.', 70, 788);
  at(d, font, 'Minimum Agirlik', 100, 770);
  at(d, font, 'Maksimum Agirlik', 160, 770);
  ['A', 'B', 'C'].forEach((z, i) => at(d, font, z, ZONE_X[i]!, 765, true));
  at(d, font, '(KG)', 110, 760);
  at(d, font, '(KG)', 170, 760);
  const drow = (y: number, label: string, min: string, max: string, vals: string[]) => {
    at(d, font, label, 60, y);
    at(d, font, min, 110, y);
    at(d, font, max, 170, y);
    vals.forEach((v, i) => v && at(d, font, v, ZONE_X[i]!, y, true));
  };
  drow(748, 'IP Pak', '0.50', '2.50', ['50.00%', '50.00%', '50.00%']);
  drow(737, 'IP', '0.50', '20.50', ['60.00%', '60.00%', '#REF!']);
  drow(726, 'IP', '21.00', '9999.00', ['60.00%', '', '#REF!']);
  pricePage(false);
  const c = doc.addPage([595, 842]);
  at(c, font, 'ULKE', 100, 700);
  at(c, font, 'BOLGE', 160, 700);
  (
    [
      ['ALMANYA', 'A'],
      ['ITALYA', 'B'],
      ['KANADA', 'B'],
      ['FRANSA', 'A'],
      ['ISPANYA', 'A'],
    ] as const
  ).forEach(([name, zone], i) => {
    at(c, font, name, 100, 685 - i * 12);
    at(c, font, zone, 172, 685 - i * 12, true);
  });
  return Buffer.from(await doc.save());
}

const codes = (checks: { code: string; severity: string }[], sev: string) => checks.filter((c) => c.severity === sev).map((c) => c.code);
type Rate = { zone: string; weightUpto: number; price: number; perKg: boolean };

describe('PDF: liste fiyatı × indirim tablosu', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let tariffId: string;
  let pdf: Buffer<ArrayBuffer>;
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
  const postJob = (url: string, payload: unknown) => viaJob(app, { method: 'POST', url, headers: auth, payload: payload as object });
  const upload = async () => {
    const form = multipart([{ name: 'file', filename: 'sozlesme.pdf', contentType: 'application/pdf', data: pdf }]);
    const r = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/import`, headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().documentId as string;
  };

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app, 'PDF Liste İndirim')).auth;
    const carrierId = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex' } })).json().carrier.id;
    const t = await post('/api/deciship/tariffs', {
      carrierId,
      name: 'FedEx IP',
      service: 'FedEx Intl Priority',
      currency: 'USD',
      divisor: 5000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 0.5 }],
      discountPct: 0,
      fuelPct: 5,
      isDefault: true,
      zones: [{ country: 'DE', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 1, price: 10 }],
      overflow: [],
      surcharges: [],
    });
    expect(t.statusCode, t.body).toBe(201);
    tariffId = t.json().tariff.id;
    pdf = await contractPdf();
  });

  it('tarama: indirim tablosu okunur, net tablo liste karşılığına bağlanır, liste × indirim önerilir', async () => {
    const docId = await upload();
    const scan = (await post(`/api/deciship/tariff-documents/${docId}/scan`, { mode: 'code' })).json();
    expect(scan.sections.map((s: { id: string; priceType: string; pages: number[] }) => [s.id, s.priceType, s.pages])).toEqual([
      ['c1', 'net', [2]],
      ['c2', 'list', [4]],
    ]);
    expect(scan.discountTables).toEqual([{ id: 'd1', title: 'IP ihracat indirimi', service: 'IP', direction: 'export', pages: [3], zones: ['A', 'B', 'C'], bands: 2 }]);
    expect(scan.sections[0].listDiscount).toEqual({
      listSectionId: 'c2',
      discountTableId: 'd1',
      listPages: [4],
      discountPages: [3],
      diff: { compared: expect.any(Number), differing: expect.any(Number), maxDiff: expect.any(Number) },
    });
    expect(scan.sections[0].listDiscount.diff.differing).toBeGreaterThan(0);
    expect(scan.sections[1].listDiscount).toMatchObject({ listSectionId: 'c2', diff: null });
    expect(scan.suggestedSectionIds).toEqual(['c1']);
    expect(scan.suggestedPricing).toBe('listDiscount');
  });

  it('çıkarma: liste × indirim (ara ağırlıklar listeden), indirimsiz hücre uyarı, #REF! sütunu eski kuralla düşer; tablo seçeneği net sayfayı alır', async () => {
    const docId = await upload();
    await post(`/api/deciship/tariff-documents/${docId}/scan`, { mode: 'code' });
    const ex = await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, pricing: 'listDiscount', target: { tariffId } });
    expect(ex.statusCode, ex.body).toBe(200);
    const p = ex.json();
    const price = (rates: Rate[], zone: string, w: number, perKg = false) => rates.find((r) => r.zone === zone && r.weightUpto === w && r.perKg === perKg)?.price;
    expect(price(p.rates, 'A', 0.5)).toBe(12);
    expect(price(p.rates, 'A', 10.5)).toBe(40.03); // 100,07 × 0,4 = 40,028
    expect(price(p.rates, 'A', 11)).toBe(44.06); // (100,07 + 10,07) × 0,4 = 44,056 (net sayfa: 40,03 + 4,03 = 44,06)
    expect(price(p.rates, 'A', 12)).toBe(52.11); // (100,07 + 3 × 10,07) × 0,4 = 52,112 (net sayfa: 52,12)
    expect(price(p.rates, 'A', 21)).toBe(120.4);
    expect(price(p.rates, 'B', 21)).toBeUndefined();
    expect(p.rates.some((r: Rate) => r.zone === 'C')).toBe(false);
    expect(p.source.sectionTitles[0]).toContain('liste × indirim');
    const info = p.checks.find((c: { code: string; title: string }) => c.code === 'PDF_LIST_DISCOUNT');
    expect(info.severity).toBe('info');
    expect(info.detail).toContain('net = liste fiyatı × (1 − indirim %)');
    expect(info.detail).toContain('C bölgesinin indirim oranı tabloda yok');
    expect(codes(p.checks, 'warning')).toContain('PDF_DISCOUNT_MISSING');
    expect(p.checks.find((c: { code: string }) => c.code === 'PDF_DISCOUNT_MISSING').detail).toContain('Bölge B, "21"');

    // tablodaki fiyat (net sayfa) seçeneği: eski davranış
    const ex2 = (await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: ['c1'], includeCountryZones: true, target: { tariffId } })).json();
    expect(price(ex2.rates, 'A', 12)).toBe(52.12);
    expect(price(ex2.rates, 'B', 21)).toBe(132);
    expect(ex2.checks.some((c: { code: string }) => c.code === 'PDF_LIST_DISCOUNT')).toBe(false);
  });

  it('karşılığı olmayan bölüm tablodaki fiyatla kalır (bilgi notu)', () => {
    const sec = { id: 'c9', title: 'XE ihracat · net', service: 'XE', direction: 'export' as const, priceType: 'net' as const, packaging: 'all' as const, zones: ['A'], weightMin: 1, weightMax: 2, currency: 'USD', pages: [1], hasAdditionalStep: false, hasPerKgBands: false };
    const scan: StoredScan = { mode: 'code', document: {} as StoredScan['document'], sections: [sec], discountTables: [], scannedAt: '' };
    const r = applyListDiscountSelection([sec], scan);
    expect(r.applied).toBe(0);
    expect(r.sections).toEqual([sec]);
    expect(r.issues.map((i) => [i.code, i.title])).toEqual([['PDF_LIST_DISCOUNT', 'Liste × indirim hesaplanamadı; tablodaki fiyatlar alındı']]);
  });
});
