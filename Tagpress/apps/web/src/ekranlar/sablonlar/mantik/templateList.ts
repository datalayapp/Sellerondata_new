import type { TemplateItem, TemplateSyncResult } from "@tagpress/domain";
import { filterLabel, sortLabel } from "../metin.ts";

/** Şablon ızgarası için saf yardımcılar: doğal sıra, süzgeç, arama, işaretler, anahtar çıkarma. */

const NUMERIC = /^\d+$/;

/** Doğal anahtar sırası: önce yalnız sayılar (1, 2, … 30), sonra harfli anahtarlar (a1, a2, … a15, b1 …). */
export function compareKeys(a: string, b: string): number {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an !== bn) return an ? -1 : 1;
  if (an && bn) return Number(a) - Number(b) || a.localeCompare(b);
  return a.localeCompare(b, "tr", { numeric: true, sensitivity: "base" });
}

export type TemplateFilter = "all" | "manual" | "auto" | "missing" | "generated" | "sticker";
/** Süzgeçler; ad okunduğu anda etkin dilde (`templates:filters.<id>`). */
export const FILTERS: Array<{ id: TemplateFilter; label: string }> = (["all", "manual", "auto", "missing", "generated", "sticker"] as const).map((id) => ({
  id,
  get label() {
    return filterLabel(id);
  },
}));
/** Kütüphanede sekme olarak görünen süzgeçler; kalanlar "Diğer" menüsünde. */
export const MAIN_FILTERS: readonly TemplateFilter[] = ["all", "manual"];
export const OTHER_FILTERS: readonly TemplateFilter[] = ["auto", "missing", "generated", "sticker"];

export type TemplateSort = "key" | "key-desc" | "updated";
/** Sıralamalar; ad okunduğu anda etkin dilde (`templates:sorts.*`). */
export const SORTS: Array<{ id: TemplateSort; label: string }> = (["key", "key-desc", "updated"] as const).map((id) => ({
  id,
  get label() {
    return sortLabel(id);
  },
}));

export interface TemplateFlags {
  fileMissing: boolean;
  manualArea: boolean;
  /** Hedef merkez ölçümden/öğrenmeden geldi. */
  centerMeasured: boolean;
  /** Kurdele yüzdesi (0 ise yok). */
  ribbonPct: number;
}

export function flagsOf(item: TemplateItem): TemplateFlags {
  const t = item.template;
  const centerRows = (t.provenance ?? []).filter((p) => p.field === "textCenter");
  const last = centerRows[centerRows.length - 1];
  return {
    fileMissing: item.fileMissing,
    manualArea: t.area?.mode === "manual",
    centerMeasured: !!t.textCenter && (last?.source === "measured" || last?.source === "learned"),
    ribbonPct: Math.round((t.ribbonTop ?? 0) * 100),
  };
}

export function matchesFilter(item: TemplateItem, f: TemplateFilter): boolean {
  const t = item.template;
  switch (f) {
    case "all":
      return true;
    case "manual":
      return t.area?.mode === "manual";
    case "auto":
      return (t.area?.mode ?? "auto") === "auto";
    case "missing":
      return item.fileMissing;
    case "generated":
      return t.kind === "generated";
    case "sticker":
      return t.kind === "sticker";
  }
}

export function matchesQuery(item: TemplateItem, q: string): boolean {
  const term = q.trim().toLocaleLowerCase("tr");
  if (!term) return true;
  const t = item.template;
  return [t.key, t.notes ?? "", ...(t.tags ?? [])].some((s) => s.toLocaleLowerCase("tr").includes(term));
}

/** "Kalıcı yapma" ile üretilen geçici şablon (`gecici` etiketi): kütüphane listesinde gösterilmez, ama id ile çözülmeye devam eder. */
export function isTemporary(item: TemplateItem): boolean {
  return (item.template.tags ?? []).includes("gecici");
}

export function filterCounts(items: TemplateItem[]): Record<TemplateFilter, number> {
  const out = { all: 0, manual: 0, auto: 0, missing: 0, generated: 0, sticker: 0 } as Record<TemplateFilter, number>;
  for (const it of items.filter((i) => !isTemporary(i))) for (const f of FILTERS) if (matchesFilter(it, f.id)) out[f.id]++;
  return out;
}

export function sortTemplates(items: TemplateItem[], sort: TemplateSort): TemplateItem[] {
  const out = [...items];
  if (sort === "updated") return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || compareKeys(a.template.key, b.template.key));
  out.sort((a, b) => compareKeys(a.template.key, b.template.key));
  return sort === "key-desc" ? out.reverse() : out;
}

export function visibleTemplates(items: TemplateItem[], filter: TemplateFilter, q: string, sort: TemplateSort): TemplateItem[] {
  return sortTemplates(
    items.filter((i) => !isTemporary(i) && matchesFilter(i, filter) && matchesQuery(i, q)),
    sort,
  );
}

/** Dosya adından anahtar önerisi: "A15.png" → "a15", "şablon 03.PNG" → "şablon 03". */
export function keyFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("tr");
}

/** Anahtar geçerli mi (sunucu dosya adı ve rota için güvenli): boş değil, yol ayracı yok. */
export function validKey(key: string): boolean {
  const k = key.trim();
  return k.length > 0 && k.length <= 60 && !/[\\/?#%:*"<>|]/.test(k);
}

/** Dosya PNG mi (tür ya da uzantı). */
export function isPng(f: { name: string; type: string }): boolean {
  return f.type === "image/png" || /\.png$/i.test(f.name);
}

/** Bırakılan/seçilen dosyalar: PNG olanlar yüklenir, kalanlar adıyla bildirilir. */
export function splitPngs<T extends { name: string; type: string }>(files: readonly T[]): { ok: T[]; bad: T[] } {
  return { ok: files.filter(isPng), bad: files.filter((f) => !isPng(f)) };
}

/** Önceki ve sonraki şablon (doğal anahtar sırasında); listede yoksa ikisi de null. */
export function siblingsOf(order: readonly string[], key: string): { prev: string | null; next: string | null } {
  const i = order.indexOf(key);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? order[i - 1]! : null, next: i < order.length - 1 ? order[i + 1]! : null };
}

export type SyncGroupId = "added" | "updated" | "missing";

/**
 * Klasör tarama raporunun özeti: boş gruplar atlanır; dosyası kaybolan varsa uyarı tonu. `none`: her şey güncel
 * (rapor gösterilmez, yalnız kısa bildirim).
 */
export function syncSummary(r: TemplateSyncResult): { none: boolean; tone: "warn" | "info"; groups: Array<{ id: SyncGroupId; keys: string[] }> } {
  const groups = (["added", "updated", "missing"] as const).map((id) => ({ id, keys: r[id] })).filter((g) => g.keys.length > 0);
  return { none: groups.length === 0, tone: r.missing.length ? "warn" : "info", groups };
}
