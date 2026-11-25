import type { PrintGridSpecInput, PrintSlot, PrintTemplateView, PrintTemplateWarning } from "@tagpress/domain";
import { clearingInset } from "@tagpress/print";
import { formatMm } from "../../../../i18n/bicim.ts";
import { i18n } from "../../../../i18n/index.ts";
import type { Pt, Rect } from "../../../../tezgah/tuval/canvas-math.ts";
import { sizeLabel } from "../shelf.ts";
import { type AlignMode, alignBoxes, alignToRect, type BoxItem, distributeBoxes, duplicateSlots, moveSlots, r2, slotBounds } from "../slot-geometry.ts";
import type { TemplateDraft } from "./draft.ts";

/**
 * Sayfa şablonu düzenleyicisinin mantığı — SAF (eski `TemplateEditor`, `TemplatesView`, `SlotCanvas` ve `panels`
 * bileşenlerinden çıkarıldı; eski ve yeni ekran aynı işlevleri kullanır). Birim mm. Metinler `printTemplates`
 * sözlüğünden (etkin dilde).
 */

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;

export type SlotTool = "select" | "circle" | "ellipse" | "rect";
/** Sağ paneldeki sekmeler: Temel (kâğıt, etiket, diziliş, seçili yuva, uyarılar) ve Gelişmiş (seyrek ayarlar). */
export type EditorTab = "temel" | "gelismis";
export type KindFilter = "all" | "label" | "sticker";

/** Araç tuşları (V seç, C daire, E elips, R dikdörtgen). */
export const TOOL_KEYS: Readonly<Record<string, SlotTool>> = { v: "select", c: "circle", e: "ellipse", r: "rect" };

/** Tuş (`e.key`, küçük harf) → araç; araç tuşu değilse null. */
export function toolForKey(key: string): SlotTool | null {
  return Object.hasOwn(TOOL_KEYS, key) ? TOOL_KEYS[key]! : null;
}

/** Taşırken / çizerken bu kadar ekran pikselinden kısa hareket tıklama sayılır. */
export const DRAG_MIN_PX = 3;
/** Okuma sırası numarasının yazı boyu (mm); ekranda `NUMBER_MIN_PX`'ten küçükse gösterilmez. */
export const NUMBER_FONT_MM = 3.2;
export const NUMBER_MIN_PX = 8;
/** Çoğaltılan yuvalar bu kadar sağa ve aşağıya konur (mm). */
export const DUPLICATE_OFFSET_MM: Pt = { x: 5, y: 5 };
/** Hücre etiketi önizlemesinde gösterilen örnek sipariş adı. */
export const SAMPLE_CELL_LABEL = "4849_36adet";

// ---------------------------------------------------------------- açılış ve liste

/** Liste: arşiv (göster/gizle), tür, arama (ad ya da boyut); arşivdekiler sonda, sonra türe ve ada göre. */
export function filterTemplates<T extends Pick<PrintTemplateView, "name" | "kind" | "sizeId" | "archived">>(all: readonly T[], f: { query: string; kind: KindFilter; showArchived: boolean }): T[] {
  const needle = f.query.trim().toLocaleLowerCase("tr");
  return all
    .filter((x) => (f.showArchived ? true : !x.archived))
    .filter((x) => f.kind === "all" || x.kind === f.kind)
    .filter((x) => !needle || x.name.toLocaleLowerCase("tr").includes(needle) || (x.sizeId ?? "").includes(needle))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "tr"));
}

/** Boyut: daire kesimli etikette cm ("3,8 cm", rafla aynı); kesim kimliğinde (63.5x38.1) olduğu gibi. */
function sizeText(kind: TemplateDraft["kind"], sizeId: string): string {
  return kind === "label" && /^\d+(\.\d+)?$/.test(sizeId) ? sizeLabel(sizeId) : sizeId;
}

