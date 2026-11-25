import {
  type PrintGridSpec,
  type PrintSlot,
  type PrintSlotInput,
  PrintSlotSchema,
  type PrintTemplate,
  type PrintTemplateWarning,
  PRINTER_MARGIN_MM,
  printWarningMsg,
  slotsInReadingOrder,
} from "@tagpress/domain";
import { MARK_SAFE_MM, markOverlappingSlots } from "@tagpress/print";
import { fail } from "../../util/errors.ts";

/**
 * Baskı şablonu geometrisi (saf, mm): ızgara üreteci, yuva kimlikleri, doğrulama. Doğrulama UYARIDIR;
 * kayıt engellenmez (kullanıcı kararı).
 */

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Ölçüm toleransı (mm): kenara tam değen yuva taşmış sayılmaz. */
const TOL = 0.01;

// ---------------------------------------------------------------- ızgara

/** Izgara üreteci: kağıt + sütun × satır + ölçü + kenar/adım → okuma sırasında yuvalar ("s1"…). */
export function generateGrid(spec: PrintGridSpec): PrintSlot[] {
  const { paper, columns: cols, rows, shape } = spec;
  const w = shape === "circle" ? (spec.diameterMm ?? spec.wMm ?? spec.hMm) : (spec.wMm ?? spec.diameterMm);
  const h = shape === "circle" ? w : (spec.hMm ?? spec.diameterMm ?? spec.wMm);
  if (!w || !h) throw fail(shape === "circle" ? "grid-diameter-required" : "grid-size-required");

  const st = spec.stagger;
  const staggered = st.enabled && rows > 1;
  // Kaydırılan satırlar sağa taşar (dropLast değilse): blok genişliğine kaydırma eklenir.
  const extendsRight = staggered && !st.dropLast;
  const fixedOffset = st.offsetXMm;
  // Blok genişliği = (cols - 1 + f) · adım + w + sabit kaydırma (f: yarım adım varsayılanı için 0,5).
  const f = extendsRight && fixedOffset === undefined ? 0.5 : 0;
  const offFixed = extendsRight && fixedOffset !== undefined ? fixedOffset : 0;

  const axis = (n: number, size: number, paperLen: number, margin: number | undefined, pitch: number | undefined, gap: number | undefined, frac: number, fixed: number) => {
    const span = n - 1 + frac;
    if (pitch !== undefined) return pitch;
    if (gap !== undefined) return size + gap;
    if (span <= 0) return size;
    // Eşit dağıtım: kenar payı verildiyse iki yanda o pay; yoksa kenarlar dahil eşit boşluk.
    if (margin !== undefined && !spec.center) return (paperLen - 2 * margin - size - fixed) / span;
    const g = (paperLen - size - fixed - span * size) / (2 + span);
    return size + g;
  };
  const pitchX = axis(cols, w, paper.wMm, spec.marginLeftMm, spec.pitchXMm, spec.gapXMm, f, offFixed);
  const pitchY = axis(rows, h, paper.hMm, spec.marginTopMm, spec.pitchYMm, spec.gapYMm, 0, 0);
  if (!(pitchX > 0) || !(pitchY > 0)) throw fail("grid-no-fit");
  const offset = staggered ? (fixedOffset ?? pitchX / 2) : 0;

  const blockW = (cols - 1) * pitchX + w + (extendsRight ? offset : 0);
  const blockH = (rows - 1) * pitchY + h;
  const left = spec.marginLeftMm !== undefined && !spec.center ? spec.marginLeftMm : (paper.wMm - blockW) / 2;
  const top = spec.marginTopMm !== undefined && !spec.center ? spec.marginTopMm : (paper.hMm - blockH) / 2;

  const raw: Omit<PrintSlot, "id">[] = [];
  for (let r = 0; r < rows; r++) {
    const shifted = staggered && r % 2 === 1;
    const n = shifted && st.dropLast ? cols - 1 : cols;
    for (let c = 0; c < n; c++) {
      raw.push({
        shape,
        cx: r2(left + w / 2 + c * pitchX + (shifted ? offset : 0)),
        cy: r2(top + h / 2 + r * pitchY),
        w: r2(w),
        h: r2(h),
        rotation: 0,
        cornerRadius: shape === "rect" ? spec.cornerRadiusMm : 0,
      });
    }
  }
  return slotsInReadingOrder(raw).map((s, i) => ({ id: `s${i + 1}`, ...s }));
}

