import { type ApiErrorCode, ERROR_MESSAGES } from "@sellerondata/contracts";
import type { FixAction, Issue, MessageParams, PrintSessionNotice, UndoToken } from "@tagpress/domain";
import { ApiFailure } from "../lib/api.ts";
import { currentLocale, i18n } from "./index.ts";

/**
 * Sunucudan gelen metin. Sunucu her hatayı, sorunu, düzeltme önerisini ve geri al bildirimini kod + parametreyle
 * gönderir; bugünkü Türkçe cümle aynı yanıtta durur (`docs/sunucu-kodlari.md`, kaynak `@tagpress/domain` messages.ts).
 * Kural: sözlükte koda karşılık varsa sözlük (parametrelerle); yoksa TR'de sunucunun metni, EN'de genel metin ve asıl
 * metin ayrıntıda (ipucu). Eski kayıtlarda kod ya da parametre olmayabilir: o zaman sunucu metnine düşülür.
 */
export interface ServerText {
  text: string;
  /** EN'de sözlük karşılığı yoksa sunucunun asıl (Türkçe) metni; ipucunda gösterilir. */
  detail?: string;
}

function has(key: string): boolean {
  return i18n.exists(key);
}

/** Sözlük anahtarı (`_one`/`_other` çoğulları dahil) varsa çevirir; yoksa undefined. */
function tr(key: string | undefined, params?: MessageParams, extra?: Record<string, unknown>): string | undefined {
  if (!key) return undefined;
  const opts = { ...params, ...extra };
  const plural = typeof opts.count === "number";
  if (!has(key) && !(plural && (has(`${key}_other`) || has(`${key}_one`)))) return undefined;
  return i18n.t(key, opts);
}

/**
 * Platform (Hesap, auth-kit) hata kodları (`ORG_CLOSED`, `READ_ONLY`, `FORBIDDEN` …): metin ortak sözlükte
 * (`@sellerondata/contracts` `ERROR_MESSAGES`, TR ve EN). TagPress kodları küçük harfli ve tirelidir, karışmaz.
 */
function platformText(code: string | undefined): string | undefined {
  if (!code || !Object.hasOwn(ERROR_MESSAGES, code)) return undefined;
  return ERROR_MESSAGES[code as ApiErrorCode][currentLocale()];
}

/** Hata → gösterilecek metin ve (gerekirse) ayrıntı. Önce `errors:<code>` (parametrelerle), sonra platform kodu. */
export function serverTextDetail(e: unknown): ServerText {
  const body = e instanceof ApiFailure ? e.body : undefined;
  const raw = body ? body.error : e instanceof Error ? e.message : "";
  const fromDict = tr(body?.code ? `errors:${body.code}` : undefined, body?.params) ?? platformText(body?.code);
  if (fromDict !== undefined) return { text: fromDict };
  if (!raw) return { text: i18n.t("errors:generic") };
  if (currentLocale() === "tr") return { text: raw };
  return { text: i18n.t("errors:generic"), detail: raw };
}

/** Hata → gösterilecek tek satır (eski `errorText` yerine). */
export function serverText(e: unknown): string {
  return serverTextDetail(e).text;
}

/**
 * "İşler açıldı ama üretim kuyruğa girmedi" nedeni (`notQueued`): `errors:<code>` sözlüğü (anahtar yoksa Anthropic),
 * yoksa TR'de sunucunun metni, EN'de genel metin.
 */
export function notQueuedText(nq: { code: string; message: string }): string {
  return tr(`errors:${nq.code}`, { providerName: "Anthropic" }) ?? (currentLocale() === "tr" ? nq.message : i18n.t("errors:generic"));
}

/** Baskı oturumu bildirimi: `printDesk:notices.<code>` (parametrelerle), yoksa sunucunun Türkçe yedek metni. */
export function noticeText(n: Pick<PrintSessionNotice, "code" | "message" | "params">): string {
  return tr(`printDesk:notices.${n.code}`, n.params) ?? n.message;
}

/** Sorun cümlesi: `issues:<messageKey>`, yoksa `issues:<code>` (parametrelerle), yoksa sunucunun mesajı. */
export function issueText(issue: Pick<Issue, "code" | "message"> & Partial<Pick<Issue, "messageKey" | "params">>): string {
  return tr(issue.messageKey ? `issues:${issue.messageKey}` : undefined, issue.params) ?? tr(`issues:${issue.code}`, issue.params) ?? issue.message;
}

/**
 * Düzeltme düğmesinin adı: `issues:fix.<labelKey>`, yoksa `issues:fix.<kind>` (`{{value}}` ve parametrelerle),
 * yoksa sunucunun adı.
 */
export function fixLabel(fix: Pick<FixAction, "kind" | "label" | "value"> & Partial<Pick<FixAction, "labelKey" | "params">>): string {
  const extra = { value: fix.value ?? "" };
  return tr(fix.labelKey ? `issues:fix.${fix.labelKey}` : undefined, fix.params, extra) ?? tr(`issues:fix.${fix.kind}`, fix.params, extra) ?? fix.label;
}

/**
 * Geri al bildiriminin metni: `common:undo.<code>` (parametrelerle); yoksa TR'de sunucunun kısa açıklaması
 * ("3 iş silindi"), EN'de genel metin.
 */
export function undoText(token: Pick<UndoToken, "label"> & Partial<Pick<UndoToken, "code" | "params">>): string {
  const fromDict = tr(token.code ? `common:undo.${token.code}` : undefined, token.params);
  if (fromDict !== undefined) return fromDict;
  if (currentLocale() === "tr") return token.label;
  return i18n.t("common:undo.generic");
}
