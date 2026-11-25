import { randomUUID } from "node:crypto";
import { type GenerateTemplateRequest, GenerateTemplateRequestSchema, type TemplateTask } from "@tagpress/domain";
import { withAiJob } from "../adapters/ai-gateway.ts";
import { requireAccess } from "../org/access.ts";
import { maintenance } from "../org/context.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { AiErrorLike, Ports } from "../ports.ts";
import type { Clock } from "../util/clock.ts";
import { errorMessage, fail } from "../util/errors.ts";
import type { CostService } from "./costs.ts";
import type { KeyGuard } from "./key-guard.ts";
import type { ProfileService } from "./profiles.ts";
import type { TemplateService } from "./templates.ts";
import { DEFAULT_MAX_CONCURRENCY, FairScheduler } from "./generation/fair.ts";
import type { TrialService } from "./trial/service.ts";

/**
 * Temadan şablon üretim görevleri (iş/sipariş gerektirmez). Bir firmanın görevleri sırayla, tek tek çalışır (firmalar
 * arasında adil sıra, kurulum genelinde en çok `maxConcurrency`; her görev kendi firmasının bağlamında) ve SQLite'ta
 * tutulur (kalıcı). Sunucu yeniden başlarsa yarım kalanlar (`queued`/`running`) `interrupted` (kesildi) olur; üretilmiş şablonlar kütüphanede kalır. Bitince şablon
 * `kind: generated` olarak eklenir; şablon servisi SSE `template` olayını yayar.
 */
export class TemplateTaskService {
  private readonly scheduler: FairScheduler;

  constructor(
    private readonly d: {
      db: TenantDb;
      keyGuard?: KeyGuard;
      ports: Ports;
      templates: TemplateService;
      profiles: ProfileService;
      costs: CostService;
      trials: TrialService;
      clock: Clock;
      /** Kurulum genelinde aynı anda çalışan en çok görev (varsayılan 4). */
      maxConcurrency?: () => number;
    },
  ) {
    this.scheduler = new FairScheduler({ maxTotal: () => d.maxConcurrency?.() ?? DEFAULT_MAX_CONCURRENCY, maxPerOrg: () => 1 });
    // Önceki oturumdan kalan yarım görevler (bütün firmalar; kurulum geneli bakım): arka plan işi artık yok.
    const now = d.clock.now().toISOString();
    maintenance(
      () =>
        d.db.maintenance
          .prepare("UPDATE template_tasks SET status = 'interrupted', error = ?, updated_at = ? WHERE status IN ('queued', 'running')")
          .run("Sunucu yeniden başlatıldığı için görev kesildi.", now),
      "şablon görevi kurtarma",
    );
  }

  get(id: string): TemplateTask {
    const r = this.d.db.prepare("SELECT * FROM template_tasks WHERE id = ? AND org_id = $org").get(id) as Row | undefined;
    if (!r) throw fail("template-task-not-found");
    return fromRow(r);
  }

  private save(t: TemplateTask): void {
    this.d.db
      .prepare(
        `INSERT INTO template_tasks (org_id, id, language_id, status, theme, template_key, error, cost_usd, sample_png, created_at, updated_at)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, template_key = excluded.template_key, error = excluded.error,
           cost_usd = excluded.cost_usd, sample_png = excluded.sample_png, updated_at = excluded.updated_at
         WHERE template_tasks.org_id = $org`,
      )
      .run(t.id, t.languageId, t.status, t.theme, t.key, t.error, t.costUsd, t.samplePng, t.createdAt, t.updatedAt);
  }

  enqueue(languageId: string, input: GenerateTemplateRequest): TemplateTask {
    const req = GenerateTemplateRequestSchema.parse(input);
    // Ücretli görev: platform izni (`spend`; `org/access.ts`).
    requireAccess("spend");
    // Dil aynı firmada olmalı (başka firmanın diline görev açılmaz).
    if (!this.d.db.prepare("SELECT 1 FROM languages WHERE id = ? AND org_id = $org").get(languageId)) throw fail("language-not-found");
    this.d.keyGuard?.require("gemini");
    if (!this.d.ports.imageGenerator) throw fail("image-generator-unavailable");
    if (req.key && this.d.templates.find(languageId, req.key)) throw fail("template-exists", { key: req.key });
    const now = this.d.clock.now().toISOString();
    const task: TemplateTask = { id: randomUUID(), languageId, status: "queued", theme: req.theme, key: null, error: null, costUsd: null, samplePng: null, createdAt: now, updatedAt: now };
    this.save(task);
    void this.scheduler.submit(this.d.db.orgId("template-tasks.enqueue"), () => this.run(task, req).catch(() => undefined));
    return { ...task };
  }

  /** Testler ve kapanış: bütün görevler (bütün firmalar) bitene kadar bekler. */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  private set(task: TemplateTask, patch: Partial<TemplateTask>): void {
    Object.assign(task, patch, { updatedAt: this.d.clock.now().toISOString() });
    this.save(task);
  }

  private async run(task: TemplateTask, req: ReturnType<typeof GenerateTemplateRequestSchema.parse>): Promise<void> {
    const gen = this.d.ports.imageGenerator;
    let cost = 0;
    const record = (calls: AiErrorLike["calls"]) => {
      for (const c of calls ?? []) cost += this.d.costs.record({ ...c, purpose: `sablon-${c.purpose}` }, { languageId: task.languageId, taskId: task.id }).costUsd ?? 0;
    };
    this.set(task, { status: "running" });
    try {
      if (!gen) throw new Error("Görüntü üretimi bağlı değil.");
      const { profile } = this.d.profiles.activeProfile(task.languageId);
      const box = profile.output.templateBox;
      const side = Math.round(Math.max(box.w, box.h) * 2);
      // Geçit: görevin bütün çağrıları tek istek zincirinde, arka plan işi, amaç `tagpress.sablon_*`.
      const r = await withAiJob({ requestId: `sablon-${task.id}`, origin: "job", purposePrefix: "sablon" }, () =>
        gen.newTemplate({ jobId: task.id, theme: req.theme, profile, width: side, height: side, log: () => undefined }),
      );
      record(r.calls);
      const key = req.key ?? `uretilen-${task.id.slice(0, 8)}`;
      const { item } = await this.d.templates.upload(task.languageId, {
        key,
        fileName: `${key}.png`,
        png: r.png,
        kind: "generated",
        extra: {
          generatedFrom: { prompt: r.prompt, model: r.model, at: this.d.clock.now().toISOString() },
          notes: req.theme,
          tags: req.keep ? ["uretilen"] : ["uretilen", "gecici"],
        },
      });
      let samplePng: string | null = null;
      if (req.sampleText) {
        try {
          samplePng = (await this.d.trials.templateTry(task.languageId, item.template.key, { text: req.sampleText })).png;
        } catch {
          samplePng = null; // önizleme olmasa da şablon üretildi
        }
      }
      this.set(task, { status: "done", key: item.template.key, samplePng, costUsd: cost });
    } catch (err) {
      record((err as AiErrorLike)?.calls);
      this.set(task, { status: "failed", error: errorMessage(err), costUsd: cost });
    }
  }
}

interface Row {
  [k: string]: unknown;
}

function fromRow(r: Row): TemplateTask {
  return {
    id: r.id as string,
    languageId: r.language_id as string,
    status: r.status as TemplateTask["status"],
    theme: r.theme as string,
    key: (r.template_key as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    samplePng: (r.sample_png as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
