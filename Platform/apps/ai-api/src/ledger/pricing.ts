import {
  AI_LIST_PRICES_USD,
  AI_TRY_PER_USD_DEFAULT,
  aiCostMicroUsd,
  aiPriceFor,
  aiPriceVersion,
  type AiMeteredUsage,
  type AiPrice,
} from '@sellerondata/contracts';

/**
 * Defterin fiyat kuralları (tek kaynak `contracts/src/ai.ts`; burada yalnız geçidin seçimleri):
 * - Ücret yanıtı veren modelin fiyatıyla (`servedModel`, yoksa istenen); tabloda olmayan model en pahalı fiyattan (`aiPriceFor`).
 *   Yanıtta `usage.iterations` varsa (sunucu tarafı yedek model) her kalem kendi modeliyle fiyatlanır, toplanır.
 * - Pay (kabulde ayrılan yaklaşık üst sınır): `max_tokens` × çıktı fiyatı + gövdeden tahmini girdi (`estimateInput`). Girdi düz
 *   girdi fiyatından; gövdede `cache_control` varsa 5 dk yazma, `ttl: "1h"` varsa 1 saatlik yazma fiyatından (R2 2026-11-22: eskiden
 *   her zaman 1 sa yazma fiyatıydı, pay 2 kat şişiyordu). Gövdede açıkça yedek model (`fallbacks: [{model}]`) varsa pay en pahalısından.
 *   Pay kesin bir üst sınır değildir (belge ve görsel tokeni bayttan kaba tahmin); çağrının gerçek tutarı kapanışta yazılır.
 * - Kesilen çağrının tahmini (DeciShip `cancelledUsage`): bilinmeyen kısım FAZLA sayılır.
 */

export const PRICE_TABLE: Readonly<Record<string, AiPrice>> = AI_LIST_PRICES_USD;

/** Üst sınırda girdi tokeninin tavanı ve bayt → token oranı (kötü durum; olağan metin 3–4 bayt/token). DeciShip ile aynı. */
export const UPPER_INPUT_TOKENS_CAP = 200_000;
const UPPER_BYTES_PER_TOKEN = 2;
const UPPER_OVERHEAD_TOKENS = 1_000;
/** `max_tokens` / `maxOutputTokens` yoksa (sağlayıcı zaten reddeder ya da kendi varsayılanını kullanır) payda sayılan çıktı. */
export const DEFAULT_UPPER_OUTPUT_TOKENS = 32_768;
/** Kesilen çağrıda saniyede üretilen çıktı tokeni (DeciShip `AI_CANCEL_OUTPUT_TOKENS_PER_SEC`). */
export const CANCEL_OUTPUT_TOKENS_PER_SEC = 110;
/** Akan metnin karakter / token oranı (DeciShip `AI_CHARS_PER_OUTPUT_TOKEN`). */
export const CHARS_PER_OUTPUT_TOKEN = 3.5;

/** Ekran kuru: `AI_PRICE_TRY_PER_USD` (DeciShip ile aynı ad), yoksa ya da geçersizse 100. Satıra `priceVersion` içinde yazılır. */
export function tryPerUsd(): number {
  const raw = process.env.AI_PRICE_TRY_PER_USD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : AI_TRY_PER_USD_DEFAULT;
}

let versionCache: { rate: number; version: string } | null = null;

export function currentPriceVersion(): string {
  const rate = tryPerUsd();
  if (versionCache?.rate !== rate) versionCache = { rate, version: aiPriceVersion(PRICE_TABLE, rate) };
  return versionCache.version;
}

export type UsageIteration = AiMeteredUsage & { model: string | null };

/** Ölçülen kullanım: toplamlar + (varsa) kalemler. */
export type MeteredUsage = Required<AiMeteredUsage> & { iterations: UsageIteration[] | null };

export const ZERO_USAGE: MeteredUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputImages: 0,
  iterations: null,
}) as MeteredUsage;

export function priceOf(model: string): { price: AiPrice; known: boolean } {
  return aiPriceFor(model, PRICE_TABLE);
}

