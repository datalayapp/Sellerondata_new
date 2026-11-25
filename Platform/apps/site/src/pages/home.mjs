// Ana sayfa (/, /en/). Pano: Main.dc.html (onaylı tasarım). CSS öneki: .pg-home-* (src/styles/home.css).
// Bölümler: hero (ekosistem şeması) · "Bir hesap" · ürün kartları (#urunler / #products) · "Başlamak üç adım sürer" · kapanış bandı.
// Satır içi stil yok (CSP); panodaki style="..." değerleri home.css sınıflarına taşındı. SVG'ler dekoratif (aria-hidden).
import content from '../content/home.mjs';

// S logosu (hero şemasının ortası).
const S_LOGO = '<rect width="64" height="64" rx="14" fill="#ffffff"></rect><path d="M46 18H22a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h20a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H24" fill="none" stroke="#0f2a5c" stroke-width="5.5" stroke-linecap="round"></path><path d="M24 46H16" stroke="#fdb022" stroke-width="5.5" stroke-linecap="round"></path>';

// Ürün işaretlerinin iç çizimi (64×64). `frame`: çerçeve rengi ve kalınlığı (koyu zeminde ayrışsın diye).
const MARK_INNER = {
  deciship: { fill: '#1d5bd8', body: '<path d="M18 20L32 28L32 44.5L18 36.5ZM32 28L46 20L46 36.5L32 44.5Z" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"></path><path d="M32 12L46 20L32 28L18 20Z" fill="#fff" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"></path><path d="M39 16L25 24" stroke="#1d5bd8" stroke-width="2.8" stroke-linecap="round"></path><path d="M18 43L32 51M18 40.6v4.8M32 48.6v4.8" fill="none" stroke="#fdb022" stroke-width="2.63" stroke-linecap="round" stroke-linejoin="round"></path>' },
  orderloom: { fill: '#0e9384', body: '<path d="M26 21h21M26 32h21M26 43h21" stroke="#fff" stroke-width="4" stroke-linecap="round"></path><path d="M15.5 21l2.6 2.6 4-4.6M15.5 32l2.6 2.6 4-4.6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="18.5" cy="43" r="3.6" fill="#fdb022"></circle>' },
  tagpress: { fill: '#7a5af8', body: '<circle cx="32" cy="32" r="14" fill="#fff"></circle><path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" fill="none" stroke="#7a5af8" stroke-width="2.4" stroke-linecap="round"></path><path d="M12 19v-7h7M52 19v-7h-7M12 45v7h7M52 45v7h-7" fill="none" stroke="#fdb022" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>' },
};
const markBody = (key, stroke, sw) => `<rect width="64" height="64" rx="14" fill="${MARK_INNER[key].fill}" stroke="${stroke}" stroke-width="${sw}"></rect>${MARK_INNER[key].body}`;

/** Hero ekosistem şeması: ortada S logosu ("Tek hesap" üstünde), üç ürün dalı. Panodaki koordinatlar birebir. */
const ecoSvg = (c) => `<svg class="pg-home-eco" viewBox="0 0 560 520" width="560" height="520" aria-hidden="true" focusable="false">
          <path d="M280 188L60 61" stroke="#1d5bd8" stroke-width="2.5"></path>
          <path d="M280 188L500 61" stroke="#0e9384" stroke-width="2.5"></path>
          <path d="M280 188V414.2" stroke="#7a5af8" stroke-width="2.5"></path>
          <rect x="156" y="64" width="248" height="248" rx="44" fill="none" stroke="#ffffff14" stroke-width="1.5"></rect>
          <rect x="196" y="104" width="168" height="168" rx="26" fill="#0a1a3a" stroke="#ffffff26" stroke-width="1.5"></rect>
          <circle cx="156" cy="116.4" r="5" fill="#0a1a3a" stroke="#1d5bd8" stroke-width="2.5"></circle>
          <circle cx="404" cy="116.4" r="5" fill="#0a1a3a" stroke="#0e9384" stroke-width="2.5"></circle>
          <circle cx="280" cy="312" r="5" fill="#0a1a3a" stroke="#7a5af8" stroke-width="2.5"></circle>
          <circle cx="196" cy="139.5" r="5" fill="#1d5bd8"></circle>
          <circle cx="364" cy="139.5" r="5" fill="#0e9384"></circle>
          <circle cx="280" cy="272" r="5" fill="#7a5af8"></circle>
          <g transform="translate(208 116) scale(2.25)">${S_LOGO}</g>
          <g transform="translate(4 5) scale(1.75)">${markBody('deciship', '#ffffff40', 1.15)}</g>
          <g transform="translate(444 5) scale(1.75)">${markBody('orderloom', '#ffffff40', 1.15)}</g>
          <g transform="translate(224 358.2) scale(1.75)">${markBody('tagpress', '#ffffff40', 1.15)}</g>
          <text class="pg-home-eco-sub" x="280" y="84" text-anchor="middle" dominant-baseline="central">${c.hub}</text>
          <text class="pg-home-eco-lbl" x="60" y="131" text-anchor="middle" dominant-baseline="hanging">DeciShip</text>
          <text class="pg-home-eco-lbl" x="500" y="131" text-anchor="middle" dominant-baseline="hanging">OrderLoom</text>
          <text class="pg-home-eco-lbl" x="280" y="484.2" text-anchor="middle" dominant-baseline="hanging">TagPress</text>
        </svg>`;

