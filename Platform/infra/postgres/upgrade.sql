-- ÜRETİLDİ: Platform/scripts/products-gen.mjs (kaynak contracts/src/products.ts). Elle düzenlemeyin.
-- Var olan hacmi güncel rol düzenine getirir. Veri silmez. Tekrar çalıştırılabilir.
-- Süper kullanıcıyla, `sellerondata` veritabanına bağlı çalışır: docker compose run --rm postgres-upgrade
-- Boş hacimde init.sql kurulumu zaten bu durumdadır; bu betik orada hiçbir şey değiştirmez.
-- Kayda yeni eklenen aracın rolleri ve şeması burada açılır (init.sql yalnız boş hacimde çalışır).
-- Parolalar yalnız rol yeni açılırken kullanılır, var olan parola değişmez.
-- SOD_ENV=production iken yeni açılacak rolün parolası `*_dev` ise betik durur (var olan rol etkilenmez).

\set ON_ERROR_STOP on
-- Parola taşıyan ifadeler sunucu günlüğüne düşmesin (hata ya da log_statement ayarı ne olursa olsun); yalnız bu oturum.
SET log_statement = 'none';
SET log_min_error_statement = panic;
SET log_min_duration_statement = -1;

\getenv sod__env SOD_ENV
\if :{?sod__env}
\else
  \set sod__env 'development'
\endif
\getenv sod_platform_admin_password SOD_PLATFORM_ADMIN_DB_PASSWORD
\if :{?sod_platform_admin_password}
\else
  \set sod_platform_admin_password 'sod_platform_admin_dev'
\endif
\getenv sod_deciship_admin_password SOD_DECISHIP_ADMIN_DB_PASSWORD
\if :{?sod_deciship_admin_password}
\else
  \set sod_deciship_admin_password 'sod_deciship_admin_dev'
\endif
\getenv sod_platform_password SOD_PLATFORM_DB_PASSWORD
\if :{?sod_platform_password}
\else
  \set sod_platform_password 'sod_platform_dev'
\endif
\getenv sod_deciship_password SOD_DECISHIP_DB_PASSWORD
\if :{?sod_deciship_password}
\else
  \set sod_deciship_password 'sod_deciship_dev'
\endif

SELECT :'sod__env' = 'production' AND EXISTS (
  SELECT 1 FROM (VALUES ('sod_platform_admin', :'sod_platform_admin_password'), ('sod_deciship_admin', :'sod_deciship_admin_password'), ('sod_platform', :'sod_platform_password'), ('sod_deciship', :'sod_deciship_password')) AS r(name, password)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) AND r.password LIKE '%\_dev'
) AS sod__refuse \gset
\if :sod__refuse
  DO $$ BEGIN RAISE EXCEPTION 'Üretimde yeni rol geliştirme parolasıyla açılamaz (*_dev). SOD_*_DB_PASSWORD değerlerini ayarlayın.'; END $$;
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r.name, r.password)
FROM (VALUES ('sod_platform_admin', :'sod_platform_admin_password'), ('sod_deciship_admin', :'sod_deciship_admin_password'), ('sod_platform', :'sod_platform_password'), ('sod_deciship', :'sod_deciship_password')) AS r(name, password)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) \gexec

-- Rol ayarları baştan yazılır: rolün kendi eklediği ayar (search_path, row_security…) kalmaz.
ALTER ROLE sod_platform_admin RESET ALL;
ALTER ROLE sod_platform_admin SET search_path = platform, pg_temp;
ALTER ROLE sod_deciship_admin RESET ALL;
ALTER ROLE sod_deciship_admin SET search_path = deciship, pg_temp;
ALTER ROLE sod_platform RESET ALL;
ALTER ROLE sod_platform SET search_path = platform, pg_temp;
ALTER ROLE sod_deciship RESET ALL;
ALTER ROLE sod_deciship SET search_path = deciship, pg_temp;

ALTER ROLE sod_platform SET timezone = 'UTC';
ALTER ROLE sod_deciship SET timezone = 'UTC';

REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;

ALTER DATABASE sellerondata OWNER TO postgres;

