import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHT_STEPS,
  buildDisputeText,
  checkTariffImport,
  chargeableWeight,
  compareLine,
  expectedCharge,
  importWeightSteps,
  parseTariffImport,
  roundUpToStep,
  scanPdfLayout,
  type DisputeLine,
  type FxRate,
  type PdfTextItem,
  type TariffImportContext,
  type TariffInput,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/** Uç durumlar (gece ekibi A2): sınır değerleri, lb/USD, bölge eşleme, tablo yuvarlaması, itiraz, PDF yapıları. Sayılar uydurma. */

/** Yuvarlamasız, tek bölgeli basit tarife: sınırları tek tek görmek için. */
const FLAT: TariffInput = {
  id: 'flat',
  currency: 'TRY',
  divisor: 5000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [],
  discountPct: 0,
  fuelPct: 0,
  zones: { '*': 'A' },
  rates: [
    { zone: 'A', weightUpto: 2.5, price: 100 },
    { zone: 'A', weightUpto: 3, price: 120 },
    { zone: 'A', weightUpto: 10, price: 200 },
  ],
  surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', kind: 'FIXED', amount: 50 }],
};

const cmp = (l: ReturnType<typeof line>, m = meas(10, 10, 10, 2.5), tariff: TariffInput = FLAT, tol = TOL, fx?: { date: string; rate: FxRate | null }) =>
  compareLine({ line: l, measurement: m, tariff, tol, isDuplicate: false, ...(fx ? { fx } : {}) });

describe('0,5 kg yuvarlama sınırları', () => {
  it('2,50 → 2,5; 2,501 / 2,51 → 3,0; 20,0 → 20 (0,5 bandı), 20,001 → 21 (1 kg bandı)', () => {
    expect(roundUpToStep(2.5, DEFAULT_WEIGHT_STEPS)).toBe(2.5);
    expect(roundUpToStep(2.501, DEFAULT_WEIGHT_STEPS)).toBe(3);
    expect(roundUpToStep(2.51, DEFAULT_WEIGHT_STEPS)).toBe(3);
    expect(roundUpToStep(20, DEFAULT_WEIGHT_STEPS)).toBe(20);
    expect(roundUpToStep(20.001, DEFAULT_WEIGHT_STEPS)).toBe(21);
    // gram altı gürültü (20,0004) gram hassasiyetinde 20,000 sayılır
    expect(roundUpToStep(20.0004, DEFAULT_WEIGHT_STEPS)).toBe(20);
  });

  it('fiyat satırı seçimi sınırda: 2,50 kg → "≤ 2,5" satırı, 2,51 kg → "≤ 3" satırı', () => {
    const at = (kg: number) => expectedCharge({ tariff: FLAT, chargeableKg: kg, destCountry: 'DE' });
    expect(at(2.5)).toMatchObject({ ok: true, base: 100 });
    expect(at(2.51)).toMatchObject({ ok: true, base: 120 });
  });

  it('inç ölçüler cm\'ye çevrilmiş gelir (10 in = 25,4 cm) → kenar 26 cm\'ye yukarı yuvarlanır', () => {
    const r = chargeableWeight({ dims: { l: 25.4, w: 25.4, h: 25.4 }, actualKg: 1, divisor: 5000, steps: DEFAULT_WEIGHT_STEPS });
    expect(r).toEqual({ volumetric: 3.515, chargeable: 4, basis: 'VOLUMETRIC' });
    // 15,75 in = 40,005 cm → 41 (yukarı); 15,748 in ≈ 39,99992 cm → 40
    expect(chargeableWeight({ dims: { l: 40.005, w: 30, h: 25 }, actualKg: 1, divisor: 5000 }).volumetric).toBe(6.15);
    expect(chargeableWeight({ dims: { l: 15.748 * 2.54, w: 30, h: 25 }, actualKg: 1, divisor: 5000 }).volumetric).toBe(6);
  });
});

