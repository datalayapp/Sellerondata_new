import {
  type PrintItem,
  type PrintItemSize,
  type PrintPageFull,
  type PrintPatchOp,
  type PrintSessionDetail,
  type PrintSlot,
  type PrintTemplate,
  slotsInReadingOrder,
} from "@tagpress/domain";
import { cellLabelPosition, labelText, nearestFreeSlot, ROW_TOL_MM } from "@tagpress/print";
import { i18n } from "../../../i18n/index.ts";
import type { Pt, Rect } from "../../../tezgah/tuval/canvas-math.ts";
import { type AlignMode, alignBoxes, alignToRect, type BoxItem, distributeBoxes, hitSlot, pointInSlot, r2 } from "./slot-geometry.ts";

/**
 * Baskı masasının oturum modeli — SAF. Yerel düzenlemeler oturumun yeni bir kopyasını üretir (değişmez veri);
 * sunucuya giden toplu yama, son onaylanan durumla yeni durum arasındaki farktan (`diffSession`) çıkar. Böylece
 * geri al / ileri al da aynı yoldan gider. Birim mm, konum sayfanın sol üstüne göre öğenin MERKEZİ.
 */

export type Session = PrintSessionDetail;
export type Page = PrintPageFull;
export type Templates = ReadonlyMap<string, PrintTemplate>;
/** Sticker ölçüleri: varyasyon kimliği → mürekkep kutusu (mm) ve önizleme görselinin kutusu (sunucudan). */
export type ItemSizes = ReadonlyMap<string, PrintItemSize>;
const NO_SIZES: ItemSizes = new Map();

/** Sticker şablonunda yuva yokken ve sticker ölçüsü bilinmezken tuvaldeki yer tutucu çap (mm; yalnızca gösterim). */
export const UNKNOWN_ITEM_MM = 40;
/** Sayfalar arası boşluk ve sayfa başlığı payı (masa, mm). */
export const PAGE_GAP_MM = 24;
export const PAGE_HEADER_MM = 12;

let seq = 0;
/** İstemci kimliği (yamada `id` olarak gider; sunucu kabul eder). */
export function newId(prefix: "i" | "p"): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function sortedPages(s: Session): Page[] {
  return [...s.pages].sort((a, b) => a.index - b.index);
}

export function slotOf(t: PrintTemplate | undefined, slotId: string | null): PrintSlot | undefined {
  return slotId && t ? t.slots.find((s) => s.id === slotId) : undefined;
}

/** Sunucunun ölçüsü: sticker sayfasında (yuvasız) mürekkep kutusu; etiket sayfasında yalnız kendi kesimi olan etiket. */
function measuredSize(variantId: string, slotId: string | null, t: PrintTemplate | undefined, sizes: ItemSizes): PrintItemSize | undefined {
  const s = sizes.get(variantId);
  if (!s || !t) return undefined;
  if (t.kind === "label") return s.kind === "label" ? s : undefined;
  return slotOf(t, slotId) ? undefined : s;
}

/**
 * Öğenin tuvaldeki ölçüsü (mm), × öğe ölçeği. Etiket: şablonun kendi kesimi varsa sunucunun verdiği kesim ölçüsü
 * (`sizes`; baskıda da bu ölçüde basılır), yoksa etiket çapı (şablonda yoksa yuva). Sticker (yuvasız akış): sunucunun
 * verdiği mürekkep kutusu (`sizes`); bilinmiyorsa yer tutucu.
 */
export function itemSize(item: Pick<PrintItem, "slotId" | "scale"> & { variantId?: string }, t: PrintTemplate | undefined, sizes: ItemSizes = NO_SIZES): { w: number; h: number } {
  const slot = slotOf(t, item.slotId) ?? t?.slots[0];
  const sticker = item.variantId ? measuredSize(item.variantId, item.slotId, t, sizes) : undefined;
  const w = sticker?.wMm ?? t?.labelDiameterMm ?? slot?.w ?? UNKNOWN_ITEM_MM;
  const h = sticker?.hMm ?? t?.labelDiameterMm ?? slot?.h ?? UNKNOWN_ITEM_MM;
  return { w: w * item.scale, h: h * item.scale };
}

