import { type Box, type Point, type Shape, scaleShape, shapeBounds } from "@tagpress/domain";

/**
 * Şekil matematiği (saf). Şablon kayıtlarındaki şekiller tasarım alanının kenarına göre 0..1 orandır;
 * kesim şekli ise px'tir (profil). Buradaki düzenleme işlevleri ORAN birimiyle çalışır.
 */

/** Bir şeklin en küçük kenarı (oran): bundan küçük çizim yok sayılır. */
export const MIN_SIZE = 0.03;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const clampPt = (p: Point): Point => ({ x: clamp01(p.x), y: clamp01(p.y) });

export const ratioToPx = (s: Shape, frame: number): Shape => scaleShape(s, frame);
export const pxToRatio = (s: Shape, frame: number): Shape => scaleShape(s, 1 / frame);

// ---------------------------------------------------------------- çizim

export type DragKind = "ellipse" | "rect";

/** Sürükleyerek çizim: iki köşeden şekil. `square`: daire/kare. Çok küçükse null. */
export function shapeFromDrag(kind: DragKind, a: Point, b: Point, square = false): Shape | null {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * m;
    dy = (dy < 0 ? -1 : 1) * m;
  }
  const x0 = clamp01(Math.min(a.x, a.x + dx));
  const x1 = clamp01(Math.max(a.x, a.x + dx));
  const y0 = clamp01(Math.min(a.y, a.y + dy));
  const y1 = clamp01(Math.max(a.y, a.y + dy));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < MIN_SIZE || h < MIN_SIZE) return null;
  if (kind === "rect") return { kind: "rect", x: x0, y: y0, w, h, radius: 0 };
  if (square) {
    const r = Math.min(w, h) / 2;
    return { kind: "circle", cx: x0 + w / 2, cy: y0 + h / 2, r };
  }
  return { kind: "ellipse", cx: x0 + w / 2, cy: y0 + h / 2, rx: w / 2, ry: h / 2 };
}

/** Çokgen çizimi: kapatmak için ilk noktaya bu uzaklıkta (oran) tıklanır. */
export const CLOSE_DISTANCE = 0.025;

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Çokgen çizimi sırasında bir tıklama: ilk noktaya yakınsa ve ≥3 nokta varsa kapatır. */
export function polygonClick(points: Point[], p: Point, closeDistance = CLOSE_DISTANCE): { points: Point[]; closed: boolean } {
  const first = points[0];
  if (points.length >= 3 && first && dist(first, p) <= closeDistance) return { points, closed: true };
  return { points: [...points, clampPt(p)], closed: false };
}

// ---------------------------------------------------------------- tutamaçlar

export type HandleId = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se" | `v${number}`;
export interface Handle {
  id: HandleId;
  x: number;
  y: number;
  cursor: string;
}

const CURSOR: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };

export function handlesOf(s: Shape): Handle[] {
  if (s.kind === "polygon") return s.points.map((p, i) => ({ id: `v${i}` as HandleId, x: p.x, y: p.y, cursor: "move" }));
  const b = shapeBounds(s);
  const l = b.x;
  const r = b.x + b.w;
  const t = b.y;
  const bt = b.y + b.h;
  const mx = b.x + b.w / 2;
  const my = b.y + b.h / 2;
  const at = (id: Exclude<HandleId, `v${number}`>, x: number, y: number): Handle => ({ id, x, y, cursor: CURSOR[id] ?? "move" });
  if (s.kind === "circle") return [at("n", mx, t), at("s", mx, bt), at("w", l, my), at("e", r, my)];
  return [at("nw", l, t), at("n", mx, t), at("ne", r, t), at("e", r, my), at("se", r, bt), at("s", mx, bt), at("sw", l, bt), at("w", l, my)];
}

export function vertexIndex(id: HandleId): number | null {
  return id.startsWith("v") ? Number(id.slice(1)) : null;
}

