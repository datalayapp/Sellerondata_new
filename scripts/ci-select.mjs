#!/usr/bin/env node
// CI iş seçimi (Mesaj 10, 15-B1): ağır işler (veritabanı, görüntü servisi) hangi gönderimde koşar.
// Kural: işin en son "sınandığı" commit'ten (o işin geçen, kalan ya da süren koşusu; iptal ve atlanan sayılmaz)
// bu yana işin yollarına dokunan değişiklik ya da bir commit mesajında [db] varsa iş koşar; öncesi bulunamazsa koşar.
// Böylece iptal edilen, atlanan ya da sırada yerini yenisine bırakan koşunun değişikliği kaybolmaz.
//
//   node scripts/ci-select.mjs              CI'da: GITHUB_OUTPUT'a db=, vision= yazar (okuma hatasında ikisi de true)
//   node scripts/ci-select.mjs --dry-run [sha]   yerelde: aynı kararı yazdırır, hiçbir şeye yazmaz
//
// Yalnız Node yerleşikleri, salt okunur git ve `gh api` (okuma). scripts/main-ready.mjs de bunları kullanır.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matchGlob } from './repo-check.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW = 'ci.yml';
export const readCiYml = () => readFileSync(path.join(ROOT, '.github', 'workflows', WORKFLOW), 'utf8').replace(/\r\n/g, '\n');

// İş adlarının başı (ci.yml `name:` bununla başlar; ad değişirse ci-select.test.mjs kırılır).
export const JOBS = {
  hizli: 'Denetim, lint',
  db: 'Veritabanı testleri',
  vision: 'Görüntü servisi testleri',
};

// Veritabanı işini tetikleyen yollar. Ölçüt: veritabanı testlerinin koştuğu kod ya da onun çalışma anında yüklediği kod.
export const DB_PATHS = [
  '**/prisma/**', // şema ve göçler
  'Deciship/apps/api/**',
  'Deciship/packages/core/**', // API hesap motorunu file: bağıyla yükler
  'Platform/apps/account-api/**',
  'Platform/packages/auth-kit/**',
  'Platform/packages/product-kit/**',
  'Platform/packages/contracts/**', // rol ve izin tablosu: izin matrisi testleri
  'Platform/packages/format/**', // API ve çekirdek para ve tarih biçimini buradan alır
  'Platform/infra/**', // init.sql: roller ve RLS kullanıcıları
  'scripts/lib/**', // API sözleşme testleri şekil yardımcısını kullanır
  'scripts/parts.mjs',
  'scripts/test.mjs',
  'scripts/install.mjs',
  'scripts/ci-select.mjs', // seçimin kendisi
  '.github/workflows/ci.yml',
  '.nvmrc', // Node sürümü
];

export const VISION_PATHS = ['Deciship/services/vision/**', '.github/workflows/ci.yml'];

// ci.yml `paths-ignore` ile aynı: yalnız bunlar değişirse CI hiç koşmaz (ci-select.test.mjs eşitliği sınar).
export const IGNORE_PATHS = ['SONRAKI-OTURUM/**', '**/*.md', '.claude/**'];

export const PATHS = { db: DB_PATHS, vision: VISION_PATHS };

export const matchesAny = (file, globs) => globs.some((g) => matchGlob(file, g));
// İşi tetikleyen dosyalar: işin yollarında olup yok sayılan (belge) olmayanlar.
export const relevantFiles = (files, key) => files.filter((f) => matchesAny(f, PATHS[key]) && !matchesAny(f, IGNORE_PATHS));
export const DB_TAG = /\[db\]/i;
export const DB_LATER = /\[db-sonra\]/i;

// İş "sınandı" sayılır mı: geçti, kaldı ya da sürüyor. İptal, atlandı, süre aşımı ve sırada bekleyen sayılmaz.
export const counts = (job) =>
  job.status === 'in_progress' || (job.status === 'completed' && (job.conclusion === 'success' || job.conclusion === 'failure'));

// ---------------------------------------------------------------------------------------------------------------------
// git ve gh (yalnız okuma)
// ---------------------------------------------------------------------------------------------------------------------

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || r.error?.message || '' };
}

export function git(...args) {
  const r = run('git', args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`);
  return r.out;
}

export function hasCommit(sha) {
  return run('git', ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

const ancestorCache = new Map();
export function isAncestor(a, b) {
  const k = `${a}..${b}`;
  if (!ancestorCache.has(k)) ancestorCache.set(k, hasCommit(a) && run('git', ['merge-base', '--is-ancestor', a, b]).ok);
  return ancestorCache.get(k);
}

// --no-renames: taşınan dosyanın hem eski hem yeni yolu sayılır (ve kısmi klonda içerik indirilmez).
export const changedFiles = (base, head) => git('diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean);
export const commitMessages = (base, head) => git('log', '--format=%B', `${base}..${head}`);

export function ghApi(p) {
  const r = run('gh', ['api', '-H', 'Accept: application/vnd.github+json', p]);
  if (!r.ok) throw new Error(`gh api ${p}: ${r.err}`);
  return JSON.parse(r.out);
}

export function repoName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const r = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (!r.ok || !r.out) throw new Error(`depo adı okunamadı (gh repo view): ${r.err}`);
  return r.out;
}

// En yeni önce, en çok 100 koşu.
export function listRuns(repo, extra = '') {
  return ghApi(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=100${extra}`).workflow_runs ?? [];
}

