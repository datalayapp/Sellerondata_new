import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareLine,
  findBestTrackingMatch,
  normalizeTracking,
  parseRows,
  readTable,
  sumMoney,
  suggestMapping,
  type CarrierCode,
  type ComparisonResult,
  type MeasurementInput,
  type TariffInput,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = resolve(here, '../../../samples');

type SeedTariff = {
  name: string;
  currency: string;
  divisor: number;
  edgeRounding: 'CEIL_CM' | 'NONE';
  weightSteps: { upto: number | null; step: number }[];
  discountPct: number;
  fuelPct: number;
  zones: { country: string; zone: string }[];
  rates: { zone: string; weightUpto: number; price: number }[];
  overflow: { zone: string; perUnit: number }[];
  surcharges: { code: string; name: string; kind: 'FIXED' | 'PCT' | 'PER_KG'; amount: number }[];
};

function toTariffInput(t: SeedTariff): TariffInput {
  return {
    id: t.name,
    currency: t.currency,
    divisor: t.divisor,
    edgeRounding: t.edgeRounding,
    weightSteps: t.weightSteps,
    discountPct: t.discountPct,
    fuelPct: t.fuelPct,
    zones: Object.fromEntries(t.zones.map((z) => [z.country, z.zone])),
    rates: t.rates,
    overflowPerUnit: Object.fromEntries(t.overflow.map((o) => [o.zone, o.perUnit])),
    surcharges: t.surcharges,
  };
}

type GoldenLine = {
  row: number;
  trackingNo: string;
  scenario: string;
  status: string;
  diffTypes: string[];
  ourChargeableKg: number | null;
  billedChargeableKg: number | null;
  expectedAmount: number | null;
  billedAmount: number;
  diffAmount: number | null;
  note?: string;
  /** KALANLAR 1.8: yalnız "İncele" satırında (aynı dosyada tekrarlanan takip no'nun mükerreri) */
  confidence?: 'LOW';
  reviewCode?: string;
};
type GoldenTotals = {
  lines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  billedTotal: number;
  expectedTotal: number;
  overchargeTotal: number;
};
type GoldenInvoice = {
  id: string;
  file: string;
  carrierCode: string;
  tariff: string;
  suggestedMapping: Record<string, unknown> & { surchargeColumns: { header: string; code: string }[] };
  lines: GoldenLine[];
  totals: GoldenTotals;
  /** "İncele" (LOW) fark satırları: Fazla ödeme (kesin) dışında */
  reviewTotals: { estimatedOverchargeTotal: number; estimatedLines: number };
};

/**
 * Denetim 04-B9: aynı altın örnekler firmanın VARSAYILAN ayarıyla da koşar. Varsayılanda tarifede olmayan ek ücret fark
 * sayılmaz, faturadaki tutarıyla beklenene eklenir (samples/README.md). expected.json yalnız katı kuralın sonucunu tutar;
 * varsayılan sonuç ondan README kuralıyla türetilir. Tarifede olmayan ek ücretlerin (KDV hariç) fatura tutarları
 * üreticideki satır tanımlarından (samples/tools/generate.mjs `extra`) alındı; anahtar `fatura kimliği#satır`.
 */
