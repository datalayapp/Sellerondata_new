import type { PrintTemplate } from "@tagpress/domain";
import { dedupeNames } from "./label.ts";
import { EPS_MM, PT_MM } from "./units.ts";
import type { PlanStickerOrder, PlannedItem, PlannedPage, PrintRules } from "./types.ts";

/**
 * Sticker sayfası planlayıcısı — SAF. Eklentideki `sticker-pages-plan.ts` ile aynı mantık, birim mm; geometri
 * `PrintTemplate.stickerFlow` + `paper`, fazlalık `rules.stickerExtraMin/Max`.
 *
 * - Satırlar dikeyde sayfaya eşit aralıkla yayılır. Her satırda tek sipariş vardır ve satır doludur. Satırdaki adet,
 *   sticker'ın MÜREKKEP genişliğine göre sığan en çok sayıdır; satır `rowSpanMm` genişliğine yayılır, ortalanır.
 * - Fazlalık: adede en az `stickerExtraMin` eklenir ve tam satıra yuvarlanır; tam sayfayı tamamlamak `stickerExtraMax`'ı
 *   aşmıyorsa sayfa tamamlanır.
 * - Tek siparişin dolu sayfaları tek sayfadır ("sip_Nsayfa" = bu sayfadan N baskı). Kalan satırlar karışık sayfalara
 *   sırayla girer ("sip_sip_1sayfa"); bir sipariş iki sayfaya bölünebilir. Karışık sayfa kapanırken kalan boşluk,
 *   sayfadaki siparişlerden fazladan satırla doldurulur; boşluk yalnızca son sayfada kalır.
 * - Çıktıda öğe konumu sticker kutusunun MERKEZİdir; hücre etiketi yoktur (eklentide de yoktu).
 */

export interface StickerGeometry {
  pageW: number;
  pageH: number;
  marginTop: number;
  marginBottom: number;
  /** Satıra kaç sticker sığacağı hesabında yan kenar payı. */
  marginX: number;
  /** Satırın yayıldığı genişlik (ilk sticker'ın solu → son sticker'ın sağı). */
  rowSpan: number;
  minGapX: number;
  minGapY: number;
  /** Doldurulmayan (son) sayfada satır arası üst sınırı. */
  looseGapY: number;
  minExtra: number;
  maxExtra: number;
}

/** Şablon + kurallardan sayfa geometrisi (mm). Şablonda `stickerFlow` yoksa hata verir. */
export function stickerGeometry(template: PrintTemplate, rules: PrintRules): StickerGeometry {
  const f = template.stickerFlow;
  if (!f) throw new Error("Sticker şablonunda sayfa akışı (stickerFlow) tanımlı değil.");
  const pageW = template.paper.wMm;
  return {
    pageW,
    pageH: template.paper.hMm,
    marginTop: f.marginTopMm,
    marginBottom: f.marginBottomMm,
    marginX: f.marginSideMm,
    rowSpan: f.rowSpanMm ?? pageW - 2 * f.marginSideMm,
    minGapX: f.minGapXMm,
    minGapY: f.minRowGapMm,
    looseGapY: f.maxRowGapLastMm,
    minExtra: rules.stickerExtraMin,
    maxExtra: rules.stickerExtraMax,
  };
}

interface Item {
  idx: number;
  order: PlanStickerOrder;
  /** Planlanacak adet (hedef). */
  quantity: number;
  /** Planlanan sticker'ların kaçı gerçek adet; aşan fazlalık işaretlenir. */
  real: number;
  /** Adede eklenen en az fazlalık (yeniden planlamanın kalanında 0). */
  minExtra: number;
  /** Sayfa tamamlamada bu siparişin tam sayfalarına konabilecek en çok sticker. */
  completeLimit: number;
  w: number;
  h: number;
}

/** `planStickerCore` seçenekleri (yeniden planlama). */
export interface StickerCoreOptions {
  /** i. siparişte planlananların kaçı gerçek adet (varsayılan: hedefin tamamı). */
  reals?: readonly number[];
  /**
   * i. sipariş "kalan" kipinde: hedef fazlalığı zaten içerir, `stickerExtraMin` eklenmez. Satıra yuvarlama ve karışık
   * sayfa boşluğunun doldurulması (yapısal kurallar) sürer; sayfa tamamlama, siparişin TOPLAM fazlalığı
   * `stickerExtraMax`'ı aşmıyorsa yapılır (`budgets[i]` = adet + stickerExtraMax − yerleşmiş).
   */
  leftover?: readonly boolean[];
  budgets?: readonly number[];
}

