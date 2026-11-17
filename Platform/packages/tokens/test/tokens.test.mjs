// Belirteç paketi testleri: node --test test/
// (a) --check temiz, (b) üretilen değerler before.json ile birebir, (c) ürün paleti kontrastı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { model, outputs, OUT } from '../build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const before = JSON.parse(readFileSync(path.join(HERE, 'before.json'), 'utf8')).surfaces;

// Bilinçli değişenler (Mesaj 15 P, plan §4.4; WCAG 1.4.11): alan çerçevesi beyazda ≥ 3:1 olur.
// before.json "önce" kaydı olarak dokunulmadan kalır; bu değerler testte üstüne yazılır.
// --border-strong #c9c5bc (kabuk) / #d9d6cf (DeciShip) -> #8f8a80 (beyazda 3,43:1), --border-hover -> #6b665d (5,70:1).
// DeciShip'in kendi iki değeri kalktı: kabuktakini alır. Mobil (D05) çerçeve rengi bu işin dışında, değişmedi.
const INTENTIONAL = { '--border-strong': '#8f8a80', '--border-hover': '#6b665d' };
Object.assign(before['shell.tokens'], INTENTIONAL);
Object.assign(before['deciship.app'], INTENTIONAL);

// ---- küçük CSS ayrıştırıcı: { 'seçici' | '@media (q) seçici' -> { özellik: değer } }
function parseCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const walk = (s, at) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim().replace(/\s*\n\s*/g, ' ');
      let depth = 1;
      let j = open + 1;
      while (depth && j < s.length) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        j++;
      }
      const body = s.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else {
        const key = at ? `${at} ${head}` : head;
        out[key] ??= {};
        for (const d of body.split(';')) {
          const k = d.indexOf(':');
          if (k > 0) out[key][d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
      }
      i = j;
    }
  };
  walk(src, null);
  return out;
}

const out = outputs();
const shell = parseCss(out[OUT.shellCss]);
const deci = parseCss(out[OUT.decishipCss]);
const site = parseCss(out[OUT.siteCss]);

function sub(actual, expected, label, { ignore = [], rename = {} } = {}) {
  for (const [k, v] of Object.entries(expected)) {
    const key = rename[k] ?? k;
    assert.equal(actual?.[key], v, `${label}: ${k} -> ${key}`);
  }
  void ignore;
}

test('(a) build.mjs --check temiz', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'build.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('(b) shell tokens: before.json ile birebir (yalnız izinli ek değişkenler fazla)', () => {
  sub(shell[':root'], before['shell.tokens'], 'shell :root');
  const extra = Object.keys(shell[':root']).filter((k) => !(k in before['shell.tokens']) && k !== 'color-scheme');
  assert.deepEqual(extra, ['--night']);
  sub(shell[":root[data-sod-product='hub'], .sod-shell[data-sod-product='hub']"], before["shell.tokens [:root[data-sod-product='hub']]"], 'hub teması');
  assert.deepEqual(before["shell.tokens [:root[data-sod-product='hub']]"], before["shell.tokens [.sod-shell[data-sod-product='hub']]"]);
  sub(shell['@media (max-width: 760px) :root'], before['shell.tokens @media (max-width: 760px)'], 'shell media');
});

test('(b) DeciShip paneli: paket + fark katmanı = bugünkü app.css :root', () => {
  // --brand-ink #0a1a3a artık --night adıyla (plan §7-3)
  const merged = { ...shell[':root'], ...deci[':root'] };
  sub(merged, before['deciship.app'], 'deciship :root', { rename: { '--brand-ink': '--night' } });
  assert.equal(deci[':root']['--brand-ink'], undefined);
  sub({ ...merged, ...deci['@media (max-width: 1023px) :root'] }, before['deciship.app @media (max-width: 1023px)'], 'deciship 1023');
  sub({ ...merged, ...deci['@media (max-width: 767px) :root'] }, before['deciship.app @media (max-width: 767px)'], 'deciship 767');
});

test('(b) site: :root ve .pg-* birebir', () => {
  assert.deepEqual(site[':root'], before['site.root']);
  for (const p of ['deciship', 'orderloom', 'tagpress']) assert.deepEqual(site[`.pg-${p}`], before[`site.pg-${p}`], p);
  for (const p of ['deciship', 'orderloom', 'tagpress']) assert.deepEqual(shell[`[data-sod-product='${p}']`], before[`site.pg-${p}`], `shell ${p}`);
});

