import type { Bitmap, Box, Point, Shape, TemplateGeometry } from "@tagpress/domain";
import { shapeBounds } from "@tagpress/domain";
import { insetShape, insideShape, shapeDiameter } from "./shapes.ts";

/**
 * Test ve deneme için küçük geometri kurucu (gerçek geometri `@tagpress/templates` → `buildGeometry`).
 * Varsayılan: 440 px tasarım alanı, ölçek 2, daire kesim, ortada elips yazı alanı, isteğe bağlı dekor şekilleri.
 * Serbest maske = kesim (nefes payı kadar içeride) ∧ alan ∧ kurdele dışı ∧ dekordan nefes payı kadar uzak.
 */
export interface TestGeometryOptions {
  key?: string;
  framePx?: number;
  scale?: number;
  cut?: Shape;
  /** Yazı alanı (tasarım px). Varsayılan: kesimin %80'i kadar elips. */
  area?: Shape;
  /** Kesin dekor şekilleri (tasarım px). */
  decorations?: Shape[];
  /** Nefes payı (px). Varsayılan: kesim çapının 0,03'ü. */
  breathingPx?: number;
  /** Üstte kurdele bandı: kesim çapının bu oranı. */
  ribbonTop?: number;
  target?: Point;
  dark?: boolean;
  imagePath?: string;
  templateBox?: Box;
}

function grow(s: Shape, d: number): Shape {
  return insetShape(s, -d);
}

export function makeTestGeometry(o: TestGeometryOptions = {}): TemplateGeometry {
  const framePx = o.framePx ?? 440;
  const S = o.scale ?? 2;
  const cut: Shape = o.cut ?? { kind: "circle", cx: framePx / 2, cy: framePx / 2, r: framePx / 2 - 1 };
  const D = shapeDiameter(cut);
  const b = o.breathingPx ?? 0.03 * D;
  const cb = shapeBounds(cut);
  const area: Shape = o.area ?? { kind: "ellipse", cx: cb.x + cb.w / 2, cy: cb.y + cb.h / 2, rx: 0.4 * cb.w, ry: 0.4 * cb.h };
  const inner = insetShape(cut, b);
  const decos = o.decorations ?? [];
  const grown = decos.map((d) => grow(d, b));
  const ribbonY = cb.y + (o.ribbonTop ?? 0) * D;
  const W = Math.round(framePx * S);
  const free = new Uint8Array(W * W);
  const deco = new Uint8Array(W * W);
  const rows: Array<Array<[number, number]>> = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < W; y++) {
    const row: Array<[number, number]> = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      let on = false;
      if (x < W) {
        const px = (x + 0.5) / S, py = (y + 0.5) / S;
        if (decos.some((d) => insideShape(d, px, py))) deco[y * W + x] = 1;
        on = py >= ribbonY && insideShape(inner, px, py) && insideShape(area, px, py) && !grown.some((d) => insideShape(d, px, py));
        if (on) {
          free[y * W + x] = 1;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
        }
      }
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        row.push([start / S, x / S]);
        start = -1;
      }
    }
    rows.push(row);
  }
  const areaBounds: Box = x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const bm = (data: Uint8Array): Bitmap => ({ width: W, height: W, scale: S, data });
  return {
    key: o.key ?? "test",
    framePx,
    cut,
    free: bm(free),
    decoration: bm(deco),
    rows,
    areaBounds,
    target: o.target ?? { x: areaBounds.x + areaBounds.w / 2, y: areaBounds.y + areaBounds.h / 2 },
    manualArea: !!o.area,
    background: { luminance: o.dark ? 0.1 : 0.95, dark: !!o.dark },
    imagePath: o.imagePath ?? "",
    templateBox: o.templateBox ?? { x: 10, y: 10, w: framePx - 20, h: framePx - 20 },
  };
}
