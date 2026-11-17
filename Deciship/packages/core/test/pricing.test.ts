import { describe, expect, it } from 'vitest';
import {
  billedFreight,
  billedPricingKg,
  combineAdjustment,
  compareLine,
  expectedCharge,
  invoiceFuelPct,
  tariffHealth,
  type FxRate,
  type HealthLineInput,
  type TariffInput,
} from '../src/index';
import { TOL, line, meas } from './fixtures';

/** SPEC §3.8–3.9: faturadaki fiyatla ölçekleme, güven, ülke istisnası, tarife uyumu. Sayılar uydurma. */

/** USD tarife, 0,5 kg basamak, %5 yakıt; T bölgesi = ES, U bölgesi = US. */
const USD: TariffInput = {
  id: 'usd',
  currency: 'USD',
  divisor: 5000,
  edgeRounding: 'CEIL_CM',
  weightSteps: [{ upto: null, step: 0.5 }],
  discountPct: 0,
  fuelPct: 5,
  zones: { ES: 'T', US: 'U' },
  rates: [
    { zone: 'T', weightUpto: 1, price: 10 },
    { zone: 'T', weightUpto: 2, price: 20 },
    { zone: 'T', weightUpto: 2.5, price: 22 },
    { zone: 'T', weightUpto: 3, price: 25 },
    { zone: 'U', weightUpto: 2, price: 30 },
    { zone: 'U', weightUpto: 3, price: 40 },
  ],
  surcharges: [],
};
const RATE: FxRate = { base: 'USD', quote: 'TRY', rate: 40, date: '2026-10-14', source: 'TCMB' };
const fx = { date: '2026-10-14', rate: RATE };
const run = (l: ReturnType<typeof line>, m = meas(30, 25, 10, 2), tariff: TariffInput = USD) =>
  compareLine({ line: l, measurement: m, tariff, tol: { ...TOL, fxTolerancePct: 1.5 }, isDuplicate: false, fx });

/** ES, faturada 40×30×12 cm (hacimsel 2,88 → 3 kg), gerçek 2,2 kg; bizim ölçüm 30×25×10, 2 kg → 2 kg. */
const esLine = (p: { base: number; discount: number; fuel?: number; extra?: number }) =>
  line({
    trackingNo: 'ES1',
    destCountry: 'ES',
    actualKg: 2.2,
    dims: { l: 40, w: 30, h: 12 },
    baseAmount: p.base,
    discountAmount: p.discount,
    fuelAmount: p.fuel,
    surcharges: p.extra ? [{ code: 'DEMAND', name: 'Demand Surcharge', amount: p.extra }] : [],
    netAmount: p.base - p.discount + (p.fuel ?? 0) + (p.extra ?? 0),
    currency: 'TRY',
  });