test('(b) bantlar: HUB_BAND ve DECISHIP_BAND', async () => {
  const b = await import(pathToFileURL(path.join(ROOT, OUT.bandsTs)).href);
  assert.deepEqual({ ...b.HUB_BAND }, before['shell.bands.hub']);
  assert.deepEqual({ ...b.DECISHIP_BAND }, before['shell.bands.deciship']);
  // :root içindeki bant değişkenleri Merkez bandıdır
  for (const [k, v] of Object.entries(before['shell.bands.hub'])) assert.equal(shell[':root'][k], v, k);
});

test('(b) mobil: theme.generated.ts before.json ile birebir', async () => {
  const t = await import(pathToFileURL(path.join(ROOT, OUT.mobileTs)).href);
  assert.deepEqual({ ...t.genColors }, before['mobile.colors']);
  assert.deepEqual(JSON.parse(JSON.stringify(t.genBands.site)), before['mobile.bands.site']);
  assert.deepEqual(JSON.parse(JSON.stringify(t.genBands.hub)), before['mobile.bands.hub']);
  assert.deepEqual(JSON.parse(JSON.stringify(t.genBands.deciship)), before['mobile.bands.deciship']);
  assert.deepEqual({ ...t.genRadius }, before['mobile.radius']);
  assert.deepEqual({ ...t.genSpace }, before['mobile.space']);
  assert.deepEqual({ ...t.genTouch }, before['mobile.touch']);
  assert.deepEqual({ ...t.genShadow }, before['mobile.shadow']);
  assert.deepEqual({ ...t.genHubColors }, before['mobile.hubColors']);
  assert.deepEqual(JSON.parse(JSON.stringify(t.genNightChip)), before['mobile.nightChip']);
});

test('(b) contracts: PRODUCT_PALETTE ürün renkleriyle aynı', async () => {
  const p = await import(pathToFileURL(path.join(ROOT, OUT.paletteTs)).href);
  const catalog = readFileSync(path.join(ROOT, 'Platform/packages/contracts/src/products.ts'), 'utf8');
  for (const k of ['deciship', 'orderloom', 'tagpress']) {
    assert.equal(p.PRODUCT_PALETTE[k].main, before[`site.pg-${k}`]['--p-main']);
    assert.equal(p.PRODUCT_PALETTE[k].text, before[`site.pg-${k}`]['--p-text']);
  }
  assert.match(catalog, /PRODUCT_PALETTE/);
});

// ---- Merkez giriş (Y148): üretilen tokens.hub.css + elle yazılı var() bağları = before.json
const hub = parseCss(out[OUT.hubCss]);
const readSrc = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** `var(--x)` → kabuk :root'taki değer (zincirli de olur); düz değer olduğu gibi. */
function viaShell(v) {
  const m = /^var\((--[\w-]+)\)$/.exec(v ?? '');
  return m ? viaShell(shell[':root'][m[1]]) : v;
}
/** Elle yazılı dosyadaki `sel` bloğunun yalnız `prefix` ile başlayan değişkenleri. */
function localVars(rel, sel, prefix) {
  const css = parseCss(readSrc(rel))[sel] ?? {};
  return Object.fromEntries(Object.entries(css).filter(([k]) => k.startsWith(prefix)));
}
// Bilinçli değişen: --a-bad hata rengi #b54708 (amber) -> var(--danger) #c4271b (11-B4: amber yalnız düğmede).
const HUB_INTENTIONAL = { '--a-bad': '#c4271b' };
// before.json'dan sonra eklenen: alan çerçevesi (Mesaj 15 P, WCAG 1.4.11).
const HUB_EXTRA = { '.auth': ['--a-field'] };

