// 1: başlangıç şeması.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE languages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE profile_versions (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
    data TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    published_at TEXT,
    UNIQUE (language_id, version)
  );

  CREATE TABLE templates (
    language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    file_missing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (language_id, key)
  );

  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_file TEXT,
    mapping TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX batches_lang ON batches(language_id, created_at);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    raw TEXT NOT NULL,
    order_no TEXT,
    quantity INTEGER,
    template_key TEXT,
    label_size TEXT,
    product TEXT,
    text_raw TEXT NOT NULL,
    text TEXT NOT NULL,
    segments TEXT NOT NULL DEFAULT '[]',
    ai_note TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'label',
    status TEXT NOT NULL,
    gen_state TEXT,
    error TEXT,
    approved_variant_id TEXT,
    issues TEXT NOT NULL DEFAULT '[]',
    run_issues TEXT NOT NULL DEFAULT '[]',
    dismissed TEXT NOT NULL DEFAULT '[]',
    issue_level TEXT,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX jobs_batch ON jobs(batch_id, seq);
  CREATE INDEX jobs_dedupe ON jobs(dedupe_key);
  CREATE INDEX jobs_created ON jobs(created_at);

  CREATE TABLE variants (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    no INTEGER NOT NULL,
    kind TEXT NOT NULL,
    intent TEXT,
    layout TEXT,
    snapshot TEXT NOT NULL,
    preview_file TEXT NOT NULL,
    image TEXT,
    score REAL,
    ai_rank INTEGER,
    suspect INTEGER NOT NULL DEFAULT 0,
    issues TEXT NOT NULL DEFAULT '[]',
    rationale TEXT NOT NULL DEFAULT '',
    figma TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (job_id, no)
  );
  CREATE INDEX variants_job ON variants(job_id);

  CREATE TABLE gen_tasks (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX gen_tasks_status ON gen_tasks(status, created_at);

  CREATE TABLE job_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    task_id TEXT,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX job_log_job ON job_log(job_id, id);

  -- Figma eklentisi kaldırıldı (2026-10-10): figma_queue, figma_calibration ve variants.figma eski veri için
  -- duruyor; kod artık okumuyor/yazmıyor. Göçler yalnızca ekler, tablo/sütun silinmez.
  CREATE TABLE figma_queue (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    node_id TEXT,
    replaces_node_id TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    decision TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX figma_queue_status ON figma_queue(status, created_at);
  CREATE INDEX figma_queue_job ON figma_queue(job_id);

  CREATE TABLE figma_calibration (
    font_id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    style TEXT NOT NULL,
    samples TEXT NOT NULL DEFAULT '[]',
    figma_asc REAL,
    probe TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE ai_calls (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    task_id TEXT,
    variant_id TEXT,
    language_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    response BLOB,
    error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ai_calls_job ON ai_calls(job_id);
  CREATE INDEX ai_calls_created ON ai_calls(created_at);

  CREATE TABLE refs (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    data TEXT NOT NULL,
    split TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX refs_lang ON refs(language_id, created_at);

  CREATE TABLE learn_proposals (
    id TEXT PRIMARY KEY,
    language_id TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    patch TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE undo (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `;
