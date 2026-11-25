import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AiProvider, DesignIntent, GenerateRequest, GenerateResponse, Skipped, Template } from "@tagpress/domain";
import { GenerateRequestSchema, fixMsg, issueMsg } from "@tagpress/domain";
import { AiBusyError } from "../../adapters/ai-busy.ts";
import { withAiJob } from "../../adapters/ai-gateway.ts";
import type { DataPaths } from "../../config.ts";
import { json } from "../../db/database.ts";
import { requireFeature } from "../../features/service.ts";
import { requireAccess } from "../../org/access.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { AiErrorLike, Ports } from "../../ports.ts";
import { errorMessage, fail } from "../../util/errors.ts";
import type { CostService } from "../costs.ts";
import { BLOCKING } from "../import/service.ts";
import { stickerSheetId } from "../import/rows.ts";
import type { JobRow } from "../jobs/mapping.ts";
import { jobIssues } from "../jobs/mapping.ts";
import type { JobService } from "../jobs/service.ts";
import type { KeyGuard } from "../key-guard.ts";
import type { ProfileService } from "../profiles.ts";
import type { SettingsService } from "../settings.ts";
import type { TemplateService } from "../templates.ts";
import type { VariantService } from "../variants.ts";
import { generateTemplate, runImageOnTemplate } from "./image-flow.ts";
import type { ProgressLog } from "./progress.ts";
import { type GenTask, type GenerationQueue, MAX_ATTEMPTS, TaskRequeue } from "./queue.ts";
import { GenerationError, TargetResolver } from "./target.ts";
import { runTextFlow } from "./text-flow.ts";

/** Moda göre gereken sağlayıcı anahtarları: metin → Claude; görüntü → Gemini; temadan şablon → ikisi. */
function keysFor(mode: GenerateRequest["mode"]): AiProvider[] {
  return mode === "text" ? ["anthropic"] : mode === "image-on-template" ? ["gemini"] : ["anthropic", "gemini"];
}

const RUN_CODES =["ai-failed", "ai-no-good-candidate", "no-layout", "font-unavailable"] as const;

/** Geçit `retry-after` vermediyse yoğunlukta bekleme; verdiyse o (en çok 5 dk). */
const BUSY_DEFAULT_WAIT_MS = 30_000;
const BUSY_MAX_WAIT_MS = 5 * 60_000;
const busyDelayMs = (suggested: number | undefined) => Math.min(BUSY_MAX_WAIT_MS, Math.max(0, suggested ?? BUSY_DEFAULT_WAIT_MS));

interface Deps {
  db: TenantDb;
  paths: DataPaths;
  ports: Ports;
  jobs: JobService;
  variants: VariantService;
  templates: TemplateService;
  profiles: ProfileService;
  settings: SettingsService;
  costs: CostService;
  progress: ProgressLog;
  queue: GenerationQueue;
  /** Anahtar ön denetimi (yoksa denetlenmez). */
  keyGuard?: KeyGuard;
}

/**
 * Üretim: kuyruğa alma ön denetimi + görev çalıştırıcısı. Akış portlar üzerinden yürür; hangi port eksikse
 * iş açık bir mesajla kuyruğa alınmaz. Hata: iş "failed" (varyasyonu yoksa) + `ai-failed` sorunu; çağrılar
 * ve maliyet yine kaydedilir.
 */
export class GenerationService {
  private readonly targets: TargetResolver;

  constructor(private readonly d: Deps) {
    this.targets = new TargetResolver(d.ports, d.templates);
    d.queue.setRunner((t) => this.run(t));
  }

