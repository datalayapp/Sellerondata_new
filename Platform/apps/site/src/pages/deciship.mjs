// DeciShip ürün sayfası. Pano: DeciShip.dc.html. Metin: content/deciship.mjs.
// Üç ürün sayfası aynı kalıbı paylaşır; kalıp (productPage) burada, orderloom.mjs ve tagpress.mjs içe aktarır.
// CSS öneki: ortak düzen .pg-prod-*, DeciShip'e özgü .pg-deciship-* (styles/products.css). Renkler gövde sınıfından (--p-*).
// Satır içi stil yok (CSP); SVG'ler satır içi ama style özniteliksiz, dekoratif olanlar aria-hidden.
import content from '../content/deciship.mjs';

const HIDE = 'aria-hidden="true" focusable="false"';

/** Hero'daki 56 px işaret: panodaki gibi yarı saydam beyaz çerçeveli (public/*-mark.svg'de çerçeve yok). */
export const heroMark = (fill, inner) =>
  `<svg class="pg-prod-mark" width="56" height="56" viewBox="0 0 64 64" ${HIDE}><rect width="64" height="64" rx="14" fill="${fill}" stroke="#ffffff40" stroke-width="2"></rect>${inner}</svg>`;

/** "Ne kazandırır" simgesi: 24 px, çizgi rengi currentColor (.pg-prod-ico → --p-text). */
export const ico = (paths) => `<span class="pg-prod-ico"><svg width="24" height="24" viewBox="0 0 24 24" ${HIDE}>${paths}</svg></span>`;

const mailto = (email, subject) => `mailto:${email}?subject=${encodeURIComponent(subject)}`;

/**
 * Ortak ürün sayfası gövdesi.
 * @param ctx   shell bağlamı
 * @param key   'deciship' | 'orderloom' | 'tagpress'
 * @param c     content[lang]
 * @param o     { mark, art, icons[3], open (kayıt açık mı), extraHero (hero sonuna ek, örn. cetvel) }
 */
export function productPage(ctx, key, c, o) {
  const { esc } = ctx;
  const email = ctx.t.footer.email;
  // Açık ürün: kayıt uygulamada. Açılmamış ürün: konu satırlı mailto (EN'de EN konu).
  const primaryHref = o.open ? ctx.app.register : mailto(email, c.subject);
  const closeHref = o.open ? ctx.app.register : mailto(email, c.subject);
  const others = ctx.products.filter((p) => p.key !== key);

  const why = c.why.items
    .map(
      (it, i) => `<li class="pg-prod-item">
          ${ico(o.icons[i])}
          <div>
            <h3 class="pg-prod-h4">${esc(it.title)}</h3>
            <p class="pg-prod-text">${esc(it.text)}</p>
          </div>
        </li>`,
    )
    .join('\n        ');

  const steps = c.how.steps
    .map(
      (s, i) => `<li>
          <span class="pg-prod-step-n">${i + 1}</span>
          <h3 class="pg-prod-h4">${esc(s.title)}</h3>
          <p class="pg-prod-text">${esc(s.text)}</p>
        </li>`,
    )
    .join('\n        ');

  const faq = c.faq
    .map(
      (f, i) => `<details${i === 0 ? ' open' : ''}>
          <summary>${esc(f.q)}</summary>
          <p>${esc(f.a)}</p>
        </details>`,
    )
    .join('\n        ');

  // Destek satırı (yalnız DeciShip): SSS listesinin altında, kit diliyle tek satır.
  const support = c.support
    ? `\n        <p class="pg-deciship-support">${esc(c.support.text)} <a href="${mailto(email, c.support.subject)}">${email}</a></p>`
    : '';

  return `<section class="hero pg-prod-hero">
  <div class="wrap pg-prod-hero-grid">
    <div class="pg-prod-hero-txt">
      <div class="pg-prod-id">
        ${o.mark}
        ${o.open ? ctx.badge(true, key) : ''}
        <p class="eyebrow">${esc(c.eyebrow)}</p>
      </div>
      <h1>${esc(c.h1)}</h1>
      <p class="lead">${esc(c.lead)}</p>
      <div class="pg-prod-ctas">
        ${o.open ? ctx.startCta({ label: esc(c.primary), openProduct: key }) : `<a class="btn btn-sun" href="${primaryHref}">${esc(c.primary)}</a>`}
        <a class="btn btn-line pg-prod-how-link" href="#${c.howId}">${esc(c.howLink)}</a>
      </div>
    </div>
    <div class="pg-prod-art">
      ${o.art}
    </div>
  </div>${o.extraHero || ''}
</section>

<section class="sec pg-prod-why-sec">
  <div class="wrap pg-prod-why">
    <div>
      <p class="eyebrow pg-prod-eyebrow">${esc(c.why.eyebrow)}</p>
      <h2 class="h2 pg-prod-h2">${esc(c.why.title)}</h2>
    </div>
    <ul class="pg-prod-list">
        ${why}
    </ul>
  </div>
</section>

<section id="${c.howId}" class="sec">
  <div class="wrap">
    <p class="eyebrow pg-prod-eyebrow">${esc(c.how.eyebrow)}</p>
    <h2 class="h2 pg-prod-h2 pg-prod-how-h2">${esc(c.how.title)}</h2>
    <ol class="pg-prod-steps">
        ${steps}
    </ol>
  </div>
</section>

<section class="sec pg-prod-flush">
  <div class="wrap pg-prod-faq">
    <h2 class="h3">${esc(c.faqTitle)}</h2>
    <div>
      <div class="faq">
        ${faq}
      </div>${support}
    </div>
  </div>
</section>

<section class="sec pg-prod-flush">
  <div class="wrap">
    <div class="pg-prod-eco">
      <div class="pg-prod-eco-marks">${others.map((p) => ctx.mark(p.key, 40)).join('')}</div>
      <p class="pg-prod-eco-text">${esc(c.eco)}</p>
      <a class="tlink pg-prod-eco-link" href="${ctx.href('home')}#${ctx.t.productsAnchor}">${esc(c.ecoLink)} <span aria-hidden="true">→</span></a>
    </div>
  </div>
</section>

<section class="sec pg-prod-close">
  <div class="wrap pg-prod-close-in">
    <div class="pg-prod-close-txt">
      <h2 class="h2">${esc(c.close.title)}</h2>
      <p>${esc(c.close.text)}</p>
    </div>
    ${o.open ? ctx.startCta({ label: esc(c.close.label), openProduct: key }) : `<a class="btn btn-sun" href="${closeHref}">${esc(c.close.label)}</a>`}
  </div>
</section>`;
}