/**
 * Önizleme görselinin öğe merkezine göre kutusu (mm): sticker'da tasarım karesi (mürekkep merkezine göre); kendi kesimi
 * olan etikette tasarım karesi (kare görsel kesim kutusuna basıklaşmaz); diğer etikette öğe kutusu.
 */
export function artBox(item: Pick<PrintItem, "slotId" | "scale" | "variantId">, t: PrintTemplate | undefined, sizes: ItemSizes = NO_SIZES): { x: number; y: number; w: number; h: number } {
  const art = measuredSize(item.variantId, item.slotId, t, sizes)?.art;
  if (art) return { x: art.xMm * item.scale, y: art.yMm * item.scale, w: art.wMm * item.scale, h: art.hMm * item.scale };
  const { w, h } = itemSize(item, t, sizes);
  return { x: -w / 2, y: -h / 2, w, h };
}

export function itemBox(item: PrintItem, t: PrintTemplate | undefined, sizes: ItemSizes = NO_SIZES): BoxItem {
  const { w, h } = itemSize(item, t, sizes);
  return { id: item.id, cx: item.xMm, cy: item.yMm, w, h };
}

/** Sayfadaki en üstteki (z, sonra dizi sırası) isabet eden öğe; daire olarak sınanır. */
export function hitItem(page: Page, t: PrintTemplate | undefined, p: Pt, sizes: ItemSizes = NO_SIZES): PrintItem | null {
  let best: PrintItem | null = null;
  for (const it of page.items) {
    const { w, h } = itemSize(it, t, sizes);
    const dx = (p.x - it.xMm) / (w / 2);
    const dy = (p.y - it.yMm) / (h / 2);
    if (dx * dx + dy * dy <= 1 && (best === null || it.z >= best.z)) best = it;
  }
  return best;
}

/** Masadaki kutuyla (masa mm) kesişen öğeler — sınır kutusuna göre, Figma'daki gibi değen seçilir. */
export function itemsInRect(s: Session, layout: ReadonlyMap<string, Rect>, templates: Templates, r: Rect, sizes: ItemSizes = NO_SIZES): string[] {
  const out: string[] = [];
  for (const p of s.pages) {
    const at = layout.get(p.id);
    if (!at) continue;
    const t = templates.get(p.templateId);
    for (const it of p.items) {
      const { w, h } = itemSize(it, t, sizes);
      const x0 = at.x + it.xMm - w / 2;
      const y0 = at.y + it.yMm - h / 2;
      if (x0 < r.x + r.w && r.x < x0 + w && y0 < r.y + r.h && r.y < y0 + h) out.push(it.id);
    }
  }
  return out;
}

export function occupied(page: Page, exceptIds: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const it of page.items) if (it.slotId && !exceptIds.has(it.id)) out.add(it.slotId);
  return out;
}

/**
 * Yuva içinde ince ayar: itilen / hizalanan öğenin merkezi kendi yuvasının içinde kaldıkça öğe yuvasında kalır (konumu
 * yuva merkezine göre ofsetli; sunucu `moveItem` aynı yuvada konumu korur). Merkezi yuvadan çıkarsa serbest konuma
 * geçer. Elle değişen öğe "elle konmuş" olur; yeniden planlama dokunmaz.
 */
function settle(it: PrintItem, t: PrintTemplate | undefined): PrintItem {
  if (!it.slotId) return it;
  const s = slotOf(t, it.slotId);
  if (!s || !pointInSlot(s, { x: it.xMm, y: it.yMm })) return { ...it, slotId: null };
  return it;
}

/** Seçili öğeleri yuvalarından çıkar (konum aynı kalır, serbest öğe olur). */
export function releaseFromSlot(s: Session, ids: ReadonlySet<string>): Session {
  return mapPages(s, (p) =>
    p.items.some((i) => ids.has(i.id) && i.slotId) ? { ...p, items: p.items.map((i) => (ids.has(i.id) && i.slotId ? { ...i, slotId: null, manual: true } : i)) } : p,
  );
}

