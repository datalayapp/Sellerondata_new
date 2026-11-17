// node --test scripts/products-gen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VAR_PREFIX, GENERATED, generate, renderConf, renderSiteJson, diff, write, loadRegistry, OUT } from './products-gen.mjs';
import { DB_RESERVED_KEYS, SCHEMAS_MARK, dbTenants, renderInitSql, renderUpgradeSql } from './products-db.mjs';
import { blockScalars, checkLists, composeServices } from './products-lists.mjs';

const GEN = fileURLToPath(new URL('./products-gen.mjs', import.meta.url));
const registry = await loadRegistry();

const fake = {
  key: 'ornekarac',
  name: 'Örnek Araç',
  tagline: { tr: 'Örnek slogan', en: 'Sample tagline' },
  color: '#123456',
  launch: 'pilot',
  deploy: { api: { service: 'ornekarac-api', port: 4200 }, web: { service: 'ornekarac-web', port: 80 } },
  site: { tr: '/urunler/ornekarac/', en: '/en/products/ornekarac/' },
};

test('diskteki çıktı kayıtla güncel', () => {
  assert.deepEqual(diff(generate(registry)), []);
});

test('--check güncelken 0 ile çıkar', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('deploy alanı olan her araç için yalnız o araçta conf var', () => {
  const files = Object.keys(generate(registry)).filter((f) => f.startsWith(OUT.confDir));
  const expected = registry.filter((e) => e.deploy).map((e) => `${OUT.confDir}/${e.key}.conf`);
  assert.deepEqual(files.sort(), expected.sort());
  assert.ok(files.includes(`${OUT.confDir}/deciship.conf`));
});

test('her conf "üretilmiştir" notuyla başlar; ^~ ve regex konumu yok', () => {
  for (const [f, c] of Object.entries({ ...generate(registry), [`${OUT.confDir}/ornekarac.conf`]: renderConf(fake) })) {
    if (!f.endsWith('.conf')) continue;
    assert.match(c.split('\n')[0], /^# ÜRETİLDİ: .*Elle düzenlemeyin\.$/);
    assert.doesNotMatch(c, /\^~/, f);
    assert.doesNotMatch(c, /location\s+~/, f);
    for (const m of c.matchAll(/^location\s+(\S+)\s+(\S+)?/gm)) assert.ok(m[1] === '=' || m[1].startsWith('/'), `${f}: ${m[0]}`);
  }
});

test('DeciShip bloğu bugünkü değerleri taşır', () => {
  const c = generate(registry)[`${OUT.confDir}/deciship.conf`];
  for (const line of [
    'set $sod_p_deciship_api http://deciship-api:4000;',
    'set $sod_p_deciship_web http://deciship-web:80;',
    'client_max_body_size 50m;',
    'client_body_timeout 120s;',
    'proxy_read_timeout 240s;',
    'proxy_send_timeout 240s;',
    'location = /api/deciship/health {',
    'location /api/deciship/ {',
    'location = /deciship {',
    'location /deciship/assets/ {',
    'location /deciship/ {',
    'add_header Cache-Control "public, max-age=31536000, immutable";',
    'add_header Cache-Control "no-cache";',
    'return 301 /deciship/;',
  ]) assert.ok(c.includes(line), line);
});

test('varsayılanlar: gövde 1m, gövde zaman aşımı 60s, okuma 30s', () => {
  const c = renderConf(fake);
  assert.match(c, /client_max_body_size 1m;/);
  assert.match(c, /client_body_timeout 60s;/);
  assert.match(c, /proxy_read_timeout 30s;\n {2}proxy_send_timeout 30s;/);
  assert.match(c, /set \$sod_p_ornekarac_api http:\/\/ornekarac-api:4200;/);
});

test('yalnız API olan araçta web bloğu yok', () => {
  const c = renderConf({ ...fake, deploy: { api: fake.deploy.api } });
  assert.doesNotMatch(c, /sod_p_ornekarac_web/);
  assert.match(c, /location \/api\/ornekarac\//);
});

test('site JSON: yalnız site alanı olan araçlar, kayıt sırasıyla', () => {
  const j = JSON.parse(renderSiteJson([fake, { ...fake, key: 'gizli', site: undefined }, { ...fake, key: 'ikinci', mark: 'x-mark.svg' }]));
  assert.deepEqual(j.products.map((p) => p.key), ['ornekarac', 'ikinci']);
  assert.equal(j.products[0].mark, null);
  assert.equal(j.products[1].mark, '/x-mark.svg');
  assert.deepEqual(j.products[0].tagline, fake.tagline);
  assert.equal(j.products[0].launch, 'pilot');
  assert.ok(j._uretildi);
  const real = JSON.parse(generate(registry)[OUT.siteJson]);
  assert.equal(real.products.find((p) => p.key === 'deciship').mark, '/deciship-mark.svg');
});

test('bayat, eksik ve artık dosya yakalanır', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'products-gen-'));
  try {
    const files = generate(registry);
    assert.ok(diff(files, root).every((p) => p.startsWith('eksik:')));
    for (const [rel, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), c);
    }
    assert.deepEqual(diff(files, root), []);
    writeFileSync(path.join(root, `${OUT.confDir}/deciship.conf`), `${files[`${OUT.confDir}/deciship.conf`]}# elle\n`);
    writeFileSync(path.join(root, `${OUT.confDir}/eski.conf`), 'x');
    const p = diff(files, root);
    assert.ok(p.some((x) => x.startsWith('bayat:') && x.includes('deciship.conf')));
    assert.ok(p.some((x) => x.startsWith('artık dosya:') && x.includes('eski.conf')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('değişkenler önekli: Merkez ve Hesap değişkenleriyle çakışmaz', () => {
  assert.equal(VAR_PREFIX, 'sod_p_');
  for (const c of Object.values(generate(registry)).filter((x) => x.includes('location'))) {
    for (const m of c.matchAll(/\$(\w+)/g)) assert.ok(m[1].startsWith('sod_p_'), m[0]);
  }
});

test("Merkez ve Hesap anahtarlı kayıt reddedilir (üretici kayıt doğrulaması)", async () => {
  const { validateRegistry } = await import('../packages/contracts/src/products.ts');
  for (const key of ['hub', 'account']) {
    const errs = validateRegistry([{ ...fake, key, permissions: {}, roles: [], ownerRole: null, inviteRole: null, launch: 'off' }]);
    assert.ok(errs.some((m) => m.includes('ayrılmış')), key);
  }
});

test('CRLF indirilmiş çıktı bayat sayılmaz (Windows klonu)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'products-gen-'));
  try {
    const files = generate(registry);
    for (const [rel, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), c.replaceAll('\n', '\r\n'));
    }
    assert.deepEqual(diff(files, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.gitkeep artık dosya sayılmaz; yalnız .conf denetlenir', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'products-gen-'));
  try {
    const files = generate([]);
    mkdirSync(path.join(root, OUT.confDir), { recursive: true });
    writeFileSync(path.join(root, OUT.confDir, '.gitkeep'), '');
    writeFileSync(path.join(root, OUT.confDir, 'not.txt'), 'x');
    assert.ok(diff(files, root).every((p) => p.startsWith('eksik:')));
    writeFileSync(path.join(root, OUT.confDir, 'eski.conf'), 'x');
    assert.ok(diff(files, root).some((p) => p.startsWith('artık dosya:')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('yazma kipi kayıttan çıkan aracın üretilmiş conf dosyasını siler; başlıksız dosyaya ve .gitkeep e dokunmaz', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'products-gen-'));
  try {
    const files = generate(registry);
    const dir = path.join(root, OUT.confDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'elle.conf'), 'x');
    writeFileSync(path.join(dir, '.gitkeep'), '');
    const first = Object.values(files).find((c) => c.includes('ÜRETİLDİ'));
    writeFileSync(path.join(dir, 'uretilmis-eski.conf'), first);
    const quiet = console.error;
    console.error = () => {};
    try {
      write(files, root);
    } finally {
      console.error = quiet;
    }
    assert.equal(existsSync(path.join(dir, 'uretilmis-eski.conf')), false);
    assert.equal(existsSync(path.join(dir, 'elle.conf')), true);
    assert.equal(existsSync(path.join(dir, '.gitkeep')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- Veritabanı rolleri ve şemaları (init.sql, upgrade.sql) ----------

const sqlOnly = (t) => t.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*--/.test(l) && l.trim() !== '').join('\n');
const withDb = (key, name = key) => ({ key, name, deploy: { api: { service: `${key}-api`, port: 4300 } } });

test('init.sql ve upgrade.sql kayıttan üretilir; şema satırı platform ve deploy.api olan araçlar', () => {
  const files = generate(registry);
  assert.ok(files[OUT.initSql].startsWith(`-- ${GENERATED}\n`));
  assert.ok(files[OUT.upgradeSql].startsWith(`-- ${GENERATED}\n`));
  const keys = ['platform', ...registry.filter((e) => e.deploy?.api).map((e) => e.key)];
  assert.ok(files[OUT.initSql].split('\n').includes(`${SCHEMAS_MARK} ${keys.join(' ')}`));
  assert.deepEqual(dbTenants(registry).map((t) => t.key), keys);
});

test('bugünkü kayıt için üretilen init.sql, son elle yazılan init.sql ile aynı SQL (yorumlar ve aşağıdaki bilinen farklar dışında)', () => {
  // Bilinen, kasıtlı farklar (güvenlik incelemesi 6.21): iç psql değişkenleri sod__ önekli (anahtar "superuser" ile çakışmasın) ve
  // parola taşıyan oturumda ifade günlüğü kapalı. Bunlar geri alınınca SQL elle yazılanla birebir aynı olmalı.
  // Yeni bir kasıtlı değişiklikte bu liste (ya da karşılaştırma dosyası) aynı commit'te güncellenir.
  const before = readFileSync(new URL('./test-fixtures/postgres-init-2026-11-16.sql', import.meta.url), 'utf8');
  const undo = (t) => t
    .replace(/^SET log_statement = 'none';\nSET log_min_error_statement = panic;\nSET log_min_duration_statement = -1;\n/m, '')
    .replaceAll('sod__su_password', 'sod_superuser_password')
    .replaceAll('sod__env', 'sod_env')
    .replaceAll('sod__refuse', 'sod_refuse');
  assert.equal(undo(sqlOnly(generate(registry)[OUT.initSql]) + '\n').trimEnd(), sqlOnly(before));
});

test('@db-setup bölümü psql komutu içermez (testler test veritabanına uygular)', () => {
  const init = renderInitSql([...registry, withDb('ornekarac')], 'x');
  const sec = init.slice(init.indexOf('-- @db-setup-begin'), init.indexOf('-- @db-setup-end'));
  assert.ok(sec.length > 100);
  assert.doesNotMatch(sec, /^\s*\\/m);
});

test('yeni araç: kendi iki rolü, kendi şeması; hak yalnız kendi rolüne, varsayılanlar yalnız kendi şemasında', () => {
  const reg = [...registry, withDb('ornekarac', 'Örnek Araç')];
  const init = renderInitSql(reg, 'x');
  const up = renderUpgradeSql(reg, 'x');
  const has = (text, line) => assert.ok(text.split('\n').includes(line), line);
  const keys = dbTenants(reg).map((t) => t.key);
  assert.deepEqual(keys, ['platform', 'deciship', 'ornekarac']);
  for (const k of keys) {
    const A = `sod_${k}_admin`;
    const U = `sod_${k}`;
    for (const r of [A, U]) {
      has(init, `CREATE ROLE ${r} LOGIN PASSWORD :'${r}_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
      has(init, `ALTER ROLE ${r} SET search_path = ${k}, pg_temp;`);
      has(up, `ALTER ROLE ${r} SET search_path = ${k}, pg_temp;`);
      assert.ok(init.includes(`:'${r}_password'`) && /unnest\(ARRAY\[[^\]]*\]\)/.test(init), r);
      assert.ok(init.match(/unnest\(ARRAY\[([^\]]*)\]\)/)[1].includes(`:'${r}_password'`), `${r} üretimde *_dev reddinde`);
      assert.ok(up.includes(`('${r}', :'${r}_password')`), `${r} upgrade.sql rol açma listesinde`);
    }
    has(init, `\\getenv ${U}_password SOD_${k.toUpperCase()}_DB_PASSWORD`);
    has(init, `\\getenv ${A}_password SOD_${k.toUpperCase()}_ADMIN_DB_PASSWORD`);
    has(init, `CREATE SCHEMA IF NOT EXISTS ${k} AUTHORIZATION ${A};`);
    has(init, `REVOKE ALL ON SCHEMA ${k} FROM PUBLIC;`);
    has(init, `GRANT USAGE ON SCHEMA ${k} TO ${U};`);
    has(init, `ALTER ROLE ${U} SET timezone = 'UTC';`);
    has(init, `ALTER DEFAULT PRIVILEGES FOR ROLE ${A} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
    assert.ok(up.includes(`('${k}', '${A}')`), `${k} sahiplik düzeltmesinde`);
    assert.ok(up.includes(`REVOKE ALL ON TABLE ${k}."_prisma_migrations" FROM ${U}'`), `${k} migration geçmişi`);
  }
  // Her hak satırı kendi kiracısında kalır: şema k → yalnız sod_k; varsayılanlar sod_k_admin'den sod_k'ye, k şemasında.
  const grants = [...init.matchAll(/^GRANT USAGE ON SCHEMA (\w+) TO (.+);$/gm)];
  assert.equal(grants.length, keys.length);
  for (const m of grants) assert.equal(m[2], `sod_${m[1]}`, m[0]);
  assert.equal([...init.matchAll(/^\s*GRANT /gm)].length, keys.length * 4, 'USAGE ve üç varsayılan dışında GRANT yok');
  const lines = init.split('\n');
  let defaults = 0;
  lines.forEach((l, i) => {
    const m = l.match(/^ALTER DEFAULT PRIVILEGES FOR ROLE sod_(\w+)_admin IN SCHEMA (\w+)$/);
    if (!m) return;
    defaults++;
    assert.equal(m[1], m[2], l);
    assert.match(lines[i + 1], new RegExp(`^ {2}GRANT [A-Z, ]+ ON (TABLES|SEQUENCES|FUNCTIONS) TO sod_${m[2]};$`), lines[i + 1]);
  });
  assert.equal(defaults, keys.length * 3);
  const connect = init.match(/GRANT CONNECT ON DATABASE %I TO ([^']+)'/)[1].split(', ');
  assert.deepEqual(connect.sort(), keys.flatMap((k) => [`sod_${k}`, `sod_${k}_admin`]).sort());
});

test('veritabanında ayrılmış anahtar reddedilir (platform, public, eski sod_admin)', () => {
  for (const k of DB_RESERVED_KEYS) assert.throws(() => dbTenants([withDb(k)]), /ayrılmış/, k);
  assert.throws(() => dbTenants([withDb('Kotu-ad')]), /anahtar biçimi/);
  assert.deepEqual(dbTenants([{ key: 'apisiz', name: 'x' }]).map((t) => t.key), ['platform']);
});

// ---------- Elle yazılan listelerin denetimi (products-lists.mjs) ----------

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const LIST_FILES = [
  'scripts/parts.mjs', 'scripts/install.mjs', 'scripts/test-changed.mjs', 'scripts/ci-select.mjs', 'scripts/test.mjs',
  'scripts/repo-check.mjs', 'scripts/repo-check.config.mjs', '.github/workflows/ci.yml', 'Platform/gateway/test/access-log.test.mjs',
  'Platform/e2e/snapshot.mjs', 'Platform/docker-compose.yml', 'Platform/docker-compose.prod.yml', 'Platform/.env.example',
  'Platform/scripts/dev.ps1', 'Platform/scripts/yedekle.ps1', 'Platform/scripts/geri-yukle.ps1',
];

/** Geçici depo: liste dosyalarının ve araç paketlerinin (package.json, kilit, Dockerfile, nginx.conf, göçler) kopyası. */
function fixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'products-lists-'));
  const copy = (rel) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), readFileSync(path.join(REPO, rel)));
  };
  for (const f of LIST_FILES) copy(f);
  for (const folder of ['Platform', 'Deciship']) {
    for (const sub of ['apps', 'packages', 'services']) {
      const dir = path.join(REPO, folder, sub);
      if (!existsSync(dir)) continue;
      for (const d of readdirSync(dir)) {
        const rel = `${folder}/${sub}/${d}`;
        mkdirSync(path.join(root, rel), { recursive: true });
        for (const f of ['package.json', 'package-lock.json', 'Dockerfile', 'nginx.conf']) if (existsSync(path.join(REPO, rel, f))) copy(`${rel}/${f}`);
        const mig = `${rel}/prisma/migrations`;
        if (!existsSync(path.join(REPO, mig))) continue;
        for (const m of readdirSync(path.join(REPO, mig))) if (existsSync(path.join(REPO, mig, m, 'migration.sql'))) copy(`${mig}/${m}/migration.sql`);
      }
    }
  }
  return root;
}
const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const edit = (root, rel, from, to) => {
  const t = readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(t.includes(from), `${rel}: "${from}" yok`);
  writeFileSync(path.join(root, rel), t.replace(from, to));
};

test('depodaki listeler kayıtla tam (products:check)', () => {
  assert.deepEqual(checkLists(registry), []);
});

test('yeni araç klasörü (Orderloom) eklenip listeler unutulursa her liste ayrı ayrı yakalanır', () => {
  const root = fixtureRepo();
  try {
    assert.deepEqual(checkLists(registry, root), [], 'kopya depo temiz başlamalı');
    const reg = registry.map((e) => (e.key === 'orderloom' ? { ...e, deploy: { api: { service: 'orderloom-api', port: 4300 } } } : e));
    put(root, 'Orderloom/apps/api/package.json', '{}');
    put(root, 'Orderloom/apps/api/package-lock.json', '{}');
    put(root, 'Orderloom/apps/api/Dockerfile', 'RUN ln -s ../../apps/api/node_modules Platform/packages/contracts/node_modules\n');
    put(root, 'Orderloom/apps/api/prisma/migrations/20270101000000_init/migration.sql',
      'CREATE SCHEMA IF NOT EXISTS "orderloom";\nGRANT SELECT ON "deciship"."Company" TO sod_deciship;\n');
    put(root, 'Orderloom/apps/web/package.json', '{}');
    put(root, 'Orderloom/apps/web/nginx.conf', 'server {}\n');
    edit(root, 'scripts/parts.mjs', "  { id: 'api', dir: 'Deciship/apps/api'",
      "  { id: 'orderloom-db', dir: 'Orderloom/apps/api', cmd: 'npm test', group: 'db', pg: true },\n  { id: 'api', dir: 'Deciship/apps/api'");
    edit(root, 'scripts/repo-check.config.mjs', "{ dir: 'Deciship/apps/api/prisma/migrations', defaultSchema: 'deciship' },",
      "{ dir: 'Deciship/apps/api/prisma/migrations', defaultSchema: 'deciship' },\n      { dir: 'Orderloom/apps/api/prisma/migrations', defaultSchema: 'orderloom' },");
    const p = checkLists(reg, root);
    const expected = [
      /^scripts\/parts\.mjs: Orderloom\/apps\/web için test parçası yok/,
      /^scripts\/install\.mjs: Orderloom\/apps\/api DIRS/,
      /^scripts\/test-changed\.mjs: Orderloom\/apps\/api PACKAGES/,
      /^scripts\/ci-select\.mjs: Orderloom\/apps\/api \(parça orderloom-db\) DB_PATHS/,
      /^\.github\/workflows\/ci\.yml: Orderloom\/apps\/api\/package-lock\.json 1\. cache/,
      /^\.github\/workflows\/ci\.yml: veritabanı parçası orderloom-db/,
      /^scripts\/repo-check\.config\.mjs: orderloom şeması rlsSchemas/,
      /^scripts\/repo-check\.config\.mjs: Orderloom\/apps\/api\/Dockerfile node_modules/,
      /migration\.sql: CREATE SCHEMA var/,
      /migration\.sql: başka kiracının rolü geçiyor: sod_deciship/,
      /migration\.sql: başka kiracının şeması geçiyor: "deciship"\./,
      /^Orderloom\/apps\/api\/prisma\/migrations: hiçbir göç _prisma_migrations/,
      /^Platform\/gateway\/test\/access-log\.test\.mjs: Orderloom\/apps\/web\/nginx\.conf/,
      /^Platform\/e2e\/snapshot\.mjs: Orderloom/,
      /^scripts\/repo-check\.mjs: DOC_ROOTS içinde Orderloom\//,
      /^scripts\/test\.mjs: --scope Orderloom/,
      /^Platform\/docker-compose\.yml: postgres ortamında SOD_ORDERLOOM_ADMIN_DB_PASSWORD/,
      /^Platform\/docker-compose\.yml: postgres-upgrade ortamında SOD_ORDERLOOM_DB_PASSWORD/,
      /^Platform\/docker-compose\.prod\.yml: postgres ortamında zorunlu SOD_ORDERLOOM_DB_PASSWORD/,
      /^Platform\/docker-compose\.yml: orderloom API servisi orderloom-api yok/,
      /^Platform\/docker-compose\.yml: orderloom için sod_orderloom_admin ile \?schema=orderloom göç servisi yok/,
      /^Platform\/docker-compose\.yml: account-api PRODUCT_EVENT_TARGETS varsayılanında orderloom=/,
      /^Platform\/\.env\.example: SOD_ORDERLOOM_ADMIN_DB_PASSWORD/,
      /^Platform\/scripts\/yedekle\.ps1: orderloom\._prisma_migrations/,
      /^Platform\/scripts\/yedekle\.ps1: orderloom şeması/,
      /^Platform\/scripts\/dev\.ps1: sod_orderloom bağlantısı yok/,
      /^Platform\/scripts\/dev\.ps1: PRODUCT_EVENT_TARGETS içinde orderloom=/,
    ];
    for (const re of expected) assert.ok(p.some((x) => re.test(x)), `beklenen bulgu yok: ${re}\n  ${p.join('\n  ')}`);
    assert.ok(p.every((x) => /orderloom|Orderloom|ORDERLOOM/.test(x)), `yalnız yeni aracın bulguları:\n  ${p.join('\n  ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kayıtta olmayan ya da yanlış adlı araç klasörü yakalanır', () => {
  const root = fixtureRepo();
  try {
    put(root, 'OrderLoom/apps/api/package.json', '{}');
    put(root, 'Bilinmez/packages/x/package.json', '{}');
    const p = checkLists(registry, root);
    assert.ok(p.some((x) => x.startsWith('klasör: OrderLoom/') && x.includes('beklenen ad Orderloom')), p.join('\n'));
    assert.ok(p.some((x) => x.startsWith('klasör: Bilinmez/')), p.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compose: başka kiracının rolüyle bağlanan servis ve uygulama kabındaki migration parolası yakalanır', () => {
  const root = fixtureRepo();
  try {
    edit(root, 'Platform/docker-compose.yml',
      'DATABASE_URL: postgresql://sod_deciship:${SOD_DECISHIP_DB_PASSWORD:-sod_deciship_dev}@postgres:5432/sellerondata',
      'DATABASE_URL: postgresql://sod_platform:${SOD_PLATFORM_DB_PASSWORD:-sod_platform_dev}@postgres:5432/sellerondata\n' +
        '      EXTRA_URL: postgresql://sod_deciship:x@postgres:5432/sellerondata\n      SOD_DECISHIP_ADMIN_DB_PASSWORD: x');
    edit(root, 'Platform/docker-compose.prod.yml', '      SOD_ENV: production\n      PGPASSWORD', '      PGPASSWORD');
    const p = checkLists(registry, root);
    for (const re of [
      /deciship-api birden çok kiracının rolüyle bağlanıyor: platform, deciship/,
      /deciship-api göç servisi değil ama migration rolünün parolasını taşıyor/,
      /postgres-upgrade ortamında SOD_ENV: production yok/,
    ]) assert.ok(p.some((x) => re.test(x)), `${re}\n  ${p.join('\n  ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compose okuyucu: servis blokları, sütun 0 yorumu servis listesini kesmez; blok metinleri', () => {
  const s = composeServices('services:\n  a:\n    x: 1\n# yorum\n  b:\n    y: 2\nvolumes:\n  c:\n');
  assert.deepEqual(Object.keys(s), ['a', 'b']);
  assert.match(s.b, /y: 2/);
  assert.deepEqual(blockScalars('k:\n  p: |\n    a\n    b\n  q: 1\n', 'p'), ['    a\n    b']);
});

// ---------- Güvenlik incelemesi (6.21) bulguları ----------

test('psql değişkenleri çakışmaz: iç değişkenler sod__ önekli, her ortam değişkeni tek değişkene; "superuser" anahtarı ayrılmış', () => {
  assert.throws(() => dbTenants([withDb('superuser')]), /ayrılmış/);
  const reg = [...registry, withDb('zeta'), withDb('sutest')];
  for (const sql of [renderInitSql(reg, 'x'), renderUpgradeSql(reg, 'x')]) {
    const gets = [...sql.matchAll(/^\\getenv (\S+) (\S+)$/gm)].map((m) => ({ v: m[1], env: m[2] }));
    assert.ok(gets.length > 6);
    assert.equal(new Set(gets.map((g) => g.v)).size, gets.length, 'psql değişkeni tekil');
    assert.equal(new Set(gets.map((g) => g.env)).size, gets.length, 'ortam değişkeni tekil');
    for (const g of gets) {
      const role = g.env.match(/^SOD_([A-Z0-9]+(?:_ADMIN)?)_DB_PASSWORD$/);
      if (role) assert.equal(g.v, `sod_${role[1].toLowerCase()}_password`, g.env);
      else assert.match(g.v, /^sod__/, `${g.env} iç değişkeni sod__ önekli olmalı`);
    }
    for (const m of sql.matchAll(/^\\set (\S+)/gm)) assert.ok(gets.some((g) => g.v === m[1]) || m[1].startsWith('sod__') || m[1] === 'ON_ERROR_STOP', m[0]);
    for (const m of sql.matchAll(/\\gset/g)) assert.ok(m);
    assert.doesNotMatch(sql, /\bAS sod_(?!_)\w+ \\gset/, 'gset değişkenleri de sod__ önekli');
  }
});

test('Postgres ayrılmış sözcüğü ve platform iç adları anahtar olamaz', () => {
  for (const k of ['user', 'select', 'table', 'grant', 'all', 'analyze', 'verbose', 'superuser', 'env']) {
    assert.throws(() => dbTenants([withDb(k)]), /ayrılmış/, k);
  }
  assert.deepEqual(dbTenants([withDb('orderloom'), withDb('tagpress')]).map((t) => t.key), ['platform', 'orderloom', 'tagpress']);
});

test('ad yorum satırından taşamaz: satır sonu ve denetim karakteri reddedilir', () => {
  for (const name of ['A\nDROP ROLE postgres;', 'A\rB', 'A\u2028B', 'A\u0000B']) {
    assert.throws(() => renderInitSql([withDb('kotuad', name)], 'x'), /ad/, JSON.stringify(name));
  }
});

test('parola taşıyan oturum ifade günlüğünü kapatır (hata olsa da düz parola sunucu günlüğüne düşmez)', () => {
  const reg = [...registry, withDb('zeta')];
  for (const sql of [renderInitSql(reg, 'x'), renderUpgradeSql(reg, 'x')]) {
    const first = sql.search(/PASSWORD/);
    const lines = sql.slice(0, first);
    for (const s of ["SET log_statement = 'none';", 'SET log_min_error_statement = panic;', 'SET log_min_duration_statement = -1;']) {
      assert.ok(lines.split('\n').includes(s), s);
    }
  }
});

test('upgrade.sql kayıtta olmayan, nesnesi ve hakkı olmayan sod_ rollerini siler; kiracı rollerine dokunmaz', () => {
  const up = renderUpgradeSql([...registry, withDb('zeta')], 'x');
  const block = up.slice(up.indexOf('-- Kayıtta olmayan ve kümede'), up.indexOf('-- Hak ve varsayılanlar'));
  assert.ok(block.length > 100, 'blok sod_admin temizliğinden sonra, hak bölümünden önce');
  const tenants = dbTenants([...registry, withDb('zeta')]).flatMap((t) => [`'sod_${t.key}_admin'`, `'sod_${t.key}'`]).sort();
  const listed = block.match(/NOT IN \(([^)]*)\)/)[1].split(', ').sort();
  assert.deepEqual(listed, tenants);
  assert.match(block, /LIKE 'sod\\_%'/);
  // kümenin hiçbir veritabanında sahiplik, hak ya da varsayılan hak kaydı yok (pg_shdepend bütün veritabanlarını kapsar)
  assert.match(block, /NOT EXISTS \(SELECT 1 FROM pg_shdepend d WHERE d\.refclassid = 'pg_authid'::regclass AND d\.refobjid = a\.oid\)/);
  assert.match(block, /EXECUTE format\('DROP ROLE %I', r\.rolname\);/);
  // silinemeyen rol betiği durdurmaz (ON_ERROR_STOP açık)
  assert.match(block, /EXCEPTION WHEN dependent_objects_still_exist OR object_in_use THEN/);
  assert.doesNotMatch(block, /DROP OWNED|REASSIGN/);
  assert.ok(up.indexOf("EXECUTE 'DROP OWNED BY sod_admin'") < up.indexOf('-- Kayıtta olmayan ve kümede'));
});

test('upgrade.sql rol ayarlarını her koşuda baştan yazar ve üretimde geliştirme parolasını ağ üzerinden dener', () => {
  const up = renderUpgradeSql([...registry, withDb('zeta')], 'x');
  for (const k of ['platform', 'deciship', 'zeta']) {
    for (const r of [`sod_${k}_admin`, `sod_${k}`]) {
      const reset = up.indexOf(`ALTER ROLE ${r} RESET ALL;`);
      assert.ok(reset > 0 && reset < up.indexOf(`ALTER ROLE ${r} SET search_path`), `${r} önce RESET ALL`);
    }
  }
  assert.match(up, /^\\if :sod__production$/m);
  assert.match(up, /^ {2}\\! sh \/infra\/postgres\/dev-parola\.sh #$/m);
  assert.match(up, /^ {2}\\if :SHELL_ERROR$/m);
  assert.match(up, /^ {2}\\setenv SOD_PGHOST :HOST$/m);
  const sh = readFileSync(new URL('../infra/postgres/dev-parola.sh', import.meta.url), 'utf8');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /_dev/);
  assert.ok(!sh.includes('\r'));
});

test("göç denetimi: PUBLIC'e hak ve başka şemaya GRANT ON SCHEMA yasak", () => {
  const root = fixtureRepo();
  try {
    const mig = 'Deciship/apps/api/prisma/migrations/20990101000000_kotu/migration.sql';
    put(root, mig, [
      'GRANT SELECT ON ALL TABLES IN SCHEMA "deciship" TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "deciship" GRANT SELECT ON TABLES TO public;',
      'GRANT USAGE ON SCHEMA platform TO sod_deciship;',
      'GRANT USAGE ON SCHEMA "platform" TO sod_deciship;',
      'REVOKE ALL ON SCHEMA deciship FROM PUBLIC;',
    ].join('\n'));
    const p = checkLists(registry, root).filter((x) => x.startsWith(mig));
    assert.equal(p.filter((x) => /PUBLIC'e hak/.test(x)).length, 2, p.join('\n'));
    assert.equal(p.filter((x) => /başka kiracının şemasına GRANT: platform/.test(x)).length, 2, p.join('\n'));
    assert.ok(!p.some((x) => /REVOKE/.test(x)), 'REVOKE ... FROM PUBLIC serbest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('göç denetimi: şemanın bütün tablolarına toplu GRANT yasak (şablonun daraltılmış hakları genişlemesin); REVOKE serbest', () => {
  const root = fixtureRepo();
  try {
    const mig = 'Deciship/apps/api/prisma/migrations/20990101000000_toplu/migration.sql';
    put(root, mig, [
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "deciship" TO sod_deciship;',
      'grant delete\n  on all tables in schema deciship to sod_deciship;',
      'REVOKE ALL ON ALL TABLES IN SCHEMA deciship FROM sod_deciship;',
      'GRANT SELECT ON "deciship"."Item" TO sod_deciship;',
    ].join('\n'));
    const p = checkLists(registry, root).filter((x) => x.startsWith(mig));
    assert.equal(p.filter((x) => /toplu GRANT/.test(x)).length, 2, p.join('\n'));
    assert.ok(!p.some((x) => /REVOKE|"Item"/.test(x)), p.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compose: postgres-upgrade SOD_ENV değerini ortamdan alır (sunucunun .env dosyası üretimi korur)', () => {
  assert.match(composeServices(readFileSync(path.join(REPO, 'Platform/docker-compose.yml'), 'utf8'))['postgres-upgrade'], /^\s+SOD_ENV: \$\{SOD_ENV:-development\}$/m);
  const root = fixtureRepo();
  try {
    edit(root, 'Platform/docker-compose.yml', '      SOD_ENV: ${SOD_ENV:-development}\n      PGPASSWORD', '      PGPASSWORD');
    assert.ok(checkLists(registry, root).some((x) => /postgres-upgrade ortamında SOD_ENV/.test(x)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init.sql yorumu search_path için "sabit" demez (rol kendi ayarını değiştirebilir; upgrade.sql yeniden yazar)', () => {
  const init = generate(registry)[OUT.initSql];
  assert.doesNotMatch(init, /search_path sabit/);
  assert.match(init, /upgrade\.sql/);
});
