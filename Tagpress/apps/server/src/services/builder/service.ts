import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Build,
  BUILDER_API,
  BUILDER_COST_HINTS,
  BUILDER_SAMPLE_LIMITS,
  type BuildAnswer,
  type BuildCreate,
  type BuildEntry,
  type BuildError,
  type BuildEstimate,
  type BuildEvent,
  type BuildIntake,
  type BuildMessage,
  type BuildMessageResponse,
  type BuildQuality,
  type BuildQuestion,
  type BuildState,
  type BuildStreamEvent,
  type BuildTryRequest,
  type BuilderRouteName,
  MODELS,
  type Profile,
  type ProfileRecord,
  type ProfileTryResponse,
  type Reference,
  type RevisionDetail,
  type RevisionDiff,
  type RevisionSummary,
  type RuleChange,
  type Sample,
  type SamplePatch,
  type SampleUpload,
  type SampleUploadResponse,
  type ShowcaseResponse,
  type Template,
  type Usage,
  type LayoutResult,
  type ProfileTrySide,
  type BuildLabelType,
  BUILD_LABEL_TYPES,
  BUILD_MESSAGE_KINDS_BY_STATE,
  API,
  apiPath,
  checkTextPreserved,
  cutDiameter,
  defaultProfile,
  estimateCost,
  isBuildRunning,
  isWritableProfilePath,
  nextBuildState,
  normalizeText,
} from "@tagpress/domain";
import {
  BUILDER_PROMPT_VERSION,
  type BuilderEffort,
  type BuilderEvent,
  type BuilderInputEntry,
  type BuilderLoopOptions,
  type BuilderMessage,
  type BuilderModelPort,
  type BuilderSessionContext,
  type BuilderToolContent,
  type BuilderTurnResult,
  type BuilderUserInput,
  countBuilderPrefix,
  dataJson,
  escapeData,
  estimateBuilderCost,
  formatReplay,
  preservationSymbols,
  runBuilderTurn,
} from "@tagpress/ai";
import { ReplayEnv, engineTrial, measureStyle, type StyleMeasurement } from "@tagpress/learn";
import { imageBoxOf } from "@tagpress/templates";
import { FontRegistry } from "@tagpress/typeset";
import sharp from "sharp";
import type { DataPaths } from "../../config.ts";
import type { EventBus } from "../../events.ts";
import { currentOrg, maintenance, runInOrg } from "../../org/context.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Ports } from "../../ports.ts";
import type { Clock } from "../../util/clock.ts";
import { errorMessage, fail } from "../../util/errors.ts";
import { HttpErrorWithBody } from "./errors.ts";
import { writeAtomic } from "../../util/files.ts";
import { MissingKeyError } from "../key-guard.ts";
import type { LanguageService } from "../languages.ts";
import type { ProfileService } from "../profiles.ts";
import type { ReferenceService } from "../references.ts";
import type { SettingsService } from "../settings.ts";
import type { TemplateService } from "../templates.ts";
import { simpleIntent } from "../trial/intent.ts";
import { compareWithReference } from "../trial/service.ts";
import { BuilderBudget, type MonthlyAllowance, type Reservation } from "./budget.ts";
import { withAiJob } from "../../adapters/ai-gateway.ts";
import { diffLeaves } from "../profiles.ts";
import { diffRevisions, profileAt, ruleChanges } from "./revisions.ts";
import { type SampleTemplateInput, SampleFiles, acceptSampleFile, analyzeSample, applyUserLines, assignSplits, fontMetricsFrom, sampleFields, sampleReference } from "./samples.ts";
import { TargetResolver } from "../generation/target.ts";
import { type ShowcaseSpec, ShowcaseRenderer, presetSpecs, profileKey, referenceSpecs, sampleLinesIntent } from "./showcase.ts";
import { type BuildRow, BuilderStore, type SampleRow, baseProfile, measurementOf, revisionSummary, rowLabelTypes, rowNotices, toBuild, toSample } from "./store.ts";
import { BuildStreams } from "./stream.ts";
import { requireAccess } from "../../org/access.ts";
import { BuilderTools, measurementText, resolveMeasurement } from "./tools-exec.ts";

/**
 * Sitede yapay zekâ ile tasarım dili oluşturma: sunucu servisi (SUNUCU-PLANI §4, paket C3). Sözleşme
 * `packages/domain/src/builder*.ts`; model döngüsü `@tagpress/ai` (`runBuilderTurn`); görselden ölçüm `samples.ts`.
 *
 * Kurallar:
 *  - Durum geçişlerini yalnız sunucu yapar (`nextBuildState`); bir oturumda aynı anda tek iş (ölçüm ya da tur:
 *    `turn_seq` kilidi), bir dilde tek etkin oturum (kısmi tekil dizin).
 *  - Model profili doğrudan yazamaz: yalnız kanıtlı `propose_changes` (`tools-exec.ts`) revizyon yazar; taslak satırı
 *    her zaman son revizyondur. Yayını yalnız kullanıcı yapar (`publish`); modelin yayın ve ücretli deneme aracı yok.
 *  - Para: her model isteği bittiği anda `ai_calls`'a yazılır (`build_id`); tur ya da ölçüm başlamadan bütçe ayrılır
 *    (`budget.ts`). Kesilen akışın görülen kullanımı da yazılır.
 *  - Süreç tur ya da ölçüm sırasında kapanırsa (ya da `stopAll`) sonuç yazılmaz; açılışta oturum `interrupted` olur,
 *    "Devam et" aynı girdiyi yeniden gönderir.
 *  - Arka plan işi isteği başlatan firmanın bağlamında sürer (`runInOrg(orgId)`).
 */

/** Okuma (Haiku) portu: satırlar + kullanım (maliyet oturuma yazılır). */
export interface BuilderTranscriber {
  transcribe(png: Buffer, opts: { signal?: AbortSignal }): Promise<{ ok: boolean; lines: string[]; usage: Usage[] }>;
}

export interface BuilderDeps {
  db: TenantDb;
  paths: DataPaths;
  clock: Clock;
  events: EventBus;
  settings: SettingsService;
  languages: LanguageService;
  profiles: ProfileService;
  templates: TemplateService;
  references: ReferenceService;
  ports: Ports;
  /** Oluşturucu modeli (geçerli firmanın kullanacağı anahtarla); anahtar yoksa null (409 `missing-key`). */
  model: () => BuilderModelPort | null;
  /** Satır okuma; yoksa örnekler okunmadan ölçülür (satır metni kullanıcıdan). */
  transcriber: () => BuilderTranscriber | null;
  /** Döngü seçenekleri (testte bekleme). */
  loop?: BuilderLoopOptions;
  bootId?: string;
  /** Platform kipi: geçidin aylık hakkı (`budget.ts`); yerel kipte yok. */
  allowance?: MonthlyAllowance | null;
  /** Platform kipi: tur başlamadan önce hak önbelleği taze değilse yeniden okunur (`BuilderBudget.refresh`). */
  refreshAllowance?: (() => Promise<unknown>) | null;
  /** Anahtarın kaynağı (tahmin ve `missing-key` gövdesi): yerel kipte firmanınki (`org`), platformda ürünün (`product`). */
  keySource?: "org" | "product";
}

interface Job {
  /** `try`: ücretli deneme (AI kipi, AI kalite denemesi); çalışırken tur ve ölçüm başlamaz. */
  kind: "turn" | "analysis" | "try";
  ctrl: AbortController;
  done: Promise<void>;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const MODEL_SAMPLES = 12;
const AUTO_MATCH_TEMPLATES = 12;

const TURN_ESTIMATE: Record<BuilderUserInput["kind"], number> = {
  "first-draft": BUILDER_COST_HINTS.firstDraftUsd,
  answer: BUILDER_COST_HINTS.questionTurnUsd,
  correction: BUILDER_COST_HINTS.correctionTurnUsd,
  continue: BUILDER_COST_HINTS.questionTurnUsd,
};
const TURN_EFFORT: Record<BuilderUserInput["kind"], BuilderEffort> = { "first-draft": "high", answer: "medium", correction: "medium", continue: "medium" };

export class BuilderService {
  readonly store: BuilderStore;
  readonly budget: BuilderBudget;
  readonly streams: BuildStreams;
  private readonly showcaseRenderer: ShowcaseRenderer;
  private readonly targets: TargetResolver;
  private readonly jobs = new Map<string, Job>();
  private stopping = false;

  constructor(private readonly d: BuilderDeps) {
    this.store = new BuilderStore(d.db, d.clock);
    this.budget = new BuilderBudget(d.settings, () => this.store.monthUsd(), d.allowance ?? null, d.refreshAllowance ?? null);
    this.streams = new BuildStreams(d.bootId);
    this.showcaseRenderer = new ShowcaseRenderer(d.ports, d.templates, (lang) => d.paths.fonts(lang));
    this.targets = new TargetResolver(d.ports, d.templates);
    this.recover();
  }

  // ================================================================ açılış ve kapanış

  /** Yarıda kalan işler (bütün firmalar, bakım kapsamı): `interrupted`, kesildiği durum `resume_state`'te. */
  private recover(): void {
    maintenance(() => {
      const m = this.d.db.maintenance;
      const at = this.d.clock.now().toISOString();
      const running = "mode = 'site' AND state IN ('analyzing', 'drafting', 'revising')";
      m.prepare(
        `INSERT INTO design_session_entries (org_id, session_id, at, kind, grp, text, paths, role, data, turn_seq)
         SELECT org_id, id, ?, 'error', NULL, '', NULL, 'system', ?, turn_seq FROM design_sessions WHERE ${running}`,
      ).run(at, JSON.stringify({ code: "interrupted" }));
      const error: BuildError = { code: "interrupted", retryable: true, at };
      m.prepare(`UPDATE design_sessions SET resume_state = state, state = 'interrupted', error = ?, turn_seq = NULL, turn_started_at = NULL, updated_at = ? WHERE ${running}`).run(
        JSON.stringify(error),
        at,
      );
    }, "oluşturucu kurtarma");
  }

  /** Çalışan işleri keser, SONUÇ YAZMADAN bekler (süreç kapanışı: açılışta `interrupted`). */
  async stopAll(): Promise<void> {
    this.stopping = true;
    const all = [...this.jobs.values()];
    for (const j of all) j.ctrl.abort();
    await Promise.allSettled(all.map((j) => j.done));
  }

  /** Testler: çalışan bütün işlerin bitmesini bekler. */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }

  // ================================================================ görünüm ve yardımcılar

  private pendingQuestions(buildId: string): BuildQuestion[] {
    const qs = this.store.entriesOfKind(buildId, ["question"]).filter((e) => e.question);
    const last = Math.max(-1, ...qs.map((e) => e.turnSeq ?? -1));
    return qs.filter((e) => (e.turnSeq ?? -1) === last && !e.question!.answered).map((e) => e.question!);
  }

  view(row: BuildRow): Build {
    return toBuild(row, this.store.sampleRows(row.id).map(toSample), this.pendingQuestions(row.id), this.store.lastEntryId(row.id));
  }

  get(id: string): Build {
    return this.view(this.store.row(id));
  }

