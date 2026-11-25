// Bağımlılıksız hesap modülü (mobil de kullanır). Bu dosyaya import eklemeyin.

export type Dims = { l: number; w: number; h: number };
export type WeightStep = { upto: number | null; step: number };
export type EdgeRounding = 'CEIL_CM' | 'NONE';

export const DEFAULT_DESI_DIVISOR = 3000;
export const DEFAULT_WEIGHT_STEPS: WeightStep[] = [
  { upto: 20, step: 0.5 },
  { upto: null, step: 1 },
];

const POW10 = Array.from({ length: 20 }, (_, i) => 10 ** i);

/**
 * Kayan nokta gürültüsünü (580.5449999… gibi) 12 anlamlı basamakta temizler: sonuç her zaman
 * `Number(n.toPrecision(12))` ile birebir aynıdır. Sık yol (|n| 1e-6 … 1e12) dizgeye çevirmeden tamsayı
 * aritmetiğiyle hesaplanır (binlerce satırlık faturada yuvarlama süresinin çoğu toPrecision'daydı);
 * yarıma çok yakın ya da sınırdaki değerler eski yoldan geçer.
 */
export function cleanFloat(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : n;
  const a = n < 0 ? -n : n;
  if (a < 1e12) {
    if (Number.isInteger(a)) return n;
    if (a >= 1e-6) {
      const k = 11 - Math.floor(Math.log10(a));
      const scale = POW10[k]!;
      const x = a * scale; // 1e11 ≤ x < 1e12: hata ≤ 6e-5, yuvarlama yönü yalnız yarıma yakınken belirsiz
      const f = Math.floor(x);
      const frac = x - f;
      if (f >= 1e11 && f < 999_999_999_999 && (frac < 0.499 || frac > 0.501)) {
        const r = (frac > 0.5 ? f + 1 : f) / scale; // tamsayı / 10^k tam bölme: ondalık dizgeyi okumakla aynı double
        return n < 0 ? -r : r;
      }
    }
  }
  return Number(n.toPrecision(12));
}

/**
 * Bu büyüklükten itibaren yuvarlama 12 anlamlı basamakla yetinmez (Y108): 12 basamak 1e10 üstünde kuruşu siler
 * (12345678901.23 → 12345678901.2). Altında her sonuç eskisiyle birebir aynıdır. `cleanFloat`'ın kendisi değişmez.
 * `@sellerondata/format` `digits()` aynı kuralı kullanır (ekran ve motor aynı kuruşu yazsın): ikisini birlikte değiştirin.
 */
const WIDE_FROM = 1e9;

/** |n| ≥ `WIDE_FROM` için temizlik basamağı: double'ın güvenilir sınırı. `format` `digits()` ile aynı. */
const WIDE_DIGITS = 15;

/**
 * |n| ≥ `WIDE_FROM`: önce 15 anlamlı basamağa temizlenir, sonra ondalık metin üzerinde yarım-yukarı (`format` `digits()`
 * ile aynı adımlar). Daha az basamakla (tam + ondalık + 1) temizlemek çift yuvarlamadır: 1234567890.0049 → …890.005 →
 * …890.01 (doğrusu …890.00). Metin üzerinde çalıştığı için sonuç her büyüklükte kuruş katıdır (r / 100 bölmesi 2^53
 * üstünde artık bırakır). Bedeli: ~1e12 üstünde yarım payı kalmaz, ~1e13 üstünde 15 basamak kuruşa yetmez.
 */
function roundWide(n: number, decimals: number): number {
  const a = n < 0 ? -n : n;
  const clean = Number(a.toPrecision(WIDE_DIGITS));
  const s = String(clean); // 1e9 ≤ clean: 1e21 altında üslü yazım yok; üstünde nokta yok, olduğu gibi döner
  const dot = s.indexOf('.');
  if (dot < 0 || s.length - dot - 1 <= decimals) return n < 0 ? -clean : clean;
  let d = s.slice(0, dot) + s.slice(dot + 1, dot + 1 + decimals);
  if (s.charCodeAt(dot + 1 + decimals) >= 53) {
    // '5' ve üstü: rakam metnine 1 ekle ("199" → "200")
    const ch = d.split('');
    let i = ch.length - 1;
    while (i >= 0 && ch[i] === '9') ch[i--] = '0';
    if (i < 0) ch.unshift('1');
    else ch[i] = String(Number(ch[i]) + 1);
    d = ch.join('');
  }
  const r = Number(decimals > 0 ? `${d.slice(0, d.length - decimals)}.${d.slice(d.length - decimals)}` : d);
  return n < 0 ? -r : r;
}