describe('tolerans sınırları (tam sınırda uyumlu)', () => {
  it('ağırlık: +0,1 kg uyumlu (fiyat aynı), +0,101 kg ağırlık farkı', () => {
    const m = meas(10, 10, 10, 2.4);
    expect(cmp(line({ trackingNo: 'T1', netAmount: 100, billedKg: 2.5 }), m)).toMatchObject({ status: 'MATCH', diffTypes: [] });
    expect(cmp(line({ trackingNo: 'T1', netAmount: 120, billedKg: 2.501 }), m)).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'] });
  });

  // KARARLAR "Ölçüm sınırı" (2026-11-10): eskiden bu satır kesin "Ölçü farkı" (+20) idi. Artık ölçümün her kenarına tolerans
  // kadar pay eklenir; taşıyıcının ağırlığı bu payın içindeyse fark sayılmaz ve beklenen taşıyıcının ağırlığında hesaplanır.
  it('kenar toleransı (1 cm) içindeki ölçü sapması fark sayılmaz; toleransın ötesi ve tolerans 0 iken kesin fark', () => {
    // bizim 30×20×20 (hacimsel 2,4) · 2,0 kg; fatura her kenarı tam 1 cm büyük ölçmüş → 2,734 kg
    const m = meas(30, 20, 20, 2);
    const l = line({ trackingNo: 'T2', netAmount: 120, dims: { l: 31, w: 21, h: 21 }, actualKg: 2 });
    const r = cmp(l, m);
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], ourChargeableKg: 2.4, billedChargeableKg: 2.734, expectedAmount: 120, diffAmount: 0 });
    expect(r.note).toBe('Ağırlık farkı ölçüm toleransı içinde (±1 cm); taşıyıcının ağırlığı kabul edildi');
    // tolerans 0: eski kural, kesin ölçü farkı
    expect(cmp(l, m, FLAT, { ...TOL, edgeTolCm: 0 })).toMatchObject({ status: 'DIFF', diffTypes: ['DIMENSION'], ourChargeableKg: 2.4, diffAmount: 20 });
    // her kenar 2 cm büyük (3,098 kg → 3,5): payın (3,0 kg) ötesinde, kesin ölçü farkı
    const over = cmp(line({ trackingNo: 'T2', netAmount: 200, dims: { l: 32, w: 22, h: 22 }, actualKg: 2 }), m);
    expect(over).toMatchObject({ status: 'DIFF', diffTypes: ['DIMENSION'], ourChargeableKg: 2.4, expectedAmount: 100, diffAmount: 100 });
    expect(over.confidence).toBe('HIGH');
    // tolerans içinde ama taşıyıcı o ağırlığın tarife fiyatından da pahalı: fiyat farkı görünür kalır
    expect(cmp({ ...l, netAmount: 131 }, m)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 120, diffAmount: 11 });
    // ücretli kg'ı değiştirmeyen ölçü sapması fark sayılmaz
    const same = cmp(line({ trackingNo: 'T2', netAmount: 120, dims: { l: 31, w: 21, h: 21 }, actualKg: 2.8 }), meas(30, 20, 20, 2.8));
    expect(same).toMatchObject({ status: 'MATCH', ourChargeableKg: 2.8, billedChargeableKg: 2.8 });
  });

  it('tutar: fark tam 5,00 uyumlu; 5,01 fiyat farkı; lehimize −5,00 notsuz, −5,01 "Lehimize fark"', () => {
    const at = (net: number) => cmp(line({ trackingNo: 'T3', netAmount: net, billedKg: 2.5 }));
    expect(at(105)).toMatchObject({ status: 'MATCH', diffAmount: 5 });
    expect(at(105.01)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 5.01 });
    expect(at(95).note).toBeUndefined();
    expect(at(94.99)).toMatchObject({ status: 'MATCH', diffAmount: -5.01, note: 'Lehimize fark' });
  });

  // SPEC §3.8 (2026-11-08): eskiden Beklenen yalnız tarifeydi (2,5 kg = 100) ve fark −10 çıkıyordu; ağırlık fazlası
  // taşıyıcının tarifeden ucuz fiyatı arkasında kayboluyordu. Artık taşıyıcı 3 kg'ı 90'a (tarife 120, %25 ucuz)
  // fiyatladığından beklenen kendi fiyatının 2,5 kg'a ölçeklenmesidir: 90 × 100/120 = 75 → ağırlık fazlası +15.
  it('taşıyıcı tarifeden ucuzken ağırlık farkı: beklenen faturadaki fiyatın bizim kg’a ölçeklenmesi (pozitif fark)', () => {
    const r = cmp(line({ trackingNo: 'T4', netAmount: 90, billedKg: 3 }), meas(10, 10, 10, 2.4));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 75, diffAmount: 15, pricingBasis: 'INVOICE', rateDeviationPct: -25 });
  });

  // KARARLAR "Parasız fark" (2026-11-10): eskiden bu satır "Fark var · Ağırlık farkı" (−14) idi; itiraz edilecek para
  // olmadığı için artık uyumlu, notla.
  it('tarife dayanağında negatif fark itiraz tutarı üretmez: ağırlık farklı yazılmış ama para yok, satır uyumlu', () => {
    // 3 kg faturalanmış ama tutar tarifenin 2,5 kg'ı kadar düşük değil: taşıyıcı 3 kg'ı 116'ya (tarife 120, tolerans içinde) fiyatladı
    const r = cmp(line({ trackingNo: 'T4', netAmount: 116, billedKg: 3 }), meas(10, 10, 10, 2.4), { ...FLAT, rates: FLAT.rates.map((x) => (x.weightUpto === 2.5 ? { ...x, price: 130 } : x)) });
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], pricingBasis: 'TARIFF', expectedAmount: 130, diffAmount: -14 });
    expect(r.note).toBe('Ağırlık farklı yazılmış, tutara etkisi yok · Lehimize fark');
  });

  it('ek ücret: tarifedekinden tam 5,00 fazlası uyumlu; 5,01 fazlası ek ücret farkı', () => {
    const at = (amt: number) =>
      cmp(line({ trackingNo: 'T5', netAmount: 100 + amt, billedKg: 2.5, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Additional Handling', amount: amt }] }));
    expect(at(55)).toMatchObject({ status: 'MATCH', expectedAmount: 150 });
    expect(at(55.01)).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'] });
  });

  it("tarifede olmayan ek ücret: varsayılan Beklenen'e faturadaki tutarıyla (fark 0), ayar açıksa ek ücret farkı", () => {
    const l = line({ trackingNo: 'T6', netAmount: 180, billedKg: 2.5, surcharges: [{ code: 'SAT', name: 'Saturday Delivery', amount: 80 }] });
    expect(cmp(l)).toMatchObject({ status: 'MATCH', expectedAmount: 180, diffAmount: 0, uncheckedSurchargeTotal: 80 });
    expect(cmp(l, undefined, FLAT, { ...TOL, unknownSurchargesAsDiff: true })).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 80 });
  });
});