  current(languageId: string): Build | null {
    this.d.languages.get(languageId);
    const row = this.store.activeRow(languageId);
    return row ? this.view(row) : null;
  }

  messages(id: string, q: { after: number; limit: number }): { entries: BuildEntry[] } {
    this.store.row(id);
    return { entries: this.store.entries(id, q.after, q.limit) };
  }

  private requireStates(row: BuildRow, route: BuilderRouteName): void {
    const states = BUILDER_API[route].states as readonly BuildState[] | null;
    if (states && !states.includes(row.state)) throw stateError(row.state);
  }

  private next(row: BuildRow, event: BuildEvent): BuildState {
    const to = nextBuildState(row.state, event, { hasRevision: row.current_rev > 0, resumeState: row.resume_state });
    if (!to) throw stateError(row.state);
    return to;
  }

  private requireFree(row: BuildRow): void {
    if (row.turn_seq !== null || this.jobs.has(row.id)) throw fail("build-busy");
  }

  private requireModel(): BuilderModelPort {
    const m = this.d.model();
    if (!m) throw new HttpErrorWithBody(new MissingKeyError("anthropic"), { provider: "anthropic", keySource: this.d.keySource ?? "org" });
    return m;
  }

  private files(buildId: string): SampleFiles {
    return new SampleFiles(path.join(this.d.paths.designSessions, buildId, "ornekler"));
  }

  private showcaseDir(buildId: string, rev: number): string {
    return path.join(this.d.paths.designSessions, buildId, "vitrin", String(rev));
  }

  private publish(row: BuildRow, event: BuildStreamEvent): void {
    this.streams.publish(row.id, event);
  }

  /**
   * Durum olayı: oturum akışı + genel olay yolu. Genel yolda `build` olayı (oluşturucu ekranı) ve `session` olayı
   * (MCP tasarım dili oturumu ekranı, `designSession`) birlikte yayınlanır; ikisi de firma süzgecinden geçer (`events.ts`).
   */
  private status(id: string): void {
    const row = this.store.row(id);
    this.publish(row, { type: "status", state: row.state, resumeState: row.resume_state, running: isBuildRunning(row.state), lastEntryId: this.store.lastEntryId(id) });
    this.d.events.emit({ type: "build", buildId: row.id, languageId: row.language_id, state: row.state });
    this.d.events.emit({ type: "session", languageId: row.language_id });
  }

  private notice(id: string, code: string, params?: Record<string, string | number>, turnSeq: number | null = null): BuildEntry {
    return this.store.addEntry(id, { role: "system", kind: "notice", turnSeq, data: { code, ...(params ? { params } : {}) } });
  }

  private addCost(id: string, usd: number): void {
    if (!usd) return;
    const row = this.store.row(id);
    this.store.update(id, { cost_usd: row.cost_usd + usd });
  }

  private costEvent(id: string, turnUsd: number): void {
    const row = this.store.row(id);
    this.publish(row, {
      type: "cost",
      costUsd: r6(row.cost_usd),
      turnUsd: r6(turnUsd),
      budgetUsd: row.budget_usd,
      monthUsd: r6(this.budget.monthUsd()),
      monthLimitUsd: this.budget.limits().monthlyUsd,
    });
  }

  /** Harcamadan önce: platform izni (`spend`; `org/access.ts`), sonra oturum ve aylık pay. Ücretli her yol buradan geçer. */
  private reserve(row: BuildRow, estimateUsd: number): Reservation {
    requireAccess("spend");
    return this.budget.reserve({ buildId: row.id, sessionUsedUsd: row.cost_usd, sessionCapUsd: row.budget_usd, canRaise: !row.budget_raised, estimateUsd });
  }

  /** Revizyonların son profili (taslak); revizyon yoksa taban. */
  private draftProfile(row: BuildRow, revisions = this.store.revisions(row.id)): Profile {
    return revisions.at(-1)?.profile ?? baseProfile(row);
  }

  private templateList(languageId: string): Template[] {
    return this.showcaseRenderer.templateList(languageId);
  }

  // ================================================================ tahmin ve oturum açma

  async estimate(req: { languageId: string; samples: number }): Promise<BuildEstimate> {
    this.d.languages.get(req.languageId);
    const model = this.d.model();
    let prefix = { prefixTokens: 9_000 + req.samples * 790, exact: false };
    if (model) {
      try {
        prefix = await countBuilderPrefix({ counter: model, promptVersion: BUILDER_PROMPT_VERSION, samples: req.samples });
      } catch {
        /* sayım olmazsa yaklaşık önek */
      }
    }
    const e = estimateBuilderCost({ prefixTokens: prefix.prefixTokens, samples: req.samples, exact: prefix.exact });
    const limits = this.budget.limits();
    const monthUsd = this.budget.monthUsd();
    return {
      lowUsd: e.lowUsd,
      highUsd: e.highUsd,
      sessionCapUsd: limits.sessionUsd,
      monthUsd: r6(monthUsd),
      monthLimitUsd: limits.monthlyUsd,
      monthWarn: monthUsd >= limits.monthlyUsd * limits.warnRatio,
      keySource: model ? (this.d.keySource ?? "org") : null,
    };
  }

  create(languageId: string, body: BuildCreate): Build {
    const lang = this.d.languages.get(languageId);
    const model = this.requireModel();
    const active = this.store.activeRow(lang.id);
    if (active) throw new HttpErrorWithBody(fail("build-active"), { buildId: active.id });
    const published = body.base === "published" ? this.d.profiles.active(lang.id) : null;
    const base: Profile = published?.data ?? defaultProfile(lang.name);
    const labelTypes = [...new Set(body.labelTypes ?? [])];
    const fromSetup = body.fromSetup === true;
    const state = fromSetup && labelTypes.length ? "samples" : "intake";
    let id: string;
    try {
      id = this.store.tx(() => {
        const newId = this.store.insert({
          languageId: lang.id,
          state,
          base: published ? "published" : "default",
          baseVersion: published?.version ?? null,
          baseData: base,
          budgetUsd: this.budget.limits().sessionUsd,
          fromSetup,
          labelTypes,
          model: model.model,
          promptVersion: BUILDER_PROMPT_VERSION,
          locale: currentOrg().locale,
          startVersion: this.d.profiles.active(lang.id)?.version ?? null,
        });
        if (!published) this.notice(newId, "base-default");
        return newId;
      });
    } catch (err) {
      // Yarış: aynı dilde ikinci açılış tekil dizinde durur.
      const again = this.store.activeRow(lang.id);
      if (again) throw new HttpErrorWithBody(fail("build-active"), { buildId: again.id });
      throw err;
    }
    this.status(id);
    return this.get(id);
  }

  putIntake(id: string, body: BuildIntake): Build {
    const row = this.store.row(id);
    this.requireStates(row, "putIntake");
    const labelTypes = [...new Set(body.labelTypes)];
    const state = row.state === "intake" ? this.next(row, "start-samples") : row.state;
    if (!this.store.compareAndSet(id, row.state, "any", { label_types: JSON.stringify(labelTypes), state })) throw fail("build-busy");
    this.status(id);
    return this.get(id);
  }

  raiseBudget(id: string): Build {
    // Sınırı artırmak harcamayı açar: yapay zekâ izni (uç da `spend`).
    requireAccess("spend");
    const row = this.store.row(id);
    this.requireStates(row, "raiseBudget");
    if (row.budget_raised) throw fail("budget-raise-used");
    const limitUsd = row.budget_usd + this.budget.limits().sessionRaiseUsd;
    this.store.update(id, { budget_usd: limitUsd, budget_raised: 1 });
    this.notice(id, "budget-raised", { limitUsd });
    this.status(id);
    return this.get(id);
  }

  // ================================================================ örnekler

  async uploadSamples(id: string, body: SampleUpload): Promise<SampleUploadResponse> {
    const row = this.store.row(id);
    this.requireStates(row, "uploadSamples");
    this.requireFree(row);
    if (body.templateKey && !this.d.templates.find(row.language_id, body.templateKey)) throw fail("template-key-not-found", { key: body.templateKey });
    const max = BUILDER_SAMPLE_LIMITS.maxFiles;
    // Kalan yer her yazımda, kayıtla AYNI eşzamanlı adımda yeniden sayılır (arada `await` yok): eşzamanlı iki yükleme
    // sınırı aşamaz.
    const full = () => this.store.sampleRows(id).length >= max;
    if (full()) throw fail("sample-limit", { max });
    const accepted: Sample[] = [];
    const rejected: SampleUploadResponse["rejected"] = [];
    const files = this.files(id);
    for (const f of body.files) {
      if (full()) {
        rejected.push({ name: f.name, code: "sample-limit", params: { max } });
        continue;
      }
      const bytes = Buffer.from(f.dataBase64, "base64");
      const r = await acceptSampleFile(bytes);
      if (!r.ok) {
        rejected.push({ name: f.name, code: r.code, ...(r.params ? { params: r.params } : {}) });
        continue;
      }
      const sid = randomUUID();
      await files.write(sid, r.png);
      if (full()) {
        // Bu dosya işlenirken başka bir yükleme yeri doldurdu: dosya kaydedilmez.
        await files.remove(sid);
        rejected.push({ name: f.name, code: "sample-limit", params: { max } });
        continue;
      }
      // Yazım ile kayıt arasında oturum başka işe geçtiyse (ör. ölçüm başladı) örnek yine `uploaded` kalır.
      this.store.insertSample(id, row.language_id, { id: sid, name: f.name, w: r.w, h: r.h, templateKey: body.templateKey ?? null });
      accepted.push(toSample(this.store.sampleRow(id, sid)));
    }
    if (accepted.length) {
      this.notice(id, "samples-added", { count: accepted.length });
      this.status(id);
    }
    // Hiçbir dosya kabul edilmediyse ve hepsi aynı nedenle (tür ya da boyut) reddedildiyse istek de o hatayla döner
    // (415 / 413; `rejected` gövdede). Karışık sonuçta 200 + `rejected`.
    const only = rejected[0]?.code;
    if (!accepted.length && (only === "sample-type" || only === "sample-too-large") && rejected.every((r) => r.code === only)) {
      throw new HttpErrorWithBody(only === "sample-type" ? fail("sample-type") : fail("sample-too-large"), { rejected });
    }
    return { samples: accepted, rejected };
  }