// "Bir hesap" listesinin 24 px simgeleri (anahtar, ızgara, ekran).
const WHY_ICONS = [
  '<circle cx="8" cy="12" r="4.25" fill="none" stroke="#0f1a2e" stroke-width="1.75"></circle><circle cx="8" cy="12" r="1.25" fill="#fdb022"></circle><path d="M12.25 12H21M18 12v3.5M21 12v2.5" fill="none" stroke="#0f1a2e" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>',
  '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="#fdb022"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="#0f1a2e" stroke-width="1.75"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="none" stroke="#0f1a2e" stroke-width="1.75"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" fill="none" stroke="#0f1a2e" stroke-width="1.75"></rect>',
  '<rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="#0f1a2e" stroke-width="1.75"></rect><path d="M9 21h6M12 17v4" fill="none" stroke="#0f1a2e" stroke-width="1.75" stroke-linecap="round"></path><path d="M6.5 13l3-3 2.5 2 4.5-4.5" fill="none" stroke="#fdb022" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>',
];

// Kartların arka plan desenleri: kartın sağ-orta noktasına sabitlenir (iç svg x=100% y=50%), .pg-home-art-g ile ölçeklenir.
const ART = {
  deciship: '<g stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.5" stroke-linejoin="round" fill="none"><path d="M-480 -96.6L-330 -10L-180 -96.6L-330 -183.2Z" fill="#ffffff" fill-opacity="0.04" vector-effect="non-scaling-stroke"></path><path d="M-480 -96.6L-480 59.4L-330 146L-180 59.4L-180 -96.6M-330 -10L-330 146" vector-effect="non-scaling-stroke"></path><path d="M-255 -139.9L-405 -53.3" stroke="#b5cbff" stroke-opacity="0.32" vector-effect="non-scaling-stroke"></path></g><path d="M-480 77.4L-330 164M-480 68.4V86.4M-330 155V173" fill="none" stroke="#fdb022" stroke-opacity="0.7" stroke-width="1.5" stroke-linecap="round" vector-effect="non-scaling-stroke"></path><g stroke="#ffffff" stroke-opacity="0.2" stroke-width="1.5" stroke-linejoin="round" fill="none"><path d="M-130 -47.4L-34 8L62 -47.4L-34 -102.9Z" fill="#ffffff" fill-opacity="0.04" vector-effect="non-scaling-stroke"></path><path d="M-130 -47.4L-130 56.6L-34 112L62 56.6L62 -47.4M-34 8L-34 112" vector-effect="non-scaling-stroke"></path><path d="M14 -75.1L-82 -19.7" stroke="#b5cbff" stroke-opacity="0.26" vector-effect="non-scaling-stroke"></path></g>',
  orderloom: '<defs><mask id="pg-home-ol-mh" maskUnits="userSpaceOnUse" x="-3000" y="-400" width="3200" height="800"><rect x="-3000" y="-400" width="3200" height="800" fill="#ffffff"></rect><rect x="-224.7" y="-93" width="12" height="14" fill="#000000"></rect><rect x="-226.8" y="30.6" width="12" height="14" fill="#000000"></rect><rect x="-485.1" y="-51.8" width="12" height="14" fill="#000000"></rect><rect x="-487.3" y="75.2" width="12" height="14" fill="#000000"></rect></mask><mask id="pg-home-ol-mv" maskUnits="userSpaceOnUse" x="-3000" y="-400" width="3200" height="800"><rect x="-3000" y="-400" width="3200" height="800" fill="#ffffff"></rect><rect x="-227.6" y="-26.2" width="16" height="12" fill="#000000"></rect><rect x="-229.2" y="97.5" width="16" height="12" fill="#000000"></rect><rect x="-486.8" y="-107.3" width="16" height="12" fill="#000000"></rect><rect x="-489" y="45.8" width="16" height="12" fill="#000000"></rect></mask></defs><g fill="none" stroke-width="1.5" stroke-linecap="round" mask="url(#pg-home-ol-mh)"><path d="M-2600 -93.8C-2508.3 -86.1 -2416.7 -83.8 -2325 -89.1C-2233.3 -94.5 -2141.7 -106.4 -2050 -114.2C-1958.3 -121.9 -1866.7 -124.2 -1775 -118.9C-1683.3 -113.5 -1591.7 -101.6 -1500 -93.8C-1408.3 -86.1 -1316.7 -83.8 -1225 -89.1C-1133.3 -94.5 -1041.7 -106.4 -950 -114.2C-858.3 -121.9 -766.7 -124.2 -675 -118.9C-583.3 -113.5 -491.7 -101.6 -400 -93.8C-308.3 -86.1 -216.7 -83.8 -125 -89.1C-33.3 -94.5 58.3 -106.4 150 -114.2" stroke="#ffffff" stroke-opacity="0.2" vector-effect="non-scaling-stroke"></path><path d="M-2600 -18C-2491.7 -22.8 -2383.3 -36.7 -2275 -47.2C-2166.7 -57.6 -2058.3 -62.8 -1950 -58C-1841.7 -53.2 -1733.3 -39.3 -1625 -28.8C-1516.7 -18.4 -1408.3 -13.2 -1300 -18C-1191.7 -22.8 -1083.3 -36.7 -975 -47.2C-866.7 -57.6 -758.3 -62.8 -650 -58C-541.7 -53.2 -433.3 -39.3 -325 -28.8C-216.7 -18.4 -108.3 -13.2 0 -18C108.3 -22.8 216.7 -36.7 325 -47.2" stroke="#7de8d9" stroke-opacity="0.3" vector-effect="non-scaling-stroke"></path><path d="M-2600 35.3C-2500 24.1 -2400 11.4 -2300 8.6C-2200 5.9 -2100 13.6 -2000 24.7C-1900 35.9 -1800 48.6 -1700 51.4C-1600 54.1 -1500 46.4 -1400 35.3C-1300 24.1 -1200 11.4 -1100 8.6C-1000 5.9 -900 13.6 -800 24.7C-700 35.9 -600 48.6 -500 51.4C-400 54.1 -300 46.4 -200 35.3C-100 24.1 0 11.4 100 8.6" stroke="#fdb022" stroke-opacity="0.55" vector-effect="non-scaling-stroke"></path><path d="M-2600 85.3C-2516.7 79.9 -2433.3 81.9 -2350 89.7C-2266.7 97.4 -2183.3 109.3 -2100 114.7C-2016.7 120.1 -1933.3 118.1 -1850 110.3C-1766.7 102.6 -1683.3 90.7 -1600 85.3C-1516.7 79.9 -1433.3 81.9 -1350 89.7C-1266.7 97.4 -1183.3 109.3 -1100 114.7C-1016.7 120.1 -933.3 118.1 -850 110.3C-766.7 102.6 -683.3 90.7 -600 85.3C-516.7 79.9 -433.3 81.9 -350 89.7C-266.7 97.4 -183.3 109.3 -100 114.7C-16.7 120.1 66.7 118.1 150 110.3" stroke="#ffffff" stroke-opacity="0.18" vector-effect="non-scaling-stroke"></path></g><g fill="none" stroke="#7de8d9" stroke-opacity="0.24" stroke-width="1.5" stroke-linecap="round" mask="url(#pg-home-ol-mv)"><path d="M-234 -260C-198 -110 -242 110 -206 260" vector-effect="non-scaling-stroke"></path><path d="M-494 -260C-458 -110 -502 110 -466 260" vector-effect="non-scaling-stroke"></path></g><circle cx="-350" cy="48.8" r="5" fill="#fdb022" fill-opacity="0.75"></circle>',
  tagpress: '<g transform="translate(-70 -118) rotate(11)"><rect x="-110" y="-70" width="220" height="140" rx="14" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.2" stroke-width="1.5" vector-effect="non-scaling-stroke"></rect><circle cx="-88" cy="-48" r="5" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="1.5" vector-effect="non-scaling-stroke"></circle></g><g transform="translate(-330 24) rotate(-7)"><rect x="-150" y="-95" width="300" height="190" rx="14" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.5" vector-effect="non-scaling-stroke"></rect><circle cx="-128" cy="-73" r="5" fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.5" vector-effect="non-scaling-stroke"></circle><g transform="scale(3.529) translate(-32 -32)" fill="none" stroke="#cfc3ff" stroke-opacity="0.32" stroke-width="1.5" stroke-linecap="round"><circle cx="32" cy="32" r="14" vector-effect="non-scaling-stroke"></circle><path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" vector-effect="non-scaling-stroke"></path></g><path d="M-162 -87V-107H-142M142 -107H162V-87M-162 87V107H-142M142 107H162V87" fill="none" stroke="#fdb022" stroke-opacity="0.7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path></g>',
};

