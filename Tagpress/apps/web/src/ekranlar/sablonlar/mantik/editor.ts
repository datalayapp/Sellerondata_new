import { type Point, type Shape, shapeBounds, type TemplateArea, type TemplateCut, normalizeCut } from "@tagpress/domain";
import {
  type HandleId,
  insertPoint,
  moveShape,
  moveVertex,
  nearestEdge,
  polygonClick,
  removePoint,
  resizeShape,
  shapeFromDrag,
  vertexIndex,
} from "./shapeMath.ts";

/**
 * Yazı alanı düzenleyicisinin durum makinesi (saf; tuvalden bağımsız, birim testli). Eski `ShapeCanvas` ve yeni
 * Şablonlar ekranının tuvali aynı kuralı kullanır. Bütün noktalar tasarım alanına ORAN (0..1).
 *
 * Kurallar (bugünkü düzenleyiciyle aynı):
 * - Hedef merkez işareti katmanı açıksa her kipte sürüklenir. Çizim araçları yalnız Elle kipte.
 * - Oval / Dikdörtgen: sürükleyerek çizilir (Shift: daire / kare); çizim bitince araç Seç'e döner.
 * - Çokgen: tıklayarak nokta konur; ilk noktaya tıklamak, çift tık ya da Enter kapatır (en az 3 nokta). Esc iptal.
 * - Seç: şekli taşı, tutamakla boyutlandır; çokgende noktayı seç, taşı, Del ile sil (en az 3 nokta kalır), kenara çift
 *   tıklayınca nokta ekle. Oklar 1 px (Shift 10 px) kaydırır; seçili nokta varsa yalnız onu.
 */

export type Tool = "select" | "ellipse" | "rect" | "polygon";

export type Interaction =
  | { type: "draw"; kind: "ellipse" | "rect"; start: Point; cur: Point; square: boolean }
  | { type: "poly"; points: Point[]; hover: Point | null }
  | { type: "move"; start: Point; orig: Shape }
  | { type: "handle"; id: HandleId; orig: Shape }
  | { type: "target" };

/** İşaretçinin altındaki öğe (tuval `data-role` ile söyler). */
export type Hit = { role: "target" } | { role: "handle"; id: HandleId } | { role: "shape" } | null;

export interface EditorCtx {
  /** Elle alan kipi. */
  manual: boolean;
  tool: Tool;
  /** Elle alanın şekli (oran); otomatik kipte null. */
  area: Shape | null;
  /** Hedef merkez katmanı açık mı (kapalıyken işaret sürüklenmez). */
  targetLayer: boolean;
  it: Interaction | null;
  /** Seçili çokgen noktası. */
  selVertex: number | null;
}

/**
 * Bir adımın sonucu. Yalnız verilen alanlar değişir: `it` (etkileşim; `null` = bitti), `selVertex`, `area` (yeni alan
 * şekli), `target` (yeni hedef merkez), `tool`, `capture` (işaretçi yakalansın).
 */
export interface Step {
  it?: Interaction | null;
  selVertex?: number | null;
  area?: Shape;
  target?: Point;
  tool?: Tool;
  capture?: boolean;
}

export const isDrawing = (it: Interaction | null) => it?.type === "draw" || it?.type === "poly";

/** Çokgeni kapat: en az 3 nokta varsa alan olur; araç Seç'e döner. */
export function finishPolygon(points: Point[]): Step {
  return { ...(points.length >= 3 ? { area: { kind: "polygon", points } as Shape } : {}), it: null, tool: "select" };
}

/** İşaretçi basışı. `null`: hiçbir şey değişmez. `detail`: tıklama sayısı (çift tıklamanın ikinci basışı yok sayılır). */
export function pointerDown(ctx: EditorCtx, hit: Hit, pt: Point, o: { shift: boolean; detail: number }): Step | null {
  if (hit?.role === "target" && ctx.targetLayer) return { capture: true, it: { type: "target" } };
  if (!ctx.manual) return null;
  if (ctx.tool === "ellipse" || ctx.tool === "rect") return { capture: true, it: { type: "draw", kind: ctx.tool, start: pt, cur: pt, square: o.shift } };
  if (ctx.tool === "polygon") {
    if (o.detail >= 2) return null; // çift tıklamanın ikinci basışı: çift tık bitirir
    const cur = ctx.it?.type === "poly" ? ctx.it.points : [];
    const r = polygonClick(cur, pt);
    if (r.closed) return finishPolygon(r.points);
    return { it: { type: "poly", points: r.points, hover: pt } };
  }
  // seçim aracı
  if (hit?.role === "handle" && ctx.area) return { capture: true, selVertex: vertexIndex(hit.id), it: { type: "handle", id: hit.id, orig: ctx.area } };
  if (hit?.role === "shape" && ctx.area) return { capture: true, selVertex: null, it: { type: "move", start: pt, orig: ctx.area } };
  return { selVertex: null };
}

