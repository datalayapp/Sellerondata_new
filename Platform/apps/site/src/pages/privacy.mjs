// Gizlilik ve KVKK (/gizlilik/, /en/privacy/), noindex. Pano: Gizlilik.dc.html.
// Koşullar sayfası aynı oluşturucuyu kullanır (renderLegal). CSS öneki: .pg-legal-*, yalnız bu sayfaya özgü .pg-privacy-*
import content from '../content/privacy.mjs';

const MAIL = 'destek@sellerondata.com';

/** Metin işaretleri: [[x]] yer tutucu, {mail} e-posta bağlantısı. Önce kaçışlanır. */
const inline = (esc, s) =>
  esc(s)
    .replace(/\[\[(.+?)\]\]/g, '<span class="lg-ph">[$1]</span>')
    .replace(/\{mail\}/g, `<a class="pg-legal-mail" href="mailto:${MAIL}">${MAIL}</a>`);

/** Hukuki sayfa gövdesi: başlık, taslak notu, içindekiler (masaüstünde liste, mobilde açılır), bölümler, soru kutusu. */
export function renderLegal(c, ctx) {
  const { esc } = ctx;
  const items = c.sections
    .map((s, i) => `<li><a href="#bolum-${i + 1}"><span class="num">${i + 1}</span>${esc(s.t)}</a></li>`)
    .join('');
  const block = (b) => {
    if (b.p) return `<p>${inline(esc, b.p)}</p>`;
    if (b.ul) return `<ul>${b.ul.map((x) => `<li>${inline(esc, x)}</li>`).join('')}</ul>`;
    if (b.link) return `<a class="lg-in" href="${ctx.href(b.link)}">${esc(b.label)}</a>`;
    return '';
  };
  const sections = c.sections
    .map((s, i) => `<section id="bolum-${i + 1}"><h2><span class="num">${i + 1}</span>${esc(s.t)}</h2>${s.b.map(block).join('')}</section>`)
    .join('\n        ');
  return `<section class="phead pg-legal-head">
  <div class="wrap">
    <p class="eyebrow phead-eyebrow">${esc(c.eyebrow)}</p>
    <h1 class="h2">${esc(c.h1)}</h1>
    <p class="lead phead-lead">${esc(c.lead)}</p>
    <p class="num pg-legal-upd">${esc(c.updated)}</p>
  </div>
</section>
<div class="pg-legal-main">
  <div class="wrap">
    <p class="pg-legal-note">${esc(c.note)}</p>
    <div class="pg-legal-cols">
      <div class="pg-legal-toc">
        <nav class="pg-legal-toc-wide" aria-label="${esc(c.toc)}">
          <p class="eyebrow pg-legal-toc-cap">${esc(c.toc)}</p>
          <ol>${items}</ol>
        </nav>
        <nav class="pg-legal-toc-fold" aria-label="${esc(c.toc)}">
          <details>
            <summary><span class="eyebrow pg-legal-toc-cap">${esc(c.toc)}</span></summary>
            <ol>${items}</ol>
          </details>
        </nav>
      </div>
      <div class="lg-text pg-legal-text">
        ${sections}
        <div class="pg-legal-ask">
          <p>${esc(c.questions)}</p>
          <a href="mailto:${MAIL}">${MAIL}</a>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

export function render(lang, ctx) {
  const c = content[lang];
  return {
    title: c.title,
    description: c.description,
    index: false,
    bodyClass: 'pg-legal',
    body: renderLegal(c, ctx),
  };
}