  patchSample(id: string, sid: string, body: SamplePatch): Sample {
    const row = this.store.row(id);
    this.requireStates(row, "patchSample");
    this.requireFree(row);
    const s = this.store.sampleRow(id, sid);
    const fields: string[] = [];
    const upd: Partial<SampleRow> = {};
    let m = measurementOf(s);
    if (body.templateKey !== undefined) {
      if (body.templateKey !== null && !this.d.templates.find(row.language_id, body.templateKey)) throw fail("template-key-not-found", { key: body.templateKey });
      upd.template_key = body.templateKey;
      // Şablon değişince yeniden ölçülür (`analyze`).
      upd.status = "uploaded";
      upd.split = null;
      fields.push("templateKey");
    }
    if (body.lines !== undefined) {
      if (!m) throw stateError(row.state);
      m = applyUserLines(m, body.lines);
      upd.measurement = JSON.stringify(m);
      fields.push("lines");
    }
    if (body.fontFile !== undefined) {
      upd.font_file = body.fontFile;
      fields.push("fontFile");
    }
    if (body.exclude !== undefined) {
      upd.excluded = body.exclude ? 1 : 0;
      fields.push("exclude");
    }
    this.store.tx(() => {
      this.store.updateSample(id, sid, upd);
      this.resplit(id);
      // Kullanıcı düzeltmesi cevap sayılır: kanıt olarak gösterilebilir.
      this.store.addEntry(id, { role: "user", kind: "sample-edit", data: { sampleEdit: { sampleId: sid, fields } } });
      this.addModelNotice(row, `The user edited sample "${sid}" (${fields.join(", ")}); re-read samples and measurements if relevant.`);
    });
    this.status(id);
    return toSample(this.store.sampleRow(id, sid));
  }

  async deleteSample(id: string, sid: string): Promise<{ ok: true }> {
    const row = this.store.row(id);
    this.requireStates(row, "deleteSample");
    this.requireFree(row);
    this.store.sampleRow(id, sid);
    this.store.tx(() => {
      this.store.updateSample(id, sid, { deleted_at: this.store.now() });
      this.resplit(id);
    });
    await this.files(id).remove(sid);
    this.status(id);
    return { ok: true };
  }

  async sampleImage(id: string, sid: string, w?: number): Promise<Buffer> {
    this.store.row(id);
    this.store.sampleRow(id, sid);
    const png = await this.files(id).read(sid);
    if (!png) throw fail("sample-not-found");
    return w ? sharp(png).resize(w, w, { fit: "inside", withoutEnlargement: true }).png().toBuffer() : png;
  }

  private resplit(id: string): void {
    const rows = this.store.sampleRows(id);
    const splits = assignSplits(
      rows.map((r) => ({
        id: r.id,
        createdAt: `${r.created_at}#${String(r.seq).padStart(6, "0")}`,
        quality: r.status === "measured" || r.status === "qualitative" ? (measurementOf(r)?.quality ?? null) : null,
        excluded: !!r.excluded,
        split: r.split,
        // Modele gösterilmiş örnek bir daha ayrılmış kümeye geçmez (`assignSplits`).
        shown: r.shown_at !== null,
      })),
    );
    for (const r of rows) {
      const s = splits.get(r.id) ?? null;
      if (s !== r.split) this.store.updateSample(id, r.id, { split: s });
    }
  }

  private addModelNotice(row: BuildRow, text: string): void {
    const fresh = this.store.row(row.id);
    const list = rowNotices(fresh);
    if (!list.includes(text)) this.store.update(row.id, { notices: JSON.stringify([...list, text].slice(-20)) });
  }

  // ================================================================ ölçüm

  /** Ölçüm (ücretsiz ölçüm + Haiku okuma). İlk ölçümden sonra model turu kendiliğinden başlar. */
  analyze(id: string): Build {
    const row = this.store.row(id);
    this.requireStates(row, "analyze");
    this.requireFree(row);
    const pending = this.store.sampleRows(id).filter((s) => !s.excluded && s.status === "uploaded");
    if (!this.store.sampleRows(id).some((s) => !s.excluded)) throw stateError(row.state);
    const to = this.next(row, "analyze");
    const willDraft = row.current_rev === 0;
    const model = willDraft ? this.requireModel() : null;
    const est = pending.length * BUILDER_COST_HINTS.transcribePerSampleUsd + (willDraft ? TURN_ESTIMATE["first-draft"] : 0);
    const res = this.reserve(row, est);
    if (!this.store.compareAndSet(id, row.state, "free", { state: to, error: null, resume_state: null })) {
      this.budget.release(res);
      throw fail("build-busy");
    }
    this.status(id);
    this.spawnAnalysis(id, res, model);
    return this.get(id);
  }

  private spawnAnalysis(id: string, res: Reservation, model: BuilderModelPort | null): void {
    const ctrl = new AbortController();
    const orgId = currentOrg();
    const done = runInOrg(orgId, async () => {
      try {
        await this.runAnalysis(id, ctrl.signal, res);
      } catch {
        /* örnek hataları örnekte; burada yalnız beklenmeyen */
      }
      if (this.stopping) {
        this.budget.release(res);
        return;
      }
      this.jobs.delete(id);
      try {
        this.finishAnalysis(id, ctrl.signal.aborted, res, model);
      } catch (err) {
        this.budget.release(res);
        this.failInternal(id, err);
      }
    });
    this.jobs.set(id, { kind: "analysis", ctrl, done: done.finally(() => this.jobs.get(id)?.ctrl === ctrl && this.jobs.delete(id)) });
  }

  private async templateInput(languageId: string, t: Template, profile: Profile, match: SampleTemplateInput["match"]): Promise<SampleTemplateInput | null> {
    const file = this.d.templates.imagePath(languageId, t);
    if (!existsSync(file)) return null;
    return { key: t.key, png: await readFile(file), imageBox: imageBoxOf(t, profile), match };
  }

  private async runAnalysis(id: string, signal: AbortSignal, res: Reservation): Promise<void> {
    const row = this.store.row(id);
    const profile = this.draftProfile(row);
    const files = this.files(id);
    const transcriber = this.d.transcriber();
    const wrapped = transcriber
      ? {
          transcribe: async (png: Buffer, o: { signal?: AbortSignal }) => {
            const r = await transcriber.transcribe(png, o);
            let usd = 0;
            for (const u of r.usage) usd += this.store.recordCall(id, row.language_id, { purpose: "builder-transcribe", model: u.model, usage: u, summary: "örnek okuma" });
            this.addCost(id, usd);
            this.budget.charge(res, usd);
            return r;
          },
        }
      : null;
    const templates = this.templateList(row.language_id);
    let candidates: SampleTemplateInput[] | null = null;
    for (const s of this.store.sampleRows(id)) {
      if (signal.aborted) return;
      if (s.excluded || s.status !== "uploaded") continue;
      this.publish(row, { type: "step", turnSeq: null, step: "measure", phase: "start", sampleId: s.id });
      let ok = true;
      try {
        const png = await files.read(s.id);
        if (!png) throw new Error("görsel yok");
        let template: SampleTemplateInput | null = null;
        if (s.template_key) {
          const t = templates.find((x) => x.key === s.template_key);
          template = t ? await this.templateInput(row.language_id, t, profile, "user") : null;
        }
        if (!template && !s.template_key && candidates === null) {
          candidates = [];
          for (const t of templates.slice(0, AUTO_MATCH_TEMPLATES)) {
            const ti = await this.templateInput(row.language_id, t, profile, "auto");
            if (ti) candidates.push(ti);
          }
        }
        const m = await analyzeSample({
          png,
          template,
          candidates: template ? [] : (candidates ?? []),
          designFramePx: profile.output.designFramePx,
          cutDiameterPx: cutDiameter(profile),
          transcriber: wrapped,
          signal,
        });
        if (signal.aborted) return;
        this.store.updateSample(id, s.id, { status: sampleFields(m).status, measurement: JSON.stringify(m), error: null, w: m.w, h: m.h });
      } catch (err) {
        if (signal.aborted) return;
        ok = false;
        this.store.updateSample(id, s.id, { status: "failed", error: JSON.stringify({ code: "analysis-failed", params: { detail: errorMessage(err).slice(0, 200) } }) });
      }
      this.publish(row, { type: "step", turnSeq: null, step: "measure", phase: "end", ok, sampleId: s.id });
    }
    this.store.tx(() => this.resplit(id));
  }

  private finishAnalysis(id: string, aborted: boolean, res: Reservation, model: BuilderModelPort | null): void {
    const row = this.store.row(id);
    if (aborted) {
      this.budget.release(res);
      const to = this.next(row, "cancel");
      this.store.update(id, { state: to });
      this.notice(id, "cancelled");
      this.publish(row, { type: "done", turnSeq: null, state: to, stopReason: "cancelled" });
      this.status(id);
      return;
    }
    const live = this.store.sampleRows(id).filter((s) => !s.excluded);
    const measured = live.filter((s) => s.status === "measured").length;
    const qualitative = live.filter((s) => s.status === "qualitative").length;
    const failed = live.filter((s) => s.status === "failed").length;
    if (!measured && !qualitative) {
      this.budget.release(res);
      const to = this.next(row, "analysis-failed");
      this.store.update(id, { state: to });
      this.store.addEntry(id, { role: "system", kind: "error", data: { code: "analysis-failed", params: { failed } } });
      this.publish(row, { type: "done", turnSeq: null, state: to, stopReason: "analysis" });
      this.status(id);
      return;
    }
    const to = this.next(row, "analysis-done");
    this.notice(id, "analysis-done", { measured, qualitative, failed });
    if (row.measured_at && row.current_rev > 0) {
      this.addModelNotice(row, `The sample set changed: ${measured} measured and ${qualitative} qualitative samples now. Call get_measurements and get_samples again before relying on earlier numbers.`);
    }
    this.store.update(id, { measured_at: this.store.now() });
    this.publish(row, { type: "done", turnSeq: null, state: to, stopReason: "analysis" });
    if (to !== "drafting") {
      this.budget.release(res);
      this.store.update(id, { state: to });
      this.status(id);
      return;
    }
    // İlk ölçüm bitti: ilk tur, ayrılmış payla hemen.
    const m = model ?? this.d.model();
    if (!m) {
      this.budget.release(res);
      this.toFailed(id, "drafting", { code: "missing-key", retryable: true, at: this.store.now() }, null);
      return;
    }
    const fresh = this.store.row(id);
    const seq = fresh.next_seq + 1;
    const input: BuilderUserInput = { kind: "first-draft", entries: this.waitingInputs(id, seq) };
    this.store.update(id, { state: "drafting", turn_seq: seq, next_seq: seq, turn_started_at: this.store.now(), turn_input: JSON.stringify(input), notices: null });
    this.status(id);
    this.spawnTurn(id, seq, withNotices(input, rowNotices(fresh)), m, res);
  }

  // ================================================================ turlar