/** "Etiket · 3,8 cm · 210 × 297 mm · 35 yuva" (boyut rafla aynı biçimde). */
export function templateSummary(x: Pick<PrintTemplateView, "kind" | "sizeId" | "paper" | "capacity">): string {
  const kind = t(x.kind === "label" ? "printTemplates:kind.label" : "printTemplates:kind.sticker");
  const base = { kind, w: formatMm(x.paper.wMm), h: formatMm(x.paper.hMm), count: x.capacity };
  return x.sizeId ? t("printTemplates:list.summarySized", { ...base, size: sizeText(x.kind, x.sizeId) }) : t("printTemplates:list.summary", base);
}

/**
 * Liste satırının kısa özeti (maket .vrow): "Etiket · 3,8 cm · 35 yuva". Boyutsuz şablonda yuvalar tek ölçüdeyse o
 * ölçü ("Ø 40 mm", "63,5 × 38,1 mm"), karışıksa yalnız tür ve yuva sayısı. Kağıt ölçüsü tam özette (`templateSummary`).
 */
export function templateShortSummary(x: Pick<PrintTemplateView, "kind" | "sizeId" | "slots" | "capacity">): string {
  const kind = t(x.kind === "label" ? "printTemplates:kind.label" : "printTemplates:kind.sticker");
  const size = x.sizeId ? sizeText(x.kind, x.sizeId) : slotSizeText(x.slots);
  return size ? t("printTemplates:list.short", { kind, size, count: x.capacity }) : t("printTemplates:list.shortNoSize", { kind, count: x.capacity });
}

/** Bütün yuvalar aynı şekil ve ölçüdeyse o ölçü; değilse null. */
function slotSizeText(slots: readonly Pick<PrintSlot, "shape" | "w" | "h">[]): string | null {
  const first = slots[0];
  if (!first) return null;
  const same = slots.every((s) => s.shape === first.shape && Math.abs(s.w - first.w) < 0.01 && Math.abs(s.h - first.h) < 0.01);
  if (!same) return null;
  return first.shape === "circle" ? t("printTemplates:list.slotCircle", { d: formatMm(first.w) }) : t("printTemplates:list.slotBox", { w: formatMm(first.w), h: formatMm(first.h) });
}

/** Izgaradan kaydedilen ön ayarın adı: "210 × 297 · 5 × 7 · 38 mm daire" ya da "… · 63.5 × 38.1 mm". */
export function presetName(g: PrintGridSpecInput): string {
  const base = { pw: g.paper.wMm, ph: g.paper.hMm, cols: g.columns, rows: g.rows };
  if (g.shape === "circle" || !g.shape) return t("printTemplates:grid.presetNameCircle", { ...base, d: String(g.diameterMm ?? g.wMm) });
  return t("printTemplates:grid.presetNameBox", { ...base, w: String(g.wMm ?? g.diameterMm), h: String(g.hMm ?? g.diameterMm) });
}

// ---------------------------------------------------------------- uyarılar

/** Yuvaya bağlı uyarılar ("yuva yok" bilgisi hariç): sekme sayacı ve tuvaldeki işaret. */
export function slotWarnings(ws: readonly PrintTemplateWarning[]): PrintTemplateWarning[] {
  return ws.filter((w) => w.code !== "no-slots");
}

export function warnedSlotIds(ws: readonly PrintTemplateWarning[]): Set<string> {
  return new Set(slotWarnings(ws).flatMap((w) => w.slotIds));
}

/**
 * Uyarının metni: `printTemplates:warnings.<messageKey>` (yoksa `<code>`) parametrelerle; sözlükte yoksa sunucunun
 * (ya da canlı denetimin) cümlesi.
 */
export function warningText(w: Pick<PrintTemplateWarning, "code" | "message"> & Partial<Pick<PrintTemplateWarning, "messageKey" | "params">>): string {
  for (const k of [w.messageKey, w.code]) {
    if (!k) continue;
    const key = `printTemplates:warnings.${k}`;
    // Çoğullu anahtar (`_one`/`_other`) yalnız `count` verilince çözülür; parametreler eksikse sunucunun cümlesi.
    if (i18n.exists(key, w.params ?? {})) return t(key, w.params ?? {});
  }
  return w.message;
}

