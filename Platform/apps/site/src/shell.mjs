// Ortak parçalar: head, üst çubuk (Ürünlerimiz paneli, profil paneli, mobil menü), altbilgi, kapanış bandı, sayfa başlığı.
// Kaynak: Claude Design panoları (Main.dc.html). Satır içi stil yok (CSP style-src 'self'); her şey site.css sınıflarıyla.
import COMMON, { PRODUCTS } from './content/common.mjs';
import { PAGES } from './routes.mjs';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const S_MARK = '/sellerondata-mark-light.svg';

const CHEV = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';
const BURGER_ICO = '<svg class="ico-open" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" stroke="#ffffff" stroke-width="2" stroke-linecap="round"></path></svg><svg class="ico-close" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="#ffffff" stroke-width="2" stroke-linecap="round"></path></svg>';
const person = (color) => `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision"><circle cx="12" cy="8.25" r="4" fill="none" stroke="${color}" stroke-width="2"></circle><path d="M4.5 20c1.25-3.6 4.15-5.5 7.5-5.5s6.25 1.9 7.5 5.5" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

/** Ürün işareti (public/<ürün>-mark.svg). Dekoratif: alt boş. */
export const mark = (productKey, size = 44, cls = 'mark') => {
  const p = PRODUCTS.find((x) => x.key === productKey);
  return `<img class="${cls}" src="${p.mark}" width="${size}" height="${size}" alt="">`;
};

/** Kapalı deneme: üst çubuk, hesap paneli ve mobil menüdeki "Hesap aç" etiketleri "Erken erişim isteyin" olur. */
function inviteText(t) {
  const cta = t.invite.cta;
  return { ...t, nav: { ...t.nav, register: t.invite.nav }, acct: { ...t.acct, register: cta }, sheet: { ...t.sheet, register: cta } };
}

/** "Açık" rozeti (6 px amber nokta) ya da "Yakında" (noktasız). Renk zemine göre CSS'ten gelir. */
export const badge = (lang, available, productKey) =>
  available
    ? `<span class="nv-badge nv-b-${productKey}"><span class="nv-dot"></span>${COMMON[lang].dd.open}</span>`
    : `<span class="nv-badge nv-b-${productKey}">${COMMON[lang].dd.soon}</span>`;

/**
 * Sayfa modüllerine verilen bağlam. Sözleşme README yerine burada:
 *   ctx.lang, ctx.key, ctx.other (öbür dil)
 *   ctx.t        ortak metinler (content/common.mjs, bu dil)
 *   ctx.products ürün listesi: { key, name, mark, available, tagline, href }
 *   ctx.href(key, lang?)  sayfa yolu (örn. ctx.href('pricing'))
 *   ctx.app.register / ctx.app.login  uygulama adresleri (?lang=tr ya da ?lang=en)
 *   ctx.app.home / ctx.app.profile / ctx.app.security / ctx.app.firms / ctx.app.team  giriş yapılmış hal (Merkez, Hesabım'ın
 *                üç bölümü, ekip; ?lang=tr ya da ?lang=en)
 *   ctx.esc, ctx.mark(productKey, size), ctx.badge(available, productKey)
 *   ctx.startCta({ label, cls, openProduct })  "başla" düğmesi: giriş yapılmamışsa kayıt (label), giriş yapılmışsa "Merkez'e git" (openProduct:'deciship' ise "DeciShip'i aç")
 *   ctx.ctaBand({ title?, label?, href?, cls? })  amber kapanış bandı
 *   ctx.pageHead({ eyebrow, title, lead?, cls? }) lacivert sayfa başlığı (h1 içerir)
 *   ctx.APP_URL, ctx.SITE_URL
 *   ctx.inviteOnly  kapalı deneme derlemesi (SIGNUP_MODE=invite): "Hesap aç" yerine "Erken erişim isteyin" (destek postası)
 */
export function makeCtx(lang, key, { APP_URL, SITE_URL, SIGNUP_MODE = 'open' }) {
  const inviteOnly = SIGNUP_MODE === 'invite';
  const t = inviteOnly ? inviteText(COMMON[lang]) : COMMON[lang];
  const href = (k, l = lang) => PAGES[k][l];
  const appUrl = (p) => `${APP_URL}${p}?lang=${lang}`;
  const ctx = {
    lang,
    key,
    other: lang === 'tr' ? 'en' : 'tr',
    t,
    APP_URL,
    SITE_URL,
    href,
    inviteOnly,
    app: {
      // Kapalı denemede kayıt düğmeleri destek postasına gider (Merkez kayıt ekranı davetsiz kişiye form göstermez).
      register: inviteOnly ? `mailto:${t.footer.email}?subject=${encodeURIComponent(t.invite.subject)}` : appUrl('/register'),
      login: appUrl('/login'),
      home: appUrl('/home'),
      deciship: `${APP_URL}/deciship/`, // DeciShip dilini hesaptan alır: ?lang yok
      // Hesabım'ın üç bölümü (Merkez'in kabuğundaki kullanıcı menüsüyle aynı sıra ve ad).
      profile: appUrl('/account/profile'),
      security: appUrl('/account/security'),
      firms: appUrl('/account/firms'),
      team: appUrl('/account/team'),
    },
    products: PRODUCTS.map((p) => ({ ...p, tagline: t.taglines[p.key], href: href(p.key) })),
    esc,
    mark,
    badge: (available, productKey) => badge(lang, available, productKey),
  };
  ctx.startCta = (o) => startCta(ctx, o);
  ctx.ctaBand = (o = {}) => ctaBand(ctx, o);
  ctx.pageHead = (o) => pageHead(o);
  return ctx;
}

export function head(ctx, { title, description, index = true, assets }) {
  const { lang, key, SITE_URL, t } = ctx;
  const other = ctx.other;
  const alt = (l) => SITE_URL + PAGES[key][l];
  let links = '';
  if (PAGES[key] && index) {
    links = `<link rel="canonical" href="${alt(lang)}">
