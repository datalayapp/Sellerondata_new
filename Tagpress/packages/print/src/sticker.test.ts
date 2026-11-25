import { describe, expect, it } from "vitest";
import { planStickerPages, stickerGeometry, stickerPerRow, stickerRowsPerPage } from "./sticker.ts";
import { defaultStickerFlow, defaultStickerPaper, PT_MM, ptToMm } from "./units.ts";
import { printedTotals } from "./totals.ts";
import { rules, stickerOrder, stickerTemplate } from "./test-helpers.ts";
import type { PlanStickerOrder } from "./types.ts";

// Eski Figma eklentisinin testlerinin taşınmış hâli (sticker-pages-plan.test.ts; eklenti kaldırıldı, eşitlik testi 2026-10-10'da geçiyordu). Eklentinin varsayılanları: üst 22, satır aralığı 13, son sayfada en çok 18 pt. Eklenti pt, burada mm: ölçüler `ptToMm` ile
// açıkça çevrilir (1 pt = 25.4/72 mm); beklenen sayılar (5 / 9 / 45 ...) birimden bağımsızdır.
const T = stickerTemplate();
const R = rules();
const G = stickerGeometry(T, R);
const item = (orderNo: string, quantity: number, wPt = 90, hPt = 70): PlanStickerOrder => stickerOrder(orderNo, quantity, ptToMm(wPt), ptToMm(hPt));
const plan = (orders: PlanStickerOrder[]) => planStickerPages({ orders, template: T, rules: R });
const printedOf = (pages: ReturnType<typeof plan>, o: PlanStickerOrder) => printedTotals(pages).find((t) => t.jobId === o.jobId)?.printed ?? 0;

describe("mm dönüşümü", () => {
  it("varsayılan sayfa tam A4 ve akış değerleri eklentideki pt değerlerinin mm karşılığı", () => {
    expect(PT_MM).toBeCloseTo(0.352777, 5);
    // Tam A4 (eklentinin 595 × 842 pt'si 209,9 × 297,04 mm idi, A4'ün yuvarlanmışı).
    expect(defaultStickerPaper()).toEqual({ wMm: 210, hMm: 297 });
    const f = defaultStickerFlow();
    expect(f.marginTopMm).toBeCloseTo((22 * 25.4) / 72, 9);
    expect(f.rowSpanMm).toBeCloseTo((538 * 25.4) / 72, 9);
    expect(G.marginTop).toBeCloseTo(ptToMm(22), 9);
    expect(G.minGapY).toBeCloseTo(ptToMm(13), 9);
    expect(G.looseGapY).toBeCloseTo(ptToMm(18), 9);
  });
});