function roundHalfUp(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return n;
  if ((n < 0 ? -n : n) >= WIDE_FROM) return roundWide(n, decimals);
  const c = cleanFloat(n);
  const sign = c < 0 ? -1 : 1;
  const factor = 10 ** decimals;
  const r = Math.round(cleanFloat(Math.abs(c) * factor));
  const out = (sign * r) / factor;
  return out === 0 ? 0 : out;
}

/** 2 ondalığa yarım-yukarı (sıfırdan uzağa) yuvarlama; 1.005 → 1.01, 580.545 → 580.55. */
export function round2(n: number): number {
  return roundHalfUp(n, 2);
}

/** 3 ondalık (gram) yuvarlama. */
export function round3(n: number): number {
  return roundHalfUp(n, 3);
}

/** Tutarı kuruş tamsayısına çevirir. */
export function toCents(n: number): number {
  return Math.round(round2(n) * 100);
}

export function fromCents(c: number): number {
  return round2(c / 100);
}

/** Para toplamı (kuruş tamsayısıyla, kayan nokta hatasız). */
export function sumMoney(values: number[]): number {
  let c = 0;
  for (const v of values) c += toCents(v);
  return fromCents(c);
}

/** a - b, kuruş tamsayısıyla. */
export function subMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

/** amount × pct / 100, 2 ondalığa yarım-yukarı. Sonuç 1e9 ve üstündeyse ara çarpım da geniş temizlenir (Y108). */
export function pctOf(amount: number, pct: number): number {
  const y = amount * pct;
  const a = y < 0 ? -y : y;
  if (!(a >= WIDE_FROM * 100)) return round2(cleanFloat(y) / 100);
  return round2(Number(y.toPrecision(WIDE_DIGITS)) / 100);
}

export function roundEdges(d: Dims, r: EdgeRounding): Dims {
  if (r !== 'CEIL_CM') return { l: d.l, w: d.w, h: d.h };
  const ceil = (x: number) => Math.ceil(cleanFloat(x));
  return { l: ceil(d.l), w: ceil(d.w), h: ceil(d.h) };
}

/** Hacimsel ağırlık (kg), 3 ondalık. Varsayılan kenar yuvarlama CEIL_CM. */
export function volumetricWeight(d: Dims, divisor: number, r: EdgeRounding = 'CEIL_CM'): number {
  if (!(divisor > 0)) return 0;
  const e = roundEdges(d, r);
  return round3(cleanFloat(e.l * e.w * e.h) / divisor);
}

/**
 * Desi, 2 ondalık. Varsayılan bölen 3000. Kenarlar karşılaştırmadaki gibi yuvarlanır (varsayılan CEIL_CM, `volumetricWeight`
 * ile aynı kural): çalışanın ve yöneticinin gördüğü desi, faturayla karşılaştırılan desiyle aynıdır (39,6 cm → 40).
 * Ham kenarlı değer için `'NONE'`.
 */
export function desi(d: Dims, divisor: number = DEFAULT_DESI_DIVISOR, r: EdgeRounding = 'CEIL_CM'): number {
  if (!(divisor > 0)) return 0;
  const e = roundEdges(d, r);
  return round2(cleanFloat(e.l * e.w * e.h) / divisor);
}

/** 1 lb, gram (LB_TO_KG × 1000; bu dosya import almaz). */
const LB_G = 453.59237;
/**
 * lb basamağı olarak tanınan adımlar (lb): lb tarifesi içe aktarmasının yazdığı basamaklar (01-B5) ve "her ilave X lb"
 * aşım birimleri. 3 ve 4 lb'nin kg karşılığı (1,361 · 1,814) olağan bir kg basamağı değildir; 0,75 ve 1,5 lb (0,34 · 0,68
 * kg) olabilir, bu yüzden listede yok.
 */
