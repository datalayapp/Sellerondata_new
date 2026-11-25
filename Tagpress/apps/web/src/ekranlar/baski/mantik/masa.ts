import {
  type PrintExport,
  type PrintExportRequest,
  type PrintItem,
  type PrintItemSize,
  type PrintSessionSummary,
  type PrintSkipped,
  type PrintTemplate,
  type PrintTemplateView,
  type ShelfItem,
  PRINT_DPI_MAX,
  PRINT_DPI_MIN,
  slotsInReadingOrder,
} from "@tagpress/domain";
import { nearestFreeSlot, ROW_TOL_MM } from "@tagpress/print";
import { type Pt, type Rect, unionRect } from "../../../tezgah/tuval/canvas-math.ts";
import {
  findItem,
  type ItemSizes,
  type ItemTarget,
  isOffset,
  itemSize,
  occupied,
  PAGE_HEADER_MM,
  type Page,
  pageAt,
  placeFromShelf,
  type Session,
  sortedPages,
  type Templates,
} from "./desk-model.ts";
import { type ShelfGroup, type ShelfRow, showsAsRemaining } from "./shelf.ts";

/**
 * Baskı masasının saf kararları (eski `desk/Desk.tsx`, `desk/Board.tsx`, `desk/Shelf.tsx` ve `desk/ExportDialog.tsx`
 * içinden çıkarıldı; eski ve yeni ekran aynı kuralları kullanır). Metin üretmez: kod ya da sayı döner, ekran sözlükten
 * yazar. Birim mm.
 */

// ---------------------------------------------------------------- oturum

/** Açılacak taslak: adresteki; yoksa hatırlanan (hâlâ taslaksa); yoksa listenin ilki; hiç yoksa null. */
export function pickSessionId(fromRoute: string | null | undefined, drafts: readonly Pick<PrintSessionSummary, "id">[], remembered: string | null): string | null {
  return fromRoute ?? drafts.find((s) => s.id === remembered)?.id ?? drafts[0]?.id ?? null;
}

/** Basılacak kağıt sayısı (kopyalar dahil). */
export function sheetCount(s: Pick<Session, "pages">): number {
  return s.pages.reduce((n, p) => n + p.copies, 0);
}

/** Oturumdaki etiket sayısı (sayfa başına bir kez; kopyalar sayılmaz). */
export function itemCount(s: Pick<Session, "pages">): number {
  return s.pages.reduce((n, p) => n + p.items.length, 0);
}

/** Oturumu kuran planın şablonu (yoksa ilk sayfanınki). */
export function planTemplateOf(s: Session, templates: Templates): PrintTemplate | undefined {
  return templates.get(s.templateId ?? sortedPages(s)[0]?.templateId ?? "");
}

export interface AddTarget {
  kind: ShelfGroup["kind"];
  sizeId: string | null;
  name: string;
}

/** Açık taslağın planı (türü, boyutu, adı): uyan raf grubunda "Oturuma ekle" görünür. Basılmış oturumda yok. */
export function addTargetOf(s: Session | null, templates: Templates, readOnly: boolean): AddTarget | null {
  if (!s || readOnly) return null;
  const t = planTemplateOf(s, templates);
  return t ? { kind: t.kind, sizeId: t.sizeId, name: s.name } : null;
}

/** Grubun kalanları açık taslağa eklenebilir mi: tür aynı, boyut aynı (ya da plan boyutsuz) ve kalan var. */
export function canAddTo(target: AddTarget | null, g: Pick<ShelfGroup, "kind" | "sizeId" | "remaining">): boolean {
  return !!target && target.kind === g.kind && (target.sizeId === null || target.sizeId === g.sizeId) && g.remaining > 0;
}

/** Planla / Oturuma ekle'ye giden işler: grupta kalanı olanlar. */
export function remainingJobIds(g: Pick<ShelfGroup, "rows">): string[] {
  return g.rows.filter((r) => r.remaining > 0).map((r) => r.jobId);
}

/** Gruptaki adedi girilmemiş sipariş sayısı (planlanmaz; uyarı). */
export function missingQuantityCount(g: Pick<ShelfGroup, "rows">): number {
  return g.rows.filter((r) => r.quantityMissing).length;
}

