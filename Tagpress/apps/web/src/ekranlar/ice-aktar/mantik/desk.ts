import type { FieldMap, FixAction, ImportCommitRequest, ImportField, ImportPreviewResponse, ImportRow, ImportValidateRequest, Issue } from "@tagpress/domain";
import { applyPatch, isDuplicate, isProblem, nextProblemPos, patchNeedsValidation, resolveFix, type RowPatch, rowSeverity, rowToInput } from "./rows.ts";

/**
 * İçe aktarma masasının saf durum mantığı (eski `ImportDesk.tsx`'ten çıkarıldı; eski ve yeni ekran ortak kullanır):
 * dosya kabulü, seçim, etkin satır gezintisi, klavye kararı, toplu yamalar ve geri alma, doğrulama sürümleri,
 * gönderim gövdeleri, alan eşlemesi özeti. Metin üretmez (ekran sözlükten yazar); müşteri metnine yalnızca
 * kullanıcının seçtiği yama dokunur.
 */

// ---------------------------------------------------------------- dosya

export const ACCEPTED = [".json", ".ndjson", ".txt"] as const;
/** Dosya seçicinin `accept` özniteliği. */
export const ACCEPT_ATTR = ".json,.ndjson,.txt,application/json,text/plain";
/** Yapıştırılan metnin sunucuya gönderilen dosya adı (sunucunun varsayılanıyla aynı). */
export const PASTED_FILE_NAME = "yapistirilan.json";
/** Düzenlemeden sonra doğrulamaya kadar beklenen süre (ms). */
export const VALIDATE_DELAY = 400;
/** Alan eşlemesinin gösterim sırası. */
export const FIELD_ORDER: readonly ImportField[] = ["text", "orderNo", "quantity", "template", "size", "product"];

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED.some((ext) => lower.endsWith(ext));
}

export type FileProblem = "type" | "unreadable" | "empty";

/** Dosyayı okur; masada açılamayacaksa nedeni döner. */
export async function readImportFile(file: Pick<File, "name" | "text">): Promise<{ ok: true; content: string } | { ok: false; problem: FileProblem }> {
  if (!isAcceptedFile(file.name)) return { ok: false, problem: "type" };
  let content: string;
  try {
    content = await file.text();
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  if (!content.trim()) return { ok: false, problem: "empty" };
  return { ok: true, content };
}

/** Öğe yazı alanı mı (yapıştırma ve tek tuş kısayolları orada çalışmaz)? */
export function isTypingTarget(el: Element | EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && !!t.tagName && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || !!t.isContentEditable);
}

// ---------------------------------------------------------------- satırlar

export function getRow(rows: readonly ImportRow[], index: number): ImportRow | undefined {
  const r = rows[index];
  return r && r.index === index ? r : rows.find((x) => x.index === index);
}

export type PatchList = Array<{ index: number; patch: RowPatch }>;

/** Yamaları uygular; dokunulmayan satırlar aynı nesne kalır. */
export function applyPatches(rows: readonly ImportRow[], patches: PatchList): ImportRow[] {
  const byIndex = new Map(patches.map((p) => [p.index, p.patch]));
  return rows.map((r) => {
    const p = byIndex.get(r.index);
    return p ? applyPatch(r, p) : r;
  });
}

/** Geri alma için yamalanacak satırların önceki hâli. */
export function snapshotRows(rows: readonly ImportRow[], indexes: Iterable<number>): Map<number, ImportRow> {
  const out = new Map<number, ImportRow>();
  for (const i of indexes) {
    const r = getRow(rows, i);
    if (r) out.set(i, r);
  }
  return out;
}

/** Önceki hâle döner (geri al). Arada sunucudan gelen sorunlar da eski hâline döner; ekran yeniden doğrular. */
export function restoreRows(rows: readonly ImportRow[], before: ReadonlyMap<number, ImportRow>): ImportRow[] {
  return rows.map((r) => before.get(r.index) ?? r);
}

/** Yamalardan yeniden doğrulanması gereken satırlar (`include` dışında bir alan değişti). */
export function validationIndexes(patches: PatchList): number[] {
  return patches.filter((p) => patchNeedsValidation(p.patch)).map((p) => p.index);
}

/** Dahil satırlardan koşulu tutanları hariç tutan yamalar. */
export function excludePatches(rows: readonly ImportRow[], pred: (r: ImportRow) => boolean): PatchList {
  return rows.filter((r) => r.include && pred(r)).map((r) => ({ index: r.index, patch: { include: false } }));
}

/** Hariç tutulan bütün satırları dahil eden yamalar. */
export function includeAllPatches(rows: readonly ImportRow[]): PatchList {
  return rows.filter((r) => !r.include).map((r) => ({ index: r.index, patch: { include: true } }));
}

