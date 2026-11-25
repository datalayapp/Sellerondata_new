// SellerOnData marka dosyası üreticisi: brand/*.svg, brand/web/*, brand/mobile/*, brand/preview.png.
// Repoya bağımlılık eklemez. Repo dışında boş bir klasörde:
//   npm i sharp opentype.js
//   node <repo>/brand/generate.mjs
// Kabuğun kullandığı yollar packages/shell/src/marks.tsx içindedir; burada aynıları tanımlıdır.
// DeciShip işareti (deciship-mark*.svg) Deciship/brand'den kopyadır ve değişmez; bu dosya onlara yazmaz.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const sharp = require('sharp');
const opentype = require('opentype.js');

const B = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(B, 'web');
const MOB = path.join(B, 'mobile');
for (const d of [WEB, MOB]) fs.mkdirSync(d, { recursive: true });

const NIGHT = '#0f2a5c'; // gece mavisi (ana marka)
const AMBER = '#fdb022'; // ölçü sarısı
const INK = '#101828'; // yazı
const ORD = '#0e9384'; // catalog.ts PRODUCTS.orderloom.color (OrderLoom)
const LAB = '#7a5af8'; // catalog.ts PRODUCTS.tagpress.color (TagPress)

const svg = (vb, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>${body}</svg>\n`;
const tile = (fill, s = 64, rx = 14) => `<rect width="${s}" height="${s}" rx="${rx}" fill="${fill}"/>`;

// ---- S işareti (64 ızgara; marks.tsx ile aynı) ----
const S_D = 'M46 18H22a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h20a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H24';
const S_TAIL = 'M24 46H16';
const sBig = (ink, accent) =>
  `<path d="${S_D}" fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round"/>` +
  `<path d="${S_TAIL}" stroke="${accent}" stroke-width="5.5" stroke-linecap="round"/>`;
// Küçük boy (16 ızgara): yarım daire dönüşler, kalın çizgi, kısa kuyruk. marks.tsx'te karşılığı yok (bkz. README).
const S_D_SM = 'M12.2 3.6H6A2.2 2.2 0 0 0 6 8H10A2.2 2.2 0 0 1 10 12.4H8.4';
const S_TAIL_SM = 'M8.4 12.4H4.2';
const sSmall = (ink, accent) =>
  `<path d="${S_D_SM}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${S_TAIL_SM}" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>`;

const MARK = svg('0 0 64 64', tile(NIGHT) + sBig('#fff', AMBER));
const MARK_REV = svg('0 0 64 64', tile('#fff') + sBig(NIGHT, AMBER)); // koyu zemin için açık kare
const MARK_SM = svg('0 0 16 16', tile(NIGHT, 16, 3.6) + sSmall('#fff', AMBER));
const sMono = sBig('currentColor', 'currentColor');
const MARK_MONO = svg('0 0 64 64', sMono, ` fill="none" color="${INK}"`);

// ---- OrderLoom / TagPress (marks.tsx ile aynı) ----
const ORDERLOOM = svg('0 0 64 64', tile(ORD) +
  `<path d="M26 21h21M26 32h21M26 43h21" stroke="#fff" stroke-width="4" stroke-linecap="round"/>` +
  `<path d="M15.5 21l2.6 2.6 4-4.6M15.5 32l2.6 2.6 4-4.6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="18.5" cy="43" r="3.6" fill="${AMBER}"/>`);
const TAGPRESS = svg('0 0 64 64', tile(LAB) +
  `<circle cx="32" cy="32" r="14" fill="#fff"/>` +
  `<path d="M26 34c2-5 4-7 6-7 1.5 0 1.5 2-.5 4s-1.5 4 .5 4c2.5 0 4-2 6-4" fill="none" stroke="${LAB}" stroke-width="2.4" stroke-linecap="round"/>` +
  `<path d="M12 19v-7h7M52 19v-7h-7M12 45v7h7M52 45v7h-7" fill="none" stroke="${AMBER}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);

// ---- Yazı logosu: IBM Plex Sans SemiBold, yola çevrilmiş (yazı tipi gerekmez) ----
const font = opentype.parse(fs.readFileSync(path.join(B, 'fonts/IBMPlexSans-SemiBold.ttf')).buffer);
const r2 = (v) => +v.toFixed(2);
function textPath(str, x, baseline, size) {
  const p = font.getPath(str, x, baseline, size, { kerning: true });
  const width = font.getAdvanceWidth(str, size, { kerning: true });
  const d = p.commands.map((c) => c.type === 'Z' ? 'Z' : c.type === 'Q' ? `Q${r2(c.x1)} ${r2(c.y1)} ${r2(c.x)} ${r2(c.y)}` : c.type === 'C' ? `C${r2(c.x1)} ${r2(c.y1)} ${r2(c.x2)} ${r2(c.y2)} ${r2(c.x)} ${r2(c.y)}` : `${c.type}${r2(c.x)} ${r2(c.y)}`).join('');
  return { d, width };
}
const TS = 36; // DeciShip logosu ile aynı ölçü: işaret 64, boşluk 16, yazı 36
const wm = textPath('SellerOnData', 80, 32 + (0.698 * TS) / 2, TS);
const LW = Math.ceil(80 + wm.width + 2);
const logo = (mark, text, extra = '') => svg(`0 0 ${LW} 64`, mark + `<path d="${wm.d}" fill="${text}"/>`, extra);
const LOGO = logo(tile(NIGHT) + sBig('#fff', AMBER), INK);
const LOGO_REV = logo(tile('#fff') + sBig(NIGHT, AMBER), '#fff');
const LOGO_MONO = logo(sMono, 'currentColor', ` fill="none" color="${INK}"`);
const LOGO_MONO_W = LOGO_MONO.replace(`color="${INK}"`, 'color="#ffffff"');

const files = {
  'sellerondata-mark.svg': MARK,
  'sellerondata-mark-small.svg': MARK_SM,
  'sellerondata-mark-mono.svg': MARK_MONO,
  'sellerondata-mark-reverse.svg': MARK_REV,
  'sellerondata-logo.svg': LOGO,
  'sellerondata-logo-reverse.svg': LOGO_REV,
  'sellerondata-logo-mono.svg': LOGO_MONO,
  'sellerondata-logo-mono-white.svg': LOGO_MONO_W,
  'orderloom-mark.svg': ORDERLOOM,
  'tagpress-mark.svg': TAGPRESS,
};
for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(B, f), c);

// DeciShip işareti Deciship/brand'den kopyadır (yalnız okunur).
const DS_MARK = fs.readFileSync(path.join(B, 'deciship-mark.svg'), 'utf8');
const DS_SM = fs.readFileSync(path.join(B, 'deciship-mark-small.svg'), 'utf8');

// ---- Tarayıcı simgeleri (SVG) ----
const wf = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);
wf(WEB, 'favicon.svg', MARK_SM);
wf(WEB, 'favicon-hub.svg', MARK_SM);
wf(WEB, 'favicon-deciship.svg', DS_SM);
wf(WEB, 'favicon-orderloom.svg', ORDERLOOM);
wf(WEB, 'favicon-tagpress.svg', TAGPRESS);

// ---- Raster ----
const png = (s, wd) => {
  const vbw = +s.match(/viewBox="0 0 ([\d.]+)/)[1];
  return sharp(Buffer.from(s), { density: (72 * Math.min(wd * 4, 4096)) / vbw }).resize(wd, wd).png({ compressionLevel: 9 }).toBuffer();
};
const out = async (dir, f, s, wd) => fs.writeFileSync(path.join(dir, f), await png(s, wd));

await out(WEB, 'favicon-32.png', MARK_SM, 32);
await out(WEB, 'favicon-16.png', MARK_SM, 16);
// S + ölçü sarısı, k: 64 ızgaranın tuvale oranı. Yazı kutusu 0.55k, bg varsa tam kare.
const glyph = (canvas, k, { bg = '', ink = '#fff', accent = AMBER } = {}) => {
  const s = (canvas / 64) * k;
  const t = (canvas - 64 * s) / 2;
  return svg(`0 0 ${canvas} ${canvas}`, (bg ? `<rect width="${canvas}" height="${canvas}" fill="${bg}"/>` : '') +
    `<g transform="translate(${r2(t)} ${r2(t)}) scale(${r2(s)})">${sBig(ink, accent)}</g>`);
};
await out(WEB, 'apple-touch-icon.png', glyph(180, 1.2, { bg: NIGHT }), 180); // iOS köşeyi kendisi yuvarlar

// Mobil. Android uyarlanabilir ikonda 108 dp tuvalin ortadaki 66 dp'lik dairesi güvenli (0.61).
const ICON_SVG = glyph(1024, 1.2, { bg: NIGHT });
await out(MOB, 'icon.png', ICON_SVG, 1024); // iOS, saydamsız
await out(MOB, 'adaptive-foreground.png', glyph(1024, 0.8), 1024);
await out(MOB, 'adaptive-background.png', svg('0 0 16 16', `<rect width="16" height="16" fill="${NIGHT}"/>`), 1024);
await out(MOB, 'monochrome.png', glyph(1024, 0.8, { accent: '#fff' }), 1024);
await out(MOB, 'splash.png', glyph(1024, 0.9), 1024); // saydam; zemin app.json'da NIGHT

// ---- Önizleme: 16, 32, 48, 192, 1024 (1024 sütunu 256'ya küçültülür) ----
const sizes = [16, 32, 48, 192, 1024];
const shownOf = (n) => (n === 1024 ? 256 : n);
const rows = [
  ['favicon (küçük)', (n) => (n <= 32 ? MARK_SM : MARK), '#f5f6f8'],
  ['işaret', () => MARK, '#f5f6f8'],
  ['ters (koyu zemin)', () => MARK_REV, NIGHT],
  ['mobil icon.png', () => ICON_SVG, '#f5f6f8'],
  ['DeciShip', (n) => (n <= 32 ? DS_SM : DS_MARK), '#f5f6f8'],
  ['OrderLoom', () => ORDERLOOM, '#f5f6f8'],
  ['TagPress', () => TAGPRESS, '#f5f6f8'],
];
const PAD = 24, LBL = 190, HDR = 44, RH = 256 + PAD;
const colW = (n) => shownOf(n) + PAD;
const W = LBL + sizes.reduce((a, n) => a + colW(n), 0);
const H = HDR + rows.length * RH;
const comps = [];
let labels = '';
const label = (t, x, y, size, fill) => { labels += `<path d="${textPath(t, x, y, size).d}" fill="${fill}"/>`; };
let x = LBL;
for (const n of sizes) { label(n === 1024 ? '1024 (256 olarak)' : `${n} px`, x, 28, 14, INK); x += colW(n); }
let y = HDR;
for (const [name, pick, bg] of rows) {
  comps.push({ input: { create: { width: W, height: RH, channels: 4, background: bg } }, left: 0, top: y });
  label(name, 12, y + 30, 14, bg === NIGHT ? '#fff' : INK);
  let cx = LBL;
  for (const n of sizes) {
    comps.push({ input: await png(pick(n), shownOf(n)), left: cx, top: y + 12 });
    cx += colW(n);
  }
  y += RH;
}
comps.push({ input: Buffer.from(svg(`0 0 ${W} ${H}`, labels).replace('<svg ', `<svg width="${W}" height="${H}" `)), left: 0, top: 0 });
fs.writeFileSync(path.join(B, 'preview.png'), await sharp({ create: { width: W, height: H, channels: 4, background: '#fff' } }).composite(comps).png().toBuffer());

console.log('SellerOnData marka dosyaları üretildi.');
