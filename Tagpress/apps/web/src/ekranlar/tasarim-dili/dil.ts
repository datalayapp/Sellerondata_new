import * as en from "../../i18n/dil/en.ts";
import * as tr from "../../i18n/dil/tr.ts";
import { currentLocale, i18n } from "../../i18n/index.ts";

/**
 * Tasarım dili ekranının dile özgü yardımcıları: etkin arayüz diline göre `i18n/dil/{tr,en}.ts` seçilir (TR "%97'si",
 * EN "97%"). `i18n/index.ts`'e biçimleyici kaydı eklenince (`"{{v, pctOwn}}"`) bu dosya sözlükten okuyan ince bir sarmalayıcıya iner.
 */
const impl = () => (currentLocale() === "tr" ? tr : en);

export const pctText = (ratio: number): string => impl().pctText(ratio);
/** "%97" (TR) ya da "97%" (EN). */
export const pct = (ratio: number): string => impl().pct(ratio);
/** "%97'si" (TR) ya da "97%" (EN). */
export const pctOwn = (ratio: number): string => impl().pctOwn(ratio);
export const num = (n: number, max?: number): string => impl().num(n, max);
export const joinList = (items: string[]): string => impl().joinList(items);

/** Saf dosyalardan sözlük okuma (`designLanguage:describe.x` gibi ad alanlı anahtar). */
export function tt(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options) as string;
}
