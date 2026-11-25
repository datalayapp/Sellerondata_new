import { PrintTemplateSchema, ProfileSchema, type PrintTemplate, type PrintTemplateInput } from "@tagpress/domain";
import { defaultStickerFlow, defaultStickerPaper } from "./units.ts";
import type { PlanOrder, PlanStickerOrder, PrintRules } from "./types.ts";

/** Profil varsayılanları (eklenti varsayılanlarıyla aynı) + istenen geçersiz kılmalar. */
export const rules = (o: Partial<PrintRules> = {}): PrintRules => ({ ...ProfileSchema.shape.printing.parse({}), ...o });

const NOW = "2026-10-09T00:00:00.000Z";

/** cols × rows daireli etiket şablonu (A4, 25 mm aralık, 20 mm çap). Yuvalar ters sırada verilir (okuma sırası dizi sırasına bağlı olmasın). */
export function labelTemplate(cols = 7, rows = 5, over: Partial<PrintTemplateInput> = {}): PrintTemplate {
  const slots: NonNullable<PrintTemplateInput["slots"]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) slots.push({ id: `s${r}-${c}`, shape: "circle", cx: 20 + c * 25, cy: 20 + r * 25, w: 20, h: 20, rotation: 0, cornerRadius: 0 });
  }
  slots.reverse();
  return PrintTemplateSchema.parse({
    id: "t1", languageId: "tr", name: "3.8", kind: "label", paper: { wMm: 210, hMm: 297 }, sizeId: "3.8", slots,
    createdAt: NOW, updatedAt: NOW, ...over,
  });
}

/** Eklenti varsayılanlarıyla (595×842 pt, mm'ye çevrilmiş) sticker şablonu. */
export function stickerTemplate(over: Partial<PrintTemplateInput> = {}): PrintTemplate {
  return PrintTemplateSchema.parse({
    id: "t2", languageId: "tr", name: "sticker", kind: "sticker", paper: defaultStickerPaper(), sizeId: "A", slots: [],
    stickerFlow: defaultStickerFlow(), createdAt: NOW, updatedAt: NOW, ...over,
  });
}

export const order = (orderNo: string, quantity: number, designKey: string | null = null): PlanOrder => ({ jobId: `job-${orderNo}`, variantId: "v1", orderNo, quantity, designKey });
export const stickerOrder = (orderNo: string, quantity: number, wMm: number, hMm: number): PlanStickerOrder => ({ ...order(orderNo, quantity), wMm, hMm });