describe('kur toleransı sınırları', () => {
  const USD: TariffInput = { ...FLAT, currency: 'USD', rates: [{ zone: 'A', weightUpto: 10, price: 100 }] };
  const fx = (rate: number | null) => ({
    date: '2026-10-17',
    rate: rate == null ? null : { base: 'USD', quote: 'TRY', rate, date: '2026-10-16', source: 'TCMB' },
  });
  // beklenen 100 USD × 40 = 4.000 TRY; %1,5 = 60 TRY
  it('tam %1,5 uyumlu + kur notu; 60,01 fark; hafta sonu → önceki iş günü kuru dökümde "… için"', () => {
    const at = (net: number) => cmp(line({ trackingNo: 'F1', netAmount: net, billedKg: 2, currency: 'TRY' }), meas(10, 10, 10, 2), USD, TOL, fx(40));
    const ok = at(4060);
    expect(ok).toMatchObject({ status: 'MATCH', expectedAmount: 4000, diffAmount: 60, note: 'Kur farkı tolerans içinde (%1,5)' });
    expect(ok.breakdown.at(-1)!.label).toBe('Beklenen 100,00 USD × 40,0000 (TCMB 16.10.2026, 17.10.2026 için)');
    expect(at(4060.01)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
    // lehimize kur farkı da tolerans içinde: not "Lehimize fark" değil kur notu
    expect(at(3940).note).toBe('Kur farkı tolerans içinde (%1,5)');
    expect(at(3939.99).note).toBe('Lehimize fark');
  });

  it('kur yok (TCMB o gün ve 10 gün geriye bülten yayımlamamış) → Tarife yok + not', () => {
    const r = cmp(line({ trackingNo: 'F2', netAmount: 4000, billedKg: 2, currency: 'TRY' }), meas(10, 10, 10, 2), USD, TOL, fx(null));
    expect(r).toMatchObject({ status: 'NO_TARIFF', expectedAmount: null, note: 'Kur bulunamadı (USD→TRY, 17.10.2026)' });
  });
});

describe('Excel/CSV içe aktarma: bölge eşleme, lb, ilave satırları', () => {
  const prices = [
    ['Ağırlık (kg) ≤', 'Zone A', 'B'],
    ['0,5', '10', '20'],
    ['1', '15', '25'],
  ];

  it('Bölgeler sayfası: ISO kodu, Türkçe ve İngilizce ülke adı kabul edilir; çakışan eşleme ilk satırla kalır ve uyarılır', () => {
    const p = parseTariffImport({
      fileName: 'x.xlsx',
      kind: 'xlsx',
      prices,
      zones: [
        ['Ülke kodu', 'Bölge'],
        ['de', 'Zone A'],
        ['Fransa', 'A'],
        ['United Kingdom', 'B'],
        ['ABD', 'B'],
        ['Almanya', 'A'],
        ['Germany', 'B'],
        ['UK', 'B'],
        ['Atlantis', 'B'],
      ],
      surcharges: null,
    });
    expect(p.zones).toEqual([
      { country: 'DE', zone: 'A' },
      { country: 'FR', zone: 'A' },
      { country: 'GB', zone: 'B' },
      { country: 'US', zone: 'B' },
    ]);
    expect(p.sheetIssues).toEqual([
      { sheet: 'zones', row: 7, reason: 'DE zaten A bölgesinde; bu satır alınmadı' },
      { sheet: 'zones', row: 9, reason: 'Geçersiz ülke kodu veya bölge' },
    ]);
  });

  it('başlıksız Bölgeler sayfasında ilk satır da okunur', () => {
    const p = parseTariffImport({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: [['DE', 'A'], ['GB', 'B']], surcharges: null });
    expect(p.zones.map((z) => z.country)).toEqual(['DE', 'GB']);
  });

  it('lb → kg: ağırlık × 0,45359237 (3 ondalık), kg başı fiyat ÷ 0,45359237, aşım ÷ 0,45359237', () => {
    const p = parseTariffImport(
      {
        fileName: 'us.csv',
        kind: 'csv',
        prices: [
          ['Weight (lbs)', 'A'],
          ['1', '50'],
          ['2', '60'],
          ['3', '70'],
          ['151-300 per kg', '2.00'],
          ['Aşım', '1.00'],
        ],
        zones: null,
        surcharges: null,
      },
      { convertLbToKg: true },
    );
    expect(p.detectedWeightUnit).toBe('lb');
    expect(p.rates.map((r) => [r.weightUpto, r.price, !!r.perKg])).toEqual([
      [0.454, 50, false],
      [0.907, 60, false],
      [1.361, 70, false],
      [136.078, 4.41, true],
    ]);
    // aşım lb başına kalır, birimi lb basamağı (01-B5; eskiden kg başına 2,2'ye çevriliyordu)
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 1 }]);
    // libre sınırının hemen altı/üstü: 0,907 kg = 2 lb satırı, 0,908 kg → 3 lb satırı
    const t: TariffInput = { ...FLAT, rates: p.rates.map((r) => ({ zone: r.zone, weightUpto: r.weightUpto, price: r.price, perKg: r.perKg })) };
    expect(expectedCharge({ tariff: t, chargeableKg: 0.907, destCountry: 'DE' })).toMatchObject({ base: 60 });
    expect(expectedCharge({ tariff: t, chargeableKg: 0.908, destCountry: 'DE' })).toMatchObject({ base: 70 });
  });

  it('kg başı bantlarda kg fiyatının ağırlıkla düşmesi uyarı değildir (sabit fiyatta düşüş hâlâ uyarı)', () => {
    const p = parseTariffImport({
      fileName: 'x.xlsx',
      kind: 'xlsx',
      prices: [
        ['Ağırlık (kg)', 'A'],
        ['1', '10'],
        ['2', '9'],
        ['3-70 kg başı', '4,35'],
        ['70+ kg başı', '3,99'],
      ],
      zones: [['DE', 'A']],
      surcharges: null,
    });
    const checks = checkTariffImport(p, { tariffCurrency: 'TRY', currentZones: [], currentRates: [], newTariff: true });
    const dec = checks.find((c) => c.code === 'PRICE_DECREASES');
    expect(dec?.title).toBe('1 yerde ağırlık artarken fiyat düşüyor');
    expect(dec?.detail).not.toContain('kg başı');
  });

  it('"İlave 0,5 kg" satırı ara ağırlıkları üretir, açık satırlar değişmez', () => {
    const p = parseTariffImport({
      fileName: 'x.xlsx',
      kind: 'xlsx',
      prices: [
        ['Ağırlık (kg)', 'A'],
        ['10', '100'],
        ['İlave 0,5 kg', '4'],
        ['12', '116'],
      ],
      zones: null,
      surcharges: null,
    });
    expect(p.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [10, 100],
      [12, 116],
      [10.5, 104],
      [11, 108],
      [11.5, 112],
    ]);
    expect(p.stepMismatches).toEqual([]);
  });
});

