import { slotsInReadingOrder, type PrintSlot, type PrintTemplate } from "@tagpress/domain";
import { labelAnchorIndex, labelPositionAt, ROW_TOL_MM } from "./slots.ts";
import type { PlanOrder, PlannedCellLabel, PlannedItem, PlannedPage, PrintRules } from "./types.ts";

/**
 * Etiket baskı sayfası planlayıcısı — SAF. Eklentideki `label-pages-plan.ts` ile aynı mantık; eşikler profilden.
 *
 * - Sayfa kapasitesi şablondaki yuva sayısıdır. Her sipariş için önce TAM sayfalar ayrılır (adet / kapasite). Kalan,
 *   sayfayı doldurmaya `labelRoundUpMaxExtra` kadar yakınsa adet kapasiteye yuvarlanır (tek tasarımlı tam sayfa).
 * - Kalanlar + fazlalık karışık sayfalara sırayla dizilir. Fazlalık [labelExtraMin, labelExtraMax] aralığında siparişin
 *   büyüklüğüne göre ölçeklenir (labelExtraScaleLow..High) ve açık yuvaya göre kırpılır.
 * - `separateSameDesign` açıkken aynı tasarım numaralı FARKLI siparişler aynı karışık sayfaya girmez.
 * - Yuvalar okuma sırasıyla dolar; etiket yuvanın merkezine konur.
 * - Adedi sıfır ya da negatif sipariş atlanır (eklenti bu durumda yine de fazlalık basardı; sıfır adet zaten geçersiz).
 */

/** Karışık sayfadaki bir hücre. */
export interface LabelCell {
  /** `orders` dizisindeki sıra; sipariş listesinde olmayan (bilinmeyen) öğe için -1. */
  orderIdx: number;
  jobId: string;
  variantId: string;
  /** Okuma sırasındaki yuva dizini; yuvasız (serbest) öğede -1. */
  slot: number;
  xMm?: number;
  yMm?: number;
  manual: boolean;
  extra: boolean;
}

/** Karışık sayfa taslağı. Yeniden planlamada korunan sayfalar tohum olarak (dolu yuvalarla) gelir. */
export interface MixPage {
  fromIndex: number | null;
  cells: LabelCell[];
  /** Boş yuva dizinleri (artan); `pos` bunlardan kaçının tüketildiğini söyler. */
  free: number[];
  pos: number;
  orderNos: string[];
  owners: Map<string, string>;
}

export interface LabelPack {
  full: { orderIdx: number; copies: number }[];
  mixed: MixPage[];
}

/** Boş (tohumsuz) karışık sayfa. */
export function emptyMixPage(capacity: number): MixPage {
  return { fromIndex: null, cells: [], free: Array.from({ length: capacity }, (_, i) => i), pos: 0, orderNos: [], owners: new Map() };
}

/** Bir siparişin profildeki kurallara göre tercih ettiği fazlalık (sayfa kapasitesi kırpmasından önce). */
export function preferredLabelExtra(quantity: number, rules: PrintRules): number {
  const minExtra = Number.isFinite(rules.labelExtraMin) ? rules.labelExtraMin : 0;
  const maxExtra = Number.isFinite(rules.labelExtraMax) ? Math.max(rules.labelExtraMax, minExtra) : minExtra;
  const t = Math.max(0, Math.min(1, (quantity - rules.labelExtraScaleLow) / Math.max(1, rules.labelExtraScaleHigh - rules.labelExtraScaleLow)));
  return Math.round(minExtra + t * (maxExtra - minExtra));
}

interface Desc {
  idx: number;
  order: PlanOrder;
  target: number;
  /** Planlanan hücrelerin kaçı gerçek adet; sıradaki hücre bunu aşarsa fazlalık işaretlenir. */
  real: number;
  fullPages: number;
  remainder: number;
  roundedUp: boolean;
}

/**
 * Çekirdek paketleme. `targets[i]`: i. sipariş için planlanacak adet (≤0 ise atlanır). `seeds`: önceden yerleşmiş
 * (korunan) karışık sayfalar; yeni hücreler önce bunların boş yuvalarına dolar.
 *
 * - `reals[i]`: planlanan hücrelerin kaçı gerçek adet (gerisi `extra`). Varsayılan: hedefin tamamı (ilk plan).
 * - `exact` (yeniden planlama): hedef fazlalığı ZATEN içerir. Fazlalık eklenmez, yukarı yuvarlanmaz; tam sayfa sayısı
 *   `min(floor(hedef / kapasite), exact.fullPages[i])` (ilk plandaki tam sayfa sayısını aşmaz), kalan karışık sayfalara.
 *   Hedef ilk planın toplamıysa ve hiçbir şey yerleşmemişse çıktı ilk planla aynıdır.
 */
