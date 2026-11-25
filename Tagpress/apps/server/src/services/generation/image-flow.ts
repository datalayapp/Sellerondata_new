import type { Issue, Profile, VariantSnapshot } from "@tagpress/domain";
import { canonicalText, fixMsg, issueMsg } from "@tagpress/domain";
import type { AiCallRecord, ImageGenerator } from "../../ports.ts";
import type { JobRow } from "../jobs/mapping.ts";
import type { TemplateService } from "../templates.ts";
import type { NewVariant } from "../variants.ts";
import { GenerationError, type Target } from "./target.ts";

interface Common {
  job: JobRow;
  profile: Profile;
  profileVersion: number;
  record: (call: AiCallRecord) => number | null;
  log: (step: string, message: string) => void;
}

/**
 * "Şablona yaz": sonuç = orijinal şablon + ayrılmış yazı katmanı. Şablon pikseli değişmez (ai paketi garanti eder,
 * `templateUntouched` ile bildirir); görseldeki yazı müşteri metniyle birebir karşılaştırılır.
 */
export async function runImageOnTemplate(
  gen: ImageGenerator,
  input: Common & { target: Target; revision: { fromVariantId: string; request: string } | null; currentPng?: Buffer | null },
): Promise<Omit<NewVariant, "jobId">> {
  const { job, target, log } = input;
  if (!target.template || !target.templatePath) throw new GenerationError("Şablona yazma için şablon gerekli (sticker desteklenmez).");
  log("image", "Görüntü modeli şablona yazıyor");
  const r = await gen.onTemplate({
    jobId: job.id,
    text: job.text,
    aiNote: job.ai_note,
    profile: input.profile,
    template: target.template,
    templatePath: target.templatePath,
    geometry: target.geometry,
    revision: input.revision ? { request: input.revision.request, currentPng: input.currentPng ?? null } : null,
    log,
  });
  let cost = 0;
  for (const c of r.calls) cost += input.record(c) ?? 0;
  const issues: Issue[] = [];
  if (!r.templateUntouched) {
    issues.push({
      ...issueMsg("image-template-changed"),
      severity: "error",
      fixes: [fixMsg("regenerate")],
    });
  }
  if (r.readText === null) {
    issues.push({ ...issueMsg("image-text-unreadable"), severity: "warning", fixes: [] });
  } else if (canonicalText(r.readText) !== canonicalText(job.text)) {
    issues.push({
      ...issueMsg("image-text-mismatch", { text: r.readText }),
      severity: "error",
      fixes: [fixMsg("regenerate")],
    });
  }
  log("image", issues.length ? `Görüntü kaydedildi, ${issues.length} sorun` : "Görüntü kaydedildi, yazı doğrulandı");
  const snapshot: VariantSnapshot = {
    languageId: job.language_id,
    profileVersion: input.profileVersion,
    templateKey: target.template.key,
    labelSize: job.label_size,
    text: job.text,
    model: r.model,
    promptVersion: r.promptVersion,
    costUsd: cost,
    revision: input.revision,
  };
  return {
    kind: "image-on-template",
    intent: null,
    layout: null,
    snapshot,
    preview: r.composite,
    textLayer: r.textLayer,
    image: { textBox: r.textBox, readText: r.readText },
    score: null,
    aiRank: null,
    suspect: issues.some((i) => i.severity !== "info"),
    issues,
    rationale: "",
  };
}

/** "Temadan şablon üret": yazısız yeni şablon → kütüphaneye `kind: generated` → normal metin akışına verilir. */
export async function generateTemplate(
  gen: ImageGenerator,
  templates: TemplateService,
  input: Common & { theme: string; keep: boolean; base: { width: number; height: number } },
) {
  const { job, log } = input;
  log("image", `Temadan şablon üretiliyor: "${input.theme}"`);
  const r = await gen.newTemplate({ jobId: job.id, theme: input.theme, profile: input.profile, width: input.base.width, height: input.base.height, log });
  let cost = 0;
  for (const c of r.calls) cost += input.record(c) ?? 0;
  const key = `uretilen-${job.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const { item } = await templates.upload(job.language_id, {
    key,
    fileName: `${key}.png`,
    png: r.png,
    kind: "generated",
    extra: {
      generatedFrom: { prompt: r.prompt, model: r.model, at: new Date().toISOString() },
      notes: input.theme,
      tags: input.keep ? ["uretilen"] : ["uretilen", "gecici"],
    },
  });
  log("image", `Yeni şablon kütüphaneye eklendi: ${key}`);
  return { template: item.template, cost };
}
