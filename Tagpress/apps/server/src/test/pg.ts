import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inject } from "vitest";
import { resolveTestDbHost } from "../../../../../scripts/lib/pg-guard.mjs";
import { PG_ADMIN_ROLE, PG_APP_ROLE, PG_SCHEMA, migratePgUrl } from "../db/pg/migrate.ts";

/**
 * Postgres test veritabanları (plan §7; `pnpm test:pg`, `vitest.pg.config.ts`).
 * - Küme: `TEST_DB_HOST` (yoksa proje kuralı, `scripts/lib/pg-guard.mjs`: gerçek kullanım işareti varsa 5435, yoksa 5434;
 *   gerçek veriye bağlanılmaz), süper kullanıcı `TEST_SUPER_URL` ya da `postgres`/`sod_postgres_dev`. Roller
 *   (`sod_tagpress_admin`, `sod_tagpress`) kümede hazırdır (`Platform/infra/postgres/init.sql` / `upgrade.sql`).
 * - Şablon: koşu başına bir kez (`pg-global-setup.ts`) `tagpress_test_<pid>_<rastgele>_tmpl`: init.sql'in veritabanı
 *   başına bölümü (`@db-setup-begin` … `-end`) + TagPress göçleri (göç rolüyle, `db/pg/migrate.ts`) + test eki (`orgs`).
 * - Her test uygulaması / test dosyası şablondan YENİ veritabanı alır (`createTestDb`), bitişte siler. Ad
 *   `tagpress_test_<pid>_<rastgele>`; incelemek için `TEST_DB_KEEP=1` (silinmez, ad konsola yazılır).
 *
 * Test eki (`orgs`): yerel kipin kurulum tablosu Postgres şemasında yoktur (firma kaydı product-kit `Company`; platform
 * kipinde `PlatformOrgService`). Servis testleri yerel çözücüyle (tek kurulum, `OrgService`) koştuğu için test
 * veritabanına aynı biçimde `orgs` eklenir; eklenen her firma için `Company` satırı tetikleyiciyle açılır (yabancı anahtar
 * ve RLS ilkeleri gerçek hâliyle çalışsın). Bu ek yalnız test şablonunda vardır.
 */

export const PG_TEST_PREFIX = "tagpress_test_";

/** `pnpm test:pg` koşusu mu (`TAGPRESS_TEST_DB=pg`). */
export function pgTestMode(): boolean {
  return process.env.TAGPRESS_TEST_DB === "pg";
}

export function testSuperUrl(): string {
  return process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${resolveTestDbHost()}/postgres`;
}

export type TestRole = "super" | "admin" | "app";

const ROLE_PASSWORD: Record<Exclude<TestRole, "super">, { name: string; env: string }> = {
  admin: { name: PG_ADMIN_ROLE, env: "SOD_TAGPRESS_ADMIN_DB_PASSWORD" },
  app: { name: PG_APP_ROLE, env: "SOD_TAGPRESS_DB_PASSWORD" },
};

/** Veritabanı adresi: süper kullanıcı (testin gözü, RLS'yi aşar), göç rolü ya da uygulama rolü. */
export function testDbUrl(db: string, role: TestRole = "app"): string {
  const u = new URL(testSuperUrl());
  u.pathname = `/${db}`;
  if (role !== "super") {
    const r = ROLE_PASSWORD[role];
    u.username = r.name;
    u.password = process.env[r.env] ?? `${r.name}_dev`;
  }
  return u.toString();
}

const ident = (s: string) => {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`Geçersiz veritabanı adı: ${s}`);
  return `"${s}"`;
};

async function withSuper<T>(fn: (c: pg.Client) => Promise<T>, db = "postgres"): Promise<T> {
  const c = new pg.Client({ connectionString: testDbUrl(db, "super") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** init.sql'in veritabanı başına bölümü (üretilmiş dosyadan okunur; kopya SQL tutulmaz). */
function dbSetupSql(): string {
  const init = readFileSync(new URL("../../../../../Platform/infra/postgres/init.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = init.indexOf("-- @db-setup-begin");
  const end = init.indexOf("-- @db-setup-end");
  if (start < 0 || end < 0) throw new Error("init.sql'de @db-setup işaretleri yok");
  return init.slice(start, end);
}

/** Test eki: yerel kipin `orgs` kurulum tablosu ve `Company` eşlemesi (yukarıdaki not). */
export const TEST_ORGS_SQL = `
CREATE TABLE ${PG_SCHEMA}.orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('local', 'account')),
  created_at text NOT NULL,
  closed_at text,
  purged_at text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ${PG_SCHEMA}.orgs TO ${PG_APP_ROLE};
CREATE FUNCTION ${PG_SCHEMA}.test_orgs_company() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${PG_SCHEMA}, pg_temp AS $$
BEGIN
  INSERT INTO ${PG_SCHEMA}."Company" ("id", "name") VALUES (NEW.id, NEW.name) ON CONFLICT ("id") DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER orgs_company AFTER INSERT ON ${PG_SCHEMA}.orgs FOR EACH ROW EXECUTE FUNCTION ${PG_SCHEMA}.test_orgs_company();
