import { describe, expect, it } from "vitest";
import { planLabelPages } from "./label.ts";
import { reflowPages, type ReflowPageInput } from "./reflow.ts";
import { planStickerPages } from "./sticker.ts";
import { printedTotals } from "./totals.ts";
import { labelTemplate, order, rules, stickerOrder, stickerTemplate } from "./test-helpers.ts";
import { ptToMm } from "./units.ts";
import type { PlanOrder, PlannedItem, PlannedPage } from "./types.ts";

const m0 = { labelExtraMin: 0, labelExtraMax: 0 };
const T = labelTemplate(7, 5);
const manualItem = (jobId: string, slotId: string, x: number, y: number): PlannedItem & { manual: boolean } => ({ jobId, variantId: "v1", slotId, xMm: x, yMm: y, extra: false, manual: true });
const autoItem = (jobId: string, slotId: string): PlannedItem & { manual: boolean } => ({ jobId, variantId: "v1", slotId, xMm: 0, yMm: 0, extra: false, manual: false });

describe("yeniden planlama", () => {
  it("hiçbir şey yerleşmemişse sıfırdan plana eşit", () => {
    const orders = [order("1", 70), order("2", 20), order("3", 6)];
    const fresh = planLabelPages({ orders, template: T, rules: rules() });
    const re = reflowPages({ pages: [], orders, template: T, rules: rules() });
    expect(re.map((p) => [p.name, p.copies, p.items.length])).toEqual(fresh.map((p) => [p.name, p.copies, p.items.length]));
  });

  it("kilitli sayfa çıktıda yok; içindekiler yerleşmiş sayılır, kalan yeniden planlanır", () => {
    const orders = [order("1", 30)];
    const locked: ReflowPageInput = { locked: true, items: Array.from({ length: 20 }, (_, i) => autoItem("job-1", `s0-${i}`)) };
    const re = reflowPages({ pages: [locked], orders, template: T, rules: rules(m0) });
    // İlk plan 30 → 35 (sayfayı tamamlama); 35 - 20 = 15 kaldı → karışık sayfada 15 hücre, yeniden yuvarlama yok
    expect(re).toHaveLength(1);
    expect(re[0]!.items).toHaveLength(15);
    expect(re[0]!.items.filter((i) => i.extra)).toHaveLength(5);
    expect(re[0]!.fromIndex).toBeNull();
    // Tamamlama kapalıyken: 30 - 20 = 10
    const re2 = reflowPages({ pages: [locked], orders, template: T, rules: rules({ ...m0, labelRoundUpMaxExtra: 0 }) });
    expect(re2[0]!.items).toHaveLength(10);
  });

  it("kilitliler tamamını karşılıyorsa sipariş atlanır", () => {
    const orders = [order("1", 5)];
    const locked: ReflowPageInput = { locked: true, items: Array.from({ length: 5 }, (_, i) => autoItem("job-1", `s0-${i}`)) };
    expect(reflowPages({ pages: [locked], orders, template: T, rules: rules(m0) })).toEqual([]);
  });

  it("kilitsiz sayfadaki elle öğe yerinde kalır, otomatik öğeler atılır, boş yuvalar dolar", () => {
    const orders = [order("1", 4)];
    const page: ReflowPageInput = { locked: false, items: [manualItem("job-1", "s2-3", 95, 70), autoItem("job-1", "s0-0"), autoItem("job-1", "s0-1")] };
    const re = reflowPages({ pages: [page], orders, template: T, rules: rules(m0) });
    expect(re).toHaveLength(1);
    const p = re[0]!;
    expect(p.fromIndex).toBe(0);
    // elle öğe s2-3'te, manual işaretli; geri kalan 3 yeni hücre okuma sırasıyla boşlara (s0-0, s0-1, s0-2)
    expect(p.items.find((i) => i.slotId === "s2-3")).toMatchObject({ manual: true, xMm: 95, yMm: 70 });
    expect(p.items.filter((i) => !i.manual).map((i) => i.slotId)).toEqual(["s0-0", "s0-1", "s0-2"]);
    expect(p.items).toHaveLength(4);
    // etiket: siparişin okuma sırasındaki ilk hücresinde
    expect(p.cellLabels).toHaveLength(1);
    expect(p.cellLabels[0]!.slotId).toBe("s0-0");
  });

  it("elle öğeli sayfadaki tasarım numarası ayrımına uyulur (aynı tasarım, farklı sipariş yeni sayfaya)", () => {
    const orders = [order("1", 1, "a1"), order("2", 3, "a1")];
    const page: ReflowPageInput = { locked: false, items: [manualItem("job-1", "s0-0", 20, 20)] };
    const re = reflowPages({ pages: [page], orders, template: T, rules: rules(m0) });
    // sipariş 1 tamam (elle); sipariş 2 aynı tasarımlı → korunan sayfaya girmez
    expect(re).toHaveLength(2);
    expect(re[0]!.fromIndex).toBe(0);
    expect(re[0]!.items).toHaveLength(1);
    expect(re[1]!.fromIndex).toBeNull();
    expect(re[1]!.items).toHaveLength(3);
  });

  it("sticker şablonu: elle öğeli sayfa olduğu gibi korunur, kalan yeni sayfaya planlanır", () => {
    const o = stickerOrder("1", 4, ptToMm(90), ptToMm(70));
    const kept: ReflowPageInput = { locked: false, items: [{ ...manualItem("job-1", "x", 50, 50), slotId: null }] };
    const re = reflowPages({ pages: [kept], orders: [o], template: stickerTemplate(), rules: rules(m0) });
    expect(re[0]!.fromIndex).toBe(0);
    expect(re[0]!.items).toEqual([{ jobId: "job-1", variantId: "v1", slotId: null, xMm: 50, yMm: 50, extra: false, manual: true }]);
    // 4 - 1 = 3 adet kaldı → bir satır (5/satır)
    const fresh = re.slice(1);
    expect(fresh.length).toBeGreaterThan(0);
    expect(printedTotals(fresh)[0]!.printed).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- fazlalık bir kez sayılır

/** Plan → yeniden planlama girdisi (kopyalar dahil). `mark(sayfa, öğe)` true dönen öğe elle konmuş sayılır. */
const toInput = (pages: readonly PlannedPage[], mark: (p: number, k: number) => boolean = () => false, locked: (p: number) => boolean = () => false): ReflowPageInput[] =>
  pages.map((p, pi) => ({ locked: locked(pi), copies: p.copies, items: p.items.map((it, k) => ({ ...it, manual: mark(pi, k) })) }));

/** Basılacak toplam: kilitli giriş sayfaları + yeniden planlamanın çıktısı (kilitsiz kümenin yeni hâli). */
function totalsAfter(input: readonly ReflowPageInput[], out: readonly PlannedPage[]): Map<string, { all: number; real: number }> {
  const m = new Map<string, { all: number; real: number }>();
  const add = (it: PlannedItem, copies: number) => {
    const t = m.get(it.jobId) ?? { all: 0, real: 0 };
    t.all += copies;
    if (!it.extra) t.real += copies;
    m.set(it.jobId, t);
  };
  for (const p of input) if (p.locked) for (const it of p.items) add(it, p.copies ?? 1);
  for (const p of out) for (const it of p.items) add(it, p.copies);
  return m;
}

const firstTotal = (pages: readonly PlannedPage[], o: PlanOrder) => printedTotals(pages).find((t) => t.jobId === o.jobId)?.printed ?? 0;

describe("yeniden planlama: fazlalık bir kez sayılır", () => {
  let seed = 4242;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 8) % n;
  };
  const randomCase = () => {
    const cols = 2 + rnd(6);
    const rowsN = 1 + rnd(6);
    const template = labelTemplate(cols, rowsN);
    const cap = cols * rowsN;
    const orders: PlanOrder[] = Array.from({ length: 1 + rnd(5) }, (_, i) => ({
      ...order(String(100 + rnd(4) * 10 + i), 1 + rnd(cap * 3), rnd(3) === 0 ? null : `a${rnd(3)}`),
      jobId: `j${i}`,
    }));
    const r = rules({ labelExtraMin: rnd(4), labelExtraMax: 4 + rnd(8), labelRoundUpMaxExtra: rnd(7), separateSameDesign: rnd(2) === 0 });
    return { template, orders, r };
  };

  it("(a) elle öğe yokken yeniden plan = ilk plan (sayfa, yuva, fazlalık, hücre etiketi, toplam)", () => {
    for (let round = 0; round < 300; round++) {
      const { template, orders, r } = randomCase();
      const first = planLabelPages({ orders, template, rules: r });
      // Hem boş girişte hem ilk planın kendisi (otomatik öğeler atılır) girdiyken
      for (const pages of [[], toInput(first)]) {
        const re = reflowPages({ pages, orders, template, rules: r });
        expect(re.map((p) => ({ ...p, fromIndex: undefined }))).toEqual(first.map((p) => ({ ...p, fromIndex: undefined })));
      }
    }
  });

  it("(b) kısmi elle yerleşim: sipariş başına toplam basılan = ilk plandaki toplam; fazlalık olmayan = adet", () => {
    let checkedReal = 0;
    let withManual = 0;
    for (let round = 0; round < 300; round++) {
      const { template, orders, r } = randomCase();
      const first = planLabelPages({ orders, template, rules: r });
      const p = 1 + rnd(5);
      const input = toInput(first, () => rnd(p) === 0);
      const re = reflowPages({ pages: input, orders, template, rules: r });
      const after = totalsAfter(input, re);
      // `extra` işareti birden çok kopyalı sayfada kopyalar için ortaktır (yalnızca ilk kopya anlamlı); gerçek adet
      // eşitliği yalnızca bütün sayfalar tek kopyayken denetlenir.
      const single = [...first, ...re].every((pg) => pg.copies === 1);
      for (const o of orders) {
        expect(after.get(o.jobId)?.all ?? 0).toBe(firstTotal(first, o));
        if (single) expect(after.get(o.jobId)?.real ?? 0).toBe(o.quantity);
      }
      if (single) checkedReal++;
      if (input.some((pg) => pg.items.some((i) => i.manual))) withManual++;
      for (const pg of re) {
        const ids = pg.items.map((i) => i.slotId).filter((x) => x !== null);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
    // Denetim boşa dönmesin: örneklerin çoğunda elle öğe var, yeterince örnekte gerçek adet de denetlendi.
    expect(withManual).toBeGreaterThan(250);
    expect(checkedReal).toBeGreaterThan(50);
  });

  it("(b) örnek: 34 adet ilk planda tek tam sayfa (35); bir etiket elle taşınınca yine tek sayfa, 35", () => {
    const o = order("4849", 34);
    const first = planLabelPages({ orders: [o], template: T, rules: rules() });
    expect(first.map((p) => [p.kind, p.items.length])).toEqual([["full", 35]]);
    const input = toInput(first, (_, k) => k === 0);
    const re = reflowPages({ pages: input, orders: [o], template: T, rules: rules() });
    // Eski hata: kalan (34 - 1 = 33) yeniden fazlalıkla planlanıyor, toplam 34+'ı aşıyordu.
    expect(re).toHaveLength(1);
    expect(re[0]!.fromIndex).toBe(0);
    expect(re[0]!.items).toHaveLength(35);
    expect(re[0]!.items.filter((i) => i.extra)).toHaveLength(1);
  });

  it("(b) birden çok kopyalı sayfa: yerleşmiş = öğe × kopya; korunan sayfa doldurulmaz, kopya sayısı korunur", () => {
    const o = order("7", 70);
    const first = planLabelPages({ orders: [o], template: T, rules: rules() });
    expect(first[0]).toMatchObject({ kind: "full", copies: 2 });
    const input = toInput(first, (pi, k) => pi === 0 && k === 0);
    const re = reflowPages({ pages: input, orders: [o], template: T, rules: rules() });
    expect(re.find((p) => p.fromIndex === 0)).toMatchObject({ copies: 2, items: [expect.objectContaining({ manual: true })] });
    expect(totalsAfter(input, re).get(o.jobId)!.all).toBe(firstTotal(first, o));
    // 2 (elle × 2) + 70 (tam sayfa × 2) ≥ 70: karışık sayfadaki yeniler fazlalıktır
    expect(re.filter((p) => p.kind === "mixed" && p.fromIndex == null).flatMap((p) => p.items).every((i) => i.extra)).toBe(true);
  });

  it("(c) kilitli sayfa korunur (çıktıda yok, içeriği sayılır); toplam ilk plandaki kadar", () => {
    const orders = [order("1", 40), order("2", 12, "a1"), order("3", 6, "a1")];
    const first = planLabelPages({ orders, template: T, rules: rules() });
    const lockedIdx = first.findIndex((p) => p.kind === "mixed");
    const input = toInput(first, (pi, k) => pi !== lockedIdx && k === 2, (pi) => pi === lockedIdx);
    const re = reflowPages({ pages: input, orders, template: T, rules: rules() });
    expect(re.some((p) => p.fromIndex === lockedIdx)).toBe(false);
    const after = totalsAfter(input, re);
    for (const o of orders) expect(after.get(o.jobId)).toEqual({ all: firstTotal(first, o), real: o.quantity });
    // Kilitli sayfa tamamen kilitliyken (ilk planın hepsi): yeni sayfa yok.
    expect(reflowPages({ pages: toInput(first, () => false, () => true), orders, template: T, rules: rules() })).toEqual([]);
  });

  it("sticker (a): yerleşim yokken ilk planla aynı", () => {
    const orders = [stickerOrder("1", 23, ptToMm(90), ptToMm(70)), stickerOrder("2", 7, ptToMm(120), ptToMm(60)), stickerOrder("3", 64, ptToMm(80), ptToMm(80))];
    const tpl = stickerTemplate();
    const first = planStickerPages({ orders, template: tpl, rules: rules() });
    const re = reflowPages({ pages: toInput(first), orders, template: tpl, rules: rules() });
    expect(re.map((p) => ({ ...p, fromIndex: undefined }))).toEqual(first.map((p) => ({ ...p, fromIndex: undefined })));
  });

  it("sticker (b): elle öğeli sayfa korunur; kalan yeniden fazlalıksız, yalnızca satıra yuvarlanır", () => {
    const o = stickerOrder("1", 23, ptToMm(90), ptToMm(70));
    const tpl = stickerTemplate();
    const r = rules({ stickerExtraMin: 5, stickerExtraMax: 10 });
    const first = planStickerPages({ orders: [o], template: tpl, rules: r });
    const need = firstTotal(first, o);
    // Yalnızca bir sticker elle konmuş tek sayfalık bir sayfa: o sayfanın hepsi yerleşmiş sayılır.
    const kept: ReflowPageInput = { locked: false, items: [{ ...manualItem("job-1", "x", 50, 50), slotId: null }] };
    const re = reflowPages({ pages: [kept], orders: [o], template: tpl, rules: r });
    const after = totalsAfter([kept], re).get(o.jobId)!;
    const perRow = re[1]!.items.filter((i) => Math.abs(i.yMm - re[1]!.items[0]!.yMm) < 0.01).length;
    expect(after.all).toBeGreaterThanOrEqual(need);
    expect(after.all - need).toBeLessThan(perRow);
    expect(after.real).toBe(23);
  });
});
