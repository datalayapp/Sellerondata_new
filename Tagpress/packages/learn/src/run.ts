import type { Point, Profile, Reference, Template } from "@tagpress/domain";
import type { ReplayMetrics } from "@tagpress/engine";
import {
  type AdjustEvalMetrics,
  type AdjustObservation,
  type AdjustTemplateStats,
  type AdjustThresholds,
  adjustFindings,
  analyzeAdjust,
  evaluateAdjust,
  proposeFromAdjust,
} from "./adjust.ts";
import { type Aggregate, type AggregateOptions, aggregate } from "./aggregate.ts";
import { type RefDiff, diffAll } from "./diff.ts";
import type { ReplayEnv } from "./env.ts";
import { type Evaluation, evaluate } from "./evaluate.ts";
import { type EvalMetrics, approxGapIndex, computeMetrics } from "./metrics.ts";
import { applyProfileChanges, applyTemplateChanges, type PatchChange } from "./patch.ts";
import { comparisonPng } from "./preview.ts";
import { type PrimaryMetric, type ProposalDraft, propose } from "./propose.ts";

/**
 * "Düzeltmelerimden öğren" akışı: fark → toplama → öneri → ayrılmış kümede önce/sonra → önizleme.
 * Sonuç sunucuda öneri kayıtlarına (learn_proposals) dönüşür; hiçbir şey kendiliğinden uygulanmaz.
 */

export type LearnStep = "fark" | "olcum" | "oneri" | "test" | "deneme" | "onizleme" | "bitti";

export interface LearnProgress {
  step: LearnStep;
  done: number;
  total: number;
  message: string;
}

export interface LearnRunInput {
  profile: Profile;
  templates: readonly Template[];
  refs: readonly Reference[];
  env: ReplayEnv;
  thresholds?: Omit<AggregateOptions, "profile"> & Partial<AdjustThresholds>;
  /**
   * Uygulamadaki hafif düzeltmeler (adjust_log): şablon hedef merkezi önerisi. `usage`: şablon başına onaylanan
   * etiket sayısı ve bunlardan elle düzeltilenler (yalnızca açıklama için).
   */
  adjust?: { observations: readonly AdjustObservation[]; usage?: ReadonlyMap<string, { approved: number; adjusted: number }> };
  /** Öneri başına önizleme sayısı (varsayılan 2) ve toplam üst sınır (varsayılan 12). */
  previews?: { perProposal?: number; total?: number };
  minHeldOut?: { profile: number; template: number };
  onProgress?: (p: LearnProgress) => void;
  /** İptal: true dönerse akış ilk fırsatta durur. */
  cancelled?: () => boolean;
}

/** Arayüzün okuduğu kanıt biçimi (`evidence`). */
export interface ProposalEvidence {
  source: "learn-run";
  /** Önerinin kaynağı: bitmiş etiketler (referanslar) ya da uygulamadaki elle düzeltmeler. */
  origin: "reference" | "adjust";
  slug: string;
  kind: ProposalDraft["kind"];
  scope: ProposalDraft["scope"];
  /** Öneriyi doğuran örnek sayısı (eğitim kümesi). */
  count: number;
  stats: Record<string, unknown>;
  examples: string[];
  primary: PrimaryMetric;
  verdict: Evaluation["verdict"];
  weak: boolean;
  reason: string;
  /** Ayrılmış kümede önce/sonra (yalnızca ilgili ölçüler; tamamı `full` altında). */
  heldOut: {
    n: number;
    before: Record<string, number>;
    after: Record<string, number>;
    full: { before: EvalMetrics; after: EvalMetrics } | { before: AdjustEvalMetrics; after: AdjustEvalMetrics };
    /** Elle düzeltmelerde: dışarıda tutulan iş katı sayısı. */
    folds?: number;
  } | null;
  previews: Array<{ referenceId: string; file?: string; url?: string }>;
  /** Elle düzeltme önerilerinde örnek varyasyonlar (düzeltilmiş önizleme). */
  variants?: Array<{ variantId: string; jobId: string; url: string | null }>;
}

export interface LearnProposalResult {
  slug: string;
  title: string;
  summary: string;
  patch: PatchChange[];
  evidence: ProposalEvidence;
  previews: Array<{ referenceId: string; png: Buffer }>;
}

