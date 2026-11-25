import { BUILDER_COST_HINTS, CACHE_WRITE_1H_MULTIPLIER, estimateCost, isPricedModel, MODELS, PRICES, type Usage } from "@tagpress/domain";
import type { BuilderModelPort, BuilderResponse } from "./model.ts";

/**
 * Oluşturucunun kullanım ve maliyet hesabı. Fiyatlar tek yerde (`domain/ai.ts`); burada yalnız API yanıtından
 * `Usage` çıkarılır ve toplanır. 1 saatlik önbellek yazımı `cacheWrite1hTokens` ile ayrı fiyatlanır.
 */

/** Bir denemenin kullanımı. `kind`: istenen modelin denemesi ya da yedek modelin (`fallback_message`) denemesi. */
export interface BuilderUsage extends Usage {
  kind: "message" | "fallback_message";
  /** Akış yarıda kesildi: yalnız o ana kadar görülen sayılar (çıktı eksik olabilir; alt sınır). */
  partial?: boolean;
}

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
};

export function usageFromRaw(u: RawUsage, model: string, kind: BuilderUsage["kind"] = "message"): BuilderUsage {
  const write = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    kind,
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: Math.max(write, w1h),
    cacheWrite1hTokens: w1h,
  };
}

/**
 * Yanıtın kullanımı. Yedek model çalıştıysa `usage.iterations` deneme başına doğru kaynaktır (üst düzey `usage`
 * yalnız yanıtı üreten denemeyi kapsar): her deneme kendi modelinin fiyatıyla hesaplanır. Reddeden denemenin
 * faturalanıp faturalanmadığı belgede ayrıca anlatılıyor; burada güvenli yön seçildi, hepsi sayılır (üst sınır).
 */
export function usageFromResponse(r: BuilderResponse, requestedModel: string): BuilderUsage[] {
  const iterations = (r.usage as { iterations?: Array<RawUsage & { type?: string; model?: string }> | null }).iterations;
  // Platform kipi: geçidin çağrı kimliği yanıtın her kullanım satırına (bir geçit satırı yedek denemeleri de kapsar).
  const call = (u: BuilderUsage): BuilderUsage => (r.gatewayCallId ? { ...u, gatewayCallId: r.gatewayCallId } : u);
  if (Array.isArray(iterations) && iterations.some((i) => i.type === "fallback_message")) {
    return iterations
      .filter((i) => i.type === "message" || i.type === "fallback_message")
      .map((i) => call(usageFromRaw(i, i.type === "fallback_message" ? (i.model ?? r.model) : requestedModel, i.type === "fallback_message" ? "fallback_message" : "message")));
  }
  return [call(usageFromRaw(r.usage, r.model || requestedModel))];
}

export interface CostSummary {
  /** Denemelerin toplamı (USD; sözleşmenin fiyatı, `estimateCost`). */
  usd: number;
  /** Fiyat tablosunda olmayan modeller: tutarları sözleşmenin kuralıyla en pahalı fiyattan sayıldı (bilgi; günlüğe). */
  unpriced: string[];
  /** Bütçe için tutar; sözleşmede bilinmeyen model de en pahalı fiyattan sayıldığından `usd` ile aynıdır. */
  budgetUsd: number;
}

/**
 * Bütçe hesabındaki tutar (USD) = `estimateCost`: fiyatı bilinmeyen model sözleşmenin en pahalı fiyatıyla sayılır
 * (`aiPriceFor`), $0 sayılıp sınırı aşmaz. Geçidin defteriyle aynı tutar.
 */
export function budgetCostOf(u: Usage): number {
  return estimateCost(u);
}

export function costOf(usages: readonly Usage[]): CostSummary {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const u of usages) {
    if (!isPricedModel(u.model)) unpriced.add(u.model);
    usd += estimateCost(u);
  }
  return { usd, unpriced: [...unpriced], budgetUsd: usd };
}

/** Önbellek isabeti özeti (günlüğe yazılır). Toplam önek = girdi + okuma + yazma. */
export interface CacheSummary {
  inputTokens: number;
  readTokens: number;
  write5mTokens: number;
  write1hTokens: number;
  /** Okunan / toplam önek (0..1); istek yoksa 0. */
  hitRatio: number;
}

