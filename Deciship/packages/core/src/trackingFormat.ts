/**
 * Takip no biçimi ve okutma temizliği (KALANLAR 4.8, SPEC §3.3). Tek yer: telefon okuma anında, sunucu ölçüm kaydında
 * kullanır. Eşleşmenin kendisi `tracking.ts`'tedir (`normalizeTracking`, `trackingCandidates`); bu dosya ona dokunmaz.
 *
 * - `stripScanNoise`: okuyucunun eklediği, takip no'nun parçası olamayacak işaretleri siler (kesin kurallar). Ölçüm girişinde
 *   `normalizeTracking`'den önce çalışır; temiz değeri değiştirmez, bu yüzden kayıtlı ölçümlerin eşleşmesi aynı kalır.
 * - `checkTracking`: `invalid` (kesin geçersiz: sunucu 400, telefon kaydetmez), `unusual` (takip no'ya benzemiyor: telefon
 *   sorar, yine de kaydedilebilir), `ok`. Bilinmeyen biçimli gerçek takip no'lar olabilir: biçim tablosu engellemez, yalnız tanır.
 */
import type { CarrierCode } from './invoice/types';
import { cleanTracking, normalizeTracking } from './tracking';

/** Temizlenmiş (boşluk ve tiresiz) değerin sert sınırları: dışı kesin geçersizdir. */
export const TRACKING_HARD_MIN = 5;
export const TRACKING_HARD_MAX = 50;
/** Olağan takip no uzunluğu (fatura okuma denetimiyle aynı, `invoice/verify.ts`): dışı yumuşak uyarıdır. */
export const TRACKING_USUAL_MIN = 8;
export const TRACKING_USUAL_MAX = 35;

/**
 * Taşıyıcıların takip no biçimleri (temizlenmiş değer üstünde). Uluslararası biçimler yayımlanmış kalıplardır; yurt içi
 * taşıyıcılarınki (Aras, Yurtiçi, MNG, PTT yurt içi) gevşek rakam aralığıdır ve gerçek etiketlerle doğrulanmalıdır.
 * Yalnız tanımak içindir: eşleşmeyen değer engellenmez.
 */
export const CARRIER_TRACKING_FORMATS: Readonly<Record<Exclude<CarrierCode, 'generic'>, readonly RegExp[]>> = {
  // Express 12, Ground 15, SmartPost 20, "96" ile başlayan 22 ve 34 haneli barkod.
  fedex: [/^\d{12}$/, /^\d{15}$/, /^\d{20}$/, /^96\d{20}$/, /^96\d{32}$/],
  // 1Z + 16; InfoNotice T + 10.
  ups: [/^1Z[0-9A-Z]{16}$/, /^T\d{10}$/],
  // Express konşimento 10 hane; parça no JJD/JD + rakam; SSCC (00 + 18).
  dhl: [/^\d{10}$/, /^J?JD\d{16,20}$/, /^00\d{18}$/],
  // UPU S10 (RR123456789TR); yurt içi 13 hane.
  ptt: [/^[A-Z]{2}\d{9}[A-Z]{2}$/, /^\d{13}$/],
  aras: [/^\d{10,13}$/],
  yurtici: [/^\d{10,12}$/],
  mng: [/^\d{9,13}$/],
};

export type TrackingVerdict = 'ok' | 'unusual' | 'invalid';
export type TrackingReason =
  /** invalid: harf ya da rakam yok. */
  | 'empty'
  /** invalid: `TRACKING_HARD_MIN`'den kısa (yarım okuma). */
  | 'tooShort'
  /** invalid: `TRACKING_HARD_MAX`'tan uzun (QR adresi, PDF417 verisi). */
  | 'tooLong'
  /** invalid: yazdırılabilir ASCII dışı karakter (Ş, emoji…). */
  | 'chars'
  /** unusual: ürün barkodu (EAN/UPC/ITF-14 ya da Türk ürün EAN-13'ü). */
  | 'product'
  /** unusual: olağan uzunluğun altında ya da üstünde. */
  | 'short'
  | 'long'
  /** unusual: harf ve rakam dışında işaret var. */
  | 'symbols'
  /** unusual: hiç rakam yok (fatura okuması rakamsız takip no'yu almaz). */
  | 'noDigit';

