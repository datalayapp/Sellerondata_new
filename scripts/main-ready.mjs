#!/usr/bin/env node
// main'e birleştirmeden önce (15-B9): o commit'te CI'nın hızlı işi ve veritabanı işi yeşil mi.
// SALT OKUNUR: yalnız `gh api` ile okuma ve git okuma. Koşu başlatmaz, yeniden koşturmaz, birleştirmez, fetch etmez.
//
//   node scripts/main-ready.mjs [sha|ref]   varsayılan: uzaktaki gelistirme ucu (GitHub'dan okunur)
//   npm run main:ready -- [sha|ref]
//
// Veritabanı işi o commit'te atlandıysa (yol süzgeci) en yakın önceki sınanmış koşuya bakar ve aradaki commit'lerin
// veritabanı yollarına dokunup dokunmadığını söyler (kural ve yollar: scripts/ci-select.mjs).
// Çıkış: 0 hazır, 1 hazır değil, 2 okunamadı.
import {
  JOBS, IGNORE_PATHS, git, hasCommit, ghApi, repoName, listRuns, runJobs, findJob, findBases, rangeInfo, changedFiles, matchesAny,
} from './ci-select.mjs';

const STUCK_MIN = 15; // bu kadar dakikadır iş almayan koşu "iş almadı" sayılır
const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']);
const short = (s) => String(s).slice(0, 7);
const ageMin = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60000);
const fmtAge = (m) => (m < 120 ? `${m} dk` : `${Math.round(m / 60)} sa`);

function unreadable(msg) {
  console.error(`OKUNAMADI: ${msg}`);
  process.exit(2);
}

const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Kullanım: node scripts/main-ready.mjs [sha|ref]   (varsayılan: uzaktaki gelistirme ucu). Salt okunur.\nÇıkış: 0 hazır, 1 hazır değil, 2 okunamadı.');
  process.exit(0);
}

let repo, sha, label, runs;
try {
  repo = repoName();
  if (arg) {
    sha = git('rev-parse', '--verify', `${arg}^{commit}`);
    label = arg;
  } else {
    sha = ghApi(`repos/${repo}/branches/gelistirme`).commit.sha;
    label = 'uzaktaki gelistirme ucu';
  }
} catch (e) {
  unreadable(String(e.message).split('\n')[0]);
}
if (!hasCommit(sha)) unreadable(`${short(sha)} bu bilgisayardaki depoda yok; önce \`git fetch origin\` (bu betik fetch etmez).`);
try {
  runs = listRuns(repo);
  if (!runs.some((r) => r.head_sha === sha)) {
    const ids = new Set(runs.map((r) => r.id));
    runs = [...listRuns(repo, `&head_sha=${sha}`).filter((r) => !ids.has(r.id)), ...runs];
  }
} catch (e) {
  unreadable(String(e.message).split('\n')[0]);
}

const problems = [];
const lines = [];
const say = (s = '') => lines.push(s);

