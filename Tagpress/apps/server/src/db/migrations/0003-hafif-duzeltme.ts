// 3: hafif düzeltme. Varyasyonun `layout`'u motor çıktısı olarak kalır; düzeltme ayrı sütunda.
// base_*: ilk düzeltmeden önceki sorunlar/önizleme (kaldırınca geri gelir). adjust_log: öğrenme için kayıt.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  ALTER TABLE variants ADD COLUMN adjust TEXT;
  ALTER TABLE variants ADD COLUMN adjust_rev INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE variants ADD COLUMN base_issues TEXT;
  ALTER TABLE variants ADD COLUMN base_preview_file TEXT;

  CREATE TABLE adjust_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language_id TEXT NOT NULL,
    template_key TEXT,
    job_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    profile_version INTEGER,
    frame_px REAL NOT NULL,
    adjust TEXT NOT NULL,
    target_x REAL NOT NULL,
    target_y REAL NOT NULL,
    target_source TEXT NOT NULL,
    ink_before TEXT NOT NULL,
    ink_after TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (variant_id, rev)
  );
  CREATE INDEX adjust_log_template ON adjust_log(language_id, template_key);
  `;
