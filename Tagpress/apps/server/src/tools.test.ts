import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyTester } from "./adapters/ai.ts";
import type { CostSummary, LanguagePackage, Profile, ProfileTryDebug } from "@tagpress/domain";
import { isUuidv7 } from "./util/ids.ts";
import { type TestApp, fakeDesigner, fullPorts, importJobs, makeApp, png, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

describe("anahtar denemesi", () => {
  it("anahtar yoksa ok=false; varsa sağlayıcıya küçük GET; 401 anlaşılır mesaj", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const tester = createKeyTester((async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return String(url).includes("anthropic") ? new Response("{}", { status: 200 }) : new Response('{"error":{"message":"API key not valid"}}', { status: 401 });
    }) as typeof fetch);
    t = await makeApp({ ports: { keyTester: tester } });
    expect((await t.api("POST", "/api/settings/keys/anthropic/test")).json).toMatchObject({ ok: false, message: "Anahtar girilmemiş." });
    await t.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-ant-deneme-1234" });
    await t.api("PUT", "/api/settings/keys/gemini", { apiKey: "gm-deneme-1234" });
    expect((await t.api("POST", "/api/settings/keys/anthropic/test")).json).toEqual({ ok: true, message: "Bağlantı çalışıyor.", model: "claude-haiku-5-5" });
    const g = (await t.api("POST", "/api/settings/keys/gemini/test")).json;
    expect(g.ok).toBe(false);
    expect(g.message).toMatch(/geçersiz.*API key not valid/);
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-ant-deneme-1234");
    expect(seen[1]!.headers["x-goog-api-key"]).toBe("gm-deneme-1234");
    expect((await t.api("POST", "/api/settings/keys/openai/test")).status).toBe(400);
  });
});

describe("temadan şablon görevi", () => {
  it("kuyruğa alınır, bitince 'generated' şablon eklenir; görev durumu okunur", async () => {
    t = await makeApp({ ports: fullPorts() });
    const lang = await seedLanguage(t);
    const r = await t.api("POST", `/api/languages/${lang}/templates/generate`, { theme: "pastel çiçekler", key: "pastel-1", keep: false, sampleText: "Anna" });
    expect(r.status, r.body).toBe(200);
    expect(r.json.status).toBe("queued");
    await t.ctx.templateTasks.idle();
    const task = (await t.api("GET", `/api/template-tasks/${r.json.id}`)).json;
    expect(task).toMatchObject({ status: "done", key: "pastel-1", error: null });
    const tpl = (await t.api("GET", `/api/languages/${lang}/templates/pastel-1`)).json.template;
    expect(tpl).toMatchObject({ kind: "generated", notes: "pastel çiçekler", tags: ["uretilen", "gecici"] });
    expect(tpl.generatedFrom.model).toBe("gemini-3.1-flash-image");
    // Aynı anahtar tekrar istenirse 409.
    expect((await t.api("POST", `/api/languages/${lang}/templates/generate`, { theme: "x", key: "pastel-1" })).status).toBe(409);
    expect((await t.api("GET", "/api/template-tasks/yok")).status).toBe(404);
  });

  it("görüntü üretimi bağlı değilse 501", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    expect((await t.api("POST", `/api/languages/${lang}/templates/generate`, { theme: "x" })).status).toBe(501);
  });
});

