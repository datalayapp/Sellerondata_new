// node --test scripts/ayakta-mi.test.mjs  (Platform klasöründen; Docker, ağ ve sunucu istemez)
// "Ayakta mı" denetimi (scripts/ayakta-mi.sh): curl, docker ve df yerine taklit komutlar konur, yedek klasörü geçici dizinde
// kurulur; her durumda çıkış kodu ve satırlar denetlenir. Windows'ta Git Bash ile, başka sistemde bash ile koşar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ayakta-mi.sh');
const posix = (p) => p.replace(/\\/g, '/');

/** Windows'ta System32\bash.exe (WSL) değil Git Bash: git'in kurulu olduğu klasörden. */
function findBash() {
  if (process.env.SOD_BASH) return process.env.SOD_BASH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (r.status === 0) candidates.push(path.resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'));
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find((c) => existsSync(c));
}

const BASH = findBash();
let dir;
let bin;

// Taklit komutlar: yanıtları $FAKE altındaki dosyalardan okur.
const SHIMS = {
  // curl ... <adres>: curl.txt "adres kod"; bilinmeyen adres bağlantı hatası (000).
  curl: `#!/usr/bin/env bash
url="\${@: -1}"
code=$(awk -v u="$url" '$1 == u { print $2; exit }' "$FAKE/curl.txt" 2>/dev/null)
printf '%s' "\${code:-000}"
[ -n "$code" ] || exit 7
`,
  // docker ps ...: docker-ps.txt içeriği; docker-fail varsa erişim hatası.
  docker: `#!/usr/bin/env bash
if [ -f "$FAKE/docker-fail" ]; then echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; fi
cat "$FAKE/docker-ps.txt" 2>/dev/null
`,
  // df -Pk <yol>: df.txt "yol yüzde boşKB"; dosya sistemi adı bilerek boşluklu.
  df: `#!/usr/bin/env bash
p="\${@: -1}"
read -r pct avail < <(awk -v p="$p" '$1 == p { print $2, $3; exit }' "$FAKE/df.txt")
[ -n "$pct" ] || { echo "df: $p: yok" >&2; exit 1; }
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "C:/Program Files/Git 100000000 1 $avail $pct% /"
`,
};

before(() => {
  assert.ok(BASH, 'bash bulunamadı (Windows: Git for Windows kurulu olmalı; SOD_BASH ile yol verilebilir)');
  dir = mkdtempSync(path.join(os.tmpdir(), 'ayakta-mi-'));
  bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(SHIMS)) writeFileSync(path.join(bin, name), body, { mode: 0o755 });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3600 * 1000;
const BASE = 'http://gw.test';
const SITE = 'http://site.test/';
// Araçların sağlık uçları gateway araç dosyalarından (betikle aynı kaynak); yeni araç eklenince taklit yanıtlar da gelir.
const PRODUCTS_DIR = path.join(HERE, '..', 'gateway', 'conf', 'products');
// default.conf'taki uçlar da taranır (ai geçidi orada: /api/ai/health); betik de aynı dosyaları okur.
const DEFAULT_HEALTH = [...readFileSync(path.join(PRODUCTS_DIR, '..', 'default.conf'), 'utf8').matchAll(/^\s*location = (\/api\/[a-z0-9-]*\/health) \{/gm)].map((m) => m[1]);
const PRODUCT_HEALTH = readdirSync(PRODUCTS_DIR)
  .filter((f) => f.endsWith('.conf'))
  .sort()
  .flatMap((f) => [...readFileSync(path.join(PRODUCTS_DIR, f), 'utf8').matchAll(/^\s*location = (\/api\/[a-z0-9-]*\/health) \{/gm)].map((m) => m[1]));
const HEALTH_PATHS = ['/healthz', ...DEFAULT_HEALTH, ...PRODUCT_HEALTH];
const ALL_OK = [...HEALTH_PATHS.map((p) => `${BASE}${p} 200`), `${SITE} 200`];
const PS_OK = [
  'postgres|running|Up 2 hours (healthy)',
  'postgres-upgrade|exited|Exited (0) 2 hours ago',
  'account-migrate|exited|Exited (0) 2 hours ago',
  'account-api|running|Up 2 hours (healthy)',
  'deciship-api|running|Up 2 hours (healthy)',
  'vision|running|Up 2 hours (healthy)',
  'tagpress-migrate|exited|Exited (0) 2 hours ago',
  'tagpress-api|running|Up 2 hours (healthy)',
  'tagpress-web|running|Up 2 hours (healthy)',
  'gateway|running|Up 2 hours (health: starting)',
];

/**
 * Bir durumu kurar ve betiği koşar. backups: [{ name, ageHours }] klasörleri (yedek.json ile); status: son-yedek.json.
 */
function run(
  name,
  {
    curl = ALL_OK,
    ps = PS_OK,
    dockerFail = false,
    df = null,
    backups = [{ name: '2026-11-16_0300', ageHours: 3 }],
    status = { kod: 0, ageHours: 3 },
    env = {},
  } = {},
) {
  const fake = path.join(dir, name);
  const backupDir = path.join(fake, 'yedekler');
  mkdirSync(backupDir, { recursive: true });
  const diskPath = posix(backupDir);
  writeFileSync(path.join(fake, 'curl.txt'), curl.join('\n') + '\n');
  if (ps !== null) writeFileSync(path.join(fake, 'docker-ps.txt'), ps.length ? ps.join('\n') + '\n' : '');
  if (dockerFail) writeFileSync(path.join(fake, 'docker-fail'), '');
  writeFileSync(
    path.join(fake, 'df.txt'),
    `${diskPath} ${(df ?? { pct: 40, availKb: 50 * 1024 * 1024 }).pct} ${(df ?? { availKb: 50 * 1024 * 1024 }).availKb}\n`,
  );
  const now = Date.now();
  for (const b of backups) {
    const d = path.join(backupDir, b.name);
    mkdirSync(d, { recursive: true });
    const f = path.join(d, 'yedek.json');
    writeFileSync(f, '{}');
    const t = new Date(now - b.ageHours * HOUR);
    utimesSync(f, t, t);
  }
  if (status) {
    const f = path.join(backupDir, 'son-yedek.json');
    // yedekle.ps1 (PowerShell 5.1 ConvertTo-Json) biçimi: iki boşluklu ayırıcı, BOM ve CRLF olabilir.
    writeFileSync(
      f,
      `\uFEFF{\r\n    "zaman":  "2026-11-16T03:00:00+03:00",\r\n    "kod":  ${status.kod},\r\n    "ozet":  "${status.ozet ?? 'yerel tamam'}"\r\n}\r\n`,
    );
    const t = new Date(now - status.ageHours * HOUR);
    utimesSync(f, t, t);
  }
  const r = spawnSync(BASH, ['-c', 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash "$SCRIPT"'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_BIN: posix(bin),
      FAKE: posix(fake),
      SCRIPT: posix(SCRIPT),
      SOD_CHECK_URL: BASE,
      SOD_CHECK_SITE_URL: SITE,
      SOD_DISK_PATHS: diskPath,
      SOD_BACKUP_DIR: diskPath,
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean), fake };
}

const has = (r, re) =>
  assert.ok(
    r.lines.some((l) => re.test(l)),
    `satır yok: ${re}\n${r.out}${r.err}`,
  );
const hasNot = (r, re) => assert.ok(!r.lines.some((l) => re.test(l)), `beklenmeyen satır: ${re}\n${r.out}`);

test('her şey yolunda: çıkış 0; sağlık uçları araç kaydından bulunur, tek seferlik kaplar ve açılan kap sorun değil', () => {
  // Kayıttaki araçlar en az bunlar: biri araç dosyasından düşerse denetim sessizce eksilmesin.
  for (const p of ['/api/account/health', '/api/ai/health', '/api/deciship/health', '/api/tagpress/health']) assert.ok(HEALTH_PATHS.includes(p), `${p} gateway araç dosyalarında yok`);
  const r = run('tamam');
  assert.equal(r.code, 0, r.out + r.err);
  for (const p of HEALTH_PATHS) has(r, new RegExp(`^\\S+ TAMAM sağlık ${p.replace(/\//g, '\\/')}$`));
  has(r, /TAMAM site$/);
  has(r, /TAMAM kaplar: 10 kap, sorun yok/);
  has(r, /TAMAM disk .*: %40 dolu, boş 51200 MB$/);
  has(r, /TAMAM yedek: son başarılı yedek 3 saat önce/);
  has(r, /SONUC sorun yok \(\d+ tamam, 0 atlandı\)$/);
  hasNot(r, /SORUN/);
});

test('sorunlar: düşen sağlık ucu, sağlıksız ya da durmuş kap, hatalı göç, dolu disk, eski yedek ve hatalı son deneme; çıkış 1', () => {
  const r = run('sorunlu', {
    curl: [`${BASE}/healthz 200`, `${BASE}/api/account/health 200`, `${BASE}/api/ai/health 503`, `${BASE}/api/deciship/health 502`, `${BASE}/api/tagpress/health 503`],
    ps: [
      'postgres|running|Up 3 days (healthy)',
      'account-migrate|exited|Exited (1) 3 days ago',
      'deciship-api|running|Up 3 days (unhealthy)',
      'vision|exited|Exited (137) 1 hour ago',
      'account-api|restarting|Restarting (1) 5 seconds ago',
      'tagpress-migrate|exited|Exited (0) 3 days ago',
      'tagpress-web|running|Up 3 days (unhealthy)',
    ],
    df: { pct: 91, availKb: 40 * 1024 * 1024 },
    backups: [{ name: '2026-11-13_0300', ageHours: 72 }],
    status: { kod: 1, ageHours: 2, ozet: 'yedek alınamadı: veritabanı kapalı' },
  });
  assert.equal(r.code, 1, r.out + r.err);
  has(r, /SORUN sağlık \/api\/ai\/health: yanıt 503 /);
  has(r, /SORUN sağlık \/api\/deciship\/health: yanıt 502 /);
  has(r, /SORUN sağlık \/api\/tagpress\/health: yanıt 503 /);
  has(r, /SORUN site: yanıt 000 /);
  has(r, /SORUN kap account-migrate: Exited \(1\)/);
  has(r, /SORUN kap deciship-api: sağlıksız/);
  has(r, /SORUN kap vision: exited/);
  has(r, /SORUN kap account-api: restarting/);
  has(r, /SORUN kap tagpress-web: sağlıksız/);
  hasNot(r, /kap postgres/);
  hasNot(r, /kap tagpress-migrate/);
  has(r, /SORUN disk .*: %91 dolu/);
  has(r, /SORUN yedek: son deneme hatalı \(kod 1: yedek alınamadı: veritabanı kapalı\)/);
  // Hatalı son deneme başarı sayılmaz: yaş eski klasörden.
  has(r, /SORUN yedek: son başarılı yedek 72 saat önce \(2026-11-13_0300; sınır 36 saat\)/);
  // 9 eski sorun + TagPress sağlık ucu (503) + sağlıksız tagpress-web kabı + ai sağlık ucu (503); tamam: /healthz ve /api/account/health.
  has(r, /SONUC 12 sorun, 2 tamam, 0 atlandı$/);
});

test('disk: yüzde sınırın altında olsa da boş yer azsa sorun', () => {
  const r = run('az-yer', { df: { pct: 50, availKb: 2 * 1024 * 1024 } });
  assert.equal(r.code, 1);
  has(r, /SORUN disk .*: %50 dolu, boş 2048 MB \(sınır %85, en az 5120 MB\)/);
});

test('yedek: hiç yoksa sorun; yarım kalan (.yaziliyor) ve adı tutmayan klasör sayılmaz; son-yedek.json kod 0 da başarıdır', () => {
  const none = run('yedek-yok', {
    backups: [
      { name: '2026-11-16_0400.yaziliyor', ageHours: 1 },
      { name: 'gunluk', ageHours: 1 },
    ],
    status: null,
  });
  assert.equal(none.code, 1);
  has(none, /SORUN yedek: başarılı yedek bulunamadı/);
  const statusOnly = run('yalniz-durum', { backups: [], status: { kod: 0, ageHours: 5 } });
  assert.equal(statusOnly.code, 0, statusOnly.out);
  has(statusOnly, /TAMAM yedek: son başarılı yedek 5 saat önce \(son-yedek.json\)/);
  const suffixed = run('ekli-ad', { backups: [{ name: '2026-11-16_0300-2', ageHours: 1 }], status: null });
  has(suffixed, /TAMAM yedek: son başarılı yedek 1 saat önce \(2026-11-16_0300-2\)/);
  // Kod 2 (yerel tamam ama dış kopya yok) de sorun: Windows'taki `yedek-zamanla.ps1 durum` gibi.
  const warn = run('uyari', { status: { kod: 2, ageHours: 1, ozet: 'dış kopya alınamadı' } });
  assert.equal(warn.code, 1);
  has(warn, /SORUN yedek: son deneme hatalı \(kod 2: dış kopya alınamadı\)/);
});

test('kaplar: proje boşsa sorun (sistem kapalı); docker erişilemezse ya da kapalıysa adım atlanır, çıkışı bozmaz', () => {
  const empty = run('kap-yok', { ps: [] });
  assert.equal(empty.code, 1);
  has(empty, /SORUN kaplar: 'sellerondata' projesinde kap yok/);
  const denied = run('docker-erisim', { dockerFail: true });
  assert.equal(denied.code, 0, denied.out);
  has(denied, /ATLANDI kaplar: docker'a erişilemedi \(permission denied/);
  const off = run('docker-kapali', { env: { SOD_COMPOSE_PROJECT: 'off', SOD_CHECK_SITE_URL: 'off', SOD_BACKUP_MAX_AGE_HOURS: '0' } });
  assert.equal(off.code, 0, off.out);
  has(off, /ATLANDI kaplar: SOD_COMPOSE_PROJECT=off/);
  has(off, /ATLANDI site: SOD_CHECK_SITE_URL=off/);
  has(off, /ATLANDI yedek: SOD_BACKUP_MAX_AGE_HOURS=0/);
  has(off, /SONUC sorun yok \(\d+ tamam, 3 atlandı\)$/);
});

test('günlük dosyası: SOD_CHECK_LOG verilince satırlar eklenir; geçersiz ayar çıkış 2', () => {
  const r1 = run('gunluk', { env: { SOD_CHECK_LOG: '' } });
  const log = posix(path.join(r1.fake, 'ayakta-mi.log'));
  run('gunluk', { env: { SOD_CHECK_LOG: log } });
  run('gunluk', { env: { SOD_CHECK_LOG: log } });
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.filter((l) => / SONUC /.test(l)).length, 2, 'iki çalıştırmanın özeti günlükte değil');
  const bad = run('gecersiz', { env: { SOD_DISK_MAX_PCT: 'yuzde' } });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /SOD_DISK_MAX_PCT sayı olmalı: .yuzde./);
});

test('ek sağlık yolları ve sonda eğik çizgili adres', () => {
  const r = run('ek-yol', {
    curl: [...ALL_OK, `${BASE}/api/orderloom/health 503`],
    env: { SOD_CHECK_URL: `${BASE}/`, SOD_CHECK_EXTRA_PATHS: '/api/orderloom/health' },
  });
  assert.equal(r.code, 1);
  has(r, /TAMAM sağlık \/healthz$/);
  has(r, /SORUN sağlık \/api\/orderloom\/health: yanıt 503 \(http:\/\/gw\.test\/api\/orderloom\/health\)/);
});
