// Tek dosya kısayolu (Mesaj 10 planı 3.4).
// Kullanım: npm run t -- <dosya> [<dosya> ...] [-u] [-t "<test adı>"]
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findPg, pgEnv, PG_HINT } from './lib/pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => {
  console.error(`Reddedildi: ${m}\nHiçbir test koşmadı.\nKullanım: npm run t -- <dosya> [<dosya> ...] [-u] [-t "<test adı>"]`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const files = [];
let update = false, name = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-u') update = true;
  else if (a === '-t') { name = argv[++i]; if (!name) fail('-t için test adı verilmedi'); }
  else if (a.startsWith('-')) fail(`bilinmeyen bayrak: ${a}`);
  else files.push(a);
}
if (!files.length) fail('en az bir test dosyası verilmeli');

const slash = (p) => p.replaceAll('\\', '/');
const abs = [];
for (const f of files) {
  if (f.includes('*')) fail(`"*" kabul edilmez: ${f}`);
  const cwdPath = path.resolve(process.cwd(), f);
  const a = path.isAbsolute(f) ? f : (existsSync(cwdPath) ? cwdPath : path.resolve(ROOT, f));
  if (!existsSync(a)) fail(`dosya yok: ${f}`);
  if (!statSync(a).isFile()) fail(`dosya değil (klasör olabilir): ${f}`);
  if (!/\.(test|spec)\./.test(path.basename(a))) fail(`test dosyası değil (.test. ya da .spec. geçmeli): ${f}`);
  if (path.relative(ROOT, a).startsWith('..')) fail(`depo dışında: ${f}`);
  abs.push(a);
}

function pkgDir(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === ROOT || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}
const pkgs = new Set(abs.map(pkgDir));
if (pkgs.has(null)) fail('dosyanın paketi (package.json) bulunamadı');
if (pkgs.size > 1) fail(`dosyalar aynı pakette olmalı: ${[...pkgs].map((p) => slash(path.relative(ROOT, p)) || '.').join(', ')}`);
const pkg = [...pkgs][0];
const pkgRel = slash(path.relative(ROOT, pkg)) || '.';
const rel = abs.map((a) => slash(path.relative(pkg, a)));
const relRoot = abs.map((a) => slash(path.relative(ROOT, a)));

