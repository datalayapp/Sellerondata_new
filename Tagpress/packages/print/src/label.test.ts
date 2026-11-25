import { describe, expect, it } from "vitest";
import { planLabelPages } from "./label.ts";
import { printedTotals } from "./totals.ts";
import { labelTemplate, order, rules } from "./test-helpers.ts";
import type { PlanOrder } from "./types.ts";

// Eski Figma eklentisinin testlerinin taşınmış hâli (label-pages-plan.test.ts; eklenti kaldırıldı, eşitlik testi 2026-10-10'da geçiyordu). Kapasite 35 = 7×5 yuva. Eklentideki
// `totals.printed` burada `printedTotals(pages)`; `cells`/`labels` yerine `items`/`cellLabels`.
const T = labelTemplate(7, 5);
const plan = (orders: PlanOrder[], over: Parameters<typeof rules>[0] = {}, template = T) => planLabelPages({ orders, template, rules: rules(over) });
const printedOf = (pages: ReturnType<typeof plan>, o: PlanOrder) => printedTotals(pages).find((t) => t.jobId === o.jobId)?.printed ?? 0;
const m0 = { labelExtraMin: 0, labelExtraMax: 0 };

describe("etiket baskı sayfası planlayıcı (eklenti testlerinden)", () => {
  it("tam sayfa: adet kapasite katıysa sayfa sayısı kadar kopya", () => {
    const pages = plan([order("1", 70)], m0);
    const full = pages.find((p) => p.kind === "full")!;
    expect(full.name).toBe("1_2sayfa");
    expect(full.copies).toBe(2);
    expect(full.items).toHaveLength(35);
    expect(full.cellLabels.map((l) => l.text)).toEqual(["1_70adet"]);
  });

  it("kalan sayfayı doldurmaya 5'ten yakınsa yukarı yuvarlanır (30 → 35)", () => {
    const o = order("2", 30);
    const pages = plan([o]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.kind).toBe("full");
    expect(pages[0]!.name).toBe("2_1sayfa");
    expect(printedOf(pages, o)).toBe(35);
  });

  it("29 adet yuvarlanmaz, karışık sayfaya fazlalıkla girer", () => {
    const o = order("3", 29);
    const pages = plan([o], { labelExtraMin: 5, labelExtraMax: 10 });
    expect(pages.every((p) => p.kind === "mixed")).toBe(true);
    expect(printedOf(pages, o)).toBeGreaterThanOrEqual(29 + 5);
  });

  it("fazlalık min..max aralığında ve sayfa kapasitesini aşmaz", () => {
    for (const q of [3, 12, 22, 60, 100, 150, 200]) {
      const o = order("4", q);
      const extra = printedOf(plan([o], { labelExtraMin: 2, labelExtraMax: 8 }), o) - q;
      expect(extra).toBeGreaterThanOrEqual(0);
      expect(extra).toBeLessThanOrEqual(8 + 5);
    }
  });

  it("küçük siparişler karışık sayfada birleşir ve adı sipariş numaralarından oluşur", () => {
    const pages = plan([order("10", 5), order("11", 6)], { labelExtraMin: 1, labelExtraMax: 1 });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.name).toBe("10_11_1sayfa");
    // her siparişin ilk hücresinde etiket yazısı var
    expect(pages[0]!.cellLabels.map((l) => l.text)).toEqual(["10_5adet", "11_6adet"]);
  });

  it("aynı tasarım numaralı farklı siparişler aynı karışık sayfaya girmez", () => {
    const orders = [order("20", 5, "a15"), order("21", 5, "a15")];
    expect(plan(orders, m0)).toHaveLength(2);
    expect(plan(orders, { ...m0, separateSameDesign: false })).toHaveLength(1);
  });

  it("farklı tasarım numaraları birlikte durabilir", () => {
    expect(plan([order("20", 5, "a1"), order("21", 5, "a2")], m0)).toHaveLength(1);
  });

  it("hücreler tekrarsızdır: sayfadaki her yuva en çok bir kez kullanılır", () => {
    const pages = plan([order("1", 50), order("2", 33, "a1"), order("3", 71, "a2"), order("4", 4, "a1")]);
    for (const p of pages) {
      const ids = p.items.map((i) => i.slotId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(35);
    }
  });

  it("basılan adet hiçbir siparişte istenenden az değildir", () => {
    const orders = [order("1", 1), order("2", 34), order("3", 36), order("4", 105)];
    const pages = plan(orders);
    for (const o of orders) expect(printedOf(pages, o)).toBeGreaterThanOrEqual(o.quantity);
  });

  it("kapasite 0 ise hata verir", () => {
    expect(() => plan([order("1", 5)], {}, labelTemplate(0, 0))).toThrow(/kapasite/);
  });

  it("sayfa adları tekrar etmez", () => {
    const pages = plan([order("7", 36), { ...order("7", 36), jobId: "other" }]);
    const names = pages.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => n.endsWith(" (2)"))).toBe(true);
  });
});

describe("yerleşim (mm)", () => {
  it("yuvalar okuma sırasıyla dolar, etiket yuvanın merkezine konur", () => {
    const pages = plan([order("1", 70)], m0);
    const items = pages[0]!.items;
    expect(items[0]).toMatchObject({ slotId: "s0-0", xMm: 20, yMm: 20 });
    expect(items[1]).toMatchObject({ slotId: "s0-1", xMm: 45, yMm: 20 });
    expect(items[7]).toMatchObject({ slotId: "s1-0", xMm: 20, yMm: 45 });
    expect(items[34]).toMatchObject({ slotId: "s4-6", xMm: 170, yMm: 120 });
  });

  it("hücre etiketi sağ alt köşeye göre; satır sonundaysa bir soldaki yuvaya göre", () => {
    const pages = plan([order("1", 70)], m0);
    // s0-0 satırın en sağında değil: kendi sağ alt köşesi (30, 30) + (-11.3, -1.6)
    expect(pages[0]!.cellLabels[0]).toMatchObject({ slotId: "s0-0", xMm: 30 - 11.3, yMm: 30 - 1.6 });
    // 3 adet + 3 fazlalık = 6 hücre (0..5); ikinci siparişin ilk hücresi 6. yuva = s0-6, satırın en sağı
    const mixed = plan([order("5", 3), order("6", 5)], { labelExtraMin: 3, labelExtraMax: 3 })[0]!;
    const l = mixed.cellLabels.find((x) => x.text === "6_5adet")!;
    expect(l.slotId).toBe("s0-6");
    expect(l.xMm).toBeCloseTo(145 + 10 - 11.3, 9); // bir soldaki s0-5 (cx 145) yuvasının sağ alt köşesine göre
  });

  it("fazlalık işaretlenir", () => {
    const pages = plan([order("2", 30)]);
    expect(pages[0]!.items.filter((i) => i.extra)).toHaveLength(5);
  });
});
