
import { AI_UNKNOWN_MODEL_PRICE, CACHE_WRITE_1H_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER, estimateCost, isPricedModel, MODELS, PRICES } from "@tagpress/domain";
import { describe, expect, it } from "vitest";
import { countBuilderPrefix } from "./agent.ts";
import { BUILDER_IMAGE_TOKENS_ESTIMATE, budgetCostOf, cacheSummary, costOf, estimateBuilderCost, usageFromResponse } from "./cost.ts";
import type { BuilderResponse } from "./model.ts";
import { BUILDER_PROMPT_VERSION } from "./prompt.ts";
import { FakeBuilderModel } from "./testing.ts";

describe("fiyat hesabı (domain/ai.ts)", () => {
  it("1 saatlik sayı verilmeyen eski çağrıların sonucu değişmez", () => {
    // Değişiklikten önceki formülle aynı: yazma = girdi fiyatı × 1,25.
    const old = (u: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => {
      const p = PRICES[u.model]!;
      const tier = p.above && u.inputTokens > p.above.tokens ? p.above : p;
      let usd = (u.inputTokens * tier.input + u.outputTokens * tier.output) / 1e6;
      if (u.cacheReadTokens && p.cacheRead) usd += (u.cacheReadTokens * p.cacheRead) / 1e6;
      if (u.cacheWriteTokens) usd += (u.cacheWriteTokens * tier.input * 1.25) / 1e6;
      return usd;
    };
    const cases = [
      { model: "claude-haiku-5-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 2000 },
      { model: "claude-haiku-5-5", inputTokens: 150_000, outputTokens: 1000, cacheWriteTokens: 700 },
      { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 },
      { model: "claude-opus-5-5", inputTokens: 3000, outputTokens: 900, cacheReadTokens: 40_000, cacheWriteTokens: 12_000 },
    ];
    // TP-AI: ücret platform sözleşmesinden, satır başına mikro USD'ye yuvarlanmış (geçidin defteriyle aynı): eski formülden
    // en çok yarım mikro USD sapar (bu örneklerde Haiku kademesi istemin tamamıyla da aynı kademede).
    for (const c of cases) expect(Math.abs(estimateCost(c) - old(c))).toBeLessThanOrEqual(0.5e-6 + 1e-15);
    expect(estimateCost({ model: "gemini-3.1-flash-image", inputTokens: 100, outputTokens: 2000, images: 2 })).toBeCloseTo((100 * 0.3) / 1e6 + 2 * 0.067, 12);
    // Tabloda olmayan model artık null değil: sözleşmenin en pahalı fiyatıyla (para için güvenli yön).
    expect(isPricedModel("bilinmeyen")).toBe(false);
    expect(estimateCost({ model: "bilinmeyen", inputTokens: 1, outputTokens: 1 })).toBeCloseTo((AI_UNKNOWN_MODEL_PRICE.input + AI_UNKNOWN_MODEL_PRICE.output) / 1e6, 12);
  });

  it("1 saatlik yazım 2 kat, kalanı 1,25 kat; Opus 5.5'te $8 ve $5 / MTok", () => {
    expect(CACHE_WRITE_5M_MULTIPLIER * PRICES["claude-opus-5-5"]!.input).toBe(5);
    expect(CACHE_WRITE_1H_MULTIPLIER * PRICES["claude-opus-5-5"]!.input).toBe(8);
    const usd = estimateCost({ model: MODELS.builder, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 250_000 })!;
    expect(usd).toBeCloseTo(0.75 * 5 + 0.25 * 8, 12);
    // Yalnız 1 saatlik sayı verilirse toplam odur; toplamdan büyük 1 saatlik sayı toplamı aşamaz.
    expect(estimateCost({ model: MODELS.builder, inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(8, 12);
    expect(MODELS.builder).toBe("claude-opus-5-5");
  });
});

describe("oluşturucu kullanımı", () => {
  const response = (usage: Record<string, unknown>, model = "claude-opus-5-5") => ({ model, usage }) as unknown as BuilderResponse;

  it("üst düzey kullanım ve 1 saatlik kırılım", () => {
    const u = usageFromResponse(response({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 } }), MODELS.builder);
    expect(u).toEqual([{ kind: "message", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cacheWrite1hTokens: 25 }]);
    expect(cacheSummary(u)).toEqual({ inputTokens: 10, readTokens: 30, write5mTokens: 15, write1hTokens: 25, hitRatio: 30 / 80 });
  });

  it("yedek model denemeleri ayrı modelle sayılır; fiyatı bilinmeyen en pahalı fiyatla sayılır ve bildirilir", () => {
    const u = usageFromResponse(
      response(
        {
          input_tokens: 5,
          output_tokens: 5,
          iterations: [
            { type: "message", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        },
        "claude-sonnet-5-5",
      ),
      MODELS.builder,
    );
    expect(u.map((x) => `${x.kind}:${x.model}:${x.inputTokens}`)).toEqual(["message:claude-opus-5-5:100", "fallback_message:claude-sonnet-5-5:100"]);
    const known = (100 * 4) / 1e6 + (100 * 2 + 50 * 10) / 1e6;
    expect(costOf(u)).toEqual({ usd: known, unpriced: [], budgetUsd: known });
    // Fiyatı bilinmeyen model (TP-AI, sözleşme `aiPriceFor`): hem gösterilen tutarda hem bütçede tablonun en pahalı fiyatıyla
    // sayılır ($0 sayılıp sınırı aşmasın; geçidin defteri de böyle yazar) ve listelenir.
    const worst = AI_UNKNOWN_MODEL_PRICE;
    const unknownUsd = (worst.input + worst.output) / 1e6;
    expect(costOf([{ model: "claude-test-unknown", inputTokens: 1, outputTokens: 1 }])).toEqual({ usd: unknownUsd, unpriced: ["claude-test-unknown"], budgetUsd: unknownUsd });
    const w = { model: "claude-test-unknown", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 1000 };
    expect(budgetCostOf(w)).toBeCloseTo((1000 * worst.input + 100 * worst.output + 1000 * worst.cacheRead + 1000 * worst.cacheWrite) / 1e6, 12);
    // Bilinen hiçbir modelden ucuz sayılmaz.
    for (const m of Object.keys(PRICES)) expect(budgetCostOf(w)).toBeGreaterThanOrEqual(budgetCostOf({ ...w, model: m }));
    expect(budgetCostOf({ model: MODELS.builder, inputTokens: 1000, outputTokens: 0 })).toBeCloseTo((1000 * 4) / 1e6, 12);
    // Opus 5.5'in izinli yedekleri fiyat tablosunda ($5 / $25, okuma $0,50).
    for (const m of ["claude-opus-5", "claude-opus-4-8"]) expect(costOf([{ model: m, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000 }]).usd).toBeCloseTo((1000 * 5 + 100 * 25 + 1000 * 0.5) / 1e6, 12);
  });
});

describe("başlamadan tahmin", () => {
  it("önek count_tokens ile sayılır (bağlamla tam, bağlamsız görsel payıyla yaklaşık)", async () => {
    const model = new FakeBuilderModel([], { countTokens: () => 8000 });
    const exact = await countBuilderPrefix({ counter: model, promptVersion: BUILDER_PROMPT_VERSION, context: { locale: "en", samples: [{ id: "a", caption: "x" }] } });
    expect(exact).toEqual({ prefixTokens: 8000, exact: true });
    const req = model.countRequests[0]!;
    expect(req.tools).toHaveLength(8);
    expect(req.messages).toHaveLength(1);
    expect(JSON.stringify(req.messages)).toContain("interface_language: en");
    const approx = await countBuilderPrefix({ counter: model, promptVersion: BUILDER_PROMPT_VERSION, samples: 12 });
    expect(approx).toEqual({ prefixTokens: 8000 + 12 * BUILDER_IMAGE_TOKENS_ESTIMATE, exact: false });
  });

  it("aralık: 1 saatlik yazım + okumalar + sözleşmedeki tur ipuçları, sente yukarı", () => {
    const e = estimateBuilderCost({ prefixTokens: 20_000, samples: 12 });
    const write = (20_000 * 4 * 2) / 1e6;
    const read = (20_000 * 0.2) / 1e6;
    const low = write + 6 * read + 0.5 + 0.11 + 12 * 0.001;
    const high = write + 30 * read + 0.5 + 4 * 0.11 + 4 * 0.08 + 12 * 0.001;
    expect(e).toEqual({ prefixTokens: 20_000, exact: false, lowUsd: Math.ceil(low * 100) / 100, highUsd: Math.ceil(high * 100) / 100 });
    expect(e.lowUsd).toBeLessThan(e.highUsd);
  });
});
