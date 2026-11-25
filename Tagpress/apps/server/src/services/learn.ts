import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type LearnApplyResult,
  type LearnProposal,
  type LearnReplayRequest,
  type LearnRunRequest,
  type LearnRunStatus,
  type Profile,
  type Reference,
  type Template,
  type DesignIntent,
  TemplateSchema,
  type VariantSnapshot,
  API,
  apiPath,
  ptToPx,
} from "@tagpress/domain";
import {
  type AdjustObservation,
  type LearnProgress,
  type PatchChange,
  ReplayEnv,
  type TrialSide,
  engineTrial,
  getPath,
  measureStyle,
  pickRefs,
  runLearning,
  setPath,
  userPanel,
} from "@tagpress/learn";
import sharp from "sharp";
import type { DataPaths } from "../config.ts";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import { maintenance } from "../org/context.ts";
import { type TenantDb, insertOrder } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";
import { writeAtomic } from "../util/files.ts";
import { PNG, safeJoin } from "../util/safe-path.ts";
import { adjustSamples } from "./adjust.ts";
import { DEFAULT_MAX_CONCURRENCY, FairScheduler } from "./generation/fair.ts";
import type { ProfileService } from "./profiles.ts";
import { type LearnProposalService, type ReferenceService, referenceImageFile } from "./references.ts";
import type { DesignSessionService } from "./session.ts";
import type { TemplateService } from "./templates.ts";

/**
 * "Düzeltmelerimden öğren" sunucu tarafı: öğrenme koşusu (arka plan görevi + SSE ilerleme), önerilerin taslağa
 * uygulanması / reddi / geri alınması, ölçüm özeti, motor denemesi (AI'sız, ücretsiz) ve görseller.
 * Öğrenme mantığı `@tagpress/learn` paketinde; burada yalnızca veri yükleme, kayıt ve dosyalar.
 */

export interface LearnDeps {
  db: TenantDb;
  paths: DataPaths;
  profiles: ProfileService;
  templates: TemplateService;
  references: ReferenceService;
  proposals: LearnProposalService;
  sessions: DesignSessionService;
  events: EventBus;
  clock: Clock;
  /** Kurulum genelinde aynı anda çalışan en çok öğrenme koşusu (varsayılan 4; firmalar arasında adil sıra). */
  maxConcurrency?: () => number;
}

const PREVIEW_DIR = "ogrenme";
const SAFE = /^[a-z0-9][a-z0-9_.-]{0,120}$/i;
const safeName = (s: string) => s.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);

export class LearnService {
  /** Yalnızca çalışan koşular (canlı nesne); biten/kesilenler veritabanından okunur. */
  private readonly runs = new Map<string, LearnRunStatus>();
  private readonly cancels = new Map<string, boolean>();
  /** Tekrar ortamı (firma + dil anahtarlı: başka firmanın yolları kullanılmaz). */
  private env: { key: string; env: ReplayEnv } | null = null;
  /** Koşular kendi firmalarının bağlamında, firmalar arasında adil sırayla (kurulum genelinde en çok `maxConcurrency`). */
  private readonly scheduler: FairScheduler;
  /** Boşta kalan tekrar ortamı (geometri önbelleği, fontlar) bir süre sonra bırakılır: bellek kısıtlı. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Arka plandaki koşu (testler bekleyebilsin). */
  running: Promise<void> | null = null;

  constructor(private readonly d: LearnDeps) {
    // Firma başına ayrı sınır yok (dil başına zaten tek koşu); kurulum sınırı ve adil seçim geçerli.
    this.scheduler = new FairScheduler({ maxTotal: () => d.maxConcurrency?.() ?? DEFAULT_MAX_CONCURRENCY, maxPerOrg: () => 1 });
    // Önceki oturumdan kalan yarım koşular (bütün firmalar; kurulum geneli bakım): arka plan işi artık yok.
    maintenance(
      () =>
        d.db.maintenance
          .prepare("UPDATE learn_runs SET status = 'interrupted', error = ?, finished_at = ?, message = ? WHERE status = 'running'")
          .run("Sunucu yeniden başlatıldığı için öğrenme kesildi.", d.clock.now().toISOString(), "Kesildi"),
      "öğrenme kurtarma",
    );
  }

