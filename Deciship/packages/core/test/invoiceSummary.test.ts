import { describe, expect, it } from 'vitest';
import {
  OVERCHARGE_NOTE,
  PAK_NOTE,
  foldDuplicateStep,
  invoiceSummaryAmounts,
  invoiceSummarySentence,
  isPakNote,
  nothingCompared,
  onlyDuplicateOvercharge,
  overchargeNote,
  overchargeReconciliation,
  summaryGap,
  type ReconLineInput,
} from '../src/index';

// Uydurma sayılar: 120 satır; 19'u karşılaştırıldı, 63'ünün ölçümü yok, 38'i pak/zarf.
// Beklenen (1.410) tarifede olmayan 160'ı faturadaki tutarıyla içerir: tarifeye göre 1.250 + 160.
const base = {
  lines: 120,
  match: 19,
  diff: 0,
  unmatched: 101,
  noTariff: 0,
  billedTotal: 9000,
  comparedBilledTotal: 1340,
  expectedTotal: 1410,
  uncheckedSurchargeTotal: 160,
  pakUnmatched: 38,
  pakNoTariff: 0,
};

describe('invoiceSummaryAmounts: Faturalanan ile Beklenen aynı kalemleri kapsar', () => {
  it("Faturalanan tüm ücretler; tarifede olmayanlar Beklenen'in içinde, bilgi olarak ayrıca", () => {
    const a = invoiceSummaryAmounts(base);
    // 1.340 vs 1.410 (lehte 70): tarifede olmayan 160 iki tarafta da var, farkı etkilemez
    expect(a).toEqual({ billed: 1340, expected: 1410, duplicates: 0, unchecked: 160, invoiceTotal: 9000, showInvoiceTotal: true });
    expect(a.billed).toBe(base.comparedBilledTotal);
  });

  it('kontrol edilmeyen yoksa ve tüm satırlar karşılaştırıldıysa fatura toplamı ayrıca gösterilmez', () => {
    const a = invoiceSummaryAmounts({ ...base, comparedBilledTotal: 9000, uncheckedSurchargeTotal: 0 });
    expect(a).toMatchObject({ billed: 9000, unchecked: 0, showInvoiceTotal: false });
  });

  it('eski kayıtlı özetler (alanlar yok) tüm satırlar üzerinden', () => {
    const { comparedBilledTotal: _c, uncheckedSurchargeTotal: _u, ...old } = base;
    expect(invoiceSummaryAmounts(old)).toMatchObject({ billed: 9000, unchecked: 0, showInvoiceTotal: false });
  });
});

describe('overchargeNote: Fazla ödeme ≠ Faturalanan − Beklenen ise açıklama', () => {
  // uydurma: farklı satırlarda +300 fazla; uyumlu satırlarda toplam −70 (lehte, tolerans içi) → net +230
  const t = { ...base, diff: 3, comparedBilledTotal: 1640, expectedTotal: 1410, uncheckedSurchargeTotal: 160 };
  it('net fark (230) fazla ödemeden (300) farklı → tek satırlık açıklama', () => {
    const a = invoiceSummaryAmounts(t);
    expect(a.billed - a.expected).toBe(230);
    expect(overchargeNote(t, 300)).toBe(OVERCHARGE_NOTE);
    expect(OVERCHARGE_NOTE).toContain('fark olan satırlardaki fazla tutar');
  });
  it('aynıysa (kuruş gürültüsü dahil) açıklama yok', () => {
    expect(overchargeNote(t, 230)).toBeNull();
    expect(overchargeNote({ ...t, comparedBilledTotal: 0.3, uncheckedSurchargeTotal: 0.1, expectedTotal: 0.1 }, 0.2)).toBeNull();
  });
});

