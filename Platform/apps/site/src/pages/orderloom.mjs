// OrderLoom ürün sayfası. Pano: OrderLoom.dc.html. Metin: content/orderloom.mjs.
// Ortak kalıp deciship.mjs'teki productPage; burada yalnız OrderLoom'a özgü işaret, çizim ve simgeler var.
// Ürün açık değil: rozet yok, birincil eylem konu satırlı mailto.
import content from '../content/orderloom.mjs';
import { productPage, heroMark } from './deciship.mjs';

const HIDE = 'aria-hidden="true" focusable="false"';

const MARK = heroMark(
  '#0e9384',
  '<path d="M26 21h21M26 32h21M26 43h21" stroke="#fff" stroke-width="4" stroke-linecap="round"></path><path d="M15.5 21l2.6 2.6 4-4.6M15.5 32l2.6 2.6 4-4.6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="18.5" cy="43" r="3.6" fill="#fdb022"></circle>',
);

// Dokuma: dikey ve yatay iplikler, ortada amber sıra; sağda üç iş kartı. Pano ile birebir; tekrarlar döngüyle üretilir.
const r = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"></rect>`;
function art() {
  // Dikey iplikler: 8 sütun (x = 40 + 30i). Çift sütunlar 5 parça, tek sütunlar 2 kısa uç + 4 parça.
  let warp = '';
  for (let i = 0; i < 8; i++) {
    const x = 40 + 30 * i;
    if (i % 2 === 0) warp += r(x, 32, 12, 69) + r(x, 119, 12, 70) + r(x, 207, 12, 70) + r(x, 295, 12, 70) + r(x, 383, 12, 69);
    else warp += r(x, 32, 12, 25) + r(x, 75, 12, 70) + r(x, 163, 12, 70) + r(x, 251, 12, 70) + r(x, 339, 12, 70) + r(x, 427, 12, 25);
  }
  // Yatay iplikler: iki desen sırası (A: 25 ile başlar, B: 55 ile başlar); son parça genişliği satıra göre.
  const rowA = (y, last) => r(12, y, 25, 12) + r(55, y, 42, 12) + r(115, y, 42, 12) + r(175, y, 42, 12) + r(235, y, last, 12);
  const rowB = (y, last) => r(12, y, 55, 12) + r(85, y, 42, 12) + r(145, y, 42, 12) + r(205, y, 42, 12) + r(265, y, last, 12);
  const weft = rowA(60, 55) + rowB(104, 55) + rowA(148, 55) + rowB(192, 25) + rowB(280, 25) + rowA(324, 55) + rowB(368, 55) + rowA(412, 55);
  const card = (y, dot) =>
    `<rect x="312" y="${y}" width="136" height="56" rx="14" fill="#e3f5f2"></rect><circle cx="340" cy="${y + 28}" r="10" fill="${dot}"></circle><rect x="360" y="${y + 18}" width="64" height="8" rx="4" fill="#0e9384"></rect><rect x="360" y="${y + 32}" width="40" height="8" rx="4" fill="#7de8d9"></rect>`;
  return `<svg viewBox="0 0 480 480" ${HIDE}><g fill="#0e9384">${warp}</g><g fill="#7de8d9">${weft}</g><g fill="#fdb022">${rowA(236, 85)}</g>${card(82, '#0e9384')}${card(214, '#fdb022')}${card(346, '#0e9384')}</svg>`;
}

const S = 'fill="none" stroke="currentColor" stroke-width="1.8"';
const ICONS = [
  // işaretli liste
  `<path d="M9 6h11M9 12h11M9 18h11" ${S} stroke-linecap="round"></path><path d="M3.5 6l1.2 1.2L6.5 5M3.5 12l1.2 1.2 1.8-2.2" ${S} stroke-linecap="round" stroke-linejoin="round"></path><circle cx="5" cy="18" r="1.5" ${S}></circle>`,
  // ekip
  `<circle cx="9" cy="8" r="3.5" ${S}></circle><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" ${S} stroke-linecap="round"></path><path d="M16 4.8a3.2 3.2 0 0 1 0 6.4M18 14.4c2.2.6 3.5 2.6 3.5 5.6" ${S} stroke-linecap="round"></path>`,
  // fiş
  `<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" ${S} stroke-linejoin="round"></path><path d="M9 8h6M9 12h6" ${S} stroke-linecap="round"></path>`,
];

export function render(lang, ctx) {
  const c = content[lang];
  return {
    title: c.title,
    description: c.description,
    bodyClass: 'pg-prod',
    body: productPage(ctx, 'orderloom', c, { mark: MARK, art: art(), icons: ICONS, open: false }),
  };
}