  // ------------------------------------------------------------ veri

  /** Taslak ya da yayınlanmış profil. */
  profile(languageId: string, source: "draft" | "published" = "published"): { profile: Profile; version: number; source: "draft" | "published" } {
    if (source === "draft") {
      const dr = this.d.profiles.draft(languageId);
      if (dr) return { profile: dr.data, version: dr.version, source: "draft" };
    }
    const a = this.d.profiles.activeProfile(languageId);
    return { ...a, source: "published" };
  }

  templateList(languageId: string): Template[] {
    return this.d.templates.list(languageId).flatMap((i) => {
      const r = TemplateSchema.safeParse(i.template);
      return r.success ? [r.data] : [];
    });
  }

  refs(languageId: string): Reference[] {
    return this.d.references.list({ languageId });
  }

  /**
   * Uygulamadaki geçerli hafif düzeltmeler (öğrenme girdisi): `adjust_log` + varyasyonun metni ve niyeti (motorla
   * önce/sonra ölçümü için) + düzeltilmiş önizleme adresi. Şablon başına onay sayıları yalnızca açıklama içindir.
   */
  adjustInput(languageId: string): { observations: AdjustObservation[]; usage: Map<string, { approved: number; adjusted: number }> } {
    const samples = adjustSamples(this.d.db, languageId);
    const variants = new Map<string, { intent: string | null; snapshot: string; no: number; adjust_rev: number }>();
    const read = this.d.db.prepare("SELECT intent, snapshot, no, adjust_rev FROM variants WHERE id = ? AND org_id = $org");
    for (const s of samples) {
      const row = read.get(s.variantId) as { intent: string | null; snapshot: string; no: number; adjust_rev: number } | undefined;
      if (row) variants.set(s.variantId, row);
    }
    const observations = samples.map((s): AdjustObservation => {
      const v = variants.get(s.variantId);
      const intent = v ? json<DesignIntent | null>(v.intent, null) : null;
      const text = v ? json<Partial<VariantSnapshot>>(v.snapshot, {}).text : undefined;
      return {
        id: s.variantId,
        jobId: s.jobId,
        templateKey: s.templateKey,
        framePx: s.framePx,
        target: { x: s.target.x, y: s.target.y },
        inkBefore: s.inkBefore,
        inkAfter: s.inkAfter,
        scale: s.adjust.scale,
        createdAt: s.createdAt,
        // Elle metin/font düzenlemesi varsa motorun özgün niyetle tekrarı aynı yazıyı vermez: önce/sonra ölçülmez.
        replay: intent && typeof text === "string" && !s.adjust.edits?.length ? { text, intent } : null,
        ...(v ? { previewUrl: `${apiPath(API.variantPreview, { id: s.variantId })}?v=${v.no}${v.adjust_rev ? `.${v.adjust_rev}` : ""}` } : {}),
      };
    });
    const usage = new Map<string, { approved: number; adjusted: number }>();
    const keys = [...new Set(samples.map((s) => s.templateKey).filter((k): k is string => !!k))];
    if (keys.length) {
      const rows = this.d.db
        .prepare(
          `SELECT j.template_key AS k, COUNT(*) AS approved, SUM(CASE WHEN v.adjust IS NOT NULL THEN 1 ELSE 0 END) AS adjusted
           FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org JOIN variants v ON v.id = j.approved_variant_id AND v.org_id = $org
           WHERE j.org_id = $org AND b.language_id = ? AND j.template_key IN (${keys.map(() => "?").join(",")}) GROUP BY j.template_key`,
        )
        .all(languageId, ...keys) as Array<{ k: string; approved: number; adjusted: number | null }>;
      for (const r of rows) usage.set(r.k, { approved: r.approved, adjusted: r.adjusted ?? 0 });
    }
    return { observations, usage };
  }

