import { MODELS, PRICES } from "@tagpress/domain";
import { formatNumber, intlLocale } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";

function p(n: number): string {
  return `$${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
}

/** TR: "≈ $0,10 / $0,50 · 1M token, 100K üstü istekte $0,50 / $2,50" (metin `settings:format.*` sözlüğünde). */
export function priceText(model: string): string | null {
  const price = PRICES[model];
  if (!price) return null;
  const base = { input: p(price.input), output: p(price.output) };
  if (price.above) {
    const k = Math.round(price.above.tokens / 1000);
    return i18n.t("settings:format.priceAbove", { ...base, k, aboveInput: p(price.above.input), aboveOutput: p(price.above.output) });
  }
  return i18n.t("settings:format.price", base);
}

export function imagePriceText(): string | null {
  const price = PRICES[MODELS.image];
  if (!price?.perImage) return null;
  return i18n.t("settings:format.imagePrice", { price: p(price.perImage) });
}

/** Çağrı amacının adı; sözlükte yoksa amaç kodu olduğu gibi. */
export function purposeLabel(purpose: string): string {
  const key = `settings:format.purposes.${purpose}`;
  return i18n.exists(key) ? i18n.t(key) : purpose;
}

/** Anahtar durumu cümlesi; anahtarın kendisi ya da hanesi hiçbir yerde gösterilmez. */
export function keyStatusText(hasKey: boolean, updatedAt: string | null): string {
  if (!hasKey) return i18n.t("settings:connections.status.none");
  if (!updatedAt) return i18n.t("settings:connections.status.saved");
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return i18n.t("settings:connections.status.saved");
  return i18n.t("settings:connections.status.savedOn", { date: d.toLocaleDateString(intlLocale(), { day: "numeric", month: "short", year: "numeric" }) });
}

