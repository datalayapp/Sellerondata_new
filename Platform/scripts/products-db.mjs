// Veritabanı rolleri ve şemaları: araç kaydından `infra/postgres/init.sql` ve `upgrade.sql` (products-gen.mjs yazar).
// Kiracı = kendi şeması ve iki rolü olan parça: `platform` (Hesap servisi) ve `deploy.api` alanı olan her araç, kayıt sırasıyla.
//   sod_<k>_admin  <k> şemasının sahibi; aracın migration'ı. Uygulama kabına girmez.
//   sod_<k>        aracın API'si. Yalnız <k> şemasında veri okuma/yazma (default privileges); DDL yok.
// Hiçbir rol başka kiracının şemasını görmez (USAGE yalnız kendi şemasında). Ayrıntı: Platform/docs/mimari/01-temel.md.
// Bağımlılıksız; ad ve parola değişkenleri yalnız kayıt anahtarından (`/^[a-z][a-z0-9]{2,19}$/`) türer.

/**
 * Kiracı olamayacak anahtarlar: Postgres'in ve platformun ad alanıyla çakışır, eski ortak rol `sod_admin` olurdu ya da üretilen
 * SQL'in iç adlarına benzer (`superuser`, `env`: iç psql değişkenleri ayrıca `sod__` önekli, anahtarda alt çizgi olamaz).
 */
export const DB_RESERVED_KEYS = ['platform', 'public', 'admin', 'postgres', 'template', 'prova', 'superuser', 'env', 'refuse', 'production'];

/**
 * Postgres 17 ayrılmış sözcükleri (`pg_get_keywords()` catcode R ve T), anahtar biçimine uyanlar. Şema adı SQL'de tırnaksız
 * yazılır; `user` gibi bir anahtar kurulumu bozar. verify.sh kurulu kümede aynı denetimi `pg_get_keywords()` ile yapar.
 */
export const PG_RESERVED_WORDS = (
  'all analyse analyze and any array asc asymmetric authorization binary both case cast check collate collation column concurrently ' +
  'constraint create cross default deferrable desc distinct else end except false fetch for foreign freeze from full grant group ' +
  'having ilike initially inner intersect into isnull join lateral leading left like limit localtime localtimestamp natural not ' +
  'notnull null offset only order outer overlaps placing primary references returning right select similar some symmetric table ' +
  'tablesample then trailing true union unique user using variadic verbose when where window with'
).split(' ');

/** Yorum satırına yazılan metin: satır sonu ve denetim karakteri SQL'e taşabilirdi (ad kayıttan gelir). */
const safeText = (s) => typeof s === 'string' && s.length > 0 && [...s].every((ch) => { const c = ch.codePointAt(0); return c > 0x1f && c !== 0x7f && c !== 0x2028 && c !== 0x2029; });

const KEY_RE = /^[a-z][a-z0-9]{2,19}$/;

/** Kiracı listesi: önce platform, sonra `deploy.api` olan araçlar (kayıt sırası). */
export function dbTenants(entries) {
  const out = [{ key: 'platform', owner: "Hesap migration'ı", app: 'Hesap servisi (account-api)' }];
  for (const e of entries) {
    if (!e.deploy?.api) continue;
    if (!KEY_RE.test(e.key)) throw new Error(`${e.key}: veritabanı adı olamaz (anahtar biçimi)`);
    if (DB_RESERVED_KEYS.includes(e.key)) throw new Error(`${e.key}: veritabanında ayrılmış ad (şema/rol çakışır)`);
    if (PG_RESERVED_WORDS.includes(e.key)) throw new Error(`${e.key}: Postgres ayrılmış sözcüğü, şema adı olamaz`);
    if (!safeText(e.name)) throw new Error(`${e.key}: ad satır sonu ya da denetim karakteri içeriyor (SQL yorumuna yazılır)`);
    out.push({ key: e.key, owner: `${e.name} migration'ı`, app: `${e.name} API` });
  }
  return out;
}

export const adminRole = (k) => `sod_${k}_admin`;
export const appRole = (k) => `sod_${k}`;
/** Ortam değişkeni adları: compose, .env, yedek betikleri aynı adı kullanır. */
export const adminPasswordEnv = (k) => `SOD_${k.toUpperCase()}_ADMIN_DB_PASSWORD`;
export const appPasswordEnv = (k) => `SOD_${k.toUpperCase()}_DB_PASSWORD`;

