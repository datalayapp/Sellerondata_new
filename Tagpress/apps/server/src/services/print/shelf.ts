import { API, type JobStatus, type JobKind, type PrintTemplate, type Profile, type ShelfItem, type TemplateCut, TemplateCutSchema, apiPath, cutSizeId, slotFitsCut } from "@tagpress/domain";
import { json, placeholders } from "../../db/database.ts";
import { type TenantDb, dialectSql } from "../../org/tenant-db.ts";
import { stickerSheetId } from "../import/rows.ts";
import type { ProfileService } from "../profiles.ts";
import type { PrintPlanner } from "./ports.ts";
import type { PrintSessionService } from "./sessions.ts";

/** Rafa giren iş durumu. */
export const SHELF_STATUSES: readonly string[] = ["approved"];

/** Baskıya aday iş (onaylı varyasyonuyla). */
export interface PrintJob {
  id: string;
  seq: number;
  /** Planlama sırası anahtarı (iş oluşturulma zamanı); plan sıraya bağlıdır (fazlalık açık yuvaya göre kırpılır). */
  createdAt: string;
  languageId: string;
  orderNo: string | null;
  /** Adet; yoksa 0 (`quantityMissing`): adedi olmayan sipariş planlanmaz (kullanıcı kararı 2026-10-10). */
  quantity: number;
  quantityMissing: boolean;
  templateKey: string | null;
  labelSize: string | null;
  kind: JobKind;
  status: JobStatus;
  text: string;
  /** Siparişin ürün alanı (raf kartında); yoksa null. */
  product: string | null;
  variantId: string;
  variantNo: number;
  adjustRev: number;
  /** İşin etiket şablonunun kendi kesimi (mm); yoksa null (tasarım dilinin kesimi ve boyut listesi). */
  cut: TemplateCut | null;
}

interface JobRowLite {
  id: string;
  seq: number;
  created_at: string;
  language_id: string;
  order_no: string | null;
  quantity: number | null;
  template_key: string | null;
  label_size: string | null;
  kind: JobKind;
  status: JobStatus;
  text: string;
  product: string | null;
  variant_id: string;
  variant_no: number;
  adjust_rev: number | null;
  template_cut: string | null;
}

/**
 * İşin ETKİN etiket şablonu anahtarı (SQL ifadesi; `j` iş, `v` varyasyon takma adı): varyasyon başka şablonda
 * üretildiyse (temadan şablon üretme; `snapshot.templateKey`) o, yoksa işin şablonu. Baskı çizimi
 * (`render-input.ts` `snap.templateKey ?? job.template_key`), raf, kesim ölçüsü ve kesim değişince onay düşmesi aynı
 * anahtarı kullanır. Bozuk anlık kopya JSON'u işin şablonuna düşer.
 */
export const effectiveTemplateKeySql = (db: Pick<TenantDb, "dialect">, j = "j", v = "v"): string =>
  dialectSql(db, {
    sqlite: `COALESCE(CASE WHEN json_valid(${v}.snapshot) THEN json_extract(${v}.snapshot, '$.templateKey') END, ${j}.template_key)`,
    pg: `COALESCE(CASE WHEN ${v}.snapshot IS JSON OBJECT THEN ${v}.snapshot::jsonb ->> 'templateKey' END, ${j}.template_key)`,
  });

/** Şablon kaydındaki kesim (`data.cut`) JSON metni olarak; yoksa ya da JSON null ise SQL NULL. */
export const templateCutSql = (db: Pick<TenantDb, "dialect">, tp = "tp"): string =>
  dialectSql(db, { sqlite: `json_extract(${tp}.data, '$.cut')`, pg: `NULLIF((${tp}.data::jsonb -> 'cut')::text, 'null')` });

const selectSql = (db: Pick<TenantDb, "dialect">) => `SELECT j.id, j.seq, j.created_at, b.language_id, j.order_no, j.quantity, j.template_key, j.label_size, j.kind, j.status, j.text, j.product,
  v.id AS variant_id, v.no AS variant_no, v.adjust_rev, ${templateCutSql(db)} AS template_cut
  FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org JOIN variants v ON v.id = j.approved_variant_id AND v.org_id = $org
  LEFT JOIN templates tp ON tp.org_id = $org AND tp.language_id = b.language_id AND tp.key = ${effectiveTemplateKeySql(db)} AND j.kind = 'label'
  WHERE j.org_id = $org AND j.deleted_at IS NULL AND b.deleted_at IS NULL AND v.deleted_at IS NULL`;

const toJob = (r: JobRowLite): PrintJob => ({
  id: r.id,
  seq: r.seq,
  createdAt: r.created_at,
  languageId: r.language_id,
  orderNo: r.order_no,
  quantity: r.quantity && r.quantity > 0 ? r.quantity : 0,
  quantityMissing: !(r.quantity && r.quantity > 0),
  templateKey: r.template_key,
  labelSize: r.label_size,
  kind: r.kind,
  status: r.status,
  text: r.text,
  product: r.product?.trim() || null,
  variantId: r.variant_id,
  variantNo: r.variant_no,
  adjustRev: r.adjust_rev ?? 0,
  cut: cutOf(r.template_cut),
});