describe('içe aktarmada ağırlık basamakları (tablodan) — aşım birimi korunur', () => {
  const ctx = (steps: TariffImportContext['currentWeightSteps']): TariffImportContext => ({
    tariffCurrency: 'TRY',
    currentZones: [],
    currentRates: [],
    currentOverflow: [{ zone: 'A', perUnit: 100 }],
    currentWeightSteps: steps,
  });
  const short = parseTariffImport({
    fileName: 'x.xlsx',
    kind: 'xlsx',
    prices: [
      ['Ağırlık (kg)', 'A'],
      ['5,5', '1400'],
      ['6', '1527,75'],
    ],
    zones: null,
    surcharges: null,
  });

  it('tablo 6 kg\'da bitiyor, mevcut "20 kg\'a kadar 0,5, üstü 1": tüm üst bantlar korunur (önceden 20 kg üstü de 0,5 oluyordu)', () => {
    expect(importWeightSteps(short, ctx([{ upto: 20, step: 0.5 }, { upto: null, step: 1 }]))).toEqual([
      { upto: 20, step: 0.5 },
      { upto: null, step: 1 },
    ]);
  });

  it('tek üst bant: değişmez; aşım yoksa üstü 1 kg', () => {
    expect(importWeightSteps(short, ctx([{ upto: null, step: 0.5 }]))).toEqual([{ upto: null, step: 0.5 }]);
    expect(importWeightSteps(short, { ...ctx([{ upto: 20, step: 0.5 }, { upto: null, step: 1 }]), currentOverflow: [] })).toEqual([
      { upto: 6, step: 0.5 },
      { upto: null, step: 1 },
    ]);
  });

  it('tablo 30 kg\'a kadar 0,5\'er (0,5 bandı mevcut bandı aşıyor): tablonun bandı, üstü mevcut tarifeden', () => {
    const long = parseTariffImport({
      fileName: 'x.xlsx',
      kind: 'xlsx',
      prices: [['Ağırlık (kg)', 'A'], ...Array.from({ length: 60 }, (_, i) => [String((i + 1) / 2).replace('.', ','), String(100 + i)])],
      zones: null,
      surcharges: null,
    });
    expect(importWeightSteps(long, ctx([{ upto: 20, step: 0.5 }, { upto: 50, step: 1 }, { upto: null, step: 5 }]))).toEqual([
      { upto: 30, step: 0.5 },
      { upto: 50, step: 1 },
      { upto: null, step: 5 },
    ]);
  });

  it('aşım fiyatı birimi: 25 kg = 6 kg + 19 × 1 kg (önceden 38 × 0,5 kg sayılırdı)', () => {
    const t: TariffInput = {
      ...FEDEX,
      weightSteps: importWeightSteps(short, ctx(FEDEX.weightSteps))!,
      rates: [
        { zone: 'A', weightUpto: 5.5, price: 1400 },
        { zone: 'A', weightUpto: 6, price: 1527.75 },
      ],
      overflowPerUnit: { A: 100 },
    };
    expect(expectedCharge({ tariff: t, chargeableKg: 25, destCountry: 'FR' })).toMatchObject({ ok: true, base: 1527.75 + 1900 });
  });
});

