import { type PrintCut, type PrintSlot, type PrintTemplate, slotsInReadingOrder } from "@tagpress/domain";
import { cellLabelPosition, ROW_TOL_MM } from "@tagpress/print";

export { ptToMm } from "@tagpress/print";

/**
 * Kesim ve baskı işaretlerinin önizleme şekilleri — SAF (mm, kağıda göre). Sunucunun çıktısıyla aynı anlam:
 * Motorun `registrationMarks` çizimiyle (`packages/engine/src/print-vector.ts`) birebir aynı yerleşim:
 * - corners-l: dört köşede L (kollar `sizeMm`, kalınlık `thicknessMm`), kenardan `insetMm` içeride;
 * - corner-square: sol üstte dolu kare (`sizeMm`; yön işareti), diğer üç köşede L;
 * - crosshair: köşelerde artı + daire (kayıt hedefi); merkez köşeden `sizeMm / 2` içeride, daire yarıçapı `0,3 · sizeMm`.
 * Çakışma denetimi için kutular `@tagpress/print` `registrationBoxes` ile alınır.
 */
export type MarkShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number }
  | { kind: "circle"; cx: number; cy: number; r: number; width: number };

export function registrationMarks(paper: { wMm: number; hMm: number }, reg: PrintCut["registration"]): MarkShape[] {
  if (!reg.enabled) return [];
  const { insetMm: i, sizeMm: s, thicknessMm: t } = reg;
  const corners: Array<{ x: number; y: number; sx: 1 | -1; sy: 1 | -1 }> = [
    { x: i, y: i, sx: 1, sy: 1 },
    { x: paper.wMm - i, y: i, sx: -1, sy: 1 },
    { x: i, y: paper.hMm - i, sx: 1, sy: -1 },
    { x: paper.wMm - i, y: paper.hMm - i, sx: -1, sy: -1 },
  ];
  const out: MarkShape[] = [];
  for (const [k, c] of corners.entries()) {
    if (reg.style === "corner-square" && k === 0) {
      out.push({ kind: "rect", x: c.x, y: c.y, w: s, h: s });
    } else if (reg.style === "corners-l" || reg.style === "corner-square") {
      // Kollar köşeden kağıdın içine doğru; çizgi kalınlığı içeri taşar.
      out.push({ kind: "rect", x: c.sx > 0 ? c.x : c.x - s, y: c.sy > 0 ? c.y : c.y - t, w: s, h: t });
      out.push({ kind: "rect", x: c.sx > 0 ? c.x : c.x - t, y: c.sy > 0 ? c.y : c.y - s, w: t, h: s });
    } else {
      const mx = c.x + (c.sx * s) / 2;
      const my = c.y + (c.sy * s) / 2;
      out.push({ kind: "line", x1: mx - s / 2, y1: my, x2: mx + s / 2, y2: my, width: t });
      out.push({ kind: "line", x1: mx, y1: my - s / 2, x2: mx, y2: my + s / 2, width: t });
      out.push({ kind: "circle", cx: mx, cy: my, r: s * 0.3, width: t });
    }
  }
  return out;
}

/** Hücre etiketi önizlemesi: okuma sırasındaki ilk yuvanın yanında örnek sipariş adı (yoksa null). */
export function sampleCellLabel(t: Pick<PrintTemplate, "slots" | "cellLabel">): { xMm: number; yMm: number } | null {
  const ordered = slotsInReadingOrder(t.slots, ROW_TOL_MM);
  const first = ordered[0];
  if (!first) return null;
  const row = t.slots.filter((s: PrintSlot) => Math.abs(s.cy - first.cy) < ROW_TOL_MM);
  return cellLabelPosition(t as PrintTemplate, first, row);
}

/** Okuma sırası numaraları (1'den), kimlik → numara. */
export function readingNumbers(slots: readonly PrintSlot[]): Map<string, number> {
  return new Map(slotsInReadingOrder(slots, ROW_TOL_MM).map((s, i) => [s.id, i + 1]));
}
