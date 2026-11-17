// Derlenmiş komut girişleri gerçekten çalışır mı (veritabanı gerekmez). `npm run test:cli` ya da kökten `npm run t -- <bu dosya>`.
//
// Neden: tsup bölmesinde (splitting) başka bir girişin de içe aktardığı modülün gövdesi ortak parçaya taşınır. Giriş dosyası
// yalnız dışa aktarım yapar, "ana dosya mı" denetimi (`import.meta.url`) parçayı gösterir ve komut hiçbir şey yapmadan 0 ile
// biter. `node dist/seed.js` böyle sessizce "başarılı" bitiyordu, demo hesaplar yüklenmiyordu.
//
// Denetim iki katlı: (1) her girişin kendi kaynağı kendi çıktı dosyasında durur (esbuild modül yorumu), (2) her giriş çalıştırılınca
// ana işini yapar: veritabanına gitmeden duran bir yol (kullanım hatası, yerel olmayan adres) ya da ulaşılamayan veritabanında
// bağlantı hatası verir. Hiçbir şey yapmadan 0 ile biten giriş burada kırılır. Yeni giriş eklenince aşağıya yoklaması yazılır.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const API_ROOT = path.resolve(import.meta.dirname, '..');
// node_modules içinde: derlenen dosyalar dış paketleri (prisma, argon2) buradan bulur. Docker'daki ve cli.test.ts'teki dist/'e dokunmaz.
const OUT = path.join(API_ROOT, 'node_modules', '.cache', `cli-entries-${process.pid}`);
const TSUP = path.join(API_ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');

/** Sunucu girişleri komut değildir: çalıştırılınca dinlemeye başlar. */
const SERVER_ENTRIES = new Set(['main']);

/** Ulaşılamayan veritabanı: bağlantı hemen reddedilir. */
const NO_DB = 'postgresql://sod:sod@127.0.0.1:1/yok';
const DB_ERROR = /ECONNREFUSED|connect|reach|bağlan/i;

/** Giriş adı -> çalıştırma. `code`: beklenen çıkış; `out`: stdout+stderr içinde aranan. */
const PROBES = {
  seed: { args: [], env: { APP_BASE_URL: 'https://app.example.com' }, code: 1, out: /yalnız yerel adreste/ },
  'outbox-requeue': { args: [], code: 1, out: DB_ERROR },
  'org-announce': { args: [], code: 1, out: DB_ERROR },
  'phone-release': { args: [], code: 1, out: /Kullanım: phone-release/ },
  'phone-restore': { args: [], code: 1, out: /Kullanım: phone-restore/ },
  'org-list': { args: ['--status', 'PAUSED'], code: 2, out: /Durum geçersiz/ },
  'subscription-set': { args: [], code: 2, out: /Kullanım: subscription-set/ },
  'product-launch': { args: ['deciship'], code: 2, out: /--operator/ },
  'org-close': { args: [], code: 2, out: /Kullanım: org-close/ },
  'org-reopen': { args: [], code: 2, out: /Kullanım: org-reopen/ },
  'members-announce': { args: ['deciship', '--org', 'abc'], code: 2, out: /UUID/ },
  'signup-purge': { args: [], code: 2, out: /Kullanım: signup-purge/ },
  'signup-invite': { args: [], code: 2, out: /Kullanım: signup-invite/ },
};

let entries = {};

function run(name, args, env = {}) {
  return spawnSync(process.execPath, [path.join(OUT, `${name}.js`), ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: NO_DB,
      APP_BASE_URL: 'http://localhost:8088',
      PRODUCT_LAUNCH: '',
      PRODUCT_EVENT_TARGETS: '',
      ...env,
    },
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
    const commands = Object.keys(entries).filter((n) => !SERVER_ENTRIES.has(n));
    assert.deepEqual(commands.filter((n) => !PROBES[n]), [], 'yeni giriş: PROBES içine yoklama ekleyin');
    assert.deepEqual(Object.keys(PROBES).filter((n) => !entries[n]), [], 'PROBES içinde tsup girişi olmayan ad');
  });

  it('her girişin kendi kaynağı kendi çıktısında (ortak parçaya taşınmamış)', () => {
    for (const [name, src] of Object.entries(entries)) {
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
