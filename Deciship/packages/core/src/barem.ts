// Barem (ağırlık basamağı) bilgi notu — mobil ölçü/özet ekranı kullanır. Fiyat içermez, yalnız kg.
// Bağımlılık yalnız ./calc ve saf metin tablosu ./i18n (mobil bu dosyayı "@deciship/core/barem" olarak içe aktarır; ağır modül eklemeyin).
import {
  DEFAULT_WEIGHT_STEPS,
  type Dims,
  type EdgeRounding,
  type WeightStep,
  roundUpToStep,
  round3,
  stepFor,
  volumetricWeight,
} from './calc';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';

/** Basamağı en çok bu kadar aşan ağırlık "az farkla" sayılır. */
export const BAREM_MAX_OVER_KG = 0.2;

/**
 * Ücretli ağırlık `boundaryKg` basamağını `overKg` ile aşıyor (bir üst basamaktan, `nextKg`, ücretlenir).
 * Bilinçli olarak yalnız ağırlık basamağı: "kenar 1 cm kısa olsaydı" türü not çalışanı ölçüyü kısmaya
 * özendirebileceği için yok.
 */
export type BaremNote = { kind: 'OVER'; boundaryKg: number; overKg: number; nextKg: number };

const g = (kg: number) => Math.round(round3(kg) * 1000);

/**
 * Ücretli ağırlık bir basamağı az farkla (≤ `maxOverKg`) aşıyor mu?
 * Basamak yoksa, tam basamaktaysa, fark büyükse ya da ilk basamağın altındaysa null.
 */
export function baremNote(i: {
  dims: Dims;
  actualKg: number;
  divisor: number;
  steps?: WeightStep[];
  edgeRounding?: EdgeRounding;
  maxOverKg?: number;
}): BaremNote | null {
  const steps = i.steps ?? DEFAULT_WEIGHT_STEPS;
  if (!steps.length) return null;
  const { l, w, h } = i.dims;
  if (!(l > 0 && w > 0 && h > 0) || !(i.divisor > 0)) return null;
  const rounding = i.edgeRounding ?? 'CEIL_CM';
  const actual = Math.max(0, i.actualKg || 0);

  const volumetric = volumetricWeight(i.dims, i.divisor, rounding);
  const raw = Math.max(round3(actual), volumetric);
  const next = roundUpToStep(raw, steps);
  if (g(next) === g(raw)) return null; // tam basamakta

  const lowerG = g(next) - g(stepFor(raw, steps));
  const overG = g(raw) - lowerG;
  if (!(lowerG > 0 && overG > 0 && overG <= g(i.maxOverKg ?? BAREM_MAX_OVER_KG))) return null;
  return { kind: 'OVER', boundaryKg: lowerG / 1000, overKg: overG / 1000, nextKg: next };
}

function kgText(n: number, locale: Locale): string {
  const s = round3(n).toFixed(3).replace(/0+$/, '');
  const text = s.endsWith('.') ? s + '0' : s;
  return locale === 'en' ? text : text.replace('.', ',');
}

/** Tek satırlık metin: "Ücretli ağırlık 6,0 kg basamağını 0,2 kg ile aşıyor." */
export function baremText(n: BaremNote, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, 'barem.over', { boundary: kgText(n.boundaryKg, locale), over: kgText(n.overKg, locale) });
}
