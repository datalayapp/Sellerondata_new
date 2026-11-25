import { type PrintSlot, type PrintTemplate, type PrintTemplateWarning, printWarningMsg } from "@tagpress/domain";
import { MARK_SAFE_MM, markOverlappingSlots } from "@tagpress/print";
import type { Pt, Rect } from "../../../tezgah/tuval/canvas-math.ts";

/**
 * Yuva geometrisi — SAF. Birim mm; yuva merkezi (cx, cy), ölçü w × h, döndürme derece (saat yönü).
 * İsabet testi, sınır kutusu, çakışma (dışbükey çokgenlerde ayırıcı eksen), kağıt dışı, hizala/dağıt, it.
 */

export type SlotShape = PrintSlot["shape"];
/** Sayısal karşılaştırma payı (mm): değmek çakışma sayılmaz. */
export const TOUCH_EPS_MM = 0.01;

const rad = (deg: number) => (deg * Math.PI) / 180;
/** mm değerini 0,01 mm'ye yuvarlar (kayan nokta tozunu temizler). */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Dünyadaki noktayı yuvanın yerel eksenine çevirir (merkez 0,0; döndürmesiz). */
export function toLocal(s: Pick<PrintSlot, "cx" | "cy" | "rotation">, p: Pt): Pt {
  const a = -rad(s.rotation ?? 0);
  const dx = p.x - s.cx;
  const dy = p.y - s.cy;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

/** Nokta yuvanın içinde mi (kenar dahil)? Dikdörtgende köşe yuvarlaklığı dikkate alınır. */
export function pointInSlot(s: PrintSlot, p: Pt, padMm = 0): boolean {
  const l = toLocal(s, p);
  const a = s.w / 2 + padMm;
  const b = s.h / 2 + padMm;
  if (s.shape !== "rect") return (l.x * l.x) / (a * a) + (l.y * l.y) / (b * b) <= 1 + 1e-9;
  if (Math.abs(l.x) > a || Math.abs(l.y) > b) return false;
  const r = Math.min(s.cornerRadius ?? 0, a, b);
  if (r <= 0) return true;
  const qx = Math.abs(l.x) - (a - r);
  const qy = Math.abs(l.y) - (b - r);
  return qx <= 0 || qy <= 0 || qx * qx + qy * qy <= r * r + 1e-9;
}

/** En üstteki (dizide en sondaki) isabet eden yuva. */
export function hitSlot(slots: readonly PrintSlot[], p: Pt, padMm = 0): PrintSlot | null {
  for (let i = slots.length - 1; i >= 0; i--) if (pointInSlot(slots[i]!, p, padMm)) return slots[i]!;
  return null;
}

/** Döndürülmüş şeklin eksen hizalı sınır kutusu (mm). */
export function slotBounds(s: Pick<PrintSlot, "shape" | "cx" | "cy" | "w" | "h" | "rotation">): Rect {
  const a = rad(s.rotation ?? 0);
  const c = Math.abs(Math.cos(a));
  const n = Math.abs(Math.sin(a));
  let hw: number;
  let hh: number;
  if (s.shape === "rect") {
    hw = (s.w / 2) * c + (s.h / 2) * n;
    hh = (s.w / 2) * n + (s.h / 2) * c;
  } else {
    const A = s.w / 2;
    const B = s.h / 2;
    hw = Math.sqrt(A * A * c * c + B * B * n * n);
    hh = Math.sqrt(A * A * n * n + B * B * c * c);
  }
  return { x: s.cx - hw, y: s.cy - hh, w: 2 * hw, h: 2 * hh };
}

/** Şeklin dışbükey çokgen yaklaşımı (dünya mm). Elips/daire `segments` köşeli; dikdörtgen 4 köşe (köşe yuvarlaklığı yok sayılır). */
export function slotPolygon(s: PrintSlot, segments = 48): Pt[] {
  const a = rad(s.rotation ?? 0);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const local: Pt[] =
    s.shape === "rect"
      ? [
          { x: -s.w / 2, y: -s.h / 2 },
          { x: s.w / 2, y: -s.h / 2 },
          { x: s.w / 2, y: s.h / 2 },
          { x: -s.w / 2, y: s.h / 2 },
        ]
      : Array.from({ length: segments }, (_, i) => {
          const t = (i / segments) * Math.PI * 2;
          return { x: (s.w / 2) * Math.cos(t), y: (s.h / 2) * Math.sin(t) };
        });
  return local.map((p) => ({ x: s.cx + p.x * cos - p.y * sin, y: s.cy + p.x * sin + p.y * cos }));
}

function project(poly: Pt[], ax: Pt): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p.x * ax.x + p.y * ax.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** İki dışbükey çokgen `eps`'ten fazla iç içe geçiyor mu (ayırıcı eksen teoremi)? */
export function polygonsOverlap(a: Pt[], b: Pt[], eps = TOUCH_EPS_MM): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const ax = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
      const [a0, a1] = project(a, ax);
      const [b0, b1] = project(b, ax);
      if (a1 - eps <= b0 || b1 - eps <= a0) return false;
    }
  }
  return true;
}

