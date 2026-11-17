/**
 * DENETIM-2 01-B11 (API tarafı): eksi tutarlı (iade / düzeltme) satır tarifeyle karşılaştırılmaz ve mükerrer kuralında
 * görünüm sayılmaz. Çekirdek satırı "iade" notuyla beklenensiz bırakır; burada dosya içi ve önceki fatura görünümleri
 * ile fatura toplamları (`computeTotals`) denetlenir. Veritabanısız (`compareAll` saf).
 */
import { describe, expect, it } from 'vitest';
import { t, type ParsedInvoiceLine } from '@deciship/core';
import { FEDEX } from '../../../packages/core/test/fixtures.ts';
import { cancelCredits, compareAll, computeTotals, MeasurementIndex, resultToLineData, type CompareContext, type PricingTariff } from '../src/services/compare.ts';

const INVOICE_DATE = new Date('2026-10-31T00:00:00.000Z');
const pricing: PricingTariff = { tariffId: 't1', revisionId: 'rev1', name: 'FedEx', currency: 'TRY', validFrom: null, validTo: null, input: FEDEX };
const TRACK = '771200000001';
const TRACK2 = '771200000002';

/** 40×30×25 cm, 4,0 kg → ücretli 6,0 kg; FEDEX A bölgesi beklenen 1.184,00. */
function context(priorLines: CompareContext['priorLines'] = new Map()): CompareContext {
  const settings = { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false, companyCurrency: 'TRY' };
  return {
    index: new MeasurementIndex([
      { id: 'm1', trackingNo: TRACK, trackingRaw: TRACK, lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, measuredAt: new Date('2026-10-20T10:00:00Z') },
      { id: 'm2', trackingNo: TRACK2, trackingRaw: TRACK2, lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, measuredAt: new Date('2026-10-20T10:00:00Z') },
    ] as never),
    pricing,
    basis: { tariffRevisionId: pricing.revisionId, compareSettings: settings },
    tol: { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false },
    priorLines,
    carrierId: 'c1',
    companyCurrency: 'TRY',
    invoiceCurrency: 'TRY',
  };
}

const row = (rowIndex: number, netAmount: number): ParsedInvoiceLine => ({ rowIndex, trackingNo: TRACK, destCountry: 'FR', billedKg: 6, surcharges: [], netAmount, currency: 'TRY', rawHash: `h${rowIndex}` });

const totalsOf = (cs: ReturnType<typeof compareAll>) =>
  computeTotals(cs.map((c) => ({ ...resultToLineData(c.result, c.measurementId, c.tariffId), netAmount: c.line.netAmount, decision: 'OPEN' })));

describe('K39: tarifenin hizmeti belli, satırın hizmeti boş (faturanın tüm satırlarından)', () => {
  const ie = (): CompareContext => ({ ...context(), pricing: { ...pricing, input: { ...FEDEX, service: 'IE' } } });
  // 6,0 kg beklenen 1.184,00; faturalanan 1.302,40 → fark +118,40
  const diffRow = (rowIndex: number, trackingNo: string, service?: string): ParsedInvoiceLine => ({ ...row(rowIndex, 1302.4), trackingNo, ...(service ? { service } : {}) });

  it('faturada hizmet sütunu var, bu satırınki boş: "İncele" (SERVICE_MISSING)', () => {
    const [named, blank] = compareAll([diffRow(0, TRACK, 'FedEx International Economy'), diffRow(1, TRACK2)], ie(), INVOICE_DATE);
    expect(named!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 118.4, confidence: 'HIGH' });
    expect(blank!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 1184, diffAmount: 118.4, confidence: 'LOW', reviewCode: 'SERVICE_MISSING' });
  });

  it('faturanın hiçbir satırında hizmet yok: fark kesin kalır', () => {
    const [only] = compareAll([diffRow(0, TRACK), diffRow(1, TRACK2)], ie(), INVOICE_DATE);
    expect(only!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: 1184, diffAmount: 118.4, confidence: 'HIGH' });
  });
});

