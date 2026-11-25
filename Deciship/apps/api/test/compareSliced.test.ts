/**
 * Mesaj 6 bağımsız inceleme (PARA): dilimli karşılaştırma (`compareAllSliced`, 2.000 satırda bir olay döngüsü molası) her
 * durumda dilimsiz hesapla (`compareAll`) birebir aynı sonucu verir. Rastgele büyük faturalar: aynı takip no farklı
 * dilimlerde (dosyada üstte görülen sayılır), önceki faturalarda geçen takip no, karışık hizmet bayrağı yalnız son dilimde
 * oluşan fatura (bayrak faturanın TÜM satırlarından), dövizli satırlar (kur var / yok / alınamadı), elle eşlenmiş ve
 * silinmiş ölçüm, karışık sırada gelen satırlar. Aynı bağlamla iki faturanın dilimleri iç içe geçse de sonuçlar aynı kalır
 * (dilimler arasında paylaşılan durum yok) ve dilimler arasında olay döngüsü gerçekten bırakılır.
 */
import { describe, expect, it } from 'vitest';
import type { FxRate, ParsedInvoiceLine } from '@deciship/core';
import { FEDEX } from '../../../packages/core/test/fixtures.ts';
import { compareAll, compareAllSliced, MeasurementIndex, type CompareContext, type PricingTariff } from '../src/services/compare.ts';
import { fxKey } from '../src/services/fx.ts';
import { mapSliced, YIELD_EVERY_ROWS } from '../src/lib/util.ts';

let seed = 20261112;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const INVOICE_DATE = new Date('2026-10-31T00:00:00.000Z');

const pricing: PricingTariff = { tariffId: 't1', revisionId: 'rev1', name: 'FedEx', currency: 'TRY', validFrom: null, validTo: null, input: FEDEX };

function tracking(i: number): string {
  const base = `7712${String(i).padStart(8, '0')}`;
  // aynı gönderinin farklı yazımları (normalizeTracking aynı anahtara indirir)
  return pick([base, base, ` ${base} `, `${base.slice(0, 4)} ${base.slice(4)}`]);
}

