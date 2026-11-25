/**
 * Ölçü birimleri ve baskı standartları — TEK KAYNAK. Fiziksel ölçü her yerde **mm**'dir; piksel yalnızca çıktı anında
 * (seçilen dpi ile) ya da ekranda (CSS pikseli) hesaplanır. Kodda 25,4 / 72 / 96 gibi sayılar bu dosyanın dışında yazılmaz.
 *
 * - `PT_PER_INCH` (72) yalnızca PDF noktası ve yazı puntosu içindir (1 pt = 1/72 inç). Eski Figma eklentisinin sayfa
 *   "px"i de buydu (595 × 842 = A4); profilin sticker sayfası ölçüleri bu birimdedir (`StickerSheet.maxW/maxH`, pt).
 * - `CSS_PX_PER_INCH` (96) yalnızca ekran içindir (tarayıcıda 1 mm = 96 / 25,4 CSS pikseli).
 * - Tasarım alanı pikseli (`profile.output.designFramePx`, 440) fiziksel değildir: etikette yuva/etiket çapına,
 *   sticker'da sticker yazı alanına (mm) ölçeklenir.
 */

export const MM_PER_INCH = 25.4;
/** PDF noktası / punto: 1 pt = 1/72 inç. */
export const PT_PER_INCH = 72;
/** Ekran (CSS) pikseli: 1 px = 1/96 inç. */
export const CSS_PX_PER_INCH = 96;

export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;
export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;
/** mm → çıktı pikseli (dpi). */
export const mmToPx = (mm: number, dpi: number): number => (mm / MM_PER_INCH) * dpi;
/** Çıktı pikseli → mm (dpi). */
export const pxToMm = (px: number, dpi: number): number => (px * MM_PER_INCH) / dpi;
/** Ekranda %100 yakınlaştırmada 1 mm kaç CSS pikseli. */
export const CSS_PX_PER_MM = CSS_PX_PER_INCH / MM_PER_INCH;

// ---------------------------------------------------------------- baskı standartları (varsayılanlar)

/** Baskı çözünürlüğü (PNG ve raster PDF): 300 dpi standart; 600 dpi ince yazı için seçenek. */
export const PRINT_DPI = 300;
export const PRINT_DPI_HIGH = 600;
/** Çözünürlük alanının alt/üst sınırı (dpi). 150'nin altı baskıda bulanık olur. */
export const PRINT_DPI_MIN = 150;
export const PRINT_DPI_MAX = 1200;

/**
 * Yazıcının basamadığı kenar (mm). Ev/ofis yazıcılarının çoğu kağıt kenarından 3–5 mm'yi basamaz; 4 mm güvenli
 * kabul edilir. Yuva ya da sticker bu bandın içinde kalırsa kenarı eksik basılabilir.
 */
export const PRINTER_MARGIN_MM = 4;
/** Kesim çizgisi kalınlığı (mm): kesim makinelerinin okuduğu ince çizgi (0,25 mm ≈ 0,7 pt). */
export const CUT_LINE_MM = 0.25;
/** Taşma payı (mm): kesim kaymasına karşı görsel kesim çizgisinin dışına bu kadar taşar. Varsayılan 0 (yuva çizgisi kesilir). */
export const BLEED_MM = 0;
/** Önerilen taşma payı (mm) kesim makinesi + kayıt işareti ile basarken (makinelerin tipik kayması ±0,5–1 mm). */
export const BLEED_WITH_CUTTER_MM = 1;
/** Kayıt işaretleri (print & cut): kağıt kenarından içeri, kenar uzunluğu, çizgi kalınlığı (mm). */
export const REGISTRATION_INSET_MM = 10;
export const REGISTRATION_SIZE_MM = 5;
export const REGISTRATION_THICKNESS_MM = 0.5;

/** Standart kağıt ölçüleri (mm, dikey). Kimlikler kurulum cevabındaki `print.paperPreset` ile aynıdır. */
export const PAPER_SIZES = {
  a4: { wMm: 210, hMm: 297 },
  "a4-yatay": { wMm: 297, hMm: 210 },
  a3: { wMm: 297, hMm: 420 },
  a5: { wMm: 148, hMm: 210 },
  sra3: { wMm: 320, hMm: 450 },
  letter: { wMm: 215.9, hMm: 279.4 },
} as const satisfies Record<string, { wMm: number; hMm: number }>;
export type PaperSizeId = keyof typeof PAPER_SIZES;
export const PAPER_SIZE_IDS = Object.keys(PAPER_SIZES) as PaperSizeId[];
export const DEFAULT_PAPER: PaperSizeId = "a4";

/** Kağıt ölçüsünün kimliği (±0,05 mm; eşleşmezse null). */
export function paperSizeId(p: { wMm: number; hMm: number }): PaperSizeId | null {
  return PAPER_SIZE_IDS.find((id) => Math.abs(PAPER_SIZES[id].wMm - p.wMm) < 0.05 && Math.abs(PAPER_SIZES[id].hMm - p.hMm) < 0.05) ?? null;
}

/** Standart etiket çapları (mm): 2,5 / 3,8 / 5,2 cm. Profildeki `output.sizes[].cm` × 10 ile aynıdır. */
export const LABEL_DIAMETERS_MM = [25, 38, 52] as const;