/** İşlerin (onaylı varyasyonun etkin) etiket şablonu kesimleri (yalnız kesimi olanlar). */
export function jobCuts(db: TenantDb, jobIds: readonly string[]): Map<string, TemplateCut> {
  const out = new Map<string, TemplateCut>();
  if (!jobIds.length) return out;
  const rows = db
    .prepare(
      `SELECT j.id, ${templateCutSql(db)} AS cut FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
       LEFT JOIN variants v ON v.id = j.approved_variant_id AND v.org_id = $org
       JOIN templates tp ON tp.org_id = $org AND tp.language_id = b.language_id AND tp.key = ${effectiveTemplateKeySql(db)}
       WHERE j.org_id = $org AND j.kind = 'label' AND j.id IN (${placeholders(jobIds.length)})`,
    )
    .all(...jobIds) as { id: string; cut: string | null }[];
  for (const r of rows) {
    const c = cutOf(r.cut);
    if (c) out.set(r.id, c);
  }
  return out;
}

/** Saklı kesim (JSON); bozuksa null (tasarım dilinin kesimi geçer). */
function cutOf(raw: string | null): TemplateCut | null {
  if (!raw) return null;
  const parsed = TemplateCutSchema.safeParse(json<unknown>(raw, null));
  return parsed.success ? parsed.data : null;
}

/** Onaylı varyasyonu olan (silinmemiş) işler. */
export function approvedJobs(db: TenantDb, languageId: string, statuses: readonly string[] | null): PrintJob[] {
  const rows = db
    .prepare(`${selectSql(db)} AND b.language_id = ? ${statuses ? `AND j.status IN (${placeholders(statuses.length)})` : ""} ORDER BY j.created_at, j.seq`)
    .all(languageId, ...(statuses ?? [])) as unknown as JobRowLite[];
  return rows.map(toJob);
}

/** Verilen işler (onaylı varyasyonu olanlar; durum fark etmez). */
export function approvedJobsById(db: TenantDb, ids: string[]): Map<string, PrintJob> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`${selectSql(db)} AND j.id IN (${placeholders(ids.length)})`).all(...ids) as unknown as JobRowLite[];
  return new Map(rows.map((r) => [r.id, toJob(r)]));
}

/**
 * İşin baskı boyutu: sticker'da sayfa kimliği; etikette şablonun kendi kesimi varsa onun boyut kimliği ("63.5x38.1",
 * "4"; işin `labelSize`'ı bu şablona uygulanmaz), yoksa boyut kimliği ("3.8"; yoksa profilin varsayılanı).
 */
export function sizeOf(job: Pick<PrintJob, "kind" | "labelSize" | "templateKey"> & { cut?: TemplateCut | null }, profile: Profile): string | null {
  if (job.kind === "sticker") return stickerSheetId(job.templateKey);
  if (job.cut) return cutSizeId(job.cut);
  return job.labelSize ?? profile.output.defaultSize ?? null;
}

/** Tasarım numarası: etikette şablon anahtarı; sticker'da yok. */
export const designKeyOf = (job: Pick<PrintJob, "kind" | "templateKey">): string | null => (job.kind === "label" ? job.templateKey : null);

export const previewUrlOf = (job: Pick<PrintJob, "variantId" | "variantNo" | "adjustRev">): string =>
  `${apiPath(API.variantPreview, { id: job.variantId })}?v=${job.variantNo}${job.adjustRev ? `.${job.adjustRev}` : ""}`;

/**
 * Planlama sırası: iş oluşturulma sırası (rafın `approvedJobs` sırası). Planlayıcının çıktısı sıraya bağlı olduğundan
 * oturum kurma, raf göstergesi ve yeniden planlama aynı sırayı kullanır (istemcinin gönderdiği sıra önemsiz).
 */
export const planOrder = (a: Pick<PrintJob, "createdAt" | "seq">, b: Pick<PrintJob, "createdAt" | "seq">): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;

/** "#<sıra>" yedek sipariş no. */
export const orderNoOf = (job: Pick<PrintJob, "orderNo" | "seq">): string => job.orderNo?.trim() || `#${job.seq}`;

/** Basılmış oturumlarda yer alan işler (`print_sessions.status = printed`). */
export function printedJobIds(db: TenantDb, languageId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.job_id FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org JOIN print_sessions s ON s.id = p.session_id AND s.org_id = $org
       WHERE i.org_id = $org AND s.language_id = ? AND s.status = 'printed' AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
    )
    .all(languageId) as { job_id: string }[];
  return new Set(rows.map((r) => r.job_id));
}