describe('faturadaki fiyatla ölçekleme (SPEC §3.8)', () => {
  it('fatura ücretli kg: max(faturadaki kg, faturadaki ölçülerin hacimsel ağırlığı), basamaklı', () => {
    expect(billedPricingKg(esLine({ base: 1000, discount: 200 }), USD)).toBe(3);
    expect(billedPricingKg(line({ trackingNo: 'x', netAmount: 1, billedKg: 2.8, dims: { l: 31, w: 31, h: 14 } }), USD)).toBe(3);
    expect(billedPricingKg(line({ trackingNo: 'x', netAmount: 1 }), USD)).toBeNull();
    // faturadaki ücretli kg taşıyıcının kendi (inçle) hacim hesabını içerir: inç→cm ölçülerden yeniden hesaplanmaz
    // (48,3×33×30,5 kenar yuvarlamasıyla 10,03 → 10,5 olurdu; taşıyıcı 9,7 → 10 fiyatladı)
    expect(billedPricingKg(line({ trackingNo: 'x', netAmount: 1, billedKg: 9.7, dims: { l: 48.3, w: 33, h: 30.5 } }), USD)).toBe(10);
    // ücretli kg sütunu açıkça gerçek ağırlıksa (hacim %2'den fazla büyük) hacimsel ağırlık
    expect(billedPricingKg(line({ trackingNo: 'x', netAmount: 1, billedKg: 2, dims: { l: 40, w: 30, h: 20 } }), USD)).toBe(5);
  });

  it('taşıma bedeli: liste − indirim; yakıt yoksa kalan; ikisi de yoksa net − ek ücretler (birlikte)', () => {
    expect(billedFreight(esLine({ base: 1000, discount: 200, fuel: 40, extra: 50 }))).toEqual({ mode: 'split', freight: 800, fuel: 40 });
    expect(billedFreight(line({ trackingNo: 'x', netAmount: 890, baseAmount: 1000, discountAmount: 200, surcharges: [{ code: 'A', name: 'A', amount: 50 }] }))).toEqual({
      mode: 'split',
      freight: 800,
      fuel: 40,
    });
    expect(billedFreight(line({ trackingNo: 'x', netAmount: 890, fuelAmount: 40, surcharges: [{ code: 'A', name: 'A', amount: 50 }] }))).toEqual({
      mode: 'split',
      freight: 800,
      fuel: 40,
    });
    expect(billedFreight(line({ trackingNo: 'x', netAmount: 890, surcharges: [{ code: 'A', name: 'A', amount: 50 }] }))).toEqual({ mode: 'combined', freight: 840, fuel: null });
  });

  it('taşıyıcı tarifeden ucuz + ölçü farkı: beklenen = faturadaki fiyat × tarife(2 kg)/tarife(3 kg); pozitif fark', () => {
    // tarife 3 kg = 25 USD × 40 = 1.000 ₺; taşıyıcı 800 ₺ (−%20). Ölçekli taşıma 800 × 20/25 = 640, yakıt 40 × 0,8 = 32
    const r = run(esLine({ base: 1000, discount: 200, fuel: 40, extra: 50 }));
    expect(r).toMatchObject({
      status: 'DIFF',
      diffTypes: ['DIMENSION'],
      pricingBasis: 'INVOICE',
      rateDeviationPct: -20,
      confidence: 'HIGH',
      expectedAmount: 722, // 640 + 32 + 50 (tarifede olmayan, faturadaki tutarıyla)
      diffAmount: 168,
    });
    expect(r.breakdown[0]).toMatchObject({ amount: 640, currency: 'TRY' });
    expect(r.breakdown[0]!.label).toBe('Taşıma — faturadaki fiyatla: 800,00 ₺ × 20,00/25,00 (2,0 kg / 3,0 kg)');
    expect(r.breakdown[1]).toMatchObject({ amount: 32 });
    const info = r.breakdown.find((b) => b.info)!;
    expect(info.amount).toBe(840); // tarifeye göre olurdu: 21 USD × 40
    expect(info.fx).toBeTruthy();
    expect(r.rate).toMatchObject({ zone: 'T', kg: 3, mode: 'split', billedFreight: 800, contractFreight: 1000 });
    // eskisi gibi yalnız tarifeyle beklenen 840 + 50 = 890 olur, fark 0 çıkardı (ölçü fazlası görünmezdi)
  });

  it('taşıyıcı tarifeden pahalı: beklenen sözleşme tarifesi (düşük olanı)', () => {
    // tarife 3 kg 1.000 ₺, taşıyıcı 1.100 ₺ (+%10) → beklenen tarife: 2 kg 20 USD + %5 yakıt = 21 × 40 = 840
    const r = run(esLine({ base: 1100, discount: 0, fuel: 55 }));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DIMENSION'], pricingBasis: 'TARIFF', rateDeviationPct: 10, expectedAmount: 840, diffAmount: 315 });
  });

  it('aynı kg, taşıyıcı pahalı → PRICE (sözleşmeye göre fazla ücret); ucuz → lehimize, tarife dayanağı', () => {
    const at = (net: number) => run(line({ trackingNo: 'U1', destCountry: 'US', billedKg: 2, netAmount: net, currency: 'TRY' }), meas(20, 20, 10, 2));
    // tarife 2 kg 30 + 1,5 yakıt = 31,5 USD × 40 = 1.260
    expect(at(1400)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], pricingBasis: 'TARIFF', confidence: 'HIGH' });
    expect(at(1400).rateDeviationPct).toBeCloseTo(11.11, 2);
    expect(at(1100)).toMatchObject({ status: 'MATCH', pricingBasis: 'TARIFF', diffAmount: -160, note: 'Lehimize fark' });
    // kur farkı (%1) tolerans içinde: uyumlu, kur notu
    expect(at(1272.6)).toMatchObject({ status: 'MATCH', note: 'Kur farkı tolerans içinde (%1,5)' });
  });

  it('faturada ağırlık/ölçü yok → tarife dayanağı, tahmini (LOW)', () => {
    const r = run(line({ trackingNo: 'N1', destCountry: 'US', netAmount: 1400, currency: 'TRY' }), meas(20, 20, 10, 2));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], pricingBasis: 'TARIFF', confidence: 'LOW', rateDeviationPct: null });
    expect(r.confidenceReason).toBe('Faturada ücretli ağırlık yok; beklenen yalnız tarifeden');
  });

  it('tarifede faturadaki kg için fiyat yok → LOW', () => {
    const r = run(line({ trackingNo: 'N2', destCountry: 'US', billedKg: 5, netAmount: 2000, currency: 'TRY' }), meas(20, 20, 10, 2));
    expect(r.confidence).toBe('LOW');
    expect(r.confidenceReason).toContain('5,0 kg');
  });

  it('aşırı sapma (> %35) → LOW: farklı hizmet/bölge olabilir', () => {
    const r = run(esLine({ base: 500, discount: 0, fuel: 25 }));
    expect(r.rateDeviationPct).toBe(-50);
    expect(r).toMatchObject({ confidence: 'LOW', pricingBasis: 'INVOICE' });
    expect(r.confidenceReason).toContain('hizmet ya da bölge');
  });

  it('ölçümü olmayan satırda da fiyat sapması hesaplanır (rapor için)', () => {
    const r = compareLine({ line: esLine({ base: 1000, discount: 200, fuel: 40 }), measurement: null, tariff: USD, tol: TOL, isDuplicate: false, fx });
    expect(r).toMatchObject({ status: 'UNMATCHED', rateDeviationPct: -20, pricingBasis: null, rate: { zone: 'T', kg: 3 } });
  });

  it('aynı para birimi, ayrım yok (birlikte): taşıma + yakıt birlikte ölçeklenir', () => {
    const TRY: TariffInput = { ...USD, currency: 'TRY', fuelPct: 0, rates: USD.rates.map((r) => ({ ...r, price: r.price * 100 })) };
    // tarife 3 kg = 2.500, taşıyıcı 2.000 (−%20) → 2 kg: 2.000 × 2.000/2.500 = 1.600
    const r = compareLine({ line: line({ trackingNo: 'C1', destCountry: 'ES', billedKg: 3, netAmount: 2000 }), measurement: meas(20, 20, 10, 2), tariff: TRY, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ pricingBasis: 'INVOICE', diffTypes: ['WEIGHT'], expectedAmount: 1600, diffAmount: 400, rateDeviationPct: -20 });
    expect(r.breakdown[0]!.label).toBe('Taşıma + yakıt — faturadaki fiyatla: 2.000,00 ₺ × 2.000,00/2.500,00 (2,0 kg / 3,0 kg)');
  });
});