/** Satırın ücreti (mikro USD tamsayı) ve tabloda bulunamayan modeller (bir kez uyarı için). */
export function costOf(usage: MeteredUsage, model: string): { costMicroUsd: number; unknownModels: string[] } {
  const unknown = new Set<string>();
  const one = (u: AiMeteredUsage, m: string) => {
    const { price, known } = priceOf(m);
    if (!known) unknown.add(m);
    return aiCostMicroUsd(u, price);
  };
  if (usage.iterations?.length) {
    let total = 0;
    for (const it of usage.iterations) total += one(it, it.model || model);
    return { costMicroUsd: total, unknownModels: [...unknown] };
  }
  return { costMicroUsd: one(usage, model), unknownModels: [...unknown] };
}

/** Gövde baytından girdi tokeninin üst tahmini (gövdesi çözülemeyen istek; metin kuralı). */
export function upperInputTokens(bodyBytes: number): number {
  const bytes = Number.isFinite(bodyBytes) && bodyBytes > 0 ? bodyBytes : 0;
  return Math.min(UPPER_INPUT_TOKENS_CAP, Math.ceil(bytes / UPPER_BYTES_PER_TOKEN) + UPPER_OVERHEAD_TOKENS);
}

/**
 * Base64 alanlarının kaba token tahmini (R2 2026-11-22). Eskiden bütün gövde bayt / 2 sayılıyordu: 1,5 MB'lık PDF (≈2 MB base64)
 * 1 milyon token tahmin edip tavana (200.000) dayanıyordu. Sağlayıcı belgeyi ve görseli bayta göre değil, sayfa ve piksele göre
 * sayar; bayttan kesin hesap yok, katsayılar bilinçli olarak cömerttir:
 * - Görsel: sağlayıcı görseli küçültür (Anthropic yaklaşık 1.600 token, yüksek çözünürlüklü modellerde birkaç bin; Gemini 258–1.120
 *   ya da 768 piksellik parça başına 258): boyundan bağımsız görsel başına `IMAGE_TOKENS`.
 * - PDF: sayfa başına metin (1.500–3.000) + sayfa görüntüsü (≈1.600) token. Sayfa sayısı güvenilir okunamaz (sayfa nesneleri çoğu
 *   kez sıkıştırılmış nesne akışında); metin PDF'inde sayfa 5–50 KB, taranmışta 100 KB üstü. Çözülmüş bayt / `PDF_BYTES_PER_TOKEN`
 *   (≈0,125 token/bayt) + belge başına bir sayfa (`PDF_DOC_TOKENS`): taranmış belgede fazla, çok sıkı metin PDF'inde eksik kalabilir.
 * - Başka belge (düz metin vb.): çözülmüş bayt / 2 (metin kuralı).
 * Gövdenin geri kalanı (JSON, metin): bayt / 2 + 1.000. Toplam en çok `UPPER_INPUT_TOKENS_CAP`.
 */
export const IMAGE_TOKENS = 5_000;
export const PDF_BYTES_PER_TOKEN = 8;
export const PDF_DOC_TOKENS = 3_000;
/** Gövdede gezilecek en çok düğüm (32 MB JSON'da da sınırlı iş); aşılırsa kalan kısım metin kuralıyla sayılır. */
const MAX_SCAN_NODES = 500_000;

export type InputPriceKind = 'input' | 'write5m' | 'write1h';