export type TrackingCheck = {
  /** Kaydedilecek ve eşleşmede kullanılacak değer: `normalizeTracking(stripScanNoise(raw))`. */
  value: string;
  verdict: TrackingVerdict;
  /** `ok` ise yok. */
  reason?: TrackingReason;
  /** Biçimi tutan taşıyıcılar (boş olabilir). */
  carriers: Exclude<CarrierCode, 'generic'>[];
};

/** Ürün barkodu simgeleri (expo-camera `BarcodeType` adları). Taşıyıcılar takip no'yu bunlarla basmaz. */
const PRODUCT_SYMBOLOGIES = new Set(['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14']);

/** Baştaki AIM simge kimliği (ör. `]C1` GS1-128, `]d2` GS1 DataMatrix, `]Q3` GS1 QR): okuyucu ayarına göre eklenir. */
const AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;
/** GS1 okunur yazımı "(00)3404…": AI parantez içinde. Yalnız değer böyle başlıyorsa parantezler kalkar. */
const GS1_HRI_START = /^\(\d{2,4}\)/;
const GS1_HRI_AI = /\((\d{2,4})\)/g;
/** Kontrol (GS/FNC1, CR, NUL…) ve biçim (sıfır genişlikli boşluk, BOM, yumuşak tire) karakterleri. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const DOTTED_CAPITAL_I = /İ/g;

/**
 * Okutma ve elle girişin kesin temizliği: görünmez karakterler, AIM öneki, GS1 AI parantezleri, Türkçe klavyenin "İ"si;
 * baş ve son boşluk kırpılır. Aradaki boşluk ve tire kalır (onları `normalizeTracking` siler; ham değer okunur kalır).
 */
export function stripScanNoise(raw: string): string {
  let s = String(raw ?? '')
    .replace(INVISIBLE, '')
    .trim();
  s = s.replace(AIM_PREFIX, '');
  if (GS1_HRI_START.test(s)) s = s.replace(GS1_HRI_AI, '$1');
  return s.replace(DOTTED_CAPITAL_I, 'I').trim();
}

/** GTIN (EAN-8/12/13, ITF-14) denetim hanesi tutuyor mu. */
function gtinCheckOk(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** Simgesi bilinmeyen değer (elle, Bluetooth okuyucu) Türk ürün EAN-13'ü mü: GS1 Türkiye öneki 868/869 + denetim hanesi. */
const isTurkishProductEan = (v: string) => /^86[89]\d{10}$/.test(v) && gtinCheckOk(v);

/**
 * Takip no denetimi. `symbology`: kameranın bildirdiği barkod türü (biliniyorsa). Sınıflama temizlenmiş tam değer üstündedir
 * (FedEx 34 haneli barkod kısaltılmadan); `value` eşleşmenin kullandığı değerdir.
 */
export function checkTracking(raw: string, opts: { symbology?: string | null } = {}): TrackingCheck {
  const stripped = stripScanNoise(raw);
  const value = normalizeTracking(stripped);
  const cleaned = cleanTracking(stripped);
  const out = (verdict: TrackingVerdict, reason?: TrackingReason, carriers: TrackingCheck['carriers'] = []): TrackingCheck =>
    reason ? { value, verdict, reason, carriers } : { value, verdict, carriers };

  if (!/[\p{L}\p{N}]/u.test(cleaned)) return out('invalid', 'empty');
  if (cleaned.length < TRACKING_HARD_MIN) return out('invalid', 'tooShort');
  if (cleaned.length > TRACKING_HARD_MAX) return out('invalid', 'tooLong');
  if (/[^\x21-\x7e]/.test(cleaned)) return out('invalid', 'chars');

  const symbology = (opts.symbology ?? '').toLowerCase();
  if (PRODUCT_SYMBOLOGIES.has(symbology) || isTurkishProductEan(cleaned)) return out('unusual', 'product');
  const carriers = (Object.keys(CARRIER_TRACKING_FORMATS) as TrackingCheck['carriers']).filter((c) =>
    CARRIER_TRACKING_FORMATS[c].some((re) => re.test(cleaned)),
  );
  if (carriers.length) return out('ok', undefined, carriers);
  if (cleaned.length < TRACKING_USUAL_MIN) return out('unusual', 'short');
  if (cleaned.length > TRACKING_USUAL_MAX) return out('unusual', 'long');
  if (/[^A-Z0-9]/.test(cleaned)) return out('unusual', 'symbols');
  if (!/\d/.test(cleaned)) return out('unusual', 'noDigit');
  return out('ok');
}
