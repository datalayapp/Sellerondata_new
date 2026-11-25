#!/usr/bin/env node
// Son CI koşusu (KALANLAR 0.6): bu dalın ucundaki koşu, işlerin sonucu; kalan işte düşen testler ve ilk hata satırı.
// SALT OKUNUR: yalnız `gh api` ile okuma ve git okuma. Koşu başlatmaz, yeniden koşturmaz.
//
//   npm run ci:son                 yerel HEAD'in koşusu (yoksa dalın en son koşusu)
//   npm run ci:son -- --bekle      koşu bitene kadar bekler (20 sn arayla, en çok 45 dk)
//   npm run ci:son -- <sha|dal>    belirli commit ya da dal
// Çıkış: 0 yeşil, 1 kalan iş var, 2 okunamadı, 3 henüz bitmedi.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, ghApi, repoName, WORKFLOW } from './ci-select.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Kullanım: npm run ci:son -- [--bekle] [sha|dal]   Çıkış: 0 yeşil, 1 kalan var, 2 okunamadı, 3 bitmedi.');
  process.exit(0);
}
const wait = args.includes('--bekle');
const target = args.find((a) => !a.startsWith('-'));
const short = (s) => String(s ?? '').slice(0, 7);
const unreadable = (m) => { console.error(`OKUNAMADI: ${m}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (a, b) => {
  if (!a || !b) return '';
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  if (s < 0) return '';
  return s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${s % 60} sn`;
};

/** Ham günlükten: düşen test adları ve ilk hata satırı. Sınanabilsin diye dışa açık. */
export function digest(log) {
  // Satır başı: GitHub zaman damgası, renk kodları, özet adımındaki `grep -n` satır numarası.
  const lines = log
    .split(/\r?\n/)
    // eslint-disable-next-line no-control-regex -- renk kodu (ESC) silinir
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d+:(?=\S)/, ''));
  const tests = new Set();
  let annotation = null;
  for (const l of lines) {
    let m;
    // vitest GitHub bildirimi: ::error file=…,title=<dosya > grup > test>,line=…::<ileti>
    if ((m = l.match(/^::error (?:[^:]*?,)?title=(.+?)(?:,line=\d+)?(?:,column=\d+)?::(.*)$/))) {
      // GitHub bildirim kaçışları: %0A satır, %3A iki nokta, %2C virgül, %25 yüzde
      const un = (x) => x.replace(/%0D/g, '').replace(/%0A/g, '\n').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
      tests.add(un(m[1]).trim());
      annotation ??= un(m[2]).trim().split('\n')[0];
    } else if ((m = l.match(/^\s*FAIL\s+(\S.*\.(?:test|spec)\.[cm]?[jt]sx?(?:\s+>\s+.+)?)$/))) tests.add(m[1].trim());
    else if ((m = l.match(/^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?$/))) tests.add(m[1].trim());
    else if ((m = l.match(/^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/)) && !/failing tests:?$/.test(m[1])) tests.add(m[1].trim());
    else if ((m = l.match(/^not ok \d+ - (.+)$/))) tests.add(m[1].trim());
  }
  const errRe = /(error TS\d+|AssertionError|\bError:|^\s*\d+:\d+\s+error\s|HATA\b|ERR_|Expected|expected .+ to )/;
  const first = annotation ?? lines.find((l) => errRe.test(l) && !/^(##\[|::)/.test(l) && !/grep -nE/.test(l));
  // scripts/test.mjs özeti: "  <parça>   kaldı (çıkış kodu 1)  [11 dk]"
  const parts = [...new Set(lines.map((l) => l.match(/^\s{2}(\S+)\s+kaldı(\s.*)?$/)).filter(Boolean).map((m) => `${m[1]} kaldı${m[2] ?? ''}`.trim()))];
  return { tests: [...tests].slice(0, 30), first: first?.trim().slice(0, 300) ?? null, parts };
}

// Günlükte renk kodları var; yeni gh bunları ancak --allow-escape-sequences ile verir (eskisi bayrağı tanımaz).
function rawGh(p) {
  const call = (extra) => spawnSync('gh', ['api', ...extra, p], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  let r = call(['--allow-escape-sequences']);
  if (r.status !== 0 && /unknown flag/i.test(r.stderr ?? '')) r = call([]);
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || '').trim().split('\n')[0]);
  return r.stdout;
}