/** Ürün kartı: kartın tamamı tek bağlantı. "Açık" rozeti yalnız açık üründe ("Yakında" rozeti yok). */
function card(ctx, c, p) {
  const k = c.cards[p.key];
  const badge = p.available ? `<span class="pg-home-badge"><span class="nv-dot"></span>${ctx.t.dd.open}</span>` : '';
  return `<a class="pg-home-card pg-home-card-${p.key}" href="${p.href}" aria-label="${k.aria}">
        <div class="pg-home-art" aria-hidden="true"><svg aria-hidden="true" focusable="false" width="100%" height="100%"><svg aria-hidden="true" x="100%" y="50%" width="1" height="1" overflow="visible"><g class="pg-home-art-g">${ART[p.key]}</g></svg></svg></div>
        <div class="pg-home-card-in">
          <div class="pg-home-card-text">
            <div class="pg-home-card-head"><svg class="pg-home-card-mark" width="36" height="36" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${markBody(p.key, '#ffffff59', 2)}</svg><h3 class="pg-home-h3">${p.name}</h3>${badge}</div>
            <div class="pg-home-card-foot">
              <p class="pg-home-slogan">${k.slogan}</p>
              <p class="pg-home-card-sub">${k.sub}</p>
              <span class="tlink"><span class="pg-home-ul">${c.explore}</span><span class="pg-home-arrow" aria-hidden="true">→</span></span>
            </div>
          </div>
        </div>
      </a>`;
}

