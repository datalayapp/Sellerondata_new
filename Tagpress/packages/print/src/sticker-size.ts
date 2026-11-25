import { type Box, type StickerSheet, ptToMm, stickerSheetAreaMm } from "@tagpress/domain";

/**
 * Sticker'ın baskıdaki ölçüsü — SAF, TEK KAYNAK. Masa (ekran), planlayıcı ve çizim (PDF/PNG) bu işlevin mm'sini kullanır.
 *
 * Sticker, etiketlerle aynı 440'lık tasarım alanında tasarlanır; tasarım pikselinin fiziksel karşılığı yoktur. Baskıda
 * yazının mürekkebi profildeki sticker sayfasının yazı alanına (`maxW × maxH`, pt → mm; yuvarlakta `maxW` çaplı daire)
 * sığacak en büyük ölçeğe getirilir: eski Figma eklentisi de yazıyı bu kutuya ölçekleyip A4'e 1:1 koyuyordu
 * (`stickerFitScale`). Bu adım atlanınca tasarım pikseli doğrudan pt sayılıyordu (1 px = 0,353 mm): 440'lık alanda
 * ~300 px'lik yazı ~105 mm basılıyordu (olması gereken ≤ 46 mm).
 */

/**
 * Eski (2026-11-21 öncesi) ölçü: tasarım pikseli = 1 pt. Yalnız bu kuralla basılmış arşiv oturumlarının basıldığı gibi
 * yeniden dışa aktarımı için (plan sürümü 1); yeni plan ve baskıda KULLANILMAZ.
 */
export const LEGACY_STICKER_MM_PER_PX = ptToMm(1);

/** Sayfa tanımı bilinmeyen sticker için yazı alanı: Ø38 mm daire (standart 3,8 cm etiket). */
export const STICKER_FALLBACK_AREA = { shape: "circle" as const, wMm: 38, hMm: 38 };

export interface StickerPrintSize {
  /** Tasarım pikseli başına mm. */
  mmPerPx: number;
  /** Mürekkep kutusu (mm): planlayıcının ve masanın kullandığı ölçü; öğe merkezi = mürekkep merkezi. */
  wMm: number;
  hMm: number;
  /** Tasarım karesinin (`framePx`) öğe merkezine göre kutusu (mm): önizleme görseli buraya çizilir. */
  art: { xMm: number; yMm: number; wMm: number; hMm: number };
  /** Çizimin çapası (tasarım px): mürekkep merkezi. */
  anchorPx: { x: number; y: number };
}

/** Yazı alanı (mm) — profil sayfası ya da yedek. */
export function stickerAreaMm(sheet: Pick<StickerSheet, "shape" | "maxW" | "maxH"> | null | undefined): { shape: "rect" | "circle"; wMm: number; hMm: number } {
  if (!sheet) return STICKER_FALLBACK_AREA;
  return { shape: sheet.shape, ...stickerSheetAreaMm(sheet) };
}

/**
 * Mürekkebi yazı alanına sığdıran ölçek (mm / tasarım px). Dikdörtgende en ve boy ayrı ayrı sınırlar. Dairede, eski
 * eklentideki gibi (`circleReach`) her SATIRIN kendi kutusunun köşelerinin bütün yazının merkezine en uzak uzaklığı
 * yarıçapa sığar (satırlar verilmezse ortak kutunun köşegeni: ortası uzun çok satırlı yazı gereğinden küçük çıkardı).
 * Mürekkep bilinmiyorsa tasarım karesinin tamamı sığdırılır.
 */
export function stickerMmPerPx(
  ink: Box | null | undefined,
  sheet: Pick<StickerSheet, "shape" | "maxW" | "maxH"> | null | undefined,
  framePx: number,
  lineInks?: readonly Box[] | null,
): number {
  const box = ink && ink.w > 0 && ink.h > 0 ? ink : { x: 0, y: 0, w: framePx, h: framePx };
  const area = stickerAreaMm(sheet);
  if (area.shape === "circle") return area.wMm / 2 / circleReach(box, ink ? lineInks : null);
  return Math.min(area.wMm / box.w, area.hMm / box.h);
}

/** Satır kutularının köşelerinin, bütün yazının (ortak kutunun) merkezine en uzak uzaklığı (px). */
function circleReach(all: Box, lines: readonly Box[] | null | undefined): number {
  const cx = all.x + all.w / 2;
  const cy = all.y + all.h / 2;
  const used = lines?.filter((b) => b.w > 0 && b.h > 0) ?? [];
  if (!used.length) return Math.hypot(all.w, all.h) / 2;
  let reach = 0;
  for (const b of used) {
    const dx = Math.max(Math.abs(b.x - cx), Math.abs(b.x + b.w - cx));
    const dy = Math.max(Math.abs(b.y - cy), Math.abs(b.y + b.h - cy));
    reach = Math.max(reach, Math.hypot(dx, dy));
  }
  return reach > 0 ? reach : Math.hypot(all.w, all.h) / 2;
}

/**
 * Sticker'ın baskı ölçüsü (mm) ve çizim çapası. `scale`: öğenin masadaki elle ölçeği (varsayılan 1). `lineInks`: satır
 * mürekkep kutuları (daire alanda satır satır sığdırma). `legacy`: eski ölçü (`LEGACY_STICKER_MM_PER_PX`; yalnız eski
 * kuralla basılmış arşiv).
 */
export function stickerPrintSize(
  ink: Box | null | undefined,
  sheet: Pick<StickerSheet, "shape" | "maxW" | "maxH"> | null | undefined,
  framePx: number,
  scale = 1,
  opts: { lineInks?: readonly Box[] | null; legacy?: boolean } = {},
): StickerPrintSize {
  const known = ink && ink.w > 0 && ink.h > 0 ? ink : null;
  const box = known ?? { x: 0, y: 0, w: framePx, h: framePx };
  const k = (opts.legacy ? LEGACY_STICKER_MM_PER_PX : stickerMmPerPx(known, sheet, framePx, opts.lineInks)) * scale;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    mmPerPx: k,
    wMm: box.w * k,
    hMm: box.h * k,
    art: { xMm: -cx * k, yMm: -cy * k, wMm: framePx * k, hMm: framePx * k },
    anchorPx: { x: cx, y: cy },
  };
}
