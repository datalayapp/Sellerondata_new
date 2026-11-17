// DeciShip marka dosyası üreticisi: brand/*.svg ve apps/web/public ikonları. Mobil ikonlar Platform/brand'den gelir.
// Repoya bağımlılık eklemez. Repo dışında boş bir klasörde:
//   npm i sharp opentype.js
//   node <repo>/brand/generate.mjs
// Geometri burada tanımlıdır; logoyu değiştirirseniz apps/web/src/components/Brand.tsx ve
// apps/mobile/src/ui/BrandMark.tsx içindeki yolları da güncelleyin.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sharp + opentype.js are loaded from the CURRENT folder's node_modules (they are not repo dependencies).
const require = createRequire(path.join(process.cwd(), 'noop.js'));
const sharp = require('sharp');
const opentype = require('opentype.js');

const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BRAND = path.join(WT, 'brand');
const OUT_PUB = path.join(WT, 'apps/web/public');
const OUT_MOB = path.join(WT, 'apps/mobile/assets');
for (const d of [OUT_BRAND, OUT_PUB]) fs.mkdirSync(d, { recursive: true });

const BLUE = '#1d5bd8';
const INK = '#101828';
const AMBER = '#fdb022'; // "ölçü" accent — only inside the mark
const n = (v) => +v.toFixed(2);
const pt = (p) => `${n(p[0])} ${n(p[1])}`;
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * Geometry of the measured box: isometric parcel (solid lid, outlined sides), a tape line across the lid,
 * and an isometric dimension line under the front-left edge (ticks parallel to the box's vertical edges).
 */
function geo({ T, a, h, dimOff, tick, tape = true }) {
  const UL = add(T, [-a[0], a[1]]);
  const UR = add(T, a);
  const C = add(T, [0, 2 * a[1]]);
  const LL = add(UL, [0, h]);
  const LR = add(UR, [0, h]);
  const B = add(C, [0, h]);
  const poly = (ps) => `M${ps.map(pt).join('L')}Z`;
  const D1 = add(LL, [0, dimOff]);
  const D2 = add(B, [0, dimOff]);
  const M1 = mid(T, UR);
  const M2 = mid(UL, C);
  return {
    top: poly([T, UR, C, UL]),
    sides: `${poly([UL, C, B, LL])}${poly([C, UR, LR, B])}`,
    tape: tape ? `M${pt(M1)}L${pt(M2)}` : '',
    dim: `M${pt(D1)}L${pt(D2)}` + (tick ? `M${n(D1[0])} ${n(D1[1] - tick)}v${n(2 * tick)}M${n(D2[0])} ${n(D2[1] - tick)}v${n(2 * tick)}` : ""),
  };
}

// Full-size mark (64 grid) and the simplified small mark (16 grid, no tape).
const BIG = geo({ T: [32, 12], a: [14, 8], h: 16.5, dimOff: 6.5, tick: 2.4 });
const SMALL = geo({ T: [8, 2.3], a: [4.6, 2.6], h: 4.5, dimOff: 2.1, tick: 0, tape: false });

let maskSeq = 0;
/** cut = colour of the tile behind the glyph (tape is drawn in it); null → cut the tape out with a mask (mono). */
function markGroup(g, { sw, ink, accent, cut = BLUE }) {
  const j = `stroke-linejoin="round" stroke-linecap="round"`;
  const tw = n(sw * 0.8);
  let top = `<path d="${g.top}" fill="${ink}" stroke="${ink}" stroke-width="${sw}" ${j}/>`;
  if (g.tape && cut) top += `<path d="${g.tape}" stroke="${cut}" stroke-width="${tw}" stroke-linecap="round"/>`;
  else if (g.tape) {
    const id = `ds-tape${maskSeq++ || ''}`;
    top = `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><path d="${g.tape}" stroke="#000" stroke-width="${tw}" stroke-linecap="round"/></mask><path d="${g.top}" fill="${ink}" stroke="${ink}" stroke-width="${sw}" ${j} mask="url(#${id})"/>`;
  }
  return [
    `<path d="${g.sides}" fill="none" stroke="${ink}" stroke-width="${sw}" ${j}/>`,
    top,
    `<path d="${g.dim}" fill="none" stroke="${accent}" stroke-width="${n(sw * 0.75)}" ${j}/>`,
  ].join('');
}

const svg = (vb, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>${body}</svg>\n`;
const tile64 = (fill = BLUE) => `<rect width="64" height="64" rx="14" fill="${fill}"/>`;

const MARK = svg('0 0 64 64', tile64() + markGroup(BIG, { sw: 3.5, ink: '#fff', accent: AMBER }));
const MARK_MONO = svg('0 0 64 64', markGroup(BIG, { sw: 3.5, ink: 'currentColor', accent: 'currentColor', cut: null }), ` fill="none" color="${INK}"`);
const MARK_SM = svg('0 0 16 16', `<rect width="16" height="16" rx="3.6" fill="${BLUE}"/>` + markGroup(SMALL, { sw: 1.45, ink: '#fff', accent: AMBER }));

// Wordmark: IBM Plex Sans SemiBold, outlined to paths (no font dependency).
const font = opentype.parse(fs.readFileSync(path.join(WT, 'apps/mobile/assets/fonts/IBMPlexSans-SemiBold.ttf')).buffer);
function wordmark(x, baseline, size) {
  const p = font.getPath('DeciShip', x, baseline, size, { kerning: true });
  const width = font.getAdvanceWidth('DeciShip', size, { kerning: true });
  const r = (v) => +v.toFixed(2); const d = p.commands.map((c) => c.type === 'Z' ? 'Z' : c.type === 'Q' ? `Q${r(c.x1)} ${r(c.y1)} ${r(c.x)} ${r(c.y)}` : c.type === 'C' ? `C${r(c.x1)} ${r(c.y1)} ${r(c.x2)} ${r(c.y2)} ${r(c.x)} ${r(c.y)}` : `${c.type}${r(c.x)} ${r(c.y)}`).join(''); return { d, width };
}
// Mark is 64 tall; text cap height ≈ 0.698em → size 36 gives ~25 cap; baseline so caps sit centred.
const TS = 36;
const capH = 0.698 * TS;
const baseline = 32 + capH / 2;
const wm = wordmark(64 + 16, baseline, TS);
const LW = Math.ceil(64 + 16 + wm.width + 2);
const logo = (mark, text) => svg(`0 0 ${LW} 64`, mark + `<path d="${wm.d}" fill="${text}"/>`);
const LOGO = logo(tile64() + markGroup(BIG, { sw: 3.5, ink: '#fff', accent: AMBER }), INK);
const LOGO_REV = logo(tile64() + markGroup(BIG, { sw: 3.5, ink: '#fff', accent: AMBER }), '#fff');
const LOGO_MONO = svg(`0 0 ${LW} 64`, markGroup(BIG, { sw: 3.5, ink: 'currentColor', accent: 'currentColor', cut: null }) + `<path d="${wm.d}" fill="currentColor"/>`, ` color="${INK}"`);
const LOGO_MONO_W = LOGO_MONO.replace(`color="${INK}"`, 'color="#ffffff"');

const files = {
  'deciship-mark.svg': MARK,
  'deciship-mark-small.svg': MARK_SM,
  'deciship-mark-mono.svg': MARK_MONO,
  'deciship-logo.svg': LOGO,
  'deciship-logo-reverse.svg': LOGO_REV,
  'deciship-logo-mono.svg': LOGO_MONO,
  'deciship-logo-mono-white.svg': LOGO_MONO_W,
};
for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(OUT_BRAND, f), c);
fs.writeFileSync(path.join(OUT_PUB, 'favicon.svg'), MARK_SM);

// ---------- rasters ----------
const png = (s, w, h = w, bg) => {
  const vbw = +s.match(/viewBox="0 0 ([\d.]+)/)[1];
  let img = sharp(Buffer.from(s), { density: (72 * Math.min(w * 4, 4096)) / vbw }).resize(w, h);
  if (bg) img = img.flatten({ background: bg });
  return img.png({ compressionLevel: 9 }).toBuffer();
};
const write = async (file, buf) => fs.writeFileSync(file, await buf);

// web
await write(path.join(OUT_PUB, 'apple-touch-icon.png'), png(svg('0 0 64 64', `<rect width="64" height="64" fill="${BLUE}"/>` + markGroup(BIG, { sw: 3.5, ink: '#fff', accent: AMBER })), 180));
await write(path.join(OUT_PUB, 'icon-192.png'), png(MARK, 192));
await write(path.join(OUT_PUB, 'icon-512.png'), png(MARK, 512));
// ICO (PNG-in-ICO): 16 + 32 small mark, 48 full mark
const icoImgs = [await png(MARK_SM, 16), await png(MARK_SM, 32), await png(MARK, 48)];
const sizes = [16, 32, 48];
const head = Buffer.alloc(6 + 16 * icoImgs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoImgs.length, 4);
let off = head.length;
icoImgs.forEach((b, i) => {
  const o = 6 + 16 * i;
  head.writeUInt8(sizes[i], o); head.writeUInt8(sizes[i], o + 1);
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12);
  off += b.length;
});
fs.writeFileSync(path.join(OUT_PUB, 'favicon.ico'), Buffer.concat([head, ...icoImgs]));

// mobile — glyph (cube + dim, no tile) centred in a square canvas
const glyph = (canvas, scale, { ink = '#fff', accent = AMBER, bg = '', cut = BLUE } = {}) => {
  const s = canvas / 64;
  const k = scale; // fraction of canvas the 64-grid occupies
  const t = (canvas - canvas * k) / 2;
  // glyph bbox in 64 grid: x 9.8..54.5, y 12.75..50.25 → centre (32.15, 31.5); shift so it is optically centred
  return svg(`0 0 ${canvas} ${canvas}`, (bg ? `<rect width="${canvas}" height="${canvas}" fill="${bg}"/>` : '') +
    `<g transform="translate(${n(t)} ${n(t)}) scale(${n(s * k)})">${markGroup(BIG, { sw: 3.5, ink, accent, cut })}</g>`);
};
// Mobil uygulama ikonları burada ÜRETİLMEZ: uygulama artık SellerOnData kimliğini taşır (gece mavisi S).
// Kaynağı Platform/brand/generate.mjs → Platform/brand/mobile; apps/mobile/assets oradan kopyalanır.
void glyph; void OUT_MOB;

console.log('DeciShip marka dosyaları üretildi.');