/** @returns {{ title: string, description: string, body: string, index?: boolean, bodyClass?: string }} */
export function render(lang, ctx) {
  const c = content[lang];
  const why = c.why
    .map(
      (w, i) => `<li class="pg-home-item">
          <span class="pg-home-tile"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${WHY_ICONS[i]}</svg></span>
          <div>
            <h3 class="pg-home-h3">${w.t}</h3>
            <p class="pg-home-p">${w.d}</p>
          </div>
        </li>`,
    )
    .join('\n        ');
  const steps = c.steps
    .map(
      (s, i) => `<li>
          <span class="pg-home-step-n" aria-hidden="true">${i + 1}</span>
          <h3 class="pg-home-h3">${s.t}</h3>
          <p class="pg-home-p">${s.d}</p>
        </li>`,
    )
    .join('\n        ');

  return {
    title: c.title,
    description: c.description,
    body: `<section class="hero pg-home-hero">
    <div class="wrap pg-home-hero-grid">
      <div class="pg-home-hero-text">
        <p class="eyebrow pg-home-hero-eyebrow">${c.eyebrow}</p>
        <h1>${c.h1a} <span class="pg-home-h1-sun">${c.h1b}</span></h1>
        <p class="lead pg-home-hero-lead">${c.lead}</p>
        <div class="pg-home-hero-ctas">
          ${ctx.startCta({ label: ctx.t.nav.register })}
          <a class="btn btn-line pg-home-btn-line" href="#${ctx.t.productsAnchor}">${c.browse}</a>
        </div>
      </div>
      <div class="pg-home-eco-box">
        ${ecoSvg(c)}
      </div>
    </div>
  </section>

  <section class="sec pg-home-vign pg-home-vign-paper">
    <div class="wrap pg-home-why">
      <h2 class="h2">${c.whyTitle}</h2>
      <ul class="pg-home-list">
        ${why}
      </ul>
    </div>
  </section>

  <section id="${ctx.t.productsAnchor}" class="pg-home-products pg-home-vign pg-home-vign-paper">
    <div class="wrap pg-home-prod-head">
      <h2 class="eyebrow pg-home-prod-title">${c.productsTitle}</h2>
    </div>
    <div class="pg-home-prod-grid">
      ${ctx.products.map((p) => card(ctx, c, p)).join('\n\n      ')}
    </div>
  </section>

  <section class="sec pg-home-vign pg-home-vign-paper">
    <div class="wrap">
      <p class="eyebrow pg-home-steps-eyebrow">${c.stepsEyebrow}</p>
      <h2 class="h2 pg-home-steps-title">${c.stepsTitle}</h2>
      <ol class="pg-home-steps">
        ${steps}
      </ol>
    </div>
  </section>

${ctx.ctaBand({ cls: 'pg-home-vign pg-home-vign-soft' })}`,
  };
}