describe("sticker sayfa planlayıcı (eklenti testlerinden)", () => {
  it("satıra sığan adedi mürekkep genişliğinden hesaplar", () => {
    // (595 - 40 + 15) / (90 + 15) = 5.4 → 5
    expect(stickerPerRow(ptToMm(90), G)).toBe(5);
    expect(stickerPerRow(ptToMm(300), G)).toBe(1);
    expect(stickerPerRow(ptToMm(9999), G)).toBe(1);
  });

  it("sayfaya sığan satır sayısını yükseklikten hesaplar", () => {
    // usable = 842 - 22 - 24 = 796; (796 + 13) / (70 + 13) = 9.7 → 9
    expect(stickerRowsPerPage(ptToMm(70), G)).toBe(9);
  });

  it("36 adet: 41 → 9 satır = 1 tam sayfa (45 baskı, +9 ≤ maksimum 10)", () => {
    const o = item("100", 36);
    const pages = plan([o]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.name).toBe("100_1sayfa");
    expect(pages[0]!.copies).toBe(1);
    expect(printedOf(pages, o)).toBe(45);
  });

  it("fazlalık en az stickerExtraMin olur", () => {
    for (const q of [7, 12, 23, 36, 58]) {
      const o = item("200", q);
      expect(printedOf(plan([o]), o) - q).toBeGreaterThanOrEqual(5);
    }
  });

  it("büyük sipariş tek siparişli dolu sayfa üretir ve adı sayfa sayısını taşır", () => {
    const o = item("300", 100);
    const pages = plan([o]);
    const full = pages.find((p) => p.copies > 1);
    expect(full).toBeTruthy();
    expect(full!.name).toBe(`300_${full!.copies}sayfa`);
    expect(printedOf(pages, o)).toBeGreaterThanOrEqual(105);
  });

  it("küçük siparişler karışık sayfada birleşir (sip_sip_1sayfa), satırlar bitişik", () => {
    const pages = plan([item("10", 4), item("11", 4), item("12", 4)]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.name).toBe("10_11_12_1sayfa");
    // aynı sipariş satırları bitişik: satır başına ilk öğeyi al (y değişimi), sipariş değişimi sayısı = 2
    const byRow = new Map<number, string>();
    for (const it of pages[0]!.items) byRow.set(Math.round(it.yMm * 1000), it.jobId);
    const order = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    expect(order.filter((id, i) => i > 0 && id !== order[i - 1]).length).toBe(2);
  });

  it("hücreler sayfa dışına taşmaz", () => {
    const orders = [item("1", 20), item("2", 33, 120, 60), item("3", 7, 150, 90)];
    const dims = new Map(orders.map((o) => [o.jobId, o]));
    for (const page of plan(orders)) {
      for (const it of page.items) {
        const o = dims.get(it.jobId)!;
        const x = it.xMm - o.wMm / 2;
        const y = it.yMm - o.hMm / 2;
        expect(x).toBeGreaterThanOrEqual(G.marginX - 0.01);
        expect(x + o.wMm).toBeLessThanOrEqual(G.pageW - G.marginX + 0.01);
        expect(y).toBeGreaterThanOrEqual(G.marginTop - 0.01);
        expect(y + o.hMm).toBeLessThanOrEqual(G.pageH - G.marginBottom + ptToMm(0.5));
      }
    }
  });

  it("satırdaki yan yana sticker'lar en az minGapX aralıklıdır", () => {
    const o = item("5", 50);
    const first = plan([o])[0]!.items.filter((it) => Math.abs(it.yMm - plan([o])[0]!.items[0]!.yMm) < 1e-6);
    expect(first.length).toBe(5);
    for (let i = 1; i < first.length; i++) expect(first[i]!.xMm - first[i - 1]!.xMm - o.wMm).toBeGreaterThanOrEqual(G.minGapX - 0.01);
  });

  it("satır yaklaşık rowSpan genişliğine yayılır", () => {
    const o = item("5", 50);
    const items = plan([o])[0]!.items;
    const row = items.filter((it) => Math.abs(it.yMm - items[0]!.yMm) < 1e-6);
    expect(row[row.length - 1]!.xMm + o.wMm / 2 - (row[0]!.xMm - o.wMm / 2)).toBeCloseTo(G.rowSpan, 6);
    expect(G.rowSpan).toBeCloseTo(ptToMm(538), 9);
  });

  it("sayfaya sığmayan sticker için açık hata verir", () => {
    expect(() => plan([item("9", 5, 600, 70)])).toThrow(/sığmıyor/);
  });

  it("şablonda sayfa akışı yoksa açık hata verir", () => {
    expect(() => planStickerPages({ orders: [item("9", 5)], template: stickerTemplate({ stickerFlow: null }), rules: R })).toThrow(/stickerFlow/);
  });

  it("aynı sayfa adı iki kez çıkarsa ayırt edilir", () => {
    const pages = plan([item("7", 100), { ...item("7", 100), jobId: "x2" }]);
    const names = pages.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("siparişleri sipariş numarasına göre doğal sırada işler", () => {
    const pages = plan([item("20", 12), item("3", 12)]);
    expect(pages[0]!.name).toBe("3_20_1sayfa");
  });

  it("her sticker için basılan adet istenenden azdır olamaz", () => {
    const orders = [item("1", 3), item("2", 90), item("3", 41, 120, 100), item("4", 9, 60, 40)];
    const pages = plan(orders);
    for (const o of orders) expect(printedOf(pages, o)).toBeGreaterThanOrEqual(o.quantity);
  });

  it("fazlalık kuralı profilden gelir (stickerExtraMin 0 ise 36 adet tam satıra yuvarlanır)", () => {
    const o = item("100", 36);
    const pages = planStickerPages({ orders: [o], template: T, rules: rules({ stickerExtraMin: 0, stickerExtraMax: 0 }) });
    expect(printedOf(pages, o)).toBe(40);
  });
});
