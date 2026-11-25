// 4: arka plan görevlerinin kalıcılığı. Temadan şablon görevleri ve öğrenme koşuları yeniden başlatmada
// kaybolmaz; yarım kalanlar açılışta "interrupted" (kesildi) olur.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  CREATE TABLE template_tasks (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    status TEXT NOT NULL,
    theme TEXT NOT NULL,
    template_key TEXT,
    error TEXT,
    cost_usd REAL,
    sample_png TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX template_tasks_language ON template_tasks(language_id, created_at);

  CREATE TABLE learn_runs (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    status TEXT NOT NULL,
    base TEXT NOT NULL,
    profile_version INTEGER NOT NULL,
    step TEXT NOT NULL,
    done REAL NOT NULL,
    total REAL NOT NULL,
    message TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    result TEXT
  );
  CREATE INDEX learn_runs_language ON learn_runs(language_id, started_at);
  `;
