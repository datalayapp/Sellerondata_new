// TagPress ürün sayfası. Pano: TagPress.dc.html. Metin: content/tagpress.mjs.
// Ortak kalıp deciship.mjs'teki productPage; burada yalnız TagPress'e özgü işaret, çizim ve simgeler var.
// Ürün açık değil: rozet yok, birincil eylem konu satırlı mailto.
import content from '../content/tagpress.mjs';
import { productPage, heroMark } from './deciship.mjs';

const HIDE = 'aria-hidden="true" focusable="false"';

const MARK = heroMark(
  '#7a5af8',
  '<circle cx="32" cy="32" r="14" fill="#fff"></circle><path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" fill="none" stroke="#7a5af8" stroke-width="2.4" stroke-linecap="round"></path><path d="M12 19v-7h7M52 19v-7h-7M12 45v7h7M52 45v7h-7" fill="none" stroke="#fdb022" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>',
);

// Üst üste üç etiket, amber kadraj köşeleri ve yıldız parıltısı. Pano ile birebir.
const ART = `<svg viewBox="0 0 480 480" ${HIDE}>
        <path d="M40 96V40h56M384 40h56v56M40 384v56h56M440 384v56h-56" fill="none" stroke="#fdb022" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
        <g transform="translate(-6 8)">
          <g transform="translate(20 -16) rotate(12 240 240)">
            <rect x="136" y="96" width="208" height="288" rx="20" fill="#7a5af8" fill-opacity=".35" stroke="#cfc3ff" stroke-opacity=".55" stroke-width="2"></rect>
          </g>
          <g transform="translate(6 -6) rotate(3 240 240)">
            <rect x="136" y="96" width="208" height="288" rx="20" fill="#7a5af8"></rect>
          </g>
          <g transform="translate(-16 12) rotate(-6 240 240)">
            <rect x="136" y="96" width="208" height="288" rx="20" fill="#ffffff"></rect>
            <circle cx="240" cy="208" r="40" fill="#7a5af8"></circle>
            <path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" transform="translate(240 208) scale(3) translate(-32 -31)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"></path>
            <rect x="176" y="284" width="128" height="16" rx="8" fill="#7a5af8"></rect>
            <rect x="200" y="316" width="80" height="12" rx="6" fill="#cfc3ff"></rect>
            <path d="M304 112Q306 126 320 128Q306 130 304 144Q302 130 288 128Q302 126 304 112Z" fill="#fdb022"></path>
            <path d="M324 146Q325 151 330 152Q325 153 324 158Q323 153 318 152Q323 151 324 146Z" fill="#fdb022"></path>
          </g>
        </g>
      </svg>`;

const S = 'fill="none" stroke="currentColor" stroke-width="1.8"';
const ICONS = [
  // parıltı
  `<path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" ${S} stroke-linejoin="round"></path><path d="M18 14.5v6M15 17.5h6" ${S} stroke-linecap="round"></path>`,
  // kalem
  `<path d="M4 20h4L19 9l-4-4L4 16z" ${S} stroke-linejoin="round"></path><path d="M13 7l4 4" ${S} stroke-linecap="round"></path>`,
  // yazıcı
  `<path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" ${S} stroke-linejoin="round"></path><path d="M7 14h10v6H7z" ${S} stroke-linejoin="round"></path>`,
];

export function render(lang, ctx) {
  const c = content[lang];
  return {
    title: c.title,
    description: c.description,
    bodyClass: 'pg-prod',
    body: productPage(ctx, 'tagpress', c, { mark: MARK, art: ART, icons: ICONS, open: false }),
  };
}
