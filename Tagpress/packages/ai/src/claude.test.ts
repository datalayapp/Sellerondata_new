import { estimateCost } from "@tagpress/domain";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyHttp, isConfigError } from "./errors.ts";
import { createFakeClaude, reply, systemText } from "./testing.ts";

const Schema = z.object({ answer: z.string(), n: z.number() });

describe("Claude istemcisi", () => {
  it("geçerli yanıtı doğrular; yerel şema varken istemde şema dökümü yok", async () => {
    const f = createFakeClaude([reply.json({ answer: "ok", n: 1 })]);
    const res = await f.claude.callJson({ system: "SYS", content: [{ type: "text", text: "q" }], schema: Schema });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ answer: "ok", n: 1 });
    const body = f.requests[0]!;
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(body.output_config?.format?.schema)).toContain('"additionalProperties":false');
    expect(systemText(body)).toBe("SYS");
  });

  it("ham yanıtı korur: onarımlardan sonra da bozuk yanıtın ham metni döner", async () => {
    const f = createFakeClaude([reply.text("bu JSON değil"), reply.text('{"answer": 3}'), reply.text('{"answer": "x"}')]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema, maxRepairs: 2 });
    expect(res.ok).toBe(false);
    expect(res.raw).toBe('{"answer": "x"}');
    expect(res.calls.map((c) => c.raw)).toEqual(["bu JSON değil", '{"answer": 3}', '{"answer": "x"}']);
    expect(res.error?.kind).toBe("invalid-response");
    expect(res.issues?.join(" ")).toMatch(/n/);
  });

  it("onarımda önceki ham yanıt ve doğrulama hataları birlikte gider", async () => {
    const f = createFakeClaude([reply.text('{"answer": "a", "n": "bir"}'), reply.json({ answer: "a", n: 1 })]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "soru" }], schema: Schema });
    expect(res.ok).toBe(true);
    const second = f.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]!.role).toBe("user");
    expect(second.messages[1]).toEqual({ role: "assistant", content: '{"answer": "a", "n": "bir"}' });
    const fix = second.messages[2]!.content as string;
    expect(fix).toMatch(/previous answer/);
    expect(fix).toMatch(/n:/);
  });

  it("anlamsal doğrulama tutmazsa onarım ister", async () => {
    const f = createFakeClaude([reply.json({ answer: "kötü", n: 1 }), reply.json({ answer: "iyi", n: 2 })]);
    const res = await f.claude.callJson({
      system: "S",
      content: [{ type: "text", text: "q" }],
      schema: Schema,
      validate: (d) => (d.answer === "iyi" ? { ok: true, issues: [] } : { ok: false, issues: ["answer must be good"] }),
    });
    expect(res.ok).toBe(true);
    expect(res.data?.answer).toBe("iyi");
    expect(f.requests[1]!.messages[2]!.content).toMatch(/answer must be good/);
  });

  it("kesilmede bütçeyi ikiye katlar ve beklemeden tekrar dener", async () => {
    const f = createFakeClaude([reply.truncated(), reply.truncated(), reply.json({ answer: "ok", n: 1 })]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema, maxTokens: 4000 });
    expect(res.ok).toBe(true);
    expect(f.requests.map((r) => r.max_tokens)).toEqual([4000, 8000, 16000]);
    expect(f.sleeps).toEqual([]);
    // Kesilen deneme onarım sayılmaz; mesajlar aynı kalır.
    expect(f.requests[2]!.messages).toHaveLength(1);
  });

  it("bütçe tavanı 32000; tavanda da kesilirse açık hata", async () => {
    const f = createFakeClaude([reply.truncated(), reply.truncated()]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema, maxTokens: 20000 });
    expect(f.requests.map((r) => r.max_tokens)).toEqual([20000, 32000]);
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("truncated");
    expect(res.raw).toBe('{"candidates": [');
  });

  it("hız sınırında üstel bekleyip dener; retry-after'a uyar", async () => {
    const f = createFakeClaude([reply.rateLimit(), reply.overloaded(), reply.rateLimit(2), reply.json({ answer: "ok", n: 1 })]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema });
    expect(res.ok).toBe(true);
    expect(f.sleeps).toEqual([1000, 3000, 2000]);
  });

  it("3 tekrardan sonra vazgeçer", async () => {
    const f = createFakeClaude([reply.network(), reply.network(), reply.network(), reply.network()]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("network");
    expect(f.requests).toHaveLength(4);
    expect(isConfigError(res.error)).toBe(false);
  });

  it("kota/bakiye ve anahtar hatasında beklemeden, açık ayar hatasıyla durur", async () => {
    for (const r of [reply.quota(), reply.auth(), { status: 402, error: { type: "billing_error", message: "payment required" } }]) {
      const f = createFakeClaude([r, reply.json({ answer: "x", n: 1 })]);
      const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema });
      expect(res.ok).toBe(false);
      expect(f.requests).toHaveLength(1);
      expect(f.sleeps).toEqual([]);
      expect(isConfigError(res.error)).toBe(true);
    }
  });

  it("hız sınırı ile kota ayrımı (sağlayıcı iletilerinden)", () => {
    expect(classifyHttp("anthropic", 429, "Number of request tokens has exceeded your per-minute rate limit", "rate_limit_error")).toBe("rate-limit");
    expect(classifyHttp("anthropic", 400, "Your credit balance is too low to access the Anthropic API.", "invalid_request_error")).toBe("quota");
    expect(classifyHttp("gemini", 429, "RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.")).toBe("quota");
    expect(classifyHttp("gemini", 429, "RESOURCE_EXHAUSTED: Quota exceeded for metric generate_requests_per_minute, retry in 12s")).toBe("rate-limit");
    expect(classifyHttp("anthropic", 400, "output_config.format.schema: invalid")).toBe("bad-request");
    expect(classifyHttp("anthropic", 529, "Overloaded", "overloaded_error")).toBe("overloaded");
  });

  it("önbellek token'larını sayar ve ücrete katar", async () => {
    const f = createFakeClaude([reply.json({ answer: "ok", n: 1 }, { usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } })]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema, cacheSystem: true });
    const u = res.usage[0]!;
    expect(u).toMatchObject({ inputTokens: 300, outputTokens: 80, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    expect(estimateCost(u)).toBeCloseTo((300 * 0.1 + 80 * 0.5 + 2000 * 0.01) / 1e6, 12);
    const sys = f.requests[0]!.system as Array<{ cache_control?: unknown }>;
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("API şemayı reddederse bir kez şemayı istemde göndererek dener", async () => {
    const f = createFakeClaude([{ status: 400, error: { type: "invalid_request_error", message: "output_config.format.schema: unsupported keyword" } }, reply.json({ answer: "ok", n: 1 })]);
    const res = await f.claude.callJson({ system: "SYS", content: [{ type: "text", text: "q" }], schema: Schema });
    expect(res.ok).toBe(true);
    expect(f.requests[1]!.output_config?.format).toBeUndefined();
    expect(systemText(f.requests[1]!)).toMatch(/JSON Schema/);
  });

  it("reddi (refusal) tekrar denemez", async () => {
    const f = createFakeClaude([{ text: "", stopReason: "refusal" }]);
    const res = await f.claude.callJson({ system: "S", content: [{ type: "text", text: "q" }], schema: Schema });
    expect(res.error?.kind).toBe("refusal");
    expect(f.requests).toHaveLength(1);
  });

  it("görselleri en uzun kenar 768'e küçültür", async () => {
    const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const f = createFakeClaude([reply.json({ answer: "ok", n: 1 })]);
    await f.claude.callJson({ system: "S", content: [{ type: "image", png }, { type: "text", text: "q" }], schema: Schema });
    const block = (f.requests[0]!.messages[0]!.content as Array<{ type: string; source?: { data: string } }>)[0]!;
    expect(block.type).toBe("image");
    const meta = await sharp(Buffer.from(block.source!.data, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([768, 384]);
  });
});
