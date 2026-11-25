/**
 * Takip no biçimi ve okutma temizliği (KALANLAR 4.8, SPEC §3.3). Tek yer: telefon okuma anında, sunucu ölçüm kaydında
 * kullanır. Eşleşmenin kendisi `tracking.ts`'tedir (`normalizeTracking`, `trackingCandidates`); bu dosya ona dokunmaz.
 *
 * - `stripScanNoise`: okuyucunun eklediği, takip no'nun parçası olamayacak işaretleri siler (kesin kurallar). Ölçüm girişinde
 *   `normalizeTracking`'den önce çalışır; temiz değeri değiştirmez, bu yüzden kayıtlı ölçümlerin eşleşmesi aynı kalır.
 * - `extractTracking`: barkodun içinden yalnız takip no (2D MH10 iletisi, FedEx "96" barkodu); tanımazsa `stripScanNoise`.
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

/**
 * Barkodun içinden takip no'yu ayıklamanın kaynağı. `none`: tanınan bir yapı yok, değer `stripScanNoise(raw)` (bugünkü
 * davranış). `mh10`: 2D barkodun (PDF417, DataMatrix, QR) ANSI MH10.8.3 / ISO 15434 iletisi. `fedex96`: FedEx "96" barkodu.
 * `gs1Postal`: GS1-128 "420 + posta kodu" ile başlayan barkodun takip no alanı.
 */
export type TrackingSource = 'mh10' | 'fedex96' | 'gs1Postal' | 'none';
export type TrackingExtract = {
  /** Taslağa ve kayda yazılacak değer: ayıklanınca yalnız takip no (boşluksuz, büyük harf), değilse `stripScanNoise(raw)`. */
  value: string;
  source: TrackingSource;
};

/** ISO 15434 ayraçları: GS alan, RS kayıt ayırır; EOT iletiyi bitirir. Kaynakta görünmez karakter yazılmaz (depo denetimi K2). */
const GS = String.fromCharCode(0x1d);
const RS = String.fromCharCode(0x1e);
const EOT = String.fromCharCode(0x04);
const MH10_HEADER = '[)>';
/** Taşıyıcı kodu (SCAC) alanı: takip no ondan hemen önceki alandır. */
const FEDEX_SCAC = new Set(['FDE', 'FDEG', 'FDXE', 'FDXG', 'FXSP', 'FDCC']);
const UPS_SCAC = new Set(['UPSN', 'UPSS']);
/** Kendini belli eden biçimler: iletide nerede olursa olsun takip no'dur. */
const SELF_EVIDENT = [/^1Z[0-9A-Z]{16}$/, /^96\d{20}$/, /^96\d{32}$/];
/** Ayraçları kaybolmuş (yapışık) FedEx Express iletisi: hizmet kodundan sonra 12 haneli takip no, ardından "FDE". */
const MH10_GLUED_EXPRESS = /(\d{12})FDE(?![A-Z])/;
/** USPS IMpb biçimli takip no (FedEx SmartPost etiketinde 420 posta kodundan sonra gelir). */
const IMPB = /^9[2-5]\d{18,32}$/;

/** FedEx 12 haneli takip no denetim hanesi: ilk 11 hane sağdan 1, 3, 7 ağırlıkla; toplam mod 11 (10 → 0) = son hane. */
export function fedexCheckOk(t: string): boolean {
  if (!/^\d{12}$/.test(t)) return false;
  const w = [1, 3, 7];
  let sum = 0;
  for (let i = 10, k = 0; i >= 0; i--, k++) sum += Number(t[i]) * w[k % 3]!;
  return (sum % 11) % 10 === Number(t[11]);
}

/**
 * FedEx 1D barkodu: "96" + 32 hane → son 12 (Express), "96" + 20 hane → son 15 (Ground: 96 + 2 SCNC + 3 hizmet + 15 takip no).
 * Başka önekli 34 haneli FedEx Express barkodu (ör. "1221…879698986192"; etikette TRK# 8796 9898 6192): son 12 hane yalnız
 * FedEx denetim hanesi tutarsa alınır (yanlış numara almaktansa hiç almaz).
 */
function fromFedex96(cleaned: string): string | null {
  if (/^96\d{32}$/.test(cleaned)) return cleaned.slice(-12);
  if (/^96\d{20}$/.test(cleaned)) return cleaned.slice(-15);
  if (/^\d{34}$/.test(cleaned) && fedexCheckOk(cleaned.slice(-12))) return cleaned.slice(-12);
  return null;
}

