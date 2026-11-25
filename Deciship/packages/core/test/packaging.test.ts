/**
 * Pak / Zarf (bütün taşıyıcılar): sınırlar, ambalaj tanıma, Pak/Zarf fiyatı ve karşılaştırma kuralları.
 * Fatura okuma `fedex-fbo.test.ts`, itiraz metni `dispute.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACKAGING_LIMITS,
  PAK_NOTE,
  compareLine,
  expectedCharge,
  invoiceLinePackaging,
  isPakNote,
  isPakService,
  localizeComparison,
  overchargeReconciliation,
  packagingFit,
  packagingLabel,
  packagingLimitsFor,
  parsePackaging,
  pricedPackaging,
  servicePackaging,
  suggestPackaging,
  t,
  type CompareLineInput,
  type MeasurementInput,
  type TariffInput,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

const FX = packagingLimitsFor('fedex');

/** FEDEX + A bölgesinde Pak (0,5–2,5 kg) ve Zarf (0,5 kg) fiyatları; Pak indirimi %40, Zarf indirimi tarifeninki (%38). */
const FEDEX_PAK: TariffInput = {
  ...FEDEX,
  rates: [
    ...FEDEX.rates,
    { zone: 'A', weightUpto: 0.5, price: 500, packaging: 'PAK' },
    { zone: 'A', weightUpto: 1, price: 560, packaging: 'PAK' },
    { zone: 'A', weightUpto: 1.5, price: 620, packaging: 'PAK' },
    { zone: 'A', weightUpto: 2, price: 680, packaging: 'PAK' },
    { zone: 'A', weightUpto: 2.5, price: 740, packaging: 'PAK' },
    { zone: 'A', weightUpto: 0.5, price: 300, packaging: 'ENVELOPE' },
  ],
  pakDiscountPct: 40,
  envelopeDiscountPct: null,
};

const own = (kg: number, tariff: TariffInput = FEDEX) => {
  const e = expectedCharge({ tariff, chargeableKg: kg, destCountry: 'FR' });
  if (!e.ok) throw new Error('fixture');
  return e.total;
};

const withPack = (m: MeasurementInput, packaging: MeasurementInput['packaging']): MeasurementInput => ({ ...m, packaging });
const cmp = (p: Partial<CompareLineInput> & Pick<CompareLineInput, 'line' | 'measurement'>) =>
  compareLine({ tariff: FEDEX_PAK, tol: TOL, isDuplicate: false, packagingLimits: FX, carrier: 'fedex', ...p });

/** 30×20×3 cm, 0,8 kg: Pak'a sığar (1.800 cm³), Zarf'a sığmaz (0,5 kg). */
const SMALL = meas(30, 20, 3, 0.8);