/** Yuvadaki öğeleri yuvalarının tam merkezine al (ince ayarı sıfırla). */
export function centerInSlot(s: Session, ids: ReadonlySet<string>, templates: Templates): Session {
  return mapPages(s, (p) => {
    const t = templates.get(p.templateId);
    let changed = false;
    const items = p.items.map((i) => {
      const sl = ids.has(i.id) ? slotOf(t, i.slotId) : undefined;
      if (!sl || (sl.cx === i.xMm && sl.cy === i.yMm)) return i;
      changed = true;
      return { ...i, xMm: sl.cx, yMm: sl.cy, manual: true };
    });
    return changed ? { ...p, items } : p;
  });
}

/** Yuvasında ofsetli (merkezde olmayan) öğe mi. */
export function isOffset(it: PrintItem, t: PrintTemplate | undefined): boolean {
  const s = slotOf(t, it.slotId);
  return !!s && (Math.abs(s.cx - it.xMm) > 1e-6 || Math.abs(s.cy - it.yMm) > 1e-6);
}

function mapPages(s: Session, fn: (p: Page) => Page): Session {
  let changed = false;
  const pages = s.pages.map((p) => {
    const n = fn(p);
    if (n !== p) changed = true;
    return n;
  });
  return changed ? { ...s, pages } : s;
}

export function findItem(s: Session, id: string): { page: Page; item: PrintItem } | null {
  for (const page of s.pages) {
    const item = page.items.find((i) => i.id === id);
    if (item) return { page, item };
  }
  return null;
}

/** İş başına sayfalara konmuş öğe sayısı (kopyalar dahil: sayfa `copies` kez basılır). */
export function placedByJob(s: Session | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!s) return out;
  for (const p of s.pages) for (const it of p.items) out.set(it.jobId, (out.get(it.jobId) ?? 0) + p.copies);
  return out;
}

// ---------------------------------------------------------------- raftan yerleştirme

export interface ShelfDrop {
  pageId: string;
  /** Sayfaya göre bırakma noktası (mm). */
  point: Pt;
  jobId: string;
  variantId: string;
  /** Kaç tane konacak (Shift = kalan adet; normalde 1). */
  count: number;
  /** Alt: yuvaya yapışmadan serbest konum (tek öğe). */
  free: boolean;
  /** Fazlalık işareti için: siparişin adedi ve şimdiye kadar konmuş sayı. */
  quantity: number;
  placed: number;
}

/**
 * Raftan bırakma: en yakın boş yuvadan başlayarak (Shift ile) okuma sırasıyla sonraki boş yuvalara dizer;
 * yuvalar biterse kalan sayı `short`ta döner. Alt ile tek öğe serbest konuma.
 */
export function placeFromShelf(s: Session, t: PrintTemplate, d: ShelfDrop, makeId: () => string = () => newId("i")): { session: Session; added: string[]; short: number } {
  const page = s.pages.find((p) => p.id === d.pageId);
  if (!page || d.count <= 0) return { session: s, added: [], short: Math.max(0, d.count) };
  const topZ = page.items.reduce((m, i) => Math.max(m, i.z), 0);
  const mk = (k: number, slot: PrintSlot | null, at: Pt): PrintItem => ({
    id: makeId(),
    pageId: page.id,
    jobId: d.jobId,
    variantId: d.variantId,
    slotId: slot ? slot.id : null,
    xMm: r2(slot ? slot.cx : at.x),
    yMm: r2(slot ? slot.cy : at.y),
    rotation: 0,
    scale: 1,
    extra: d.placed + k >= d.quantity,
    manual: true,
    z: topZ + 1,
  });
  // Alt ya da yuvasız (sticker akışı) sayfa: tek öğe bırakılan noktaya.
  if (d.free || !t.slots.length) {
    const it = mk(0, null, d.point);
    return { session: mapPages(s, (p) => (p.id === page.id ? { ...p, items: [...p.items, it] } : p)), added: [it.id], short: d.count - 1 };
  }
  const occ = occupied(page);
  const start = nearestFreeSlot(t, d.point.x, d.point.y, occ);
  if (!start) return { session: s, added: [], short: d.count };
  const ordered = slotsInReadingOrder(t.slots, ROW_TOL_MM).filter((x) => !occ.has(x.id));
  const at = ordered.findIndex((x) => x.id === start.id);
  const seqSlots = [...ordered.slice(at), ...ordered.slice(0, at)].slice(0, d.count);
  const items = seqSlots.map((slot, k) => mk(k, slot, d.point));
  return {
    session: mapPages(s, (p) => (p.id === page.id ? { ...p, items: [...p.items, ...items] } : p)),
    added: items.map((i) => i.id),
    short: d.count - items.length,
  };
}

