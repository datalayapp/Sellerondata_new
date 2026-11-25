import {
  ADJUST_LIMITS,
  adjustedInk,
  adjustedLineInks,
  type Box,
  boxCenter,
  centerAdjust,
  type CenterAxis,
  type CenterPoints,
  type CenterTarget,
  type LineAdjust,
  type Point,
  type StrokeAlign,
  effectiveLineStroke,
  stepScale,
  stepStroke,
  svgStrokeWidth,
  unionBoxes,
  type VariantAdjust,
} from "@tagpress/domain";
import { allTextName, fontEditedText, lineName, linesApartText, linesName, strokeNumber, strokePartText, textEditedText } from "../metin.ts";
import { adjustParts, adjustSummary, nudgeStep, screenToDesign } from "./adjust-math.ts";

/**
 * Satır seçimi ve seçime uygulanan işlemler (saf mantık). Birim: tasarım alanı px.
 * Satır dönüşümü domain `applyAdjustToLayout` ile birebir: satır önce KENDİ merkezi etrafında ölçeklenip kaydırılır, sonra blok.
 * Çoklu seçim: seçili satırlar BİR GRUP gibi davranır (birlikte taşınır; boyut grubun merkezine / karşı köşesine göre değişir;
 * ortalama grubun kutusunu hedefe oturtur). Her işlem tek düzeltme döndürür; geri al/yinele için tek adımdır.
 */

/** Seçim: satır sıraları (0'dan, sıralı, tekrarsız) ya da null = bütün yazı (blok). */
export type Sel = readonly number[] | null;
/** Eski çağrılar için tek satır sırası da kabul edilir. */
export type SelLike = Sel | number;

type Pt = { x: number; y: number };
/** Düzenleme modelinin yerleşim kısmı: kutular + kontur bilgisi (kalınlık mürekkep kutusunu büyütür). */
type InkLayout = { ink: Box; origin?: Point; strokePx?: number; strokeAlign?: StrokeAlign; lines: ReadonlyArray<{ ink: Box; strokePx?: number }> };
const alignOpts = (l: InkLayout) => ({ strokeAlign: l.strokeAlign });

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const clampShift = (v: number) => Math.max(-ADJUST_LIMITS.shiftMaxPx, Math.min(ADJUST_LIMITS.shiftMaxPx, v));
const clampScale = (v: number) => Math.max(ADJUST_LIMITS.scaleMin, Math.min(ADJUST_LIMITS.scaleMax, v));

/** Seçimi diziye çevirir: geçerli satır sıraları (sıralı, tekrarsız); hiç geçerli satır yoksa null (= bütün yazı). */
export function selIndices(sel: SelLike, count: number): number[] | null {
  if (sel === null) return null;
  const arr = typeof sel === "number" ? [sel] : sel;
  const out = [...new Set(arr)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b);
  return out.length ? out : null;
}

/** Tek satır seçimi. */
export const lineSel = (i: number): Sel => [i];

/** Seçimdeki satırlar; bütün yazıda hepsi (font değiştirme gibi satır işlemleri için). */
export function selectedLines(sel: SelLike, count: number): number[] {
  return selIndices(sel, count) ?? Array.from({ length: count }, (_, i) => i);
}

/** Seçim tek bir satır mı? Öyleyse sırası. */
export function singleLine(sel: SelLike, count: number): number | null {
  const s = selIndices(sel, count);
  return s && s.length === 1 ? s[0]! : null;
}

export function isSelected(sel: SelLike, i: number): boolean {
  if (sel === null) return false;
  return typeof sel === "number" ? sel === i : sel.includes(i);
}

/** Ctrl/Shift + tık: satırı seçime ekler ya da çıkarır. Bütün yazıdan başlarken yalnızca o satır seçilir; boşalırsa bütün yazı. */
export function toggleSel(sel: SelLike, i: number, count: number): Sel {
  const cur = selIndices(sel, count);
  if (!cur) return [i];
  const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
  return next.length ? next : null;
}

/** İki seçim aynı mı? */
export function sameSel(a: SelLike, b: SelLike, count: number): boolean {
  return JSON.stringify(selIndices(a, count)) === JSON.stringify(selIndices(b, count));
}

// ---------------------------------------------------------------- dönüşümler

/** Tek ölçek + kaydırma: x' = s·x + tx, y' = s·y + ty. SVG/CSS `matrix(s 0 0 s tx ty)` ile aynıdır. */
export interface Mat {
  s: number;
  tx: number;
  ty: number;
}

