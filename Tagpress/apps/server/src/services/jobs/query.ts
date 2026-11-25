import { JOB_STATUSES, type JobListQuery, JobListQuerySchema, type JobSummary } from "@tagpress/domain";
import { placeholders } from "../../db/database.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import { JOB_SELECT, type JobRow, type VariantRow, jobSummary, visibleStatus } from "./mapping.ts";

const collator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });
const STATUS_ORDER = new Map<string, number>(JOB_STATUSES.map((s, i) => [s, i]));

type Arg = string | number | null;
const all = (db: TenantDb, sql: string, args: Arg[]): unknown[] => db.prepare(sql).all(...args);

/**
 * İş listesi (geçerli firma): filtreler SQL'de, sıralama bellekte (sipariş no sayısal karşılaştırılır).
 * Her zaman iki sorgu: işler + o işlerin varyasyonları (N+1 yok).
 */
export function listJobs(db: TenantDb, input: JobListQuery): JobSummary[] {
  const q = JobListQuerySchema.parse(input);
  const where = ["j.org_id = $org", "j.deleted_at IS NULL", "b.deleted_at IS NULL"];
  const args: string[] = [];
  if (q.languageId) {
    where.push("b.language_id = ?");
    args.push(q.languageId);
  }
  if (q.batchId) {
    where.push("j.batch_id = ?");
    args.push(q.batchId);
  }
  if (q.status) {
    const list = q.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      where.push(`COALESCE(j.gen_state, j.status) IN (${placeholders(list.length)})`);
      args.push(...list);
    }
  }
  if (q.issues === "yes") where.push("j.issue_level IS NOT NULL");
  if (q.issues === "no") where.push("j.issue_level IS NULL");
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(j.text LIKE ? ESCAPE '\\' OR j.order_no LIKE ? ESCAPE '\\' OR j.template_key LIKE ? ESCAPE '\\' OR j.product LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const rows = all(db, `${JOB_SELECT} WHERE ${where.join(" AND ")}`, args) as JobRow[];
  const variants = variantsFor(db, rows.map((r) => r.id));
  const sign = q.dir === "asc" ? 1 : -1;
  const byCreated = (a: JobRow, b: JobRow) => a.created_at.localeCompare(b.created_at) || a.seq - b.seq;
  const cmp: Record<typeof q.sort, (a: JobRow, b: JobRow) => number> = {
    created: byCreated,
    // Sipariş no'su olmayanlar her iki yönde de sonda.
    order: (a, b) => (a.order_no === null ? (b.order_no === null ? 0 : sign) : b.order_no === null ? -sign : collator.compare(a.order_no, b.order_no)),
    status: (a, b) => (STATUS_ORDER.get(visibleStatus(a)) ?? 99) - (STATUS_ORDER.get(visibleStatus(b)) ?? 99),
    template: (a, b) => collator.compare(a.template_key ?? "￿", b.template_key ?? "￿"),
  };
  rows.sort((a, b) => sign * cmp[q.sort](a, b) || -byCreated(a, b));
  return rows.map((r) => jobSummary(r, variants.get(r.id) ?? []));
}

/** Verilen işlerin silinmemiş varyasyonları (iş başına V sırasıyla). */
export function variantsFor(db: TenantDb, jobIds: string[]): Map<string, VariantRow[]> {
  const out = new Map<string, VariantRow[]>();
  for (let i = 0; i < jobIds.length; i += 500) {
    const chunk = jobIds.slice(i, i + 500);
    if (!chunk.length) break;
    const rows = all(db, `SELECT * FROM variants WHERE org_id = $org AND deleted_at IS NULL AND job_id IN (${placeholders(chunk.length)}) ORDER BY job_id, no`, chunk) as VariantRow[];
    for (const v of rows) {
      const list = out.get(v.job_id) ?? [];
      list.push(v);
      out.set(v.job_id, list);
    }
  }
  return out;
}