  /** Kullanıcı iletisi: cevap, düzeltme ya da not. */
  postMessage(id: string, body: BuildMessage): { status: 200 | 202; body: BuildMessageResponse } {
    const row = this.store.row(id);
    this.requireStates(row, "postMessage");
    const allowed: readonly string[] = BUILD_MESSAGE_KINDS_BY_STATE[row.state] ?? [];
    if (!allowed.includes(body.kind)) throw fail("message-kind");
    if (body.kind === "note") {
      const e = this.store.addEntry(id, { role: "user", kind: "note", text: body.text! });
      this.status(id);
      return { status: 200, body: { turn: null, entries: [e] } };
    }
    this.requireFree(row);
    const model = this.requireModel();
    const event: BuildEvent = row.state === "awaiting-user" ? "answer" : "correct";
    const to = this.next(row, event);
    const kind: BuilderUserInput["kind"] = body.kind === "answer" ? "answer" : "correction";
    const pending = this.pendingQuestions(id);
    const questionEntries = this.store.entriesOfKind(id, ["question"]);
    const answers: Array<{ q: BuildQuestion; a: BuildAnswer }> = [];
    for (const a of body.answers ?? []) {
      const q = pending.find((x) => x.id === a.questionId);
      if (!q) throw fail("question-unknown");
      if (a.option !== undefined && !q.options[a.option]) throw fail("question-unknown");
      // Serbest cevapsız soruda seçenek şart (metin tek başına cevap değil).
      if (a.option === undefined && !q.free) throw fail("question-unknown");
      answers.push({ q, a: { questionId: q.id, option: a.option ?? null, text: a.text ?? null, value: a.option !== undefined ? (q.options[a.option]!.value ?? null) : null } });
    }
    const res = this.reserve(row, TURN_ESTIMATE[kind]);
    let written: BuildEntry[] = [];
    let seq = 0;
    try {
      this.store.tx(() => {
        seq = row.next_seq + 1;
        if (!this.store.compareAndSet(id, row.state, "free", { state: to, turn_seq: seq, next_seq: seq, turn_started_at: this.store.now(), error: null, resume_state: null })) throw fail("build-busy");
        for (const { q, a } of answers) {
          written.push(this.store.addEntry(id, { role: "user", kind: "answer", text: a.text, group: q.group, turnSeq: seq, data: { answer: a } }));
          const qe = questionEntries.find((e) => e.question?.id === q.id);
          if (qe) this.store.updateEntryData(id, qe.id, { question: { ...qe.question!, answered: true } });
        }
        if (body.text) written.push(this.store.addEntry(id, { role: "user", kind: body.kind === "answer" ? "answer" : "correction", text: body.text, turnSeq: seq }));
      });
    } catch (err) {
      this.budget.release(res);
      throw err;
    }
    written = written.map((e) => this.store.entry(id, e.id)!);
    const entries: BuilderInputEntry[] = [...this.waitingInputs(id, seq), ...written.map((e) => inputEntry(e, pending))];
    const fresh = this.store.row(id);
    const input: BuilderUserInput = { kind, entries };
    this.store.update(id, { turn_input: JSON.stringify(withNotices(input, rowNotices(fresh))), notices: null });
    this.status(id);
    this.spawnTurn(id, seq, withNotices(input, rowNotices(fresh)), model, res);
    return { status: 202, body: { turn: { seq }, entries: written } };
  }

  /**
   * Tur başlatmayan kullanıcı girdileri (not, örnek düzeltmesi): önceki turdan sonra yazılanlar bu turla modele gider
   * (kimlikleri kanıt olarak kullanılabilir).
   */
  private waitingInputs(id: string, seq: number): BuilderInputEntry[] {
    const all = this.store.entries(id, 0, 100_000);
    let last = 0;
    for (const e of all) if (e.turnSeq !== null && e.turnSeq < seq) last = Math.max(last, e.id);
    return all.filter((e) => e.role === "user" && e.turnSeq === null && e.id > last && (e.kind === "note" || e.kind === "sample-edit")).map((e) => inputEntry(e, []));
  }

  /** "Örneğim yok": ölçümsüz ilk tur. */
  skipSamples(id: string): Build {
    const row = this.store.row(id);
    this.requireStates(row, "skipSamples");
    this.requireFree(row);
    const model = this.requireModel();
    const to = this.next(row, "skip-samples");
    this.beginTurn(row, to, { kind: "first-draft", entries: this.waitingInputs(id, row.next_seq + 1) }, model);
    return this.get(id);
  }

  /** "Devam et": kesilen ölçümü ya da turu yeniden başlatır. */
  resume(id: string): Build {
    const row = this.store.row(id);
    this.requireStates(row, "resume");
    this.requireFree(row);
    const to = this.next(row, "resume");
    if (to === "analyzing") {
      const willDraft = row.current_rev === 0;
      const model = willDraft ? this.requireModel() : null;
      const pending = this.store.sampleRows(id).filter((s) => !s.excluded && s.status === "uploaded").length;
      const res = this.reserve(row, pending * BUILDER_COST_HINTS.transcribePerSampleUsd + (willDraft ? TURN_ESTIMATE["first-draft"] : 0));
      if (!this.store.compareAndSet(id, row.state, "free", { state: to, error: null, resume_state: null })) {
        this.budget.release(res);
        throw fail("build-busy");
      }
      this.notice(id, "resumed");
      this.status(id);
      this.spawnAnalysis(id, res, model);
      return this.get(id);
    }
    const model = this.requireModel();
    const stored = row.turn_input ? (JSON.parse(row.turn_input) as BuilderUserInput) : null;
    // Girdi kaydedilmediyse (tur iletileri yazıldı): son ileti kullanıcınınsa aynen, değilse "devam".
    const last = this.store.history(id).at(-1);
    const input: BuilderUserInput | null = stored ?? (last && last.role !== "assistant" ? null : { kind: "continue" });
    this.notice(id, "resumed");
    this.beginTurn(row, to, input, model);
    return this.get(id);
  }

  /** Tur başlatır (eşzamanlı: denetim, bütçe ayırma ve kilit aynı adımda). */
  private beginTurn(row: BuildRow, to: BuildState, input: BuilderUserInput | null, model: BuilderModelPort): number {
    const res = this.reserve(row, TURN_ESTIMATE[input?.kind ?? "continue"]);
    const seq = row.next_seq + 1;
    const withN = input ? withNotices(input, rowNotices(row)) : null;
    const ok = this.store.compareAndSet(row.id, row.state, "free", {
      state: to,
      turn_seq: seq,
      next_seq: seq,
      turn_started_at: this.store.now(),
      turn_input: withN ? JSON.stringify(withN) : null,
      notices: null,
      error: null,
      resume_state: null,
    });
    if (!ok) {
      this.budget.release(res);
      throw fail("build-busy");
    }
    this.status(row.id);
    this.spawnTurn(row.id, seq, withN, model, res);
    return seq;
  }

  /**
   * Turun modele açabileceği bütün örnekler (bağlam, `get_samples`, ölçüm özeti, motor denemesi `all`) "gösterildi"
   * işaretlenir: bir daha `test` olamazlar (ayrılmış küme modelin görmediği örneklerden kalır).
   */
  private markModelSamplesShown(id: string): void {
    const ids = this.modelSamples(id).map((s) => s.id);
    if (ids.length) this.store.markShown(id, ids);
  }

  private spawnTurn(id: string, seq: number, input: BuilderUserInput | null, model: BuilderModelPort, res: Reservation): void {
    const ctrl = new AbortController();
    const org = currentOrg();
    this.markModelSamplesShown(id);
    const done = runInOrg(org, async () => {
      let result: BuilderTurnResult | null = null;
      let thrown: unknown = null;
      let tools: BuilderTools | null = null;
      let recorded = 0;
      try {
        // Platform kipi: geçidin aylık harcaması taze değilse ilk model isteğinden önce yeniden okunur (kalan pay taze).
        await this.budget.refresh();
        const row = this.store.row(id);
        const history = this.store.history(id);
        const env = await this.toolsEnv(row, seq, input?.kind ?? "continue");
        tools = new BuilderTools(env);
        const context = history.length ? undefined : await this.sessionContext(row, env.measurement);
        const onEvent = (e: BuilderEvent) => {
          recorded += this.onLoopEvent(id, seq, e, res);
        };
        // Kalan pay HER model isteğinden önce kayıtlı harcamadan yeniden hesaplanır (bu turun ve eşzamanlı işlerin
        // yazılmış harcaması dahil): sınır en çok iş başına bir istek kadar aşılır.
        const remainingUsd = () => {
          const fresh = this.store.row(id);
          return this.budget.remainingUsd(res, fresh.cost_usd, fresh.budget_usd);
        };
        result = await runBuilderTurn({
          model,
          promptVersion: row.prompt_version,
          history,
          ...(context ? { context } : {}),
          input,
          effort: TURN_EFFORT[input?.kind ?? "continue"],
          executor: tools,
          onEvent,
          signal: ctrl.signal,
          budget: { remainingUsd },
          ...(this.d.loop ? { options: this.d.loop } : {}),
        });
      } catch (err) {
        thrown = err;
      }
      // Kesilen akışın görülen kullanımı (olay olarak gelmedi) da harcamadır.
      if (result) {
        const partial = result.usage.filter((u) => u.partial);
        let usd = 0;
        const row = this.store.row(id);
        for (const u of partial) usd += this.store.recordCall(id, row.language_id, { purpose: "builder-turn", model: u.model, usage: u, summary: `tur ${seq} (yarım)` });
        this.addCost(id, usd);
        this.budget.charge(res, usd);
        recorded += usd;
      }
      if (this.stopping) {
        this.budget.release(res);
        return;
      }
      try {
        this.finishTurn(id, seq, result, thrown, tools, recorded);
      } catch (err) {
        this.failInternal(id, err);
      } finally {
        this.budget.release(res);
      }
    });
    this.jobs.set(id, { kind: "turn", ctrl, done: done.finally(() => this.jobs.get(id)?.ctrl === ctrl && this.jobs.delete(id)) });
  }

  /** Döngü olayı → akış olayı; istek bitince kullanımı yazar (dönen: yazılan tutar). */
  private onLoopEvent(id: string, seq: number, e: BuilderEvent, res: Reservation): number {
    const row = this.store.row(id);
    switch (e.type) {
      case "text":
        this.publish(row, { type: "text", turnSeq: seq, index: e.index, delta: e.delta });
        return 0;
      case "step":
        this.publish(row, { type: "step", turnSeq: seq, step: e.tool as never, phase: e.phase, ...(e.phase === "end" ? { ok: e.ok } : {}) });
        return 0;
      case "retry-wait":
        this.notice(id, "retrying", { waitMs: e.waitMs, attempt: e.attempt }, seq);
        this.publish(row, { type: "step", turnSeq: seq, step: "retry-wait", phase: "start", attempt: e.attempt, waitMs: e.waitMs });
        return 0;
      case "usage": {
        let usd = 0;
        for (const u of e.usage) usd += this.store.recordCall(id, row.language_id, { purpose: "builder-turn", model: u.model, usage: u, summary: `tur ${seq}, istek ${e.round + 1}` });
        this.addCost(id, usd);
        this.budget.charge(res, usd);
        this.costEvent(id, e.turnUsd);
        return usd;
      }
      default:
        return 0;
    }
  }

