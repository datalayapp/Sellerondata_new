/**
 * Gerçek faturalarla denemeden önce para doğruluğu (DENETIM-2):
 * - 01-B11: eksi tutarlı (iade / düzeltme) satır tarifeyle karşılaştırılıyor, "Uyumlu, lehimize fark" görünüyor ve
 *   faturanın "Beklenen" toplamını şişiriyordu.
 * - K39 (kullanıcı kararı 2026-11-13, eski Y32): tarifenin hizmeti "IE" iken satırın hizmeti boşsa fark kesin kalıyordu.
 * - 01-B13: sabit yakıtlı tarifede taşıyıcı yakıtı ek ücrete de uygulayınca sahte kesin "Fiyat farkı" çıkıyordu.
 * - Y21: tam lb'ye denk gelen kg basamakları (0,454 · 0,907 …) kg tarifesinde de lb basamağı sayılıyordu.
 * Tutarlar elle hesaplandı (her blokta açıklaması var).
 */
import { describe, expect, it } from 'vitest';
import {
  chargeableWeight,
  compareLine,
  expectedCharge,
  lbRatesOf,
  overchargeReconciliation,
  roundUpToStep,
  t,
  type ComparisonResult,
  type TariffInput,
  type WeightStep,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/** 40×30×25 cm, 4,0 kg, bölen 5000 → hacimsel 6,0 kg; FEDEX A bölgesi 6,0 kg beklenen 1.184,00 (SPEC §3.2). */
const M6 = meas(40, 30, 25, 4);

/** API `computeTotals` ile aynı toplama: Faturalanan tüm satırlar, Beklenen ve karşılaştırılan yalnız beklenen tutarı olanlar. */
function totals(rs: ComparisonResult[]) {
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const compared = rs.filter((r) => r.expectedAmount != null);
  return {
    billedTotal: sum(rs.map((r) => r.billedAmount)),
    comparedBilledTotal: sum(compared.map((r) => r.billedAmount)),
    expectedTotal: sum(compared.map((r) => r.expectedAmount!)),
  };
}

describe('01-B11: iade / düzeltme satırı (eksi tutar) tarifeyle karşılaştırılmaz', () => {
  const credit = line({ trackingNo: 'IADE1', billedKg: 6, netAmount: -150 });
  const charge = line({ trackingNo: 'IADE1', billedKg: 6, netAmount: 1184 });
  const creditNote = t('tr', 'compare.credit');

  it('ölçümü olan eksi satır: beklenen ve fark boş, "Lehimize fark" değil, not iade satırı', () => {
    // eskiden: MATCH, beklenen 1.184,00, fark −1.334,00, not "Lehimize fark"
    const r = compareLine({ line: credit, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({
      status: 'NO_TARIFF',
      diffTypes: [],
      expectedAmount: null,
      diffAmount: null,
      billedAmount: -150,
      confidence: 'HIGH',
      confidenceReason: null,
      pricingBasis: null,
      rate: null,
      uncheckedSurchargeTotal: 0,
      breakdown: [],
      note: creditNote,
    });
    expect(r.reviewCode).toBeUndefined();
  });

  it('ölçümsüz, tarifesiz ve önceki faturada aynı takip no (mükerrer) olan eksi satır da iade satırıdır, mükerrer değildir', () => {
    for (const r of [
      compareLine({ line: credit, measurement: null, tariff: FEDEX, tol: TOL, isDuplicate: false }),
      compareLine({ line: credit, measurement: M6, tariff: null, tol: TOL, isDuplicate: false }),
      compareLine({ line: credit, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: true, duplicatePrior: { sameCarrier: true, sameAmount: false, invoiceNo: 'F-1', amount: 1184, currency: 'TRY' } }),
    ]) {
      expect(r).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null, billedAmount: -150, confidence: 'HIGH', note: creditNote });
    }
  });

  it('İngilizce not', () => {
    const r = compareLine({ line: credit, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false, locale: 'en' });
    expect(r.note).toBe(t('en', 'compare.credit'));
  });

  it('fatura özeti: iade Faturalanan toplamında kalır, Beklenen ve karşılaştırılan toplama girmez; fazla ödeme değişmez', () => {
    const rs = [
      compareLine({ line: charge, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false }),
      compareLine({ line: credit, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false }),
    ];
    expect(rs[0]).toMatchObject({ status: 'MATCH', expectedAmount: 1184, diffAmount: 0 });
    // eskiden Beklenen 2.368,00 (iade satırı tam tarife bekliyordu), karşılaştırılan Faturalanan 1.034,00
    expect(totals(rs)).toEqual({ billedTotal: 1034, comparedBilledTotal: 1184, expectedTotal: 1184 });
    const recon = overchargeReconciliation(rs.map((r) => ({ ...r, decision: 'OPEN', estimated: r.confidence === 'LOW' })));
    expect(recon.reconciliation).toEqual({ steps: [{ key: 'netDiff', amount: 0, lines: 1 }], overchargeTotal: 0 });
  });

  it('sıfır tutarlı satır (ücretsiz gönderi, kampanya) iade gibi karşılaştırılmaz; kendi notuyla (kullanıcı kararı 2026-11-13)', () => {
    // eskiden: MATCH, beklenen 1.184,00, fark −1.184,00 ("İncele", TARIFF_ONLY): Beklenen toplamını şişiriyordu
    const zero = line({ trackingNo: 'SIFIR', billedKg: 6, netAmount: 0 });
    for (const r of [
      compareLine({ line: zero, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false }),
      compareLine({ line: zero, measurement: null, tariff: FEDEX, tol: TOL, isDuplicate: false }),
      compareLine({ line: zero, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: true, duplicatePrior: { sameCarrier: true, sameAmount: false, invoiceNo: 'F-1', amount: 1184, currency: 'TRY' } }),
    ]) {
      expect(r).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null, billedAmount: 0, confidence: 'HIGH', note: t('tr', 'compare.freeLine') });
      expect(r.reviewCode).toBeUndefined();
    }
    expect(compareLine({ line: zero, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false, locale: 'en' }).note).toBe(t('en', 'compare.freeLine'));
    const rs = [compareLine({ line: charge, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false }), compareLine({ line: zero, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false })];
    // Faturalanan'a 0 ekler; Beklenen ve karşılaştırılana girmez (eskiden Beklenen 2.368,00)
    expect(totals(rs)).toEqual({ billedTotal: 1184, comparedBilledTotal: 1184, expectedTotal: 1184 });
  });
});