<link rel="alternate" hreflang="tr" href="${alt('tr')}">
<link rel="alternate" hreflang="en" href="${alt('en')}">
<link rel="alternate" hreflang="x-default" href="${alt('en')}">
<meta property="og:url" content="${alt(lang)}">
<meta property="og:locale" content="${t.locale}">
<meta property="og:locale:alternate" content="${COMMON[other].locale}">`;
  } else if (PAGES[key]) {
    links = `<meta name="robots" content="noindex">
<link rel="alternate" hreflang="tr" href="${alt('tr')}">
<link rel="alternate" hreflang="en" href="${alt('en')}">`;
  } else {
    links = '<meta name="robots" content="noindex">';
  }
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0a1a3a">
${links}
<meta property="og:type" content="website">
<meta property="og:site_name" content="SellerOnData">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="SellerOnData">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/ibm-plex-sans-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${assets.css}">
<script src="${assets.js}" defer></script>`;
}

// Dil anahtarı: aynı sayfanın öbür dildeki karşılığı. 404'te ana sayfa.
const langHref = (ctx, l) => (PAGES[ctx.key] ? PAGES[ctx.key][l] : PAGES.home[l]);

function ddPanel(ctx) {
  const { t } = ctx;
  const rows = ctx.products
    .map(
      (p) => `<a class="dd-row dd-${p.key}" href="${p.href}">${mark(p.key, 44)}<span class="dd-txt"><span class="dd-name">${p.name}${p.available ? ' ' + ctx.badge(true, p.key) : ''}</span><span class="dd-desc">${p.tagline}</span></span><span class="dd-go" aria-hidden="true">→</span></a>`,
    )
    .join('');
  return `<div class="dd-panel"><div class="dd-list"><p class="dd-cap">${t.dd.cap}</p>${rows}<a class="dd-more" href="${ctx.href('home')}#${t.productsAnchor}">${t.dd.all} <span aria-hidden="true">→</span></a></div></div>`;
}

