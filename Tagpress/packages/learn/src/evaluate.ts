import type { Profile, Reference, Template } from "@tagpress/domain";
import type { ReplayMetrics } from "@tagpress/engine";
import type { ReplayEnv } from "./env.ts";
import { type EvalMetrics, computeMetrics } from "./metrics.ts";
import { applyProfileChanges, applyTemplateChanges } from "./patch.ts";
import type { ProposalDraft } from "./propose.ts";

/**
 * Önerinin ayrılmış kümede (split: test) değerlendirmesi: yama uygulanır, kullanıcının satırları motorla yeniden
 * yerleştirilir (AI'sız tekrar), önce/sonra ölçüleri karşılaştırılır.
 */

export type Verdict = "better" | "same" | "worse" | "unmeasured";

export interface Evaluation {
  verdict: Verdict;
  /** Kanıt zayıf: ayrılmış kümede az örnek, iyileştirme yok ya da yan ölçüde gerileme. */
  weak: boolean;
  /** Öneri düşürülmeli (yeterli örnekte kötüleştirdi). */
  drop: boolean;
  reason: string;
  /** Ayrılmış kümede ölçülen etiket sayısı. */
  n: number;
  before: EvalMetrics | null;
  after: EvalMetrics | null;
  /** Önizleme için en çok değişen referanslar. */
  changedIds: string[];
  /** Sonraki ölçümlerin ham hâli (önizleme seçimi için). */
  afterReplays: Map<string, ReplayMetrics>;
}

export interface EvalContext {
  env: ReplayEnv;
  profile: Profile;
  templates: ReadonlyMap<string, Template>;
  /** Ayrılmış küme. */
  heldOut: readonly Reference[];
  /** Mevcut profille ayrılmış kümedeki tekrar sonuçları. */
  baseline: ReadonlyMap<string, ReplayMetrics>;
  /** Yaklaşık boşluk dizinleri (ölçüm sayılmayanlar). */
  approx: ReadonlyMap<string, Set<number>>;
  /** Ayrılmış kümede en az örnek: profil önerisi / şablon önerisi. */
  minHeldOut?: { profile: number; template: number };
}

const EPS = { size: 0.005, height: 0.005, gap: 0.005, position: 0.5 } as const;

function compare(primary: ProposalDraft["primary"], b: EvalMetrics, a: EvalMetrics): { verdict: Verdict; detail: string } {
  const by = (before: number | null, after: number | null, eps: number, label: string) => {
    if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) return { verdict: "unmeasured" as Verdict, detail: `${label} ölçülemedi` };
    if (after < before - eps) return { verdict: "better" as Verdict, detail: `${label} ${before.toFixed(3)} → ${after.toFixed(3)}` };
    if (after > before + eps) return { verdict: "worse" as Verdict, detail: `${label} ${before.toFixed(3)} → ${after.toFixed(3)}` };
    return { verdict: "same" as Verdict, detail: `${label} değişmedi (${before.toFixed(3)})` };
  };
  switch (primary) {
    case "size": {
      if (a.within10 > b.within10) return { verdict: "better", detail: `±%10 boyut ${b.within10} → ${a.within10}/${a.n}` };
      if (a.within10 < b.within10) return { verdict: "worse", detail: `±%10 boyut ${b.within10} → ${a.within10}/${a.n}` };
      return by(b.sizeError, a.sizeError, EPS.size, "boyut sapması");
    }
    case "height":
      return by(b.heightError, a.heightError, EPS.height, "blok yüksekliği sapması");
    case "gap:normal":
      return by(b.gapNormal, a.gapNormal, EPS.gap, "satır arası boşluk farkı");
    case "gap:beforeLast":
      return by(b.gapBeforeLast, a.gapBeforeLast, EPS.gap, "son satır öncesi boşluk farkı");
    case "gap:connector":
      return by(b.gapConnector, a.gapConnector, EPS.gap, "bağlaç çevresi boşluk farkı");
    case "position":
      return by(b.positionError, a.positionError, EPS.position, "blok merkezi uzaklığı (px)");
    case "none":
      return { verdict: "unmeasured", detail: "AI'sız tekrar bu ayarı ölçmüyor" };
  }
}