describe('K39: tarifenin hizmeti belli, satırın hizmeti boş → fark "İncele"', () => {
  // 30×30×20, 5,6 kg → ücretli 6,0 kg → beklenen 1.184,00. Faturalanan 1.302,40 (%10 pahalı) → fark +118,40, Fiyat farkı.
  const m = meas(30, 30, 20, 5.6);
  const diffLine = (service?: string) => line({ trackingNo: 'K39', billedKg: 6, netAmount: 1302.4, ...(service !== undefined ? { service } : {}) });
  const cmp = (service: string | undefined, tariffService: string | undefined, net?: number) =>
    compareLine({
      line: net != null ? { ...diffLine(service), netAmount: net } : diffLine(service),
      measurement: m,
      tariff: { ...FEDEX, service: tariffService },
      tol: TOL,
      isDuplicate: false,
    });

  it('tarife "IE", satırın hizmeti yok ya da boşluk: fark aynı, güven LOW (SERVICE_MISSING)', () => {
    // eskiden: confidence HIGH (kesin fazla ödeme 118,40)
    for (const s of [undefined, '', '   ']) {
      const r = cmp(s, 'IE');
      expect(r, JSON.stringify(s)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 1184, diffAmount: 118.4, confidence: 'LOW', reviewCode: 'SERVICE_MISSING' });
      expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.serviceMissing', { tariff: 'IE' }));
    }
  });

  it('ağırlık farkı ve ek ücret farkı da "İncele" olur (tutar tarifenin hizmetine bağlı)', () => {
    // faturada 9,5 kg: beklenen bizim 6,0 kg'ımızda 1.184,00; faturalanan 9,5 kg'ın tarife tutarı → ağırlık farkı
    const nine = expectedCharge({ tariff: FEDEX, chargeableKg: 9.5, destCountry: 'FR' });
    if (!nine.ok) throw new Error('fixture');
    const w = compareLine({ line: line({ trackingNo: 'K39W', billedKg: 9.5, netAmount: nine.total }), measurement: m, tariff: { ...FEDEX, service: 'IE' }, tol: TOL, isDuplicate: false });
    expect(w).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 1184, confidence: 'LOW', reviewCode: 'SERVICE_MISSING' });
    // ek elleçleme 285 yerine 300: ek ücret farkı +15,00
    const s = compareLine({
      line: line({ trackingNo: 'K39S', billedKg: 6, netAmount: 1484, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 300 }] }),
      measurement: m,
      tariff: { ...FEDEX, service: 'IE' },
      tol: TOL,
      isDuplicate: false,
    });
    expect(s).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], expectedAmount: 1469, diffAmount: 15, confidence: 'LOW', reviewCode: 'SERVICE_MISSING' });
  });

  it('değişmeyenler: satırın hizmeti yazılı, tarifenin hizmeti boş ya da sınıfsız, uyumlu satır', () => {
    expect(cmp('FedEx International Economy', 'IE')).toMatchObject({ diffAmount: 118.4, confidence: 'HIGH' });
    expect(cmp(undefined, undefined)).toMatchObject({ diffAmount: 118.4, confidence: 'HIGH' });
    expect(cmp(undefined, 'Kargo')).toMatchObject({ diffAmount: 118.4, confidence: 'HIGH' });
    // "Standart" de sınıf sözcüğüdür (yurt içi tarifede de): satırın hizmeti boşsa "İncele"
    expect(cmp(undefined, 'Standart')).toMatchObject({ diffAmount: 118.4, confidence: 'LOW', reviewCode: 'SERVICE_MISSING' });
    const ok = cmp(undefined, 'IE', 1184);
    expect(ok).toMatchObject({ status: 'MATCH', diffAmount: 0, confidence: 'HIGH', confidenceReason: null });
    // hizmeti farklı satır SERVICE kalır (önce gelir)
    expect(cmp('FedEx International Priority', 'IE')).toMatchObject({ confidence: 'LOW', reviewCode: 'SERVICE' });
  });

  it('faturada hiç hizmet adı yoksa (hizmet sütunu yok; yurt içi tablo) kural uygulanmaz: fark kesin', () => {
    for (const service of ['IE', 'Standart']) {
      const r = compareLine({ line: diffLine(undefined), measurement: m, tariff: { ...FEDEX, service }, tol: TOL, isDuplicate: false, invoiceLacksServices: true });
      expect(r, service).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 118.4, confidence: 'HIGH', confidenceReason: null });
    }
  });
});

