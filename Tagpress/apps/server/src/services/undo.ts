import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { type JobStatus, type Profile, type UndoResult, type UndoText, type UndoToken, undoMsg } from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import { json, placeholders } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import { type Clock, DAY_MS } from "../util/clock.ts";
import { fail } from "../util/errors.ts";
import { requireFeature } from "../features/service.ts";
import { CutChangeService } from "./jobs/cut-change.ts";
import { ProfileService } from "./profiles.ts";
import { SettingsService } from "./settings.ts";
import type { VariantImage } from "./variants.ts";
import { PNG, safeJoin } from "../util/safe-path.ts";

/** Yumuşak silinenler ve geri alma kayıtları bu kadar gün tutulur. */
export const RETENTION_DAYS = 30;

interface UndoPayload {
  jobs: string[];
  batches: string[];
  variants: string[];
  languages: string[];
  /**
   * Silmeden önceki onay durumu (varyasyon silinirken onay kalkar). `cutSignature`: onaylı varyasyonun silme anındaki
   * etkin kesim imzası (`CutChangeService.approvalCut`); geri almada kesim değişmişse onay geri gelmez. Eski kayıtlarda yok.
   */
  approvals: { jobId: string; variantId: string | null; status: JobStatus; cutSignature?: string }[];
  /** Hafif düzeltme: değişiklikten ÖNCEKİ hâl (geri almada bu yazılır; önizleme dosyaları silinmediği için yeniden çizim gerekmez). */
  adjusts?: AdjustState[];
  /** Baskı masası: yumuşak silinen oturumlar ve sayfalar (geri almada oturum sürümü artar). */
  printSessions?: string[];
  printPages?: string[];
}

/** Varyasyonun düzeltme durumu (veritabanı sütunları). */
export interface AdjustState {
  variantId: string;
  adjust: string | null;
  rev: number;
  issues: string;
  previewFile: string;
}

const empty = (): UndoPayload => ({ jobs: [], batches: [], variants: [], languages: [], approvals: [], adjusts: [] });

/**
 * Yumuşak silme + geri alma. Silme `deleted_at` yazar ve bir geri alma anahtarı döner; geri alma yalnızca
 * O İŞLEMDE silinenleri geri getirir. 30 gün sonra kalıcı temizlik (`purge`). Her şey geçerli firmanın satırlarında:
 * başka firmanın anahtarı "bulunamadı" olur, temizlik yalnız o firmanın satırlarını ve kökündeki dosyaları siler.
 */
export class UndoService {
  constructor(
    private readonly db: TenantDb,
    private readonly paths: DataPaths,
    private readonly events: EventBus,
    private readonly clock: Clock,
    /** İş/varyasyon silindikten sonra durum düzeltmesi (JobService.syncAfterVariants). */
    private readonly afterVariantChange: (jobId: string) => void,
    /** Kalıcı temizlikten sonra (kullanılmayan geçici şablonlar vb.). */
    private readonly afterPurge?: () => Promise<unknown>,
  ) {
    this.cutChange = new CutChangeService(db, clock, events);
  }

  /** Kesim değişince onay düşmesi (geri almada eski kesimle onaylı dönmesin). */
  private readonly cutChange: CutChangeService;

  /** Dilin etkin profili (kesim imzası için); yoksa ya da okunamazsa null (karşılaştırılmaz). */
  private readonly activeProfile = (languageId: string): Profile | null => {
    try {
      return new ProfileService(this.db, this.events, this.clock).active(languageId)?.data ?? null;
    } catch {
      return null;
    }
  };

  deleteJobs(ids: string[]): UndoToken {
    const now = this.now();
    const live = this.liveIds("jobs", ids);
    if (!live.length) throw fail("jobs-to-delete-not-found");
    this.db.tx(() => {
      this.db.prepare(`UPDATE jobs SET deleted_at = ? WHERE org_id = $org AND id IN (${placeholders(live.length)})`).run(now, ...live);
      this.cancelQueues(live);
    });
    this.events.emit({ type: "jobs", batchId: null });
    return this.record("jobs", undoMsg("jobs-deleted", { count: live.length }), { ...empty(), jobs: live });
  }