export interface LearnRunResult {
  counts: { refs: number; train: number; test: number; replayableTrain: number; replayableTest: number; adjust: number; adjustTemplates: number };
  baseline: { train: EvalMetrics | null; test: EvalMetrics | null };
  aggregate: Aggregate;
  /** Elle düzeltmelerin şablon bazında istatistiği. */
  adjust: AdjustTemplateStats[];
  proposals: LearnProposalResult[];
  dropped: Array<{ slug: string; title: string; reason: string }>;
  findings: string[];
  ms: number;
}

/** Arayüzde gösterilecek ölçüler: boyut, konum, yükseklik ve (varsa) ilgili boşluk. */
function uiMetrics(m: EvalMetrics, primary: PrimaryMetric): Record<string, number> {
  const out: Record<string, number> = { sizeWithin10: m.sizeWithin10, sizeError: m.sizeError, positionError: m.positionError, heightError: m.heightError };
  const gap = primary === "gap:normal" ? m.gapNormal : primary === "gap:beforeLast" ? m.gapBeforeLast : primary === "gap:connector" ? m.gapConnector : null;
  if (gap !== null) out[primary === "gap:normal" ? "gapNormal" : primary === "gap:beforeLast" ? "gapBeforeLast" : "gapConnector"] = gap;
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) delete out[k];
  return out;
}

const f2 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(2));

/** İnsan diline çevrilmiş bulgular (rapor ve öneri listesinin üstü). */
export function findingsOf(all: Aggregate): string[] {
  const out: string[] = [];
  const c = all.gaps.connector;
  const cw = all.gapsWithApprox.connector;
  if (cw && all.gapsApprox.connector) {
    out.push(
      `Bağlaç çevresi boşluk: bütün satırlarla ortanca ${f2(cw.median)} (n=${cw.n}), çok satırlı tek katmandan bölünmüş ${all.gapsApprox.connector} satır çifti hariç ${f2(c?.median)} (n=${c?.n ?? 0}). ` +
        "Bu çiftlerin mürekkep kutusu okuyucu tarafından katman kutusu dilimlenerek bulunuyor: aynı x/genişlik ve aralarında tam 0 boşluk. Gerçek ölçüm olmadıkları için istatistikten çıkarıldılar.",
    );
  }
  for (const k of ["normal", "beforeLast"] as const) {
    if (all.gapsApprox[k]) out.push(`${k === "normal" ? "Satır arası" : "Son satır öncesi"} boşlukta da ${all.gapsApprox[k]} yaklaşık çift çıkarıldı (ortanca ${f2(all.gapsWithApprox[k]?.median)} → ${f2(all.gaps[k]?.median)}).`);
  }
  if (all.sameBreaks.n) out.push(`Programın satır bölmesi ${all.sameBreaks.n} etiketin ${all.sameBreaks.same} tanesinde kullanıcınınkiyle aynı (kenar ayırıcıları ve büyük/küçük harf yok sayıldı).`);
  if (all.scale) out.push(`Bölmesi aynı etiketlerde kullanıcı en büyük satırı programınkinin ortanca ${f2(all.scale.median)} katı yapmış.`);
  if (all.separatorsOnly) out.push(`${all.separatorsOnly} etikette kullanıcı yalnızca satır sonu ayırıcılarını ("-", ",", "~", "•") silmiş; sistem metni değiştirmediği için bunlar fark sayılmadı.`);
  if (all.textEdited) out.push(`${all.textEdited} etikette referanstaki metin müşteri metninden farklı (elle düzeltme); bu etiketler örnek bölme önerisine alınmadı.`);
  if (all.fontChanges.length) out.push(`Font değişimi: ${all.fontChanges.slice(0, 4).map((x) => `${x.from} → ${x.to} (${x.count})`).join(", ")}.`);
  if (all.ribbonViolations) out.push(`${all.ribbonViolations} etikette kullanıcının yazısı şablonun kurdele bandına giriyor.`);
  return out;
}