/** Rastgele fatura: `n` satır, `pool` farklı takip no (n/pool kadar yineleme), karışık sırada. */
function invoice(n: number, pool: number, service: (rowIndex: number) => string): ParsedInvoiceLine[] {
  const lines: ParsedInvoiceLine[] = [];
  for (let r = 0; r < n; r++) {
    const kg = Math.round(rnd() * 300) / 10 + 0.1;
    const usd = rnd() < 0.15;
    lines.push({
      rowIndex: r,
      trackingNo: tracking(Math.floor(rnd() * pool)),
      shipDate: `2026-10-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
      service: service(r),
      destCountry: pick(['DE', 'FR', 'GB', 'US', 'NL', 'XX']),
      actualKg: kg,
      billedKg: rnd() < 0.5 ? kg : Math.round(kg * (1 + rnd()) * 10) / 10,
      ...(rnd() < 0.6 ? { dims: { l: 10 + Math.round(rnd() * 60), w: 10 + Math.round(rnd() * 40), h: 5 + Math.round(rnd() * 40) } } : {}),
      surcharges: rnd() < 0.2 ? [{ code: 'REMOTE_AREA', name: 'Uzak bölge', amount: Math.round(rnd() * 5000) / 100 }] : [],
      netAmount: Math.round(rnd() * 900_000) / 100,
      ...(usd ? { currency: 'USD' } : rnd() < 0.5 ? { currency: 'TRY' } : {}),
      rawHash: `h${r}`,
    });
  }
  // dosyadaki sıra karışık: hesap rowIndex sırasıyla yapılır
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
  }
  return lines;
}

function context(lines: ParsedInvoiceLine[]): CompareContext {
  const measurements = [];
  const priorLines: CompareContext['priorLines'] = new Map();
  const seen = new Set<string>();
  for (const l of lines) {
    const key = l.trackingNo.replace(/\s+/g, '').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (rnd() < 0.6) {
      measurements.push({
        id: `m-${key}`,
        trackingNo: key,
        trackingRaw: key,
        lengthCm: 10 + Math.round(rnd() * 60),
        widthCm: 10 + Math.round(rnd() * 40),
        heightCm: 5 + Math.round(rnd() * 40),
        weightKg: Math.round(rnd() * 300) / 10 + 0.1,
        measuredAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(rnd() * 28), 10)),
      });
    }
    if (rnd() < 0.05) priorLines.set(key, [{ carrierId: pick(['c1', 'c2']), invoiceNo: 'ESKI-1', netAmount: Math.round(rnd() * 90_000) / 100, currency: pick([null, 'TRY']) }]);
  }
  // kur: bazı günler var, bazıları yok, bazıları ağ hatasıyla alınamadı
  const fx = new Map<string, FxRate | null>();
  const fxFailed = new Set<string>();
  for (let d = 1; d <= 28; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    const key = fxKey('TRY', 'USD', date);
    const roll = rnd();
    if (roll < 0.7) fx.set(key, { base: 'TRY', quote: 'USD', rate: 0.024 + rnd() / 1000, date, source: 'TCMB' });
    else if (roll < 0.85) fx.set(key, null);
    else {
      fx.set(key, null);
      fxFailed.add(key);
    }
  }
  fx.set(fxKey('TRY', 'USD', '2026-10-31'), { base: 'TRY', quote: 'USD', rate: 0.0241, date: '2026-10-31', source: 'TCMB' });
  const settings = { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false, companyCurrency: 'TRY' };
  return {
    index: new MeasurementIndex(measurements as never),
    pricing,
    basis: { tariffRevisionId: pricing.revisionId, compareSettings: settings },
    tol: { edgeTolCm: 1, weightTolKg: 0.1, amountTol: 5, fxTolerancePct: 1, unknownSurchargesAsDiff: false },
    priorLines,
    carrierId: 'c1',
    companyCurrency: 'TRY',
    invoiceCurrency: 'TRY',
    fx,
    fxFailed,
  };
}

/** Elle eşlenmiş satırlar (ölçüm ya da silinmiş ölçüm: null). */
function pinnedFor(lines: ParsedInvoiceLine[]) {
  const pinned = new Map();
  for (const l of lines) {
    if (rnd() < 0.03) pinned.set(l.rowIndex, rnd() < 0.3 ? null : { id: `p-${l.rowIndex}`, trackingNo: 'X', trackingRaw: 'X', lengthCm: 30, widthCm: 20, heightCm: 10, weightKg: 4.2, measuredAt: new Date('2026-10-10T00:00:00Z') });
  }
  return pinned;
}

describe('dilimli karşılaştırma dilimsizle birebir aynı (para)', () => {
  it('rastgele büyük faturalar: mükerrer dilimler arası, önceki faturalar, döviz, elle eşleme', async () => {
    for (const [n, pool] of [[9_001, 2_500], [2_000, 1_999], [4_001, 40], [1, 1], [0, 1]] as const) {
      const lines = invoice(n, pool, () => pick(['IP', 'IP', 'IE', 'International Priority']));
      const ctx = context(lines);
      const pinned = pinnedFor(lines);
      const sliced = await compareAllSliced(lines, ctx, INVOICE_DATE, pinned);
      expect(sliced, `n=${n}`).toEqual(compareAll(lines, ctx, INVOICE_DATE, pinned));
      expect(sliced.map((r) => r.line.rowIndex)).toEqual([...lines].map((l) => l.rowIndex).sort((a, b) => a - b));
    }
  });

  it('dilimler arası mükerrer: üstte görülen sayılır, sonraki dilimlerdeki kopyalar mükerrer', async () => {
    // aynı takip no 0., 2.500., 7.000. satırlarda (üç ayrı dilim)
    const lines = invoice(9_000, 9_000, () => 'IP');
    for (const r of [0, 2_500, 7_000]) lines.find((l) => l.rowIndex === r)!.trackingNo = '771299999999';
    const ctx = context(lines);
    ctx.priorLines.delete('771299999999');
    const sliced = await compareAllSliced(lines, ctx, INVOICE_DATE);
    expect(sliced).toEqual(compareAll(lines, ctx, INVOICE_DATE));
    const dup = sliced.filter((r) => r.line.trackingNo === '771299999999');
    expect(dup.map((r) => [r.line.rowIndex, (r.result.diffTypes as string[]).includes('DUPLICATE')])).toEqual([
      [0, false],
      [2_500, true],
      [7_000, true],
    ]);
  });

  it('karışık hizmet bayrağı yalnız son dilimdeki satırdan doğsa da ilk dilimin satırlarına uygulanır', async () => {
    const n = 3 * YIELD_EVERY_ROWS + 1;
    // takip no'lar seyrek yinelenir: dosyada yinelenen takip no (KALANLAR 1.8) "İncele" gerekçesini kendisi verir, karışık
    // hizmet bayrağının etkisini örterdi
    const lines = invoice(n, 100 * n, (r) => (r === n - 1 ? 'IE' : 'IP'));
    const ctx = context(lines);
    const sliced = await compareAllSliced(lines, ctx, INVOICE_DATE);
    expect(sliced).toEqual(compareAll(lines, ctx, INVOICE_DATE));
    // aynı satırlar son satır olmadan (tek hizmet): ilk dilimde sonucu değişen satır olmalı, yoksa deneme bir şey göstermez
    const single = await compareAllSliced(lines.filter((l) => l.rowIndex !== n - 1), ctx, INVOICE_DATE);
    const byRow = new Map(single.map((r) => [r.line.rowIndex, r.result]));
    const changedInFirstSlice = sliced.filter((r) => r.line.rowIndex < YIELD_EVERY_ROWS && JSON.stringify(r.result) !== JSON.stringify(byRow.get(r.line.rowIndex)));
    expect(changedInFirstSlice.length).toBeGreaterThan(0);
  });

  it('aynı bağlamla iki faturanın dilimleri iç içe geçer: sonuçlar yine aynı; dilim aralarında olay döngüsü bırakılır', async () => {
    const a = invoice(6_001, 1_000, () => pick(['IP', 'IE']));
    const b = invoice(6_001, 1_000, () => 'IP');
    const ctx = context([...a, ...b]);
    let ticks = 0;
    let stop = false;
    const tick = () => {
      if (stop) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const [ra, rb] = await Promise.all([compareAllSliced(a, ctx, INVOICE_DATE), compareAllSliced(b, ctx, INVOICE_DATE)]);
    stop = true;
    expect(ra).toEqual(compareAll(a, ctx, INVOICE_DATE));
    expect(rb).toEqual(compareAll(b, ctx, INVOICE_DATE));
    // 6.001 satır = 4 dilim: her fatura en az 3 kez bıraktı
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('mapSliced sırayı ve değeri korur', async () => {
    const xs = Array.from({ length: 4 * YIELD_EVERY_ROWS + 7 }, (_, i) => i);
    expect(await mapSliced(xs, (x) => x * 2 + 1)).toEqual(xs.map((x) => x * 2 + 1));
    expect(await mapSliced([], (x) => x)).toEqual([]);
  });
});
