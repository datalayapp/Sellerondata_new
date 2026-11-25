// İletişim (/iletisim/, /en/contact/). Pano: Iletisim.dc.html. CSS öneki: .pg-contact-*
// Sunucu yok: panodaki kartlar form değil, konu satırlı mailto bağlantısıdır; JS gerekmez.
import content from '../content/contact.mjs';

const ICONS = {
  help: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"></path>',
  chat: '<path d="M4 5h16v11H9l-5 4z"></path><path d="M8 9.5h8M8 12.5h5"></path>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"></path><path d="M10 20.5a2 2 0 0 0 4 0"></path>',
};

export function render(lang, ctx) {
  const c = content[lang];
  const f = ctx.t.footer;

  const cards = c.cards
    .map(
      (k) => `<div class="pg-contact-card">
<span class="pg-contact-ico"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k.icon]}</svg></span>
<h2>${k.t}</h2>
<p>${k.d}</p>
<a class="tlink pg-contact-go" href="mailto:${f.email}?subject=${encodeURIComponent(k.subject)}"><span>${k.cta} <span aria-hidden="true">→</span></span></a>
</div>`,
    )
    .join('\n');

  return {
    title: c.title,
    description: c.description,
    body: `${ctx.pageHead({ eyebrow: c.eyebrow, title: c.h1, lead: c.lead })}
<section class="sec">
<div class="wrap">
<div class="pg-contact-cards">
${cards}
</div>
</div>
</section>
<section class="pg-contact-info">
<div class="wrap">
<div class="pg-contact-cols">
<h2 class="h3">${c.infoTitle}</h2>
<dl class="pg-contact-rows">
<div class="pg-contact-row"><dt class="eyebrow">${c.labels.email}</dt><dd><a class="tlink pg-contact-mail" href="mailto:${f.email}">${f.email}</a></dd></div>
<div class="pg-contact-row"><dt class="eyebrow">${c.labels.phone}</dt><dd><span class="pg-contact-ph">${f.phone}</span></dd></div>
<div class="pg-contact-row"><dt class="eyebrow">${c.labels.address}</dt><dd><span class="pg-contact-ph">${f.address}</span></dd></div>
<div class="pg-contact-row"><dt class="eyebrow">${c.labels.company}</dt><dd>${c.companyVal.replace(/\[[^\]]+\]/, (m) => `<span class="pg-contact-ph">${m}</span>`)}</dd></div>
</dl>
</div>
</div>
</section>`,
  };
}
