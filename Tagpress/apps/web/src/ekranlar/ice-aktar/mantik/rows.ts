import {
  type FixAction,
  type ImportRow,
  type ImportRowInput,
  type Issue,
  type IssueCode,
  type IssueSeverity,
  normalizeText,
  styledUnicodeChars,
  toPlainLetters,
} from "@tagpress/domain";
import { deskFixLabel, filterLabel, issueShortText } from "../metin.ts";

/**
 * İçe aktarma masasının saf yardımcıları (arayüzden bağımsız, birim testli): satır durumu özeti, süzgeç,
 * sorun sıralama, düzeltme çözümleme, doğrulama yanıtını birleştirme.
 * Hiçbir işlev metni kendiliğinden değiştirmez; yalnızca kullanıcının seçtiği düzeltmeyi bir yama olarak döndürür.
 * Görünen metinler `importDesk` sözlüğünde (`ekranlar/ice-aktar/metin.ts`); etkin dilde okunur.
 */

// ---------------------------------------------------------------- sorunlar

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Ağırdan hafife (hata, uyarı, bilgi); eşitlikte sunucu sırası korunur. */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  return issues.map((issue, i) => ({ issue, i })).sort((a, b) => SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || a.i - b.i).map((x) => x.issue);
}

export function rowSeverity(row: Pick<ImportRow, "issues">): IssueSeverity | null {
  if (row.issues.some((i) => i.severity === "error")) return "error";
  if (row.issues.some((i) => i.severity === "warning")) return "warning";
  if (row.issues.length) return "info";
  return null;
}

/** Kullanıcının bakması gereken satır: hata ya da uyarı var (bilgi notları sorun sayılmaz). */
export function isProblem(row: Pick<ImportRow, "issues">): boolean {
  const s = rowSeverity(row);
  return s === "error" || s === "warning";
}

export function isDuplicate(row: Pick<ImportRow, "issues">): boolean {
  return row.issues.some((i) => i.code === "duplicate-in-file" || i.code === "duplicate-existing");
}

/** Kısa adı olan sorun kodları (adlar `importDesk:issueShort.<kod>`). */
export const SHORT_CODES: readonly IssueCode[] = [
  "text-missing",
  "text-very-long",
  "text-word-too-long",
  "text-outer-quotes-removed",
  "text-unicode-styled",
  "text-unprintable",
  "text-fallback-font",
  "text-suspicious",
  "template-missing",
  "template-unknown",
  "size-unknown",
  "quantity-missing",
  "quantity-invalid",
  "order-missing",
  "duplicate-in-file",
  "duplicate-existing",
  "duplicate-similar",
  "sticker-detected",
  "sticker-sheet-missing",
];

/** Sorun kodlarının kısa adları (rozet metni), etkin dilde. Okundukça sözlükten gelir. */
export const ISSUE_SHORT: Partial<Record<IssueCode, string>> = Object.defineProperties(
  {},
  Object.fromEntries(SHORT_CODES.map((code) => [code, { enumerable: true, get: () => issueShortText(code) ?? code }])),
);

export function issueShort(issue: Pick<Issue, "code" | "message">): string {
  return ISSUE_SHORT[issue.code] ?? (issue.message.length > 28 ? `${issue.message.slice(0, 27)}…` : issue.message);
}

// ---------------------------------------------------------------- özet ve süzgeç

export interface RowTally {
  total: number;
  included: number;
  excluded: number;
  /** Hatalı satır sayısı (hariç tutulanlar dahil). */
  errors: number;
  warnings: number;
  duplicates: number;
  stickers: number;
  /** İçe aktarılacak: dahil ve metni dolu. */
  importable: number;
  /** İçe aktarılacak ama hatalı olduğu için üretime girmeyecek. */
  blocked: number;
}

export function hasText(row: Pick<ImportRow, "text">): boolean {
  return row.text.trim() !== "";
}

export function tallyRows(rows: readonly ImportRow[]): RowTally {
  const t: RowTally = { total: rows.length, included: 0, excluded: 0, errors: 0, warnings: 0, duplicates: 0, stickers: 0, importable: 0, blocked: 0 };
  for (const r of rows) {
    const sev = rowSeverity(r);
    if (r.include) t.included++;
    else t.excluded++;
    if (sev === "error") t.errors++;
    else if (sev === "warning") t.warnings++;
    if (isDuplicate(r)) t.duplicates++;
    if (r.kind === "sticker") t.stickers++;
    if (r.include && hasText(r)) {
      t.importable++;
      if (sev === "error") t.blocked++;
    }
  }
  return t;
}

export type RowFilter = "all" | "issues" | "duplicates" | "excluded";