  enqueue(input: GenerateRequest, revision?: { fromVariantId: string; request: string }): GenerateResponse {
    const req = GenerateRequestSchema.parse(input);
    // Ücretli üretim platform izni ister (`spend`: yapay zekâ + iş düzenleme). Uç kapısından bağımsız: içe aktarma ve elle
    // iş (`generate: true`) de buradan geçer (R1).
    if (req.jobIds.length) requireAccess("spend");
    // Görüntü kipleri firmada açık olmalı (kapalıysa 409 feature-off; kuyruktaki görevler biter).
    if (req.mode !== "text") requireFeature(this.d.settings, req.mode === "image-on-template" ? "image.onTemplate" : "image.themeTemplate");
    // Anahtar yoksa iş kuyruğa alınmaz: açık hata (409 missing-key).
    if (req.jobIds.length) this.d.keyGuard?.require(...keysFor(req.mode));
    const skipped: Skipped[] = [];
    const items: Parameters<GenerationQueue["enqueue"]>[0] = [];
    const missing = this.missingFor(req.mode);
    for (const id of req.jobIds) {
      const job = this.d.jobs.row(id);
      const reason = !job
        ? "İş bulunamadı."
        : missing
          ? missing
          : this.blocking(job, req.mode);
      if (reason) skipped.push({ id, reason });
      else items.push({ jobId: id, mode: req.mode, params: { theme: req.theme, keepTemplate: req.keepTemplate, ...(revision && { revision }) } });
    }
    const r = this.d.queue.enqueue(items);
    return { queued: r.queued, skipped: [...skipped, ...r.skipped] };
  }

  /** "Şunu değiştir": kaynak varyasyon kalır, aynı türde yeni varyasyon üretilir. */
  revise(variantId: string, request: string): GenerateResponse {
    const v = this.d.variants.require(variantId);
    const mode = v.kind === "generated-template" ? "text" : v.kind;
    return this.enqueue({ jobIds: [v.job_id], mode }, { fromVariantId: variantId, request });
  }

  /** Bu modda üretim için eksik port (yoksa null). */
  missingFor(mode: GenerateRequest["mode"]): string | null {
    const p = this.d.ports;
    if (!p.geometry) return "Şablon geometrisi (templates paketi) bağlı değil.";
    if (mode !== "image-on-template" && (!p.designer || !p.engine)) return "AI tasarımcı ya da yerleşim motoru bağlı değil.";
    if (mode !== "text" && !p.imageGenerator) return "Görüntü üretimi bağlı değil.";
    return null;
  }

  private blocking(job: JobRow, mode: GenerateRequest["mode"]): string | null {
    const block = jobIssues(job).find((i) => BLOCKING.has(i.code) && !(mode === "generated-template" && i.code.startsWith("template-")));
    if (block) return block.message;
    if (mode === "image-on-template" && (job.kind === "sticker" || stickerSheetId(job.template_key))) return "Sticker'da şablona yazma yapılamaz.";
    return null;
  }

  /** Kuyruğun görevi. Geçit: görevin bütün yapay zekâ çağrıları tek istek zincirinde (süren iş payı), arka plan işi. */
  run(task: GenTask): Promise<void> {
    return withAiJob({ requestId: `gen-${task.id}`, origin: "job" }, () => this.runTask(task));
  }