describe('invoiceSummarySentence', () => {
  it('kısmi karşılaştırmada önce "19/120 satır karşılaştırıldı"; pak/zarf ölçüm sayısından ayrılır', () => {
    expect(invoiceSummarySentence(base)).toBe('19/120 satır karşılaştırıldı, fark yok · 63 satırın ölçümü bulunamadı · 38 pak/zarf satırı kapsam dışı');
  });

  it('fark varsa sayısı ayrı; ölçülmüş pak satırı "tarife yok"tan ayrılır', () => {
    expect(invoiceSummarySentence({ ...base, match: 15, diff: 4, unmatched: 99, noTariff: 3, pakUnmatched: 36, pakNoTariff: 2 })).toBe(
      '19/120 satır karşılaştırıldı · 4 satırda fark var · 63 satırın ölçümü bulunamadı · 1 satırda tarife yok · 38 pak/zarf satırı kapsam dışı',
    );
  });

  it('hepsi karşılaştırıldıysa eski kısa cümle', () => {
    const all = { ...base, match: 118, diff: 2, unmatched: 0, pakUnmatched: 0 };
    expect(invoiceSummarySentence(all)).toBe('2 satırda fark var');
    expect(invoiceSummarySentence({ ...all, match: 120, diff: 0 })).toBe('Karşılaştırılan satırlarda fark yok');
  });

  it('eski özetler: pak alanı yoksa 0; binlik ayırıcı', () => {
    expect(invoiceSummarySentence({ lines: 1200, match: 900, diff: 0, unmatched: 300, noTariff: 0, billedTotal: 1, expectedTotal: 1 })).toBe(
      '900/1.200 satır karşılaştırıldı, fark yok · 300 satırın ölçümü bulunamadı',
    );
  });

  it('isPakNote: ölçümsüz ve ölçülmüş pak notlarını tanır', () => {
    expect(isPakNote(PAK_NOTE)).toBe(true);
    expect(isPakNote(`${PAK_NOTE}; koli tarifesiyle karşılaştırılmadı`)).toBe(true);
    expect(isPakNote('Bu takip no için ölçüm yok')).toBe(false);
    expect(isPakNote(null)).toBe(false);
  });
});

describe('onlyDuplicateOvercharge: tamamı mükerrer fatura', () => {
  const dup = { ...base, lines: 4, match: 0, diff: 4, unmatched: 0, billedTotal: 400, comparedBilledTotal: 0, expectedTotal: 0, uncheckedSurchargeTotal: 0 };
  it('karşılaştırılan satır yok ve fazla ödeme var: true', () => {
    expect(onlyDuplicateOvercharge(dup, 400)).toBe(true);
  });
  it('fazla ödeme yoksa false', () => {
    expect(onlyDuplicateOvercharge(dup, 0)).toBe(false);
  });
  it('karşılaştırılan satır varsa false', () => {
    expect(onlyDuplicateOvercharge({ ...dup, comparedBilledTotal: 100, expectedTotal: 90 }, 400)).toBe(false);
  });
  it('eski kayıtlı özette (comparedBilledTotal yok) false', () => {
    const { comparedBilledTotal: _c, ...old } = dup;
    expect(onlyDuplicateOvercharge(old, 400)).toBe(false);
  });
  it('döküm varsa mükerrer Faturalanan\'a girer: açıklama cümlesine gerek kalmaz (false)', () => {
    const withSteps = { ...dup, reconciliation: { steps: [{ key: 'netDiff' as const, amount: 0, lines: 0 }, { key: 'uncompared' as const, amount: 400, lines: 4 }] } };
    expect(onlyDuplicateOvercharge(withSteps, 400)).toBe(false);
  });
});

/**
 * Karar 2026-11-12: mükerrer satır Faturalanan'a tam tutarıyla girer, beklenen tutarı 0 sayılır; Faturalanan − Beklenen =
 * Fazla ödeme tutar. Satırlar API'nin satır şekliyle (`ReconLineInput`), toplamlar API `computeTotals` ile aynı tanımla.
 */
type Ln = ReconLineInput & { net: number };
const ln = (p: Partial<Ln> & { net: number }): Ln => ({ status: 'MATCH', decision: 'OPEN', expectedAmount: null, diffAmount: null, diffTypes: [], estimated: false, ...p });
const cents = (xs: number[]) => xs.reduce((s, x) => s + Math.round(x * 100), 0) / 100;
function totalsOf(lines: Ln[]) {
  const { reconciliation } = overchargeReconciliation(lines);
  const compared = lines.filter((l) => l.expectedAmount != null);
  return {
    totals: {
      lines: lines.length,
      match: lines.filter((l) => l.status === 'MATCH').length,
      diff: lines.filter((l) => l.status === 'DIFF').length,
      unmatched: lines.filter((l) => l.status === 'UNMATCHED').length,
      noTariff: lines.filter((l) => l.status === 'NO_TARIFF').length,
      billedTotal: cents(lines.map((l) => l.net)),
      comparedBilledTotal: cents(compared.map((l) => l.net)),
      expectedTotal: cents(compared.map((l) => l.expectedAmount!)),
      reconciliation,
    },
    overcharge: reconciliation.overchargeTotal,
  };
}