// ---------------------------------------------------------------- taşıma

export interface ItemTarget {
  id: string;
  pageId: string;
  /** Hedef sayfaya göre merkez (mm). */
  x: number;
  y: number;
}

/**
 * Sürükleyip bırakma. Tek öğe: bırakılan nokta bir yuvanın içindeyse o yuvaya (doluysa iki öğe yer değiştirir),
 * değilse yakındaki (yuva çapı kadar) boş yuvaya yapışır, yoksa serbest kalır. Çok öğe: her biri en yakın boş
 * yuvaya (taşınanların eski yuvaları boş sayılır), bulamazsa serbest. `free` (Alt) yapışmayı kapatır.
 * Taşınan öğe "elle konmuş" olur (yeniden planlama dokunmaz).
 */
export function dropItems(s: Session, targets: readonly ItemTarget[], templates: Templates, free: boolean): Session {
  if (!targets.length) return s;
  const moving = new Set(targets.map((t) => t.id));
  const origin = new Map<string, { page: Page; item: PrintItem }>();
  for (const t of targets) {
    const f = findItem(s, t.id);
    if (f) origin.set(t.id, f);
  }
  // Önce taşınanları yerlerinden çıkar, sonra sırayla yerleştir.
  const placed = new Map<string, PrintItem>();
  const swaps = new Map<string, PrintItem>();
  const taken = new Map<string, Set<string>>(); // sayfa → bu bırakmada dolan yuvalar
  const occOf = (pageId: string) => {
    const page = s.pages.find((p) => p.id === pageId);
    const base = page ? occupied(page, moving) : new Set<string>();
    for (const x of taken.get(pageId) ?? []) base.add(x);
    return base;
  };
  for (const tg of targets) {
    const o = origin.get(tg.id);
    const t = templates.get(s.pages.find((p) => p.id === tg.pageId)?.templateId ?? "");
    if (!o) continue;
    const base: PrintItem = { ...o.item, pageId: tg.pageId, xMm: r2(tg.x), yMm: r2(tg.y), slotId: null, manual: true };
    if (free || !t) {
      placed.set(tg.id, base);
      continue;
    }
    const occ = occOf(tg.pageId);
    const hit = hitSlot(t.slots, { x: tg.x, y: tg.y });
    let slot: PrintSlot | null = null;
    if (hit && targets.length === 1) {
      // Dolu yuvaya bırakma: oradaki öğe taşınanın eski yerine geçer.
      const page = s.pages.find((p) => p.id === tg.pageId)!;
      const other = page.items.find((i) => i.slotId === hit.id && i.id !== tg.id);
      if (other) {
        // Yerinden edilen öğe taşınanın eski yuvasının MERKEZİNE (taşınanın ince ayarı ona geçmez); yuvasızsa eski konuma.
        const old = slotOf(templates.get(o.page.templateId), o.item.slotId);
        swaps.set(other.id, { ...other, pageId: o.item.pageId, slotId: old ? old.id : null, xMm: old ? old.cx : o.item.xMm, yMm: old ? old.cy : o.item.yMm, manual: true });
      }
      slot = hit;
    } else if (hit && !occ.has(hit.id)) slot = hit;
    else {
      const reach = Math.max(...t.slots.map((x) => Math.max(x.w, x.h)), 0);
      slot = nearestFreeSlot(t, tg.x, tg.y, occ, reach || undefined);
    }
    if (slot) {
      let set = taken.get(tg.pageId);
      if (!set) taken.set(tg.pageId, (set = new Set()));
      set.add(slot.id);
      placed.set(tg.id, { ...base, slotId: slot.id, xMm: slot.cx, yMm: slot.cy });
    } else placed.set(tg.id, base);
  }
  const all = new Map([...swaps, ...placed]);
  const pages = s.pages.map((p) => {
    const keep = p.items.filter((i) => !all.has(i.id));
    const add = [...all.values()].filter((i) => i.pageId === p.id);
    return keep.length === p.items.length && !add.length ? p : { ...p, items: [...keep, ...add] };
  });
  return { ...s, pages };
}