  private async runTask(task: GenTask): Promise<void> {
    const job = this.d.jobs.row(task.jobId);
    if (!job) return; // silinmiş
    const log = (step: string, message: string) => this.d.progress.push(job.id, task.id, step, message);
    const record = (call: Parameters<CostService["record"]>[0]) => this.d.costs.record(call, { jobId: job.id, taskId: task.id, languageId: job.language_id }).costUsd;
    try {
      log("context", task.attempts > 1 ? `Üretim yeniden başlıyor (deneme ${task.attempts})` : "Bağlam hazırlanıyor");
      const { profile, version } = this.d.profiles.activeProfile(job.language_id);
      const settings = this.d.settings.get();
      const revision = task.params.revision ?? null;
      let saved: string[] = [];
      if (task.mode === "image-on-template") {
        const gen = this.require(this.d.ports.imageGenerator, "Görüntü üretimi");
        const target = await this.targets.resolve(job, profile, version);
        // Revizyonda kaynak varyasyonun görseli de modele gider ("şunu değiştir").
        const source = revision ? this.d.variants.row(revision.fromVariantId, true) : null;
        const sourceFile = source ? this.d.variants.previewPath(source) : null;
        const currentPng = sourceFile && existsSync(sourceFile) ? await readFile(sourceFile) : null;
        saved = [await this.d.variants.create({ jobId: job.id, ...(await runImageOnTemplate(gen, { job, profile, profileVersion: version, target, revision, currentPng, record, log })) })];
      } else {
        let override: Template | undefined;
        if (task.mode === "generated-template") {
          const gen = this.require(this.d.ports.imageGenerator, "Görüntü üretimi");
          const theme = task.params.theme?.trim();
          if (!theme) throw new GenerationError("Temadan şablon üretmek için tema/tarif yazın.");
          const base = job.template_key ? this.d.templates.find(job.language_id, job.template_key) : null;
          const box = profile.output.templateBox;
          const size = base ? { width: base.width, height: base.height } : { width: Math.round(box.w * 2), height: Math.round(box.h * 2) };
          override = (await generateTemplate(gen, this.d.templates, { job, profile, profileVersion: version, record, log, theme, keep: task.params.keepTemplate !== false, base: size })).template;
        }
        const target = await this.targets.resolve(job, profile, version, override);
        const fromIntent = revision ? json<DesignIntent | null>(this.d.variants.row(revision.fromVariantId, true)?.intent, null) : null;
        const drafts = await runTextFlow(this.require(this.d.ports.designer, "AI tasarımcı"), this.require(this.d.ports.engine, "Yerleşim motoru"), {
          job,
          profile,
          profileVersion: version,
          target,
          kind: task.mode,
          previous: this.d.variants.previousIntents(job.id),
          revision: revision ? { ...revision, intent: fromIntent } : null,
          variantsPerRun: settings.variantsPerRun,
          fontsDir: this.d.paths.fonts(job.language_id),
          record,
          log,
        });
        for (const v of drafts) saved.push(await this.d.variants.create({ jobId: job.id, ...v }));
      }
      if (saved[0]) this.d.db.prepare("UPDATE ai_calls SET variant_id = ? WHERE task_id = ? AND org_id = $org AND variant_id IS NULL").run(saved[0], task.id);
      this.d.jobs.setRunIssues(job.id, [...RUN_CODES], []);
      this.d.db.prepare("UPDATE jobs SET error = NULL WHERE id = ? AND org_id = $org").run(job.id);
      log("done", saved.length === 1 ? "Varyasyon hazır" : `${saved.length} varyasyon hazır`);
    } catch (err) {
      const calls = (err as AiErrorLike)?.calls;
      if (Array.isArray(calls)) for (const c of calls) record(c);
      // Geçit yoğun (`sod_rate_limited`): görev bekleyip yeni bir istekle yeniden kuyruğa girer (deneme sınırına dek); iş başarısız sayılmaz.
      if (err instanceof AiBusyError && task.attempts < MAX_ATTEMPTS) {
        const wait = busyDelayMs(err.retryAfterMs);
        log("ai", `Yapay zekâ şu an yoğun; ${Math.max(1, Math.round(wait / 1000))} sn sonra yeniden denenecek (deneme ${task.attempts}/${MAX_ATTEMPTS})`);
        throw new TaskRequeue(wait);
      }
      const message = errorMessage(err);
      const code = err instanceof GenerationError ? err.code : "ai-failed";
      this.d.jobs.setRunIssues(job.id, [...RUN_CODES], [
        { ...issueMsg("generation-failed", { detail: message }), code, severity: "error", fixes: [fixMsg("retry")] },
      ]);
      const live = this.d.jobs.liveVariants(job.id).length;
      const current = this.d.jobs.row(job.id, true);
      if (current) this.d.jobs.setStatus(job.id, live ? current.status : "failed", message);
      log("error", message);
      throw err;
    }
  }

  private require<T>(port: T | null, name: string): T {
    if (!port) throw new GenerationError(`${name} bağlı değil.`);
    return port;
  }

  /** Yalnızca okuma: iş var mı (rotalar için). */
  ensureJob(id: string): void {
    if (!this.d.jobs.row(id)) throw fail("job-not-found");
  }
}