const LB_STEP_CHOICES = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 4, 5, 10];
/**
 * Y42: "her ilave 0,75 lb / 1,5 lb" aşım birimleri. 3 haneli kg karşılıkları (0,34 · 0,68) kg basamağı da olabildiği için
 * yalnız iki durumda lb sayılır: (1) adım tam hassasiyetle bu lb değeridir (içe aktarmanın yazdığı 0,680388555; 1 mg
 * payla, kg tarifesi böyle bir değer taşımaz) ya da (2) tarifede lb kanıtı var (`lbHinted`) ve adım 0,5 g'dan yakındır
 * (düzenleyicinin 3 haneye yuvarladığı 0,68).
 */
const LB_STEP_HINTED = [0.75, 1.5];
const EXACT_G = 0.001;

/**
 * `lbRates` (Y21; tarifenin fiyat satırlarından, `lbRatesOf`): `true` satırlar lb ağırlığı (lb kanıtı, 0,68 · 0,34 de lb),
 * `false` satırlar kg ağırlığı: 3 haneli değer (0,454 · 0,907 · 2,268 …) kg basamağıdır, yalnız tam hassasiyetli lb
 * değeri (içe aktarmanın yazdığı 0,45359237; 1 mg pay) lb kalır. `undefined` (satır bilgisi yok): bugünkü kural.
 */
function lbStepLb(step: number, hinted = false, lbRates?: boolean): number | null {
  const g = step * 1000;
  for (const lb of LB_STEP_CHOICES) if (Math.abs(g - lb * LB_G) <= EXACT_G) return lb;
  for (const lb of LB_STEP_HINTED) if (Math.abs(g - lb * LB_G) <= EXACT_G) return lb;
  if (lbRates === false) return null;
  for (const lb of LB_STEP_CHOICES) if (Math.abs(g - lb * LB_G) <= 0.5) return lb;
  if (hinted || lbRates === true) for (const lb of LB_STEP_HINTED) if (Math.abs(g - lb * LB_G) <= 0.5) return lb;
  return null;
}

/** Fiyat satırının ağırlığı (lb kanıtı için yalnız sabit fiyatlı, açık uçlu olmayan satırlar sayılır). */
export type RateWeight = { weightUpto: number; perKg?: boolean };

/** Ağırlık tam ya da yarım lb'nin 3 haneli kg'ı mı (lb içe aktarması satırları round3(n lb) yazar: 2 lb = 0,907). */
function isLbWeight(g: number): boolean {
  const half = Math.round((g / LB_G) * 2) / 2;
  return half > 0 && Math.round(half * LB_G) === g;
}

const lbRatesCache = new WeakMap<readonly RateWeight[], { length: number; value: boolean | undefined }>();

/**
 * Y21: tarifenin fiyat satırları lb tarifesini mi gösteriyor? Sabit fiyatlı satırların farklı ağırlıklarından (≥ 2;
 * açık uç 99999 ve kg başı bantlar sayılmaz) yarıdan çoğu tam ya da yarım lb'nin 3 haneli kg'ıysa `true` (lb içe
 * aktarması: 0,454 · 0,907 · 1,361 …), değilse `false` (kg tarifesi: 0,5 · 1 · 1,5 … ya da 0,454 · 0,908 · 1,362 …);
 * < 2 ağırlık varsa `undefined` (kanıt yok, bugünkü kural). Aynı dizi için bir kez hesaplanır (boyu değişirse yeniden).
 */
export function lbRatesOf(rates: readonly RateWeight[] | null | undefined): boolean | undefined {
  if (!rates) return undefined;
  const hit = lbRatesCache.get(rates);
  if (hit && hit.length === rates.length) return hit.value;
  const grams = new Set<number>();
  for (const r of rates) if (!r.perKg && r.weightUpto > 0 && r.weightUpto < 99999) grams.add(Math.round(round3(r.weightUpto) * 1000));
  let value: boolean | undefined;
  if (grams.size >= 2) {
    let lb = 0;
    for (const g of grams) if (isLbWeight(g)) lb++;
    value = lb * 2 > grams.size;
  }
  lbRatesCache.set(rates, { length: rates.length, value });
  return value;
}