/** İki yuva çakışıyor mu? İki daire/elips dönmesizse kesin hesap; diğerlerinde çokgen yaklaşımı. */
export function slotsOverlap(a: PrintSlot, b: PrintSlot, eps = TOUCH_EPS_MM): boolean {
  const ba = slotBounds(a);
  const bb = slotBounds(b);
  if (ba.x + ba.w - eps <= bb.x || bb.x + bb.w - eps <= ba.x || ba.y + ba.h - eps <= bb.y || bb.y + bb.h - eps <= ba.y) return false;
  if (a.shape === "circle" && b.shape === "circle" && a.w === a.h && b.w === b.h) {
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.w / 2 + b.w / 2 - eps;
  }
  return polygonsOverlap(slotPolygon(a), slotPolygon(b), eps);
}

/** Kağıdın dışına taşan yuvalar. */
export function slotsOutside(slots: readonly PrintSlot[], paper: PrintTemplate["paper"], eps = TOUCH_EPS_MM): string[] {
  return slots
    .filter((s) => {
      const b = slotBounds(s);
      return b.x < -eps || b.y < -eps || b.x + b.w > paper.wMm + eps || b.y + b.h > paper.hMm + eps;
    })
    .map((s) => s.id);
}

/** Çakışan yuva çiftleri (sınır kutusuna göre sıralı tarama; birkaç bin yuvada da hızlı). */
export function overlappingPairs(slots: readonly PrintSlot[], eps = TOUCH_EPS_MM): Array<[string, string]> {
  const items = slots.map((s) => ({ s, b: slotBounds(s) })).sort((p, q) => p.b.x - q.b.x);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < items.length; i++) {
    const A = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const B = items[j]!;
      if (B.b.x >= A.b.x + A.b.w - eps) break;
      if (slotsOverlap(A.s, B.s, eps)) out.push([A.s.id, B.s.id]);
    }
  }
  return out;
}

/** Uyarıdaki yuva listesi (sunucuyla aynı): en çok 6 kimlik, fazlası "…". */
const idList = (ids: readonly string[]) => (ids.length > 6 ? `${ids.slice(0, 6).join(", ")} …` : ids.join(", "));

/**
 * Taslak şablonun uyarıları (canlı; engellemez). Sunucu da aynı kodlarla uyarır; burada kaydetmeden önce görünsün diye.
 * Cümle, sözlük anahtarı (`messageKey`) ve parametreler sunucuyla aynı (`@tagpress/domain` `printWarningMsg`): ekran
 * metni `printTemplates:warnings.<messageKey>` ile sözlükten okur.
 */
export function templateWarnings(
  t: Pick<PrintTemplate, "kind" | "paper" | "slots" | "labelDiameterMm"> & { stickerFlow?: PrintTemplate["stickerFlow"]; cut?: Pick<PrintTemplate["cut"], "registration" | "bleedMm"> },
): PrintTemplateWarning[] {
  const out: PrintTemplateWarning[] = [];
  if (t.kind === "label" && t.slots.length === 0) out.push({ ...printWarningMsg("no-slots"), slotIds: [] });
  if (t.kind === "sticker" && t.slots.length === 0 && t.stickerFlow === null) out.push({ ...printWarningMsg("no-slots-sticker"), slotIds: [] });
  const outside = slotsOutside(t.slots, t.paper);
  if (outside.length) out.push({ ...printWarningMsg("slot-outside", { count: outside.length, slots: idList(outside) }), slotIds: outside });
  const pairs = overlappingPairs(t.slots);
  if (pairs.length) {
    const ids = [...new Set(pairs.flat())];
    out.push({ ...printWarningMsg("slot-overlap", { count: ids.length, slots: idList(ids) }), slotIds: ids });
  }
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of t.slots) (seen.has(s.id) ? dup : seen).add(s.id);
  if (dup.size) out.push({ ...printWarningMsg("slot-duplicate-id", { slots: idList([...dup]) }), slotIds: [...dup] });
  if (t.labelDiameterMm) {
    const small = t.slots.filter((s) => Math.min(s.w, s.h) + TOUCH_EPS_MM < (t.labelDiameterMm ?? 0)).map((s) => s.id);
    if (small.length) out.push({ ...printWarningMsg("label-larger-than-slot", { diameter: t.labelDiameterMm, count: small.length }), slotIds: small });
  }
  if (t.cut?.registration.enabled && t.slots.length) {
    const near = markOverlappingSlots(t.paper, t.cut, t.slots);
    if (near.length) out.push({ ...printWarningMsg("mark-overlap", { count: near.length, safeMm: MARK_SAFE_MM, slots: idList(near) }), slotIds: near });
  }
  return out;
}

