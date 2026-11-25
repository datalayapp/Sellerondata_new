import { z } from "zod";

/**
 * Koordinat sözleşmesi:
 * - "Tasarım alanı" her etiket boyutu için aynıdır: profilin `output.designFramePx` (varsayılan 440) kenarlı kare.
 *   Motor, önizleme ve baskı bu alanda çalışır. Etiket 2,5 / 5,2 cm olduğunda çerçeve
 *   sonradan o boyuta getirilir; şablon ve yazı merkez etrafında `contentScale` ile orantılı ölçeklenir
 *   (profil `output.sizes[].contentScale`, yoksa framePx / designFramePx; kullanıcı kararı 2026-10-09).
 * - Şablon kayıtlarındaki konumlar (alan, yazı merkezi) tasarım alanının kenarına göre 0..1 oranıdır.
 */

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof BoxSchema>;

/** Kesim ya da alan şekli. Birim: kullanıldığı yere göre px (profil) ya da 0..1 oran (şablon). */
export const ShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), cx: z.number(), cy: z.number(), r: z.number().positive() }),
  z.object({ kind: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number().positive(), ry: z.number().positive() }),
  z.object({ kind: z.literal("rect"), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), radius: z.number().min(0).default(0) }),
  /** Kapalı çokgen; noktalar saat yönünde ya da tersinde olabilir. */
  z.object({ kind: z.literal("polygon"), points: z.array(PointSchema).min(3) }),
]);
export type Shape = z.infer<typeof ShapeSchema>;

export function shapeBounds(s: Shape): Box {
  switch (s.kind) {
    case "circle":
      return { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r };
    case "ellipse":
      return { x: s.cx - s.rx, y: s.cy - s.ry, w: 2 * s.rx, h: 2 * s.ry };
    case "rect":
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case "polygon": {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

export function scaleShape(s: Shape, k: number): Shape {
  switch (s.kind) {
    case "circle":
      return { ...s, cx: s.cx * k, cy: s.cy * k, r: s.r * k };
    case "ellipse":
      return { ...s, cx: s.cx * k, cy: s.cy * k, rx: s.rx * k, ry: s.ry * k };
    case "rect":
      return { ...s, x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k, radius: s.radius * k };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: p.x * k, y: p.y * k })) };
  }
}

/** Tek kanallı bit maske (0/1 ya da 0..255). `scale`: maskenin tasarım alanına göre ölçeği (ör. 2 → 880 px). */
export interface Bitmap {
  width: number;
  height: number;
  scale: number;
  data: Uint8Array;
}
