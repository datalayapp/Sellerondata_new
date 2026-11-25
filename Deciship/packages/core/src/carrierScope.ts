/**
 * Yeni tarifenin kapsamı (KALANLAR 1.1, KARARLAR "Yurt içi varsayılanı"): yurt içi = desi tarifesi, hacim böleni 3000, yakıt
 * sözleşmede sabit; yurt dışı = bölen 5000, yakıt değişken. Yalnız YENİ tarifenin (elle, Excel/CSV ya da PDF'ten) ilk
 * değeridir; kayıtlı tarifenin böleni ve yakıtı değişmez. Kişi tarife ekranında değiştirir.
 */
export type TariffScope = 'domestic' | 'international';

export const DOMESTIC_DIVISOR = 3000;
export const INTERNATIONAL_DIVISOR = 5000;

const DOMESTIC_CODES = new Set(['aras', 'yurtici', 'mng', 'ptt']);
const INTERNATIONAL_CODES = new Set(['fedex', 'ups', 'dhl']);

/**
 * "Diğer" (generic) taşıyıcının adında geçerse yurt dışı sayılır ("global", "uluslararası", "international" sözcükleri de:
 * Hepsi Global, Ekol Uluslararası) (Türkçe harfler sadeleşmiş, küçük harf, kelime sınırıyla).
 * Listede olmayan ad (Sürat, HepsiJet, Kolay Gelsin, Sendeo, Trendyol Express, Kargoist, …) yurt içidir: DeciShip'in
 * müşterisi Türkiye'deki satıcıdır, yurt dışı taşıyıcıların büyükleri kendi kodlarıyla (fedex, ups, dhl) gelir.
 */
const INTERNATIONAL_NAME =
  /\b(?:fedex|ups|dhl|tnt|gls|dpd|aramex|usps|ems|royal\s*mail|post\s*nl|postnl|chronopost|colissimo|deutsche\s*post|parcelforce|purolator|canada\s*post|la\s*poste|correos|bpost|asendia|skynet|hermes|evri|postnord|swiss\s*post|sf\s*express|yanwen|china\s*post|cainiao|4px|japan\s*post|korea\s*post|singpost|australia\s*post|aliexpress|global|international|internacional|intl|worldwide|uluslararasi|ihracat|yurt\s*disi|yurtdisi|abroad|cross\s*border)\b/;

const fold = (s: string) =>
  s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Taşıyıcının yeni tarife kapsamı: kod (aras, yurtici, mng, ptt → yurt içi; fedex, ups, dhl → yurt dışı), "Diğer"de ad. */
export function carrierScope(carrier: { code?: string | null; name?: string | null } | null | undefined): TariffScope {
  const code = (carrier?.code ?? '').trim().toLowerCase();
  if (DOMESTIC_CODES.has(code)) return 'domestic';
  if (INTERNATIONAL_CODES.has(code)) return 'international';
  return INTERNATIONAL_NAME.test(fold(carrier?.name ?? '')) ? 'international' : 'domestic';
}

/** Kapsamın hacim böleni (yurt içi desi 3000, yurt dışı 5000). */
export const scopeDivisor = (scope: TariffScope): number => (scope === 'domestic' ? DOMESTIC_DIVISOR : INTERNATIONAL_DIVISOR);

/** Kapsamın yakıt varsayılanı: yurt dışında değişken (faturadaki oran), yurt içinde sözleşmede sabit. */
export const scopeFuelVariable = (scope: TariffScope): boolean => scope === 'international';

/** Taşıyıcının yeni tarifesi yurt içi mi (bölen 3000, sabit yakıt). */
export const isDomesticCarrier = (carrier: { code?: string | null; name?: string | null } | null | undefined): boolean =>
  carrierScope(carrier) === 'domestic';