interface Row {
  idx: number;
  /** Satırdaki sticker'ların sol üst köşeleri (mm). */
  cells: { x: number; y: number }[];
}

interface RawPage {
  name: string;
  copies: number;
  kind: "full" | "mixed";
  rows: Row[];
}

const usableH = (s: StickerGeometry): number => s.pageH - s.marginTop - s.marginBottom;

/** Bir satıra sığan sticker sayısı. */
export function stickerPerRow(wMm: number, s: StickerGeometry): number {
  return Math.max(1, Math.floor((s.pageW - 2 * s.marginX + s.minGapX) / (wMm + s.minGapX) + EPS_MM));
}

/** Bir sayfaya sığan satır sayısı. */
export function stickerRowsPerPage(hMm: number, s: StickerGeometry): number {
  return Math.max(1, Math.floor((usableH(s) + s.minGapY) / (hMm + s.minGapY) + EPS_MM));
}

interface Draft {
  rows: Item[];
}

// Eklentideki 0.01 pt payı mm'ye çevrilmiş.
const FIT_TOL = 0.01 * PT_MM;

function heightWith(page: Draft, s: StickerGeometry, extra?: Item): number {
  const rows = extra ? [...page.rows, extra] : page.rows;
  return rows.reduce((sum, r) => sum + r.h, 0) + Math.max(0, rows.length - 1) * s.minGapY;
}

const fits = (page: Draft, item: Item, s: StickerGeometry): boolean => heightWith(page, s, item) <= usableH(s) + FIT_TOL;

/**
 * Çekirdek: `targets[i]` i. siparişin planlanacak adedi (≤0 ise atlanır). Sipariş numarasına göre doğal sırada işler.
 */