describe('sınırlar ve sığma', () => {
  it('varsayılanlar: FedEx Pak 2,5 kg / 15.400 cm³, Zarf 0,5 kg; UPS Zarf 0,5 kg, DHL Zarf 0,3 kg, Pak bilinmiyor; zarf kenarları', () => {
    expect(FX).toEqual({ PAK: { maxKg: 2.5, maxVolumeCm3: 15400 }, ENVELOPE: { maxKg: 0.5, maxEdgesCm: [31.7, 24.1, 2] } });
    expect(packagingLimitsFor('ups')).toEqual({ PAK: null, ENVELOPE: { maxKg: 0.5, maxEdgesCm: [40.6, 31.7, 2] } });
    expect(packagingLimitsFor('dhl')).toEqual({ PAK: null, ENVELOPE: { maxKg: 0.3, maxEdgesCm: [35, 27.5, 1] } });
    expect(packagingLimitsFor('aras')).toEqual({ PAK: null, ENVELOPE: null });
    expect(packagingLimitsFor(null)).toEqual({ PAK: null, ENVELOPE: null });
    expect(DEFAULT_PACKAGING_LIMITS.yurtici).toBeUndefined();
  });

  it('geçersiz kılma ambalaj başına; null = bilinmiyor; geçersiz sayı bilinmiyor', () => {
    expect(packagingLimitsFor('fedex', { PAK: { maxKg: 3 } })).toEqual({ PAK: { maxKg: 3, maxVolumeCm3: null }, ENVELOPE: { maxKg: 0.5, maxEdgesCm: [31.7, 24.1, 2] } });
    expect(packagingLimitsFor('fedex', { ENVELOPE: null })).toEqual({ PAK: { maxKg: 2.5, maxVolumeCm3: 15400 }, ENVELOPE: null });
    expect(packagingLimitsFor('aras', { ENVELOPE: { maxKg: 1 } })).toEqual({ PAK: null, ENVELOPE: { maxKg: 1, maxEdgesCm: null } });
    // kenarlar büyükten küçüğe sıralanır; eksik/geçersiz kenar = kenar sınırı bilinmiyor
    expect(packagingLimitsFor('aras', { ENVELOPE: { maxKg: 1, maxEdgesCm: [2, 40, 30] } }).ENVELOPE).toEqual({ maxKg: 1, maxEdgesCm: [40, 30, 2] });
    expect(packagingLimitsFor('aras', { ENVELOPE: { maxKg: 1, maxEdgesCm: [40, 0, 2] } }).ENVELOPE).toEqual({ maxKg: 1, maxEdgesCm: null });
    expect(packagingLimitsFor('aras', { PAK: { maxKg: -1 } }).PAK).toBeNull();
  });

  it('packagingFit: ağırlık, hacim, sınırda kalan, bilinmeyen sınır', () => {
    expect(packagingFit('OWN', 99, null, null)).toEqual({ ok: true, reasons: [] });
    expect(packagingFit('PAK', 2.5, { l: 35, w: 22, h: 20 }, FX)).toEqual({ ok: true, reasons: [] }); // 15.400 cm³ tam sınır
    expect(packagingFit('PAK', 2.501, null, FX)).toEqual({ ok: false, reasons: ['WEIGHT'] });
    expect(packagingFit('PAK', 3, { l: 40, w: 30, h: 20 }, FX)).toEqual({ ok: false, reasons: ['WEIGHT', 'VOLUME'] });
    // zarf: kenarlar sıralanıp kenar kenar (31,7 × 24,1 × 2 cm); yön önemsiz, sınırda kalan sığar
    expect(packagingFit('ENVELOPE', 0.5, { l: 24.1, w: 2, h: 31.7 }, FX)).toEqual({ ok: true, reasons: [] });
    expect(packagingFit('ENVELOPE', 0.3, { l: 40, w: 30, h: 20 }, FX)).toEqual({ ok: false, reasons: ['DIMENSION'] });
    expect(packagingFit('ENVELOPE', 0.3, { l: 30, w: 22, h: 2.1 }, FX)).toEqual({ ok: false, reasons: ['DIMENSION'] });
    expect(packagingFit('ENVELOPE', 0.6, { l: 40, w: 30, h: 20 }, FX)).toEqual({ ok: false, reasons: ['WEIGHT', 'DIMENSION'] });
    expect(packagingFit('ENVELOPE', 0.3, null, FX)).toEqual({ ok: true, reasons: [] }); // ölçü yok: yalnız ağırlık
    expect(packagingFit('ENVELOPE', 0.3, { l: 40, w: 30, h: 20 }, { ENVELOPE: { maxKg: 0.5 } })).toEqual({ ok: true, reasons: [] }); // kenar sınırı bilinmiyor
    expect(packagingFit('ENVELOPE', 0.51, null, FX).ok).toBe(false);
    expect(packagingFit('PAK', 1, null, packagingLimitsFor('ups'))).toEqual({ ok: null, reasons: [] });
    expect(packagingFit('PAK', 1, null, undefined).ok).toBeNull();
  });

  it('suggestPackaging: önce zarf, sonra Pak; sınırı bilinmeyen önerilmez; zarf yalnız kenarları sığarsa', () => {
    expect(suggestPackaging(0.3, { l: 30, w: 20, h: 2 }, FX)).toBe('ENVELOPE');
    expect(suggestPackaging(0.3, { l: 30, w: 20, h: 10 }, FX)).toBe('PAK'); // 0,5 kg altı büyük koli zarf değil
    expect(suggestPackaging(0.8, SMALL.dims, FX)).toBe('PAK');
    expect(suggestPackaging(3, SMALL.dims, FX)).toBeNull();
    expect(suggestPackaging(0.8, SMALL.dims, packagingLimitsFor('ups'))).toBeNull();
    expect(suggestPackaging(0.3, { l: 34, w: 27, h: 1 }, packagingLimitsFor('dhl'))).toBe('ENVELOPE');
    expect(suggestPackaging(0.3, null, packagingLimitsFor('dhl'))).toBeNull(); // ölçü yok
    expect(suggestPackaging(0.3, { l: 30, w: 20, h: 2 }, { ENVELOPE: { maxKg: 0.5 } })).toBeNull(); // kenar sınırı bilinmiyor
  });

  it('pricedPackaging: zarf → Pak → kendi ambalajı; bilinmeyen sınır aşılmamış sayılır', () => {
    expect(pricedPackaging('ENVELOPE', 0.3, null, FX)).toBe('ENVELOPE');
    expect(pricedPackaging('ENVELOPE', 0.8, null, FX)).toBe('PAK');
    expect(pricedPackaging('ENVELOPE', 3, null, FX)).toBe('OWN');
    expect(pricedPackaging('PAK', 3, null, packagingLimitsFor('ups'))).toBe('PAK');
    expect(pricedPackaging('ENVELOPE', 0.3, null, FX, (p) => p !== 'ENVELOPE')).toBe('PAK');
  });

  it('packagingLabel: taşıyıcıya göre ad, iki dilde', () => {
    expect(packagingLabel('fedex', 'PAK', 'tr')).toBe('FedEx Pak');
    expect(packagingLabel('fedex', 'ENVELOPE', 'tr')).toBe('FedEx Zarf');
    expect(packagingLabel('fedex', 'ENVELOPE', 'en')).toBe('FedEx Envelope');
    expect(packagingLabel('ups', 'PAK', 'tr')).toBe('UPS Express Pak');
    expect(packagingLabel('ups', 'ENVELOPE', 'en')).toBe('UPS Express Envelope');
    expect(packagingLabel('dhl', 'PAK', 'tr')).toBe('DHL Flyer');
    expect(packagingLabel('dhl', 'ENVELOPE', 'en')).toBe('DHL Express Envelope');
    expect(packagingLabel('aras', 'PAK', 'tr')).toBe('Kargo poşeti');
    expect(packagingLabel(null, 'ENVELOPE', 'en')).toBe('Carrier envelope');
    expect(packagingLabel('fedex', 'OWN', 'tr')).toBe('Kendi ambalajı');
    expect(packagingLabel('fedex', 'OWN', 'en')).toBe('Own packaging');
  });
});