/** İşaretçi hareketi (etkileşim sürerken). */
export function pointerMove(it: Interaction | null, pt: Point, shift: boolean): Step | null {
  if (!it) return null;
  switch (it.type) {
    case "draw":
      return { it: { ...it, cur: pt, square: shift } };
    case "poly":
      return { it: { ...it, hover: pt } };
    case "move":
      return { area: moveShape(it.orig, pt.x - it.start.x, pt.y - it.start.y) };
    case "handle":
      return { area: resizeShape(it.orig, it.id, pt) };
    case "target":
      return { target: pt };
  }
}

/** İşaretçi bırakıldı: çizim şekle döner (çok küçükse yok sayılır); çokgen çizimi sürer. */
export function pointerUp(it: Interaction | null, pt: Point, shift: boolean): Step | null {
  if (!it) return null;
  if (it.type === "draw") {
    const s = shapeFromDrag(it.kind, it.start, pt, shift || it.square);
    return s ? { area: s, tool: "select", it: null } : { it: null };
  }
  if (it.type === "poly") return null;
  return { it: null };
}

/** Çizim sırasında görünen önizleme şekli (oran). */
export function drawPreview(it: Interaction | null): Shape | null {
  return it?.type === "draw" ? shapeFromDrag(it.kind, it.start, it.cur, it.square) : null;
}

/**
 * Çift tık: çokgen çizimini bitirir; Seç aracında çokgenin kenarına yakınsa (`tolerance`, oran) oraya nokta ekler.
 */
export function doubleClick(ctx: EditorCtx, pt: Point, tolerance: number): Step | null {
  if (!ctx.manual) return null;
  if (ctx.it?.type === "poly") return finishPolygon(ctx.it.points);
  if (ctx.tool === "select" && ctx.area?.kind === "polygon") {
    const edge = nearestEdge(ctx.area.points, pt);
    if (edge.distance < tolerance) return { area: { kind: "polygon", points: insertPoint(ctx.area.points, edge.index, edge.point) }, selVertex: edge.index + 1 };
  }
  return null;
}

/** Esc: önce çizimi iptal, sonra aracı Seç'e döndür, sonra nokta seçimini kaldır. */
export function escapeStep(ctx: EditorCtx): Step {
  if (isDrawing(ctx.it)) return { it: null };
  if (ctx.tool !== "select") return { tool: "select" };
  return { selVertex: null };
}

/** Enter: çokgen çizimini kapatır; başka durumda yok. */
export function enterStep(ctx: EditorCtx): Step | null {
  return ctx.it?.type === "poly" ? finishPolygon(ctx.it.points) : null;
}

/** Del / Backspace: çokgen çizerken son noktayı geri alır; seçili noktayı siler (çokgen 3 noktanın altına inmez). */
export function deleteStep(ctx: EditorCtx): Step | null {
  if (isDrawing(ctx.it)) {
    if (ctx.it?.type === "poly") return { it: ctx.it.points.length > 1 ? { ...ctx.it, points: ctx.it.points.slice(0, -1) } : null };
    return null;
  }
  return removeVertexStep(ctx.area, ctx.selVertex);
}

/** Seçili noktayı sil ("Noktayı sil" düğmesi). */
export function removeVertexStep(area: Shape | null, selVertex: number | null): Step | null {
  if (area?.kind !== "polygon" || selVertex === null) return null;
  const pts = removePoint(area.points, selVertex);
  return pts ? { area: { kind: "polygon", points: pts }, selVertex: null } : null;
}

/** "Nokta ekle": en uzun kenarın ortasına; yeni nokta seçili olur. */
export function addVertexStep(area: Shape | null): Step | null {
  if (area?.kind !== "polygon" || area.points.length < 2) return null;
  let best = 0;
  let bestLen = -1;
  area.points.forEach((a, i) => {
    const b = area.points[(i + 1) % area.points.length]!;
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  });
  const a = area.points[best]!;
  const b = area.points[(best + 1) % area.points.length]!;
  return { area: { kind: "polygon", points: insertPoint(area.points, best, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) }, selVertex: best + 1 };
}

/** Ok tuşu: seçili çokgen noktasını ya da bütün şekli `step` (oran) kadar kaydırır. Elle alan yoksa yok. */
export function nudgeStep(ctx: Pick<EditorCtx, "manual" | "area" | "selVertex">, dx: number, dy: number, step: number): Step | null {
  const { area } = ctx;
  if (!area || !ctx.manual) return null;
  if (area.kind === "polygon" && ctx.selVertex !== null) return { area: moveVertex(area, ctx.selVertex, dx * step, dy * step) };
  return { area: moveShape(area, dx * step, dy * step) };
}

