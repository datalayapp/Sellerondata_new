import { chargeableWeight, pctOf, round2, round3, roundUpToStep, sortedEdges, subMoney, sumMoney, volumetricWeight, type Dims } from './calc';
import { countryNameToIso2 } from './countries';
import { countryName } from './countryNames';
import { fmtDate, fmtKg, fmtMoney, fmtNumber, fmtPct } from './format';
import { DEFAULT_FX_TOLERANCE_PCT, convertMoney, fmtFxRate, fxSourceText, type BreakdownLine, type FxApplied, type FxInput, type FxRate, type TolFxInput } from './fx';
import { DEFAULT_LOCALE, localizeText, t, type Locale } from './i18n/index';
import type { ParsedInvoiceLine } from './invoice/types';
import { serviceClassWords, serviceMismatch } from './service';
import { canonicalSurchargeCode } from './surcharges';
import { distanceZoneCode, distanceZoneCount, expectedCharge, findTariffSurcharge, resolveZone, surchargeAmount, zoneKey, type TariffInput } from './tariff';

/**
 * `fxTolerancePct`: kur çevrilen satırlarda, çevrilmiş beklenen tutarın bu yüzdesine kadar fark uyumlu sayılır (varsayılan %1,5).
 * `unknownSurchargesAsDiff`: faturadaki, tarifede tanımlı olmayan ek ücretler satırı "Fark var" yapsın mı. Varsayılan hayır:
 * bu ücretler faturadaki tutarıyla Beklenen'e eklenir (tarifeyle kontrol edilemez, ama Beklenen ile Faturalanan aynı
 * kalemleri kapsar); fark böylece yalnız tarifenin tanımladığı kısımdan — taşıma + bilinen ek ücretler + yakıt — doğar.
 * Açıkken bu ücretler Beklenen'e girmez, tamamı fark sayılır.
 */
export type Tolerances = { edgeTolCm: number; weightTolKg: number; amountTol: number; fxTolerancePct?: number; unknownSurchargesAsDiff?: boolean };

export type MeasurementInput = { id: string; dims: Dims; actualKg: number; measuredAt: string };

export type ComparisonStatus = 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF';
export type DiffType = 'DUPLICATE' | 'DIMENSION' | 'WEIGHT' | 'SURCHARGE' | 'PRICE';

/**
 * Beklenen taşıma bedelinin dayanağı (SPEC §3.8): `TARIFF` = sözleşme tarifesi (kurla çevrilmiş); `INVOICE` = taşıyıcının
 * bu faturadaki kendi fiyatı, tarifenin ağırlık eğrisiyle bizim ücretli kg'a ölçeklenmiş (taşıyıcı sözleşmeden ucuz fiyat
 * uyguladığında).
 */
export type PricingBasis = 'TARIFF' | 'INVOICE';
/** Fark tutarına güven: `HIGH` = kesin (Fazla ödeme'ye girer), `LOW` = "İncele" (eski adı tahmini; ayrı gösterilir). */
export type Confidence = 'HIGH' | 'LOW';
/** Satır neden "İncele" (LOW): ekran ve raporlar gerekçeyi sınıflamak için kullanır. */
/** `FX_STALE` (Y18): saklı (bayat) kurla hesaplandı; güncel kur gelince "Yeniden karşılaştır" kesinleştirir. */
/**
 * `SERVICE_UNKNOWN` (DENETIM-2 B1): faturada birden çok hizmet sınıfı var, tarifenin hizmeti boş ya da sınıf sözcüğü
 * taşımıyor; farkın hangi hizmetin fiyatıyla hesaplandığı belli değil. `FUEL_UNKNOWN` (B2, eski Y17): değişken yakıtlı
 * tarifede faturada yakıt ayrı yazılmamış; fiyat farkı güncel yakıt oranından olabilir.
 * `SERVICE_MISSING` (K39, kullanıcı kararı 2026-11-13): tarifenin hizmeti sınıf sözcüğü taşıyor ("IE"), satırın hizmeti
 * boş; tarifenin hizmetinin bu gönderiye uygulandığı bilinmiyor. `FUEL_SURCHARGE` (DENETIM-2 01-B13): sabit yakıtlı
 * tarifede faturadaki yakıt, tarifedeki oranın taşıma + ek ücret(ler) üstünden hesabıdır; tarife yakıtı yalnız taşımaya
 * uygular, sözleşme ek ücrete yakıtı izin veriyorsa fark yoktur.
 */
/**
 * `MULTI_PARCEL` (KALANLAR 1.8): çok kolili gönderi şüphesi. Takip no bu dosyada birden çok ücret satırında (her fark türü)
 * ya da eşleşen ölçüm birden çok kez ölçülmüş (ağırlık/ölçü farkı): bizim ölçümümüz kolilerden biri, fatura toplamı olabilir.
 */
export type ReviewCode =
  | 'MULTI_PARCEL'
  | 'SERVICE'
  | 'SERVICE_UNKNOWN'
  | 'SERVICE_MISSING'
  | 'DUPLICATE'
  | 'TARIFF_ONLY'
  /** KALANLAR 1.9: tarifede iki ya da daha çok mesafe bölgesi var; gönderinin bölgesi faturadan doğrulanamaz (fiyat farkı). */
  | 'ZONE_DISTANCE'
  | 'EXTREME_RATE'
  | 'EXTREME_WEIGHT'
  | 'FUEL_RATE'
  | 'FUEL_UNKNOWN'
  | 'FUEL_SURCHARGE'
  | 'FX_STALE';

/**
 * Mükerrer satırın önceki görünümü (KARARLAR "Mükerrer"): aynı taşıyıcı ve aynı tutar ise kesin, değilse "İncele"
 * (ek fatura ya da ek ücret satırı olabilir). Verilmezse eski davranış: kesin.
 */
export type DuplicatePrior = {
  sameCarrier: boolean;
  sameAmount: boolean;
  /** Önceki görünüm aynı dosyada, üst satırda. */
  sameFile?: boolean;
  invoiceNo?: string | null;
  amount?: number | null;
  currency?: string | null;
  /**
   * İnceleme 2026-11-13: aynı takip no için tutarı hiçbir önceki ücrete eşit olmayan bir iade (eksi satır) var (bu dosyada
   * ya da önceki faturada). Ücret iptal edilip yeniden faturalanmış olabilir: mükerrer kesin sayılmaz. Tutarı eşit iade
   * önceki ücreti iptal eder; o ücret önceki görünüm sayılmaz (API `cancelCredits`).
   */
  unmatchedCredit?: boolean;
  /**
   * KALANLAR 1.8: önceki faturadaki aynı tutarlı görünümün açıklaması (hizmet adı ve ek ücret kodları) bu satırınkiyle aynı mı.
   * `false`: aynı tutarlı ama başka bir ücret olabilir (göndericiye iade, ek hizmet): mükerrer kesin sayılmaz. Verilmezse aynı.
   */
  sameDescription?: boolean;
};

/**
 * Satırın fiyat karşılaştırması (taşıyıcının faturadaki fiyatı ↔ tarife, faturanın kendi ücretli kg'ında). Ölçümden
 * bağımsızdır: ölçümü olmayan satırlarda da hesaplanır, "Tarife uyumu" raporu bununla kurulur.
 */
export type RateInfo = {
  zone: string;
  /** Faturanın ücretli kg'ı (faturadaki kg ya da faturadaki ölçülerin hacimsel ağırlığı, büyüğü; basamaklı). */
  kg: number;
  /** `split`: taşıma (liste − indirim) ve yakıt ayrı; `combined`: faturada ayrım yok, taşıma + yakıt birlikte. */
  mode: 'split' | 'combined';
  /** Faturadaki taşıma bedeli (combined'da taşıma + yakıt), satır para biriminde. */
  billedFreight: number;
  /** Tarifenin aynı kg'daki taşıma bedeli (combined'da taşıma + yakıt), satır para biriminde (istisna dahil). */
  contractFreight: number;
  /** Uygulanan ülke istisnası (%, yoksa 0). */
  adjustmentPct: number;
  /** Faturadaki yakıt oranı (%; yakıt ayrı yazmıyorsa null) — tarife uyumu raporunda tarifedeki oranla kıyaslanır. */
  fuelPct: number | null;
};

