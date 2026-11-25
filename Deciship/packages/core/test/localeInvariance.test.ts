import { describe, expect, it } from 'vitest';
import {
  buildDisputeText,
  checkTariffImport,
  compareLine,
  emptyMapping,
  expectedCharge,
  localizeComparison,
  mappingDiagnostics,
  parseRows,
  parseTariffImport,
  tableFromMatrix,
  tariffHealth,
  verifyMapping,
  type ComparisonResult,
  type DiffType,
  type DisputeLine,
  type FxRate,
  type HealthLineInput,
  type ParsedInvoiceLine,
  type TariffInput,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

/** Özellik testi: aynı girdide hesap sonucu her dilde aynı. Tohumlu üreteç: başarısızlık yeniden üretilebilir. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const USD: TariffInput = { ...FEDEX, id: 'usd', currency: 'USD' };
const ADJ: TariffInput = { ...FEDEX, id: 'adj', countryAdjustments: [{ country: 'FR', pct: -15.45, source: 'manual' }, { country: 'DE', pct: 3, source: 'invoice' }] };
const RATE: FxRate = { base: 'USD', quote: 'TRY', rate: 41.2345, date: '2026-10-23', source: 'TCMB' };

/** Metin alanları dışındaki her şey: dil değiştiğinde değişmemesi gereken sonuç. */
function numbersOf(r: ComparisonResult) {
  const { note: _n, confidenceReason, breakdown, ...rest } = r;
  return { ...rest, hasReason: confidenceReason != null, breakdown: breakdown.map(({ label: _l, ...b }) => b) };
}

describe('hesap sonucu dilden bağımsız', () => {
  it('compareLine: 3000 rastgele satır', () => {
    const rnd = prng(20261106);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const num = (a: number, b: number, dp = 2) => Number((a + rnd() * (b - a)).toFixed(dp));
    let withNote = 0;
    for (let i = 0; i < 3000; i++) {
      const surcharges = rnd() < 0.3 ? [{ code: pick(['ADDITIONAL_HANDLING', 'REMOTE_AREA', 'EPH', 'COD']), name: pick(['Ek elleçleme', 'EPH Ücreti', '']), amount: num(1, 900) }] : [];
      const l: ParsedInvoiceLine = line({
        trackingNo: `79481234${i}`,
        netAmount: num(1, 12000),
        destCountry: pick(['FR', 'DE', 'GB', 'US', 'JP', undefined]) as string | undefined,
        currency: pick(['TRY', 'TRY', 'USD', 'EUR']),
        service: pick(['FedEx Intl Economy', 'FedEx Envelope', undefined]) as string | undefined,
        surcharges,
        ...(rnd() < 0.8 ? { billedKg: num(0.3, 40, 1) } : {}),
        ...(rnd() < 0.3 ? { actualKg: num(0.3, 40, 2) } : {}),
        ...(rnd() < 0.3 ? { dims: { l: num(5, 90, 1), w: num(5, 70, 1), h: num(5, 60, 1) } } : {}),
        ...(rnd() < 0.3 ? { baseAmount: num(10, 5000), discountAmount: num(0, 500) } : {}),
        ...(rnd() < 0.3 ? { fuelAmount: num(0, 800) } : {}),
      });
      const input = {
        line: l,
        measurement: rnd() < 0.85 ? meas(num(5, 90, 1), num(5, 70, 1), num(5, 60, 1), num(0.2, 30, 2)) : null,
        tariff: pick([FEDEX, FEDEX, ADJ, USD, null]),
        tol: { ...TOL, ...(rnd() < 0.2 ? { unknownSurchargesAsDiff: true } : {}) },
        isDuplicate: rnd() < 0.05,
        ...(rnd() < 0.5 ? { fx: { date: '2026-10-25', rate: rnd() < 0.8 ? RATE : null } } : {}),
      };
      const def = compareLine(input);
      const tr = compareLine({ ...input, locale: 'tr' });
      const en = compareLine({ ...input, locale: 'en' });
      expect(tr).toEqual(def);
      expect(numbersOf(en)).toEqual(numbersOf(tr));
      // kayıtlı TR sonucu okurken çevirmek, doğrudan EN üretmekle aynı
      expect(localizeComparison(def, 'en')).toEqual(en);
      if (en.note) {
        withNote++;
        // tanınan bütün notlar çevrildi: üretilen metinde bilinen Türkçe kalıp kalmaz
        expect(en.note, en.note).not.toMatch(/fatura |tarife |Kur |takip no|ölçüm|Lehimize|kapsam dışı|ek ücret/);
      }
      for (const b of en.breakdown) expect(b.label, b.label).not.toMatch(/Tarife fiyatı|İndirim %|Yakıt %|Taşıma|istisnası|olurdu|^Beklenen /);
      if (en.confidenceReason) expect(en.confidenceReason).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
    expect(withNote).toBeGreaterThan(500);
  });

  it('expectedCharge: tutarlar aynı', () => {
    const rnd = prng(7);
    for (let i = 0; i < 500; i++) {
      const input = { tariff: rnd() < 0.5 ? FEDEX : ADJ, chargeableKg: Math.round(rnd() * 400) / 10, destCountry: ['FR', 'DE', 'GB', 'US', 'JP', undefined][Math.floor(rnd() * 6)], surchargeCodes: rnd() < 0.5 ? ['ADDITIONAL_HANDLING', 'REMOTE_AREA', 'INSURANCE'] : [] };
      const tr = expectedCharge(input);
      const en = expectedCharge({ ...input, locale: 'en' });
      expect(en.ok).toBe(tr.ok);
      if (tr.ok && en.ok) {
        expect({ ...en, lines: en.lines.map((l) => l.amount) }).toEqual({ ...tr, lines: tr.lines.map((l) => l.amount) });
      }
    }
  });

  it('buildDisputeText: toplam ve satır sayısı aynı', () => {
    const rnd = prng(11);
    const types: DiffType[] = ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE'];
    for (let i = 0; i < 300; i++) {
      const lines: DisputeLine[] = Array.from({ length: Math.floor(rnd() * 8) }, (_, k) => ({
        trackingNo: `T${k}`,
        diffTypes: [types[Math.floor(rnd() * types.length)]!],
        decision: (['OPEN', 'VERIFIED', 'ACCEPTED', undefined] as const)[Math.floor(rnd() * 4)],
        status: (['DIFF', 'MATCH', undefined] as const)[Math.floor(rnd() * 3)],
        ourChargeableKg: rnd() * 30,
        billedChargeableKg: rnd() * 30,
        expectedAmount: rnd() * 1000,
        billedAmount: rnd() * 2000,
        diffAmount: rnd() * 2000 - 500,
      }));
      const base = { company: { name: 'C' }, carrier: { name: 'FedEx' }, invoice: { invoiceNo: 'I', currency: 'TRY' }, lines };
      const tr = buildDisputeText({ ...base, lang: 'tr' });
      const en = buildDisputeText({ ...base, lang: 'en' });
      expect([en.total, en.lineCount]).toEqual([tr.total, tr.lineCount]);
    }
  });

  it('tariffHealth: metin dışı her alan ve grup sırası aynı', () => {
    const rnd = prng(13);
    const strip = (r: ReturnType<typeof tariffHealth>) => ({
      ...r,
      overallNote: r.overallNote != null,
      fuelNote: r.fuelNote != null,
      groups: r.groups.map(({ message: _m, countryName: _c, ...g }) => g),
    });
    for (let i = 0; i < 200; i++) {
      const lines: HealthLineInput[] = Array.from({ length: Math.floor(rnd() * 40) }, () => ({
        destCountry: ['ES', 'DE', 'FR', 'US', 'GB', 'JP', null][Math.floor(rnd() * 7)],
        service: ['IE', 'IP'][Math.floor(rnd() * 2)],
        zone: ['A', 'B'][Math.floor(rnd() * 2)],
        rateDeviationPct: rnd() < 0.1 ? null : (rnd() - 0.5) * (rnd() < 0.5 ? 6 : 100),
        adjustmentPct: rnd() < 0.2 ? -5 : null,
        fx: rnd() < 0.3,
        fuelPct: rnd() < 0.5 ? 20 + rnd() * 10 : null,
      }));
      const opts = { carrierName: 'FedEx', tariffFuelPct: 25 };
      expect(strip(tariffHealth(lines, { ...opts, locale: 'en' }))).toEqual(strip(tariffHealth(lines, opts)));
    }
  });

  it('checkTariffImport: kodlar, önem dereceleri ve satırlar aynı', () => {
    const rnd = prng(17);
    const cell = () => (rnd() < 0.1 ? 'x' : rnd() < 0.1 ? '' : (rnd() * 900).toFixed(2).replace('.', ','));
    const shape = (issues: ReturnType<typeof checkTariffImport>) => issues.map((i) => [i.code, i.severity, i.rows]);
    for (let i = 0; i < 200; i++) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, k) => [rnd() < 0.05 ? 'abc' : String(0.5 * (k + 1)).replace('.', ','), cell(), cell()]);
      const parsed = parseTariffImport({ fileName: 'x.xlsx', kind: rnd() < 0.3 ? 'pdf' : 'xlsx', prices: [['Ağırlık', 'A', rnd() < 0.1 ? 'A' : 'B'], ...rows], zones: null, surcharges: null });
      const ctx = { tariffCurrency: 'TRY', currentZones: rnd() < 0.5 ? [{ country: 'DE', zone: 'A' }] : [{ country: 'DE', zone: 'C' }], currentRates: [{ zone: 'A', weightUpto: 1, price: 100 }], currentOverflow: rnd() < 0.3 ? [{ zone: 'A', perUnit: 3 }] : [] };
      const opts = rnd() < 0.2 ? { currency: 'USD' } : {};
      expect(shape(checkTariffImport(parsed, ctx, opts, 'en'))).toEqual(shape(checkTariffImport(parsed, ctx, opts)));
    }
  });

  it('verifyMapping ve mappingDiagnostics: kararlar aynı', () => {
    const rnd = prng(19);
    const HEAD = ['Takip No', 'Tarih', 'Kg', 'Net', 'Toplam'];
    const map = { ...emptyMapping(), trackingNo: 'Takip No', shipDate: 'Tarih', actualKg: 'Kg', netAmount: 'Net', invoiceTotal: 'Toplam' };
    const strip = <T extends ReturnType<typeof verifyMapping>>(v: T) => ({
      ...v,
      issues: v.issues.length,
      fields: Object.fromEntries(Object.entries(v.fields).map(([k, f]) => [k, { status: f.status, confidence: f.confidence, reasons: f.reasons.length }])),
    });
    for (let i = 0; i < 150; i++) {
      const rows = Array.from({ length: Math.floor(rnd() * 10) }, (_, k) => [
        rnd() < 0.1 ? 'ABCDEF' : `7948123453${k}`,
        rnd() < 0.1 ? 'dün' : '20.10.2026',
        rnd() < 0.1 ? '5000' : '4',
        rnd() < 0.1 ? 'yok' : '10,00',
        '100,00',
      ]);
      const t = tableFromMatrix([HEAD, ...rows]);
      expect(strip(verifyMapping(t, map, { locale: 'en' }))).toEqual(strip(verifyMapping(t, map)));
      const de = mappingDiagnostics(t, map, { locale: 'en' });
      const dt = mappingDiagnostics(t, map);
      expect(de.warnings.map((w) => w.code)).toEqual(dt.warnings.map((w) => w.code));
      expect(de.parsedLines).toBe(dt.parsedLines);
      expect(parseRows(t, map, 'en').lines).toEqual(parseRows(t, map).lines);
    }
  });
});