/** Klavye kısayolları (Esc, Enter, Del, oklar) anlamlı mı: Elle kipte çizim sürüyor, araç seçili ya da alan var. */
export function keysActive(ctx: Pick<EditorCtx, "manual" | "it" | "tool" | "area">): boolean {
  return ctx.manual && (isDrawing(ctx.it) || ctx.tool !== "select" || ctx.area !== null);
}

/** Araç değişince yarım kalan çizim iptal (taşıma / tutamak sürüyorsa kalır). */
export function onToolChange(it: Interaction | null): Interaction | null {
  return isDrawing(it) ? null : it;
}

/** Çokgen noktası seçimi alan değişince geçerli mi (alan çokgen değilse ya da nokta artık yoksa kalkar). */
export function validVertex(area: Shape | null, selVertex: number | null): number | null {
  if (area?.kind !== "polygon") return null;
  return selVertex !== null && selVertex >= area.points.length ? null : selVertex;
}

// ---------------------------------------------------------------- alan kipi ve hedef

/** Elle kipe ilk geçişte önerilen şekil: kesimin ortasında, kısa kenarın %30'u yarıçaplı daire (oran). */
export function defaultAreaShape(cutRatio: Shape): Shape {
  const b = shapeBounds(cutRatio);
  return { kind: "circle", cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: Math.min(b.w, b.h) * 0.3 };
}

/** Alan kipi değişimi: Otomatik'e geçince şekil düşer; Elle'ye geçince son elle şekil, yoksa önerilen şekil. */
export function areaForMode(mode: "auto" | "manual", lastManual: Shape | null, cutRatio: Shape): TemplateArea {
  if (mode === "auto") return { mode: "auto" };
  return { mode: "manual", shape: lastManual ?? defaultAreaShape(cutRatio) };
}

/** Hedef merkez kaydı dört basamağa yuvarlanır. */
export function roundTarget(p: Point): Point {
  return { x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 };
}

// ---------------------------------------------------------------- kesim (mm)

/** Kesim değerini `normalizeCut` ile kaydet (daire h=w, köşe yarıçapı sınırı). */
export function cutWith(cut: TemplateCut, patch: Partial<TemplateCut>): TemplateCut {
  return normalizeCut({ ...cut, ...patch });
}

/** Şekil değişince makul başlangıç: mevcut ölçü korunur; daireden dikdörtgene geçerken h=w ise dikdörtgen varsayılanı. */
export function cutFor(shape: TemplateCut["shape"], cur: TemplateCut | null): TemplateCut {
  const radiusMm = shape === "roundRect" ? cur?.radiusMm || 3 : 0;
  if (!cur) {
    if (shape === "circle") return normalizeCut({ shape, wMm: 38, hMm: 38, radiusMm });
    if (shape === "ellipse") return normalizeCut({ shape, wMm: 50, hMm: 35, radiusMm });
    return normalizeCut({ shape, wMm: 63.5, hMm: 38.1, radiusMm });
  }
  if (shape === "circle") return normalizeCut({ shape, wMm: cur.wMm, hMm: cur.wMm, radiusMm: 0 });
  if (cur.hMm === cur.wMm) {
    const d = shape === "ellipse" ? { wMm: 50, hMm: 35 } : { wMm: 63.5, hMm: 38.1 };
    return normalizeCut({ shape, ...d, radiusMm });
  }
  return normalizeCut({ shape, wMm: cur.wMm, hMm: cur.hMm, radiusMm });
}

/** En/boy oranı farkı bu kadarı aşarsa (göreli) görsel kesime gerilerek basılır: uyarı. */
export const ASPECT_TOLERANCE = 0.02;

/**
 * Yüklenen görselin en/boy oranı kesimle uyuşuyor mu? Uyuşmuyorsa görsel kesimin kutusuna gerilir (`templateImageBox`).
 * Görsel ya da kesim yoksa uyarı yok (`null`); varsa iki oran ve uyuşma sonucu.
 */
export function aspectCheck(image: { w: number; h: number } | null, cut: TemplateCut | null, tol = ASPECT_TOLERANCE): { image: number; cut: number; ok: boolean } | null {
  if (!image || !cut || !(image.w > 0) || !(image.h > 0)) return null;
  const c = normalizeCut(cut);
  const a = image.w / image.h;
  const b = c.wMm / c.hMm;
  return { image: a, cut: b, ok: Math.abs(a - b) / b <= tol };
}
