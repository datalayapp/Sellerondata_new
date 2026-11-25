/**
 * KALANLAR 1.8 (API tarafı, veritabanısız): yanlış itiraza karşı güvenlik ağı. Çekirdeğin bayraklarını API dosyanın
 * satırlarından ve bağlamdan kurar (`compareAll`):
 * - takip no bu dosyada birden çok ücret satırında (iade ile iptal edilenler düşülür) → her farkı "İncele";
 * - eşleşen ölçüm birden çok kez ölçülmüş (`ctx.remeasured`) → ağırlık/ölçü farkı "İncele";
 * - önceki faturada aynı tutarlı görünümün açıklaması (hizmet, ek ücret kodları) farklı → mükerrer "İncele".
 * "İncele" satırın tutarı Fazla ödeme'ye girmez (`computeTotals`).
 */
import { describe, expect, it } from 'vitest';
import { t, type ParsedInvoiceLine } from '@deciship/core';
import { FEDEX } from '../../../packages/core/test/fixtures.ts';
import { compareAll, computeTotals, lineDescription, MeasurementIndex, sameLineDescription, resultToLineData, type CompareContext, type PricingTariff, type PriorLine } from '../src/services/compare.ts';

const INVOICE_DATE = new Date('2026-10-31T00:00:00.000Z');
const pricing: PricingTariff = { tariffId: 't1', revisionId: 'rev1', name: 'FedEx', currency: 'TRY', validFrom: null, validTo: null, input: FEDEX };
const TRACK = '771300000001';
const TRACK2 = '771300000002';

/** 40×30×25 cm, 4,0 kg → ücretli 6,0 kg; FEDEX A bölgesi beklenen 1.184,00. */
function context(o: { priorLines?: CompareContext['priorLines']; remeasured?: string[] } = {}): CompareContext {
  const settings = { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false, companyCurrency: 'TRY' };
  return {
    index: new MeasurementIndex([
      { id: 'm1', trackingNo: TRACK, trackingRaw: TRACK, lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, measuredAt: new Date('2026-10-20T10:00:00Z') },
      { id: 'm2', trackingNo: TRACK2, trackingRaw: TRACK2, lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 4, measuredAt: new Date('2026-10-20T10:00:00Z') },
    ] as never),
    pricing,
    basis: { tariffRevisionId: pricing.revisionId, compareSettings: settings },
    tol: { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false },
    priorLines: o.priorLines ?? new Map(),
    carrierId: 'c1',
    companyCurrency: 'TRY',
    invoiceCurrency: 'TRY',
    ...(o.remeasured ? { remeasured: new Set(o.remeasured) } : {}),
  };
}

const row = (rowIndex: number, netAmount: number, p: Partial<ParsedInvoiceLine> = {}): ParsedInvoiceLine => ({
  rowIndex,
  trackingNo: TRACK,
  destCountry: 'FR',
  billedKg: 6,
  surcharges: [],
  netAmount,
  currency: 'TRY',
  rawHash: `h${rowIndex}`,
  ...p,
});

const totalsOf = (cs: ReturnType<typeof compareAll>) =>
  computeTotals(cs.map((c) => ({ ...resultToLineData(c.result, c.measurementId, c.tariffId), netAmount: c.line.netAmount, decision: 'OPEN' })));

