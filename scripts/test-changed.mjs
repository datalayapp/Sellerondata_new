#!/usr/bin/env node
// Değişen dosyaların testleri (KALANLAR 0.2). Yalnız Node yerleşikleri ve salt okunur git.
//
//   npm run test:changed                 son gönderimden bu yana commit'ler + sahnelenen + sahnelenmemiş + izlenmeyen
//   npm run test:changed -- --staged     yalnız sahnelenen
//   npm run test:changed -- --deps       paket değiştiyse onu file: ile alan paketlerin ilgili vitest testleri de
//   npm run test:changed -- --no-tc      tip denetimi yok (varsayılan: dokunulan paketin tip denetimi koşar)
//   npm run test:changed -- --dry-run    yalnız planı yazar
//   npm run test:changed -- <dosya...>   git yerine verilen dosyalar (depo köküne göre)
//
// Paket başına: vitest paketlerinde `vitest related` (değişen kaynağı içe aktaran testler + değişen testin kendisi);
// node --test paketlerinde değişen test dosyası ve değişen kaynağın adını içe aktaran test dosyaları. Veritabanı isteyen
// adımlar Postgres varsa koşar (scripts/lib/pg.mjs: 5434 Docker ya da 5435 yerel), yoksa "koşmadı" yazılır.
// Çıkış: 0 hepsi geçti (koşmayanlar ayrıca yazılır), 1 kalan var, 2 kullanım hatası.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PARTS } from './parts.mjs';
import { findPg, pgEnv, PG_HINT } from './lib/pg.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json)$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Paketler. vitest: `vitest related` adımları (pg: Postgres ister; nopg: Postgres yokken onun yerine koşan adım).
// node: node --test ile koşan test kalıpları (paket köküne göre; `*` tek klasör içi). tc: tip denetimi parçası.
export const PACKAGES = [
  { dir: 'Deciship/packages/core', vitest: [{}], tc: 'tc:core' },
  {
    dir: 'Deciship/apps/api',
    vitest: [{ label: 'birim', args: '--config vitest.unit.config.ts' }, { label: 'veritabanı', pg: true }],
    node: [{ globs: ['test/*.test.mjs'] }],
    tc: 'tc:api',
  },
  { dir: 'Platform/apps/account-api', vitest: [{ label: 'veritabanı', pg: true }], node: [{ globs: ['test/*.test.mjs'] }], tc: 'tc:account' },
  { dir: 'Platform/apps/ai-api', vitest: [{ label: 'veritabanı', pg: true }], tc: 'tc:ai' },
  { dir: 'Platform/packages/auth-kit', vitest: [{ pg: true, nopg: '--exclude "test/**/*.db.test.ts"' }], tc: 'tc:auth-kit' },
  { dir: 'Platform/packages/product-kit', vitest: [{ pg: true, nopg: '--exclude "test/**/*.db.test.ts"' }], tc: 'tc:product-kit' },
  { dir: 'Platform/packages/shell', vitest: [{}], tc: 'tc:shell', i18n: 'shell-i18n' },
  { dir: 'Deciship/apps/mobile', vitest: [{}], node: [{ globs: ['test/*.test.ts'] }, { globs: ['src/hub/__tests__/*.test.mts'], flags: '--import ./src/hub/__tests__/register.mjs' }], tc: 'tc:mobile', i18n: 'mobile-i18n' },
  { dir: 'Deciship/apps/web', node: [{ globs: ['test/*.test.ts'] }], tc: 'tc:web', i18n: 'web-i18n' },
  { dir: 'Platform/apps/hub-web', node: [{ globs: ['src/lib/*.test.mjs', 'test/*.test.mjs'] }], tc: 'tc:hub', i18n: 'hub-i18n' },
  { dir: 'Platform/packages/contracts', node: [{ globs: ['test/*.test.ts'] }], tc: 'tc:contracts' },
  { dir: 'Platform/packages/format', node: [{ globs: ['test/*.test.ts'] }], tc: 'tc:format' },
  { dir: 'Platform/packages/tokens', node: [{ globs: ['test/*.test.mjs'] }] },
  // TagPress pnpm çalışma alanı (workspace): vitest çalışma alanı kökünden tek ayarla ve `pnpm exec` ile koşar; dosya
  // yolları o köke göre. Son satır paketsiz dosyalar (kök betikleri, kök ayarları).
  { dir: 'Tagpress/apps/mcp', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-mcp' },
  // Sunucu: SQLite koşusu ve aynı testlerin Postgres koşusu (vitest.pg.config.ts; *.pg.test.ts yalnız orada).
  { dir: 'Tagpress/apps/server', workspace: 'Tagpress', vitest: [{}, { label: 'veritabanı', pg: true, args: '--config vitest.pg.config.ts' }], tc: 'tc:tp-server' },
  { dir: 'Tagpress/apps/web', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-web', i18n: 'tp-web-i18n' },
  { dir: 'Tagpress/packages/ai', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-ai' },
  { dir: 'Tagpress/packages/domain', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-domain' },
  { dir: 'Tagpress/packages/engine', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-engine' },
  { dir: 'Tagpress/packages/learn', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-learn' },
  { dir: 'Tagpress/packages/print', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-print' },
  { dir: 'Tagpress/packages/templates', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-templates' },
  { dir: 'Tagpress/packages/typeset', workspace: 'Tagpress', vitest: [{}], tc: 'tc:tp-typeset' },
  { dir: 'Tagpress', workspace: 'Tagpress', vitest: [{}] },
  // Kök betikleri ve paketsiz test dosyaları (scripts, tools/lint, Platform/scripts, gateway yapılandırması).
  {
    dir: '.',
    owns: ['scripts/', 'tools/lint/', 'Platform/scripts/', 'Platform/gateway/', '.github/', '.githooks/'],
    node: [{ globs: ['scripts/*.test.mjs', 'scripts/lib/*.test.mjs', 'tools/lint/*.test.mjs', 'Platform/scripts/*.test.mjs', 'Platform/gateway/test/*.test.mjs'] }],
  },
];

const slash = (p) => p.replaceAll('\\', '/');
const prefixOf = (pkg) => (pkg.dir === '.' ? '' : pkg.dir + '/');

/** Dosyanın paketi (en uzun önek); yoksa null. */
export function packageOf(file) {
  let best = null;
  for (const p of PACKAGES) {
    const pres = p.owns ?? [prefixOf(p)];
    for (const pre of pres) if (file.startsWith(pre) && (!best || pre.length > best.len)) best = { pkg: p, len: pre.length };
  }
  return best?.pkg ?? null;
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

function listGlob(pkgDirAbs, glob) {
  const dir = path.posix.dirname(glob);
  const abs = path.join(pkgDirAbs, dir);
  if (!existsSync(abs)) return [];
  const re = globRe(path.posix.basename(glob));
  return readdirSync(abs).filter((f) => re.test(f)).map((f) => (dir === '.' ? f : `${dir}/${f}`));
}

/**
 * Kaynak dosyayı içe aktaran ya da adını geçiren test: `…/ad'`, `…/ad.ts'` biçiminde bir dize. `index` dosyasında ad
 * yerine klasörü aranır (`…/src/index.ts'`, `…/src'`); paket kökündeki index eşleşmez (fazla genel).
 */
export function mentions(text, rel) {
  const esc = (x) => x.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  const stem = path.posix.basename(rel).replace(/\.[^.]+$/, '');
  if (!stem) return false;
  if (stem === 'index') {
    const parent = path.posix.basename(path.posix.dirname(rel));
    if (!parent || parent === '.') return false;
    return new RegExp(`[/'"\`]${esc(parent)}(/index(\\.[\\w.]+)?)?/?['"\`]`).test(text);
  }
  return new RegExp(`[/'"\`]${esc(stem)}(\\.[\\w.]+)?['"\`]`).test(text);
}

const q = (s) => `"${s}"`;

/**
 * Plan: [{ pkg, label, cmd, cwd, pg, note }]. `files` depo köküne göre (var olan dosyalar).
 * `read(abs)` test dosyası içeriği (sınamada sahte verilir), `list(pkgAbs, glob)` kalıba uyan dosyalar.
 */
export function plan(files, { pgOk, deps = false, tc = true, read = (f) => readFileSync(f, 'utf8'), list = listGlob, root = ROOT } = {}) {
  const steps = [];
  const unowned = [];
  const byPkg = new Map();
  for (const f of files) {
    const p = packageOf(f);
    if (!p) { unowned.push(f); continue; }
    if (!byPkg.has(p)) byPkg.set(p, []);
    byPkg.get(p).push(f);
  }
  // --deps: değişen paketi file: ile alan vitest paketlerine değişen dosyalar mutlak yolla eklenir.
  const extra = new Map();
  if (deps) {
    for (const [p, fs] of byPkg) {
      if (p.dir === '.') continue;
      for (const d of dependentsOf(p.dir, root)) {
        const dp = PACKAGES.find((x) => x.dir === d);
        if (!dp?.vitest) continue;
        if (!extra.has(dp)) extra.set(dp, []);
        extra.get(dp).push(...fs);
      }
    }
  }
  const pkgs = [...new Set([...byPkg.keys(), ...extra.keys()])];
  for (const p of pkgs) {
    const own = byPkg.get(p) ?? [];
    const pre = prefixOf(p);
    const cwd = path.join(root, p.dir);
    const rel = own.map((f) => f.slice(pre.length));
    // pnpm çalışma alanında vitest kökten koşar: yollar ve klasör çalışma alanı köküne göre.
    const vCwd = p.workspace ? path.join(root, p.workspace) : cwd;
    const vRel = p.workspace ? own.map((f) => f.slice(p.workspace.length + 1)) : rel;
    const code = vRel.filter((f) => CODE.test(f));
    const foreign = (extra.get(p) ?? []).filter((f) => CODE.test(f)).map((f) => slash(path.relative(vCwd, path.join(root, f))));
    const related = [...code, ...foreign];
    const before = steps.length;
    for (const v of p.vitest ?? []) {
      if (!related.length) break;
      const label = `${p.dir} vitest${v.label ? ` (${v.label})` : ''}`;
      const base = `${p.workspace ? 'pnpm exec' : 'npx'} vitest related --run --passWithNoTests`;
      if (v.pg && !pgOk) {
        if (v.nopg) steps.push({ pkg: p.dir, label: `${label}, veritabanısız`, cwd: vCwd, cmd: `${base} ${v.nopg} ${related.map(q).join(' ')}` });
        steps.push({ pkg: p.dir, label, skip: `Postgres kapalı (${PG_HINT})` });
        continue;
      }
      steps.push({ pkg: p.dir, label, cwd: vCwd, pg: !!v.pg, cmd: `${base}${v.args ? ` ${v.args}` : ''} ${related.map(q).join(' ')}` });
    }
    for (const n of p.node ?? []) {
      const all = n.globs.flatMap((g) => list(cwd, g));
      const changedTests = rel.filter((f) => all.includes(f));
      const sources = rel.filter((f) => !TEST.test(f));
      const hit = new Set(changedTests);
      if (sources.length) {
        for (const t of all) {
          if (hit.has(t)) continue;
          let text = '';
          try { text = read(path.join(cwd, t)); } catch { continue; }
          if (sources.some((s) => mentions(text, s))) hit.add(t);
        }
      }
      if (!hit.size) continue;
      const tests = [...hit].sort();
      steps.push({ pkg: p.dir, label: `${p.dir === '.' ? 'kök' : p.dir} node --test (${tests.length} dosya)`, cwd, cmd: `node ${n.flags ? `${n.flags} ` : ''}--test ${tests.map(q).join(' ')}` });
    }
    const testSteps = steps.length - before;
    if (p.i18n && rel.some((f) => f.includes('/locales/') || /\.tsx?$/.test(f))) {
      const part = PARTS.find((x) => x.id === p.i18n);
      if (part) steps.push({ pkg: p.dir, label: `${p.dir} sözlük (${part.id})`, cwd: path.join(root, part.dir), cmd: part.cmd });
    }
    if (tc && p.tc && rel.some((f) => /\.(ts|tsx|mts|cts)$/.test(f))) {
      const part = PARTS.find((x) => x.id === p.tc);
      if (part) steps.push({ pkg: p.dir, label: `${p.dir} tip denetimi`, cwd: path.join(root, part.dir), cmd: part.cmd });
    }
    if (!own.length) continue;
    if (!testSteps) steps.push({ pkg: p.dir, label: `${p.dir === '.' ? 'kök' : p.dir} testleri`, skip: 'değişen dosyalara bağlı test bulunamadı' });
  }
  return { steps, unowned };
}

/** Paketi `file:` bağıyla alan paket klasörleri (depo köküne göre). */
export function dependentsOf(dir, root = ROOT) {
  const out = [];
  for (const p of PACKAGES) {
    if (p.dir === '.' || p.dir === dir) continue;
    let pj;
    try { pj = JSON.parse(readFileSync(path.join(root, p.dir, 'package.json'), 'utf8')); } catch { continue; }
    const specs = Object.values({ ...pj.dependencies, ...pj.devDependencies }).filter((v) => String(v).startsWith('file:'));
    if (specs.some((v) => slash(path.relative(root, path.resolve(root, p.dir, String(v).slice(5)))) === dir)) out.push(p.dir);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
}

function changed(stagedOnly) {
  const set = new Set();
  const notes = [];
  const add = (xs) => xs?.forEach((x) => set.add(slash(x)));
  add(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  if (!stagedOnly) {
    add(git(['diff', '--name-only', '--diff-filter=ACMR']));
    add(git(['ls-files', '--others', '--exclude-standard']));
    const base = git(['rev-parse', '--verify', '-q', '@{push}'])?.[0] ?? git(['rev-parse', '--verify', '-q', '@{upstream}'])?.[0];
    if (base) add(git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]));
    else notes.push('uzak dal bulunamadı: yalnız çalışma ağacı ve sahnelenenler');
  }
  return { files: [...set].filter((f) => existsSync(path.join(ROOT, f))).sort(), notes };
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--staged', '--deps', '--no-tc', '--dry-run', '--help', '-h']);
  const bad = args.filter((a) => a.startsWith('-') && !known.has(a));
  if (bad.length || args.includes('--help') || args.includes('-h')) {
    console.log('Kullanım: npm run test:changed -- [--staged] [--deps] [--no-tc] [--dry-run] [<dosya...>]');
    process.exit(bad.length ? 2 : 0);
  }
  const given = args.filter((a) => !a.startsWith('-')).map((f) => slash(path.relative(ROOT, path.resolve(f))));
  const missing = given.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missing.length) { console.error(`Dosya yok: ${missing.join(', ')}`); process.exit(2); }
  const { files, notes } = given.length ? { files: given, notes: [] } : changed(args.includes('--staged'));
  for (const n of notes) console.log(`Not: ${n}`);
  if (!files.length) { console.log('Değişen dosya yok; hiçbir test koşmadı.'); return 0; }
  const needsPg = files.some((f) => /^(Deciship\/apps\/api|Platform\/apps\/account-api|Platform\/packages\/(auth|product)-kit)\//.test(f)) || args.includes('--deps');
  const pg = needsPg ? await findPg() : { ok: false };
  const { steps, unowned } = plan(files, { pgOk: pg.ok, deps: args.includes('--deps'), tc: !args.includes('--no-tc') });
  console.log(`${files.length} değişen dosya; ${steps.filter((s) => !s.skip).length} adım.${needsPg ? ` Postgres: ${pg.ok ? `${pg.addr} (${pg.source})` : 'yok'}` : ''}`);
  if (unowned.length) console.log(`Testi olmayan yerler (belge, yapılandırma): ${unowned.length} dosya${unowned.length <= 6 ? `: ${unowned.join(', ')}` : ''}`);
  const results = [];
  const env = { ...process.env, ...pgEnv(pg) };
  for (const s of steps) {
    if (s.skip) { results.push({ s, status: 'koşmadı', note: s.skip }); continue; }
    console.log(`\n== ${s.label}\n   ${s.cmd}`);
    if (args.includes('--dry-run')) { results.push({ s, status: 'plan' }); continue; }
    const t0 = Date.now();
    const r = spawnSync(s.cmd, { cwd: s.cwd, shell: true, stdio: 'inherit', env, windowsHide: true });
    results.push({ s, status: r.status === 0 ? 'geçti' : 'kaldı', ms: Date.now() - t0 });
  }
  console.log('\nÖzet:');
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.s.label}${r.note ? `  (${r.note})` : ''}${r.ms ? `  [${(r.ms / 1000).toFixed(1)} sn]` : ''}`);
  const failed = results.filter((r) => r.status === 'kaldı').length;
  const skipped = results.filter((r) => r.status === 'koşmadı' && !/bulunamadı/.test(r.note)).length;
  console.log(failed ? `SONUÇ: ${failed} adım kaldı` : `SONUÇ: tamam${skipped ? ` (koşmadı: ${skipped} adım; geçti sayılmaz)` : ''}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(await main());
