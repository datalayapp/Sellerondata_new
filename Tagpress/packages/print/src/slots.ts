import { slotsInReadingOrder, type PrintSlot, type PrintTemplate } from "@tagpress/domain";

/** Aynı satır sayılan merkez-y farkı (mm); domain `slotsInReadingOrder` varsayılanıyla aynı. */
export const ROW_TOL_MM = 2;

/** Boş yuvalar, okuma sırasıyla. */
export function freeSlots(template: PrintTemplate, occupiedSlotIds: ReadonlySet<string>): PrintSlot[] {
  return slotsInReadingOrder(template.slots, ROW_TOL_MM).filter((s) => !occupiedSlotIds.has(s.id));
}

/**
 * (x, y) noktasına merkezi en yakın BOŞ yuva (elle yerleştirmede yapışma). `maxDistMm` verilirse daha uzaktakiler
 * sayılmaz; verilmezse sınır yok. Boş yuva yoksa null.
 */
export function nearestFreeSlot(
  template: PrintTemplate,
  xMm: number,
  yMm: number,
  occupied: ReadonlySet<string>,
  maxDistMm?: number,
): PrintSlot | null {
  let best: PrintSlot | null = null;
  let bestDist = Infinity;
  for (const s of freeSlots(template, occupied)) {
    const d = Math.hypot(s.cx - xMm, s.cy - yMm);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  if (!best) return null;
  if (maxDistMm !== undefined && bestDist > maxDistMm) return null;
  return best;
}

/** Etiket yazısını `anchor` yuvasının sağ alt köşesine göre koyar (şablonun hücre etiketi ayarı). */
export function labelPositionAt(template: PrintTemplate, anchor: PrintSlot): { xMm: number; yMm: number } {
  return {
    xMm: anchor.cx + anchor.w / 2 + template.cellLabel.dxMm,
    yMm: anchor.cy + anchor.h / 2 + template.cellLabel.dyMm,
  };
}

/**
 * Hücre etiketinin (sipariş adı) konumu — yazının sol üst köşesi (mm). Eklentideki kural: yazı yuvanın sağ alt
 * köşesine göre durur (`cellLabel.dxMm/dyMm`); yuva satırın en sağındaysa yazı sayfadan taşar, bu yüzden bir
 * soldaki yuvaya göre konur. `rowSlots`: aynı satırdaki yuvalar (yuvanın kendisi de olabilir, sırası önemsiz).
 */
export function cellLabelPosition(template: PrintTemplate, slot: PrintSlot, rowSlots: PrintSlot[]): { xMm: number; yMm: number } {
  const row = [...rowSlots].sort((a, b) => a.cx - b.cx);
  const rightmost = !row.some((o) => o.id !== slot.id && o.cx > slot.cx);
  const i = row.findIndex((o) => o.id === slot.id);
  const anchor = rightmost && i > 0 ? row[i - 1]! : slot;
  return labelPositionAt(template, anchor);
}

/**
 * Eklentideki `labelAnchorSlot`: okuma sırasındaki dizide, satırın en sağındaki yuva (ve ilk değilse) için bir önceki.
 * Not: dizideki önceki yuva başka satırda olabilir (tek yuvalı son satır); eklentiyle birebir korunur.
 */
export function labelAnchorIndex(ordered: readonly PrintSlot[], index: number): number {
  const c = ordered[index];
  if (!c) return index;
  const rightmost = !ordered.some((o, i) => i !== index && Math.abs(o.cy - c.cy) <= ROW_TOL_MM && o.cx > c.cx);
  return rightmost && index > 0 ? index - 1 : index;
}
