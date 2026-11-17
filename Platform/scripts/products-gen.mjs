#!/usr/bin/env node
// Araç kaydından türeyen dosyaların üreticisi. Kaynak: Platform/packages/contracts/src/products.ts. Bağımlılıksız.
//   node Platform/scripts/products-gen.mjs           çıktıları yazar
//   node Platform/scripts/products-gen.mjs --check   yazmaz; diskteki çıktı bayatsa ya da artık dosya varsa 1 ile çıkar
// Çıktılar commit edilir; elle düzenlenmez (nginx TypeScript okuyamaz, site ayrı Docker bağlamında derlenir).
//   Platform/gateway/conf/products/<anahtar>.conf              `deploy` alanı olan her araç için
//   Platform/apps/site/src/content/products.generated.json     `site` alanı olan araçlar, kayıt sırasıyla
//   Platform/infra/postgres/init.sql, upgrade.sql              platform ve `deploy.api` olan her aracın şeması ve iki rolü (products-db.mjs)
// --check ayrıca üretilemeyen listeleri denetler: kayıttaki her araç ve klasörü elle yazılan listelerde var mı (products-lists.mjs).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderInitSql, renderUpgradeSql } from './products-db.mjs';
import { checkLists } from './products-lists.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const REGISTRY_FILE = path.join(ROOT, 'Platform', 'packages', 'contracts', 'src', 'products.ts');

export const OUT = {
  confDir: 'Platform/gateway/conf/products',
  siteJson: 'Platform/apps/site/src/content/products.generated.json',
  initSql: 'Platform/infra/postgres/init.sql',
  upgradeSql: 'Platform/infra/postgres/upgrade.sql',
};

/** Değişken adı öneki: Merkez'in `$hub_web`, `$account_api` değişkenleriyle çakışmasın. */
export const VAR_PREFIX = 'sod_p_';

export const GENERATED = 'ÜRETİLDİ: Platform/scripts/products-gen.mjs (kaynak contracts/src/products.ts). Elle düzenlemeyin.';

/** Bir aracın nginx dosyası. Şablon bugünkü DeciShip bloklarının birebir karşılığıdır; `^~` ve regex konumu yok. */
export function renderConf(e) {
  const k = e.key;
  const { api, web } = e.deploy ?? {};
  const out = [`# ${GENERATED}`, `# ${e.name} (${k})`, ''];
  if (api) {
    out.push(
      `set $${VAR_PREFIX}${k}_api http://${api.service}:${api.port};`,
      '',
      `# ${e.name} API sağlık ucu hız sınırının dışındadır (kapların ve izlemenin yoklaması kısılmasın).`,
      `location = /api/${k}/health {`,
      '  include /etc/nginx/snippets/proxy.conf;',
      '  include /etc/nginx/snippets/security-headers.conf;',
      '  proxy_read_timeout 30s;',
      `  proxy_pass $${VAR_PREFIX}${k}_api;`,
      '}',
      '',
      `location /api/${k}/ {`,
      '  include /etc/nginx/conf.d/api-limits.inc;',
      '  include /etc/nginx/snippets/proxy.conf;',
      '  include /etc/nginx/snippets/security-headers.conf;',
      `  client_max_body_size ${api.maxBody ?? '1m'};`,
      `  client_body_timeout ${api.bodyTimeout ?? '60s'};`,
      `  proxy_read_timeout ${api.readTimeout ?? '30s'};`,
      `  proxy_send_timeout ${api.readTimeout ?? '30s'};`,
      '  proxy_request_buffering on;',
      `  proxy_pass $${VAR_PREFIX}${k}_api;`,
      '}',
      '',
    );
  }
  if (web) {
    out.push(
      `set $${VAR_PREFIX}${k}_web http://${web.service}:${web.port};`,
      '',
      `# ${e.name} web: Vite base '/${k}/'. Web konteyneri dosyaları da /${k}/ altında sunar: önek olduğu gibi geçer.`,
      `location = /${k} {`,
      '  include /etc/nginx/snippets/security-headers.conf;',
      `  return 301 /${k}/;`,
      '}',
      '',
      `location /${k}/assets/ {`,
      '  include /etc/nginx/snippets/proxy.conf;',
      '  proxy_hide_header Cache-Control;',
      '  proxy_hide_header Expires;',
      '  include /etc/nginx/snippets/security-headers.conf;',
      '  add_header Cache-Control "public, max-age=31536000, immutable";',
      '  proxy_read_timeout 30s;',
      `  proxy_pass $${VAR_PREFIX}${k}_web;`,
      '}',
      '',
      `location /${k}/ {`,
      '  include /etc/nginx/snippets/proxy.conf;',
      '  proxy_hide_header Cache-Control;',
      '  proxy_hide_header Expires;',
      '  include /etc/nginx/snippets/security-headers.conf;',
      '  add_header Cache-Control "no-cache";',
      '  proxy_read_timeout 30s;',
      `  proxy_pass $${VAR_PREFIX}${k}_web;`,
      '}',
      '',
    );
  }
  return out.join('\n');
}