/** Gövdeden girdinin tahmini ve fiyat kalemi (önbelleğe yazma isteniyorsa yazma fiyatı). */
export function estimateInput(body: unknown, bodyBytes: number): { inputTokens: number; inputKind: InputPriceKind } {
  const bytes = Number.isFinite(bodyBytes) && bodyBytes > 0 ? bodyBytes : 0;
  let b64Chars = 0;
  let b64Tokens = 0;
  let inputKind: InputPriceKind = 'input';
  const stack: unknown[] = [body];
  let visited = 0;
  while (stack.length && visited < MAX_SCAN_NODES) {
    const node = stack.pop();
    visited += 1;
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') stack.push(v);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const rec = node as Record<string, unknown>;
    const media = rec.media_type ?? rec.mimeType ?? rec.mime_type;
    if (typeof rec.data === 'string' && typeof media === 'string') {
      // Anthropic düz metin belgesi (`source.type: 'text'`) base64 değildir.
      const decoded = rec.type === 'text' ? rec.data.length : Math.floor((rec.data.length * 3) / 4);
      const type = media.trim().toLowerCase();
      b64Chars += rec.data.length;
      if (type.startsWith('image/')) b64Tokens += IMAGE_TOKENS;
      else if (type === 'application/pdf') b64Tokens += Math.ceil(decoded / PDF_BYTES_PER_TOKEN) + PDF_DOC_TOKENS;
      else b64Tokens += Math.ceil(decoded / UPPER_BYTES_PER_TOKEN);
    }
    const cc = rec.cache_control;
    if (cc && typeof cc === 'object' && !Array.isArray(cc)) {
      if ((cc as { ttl?: unknown }).ttl === '1h') inputKind = 'write1h';
      else if (inputKind === 'input') inputKind = 'write5m';
    }
    for (const [k, v] of Object.entries(rec)) if (k !== 'data' && v && typeof v === 'object') stack.push(v);
  }
  const rest = Math.max(0, bytes - b64Chars);
  const tokens = Math.ceil(rest / UPPER_BYTES_PER_TOKEN) + UPPER_OVERHEAD_TOKENS + b64Tokens;
  return { inputTokens: Math.min(UPPER_INPUT_TOKENS_CAP, tokens), inputKind };
}

export type UpperBound = {
  /** Girdi tokeninin üst tahmini. */
  inputTokens: number;
  /** Çıktı tokeninin üst sınırı (`max_tokens`). */
  outputTokens: number;
  /** Üretilebilecek görsel sayısı (Gemini görsel modeli). */
  outputImages: number;
  /** Girdinin fiyat kalemi (yoksa düz girdi). */
  inputKind?: InputPriceKind;
  /** Gövdede adı geçen yedek modeller (`fallbacks`): pay istenen ve bunların en pahalısından. */
  fallbackModels?: readonly string[];
};

/**
 * Payın tutarı: girdi `inputKind` kalemiyle (kademeli fiyatta istem uzunluğu kademeyi seçer), istenen ve yedek modellerin en
 * pahalısından.
 */
export function upperMicroUsd(bound: UpperBound, model: string): number {
  const kind = bound.inputKind ?? 'input';
  const usage: AiMeteredUsage = {
    inputTokens: kind === 'input' ? bound.inputTokens : 0,
    outputTokens: bound.outputTokens,
    cacheReadTokens: 0,
    cacheWrite5mTokens: kind === 'write5m' ? bound.inputTokens : 0,
    cacheWrite1hTokens: kind === 'write1h' ? bound.inputTokens : 0,
    outputImages: bound.outputImages,
  };
  let max = 0;
  for (const m of [model, ...(bound.fallbackModels ?? [])]) max = Math.max(max, aiCostMicroUsd(usage, priceOf(m).price));
  return max;
}

/**
 * Geçidin fiyatlayamadığı ya da tanımadığı ücretli özellikler (R2 2026-11-22). Ücretli yolda (`messages`, `generate`) gövdede varsa
 * istek reddedilir (`sod_model_not_allowed`), sağlayıcıya gitmez. Basit ve güvenli kural:
 * - Anthropic `tools`: yalnız aracın kendi araçları (`type` yok ya da `custom`). Sağlayıcı tanımlı araçlar (web arama, web getirme, kod
 *   çalıştırma, danışman, araç arama, MCP, bash, metin düzenleyici…) ayrıca ücretlenir ya da başka modeli çağırır; fiyat tablosunda
 *   yok (`usage.server_tool_use` fiyatsız kalırdı). `mcp_servers` de aynı nedenle.
 * - Gemini `tools`: yalnız `functionDeclarations` (Google araması ve haritaları ayrıca ücretlenir).
 * - `fallbacks` (sunucu tarafı yedek model): `"default"` kabul (Anthropic'in önerdiği zincir; bugün izinli modellerde aynı fiyat
 *   basamağı: Sonnet 5.5 → Sonnet 5); dizi biçiminde her model Anthropic modeli olmalı ve fiyat tablosunda bulunmalı (aracın izin
 *   listesi aranmaz: kayıttaki `ai.models` yalnız istenen modeli sınırlar, TagPress Opus 5.5 → Opus 5 yedeği gibi). Pay bu modellerin
 *   en pahalısından, çıktı üst sınırı girişlerdeki `max_tokens`'ların en büyüğü. Başka biçim reddedilir.
 */