export type ComparisonResult = {
  status: ComparisonStatus;
  diffTypes: DiffType[];
  ourChargeableKg: number | null;
  billedChargeableKg: number | null;
  expectedAmount: number | null;
  billedAmount: number;
  /**
   * Faturalanan − Beklenen. Beklenen, varsayılan ayarda tarifede tanımlı olmayan ek ücretleri faturadaki tutarıyla
   * içerir (`uncheckedSurchargeTotal`); bu kalemler iki tarafta eşit olduğundan fark tarifenin tanımladığı kısımdan doğar.
   */
  diffAmount: number | null;
  /**
   * Beklenen'e faturadaki tutarıyla eklenen (tarifede tanımlı olmadığı için kontrol edilemeyen) ek ücretlerin toplamı,
   * satır para biriminde; yoksa 0. Beklenen − bu = tarifeye göre hesaplanan tutar.
   */
  uncheckedSurchargeTotal: number;
  /** Kur çevrilen satırlarda kalemler tarife para biriminde (`currency`), son kalem çevrimdir (`fx`). */
  breakdown: BreakdownLine[];
  note?: string;
  /** Tarife para birimi satırınkinden farklıysa uygulanan kur. */
  fx?: FxApplied;
  /**
   * Yalnız `NO_TARIFF` ve neden kurun bulunamaması (not `compare.fxMissing`): notun parametreleri (`date` biçimlenmiş).
   * API notu metne bakmadan buna göre "TCMB yanıt vermedi" notuna çevirir (Y144). Sonuç sütunu değildir, saklanmaz.
   */
  fxMissing?: FxMissing;
  /**
   * Y18: hesapta saklı (bayat) kur kullanıldı (`FxRate.stale`; satır kuru ya da tolerans kuru): o kurun yayın günü, ISO.
   * Not `compare.fxStale` ile aynı bilgiyi metin olarak taşır; mantık bu alana bakar. API `pricing.fxStale` olarak saklar.
   */
  fxStale?: string;
  /** Beklenen'in dayanağı; beklenen hesaplanmadıysa null. */
  pricingBasis: PricingBasis | null;
  /** Faturadaki taşıma bedelinin tarifeye göre sapması (%, işaretli; −15 = tarifeden %15 ucuz); hesaplanamazsa null. */
  rateDeviationPct: number | null;
  confidence: Confidence;
  /** LOW ise kısa Türkçe gerekçe. */
  confidenceReason: string | null;
  /** LOW ise gerekçenin sınıfı; HIGH ise yok. */
  reviewCode?: ReviewCode;
  /** Fiyat karşılaştırmasının ayrıntısı (rapor için); hesaplanamazsa null. */
  rate: RateInfo | null;
};

export const FX_TOLERANCE_NOTE = t('tr', 'compare.fxToleranceNote');
export const UNCHECKED_SURCHARGE_NOTE = t('tr', 'compare.uncheckedNote');

export const STATUS_LABELS: Record<ComparisonStatus, string> = {
  MATCH: t('tr', 'compare.status.MATCH'),
  DIFF: t('tr', 'compare.status.DIFF'),
  UNMATCHED: t('tr', 'compare.status.UNMATCHED'),
  NO_TARIFF: t('tr', 'compare.status.NO_TARIFF'),
};

export const DIFF_TYPE_LABELS: Record<DiffType, string> = {
  DUPLICATE: t('tr', 'compare.diff.DUPLICATE'),
  DIMENSION: t('tr', 'compare.diff.DIMENSION'),
  WEIGHT: t('tr', 'compare.diff.WEIGHT'),
  SURCHARGE: t('tr', 'compare.diff.SURCHARGE'),
  PRICE: t('tr', 'compare.diff.PRICE'),
};

/** `STATUS_LABELS` istenen dilde. */
export function statusLabel(status: ComparisonStatus, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, `compare.status.${status}`);
}

/** `DIFF_TYPE_LABELS` istenen dilde. */
export function diffTypeLabel(type: DiffType, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, `compare.diff.${type}`);
}

export const FAVOURABLE_NOTE = t('tr', 'compare.favourable');
export const PAK_NOTE = t('tr', 'compare.pak');

/** |sapma| bundan büyükse satır tahmini (LOW): taşıyıcı büyük olasılıkla başka hizmet/bölge fiyatı uyguluyor. */
export const EXTREME_RATE_DEVIATION_PCT = 35;
/** Fatura ile ölçüm ücretli kg'ı arasındaki oran bundan büyükse satır tahmini (LOW): eşleşme yanlış olabilir. */
export const EXTREME_WEIGHT_RATIO = 4;
export const INVOICE_BASIS_NOTE = t('tr', 'compare.invoiceBasisNote');

/** Faturadaki ücretli ağırlık: faturada yazan; yoksa faturadaki ölçü + gerçek ağırlıktan; o da yoksa gerçek ağırlıktan. */
export function billedChargeableKg(line: ParsedInvoiceLine, tariff: TariffInput | null): number | null {
  if (line.billedKg != null) return round3(line.billedKg);
  const steps = tariff?.weightSteps ?? [];
  const divisor = line.billedDivisor ?? tariff?.divisor;
  if (line.dims && divisor) {
    return chargeableWeight({
      dims: line.dims,
      actualKg: line.actualKg ?? 0,
      divisor,
      edgeRounding: tariff?.edgeRounding ?? 'CEIL_CM',
      steps,
      rates: tariff?.rates,
    }).chargeable;
  }
  if (line.actualKg != null) return roundUpToStep(line.actualKg, steps, tariff?.rates);
  return null;
}

/**
 * Faturadaki ücretli kg yazılıyken faturadaki ölçülerin hacimsel ağırlığı (kenar yuvarlamasız) bundan en az bu oranda
 * büyükse ücretli kg sütunu gerçek ağırlık sayılır. Küçük farklar inç→cm çevirisindendir (19 in = 48,26 cm; taşıyıcı
 * hacmi inçle hesaplar), yok sayılır.
 */
const BILLED_VOL_SLACK = 1.02;

/**
 * Taşıyıcının fiyatlandırdığı ücretli kg (fiyat karşılaştırması için), tarifenin basamağına yukarı yuvarlanmış:
 * - faturada ücretli kg yazıyorsa o (taşıyıcının kendi hacim hesabını içerir; faturadaki ölçülerden yeniden hesaplamak
 *   inç→cm ve kenar yuvarlaması yüzünden bir basamak fazla verebilir) — faturadaki ölçülerin hacimsel ağırlığı
 *   %2'den fazla büyük değilse;
 * - yoksa max(gerçek kg, faturadaki ölçülerin hacimsel ağırlığı; bölen faturadaki ya da tarifeninki).
 * Faturada ne ağırlık ne ölçü varsa null.
 */
export function billedPricingKg(line: ParsedInvoiceLine, tariff: TariffInput): number | null {
  const divisor = line.billedDivisor ?? tariff.divisor;
  let raw: number;
  if (line.billedKg != null && line.billedKg > 0) {
    const volRaw = line.dims && divisor ? volumetricWeight(line.dims, divisor, 'NONE') : 0;
    raw = volRaw > line.billedKg * BILLED_VOL_SLACK ? volumetricWeight(line.dims!, divisor, tariff.edgeRounding) : line.billedKg;
  } else {
    if (line.actualKg == null && !line.dims) return null;
    const vol = line.dims && divisor ? volumetricWeight(line.dims, divisor, tariff.edgeRounding) : 0;
    raw = Math.max(line.actualKg ?? 0, vol);
  }
  return raw > 0 ? roundUpToStep(raw, tariff.weightSteps, tariff.rates) : null;
}

/**
 * Faturadaki taşıma bedeli ve yakıt (satır para biriminde):
 * - liste tutarı varsa taşıma = liste − indirim; yakıt = faturadaki yakıt, yoksa net − taşıma − ek ücretler (kalan, ≥ 0);
 * - liste yok, yakıt varsa taşıma = net − yakıt − ek ücretler;
 * - ikisi de yoksa ayrım yapılamaz: taşıma + yakıt = net − ek ücretler (`combined`).
 */
export function billedFreight(line: ParsedInvoiceLine): { mode: 'split' | 'combined'; freight: number; fuel: number | null } | null {
  const sur = sumMoney(line.surcharges.map((s) => s.amount));
  let out: { mode: 'split' | 'combined'; freight: number; fuel: number | null };
  if (line.baseAmount != null) {
    const freight = subMoney(line.baseAmount, Math.abs(line.discountAmount ?? 0));
    const rest = subMoney(subMoney(line.netAmount, freight), sur);
    out = { mode: 'split', freight, fuel: line.fuelAmount ?? Math.max(0, rest) };
  } else if (line.fuelAmount != null) {
    out = { mode: 'split', freight: subMoney(subMoney(line.netAmount, line.fuelAmount), sur), fuel: line.fuelAmount };
  } else {
    out = { mode: 'combined', freight: subMoney(line.netAmount, sur), fuel: null };
  }
  return out.freight > 0 ? out : null;
}

/** Yakıt oranı bundan büyükse (ör. yanlış eşlenmiş sütun) faturadaki oran kullanılmaz. */
export const MAX_INVOICE_FUEL_PCT = 60;

/**
 * Faturadaki yakıt oranı (%) = yakıt / taşıma (liste − indirim ya da net − yakıt − ek ücretler); yakıt ayrı yazmıyorsa
 * ya da oran makul değilse null.
 */
export function invoiceFuelPct(line: ParsedInvoiceLine): number | null {
  if (line.fuelAmount == null) return null;
  const b = billedFreight(line);
  if (!b || b.mode !== 'split' || !(b.freight > 0)) return null;
  const pct = round2((line.fuelAmount / b.freight) * 100);
  return pct >= 0 && pct <= MAX_INVOICE_FUEL_PCT ? pct : null;
}

/**
 * Yakıtı değişken tarifede kabul edilecek fatura oranı (%) = yakıt / (net − yakıt − ek ücretler). Payda taşıyıcının gerçekten
 * aldığı taşıma bedelidir: navlun sütunu liste fiyatını yazıp indirim sütunu hiç yoksa `invoiceFuelPct` oranı liste
 * fiyatına böler ve düşük bulur (inceleme 2026-11-10: sözleşme fiyatını uygulayan satır yanlış "Fiyat farkı" oluyordu).
 * Yakıt ayrı yazmıyorsa ya da oran makul değilse (0–60 dışı) null: tarifedeki oran kullanılır.
 */
