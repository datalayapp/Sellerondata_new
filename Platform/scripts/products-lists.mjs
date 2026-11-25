// Üretilemeyen listelerin denetimi (`npm run products:check`): kayıttaki her araç ve aracın klasörü elle yazılan listelerde var mı.
// Yeni araç (ör. OrderLoom) eklenince unutulan bir liste sessiz arızaya (testi hiç koşmayan paket, CI'da seçilmeyen veritabanı
// testi) ya da güvenlik açığına (RLS'siz şema, başka aracın rolüyle bağlanan servis, uygulama kabında migration parolası) dönmesin.
// Kural başına tek işlev; her biri sorun metinlerinin listesini döndürür (boş = tamam). Dosyalar metin olarak okunur: listeler
// betiklerin içinde durur ve içe aktarılınca çalışan betikler var (install.mjs). Biçim değişirse denetim "okunamadı" der, susmaz.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchGlob } from '../../scripts/repo-check.mjs';
import { adminPasswordEnv, adminRole, appPasswordEnv, appRole, dbAllTenants, dbTenants } from './products-db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Aracın depo kökündeki klasörü: anahtarın ilk harfi büyük (`deciship` → `Deciship`, `orderloom` → `Orderloom`). */
export const productDir = (key) => key[0].toUpperCase() + key.slice(1);

/** Kiracının API servisi (compose): kiracı listesindeki `service` (Platform: Hesap servisi, araç: `deploy.api.service`, hizmet: kendi servisi). */
const apiService = (t) => t.service;

