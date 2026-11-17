import { LOCALES, type Locale } from '@sellerondata/contracts';
import { initShellI18n, setShellLocale } from '@sellerondata/shell';
import trHub from './locales/tr/hub.json';
import enHub from './locales/en/hub.json';
import trAuth from './locales/tr/auth.json';
import enAuth from './locales/en/auth.json';
import trAccount from './locales/tr/account.json';
import enAccount from './locales/en/account.json';
import trAiUsage from './locales/tr/aiUsage.json';
import enAiUsage from './locales/en/aiUsage.json';
import trRoles from './locales/tr/roles.json';
import enRoles from './locales/en/roles.json';
import trCloseOrg from './locales/tr/closeOrg.json';
import enCloseOrg from './locales/en/closeOrg.json';

/** Siteden gelen dil: `/register?lang=en`. Oturum açıksa kişinin dili yine öne geçer (§9). */
const param = new URLSearchParams(window.location.search).get('lang');
const fromSite = (LOCALES as readonly string[]).includes(param ?? '') ? (param as Locale) : undefined;

// Tek ad alanı `hub`; dosyalar üst düzey anahtarla ayrılır (auth.json `auth`, account.json `accountArea`, roles.json `roles`, closeOrg.json `closeOrg`): aynı anahtar iki dosyada olmaz.
const tr = { ...trHub, ...trAuth, ...trAccount, ...trAiUsage, ...trRoles, ...trCloseOrg };
const en = { ...enHub, ...enAuth, ...enAccount, ...enAiUsage, ...enRoles, ...enCloseOrg };

export const i18n = initShellI18n({
  locale: fromSite,
  resources: { tr: { hub: tr }, en: { hub: en } },
  defaultNS: 'hub',
});
if (fromSite) setShellLocale(fromSite);