/** Bir kiracının iki rolü: önce bütün migration rolleri, sonra bütün uygulama rolleri (kurulumdaki sıra). */
function roles(tenants) {
  return [
    ...tenants.map((t) => ({ name: adminRole(t.key), env: adminPasswordEnv(t.key), psqlVar: `${adminRole(t.key)}_password`, tenant: t, admin: true })),
    ...tenants.map((t) => ({ name: appRole(t.key), env: appPasswordEnv(t.key), psqlVar: `${appRole(t.key)}_password`, tenant: t, admin: false })),
  ];
}

/** psql: ortamdan parola, yoksa yalnız geliştirme için `<rol>_dev`. */
function passwordVars(list) {
  const out = [];
  for (const r of list) {
    out.push(`\\getenv ${r.psqlVar} ${r.env}`, `\\if :{?${r.psqlVar}}`, '\\else', `  \\set ${r.psqlVar} '${r.name}_dev'`, '\\endif');
  }
  return out;
}

/**
 * Parola taşıyan ifadeler bu oturumda sunucu günlüğüne yazılmaz: sunucu log_statement=all/ddl ile açılmış olsa da, ifade hata
 * verse de (log_min_error_statement) ya da yavaş sayılsa da. Süper kullanıcı ayarları; yalnız bu oturum için.
 */
const LOG_OFF = [
  '-- Parola taşıyan ifadeler sunucu günlüğüne düşmesin (hata ya da log_statement ayarı ne olursa olsun); yalnız bu oturum.',
  "SET log_statement = 'none';",
  'SET log_min_error_statement = panic;',
  'SET log_min_duration_statement = -1;',
];

/** Kurulum yorumundaki ve verify.sh'nin okuduğu şema satırı. */
export const SCHEMAS_MARK = '-- @sod-schemas';