const FILTER_IDS: readonly RowFilter[] = ["all", "issues", "duplicates", "excluded"];

/** Süzgeçler; `label` okundukça etkin dilde gelir. */
export const ROW_FILTERS: ReadonlyArray<{ readonly id: RowFilter; readonly label: string }> = FILTER_IDS.map((id) => ({
  id,
  get label() {
    return filterLabel(id);
  },
}));

export function matchesRowFilter(row: ImportRow, f: RowFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "issues":
      return isProblem(row);
    case "duplicates":
      return isDuplicate(row);
    case "excluded":
      return !row.include;
  }
}

export function filterRows(rows: readonly ImportRow[], f: RowFilter): ImportRow[] {
  return f === "all" ? [...rows] : rows.filter((r) => matchesRowFilter(r, f));
}

export function filterCounts(rows: readonly ImportRow[]): Record<RowFilter, number> {
  const c: Record<RowFilter, number> = { all: rows.length, issues: 0, duplicates: 0, excluded: 0 };
  for (const r of rows) {
    if (isProblem(r)) c.issues++;
    if (isDuplicate(r)) c.duplicates++;
    if (!r.include) c.excluded++;
  }
  return c;
}

/**
 * Görünen sıradaki sonraki/önceki sorunlu satırın konumu (sona gelince başa sarar). Sorunlu satır yoksa null.
 * `from`: şimdiki konum (-1 = henüz yok).
 */
export function nextProblemPos(visible: readonly ImportRow[], from: number, dir: 1 | -1): number | null {
  const n = visible.length;
  if (!n) return null;
  for (let step = 1; step <= n; step++) {
    const pos = (((from + dir * step) % n) + n) % n;
    const r = visible[pos];
    if (r && isProblem(r)) return pos;
  }
  return null;
}

// ---------------------------------------------------------------- düzenleme

/** Kullanıcının değiştirebildiği satır alanları. */
export type RowPatch = Partial<Pick<ImportRow, "include" | "text" | "templateKey" | "labelSize" | "orderNo" | "quantity" | "product" | "kind" | "dismissed">>;

/** `include` dışındaki her değişiklik sorunları etkileyebilir: yeniden doğrulanır. */
export function patchNeedsValidation(patch: RowPatch): boolean {
  return Object.keys(patch).some((k) => k !== "include");
}

export function applyPatch(row: ImportRow, patch: RowPatch): ImportRow {
  return { ...row, ...patch };
}

/** Sunucuya geri gönderilen biçim (hesaplanan alanlar çıkarılır). */
export function rowToInput(row: ImportRow): ImportRowInput {
  return {
    index: row.index,
    raw: row.raw,
    include: row.include,
    textRaw: row.textRaw,
    text: row.text,
    templateInput: row.templateInput,
    templateKey: row.templateKey,
    labelSize: row.labelSize,
    orderNo: row.orderNo,
    quantity: row.quantity,
    product: row.product,
    kind: row.kind,
    aiNote: row.aiNote,
    dismissed: row.dismissed,
  };
}

