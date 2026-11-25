import type { ProgressStep } from "@tagpress/domain";
import type { EventBus } from "../../events.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";

/** İş başına saklanan en fazla adım satırı. */
const KEEP = 300;

/** Üretim günlüğü: kısa adım satırları kalıcıdır (job_log) ve SSE `progress` olayıyla canlı gider. */
export class ProgressLog {
  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  push(jobId: string, taskId: string | null, step: string, message: string): ProgressStep {
    const s: ProgressStep = { jobId, taskId, step, message: message.slice(0, 1000), at: this.clock.now().toISOString() };
    const r = this.db.prepare("INSERT INTO job_log (org_id, job_id, task_id, step, message, at) VALUES ($org, ?, ?, ?, ?, ?)").run(jobId, taskId, step, s.message, s.at);
    const id = Number(r.lastInsertRowid);
    if (id % 50 === 0) this.db.prepare("DELETE FROM job_log WHERE job_id = ? AND org_id = $org AND id <= ?").run(jobId, id - KEEP);
    this.events.emit({ type: "progress", step: s });
    return s;
  }

  list(jobId: string): ProgressStep[] {
    const rows = this.db
      .prepare("SELECT job_id, task_id, step, message, at FROM job_log WHERE job_id = ? AND org_id = $org ORDER BY id DESC LIMIT ?")
      .all(jobId, KEEP) as { job_id: string; task_id: string | null; step: string; message: string; at: string }[];
    return rows.reverse().map((r) => ({ jobId: r.job_id, taskId: r.task_id, step: r.step, message: r.message, at: r.at }));
  }
}
