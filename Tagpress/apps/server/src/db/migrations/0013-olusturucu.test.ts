import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigration, openDatabase } from "../database.ts";
import { MIGRATIONS } from "./index.ts";
import { migration as runMigration13 } from "./0013-olusturucu.ts";

const at = "2026-11-22T00:00:00.000Z";
const env = { now: () => at, newId: () => "id" };

/** Göç 12'ye kadar uygulanmış veritabanı: MCP oturumu ve girdisi olan iki firma. */
function atVersion12(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let v = 0; v < 12; v++) applyMigration(db, MIGRATIONS[v]!, env);
  db.exec("PRAGMA user_version = 12");
  for (const org of ["firma-a", "firma-b"]) {
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES (?, ?, 'local', ?)").run(org, org, at);
    db.prepare("INSERT INTO languages (id, name, created_at, org_id) VALUES (?, 'Dil', ?, ?)").run(`dil-${org}`, at, org);
    db.prepare("INSERT INTO design_sessions (id, language_id, title, status, started_at, updated_at, org_id) VALUES (?, ?, 'MCP', 'asking', ?, ?, ?)").run(`s-${org}`, `dil-${org}`, at, at, org);
    db.prepare("INSERT INTO design_session_entries (session_id, at, kind, grp, text, paths, org_id) VALUES (?, ?, 'question', 'boyut', 'Soru?', NULL, ?)").run(`s-${org}`, at, org);
  }
  return db;
}

