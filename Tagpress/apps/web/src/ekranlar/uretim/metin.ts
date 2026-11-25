import { formatNumber, intlLocale } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";

/**
 * Üretim ekranının sözlük metinleri (`production` ad alanı). Saf mantık dosyaları (`mantik/jobs.ts`,
 * `mantik/data.ts`) metni buradan alır ve testler TR sözlüğüyle
 * bugünkü Türkçe sonucu denetler.
 */

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string;

/** Sıralama seçeneğinin adı ("Eklenme: yeniden eskiye"…); `id` "created-desc" biçiminde. */
export function sortLabel(id: string): string {
  const [key = "", dir = ""] = id.split("-");
  return t(`production:sort.${key}${dir.charAt(0).toUpperCase()}${dir.slice(1)}`);
}

/** "Bugün" / "Dün". */
export function dayWord(kind: "today" | "yesterday"): string {
  return kind === "today" ? t("production:day.today") : t("production:day.yesterday");
}

/** Gün adı ve kısa tarih: etkin arayüz dilinin takvim biçimiyle (TR "Salı", "2 Eki"). */
export function weekdayText(d: Date): string {
  return d.toLocaleDateString(intlLocale(), { weekday: "long" });
}

export function shortDateText(d: Date, withYear: boolean): string {
  return d.toLocaleDateString(intlLocale(), { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).replace(/\.$/, "");
}

export function clockText(d: Date, seconds = false): string {
  return d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

/** "5.2" → "5,2 cm" (EN "5.2 cm"). Sayı değilse kimlik olduğu gibi. */
export function sizeCmText(id: string): string {
  const n = Number(id);
  return t("production:size.cm", { v: Number.isFinite(n) ? formatNumber(n) : id });
}

/** Sticker işinin tip etiketi. */
export function stickerLabel(): string {
  return t("production:type.sticker");
}

// ---------------------------------------------------------------- bildirimler (data.ts)

export function toastText(
  key:
    | "undo"
    | "undone"
    | "queued"
    | "noneQueued"
    | "approved"
    | "noneApproved"
    | "noteAdded"
    | "noteCleared"
    | "reviseQueued"
    | "reviseFailed"
    | "skipped",
  opts?: Record<string, unknown>,
): string {
  return t(`production:toast.${key}`, opts);
}

/** Alım alanının bildirimleri ("8 sipariş listeye eklendi."). */
export function uploadText(key: "added" | "skipped" | "nothing" | "noText" | "detailed", opts?: Record<string, unknown>): string {
  return t(`production:upload.${key}`, opts);
}

/** Dosya okunamadı: tür, okunamadı ya da boş. */
export function fileProblemText(problem: "type" | "unreadable" | "empty", name: string): string {
  switch (problem) {
    case "type":
      return t("production:upload.fileType", { name });
    case "unreadable":
      return t("production:upload.fileUnreadable", { name });
    case "empty":
      return t("production:upload.fileEmpty", { name });
  }
}