// ---------------------------------------------------------------- kimlikler

/** Girdi yuvaları: şemayla doldurulur, okuma sırasına dizilir, kimliği olmayana (ya da tekrar edene) yeni "sN" verilir. */
export function normalizeSlots(input: readonly PrintSlotInput[]): PrintSlot[] {
  const parsed = input.map((s) => {
    const { id, ...rest } = s;
    return { id: id ?? null, ...PrintSlotSchema.omit({ id: true }).parse(rest) };
  });
  const used = new Set<string>();
  for (const s of parsed) if (s.id) used.add(s.id);
  let n = 0;
  const fresh = () => {
    do n++;
    while (used.has(`s${n}`));
    used.add(`s${n}`);
    return `s${n}`;
  };
  // Önce okuma sırası; yeni kimlikler bu sırayla verilir.
  const seen = new Set<string>();
  return slotsInReadingOrder(parsed).map((s) => {
    let id = s.id;
    if (!id || seen.has(id)) id = fresh();
    seen.add(id);
    return { ...s, id };
  });
}

// ---------------------------------------------------------------- doğrulama

/** Yuva kutusu (döndürme dahil, eksenlere hizalı), mm. */
export function slotBounds(s: PrintSlot): { x0: number; y0: number; x1: number; y1: number } {
  const a = (s.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const si = Math.abs(Math.sin(a));
  let hw: number;
  let hh: number;
  if (s.shape === "rect") {
    hw = (s.w * c + s.h * si) / 2;
    hh = (s.w * si + s.h * c) / 2;
  } else {
    const rx = s.w / 2;
    const ry = s.h / 2;
    hw = Math.sqrt(rx * rx * c * c + ry * ry * si * si);
    hh = Math.sqrt(rx * rx * si * si + ry * ry * c * c);
  }
  return { x0: s.cx - hw, y0: s.cy - hh, x1: s.cx + hw, y1: s.cy + hh };
}

/** Nokta yuvanın içinde mi (kenardan `tol` içeride)? */
function inside(s: PrintSlot, x: number, y: number, tol = TOL): boolean {
  const a = (-s.rotation * Math.PI) / 180;
  const dx = x - s.cx;
  const dy = y - s.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const rx = s.w / 2 - tol;
  const ry = s.h / 2 - tol;
  if (rx <= 0 || ry <= 0) return false;
  if (s.shape === "rect") return Math.abs(lx) < rx && Math.abs(ly) < ry;
  return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) < 1;
}

function boundary(s: PrintSlot, n = 48): { x: number; y: number }[] {
  const a = (s.rotation * Math.PI) / 180;
  const pts: { x: number; y: number }[] = [];
  const push = (lx: number, ly: number) => pts.push({ x: s.cx + lx * Math.cos(a) - ly * Math.sin(a), y: s.cy + lx * Math.sin(a) + ly * Math.cos(a) });
  if (s.shape === "rect") {
    const k = Math.max(2, Math.round(n / 4));
    for (let i = 0; i <= k; i++) {
      const t = -0.5 + i / k;
      push(t * s.w, -s.h / 2);
      push(t * s.w, s.h / 2);
      push(-s.w / 2, t * s.h);
      push(s.w / 2, t * s.h);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      push((s.w / 2) * Math.cos(t), (s.h / 2) * Math.sin(t));
    }
  }
  return pts;
}

/** İki yuva üst üste biniyor mu (değmek sayılmaz)? Daire-daire kesin, diğerleri kenar örneklemesiyle. */
export function slotsOverlap(a: PrintSlot, b: PrintSlot): boolean {
  if (a.shape === "circle" && b.shape === "circle" && a.w === a.h && b.w === b.h) {
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.w / 2 + b.w / 2 - TOL;
  }
  if (inside(a, b.cx, b.cy) || inside(b, a.cx, a.cy)) return true;
  return boundary(a).some((p) => inside(b, p.x, p.y)) || boundary(b).some((p) => inside(a, p.x, p.y));
}