/**
 * Basamağın lb karşılığı (lb tarifesi, 01-B5): adım bir olağan lb basamağının kg değerine 0,5 g'dan yakınsa (0,45359237;
 * düzenleyicinin 3 haneye yuvarladığı 0,454; 0,5 lb = 0,227 …) o lb basamağının kesin kg değeri, değilse null. Olağan kg
 * basamakları (0,1 · 0,2 · 0,25 · 0,5 · 1 · 2 · 5 · 10 kg) hiçbir lb basamağına 0,5 g'dan yakın değildir: kg tarifeleri
 * etkilenmez. lb basamağı gram tamsayısı değildir; 0,454 gramla sayılsa sınırlar kayar (0,88 kg → 0,908 kg > 2 lb satırı).
 * 0,75 ve 1,5 lb (Y42) bağlamsız yalnız tam hassasiyetle; `hinted` (tarifede lb kanıtı) ile 3 haneli değer de tanınır.
 * `lbRates` (Y21, `lbRatesOf`): satırlar kg tarifesini gösteriyorsa (`false`) 3 haneli değer kg basamağıdır.
 */
export function lbStepKg(step: number, hinted = false, lbRates?: boolean): number | null {
  const lb = lbStepLb(step, hinted, lbRates);
  return lb == null ? null : (lb * LB_G) / 1000;
}

/**
 * Tarifede lb kanıtı var mı (Y42; 0,68 · 0,34'ü lb sayabilmek için): başka bir bandın adımı olağan lb basamağıdır (lb
 * içe aktarması tablo içini hep 0,1–1 lb'lik basamakla yazar: 0,454 …) ya da sınır (önceki bandın üstü / son satır) tam
 * ya da yarım lb'nin 3 haneli kg'ıdır (10 lb = 4,536; 0,25 lb ızgarasındaki 11 kg = 24,25 lb gibi kg sınırları sayılmaz).
 */
function lbHinted(steps: WeightStep[] | null | undefined, boundKg: number | null | undefined, lbRates?: boolean): boolean {
  if (lbRates === true) return true;
  if (steps?.some((s) => s.step > 0 && lbStepLb(s.step, false, lbRates) != null)) return true;
  const lb = lbBoundOf(boundKg);
  return lb > 0 && Math.abs(lb * 2 - Math.round(lb * 2)) < 1e-9;
}

/**
 * Bant alt sınırının lb değeri (0,05 lb katı), sınır bir lb ağırlığının 3 haneli kg'ıysa (11 lb = 4,99 kg); değilse 0
 * (sıfırdan sayılır, bugünkü hesap). 0,05 lb (~23 g) adım, kg sınırının rastlantıyla lb ağırlığı sayılmasını azaltır.
 */
function lbBoundOf(kg: number | null | undefined): number {
  if (kg == null || !(kg > 0)) return 0;
  const lb = Math.round(((kg * 1000) / LB_G) * 20) / 20;
  return Math.round(lb * LB_G) === Math.round(round3(kg) * 1000) ? lb : 0;
}

/**
 * Basamak bandına yukarı yuvarlama (gram tamsayısıyla). 9,45 → 9,5; 21,2 → 22. lb basamağında (`lbStepKg`) lb'nin katına:
 * 3 haneli kg 1 lb sınırını en çok 0,5 g kaçırır (15 lb = 6,80389 kg → 6,804), bu yüzden sınırın 0,5 g üstü aynı lb sayılır;
 * sonuç içe aktarmadaki satır ağırlığıyla aynı hesaptır (round3(n lb × 0,45359237)): 0,88 kg → 0,907 kg (2 lb).
 * lb bandı alt sınırından (önceki bandın sınırı, bir lb ağırlığıysa) sayılır: 11 lb satırından sonra "her ilave 2 lb"
 * 12,5 lb'yi 13 lb'ye yuvarlar (sıfırdan sayılsa 14 lb, bir aşım birimi fazla).
 * `rates` (tarifenin fiyat satırları; Y21): kg satırlı tarifede 0,454 gibi 3 haneli lb benzeri basamak kg basamağıdır
 * (`lbRatesOf`); verilmezse bugünkü kural.
 */