/** Adet alanı: boş → null, tam sayı → sayı, başka her şey yazıldığı gibi kalır (sunucu "adet geçersiz" der). */
export function parseQuantity(text: string): number | string | null {
  const t = text.trim();
  if (t === "") return null;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

export function quantityText(q: ImportRow["quantity"]): string {
  return q === null || q === undefined ? "" : String(q);
}

/** Metin, ham dosya metninin normalleştirilmiş hâlinden farklı mı (kullanıcı düzenlemiş)? */
export function isTextEdited(row: Pick<ImportRow, "text" | "textRaw">): boolean {
  return row.text !== normalizeText(row.textRaw).text;
}

/** Dış tırnak kaldırıldı ve metin henüz düzenlenmedi mi? */
export function quotesStripped(row: Pick<ImportRow, "text" | "textRaw">): boolean {
  return !isTextEdited(row) && normalizeText(row.textRaw).outerQuotesRemoved;
}

/** Ekranda gösterilecek satır ipuçları (kullanıcı düzenlediyse güncel metinden). */
export function displaySegments(row: Pick<ImportRow, "text">): string[] {
  return normalizeText(row.text).segments;
}

/** Özel biçimli harf içeren satırlar için "düz harfe çevir" yamaları. Yalnızca o harfler değişir. */
export function plainLetterPatches(rows: readonly ImportRow[]): Array<{ index: number; patch: RowPatch }> {
  const out: Array<{ index: number; patch: RowPatch }> = [];
  for (const r of rows) {
    if (styledUnicodeChars(r.text).length) out.push({ index: r.index, patch: { text: toPlainLetters(r.text) } });
  }
  return out;
}

// ---------------------------------------------------------------- düzeltme eylemleri

export type FixField = "quantity" | "orderNo" | "labelSize";

export type FixOutcome =
  | { type: "patch"; patch: RowPatch }
  | { type: "focus"; field: FixField }
  | { type: "edit-text" }
  | { type: "pick-template" }
  | { type: "open-template"; key: string }
  | { type: "none" };

/** Bir düzeltmenin ne yapacağı. Değer verilmişse yama, verilmemişse ilgili alana odak/seçici. */
export function resolveFix(row: ImportRow, issue: Pick<Issue, "code">, fix: FixAction): FixOutcome {
  switch (fix.kind) {
    case "convert-unicode":
      return { type: "patch", patch: { text: fix.value ?? toPlainLetters(row.text) } };
    case "edit-text":
      return fix.value !== undefined ? { type: "patch", patch: { text: fix.value } } : { type: "edit-text" };
    case "choose-template":
      return fix.value ? { type: "patch", patch: { templateKey: fix.value } } : { type: "pick-template" };
    case "set-size":
      return fix.value ? { type: "patch", patch: { labelSize: fix.value } } : { type: "focus", field: "labelSize" };
    case "set-quantity":
      return fix.value !== undefined ? { type: "patch", patch: { quantity: parseQuantity(fix.value) } } : { type: "focus", field: "quantity" };
    case "set-order":
      return fix.value !== undefined ? { type: "patch", patch: { orderNo: fix.value } } : { type: "focus", field: "orderNo" };
    case "skip":
      return { type: "patch", patch: { include: false } };
    case "dismiss":
      return { type: "patch", patch: { dismissed: row.dismissed.includes(issue.code) ? row.dismissed : [...row.dismissed, issue.code] } };
    case "open-template":
      return fix.value ? { type: "open-template", key: fix.value } : { type: "none" };
    default:
      return { type: "none" };
  }
}

/**
 * Bir sorunun masada gösterilecek düzeltmeleri: sunucunun önerileri (masada anlamsız olanlar — yeniden üret, revizyon —
 * çıkarılır). Hata olmayan sorunlara "yok say", dahil satırlara "hariç tut" her zaman eklenir.
 */
export function fixesFor(row: Pick<ImportRow, "include">, issue: Issue): FixAction[] {
  const fixes = issue.fixes.filter((f) => f.kind !== "regenerate" && f.kind !== "revise" && !(f.kind === "open-template" && !f.value));
  if (issue.severity !== "error" && !fixes.some((f) => f.kind === "dismiss")) fixes.push({ kind: "dismiss", label: deskFixLabel("dismiss") });
  if (row.include && !fixes.some((f) => f.kind === "skip")) fixes.push({ kind: "skip", label: deskFixLabel("skip") });
  return fixes;
}

/** Şablon seçicisinde üstte gösterilecek öneriler: satırın `choose-template` önerileri, tekrarsız. */
export function templateSuggestions(row: Pick<ImportRow, "issues">): string[] {
  const out: string[] = [];
  for (const i of row.issues) for (const f of i.fixes) if (f.kind === "choose-template" && f.value && !out.includes(f.value)) out.push(f.value);
  return out;
}

// ---------------------------------------------------------------- doğrulama yanıtını birleştirme

/**
 * Sunucudan dönen satırları şimdiki satırlara yerleştirir. Yarış koruması: her satırın bir düzenleme sürümü (`rev`) vardır;
 * istek gönderilirken kaydedilen sürüm şimdikiyle aynı değilse (kullanıcı yanıt gelmeden tekrar düzenledi) o satırın yanıtı atılır.
 * Yalnızca sunucunun hesapladığı alanlar alınır; kullanıcının yazdığı metin, sipariş no ve dahil et durumu olduğu gibi kalır.
 */
export function mergeValidated(
  current: readonly ImportRow[],
  returned: readonly ImportRow[],
  sentRevs: ReadonlyMap<number, number>,
  currentRevs: ReadonlyMap<number, number>,
): ImportRow[] {
  const byIndex = new Map(returned.map((r) => [r.index, r]));
  return current.map((row) => {
    const fresh = byIndex.get(row.index);
    if (!fresh) return row;
    if ((sentRevs.get(row.index) ?? 0) !== (currentRevs.get(row.index) ?? 0)) return row;
    return {
      ...row,
      issues: fresh.issues,
      segments: fresh.segments,
      dedupeKey: fresh.dedupeKey,
      kind: fresh.kind,
      templateKey: fresh.templateKey,
      labelSize: fresh.labelSize,
      quantity: fresh.quantity,
    };
  });
}
