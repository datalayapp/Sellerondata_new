import type pg from "pg";
import { TENANT_TABLES, type TenantTable } from "../../org/tables.ts";
import { PG_SCHEMA } from "./migrate.ts";

/**
 * TagPress tablolarında uygulama rolünün (`sod_tagpress`) beklenen hakları (göç `0001-tagpress.sql` "haklar" bölümü).
 * product-kit `checkGrants()` yalnız kimlik izdüşümü tablolarını denetler; bu liste TagPress'in kendi tablolarını tamamlar.
 * Yalnız eklenen günlükler güncellenmez; TRUNCATE, REFERENCES, TRIGGER hiçbir tabloda yok.
 */
const FULL = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const APPEND = ["SELECT", "INSERT", "DELETE"] as const;
const APPEND_ONLY = new Set<string>(["job_log", "adjust_log", "design_session_turns"]);

export const TAGPRESS_TABLE_PRIVILEGES: Readonly<Record<TenantTable | "settings", readonly string[]>> = Object.freeze(
  Object.fromEntries([["settings", FULL], ...TENANT_TABLES.map((t) => [t, APPEND_ONLY.has(t) ? APPEND : FULL])]) as Record<TenantTable | "settings", readonly string[]>,
);

/** Kimlik sütunlu tablolar (SQLite AUTOINCREMENT): eklemede `RETURNING id` (köprü), aktarımdan sonra dizi ilerletilir. */
export const IDENTITY_TABLES = ["design_session_entries", "profile_revisions", "design_session_turns", "job_log", "adjust_log"] as const;

/**
 * Postgres'e özgü ekleme sırası sütunu `ins_seq` (SQLite `rowid` karşılığı; `ORDER BY …, rowid` yazan servis sorguları için).
 * Kimlik sütunu (BY DEFAULT), SQLite şemasında yok; şema eşliği testi bu sütunu tanır.
 */
export const ROWID_COLUMN = "ins_seq";
export const ROWID_TABLES = ["gen_tasks", "learn_runs", "print_pages", "print_items", "design_sessions"] as const;

/** Uygulama rolünün çağırabildiği işlevler (başkası yok): görevi kalmamış işlerin üretim durumunu boşaltma (kuyruk kapsamı). */
export const APP_FUNCTIONS = ["queue_clear_orphan_gen_state"] as const;

/**
 * Kuyruk kapsamı (`app.scope = 'queue'`): TagPress bakım bağlantısının firmalar arası gördüğü tablolar ve hakları (RLS ilkeleri;
 * tablo hakkı ayrıca). Göçteki `queue_*` ilkeleriyle aynı (test karşılaştırır).
 */
export const QUEUE_SCOPE = "queue";
export const QUEUE_POLICIES: Readonly<Record<string, readonly ("SELECT" | "UPDATE" | "INSERT")[]>> = Object.freeze({
  Company: ["SELECT"],
  gen_tasks: ["SELECT", "UPDATE"],
  print_exports: ["SELECT", "UPDATE"],
  learn_runs: ["SELECT", "UPDATE"],
  template_tasks: ["SELECT", "UPDATE"],
  design_sessions: ["SELECT", "UPDATE"],
  design_session_entries: ["INSERT"],
});

const ALL_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

export type TagpressGrantIssue = { table: string; issue: "missing-table" | "missing-privilege" | "extra-privilege"; privilege: string };

/**
 * Bağlantının rolünün TagPress tablolarındaki hakları beklenenle aynı mı (katalog okur, firma bağlamı gerekmez). Ayrıca
 * geçmiş tablosu (`_tagpress_migrations`) ve şemadaki diziler: geçmişte hiçbir hak, dizide yalnız USAGE beklenir.
 */
export async function checkTagpressGrants(db: Pick<pg.Pool, "query">): Promise<TagpressGrantIssue[]> {
  const tables = Object.keys(TAGPRESS_TABLE_PRIVILEGES);
  const rows = (
    await db.query<{ t: string; priv: string; has: boolean }>(
      `SELECT c.relname AS t, p.priv, has_table_privilege(c.oid, p.priv) AS has
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN unnest($3::text[]) AS p(priv)
        WHERE n.nspname = $1 AND (c.relname = ANY($2::text[]) OR c.relname = '_tagpress_migrations') AND c.relkind IN ('r', 'p')`,
      [PG_SCHEMA, tables, ALL_PRIVILEGES],
    )
  ).rows;
  const issues: TagpressGrantIssue[] = [];
  for (const table of [...tables, "_tagpress_migrations"]) {
    const mine = rows.filter((r) => r.t === table);
    if (!mine.length) {
      issues.push({ table, issue: "missing-table", privilege: "*" });
      continue;
    }
    const expected = (TAGPRESS_TABLE_PRIVILEGES as Record<string, readonly string[]>)[table] ?? [];
    for (const r of mine) {
      if (r.has && !expected.includes(r.priv)) issues.push({ table, issue: "extra-privilege", privilege: r.priv });
      if (!r.has && expected.includes(r.priv)) issues.push({ table, issue: "missing-privilege", privilege: r.priv });
    }
  }
  const seqs = (
    await db.query<{ s: string; usage: boolean; sel: boolean; upd: boolean }>(
      `SELECT c.relname AS s, has_sequence_privilege(c.oid, 'USAGE') AS usage, has_sequence_privilege(c.oid, 'SELECT') AS sel,
              has_sequence_privilege(c.oid, 'UPDATE') AS upd
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S'`,
      [PG_SCHEMA],
    )
  ).rows;
  for (const s of seqs) {
    if (!s.usage) issues.push({ table: s.s, issue: "missing-privilege", privilege: "USAGE" });
    if (s.sel) issues.push({ table: s.s, issue: "extra-privilege", privilege: "SELECT" });
    if (s.upd) issues.push({ table: s.s, issue: "extra-privilege", privilege: "UPDATE" });
  }
  const fns = (
    await db.query<{ f: string; exec: boolean }>(
      `SELECT p.proname AS f, has_function_privilege(p.oid, 'EXECUTE') AS exec FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
      [PG_SCHEMA],
    )
  ).rows;
  for (const f of fns) {
    const expected = (APP_FUNCTIONS as readonly string[]).includes(f.f);
    if (f.exec && !expected) issues.push({ table: `${f.f}()`, issue: "extra-privilege", privilege: "EXECUTE" });
    if (!f.exec && expected) issues.push({ table: `${f.f}()`, issue: "missing-privilege", privilege: "EXECUTE" });
  }
  for (const f of APP_FUNCTIONS) if (!fns.some((x) => x.f === f)) issues.push({ table: `${f}()`, issue: "missing-table", privilege: "EXECUTE" });
  return issues;
}