// 15-B12: koşucu paketin `test` betiğinden çıkar (`npm run x` adımları açılır). Betik `node --test <kalıp>` içeriyorsa
// kalıba uyan dosya node --test ile (aynı adımın --import gibi bayraklarıyla), vitest içeriyorsa öteki dosyalar vitest ile.
function testSteps(dir) {
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {}
  const out = [];
  const seen = new Set();
  const expand = (name) => {
    if (seen.has(name) || !scripts[name]) return;
    seen.add(name);
    for (const step of scripts[name].split(/&&|\|\||;/).map((s) => s.trim())) {
      const sub = step.match(/^npm (?:run ([\w:.-]+)|(test))\b/);
      if (sub) expand(sub[1] ?? sub[2]);
      else out.push(step);
    }
  };
  expand('test');
  const tokens = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((x) => x.replace(/^["']|["']$/g, ''));
  const node = [];
  let vitest = false;
  for (const step of out) {
    const t = tokens(step);
    if (t[0] === 'node' && t.includes('--test')) {
      const at = t.indexOf('--test');
      const globs = t.slice(at + 1).filter((x) => !x.startsWith('-'));
      node.push({ flags: t.slice(1, at).join(' '), globs });
    } else if (/(^|\s|\/)vitest(\s|$)/.test(step)) vitest = true;
  }
  return { node, vitest };
}
const globRe = (g) => new RegExp(`^${g.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`);
const steps = testSteps(pkg);

// 15-B5: API'nin veritabanısız dosyaları ayrı yapılandırmayla, Postgres yoklamasız koşar (liste test/unitFiles.ts).
let apiUnit = new Set();
if (pkgRel === 'Deciship/apps/api') {
  try {
    const m = await import(pathToFileURL(path.join(pkg, 'test', 'unitFiles.ts')).href);
    apiUnit = new Set(m.UNIT_TEST_FILES);
  } catch (e) {
    console.warn(`Bilgi: Deciship/apps/api/test/unitFiles.ts okunamadı (${e.message}); dosyalar veritabanlı yapılandırmayla koşar.`);
  }
}

let nodeFlags = '';
const kind = (r, rr) => {
  if (/(^|\/)e2e\/.*\.spec\.[cm]?tsx?$/.test(r)) return 'playwright';
  if (pkgRel === 'Deciship/apps/mobile' && /^src\/hub\/__tests__\/.*\.test\.mts$/.test(r)) return 'hub';
  // KALANLAR 0.4: süre eşikli testler kendi yapılandırmasıyla (ana yapılandırmalar dışlar).
  // KALANLAR 6.14: veritabanlı başarım dosyası (`*.db.perf.test.ts`) ayrı yapılandırmada, Postgres ister.
  if (/\.db\.perf\.test\.[cm]?tsx?$/.test(r)) return 'perf-db';
  if (/\.perf\.test\.[cm]?tsx?$/.test(r)) return 'perf';
  if (apiUnit.has(r)) return 'api-unit';
  if (/^(Deciship\/apps\/web\/test|Deciship\/apps\/mobile\/test|Platform\/packages\/contracts\/test)\//.test(rr)) return 'node';
  if (/^((Platform\/)?scripts|tools\/lint)\/[^/]+\.test\.mjs$/.test(rr)) return 'node';
  // Derlenmiş komut girişi ve gateway yapılandırma testleri: node --test, veritabanı istemez.
  if (/^(Platform\/apps\/account-api\/test|Deciship\/apps\/api\/test|Platform\/gateway\/test)\/[^/]+\.test\.mjs$/.test(rr)) return 'node';
  const hit = steps.node.find((s) => s.globs.some((g) => globRe(g).test(r)));
  if (hit) {
    nodeFlags = hit.flags;
    return hit.flags ? `node ${hit.flags}` : 'node';
  }
  if (steps.vitest) return 'vitest';
  if (steps.node.length || /\.[cm]?js$/.test(r)) return 'node';
  return 'vitest';
};
const kinds = new Set(rel.map((r, i) => kind(r, relRoot[i])));
if (kinds.size > 1) fail(`dosyalar farklı koşucular ister (${[...kinds].join(', ')}); ayrı ayrı verin`);
let k = [...kinds][0];
if (k.startsWith('node ')) k = 'node';
if (update && k !== 'vitest' && k !== 'api-unit' && k !== 'perf' && k !== 'perf-db') fail('-u yalnız vitest dosyalarıyla kullanılır (node --test ve Playwright için reddedilir)');
if (k !== 'node' && !existsSync(path.join(pkg, 'node_modules'))) fail(`${pkgRel} içinde node_modules yok: npm run install:all`);

const q = (s) => `"${s}"`;
const isPg = k === 'perf-db' || (k === 'perf' && pkgRel === 'Platform/apps/account-api') || (k === 'vitest' && (/^(Deciship\/apps\/api|Platform\/apps\/account-api)$/.test(pkgRel) || rel.some((r) => /\.db\.test\./.test(r))));

// Postgres: TEST_DB_HOST, yoksa 5434 (Docker) ya da 5435 (yerel, npm run pg:baslat); bulunan adres TEST_DB_HOST ile geçer.
let childEnv = process.env;
if (isPg) {
  const pg = await findPg();
  if (!pg.ok) {
    console.error(`Postgres kapalı (${pg.addr}). ${PG_HINT}. Hiçbir test koşmadı.`);
    process.exit(2);
  }
  childEnv = { ...process.env, ...pgEnv(pg) };
  console.log(`Postgres: ${pg.addr} (${pg.source})`);
  if (pkgRel === 'Deciship/apps/api' && !process.env.TEST_DB_NAME) {
    console.log('Bilgi: TEST_DB_NAME verilmedi; bu koşu rastgele adlı kendi test veritabanını kurar ve bitişte siler (test/testEnv.ts).');
  }
}

const files_ = rel.map(q).join(' ');
let cmd;
if (k === 'playwright') {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const out = path.join(ROOT, '.test-logs', `pw-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
  mkdirSync(path.dirname(out), { recursive: true });
  cmd = `npx playwright test ${files_} --output=${q(slash(out))}${name ? ` -g ${q(name)}` : ''}`;
} else if (k === 'hub') {
  cmd = `node --import ./src/hub/__tests__/register.mjs --test ${name ? `--test-name-pattern=${q(name)} ` : ''}${files_}`;
} else if (k === 'node') {
  cmd = `node ${nodeFlags ? `${nodeFlags} ` : ''}--test ${name ? `--test-name-pattern=${q(name)} ` : ''}${files_}`;
} else if (k === 'perf') {
  if (!existsSync(path.join(pkg, 'vitest.perf.config.ts'))) fail(`${pkgRel} içinde vitest.perf.config.ts yok`);
  cmd = `npx vitest run --config vitest.perf.config.ts ${files_}${update ? ' -u' : ''}${name ? ` -t ${q(name)}` : ''}`;
} else if (k === 'perf-db') {
  if (!existsSync(path.join(pkg, 'vitest.perf-db.config.ts'))) fail(`${pkgRel} içinde vitest.perf-db.config.ts yok`);
  cmd = `npx vitest run --config vitest.perf-db.config.ts --silent=false ${files_}${update ? ' -u' : ''}${name ? ` -t ${q(name)}` : ''}`;
} else if (k === 'api-unit') {
  cmd = `npx vitest run --config vitest.unit.config.ts ${files_}${update ? ' -u' : ''}${name ? ` -t ${q(name)}` : ''}`;
} else {
  cmd = `npx vitest run ${files_}${update ? ' -u' : ''}${name ? ` -t ${q(name)}` : ''}`;
}

console.log(`[${pkgRel}] ${cmd}`);
const r = spawnSync(cmd, { cwd: pkg, shell: true, stdio: 'inherit', env: childEnv });
process.exit(r.status ?? 1);