  private envFor(languageId: string): ReplayEnv {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Zamanlayıcı isteğin bağlamını taşımaz (bakım kapsamında kurulur; geri çağırma veritabanına dokunmaz).
    this.idleTimer = maintenance(
      () =>
        setTimeout(() => {
          if (this.running) return;
          this.env?.env.clear();
          this.env = null;
        }, 10 * 60_000),
      "öğrenme ortamı boşaltma",
    );
    this.idleTimer.unref();
    const key = `${this.d.db.orgId("learn.env")}:${languageId}`;
    if (this.env?.key !== key) {
      this.env?.env.clear();
      this.env = {
        key,
        env: new ReplayEnv({
          fontDir: this.d.paths.fonts(languageId),
          fallbackDirs: [this.d.paths.sharedFonts],
          templatePath: (t) => this.d.templates.imagePath(languageId, t),
          referenceImagePath: (r) => this.referenceImagePath(r),
        }),
      };
    }
    return this.env.env;
  }

  /** Referans görseli: yalnız geçerli firmanın, dilin referans klasöründeki PNG (`referenceImageFile`; başka dosya asla). */
  referenceImagePath(ref: Reference): string | null {
    const file = referenceImageFile(this.d.paths.root, ref);
    return file && existsSync(file) ? file : null;
  }

  // ------------------------------------------------------------ öğrenme koşusu