// Giriş yapılmış hesap menüsünün simgeleri (Mobil.dc.html "4 · Hesap menüsü – giriş yapılmış").
const mi = (paths, color = '#0f1a2e') => `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICO_HUB = mi('<path d="M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z"></path>');
const ICO_PROFILE = mi('<circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"></path>');
const ICO_LOCK = mi('<rect x="5" y="10.5" width="14" height="10" rx="1.5"></rect><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>');
const ICO_FIRMS = mi('<path d="M4.5 21V3.5h9.5V21M14 9.5h5.5V21M2.5 21h19M8 7h3M8 11h3M8 15h3M16.5 13h.5M16.5 16.5h.5"></path>');
const ICO_TEAM = mi('<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c0-3.5 2.9-5.5 6.5-5.5s6.5 2 6.5 5.5"></path><circle cx="17" cy="9" r="2.5"></circle><path d="M17 14.5c2.6 0 4.5 1.5 4.5 4.5"></path>');
const ICO_OUT = mi('<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"></path>', '#475467');
const ICO_GLOBE = mi('<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"></path>');
const ICO_CHECK = '<svg class="acct-check" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';

/**
 * Dil seçimi (üst çubuktaki TR | EN ikilisinin yerine): giriş yapılmışsa çıkışın hemen üstünde, yapılmamışsa panelin altında.
 * İç içe <details>: betik yoksa da açılır. Seçenekler aynı sayfanın öbür dildeki adresine giden bağlantılardır
 * (hreflang + lang; site.js aynı tıklamada sod_lang çerezini yazar). name özniteliği yok: üst çubuk panelleriyle yarışmaz.
 */
function acctLang(ctx) {
  const { t, lang } = ctx;
  const opts = ['tr', 'en']
    .map((l) => `<li><a class="acct-lo" href="${langHref(ctx, l)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ''}><span>${t.langNames[l]}</span>${l === lang ? ICO_CHECK : ''}</a></li>`)
    .join('');
  return `<details class="acct-lang"><summary class="acct-mi">${ICO_GLOBE}<span>${t.acct.lang}</span><span class="acct-lang-cur" lang="${lang}">${t.langNames[lang]}</span>${CHEV}</summary><ul class="acct-langs">${opts}</ul></details>`;
}

/**
 * Profil paneli, iki hal birden çizilir. Varsayılan "giriş yapılmamış" (data-auth="out"): betik yoksa da çalışır.
 * site.js uygulamanın site-session ucunu yoklar; giriş yapılmışsa <body data-session="in"> olur ve data-auth="in"
 * öğeleri görünür. Ad, firma ve baş harfler data-sod="…" öğelerine textContent ile yazılır (HTML olarak değil).
 * Kimlik bilgisi sitede hiç girilmez: giriş ve kayıt uygulamanın kendi kökenindeki formlardır (ARCHITECTURE §5).
 */
function acctPanel(ctx) {
  const { t } = ctx;
  const a = t.acct;
  const minis = ctx.products.map((p) => mark(p.key, 20, 'mark-sm')).join('');
  const out = `<div class="acct-body" data-auth="out"><div class="acct-head"><span class="acct-av">${person('#0a1a3a')}</span><span class="acct-txt"><span class="acct-t">${a.title}</span><span class="acct-s">${a.sub}</span></span></div><a class="btn btn-sun" href="${ctx.app.register}">${a.register}</a><a class="btn acct-in" href="${ctx.app.login}">${a.login}</a><div class="acct-foot"><span class="acct-marks">${minis}</span><span>${a.foot}</span></div>${acctLang(ctx)}</div>`;
  const me = `<div class="acct-body acct-me" data-auth="in"><div class="acct-head acct-who"><span class="acct-av acct-av-me" data-sod="initials" aria-hidden="true"></span><span class="acct-txt"><span class="acct-t" data-sod="name"></span><span class="acct-s" data-sod="org" hidden></span></span></div><div class="acct-rule"></div><a class="acct-mi" href="${ctx.app.home}">${ICO_HUB}<span>${a.hub}</span></a><a class="acct-mi" href="${ctx.app.profile}">${ICO_PROFILE}<span>${a.profile}</span></a><a class="acct-mi" href="${ctx.app.security}">${ICO_LOCK}<span>${a.security}</span></a><a class="acct-mi" href="${ctx.app.firms}">${ICO_FIRMS}<span>${a.firms}</span></a><a class="acct-mi" href="${ctx.app.team}" data-sod="team" hidden>${ICO_TEAM}<span>${a.team}</span></a><div class="acct-rule"></div>${acctLang(ctx)}<button class="acct-mi acct-logout" type="button" data-sod="logout">${ICO_OUT}<span>${a.logout}</span></button><p class="acct-err" data-sod="logout-error" role="alert" hidden>${a.logoutFailed}</p></div>`;
  return `<details class="acct" name="ust"><summary aria-label="${a.label}"><span class="acct-ico" data-auth="out">${person('#ffffff')}</span><span class="acct-ini" data-auth="in" data-sod="initials" aria-hidden="true"></span></summary><div class="acct-panel">${out}${me}</div></details>`;
}