describe('ambalaj tanıma', () => {
  it('parsePackaging: FedEx ve UPS kodları, metin', () => {
    expect(['01', '02', '03', '06', '04', '10', '1'].map((c) => parsePackaging(c, 'fedex'))).toEqual(['OWN', 'PAK', 'OWN', 'ENVELOPE', undefined, undefined, 'OWN']);
    // kod tablosu bilinmeyen taşıyıcıda (DHL, Aras…) yalnız sayı olan değer okunmaz; metin genel tanımayla
    expect(['01', '02', '06', '2'].map((c) => parsePackaging(c))).toEqual([undefined, undefined, undefined, undefined]);
    expect(parsePackaging('Flyer')).toBe('PAK');
    expect(['01', '02', '04', '03'].map((c) => parsePackaging(c, 'ups'))).toEqual(['ENVELOPE', 'OWN', 'PAK', undefined]);
    expect(parsePackaging('Your Packaging')).toBe('OWN');
    expect(parsePackaging('YOUR_PACKAGING')).toBe('OWN');
    expect(parsePackaging('Customer Supplied Package')).toBe('OWN');
    expect(parsePackaging('FedEx Box')).toBe('OWN');
    expect(parsePackaging('FedEx 10kg Box')).toBe('OWN');
    expect(parsePackaging('FEDEX_PAK')).toBe('PAK');
    expect(parsePackaging('UPS Express Pak')).toBe('PAK');
    expect(parsePackaging('DHL Flyer')).toBe('PAK');
    expect(parsePackaging('FedEx Envelope')).toBe('ENVELOPE');
    expect(parsePackaging('UPS Letter')).toBe('ENVELOPE');
    expect(parsePackaging('Document')).toBe('ENVELOPE');
    expect(parsePackaging('Zarf')).toBe('ENVELOPE');
    expect(parsePackaging('DOSYA')).toBe('ENVELOPE');
    expect(parsePackaging('Evrak')).toBe('ENVELOPE');
    expect(parsePackaging('Koli')).toBe('OWN');
    expect(parsePackaging('Package')).toBe('OWN');
    expect(parsePackaging('')).toBeUndefined();
    expect(parsePackaging(null)).toBeUndefined();
    expect(parsePackaging('Tube')).toBeUndefined();
  });

  it('servicePackaging / isPakService: hizmet adından yalnız Pak ve Zarf', () => {
    expect(servicePackaging('FedEx Intl Priority Pak')).toBe('PAK');
    expect(servicePackaging('DHL Express Flyer')).toBe('PAK');
    expect(servicePackaging('FedEx Envelope')).toBe('ENVELOPE');
    expect(servicePackaging('UPS Express Letter')).toBe('ENVELOPE');
    expect(servicePackaging('Dosya')).toBe('ENVELOPE');
    expect(servicePackaging('FedEx International Priority')).toBeUndefined();
    expect(servicePackaging('Package')).toBeUndefined();
    expect(servicePackaging('Pakistan Express')).toBeUndefined();
    expect(isPakService('DHL Flyer')).toBe(true);
    expect(isPakService('FedEx International Economy')).toBe(false);
  });

  it('hizmet adında "Documents" ürün türüdür; olumsuzlama ve kutu adı özel ambalaj değildir', () => {
    for (const name of [
      'DHL Express Worldwide Non-Documents',
      'EXPRESS WORLDWIDE NON DOCUMENT',
      'Express Worldwide Non Document',
      'NONDOC',
      'Non-Doc',
      'DHL Express Worldwide Documents',
      'EXPRESS WORLDWIDE DOC',
      'Express Worldwide DOX',
      'Doc Box',
      'UPS Express Saver Document',
      'FedEx Pak Box',
      'Non-Envelope',
    ]) {
      expect({ name, p: servicePackaging(name), pak: isPakService(name) }).toEqual({ name, p: undefined, pak: false });
    }
    expect(servicePackaging('DHL Express Envelope')).toBe('ENVELOPE');
  });

  it('ambalaj sütununda: "Document" zarf; olumsuzlama ve kutu adı kendi ambalajı', () => {
    expect(parsePackaging('Document')).toBe('ENVELOPE');
    expect(parsePackaging('Non-Documents')).toBe('OWN');
    expect(parsePackaging('NONDOC')).toBe('OWN');
    expect(parsePackaging('Doc Box')).toBe('OWN');
    expect(parsePackaging('Document Box')).toBe('OWN');
  });

  it('invoiceLinePackaging: satırın ambalajı, yoksa hizmet adından', () => {
    expect(invoiceLinePackaging({ packaging: 'OWN', service: 'FedEx Intl Priority Pak' })).toBe('OWN');
    expect(invoiceLinePackaging({ service: 'FedEx Intl Priority Pak' })).toBe('PAK');
    expect(invoiceLinePackaging({ service: 'FedEx International Priority' })).toBeUndefined();
  });
});