export function renderInitSql(entries, generatedNote) {
  const tenants = dbTenants(entries);
  const all = roles(tenants);
  const apps = all.filter((r) => !r.admin);
  const admins = all.filter((r) => r.admin);
  const width = Math.max(...all.map((r) => r.name.length));
  const pad = (s) => s.padEnd(width + 2);
  const L = [
    `-- ${generatedNote}`,
    '-- SellerOnData veritabanı kurulumu. Postgres imajı bunu yalnız boş hacimde bir kez, süper kullanıcıyla çalıştırır.',
    '-- Var olan hacim için: upgrade.sql (compose\'da postgres-upgrade). Sözleşme: docs/ARCHITECTURE.md §4.',
    '-- Kiracılar: platform ve `deploy.api` alanı olan her araç (verify.sh şema listesini bir alttaki satırdan okur).',
    `${SCHEMAS_MARK} ${tenants.map((t) => t.key).join(' ')}`,
    '--',
    ...admins.map((r) => `--   ${pad(r.name)}\`${r.tenant.key}\` şemasının sahibi. ${r.tenant.owner} bununla çalışır. Başka şemayı göremez.`),
    ...apps.map((r) => `--   ${pad(r.name)}${r.tenant.app}. Yalnız \`${r.tenant.key}\` şemasında veri okuma/yazma. DDL yok.`),
    '--',
    '-- Veritabanının sahibi süper kullanıcıdır. Hiçbir rolde CREATEDB, CREATEROLE, BYPASSRLS yoktur.',
    '-- Parolalar ortamdan gelir. Değişken yoksa yalnız geliştirme için varsayılan kullanılır.',
    '-- SOD_ENV=production iken `*_dev` parolası kurulumu durdurur (docker-compose.prod.yml bunu ayarlar).',
    '',
    '\\set ON_ERROR_STOP on',
    ...LOG_OFF,
    '',
    '\\getenv sod__env SOD_ENV',
    '\\if :{?sod__env}',
    '\\else',
    "  \\set sod__env 'development'",
    '\\endif',
    '\\getenv sod__su_password POSTGRES_PASSWORD',
    '\\if :{?sod__su_password}',
    '\\else',
    "  \\set sod__su_password ''",
    '\\endif',
    ...passwordVars(all),
    '',
    "SELECT :'sod__env' = 'production' AND EXISTS (",
    `  SELECT 1 FROM unnest(ARRAY[:'sod__su_password', ${all.map((r) => `:'${r.psqlVar}'`).join(', ')}]) AS p`,
    "  WHERE p LIKE '%\\_dev'",
    ') AS sod__refuse \\gset',
    '\\if :sod__refuse',
    "  DO $$ BEGIN RAISE EXCEPTION 'Üretimde geliştirme parolası kullanılamaz (*_dev). SOD_*_DB_PASSWORD değerlerini ayarlayın.'; END $$;",
    '\\endif',
    '',
    ...all.map((r) => `CREATE ROLE ${r.name} LOGIN PASSWORD :'${r.psqlVar}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`),
    '',
    '-- search_path rol ayarıdır: ad çözümlemesi kendi şemasında başlar, `public`e düşmez. Rol bu ayarı kendisi değiştirebilir',
    "-- (Postgres izin verir); upgrade.sql her koşuda baştan yazar. Ayrım şema haklarına dayanır, search_path'e değil.",
    ...all.map((r) => `ALTER ROLE ${r.name} SET search_path = ${r.tenant.key}, pg_temp;`),
    '',
    '-- Süre karşılaştırmaları UTC varsayar. Uygulama bağlantısı da ayrıca UTC ister: bu, ham istemcilere karşı ikinci kat.',
    ...apps.map((r) => `ALTER ROLE ${r.name} SET timezone = 'UTC';`),
    '',
    '-- Uygulama rolleri başka veritabanına bağlanamaz (TEMP tablo, katalog taraması).',
    'REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;',
    'REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;',
    '',
    "CREATE DATABASE sellerondata ENCODING 'UTF8' TEMPLATE template0;",
    '',
    '\\connect sellerondata',
    '',
    '-- @db-setup-begin',
    '-- Bu işaretin altı veritabanı başınadır. Testler aynı bölümü test veritabanına uygular; psql komutu içermez.',
    '-- Tekrar çalıştırılabilir. Veritabanının sahibi süper kullanıcı olmalı.',
    'DO $$',
    'BEGIN',
    "  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());",
    `  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${all.map((r) => r.name).join(', ')}', current_database());`,
    'END $$;',
    '',
    '-- `public` kimsenin çalışma alanı değil.',
    'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
    '',
    ...tenants.map((t) => `CREATE SCHEMA IF NOT EXISTS ${t.key} AUTHORIZATION ${adminRole(t.key)};`),
    '',
    ...tenants.map((t) => `REVOKE ALL ON SCHEMA ${t.key} FROM PUBLIC;`),
    '',
    '-- Her uygulama rolü yalnız kendi şemasını görür. CREATE yoktur. Migration rolü de karşı şemayı görmez.',
    ...tenants.map((t) => `GRANT USAGE ON SCHEMA ${t.key} TO ${appRole(t.key)};`),
    '',
    '-- Migration rolünün bundan sonra açacağı nesneler için hak otomatik gelir.',
  ];
  tenants.forEach((t, i) => {
    if (i > 0) L.push('');
    const head = `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole(t.key)} IN SCHEMA ${t.key}`;
    L.push(
      head,
      `  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole(t.key)};`,
      head,
      `  GRANT USAGE, SELECT ON SEQUENCES TO ${appRole(t.key)};`,
      head,
      `  GRANT EXECUTE ON FUNCTIONS TO ${appRole(t.key)};`,
    );
  });
  L.push(
    '',
    '-- İşlevlerde varsayılan PUBLIC EXECUTE kapalı: şema sınırı işlev yoluyla delinmesin.',
    ...admins.map((r) => `ALTER DEFAULT PRIVILEGES FOR ROLE ${r.name} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`),
    '',
    '-- Büyük nesne deposu şema dışıdır, RLS ve GRANT\'lerin arasından veri taşır. Kullanılmıyor, kapalı.',
    'REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea), lo_put(oid, bigint, bytea) FROM PUBLIC;',
    '-- `pg_notify` işlevi kapalı. `NOTIFY` komutu GRANT ile kapatılamaz (ARCHITECTURE §4, kalan riskler).',
    'REVOKE EXECUTE ON FUNCTION pg_notify(text, text) FROM PUBLIC;',
    '-- @db-setup-end',
    '',
  );
  return L.join('\n');
}