describe('takip no aynı dosyada birden çok satırda', () => {
  it('koli başına iki aynı satır: ikisi de "İncele" (ilki fiyat farkı, ikincisi mükerrer); fazla ödeme 0', () => {
    // her satır 1.302,40 (beklenen 1.184,00 → fark 118,40)
    const cs = compareAll([row(0, 1302.4), row(1, 1302.4)], context(), INVOICE_DATE);
    expect(cs[0]!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 118.4, confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    expect(cs[0]!.result.confidenceReason).toBe(t('tr', 'compare.confidence.multiParcelFile'));
    // eskiden: ikinci satır kesin mükerrer, tutarın tamamı (1.302,40) itiraz listesine girebilirdi
    expect(cs[1]!.result).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 1302.4, confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(cs[1]!.result.confidenceReason).toBe(t('tr', 'compare.confidence.duplicateFile'));
    expect(totalsOf(cs)).toMatchObject({ overchargeTotal: 0, estimatedLines: 2 });
  });

  it('uyumlu ilk satır işaretlenmez; başka takip no etkilenmez', () => {
    const cs = compareAll([row(0, 1184), row(1, 1184), row(2, 1302.4, { trackingNo: TRACK2 })], context(), INVOICE_DATE);
    expect(cs[0]!.result).toMatchObject({ status: 'MATCH', confidence: 'HIGH', confidenceReason: null });
    expect(cs[1]!.result).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'LOW' });
    expect(cs[2]!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
  });

  it('bu dosyanın iadesiyle iptal edilen ücret sayılmaz: tek ücret kalırsa fark kesin', () => {
    // 1.184,00 ücret, −1.184,00 iadesi, 1.302,40 yeniden fatura: kalan tek ücret
    const cs = compareAll([row(0, 1184), row(1, -1184), row(2, 1302.4)], context(), INVOICE_DATE);
    expect(cs[2]!.result).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 118.4, confidence: 'HIGH' });
  });

  it('takip no yazımı farklı da olsa aynı gönderi sayılır (normalleştirme)', () => {
    const cs = compareAll([row(0, 1302.4), row(1, 1302.4, { trackingNo: ` ${TRACK.slice(0, 4)} ${TRACK.slice(4)} ` })], context(), INVOICE_DATE);
    expect(cs.map((c) => c.result.confidence)).toEqual(['LOW', 'LOW']);
  });
});

describe('mükerrer: önceki faturada aynı tutar, farklı açıklama', () => {
  const prior = (p: Partial<PriorLine> = {}): PriorLine => ({ carrierId: 'c1', invoiceNo: 'A-1', netAmount: 1184, currency: 'TRY', ...p });
  const ctx = (...ps: PriorLine[]) => context({ priorLines: new Map([[TRACK, ps]]) });
  const svc = 'FedEx International Economy';

  it('açıklama aynı (boşluk ve büyük harf farkı sayılmaz) ya da bilinmiyorsa kesin mükerrer', () => {
    const line = row(0, 1184, { service: svc });
    for (const p of [prior({ description: lineDescription('  fedex international  ECONOMY ', []) }), prior()]) {
      expect(compareAll([line], ctx(p), INVOICE_DATE)[0]!.result).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'HIGH', confidenceReason: null });
    }
  });

  it('hizmet ya da ek ücret kodları farklıysa "İncele" (göndericiye iade, ek hizmet olabilir)', () => {
    const cases: [ParsedInvoiceLine, PriorLine][] = [
      [row(0, 1184, { service: 'Göndericiye iade' }), prior({ description: lineDescription(svc, []) })],
      [
        row(0, 1184, { service: svc, surcharges: [{ code: 'ADDRESS_CORRECTION', amount: 50 }] }),
        prior({ description: lineDescription(svc, [{ code: 'REMOTE_AREA' }]) }),
      ],
    ];
    for (const [line, p] of cases) {
      const r = compareAll([line], ctx(p), INVOICE_DATE)[0]!.result;
      expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 1184, confidence: 'LOW', reviewCode: 'DUPLICATE' });
      expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.duplicateDescription', { invoice: 'A-1' }));
    }
  });

  // bağımsız inceleme: bilinmeyen kısım (bir faturada hizmet sütunu ya da ek ücret sütunları yok) farklılık sayılmaz
  it('hizmet ya da ek ücret yalnız bir tarafta yazılıysa o kısım yok sayılır: kesin mükerrer', () => {
    const cases: [ParsedInvoiceLine, PriorLine][] = [
      // A: hizmet sütunu yok; B: "Standart"
      [row(0, 1184, { service: 'Standart' }), prior({ description: lineDescription(null, []) })],
      [row(0, 1184), prior({ description: lineDescription('Standart', []) })],
      // ek ücret sütunları yalnız birinde eşlenmiş
      [row(0, 1184, { service: svc, surcharges: [{ code: 'ADDRESS_CORRECTION', amount: 50 }] }), prior({ description: lineDescription(svc, []) })],
      [row(0, 1184, { service: svc }), prior({ description: lineDescription(svc, [{ code: 'FUEL' }]) })],
    ];
    for (const [line, p] of cases) {
      expect(compareAll([line], ctx(p), INVOICE_DATE)[0]!.result).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'HIGH', confidenceReason: null });
    }
  });

  it('aynı tutarlı görünümlerden biri aynı açıklamalıysa kesin (o seçilir)', () => {
    const line = row(0, 1184, { service: svc });
    const r = compareAll([line], ctx(prior({ invoiceNo: 'A-1', description: lineDescription('Ek hizmet', []) }), prior({ invoiceNo: 'A-2', description: lineDescription(svc, []) })), INVOICE_DATE)[0]!.result;
    expect(r).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'HIGH' });
  });

  it('açıklama: hizmet + sıralı ek ücret kodları', () => {
    expect(lineDescription(' A  b ', [{ code: 'z' }, { code: 'A' }])).toEqual({ service: 'a b', codes: ['A', 'Z'] });
    expect(lineDescription('İADE ıade', [])).toEqual(lineDescription('iade IADE', []));
    expect(lineDescription(null, null)).toEqual({ service: '', codes: [] });
    expect(lineDescription(undefined, [{ name: 'kodsuz' }, null, 'x'])).toEqual({ service: '', codes: [] });
    const d = (svc: string | null, codes: string[]) => lineDescription(svc, codes.map((code) => ({ code })));
    expect(sameLineDescription(d('a', ['X']), d('a', ['X']))).toBe(true);
    expect(sameLineDescription(d('a', []), d('b', []))).toBe(false);
    expect(sameLineDescription(d('a', ['X']), d('a', ['Y']))).toBe(false);
    expect(sameLineDescription(d(null, ['X']), d('b', ['X']))).toBe(true);
    expect(sameLineDescription(d('a', []), d('a', ['Y']))).toBe(true);
  });
});

