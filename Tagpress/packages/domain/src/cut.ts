import { z } from "zod";
import { type Shape, shapeBounds } from "./geometry.ts";

/**
 * Etiket şablonunun kesim şekli ve FİZİKSEL ölçüsü (mm) — kullanıcı kararı 2026-11-21: kesim tasarım dilinin değil
 * ŞABLONUN ayarıdır. Aynı tasarım dilinde daire, dikdörtgen, kare, köşesi yuvarlatılmış dikdörtgen ve oval etiketler
 * birlikte çalışır.
 *
 * Model:
 * - Şablonda `cut` VARSA: şablonun kesimi ve boyutu sabittir (ör. 63,5 × 38,1 mm dikdörtgen). Tasarım alanı (440'lık
 *   kare) içinde kesim, uzun kenarı tasarım alanına (profil kesimiyle aynı kenar payıyla) sığacak biçimde ortalanır;
 *   1 tasarım px = `wMm / kesim genişliği px` mm. İşin "etiket boyutu" bu şablonun kendi ölçüsüdür (`cutSizeId`);
 *   profildeki boyut listesi (2,5 / 3,8 / 5,2 cm) bu şablona uygulanmaz.
 * - Şablonda `cut` YOKSA (eski kayıtlar, sahibin şablonları): profilin `output.cut`'ı ve boyut listesi aynen geçer;
 *   çıktı piksel piksel eskisi gibidir.
 */
export const TEMPLATE_CUT_SHAPES = ["circle", "ellipse", "rect", "roundRect"] as const;
export type TemplateCutShape = (typeof TEMPLATE_CUT_SHAPES)[number];

export const TemplateCutSchema = z.object({
  shape: z.enum(TEMPLATE_CUT_SHAPES),
  /** Genişlik (mm); dairede çap. */
  wMm: z.number().positive().max(1000),
  /** Yükseklik (mm); dairede genişliğe eşitlenir. */
  hMm: z.number().positive().max(1000),
  /** Köşe yarıçapı (mm); yalnız `roundRect`. */
  radiusMm: z.number().min(0).default(0),
});
export type TemplateCut = z.infer<typeof TemplateCutSchema>;
export type TemplateCutInput = z.input<typeof TemplateCutSchema>;

/** Dairede yükseklik = genişlik; köşe yarıçapı kısa kenarın yarısını aşmaz (yalnız `roundRect`'te anlamlı). */
export function normalizeCut(cut: TemplateCutInput): TemplateCut {
  const c = TemplateCutSchema.parse(cut);
  const hMm = c.shape === "circle" ? c.wMm : c.hMm;
  const radiusMm = c.shape === "roundRect" ? Math.min(c.radiusMm, Math.min(c.wMm, hMm) / 2) : 0;
  return { shape: c.shape, wMm: c.wMm, hMm, radiusMm };
}

/** Kesim çapı (px): daire/elipste kısa çap, dikdörtgende kısa kenar, çokgende kutunun kısa kenarı. Oranlar buna göre. */
export function shapeCutDiameter(c: Shape): number {
  switch (c.kind) {
    case "circle":
      return 2 * c.r;
    case "ellipse":
      return 2 * Math.min(c.rx, c.ry);
    case "rect":
      return Math.min(c.w, c.h);
    case "polygon": {
      const b = shapeBounds(c);
      return Math.min(b.w, b.h);
    }
  }
}

/**
 * Şablon kesiminin tasarım alanındaki şekli (px). Uzun kenar `framePx - 2 × marginPx`'e sığar, kesim tasarım alanının
 * ortasındadır. `marginPx`: profil kesiminin tasarım alanı kenarına uzaklığı (varsayılan profilde ≈ 1 px).
 */
export function cutShapePx(cut: TemplateCutInput, framePx: number, marginPx: number): { shape: Shape; mmPerPx: number } {
  const c = normalizeCut(cut);
  const span = Math.max(1, framePx - 2 * Math.max(0, marginPx));
  const pxPerMm = span / Math.max(c.wMm, c.hMm);
  const w = c.wMm * pxPerMm;
  const h = c.hMm * pxPerMm;
  const cx = framePx / 2;
  const cy = framePx / 2;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  let shape: Shape;
  if (c.shape === "circle") shape = { kind: "circle", cx, cy, r: r6(w / 2) };
  else if (c.shape === "ellipse") shape = { kind: "ellipse", cx, cy, rx: r6(w / 2), ry: r6(h / 2) };
  else shape = { kind: "rect", x: r6(cx - w / 2), y: r6(cy - h / 2), w: r6(w), h: r6(h), radius: c.shape === "roundRect" ? r6(c.radiusMm * pxPerMm) : 0 };
  return { shape, mmPerPx: 1 / pxPerMm };
}

/** Kendi kesimi olan şablonda kesimin tasarım alanı kenarına payı: alanın 1/440'ı (440'lık alanda 1 px). */
export const OWN_CUT_MARGIN_RATIO = 1 / 440;