  private finishTurn(id: string, seq: number, result: BuilderTurnResult | null, thrown: unknown, tools: BuilderTools | null, recordedUsd: number): void {
    const row = this.store.row(id);
    const hasRevision = row.current_rev > 0;
    let event: BuildEvent;
    let error: BuildError | null = null;
    let stop: "end_turn" | "ask_user" | "cancelled" | "failed" | "max_steps" | "proposal_failed" | "budget" = "end_turn";
    const at = this.store.now();
    if (!result) {
      event = "fail";
      error = { code: "internal", params: { detail: errorMessage(thrown).slice(0, 200) }, retryable: true, at };
      stop = "failed";
    } else {
      switch (result.stopReason) {
        case "ask_user":
          event = "ask";
          stop = "ask_user";
          break;
        case "end_turn":
          event = "turn-end";
          break;
        case "budget":
          // Kalan pay doldu: tur durur, kullanıcıya görünür bildirim yazılır (sessiz bitmez).
          event = "turn-end";
          stop = "budget";
          break;
        case "max_steps":
          event = "turn-end";
          stop = "max_steps";
          break;
        case "proposal_failed":
          event = "turn-end";
          stop = "proposal_failed";
          break;
        case "cancelled":
          event = "cancel";
          stop = "cancelled";
          break;
        default:
          event = "fail";
          stop = "failed";
          error = { ...failureError(result), at };
      }
    }
    const to = nextBuildState(row.state, event, { hasRevision }) ?? "failed";
    this.store.tx(() => {
      if (result) {
        this.store.insertTurn(id, seq, { messages: result.messages, usage: result.usage, costUsd: result.costUsd, stopReason: result.stopReason });
        for (const t of result.text) if (t.trim()) this.store.addEntry(id, { role: "assistant", kind: "text", text: t, turnSeq: seq });
        if (tools?.revisions.length) this.store.updateRevisionCost(id, tools.revisions.at(-1)!, recordedUsd);
      }
      if (stop === "proposal_failed" && tools) this.notice(id, "proposal-failed", { paths: [...tools.failedPaths].join(", ") }, seq);
      if (stop === "cancelled") this.notice(id, "cancelled", undefined, seq);
      if (stop === "budget") this.notice(id, "budget-stopped", this.budgetStopParams(id), seq);
      if (event === "ask" && result?.questions) this.writeQuestions(id, seq, result.questions, tools);
      if (error) this.store.addEntry(id, { role: "system", kind: "error", turnSeq: seq, data: { code: error.code, ...(error.params ? { params: error.params } : {}) } });
      this.store.update(id, {
        state: to,
        turn_seq: null,
        turn_started_at: null,
        // Tur iletileri yazıldıysa girdi tükendi ("Devam et" kayıtlı iletilerden sürer); yazılmadıysa saklı kalır.
        ...(result ? { turn_input: null } : {}),
        error: error ? JSON.stringify(error) : null,
        resume_state: to === "failed" ? row.state : null,
      });
    });
    if (error) this.publish(row, { type: "error", error });
    this.costEvent(id, result?.costUsd ?? 0);
    this.publish(row, { type: "done", turnSeq: seq, state: to, stopReason: stop });
    this.status(id);
  }

  /** Bütçe yüzünden duran turun bildirimi: hangi sınır (oturum önce), harcanan ve sınır. */
  private budgetStopParams(id: string): { scope: "session" | "month"; usedUsd: number; limitUsd: number } {
    const row = this.store.row(id);
    if (row.cost_usd >= row.budget_usd - 1e-9) return { scope: "session", usedUsd: r6(row.cost_usd), limitUsd: row.budget_usd };
    return { scope: "month", usedUsd: r6(this.budget.monthUsd()), limitUsd: this.budget.limits().monthlyUsd };
  }

  private writeQuestions(id: string, seq: number, questions: NonNullable<BuilderTurnResult["questions"]>, tools: BuilderTools | null): void {
    const taken = new Set(this.store.entriesOfKind(id, ["question"]).map((e) => e.question?.id));
    const measurement = tools?.measurement ?? null;
    for (const q of questions) {
      let qid = q.id;
      for (let k = 2; taken.has(qid); k++) qid = `${q.id}-${k}`;
      taken.add(qid);
      const stat = q.measured ? resolveMeasurement(measurement, q.measured.key) : null;
      const question: BuildQuestion = {
        id: qid,
        entryId: 1,
        group: q.group,
        text: q.text,
        measured: stat ? { key: stat.key, value: stat.value, n: stat.n, q1: stat.q1, q3: stat.q3 } : null,
        suggestion: q.suggestion ?? null,
        options: q.options.map((o) => ({ label: o.label, value: o.value_json !== undefined ? safeJson(o.value_json) : null })),
        free: q.free,
        paths: q.paths ?? [],
        answered: false,
      };
      const e = this.store.addEntry(id, { role: "assistant", kind: "question", text: q.text, group: q.group, turnSeq: seq, data: { question } });
      const withId = { ...question, entryId: e.id };
      this.store.updateEntryData(id, e.id, { question: withId });
      this.publish(this.store.row(id), { type: "question", entry: this.store.entry(id, e.id)! });
    }
  }

  private toFailed(id: string, from: BuildState, error: BuildError, seq: number | null): void {
    this.store.tx(() => {
      this.store.addEntry(id, { role: "system", kind: "error", turnSeq: seq, data: { code: error.code } });
      this.store.update(id, { state: "failed", resume_state: from, turn_seq: null, turn_started_at: null, error: JSON.stringify(error) });
    });
    const row = this.store.row(id);
    this.publish(row, { type: "error", error });
    this.publish(row, { type: "done", turnSeq: seq, state: "failed", stopReason: "failed" });
    this.status(id);
  }

  private failInternal(id: string, err: unknown): void {
    try {
      const row = this.store.row(id);
      const from = isBuildRunning(row.state) ? row.state : (row.resume_state ?? "drafting");
      this.toFailed(id, from, { code: "internal", params: { detail: errorMessage(err).slice(0, 200) }, retryable: true, at: this.store.now() }, row.turn_seq);
    } catch {
      /* oturum silinmiş olabilir */
    }
  }

  /** Çalışan ölçümü ya da turu keser; harcanan tutar yazılmıştır. */
  async cancel(id: string): Promise<Build> {
    const row = this.store.row(id);
    this.requireStates(row, "cancel");
    const job = this.jobs.get(id);
    if (job) {
      job.ctrl.abort();
      await job.done;
    } else {
      // Süreçte iş yok (ör. kayıt yarım kaldı): durum doğrudan geri alınır.
      const to = this.next(row, "cancel");
      this.store.update(id, { state: to, turn_seq: null, turn_started_at: null });
      this.notice(id, "cancelled");
      this.status(id);
    }
    return this.get(id);
  }

  async close(id: string): Promise<Build> {
    const row = this.store.row(id);
    this.requireStates(row, "close");
    const job = this.jobs.get(id);
    if (job) {
      job.ctrl.abort();
      await job.done;
    }
    const fresh = this.store.row(id);
    const to = this.next(fresh, "close");
    this.store.update(id, { state: to, turn_seq: null, turn_started_at: null, resume_state: null });
    this.status(id);
    return this.get(id);
  }

  // ================================================================ araç ortamı ve oturum bağlamı

  /** Modelin görebildiği yüklenen örnekler (ayrılmış küme ve dışarıda bırakılanlar YOK). */
  private modelSamples(buildId: string): SampleRow[] {
    return this.store.sampleRows(buildId).filter((s) => !s.excluded && s.split !== "test" && (s.status === "measured" || s.status === "qualitative"));
  }

  /** Ölçüme giren kayıtlar: dilin öğrenme kümesi referansları + yüklenen örneklerin (test hariç) referans biçimi. */
  private async measureRefs(row: BuildRow, profile: Profile, split: "train" | "test"): Promise<Reference[]> {
    const refs = this.d.references.list({ languageId: row.language_id, split });
    const samples = this.store.sampleRows(row.id).filter((s) => !s.excluded && (split === "test" ? s.split === "test" : s.split !== "test") && (s.status === "measured" || s.status === "qualitative"));
    const needFonts = samples.some((s) => s.font_file || measurementOf(s)?.lines.some((l) => l.fontFile));
    let fonts: ReturnType<typeof fontMetricsFrom> | null = null;
    if (needFonts) {
      try {
        const reg = await FontRegistry.create({ entries: profile.fonts.list, fontDir: this.d.paths.fonts(row.language_id), fallbackDirs: [this.d.paths.sharedFonts] });
        fonts = fontMetricsFrom(reg, profile.fonts.list);
      } catch {
        fonts = null;
      }
    }
    const out = [...refs];
    for (const s of samples) {
      const m = measurementOf(s);
      if (!m) continue;
      const ref = sampleReference({ id: s.id, languageId: row.language_id, createdAt: s.created_at, split: s.split, measurement: m, fontFile: s.font_file, designFramePx: profile.output.designFramePx, fonts });
      if (ref) out.push(ref);
    }
    return out;
  }

  private async measurement(row: BuildRow, profile: Profile): Promise<StyleMeasurement | null> {
    const refs = await this.measureRefs(row, profile, "train");
    if (!refs.length) return null;
    try {
      return measureStyle(refs, profile, this.templateList(row.language_id));
    } catch {
      return null;
    }
  }

  private async toolsEnv(row: BuildRow, seq: number, kind: BuilderUserInput["kind"]) {
    const revisions = this.store.revisions(row.id);
    const draft = this.draftProfile(row, revisions);
    const measurement = await this.measurement(row, draft);
    const id = row.id;
    const self = this;
    const env = {
      base: baseProfile(row),
      draft,
      measurement,
      userEntry: (entryId: number) => self.store.userEntry(id, entryId),
      samples: (limit: number, ids?: readonly string[]) => self.samplesContent(row, limit, ids),
      templates: (keys?: readonly string[]) => self.templatesContent(row, keys),
      engineTrial: (split: "test" | "all", limit: number, profile: Profile) => self.engineTrialText(row, split, limit, profile),
      writeRevision: (profile: Profile, changes: RuleChange[], note: string) => self.writeRevision(id, profile, changes, note, kind, seq),
    };
    return env;
  }

  /**
   * Taslak satırı her zaman son revizyondur; ama taslak bu oturumun dışında (Tasarım dili ekranı, MCP `taslak_yaz`,
   * öğrenme) değiştiyse o hâl sessizce ezilmez: önce `manual` revizyon olarak oturum geçmişine yazılır (kullanıcı
   * "Bu sürüme dön" ile geri getirebilir), akışa `draft-replaced` bildirimi ve modele not düşülür. Dönen: bundan sonra
   * yazılacak revizyonun numarası. İşlem (tx) içinde çağrılır.
   */
  private keepForeignDraft(id: string, seq: number | null): number {
    const row = this.store.row(id);
    const expected = this.draftProfile(row);
    const cur = this.d.profiles.draft(row.language_id);
    if (!cur || !diffLeaves(expected, cur.data).length) return row.current_rev + 1;
    const rev = row.current_rev + 1;
    const entry = this.notice(id, "draft-replaced", { rev }, seq);
    const changes = ruleChanges(expected, cur.data, () => ({ kind: "manual", ref: String(cur.version) }));
    this.store.insertRevision(id, row.language_id, { rev, reason: "manual", summary: cur.note ?? "", profile: cur.data, changes, entryId: entry.id, restoredFrom: null, costUsd: 0 });
    this.store.update(id, { current_rev: rev });
    this.publish(row, { type: "revision", rev, reason: "manual", changeCount: changes.length, summary: cur.note ?? "", entryId: entry.id });
    this.addModelNotice(row, `The draft had been changed outside this session; that version is kept as revision ${rev} (manual) and the next revision replaced it in the draft. Re-read the draft (read_profile) and ask the user if their outside change should be kept.`);
    return rev + 1;
  }