export function packLabels(args: {
  orders: readonly PlanOrder[];
  targets: readonly number[];
  capacity: number;
  rules: PrintRules;
  seeds?: MixPage[];
  reals?: readonly number[];
  exact?: { fullPages: readonly number[] };
}): LabelPack {
  const { orders, targets, capacity, rules, exact } = args;
  if (!(capacity > 0)) throw new Error("Şablon sayfasının kapasitesi (yuva sayısı) 0.");

  const descs: Desc[] = [];
  orders.forEach((order, idx) => {
    const target = targets[idx] ?? 0;
    if (!(target > 0)) return;
    const real = Math.max(0, args.reals?.[idx] ?? target);
    let fullPages = Math.floor(target / capacity);
    if (exact) {
      fullPages = Math.min(fullPages, Math.max(0, exact.fullPages[idx] ?? 0));
      descs.push({ idx, order, target, real, fullPages, remainder: target - fullPages * capacity, roundedUp: false });
      return;
    }
    let remainder = target - fullPages * capacity;
    let roundedUp = false;
    // Yukarı yuvarlama: kalan sayfayı doldurmaya yeterince yakınsa sipariş tek tasarımlı tam sayfa olur.
    if (remainder > 0 && capacity - remainder <= rules.labelRoundUpMaxExtra) {
      fullPages += 1;
      remainder = 0;
      roundedUp = true;
    }
    descs.push({ idx, order, target, real, fullPages, remainder, roundedUp });
  });

  // 1) Tam sayfalar (karışımdan bağımsız).
  const full: LabelPack["full"] = [];
  for (const d of descs) if (d.fullPages > 0) full.push({ orderIdx: d.idx, copies: d.fullPages });

  // 2) Kalanlar + fazlalık, karışık sayfalara.
  const seeds = args.seeds ?? [];
  const mixed: MixPage[] = [...seeds];
  const queue: MixPage[] = seeds.filter((p) => p.pos < p.free.length);
  let current: MixPage | null = null;
  const isFull = (p: MixPage): boolean => p.pos >= p.free.length;
  const conflictOn = (page: MixPage | null, d: Desc): boolean =>
    rules.separateSameDesign && !!page && d.order.designKey != null && page.owners.has(d.order.designKey) && page.owners.get(d.order.designKey) !== d.order.orderNo;

  for (const d of descs) {
    if (d.roundedUp) continue;
    const { order } = d;
    // Kesin modda hedef fazlalığı zaten içerir: yeniden fazlalık eklenmez.
    const preferredExtra = exact ? 0 : preferredLabelExtra(d.target, rules);

    // Açık yuvaya göre fazlalığı kırp: 1-2 adet için ayrı sayfaya geçilmesin.
    let availableNow = capacity;
    if (current && !isFull(current) && !conflictOn(current, d)) availableNow = current.free.length - current.pos;
    let extra = Math.min(preferredExtra, capacity - d.remainder);
    if (d.remainder < availableNow) extra = Math.min(extra, availableNow - d.remainder);
    extra = Math.max(0, extra);

    let remaining = d.remainder + extra;
    let placed = 0;
    while (remaining > 0) {
      if (!current || isFull(current) || conflictOn(current, d)) {
        const next: MixPage = queue.shift() ?? emptyMixPage(capacity);
        if (!mixed.includes(next)) mixed.push(next);
        current = next;
        continue;
      }
      const slot = current.free[current.pos++]!;
      placed++;
      // Sipariş başına sıra: önce tam sayfalar, sonra karışık hücreler; `real`'i aşan hücre fazlalıktır
      // (ilk planda real = hedef, yani karışık sayfada `remainder`'ı aşanlar).
      current.cells.push({ orderIdx: d.idx, jobId: order.jobId, variantId: order.variantId, slot, manual: false, extra: d.fullPages * capacity + placed > d.real });
      if (!current.orderNos.includes(order.orderNo)) current.orderNos.push(order.orderNo);
      if (order.designKey != null) current.owners.set(order.designKey, order.orderNo);
      remaining--;
    }
  }
  return { full, mixed: mixed.filter((m) => m.cells.length > 0) };
}

/** Hücre etiketi metni (eklentideki component adı): "4849_36adet". */
export const labelText = (o: PlanOrder): string => `${o.orderNo}_${o.quantity}adet`;

