import { CSS_PX_PER_MM, PAPER_SIZES, type PrintItem, type PrintItemSize, PrintTemplateSchema, ProfileSchema, effectiveCut } from "@tagpress/domain";
import { defaultStickerFlow, stickerPrintSize } from "@tagpress/print";
import { describe, expect, it } from "vitest";
import { PX_PER_MM } from "../../../tezgah/tuval/canvas-math.ts";
import { artBox, itemSize } from "./desk-model.ts";
import { PAPER_PRESETS } from "./grid.ts";

// Ekran (masa) ile baskı (sunucu + motor) AYNI mm'den türer: sunucu sticker ölçüsünü `@tagpress/print` `stickerPrintSize`
// ile verir (`itemSizes`), çizim aynı işlevin `mmPerPx`'ini kullanır. Masa bu mm'yi olduğu gibi çizer.
const NOW = "2026-11-21T00:00:00.000Z";
const sticker = PrintTemplateSchema.parse({ id: "s", languageId: "l", name: "S", kind: "sticker", paper: PAPER_SIZES.a4, stickerFlow: defaultStickerFlow(), createdAt: NOW, updatedAt: NOW });
const label = PrintTemplateSchema.parse({
  id: "e", languageId: "l", name: "E", kind: "label", paper: PAPER_SIZES.a4,
  slots: [{ id: "s1", shape: "circle", cx: 26, cy: 29, w: 38, h: 38 }], createdAt: NOW, updatedAt: NOW,
});
const item = (over: Partial<PrintItem> = {}): PrintItem =>
  ({ id: "i", jobId: "j", variantId: "v", slotId: null, xMm: 105, yMm: 50, rotation: 0, scale: 1, extra: false, manual: false, z: 0, ...over }) as PrintItem;

describe("ekran ↔ baskı ölçü tutarlılığı (mm)", () => {
  it("sticker: masadaki mürekkep ve görsel kutusu baskı ölçüsüyle aynı (elle ölçek dahil)", () => {
    const ink = { x: 71.01, y: 190.99, w: 297.48, h: 57.54 };
    const sheet = { shape: "rect" as const, maxW: 130, maxH: 96 };
    const base = stickerPrintSize(ink, sheet, 440);
    const sizes = new Map<string, PrintItemSize>([["v", { wMm: base.wMm, hMm: base.hMm, art: base.art }]]);
    for (const scale of [1, 0.8]) {
      const print = stickerPrintSize(ink, sheet, 440, scale);
      expect(itemSize(item({ scale }), sticker, sizes)).toEqual({ w: expect.closeTo(print.wMm, 9), h: expect.closeTo(print.hMm, 9) });
      const a = artBox(item({ scale }), sticker, sizes);
      expect(a.w).toBeCloseTo(440 * print.mmPerPx, 9);
      expect(a.x).toBeCloseTo(print.art.xMm, 9);
    }
    expect(base.wMm).toBeCloseTo(45.86, 2); // kullanıcının sticker'ı: 105 mm değil
  });

  it("etiket: yuvadaki öğe yuva çapında (baskıda tasarım karesi yuva çapına ölçeklenir)", () => {
    expect(itemSize(item({ slotId: "s1" }), label)).toEqual({ w: 38, h: 38 });
  });

  it("kendi kesimi olan etiket: masa kesim ölçüsünü ve kare tasarım karesini çizer (baskının mm/px'iyle aynı)", () => {
    const own = effectiveCut({ cut: { shape: "rect", wMm: 63.5, hMm: 38.1, radiusMm: 0 } }, ProfileSchema.parse({ name: "x" }));
    const frame = 440 * own.mmPerPx!;
    const sizes = new Map<string, PrintItemSize>([["v", { wMm: 63.5, hMm: 38.1, art: { xMm: -frame / 2, yMm: -frame / 2, wMm: frame, hMm: frame }, kind: "label" }]]);
    expect(itemSize(item({ slotId: "s1" }), label, sizes)).toEqual({ w: 63.5, h: 38.1 });
    expect(artBox(item({ slotId: "s1" }), label, sizes).w).toBeCloseTo(frame, 9);
    // Sticker ölçüsü (kind yok) etiket sayfasında yok sayılır.
    const stickerOnly = new Map<string, PrintItemSize>([["v", { wMm: 10, hMm: 5, art: null }]]);
    expect(itemSize(item({ slotId: "s1" }), label, stickerOnly)).toEqual({ w: 38, h: 38 });
  });

  it("ekranda %100 = gerçek boyut; kağıt ön ayarları ortak standart ölçülerden", () => {
    expect(PX_PER_MM).toBe(CSS_PX_PER_MM);
    expect(PAPER_PRESETS.find((p) => p.id === "a4")).toMatchObject(PAPER_SIZES.a4);
    expect(PAPER_PRESETS.map((p) => p.id)).toEqual(Object.keys(PAPER_SIZES));
  });
});