/** Verilen satırları dahil eder ya da hariç tutar; zaten o durumda olanlar atlanır. */
export function setIncludePatches(rows: readonly ImportRow[], indexes: Iterable<number>, include: boolean): PatchList {
  return [...indexes].filter((i) => getRow(rows, i)?.include !== include).map((i) => ({ index: i, patch: { include } }));
}

/** Seçili satırlara şablon atar (`null` şablonu kaldırır). */
export function templatePatches(indexes: Iterable<number>, key: string | null): PatchList {
  return [...indexes].map((i) => ({ index: i, patch: { templateKey: key } }));
}

/** Toplu eylemlerin sayıları: yalnızca dahil satırlar (hariç tutulmuşu yeniden hariç tutmanın anlamı yok). */
export interface BulkCounts {
  errors: number;
  problems: number;
  duplicates: number;
  excluded: number;
}

export function bulkCounts(rows: readonly ImportRow[]): BulkCounts {
  const c: BulkCounts = { errors: 0, problems: 0, duplicates: 0, excluded: 0 };
  for (const r of rows) {
    if (!r.include) {
      c.excluded++;
      continue;
    }
    if (rowSeverity(r) === "error") c.errors++;
    if (isProblem(r)) c.problems++;
    if (isDuplicate(r)) c.duplicates++;
  }
  return c;
}

export const isErrorRow = (r: ImportRow) => rowSeverity(r) === "error";

/** "Satır ekle": dosyada olmayan boş satır (sıra numarası en büyüğün bir fazlası). Metni kullanıcı yazar. */
export function blankRow(rows: readonly ImportRow[]): ImportRow {
  const index = rows.reduce((m, r) => Math.max(m, r.index), -1) + 1;
  return {
    index,
    raw: {},
    include: true,
    textRaw: "",
    text: "",
    segments: [],
    templateInput: null,
    templateKey: null,
    labelSize: null,
    orderNo: null,
    quantity: null,
    product: null,
    kind: "label",
    aiNote: "",
    dismissed: [],
    issues: [],
    dedupeKey: "",
  };
}

/**
 * Bir düzeltmenin metne etkisi (önizleme): düzeltme metni değiştiriyorsa yeni metin, değiştirmiyorsa (yok say,
 * hariç tut, alana git…) bugünkü metin. Düzeltmenin kendisi `resolveFix`'tir; burada yalnız sonucu okunur.
 */
export function fixTextPreview(row: ImportRow, issue: Pick<Issue, "code">, fix: FixAction): string {
  const out = resolveFix(row, issue, fix);
  return out.type === "patch" && out.patch.text !== undefined ? out.patch.text : row.text;
}

// ---------------------------------------------------------------- seçim

export interface SelectMods {
  shift: boolean;
  ctrl: boolean;
}

/**
 * Satır seçimi: Shift ile çapadan bu satıra kadar aralık eklenir; Ctrl ile tek satır eklenir/çıkarılır (çapa olur);
 * düz tıklama yalnızca bu satırı seçer (yalnız o seçiliyse seçimi kaldırır). `order` görünen sıradır.
 */
export function selectRow(prev: ReadonlySet<number>, order: readonly number[], anchor: number | null, index: number, mods: SelectMods): { selected: Set<number>; anchor: number | null } {
  const next = new Set(prev);
  if (mods.shift && anchor !== null) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(index);
    if (a >= 0 && b >= 0) for (const i of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(i);
    return { selected: next, anchor };
  }
  if (mods.ctrl) {
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return { selected: next, anchor: index };
  }
  if (next.size === 1 && next.has(index)) next.clear();
  else {
    next.clear();
    next.add(index);
  }
  return { selected: next, anchor: index };
}

/** Görünen satırların seçim durumu (başlıktaki onay kutusu). */
export function visibleSelection(selected: ReadonlySet<number>, visible: readonly number[]): boolean | "mixed" {
  if (!visible.length) return false;
  const n = visible.filter((i) => selected.has(i)).length;
  return n === 0 ? false : n === visible.length ? true : "mixed";
}

/** Görünen satırların hepsini seçer ya da seçimden çıkarır (görünmeyen seçimler korunur). */
export function selectVisible(selected: ReadonlySet<number>, visible: readonly number[], on: boolean): Set<number> {
  const next = new Set(selected);
  for (const i of visible) {
    if (on) next.add(i);
    else next.delete(i);
  }
  return next;
}

// ---------------------------------------------------------------- etkin satır ve klavye

/** Oklarla bir satır aşağı/yukarı (görünen sırada, uçlarda durur). Etkin satır yoksa ilk satır. */
export function stepActive(visible: readonly number[], active: number | null, dir: 1 | -1): number | null {
  if (!visible.length) return null;
  const pos = active === null ? -1 : visible.indexOf(active);
  const next = dir === 1 ? Math.min(visible.length - 1, pos + 1) : Math.max(0, pos - 1);
  return visible[next] ?? null;
}