for (const [sel, rel, prefix, key] of [['.auth', 'Platform/apps/hub-web/src/styles/auth.css', '--a-', 'hub.auth [.auth]']]) {
  test(`(b) Merkez ${sel}: tokens.hub.css + ${path.basename(rel)} = before.json, değer iki yerde yazılı değil`, () => {
    const gen = hub[sel];
    const hand = localVars(rel, sel, prefix);
    assert.ok(gen && Object.keys(gen).length > 0, `${sel} üretilmedi`);
    assert.deepEqual(Object.keys(gen).filter((k) => k in hand), [], 'aynı değişken hem üretilen hem elle yazılı dosyada');
    for (const [k, v] of Object.entries(hand)) assert.match(v, /^var\(--[\w-]+\)$/, `${rel} ${k}: elle düz değer (tokens.json'a taşıyın)`);
    const merged = Object.fromEntries(Object.entries({ ...gen, ...hand }).map(([k, v]) => [k, viaShell(v)]));
    const want = { ...before[key] };
    for (const [k, v] of Object.entries(HUB_INTENTIONAL)) if (k in want) want[k] = v;
    sub(merged, want, sel);
    assert.deepEqual(Object.keys(merged).filter((k) => !(k in want)), HUB_EXTRA[sel], `${sel}: izinsiz ek değişken`);
  });
}

// Hesabım (.acc) Merkez değişkenlerini doğrudan okur: --acc-* belirteçleri ölüydü, kaldırıldı (KALANLAR 6.25, C3-B6).
test('(b) Merkez .acc: --acc-* değişkeni ne üretilir ne elle yazılır', () => {
  assert.equal(hub['.acc'], undefined);
  assert.deepEqual(Object.keys(localVars('Platform/apps/hub-web/src/styles/account.css', '.acc', '--acc-')), []);
});

test('(b) Merkez: index.css üretilen dosyayı auth.css ve account.css\'ten önce yükler', () => {
  const imports = [...readSrc('Platform/apps/hub-web/src/styles/index.css').matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
  const at = (f) => imports.indexOf(f);
  assert.ok(at('./tokens.hub.css') >= 0, 'tokens.hub.css içe aktarılmıyor');
  assert.ok(at('@sellerondata/shell/tokens.css') < at('./tokens.hub.css'));
  assert.ok(at('./tokens.hub.css') < at('./auth.css') && at('./tokens.hub.css') < at('./account.css'));
});

test('(b) site: rozet ve kartlar ürün paletini öğenin kendi sınıfından okur, elle renk yok', () => {
  for (const p of ['deciship', 'orderloom', 'tagpress']) {
    const sel = Object.keys(site).find((k) => k.split(', ').includes(`.nv-b-${p}`));
    assert.ok(sel, `.nv-b-${p} üretilmedi`);
    for (const s of ['.pg-home-card', '.pg-pricing', '.pg-about']) assert.ok(sel.split(', ').includes(`${s}-${p}`), `${s}-${p}`);
    assert.deepEqual(site[sel], before[`site.pg-${p}`], sel);
  }
  // Elle yazılı dosyada bu sınıflara renk ya da --p-* yazılırsa paleti ezer.
  const own = /\.(nv-b|pg-home-card|pg-pricing|pg-about)-(deciship|orderloom|tagpress)\b/;
  for (const f of ['site.css', 'styles/home.css', 'styles/company.css', 'styles/products.css']) {
    const src = readSrc(`Platform/apps/site/src/${f}`).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, own, f);
  }
});

test('model: başvurular çözülmüş, "{" kalmamış', () => {
  const bad = [];
  const walk = (o, p) => {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
    else if (typeof o === 'string' && o.includes('{')) bad.push(p);
  };
  walk(model(), '');
  assert.deepEqual(bad, []);
});

// ---- (c) kontrast
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Bugün sınırın (4.5) altında kalan çiftler: renk bu mesajda değişmez, Y maddesi açılır. Boşsa hepsi geçiyor. */
const KNOWN_LOW_CONTRAST = new Set([]);

test('(c) ürün paleti kontrastı: text/kâğıt ≥ 4.5 ve beyaz/hero ≥ 4.5', () => {
  const paper = model().base['--bg'];
  const pal = model().products;
  const seen = [];
  for (const [key, c] of Object.entries(pal)) {
    for (const [name, r] of [
      [`${key}: text/kâğıt`, ratio(c.text, paper)],
      [`${key}: beyaz/hero`, ratio('#ffffff', c.hero)],
    ]) {
      if (r < 4.5) {
        seen.push(name);
        assert.ok(KNOWN_LOW_CONTRAST.has(name), `${name} = ${r.toFixed(2)} < 4.5 (bilinen listede yok)`);
      }
    }
  }
  for (const k of KNOWN_LOW_CONTRAST) assert.ok(seen.includes(k), `bilinen listede ama artık geçiyor: ${k}`);
});
