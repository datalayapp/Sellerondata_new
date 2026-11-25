import { formatNumber, formatUsd, intlLocale } from "../../../i18n/bicim.ts";

export { formatUsd };
// Sözlük metni kullanan yardımcılar `../metin.ts`'te; bu dosya yalnız biçimleme ve hesap.
export { imagePriceText, keyStatusText, priceText, purposeLabel } from "../metin.ts";

/** Marka adları: dile göre değişmez. */
export const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "gemini-3.1-flash-image": "Nano Banana (Gemini)",
};
export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export interface DayBar {
  day: string;
  usd: number;
  calls: number;
}

/** `today` (YYYY-MM-DD) dahil son `n` günü eksiksiz döndürür; verisi olmayan gün 0. */
export function fillDays(byDay: DayBar[], today: string, n = 31): DayBar[] {
  const map = new Map(byDay.map((d) => [d.day, d]));
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const out: DayBar[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    out.push(map.get(day) ?? { day, usd: 0, calls: 0 });
  }
  return out;
}

/** Çubuk yüksekliği yüzdesi; sıfır dışındaki her değer en az %3 görünür. */
export function barPercent(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(3, Math.min(100, (value / max) * 100));
}

export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString(intlLocale(), { month: "short", timeZone: "UTC" });
  return `${d} ${month}`;
}

/** Dosya boyutu (B, KB, MB birimleri her dilde aynı). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, { maximumFractionDigits: 0 })} KB`;
  return `${formatNumber(n / 1024 / 1024, { maximumFractionDigits: 1 })} MB`;
}

export const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