export async function runLearning(input: LearnRunInput): Promise<LearnRunResult> {
  const t0 = Date.now();
  const { profile, env } = input;
  const tmap = new Map(input.templates.map((t) => [t.key, t]));
  const progress = (step: LearnStep, done: number, total: number, message: string) => input.onProgress?.({ step, done, total, message });
  const stop = () => {
    if (input.cancelled?.()) throw new Error("Öğrenme durduruldu.");
  };

  progress("fark", 0, 1, "Program ve kullanıcı satırları karşılaştırılıyor");
  const diffs: RefDiff[] = diffAll(input.refs, profile, tmap);
  const approx = approxGapIndex(diffs);
  const train = input.refs.filter((r) => r.split === "train");
  const test = input.refs.filter((r) => r.split === "test");
  const all = aggregate(diffs, { ...input.thresholds, profile });
  progress("fark", 1, 1, `${diffs.length} referans karşılaştırıldı`);
  stop();

  const trainReplay = await env.replayAll(train, profile, tmap, (d, n) => progress("olcum", d, n, `Eğitim kümesi motorla yeniden yerleştiriliyor (${d}/${n})`), input.cancelled);
  stop();
  progress("oneri", 0, 1, "Öneriler çıkarılıyor");
  const drafts = propose(profile, tmap, input.refs, { ...input.thresholds, diffs, replays: trainReplay, split: "train" });
  progress("oneri", 1, 1, `${drafts.length} aday öneri`);
  stop();

  const testReplay = await env.replayAll(test, profile, tmap, (d, n) => progress("test", d, n, `Ayrılmış küme ölçülüyor (${d}/${n})`), input.cancelled);
  stop();

  const proposals: LearnProposalResult[] = [];
  const dropped: LearnRunResult["dropped"] = [];
  const evaluated: Array<{ draft: ProposalDraft; ev: Evaluation }> = [];
  for (const [i, draft] of drafts.entries()) {
    progress("deneme", i, drafts.length, `Deneniyor: ${draft.title}`);
    const ev = await evaluate(draft, { env, profile, templates: tmap, heldOut: test, baseline: testReplay, approx, ...(input.minHeldOut ? { minHeldOut: input.minHeldOut } : {}) });
    if (ev.drop) dropped.push({ slug: draft.slug, title: draft.title, reason: ev.reason });
    else evaluated.push({ draft, ev });
    stop();
  }
  progress("deneme", drafts.length, drafts.length, `${evaluated.length} öneri kaldı, ${dropped.length} düşürüldü`);

  const perProposal = input.previews?.perProposal ?? 2;
  let budget = input.previews?.total ?? 12;
  const refById = new Map(input.refs.map((r) => [r.id, r]));
  for (const [i, { draft, ev }] of evaluated.entries()) {
    const previews: LearnProposalResult["previews"] = [];
    if (draft.kind === "motor" && budget > 0) {
      progress("onizleme", i, evaluated.length, `Önizleme: ${draft.title}`);
      const ids = [...ev.changedIds, ...draft.examples].filter((id, k, a) => a.indexOf(id) === k);
      const afterProfile = applyProfileChanges(profile, draft.changes);
      const afterTemplates = applyTemplateChanges(tmap, draft.changes);
      for (const id of ids) {
        if (previews.length >= perProposal || budget <= 0) break;
        const ref = refById.get(id);
        const tb = ref?.templateKey ? tmap.get(ref.templateKey) : undefined;
        const ta = ref?.templateKey ? afterTemplates.get(ref.templateKey) : undefined;
        if (!ref || !tb || !ta || ref.labelFramePx !== profile.output.designFramePx) continue;
        try {
          previews.push({ referenceId: id, png: await comparisonPng(ref, env, { profile, template: tb }, { profile: afterProfile, template: ta }) });
          budget--;
        } catch {
          /* önizleme olmazsa öneri yine kalır */
        }
      }
    }
    proposals.push({
      slug: draft.slug,
      title: draft.title,
      summary: draft.summary,
      patch: draft.changes,
      evidence: {
        source: "learn-run",
        origin: "reference",
        slug: draft.slug,
        kind: draft.kind,
        scope: draft.scope,
        count: draft.count,
        stats: draft.stats,
        examples: draft.examples,
        primary: draft.primary,
        verdict: ev.verdict,
        weak: ev.weak,
        reason: ev.reason,
        heldOut: ev.before && ev.after ? { n: ev.n, before: uiMetrics(ev.before, draft.primary), after: uiMetrics(ev.after, draft.primary), full: { before: ev.before, after: ev.after } } : null,
        previews: previews.map((p) => ({ referenceId: p.referenceId })),
      },
      previews,
    });
  }
  const adjust = await learnFromAdjust(input, tmap, drafts, proposals, dropped);
  progress("bitti", 1, 1, `${proposals.length} öneri hazır`);

  const ok = (m: ReadonlyMap<string, ReplayMetrics>) => [...m.values()];
  return {
    counts: {
      refs: input.refs.length,
      train: train.length,
      test: test.length,
      replayableTrain: trainReplay.size,
      replayableTest: testReplay.size,
      adjust: input.adjust?.observations.length ?? 0,
      adjustTemplates: adjust.stats.length,
    },
    baseline: {
      train: trainReplay.size ? computeMetrics(ok(trainReplay), approx) : null,
      test: testReplay.size ? computeMetrics(ok(testReplay), approx) : null,
    },
    aggregate: all,
    adjust: adjust.stats,
    proposals,
    dropped,
    findings: [...findingsOf(all), ...adjust.findings],
    ms: Date.now() - t0,
  };
}

