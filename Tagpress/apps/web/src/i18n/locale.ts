/**
 * Arayüz dili ("locale"; kodda "language" tasarım dili demektir). İlk dil kuralı platformdaki `pickInitialLocale` ile
 * aynıdır (Platform/packages/contracts/src/locale.ts; `locale.test.ts` iki kopyanın aynı sonucu verdiğini denetler):
 * kayıtlı tercih → cihaz dilleri (ilk desteklenen) → İngilizce.
 * Kayıtlı tercih sırası: yerel kayıt `tagpress.arayuzDili` → `sod_lang` çerezi (platformla ortak).
 * `studio.dil` anahtarı tasarım dili seçimi içindir; buraya karışmaz.
 */
export type Locale = "tr" | "en";
export const LOCALES: readonly Locale[] = ["tr", "en"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "tagpress.arayuzDili";
export const COOKIE_LANG = "sod_lang";

/** Dil kodunu desteklenen ana dile indirger: "tr-TR", "TR", "en_GB" → tr / en. Desteklenmiyorsa ya da bozuksa null. */
export function baseLocale(value: unknown, supported: readonly string[] = LOCALES): Locale | null {
  if (typeof value !== "string") return null;
  const base = value.trim().replace(/_/g, "-").split("-")[0]?.toLowerCase() ?? "";
  return base && supported.includes(base) ? (base as Locale) : null;
}

/** İlk açılış dili (saf). `saved`: kayıtlı tercih(ler), öncelik sırasıyla. `deviceLangs`: `navigator.languages` gibi. */
export function pickInitialLocale(saved: unknown, deviceLangs: readonly unknown[] | null | undefined, supported: readonly string[] = LOCALES): Locale {
  const savedList = Array.isArray(saved) ? saved : [saved];
  for (const s of savedList) {
    const l = baseLocale(s, supported);
    if (l) return l;
  }
  for (const d of Array.isArray(deviceLangs) ? deviceLangs : []) {
    const l = baseLocale(d, supported);
    if (l) return l;
  }
  return supported.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : ((supported[0] as Locale | undefined) ?? DEFAULT_LOCALE);
}

export const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

function readStored(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie.match(new RegExp(`(?:^|; )${COOKIE_LANG}=([^;]*)`))?.[1];
}

function deviceLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** Tarayıcıdaki kayıtlara ve cihaz diline göre ilk dil. */
export function detectLocale(): Locale {
  return pickInitialLocale([readStored(), readCookie()], deviceLanguages());
}

/** Seçimi yerel kayda ve çereze yazar (i18next'i değiştirmek `changeLocale`'in işi). */
export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* gizli pencere */
  }
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const host = window.location.hostname;
  const domain = host === "sellerondata.com" || host.endsWith(".sellerondata.com") ? "; Domain=.sellerondata.com" : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_LANG}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
}
