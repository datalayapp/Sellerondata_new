/** Bileşen testleri için: anahtar ve değişkenler metin olarak döner ("top.nav:{"name":"Merkez"}"). */
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);
const i18n = { language: 'tr' };
export const useTranslation = () => ({ t, i18n });
export const initReactI18next = { type: '3rdParty', init: () => undefined };