/** Ok tuşuyla it: konum değişir; merkezi yuvasında kaldıkça öğe yuvasında kalır (ince ayar, `settle`). */
export function nudgeItems(s: Session, ids: ReadonlySet<string>, dx: number, dy: number, templates: Templates): Session {
  if (!ids.size) return s;
  return mapPages(s, (p) => {
    if (!p.items.some((i) => ids.has(i.id))) return p;
    const t = templates.get(p.templateId);
    return { ...p, items: p.items.map((i) => (ids.has(i.id) ? settle({ ...i, xMm: r2(i.xMm + dx), yMm: r2(i.yMm + dy), manual: true }, t) : i)) };
  });
}

export function removeItems(s: Session, ids: ReadonlySet<string>): Session {
  if (!ids.size) return s;
  return mapPages(s, (p) => (p.items.some((i) => ids.has(i.id)) ? { ...p, items: p.items.filter((i) => !ids.has(i.id)) } : p));
}

/** Çoğalt: her kopya aynı sayfada en yakın boş yuvaya; yoksa 3 mm kaydırılmış serbest konuma. */
export function duplicateItems(s: Session, ids: ReadonlySet<string>, templates: Templates, makeId: () => string = () => newId("i")): { session: Session; added: string[] } {
  const added: string[] = [];
  const next = mapPages(s, (p) => {
    const src = p.items.filter((i) => ids.has(i.id));
    if (!src.length) return p;
    const t = templates.get(p.templateId);
    const occ = occupied(p);
    const topZ = p.items.reduce((m, i) => Math.max(m, i.z), 0);
    const copies = src.map((i) => {
      const slot = t ? nearestFreeSlot(t, i.xMm, i.yMm, occ) : null;
      if (slot) occ.add(slot.id);
      const id = makeId();
      added.push(id);
      return { ...i, id, slotId: slot?.id ?? null, xMm: slot ? slot.cx : r2(i.xMm + 3), yMm: slot ? slot.cy : r2(i.yMm + 3), manual: true, z: topZ + 1 };
    });
    return { ...p, items: [...p.items, ...copies] };
  });
  return { session: next, added };
}

/**
 * Hizala / dağıt: sayfa sayfa (öğeler farklı sayfalardaysa her sayfa kendi içinde). Tek öğe seçiliyse kağıda hizalanır.
 */
export function arrangeItems(s: Session, ids: ReadonlySet<string>, templates: Templates, how: { align: AlignMode } | { distribute: "x" | "y" }, sizes: ItemSizes = NO_SIZES): Session {
  return mapPages(s, (p) => {
    const sel = p.items.filter((i) => ids.has(i.id));
    if (!sel.length) return p;
    const t = templates.get(p.templateId);
    const boxes = sel.map((i) => itemBox(i, t, sizes));
    let moves: Map<string, Pt>;
    if ("align" in how) moves = sel.length === 1 && t ? alignToRect(boxes, how.align, { x: 0, y: 0, w: t.paper.wMm, h: t.paper.hMm }) : alignBoxes(boxes, how.align);
    else moves = distributeBoxes(boxes, how.distribute);
    if (!moves.size) return p;
    return { ...p, items: p.items.map((i) => (moves.has(i.id) ? settle({ ...i, xMm: moves.get(i.id)!.x, yMm: moves.get(i.id)!.y, manual: true }, t) : i)) };
  });
}

// ---------------------------------------------------------------- sayfalar

export function addPage(s: Session, templateId: string, opts: { id?: string; name?: string; showCellLabels?: boolean } = {}): { session: Session; pageId: string } {
  const id = opts.id ?? newId("p");
  const index = s.pages.reduce((m, p) => Math.max(m, p.index + 1), 0);
  const page: Page = {
    id,
    sessionId: s.id,
    templateId,
    index,
    name: opts.name ?? (i18n.t("printDesk:page.defaultName", { n: index + 1 }) as string),
    copies: 1,
    kind: "manual",
    showCellLabels: opts.showCellLabels ?? true,
    locked: false,
    items: [],
  };
  return { session: { ...s, pages: [...s.pages, page] }, pageId: id };
}

