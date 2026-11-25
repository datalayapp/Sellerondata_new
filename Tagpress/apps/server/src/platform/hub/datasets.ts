import type { HubColumn, HubDatasetDef, HubDatasetList, HubDatasetPage, HubRow } from "@sellerondata/contracts";
import type { HubExport } from "@sellerondata/product-kit";
import { queryInt } from "@sellerondata/product-kit";
import { validDay } from "@sellerondata/product-kit/pure";
import type { HubKey } from "../../i18n/hub.ts";
import { type Ctx, PRODUCT, asList, languageFilter, languageFilterDef, languageName, select, tagpress, text, validation } from "./common.ts";
import { HubFacts, LIVE_JOBS, LIVE_JOBS_WHERE, type HubSqlDb, type LanguageRow, type SqlValue, likePattern, num, str } from "./sql.ts";
import { zonedIsoRange } from "./time.ts";

/**
 * Veri setleri (plan §S7): `jobs` (iş), `prints` (baskı oturumu), `templates` (şablon). Müşteri metni (etiket yazısı, ham
 * satır, sipariş notu, isim) hiçbir sütunda ve aramada yok [V]: arama yalnız sipariş numarası ve ürün adında. `jobs` ve
 * `prints` dışa aktarılır (CSV, product-kit). Her satırda araçtaki kayda derin bağlantı.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
const EXPORT_BATCH = 2_000;

const JOB_STATUSES = ["new", "queued", "generating", "ready", "failed", "approved"] as const;
const JOB_KINDS = ["label", "sticker"] as const;
const PRINT_STATUSES = ["draft", "printed"] as const;

type Query = Record<string, unknown>;
type DatasetQuery = { page: number; pageSize: number; q: string | null; sort: string | null; dir: "asc" | "desc"; filters: Record<string, string[]> };

function parse(ctx: Ctx, query: Query): DatasetQuery {
  const filters = Object.create(null) as Record<string, string[]>;
  for (const [k, v] of Object.entries(query)) if (k.startsWith("filter.")) filters[k.slice(7)] = asList(v);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  return {
    page: queryInt(query.page, 1, "page", ctx.locale),
    pageSize: Math.min(MAX_PAGE_SIZE, queryInt(query.pageSize, DEFAULT_PAGE_SIZE, "pageSize", ctx.locale)),
    q: q ? q.slice(0, 200) : null,
    sort: typeof query.sort === "string" && query.sort ? query.sort : null,
    dir: query.dir === "asc" ? "asc" : "desc",
    filters,
  };
}

function oneOf<T extends string>(ctx: Ctx, q: DatasetQuery, name: string, allowed: readonly T[]): T[] {
  const vals = q.filters[name] ?? [];
  for (const v of vals) if (!allowed.includes(v as T)) throw validation(ctx, name);
  return vals as T[];
}

/** `filter.from` / `filter.to`: firmanın günü. Biçim dışı gün 400. */
function dayRange(ctx: Ctx, q: DatasetQuery): { gte: string | null; lt: string | null } {
  const from = q.filters.from?.[0] ?? null;
  const to = q.filters.to?.[0] ?? null;
  if (from && !validDay(from)) throw validation(ctx, "from");
  if (to && !validDay(to)) throw validation(ctx, "to");
  return { gte: from ? zonedIsoRange(from, from, ctx.timeZone).gte : null, lt: to ? zonedIsoRange(to, to, ctx.timeZone).lt : null };
}

/** Yalnız tablonun kendi anahtarı: `?sort=constructor` prototipe düşmez. */
const pick = <T>(table: Record<string, T>, key: string | null): T | undefined => (key && Object.hasOwn(table, key) ? table[key] : undefined);

type Where = { sql: string[]; params: SqlValue[] };
const add = (w: Where, sql: string, ...params: SqlValue[]) => {
  w.sql.push(sql);
  w.params.push(...params);
};
const inList = (w: Where, column: string, values: readonly string[]) => {
  if (values.length) add(w, `${column} IN (${values.map(() => "?").join(", ")})`, ...values);
};

type Slice = { offset: number; limit: number };
type Fetched = { rows: HubRow[]; total: number };

type Spec = {
  def: (ctx: Ctx, languages: LanguageRow[]) => HubDatasetDef;
  columns: (ctx: Ctx) => HubColumn[];
  fetch: (db: HubSqlDb, ctx: Ctx, languages: LanguageRow[], q: DatasetQuery, slice: Slice, countTotal: boolean) => Fetched;
  exportable: boolean;
};

const col = (ctx: Ctx, id: string, label: HubKey, format: HubColumn["format"], extra: Partial<HubColumn> = {}): HubColumn => ({ id, label: ctx.t(label), format, ...extra });

