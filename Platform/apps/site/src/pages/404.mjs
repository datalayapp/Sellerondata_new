// Bulunamadı (404.html, en/404.html), her zaman noindex; herhangi bir yolda sunulur, bağlantılar kök yollu (ctx.href).
// Pano: Bulunamadi.dc.html. CSS öneki: .pg-404-*
import content from '../content/404.mjs';

export function render(lang, ctx) {
  const c = content[lang];
  const products = ctx.products
    .map((p) => `<a class="pg-404-prod" href="${p.href}">${ctx.mark(p.key, 32, 'pg-404-mark')}${p.name}</a>`)
    .join('');
  return {
    title: c.title,
    description: c.description,
    index: false,
    body: `<section class="pg-404-head">
  <div class="wrap">
    <p class="pg-404-code">${c.code}</p>
    <hr class="pg-404-rule">
    <h1 class="h2">${c.h1}</h1>
    <p class="lead pg-404-lead">${c.lead}</p>
    <div class="pg-404-act">
      <a class="btn btn-sun" href="${ctx.href('home')}">${c.home}</a>
      <a class="btn btn-line" href="${ctx.href('home')}#${ctx.t.productsAnchor}">${c.products}</a>
    </div>
    <nav class="pg-404-go" aria-label="${c.goTo}">
      <p class="eyebrow pg-404-go-cap">${c.goTo}</p>
      <div class="pg-404-list">${products}</div>
    </nav>
  </div>
</section>`,
  };
}