describe('ülke istisnası', () => {
  const ADJ: TariffInput = { ...USD, countryAdjustments: [{ country: 'es', pct: -15.45, source: 'manual' }] };
  it('varış ülkesinin taşıma bedeline uygulanır; yakıt istisnalı tutar üstünden', () => {
    const r = expectedCharge({ tariff: ADJ, chargeableKg: 2, destCountry: 'ES' });
    if (!r.ok) throw new Error(r.reason);
    // 20 − %15,45 = 20 − 3,09 = 16,91; yakıt %5 = 0,85
    expect(r).toMatchObject({ base: 20, adjustment: -3.09, adjustmentPct: -15.45, freight: 16.91, fuel: 0.85, total: 17.76 });
    expect(r.lines.map((l) => l.label)).toContain('İspanya istisnası −%15,45');
    const us = expectedCharge({ tariff: ADJ, chargeableKg: 2, destCountry: 'US' });
    expect(us.ok && us.adjustment).toBe(0);
  });

  it('istisna uygulanınca taşıyıcının ülke fiyatı tarifeyle uyumlu çıkar', () => {
    const tariff: TariffInput = { ...USD, countryAdjustments: [{ country: 'ES', pct: -20, source: 'invoice', invoiceId: 'inv' }] };
    const r = compareLine({ line: esLine({ base: 1000, discount: 200, fuel: 40 }), measurement: null, tariff, tol: TOL, isDuplicate: false, fx });
    expect(r.rateDeviationPct).toBe(0);
    expect(r.rate?.adjustmentPct).toBe(-20);
  });

  it('toplam istisna = (1 + mevcut)(1 + sapma) − 1', () => {
    expect(combineAdjustment(0, -15)).toBe(-15);
    expect(combineAdjustment(-10, -10)).toBe(-19);
  });
});