describe('itiraz metni: ekrandaki "İtiraz listesinde" tutarıyla aynı satırlar', () => {
  const base = (lines: DisputeLine[]) => ({
    company: { name: 'Demo' },
    carrier: { name: 'FedEx' },
    invoice: { invoiceNo: 'INV-1', invoiceDate: '2026-10-27', currency: 'TRY' },
    lang: 'tr' as const,
    lines,
  });
  const l = (over: Partial<DisputeLine>): DisputeLine => ({
    trackingNo: 'X',
    diffTypes: ['WEIGHT'],
    decision: 'VERIFIED',
    status: 'DIFF',
    ourChargeableKg: 2,
    billedChargeableKg: 3,
    expectedAmount: 100,
    billedAmount: 130,
    diffAmount: 30,
    ...over,
  });

  it('yeniden karşılaştırmada uyumlu çıkan ya da farkı ≤ 0 olan doğrulanmış satır listelenmez; toplam negatif farkla azalmaz', () => {
    const r = buildDisputeText(
      base([
        l({ trackingNo: 'A1' }),
        l({ trackingNo: 'A2', status: 'MATCH', diffTypes: [], diffAmount: 2 }),
        l({ trackingNo: 'A3', diffAmount: -10, billedAmount: 90 }),
        l({ trackingNo: 'A4', diffTypes: ['DUPLICATE'], expectedAmount: null, billedAmount: 77, diffAmount: 77 }),
      ]),
    );
    expect(r.lineCount).toBe(2);
    expect(r.total).toBe(107);
    expect(r.body).toContain('A1');
    expect(r.body).toContain('A4');
    expect(r.body).not.toContain('A2');
    expect(r.body).not.toContain('A3');
    expect(r.body).toContain('Toplam talep edilen düzeltme: 107,00 ₺');
  });

  it('durumu verilmeyen eski çağrılar eskisi gibi (VERIFIED + pozitif fark)', () => {
    const r = buildDisputeText(base([l({ status: undefined })]));
    expect(r).toMatchObject({ lineCount: 1, total: 30 });
  });
});

