import type { PrintSlot } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import "../../../i18n/test.ts";
import { warningText } from "./sablon/editor.ts";
import { pageTemplateWarnings, printerMarginSlots } from "./kenar.ts";

const paper = { wMm: 210, hMm: 297 };
const circle = (id: string, cx: number, cy: number, d = 38): PrintSlot => ({ id, shape: "circle", cx, cy, w: d, h: d, rotation: 0, cornerRadius: 0 });

describe("yazıcı kenarı (basılamayan kenar payı)", () => {
  it("4 mm şeride giren yuva uyarılır; tam sınırdaki ve içerideki uyarılmaz; kağıt dışındaki ayrı uyarıdır", () => {
    // Sol kenarı 3 mm'de (şeritte), 4 mm'de (tam sınır), 10 mm'de; biri kağıt dışında.
    const slots = [circle("s1", 22, 100), circle("s2", 23, 150), circle("s3", 29, 200), circle("s4", 10, 250)];
    expect(printerMarginSlots({ paper, slots })).toEqual(["s1"]);
  });

  it("taşma payı (bleed) kenara eklenir; dört kenarın hepsi denetlenir", () => {
    const slots = [circle("s1", 25, 100), circle("s2", 105, 25), circle("s3", 186, 100), circle("s4", 105, 272)];
    expect(printerMarginSlots({ paper, slots })).toEqual([]);
    expect(printerMarginSlots({ paper, slots, cut: { bleedMm: 3.5 } })).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("canlı uyarılarda sunucunun kodu ve parametreleriyle, etiket çapı uyarısından önce; metin sözlükten", () => {
    const slots = [circle("s1", 21, 100), circle("s2", 105, 150)];
    const ws = pageTemplateWarnings({ kind: "label", paper, slots, labelDiameterMm: 40 });
    expect(ws.map((w) => w.code)).toEqual(["slot-in-printer-margin", "label-larger-than-slot"]);
    const w = ws[0]!;
    expect(w).toMatchObject({ messageKey: "slot-in-printer-margin", params: { count: 1, marginMm: 4, slots: "s1" }, slotIds: ["s1"] });
    expect(warningText(w)).toBe("1 yuva (taşma payı dahil) yazıcının basamadığı 4 mm'lik kenara giriyor: s1. Kenarı eksik basılabilir.");
  });

  it("kenarda yuva yoksa ortak denetimin uyarıları aynen kalır", () => {
    expect(pageTemplateWarnings({ kind: "label", paper, slots: [], labelDiameterMm: null }).map((w) => w.code)).toEqual(["no-slots"]);
    expect(pageTemplateWarnings({ kind: "label", paper, slots: [circle("s1", 100, 100)], labelDiameterMm: null })).toEqual([]);
  });
});
