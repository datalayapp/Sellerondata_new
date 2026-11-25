import type { ShelfItem } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { setTestLocale } from "../../../i18n/test.ts";
import { groupShelf, groupSizeLabel, groupTitle, neededLabel, shelfRows, showsAsRemaining, sizeLabel, stamp, templatesForGroup } from "./shelf.ts";

const it_ = (jobId: string, o: Partial<ShelfItem> = {}): ShelfItem => ({
  jobId,
  variantId: `v${jobId}`,
  orderNo: jobId,
  kind: "label",
  sizeId: "3.8",
  quantity: 36,
  needed: 40,
  placed: 0,
  designKey: null,
  previewUrl: `/p/${jobId}`,
  product: null,
  ...o,
});

describe("raf", () => {
  it("yerleşen sayısı yerel (gönderilmemiş) farkla düzelir; kalan negatif olmaz", () => {
    const rows = shelfRows([it_("4849", { placed: 10 })], new Map([["4849", 10]]), new Map([["4849", 14]]));
    expect(rows[0]).toMatchObject({ placedNow: 14, remaining: 26 });
    const over = shelfRows([it_("1", { placed: 0 })], new Map(), new Map([["1", 99]]));
    expect(over[0]!.remaining).toBe(0);
  });

  it("gruplar: önce etiketler boyut sırasıyla, sonra sticker; grup içinde sipariş no (doğal sıra)", () => {
    const rows = shelfRows(
      [it_("10", { sizeId: "5.2" }), it_("9", { sizeId: "3.8" }), it_("100", { sizeId: "3.8" }), it_("s1", { kind: "sticker", sizeId: "A" }), it_("2", { sizeId: "2.5" })],
      new Map(),
      new Map(),
    );
    const g = groupShelf(rows);
    expect(g.map((x) => x.key)).toEqual(["label:2.5", "label:3.8", "label:5.2", "sticker:A"]);
    expect(g[1]!.rows.map((r) => r.orderNo)).toEqual(["9", "100"]);
    expect(g[1]).toMatchObject({ quantity: 72, needed: 80, remaining: 80 });
  });

  it("kesimli ve kesimsiz iş aynı boyut kimliğinde ayrı grupta (daire Ø38 kesimi ↔ eski 3,8 cm); başlık ayırt eder", () => {
    const daire = { shape: "circle" as const, wMm: 38, hMm: 38, radiusMm: 0 };
    const urun = { shape: "rect" as const, wMm: 63.5, hMm: 38.1, radiusMm: 0 };
    const rows = shelfRows([it_("1"), it_("2", { cut: daire }), it_("3"), it_("4", { sizeId: "63.5x38.1", cut: urun }), it_("s", { kind: "sticker", sizeId: "A", cut: urun })], new Map(), new Map());
    const g = groupShelf(rows);
    expect(g.map((x) => x.key)).toEqual(["label:3.8", "label:3.8:cut", "label:63.5x38.1:cut", "sticker:A"]);
    expect(g[0]!.rows.map((r) => r.jobId)).toEqual(["1", "3"]);
    expect(g[0]!.cut).toBeUndefined();
    expect(g[1]!.cut).toEqual(daire);
    expect(g[3]!.cut).toBeUndefined();
    expect(g.map((x) => groupTitle(x))).toEqual(["3,8 cm etiket", "Ø 38 mm etiket", "63,5 × 38,1 mm etiket", "Sticker · A"]);
    expect(groupSizeLabel({ sizeId: null })).toBeNull();
  });

  it("eski masa: kesimli grupta boyutsuz şablon yalnız yuvaları kesime uyuyorsa", () => {
    const slot = (w: number) => ({ id: "s1", shape: "circle" as const, cx: 50, cy: 50, w, h: w, rotation: 0, cornerRadius: 0 });
    const ts = [
      { id: "d38", kind: "label" as const, sizeId: null, archived: false, slots: [slot(38)] },
      { id: "d40", kind: "label" as const, sizeId: null, archived: false, slots: [slot(40)] },
    ];
    const cut = { shape: "circle" as const, wMm: 38, hMm: 38, radiusMm: 0 };
    expect(templatesForGroup({ kind: "label", sizeId: "3.8", cut }, ts).map((t) => t.id)).toEqual(["d38"]);
    expect(templatesForGroup({ kind: "label", sizeId: "3.8" }, ts).map((t) => t.id)).toEqual(["d38", "d40"]);
  });

  it("gruba uygun sayfa şablonları: aynı tür ve boyut; yoksa boyutsuz olanlar; arşivdekiler hariç", () => {
    const ts = [
      { id: "a", kind: "label" as const, sizeId: "3.8", archived: false },
      { id: "b", kind: "label" as const, sizeId: "3.8", archived: true },
      { id: "c", kind: "label" as const, sizeId: null, archived: false },
      { id: "d", kind: "sticker" as const, sizeId: "3.8", archived: false },
    ];
    expect(templatesForGroup({ kind: "label", sizeId: "3.8" }, ts).map((t) => t.id)).toEqual(["a"]);
    expect(templatesForGroup({ kind: "label", sizeId: "5.2" }, ts).map((t) => t.id)).toEqual(["c"]);
  });

  it("adedi olmayan sipariş 'yalnızca kalanlar' süzgecinde görünür kalır (uyarı için)", () => {
    const [r] = shelfRows([it_("1", { quantity: 0, needed: 0, quantityMissing: true })], new Map(), new Map());
    expect(r!.remaining).toBe(0);
    expect(showsAsRemaining(r!)).toBe(true);
    expect(showsAsRemaining({ remaining: 0 })).toBe(false);
  });

  it("künye metinleri", () => {
    expect(neededLabel({ quantity: 36, needed: 40 })).toBe("36 → 40 (+4)");
    expect(neededLabel({ quantity: 36, needed: 36 })).toBe("36");
    // Şablon bilinmiyorsa formül: "≈"; adet yoksa uyarı.
    expect(neededLabel({ quantity: 36, needed: 40, neededApprox: true })).toBe("36 → ≈40 (+4)");
    expect(neededLabel({ quantity: 0, needed: 0, quantityMissing: true })).toBe("adet yok");
    expect(groupTitle({ kind: "label", sizeId: "3.8" })).toBe("3,8 cm etiket");
    expect(groupTitle({ kind: "sticker", sizeId: null })).toBe("Sticker");
  });

  it("tarih damgası", () => {
    const now = new Date(2026, 9, 10, 15, 0);
    expect(stamp(new Date(2026, 9, 10, 9, 5).toISOString(), now)).toMatch(/^Bugün 09[:.]05$/);
    expect(stamp(new Date(2026, 9, 9, 23, 0).toISOString(), now)).toMatch(/^Dün /);
    expect(stamp(null)).toBe("—");
    expect(stamp("bozuk")).toBe("—");
  });

  it("boyut metni: eski boyut cm, kesimli boyut mm (TR ve EN)", async () => {
    expect(sizeLabel("3.8")).toBe("3,8 cm");
    expect(sizeLabel("4")).toBe("4 cm");
    expect(sizeLabel("63.5x38.1")).toBe("63,5 × 38,1 mm");
    expect(sizeLabel("40x40")).toBe("40 × 40 mm");
    expect(sizeLabel("50x30r3")).toBe("50 × 30 mm · köşe 3 mm");
    expect(sizeLabel("50x30-oval")).toBe("50 × 30 mm · oval");
    expect(sizeLabel("A")).toBe("A");
    await setTestLocale("en");
    try {
      expect(sizeLabel("3.8")).toBe("3.8 cm");
      expect(sizeLabel("63.5x38.1")).toBe("63.5 × 38.1 mm");
      expect(sizeLabel("50x30r3")).toBe("50 × 30 mm · corner 3 mm");
    } finally {
      await setTestLocale("tr");
    }
  });
});