// ---------------------------------------------------------------------------------------------
// PDF: DHL tipi liste fiyatı yapısı (libre başlık, "From | To" ilave ücret tablosu, İngilizce ülke listesi)

const H = 7;
const at = (y: number, cells: [number, string][]): PdfTextItem[] => cells.map(([x, str]) => ({ str, x, y, w: str.length * 3.6, h: H }));
const ZX = [200, 250, 300];
const prow = (y: number, label: string | [number, string][], vals: string[]) =>
  at(y, [...(typeof label === 'string' ? ([[120, label]] as [number, string][]) : label), ...vals.map((v, i) => [ZX[i]! + 2, v] as [number, string])]);

function dhlLikePage(): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  let y = 780;
  const push = (its: PdfTextItem[]) => {
    items.push(...its);
    y -= 10;
  };
  push(at(y, [[100, 'ORNEK EXPRESS WORLDWIDE EXPORT']]));
  push(at(y, [[100, 'Documents up to 2.0 LB']]));
  push(at(y, [[120, 'LB'], [ZX[0]!, 'Zone 1'], [ZX[1]!, 'Zone 2'], [ZX[2]!, 'Zone 3']]));
  push(prow(y, '1.0', ['50.00', '60.00', '70.00']));
  push(prow(y, '2.0', ['55.00', '66.00', '77.00']));
  push(at(y, [[100, 'Non-documents from 1.0 LB & Documents from 3 LB']]));
  push(at(y, [[120, 'LB'], [ZX[0]!, 'Zone 1'], [ZX[1]!, 'Zone 2'], [ZX[2]!, 'Zone 3']]));
  push(prow(y, '1.0', ['51.00', '61.00', '71.00']));
  push(prow(y, '2.0', ['56.00', '67.00', '78.00']));
  push(prow(y, '3.0', ['61.00', '73.00', '85.00']));
  push(prow(y, '10.0', ['96.00', '115.00', '134.00']));
  push(prow(y, '20.0', ['146.00', '175.00', '204.00']));
  push(prow(y, '30.0', ['176.00', '215.00', '1 254.00']));
  push(at(y, [[100, 'Adder rate per additional 1 LB from 3.1 LB']]));
  push(at(y, [[100, 'From'], [140, 'To'], [ZX[0]!, 'Zone 1'], [ZX[1]!, 'Zone 2'], [ZX[2]!, 'Zone 3']]));
  push(prow(y, [[100, '3.1'], [140, '20']], ['5.00', '6.00', '7.00']));
  push(prow(y, [[100, '20.1'], [140, '99 999']], ['3.00', '4.00', '105.00']));
  push(at(y, [[100, 'Rates are in USD and exclude duties and taxes.']]));
  return items;
}

