import sharp from "sharp";
import type { TemplateGeometry } from "@tagpress/domain";
import { type FontRegistry, runToSvg, type ShapedRun, svgDocument } from "@tagpress/typeset";
import { insideShape } from "./shapes.ts";

/**
 * verify: tek raster doğrulama. Yazı mürekkebi (kontur dahil, alfa ≥ %50) kesim dışında 0 piksel olmalı;
 * kesin dekorla kesişme ≤ max(2·S², %0,15 mürekkep). Serbest alan dışına (nefes payına) taşan mürekkep
 * yalnızca puana yansır.
 */

export interface PositionedRun {
  shaped: ShapedRun;
  /** Run başlangıcı ve taban çizgisi (tasarım px). */
  x: number;
  baseline: number;
  /** Bu run'ın konturu (hafif düzeltmede satır başına kalınlık). Verilmezse `verifyRaster`'ın ortak konturu. */
  stroke?: { widthPx: number; align: "outside" | "center" } | null;
}

export interface CollisionReport {
  inkPx: number;
  outsideCutPx: number;
  decorationPx: number;
  /** Serbest alan dışındaki (nefes payındaki) mürekkep. */
  outsideFreePx: number;
  ok: boolean;
}

const cutCache = new WeakMap<TemplateGeometry, { S: number; mask: Uint8Array; w: number }>();

function cutMask(g: TemplateGeometry, S: number): { mask: Uint8Array; w: number } {
  const hit = cutCache.get(g);
  if (hit && hit.S === S) return hit;
  const w = Math.round(g.framePx * S);
  const mask = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) mask[y * w + x] = insideShape(g.cut, (x + 0.5) / S, (y + 0.5) / S) ? 1 : 0;
  const out = { S, mask, w };
  cutCache.set(g, out);
  return out;
}

function sample(bm: TemplateGeometry["free"], S: number, x: number, y: number): number {
  if (!bm.width) return 0;
  const k = bm.scale / S;
  const bx = Math.floor((x + 0.5) * k);
  const by = Math.floor((y + 0.5) * k);
  if (bx < 0 || by < 0 || bx >= bm.width || by >= bm.height) return 0;
  return bm.data[by * bm.width + bx]!;
}

export function collisionAllowed(report: Omit<CollisionReport, "ok">, S: number): boolean {
  return report.outsideCutPx === 0 && report.decorationPx <= Math.max(2 * S * S, 0.0015 * report.inkPx);
}

export async function verifyRaster(
  fonts: FontRegistry,
  g: TemplateGeometry,
  runs: readonly PositionedRun[],
  stroke: { widthPx: number; align: "outside" | "center" } | null,
): Promise<CollisionReport> {
  const S = g.decoration.scale || g.free.scale || 2;
  // Yalnızca mürekkep kutusu çizilir (hızlı): kutu dışında mürekkep yok.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const strokeOf = (r: PositionedRun) => (r.stroke !== undefined ? r.stroke : stroke);
  for (const r of runs) {
    if (!r.shaped.ink) continue;
    const st = strokeOf(r);
    const pad = st && st.widthPx > 0 ? st.widthPx + 1 : 1;
    x0 = Math.min(x0, r.x + r.shaped.ink.x0 - pad);
    x1 = Math.max(x1, r.x + r.shaped.ink.x1 + pad);
    y0 = Math.min(y0, r.baseline + r.shaped.ink.y0 - pad);
    y1 = Math.max(y1, r.baseline + r.shaped.ink.y1 + pad);
  }
  if (x0 === Infinity) return { inkPx: 0, outsideCutPx: 0, decorationPx: 0, outsideFreePx: 0, ok: true };
  const px0 = Math.floor(x0 * S), py0 = Math.floor(y0 * S);
  const w = Math.max(1, Math.ceil(x1 * S) - px0), h = Math.max(1, Math.ceil(y1 * S) - py0);
  const body = runs.map((r) => runToSvg(fonts, r.shaped, r.x - px0 / S, r.baseline - py0 / S, { color: "#000", stroke: strokeOf(r), scale: S, monochrome: true })).join("");
  const { data, info } = await sharp(Buffer.from(svgDocument(w, h, body))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cut = cutMask(g, S);
  let inkPx = 0, outsideCutPx = 0, decorationPx = 0, outsideFreePx = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3]! < 128) continue;
      inkPx++;
      const ax = x + px0, ay = y + py0;
      const inCut = ax >= 0 && ay >= 0 && ax < cut.w && ay < cut.w && cut.mask[ay * cut.w + ax] === 1;
      if (!inCut) outsideCutPx++;
      if (sample(g.decoration, S, ax, ay)) decorationPx++;
      if (!sample(g.free, S, ax, ay)) outsideFreePx++;
    }
  }
  const report = { inkPx, outsideCutPx, decorationPx, outsideFreePx };
  return { ...report, ok: collisionAllowed(report, S) };
}
