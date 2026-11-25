#!/usr/bin/env node
// SellerOnData belirteç üreticisi. Kaynak: tokens.json. Bağımlılıksız.
//   node build.mjs           çıktıları yazar
//   node build.mjs --check   yazmaz; diskteki çıktı güncel değilse 1 ile çıkar
// Çıktı dosyaları commit edilir; elle düzenlenmez.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(HERE, 'tokens.json');
const PRODUCTS = ['deciship', 'orderloom', 'tagpress'];
const PALETTE_KEYS = ['main', 'hero', 'onDark', 'soft', 'text'];
const PALETTE_CSS = { hero: '--p-hero', main: '--p-main', onDark: '--p-on-dark', soft: '--p-soft', text: '--p-text' };
const BAND_CSS = {
  band: '--sod-band',
  band2: '--sod-band-2',
  on: '--sod-band-on',
  accent: '--sod-band-accent',
  cta: '--sod-band-cta',
  ctaHover: '--sod-band-cta-hover',
  ctaInk: '--sod-band-cta-ink',
  product: '--sod-product',
};

/** Çıktı yolları (depo köküne göre). */
export const OUT = {
  shellCss: 'Platform/packages/shell/src/styles/tokens.css',
  decishipCss: 'Deciship/apps/web/src/styles/tokens.deciship.css',
  mobileTs: 'Deciship/apps/mobile/src/ui/theme.generated.ts',
  siteCss: 'Platform/apps/site/src/styles/tokens.css',
  bandsTs: 'Platform/packages/shell/src/bands.generated.ts',
  paletteTs: 'Platform/packages/contracts/src/palette.generated.ts',
  hubCss: 'Platform/apps/hub-web/src/styles/tokens.hub.css',
  tagpressCss: 'Tagpress/apps/web/src/tezgah/tokens.generated.css',
};

/**
 * Sitede ürün paletini (`--p-*`) taşıyan öğe sınıfları: `.pg-<ürün>` sayfa gövdesidir; bunlar başka sayfalarda da görünen
 * ürüne ait öğeler (menü rozeti, ana sayfa kartı, fiyat ve hakkımızda kartı). `<önek>-<ürün>` sınıfına palet yazılır.
 */
const SITE_PRODUCT_SCOPES = ['nv-b', 'pg-home-card', 'pg-pricing', 'pg-about'];

const doc = JSON.parse(readFileSync(SRC, 'utf8'));

function lookup(p) {
  if (p.startsWith('--')) return doc.base[p];
  let cur = doc;
  for (const part of p.split('.')) cur = cur == null ? undefined : cur[part];
  return cur;
}
function resolve(v, trail = []) {
  if (typeof v !== 'string') return v;
  const m = /^\{([^}]+)\}$/.exec(v);
  if (!m) return v;
  if (trail.includes(m[1])) throw new Error(`döngüsel başvuru: ${[...trail, m[1]].join(' -> ')}`);
  const t = lookup(m[1]);
  if (t === undefined || (typeof t === 'object' && t !== null)) throw new Error(`çözülemeyen başvuru: {${m[1]}}`);
  return resolve(t, [...trail, m[1]]);
}
function deep(o) {
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, deep(v)]));
  return resolve(o);
}

/** Başvuruları çözülmüş model (testler de bunu kullanır). */
export function model() {
  return {
    base: deep(doc.base),
    themes: deep(doc.themes),
    media: deep(doc.media),
    bands: deep(doc.bands),
    products: deep(doc.products),
    surfaces: deep(doc.surfaces),
  };
}

const HEADER = 'ÜRETİLDİ: elle düzenlemeyin; kaynak Platform/packages/tokens/tokens.json (node Platform/packages/tokens/build.mjs).';

const decls = (o, ind) => Object.entries(o).map(([k, v]) => `${ind}${k}: ${v};`);
const block = (sel, o, ind = '') => [`${ind}${sel} {`, ...decls(o, ind + '  '), `${ind}}`];
const mediaBlocks = (media, sel) => Object.entries(media).flatMap(([q, o]) => [`@media (${q}) {`, ...block(sel, o, '  '), '}']);
const paletteDecls = (p) => Object.fromEntries(Object.entries(PALETTE_CSS).map(([k, c]) => [c, p[k]]));

function shellCss(m) {
  const lines = [`/* ${HEADER} */`, ':root {', ...decls(m.base, '  '), '  color-scheme: light;', '}'];
  lines.push(...block(":root[data-sod-product='hub'],\n.sod-shell[data-sod-product='hub']", m.themes.hub));
  lines.push(...mediaBlocks(m.media, ':root'));
  for (const p of PRODUCTS) lines.push(...block(`[data-sod-product='${p}']`, paletteDecls(m.products[p])));
  return lines.join('\n') + '\n';
}

function decishipCss(m) {
  const w = m.surfaces.decishipWeb;
  const lines = [
    `/* ${HEADER} */`,
    '/* DeciShip paneli: paket belirteçlerinden (shell tokens) farklı ya da pakette olmayan bildirimler. --brand-ink #0a1a3a burada yoktur; o değer --night adıyla pakettedir. */',
    ...block(':root', w.css),
  ];
  lines.push(...mediaBlocks(w.media, ':root'));
  return lines.join('\n') + '\n';
}

