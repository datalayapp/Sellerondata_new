// Tek test koşturucu (Mesaj 10 planı 3.3). Yalnız Node yerleşik modülleri.
// Kullanım: node scripts/test.mjs <grup...> [--only id,id] [--scope Platform|Deciship] [--jobs N] [--shard i/n] [--list]
// --shard i/n: `shard: true` parçalarına vitest `--shard=i/n` geçer (CI veritabanı işi, KALANLAR 0.7); ötekiler tam koşar.
// `gate: false` parça (perf) kalırsa "kaldı (bilgi)" yazılır, sonucu bozmaz.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTS, GROUPS, DEFAULT_TIMEOUT } from './parts.mjs';
import { findPg, pgEnv, PG_HINT } from './lib/pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const CI = process.env.CI === 'true';

function usage(code) {
  console.log(`Kullanım: node scripts/test.mjs <grup...> [--only id,id] [--scope Platform|Deciship] [--jobs N] [--shard i/n] [--list]
Gruplar: ${GROUPS.join(', ')}
Örnek: node scripts/test.mjs quick --only core,web`);
  process.exit(code);
}

const args = process.argv.slice(2);
const groups = [];
let only = null, scope = null, jobs = null, list = false, shard = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--list') list = true;
  else if (a === '--only') only = (args[++i] ?? '').split(',').filter(Boolean);
  else if (a === '--scope') scope = args[++i];
  else if (a === '--jobs') jobs = Number(args[++i]);
  else if (a === '--shard') shard = args[++i] ?? '';
  else if (a === '--help' || a === '-h') usage(0);
  else if (GROUPS.includes(a)) groups.push(a);
  else { console.error(`Bilinmeyen bağımsız değişken: ${a}`); usage(2); }
}
if (jobs !== null && !(jobs >= 1)) { console.error('--jobs 1 ya da daha büyük bir sayı olmalı'); process.exit(2); }
if (shard !== null) {
  const m = shard.match(/^(\d+)\/(\d+)$/);
  if (!m || +m[1] < 1 || +m[1] > +m[2]) { console.error('--shard i/n biçiminde olmalı (1 <= i <= n), ör. 2/3'); process.exit(2); }
}
if (scope && !['Platform', 'Deciship'].includes(scope)) { console.error('--scope Platform ya da Deciship olmalı'); process.exit(2); }
if (only) {
  const bad = only.filter((id) => !PARTS.some((p) => p.id === id));
  if (bad.length) { console.error(`Bilinmeyen parça: ${bad.join(', ')} (liste: npm run parts)`); process.exit(2); }
}
if (!groups.length && !only && !list) usage(2);
const activeGroups = groups.length ? groups : GROUPS;

const inScope = (p) => !scope || p.dir === scope || p.dir.startsWith(scope + '/');
const selected = (g) => PARTS.filter((p) => p.group === g && inScope(p) && (!only || only.includes(p.id)));

if (list) {
  for (const g of activeGroups) {
    const ps = selected(g);
    if (!ps.length) continue;
    console.log(`\n[${g}]`);
    for (const p of ps) {
      const flags = [p.pg ? 'Postgres' : '', p.tool?.startsWith('docker') ? 'Docker' : '', p.optional ? 'isteğe bağlı' : ''].filter(Boolean).join(', ');
      console.log(`  ${p.id.padEnd(16)} ${p.dir.padEnd(30)} ${p.cmd}${flags ? `   (${flags})` : ''}`);
    }
  }
  process.exit(0);
}

