// Bağımlılıksız statik derleme: src/ + public/ -> dist/. Yalnız orkestrasyon:
// ortak parçalar src/shell.mjs, sayfalar src/pages/<anahtar>.mjs, metinler src/content/<anahtar>.mjs.
import { mkdir, rm, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { LANGS, PAGES, NOT_FOUND, INDEXED } from '../src/routes.mjs';
import { makeCtx, documentHtml, appOrigin } from '../src/shell.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SITE_DIST: paralel çalışan derlemeler birbirinin dist/ klasörünü silmesin diye ayrı çıktı klasörü.
const DIST = process.env.SITE_DIST ? path.resolve(process.env.SITE_DIST) : path.join(ROOT, 'dist');
// Sayfa bölümleri: site.css'in ardına bu sırayla eklenir (her dosyanın tek sahibi vardır).
const STYLES = ['home', 'products', 'company', 'legal'];
const APP_URL = (process.env.APP_URL || 'http://localhost:8088').replace(/\/+$/, '');
const SITE_URL = (process.env.SITE_URL || 'https://sellerondata.com').replace(/\/+$/, '');
// Kayıt kipi (Hesap servisiyle aynı ad, kullanıcı kararı 2026-11-12). `invite`: "Hesap aç" düğmeleri destek postasına gider.
// Boş: `open` (bugünkü çıktı birebir aynı). Yanlış yazılmış değer derlemeyi durdurur: kapalı denemede sessizce açık site çıkmasın.
const SIGNUP_MODE = (process.env.SIGNUP_MODE || 'open').trim().toLowerCase();
if (SIGNUP_MODE !== 'open' && SIGNUP_MODE !== 'invite') throw new Error(`SIGNUP_MODE geçersiz: open veya invite olmalı (verilen: ${process.env.SIGNUP_MODE})`);
const PUBLIC_ASSETS = path.join(ROOT, 'public', 'assets');

async function write(rel, content) {
  const file = path.join(DIST, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

// /assets/ bir yıl değişmez önbellekle sunulur (nginx.conf): içerik özetiyle adlandır.
async function hashed(rel, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const ext = path.extname(rel);
  const out = `/assets/${path.basename(rel, ext)}.${hash}${ext}`;
  await write(out.slice(1), content);
  return out;
}

const load = async (rel) => (await import(pathToFileURL(path.join(ROOT, rel)).href)).render;

/**
 * nginx.conf'taki __APP_ORIGIN__ yer tutucusunu uygulama kökeniyle değiştirir (CSP connect-src). Yalnız http(s) kökeni
 * kabul edilir; check.mjs aynı işlevle üretilen sonucu denetler. Dockerfile bunu SITE_NGINX_OUT ile ister.
 */
export function renderNginx(template, appUrl = APP_URL) {
  const origin = appOrigin(appUrl);
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error(`APP_URL kökeni CSP için uygun değil: ${origin}`);
  if (!template.includes('__APP_ORIGIN__')) throw new Error('nginx.conf içinde __APP_ORIGIN__ yer tutucusu yok');
  return template.replaceAll('__APP_ORIGIN__', origin);
}

function sitemap(keys) {
  const urls = keys
    .map((key) => {
      const links = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE_URL}${PAGES[key][l]}"/>`).join('\n');
      return LANGS.map(
        (l) => `  <url>
    <loc>${SITE_URL}${PAGES[key][l]}</loc>
${links}
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}${PAGES[key].en}"/>
  </url>`,
      ).join('\n');
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

export async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(path.join(ROOT, 'public'), DIST, { recursive: true, filter: (src) => !src.startsWith(PUBLIC_ASSETS) });

  const assets = {
    css: await hashed(
      'site.css',
      (await Promise.all([path.join('src', 'styles', 'tokens.css'), path.join('src', 'site.css'), ...STYLES.map((s) => path.join('src', 'styles', `${s}.css`))].map((f) => readFile(path.join(ROOT, f), 'utf8')))).join('\n'),
    ),
    js: await hashed('site.js', await readFile(path.join(PUBLIC_ASSETS, 'site.js'), 'utf8')),
  };
  // public/assets altındaki diğer dosyalar da özetli ada çevrilmeden kopyalanmaz; bugün yalnız site.js var.
  const extra = (await readdir(PUBLIC_ASSETS)).filter((f) => f !== 'site.js');
  if (extra.length) throw new Error(`public/assets içinde beklenmeyen dosya: ${extra.join(', ')} (build.mjs'e ekleyin)`);

  const cfg = { APP_URL, SITE_URL, SIGNUP_MODE };
  for (const key of Object.keys(PAGES)) {
    const render = await load(`src/pages/${key}.mjs`);
    for (const lang of LANGS) {
      const ctx = makeCtx(lang, key, cfg);
      await write(path.join(PAGES[key][lang], 'index.html'), documentHtml(ctx, render(lang, ctx), assets));
    }
  }
  const render404 = await load('src/pages/404.mjs');
  for (const lang of LANGS) {
    const ctx = makeCtx(lang, '404', cfg);
    await write(NOT_FOUND[lang], documentHtml(ctx, { index: false, ...render404(lang, ctx) }, assets));
  }

  await write('sitemap.xml', sitemap(INDEXED));
  await write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  // Sunucu yapılandırması dist/ içine yazılmaz (sunulan klasör): yalnız istenen yere.
  if (process.env.SITE_NGINX_OUT) {
    await writeFile(path.resolve(process.env.SITE_NGINX_OUT), renderNginx(await readFile(path.join(ROOT, 'nginx.conf'), 'utf8')));
  }
  console.log(`site: dist/ hazır (APP_URL=${APP_URL}, SITE_URL=${SITE_URL}${SIGNUP_MODE === 'invite' ? ', SIGNUP_MODE=invite' : ''})`);
}

if (process.argv[1]?.endsWith('build.mjs')) {
  await build();
}