describe('Pak/Zarf fiyatı (expectedCharge)', () => {
  it('Pak satırları ve Pak indirimi: 560 − %40 + yakıt %25 = 420', () => {
    const e = expectedCharge({ tariff: FEDEX_PAK, chargeableKg: 1, destCountry: 'FR', packaging: 'PAK' });
    expect(e).toMatchObject({ ok: true, zone: 'A', base: 560, discount: 224, freight: 336, fuel: 84, total: 420, packaging: 'PAK' });
    expect(e.ok && e.lines.map((l) => l.label)).toEqual(['Pak fiyatı (Bölge A, 1,0 kg)', 'İndirim %40', 'Yakıt %25']);
  });

  it('Zarf indirimi yoksa tarifenin indirimi: 300 − %38 + %25 = 232,50', () => {
    expect(expectedCharge({ tariff: FEDEX_PAK, chargeableKg: 0.5, destCountry: 'FR', packaging: 'ENVELOPE' })).toMatchObject({ ok: true, total: 232.5, packaging: 'ENVELOPE' });
  });

  it('kendi ambalajı Pak satırlarından etkilenmez (kuruşu kuruşuna aynı)', () => {
    for (const kg of [0.5, 1, 2.5, 6, 31]) {
      expect(expectedCharge({ tariff: FEDEX_PAK, chargeableKg: kg, destCountry: 'FR' })).toEqual(expectedCharge({ tariff: FEDEX, chargeableKg: kg, destCountry: 'FR' }));
      expect(expectedCharge({ tariff: FEDEX_PAK, chargeableKg: kg, destCountry: 'FR', packaging: 'OWN' })).toEqual(expectedCharge({ tariff: FEDEX, chargeableKg: kg, destCountry: 'FR' }));
    }
  });

  it('tarifede Pak yoksa ok:false + noPackagingRates; bölgede yoksa bölgeyi söyler; taşma yok', () => {
    expect(expectedCharge({ tariff: FEDEX, chargeableKg: 1, destCountry: 'FR', packaging: 'PAK' })).toEqual({ ok: false, reason: 'Tarifede Pak fiyatı yok', noPackagingRates: 'PAK' });
    expect(expectedCharge({ tariff: FEDEX_PAK, chargeableKg: 1, destCountry: 'GB', packaging: 'PAK' })).toEqual({ ok: false, reason: 'Tarifede B bölgesi için Pak fiyatı yok' });
    const over = expectedCharge({ tariff: FEDEX_PAK, chargeableKg: 3, destCountry: 'FR', packaging: 'PAK' });
    expect(over.ok).toBe(false);
  });

  it('ülke istisnası yalnız kendi ambalajı fiyatına', () => {
    const adj: TariffInput = { ...FEDEX_PAK, countryAdjustments: [{ country: 'FR', pct: -10, source: 'manual' }] };
    expect(expectedCharge({ tariff: adj, chargeableKg: 1, destCountry: 'FR', packaging: 'PAK' })).toMatchObject({ ok: true, total: 420, adjustment: 0 });
    expect(expectedCharge({ tariff: adj, chargeableKg: 1, destCountry: 'FR' })).toMatchObject({ ok: true, adjustmentPct: -10 });
  });
});

