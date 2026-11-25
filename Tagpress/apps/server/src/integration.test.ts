import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeClaude, createFakeGemini, requestText, systemText, type AnthropicRequestBody, type FakeReply } from "@tagpress/ai/testing";
import { type AiCallSummary, type IntentLine, type Issue, type PlacedLine, PRINT_API } from "@tagpress/domain";
import { tagpressEnv } from "@tagpress/domain/env";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionPorts } from "./adapters/index.ts";
import { PROJECT_ROOT } from "./config.ts";
import { type TestApp, importJobs, makeApp } from "./test/helpers.ts";

/**
 * Uçtan uca: GERÇEK aktarım verisinin (data/aktarim + data/diller + data/ortak + referanslar) geçici kopyası,
 * GERÇEK templates + typeset + engine, SAHTE Claude (ağsız; gerçek istemci mantığı sahte fetch ile çalışır).
 * İçe aktar → üret → varyasyon + gerçek önizleme PNG'si → onay → baskı rafı.
 * Ölçüm testi: birim testlerine girmez; `pnpm test:olcum` ile koşar, veri yoksa açık hatayla düşer (atlanmaz).
 * Veri klasörü: TAGPRESS_DATA_DIR (eski adı STUDIO_DATA_DIR) ya da data/ (yalnız okunur; geçici kopyaya yazılır).
 */
const DATA_ENV = tagpressEnv("DATA_DIR")?.trim();
const DATA = DATA_ENV ? path.resolve(DATA_ENV) : path.join(PROJECT_ROOT, "data");
const migration = path.join(DATA, "aktarim");
const hasData = existsSync(migration) && readdirSync(migration).some((d) => existsSync(path.join(migration, d, "paket.json")));

const TEXTS = {
  couple: "Anna & Marco 12.10.2026",
  big: "Battesimo Diego",
  sticker: "Grazie",
  image: "Grazie Anna",
};