  latestRun(languageId: string): LearnRunStatus | null {
    const row = this.d.db.prepare(`SELECT * FROM learn_runs WHERE org_id = $org AND language_id = ? ORDER BY started_at DESC, ${insertOrder(this.d.db)} DESC LIMIT 1`).get(languageId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.runs.get(row.id as string) ?? runFromRow(row);
  }

  private saveRun(s: LearnRunStatus): void {
    this.d.db
      .prepare(
        `INSERT INTO learn_runs (org_id, id, language_id, status, base, profile_version, step, done, total, message, started_at, finished_at, error, result)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, step = excluded.step, done = excluded.done, total = excluded.total,
           message = excluded.message, finished_at = excluded.finished_at, error = excluded.error, result = excluded.result
         WHERE learn_runs.org_id = $org`,
      )
      .run(s.id, s.languageId, s.status, s.base, s.profileVersion, s.step, s.done, s.total, s.message, s.startedAt, s.finishedAt, s.error, s.result ? JSON.stringify(s.result) : null);
  }

  run(languageId: string, req: LearnRunRequest = {}): LearnRunStatus {
    if (!this.d.db.prepare("SELECT 1 FROM languages WHERE id = ? AND org_id = $org").get(languageId)) throw fail("language-not-found");
    const cur = this.latestRun(languageId);
    if (cur?.status === "running") throw fail("learn-running");
    // Yüklenen örnekten gelen (`quality` alanlı) referanslar öğrenme koşusuna girmez: koşu bu alanları okumaz.
    const refs = this.refs(languageId).filter((r) => r.quality === undefined);
    if (!refs.length && !adjustSamples(this.d.db, languageId).length)
      throw fail("learn-nothing");
    const base = this.profile(languageId, req.base ?? "draft");
    const id = randomUUID();
    const status: LearnRunStatus = {
      id,
      languageId,
      status: "running",
      base: base.source,
      profileVersion: base.version,
      step: "fark",
      done: 0,
      total: 1,
      message: "Başlıyor",
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      result: null,
    };
    this.runs.set(id, status);
    // Eski koşu kayıtları: dil başına en yeni 20 kalır.
    this.d.db
      .prepare(
        `DELETE FROM learn_runs WHERE org_id = $org AND language_id = ? AND id NOT IN (SELECT id FROM learn_runs WHERE learn_runs.org_id = $org AND language_id = ? ORDER BY started_at DESC, ${insertOrder(this.d.db)} DESC LIMIT 19)`,
      )
      .run(languageId, languageId);
    this.emitRun(status);
    const p = this.scheduler.submit(this.d.db.orgId("learn.run"), () => this.execute(status, base.profile, refs, req)).finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return { ...status };
  }

  /** Bütün koşuları (bütün firmalar) durdurur ve bitmelerini bekler (kapanış). */
  async stopAll(): Promise<void> {
    for (const r of this.runs.values()) if (r.status === "running") this.cancels.set(r.id, true);
    await this.scheduler.idle();
  }

  cancel(languageId: string): LearnRunStatus | null {
    const cur = this.latestRun(languageId);
    if (cur?.status === "running") this.cancels.set(cur.id, true);
    return cur;
  }

  private async execute(status: LearnRunStatus, profile: Profile, refs: Reference[], req: LearnRunRequest): Promise<void> {
    const languageId = status.languageId;
    let lastEmit = 0;
    const onProgress = (p: LearnProgress) => {
      const stepChanged = p.step !== status.step;
      Object.assign(status, { step: p.step, done: p.done, total: p.total, message: p.message });
      const t = Date.now();
      if (stepChanged || t - lastEmit > 400 || p.done === p.total) {
        lastEmit = t;
        this.emitRun(status);
      }
    };
    try {
      const res = await runLearning({
        profile,
        templates: this.templateList(languageId),
        refs,
        env: this.envFor(languageId),
        thresholds: {
          ...(req.minProfile ? { minProfile: req.minProfile } : {}),
          ...(req.minTemplate ? { minTemplate: req.minTemplate } : {}),
          ...(req.minCenter ? { minCenter: req.minCenter } : {}),
          ...(req.minAdjust ? { minAdjust: req.minAdjust } : {}),
          ...(req.minAdjustJobs ? { minAdjustJobs: req.minAdjustJobs } : {}),
          ...(req.minAdjustShift ? { minAdjustShift: req.minAdjustShift } : {}),
          ...(req.minAdjustAgreement ? { minAdjustAgreement: req.minAdjustAgreement } : {}),
        },
        adjust: this.adjustInput(languageId),
        onProgress,
        cancelled: () => this.cancels.get(status.id) === true,
      });
      // Aynı karar için önceki AÇIK öneri yenisiyle değiştirilir (karara bağlanmışlar kalır).
      const open = this.d.proposals.list({ languageId, status: "open" });
      const created: string[] = [];
      for (const p of res.proposals) {
        for (const old of open) if ((old.evidence as { slug?: string } | null)?.slug === p.slug) this.d.proposals.remove(old.id);
        const previews: Array<{ referenceId: string; file: string; url: string }> = [];
        for (const v of p.previews) {
          const file = `${safeName(p.slug)}-${safeName(v.referenceId)}.png`;
          await writeAtomic(path.join(this.d.paths.previews, PREVIEW_DIR, status.id, file), v.png);
          previews.push({ referenceId: v.referenceId, file, url: `/api/learn/previews/${status.id}/${file}` });
        }
        // AI ayarının özeti "yalnızca gerçek denemeyle ölçülür" der zaten; aynı gerekçe ikinci kez eklenmez.
        const weak = p.evidence.weak && p.evidence.kind !== "ai" ? ` · Kanıt zayıf: ${p.evidence.reason}` : "";
        const prop = this.d.proposals.create({
          languageId,
          title: p.title,
          summary: `${p.summary}${weak}`,
          patch: p.patch,
          evidence: { ...p.evidence, previews, runId: status.id, profileVersion: status.profileVersion },
        });
        created.push(prop.id);
      }
      Object.assign(status, {
        status: "done",
        step: "bitti",
        done: 1,
        total: 1,
        message: `${created.length} öneri hazır${res.dropped.length ? `, ${res.dropped.length} öneri ayrılmış kümede kötüleştirdiği için düşürüldü` : ""}.`,
        finishedAt: this.now(),
        result: { proposals: created, dropped: res.dropped, findings: res.findings, baseline: res.baseline, counts: res.counts, ms: res.ms },
      });
      this.prunePreviews();
    } catch (err) {
      const cancelled = this.cancels.get(status.id) === true;
      Object.assign(status, { status: cancelled ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), finishedAt: this.now() });
    } finally {
      this.cancels.delete(status.id);
      this.runs.delete(status.id);
      this.emitRun(status);
    }
  }

  private emitRun(s: LearnRunStatus): void {
    this.saveRun(s);
    this.d.events.emit({ type: "learn", languageId: s.languageId, runId: s.id, status: s.status, step: s.step, done: s.done, total: s.total });
  }