/** Demo faturası MNG-2026-77120: mükerrer 141,30, ağırlık farkı 104,62/96,00, fiyat farkı 185,98/171,10, dört uyumlu, bir eşleşmeyen. */
const DEMO: Ln[] = [
  ln({ status: 'DIFF', net: 141.3, diffAmount: 141.3, diffTypes: ['DUPLICATE'] }),
  ln({ status: 'DIFF', net: 104.62, expectedAmount: 96, diffAmount: 8.62, diffTypes: ['WEIGHT'] }),
  ln({ status: 'DIFF', net: 185.98, expectedAmount: 171.1, diffAmount: 14.88, diffTypes: ['PRICE'] }),
  ln({ net: 120, expectedAmount: 120, diffAmount: 0 }),
  ln({ net: 150.5, expectedAmount: 150.5, diffAmount: 0 }),
  ln({ net: 130.25, expectedAmount: 130.25, diffAmount: 0 }),
  ln({ net: 146.3, expectedAmount: 146.3, diffAmount: 0 }),
  ln({ status: 'UNMATCHED', net: 79.4 }),
];

describe('Faturalanan mükerreri kapsar: Faturalanan − Beklenen = Fazla ödeme', () => {
  it('demo faturası: 978,95 − 814,15 = 164,80; fatura toplamı (eşleşmeyen dahil) ayrıca', () => {
    const { totals, overcharge } = totalsOf(DEMO);
    // kayıtlı alanlar değişmez: karşılaştırılan satırlar 837,65 / 814,15
    expect(totals).toMatchObject({ comparedBilledTotal: 837.65, expectedTotal: 814.15, billedTotal: 1058.35 });
    expect(overcharge).toBe(164.8);
    expect(invoiceSummaryAmounts(totals)).toEqual({ billed: 978.95, expected: 814.15, duplicates: 141.3, unchecked: 0, invoiceTotal: 1058.35, showInvoiceTotal: true });
    expect(summaryGap(totals, overcharge)).toEqual({ billed: 978.95, expected: 814.15, net: 164.8, parts: [] });
    expect(overchargeNote(totals, overcharge)).toBeNull();
    expect(nothingCompared(totals)).toBe(false);
    expect(onlyDuplicateOvercharge(totals, overcharge)).toBe(false);
    // "Nasıl hesaplandı?": mükerrer adımı Faturalanan − Beklenen'e katılır, toplam aynı
    expect(foldDuplicateStep(totals.reconciliation.steps)).toEqual([{ key: 'netDiff', amount: 164.8, lines: 7 }]);
  });

  it('mükerrersiz fatura: eskisiyle aynı (Faturalanan = karşılaştırılan satırlar)', () => {
    const { totals, overcharge } = totalsOf(DEMO.slice(1));
    expect(invoiceSummaryAmounts(totals)).toMatchObject({ billed: 837.65, expected: 814.15, duplicates: 0 });
    expect(invoiceSummaryAmounts(totals).billed).toBe(totals.comparedBilledTotal);
    expect(summaryGap(totals, overcharge)).toEqual({ billed: 837.65, expected: 814.15, net: 23.5, parts: [] });
    expect(foldDuplicateStep(totals.reconciliation.steps)).toEqual(totals.reconciliation.steps);
  });

  it('yalnız mükerrer satırlı fatura: Faturalanan = mükerrerler, Beklenen 0', () => {
    const { totals, overcharge } = totalsOf([ln({ status: 'DIFF', net: 100, diffAmount: 100, diffTypes: ['DUPLICATE'] }), ln({ status: 'DIFF', net: 50.55, diffAmount: 50.55, diffTypes: ['DUPLICATE'] })]);
    expect(totals).toMatchObject({ comparedBilledTotal: 0, expectedTotal: 0 });
    expect(invoiceSummaryAmounts(totals)).toMatchObject({ billed: 150.55, expected: 0, duplicates: 150.55, showInvoiceTotal: false });
    expect(summaryGap(totals, overcharge)).toEqual({ billed: 150.55, expected: 0, net: 150.55, parts: [] });
    expect(onlyDuplicateOvercharge(totals, overcharge)).toBe(false);
  });

  it('lehe satır: Faturalanan − Beklenen fazla ödemeden küçük, aradaki "lehinize" adımı', () => {
    const { totals, overcharge } = totalsOf([
      ln({ status: 'DIFF', net: 60, expectedAmount: 50, diffAmount: 10, diffTypes: ['WEIGHT'] }),
      ln({ status: 'DIFF', net: 40, expectedAmount: 55, diffAmount: -15, diffTypes: ['PRICE'] }),
      ln({ status: 'DIFF', net: 30, diffAmount: 30, diffTypes: ['DUPLICATE'] }),
    ]);
    expect(overcharge).toBe(40);
    const g = summaryGap(totals, overcharge)!;
    expect(g).toEqual({ billed: 130, expected: 105, net: 25, parts: [{ key: 'favourable', amount: 15 }] });
    expect(cents([g.net, ...g.parts.map((p) => p.amount)])).toBe(overcharge);
    expect(overchargeNote(totals, overcharge)).toBe(OVERCHARGE_NOTE);
  });

  it(`"İncele" ve Uyumlu sayılan mükerrer de Faturalanan'a tam tutarıyla girer; Fazla ödeme değişmez, aradaki adımlarda çıkar`, () => {
    const lines = [
      ln({ status: 'DIFF', net: 60, expectedAmount: 50, diffAmount: 10, diffTypes: ['WEIGHT'] }),
      ln({ net: 100, expectedAmount: 100, diffAmount: 0 }),
      // aynı dosyada tekrar eden takip no: tutarı tahmini ("İncele")
      ln({ status: 'DIFF', net: 1120, diffAmount: 1120, diffTypes: ['DUPLICATE'], estimated: true }),
      ln({ status: 'DIFF', net: 30, diffAmount: 30, diffTypes: ['DUPLICATE'], decision: 'ACCEPTED' }),
    ];
    const { totals, overcharge } = totalsOf(lines);
    expect(overcharge).toBe(10);
    // Faturalanan = taşıyıcının kestiği her satır (eşleşmeyen yok): fatura toplamına eşit, ayrı "Fatura toplamı" satırı çıkmaz
    expect(invoiceSummaryAmounts(totals)).toEqual({ billed: 1310, expected: 150, duplicates: 1150, unchecked: 0, invoiceTotal: 1310, showInvoiceTotal: false });
    const g = summaryGap(totals, overcharge)!;
    expect(g).toEqual({ billed: 1310, expected: 150, net: 1160, parts: [{ key: 'accepted', amount: -30 }, { key: 'review', amount: -1120 }] });
    expect(cents([g.net, ...g.parts.map((p) => p.amount)])).toBe(overcharge);
    expect(foldDuplicateStep(totals.reconciliation.steps)).toEqual([
      { key: 'netDiff', amount: 1160, lines: 4 },
      { key: 'accepted', amount: -30, lines: 1 },
      { key: 'review', amount: -1120, lines: 1 },
    ]);
  });

  it('tolerans içi ve kabul edilen farklar: adları ve tutarlarıyla, toplamı tutar', () => {
    const { totals, overcharge } = totalsOf([
      ln({ net: 50.3, expectedAmount: 50, diffAmount: 0.3 }),
      ln({ status: 'DIFF', net: 70, expectedAmount: 50, diffAmount: 20, diffTypes: ['PRICE'], decision: 'ACCEPTED' }),
      ln({ status: 'DIFF', net: 60, expectedAmount: 50, diffAmount: 10, diffTypes: ['WEIGHT'] }),
    ]);
    expect(overcharge).toBe(10);
    const g = summaryGap(totals, overcharge)!;
    expect(g.net).toBe(30.3);
    expect(g.parts).toEqual([
      { key: 'matchLines', amount: -0.3 },
      { key: 'accepted', amount: -20 },
    ]);
    expect(cents([g.net, ...g.parts.map((p) => p.amount)])).toBe(overcharge);
  });

  it('hiç karşılaştırılmamış (ölçümsüz) fatura: nothingCompared; kutular 0,00 yerine fatura toplamını gösterir', () => {
    const { totals, overcharge } = totalsOf([ln({ status: 'UNMATCHED', net: 10000 }), ln({ status: 'UNMATCHED', net: 180 })]);
    expect(nothingCompared(totals)).toBe(true);
    expect(invoiceSummaryAmounts(totals)).toMatchObject({ billed: 0, expected: 0, invoiceTotal: 10180, showInvoiceTotal: true });
    expect(onlyDuplicateOvercharge(totals, overcharge)).toBe(false);
    expect(nothingCompared({ ...totals, lines: 0 })).toBe(false);
  });

  it('döküm kutularla tutmuyorsa (bozuk kayıt) artık "diğer"e yazılır; döküm yoksa null', () => {
    const t = { ...base, diff: 1, comparedBilledTotal: 100, expectedTotal: 80, reconciliation: { steps: [{ key: 'netDiff' as const, amount: 20, lines: 1 }] } };
    expect(summaryGap(t, 25)).toEqual({ billed: 100, expected: 80, net: 20, parts: [{ key: 'other', amount: 5 }] });
    const { reconciliation: _r, ...old } = t;
    expect(summaryGap(old, 25)).toBeNull();
    expect(invoiceSummaryAmounts(old).billed).toBe(100);
  });
});
