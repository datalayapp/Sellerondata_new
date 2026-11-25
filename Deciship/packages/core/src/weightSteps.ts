import { type WeightStep, stepFor } from './calc';
import { fmtKg } from './format';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';

/**
 * Ağırlık yuvarlama basamaklarını fiyat tablosundan çıkarır (içe aktarmada otomatik; SPEC §5.7).
 *
 * - Açık (sabit fiyatlı) satırların aralığı basamaktır: 0,5 · 1 · 1,5 … 70,5 → "70,5 kg'a kadar 0,5 kg".
 *   Aralık değişirse yeni bant başlar (0,5'er 20 kg'a kadar, sonra 1'er → iki bant). 1 kg'dan büyük aralıklarda
 *   (5 · 10 · 15 desi) basamak 1 kg'dır; yuvarlanan ağırlık zaten bir sonraki satırın fiyatını alır.
 * - Son açık satırın üstü (kg başı bantlar, örn. 71–99 kg): taşıyıcılarda yaygın kural olarak 1 kg'a yukarı yuvarlanır.
 *   Kg başı bant yok ama aşım fiyatı varsa, aşım birimi değişmesin diye üst bandın basamağı mevcut tarifeden alınır
 *   (`aboveStep`).
 * - En az iki farklı açık ağırlık yoksa ya da aralıklar düzgün bir basamağa (en az 0,1 kg) oturmuyorsa — örn. libreden
 *   çevrilmiş 0,454 · 0,907 … — null (mevcut basamaklar korunur).
 */
export function weightStepsFromRates(
  rates: { weightUpto: number; perKg?: boolean }[],
  opts: { aboveStep?: number } = {},
): WeightStep[] | null {
  const grams = [...new Set(rates.filter((r) => !r.perKg && r.weightUpto > 0).map((r) => Math.round(r.weightUpto * 1000)))].sort(
    (a, b) => a - b,
  );
  if (grams.length < 2) return null;
  const bands: { uptoG: number | null; stepG: number }[] = [];
  const push = (uptoG: number | null, stepG: number) => {
    const last = bands[bands.length - 1];
    if (last && last.stepG === stepG) last.uptoG = uptoG;
    else bands.push({ uptoG, stepG });
  };
  for (let i = 0; i < grams.length; i++) {
    const prev = i === 0 ? 0 : grams[i - 1]!;
    const gap = i === 0 ? grams[1]! - grams[0]! : grams[i]! - prev;
    // ilk aralık (0, w0]: bir sonraki aralıkla aynı basamak, w0'a hizalı
    const step = stepDividing(gap, i === 0 ? grams[0]! : prev);
    if (step < MIN_STEP_G) return null;
    push(grams[i]!, step);
  }
  const aboveG = Math.round((opts.aboveStep && opts.aboveStep > 0 ? opts.aboveStep : 1) * 1000);
  push(null, aboveG);
  return bands.map((b) => ({ upto: b.uptoG == null ? null : b.uptoG / 1000, step: b.stepG / 1000 }));
}

const STEP_CHOICES_G = [1000, 500, 250, 200, 100];
const MIN_STEP_G = 100;

/** Aralığı ve hizalama noktasını bölen en büyük olağan basamak (en çok 1 kg). */
function stepDividing(gapG: number, alignG: number): number {
  return STEP_CHOICES_G.find((s) => gapG % s === 0 && alignG % s === 0) ?? 0;
}

/** Basamaklar aynı mı (bant sınırları ve adımlar gram hassasiyetinde). */
export function sameWeightSteps(a: WeightStep[] | null | undefined, b: WeightStep[] | null | undefined): boolean {
  const key = (s: WeightStep[] | null | undefined) =>
    (s ?? []).map((x) => `${x.upto == null ? '∞' : Math.round(x.upto * 1000)}:${Math.round(x.step * 1000)}`).join('|');
  return key(a) === key(b);
}

const kg = (n: number, locale: Locale) => fmtKg(n, locale).replace(/[,.]0 kg$/, ' kg');

/** Tek basamak: "her 1 kg" / "every 1 kg". */
export function describeWeightStep(step: number, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, 'weightSteps.every', { kg: kg(step, locale) });
}

/** "70,5 kg'a kadar 0,5 kg, üstü 1 kg" · tek bant: "her 1 kg". */
export function describeWeightSteps(steps: WeightStep[], locale: Locale = DEFAULT_LOCALE): string {
  if (!steps.length) return t(locale, 'weightSteps.none');
  if (steps.length === 1) return describeWeightStep(steps[0]!.step, locale);
  return steps
    .map((s) => (s.upto == null ? t(locale, 'weightSteps.above', { kg: kg(s.step, locale) }) : t(locale, 'weightSteps.upto', { upto: kg(s.upto, locale), step: kg(s.step, locale) })))
    .join(', ');
}

/** Son açık satırın üstündeki mevcut basamak (aşım birimini korumak için). */
export function stepAbove(steps: WeightStep[] | null | undefined, kg: number): number {
  return stepFor(kg + 0.001, steps ?? []);
}
