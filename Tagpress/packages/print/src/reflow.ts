import { slotsInReadingOrder, type PrintTemplate } from "@tagpress/domain";
import { dedupeNames, emptyMixPage, labelPagesFromPack, packLabels, planLabelPages, type LabelCell, type MixPage } from "./label.ts";
import { planStickerCore, stickerGeometry } from "./sticker.ts";
import { ROW_TOL_MM } from "./slots.ts";
import type { PlanOrder, PlanStickerOrder, PlannedItem, PlannedPage, PrintRules } from "./types.ts";

export interface ReflowPageInput {
  locked: boolean;
  /** Bu sayfadan kaç baskı (varsayılan 1). Yerleşmiş sayılan adet = öğe × kopya (raftaki `placed` ile aynı sayım). */
  copies?: number;
  /**
   * false: sayfa korunsa da boş yuvalarına yeni hücre konmaz (ör. sayfanın şablonu planın şablonundan farklı).
   * Birden çok kopyalı sayfa da doldurulmaz (eklenen her hücre kopya sayısı kadar basılırdı).
   */
  fill?: boolean;
  items: (PlannedItem & { manual: boolean })[];
}

const keyOf = (jobId: string, variantId: string): string => `${jobId}\u0000${variantId}`;

/** Her sipariş için planın toplam baskısı (öğe × kopya) ve tam sayfa (tek siparişli) baskı sayısı. */
function planTotals(pages: readonly PlannedPage[], idxByKey: Map<string, number>, n: number): { total: number[]; fullSheets: number[] } {
  const total = new Array<number>(n).fill(0);
  const fullSheets = new Array<number>(n).fill(0);
  for (const p of pages) {
    for (const it of p.items) {
      const i = idxByKey.get(keyOf(it.jobId, it.variantId));
      if (i !== undefined) total[i]! += p.copies;
    }
    const first = p.items[0];
    const fi = p.kind === "full" && first ? idxByKey.get(keyOf(first.jobId, first.variantId)) : undefined;
    if (fi !== undefined) fullSheets[fi]! += p.copies;
  }
  return { total, fullSheets };
}

/**
 * Yeniden planlama: kilitli sayfalara ve elle konmuş (`manual`) öğelere dokunmaz, kalanı yeniden planlar.
 *
 * Kural (fazlalık bir kez sayılır):
 * - Siparişin TOPLAM ihtiyacı = aynı siparişlerin ilk planındaki (sıfırdan plan, `profile.printing` kuralları) toplam
 *   baskısı: adet + o planın verdiği fazlalık (kapasiteye kırpma ve sayfayı tamamlama/yukarı yuvarlama dahil).
 * - Yerleşmiş = kilitli sayfalardaki bütün öğeler + kilitsiz sayfalardaki elle öğeler (sticker'da elle öğeli sayfanın
 *   tamamı); öğe × sayfa kopyası.
 * - Kalan = toplam ihtiyaç − yerleşmiş (≤0 ise sipariş atlanır). Kalana YENİ fazlalık eklenmez.
 * - `extra` işareti: siparişin elle/kilitli öğelerinden fazlalık olmayanlar sayılır; yeni öğelerden
 *   adet − (yerleşmiş gerçek) kadarı gerçek, gerisi fazlalıktır. Böylece sipariş başına fazlalık olmayan öğe = adet.
 *
 * Etiket: kalan "kesin" kipte paketlenir (fazlalık yok, yukarı yuvarlama yok; tam sayfa sayısı ilk plandakini aşmaz):
 * yuvarlama ilk planın toplamında zaten var, yeniden uygulanırsa aynı fazlalık ikinci kez basılır. Elle yerleşim yoksa
 * çıktı ilk planla birebir aynıdır.
 * Sticker: hiç yerleşmemiş sipariş ilk plandaki gibi; yerleşmiş olanın kalanı satıra yuvarlanır (satır yarım kalmaz,
 * eklentideki gibi), karışık sayfa boşluğu yine doldurulur; sayfa tamamlama ancak siparişin toplam fazlalığı
 * `stickerExtraMax`'ı aşmıyorsa yapılır.
 *
 * Sayfalar:
 * - Kilitsiz sayfalardaki elle olmayan öğeler atılır. Elle öğesi olan kilitsiz sayfa korunur: öğeler yerinde kalır,
 *   boş yuvalarına yeni hücreler dolar (etiket şablonu; `fill: false` ya da birden çok kopyalı sayfa doldurulmaz).
 *   Sticker şablonunda elle öğesi olan sayfa olduğu gibi korunur (akış serbest konumlu olduğundan üstüne ekleme yapılmaz).
 * - Çıktı YALNIZCA kilitsiz kümenin yeni hâlidir (kilitli sayfalar çıktıda yoktur). Korunan sayfaların `fromIndex`'i
 *   giriş dizisindeki dizindir, yenilerinde null; kalan hücre etiketleri baştan hesaplanır.
 */