  deleteBatch(id: string): UndoToken {
    if (!this.liveIds("batches", [id]).length) throw fail("batch-not-found");
    const jobs = (this.db.prepare("SELECT id FROM jobs WHERE batch_id = ? AND org_id = $org AND deleted_at IS NULL").all(id) as { id: string }[]).map((r) => r.id);
    const now = this.now();
    this.db.tx(() => {
      this.db.prepare("UPDATE batches SET deleted_at = ? WHERE id = ? AND org_id = $org").run(now, id);
      if (jobs.length) this.db.prepare(`UPDATE jobs SET deleted_at = ? WHERE org_id = $org AND id IN (${placeholders(jobs.length)})`).run(now, ...jobs);
      this.cancelQueues(jobs);
    });
    this.events.emit({ type: "batch", batchId: id });
    return this.record("batch", undoMsg("batch-deleted", { count: jobs.length }), { ...empty(), batches: [id], jobs });
  }

  deleteVariant(id: string): UndoToken {
    const v = this.db.prepare("SELECT job_id FROM variants WHERE id = ? AND org_id = $org AND deleted_at IS NULL").get(id) as { job_id: string } | undefined;
    if (!v) throw fail("variant-not-found");
    const job = this.db.prepare("SELECT approved_variant_id, status FROM jobs WHERE id = ? AND org_id = $org").get(v.job_id) as { approved_variant_id: string | null; status: JobStatus };
    const cutSignature = job.status === "approved" && job.approved_variant_id ? this.cutChange.approvalCut(v.job_id, job.approved_variant_id, this.activeProfile)?.signature : undefined;
    this.db.prepare("UPDATE variants SET deleted_at = ? WHERE id = ? AND org_id = $org").run(this.now(), id);
    this.afterVariantChange(v.job_id);
    this.events.emit({ type: "variant", jobId: v.job_id, variantId: id });
    return this.record("variant", undoMsg("variant-deleted"), {
      ...empty(),
      variants: [id],
      approvals: [{ jobId: v.job_id, variantId: job.approved_variant_id, status: job.status, ...(cutSignature && { cutSignature }) }],
    });
  }

  /** Hafif düzeltme kaydedildi/kaldırıldı: önceki hâl geri alınabilir (çağıran servis değişikliği yazar). */
  adjustChanged(text: UndoText, before: AdjustState): UndoToken {
    return this.record("adjust", text, { ...empty(), adjusts: [before] });
  }

  /** Baskı oturumu/sayfası silindi (çağıran servis `deleted_at` yazar). */
  printDeleted(text: UndoText, sessions: string[], pages: string[]): UndoToken {
    return this.record("print", text, { ...empty(), printSessions: sessions, printPages: pages });
  }

  /** Dil silme (çağıran servis `deleted_at` yazar). */
  languageDeleted(id: string): UndoToken {
    return this.record("language", undoMsg("language-deleted"), { ...empty(), languages: [id] });
  }