/** Tutamağı `p` noktasına sürükle. */
export function resizeShape(s: Shape, id: HandleId, p0: Point): Shape {
  const p = clampPt(p0);
  if (s.kind === "polygon") {
    const i = vertexIndex(id);
    if (i === null || i < 0 || i >= s.points.length) return s;
    return { ...s, points: s.points.map((q, j) => (j === i ? p : q)) };
  }
  if (s.kind === "circle") {
    const r = id === "e" || id === "w" ? Math.abs(p.x - s.cx) : Math.abs(p.y - s.cy);
    // Kenardan taşmasın.
    const max = Math.min(s.cx, 1 - s.cx, s.cy, 1 - s.cy);
    return { ...s, r: clamp(r, MIN_SIZE / 2, Math.max(MIN_SIZE / 2, max)) };
  }
  const b = shapeBounds(s);
  let l = b.x;
  let r = b.x + b.w;
  let t = b.y;
  let bt = b.y + b.h;
  if (id.includes("w")) l = Math.min(p.x, r - MIN_SIZE);
  if (id.includes("e")) r = Math.max(p.x, l + MIN_SIZE);
  if (id.includes("n")) t = Math.min(p.y, bt - MIN_SIZE);
  if (id.includes("s")) bt = Math.max(p.y, t + MIN_SIZE);
  if (s.kind === "rect") return { ...s, x: l, y: t, w: r - l, h: bt - t };
  return { ...s, cx: (l + r) / 2, cy: (t + bt) / 2, rx: (r - l) / 2, ry: (bt - t) / 2 };
}

// ---------------------------------------------------------------- taşıma

/** Şekli (dx, dy) oran kadar taşır; sınırlar tasarım alanından çıkmaz. */
export function moveShape(s: Shape, dx: number, dy: number): Shape {
  const b = shapeBounds(s);
  const mx = Math.min(1 - (b.x + b.w), Math.max(-b.x, dx));
  const my = Math.min(1 - (b.y + b.h), Math.max(-b.y, dy));
  switch (s.kind) {
    case "circle":
    case "ellipse":
      return { ...s, cx: s.cx + mx, cy: s.cy + my };
    case "rect":
      return { ...s, x: s.x + mx, y: s.y + my };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: p.x + mx, y: p.y + my })) };
  }
}

/** Çokgenin tek noktasını taşır (ok tuşları). */
export function moveVertex(s: Shape, i: number, dx: number, dy: number): Shape {
  if (s.kind !== "polygon" || i < 0 || i >= s.points.length) return s;
  return { ...s, points: s.points.map((p, j) => (j === i ? clampPt({ x: p.x + dx, y: p.y + dy }) : p)) };
}

/** Klavye ile 1 px (Shift: 10 px) kaydırma: oran cinsinden adım. */
export function nudgeStep(frame: number, shift: boolean): number {
  return (shift ? 10 : 1) / frame;
}

// ---------------------------------------------------------------- çokgen düzenleme

export function nearestEdge(points: Point[], p: Point): { index: number; point: Point; distance: number } {
  let best = { index: 0, point: points[0] ?? p, distance: Infinity };
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
    const q = { x: a.x + t * abx, y: a.y + t * aby };
    const d = dist(p, q);
    if (d < best.distance) best = { index: i, point: q, distance: d };
  }
  return best;
}

/** `afterIndex` noktasından sonra yeni nokta ekler. */
export function insertPoint(points: Point[], afterIndex: number, p: Point): Point[] {
  return [...points.slice(0, afterIndex + 1), p, ...points.slice(afterIndex + 1)];
}

/** Noktayı siler; çokgen 3 noktanın altına inmeyecekse null. */
export function removePoint(points: Point[], index: number): Point[] | null {
  if (points.length <= 3 || index < 0 || index >= points.length) return null;
  return points.filter((_, i) => i !== index);
}