function sheet(ctx) {
  const { t } = ctx;
  const cur = (k) => (ctx.key === k ? ' aria-current="page"' : '');
  const rows = ctx.products
    .map(
      (p) => `<a class="sh-row" href="${p.href}"${cur(p.key)}>${mark(p.key, 40)}<span class="dd-txt"><span class="dd-name">${p.name}${p.available ? ' ' + ctx.badge(true, p.key) : ''}</span><span class="sh-desc">${p.tagline}</span></span></a>`,
    )
    .join('');
  return `<details class="burger" name="ust"><summary aria-label="${t.nav.menu}">${BURGER_ICO}</summary><div class="sheet"><p class="eyebrow sh-cap">${t.dd.cap}</p>${rows}<div class="sh-rule"></div><a class="sh-link" href="${ctx.href('pricing')}"${cur('pricing')}>${t.nav.pricing}</a><a class="sh-link" href="${ctx.href('about')}"${cur('about')}>${t.nav.about}</a><a class="sh-link" href="${ctx.href('contact')}"${cur('contact')}>${t.nav.contact}</a><div class="sh-rule"></div><a class="sh-link sh-login" href="${ctx.app.login}" data-auth="out">${t.sheet.login}</a><a class="btn btn-sun sh-cta" href="${ctx.app.register}" data-auth="out">${t.sheet.register}</a><a class="btn btn-sun sh-cta" href="${ctx.app.home}" data-auth="in">${t.sheet.hub}</a><div class="sh-langs">${acctLang(ctx)}</div></div></details>`;
}

export function header(ctx) {
  const { t, key } = ctx;
  const isProduct = ctx.products.some((p) => p.key === key);
  const on = (k) => (key === k ? ' class="on" aria-current="page"' : '');
  return `<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${ctx.href('home')}" aria-label="${t.home}"><img src="${S_MARK}" width="32" height="32" alt=""><span>SellerOnData</span></a>
    <nav class="nav" aria-label="${t.nav.main}">
      <details class="dd" name="ust"><summary${isProduct ? ' class="on"' : ''}>${t.nav.products} ${CHEV}</summary>${ddPanel(ctx)}</details>
      <a href="${ctx.href('pricing')}"${on('pricing')}>${t.nav.pricing}</a>
      <a href="${ctx.href('about')}"${on('about')}>${t.nav.about}</a>
      <a href="${ctx.href('contact')}"${on('contact')}>${t.nav.contact}</a>
    </nav>
    <div class="top-r">
      <a class="login" href="${ctx.app.login}" data-auth="out">${t.nav.login}</a>
      <a class="btn btn-sun" href="${ctx.app.register}" data-auth="out">${t.nav.register}</a>
      <a class="btn btn-sun" href="${ctx.app.home}" data-auth="in">${t.nav.hub}</a>
      ${acctPanel(ctx)}
    </div>
    ${sheet(ctx)}
  </div>
</header>`;
}