const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const logRoot = path.join(ROOT, '.test-logs');
const fmt = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} sn` : `${Math.floor(ms / 60000)} dk ${Math.round((ms % 60000) / 1000)} sn`);

function toolMissing(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'ignore', timeout: 20000 });
  return r.status !== 0;
}

// koşmadı nedeni ya da null
function skipReason(p) {
  const abs = path.join(ROOT, p.dir);
  if (!existsSync(abs)) return `klasör yok: ${p.dir}`;
  for (const n of p.needs ?? []) {
    if (!existsSync(path.join(abs, n))) return `dosya yok: ${p.dir === '.' ? '' : p.dir + '/'}${n}`;
  }
  if (p.modules !== false) {
    const m = p.modules || p.dir;
    if (!existsSync(path.join(ROOT, m, 'node_modules'))) return `node_modules yok (${m}): npm run install:all`;
  }
  if (p.tool && toolMissing(p.tool)) return `araç yok (${p.tool.split(' ')[0]})`;
  return null;
}

// Süreç ağacı yalnız PID ile kapatılır; ada göre öldürme yok.
function killTree(child) {
  if (!child.pid) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* bitmiş */ } }
  }
}

function runPart(p, logDir, extraEnv = {}) {
  return new Promise((resolve) => {
    const logFile = path.join(logDir, `${p.id.replace(/[^\w.-]/g, '_')}.log`);
    const out = createWriteStream(logFile);
    let cmd = p.cmd.replaceAll('<LOG>', logDir.replaceAll('\\', '/'));
    if (shard && p.shard) cmd += ` -- --shard=${shard}`;
    out.write(`> ${p.dir}: ${cmd}\n\n`);
    const t0 = Date.now();
    const child = spawn(cmd, { cwd: path.join(ROOT, p.dir), env: { ...process.env, ...extraEnv, ...(p.env ?? {}) }, shell: true, detached: !WIN, windowsHide: true });
    let timedOut = false;
    const limit = p.timeout ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
    child.stdout.on('data', (b) => out.write(b));
    child.stderr.on('data', (b) => out.write(b));
    const finish = (status, note) => {
      clearTimeout(timer);
      out.end(`\n[${status}${note ? ` ${note}` : ''}]\n`);
      resolve({ p, status, note, ms: Date.now() - t0, logFile });
    };
    child.once('error', (e) => finish('kaldı', e.message));
    child.once('close', (code) => {
      if (timedOut) finish('kaldı', `(süre ${fmt(limit)} doldu)`);
      else finish(code === 0 ? 'geçti' : 'kaldı', code === 0 ? '' : `(çıkış kodu ${code})`);
    });
  });
}

async function pool(items, n, fn) {
  const res = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx]); }
  }));
  return res;
}

const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };
let bad = false;
const startAll = Date.now();

for (const g of activeGroups) {
  const parts = selected(g);
  if (!parts.length) continue;
  const logDir = path.join(logRoot, `${g}-${stamp}`);
  mkdirSync(logDir, { recursive: true });
  say(`\n== ${g} (${parts.length} parça) ==  günlük: ${path.relative(ROOT, logDir)}`);

  // Postgres: TEST_DB_HOST, yoksa 5434 (Docker) ya da 5435 (yerel); bulunan adres alt süreçlere TEST_DB_HOST ile geçer.
  let pgOk = true;
  let extraEnv = {};
  if (parts.some((p) => p.pg)) {
    const pg = await findPg();
    pgOk = pg.ok;
    extraEnv = pgEnv(pg);
    say(pg.ok ? `  Postgres: ${pg.addr} (${pg.source})` : `  Postgres yok (${pg.addr})`);
  }

  const results = [];
  const runnable = [];
  for (const p of parts) {
    let reason = skipReason(p);
    if (!reason && p.pg && !pgOk) reason = `Postgres kapalı (${PG_HINT})`;
    if (reason) results.push({ p, status: 'koşmadı', note: reason, ms: 0 });
    else runnable.push(p);
  }
  const n = jobs ?? (g === 'db' ? 2 : 3);
  const ran = await pool(runnable, n, (p) => { console.log(`  başladı: ${p.id}`); return runPart(p, logDir, extraEnv); });
  results.push(...ran);

  for (const p of parts) {
    const r = results.find((x) => x.p === p);
    const label = r.status === 'koşmadı' ? `koşmadı: ${r.note}` : `${r.status}${r.status === 'kaldı' && p.gate === false ? ' (bilgi)' : ''}${r.note ? ' ' + r.note : ''}`;
    say(`  ${p.id.padEnd(16)} ${label}${r.ms ? `  [${fmt(r.ms)}]` : ''}`);
    if (r.status === 'kaldı' && p.gate === false) say(`      bilgi (sonucu bozmaz): ${path.relative(ROOT, r.logFile)}`);
    else if (r.status === 'kaldı') { bad = true; say(`      günlük: ${path.relative(ROOT, r.logFile)}`); }
    if (r.status === 'koşmadı' && p.gate !== false && (CI || !p.optional)) bad = true;
  }
}

say(`\n${bad ? 'SONUÇ: BAŞARISIZ' : 'SONUÇ: tamam'}  (${fmt(Date.now() - startAll)})`);
mkdirSync(logRoot, { recursive: true });
writeFileSync(path.join(logRoot, 'son.txt'), lines.join('\n') + '\n');
process.exit(bad ? 1 : 0);
