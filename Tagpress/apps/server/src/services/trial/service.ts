import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  API,
  type DesignIntent,
  type Issue,
  type LayoutResult,
  MODELS,
  type Profile,
  type ProfileTryRequest,
  ProfileTryRequestSchema,
  type ProfileTryDebug,
  type ProfileTryResponse,
  type ProfileTrySide,
  type Reference,
  type Template,
  type TemplateTryRequest,
  TemplateTryRequestSchema,
  type TemplateTryResponse,
  TemplateSchema,
  apiPath,
  estimateCost,
  normalizeText,
  ptToPx,
} from "@tagpress/domain";
import { referenceToIntent } from "@tagpress/engine";
import { suggestArea } from "@tagpress/templates";
import { withAiJob } from "../../adapters/ai-gateway.ts";
import type { DataPaths } from "../../config.ts";
import type { AiCallRecord, AiErrorLike, Designer, Engine, Ports } from "../../ports.ts";
import { errorMessage, fail, failFields } from "../../util/errors.ts";
import { writeAtomic } from "../../util/files.ts";
import { PNG, safeJoin } from "../../util/safe-path.ts";
import type { CostService } from "../costs.ts";
import { TargetResolver, type Target } from "../generation/target.ts";
import { layoutSignature } from "../generation/text-flow.ts";
import { stickerSheetId } from "../import/rows.ts";
import type { ProfileService } from "../profiles.ts";
import type { ReferenceService } from "../references.ts";
import { deepMerge, type TemplateService } from "../templates.ts";
import { simpleIntent } from "./intent.ts";
import { requireAccess } from "../../org/access.ts";

/** Değiştirilemeyen şablon alanları (geçici yamada da). */
const IMMUTABLE = ["key", "languageId", "file", "hash", "width", "height"];
/** Deneme önizlemeleri bu kadar sonra silinir. */
const PREVIEW_TTL_MS = 24 * 60 * 60_000;
/** AI denemesi tahmini (bir örnek × bir profil): tasarım çağrısı (görsellerle) + aday sıralaması. */
const EST_USAGE = { model: MODELS.daily, inputTokens: 12_500, outputTokens: 1_900 };

const r2 = (v: number) => Math.round(v * 100) / 100;
const norm = (s: string) => s.replace(/\s+/gu, " ").trim().toLocaleLowerCase("tr");

interface Deps {
  paths: DataPaths;
  ports: Ports;
  templates: TemplateService;
  profiles: ProfileService;
  references: ReferenceService;
  costs: CostService;
}

/**
 * Denemeler: kalıcı varyasyon OLUŞTURMAZ. Şablon denemesi ve "Dene"nin motor modu AI'sızdır; "Dene"nin AI modu
 * gerçek tasarımcıyla çalışır ve maliyeti kaydeder. Önizlemeler `data/onizleme/deneme/` altında geçicidir.
 */
export class TrialService {
  private readonly targets: TargetResolver;

  constructor(private readonly d: Deps) {
    this.targets = new TargetResolver(d.ports, d.templates);
  }

  previewDir(): string {
    return path.join(this.d.paths.previews, "deneme");
  }

  previewFile(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fail("trial-preview-not-found");
    const file = safeJoin(this.previewDir(), `${id}.png`, { ext: PNG });
    if (!file || !existsSync(file)) throw fail("trial-preview-not-found");
    return file;
  }

  private engine(): Engine {
    if (!this.d.ports.engine) throw fail("layout-engine-unavailable");
    return this.d.ports.engine;
  }

  private profileOf(languageId: string, which: "draft" | "published"): { profile: Profile; version: number } | null {
    if (which === "published") return this.d.profiles.activeProfile(languageId);
    const draft = this.d.profiles.draft(languageId);
    return draft ? { profile: draft.data, version: draft.version } : null;
  }

  // ------------------------------------------------------------ şablon araçları