describe('01-B13: sabit yakıtta taşıyıcı yakıtı ek ücrete de uygularsa fark kesin değil', () => {
  // Liste 1.527,75 − %38 indirim 580,55 = taşıma 947,20; tarifede yakıt %25 yalnız taşımaya: 236,80; ek elleçleme 285.
  // Beklenen 947,20 + 236,80 + 285,00 = 1.469,00. Taşıyıcının yakıtı %25 × (947,20 + 285) = 308,05 → net 1.540,25,
  // fark +71,25 (= %25 × 285).
  const handling = { code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 285 };
  const fuelOnBoth = line({ trackingNo: 'B13', billedKg: 6, baseAmount: 1527.75, discountAmount: 580.55, fuelAmount: 308.05, surcharges: [handling], netAmount: 1540.25 });

  it('fark aynı (+71,25), güven LOW (FUEL_SURCHARGE); gerekçe yakıt fazlasını söyler', () => {
    // eskiden: DIFF [PRICE] +71,25 HIGH (kesin fazla ödeme)
    const r = compareLine({ line: fuelOnBoth, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 1469, diffAmount: 71.25, confidence: 'LOW', reviewCode: 'FUEL_SURCHARGE' });
    expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.fuelSurcharge', { pct: '%25', amount: '71,25 ₺' }));
  });

  it('iki ek ücretten yalnız birine yakıt uygulanmış: yine LOW', () => {
    // uzak bölge 18,50 × 6 kg = 111,00 (tarifeyle aynı); yakıt %25 × (947,20 + 285) = 308,05 → net 1.651,25
    // beklenen 947,20 + 236,80 + 285 + 111 = 1.580,00 → fark +71,25
    const two = line({
      trackingNo: 'B13b',
      billedKg: 6,
      baseAmount: 1527.75,
      discountAmount: 580.55,
      fuelAmount: 308.05,
      surcharges: [handling, { code: 'REMOTE_AREA', name: 'Uzak bölge', amount: 111 }],
      netAmount: 1651.25,
    });
    expect(compareLine({ line: two, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false })).toMatchObject({
      status: 'DIFF',
      diffTypes: ['PRICE'],
      expectedAmount: 1580,
      diffAmount: 71.25,
      confidence: 'LOW',
      reviewCode: 'FUEL_SURCHARGE',
    });
  });

  it('kesin kalanlar: yüksek yakıt oranı yalnız taşımaya, taşıma bedeli pahalı, yakıt doğru', () => {
    // %27 yalnız taşımaya: 255,74 → net 947,20 + 255,74 + 285 = 1.487,94 → fark +18,94 (sözleşmede sabit oran aşıldı)
    const rate27 = line({ trackingNo: 'B13c', billedKg: 6, baseAmount: 1527.75, discountAmount: 580.55, fuelAmount: 255.74, surcharges: [handling], netAmount: 1487.94 });
    expect(compareLine({ line: rate27, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false })).toMatchObject({ diffTypes: ['PRICE'], diffAmount: 18.94, confidence: 'HIGH' });
    // taşıma 992,00 (liste 1.600 − 608), yakıt %25 × 992 = 248,00, ek elleçleme 285 → net 1.525,00 → fark +56,00
    const dear = line({ trackingNo: 'B13d', billedKg: 6, baseAmount: 1600, discountAmount: 608, fuelAmount: 248, surcharges: [handling], netAmount: 1525 });
    expect(compareLine({ line: dear, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false })).toMatchObject({ diffTypes: ['PRICE'], diffAmount: 56, confidence: 'HIGH' });
    // yakıt yalnız taşımaya, tutarlar tarifeyle aynı: uyumlu
    const exact = line({ trackingNo: 'B13e', billedKg: 6, baseAmount: 1527.75, discountAmount: 580.55, fuelAmount: 236.8, surcharges: [handling], netAmount: 1469 });
    expect(compareLine({ line: exact, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false })).toMatchObject({ status: 'MATCH', diffAmount: 0, confidence: 'HIGH' });
  });

  it('değişken yakıtta bugünkü gibi uyumlu (faturadaki oran %32,52 kabul edilir)', () => {
    // 308,05 / 947,20 = %32,52 → beklenen yakıt 947,20 × %32,52 = 308,03 → beklenen 1.540,23, fark +0,02
    const r = compareLine({ line: fuelOnBoth, measurement: M6, tariff: { ...FEDEX, fuelVariable: true }, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: 1540.23, diffAmount: 0.02, confidence: 'HIGH' });
  });
});