/** Sonraki/önceki sorunlu satırın sıra numarası (sarar); yoksa null. */
export function problemStep(visible: readonly ImportRow[], active: number | null, dir: 1 | -1): number | null {
  const pos = active === null ? -1 : visible.findIndex((r) => r.index === active);
  const p = nextProblemPos(visible, pos, dir);
  return p === null ? null : (visible[p]?.index ?? null);
}

export type DeskKey = "commit" | "close" | "down" | "up" | "edit" | "toggle" | "next-problem" | "prev-problem";

export interface DeskKeyInput {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Yazı alanında. */
  typing: boolean;
  /** Menü, pencere ya da liste katmanında. */
  inLayer: boolean;
  /** Düğme, bağlantı ya da açılır başlıkta (Enter/Space onların işi). */
  onControl: boolean;
  /** Bir satırın metni düzenleniyor ya da şablon seçici açık. */
  busy: boolean;
}

/**
 * Eski masanın tuş kararı: Ctrl+Enter içe aktar ve üret, Esc kapat, ↑/↓ satır, Enter metni düzenle, Space dahil
 * et/çıkar, N/Shift N sonraki/önceki sorun. Yazarken, katmanda ve düzenleme sürerken hiçbiri.
 */
export function deskKey(k: DeskKeyInput): DeskKey | null {
  if (k.typing || k.inLayer || k.busy) return null;
  const key = k.key.toLowerCase();
  if (k.ctrl && key === "enter") return "commit";
  if (k.ctrl || k.alt) return null;
  if (key === "escape") return "close";
  if (key === "arrowdown") return "down";
  if (key === "arrowup") return "up";
  if (k.onControl) return null;
  if (key === "enter") return "edit";
  if (key === " ") return "toggle";
  if (key === "n") return k.shift ? "prev-problem" : "next-problem";
  return null;
}

// ---------------------------------------------------------------- doğrulama sürümleri (yarış koruması)

/** Düzenlenen satırların sürümünü artırır. */
export function bumpRevs(revs: Map<number, number>, indexes: Iterable<number>): void {
  for (const i of indexes) revs.set(i, (revs.get(i) ?? 0) + 1);
}

/** Gönderildiği sürümde kalan (yanıt beklerken yeniden düzenlenmemiş) satırlar: bekleyen işaretleri kalkar. */
export function settledIndexes(sent: ReadonlyMap<number, number>, revs: ReadonlyMap<number, number>): number[] {
  return [...sent].filter(([i, rev]) => (revs.get(i) ?? 0) === rev).map(([i]) => i);
}

// ---------------------------------------------------------------- gönderim gövdeleri

export function validateBody(languageId: string | null | undefined, rows: readonly ImportRow[], indexes: readonly number[]): ImportValidateRequest {
  const inputs = indexes.map((i) => getRow(rows, i)).filter((r): r is ImportRow => !!r).map(rowToInput);
  return { languageId: languageId ?? undefined, rows: inputs };
}

export function previewBody(fileName: string, content: string, languageId: string | null | undefined, mapping?: Partial<FieldMap>) {
  return { fileName, content, languageId: languageId ?? undefined, mapping };
}

/** "İçe aktar" ve "İçe aktar ve üret" gövdesi: bütün satırlar (hariç tutulanlar dahil; sunucu yeniden doğrular). */
export function commitBody(preview: Pick<ImportPreviewResponse, "fileName" | "languageId" | "mapping">, batchName: string, rows: readonly ImportRow[], generate: boolean): ImportCommitRequest {
  return {
    fileName: preview.fileName,
    languageId: preview.languageId,
    batchName: batchName.trim() || undefined,
    mapping: preview.mapping,
    rows: rows.map(rowToInput),
    generate,
  };
}

// ---------------------------------------------------------------- alan eşlemesi

export interface FieldState {
  field: ImportField;
  /** Eşlenen JSON alanı (null = yok). */
  current: string | null;
  source: ImportPreviewResponse["mappingSource"][ImportField];
  /** Metin alanı eşlenmemiş: satırlar boş görünür. */
  missing: boolean;
}

export function fieldStates(preview: Pick<ImportPreviewResponse, "mapping" | "mappingSource">): FieldState[] {
  return FIELD_ORDER.map((field) => {
    const current = preview.mapping[field];
    return { field, current, source: preview.mappingSource[field] ?? null, missing: field === "text" && current === null };
  });
}

/** Kapalı grubun özeti için: eşlenen alan sayısı ve metin eksik mi. */
export function mappingSummary(preview: Pick<ImportPreviewResponse, "mapping" | "mappingSource">): { mapped: number; textMissing: boolean } {
  const states = fieldStates(preview);
  return { mapped: states.filter((s) => s.current !== null).length, textMissing: states.some((s) => s.missing) };
}

/** Yeni eşleme: verilen alan değişir, gerisi aynı kalır (sunucu verilenleri tahminin önüne koyar). */
export function nextMapping(mapping: FieldMap, field: ImportField, value: string | null): FieldMap {
  return { ...mapping, [field]: value };
}
