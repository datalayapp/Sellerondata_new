import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { MIGRATION_9_TABLES } from "../db/migrations/0009-firma.ts";
import { INSTALL_TABLES, TENANT_TABLES } from "./tables.ts";

/** Şema denetimi (`sqlite_master`): her kiracı tablosunda `org_id`, tetikleyiciler ve firmayla başlayan dizinler. */
const db = openDatabase(":memory:");
const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
const tables = master.filter((m) => m.type === "table" && !m.name.startsWith("sqlite_")).map((m) => m.name);
const triggers = new Map(master.filter((m) => m.type === "trigger").map((m) => [m.name, m]));
const columns = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[];
const indexColumns = (name: string) => (db.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[]).map((c) => c.name);

describe("şema: firma alanı", () => {
  it("her tablo ya kiracı ya kurulum listesinde (yeni tablo TENANT_TABLES'a girmeden kalmaz)", () => {
    const known = new Set<string>([...TENANT_TABLES, ...INSTALL_TABLES]);
    expect(tables.filter((t) => !known.has(t))).toEqual([]);
    expect([...TENANT_TABLES, ...INSTALL_TABLES].filter((t) => !tables.includes(t))).toEqual([]);
    expect(MIGRATION_9_TABLES.filter((t) => !(TENANT_TABLES as readonly string[]).includes(t))).toEqual([]);
  });

  it.each([...TENANT_TABLES])("%s: org_id, boş eklemeyi ve firma değişikliğini durduran tetikleyiciler", (t) => {
    const col = columns(t).find((c) => c.name === "org_id");
    expect(col, "org_id sütunu").toBeDefined();
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { from: string; table: string; to: string }[];
    expect(fks.find((f) => f.from === "org_id")).toMatchObject({ table: "orgs", to: "id" });
    // Firma hiç değişmez (boştan doluya geçiş de: koşulda `OLD.org_id IS NOT NULL` yok).
    const immutable = triggers.get(`${t}_org_immutable`)?.sql;
    expect(immutable, "firma değişmezliği").toMatch(/BEFORE UPDATE OF org_id[\s\S]*WHEN NEW\.org_id IS NOT OLD\.org_id[\s\S]*RAISE\(ABORT/);
    expect(immutable).not.toMatch(/OLD\.org_id IS NOT NULL/);
    // Geçici doldurma (göç 9) göç 10'da kalktı.
    expect(triggers.has(`${t}_org_fill`), "geçici doldurma yok").toBe(false);
    if (col!.notnull) return; // org_settings: sütun baştan NOT NULL
    // Boş org_id her durumda durur (koşulda varsayılan firma yoklaması yok).
    const required = triggers.get(`${t}_org_required`)?.sql;
    expect(required, "boş org_id").toMatch(/BEFORE INSERT[\s\S]*WHEN NEW\.org_id IS NULL\s+BEGIN[\s\S]*RAISE\(ABORT/);
    expect(required).not.toMatch(/settings/);
  });

  it("firmayla başlayan dizinler; yerini aldıkları eski dizinler yok", () => {
    const want: Record<string, string[]> = {
      languages_org: ["org_id", "created_at"],
      batches_org_lang: ["org_id", "language_id", "created_at"],
      jobs_org_dedupe: ["org_id", "dedupe_key"],
      jobs_org_created: ["org_id", "created_at"],
      refs_org_lang: ["org_id", "language_id", "created_at"],
      ai_calls_org_created: ["org_id", "created_at"],
      gen_tasks_status_org: ["status", "org_id", "created_at"],
      print_sessions_org_lang: ["org_id", "language_id", "status", "updated_at"],
      design_sessions_org_lang: ["org_id", "language_id", "started_at"],
    };
    for (const [name, cols] of Object.entries(want)) expect(indexColumns(name), name).toEqual(cols);
    const names = new Set(master.filter((m) => m.type === "index").map((m) => m.name));
    for (const old of ["batches_lang", "jobs_dedupe", "jobs_created", "refs_lang", "ai_calls_created", "gen_tasks_status", "print_sessions_language", "design_sessions_lang"]) {
      expect(names.has(old), old).toBe(false);
    }
  });

  it("TENANT_TABLES silme sırasında: çocuk tablo ebeveyninden önce", () => {
    const order = TENANT_TABLES as readonly string[];
    for (const t of order) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[];
      for (const f of fks) if (order.includes(f.table)) expect(order.indexOf(t), `${t} → ${f.table}`).toBeLessThan(order.indexOf(f.table));
    }
  });
});