export async function evaluate(draft: ProposalDraft, ctx: EvalContext): Promise<Evaluation> {
  const minN = ctx.minHeldOut ?? { profile: 8, template: 2 };
  const empty = new Map<string, ReplayMetrics>();
  if (draft.kind === "ai" || draft.primary === "none") {
    return {
      verdict: "unmeasured",
      weak: true,
      drop: false,
      reason: draft.kind === "ai" ? "AI ayarı: etkisi yalnızca gerçek denemeyle (Dene) ölçülür." : "AI'sız tekrar bu ayarı ölçmüyor; Dene ile kontrol edin.",
      n: 0,
      before: null,
      after: null,
      changedIds: [],
      afterReplays: empty,
    };
  }
  const scopeKey = draft.scope.kind === "template" ? draft.scope.key : null;
  const set = ctx.heldOut.filter((r) => ctx.baseline.has(r.id) && (scopeKey === null || r.templateKey === scopeKey));
  const need = scopeKey === null ? minN.profile : minN.template;
  if (!set.length) {
    return { verdict: "unmeasured", weak: true, drop: false, reason: "Ayrılmış kümede bu kapsamda etiket yok; kanıt zayıf.", n: 0, before: null, after: null, changedIds: [], afterReplays: empty };
  }
  let profile: Profile;
  try {
    profile = applyProfileChanges(ctx.profile, draft.changes);
  } catch (err) {
    return { verdict: "unmeasured", weak: true, drop: true, reason: `Yama profili geçersiz kılıyor: ${err instanceof Error ? err.message : String(err)}`, n: 0, before: null, after: null, changedIds: [], afterReplays: empty };
  }
  const templates = applyTemplateChanges(ctx.templates, draft.changes);
  const after = await ctx.env.replayAll(set, profile, templates);
  const before = computeMetrics(set.map((r) => ctx.baseline.get(r.id)!), ctx.approx);
  const afterM = computeMetrics(set.map((r) => after.get(r.id)).filter((m): m is ReplayMetrics => !!m), ctx.approx);
  const { verdict, detail } = compare(draft.primary, before, afterM);

  // Yan ölçü: boyut tutması belirgin düşerse (birincil ölçü iyileşse bile) kanıt zayıf.
  const sizeDrop = before.within10 - afterM.within10;
  const sideRegression = draft.primary !== "size" && sizeDrop >= Math.max(2, Math.ceil(0.03 * set.length));
  const small = set.length < need;
  let weak = small || verdict !== "better" || sideRegression;
  const drop = verdict === "worse" && !small;
  let reason = detail;
  if (small) reason += ` · ayrılmış kümede yalnızca ${set.length} etiket (en az ${need})`;
  if (sideRegression) reason += ` · ±%10 boyut ${before.within10} → ${afterM.within10} geriledi`;
  if (verdict === "same") reason += " · iyileştirmedi";
  if (afterM.failed > before.failed) {
    weak = true;
    reason += ` · yerleşmeyen ${before.failed} → ${afterM.failed}`;
  }

  // En çok değişenler (önizleme).
  const change = (id: string) => {
    const b = ctx.baseline.get(id)!;
    const a = after.get(id);
    if (!a || !Number.isFinite(a.sizeRatio) || !Number.isFinite(b.sizeRatio)) return 0;
    return Math.abs(Math.abs(a.sizeRatio - 1) - Math.abs(b.sizeRatio - 1)) * 100 + Math.abs(Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
  };
  const changedIds = set
    .map((r) => ({ id: r.id, c: change(r.id) }))
    .filter((x) => x.c > 0.01)
    .sort((a, b) => b.c - a.c)
    .map((x) => x.id);

  return { verdict, weak, drop, reason, n: set.length, before, after: afterM, changedIds, afterReplays: after };
}