  undo(token: string): UndoResult {
    const row = this.db.prepare("SELECT * FROM undo WHERE token = ? AND org_id = $org").get(token) as { payload: string; expires_at: string; used_at: string | null } | undefined;
    if (!row) throw fail("undo-not-found");
    if (row.used_at) throw fail("undo-used");
    if (row.expires_at < this.now()) throw fail("undo-expired");
    const p = { ...empty(), ...json<Partial<UndoPayload>>(row.payload, {}) };
    const restore = (table: "languages" | "batches" | "jobs" | "variants" | "print_sessions" | "print_pages", ids: string[]) =>
      ids.length ? Number(this.db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE org_id = $org AND id IN (${placeholders(ids.length)})`).run(...ids).changes) : 0;
    // Silinmiş dili geri getirmek, firmada başka canlı dil varken ikinci dil açmaktır: `language.multi` gerekir.
    if (p.languages.length) {
      const deleted = Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM languages WHERE org_id = $org AND deleted_at IS NOT NULL AND id IN (${placeholders(p.languages.length)})`).get(...p.languages) as { n: number }).n,
      );
      const live = Number((this.db.prepare("SELECT COUNT(*) AS n FROM languages WHERE org_id = $org AND deleted_at IS NULL").get() as { n: number }).n);
      if (deleted > 0 && live > 0) requireFeature(new SettingsService(this.db), "language.multi");
    }
    const printTouched: string[] = [];
    const restored = this.db.tx(() => {
      const r = {
        languages: restore("languages", p.languages),
        batches: restore("batches", p.batches),
        jobs: restore("jobs", p.jobs),
        variants: restore("variants", p.variants),
      };
      for (const a of p.approvals) this.db.prepare("UPDATE jobs SET approved_variant_id = ?, status = ? WHERE id = ? AND org_id = $org").run(a.variantId, a.status, a.jobId);
      // Silmeden bu yana onaylı varyasyonun etkin kesimi değiştiyse onay geri gelmez: kesim değişince düşen onaylarla
      // aynı yol (`ready` + `template-cut-changed` uyarısı). İmzasız eski kayıtlar bugünkü gibi onaylı döner.
      const stale = p.approvals.flatMap((a) => {
        if (a.status !== "approved" || !a.variantId || !a.cutSignature) return [];
        const cur = this.cutChange.approvalCut(a.jobId, a.variantId, this.activeProfile);
        return cur && cur.signature !== a.cutSignature ? [{ id: a.jobId, key: cur.key }] : [];
      });
      if (stale.length) this.cutChange.dropApprovals(stale);
      for (const a of p.adjusts ?? []) {
        const n = this.db
          .prepare("UPDATE variants SET adjust = ?, adjust_rev = ?, issues = ?, preview_file = ? WHERE id = ? AND org_id = $org")
          .run(a.adjust, a.rev, a.issues, a.previewFile, a.variantId).changes;
        r.variants += Number(n);
      }
      // Baskı masası: oturum/sayfa geri gelir; oturumun sürümü artar (açık düzenleyiciler yenilensin).
      restore("print_sessions", p.printSessions ?? []);
      restore("print_pages", p.printPages ?? []);
      const pageSessions = (p.printPages ?? []).length
        ? (this.db.prepare(`SELECT DISTINCT session_id FROM print_pages WHERE org_id = $org AND id IN (${placeholders(p.printPages!.length)})`).all(...p.printPages!) as { session_id: string }[]).map(
            (x) => x.session_id,
          )
        : [];
      printTouched.push(...new Set([...(p.printSessions ?? []), ...pageSessions]));
      if (printTouched.length)
        this.db.prepare(`UPDATE print_sessions SET version = version + 1, updated_at = ? WHERE org_id = $org AND id IN (${placeholders(printTouched.length)})`).run(this.now(), ...printTouched);
      this.db.prepare("UPDATE undo SET used_at = ? WHERE token = ? AND org_id = $org").run(this.now(), token);
      return r;
    });
    for (const id of printTouched) {
      const s = this.db.prepare("SELECT language_id FROM print_sessions WHERE id = ? AND org_id = $org").get(id) as { language_id: string } | undefined;
      if (s) this.events.emit({ type: "print", languageId: s.language_id, sessionId: id });
    }
    for (const a of p.approvals) this.afterVariantChange(a.jobId);
    this.events.emit({ type: "jobs", batchId: null });
    for (const l of p.languages) this.events.emit({ type: "language", languageId: l });
    for (const a of p.adjusts ?? []) {
      const v = this.db.prepare("SELECT job_id FROM variants WHERE id = ? AND org_id = $org").get(a.variantId) as { job_id: string } | undefined;
      if (v) this.events.emit({ type: "variant", jobId: v.job_id, variantId: a.variantId });
    }
    return { ok: true, restored };
  }

  /**
   * Geçerli firmanın süresi dolan yumuşak silinenlerini ve geri alma kayıtlarını kalıcı siler; önizleme dosyaları
   * (firmanın kökünden) da gider. Açılışta ve günlük bakımda firma firma `runInOrg` içinde çağrılır.
   */
  async purge(): Promise<{ jobs: number; variants: number; batches: number }> {
    const cutoff = new Date(this.clock.now().getTime() - RETENTION_DAYS * DAY_MS).toISOString();
    // Süresi dolan varyasyon: kendisi, işi ya da işinin partisi silinmiş (hepsi bu firmanın).
    const expiredVariants = `org_id = $org AND (deleted_at < ? OR job_id IN (SELECT id FROM jobs WHERE org_id = $org AND deleted_at < ?)
         OR job_id IN (SELECT j.id FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org WHERE j.org_id = $org AND b.deleted_at < ?))`;
    const files = this.db
      .prepare(`SELECT id, preview_file, base_preview_file, image FROM variants WHERE ${expiredVariants}`)
      .all(cutoff, cutoff, cutoff) as { id: string; preview_file: string; base_preview_file: string | null; image: string | null }[];
    const counts = this.db.tx(() => {
      const variants = Number(this.db.prepare(`DELETE FROM variants WHERE ${expiredVariants}`).run(cutoff, cutoff, cutoff).changes);
      const jobs = Number(
        this.db
          .prepare("DELETE FROM jobs WHERE org_id = $org AND (deleted_at < ? OR batch_id IN (SELECT id FROM batches WHERE org_id = $org AND deleted_at < ?))")
          .run(cutoff, cutoff).changes,
      );
      const batches = Number(this.db.prepare("DELETE FROM batches WHERE org_id = $org AND deleted_at < ?").run(cutoff).changes);
      this.db.prepare("DELETE FROM gen_tasks WHERE org_id = $org AND job_id NOT IN (SELECT id FROM jobs WHERE org_id = $org)").run();
      this.db.prepare("DELETE FROM job_log WHERE org_id = $org AND job_id NOT IN (SELECT id FROM jobs WHERE org_id = $org)").run();
      this.db.prepare("DELETE FROM adjust_log WHERE org_id = $org AND variant_id NOT IN (SELECT id FROM variants WHERE org_id = $org)").run();
      this.db.prepare("DELETE FROM refs WHERE org_id = $org AND deleted_at < ?").run(cutoff);
      // Baskı masası: süresi dolan silinmiş oturum/sayfalar (öğeler ON DELETE CASCADE ile gider).
      this.db.prepare("DELETE FROM print_pages WHERE org_id = $org AND deleted_at < ?").run(cutoff);
      this.db.prepare("DELETE FROM print_sessions WHERE org_id = $org AND deleted_at < ?").run(cutoff);
      this.db.prepare("DELETE FROM undo WHERE org_id = $org AND expires_at < ?").run(this.now());
      return { variants, jobs, batches };
    });
    // Hafif düzeltme önizlemeleri: `<id>.adj<sürüm>.png` (geri alma için hepsi saklanır).
    const adjusted = files.length ? (await readdir(this.paths.previews).catch(() => [] as string[])).filter((n) => n.includes(".adj")) : [];
    // Kayıttaki dosya adları önizleme klasörünün dışına çıkamaz (`safeJoin`): kaçan değer silinmez.
    const remove = async (name: string | null | undefined) => {
      const file = name ? safeJoin(this.paths.previews, name, { ext: PNG }) : null;
      if (file) await rm(file, { force: true });
    };
    for (const f of files) {
      await remove(f.preview_file);
      await remove(f.base_preview_file);
      for (const n of adjusted) if (n.startsWith(`${f.id}.adj`)) await remove(n);
      await remove(json<VariantImage | null>(f.image, null)?.textLayerFile);
    }
    await this.afterPurge?.();
    return counts;
  }

  private record(kind: string, text: UndoText, payload: UndoPayload): UndoToken {
    const { label } = text;
    const token = randomBytes(12).toString("base64url");
    const expiresAt = new Date(this.clock.now().getTime() + RETENTION_DAYS * DAY_MS).toISOString();
    this.db
      .prepare("INSERT INTO undo (org_id, token, kind, label, payload, created_at, expires_at) VALUES ($org, ?, ?, ?, ?, ?, ?)")
      .run(token, kind, label, JSON.stringify(payload), this.now(), expiresAt);
    return { undoToken: token, label, code: text.code, ...(text.params && { params: text.params }), expiresAt };
  }

  /** Silinen işlerin bekleyen üretim görevleri iptal edilir (geri almada geri gelmez). */
  private cancelQueues(jobIds: string[]): void {
    if (!jobIds.length) return;
    const ph = placeholders(jobIds.length);
    this.db.prepare(`UPDATE gen_tasks SET status = 'cancelled', finished_at = ? WHERE org_id = $org AND status = 'queued' AND job_id IN (${ph})`).run(this.now(), ...jobIds);
    this.db.prepare(`UPDATE jobs SET gen_state = NULL WHERE org_id = $org AND gen_state = 'queued' AND id IN (${ph})`).run(...jobIds);
  }

  private liveIds(table: "jobs" | "batches", ids: string[]): string[] {
    if (!ids.length) return [];
    return (this.db.prepare(`SELECT id FROM ${table} WHERE org_id = $org AND deleted_at IS NULL AND id IN (${placeholders(ids.length)})`).all(...ids) as { id: string }[]).map((r) => r.id);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}