// ---------- işler ----------

const jobSort: Record<string, string> = {
  createdAt: "j.created_at",
  orderNo: "j.order_no",
  status: "j.status",
  quantity: "j.quantity",
  approvedAt: "CASE WHEN j.status = 'approved' THEN j.updated_at END",
};

const jobs: Spec = {
  exportable: true,
  def: (ctx, languages) => ({
    id: "jobs",
    label: ctx.t("dataset.jobs"),
    description: ctx.t("dataset.jobs.description"),
    filters: [
      languageFilterDef(ctx, languages),
      select(ctx, "status", "filter.status", JOB_STATUSES.map((s) => ({ value: s, label: ctx.t(`jobStatus.${s}`) })), true),
      select(ctx, "kind", "filter.kind", JOB_KINDS.map((k) => ({ value: k, label: ctx.t(`jobKind.${k}`) }))),
      text(ctx, "from", "filter.from"),
      text(ctx, "to", "filter.to"),
    ],
    exportable: true,
  }),
  columns: (ctx) => [
    col(ctx, "orderNo", "col.orderNo", "text", { sortable: true }),
    col(ctx, "product", "col.product", "text"),
    col(ctx, "language", "col.language", "text"),
    col(ctx, "kind", "col.kind", "text", { hiddenByDefault: true }),
    col(ctx, "status", "col.status", "text", { sortable: true }),
    col(ctx, "quantity", "col.quantity", "number", { sortable: true, align: "right" }),
    col(ctx, "createdAt", "col.createdAt", "datetime", { sortable: true }),
    col(ctx, "approvedAt", "col.approvedAt", "datetime", { sortable: true }),
  ],
  fetch(db, ctx, languages, q, slice, countTotal) {
    const w: Where = { sql: [LIVE_JOBS_WHERE], params: [] };
    const language = languageFilter(ctx, languages, { "filter.language": q.filters.language });
    if (language) add(w, "b.language_id = ?", language);
    inList(w, "j.status", oneOf(ctx, q, "status", JOB_STATUSES));
    inList(w, "j.kind", oneOf(ctx, q, "kind", JOB_KINDS));
    const days = dayRange(ctx, q);
    if (days.gte) add(w, "j.created_at >= ?", days.gte);
    if (days.lt) add(w, "j.created_at < ?", days.lt);
    if (q.q) add(w, "(j.order_no LIKE ? ESCAPE '\\' OR j.product LIKE ? ESCAPE '\\')", likePattern(q.q), likePattern(q.q));
    const where = w.sql.join(" AND ");
    const total = countTotal ? num(db.prepare(`SELECT COUNT(*) AS n FROM ${LIVE_JOBS} WHERE ${where}`).get(...w.params)?.n) : 0;
    const order = pick(jobSort, q.sort) ?? jobSort.createdAt!;
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT j.id, j.order_no, j.product, j.kind, j.status, j.quantity, j.created_at, j.updated_at, b.language_id FROM ${LIVE_JOBS}
         WHERE ${where} ORDER BY ${order} ${dir} NULLS LAST, j.created_at ${dir}, j.id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...w.params, slice.limit, slice.offset);
    return {
      total,
      rows: rows.map((r) => {
        const status = String(r.status);
        const kind = String(r.kind);
        return {
          id: String(r.id),
          href: tagpress.job(String(r.id)),
          cells: {
            orderNo: str(r.order_no),
            product: str(r.product),
            language: languageName(ctx, languages, str(r.language_id)),
            kind: (JOB_KINDS as readonly string[]).includes(kind) ? ctx.t(`jobKind.${kind}` as HubKey) : kind,
            status: (JOB_STATUSES as readonly string[]).includes(status) ? ctx.t(`jobStatus.${status}` as HubKey) : status,
            quantity: r.quantity === null || r.quantity === undefined ? null : num(r.quantity),
            createdAt: str(r.created_at),
            approvedAt: status === "approved" ? str(r.updated_at) : null,
          },
        };
      }),
    };
  },
};

// ---------- baskı oturumları ----------

const printSort: Record<string, string> = {
  updatedAt: "s.updated_at",
  printedAt: "s.printed_at",
  name: "s.name",
  status: "s.status",
};

const PAGES = "(SELECT COUNT(*) FROM print_pages p WHERE p.org_id = $org AND p.session_id = s.id AND p.deleted_at IS NULL)";
const SHEETS = "(SELECT COALESCE(SUM(p.copies), 0) FROM print_pages p WHERE p.org_id = $org AND p.session_id = s.id AND p.deleted_at IS NULL)";