const dump = (db: DatabaseSync, t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
const schema = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

describe("göç 13: oluşturucu", () => {
  it("dizide 13. sırada; MCP oturumları `mcp` olarak kalır, verisi değişmez; yeni tablolar ve sütunlar kurulur", () => {
    expect(MIGRATIONS[12]).toBe(runMigration13);
    const db = atVersion12();
    const before = dump(db, "design_session_entries");
    runMigration13(db, env);
    const rows = db.prepare("SELECT id, mode, state, current_rev, cost_usd, budget_raised FROM design_sessions ORDER BY id").all();
    expect(rows).toEqual([
      { id: "s-firma-a", mode: "mcp", state: null, current_rev: 0, cost_usd: 0, budget_raised: 0 },
      { id: "s-firma-b", mode: "mcp", state: null, current_rev: 0, cost_usd: 0, budget_raised: 0 },
    ]);
    expect(dump(db, "design_session_entries").map((r) => ({ ...r, role: undefined, data: undefined, turn_seq: undefined }))).toEqual(before.map((r) => ({ ...r, role: undefined, data: undefined, turn_seq: undefined })));
    for (const t of ["design_session_turns", "profile_revisions", "design_samples"]) expect(dump(db, t)).toEqual([]);
    const cols = (db.prepare("PRAGMA table_info(ai_calls)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("build_id");
    const colsOf = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    // Yayın denetimi (açılıştaki yayınlanmış sürüm) ve ayrılmış küme kuralı (modele gösterilen örnek test olmaz).
    expect(colsOf("design_sessions")).toContain("start_version");
    expect(colsOf("design_samples")).toContain("shown_at");
  });

  it("`shown_at` sütunu olmadan kurulmuş örnek tablosuna ikinci koşuda eklenir (veri korunur)", () => {
    const db = atVersion12();
    runMigration13(db, env);
    db.exec(`INSERT INTO design_samples (id, org_id, session_id, language_id, seq, name, w, h, status, created_at) VALUES ('x', 'firma-a', 's-firma-a', 'dil-firma-a', 1, 'a.png', 10, 10, 'uploaded', '${at}')`);
    db.exec("ALTER TABLE design_samples DROP COLUMN shown_at");
    runMigration13(db, env);
    expect(db.prepare("SELECT id, shown_at FROM design_samples").all()).toEqual([{ id: "x", shown_at: null }]);
  });

  it("bir dilde tek etkin site oturumu (yayınlanan / kapanan sayılmaz); MCP oturumları sınırsız", () => {
    const db = atVersion12();
    runMigration13(db, env);
    const ins = db.prepare("INSERT INTO design_sessions (id, language_id, title, status, started_at, updated_at, org_id, mode, state) VALUES (?, 'dil-firma-a', '', 'idle', ?, ?, 'firma-a', ?, ?)");
    ins.run("m2", at, at, "mcp", null);
    ins.run("site1", at, at, "site", "review");
    expect(() => ins.run("site2", at, at, "site", "intake")).toThrow(/UNIQUE/);
    db.exec("UPDATE design_sessions SET state = 'published' WHERE id = 'site1'");
    ins.run("site2", at, at, "site", "intake");
    db.exec("UPDATE design_sessions SET state = 'closed' WHERE id = 'site2'");
    ins.run("site3", at, at, "site", "failed");
    // Başka firmanın aynı adlı dili ayrı.
    db.prepare("INSERT INTO design_sessions (id, language_id, title, status, started_at, updated_at, org_id, mode, state) VALUES ('b1', 'dil-firma-a', '', 'idle', ?, ?, 'firma-b', 'site', 'intake')").run(at, at);
  });

  it("yeni kiracı tablolarında boş ya da değişen firma durur; oturum silinince çocukları silinir; revizyon nedeni sınırlı", () => {
    const db = atVersion12();
    runMigration13(db, env);
    expect(() => db.exec(`INSERT INTO design_samples (id, session_id, language_id, seq, name, w, h, status, created_at) VALUES ('x', 's-firma-a', 'dil-firma-a', 1, 'a.png', 10, 10, 'uploaded', '${at}')`)).toThrow(/org_id boş \(design_samples\)/);
    db.exec(`INSERT INTO design_samples (id, org_id, session_id, language_id, seq, name, w, h, status, created_at) VALUES ('x', 'firma-a', 's-firma-a', 'dil-firma-a', 1, 'a.png', 10, 10, 'uploaded', '${at}')`);
    expect(() => db.exec("UPDATE design_samples SET org_id = 'firma-b'")).toThrow(/org_id değiştirilemez \(design_samples\)/);
    db.exec(`INSERT INTO profile_revisions (org_id, session_id, language_id, rev, data, changes, reason, created_at) VALUES ('firma-a', 's-firma-a', 'dil-firma-a', 1, '{}', '[]', 'initial', '${at}')`);
    expect(() => db.exec(`INSERT INTO profile_revisions (org_id, session_id, language_id, rev, data, changes, reason, created_at) VALUES ('firma-a', 's-firma-a', 'dil-firma-a', 2, '{}', '[]', 'uydurma', '${at}')`)).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO profile_revisions (org_id, session_id, language_id, rev, data, changes, reason, created_at) VALUES ('firma-a', 's-firma-a', 'dil-firma-a', 1, '{}', '[]', 'answer', '${at}')`)).toThrow(/UNIQUE/);
    db.exec(`INSERT INTO design_session_turns (org_id, session_id, seq, messages, stop_reason, created_at) VALUES ('firma-a', 's-firma-a', 1, x'00', 'end_turn', '${at}')`);
    db.exec("DELETE FROM design_session_entries WHERE session_id = 's-firma-a'");
    db.exec("DELETE FROM design_sessions WHERE id = 's-firma-a'");
    for (const t of ["design_session_turns", "profile_revisions", "design_samples"]) expect(dump(db, t), t).toEqual([]);
  });

  it("ikinci koşu hata vermez, bir şey değiştirmez; taze kurulumda da kurulur", () => {
    const db = atVersion12();
    runMigration13(db, env);
    const s1 = schema(db);
    const d1 = dump(db, "design_sessions");
    runMigration13(db, env);
    expect(schema(db)).toEqual(s1);
    expect(dump(db, "design_sessions")).toEqual(d1);
    const fresh = openDatabase(":memory:", { backupDir: null });
    expect(fresh.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect((fresh.prepare("PRAGMA table_info(design_sessions)").all() as { name: string }[]).map((c) => c.name)).toEqual(expect.arrayContaining(["mode", "state", "turn_seq", "base_data"]));
  });
});
