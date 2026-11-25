import type { FixAction, Issue, IssueCode, JobPatch, JobSummary, VariantSummary } from "@tagpress/domain";
import { parseQuantity } from "../../ice-aktar/mantik/rows.ts";
import { shownVariant } from "./jobs.ts";

/**
 * Üretim sağ panelinin saf kararları: işin en yeni hâli, seçili seçenek, onay öncesi denetim, sorunların birleşmesi,
 * alanların kaydı ve sorun düzeltme adımı. Metin üretmez: kodlar döner, ekran sözlükten yazar.
 */

// ---------------------------------------------------------------- iş ve varyasyon

/** En yeni hâl: ayrıntı sorgusu listeden eskiyse (olay önce listeyi tazelediyse) liste verisi üstüne yazılır. */
export function freshestJob<D extends JobSummary>(detail: D | undefined, listJob: JobSummary): JobSummary & Partial<D> {
  return detail && detail.updatedAt >= listJob.updatedAt ? detail : ({ ...detail, ...listJob } as JobSummary & Partial<D>);
}

/** Seçili varyasyon: kullanıcının seçtiği (hâlâ varsa), yoksa öne çıkan (onaylı, AI sırası, puan). */
export function focusedVariant(variants: readonly VariantSummary[], focusId: string | null, job: Pick<JobSummary, "variants" | "approvedVariantId">): VariantSummary | null {
  return variants.find((v) => v.id === focusId) ?? shownVariant(job);
}

export type ApproveCheck = "skip" | "confirm-stale" | "ok";

/** Onay öncesi: varyasyon yoksa ya da zaten onaylıysa geç; eski metinle üretildiyse önce sor. */
export function approveCheck(v: Pick<VariantSummary, "approved" | "stale"> | null): ApproveCheck {
  if (!v || v.approved) return "skip";
  return v.stale ? "confirm-stale" : "ok";
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Aynı sorunun iş ve varyasyon düzeyinde iki kez görünmesini önler; ağır olan önce. */
export function mergeIssues(...lists: Array<readonly Issue[] | undefined>): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const list of lists)
    for (const i of list ?? []) {
      const key = `${i.code}|${i.message}|${i.field ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i);
    }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Metin alanından çıkış: değişmedi, boş (kabul edilmez, eski metne dönülür) ya da kaydet. */
export function textCommit(draft: string, current: string): "same" | "empty" | "save" {
  if (draft === current) return "same";
  if (!draft.trim()) return "empty";
  return "save";
}

/** Sipariş no alanı: boş bırakılırsa silinir. */
export const orderNoValue = (v: string): string | null => v.trim() || null;

// ---------------------------------------------------------------- sorun düzeltme

export type FixStep =
  | { do: "focus"; field: "text" | "quantity" | "order" | "size" }
  | { do: "patch"; patch: JobPatch; undo?: JobPatch }
  | { do: "pickTemplate" }
  | { do: "openTemplate"; key: string }
  | { do: "regenerate" }
  | { do: "revise"; request: string }
  | { do: "draftRevise"; request?: string }
  | { do: "refuse" }
  | { do: "none" };

/**
 * Sorunun düzeltme düğmesine basılınca ne olur (eski `Desk.fix`). `patch` sonucunda `undo` varsa ekran geri al
 * bildirimi gösterir (düz harfe çevirme). Müşteri metni yalnız kullanıcı bu düğmeye basınca değişir.
 */
export function fixStep(
  issue: Pick<Issue, "code" | "severity">,
  fix: Pick<FixAction, "kind" | "value">,
  job: { text: string; templateKey: string | null; dismissed?: readonly IssueCode[] },
  hasFocusedVariant: boolean,
): FixStep {
  switch (fix.kind) {
    case "edit-text":
      return { do: "focus", field: "text" };
    case "convert-unicode":
      return fix.value ? { do: "patch", patch: { text: fix.value }, undo: { text: job.text } } : { do: "focus", field: "text" };
    case "choose-template":
      return fix.value ? { do: "patch", patch: { templateKey: fix.value } } : { do: "pickTemplate" };
    case "set-size":
      return fix.value ? { do: "patch", patch: { labelSize: fix.value } } : { do: "focus", field: "size" };
    case "set-quantity":
      return fix.value ? { do: "patch", patch: { quantity: parseQuantity(fix.value) } } : { do: "focus", field: "quantity" };
    case "set-order":
      return { do: "focus", field: "order" };
    case "open-template": {
      const key = fix.value ?? job.templateKey;
      return key ? { do: "openTemplate", key } : { do: "none" };
    }
    case "regenerate":
      return { do: "regenerate" };
    case "revise":
      return fix.value && hasFocusedVariant ? { do: "revise", request: fix.value } : { do: "draftRevise", request: fix.value ?? undefined };
    case "skip":
    case "dismiss":
      if (issue.severity === "error") return { do: "refuse" };
      return { do: "patch", patch: { dismissed: [...new Set([...(job.dismissed ?? []), issue.code])] } };
    default:
      return { do: "none" };
  }
}
