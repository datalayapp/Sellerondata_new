import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { COOKIE_LANG, DEFAULT_LOCALE, LOCALES, pickInitialLocale, type Locale } from '@sellerondata/contracts';
import shellTr from '../locales/tr/shell.json';
import shellEn from '../locales/en/shell.json';

const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

function readLangCookie(): Locale | undefined {
  if (typeof document === 'undefined') return undefined;
  const v = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_LANG}=([^;]*)`))?.[1];
  return isLocale(v) ? v : undefined;
}

/** Tarayıcının dilleri, tercih sırasıyla (`navigator.languages`, yoksa `navigator.language`). */
function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Dil kaynağı sırası: Person.locale → `sod_lang` çerezi → tarayıcı dilleri (ilk desteklenen) → İngilizce (§9;
 * kullanıcı kararı 2026-11-12, kural `pickInitialLocale`).
 */
export function detectLocale(personLocale?: string | null): Locale {
  return pickInitialLocale([personLocale, readLangCookie()], browserLanguages());
}

function writeLangCookie(locale: Locale) {
  const host = window.location.hostname;
  const domain = host === 'sellerondata.com' || host.endsWith('.sellerondata.com') ? '; Domain=.sellerondata.com' : '';
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_LANG}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
}

/** Kabuk çevirileriyle i18next'i başlatır. Uygulama kendi ad alanlarını `resources` ile verir. */
export function initShellI18n(opts: { resources?: Resource; defaultNS?: string; locale?: Locale } = {}) {
  const lng = opts.locale ?? detectLocale();
  const resources: Resource = {
    tr: { shell: shellTr, ...(opts.resources?.tr ?? {}) },
    en: { shell: shellEn, ...(opts.resources?.en ?? {}) },
  };
  // Ad nokta ile bitebilir ("Ltd. Şti."), metin de nokta koyar: çift nokta yazılmaz. Üç nokta dokunulmaz.
  i18next.use({ type: 'postProcessor', name: 'singleDot', process: (value: string) => value.replace(/(?<!\.)\.\.(?!\.)/g, '.') });
  void i18next.use(initReactI18next).init({
    postProcess: ['singleDot'],
    lng,
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: opts.defaultNS ?? 'shell',
    resources,
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  document.documentElement.lang = lng;
  return i18next;
}

/** Dili anında değiştirir ve çereze yazar. Hesaba kaydetme `useSessionActions().changeLocale` ile. */
export function setShellLocale(locale: Locale) {
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
  if (readLangCookie() !== locale) writeLangCookie(locale);
}

export const currentLocale = (): Locale => (isLocale(i18next.language) ? i18next.language : DEFAULT_LOCALE);
