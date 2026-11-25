import type { JobDetail, VariantDetail, VariantEditModel } from "@tagpress/domain";
import { ApiFailure } from "../../lib/api.ts";
import { useJob, useLabelSizes, useVariantDetail, useVariantEdit } from "../uretim/mantik/data.ts";
import { frameSideMm } from "./olcu.ts";

export type DuzeltModel =
  | { state: "error"; notAdjustable: boolean; error: unknown }
  | { state: "loading"; job?: JobDetail; variant?: VariantDetail }
  | { state: "ready"; model: VariantEditModel; frameMm: number; job?: JobDetail; variant?: VariantDetail };

/**
 * Düzelt'in verisi (sayfa, büyük pencere ve sağ paneldeki küçük tezgâh aynı yoldan): düzeltme modeli, varyasyon, iş ve
 * tasarım dilinin ölçüleri. Kare kenarı (mm) varyasyonun üretildiği boyuttan; profil okunamazsa yedek değer. Bilinene
 * kadar tuval çizilmez (`loading`).
 */
export function useDuzeltModel(variantId: string | null): DuzeltModel {
  const editQ = useVariantEdit(variantId);
  const variantQ = useVariantDetail(variantId);
  const model = editQ.data && editQ.data.variantId === variantId ? editQ.data : undefined;
  const jobQ = useJob(model?.jobId ?? variantQ.data?.jobId ?? null);
  const languageId = variantQ.data?.snapshot.languageId ?? jobQ.data?.languageId;
  const sizesQ = useLabelSizes(languageId);
  const job = jobQ.data;
  const variant = variantQ.data;

  if (!variantId || editQ.isError) {
    return { state: "error", notAdjustable: editQ.error instanceof ApiFailure && editQ.error.status === 422, error: variantId ? editQ.error : null };
  }
  const sizeKnown = variantQ.isError || (!!variant && (!languageId || !sizesQ.isPending));
  if (!model || !sizeKnown) return { state: "loading", job, variant };
  const frameMm = frameSideMm({ sizes: sizesQ.data?.sizes, labelSize: variant?.snapshot.labelSize ?? job?.labelSize, defaultSize: sizesQ.data?.defaultSize, designFramePx: model.framePx });
  return { state: "ready", model, frameMm, job, variant };
}