/** İletideki bir alanın takip no olarak temiz hâli; taşıyıcının biçimine uymuyorsa null (yanlış alan almaktansa hiç almaz). */
function trackingField(field: string | undefined, scac: string | undefined): string | null {
  if (!field) return null;
  const c = cleanTracking(stripScanNoise(field));
  const short = fromFedex96(c);
  if (short) return short;
  if (!/^[A-Z0-9]+$/.test(c) || c.length < TRACKING_USUAL_MIN || c.length > TRACKING_USUAL_MAX) return null;
  if (scac && FEDEX_SCAC.has(scac)) return CARRIER_TRACKING_FORMATS.fedex.some((re) => re.test(c)) ? c : null;
  if (scac && UPS_SCAC.has(scac)) return CARRIER_TRACKING_FORMATS.ups.some((re) => re.test(c)) ? c : null;
  // Taşıyıcı kodu yok (alan yerinden alındı): yalnız bilinen bir taşıyıcı biçimine uyuyorsa.
  return Object.values(CARRIER_TRACKING_FORMATS).some((list) => list.some((re) => re.test(c))) ? c : null;
}

/**
 * MH10.8.3 "01" kaydı: `[)>RS 01 GS <sürüm> GS <posta kodu> GS <ülke> GS <hizmet> GS <takip no> GS <SCAC> GS <hesap> …`.
 * Takip no önce SCAC alanının hemen önünden, SCAC yoksa yerinden (6. alan) alınır.
 */
function fromMh10(message: string): string | null {
  const body = message.slice(MH10_HEADER.length);
  const records = body.split(new RegExp(`[${RS}${EOT}]`));
  for (const rec of records) {
    const f = rec.split(GS).map((x) => x.trim());
    if (f[0] !== '01' || f.length < 6) continue;
    const scacAt = f.findIndex((x, i) => i >= 3 && (FEDEX_SCAC.has(x.toUpperCase()) || UPS_SCAC.has(x.toUpperCase())));
    const t = scacAt > 2 ? trackingField(f[scacAt - 1], f[scacAt]!.toUpperCase()) : trackingField(f[5], undefined);
    if (t) return t;
  }
  for (const field of body.split(new RegExp(`[${GS}${RS}${EOT}]`))) {
    const c = cleanTracking(stripScanNoise(field));
    if (SELF_EVIDENT.some((re) => re.test(c))) return fromFedex96(c) ?? c;
  }
  if (!body.includes(GS)) {
    const m = MH10_GLUED_EXPRESS.exec(body);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Ham barkod içeriğinden takip no'yu ayıklar (okutma anında, `checkTracking`'den önce). Ayraçlar `stripScanNoise` onları
 * silmeden önce kullanılır. Tanınan yapılar:
 * - 2D MH10 iletisi (FedEx/UPS PDF417 …): yalnız takip no alanı; alan taşıyıcı biçimine uymazsa ayıklanmaz.
 * - FedEx "96" barkodu: 34 hane → son 12, 22 hane → son 15 (`normalizeTracking` 34 haneyi zaten son 12'ye indirir).
 * - GS1-128 "420 + posta kodu GS takip no": GS'den sonraki IMpb takip no.
 * Tanınmayan her biçimde `stripScanNoise(raw)` döner (bugünkü davranış: UPS 1Z, DHL, PTT, Aras, Yurtiçi, MNG bozulmaz).
 */
export function extractTracking(raw: string): TrackingExtract {
  const head = String(raw ?? '')
    .replace(/^[\s\p{Cf}]+/u, '')
    .replace(AIM_PREFIX, '');
  if (head.startsWith(MH10_HEADER)) {
    const t = fromMh10(head);
    return t ? { value: t, source: 'mh10' } : { value: stripScanNoise(raw), source: 'none' };
  }
  const gsAt = head.indexOf(GS);
  if (/^42[01]\d{5}/.test(head) && gsAt > 0) {
    const c = cleanTracking(stripScanNoise(head.slice(gsAt + 1).split(GS)[0]!));
    if (IMPB.test(c)) return { value: c, source: 'gs1Postal' };
  }
  const stripped = stripScanNoise(raw);
  const short = fromFedex96(cleanTracking(stripped));
  return short ? { value: short, source: 'fedex96' } : { value: stripped, source: 'none' };
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