describe("tasarım dili paketi", () => {
  it("dışa aktar → içe aktar: profil, taslak, şablon kayıtları + PNG'ler ve fontlar yeni dile gelir", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t, ["a1", "b2"]);
    await t.api("PATCH", `/api/languages/${lang}/templates/a1`, { ribbonTop: 0.2, notes: "çelenk" });
    const fontsDir = t.inOrg(() => t.ctx.paths.fonts(lang));
    mkdirSync(fontsDir, { recursive: true });
    writeFileSync(path.join(fontsDir, "GreatVibes.ttf"), Buffer.from("\u0000\u0001\u0000\u0000sahte-font"));
    await t.api("PUT", `/api/languages/${lang}/profile/draft`, { data: { ...t.inOrg(() => t.ctx.profiles.activeProfile(lang)).profile, description: "taslak" } });
    const exp = await t.api("GET", `/api/languages/${lang}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers["content-disposition"]).toMatch(/tasarim-dili-deneme\.json/);
    expect(exp.json.templates).toHaveLength(2);
    expect(exp.json.fonts.map((f: LanguagePackage["fonts"][number]) => f.file)).toEqual(["GreatVibes.ttf"]);

    const imp = await t.api("POST", "/api/languages/import", { ...exp.json, name: "Kopya" });
    expect(imp.status, imp.body).toBe(200);
    expect(imp.json).toMatchObject({ templates: 2, fonts: 1, warnings: [] });
    const id = imp.json.language.id;
    // Paketteki kimlik ("deneme") kullanılmaz: içe aktarılan dil yeni UUIDv7 alır (kimlik varlığı ele verilmesin).
    expect(isUuidv7(id)).toBe(true);
    expect(imp.json.language).toMatchObject({ name: "Kopya", hasDraft: true, templateCount: 2 });
    const a1 = (await t.api("GET", `/api/languages/${id}/templates/a1`)).json;
    expect(a1).toMatchObject({ fileMissing: false, template: { ribbonTop: 0.2, notes: "çelenk", languageId: id } });
    expect((await t.api("GET", `/api/languages/${id}/templates/a1/image.png`)).status).toBe(200);
    expect((await t.api("GET", `/api/languages/${id}/profile/draft`)).json.data.description).toBe("taslak");

    // Geçersiz paket: alan yollarıyla 400.
    const bad = await t.api("POST", "/api/languages/import", { ...exp.json, profile: { name: "" } });
    expect(bad.status).toBe(400);
  });

  it("eski adlı alanla (figma.frameName) gelen paket içe alınınca yeni ada çevrilir; dışa aktarma yeni adla", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t, ["a1"]);
    const exp = (await t.api("GET", `/api/languages/${lang}/export`)).json;
    expect(exp.profile.printing.orderNamePattern).toBe("{orderNo}_{quantity}adet");
    expect(exp.profile).not.toHaveProperty("figma");
    const legacy = (p: Profile, frameName: string) => {
      const { orderNamePattern: _, ...printing } = p.printing;
      return { ...p, printing, figma: { frameName, maxShrink: 0.03, maxShiftPx: 4 } };
    };
    const pkg = { ...exp, profile: legacy(exp.profile, "{orderNo}-{template}"), draft: legacy(exp.profile, "{orderNo}/taslak") };
    const imp = await t.api("POST", "/api/languages/import", { ...pkg, name: "Eski paket" });
    expect(imp.status, imp.body).toBe(200);
    expect(imp.json.warnings).toEqual([]);
    const id = imp.json.language.id;
    const active = (await t.api("GET", `/api/languages/${id}/profile`)).json;
    expect(active.data.printing.orderNamePattern).toBe("{orderNo}-{template}");
    expect(active.data).not.toHaveProperty("figma");
    const draft = (await t.api("GET", `/api/languages/${id}/profile/draft`)).json;
    expect(draft.data.printing.orderNamePattern).toBe("{orderNo}/taslak");
    const stored = t.raw.all("SELECT data FROM profile_versions WHERE language_id = ?", id) as { data: string }[];
    expect(stored.map((r) => r.data).join()).not.toContain("figma");
    const again = (await t.api("GET", `/api/languages/${id}/export`)).json;
    expect(again.profile.printing.orderNamePattern).toBe("{orderNo}-{template}");
    expect(again.draft.printing.orderNamePattern).toBe("{orderNo}/taslak");
  });

  it("büyük paket (≈80 MB gövde) kabul edilir", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t, ["a1"]);
    const exp = (await t.api("GET", `/api/languages/${lang}/export`)).json;
    const big = Buffer.alloc(60 * 1024 * 1024, 7).toString("base64");
    const r = await t.api("POST", "/api/languages/import", { ...exp, fonts: [{ file: "Buyuk.ttf", data: big }] });
    expect(r.status, r.body.slice(0, 200)).toBe(200);
    expect(r.json.fonts).toBe(1);
  }, 60_000);
});

describe("tasarım dili denemesi (sahte portlar)", () => {
  it("dryRun yalnızca tahmin; ai modu tasarımcıyı çağırır, maliyeti döner, kalıcı varyasyon üretmez", async () => {
    const designer = fakeDesigner();
    t = await makeApp({ ports: fullPorts({ designer }) });
    const lang = await seedLanguage(t);
    const body = { samples: [{ id: "x1", text: "Anna Marco", templateKey: "a1" }], profiles: ["published"] };
    const dry = (await t.api("POST", `/api/languages/${lang}/profile/try`, { ...body, dryRun: true })).json;
    expect(dry.estimateUsd).toBeGreaterThan(0);
    expect(dry.results).toEqual([]);
    expect(designer.requests).toHaveLength(0);

    const r = await t.api("POST", `/api/languages/${lang}/profile/try`, body);
    expect(r.status, r.body).toBe(200);
    expect(r.json.mode).toBe("ai");
    const side = r.json.results[0].published;
    expect(side.lines).toEqual(["Anna", "Marco"]); // sahte sıralama ikinciyi seçti
    expect(side.costUsd).toBeGreaterThan(0);
    expect(r.json.costUsd).toBeCloseTo(side.costUsd, 6);
    expect((await t.app.inject({ method: "GET", url: side.previewUrl })).statusCode).toBe(200);
    expect((t.raw.get("SELECT COUNT(*) AS n FROM variants") as { n: number }).n).toBe(0);
    expect((await t.api("GET", "/api/costs")).json.byPurpose.map((p: CostSummary["byPurpose"][number]) => p.purpose).sort()).toEqual(["deneme-design", "deneme-pick"]);
    expect((await t.api("GET", "/api/trials/../../x/preview.png")).status).toBe(404);
    expect(side.debug).toBeUndefined();

    // Hata ayıklama: bütün adaylar, motor puanları, sıralama ve seçilen (aday dizinleriyle).
    const dbg = (await t.api("POST", `/api/languages/${lang}/profile/try`, { ...body, debug: true })).json.results[0].published.debug;
    expect(dbg.candidates).toHaveLength(3);
    expect(dbg.candidates.slice(0, 2).every((c: ProfileTryDebug["candidates"][number]) => c.placed && typeof c.score === "number" && c.lines.length === c.fonts.length)).toBe(true);
    // Üçüncü aday birinciyle aynı: üretim akışı gibi elenir, gerekçesi yazılır.
    expect(dbg.candidates[2]).toMatchObject({ placed: false, note: "öncekiyle aynı" });
    expect(dbg.ranking).toEqual([1, 0]);
    expect(dbg.chosen).toBe(1);
    expect(dbg.candidates[1].lines).toEqual(["Anna", "Marco"]);
    expect(dbg.reasons).toHaveLength(dbg.candidates.length);
  });

  it("VariantSummary.issueCount: bilgi notları sayılmaz", async () => {
    t = await makeApp({ ports: fullPorts() });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }], { generate: true });
    await t.ctx.queue.idle();
    const job = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
    expect(job.variants[0].issueCount).toBe(0);
  });

  it("referans görseli yoksa 404", async () => {
    t = await makeApp();
    const lang = await seedLanguage(t);
    const ref = await t.api("POST", "/api/references", {
      languageId: lang,
      source: "figma",
      orderNo: null,
      quantity: null,
      templateKey: "a1",
      labelFramePx: 440,
      text: "Anna",
      user: [{ text: "Anna", family: "Great Vibes", style: "Regular", sizePx: 40, segments: [], ink: { x: 1, y: 1, w: 10, h: 10 } }],
      program: null,
      programMeta: null,
      image: `referanslar/${lang}/ref.png`,
      split: "train",
    });
    expect(ref.status, ref.body).toBe(200);
    expect((await t.api("GET", `/api/references/${ref.json.id}/image.png`)).status).toBe(404);
    const refsDir = t.inOrg(() => t.ctx.paths.references(lang));
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(path.join(refsDir, "ref.png"), await png(8, 8));
    expect((await t.api("GET", `/api/references/${ref.json.id}/image.png`)).status).toBe(200);
    // Klasör dışı yol artık kabul edilmez (ayrıntı: safe-path.test.ts).
    expect((await t.api("POST", "/api/references", { ...ref.json, id: undefined, createdAt: undefined, image: "../../disari.png" })).status).toBe(400);
  });
});
