import { PAPER_SIZES, type PrintTemplate, ptToMm } from "@tagpress/domain";

// Birimler ve çeviriler tek yerde: `@tagpress/domain` `units.ts`. Buradan yeniden verilir (eski içe aktarmalar için).
export { ptToMm } from "@tagpress/domain";

/** 1 pt kaç mm (25,4 / 72). Eski Figma eklentisi noktayla (pt) çalışıyordu; baskı masası mm. */
export const PT_MM = ptToMm(1);

/** Sayısal karşılaştırmalarda kayan nokta payı (mm). */
export const EPS_MM = 1e-6;

/** Sticker sayfası: A4 (210 × 297 mm). Eski eklentinin 595 × 842 pt'si (209,9 × 297,04 mm) A4'ün yuvarlanmışıydı. */
export function defaultStickerPaper(): PrintTemplate["paper"] {
  return { ...PAPER_SIZES.a4 };
}

/**
 * Eski Figma eklentisinin varsayılanlarının mm karşılığı (eklentinin `DEFAULT_STICKER_PAGE`'i; eklenti kaldırıldı):
 * üst 22, alt 24, yan 20, yan aralık 15, satır aralığı 13, son sayfada satır arası en çok 18, satır yayılımı 538 pt.
 * Kenar payları (7–8,5 mm) yazıcının basamadığı kenardan (`PRINTER_MARGIN_MM`, 4 mm) geniştir.
 */
export function defaultStickerFlow(): NonNullable<PrintTemplate["stickerFlow"]> {
  return {
    marginTopMm: ptToMm(22),
    marginBottomMm: ptToMm(24),
    marginSideMm: ptToMm(20),
    minGapXMm: ptToMm(15),
    minRowGapMm: ptToMm(13),
    maxRowGapLastMm: ptToMm(18),
    rowSpanMm: ptToMm(538),
  };
}
