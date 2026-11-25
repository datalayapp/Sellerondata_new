import { randomUUID } from "node:crypto";
import type { QueueStatus, VariantKind } from "@tagpress/domain";
import { json, placeholders } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import { isOrgOpen, maintenance, runInOrg } from "../../org/context.ts";
import { type TenantDb, dialectSql, insertOrder } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";
import { errorMessage } from "../../util/errors.ts";
import { DEFAULT_MAX_CONCURRENCY, pickFair } from "./fair.ts";

/**
 * Kurtarmada bu kadar denemeden sonra görev başarısız sayılır (sürekli çöken iş kuyruğu kilitlemesin). Yoğunlukta
 * (`TaskRequeue`) yeniden kuyruğa alma da aynı sayaçtan düşer.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Çalıştırıcı görevi bir süre sonra yeniden kuyruğa ister (geçidin hız sınırı `sod_rate_limited`). Görev "queued" olur ama
 * `delayMs` dolana dek seçilmez (bekleme süreç belleğinde; süreç kapanırsa açılışta hemen seçilir); yuvası boşalır. Yeni
 * çalıştırma yeni bir yapay zekâ isteği gönderir. Deneme sayısı (`attempts`) sınırını çalıştırıcı denetler (`MAX_ATTEMPTS`).
 */
export class TaskRequeue extends Error {
  constructor(readonly delayMs: number) {
    super(`Görev ${Math.round(delayMs / 1000)} sn sonra yeniden kuyruğa alınacak.`);
    this.name = "TaskRequeue";
  }
}

export interface TaskParams {
  theme?: string;
  keepTemplate?: boolean;
  revision?: { fromVariantId: string; request: string };
}

export interface GenTask {
  id: string;
  /** Görevin firması: çalıştırıcı bu firmanın bağlamında çağrılır. */
  orgId: string;
  jobId: string;
  mode: VariantKind;
  params: TaskParams;
  attempts: number;
}

/** Görev çalıştırıcısı: hata fırlatırsa görev "failed" olur (iş durumu çalıştırıcının sorumluluğunda). */
export type TaskRunner = (task: GenTask) => Promise<void>;

interface TaskRow {
  id: string;
  org_id: string;
  job_id: string;
  mode: VariantKind;
  params: string;
  attempts: number;
}

export interface QueueOptions {
  /** Kurulum genelinde aynı anda çalışan en çok görev (`install.maxConcurrency`; varsayılan 4). */
  maxConcurrency?: () => number;
  /** Kurtarmada üst üste yarıda kalan görevin işi (işin firmasının bağlamında çağrılır). */
  onAbandoned?: (jobId: string) => void;
}

/**
 * Süreç içi üretim kuyruğu, firma kapsamlı ve adil. Durum SQLite'tadır (gen_tasks): süreç çökerse açılışta
 * `recover()` yarıda kalanları yeniden sıraya alır.
 * - Kurulum genelinde en çok `maxConcurrency`, firma başına en çok firmanın `concurrency` ayarı kadar görev çalışır
 *   (ikisi de her seçimde okunur).
 * - `kick()` isteğin bağlamını miras almaz (bakım kapsamında seçer): bekleyen görevi olan firmalardan o an en az görevi
 *   çalışan, eşitse en eski görevi olan seçilir; firmanın içinde en eski görev. Tek firmada sıra bugünküyle aynı.
 * - Her görev kendi firmasının bağlamında (`runInOrg(task.orgId)`) çalışır; `status()` geçerli firmanınkidir.
 */
