// Depo geneli lint ve biçim denetimi (Mesaj 10 planı 3.8). Kökten: `npm run lint`, `npm run format:check`.
// Kullanım:
//   node tools/lint/run.mjs [yol ...] [--warnings]          ESLint; yalnız hatalar ayrıntılı, uyarılar sayılır
//   node tools/lint/run.mjs --update-baseline               uyarı tabanını (warnings-baseline.json) bugünkü sayıya indirir
//   Uyarı tabanı: tüm depo koşusunda kural başına uyarı sayısı tabandan çoksa çıkış 1; azsa taban düşürülsün diye bilgi verilir.
//   node tools/lint/run.mjs --head-baseline <yol ...>       ön-commit kancası (KALANLAR 0.5): verilen dosyalarda kural
//     başına uyarı sayısı HEAD'deki hâllerinden çoksa çıkış 1. HEAD tabanın içindeyse bu, CI'daki taban kuralının aynısıdır.
//   node tools/lint/run.mjs --prettier-check [--strict] [prettier seçenekleri ...]
// Hiçbir kipte dosya yazılmaz (--fix ve --write yok; toplu biçimleme kullanıcı kararıdır).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

if (!existsSync(path.join(HERE, 'node_modules', 'eslint')) || !existsSync(path.join(HERE, 'node_modules', 'prettier'))) {
  console.error('koşmadı: tools/lint/node_modules yok. Kurmak için: npm run install:all');
  process.exit(1);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

// Bulgu sayıları parça başına toplanır; parça = bilinen paket klasörü (yoksa ilk iki klasör).
const PART_DIRS = [
  'Deciship/apps/api', 'Deciship/apps/web', 'Deciship/apps/mobile', 'Deciship/packages/core', 'Deciship/samples',
  'Deciship/brand', 'Platform/apps/account-api', 'Platform/apps/hub-web', 'Platform/apps/site',
  'Platform/packages/auth-kit', 'Platform/packages/contracts', 'Platform/packages/shell', 'Platform/e2e',
  'Platform/scripts', 'Platform/brand', 'scripts', 'tools/lint',
];
function partOf(rel) {
  const p = rel.replaceAll('\\', '/');
  const hit = PART_DIRS.find((d) => p === d || p.startsWith(d + '/'));
  if (hit) return hit;
  const segs = p.split('/');
  return segs.length > 2 ? segs.slice(0, 2).join('/') : segs.length === 2 ? segs[0] : '(kök)';
}

function table(rows, head) {
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => '  ' + r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

if (has('--prettier-check')) {
  const strict = has('--strict');
  const extra = args.filter((a) => a !== '--prettier-check' && a !== '--strict');
  const bin = path.join(HERE, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  const r = spawnSync(process.execPath, [bin, '--list-different', ...extra, '.'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 2 || r.error) {
    console.error(r.stderr || r.error?.message);
    console.error('Prettier çalışırken hata verdi (yukarıda).');
    process.exit(2);
  }
  const files = r.stdout.split(/\r?\n/).filter(Boolean);
  const byPart = new Map();
  for (const f of files) byPart.set(partOf(f), (byPart.get(partOf(f)) ?? 0) + 1);
  if (files.length) {
    table([...byPart].sort((a, b) => b[1] - a[1]), ['parça', 'dosya']);
    console.log('\nİlk 20 dosya:');
    for (const f of files.slice(0, 20)) console.log('  ' + f);
  }
  if (r.stderr.trim()) console.log('\n' + r.stderr.trim());
  console.log(`\nBiçim farkı olan dosya: ${files.length}. Dosyalara dokunulmadı; toplu biçimleme kullanıcı kararıdır.`);
  process.exit(strict && files.length ? 1 : 0);
}

const { ESLint } = await import('eslint');
const headBaseline = has('--head-baseline');
const showWarnings = has('--warnings');
const targets = args.filter((a) => !a.startsWith('--'));
// warnIgnored: false — kanca sahnelenen dosyaları tek tek verir; lint'in yok saydığı (ör. `.d.ts`) bir dosya "File ignored"
// uyarısı üretip uyarı tabanını haksız aşmasın.
const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: true, warnIgnored: false });
const t0 = Date.now();
const results = await eslint.lintFiles(targets.length ? targets : ['.']);

const shown = showWarnings ? results : results
  .map((r) => ({ ...r, messages: r.messages.filter((m) => m.severity === 2), warningCount: 0, fixableWarningCount: 0 }))
  .filter((r) => r.messages.length);
const formatter = await eslint.loadFormatter('stylish');
const out = await formatter.format(shown);
if (out.trim()) console.log(out);

let errors = 0, warnings = 0;
const byRule = new Map();
const byPart = new Map();
for (const r of results) {
  const part = partOf(path.relative(ROOT, r.filePath));
  const pc = byPart.get(part) ?? { files: 0, e: 0, w: 0 };
  pc.files++;
  for (const m of r.messages) {
    const rule = m.ruleId ?? (m.fatal ? '(ayrıştırma hatası)' : '(yönerge)');
    const rc = byRule.get(rule) ?? { e: 0, w: 0 };
    if (m.severity === 2) { rc.e++; pc.e++; errors++; } else { rc.w++; pc.w++; warnings++; }
    byRule.set(rule, rc);
  }
  byPart.set(part, pc);
}

console.log(`\nLint: ${results.length} dosya, ${errors} hata, ${warnings} uyarı (${((Date.now() - t0) / 1000).toFixed(1)} sn)`);
if (byRule.size) {
  console.log('\nKural başına:');
  table([...byRule].sort((a, b) => b[1].e - a[1].e || b[1].w - a[1].w).map(([k, v]) => [k, v.e, v.w]), ['kural', 'hata', 'uyarı']);
}
console.log('\nParça başına:');
table([...byPart].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, v.files, v.e, v.w]), ['parça', 'dosya', 'hata', 'uyarı']);
if (warnings && !showWarnings) console.log('\nUyarıların ayrıntısı: npm run lint -- --warnings [yol]');
// Uyarı tabanı yalnız tüm depo koşusunda anlamlıdır (yol verilirse sayılar eksik olur).
const BASELINE = path.join(HERE, 'warnings-baseline.json');
const current = Object.fromEntries([...byRule].filter(([, v]) => v.w).map(([k, v]) => [k, v.w]).sort((a, b) => a[0].localeCompare(b[0])));
let baselineFail = false;
if (has('--update-baseline')) {
  if (targets.length) { console.error('\n--update-baseline yol verilmeden (tüm depo) kullanılır.'); process.exit(2); }
  writeFileSync(BASELINE, JSON.stringify({ kurallar: current }, null, 2) + '\n');
  console.log(`\nUyarı tabanı yenilendi: ${Object.values(current).reduce((a, b) => a + b, 0)} uyarı.`);
} else if (headBaseline && targets.length) {
  // Aynı dosyaların HEAD'deki içeriği aynı yapılandırmayla; yeni dosyanın HEAD sayısı 0.
  const before = new Map();
  for (const r of results) {
    const rel = path.relative(ROOT, r.filePath).replaceAll('\\', '/');
    const g = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (g.status !== 0) continue;
    for (const h of await eslint.lintText(g.stdout, { filePath: r.filePath })) {
      for (const m of h.messages) if (m.severity === 1) before.set(m.ruleId ?? '(yönerge)', (before.get(m.ruleId ?? '(yönerge)') ?? 0) + 1);
    }
  }
  const worse = Object.entries(current).filter(([k, n]) => n > (before.get(k) ?? 0));
  if (worse.length) {
    baselineFail = true;
    console.log("\nUyarı tabanı aşılır (bu dosyalarda HEAD'e göre yeni uyarı; CI da kırılır). Düzelt ya da gerekçeyle bastır:");
    for (const [k, n] of worse) console.log(`  ${k}: ${before.get(k) ?? 0} -> ${n}`);
    console.log('Ayrıntı: node tools/lint/run.mjs --warnings <dosya>');
  }
} else if (!targets.length) {
  if (!existsSync(BASELINE)) {
    console.log('\nUyarı tabanı yok (tools/lint/warnings-baseline.json); oluşturmak için: node tools/lint/run.mjs --update-baseline');
  } else {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')).kurallar ?? {};
    const worse = Object.entries(current).filter(([k, n]) => n > (base[k] ?? 0));
    const better = Object.keys({ ...base, ...current }).filter((k) => (current[k] ?? 0) < (base[k] ?? 0));
    if (worse.length) {
      baselineFail = true;
      console.log('\nUyarı tabanı aşıldı (yeni uyarı eklenmiş; düzelt ya da gerekçeyle bastır):');
      for (const [k, n] of worse) console.log(`  ${k}: ${base[k] ?? 0} -> ${n}`);
    }
    if (better.length) {
      console.log('\nUyarı sayısı tabanın altına indi; tabanı düşür: node tools/lint/run.mjs --update-baseline');
      for (const k of better) console.log(`  ${k}: ${base[k]} -> ${current[k] ?? 0}`);
    }
  }
}
console.log(errors ? '\nSONUÇ: lint hatası var (yukarıda).' : baselineFail ? '\nSONUÇ: lint 0 hata ama uyarı tabanı aşıldı.' : '\nSONUÇ: lint 0 hata.');
process.exit(errors || baselineFail ? 1 : 0);