export function invoiceFuelPctOfNet(line: ParsedInvoiceLine): number | null {
  if (line.fuelAmount == null) return null;
  const freight = subMoney(subMoney(line.netAmount, line.fuelAmount), sumMoney(line.surcharges.map((s) => s.amount)));
  if (!(freight > 0)) return null;
  const pct = round2((line.fuelAmount / freight) * 100);
  return pct >= 0 && pct <= MAX_INVOICE_FUEL_PCT ? pct : null;
}

/** Tutarı faturadaki yakıtı içeren fark türleri: `FUEL_RATE` yalnız bunlardan biri olan satıra konur. */
const FUEL_SENSITIVE_DIFFS: ReadonlySet<DiffType> = new Set<DiffType>(['PRICE', 'WEIGHT', 'DIMENSION']);

/**
 * Faturada pozitif yakıt yazıyor ama `invoiceFuelPctOfNet` onu kabul etmiyor mu: oran %60'ı aşıyor ya da taşıma bedeli
 * (net − yakıt − ek ücretler) kalmıyor. Değişken yakıtlı tarifede böyle satır tarifedeki orana düşer; çıkan fark yanlış
 * eşlenmiş yakıt sütunundan ya da liste fiyatından hesaplanmış yakıttan olabilir, kesin sayılmaz (`FUEL_RATE`). Negatif
 * yakıt (iade) bu sınıfa girmez.
 */
export function implausibleInvoiceFuel(line: ParsedInvoiceLine): boolean {
  if (line.fuelAmount == null || !(line.fuelAmount > 0)) return false;
  return invoiceFuelPctOfNet(line) == null;
}

/** `fuelOnSurcharges` en çok bu kadar ek ücretin alt kümelerini dener (2^n; satırda daha çoksa yalnız tümü). */
const FUEL_SURCHARGE_SUBSET_MAX = 8;

/**
 * DENETIM-2 01-B13: sabit yakıtlı tarifede (`fuelPct` tarifedeki oran) faturadaki yakıt, bu oranın taşıma bedeline değil
 * taşıma + faturadaki ek ücretlerden bazılarına uygulanmış hâli mi? Öyleyse yakıtın taşıma bedelinin üstündeki kısmı
 * (fazla yakıt, satır para biriminde), değilse null. Yakıt ayrı yazılmalı (split) ve oranla taşımaya uygulanmış hâlinden
 * farklı olmalı; ek ücretlerin bir alt kümesi denenir (taşıyıcı yakıtı her ek ücrete uygulamayabilir). Pay kuruş
 * yuvarlamasıdır: kalem başına 1 kuruş (taşıyıcı her kalemin yakıtını ayrı yuvarlayabilir) + 1. Oran farklıysa (yüksek
 * yakıt oranı) tutmaz: fark kesin kalır.
 */
export function fuelOnSurcharges(line: ParsedInvoiceLine, fuelPct: number): number | null {
  if (line.fuelAmount == null || !(line.fuelAmount > 0) || !(fuelPct > 0)) return null;
  const b = billedFreight(line);
  if (!b || b.mode !== 'split') return null;
  const tol = (k: number) => (k + 2) / 100 + EPS;
  const onFreight = pctOf(b.freight, fuelPct);
  if (Math.abs(subMoney(line.fuelAmount, onFreight)) <= tol(0)) return null;
  const amounts = line.surcharges.map((s) => s.amount).filter((a) => a > 0);
  const fits = (sum: number, k: number) => Math.abs(subMoney(line.fuelAmount!, pctOf(sumMoney([b.freight, sum]), fuelPct))) <= tol(k);
  if (amounts.length > FUEL_SURCHARGE_SUBSET_MAX) return fits(sumMoney(amounts), amounts.length) ? subMoney(line.fuelAmount, onFreight) : null;
  for (let mask = 1; mask < 1 << amounts.length; mask++) {
    const picked = amounts.filter((_, i) => mask & (1 << i));
    if (fits(sumMoney(picked), picked.length)) return subMoney(line.fuelAmount, onFreight);
  }
  return null;
}

/**
 * Kullanıcı adına verilen karar (2026-11-12 gece, DENETIM-2 B2 / eski Y17): değişken yakıtlı tarifede faturada yakıt ayrı
 * yazılmamışsa (navlunun içinde) fiyat farkı kesin sayılmaz, "İncele" olur (`FUEL_UNKNOWN`). Geri almak: `false` yapın
 * (kural yalnız `compareLineTr` adım 11'de bu sabite bakar; test `kesinFark.test.ts` "B2" bloğu da değişir).
 */
export const VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW = true;

/**
 * Faturanın satırlarında birbirinden farklı hizmet sınıfları var mı (`serviceMismatch` kuralıyla, ör. "International
 * Economy" ile "International Priority")? Pak/zarf satırları karşılaştırmaya girmediği için sayılmaz; boş ya da sınıf
 * sözcüğü taşımayan adlar hüküm vermez. API faturanın tüm satırları için bir kez hesaplar (`mixedServices`).
 */
export function invoiceHasMixedServices(services: Iterable<string | null | undefined>): boolean {
  const names = [...new Set([...services].map((s) => s?.trim() ?? '').filter((s) => s && !isPakService(s) && serviceClassWords(s).length > 0))];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) if (serviceMismatch(names[a], names[b])) return true;
  return false;
}

/** Faturadaki ölçülerden herhangi bir kenar (sıralı karşılaştırma) bizimkinden tol'den fazla büyük mü? */
export function edgesExceed(billed: Dims, ours: Dims, edgeTolCm: number): boolean {
  const b = sortedEdges(billed);
  const o = sortedEdges(ours);
  return b.some((x, i) => x > o[i]! + edgeTolCm + EPS);
}

/** Faturadaki hizmet adı pak/zarf mı? (ör. "FedEx Intl Priority Pak", "FedEx Envelope", "UPS Express Envelope") */
export function isPakService(service: string | null | undefined): boolean {
  return !!service && /(^|[^\p{L}])(pak|envelope|zarf|letter|mektup)([^\p{L}]|$)/iu.test(service);
}

const g = (kg: number) => Math.round(round3(kg) * 1000);
const EPS = 1e-9;

function joinNotes(notes: string[]): string | undefined {
  return notes.length ? notes.join(' · ') : undefined;
}

/** "−%14,7" / "+%8"; en: "−14.7%" / "+8%" */
export function fmtSignedPct(p: number, locale: Locale = DEFAULT_LOCALE): string {
  return `${p < 0 ? '−' : '+'}${fmtPct(Math.abs(round2(p)), locale)}`;
}

/** Kur bulunamadı notunun parametreleri (`compare.fxMissing` / `stored.fxFailed`). */
export type FxMissing = { tariff: string; line: string; date: string };

type FxResolution = { ok: true; rate: FxRate | null; lineCur: string; tariffCur: string } | { ok: false; reason: string; fxMissing?: FxMissing };

function resolveFx(line: ParsedInvoiceLine, tariff: TariffInput, fx: FxInput | undefined): FxResolution {
  const tariffCur = tariff.currency.trim().toUpperCase();
  const lineCur = line.currency?.trim() ? line.currency.trim().toUpperCase() : tariffCur;
  if (lineCur === tariffCur) return { ok: true, rate: null, lineCur, tariffCur };
  if (fx === undefined) return { ok: false, reason: t('tr', 'compare.currencyMismatch', { line: lineCur, tariff: tariffCur }) };
  const r = fx.rate;
  if (!r || r.base.toUpperCase() !== tariffCur || r.quote.toUpperCase() !== lineCur || !(r.rate > 0)) {
    const fxMissing: FxMissing = { tariff: tariffCur, line: lineCur, date: fmtDate(fx.date) };
    return { ok: false, reason: t('tr', 'compare.fxMissing', fxMissing), fxMissing };
  }
  return { ok: true, rate: r, lineCur, tariffCur };
}

type RateCheck =
  | (RateInfo & {
      ok: true;
      /** Faturadaki yakıt (split; combined'da null). */
      billedFuel: number | null;
      /** Tarifenin faturadaki kg'daki liste fiyatı (tarife para biriminde; ölçekleme paydası). */
      listAtKg: number;
      /** Ölçeklenebilir kısım (taşıma + yakıt): faturadaki ve tarifedeki (satır para biriminde). */
      billedScalable: number;
      contractScalable: number;
      deviationPct: number;
    })
  | { ok: false; reason: string; zone: string | null };

/** Taşıyıcının faturadaki fiyatı ↔ tarife, faturanın kendi ücretli kg'ında (ölçümden bağımsız). */
function rateCheck(line: ParsedInvoiceLine, tariff: TariffInput, conv: (n: number) => number, atKg?: number, fuelPct?: number): RateCheck {
  const zone = resolveZone(tariff, line.destCountry);
  const kg = atKg ?? billedPricingKg(line, tariff);
  if (kg == null) return { ok: false, reason: t('tr', 'compare.noBilledKg'), zone };
  const b = billedFreight(line);
  if (!b) return { ok: false, reason: t('tr', 'compare.noBilledFreight'), zone };
  const exp = expectedCharge({ tariff, chargeableKg: kg, destCountry: line.destCountry, fuelPct });
  if (!exp.ok || !(exp.base > 0)) return { ok: false, reason: t('tr', 'compare.noPriceAtKg', { kg: fmtKg(kg) }), zone };
  const contractFreight = b.mode === 'split' ? conv(exp.freight) : conv(sumMoney([exp.freight, exp.fuel]));
  if (!(contractFreight > 0)) return { ok: false, reason: t('tr', 'compare.noPriceAtKg', { kg: fmtKg(kg) }), zone };
  const billedScalable = sumMoney([b.freight, b.fuel ?? 0]);
  const contractScalable = conv(sumMoney([exp.freight, exp.fuel]));
  return {
    ok: true,
    zone: exp.zone,
    kg,
    mode: b.mode,
    billedFreight: b.freight,
    billedFuel: b.fuel,
    contractFreight,
    adjustmentPct: exp.adjustmentPct,
    fuelPct: invoiceFuelPct(line),
    listAtKg: exp.base,
    billedScalable,
    contractScalable,
    deviationPct: round2((b.freight / contractFreight - 1) * 100),
  };
}

