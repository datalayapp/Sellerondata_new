import type { PrintCut, PrintSlot } from "@tagpress/domain";

/**
 * Kayıt işaretlerinin kutuları ve yuvalarla çakışma denetimi — SAF, mm. Sunucu uyarısı ve istemci taslağı aynı
 * hesabı kullanır. Ölçüler motorun `registrationMarks` çizimiyle (`packages/engine/src/print-vector.ts`) aynıdır:
 * her tarzda işaret, kağıt kenarından `insetMm` içeride başlayan `sizeMm` × `sizeMm` kareye sığar
 * (kayıt hedefinde çizgi kalınlığının yarısı kadar dışa taşar).
 */

export type MarkBox = { x0: number; y0: number; x1: number; y1: number };

/** Yuva çevresindeki güvenli alan (mm), taşma payına EK: etiket görseli + kesim kayması + sensör okuma payı. */
export const MARK_SAFE_MM = 2;
const EPS = 0.01;

type Reg = Pick<PrintCut["registration"], "enabled" | "style" | "insetMm" | "sizeMm" | "thicknessMm">;

/** Dört köşedeki işaret kutuları (kapalıysa boş). */
export function registrationBoxes(paper: { wMm: number; hMm: number }, reg: Reg): MarkBox[] {
  if (!reg.enabled) return [];
  const { insetMm: i, sizeMm: s } = reg;
  const grow = reg.style === "crosshair" ? reg.thicknessMm / 2 : 0;
  const lo = (v: number) => v - grow;
  const hi = (v: number) => v + grow;
  const xs: Array<[number, number]> = [
    [i, i + s],
    [paper.wMm - i - s, paper.wMm - i],
  ];
  const ys: Array<[number, number]> = [
    [i, i + s],
    [paper.hMm - i - s, paper.hMm - i],
  ];
  const out: MarkBox[] = [];
  for (const [y0, y1] of ys) for (const [x0, x1] of xs) out.push({ x0: lo(x0), y0: lo(y0), x1: hi(x1), y1: hi(y1) });
  return out;
}

type Pt = { x: number; y: number };

function slotPolygon(s: PrintSlot, pad: number): Pt[] {
  const a = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const w = s.w + 2 * pad;
  const h = s.h + 2 * pad;
  const local: Pt[] =
    s.shape === "rect"
      ? [
          { x: -w / 2, y: -h / 2 },
          { x: w / 2, y: -h / 2 },
          { x: w / 2, y: h / 2 },
          { x: -w / 2, y: h / 2 },
        ]
      : Array.from({ length: 48 }, (_, k) => {
          const t = (k / 48) * Math.PI * 2;
          return { x: (w / 2) * Math.cos(t), y: (h / 2) * Math.sin(t) };
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

/** İki dışbükey çokgen `EPS`'ten fazla iç içe mi (ayırıcı eksen)? */
function convexOverlap(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const ax = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
      const [a0, a1] = project(a, ax);
      const [b0, b1] = project(b, ax);
      if (a1 - EPS <= b0 || b1 - EPS <= a0) return false;
    }
  }
  return true;
}

const boxPoly = (b: MarkBox): Pt[] => [
  { x: b.x0, y: b.y0 },
  { x: b.x1, y: b.y0 },
  { x: b.x1, y: b.y1 },
  { x: b.x0, y: b.y1 },
];

/** Kayıt işaretine (taşma payı + güvenli alan kadar şişirilmiş) çakışan ya da çok yakın yuvaların kimlikleri. */
export function markOverlappingSlots(paper: { wMm: number; hMm: number }, cut: Pick<PrintCut, "registration" | "bleedMm">, slots: readonly PrintSlot[]): string[] {
  const boxes = registrationBoxes(paper, cut.registration).map(boxPoly);
  if (!boxes.length) return [];
  const pad = cut.bleedMm + MARK_SAFE_MM;
  return slots.filter((s) => {
    const poly = slotPolygon(s, pad);
    return boxes.some((b) => convexOverlap(poly, b));
  }).map((s) => s.id);
}

/**
 * Çakışmayı gideren `insetMm`: önce işareti kenara doğru çeker (mevcut değerden aşağı, en büyük çözen değer; 0,1 mm adım),
 * olmazsa içeri doğru en küçük çözen değer (işaretler kağıt içinde kalır). Zaten çakışma yoksa mevcut değer; hiçbir
 * değer çözmüyorsa null (yuvalar köşeye çok yakın: yuvayı kaydırmak gerekir).
 */
export function clearingInset(paper: { wMm: number; hMm: number }, cut: Pick<PrintCut, "registration" | "bleedMm">, slots: readonly PrintSlot[]): number | null {
  const reg = cut.registration;
  const clear = (v: number) => markOverlappingSlots(paper, { ...cut, registration: { ...reg, insetMm: v } }, slots).length === 0;
  if (clear(reg.insetMm)) return reg.insetMm;
  const max = Math.floor((Math.min(paper.wMm, paper.hMm) / 2 - reg.sizeMm) * 10) / 10;
  const cur = Math.round(reg.insetMm * 10);
  for (let k = cur - 1; k >= 0; k--) if (clear(k / 10)) return k / 10;
  for (let k = cur + 1; k <= Math.round(max * 10); k++) if (clear(k / 10)) return k / 10;
  return null;
}
