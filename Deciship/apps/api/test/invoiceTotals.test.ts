import { describe, expect, it } from 'vitest';
import { PAK_NOTE, invoiceSummaryAmounts, invoiceSummarySentence } from '@deciship/core';
import { computeTotals } from '../src/services/compare.ts';

/** computeTotals (saf), uydurma satırlarla: kontrol edilmeyen ek ücretli satır, pak/zarf, ölçümsüz satır. */
const L = (p: Partial<Parameters<typeof computeTotals>[0][number]>) => ({
  status: 'MATCH',
  netAmount: 0,
  expectedAmount: null as number | null,
  diffAmount: null as number | null,
  breakdown: [] as unknown,
  decision: 'OPEN',
  note: null as string | null,
  diffTypes: [] as string[],
  ...p,
});

const lines = [
  // 100 navlun + 40 tarifede olmayan ek ücret; beklenen = tarife 110 + faturadaki 40 = 150 → fark 140 − 150 = −10 (lehte)
  L({ netAmount: 140, expectedAmount: 150, diffAmount: -10, breakdown: [{ label: 'Taşıma', amount: 110 }, { label: 'Import fee', amount: 40, unchecked: true }] }),
  L({ status: 'DIFF', netAmount: 60, expectedAmount: 50, diffAmount: 10 }),
  L({ status: 'UNMATCHED', netAmount: 70, note: 'Bu takip no için ölçüm yok' }),
  L({ status: 'UNMATCHED', netAmount: 30, note: PAK_NOTE }),
  L({ status: 'NO_TARIFF', netAmount: 25, note: `${PAK_NOTE}; koli tarifesiyle karşılaştırılmadı` }),
];

describe('computeTotals + özet', () => {
  it('karşılaştırılan sayısı, pak/zarf sayıları; toplamların anlamı değişmez', () => {
    const t = computeTotals(lines);
    expect(t).toMatchObject({
      lines: 5,
      match: 1,
      diff: 1,
      unmatched: 2,
      noTariff: 1,
      pakUnmatched: 1,
      pakNoTariff: 1,
      billedTotal: 325,
      comparedBilledTotal: 200,
      expectedTotal: 200,
      uncheckedSurchargeTotal: 40,
      overchargeTotal: 10,
    });
    expect(invoiceSummarySentence(t)).toBe('2/5 satır karşılaştırıldı · 1 satırda fark var · 1 satırın ölçümü bulunamadı · 2 pak/zarf satırı kapsam dışı');
  });

  it('Faturalanan − Beklenen = karşılaştırılan satırların farkları toplamı (aynı kalemler)', () => {
    const t = computeTotals(lines);
    const a = invoiceSummaryAmounts(t);
    // tarifede olmayan 40 iki tarafta da var (Beklenen'e faturadaki tutarıyla girdi)
    expect(a).toMatchObject({ billed: 200, expected: 200, unchecked: 40, invoiceTotal: 325, showInvoiceTotal: true });
    expect(a.billed - a.expected).toBe(-10 + 10);
  });

  it('kontrol edilmeyen ek ücret yalnız karşılaştırılan satırlardan sayılır', () => {
    const t = computeTotals([L({ status: 'NO_TARIFF', netAmount: 10, breakdown: [{ label: 'x', amount: 5, unchecked: true }] })]);
    expect(t.uncheckedSurchargeTotal).toBe(0);
  });

  it('pendingLines: donmuş satırda bekleyen değişiklik (recalcPending) sayılır; rakamlar kayıtlı sonuçtan gelir', () => {
    expect(computeTotals(lines).pendingLines).toBe(0);
    const t = computeTotals([
      L({ status: 'DIFF', netAmount: 60, expectedAmount: 50, diffAmount: 10, decision: 'VERIFIED', recalcPending: 'MEASUREMENT' }),
      L({ status: 'DIFF', netAmount: 60, expectedAmount: 50, diffAmount: 10, decision: 'ACCEPTED', recalcPending: 'DUPLICATE' }),
      L({ status: 'MATCH', netAmount: 60, expectedAmount: 60, diffAmount: 0, recalcPending: null }),
    ]);
    expect(t).toMatchObject({ pendingLines: 2, diff: 2, overchargeTotal: 10, verifiedTotal: 10, acceptedLines: 1, expectedTotal: 160 });
  });
});

