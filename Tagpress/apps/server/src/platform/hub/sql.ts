/**
 * Merkez sağlayıcılarının veritabanı yüzeyi ve ortak sorguları. Sorgular `TenantDb` arayüzüyle yazılır (plan §S5): her kiracı
 * tablosu geçişi `<takma ad>.org_id = $org` ile kapsamlı, `$org`'u veritabanı katmanı geçerli firma bağlamından
 * (`runInOrg`) bağlar. SQL iki lehçede aynı çalışacak biçimde: yalnız metin karşılaştırması (zamanlar ISO metin), `COUNT`,
 * `SUM`, `COALESCE`, `LIKE … ESCAPE`; JSON ve saat dilimi işlevi yok (gün hesabı JS'de, `time.ts`). Mantıksal ifade seçim
 * listesinde yok (SQLite 0/1, Postgres boolean döner).
 */

/** Bağlanan değer. */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

/** `TenantDb` / `TenantDbLike` deyiminin sağlayıcıların kullandığı kısmı. */
export interface HubStatement {
  all(...params: SqlValue[]): SqlRow[];
  get(...params: SqlValue[]): SqlRow | undefined;
}

/** `TenantDb` / `TenantDbLike`'ın sağlayıcıların kullandığı kısmı (yalnız okuma). */
export interface HubSqlDb {
  prepare(sql: string): HubStatement;
}

