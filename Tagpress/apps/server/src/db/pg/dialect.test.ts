import { describe, expect, it } from "vitest";
import { DialectError, toPg, toPgScript } from "./dialect.ts";

/** Mekanik çevirici (plan §2.3): yalnız tanımlı kurallar; tanımadığı SQLite yapısına açık hata. Veritabanı gerekmez. */
describe("SQLite → Postgres çevirici", () => {
  it("? → $n; adlı parametre tek numara alır, tekrarında aynı numara", () => {
    const r = toPg("SELECT * FROM jobs WHERE org_id = $org AND id = ? AND batch_id IN (SELECT id FROM batches WHERE org_id = $org AND name = ?)");
    expect(r.text).toBe("SELECT * FROM jobs WHERE org_id = $1 AND id = $2 AND batch_id IN (SELECT id FROM batches WHERE org_id = $1 AND name = $3)");
    expect(r.slots).toEqual([{ kind: "named", name: "org" }, { kind: "pos", index: 0 }, { kind: "pos", index: 1 }]);
    expect(r.positional).toBe(2);
    expect(r.named).toEqual(["org"]);
  });

  it("metin değişmezi, tırnaklı ad ve yorum içine dokunulmaz", () => {
    const r = toPg(`SELECT 'a ? b LIKE $org' AS "x?", 1 -- ? LIKE\nFROM t WHERE a = ? /* $org ? */`);
    expect(r.text).toBe(`SELECT 'a ? b LIKE $org' AS "x?", 1 -- ? LIKE\nFROM t WHERE a = $1 /* $org ? */`);
    expect(r.slots).toEqual([{ kind: "pos", index: 0 }]);
  });

  it("LIKE → ILIKE (ESCAPE korunur), == → =, IFNULL → COALESCE, BEGIN IMMEDIATE → BEGIN", () => {
    expect(toPg("SELECT 1 FROM t WHERE a LIKE ? ESCAPE '\\' AND b NOT LIKE ?").text).toBe("SELECT 1 FROM t WHERE a ILIKE $1 ESCAPE '\\' AND b NOT ILIKE $2");
    expect(toPg("SELECT IFNULL(a, 0) FROM t WHERE a == 1").text).toBe("SELECT COALESCE(a, 0) FROM t WHERE a = 1");
    expect(toPg("BEGIN IMMEDIATE").text).toBe("BEGIN");
  });

  it("kimlik sütunlu tabloya INSERT → RETURNING id (öbür tablolara eklenmez)", () => {
    const r = toPg("INSERT INTO job_log (org_id, job_id, step, message, at) VALUES ($org, ?, ?, ?, ?)");
    expect(r.text.endsWith(" RETURNING id")).toBe(true);
    expect(r.returnsId).toBe(true);
    expect(toPg("INSERT INTO jobs (org_id, id) VALUES ($org, ?)").returnsId).toBe(false);
    expect(toPg("INSERT INTO adjust_log (org_id, x) VALUES ($org, ?) RETURNING id").text.match(/RETURNING/g)).toHaveLength(1);
  });

  it("karışık harfli adların eşlemesi (Postgres tırnaksız adı küçültür)", () => {
    const r = toPg("SELECT COUNT(*) AS jobCount, MAX(x) AS lastAt FROM t");
    expect(r.rename.get("jobcount")).toBe("jobCount");
    expect(r.rename.get("lastat")).toBe("lastAt");
    expect(r.rename.has("count")).toBe(false);
  });

  it("Postgres yazımının işleçleri (::jsonb, ->>, IS JSON) bozulmaz", () => {
    const r = toPg("SELECT NULLIF((tp.data::jsonb -> 'cut')::text, 'null') AS cut FROM templates tp WHERE tp.snapshot IS JSON OBJECT AND tp.x ->> 'k' = ?");
    expect(r.text).toBe("SELECT NULLIF((tp.data::jsonb -> 'cut')::text, 'null') AS cut FROM templates tp WHERE tp.snapshot IS JSON OBJECT AND tp.x ->> 'k' = $1");
  });

  it.each([
    ["SELECT json_extract(data, '$.cut') FROM t", "json_extract()"],
    ["SELECT 1 FROM t WHERE json_valid(x)", "json_valid()"],
    ["SELECT * FROM t ORDER BY a, rowid", "rowid"],
    ["SELECT * FROM t ORDER BY name COLLATE NOCASE", "COLLATE NOCASE"],
    ["PRAGMA user_version", "pragma"],
    ["SELECT name FROM sqlite_master", "sqlite_master"],
    ["SELECT group_concat(a) FROM t", "group_concat()"],
    ["SELECT strftime('%Y', at) FROM t", "strftime()"],
    ["SELECT datetime('now')", "datetime()"],
    ["INSERT OR IGNORE INTO t (a) VALUES (1)", "INSERT OR IGNORE"],
    ["REPLACE INTO t (a) VALUES (1)", "REPLACE INTO"],
    ["SELECT iif(a, 1, 2) FROM t", "iif()"],
    ["SELECT * FROM t WHERE a = :ad", "parametre yazımı :ad"],
    ["SELECT * FROM t WHERE a = $1", "parametre yazımı $1"],
  ])("tanınmayan SQLite yapısı açık hata: %s", (sql, problem) => {
    let err: unknown;
    try {
      toPg(sql);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DialectError);
    expect((err as DialectError).problems.some((p) => p === problem || p.startsWith(`${problem} `))).toBe(true);
  });

  it("çok ifadeli metin parametre almaz", () => {
    expect(toPgScript("UPDATE t SET a = 1; UPDATE u SET b = 2")).toBe("UPDATE t SET a = 1; UPDATE u SET b = 2");
    expect(() => toPgScript("UPDATE t SET a = ?")).toThrow(DialectError);
  });

  it("COLLATE \"C\" ve COLLATE C geçer", () => {
    expect(toPg('SELECT * FROM t ORDER BY a COLLATE "C"').text).toBe('SELECT * FROM t ORDER BY a COLLATE "C"');
  });
});