export function reflowPages(input: { pages: ReflowPageInput[]; orders: PlanOrder[]; template: PrintTemplate; rules: PrintRules }): PlannedPage[] {
  const { pages, orders, template, rules } = input;
  const idxByKey = new Map(orders.map((o, i) => [keyOf(o.jobId, o.variantId), i]));
  const copiesOf = (p: ReflowPageInput): number => Math.max(1, Math.round(p.copies ?? 1));

  const placed = new Array<number>(orders.length).fill(0);
  const placedReal = new Array<number>(orders.length).fill(0);
  pages.forEach((p) => {
    // Sticker şablonunda elle öğesi olan sayfa bütünüyle korunur; hepsi yerleşmiş sayılır.
    const keepsPage = template.kind === "sticker" && !p.locked && p.items.some((it) => it.manual);
    const copies = copiesOf(p);
    for (const it of p.items) {
      if (!(p.locked || it.manual || keepsPage)) continue;
      const i = idxByKey.get(keyOf(it.jobId, it.variantId));
      if (i === undefined) continue;
      placed[i]! += copies;
      if (!it.extra) placedReal[i]! += copies;
    }
  });
  const reals = orders.map((o, i) => Math.max(0, o.quantity - placedReal[i]!));
  const keptIdx = pages.map((p, i) => ({ p, i })).filter(({ p }) => !p.locked && p.items.some((it) => it.manual));

  if (template.kind === "sticker") {
    const geo = stickerGeometry(template, rules);
    const kept: PlannedPage[] = keptIdx.map(({ p, i }) => {
      const nos: string[] = [];
      for (const it of p.items) {
        const o = orders[idxByKey.get(keyOf(it.jobId, it.variantId)) ?? -1];
        if (o && !nos.includes(o.orderNo)) nos.push(o.orderNo);
      }
      return {
        name: `${nos.join("_") || "sayfa"}_1sayfa`,
        kind: "mixed",
        copies: copiesOf(p),
        items: p.items.map((it) => ({ jobId: it.jobId, variantId: it.variantId, slotId: it.slotId, xMm: it.xMm, yMm: it.yMm, extra: it.extra, ...(it.manual ? { manual: true } : {}) })),
        cellLabels: [],
        fromIndex: i,
      };
    });
    const stickerOrders = orders as PlanStickerOrder[];
    const leftover = orders.map((_, i) => placed[i]! > 0);
    let targets = orders.map((o) => o.quantity);
    if (leftover.some(Boolean)) {
      const { total } = planTotals(planStickerCore(stickerOrders, targets, geo), idxByKey, orders.length);
      targets = orders.map((o, i) => (leftover[i] ? Math.max(0, total[i]! - placed[i]!) : o.quantity));
    }
    const budgets = orders.map((o, i) => Math.max(0, o.quantity + geo.maxExtra - placed[i]!));
    const fresh = planStickerCore(stickerOrders, targets, geo, { reals, leftover, budgets }).map((pg) => ({ ...pg, fromIndex: null as number | null }));
    return dedupeNames([...kept, ...fresh]);
  }

  const slots = slotsInReadingOrder(template.slots, ROW_TOL_MM);
  const slotIdxById = new Map(slots.map((s, i) => [s.id, i]));
  // İlk plan (aynı siparişler, sıfırdan): toplam ihtiyaç ve tam sayfa sayısı buradan.
  const first = planTotals(planLabelPages({ orders, template, rules }), idxByKey, orders.length);
  const targets = orders.map((_, i) => Math.max(0, first.total[i]! - placed[i]!));

  const seeds: MixPage[] = keptIdx.map(({ p, i }) => {
    const seed = emptyMixPage(slots.length);
    seed.fromIndex = i;
    const occupied = new Set<number>();
    for (const it of p.items) {
      if (!it.manual) continue;
      const oi = idxByKey.get(keyOf(it.jobId, it.variantId)) ?? -1;
      const slot = it.slotId !== null ? (slotIdxById.get(it.slotId) ?? -1) : -1;
      if (slot >= 0) occupied.add(slot);
      const cell: LabelCell = { orderIdx: oi, jobId: it.jobId, variantId: it.variantId, slot, manual: true, extra: it.extra };
      if (slot < 0) {
        cell.xMm = it.xMm;
        cell.yMm = it.yMm;
      }
      seed.cells.push(cell);
      const o = orders[oi];
      if (o) {
        if (!seed.orderNos.includes(o.orderNo)) seed.orderNos.push(o.orderNo);
        if (o.designKey != null) seed.owners.set(o.designKey, o.orderNo);
      }
    }
    const fillable = p.fill !== false && copiesOf(p) === 1;
    seed.free = fillable ? seed.free.filter((s) => !occupied.has(s)) : [];
    return seed;
  });
  const pack = packLabels({ orders, targets, capacity: slots.length, rules, seeds, reals, exact: { fullPages: first.fullSheets } });
  const out = labelPagesFromPack({ pack, orders, targets, template, slots, reflow: true, reals });
  // Korunan sayfanın kopya sayısı değişmez.
  for (const p of out) if (p.fromIndex != null) p.copies = copiesOf(pages[p.fromIndex]!);
  return out;
}
