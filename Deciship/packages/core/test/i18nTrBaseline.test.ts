import { describe, expect, it } from 'vitest';
import {
  DIFF_TYPE_LABELS,
  ESTIMATED_NOTE,
  FAVOURABLE_NOTE,
  FX_SOURCE_LABEL,
  FX_TOLERANCE_NOTE,
  INVOICE_BASIS_NOTE,
  MAPPING_FIELD_LABELS,
  OVERCHARGE_NOTE,
  PAK_NOTE,
  ROW_FLAG_LABELS,
  STATUS_LABELS,
  UNCHECKED_SURCHARGE_NOTE,
  baremText,
  buildDisputeText,
  buildWhatsAppText,
  checkTariffImport,
  classifyCharge,
  compareLine,
  countryAdjustmentLabel,
  countryNameTr,
  describeWeightSteps,
  detectDocumentFacts,
  emptyMapping,
  expectedCharge,
  fmtDate,
  fmtDims,
  fmtFxRate,
  fmtKg,
  fmtMoney,
  fmtMoneyEn,
  fmtNumber,
  fmtPct,
  fmtSignedPct,
  fmtWeightNumber,
  fxSourceText,
  importHeadline,
  importSummaryLine,
  invoiceFileError,
  invoiceSummarySentence,
  mappingDiagnostics,
  overchargeNote,
  parseRows,
  parseTariffImport,
  ratePrice,
  rawRowsText,
  tableFromMatrix,
  tariffHealth,
  tariffImportFixes,
  verifyMapping,
  type ColumnMapping,
  type DisputeInput,
  type DisputeLine,
  type FxRate,
  type HealthLineInput,
  type InvoiceFileErrorCode,
  type ParsedInvoiceLine,
  type RawTariffFile,
  type TariffImportContext,
  type TariffInput,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/**
 * TR çıktılarının taban görüntüsü: bu dosyanın anlık görüntüleri çok dilli yapıya geçmeden ÖNCE, eski kodla üretildi.
 * Testler yalnız varsayılan (locale'siz) çağrı yapar; görüntü değişirse TR metin değişmiş demektir.
 */

const disputeLines: DisputeLine[] = [
  {
    trackingNo: '794812345305',
    shipDate: '2026-10-22',
    diffTypes: ['DIMENSION'],
    decision: 'VERIFIED',
    ourDims: { l: 40, w: 30.5, h: 25 },
    ourActualKg: 4,
    ourChargeableKg: 6,
    billedDims: { l: 45, w: 35, h: 30 },
    billedActualKg: 4.5,
    billedChargeableKg: 9.5,
    expectedAmount: 1184,
    billedAmount: 1642.5,
    diffAmount: 458.5,
  },
  { trackingNo: '794812345288', diffTypes: ['DUPLICATE'], decision: 'VERIFIED', ourChargeableKg: null, billedChargeableKg: 5.5, expectedAmount: null, billedAmount: 1120, diffAmount: 1120 },
  { trackingNo: '794812345290', diffTypes: ['PRICE'], decision: 'OPEN', ourChargeableKg: 15, billedChargeableKg: 15, expectedAmount: 2815, billedAmount: 2871.3, diffAmount: 56.3 },
  {
    trackingNo: '794812345293',
    diffTypes: ['SURCHARGE', 'WEIGHT'],
    decision: 'VERIFIED',
    ourChargeableKg: 4.5,
    billedChargeableKg: 1250,
    expectedAmount: null,
    billedAmount: 1377.84,
    diffAmount: 412,
    surcharges: [
      { code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 },
      { code: 'PEAK', amount: 12.5 },
    ],
  },
  { trackingNo: '794812345299', diffTypes: ['PRICE'], status: 'MATCH', ourChargeableKg: 2, billedChargeableKg: 2, expectedAmount: 10, billedAmount: 20, diffAmount: 10 },
];

const disputeBase: Omit<DisputeInput, 'lang'> = {
  company: { name: 'Demo İhracat', contactName: 'Elif Kaya', email: 'elif@demo.com', phone: '+90 212 000 00 00' },
  carrier: { name: 'FedEx', accountNo: '123456789' },
  invoice: { invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY' },
  lines: disputeLines,
};

describe('TR taban: itiraz metni', () => {
  it('tam metin', () => {
    expect(buildDisputeText({ ...disputeBase, lang: 'tr' })).toMatchSnapshot();
  });
  it('müşteri no, tarih ve imza alanları olmadan; USD', () => {
    expect(
      buildDisputeText({
        ...disputeBase,
        company: { name: 'Demo İhracat' },
        carrier: { name: 'UPS' },
        invoice: { invoiceNo: 'X1', currency: 'USD' },
        lines: [disputeLines[0]!],
        lang: 'tr',
      }),
    ).toMatchSnapshot();
  });
  it('listelenecek satır yok', () => {
    expect(buildDisputeText({ ...disputeBase, lines: [], lang: 'tr' })).toMatchSnapshot();
  });
});

describe('TR taban: biçimleme', () => {
  it('sayılar, para, ağırlık, ölçü, yüzde, tarih', () => {
    const nums = [0, 1, -1, 0.5, 1.005, 4.02, 4.025, 6, 9.5, 27.5, 999.999, 1000, 1234.5, -458.5, 1234567.891];
    expect({
      fmtNumber: nums.map((n) => fmtNumber(n)),
      fmtNumber0: nums.map((n) => fmtNumber(n, 0)),
      fmtNumber4: nums.map((n) => fmtNumber(n, 4)),
      fmtMoney: nums.flatMap((n) => ['TRY', 'EUR', 'USD', 'GBP', 'CHF'].map((c) => fmtMoney(n, c))),
      fmtMoneyEn: nums.map((n) => fmtMoneyEn(n, 'EUR')),
      fmtWeightNumber: nums.map((n) => fmtWeightNumber(n)),
      fmtKg: nums.map((n) => fmtKg(n)),
      fmtPct: nums.map((n) => fmtPct(n)),
      fmtSignedPct: nums.map((n) => fmtSignedPct(n)),
      fmtFxRate: nums.map((n) => fmtFxRate(n)),
      fmtDims: [fmtDims({ l: 40, w: 30.5, h: 25 }), fmtDims({ l: 40.04, w: 0.5, h: 1000 })],
      fmtDate: [fmtDate('2026-10-27'), fmtDate('2026-10-27T14:00:00'), fmtDate('geçersiz')],
    }).toMatchSnapshot();
  });
});

describe('TR taban: sabit etiketler', () => {
  it('etiket tabloları ve notlar', () => {
    expect({
      STATUS_LABELS,
      DIFF_TYPE_LABELS,
      ROW_FLAG_LABELS,
      MAPPING_FIELD_LABELS,
      ESTIMATED_NOTE,
      OVERCHARGE_NOTE,
      PAK_NOTE,
      FAVOURABLE_NOTE,
      FX_TOLERANCE_NOTE,
      UNCHECKED_SURCHARGE_NOTE,
      INVOICE_BASIS_NOTE,
      FX_SOURCE_LABEL,
    }).toMatchSnapshot();
  });
  it('dosya hataları', () => {
    const codes: InvoiceFileErrorCode[] = ['EMPTY_FILE', 'NO_ROWS', 'XLSX_UNREADABLE', 'OLD_EXCEL', 'HTML_AS_EXCEL', 'UNSUPPORTED_FORMAT', 'XLSX_TOO_LARGE'];
    expect(codes.map((c) => invoiceFileError(c).message)).toMatchSnapshot();
    // yük sınırları (Mesaj 6): sınır metne girer
    expect([invoiceFileError('TOO_MANY_ROWS', { limit: '200.000' }).message, invoiceFileError('PDF_TOO_MANY_PAGES', { limit: 300 }).message]).toMatchSnapshot();
  });
  it('ülke adları ve ülke istisnası', () => {
    expect({
      names: ['ES', 'de', 'TR', 'US', 'ZZ', 'XX', '', null, 'ABC'].map((c) => countryNameTr(c)),
      adj: [countryAdjustmentLabel({ country: 'ES', pct: -15.45 }), countryAdjustmentLabel({ country: 'DE', pct: 3 })],
    }).toMatchSnapshot();
  });
  it('etiketsiz ücret', () => {
    expect(classifyCharge('', 12)).toMatchSnapshot();
  });
});

describe('TR taban: fatura özeti', () => {
  const base = { lines: 120, match: 16, diff: 3, unmatched: 63, noTariff: 38, billedTotal: 1000, expectedTotal: 900 };
  it('cümleler', () => {
    expect([
      invoiceSummarySentence(base),
      invoiceSummarySentence({ ...base, pakUnmatched: 10, pakNoTariff: 28 }),
      invoiceSummarySentence({ ...base, diff: 0 }),
      invoiceSummarySentence({ lines: 10, match: 10, diff: 0, unmatched: 0, noTariff: 0, billedTotal: 0, expectedTotal: 0 }),
      invoiceSummarySentence({ lines: 10, match: 8, diff: 2, unmatched: 0, noTariff: 0, billedTotal: 0, expectedTotal: 0 }),
      invoiceSummarySentence({ lines: 1200, match: 1000, diff: 100, unmatched: 50, noTariff: 50, billedTotal: 0, expectedTotal: 0 }),
    ]).toMatchSnapshot();
  });
  it('fazla ödeme notu', () => {
    expect([overchargeNote(base, 100), overchargeNote(base, 50), overchargeNote({ ...base, estimatedOverchargeTotal: 40 }, 60)]).toMatchSnapshot();
  });
});

describe('TR taban: ipuçları ve barem', () => {
  it('WhatsApp', () => {
    const s = { carrierName: 'FedEx', invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', lines: 18, diff: 4, unmatched: 1, overchargeTotal: 1731.2, disputeLastDay: '2026-11-04' };
    expect([
      buildWhatsAppText(s),
      buildWhatsAppText({ ...s, invoiceDate: null, unmatched: 0, disputeLastDay: null }),
      buildWhatsAppText({ ...s, overchargeTotal: 0 }),
    ]).toMatchSnapshot();
  });
  it('barem', () => {
    expect([baremText({ kind: 'OVER', boundaryKg: 6, overKg: 0.2, nextKg: 6.5 }), baremText({ kind: 'OVER', boundaryKg: 10.5, overKg: 0.125, nextKg: 11 })]).toMatchSnapshot();
  });
  it('ağırlık basamakları', () => {
    expect([
      describeWeightSteps([]),
      describeWeightSteps([{ upto: null, step: 1 }]),
      describeWeightSteps([{ upto: 70.5, step: 0.5 }, { upto: null, step: 1 }]),
      describeWeightSteps([{ upto: 20, step: 0.5 }, { upto: 1000, step: 1.5 }, { upto: null, step: 5 }]),
    ]).toMatchSnapshot();
  });
});

describe('TR taban: tarife uyumu', () => {
  const l = (destCountry: string | null, rateDeviationPct: number, over: Partial<HealthLineInput> = {}): HealthLineInput => ({ destCountry, service: 'IE', zone: 'A', rateDeviationPct, fx: false, ...over });
  it('tüm mesaj dalları', () => {
    expect(
      tariffHealth(
        [
          l('ES', -15, { adjustmentPct: -2 }), l('ES', -15.4), l('ES', -14.6),
          l('DE', 8), l('DE', 8.5), l('DE', 7.5),
          l('US', 50), l('US', 55), l('US', 60),
          l('GB', -60), l('GB', -55), l('GB', -50),
          l('FR', 0.1), l('FR', 0.2), l('NL', 0.3),
          l(null, 12.34), l('JP', Number.NaN),
        ],
        { carrierName: 'FedEx', tariffFuelPct: 20 },
      ),
    ).toMatchSnapshot();
  });
  it('varsayılan taşıyıcı adı', () => {
    expect(tariffHealth([l('ES', -15)]).groups.map((g) => g.message)).toMatchSnapshot();
  });
  it('genel not: kur ve aynı para birimi, yakıt notu', () => {
    const fuel = (p: number) => ({ fuelPct: p });
    expect({
      fx: tariffHealth([1, 2, 3, 4, 5].map(() => l('ES', 1, { fx: true })), { carrierName: 'FedEx' }).overallNote,
      fxOver: tariffHealth([1, 2, 3, 4, 5].map(() => l('ES', 2.5, { fx: true })), { carrierName: 'FedEx', fxTolerancePct: 1 }).overallNote,
      same: tariffHealth([1, 2, 3, 4, 5].map(() => l('ES', -2)), {}).overallNote,
      fuelHigh: tariffHealth([l('ES', 1, fuel(30)), l('ES', 1, fuel(30)), l('ES', 1, fuel(30))], { tariffFuelPct: 25 }).fuelNote,
      fuelLow: tariffHealth([l('ES', 1, fuel(20.5)), l('ES', 1, fuel(20.5)), l('ES', 1, fuel(20.5))], { tariffFuelPct: 25 }).fuelNote,
    }).toMatchSnapshot();
  });
});

describe('TR taban: tarife hesabı metinleri', () => {
  const perKg: TariffInput = {
    ...FEDEX,
    discountPct: 10,
    fuelPct: 12.5,
    zones: { ES: 'P', '*': 'A' },
    rates: [{ zone: 'P', weightUpto: 70, price: 100 }, { zone: 'P', weightUpto: 100, price: 4.35, perKg: true }, { zone: 'A', weightUpto: 5, price: 50 }],
    overflowPerUnit: {},
    countryAdjustments: [{ country: 'ES', pct: -15.45, source: 'manual' }],
  };
  it('expectedCharge etiketleri ve sebepleri', () => {
    expect([
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR', surchargeCodes: ['ADDITIONAL_HANDLING'] }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 35, destCountry: 'FR' }),
      expectedCharge({ tariff: perKg, chargeableKg: 80, destCountry: 'ES' }),
      expectedCharge({ tariff: perKg, chargeableKg: 120, destCountry: 'ES' }),
      expectedCharge({ tariff: perKg, chargeableKg: 9, destCountry: 'DE' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'JP' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6 }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'US' }),
      ratePrice(FEDEX, 'B', 50),
    ]).toMatchSnapshot();
  });
});

describe('TR taban: karşılaştırma notları', () => {
  const usd: TariffInput = { ...FEDEX, currency: 'USD' };
  const rate: FxRate = { base: 'USD', quote: 'TRY', rate: 41.2345, date: '2026-10-23', source: 'TCMB' };
  const cmp = (l: ParsedInvoiceLine, over: Partial<Parameters<typeof compareLine>[0]> = {}) =>
    compareLine({ line: l, measurement: meas(40, 30, 25, 4), tariff: FEDEX, tol: TOL, isDuplicate: false, ...over });
  const texts = (r: ReturnType<typeof compareLine>) => ({ status: r.status, note: r.note, reason: r.confidenceReason, labels: r.breakdown.map((b) => b.label) });

  it('her sebep ve döküm dalı', () => {
    const cases = {
      duplicate: cmp(line({ trackingNo: 'a', netAmount: 100 }), { isDuplicate: true }),
      noMeasurement: cmp(line({ trackingNo: 'a', netAmount: 100 }), { measurement: null }),
      pakNoMeasurement: cmp(line({ trackingNo: 'a', netAmount: 100, service: 'FedEx Envelope' }), { measurement: null }),
      pak: cmp(line({ trackingNo: 'a', netAmount: 100, service: 'FedEx Intl Priority Pak' })),
      noTariff: cmp(line({ trackingNo: 'a', netAmount: 100 }), { tariff: null }),
      currencyMismatch: cmp(line({ trackingNo: 'a', netAmount: 100, currency: 'EUR' })),
      fxMissing: cmp(line({ trackingNo: 'a', netAmount: 100 }), { tariff: usd, fx: { date: '2026-10-22', rate: null } }),
      zoneMissing: cmp(line({ trackingNo: 'a', netAmount: 100, destCountry: 'JP' })),
      noCountry: cmp(line({ trackingNo: 'a', netAmount: 100, destCountry: undefined })),
      noRates: cmp(line({ trackingNo: 'a', netAmount: 100, destCountry: 'US' })),
      favourable: cmp(line({ trackingNo: 'a', netAmount: 100, billedKg: 6 })),
      noBilledKg: cmp(line({ trackingNo: 'a', netAmount: 1300 })),
      price: cmp(line({ trackingNo: 'a', netAmount: 5000, billedKg: 6 })),
      extremeWeight: cmp(line({ trackingNo: 'a', netAmount: 1187.33, billedKg: 0.5 })),
      weight: cmp(line({ trackingNo: 'a', netAmount: 2000, billedKg: 15 })),
      dimension: cmp(line({ trackingNo: 'a', netAmount: 2000, billedKg: 15, dims: { l: 60, w: 50, h: 40 } })),
      invoiceBasis: cmp(line({ trackingNo: 'a', netAmount: 800, billedKg: 9.5, baseAmount: 700, discountAmount: 50, fuelAmount: 100, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 50 }] })),
      invoiceBasisCombined: cmp(line({ trackingNo: 'a', netAmount: 800, billedKg: 9.5 })),
      unknownSurcharge: cmp(line({ trackingNo: 'a', netAmount: 1500, billedKg: 6, surcharges: [{ code: 'EPH', name: 'EPH Ücreti', amount: 12.5 }] })),
      strictUnknown: cmp(line({ trackingNo: 'a', netAmount: 1500, billedKg: 6, surcharges: [{ code: 'EPH', amount: 12.5, name: '' }] }), { tol: { ...TOL, unknownSurchargesAsDiff: true } }),
      excessSurcharge: cmp(line({ trackingNo: 'a', netAmount: 1800, billedKg: 6, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 800 }] })),
      fx: cmp(line({ trackingNo: 'a', netAmount: 100000, billedKg: 6 }), { tariff: usd, fx: { date: '2026-10-25', rate } }),
      fxTolerance: cmp(line({ trackingNo: 'a', netAmount: 49000, billedKg: 6 }), { tariff: usd, fx: { date: '2026-10-23', rate } }),
      fxInvoiceBasis: cmp(line({ trackingNo: 'a', netAmount: 30000, billedKg: 9.5 }), { tariff: usd, fx: { date: '2026-10-25', rate } }),
      extremeDeviation: cmp(line({ trackingNo: 'a', netAmount: 10000, billedKg: 6 })),
      noFreight: cmp(line({ trackingNo: 'a', netAmount: 10, billedKg: 6, surcharges: [{ code: 'X', name: 'X', amount: 20 }] })),
      noRateAtKg: cmp(line({ trackingNo: 'a', netAmount: 2000, billedKg: 40, destCountry: 'GB' })),
    };
    expect(Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, texts(r)]))).toMatchSnapshot();
  });
  it('kur kaynağı', () => {
    expect([fxSourceText({ source: 'TCMB', date: '2025-06-03', requestedDate: '2025-06-03' }), fxSourceText({ source: 'TCMB', date: '2025-06-06', requestedDate: '2025-06-07' })]).toMatchSnapshot();
  });
});