describe('İnceleme 2026-11-13 (para): fazla yakıt küçükken kesin ağırlık/fiyat farkı "İncele"ye düşmez', () => {
  // Yalnız fazla yakıt belirsizdir (sözleşme yakıtı ek ücrete uygulamaya izin verebilir); kalan fark kesin kalır,
  // fazla yakıt Beklenen'e faturadaki tutarıyla eklenir (tarifede olmayan ek ücret gibi, farka etkisi yok).
  const fee = { code: 'XYZ_FEE', name: 'Xyz fee', amount: 100 };

  it('ağırlık farkı 461,00 kesin; fazla yakıt 25,00 Beklenen\'e eklenir', () => {
    // ölçüm 6,0 kg, fatura 9,5 kg: liste 2.119,35 − 803,35 = taşıma 1.316,00; tarifede olmayan ücret 100,00;
    // yakıt %25 × (1.316 + 100) = 354,00 → net 1.770,00. Beklenen 1.184,00 + 100,00 = 1.284,00 → fark 486,00;
    // fazla yakıt 354,00 − %25 × 1.316 = 25,00 → Beklenen 1.309,00, kesin fark 461,00
    // (eskiden: fark 486,00 LOW FUEL_SURCHARGE, gerekçe "izin veriyorsa bu fark yoktur")
    const w = line({ trackingNo: 'FS1', billedKg: 9.5, baseAmount: 2119.35, discountAmount: 803.35, fuelAmount: 354, surcharges: [fee], netAmount: 1770 });
    const r = compareLine({ line: w, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 1309, diffAmount: 461, confidence: 'HIGH', confidenceReason: null });
    expect(r.reviewCode).toBeUndefined();
    // inceleme 2: fazla yakıt kendi kalemi; "tarifede olmayan ek ücretler" toplamına girmez (eskiden unchecked, toplam 125,00)
    expect(r.uncheckedSurchargeTotal).toBe(100);
    expect(r.breakdown).toContainEqual({ label: t('tr', 'compare.breakdown.fuelOnSurcharges', { pct: '%25' }), amount: 25, currency: 'TRY' });
    expect(r.note).toContain(t('tr', 'compare.fuelOnSurcharges', { pct: '%25', amount: '25,00 ₺' }));
  });

  it('fiyat farkı 125,00 kesin; fazla yakıt 25,00 ayrılır', () => {
    // 6,0 kg; liste 1.527,75 − 480,55 = taşıma 1.047,20 (tarife 947,20); ücret 100,00; yakıt %25 × 1.147,20 = 286,80
    // → net 1.434,00; Beklenen 1.284,00 → fark 150,00; fazla yakıt 286,80 − 261,80 = 25,00 → kesin fark 125,00
    const p = line({ trackingNo: 'FS2', billedKg: 6, baseAmount: 1527.75, discountAmount: 480.55, fuelAmount: 286.8, surcharges: [fee], netAmount: 1434 });
    const r = compareLine({ line: p, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 1309, diffAmount: 125, confidence: 'HIGH', confidenceReason: null });
  });

  it('inceleme 2: faturadaki fiyatla hesapta fazla yakıt ölçeklenen yakıttan düşülür (iki kez eklenmez)', () => {
    // 9,5 kg fatura, taşıma 1.200,00 (tarifenin 1.314,00'ından ucuz → fatura dayanağı), ücret 100,00, yakıt %25 × 1.300 =
    // 325,00 → net 1.625,00. Oran 1.527,75/2.119,35: taşıma 865,03, yakıt (325 − 25) × oran = 216,26, + 100 + fazla yakıt
    // 25,00 → Beklenen 1.206,29, fark 418,71 (yakıt yalnız taşımaya olsaydı da 418,71; eskiden 400,69)
    const ib = line({ trackingNo: 'FS4', billedKg: 9.5, baseAmount: 2119.35, discountAmount: 919.35, fuelAmount: 325, surcharges: [fee], netAmount: 1625 });
    const r = compareLine({ line: ib, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], pricingBasis: 'INVOICE', expectedAmount: 1206.29, diffAmount: 418.71, confidence: 'HIGH' });
    expect(r.breakdown.find((b) => b.amount === 216.26)?.label).toContain('300,00');
  });

  it('ek ücret fazlası kesin; fiyat farkı yalnız fazla yakıttansa "Fiyat farkı" eklenmez', () => {
    // ek elleçleme tarifede 285, faturada 300 (+15,00); yakıt %25 × (947,20 + 300) = 311,80 → net 1.559,00;
    // Beklenen 1.469,00 → fark 90,00 = 15,00 ek ücret + 75,00 fazla yakıt → kesin fark 15,00 (yalnız SURCHARGE)
    const s = line({ trackingNo: 'FS3', billedKg: 6, baseAmount: 1527.75, discountAmount: 580.55, fuelAmount: 311.8, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 300 }], netAmount: 1559 });
    const r = compareLine({ line: s, measurement: M6, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], expectedAmount: 1544, diffAmount: 15, confidence: 'HIGH' });
  });
});

