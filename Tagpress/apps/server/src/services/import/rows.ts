import {
  type FieldMap,
  type ImportRow,
  type ImportRowInput,
  ImportRowInputSchema,
  type Issue,
  type IssueCode,
  type LabelSize,
  type Profile,
  type StickerSheet,
  canonicalText,
  fixMsg,
  issueMsg,
  normalizeText,
} from "@tagpress/domain";
import type { FontCoverage, TemplateResolver } from "../../ports.ts";
import { fold } from "../../util/text.ts";
import { type RawRecord, fieldValue } from "./parse.ts";
import { segmentsOf, textIssues } from "./text-checks.ts";

export const STICKER_PREFIX = "sticker-";
export const stickerKey = (sheetId: string) => STICKER_PREFIX + sheetId;
export const stickerSheetId = (key: string | null | undefined) => (key?.startsWith(STICKER_PREFIX) && key.length > STICKER_PREFIX.length ? key.slice(STICKER_PREFIX.length) : null);

/** Bir satırı doğrulamak için gereken her şey (dil başına bir kez kurulur). */
export interface RowContext {
  languageId: string;
  profile: Profile;
  /** Dilin şablon anahtarları (dosyası eksik olanlar dahil). */
  templateKeys: string[];
  /** Dosyası eksik şablonlar. */
  missingFiles: Set<string>;
  resolver: TemplateResolver;
  coverage: FontCoverage;
  fontsDir: string;
  sharedFontsDir: string;
}

export const sheetsOf = (p: Profile): StickerSheet[] => (p.stickers.enabled ? p.stickers.sheets : []);

/** Ürün adına göre sticker sayfası: anahtar kelimesi geçen ilk sayfa; yoksa anahtar kelimesiz ilk sayfa; o da yoksa ilk sayfa. */
export function pickStickerSheet(sheets: StickerSheet[], product: string | null): StickerSheet | null {
  if (!sheets.length) return null;
  const p = fold(product);
  const hit = p ? sheets.find((s) => s.productKeywords.some((k) => fold(k) && p.includes(fold(k)))) : undefined;
  return hit ?? sheets.find((s) => s.productKeywords.length === 0) ?? sheets[0]!;
}

/** Ayrı boyut alanının değeri ("5,2 cm") → profil boyutu; tanınmazsa ham değer (size-unknown için). */
function sizeFromField(value: string | null, sizes: readonly LabelSize[]): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\s*cm$/, "").replace(",", ".");
  const hit = sizes.find((s) => s.id === v || String(s.cm) === v || String(s.framePx) === v);
  return hit ? hit.id : value.trim();
}

/** Dosyadaki ham kayıttan inceleme satırı (taslak; sorunlar `validateRows` ile). */
export function rowFromRecord(raw: RawRecord, index: number, map: FieldMap, ctx: RowContext): ImportRowInput {
  const textRaw = fieldValue(raw, map.text) ?? "";
  const norm = normalizeText(textRaw);
  const templateInput = fieldValue(raw, map.template);
  const sizes = ctx.profile.output.sizes;
  const resolved = templateInput ? ctx.resolver.resolve(templateInput, { keys: ctx.templateKeys, sizes }) : null;
  const product = fieldValue(raw, map.product);
  const st = ctx.profile.stickers;
  const isSticker = st.enabled && (st.detect === "product-field" ? !!map.product && Object.hasOwn(raw, map.product) : !templateInput);
  const sheet = isSticker ? pickStickerSheet(st.sheets, product) : null;
  const sizeField = sizeFromField(fieldValue(raw, map.size), sizes);
  return {
    index,
    raw,
    include: true,
    textRaw,
    text: norm.text,
    templateInput,
    templateKey: isSticker ? (sheet ? stickerKey(sheet.id) : null) : (resolved?.key ?? null),
    labelSize: isSticker ? null : (sizeField ?? resolved?.size ?? resolved?.unknownSize ?? null),
    orderNo: fieldValue(raw, map.orderNo)?.trim() ?? null,
    quantity: quantityInput(map.quantity ? raw[map.quantity] : null),
    product,
    kind: isSticker ? "sticker" : "label",
    aiNote: "",
    dismissed: [],
  };
}

