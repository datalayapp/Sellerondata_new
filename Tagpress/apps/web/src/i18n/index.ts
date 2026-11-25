import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, detectLocale, type Locale, setLocale } from "./locale.ts";

/**
 * TagPress web i18n (DeciShip kalıbı; 2. aşamada `initShellI18n` çağrısına döner, kaynak biçimi aynı).
 * Ad alanı = `locales/<dil>/<ad>.json` dosya adı; varsayılan ad alanı `common`, yedek dil İngilizce.
 * Giriş (`main.tsx`) kayıtlı tercihi okur; testler `forceLocale` ile dili sabitler (`test.ts`).
 */
const files = import.meta.glob<{ default: Record<string, unknown> }>("../locales/*/*.json", { eager: true });

export const resources: Resource = {};
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/locales\/(\w+)\/(\w+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m as unknown as [string, string, string];
  (resources[lng] ??= {})[ns] = mod.default;
}

export const NAMESPACES = Object.keys(resources.tr ?? {});

function setDocumentLang(lng: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = lng;
}

/** i18next'i başlatır (bir kez); yeniden çağrılırsa yalnız dili değiştirir. */
export function initI18n(opts: { forceLocale?: Locale } = {}) {
  const lng = opts.forceLocale ?? detectLocale();
  if (!i18next.isInitialized) {
    // Ad nokta ile bitebilir, metin de nokta koyar: çift nokta yazılmaz; üç nokta dokunulmaz (platformla aynı).
    i18next.use({ type: "postProcessor", name: "singleDot", process: (value: string) => value.replace(/(?<!\.)\.\.(?!\.)/g, ".") });
    void i18next.use(initReactI18next).init({
      postProcess: ["singleDot"],
      lng,
      fallbackLng: DEFAULT_LOCALE,
      defaultNS: "common",
      ns: NAMESPACES,
      resources,
      interpolation: { escapeValue: false },
      initAsync: false,
      returnNull: false,
    });
  } else if (i18next.language !== lng) {
    void i18next.changeLanguage(lng);
  }
  setDocumentLang(lng);
  return i18next;
}

/** Platform kipinde dil seçimi kişinin hesabına yazılır (kabuğun `changeLocale`'i; `oturum/Kabuk.tsx` bağlar). */
let accountLocale: ((locale: Locale) => unknown) | null = null;
export function bindAccountLocale(fn: ((locale: Locale) => unknown) | null): void {
  accountLocale = fn;
}

/** Arayüz dilini anında değiştirir ve seçimi kaydeder (yerel kip: yerel kayıt + `sod_lang` çerezi; platform: hesap). */
export function changeLocale(locale: Locale): void {
  if (accountLocale) {
    void accountLocale(locale);
    return;
  }
  setLocale(locale);
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
  setDocumentLang(locale);
}

/** Etkin arayüz dili. */
export function currentLocale(): Locale {
  return i18next.language === "tr" ? "tr" : "en";
}

export { i18next as i18n };
export type { Locale } from "./locale.ts";