/** Tanıtım sitesinin ürün listesi (JSON metni). */
export function renderSiteJson(entries) {
  const products = entries
    .filter((e) => e.site)
    .map((e) => ({
      key: e.key,
      name: e.name,
      mark: e.mark ? `/${e.mark}` : null,
      color: e.color,
      launch: e.launch,
      tagline: { tr: e.tagline.tr, en: e.tagline.en },
      site: { tr: e.site.tr, en: e.site.en },
    }));
  return `${JSON.stringify({ _uretildi: GENERATED, products }, null, 2)}\n`;
}

/** Kayıttan bütün çıktılar: { depo köküne göre yol -> içerik }. */
export function generate(entries) {
  const files = {};
  for (const e of entries) if (e.deploy && (e.deploy.api || e.deploy.web)) files[`${OUT.confDir}/${e.key}.conf`] = renderConf(e);
  files[OUT.siteJson] = renderSiteJson(entries);
  files[OUT.initSql] = renderInitSql(entries, GENERATED);
  files[OUT.upgradeSql] = renderUpgradeSql(entries, GENERATED);
  return files;
}

export async function loadRegistry() {
  const mod = await import(pathToFileURL(REGISTRY_FILE).href);
  const errors = mod.validateRegistry(mod.PRODUCT_REGISTRY);
  if (errors.length) throw new Error(`kayıt geçersiz:\n  ${errors.join('\n  ')}`);
  return mod.PRODUCT_REGISTRY;
}

/** Satır sonu farkı (Windows'ta CRLF indirme) bayatlık sayılmaz. */
const norm = (t) => t.replace(/\r\n/g, '\n');

/** Diskle karşılaştırır; sorunların listesini döndürür (boş = güncel). */
export function diff(files, root = ROOT) {
  const problems = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) problems.push(`eksik: ${rel}`);
    else if (norm(readFileSync(abs, 'utf8')) !== norm(content)) problems.push(`bayat: ${rel}`);
  }
  const dir = path.join(root, OUT.confDir);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.conf'))) {
      const rel = `${OUT.confDir}/${f}`;
      if (!(rel in files)) problems.push(`artık dosya: ${rel}`);
    }
  }
  return problems;
}

export function write(files, root = ROOT) {
  const dir = path.join(root, OUT.confDir);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.conf'))) {
      if (`${OUT.confDir}/${f}` in files) continue;
      // Yalnız üreticinin kendi başlığını taşıyan dosya silinir; başlıksız dosyaya dokunulmaz.
      if (readFileSync(path.join(dir, f), 'utf8').includes(GENERATED)) rmSync(path.join(dir, f));
      else console.error(`uyarı: üretici dosyası değil, elle silinmeli: ${OUT.confDir}/${f}`);
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const registry = await loadRegistry();
  const files = generate(registry);
  if (check) {
    const problems = diff(files);
    if (problems.length) {
      console.error(`products-gen: üretilen dosyalar güncel değil (düzeltmek için: npm run products:gen)\n  ${problems.join('\n  ')}`);
    }
    const lists = checkLists(registry);
    if (lists.length) {
      console.error(`products-gen: elle yazılan listelerde araç eksik (Platform/docs/mimari/06-merkez.md "Yeni araç ekleme")\n  ${lists.join('\n  ')}`);
    }
    if (problems.length || lists.length) process.exit(1);
    console.log(`products-gen: ${Object.keys(files).length} dosya güncel, araç listeleri tam`);
  } else {
    write(files);
    console.log(`products-gen: ${Object.keys(files).length} dosya yazıldı`);
    const lists = checkLists(registry);
    if (lists.length) console.error(`products-gen: uyarı, elle yazılan listelerde araç eksik (products:check kalır)\n  ${lists.join('\n  ')}`);
  }
}