try {
  const subject = git('log', '-1', '--format=%s', sha);
  say(`Commit: ${short(sha)} (${label})  ${subject.length > 90 ? subject.slice(0, 90) + '…' : subject}`);
  let local = '';
  try { local = git('rev-parse', 'origin/gelistirme'); } catch { /* yerel izleme dalı yok */ }
  if (!arg && local && local !== sha) say(`  Not: yerel origin/gelistirme ${short(local)}, uzaktaki ${short(sha)} (yerel kopya eski olabilir).`);

  // İş almayan koşular (15-B12: "queued" kalıp hiç başlamayan).
  const stuck = runs.filter((r) => WAITING.has(r.status) && ageMin(r.created_at) >= STUCK_MIN);
  if (stuck.length) {
    say(`\nİş almayan koşular (${STUCK_MIN} dk'dan uzun süredir sırada):`);
    for (const r of stuck) say(`  ${short(r.head_sha)} ${r.head_branch} ${r.event}  ${fmtAge(ageMin(r.created_at))} önce açıldı, durum ${r.status}  ${r.html_url}`);
    if (stuck.some((r) => r.head_sha === sha)) problems.push('bu commit\'in koşusu iş almadan sırada bekliyor');
  }

  // Hızlı iş: commit'in kendi koşusu; yoksa (yalnız belge değiştiyse CI koşmaz) en yakın koşulu ata bakılır.
  say('\nHızlı iş (denetim, lint, tip denetimi, birim testler):');
  let eff = sha;
  if (!runs.some((r) => r.head_sha === sha)) {
    const anc = git('rev-list', '--max-count=300', sha).split('\n').filter(Boolean);
    const withRun = anc.find((c) => runs.some((r) => r.head_sha === c));
    if (!withRun) {
      eff = null;
      problems.push('hızlı iş: bu commit ve yakın atalarında CI koşusu bulunamadı');
      say('  koşu bulunamadı');
    } else {
      const code = changedFiles(withRun, sha).filter((f) => !matchesAny(f, IGNORE_PATHS));
      if (code.length) {
        eff = null;
        problems.push(`hızlı iş: bu commit için koşu yok, ama ${short(withRun)} sonrası kod değişti (${code.length} dosya, ör. ${code[0]})`);
        say(`  koşu yok; ${short(withRun)} sonrası ${code.length} kod dosyası değişti`);
      } else {
        eff = withRun;
        say(`  bu commit için koşu yok (yalnız not/belge değişti); ${short(withRun)} koşusuna bakılıyor`);
      }
    }
  }
  if (eff) {
    const atEff = runs.filter((r) => r.head_sha === eff);
    const found = [];
    for (const r of atEff) {
      const j = findJob(runJobs(repo, r.id), 'hizli');
      if (j) found.push({ r, j });
    }
    const done = found.find(({ j }) => j.status === 'completed' && j.conclusion !== 'cancelled' && j.conclusion !== 'skipped');
    const live = found.find(({ j }) => j.status !== 'completed');
    if (done && done.j.conclusion === 'success') say(`  geçti  ${done.j.html_url}`);
    else if (done) { problems.push(`hızlı iş: ${done.j.conclusion}`); say(`  ${done.j.conclusion}  ${done.j.html_url}`); }
    else if (live) { problems.push(`hızlı iş: henüz bitmedi (${live.j.status})`); say(`  ${live.j.status}  ${live.j.html_url}`); }
    else {
      const any = found[0];
      problems.push(`hızlı iş: sonuç yok${any ? ` (${any.j.conclusion})` : ''}`);
      say(`  sonuç yok${any ? `: ${any.j.conclusion} ${any.j.html_url}` : ''}`);
    }
  }

  // Veritabanı işi ve görüntü servisi: en yakın sınanmış koşu ve sonrasındaki değişiklikler.
  const bases = findBases({ repo, head: sha, keys: ['db', 'vision'], runs });
  for (const key of ['db', 'vision']) {
    const gate = key === 'db';
    const title = gate ? 'Veritabanı işi (para, yetki, RLS)' : 'Görüntü servisi (bilgi; birleştirmeyi engellemez)';
    say(`\n${title}:`);
    const flag = (msg) => { if (gate) problems.push(`veritabanı işi: ${msg}`); };
    // Bu commit'teki iş sırada mı?
    for (const r of runs.filter((x) => x.head_sha === sha)) {
      const j = findJob(runJobs(repo, r.id), key);
      if (j && WAITING.has(j.status)) say(`  bu commit'te sırada bekliyor (${j.status})  ${j.html_url}`);
      else if (j && j.status === 'completed' && (j.conclusion === 'skipped' || j.conclusion === 'cancelled')) say(`  bu commit'te ${j.conclusion === 'skipped' ? 'atlandı' : 'iptal edildi'} (koşu ${r.id})`);
    }
    const b = bases[key];
    if (!b) { flag('bu commit ve atalarında hiç sınanmamış'); say('  sınanmış koşu bulunamadı'); continue; }
    const where = b.sha === sha ? 'bu commit\'te' : `${short(b.sha)} commit'inde`;
    if (b.status === 'in_progress') { flag(`${where} sürüyor`); say(`  ${where} sürüyor  ${b.url}`); continue; }
    if (b.conclusion !== 'success') { flag(`${where} kaldı`); say(`  ${where} KALDI  ${b.url}`); continue; }
    if (b.sha === sha) { say(`  bu commit'te geçti  ${b.url}`); continue; }
    const n = git('rev-list', '--count', `${b.sha}..${sha}`);
    const { hits, tagged } = rangeInfo(key, b.sha, sha);
    say(`  ${short(b.sha)} commit'inde geçti  ${b.url}`);
    if (hits.length) {
      flag(`${short(b.sha)} sonrası ${hits.length} ilgili dosya değişti ve iş bunlarla koşmadı`);
      say(`  aradaki ${n} commit'te ${hits.length} ilgili dosya değişti; iş bu değişikliklerle koşmadı:`);
      for (const f of hits.slice(0, 15)) say(`    ${f}`);
      if (hits.length > 15) say(`    … ${hits.length - 15} dosya daha`);
    } else if (tagged) {
      flag(`${short(b.sha)} sonrası bir commit [db] istedi ama iş koşmadı`);
      say(`  aradaki ${n} commit'ten biri [db] istedi ama iş koşmadı`);
    } else say(`  aradaki ${n} commit ilgili yollara dokunmuyor: sonuç geçerli`);
  }
} catch (e) {
  console.log(lines.join('\n'));
  unreadable(String(e.message).split('\n')[0]);
}

say(problems.length ? `\nSONUÇ: HAZIR DEĞİL\n${problems.map((p) => `  - ${p}`).join('\n')}` : '\nSONUÇ: HAZIR (hızlı iş ve veritabanı işi yeşil)');
say(`(İş adları: ${JOBS.hizli}…, ${JOBS.db}…; bu betik yalnız okur.)`);
console.log(lines.join('\n'));
process.exit(problems.length ? 1 : 0);
