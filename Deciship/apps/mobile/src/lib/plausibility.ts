/**
 * Akla aykırı ölçü uyarısı. Değer geçerlidir (sınırlar içinde) ama yanlış girilmiş olabilir: kayıttan (ve düzeltmeden) önce
 * sorulur, kişi "Değerler doğru" deyince kaydedilir. Kenar ve ağırlık eşiği firma ayarıdır (`warnEdgeCm`, `warnWeightKg`;
 * Y44); ayar gelmediyse ya da geçersizse aşağıdaki varsayılanlar. Sunucu bu eşiklerle ölçüm reddetmez.
 */
export const EDGE_WARN_CM = 150;
export const WEIGHT_WARN_KG = 70;
/** Desi (hacimsel ağırlık) gerçek ağırlığın bu katını aşarsa ölçü ya da ağırlık şüphelidir. Firma ayarı değildir. */
export const RATIO_WARN = 20;

/** API'nin kabul ettiği aralık (`routes/settings.ts`); dışındaki değer yok sayılır, varsayılan kullanılır. */
export const WARN_EDGE_RANGE = [10, 400] as const;
export const WARN_WEIGHT_RANGE = [1, 999] as const;

export type PlausibilityLimits = { edgeCm: number; weightKg: number };

const inRange = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Firma ayarından eşikler. Alan yoksa ya da aralık dışındaysa bugünkü sabit. */
export function plausibilityLimits(s: { warnEdgeCm?: unknown; warnWeightKg?: unknown } | null | undefined): PlausibilityLimits {
  return {
    edgeCm: inRange(s?.warnEdgeCm, WARN_EDGE_RANGE) ? (s!.warnEdgeCm as number) : EDGE_WARN_CM,
    weightKg: inRange(s?.warnWeightKg, WARN_WEIGHT_RANGE) ? (s!.warnWeightKg as number) : WEIGHT_WARN_KG,
  };
}

export type PlausibilityWarning = 'edge' | 'weight' | 'ratio';

export function plausibilityWarnings(v: {
  l: number | null;
  w: number | null;
  h: number | null;
  kg: number | null;
  divisor: number;
  limits?: PlausibilityLimits;
}): PlausibilityWarning[] {
  const out: PlausibilityWarning[] = [];
  const { l, w, h, kg, divisor } = v;
  const { edgeCm, weightKg } = v.limits ?? { edgeCm: EDGE_WARN_CM, weightKg: WEIGHT_WARN_KG };
  if ([l, w, h].some((x) => x !== null && x > edgeCm)) out.push('edge');
  if (kg !== null && kg > weightKg) out.push('weight');
  if (l && w && h && kg !== null && kg > 0 && divisor > 0 && (l * w * h) / divisor / kg > RATIO_WARN) out.push('ratio');
  return out;
}