/** Kuruş: para karşılaştırması tamsayıda (kayan nokta artığı eşitliği bozmasın). */
const kr = (n: number) => Math.round(n * 100);

/** Mesaj 5 (08-B10) değişmez kuralı: adımlar = reconciliation.overchargeTotal = overchargeTotal = türlere göre toplam. */
function expectExplained(t: ReturnType<typeof computeTotals>) {
  expect(t.reconciliation, 'reconciliation').toBeDefined();
  expect(t.overchargeByType, 'overchargeByType').toBeDefined();
  const steps = t.reconciliation!.steps;
  // netDiff her zaman var, her zaman ilk; özet kutusundaki Faturalanan − Beklenen ile aynı (kuruş)
  expect(steps[0]?.key, 'netDiff ilk adım').toBe('netDiff');
  expect(steps.filter((s) => s.key === 'netDiff')).toHaveLength(1);
  expect(kr(steps[0]!.amount)).toBe(kr(t.comparedBilledTotal) - kr(t.expectedTotal));
  expect(kr(t.reconciliation!.overchargeTotal)).toBe(kr(t.overchargeTotal));
  expect(steps.reduce((a, s) => a + kr(s.amount), 0)).toBe(kr(t.overchargeTotal));
  expect(t.overchargeByType!.reduce((a, s) => a + kr(s.amount), 0)).toBe(kr(t.overchargeTotal));
  // anahtarlar tekil, türler tekil; türler büyükten küçüğe
  expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
  expect(new Set(t.overchargeByType!.map((x) => x.type)).size).toBe(t.overchargeByType!.length);
  const amounts = t.overchargeByType!.map((x) => kr(x.amount));
  expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
}

/** Basit, tohumlu rastgele sayı (testler her koşuda aynı satırları üretir). */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const TYPES = ['DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE'] as const;
const LOW = { confidence: 'LOW' };
const HIGH = { confidence: 'HIGH' };

/** Gerçek satır şekilleri: uyumlu (küçük ± fark), fark (her karar, kesin/tahmini, lehe/aleyhe), mükerrer, ölçümsüz, tarifesiz. */
function randomLines(seed: number, n: number) {
  const r = rng(seed);
  const money = (max: number) => Math.round(r() * max * 100) / 100;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: ReturnType<typeof L>[] = [];
  for (let i = 0; i < n; i++) {
    const net = money(400) + 0.01;
    const kind = r();
    const decision = pick(['OPEN', 'OPEN', 'VERIFIED', 'ACCEPTED'] as const);
    const pricing = r() < 0.25 ? LOW : r() < 0.5 ? HIGH : null;
    if (kind < 0.3) {
      const expected = Math.round((net - (money(10) - 5)) * 100) / 100;
      out.push(L({ status: 'MATCH', netAmount: net, expectedAmount: expected, diffAmount: Math.round((net - expected) * 100) / 100, decision: 'OPEN', pricing }));
    } else if (kind < 0.7) {
      const expected = money(400);
      const types = [pick(TYPES), ...(r() < 0.3 ? [pick(TYPES)] : [])].filter((x, j, a) => a.indexOf(x) === j);
      out.push(L({ status: 'DIFF', netAmount: net, expectedAmount: expected, diffAmount: Math.round((net - expected) * 100) / 100, decision, pricing, diffTypes: types }));
    } else if (kind < 0.8) {
      out.push(L({ status: 'DIFF', netAmount: net, expectedAmount: null, diffAmount: net, decision, pricing: r() < 0.5 ? LOW : null, diffTypes: ['DUPLICATE'] }));
    } else if (kind < 0.9) {
      out.push(L({ status: 'UNMATCHED', netAmount: net, decision: 'OPEN' }));
    } else {
      out.push(L({ status: 'NO_TARIFF', netAmount: net, decision: 'OPEN' }));
    }
  }
  return out;
}

