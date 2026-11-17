import { LOCALES, type Locale } from './products.ts';

/**
 * İlk açılış dili (kullanıcı kararı 2026-11-12). Tek kural, her yüzeyde aynı:
 * 1. Kayıtlı tercih (hesap dili, `sod_lang` çerezi, yerel kayıt) desteklenen bir dilse o.
 * 2. Yoksa cihazın/tarayıcının dilleri sırayla: ilk desteklenen ("tr-TR" → tr, "en-GB" → en).
 * 3. O da yoksa İngilizce.
 * Sunucu tarafında "dil bilgisi hiç yok" durumunun son çaresi de `DEFAULT_LOCALE`'dir.
 * Tanıtım sitesi (`Platform/apps/site/public/assets/site.js`) bu paketi içe aktaramaz; aynı mantığın küçük kopyası orada.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/** Dil kodunu desteklenen ana dile indirger: "tr-TR", "TR", "en_GB" → tr / en. Desteklenmiyorsa ya da bozuksa null. */
export function baseLocale(value: unknown, supported: readonly string[] = LOCALES): Locale | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase() ?? '';
  return base && supported.includes(base) ? (base as Locale) : null;
}

/**
 * İlk açılış dilini seçer (saf işlev). `saved`: kayıtlı tercih(ler), öncelik sırasıyla; boş, null ya da desteklenmeyen
 * değer atlanır. `deviceLangs`: `navigator.languages` gibi cihaz dilleri, tercih sırasıyla. `supported`: desteklenen diller.
 */
export function pickInitialLocale(
  saved: unknown,
  deviceLangs: readonly unknown[] | null | undefined,
  supported: readonly string[] = LOCALES,
): Locale {
  const savedList = Array.isArray(saved) ? saved : [saved];
  for (const s of savedList) {
    // Kayıtlı tercih tam kod olarak yazılır ("tr", "en"); bölgeli yazılmışsa da kabul edilir.
    const l = baseLocale(s, supported);
    if (l) return l;
  }
  for (const d of Array.isArray(deviceLangs) ? deviceLangs : []) {
    const l = baseLocale(d, supported);
    if (l) return l;
  }
  return supported.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : ((supported[0] as Locale | undefined) ?? DEFAULT_LOCALE);
}