describe('tarife uyumu raporu (SPEC §3.9)', () => {
  const L = (country: string, dev: number | null, n = 1, extra: Partial<HealthLineInput> = {}): HealthLineInput[] =>
    Array.from({ length: n }, () => ({ destCountry: country, service: 'Intl Priority', zone: country === 'ES' ? 'T' : 'U', rateDeviationPct: dev, fx: true, ...extra }));

  it('ülke + bölge + hizmet gruplar; ucuz grup önerili, uyumlular sayılır, kur kaynaklı tekdüze sapma notu', () => {
    const rep = tariffHealth([...L('ES', -15.2, 2), ...L('ES', -14.8, 2), ...L('US', 1, 6), ...L('DE', 0.9, 4), ...L('IT', null, 3)], { fxTolerancePct: 1.5, carrierName: 'FedEx' });
    expect(rep).toMatchObject({ checkedLines: 14, okLines: 10, skippedLines: 3, okTolerancePct: 1.5 });
    const es = rep.groups[0]!;
    expect(es).toMatchObject({ country: 'ES', countryName: 'İspanya', lines: 4, status: 'cheaper', medianDeviationPct: -15, suggestedAdjustmentPct: -15, weak: false, suspect: false });
    expect(es.message).toBe('İspanya (4 satır): FedEx tarifenizden %15 düşük fiyat uyguluyor — ayrı bir anlaşma olabilir.');
    expect(rep.groups.slice(1).every((g) => g.status === 'ok')).toBe(true);
    // 14 satırın 10'u ~%0,9 yüksek → kur kaynağı farkı notu
    expect(rep.overallNote).toContain('kur farkı');
    expect(rep.overallNote).toContain('Kur toleransı (%1,5) bu farkı karşılar');
  });

  it('sapma yoksa ya da dağınıksa genel not yok', () => {
    expect(tariffHealth(L('US', 0, 6)).overallNote).toBeNull();
    expect(tariffHealth([...L('US', 1, 3), ...L('ES', -15, 3)]).overallNote).toBeNull();
  });

  it('pahalı grup itiraz diliyle; aşırı sapma öneri vermez; az satır zayıf', () => {
    const rep = tariffHealth([...L('DE', 8, 3, { fx: false }), ...L('FR', -60, 5, { fx: false }), ...L('NL', -5, 1, { fx: false })], { carrierName: 'UPS' });
    const de = rep.groups.find((g) => g.country === 'DE')!;
    expect(de).toMatchObject({ status: 'pricier', suggestedAdjustmentPct: 8 });
    expect(de.message).toContain('itiraz');
    const fr = rep.groups.find((g) => g.country === 'FR')!;
    expect(fr).toMatchObject({ status: 'cheaper', suspect: true, suggestedAdjustmentPct: null });
    expect(rep.groups.find((g) => g.country === 'NL')).toMatchObject({ weak: true, suggestedAdjustmentPct: -5 });
    expect(rep.okTolerancePct).toBe(1);
  });

  it('faturadaki yakıt oranı tarifedekinden farklıysa yakıt notu', () => {
    const rep = tariffHealth(L('US', 0.5, 4, { fuelPct: 5.33 }), { tariffFuelPct: 5, carrierName: 'FedEx' });
    expect(rep.invoiceFuelPct).toBe(5.33);
    expect(rep.fuelNote).toContain('Faturada yakıt oranı %5,33, tarifenizde %5');
    expect(tariffHealth(L('US', 0.5, 4, { fuelPct: 5.02 }), { tariffFuelPct: 5 }).fuelNote).toBeNull();
    expect(invoiceFuelPct(esLine({ base: 1000, discount: 200, fuel: 40 }))).toBe(5);
    expect(invoiceFuelPct(esLine({ base: 1000, discount: 200 }))).toBeNull();
  });

  it('mevcut istisna varken öneri toplam yüzdedir', () => {
    const rep = tariffHealth(L('ES', -2, 4, { adjustmentPct: -15, fx: false }));
    expect(rep.groups[0]).toMatchObject({ status: 'cheaper', currentAdjustmentPct: -15, suggestedAdjustmentPct: -16.7 });
  });
});