CREATE FUNCTION ${PG_SCHEMA}.test_orgs_company_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${PG_SCHEMA}, pg_temp AS $$
BEGIN
  UPDATE ${PG_SCHEMA}."Company" SET "name" = NEW.name, "closedAt" = NEW.closed_at::timestamptz WHERE "id" = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER orgs_company_update AFTER UPDATE ON ${PG_SCHEMA}.orgs FOR EACH ROW EXECUTE FUNCTION ${PG_SCHEMA}.test_orgs_company_update();
`;

export interface TemplateOptions {
  /** Göçler uygulansın mı (varsayılan evet). Hayır: yalnız şema ve roller (göç testleri). */
  migrate?: boolean;
  /** Test eki `orgs` (varsayılan evet; göçlerle birlikte). */
  orgs?: boolean;
}

/** Boş veritabanı + init.sql bölümü (+ göçler + test eki). Dönen değer adı. */
export async function createSchemaDb(name: string, opts: TemplateOptions = {}): Promise<string> {
  await withSuper(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${ident(name)}`);
  });
  await withSuper((c) => c.query(dbSetupSql()), name);
  if (opts.migrate !== false) {
    await migratePgUrl(testDbUrl(name, "admin"));
    if (opts.orgs !== false) await withSuper((c) => c.query(TEST_ORGS_SQL), name);
  }
  return name;
}

/** Koşu etiketi (genel kurulum verir): bitişte bu koşunun kalmış veritabanları da silinir. */
function runTag(): string {
  try {
    return (inject("tagpressPgRun" as never) as string | undefined) ?? "";
  } catch {
    return "";
  }
}

/** `tagpress_test_[<koşu>_]<pid>_<rastgele>[<ek>]`. */
export function newTestDbName(suffix = "", tag = runTag()): string {
  return `${PG_TEST_PREFIX}${tag ? `${tag}_` : ""}${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}${suffix}`;
}

let localTemplate: Promise<string> | null = null;

/** Koşunun şablonu: genel kurulumdan (`inject`), yoksa bu süreçte bir kez kurulur (süreç sonunda silinmez; uyarı). */
function templateName(): Promise<string> {
  let provided: string | undefined;
  try {
    provided = inject("tagpressPgTemplate" as never) as string | undefined;
  } catch {
    provided = undefined;
  }
  if (provided) return Promise.resolve(provided);
  localTemplate ??= createSchemaDb(newTestDbName("_tmpl")).then((n) => {
    console.warn(`UYARI: Postgres test şablonu genel kurulum olmadan açıldı (${n}); vitest.pg.config.ts ile koşun.`);
    return n;
  });
  return localTemplate;
}

export interface TestPgDb {
  name: string;
  /** Uygulama rolü (`sod_tagpress`, RLS altında). */
  appUrl: string;
  /** Göç rolü (şemanın sahibi). */
  adminUrl: string;
  /** Süper kullanıcı (RLS'yi aşar; testin kendi denetimleri). */
  superUrl: string;
  drop(): Promise<void>;
}

/**
 * Yeni test veritabanı. Varsayılan: koşunun şablonundan (göçler + test eki hazır). `template: false`: boş (yalnız init.sql
 * bölümü; `migrate`/`orgs` ile ayrıca kurulabilir).
 */
export async function createTestDb(opts: { template?: boolean } & TemplateOptions = {}): Promise<TestPgDb> {
  const name = newTestDbName();
  if (opts.template === false) await createSchemaDb(name, { migrate: opts.migrate ?? false, orgs: opts.orgs ?? false });
  else {
    const tmpl = await templateName();
    await withSuper((c) => c.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(tmpl)}`));
  }
  return testDbHandle(name);
}

/** Var olan test veritabanının adresleri ve silme işlevi (veritabanı açmaz). */
export function testDbHandle(name: string): TestPgDb {
  let dropped = false;
  return {
    name,
    appUrl: testDbUrl(name, "app"),
    adminUrl: testDbUrl(name, "admin"),
    superUrl: testDbUrl(name, "super"),
    drop: async () => {
      if (dropped) return;
      dropped = true;
      if (process.env.TEST_DB_KEEP === "1") {
        console.log(`Test veritabanı bırakıldı: ${name}`);
        return;
      }
      await dropTestDb(name);
    },
  };
}

export async function dropTestDb(name: string): Promise<void> {
  await withSuper((c) => c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
}

/** Kümedeki TagPress test veritabanlarının adları. */
export async function listTestDbs(): Promise<string[]> {
  return withSuper(async (c) => (await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [PG_TEST_PREFIX])).rows.map((r) => r.datname));
}

/** Verilen önekin kalmış test veritabanlarını siler (genel kurulum bitişi). */
export async function dropTestDbs(prefix: string): Promise<string[]> {
  return withSuper(async (c) => {
    const rows = (await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [prefix])).rows;
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS ${ident(r.datname)} WITH (FORCE)`);
    return rows.map((r) => r.datname);
  });
}