const list = (ids: string[]) => (ids.length > 6 ? `${ids.slice(0, 6).join(", ")} …` : ids.join(", "));

/** Şablon doğrulaması: uyarılar (engellemez). */
export function checkTemplate(t: Pick<PrintTemplate, "kind" | "paper" | "slots" | "stickerFlow" | "labelDiameterMm"> & { cut?: Pick<PrintTemplate["cut"], "registration" | "bleedMm"> }): PrintTemplateWarning[] {
  const out: PrintTemplateWarning[] = [];
  const slots = t.slots;
  if (!slots.length && !(t.kind === "sticker" && t.stickerFlow)) {
    out.push({ ...printWarningMsg(t.kind === "sticker" ? "no-slots-sticker" : "no-slots"), slotIds: [] });
  }
  const seen = new Map<string, number>();
  for (const s of slots) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  if (dup.length) out.push({ ...printWarningMsg("slot-duplicate-id", { slots: list(dup) }), slotIds: dup });

  const outside = slots.filter((s) => {
    const b = slotBounds(s);
    return b.x0 < -TOL || b.y0 < -TOL || b.x1 > t.paper.wMm + TOL || b.y1 > t.paper.hMm + TOL;
  });
  if (outside.length) {
    out.push({ ...printWarningMsg("slot-outside", { count: outside.length, slots: list(outside.map((s) => s.id)) }), slotIds: outside.map((s) => s.id) });
  }

  // Kutu ön elemesiyle çiftler (x'e göre sıralı tarama).
  const boxes = slots.map((s) => ({ s, b: slotBounds(s) })).sort((p, q) => p.b.x0 - q.b.x0);
  const hit = new Set<string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i]!;
      const q = boxes[j]!;
      if (q.b.x0 >= p.b.x1) break;
      if (q.b.y0 >= p.b.y1 || p.b.y0 >= q.b.y1) continue;
      if (slotsOverlap(p.s, q.s)) {
        hit.add(p.s.id);
        hit.add(q.s.id);
      }
    }
  }
  if (hit.size) {
    const ids = slots.map((s) => s.id).filter((id) => hit.has(id));
    out.push({ ...printWarningMsg("slot-overlap", { count: ids.length, slots: list(ids) }), slotIds: ids });
  }

  // Yazıcının basamadığı kenar (taşma payı dahil): yuva kağıt içinde ama kenarı eksik basılabilir.
  const bleed = t.cut?.bleedMm ?? 0;
  const edge = slots.filter((s) => {
    if (outside.includes(s)) return false;
    const b = slotBounds(s);
    const m = PRINTER_MARGIN_MM - TOL;
    return b.x0 - bleed < m || b.y0 - bleed < m || b.x1 + bleed > t.paper.wMm - m || b.y1 + bleed > t.paper.hMm - m;
  });
  if (edge.length) {
    out.push({
      ...printWarningMsg("slot-in-printer-margin", { count: edge.length, marginMm: PRINTER_MARGIN_MM, slots: list(edge.map((s) => s.id)) }),
      slotIds: edge.map((s) => s.id),
    });
  }

  if (t.labelDiameterMm && slots.length) {
    const small = slots.filter((s) => t.labelDiameterMm! > Math.min(s.w, s.h) + TOL);
    if (small.length) {
      out.push({
        ...printWarningMsg("label-larger-than-slot", { diameter: t.labelDiameterMm, count: small.length }),
        slotIds: small.map((s) => s.id),
      });
    }
  }
  if (t.cut?.registration.enabled && slots.length) {
    const near = markOverlappingSlots(t.paper, t.cut, slots);
    if (near.length) {
      out.push({
        ...printWarningMsg("mark-overlap", { count: near.length, safeMm: MARK_SAFE_MM, slots: list(near) }),
        slotIds: near,
      });
    }
  }
  return out;
}
