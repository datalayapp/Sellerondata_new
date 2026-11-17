-- ÜRETİLDİ: Platform/scripts/products-gen.mjs (kaynak contracts/src/products.ts). Elle düzenlemeyin.
-- SellerOnData veritabanı kurulumu. Postgres imajı bunu yalnız boş hacimde bir kez, süper kullanıcıyla çalıştırır.
-- Var olan hacim için: upgrade.sql (compose'da postgres-upgrade). Sözleşme: docs/ARCHITECTURE.md §4.
-- Kiracılar: platform ve `deploy.api` alanı olan her araç (verify.sh şema listesini bir alttaki satırdan okur).
-- @sod-schemas platform deciship
--
--   sod_platform_admin  `platform` şemasının sahibi. Hesap migration'ı bununla çalışır. Başka şemayı göremez.
--   sod_deciship_admin  `deciship` şemasının sahibi. DeciShip migration'ı bununla çalışır. Başka şemayı göremez.
--   sod_platform        Hesap servisi (account-api). Yalnız `platform` şemasında veri okuma/yazma. DDL yok.
--   sod_deciship        DeciShip API. Yalnız `deciship` şemasında veri okuma/yazma. DDL yok.
--
-- Veritabanının sahibi süper kullanıcıdır. Hiçbir rolde CREATEDB, CREATEROLE, BYPASSRLS yoktur.
-- Parolalar ortamdan gelir. Değişken yoksa yalnız geliştirme için varsayılan kullanılır.
-- SOD_ENV=production iken `*_dev` parolası kurulumu durdurur (docker-compose.prod.yml bunu ayarlar).

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
\getenv sod__su_password POSTGRES_PASSWORD
\if :{?sod__su_password}
\else
  \set sod__su_password ''
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
  SELECT 1 FROM unnest(ARRAY[:'sod__su_password', :'sod_platform_admin_password', :'sod_deciship_admin_password', :'sod_platform_password', :'sod_deciship_password']) AS p
  WHERE p LIKE '%\_dev'
) AS sod__refuse \gset
\if :sod__refuse
  DO $$ BEGIN RAISE EXCEPTION 'Üretimde geliştirme parolası kullanılamaz (*_dev). SOD_*_DB_PASSWORD değerlerini ayarlayın.'; END $$;
\endif

CREATE ROLE sod_platform_admin LOGIN PASSWORD :'sod_platform_admin_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE sod_deciship_admin LOGIN PASSWORD :'sod_deciship_admin_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE sod_platform LOGIN PASSWORD :'sod_platform_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE sod_deciship LOGIN PASSWORD :'sod_deciship_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- search_path rol ayarıdır: ad çözümlemesi kendi şemasında başlar, `public`e düşmez. Rol bu ayarı kendisi değiştirebilir
-- (Postgres izin verir); upgrade.sql her koşuda baştan yazar. Ayrım şema haklarına dayanır, search_path'e değil.
ALTER ROLE sod_platform_admin SET search_path = platform, pg_temp;
ALTER ROLE sod_deciship_admin SET search_path = deciship, pg_temp;
ALTER ROLE sod_platform SET search_path = platform, pg_temp;
ALTER ROLE sod_deciship SET search_path = deciship, pg_temp;

-- Süre karşılaştırmaları UTC varsayar. Uygulama bağlantısı da ayrıca UTC ister: bu, ham istemcilere karşı ikinci kat.
ALTER ROLE sod_platform SET timezone = 'UTC';
ALTER ROLE sod_deciship SET timezone = 'UTC';

-- Uygulama rolleri başka veritabanına bağlanamaz (TEMP tablo, katalog taraması).
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;

CREATE DATABASE sellerondata ENCODING 'UTF8' TEMPLATE template0;

\connect sellerondata

-- @db-setup-begin
-- Bu işaretin altı veritabanı başınadır. Testler aynı bölümü test veritabanına uygular; psql komutu içermez.
-- Tekrar çalıştırılabilir. Veritabanının sahibi süper kullanıcı olmalı.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sod_platform_admin, sod_deciship_admin, sod_platform, sod_deciship', current_database());
END $$;

-- `public` kimsenin çalışma alanı değil.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION sod_platform_admin;
CREATE SCHEMA IF NOT EXISTS deciship AUTHORIZATION sod_deciship_admin;

REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON SCHEMA deciship FROM PUBLIC;

-- Her uygulama rolü yalnız kendi şemasını görür. CREATE yoktur. Migration rolü de karşı şemayı görmez.
GRANT USAGE ON SCHEMA platform TO sod_platform;
GRANT USAGE ON SCHEMA deciship TO sod_deciship;

-- Migration rolünün bundan sonra açacağı nesneler için hak otomatik gelir.
ALTER DEFAULT PRIVILEGES FOR ROLE sod_platform_admin IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sod_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE sod_platform_admin IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO sod_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE sod_platform_admin IN SCHEMA platform
  GRANT EXECUTE ON FUNCTIONS TO sod_platform;

ALTER DEFAULT PRIVILEGES FOR ROLE sod_deciship_admin IN SCHEMA deciship
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sod_deciship;
ALTER DEFAULT PRIVILEGES FOR ROLE sod_deciship_admin IN SCHEMA deciship
  GRANT USAGE, SELECT ON SEQUENCES TO sod_deciship;
ALTER DEFAULT PRIVILEGES FOR ROLE sod_deciship_admin IN SCHEMA deciship
  GRANT EXECUTE ON FUNCTIONS TO sod_deciship;

-- İşlevlerde varsayılan PUBLIC EXECUTE kapalı: şema sınırı işlev yoluyla delinmesin.
ALTER DEFAULT PRIVILEGES FOR ROLE sod_platform_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE sod_deciship_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Büyük nesne deposu şema dışıdır, RLS ve GRANT'lerin arasından veri taşır. Kullanılmıyor, kapalı.
REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea), lo_put(oid, bigint, bytea) FROM PUBLIC;
-- `pg_notify` işlevi kapalı. `NOTIFY` komutu GRANT ile kapatılamaz (ARCHITECTURE §4, kalan riskler).
REVOKE EXECUTE ON FUNCTION pg_notify(text, text) FROM PUBLIC;
-- @db-setup-end