// ---------------------------------------------------------------- DeciShip'e özgü çizimler (pano ile birebir)
const MARK = heroMark(
  '#1d5bd8',
  '<path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"></path><path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"></path><path d="M39 16L25 24" stroke="#1d5bd8" stroke-width="2.8" stroke-linecap="round"></path><path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke="#fdb022" stroke-width="2.63" stroke-linecap="round" stroke-linejoin="round"></path>',
);

// Ölçülen koli: kesikli dış kutu (fatura ölçüsü) ve amber ölçü okları.
const ART = `<svg viewBox="0 0 480 480" ${HIDE}>
        <path d="M411.1 310L447.2 289.2L447.2 133.2L285 39.6L68.9 164.4L68.9 320.4L95.9 336M231 258L447.2 133.2M231 258L68.9 164.4" fill="none" stroke="#b5cbff" stroke-width="2" stroke-dasharray="8 8" stroke-linejoin="round"></path>
        <path d="M231 414L411.1 310L411.1 180L276 102L95.9 206L95.9 336Z" fill="#9db9f5"></path>
        <path d="M231 414L95.9 336L95.9 206L231 284Z" fill="#d3e0fd"></path>
        <path d="M231 284L411.1 180L276 102L95.9 206Z" fill="#ffffff"></path>
        <path d="M172.5 250.2L352.6 146.2L334.6 135.8L154.4 239.8Z" fill="#1d5bd8" fill-opacity="0.16"></path>
        <path d="M172.5 250.2L154.4 239.8L154.4 286.6L172.5 297Z" fill="#1d5bd8" fill-opacity="0.16"></path>
        <path d="M240 419.2L276 440M420.1 315.2L456.2 336M222 419.2L186 440M86.9 341.2L23.8 377.6M86.9 211.2L23.8 247.6" fill="none" stroke="#fdb022" stroke-width="2" stroke-linecap="round"></path>
        <path d="M262.5 432.2L442.7 328.2M273.7 431.5L262.5 432.2L268.7 422.9M436.5 337.5L442.7 328.2L431.5 328.9M199.5 432.2L64.4 354.2M193.3 422.9L199.5 432.2L188.3 431.5M75.5 354.9L64.4 354.2L70.5 363.5M32.9 372.4L32.9 242.4M37.9 362.4L32.9 372.4L27.9 362.4M37.9 252.4L32.9 242.4L27.9 252.4" fill="none" stroke="#fdb022" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>`;

const S = 'fill="none" stroke="currentColor" stroke-width="1.8"';
const ICONS = [
  // cetvel
  `<path d="M3 16.5L16.5 3L21 7.5L7.5 21Z" ${S} stroke-linejoin="round"></path><path d="M7.5 12l2 2M10.5 9l2 2M13.5 6l2 2" ${S} stroke-linecap="round"></path>`,
  // büyüteç
  `<circle cx="10.5" cy="10.5" r="6.5" ${S}></circle><path d="M15.5 15.5L21 21" ${S} stroke-linecap="round"></path>`,
  // belge
  `<path d="M6 3h9l4 4v14H6Z" ${S} stroke-linejoin="round"></path><path d="M14.5 3v4.5H19M9 12h7M9 16h5" ${S} stroke-linecap="round" stroke-linejoin="round"></path>`,
];

export function render(lang, ctx) {
  const c = content[lang];
  return {
    title: c.title,
    description: c.description,
    bodyClass: 'pg-prod',
    body: productPage(ctx, 'deciship', c, {
      mark: MARK,
      art: ART,
      icons: ICONS,
      open: true,
      // Cetvel yalnız DeciShip'te (KIT.md).
      extraHero: '\n  <div class="pg-deciship-ruler" aria-hidden="true"></div>',
    }),
  };
}
