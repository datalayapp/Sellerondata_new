// Derleme denetimi: kırık bağlantı (sayfa içi ve sayfalar arası #parça dahil), hreflang karşılığı, dil anahtarı,
// uygulama bağlantıları, tek h1 ve başlık hiyerarşisi, alt metin, meta, dış kaynak, satır içi stil/betik, yasak ifadeler,
// atlama bağlantısı, sitemap/robots, nginx (CSP ve dile göre 404).
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { PAGES, NOT_FOUND, INDEXED, LANGS } from '../src/routes.mjs';
import { renderNginx } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SITE_DIST ? path.resolve(process.env.SITE_DIST) : path.join(ROOT, 'dist');
const APP_URL = (process.env.APP_URL || 'http://localhost:8088').replace(/\/+$/, '');
const SITE_URL = (process.env.SITE_URL || 'https://sellerondata.com').replace(/\/+$/, '');
const APP_ORIGIN = new URL(APP_URL).origin;
const errors = [];
const err = (f, m) => errors.push(`${path.relative(DIST, f)}: ${m}`);

async function walk(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const exists = async (p) => stat(p).then(() => true, () => false);

// yerel yol -> dosya yolu (yoksa null)
async function fileFor(u) {
  const p = decodeURIComponent(u.split('#')[0].split('?')[0]);
  if (!p.startsWith('/')) return null;
  let f = path.join(DIST, p);
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!(await exists(f))) return null;
  if ((await stat(f)).isDirectory()) f = path.join(f, 'index.html');
  return (await exists(f)) ? f : null;
}
const htmlCache = new Map();
const htmlOf = async (f) => {
  if (!htmlCache.has(f)) htmlCache.set(f, await readFile(f, 'utf8'));
  return htmlCache.get(f);
};
const hasId = (html, id) => new RegExp(`\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html);

// Yasak ifadeler (deneme süreci yok, kart istenmez; kullanıcı kararı) ve yer tutucu notlar.
const FORBIDDEN = [/14\s*g[uü]n/i, /deneme/i, /kredi\s*kart/i, /kart\s*istemez/i, /free trial/i, /\btrial\b/i, /credit card/i, /no card/i, /\bişçi/i];
const NOINDEX_ROUTES = Object.keys(PAGES).filter((k) => !INDEXED.includes(k));
const routeOf = (rel) => Object.entries(PAGES).flatMap(([k, v]) => LANGS.map((l) => [k, l, v[l]])).find(([, , p]) => p === rel);

const files = (await walk(DIST)).filter((f) => f.endsWith('.html'));
const hreflangs = new Map();
const titles = new Map();
let assetCss = null;

for (const f of files) {
  const html = await htmlOf(f);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  // Öznitelikler (meta description, title, alt, aria-label) dahil.
  for (const re of FORBIDDEN) if (re.test(text)) err(f, `yasak ifade: ${re}`);

  // CSP: satır içi betik/stil yok. Tek izinli betik: <script src="/assets/site.<özet>.js" defer></script>
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);
  const okScript = /^<script src="\/assets\/site\.[0-9a-f]{8}\.js" defer><\/script>$/;
  if (scripts.length !== 1 || !okScript.test(scripts[0])) err(f, `betik kuralı: yalnız bir dış site.js olmalı (${scripts.length} betik)`);
  if (/<script(?![^>]*\bsrc=)/i.test(html)) err(f, 'satır içi betik (CSP)');
  if (/\son[a-z]+="/i.test(html)) err(f, 'satır içi olay işleyici (CSP)');
  if (/\sstyle="/.test(html)) err(f, 'satır içi stil (CSP)');
  if (/<style\b/i.test(html)) err(f, '<style> bloğu (CSP)');
  // Tek hesap (ARCHITECTURE §5): kimlik bilgisi sitede girilmez; site yalnız uygulamanın kökenini yoklar, iki hal birden çizilir.
  if (/<input\b[^>]*\btype="password"/i.test(html) || /autocomplete="(current-password|new-password|username|one-time-code)"/i.test(html)) err(f, 'sitede kimlik bilgisi alanı var (giriş ve kayıt uygulamada)');
  const dataApp = (html.match(/<body\b[^>]*\bdata-app="([^"]*)"/) || [])[1];
  if (dataApp !== APP_ORIGIN) err(f, `<body data-app> uygulama kökeni değil (${dataApp ?? 'yok'}, beklenen ${APP_ORIGIN})`);
  if (/<body\b[^>]*\bdata-session=/.test(html)) err(f, 'sunucu çıktısı "giriş yapılmamış" olmalı (data-session yok)');
  for (const k of ['in', 'out']) if (!html.includes(`data-auth="${k}"`)) err(f, `üst çubukta data-auth="${k}" hali yok`);
  const css = html.match(/<link rel="stylesheet" href="(\/assets\/site\.[0-9a-f]{8}\.css)">/);
  if (!css) err(f, 'site.css bağlantısı yok');
  else assetCss = css[1];

  const rel = '/' + path.relative(DIST, f).split(path.sep).join('/').replace(/index\.html$/, '');
  const is404 = Object.values(NOT_FOUND).some((n) => f === path.join(DIST, n));
  const route = routeOf(rel);
  if (!is404 && !route) err(f, 'routes.mjs içinde olmayan sayfa');
  const noindex = /name="robots" content="noindex"/.test(html);
  const mustNoindex = is404 || (route && NOINDEX_ROUTES.includes(route[0]));
  if (mustNoindex && !noindex) err(f, 'noindex olmalı');
  if (!mustNoindex && noindex) err(f, 'noindex olmamalı');
  if (route && NOINDEX_ROUTES.includes(route[0]) && /yayınlanmadı|not published|before launch|önce burada/i.test(html)) err(f, 'yasal sayfada süreç notu');

  if (!is404 && !/property="og:image" content="[^"]+og.png"/.test(html)) err(f, 'og:image yok');
  if (!is404 && !/name="twitter:card"/.test(html)) err(f, 'twitter:card yok');
  const lang = (html.match(/<html lang="(tr|en)"/) || [])[1];
  if (!lang) err(f, 'html lang yok');
  if (route && route[1] !== lang) err(f, `html lang (${lang}) yol diliyle (${route[1]}) uyuşmuyor`);
  const title = (html.match(/<title>([^<]{5,})<\/title>/) || [])[1];
  if (!title) err(f, 'title yok');
  else if (titles.has(title)) err(f, `title tekrarı: ${path.relative(DIST, titles.get(title))}`);
  else titles.set(title, f);

  // Atlama bağlantısı üst çubuktan önce, hedefi <main id="main">.
  const skip = html.indexOf('<a class="skip" href="#main">');
  if (skip < 0 || skip > html.indexOf('<header')) err(f, 'atlama bağlantısı (.skip) üst çubuktan önce değil');
  if (!/<main id="main">/.test(html)) err(f, '<main id="main"> yok');

  if (!is404) {
    const d = html.match(/<meta name="description" content="([^"]*)"/);
    if (!d || d[1].length < 50 || d[1].length > 200) err(f, `description uzunluğu uygun değil (${d ? d[1].length : 0})`);
    if (!noindex && !/<link rel="canonical"/.test(html)) err(f, 'canonical yok');
    const hl = [...html.matchAll(/<link rel="alternate" hreflang="(tr|en|x-default)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    if (!noindex && hl.length !== 3) err(f, 'hreflang eksik');
    if (noindex && hl.length !== 2) err(f, 'noindex sayfada tr/en hreflang eksik');
    // İlk açılış dili İngilizce (kullanıcı kararı 2026-11-12): x-default İngilizce sayfayı gösterir.
    const xd = hl.find(([l]) => l === 'x-default');
    const enAlt = hl.find(([l]) => l === 'en');
    if (xd && (!enAlt || xd[1] !== enAlt[1])) err(f, `hreflang x-default İngilizce sayfa değil: ${xd[1]}`);
    hreflangs.set(f, hl);

    // Dil anahtarı (üst çubuk, mobil menü, altbilgi) aynı sayfanın karşılığına gider.
    for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*\bhreflang="(tr|en)"/g)) {
      const want = PAGES[route[0]][m[2]];
      if (m[1] !== want) err(f, `dil anahtarı ${m[2]} -> ${m[1]} (beklenen ${want})`);
    }
  }

  // başlıklar
  const hs = [...text.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  if (hs.filter((h) => h === 1).length !== 1) err(f, `h1 sayısı ${hs.filter((h) => h === 1).length}`);
  if (hs[0] !== 1) err(f, 'ilk başlık h1 değil');
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) err(f, `başlık atlaması h${hs[i - 1]} -> h${hs[i]}`);

  // görseller
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt="/.test(m[0])) err(f, `alt yok: ${m[0].slice(0, 80)}`);
    if (!/\bwidth="/.test(m[0]) || !/\bheight="/.test(m[0])) err(f, 'img width/height yok');
  }
  // SVG: dekoratifse aria-hidden, değilse erişilebilir ad
  for (const m of html.matchAll(/<svg\b[^>]*>/g)) {
    if (!/aria-hidden="true"/.test(m[0]) && !/role="img"[^>]*aria-label="|aria-label="[^"]+"[^>]*role="img"/.test(m[0])) err(f, `svg aria-hidden/ad yok: ${m[0].slice(0, 80)}`);
  }
  // Eksik değişken sızıntısı: href="undefined", "[object Object]" gibi.
  if (/\b(?:href|src|action)="(?:undefined|null)"|>undefined<|\[object Object\]/.test(html)) err(f, "eksik değer sızmış (undefined / [object Object])");

  // bağlantılar
  for (const m of html.matchAll(/\b(?:href|src|srcset|action)="([^"]+)"/g)) {
    const u = m[1];
    if (u.startsWith('#')) {
      if (!hasId(html, u.slice(1))) err(f, `sayfa içi bağlantı kırık: ${u}`);
    } else if (u.startsWith(APP_URL)) {
      // Uygulamaya yalnız kayıt ve giriş; giriş yapılmış halde Merkez, Hesabım (profil, güvenlik, firmalarım), ekip. Her sayfada kendi dili: ?lang=tr ya da ?lang=en.
      if (u.slice(APP_URL.length) === '/deciship/') continue; // giriş yapılmış hal: DeciShip ürün sayfasından ürüne geçiş
      const want = new RegExp(`^/(register|login|home|account/profile|account/security|account/firms|account/team)\\?lang=${lang}$`);
      if (!want.test(u.slice(APP_URL.length))) err(f, `uygulama bağlantısı uygun değil: ${u}`);
    } else if (u.startsWith('mailto:')) {
      continue;
    } else if (u.startsWith(SITE_URL)) {
      if (!(await fileFor(u.slice(SITE_URL.length) || '/'))) err(f, `kırık (mutlak): ${u}`);
    } else if (u.startsWith('/')) {
      const target = await fileFor(u);
      if (!target) err(f, `kırık bağlantı: ${u}`);
      else if (u.includes('#') && target.endsWith('.html') && !hasId(await htmlOf(target), u.split('#')[1])) err(f, `sayfalar arası #parça kırık: ${u}`);
    } else if (/^(https?:)?\/\//.test(u)) {
      err(f, `dış kaynak: ${u}`);
    } else {
      err(f, `göreli bağlantı (404 sayfasında kırılır): ${u}`);
    }
  }
}