function siteCss(m) {
  const lines = [`/* ${HEADER} */`, ...block(':root', m.surfaces.site.css)];
  lines.push('/* Ürün renkleri: hero zemini / ana / koyu zeminde açık ton / açık zemin / kâğıtta metin (KIT.md) */');
  for (const p of PRODUCTS) lines.push(...block(`.pg-${p}`, paletteDecls(m.products[p])));
  lines.push('/* Başka sayfalarda da görünen ürün öğeleri (rozet, kart): aynı palet, öğenin kendi sınıfında */');
  for (const p of PRODUCTS) lines.push(...block(SITE_PRODUCT_SCOPES.map((s) => `.${s}-${p}`).join(',\n'), paletteDecls(m.products[p])));
  return lines.join('\n') + '\n';
}

function hubCss(m) {
  return [
    `/* ${HEADER} */`,
    '/* Merkez giriş (.auth, auth.css): pakette karşılığı olmayan yerel değerler. Pakettekine eşit olanlar auth.css\'te var() ile bağlı. */',
    ...block('.auth', m.surfaces.hubAuth.css),
  ].join('\n') + '\n';
}

/**
 * TagPress web (Tezgâh): aracın rengi ve `--tz-*`. `@blok`/`@son` işaretleri TagPress'in kayma testinin okuduğu biçimde.
 * Tezgâh alt anahtarları gruptur; adları dosyada yorum satırı olur.
 */
function tagpressCss(m) {
  const w = m.surfaces.tagpressWeb;
  const lines = [
    `/* ${HEADER} */`,
    '/* TagPress web (Tezgâh). Kabuğun tokens.css\'inden SONRA yüklenir: "tagpress" bloğu aracın rengini (birincil, odak, bant) yazar,',
    ' * "tezgah" bloğu yalnız Tezgâh\'a özgü --tz- önekli renk ve ölçüleri. Ekranlar renk ve ölçüyü elle yazmaz, yalnız var(--…). */',
    '/* @blok tagpress */',
    ...block(':root', w.css),
    '/* @son tagpress */',
    '/* @blok tezgah */',
    ':root {',
  ];
  Object.entries(w.tezgah).forEach(([group, vars], i) => {
    if (i > 0) lines.push('');
    lines.push(`  /* ${group} */`, ...decls(vars, '  '));
  });
  lines.push('}', '/* @son tezgah */');
  return lines.join('\n') + '\n';
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
function ts(v, ind = '') {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const inner = ind + '  ';
  const rows = Object.entries(v).map(([k, x]) => `${inner}${IDENT.test(k) ? k : ts(k)}: ${ts(x, inner)},`);
  return `{\n${rows.join('\n')}\n${ind}}`;
}

function mobileTs(m) {
  const s = m.surfaces.mobile;
  const parts = [
    ['genColors', s.colors],
    ['genBands', s.bands],
    ['genHubColors', s.hubColors],
    ['genNightChip', s.nightChip],
    ['genRadius', s.radius],
    ['genSpace', s.space],
    ['genTouch', s.touch],
    ['genShadow', s.shadow],
  ];
  return `// ${HEADER}\n\n${parts.map(([n, v]) => `export const ${n} = ${ts(v)} as const;\n`).join('\n')}`;
}

function bandsTs(m) {
  const conv = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [BAND_CSS[k], v]));
  return [
    `// ${HEADER}`,
    '',
    '/** Merkez bandı (AppShell bandTheme, hub). */',
    `export const HUB_BAND = ${ts(conv(m.bands.hub))} as const;`,
    '',
    '/** DeciShip bandı (AppShell bandTheme, deciship). */',
    `export const DECISHIP_BAND = ${ts(conv(m.bands.deciship))} as const;`,
    '',
    '/** TagPress bandı (AppShell bandTheme, tagpress; Tezgâh). */',
    `export const TAGPRESS_BAND = ${ts(conv(m.bands.tagpress))} as const;`,
    '',
  ].join('\n');
}

function paletteTs(m) {
  const pal = Object.fromEntries(PRODUCTS.map((p) => [p, Object.fromEntries(PALETTE_KEYS.map((k) => [k, m.products[p][k]]))]));
  return [
    `// ${HEADER}`,
    '',
    '/** Ürün paleti: ana / hero zemini / koyu zeminde açık ton / açık zemin / kâğıtta metin. */',
    'export type ProductPalette = { main: string; hero: string; onDark: string; soft: string; text: string };',
    '',
    `export const PRODUCT_PALETTE: Record<${PRODUCTS.map((p) => `'${p}'`).join(' | ')}, ProductPalette> = ${ts(pal)};`,
    '',
  ].join('\n');
}

/** Tüm çıktılar: { yol (depo köküne göre) -> içerik } */
export function outputs() {
  const m = model();
  return {
    [OUT.shellCss]: shellCss(m),
    [OUT.decishipCss]: decishipCss(m),
    [OUT.mobileTs]: mobileTs(m),
    [OUT.siteCss]: siteCss(m),
    [OUT.bandsTs]: bandsTs(m),
    [OUT.paletteTs]: paletteTs(m),
    [OUT.hubCss]: hubCss(m),
    [OUT.tagpressCss]: tagpressCss(m),
  };
}

const norm = (s) => s.replace(/\r\n/g, '\n');

function main() {
  const check = process.argv.includes('--check');
  const out = outputs();
  const stale = [];
  for (const [rel, content] of Object.entries(out)) {
    const abs = path.join(ROOT, rel);
    const cur = existsSync(abs) ? norm(readFileSync(abs, 'utf8')) : null;
    if (cur === content) continue;
    stale.push(rel);
    if (!check) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  if (check) {
    if (stale.length) {
      console.error(`Güncel olmayan çıktılar (node Platform/packages/tokens/build.mjs çalıştırın):\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`tokens: ${Object.keys(out).length} çıktı güncel`);
  } else {
    console.log(stale.length ? `tokens: yazıldı\n  ${stale.join('\n  ')}` : 'tokens: değişiklik yok');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
