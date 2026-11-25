// 2: tasarım dili oturumu (Claude Code becerisi + MCP): sorular, cevaplar, taslak yazımları, denemeler.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  CREATE TABLE design_sessions (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX design_sessions_lang ON design_sessions(language_id, started_at);

  CREATE TABLE design_session_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    grp TEXT,
    text TEXT NOT NULL,
    paths TEXT
  );
  CREATE INDEX design_session_entries_session ON design_session_entries(session_id, id);
  `;