/** Merkez `c` etrafında ölçekle, sonra kaydır: p' = c + s·(p − c) + d. */
export function aroundMat(c: Pt, s: number, dx: number, dy: number): Mat {
  return { s, tx: c.x * (1 - s) + dx, ty: c.y * (1 - s) + dy };
}

/** Önce `inner`, sonra `outer`. */
export function composeMat(outer: Mat, inner: Mat): Mat {
  return { s: outer.s * inner.s, tx: outer.s * inner.tx + outer.tx, ty: outer.s * inner.ty + outer.ty };
}

export function mapBoxBy(m: Mat, b: Box): Box {
  return { x: m.s * b.x + m.tx, y: m.s * b.y + m.ty, w: b.w * m.s, h: b.h * m.s };
}

/** Blok dönüşümü: merkez = düzeltmesiz (ve düzenlenmemiş) yazı bloğunun merkezi. */
export function blockMat(layout: InkLayout, a: VariantAdjust): Mat {
  return aroundMat(layout.origin ?? boxCenter(layout.ink), a.scale, a.dx, a.dy);
}

/** Satır dönüşümü: satırın kendi merkezi etrafında. */
export function lineMat(ink: Box, la: Pick<LineAdjust, "dx" | "dy" | "scale">): Mat {
  return aroundMat(boxCenter(ink), la.scale, la.dx, la.dy);
}

/** Satır grubunun SVG `transform` özniteliği (blok dönüşümü dıştaki kapta uygulanır). */
export function lineTransformAttr(ink: Box, la: Pick<LineAdjust, "dx" | "dy" | "scale">): string {
  const m = lineMat(ink, la);
  const n = (v: number) => String(Math.round(v * 10000) / 10000);
  return `matrix(${n(m.s)} 0 0 ${n(m.s)} ${n(m.tx)} ${n(m.ty)})`;
}

// ---------------------------------------------------------------- satır düzeltmesi

/** Satır düzeltmesi yoksa kimlik değerleri. */
export function lineAdjustOf(a: VariantAdjust, index: number): LineAdjust {
  return a.lines?.find((l) => l.index === index) ?? { index, dx: 0, dy: 0, scale: 1 };
}

/** Satırın kontur farkı (tasarım px). */
export function lineStroke(l: LineAdjust): number {
  return l.strokePx ?? 0;
}

function lineIsNeutral(l: LineAdjust): boolean {
  return Math.abs(l.dx) < 0.005 && Math.abs(l.dy) < 0.005 && Math.abs(l.scale - 1) < 0.00005 && Math.abs(lineStroke(l)) < 0.005;
}

/** Satır düzeltmesini yazar; etkisiz satır listeden çıkar. */
export function setLineAdjust(a: VariantAdjust, la: LineAdjust): VariantAdjust {
  const rest = (a.lines ?? []).filter((l) => l.index !== la.index);
  const lines = lineIsNeutral(la) ? rest : [...rest, la].sort((x, y) => x.index - y.index);
  const { lines: _drop, ...head } = a;
  return lines.length ? { ...head, lines } : head;
}

// ---------------------------------------------------------------- seçim

/** Seçimin düzeltilmiş kutusu (çoklu seçimde satır kutularının birleşimi). */
export function selectionBox(layout: InkLayout, a: VariantAdjust, sel: SelLike): Box {
  const idx = selIndices(sel, layout.lines.length);
  if (!idx) return adjustedInk(layout, a, alignOpts(layout));
  const inks = adjustedLineInks(layout, a, alignOpts(layout));
  return unionBoxes(idx.map((i) => inks[i]!)) ?? adjustedInk(layout, a, alignOpts(layout));
}

/** "Satır 2: Matteo" / "3 satır" / "Bütün yazı". */
export function selectionName(sel: SelLike, lines: ReadonlyArray<{ text: string }>): string {
  const idx = selIndices(sel, lines.length);
  if (!idx) return allTextName();
  if (idx.length > 1) return linesName(idx.length, idx.map((i) => i + 1).join(", "));
  const i = idx[0]!;
  const t = lines[i]!.text.trim();
  return lineName(i + 1, t.length > 18 ? `${t.slice(0, 17)}…` : t);
}

/** Seçimin kısa özeti: "sağa 12 px · boyut %104" (çoklu seçimde ilk satır). */
export function selectionSummary(a: VariantAdjust, sel: SelLike): string {
  if (sel === null) return adjustSummary(a);
  const first = typeof sel === "number" ? sel : sel[0];
  if (first === undefined) return adjustSummary(a);
  const la = lineAdjustOf(a, first);
  return adjustSummary({ dx: la.dx, dy: la.dy, scale: la.scale });
}

