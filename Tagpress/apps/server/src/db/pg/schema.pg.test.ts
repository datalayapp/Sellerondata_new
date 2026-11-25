import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_REGISTRY } from "@sellerondata/contracts";
import { memberProjectionSql, pgDb, registerProductIdentity } from "@sellerondata/product-kit";
import { openDatabase } from "../database.ts";
import { PG_PURGE_TABLES, TENANT_TABLES } from "../../org/tables.ts";
import { checkTagpressGrants, IDENTITY_TABLES, QUEUE_POLICIES, QUEUE_SCOPE, ROWID_COLUMN, ROWID_TABLES, TAGPRESS_TABLE_PRIVILEGES } from "./grants.ts";
import { migratePg, migrationChecksum, PG_ADMIN_ROLE, PG_APP_ROLE, PG_MIGRATIONS_DIR, PG_SCHEMA, readPgMigrations } from "./migrate.ts";

/**
 * TagPress Postgres şeması (plan §S4, B4), gerçek Postgres ile: koşu başına açılıp silinen veritabanı (`tagpress_test_<pid>_<rastgele>`),
 * şema ve roller kayıttan üretilen init.sql'in veritabanı bölümüyle (`Platform/scripts/products-db.mjs`; roller kümede yoksa
 * init.sql satırıyla açılır), göç göç rolüyle (`sod_tagpress_admin`), uygulama uygulama rolüyle (`sod_tagpress`, FORCE RLS altında).
 * Adres `TEST_DB_HOST` (varsayılan `scripts/lib/pg-guard.mjs`: gerçek kullanım kümesine bağlanmaz). Postgres yoksa test düşer.
 */

const ROOT = new URL("../../../../../../", import.meta.url);
type PgGuard = { resolveTestDbHost(): string };
type ProductsDb = {
  renderInitSql(entries: readonly unknown[], note: string, services?: readonly unknown[]): string;
  adminPasswordEnv(key: string): string;
  appPasswordEnv(key: string): string;
};

const DB = `tagpress_test_${process.pid}_${randomUUID().slice(0, 6)}`;
let SUPER_URL = "";
const dbUrl = (user?: { name: string; password: string }) => {
  const u = new URL(SUPER_URL);
  u.pathname = `/${DB}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

/** Testin gözü: süper kullanıcı (RLS'yi aşar). */
let su: pg.Client;
/** Uygulama rolü (FORCE RLS). */
let app: pg.Pool;
let roles: { admin: { name: string; password: string }; app: { name: string; password: string } };

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

beforeAll(async () => {
  const guard = (await import(new URL("scripts/lib/pg-guard.mjs", ROOT).href)) as PgGuard;
  SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${guard.resolveTestDbHost()}/postgres`;
  const lib = (await import(new URL("Platform/scripts/products-db.mjs", ROOT).href)) as ProductsDb;
  const entry = PRODUCT_REGISTRY.find((e) => e.key === "tagpress");
  if (!entry) throw new Error("kayıtta tagpress yok");
  // Yalnız TagPress kiracısı: platform hizmet kiracıları (ör. `ai`) bu testin kurduğu rollerde yok.
  const init = lib.renderInitSql([entry], "TagPress şema testi", []).replace(/\r\n/g, "\n");
  const lines = init.split("\n");
  const role = (name: string, env: string) => ({ name, password: process.env[env] ?? `${name}_dev` });
  roles = { admin: role(PG_ADMIN_ROLE, lib.adminPasswordEnv("tagpress")), app: role(PG_APP_ROLE, lib.appPasswordEnv("tagpress")) };

  const root = new pg.Client({ connectionString: SUPER_URL });
  await root.connect();
  try {
    await root.query("BEGIN");
    await root.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["tagpress:test-roles"]);
    for (const r of [roles.admin, roles.app]) {
      const create = lines.find((l) => l.startsWith(`CREATE ROLE ${r.name} `));
      const placeholder = `:'${r.name}_password'`;
      if (!create?.includes(placeholder)) throw new Error(`init.sql üreteci ${r.name} satırını vermedi`);
      if ((await root.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [r.name])).rowCount === 0) await root.query(create.replace(placeholder, literal(r.password)));
      for (const s of lines.filter((l) => l.startsWith(`ALTER ROLE ${r.name} SET `))) await root.query(s);
    }
    await root.query("COMMIT");
    await root.query(`DROP DATABASE IF EXISTS "${DB}"`);
    await root.query(`CREATE DATABASE "${DB}"`);
  } catch (e) {
    await root.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await root.end();
  }
  const start = init.indexOf("-- @db-setup-begin");
  const end = init.indexOf("-- @db-setup-end");
  if (start < 0 || end < 0) throw new Error("init.sql üretecinde @db-setup işaretleri yok");
  su = new pg.Client({ connectionString: dbUrl() });
  await su.connect();
  await su.query(init.slice(start, end));

  const migrator = new pg.Client({ connectionString: dbUrl(roles.admin) });
  await migrator.connect();
  try {
    expect(await migratePg(migrator)).toEqual({ applied: ["0001-tagpress.sql"], skipped: [] });
  } finally {
    await migrator.end();
  }
  app = new pg.Pool({ connectionString: dbUrl(roles.app), max: 4 });
});

afterAll(async () => {
  await app?.end();
  await su?.end();
  if (!SUPER_URL) return;
  const root = new pg.Client({ connectionString: SUPER_URL });
  await root.connect();
  await root.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [DB]);
  await root.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await root.end();
});