/** DENETIM-2 B3: taşıyıcının taşıma + yakıtı, tarifenin bizim basamağımızdaki fiyatından tolerans ötesinde pahalı mı? */
function pricedAboveStep(rc: RateCheck, amountTolFor: (expected: number) => number): boolean {
  return rc.ok && rc.billedScalable > rc.contractScalable + amountTolFor(rc.contractScalable) + EPS;
}

/**
 * DENETIM-2 B3 (bağımsız inceleme): taşıyıcının taşıma + yakıtı, tarifenin faturadaki basamağındaki fiyatına en az tolerans
 * kadar yakın mı (üst basamağın fiyatı alınmış)? İki basamağın arasında kalan fiyat (bizim basamağımıza zam, navluna katılmış
 * güncel yakıt) basamak kanıtı değildir: ağırlık farkı sayılırsa fatura dayanağı tutarı şişirir ve yakıt kuralı atlanır.
 */
function pricedAtStep(rc: RateCheck, amountTolFor: (expected: number) => number): boolean {
  return rc.ok && rc.billedScalable >= rc.contractScalable - amountTolFor(rc.contractScalable) - EPS;
}

const rateInfoOf = (rc: RateCheck): RateInfo | null =>
  rc.ok
    ? { zone: rc.zone, kg: rc.kg, mode: rc.mode, billedFreight: rc.billedFreight, contractFreight: rc.contractFreight, adjustmentPct: rc.adjustmentPct, fuelPct: rc.fuelPct }
    : null;

const NO_PRICING = { pricingBasis: null, rateDeviationPct: null, confidence: 'HIGH' as Confidence, confidenceReason: null, rate: null };

/** Kayıtlı döküm satırlarının (`breakdown` JSON'u) etiketlerini çevirir; tutarlara dokunmaz. Dizi değilse olduğu gibi döner. */
export function localizeBreakdown<T>(breakdown: T, locale: Locale = DEFAULT_LOCALE): T {
  if (locale === 'tr' || !Array.isArray(breakdown)) return breakdown;
  return breakdown.map((b) => (b && typeof b === 'object' && typeof (b as BreakdownLine).label === 'string' ? { ...b, label: localizeLabel((b as BreakdownLine).label, locale) } : b)) as T;
}

/** "İspanya istisnası −%15,45" etiketinde ülke adı da çevrilir. */
function localizeLabel(label: string, locale: Locale): string {
  const adj = /^(.+) istisnası (.+)$/.exec(label);
  const code = adj ? countryNameToIso2(adj[1]!) : null;
  return localizeText(code ? `${countryName(code, locale)} istisnası ${adj![2]}` : label, locale);
}

/**
 * Sonucun metinlerini (not, güven gerekçesi, döküm etiketleri) çevirir; sayılara dokunmaz. Veritabanındaki satırlar
 * Türkçe saklandığı için okurken de kullanılır.
 */
export function localizeComparison<T extends Pick<ComparisonResult, 'breakdown'> & { note?: string | null; confidenceReason?: string | null }>(r: T, locale: Locale = DEFAULT_LOCALE): T {
  if (locale === 'tr') return r;
  return { ...r, note: localizeText(r.note, locale), confidenceReason: localizeText(r.confidenceReason, locale), breakdown: localizeBreakdown(r.breakdown, locale) };
}

/** Kur bulunamadı/alınamadı notu mu? (Her iki dilde; ekran bu notta ayrı açıklama gösterir.) */
export function isFxMissingNote(note: string | null | undefined): boolean {
  if (!note) return false;
  const prefix = (s: string) => s.slice(0, s.indexOf(' ('));
  return [t('tr', 'compare.fxMissing'), t('tr', 'stored.fxFailed'), t('en', 'compare.fxMissing'), t('en', 'stored.fxFailed')].some((s) => note.startsWith(prefix(s)));
}

export type CompareLineInput = {
  line: ParsedInvoiceLine;
  measurement: MeasurementInput | null;
  tariff: TariffInput | null;
  tol: Tolerances;
  isDuplicate: boolean;
  /** Mükerrerin önceki görünümü; verilmezse mükerrer kesin sayılır. */
  duplicatePrior?: DuplicatePrior | null;
  /**
   * İnceleme 2 (2026-11-13): bu ücret aynı faturadaki eşit tutarlı bir iadeyle iptal edildi (API `cancelCredits`): iade
   * satırı gibi karşılaştırılmaz (not `compare.creditCancelled`), fark ve itiraz yok.
   */
  cancelledByCredit?: boolean;
  /**
   * Satır ile tarife para birimi farklıysa kullanılacak kur (1 tarife birimi = rate satır birimi).
   * Verilmezse eski davranış: "Para birimi uyuşmuyor"; verilip `rate` null ise "Kur bulunamadı".
   */
  fx?: FxInput;
  /**
   * Y18: `tol.amountTol` firma para biriminden satır para birimine çevrildiyse çevrimin kuru. `rate` null: tolerans
   * çevrilemedi, satır fiyat karşılaştırmasına girmez (NO_TARIFF + `fxMissing`, çifti firma→satır para birimi).
   * Verilmezse tolerans olduğu gibi kullanılır (aynı para birimi).
   */
  tolFx?: TolFxInput;
  /**
   * DENETIM-2 B1: faturanın satırlarında farklı hizmet sınıfları var (`invoiceHasMixedServices`). Tarifenin hizmeti boş
   * ya da tanınmıyorsa fark satırı "İncele" olur (`SERVICE_UNKNOWN`). Verilmezse karışık değil sayılır (eski davranış).
   */
  mixedServices?: boolean;
  /**
   * K39: faturanın hiçbir satırında hizmet adı yok (hizmet sütunu yok; yurt içi tablolarında olağan). Satırın boş hizmeti
   * bu durumda bir şey söylemez, K39 kuralı (`SERVICE_MISSING`) uygulanmaz: tarife bu fatura için seçilmiştir. Verilmezse
   * kural uygulanır. API faturanın tüm satırlarından bir kez hesaplar.
   */
  invoiceLacksServices?: boolean;
  /**
   * KALANLAR 1.8: bu takip no bu dosyada birden çok ücret satırında (iade ile iptal edilenler sayılmaz). Çok kolili gönderi ya
   * da ayrı ücret satırı olabilir: satırın hiçbir farkı (mükerrer dahil) kesin sayılmaz. API dosyanın tüm satırlarından hesaplar.
   */
  repeatedInFile?: boolean;
  /**
   * KALANLAR 1.8: eşleşen ölçümün zincirinde birden çok bağımsız ölçüm var (telefonda "Yeniden ölç"; API
   * `remeasuredMeasurements`). Ölçüm kolilerden biri olabilir: ağırlık/ölçü farkı kesin sayılmaz.
   */
  remeasured?: boolean;
  /**
   * Yalnız metinler. Sonuç önce Türkçe hesaplanır, sonra çevrilir; sayılar aynı yoldan gelir. Veritabanına yazılacak
   * sonuçta verilmez: notlar kanonik Türkçe saklanır, gösterirken `localizeComparison` ile çevrilir.
   */
  locale?: Locale;
};

export function compareLine(i: CompareLineInput): ComparisonResult {
  return localizeComparison(compareLineTr(i), i.locale ?? DEFAULT_LOCALE);
}

/**
 * KALANLAR 1.9 (inceleme): mesafe bölgeli tarife (fiyat satırlarında ≥ 2 mesafe bölgesi, `distanceZoneCount`). Bölge yalnız
 * varış ülkesinden ya da `*`'dan bulunur; gönderinin gerçek bölgesi faturadan bilinmez. Kesin (HIGH) fark satırı
 * tarifenin her bölgesiyle yeniden hesaplanır; kesin borç, bölgelerin en küçük farkıdır (gönderi hangi bölgede olursa olsun
 * en az bu kadar fazla ödenmiştir; ağırlık farkında da bölge fiyat aralığı talebe girmez):
 * - en küçük fark sıfırdan büyükse o bölgenin sonucu döner (tutar, tür, döküm, güven o bölgeden) ve notu bölgeyi söyler;
 * - bir bölgede fark yoksa (ya da yalnız "İncele") satır "İncele" olur (`ZONE_DISTANCE`), tutarlar `*` bölgesinden kalır.
 * Faturalanan en pahalı bölgenin fiyatından da yüksekse aradaki kısım böylece kesin kalır.
 */