describe('Y21: kg tarifesinde tam lb\'ye denk gelen basamak (0,454 kg) kg basamağıdır', () => {
  // kg tarifesi: her 0,454 kg bir basamak, satırlar 0,454 kg'ın katları (0,454 · 0,908 … 4,54), n. satır 10 + n; üstü
  // her ilave 0,454 kg 2. Doğrusu kg ızgarası: ⌈g / 454⌉ × 454 g.
  const steps: WeightStep[] = [{ upto: null, step: 0.454 }];
  const rates = Array.from({ length: 10 }, (_, i) => ({ zone: 'A', weightUpto: Math.round((i + 1) * 454) / 1000, price: 11 + i }));
  const KG: TariffInput = {
    ...FEDEX,
    id: 'kg-454',
    discountPct: 0,
    fuelPct: 0,
    weightSteps: steps,
    rates,
    overflowPerUnit: { A: 2 },
    surcharges: [],
  };
  const HAND: [kg: number, why: string, stepped: number, price: number][] = [
    [0.3, '1 basamak', 0.454, 11],
    [0.908, 'tam 2 basamak (eskiden 3 lb = 1,361 → 13)', 0.908, 12],
    [0.909, '3 basamak', 1.362, 13],
    [4.54, 'tam 10 basamak: son satır (eskiden 11 lb = 4,99 → 22)', 4.54, 20],
    [4.541, '11 basamak = 4,994: 1 aşım birimi', 4.994, 22],
    [5, '12 basamak = 5,448: 2 aşım birimi', 5.448, 24],
    [10, '23 basamak = 10,442: 13 aşım birimi', 10.442, 46],
  ];

  it('satırlar kg tarifesini gösterir; lb tarifesinin satırları lb gösterir', () => {
    expect(lbRatesOf(rates)).toBe(false);
    const lbRows = Array.from({ length: 10 }, (_, i) => ({ zone: 'A', weightUpto: Math.round((i + 1) * 453.59237) / 1000, price: 11 + i }));
    expect(lbRows.map((r) => r.weightUpto)).toEqual([0.454, 0.907, 1.361, 1.814, 2.268, 2.722, 3.175, 3.629, 4.082, 4.536]);
    expect(lbRatesOf(lbRows)).toBe(true);
    // kanıt yok: tek satır, yalnız açık bant, kg başı bant
    expect(lbRatesOf([{ weightUpto: 0.454 }])).toBeUndefined();
    expect(lbRatesOf([])).toBeUndefined();
    expect(lbRatesOf([{ weightUpto: 99999, perKg: true }, { weightUpto: 30, perKg: true }])).toBeUndefined();
  });

  it('yuvarlama ve beklenen tutar kg ızgarasıyla (elle doğrulanmış)', () => {
    for (const [kg, why, stepped, price] of HAND) {
      expect(roundUpToStep(kg, steps, rates), `${kg}: ${why}`).toBe(stepped);
      const { chargeable } = chargeableWeight({ dims: { l: 1, w: 1, h: 1 }, actualKg: kg, divisor: 5000, steps, rates });
      expect(chargeable, `${kg}: ${why}`).toBe(stepped);
      expect(expectedCharge({ tariff: KG, chargeableKg: chargeable, destCountry: 'FR' }), `${kg}: ${why}`).toMatchObject({ ok: true, total: price });
    }
  });

  it('karşılaştırma: 0,908 kg koli 12 ile faturalanınca beklenen 12 (eskiden 13, "Lehimize fark")', () => {
    const r = compareLine({
      line: line({ trackingNo: 'Y21', billedKg: 0.908, netAmount: 12 }),
      measurement: meas(1, 1, 1, 0.908),
      tariff: KG,
      tol: { ...TOL, amountTol: 0.1 },
      isDuplicate: false,
    });
    expect(r).toMatchObject({ status: 'MATCH', ourChargeableKg: 0.908, billedChargeableKg: 0.908, expectedAmount: 12, diffAmount: 0 });
    expect(r.note).toBeUndefined();
  });

  it('lb tarifesi değişmez: düzenleyicide 0,454\'e yuvarlanmış basamak lb satırlarıyla lb sayılır, tam değer her zaman lb', () => {
    const lbRows = Array.from({ length: 10 }, (_, i) => ({ zone: 'A', weightUpto: Math.round((i + 1) * 453.59237) / 1000, price: 11 + i }));
    // 0,88 kg = 1,94 lb → 2 lb = 0,907 kg; 0,908 kg = 2,002 lb → 3 lb = 1,361 kg
    expect(roundUpToStep(0.88, steps, lbRows)).toBe(0.907);
    expect(roundUpToStep(0.908, steps, lbRows)).toBe(1.361);
    expect(roundUpToStep(0.908, steps)).toBe(1.361);
    // içe aktarmanın yazdığı tam lb değeri kg satırlarıyla da lb kalır
    expect(roundUpToStep(0.908, [{ upto: null, step: 0.45359237 }], rates)).toBe(1.361);
    // lb satırları 0,68'i (1,5 lb) de lb yapar (Y42 kanıtı); kg satırları yapmaz
    const y42: WeightStep[] = [{ upto: null, step: 0.68 }];
    expect(roundUpToStep(1.0, y42, lbRows)).toBe(1.361); // 2,2 lb → 3 lb
    expect(roundUpToStep(1.0, y42, rates)).toBe(1.36); // ⌈1000 / 680⌉ × 680 g
  });
});