/** Kayıt işareti çakışmasını çözen en yakın kenar payı (mm); çakışma yoksa ya da hiçbir pay çözmüyorsa null. */
export function markFixInset(d: Pick<TemplateDraft, "paper" | "cut" | "slots">): number | null {
  if (!d.cut.registration.enabled || !d.slots.length) return null;
  const v = clearingInset(d.paper, d.cut, d.slots);
  return v === null || v === d.cut.registration.insetMm ? null : v;
}

// ---------------------------------------------------------------- yuvalar

/** Tıkla-çiz varsayılan ölçüsü: seçili/ilk yuva, etiket çapı ya da etiket boyutu (cm → mm); hiçbiri yoksa 30 mm. */
export function defaultSlotSize(d: Pick<TemplateDraft, "slots" | "labelDiameterMm" | "sizeId">, selected: readonly string[]): { w: number; h: number } {
  const s = d.slots.find((x) => x.id === selected[0]) ?? d.slots[0];
  if (s) return { w: s.w, h: s.h };
  if (d.labelDiameterMm) return { w: d.labelDiameterMm, h: d.labelDiameterMm };
  const cm = Number((d.sizeId ?? "").replace(",", "."));
  if (cm > 0 && cm < 50) return { w: cm * 10, h: cm * 10 };
  return { w: 30, h: 30 };
}

export function removeSlots(d: TemplateDraft, ids: ReadonlySet<string>): TemplateDraft {
  if (!ids.size) return d;
  return { ...d, slots: d.slots.filter((s) => !ids.has(s.id)) };
}

/** Seçili yuvaları çoğaltır (5 mm sağa ve aşağıya); yeni kimlikler `added`. */
export function duplicateSelection(d: TemplateDraft, ids: ReadonlySet<string>): { draft: TemplateDraft; added: string[] } {
  if (!ids.size) return { draft: d, added: [] };
  const r = duplicateSlots(d.slots, ids, DUPLICATE_OFFSET_MM);
  return { draft: { ...d, slots: r.slots }, added: r.added };
}

export function nudgeSelection(d: TemplateDraft, ids: ReadonlySet<string>, n: Pt): TemplateDraft {
  const slots = moveSlots(d.slots, ids, n.x, n.y);
  return slots === d.slots ? d : { ...d, slots };
}

function boxesOf(d: TemplateDraft, ids: ReadonlySet<string>): BoxItem[] {
  return d.slots
    .filter((s) => ids.has(s.id))
    .map((s) => {
      const b = slotBounds(s);
      return { id: s.id, cx: s.cx, cy: s.cy, w: b.w, h: b.h };
    });
}

/** Yeni merkezleri yazar (0,01 mm'ye yuvarlı); yer değişmezse aynı taslak. */
export function applyMoves(d: TemplateDraft, moves: ReadonlyMap<string, Pt>): TemplateDraft {
  if (!moves.size) return d;
  return { ...d, slots: d.slots.map((s) => (moves.has(s.id) ? { ...s, cx: r2(moves.get(s.id)!.x), cy: r2(moves.get(s.id)!.y) } : s)) };
}

/** Hizala: tek yuvada kağıda, birden çokta seçimin kutusuna göre. */
export function alignSelection(d: TemplateDraft, ids: ReadonlySet<string>, mode: AlignMode): TemplateDraft {
  const boxes = boxesOf(d, ids);
  return applyMoves(d, boxes.length === 1 ? alignToRect(boxes, mode, { x: 0, y: 0, w: d.paper.wMm, h: d.paper.hMm }) : alignBoxes(boxes, mode));
}

/** Eşit aralıkla dağıt (en az 3 yuva). */
export function distributeSelection(d: TemplateDraft, ids: ReadonlySet<string>, axis: "x" | "y"): TemplateDraft {
  return applyMoves(d, distributeBoxes(boxesOf(d, ids), axis));
}