  /** Eski koşuların önizleme klasörleri: en yeni 10 kalır. */
  private prunePreviews(): void {
    const dir = path.join(this.d.paths.previews, PREVIEW_DIR);
    if (!existsSync(dir)) return;
    const runs = readdirSync(dir)
      .map((n) => ({ n, t: statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const r of runs.slice(10)) rmSync(path.join(dir, r.n), { recursive: true, force: true });
  }

  previewPath(dir: string, file: string): string {
    if (!SAFE.test(dir) || !SAFE.test(file)) throw fail("preview-not-found");
    const p = safeJoin(path.join(this.d.paths.previews, PREVIEW_DIR), `${dir}/${file}`, { ext: PNG });
    if (!p || !existsSync(p)) throw fail("preview-not-found");
    return p;
  }

  // ------------------------------------------------------------ öneriyi uygula / reddet / geri al

  apply(id: string): LearnApplyResult {
    const p = this.d.proposals.get(id);
    if (p.status !== "open") throw fail("proposal-decided");
    const changes = readChanges(p.patch);
    if (!changes.length) throw fail("proposal-empty");
    const languageId = p.languageId;
    const before: { profile: Record<string, unknown>; templates: Record<string, Record<string, unknown>> } = { profile: {}, templates: {} };
    let draft = null;
    const prof = changes.filter((c) => c.target === "profile");
    if (prof.length) {
      const base = this.d.profiles.draft(languageId) ?? this.d.profiles.active(languageId);
      let data: unknown = base?.data ?? {};
      for (const c of prof) {
        before.profile[c.path] = getPath(data, c.path) ?? null;
        data = setPath(data, c.path, c.to);
      }
      draft = this.d.profiles.saveDraft(languageId, data, `Öğrenme: ${p.title}`.slice(0, 500));
      this.d.events.emit({ type: "profile", languageId, version: draft.version });
    }
    const touched: string[] = [];
    const evidence = (p.evidence ?? {}) as { count?: number };
    for (const c of changes) {
      if (c.target !== "template") continue;
      const cur = this.d.templates.find(languageId, c.key);
      if (!cur) throw fail("template-key-not-found", { key: c.key });
      before.templates[c.key] = { ...(before.templates[c.key] ?? {}), [c.field]: cur[c.field] ?? null };
      this.d.templates.update(languageId, c.key, {
        [c.field]: c.to,
        provenance: [...cur.provenance, { field: c.field, source: "learned", ...(evidence.count ? { samples: evidence.count } : {}), at: this.now() }],
      });
      if (!touched.includes(c.key)) touched.push(c.key);
    }
    this.setEvidence(id, { ...(p.evidence as object), applied: { at: this.now(), before, draftVersion: draft?.version ?? null } });
    const proposal = this.d.proposals.update(id, { status: "accepted" });
    this.d.sessions.add(languageId, { kind: "note", text: `Öğrenme önerisi uygulandı: ${p.title}`, paths: changes.map((c) => c.path) });
    return { proposal, draft, templates: touched };
  }

  reject(id: string): LearnProposal {
    const p = this.d.proposals.get(id);
    if (p.status === "accepted") throw fail("proposal-accepted");
    return this.d.proposals.update(id, { status: "rejected" });
  }

  /**
   * Uygulanmış öneriyi geri alır: şablon alanları önceki değerlerine döner; taslakta değer hâlâ önerinin yazdığıysa
   * önceki değerine döner (sonradan elle değiştirilmişse dokunulmaz). Öneri yeniden "açık" olur.
   */
  revert(id: string): LearnApplyResult {
    const p = this.d.proposals.get(id);
    if (p.status !== "accepted") {
      if (p.status === "rejected") return { proposal: this.d.proposals.update(id, { status: "open" }), draft: null, templates: [] };
      throw fail("proposal-not-applied");
    }
    const ev = (p.evidence ?? {}) as { applied?: { before: { profile: Record<string, unknown>; templates: Record<string, Record<string, unknown>> } } };
    const before = ev.applied?.before;
    if (!before) throw fail("proposal-no-record");
    const languageId = p.languageId;
    const changes = readChanges(p.patch);
    let draft = null;
    const base = this.d.profiles.draft(languageId) ?? this.d.profiles.active(languageId);
    if (base && Object.keys(before.profile).length) {
      let data: unknown = base.data;
      let changed = false;
      for (const c of changes) {
        if (c.target !== "profile" || !(c.path in before.profile)) continue;
        if (JSON.stringify(getPath(data, c.path)) !== JSON.stringify(c.to)) continue;
        data = setPath(data, c.path, before.profile[c.path]);
        changed = true;
      }
      if (changed) {
        draft = this.d.profiles.saveDraft(languageId, data, `Öğrenme geri alındı: ${p.title}`.slice(0, 500));
        this.d.events.emit({ type: "profile", languageId, version: draft.version });
      }
    }
    const touched: string[] = [];
    for (const [key, fields] of Object.entries(before.templates)) {
      const cur = this.d.templates.find(languageId, key);
      if (!cur) continue;
      this.d.templates.update(languageId, key, {
        ...fields,
        provenance: [...cur.provenance, ...Object.keys(fields).map((field) => ({ field, source: "user" as const, at: this.now() }))],
      });
      touched.push(key);
    }
    const { applied: _a, ...rest } = ev as Record<string, unknown>;
    this.setEvidence(id, rest);
    const proposal = this.d.proposals.update(id, { status: "open" });
    return { proposal, draft, templates: touched };
  }

  private setEvidence(id: string, evidence: unknown): void {
    this.d.db.prepare("UPDATE learn_proposals SET evidence = ? WHERE id = ? AND org_id = $org").run(JSON.stringify(evidence ?? null), id);
  }

  // ------------------------------------------------------------ ölçüm, örnekler, motor denemesi

  measure(languageId: string, source: "draft" | "published" = "published") {
    const { profile, version } = this.profile(languageId, source);
    return { source, profileVersion: version, measurement: measureStyle(this.refs(languageId), profile, this.templateList(languageId)) };
  }

  samples(languageId: string, q: { limit?: number; template?: string; split?: "train" | "test"; w?: number }) {
    const { profile } = this.profile(languageId, "published");
    const pt = (px: number) => Math.round((px / ptToPx(profile, 1)) * 10) / 10;
    let refs = this.refs(languageId).filter((r) => (!q.template || r.templateKey === q.template) && (!q.split || r.split === q.split));
    const total = refs.length;
    refs = pickRefs(refs, Math.max(1, Math.min(q.limit ?? 12, 60)));
    const w = q.w ?? 320;
    return {
      total,
      samples: refs.map((r) => ({
        id: r.id,
        text: r.text,
        templateKey: r.templateKey,
        split: r.split,
        orderNo: r.orderNo,
        labelFramePx: r.labelFramePx,
        lines: r.user.map((l) => ({
          text: l.text,
          font: `${l.family}/${l.style}`,
          sizePx: Math.round(l.sizePx * 10) / 10,
          pt: pt(l.sizePx),
          segments: l.segments.filter((s) => s.text.trim() && (s.family !== l.family || s.style !== l.style)).map((s) => ({ text: s.text, font: `${s.family}/${s.style}`, sizePx: Math.round(s.sizePx * 10) / 10 })),
        })),
        program: r.program?.map((l) => l.text) ?? null,
        imageUrl: r.image ? `/api/learn/references/${encodeURIComponent(r.id)}/thumb.png?template=1&w=${w}` : null,
      })),
    };
  }

  async replay(languageId: string, req: LearnReplayRequest) {
    const sides: TrialSide[] = [];
    const templates = new Map(this.templateList(languageId).map((t) => [t.key, t]));
    const want = req.source === "both" ? (["published", "draft"] as const) : ([req.source] as const);
    for (const s of want) {
      const p = this.profile(languageId, s);
      if (s === "draft" && p.source !== "draft" && req.source === "both") continue;
      sides.push({ label: p.source === "draft" ? `Taslak (v${p.version})` : `Yayınlanan (v${p.version})`, profile: p.profile, templates });
    }
    const env = this.envFor(languageId);
    const base = sides[0]!.profile;
    // Motor tekrarı da `quality` alanlı (yüklenen örnekten) referansı kullanmaz (kutular/puntolar ölçülmemiş olabilir).
    let refs = this.refs(languageId).filter((r) => r.quality === undefined && (req.split === "all" || r.split === req.split) && (!req.template || r.templateKey === req.template));
    refs = pickRefs(env.replayable(refs, base, templates), req.limit);
    if (!refs.length) throw fail("replay-no-references");
    const res = await engineTrial(env, refs, sides, { previews: req.previews });
    const id = `deneme-${randomUUID().slice(0, 8)}`;
    const previews: Array<{ referenceId: string; url: string }> = [];
    for (const v of res.previews) {
      const file = `${safeName(v.referenceId)}.png`;
      await writeAtomic(path.join(this.d.paths.previews, PREVIEW_DIR, id, file), v.png);
      previews.push({ referenceId: v.referenceId, url: `/api/learn/previews/${id}/${file}` });
    }
    this.prunePreviews();
    return {
      refs: res.refs.length,
      split: req.split,
      sides: res.sides.map((s) => ({
        label: s.label,
        metrics: s.metrics,
        summary: s.summary,
        worst: s.perRef
          .filter((m) => !m.ok || !m.within10)
          .sort((a, b) => Math.abs((b.sizeRatio || 9) - 1) - Math.abs((a.sizeRatio || 9) - 1))
          .slice(0, 8)
          .map((m) => ({ id: m.id, templateKey: m.templateKey, ok: m.ok, reason: m.reason ?? null, sizeRatio: m.sizeRatio, dx: m.dx, dy: m.dy })),
      })),
      previews,
    };
  }

  // ------------------------------------------------------------ görseller

  /** Referansın görseli: yazı katmanı ya da şablon + yazı (`template`), isteğe bağlı küçültülmüş (`w`). */
  async referenceImage(id: string, opts: { w?: number; template?: boolean }): Promise<Buffer> {
    const ref = this.d.references.get(id);
    const file = this.referenceImagePath(ref);
    if (!file) throw fail("reference-image-not-found");
    let png: Buffer;
    if (opts.template) {
      const profile = this.profile(ref.languageId, "published").profile;
      const t = ref.templateKey ? this.d.templates.find(ref.languageId, ref.templateKey) : null;
      png = (await userPanel(ref, profile, t ? TemplateSchema.parse(t) : null, this.envFor(ref.languageId), 1)) ?? (await readFile(file));
    } else png = await readFile(file);
    return opts.w ? sharp(png).resize(opts.w, opts.w, { fit: "inside" }).flatten({ background: "#ffffff" }).png().toBuffer() : png;
  }

  async templateThumb(languageId: string, key: string, w = 200): Promise<Buffer> {
    const t = this.d.templates.find(languageId, key);
    const file = t && this.d.templates.imagePath(languageId, t);
    if (!file || !existsSync(file)) throw fail("template-key-image-not-found", { key });
    return sharp(file).resize(w, w, { fit: "inside" }).png().toBuffer();
  }

  private now(): string {
    return this.d.clock.now().toISOString();
  }
}

/** Öneri yamasını okur: `[{target?, path, from?, to}]`; hedefsiz kayıt profil sayılır. */
export function readChanges(patch: unknown): PatchChange[] {
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((x): PatchChange[] => {
    if (!x || typeof x !== "object") return [];
    const c = x as Record<string, unknown>;
    if (c.target === "template" && typeof c.key === "string" && (c.field === "textCenter" || c.field === "ribbonTop" || c.field === "area")) {
      return [{ target: "template", key: c.key, field: c.field, path: String(c.path ?? `template:${c.key}.${c.field}`), from: c.from, to: c.to }];
    }
    if (typeof c.path === "string" && !c.path.startsWith("template:") && ("to" in c || "value" in c)) {
      return [{ target: "profile", path: c.path, from: c.from, to: "to" in c ? c.to : c.value }];
    }
    return [];
  });
}


function runFromRow(r: Record<string, unknown>): LearnRunStatus {
  return {
    id: r.id as string,
    languageId: r.language_id as string,
    status: r.status as LearnRunStatus["status"],
    base: r.base as LearnRunStatus["base"],
    profileVersion: r.profile_version as number,
    step: r.step as string,
    done: r.done as number,
    total: r.total as number,
    message: r.message as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    result: r.result ? (JSON.parse(r.result as string) as LearnRunStatus["result"]) : null,
  };
}