// ------------------------------------------------------------------------------------------------ yardımcılar

/** Uygulama rolüyle tek işlem; `org` firma bağlamı, `scope` kapsam (işlem sonunda biter). */
async function asApp<T>(ctx: { org?: string; scope?: string }, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    if (ctx.org !== undefined) await c.query("SELECT set_config('app.org_id', $1, true)", [ctx.org]);
    if (ctx.scope) await c.query("SELECT set_config('app.scope', $1, true)", [ctx.scope]);
    const out = await work(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const AT = "2026-11-22T00:00:00.000Z";

/** Her kiracı tablosuna en az bir satır (ebeveynler önce: `TENANT_TABLES` ters sırası), süper kullanıcıyla. */
async function seedOrg(org: string, member: string | null = null): Promise<Record<string, string>> {
  await su.query(`INSERT INTO tagpress."Company"(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [org]);
  if (member) await su.query(`INSERT INTO tagpress."Member"(id, "orgId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [member, org]);
  const id = (p: string) => `${p}-${org}`;
  const rows: Record<string, Record<string, unknown>> = {
    org_settings: { key: "app", value: "{}" },
    languages: { id: id("dil"), name: "Dil", created_at: AT },
    profile_versions: { id: id("pv"), language_id: id("dil"), version: 1, status: "published", data: "{}", created_at: AT },
    templates: { language_id: id("dil"), key: "1", data: "{}", created_at: AT, updated_at: AT },
    undo: { token: id("u"), kind: "k", label: "l", payload: "{}", created_at: AT, expires_at: AT },
    ai_calls: { id: id("ai"), purpose: "design", model: "m", summary: "s", created_at: AT, member_id: member, response: Buffer.from("x") },
    template_tasks: { id: id("tt"), language_id: id("dil"), status: "running", theme: "t", created_at: AT, updated_at: AT },
    refs: { id: id("ref"), language_id: id("dil"), data: "{}", split: "train", created_at: AT },
    learn_proposals: { id: id("lp"), language_id: id("dil"), status: "open", title: "t", created_at: AT },
    learn_runs: { id: id("lr"), language_id: id("dil"), status: "running", base: "b", profile_version: 1, step: "s", done: 0, total: 1, message: "m", started_at: AT },
    design_sessions: { id: id("ds"), language_id: id("dil"), status: "open", started_at: AT, updated_at: AT, mode: "site", state: "drafting", member_id: member },
    design_session_entries: { session_id: id("ds"), at: AT, kind: "note", text: "t" },
    design_samples: { id: id("smp"), session_id: id("ds"), language_id: id("dil"), seq: 1, name: "n", w: 1, h: 1, status: "uploaded", created_at: AT },
    profile_revisions: { session_id: id("ds"), language_id: id("dil"), rev: 1, data: "{}", changes: "[]", reason: "initial", created_at: AT },
    design_session_turns: { session_id: id("ds"), seq: 1, messages: Buffer.from("m"), stop_reason: "end", created_at: AT },
    batches: { id: id("b"), language_id: id("dil"), name: "Parti", created_at: AT },
    jobs: { id: id("j"), batch_id: id("b"), seq: 1, raw: "{}", text_raw: "x", text: "x", status: "ready", gen_state: "queued", dedupe_key: "d", created_at: AT, updated_at: AT },
    variants: { id: id("v"), job_id: id("j"), no: 1, kind: "engine", snapshot: "{}", preview_file: "p.png", created_at: AT },
    gen_tasks: { id: id("g"), job_id: id("j"), mode: "m", status: "queued", created_at: AT },
    job_log: { job_id: id("j"), step: "s", message: "m", at: AT, member_id: member },
    adjust_log: { language_id: id("dil"), job_id: id("j"), variant_id: id("v"), rev: 1, frame_px: 1, adjust: "{}", target_x: 0, target_y: 0, target_source: "s", ink_before: "{}", ink_after: "{}", created_at: AT },
    print_templates: { id: id("pt"), language_id: id("dil"), name: "T", kind: "label", data: "{}", created_at: AT, updated_at: AT },
    print_sessions: { id: id("ps"), language_id: id("dil"), name: "S", status: "draft", created_at: AT, updated_at: AT },
    print_exports: { id: id("pe"), session_id: id("ps"), format: "pdf", status: "running", created_at: AT, member_id: member },
    print_pages: { id: id("pp"), session_id: id("ps"), template_id: id("pt"), idx: 0 },
    print_items: { id: id("pi"), page_id: id("pp"), job_id: id("j"), variant_id: id("v"), x_mm: 0, y_mm: 0 },
  };
  expect(Object.keys(rows).sort()).toEqual([...TENANT_TABLES].sort());
  for (const table of [...TENANT_TABLES].reverse()) {
    const row = { ...rows[table]!, org_id: org };
    const cols = Object.keys(row);
    await su.query(`INSERT INTO tagpress.${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  }
  return Object.fromEntries(Object.entries(rows).map(([t, r]) => [t, String(r.id ?? r.token ?? r.key)]));
}

const countAll = async (org: string) =>
  Object.fromEntries(
    await Promise.all(TENANT_TABLES.map(async (t) => [t, (await su.query(`SELECT count(*)::int AS n FROM tagpress.${t} WHERE org_id = $1`, [org])).rows[0].n as number] as const)),
  );

// ------------------------------------------------------------------------------------------------ göç

describe("göç çalıştırıcısı", () => {
  it("ikinci koşu hiçbir şey uygulamaz; geçmiş tablosu uygulama rolüne kapalı", async () => {
    const c = new pg.Client({ connectionString: dbUrl(roles.admin) });
    await c.connect();
    try {
      expect(await migratePg(c)).toEqual({ applied: [], skipped: ["0001-tagpress.sql"] });
    } finally {
      await c.end();
    }
    const hist = await su.query(`SELECT name, checksum FROM tagpress."_tagpress_migrations"`);
    expect(hist.rows).toEqual([{ name: "0001-tagpress.sql", checksum: migrationChecksum(readFileSync(path.join(PG_MIGRATIONS_DIR, "0001-tagpress.sql"), "utf8")) }]);
    await expect(app.query(`SELECT * FROM tagpress."_tagpress_migrations"`)).rejects.toMatchObject({ code: "42501" });
  });

  it("düşen göç bütünüyle geri alınır ve geçmişe yazılmaz; değişmiş ya da kaybolmuş uygulanmış göç ve bozuk ad durdurur", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-pg-goc-"));
    const c = new pg.Client({ connectionString: dbUrl(roles.admin) });
    await c.connect();
    try {
      const first = readFileSync(path.join(PG_MIGRATIONS_DIR, "0001-tagpress.sql"), "utf8");
      writeFileSync(path.join(dir, "0001-tagpress.sql"), first.replace(/\n/g, "\r\n")); // satır sonu özeti değiştirmez
      writeFileSync(path.join(dir, "0002-bozuk.sql"), "CREATE TABLE tagpress.yarim (id text);\nSELECT 1/0;\n");
      await expect(migratePg(c, { dir })).rejects.toThrow(/0002-bozuk\.sql uygulanamadı, geri alındı/);
      expect((await su.query("SELECT to_regclass('tagpress.yarim') AS t")).rows[0].t).toBeNull();
      expect((await su.query(`SELECT name FROM tagpress."_tagpress_migrations" ORDER BY name`)).rows.map((r) => r.name)).toEqual(["0001-tagpress.sql"]);

      rmSync(path.join(dir, "0002-bozuk.sql"));
      writeFileSync(path.join(dir, "0001-tagpress.sql"), `${first}\n-- elle değişiklik\n`);
      await expect(migratePg(c, { dir })).rejects.toThrow(/uygulanmış Postgres göçü değişmiş: 0001-tagpress\.sql/i);
      rmSync(path.join(dir, "0001-tagpress.sql"));
      await expect(migratePg(c, { dir })).rejects.toThrow(/klasörde yok: 0001-tagpress\.sql/);
      writeFileSync(path.join(dir, "0001-Tagpress.sql"), first);
      expect(() => readPgMigrations(dir)).toThrow(/göç adı geçersiz/);
      rmSync(path.join(dir, "0001-Tagpress.sql"));
      writeFileSync(path.join(dir, "0001-tagpress.sql"), first);
      writeFileSync(path.join(dir, "0003-atlama.sql"), "SELECT 1;");
      expect(() => readPgMigrations(dir)).toThrow(/göç sırası bozuk: 0003-atlama\.sql/);
    } finally {
      await c.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ilk göç product-kit kimlik izdüşümü bloğunu aynen taşır; CREATE SCHEMA, PUBLIC'e hak ve toplu GRANT yok", () => {
    const sql = readPgMigrations()[0]!.sql.replace(/\r\n/g, "\n");
    expect(sql).toContain(memberProjectionSql({ schema: PG_SCHEMA, appRole: PG_APP_ROLE }));
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\bCREATE\s+SCHEMA\b/i);
    for (const st of code.split(";")) {
      expect(st, "PUBLIC'e hak").not.toMatch(/\bGRANT\b[\s\S]*\bTO\s+PUBLIC\b/i);
      expect(st, "toplu GRANT").not.toMatch(/\bGRANT\b[\s\S]*\bON\s+ALL\s+(TABLES|SEQUENCES)\s+IN\s+SCHEMA\b/i);
    }
    for (const r of new Set(code.match(/\bsod_[a-z0-9_]+\b/g))) expect([PG_APP_ROLE, PG_ADMIN_ROLE], r).toContain(r);
  });
});

// ------------------------------------------------------------------------------------------------ şema eşliği

type PgCol = { table: string; name: string; type: string; notnull: boolean; hasDefault: boolean; identity: string };

describe("şema eşliği: SQLite (bütün göçlerden sonra) = Postgres", () => {
  const lite = openDatabase(":memory:", { backupDir: null });
  const liteCols = (t: string) =>
    lite.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
  const TYPE: Record<string, string> = { TEXT: "text", INTEGER: "bigint", REAL: "double precision", BLOB: "bytea" };
  let pgCols: PgCol[] = [];

  beforeAll(async () => {
    pgCols = (
      await su.query<PgCol>(
        `SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
                a.atthasdef AS "hasDefault", a.attidentity::text AS identity
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'tagpress' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
      )
    ).rows;
  });

  it("tablolar: 26 kiracı tablosu + settings + product-kit tabloları + göç geçmişi; SQLite'ta yalnız orgs fazladan (kurulum, Postgres'te Company)", () => {
    const pgTables = new Set(pgCols.map((c) => c.table));
    expect([...pgTables].sort()).toEqual(
      [...TENANT_TABLES, "settings", "Company", "Member", "ProcessedEvent", "CompanyPurge", "_tagpress_migrations"].sort(),
    );
    expect(TENANT_TABLES).toHaveLength(26);
    const liteTables = (lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(liteTables.filter((t) => !pgTables.has(t))).toEqual(["orgs"]);
  });

  it.each([...TENANT_TABLES, "settings"])("%s: sütun adları, tipleri, boş olabilirlik ve varsayılan aynı (org_id Postgres'te NOT NULL)", (t) => {
    const lc = liteCols(t);
    const all = pgCols.filter((c) => c.table === t);
    // Postgres'e özgü rowid karşılığı: yalnız listedeki tablolarda, kimlik sütunu (BY DEFAULT), NOT NULL.
    const rowid = all.find((c) => c.name === ROWID_COLUMN);
    if ((ROWID_TABLES as readonly string[]).includes(t)) expect(rowid, `${t}.${ROWID_COLUMN}`).toMatchObject({ type: "bigint", identity: "d", notnull: true });
    else expect(rowid, `${t}.${ROWID_COLUMN}`).toBeUndefined();
    const pc = all.filter((c) => c.name !== ROWID_COLUMN);
    expect(pc.map((c) => c.name).sort()).toEqual(lc.map((c) => c.name).sort());
    for (const l of lc) {
      const p = pc.find((c) => c.name === l.name)!;
      expect(p.type, `${t}.${l.name} tipi`).toBe(TYPE[l.type]);
      const autoinc = l.pk === 1 && l.type === "INTEGER";
      if (autoinc) {
        expect(p.identity, `${t}.${l.name} kimlik`).toBe("d");
        expect(IDENTITY_TABLES as readonly string[]).toContain(t);
        continue;
      }
      expect(p.hasDefault, `${t}.${l.name} varsayılan`).toBe(l.dflt_value !== null);
      const liteNotNull = l.notnull === 1 || l.pk > 0;
      if (l.name === "org_id") expect(p.notnull, `${t}.org_id`).toBe(true);
      else expect(p.notnull, `${t}.${l.name} NOT NULL`).toBe(liteNotNull);
    }
  });

  it("SQLite'ın birincil ve tekil anahtarları (ON CONFLICT hedefleri) Postgres'te aynı sütunlarla tekil; kısmi tekil dizin aynı koşulla", async () => {
    const pgUnique = (
      await su.query<{ table: string; cols: string[]; partial: boolean }>(
        `SELECT c.relname AS "table", i.indpred IS NOT NULL AS partial,
                ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.n ORDER BY k.o) AS cols
           FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'tagpress' AND i.indisunique`,
      )
    ).rows;
    const has = (t: string, cols: string[], partial = false) => pgUnique.some((u) => u.table === t && u.partial === partial && u.cols.join(",") === cols.join(","));
    for (const t of [...TENANT_TABLES, "settings"]) {
      const pk = liteCols(t)
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(has(t, pk), `${t} birincil anahtar ${pk}`).toBe(true);
      for (const idx of lite.prepare(`PRAGMA index_list(${t})`).all() as { name: string; unique: number; origin: string; partial: number }[]) {
        if (!idx.unique || idx.origin === "pk") continue;
        const cols = (lite.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[]).map((c) => c.name);
        expect(has(t, cols, idx.partial === 1), `${t} tekil ${cols}`).toBe(true);
      }
    }
    const active = await su.query(`SELECT pg_get_indexdef('tagpress.design_sessions_org_active'::regclass) AS d`);
    expect(active.rows[0].d).toMatch(/UNIQUE INDEX design_sessions_org_active ON tagpress\.design_sessions USING btree \(org_id, language_id\) WHERE \(\(mode = 'site'::text\) AND \(state <> ALL \(ARRAY\['published'::text, 'closed'::text\]\)\)\)/);
  });
});

// ------------------------------------------------------------------------------------------------ firma alanı, RLS, dizinler

describe("firma alanı ve RLS (katalog)", () => {
  it.each([...TENANT_TABLES])("%s: org_id NOT NULL + Company FK; ENABLE + FORCE; org_isolation; firma değişmezliği tetikleyicisi", async (t) => {
    const fk = await su.query(
      `SELECT pg_get_constraintdef(con.oid) AS d FROM pg_constraint con
        WHERE con.conrelid = $1::regclass AND con.contype = 'f' AND con.confrelid = 'tagpress."Company"'::regclass`,
      [`tagpress.${t}`],
    );
    expect(fk.rows.map((r) => r.d)).toEqual(['FOREIGN KEY (org_id) REFERENCES tagpress."Company"(id)']);
    const rel = await su.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`tagpress.${t}`]);
    expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await su.query(`SELECT cmd, permissive, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'tagpress' AND tablename = $1 AND policyname = 'org_isolation'`, [t]);
    expect(pol.rows).toEqual([
      { cmd: "ALL", permissive: "PERMISSIVE", roles: ["public"], qual: "(org_id = current_setting('app.org_id'::text, true))", with_check: "(org_id = current_setting('app.org_id'::text, true))" },
    ]);
    const trg = await su.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [`tagpress.${t}`]);
    expect(trg.rows.map((r) => r.tgname)).toEqual([`${t}_org_immutable`]);
  });

  it("ilkeler yalnız org_isolation ve listelenen kuyruk ilkeleri; kuyruk ilkeleri kuyruk kapsamına bağlı, silme yok", async () => {
    const pols = (
      await su.query<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }>(
        `SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'tagpress' AND policyname LIKE 'queue%'`,
      )
    ).rows;
    const byTable: Record<string, string[]> = {};
    for (const p of pols) {
      (byTable[p.tablename] ??= []).push(p.cmd);
      for (const expr of [p.qual, p.with_check]) if (expr) expect(expr, `${p.tablename}.${p.policyname}`).toContain(`current_setting('app.scope'::text, true) = '${QUEUE_SCOPE}'::text`);
    }
    for (const v of Object.values(byTable)) v.sort();
    expect(byTable).toEqual(Object.fromEntries(Object.entries(QUEUE_POLICIES).map(([t, c]) => [t, [...c].sort()])));
    const other = await su.query(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'tagpress' AND policyname <> 'org_isolation' AND policyname NOT LIKE 'queue%'
          AND tablename NOT IN ('Company', 'Member', 'ProcessedEvent', 'CompanyPurge')`,
    );
    expect(other.rows).toEqual([]);
  });

  it("çocuk tablolar ebeveynine firmayla bağlı (bileşik yabancı anahtar); üye izi Member(id, orgId)'ye", async () => {
    const fks = (
      await su.query<{ child: string; parent: string; d: string }>(
        `SELECT ch.relname AS child, p.relname AS parent, pg_get_constraintdef(con.oid) AS d FROM pg_constraint con
           JOIN pg_class ch ON ch.oid = con.conrelid JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace n ON n.oid = ch.relnamespace
          WHERE n.nspname = 'tagpress' AND con.contype = 'f' AND p.relname <> 'Company' AND ch.relname = ANY($1::text[])`,
        [[...TENANT_TABLES]],
      )
    ).rows;
    const got = fks.map((f) => `${f.child} -> ${f.d.replace(/tagpress\./g, "")}`).sort();
    const cascade = (child: string, col: string, parent: string) => `${child} -> FOREIGN KEY (org_id, ${col}) REFERENCES ${parent}(org_id, id) ON DELETE CASCADE`;
    const member = (child: string) => `${child} -> FOREIGN KEY (member_id, org_id) REFERENCES "Member"(id, "orgId")`;
    expect(got).toEqual(
      [
        cascade("profile_versions", "language_id", "languages"),
        cascade("templates", "language_id", "languages"),
        cascade("design_session_entries", "session_id", "design_sessions"),
        cascade("design_samples", "session_id", "design_sessions"),
        cascade("profile_revisions", "session_id", "design_sessions"),
        cascade("design_session_turns", "session_id", "design_sessions"),
        cascade("jobs", "batch_id", "batches"),
        cascade("variants", "job_id", "jobs"),
        cascade("print_pages", "session_id", "print_sessions"),
        cascade("print_items", "page_id", "print_pages"),
        member("ai_calls"),
        member("design_sessions"),
        member("job_log"),
        member("print_exports"),
      ].sort(),
    );
    // SQLite'taki her ebeveyn bağı Postgres'te var (ad ve yön aynı).
    const lite = openDatabase(":memory:", { backupDir: null });
    for (const t of TENANT_TABLES) {
      for (const f of lite.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string; from: string; on_delete: string }[]) {
        if (f.table === "orgs") continue;
        expect(fks.some((x) => x.child === t && x.parent === f.table && x.d.includes(`(org_id, ${f.from})`) && x.d.includes("ON DELETE CASCADE")), `${t}.${f.from} -> ${f.table}`).toBe(true);
      }
    }
  });

  it("dizinler: her kiracı tablosunda firmayla başlayan dizin var; tekil olmayan dizinler firmayla başlar (kuyruk taraması hariç)", async () => {
    const idx = (
      await su.query<{ table: string; name: string; unique: boolean; first: string }>(
        `SELECT c.relname AS "table", ic.relname AS name, i.indisunique AS unique, a.attname AS first
           FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
          WHERE n.nspname = 'tagpress' AND c.relname = ANY($1::text[])`,
        [[...TENANT_TABLES]],
      )
    ).rows;
    for (const t of TENANT_TABLES) expect(idx.some((i) => i.table === t && i.first === "org_id"), `${t}: org_id ile başlayan dizin`).toBe(true);
    expect(idx.filter((i) => !i.unique && i.first !== "org_id").map((i) => i.name)).toEqual(["gen_tasks_status_org"]);
  });
});

// ------------------------------------------------------------------------------------------------ haklar ve silme listesi

describe("haklar ve kalıcı silme", () => {
  const kit = () => {
    const f = Fastify();
    const identity = registerProductIdentity(f, {
      product: "tagpress",
      db: pgDb(app),
      schema: PG_SCHEMA,
      jwksUrl: "http://127.0.0.1:9/jwks.json",
      allowedOrigins: [],
      purgeRetryEveryMs: 0,
      purge: { tables: PG_PURGE_TABLES, orgColumn: "org_id", onPurged: async (orgId) => void purged.push(orgId) },
    });
    return { f, identity };
  };
  const purged: string[] = [];

  it("checkPurgeTables() ve checkGrants() boş; TagPress tablolarının hakları beklenenle aynı; diziler yalnız USAGE", async () => {
    const { f, identity } = kit();
    try {
      expect(await identity.checkPurgeTables()).toEqual([]);
      expect(await identity.checkGrants()).toEqual([]);
    } finally {
      await f.close();
    }
    expect(await checkTagpressGrants(app)).toEqual([]);
    expect(Object.keys(TAGPRESS_TABLE_PRIVILEGES).sort()).toEqual([...TENANT_TABLES, "settings"].sort());
    // tetikleyici işlevi uygulama rolünce çağrılamaz (yalnız tetikleyici çalıştırır)
    expect((await su.query(`SELECT has_function_privilege($1, 'tagpress.org_id_immutable()', 'EXECUTE') AS x`, [PG_APP_ROLE])).rows[0].x).toBe(false);
    // denetim gerçekten görür: fazladan hak bulgu verir
    await su.query(`GRANT UPDATE ON tagpress.job_log TO ${PG_APP_ROLE}; GRANT TRUNCATE ON tagpress.jobs TO ${PG_APP_ROLE}`);
    try {
      expect((await checkTagpressGrants(app)).map((i) => `${i.table}: ${i.issue} ${i.privilege}`).sort()).toEqual([
        "job_log: extra-privilege UPDATE",
        "jobs: extra-privilege TRUNCATE",
      ]);
    } finally {
      await su.query(`REVOKE UPDATE ON tagpress.job_log FROM ${PG_APP_ROLE}; REVOKE TRUNCATE ON tagpress.jobs FROM ${PG_APP_ROLE}`);
    }
  });

  it("silme listesi TENANT_TABLES sırasında; anahtarsız tablolar kendi anahtarıyla", () => {
    expect(PG_PURGE_TABLES.map((t) => t.table)).toEqual([...TENANT_TABLES]);
    expect(PG_PURGE_TABLES.filter((t) => t.key)).toEqual([
      { table: "undo", key: "token" },
      { table: "templates", key: "language_id" },
      { table: "org_settings", key: "key" },
    ]);
  });

  it("kalıcı silme (product-kit, parça parça): A firmasının 26 tablodaki satırları, üyesi ve firma satırı gider; B aynen kalır", async () => {
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    await seedOrg(a, `m-${a}`);
    await seedOrg(b, `m-${b}`);
    // Aynı dilde iki şablon (anahtarı tekil olmayan tablo, küçük parça)
    await su.query(`INSERT INTO tagpress.templates (org_id, language_id, key, data, created_at, updated_at) VALUES ($1, $2, '2', '{}', $3, $3)`, [a, `dil-${a}`, AT]);
    const before = await countAll(b);
    expect(Object.values(await countAll(a)).every((n) => n >= 1)).toBe(true);
    await su.query(`INSERT INTO tagpress."CompanyPurge"("orgId") VALUES ($1)`, [a]);
    const { f, identity } = kit();
    try {
      const res = await identity.purgeOrg(a, { batchSize: 1 });
      expect(res.state).toBe("completed");
      expect(purged).toEqual([a]);
    } finally {
      await f.close();
    }
    expect(Object.values(await countAll(a)).every((n) => n === 0)).toBe(true);
    expect(await countAll(b)).toEqual(before);
    expect((await su.query(`SELECT count(*)::int AS n FROM tagpress."Member" WHERE "orgId" = $1`, [a])).rows[0].n).toBe(0);
    expect((await su.query(`SELECT count(*)::int AS n FROM tagpress."Company" WHERE id = ANY($1)`, [[a, b]])).rows[0].n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ RLS davranışı

describe("RLS davranışı (uygulama rolü)", () => {
  const a = `a-${randomUUID()}`;
  const b = `b-${randomUUID()}`;
  let ids: { a: Record<string, string>; b: Record<string, string> };
  beforeAll(async () => {
    ids = { a: await seedOrg(a, `m-${a}`), b: await seedOrg(b, `m-${b}`) };
  });

  it("bağlamsız oturum hiçbir kiracı satırı ve firma görmez; bağlamsız ekleme reddedilir", async () => {
    for (const t of TENANT_TABLES) expect((await app.query(`SELECT count(*)::int AS n FROM tagpress.${t}`)).rows[0].n, t).toBe(0);
    expect((await app.query(`SELECT count(*)::int AS n FROM tagpress."Company"`)).rows[0].n).toBe(0);
    await expect(app.query(`INSERT INTO tagpress.languages (id, name, created_at, org_id) VALUES ('x', 'X', $1, $2)`, [AT, a])).rejects.toMatchObject({ code: "42501" });
  });

  it("A bağlamı yalnız A'yı görür; B'nin satırını yazamaz, güncelleyemez, silemez; kendi satırını B'ye taşıyamaz", async () => {
    await asApp({ org: a }, async (c) => {
      for (const t of TENANT_TABLES) {
        const orgs = (await c.query(`SELECT DISTINCT org_id FROM tagpress.${t}`)).rows.map((r) => r.org_id);
        expect(orgs, t).toEqual([a]);
      }
      expect((await c.query(`UPDATE tagpress.jobs SET text = 'ele geçirildi' WHERE id = $1`, [ids.b.jobs])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM tagpress.languages WHERE id = $1`, [ids.b.languages])).rowCount).toBe(0);
    });
    await expect(asApp({ org: a }, (c) => c.query(`INSERT INTO tagpress.languages (id, name, created_at, org_id) VALUES ('x2', 'X', $1, $2)`, [AT, b]))).rejects.toMatchObject({ code: "42501" });
    // Firma değişmezliği tetikleyicisi RLS'den önce durdurur (ikisi de engeller).
    await expect(asApp({ org: a }, (c) => c.query(`UPDATE tagpress.jobs SET org_id = $2 WHERE id = $1`, [ids.a.jobs, b]))).rejects.toMatchObject({
      code: "23514",
      message: "org_id değiştirilemez (jobs)",
    });
    await expect(asApp({ org: a }, (c) => c.query(`INSERT INTO tagpress.org_settings (org_id, key, value) VALUES ($1, 'app', '{}') ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`, [b]))).rejects.toMatchObject({ code: "42501" });
    expect((await su.query(`SELECT text FROM tagpress.jobs WHERE id = $1`, [ids.b.jobs])).rows[0].text).toBe("x");
  });

  it("A, B'nin ebeveynine (parti, dil, oturum, sayfa) ve üyesine bağlanamaz (bileşik yabancı anahtar)", async () => {
    const ins = (sql: string, p: unknown[]) => asApp({ org: a }, (c) => c.query(sql, p));
    await expect(
      ins(`INSERT INTO tagpress.jobs (id, batch_id, seq, raw, text_raw, text, status, dedupe_key, created_at, updated_at, org_id) VALUES ('jx', $1, 1, '{}', 'x', 'x', 'ready', 'd', $2, $2, $3)`, [ids.b.batches, AT, a]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(ins(`INSERT INTO tagpress.templates (language_id, key, data, created_at, updated_at, org_id) VALUES ($1, 'k', '{}', $2, $2, $3)`, [ids.b.languages, AT, a])).rejects.toMatchObject({ code: "23503" });
    await expect(ins(`INSERT INTO tagpress.design_session_entries (session_id, at, kind, text, org_id) VALUES ($1, $2, 'note', 't', $3)`, [ids.b.design_sessions, AT, a])).rejects.toMatchObject({ code: "23503" });
    await expect(ins(`INSERT INTO tagpress.print_items (id, page_id, job_id, variant_id, x_mm, y_mm, org_id) VALUES ('pix', $1, 'j', 'v', 0, 0, $2)`, [ids.b.print_pages, a])).rejects.toMatchObject({ code: "23503" });
    await expect(ins(`INSERT INTO tagpress.job_log (job_id, step, message, at, org_id, member_id) VALUES ('j', 's', 'm', $1, $2, $3)`, [AT, a, `m-${b}`])).rejects.toMatchObject({ code: "23503" });
    // kendi ebeveyni ve üyesi: olur; kimlik sütunu kimlik döner (köprünün RETURNING id'si)
    const r = await ins(`INSERT INTO tagpress.job_log (job_id, step, message, at, org_id, member_id) VALUES ('j', 's', 'm', $1, $2, $3) RETURNING id`, [AT, a, `m-${a}`]);
    expect(Number(r.rows[0].id)).toBeGreaterThan(0);
  });

  it("yalnız eklenen günlükler güncellenmez (hak yok)", async () => {
    for (const [t, col] of [["job_log", "at"], ["adjust_log", "created_at"], ["design_session_turns", "created_at"]] as const) {
      await expect(asApp({ org: a }, (c) => c.query(`UPDATE tagpress.${t} SET ${col} = ${col}`))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("kuyruk kapsamı: servislerin bakım ifadeleri bütün firmalarda çalışır; yalnız yarım satırlar görünür, yalnız izinli duruma geçer", async () => {
    const q = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, p: unknown[] = []) => asApp({ scope: QUEUE_SCOPE }, (c) => c.query<T>(sql, p));
    // adil seçim (queue.ts kick): açık firma sayısı ve firmaların bekleyenleri
    expect((await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tagpress."Company" WHERE "closedAt" IS NULL AND id = ANY($1)`, [[a, b]])).rows[0]!.n).toBe(2);
    const orgs = (await q<{ org_id: string }>("SELECT org_id, MIN(created_at) AS oldest FROM tagpress.gen_tasks WHERE status = 'queued' GROUP BY org_id")).rows.map((r) => r.org_id);
    expect(orgs).toEqual(expect.arrayContaining([a, b]));
    const claimed = await q("UPDATE tagpress.gen_tasks SET status = 'running', attempts = attempts + 1, started_at = $1 WHERE id = $2 AND status = 'queued'", [AT, ids.a.gen_tasks]);
    expect(claimed.rowCount).toBe(1);
    // isIdle / recover okuması
    expect((await q("SELECT id, org_id, job_id, attempts FROM tagpress.gen_tasks WHERE status = 'running'")).rows.map((r) => r.id)).toContain(ids.a.gen_tasks);
    // başka geçiş reddedilir; bitmiş görev görünmez; silme ve firma değişikliği yok
    await expect(q("UPDATE tagpress.gen_tasks SET status = 'done' WHERE id = $1", [ids.b.gen_tasks])).rejects.toMatchObject({ code: "42501" });
    await su.query("UPDATE tagpress.gen_tasks SET status = 'done' WHERE id = $1", [ids.b.gen_tasks]);
    expect((await q("SELECT id FROM tagpress.gen_tasks WHERE id = $1", [ids.b.gen_tasks])).rowCount).toBe(0);
    expect((await q("DELETE FROM tagpress.gen_tasks")).rowCount).toBe(0);
    // kuyruk kapsamı da görevi başka firmaya taşıyamaz (izinli geçişte bile: firma değişmezliği tetikleyicisi)
    await su.query("INSERT INTO tagpress.gen_tasks (id, job_id, mode, status, created_at, org_id) VALUES ($1, $2, 'm', 'queued', $3, $4)", [`g2-${a}`, ids.a.jobs, AT, a]);
    await expect(q("UPDATE tagpress.gen_tasks SET status = 'running', org_id = $2 WHERE id = $1", [`g2-${a}`, b])).rejects.toMatchObject({
      code: "23514",
      message: "org_id değiştirilemez (gen_tasks)",
    });
    expect((await su.query("SELECT org_id, status FROM tagpress.gen_tasks WHERE id = $1", [`g2-${a}`])).rows).toEqual([{ org_id: a, status: "queued" }]);
    // queue.ts recover: görevi kalmamış işlerin üretim durumu boşalır (B'nin görevi bitti → B'nin işi boşalır, A'nınki kalır)
    // (Postgres yazımı: işlev, firma firma; işler tablosu kuyruk kapsamında görünmez.)
    const cleared = await asApp({ org: "", scope: QUEUE_SCOPE }, async (c) => {
      const n = Number((await c.query("SELECT tagpress.queue_clear_orphan_gen_state() AS n")).rows[0].n);
      // firma bağlamı işlevden sonra eski değerinde (köprünün bakım bağlamı `app.org_id = ''`)
      expect((await c.query("SELECT current_setting('app.org_id', true) AS o")).rows[0].o).toBe("");
      return n;
    });
    expect(cleared).toBeGreaterThanOrEqual(1);
    await expect(asApp({ org: a }, (c) => c.query("SELECT tagpress.queue_clear_orphan_gen_state()"))).rejects.toMatchObject({ code: "42501" });
    const genState = async (id: string | undefined) => (await su.query("SELECT gen_state FROM tagpress.jobs WHERE id = $1", [id])).rows[0].gen_state;
    expect(await genState(ids.a.jobs)).toBe("queued");
    expect(await genState(ids.b.jobs)).toBeNull();
    expect((await q("UPDATE tagpress.jobs SET gen_state = NULL WHERE id = $1", [ids.a.jobs])).rowCount).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM tagpress.jobs")).rows[0]!.n).toBe(0);
    // açılış kurtarmaları (exports.ts, learn.ts, template-tasks.ts, builder/service.ts)
    expect((await q("UPDATE tagpress.print_exports SET status = 'interrupted', finished_at = $1 WHERE status IN ('queued', 'running')", [AT])).rowCount).toBeGreaterThanOrEqual(2);
    expect((await q("UPDATE tagpress.learn_runs SET status = 'interrupted', error = $1, finished_at = $2, message = $3 WHERE status = 'running'", ["e", AT, "Kesildi"])).rowCount).toBeGreaterThanOrEqual(2);
    expect((await q("UPDATE tagpress.template_tasks SET status = 'interrupted', error = $1, updated_at = $2 WHERE status IN ('queued', 'running')", ["e", AT])).rowCount).toBeGreaterThanOrEqual(2);
    const running = "mode = 'site' AND state IN ('analyzing', 'drafting', 'revising')";
    const entries = await q(
      `INSERT INTO tagpress.design_session_entries (org_id, session_id, at, kind, grp, text, paths, role, data, turn_seq)
       SELECT org_id, id, $1, 'error', NULL, '', NULL, 'system', $2, turn_seq FROM tagpress.design_sessions WHERE ${running}`,
      [AT, JSON.stringify({ code: "interrupted" })],
    );
    expect(entries.rowCount).toBeGreaterThanOrEqual(2);
    const sessions = await q(`UPDATE tagpress.design_sessions SET resume_state = state, state = 'interrupted', error = $1, turn_seq = NULL, turn_started_at = NULL, updated_at = $2 WHERE ${running}`, ["{}", AT]);
    expect(sessions.rowCount).toBeGreaterThanOrEqual(2);
    for (const org of [a, b]) {
      expect((await su.query("SELECT state FROM tagpress.design_sessions WHERE id = $1", [`ds-${org}`])).rows[0].state).toBe("interrupted");
      expect((await su.query("SELECT status FROM tagpress.print_exports WHERE id = $1", [`pe-${org}`])).rows[0].status).toBe("interrupted");
    }
    // başka tablo, başka kayıt türü görünmez/yazılamaz
    for (const t of ["languages", "variants", "ai_calls", "org_settings"]) {
      expect((await q(`SELECT count(*)::int AS n FROM tagpress.${t}`)).rows[0]!.n, t).toBe(0);
    }
    expect((await q(`SELECT count(*)::int AS n FROM tagpress."Member"`)).rows[0]!.n).toBe(0);
    await expect(
      q("INSERT INTO tagpress.design_session_entries (org_id, session_id, at, kind, text, role) VALUES ($1, $2, $3, 'note', 'x', 'user')", [a, ids.a.design_sessions, AT]),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await q("UPDATE tagpress.print_exports SET status = 'interrupted' WHERE id = $1", [ids.a.print_exports])).rowCount).toBe(0);
  });

  it("settings (kurulum tablosu): RLS yok, firma bağlamı gerekmez", async () => {
    await app.query(`INSERT INTO tagpress.settings (key, value) VALUES ('install.test', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    expect((await app.query(`SELECT value FROM tagpress.settings WHERE key = 'install.test'`)).rows).toEqual([{ value: "1" }]);
  });
});