/** Profil kesiminin tasarım alanı kenarına en kısa uzaklığı (px). */
export function cutMarginPx(profileCut: Shape, framePx: number): number {
  const b = shapeBounds(profileCut);
  return Math.max(0, Math.min(b.x, b.y, framePx - (b.x + b.w), framePx - (b.y + b.h)));
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Şablon kesiminin boyut kimliği (iş/raf/sayfa şablonu `sizeId`): dairede cm ("3.8", "4"; profil boyut kimlikleriyle
 * aynı biçim), dikdörtgende "63.5x38.1" (mm), köşesi yuvarlatılmışta "63.5x38.1r3", ovalde "63.5x38.1-oval".
 */
export function cutSizeId(cut: TemplateCutInput): string {
  const c = normalizeCut(cut);
  if (c.shape === "circle") return fmt(c.wMm / 10);
  const base = `${fmt(c.wMm)}x${fmt(c.hMm)}`;
  if (c.shape === "ellipse") return `${base}-oval`;
  if (c.shape === "roundRect" && c.radiusMm > 0) return `${base}r${fmt(c.radiusMm)}`;
  return base;
}

/**
 * `cutSizeId`'nin tersi: "63.5x38.1" → dikdörtgen, "50x30r3" → köşesi yuvarlak, "50x30-oval" → oval. Dairenin kimliği
 * ("3.8") eski boyut kimlikleriyle aynı biçimdedir; ayırt edilemez → null (eski boyut sayılır).
 */
export function parseCutSizeId(sizeId: string | null | undefined): TemplateCut | null {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:r(\d+(?:\.\d+)?)|(-oval))?$/.exec(sizeId ?? "");
  if (!m) return null;
  const wMm = Number(m[1]);
  const hMm = Number(m[2]);
  if (m[4]) return normalizeCut({ shape: "ellipse", wMm, hMm });
  if (m[3]) return normalizeCut({ shape: "roundRect", wMm, hMm, radiusMm: Number(m[3]) });
  return normalizeCut({ shape: "rect", wMm, hMm });
}

/** Kesimin baskı sayfasındaki yuva karşılığı (mm): şekil, en, boy, köşe. */
export function cutSlotShape(cut: TemplateCutInput): { shape: "circle" | "ellipse" | "rect"; w: number; h: number; cornerRadius: number } {
  const c = normalizeCut(cut);
  if (c.shape === "circle") return { shape: "circle", w: c.wMm, h: c.wMm, cornerRadius: 0 };
  if (c.shape === "ellipse") return { shape: "ellipse", w: c.wMm, h: c.hMm, cornerRadius: 0 };
  return { shape: "rect", w: c.wMm, h: c.hMm, cornerRadius: c.radiusMm };
}

/**
 * Yuva bu kesime uyuyor mu (şekil aynı; en/boy `tolMm` içinde, 90° döndürülmüş dikdörtgen de kabul)? Uymuyorsa
 * baskıda kesim çizgisi etiketin kenarına oturmaz: görünür uyarı verilir (engellemez).
 */
export function slotFitsCut(slot: { shape: "circle" | "ellipse" | "rect"; w: number; h: number; rotation?: number }, cut: TemplateCutInput, tolMm = 0.5): boolean {
  const want = cutSlotShape(cut);
  const same = (a: number, b: number) => Math.abs(a - b) <= tolMm;
  const isCircle = (s: { shape: string; w: number; h: number }) => s.shape === "circle" || (s.shape === "ellipse" && same(s.w, s.h));
  if (isCircle(want) || isCircle(slot)) return isCircle(want) && isCircle(slot) && same(slot.w, want.w);
  if (slot.shape !== want.shape) return false;
  const turned = Math.abs(((slot.rotation ?? 0) % 180) - 90) < 1;
  const [w, h] = turned ? [slot.h, slot.w] : [slot.w, slot.h];
  return (same(w, want.w) && same(h, want.h)) || (want.shape === "rect" && same(w, want.h) && same(h, want.w));
}

/**
 * Kesimli etiketin bu yuvadaki dönüşü (derece): yuva kesimle aynı yöndeyse yuvanın dönüşü; en/boyu yer değiştirmiş
 * (dikey) dikdörtgen yuvada +90. Uymuyorsa null (görünür uyarı; öğe döndürülmez).
 */
export function cutRotationForSlot(slot: { shape: "circle" | "ellipse" | "rect"; w: number; h: number; rotation?: number }, cut: TemplateCutInput, tolMm = 0.5): number | null {
  if (!slotFitsCut(slot, cut, tolMm)) return null;
  const want = cutSlotShape(cut);
  const base = slot.rotation ?? 0;
  if (want.shape === "circle" || Math.abs(want.w - want.h) <= tolMm) return base;
  const same = (a: number, b: number) => Math.abs(a - b) <= tolMm;
  const upright = same(slot.w, want.w) && same(slot.h, want.h);
  if (upright) return base;
  // Çeyrek tur ekle; yazı baş aşağı (|açı| > 90) kalmasın diye yarım tur geri al.
  let rot = (((base + 90) % 360) + 360) % 360;
  if (rot > 180) rot -= 360;
  if (Math.abs(rot) > 90) rot -= Math.sign(rot) * 180;
  return rot;
}

/** Yuvada köşe yarıçapı farkı (yalnız dikdörtgen kesim/yuva; mm): köşesi yuvarlak kesim köşesiz yuvada ya da tersi. */
export function cornerMismatchMm(slot: { shape: string; cornerRadius?: number }, cut: TemplateCutInput): number {
  const want = cutSlotShape(cut);
  if (want.shape !== "rect" || slot.shape !== "rect") return 0;
  return Math.abs((slot.cornerRadius ?? 0) - want.cornerRadius);
}

/** Kesimin okunur adı (uyarılar için): "Ø38 mm daire", "63.5 × 38.1 mm dikdörtgen". */
export function cutLabel(cut: TemplateCutInput): string {
  const c = normalizeCut(cut);
  if (c.shape === "circle") return `Ø${fmt(c.wMm)} mm daire`;
  const size = `${fmt(c.wMm)} × ${fmt(c.hMm)} mm`;
  return c.shape === "ellipse" ? `${size} oval` : c.shape === "roundRect" ? `${size} köşesi yuvarlak dikdörtgen` : `${size} dikdörtgen`;
}