export function planStickerCore(orders: readonly PlanStickerOrder[], targets: readonly number[], s: StickerGeometry, opts: StickerCoreOptions = {}): PlannedPage[] {
  const items: Item[] = [];
  orders.forEach((order, idx) => {
    const quantity = targets[idx] ?? 0;
    if (!(quantity > 0)) return;
    const leftover = opts.leftover?.[idx] ?? false;
    items.push({
      idx,
      order,
      quantity,
      real: Math.max(0, opts.reals?.[idx] ?? quantity),
      minExtra: leftover ? 0 : s.minExtra,
      completeLimit: leftover ? (opts.budgets?.[idx] ?? quantity) : quantity + s.maxExtra,
      w: order.wMm,
      h: order.hMm,
    });
  });
  items.sort((a, b) => a.order.orderNo.localeCompare(b.order.orderNo, "tr", { numeric: true }));
  for (const item of items) {
    if (item.w > s.pageW - 2 * s.marginX || item.h > usableH(s)) {
      throw new Error(`${item.order.orderNo}: sticker sayfaya sığmıyor (${Math.round(item.w * 10) / 10}×${Math.round(item.h * 10) / 10} mm).`);
    }
  }

  // 1) Tek siparişin dolu sayfaları.
  const full: RawPage[] = [];
  const pending: { item: Item; rows: number }[] = [];
  for (const item of items) {
    const n = stickerPerRow(item.w, s);
    const pageRows = stickerRowsPerPage(item.h, s);
    const capacity = n * pageRows;
    const rows = Math.ceil((item.quantity + item.minExtra) / n);
    let pages = Math.floor(rows / pageRows);
    let rest = rows - pages * pageRows;
    // Sayfayı tamamlamak fazlalık sınırını aşmıyorsa tam sayfa yapılır (karışık sayfaya bölünmez).
    if (rest > 0 && (pages + 1) * capacity <= item.completeLimit) {
      pages += 1;
      rest = 0;
    }
    if (pages > 0) {
      full.push({ name: `${item.order.orderNo}_${pages}sayfa`, copies: pages, kind: "full", rows: layoutRows(Array.from({ length: pageRows }, () => item), s, true) });
    }
    if (rest > 0) pending.push({ item, rows: rest });
  }

  // 2) Kalan satırlar karışık sayfalara, sırayla.
  const drafts: Draft[] = [];
  let page: Draft = { rows: [] };
  const close = (): void => {
    if (page.rows.length) drafts.push(page);
    page = { rows: [] };
  };
  const fillWithExtras = (p: Draft): void => {
    for (;;) {
      const onPage = [...new Map(p.rows.map((r) => [r.idx, r])).values()].filter((it) => fits(p, it, s)).sort((a, b) => b.quantity - a.quantity);
      const pick = onPage[0];
      if (!pick) return;
      p.rows.push(pick);
    }
  };
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i]!;
    while (entry.rows > 0) {
      if (fits(page, entry.item, s)) {
        page.rows.push(entry.item);
        entry.rows--;
        continue;
      }
      // Satır sığmıyor: önce sonraki siparişlerin sığan satırları, sonra sayfadakilerden fazladan satır; sonra yeni sayfa.
      for (const later of pending.slice(i + 1)) {
        while (later.rows > 0 && fits(page, later.item, s)) {
          page.rows.push(later.item);
          later.rows--;
        }
      }
      fillWithExtras(page);
      close();
    }
  }
  const last = page.rows.length ? page : null;
  if (last) drafts.push(last);

  const mixed: RawPage[] = drafts.map((d) => {
    const nos = [...new Set(d.rows.map((r) => r.order.orderNo))];
    // Aynı siparişin satırları (sonradan eklenen fazlalık dahil) bitişik durur.
    const grouped = nos.flatMap((o) => d.rows.filter((r) => r.order.orderNo === o));
    return { name: `${nos.join("_")}_1sayfa`, copies: 1, kind: "mixed" as const, rows: layoutRows(grouped, s, d !== last) };
  });

  // Mm çıktısı: kutu merkezi; fazlalık işareti (sipariş başına birikimli, kopyalar sayfa sonunda eklenir).
  const running = new Map<number, number>();
  const out: PlannedPage[] = [...full, ...mixed].map((p) => {
    const onPage = new Map<number, number>();
    const planned: PlannedItem[] = [];
    for (const row of p.rows) {
      const item = items.find((it) => it.idx === row.idx)!;
      for (const c of row.cells) {
        const k = (onPage.get(row.idx) ?? 0) + 1;
        onPage.set(row.idx, k);
        planned.push({
          jobId: item.order.jobId,
          variantId: item.order.variantId,
          slotId: null,
          xMm: c.x + item.w / 2,
          yMm: c.y + item.h / 2,
          extra: (running.get(row.idx) ?? 0) + k > item.real,
        });
      }
    }
    for (const [idx, n] of onPage) running.set(idx, (running.get(idx) ?? 0) + n * p.copies);
    return { name: p.name, kind: p.kind, copies: p.copies, items: planned, cellLabels: [] };
  });
  return dedupeNames(out);
}

/**
 * Satırların yerleri. Dolu sayfada satırlar üst ve alt boşluk arasına eşit aralıkla yayılır;
 * son (dolmamış) sayfada yukarıdan, olağan aralıkla dizilir.
 */
function layoutRows(rows: Item[], s: StickerGeometry, justify: boolean): Row[] {
  const sumH = rows.reduce((sum, r) => sum + r.h, 0);
  const even = rows.length > 1 ? (usableH(s) - sumH) / (rows.length - 1) : 0;
  const gap = justify ? even : Math.min(Math.max(even, s.minGapY), s.looseGapY);
  let y = s.marginTop;
  return rows.map((item) => {
    const n = stickerPerRow(item.w, s);
    const span = Math.min(s.pageW - 2 * s.marginX, Math.max(s.rowSpan, n * item.w + (n - 1) * s.minGapX));
    const x0 = (s.pageW - span) / 2;
    const pitch = n > 1 ? (span - item.w) / (n - 1) : 0;
    const cells = Array.from({ length: n }, (_, i) => ({ x: n > 1 ? x0 + i * pitch : (s.pageW - item.w) / 2, y }));
    y += item.h + gap;
    return { idx: item.idx, cells };
  });
}

export function planStickerPages(input: { orders: PlanStickerOrder[]; template: PrintTemplate; rules: PrintRules }): PlannedPage[] {
  const { orders, template, rules } = input;
  return planStickerCore(orders, orders.map((o) => o.quantity), stickerGeometry(template, rules));
}
