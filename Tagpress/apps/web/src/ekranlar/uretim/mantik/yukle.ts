import type { BatchSummary, ImportCommitRequest, ImportPreviewResponse } from "@tagpress/domain";
import { baseName, commitBody, PASTED_FILE_NAME } from "../../ice-aktar/mantik/desk.ts";
import { hasText, isDuplicate } from "../../ice-aktar/mantik/rows.ts";

/**
 * Üretim'in alım alanı: dosya (ya da yapıştırılan metin) doğrudan "Üretilmeyi bekleyenler"e düşer, üretim başlamaz.
 * İçe aktarma masası (tablo, alan eşleme) yalnız ⋯ menüsündeki "Ayrıntılı içe aktar"da.
 */

export interface UploadSource {
  file: File;
}

/** Yapıştırılan metin bir dosya gibi gönderilir (sunucunun varsayılan adıyla). */
export function pastedSource(text: string): UploadSource {
  return { file: new File([text], PASTED_FILE_NAME, { type: "application/json" }) };
}

/** Yapıştırılan metin sipariş verisine benziyor mu (JSON dizi ya da nesne; NDJSON da `{` ile başlar). */
export function looksLikeOrders(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("[") || s.startsWith("{");
}

export type UploadPlan =
  | { kind: "no-text" }
  | { kind: "nothing"; duplicates: number; blank: number }
  | { kind: "commit"; body: ImportCommitRequest; take: number; duplicates: number; blank: number };

/**
 * Önizlemeden kayda: metin alanı bulunamadıysa masa gerekir (`no-text`). Satırlar sunucunun önizlemede verdiği gibi
 * alınır: sorunlu satırlar da iş olur (kartta uyarı), tekrarlar (dosyada ya da listede) ve metinsizler alınmaz.
 * Kayıt üretimsizdir (`generate: false`); müşteri metnine dokunulmaz.
 */
export function uploadPlan(preview: ImportPreviewResponse): UploadPlan {
  if (!preview.mapping.text) return { kind: "no-text" };
  const blank = preview.rows.filter((r) => !hasText(r)).length;
  const duplicates = preview.rows.filter((r) => hasText(r) && !r.include && isDuplicate(r)).length;
  const take = preview.rows.filter((r) => r.include && hasText(r)).length;
  if (take === 0) return { kind: "nothing", duplicates, blank };
  return { kind: "commit", body: commitBody(preview, baseName(preview.fileName), preview.rows, false), take, duplicates, blank };
}

/** Alım şeridindeki "Son yükleme": dosyadan gelen en yeni parti (elle eklenenlerin partisi dosyasızdır). */
export function lastUpload(batches: readonly BatchSummary[] | undefined): BatchSummary | null {
  let best: BatchSummary | null = null;
  for (const b of batches ?? []) if (b.sourceFile && (!best || b.createdAt > best.createdAt)) best = b;
  return best;
}