/** Yuvaların ortak sınır kutusu (cetvel vurgusu, "seçime yakınlaştır"); boşsa null. */
export function selectionBounds(slots: readonly PrintSlot[]): Rect | null {
  if (!slots.length) return null;
  const bs = slots.map(slotBounds);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

/** Sürükleme kayması (mm): Shift ile tek eksende; 0,1 mm'ye yuvarlı. */
export function dragDelta(dx: number, dy: number, shift: boolean): Pt {
  let x = dx;
  let y = dy;
  if (shift) {
    if (Math.abs(x) > Math.abs(y)) y = 0;
    else x = 0;
  }
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** Okuma sırası numaraları bu yakınlaştırmada okunur mu (ekranda en az 8 px)? */
export function numbersReadable(zoom: number, fontMm = NUMBER_FONT_MM): boolean {
  return fontMm * zoom >= NUMBER_MIN_PX;
}

/** Numara yazı boyunun yuvanın kısa kenarına oranı (maket: 38 mm yuvada ≈ 8 mm). */
export const NUMBER_SLOT_RATIO = 0.21;

/**
 * Okuma sırası numarasının yazı boyu (mm): en küçük yuvanın kısa kenarıyla büyür, en az `NUMBER_FONT_MM`. Bütün
 * yuvalarda aynı boy (sığdır görünümünde de okunsun; küçük yuvalı kağıtta eskisi gibi).
 */
export function slotNumberFontMm(slots: readonly Pick<PrintSlot, "w" | "h">[]): number {
  let side = Infinity;
  for (const s of slots) side = Math.min(side, s.w, s.h);
  if (!Number.isFinite(side)) return NUMBER_FONT_MM;
  return Math.max(NUMBER_FONT_MM, Math.round(side * NUMBER_SLOT_RATIO * 10) / 10);
}

// ---------------------------------------------------------------- alanlar

/**
 * Elle yazılan ölçü ("28,5", "28.5", "28,5 mm", "-3°") → sayı; okunamazsa null. Hem nokta hem virgül varsa nokta
 * binlik ayırıcıdır.
 */
export function parseMmText(text: string): number | null {
  let s = text.trim().replace(/\s+/g, "").replace(/[^\d.,+-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Hex renk yazımı sürerken kabul edilir mi ("#", "#E0", "#E0218A")? */
export const HEX_PARTIAL = /^#[0-9a-f]{0,6}$/i;
/** Renk seçicinin anlayacağı tam hex; değilse siyah. */
export function pickerColor(v: string): string {
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000";
}

// ---------------------------------------------------------------- kağıt

export type Orientation = "portrait" | "landscape";

export function orientationOf(paper: { wMm: number; hMm: number }): Orientation {
  return paper.wMm > paper.hMm ? "landscape" : "portrait";
}

/** Yön değişince en ve boy yer değiştirir (aynı yöndeyse aynı kağıt). */
export function withOrientation(paper: { wMm: number; hMm: number }, o: Orientation): { wMm: number; hMm: number } {
  return orientationOf(paper) === o ? paper : { wMm: paper.hMm, hMm: paper.wMm };
}

// ---------------------------------------------------------------- silme

/**
 * Silme penceresinin hâli (sunucunun `DELETE` sonucuyla aynı ayrım, listedeki kullanım sayısından önceden):
 * hiç kullanılmamış şablon kalıcı silinir (`delete`), bir baskıda kullanılmış olan arşive kaldırılır (`archive`).
 * Kullanım sayısı gelmemişse (`usedIn` yok) genel metin (`unknown`); sonuç bildirimde söylenir.
 */
export type DeleteMode = "delete" | "archive" | "unknown";

export function deleteMode(x: Pick<PrintTemplateView, "usedIn">): DeleteMode {
  if (x.usedIn === undefined) return "unknown";
  return x.usedIn > 0 ? "archive" : "delete";
}

/** Görünür "Sil" düğmesi: arşivde duran ve baskıda kullanılmış şablon silinemez (yalnız arşivden çıkarılır). */
export function canDelete(x: Pick<PrintTemplateView, "usedIn" | "archived">): boolean {
  return !(x.archived && (x.usedIn ?? 0) > 0);
}
