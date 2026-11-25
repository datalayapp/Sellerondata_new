// CI iş seçimi: yol listeleri, ci.yml ile eşlik, "sınandı" sayımı ve taban arama (git ve gh çağrılmaz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_PATHS, VISION_PATHS, IGNORE_PATHS, JOBS, matchesAny, relevantFiles, counts, findJob, readCiYml, DB_TAG, DB_LATER } from './ci-select.mjs';

test('veritabanı yolları: veritabanına dokunan kod tetikler, panel ve notlar tetiklemez', () => {
  const yes = [
    'Deciship/apps/api/src/routes/invoices.ts',
    'Deciship/apps/api/prisma/migrations/20261112120000_import_report/migration.sql',
    'Platform/apps/account-api/prisma/schema.prisma',
    'Platform/apps/account-api/src/lib/members.ts',
    'Platform/packages/auth-kit/src/index.ts',
    'Platform/packages/product-kit/test/ornekarac/ornekarac.db.test.ts',
    'Platform/packages/contracts/src/permissions.ts',
    'Platform/packages/format/src/index.ts',
    'Deciship/packages/core/src/calc.ts',
    'Platform/infra/postgres/init.sql',
    'scripts/parts.mjs',
    'scripts/test.mjs',
    'scripts/lib/shape.mjs',
    '.github/workflows/ci.yml',
    '.nvmrc',
    'baska/bir/yer/prisma/schema.prisma',
    'Tagpress/apps/server/src/db/pg/migrations/0002-yeni.sql',
    'Tagpress/apps/server/src/services/print/sessions.ts',
    'Tagpress/apps/server/src/platform/identity.ts',
    'Tagpress/pnpm-lock.yaml',
    'Tagpress/vitest.pg.config.ts',
    'Platform/apps/ai-api/prisma/migrations/20261123000000_init/migration.sql',
    'Platform/apps/ai-api/src/keystore/seal.ts',
    'Platform/scripts/products-db.mjs',
  ];
  const no = [
    'Deciship/apps/web/src/App.tsx',
    'Platform/apps/hub-web/src/main.tsx',
    'Deciship/apps/mobile/app/(tabs)/deciship/scan.tsx',
    'Platform/packages/shell/src/index.ts',
    'Platform/packages/tokens/build.mjs',
    'tools/lint/run.mjs',
    'SONRAKI-OTURUM/DEVAM.md',
    'Deciship/services/vision/app/main.py',
    'scripts/t.mjs',
    'Tagpress/apps/web/src/main.tsx',
    'Tagpress/packages/engine/src/index.ts',
  ];
  for (const f of yes) assert.ok(matchesAny(f, DB_PATHS), `tetiklemeli: ${f}`);
  for (const f of no) assert.ok(!matchesAny(f, DB_PATHS), `tetiklememeli: ${f}`);
});

test('görüntü servisi yolları', () => {
  assert.ok(matchesAny('Deciship/services/vision/tests/test_robustness.py', VISION_PATHS));
  assert.ok(matchesAny('Deciship/services/vision/requirements.txt', VISION_PATHS));
  assert.ok(!matchesAny('Deciship/apps/api/src/index.ts', VISION_PATHS));
});

test('yok sayılan yollar: notlar ve belgeler; kod değil', () => {
  for (const f of ['SONRAKI-OTURUM/KALANLAR.md', 'README.md', 'Deciship/SPEC.md', '.claude/skills/is-akisi/SKILL.md']) {
    assert.ok(matchesAny(f, IGNORE_PATHS), f);
  }
  for (const f of ['Platform/apps/site/index.html', 'scripts/ci-select.mjs', 'Deciship/apps/api/src/index.ts']) {
    assert.ok(!matchesAny(f, IGNORE_PATHS), f);
  }
  // Veritabanı yolundaki belge, kodla aynı gönderimde gelse de veritabanı işini tetiklemez.
  assert.deepEqual(relevantFiles(['Deciship/apps/api/README.md', 'Deciship/apps/web/src/App.tsx'], 'db'), []);
  assert.deepEqual(relevantFiles(['Deciship/apps/api/README.md', 'Deciship/apps/api/src/index.ts'], 'db'), ['Deciship/apps/api/src/index.ts']);
});