export function cacheSummary(usages: readonly Usage[]): CacheSummary {
  let input = 0;
  let read = 0;
  let w5 = 0;
  let w1 = 0;
  for (const u of usages) {
    input += u.inputTokens;
    read += u.cacheReadTokens ?? 0;
    const w = u.cacheWriteTokens ?? 0;
    const h = Math.min(u.cacheWrite1hTokens ?? 0, w);
    w1 += h;
    w5 += w - h;
  }
  const total = input + read + w5 + w1;
  return { inputTokens: input, readTokens: read, write5mTokens: w5, write1hTokens: w1, hitRatio: total ? read / total : 0 };
}

// ---------------------------------------------------------------- başlamadan tahmin

/**
 * 768 px'lik bir örnek görselin yaklaşık token sayısı (görsel belgesindeki genişlik × yükseklik / 750 kuralı; kare
 * görselde ≈ 786). Görseller yüklenmeden tahminde kullanılır; yüklendiyse önek `count_tokens` ile tam sayılır.
 * Opus 5.5'te `count_tokens` ile doğrulandı (2026-11-22): 768×768 → 787, 440×440 → 259, 384×384 → 199 token.
 */
export const BUILDER_IMAGE_TOKENS_ESTIMATE = 790;

/** Tahminin dayandığı istek sayıları: tipik oturumda alt ve üst (her istek öneki önbellekten okur). */
export const BUILDER_ESTIMATE_REQUESTS = { low: 6, high: 30 } as const;

export interface BuilderEstimate {
  /** Araçlar + sistem + oturum bağlamı (token). */
  prefixTokens: number;
  /** Sayım gerçek mi (`count_tokens`) yoksa görsel payı yaklaşık mı. */
  exact: boolean;
  lowUsd: number;
  highUsd: number;
}

/**
 * Oturum tahmini (plan §4.6). Önek bir kez 1 saatlik önbelleğe yazılır (girdi fiyatının 2 katı) ve her istekte okunur;
 * üstüne sözleşmedeki tur ipuçları (ilk taslak, soru ve düzeltme turları) ve örnek başına okuma (Haiku) eklenir.
 *  - alt: ilk taslak + 1 soru turu, 6 istek;
 *  - üst: ilk taslak + 4 soru + 4 düzeltme turu, 30 istek.
 * Sonuç sente yukarı yuvarlanır. Sayım ücretsizdir (`count_tokens`); `prefixTokens` dışarıdan sayılır
 * (`countBuilderPrefix`, `agent.ts`).
 */
export function estimateBuilderCost(input: { prefixTokens: number; samples: number; exact?: boolean; model?: string }): BuilderEstimate {
  const model = input.model ?? MODELS.builder;
  const p = PRICES[model];
  if (!p) throw new Error(`Fiyatı bilinmeyen model: ${model}`);
  const write = (input.prefixTokens * p.input * CACHE_WRITE_1H_MULTIPLIER) / 1e6;
  const read = (input.prefixTokens * (p.cacheRead ?? p.input)) / 1e6;
  const h = BUILDER_COST_HINTS;
  const transcribe = input.samples * h.transcribePerSampleUsd;
  const low = write + read * BUILDER_ESTIMATE_REQUESTS.low + h.firstDraftUsd + h.questionTurnUsd + transcribe;
  const high = write + read * BUILDER_ESTIMATE_REQUESTS.high + h.firstDraftUsd + 4 * h.questionTurnUsd + 4 * h.correctionTurnUsd + transcribe;
  const cents = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
  return { prefixTokens: input.prefixTokens, exact: input.exact ?? false, lowUsd: cents(low), highUsd: cents(high) };
}

/** Sahte ya da gerçek modelle sayım yapılabildiğini tip düzeyinde belirtmek için (yalnız `countTokens` gerekir). */
export type BuilderTokenCounter = Pick<BuilderModelPort, "model" | "countTokens">;