export class GenerationQueue {
  private running = new Map<string, { orgId: string; p: Promise<void> }>();
  /** Yeniden kuyruğa alınmış ama bekleme süresi dolmamış görevler (`TaskRequeue`): seçimde atlanır. */
  private held = new Map<string, NodeJS.Timeout>();
  private runner: TaskRunner | null = null;
  private stopped = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly clock: Clock,
    /** Geçerli firmanın eşzamanlılık ayarı (firma bağlamında çağrılır). */
    private readonly concurrency: () => number,
    /** İş görünür durumu (queued/generating/null); işin firmasının bağlamında çağrılır. */
    private readonly setJobState: (jobId: string, state: "queued" | "generating" | null) => void,
    private readonly opts: QueueOptions = {},
  ) {}

  setRunner(runner: TaskRunner): void {
    this.runner = runner;
  }

  /** Aynı iş için zaten bekleyen/çalışan görev varsa yenisi eklenmez (geçerli firma). */
  enqueue(items: { jobId: string; mode: VariantKind; params?: TaskParams }[]): { queued: string[]; skipped: { id: string; reason: string }[] } {
    const queued: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const now = this.clock.now().toISOString();
    for (const it of items) {
      // Ebeveyn (iş) aynı firmada olmalı: başka firmanın işine görev açılmaz.
      if (!this.db.prepare("SELECT 1 FROM jobs WHERE id = ? AND org_id = $org AND deleted_at IS NULL").get(it.jobId)) {
        skipped.push({ id: it.jobId, reason: "İş bulunamadı." });
        continue;
      }
      const busy = this.db.prepare("SELECT 1 FROM gen_tasks WHERE job_id = ? AND org_id = $org AND status IN ('queued', 'running')").get(it.jobId);
      if (busy) {
        skipped.push({ id: it.jobId, reason: "Bu iş zaten üretim sırasında." });
        continue;
      }
      this.db
        .prepare("INSERT INTO gen_tasks (org_id, id, job_id, mode, params, status, created_at) VALUES ($org, ?, ?, ?, ?, 'queued', ?)")
        .run(randomUUID(), it.jobId, it.mode, JSON.stringify(it.params ?? {}), now);
      this.setJobState(it.jobId, "queued");
      queued.push(it.jobId);
    }
    this.emitStatus();
    queueMicrotask(() => this.kick());
    return { queued, skipped };
  }

  /** Geçerli firmanın bekleyenlerini iptal eder (çalışanlar biter). */
  cancel(jobIds?: string[]): number {
    const now = this.clock.now().toISOString();
    const where = jobIds?.length ? `AND job_id IN (${placeholders(jobIds.length)})` : "";
    const rows = this.db.prepare(`SELECT job_id FROM gen_tasks WHERE org_id = $org AND status = 'queued' ${where}`).all(...(jobIds ?? [])) as { job_id: string }[];
    this.db.prepare(`UPDATE gen_tasks SET status = 'cancelled', finished_at = ? WHERE org_id = $org AND status = 'queued' ${where}`).run(now, ...(jobIds ?? []));
    for (const r of rows) this.setJobState(r.job_id, null);
    this.emitStatus();
    this.notifyIdle();
    return rows.length;
  }

  /**
   * Açılışta (kurulum geneli bakım): "running" kalanlar yeniden sıraya (deneme sayısı aşıldıysa başarısız). Her görev
   * kendi firmasında işlenir. Dönen `failed`: başarısız sayılan görevlerin işleri (`onAbandoned` de çağrılmıştır).
   */
  recover(): { requeued: number; failed: string[] } {
    return maintenance(() => {
      const rows = this.db.maintenance.prepare("SELECT id, org_id, job_id, attempts FROM gen_tasks WHERE status = 'running'").all() as {
        id: string;
        org_id: string;
        job_id: string;
        attempts: number;
      }[];
      const failed: string[] = [];
      let requeued = 0;
      for (const r of rows) {
        runInOrg(r.org_id, () => {
          if (r.attempts >= MAX_ATTEMPTS) {
            this.finish(r.id, "failed", "Üretim üst üste yarıda kaldı; görev durduruldu.");
            this.setJobState(r.job_id, null);
            this.opts.onAbandoned?.(r.job_id);
            failed.push(r.job_id);
          } else {
            this.db.prepare("UPDATE gen_tasks SET status = 'queued', started_at = NULL WHERE id = ? AND org_id = $org").run(r.id);
            this.setJobState(r.job_id, "queued");
            requeued++;
          }
        });
      }
      // Görevi olmayan "queued/generating" işler (ör. elle düzenlenmiş veritabanı) temizlenir. Postgres'te işler tablosu
      // kuyruk kapsamında görünmez: şemadaki işlev firma firma boşaltır.
      this.db.maintenance.exec(
        dialectSql(this.db, {
          sqlite: "UPDATE jobs SET gen_state = NULL WHERE gen_state IS NOT NULL AND id NOT IN (SELECT job_id FROM gen_tasks WHERE status IN ('queued', 'running'))",
          pg: "SELECT tagpress.queue_clear_orphan_gen_state()",
        }),
      );
      return { requeued, failed };
    }, "kuyruk kurtarma");
  }

  /** Boş yer varsa adil sırayla bekleyenleri başlatır. Çağıranın firma bağlamını kullanmaz. */
  kick(): void {
    if (this.stopped || !this.runner) return;
    const runner = this.runner;
    const started = new Set<string>();
    maintenance(() => {
      const m = this.db.maintenance;
      const caps = new Map<string, number>();
      const cap = (orgId: string) => {
        let c = caps.get(orgId);
        if (c === undefined) caps.set(orgId, (c = runInOrg(orgId, () => this.concurrency())));
        return c;
      };
      // Çok firmalı kurulumda tek başına çalışan firma bir yuvayı boş bırakır (pickFair `reserve`).
      // Postgres'te firma kaydı product-kit `Company` (kurulum tablosu `orgs` yok; kuyruk kapsamında okunur).
      const openOrgsStmt =
        this.db.dialect === "pg" ? m.prepare('SELECT COUNT(*) AS n FROM "Company" WHERE "closedAt" IS NULL') : this.db.install.prepare("SELECT COUNT(*) AS n FROM orgs WHERE closed_at IS NULL");
      const openOrgs = Number((openOrgsStmt.get() as { n: number }).n);
      // Bekleme süresi dolmamış yeniden kuyruğa alınmış görevler seçilmez.
      const heldIds = [...this.held.keys()];
      const notHeld = heldIds.length ? ` AND id NOT IN (${placeholders(heldIds.length)})` : "";
      while (this.running.size < this.maxTotal()) {
        const orgs = m.prepare(`SELECT org_id, MIN(created_at) AS oldest FROM gen_tasks WHERE status = 'queued'${notHeld} GROUP BY org_id`).all(...heldIds) as {
          org_id: string;
          oldest: string;
        }[];
        // Kapalı ya da kalıcı silinen firmanın görevi seçilmez (platform kipi, `isOrgOpen`); firma açılınca sürer.
        const pick = pickFair(
          orgs.filter((o) => isOrgOpen(o.org_id)).map((o) => ({ orgId: o.org_id, oldest: o.oldest })),
          (o) => this.runningOf(o),
          cap,
          { total: this.maxTotal(), reserve: openOrgs > 1 },
        );
        if (!pick) break;
        const row = m
          .prepare(`SELECT id, org_id, job_id, mode, params, attempts FROM gen_tasks WHERE status = 'queued' AND org_id = ?${notHeld} ORDER BY created_at, ${insertOrder(this.db)} LIMIT 1`)
          .get(pick.orgId, ...heldIds) as TaskRow | undefined;
        if (!row) break;
        const claimed = m
          .prepare("UPDATE gen_tasks SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'queued'")
          .run(this.clock.now().toISOString(), row.id);
        if (claimed.changes !== 1) continue;
        const task: GenTask = { id: row.id, orgId: row.org_id, jobId: row.job_id, mode: row.mode, params: json<TaskParams>(row.params, {}), attempts: row.attempts + 1 };
        started.add(task.orgId);
        runInOrg(task.orgId, () => this.start(runner, task));
      }
    }, "kuyruk seçimi");
    for (const orgId of started) runInOrg(orgId, () => this.emitStatus());
    this.notifyIdle();
  }

  /** Geçerli firmanın kuyruk durumu (`concurrency`: firmanın etkin sınırı; kurulum sınırını aşmaz). */
  status(): QueueStatus {
    const orgId = this.db.orgId("queue.status");
    const queued = (this.db.prepare("SELECT COUNT(*) AS n FROM gen_tasks WHERE org_id = $org AND status = 'queued'").get() as { n: number }).n;
    const runningJobIds = (this.db.prepare("SELECT job_id FROM gen_tasks WHERE org_id = $org AND status = 'running'").all() as { job_id: string }[]).map((r) => r.job_id);
    return { running: this.runningOf(orgId), queued, concurrency: Math.min(Math.max(1, this.concurrency()), this.maxTotal()), runningJobIds };
  }

  /** Kuyruk boşalınca (bütün firmalarda çalışan ve bekleyen yokken) çözülür. Testler ve kapanış için. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Yeni görev başlatmaz; çalışanların bitmesini en çok `waitMs` bekler (yarıda kalan açılışta kurtarılır). */
  async stop(waitMs = 5000): Promise<void> {
    this.stopped = true;
    for (const t of this.held.values()) clearTimeout(t);
    this.held.clear();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, waitMs)));
    await Promise.race([Promise.allSettled([...this.running.values()].map((r) => r.p)), timeout]);
    clearTimeout(timer);
  }

  /** Görevi başlatır; görevin firmasının bağlamında çağrılır (bitiş geri çağırmaları da o bağlamda sürer). */
  private start(runner: TaskRunner, task: GenTask): void {
    this.setJobState(task.jobId, "generating");
    let requeued = false;
    const p = runner(task)
      .then(() => this.finish(task.id, "done", null))
      .catch((err: unknown) => {
        if (err instanceof TaskRequeue) {
          requeued = true;
          this.hold(task.id, err.delayMs);
        } else this.finish(task.id, "failed", errorMessage(err));
      })
      .finally(() => {
        this.running.delete(task.id);
        this.setJobState(task.jobId, requeued ? "queued" : null);
        this.emitStatus();
        this.kick();
        this.notifyIdle();
      });
    this.running.set(task.id, { orgId: task.orgId, p });
  }

  /** Görevi yeniden "queued" yapar; `delayMs` dolana dek seçilmez (görevin firmasının bağlamında çağrılır). */
  private hold(taskId: string, delayMs: number): void {
    this.db.prepare("UPDATE gen_tasks SET status = 'queued', started_at = NULL WHERE id = ? AND org_id = $org AND status = 'running'").run(taskId);
    if (this.stopped) return; // kapanışta: açılışta sıradan seçilir
    const t = setTimeout(() => {
      this.held.delete(taskId);
      this.kick();
    }, Math.max(0, delayMs));
    t.unref?.();
    this.held.set(taskId, t);
  }

  private maxTotal(): number {
    return Math.max(1, this.opts.maxConcurrency?.() ?? DEFAULT_MAX_CONCURRENCY);
  }

  private runningOf(orgId: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.orgId === orgId) n++;
    return n;
  }

  private isIdle(): boolean {
    if (this.running.size) return false;
    if (this.stopped || !this.runner) return true;
    return maintenance(() => !(this.db.maintenance.prepare("SELECT 1 FROM gen_tasks WHERE status = 'queued' LIMIT 1").get() as unknown), "kuyruk boş mu");
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Geçerli firmanın görevini kapatır (görevin firmasının bağlamında çağrılır). */
  private finish(id: string, status: "done" | "failed", error: string | null): void {
    this.db.prepare("UPDATE gen_tasks SET status = ?, error = ?, finished_at = ? WHERE id = ? AND org_id = $org").run(status, error, this.clock.now().toISOString(), id);
  }

  private emitStatus(): void {
    this.events.emit({ type: "queue", status: this.status() });
  }
}