/** Sırayla gezinme: "bütün yazı → satır 1 … son satır → bütün yazı". Tab ileri, Shift+Tab geri. Çoklu seçimde son satırdan. */
export function cycleSel(sel: SelLike, count: number, back: boolean): Sel {
  const idx = selIndices(sel, count);
  const at = idx ? (back ? idx[0]! : idx[idx.length - 1]!) + 1 : 0; // sıra listesinde: 0 = bütün yazı
  const n = count + 1;
  const next = (at + (back ? -1 : 1) + n) % n;
  return next === 0 ? null : [next - 1];
}

/** Tıklanan noktadaki satır (kutu `pad` tasarım px genişletilir; birden çoksa en küçük alanlı). Yoksa null. */
export function hitLine(layout: InkLayout, a: VariantAdjust, p: Pt, pad: number): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  adjustedLineInks(layout, a, alignOpts(layout)).forEach((b, i) => {
    if (p.x < b.x - pad || p.x > b.x + b.w + pad || p.y < b.y - pad || p.y > b.y + b.h + pad) return;
    const area = Math.max(1, b.w * b.h);
    if (area < bestArea) {
      best = i;
      bestArea = area;
    }
  });
  return best;
}

/** İki köşeyle verilen dikdörtgen (tasarım px) → kutu. */
export function rectFromPoints(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Seçim kutusu (marquee): kutuyla kesişen satırlar; hiçbiri yoksa null. */
export function marqueeHits(layout: InkLayout, a: VariantAdjust, rect: Box): number[] | null {
  const out: number[] = [];
  adjustedLineInks(layout, a, alignOpts(layout)).forEach((b, i) => {
    if (b.x <= rect.x + rect.w && b.x + b.w >= rect.x && b.y <= rect.y + rect.h && b.y + b.h >= rect.y) out.push(i);
  });
  return out.length ? out : null;
}

/** Seçim kutusunun sonucu: yeni satırlar; `add` (Ctrl/Shift) ile mevcut seçime eklenir. */
export function marqueeSel(layout: InkLayout, a: VariantAdjust, rect: Box, current: SelLike, add: boolean): Sel {
  const hits = marqueeHits(layout, a, rect);
  if (!add) return hits;
  const cur = selIndices(current, layout.lines.length) ?? [];
  const all = [...new Set([...cur, ...(hits ?? [])])].sort((x, y) => x - y);
  return all.length ? all : null;
}

// ---------------------------------------------------------------- taşıma

/** Seçimi son tasarım px cinsinden (ddx, ddy) kaydırır. Satırda blok ölçeği hesaba katılır; ekranda tam o kadar oynar. */
export function shiftSelection(a: VariantAdjust, sel: SelLike, ddx: number, ddy: number): VariantAdjust {
  if (sel === null || (typeof sel !== "number" && !sel.length)) return { ...a, dx: r2(clampShift(a.dx + ddx)), dy: r2(clampShift(a.dy + ddy)) };
  const idx = typeof sel === "number" ? [sel] : [...new Set(sel)];
  const S = a.scale || 1;
  let out = a;
  for (const i of idx) {
    const la = lineAdjustOf(out, i);
    out = setLineAdjust(out, { ...la, dx: r2(clampShift(la.dx + ddx / S)), dy: r2(clampShift(la.dy + ddy / S)) });
  }
  return out;
}

/** Fare sürüklemesi: başlangıç düzeltmesine ekran farkı eklenir. */
export function dragSelection(start: VariantAdjust, sel: SelLike, dxScreen: number, dyScreen: number, k: number): VariantAdjust {
  return shiftSelection(start, sel, screenToDesign(dxScreen, k), screenToDesign(dyScreen, k));
}

/** Ok tuşu: `step` tasarım px (varsayılan 1), Shift ile 10 katı. */
export function nudgeSelection(a: VariantAdjust, sel: SelLike, key: string, shift: boolean, step = 1): VariantAdjust {
  const s = nudgeStep(key, shift, step);
  return s ? shiftSelection(a, sel, s.dx, s.dy) : a;
}

/** Sürüklerken seçimin merkezi hedefe yapışır (Alt ile çağıran kapatır). */
export function snapSelection(layout: InkLayout, a: VariantAdjust, sel: SelLike, target: Pt, snapDesign: number): VariantAdjust {
  const c = boxCenter(selectionBox(layout, a, sel));
  const ddx = Math.abs(c.x - target.x) <= snapDesign ? target.x - c.x : 0;
  const ddy = Math.abs(c.y - target.y) <= snapDesign ? target.y - c.y : 0;
  return ddx || ddy ? shiftSelection(a, selIndices(sel, layout.lines.length), ddx, ddy) : a;
}

/** Ortalama: seçimin (grubun) merkezi hedefe oturur. Bütün yazıda domain `centerAdjust`. */
export function centerSelection(layout: InkLayout, centers: CenterPoints, a: VariantAdjust, sel: SelLike, opts: { axis: CenterAxis; target: CenterTarget }): VariantAdjust {
  const idx = selIndices(sel, layout.lines.length);
  if (!idx) return centerAdjust(layout, centers, a, opts);
  const c = boxCenter(selectionBox(layout, a, idx));
  const t = centers[opts.target];
  return shiftSelection(a, idx, opts.axis === "y" ? 0 : t.x - c.x, opts.axis === "x" ? 0 : t.y - c.y);
}

// ---------------------------------------------------------------- boyut

/** Seçimin güncel boyut çarpanı (çoklu seçimde ilk satırınki). */
export function selectionScale(a: VariantAdjust, sel: SelLike): number {
  if (sel === null) return a.scale;
  const first = typeof sel === "number" ? sel : sel[0];
  return first === undefined ? a.scale : lineAdjustOf(a, first).scale;
}

/** Tek satırın ölçeğini `newScale` yapar; `anchor` (son tasarım px) yerinde kalır. */
function scaleLineAbout(layout: InkLayout, a: VariantAdjust, i: number, newScale: number, anchor: Pt): VariantAdjust {
  const s2 = round4(clampScale(newScale));
  const O = layout.origin ?? boxCenter(layout.ink);
  const la = lineAdjustOf(a, i);
  const c = boxCenter(layout.lines[i]!.ink);
  const q = { x: O.x + (anchor.x - O.x - a.dx) / a.scale, y: O.y + (anchor.y - O.y - a.dy) / a.scale };
  const f = s2 / la.scale;
  return setLineAdjust(a, {
    ...la,
    scale: s2,
    dx: r2(clampShift(q.x - c.x - f * (q.x - c.x - la.dx))),
    dy: r2(clampShift(q.y - c.y - f * (q.y - c.y - la.dy))),
  });
}

/**
 * Seçimin ölçeğini `newScale` yapar; `anchor` (son tasarım px) noktası yerinde kalır.
 * Blok: p' = O + S·(p − O) + D için D yeniden çözülür. Satır: önce blok içindeki karşılığı bulunur, sonra satırın kaydırması çözülür.
 * Çoklu seçim: her satır aynı oranla (`newScale` / ilk satırın ölçeği) aynı nokta etrafında büyür; grup orantılı değişir.
 */
export function scaleSelectionAbout(layout: InkLayout, a: VariantAdjust, sel: SelLike, newScale: number, anchor: Pt): VariantAdjust {
  const idx = selIndices(sel, layout.lines.length);
  if (!idx) {
    const s2 = round4(clampScale(newScale));
    const O = layout.origin ?? boxCenter(layout.ink);
    const f = s2 / a.scale;
    return { ...a, scale: s2, dx: r2(clampShift(anchor.x - O.x - f * (anchor.x - O.x - a.dx))), dy: r2(clampShift(anchor.y - O.y - f * (anchor.y - O.y - a.dy))) };
  }
  if (idx.length === 1) return scaleLineAbout(layout, a, idx[0]!, newScale, anchor);
  const ratio = newScale / (lineAdjustOf(a, idx[0]!).scale || 1);
  let out = a;
  for (const i of idx) out = scaleLineAbout(layout, out, i, lineAdjustOf(a, i).scale * ratio, anchor);
  return out;
}

/** Boyut −/+ : bütün yazıda domain `stepScale`; satır(lar)da seçimin merkezi sabit kalır. */
export function stepSelectionScale(layout: InkLayout, a: VariantAdjust, sel: SelLike, step: number): VariantAdjust {
  const idx = selIndices(sel, layout.lines.length);
  if (!idx) return stepScale(a, step);
  return scaleSelectionAbout(layout, a, idx, selectionScale(a, idx) + step, boxCenter(selectionBox(layout, a, idx)));
}

export type Corner = "nw" | "ne" | "sw" | "se";
export const CORNERS: readonly Corner[] = ["nw", "ne", "se", "sw"];
const OPPOSITE: Record<Corner, Corner> = { nw: "se", se: "nw", ne: "sw", sw: "ne" };

export function cornerPoint(b: Box, c: Corner): Pt {
  return { x: c.endsWith("w") ? b.x : b.x + b.w, y: c.startsWith("n") ? b.y : b.y + b.h };
}
export const oppositeCorner = (c: Corner): Corner => OPPOSITE[c];

/**
 * Köşe tutamacıyla orantılı ölçek: karşı köşe sabit; oran, imlecin karşı köşeye uzaklığının başlangıçtaki köşe uzaklığına oranıdır
 * (köşegen yönüne izdüşüm).
 */
export function handleScale(layout: InkLayout, start: VariantAdjust, sel: SelLike, corner: Corner, pointer: Pt): VariantAdjust {
  const box = selectionBox(layout, start, sel);
  const C = cornerPoint(box, corner);
  const A = cornerPoint(box, oppositeCorner(corner));
  const vx = C.x - A.x;
  const vy = C.y - A.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return start;
  const f = Math.max(0.05, ((pointer.x - A.x) * vx + (pointer.y - A.y) * vy) / len2);
  return scaleSelectionAbout(layout, start, sel, selectionScale(start, selIndices(sel, layout.lines.length)) * f, A);
}

// ---------------------------------------------------------------- kalınlık

/** Kalınlık adımı (tasarım px). */
export const STROKE_STEP = 0.2;

/** Seçimin kontur farkı (tasarım px; çoklu seçimde ilk satırınki). */
export function selectionStroke(a: VariantAdjust, sel: SelLike): number {
  if (sel === null) return a.strokePx ?? 0;
  const first = typeof sel === "number" ? sel : sel[0];
  return first === undefined ? (a.strokePx ?? 0) : lineStroke(lineAdjustOf(a, first));
}

/** Kalınlık −/+ : bütün yazıda blok farkı, satır(lar)da her satırın farkı (domain `stepStroke`). Yuvarlanmış, −20..+20. */
export function stepSelectionStroke(a: VariantAdjust, sel: SelLike, step: number): VariantAdjust {
  if (sel === null) return stepStroke(a, step);
  const idx = typeof sel === "number" ? [sel] : [...new Set(sel)];
  if (!idx.length) return stepStroke(a, step);
  return idx.reduce((acc, i) => stepStroke(acc, step, i), a);
}

/** "+0,4" / "−0,2" / "0". */
export function strokeLabel(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (Math.abs(r) < 0.005) return "0";
  return `${r > 0 ? "+" : "−"}${strokeNumber(r)}`;
}

/** Seçilen satırların etkin konturlarının en büyüğü (tasarım px). Kalınlık − düğmesi 0'da kapanır. */
export function selectionEffectiveStroke(layout: InkLayout, a: VariantAdjust, sel: SelLike): number {
  const idx = selectedLines(sel, layout.lines.length);
  return Math.max(0, ...idx.map((i) => effectiveLineStroke(layout, a, i)));
}

/**
 * Bir satır grubunun SVG kontur öznitelikleri (domain sözleşmesi): `stroke-width` = svgStrokeWidth(etkin, hiza, blokÖlçeği · satırÖlçeği).
 * Etkin kontur 0 ise null (kontur yok).
 */
export function lineStrokeAttrs(layout: InkLayout, a: VariantAdjust, index: number): { width: number } | null {
  const eff = effectiveLineStroke(layout, a, index);
  const k = a.scale * lineAdjustOf(a, index).scale;
  const w = svgStrokeWidth(eff, layout.strokeAlign ?? "outside", k);
  return w > 0 ? { width: Math.round(w * 10000) / 10000 } : null;
}

/** Bütün düzeltmenin kısa özeti: blok + "2 satır ayrı" + "kalınlık +0,4" + "1 satır elle düzenlendi". */
export function fullSummary(a: VariantAdjust): string {
  const parts = adjustParts({ dx: a.dx, dy: a.dy, scale: a.scale });
  if (Math.abs(a.strokePx ?? 0) >= 0.005) parts.push(strokePartText(strokeLabel(a.strokePx ?? 0)));
  const n = (a.lines ?? []).filter((l) => !lineIsNeutral(l)).length;
  if (n) parts.push(linesApartText(n));
  const texts = (a.edits ?? []).filter((e) => e.text !== undefined).length;
  const fonts = (a.edits ?? []).filter((e) => e.fontId !== undefined || e.spans?.length).length;
  if (texts) parts.push(textEditedText(texts));
  if (fonts) parts.push(fontEditedText(fonts));
  return parts.length ? parts.join(" · ") : adjustSummary(a);
}