/** Kutuyla kesişen yuvalar (sınır kutusuna göre; Figma'daki gibi değen seçilir). */
export function slotsInRect(slots: readonly PrintSlot[], r: Rect): string[] {
  return slots
    .filter((s) => {
      const b = slotBounds(s);
      return b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h;
    })
    .map((s) => s.id);
}

/** Yeni yuva kimliği: mevcut "sN" kimliklerinin en büyüğünün bir fazlası (çakışmaz). */
export function nextSlotIds(slots: readonly Pick<PrintSlot, "id">[], count: number): string[] {
  let max = 0;
  for (const s of slots) {
    const m = /^s(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const used = new Set(slots.map((s) => s.id));
  const out: string[] = [];
  let n = max;
  while (out.length < count) {
    n++;
    const id = `s${n}`;
    if (!used.has(id)) out.push(id);
  }
  return out;
}

/** Seçili yuvaları kaydırır (mm; 0,01 mm'ye yuvarlı). */
export function moveSlots(slots: readonly PrintSlot[], ids: ReadonlySet<string>, dx: number, dy: number): PrintSlot[] {
  if (!ids.size || (dx === 0 && dy === 0)) return slots as PrintSlot[];
  return slots.map((s) => (ids.has(s.id) ? { ...s, cx: r2(s.cx + dx), cy: r2(s.cy + dy) } : s));
}

/** Seçili yuvaları çoğaltır (yeni kimliklerle, `offset` kadar kaydırılmış). Yeni kimlikleri de döner. */
export function duplicateSlots(slots: readonly PrintSlot[], ids: ReadonlySet<string>, offset: Pt): { slots: PrintSlot[]; added: string[] } {
  const src = slots.filter((s) => ids.has(s.id));
  const newIds = nextSlotIds(slots, src.length);
  const copies = src.map((s, i) => ({ ...s, id: newIds[i]!, cx: r2(s.cx + offset.x), cy: r2(s.cy + offset.y) }));
  return { slots: [...slots, ...copies], added: newIds };
}

/** Seçili yuvalara aynı alanları yazar (sayısal düzenleme; çoklu seçimde ortak değer). */
export function patchSlots(slots: readonly PrintSlot[], ids: ReadonlySet<string>, patch: Partial<Omit<PrintSlot, "id">>): PrintSlot[] {
  return slots.map((s) => {
    if (!ids.has(s.id)) return s;
    const next = { ...s, ...patch };
    // Daire: genişlik ve yükseklik aynı çaptır.
    if (next.shape === "circle") {
      const d = patch.h !== undefined && patch.w === undefined ? next.h : next.w;
      next.w = d;
      next.h = d;
    }
    return next;
  });
}

/** Çoklu seçimde bir alanın ortak değeri; farklıysa null. */
export function commonValue<T>(values: readonly T[]): T | null {
  if (!values.length) return null;
  const first = values[0]!;
  return values.every((v) => v === first) ? first : null;
}

/**
 * Tıkla-çiz: başlangıç ve bitiş noktasından yuva. Kısa sürüklemede (`minDragMm` altı) varsayılan ölçüyle tıklanan
 * noktaya ortalanır. Dairede kutunun büyük kenarı çaptır; `square` (Shift) ile elips/dikdörtgen kare olur.
 */
export function slotFromDrag(
  a: Pt,
  b: Pt,
  shape: SlotShape,
  defaults: { w: number; h: number },
  opts: { square?: boolean; minDragMm?: number } = {},
): Omit<PrintSlot, "id"> {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const base = { shape, rotation: 0, cornerRadius: 0 };
  if (Math.max(Math.abs(dx), Math.abs(dy)) < (opts.minDragMm ?? 1)) {
    const h = shape === "circle" ? defaults.w : defaults.h;
    return { ...base, cx: r2(a.x), cy: r2(a.y), w: r2(defaults.w), h: r2(h) };
  }
  let w = Math.abs(dx);
  let h = Math.abs(dy);
  if (shape === "circle" || opts.square) {
    const d = Math.max(w, h);
    w = d;
    h = d;
  }
  const cx = a.x + (Math.sign(dx) || 1) * (w / 2);
  const cy = a.y + (Math.sign(dy) || 1) * (h / 2);
  return { ...base, cx: r2(cx), cy: r2(cy), w: r2(w), h: r2(h) };
}

// ---------------------------------------------------------------- hizala / dağıt (yuvalar ve masadaki öğeler ortak)

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export interface BoxItem {
  id: string;
  /** Merkez (mm). */
  cx: number;
  cy: number;
  /** Sınır kutusu ölçüsü (mm). */
  w: number;
  h: number;
}

/**
 * Hizala: seçimin sınır kutusuna göre (Figma gibi). Dönen eşleme yalnızca yeri değişenlerin yeni merkezi.
 * Tek öğede hiçbir şey yapmaz (kağıda hizalama ayrı: `alignToRect`).
 */
export function alignBoxes(items: readonly BoxItem[], mode: AlignMode): Map<string, Pt> {
  const out = new Map<string, Pt>();
  if (items.length < 2) return out;
  const x0 = Math.min(...items.map((i) => i.cx - i.w / 2));
  const x1 = Math.max(...items.map((i) => i.cx + i.w / 2));
  const y0 = Math.min(...items.map((i) => i.cy - i.h / 2));
  const y1 = Math.max(...items.map((i) => i.cy + i.h / 2));
  return alignToRect(items, mode, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** Kutulara göre değil verilen dikdörtgene (ör. kağıt) hizalar. */
export function alignToRect(items: readonly BoxItem[], mode: AlignMode, r: Rect): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const i of items) {
    let { cx, cy } = i;
    if (mode === "left") cx = r.x + i.w / 2;
    else if (mode === "right") cx = r.x + r.w - i.w / 2;
    else if (mode === "hcenter") cx = r.x + r.w / 2;
    else if (mode === "top") cy = r.y + i.h / 2;
    else if (mode === "bottom") cy = r.y + r.h - i.h / 2;
    else cy = r.y + r.h / 2;
    cx = r2(cx);
    cy = r2(cy);
    if (cx !== i.cx || cy !== i.cy) out.set(i.id, { x: cx, y: cy });
  }
  return out;
}

/**
 * Dağıt: uçtakiler yerinde kalır, aradakiler eşit BOŞLUKLA dizilir (Figma "eşit aralık"). En az 3 öğe gerekir.
 */
export function distributeBoxes(items: readonly BoxItem[], axis: "x" | "y"): Map<string, Pt> {
  const out = new Map<string, Pt>();
  if (items.length < 3) return out;
  const size = (i: BoxItem) => (axis === "x" ? i.w : i.h);
  const pos = (i: BoxItem) => (axis === "x" ? i.cx : i.cy);
  const sorted = [...items].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const start = pos(first) - size(first) / 2;
  const end = pos(last) + size(last) / 2;
  const total = sorted.reduce((s, i) => s + size(i), 0);
  const gap = (end - start - total) / (sorted.length - 1);
  let cursor = start;
  for (const i of sorted) {
    const c = r2(cursor + size(i) / 2);
    cursor += size(i) + gap;
    if (i === first || i === last) continue;
    const next = axis === "x" ? { x: c, y: i.cy } : { x: i.cx, y: c };
    if (next.x !== i.cx || next.y !== i.cy) out.set(i.id, next);
  }
  return out;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Ok tuşu → itme (mm): 0,1 mm, Shift ile 1 mm. Ok tuşu değilse null. */
export function nudgeMm(key: string, shift: boolean): Pt | null {
  const a = ARROWS[key];
  if (!a) return null;
  const n = shift ? 1 : 0.1;
  return { x: a[0] * n, y: a[1] * n };
}