describe('TR taban: tarife içe aktarma kontrolleri', () => {
  const raw = (prices: string[][] | null, over: Partial<RawTariffFile> = {}): RawTariffFile => ({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null, ...over });
  const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({ tariffCurrency: 'TRY', currentZones: [{ country: 'DE', zone: 'A' }], currentRates: [], ...over });
  const run = (r: RawTariffFile, c: TariffImportContext = ctx(), o: { convertLbToKg?: boolean; currency?: string; openBandMode?: 'additional' | 'perKg' | 'flat' } = {}, extra: string[] = []) => {
    const parsed = parseTariffImport(r, o);
    const checks = checkTariffImport(parsed, c, o);
    const reasons = { skipped: parsed.skipped, stepIssues: parsed.stepIssues, sheetIssues: parsed.sheetIssues, currencyEvidence: parsed.currencyEvidence, unitEvidence: parsed.unitEvidence };
    return { checks, fixes: tariffImportFixes(parsed, c), summary: importSummaryLine(parsed, c, o), headline: importHeadline(checks, parsed, c, o, extra), reasons };
  };
  const good = [['Ağırlık', 'A', 'B'], ['0,5', '100', '200'], ['1', '150', '250'], ['1,5', '200', '300']];

  it('uygun dosya, notlar', () => {
    expect(run(raw(good), ctx({ currentZones: [{ country: 'DE', zone: 'A' }, { country: 'FR', zone: 'B' }] }), {}, ['otomatik seçim'])).toMatchSnapshot();
  });
  it('hatalar', () => {
    expect({
      noSheet: run(raw(null)),
      noZones: run(raw([['Ağırlık'], ['0,5'], ['1']])),
      noRates: run(raw([['Ağırlık', 'A'], ['abc', 'x']])),
      duplicateZone: run(raw([['Ağırlık', 'A', 'Zone A'], ['0,5', '1', '2']])),
      duplicateWeight: run(raw([['Ağırlık', 'A'], ['0,5', '1'], ['0,5', '2'], ['1', '3']])),
      invalidPrice: run(raw([['Ağırlık', 'A'], ['0,5', 'x'], ['1', '3']])),
      mappingMissing: run(raw(good), ctx({ currentZones: [{ country: 'DE', zone: 'C' }] })),
      mappingMissingMany: run(raw(good, { zones: [['Ülke', 'Bölge'], ['DE', 'C'], ['FR', 'D']] }), ctx()),
      lb: run(raw([['Weight (lbs)', 'A'], ['1 lb', '10'], ['2 lb', '20']])),
      lbConverted: run(raw([['Weight (lbs)', 'A'], ['1 lb', '10'], ['2 lb', '20']]), ctx(), { convertLbToKg: true }),
      currency: run(raw([['Ağırlık', 'A'], ['0,5', '$10'], ['1', '$20']])),
      currencyPdf: run(raw([['Ağırlık', 'A'], ['0,5', '$10'], ['1', '$20']], { kind: 'pdf' })),
    }).toMatchSnapshot();
  });
  it('uyarılar', () => {
    const steps = [['Ağırlık', 'A'], ['10', '100'], ['İlave 0,5 kg', '10'], ['12', '150'], ['14', '180']];
    const base = [{ zone: 'A', weightUpto: 1, price: 100 }];
    expect({
      skipped: run(raw([['Ağırlık', 'A'], ['0,5', '1'], ['abc', '2'], ['', '3'], ['Zarf', '4'], ['1', '5']])),
      sections: run(raw([['Ağırlık', 'A'], ['Başlık', ''], ['0,5', '1'], ['1', '2'], ['Çoklu paket', ''], ['Ağırlık', 'A'], ['0,5', '9']])),
      sheetIssues: run(raw(good, { zones: [['Ülke', 'Bölge'], ['??', 'A'], ['DE', 'A'], ['DE', 'B']], surcharges: [['Kod', 'Ad', 'Tür', 'Tutar'], ['X', 'X', 'BOZUK', '1'], ['Y', 'Y', 'FIXED', '5']] })),
      order: run(raw([['Ağırlık', 'A'], ['0,5', '100'], ['1', '50'], ['1,5', '500']])),
      distance: run(raw([['Desi', 'Şehir İçi', 'Yakın', 'Uzak'], ['1', '1', '2', '3'], ['2', '2', '3', '4']])),
      distanceStar: run(raw([['Desi', 'Şehir İçi', 'Yakın'], ['1', '1', '2'], ['2', '2', '3']]), ctx({ currentZones: [{ country: '*', zone: 'YAKIN' }] })),
      noMapping: run(raw(good), ctx({ currentZones: [] })),
      recent: run(raw(good), ctx({ currentZones: [{ country: 'DE', zone: 'A' }], recent: { countries: ['fr', 'de', 'US'], currencies: ['eur'], maxBilledKg: 50 } })),
      maxLow: run(raw(good), ctx()),
      big: run(raw(good), ctx({ currentRates: base.map((b) => ({ ...b, price: 1000 })) })),
      overflowChanged: run(raw([...good, ['Aşım (kg başı)', '5', '']]), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }, { zone: 'B', perUnit: 4 }] })),
      overflowKept: run(raw(good), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }] })),
      overflowUnit: run(raw([...good, ['Aşım', '5', '6']]), ctx({ currentWeightSteps: [{ upto: null, step: 0.5 }] })),
      otherCurrency: run(raw(good), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }], currentSurcharges: [{ code: 'A', name: 'Ad', kind: 'FIXED', amount: 5 }, { code: 'B', name: '', kind: 'PER_KG', amount: 2 }] }), { currency: 'USD' }),
      otherCurrencyOverflow: run(raw(good), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }] }), { currency: 'USD' }),
      otherCurrencySurcharge: run(raw(good), ctx({ currentSurcharges: [{ code: 'A', name: 'Ad', kind: 'FIXED', amount: 5 }] }), { currency: 'USD' }),
      steps: run(raw(steps)),
      stepUnused: run(raw([['Ağırlık', 'A'], ['İlave 0,5 kg', '10'], ['10', '100'], ['5', '50'], ['İlave 1 kg', '1'], ['2', '20']])),
      stepMismatch: run(raw([['Ağırlık', 'A'], ['10', '100'], ['İlave 0,5 kg', '10'], ['12', '500']])),
      perKg: run(raw([['Ağırlık', 'A'], ['1', '10'], ['2', '20'], ['Kg başına ücret', ''], ['71-99', '4'], ['100+', '3']]), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }] })),
      perKgOnly: run(raw([['Ağırlık', 'A'], ['1 kg başı', '10']])),
      csv: run(raw([['Ağırlık', 'Zone A', 'Zone B'], ['0,5', '1', '2'], ['1', '2', '3']], { kind: 'csv', fileName: 'x.csv' })),
      // önceki satırdan ucuz açık uç artık sorulur (KALANLAR 1.7); "üst sınırsız" metni sabit seçimiyle
      openWeight: run(raw([['Ağırlık', 'A'], ['1', '100'], ['1000+', '50']]), ctx(), { openBandMode: 'flat' }),
      stepAfterLast: run(raw([['Ağırlık', 'A', 'B'], ['1', '100', '50'], ['Aşım (kg başı)', '', '3'], ['İlave 0,5 kg', '10', '']])),
      stepTooWide: run(raw([['Ağırlık', 'A'], ['1', '100'], ['İlave 0,0001 kg', '10'], ['9', '500']])),
      stepOrder: run(raw([['Ağırlık', 'A'], ['9', '100'], ['İlave 0,5 kg', '10'], ['1', '500']])),
    }).toMatchSnapshot();
  });
  it('ham satır dökümü', () => {
    expect(rawRowsText(Array.from({ length: 12 }, (_, i) => [`s${i}`]), 5).text).toMatchSnapshot();
  });
});