function countriesPage(): PdfTextItem[] {
  const rows: [string, string][] = [
    ['Germany', '1'],
    ['France', '1'],
    ['United Kingdom', '2'],
    ['United States of America', '3'],
    ['Canada', '3'],
    ['Japan', '3'],
  ];
  return [...at(700, [[100, 'Countries & Territories'], [220, 'Zone']]), ...rows.flatMap(([n, z], i) => at(688 - i * 12, [[100, n], [222, z]]))];
}

describe('PDF (kodla): DHL tipi libre tablo + "From | To" ilave ücret tablosu + İngilizce ülke listesi', () => {
  const scan = scanPdfLayout([{ items: countriesPage() }, { items: dhlLikePage() }]);

  it('başlıkları "LB" olan tablolar → belge birimi lb (önceden kg sanılıyordu); başlık lb yazar', () => {
    expect(scan.document.weightUnit).toBe('lb');
    // "Documents up to 2.0 LB" tablosu zarf/doküman olarak alınmaz; koli tablosu tek bölüm
    expect(scan.sections).toHaveLength(1);
    expect(scan.sections[0]!.title).toContain('1–30 lb');
  });

  it('ilave ücret tablosu kendi bölümü olmaz; açık satırlar arasındaki boşluklara ve son satırın üstüne (aşım) "İlave 1" satırı olarak işlenir', () => {
    const rows = scan.sections[0]!.table.rows;
    expect(rows.map((r) => [r.kind, r.weight ?? r.step, r.cells.join(' ')])).toEqual([
      ['weight', 1, '51.00 61.00 71.00'],
      ['weight', 2, '56.00 67.00 78.00'],
      ['weight', 3, '61.00 73.00 85.00'],
      ['additional', 1, '5.00 6.00 7.00'],
      ['weight', 10, '96.00 115.00 134.00'],
      ['additional', 1, '5.00 6.00 7.00'],
      ['weight', 20, '146.00 175.00 204.00'],
      ['additional', 1, '3.00 4.00 105.00'],
      ['weight', 30, '176.00 215.00 1 254.00'],
      // "20.1 – 99 999" bandı son satırın (30 lb) üstünü de kapsar → aşım
      ['additional', 1, '3.00 4.00 105.00'],
    ]);
    expect(scan.sections[0]!.hasAdditionalStep).toBe(true);
  });

  it('içe aktarma ara ağırlıkları üretir ve açık satırlarla tutarlı (uyumsuzluk yok)', () => {
    const t = scan.sections[0]!.table;
    const sheet = [
      ['Weight (lb)', ...t.zones],
      ...t.rows.map((r) => [r.kind === 'additional' ? `Additional ${r.step} lb` : String(r.weight), ...r.cells]),
    ];
    const p = parseTariffImport({ fileName: 'dhl.pdf', kind: 'pdf', prices: sheet, zones: null, surcharges: null });
    expect(p.stepMismatches).toEqual([]);
    expect(p.rates.find((r) => r.zone === '1' && r.weightUpto === 7)?.price).toBe(81);
    expect(p.rates.find((r) => r.zone === '3' && r.weightUpto === 25)?.price).toBe(729);
    expect(p.detectedWeightUnit).toBe('lb');
    // son satırın üstündeki bant aşım fiyatı olur (önceden 30 lb üstü "Tarife yok" kalıyordu)
    expect(p.stepIssues).toEqual([]);
    expect(p.overflow).toEqual([
      { zone: '1', perUnit: 3 },
      { zone: '2', perUnit: 4 },
      { zone: '3', perUnit: 105 },
    ]);
    expect(p.overflowStep).toBe(1);
    // lb → kg: aşım lb başına kalır, birimi 1 lb'nin kg karşılığı (01-B5; eskiden kg başına 6,61 ve 1 kg birim)
    const kg = parseTariffImport({ fileName: 'dhl.pdf', kind: 'pdf', prices: sheet, zones: null, surcharges: null }, { convertLbToKg: true });
    expect(kg.overflow[0]).toEqual({ zone: '1', perUnit: 3 });
    expect(kg.overflowStep).toBe(0.45359237);
  });

  it('"Countries & Territories | Zone" başlıklı İngilizce ülke listesi okunur', () => {
    expect(scan.countries.map((c) => `${c.name}=${c.zone}`)).toEqual([
      'Germany=1',
      'France=1',
      'United Kingdom=2',
      'United States of America=3',
      'Canada=3',
      'Japan=3',
    ]);
    expect(scan.document.countryZonePages).toEqual([1]);
  });
});