export function footer(ctx) {
  const { t, lang } = ctx;
  const f = t.footer;
  const li = (h, label) => `<li><a href="${h}">${label}</a></li>`;
  const langs = ['tr', 'en']
    .map((l) => `<a${l === lang ? ' class="on" aria-current="true"' : ''} href="${langHref(ctx, l)}" hreflang="${l}" lang="${l}">${t.langNames[l]}</a>`)
    .join('<span aria-hidden="true"> · </span>');
  return `<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <p class="foot-brand"><img src="${S_MARK}" width="28" height="28" alt="">SellerOnData</p>
        <p class="foot-tag">${f.tag}</p>
      </div>
      <nav aria-label="${f.productsLabel}"><h2>${f.products}</h2><ul>${ctx.products.map((p) => li(p.href, p.name)).join('')}${li(ctx.href('pricing'), t.nav.pricing)}</ul></nav>
      <nav aria-label="${f.companyLabel}"><h2>${f.company}</h2><ul>${li(ctx.href('about'), t.nav.about)}${li(ctx.href('contact'), t.nav.contact)}${li(ctx.href('privacy'), f.privacy)}${li(ctx.href('terms'), f.terms)}</ul></nav>
      <div><h2>${f.contact}</h2><ul><li><a href="mailto:${f.email}">${f.email}</a></li><li>${f.phone}</li><li>${f.address}</li></ul></div>
    </div>
    <p class="foot-mark" aria-hidden="true">SellerOnData</p>
    <div class="foot-bar"><span>${f.copy}</span><span class="foot-langs">${langs}</span></div>
  </div>
</footer>`;
}

/**
 * Kayıt çağrısı iki hal birden: giriş yapılmamışsa uygulamada kayıt, giriş yapılmışsa Merkez (site.js data-session).
 * Betik yoksa kayıt görünür; giriş yapmış kişi /register'dan zaten Merkez'e yönlenir.
 */
export function startCta(ctx, { label, cls = 'btn btn-sun', openProduct = '' }) {
  if (ctx.inviteOnly) label = ctx.t.invite.cta;
  // Ürün sayfasında giriş yapmış kişi doğrudan ürüne geçer (DeciShip: /deciship/); diğer sayfalarda Merkez.
  const [inHref, inLabel] = openProduct === 'deciship' ? [ctx.app.deciship, ctx.t.nav.openDeciship] : [ctx.app.home, ctx.t.nav.hub];
  return `<a class="${cls}" href="${ctx.app.register}" data-auth="out">${label}</a><a class="${cls}" href="${inHref}" data-auth="in">${inLabel}</a>`;
}

/** Amber kapanış bandı. Varsayılan: ortak metin + "Hesap aç" uygulamaya. `cls`: ek sınıf (örn. pg-home-vign). */
export function ctaBand(ctx, { title = ctx.t.cta.title, label = ctx.t.cta.label, href = ctx.app.register, cls = '' } = {}) {
  return `<section class="sec cta-band${cls ? ' ' + cls : ''}">
  <div class="wrap cta-in">
    <h2 class="h3">${title}</h2>
    ${href === ctx.app.register ? startCta(ctx, { label, cls: 'btn cta-btn' }) : `<a class="btn cta-btn" href="${href}">${label}</a>`}
  </div>
</section>`;
}

/** Lacivert sayfa başlığı (şirket ve hukuki sayfalar, KIT.md "Ortak sayfa başlığı"). Sayfanın tek h1'i budur. */
export function pageHead({ eyebrow, title, lead = '', cls = '' }) {
  return `<section class="phead${cls ? ' ' + cls : ''}">
  <div class="wrap">
    ${eyebrow ? `<p class="eyebrow phead-eyebrow">${eyebrow}</p>` : ''}
    <h1 class="h2">${title}</h1>
    ${lead ? `<p class="lead phead-lead">${lead}</p>` : ''}
  </div>
</section>`;
}

/** Uygulamanın kökeni (şema + alan adı + port). site.js oturumu buradan yoklar; nginx CSP'sindeki connect-src de budur. */
export const appOrigin = (appUrl) => new URL(appUrl).origin;

/** Bütün sayfa. `result` sayfa modülünün render() dönüşüdür. `data-app`: site.js'in yoklayacağı uygulama kökeni. */
export function documentHtml(ctx, result, assets) {
  const { title, description, body, index = true, bodyClass = '' } = result;
  return `<!doctype html>
<html lang="${ctx.lang}">
<head>
${head(ctx, { title, description, index, assets })}
</head>
<body class="page pg-${ctx.key}${bodyClass ? ' ' + bodyClass : ''}" data-app="${esc(appOrigin(ctx.APP_URL))}">
<a class="skip" href="#main">${ctx.t.skip}</a>
${header(ctx)}
<main id="main">
${body}
</main>
${footer(ctx)}
</body>
</html>
`;
}