const UNLISTED_SURCHARGE: Record<string, number> = {
  'fedex-9-482-11735#7': 412, // ADDRESS_CORRECTION
  'fedex-9-482-11736#2': 96.5, // RESIDENTIAL (ölçü farkıyla birlikte)
  'ups-0000F4A71X#7': 395, // ADDRESS_CORRECTION
  'dhl-SIN-4471029#7': 185, // EMERGENCY_SITUATION
  'aras-ARS-2026-004871#6': 38, // ADRES_DUZELTME (KDV hariç sütun; fatura toplamı KDV dahil)
  'yurtici-YK-2026-118833#7': 35, // ADRES_DEGISIKLIGI
  'mng-MNG-2026-77120#6': 40, // ADRES_DUZELTME
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function defaultModeLine(invId: string, l: GoldenLine, amountTol: number): GoldenLine {
  const x = UNLISTED_SURCHARGE[`${invId}#${l.row}`];
  if (x == null) return l;
  const diffTypes = l.diffTypes.filter((d) => d !== 'SURCHARGE');
  const diffAmount = round2(l.diffAmount! - x);
  if (diffTypes.length === 0 && diffAmount > amountTol) diffTypes.push('PRICE');
  return { ...l, diffTypes, status: diffTypes.length ? 'DIFF' : 'MATCH', expectedAmount: round2(l.expectedAmount! + x), diffAmount };
}

function totalsOf(lines: GoldenLine[]): GoldenTotals {
  return {
    lines: lines.length,
    match: lines.filter((l) => l.status === 'MATCH').length,
    diff: lines.filter((l) => l.status === 'DIFF').length,
    unmatched: lines.filter((l) => l.status === 'UNMATCHED').length,
    noTariff: lines.filter((l) => l.status === 'NO_TARIFF').length,
    billedTotal: sumMoney(lines.map((l) => l.billedAmount)),
    expectedTotal: sumMoney(lines.filter((l) => l.expectedAmount != null).map((l) => l.expectedAmount!)),
    // "İncele" satırı Fazla ödeme (kesin) dışında (KALANLAR 1.8)
    overchargeTotal: sumMoney(lines.filter((l) => l.status === 'DIFF' && l.confidence !== 'LOW' && (l.diffAmount ?? 0) > 0).map((l) => l.diffAmount!)),
  };
}

describe('samples/ golden invoices', () => {
  // Örnek klasörü depoda izlenir; yoksa takım sessizce atlanmaz, kırılır.
  it('samples/ klasörü yerinde', () => {
    expect(existsSync(resolve(samplesDir, 'expected.json'))).toBe(true);
  });
  const load = (f: string) => JSON.parse(readFileSync(resolve(samplesDir, f), 'utf8'));
  const expected = load('expected.json');
  const tariffs: { code: string; tariffs: SeedTariff[] }[] = load('seed-tariffs.json');
  const seedMeasurements: { trackingRaw: string; lengthCm: number; widthCm: number; heightCm: number; weightKg: number; measuredAt: string }[] =
    load('seed-measurements.json');
  const measurements: (MeasurementInput & { trackingRaw: string })[] = seedMeasurements
    .map((m, i) => ({
      id: `m${i}`,
      trackingRaw: m.trackingRaw,
      dims: { l: m.lengthCm, w: m.widthCm, h: m.heightCm },
      actualKg: m.weightKg,
      measuredAt: m.measuredAt,
    }))
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
  const baseTol = expected.tolerances ?? { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5 };

  const order: string[] = expected.uploadOrder ?? expected.invoices.map((i: { id: string }) => i.id);
  const invoices: GoldenInvoice[] = [...expected.invoices].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  // KALANLAR 1.8: #5288'in ikinci satırı (1.120,00) aynı dosyada tekrar → "İncele", Fazla ödeme dışında
  it('varsayılan ayar beklentisi README ile tutarlı (FedEx 9-482-11735: 13 uyumlu / 4 fark / 611,20)', () => {
    const inv = invoices.find((i) => i.id === 'fedex-9-482-11735');
    if (!inv) throw new Error('fedex-9-482-11735 yok');
    const t = totalsOf(inv.lines.map((l) => defaultModeLine(inv.id, l, baseTol.amountTol)));
    expect({ match: t.match, diff: t.diff, overcharge: t.overchargeTotal }).toEqual({ match: 13, diff: 4, overcharge: 611.2 });
    // tablodaki her kayıt katı kuralda yalnız tarifede olmayan ek ücret yüzünden SURCHARGE olan bir altın satıra denk gelir
    for (const key of Object.keys(UNLISTED_SURCHARGE)) {
      const [id, row] = key.split('#');
      const l = invoices.find((i) => i.id === id)?.lines.find((x) => x.row === Number(row));
      expect({ key, surcharge: l?.diffTypes.includes('SURCHARGE') ?? false }).toEqual({ key, surcharge: true });
    }
  });

  const modes = [
    // Altın sonuçlar katı kuralla yazıldı: tarifede olmayan ek ücretler fark sayılır (ayar "Tarifede olmayan ek ücretleri fark say").
    { name: 'katı ayar (tarifede olmayan ek ücret fark sayılır)', strict: true },
    { name: 'varsayılan ayar (tarifede olmayan ek ücret beklenene eklenir)', strict: false },
  ];
  for (const mode of modes) {
    describe(mode.name, () => {
      const tol = { ...baseTol, unknownSurchargesAsDiff: mode.strict };
      const seenTracking = new Set<string>();

      for (const inv of invoices) {
        it(`${inv.file}: önerilen eşleme + satır sonuçları`, async () => {
          const bytes = new Uint8Array(readFileSync(resolve(samplesDir, inv.file)));
          const table = await readTable(inv.file, bytes);
          const { mapping, missing, confidence } = suggestMapping(table.headers, inv.carrierCode as CarrierCode);
          expect(missing).toEqual([]);
          expect(confidence).toBeGreaterThan(0.7);

          const golden = inv.suggestedMapping;
          for (const [field, value] of Object.entries(golden)) {
            if (field === 'surchargeColumns') continue;
            expect({ field, value: (mapping as Record<string, unknown>)[field] }).toEqual({ field, value });
          }
          const sc = (xs: { header: string; code: string }[]) => [...xs].sort((a, b) => a.header.localeCompare(b.header));
          expect(sc(mapping.surchargeColumns)).toEqual(sc(golden.surchargeColumns));

          const { lines, errors } = parseRows(table, mapping);
          expect(errors).toEqual([]);
          expect(lines).toHaveLength(inv.lines.length);
          for (const l of lines) {
            expect(Object.keys(l)).not.toContain('recipientName');
            expect(JSON.stringify(l)).not.toMatch(/Hauptstrasse|Rue de la Paix|Mah\. No/);
          }

          const goldenLines = mode.strict ? inv.lines : inv.lines.map((l) => defaultModeLine(inv.id, l, baseTol.amountTol));
          const tariff = toTariffInput(tariffs.find((c) => c.code === inv.carrierCode)!.tariffs.find((t) => t.name === inv.tariff)!);
          const results: ComparisonResult[] = [];
          // KALANLAR 1.8: takip no bu dosyada birden çok ücret satırında (artı tutarlı) → satırın hiçbir farkı kesin değil
          const inFile = new Map<string, number>();
          for (const l of lines) if (l.netAmount > 0) inFile.set(normalizeTracking(l.trackingNo), (inFile.get(normalizeTracking(l.trackingNo)) ?? 0) + 1);
          lines.forEach((line, idx) => {
            const exp = goldenLines[idx]!;
            expect(line.trackingNo).toBe(exp.trackingNo);
            const key = normalizeTracking(line.trackingNo);
            const isDuplicate = seenTracking.has(key);
            seenTracking.add(key);
            const measurement = findBestTrackingMatch(line.trackingNo, measurements, (m) => m.trackingRaw);
            const repeatedInFile = (inFile.get(key) ?? 0) > 1;
            const r = compareLine({ line, measurement, tariff, tol, isDuplicate, repeatedInFile });
            results.push(r);
            const ctx = `${inv.file} satır ${exp.row} ${exp.trackingNo} (${exp.scenario})`;
            expect({ ctx, status: r.status, diffTypes: r.diffTypes, diffAmount: r.diffAmount }).toEqual({
              ctx,
              status: exp.status,
              diffTypes: exp.diffTypes,
              diffAmount: exp.diffAmount,
            });
            expect({ ctx, billed: r.billedAmount }).toEqual({ ctx, billed: exp.billedAmount });
            expect({ ctx, confidence: r.confidence === 'LOW' ? 'LOW' : undefined, reviewCode: r.confidence === 'LOW' ? r.reviewCode : undefined }).toEqual({
              ctx,
              confidence: exp.confidence,
              reviewCode: exp.reviewCode,
            });
            if (!exp.diffTypes.includes('DUPLICATE')) {
              expect({ ctx, our: r.ourChargeableKg, billedKg: r.billedChargeableKg, expected: r.expectedAmount }).toEqual({
                ctx,
                our: exp.ourChargeableKg,
                billedKg: exp.billedChargeableKg,
                expected: exp.expectedAmount,
              });
            } else {
              expect(r.expectedAmount).toBeNull();
            }
            if (exp.note === 'Lehimize fark') expect(r.note).toBe('Lehimize fark');
          });

          const t = mode.strict ? inv.totals : totalsOf(goldenLines);
          expect(results.length).toBe(t.lines);
          expect(results.filter((r) => r.status === 'MATCH').length).toBe(t.match);
          expect(results.filter((r) => r.status === 'DIFF').length).toBe(t.diff);
          expect(results.filter((r) => r.status === 'UNMATCHED').length).toBe(t.unmatched);
          expect(results.filter((r) => r.status === 'NO_TARIFF').length).toBe(t.noTariff);
          expect(sumMoney(results.map((r) => r.billedAmount))).toBe(t.billedTotal);
          expect(sumMoney(results.filter((r) => r.expectedAmount != null).map((r) => r.expectedAmount!))).toBe(t.expectedTotal);
          const firm = results.filter((r) => r.status === 'DIFF' && r.confidence !== 'LOW');
          const review = results.filter((r) => r.status === 'DIFF' && r.confidence === 'LOW');
          expect(sumMoney(firm.filter((r) => (r.diffAmount ?? 0) > 0).map((r) => r.diffAmount!))).toBe(t.overchargeTotal);
          // mükerrer "İncele" satırı ek ücret ayarından etkilenmez: iki ayarda da aynı İncele toplamı
          expect({ estimatedOverchargeTotal: sumMoney(review.filter((r) => (r.diffAmount ?? 0) > 0).map((r) => r.diffAmount!)), estimatedLines: review.length }).toEqual(inv.reviewTotals);
        });
      }
    });
  }
});
