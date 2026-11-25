import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProfileSchema } from "@tagpress/domain";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_URL, TagpressClient } from "./client.ts";
import { INSTRUCTIONS, MCP_SERVER_NAME, buildServer } from "./server.ts";
import { profileLeaves, schemaFields } from "./tools/profile.ts";

/** Sahte uygulamaya gelen istek; `body` çözülmüş JSON gövdesi (yoksa `undefined`). */
type FakeRequest = { method: string; path: string; body: unknown; headers: Record<string, string> };
/** Sahte uygulama: yol → yanıt. İstekler kaydedilir. */
type Handler = (req: FakeRequest) => { status?: number; json?: unknown; png?: boolean } | undefined;

function fakeFetch(handler: Handler) {
  const calls: FakeRequest[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const req: FakeRequest = { method: init.method ?? "GET", path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(req);
    const r = handler(req);
    if (!r) return new Response(JSON.stringify({ error: "Bulunamadı." }), { status: 404 });
    if (r.png) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
    return new Response(JSON.stringify(r.json ?? null), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

async function connect(fetchFn: typeof fetch) {
  const { server } = buildServer({ baseUrl: "http://127.0.0.1:5420", fetch: fetchFn, timeoutMs: 2000 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

type ToolContent = CallToolResult["content"][number];
/** Araç yanıtı (eski `toolResult` biçimi bu sunucuda yok; gelirse test düşer). */
function asResult(r: Awaited<ReturnType<Client["callTool"]>>): CallToolResult {
  if (!Array.isArray(r.content)) throw new Error("Araç yanıtında content yok.");
  // Dizi denetiminden sonra yanıt CallToolResult biçimindedir (dizinleme imzası `in` ile daraltmayı engelliyor).
  return r as CallToolResult;
}
const textOf = (r: CallToolResult) =>
  r.content
    .filter((c): c is Extract<ToolContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
const imagesOf = (r: CallToolResult) => r.content.filter((c) => c.type === "image");
const profile = ProfileSchema.parse({ name: "Deneme", sizing: { fill: 0.93 } });
const record = (status: "draft" | "published", version: number) => ({ id: "x", languageId: "dil", version, status, data: profile, note: "", createdAt: "2026-10-09T00:00:00Z" });

describe("MCP sunucusu", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("sunucu kendini \"tagpress\" adıyla bildirir; yönerge yeni adları anar", async () => {
    const c = await connect(fakeFetch(() => undefined).fn);
    close = c.close;
    expect(MCP_SERVER_NAME).toBe("tagpress");
    expect(c.client.getServerVersion()?.name).toBe("tagpress");
    expect(INSTRUCTIONS).toContain("TagPress");
    expect(INSTRUCTIONS).toContain("TAGPRESS_URL");
    expect(INSTRUCTIONS).not.toMatch(/Etiket Studio|STUDIO_URL/);
  });

  it("uygulama adresi: TAGPRESS_URL, yoksa eski STUDIO_URL, yoksa varsayılan", () => {
    const keys = ["TAGPRESS_URL", "STUDIO_URL"] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      delete process.env.TAGPRESS_URL;
      delete process.env.STUDIO_URL;
      expect(new TagpressClient().baseUrl).toBe(DEFAULT_URL);
      process.env.STUDIO_URL = "http://127.0.0.1:5499/";
      expect(new TagpressClient().baseUrl).toBe("http://127.0.0.1:5499");
      process.env.TAGPRESS_URL = "http://127.0.0.1:5498";
      expect(new TagpressClient().baseUrl).toBe("http://127.0.0.1:5498");
      expect(new TagpressClient({ baseUrl: "http://x" }).baseUrl).toBe("http://x");
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it("araç listesi: beklenen adlar ve Türkçe açıklamalar", async () => {
    const c = await connect(fakeFetch(() => undefined).fn);
    close = c.close;
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["diller", "motor_dene", "olcum_ozeti", "ornekleri_getir", "oturum_baslat", "oturum_notu", "oturum_oku", "profil_oku", "profil_semasi", "sablonlari_getir", "soru_kaydet", "taslak_yaz", "uretim_dene"].sort(),
    );
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(20);
  });

  it("uygulama kapalıyken her araç anlaşılır hata döner (sunucu çökmez)", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = await connect(down);
    close = c.close;
    const r = asResult(await c.client.callTool({ name: "diller", arguments: {} }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ulaşılamadı.*pnpm start/s);
    const r2 = asResult(await c.client.callTool({ name: "taslak_yaz", arguments: { dil: "dil", yama: { sizing: { fill: 0.9 } }, not: "x" } }));
    expect(r2.isError).toBe(true);
    // Şema aracı uygulamasız çalışır.
    const s = asResult(await c.client.callTool({ name: "profil_semasi", arguments: { grup: "boyut" } }));
    expect(s.isError).toBeFalsy();
    expect(textOf(s)).toContain("sizing.fill");
  });

  it("profil_oku: taslak yoksa yayınlanan; değer + açıklama + rozet", async () => {
    const f = fakeFetch(({ path }) => {
      if (path === "/api/languages/dil/profile/draft") return { json: null };
      if (path === "/api/languages/dil/profile") return { json: record("published", 3) };
      return undefined;
    });
    const c = await connect(f.fn);
    close = c.close;
    const r = asResult(await c.client.callTool({ name: "profil_oku", arguments: { dil: "dil", grup: "boyut" } }));
    const t = textOf(r);
    expect(t).toMatch(/Taslak yok/);
    expect(t).toMatch(/yayınlanan v3/);
    expect(t).toMatch(/sizing\.fill = 0\.93\n\s+Doluluk · \[motor \(kesin\)\]/);
    expect(t).not.toMatch(/lineBreaking/);
  });

  it("taslak_yaz: X-Studio başlığıyla yama gönderir; doğrulama hataları alan yollarıyla", async () => {
    const f = fakeFetch(({ method, path, body }) => {
      if (method === "POST" && path === "/api/languages/dil/design-session/draft") {
        const { patch } = body as { patch: { sizing?: { fill?: number } } };
        if ((patch.sizing?.fill ?? 0) > 1) return { status: 400, json: { error: "Profil geçersiz; işaretli alanları düzeltin.", fields: [{ path: "sizing.fill", message: "Too big" }] } };
        return { json: { draft: record("draft", 4), changes: [{ path: "sizing.fill", from: 0.97, to: 0.93 }] } };
      }
      return undefined;
    });
    const c = await connect(f.fn);
    close = c.close;
    const ok = asResult(await c.client.callTool({ name: "taslak_yaz", arguments: { dil: "dil", yama: { sizing: { fill: 0.93 } }, not: "doluluk" } }));
    expect(textOf(ok)).toMatch(/Taslak v4.*sizing\.fill: 0\.97 → 0\.93/s);
    expect(f.calls[0]!.headers["x-studio"]).toBe("1");
    expect(f.calls[0]!.body).toEqual({ patch: { sizing: { fill: 0.93 } }, note: "doluluk" });
    const bad = asResult(await c.client.callTool({ name: "taslak_yaz", arguments: { dil: "dil", yama: { sizing: { fill: 5 } }, not: "x" } }));
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/- sizing\.fill: Too big/);
  });

  it("ornekleri_getir: metin + görseller (MCP image)", async () => {
    const sample = {
      id: "ref-1",
      text: "Laurea Giulia",
      templateKey: "12",
      split: "train",
      orderNo: "1",
      labelFramePx: 440,
      lines: [
        { text: "Laurea", font: "Great Vibes/Regular", sizePx: 40, pt: 9.3, segments: [] },
        { text: "Giulia", font: "Great Vibes/Regular", sizePx: 60, pt: 13.9, segments: [] },
      ],
      program: ["Laurea Giulia"],
      imageUrl: "/api/learn/references/ref-1/thumb.png?template=1&w=320",
    };
    const f = fakeFetch(({ path }) => {
      if (path.startsWith("/api/languages/dil/learn/samples?")) return { json: { total: 30, samples: [sample] } };
      if (path.startsWith("/api/learn/references/ref-1/thumb.png")) return { png: true };
      return undefined;
    });
    const c = await connect(f.fn);
    close = c.close;
    const r = asResult(await c.client.callTool({ name: "ornekleri_getir", arguments: { dil: "dil", limit: 1, split: "train" } }));
    expect(textOf(r)).toMatch(/Müşteri metni: "Laurea Giulia"/);
    expect(textOf(r)).toMatch(/Programın önerisi: Laurea Giulia/);
    expect(imagesOf(r)).toHaveLength(1);
    expect(f.calls[0]!.path).toContain("split=train");
  });

  it("motor_dene: metrikler + önizleme + oturuma 'trial' girdisi", async () => {
    const metrics = { n: 10, failed: 0, within10: 7, sizeWithin10: 0.7, sizeError: 0.05, sizeRatio: 1.02, heightError: 0.06, positionError: 5.2, dx: 0.1, dy: -1, gapNormal: 0.03, gapBeforeLast: 0.1, gapConnector: null };
    const f = fakeFetch(({ method, path }) => {
      if (method === "POST" && path === "/api/languages/dil/learn/replay")
        return { json: { refs: 10, split: "test", sides: [{ label: "Taslak (v4)", metrics, summary: { gaps: {} }, worst: [] }], previews: [{ referenceId: "ref-1", url: "/api/learn/previews/deneme-1/ref-1.png" }] } };
      if (path === "/api/learn/previews/deneme-1/ref-1.png") return { png: true };
      if (method === "POST" && path === "/api/languages/dil/design-session/entries") return { json: { id: 1 } };
      return undefined;
    });
    const c = await connect(f.fn);
    close = c.close;
    const r = asResult(await c.client.callTool({ name: "motor_dene", arguments: { dil: "dil", kaynak: "taslak" } }));
    expect(textOf(r)).toMatch(/±%10 içinde: 7\/10/);
    expect(imagesOf(r)).toHaveLength(1);
    expect(f.calls.find((x) => x.path.endsWith("/learn/replay"))!.body).toMatchObject({ source: "draft", split: "test", limit: 40 });
    expect(f.calls.find((x) => x.path.endsWith("/design-session/entries"))!.body).toMatchObject({ kind: "trial" });
  });

  it("uretim_dene: onay yokken yalnızca tahmini maliyet (dryRun); onayla gerçek istek", async () => {
    const f = fakeFetch(({ method, path, body }) => {
      if (method === "GET" && path === "/api/references/ref-9") return { json: { id: "ref-9", text: "Anna & Marco", templateKey: "7" } };
      if (method === "POST" && path === "/api/languages/dil/profile/try") {
        if ((body as { dryRun?: boolean }).dryRun) return { json: { estimateUsd: 0.006, costUsd: 0, mode: "ai", results: [] } };
        const side = { previewUrl: "/api/trials/p1.png", lines: ["Anna", "&", "Marco"], sizesPx: [60, 30, 60], issues: 0, issueList: [], costUsd: 0.002, sameBreaksAsReference: true, sizeDiffVsReference: 0.04 };
        return { json: { estimateUsd: 0.006, costUsd: 0.0021, mode: "ai", results: [{ sampleId: "oge-1", published: null, draft: side }] } };
      }
      if (path === "/api/trials/p1.png") return { png: true };
      if (method === "POST" && path.endsWith("/design-session/entries")) return { json: { id: 1 } };
      return undefined;
    });
    const c = await connect(f.fn);
    close = c.close;
    const est = asResult(await c.client.callTool({ name: "uretim_dene", arguments: { dil: "dil", ogeler: [{ referans: "ref-9" }], onay: false } }));
    expect(textOf(est)).toMatch(/Tahmini maliyet: \$0\.0060.*Hiçbir şey çalıştırılmadı/s);
    const tries = f.calls.filter((x) => x.path === "/api/languages/dil/profile/try");
    expect(tries).toHaveLength(1);
    expect(tries[0]!.body).toMatchObject({ dryRun: true, mode: "ai", profiles: ["draft"], samples: [{ id: "oge-1", text: "Anna & Marco", templateKey: "7", referenceId: "ref-9" }] });

    const run = asResult(await c.client.callTool({ name: "uretim_dene", arguments: { dil: "dil", ogeler: [{ referans: "ref-9" }], onay: true } }));
    expect(textOf(run)).toMatch(/gerçekleşen \$0\.0021/);
    expect(textOf(run)).toMatch(/Taslak: Anna \/ & \/ Marco · 0 sorun · referansla bölme AYNI/);
    expect(imagesOf(run)).toHaveLength(1);
    const real = f.calls.filter((x) => x.path === "/api/languages/dil/profile/try").at(-1)!;
    expect((real.body as { dryRun?: boolean }).dryRun).toBeUndefined();
  });

  it("soru_kaydet: soru ve cevap ayrı girdiler; oturum_notu durum verir", async () => {
    const f = fakeFetch(({ method, path }) => (method === "POST" && path.startsWith("/api/languages/dil/design-session") ? { json: { id: 1 } } : undefined));
    const c = await connect(f.fn);
    close = c.close;
    await c.client.callTool({ name: "soru_kaydet", arguments: { dil: "dil", grup: "bağlaçlar", soru: "& ortada mı?", cevap: "Evet, isimlerin arasında tek başına." } });
    await c.client.callTool({ name: "oturum_notu", arguments: { dil: "dil", metin: "Bitti", durum: "done" } });
    expect(f.calls.map((x) => x.body)).toEqual([
      { kind: "question", group: "bağlaçlar", text: "& ortada mı?" },
      { kind: "answer", group: "bağlaçlar", text: "Evet, isimlerin arasında tek başına." },
      { kind: "note", text: "Bitti", status: "done" },
    ]);
  });
});

describe("profil yardımcıları", () => {
  it("yapraklar açıklamalı yolda durur; şema alanları açıklama ve sınır taşır", () => {
    const leaves = profileLeaves(profile).map((l) => l.path);
    expect(leaves).toContain("fonts.list");
    expect(leaves).toContain("sizing.tiers.secondary");
    expect(leaves).not.toContain("schemaVersion");
    const fill = schemaFields().find((f) => f.path === "sizing.fill")!;
    expect(fill).toMatchObject({ min: 0.3, max: 1, default: 0.9, label: "Doluluk", enforcement: "motor (kesin)" });
    expect(schemaFields().find((f) => f.path === "lineBreaking.examples")!.type).toMatch(/^dizi</);
  });
});
