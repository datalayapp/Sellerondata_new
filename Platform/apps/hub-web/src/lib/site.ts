import { PRODUCTS, type Locale, type ProductKey } from '@sellerondata/contracts';

/** Tanıtım sitesinin kökü (derlemede gömülür). Giriş ekranlarının site bağlantıları buraya gider. */
export const SITE_URL = ((import.meta.env.VITE_SITE_URL as string | undefined)?.trim() || 'http://localhost:8089').replace(/\/+$/, '');

/** Sitenin ürün dışı yolları (apps/site/src/routes.mjs ile aynı). Ürün sayfalarının yolu araç kaydındadır (`site`). */
const PAGES = {
  home: { tr: '/', en: '/en/' },
  pricing: { tr: '/fiyatlar/', en: '/en/pricing/' },
  about: { tr: '/hakkimizda/', en: '/en/about/' },
  contact: { tr: '/iletisim/', en: '/en/contact/' },
  privacy: { tr: '/gizlilik/', en: '/en/privacy/' },
  terms: { tr: '/kosullar/', en: '/en/terms/' },
} as const;

export type SitePage = keyof typeof PAGES | ProductKey;

const pathOf = (page: SitePage, lang: Locale): string => (page in PAGES ? PAGES[page as keyof typeof PAGES][lang] : (PRODUCTS[page as ProductKey].site?.[lang] ?? '/'));

export const siteHref = (page: SitePage, lang: Locale, hash?: string) => `${SITE_URL}${pathOf(page, lang)}${hash ? `#${hash}` : ''}`;