  private writeRevision(id: string, profile: Profile, changes: RuleChange[], note: string, kind: BuilderUserInput["kind"], seq: number): number {
    return this.store.tx(() => {
      const first = this.store.row(id).current_rev === 0;
      const rev = this.keepForeignDraft(id, seq);
      const row = this.store.row(id);
      const reason = first ? "initial" : kind === "correction" ? "correction" : "answer";
      const entry = this.store.addEntry(id, { role: "assistant", kind: "revision", text: note, turnSeq: seq, data: { rev } });
      this.store.insertRevision(id, row.language_id, { rev, reason, summary: note, profile, changes, entryId: entry.id, restoredFrom: null, costUsd: 0 });
      this.store.update(id, { current_rev: rev });
      const draft = this.d.profiles.saveDraft(row.language_id, profile, note);
      this.d.events.emit({ type: "profile", languageId: row.language_id, version: draft.version });
      this.publish(row, { type: "revision", rev, reason, changeCount: changes.length, summary: note, entryId: entry.id });
      return rev;
    });
  }

  /**
   * Örneğin istemdeki açıklaması. Müşteri metni ve kullanıcı alanları veri kaçışıyla (`dataJson` / `escapeData`:
   * `<` `>` → `\u003c` `\u003e`), metnin kendisi değişmez; `</sample>` gibi bir metin bloğu kapatamaz.
   */
  private sampleCaption(s: SampleRow): string {
    const m = measurementOf(s);
    const e = escapeData;
    const lines = (m?.lines ?? []).map((l, i) => `  ${i + 1}. ${dataJson(l.text ?? "?")}${l.fontFile ? ` [font ${e(l.fontFile)}]` : ""}${l.ink ? ` [ink h ${Math.round(l.ink.h)} px]` : ""}`);
    return [
      `uploaded sample ${e(s.id)} · quality ${m?.quality ?? "?"}${m?.approx ? " (approximate: line count did not match)" : ""} · template ${e(s.template_key ?? m?.templateKey ?? "—")}${s.font_file ? ` · font ${e(s.font_file)}` : ""}`,
      "lines (customer text, data):",
      ...lines,
    ].join("\n");
  }

  private async samplesContent(row: BuildRow, limit: number, ids?: readonly string[]): Promise<BuilderToolContent[]> {
    const want = ids?.length ? new Set(ids) : null;
    const out: BuilderToolContent[] = [];
    let n = 0;
    for (const s of this.modelSamples(row.id)) {
      if (n >= limit) break;
      if (want && !want.has(s.id)) continue;
      out.push({ type: "text", text: `<sample id=${dataJson(s.id)}>\n${this.sampleCaption(s)}\n</sample>` });
      const png = await this.files(row.id).read(s.id);
      if (png) out.push({ type: "image", png });
      n++;
    }
    for (const r of this.d.references.list({ languageId: row.language_id, split: "train" })) {
      if (n >= limit) break;
      if (want && !want.has(r.id)) continue;
      const e = escapeData;
      const lines = r.user.map((l, i) => `  ${i + 1}. ${dataJson(l.text)} [${e(l.family)}/${e(l.style)} ${Math.round(l.sizePx * 10) / 10} px]`);
      out.push({ type: "text", text: `<sample id=${dataJson(r.id)}>\nshop reference ${e(r.id)} · template ${e(r.templateKey ?? "—")}\ncustomer text (data): ${dataJson(r.text)}\nthe user's lines:\n${lines.join("\n")}\n</sample>` });
      n++;
    }
    if (!out.length) out.push({ type: "text", text: "No samples or references available (the held-out test split is never shown)." });
    return out;
  }

  private async templatesContent(row: BuildRow, keys?: readonly string[]): Promise<BuilderToolContent[]> {
    const list = this.templateList(row.language_id).filter((t) => !keys?.length || keys.includes(t.key));
    const summary = list.map((t) => {
      const x = t as Template & Record<string, unknown>;
      return { key: t.key, ...Object.fromEntries(["kind", "notes", "tags", "cut", "area", "areaMode", "ribbon", "textCenter"].filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) };
    });
    // Şablon notları ve etiketleri kullanıcı metnidir: veri kaçışıyla.
    const out: BuilderToolContent[] = [{ type: "text", text: dataJson(summary) }];
    for (const t of list.slice(0, 6)) {
      const file = this.d.templates.imagePath(row.language_id, t);
      if (!existsSync(file)) continue;
      try {
        out.push({ type: "text", text: `template ${escapeData(t.key)}:` }, { type: "image", png: await sharp(file).resize(256, 256, { fit: "inside" }).png().toBuffer(), maxSide: 256 });
      } catch {
        /* görsel okunamadı */
      }
    }
    return out;
  }

  /** Motor denemesi (ücretsiz). `test`'te yalnız toplu ölçüler; `all` = ayrılmış küme dışındaki her kayıt. */
  private async engineTrialText(row: BuildRow, split: "test" | "all", limit: number, profile: Profile): Promise<string> {
    const lang = row.language_id;
    const templates = new Map(this.templateList(lang).map((t) => [t.key, t]));
    const env = new ReplayEnv({ fontDir: this.d.paths.fonts(lang), fallbackDirs: [this.d.paths.sharedFonts], templatePath: (t) => this.d.templates.imagePath(lang, t), referenceImagePath: () => null });
    try {
      const all = await this.measureRefs(row, profile, split === "test" ? "test" : "train");
      // Motor yalnız ölçüsü tam kayıtları tekrar edebilir (yüklenen örnekte: şablon ayrılmış, satırlar eşleşmiş, font onaylı).
      const numeric = all.filter((r) => r.quality === undefined || (r.quality === "exact" && !r.approx && r.sizesKnown !== false));
      const refs = env.replayable(numeric, profile, templates).slice(0, limit);
      if (!refs.length) throw new Error(split === "test" ? "no replayable samples in the held-out split" : "no replayable samples (template separated, lines matched and font confirmed are required)");
      const res = await engineTrial(env, refs, [{ label: "Draft", profile, templates }], { previews: 0 });
      const side = res.sides[0]!;
      const fails = new Map<string, number>();
      for (const m of side.perRef) if (!m.ok) fails.set(m.reason ?? "unknown", (fails.get(m.reason ?? "unknown") ?? 0) + 1);
      const worst =
        split === "test"
          ? []
          : side.perRef
              .filter((m) => !m.ok || !m.within10)
              .slice(0, 8)
              .map((m) => ({ id: m.id, templateKey: m.templateKey, ok: m.ok, reason: m.reason ?? null, sizeRatio: m.sizeRatio, dx: m.dx, dy: m.dy }));
      const body = formatReplay({ refs: res.refs.length, split: split === "test" ? "test" : "train", sides: [{ label: side.label, metrics: side.metrics as unknown as Record<string, number | null>, summary: side.summary as never, worst }] });
      const failText = fails.size ? `\nNot placed: ${[...fails].map(([k, n]) => `${k} × ${n}`).join("; ")}` : "";
      // Kimlikler ve şablon anahtarları veri: kaçışla.
      return escapeData(body + failText);
    } finally {
      env.clear();
    }
  }

