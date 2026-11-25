import type { CenterTarget } from "@tagpress/domain";
import { formatNumber } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";

/**
 * Düzelt'in sözlük metinleri (`adjust` ad alanı). Saf mantık dosyaları (`mantik/adjust-*.ts`) metni buradan
 * alır.
 */

/** Tasarım pikseli sayısı, iki ondalığa yuvarlanmış ve etkin dilde ("12", "0,05"). */
export function pxNumber(v: number): string {
  return formatNumber(Math.round(Math.abs(v) * 100) / 100);
}

/** "%104" (TR) / "104%" (EN). */
export function percentText(n: number): string {
  return i18n.t("adjust:format.percent", { n });
}

/** Kaydırma parçası: "sağa 12 px", "yukarı 3 px". */
export function moveText(axis: "x" | "y", v: number): string {
  const key = axis === "x" ? (v > 0 ? "adjust:summary.right" : "adjust:summary.left") : v > 0 ? "adjust:summary.down" : "adjust:summary.up";
  return i18n.t(key, { v: pxNumber(v) });
}

/** "boyut %104". */
export function scalePartText(label: string): string {
  return i18n.t("adjust:summary.scale", { v: label });
}

/** "kalınlık +0,4". */
export function strokePartText(label: string): string {
  return i18n.t("adjust:summary.stroke", { v: label });
}

/** "değişiklik yok". */
export function noChangeText(): string {
  return i18n.t("adjust:summary.none");
}

/** "2 satır ayrı" (satır düzeltmesi olan satır sayısı). */
export function linesApartText(count: number): string {
  return i18n.t("adjust:summary.linesApart", { count });
}

/** "1 satırın metni elle". */
export function textEditedText(count: number): string {
  return i18n.t("adjust:summary.textEdited", { count });
}

/** "1 satırın fontu elle". */
export function fontEditedText(count: number): string {
  return i18n.t("adjust:summary.fontEdited", { count });
}

/** Kontur farkının sayısı (en çok iki ondalık). */
export function strokeNumber(v: number): string {
  return formatNumber(Math.abs(v), { maximumFractionDigits: 2 });
}

/** Seçim adları: "Bütün yazı", "Satır 2: Matteo", "2 satır: 1, 3". */
export function allTextName(): string {
  return i18n.t("adjust:selection.all");
}
export function lineName(n: number, text: string): string {
  return i18n.t("adjust:selection.line", { n, text });
}
export function linesName(count: number, list: string): string {
  return i18n.t("adjust:selection.many", { count, list });
}

/** Fontun uygulanacağı yer (bkz. `adjust-session.ts` `fontScope`). */
export type FontScopeKind = "span" | "all" | "lines" | "line";

/** "Font (seçili parça)" / "Font (bütün yazı)" / "Font (3 satır)" / "Font (satır)". */
export function fontScopeLabel(kind: FontScopeKind, count = 0): string {
  return i18n.t(`adjust:font.scope.${kind}`, { count });
}

/** Seçici başlığı: "“Ke” için font seç" (parça) ya da "Karışık". */
export function fontPlaceholder(span: string | null): string {
  return span !== null ? i18n.t("adjust:font.forSpan", { text: span }) : i18n.t("adjust:font.mixed");
}

/** Ortalama hedefinin adı. `source`: hedef merkez şablonda kayıtlı mı. */
export function targetLabel(target: CenterTarget, source: "template" | "area"): string {
  if (target === "textCenter") return i18n.t(source === "template" ? "adjust:target.template" : "adjust:target.area");
  return i18n.t(target === "area" ? "adjust:target.area" : "adjust:target.cut");
}