/**
 * Kiracı listesinde olmayan `sod_` rolleri (kayıttan çıkmış araç, eski `sod_admin`, test kurulumunun açtığı `sod_ornekarac*`)
 * yalnız hiçbir nesnesi ve hakkı yoksa silinir: kümenin hiçbir veritabanında sahipliği, hak ya da varsayılan hak kaydı
 * (`pg_shdepend`) olmamalı. Nesnesi ya da hakkı olan rol kalır (veri silinmez); silinemeyen rol betiği durdurmaz.
 */
function orphanRoleCleanup(all) {
  return [
    "-- Kayıtta olmayan ve kümede hiçbir nesnesi, hakkı olmayan sod_ rolleri silinir (kalıntı: kayıttan çıkmış araç, test rolü).",
    '-- Nesnesi ya da hakkı olan rol (başka veritabanında da) kalır; silinemeyen rol betiği durdurmaz.',
    'DO $$',
    'DECLARE',
    '  r record;',
    'BEGIN',
    '  FOR r IN',
    '    SELECT a.rolname FROM pg_roles a',
    "    WHERE a.rolname LIKE 'sod\\_%'",
    `      AND a.rolname NOT IN (${all.map((x) => `'${x.name}'`).join(', ')})`,
    "      AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = a.oid)",
    '    ORDER BY 1',
    '  LOOP',
    '    BEGIN',
    "      EXECUTE format('DROP ROLE %I', r.rolname);",
    "      RAISE NOTICE 'kayıtta olmayan boş rol silindi: %', r.rolname;",
    '    EXCEPTION WHEN dependent_objects_still_exist OR object_in_use THEN',
    "      RAISE NOTICE 'rol silinemedi, kalıyor: %', r.rolname;",
    '    END;',
    '  END LOOP;',
    'END $$;',
  ];
}

