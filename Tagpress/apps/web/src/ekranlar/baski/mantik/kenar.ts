import { PRINTER_MARGIN_MM, type PrintTemplate, type PrintTemplateWarning, printWarningMsg } from "@tagpress/domain";
import { slotBounds, slotsOutside, templateWarnings, TOUCH_EPS_MM } from "./slot-geometry.ts";

/**
 * Yazıcı kenarı (basılamayan kenar payı, `PRINTER_MARGIN_MM`) — SAF, mm. Sunucunun `checkTemplate` kuralıyla aynı:
 * kağıt içinde kalan ama taşma payı dahil kenarı yazıcının basamadığı şeride giren yuvalar uyarılır (engellemez).
 * Kağıt dışına taşan yuva ayrı uyarıdır (`slot-outside`), burada sayılmaz.
 */

type Probe = Pick<PrintTemplate, "paper" | "slots"> & { cut?: Pick<PrintTemplate["cut"], "bleedMm"> };

/** Yazıcının basamadığı kenara giren yuvaların kimlikleri (okuma sırasında). */
export function printerMarginSlots(t: Probe, marginMm = PRINTER_MARGIN_MM): string[] {
  const outside = new Set(slotsOutside(t.slots, t.paper));
  const bleed = t.cut?.bleedMm ?? 0;
  const m = marginMm - TOUCH_EPS_MM;
  return t.slots
    .filter((s) => {
      if (outside.has(s.id)) return false;
      const b = slotBounds(s);
      return b.x - bleed < m || b.y - bleed < m || b.x + b.w + bleed > t.paper.wMm - m || b.y + b.h + bleed > t.paper.hMm - m;
    })
    .map((s) => s.id);
}

/** Uyarıdaki yuva listesi (sunucuyla aynı): en çok 6 kimlik, fazlası "…". */
const idList = (ids: readonly string[]) => (ids.length > 6 ? `${ids.slice(0, 6).join(", ")} …` : ids.join(", "));

/**
 * Sayfa şablonu düzenleyicisinin canlı uyarıları: ortak denetim (`templateWarnings`) + yazıcı kenarı
 * (`slot-in-printer-margin`, sunucuyla aynı kod ve parametreler; metin `printTemplates:warnings.*`).
 */
export function pageTemplateWarnings(t: Parameters<typeof templateWarnings>[0]): PrintTemplateWarning[] {
  const out = templateWarnings(t);
  const edge = printerMarginSlots(t);
  if (!edge.length) return out;
  const w: PrintTemplateWarning = { ...printWarningMsg("slot-in-printer-margin", { count: edge.length, marginMm: PRINTER_MARGIN_MM, slots: idList(edge) }), slotIds: edge };
  // Sunucudaki sıra: kağıt dışı / çakışma / kimlik uyarılarından sonra, etiket çapı ve kayıt işaretinden önce.
  const at = out.findIndex((x) => x.code === "label-larger-than-slot" || x.code === "mark-overlap");
  return at < 0 ? [...out, w] : [...out.slice(0, at), w, ...out.slice(at)];
}