  private installedFonts(languageId: string): string[] {
    const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)) : []);
    return [...list(this.d.paths.fonts(languageId)), ...list(this.d.paths.sharedFonts).map((f) => `${f} (fallback)`)].slice(0, 80);
  }

  private async sessionContext(row: BuildRow, measurement: StyleMeasurement | null): Promise<BuilderSessionContext> {
    const samples = [];
    for (const s of this.modelSamples(row.id).slice(0, MODEL_SAMPLES)) {
      const png = await this.files(row.id).read(s.id);
      samples.push({ id: s.id, caption: this.sampleCaption(s), ...(png ? { png } : {}) });
    }
    const fonts = this.installedFonts(row.language_id);
    return {
      locale: row.locale,
      labelTypes: rowLabelTypes(row),
      base: row.base === "published" && row.base_version ? { kind: "published", version: row.base_version } : { kind: "default" },
      measurementSummary: measurementText(measurement) || null,
      samples,
      facts: [
        `installed font files: ${fonts.length ? fonts.join(", ") : "none"}`,
        ...(samples.length ? [] : ["the user has no sample labels yet: build the language from answers only"]),
      ],
    };
  }

  // ================================================================ revizyonlar

  revisions(id: string): { revisions: RevisionSummary[] } {
    this.store.row(id);
    return { revisions: this.store.revisions(id).map(revisionSummary) };
  }

  revision(id: string, rev: number): RevisionDetail {
    const row = this.store.row(id);
    if (rev === 0) return { rev: 0, at: row.started_at, reason: null, summary: "", profile: baseProfile(row), changes: [] };
    const r = this.store.revision(id, rev);
    if (!r) throw fail("build-no-revision");
    return { rev: r.rev, at: r.at, reason: r.reason, summary: r.summary, profile: r.profile, changes: r.changes };
  }

  diff(id: string, from: number, to: number): RevisionDiff {
    const row = this.store.row(id);
    const changes = diffRevisions(baseProfile(row), this.store.revisions(id), from, to);
    if (!changes) throw fail("build-no-revision");
    return { from, to, changes };
  }

  /** "Sürüm N'e dön": eski verinin yeni revizyon olarak yazılması (geçmiş silinmez). */
  restore(id: string, body: { rev: number }): RevisionDetail {
    const row = this.store.row(id);
    this.requireStates(row, "restore");
    this.requireFree(row);
    const revisions = this.store.revisions(id);
    const target = profileAt(baseProfile(row), revisions, body.rev);
    if (!target) throw fail("build-no-revision");
    let rev = row.current_rev + 1;
    this.store.tx(() => {
      rev = this.keepForeignDraft(id, null);
      // Fark, taslağın bugünkü hâlinden (dışarıdan değiştiyse az önce saklanan `manual` revizyondan).
      const changes = ruleChanges(this.draftProfile(this.store.row(id)), target, () => ({ kind: "restore", ref: String(body.rev) }));
      const entry = this.notice(id, "restored", { rev, from: body.rev });
      this.store.insertRevision(id, row.language_id, { rev, reason: "restore", summary: "", profile: target, changes, entryId: entry.id, restoredFrom: body.rev, costUsd: 0 });
      this.store.update(id, { current_rev: rev });
      const draft = this.d.profiles.saveDraft(row.language_id, target, `Oluşturucu: revizyon ${body.rev}'e dönüldü`);
      this.d.events.emit({ type: "profile", languageId: row.language_id, version: draft.version });
      this.publish(row, { type: "revision", rev, reason: "restore", changeCount: changes.length, summary: "", entryId: entry.id });
    });
    this.addModelNotice(row, `The user restored revision ${body.rev}; it is now revision ${rev} (the draft). Re-read the draft before proposing.`);
    this.status(id);
    return this.revision(id, rev);
  }

  // ================================================================ yayın

  /**
   * Son revizyonu yayınlar. Oturum sürerken dilin başka bir sürümü yayınlandıysa (açılıştaki `start_version` ile
   * bugünkü farklı) ya da taslak bu oturumun dışında değiştiyse yayın o değişikliği sessizce ezmez: 409
   * `build-base-changed` (`baseVersion`, `publishedVersion`, `draftChanged`). Kullanıcı onaylarsa (`overwrite: true`)
   * oturumun son revizyonu yine yayınlanır.
   */
  publishBuild(id: string, body: { note?: string; overwrite?: boolean }): ProfileRecord {
    const row = this.store.row(id);
    this.requireStates(row, "publish");
    this.requireFree(row);
    if (row.current_rev === 0) throw fail("build-no-revision");
    const revisions = this.store.revisions(id);
    const last = revisions.at(-1)!;
    const note = body.note?.trim() || revisions.map((r) => r.summary).filter(Boolean).at(-1) || `Oluşturucu: revizyon ${last.rev}`;
    const rec = this.store.tx(() => {
      const live = this.d.profiles.active(row.language_id)?.version ?? null;
      const draft = this.d.profiles.draft(row.language_id);
      const draftChanged = !!draft && diffLeaves(last.profile, draft.data).length > 0;
      if ((live !== row.start_version || draftChanged) && body.overwrite !== true) {
        throw new HttpErrorWithBody(fail("build-base-changed"), { baseVersion: row.start_version, publishedVersion: live, draftChanged });
      }
      this.d.profiles.saveDraft(row.language_id, last.profile, note);
      const published = this.d.profiles.publish(row.language_id, note);
      this.store.update(id, { state: this.next(row, "publish"), turn_seq: null });
      this.notice(id, "published", { version: published.version });
      return published;
    });
    this.keepSamplesAsReferences(row, last.profile);
    this.status(id);
    return rec;
  }

  /** Yüklenen örnekler firmanın referansı olarak kalır (§9.2; kullanıcı tek tıkla silebilir). */
  private keepSamplesAsReferences(row: BuildRow, profile: Profile): void {
    for (const s of this.store.sampleRows(row.id)) {
      if (s.excluded || s.reference_id) continue;
      const m = measurementOf(s);
      if (!m) continue;
      const ref = sampleReference({ id: s.id, languageId: row.language_id, createdAt: s.created_at, split: s.split, measurement: m, fontFile: s.font_file, designFramePx: profile.output.designFramePx });
      if (!ref) continue;
      try {
        const saved = this.d.references.save(ref);
        this.store.updateSample(row.id, s.id, { reference_id: saved.id });
      } catch {
        /* referans yazılamadıysa örnek oturumda kalır */
      }
    }
  }

  // ================================================================ örnek etiketler

  private showcaseSpecs(row: BuildRow, locale: "tr" | "en"): ShowcaseSpec[] {
    const templates = this.templateList(row.language_id);
    const first = templates[0]?.key ?? null;
    const specs: ShowcaseSpec[] = [];
    for (const s of this.store.sampleRows(row.id)) {
      if (s.excluded) continue;
      const m = measurementOf(s);
      const lines = m?.lines.filter((l) => l.text && l.text.trim()) ?? [];
      if (!lines.length) continue;
      const key = s.template_key ?? m?.templateKey ?? first;
      specs.push({ id: `s-${s.id}`, labelType: null, sampleId: s.id, source: "sample", templateKey: key, text: lines.map((l) => l.text).join(" "), intent: (p) => sampleLinesIntent(lines, p, key) });
    }
    if (specs.length < 4) {
      const refs = this.d.references.list({ languageId: row.language_id, split: "train" }).filter((r) => r.quality === undefined && r.templateKey && templates.some((t) => t.key === r.templateKey));
      specs.push(...referenceSpecs(refs, 2));
    }
    specs.push(...presetSpecs(rowLabelTypes(row), locale, first));
    return specs;
  }

  async showcase(id: string, rev: number, locale: "tr" | "en"): Promise<ShowcaseResponse> {
    const row = this.store.row(id);
    if (rev > row.current_rev) throw fail("build-no-revision");
    const revisions = this.store.revisions(id);
    const base = baseProfile(row);
    const profile = profileAt(base, revisions, rev)!;
    const prev = rev > 0 ? profileAt(base, revisions, rev - 1) : null;
    const changes = rev > 0 ? (revisions.find((r) => r.rev === rev)?.changes ?? []) : [];
    const items = await this.showcaseRenderer.render({
      languageId: row.language_id,
      specs: this.showcaseSpecs(row, locale),
      profile,
      prev,
      changes,
      dir: this.showcaseDir(id, rev),
      url: (item) => apiPath(BUILDER_API.showcaseImage.path, { id, rev, item }),
    });
    return { items };
  }

  async showcaseImage(id: string, rev: number, item: string): Promise<Buffer> {
    this.store.row(id);
    const png = await this.showcaseRenderer.image(this.showcaseDir(id, rev), item);
    if (!png) throw fail("showcase-item-not-found");
    return png;
  }

  /** Oturumsuz örnek etiketler (Özet; kurulumdaki "Varsayılanla başla"). Görseller deneme önizlemesi olarak. */
  async languageShowcase(languageId: string, body: { source: "published" | "draft"; locale?: "tr" | "en" }): Promise<ShowcaseResponse> {
    const lang = this.d.languages.get(languageId);
    const rec = body.source === "draft" ? (this.d.profiles.draft(lang.id) ?? this.d.profiles.active(lang.id)) : this.d.profiles.active(lang.id);
    const profile = rec?.data ?? defaultProfile(lang.name);
    const setup = this.d.settings.getOrg<{ answers?: { labelTypes?: string[] } }>("setup", {});
    const types = (setup.answers?.labelTypes ?? []).filter((t): t is BuildLabelType => (BUILD_LABEL_TYPES as readonly string[]).includes(t));
    const templates = this.templateList(lang.id);
    const first = templates[0]?.key ?? null;
    const refs = this.d.references.list({ languageId: lang.id, split: "train" }).filter((r) => r.quality === undefined && r.templateKey && templates.some((t) => t.key === r.templateKey));
    const specs = [...referenceSpecs(refs, 2), ...presetSpecs(types, body.locale ?? currentOrg().locale, first)];
    const dir = path.join(this.d.paths.previews, "deneme");
    const ids = new Map<string, string>();
    const items = await this.showcaseRenderer.render({
      languageId: lang.id,
      specs: specs.map((s) => {
        const tid = randomUUID();
        ids.set(s.id, tid);
        return { ...s, id: tid };
      }),
      profile,
      prev: null,
      changes: [],
      dir,
      url: (item) => apiPath(API.trialPreview, { id: item }),
    });
    // Kimlik önizleme dosyasının kimliğidir (uuid); arayüz için kararlı anahtar yerine bunu döner.
    return { items };
  }

  // ================================================================ deneme ve kalite

  private profileForRev(row: BuildRow, rev: number | undefined): Profile {
    const r = rev ?? row.current_rev;
    if (r > row.current_rev) throw fail("build-no-revision");
    return profileAt(baseProfile(row), this.store.revisions(row.id), r)!;
  }

  async tryText(id: string, body: BuildTryRequest): Promise<ProfileTryResponse> {
    const row = this.store.row(id);
    const profile = this.profileForRev(row, body.rev);
    const engine = this.d.ports.engine;
    if (body.mode === "ai") {
      const estimateUsd = r6(estimateCost({ model: MODELS.daily, inputTokens: 12_500, outputTokens: 1_900 }) ?? 0);
      if (!body.confirm) return { estimateUsd, costUsd: 0, mode: "ai", results: [] };
      this.requireTryable(row);
      const designer = this.d.ports.designer;
      if (!designer) throw fail("ai-designer-unavailable");
      if (!engine) throw fail("layout-engine-unavailable");
      return this.paidTry(row, estimateUsd, async (res) => {
        const { side, costUsd } = await this.aiSide(row, profile, body.text, body.templateKey ?? null, res);
        return { estimateUsd, costUsd, mode: "ai" as const, results: [{ sampleId: "text", draft: side, published: null }] };
      });
    }
    if (!engine) throw fail("layout-engine-unavailable");
    const side = await this.engineSide(row, profile, body.text, body.templateKey ?? null);
    return { estimateUsd: 0, costUsd: 0, mode: "engine", results: [{ sampleId: "text", draft: side, published: null }] };
  }

  /**
   * Ücretli deneme (AI kipi deneme, AI kalite denemesi): yalnız etkin (yayınlanmamış, kapatılmamış) ve boştaki
   * oturumda; bütçe ayrılır (oturum ve aylık sınır) ve deneme sürerken oturumun iş kilidi tutulur (`jobs`, tür `try`):
   * tur ya da ölçüm aynı anda başlamaz, deneme de çalışan turla aynı anda başlamaz (409 `build-busy`).
   */
  private requireTryable(row: BuildRow): void {
    if (row.state === "published" || row.state === "closed") throw stateError(row.state);
    this.requireFree(row);
  }

  private async paidTry<T>(row: BuildRow, estimateUsd: number, fn: (res: Reservation) => Promise<T>): Promise<T> {
    this.requireTryable(row);
    const res = this.reserve(row, estimateUsd);
    const ctrl = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    this.jobs.set(row.id, { kind: "try", ctrl, done });
    try {
      return await fn(res);
    } finally {
      this.budget.release(res);
      if (this.jobs.get(row.id)?.ctrl === ctrl) this.jobs.delete(row.id);
      settle();
    }
  }

  private async tryTarget(row: BuildRow, profile: Profile, templateKey: string | null) {
    const key = templateKey ?? this.templateList(row.language_id)[0]?.key ?? null;
    if (!key) throw fail("template-key-not-found", { key: "—" });
    if (!this.d.templates.find(row.language_id, key)) throw fail("template-key-not-found", { key });
    return this.targets.resolve({ language_id: row.language_id, template_key: key, kind: "label" }, profile, profileKey(profile));
  }

  private async engineSide(row: BuildRow, profile: Profile, raw: string, templateKey: string | null) {
    const engine = this.d.ports.engine!;
    const target = await this.tryTarget(row, profile, templateKey);
    let si: ReturnType<typeof simpleIntent>;
    try {
      si = simpleIntent(raw, profile);
    } catch (err) {
      throw fail("trial-failed", { detail: errorMessage(err) });
    }
    const fontsDir = this.d.paths.fonts(row.language_id);
    const layout = await engine.layout({ intent: si.intent, text: si.text, profile, geometry: target.geometry, fontsDir });
    const png = await engine.render({ layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir });
    return this.trySideOf(layout, si.intent.lines.map((l) => l.text), png, null);
  }

  private async trySideOf(layout: LayoutResult, fallbackLines: string[], png: Buffer, costUsd: number | null): Promise<ProfileTrySide> {
    const pid = randomUUID();
    await writeAtomic(path.join(this.d.paths.previews, "deneme", `${pid}.png`), png);
    const lines = layout.lines.length ? layout.lines.map((l) => l.text) : fallbackLines;
    return {
      previewUrl: apiPath(API.trialPreview, { id: pid }),
      lines,
      sizesPx: layout.lines.map((l) => Math.round(l.sizePx * 100) / 100),
      issues: layout.issues.filter((i) => i.severity !== "info").length,
      issueList: layout.issues,
      costUsd,
      sameBreaksAsReference: null,
      sizeDiffVsReference: null,
    };
  }

  /** AI denemesi (Haiku tasarımcısı; aday sıralaması yapılmaz: en iyi motor puanı). Maliyet oturuma yazılır. */
  private async aiSide(row: BuildRow, profile: Profile, raw: string, templateKey: string | null, res: Reservation) {
    const engine = this.d.ports.engine!;
    const designer = this.d.ports.designer!;
    const target = await this.tryTarget(row, profile, templateKey);
    const s = normalizeText(raw);
    const fontsDir = this.d.paths.fonts(row.language_id);
    let costUsd = 0;
    const record = (calls: { purpose: string; model: string; summary: string; usage?: Usage | null; error?: string | null; durationMs: number }[]) => {
      for (const c of calls) {
        if (!c.usage) continue;
        const usd = this.store.recordCall(row.id, row.language_id, { purpose: `builder-try-${c.purpose}`, model: c.model, usage: c.usage, summary: c.summary, error: c.error ?? null, durationMs: c.durationMs });
        costUsd += usd;
        this.budget.charge(res, usd);
      }
    };
    try {
      // Geçit amacı `tagpress.builder_try_design` (kayıttaki `builder-try-*` ile aynı ad).
      const design = await withAiJob({ purposePrefix: "builder-try" }, () => designer.design({
        jobId: `olusturucu-${row.id}`,
        text: s.text,
        segments: s.segments,
        aiNote: "",
        kind: "label",
        profile,
        profileVersion: 0,
        template: target.template,
        sticker: null,
        geometry: target.geometry,
        previous: [],
        revision: null,
        candidates: 3,
        log: () => undefined,
        fontsDir,
        languageId: row.language_id,
      }));
      record(design.calls);
      let best: { layout: Awaited<ReturnType<typeof engine.layout>>; lines: string[] } | null = null;
      for (const cand of design.candidates) {
        const l = await engine.layout({ intent: cand, text: s.text, profile, geometry: target.geometry, fontsDir });
        if (l.ok && (!best || l.score.total > best.layout.score.total)) best = { layout: l, lines: cand.lines.map((x) => x.text) };
      }
      if (!best) throw fail("trial-failed", { detail: "Hiçbir aday şablona yerleştirilemedi." });
      const png = await engine.render({ layout: best.layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir });
      const side = await this.trySideOf(best.layout, best.lines, png, r6(costUsd));
      return { side, costUsd: r6(costUsd) };
    } catch (err) {
      const calls = (err as { calls?: Parameters<typeof record>[0] }).calls;
      if (Array.isArray(calls)) record(calls);
      throw err;
    } finally {
      this.addCost(row.id, costUsd);
    }
  }

  async quality(id: string, rev?: number): Promise<BuildQuality> {
    const row = this.store.row(id);
    const r = rev ?? row.current_rev;
    const profile = this.profileForRev(row, r);
    const measurable = this.store.sampleRows(id).filter((s) => !s.excluded && s.status === "measured");
    const testRows = measurable.filter((s) => s.split === "test");
    let test: BuildQuality["test"] = null;
    let testReason: BuildQuality["testReason"] = null;
    if (!measurable.length) testReason = "no-measurable";
    else if (!testRows.length) testReason = "too-few-samples";
    else {
      test = await this.engineQuality(row, profile, testRows.length);
      if (!test) testReason = "not-replayable";
    }
    const stored = (row.quality_ai ? JSON.parse(row.quality_ai) : null) as (NonNullable<BuildQuality["ai"]> & { rev: number }) | null;
    return { rev: r, test, testReason, ai: stored && stored.rev === r ? { n: stored.n, sameBreaks: stored.sameBreaks, sizeDiff: stored.sizeDiff, costUsd: stored.costUsd, at: stored.at } : null, invariants: this.invariants(row, r) };
  }

  private async engineQuality(row: BuildRow, profile: Profile, n: number): Promise<NonNullable<BuildQuality["test"]> | null> {
    const lang = row.language_id;
    const templates = new Map(this.templateList(lang).map((t) => [t.key, t]));
    const env = new ReplayEnv({ fontDir: this.d.paths.fonts(lang), fallbackDirs: [this.d.paths.sharedFonts], templatePath: (t) => this.d.templates.imagePath(lang, t), referenceImagePath: () => null });
    try {
      const refs = (await this.measureRefs(row, profile, "test")).filter((x) => x.source === "uploaded" && x.quality === "exact" && !x.approx && x.sizesKnown !== false);
      const ok = env.replayable(refs, profile, templates);
      if (!ok.length) return null;
      const res = await engineTrial(env, ok, [{ label: "Draft", profile, templates }], { previews: 0 });
      const m = res.sides[0]!.metrics as unknown as Record<string, number | null>;
      const num = (k: string) => (typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : null);
      return {
        n,
        failed: n - ok.length + (num("failed") ?? 0),
        within10: num("within10") ?? 0,
        positionPx: num("positionError"),
        gaps: { normal: num("gapNormal"), beforeLast: num("gapBeforeLast"), connector: num("gapConnector") },
      };
    } catch {
      return { n, failed: n, within10: 0, positionPx: null, gaps: { normal: null, beforeLast: null, connector: null } };
    } finally {
      env.clear();
    }
  }

  /** Her revizyonda değişmez denetimler: kanıtsız değer, müşteri metni bozulması, şema dışı yol (hepsi 0 olmalı). */
  private invariants(row: BuildRow, rev: number): BuildQuality["invariants"] {
    const revisions = this.store.revisions(row.id).filter((r) => r.rev <= rev);
    let unsupportedValues = 0;
    let outsideSchema = 0;
    for (const r of revisions) {
      for (const c of r.changes) {
        // Geri dönüş ve dışarıdan gelen taslak (`manual`) modelin önerisi değildir: yol denetimine girmez.
        if (!isWritableProfilePath(c.path) && r.reason !== "restore" && r.reason !== "manual") outsideSchema++;
        const k = c.source.kind;
        if (k === "measurement" ? !c.source.ref || c.source.n === undefined : k === "answer" || k === "correction" ? !c.source.ref || !this.store.userEntry(row.id, Number(c.source.ref)) : false) unsupportedValues++;
      }
    }
    const profile = profileAt(baseProfile(row), this.store.revisions(row.id), rev)!;
    const symbols = preservationSymbols(profile);
    const textChanged = profile.lineBreaking.examples.filter((e) => !checkTextPreserved(e.lines, e.text, symbols).ok).length;
    return { unsupportedValues, textChanged, outsideSchema };
  }

  async qualityAi(id: string, body: { rev?: number; confirm?: boolean }): Promise<{ estimateUsd: number; quality: BuildQuality | null }> {
    const row = this.store.row(id);
    const r = body.rev ?? row.current_rev;
    const profile = this.profileForRev(row, r);
    const testRows = this.store.sampleRows(id).filter((s) => !s.excluded && s.status === "measured" && s.split === "test");
    const per = estimateCost({ model: MODELS.daily, inputTokens: 12_500, outputTokens: 1_900 }) ?? 0;
    const estimateUsd = r6(per * testRows.length);
    if (!body.confirm) return { estimateUsd, quality: null };
    this.requireTryable(row);
    if (!testRows.length) throw fail("build-no-revision");
    if (!this.d.ports.designer) throw fail("ai-designer-unavailable");
    if (!this.d.ports.engine) throw fail("layout-engine-unavailable");
    let same = 0;
    const diffs: number[] = [];
    let cost = 0;
    await this.paidTry(row, estimateUsd, async (res) => {
      for (const s of testRows) {
        const m = measurementOf(s);
        const ref = m ? sampleReference({ id: s.id, languageId: row.language_id, createdAt: s.created_at, split: "test", measurement: m, fontFile: s.font_file, designFramePx: profile.output.designFramePx }) : null;
        if (!ref) continue;
        try {
          const { side, costUsd } = await this.aiSide(row, profile, ref.text, ref.templateKey, res);
          cost += costUsd;
          const cmp = compareWithReference(ref, side.lines, side.sizesPx);
          if (cmp.same) same++;
          if (cmp.diff !== null && ref.sizesKnown !== false) diffs.push(cmp.diff);
        } catch {
          /* yerleşmeyen örnek sayılmaz */
        }
      }
    });
    diffs.sort((a, b) => a - b);
    const ai = { rev: r, n: testRows.length, sameBreaks: testRows.length ? same / testRows.length : 0, sizeDiff: diffs.length ? diffs[Math.floor(diffs.length / 2)]! : null, costUsd: r6(cost), at: this.store.now() };
    this.store.update(id, { quality_ai: JSON.stringify(ai) });
    return { estimateUsd, quality: await this.quality(id, r) };
  }
}