function compareLineTr(i: CompareLineInput): ComparisonResult {
  const r = compareLineCore(i);
  const tariff = i.tariff;
  // "Tarifeden çok farklı" (EXTREME_RATE) mesafe bölgeli tarifede çoğu zaman bölge farkıdır: o satır da bölge bölge denenir
  const extreme = r.confidence === 'LOW' && r.reviewCode === 'EXTREME_RATE';
  if (!tariff || r.status !== 'DIFF' || (r.confidence !== 'HIGH' && !extreme) || r.diffTypes.includes('DUPLICATE') || distanceZoneCount(tariff) < 2) return r;
  // Yalnız `*` ya da bir mesafe bölgesiyle fiyatlanan satır, yalnız mesafe bölgeleriyle denenir: ülkesi ayrı bölgeye bağlı
  // gönderi (DE → EU1) yurt içi mesafelerle karşılaştırılmaz (inceleme bulgusu)
  const { ['*']: _star, ...explicit } = tariff.zones;
  const resolved = resolveZone(tariff, i.line.destCountry);
  const viaStar = resolveZone({ ...tariff, zones: explicit }, i.line.destCountry) == null;
  if (!resolved || (!viaStar && distanceZoneCode(resolved) == null)) return r;
  const zones = [...new Map(tariff.rates.filter((x) => distanceZoneCode(x.zone) != null).map((x) => [zoneKey(x.zone), x.zone])).values()];
  let best: { zone: string; r: ComparisonResult; amount: number } | null = null;
  for (const zone of zones) {
    // `*` ve mesafe bölgesine bağlı ülkeler bu bölgeye; başka bölgeye bağlı ülkeler olduğu gibi
    const mapped = Object.fromEntries(Object.entries(tariff.zones).map(([k, v]) => [k, distanceZoneCode(v) != null ? zone : v]));
    const forced: TariffInput = { ...tariff, zones: { ...mapped, '*': zone } };
    const rz = compareLineCore({ ...i, tariff: forced });
    // o bölgede olsaydı fazla ödenen (güveni ne olursa olsun); fark yok, tarife yok ya da hesaplanamadı → 0 (kesin değil)
    const amount = rz.status === 'DIFF' ? Math.max(0, rz.diffAmount ?? 0) : 0;
    if (!best || amount < best.amount) best = { zone, r: rz, amount };
  }
  if (best && best.amount > 0) {
    return { ...best.r, note: joinNotes([best.r.note, t('tr', 'compare.zoneDistanceMin', { zone: best.zone })].filter((x): x is string => !!x)) };
  }
  if (extreme) return r;
  return { ...r, confidence: 'LOW', confidenceReason: t('tr', 'compare.confidence.zoneDistance'), reviewCode: 'ZONE_DISTANCE' };
}

