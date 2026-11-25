// Ortak metinler: üst çubuk, paneller, mobil menü, altbilgi, kapanış bandı, ürün listesi.
// TR ve EN ayrı yazılır, kelime kelime çeviri değildir. TR'de hitap "siz". Ürün adları ve marka çevrilmez.
// Düğme etiketleri uygulamayla aynıdır ve e2e testleri bunlara bakar: "Giriş"/"Sign in", "Hesap aç"/"Create account".

import { readFileSync } from 'node:fs';

// Ürün listesi, adları, işaretleri ve sloganları araç kaydından üretilen products.generated.json'dan gelir
// (Platform/scripts/products-gen.mjs). Site ayrı Docker bağlamında derlenir; kayda doğrudan erişmez.
// `available`: yalnız yayın durumu "public" olan araç açıktır.
const GENERATED = JSON.parse(readFileSync(new URL('./products.generated.json', import.meta.url), 'utf8'));
export const PRODUCTS = GENERATED.products.map((p) => ({ key: p.key, name: p.name, mark: p.mark, color: p.color, available: p.launch === 'public' }));
const taglines = (lang) => Object.fromEntries(GENERATED.products.map((p) => [p.key, p.tagline[lang]]));

const COMMON = {
  tr: {
    locale: 'tr_TR',
    skip: 'İçeriğe geç',
    home: 'SellerOnData ana sayfa',
    nav: {
      main: 'Ana menü',
      products: 'Ürünlerimiz',
      pricing: 'Fiyatlar',
      about: 'Hakkımızda',
      contact: 'İletişim',
      login: 'Giriş',
      register: 'Hesap aç',
      // Giriş yapılmışken "Hesap aç" yerine (site oturumu, ARCHITECTURE §5 "Tek hesap").
      hub: "Merkez'e git",
      openDeciship: "DeciShip'i aç",
      menu: 'Menü',
    },
    dd: { cap: 'ÜRÜNLERİMİZ', all: 'Bütün ürünleri görün', open: 'Açık', soon: 'Yakında' },
    // Ana sayfadaki ürünler bölümünün kimliği (dd "Bütün ürünleri görün" buraya gider).
    productsAnchor: 'urunler',
    taglines: taglines('tr'),
    acct: {
      label: 'Hesap',
      title: 'SellerOnData hesabınız',
      sub: 'Bütün araçlara tek hesapla girin.',
      register: 'Hesap aç',
      login: 'Giriş yap',
      foot: 'Tek hesap, bütün araçlar',
      // Giriş yapılmış hali (Mobil.dc.html "4 · Hesap menüsü – giriş yapılmış"). Ad ve firma adı betikle, metin olarak yazılır.
      hub: "Merkez'e git",
      profile: 'Hesabım',
      security: 'Güvenlik',
      firms: 'Firmalarım',
      team: 'Firma ve ekip',
      logout: 'Çıkış yap',
      logoutFailed: 'Çıkış yapılamadı. Bağlantınızı denetleyip yeniden deneyin.',
      // Dil seçimi panelin altında (üst çubuktaki TR | EN ikilisinin yerine). Dil adları langNames'ten.
      lang: 'Dil',
    },
    sheet: { login: 'Giriş yap', register: 'Hesap aç', hub: "Merkez'e git" },
    // Kapalı deneme (SIGNUP_MODE=invite derlemesi): "Hesap aç" düğmelerinin yerine destek postası.
    // `nav`: üst çubuktaki kısa hali (901 px'te uzun metin çubuğu taşırıyor).
    invite: { cta: 'Erken erişim isteyin', nav: 'Erken erişim', subject: 'Erken erişim isteği' },
    langNames: { tr: 'Türkçe', en: 'English' },
    footer: {
      tag: 'E-ticaret satıcıları için birbirine bağlı araçlar.',
      products: 'ÜRÜNLER',
      company: 'ŞİRKET',
      contact: 'İLETİŞİM',
      productsLabel: 'Ürünler',
      companyLabel: 'Şirket',
      privacy: 'Gizlilik ve KVKK',
      terms: 'Kullanım koşulları',
      email: 'destek@sellerondata.com',
      // Yer tutucular kullanıcı kararıyla kalır (KIT.md, Tur 2).
      phone: '[TELEFON]',
      address: '[ADRES]',
      copy: "© 2026 DatalaYapp. SellerOnData, DatalaYapp'ın bir markasıdır.",
    },
    cta: { title: 'Bugün ücretsiz başlayın.', label: 'Hesap aç' },
  },
  en: {
    locale: 'en_US',
    skip: 'Skip to content',
    home: 'SellerOnData home',
    nav: {
      main: 'Main menu',
      products: 'Products',
      pricing: 'Pricing',
      about: 'About',
      contact: 'Contact',
      login: 'Sign in',
      register: 'Create account',
      hub: 'Go to Hub',
      openDeciship: 'Open DeciShip',
      menu: 'Menu',
    },
    dd: { cap: 'OUR PRODUCTS', all: 'See all products', open: 'Open', soon: 'Soon' },
    productsAnchor: 'products',
    taglines: taglines('en'),
    acct: {
      label: 'Account',
      title: 'Your SellerOnData account',
      sub: 'Sign in to every tool with one account.',
      register: 'Create account',
      login: 'Sign in',
      foot: 'One account, every tool',
      // Merkez is "Hub" in the app (hub-web locales/en).
      hub: 'Go to Hub',
      profile: 'My account',
      security: 'Security',
      firms: 'My companies',
      team: 'Company and team',
      logout: 'Sign out',
      logoutFailed: "Couldn't sign out. Check your connection and try again.",
      lang: 'Language',
    },
    sheet: { login: 'Sign in', register: 'Create account', hub: 'Go to Hub' },
    invite: { cta: 'Request early access', nav: 'Early access', subject: 'Early access request' },
    langNames: { tr: 'Türkçe', en: 'English' },
    footer: {
      tag: 'Connected tools for e-commerce sellers.',
      products: 'PRODUCTS',
      company: 'COMPANY',
      contact: 'CONTACT',
      productsLabel: 'Products',
      companyLabel: 'Company',
      privacy: 'Privacy and KVKK',
      terms: 'Terms of use',
      email: 'destek@sellerondata.com',
      phone: '[PHONE]',
      address: '[ADDRESS]',
      copy: '© 2026 DatalaYapp. SellerOnData is a brand of DatalaYapp.',
    },
    cta: { title: 'Start free today.', label: 'Create account' },
  },
};

export default COMMON;