const prints: Spec = {
  exportable: true,
  def: (ctx, languages) => ({
    id: "prints",
    label: ctx.t("dataset.prints"),
    description: ctx.t("dataset.prints.description"),
    filters: [
      languageFilterDef(ctx, languages),
      select(ctx, "status", "filter.status", PRINT_STATUSES.map((s) => ({ value: s, label: ctx.t(`printStatus.${s}`) }))),
      text(ctx, "from", "filter.from"),
      text(ctx, "to", "filter.to"),
    ],
    exportable: true,
  }),
  columns: (ctx) => [
    col(ctx, "name", "col.name", "text", { sortable: true }),
    col(ctx, "language", "col.language", "text"),
    col(ctx, "status", "col.status", "text", { sortable: true }),
    col(ctx, "pages", "col.pages", "number", { align: "right" }),
    col(ctx, "sheets", "col.sheets", "number", { align: "right" }),
    col(ctx, "jobs", "col.jobs", "number", { align: "right", hiddenByDefault: true }),
    col(ctx, "updatedAt", "col.updatedAt", "datetime", { sortable: true }),
    col(ctx, "printedAt", "col.printedAt", "datetime", { sortable: true }),
  ],
  fetch(db, ctx, languages, q, slice, countTotal) {
    const w: Where = { sql: ["s.org_id = $org", "s.deleted_at IS NULL"], params: [] };
    const language = languageFilter(ctx, languages, { "filter.language": q.filters.language });
    if (language) add(w, "s.language_id = ?", language);
    const status = oneOf(ctx, q, "status", PRINT_STATUSES);
    inList(w, "s.status", status);
    // Gün süzgeci basılan oturumda basılma, taslakta oluşturma günü (Analiz'deki "basılan" sayısıyla aynı).
    const days = dayRange(ctx, q);
    if (days.gte) add(w, "COALESCE(s.printed_at, s.created_at) >= ?", days.gte);
    if (days.lt) add(w, "COALESCE(s.printed_at, s.created_at) < ?", days.lt);
    if (q.q) add(w, "s.name LIKE ? ESCAPE '\\'", likePattern(q.q));
    const where = w.sql.join(" AND ");
    const total = countTotal ? num(db.prepare(`SELECT COUNT(*) AS n FROM print_sessions s WHERE ${where}`).get(...w.params)?.n) : 0;
    const order = pick(printSort, q.sort) ?? printSort.updatedAt!;
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.language_id, s.status, s.job_ids, s.updated_at, s.printed_at, ${PAGES} AS pages, ${SHEETS} AS sheets FROM print_sessions s
         WHERE ${where} ORDER BY ${order} ${dir} NULLS LAST, s.updated_at ${dir}, s.id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...w.params, slice.limit, slice.offset);
    return {
      total,
      rows: rows.map((r) => {
        const st = String(r.status);
        return {
          id: String(r.id),
          href: tagpress.printSession(String(r.id)),
          cells: {
            name: str(r.name),
            language: languageName(ctx, languages, str(r.language_id)),
            status: (PRINT_STATUSES as readonly string[]).includes(st) ? ctx.t(`printStatus.${st}` as HubKey) : st,
            pages: num(r.pages),
            sheets: num(r.sheets),
            jobs: jsonLength(r.job_ids),
            updatedAt: str(r.updated_at),
            printedAt: str(r.printed_at),
          },
        };
      }),
    };
  },
};