export function paidFeatures(
  provider: 'anthropic' | 'gemini',
  body: Record<string, unknown>,
): { ok: true; fallbackModels: string[]; fallbackMaxTokens: number } | { ok: false; message: string } {
  const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const tools = body.tools;
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) return { ok: false, message: 'tools must be an array' };
  if (provider === 'gemini') {
    for (const t of (tools as unknown[] | undefined) ?? []) {
      if (!isRec(t) || Object.keys(t).some((k) => k !== 'functionDeclarations' && k !== 'function_declarations')) {
        return { ok: false, message: 'only function declarations are allowed as tools by gateway' };
      }
    }
    return { ok: true, fallbackModels: [], fallbackMaxTokens: 0 };
  }
  for (const t of (tools as unknown[] | undefined) ?? []) {
    if (!isRec(t) || (t.type !== undefined && t.type !== 'custom')) return { ok: false, message: 'provider-defined (server) tools are not allowed by gateway' };
  }
  if (body.mcp_servers !== undefined && body.mcp_servers !== null) return { ok: false, message: 'mcp servers are not allowed by gateway' };
  const fb = body.fallbacks;
  if (fb === undefined || fb === null || fb === 'default') return { ok: true, fallbackModels: [], fallbackMaxTokens: 0 };
  if (!Array.isArray(fb) || fb.length === 0 || fb.length > 8) return { ok: false, message: 'fallbacks must be "default" or a short list of models' };
  const models: string[] = [];
  let maxTokens = 0;
  for (const f of fb) {
    const m = isRec(f) && typeof f.model === 'string' ? f.model.trim() : '';
    const p = m ? aiPriceFor(m, PRICE_TABLE) : null;
    if (!p?.known || p.price.provider !== 'anthropic') return { ok: false, message: 'fallback model is not allowed by gateway' };
    models.push(m);
    const mt = (f as Record<string, unknown>).max_tokens;
    if (typeof mt === 'number' && Number.isInteger(mt) && mt > maxTokens) maxTokens = mt;
  }
  return { ok: true, fallbackModels: models, fallbackMaxTokens: maxTokens };
}

/**
 * Kesilen ya da yarıda kalan çağrının kullanımı (satır `estimated`). Girdi: sağlayıcının saydığı (geldiyse), yoksa gövdeden üst
 * tahmin. Çıktı: bilinen sayı, akan metinden tahmin ve geçen süre × hız içinden en büyüğü; en az 1, en çok üst sınır. Görsel:
 * görülen ile üst sınırın büyüğü (görsel sağlayıcıda üretilmiş ama bize ulaşmamış olabilir).
 */
export function cancelledUsage(known: MeteredUsage | null, bound: UpperBound, elapsedMs: number, streamedChars: number): MeteredUsage {
  const k = known ?? ZERO_USAGE;
  const knownPrompt = k.inputTokens + k.cacheReadTokens + k.cacheWrite5mTokens + k.cacheWrite1hTokens;
  const byTime = Math.ceil((Math.max(0, elapsedMs) / 1000) * CANCEL_OUTPUT_TOKENS_PER_SEC);
  const byChars = Math.ceil(Math.max(0, streamedChars) / CHARS_PER_OUTPUT_TOKEN);
  const max = bound.outputTokens > 0 ? bound.outputTokens : Number.MAX_SAFE_INTEGER;
  return {
    inputTokens: knownPrompt > 0 ? k.inputTokens : bound.inputTokens,
    cacheReadTokens: knownPrompt > 0 ? k.cacheReadTokens : 0,
    cacheWrite5mTokens: knownPrompt > 0 ? k.cacheWrite5mTokens : 0,
    cacheWrite1hTokens: knownPrompt > 0 ? k.cacheWrite1hTokens : 0,
    outputTokens: Math.min(max, Math.max(1, k.outputTokens, byChars, byTime)),
    outputImages: Math.max(k.outputImages, bound.outputImages),
    iterations: null,
  };
}
