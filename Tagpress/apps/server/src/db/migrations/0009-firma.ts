import type { DatabaseSync } from "node:sqlite";
import type { MigrationEnv } from "./types.ts";

// 9: firma (kiracı) alanı (SUNUCU-PLANI §2.1–2.3). Yeni tablolar `orgs`, `org_settings`; bugünkü 22 kiracı tablosuna
// `org_id` (boş bırakılabilir, `orgs`'a yabancı anahtar: SQLite ALTER ile NOT NULL eklemez) ve firmayla başlayan
// dizinler. Mevcut veri varsa tek firma ("Firmam", kaynak `local`) açılır, bütün satırlar ona atanır, firma ayarları
// (`app`, `print.presets.*`, `imported:*`) `settings`'ten `org_settings`'e taşınır ve `install.ownerOrgId` ile
// `install.defaultOrgId` yazılır. Taze kurulumda firma açılmaz (ilk açılışta `OrgService.ensureLocal`).
// Yapay zekâ anahtarları (`key:*`) kurulum düzeyinde, `settings`'te kalır (YOL-HARITASI 2026-11-21; `org_secrets` yok).
// `settings`'teki tanınmayan anahtarlar olduğu gibi kalır.
//
// Tetikleyiciler (her kiracı tablosunda; üçü de GEÇİŞ biçimi, göç 10 `0010-siki-kip.ts` kalıcı biçimlerine çevirir):
// - `<t>_org_immutable`: dolu `org_id` değiştirilemez (boştan doluya geçişe geçici doldurma için izin verilir).
// - `<t>_org_required`: `org_id` boşsa ve kurulumda varsayılan firma yoksa ekleme durur.
// - `<t>_org_fill`: `org_id` boş eklenen satıra kurulumun varsayılan firması yazılır (göç 10'da kalktı).
//
// Liste bu göçte DONDURULMUŞTUR (göçler değişmez); yaşayan liste `org/tables.ts` `TENANT_TABLES`.

/** Göç 9'un `org_id` eklediği tablolar (22). */
export const MIGRATION_9_TABLES = [
  "languages",
  "profile_versions",
  "templates",
  "batches",
  "jobs",
  "variants",
  "gen_tasks",
  "job_log",
  "ai_calls",
  "refs",
  "learn_proposals",
  "undo",
  "design_sessions",
  "design_session_entries",
  "adjust_log",
  "template_tasks",
  "learn_runs",
  "print_templates",
  "print_sessions",
  "print_pages",
  "print_items",
  "print_exports",
] as const;

/** Eski dizin → yeni (firmayla başlayan) dizin. */
const INDEXES: { drop: string | null; name: string; on: string }[] = [
  { drop: null, name: "languages_org", on: "languages(org_id, created_at)" },
  { drop: "batches_lang", name: "batches_org_lang", on: "batches(org_id, language_id, created_at)" },
  { drop: "jobs_dedupe", name: "jobs_org_dedupe", on: "jobs(org_id, dedupe_key)" },
  { drop: "jobs_created", name: "jobs_org_created", on: "jobs(org_id, created_at)" },
  { drop: "refs_lang", name: "refs_org_lang", on: "refs(org_id, language_id, created_at)" },
  { drop: "ai_calls_created", name: "ai_calls_org_created", on: "ai_calls(org_id, created_at)" },
  { drop: "gen_tasks_status", name: "gen_tasks_status_org", on: "gen_tasks(status, org_id, created_at)" },
  { drop: "print_sessions_language", name: "print_sessions_org_lang", on: "print_sessions(org_id, language_id, status, updated_at)" },
  { drop: "design_sessions_lang", name: "design_sessions_org_lang", on: "design_sessions(org_id, language_id, started_at)" },
];

const ORG_SETTING_KEYS = "key = 'app' OR key LIKE 'print.presets.%' OR key LIKE 'imported:%'";

export function migration(db: DatabaseSync, env: MigrationEnv): void {
  db.exec(`
  CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'account')),
    created_at TEXT NOT NULL,
    closed_at TEXT,
    purged_at TEXT
  );

  CREATE TABLE org_settings (
    org_id TEXT NOT NULL REFERENCES orgs(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
  );
  CREATE TRIGGER org_settings_org_immutable BEFORE UPDATE OF org_id ON org_settings
    WHEN NEW.org_id IS NOT OLD.org_id
    BEGIN SELECT RAISE(ABORT, 'org_id değiştirilemez (org_settings)'); END;
  `);
  for (const t of MIGRATION_9_TABLES) db.exec(`ALTER TABLE ${t} ADD COLUMN org_id TEXT REFERENCES orgs(id);`);

  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const hasData = MIGRATION_9_TABLES.some((t) => count(`SELECT EXISTS (SELECT 1 FROM ${t}) AS n`) > 0) || count(`SELECT EXISTS (SELECT 1 FROM settings WHERE ${ORG_SETTING_KEYS}) AS n`) > 0;
  if (hasData) {
    const owner = env.newId();
    db.prepare("INSERT INTO orgs (id, name, source, created_at) VALUES (?, 'Firmam', 'local', ?)").run(owner, env.now());
    for (const t of MIGRATION_9_TABLES) db.prepare(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`).run(owner);
    db.prepare(`INSERT INTO org_settings (org_id, key, value) SELECT ?, key, value FROM settings WHERE ${ORG_SETTING_KEYS}`).run(owner);
    db.exec(`DELETE FROM settings WHERE ${ORG_SETTING_KEYS}`);
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    set.run("install.ownerOrgId", JSON.stringify(owner));
    set.run("install.defaultOrgId", JSON.stringify(owner));
  }

  for (const t of MIGRATION_9_TABLES) {
    db.exec(`
    CREATE TRIGGER ${t}_org_immutable BEFORE UPDATE OF org_id ON ${t}
      WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
      BEGIN SELECT RAISE(ABORT, 'org_id değiştirilemez (${t})'); END;
    CREATE TRIGGER ${t}_org_required BEFORE INSERT ON ${t}
      WHEN NEW.org_id IS NULL AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'install.defaultOrgId')
      BEGIN SELECT RAISE(ABORT, 'org_id boş (${t})'); END;
    CREATE TRIGGER ${t}_org_fill AFTER INSERT ON ${t}
      WHEN NEW.org_id IS NULL
      BEGIN
        UPDATE ${t} SET org_id = (SELECT json_extract(value, '$') FROM settings WHERE key = 'install.defaultOrgId') WHERE rowid = NEW.rowid;
      END;
    `);
  }

  for (const i of INDEXES) {
    if (i.drop) db.exec(`DROP INDEX IF EXISTS ${i.drop};`);
    db.exec(`CREATE INDEX ${i.name} ON ${i.on};`);
  }
}
