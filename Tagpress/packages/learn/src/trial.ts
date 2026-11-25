import type { Profile, Reference, Template } from "@tagpress/domain";
import { type ReplayMetrics, type ReplaySummary, summarizeReplays } from "@tagpress/engine";
import { diffAll } from "./diff.ts";
import type { ReplayEnv } from "./env.ts";
import { type EvalMetrics, approxGapIndex, computeMetrics } from "./metrics.ts";
import { sideBySide, userPanel } from "./preview.ts";

/**
 * Motor denemesi (ücretsiz, AI'sız): seçilen referansların kullanıcı satırları bir ya da iki profille motora verilir.
 * İki profil verilirse (yayınlanan / taslak) önizlemeler farkın en büyük olduğu etiketlerden seçilir.
 */

export interface TrialSide {
  label: string;
  profile: Profile;
  templates: ReadonlyMap<string, Template>;
}

export interface EngineTrialResult {
  refs: string[];
  sides: Array<{ label: string; metrics: EvalMetrics; summary: ReplaySummary; perRef: ReplayMetrics[] }>;
  previews: Array<{ referenceId: string; png: Buffer }>;
}

/** Referans seçimi: verilen kümeden şablon çeşitliliği gözetilerek `limit` kadar (kararlı sıra). */
export function pickRefs(refs: readonly Reference[], limit: number): Reference[] {
  const byTpl = new Map<string, Reference[]>();
  for (const r of [...refs].sort((a, b) => a.id.localeCompare(b.id))) byTpl.set(r.templateKey ?? "", [...(byTpl.get(r.templateKey ?? "") ?? []), r]);
  const out: Reference[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const list of byTpl.values()) {
      if (list[i] && out.length < limit) {
        out.push(list[i]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

export async function engineTrial(env: ReplayEnv, refs: readonly Reference[], sides: readonly TrialSide[], opts: { previews?: number } = {}): Promise<EngineTrialResult> {
  const first = sides[0];
  if (!first) throw new Error("En az bir profil gerekli.");
  const approx = approxGapIndex(diffAll(refs, first.profile, first.templates));
  const results: EngineTrialResult["sides"] = [];
  for (const s of sides) {
    const m = await env.replayAll(refs, s.profile, s.templates);
    const list = [...m.values()];
    results.push({ label: s.label, metrics: computeMetrics(list, approx), summary: summarizeReplays(list), perRef: list });
  }
  const want = opts.previews ?? 3;
  const previews: EngineTrialResult["previews"] = [];
  if (want > 0) {
    const score = (m: ReplayMetrics | undefined) => (m && Number.isFinite(m.sizeRatio) ? Math.abs(m.sizeRatio - 1) * 100 + Math.hypot(m.dx, m.dy) / 2 : 100);
    const maps = results.map((r) => new Map(r.perRef.map((m) => [m.id, m])));
    // Tek profil: en kötü uyanlar; iki profil: en çok değişenler.
    const ranked = [...maps[0]!.keys()]
      .map((id) => ({ id, s: maps.length > 1 ? Math.abs(score(maps[0]!.get(id)) - score(maps[1]!.get(id))) : score(maps[0]!.get(id)) }))
      .sort((a, b) => b.s - a.s);
    const byId = new Map(refs.map((r) => [r.id, r]));
    for (const { id } of ranked) {
      if (previews.length >= want) break;
      const ref = byId.get(id)!;
      try {
        const panels: Array<{ label: string; png: Buffer }> = [];
        const t0 = first.templates.get(ref.templateKey ?? "") ?? null;
        const user = await userPanel(ref, first.profile, t0, env);
        if (user) panels.push({ label: "Son hâl (referans)", png: user });
        for (const s of sides) {
          const t = s.templates.get(ref.templateKey ?? "");
          if (t) panels.push({ label: s.label, png: await env.preview(ref, s.profile, t) });
        }
        if (panels.length) previews.push({ referenceId: id, png: await sideBySide(panels) });
      } catch {
        /* önizleme olmazsa geç */
      }
    }
  }
  return { refs: refs.map((r) => r.id), sides: results, previews };
}