describe('01-B11: iade satırı ve mükerrer', () => {
  it('dosyada önce iade, sonra asıl ücret: ücret mükerrer değil, tarifeyle karşılaştırılır', () => {
    const [credit, charge] = compareAll([row(0, -150), row(1, 1184)], context(), INVOICE_DATE);
    expect(credit!.result).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null, note: t('tr', 'compare.credit') });
    // eskiden: asıl ücret DUPLICATE ("İncele", tutar farklı), fark 1.184,00
    expect(charge!.result).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 1184, diffAmount: 0, confidence: 'HIGH' });
  });

  it('dosyada önce ücret, sonra iade: iade mükerrer değil; ikinci ücret yine mükerrer, iade tutmadığı için "İncele"', () => {
    const [charge, credit, again] = compareAll([row(0, 1184), row(1, -150), row(2, 1184)], context(), INVOICE_DATE);
    expect(charge!.result).toMatchObject({ status: 'MATCH', expectedAmount: 1184 });
    expect(credit!.result).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null });
    // inceleme 2026-11-13: aynı takip no için tutarı ücrete eşit olmayan iade var (kısmi iade ya da düzeltme olabilir):
    // mükerrer kesin sayılmaz (eskiden HIGH)
    expect(again!.result).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 1184, confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(again!.result.confidenceReason).toBe(t('tr', 'compare.confidence.duplicateCredit'));
  });

  it('fatura toplamları: iade Faturalanan (fatura toplamı) içinde, Beklenen ve fazla ödemede yok', () => {
    const cs = compareAll([row(0, 1184), row(1, -150)], context(), INVOICE_DATE);
    // eskiden: iade MATCH, beklenen 1.184,00 → Beklenen 2.368,00, karşılaştırılan Faturalanan 1.034,00
    expect(totalsOf(cs)).toMatchObject({ lines: 2, match: 1, diff: 0, noTariff: 1, billedTotal: 1034, comparedBilledTotal: 1184, expectedTotal: 1184, overchargeTotal: 0 });
  });
});

describe('İnceleme 2026-11-13: iptal edilip yeniden faturalanan gönderi mükerrer değil', () => {
  const prior = (invoiceNo: string, netAmount: number) => ({ carrierId: 'c1', invoiceNo, netAmount, currency: 'TRY' });
  const priors = (...ps: ReturnType<typeof prior>[]): CompareContext['priorLines'] => new Map([[TRACK, ps]]);

  it('A: 100,00; B: −100,00 (iade) ve 100,00 (yeniden fatura) → yeniden fatura mükerrer değil', () => {
    // eskiden: yeniden fatura DUPLICATE kesin, itiraz 100,00 isterdi
    const [credit, rebill] = compareAll([row(0, -100), row(1, 100)], context(priors(prior('A', 100))), INVOICE_DATE);
    expect(credit!.result).toMatchObject({ status: 'NO_TARIFF', diffTypes: [] });
    expect(rebill!.result.diffTypes).not.toContain('DUPLICATE');
    expect(rebill!.result).toMatchObject({ status: 'MATCH', expectedAmount: 1184 });
  });

  it('dosyada sıra ters (önce yeniden fatura, sonra iade): yine mükerrer değil', () => {
    const [rebill] = compareAll([row(0, 100), row(1, -100)], context(priors(prior('A', 100))), INVOICE_DATE);
    expect(rebill!.result.diffTypes).not.toContain('DUPLICATE');
  });

  it('iade önceki faturada (A: 100,00; B: −100,00; C: 100,00) → C mükerrer değil', () => {
    const [rebill] = compareAll([row(0, 100)], context(priors(prior('A', 100), prior('B', -100))), INVOICE_DATE);
    expect(rebill!.result.diffTypes).not.toContain('DUPLICATE');
  });

  it('aynı dosyada 100,00 + 100,00 + −100,00 → hiçbiri mükerrer değil', () => {
    const cs = compareAll([row(0, 100), row(1, 100), row(2, -100)], context(), INVOICE_DATE);
    expect(cs.map((c) => c.result.diffTypes.includes('DUPLICATE'))).toEqual([false, false, false]);
  });

  it('iade iptali yalnız bir ücreti düşer: A: 100,00; B: −100,00, 100,00, 100,00 → son ücret mükerrer ("İncele": dosyada yineleniyor)', () => {
    const cs = compareAll([row(0, -100), row(1, 100), row(2, 100)], context(priors(prior('A', 100))), INVOICE_DATE);
    expect(cs[1]!.result.diffTypes).not.toContain('DUPLICATE');
    // KALANLAR 1.8: iade A'yı iptal etti, B'de iki ücret kaldı: aynı dosyada yinelenen takip no (çok koli ya da ayrı ücret
    // satırı olabilir) kesin mükerrer sayılmaz (eskiden HIGH)
    expect(cs[2]!.result).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 100, confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(cs[2]!.result.confidenceReason).toBe(t('tr', 'compare.confidence.duplicateFile'));
  });

  it('iade tutarı ücrete eşit değil (A: 100,00; B: −90,00, 100,00) → mükerrer "İncele"', () => {
    const [, rebill] = compareAll([row(0, -90), row(1, 100)], context(priors(prior('A', 100))), INVOICE_DATE);
    expect(rebill!.result).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 100, confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(rebill!.result.confidenceReason).toBe(t('tr', 'compare.confidence.duplicateCredit'));
  });
});

