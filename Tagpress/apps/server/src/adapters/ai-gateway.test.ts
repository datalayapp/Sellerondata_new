import { AI_HEADERS, type AiAllowance, MODELS, emptyProfile } from "@tagpress/domain";
import type { ImagePort } from "@tagpress/ai";
import { describe, expect, it, vi } from "vitest";
import { type OrgContext, runInOrg } from "../org/context.ts";
import { KeyGuard } from "../services/key-guard.ts";
import { SecretService } from "../services/secrets.ts";
import { ManualClock } from "../util/clock.ts";
import { HttpError } from "../util/errors.ts";
import { AiBusyError, AiRejectError, createImageGenerator } from "./ai.ts";
import { AI_ALLOWANCE_FRESH_MS, AI_ALLOWANCE_TTL_MS, AiGateway, allowanceLimit, createAiGateway, withAiJob } from "./ai-gateway.ts";
import type { FontRegistryCache } from "./fonts.ts";

/**
 * Platform kipi (TP-AI): sunucunun geçit tarafı. Bağlam başlıkları firma bağlamından ve iş kapsamından; aylık hak geçidin
 * `/internal/allowance`'ından 30 sn önbellekle; ön denetim (`KeyGuard`) anahtar okumaz; görüntü üretimi gerçek Gemini
 * istemcisiyle sahte geçide gider (adres, jeton, `X-SOD-*`), `SecretService.get` hiç çağrılmaz; geçidin reddi kodlu hata.
 */

const GW = "http://ai-gateway.test:4300";
const TOKEN = "tp-arac-jetonu";
const member: OrgContext = { orgId: "org-a", memberId: "uye-1", permissions: "all", locale: "tr", source: "platform" };
const job: OrgContext = { ...member, memberId: null };

const allowance = (over: Partial<AiAllowance> = {}): AiAllowance => ({
  period: "2026-11",
  resetsAt: "2026-12-01T00:00:00.000Z",
  capMicroUsd: 30_000_000,
  usedMicroUsd: 1_000_000,
  reservedMicroUsd: 0,
  remainingMicroUsd: 29_000_000,
  state: "ok",
  tool: { product: "tagpress", capMicroUsd: null, usedMicroUsd: 1_000_000 },
  ...over,
});

function fakeFetch(handler: (url: string, headers: Record<string, string>) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    calls.push({ url: String(url), headers: h });
    const r = handler(String(url), h);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fn, calls };
}

describe("geçit bağlam başlıkları", () => {
  const gw = new AiGateway({ url: `${GW}/`, token: TOKEN });

  it("taban adresler sözleşmeden; adres ya da jeton boşsa geçit yok", () => {
    expect(gw.anthropicBaseUrl).toBe(`${GW}/internal/anthropic`);
    expect(gw.geminiBaseUrl).toBe(`${GW}/internal/gemini/v1beta`);
    expect(createAiGateway(null)).toBeNull();
    expect(createAiGateway({ url: "", token: TOKEN })).toBeNull();
    expect(createAiGateway({ url: GW, token: " " })).toBeNull();
    expect(() => new AiGateway({ url: "ai-api:4300", token: TOKEN })).toThrow(/http/);
  });

  it("firma ve üye bağlamdan; üyeli bağlam request, üyesiz job; amaç tagpress.<amaç>", () => {
    const h = runInOrg(member, () => gw.headers({ purpose: "design", requestId: "r1", attempt: 2 }));
    expect(h).toEqual({
      [AI_HEADERS.org]: "org-a",
      [AI_HEADERS.member]: "uye-1",
      [AI_HEADERS.purpose]: "tagpress.design",
      [AI_HEADERS.requestId]: "r1",
      [AI_HEADERS.origin]: "request",
      [AI_HEADERS.attempt]: "2",
    });
    const j = runInOrg(job, () => gw.headers({ purpose: "builder-transcribe", requestId: "r2", attempt: 0 }));
    expect(j[AI_HEADERS.member]).toBeUndefined();
    expect(j[AI_HEADERS.origin]).toBe("job");
    expect(j[AI_HEADERS.purpose]).toBe("tagpress.builder_transcribe");
  });

  it("iş kapsamı: bütün çağrılar aynı istek kimliği, kapsamın çıkışı ve amaç öneki", async () => {
    const h = await runInOrg(member, () =>
      withAiJob({ requestId: "sablon-t1", origin: "job", purposePrefix: "sablon" }, async () => {
        await Promise.resolve();
        return [gw.headers({ purpose: "image", requestId: "istemci-1", attempt: 0 }), gw.headers({ purpose: "transcribe", requestId: "istemci-2", attempt: 0 })];
      }),
    );
    expect(h.map((x) => x[AI_HEADERS.requestId])).toEqual(["sablon-t1", "sablon-t1"]);
    expect(h.map((x) => x[AI_HEADERS.purpose])).toEqual(["tagpress.sablon_image", "tagpress.sablon_transcribe"]);
    expect(h.every((x) => x[AI_HEADERS.origin] === "job")).toBe(true);
    // İstemcinin sabit amacı ve çıkışı (oluşturucu modeli) kapsamdan önce gelir.
    const b = runInOrg(member, () => gw.options({ purpose: "builder-turn", origin: "job" }).context({ purpose: "x", requestId: "m1", attempt: 3 }));
    expect(b).toMatchObject({ [AI_HEADERS.purpose]: "tagpress.builder_turn", [AI_HEADERS.origin]: "job", [AI_HEADERS.requestId]: "m1" });
  });

  it("firma bağlamı yoksa hata (bağlamsız yapay zekâ çağrısı yok)", () => {
    expect(() => gw.headers({ purpose: "design", requestId: "r", attempt: 0 })).toThrow(/Firma bağlamı yok/);
  });
});

