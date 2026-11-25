import {
  HARD_ROW_FLAGS,
  MAPPING_FIELD_LABELS,
  ROW_FLAG_LABELS,
  type FieldSource,
  type MappingField,
  type RowFlagCode,
} from "@deciship/core";
import { i18n } from "../../i18n";
import type { ColumnMapping, InvoicePreview } from "../../api/types";

export type Step = 1 | 2 | 3;

export { acceptList, isBlockedPdf, pdfReadState, retryFresh, type PdfReadState } from "./acceptList";
export const MAX_MB = 25;

/** Seçilen sütunun dosyada kaç satırda dolu olduğu (önizleme `columnFill` yoksa undefined). */
export function fillOf(
  preview: InvoicePreview | null,
  header?: string,
): number | undefined {
  if (!preview || preview.format === "pdf" || !preview.columnFill || !header)
    return undefined;
  const i = preview.headers.indexOf(header);
  return i < 0 ? undefined : preview.columnFill[i];
}

export function emptyMapping(): ColumnMapping {
  return {
    surchargeColumns: [],
    amountsIncludeVat: false,
    vatPct: 20,
    desiAsWeight: false,
  };
}

// ---------------- Okuma kontrolü (SPEC §11) ----------------
export const sourceLabel = (s: FieldSource): string => i18n.t(`invoiceUpload:source.${s}`);
export const flagText = (c: string): string =>
  i18n.t(`invoiceUpload:flag.${c}`, { defaultValue: ROW_FLAG_LABELS[c as RowFlagCode] ?? c });
/** Eşleme alanının görünen adı (çekirdekteki Türkçe etiket yalnız yedek). */
export const fieldLabel = (k: MappingField): string =>
  i18n.t(`invoiceUpload:field.${k}`, { defaultValue: MAPPING_FIELD_LABELS[k] });
export const isHard = (c: string) => HARD_ROW_FLAGS.includes(c as RowFlagCode);

/** İçe aktarma bu süreden uzun sürerse ekran beklemeyi açıklar (ms). */
export const SLOW_IMPORT_MS = 3000;

/** Sunucunun tahmin ettiği gün; tarih alanı yalnız YYYY-MM-DD gösterir, geçersizse boş kalır. */
export function guessedDay(value: string | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}
