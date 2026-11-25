import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FEATURE_KEYS, FeatureStateSchema, ProfileSchema, SetupStateSchema, effectiveFeatures, upgradeProfileInput } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../org/tables.ts";
import { applyMigration, migrate, openDatabase } from "./database.ts";
import { MIGRATION_9_TABLES } from "./migrations/0009-firma.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import { verifyBackup } from "./database.ts";

/** İlk `n` göç uygulanmış veritabanı. */
function dbAtVersion(n: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let v = 0; v < n; v++) applyMigration(db, MIGRATIONS[v]!);
  db.exec(`PRAGMA user_version = ${n}`);
  return db;
}

/** Göç 7'den önceki (Figma kalıntılı) şemada veritabanı. */
const dbAtVersion6 = () => dbAtVersion(6);

const at = "2026-10-01T00:00:00.000Z";
const get = <T>(db: DatabaseSync, sql: string, ...args: string[]) => db.prepare(sql).get(...args) as T;

describe("göç 7: Figma kalıntıları", () => {
  it("eski değerler bugünkü karşılıklarına çevrilir, Figma tabloları ve sütunu kalkar; diğer veri aynı kalır", () => {
    const db = dbAtVersion6();
    const issue = (code: string) => ({ code, severity: "warning", message: code });
    db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('dil', 'Dil', '${at}')`);
    db.exec(`INSERT INTO batches (id, language_id, name, created_at) VALUES ('b', 'dil', 'Parti', '${at}')`);
    const job = db.prepare(
      `INSERT INTO jobs (id, batch_id, seq, raw, text_raw, text, status, issues, run_issues, dedupe_key, created_at, updated_at)
       VALUES (?, 'b', ?, '{}', 'metin', 'metin', ?, ?, ?, ?, '${at}', '${at}')`,
    );
    job.run("j1", 1, "in-figma", JSON.stringify([issue("figma-check"), issue("long-line"), "düz"]), JSON.stringify([issue("figma-error")]), "d1");
    job.run("j2", 2, "figma-withdraw", "[]", "[]", "d2");
    job.run("j3", 3, "ready", JSON.stringify([issue("long-line")]), "bozuk {figma-", "d3");
    db.exec(
      `INSERT INTO variants (id, job_id, no, kind, snapshot, preview_file, figma, created_at) VALUES ('v1', 'j1', 1, 'engine', '{}', 'p.png', '{"nodeId":"1:2"}', '${at}')`,
    );
    const tpl = { key: "1", languageId: "dil", file: "1.png", width: 10, height: 10, notes: "çiçek ♥", figma: { nodeId: "271:2483", name: "1" } };
    db.prepare(`INSERT INTO templates (language_id, key, data, created_at, updated_at) VALUES ('dil', '1', ?, '${at}', '${at}')`).run(JSON.stringify(tpl));
    const ptpl = db.prepare(`INSERT INTO print_templates (id, language_id, name, kind, data, created_at, updated_at) VALUES (?, 'dil', ?, 'label', ?, '${at}', '${at}')`);
    ptpl.run("p1", "Eski", JSON.stringify({ id: "p1", source: "figma" }));
    ptpl.run("p2", "Izgara", JSON.stringify({ id: "p2", source: "grid" }));
    const sess = db.prepare(`INSERT INTO print_sessions (id, language_id, name, status, template_snapshots, created_at, updated_at) VALUES (?, 'dil', 'Oturum', ?, ?, '${at}', '${at}')`);
    const snapshots = { p1: { id: "p1", source: "figma", slots: [{ cx: 1.25, cy: 2 }] }, p2: { id: "p2", source: "grid" }, eski: "metin", n: 5 };
    sess.run("s1", "printed", JSON.stringify(snapshots));
    sess.run("s2", "printed", "bozuk {\"figma\"");
    sess.run("s3", "draft", null);
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify({ concurrency: 2, figmaStuckMinutes: 10 }));
    db.prepare("INSERT INTO settings (key, value) VALUES ('diger', ?)").run(JSON.stringify({ figmaStuckMinutes: 1 }));
    const prop = db.prepare(`INSERT INTO learn_proposals (id, language_id, status, title, evidence, created_at) VALUES (?, 'dil', 'open', 'Öneri', ?, '${at}')`);
    prop.run("l1", JSON.stringify({ source: "learn-run", origin: "figma", count: 3 }));
    prop.run("l2", JSON.stringify({ source: "learn-run", origin: "adjust", count: 4 }));
    prop.run("l3", "bozuk");
    db.exec(`INSERT INTO figma_queue (id, job_id, variant_id, status, created_at, updated_at) VALUES ('q', 'j1', 'v1', 'done', '${at}', '${at}')`);
    db.exec(`INSERT INTO figma_calibration (font_id, family, style, updated_at) VALUES ('A/R', 'A', 'R', '${at}')`);

    // Yalnız göç 7 (göç 9 firma ayarlarını `org_settings`'e taşır; o ayrı test edilir).
    expect(migrate(db, { to: 7 })).toBe(7);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version").user_version).toBe(7);

    const jobs = db.prepare("SELECT id, status, issues, run_issues FROM jobs ORDER BY seq").all() as { id: string; status: string; issues: string; run_issues: string }[];
    expect(jobs.map((j) => [j.id, j.status])).toEqual([["j1", "approved"], ["j2", "approved"], ["j3", "ready"]]);
    expect(JSON.parse(jobs[0]!.issues)).toEqual([issue("long-line"), "düz"]);
    expect(JSON.parse(jobs[0]!.run_issues)).toEqual([]);
    expect(JSON.parse(jobs[2]!.issues)).toEqual([issue("long-line")]);
    expect(jobs[2]!.run_issues).toBe("bozuk {figma-");

    const { figma, ...rest } = tpl;
    expect(figma).toBeDefined();
    expect(JSON.parse(get<{ data: string }>(db, "SELECT data FROM templates").data)).toEqual(rest);
    expect(db.prepare("SELECT id, data FROM print_templates ORDER BY id").all().map((r) => JSON.parse(String(r.data)).source)).toEqual(["manual", "grid"]);
    const sessions = db.prepare("SELECT id, template_snapshots FROM print_sessions ORDER BY id").all() as { id: string; template_snapshots: string | null }[];
    expect(JSON.parse(sessions[0]!.template_snapshots!)).toEqual({ ...snapshots, p1: { ...snapshots.p1, source: "manual" } });
    expect(sessions[1]!.template_snapshots).toBe('bozuk {"figma"');
    expect(sessions[2]!.template_snapshots).toBeNull();
    expect(JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'app'").value)).toEqual({ concurrency: 2 });
    expect(JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'diger'").value)).toEqual({ figmaStuckMinutes: 1 });
    const props = db.prepare("SELECT id, evidence FROM learn_proposals ORDER BY id").all() as { id: string; evidence: string }[];
    expect(JSON.parse(props[0]!.evidence)).toEqual({ source: "learn-run", origin: "reference", count: 3 });
    expect(JSON.parse(props[1]!.evidence).origin).toBe("adjust");
    expect(props[2]!.evidence).toBe("bozuk");

    const names = (db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
    expect(names.filter((n) => n.includes("figma"))).toEqual([]);
    const cols = (db.prepare("PRAGMA table_info(variants)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("figma");
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM variants").n).toBe(1);
  });

  it("yeni veritabanında Figma tablosu ya da sütunu yok", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
    expect(names.filter((n) => n.includes("figma"))).toEqual([]);
    const cols = (db.prepare("PRAGMA table_info(variants)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("figma");
  });
});

describe("göç 8: profildeki Figma bölümü", () => {
  const rows = (db: DatabaseSync) =>
    (db.prepare("SELECT version, data FROM profile_versions ORDER BY version").all() as { version: number; data: string }[]).map((r) => [r.version, r.data] as const);

  it("figma.frameName → printing.orderNamePattern, ölü alanlar gider; bozuk ve ilgisiz satırlar aynen kalır; ikinci koşu değiştirmez", () => {
    const db = dbAtVersion(7);
    db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('dil', 'Dil', '${at}')`);
    const ins = db.prepare(`INSERT INTO profile_versions (id, language_id, version, status, data, created_at) VALUES (?, 'dil', ?, ?, ?, '${at}')`);
    const dead = { maxShrink: 0.03, maxShiftPx: 4 };
    const cases: [string, string][] = [
      ["published", JSON.stringify({ name: "Ana", printing: { dpi: 300 }, figma: { frameName: "{orderNo}_{quantity}adet", ...dead } })],
      ["draft", JSON.stringify({ name: "Taslak ♥", figma: { frameName: "{orderNo}-{template}", ...dead } })],
      ["published", JSON.stringify({ name: "İkisi", printing: { orderNamePattern: "yeni" }, figma: { frameName: "eski", ...dead } })],
      ["published", JSON.stringify({ name: "Ölü", figma: dead })],
      ["published", JSON.stringify({ name: "Boş", figma: { frameName: "", ...dead } })],
      ["published", JSON.stringify({ name: "Sayı", figma: { frameName: 5 } })],
      ["published", JSON.stringify({ name: "Bozuk baskı", printing: "x", figma: { frameName: "a" } })],
      ["published", 'bozuk {"figma":'],
      ["published", JSON.stringify([{ figma: { frameName: "dizi" } }])],
      ["published", JSON.stringify({ name: "Yeni", printing: { orderNamePattern: "{orderNo}" } })],
    ];
    for (const [i, [status, data]] of cases.entries()) ins.run(`p${i + 1}`, i + 1, status, data);
    const before = rows(db);

    expect(migrate(db)).toBe(MIGRATIONS.length);
    const after = rows(db);
    const parsed = after.map(([, d]) => {
      try {
        return JSON.parse(d) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    expect(parsed[0]).toEqual({ name: "Ana", printing: { dpi: 300, orderNamePattern: "{orderNo}_{quantity}adet" } });
    expect(parsed[1]).toEqual({ name: "Taslak ♥", printing: { orderNamePattern: "{orderNo}-{template}" } });
    expect(parsed[2]).toEqual({ name: "İkisi", printing: { orderNamePattern: "eski" } }); // eski adla gelen kazanır
    expect(parsed[3]).toEqual({ name: "Ölü" });
    expect(parsed[4]).toEqual({ name: "Boş", printing: { orderNamePattern: "" } });
    expect(parsed[5]).toEqual({ name: "Sayı" });
    expect(parsed[6]).toEqual({ name: "Bozuk baskı", printing: "x" });
    expect(after[7]).toEqual(before[7]); // bozuk JSON
    expect(after[8]).toEqual(before[8]); // nesne değil
    expect(after[9]).toEqual(before[9]); // zaten yeni biçim
    expect(after.filter(([, d]) => d.includes('"figma"') && !d.startsWith("bozuk") && !d.startsWith("["))).toEqual([]);

    // Göç ile okuma anındaki çeviri (`upgradeProfileInput`) aynı sonucu verir.
    for (const i of [0, 1, 2, 3, 4]) {
      const fromSql = ProfileSchema.parse(parsed[i]);
      const fromTs = ProfileSchema.parse(upgradeProfileInput(JSON.parse(before[i]![1])));
      expect(fromSql).toEqual(fromTs);
      expect(fromSql).not.toHaveProperty("figma");
    }

    // İkinci koşu: hiçbir satır değişmez.
    applyMigration(db, MIGRATIONS[7]!);
    expect(rows(db)).toEqual(after);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(rows(db)).toEqual(after);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version").user_version).toBe(MIGRATIONS.length);
  });
});

// ---------------------------------------------------------------- göç 9: firma alanı

/** Ebeveynin çocuktan önce geldiği sıra (silme sırasının tersi). */
const PARENT_FIRST = [...TENANT_TABLES].reverse() as string[];

/**
 * Göç 8 şemasındaki 22 kiracı tablosunun her birine bir satır (ebeveyn önce). Zorunlu sütunlar türüne göre doldurulur;
 * yabancı anahtarlar ebeveyn kimliğine bağlanır.
 */
function seedAllTables(db: DatabaseSync): void {
  const order = [...MIGRATION_9_TABLES].sort((a, b) => PARENT_FIRST.indexOf(a) - PARENT_FIRST.indexOf(b));
  const fk: Record<string, string> = { language_id: "dil", batch_id: "batches-1", job_id: "jobs-1", page_id: "print_pages-1" };
  const special: Record<string, Record<string, string | number>> = {
    languages: { id: "dil" },
    profile_versions: { status: "published", version: 1 },
    print_sessions: { status: "draft" },
    design_session_entries: { session_id: "design_sessions-1" },
    print_pages: { session_id: "print_sessions-1" },
    print_exports: { session_id: "print_sessions-1" },
  };
  for (const t of order) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
    const names: string[] = [];
    const values: (string | number)[] = [];
    for (const c of cols) {
      if (c.pk && c.type === "INTEGER") continue; // AUTOINCREMENT
      const sp = special[t]?.[c.name];
      let v: string | number | undefined;
      if (sp !== undefined) v = sp;
      else if (c.name === "id" || c.name === "token") v = `${t}-1`;
      else if (fk[c.name]) v = fk[c.name]!;
      else if (c.notnull && c.dflt_value === null) v = c.type === "INTEGER" ? 1 : c.type === "REAL" ? 1.5 : `${t}.${c.name}`;
      if (v === undefined) continue;
      names.push(c.name);
      values.push(v);
    }
    db.prepare(`INSERT INTO ${t} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
  }
}

const counts = (db: DatabaseSync) => Object.fromEntries(MIGRATION_9_TABLES.map((t) => [t, get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`).n]));
const settingsRows = (db: DatabaseSync) => db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
const schema = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
const env = { now: () => "2026-11-21T09:00:00.000Z", newId: () => "0197a000-0000-7000-8000-000000000001" };