describe('ölçüm birden çok kez yapıldı (ctx.remeasured)', () => {
  // faturada 9 kg, bizim ölçümümüz 6 kg: ağırlık/ölçü farkı
  const heavy = row(0, 1900, { billedKg: 9 });

  it('ağırlık farkı "İncele" (MULTI_PARCEL), tutarlar aynı; ölçüm tekrarı yoksa kesin', () => {
    const firm = compareAll([heavy], context(), INVOICE_DATE)[0]!;
    expect(firm.result.status).toBe('DIFF');
    expect(firm.result.diffTypes.some((x) => x === 'WEIGHT' || x === 'DIMENSION')).toBe(true);
    expect(firm.result.confidence).toBe('HIGH');
    const r = compareAll([heavy], context({ remeasured: ['m1'] }), INVOICE_DATE)[0]!;
    expect(r.measurementId).toBe('m1');
    expect(r.result).toMatchObject({ status: 'DIFF', diffTypes: firm.result.diffTypes, diffAmount: firm.result.diffAmount, confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    expect(r.result.confidenceReason).toBe(t('tr', 'compare.confidence.multiParcelMeasured'));
    // başka ölçüm tekrarlı: bu satır etkilenmez
    expect(compareAll([heavy], context({ remeasured: ['m2'] }), INVOICE_DATE)[0]!.result.confidence).toBe('HIGH');
  });

  it('yalnız fiyat farkı kesin kalır (ölçümden bağımsız)', () => {
    expect(compareAll([row(0, 1302.4)], context({ remeasured: ['m1'] }), INVOICE_DATE)[0]!.result).toMatchObject({ diffTypes: ['PRICE'], confidence: 'HIGH' });
  });
});