function quantityInput(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Adet: pozitif tam sayı. Metin olarak "3" kabul; "3 adet" de. */
export function parseQuantity(q: unknown): { value: number | null; invalid: string | null } {
  if (q === null || q === undefined || (typeof q === "string" && !q.trim())) return { value: null, invalid: null };
  const s = String(q).trim().replace(/\s*(adet|pcs|pieces|x)$/i, "");
  const n = Number(s);
  if (Number.isInteger(n) && n > 0) return { value: n, invalid: null };
  return { value: null, invalid: String(q) };
}

export function dedupeKey(r: { orderNo: string | null; templateKey: string | null; labelSize: string | null; text: string }): string {
  return [r.orderNo ?? "", r.templateKey ?? "", r.labelSize ?? "", canonicalText(r.text).toLocaleLowerCase("tr")].join("|");
}

/** Tekrar anahtarının sipariş numarası dışındaki kısmı: şablon | boyut | metin. */
export function dedupeRest(key: string): string {
  return key.slice(key.indexOf("|") + 1);
}
export function dedupeOrder(key: string): string {
  return key.slice(0, key.indexOf("|"));
}

/** Tek satırın alan sorunları (tekrarlar hariç; onlar toplu hesaplanır). */
export function rowIssues(r: ReturnType<typeof ImportRowInputSchema.parse>, ctx: RowContext): Issue[] {
  const out: Issue[] = [];
  const add = (i: Issue) => out.push(i);
  const coverage = r.text.trim()
    ? ctx.coverage.check(r.text, { languageId: ctx.languageId, profile: ctx.profile, fontsDir: ctx.fontsDir, sharedFontsDir: ctx.sharedFontsDir })
    : { fallback: [], missing: [] };
  out.push(...textIssues(r.text, ctx.profile, coverage));

  if (r.textRaw) {
    const norm = normalizeText(r.textRaw);
    if (norm.outerQuotesRemoved && norm.text === r.text) {
      add({
        ...issueMsg("text-outer-quotes-removed"),
        severity: "info",
        field: "text",
        fixes: [fixMsg("restore-quotes", { value: r.textRaw.trim() })],
      });
    }
  }

  const sheets = sheetsOf(ctx.profile);
  const sheetId = stickerSheetId(r.templateKey);
  const kind = r.kind ?? (sheetId ? "sticker" : "label");
  const templateChoices = (keys: string[]) => keys.map((k) => fixMsg("choose-template-key", { value: k, params: { key: k } }));
  if (kind === "sticker") {
    add({ ...issueMsg("sticker-detected"), severity: "info", field: "templateKey", fixes: [] });
    if (!sheets.length || (sheetId && !sheets.some((s) => s.id === sheetId)) || (!sheetId && !r.templateKey)) {
      add({
        ...issueMsg(sheets.length ? "sticker-sheet-missing" : "sticker-sheet-missing-none"),
        severity: "error",
        field: "templateKey",
        fixes: templateChoices(sheets.map((s) => stickerKey(s.id))),
      });
    }
  } else if (!r.templateKey) {
    add({
      ...(r.templateInput ? issueMsg("template-missing-input", { input: r.templateInput }) : issueMsg("template-missing")),
      severity: "error",
      field: "templateKey",
      fixes: [fixMsg("choose-template")],
    });
  } else if (sheetId) {
    if (!sheets.some((s) => s.id === sheetId)) {
      add({ ...issueMsg("sticker-sheet-missing-id", { sheet: sheetId }), severity: "error", field: "templateKey", fixes: templateChoices(sheets.map((s) => stickerKey(s.id))) });
    }
  } else if (!ctx.templateKeys.includes(r.templateKey)) {
    const sugg = ctx.resolver.resolve(r.templateKey, { keys: ctx.templateKeys, sizes: [] }).suggestions;
    add({
      ...(sugg.length ? issueMsg("template-unknown-suggest", { key: r.templateKey, suggestions: sugg.join(", ") }) : issueMsg("template-unknown", { key: r.templateKey })),
      severity: "error",
      field: "templateKey",
      fixes: [...templateChoices(sugg), fixMsg("upload-template")],
    });
  } else if (ctx.missingFiles.has(r.templateKey)) {
    add({ ...issueMsg("template-unknown-file", { key: r.templateKey }), severity: "error", field: "templateKey", fixes: [fixMsg("open-template", { value: r.templateKey })] });
  }

  const sizes = ctx.profile.output.sizes;
  if (kind === "label" && r.labelSize && !sizes.some((s) => s.id === r.labelSize)) {
    add({
      ...issueMsg("size-unknown", { size: r.labelSize, defaultSize: ctx.profile.output.defaultSize }),
      severity: "warning",
      field: "labelSize",
      fixes: sizes.map((s) => fixMsg("set-size", { value: s.id, params: { cm: s.cm } })),
    });
  }

  const q = parseQuantity(r.quantity);
  if (q.invalid !== null) {
    add({ ...issueMsg("quantity-invalid", { value: q.invalid }), severity: "error", field: "quantity", fixes: [fixMsg("fix-quantity")] });
  } else if (q.value === null) {
    add({ ...issueMsg("quantity-missing"), severity: "warning", field: "quantity", fixes: [fixMsg("set-quantity", { value: "1" })] });
  }
  if (!r.orderNo) add({ ...issueMsg("order-missing"), severity: "warning", field: "orderNo", fixes: [fixMsg("set-order")] });
  return out;
}

/** Yalnızca uyarı ve bilgi notları yok sayılabilir; hatalar her zaman görünür. */
export function applyDismissed(issues: Issue[], dismissed: readonly IssueCode[]): Issue[] {
  if (!dismissed.length) return issues;
  return issues.filter((i) => i.severity === "error" || !dismissed.includes(i.code));
}

export interface ExistingDuplicate {
  dedupeKey: string;
  jobId: string;
  batchName: string;
  createdAt: string;
}

/**
 * Satırları doğrular: alan sorunları + dosya içi tekrar + mevcut işlerle tekrar.
 * `fresh`: dosyadan ilk kez geliyor → tekrarlar ve metinsizler varsayılan olarak hariç.
 */
export function validateRows(
  inputs: ImportRowInput[],
  ctx: RowContext,
  existing: (keys: string[]) => ExistingDuplicate[],
  fresh: boolean,
  /** Var olan işlerde (sipariş numarasından bağımsız) aynı şablon + boyut + metin; `rests` = `dedupeRest` anahtarları. */
  similar?: (rests: string[]) => ExistingDuplicate[],
): ImportRow[] {
  const parsed = inputs.map((i) => ImportRowInputSchema.parse(i));
  const keys = parsed.map((r) => dedupeKey(r));
  const dupMap = new Map<string, ExistingDuplicate>();
  for (const d of existing([...new Set(keys)])) if (!dupMap.has(d.dedupeKey)) dupMap.set(d.dedupeKey, d);
  const firstSeen = new Map<string, number>();
  const similarMap = new Map<string, ExistingDuplicate[]>();
  if (similar) {
    for (const d of similar([...new Set(keys.map(dedupeRest))])) {
      const rest = dedupeRest(d.dedupeKey);
      similarMap.set(rest, [...(similarMap.get(rest) ?? []), d]);
    }
  }
  /** Dosyada şimdiye dek görülen (şablon + boyut + metin) → sipariş numaraları. */
  const seenRest = new Map<string, Array<{ order: string; index: number }>>();
  return parsed.map((r, i) => {
    const key = keys[i]!;
    const issues = rowIssues(r, ctx);
    let duplicate = false;
    const first = firstSeen.get(key);
    if (first === undefined) firstSeen.set(key, r.index);
    else if (r.text.trim()) {
      duplicate = true;
      issues.push({ ...issueMsg("duplicate-in-file", { row: first + 1 }), severity: "warning", field: String(first), fixes: [fixMsg("skip")] });
    }
    const ex = dupMap.get(key);
    if (ex && r.text.trim()) {
      duplicate = true;
      issues.push({
        ...issueMsg("duplicate-existing", { batch: ex.batchName, date: ex.createdAt.slice(0, 10) }),
        severity: "warning",
        field: ex.jobId,
        fixes: [fixMsg("skip")],
      });
    }
    // Aynı metin + şablon ama başka sipariş numarası: bilgi notu (tekrar değil, içe aktarmayı engellemez).
    const rest = dedupeRest(key);
    const order = dedupeOrder(key);
    if (r.text.trim() && order) {
      const inFile = seenRest.get(rest)?.find((s) => s.order !== order);
      const inDb = similarMap.get(rest)?.find((d) => dedupeOrder(d.dedupeKey) && dedupeOrder(d.dedupeKey) !== order);
      if (!duplicate && (inFile || inDb)) {
        const other = inFile ? inFile.order : dedupeOrder(inDb!.dedupeKey);
        issues.push({
          ...(inFile ? issueMsg("duplicate-similar-file", { order: other, row: inFile.index + 1 }) : issueMsg("duplicate-similar-batch", { order: other, batch: inDb!.batchName })),
          severity: "info",
          field: inFile ? String(inFile.index) : inDb!.jobId,
          fixes: [],
        });
      }
      seenRest.set(rest, [...(seenRest.get(rest) ?? []), { order, index: r.index }]);
    }
    const q = parseQuantity(r.quantity);
    const kind = r.kind ?? (stickerSheetId(r.templateKey) ? "sticker" : "label");
    return {
      index: r.index,
      raw: r.raw,
      include: fresh ? !duplicate && !!r.text.trim() : r.include,
      textRaw: r.textRaw,
      text: r.text,
      segments: segmentsOf(r.text),
      templateInput: r.templateInput,
      templateKey: r.templateKey,
      labelSize: r.labelSize,
      orderNo: r.orderNo,
      quantity: q.invalid ?? q.value,
      product: r.product,
      kind,
      aiNote: r.aiNote,
      dismissed: r.dismissed,
      issues: applyDismissed(issues, r.dismissed),
      dedupeKey: key,
    };
  });
}
