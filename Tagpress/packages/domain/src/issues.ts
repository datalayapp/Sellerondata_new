import { z } from "zod";
import { MessageParamsSchema } from "./messages.ts";

/**
 * Sorun modeli: içe aktarmada ve üretimde bulunan her sorun aynı biçimdedir ve
 * mümkünse tek tıkla düzeltme önerir. Arayüz sorunları bu kodlara göre gruplar.
 */
export const IssueSeveritySchema = z.enum(["error", "warning", "info"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const ISSUE_CODES = [
  // İçe aktarma
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
  /** Aynı metin + aynı şablon, başka sipariş numarasıyla (bilgi; tekrar sayılmaz). */
  "duplicate-similar",
  "sticker-detected",
  "sticker-sheet-missing",
  // Üretim
  "no-layout",
  /** Niyetin satırları müşteri metnini değiştiriyor (motor reddeder). */
  "text-changed",
  /** Hafif düzeltmede kullanıcı satır metnini ELLE değiştirdi; iş metninden farklı (bilgi; otomatik adım değil). */
  "text-edited",
  "text-too-small",
  "collision",
  "low-fill",
  "rule-name-not-own-line",
  "rule-line-too-long",
  "rule-lone-word",
  "rule-too-many-lines",
  "rule-split-greeting",
  "rule-initials-split",
  "rule-couple-stack",
  "rule-date-own-line",
  "rule-customer-break",
  "font-unavailable",
  "font-mixing",
  "ai-failed",
  "ai-duplicate",
  "ai-no-good-candidate",
  "critique-issue",
  "image-text-mismatch",
  "image-template-changed",
  /** Şablonun (ya da tasarım dilinin) kesimi onaydan sonra değişti; onay kaldırıldı, yerleşim yeniden kontrol edilmeli. */
  "template-cut-changed",
] as const;
export const IssueCodeSchema = z.enum(ISSUE_CODES);
export type IssueCode = z.infer<typeof IssueCodeSchema>;

export const FixActionSchema = z.object({
  kind: z.enum([
    "edit-text",
    "convert-unicode",
    "choose-template",
    "set-size",
    "set-quantity",
    "set-order",
    "open-template",
    "regenerate",
    "revise",
    "skip",
    "dismiss",
  ]),
  /** Kullanıcıya gösterilecek Türkçe ad (geriye uyum; arayüz önce `labelKey`'e bakar). */
  label: z.string(),
  /** Düğme adının sözlük anahtarı (`FIX_LABELS`); yoksa `kind`. */
  labelKey: z.string().optional(),
  /** Ad şablonunun parametreleri (ör. `set-size`: `{ cm }`). */
  params: MessageParamsSchema.optional(),
  /** Öneri değeri (ör. önerilen şablon anahtarı, dönüştürülmüş metin, revizyon cümlesi). */
  value: z.string().optional(),
});
export type FixAction = z.infer<typeof FixActionSchema>;

export const IssueSchema = z.object({
  code: IssueCodeSchema,
  severity: IssueSeveritySchema,
  /** Kullanıcıya gösterilecek Türkçe cümle (geriye uyum; arayüz önce `messageKey`'e bakar). */
  message: z.string(),
  /** Cümlenin sözlük anahtarı (`ISSUE_MESSAGES`); bir kodun birden çok cümlesi olabilir. Eski kayıtlarda yok. */
  messageKey: z.string().optional(),
  /** Cümledeki değişkenler (hücre, sayı, font adı, müşteri metni parçası…). */
  params: MessageParamsSchema.optional(),
  /** İlgili alan (text, templateKey, quantity…) ya da satır numarası. */
  field: z.string().optional(),
  fixes: z.array(FixActionSchema).default([]),
});
export type Issue = z.infer<typeof IssueSchema>;

export function worstSeverity(issues: readonly Issue[]): IssueSeverity | null {
  if (issues.some((i) => i.severity === "error")) return "error";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  if (issues.length) return "info";
  return null;
}