function jsonLength(v: unknown): number {
  try {
    const a = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
}

// ---------- şablonlar ----------

const templateSort: Record<string, string> = { name: "t.key", updatedAt: "t.updated_at" };

const templates: Spec = {
  exportable: false,
  def: (ctx, languages) => ({ id: "templates", label: ctx.t("dataset.templates"), description: ctx.t("dataset.templates.description"), filters: [languageFilterDef(ctx, languages)], exportable: false }),
  columns: (ctx) => [
    col(ctx, "language", "col.language", "text"),
    col(ctx, "name", "col.template", "text", { sortable: true }),
    col(ctx, "kind", "col.kind", "text"),
    col(ctx, "cut", "col.cut", "text"),
    col(ctx, "updatedAt", "col.updatedAt", "datetime", { sortable: true }),
  ],
  fetch(db, ctx, languages, q, slice, countTotal) {
    const w: Where = { sql: ["t.org_id = $org", "l.deleted_at IS NULL"], params: [] };
    const language = languageFilter(ctx, languages, { "filter.language": q.filters.language });
    if (language) add(w, "t.language_id = ?", language);
    if (q.q) add(w, "t.key LIKE ? ESCAPE '\\'", likePattern(q.q));
    const from = "templates t JOIN languages l ON l.id = t.language_id AND l.org_id = $org";
    const where = w.sql.join(" AND ");
    const total = countTotal ? num(db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`).get(...w.params)?.n) : 0;
    const sort = pick(templateSort, q.sort);
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    // Varsayılan sıra: dil eklenme sırası, sonra şablon anahtarı (kütüphanedeki gibi).
    const order = sort ? `${sort} ${dir}, l.created_at, t.key` : "l.created_at, l.id, t.key";
    const rows = db
      .prepare(`SELECT t.key, t.language_id, t.data, t.updated_at FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...w.params, slice.limit, slice.offset);
    return {
      total,
      rows: rows.map((r) => {
        const data = parseTemplate(r.data);
        const key = String(r.key);
        return {
          id: `${String(r.language_id)}:${key}`,
          href: tagpress.template(key),
          cells: {
            language: languageName(ctx, languages, str(r.language_id)),
            name: key,
            kind: ctx.t(`templateKind.${data.kind}` as HubKey),
            cut: cutText(ctx, data.cut),
            updatedAt: str(r.updated_at),
          },
        };
      }),
    };
  },
};

type TemplateBits = { kind: "label" | "sticker" | "generated"; cut: { shape: string; wMm: number; hMm: number } | null };

function parseTemplate(raw: unknown): TemplateBits {
  try {
    const d = JSON.parse(String(raw ?? "{}")) as { kind?: unknown; cut?: { shape?: unknown; wMm?: unknown; hMm?: unknown } | null };
    const kind = d.kind === "sticker" || d.kind === "generated" ? d.kind : "label";
    const c = d.cut;
    const cut =
      c && typeof c.shape === "string" && typeof c.wMm === "number" && typeof c.hMm === "number" ? { shape: c.shape, wMm: c.wMm, hMm: c.shape === "circle" ? c.wMm : c.hMm } : null;
    return { kind, cut };
  } catch {
    return { kind: "label", cut: null };
  }
}

const mm = (n: number) => String(Math.round(n * 10) / 10);

function cutText(ctx: Ctx, cut: TemplateBits["cut"]): string {
  if (!cut) return ctx.t("cut.language");
  const shape = ["circle", "ellipse", "rect", "roundRect"].includes(cut.shape) ? cut.shape : "rect";
  return ctx.t(`cut.${shape}` as HubKey, { w: mm(cut.wMm), h: mm(cut.hMm) });
}

// ---------- uçlar ----------

const SPECS: Record<string, Spec> = { jobs, prints, templates };
const ORDER = ["jobs", "prints", "templates"] as const;

export function listDatasets(db: HubSqlDb, ctx: Ctx): HubDatasetList {
  const languages = new HubFacts(db).languages();
  return { product: PRODUCT, datasets: ORDER.map((id) => SPECS[id]!.def(ctx, languages)) };
}

export function datasetPage(db: HubSqlDb, ctx: Ctx, id: string, query: Query): HubDatasetPage | null {
  const spec = pick(SPECS, id);
  if (!spec) return null;
  const languages = new HubFacts(db).languages();
  const q = parse(ctx, query);
  const { rows, total } = spec.fetch(db, ctx, languages, q, { offset: (q.page - 1) * q.pageSize, limit: q.pageSize }, true);
  return { id, columns: spec.columns(ctx), rows, page: q.page, pageSize: q.pageSize, total };
}

/**
 * CSV: sayfadaki süzgeç, arama ve sırayla bütün satırlar, partiler hâlinde (her parti kendi `run` çağrısında, firma bağlamında).
 * Dışa aktarılamaz ya da bilinmeyen set null.
 */
export async function datasetExport(run: <T>(fn: (db: HubSqlDb) => T) => Promise<T>, ctx: Ctx, id: string, query: Query): Promise<HubExport | null> {
  const spec = pick(SPECS, id);
  if (!spec || !spec.exportable) return null;
  const q = parse(ctx, { ...query, page: undefined, pageSize: undefined });
  // Süzgeç hatası akış başlamadan 400 dönsün (başlık gittikten sonra hata dosyayı yarım bırakırdı): ilk denetim burada.
  const languages = await run((db) => {
    const langs = new HubFacts(db).languages();
    spec.fetch(db, ctx, langs, q, { offset: 0, limit: 1 }, false);
    return langs;
  });
  return {
    columns: spec.columns(ctx),
    async *batches() {
      for (let offset = 0; ; offset += EXPORT_BATCH) {
        const { rows } = await run((db) => spec.fetch(db, ctx, languages, q, { offset, limit: EXPORT_BATCH }, false));
        if (rows.length) yield rows;
        if (rows.length < EXPORT_BATCH) return;
      }
    },
  };
}
