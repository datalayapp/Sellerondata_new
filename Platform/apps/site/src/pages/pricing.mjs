// Fiyatlar (/fiyatlar/, /en/pricing/). Pano: Fiyatlar.dc.html. CSS öneki: .pg-pricing-*
import content from '../content/pricing.mjs';

const CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3 3 7-7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

export function render(lang, ctx) {
  const c = content[lang];
  const mail = (subject) => `mailto:${ctx.t.footer.email}?subject=${encodeURIComponent(subject)}`;

  const cards = c.cards
    .map((k) => {
      const p = ctx.products.find((x) => x.key === k.key);
      const open = p.available;
      // Açılmamış üründe fiyat yerine "Yakında" yazar; ayrı rozet yok.
      const cta = open
        ? ctx.startCta({ label: k.cta })
        : `<a class="btn btn-line" href="${mail(k.subject)}">${k.cta}</a>`;
      return `<div class="pg-pricing-card pg-pricing-${k.key}${open ? ' is-open' : ''}">
<div class="pg-pricing-bar"></div>
<div class="pg-pricing-body">
<div class="pg-pricing-id">${ctx.mark(k.key, 40)}<h2>${p.name}</h2></div>
<p class="pg-pricing-desc">${k.desc}</p>
<p class="pg-pricing-price">${k.price}</p>
<p class="pg-pricing-sub">${k.sub}</p>
<ul class="pg-pricing-list">${k.items.map((i) => `<li>${CHECK}<span>${i}</span></li>`).join('')}</ul>
${cta}
</div></div>`;
    })
    .join('\n');

  const faq = c.faq
    .map((f, i) => {
      const a = f.a
        ? f.a
        : `${f.pre}<a class="pg-pricing-link" href="${ctx.href('privacy')}">${f.link}</a>${f.post}`;
      return `<details${i === 0 ? ' open' : ''}><summary>${f.q}</summary><p>${a}</p></details>`;
    })
    .join('\n');

  return {
    title: c.title,
    description: c.description,
    body: `${ctx.pageHead({ eyebrow: c.eyebrow, title: c.h1, lead: c.lead })}
<section class="sec">
<div class="wrap">
<div class="pg-pricing-cards">
${cards}
</div>
<p class="pg-pricing-note">${c.note}</p>
</div>
</section>
<section class="sec pg-pricing-faq-sec">
<div class="wrap">
<div class="pg-pricing-faq">
<h2 class="h3">${c.faqTitle}</h2>
<div class="faq">
${faq}
</div>
</div>
</div>
</section>
${ctx.ctaBand()}`,
  };
}