describe('karşılaştırma: ölçüm Pak/Zarf, fatura kendi ambalajı', () => {
  /** Faturada kendi ambalajı (FedEx "01"), 1,0 kg kendi ambalajı fiyatı. */
  const ownLine = line({ trackingNo: 'P1', billedKg: 1, packaging: 'OWN', netAmount: own(1) });

  it('sınır içinde → PACKAGING, kesin; beklenen Pak fiyatı, tek fark', () => {
    const r = cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK') });
    expect(own(1)).toBe(561.51);
    expect(r).toMatchObject({
      status: 'DIFF',
      diffTypes: ['PACKAGING'],
      confidence: 'HIGH',
      expectedAmount: 420,
      diffAmount: 141.51,
      ourChargeableKg: 1,
      billedChargeableKg: 1,
      pricedPackaging: 'PAK',
      pricingBasis: 'TARIFF',
    });
    expect(r.reviewCode).toBeUndefined();
    expect(r.note).toBe('FedEx Pak ile gönderildi (sınır içinde) · Faturada kendi ambalajı olarak fiyatlanmış; beklenen FedEx Pak fiyatı');
    expect(r.breakdown.map((b) => b.label)).toEqual(['Pak fiyatı (Bölge A, 1,0 kg)', 'İndirim %40', 'Yakıt %25']);
    // tarife uyumu: faturanın kendi ambalajı fiyatı ↔ tarifenin kendi ambalajı fiyatı
    expect(r.rate).toMatchObject({ zone: 'A', kg: 1, contractFreight: 561.51 });
    expect(r.rateDeviationPct).toBe(0);
  });

  it('faturadaki ağırlık (desi) farkı ayrıca sayılmaz: PACKAGING tutarın tamamı', () => {
    // kendi ambalajı 3,0 kg (hacimsel) fiyatlanmış; Pak fiyatı bizim 1,0 kg'ımızda
    const r = cmp({ line: line({ trackingNo: 'P2', billedKg: 3, packaging: 'OWN', netAmount: own(3) }), measurement: withPack(SMALL, 'PAK') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'HIGH', expectedAmount: 420, billedChargeableKg: 3, ourChargeableKg: 1 });
    expect(r.diffAmount).toBe(Math.round((own(3) - 420) * 100) / 100);
  });

  it('ek ücret fazlası yanında: SURCHARGE + PACKAGING, para bir kez', () => {
    const l = line({ trackingNo: 'P3', billedKg: 1, packaging: 'OWN', netAmount: 561.51 + 385, surcharges: [{ code: 'ADDITIONAL_HANDLING', amount: 385 }] });
    const r = cmp({ line: l, measurement: withPack(SMALL, 'PAK') });
    expect(r).toMatchObject({ diffTypes: ['SURCHARGE', 'PACKAGING'], confidence: 'HIGH', expectedAmount: 705, diffAmount: 241.51 });
  });

  it('sınır bilinmiyor → "İncele" PACKAGING_LIMIT_UNKNOWN (tutar aynı)', () => {
    for (const p of [{ packagingLimits: packagingLimitsFor('ups') }, { packagingLimits: undefined }]) {
      const r = cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK'), ...p });
      expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_LIMIT_UNKNOWN', expectedAmount: 420, diffAmount: 141.51 });
    }
    const ups = cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK'), packagingLimits: packagingLimitsFor('ups'), carrier: 'ups' });
    expect(ups.note).toContain('UPS Express Pak ile gönderildi');
    expect(ups.confidenceReason).toContain('UPS Express Pak sınırı bilinmiyor');
  });

  it('faturada ambalaj bilgisi yok → "İncele" PACKAGING_UNKNOWN; tutar Pak fiyatındaysa uyumlu', () => {
    const r = cmp({ line: line({ trackingNo: 'P4', billedKg: 1, netAmount: own(1) }), measurement: withPack(SMALL, 'PAK') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_UNKNOWN', expectedAmount: 420 });
    expect(r.note).toBe('FedEx Pak ile gönderildi (sınır içinde)');
    const ok = cmp({ line: line({ trackingNo: 'P5', billedKg: 1, netAmount: 420 }), measurement: withPack(SMALL, 'PAK') });
    expect(ok).toMatchObject({ status: 'MATCH', diffTypes: [], confidence: 'HIGH' });
    expect(ok.note).toContain('Faturadaki tutar bu ambalajın fiyatını aşmıyor');
  });

  it('sınıra yakın ağırlık: toleransla ya da faturadaki gerçek kg ile sınır aşılıyor → "İncele" PACKAGING_NEAR_LIMIT', () => {
    // bizim 2,45 kg (+0,1 tolerans = 2,55 > 2,5); faturada gerçek 2,55 kg, kendi ambalajı 3 kg fiyatı
    const l = line({ trackingNo: 'N1', billedKg: 3, actualKg: 2.55, packaging: 'OWN', netAmount: own(3) });
    const r = cmp({ line: l, measurement: withPack(meas(30, 20, 5, 2.45), 'PAK') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_NEAR_LIMIT', expectedAmount: 555 });
    // faturada gerçek kg yok, bizim ağırlığımız toleransla da sınır içinde: kesin
    const okLine = line({ trackingNo: 'N2', billedKg: 3, packaging: 'OWN', netAmount: own(3) });
    expect(cmp({ line: okLine, measurement: withPack(meas(30, 20, 5, 2.3), 'PAK') })).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'HIGH' });
    // faturadaki gerçek kg sınırı aşıyor (bizimki rahat)
    const billedHeavy = line({ trackingNo: 'N3', billedKg: 3, actualKg: 2.6, packaging: 'OWN', netAmount: own(3) });
    expect(cmp({ line: billedHeavy, measurement: withPack(meas(30, 20, 5, 2), 'PAK') })).toMatchObject({ confidence: 'LOW', reviewCode: 'PACKAGING_NEAR_LIMIT' });
  });

  it('sınıra yakın hacim: toleransla ya da faturadaki ölçüyle hacim aşılıyor → "İncele"', () => {
    // bizim 40×30×12,8 = 15.360 cm³ (sınır içinde); faturada 40,5×30,5×13 = 16.058 cm³
    const tol = { ...TOL, edgeTolCm: 0.5 };
    const l = line({ trackingNo: 'N4', billedKg: 5, dims: { l: 40.5, w: 30.5, h: 13 }, packaging: 'OWN', netAmount: own(5) });
    const r = cmp({ line: l, measurement: withPack(meas(40, 30, 12.8, 1), 'PAK'), tol });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_NEAR_LIMIT', expectedAmount: 420 });
    // payla da sığan küçük paket ve faturadaki ölçü sınır içinde: kesin
    const small = line({ trackingNo: 'N5', billedKg: 1, dims: { l: 31, w: 21, h: 4 }, packaging: 'OWN', netAmount: own(1) });
    expect(cmp({ line: small, measurement: withPack(SMALL, 'PAK'), tol })).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'HIGH' });
  });

  it('Pak fiyatında ağırlık Pak satırına yuvarlanır (kendi ambalajı basamağı değil)', () => {
    // kendi ambalajı basamağı 1 kg: 0,4 kg Pak 0,5 kg satırından (500), 1 kg satırından (560) değil
    const coarse: TariffInput = { ...FEDEX_PAK, weightSteps: [{ upto: null, step: 1 }] };
    const l = line({ trackingNo: 'R1', billedKg: 1, packaging: 'OWN', netAmount: own(1, coarse) });
    const r = cmp({ line: l, measurement: withPack(meas(30, 20, 3, 0.4), 'PAK'), tariff: coarse });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], expectedAmount: 375, ourChargeableKg: 0.5, pricedPackaging: 'PAK' });
    const pak = cmp({ line: line({ trackingNo: 'R2', packaging: 'PAK', billedKg: 0.45, netAmount: 375 }), measurement: meas(30, 20, 3, 0.4), tariff: coarse });
    expect(pak).toMatchObject({ status: 'MATCH', expectedAmount: 375, ourChargeableKg: 0.5, billedChargeableKg: 0.5 });
  });

  it('çok kez ölçülmüş ölçüm: PACKAGING "İncele" (MULTI_PARCEL)', () => {
    expect(cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK'), remeasured: true })).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
  });

  it('Pak sınırı aşılmış → kendi ambalajı kuralları, bilgi notu; PACKAGING yok', () => {
    const big = withPack(meas(40, 30, 20, 2), 'PAK'); // 24.000 cm³
    const l = line({ trackingNo: 'P6', billedKg: 5, packaging: 'OWN', netAmount: own(5) });
    const r = cmp({ line: l, measurement: big });
    const plain = compareLine({ line: l, measurement: meas(40, 30, 20, 2), tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r.diffTypes).not.toContain('PACKAGING');
    expect(r).toMatchObject({ status: plain.status, expectedAmount: plain.expectedAmount, diffAmount: plain.diffAmount, confidence: plain.confidence });
    expect(r.note).toContain('FedEx Pak sınırını aşıyor (en çok 2,5 kg, 15.400 cm³); kendi ambalajı gibi denetlendi');
    expect(r.pricedPackaging).toBeUndefined();
  });

  it('tarifede Pak fiyatı yok → kendi ambalajı kuralları, bilgi notu', () => {
    const r = cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK'), tariff: FEDEX });
    const plain = compareLine({ line: ownLine, measurement: SMALL, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: plain.status, diffTypes: plain.diffTypes, expectedAmount: plain.expectedAmount });
    expect(r.note).toContain('Tarifede FedEx Pak fiyatı yok; kendi ambalajı gibi denetlendi');
  });

  it('Zarf (0,3 kg) → beklenen Zarf fiyatı', () => {
    const l = line({ trackingNo: 'Z1', billedKg: 0.5, packaging: 'OWN', netAmount: own(0.5) });
    const r = cmp({ line: l, measurement: withPack(meas(30, 22, 1, 0.3), 'ENVELOPE') });
    // zarf yalnız belge içindir: zarftan doğan fark "İncele"
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_ENVELOPE', expectedAmount: 232.5, pricedPackaging: 'ENVELOPE', ourChargeableKg: 0.5 });
    expect(r.diffAmount).toBe(Math.round((own(0.5) - 232.5) * 100) / 100);
  });

  it('Zarf 0,5 kg\'ı aşıyor → Pak fiyatı', () => {
    const r = cmp({ line: ownLine, measurement: withPack(SMALL, 'ENVELOPE') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_ENVELOPE', expectedAmount: 420, pricedPackaging: 'PAK' });
    expect(r.note).toContain('FedEx Zarf ile gönderildi, zarf sınırını (en çok 0,5 kg, 31,7×24,1×2 cm) aşıyor: FedEx Pak fiyatı geçerli');
  });

  it('Zarf olarak kaydedilmiş ama zarfa sığmayan kalın paket (0,3 kg, 30×20×5 cm) → Pak fiyatı', () => {
    const r = cmp({ line: line({ trackingNo: 'Z4', billedKg: 1, packaging: 'OWN', netAmount: own(1) }), measurement: withPack(meas(30, 20, 5, 0.3), 'ENVELOPE') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_ENVELOPE', pricedPackaging: 'PAK', expectedAmount: 375 });
  });

  it('Zarf ve Pak sınırı aşılmış → kendi ambalajı', () => {
    const r = cmp({ line: line({ trackingNo: 'Z2', billedKg: 3, packaging: 'OWN', netAmount: own(3) }), measurement: withPack(meas(30, 20, 5, 3), 'ENVELOPE') });
    expect(r.diffTypes).not.toContain('PACKAGING');
    expect(r.note).toContain('FedEx Zarf ve FedEx Pak sınırlarını aşıyor');
  });

  it('tarifede Zarf fiyatı yok → Pak fiyatıyla (alt sınır) iddia', () => {
    const noEnv: TariffInput = { ...FEDEX_PAK, rates: FEDEX_PAK.rates.filter((r) => r.packaging !== 'ENVELOPE') };
    const l = line({ trackingNo: 'Z3', billedKg: 0.5, packaging: 'OWN', netAmount: own(0.5) });
    const r = cmp({ line: l, measurement: withPack(meas(30, 22, 1, 0.3), 'ENVELOPE'), tariff: noEnv });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_ENVELOPE', pricedPackaging: 'PAK', expectedAmount: 375 });
    expect(r.note).toContain('tarifede zarf fiyatı yok, FedEx Pak fiyatıyla denetlendi');
  });

  it('İngilizce gösterim: notlar ve ambalaj adları çevrilir', () => {
    const r = cmp({ line: ownLine, measurement: withPack(SMALL, 'ENVELOPE'), locale: 'en' });
    expect(r.note).toBe('Sent in a FedEx Envelope over the envelope limit (max 0.5 kg, 31.7×24.1×2 cm): the FedEx Pak rate applies · Invoiced as own packaging; the FedEx Pak rate is expected');
    expect(r.breakdown[0]!.label).toBe('Pak rate (Zone A, 1.0 kg)');
    const stored = cmp({ line: ownLine, measurement: withPack(SMALL, 'PAK'), packagingLimits: undefined });
    expect(localizeComparison(stored, 'en').confidenceReason).toBe(t('en', 'compare.confidence.packagingLimitUnknown', { pack: 'FedEx Pak' }));
  });
});

describe('karşılaştırma: fatura Pak/Zarf', () => {
  const pakLine = (p: { trackingNo: string; netAmount: number; billedKg?: number }) =>
    line({ service: 'FedEx Intl Priority Pak', packaging: 'PAK', billedKg: 1, ...p });

  it('tarifede Pak fiyatı varsa Pak fiyatıyla denetlenir: uyumlu', () => {
    const r = cmp({ line: pakLine({ trackingNo: 'F1', netAmount: 420 }), measurement: SMALL });
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: 420, pricedPackaging: 'PAK', rate: null, rateDeviationPct: null });
    expect(isPakNote(r.note)).toBe(false);
  });

  it('Pak fiyatından pahalı: PRICE; ağırlık fazla yazılmış: WEIGHT (Pak fiyatında desi yok)', () => {
    expect(cmp({ line: pakLine({ trackingNo: 'F2', netAmount: 480 }), measurement: SMALL })).toMatchObject({ diffTypes: ['PRICE'], confidence: 'HIGH', expectedAmount: 420, diffAmount: 60 });
    const w = cmp({ line: pakLine({ trackingNo: 'F3', netAmount: 510, billedKg: 2 }), measurement: SMALL });
    expect(w).toMatchObject({ diffTypes: ['WEIGHT'], confidence: 'HIGH', expectedAmount: 420, diffAmount: 90, ourChargeableKg: 1, billedChargeableKg: 2 });
  });

  it('hizmet adından tanınan Pak (ambalaj sütunu yok) aynı kural', () => {
    const l = line({ trackingNo: 'F4', service: 'FedEx Intl Priority Pak', billedKg: 1, netAmount: 420 });
    expect(cmp({ line: l, measurement: SMALL })).toMatchObject({ status: 'MATCH', pricedPackaging: 'PAK' });
  });

  it('tarifede Pak fiyatı yok → bugünkü "kapsam dışı"', () => {
    const l = pakLine({ trackingNo: 'F5', netAmount: 420 });
    expect(cmp({ line: l, measurement: SMALL, tariff: FEDEX })).toMatchObject({ status: 'NO_TARIFF', note: t('tr', 'compare.pakNoTariff') });
    expect(cmp({ line: l, measurement: null, tariff: FEDEX })).toMatchObject({ status: 'UNMATCHED', note: PAK_NOTE, rate: null });
    // bölgede Pak fiyatı yok (B)
    expect(cmp({ line: { ...l, destCountry: 'GB' }, measurement: SMALL })).toMatchObject({ status: 'NO_TARIFF', note: t('tr', 'compare.pakNoTariff') });
  });

  it('ölçüm yok, tarifede Pak var → eşleşmedi (kapsam dışı değil), fiyat sapması yok', () => {
    const r = cmp({ line: pakLine({ trackingNo: 'F6', netAmount: 420 }), measurement: null });
    expect(r).toMatchObject({ status: 'UNMATCHED', note: t('tr', 'compare.noMeasurement'), rate: null, pricedPackaging: 'PAK' });
  });

  it('Zarf ile gönderildi, faturada Pak → PACKAGING (beklenen Zarf fiyatı)', () => {
    const r = cmp({ line: pakLine({ trackingNo: 'F7', netAmount: 375, billedKg: 0.5 }), measurement: withPack(meas(30, 22, 1, 0.3), 'ENVELOPE') });
    expect(r).toMatchObject({ diffTypes: ['PACKAGING'], confidence: 'LOW', reviewCode: 'PACKAGING_ENVELOPE', expectedAmount: 232.5, diffAmount: 142.5, pricedPackaging: 'ENVELOPE' });
    expect(r.note).toBe('FedEx Zarf ile gönderildi (sınır içinde) · Faturada FedEx Pak olarak fiyatlanmış; beklenen FedEx Zarf fiyatı');
  });

  it('fatura Pak, ölçüm Pak hacmini aşıyor: taşıyıcı Pak fiyatladı → Pak fiyatıyla (bizim ağırlığımızla), not', () => {
    const big = meas(40, 30, 20, 2); // 24.000 cm³ > 15.400; eski kayıt (ambalaj seçilmemiş)
    const ok = cmp({ line: pakLine({ trackingNo: 'F8', netAmount: 510, billedKg: 2 }), measurement: big });
    expect(ok).toMatchObject({ status: 'MATCH', pricedPackaging: 'PAK', expectedAmount: 510 });
    expect(ok.note).toContain('Faturada FedEx Pak; ölçümümüz sınırı aşıyor ama taşıyıcı bu ambalajın fiyatını uygulamış, o fiyatla denetlendi');
    // Pak 1 → 2 kg ağırlık farkı kaybolmaz (eskiden kendi ambalajı fiyatıyla "lehimize" çıkıyordu)
    const w = cmp({ line: pakLine({ trackingNo: 'F8b', netAmount: 510, billedKg: 2 }), measurement: meas(40, 30, 20, 0.8) });
    expect(w).toMatchObject({ diffTypes: ['WEIGHT'], confidence: 'HIGH', pricedPackaging: 'PAK', expectedAmount: 420, diffAmount: 90 });
  });

  it('fatura Pak, Pak tablosunda bizim ağırlığımız yok → kapsam dışı', () => {
    const r = cmp({ line: pakLine({ trackingNo: 'F8c', netAmount: 555, billedKg: 2.5 }), measurement: meas(30, 20, 10, 3) });
    expect(r).toMatchObject({ status: 'NO_TARIFF', note: t('tr', 'compare.pakNoTariff') });
  });

  it('fatura Zarf, ölçüm 0,8 kg → Pak fiyatıyla', () => {
    const l = line({ trackingNo: 'F9', service: 'FedEx Envelope', billedKg: 0.5, netAmount: 232.5 });
    const r = cmp({ line: l, measurement: SMALL });
    expect(r).toMatchObject({ pricedPackaging: 'PAK', expectedAmount: 420, diffTypes: [] });
    expect(r.note).toContain('Faturada FedEx Zarf; tarifede bu ağırlık için zarf fiyatı yok, FedEx Pak fiyatıyla denetlendi');
  });
});

describe('fazla ödeme dökümü', () => {
  it('yalnız PACKAGING olan satır kendi türünde (Fiyat farkı değil)', () => {
    const { overchargeByType } = overchargeReconciliation([
      { status: 'DIFF', decision: 'OPEN', expectedAmount: 420, diffAmount: 141.51, diffTypes: ['PACKAGING'], estimated: false },
      { status: 'DIFF', decision: 'OPEN', expectedAmount: 100, diffAmount: 10, diffTypes: ['PRICE'], estimated: false },
    ]);
    expect(overchargeByType).toEqual([
      { type: 'PACKAGING', lines: 1, amount: 141.51 },
      { type: 'PRICE', lines: 1, amount: 10 },
    ]);
  });
});

describe('kendi ambalajı sonuçları değişmez', () => {
  const cases: [string, ReturnType<typeof line>, MeasurementInput][] = [
    ['uyumlu', line({ trackingNo: 'O1', billedKg: 6, netAmount: own(6) }), meas(30, 30, 20, 5.6)],
    ['ağırlık farkı', line({ trackingNo: 'O2', billedKg: 9.5, netAmount: own(9.5) }), meas(30, 30, 20, 5.6)],
    ['ölçü farkı', line({ trackingNo: 'O3', billedKg: 9.5, dims: { l: 50, w: 40, h: 22 }, netAmount: own(9.5) }), meas(30, 30, 20, 5.6)],
    ['fiyat farkı', line({ trackingNo: 'O4', billedKg: 6, netAmount: own(6) + 80 }), meas(30, 30, 20, 5.6)],
    ['ölçüm Pak sınırına sığmıyor', line({ trackingNo: 'O5', billedKg: 1, packaging: 'OWN', netAmount: own(1) + 40 }), meas(30, 20, 3, 0.8)],
  ];
  for (const [name, l, m] of cases) {
    it(name, () => {
      const base = compareLine({ line: l, measurement: m, tariff: FEDEX, tol: TOL, isDuplicate: false });
      expect(compareLine({ line: l, measurement: { ...m, packaging: 'OWN' }, tariff: FEDEX_PAK, tol: TOL, isDuplicate: false, packagingLimits: FX, carrier: 'fedex' })).toEqual(base);
      expect(compareLine({ line: l, measurement: m, tariff: FEDEX_PAK, tol: TOL, isDuplicate: false })).toEqual(base);
    });
  }
});
