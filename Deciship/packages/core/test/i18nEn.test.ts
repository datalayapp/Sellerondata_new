import { describe, expect, it } from 'vitest';
import {
  buildDisputeText,
  buildWhatsAppText,
  checkTariffImport,
  compareLine,
  emptyMapping,
  expectedCharge,
  importHeadline,
  invoiceFileMessage,
  invoiceSummarySentence,
  mappingDiagnostics,
  overchargeNote,
  parseTariffImport,
  tableFromMatrix,
  tariffHealth,
  tariffImportFixes,
  type ColumnMapping,
  type DisputeInput,
  type HealthLineInput,
  type ParsedInvoiceLine,
  type RawTariffFile,
  type TariffImportContext,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/** EN metinlerin anlık görüntüleri: metin bilerek değişmedikçe sabit kalır. */

const dispute: Omit<DisputeInput, 'lang'> = {
  company: { name: 'Demo Export', contactName: 'Elif Kaya', email: 'elif@demo.com', phone: '+90 212 000 00 00' },
  carrier: { name: 'FedEx', accountNo: '123456789' },
  invoice: { invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY' },
  lines: [
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
    {
      trackingNo: '794812345293',
      diffTypes: ['SURCHARGE', 'WEIGHT'],
      decision: 'VERIFIED',
      ourChargeableKg: 4.5,
      billedChargeableKg: 1250,
      expectedAmount: null,
      billedAmount: 1377.84,
      diffAmount: 412,
      surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 }, { code: 'PEAK', amount: 12.5 }],
    },
  ],
};

describe('EN: itiraz metni', () => {
  it('tam metin', () => {
    expect(buildDisputeText({ ...dispute, lang: 'en' })).toMatchSnapshot();
  });
  it('tek gönderi: tekil, müşteri no ve tarih yok', () => {
    const r = buildDisputeText({ ...dispute, company: { name: 'Demo Export' }, carrier: { name: 'UPS' }, invoice: { invoiceNo: 'X1', currency: 'USD' }, lines: [dispute.lines[0]!], lang: 'en' });
    expect(r).toMatchSnapshot();
    expect(r.subject).toContain('(1 shipment, 458.50 USD)');
    expect(r.body).toContain('the following 1 shipment:');
  });
  it('EN metinde Türkçe sabit kalmaz', () => {
    const { subject, body } = buildDisputeText({ ...dispute, lang: 'en' });
    expect(subject + body).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(body).toContain('Oct 27, 2026');
  });
});

describe('EN: özet, uyum, karşılaştırma', () => {
  it('fatura özeti', () => {
    const base = { lines: 120, match: 16, diff: 3, unmatched: 63, noTariff: 38, billedTotal: 1000, expectedTotal: 900, pakUnmatched: 10, pakNoTariff: 28 };
    expect({
      sentence: invoiceSummarySentence(base, 'en'),
      noDiff: invoiceSummarySentence({ ...base, diff: 0 }, 'en'),
      big: invoiceSummarySentence({ lines: 1200, match: 1000, diff: 100, unmatched: 50, noTariff: 50, billedTotal: 0, expectedTotal: 0 }, 'en'),
      all: invoiceSummarySentence({ lines: 1, match: 1, diff: 0, unmatched: 0, noTariff: 0, billedTotal: 0, expectedTotal: 0 }, 'en'),
      note: overchargeNote(base, 50, 'en'),
    }).toMatchSnapshot();
  });
  it('WhatsApp', () => {
    expect(buildWhatsAppText({ carrierName: 'FedEx', invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', lines: 18, diff: 4, unmatched: 1, overchargeTotal: 1731.2, disputeLastDay: '2026-11-04' }, 'en')).toMatchSnapshot();
  });
  it('tarife uyumu', () => {
    const l = (destCountry: string | null, rateDeviationPct: number, over: Partial<HealthLineInput> = {}): HealthLineInput => ({ destCountry, service: 'IE', zone: 'A', rateDeviationPct, fx: false, ...over });
    const report = tariffHealth(
      [l('ES', -15), l('ES', -15.4), l('ES', -14.6), l('DE', 8), l('DE', 8.5), l('DE', 7.5), l('US', 50), l('US', 55), l('US', 60), l('GB', -60), l('FR', 0.1), l(null, 12.34)],
      { carrierName: 'FedEx', tariffFuelPct: 20, locale: 'en' },
    );
    expect(report.groups.map((g) => [g.countryName, g.message])).toMatchSnapshot();
    expect(tariffHealth([1, 2, 3, 4, 5].map(() => l('ES', 1, { fx: true, fuelPct: 30 })), { carrierName: 'FedEx', tariffFuelPct: 25, locale: 'en' })).toMatchObject({
      overallNote: expect.stringContaining('The exchange rate tolerance (1.5%) covers this difference.'),
      fuelNote: expect.stringContaining('The invoice fuel rate is 30%, your tariff has 25%.'),
    });
  });
  it('karşılaştırma notları ve döküm', () => {
    const cmp = (l: ParsedInvoiceLine, over: Partial<Parameters<typeof compareLine>[0]> = {}) => {
      const r = compareLine({ line: l, measurement: meas(40, 30, 25, 4), tariff: FEDEX, tol: TOL, isDuplicate: false, locale: 'en', ...over });
      return { note: r.note, reason: r.confidenceReason, labels: r.breakdown.map((b) => b.label) };
    };
    expect({
      duplicate: cmp(line({ trackingNo: 'a', netAmount: 100 }), { isDuplicate: true }),
      noTariff: cmp(line({ trackingNo: 'a', netAmount: 100 }), { tariff: null }),
      favourable: cmp(line({ trackingNo: 'a', netAmount: 100, billedKg: 6 })),
      invoiceBasis: cmp(line({ trackingNo: 'a', netAmount: 800, billedKg: 9.5, baseAmount: 700, discountAmount: 50, fuelAmount: 100, surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 50 }] })),
      unknown: cmp(line({ trackingNo: 'a', netAmount: 1500, billedKg: 6, surcharges: [{ code: 'EPH', name: 'EPH Ücreti', amount: 12.5 }] })),
      noBilledKg: cmp(line({ trackingNo: 'a', netAmount: 1300 })),
      extreme: cmp(line({ trackingNo: 'a', netAmount: 10000, billedKg: 6 })),
    }).toMatchSnapshot();
  });
  it('doğrudan tarife hesabı', () => {
    expect([
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR', surchargeCodes: ['ADDITIONAL_HANDLING'], locale: 'en' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 35, destCountry: 'FR', locale: 'en' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'JP', locale: 'en' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, locale: 'en' }),
      expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'US', locale: 'en' }),
    ]).toMatchSnapshot();
  });
});