// hreflang karşılıklılık: TR sayfanın en karşılığı var, o da TR'ye döner
for (const [f, hl] of hreflangs) {
  if (!hl.length) continue;
  const myLang = /<html lang="en"/.test(await htmlOf(f)) ? 'en' : 'tr';
  const mine = hl.find(([l]) => l === myLang);
  const other = hl.find(([l]) => l !== 'x-default' && l !== mine[0]);
  const target = path.join(DIST, other[1].slice(SITE_URL.length), 'index.html');
  if (!(await exists(target))) { err(f, `hreflang hedefi yok: ${other[1]}`); continue; }
  const back = hreflangs.get(target);
  if (!back || !back.some(([l, h]) => l === mine[0] && h === mine[1])) err(f, `hreflang karşılığı yok: ${other[1]}`);
}

// Her rota iki dilde de üretildi mi
for (const [k, v] of Object.entries(PAGES)) for (const l of LANGS) if (!(await fileFor(v[l]))) errors.push(`${k}/${l} sayfası yok: ${v[l]}`);

// CSS: dış kaynak ve @import yok, yazı tipleri yerelde
if (assetCss) {
  const css = await readFile(path.join(DIST, assetCss), 'utf8');
  if (/@import/i.test(css)) errors.push('site.css: @import var');
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
    const u = m[1].replace(/['"]/g, '');
    if (/^(https?:)?\/\//.test(u)) errors.push(`site.css: dış kaynak ${u}`);
    else if (u.startsWith('/') && !(await fileFor(u))) errors.push(`site.css: kırık ${u}`);
  }
}

// sitemap, robots
for (const f of ['sitemap.xml', 'robots.txt', ...Object.values(NOT_FOUND), 'og.png', 'favicon.svg']) if (!(await exists(path.join(DIST, f)))) errors.push(`${f} yok`);
const sm = await readFile(path.join(DIST, 'sitemap.xml'), 'utf8');
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const loc of locs) {
  const target = await fileFor(loc.slice(SITE_URL.length));
  if (!target) errors.push(`sitemap kırık: ${loc}`);
  else if (/name="robots" content="noindex"/.test(await htmlOf(target))) errors.push(`sitemap'te noindex sayfa: ${loc}`);
}
for (const k of INDEXED) for (const l of LANGS) if (!locs.includes(SITE_URL + PAGES[k][l])) errors.push(`sitemap'te yok: ${PAGES[k][l]}`);
// Sitemap'te de x-default İngilizce sayfa (kullanıcı kararı 2026-11-12).
for (const m of sm.matchAll(/hreflang="x-default" href="([^"]+)"/g)) if (!Object.values(PAGES).some((p) => SITE_URL + p.en === m[1])) errors.push(`sitemap x-default İngilizce değil: ${m[1]}`);
const robots = await readFile(path.join(DIST, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${SITE_URL}/sitemap.xml`)) errors.push('robots.txt sitemap satırı yok');

// nginx: CSP satır içi betik/stile izin vermez, dış kaynak yok; dile göre 404. Denetlenen, derlemede üretilen yapılandırmadır
// (renderNginx: __APP_ORIGIN__ -> uygulama kökeni). Tek dış köken connect-src'deki uygulama kökenidir, başka yönergede olamaz.
let nginx = '';
try {
  nginx = renderNginx(await readFile(path.join(ROOT, 'nginx.conf'), 'utf8'), APP_URL);
} catch (e) {
  errors.push(`nginx: ${e.message}`);
}
const cspFull = (nginx.match(/Content-Security-Policy "([^"]+)"/) || [])[1] || '';
if (!cspFull) errors.push('nginx: CSP yok');
if ((nginx.match(/Content-Security-Policy "/g) || []).length > 1) errors.push('nginx: birden çok CSP satırı');
const directives = cspFull.split(';').map((d) => d.trim()).filter(Boolean);
const connect = directives.filter((d) => /^connect-src\b/.test(d));
if (connect.length !== 1 || connect[0] !== `connect-src 'self' ${APP_ORIGIN}`) errors.push(`nginx: connect-src yalnız 'self' ve uygulama kökeni olmalı (${connect.join(' | ') || 'yok'})`);
const csp = directives.filter((d) => !/^connect-src\b/.test(d)).join('; ') + ';';
if (/unsafe-inline|unsafe-eval|https?:|\*/.test(csp) || /unsafe|\*/.test(connect.join(' '))) errors.push(`nginx: CSP gevşek: ${cspFull}`);
if (!/default-src 'self'/.test(csp)) errors.push("nginx: CSP default-src 'self' değil");
if (/script-src(?! 'self';)/.test(csp)) errors.push("nginx: CSP script-src yalnız 'self' olmalı");
if (!/style-src 'self';/.test(csp)) errors.push("nginx: CSP style-src 'self' değil");
if (!/location \/en\/ \{[^}]*error_page 404 \/en\/404\.html;/.test(nginx)) errors.push('nginx: /en/ altında error_page 404 /en/404.html yok');
if (!/^\s*error_page 404 \/404\.html;/m.test(nginx)) errors.push('nginx: genel error_page 404 /404.html yok');

// site.js ilk açılış dili kuralı (`// <dil-kurali>` işaretleri arası): uygulamadaki `pickInitialLocale` ile aynı sonuçlar.
{
  const src = await readFile(path.join(ROOT, 'public', 'assets', 'site.js'), 'utf8');
  const part = src.match(/\/\/ <dil-kurali>\r?\n([\s\S]*?)\/\/ <\/dil-kurali>/);
  if (!part) errors.push('site.js: // <dil-kurali> bölümü yok');
  else {
    const box = {};
    vm.runInNewContext(`${part[1]}\nout.pick = sodPickLang; out.target = sodAutoLangTarget;`, { out: box });
    const S = ['tr', 'en'];
    const pickCases = [
      [[null, ['de-DE', 'tr-TR'], S], 'tr'],
      [[null, ['de'], S], 'en'],
      [[null, [], S], 'en'],
      [['tr', ['en'], S], 'tr'],
      [[null, ['en-GB'], S], 'en'],
      [[null, ['TR_tr'], S], 'tr'],
      [[[null, 'xx', 'en'], ['tr'], S], 'en'],
      [[42, [null, 3, '', 'enx', 'tr-TR'], S], 'tr'],
      [[undefined, undefined, S], 'en'],
    ];
    for (const [args, want] of pickCases) {
      const got = box.pick(...args);
      if (got !== want) errors.push(`site.js sodPickLang(${JSON.stringify(args)}) = ${got}, beklenen ${want}`);
    }
    const base = { hasCookie: false, seen: false, webdriver: false, userAgent: 'Mozilla/5.0 Chrome/130', lang: 'tr', alternates: { tr: '/urunler/', en: '/en/products/' }, pathname: '/urunler/', search: '?a=1', hash: '#x' };
    const targetCases = [
      [{ languages: ['en-US', 'en'] }, '/en/products/?a=1#x'],
      [{ languages: ['de-DE'] }, '/en/products/?a=1#x'],
      [{ languages: [] }, '/en/products/?a=1#x'],
      [{ languages: ['de-DE', 'tr-TR'] }, null],
      [{ languages: ['en'], hasCookie: true }, null],
      [{ languages: ['en'], seen: true }, null],
      [{ languages: ['en'], webdriver: true }, null],
      [{ languages: ['en'], userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, null],
      [{ languages: ['en'], alternates: {} }, null],
      [{ languages: ['tr-TR'], lang: 'en', pathname: '/en/products/', search: '', hash: '' }, '/urunler/'],
      [{ languages: ['en-GB'], lang: 'en', pathname: '/en/products/' }, null],
    ];
    for (const [over, want] of targetCases) {
      const got = box.target({ ...base, ...over });
      if (got !== want) errors.push(`site.js sodAutoLangTarget(${JSON.stringify(over)}) = ${got}, beklenen ${want}`);
    }
  }
}

console.log(`${files.length} sayfa denetlendi.`);
if (errors.length) { console.error(errors.join('\n')); console.error(`\n${errors.length} sorun`); process.exit(1); }
console.log('Kırık bağlantı, hreflang, dil anahtarı, uygulama bağlantıları, alt, başlık, meta, CSP, sitemap, nginx: temiz.');