describe("aylık hak (/internal/allowance, 30 sn önbellek)", () => {
  it("ilk okumada null + arka planda tazeleme; sonra önbellekten; bayatlayınca yeniden okunur", async () => {
    let now = 1_000_000;
    const f = fakeFetch(() => ({ body: allowance() }));
    const gw = new AiGateway({ url: GW, token: TOKEN }, { fetch: f.fn, now: () => now });
    expect(gw.peek("org-a")).toBeNull();
    await gw.refresh("org-a");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`${GW}/internal/allowance?orgId=org-a`);
    expect(f.calls[0]!.headers["x-api-key"]).toBe(TOKEN);
    expect(gw.peek("org-a")?.state).toBe("ok");
    now += AI_ALLOWANCE_TTL_MS - 1;
    gw.peek("org-a");
    expect(f.calls).toHaveLength(1);
    now += 2;
    expect(gw.peek("org-a")?.state).toBe("ok"); // bayat değer döner, tazeleme arkada
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  });

  it("geçit hata verirse null; önbellekteki değer çok eskiyince kullanılmaz", async () => {
    let now = 0;
    let fail = false;
    const f = fakeFetch(() => (fail ? { status: 503, body: {} } : { body: allowance({ state: "capped" }) }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gw = new AiGateway({ url: GW, token: TOKEN }, { fetch: f.fn, now: () => now });
    await gw.refresh("org-a");
    fail = true;
    expect(await gw.refresh("org-a")).toBeNull();
    expect(gw.peek("org-a")?.state).toBe("capped");
    now += 10 * 60_000;
    expect(gw.peek("org-a")).toBeNull();
    warn.mockRestore();
  });

  it("ensureFresh (tur başlamadan): taze değilse okunması beklenir; tazeyse istek yok; ulaşılamazsa önbellekteki değer", async () => {
    let now = 0;
    let used = 1_000_000;
    let fail = false;
    const f = fakeFetch(() => (fail ? { status: 503, body: {} } : { body: allowance({ usedMicroUsd: used }) }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gw = new AiGateway({ url: GW, token: TOKEN }, { fetch: f.fn, now: () => now });
    expect((await gw.ensureFresh("org-a"))?.usedMicroUsd).toBe(1_000_000);
    expect(f.calls).toHaveLength(1);
    now += AI_ALLOWANCE_FRESH_MS - 1;
    used = 9_000_000;
    expect((await gw.ensureFresh("org-a"))?.usedMicroUsd).toBe(1_000_000);
    expect(f.calls).toHaveLength(1);
    now += 2; // 30 sn'lik önbellek süresi dolmadan da tur başında yeniden okunur
    expect((await gw.ensureFresh("org-a"))?.usedMicroUsd).toBe(9_000_000);
    expect(f.calls).toHaveLength(2);
    now += AI_ALLOWANCE_FRESH_MS;
    fail = true;
    expect((await gw.ensureFresh("org-a"))?.usedMicroUsd).toBe(9_000_000);
    warn.mockRestore();
  });

  it("allowanceLimit: firma hakkı ile araç tavanından kalanı az olan", () => {
    expect(allowanceLimit(allowance())).toEqual({ limitUsd: 30, usedUsd: 1, state: "ok" });
    expect(allowanceLimit(allowance({ tool: { product: "tagpress", capMicroUsd: 5_000_000, usedMicroUsd: 4_000_000 } }))).toEqual({ limitUsd: 5, usedUsd: 4, state: "ok" });
  });
});

describe("ön denetim (KeyGuard) platform kipinde anahtar okumaz", () => {
  it("geçit yok → ai-unavailable; durdurulmuş → ai-paused; dolmuş → budget-exceeded; aksi hâlde geçer", async () => {
    const code = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e instanceof HttpError ? [e.status, e.code] : String(e);
      }
    };
    expect(code(() => runInOrg(member, () => new KeyGuard({ gateway: null }, true).require("anthropic")))).toEqual([409, "ai-unavailable"]);
    let state: AiAllowance["state"] = "paused";
    const f = fakeFetch(() => ({ body: allowance({ state }) }));
    const gw = new AiGateway({ url: GW, token: TOKEN }, { fetch: f.fn });
    const guard = new KeyGuard({ gateway: gw }, true);
    // Hak henüz okunmadıysa iş başlar (sınırı geçit uygular).
    expect(code(() => runInOrg(member, () => guard.require("gemini")))).toBeNull();
    await gw.refresh("org-a");
    expect(code(() => runInOrg(member, () => guard.require("gemini")))).toEqual([409, "ai-paused"]);
    state = "capped";
    await gw.refresh("org-a");
    expect(code(() => runInOrg(member, () => guard.require("gemini")))).toEqual([409, "budget-exceeded"]);
    expect(code(() => new KeyGuard({ gateway: gw }, false).require("gemini"))).toBeNull();
  });

  it("platform kaynaklı SecretService anahtar okumaz, yazmaz; durumda anahtar yok, uyarı yok", async () => {
    const settings = { getInstall: vi.fn(), setInstall: vi.fn(), deleteInstall: vi.fn() };
    const keys = { description: "test", label: "test", load: vi.fn(async () => null) };
    const s = new SecretService(settings as never, new ManualClock(), { keys: keys as never, legacyDpapi: null, source: "platform" });
    expect(s.source).toBe("platform");
    expect((await s.init()).source).toBe("platform");
    expect(keys.load).not.toHaveBeenCalled();
    expect(() => s.get("anthropic")).toThrow(/Platform kipinde/);
    expect(() => s.set("anthropic", "sk-x")).toThrow(/Platform kipinde/);
    expect(s.warnings()).toEqual([]);
    expect(s.status().every((k) => !k.hasKey)).toBe(true);
    expect(settings.getInstall).not.toHaveBeenCalled();
  });
});

describe("görüntü üretimi platform kipinde (gerçek Gemini istemcisi, sahte geçit)", () => {
  const png = Buffer.alloc(64, 7).toString("base64");
  const fonts = {} as FontRegistryCache;
  const req = { jobId: "t1", theme: "çiçek", profile: emptyProfile("x"), width: 64, height: 64, log: () => undefined };

  it("istek geçide gider: adres, x-goog-api-key = jeton, X-SOD-* (sablon kapsamı); anahtar okunmaz", async () => {
    const f = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }, headers: { [AI_HEADERS.callId]: "gc-1" } }));
    const apiKey = vi.fn(() => "sk-olmamali");
    const gen = createImageGenerator({ apiKey, platformAi: { gateway: new AiGateway({ url: GW, token: TOKEN }) }, fetch: f.fn, fonts });
    // Görsel çözülemese de (sahte bayt) istek gitmiş olmalı; sonuç burada önemsiz.
    await runInOrg(member, () => withAiJob({ requestId: "sablon-t1", origin: "job", purposePrefix: "sablon" }, () => gen.newTemplate(req))).catch(() => undefined);
    expect(apiKey).not.toHaveBeenCalled();
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
    const c = f.calls[0]!;
    expect(c.url).toBe(`${GW}/internal/gemini/v1beta/models/${MODELS.image}:generateContent`);
    expect(c.headers["x-goog-api-key"]).toBe(TOKEN);
    expect(c.headers.authorization).toBeUndefined();
    expect(c.headers).toMatchObject({
      [AI_HEADERS.org]: "org-a",
      [AI_HEADERS.member]: "uye-1",
      [AI_HEADERS.purpose]: "tagpress.sablon_image",
      [AI_HEADERS.requestId]: "sablon-t1",
      [AI_HEADERS.origin]: "job",
    });
  });

  it("geçidin reddi kodlu hata (budget-exceeded / ai-paused), yeniden denenmez; çağrı kaydı ret kimliğini taşır", async () => {
    for (const [reject, code] of [
      ["sod_org_cap", "budget-exceeded"],
      ["sod_tool_cap", "budget-exceeded"],
      ["sod_platform_paused", "ai-paused"],
      ["sod_provider_missing", "ai-unavailable"],
    ] as const) {
      const f = fakeFetch(() => ({ status: 429, body: { error: { code: 429, message: reject, status: "RESOURCE_EXHAUSTED", reason: reject } }, headers: { [AI_HEADERS.reject]: reject, [AI_HEADERS.shouldRetry]: "false", [AI_HEADERS.callId]: "gc-ret" } }));
      const gen = createImageGenerator({ apiKey: () => null, platformAi: { gateway: new AiGateway({ url: GW, token: TOKEN }) }, fetch: f.fn, fonts });
      const err = await runInOrg(job, () => gen.newTemplate(req)).catch((e: unknown) => e);
      expect(err, reject).toBeInstanceOf(AiRejectError);
      expect((err as AiRejectError).status).toBe(409);
      expect((err as AiRejectError).code).toBe(code);
      expect((err as AiRejectError).calls[0]).toMatchObject({ purpose: "image", gatewayCallId: "gc-ret" });
      expect(f.calls).toHaveLength(1);
    }
  });

  it("hız reddi (sod_rate_limited) tanınır: AiBusyError + retry-after (kuyruk yeni istekle yeniden dener); yeniden denenmez", async () => {
    const f = fakeFetch(() => ({
      status: 429,
      body: { error: { code: 429, message: "sod_rate_limited", status: "RESOURCE_EXHAUSTED", reason: "sod_rate_limited" } },
      headers: { [AI_HEADERS.reject]: "sod_rate_limited", [AI_HEADERS.shouldRetry]: "false", [AI_HEADERS.callId]: "gc-yogun", "retry-after": "7" },
    }));
    const gen = createImageGenerator({ apiKey: () => null, platformAi: { gateway: new AiGateway({ url: GW, token: TOKEN }) }, fetch: f.fn, fonts });
    const err = await runInOrg(job, () => gen.newTemplate(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBusyError);
    expect((err as AiBusyError).retryAfterMs).toBe(7000);
    expect((err as AiBusyError).calls[0]).toMatchObject({ purpose: "image", gatewayCallId: "gc-yogun" });
    expect(f.calls).toHaveLength(1);
  });

  it("geçit adresi boşsa açık hata (anahtara düşülmez)", async () => {
    const apiKey = vi.fn(() => "sk-olmamali");
    const fake: ImagePort = { model: MODELS.image, generate: vi.fn() };
    const gen = createImageGenerator({ apiKey, platformAi: { gateway: null }, fonts, gemini: () => fake });
    const err = await runInOrg(member, () => gen.newTemplate(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, code: "ai-unavailable" });
    expect(apiKey).not.toHaveBeenCalled();
    expect(fake.generate).not.toHaveBeenCalled();
  });
});