export function removePage(s: Session, pageId: string): Session {
  return s.pages.some((p) => p.id === pageId) ? { ...s, pages: s.pages.filter((p) => p.id !== pageId) } : s;
}

export type PagePatch = Partial<Pick<Page, "name" | "copies" | "locked" | "showCellLabels">>;
export function updatePage(s: Session, pageId: string, patch: PagePatch): Session {
  return mapPages(s, (p) => (p.id === pageId ? { ...p, ...patch } : p));
}

// ---------------------------------------------------------------- fark → toplu yama

const ITEM_POS = ["pageId", "slotId", "xMm", "yMm"] as const;
const ITEM_NUM = ["rotation", "scale", "z", "extra", "variantId", "manual"] as const;
const PAGE_FIELDS = ["name", "copies", "locked", "showCellLabels", "index"] as const;

/**
 * İki oturum durumu arasındaki fark → sunucunun toplu yama işlemleri. Sıra: öğe silme, sayfa silme, sayfa ekleme,
 * sayfa güncelleme, şablon değiştirme, taşıma (dolu yuvada sunucu yer değiştirir; sonuç yine hedef durumdur),
 * öğe ekleme, öğe güncelleme. `manual` bayrağı da gider: geri al / ileri al planlayıcının koyduğu öğeyi (manual
 * false) geri getirirken öğe "elle" olmasın (yoksa sonraki yeniden planlama ona dokunamazdı).
 */
export function diffSession(prev: Session, next: Session): PrintPatchOp[] {
  const ops: PrintPatchOp[] = [];
  if (prev.name !== next.name) ops.push({ op: "renameSession", name: next.name });
  const prevPages = new Map(prev.pages.map((p) => [p.id, p]));
  const nextPages = new Map(next.pages.map((p) => [p.id, p]));
  const prevItems = new Map(prev.pages.flatMap((p) => p.items.map((i) => [i.id, i] as const)));
  const nextItems = new Map(next.pages.flatMap((p) => p.items.map((i) => [i.id, i] as const)));

  for (const [id, it] of prevItems) if (!nextItems.has(id) && nextPages.has(it.pageId)) ops.push({ op: "removeItem", itemId: id });
  for (const id of prevPages.keys()) if (!nextPages.has(id)) ops.push({ op: "removePage", pageId: id });

  const pageUpdates: PrintPatchOp[] = [];
  for (const p of next.pages) {
    const o = prevPages.get(p.id);
    if (!o) {
      ops.push({ op: "addPage", id: p.id, templateId: p.templateId, index: p.index, name: p.name, copies: p.copies });
      pageUpdates.push({ op: "updatePage", pageId: p.id, locked: p.locked, showCellLabels: p.showCellLabels });
      continue;
    }
    const upd: Record<string, unknown> = {};
    for (const f of PAGE_FIELDS) if (o[f] !== p[f]) upd[f] = p[f];
    if (Object.keys(upd).length) pageUpdates.push({ op: "updatePage", pageId: p.id, ...upd } as PrintPatchOp);
    if (o.templateId !== p.templateId) pageUpdates.push({ op: "setPageTemplate", pageId: p.id, templateId: p.templateId });
  }
  ops.push(...pageUpdates);

  const adds: PrintPatchOp[] = [];
  const updates: PrintPatchOp[] = [];
  for (const [id, it] of nextItems) {
    const o = prevItems.get(id);
    if (!o) {
      adds.push({
        op: "addItem",
        id,
        pageId: it.pageId,
        jobId: it.jobId,
        variantId: it.variantId,
        slotId: it.slotId,
        xMm: it.xMm,
        yMm: it.yMm,
        rotation: it.rotation,
        scale: it.scale,
        z: it.z,
        extra: it.extra,
        manual: it.manual,
      });
      continue;
    }
    const moved = ITEM_POS.some((f) => o[f] !== it[f]);
    if (moved) {
      ops.push({ op: "moveItem", itemId: id, ...(o.pageId !== it.pageId ? { pageId: it.pageId } : {}), slotId: it.slotId, xMm: it.xMm, yMm: it.yMm, manual: it.manual });
    }
    const upd: Record<string, unknown> = {};
    for (const f of ITEM_NUM) if (o[f] !== it[f] && !(moved && f === "manual")) upd[f] = it[f];
    if (Object.keys(upd).length) updates.push({ op: "updateItem", itemId: id, ...upd } as PrintPatchOp);
  }
  ops.push(...adds, ...updates);
  return ops;
}

