import { type PrintSlot, type PrintTemplate, type ShelfItem, slotFitsCut, type TemplateCut } from "@tagpress/domain";
import { formatNumber, intlLocale } from "../../../i18n/bicim.ts";
import { i18n } from "../../../i18n/index.ts";

/**
 * Raf (onaylı, basılmamış etiketler/sticker'lar) — SAF. Sunucunun `placed` sayısı kayıtlı taslak oturumlardandır; açık
 * oturumdaki henüz gönderilmemiş yerel değişiklik farkı eklenir ki sayaç sürükler sürüklemez değişsin. Metinler
 * `printDesk` sözlüğünden (etkin arayüz dilinde).
 */

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;

export interface ShelfRow extends ShelfItem {
  /** Yerel değişiklikler dahil yerleşen. */
  placedNow: number;
  /** Basılacak adede göre kalan (negatif olmaz). */
  remaining: number;
}

export interface ShelfGroup {
  key: string;
  kind: ShelfItem["kind"];
  sizeId: string | null;
  /**
   * Etiket: grubun işlerinin şablon kesimi (mm; raf satırındaki `cut`). Kesimli ve kesimsiz işler aynı boyut kimliğini
   * paylaşsa da (daire Ø38 kesimi ↔ eski "3.8") ayrı gruptadır: sayfa şablonu kuralı farklıdır (`groupTemplates`).
   */
  cut?: TemplateCut;
  rows: ShelfRow[];
  quantity: number;
  needed: number;
  remaining: number;
}

export function shelfRows(items: readonly ShelfItem[], serverPlaced: ReadonlyMap<string, number>, localPlaced: ReadonlyMap<string, number>): ShelfRow[] {
  return items.map((it) => {
    const placedNow = Math.max(0, it.placed - (serverPlaced.get(it.jobId) ?? 0) + (localPlaced.get(it.jobId) ?? 0));
    return { ...it, placedNow, remaining: Math.max(0, it.needed - placedNow) };
  });
}

const naturalNo = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "", "tr", { numeric: true });

/**
 * Boyuta / sayfa türüne göre gruplar: önce etiketler (boyut sırasıyla), sonra sticker'lar; grup içinde sipariş no.
 * Kesimli etiket (satırda `cut`) aynı boyut kimliğindeki kesimsiz (eski) etiketten ayrı gruptadır: sunucu ikisine
 * farklı sayfa şablonu kuralı uygular (`pageTemplateFor`); aynı grupta Planla birine yanlış şablon önerirdi.
 */