  /** Kayda yazılmadan geçici şablon (değiştirilemeyen alanlar yok sayılır). */
  private patched(template: Template, patch: Record<string, unknown> | undefined): Template {
    if (!patch) return template;
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => !IMMUTABLE.includes(k)));
    const r = TemplateSchema.loose().safeParse(deepMerge(template as Template & Record<string, unknown>, clean));
    if (!r.success) throw failFields("template-patch-invalid", r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })));
    return r.data as Template;
  }

  private templateOrThrow(languageId: string, key: string): { template: Template; imagePath: string } {
    const template = this.d.templates.find(languageId, key);
    if (!template) throw fail("template-key-not-found", { key });
    const imagePath = this.d.templates.imagePath(languageId, template);
    if (!existsSync(imagePath)) throw fail("template-image-not-found");
    return { template, imagePath };
  }

  async suggestArea(languageId: string, key: string, decoration: Record<string, unknown> | undefined) {
    const { template, imagePath } = this.templateOrThrow(languageId, key);
    const t = this.patched(template, decoration ? { decoration } : undefined);
    try {
      return { shape: await suggestArea(t, this.d.profiles.activeProfile(languageId).profile, imagePath) };
    } catch (err) {
      throw fail("trial-failed", { detail: errorMessage(err) });
    }
  }

  async templateTry(languageId: string, key: string, input: TemplateTryRequest): Promise<TemplateTryResponse> {
    const req = TemplateTryRequestSchema.parse(input);
    const geo = this.d.ports.geometry;
    if (!geo) throw fail("geometry-unavailable");
    const engine = this.engine();
    const p = this.profileOf(languageId, req.profile);
    if (!p) throw fail("no-draft-profile");
    const { template, imagePath } = this.templateOrThrow(languageId, key);
    const t = this.patched(template, req.patch);
    let geometry;
    try {
      geometry = await geo.forTemplate({ template: t, imagePath, profile: p.profile });
    } catch (err) {
      throw fail("trial-failed", { detail: errorMessage(err) });
    }
    const fontsDir = this.d.paths.fonts(languageId);
    const { text, intent } = this.intentOrThrow(req.text, p.profile);
    const layout = await engine.layout({ intent, text, profile: p.profile, geometry, fontsDir });
    const png = await engine.render({ layout, geometry, profile: p.profile, templatePath: imagePath, fontsDir });
    return {
      png: png.toString("base64"),
      lines: layout.lines.map((l) => l.text),
      basePt: layout.basePx ? r2(layout.basePx / ptToPx(p.profile, 1)) : 0,
      sizesPx: layout.lines.map((l) => r2(l.sizePx)),
      issues: layout.issues,
    };
  }

  private intentOrThrow(text: string, profile: Profile) {
    try {
      return simpleIntent(text, profile);
    } catch (err) {
      throw fail("trial-failed", { detail: errorMessage(err) });
    }
  }

  // ------------------------------------------------------------ tasarım dili denemesi

  async profileTry(languageId: string, input: ProfileTryRequest): Promise<ProfileTryResponse> {
    const req = ProfileTryRequestSchema.parse(input);
    const which = [...new Set(req.profiles)];
    const runs = req.samples.length * which.length;
    const estimateUsd = req.mode === "ai" ? r2((estimateCost(EST_USAGE) ?? 0) * runs * 10000) / 10000 : 0;
    if (req.dryRun) return { estimateUsd, costUsd: 0, mode: req.mode, results: [] };
    // Yapay zekâ denemesi ücretli: platform izni (`spend`; uç da `spend`).
    if (req.mode === "ai") requireAccess("spend");
    const engine = this.engine();
    if (req.mode === "ai" && !this.d.ports.designer) throw fail("ai-designer-unavailable");
    void this.purgePreviews();
    const profiles = Object.fromEntries(which.map((w) => [w, this.profileOf(languageId, w)])) as Record<"draft" | "published", { profile: Profile; version: number } | null>;
    let total = 0;
    const results: ProfileTryResponse["results"] = [];
    for (const sample of req.samples) {
      const result: ProfileTryResponse["results"][number] = { sampleId: sample.id, published: null, draft: null };
      const errors: string[] = [];
      let ref: Reference | null = null;
      if (sample.referenceId) {
        try {
          ref = this.d.references.get(sample.referenceId);
        } catch {
          errors.push("Referans bulunamadı.");
        }
      }
      for (const w of which) {
        const p = profiles[w];
        if (!p) {
          errors.push(w === "draft" ? "Taslak profil yok." : "Yayınlanmış profil yok.");
          continue;
        }
        try {
          // Geçit amacı `tagpress.deneme_*` (kayıttaki `deneme-*` ile aynı ad).
          const side = await withAiJob({ purposePrefix: "deneme" }, () => this.trySide(languageId, sample, ref, p, req.mode, engine, req.debug === true));
          total += side.costUsd ?? 0;
          result[w] = side;
        } catch (err) {
          const calls = (err as AiErrorLike)?.calls;
          if (Array.isArray(calls)) total += this.record(calls, languageId);
          errors.push(`${w === "draft" ? "Taslak" : "Yayınlanmış"}: ${errorMessage(err)}`);
        }
      }
      if (errors.length) result.error = errors.join(" · ");
      results.push(result);
    }
    return { estimateUsd, costUsd: Math.round(total * 1e6) / 1e6, mode: req.mode, results };
  }

  private record(calls: AiCallRecord[], languageId: string): number {
    let cost = 0;
    for (const c of calls) cost += this.d.costs.record({ ...c, purpose: `deneme-${c.purpose}` }, { languageId }).costUsd ?? 0;
    return cost;
  }

  private async target(languageId: string, templateKey: string | null, p: { profile: Profile; version: number }): Promise<Target> {
    const kind = stickerSheetId(templateKey) ? "sticker" : "label";
    return this.targets.resolve({ language_id: languageId, template_key: templateKey, kind }, p.profile, p.version);
  }

  private async trySide(
    languageId: string,
    sample: ProfileTryRequest["samples"][number],
    ref: Reference | null,
    p: { profile: Profile; version: number },
    mode: "ai" | "engine",
    engine: Engine,
    debug = false,
  ): Promise<ProfileTrySide> {
    const { profile } = p;
    let debugOut: ProfileTryDebug | null = null;
    const target = await this.target(languageId, sample.templateKey ?? ref?.templateKey ?? null, p);
    const fontsDir = this.d.paths.fonts(languageId);
    let intent: DesignIntent;
    let text: string;
    let cost: number | null = null;
    let layout: LayoutResult;
    let preview: Buffer | null = null;
    if (mode === "engine") {
      ({ intent, text } = ref ? referenceToIntent(ref, profile) : simpleIntent(sample.text, profile));
      layout = await engine.layout({ intent, text, profile, geometry: target.geometry, fontsDir });
    } else {
      const designer = this.d.ports.designer as Designer;
      const s = normalizeText(sample.text);
      text = s.text;
      const log = () => undefined;
      const design = await designer.design({
        jobId: `deneme-${sample.id}`,
        text,
        segments: s.segments,
        aiNote: "",
        kind: target.sticker ? "sticker" : "label",
        profile,
        profileVersion: p.version,
        template: target.template,
        sticker: target.sticker,
        geometry: target.geometry,
        previous: [],
        revision: null,
        candidates: 3,
        log,
        fontsDir,
        languageId,
        ...(ref ? { excludeReferenceId: ref.id } : {}),
      });
      cost = this.record(design.calls, languageId);
      // Üretim akışıyla aynı: yerleşmeyen ve öncekiyle aynı aday elenir (bkz. generation/text-flow.ts).
      const placed: { intent: DesignIntent; layout: LayoutResult; from: number }[] = [];
      const seen = new Set<string>();
      const dbgCands: ProfileTryDebug["candidates"] = [];
      for (const [k, cand] of design.candidates.entries()) {
        const l = await engine.layout({ intent: cand, text, profile, geometry: target.geometry, fontsDir });
        const sig = l.ok ? layoutSignature(cand, l) : "";
        const dup = l.ok && seen.has(sig);
        if (l.ok && !dup) {
          seen.add(sig);
          placed.push({ intent: cand, layout: l, from: k });
        }
        dbgCands.push({
          lines: cand.lines.map((x) => x.text),
          fonts: cand.lines.map((x) => x.fontId),
          tiers: cand.lines.map((x) => x.tier),
          rationale: cand.rationale ?? "",
          placed: l.ok && !dup,
          score: l.ok ? r2(l.score.total) : null,
          sizesPx: l.lines.map((x) => r2(x.sizePx)),
          ...(l.ok ? (dup ? { note: "öncekiyle aynı" } : {}) : { note: l.issues.map((x) => x.message).join("; ") || "yerleşmedi" }),
        });
      }
      if (!placed.length) throw new Error("Hiçbir aday şablona yerleştirilemedi.");
      let best = 0;
      let ranking = placed.map((_, i) => i);
      let pickInfo: { reasons?: string[]; summary?: string } = {};
      if (placed.length > 1) {
        const previews = await Promise.all(placed.map((c) => engine.render({ layout: c.layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir })));
        const pick = await designer.pick({ jobId: `deneme-${sample.id}`, text, profile, candidates: placed.map((c, i) => ({ intent: c.intent, layout: c.layout, preview: previews[i]! })), log });
        cost += this.record(pick.calls, languageId);
        const valid = pick.ranking.filter((i, k, a) => Number.isInteger(i) && i >= 0 && i < placed.length && a.indexOf(i) === k);
        ranking = [...valid, ...ranking.filter((i) => !valid.includes(i))];
        best = ranking[0] ?? 0;
        pickInfo = pick;
        preview = previews[best]!;
      }
      ({ intent, layout } = placed[best]!);
      if (debug) {
        const reasons = design.candidates.map(() => "");
        placed.forEach((c, i) => (reasons[c.from] = pickInfo.reasons?.[i] ?? ""));
        debugOut = { candidates: dbgCands, ranking: ranking.map((i) => placed[i]!.from), reasons, rankSummary: pickInfo.summary ?? "", chosen: placed[best]!.from };
      }
    }
    preview ??= await engine.render({ layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir });
    const id = randomUUID();
    await writeAtomic(path.join(this.previewDir(), `${id}.png`), preview);
    const lines = layout.lines.length ? layout.lines.map((l) => l.text) : intent.lines.map((l) => l.text);
    const sizesPx = layout.lines.map((l) => r2(l.sizePx));
    const issueList: Issue[] = layout.issues;
    const cmp = ref ? compareWithReference(ref, lines, sizesPx) : { same: null, diff: null };
    return {
      previewUrl: apiPath(API.trialPreview, { id }),
      lines,
      sizesPx,
      issues: issueList.filter((i) => i.severity !== "info").length,
      issueList,
      costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
      sameBreaksAsReference: cmp.same,
      sizeDiffVsReference: cmp.diff,
      ...(debugOut ? { debug: debugOut } : {}),
    };
  }

  /** 24 saatten eski deneme önizlemelerini siler. */
  async purgePreviews(now = Date.now()): Promise<number> {
    const dir = this.previewDir();
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir)) {
      const file = path.join(dir, f);
      try {
        if (now - statSync(file).mtimeMs > PREVIEW_TTL_MS) {
          await rm(file, { force: true });
          n++;
        }
      } catch {
        // eşzamanlı silme: önemsiz
      }
    }
    return n;
  }
}

/** Satır bölmesi aynı mı ve en büyük satırın boyut farkı (oran). */
export function compareWithReference(ref: Reference, lines: string[], sizesPx: number[]): { same: boolean; diff: number | null } {
  const user = ref.user.map((l) => l.text).filter((t) => t.trim());
  const same = user.length === lines.length && user.every((t, i) => norm(t) === norm(lines[i] ?? ""));
  const uMax = Math.max(0, ...ref.user.map((l) => l.sizePx));
  const eMax = Math.max(0, ...sizesPx);
  return { same, diff: uMax > 0 && eMax > 0 ? Math.round(Math.abs(eMax / uMax - 1) * 1000) / 1000 : null };
}