export const hasMarkOverlap = (t: Pick<PrintTemplateView, "warnings">): boolean => t.warnings.some((w) => w.code === "mark-overlap");

/** Oturumda kullanılan şablonlardan kayıt işareti yuvalara çakışanlar (dosya üretiminde sarı uyarı). */
export function markWarnings(s: Pick<Session, "pages"> | null, templates: readonly PrintTemplateView[]): Array<{ id: string; name: string }> {
  const used = new Set((s?.pages ?? []).map((p) => p.templateId));
  return templates.filter((t) => used.has(t.id) && hasMarkOverlap(t)).map((t) => ({ id: t.id, name: t.name }));
}

// ---------------------------------------------------------------- raf

export interface ShelfFilter {
  query: string;
  onlyRemaining: boolean;
}

const matchesQuery = (r: Pick<ShelfRow, "orderNo">, needle: string) => !needle || (r.orderNo ?? "").includes(needle);

/** Süzülmüş raf: sipariş no araması ve "yalnızca kalanlar"; boş kalan grup düşer. */
export function filterShelf(groups: readonly ShelfGroup[], f: ShelfFilter): ShelfGroup[] {
  const needle = f.query.trim();
  return groups.map((g) => ({ ...g, rows: g.rows.filter((r) => (!f.onlyRemaining || showsAsRemaining(r)) && matchesQuery(r, needle)) })).filter((g) => g.rows.length);
}

/**
 * "Yalnızca kalanlar" açıkken gizlenen (bütünüyle dizilmiş) işler: rafın sonunda tek satır ("3 iş dizildi · göster").
 * Arama varsa yalnız ona uyanlar sayılır; süzgeç kapalıysa sıfır.
 */
export function hiddenDoneCount(groups: readonly ShelfGroup[], f: ShelfFilter): number {
  if (!f.onlyRemaining) return 0;
  const needle = f.query.trim();
  let n = 0;
  for (const g of groups) for (const r of g.rows) if (!showsAsRemaining(r) && matchesQuery(r, needle)) n++;
  return n;
}

/** Raf başlığının sayıları: sipariş ve kalan adet. */
export function shelfTotals(groups: readonly ShelfGroup[]): { orders: number; remaining: number } {
  return { orders: groups.reduce((s, g) => s + g.rows.length, 0), remaining: groups.reduce((s, g) => s + g.remaining, 0) };
}

/** Kartın durumu: bitti (hepsi yerleşti), adet yok ya da sürüyor. */
export function rowState(r: Pick<ShelfRow, "remaining" | "quantityMissing">): "done" | "missing" | "open" {
  if (r.quantityMissing) return "missing";
  return r.remaining === 0 ? "done" : "open";
}

// ---------------------------------------------------------------- raftan sayfaya

export type ShelfDropRefusal = "no-page" | "locked" | "sticker-on-label" | "label-on-sticker" | "no-free-slot";

export type ShelfDropPlan = { ok: true; session: Session; added: string[]; short: number } | { ok: false; reason: ShelfDropRefusal };

/**
 * Raftan bırakma (sürükle-bırak ya da klavye): Shift kalan adedin hepsini (en az 1) okuma sırasıyla boş yuvalara
 * dizer, Alt tek etiketi yuvaya yapıştırmadan serbest konuma koyar. Kilitli sayfa ve türü uymayan sayfa (sticker →
 * etiket sayfası) reddedilir; boş yuva yoksa da. `short`: Shift ile sığmayan sayı (Shift yoksa 0).
 */
export function shelfDropPlan(
  s: Session,
  templates: Templates,
  d: { pageId: string; point: Pt; row: Pick<ShelfRow, "jobId" | "variantId" | "kind" | "remaining" | "quantity" | "placedNow">; shift: boolean; alt: boolean },
  makeId?: () => string,
): ShelfDropPlan {
  const page = s.pages.find((p) => p.id === d.pageId);
  const t = page && templates.get(page.templateId);
  if (!page || !t) return { ok: false, reason: "no-page" };
  if (page.locked) return { ok: false, reason: "locked" };
  if (d.row.kind !== t.kind) return { ok: false, reason: d.row.kind === "sticker" ? "sticker-on-label" : "label-on-sticker" };
  const count = d.shift ? Math.max(1, d.row.remaining) : 1;
  const r = placeFromShelf(s, t, { pageId: page.id, point: d.point, jobId: d.row.jobId, variantId: d.row.variantId, count, free: d.alt, quantity: d.row.quantity, placed: d.row.placedNow }, makeId);
  if (!r.added.length) return { ok: false, reason: "no-free-slot" };
  return { ok: true, session: r.session, added: r.added, short: d.shift ? r.short : 0 };
}