// ================================================================ yardımcılar

function stateError(state: BuildState) {
  return new HttpErrorWithBody(fail("build-state"), { state });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function withNotices(input: BuilderUserInput, notices: readonly string[]): BuilderUserInput {
  return notices.length ? { ...input, notices: [...(input.notices ?? []), ...notices] } : input;
}

function inputEntry(e: BuildEntry, questions: readonly BuildQuestion[]): BuilderInputEntry {
  const q = e.answer ? questions.find((x) => x.id === e.answer!.questionId) : undefined;
  const opt = q && e.answer?.option !== null && e.answer?.option !== undefined ? q.options[e.answer.option] : undefined;
  return {
    entryId: e.id,
    kind: e.kind === "answer" ? "answer" : e.kind === "correction" ? "correction" : e.kind === "sample-edit" ? "sample-edit" : "note",
    ...(e.text ? { text: e.text } : {}),
    ...(q ? { question: { id: q.id, text: q.text } } : {}),
    ...(opt ? { option: { label: opt.label, ...(opt.value !== null && opt.value !== undefined ? { value: opt.value } : {}) } } : {}),
    ...(e.sampleEdit ? { sampleEdit: e.sampleEdit } : {}),
  };
}

/** Döngü sonucu → oturum hatası (kod ve "Devam et" anlamlı mı). */
function failureError(r: BuilderTurnResult): Omit<BuildError, "at"> {
  switch (r.stopReason) {
    case "refusal":
      return { code: "refusal", retryable: false };
    case "max_tokens":
      return { code: "max-tokens", retryable: true };
    case "invalid_tool_input":
      return { code: "internal", params: { detail: "invalid-tool-input" }, retryable: true };
    default: {
      const k = r.error?.kind;
      if (k === "auth" || k === "permission") return { code: "key-invalid", retryable: false };
      if (k === "quota") return { code: "quota-exceeded", retryable: false };
      if (k === "rate-limit") return { code: "rate-limited", retryable: true };
      if (k === "network" || k === "overloaded" || k === "server" || k === "timeout") return { code: "provider-unavailable", retryable: true };
      return { code: "internal", ...(r.error ? { params: { detail: r.error.message.slice(0, 200) } } : {}), retryable: true };
    }
  }
}

export type { BuilderMessage };
