import type { ImportField, ImportPreviewResponse, IssueCode } from "@tagpress/domain";
import { i18n } from "../../i18n/index.ts";
import type { RowFilter } from "./mantik/rows.ts";

/**
 * İçe aktarma masasının sözlük metinleri (`importDesk` ad alanı). Saf mantık dosyaları (`mantik/rows.ts`)
 * metni buradan alır; böylece eski ve yeni ekran aynı sözlüğü okur.
 */

/** Sorun kodunun kısa adı (rozet metni); sözlükte yoksa null. */
export function issueShortText(code: IssueCode): string | null {
  const key = `importDesk:issueShort.${code}`;
  return i18n.exists(key) ? i18n.t(key) : null;
}

/** Satır süzgecinin adı ("Hepsi", "Yalnızca sorunlu"…). */
export function filterLabel(f: RowFilter): string {
  return i18n.t(`importDesk:filters.${f}`);
}

/** Masanın her soruna eklediği düzeltmelerin adı ("Yok say", "Satırı hariç tut"). */
export function deskFixLabel(kind: "dismiss" | "skip"): string {
  return i18n.t(`importDesk:fix.${kind}`);
}

/** Eşleme alanının adı ("Metin", "Sipariş no"…). */
export function fieldLabel(f: ImportField): string {
  return i18n.t(`importDesk:fields.${f}`);
}

/** Dosya biçiminin adı ("JSON dizisi"…). */
export function formatLabel(f: ImportPreviewResponse["format"]): string {
  return i18n.t(`importDesk:formats.${f}`);
}
