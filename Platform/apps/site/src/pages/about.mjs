// Hakkımızda (/hakkimizda/, /en/about/). Pano: Hakkimizda.dc.html. CSS öneki: .pg-about-*
import content from '../content/about.mjs';

const ICONS = {
  simple: '<rect x="5" y="5" width="22" height="22" rx="6" fill="none" stroke="currentColor" stroke-width="2.5"></rect><path d="M11 16h10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></path>',
  proof: '<path d="M6 17l7 7 13-15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>',
  linked: '<circle cx="11" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2.5"></circle><circle cx="21" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2.5"></circle>',
};

export function render(lang, ctx) {
  const c = content[lang];
  const f = ctx.t.footer;

  const principles = c.principles
    .map(
      (p) => `<div class="pg-about-pr">
<span class="pg-about-ico"><svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${ICONS[p.icon]}</svg></span>
<h3>${p.t}</h3>
<p>${p.d}</p>
</div>`,
    )
    .join('\n');

  const products = ctx.products
    .map(
      (p) => `<a class="pg-about-prod pg-about-${p.key}" href="${p.href}">
${ctx.mark(p.key, 48)}
<span><span class="pg-about-prod-top"><span class="pg-about-prod-name">${p.name}</span>${p.available ? ctx.badge(true, p.key) : ''}</span><span class="pg-about-prod-tag">${p.tagline}</span></span>
</a>`,
    )
    .join('\n');

  return {
    title: c.title,
    description: c.description,
    body: `${ctx.pageHead({ eyebrow: c.eyebrow, title: c.h1, lead: c.lead, cls: 'pg-about-head' })}
<section class="sec">
<div class="wrap pg-about-story">
<h2 class="h3">${c.story}</h2>
<div>
<h3 class="eyebrow pg-about-cap">${c.why}</h3>
<p>${c.whyText}</p>
<h3 class="eyebrow pg-about-cap pg-about-cap-2">${c.how}</h3>
<p>${c.howText}</p>
</div>
</div>
</section>
<section class="sec pg-about-follow">
<div class="wrap">
<h2 class="h3">${c.principlesTitle}</h2>
<div class="pg-about-prs">
${principles}
</div>
</div>
</section>
<section class="sec pg-about-follow">
<div class="wrap">
<h2 class="eyebrow pg-about-cap">${c.productsCap}</h2>
<div class="pg-about-fam">
${products}
</div>
</div>
</section>
<section class="sec pg-about-follow">
<div class="wrap">
<div class="pg-about-co">
<h2 class="eyebrow pg-about-cap">${c.companyCap}</h2>
<p class="pg-about-co-line">${c.companyLine}</p>
<dl class="pg-about-info">
<dt>${c.rows.name}</dt><dd>${c.rows.nameVal}</dd>
<dt>${c.rows.address}</dt><dd>${f.address}</dd>
<dt>${c.rows.email}</dt><dd><a class="tlink pg-about-mail" href="mailto:${f.email}">${f.email}</a></dd>
</dl>
</div>
</div>
</section>
${ctx.ctaBand()}`,
  };
}