// ---------------------------------------------------------------- masa düzeni ve hücre etiketleri

/** Masada sütun sayısı: sayfa sayısına göre geniş ekrana yatık bir ızgara. */
export function boardColumns(n: number): number {
  return Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 2))));
}

/**
 * Sayfaların masadaki yerleri (mm): soldan sağa, satır satır; her satırın yüksekliği en uzun sayfası kadar.
 * Sayfanın üstünde `PAGE_HEADER_MM` başlık payı bırakılır.
 */
export function boardLayout(pages: ReadonlyArray<{ id: string; wMm: number; hMm: number }>, cols = boardColumns(pages.length)): Map<string, Rect> {
  const out = new Map<string, Rect>();
  let y = PAGE_HEADER_MM;
  for (let r = 0; r * cols < pages.length; r++) {
    const row = pages.slice(r * cols, r * cols + cols);
    let x = 0;
    for (const p of row) {
      out.set(p.id, { x, y, w: p.wMm, h: p.hMm });
      x += p.wMm + PAGE_GAP_MM;
    }
    y += Math.max(...row.map((p) => p.hMm)) + PAGE_GAP_MM + PAGE_HEADER_MM;
  }
  return out;
}

/** Masadaki nokta hangi sayfanın üstünde? (sayfaya göre yerel nokta ile) */
export function pageAt(layout: ReadonlyMap<string, Rect>, p: Pt, padMm = 0): { pageId: string; local: Pt } | null {
  for (const [id, r] of layout) {
    if (p.x >= r.x - padMm && p.x <= r.x + r.w + padMm && p.y >= r.y - padMm && p.y <= r.y + r.h + padMm) return { pageId: id, local: { x: p.x - r.x, y: p.y - r.y } };
  }
  return null;
}

export interface CellLabelView {
  jobId: string;
  text: string;
  /** Yazının sol üst köşesi (mm, sayfaya göre). */
  xMm: number;
  yMm: number;
}

/**
 * Sayfadaki hücre etiketleri (sipariş adı): her siparişin okuma sırasındaki ilk yuvasının yanında (eklenti kuralı,
 * `@tagpress/print` `cellLabelPosition`). Sayfada kapalıysa ya da siparişin no/adedi bilinmiyorsa yok.
 */
export function cellLabels(page: Page, t: PrintTemplate | undefined, orders: ReadonlyMap<string, { orderNo: string | null; quantity: number }>): CellLabelView[] {
  if (!page.showCellLabels || !t || !t.slots.length) return [];
  const order = slotsInReadingOrder(t.slots, ROW_TOL_MM);
  const rank = new Map(order.map((s, i) => [s.id, i]));
  const firstSlot = new Map<string, PrintSlot>();
  for (const it of page.items) {
    if (!it.slotId) continue;
    const slot = t.slots.find((s) => s.id === it.slotId);
    if (!slot) continue;
    const cur = firstSlot.get(it.jobId);
    if (!cur || (rank.get(slot.id) ?? 0) < (rank.get(cur.id) ?? 0)) firstSlot.set(it.jobId, slot);
  }
  const out: CellLabelView[] = [];
  const seenOrder = new Set<string>();
  for (const [jobId, slot] of [...firstSlot].sort((a, b) => (rank.get(a[1].id) ?? 0) - (rank.get(b[1].id) ?? 0))) {
    const o = orders.get(jobId);
    if (!o?.orderNo || seenOrder.has(o.orderNo)) continue;
    seenOrder.add(o.orderNo);
    const row = t.slots.filter((s) => Math.abs(s.cy - slot.cy) < ROW_TOL_MM);
    const pos = cellLabelPosition(t, slot, row);
    out.push({ jobId, text: labelText({ jobId, variantId: "", orderNo: o.orderNo, quantity: o.quantity, designKey: null }), ...pos });
  }
  return out;
}