const jobsCache = new Map();
export function runJobs(repo, id) {
  if (!jobsCache.has(id)) jobsCache.set(id, ghApi(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`).jobs ?? []);
  return jobsCache.get(id);
}

// Parçalı iş (veritabanı işi matrisi, KALANLAR 0.7) tek iş gibi toplanır: biri sürüyorsa sürüyor, biri sıradaysa sırada;
// hepsi bittiyse en kötü sonuç (kaldı > süre aşımı > iptal > atlandı > geçti). Adres en kötü parçanınki.
const RANK = ['failure', 'timed_out', 'cancelled', 'action_required', 'neutral', 'skipped', 'success'];
export function mergeJobs(all) {
  if (all.length <= 1) return all[0];
  const by = (pred) => all.find(pred);
  const live = by((j) => j.status === 'in_progress') ?? by((j) => j.status !== 'completed');
  const rank = (c) => (RANK.includes(c) ? RANK.indexOf(c) : RANK.length);
  const worst = [...all].sort((a, b) => rank(a.conclusion) - rank(b.conclusion))[0];
  const pick = live ?? worst;
  return { ...pick, status: live ? live.status : 'completed', conclusion: live ? null : worst.conclusion, shards: all };
}
export const findJob = (jobs, key) => mergeJobs(jobs.filter((j) => j.name.startsWith(JOBS[key])));

// Her iş için head'in kendisi ya da atası olan, işin sınandığı en yeni koşu. Önce head'in kendi koşuları bakılır.
// Dönen: { key: { sha, runId, url, status, conclusion } | null }
export function findBases({ repo, head, keys, runs, excludeRunId }) {
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  const ordered = [...runs.filter((r) => r.head_sha === head), ...runs.filter((r) => r.head_sha !== head)];
  for (const r of ordered) {
    if (keys.every((k) => out[k])) break;
    if (String(r.id) === String(excludeRunId)) continue;
    if (!isAncestor(r.head_sha, head)) continue;
    const jobs = runJobs(repo, r.id);
    for (const k of keys) {
      if (out[k]) continue;
      const j = findJob(jobs, k);
      if (j && counts(j)) out[k] = { sha: r.head_sha, runId: r.id, url: j.html_url ?? r.html_url, status: j.status, conclusion: j.conclusion };
    }
  }
  return out;
}

// Taban ile head arasında işin yollarına dokunan dosyalar ve [db] etiketi.
export function rangeInfo(key, base, head) {
  const files = changedFiles(base, head);
  const hits = relevantFiles(files, key);
  const tagged = key === 'db' && DB_TAG.test(commitMessages(base, head));
  return { files, hits, tagged };
}

// ---------------------------------------------------------------------------------------------------------------------
// Karar
// ---------------------------------------------------------------------------------------------------------------------

export function decide({ event, head, dbInput, repo, excludeRunId }) {
  const res = { db: { run: true, why: '' }, vision: { run: true, why: '' } };
  if (event === 'workflow_dispatch') {
    res.db = { run: dbInput !== 'false', why: `elle başlatıldı (db girdisi: ${dbInput || 'true'})` };
    res.vision.why = 'elle başlatıldı';
    return res;
  }
  const runs = listRuns(repo);
  const bases = findBases({ repo, head, keys: ['db', 'vision'], runs, excludeRunId });
  for (const key of ['db', 'vision']) {
    const b = bases[key];
    if (!b) { res[key] = { run: true, why: 'bu commit ya da atalarında işin sınandığı koşu yok' }; continue; }
    const { hits, tagged } = rangeInfo(key, b.sha, head);
    const from = `${b.sha.slice(0, 7)} (koşu ${b.runId}, ${b.status === 'in_progress' ? 'sürüyor' : b.conclusion})`;
    if (hits.length) res[key] = { run: true, why: `${from} sonrası ${hits.length} ilgili dosya: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ' …' : ''}` };
    else if (tagged) res[key] = { run: true, why: `${from} sonrası bir commit mesajında [db] var` };
    else res[key] = { run: false, why: `${from} sonrası ilgili değişiklik yok` };
  }
  // Kota kolu: gönderimin son commit'inde [db-sonra] varsa veritabanı işi bu gönderimde koşmaz. Atlanan iş sınanmış
  // sayılmadığı için sonraki gönderimin seçimi bu değişiklikleri de kapsar; main:ready o arada "hazır değil" der.
  if (event === 'push' && res.db.run) {
    const last = git('log', '-1', '--format=%B', head);
    if (DB_LATER.test(last) && !DB_TAG.test(last)) res.db = { run: false, why: `ertelendi ([db-sonra]); bekleyen: ${res.db.why}` };
  }
  return res;
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const env = process.env;
  const out = env.GITHUB_OUTPUT;
  let res;
  let head = '';
  try {
    head = git('rev-parse', `${args.find((a) => !a.startsWith('--')) ?? env.GITHUB_SHA ?? 'HEAD'}^{commit}`);
    res = decide({
      event: dry ? 'push' : env.GITHUB_EVENT_NAME ?? 'push',
      head,
      dbInput: env.SOD_DB_INPUT ?? '',
      repo: repoName(),
      excludeRunId: env.GITHUB_RUN_ID,
    });
  } catch (e) {
    // Güvenli taraf: karar verilemezse ağır işler koşar.
    const why = `seçim okunamadı, güvenli taraf (${String(e.message).split('\n')[0]})`;
    res = { db: { run: true, why }, vision: { run: true, why } };
  }
  const lines = [`commit ${head.slice(0, 7) || '?'}`, ...Object.entries(res).map(([k, v]) => `${k}: ${v.run ? 'KOŞAR' : 'koşmaz'}  ${v.why}`)];
  console.log(lines.join('\n'));
  if (dry || !out) return;
  appendFileSync(out, `db=${res.db.run}\nvision=${res.vision.run}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Ağır iş seçimi\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
