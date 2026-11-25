// Derlenmiş komut girişleri gerçekten çalışır mı (veritabanı gerekmez). `npm run test:cli` ya da kökten `npm run t -- <bu dosya>`.
// Vitest değil `node --test`: vitest'in globalSetup'ı veritabanı ister.
//
// Neden: tsup bölmesinde (splitting) başka bir girişin de içe aktardığı modülün gövdesi ortak parçaya taşınır. Giriş dosyası
// yalnız dışa aktarım yapar, "ana dosya mı" denetimi (`import.meta`) parçayı gösterir ve komut hiçbir şey yapmadan 0 ile biter
// (Hesap servisinde `node dist/seed.js` böyle sessizce "başarılı" bitiyordu). Kural src/bin/runCli.ts'te.
//
// Denetim iki katlı: (1) her komut girişinin kendi kaynağı kendi çıktı dosyasında durur (esbuild modül yorumu), (2) her giriş
// çalıştırılınca ana işini yapar: veritabanına gitmeden duran bir yol (kullanım hatası, üretim kilidi) verir. Hiçbir şey yapmadan
// 0 ile biten giriş burada kırılır. Yeni giriş eklenince aşağıya yoklaması yazılır.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const API_ROOT = path.resolve(import.meta.dirname, '..');
// node_modules içinde: derlenen dosyalar dış paketleri buradan bulur. dist/'e (imaj, duman testi) dokunmaz.
const OUT = path.join(API_ROOT, 'node_modules', '.cache', `cli-entries-${process.pid}`);
const TSUP = path.join(API_ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');

/**
 * Komut olmayan girişler. main: sunucu. fileWorker: API'nin çocuk süreci; gövdesi bilerek ortak parçadadır (satır içi kipte main
 * de içe aktarır) ve "ana dosya mı" yerine argv işaretine bakar. Derlenmiş hâli Dockerfile'daki duman testinde denenir.
 */
const NOT_COMMANDS = new Set(['main', 'fileWorker']);

/** Giriş adı -> çalıştırma. `code`: beklenen çıkış; `out`: stdout+stderr içinde aranan. */
const PROBES = {
  seed: { args: [], env: { NODE_ENV: 'production' }, code: 1, out: /tohumu üretimde çalışmaz/ },
  seedDemoDisputes: { args: [], env: { NODE_ENV: 'production' }, code: 1, out: /tohumu üretimde çalışmaz/ },
  aiUsage: { args: [], code: 2, out: /ai:usage/ },
  'cli/reminders': { args: ['--bilinmeyen'], code: 2, out: /unknown argument/ },
  'cli/storageOrphans': { args: ['--bilinmeyen'], code: 2, out: /unknown argument/ },
  'cli/purgePreview': { args: ['--bilinmeyen'], code: 2, out: /unknown argument/ },
  // İş çalıştırıcı (KALANLAR 6.17): üretim kilidi veritabanından önce durur. Gerçek çalışması test/workerEntry.test.ts (veritabanlı).
  worker: { args: [], env: { NODE_ENV: 'production', ENABLE_DATA_RESET: 'true' }, code: 1, out: /zorunlu ayarlar eksik.*ENABLE_DATA_RESET/ },
};

let entries = {};

function run(name, args, env = {}) {
  return spawnSync(process.execPath, [path.join(OUT, `${name}.js`), ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgresql://sod:sod@127.0.0.1:1/yok', ...env },
  });
}

describe('derlenmiş komut girişleri', () => {
  before(async () => {
    entries = (await import(new URL('../tsup.config.ts', import.meta.url).href)).default.entry;
    const build = spawnSync(process.execPath, [TSUP, '--out-dir', OUT, '--no-sourcemap'], { cwd: API_ROOT, encoding: 'utf8', timeout: 180_000 });
    assert.equal(build.status, 0, `tsup: ${build.stdout}\n${build.stderr}`);
  });
  after(() => fs.rmSync(OUT, { recursive: true, force: true }));

  it('her komut girişinin yoklaması var', () => {
    const commands = Object.keys(entries).filter((n) => !NOT_COMMANDS.has(n));
    assert.deepEqual(commands.filter((n) => !PROBES[n]), [], 'yeni giriş: PROBES içine yoklama ekleyin');
    assert.deepEqual(Object.keys(PROBES).filter((n) => !entries[n]), [], 'PROBES içinde tsup girişi olmayan ad');
  });

  it('her komut girişinin kendi kaynağı kendi çıktısında (ortak parçaya taşınmamış)', () => {
    for (const [name, src] of Object.entries(entries)) {
      if (NOT_COMMANDS.has(name)) continue;
      const out = fs.readFileSync(path.join(OUT, `${name}.js`), 'utf8');
      assert.ok(out.includes(`// ${src.replace(/\\/g, '/')}\n`), `${name}.js kendi kaynağını (${src}) taşımıyor: gövde ortak parçada, komut çalışmaz`);
    }
  });

  for (const [name, probe] of Object.entries(PROBES)) {
    it(`${name}: çalıştırılınca işini yapar (boş geçip 0 ile bitmez)`, () => {
      const res = run(name, probe.args, probe.env);
      const output = `${res.stdout}\n${res.stderr}`;
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError/, output);
      assert.equal(res.status, probe.code, output);
      assert.match(output, probe.out);
    });
  }
});