/**
 * Klavyeyle raftan koyma noktası: etkin sayfanın okuma sırasındaki ilk boş yuvası (yuvasız sayfada sayfanın ortası;
 * boş yuva yoksa ilk yuva, bırakma "boş yuva yok" diye reddedilir). Sayfa yoksa null.
 */
export function keyboardDropPoint(page: Page | undefined, t: PrintTemplate | undefined): Pt | null {
  if (!page || !t) return null;
  if (!t.slots.length) return { x: t.paper.wMm / 2, y: t.paper.hMm / 2 };
  const occ = occupied(page);
  const ordered = slotsInReadingOrder(t.slots, ROW_TOL_MM);
  const slot = ordered.find((x) => !occ.has(x.id)) ?? ordered[0]!;
  return { x: slot.cx, y: slot.cy };
}

export interface DropGhost {
  pageId: string;
  /** Hayaletin merkezi (masa mm). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Sürüklerken hayalet: imlecin altındaki sayfada en yakın boş yuvanın merkezi (Alt ile imlecin kendisi). Kilitli ya da
 * türü uymayan sayfada, sayfa dışında null (bırakınca nedeni söylenir).
 */
export function dropGhost(
  s: Session,
  layout: ReadonlyMap<string, Rect>,
  templates: Templates,
  sizes: ItemSizes,
  world: Pt,
  row: Pick<ShelfRow, "kind" | "wMm" | "hMm">,
  alt: boolean,
): DropGhost | null {
  const at = pageAt(layout, world);
  if (!at) return null;
  const page = s.pages.find((p) => p.id === at.pageId);
  const t = page ? templates.get(page.templateId) : undefined;
  if (!page || !t || page.locked || t.kind !== row.kind) return null;
  const o = layout.get(page.id)!;
  const slot = alt ? null : nearestFreeSlot(t, at.local.x, at.local.y, occupied(page));
  const c = slot ? { x: o.x + slot.cx, y: o.y + slot.cy } : world;
  const size = t.kind === "sticker" && row.wMm && row.hMm ? { w: row.wMm, h: row.hMm } : itemSize({ slotId: null, scale: 1 }, t, sizes);
  return { pageId: page.id, x: c.x, y: c.y, w: size.w, h: size.h };
}

// ---------------------------------------------------------------- tuvalde taşıma

/**
 * Sürüklenen öğelerin hedefleri: her öğe kendi merkezinin düştüğü sayfaya (sayfa dışına düşen, imlecin altındaki
 * sayfaya göre yerel konumla). Kaynak sayfası bilinmeyen öğe atlanır.
 */
export function moveTargets(s: Session, layout: ReadonlyMap<string, Rect>, ids: readonly string[], dx: number, dy: number, pointerPageId: string): ItemTarget[] {
  const out: ItemTarget[] = [];
  const pointer = layout.get(pointerPageId);
  for (const id of ids) {
    const f = findItem(s, id);
    const o = f && layout.get(f.page.id);
    if (!f || !o) continue;
    const world = { x: o.x + f.item.xMm + dx, y: o.y + f.item.yMm + dy };
    const at = pageAt(layout, world) ?? (pointer ? { pageId: pointerPageId, local: { x: world.x - pointer.x, y: world.y - pointer.y } } : null);
    if (at) out.push({ id, pageId: at.pageId, x: at.local.x, y: at.local.y });
  }
  return out;
}

/** Hedeflerden biri kilitli sayfada mı (bırakma reddedilir). */
export function targetsLocked(s: Session, targets: readonly ItemTarget[]): boolean {
  return targets.some((t) => s.pages.find((p) => p.id === t.pageId)?.locked);
}

/** Taşınabilir öğeler: seçimden kilitli sayfadakiler çıkar (basılmış oturumda hiçbiri). */
export function movableIds(s: Session, ids: readonly string[], readOnly: boolean): string[] {
  if (readOnly) return [];
  return ids.filter((id) => {
    const f = findItem(s, id);
    return !!f && !f.page.locked;
  });
}

// ---------------------------------------------------------------- seçim şeridi

/** Seçim şeridi eylemlerinin hedefi: seçili öğelerden kilitsiz sayfada olanlar. */
export function editableIds(s: Session | null, selected: readonly string[]): Set<string> {
  if (!s) return new Set();
  return new Set(movableIds(s, selected, false));
}

/** Hedefte yuvaya oturmuş öğe var mı (yuvadan çıkar) ve yuvasında kaymış olan var mı (yuvanın merkezine al). */
export function slotState(s: Session | null, editable: ReadonlySet<string>, templates: Templates): { any: boolean; offset: boolean } {
  let any = false;
  let offset = false;
  for (const p of s?.pages ?? []) {
    const t = templates.get(p.templateId);
    for (const it of p.items) {
      if (!editable.has(it.id) || !it.slotId) continue;
      any = true;
      if (isOffset(it, t)) offset = true;
    }
  }
  return { any, offset };
}

/** Ctrl A: etkin sayfa varsa yalnız onun öğeleri, yoksa bütün oturum. */
export function selectAllIds(s: Session, activePageId: string | null): string[] {
  const scope = activePageId ? s.pages.filter((p) => p.id === activePageId) : s.pages;
  return scope.flatMap((p) => p.items.map((i) => i.id));
}

/** Yazıyı düzelt (Enter, çift tık): tek öğe seçiliyse o. */
export function singleItem(s: Session | null, selected: readonly string[]): PrintItem | null {
  if (!s || selected.length !== 1) return null;
  return findItem(s, selected[0]!)?.item ?? null;
}

/** Esc: önce seçim, sonra etkin sayfa kalkar; ikisi de yoksa olay serbest. */
export function escapeStep(selectedCount: number, activePageId: string | null): "selection" | "page" | "none" {
  if (selectedCount > 0) return "selection";
  return activePageId ? "page" : "none";
}

// ---------------------------------------------------------------- sayfalar ve masa

/** Masa düzeninin girdisi: sayfa sırasıyla kağıt ölçüleri (şablon bilinmiyorsa A4). */
export function pageSizes(pages: readonly Page[], templates: Templates): Array<{ id: string; wMm: number; hMm: number }> {
  return pages.map((p) => ({ id: p.id, wMm: templates.get(p.templateId)?.paper.wMm ?? 210, hMm: templates.get(p.templateId)?.paper.hMm ?? 297 }));
}

/** Düzen anahtarı: yalnız sayfa listesi ya da ölçüleri değişince masa yeniden dizilir (öğe taşımak dizmez). */
export function layoutKey(sizes: ReadonlyArray<{ id: string; wMm: number; hMm: number }>): string {
  return sizes.map((p) => `${p.id}:${p.wMm}x${p.hMm}`).join("|");
}

/** "Hepsini sığdır" dikdörtgeni: bütün sayfalar, başlık payı dahil. Sayfa yoksa null. */
export function boardBounds(layout: ReadonlyMap<string, Rect>): Rect | null {
  return unionRect([...layout.values()].map((r) => ({ ...r, y: r.y - PAGE_HEADER_MM, h: r.h + PAGE_HEADER_MM })));
}

/** Tek sayfaya odak (yeni sayfa eklenince): başlık payı dahil. */
export function pageFocusRect(r: Rect): Rect {
  return { x: r.x, y: r.y - PAGE_HEADER_MM, w: r.w, h: r.h + PAGE_HEADER_MM };
}

/**
 * Sayfanın doluluğu: konan etiket, yuva sayısı ve fazladan konanlar. Yuvasız (sticker akışı) sayfada kapasite yok
 * (`null`; "0/0 dolu" yazılmaz).
 */
export function pageFill(page: Pick<Page, "items">, t: Pick<PrintTemplate, "slots"> | undefined): { count: number; capacity: number | null; extras: number } {
  const capacity = t && t.slots.length ? t.slots.length : null;
  return { count: page.items.length, capacity, extras: page.items.reduce((n, i) => n + (i.extra ? 1 : 0), 0) };
}

/** Ölçüler: oturumdakiler sunucudan, raftan yeni bırakılan sticker'lar raf satırından (görsel kutusu sonra gelir). */
export function itemSizesMap(shelf: readonly Pick<ShelfItem, "variantId" | "wMm" | "hMm">[], fromSession: Record<string, PrintItemSize> | undefined): Map<string, PrintItemSize> {
  const m = new Map<string, PrintItemSize>();
  for (const i of shelf) if (i.wMm && i.hMm) m.set(i.variantId, { wMm: i.wMm, hMm: i.hMm, art: null });
  for (const [v, sz] of Object.entries(fromSession ?? {})) m.set(v, sz);
  return m;
}

// ---------------------------------------------------------------- planlama yanıtları

/** Planlanmayan işlerin özeti (bildirim): sayı ve ilk üç neden. */
export function skippedSummary(skipped: readonly PrintSkipped[] | undefined): { count: number; reasons: string[] } {
  const list = skipped ?? [];
  return { count: list.length, reasons: list.slice(0, 3).map((x) => x.reason) };
}

/**
 * Yeniden planlamada adedi olmadığı için atlanan siparişler (sunucunun nedeni "…: adet yok"): sayı ve ilk üç sipariş.
 * Kural eski masayla aynı (neden metninde "adet yok", sipariş iki noktadan önce).
 */
export function missingQuantity(skipped: readonly PrintSkipped[] | undefined): { count: number; orders: string[] } {
  const list = (skipped ?? []).filter((x) => /adet yok/.test(x.reason)); // i18n-ok: sunucunun neden metni
  return { count: list.length, orders: list.slice(0, 3).map((x) => x.reason.split(":")[0] ?? x.reason) };
}

// ---------------------------------------------------------------- dosya (PDF / PNG)

export type ExportFormat = "pdf" | "png";
export type PdfMode = "raster" | "vector";
export type ExportScope = "all" | "page";

export interface ExportOptions {
  format: ExportFormat;
  pdfMode: PdfMode;
  scope: ExportScope;
  /** Kapsam "seçili sayfa" ise o sayfa. */
  pageId: string | null;
  /** Elle girilen çözünürlük; null = tasarım dilindeki. */
  dpi: number | null;
}

/** "Dosyayı üret" isteğinin gövdesi. Seçili sayfa yoksa bütün sayfalar; PDF türü yalnız PDF'te. */
export function exportRequest(o: ExportOptions): PrintExportRequest {
  return { format: o.format, pages: o.scope === "page" && o.pageId ? [o.pageId] : undefined, dpi: o.dpi ?? undefined, ...(o.format === "pdf" ? { pdfMode: o.pdfMode } : {}) };
}

/** Seçeneklerin imzası: son üretimdekinden farklıysa dosyalar eskidir ("yeniden üret"). */
export function exportKey(o: ExportOptions): string {
  return JSON.stringify([o.format, o.format === "pdf" ? o.pdfMode : null, o.scope === "page" && o.pageId ? o.pageId : null, o.dpi]);
}

/** Çözünürlük alanı: baskı alt sınırından (150 dpi) küçük, boş ya da tasarım dilindekiyle aynı değer "tasarım dilindeki" (null) sayılır. */
export function dpiInput(v: number | null | undefined, defaultDpi: number | null): number | null {
  return v && v >= PRINT_DPI_MIN && v <= PRINT_DPI_MAX && Math.round(v) !== defaultDpi ? Math.round(v) : null;
}

export type ExportPhase = "idle" | "running" | "done" | "failed";

/** Üretimin evresi (sunucu kaydına göre; kayıt gelmeden "sürüyor"). */
export function exportPhase(exportId: string | null, ex: Pick<PrintExport, "status" | "files"> | undefined): ExportPhase {
  if (!exportId) return "idle";
  if (!ex || ex.status === "queued" || ex.status === "running") return "running";
  if (ex.status === "done") return ex.files.length > 0 ? "done" : "failed";
  return "failed";
}

/** İlerleme: sürerken olayın sayacı (daha taze), sonra kaydın kendisi. */
export function exportProgress(phase: ExportPhase, live: { done: number; total: number } | null, ex: Pick<PrintExport, "done" | "total"> | undefined): { done: number; total: number } {
  if (live && phase === "running") return live;
  return { done: ex?.done ?? 0, total: ex?.total ?? 0 };
}