describe("göç 9: firma alanı", () => {
  it("taze kurulumda firma açılmaz; tablolar ve sütunlar kurulur", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM orgs").n).toBe(0);
    expect(settingsRows(db)).toEqual([]);
    for (const t of MIGRATION_9_TABLES) expect((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name), t).toContain("org_id");
    // org_id'siz ekleme durur (göç 10'un kalıcı tetikleyicisi).
    expect(() => db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('x', 'X', '${at}')`)).toThrow(/org_id boş \(languages\)/);
  });

  it("mevcut veri sahibin firmasına atanır, firma ayarları taşınır, anahtarlar kurulumda kalır; satır sayıları aynı", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    const app = JSON.stringify({ concurrency: 2, defaultLanguageId: "dil" });
    set.run("app", app);
    set.run("key:anthropic", JSON.stringify({ format: "sealed", value: "şifreli" }));
    set.run("key:gemini", JSON.stringify({ format: "dpapi", value: "eski" }));
    set.run("imported:dil", JSON.stringify({ at }));
    set.run("print.presets.dil", "[]");
    set.run("diger", "1");
    const before = counts(db);
    expect(Object.values(before).every((n) => n === 1)).toBe(true);

    // Göç 9'un kendi davranışı (geçici doldurma dahil) 9'da durarak denenir; sıkı kip (göç 10) aşağıda.
    expect(migrate(db, { env, to: 9 })).toBe(9);
    const owner = env.newId();
    expect(db.prepare("SELECT id, name, source, created_at, closed_at, purged_at FROM orgs").all()).toEqual([
      { id: owner, name: "Firmam", source: "local", created_at: env.now(), closed_at: null, purged_at: null },
    ]);
    expect(counts(db)).toEqual(before);
    for (const t of MIGRATION_9_TABLES) expect(db.prepare(`SELECT DISTINCT org_id FROM ${t}`).all().map((r) => r.org_id), t).toEqual([owner]);
    expect(settingsRows(db).map((r) => r.key)).toEqual(["diger", "install.defaultOrgId", "install.ownerOrgId", "key:anthropic", "key:gemini"]);
    expect(JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'install.ownerOrgId'").value)).toBe(owner);
    expect(JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'install.defaultOrgId'").value)).toBe(owner);
    expect(db.prepare("SELECT org_id, key, value FROM org_settings ORDER BY key").all()).toEqual([
      { org_id: owner, key: "app", value: app },
      { org_id: owner, key: "imported:dil", value: JSON.stringify({ at }) },
      { org_id: owner, key: "print.presets.dil", value: "[]" },
    ]);

    // Geçiş: org_id'siz yeni satıra varsayılan firma yazılır; dolu org_id değiştirilemez (çocuk tablo dahil).
    db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('yeni', 'Yeni', '${at}')`);
    expect(get<{ org_id: string }>(db, "SELECT org_id FROM languages WHERE id = 'yeni'").org_id).toBe(owner);
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES ('baska', 'B', 'local', ?)").run(at);
    expect(() => db.exec("UPDATE languages SET org_id = 'baska' WHERE id = 'dil'")).toThrow(/org_id değiştirilemez \(languages\)/);
    expect(() => db.exec("UPDATE print_items SET org_id = NULL")).toThrow(/org_id değiştirilemez \(print_items\)/);
    expect(() => db.exec("UPDATE org_settings SET org_id = 'baska' WHERE key = 'app'")).toThrow(/org_id değiştirilemez \(org_settings\)/);
    // Açık firmayla ekleme doldurulmaz; bilinmeyen firma yabancı anahtara takılır.
    db.exec(`INSERT INTO languages (id, name, created_at, org_id) VALUES ('b-dil', 'B', '${at}', 'baska')`);
    expect(get<{ org_id: string }>(db, "SELECT org_id FROM languages WHERE id = 'b-dil'").org_id).toBe("baska");
    expect(() => db.exec(`INSERT INTO languages (id, name, created_at, org_id) VALUES ('c', 'C', '${at}', 'yok')`)).toThrow(/FOREIGN KEY/);
  });

  it("ikinci koşu hiçbir şeyi değiştirmez", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', '{}')").run();
    migrate(db, { env });
    const snap = () => ({ schema: schema(db), counts: counts(db), settings: settingsRows(db), orgs: db.prepare("SELECT * FROM orgs").all() });
    const first = snap();
    expect(migrate(db, { env: { newId: () => "0197a000-0000-7000-8000-00000000ffff" } })).toBe(MIGRATIONS.length);
    expect(snap()).toEqual(first);
  });

  it("yarıda kalırsa bütünüyle geri alınır (sürüm, sütunlar, tablolar, ayarlar eski hâlinde); engel kalkınca tamamlanır", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', '{}')").run();
    // Göçün son adımındaki dizin adı önceden alınmış: ALTER, UPDATE ve ayar taşımasından SONRA düşer.
    db.exec("CREATE INDEX design_sessions_org_lang ON undo(token)");
    const snap = () => ({ schema: schema(db), counts: counts(db), settings: settingsRows(db) });
    const before = snap();
    expect(() => migrate(db, { env })).toThrow(/design_sessions_org_lang/);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version").user_version).toBe(8);
    expect(snap()).toEqual(before);
    expect(db.isTransaction).toBe(false);

    db.exec("DROP INDEX design_sessions_org_lang");
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM orgs").n).toBe(1);
  });

  it("bekleyen göç varsa açılışta önce yedek alınır (WAL boşaltılmış tek dosya); taze ve güncel veritabanında alınmaz", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "goc9-"));
    try {
      const file = path.join(dir, "studio.db");
      const old = new DatabaseSync(file);
      old.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      for (let v = 0; v < 6; v++) applyMigration(old, MIGRATIONS[v]!);
      old.exec("PRAGMA user_version = 6");
      seedAllTables(old);
      old.close();

      const db = openDatabase(file, { env });
      expect(get<{ user_version: number }>(db, "PRAGMA user_version").user_version).toBe(MIGRATIONS.length);
      db.close();
      const backups = readdirSync(path.join(dir, "yedek"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^db-\d{4}-\d{2}-\d{2}-goc-7-oncesi$/);
      const copy = new DatabaseSync(path.join(dir, "yedek", backups[0]!, "studio.db"), { readOnly: true });
      expect(get<{ user_version: number }>(copy, "PRAGMA user_version").user_version).toBe(6);
      expect(get<{ n: number }>(copy, "SELECT COUNT(*) AS n FROM jobs").n).toBe(1);
      copy.close();

      openDatabase(file).close(); // güncel: yedek yok
      expect(readdirSync(path.join(dir, "yedek"))).toHaveLength(1);
      openDatabase(path.join(dir, "taze", "studio.db")).close(); // taze: yedek yok
      expect(existsSync(path.join(dir, "taze", "yedek"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("göç 10: sıkı firma kipi", () => {
  const triggers = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

  it("geçici doldurma kalkar: boş org_id her durumda durur, firma hiç değişmez; satır sayıları aynı; ikinci koşu değiştirmez", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    migrate(db, { env, to: 9 });
    // Göç 9'un geçici doldurmasıyla eklenen satır (eski kodun kapsamsız INSERT'i) sahibin firmasına yazılmıştır.
    db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('ara', 'Ara', '${at}')`);
    const before = counts(db);
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS).toHaveLength(14);
    expect(counts(db)).toEqual(before);
    const names = triggers(db);
    expect(names.filter((n) => n.endsWith("_org_fill"))).toEqual([]);
    for (const t of MIGRATION_9_TABLES) expect(names, t).toEqual(expect.arrayContaining([`${t}_org_required`, `${t}_org_immutable`]));
    // Varsayılan firma varken de boş org_id durur; boştan doluya ve firmadan firmaya geçiş de engellenir.
    expect(() => db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('yeni', 'Yeni', '${at}')`)).toThrow(/org_id boş \(languages\)/);
    expect(() => db.exec("UPDATE languages SET org_id = NULL")).toThrow(/org_id değiştirilemez \(languages\)/);
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES ('baska', 'B', 'local', ?)").run(at);
    expect(() => db.exec("UPDATE jobs SET org_id = 'baska'")).toThrow(/org_id değiştirilemez \(jobs\)/);
    // Aynı değere güncelleme ve açık firmayla ekleme serbest.
    db.exec("UPDATE languages SET org_id = org_id, name = 'Dil 2' WHERE id = 'dil'");
    db.exec(`INSERT INTO languages (id, name, created_at, org_id) VALUES ('yeni', 'Yeni', '${at}', 'baska')`);
    expect(counts(db).languages).toBe(before.languages! + 1);

    const snap = () => ({ schema: schema(db), counts: counts(db), settings: settingsRows(db) });
    const first = snap();
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    expect(snap()).toEqual(first);
  });

  it("boş org_id'li satır kaldıysa göç durur ve bütünüyle geri alınır (sürüm 9, geçici tetikleyiciler yerinde)", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    migrate(db, { env, to: 9 });
    db.exec("DROP TRIGGER languages_org_fill");
    db.exec(`INSERT INTO languages (id, name, created_at) VALUES ('bos', 'Boş', '${at}')`);
    const before = triggers(db);
    expect(() => migrate(db, { env })).toThrow(/languages tablosunda org_id boş 1 satır/);
    expect(get<{ user_version: number }>(db, "PRAGMA user_version").user_version).toBe(9);
    expect(triggers(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });
});

describe("göç 11: özellikler ve kurulum durumu", () => {
  const orgSetting = (db: DatabaseSync, org: string, key: string) =>
    (db.prepare("SELECT value FROM org_settings WHERE org_id = ? AND key = ?").get(org, key) as { value: string } | undefined)?.value ?? null;
  const orgSettings = (db: DatabaseSync) => db.prepare("SELECT org_id, key, value FROM org_settings ORDER BY org_id, key").all();

  it("verisi olan sahip firmada bütün özellikler açık (göç), kurulum tamamlanmış; görsel denetim ayarı silinir", () => {
    const db = dbAtVersion(8);
    seedAllTables(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify({ concurrency: 2, visualCritique: true }));
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    const owner = env.newId();
    const explicit = FeatureStateSchema.parse(JSON.parse(orgSetting(db, owner, "features")!));
    expect(Object.keys(explicit).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(Object.values(explicit).every((c) => c!.on && c!.by === "migration" && c!.at === env.now())).toBe(true);
    expect(Object.values(effectiveFeatures(explicit)).every(Boolean)).toBe(true);
    expect(SetupStateSchema.parse(JSON.parse(orgSetting(db, owner, "setup")!))).toEqual({
      status: "completed",
      step: 3,
      answers: { labelTypes: [] },
      completedAt: env.now(),
      skipped: false,
    });
    // Görsel denetim üründen kalktı (SUNUCU-PLANI §9): ayardan yalnız o alan silinir.
    expect(JSON.parse(orgSetting(db, owner, "app")!)).toEqual({ concurrency: 2 });
  });

  it("bozuk ayar atlanır; verisi olmayan firma kayıtsız (pending) ama denetim ayarı silinir; mevcut kayda dokunulmaz; ikinci koşu değiştirmez", () => {
    const db = dbAtVersion(10);
    const org = db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES (?, ?, 'local', ?)");
    const lang = db.prepare("INSERT INTO languages (id, name, created_at, org_id) VALUES (?, 'Dil', ?, ?)");
    const set = db.prepare("INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)");
    for (const id of ["bozuk", "bos", "kayitli", "ayarsiz"]) org.run(id, id, at);
    lang.run("d1", at, "bozuk");
    set.run("bozuk", "app", "{bozuk json");
    lang.run("d2", at, "kayitli");
    set.run("kayitli", "features", "bozuk{");
    lang.run("d3", at, "ayarsiz");
    set.run("bos", "app", JSON.stringify({ variantsPerRun: 2, visualCritique: true, concurrency: 3 }));
    set.run("ayarsiz", "app", "[1]");
    applyMigration(db, MIGRATIONS[10]!, env);

    for (const id of ["bozuk", "ayarsiz"]) {
      const explicit = FeatureStateSchema.parse(JSON.parse(orgSetting(db, id, "features")!));
      expect(Object.keys(explicit).sort(), id).toEqual([...FEATURE_KEYS].sort());
      expect(explicit.learn, id).toMatchObject({ on: true, by: "migration" });
      expect(JSON.parse(orgSetting(db, id, "setup")!).status, id).toBe("completed");
    }
    // Verisi olmayan firma: kayıt yok (sunucu `pending` ve kayıt varsayılanlarıyla okur).
    expect(orgSetting(db, "bos", "features")).toBeNull();
    expect(orgSetting(db, "bos", "setup")).toBeNull();
    expect(orgSetting(db, "bos", "app")).toBe(JSON.stringify({ variantsPerRun: 2, concurrency: 3 }));
    // Bozuk ya da nesne olmayan ayar olduğu gibi kalır.
    expect(orgSetting(db, "bozuk", "app")).toBe("{bozuk json");
    expect(orgSetting(db, "ayarsiz", "app")).toBe("[1]");
    // Var olan (bozuk) özellik kaydı korunur; eksik kurulum kaydı yazılır.
    expect(orgSetting(db, "kayitli", "features")).toBe("bozuk{");
    expect(JSON.parse(orgSetting(db, "kayitli", "setup")!).status).toBe("completed");

    const first = orgSettings(db);
    applyMigration(db, MIGRATIONS[10]!, { now: () => "2027-01-01T00:00:00.000Z" });
    expect(orgSettings(db)).toEqual(first);
  });

  it("taze kurulumda firma ayarı yazılmaz", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    expect(migrate(db, { env })).toBe(MIGRATIONS.length);
    expect(orgSettings(db)).toEqual([]);
  });
});

describe("göç öncesi yedeğin doğrulanması", () => {
  it("bozuk ya da eksik kopya kabul edilmez", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yedek-"));
    try {
      const bad = path.join(dir, "bozuk.db");
      writeFileSync(bad, "SQLite format 3\u0000 bozuk içerik");
      expect(() => verifyBackup(bad, 6, {})).toThrow(/doğrulanamadı/);
      const ok = path.join(dir, "iyi.db");
      const db = new DatabaseSync(ok);
      db.exec("CREATE TABLE a (x); INSERT INTO a VALUES (1); PRAGMA user_version = 6;");
      db.close();
      expect(() => verifyBackup(ok, 6, { a: 1 })).not.toThrow();
      expect(() => verifyBackup(ok, 6, { a: 2 })).toThrow(/satır sayısı/);
      expect(() => verifyBackup(ok, 5, { a: 1 })).toThrow(/sürüm/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("göç öncesi yedek: başarısız açılışın tekrarı", () => {
  it("aynı sürüm ve aynı içerikle yeniden açılışta ikinci yedek alınmaz; içerik değişince yeni yedek alınır", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yedek-tekrar-"));
    try {
      const file = path.join(dir, "studio.db");
      const old = new DatabaseSync(file);
      old.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      for (let v = 0; v < 8; v++) applyMigration(old, MIGRATIONS[v]!);
      old.exec("PRAGMA user_version = 8");
      seedAllTables(old);
      // Göç 9'u son adımında düşüren engel (başarısız açılış).
      old.exec("CREATE INDEX design_sessions_org_lang ON undo(token)");
      old.close();
      expect(() => openDatabase(file, { env })).toThrow(/design_sessions_org_lang/);
      expect(() => openDatabase(file, { env })).toThrow(/design_sessions_org_lang/);
      expect(readdirSync(path.join(dir, "yedek"))).toHaveLength(1);
      const fix = new DatabaseSync(file);
      fix.exec("DROP INDEX design_sessions_org_lang");
      fix.close();
      openDatabase(file, { env }).close();
      expect(readdirSync(path.join(dir, "yedek"))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
