// Sunucu betiklerinin (guncelle.sh, kurulum.sh) testleri için ortak ortam: Git Bash bulma, geçici git deposu (uzak depo +
// etiketli sürümler), taklit docker ve curl, betiği taklit PATH ile koşma. Docker, ağ ve sunucu istemez.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM = path.resolve(HERE, '..', '..', '..');
export const posix = (p) => p.replace(/\\/g, '/');

/** Windows'ta System32\bash.exe (WSL) değil Git Bash: git'in kurulu olduğu klasörden. */
export function findBash() {
  if (process.env.SOD_BASH) return process.env.SOD_BASH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (r.status === 0) candidates.push(path.resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'));
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find((c) => existsSync(c));
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@ornek.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@ornek.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=ana', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(root, rel, body) {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, body);
}

const SCRIPTS = ['guncelle.sh', 'kurulum.sh', 'ayakta-mi.sh', 'yedek-kap.sh'];

/**
 * Geçici kök: bin/ (taklit docker, curl), uzak depo origin.git ve dört etiketli sürüm:
 * v1 temel, v2 göçsüz değişiklik, v3 DeciShip göçü ekler, v4 araç kaydını (rol varsayılanları) değiştirir.
 */
export function setupRoot(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  // Linux'ta (CI) PATH'teki taklit ancak çalıştırma izniyle bulunur; depoda 644 olabilir.
  for (const name of ['docker', 'curl']) {
    copyFileSync(path.join(HERE, name), path.join(bin, name));
    chmodSync(path.join(bin, name), 0o755);
  }
  const src = path.join(root, 'kaynak');
  mkdirSync(src);
  git(src, 'init', '-q');
  mkdirSync(path.join(src, 'Platform', 'scripts'), { recursive: true });
  for (const s of SCRIPTS) {
    const from = path.join(PLATFORM, 'scripts', s);
    if (existsSync(from)) copyFileSync(from, path.join(src, 'Platform', 'scripts', s));
  }
  put(src, 'Platform/gateway/conf/products/deciship.conf', 'location = /api/deciship/health {\n  return 200;\n}\n');
  put(src, 'Platform/docker-compose.yml', 'name: sellerondata\n');
  put(src, 'Platform/.gitignore', '.env\nyedekler/\nkeys/\n');
  put(src, 'Platform/packages/contracts/src/products.ts', 'export const ROLES = 1;\n');
  put(src, 'README.md', 'v1\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'v1');
  git(src, 'tag', 'v1');
  put(src, 'README.md', 'v2\n');
  git(src, 'commit', '-q', '-am', 'v2');
  git(src, 'tag', 'v2');
  put(src, 'Deciship/apps/api/prisma/migrations/20261120000000_yeni/migration.sql', 'ALTER TABLE x ADD COLUMN y int;\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'v3');
  git(src, 'tag', 'v3');
  put(src, 'Platform/packages/contracts/src/products.ts', 'export const ROLES = 2;\n');
  git(src, 'commit', '-q', '-am', 'v4');
  git(src, 'tag', 'v4');
  const origin = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', src, origin);
  const sha = Object.fromEntries(['v1', 'v2', 'v3', 'v4'].map((t) => [t, git(src, 'rev-parse', '--short=7', t)]));
  return { root, bin, origin, sha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Uzak depodan çalışma kopyası, istenen sürümde (ayrık HEAD), artı taklit durum klasörü. */
export function workTree(env, name, at = 'v1') {
  const repo = path.join(env.root, name);
  git(env.root, 'clone', '-q', env.origin, repo);
  git(repo, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', at);
  const fake = path.join(env.root, `${name}-taklit`);
  mkdirSync(fake);
  return { repo, platform: path.join(repo, 'Platform'), fake };
}

/** Betiği taklit PATH ile koşar (eşzamansız: testler paralel koşabilsin). */
export function runScript(env, wt, script, args = [], extraEnv = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      findBash(),
      ['-c', 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash "$SCRIPT" "$@"', 'bash', ...args],
      {
        env: {
          ...process.env,
          ...GIT_ENV,
          FAKE_BIN: posix(env.bin),
          FAKE: posix(wt.fake),
          FAKE_REPO: posix(wt.repo),
          SCRIPT: posix(path.join(wt.platform, 'scripts', script)),
          ...extraEnv,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: stdout + stderr, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