describe('EN: tarife içe aktarma', () => {
  const raw = (prices: string[][] | null, over: Partial<RawTariffFile> = {}): RawTariffFile => ({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null, ...over });
  const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({ tariffCurrency: 'TRY', currentZones: [{ country: 'DE', zone: 'A' }], currentRates: [], ...over });
  const run = (r: RawTariffFile, c = ctx(), o: { currency?: string } = {}) => {
    const parsed = parseTariffImport(r, o);
    const checks = checkTariffImport(parsed, c, o, 'en');
    return { checks: checks.map((x) => [x.code, x.title, x.detail, x.suggestion]), fixes: tariffImportFixes(parsed, c, 'en').map((f) => f.label), headline: importHeadline(checks, parsed, c, o, [], 'en') };
  };
  const good = [['Weight', 'A', 'B'], ['0.5', '100', '200'], ['1', '150', '250'], ['1.5', '200', '300']];
  it('uyarı ve hatalar', () => {
    expect({
      ok: run(raw(good), ctx({ currentZones: [{ country: 'DE', zone: 'A' }, { country: 'FR', zone: 'B' }] })),
      noSheet: run(raw(null)),
      skipped: run(raw([['Weight', 'A'], ['0.5', '1'], ['abc', '2'], ['', '3'], ['Zarf', '4'], ['1', '5']])),
      currency: run(raw([['Weight', 'A'], ['0.5', '$10'], ['1', '$20']])),
      lb: run(raw([['Weight (lbs)', 'A'], ['1 lb', '10'], ['2 lb', '20']])),
      sheet: run(raw(good, { zones: [['Country', 'Zone'], ['??', 'A'], ['DE', 'A'], ['DE', 'B']] })),
      otherCurrency: run(raw(good), ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }], currentSurcharges: [{ code: 'A', name: 'Name', kind: 'FIXED', amount: 5 }] }), { currency: 'USD' }),
      step: run(raw([['Weight', 'A'], ['Additional 0.5 kg', '10'], ['10', '100']])),
    }).toMatchSnapshot();
  });
});

describe('EN: fatura okuma kontrolü', () => {
  it('sorunlu tablo', () => {
    const t = tableFromMatrix([['Tracking', 'Net'], ['794812345301', 'x'], ['12', '10.00'], ['12', '10.00'], ['ABCDEF', '10.00']]);
    const m: ColumnMapping = { ...emptyMapping(), trackingNo: 'Tracking', netAmount: 'Net', service: 'Missing' };
    const d = mappingDiagnostics(t, m, { locale: 'en' });
    expect({ warnings: d.warnings.map((w) => w.message), issues: d.verification.issues }).toMatchSnapshot();
  });
});

describe('EN: dosya yük sınırları (Mesaj 6)', () => {
  it('açılmış boyut, satır ve sayfa sınırı', () => {
    expect([
      invoiceFileMessage('XLSX_TOO_LARGE', 'en'),
      invoiceFileMessage('TOO_MANY_ROWS', 'en', { limit: '200,000' }),
      invoiceFileMessage('PDF_TOO_MANY_PAGES', 'en', { limit: 300 }),
    ]).toMatchSnapshot();
  });
});