describe('Kullanıcı kararı 2026-11-13: sıfır tutarlı satır (ücretsiz) mükerrerin önceki görünümü değildir', () => {
  it('önceki faturada 0,00, bu faturada 1.184,00 → mükerrer değil', () => {
    // eskiden: DUPLICATE ("İncele", tutar farklı), fark 1.184,00
    const [charge] = compareAll([row(0, 1184)], context(new Map([[TRACK, [{ carrierId: 'c1', invoiceNo: 'A', netAmount: 0, currency: 'TRY' }]]])), INVOICE_DATE);
    expect(charge!.result).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 1184, diffAmount: 0 });
  });

  it('aynı dosyada önce 0,00 sonra 1.184,00 → ikinci mükerrer değil; sıfır satır karşılaştırılmaz, toplamlara 0', () => {
    const cs = compareAll([row(0, 0), row(1, 1184)], context(), INVOICE_DATE);
    expect(cs[0]!.result).toMatchObject({ status: 'NO_TARIFF', expectedAmount: null, diffAmount: null, note: t('tr', 'compare.freeLine') });
    expect(cs[1]!.result).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 1184 });
    expect(totalsOf(cs)).toMatchObject({ lines: 2, match: 1, noTariff: 1, billedTotal: 1184, comparedBilledTotal: 1184, expectedTotal: 1184, overchargeTotal: 0 });
  });
});

describe('İnceleme 2: iade ile iptal edilen ücret ve başka taşıyıcının iadesi', () => {
  it('dosyada 1.302,40 (fark 118,40), iadesi −1.302,40 ve yeniden fatura 1.184,00 → iptal edilen ücret karşılaştırılmaz', () => {
    // eskiden: 1.302,40 satırı kesin +118,40 fark (itiraz edilebilir), oysa ücret iade edildi
    const cs = compareAll([row(0, 1302.4), row(1, -1302.4), row(2, 1184)], context(), INVOICE_DATE);
    expect(cs[0]!.result).toMatchObject({ status: 'NO_TARIFF', diffTypes: [], expectedAmount: null, diffAmount: null, note: t('tr', 'compare.creditCancelled') });
    expect(cs[2]!.result).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 1184 });
    expect(totalsOf(cs)).toMatchObject({ billedTotal: 1184, comparedBilledTotal: 1184, expectedTotal: 1184, overchargeTotal: 0 });
  });

  it('iade dosyada üstte de olsa ücreti iptal eder', () => {
    const cs = compareAll([row(0, -1302.4), row(1, 1302.4)], context(), INVOICE_DATE);
    expect(cs[1]!.result).toMatchObject({ status: 'NO_TARIFF', note: t('tr', 'compare.creditCancelled') });
  });

  it('başka taşıyıcının tutmayan iadesi bu taşıyıcının mükerrerini "İncele" yapmaz', () => {
    const P = (carrierId: string, netAmount: number, invoiceNo = 'I1') => ({ carrierId, invoiceNo, netAmount, currency: 'TRY' });
    // eskiden: unmatchedCredit true
    expect(cancelCredits([P('c1', 100), P('c9', -100, 'I2')], [], [], 'c1')).toMatchObject({ charges: [P('c1', 100)], unmatchedCredit: false });
    expect(cancelCredits([P('c1', 100), P('c1', -90, 'I2')], [], [], 'c1').unmatchedCredit).toBe(true);
  });
});