async function main() {
  let repo, branch, sha;
  try {
    repo = repoName();
    if (target && !/^[0-9a-f]{7,40}$/i.test(target)) branch = target;
    else if (target) sha = git('rev-parse', '--verify', `${target}^{commit}`);
    else {
      branch = git('rev-parse', '--abbrev-ref', 'HEAD');
      sha = git('rev-parse', 'HEAD');
    }
  } catch (e) {
    unreadable(String(e.message).split('\n')[0]);
  }
  const deadline = Date.now() + 45 * 60 * 1000;
  let run;
  let nightly = null;
  let noted = false;
  for (;;) {
    try {
      const api = (q) => ghApi(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=20&${q}`).workflow_runs ?? [];
      // Gece koşusu (schedule) yalnız e2e içerir: ana sonuç gönderim ya da elle koşudan, gece koşusu ayrı satırda.
      const notNightly = (rs) => rs.find((r) => r.event !== 'schedule');
      const branchRuns = branch ? api(`branch=${encodeURIComponent(branch)}`) : [];
      nightly = branchRuns.find((r) => r.event === 'schedule') ?? null;
      run = sha ? notNightly(api(`head_sha=${sha}`)) : notNightly(branchRuns);
      if (!run && sha && branch) {
        const latest = notNightly(branchRuns);
        if (!latest) unreadable(`${branch} dalında koşu yok`);
        if (!noted) console.log(`HEAD ${short(sha)} için CI koşusu yok (gönderilmedi ya da yalnız not/belge değişti). Dalın en son koşusu: ${short(latest.head_sha)}`);
        noted = true;
        run = latest;
      }
      if (!run) unreadable(`koşu bulunamadı (${sha ? short(sha) : branch})`);
    } catch (e) {
      unreadable(String(e.message).split('\n')[0]);
    }
    if (run.status === 'completed' || !wait || Date.now() > deadline) break;
    process.stdout.write(`bekleniyor: koşu ${run.id} ${run.status}…\n`);
    await sleep(20000);
  }

  const subject = String(run.display_title ?? '').split('\n')[0];
  console.log(`Koşu ${run.id}  ${short(run.head_sha)} ${run.head_branch}  ${subject.length > 80 ? subject.slice(0, 80) + '…' : subject}`);
  console.log(`  ${run.status === 'completed' ? run.conclusion : run.status}  ${run.html_url}`);
  let jobs;
  try {
    jobs = ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
  } catch (e) {
    unreadable(String(e.message).split('\n')[0]);
  }
  const red = [];
  for (const j of jobs) {
    const state = j.status === 'completed' ? j.conclusion : j.status;
    console.log(`  ${String(state).padEnd(11)} ${j.name}${j.completed_at ? `  [${dur(j.started_at, j.completed_at)}]` : ''}`);
    if (j.status === 'completed' && (j.conclusion === 'failure' || j.conclusion === 'timed_out')) red.push(j);
  }
  for (const j of red) {
    console.log(`\n== ${j.name}  ${j.html_url}`);
    const step = (j.steps ?? []).find((s) => s.conclusion === 'failure');
    if (step) console.log(`  kalan adım: ${step.name}`);
    let d;
    try {
      d = digest(rawGh(`repos/${repo}/actions/jobs/${j.id}/logs`));
    } catch (e) {
      console.log(`  günlük okunamadı: ${String(e.message)}`);
      continue;
    }
    if (d.parts.length) console.log(`  kalan parçalar: ${[...new Set(d.parts)].join('; ')}`);
    if (d.tests.length) {
      console.log('  düşen testler:');
      for (const t of d.tests) console.log(`    ${t}`);
    }
    console.log(`  ilk hata satırı: ${d.first ?? '(bulunamadı; günlüğe bakın)'}`);
  }
  if (nightly) {
    const e2e = nightly.status === 'completed' ? nightly.conclusion : nightly.status;
    console.log(`\nGece e2e: ${e2e}  ${short(nightly.head_sha)} ${String(nightly.created_at).slice(0, 10)}  ${nightly.html_url}`);
  }
  if (run.status !== 'completed') { console.log('\nSONUÇ: henüz bitmedi'); return 3; }
  if (red.length || run.conclusion === 'failure') { console.log(`\nSONUÇ: KIRMIZI (${red.length} iş)`); return 1; }
  console.log(`\nSONUÇ: ${run.conclusion === 'success' ? 'yeşil' : run.conclusion}`);
  return run.conclusion === 'success' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(await main());