describe('Mesaj 5: fazla ödemenin açıklaması (reconciliation, overchargeByType)', () => {
  it('fazla ödeme kuralı değişmez: overchargeTotal eskisiyle aynı formül, açıklama ona eşit', () => {
    const ls = [
      L({ status: 'DIFF', netAmount: 60, expectedAmount: 50, diffAmount: 10, diffTypes: ['WEIGHT'] }),
      L({ status: 'DIFF', netAmount: 80.33, expectedAmount: 50.1, diffAmount: 30.23, diffTypes: ['DIMENSION', 'SURCHARGE'], decision: 'VERIFIED' }),
      // kabul edilen ve tahmini satır fazla ödemeye girmez
      L({ status: 'DIFF', netAmount: 70, expectedAmount: 50, diffAmount: 20, diffTypes: ['PRICE'], decision: 'ACCEPTED' }),
      L({ status: 'DIFF', netAmount: 70, expectedAmount: 50, diffAmount: 20, diffTypes: ['PRICE'], pricing: LOW }),
      // lehe fark satırı (eksi) fazla ödemeye 0 katar
      L({ status: 'DIFF', netAmount: 40, expectedAmount: 55, diffAmount: -15, diffTypes: ['WEIGHT'] }),
      // mükerrer: beklenen yok, faturalananın tamamı
      L({ status: 'DIFF', netAmount: 45.67, expectedAmount: null, diffAmount: 45.67, diffTypes: ['DUPLICATE'] }),
      L({ status: 'MATCH', netAmount: 50.02, expectedAmount: 50, diffAmount: 0.02 }),
      L({ status: 'UNMATCHED', netAmount: 99 }),
    ];
    const t = computeTotals(ls);
    // 10 + 30,23 + 45,67 (eski kural elle)
    expect(t.overchargeTotal).toBe(85.9);
    expectExplained(t);
    // ilk fark türü sayılır (Pano ile aynı): DIMENSION+SURCHARGE satırı DIMENSION'a
    const byType = Object.fromEntries(t.overchargeByType!.map((x) => [x.type, x]));
    expect(byType.DUPLICATE).toMatchObject({ amount: 45.67, lines: 1 });
    expect(byType.DIMENSION).toMatchObject({ amount: 30.23, lines: 1 });
    expect(byType.SURCHARGE).toBeUndefined();
    expect(byType.PRICE?.amount ?? 0).toBe(0);
    expect(t.overchargeByType!.map((x) => x.type).slice(0, 3)).toEqual(['DUPLICATE', 'DIMENSION', 'WEIGHT']);
  });

  it('boş fatura ve fazla ödemesiz fatura: açıklama sıfıra varır', () => {
    for (const ls of [[], [L({ status: 'MATCH', netAmount: 10, expectedAmount: 10, diffAmount: 0 }), L({ status: 'UNMATCHED', netAmount: 5 })]]) {
      const t = computeTotals(ls);
      expect(t.overchargeTotal).toBe(0);
      expectExplained(t);
    }
  });

  it('rastgele 300 fatura: adımlar = overchargeTotal = türlere göre toplam, kuruşu kuruşuna', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const ls = randomLines(seed, 1 + (seed % 60));
      const t = computeTotals(ls);
      // eski kural, ayrı yazılmış: açık (kabul edilmemiş), kesin, fark satırlarının pozitif farkı
      const old = ls
        .filter((l) => l.status === 'DIFF' && l.decision !== 'ACCEPTED' && (l as { pricing?: { confidence?: string } | null }).pricing?.confidence !== 'LOW')
        .reduce((a, l) => a + Math.max(0, kr(Number(l.diffAmount ?? 0))), 0);
      expect(kr(t.overchargeTotal), `seed ${seed}`).toBe(old);
      expectExplained(t);
    }
  });
});
