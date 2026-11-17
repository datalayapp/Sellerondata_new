// Bağımlılıksız ölçü girişi modülü (web ve mobil de kullanabilir). Bu dosyaya import eklemeyin.

/** Elle girilen kenar üst sınırı (cm); mobil ölçü alanıyla aynı. */
export const MAX_EDGE_CM = 400;
/** Elle girilen ağırlık sınırı (kg, hariç); mobil ağırlık ekranıyla aynı. */
export const MAX_WEIGHT_KG = 1000;

/**
 * Elle ölçü/ağırlık girişi: "4,02" | "4.02" | "2.500" (= 2,5) | "1.234,5" → sayı. Binlik ayırıcı tanınmaz: tek nokta da
 * tek virgül de ondalıktır, iki ayırıcı birlikteyse sondaki ondalıktır. Dil almaz. Mobil `parseNum` ile aynı sonucu verir
 * (denetim 14-B1). Fatura, tarife ve para girişi `parseTrNumber` kullanır; orada "2.500" binliktir.
 */
export function parseMeasureNumber(s: string | null | undefined): number | null {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return null;
  let norm: string;
  if (t.includes(',') && t.includes('.') && t.lastIndexOf('.') > t.lastIndexOf(',')) norm = t.replace(/,/g, '');
  else if (t.includes(',')) norm = t.replace(/\./g, '').replace(',', '.');
  else norm = t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/** Kenar girişi geçerli mi: 0 < cm ≤ 400. */
export function measureEdgeOk(s: string | null | undefined): boolean {
  const n = parseMeasureNumber(s);
  return n !== null && n > 0 && n <= MAX_EDGE_CM;
}

/** Ağırlık girişi geçerli mi: 0 < kg < 1000. */
export function measureWeightOk(s: string | null | undefined): boolean {
  const n = parseMeasureNumber(s);
  return n !== null && n > 0 && n < MAX_WEIGHT_KG;
}

/** İki türlü okunan ağırlık yazımının iki okuması (K36). */
export type WeightReadings = { decimal: number; thousands: number };

/** Tek ayırıcı ve ardından tam üç hane, tam kısım 1–999 ("1.500", "1,500"; "0.500" belirsiz değil). */
const SEP_THREE = /^[1-9]\d{0,2}([.,])\d{3}$/;

/**
 * Hangi ayırıcı soru doğurur: `.` Türkçe arayüz ("1.500": Türkçe binlik mi İngilizce ondalık mı), `,` İngilizce arayüz
 * ("1,500": İngilizce binlik mi Türkçe ondalık mı; kullanıcı kararı 2026-11-14), `any` dosya ve PDF (biçim kanıtı yoksa
 * ikisi de; dosyalar arayüz diline değil dosyanın kanıtına bakar).
 */
export type AmbiguousSeparator = '.' | ',' | 'any';
/**
 * Yalnız K36 öncesi de okunan birimler (`parseTrNumber` "kg" ve "desi" ekini atar): "1.500 lb" / "1.500 lbs" / "1.500 kgs" /
 * "1.500 kilo" eskisi gibi okunmaz, bu yüzden belirsiz de sayılmaz (lb hücresi kg sanılmasın).
 */
const WEIGHT_UNIT = /\s*(?:kg|desi)$/i;

/**
 * K36 (kullanıcı kararı 2026-11-14): ağırlıkta nokta ve ardından tam üç hane ("1.500", "12.000") Türkçe binlik (1500 kg)
 * de İngilizce ondalık (1,5 kg) da olabilir; İngilizcede virgül ve tam üç hane ("1,500") aynası. `sep` hangi ayırıcının
 * soru doğurduğunu söyler (varsayılan nokta). Bu yazımda iki okumayı verir (`decimal`: ayırıcı ondalık); başka her yazımda
 * null ("1500", "1.5", "0.500", "1.500.000", "1.500,5" belirsiz değildir; `sep` nokta iken "1,500" de). Sonundaki "kg" ya da "desi" ("1.500 kg") yok sayılır; başka birim
 * ("1.500 lb") belirsiz sayılmaz (K36 öncesi de okunmuyordu).
 *
 * Koli ölçümünde (ölçüm formu, mobil, ölçüm API'si) sorulmaz: koli 1500 kg olamaz, `parseMeasureNumber` ondalık okur.
 * Tarife ve faturada sınır büyük olabilir: düzenleyicide seçim istenir, dosyada biçim belli değilse sorulur.
 */
export function ambiguousWeightText(s: string | null | undefined, sep: AmbiguousSeparator = '.'): WeightReadings | null {
  const t = String(s ?? '')
    .trim()
    .replace(WEIGHT_UNIT, '')
    .replace(/\s/g, '');
  const m = SEP_THREE.exec(t);
  if (!m || (sep !== 'any' && m[1] !== sep)) return null;
  return { decimal: Number(t.replace(',', '.')), thousands: Number(t.replace(/[.,]/, '')) };
}

/** Ağırlık yazımının sayı biçimi (K36 seçimi): `tr` nokta binlik / virgül ondalık, `en` virgül binlik / nokta ondalık. */
export type WeightFormat = 'tr' | 'en';

/** İki türlü okunan ağırlık yazımının ayırıcısı ("1.500" → ".", "1,500" → ","), değilse null. */
export function ambiguousWeightSeparator(s: string | null | undefined, sep: AmbiguousSeparator = 'any'): '.' | ',' | null {
  if (!ambiguousWeightText(s, sep)) return null;
  return String(s).includes(',') ? ',' : '.';
}

/**
 * Seçilen yazım biçimine göre değer: Türkçe yazımda "1.500" = 1500, "1,500" = 1,5; İngilizcede tersi. Aynı dosyada iki yazım
 * birlikte geçse de her biri kendi ayırıcısına göre okunur (tek "binlik/ondalık" cevabı ikisine birden uygulanmaz).
 */
export function weightAs(r: WeightReadings, sep: '.' | ',', fmt: WeightFormat): number {
  return (fmt === 'tr') === (sep === '.') ? r.thousands : r.decimal;
}

/** Metin iki türlü okunuyorsa seçilen biçimle değeri, değilse null. */
export function readAmbiguousWeight(s: string | null | undefined, fmt: WeightFormat, sep: AmbiguousSeparator = 'any'): number | null {
  const r = ambiguousWeightText(s, sep);
  const at = r ? ambiguousWeightSeparator(s, sep) : null;
  return r && at ? weightAs(r, at, fmt) : null;
}

/** Arayüz dilinin soru doğuran ayırıcısı: Türkçede nokta ("1.500"), İngilizcede virgül ("1,500"). */
export const uiAmbiguousSeparator = (locale: string): '.' | ',' => (locale === 'en' ? ',' : '.');