export function groupShelf(rows: readonly ShelfRow[]): ShelfGroup[] {
  const map = new Map<string, ShelfGroup>();
  for (const r of rows) {
    const cut = r.kind === "label" ? r.cut : undefined;
    const key = `${r.kind}:${r.sizeId ?? ""}${cut ? ":cut" : ""}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, kind: r.kind, sizeId: r.sizeId, ...(cut ? { cut } : {}), rows: [], quantity: 0, needed: 0, remaining: 0 }));
    g.rows.push(r);
    g.quantity += r.quantity;
    g.needed += r.needed;
    g.remaining += r.remaining;
  }
  for (const g of map.values()) g.rows.sort((a, b) => naturalNo(a.orderNo, b.orderNo));
  // Aynı boyut kimliğinde önce kesimsiz (eski) grup, sonra kesimli.
  return [...map.values()].sort((a, b) => (a.kind === b.kind ? naturalNo(a.sizeId, b.sizeId) || Number(!!a.cut) - Number(!!b.cut) : a.kind === "label" ? -1 : 1));
}

/**
 * Grubun basılabileceği sayfa şablonları (eski masa): aynı tür ve boyut (arşivlenmemiş); yoksa boyutsuz şablonlar,
 * kesimli grupta yalnız bütün yuvaları kesime uyanlar (sunucunun `pageTemplateFor` kuralı; Tezgâh'ta `groupTemplates`).
 */
export function templatesForGroup<T extends Pick<PrintTemplate, "kind" | "sizeId" | "archived"> & { slots?: readonly PrintSlot[] }>(
  g: Pick<ShelfGroup, "kind" | "sizeId"> & Partial<Pick<ShelfGroup, "cut">>,
  templates: readonly T[],
): T[] {
  const live = templates.filter((t) => !t.archived && t.kind === g.kind);
  const exact = live.filter((t) => t.sizeId !== null && t.sizeId === g.sizeId);
  if (exact.length) return exact;
  const loose = live.filter((t) => t.sizeId === null);
  const cut = g.kind === "label" ? g.cut : undefined;
  return cut ? loose.filter((t) => !!t.slots?.length && t.slots.every((s) => slotFitsCut(s, cut))) : loose;
}

/**
 * "36 → 40 (+4)"; fazlalık yoksa "36". Şablon bilinmeden kural formülüyle hesaplandıysa "≈" ile ("36 → ≈40 (+4)").
 * Adet yoksa "adet yok".
 */
export function neededLabel(r: Pick<ShelfItem, "quantity" | "needed"> & Partial<Pick<ShelfItem, "neededApprox" | "quantityMissing">>): string {
  if (r.quantityMissing) return t("printDesk:shelf.noQuantity");
  const extra = r.needed - r.quantity;
  if (extra <= 0) return String(r.quantity);
  return t(r.neededApprox ? "printDesk:shelf.neededApprox" : "printDesk:shelf.needed", { quantity: r.quantity, needed: r.needed, extra });
}

/** Raf süzgeci "yalnızca kalanlar": kalanı olan ya da adedi girilmemiş (uyarı için görünür kalır) sipariş. */
export const showsAsRemaining = (r: Pick<ShelfRow, "remaining" | "quantityMissing">): boolean => r.remaining > 0 || !!r.quantityMissing;

/** Grup başlığı: "3,8 cm etiket" / "Ø 38 mm etiket" (daire kesimli) / "Sticker · A". */
export function groupTitle(g: Pick<ShelfGroup, "kind" | "sizeId"> & Partial<Pick<ShelfGroup, "cut">>): string {
  if (g.kind === "label") {
    const size = groupSizeLabel(g);
    return size ? t("printDesk:shelf.labelGroup", { size }) : t("printDesk:shelf.labelNoSize");
  }
  return g.sizeId ? t("printDesk:shelf.stickerGroup", { size: g.sizeId }) : t("printDesk:shelf.sticker");
}

/**
 * Grubun ölçü metni: daire kesimli grupta çap mm ile ("Ø 38 mm"; kimliği "3.8" eski boyutla aynı olduğundan "3,8 cm"
 * yazılsa iki grup aynı adı alırdı), diğerlerinde `sizeLabel`. Boyutsuzsa null.
 */
export function groupSizeLabel(g: Pick<ShelfGroup, "sizeId"> & Partial<Pick<ShelfGroup, "cut">>): string | null {
  if (g.cut?.shape === "circle") return t("printDesk:shelf.sizeCutCircle", { d: formatNumber(g.cut.wMm, { maximumFractionDigits: 2 }) });
  return g.sizeId ? sizeLabel(g.sizeId) : null;
}

/** Ondalık ayırıcı (etkin dilde: TR ",", EN "."). */
const decimalSep = (): string => (1.5).toLocaleString(intlLocale()).charAt(1);

const OLD_SIZE = /^\d+(?:\.\d+)?$/;
const CUT_SIZE = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:r(\d+(?:\.\d+)?))?(-oval)?$/;

/**
 * Boyut kimliği → metin. Eski boyut "3.8" → TR "3,8 cm", EN "3.8 cm"; kesimli boyut "63.5x38.1" → "63,5 × 38,1 mm"
 * ("50x30r3" köşe yarıçapını, "50x30-oval" oval eki gösterir). Tanınmayan kimlik olduğu gibi döner.
 */
export function sizeLabel(sizeId: string): string {
  const num = (v: string) => formatNumber(Number(v), { maximumFractionDigits: 2 });
  if (OLD_SIZE.test(sizeId)) return t("printDesk:shelf.sizeCm", { size: sizeId.replace(".", decimalSep()) });
  const m = CUT_SIZE.exec(sizeId);
  if (!m) return sizeId;
  const o = { w: num(m[1]!), h: num(m[2]!), r: m[3] ? num(m[3]) : "" };
  return t(m[4] ? "printDesk:shelf.sizeCutOval" : m[3] ? "printDesk:shelf.sizeCutRound" : "printDesk:shelf.sizeCut", o);
}

/** Tarih damgası: "Bugün 14:20", "Dün 09:05", "7 Eki 2026" (EN "Today 2:20 PM", "Oct 7, 2026"). */
export function stamp(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return t("printDesk:stamp.today", { time: hm });
  if (diff === 1) return t("printDesk:stamp.yesterday", { time: hm });
  return d.toLocaleDateString(intlLocale(), { day: "numeric", month: "short", year: "numeric" });
}