/** Taslağı `PlannedPage` listesine çevirir (konumlar, fazlalık işareti, hücre etiketleri, ad tekrarı ayrımı). */
export function labelPagesFromPack(args: {
  pack: LabelPack;
  orders: readonly PlanOrder[];
  targets: readonly number[];
  template: PrintTemplate;
  slots: readonly PrintSlot[];
  reflow?: boolean;
  /** `packLabels`'a verilen `reals` (yoksa hedef). */
  reals?: readonly number[];
}): PlannedPage[] {
  const { pack, orders, targets, template, slots } = args;
  const reflow = args.reflow ?? false;
  const capacity = slots.length;
  const running = new Map<number, number>();
  const pages: PlannedPage[] = [];

  const labelFor = (orderIdx: number, slotIdx: number): PlannedCellLabel => {
    const o = orders[orderIdx]!;
    const anchor = slots[labelAnchorIndex(slots, slotIdx)]!;
    return { jobId: o.jobId, slotId: slots[slotIdx]!.id, ...labelPositionAt(template, anchor), text: labelText(o) };
  };

  for (const f of pack.full) {
    const o = orders[f.orderIdx]!;
    const before = running.get(f.orderIdx) ?? 0;
    const real = Math.max(0, args.reals?.[f.orderIdx] ?? targets[f.orderIdx] ?? 0);
    const items: PlannedItem[] = slots.map((s, k) => ({
      jobId: o.jobId,
      variantId: o.variantId,
      slotId: s.id,
      xMm: s.cx,
      yMm: s.cy,
      // Birden çok kopyada yalnızca ilk kopya işaretlenir (öğeler bütün kopyalar için ortaktır).
      extra: before + k + 1 > real,
    }));
    running.set(f.orderIdx, before + capacity * f.copies);
    // Tam sayfada etiket bir kez, ilk yuvada.
    const page: PlannedPage = { name: `${o.orderNo}_${f.copies}sayfa`, kind: "full", copies: f.copies, items, cellLabels: [labelFor(f.orderIdx, 0)] };
    if (reflow) page.fromIndex = null;
    pages.push(page);
  }

  for (const m of pack.mixed) {
    const sorted = [...m.cells].sort((a, b) => (a.slot < 0 ? Infinity : a.slot) - (b.slot < 0 ? Infinity : b.slot));
    const items: PlannedItem[] = sorted.map((c) => {
      const s = c.slot >= 0 ? slots[c.slot]! : null;
      const item: PlannedItem = { jobId: c.jobId, variantId: c.variantId, slotId: s ? s.id : null, xMm: s ? s.cx : (c.xMm ?? 0), yMm: s ? s.cy : (c.yMm ?? 0), extra: c.extra };
      if (c.manual) item.manual = true;
      return item;
    });
    // Her siparişin (sipariş numarasına göre) sayfadaki ilk hücresine etiket.
    const seen = new Set<string>();
    const cellLabels: PlannedCellLabel[] = [];
    for (const c of sorted) {
      if (c.orderIdx < 0 || c.slot < 0) continue;
      const o = orders[c.orderIdx]!;
      if (seen.has(o.orderNo)) continue;
      seen.add(o.orderNo);
      cellLabels.push(labelFor(c.orderIdx, c.slot));
    }
    const page: PlannedPage = { name: `${m.orderNos.join("_")}_1sayfa`, kind: "mixed", copies: 1, items, cellLabels };
    if (reflow) page.fromIndex = m.fromIndex;
    pages.push(page);
  }
  return dedupeNames(pages);
}

/** Aynı ad iki kez çıkarsa " (2)", " (3)" eklenir. */
export function dedupeNames<T extends { name: string }>(pages: T[]): T[] {
  const used = new Map<string, number>();
  for (const p of pages) {
    const n = (used.get(p.name) ?? 0) + 1;
    used.set(p.name, n);
    if (n > 1) p.name = `${p.name} (${n})`;
  }
  return pages;
}

export function planLabelPages(input: { orders: PlanOrder[]; template: PrintTemplate; rules: PrintRules }): PlannedPage[] {
  const { orders, template, rules } = input;
  const slots = slotsInReadingOrder(template.slots, ROW_TOL_MM);
  const targets = orders.map((o) => o.quantity);
  const pack = packLabels({ orders, targets, capacity: slots.length, rules });
  return labelPagesFromPack({ pack, orders, targets, template, slots });
}
