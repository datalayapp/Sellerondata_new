import { AI_LIST_PRICES_USD, AI_MICROS_PER_UNIT, aiCostMicroUsd, aiPriceFor } from "@sellerondata/contracts";

/**
 * AI modelleri ve fiyatlar. Fiyatların TEK kaynağı platform sözleşmesidir (`@sellerondata/contracts` `AI_LIST_PRICES_USD`,
 * `aiPriceFor`, `aiCostMicroUsd`): yapay zekâ geçidinin defteri ile TagPress'in `ai_calls` kaydı aynı kuralla ve aynı
 * yuvarlamayla (satır başına mikro USD) hesaplanır; yerel kipte de. Fiyat değişirse yalnız sözleşme güncellenir.
 * Sözleşmenin kuralları: Haiku 5.5 kademesi istemin TAMAMINA bakar (girdi + önbellekten okuma + önbelleğe yazma), 1 saatlik
 * önbelleğe yazma ayrı fiyatlanır, tabloda olmayan model en pahalı fiyattan sayılır (eksik sayılmaz).
 */
export const MODELS = {
  /** Günlük üretim: tasarım, aday seçimi, görsel denetim, görseldeki yazıyı okuma. */
  daily: "claude-haiku-5-5",
  /** Görüntü üretimi (Nano Banana). */
  image: "gemini-3.1-flash-image",
  /** Sitede tasarım dili oluşturucu (çok turlu, görsele bakan araç döngüsü; plan §4.3). */
  builder: "claude-opus-5-5",
} as const;

/**
 * Önbellek yazımı, girdi fiyatının katı: 5 dakikalık 1,25 kat, 1 saatlik 2 kat (Anthropic fiyat sayfası; Opus 5.5'te
 * $5 ve $8 / MTok). Okuma her modelde ayrı (`cacheRead`). Ücret hesabı sözleşmenin açık değerlerini kullanır; bu katlar
 * tahmin ve ekran içindir.
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Ekrandaki fiyat özeti (USD / 1M token); sözleşme tablosundan türer. */
export interface ModelPrice {
  /** USD / 1M token. */
  input: number;
  output: number;
  cacheRead?: number;
  /** İstem bu kadar tokeni aşınca geçerli fiyat (istemin tamamı: girdi + önbellek okuma + yazma). */
  above?: { tokens: number; input: number; output: number };
  /** Görsel başına (görüntü modelleri). */
  perImage?: number;
}

/** Sözleşme tablosunun ekran biçimi (ayarlar ekranı, tahminler). Ücret `estimateCost` ile hesaplanır. */
export const PRICES: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(AI_LIST_PRICES_USD).map(([model, p]) => [
    model,
    {
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      ...(p.above ? { above: { tokens: p.above.promptTokens, input: p.above.price.input, output: p.above.price.output } } : {}),
      ...(p.perOutputImage ? { perImage: p.perOutputImage } : {}),
    } satisfies ModelPrice,
  ]),
);

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Önbelleğe yazılan token'ların TOPLAMI (5 dk + 1 sa; API'nin `cache_creation_input_tokens` alanı). */
  cacheWriteTokens?: number;
  /** Bunun 1 saatlik kısmı (`cache_creation.ephemeral_1h_input_tokens`); kalanı 5 dakikalık sayılır. */
  cacheWrite1hTokens?: number;
  images?: number;
  /** Platform kipi: yapay zekâ geçidinin çağrı kimliği (`x-sod-ai-call-id`); `ai_calls.gateway_call_id`'ye yazılır. */
  gatewayCallId?: string;
}

/** Model sözleşme tablosunda var mı (tarih ekli ad kökü dahil). Yoksa ücret en pahalı fiyattan sayılır. */
export function isPricedModel(model: string): boolean {
  return aiPriceFor(model).known;
}

/** Kullanımın sözleşme biçimi (geçidin ölçtüğü alanlar). Yazmanın 1 saatlik kısmı toplamı aşamaz; kalanı 5 dakikalık. */
export function meteredUsage(u: Usage): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; outputImages: number } {
  const writeTotal = Math.max(u.cacheWriteTokens ?? 0, u.cacheWrite1hTokens ?? 0, 0);
  const write1h = Math.min(Math.max(u.cacheWrite1hTokens ?? 0, 0), writeTotal);
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWrite5mTokens: writeTotal - write1h,
    cacheWrite1hTokens: write1h,
    outputImages: u.images ?? 0,
  };
}

/** Ücret, mikro USD tamsayı: geçidin defter satırıyla birebir aynı (`aiCostMicroUsd` + `aiPriceFor`). */
export function estimateCostMicroUsd(u: Usage): number {
  return aiCostMicroUsd(meteredUsage(u), aiPriceFor(u.model).price);
}

/**
 * Tahmini ücret (USD) = `estimateCostMicroUsd / 1.000.000`. Görüntü modelinde çıktı `max(çıktı tokeni × fiyat, görsel ×
 * görsel fiyatı)`. Tabloda olmayan model en pahalı fiyattan sayılır (`isPricedModel` false; para için güvenli yön).
 */
export function estimateCost(u: Usage): number {
  return estimateCostMicroUsd(u) / AI_MICROS_PER_UNIT;
}

// ---------------------------------------------------------------- yapay zekâ geçidi (platform kipi)

/**
 * Geçit sözleşmesinin TagPress'in kullandığı parçaları (`@sellerondata/contracts` `ai.ts`, `aiSpend.ts`): `@tagpress/ai`
 * istemcileri ve sunucu buradan alır. Ayrıntı ve kurallar sözleşmededir.
 */
export {
  AI_LIST_PRICES_USD,
  AI_UNKNOWN_MODEL_PRICE,
  aiCostMicroUsd,
  aiPriceFor,
  AI_GATEWAY_KEY_HEADERS,
  AI_GATEWAY_PATHS,
  AI_CHARGED_MAYBE,
  AI_HEADERS,
  AI_REJECT_KIND,
  aiContextHeaders,
  aiGatewayBaseUrl,
  aiGeminiPath,
  aiPurposeKey,
  aiRejectCodeOf,
  isAiRejectCode,
  type AiAllowance,
  type AiAllowanceState,
  type AiCallContext,
  type AiCallOrigin,
  type AiRejectCode,
  type AiRejectKind,
} from "@sellerondata/contracts";

/** Ürün anahtarı (geçit amaçları `tagpress.<amaç>`). */
export const AI_PRODUCT = "tagpress";
