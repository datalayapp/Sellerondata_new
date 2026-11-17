import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, pickInitialLocale } from '@sellerondata/contracts';
import commonTr from '../locales/tr/common.json';
import commonEn from '../locales/en/common.json';
import authTr from '../locales/tr/auth.json';
import authEn from '../locales/en/auth.json';
import measureTr from '../locales/tr/measure.json';
import measureEn from '../locales/en/measure.json';
import hubTr from '../locales/tr/hub.json';
import hubEn from '../locales/en/hub.json';

/** Cihaz dili. Yerel modül eklememek için Intl'den okunur (tek değer, ör. "tr-TR"); okunamazsa boş. */
export function deviceLanguages(): string[] {
  try {
    const l = new Intl.DateTimeFormat().resolvedOptions().locale;
    return l ? [l] : [];
  } catch {
    return [];
  }
}

/**
 * Mobil i18n. İlk dil (kullanıcı kararı 2026-11-12, `pickInitialLocale`): cihaz dili desteklenenlerdense o, yoksa İngilizce.
 * Kayıtlı tercih sonra uygulanır: giriş ekranındaki seçim (`K_LOGIN_LOCALE`), oturumda kişinin dili (`AuthContext`).
 */
void i18next.use(initReactI18next).init({
  lng: pickInitialLocale(null, deviceLanguages()),
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: 'common',
  resources: {
    tr: { common: commonTr, auth: authTr, measure: measureTr, hub: hubTr },
    en: { common: commonEn, auth: authEn, measure: measureEn, hub: hubEn },
  },
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

export const i18n = i18next;
/**
 * Dil zaten buysa i18next'e dokunulmaz: aynı dile geçiş de `languageChanged` yayar, `t`'ye bağlı her efekt yeniden çalışırdı
 * (öne gelişteki profil yenilemesi düzeltme formunu siliyordu, G4).
 */
export const setLocale = (locale: 'tr' | 'en') => (i18next.language === locale ? Promise.resolve(i18next.t) : i18next.changeLanguage(locale));