function fsCtx(root) {
  const abs = (rel) => path.join(root, rel);
  const read = (rel) => (existsSync(abs(rel)) ? readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n') : null);
  const isDir = (rel) => existsSync(abs(rel)) && statSync(abs(rel)).isDirectory();
  const dirs = (rel) => (isDir(rel) ? readdirSync(abs(rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
  const files = (rel) => (isDir(rel) ? readdirSync(abs(rel), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort() : []);
  const has = (rel) => existsSync(abs(rel));
  return { read, isDir, dirs, files, has };
}

/** Göç düzenleri: Prisma (`prisma/migrations/<ad>/migration.sql`) ve düz SQL (`src/db/pg/migrations/<ad>.sql`, kendi çalıştırıcısı). */
const MIGRATION_LAYOUTS = ['prisma/migrations', 'src/db/pg/migrations'];
const PRISMA_HISTORY = '_prisma_migrations';
/** Klasördeki göç dosyaları (depo köküne göre). */
const migrationFiles = (fs, dir) => (dir.endsWith('/prisma/migrations')
  ? fs.dirs(dir).map((d) => `${dir}/${d}/migration.sql`).filter((f) => fs.has(f))
  : fs.files(dir).filter((f) => f.endsWith('.sql')).map((f) => `${dir}/${f}`));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Aracın paketleri: `apps/*` ve `packages/*` (package.json olan), `services/*` (her klasör). */
function productPackages(fs, folder) {
  const out = [];
  for (const sub of ['apps', 'packages']) {
    for (const d of fs.dirs(`${folder}/${sub}`)) if (fs.has(`${folder}/${sub}/${d}/package.json`)) out.push({ dir: `${folder}/${sub}/${d}`, node: true });
  }
  for (const d of fs.dirs(`${folder}/services`)) out.push({ dir: `${folder}/services/${d}`, node: fs.has(`${folder}/services/${d}/package.json`) });
  return out;
}

/** `[ 'a', "b" ]` biçimli dizinin dizgeleri; dizi bulunamazsa null. */
function arrayAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const open = text.indexOf('[', i);
  const close = text.indexOf(']', open);
  if (open < 0 || close < 0) return null;
  return [...text.slice(open + 1, close).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/** YAML `anahtar: |` blok metinleri: anahtar satırından daha girintili ardışık satırlar. */
export function blockScalars(text, key) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(new RegExp(`^(\\s*)${key}: \\|\\s*$`));
    if (!m) return;
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '' && lines[j].match(/^\s*/)[0].length > m[1].length; j++) body.push(lines[j]);
    out.push(body.join('\n'));
  });
  return out;
}

/** Basit compose okuyucu: `services:` altındaki iki boşluk girintili her servisin metin bloğu. */
export function composeServices(text) {
  const out = {};
  let cur = null;
  let inServices = false;
  for (const line of text.split('\n')) {
    if (/^#/.test(line)) continue;
    if (/^\S/.test(line)) { inServices = /^services:\s*$/.test(line); cur = null; continue; }
    if (!inServices) continue;
    const m = line.match(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/);
    if (m) { cur = m[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += `${line}\n`;
  }
  return out;
}

/** Metindeki `sod_<ad>` rol adları (bağlantı adreslerinde `rol:` ya da `rol@`). */
const urlRoles = (block) => [...block.matchAll(/postgres(?:ql)?:\/\/(sod_[a-z0-9_]+)[:@]/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------------------------------

export function checkLists(entries, root = ROOT) {
  const fs = fsCtx(root);
  const problems = [];
  const P = (msg) => problems.push(msg);
  // Bütün veritabanı kiracıları: platform, araçlar ve ürün dışı hizmetler (yapay zekâ geçidi `ai`); init.sql ile aynı liste.
  const tenants = dbAllTenants(entries);
  const productKeys = new Set(dbTenants(entries).map((t) => t.key));
  const services = tenants.filter((t) => !productKeys.has(t.key));
  const tenantByRole = new Map();
  for (const t of tenants) { tenantByRole.set(appRole(t.key), t.key); tenantByRole.set(adminRole(t.key), t.key); }
  const dbProducts = entries.filter((e) => e.deploy?.api);

  // 1) Araç klasörleri: kayıttaki anahtarın klasörü; kayıtta olmayan araç klasörü yok.
  const folders = entries.map((e) => productDir(e.key)).filter((f) => fs.isDir(f));
  for (const d of fs.dirs('.')) {
    if (d === 'Platform' || d.startsWith('.') || folders.includes(d)) continue;
    if (fs.isDir(`${d}/apps`) || fs.isDir(`${d}/packages`)) {
      const near = entries.find((e) => e.key === d.toLowerCase());
      P(`klasör: ${d}/ araç klasörüne benziyor ama kayıtta karşılığı yok${near ? ` (beklenen ad ${productDir(near.key)})` : ''}`);
    }
  }
  const pkgs = folders.flatMap((f) => productPackages(fs, f));
  const nodePkgs = pkgs.filter((p) => p.node);

  // 2) scripts/parts.mjs: her paketin en az bir test parçası var.
  const partsText = fs.read('scripts/parts.mjs');
  const parts = (partsText ?? '').split('\n').map((l) => l.match(/^\s*\{ id: '([^']+)', dir: '([^']+)'(.*)\},?\s*$/)).filter(Boolean)
    .map((m) => ({ id: m[1], dir: m[2], rest: m[3], pg: /\bpg: true\b/.test(m[3]), db: /\bgroup: 'db'/.test(m[3]) }));
  if (!parts.length) P('scripts/parts.mjs: PARTS okunamadı');
  for (const p of pkgs) if (!parts.some((x) => x.dir === p.dir)) P(`scripts/parts.mjs: ${p.dir} için test parçası yok (npm test onu hiç koşmaz)`);

  // 3) scripts/install.mjs: kilit dosyası olan her paket kurulur.
  const installDirs = [...(fs.read('scripts/install.mjs') ?? '').matchAll(/\{ dir: '([^']+)'/g)].map((m) => m[1]);
  if (!installDirs.length) P('scripts/install.mjs: DIRS okunamadı');
  for (const p of nodePkgs) {
    if (fs.has(`${p.dir}/package-lock.json`) && !installDirs.includes(p.dir)) P(`scripts/install.mjs: ${p.dir} DIRS listesinde yok (CI'da bağımlılığı kurulmaz)`);
  }

  // 4) scripts/test-changed.mjs: Node paketleri değişen dosya planında.
  const changedDirs = [...(fs.read('scripts/test-changed.mjs') ?? '').matchAll(/\bdir: '([^']+)'/g)].map((m) => m[1]);
  if (!changedDirs.length) P('scripts/test-changed.mjs: PACKAGES okunamadı');
  for (const p of nodePkgs) if (!changedDirs.includes(p.dir)) P(`scripts/test-changed.mjs: ${p.dir} PACKAGES listesinde yok (npm run test:changed onu atlar)`);

  // 5) scripts/ci-select.mjs DB_PATHS: veritabanı testi olan her parça CI veritabanı işini tetikler.
  const dbPaths = arrayAfter(fs.read('scripts/ci-select.mjs') ?? '', 'export const DB_PATHS');
  if (!dbPaths?.length) P('scripts/ci-select.mjs: DB_PATHS okunamadı');
  else for (const p of parts.filter((x) => x.pg)) {
    if (!dbPaths.some((g) => matchGlob(`${p.dir}/package.json`, g))) P(`scripts/ci-select.mjs: ${p.dir} (parça ${p.id}) DB_PATHS kapsamında değil (değişince veritabanı işi koşmaz)`);
  }

  // 6) .github/workflows/ci.yml: önbellek yolları her kilit dosyasını kapsar; her veritabanı parçası matriste.
  const ci = fs.read('.github/workflows/ci.yml');
  if (ci === null) P('.github/workflows/ci.yml okunamadı');
  else {
    // npm önbellekleri (pip önbelleği gibi kilit dosyası anmayan bloklar sayılmaz).
    const caches = blockScalars(ci, 'cache-dependency-path')
      .map((b) => b.split('\n').map((x) => x.trim()).filter(Boolean))
      .filter((globs) => globs.some((g) => g.endsWith('package-lock.json')));
    if (!caches.length) P('.github/workflows/ci.yml: cache-dependency-path okunamadı');
    for (const p of nodePkgs) {
      const lock = `${p.dir}/package-lock.json`;
      if (!fs.has(lock)) continue;
      caches.forEach((globs, i) => { if (!globs.some((g) => matchGlob(lock, g))) P(`.github/workflows/ci.yml: ${lock} ${i + 1}. cache-dependency-path listesinde yok`); });
    }
    const only = [...ci.matchAll(/\bonly: '?([a-z0-9,:-]+)'?/g)].flatMap((m) => m[1].split(','));
    for (const p of parts.filter((x) => x.db)) if (!only.includes(p.id)) P(`.github/workflows/ci.yml: veritabanı parçası ${p.id} "veritabani" matrisinde (only:) yok (CI'da hiç koşmaz)`);
  }

  // 7) scripts/repo-check.config.mjs: göç klasörü kiracı şemasında, araç şeması FORCE RLS'li, imajda node_modules bağı.
  const rc = fs.read('scripts/repo-check.config.mjs');
  const migDirs = rc
    ? [...rc.matchAll(/\{ dir: '([^']+)', defaultSchema: '([^']+)'(?:, historyTable: '([^']+)', historyRunner: '([^']+)')? \}/g)]
      .map((m) => ({ dir: m[1], schema: m[2], history: m[3] ?? PRISMA_HISTORY, runner: m[4] ?? null }))
    : [];
  const rlsSchemas = rc ? arrayAfter(rc, 'rlsSchemas:') : null;
  const consumers = rc ? [...rc.matchAll(/consumer: '([^']+)'/g)].map((m) => m[1]) : [];
  if (!rc || !migDirs.length || !rlsSchemas) P('scripts/repo-check.config.mjs: migrations.dirs ya da rlsSchemas okunamadı');
  else {
    for (const e of dbProducts) if (!rlsSchemas.includes(e.key)) P(`scripts/repo-check.config.mjs: ${e.key} şeması rlsSchemas listesinde yok (göçlerde FORCE RLS denetlenmez)`);
    for (const p of nodePkgs) {
      for (const layout of MIGRATION_LAYOUTS) {
        const mig = `${p.dir}/${layout}`;
        if (!fs.isDir(mig)) continue;
        const key = p.dir.split('/')[0].toLowerCase();
        const cfg = migDirs.find((m) => m.dir === mig);
        if (!cfg) P(`scripts/repo-check.config.mjs: ${mig} migrations.dirs listesinde yok`);
        else if (cfg.schema !== key) P(`scripts/repo-check.config.mjs: ${mig} varsayılan şeması ${cfg.schema}, beklenen ${key}`);
        else if (!layout.startsWith('prisma/') && !cfg.runner) P(`scripts/repo-check.config.mjs: ${mig} Prisma dışı: historyTable ve historyRunner yazılmalı`);
      }
    }
    for (const p of nodePkgs) {
      const df = fs.read(`${p.dir}/Dockerfile`);
      if (df && /\bln -s\b[^\n]*node_modules/.test(df) && !consumers.includes(p.dir)) P(`scripts/repo-check.config.mjs: ${p.dir}/Dockerfile node_modules bağlıyor, sharedNodeModules listesinde yok`);
    }
    // Göçler: yalnız kendi rolleri, CREATE SCHEMA yok (şemayı init.sql açar), migration geçmişi uygulama rolüne kapalı.
    for (const m of migDirs) {
      const t = tenants.find((x) => x.key === m.schema);
      if (!t) { P(`scripts/repo-check.config.mjs: ${m.dir} şeması ${m.schema} kiracı değil (init.sql'de rolü ve şeması yok)`); continue; }
      const files = migrationFiles(fs, m.dir);
      let revoked = false;
      for (const f of files) {
        const sql = fs.read(f).replace(/--[^\n]*/g, '');
        if (/\bCREATE\s+SCHEMA\b/i.test(sql)) P(`${f}: CREATE SCHEMA var (şemayı init.sql açar; migration rolünde CREATE hakkı yok)`);
        for (const r of new Set([...sql.matchAll(/\bsod_[a-z0-9_]+\b/g)].map((x) => x[0]))) {
          if (r !== appRole(t.key) && r !== adminRole(t.key)) P(`${f}: başka kiracının rolü geçiyor: ${r}`);
        }
        for (const o of tenants) if (o.key !== t.key && new RegExp(`"${o.key}"\\s*\\.`).test(sql)) P(`${f}: başka kiracının şeması geçiyor: "${o.key}".`);
        // PUBLIC'e hak (GRANT ya da ALTER DEFAULT PRIVILEGES … TO PUBLIC): her rol, başka aracınki de, erişirdi. REVOKE … FROM PUBLIC serbest.
        for (const st of sql.split(';')) {
          if (/\bGRANT\b[\s\S]*\bTO\s+PUBLIC\b/i.test(st)) P(`${f}: PUBLIC'e hak veriliyor: ${st.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
          // Şemanın bütün tablolarına toplu hak: product-kit şablonunun daraltılmış haklarını (CompanyPurge, ProcessedEvent) sessizce
          // genişletir. Hak tablo tablo verilir; REVOKE … ON ALL TABLES serbest.
          if (/\bGRANT\b[\s\S]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(st)) P(`${f}: şemanın bütün tablolarına toplu GRANT (tablo tablo verin): ${st.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
          const sch = st.match(/\bGRANT\b[\s\S]*?\bON\s+SCHEMA\s+"?([a-z][a-z0-9_]*)"?/i);
          if (sch && sch[1].toLowerCase() !== t.key) P(`${f}: başka kiracının şemasına GRANT: ${sch[1]}`);
        }
        if (new RegExp(`REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+[^;]*${escapeRe(m.history)}"?\\s+FROM\\s+"?${appRole(t.key)}\\b`, 'i').test(sql)) revoked = true;
      }
      // Kendi çalıştırıcısı olan düzen: geçmiş tablosunu çalıştırıcı açar ve her koşuda uygulama rolünden geri alır
      // (tablo adı ve rol adı dosyada sabit, REVOKE ALL ON TABLE … FROM <rol> ifadesi var).
      if (m.runner && files.length) {
        const src = fs.read(m.runner);
        if (src === null) P(`scripts/repo-check.config.mjs: ${m.dir} göç çalıştırıcısı ${m.runner} yok`);
        else {
          const role = appRole(t.key);
          if (src.includes(`"${m.history}"`) && src.includes(`"${role}"`) && /REVOKE ALL ON TABLE \S+ FROM "?(\$\{\w+\}|sod_[a-z0-9_]+)"?/.test(src)) revoked = true;
          else P(`${m.runner}: ${m.history} geçmiş tablosu ${role} rolünden geri alınmıyor (REVOKE ALL ON TABLE … FROM ${role})`);
        }
      }
      if (files.length && !revoked) P(`${m.dir}: hiçbir göç ${m.history} tablosunu ${appRole(t.key)} rolünden geri almıyor (REVOKE ALL ON TABLE "${m.history}")`);
    }
  }

  // 8) Platform/gateway/test/access-log.test.mjs: jetonlu adres taşıyabilen her nginx sunucusu günlük denetiminde.
  const al = fs.read('Platform/gateway/test/access-log.test.mjs') ?? '';
  for (const p of nodePkgs) {
    const conf = `${p.dir}/nginx.conf`;
    if (fs.has(conf) && !al.includes(`conf: '${conf}'`)) P(`Platform/gateway/test/access-log.test.mjs: ${conf} SERVERS listesinde yok (jeton günlüğe düşebilir)`);
  }

  // 9) Klasör listeleri: e2e anlık görüntüsü, belge denetimi kökleri, test.mjs --scope. Bunlar ileride kayıttan türeyebilir
  // (KALANLAR 6.26, 6.27): elle yazılmış klasör listesi ('Platform' ile 'Deciship' aynı satırda) yoksa denetlenecek bir şey de yoktur.
  const folderLists = (rel) => (fs.read(rel) ?? '').split('\n').filter((l) => l.includes("'Platform'") && l.includes("'Deciship'"));
  const snapLines = folderLists('Platform/e2e/snapshot.mjs');
  const scopeLines = folderLists('scripts/test.mjs').filter((l) => l.includes('scope'));
  const docRoots = arrayAfter(fs.read('scripts/repo-check.mjs') ?? '', 'const DOC_ROOTS');
  for (const f of folders) {
    if (snapLines.some((l) => !l.includes(`'${f}'`))) P(`Platform/e2e/snapshot.mjs: ${f} anlık görüntüye girmiyor`);
    if (docRoots?.includes('Platform/') && !docRoots.includes(`${f}/`)) P(`scripts/repo-check.mjs: DOC_ROOTS içinde ${f}/ yok (belge yolları denetlenmez)`);
    if (scopeLines.some((l) => !l.includes(`'${f}'`))) P(`scripts/test.mjs: --scope ${f} kabul edilmiyor`);
  }

  // 10) Veritabanı rolleri: compose, üretim katmanı, .env örneği, geliştirme ve yedek betikleri.
  const dev = fs.read('Platform/docker-compose.yml');
  const prod = fs.read('Platform/docker-compose.prod.yml');
  if (dev === null || prod === null) P('Platform/docker-compose.yml ya da docker-compose.prod.yml okunamadı');
  else {
    const S = composeServices(dev);
    const SP = composeServices(prod);
    for (const t of tenants) {
      for (const env of [adminPasswordEnv(t.key), appPasswordEnv(t.key)]) {
        for (const svc of ['postgres', 'postgres-upgrade']) {
          if (!new RegExp(`^\\s+${env}: \\$\\{${env}:-`, 'm').test(S[svc] ?? '')) P(`Platform/docker-compose.yml: ${svc} ortamında ${env} yok`);
          if (!new RegExp(`^\\s+${env}: \\$\\{${env}:\\?`, 'm').test(SP[svc] ?? '')) P(`Platform/docker-compose.prod.yml: ${svc} ortamında zorunlu ${env} yok`);
        }
      }
      const api = apiService(t);
      const urls = urlRoles(S[api] ?? '');
      if (!S[api]) P(`Platform/docker-compose.yml: ${t.key} API servisi ${api} yok`);
      else if (!urls.includes(appRole(t.key))) P(`Platform/docker-compose.yml: ${api} veritabanına ${appRole(t.key)} ile bağlanmıyor`);
      const migrators = Object.entries(S).filter(([, b]) => new RegExp(`MIGRATE_DATABASE_URL: postgresql://${adminRole(t.key)}:[^\\n]*[?&]schema=${t.key}\\b`).test(b));
      if (!migrators.length) P(`Platform/docker-compose.yml: ${t.key} için ${adminRole(t.key)} ile ?schema=${t.key} göç servisi yok`);
    }
    for (const [name, block] of Object.entries(S)) {
      if (name === 'postgres' || name === 'postgres-upgrade') continue;
      const owners = new Set(urlRoles(block).map((r) => tenantByRole.get(r) ?? `?${r}`));
      for (const o of owners) if (o.startsWith('?')) P(`Platform/docker-compose.yml: ${name} bilinmeyen rolle bağlanıyor: ${o.slice(1)}`);
      if (owners.size > 1) P(`Platform/docker-compose.yml: ${name} birden çok kiracının rolüyle bağlanıyor: ${[...owners].join(', ')}`);
      const migrates = /MIGRATE_DATABASE_URL:/.test(block);
      if (!migrates && /_ADMIN_DB_PASSWORD|sod_[a-z0-9]+_admin[:@]/.test(block)) P(`Platform/docker-compose.yml: ${name} göç servisi değil ama migration rolünün parolasını taşıyor`);
    }
    if (!/^\s+SOD_ENV: \$\{SOD_ENV:-development\}$/m.test(S['postgres-upgrade'] ?? '')) {
      P('Platform/docker-compose.yml: postgres-upgrade ortamında SOD_ENV: ${SOD_ENV:-development} yok (sunucunun .env dosyası üretimi seçemez)');
    }
    if (!/^\s+SOD_ENV: production$/m.test(SP['postgres-upgrade'] ?? '')) P('Platform/docker-compose.prod.yml: postgres-upgrade ortamında SOD_ENV: production yok (yeni rol *_dev parolasıyla açılabilir)');
    const targets = (S['account-api'] ?? '').match(/PRODUCT_EVENT_TARGETS: (.*)/)?.[1] ?? '';
    for (const e of dbProducts) if (!new RegExp(`(^|[{:,-])${e.key}=`).test(targets)) P(`Platform/docker-compose.yml: account-api PRODUCT_EVENT_TARGETS varsayılanında ${e.key}= yok`);
    // Ürün dışı hizmetler (ai) firma olaylarını ayrı listeden alır (PLATFORM_SERVICE_TARGETS); adresi yoksa olay yazılmaz.
    const serviceTargets = (S['account-api'] ?? '').match(/PLATFORM_SERVICE_TARGETS: (.*)/)?.[1] ?? '';
    for (const s of services) if (!new RegExp(`(^|[{:,-])${s.key}=`).test(serviceTargets)) P(`Platform/docker-compose.yml: account-api PLATFORM_SERVICE_TARGETS varsayılanında ${s.key}= yok`);
  }
  const envEx = fs.read('Platform/.env.example') ?? '';
  const devPs = fs.read('Platform/scripts/dev.ps1') ?? '';
  const yedekle = fs.read('Platform/scripts/yedekle.ps1') ?? '';
  const gocLine = yedekle.split('\n').find((l) => l.includes("'platform._prisma_migrations'")) ?? '';
  const semaLine = yedekle.split('\n').find((l) => /foreach \(\$sema in @\('platform'/.test(l)) ?? '';
  // Yedek betiğindeki elle yazılı şema listeleri; betik listeyi veritabanından okumaya geçerse satır kalmaz, denetim de.
  // geri-yukle.ps1 rol parolalarını desenle (Get-RolParolaAdlari), yedek-kap.sh rolleri veritabanından okur: liste yok.
  for (const t of tenants) {
    for (const env of [adminPasswordEnv(t.key), appPasswordEnv(t.key)]) {
      if (!new RegExp(`^${env}=`, 'm').test(envEx)) P(`Platform/.env.example: ${env} yok`);
    }
    // Geçmiş tablosu kiracının göç düzenine göre (Prisma: _prisma_migrations; kendi çalıştırıcısı: repo-check ayarındaki ad).
    const history = migDirs.find((m) => m.schema === t.key)?.history ?? PRISMA_HISTORY;
    if (gocLine && !gocLine.includes(`'${t.key}.${history}'`)) P(`Platform/scripts/yedekle.ps1: ${t.key}.${history} yedek denetiminde yok`);
    if (semaLine && !semaLine.includes(`'${t.key}'`)) P(`Platform/scripts/yedekle.ps1: ${t.key} şeması göç özetinde yok`);
    if (!devPs.includes(`postgresql://${appRole(t.key)}:`)) P(`Platform/scripts/dev.ps1: ${appRole(t.key)} bağlantısı yok`);
  }
  const devTargets = devPs.match(/PRODUCT_EVENT_TARGETS = "([^"]*)"/)?.[1] ?? '';
  for (const e of dbProducts) if (!new RegExp(`(^|,)${e.key}=`).test(devTargets)) P(`Platform/scripts/dev.ps1: PRODUCT_EVENT_TARGETS içinde ${e.key}= yok`);
  const devServiceTargets = devPs.match(/PLATFORM_SERVICE_TARGETS = "([^"]*)"/)?.[1] ?? '';
  for (const s of services) if (!new RegExp(`(^|,)${s.key}=`).test(devServiceTargets)) P(`Platform/scripts/dev.ps1: PLATFORM_SERVICE_TARGETS içinde ${s.key}= yok`);

  return problems;
}