/** Taslak oturumlardaki yerleşim sayısı (kopyalar dahil), iş başına. */
export function placedCounts(db: TenantDb, languageId: string, excludeSessionId?: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT i.job_id, SUM(p.copies) AS n FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org JOIN print_sessions s ON s.id = p.session_id AND s.org_id = $org
       WHERE i.org_id = $org AND s.language_id = ? AND s.status = 'draft' AND s.deleted_at IS NULL AND p.deleted_at IS NULL ${excludeSessionId ? "AND s.id <> ?" : ""}
       GROUP BY i.job_id`,
    )
    .all(languageId, ...(excludeSessionId ? [excludeSessionId] : [])) as { job_id: string; n: number }[];
  return new Map(rows.map((r) => [r.job_id, Number(r.n)]));
}

/**
 * Raf: onaylı ve basılmamış işler, her biri için gereken (`needed`, planlayıcının fazlalık kuralıyla) ve taslaklara
 * yerleşmiş (`placed`) adet. `needed` için işin türü/boyutundaki ilk (arşivlenmemiş) şablonun kapasitesi kullanılır.
 */
export class ShelfQuery {
  constructor(
    private readonly db: TenantDb,
    private readonly profiles: ProfileService,
    private readonly planner: () => PrintPlanner | null | undefined,
    private readonly templates: (languageId: string) => PrintTemplate[],
    /** İlk plan toplamı ve sticker ölçüsü için (bağlı değilse formül, ölçüsüz). */
    private readonly sessions: () => PrintSessionService | null = () => null,
  ) {}

  list(languageId: string): ShelfItem[] {
    const profile = this.profiles.activeProfile(languageId).profile;
    const printed = printedJobIds(this.db, languageId);
    const placed = placedCounts(this.db, languageId);
    const templates = this.templates(languageId);
    const jobs = approvedJobs(this.db, languageId, SHELF_STATUSES).filter((j) => !printed.has(j.id));
    const sessions = this.sessions();
    const exact = sessions?.plannedNeeds(languageId, jobs, profile, (j) => this.templateFor(j, sizeOf(j, profile), templates)) ?? new Map<string, number>();
    return jobs.map((j) => {
      const sizeId = sizeOf(j, profile);
      const planned = exact.get(j.id);
      const item: ShelfItem = {
        jobId: j.id,
        variantId: j.variantId,
        orderNo: j.orderNo,
        kind: j.kind,
        sizeId,
        quantity: j.quantity,
        needed: j.quantityMissing ? 0 : planned !== undefined ? planned : this.needed(j, sizeId, profile, templates),
        placed: placed.get(j.id) ?? 0,
        designKey: designKeyOf(j),
        previewUrl: previewUrlOf(j),
        product: j.product,
        neededApprox: !j.quantityMissing && planned === undefined,
      };
      if (j.quantityMissing) item.quantityMissing = true;
      // Kesimli etiket: raf, `pageTemplateFor` ile aynı ayrımı (daire kesimi ↔ eski boyut) yapabilsin.
      if (j.kind === "label" && j.cut) item.cut = j.cut;
      if (j.kind === "sticker") {
        const size = sessions?.stickerSize(j.variantId);
        if (size) {
          item.wMm = size.wMm;
          item.hMm = size.hMm;
        }
      }
      return item;
    });
  }

  /** İşin türü/boyutundaki ilk (arşivlenmemiş) şablon; yoksa boyutu boş olan. */
  private templateFor(j: Pick<PrintJob, "kind"> & { cut?: TemplateCut | null }, sizeId: string | null, templates: PrintTemplate[]): PrintTemplate | null {
    return pageTemplateFor(j, sizeId, templates);
  }

  needed(j: Pick<PrintJob, "kind" | "quantity"> & { cut?: TemplateCut | null }, sizeId: string | null, profile: Profile, templates: PrintTemplate[]): number {
    const fn = this.planner()?.neededCount;
    if (!fn) return j.quantity;
    const t = this.templateFor(j, sizeId, templates);
    return Math.max(j.quantity, Math.round(fn({ kind: j.kind, quantity: j.quantity, template: t, rules: profile.printing })));
  }
}

/**
 * İşin kendiliğinden gideceği sayfa şablonu (arşivlenmemiş): önce boyut kimliği tam uyan. Kesimli işte (dikdörtgen,
 * kare…) boyutsuz şablona yalnız BÜTÜN yuvaları kesime uyuyorsa gider; uyan yoksa null (kullanıcı seçer, uyarı alır).
 * Kesimsiz (eski) işte boyutsuz şablona gider (eski kural; sahibin akışı değişmez).
 */
export function pageTemplateFor(
  j: Pick<PrintJob, "kind"> & { cut?: TemplateCut | null },
  sizeId: string | null,
  templates: readonly PrintTemplate[],
): PrintTemplate | null {
  const live = templates.filter((x) => x.kind === j.kind && !x.archived);
  const exact = live.find((x) => x.sizeId !== null && x.sizeId === sizeId);
  if (exact) return exact;
  const loose = live.filter((x) => x.sizeId === null);
  if (j.kind === "label" && j.cut) {
    const cut = j.cut;
    return loose.find((x) => x.slots.length > 0 && x.slots.every((s) => slotFitsCut(s, cut))) ?? null;
  }
  return loose[0] ?? null;
}