export const num = (v: unknown): number => {
  const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** `LIKE … ESCAPE '\'` için kaçış (SQLite'ta harf duyarsız; Postgres'te köprü `ILIKE` yapar). */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Görünen (silinmemiş) etiket işleri: `j` = jobs, `b` = batches. */
export const LIVE_JOBS = `jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org`;
export const LIVE_JOBS_WHERE = `j.org_id = $org AND j.deleted_at IS NULL AND b.deleted_at IS NULL`;

/** İş basılmış bir oturumda değil (`j` = jobs; `services/jobs/cut-change.ts` ile aynı tanım). */
export const NOT_PRINTED = `NOT EXISTS (SELECT 1 FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org
  JOIN print_sessions s ON s.id = p.session_id AND s.org_id = $org
  WHERE i.org_id = $org AND i.job_id = j.id AND s.status = 'printed' AND s.deleted_at IS NULL AND p.deleted_at IS NULL)`;

export type Range = { gte: string; lt: string };

export type LanguageRow = { id: string; name: string; deleted: boolean; published: boolean };

/**
 * Sayılar (tek firma, geçerli bağlam). Onay anı: işin `status = 'approved'` iken son güncellenmesi (`jobs.updated_at`; ayrı
 * onay anı sütunu yok, onaydan sonraki düzenleme anı kaydırır).
 */
export class HubFacts {
  constructor(private readonly db: HubSqlDb) {}

  private count(sql: string, ...params: SqlValue[]): number {
    return num(this.db.prepare(sql).get(...params)?.n);
  }

  private langClause(language: string | null, column: string): { sql: string; params: SqlValue[] } {
    return language ? { sql: ` AND ${column} = ?`, params: [language] } : { sql: "", params: [] };
  }

  languages(): LanguageRow[] {
    return this.db
      .prepare(
        `SELECT l.id, l.name, l.deleted_at,
           (SELECT COUNT(*) FROM profile_versions p WHERE p.org_id = $org AND p.language_id = l.id AND p.status = 'published') AS published
         FROM languages l WHERE l.org_id = $org ORDER BY l.created_at, l.id`,
      )
      .all()
      .map((r) => ({ id: String(r.id), name: String(r.name), deleted: r.deleted_at !== null && r.deleted_at !== undefined, published: num(r.published) > 0 }));
  }

  /** Dönemde onaylanan işlerin onay anı ve dili. */
  approved(range: Range, language: string | null = null): { at: string; language: string }[] {
    const l = this.langClause(language, "b.language_id");
    return this.db
      .prepare(
        `SELECT j.updated_at AS at, b.language_id AS language FROM ${LIVE_JOBS}
         WHERE ${LIVE_JOBS_WHERE} AND j.status = 'approved' AND j.updated_at >= ? AND j.updated_at < ?${l.sql}`,
      )
      .all(range.gte, range.lt, ...l.params)
      .map((r) => ({ at: String(r.at), language: String(r.language) }));
  }

  /** Dönemde eklenen işlerin ekleme anı ve bugünkü durumu. */
  created(range: Range, language: string | null = null): { at: string; status: string }[] {
    const l = this.langClause(language, "b.language_id");
    return this.db
      .prepare(`SELECT j.created_at AS at, j.status FROM ${LIVE_JOBS} WHERE ${LIVE_JOBS_WHERE} AND j.created_at >= ? AND j.created_at < ?${l.sql}`)
      .all(range.gte, range.lt, ...l.params)
      .map((r) => ({ at: String(r.at), status: String(r.status) }));
  }

  /** Dönemde basıldı işaretlenen oturumlar: an ve sayfa (kopyalar dahil, silinmiş sayfa hariç). */
  printed(range: Range, language: string | null = null): { at: string; sheets: number }[] {
    const l = this.langClause(language, "s.language_id");
    return this.db
      .prepare(
        `SELECT s.printed_at AS at,
           (SELECT COALESCE(SUM(p.copies), 0) FROM print_pages p WHERE p.org_id = $org AND p.session_id = s.id AND p.deleted_at IS NULL) AS sheets
         FROM print_sessions s
         WHERE s.org_id = $org AND s.status = 'printed' AND s.deleted_at IS NULL AND s.printed_at >= ? AND s.printed_at < ?${l.sql}`,
      )
      .all(range.gte, range.lt, ...l.params)
      .map((r) => ({ at: String(r.at), sheets: num(r.sheets) }));
  }

  /** Dönemdeki yapay zekâ çağrıları: an, amaç, hatalı mı. */
  aiCalls(range: Range, language: string | null = null): { at: string; purpose: string; failed: boolean }[] {
    const l = this.langClause(language, "a.language_id");
    return this.db
      .prepare(`SELECT a.created_at AS at, a.purpose, a.error FROM ai_calls a WHERE a.org_id = $org AND a.created_at >= ? AND a.created_at < ?${l.sql}`)
      .all(range.gte, range.lt, ...l.params)
      .map((r) => ({ at: String(r.at), purpose: String(r.purpose), failed: r.error !== null && r.error !== undefined && r.error !== "" }));
  }

  /** Şu an: tasarımı hazır, onay bekleyen işler. */
  pending(): number {
    return this.count(`SELECT COUNT(*) AS n FROM ${LIVE_JOBS} WHERE ${LIVE_JOBS_WHERE} AND j.status = 'ready'`);
  }

  /** Şu an: üretilen ya da sırada bekleyen iş (görev değil iş sayısı). */
  queue(): number {
    return this.count("SELECT COUNT(DISTINCT t.job_id) AS n FROM gen_tasks t WHERE t.org_id = $org AND t.status IN ('queued', 'running')");
  }

  failedJobs(): number {
    return this.count(`SELECT COUNT(*) AS n FROM ${LIVE_JOBS} WHERE ${LIVE_JOBS_WHERE} AND j.status = 'failed'`);
  }

  /** Kesim değişince onayı düşmüş, henüz yeniden onaylanmamış ve basılmamış işler (`template-cut-changed` uyarısı). */
  droppedApprovals(): number {
    return this.count(
      `SELECT COUNT(*) AS n FROM ${LIVE_JOBS} WHERE ${LIVE_JOBS_WHERE} AND j.status = 'ready' AND j.run_issues LIKE '%"template-cut-changed"%' AND ${NOT_PRINTED}`,
    );
  }

  /** `before` anından önce başlamış, hâlâ süren üretim görevleri ve baskı çıktıları. */
  stuckTasks(before: string): number {
    return (
      this.count("SELECT COUNT(*) AS n FROM gen_tasks t WHERE t.org_id = $org AND t.status = 'running' AND t.started_at < ?", before) +
      this.count("SELECT COUNT(*) AS n FROM print_exports e WHERE e.org_id = $org AND e.status = 'running' AND e.created_at < ?", before)
    );
  }

  anyJob(): boolean {
    return !!this.db.prepare("SELECT j.id FROM jobs j WHERE j.org_id = $org LIMIT 1").get();
  }

  anyPrinted(): boolean {
    return !!this.db.prepare("SELECT s.id FROM print_sessions s WHERE s.org_id = $org AND s.status = 'printed' LIMIT 1").get();
  }

  /** Kurulum kaydı (`org_settings.setup`, `SetupService`); yoksa ya da bozuksa null. */
  setup(): { status: string; completedAt: string | null } | null {
    const raw = str(this.db.prepare("SELECT s.value FROM org_settings s WHERE s.org_id = $org AND s.key = 'setup'").get()?.value);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { status?: unknown; completedAt?: unknown };
      return { status: typeof v.status === "string" ? v.status : "pending", completedAt: typeof v.completedAt === "string" ? v.completedAt : null };
    } catch {
      return null;
    }
  }
}