/** Sahte görüntü modeli: şablonun AYNISI + ortada koyu bir "yazı" bloğu (şablon pikseline dokunmadan yazmış gibi). */
async function fakeModelImage(req: { images?: Buffer[] }): Promise<Buffer> {
  const base = req.images![0]!;
  const meta = await sharp(base).metadata();
  const w = meta.width!, h = meta.height!;
  const block = await sharp({ create: { width: Math.round(w * 0.3), height: Math.round(h * 0.07), channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
  return sharp(base).composite([{ input: block, left: Math.round(w * 0.35), top: Math.round(h * 0.46) }]).png().toBuffer();
}

/** İstekteki müşteri metnine göre deterministik tasarım adayları; sıralama isteğine "B önce". */
function fakeReplies(body: AnthropicRequestBody): FakeReply {
  const sys = systemText(body);
  const user = requestText(body);
  if (sys.includes("You compare finished label designs")) {
    return { json: { ranking: ["B", "A"], reasons: [{ id: "B", reason: "Daha dengeli." }], noneAcceptable: false, summary: "B daha dengeli." } };
  }
  if (sys.includes("You read printed labels")) return { json: { lines: [TEXTS.image], legible: true } };
  if (sys.includes("exacting print art director")) {
    return {
      json: {
        verdict: "fix",
        summary: "Hiyerarşi zayıf.",
        issues: [{ code: "hierarchy", severity: "major", note: "Üst satır daha küçük olmalı." }],
        adjust: { sizeChangePercent: null, moveRightPercent: null, moveDownPercent: null, tiers: [{ line: 1, tier: "tertiary" }], lines: null },
      },
    };
  }
  if (sys.includes("design the typography")) {
    const font = "Great Vibes/Regular";
    const line = (text: string, role: string, tier: string) => ({ text, role, tier, fontId: font });
    if (user.includes(TEXTS.couple)) {
      return {
        json: {
          candidates: [
            { rationale: "İsimler bir satırda, tarih altta.", lines: [line("Anna & Marco", "name", "primary"), line("12.10.2026", "date", "tertiary")] },
            { rationale: "İsim / bağlaç / isim.", lines: [line("Anna", "name", "primary"), line("&", "connector", "connector"), line("Marco", "name", "primary"), line("12.10.2026", "date", "tertiary")] },
          ],
        },
      };
    }
    if (user.includes(TEXTS.big)) {
      return { json: { candidates: [{ rationale: "İki satır.", lines: [line("Battesimo", "title", "secondary"), line("Diego", "name", "primary")] }] } };
    }
    if (user.includes(TEXTS.sticker)) {
      return { json: { candidates: [{ rationale: "Tek satır.", lines: [line("Grazie", "greeting", "primary")] }] } };
    }
  }
  return { status: 400, error: { type: "invalid_request_error", message: `Sahte Claude: beklenmeyen istek: ${user.slice(0, 120)}` } };
}

if (!hasData) throw new Error(`Ölçüm testi gerçek veri ister: ${migration} altında paket.json bulunamadı. Veri klasörü: TAGPRESS_DATA_DIR ya da data/.`);

describe("uçtan uca üretim (gerçek veri kopyası, sahte Claude)", () => {
  let t: TestApp;
  let dir: string;
  const fake = createFakeClaude(Array.from({ length: 200 }, () => fakeReplies));
  const gemini = createFakeGemini(Array.from({ length: 20 }, () => fakeModelImage));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "studio-e2e-"));
    for (const sub of ["aktarim", "diller", "ortak", "referanslar"]) if (existsSync(path.join(DATA, sub))) cpSync(path.join(DATA, sub), path.join(dir, sub), { recursive: true });
    t = await makeApp({ dir, ports: productionPorts({ claude: () => fake.claude, gemini: () => gemini }) });
    await t.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-test-entegrasyon" });
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("içe aktar → üret → onay → baskı rafı", async () => {
    const health = (await t.api("GET", "/api/health")).json;
    expect(health.missingPorts).toEqual([]);
    const lang = t.inOrg(() => t.ctx.languages.list())[0]!.id;

    // İçe aktarma: gerçek glif kapsamı (Arapça yedek fontla basılır = bilgi notu, hata değil).
    const { commit, preview } = await importJobs(
      t,
      [
        { siparis: "E1", etiket: "12 3.8", adet: 10, text: TEXTS.couple },
        { siparis: "E2", etiket: "12 5.2", adet: 5, text: TEXTS.big },
        { siparis: "E3", etiket: "12", adet: 1, text: "Anna مريم" },
        { siparis: "E4", etiket: "", adet: 30, text: TEXTS.sticker, urun: "Sticker" },
      ],
      { generate: false },
    );
    expect(preview.rows[0].issues.filter((i: Issue) => i.severity === "error")).toEqual([]);
    const arabic = preview.rows[2].issues.map((i: Issue) => i.code);
    expect(arabic).toContain("text-fallback-font");
    expect(arabic).not.toContain("text-unprintable");
    const [coupleId, bigId, , stickerId] = commit.jobIds as string[];
    expect(preview.rows[3].kind).toBe("sticker");

    // Üretim: sahte Claude niyetleri → GERÇEK motor + font + şablon → gerçek önizleme.
    const gen = await t.api("POST", "/api/generate", { jobIds: [coupleId, bigId, stickerId] });
    expect(gen.json.skipped).toEqual([]);
    await t.ctx.queue.idle();
    const job = (await t.api("GET", `/api/jobs/${coupleId}`)).json;
    expect(job.status, JSON.stringify(job.issues)).toBe("ready");
    expect(job.variants).toHaveLength(1);
    expect(job.variants[0].issueCount).toBeTypeOf("number");
    const v = (await t.api("GET", `/api/variants/${job.variants[0].id}`)).json;
    // Sıralama "B önce" dedi: isim / bağlaç / isim seçildi.
    expect(v.intent.lines.map((l: IntentLine) => l.text)).toEqual(["Anna", "&", "Marco", "12.10.2026"]);
    expect(v.layout.ok).toBe(true);
    expect(v.layout.basePx).toBeGreaterThan(10);
    expect(v.layout.lines.every((l: PlacedLine) => l.runs.length > 0 && l.ink.w > 0)).toBe(true);
    expect(v.snapshot.costUsd).toBeGreaterThan(0);
    const png = await t.app.inject({ method: "GET", url: `/api/variants/${v.id}/preview.png` });
    const meta = await sharp(png.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([660, 660]);
    // Önizlemede yazı var: şablonun kendisinden farklı pikseller.
    const stats = await sharp(png.rawPayload).stats();
    expect(stats.channels[0]!.stdev).toBeGreaterThan(1);
    const log = (await t.api("GET", `/api/jobs/${coupleId}/log`)).json;
    expect(log.aiCalls.map((c: AiCallSummary) => c.purpose).sort()).toEqual(["design", "rank"]);
    // Tasarım isteği şablon + alan görseli taşıdı.
    const designReq = fake.requests.find((r) => systemText(r).includes("design the typography"))!;
    const images = (designReq.messages[0]!.content as Array<{ type: string }>).filter((c) => c.type === "image").length;
    expect(images).toBeGreaterThanOrEqual(2);

    // Onay → Baskı masasının rafı (onaylı, basılmamış işler).
    expect((await t.api("POST", `/api/jobs/${coupleId}/approve`, { variantId: v.id })).status).toBe(200);
    const bigJob = (await t.api("GET", `/api/jobs/${bigId}`)).json;
    expect(bigJob.status, JSON.stringify(bigJob.issues)).toBe("ready");
    await t.api("POST", `/api/jobs/${bigId}/approve`, { variantId: bigJob.variants[0].id });
    const stickerJob = (await t.api("GET", `/api/jobs/${stickerId}`)).json;
    expect(stickerJob.status, JSON.stringify(stickerJob.issues)).toBe("ready");
    await t.api("POST", `/api/jobs/${stickerId}/approve`, { variantId: stickerJob.variants[0].id });
    const shelf = (await t.api("GET", `${PRINT_API.shelf}?languageId=${lang}`)).json.items as { jobId: string; kind: string }[];
    expect(shelf.map((s) => s.jobId).sort()).toEqual([coupleId, bigId, stickerId].sort());
    expect(shelf.find((s) => s.jobId === stickerId)?.kind).toBe("sticker");
  }, 120_000);

  it("şablona yaz: sonuç = ORİJİNAL şablon + ayrı yazı katmanı; yazı okunur ve doğrulanır", async () => {
    await t.api("PUT", "/api/settings/keys/gemini", { apiKey: "gm-test-entegrasyon" });
    const { commit } = await importJobs(t, [{ siparis: "I1", etiket: "12 3.8", adet: 1, text: TEXTS.image }]);
    const gen = await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "image-on-template" });
    expect(gen.json.skipped).toEqual([]);
    await t.ctx.queue.idle();
    const job = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
    expect(job.status, JSON.stringify([job.error, job.issues])).toBe("ready");
    const v = (await t.api("GET", `/api/variants/${job.variants[0].id}`)).json;
    expect(v.kind).toBe("image-on-template");
    expect(v.issues).toEqual([]);
    expect(v.image.readText).toBe(TEXTS.image);
    // Yazı kutusu tasarım alanında ve ortaya yakın.
    expect(v.image.textBox.x).toBeGreaterThan(100);
    expect(v.image.textBox.x + v.image.textBox.w).toBeLessThan(340);
    const layer = await t.app.inject({ method: "GET", url: `/api/variants/${v.id}/text-layer.png` });
    expect(layer.statusCode).toBe(200);
    const log = (await t.api("GET", `/api/jobs/${job.id}/log`)).json;
    expect(log.aiCalls.map((c: AiCallSummary) => c.purpose).sort()).toEqual(["image", "transcribe"]);
  }, 120_000);

  it("tasarım dili denemesi (motor modu, referansla) ve şablon denemesi AI'sız çalışır; kalıcı varyasyon üretmez", async () => {
    const lang = t.inOrg(() => t.ctx.languages.list())[0]!.id;
    const ref = t.inOrg(() => t.ctx.references.list({ languageId: lang }).find((r) => r.templateKey && t.ctx.templates.find(lang, r.templateKey)))!;
    const before = (t.raw.get("SELECT COUNT(*) AS n FROM variants") as { n: number }).n;
    const r = await t.api("POST", `/api/languages/${lang}/profile/try`, {
      samples: [
        { id: "s1", text: ref.text, templateKey: ref.templateKey, referenceId: ref.id },
        { id: "s2", text: "Grazie di cuore  Anna & Luca", templateKey: ref.templateKey },
      ],
      profiles: ["published", "draft"],
      mode: "engine",
    });
    expect(r.status, r.body).toBe(200);
    expect(r.json.estimateUsd).toBe(0);
    const s1 = r.json.results[0];
    expect(s1.published.lines.length).toBeGreaterThan(0);
    expect(s1.published.sameBreaksAsReference).toBe(true);
    expect(s1.published.sizeDiffVsReference).toBeTypeOf("number");
    expect(s1.draft).toBeNull();
    expect(s1.error).toMatch(/Taslak/);
    expect(r.json.results[1].published.lines).toEqual(["Grazie di cuore", "Anna & Luca"]);
    const img = await t.app.inject({ method: "GET", url: s1.published.previewUrl });
    expect(img.statusCode).toBe(200);
    expect((t.raw.get("SELECT COUNT(*) AS n FROM variants") as { n: number }).n).toBe(before);

    const tried = await t.api("POST", `/api/languages/${lang}/templates/${ref.templateKey}/try`, { text: "Anna & Marco  12.10.2026", patch: { ribbonTop: 0.1 } });
    expect(tried.status, tried.body).toBe(200);
    expect(tried.json.lines).toEqual(["Anna & Marco", "12.10.2026"]);
    expect(tried.json.basePt).toBeGreaterThan(0);
    expect((await sharp(Buffer.from(tried.json.png, "base64")).metadata()).width).toBe(660);
    // Yama kayda yazılmadı.
    expect(t.inOrg(() => t.ctx.templates.find(lang, ref.templateKey!))!.ribbonTop).not.toBe(0.1);

    const area = await t.api("POST", `/api/languages/${lang}/templates/${ref.templateKey}/suggest-area`, { decoration: { dilatePx: 6 } });
    expect(area.status, area.body).toBe(200);
    expect(["ellipse", "rect", "circle"]).toContain(area.json.shape.kind);

    const refImg = await t.app.inject({ method: "GET", url: `/api/references/${ref.id}/image.png` });
    expect(refImg.statusCode).toBe(200);
    expect(refImg.headers["content-type"]).toBe("image/png");
  }, 120_000);
});
