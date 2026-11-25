// Sayfa anahtarları ve yolları. Yeni sayfa: buraya ekle, src/pages/<anahtar>.mjs ve src/content/<anahtar>.mjs yaz.

export const LANGS = ['tr', 'en'];

export const PAGES = {
  home: { tr: '/', en: '/en/' },
  deciship: { tr: '/urunler/deciship/', en: '/en/products/deciship/' },
  orderloom: { tr: '/urunler/orderloom/', en: '/en/products/orderloom/' },
  tagpress: { tr: '/urunler/tagpress/', en: '/en/products/tagpress/' },
  pricing: { tr: '/fiyatlar/', en: '/en/pricing/' },
  about: { tr: '/hakkimizda/', en: '/en/about/' },
  contact: { tr: '/iletisim/', en: '/en/contact/' },
  privacy: { tr: '/gizlilik/', en: '/en/privacy/' },
  terms: { tr: '/kosullar/', en: '/en/terms/' },
};

// 404 bir yol değil, dosyadır; dile göre nginx ve dev.mjs seçer.
export const NOT_FOUND = { tr: '404.html', en: 'en/404.html' };

// Arama motoruna açık sayfalar (sitemap). Gizlilik ve koşullar noindex.
export const INDEXED = ['home', 'deciship', 'orderloom', 'tagpress', 'pricing', 'about', 'contact'];