function compareLineCore(i: CompareLineInput): ComparisonResult {
  const { line, measurement, tariff, tol } = i;
  const billedAmount = line.netAmount;
  const billedKg = billedChargeableKg(line, tariff);
  const ours =
    measurement && tariff
      ? chargeableWeight({
          dims: measurement.dims,
          actualKg: measurement.actualKg,
          divisor: tariff.divisor,
          edgeRounding: tariff.edgeRounding,
          steps: tariff.weightSteps,
          rates: tariff.rates,
        })
      : null;
  const ourKg = ours ? ours.chargeable : null;

  // 0. İade / düzeltme (DENETIM-2 01-B11): eksi tutarlı satır taşıyıcının alacak kaydıdır, gönderi ücreti değil. Tarifeyle
  // karşılaştırılmaz (beklenen ve fark boş: özetin Beklenen'ine ve fazla ödemeye girmez, Faturalanan'ın fatura toplamında
  // kalır) ve mükerrer sayılmaz (iade, aynı takip no'nun önceki ücretine yazılır). Sıfır tutarlı satır (ücretsiz gönderi,
  // kampanya; kullanıcı kararı 2026-11-13) aynı biçimde karşılaştırılmaz, kendi notuyla: eskiden tam tarife bekleyip
  // Beklenen'i şişiriyordu. API ikisini de mükerrer kuralında önceki görünüm saymaz.
  if (line.netAmount < 0 || line.netAmount === 0 || i.cancelledByCredit) {
    return {
      status: 'NO_TARIFF',
      diffTypes: [],
      ourChargeableKg: ourKg,
      billedChargeableKg: billedKg,
      expectedAmount: null,
      billedAmount,
      diffAmount: null,
      uncheckedSurchargeTotal: 0,
      breakdown: [],
      note: t('tr', line.netAmount < 0 ? 'compare.credit' : line.netAmount === 0 ? 'compare.freeLine' : 'compare.creditCancelled'),
      ...NO_PRICING,
    };
  }

  // 1. Mükerrer: aynı taşıyıcı + aynı tutar kesin; değilse "İncele" (ek fatura olabilir)
  if (i.isDuplicate) {
    const prior = i.duplicatePrior;
    const lineCurText = line.currency?.trim() ? line.currency.trim().toUpperCase() : (tariff?.currency ?? '').trim().toUpperCase();
    const priorAmount = prior?.amount != null ? fmtMoney(prior.amount, (prior.currency?.trim() || lineCurText || 'TRY').toUpperCase()) : '—';
    const priorInvoice = prior?.invoiceNo?.trim() || '—';
    let reason: string | null = null;
    if (prior && !prior.sameCarrier) reason = t('tr', 'compare.confidence.duplicateCarrier', { invoice: priorInvoice });
    else if (prior?.unmatchedCredit) reason = t('tr', 'compare.confidence.duplicateCredit');
    else if (prior && !prior.sameAmount) {
      reason = prior.sameFile
        ? t('tr', 'compare.confidence.duplicateAmountFile', { amount: priorAmount })
        : t('tr', 'compare.confidence.duplicateAmount', { invoice: priorInvoice, amount: priorAmount });
    } else if (prior?.sameFile || i.repeatedInFile) {
      // KALANLAR 1.8: aynı dosyada tekrarlanan takip no çok kolili gönderi ya da ayrı ücret satırı olabilir: kesin değil
      reason = t('tr', 'compare.confidence.duplicateFile');
    } else if (prior?.sameDescription === false) {
      // KALANLAR 1.8: aynı tutar ama açıklama farklı (göndericiye iade, ek hizmet): başka bir ücret olabilir
      reason = t('tr', 'compare.confidence.duplicateDescription', { invoice: priorInvoice });
    }
    return {
      status: 'DIFF',
      diffTypes: ['DUPLICATE'],
      ourChargeableKg: ourKg,
      billedChargeableKg: billedKg,
      expectedAmount: null,
      billedAmount,
      diffAmount: billedAmount,
      uncheckedSurchargeTotal: 0,
      breakdown: [],
      note: t('tr', 'compare.duplicate'),
      ...NO_PRICING,
      ...(reason ? { confidence: 'LOW' as Confidence, confidenceReason: reason, reviewCode: 'DUPLICATE' as ReviewCode } : {}),
    };
  }

  // 2. Ölçüm yok — fiyat karşılaştırması (tarife uyumu raporu için) yine yapılır
  const pak = isPakService(line.service);
  if (!measurement) {
    let rate: RateInfo | null = null;
    if (tariff && !pak) {
      const fxr = resolveFx(line, tariff, i.fx);
      if (fxr.ok) rate = rateInfoOf(rateCheck(line, tariff, (n) => (fxr.rate ? convertMoney(n, fxr.rate.rate) : n)));
    }
    return {
      status: 'UNMATCHED',
      diffTypes: [],
      ourChargeableKg: null,
      billedChargeableKg: billedKg,
      expectedAmount: null,
      billedAmount,
      diffAmount: null,
      uncheckedSurchargeTotal: 0,
      breakdown: [],
      note: pak ? PAK_NOTE : t('tr', 'compare.noMeasurement'),
      ...NO_PRICING,
      rateDeviationPct: rate ? round2((rate.billedFreight / rate.contractFreight - 1) * 100) : null,
      rate,
    };
  }

  // 3. Tarife yok
  const noTariff = (note: string): ComparisonResult => ({
    status: 'NO_TARIFF',
    diffTypes: [],
    ourChargeableKg: ourKg,
    billedChargeableKg: billedKg,
    expectedAmount: null,
    billedAmount,
    diffAmount: null,
    uncheckedSurchargeTotal: 0,
    breakdown: [],
    note,
    ...NO_PRICING,
  });
  if (!tariff || !ours || ourKg == null) return noTariff(t('tr', 'compare.noTariff'));
  // Pak/zarf koli tarifesiyle karşılaştırılmaz (taşıyıcı ayrı fiyat uygular; DeciShip koli desisini ölçer)
  if (pak) return noTariff(t('tr', 'compare.pakNoTariff'));
  const fxr = resolveFx(line, tariff, i.fx);
  if (!fxr.ok) return fxr.fxMissing ? { ...noTariff(fxr.reason), fxMissing: fxr.fxMissing } : noTariff(fxr.reason);
  // Y18: tutar toleransı satır para birimine çevrilemediyse sabit bir yedek oran kullanılmaz; satır "kur yok" sınıfında kalır
  const tolFx = i.tolFx;
  if (tolFx && !(tolFx.rate && tolFx.rate.rate > 0)) {
    const fxMissing: FxMissing = { tariff: tolFx.base.toUpperCase(), line: tolFx.quote.toUpperCase(), date: fmtDate(tolFx.date) };
    return { ...noTariff(t('tr', 'compare.fxMissing', fxMissing)), fxMissing };
  }
  const { lineCur, tariffCur } = fxr;
  const fxRate = fxr.rate;
  /** Y18: saklı (bayat) kurun yayın günü; satır kuru önce, yoksa tolerans kuru. */
  const fxStale = fxRate?.stale ? fxRate.date : tolFx?.rate?.stale ? tolFx.rate.date : undefined;
  /** Notta gösterilen bayat kur günleri (iki kur da bayatsa ikisi, farklıysa). */
  const staleDays = [...new Set([fxRate?.stale ? fxRate.date : null, tolFx?.rate?.stale ? tolFx.rate.date : null].filter((d): d is string => !!d))]
    .map((d) => fmtDate(d))
    .join(', ');
  /** Tarife para birimindeki tutarı satır para birimine çevirir (aynıysa dokunmaz). */
  const conv = (n: number) => (fxRate ? convertMoney(n, fxRate.rate) : n);
  const fxPct = tol.fxTolerancePct ?? DEFAULT_FX_TOLERANCE_PCT;
  /** Tutar toleransı: kur çevrilen satırda max(sabit tolerans, beklenenin %fxPct'i). */
  const amountTolFor = (expected: number) => (fxRate ? Math.max(tol.amountTol, pctOf(Math.abs(expected), fxPct)) : tol.amountTol);
  let fxAbsorbed = false;
  const knownCodes = line.surcharges.filter((s) => findTariffSurcharge(tariff, s.code)).map((s) => s.code);
  // Yakıt: tarifede "sözleşmede sabit" ise tarifedeki oranla beklenir (yüksek oran fiyat farkıdır, SPEC §3.2); "değişken"
  // ise ve fatura yakıtı ayrı yazıyorsa faturadaki oran kabul edilir (fatura başında oran notu çıkar, tarife uyumu raporu).
  const invoiceFuel = tariff.fuelVariable ? invoiceFuelPctOfNet(line) : null;
  const fuelPct = invoiceFuel != null && invoiceFuel !== tariff.fuelPct ? invoiceFuel : undefined;

  const types: DiffType[] = [];
  const notes: string[] = [];

  // 4–5. Ağırlık / ölçü. Kendi ölçümümüzün her kenarına tolerans kadar pay eklenir (KARARLAR "Ölçüm sınırı"): taşıyıcının
  // ağırlığı bu payla hesaplanan ağırlığı aşmıyorsa fark sayılmaz, beklenen taşıyıcının ağırlığında hesaplanır (fiyat
  // farkı yine görünür). Aşıyorsa (başka bölen, gerçek ölçü farkı) fark kesindir.
  const paddedKg =
    tol.edgeTolCm > 0
      ? chargeableWeight({
          dims: { l: measurement.dims.l + tol.edgeTolCm, w: measurement.dims.w + tol.edgeTolCm, h: measurement.dims.h + tol.edgeTolCm },
          actualKg: measurement.actualKg,
          divisor: tariff.divisor,
          edgeRounding: tariff.edgeRounding,
          steps: tariff.weightSteps,
          rates: tariff.rates,
        }).chargeable
      : ourKg;
  /** Beklenenin hesaplandığı ücretli kg: bizim ölçümümüz; fark ölçüm toleransı içindeyse taşıyıcının ağırlığı. */
  let pricingKg = ourKg;
  // Sınır taşıyıcının fiyatlandırdığı basamakla karşılaştırılır: 6,1 kg faturalanıp 6,5 kg fiyatı alınmışsa paylı 6,0 kg'ı
  // aşmıştır (inceleme 2026-11-10: ham kg ile karşılaştırınca fark "Fiyat farkı" olarak ve eksik tutarla çıkıyordu).
  const billedStepped = billedKg != null ? roundUpToStep(billedKg, tariff.weightSteps, tariff.rates) : null;
  // DENETIM-2 B3: ham kg toleransın içinde ama bir üst basamağa düşüyorsa (biz 6,0; fatura 6,05 → 6,5 basamağı) ağırlık
  // farkı yalnız taşıyıcının fiyatı üst basamağı gösteriyorsa sayılır: bizim basamağımızdan pahalı ve faturadaki basamağın
  // tarife fiyatından ucuz değil (tolerans içinde). Bizim basamağımızın fiyatını almışsa bugünkü gibi fark yoktur; arada
  // kalan fiyat bugünkü gibi fiyat farkıdır (güven kuralları, ör. FUEL_UNKNOWN, ona uygulanır).
  const rawOver = billedKg != null && g(billedKg) > g(ourKg) + g(tol.weightTolKg);
  const stepOnlyOver =
    !rawOver &&
    billedStepped != null &&
    g(billedStepped) > g(ourKg) + g(tol.weightTolKg) &&
    pricedAboveStep(rateCheck(line, tariff, conv, ourKg, fuelPct), amountTolFor) &&
    pricedAtStep(rateCheck(line, tariff, conv, billedStepped, fuelPct), amountTolFor);
  const billedOver = rawOver || stepOnlyOver;
  if (billedOver && billedStepped != null && g(billedStepped) <= g(paddedKg)) {
    pricingKg = Math.max(ourKg, billedStepped);
    notes.push(t('tr', 'compare.withinMeasureTol', { cm: String(round2(tol.edgeTolCm)).replace('.', ',') }));
  }
  const exp = expectedCharge({ tariff, chargeableKg: pricingKg, destCountry: line.destCountry, surchargeCodes: knownCodes, fuelPct });
  if (!exp.ok) return noTariff(exp.reason);

  if (billedOver && pricingKg === ourKg && billedKg != null) {
    let dimension = false;
    if (line.dims) {
      const divisor = line.billedDivisor ?? tariff.divisor;
      const billedVol = volumetricWeight(line.dims, divisor, tariff.edgeRounding);
      const billedVolStepped = roundUpToStep(billedVol, tariff.weightSteps, tariff.rates);
      const dimsDriveIncrease = g(billedVolStepped) > g(ourKg) + g(tol.weightTolKg);
      dimension = dimsDriveIncrease && (edgesExceed(line.dims, measurement.dims, tol.edgeTolCm) || g(billedVol) > g(measurement.actualKg));
    }
    types.push(dimension ? 'DIMENSION' : 'WEIGHT');
  }

  // 6. Ek ücretler
  const strictUnknown = tol.unknownSurchargesAsDiff === true;
  const unknown: string[] = [];
  const uncheckedLines: BreakdownLine[] = [];
  const excessive: string[] = [];
  const expectedByCode = new Map<string, number>();
  for (const s of line.surcharges) {
    const ts = findTariffSurcharge(tariff, s.code);
    if (!ts) {
      unknown.push(`${s.name || s.code} ${fmtMoney(s.amount, lineCur)}`);
      uncheckedLines.push({ label: s.name || s.code, amount: s.amount, currency: lineCur, unchecked: true });
      continue;
    }
    const key = canonicalSurchargeCode(ts.code);
    if (!expectedByCode.has(key)) {
      expectedByCode.set(key, conv(surchargeAmount(ts, { base: exp.base, chargeableKg: pricingKg })));
    }
  }
  const billedByCode = new Map<string, number[]>();
  for (const s of line.surcharges) {
    const ts = findTariffSurcharge(tariff, s.code);
    if (!ts) continue;
    const key = canonicalSurchargeCode(ts.code);
    billedByCode.set(key, [...(billedByCode.get(key) ?? []), s.amount]);
  }
  for (const [key, amounts] of billedByCode) {
    const billed = sumMoney(amounts);
    const expected = expectedByCode.get(key) ?? 0;
    const excess = subMoney(billed, expected);
    if (excess > amountTolFor(expected) + EPS) excessive.push(`${key} +${fmtMoney(excess, lineCur)}`);
    else if (excess > tol.amountTol + EPS) fxAbsorbed = true;
  }
  if ((strictUnknown && unknown.length) || excessive.length) {
    types.push('SURCHARGE');
    if (strictUnknown && unknown.length) notes.push(t('tr', 'compare.unknownSurcharge', { list: unknown.join(', ') }));
    if (excessive.length) notes.push(t('tr', 'compare.excessSurcharge', { list: excessive.join(', ') }));
  }
  if (!strictUnknown && unknown.length) notes.push(t('tr', 'compare.unchecked', { list: unknown.join(', ') }));
  const unchecked = strictUnknown ? [] : uncheckedLines;
  const uncheckedTotal = sumMoney(unchecked.map((u) => u.amount));

  // 7. Fiyat dayanağı (SPEC §3.8): taşıyıcının faturadaki kendi fiyatı (faturanın ücretli kg'ında) tarifeden tolerans
  // ötesinde ucuzsa, beklenen taşıma + yakıt bu fiyatın tarifenin ağırlık eğrisiyle bizim kg'a ölçeklenmesidir
  // (müşteri sözleşme ile taşıyıcının gerçek fiyatından düşük olanı öder). Değilse tarife.
  // Faturadaki ağırlık bizimkinden tolerans içinde farklıysa (ağırlık/ölçü farkı yok) taşıyıcı bizim kg'ımızı
  // fiyatlamış sayılır: karşılaştırma bizim kg'ımızda, dayanak tarife (fark = fiyat farkı ya da lehimize fark).
  const tariffAmount = conv(exp.total);
  // Bağımsız inceleme (DENETIM-2 Mesaj 2): yalnız ek ücret farkı olan satırda ağırlık farkı yoktur, taşıyıcının fiyatı bizim
  // kg'ımızda okunur. Eskiden her fark türü faturadaki kg'a geçiriyordu: 6,05 kg yazıp 6,0 fiyatı alınan satırda ek ücret
  // fazlası, fatura dayanağıyla (6,5 basamağına ölçekleme) olduğundan büyük ve kesin çıkıyordu.
  const weightDiff = types.some((x) => x === 'WEIGHT' || x === 'DIMENSION');
  const rc = rateCheck(line, tariff, conv, weightDiff || billedPricingKg(line, tariff) == null ? undefined : pricingKg, fuelPct);
  const invoiceBasis = types.length > 0 && rc.ok && rc.billedScalable < rc.contractScalable - amountTolFor(rc.contractScalable) - EPS;
  let pricedAmount = tariffAmount;
  let invoiceLines: BreakdownLine[] = [];
  /** Fatura dayanağında ölçeklenen yakıt kalemi (adım 9b fazla yakıtı bundan düşer): oran, faturadaki yakıt, kalemin yeri. */
  let scaledFuel: { ratio: number; billed: number; index: number } | null = null;
  if (invoiceBasis && rc.ok) {
    const ratio = exp.base / rc.listAtKg;
    const ratioText = `${fmtNumber(exp.base)}/${fmtNumber(rc.listAtKg)} (${fmtKg(pricingKg)} / ${fmtKg(rc.kg)})`;
    const freight = round2(rc.billedFreight * ratio);
    const fuel = rc.billedFuel != null ? round2(rc.billedFuel * ratio) : 0;
    const surcharges = [...expectedByCode.values()];
    pricedAmount = sumMoney([freight, fuel, ...surcharges]);
    invoiceLines = [
      {
        label: t('tr', rc.mode === 'combined' ? 'compare.breakdown.combinedInvoice' : 'compare.breakdown.freightInvoice', { amount: fmtMoney(rc.billedFreight, lineCur), ratio: ratioText }),
        amount: freight,
        currency: lineCur,
      },
    ];
    if (rc.billedFuel != null && fuel !== 0) {
      scaledFuel = { ratio, billed: rc.billedFuel, index: invoiceLines.length };
      invoiceLines.push({ label: t('tr', 'compare.breakdown.fuelInvoice', { amount: fmtMoney(rc.billedFuel, lineCur), ratio: `${fmtNumber(exp.base)}/${fmtNumber(rc.listAtKg)}` }), amount: fuel, currency: lineCur });
    }
    // bilinen ek ücretler tarifeyle kontrol edilmeye devam eder
    const shown = new Set<string>();
    for (const s of line.surcharges) {
      const ts = findTariffSurcharge(tariff, s.code);
      if (!ts) continue;
      const key = canonicalSurchargeCode(ts.code);
      if (shown.has(key)) continue;
      shown.add(key);
      invoiceLines.push({ label: ts.name || ts.code, amount: expectedByCode.get(key) ?? 0, currency: lineCur });
    }
    notes.push(t('tr', 'compare.invoiceBasis', { pct: fmtSignedPct(rc.deviationPct) }));
  }

  // 8. Beklenen ve fark. Beklenen = fiyat dayanağına göre tutar + tarifede olmayan ek ücretler (faturadaki tutarıyla;
  // katı kuralda yok). Bu kalemler iki tarafta eşit olduğundan fark yalnız tarifenin tanımladığı kısımdan doğar.
  let expectedAmount = sumMoney([pricedAmount, uncheckedTotal]);
  let diffAmount = subMoney(billedAmount, expectedAmount);
  // kur toleransı yalnız kurla çevrilen kısma uygulanır; faturadan alınan kalemler (ölçeklenen fiyat, tarifede olmayan
  // ek ücretler) zaten satır para biriminde
  const priceTol = invoiceBasis ? amountTolFor(sumMoney([...expectedByCode.values()])) : amountTolFor(tariffAmount);

  // 8b. Parasız fark (KARARLAR "Parasız fark"): ağırlık/ölçü farklı yazılmış ama tutara etkisi tolerans içindeyse satır
  // uyumludur; itiraz edilecek para yoktur. Ek ücret farkı varsa para vardır, dokunulmaz.
  // Eşik sabit tutar toleransıdır; kur toleransı (beklenenin yüzdesi) burada kullanılmaz, yoksa dövizli satırda yüzde
  // bir buçuğa kadar ağırlık fazlası "etkisi yok" diye gizlenirdi (inceleme 2026-11-10).
  if (types.length > 0 && !types.includes('SURCHARGE') && diffAmount <= tol.amountTol + EPS) {
    types.length = 0;
    notes.push(t('tr', 'compare.noMoneyEffect'));
  }

  let priceExcess: number | null = null;
  let fuelPassthrough: BreakdownLine | null = null;
  // 9. Fiyat farkı: yalnız tarife dayanağında (taşıyıcı sözleşmeden pahalı — faturadaki fiyatla hesaplananda aynı kg'da
  // fark kalmaz)
  if (types.length === 0 && diffAmount > priceTol + EPS) types.push('PRICE');
  // DENETIM-2 B10: yalnız ek ücret farkı olan satırda taşıma + yakıt da tarifeden pahalıysa o kısım ayrıca "Fiyat farkı"
  // olur (fark iki kısmın toplamıdır; itiraz metni ve türe göre analiz ikisini de görür). Fatura dayanağında (taşıyıcının
  // fiyatı tarifeden ucuz) taşıma kısmında fark yoktur.
  else if (types.length === 1 && types[0] === 'SURCHARGE' && !invoiceBasis) {
    const pricePart = subMoney(subMoney(line.netAmount, sumMoney(line.surcharges.map((s) => s.amount))), conv(sumMoney([exp.freight, exp.fuel])));
    if (pricePart > priceTol + EPS) {
      types.push('PRICE');
      priceExcess = pricePart;
    }
  }

  // 9b. Yakıt ek ücrete de uygulanmış (DENETIM-2 01-B13; inceleme 2026-11-13): sabit yakıtlı tarifede yalnız fazla yakıt
  // belirsizdir (sözleşme yakıtı ek ücrete uygulamaya izin verebilir). Fark fazla yakıttan büyükse kalan kısım kesindir:
  // fazla yakıt Beklenen'e faturadaki tutarıyla eklenir (tarifede olmayan ek ücret gibi, farka etkisi yok), satır kesin
  // kalır. Fark yalnız fazla yakıtsa (kalan ≤ tolerans) tutarlar değişmez, satır "İncele" olur (adım 11, `FUEL_SURCHARGE`).
  // Değişken yakıttaki K40 kuralından (kesin ek ücret farkı + belirsiz yakıt → satırın tamamı "İncele") ayrıdır.
  let fuelSurchargeReview: number | null = null;
  const fuelExcess = !tariff.fuelVariable && types.some((x) => FUEL_SENSITIVE_DIFFS.has(x)) ? fuelOnSurcharges(line, tariff.fuelPct) : null;
  if (fuelExcess != null && fuelExcess > 0) {
    // inceleme 2: fatura dayanağında ölçeklenen yakıt fazla yakıtı (oranla) zaten içeriyor: ölçekleme faturadaki yakıt −
    // fazla yakıttan yapılır, fazla yakıt tam tutarıyla ayrıca eklenir (iki kez sayılmaz)
    const scaledNet = scaledFuel ? round2(subMoney(scaledFuel.billed, fuelExcess) * scaledFuel.ratio) : null;
    const added = scaledFuel && scaledNet != null ? sumMoney([fuelExcess, scaledNet, -invoiceLines[scaledFuel.index]!.amount]) : fuelExcess;
    if (subMoney(diffAmount, added) > priceTol + EPS) {
      expectedAmount = sumMoney([expectedAmount, added]);
      diffAmount = subMoney(diffAmount, added);
      if (scaledFuel && scaledNet != null) {
        invoiceLines[scaledFuel.index] = {
          ...invoiceLines[scaledFuel.index]!,
          label: t('tr', 'compare.breakdown.fuelInvoice', { amount: fmtMoney(subMoney(scaledFuel.billed, fuelExcess), lineCur), ratio: `${fmtNumber(exp.base)}/${fmtNumber(rc.ok ? rc.listAtKg : 0)}` }),
          amount: scaledNet,
        };
      }
      // kendi kalemi: tarifeye göre hesabın parçası değil, "tarifede olmayan ek ücretler" toplamına da girmez (inceleme 2)
      fuelPassthrough = { label: t('tr', 'compare.breakdown.fuelOnSurcharges', { pct: fmtPct(tariff.fuelPct) }), amount: fuelExcess, currency: lineCur };
      notes.push(t('tr', 'compare.fuelOnSurcharges', { pct: fmtPct(tariff.fuelPct), amount: fmtMoney(fuelExcess, lineCur) }));
      // B10 satırında "Fiyat farkı" yalnız fazla yakıttan doğuyorsa kalkar (kalan fark ek ücret fazlasıdır)
      if (priceExcess != null) {
        priceExcess = subMoney(priceExcess, fuelExcess);
        if (priceExcess <= priceTol + EPS) {
          types.splice(types.indexOf('PRICE'), 1);
          priceExcess = null;
        }
      }
    } else fuelSurchargeReview = fuelExcess;
  }
  if (priceExcess != null) notes.push(t('tr', 'compare.priceExcess', { amount: fmtMoney(priceExcess, lineCur) }));

  // 10. Uyumlu
  if (types.length === 0 && diffAmount < -priceTol - EPS) notes.push(FAVOURABLE_NOTE);
  if (types.length === 0 && Math.abs(diffAmount) > tol.amountTol + EPS && Math.abs(diffAmount) <= priceTol + EPS) fxAbsorbed = true;
  if (fxRate && fxAbsorbed && types.length === 0) notes.push(t('tr', 'compare.fxTolerance', { pct: fmtPct(fxPct) }));

  let breakdown: BreakdownLine[] = exp.lines;
  let fx: FxApplied | undefined;
  if (fxRate) {
    fx = { ...fxRate, base: tariffCur, quote: lineCur, requestedDate: i.fx!.date, expected: exp.total, converted: tariffAmount };
  }
  const fxLine = (key: 'compare.breakdown.wouldBeFx' | 'compare.breakdown.expectedFx'): BreakdownLine => ({
    label: t('tr', key, { amount: fmtNumber(exp.total), currency: tariffCur, rate: fmtFxRate(fxRate!.rate), source: fxSourceText(fx!) }),
    amount: tariffAmount,
    currency: lineCur,
    fx,
  });
  if (invoiceBasis) {
    // tarifeye göre tutar bilgi olarak (toplama girmez)
    breakdown = [
      ...invoiceLines,
      fx ? { ...fxLine('compare.breakdown.wouldBeFx'), info: true } : { label: t('tr', 'compare.breakdown.wouldBe'), amount: tariffAmount, currency: lineCur, info: true },
    ];
  } else if (fx) {
    breakdown = [...exp.lines.map((b) => ({ ...b, currency: tariffCur })), fxLine('compare.breakdown.expectedFx')];
  }
  if (unchecked.length) breakdown = [...breakdown, ...unchecked];
  if (fuelPassthrough) breakdown = [...breakdown, fuelPassthrough];

  // 11. Güven: "İncele" (LOW) — çok kolili gönderi şüphesi, satırın hizmeti tarifeninkinden farklıysa, faturadan taşıyıcının
  // fiyatı doğrulanamıyorsa, sonuç olağandışıysa ya da yakıt faturadan doğrulanamıyorsa (ilk tutan; sıra SPEC §3.13:
  // MULTI_PARCEL → SERVICE → SERVICE_UNKNOWN →
  // SERVICE_MISSING → TARIFF_ONLY → EXTREME_RATE → EXTREME_WEIGHT → FUEL_RATE → FUEL_UNKNOWN → FUEL_SURCHARGE → FX_STALE)
  let confidenceReason: string | null = null;
  let reviewCode: ReviewCode | undefined;
  if (types.length > 0 && (i.repeatedInFile || (i.remeasured && types.some((x) => x === 'WEIGHT' || x === 'DIMENSION')))) {
    // KALANLAR 1.8: çok kolili gönderi şüphesi, en temel gerekçe (karşılaştırılan gönderi/ölçüm belirsiz). Uyumlu satır
    // işaretlenmez. Ölçüm tekrarı yalnız ağırlık/ölçü farkını etkiler; dosyada tekrar her farkı (ayrı ücret satırı olabilir).
    confidenceReason = t('tr', i.repeatedInFile ? 'compare.confidence.multiParcelFile' : 'compare.confidence.multiParcelMeasured');
    reviewCode = 'MULTI_PARCEL';
  } else if (serviceMismatch(line.service, tariff.service)) {
    confidenceReason = t('tr', 'compare.confidence.serviceMismatch', { line: line.service!.trim(), tariff: tariff.service!.trim() });
    reviewCode = 'SERVICE';
    // satır fark çıkmasa da (yanlış tarifeyle "Uyumlu" görünebilir) uyarı notta durur
    if (types.length === 0) notes.push(confidenceReason);
  } else if (i.mixedServices && types.length > 0 && serviceClassWords(tariff.service).length === 0) {
    // DENETIM-2 B1: karışık hizmetli faturada tarifenin hangi hizmet olduğu bilinmiyor: fark kesin sayılmaz
    confidenceReason = t('tr', 'compare.confidence.serviceUnknown');
    reviewCode = 'SERVICE_UNKNOWN';
  } else if (!i.invoiceLacksServices && types.length > 0 && !line.service?.trim() && serviceClassWords(tariff.service).length > 0) {
    // K39 (kullanıcı kararı 2026-11-13): tarifenin hizmeti belli ("IE"), satırınki boş; gönderi başka hizmetle taşınmış
    // olabilir, fark kesin sayılmaz. Uyumlu satır işaretlenmez; tarifenin hizmeti boş ya da sınıfsızsa kural yok. Faturada
    // hiç hizmet adı yoksa (hizmet sütunu yok) kural yok: yurt içi "Standart" tarifesinde bütün desi farkları "İncele" olurdu.
    confidenceReason = t('tr', 'compare.confidence.serviceMissing', { tariff: tariff.service!.trim() });
    reviewCode = 'SERVICE_MISSING';
  } else if (!rc.ok) {
    confidenceReason = t('tr', 'compare.confidence.tariffOnly', { reason: rc.reason });
    reviewCode = 'TARIFF_ONLY';
  } else if (Math.abs(rc.deviationPct) > EXTREME_RATE_DEVIATION_PCT) {
    confidenceReason = t('tr', 'compare.confidence.extremeRate', { pct: fmtSignedPct(rc.deviationPct) });
    reviewCode = 'EXTREME_RATE';
  } else if (billedKg != null && ourKg > 0 && (billedKg / ourKg > EXTREME_WEIGHT_RATIO || ourKg / billedKg > EXTREME_WEIGHT_RATIO)) {
    confidenceReason = t('tr', 'compare.confidence.extremeWeight');
    reviewCode = 'EXTREME_WEIGHT';
  } else if (types.some((x) => FUEL_SENSITIVE_DIFFS.has(x)) && tariff.fuelVariable && implausibleInvoiceFuel(line)) {
    // Değişken yakıtta faturadaki oran kullanılamadı, beklenen tarifedeki oranla kuruldu: fark yakıttan olabilir. Yalnız
    // tutarı yakıtı içeren fark türlerinde; uyumlu satırda ve yalnız ek ücret farkında (yakıttan bağımsız) işaretlenmez.
    // En sonda: daha temel bir gerekçe (hizmet, eşleşme, uç fiyat) varsa o görünür.
    confidenceReason = t('tr', 'compare.confidence.fuelRate', {
      amount: fmtMoney(line.fuelAmount!, lineCur),
      max: fmtPct(MAX_INVOICE_FUEL_PCT),
      tariff: fmtPct(tariff.fuelPct),
    });
    reviewCode = 'FUEL_RATE';
  } else if (VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW && types.includes('PRICE') && tariff.fuelVariable && line.fuelAmount == null) {
    // Kullanıcı adına karar (B2, eski Y17): yakıt navlunun içinde, oranı faturadan okunamıyor; beklenen tarifedeki oranla
    // kuruldu, fiyat farkı güncel yakıt oranından olabilir. Yalnız fiyat farkında (ağırlık/ölçü/ek ücret farkı gerçektir).
    confidenceReason = t('tr', 'compare.confidence.fuelUnknown', { tariff: fmtPct(tariff.fuelPct) });
    reviewCode = 'FUEL_UNKNOWN';
  } else if (fuelSurchargeReview != null) {
    // DENETIM-2 01-B13: sabit yakıtta taşıyıcı yakıtı ek ücrete de uygulamış; tarifede yakıt yalnız taşımaya. Fark yalnız
    // bu fazla yakıt (adım 9b); sözleşme buna izin veriyorsa fark yoktur: kesin sayılmaz.
    confidenceReason = t('tr', 'compare.confidence.fuelSurcharge', { pct: fmtPct(tariff.fuelPct), amount: fmtMoney(fuelSurchargeReview, lineCur) });
    reviewCode = 'FUEL_SURCHARGE';
  } else if (fxStale) {
    // Y18 (inceleme): eski kur, TL değer kaybederken beklenen tutarı düşük, farkı yüksek gösterir: sonuç kesin sayılmaz
    // (fazla ödemeye ve kesin itiraz talebine girmez). Daha temel bir gerekçe varsa o görünür; güven her durumda LOW.
    confidenceReason = t('tr', 'compare.confidence.fxStale', { date: staleDays });
    reviewCode = 'FX_STALE';
  }
  if (fxStale) notes.push(t('tr', 'compare.fxStale', { date: staleDays }));

  return {
    status: types.length ? 'DIFF' : 'MATCH',
    diffTypes: types,
    ourChargeableKg: ourKg,
    billedChargeableKg: billedKg,
    expectedAmount,
    billedAmount,
    diffAmount,
    uncheckedSurchargeTotal: uncheckedTotal,
    breakdown,
    note: joinNotes(notes),
    ...(fx ? { fx } : {}),
    ...(fxStale ? { fxStale } : {}),
    pricingBasis: invoiceBasis ? 'INVOICE' : 'TARIFF',
    rateDeviationPct: rc.ok ? rc.deviationPct : null,
    confidence: confidenceReason ? 'LOW' : 'HIGH',
    confidenceReason,
    ...(reviewCode ? { reviewCode } : {}),
    rate: rateInfoOf(rc),
  };
}
