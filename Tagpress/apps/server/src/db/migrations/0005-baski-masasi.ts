// 5: baskı masası (Figma'sız baskı sayfaları). Şablon tasarım dili kapsamında, düz veri (`data` = PrintTemplate).
// Oturum/sayfa yumuşak silinir (geri alınabilir); öğe bir varyasyona referanstır. Çıktı görevleri kalıcıdır.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  CREATE TABLE print_templates (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX print_templates_language ON print_templates(language_id, archived, name);

  CREATE TABLE print_sessions (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'printed')),
    version INTEGER NOT NULL DEFAULT 0,
    template_id TEXT,
    job_ids TEXT NOT NULL DEFAULT '[]',
    source_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    printed_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX print_sessions_language ON print_sessions(language_id, status, updated_at);

  CREATE TABLE print_pages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES print_sessions(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    copies INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'manual',
    show_cell_labels INTEGER NOT NULL DEFAULT 1,
    locked INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  );
  CREATE INDEX print_pages_session ON print_pages(session_id, idx);

  CREATE TABLE print_items (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES print_pages(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    slot_id TEXT,
    x_mm REAL NOT NULL,
    y_mm REAL NOT NULL,
    rotation REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1,
    extra INTEGER NOT NULL DEFAULT 0,
    manual INTEGER NOT NULL DEFAULT 0,
    z INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX print_items_page ON print_items(page_id);
  CREATE INDEX print_items_job ON print_items(job_id);

  CREATE TABLE print_exports (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    format TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    files TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX print_exports_session ON print_exports(session_id, created_at);
  `;
