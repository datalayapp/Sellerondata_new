// test:changed planı (git ve test koşusu yok; dosya içerikleri ve listeler sahte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plan, packageOf, mentions, dependentsOf, PACKAGES } from './test-changed.mjs';

const fakeTests = {
  'Deciship/apps/web': { 'test/recalc.test.ts': "import { recalc } from '../src/lib/recalc.ts';", 'test/other.test.ts': "import x from '../src/lib/other';" },
  '.': { 'scripts/ci-select.test.mjs': "import { JOBS } from './ci-select.mjs';", 'scripts/repo-check.test.mjs': "from './repo-check.mjs'" },
};
const opts = (o = {}) => ({
  root: '/r',
  tc: false,
  list: (cwd, glob) => {
    const dir = path.relative('/r', cwd).replaceAll('\\', '/') || '.';
    const re = new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
    return Object.keys(fakeTests[dir] ?? {}).filter((f) => re.test(f));
  },
  read: (abs) => {
    const rel = path.relative('/r', abs).replaceAll('\\', '/');
    for (const [dir, files] of Object.entries(fakeTests)) {
      const pre = dir === '.' ? '' : dir + '/';
      if (rel.startsWith(pre) && files[rel.slice(pre.length)] !== undefined) return files[rel.slice(pre.length)];
    }
    throw new Error('yok');
  },
  ...o,
});

test('paket bulma: en uzun önek, kök betikleri, sahipsiz belge', () => {
  assert.equal(packageOf('Deciship/apps/api/src/app.ts').dir, 'Deciship/apps/api');
  assert.equal(packageOf('scripts/ci-select.mjs').dir, '.');
  assert.equal(packageOf('Platform/gateway/test/access-log.test.mjs').dir, '.');
  assert.equal(packageOf('SONRAKI-OTURUM/DEVAM.md'), null);
  assert.equal(packageOf('Platform/docs/KARARLAR.md'), null);
});

test('içe aktarma eşleşmesi: adın kendisi, uzantılı ya da uzantısız; benzer ad eşleşmez', () => {
  assert.ok(mentions("from '../src/lib/recalc.ts'", 'src/lib/recalc.ts'));
  assert.ok(mentions("from '../src/lib/recalc'", 'src/lib/recalc.ts'));
  assert.ok(!mentions("from '../src/lib/recalcAll.ts'", 'src/lib/recalc.ts'));
  assert.ok(mentions("from '../src/index.ts'", 'src/index.ts'), 'index: klasörüyle');
  assert.ok(mentions("from '../src'", 'src/index.ts'), 'index: klasörün kendisi');
  assert.ok(!mentions("from './other/index.ts'", 'src/index.ts'), 'başka klasörün index dosyası');
  assert.ok(!mentions("from './index.ts'", 'index.ts'), 'paket kökündeki index fazla genel');
});

test('API: birim ve veritabanı adımları; Postgres yoksa veritabanı adımı koşmadı', () => {
  const files = ['Deciship/apps/api/src/services/compare.ts'];
  const on = plan(files, opts({ pgOk: true })).steps;
  assert.equal(on.length, 2);
  assert.match(on[0].cmd, /vitest related --run --passWithNoTests --config vitest\.unit\.config\.ts "src\/services\/compare\.ts"/);
  assert.ok(on[1].pg && !on[1].skip);
  const off = plan(files, opts({ pgOk: false })).steps;
  assert.equal(off.length, 2);
  assert.ok(off[1].skip && /Postgres kapalı/.test(off[1].skip));
});

test('auth-kit: Postgres yoksa .db.test dışlanarak koşar ve veritabanı kısmı koşmadı yazılır', () => {
  const s = plan(['Platform/packages/auth-kit/src/index.ts'], opts({ pgOk: false })).steps;
  assert.match(s[0].cmd, /--exclude "test\/\*\*\/\*\.db\.test\.ts"/);
  assert.ok(s[1].skip);
});

test('node --test paketi: değişen kaynağı içe aktaran test ve değişen test seçilir, ötekiler seçilmez', () => {
  const s = plan(['Deciship/apps/web/src/lib/recalc.ts'], opts({ pgOk: false })).steps.filter((x) => /node --test/.test(x.cmd ?? ''));
  assert.equal(s.length, 1);
  assert.match(s[0].cmd, /"test\/recalc\.test\.ts"/);
  assert.doesNotMatch(s[0].cmd, /other/);
  const t = plan(['scripts/ci-select.mjs', 'scripts/repo-check.test.mjs'], opts({ pgOk: false })).steps;
  assert.equal(t.length, 1);
  assert.match(t[0].cmd, /"scripts\/ci-select\.test\.mjs" "scripts\/repo-check\.test\.mjs"/);
});

test('testi bulunmayan değişiklik "bulunamadı" der; belge sahipsiz listede', () => {
  const r = plan(['Deciship/apps/web/src/lib/none.ts', 'SONRAKI-OTURUM/KALANLAR.md'], opts({ pgOk: false }));
  assert.deepEqual(r.unowned, ['SONRAKI-OTURUM/KALANLAR.md']);
  assert.ok(r.steps.some((s) => s.skip && /bulunamadı/.test(s.skip)));
});

test('tip denetimi: TypeScript değişince paketin tc parçası eklenir', () => {
  const s = plan(['Deciship/packages/core/src/calc.ts'], opts({ pgOk: false, tc: true })).steps;
  assert.ok(s.some((x) => x.label.endsWith('tip denetimi') && x.cmd === 'npm run typecheck'));
});

test('file: bağımlıları gerçek package.json dosyalarından çıkar', () => {
  const d = dependentsOf('Deciship/packages/core');
  for (const x of ['Deciship/apps/api', 'Deciship/apps/web', 'Deciship/apps/mobile']) assert.ok(d.includes(x), x);
  assert.ok(!d.includes('Platform/apps/account-api'));
  for (const p of PACKAGES) assert.ok(p.dir === '.' || p.vitest || p.node, p.dir);
});