/**
 * Elle düzeltmelerden şablon hedef merkezi önerileri: istatistik → öneri → dışarıda tutulan işlerle motorla önce/sonra.
 * Kötüleştiren (yeterli ölçümde) öneri düşürülür; diğerleri kanıtıyla öneri listesine eklenir.
 */
async function learnFromAdjust(
  input: LearnRunInput,
  tmap: ReadonlyMap<string, Template>,
  referenceDrafts: readonly ProposalDraft[],
  proposals: LearnProposalResult[],
  dropped: LearnRunResult["dropped"],
): Promise<{ stats: AdjustTemplateStats[]; findings: string[] }> {
  const obs = input.adjust?.observations ?? [];
  if (!obs.length) return { stats: [], findings: [] };
  const { profile, env } = input;
  const F = profile.output.designFramePx;
  const progress = (done: number, total: number, message: string) => input.onProgress?.({ step: "deneme", done, total, message });
  const stop = () => {
    if (input.cancelled?.()) throw new Error("Öğrenme durduruldu.");
  };
  // Geçerli hedef merkez motorun geometrisinden (şablondaki nokta serbest alanın dışındaysa motor en yakın içteki noktayı kullanır).
  const current = new Map<string, Point>();
  for (const key of new Set(obs.map((o) => o.templateKey).filter((k): k is string => !!k && tmap.has(k)))) {
    try {
      const g = await env.geometry(tmap.get(key)!, profile);
      current.set(key, { x: g.target.x / F, y: g.target.y / F });
    } catch {
      /* geometri kurulamazsa şablon kaydı ya da son düzeltme kaydı kullanılır */
    }
  }
  stop();
  const th = input.thresholds ?? {};
  const stats = analyzeAdjust(obs, tmap, { thresholds: th, framePx: F, current, ...(input.adjust?.usage ? { usage: input.adjust.usage } : {}) });
  const drafts = proposeFromAdjust(stats, tmap, F);
  const byId = new Map(obs.map((o) => [o.id, o]));
  const place = async (o: AdjustObservation, t: Template) => {
    if (!o.replay) return null;
    const r = await env.layoutIntent(o.replay.text, o.replay.intent, profile, t);
    return r.ok && r.lines.length ? r.ink : null;
  };
  for (const [i, draft] of drafts.entries()) {
    progress(i, drafts.length, `Elle düzeltmeler deneniyor: ${draft.title}`);
    const key = draft.scope.kind === "template" ? draft.scope.key : "";
    const stat = stats.find((s) => s.key === key)!;
    const ev = await evaluateAdjust(stat, tmap.get(key)!, obs, place, { framePx: F, minHeldOut: input.minHeldOut?.template ?? 2 });
    stop();
    if (ev.drop) {
      dropped.push({ slug: draft.slug, title: draft.title, reason: ev.reason });
      continue;
    }
    const both = referenceDrafts.some((d) => d.slug === `template:${key}:textCenter`);
    const ui = (m: AdjustEvalMetrics) => ({ positionError: m.positionError, sizeError: m.sizeError });
    proposals.push({
      slug: draft.slug,
      title: draft.title,
      summary: both ? `${draft.summary} Aynı şablon için bitmiş etiketlerden de bir merkez önerisi var; ikisinden yalnızca birini uygulayın.` : draft.summary,
      patch: draft.changes,
      evidence: {
        source: "learn-run",
        origin: "adjust",
        slug: draft.slug,
        kind: draft.kind,
        scope: draft.scope,
        count: draft.count,
        stats: draft.stats,
        examples: draft.examples,
        primary: draft.primary,
        verdict: ev.verdict,
        weak: ev.weak,
        reason: ev.reason,
        heldOut: ev.before && ev.after ? { n: ev.n, before: ui(ev.before), after: ui(ev.after), full: { before: ev.before, after: ev.after }, folds: ev.folds } : null,
        previews: [],
        variants: draft.examples.map((id) => ({ variantId: id, jobId: byId.get(id)?.jobId ?? "", url: byId.get(id)?.previewUrl ?? null })),
      },
      previews: [],
    });
  }
  return { stats, findings: adjustFindings(stats, obs, th) };
}
