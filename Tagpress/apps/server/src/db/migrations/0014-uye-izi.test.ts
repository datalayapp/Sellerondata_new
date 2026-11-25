import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigration, migrate, openDatabase } from "../database.ts";
import { MIGRATIONS } from "./index.ts";
import { MIGRATION_14_COLUMNS, migration as runMigration14 } from "./0014-uye-izi.ts";

const at = "2026-11-22T00:00:00.000Z";
const env = { now: () => at, newId: () => "id" };

const columns = (db: DatabaseSync, t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];
const schema = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

describe("göç 14: üye izi", () => {
  it("dizide 14. sırada ve son; yeni veritabanı 14'e çıkar", () => {
    expect(MIGRATIONS[13]).toBe(runMigration14);
    expect(MIGRATIONS).toHaveLength(14);
    const db = openDatabase(":memory:", { backupDir: null });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
  });

  it("boş olabilir metin sütunları eklenir; var olan satırlar aynı kalır (yeni sütun boş); ikinci koşu değiştirmez", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let v = 0; v < 13; v++) applyMigration(db, MIGRATIONS[v]!, env);
    db.exec("PRAGMA user_version = 13");
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES ('firma', 'Firma', 'local', ?)").run(at);
    db.prepare("INSERT INTO job_log (org_id, job_id, step, message, at) VALUES ('firma', 'is', 'adim', 'mesaj', ?)").run(at);
    db.prepare("INSERT INTO ai_calls (org_id, id, purpose, model, summary, created_at) VALUES ('firma', 'c1', 'design', 'm', 'ozet', ?)").run(at);
    db.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ('firma', 'dil', 'Dil', ?)").run(at);
    db.prepare("INSERT INTO design_sessions (org_id, id, language_id, status, started_at, updated_at) VALUES ('firma', 's1', 'dil', 'open', ?, ?)").run(at, at);
    db.prepare("INSERT INTO print_exports (org_id, id, session_id, format, status, created_at) VALUES ('firma', 'e1', 'ps', 'pdf', 'done', ?)").run(at);
    const before = {
      job_log: db.prepare("SELECT * FROM job_log").all(),
      ai_calls: db.prepare("SELECT * FROM ai_calls").all(),
      design_sessions: db.prepare("SELECT * FROM design_sessions").all(),
      print_exports: db.prepare("SELECT * FROM print_exports").all(),
    };

    expect(migrate(db, { env })).toBe(14);
    for (const [table, column] of MIGRATION_14_COLUMNS) {
      expect(columns(db, table).find((c) => c.name === column), `${table}.${column}`).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    }
    for (const [table, rows] of Object.entries(before)) {
      const added = MIGRATION_14_COLUMNS.filter(([t]) => t === table).map(([, c]) => c);
      const now = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      expect(now.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !added.includes(k as never))))).toEqual(rows);
      for (const r of now) for (const c of added) expect(r[c], `${table}.${c}`).toBeNull();
    }
    // Yazılabilir: üye ve geçit çağrı kimliği.
    db.prepare("INSERT INTO job_log (org_id, job_id, step, message, at, member_id) VALUES ('firma', 'is', 'adim', 'mesaj', ?, 'uye-1')").run(at);
    db.prepare("UPDATE ai_calls SET member_id = 'uye-1', gateway_call_id = 'gc-1' WHERE id = 'c1'").run();
    expect(db.prepare("SELECT member_id, gateway_call_id FROM ai_calls WHERE id = 'c1'").get()).toEqual({ member_id: "uye-1", gateway_call_id: "gc-1" });

    const snap = schema(db);
    runMigration14(db, env);
    expect(schema(db)).toEqual(snap);
  });
});