-- Şema ve içindeki her nesnenin sahipliği ürünün migration rolüne geçer.
DO $$
DECLARE
  pair record;
  obj record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES ('platform', 'sod_platform_admin'), ('deciship', 'sod_deciship_admin')) AS t(schema_name, owner_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = pair.schema_name) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', pair.schema_name, pair.owner_name);
    FOR obj IN
      SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = pair.schema_name AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    LOOP
      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', pair.schema_name, obj.relname, pair.owner_name);
    END LOOP;
    FOR obj IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = pair.schema_name AND c.relkind = 'S'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
    LOOP
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', pair.schema_name, obj.relname, pair.owner_name);
    END LOOP;
    FOR obj IN
      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = pair.schema_name AND t.typtype IN ('e', 'd')
    LOOP
      EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', pair.schema_name, obj.typname, pair.owner_name);
    END LOOP;
    FOR obj IN
      SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = pair.schema_name
    LOOP
      EXECUTE format('ALTER ROUTINE %s OWNER TO %I', obj.signature, pair.owner_name);
    END LOOP;
  END LOOP;
END $$;

-- Eski ortak rol bu veritabanında hiçbir şeye sahip değil. Başka test veritabanı ona aitse rol kalır, burada yetkisi yoktur.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sod_admin') THEN
    EXECUTE 'DROP OWNED BY sod_admin';
    EXECUTE 'ALTER ROLE sod_admin NOCREATEDB';
  END IF;
END $$;

-- Kayıtta olmayan ve kümede hiçbir nesnesi, hakkı olmayan sod_ rolleri silinir (kalıntı: kayıttan çıkmış araç, test rolü).
-- Nesnesi ya da hakkı olan rol (başka veritabanında da) kalır; silinemeyen rol betiği durdurmaz.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT a.rolname FROM pg_roles a
    WHERE a.rolname LIKE 'sod\_%'
      AND a.rolname NOT IN ('sod_platform_admin', 'sod_deciship_admin', 'sod_platform', 'sod_deciship')
      AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = a.oid)
    ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('DROP ROLE %I', r.rolname);
      RAISE NOTICE 'kayıtta olmayan boş rol silindi: %', r.rolname;
    EXCEPTION WHEN dependent_objects_still_exist OR object_in_use THEN
      RAISE NOTICE 'rol silinemedi, kalıyor: %', r.rolname;
    END;
  END LOOP;
END $$;

-- Hak ve varsayılanlar: init.sql'in veritabanı başına bölümü, kopyasız.
-- Sondaki # bilerek: Windows klonunda satır CRLF olursa kabuk satır sonunu dosya adına katardı ve kurulum dururdu.
\! sed -n '/@db-setup-begin/,/@db-setup-end/p' /infra/postgres/init.sql > /tmp/sod-db-setup.sql #
\i /tmp/sod-db-setup.sql

-- Migration geçmişi uygulama rolüne kapalı.
DO $$
BEGIN
  IF to_regclass('platform."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE platform."_prisma_migrations" FROM sod_platform';
  END IF;
  IF to_regclass('deciship."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE deciship."_prisma_migrations" FROM sod_deciship';
  END IF;
END $$;

-- Üretimde hiçbir rol geliştirme parolasıyla girememeli: her role ağ üzerinden <rol>_dev ile girmek denenir (dev-parola.sh).
-- Sunucu parolayı sınamıyorsa (yerel soket, 127.0.0.1 trust) da durur: upgrade.sql ağ adresiyle çalıştırılmalı.
SELECT :'sod__env' = 'production' AS sod__production \gset
\if :sod__production
  \setenv SOD_PGHOST :HOST
  \setenv SOD_PGPORT :PORT
  \setenv SOD_PGDB :DBNAME
  \setenv SOD_PGUSER :USER
  \! sh /infra/postgres/dev-parola.sh #
  \if :SHELL_ERROR
    DO $$ BEGIN RAISE EXCEPTION 'Üretimde geliştirme parolasıyla giren rol var ya da parola sınanamadı (dev-parola.sh çıktısı yukarıda). Parolayı ALTER ROLE ile değiştirin.'; END $$;
  \endif
\endif
