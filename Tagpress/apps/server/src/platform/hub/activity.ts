import { HUB_ACTIVITY_PAGE_SIZE, type HubActivityItem, type HubActivityPage } from "@sellerondata/contracts";
import { queryInt } from "@sellerondata/product-kit";
import { type Ctx, tagpress } from "./common.ts";
import { HubFacts, type HubSqlDb, num, str } from "./sql.ts";

/** Sayfa boyu üst sınırı ve en derin sayfa (her kaynaktan `page × pageSize` satır okunur). */
export const MAX_ACTIVITY_PAGE_SIZE = 100;
const MAX_ACTIVITY_ROWS = 5_000;

/**
 * Etkinlik akışı (plan §S7): beyaz listedeki olaylar; serbest metin (üretim günlüğünün iletisi, revizyon isteği, müşteri metni)
 * akışa girmez, eylem adı sözlükten. Kaynaklar: üretim günlüğü (`job_log`: yalnız `done`, `error`), baskı çıktıları
 * (`print_exports` biten), dil yayını (`profile_versions`), oluşturucu oturumunun bitişi (`design_sessions` site kipi),
 * kurulumun tamamlanması (`org_settings.setup`). `actor` üyenin adı (`member_id` varsa, ad Merkez'in izdüşümünden; yerel
 * kipte ve eski satırda null).
 */
export type RawActivity = { id: string; at: string; memberId: string | null; action: string; target?: string; href?: string };

export function activityRows(db: HubSqlDb, ctx: Ctx, query: Record<string, unknown>): { page: number; pageSize: number; total: number; items: RawActivity[] } {
  const { t } = ctx;
  const page = queryInt(query.page, 1, "page", ctx.locale);
  const pageSize = Math.min(MAX_ACTIVITY_PAGE_SIZE, queryInt(query.pageSize, HUB_ACTIVITY_PAGE_SIZE, "pageSize", ctx.locale));
  const take = Math.min(page * pageSize, MAX_ACTIVITY_ROWS);
  const count = (sql: string) => num(db.prepare(sql).get()?.n);
  const items: RawActivity[] = [];

  const JOB_LOG = "FROM job_log l WHERE l.org_id = $org AND l.step IN ('done', 'error')";
  let total = count(`SELECT COUNT(*) AS n ${JOB_LOG}`);
  for (const r of db
    .prepare(
      `SELECT l.id, l.job_id, l.step, l.at, l.member_id, j.order_no, j.seq FROM job_log l
       LEFT JOIN jobs j ON j.id = l.job_id AND j.org_id = $org
       WHERE l.org_id = $org AND l.step IN ('done', 'error') ORDER BY l.at DESC, l.id DESC LIMIT ?`,
    )
    .all(take)) {
    const ref = str(r.order_no) ?? (r.seq === null || r.seq === undefined ? "" : `#${num(r.seq)}`);
    items.push({
      id: `job-log:${String(r.id)}`,
      at: String(r.at),
      memberId: str(r.member_id),
      action: t(r.step === "done" ? "activity.jobDone" : "activity.jobError"),
      ...(ref ? { target: t("activity.job", { ref }) } : {}),
      href: tagpress.job(String(r.job_id)),
    });
  }

  const EXPORTS = "FROM print_exports e WHERE e.org_id = $org AND e.status IN ('done', 'failed') AND e.finished_at IS NOT NULL";
  total += count(`SELECT COUNT(*) AS n ${EXPORTS}`);
  for (const r of db
    .prepare(
      `SELECT e.id, e.session_id, e.format, e.status, e.finished_at, e.member_id, s.name FROM print_exports e
       LEFT JOIN print_sessions s ON s.id = e.session_id AND s.org_id = $org
       WHERE e.org_id = $org AND e.status IN ('done', 'failed') AND e.finished_at IS NOT NULL ORDER BY e.finished_at DESC, e.id DESC LIMIT ?`,
    )
    .all(take)) {
    const format = String(r.format).toUpperCase();
    items.push({
      id: `export:${String(r.id)}`,
      at: String(r.finished_at),
      memberId: str(r.member_id),
      action: t(r.status === "done" ? "activity.exportDone" : "activity.exportFailed", { format }),
      ...(str(r.name) ? { target: String(r.name) } : {}),
      href: tagpress.printSession(String(r.session_id)),
    });
  }

  const PUBLISHED = "FROM profile_versions p WHERE p.org_id = $org AND p.status = 'published' AND p.published_at IS NOT NULL";
  total += count(`SELECT COUNT(*) AS n ${PUBLISHED}`);
  for (const r of db
    .prepare(
      `SELECT p.id, p.version, p.published_at, l.name FROM profile_versions p
       LEFT JOIN languages l ON l.id = p.language_id AND l.org_id = $org
       WHERE p.org_id = $org AND p.status = 'published' AND p.published_at IS NOT NULL ORDER BY p.published_at DESC, p.id DESC LIMIT ?`,
    )
    .all(take)) {
    items.push({
      id: `publish:${String(r.id)}`,
      at: String(r.published_at),
      memberId: null,
      action: t("activity.languagePublished", { version: num(r.version) }),
      ...(str(r.name) ? { target: String(r.name) } : {}),
      href: tagpress.languages,
    });
  }

  const SESSIONS = "FROM design_sessions d WHERE d.org_id = $org AND d.mode = 'site' AND d.state IN ('published', 'closed')";
  total += count(`SELECT COUNT(*) AS n ${SESSIONS}`);
  for (const r of db
    .prepare(
      `SELECT d.id, d.state, d.updated_at, d.member_id, l.name FROM design_sessions d
       LEFT JOIN languages l ON l.id = d.language_id AND l.org_id = $org
       WHERE d.org_id = $org AND d.mode = 'site' AND d.state IN ('published', 'closed') ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
    )
    .all(take)) {
    items.push({
      id: `design:${String(r.id)}`,
      at: String(r.updated_at),
      memberId: str(r.member_id),
      action: t(r.state === "published" ? "activity.sessionPublished" : "activity.sessionClosed"),
      ...(str(r.name) ? { target: String(r.name) } : {}),
      href: tagpress.languages,
    });
  }

  const setup = new HubFacts(db).setup();
  if (setup?.status === "completed" && setup.completedAt) {
    total += 1;
    items.push({ id: "setup:completed", at: setup.completedAt, memberId: null, action: t("activity.setupCompleted") });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { page, pageSize, total, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

/** Kişi adları çözülmüş sayfa. */
export function activityPage(raw: ReturnType<typeof activityRows>, names: ReadonlyMap<string, string>): HubActivityPage {
  const items: HubActivityItem[] = raw.items.map(({ memberId, ...rest }) => ({ ...rest, actor: memberId ? (names.get(memberId) ?? null) : null }));
  return { items, page: raw.page, pageSize: raw.pageSize, total: raw.total };
}
