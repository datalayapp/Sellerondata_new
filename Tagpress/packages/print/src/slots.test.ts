import { describe, expect, it } from "vitest";
import { slotsInReadingOrder } from "@tagpress/domain";
import { cellLabelPosition, freeSlots, labelAnchorIndex, nearestFreeSlot } from "./slots.ts";
import { neededCount } from "./needed.ts";
import { labelTemplate, rules } from "./test-helpers.ts";

// Eklentideki "daire sıralaması" testlerinin mm karşılığı: yuvalar sıralanır, satır sonundaki yuvanın etiketi bir soldakine.
describe("yuva sırası ve etiket çapası (eklenti testlerinden)", () => {
  const mk = (id: string, cx: number, cy: number) => ({ id, cx, cy, w: 20, h: 20, shape: "circle" as const, rotation: 0, cornerRadius: 0 });
  const slots = [mk("a", 30, 10), mk("b", 10, 10.5), mk("c", 20, 9.8), mk("d", 10, 30), mk("e", 30, 30)];

  it("üstten alta, aynı satırda soldan sağa sıralar", () => {
    expect(slotsInReadingOrder(slots).map((s) => s.id)).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("satırın en sağındaki hücrenin etiketi bir soldakinin yanına yazılır (eklentiyle aynı indeksler)", () => {
    const sorted = slotsInReadingOrder(slots);
    expect(labelAnchorIndex(sorted, 0)).toBe(0); // ilk yuva, en sağda olsa da önceki yok
    expect(labelAnchorIndex(sorted, 1)).toBe(1);
    expect(labelAnchorIndex(sorted, 2)).toBe(1); // satırın en sağı → bir önceki
    expect(labelAnchorIndex(sorted, 4)).toBe(3);
  });

  it("cellLabelPosition: satır yuvalarıyla aynı kural", () => {
    const t = labelTemplate(3, 2);
    const row0 = t.slots.filter((s) => s.cy === 20);
    const byId = (id: string) => t.slots.find((s) => s.id === id)!;
    // ortadaki yuva: kendi sağ alt köşesi
    expect(cellLabelPosition(t, byId("s0-1"), row0)).toEqual({ xMm: 45 + 10 - 11.3, yMm: 30 - 1.6 });
    // en sağdaki: bir soldakine göre
    expect(cellLabelPosition(t, byId("s0-2"), row0)).toEqual({ xMm: 45 + 10 - 11.3, yMm: 30 - 1.6 });
    // satırda tek yuva: kendisi
    expect(cellLabelPosition(t, byId("s0-0"), [byId("s0-0")])).toEqual({ xMm: 30 - 11.3, yMm: 30 - 1.6 });
  });
});

describe("boş yuvalar ve yapışma", () => {
  const t = labelTemplate(3, 2);

  it("freeSlots okuma sırasıyla boş yuvaları verir", () => {
    expect(freeSlots(t, new Set()).map((s) => s.id)).toEqual(["s0-0", "s0-1", "s0-2", "s1-0", "s1-1", "s1-2"]);
    expect(freeSlots(t, new Set(["s0-1", "s1-0"])).map((s) => s.id)).toEqual(["s0-0", "s0-2", "s1-1", "s1-2"]);
  });

  it("nearestFreeSlot en yakın boş yuvayı seçer, dolu yuvayı atlar, sınırı uygular", () => {
    // s0-1 merkezi (45,20)
    expect(nearestFreeSlot(t, 46, 21, new Set())?.id).toBe("s0-1");
    // s0-0 (x 20) 26,0 mm; s0-2 (x 70) 24,0 mm uzakta
    expect(nearestFreeSlot(t, 46, 21, new Set(["s0-1"]))?.id).toBe("s0-2");
  });

  it("nearestFreeSlot: eşit olmayan mesafede doğru, sınırı aşarsa null, boş yuva yoksa null", () => {
    expect(nearestFreeSlot(t, 66, 21, new Set(["s0-1"]))?.id).toBe("s0-2");
    expect(nearestFreeSlot(t, 46, 21, new Set(["s0-1"]), 5)).toBeNull();
    expect(nearestFreeSlot(t, 46, 21, new Set(t.slots.map((s) => s.id)))).toBeNull();
    expect(nearestFreeSlot(t, 47, 22, new Set(), 5)?.id).toBe("s0-1");
  });
});

describe("neededCount", () => {
  it("etiket: adet + ölçeklenen fazlalık (profilden)", () => {
    const r = rules({ labelExtraMin: 4, labelExtraMax: 10, labelExtraScaleLow: 20, labelExtraScaleHigh: 150 });
    expect(neededCount(36, r, "label")).toBe(36 + Math.round(4 + ((36 - 20) / 130) * 6)); // 36 + 5
    expect(neededCount(10, r, "label")).toBe(14); // ölçeğin altı → en az
    expect(neededCount(500, r, "label")).toBe(510); // ölçeğin üstü → en çok
    expect(neededCount(0, r, "label")).toBe(0);
  });

  it("sticker: adet + stickerExtraMin", () => {
    expect(neededCount(36, rules({ stickerExtraMin: 5 }), "sticker")).toBe(41);
    expect(neededCount(36, rules({ stickerExtraMin: 0 }), "sticker")).toBe(36);
  });
});
