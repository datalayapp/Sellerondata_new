// Kullanım koşulları (/kosullar/, /en/terms/), noindex. Pano: Kosullar.dc.html.
// Gövde, Gizlilik sayfasıyla ortak oluşturucudan gelir. CSS öneki: .pg-legal-*, yalnız bu sayfaya özgü .pg-terms-*
import content from '../content/terms.mjs';
import { renderLegal } from './privacy.mjs';

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
