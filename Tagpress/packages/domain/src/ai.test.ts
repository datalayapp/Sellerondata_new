import { AI_LIST_PRICES_USD, AI_UNKNOWN_MODEL_PRICE, PRODUCT_REGISTRY, aiCostMicroUsd, aiPurposeKey } from "@sellerondata/contracts";
import { describe, expect, it } from "vitest";
import { MODELS, PRICES, type Usage, estimateCost, estimateCostMicroUsd, isPricedModel, meteredUsage } from "./ai.ts";

/**
 * Fiyat eşitliği (TP-AI, YAPAY-ZEKA-GECIDI §6): TagPress'in `ai_calls` maliyeti platform sözleşmesinin fiyat işleviyle
 * (`aiCostMicroUsd`) birebir aynı: yapay zekâ geçidinin defter satırı ile aracın kaydı aynı kural ve yuvarlamayla çıkar.
 */

const tagpress = PRODUCT_REGISTRY.find((p) => p.key === "tagpress")!;

/** Deterministik sözde rastgele (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fiyatlar platform sözleşmesinden", () => {
  it("TagPress modelleri sözleşmenin fiyat tablosunda ve kayıttaki izin listesinde", () => {
    for (const m of Object.values(MODELS)) {
      expect(AI_LIST_PRICES_USD[m], m).toBeDefined();
      expect(isPricedModel(m)).toBe(true);
      expect(tagpress.ai?.models, m).toContain(m);
    }
  });

  it("ekran tablosu (PRICES) sözleşmenin tablosundan türer", () => {
    expect(Object.keys(PRICES).sort()).toEqual(Object.keys(AI_LIST_PRICES_USD).sort());
    for (const [m, p] of Object.entries(AI_LIST_PRICES_USD)) {
      expect(PRICES[m]).toMatchObject({ input: p.input, output: p.output, cacheRead: p.cacheRead });
      if (p.above) expect(PRICES[m]!.above).toEqual({ tokens: p.above.promptTokens, input: p.above.price.input, output: p.above.price.output });
      if (p.perOutputImage) expect(PRICES[m]!.perImage).toBe(p.perOutputImage);
    }
  });

  it("eşitlik: her model ve kullanım için ücret = sözleşmenin aiCostMicroUsd'si (mikro USD, bit bit)", () => {
    const r = rng(20261122);
    const n = (max: number) => Math.floor(r() * max);
    for (const model of [...Object.keys(AI_LIST_PRICES_USD), "claude-sonnet-5-5-20261001", "bilinmeyen-model"]) {
      for (let i = 0; i < 200; i++) {
        const write = n(3) ? n(150_000) : 0;
        const u: Usage = {
          model,
          inputTokens: n(i % 2 ? 160_000 : 5_000),
          outputTokens: n(8_000),
          cacheReadTokens: n(120_000),
          cacheWriteTokens: write,
          cacheWrite1hTokens: n(2) ? n(write + 1) : 0,
          images: model.startsWith("gemini") ? n(3) : 0,
        };
        const price = AI_LIST_PRICES_USD[model] ?? AI_LIST_PRICES_USD[model.replace(/-\d{8}$/, "")] ?? { ...AI_UNKNOWN_MODEL_PRICE, perOutputImage: 0.067 };
        const micro = aiCostMicroUsd(meteredUsage(u), price);
        expect(estimateCostMicroUsd(u), `${model} #${i}`).toBe(micro);
        expect(estimateCost(u)).toBe(micro / 1e6);
      }
    }
  });

  it("Haiku kademesi istemin TAMAMINA bakar (girdi + önbellek okuma + yazma; eskiden yalnız girdi)", () => {
    // Girdi 60k (tek başına kademenin altında) + okuma 50k = 110k istem → bütün istek üst kademeden.
    const u: Usage = { model: MODELS.daily, inputTokens: 60_000, outputTokens: 1_000, cacheReadTokens: 50_000 };
    expect(estimateCostMicroUsd(u)).toBe(Math.round(60_000 * 0.5 + 1_000 * 2.5 + 50_000 * 0.05));
    // Aynı istem 100k'nın altında: alt kademe.
    expect(estimateCostMicroUsd({ ...u, cacheReadTokens: 30_000 })).toBe(Math.round(60_000 * 0.1 + 1_000 * 0.5 + 30_000 * 0.01));
  });

  it("1 saatlik önbellek yazımı ayrı fiyatlanır; görsel modelinde çıktı max(token, görsel)", () => {
    // Opus 5.5: 5 dk yazma $5, 1 sa yazma $8 / MTok.
    expect(estimateCost({ model: MODELS.builder, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 250_000 })).toBeCloseTo(0.75 * 5 + 0.25 * 8, 12);
    // Gemini: 1 görsel ($0,067) ≥ 1.300 çıktı tokeni × $2,5 / MTok.
    expect(estimateCost({ model: MODELS.image, inputTokens: 2000, outputTokens: 1300, images: 1 })).toBeCloseTo(0.067 + (2000 * 0.3) / 1e6, 9);
  });

  it("tabloda olmayan model en pahalı fiyattan (null değil); bilinen hiçbir modelden ucuz değil", () => {
    const u: Usage = { model: "claude-yeni-model", inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 5_000, cacheWriteTokens: 1_000 };
    expect(isPricedModel(u.model)).toBe(false);
    for (const m of Object.keys(AI_LIST_PRICES_USD)) expect(estimateCost(u)).toBeGreaterThanOrEqual(estimateCost({ ...u, model: m }));
  });

  it("TagPress'in yerel amaçları kayıttaki geçit amaçlarıyla eşleşir", () => {
    const purposes = Object.keys(tagpress.ai?.purposes ?? {});
    const local = ["design", "rank", "transcribe", "image", "builder-turn", "builder-transcribe"];
    for (const prefix of ["builder-try", "sablon", "deneme"]) for (const p of ["design", "rank", "transcribe", "image"]) local.push(`${prefix}-${p}`);
    expect(local.map((p) => aiPurposeKey("tagpress", p)).sort()).toEqual([...purposes].sort());
  });
});