export function roundUpToStep(kg: number, steps: WeightStep[], rates?: readonly RateWeight[] | null): number {
  const value = round3(kg);
  if (!steps || steps.length === 0) return value;
  let i = steps.findIndex((s) => s.upto === null || value <= s.upto);
  if (i < 0) i = steps.length - 1;
  const band = steps[i]!;
  const g = Math.round(value * 1000);
  const lbRates = lbRatesOf(rates);
  const lb = lbStepLb(band.step, false, lbRates) ?? lbStepLb(band.step, lbHinted(steps, i > 0 ? steps[i - 1]!.upto : null, lbRates), lbRates);
  if (lb != null) {
    if (!(g > 0)) return value;
    const fromG = (i > 0 ? lbBoundOf(steps[i - 1]!.upto) : 0) * LB_G;
    const units = Math.max(1, Math.ceil((g - 0.5 - fromG) / (lb * LB_G)));
    return round3((fromG + units * lb * LB_G) / 1000);
  }
  const stepG = Math.round(band.step * 1000);
  if (!(stepG > 0)) return value;
  const units = Math.ceil(g / stepG);
  return round3((units * stepG) / 1000);
}

/**
 * Tablonun son satırının üstündeki aşım birimi sayısı (`ratePrice`). Gram tamsayısı basamakta bugünkü hesap; lb
 * basamağında (`lbStepKg`) iki 3 haneli ağırlığın farkı lb katından en çok 1 g sapar: 1 g payla sayılır, en az 1 birim.
 * 10 lb (4,536 kg) satırından sonra 15 lb (6,804 kg) → 5 birim. `steps` (tarifenin basamakları) 0,75 · 1,5 lb'nin
 * 3 haneli değeri için lb kanıtıdır (Y42; `roundUpToStep` ile aynı kural); `rates` Y21 kanıtı (`roundUpToStep`).
 */
export function overflowUnits(chargeableKg: number, lastUptoKg: number, step: number, steps?: WeightStep[], rates?: readonly RateWeight[] | null): number {
  const diffG = Math.round(round3(chargeableKg) * 1000) - Math.round(round3(lastUptoKg) * 1000);
  const lbRates = lbRatesOf(rates);
  const lbKg = lbStepKg(step, false, lbRates) ?? lbStepKg(step, lbHinted(steps, lastUptoKg, lbRates), lbRates);
  if (lbKg != null) return Math.max(1, Math.ceil((diffG - 1) / (lbKg * 1000)));
  return Math.ceil(diffG / Math.round(step * 1000));
}

/** Bandın adımı (taşma hesabında kullanılır); bulunamazsa 1. */
export function stepFor(kg: number, steps: WeightStep[]): number {
  if (!steps || steps.length === 0) return 1;
  const band = steps.find((s) => s.upto === null || kg <= s.upto) ?? steps[steps.length - 1]!;
  return band.step > 0 ? band.step : 1;
}

export function chargeableWeight(i: {
  dims: Dims;
  actualKg: number;
  divisor: number;
  edgeRounding?: EdgeRounding;
  steps?: WeightStep[];
  /** Tarifenin fiyat satırları (Y21; `roundUpToStep`). */
  rates?: readonly RateWeight[] | null;
}): { volumetric: number; chargeable: number; basis: 'ACTUAL' | 'VOLUMETRIC' } {
  const volumetric = volumetricWeight(i.dims, i.divisor, i.edgeRounding ?? 'CEIL_CM');
  const actual = round3(i.actualKg);
  const basis = volumetric > actual ? 'VOLUMETRIC' : 'ACTUAL';
  const raw = Math.max(actual, volumetric);
  const chargeable = roundUpToStep(raw, i.steps ?? [], i.rates);
  return { volumetric, chargeable, basis };
}

/** Kenarları büyükten küçüğe sıralar (yön önemsiz karşılaştırma için). */
export function sortedEdges(d: Dims): [number, number, number] {
  const a = [d.l, d.w, d.h].sort((x, y) => y - x);
  return [a[0]!, a[1]!, a[2]!];
}
