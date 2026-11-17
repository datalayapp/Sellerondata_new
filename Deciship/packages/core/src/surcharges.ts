import { DEFAULT_LOCALE, messages, t, type Locale, type MessageKey } from './i18n/index';

/** Ek ücret kodlarını karşılaştırmak için normalleştirir ("Adres düzeltme" → "ADRES_DUZELTME"). */
export function normalizeSurchargeCode(code: string): string {
  return String(code ?? '')
    .trim()
    .replace(/İ/g, 'I')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Bilinen ek ücret grupları: grup kodu + TR/EN başlık eş anlamlıları (aynı gruptaki kodlar eşdeğer sayılır). */
export const SURCHARGE_SYNONYMS: { code: string; synonyms: string[] }[] = [
  { code: 'ADDRESS_CORRECTION', synonyms: ['address correction', 'address correction charge', 'adres duzeltme', 'adres duzeltme bedeli', 'adres duzeltme ucreti', 'adres degisikligi'] },
  { code: 'ADDITIONAL_HANDLING', synonyms: ['additional handling', 'additional handling charge', 'ek ellecleme', 'ozel ellecleme', 'ellecleme'] },
  { code: 'REMOTE_AREA', synonyms: ['remote area', 'remote area surcharge', 'remote area delivery', 'out of delivery area', 'extended area', 'uzak bolge', 'mobil bolge', 'mobil bolge ucreti'] },
  { code: 'DELIVERY_AREA', synonyms: ['delivery area surcharge', 'delivery area'] },
  { code: 'RESIDENTIAL', synonyms: ['residential', 'residential delivery', 'residential surcharge', 'ev teslim', 'adrese teslim'] },
  { code: 'LARGE_PACKAGE', synonyms: ['large package', 'large package surcharge', 'oversize', 'oversized', 'buyuk paket', 'hacimli gonderi'] },
  { code: 'OVERWEIGHT', synonyms: ['overweight', 'agir paket', 'agir gonderi'] },
  { code: 'SATURDAY', synonyms: ['saturday delivery', 'saturday pickup', 'saturday', 'cumartesi teslim', 'cumartesi'] },
  { code: 'SIGNATURE', synonyms: ['signature', 'signature required', 'direct signature', 'imzali teslim'] },
  { code: 'INSURANCE', synonyms: ['declared value', 'insurance', 'sigorta', 'deger beyani', 'kiymet'] },
  { code: 'KAPIDA_ODEME', synonyms: ['kapida odeme', 'kapida odeme bedeli', 'kapida odeme hizmeti', 'cod', 'cash on delivery', 'tahsilatli teslim', 'tahsilat ucreti'] },
  { code: 'RETURN', synonyms: ['return charge', 'iade ucreti', 'iade bedeli'] },
  { code: 'PEAK', synonyms: ['peak surcharge', 'demand surcharge', 'peak', 'yogunluk ek ucreti'] },
  { code: 'EMERGENCY_SITUATION', synonyms: ['emergency situation', 'emergency surcharge'] },
  { code: 'SMS', synonyms: ['sms', 'sms ucreti', 'sms bilgilendirme'] },
];

const ALIAS = new Map<string, string>();
for (const g of SURCHARGE_SYNONYMS) {
  ALIAS.set(normalizeSurchargeCode(g.code), g.code);
  for (const s of g.synonyms) {
    const k = normalizeSurchargeCode(s);
    if (!ALIAS.has(k)) ALIAS.set(k, g.code);
  }
}

/** Kodun bilinen grubu (ör. "COD" ve "KAPIDA_ODEME" → "KAPIDA_ODEME"); bilinmiyorsa normalleştirilmiş kod. */
export function canonicalSurchargeCode(code: string): string {
  const n = normalizeSurchargeCode(code);
  return ALIAS.get(n) ?? ALIAS.get(stripSuffix(n)) ?? n;
}

/** Bilinen ek ücret grubunun görünen adı ("COD" → "Kapıda ödeme" / "Cash on delivery"); bilinmiyorsa `fallback` ya da kodun kendisi. */
export function surchargeLabel(code: string, locale: Locale = DEFAULT_LOCALE, fallback?: string | null): string {
  const key = `surcharge.${canonicalSurchargeCode(code)}` as MessageKey;
  return key in messages.tr ? t(locale, key) : fallback || code;
}

const SUFFIX_WORDS = new Set(['SURCHARGE', 'CHARGE', 'FEE', 'AMOUNT', 'BEDELI', 'HIZMETI', 'HIZMET', 'UCRETI', 'UCRET', 'TUTARI', 'DELIVERY']);

function stripSuffix(n: string): string {
  const words = n.split('_').filter(Boolean);
  while (words.length > 1 && SUFFIX_WORDS.has(words[words.length - 1]!)) words.pop();
  return words.join('_');
}

/** Başlıktan ek ücret kodu türetir: sondaki "Surcharge/Bedeli/Hizmeti/Ücreti…" atılır ("Kapıda Ödeme Bedeli" → "KAPIDA_ODEME"). */
export function surchargeCodeFromHeader(header: string): string {
  return stripSuffix(normalizeSurchargeCode(header));
}