/** Oval/dikdörtgeni noktalarla düzenlemek için çokgene çevirir. */
export function toPolygon(s: Shape, segments = 32): Shape {
  if (s.kind === "polygon") return s;
  if (s.kind === "rect") {
    return {
      kind: "polygon",
      points: [
        { x: s.x, y: s.y },
        { x: s.x + s.w, y: s.y },
        { x: s.x + s.w, y: s.y + s.h },
        { x: s.x, y: s.y + s.h },
      ],
    };
  }
  const rx = s.kind === "circle" ? s.r : s.rx;
  const ry = s.kind === "circle" ? s.r : s.ry;
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: s.cx + rx * Math.cos(a), y: s.cy + ry * Math.sin(a) });
  }
  return { kind: "polygon", points };
}

// ---------------------------------------------------------------- sorgular

export function pointInShape(s: Shape, p: Point): boolean {
  switch (s.kind) {
    case "circle":
      return dist(p, { x: s.cx, y: s.cy }) <= s.r;
    case "ellipse":
      return ((p.x - s.cx) / s.rx) ** 2 + ((p.y - s.cy) / s.ry) ** 2 <= 1;
    case "rect":
      return p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
    case "polygon": {
      let inside = false;
      const pts = s.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!;
        const b = pts[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }
  }
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** SVG yol verisi (çizim, kırpma yolu). Verilen birimde çalışır. */
export function shapeToPath(s: Shape): string {
  switch (s.kind) {
    case "circle":
      return `M${n3(s.cx - s.r)} ${n3(s.cy)}a${n3(s.r)} ${n3(s.r)} 0 1 0 ${n3(2 * s.r)} 0a${n3(s.r)} ${n3(s.r)} 0 1 0 ${n3(-2 * s.r)} 0Z`;
    case "ellipse":
      return `M${n3(s.cx - s.rx)} ${n3(s.cy)}a${n3(s.rx)} ${n3(s.ry)} 0 1 0 ${n3(2 * s.rx)} 0a${n3(s.rx)} ${n3(s.ry)} 0 1 0 ${n3(-2 * s.rx)} 0Z`;
    case "rect":
      return `M${n3(s.x)} ${n3(s.y)}h${n3(s.w)}v${n3(s.h)}h${n3(-s.w)}Z`;
    case "polygon":
      return s.points.map((p, i) => `${i === 0 ? "M" : "L"}${n3(p.x)} ${n3(p.y)}`).join("") + "Z";
  }
}

// ---------------------------------------------------------------- kurdele ve hedef

/** Kesim çapı (px): daire/elipste genişlik, dikdörtgende kısa kenar (profildeki `cutDiameter` ile aynı kural). */
export function cutDiameterOf(cut: Shape): number {
  switch (cut.kind) {
    case "circle":
      return 2 * cut.r;
    case "ellipse":
      return 2 * Math.min(cut.rx, cut.ry);
    case "rect":
      return Math.min(cut.w, cut.h);
    case "polygon": {
      const b = shapeBounds(cut);
      return Math.min(b.w, b.h);
    }
  }
}

/** Kurdele bandının alt sınırı (kesimle aynı birim): kesimin üstünden `ribbonTop × çap` aşağıda. */
export function ribbonLimitY(cut: Shape, ribbonTop: number): number {
  return shapeBounds(cut).y + clamp(ribbonTop, 0, 0.6) * cutDiameterOf(cut);
}

/** Hedef merkez yoksa gösterilecek yer: elle alanın sınır kutusu merkezi, yoksa kesimin merkezi (oran). */
export function areaCenter(area: Shape | null, cutRatio: Shape): Point {
  const b = shapeBounds(area ?? cutRatio);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Hedef merkez etrafında yakın görünüm: kenarı `span` olan kare, merkezde ama alanın dışına taşmadan.
 * `frame`: alanın kenarı (oran için 1, px için tasarım alanı).
 */
export function cropBox(center: Point, span: number, frame = 1): Box {
  const s = Math.min(span, frame);
  return { x: clamp(center.x - s / 2, 0, frame - s), y: clamp(center.y - s / 2, 0, frame - s), w: s, h: s };
}

export const toPct = (v: number) => Math.round(v * 1000) / 10;