export function renderUpgradeSql(entries, generatedNote) {
  const tenants = dbTenants(entries);
  const all = roles(tenants);
  const apps = all.filter((r) => !r.admin);
  const values = all.map((r) => `('${r.name}', :'${r.psqlVar}')`).join(', ');
  const L = [
    `-- ${generatedNote}`,
    '-- Var olan hacmi güncel rol düzenine getirir. Veri silmez. Tekrar çalıştırılabilir.',
    '-- Süper kullanıcıyla, `sellerondata` veritabanına bağlı çalışır: docker compose run --rm postgres-upgrade',
    '-- Boş hacimde init.sql kurulumu zaten bu durumdadır; bu betik orada hiçbir şey değiştirmez.',
    '-- Kayda yeni eklenen aracın rolleri ve şeması burada açılır (init.sql yalnız boş hacimde çalışır).',
    '-- Parolalar yalnız rol yeni açılırken kullanılır, var olan parola değişmez.',
    '-- SOD_ENV=production iken yeni açılacak rolün parolası `*_dev` ise betik durur (var olan rol etkilenmez).',
    '',
    '\\set ON_ERROR_STOP on',
    ...LOG_OFF,
    '',
    '\\getenv sod__env SOD_ENV',
    '\\if :{?sod__env}',
    '\\else',
    "  \\set sod__env 'development'",
    '\\endif',
    ...passwordVars(all),
    '',
    "SELECT :'sod__env' = 'production' AND EXISTS (",
    `  SELECT 1 FROM (VALUES ${values}) AS r(name, password)`,
    "  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) AND r.password LIKE '%\\_dev'",
    ') AS sod__refuse \\gset',
    '\\if :sod__refuse',
    "  DO $$ BEGIN RAISE EXCEPTION 'Üretimde yeni rol geliştirme parolasıyla açılamaz (*_dev). SOD_*_DB_PASSWORD değerlerini ayarlayın.'; END $$;",
    '\\endif',
    '',
    "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r.name, r.password)",
    `FROM (VALUES ${values}) AS r(name, password)`,
    'WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) \\gexec',
    '',
    '-- Rol ayarları baştan yazılır: rolün kendi eklediği ayar (search_path, row_security…) kalmaz.',
    ...all.flatMap((r) => [`ALTER ROLE ${r.name} RESET ALL;`, `ALTER ROLE ${r.name} SET search_path = ${r.tenant.key}, pg_temp;`]),
    '',
    ...apps.map((r) => `ALTER ROLE ${r.name} SET timezone = 'UTC';`),
    '',
    'REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;',
    'REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;',
    '',
    'ALTER DATABASE sellerondata OWNER TO postgres;',
    '',
    '-- Şema ve içindeki her nesnenin sahipliği ürünün migration rolüne geçer.',
    'DO $$',
    'DECLARE',
    '  pair record;',
    '  obj record;',
    'BEGIN',
    `  FOR pair IN SELECT * FROM (VALUES ${tenants.map((t) => `('${t.key}', '${adminRole(t.key)}')`).join(', ')}) AS t(schema_name, owner_name) LOOP`,
    '    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = pair.schema_name) THEN',
    '      CONTINUE;',
    '    END IF;',
    "    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', pair.schema_name, pair.owner_name);",
    '    FOR obj IN',
    '      SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace',
    "      WHERE n.nspname = pair.schema_name AND c.relkind IN ('r', 'p', 'v', 'm', 'f')",
    '    LOOP',
    "      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', pair.schema_name, obj.relname, pair.owner_name);",
    '    END LOOP;',
    '    FOR obj IN',
    '      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace',
    "      WHERE n.nspname = pair.schema_name AND c.relkind = 'S'",
    "        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))",
    '    LOOP',
    "      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', pair.schema_name, obj.relname, pair.owner_name);",
    '    END LOOP;',
    '    FOR obj IN',
    '      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace',
    "      WHERE n.nspname = pair.schema_name AND t.typtype IN ('e', 'd')",
    '    LOOP',
    "      EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', pair.schema_name, obj.typname, pair.owner_name);",
    '    END LOOP;',
    '    FOR obj IN',
    '      SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace',
    '      WHERE n.nspname = pair.schema_name',
    '    LOOP',
    "      EXECUTE format('ALTER ROUTINE %s OWNER TO %I', obj.signature, pair.owner_name);",
    '    END LOOP;',
    '  END LOOP;',
    'END $$;',
    '',
    '-- Eski ortak rol bu veritabanında hiçbir şeye sahip değil. Başka test veritabanı ona aitse rol kalır, burada yetkisi yoktur.',
    'DO $$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sod_admin') THEN",
    "    EXECUTE 'DROP OWNED BY sod_admin';",
    "    EXECUTE 'ALTER ROLE sod_admin NOCREATEDB';",
    '  END IF;',
    'END $$;',
    '',
    ...orphanRoleCleanup(all),
    '',
    '-- Hak ve varsayılanlar: init.sql\'in veritabanı başına bölümü, kopyasız.',
    '-- Sondaki # bilerek: Windows klonunda satır CRLF olursa kabuk satır sonunu dosya adına katardı ve kurulum dururdu.',
    "\\! sed -n '/@db-setup-begin/,/@db-setup-end/p' /infra/postgres/init.sql > /tmp/sod-db-setup.sql #",
    '\\i /tmp/sod-db-setup.sql',
    '',
    '-- Migration geçmişi uygulama rolüne kapalı.',
    'DO $$',
    'BEGIN',
  ];
  for (const t of tenants) {
    L.push(
      `  IF to_regclass('${t.key}."_prisma_migrations"') IS NOT NULL THEN`,
      `    EXECUTE 'REVOKE ALL ON TABLE ${t.key}."_prisma_migrations" FROM ${appRole(t.key)}';`,
      '  END IF;',
    );
  }
  L.push(
    'END $$;',
    '',
    '-- Üretimde hiçbir rol geliştirme parolasıyla girememeli: her role ağ üzerinden <rol>_dev ile girmek denenir (dev-parola.sh).',
    '-- Sunucu parolayı sınamıyorsa (yerel soket, 127.0.0.1 trust) da durur: upgrade.sql ağ adresiyle çalıştırılmalı.',
    "SELECT :'sod__env' = 'production' AS sod__production \\gset",
    '\\if :sod__production',
    '  \\setenv SOD_PGHOST :HOST',
    '  \\setenv SOD_PGPORT :PORT',
    '  \\setenv SOD_PGDB :DBNAME',
    '  \\setenv SOD_PGUSER :USER',
    '  \\! sh /infra/postgres/dev-parola.sh #',
    '  \\if :SHELL_ERROR',
    "    DO $$ BEGIN RAISE EXCEPTION 'Üretimde geliştirme parolasıyla giren rol var ya da parola sınanamadı (dev-parola.sh çıktısı yukarıda). Parolayı ALTER ROLE ile değiştirin.'; END $$;",
    '  \\endif',
    '\\endif',
    '',
  );
  return L.join('\n');
}
