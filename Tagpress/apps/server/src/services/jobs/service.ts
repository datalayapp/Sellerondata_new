import { randomUUID } from "node:crypto";
import type { ApproveBestResponse, ImportRow, ImportRowInput, Issue, JobDetail, JobPatch, JobStatus, Skipped } from "@tagpress/domain";
import { json } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";
import { fail } from "../../util/errors.ts";
import { parseQuantity } from "../import/rows.ts";
import type { RowContext } from "../import/rows.ts";
import type { RowValidator } from "../import/validator.ts";
import { JOB_SELECT, type JobRow, type VariantRow, dismissedOf, issueLevel, jobIssues, jobSummary, visibleStatus } from "./mapping.ts";
import { variantsFor } from "./query.ts";

/** İşler: oluşturma, okuma, düzenleme (sorunlar yeniden hesaplanır), onay, durum. */
export class JobService {
  constructor(
    private readonly db: TenantDb,
    private readonly validator: RowValidator,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  row(id: string, includeDeleted = false): JobRow | null {
    const r = this.db.prepare(`${JOB_SELECT} WHERE j.id = ? AND j.org_id = $org ${includeDeleted ? "" : "AND j.deleted_at IS NULL"}`).get(id) as JobRow | undefined;
    return r ?? null;
  }

  require(id: string): JobRow {
    const r = this.row(id);
    if (!r) throw fail("job-not-found");
    return r;
  }

  get(id: string): JobDetail {
    const r = this.require(id);
    const variants = variantsFor(this.db, [id]).get(id) ?? [];
    return { ...jobSummary(r, variants), raw: json(r.raw, {}), textRaw: r.text_raw, dismissed: dismissedOf(r), batchName: r.batch_name };
  }

  liveVariants(jobId: string): VariantRow[] {
    return variantsFor(this.db, [jobId]).get(jobId) ?? [];
  }

  /** Doğrulanmış satırlardan işler (aynı işlemde). */
  createMany(batchId: string, rows: ImportRow[]): string[] {
    // Ebeveyn (parti) aynı firmada olmalı.
    if (!this.db.prepare("SELECT 1 FROM batches WHERE id = ? AND org_id = $org").get(batchId)) throw fail("batch-not-found");
    const now = this.clock.now().toISOString();
    const ids: string[] = [];
    const stmt = this.db.prepare(
      `INSERT INTO jobs (org_id, id, batch_id, seq, raw, order_no, quantity, template_key, label_size, product, text_raw, text, segments, ai_note, kind, status,
         issues, dismissed, issue_level, dedupe_key, created_at, updated_at)
       VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
    );
    const seq0 = (this.db.prepare("SELECT COALESCE(MAX(seq), -1) AS s FROM jobs WHERE batch_id = ? AND org_id = $org").get(batchId) as { s: number }).s + 1;
    this.db.tx(() => {
      rows.forEach((r, i) => {
        const id = randomUUID();
        ids.push(id);
        const q = parseQuantity(r.quantity);
        stmt.run(
          id, batchId, seq0 + i, JSON.stringify(r.raw), r.orderNo, q.value, r.templateKey, r.labelSize, r.product, r.textRaw, r.text,
          JSON.stringify(r.segments), r.aiNote, r.kind, JSON.stringify(r.issues), JSON.stringify(r.dismissed), issueLevel(r.issues), r.dedupeKey, now, now,
        );
      });
    });
    this.events.emit({ type: "jobs", batchId });
    return ids;
  }

  /** Düzenleme: alanlar yazılır, sorunlar yeniden hesaplanır; onaylı varyasyon eskidiyse onay kalkar. */
  update(id: string, patch: JobPatch, ctx?: RowContext): JobDetail {
    const r = this.require(id);
    const input: ImportRowInput = {
      ...this.asInput(r),
      ...(patch.text !== undefined && { text: patch.text }),
      ...(patch.templateKey !== undefined && { templateKey: patch.templateKey?.trim().toLowerCase() || null }),
      ...(patch.labelSize !== undefined && { labelSize: patch.labelSize }),
      ...(patch.quantity !== undefined && { quantity: patch.quantity }),
      ...(patch.orderNo !== undefined && { orderNo: patch.orderNo?.trim() || null }),
      ...(patch.product !== undefined && { product: patch.product }),
      ...(patch.aiNote !== undefined && { aiNote: patch.aiNote }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.dismissed !== undefined && { dismissed: patch.dismissed }),
    };
    const [v] = this.validator.validate(r.language_id, [input], false, [id], ctx && ctx.languageId === r.language_id ? ctx : undefined);
    const q = parseQuantity(v!.quantity);
    const runIssues = json<Issue[]>(r.run_issues, []);
    let approved = r.approved_variant_id;
    let status = r.status;
    const contentChanged = v!.text !== r.text || v!.templateKey !== r.template_key || v!.labelSize !== r.label_size;
    if (contentChanged && approved && status === "approved") {
      approved = null;
      status = "ready";
    }
    if (contentChanged && status === "failed") status = this.liveVariants(id).length ? "ready" : "new";
    this.db
      .prepare(
        `UPDATE jobs SET text = ?, segments = ?, template_key = ?, label_size = ?, quantity = ?, order_no = ?, product = ?, ai_note = ?, kind = ?,
           dismissed = ?, issues = ?, issue_level = ?, dedupe_key = ?, approved_variant_id = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = $org`,
      )
      .run(
        v!.text, JSON.stringify(v!.segments), v!.templateKey, v!.labelSize, q.value, v!.orderNo, v!.product, v!.aiNote, v!.kind,
        JSON.stringify(v!.dismissed), JSON.stringify(v!.issues), issueLevel([...v!.issues, ...runIssues]), v!.dedupeKey, approved, status,
        this.clock.now().toISOString(), id,
      );
    this.emit(id);
    return this.get(id);
  }

  /** İçe aktarma sorunlarını şablon/profil/font değişikliğinden sonra yeniden hesaplar (dil başına tek bağlam). */
  revalidate(ids: string[]): number {
    const contexts = new Map<string, RowContext>();
    let n = 0;
    for (const id of ids) {
      const r = this.row(id);
      if (!r) continue;
      let ctx = contexts.get(r.language_id);
      if (!ctx) contexts.set(r.language_id, (ctx = this.validator.context(r.language_id)));
      this.update(id, {}, ctx);
      n++;
    }
    return n;
  }

  /** Bir dilin bütün (silinmemiş) işleri. */
  idsOfLanguage(languageId: string): string[] {
    return (this.db.prepare("SELECT j.id FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org WHERE j.org_id = $org AND b.language_id = ? AND j.deleted_at IS NULL AND b.deleted_at IS NULL").all(languageId) as { id: string }[]).map((r) => r.id);
  }

  approve(id: string, variantId: string | null): JobDetail {
    this.require(id);
    if (variantId && !this.liveVariants(id).some((v) => v.id === variantId)) throw fail("variant-not-found");
    const status: JobStatus = variantId ? "approved" : this.liveVariants(id).length ? "ready" : "new";
    this.db.prepare("UPDATE jobs SET approved_variant_id = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = $org").run(variantId, status, this.clock.now().toISOString(), id);
    this.emit(id);
    return this.get(id);
  }

  /**
   * "En iyiyi onayla": kontrol işaretli ve eskimiş varyasyonlar seçilmez. Sıra: AI'ın kendi turundaki ilk tercihi
   * olanlar önce, sonra puan, sonra en yeni.
   */
  approveBest(ids: string[]): ApproveBestResponse {
    const approved: ApproveBestResponse["approved"] = [];
    const skipped: Skipped[] = [];
    for (const id of ids) {
      const r = this.row(id);
      if (!r) {
        skipped.push({ id, reason: "İş bulunamadı." });
        continue;
      }
      const detail = this.get(id);
      const pool = detail.variants.filter((v) => !v.suspect && !v.stale);
      if (!detail.variants.length) {
        skipped.push({ id, reason: "Varyasyon yok." });
        continue;
      }
      if (!pool.length) {
        skipped.push({ id, reason: "Bütün varyasyonlar kontrol işaretli ya da eski." });
        continue;
      }
      const rankKey = (n: number | null) => (n === 1 ? 0 : 1);
      const best = [...pool].sort((a, b) => rankKey(a.aiRank) - rankKey(b.aiRank) || (b.score ?? -1) - (a.score ?? -1) || b.no - a.no)[0]!;
      this.approve(id, best.id);
      approved.push({ jobId: id, variantId: best.id });
    }
    return { approved, skipped };
  }

  /** Yaşam döngüsü durumu (+ isteğe bağlı hata metni). */
  setStatus(id: string, status: JobStatus, error: string | null = null): void {
    this.db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND org_id = $org").run(status, error, this.clock.now().toISOString(), id);
    this.emit(id);
  }

  setGenState(id: string, state: "queued" | "generating" | null): void {
    this.db.prepare("UPDATE jobs SET gen_state = ?, updated_at = ? WHERE id = ? AND org_id = $org").run(state, this.clock.now().toISOString(), id);
    this.emit(id);
  }

  /** Üretim sorunları: verilen kodlar silinip yenileri eklenir. */
  setRunIssues(id: string, codes: Issue["code"][], add: Issue[]): void {
    const r = this.row(id, true);
    if (!r) return;
    const run = [...json<Issue[]>(r.run_issues, []).filter((i) => !codes.includes(i.code)), ...add];
    const all = [...json<Issue[]>(r.issues, []), ...run];
    this.db.prepare("UPDATE jobs SET run_issues = ?, issue_level = ? WHERE id = ? AND org_id = $org").run(JSON.stringify(run), issueLevel(all), id);
  }

  /** Varyasyon eklenince/silinince yaşam döngüsünü düzeltir. */
  syncAfterVariants(id: string): void {
    const r = this.row(id, true);
    if (!r) return;
    const live = this.liveVariants(id);
    let approved = r.approved_variant_id;
    if (approved && !live.some((v) => v.id === approved)) approved = null;
    const status: JobStatus = approved ? "approved" : live.length ? "ready" : r.status === "failed" ? "failed" : "new";
    this.db.prepare("UPDATE jobs SET approved_variant_id = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = $org").run(approved, status, this.clock.now().toISOString(), id);
    this.emit(id);
  }

  private asInput(r: JobRow): ImportRowInput {
    return {
      index: r.seq,
      raw: json(r.raw, {}),
      include: true,
      textRaw: r.text_raw,
      text: r.text,
      templateInput: null,
      templateKey: r.template_key,
      labelSize: r.label_size,
      orderNo: r.order_no,
      quantity: r.quantity,
      product: r.product,
      kind: r.kind,
      aiNote: r.ai_note,
      dismissed: dismissedOf(r),
    };
  }

  emit(id: string): void {
    const r = this.row(id, true);
    this.events.emit({ type: "job", jobId: id, ...(r ? { status: visibleStatus(r) } : {}) });
  }

  /** Bir işin bütün sorunları (DTO için). */
  issuesOf(id: string): Issue[] {
    return jobIssues(this.require(id));
  }
}