describe('TR taban: fatura okuma kontrolü', () => {
  const HEAD = ['Takip No', 'Tarih', 'Ülke', 'Birim', 'Kg', 'Ücretli Kg', 'Kenar', 'En', 'Boy', 'Bölen', 'Navlun', 'Yakıt', 'Para', 'Net Tutar', 'Fatura No', 'Fatura Tarihi', 'Fatura Toplamı', 'Olmayan'];
  const CELLS: Record<string, string> = { Tarih: '20.10.2026', Ülke: 'DE', Birim: 'kg', Kg: '4', 'Ücretli Kg': '6', Kenar: '40', En: '30', Boy: '25', Bölen: '5000', Navlun: '1000,00', Yakıt: '250,00', Para: 'TRY', 'Net Tutar': '1250,00', 'Fatura No': 'F1', 'Fatura Tarihi': '20.10.2026', 'Fatura Toplamı': '5000,00', Olmayan: '' };
  const row = (t: string, over: Partial<Record<string, string>> = {}) => HEAD.map((h) => over[h] ?? (h === 'Takip No' ? t : CELLS[h]!));
  const map = (over: Partial<ColumnMapping> = {}): ColumnMapping => ({
    ...emptyMapping(),
    trackingNo: 'Takip No',
    shipDate: 'Tarih',
    destCountry: 'Ülke',
    actualKg: 'Kg',
    actualKgUnit: 'Birim',
    billedKg: 'Ücretli Kg',
    dimL: 'Kenar',
    dimW: 'En',
    dimH: 'Boy',
    billedDivisor: 'Bölen',
    baseAmount: 'Navlun',
    fuelAmount: 'Yakıt',
    currency: 'Para',
    netAmount: 'Net Tutar',
    invoiceNo: 'Fatura No',
    invoiceDate: 'Fatura Tarihi',
    invoiceTotal: 'Fatura Toplamı',
    ...over,
  });
  const good = ['794812345301', '794812345302', '794812345303', '794812345304'].map((t) => row(t));
  const bad = [
    row('794812345301', { Tarih: 'dün', Ülke: 'Mars', Birim: '??', Kg: '5000', Kenar: '900', Bölen: '5', Navlun: 'x', Para: '???', 'Fatura Tarihi': 'dün', 'Fatura Toplamı': '1,00', 'Ücretli Kg': '900' }),
    row('12'),
    row('12'),
    row('12'),
    row('ABCDEF'),
    row('794812345399', { 'Net Tutar': 'yok' }),
    row('794812345398', { 'Net Tutar': '' }),
    row(''),
  ];
  const texts = (t: ReturnType<typeof tableFromMatrix>, m: ColumnMapping) => {
    const d = mappingDiagnostics(t, m);
    return { warnings: d.warnings.map((w) => w.message), issues: d.verification.issues, fields: Object.fromEntries(Object.entries(d.verification.fields).map(([k, v]) => [k, v.reasons])), errors: parseRows(t, m).errors };
  };
  it('temiz tablo', () => {
    expect(texts(tableFromMatrix([HEAD, ...good]), map())).toMatchSnapshot();
  });
  it('sorunlu tablo', () => {
    expect(texts(tableFromMatrix([HEAD, ...bad]), map())).toMatchSnapshot();
  });
  it('eksik eşleme ve boş sütunlar', () => {
    const t = tableFromMatrix([HEAD, ...good]);
    const same = tableFromMatrix([HEAD, ...Array.from({ length: 6 }, (_, i) => row(`79481234530${i}`))]);
    const emptyCol = tableFromMatrix([HEAD, ...good.map((r) => r.map((c, i) => (HEAD[i] === 'Net Tutar' || HEAD[i] === 'Takip No' ? '' : c)))]);
    const halfFilled = tableFromMatrix([HEAD, ...['794812345301', '794812345302', '794812345303', '', '', '', ''].map((x) => row(x))]);
    const sameTrack = tableFromMatrix([HEAD, ...['794812345301', '794812345301', '794812345301', '794812345302'].map((x) => row(x))]);
    expect({
      noTracking: texts(t, map({ trackingNo: undefined })),
      noNet: texts(t, map({ netAmount: undefined })),
      missingCol: texts(t, map({ service: 'Yok', invoiceNo: 'Yok' })),
      netConstant: texts(same, map()),
      emptyCols: texts(emptyCol, map()),
      halfFilled: texts(halfFilled, map()),
      sameTrack: texts(sameTrack, map()),
      desi: texts(t, map({ desiAsWeight: true, dims: 'Kenar', dimL: undefined, dimW: undefined, dimH: undefined, dimUnit: 'Birim', billedKgUnit: 'Birim' })),
      verify: verifyMapping(t, map()).issues,
      emptyOptional: texts(tableFromMatrix([[...HEAD, 'Hizmet'], ...good.map((r) => [...r, ''])]), map({ service: 'Hizmet' })),
      noLines: texts(tableFromMatrix([HEAD, ...['ABCDEF', 'GHIJKL'].map((x) => row(x))]), map()),
      chargesMismatch: texts(tableFromMatrix([HEAD, ...good.map((r) => r.map((c, i) => (HEAD[i] === 'Navlun' ? '1,00' : c)))]), map()),
    }).toMatchSnapshot();
  });
});

describe('TR taban: PDF belge notları', () => {
  it('KDV ve kur notu, ek ücret muafiyeti', () => {
    const page = 'Tüm fiyatlar USD. Fiyatlar KDV hariçtir. Günlük kur uygulanır. Uzak bölge muafiyet Residential 100%';
    expect(detectDocumentFacts([page])).toMatchSnapshot();
  });
});
