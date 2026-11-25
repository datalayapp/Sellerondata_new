import {
  API,
  type Issue,
  type IssueCode,
  type JobKind,
  type JobStatus,
  type JobSummary,
  type VariantKind,
  type VariantSnapshot,
  type VariantSummary,
  apiPath,
  worstSeverity,
} from "@tagpress/domain";
import { json } from "../../db/database.ts";

export interface JobRow {
  id: string;
  batch_id: string;
  seq: number;
  raw: string;
  order_no: string | null;
  quantity: number | null;
  template_key: string | null;
  label_size: string | null;
  product: string | null;
  text_raw: string;
  text: string;
  segments: string;
  ai_note: string;
  kind: JobKind;
  status: JobStatus;
  gen_state: "queued" | "generating" | null;
  error: string | null;
  approved_variant_id: string | null;
  issues: string;
  run_issues: string;
  dismissed: string;
  issue_level: string | null;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** JOIN ile. */
  language_id: string;
  batch_name: string;
}

export interface VariantRow {
  id: string;
  job_id: string;
  no: number;
  kind: VariantKind;
  intent: string | null;
  layout: string | null;
  snapshot: string;
  preview_file: string;
  image: string | null;
  score: number | null;
  ai_rank: number | null;
  suspect: number;
  issues: string;
  rationale: string;
  created_at: string;
  deleted_at: string | null;
  /** Hafif düzeltme (göç 3): VariantAdjust JSON; null = düzeltme yok. */
  adjust?: string | null;
  /** Kayıtlı düzeltmenin sürümü (önizleme dosyası ve öğrenme kaydı bununla eşleşir); 0 = yok. */
  adjust_rev?: number;
  base_issues?: string | null;
  base_preview_file?: string | null;
}

/** İş satırı + partinin dili ve adı. Partinin firma kapsamı JOIN'de; çağıran WHERE'e `j.org_id = $org` ekler. */
export const JOB_SELECT = `SELECT j.*, b.language_id AS language_id, b.name AS batch_name FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org`;

/** Görünen durum: üretim kuyruğundaysa o, değilse yaşam döngüsü durumu. */
export const visibleStatus = (r: Pick<JobRow, "gen_state" | "status">): JobStatus => r.gen_state ?? r.status;

/** İşin sorunları: içerik sorunları + son üretimin sorunları. */
export function jobIssues(r: Pick<JobRow, "issues" | "run_issues">): Issue[] {
  return [...json<Issue[]>(r.issues, []), ...json<Issue[]>(r.run_issues, [])];
}

/** Filtre için: bilgi notları sayılmaz. */
export function issueLevel(issues: Issue[]): "error" | "warning" | null {
  const w = worstSeverity(issues.filter((i) => i.severity !== "info"));
  return w === "error" || w === "warning" ? w : null;
}

export function variantSummary(v: VariantRow, job: Pick<JobRow, "text" | "template_key" | "approved_variant_id">): VariantSummary {
  const snap = json<VariantSnapshot | null>(v.snapshot, null);
  const issues = json<Issue[]>(v.issues, []);
  return {
    id: v.id,
    jobId: v.job_id,
    no: v.no,
    kind: v.kind,
    score: v.score,
    aiRank: v.ai_rank,
    suspect: !!v.suspect,
    approved: job.approved_variant_id === v.id,
    // Temadan üretilmiş şablonda varyasyonun şablonu işinkinden farklıdır; yalnızca metin karşılaştırılır.
    stale: !!snap && (snap.text !== job.text || (v.kind !== "generated-template" && (snap.templateKey ?? null) !== (job.template_key ?? null))),
    // Önizleme önbellekte değişmez tutulur: düzeltme sürümü adrese girer (her sürümün dosyası ayrıdır).
    previewUrl: `${apiPath(API.variantPreview, { id: v.id })}?v=${v.no}${v.adjust_rev ? `.${v.adjust_rev}` : ""}`,
    worst: worstSeverity(issues),
    issueCount: issues.filter((i) => i.severity !== "info").length,
    adjusted: !!v.adjust,
    // Elle metin düzenlemesi iş metninden farklıysa kaydederken `text-edited` notu yazılır.
    textEdited: !!v.adjust && issues.some((i) => i.code === "text-edited"),
    createdAt: v.created_at,
  };
}

export function jobSummary(r: JobRow, variants: VariantRow[]): JobSummary {
  const issues = jobIssues(r);
  return {
    id: r.id,
    batchId: r.batch_id,
    languageId: r.language_id,
    seq: r.seq,
    orderNo: r.order_no,
    quantity: r.quantity,
    templateKey: r.template_key,
    labelSize: r.label_size,
    product: r.product,
    text: r.text,
    segments: json<string[]>(r.segments, []),
    kind: r.kind,
    aiNote: r.ai_note,
    status: visibleStatus(r),
    error: r.error,
    approvedVariantId: r.approved_variant_id,
    issues,
    worst: worstSeverity(issues),
    variants: variants.map((v) => variantSummary(v, r)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const dismissedOf = (r: Pick<JobRow, "dismissed">) => json<IssueCode[]>(r.dismissed, []);