test('ci.yml: paths-ignore listesi iki tetikleyicide de IGNORE_PATHS ile aynı', () => {
  const yml = readCiYml();
  const blocks = [...yml.matchAll(/paths-ignore:\n((?:\s+- .+\n)+)/g)].map((m) => [...m[1].matchAll(/- '([^']+)'/g)].map((x) => x[1]));
  assert.equal(blocks.length, 2, 'push ve pull_request');
  for (const b of blocks) assert.deepEqual(b, IGNORE_PATHS);
});

test('ci.yml: iş adları JOBS önekleriyle başlar (taban arama ada göre yapılır)', () => {
  const names = [...readCiYml().matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
  for (const [k, prefix] of Object.entries(JOBS)) {
    assert.equal(names.filter((n) => n.startsWith(prefix)).length, 1, `${k}: "${prefix}" ile başlayan tek iş`);
  }
});

test('sınandı sayılan iş durumları', () => {
  assert.ok(counts({ status: 'completed', conclusion: 'success' }));
  assert.ok(counts({ status: 'completed', conclusion: 'failure' }));
  assert.ok(counts({ status: 'in_progress', conclusion: null }));
  for (const c of ['cancelled', 'skipped', 'timed_out', 'neutral']) assert.ok(!counts({ status: 'completed', conclusion: c }), c);
  for (const s of ['queued', 'waiting', 'pending', 'requested']) assert.ok(!counts({ status: s, conclusion: null }), s);
});

test('iş adı eşleşmesi eski koşu adlarını da tanır', () => {
  const jobs = [
    { name: 'Denetim, lint, tip denetimi, birim testler' },
    { name: 'Veritabanı testleri (DeciShip API, Hesap servisi, auth-kit)' },
  ];
  assert.equal(findJob(jobs, 'db'), jobs[1]);
  assert.equal(findJob(jobs, 'hizli'), jobs[0]);
  assert.equal(findJob(jobs, 'vision'), undefined);
});

test('parçalı veritabanı işi tek iş gibi toplanır (KALANLAR 0.7)', () => {
  const j = (ad, status, conclusion) => ({ name: `Veritabanı testleri (${ad})`, status, conclusion, html_url: ad });
  const ok = [j('API 1/3', 'completed', 'success'), j('API 2/3', 'completed', 'success')];
  assert.deepEqual([findJob(ok, 'db').status, findJob(ok, 'db').conclusion], ['completed', 'success']);
  const bad = [...ok, j('Hesap 1/2', 'completed', 'failure'), j('Hesap 2/2', 'completed', 'cancelled')];
  assert.equal(findJob(bad, 'db').conclusion, 'failure');
  assert.equal(findJob(bad, 'db').html_url, 'Hesap 1/2');
  assert.equal(findJob([...ok, j('API 3/3', 'completed', 'cancelled')], 'db').conclusion, 'cancelled');
  const live = [...ok, j('API 3/3', 'queued', null), j('Hesap 1/2', 'in_progress', null)];
  assert.equal(findJob(live, 'db').status, 'in_progress');
  assert.ok(counts(findJob(live, 'db')));
  assert.equal(findJob([...ok, j('API 3/3', 'queued', null)], 'db').status, 'queued');
  assert.ok(!counts(findJob([...ok, j('API 3/3', 'queued', null)], 'db')));
  // Atlanan matris (if: false) tek iş olarak görünür.
  assert.equal(findJob([j('${{ matrix.ad }}', 'completed', 'skipped')], 'db').conclusion, 'skipped');
});

test('[db] etiketi büyük küçük harf duyarsız; [db-sonra] onunla karışmaz', () => {
  assert.ok(DB_TAG.test('Rapor güncellendi [DB]'));
  assert.ok(DB_TAG.test('a\n\nb [db]\n'));
  assert.ok(!DB_TAG.test('db testleri'));
  assert.ok(!DB_TAG.test('küçük düzeltme [db-sonra]'));
  assert.ok(DB_LATER.test('küçük düzeltme [db-sonra]'));
});
