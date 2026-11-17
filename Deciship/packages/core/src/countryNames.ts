import { DEFAULT_LOCALE, type Locale } from './i18n/index';

const namesByLocale = new Map<Locale, Intl.DisplayNames | null>();

/** ISO olmayan ama faturada, tarifede ve yapay zekâ çıktısında görülen iki harfli ülke kodları → ISO-2. */
export const COUNTRY_CODE_ALIASES: Readonly<Record<string, string>> = { UK: 'GB', EL: 'GR' };

/** İki harfli ülke kodunu büyük harfe çevirir ve takma adı ISO-2'ye çevirir ("uk" → "GB", "EL" → "GR", "fr" → "FR"). */
export function canonicalCountryCode(code: string): string {
  const c = code.trim().toUpperCase();
  return COUNTRY_CODE_ALIASES[c] ?? c;
}

/** ISO-2 ülke kodu → dildeki ad ("ES" → "İspanya" / "Spain"); bilinmiyorsa kodun kendisi. */
export function countryName(code: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  const c = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return c || '—';
  let names = namesByLocale.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    namesByLocale.set(locale, names);
  }
  try {
    const n = names?.of(c);
    return n && n !== c ? n : c;
  } catch {
    return c;
  }
}

/** ISO-2 ülke kodu → Türkçe ad ("ES" → "İspanya"); bilinmiyorsa kodun kendisi. */
export function countryNameTr(code: string | null | undefined): string {
  return countryName(code, 'tr');
}
