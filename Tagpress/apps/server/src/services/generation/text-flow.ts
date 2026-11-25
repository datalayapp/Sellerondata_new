import { type DesignIntent, type Issue, type LayoutResult, type Profile, type VariantKind, type VariantSnapshot, checkTextPreserved } from "@tagpress/domain";
import type { AiCallRecord, Designer, Engine } from "../../ports.ts";
import type { JobRow } from "../jobs/mapping.ts";
import type { NewVariant } from "../variants.ts";
import { GenerationError, type Target } from "./target.ts";

/** Satır bölmesinde boşluğu değişebilecek sembol bağlaçlar (yalnızca harf olmayanlar). */
export function symbolConnectors(p: Profile): string[] {
  return p.connectors.allowSymbolSpacing ? p.connectors.words.filter((w) => w.trim() && !/[\p{L}\p{N}]/u.test(w)) : [];
}

/** Aynı satırlar + aynı fontlar + aynı sınıflar + aynı boyut = aynı tasarım. */
export function layoutSignature(intent: DesignIntent, layout: LayoutResult): string {
  return JSON.stringify([intent.lines.map((l) => [l.text, l.fontId, l.tier]), Math.round(layout.basePx * 2)]);
}

export interface TextFlowInput {
  job: JobRow;
  profile: Profile;
  profileVersion: number;
  target: Target;
  kind: VariantKind;
  previous: DesignIntent[];
  revision: { intent: DesignIntent | null; request: string; fromVariantId: string } | null;
  variantsPerRun: number;
  fontsDir: string;
  /** Çağrı kaydı (maliyeti döner). */
  record: (call: AiCallRecord) => number | null;
  log: (step: string, message: string) => void;
}

/**
 * Metin akışı: Designer (AI niyet adayları) → metin koruma denetimi → Engine (yerleşim) → aynıları ele →
 * önizleme → aday seçimi (AI) → kaydedilecek varyasyonlar.
 */
export async function runTextFlow(designer: Designer, engine: Engine, input: TextFlowInput): Promise<Omit<NewVariant, "jobId">[]> {
  const { job, profile, target, log } = input;
  let cost = 0;
  const take = (calls: AiCallRecord[]) => {
    for (const c of calls) cost += input.record(c) ?? 0;
  };

  log("ai", input.revision ? `Revizyon isteniyor: "${input.revision.request}"` : "AI'dan tasarım adayları isteniyor");
  const design = await designer.design({
    jobId: job.id,
    text: job.text,
    segments: JSON.parse(job.segments) as string[],
    aiNote: job.ai_note,
    kind: job.kind,
    profile,
    profileVersion: input.profileVersion,
    template: target.template,
    sticker: target.sticker,
    geometry: target.geometry,
    previous: input.previous,
    revision: input.revision ? { intent: input.revision.intent, request: input.revision.request } : null,
    candidates: 3,
    log,
    fontsDir: input.fontsDir,
    languageId: job.language_id,
  });
  take(design.calls);
  if (!design.candidates.length) throw new GenerationError("AI aday tasarım üretmedi.");

  const symbols = symbolConnectors(profile);
  const placed: { intent: DesignIntent; layout: LayoutResult }[] = [];
  const seen = new Set<string>();
  for (const [i, intent] of design.candidates.entries()) {
    const kept = checkTextPreserved(intent.lines.map((l) => l.text), job.text, symbols);
    if (!kept.ok) {
      // AI paketi zaten onarır; buraya bozuk aday gelirse kullanılmaz (müşteri metni asla değişmez).
      log("layout", `Aday ${i + 1} elendi: ${kept.problem}`);
      continue;
    }
    const layout = await engine.layout({ intent, text: job.text, profile, geometry: target.geometry, fontsDir: input.fontsDir });
    if (!layout.ok) {
      log("layout", `Aday ${i + 1} yerleşmedi: ${layout.issues.map((x) => x.message).join("; ") || "sığmadı"}`);
      continue;
    }
    const sig = layoutSignature(intent, layout);
    if (seen.has(sig)) {
      log("layout", `Aday ${i + 1} öncekiyle aynı, elendi`);
      continue;
    }
    seen.add(sig);
    placed.push({ intent, layout });
    log("layout", `Aday ${i + 1}: ${layout.lines.length} satır, puan ${Math.round(layout.score.total)}`);
  }
  if (!placed.length) throw new GenerationError("Hiçbir aday şablona yerleştirilemedi.", "no-layout");

  log("render", "Önizlemeler çiziliyor");
  const previews = await Promise.all(
    placed.map((p) => engine.render({ layout: p.layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir: input.fontsDir })),
  );

  let ranking = placed.map((_, i) => i);
  let reason = "";
  if (placed.length > 1) {
    log("pick", "AI en iyi adayı seçiyor");
    const pick = await designer.pick({
      jobId: job.id,
      text: job.text,
      profile,
      candidates: placed.map((p, i) => ({ intent: p.intent, layout: p.layout, preview: previews[i]! })),
      log,
    });
    take(pick.calls);
    const valid = pick.ranking.filter((i, k, a) => Number.isInteger(i) && i >= 0 && i < placed.length && a.indexOf(i) === k);
    ranking = [...valid, ...ranking.filter((i) => !valid.includes(i))];
    reason = pick.reason;
  }

  const chosen = ranking.slice(0, Math.max(1, input.variantsPerRun));
  const out: Omit<NewVariant, "jobId">[] = [];
  for (const [rank, idx] of chosen.entries()) {
    const { intent, layout } = placed[idx]!;
    const preview = previews[idx]!;
    const issues: Issue[] = [...layout.issues];
    const suspect = layout.score.total < profile.quality.suspectScore || issues.some((x) => x.severity === "error");
    const snapshot: VariantSnapshot = {
      languageId: job.language_id,
      profileVersion: input.profileVersion,
      templateKey: target.template?.key ?? job.template_key,
      labelSize: job.label_size,
      text: job.text,
      model: design.model,
      promptVersion: design.promptVersion,
      costUsd: null,
      revision: input.revision ? { fromVariantId: input.revision.fromVariantId, request: input.revision.request } : null,
    };
    out.push({
      kind: input.kind,
      intent,
      layout,
      snapshot,
      preview,
      score: layout.score.total,
      aiRank: placed.length > 1 ? rank + 1 : null,
      suspect,
      issues,
      rationale: [intent.rationale, rank === 0 ? reason : ""].filter(Boolean).join(" · "),
    });
  }
  // Turun maliyeti kaydedilen varyasyonlara bölünür.
  for (const v of out) v.snapshot.costUsd = cost / out.length;
  return out;
}
