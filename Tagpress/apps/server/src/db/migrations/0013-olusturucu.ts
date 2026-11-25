import type { DatabaseSync } from "node:sqlite";
import type { MigrationEnv } from "./types.ts";

// 13: sitede tasarım dili oluşturucu (SUNUCU-PLANI §4.2, C3). Mevcut oturum tabloları genişler (MCP oturumları aynı
// tabloda `mode = 'mcp'` ile kalır; satırlarına dokunulmaz), üç yeni kiracı tablosu kurulur.
// - `design_sessions`: `mode` (mcp | site; var olan satırlar mcp), durum makinesi (`state`, `resume_state`), taban
//   (`base`, `base_version`, `base_data` = revizyon 0'ın profili), `current_rev`, para (`cost_usd`, `budget_usd`,
//   `budget_raised`), kurulum bilgisi (`from_setup`, `label_types`), model ve istem sürümü, arayüz dili, çalışan tur
//   kilidi (`turn_seq`, `turn_started_at`, `turn_input`, `next_seq`), bekleyen bildirimler (`notices`), hata (`error`),
//   ölçüm anı (`measured_at`), AI kalite denemesi (`quality_ai`), açılıştaki yayınlanmış sürüm (`start_version`; taban
//   varsayılan olsa da: yayında "oturum sürerken başka sürüm yayınlandı mı" denetimi).
//   Bir dilde en çok bir etkin site oturumu: kısmi tekil dizin (`design_sessions_org_active`), yarışta ikinci açılış
//   veritabanında durur.
// - `design_session_entries`: `role`, `data` (JSON: soru, cevap, revizyon, kod + parametre), `turn_seq`.
// - `design_session_turns`: model turlarının ham iletileri (sıkıştırılmış JSON), kullanım ve maliyet. Yalnız eklenir.
// - `profile_revisions`: taslak geçmişi; taslak satırı her zaman son revizyondur.
// - `design_samples`: yüklenen bitmiş etiketler ve ölçümleri; `shown_at` = modele ilk gösterildiği an (gösterilmiş
//   örnek ayrılmış kümeye, `split = 'test'`, bir daha geçmez).
// - `ai_calls.build_id`: oturumun harcamaları (bütçe ve maliyet dökümü).
// Yeni kiracı tablolarında `org_id` NOT NULL değil (göç 9 düzeni): boş eklemeyi ve firma değişikliğini iki tetikleyici
// durdurur (`org/schema.test.ts`). İkinci koşu hata vermez, bir şey değiştirmez.

const NEW_TABLES = ["design_session_turns", "profile_revisions", "design_samples"] as const;

const addColumn = (db: DatabaseSync, table: string, column: string, ddl: string) => {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
};

export function migration(db: DatabaseSync, _env: MigrationEnv): void {
  const S = "design_sessions";
  addColumn(db, S, "mode", "TEXT NOT NULL DEFAULT 'mcp' CHECK (mode IN ('mcp', 'site'))");
  addColumn(db, S, "state", "TEXT");
  addColumn(db, S, "resume_state", "TEXT");
  addColumn(db, S, "base", "TEXT");
  addColumn(db, S, "base_version", "INTEGER");
  addColumn(db, S, "base_data", "TEXT");
  addColumn(db, S, "current_rev", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, S, "cost_usd", "REAL NOT NULL DEFAULT 0");
  addColumn(db, S, "budget_usd", "REAL");
  addColumn(db, S, "budget_raised", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, S, "from_setup", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, S, "label_types", "TEXT");
  addColumn(db, S, "model", "TEXT");
  addColumn(db, S, "prompt_version", "TEXT");
  addColumn(db, S, "locale", "TEXT");
  addColumn(db, S, "turn_seq", "INTEGER");
  addColumn(db, S, "turn_started_at", "TEXT");
  addColumn(db, S, "turn_input", "TEXT");
  addColumn(db, S, "next_seq", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, S, "notices", "TEXT");
  addColumn(db, S, "error", "TEXT");
  addColumn(db, S, "measured_at", "TEXT");
  addColumn(db, S, "quality_ai", "TEXT");
  addColumn(db, S, "start_version", "INTEGER");

  const E = "design_session_entries";
  addColumn(db, E, "role", "TEXT");
  addColumn(db, E, "data", "TEXT");
  addColumn(db, E, "turn_seq", "INTEGER");

  addColumn(db, "ai_calls", "build_id", "TEXT");

  db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS design_sessions_org_active ON design_sessions(org_id, language_id)
    WHERE mode = 'site' AND state NOT IN ('published', 'closed');
  CREATE INDEX IF NOT EXISTS ai_calls_org_build ON ai_calls(org_id, build_id);

  CREATE TABLE IF NOT EXISTS design_session_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT REFERENCES orgs(id),
    session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    messages BLOB NOT NULL,
    usage TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS design_session_turns_org ON design_session_turns(org_id, session_id, seq);

  CREATE TABLE IF NOT EXISTS profile_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT REFERENCES orgs(id),
    session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
    language_id TEXT NOT NULL,
    rev INTEGER NOT NULL CHECK (rev > 0),
    data TEXT NOT NULL,
    changes TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('initial', 'answer', 'correction', 'restore', 'manual')),
    summary TEXT NOT NULL DEFAULT '',
    entry_id INTEGER,
    restored_from INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, rev)
  );
  CREATE INDEX IF NOT EXISTS profile_revisions_org ON profile_revisions(org_id, session_id, rev);

  CREATE TABLE IF NOT EXISTS design_samples (
    id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES orgs(id),
    session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
    language_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    w INTEGER NOT NULL,
    h INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('uploaded', 'measured', 'qualitative', 'failed')),
    measurement TEXT,
    template_key TEXT,
    font_file TEXT,
    split TEXT CHECK (split IN ('train', 'test')),
    excluded INTEGER NOT NULL DEFAULT 0,
    reference_id TEXT,
    error TEXT,
    shown_at TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS design_samples_org ON design_samples(org_id, session_id, seq);
  `);
  // Göç 13'ün bu sütundan önceki hâliyle kurulmuş geliştirme veritabanı için (tablo zaten varsa CREATE atlanır).
  addColumn(db, "design_samples", "shown_at", "TEXT");

  for (const t of NEW_TABLES) {
    db.exec(`
    DROP TRIGGER IF EXISTS ${t}_org_required;
    DROP TRIGGER IF EXISTS ${t}_org_immutable;
    CREATE TRIGGER ${t}_org_required BEFORE INSERT ON ${t}
      WHEN NEW.org_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'org_id boş (${t})'); END;
    CREATE TRIGGER ${t}_org_immutable BEFORE UPDATE OF org_id ON ${t}
      WHEN NEW.org_id IS NOT OLD.org_id
      BEGIN SELECT RAISE(ABORT, 'org_id değiştirilemez (${t})'); END;
    `);
  }
}
