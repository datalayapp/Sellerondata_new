import { type FeatureKey, type FeaturesPatchBody, type FeaturesResponse, ORG_API, type OrgResponse, SETUP_API } from "@tagpress/domain";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

/**
 * Firma, kurulum durumu ve özellik anahtarları (SUNUCU-PLANI §2.9, §3.4). Sorgu anahtarları: `["org"]` (firma +
 * kurulum + özellikler), `["features"]`, `["setup"]`. Özellik ya da kurulum değişince `refreshOrg` üçünü bayatlatır.
 */

/** Sözlük kimliği: anahtardaki nokta alt çizgi olur (`print.stickers` → `print_stickers`; `setup:feat.<kimlik>.name`). */
export function featureDictId(key: string): string {
  return key.replace(/\./g, "_");
}

export function useOrg(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: ["org"], queryFn: () => api.get<OrgResponse>(ORG_API.get.path), enabled: opts.enabled ?? true });
}

export function useFeatures() {
  return useQuery({ queryKey: ["features"], queryFn: () => api.get<FeaturesResponse>(SETUP_API.featuresGet.path) });
}

/** Özellik aç/kapat (`PATCH /api/features`); yanıt bütün görünümdür (bağımlılıklar dahil). */
export function patchFeatures(body: FeaturesPatchBody): Promise<FeaturesResponse> {
  return api.patch<FeaturesResponse>(SETUP_API.featuresPatch.path, body);
}

export function enableFeature(key: FeatureKey | string): Promise<FeaturesResponse> {
  return patchFeatures({ [key]: true } as FeaturesPatchBody);
}

/** Yeni özellik görünümünü önbelleğe yazar; firma ve kurulum sorguları yeniden çekilir. */
export function refreshOrg(qc: QueryClient, features?: FeaturesResponse): void {
  if (features) qc.setQueryData(["features"], features);
  else void qc.invalidateQueries({ queryKey: ["features"] });
  void qc.invalidateQueries({ queryKey: ["org"] });
  void qc.invalidateQueries({ queryKey: ["setup"] });
}

/** Etkin değeri değişen anahtarlar (önce → sonra). */
export function changedFeatures(before: Partial<Record<string, boolean>> | undefined, after: Partial<Record<string, boolean>>): string[] {
  if (!before) return [];
  return Object.keys(after).filter((k) => before[k] !== undefined && before[k] !== after[k]);
}
