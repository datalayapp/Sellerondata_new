import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiCallSummary, CostSummary, IntentLine, Issue, ProgressStep, VariantSummary } from "@tagpress/domain";
import { AiBusyError } from "./adapters/ai.ts";
import type { AiErrorLike } from "./ports.ts";
import { type TestApp, call, fakeDesigner, fakeImageGenerator, fullPorts, importJobs, makeApp, seedLanguage } from "./test/helpers.ts";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const job = async (id: string) => (await t.api("GET", `/api/jobs/${id}`)).json;

describe("üretim kuyruğu (sahte portlarla)", () => {
  it("başarı: adaylar → aynısı elenir → AI seçer → varyasyon; çağrılar ve maliyet kaydedilir", async () => {
    const designer = fakeDesigner();
    t = await makeApp({ ports: fullPorts({ designer }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    expect(commit.queued).toEqual(commit.jobIds);
    await t.ctx.queue.idle();
    const j = await job(commit.jobIds[0]);
    expect(j.status).toBe("ready");
    expect(j.variants).toHaveLength(1);
    expect(j.variants[0]).toMatchObject({ no: 1, kind: "text", aiRank: 1, suspect: false, stale: false });
    const v = (await t.api("GET", `/api/variants/${j.variants[0].id}`)).json;
    expect(v.intent.lines.map((l: IntentLine) => l.text)).toEqual(["Anna", "Marco"]); // AI ikinciyi seçti
    expect(v.snapshot).toMatchObject({ model: "claude-haiku-5-5", promptVersion: "test-1", profileVersion: 1, templateKey: "a1", text: "Anna Marco" });
    expect(v.snapshot.costUsd).toBeGreaterThan(0);
    const preview = await t.api("GET", `/api/variants/${v.id}/preview.png`);
    expect(preview.headers["content-type"]).toBe("image/png");
    // Kimlik isteyen içerik (platform) paylaşılan önbelleğe girmez; yerel kipte de `private` (R1).
    expect(String(preview.headers["cache-control"])).toBe("private, max-age=31536000, immutable");
    const log = (await t.api("GET", `/api/jobs/${j.id}/log`)).json;
    expect(log.aiCalls.map((c: AiCallSummary) => c.purpose).sort()).toEqual(["design", "pick"]);
    expect(log.steps.map((s: ProgressStep) => s.step)).toEqual(expect.arrayContaining(["context", "ai", "layout", "pick", "done"]));
    expect(log.steps.some((s: ProgressStep) => /aynı, elendi/.test(s.message))).toBe(true);
    const full = (await t.api("GET", `/api/ai-calls/${log.aiCalls[0].id}`)).json;
    expect(full.response).toMatch(/ham/);
    const costs = (await t.api("GET", "/api/costs")).json;
    expect(costs.todayUsd).toBeCloseTo(costs.totalUsd);
    expect(costs.byPurpose.map((p: CostSummary["byPurpose"][number]) => p.purpose)).toEqual(["design", "pick"]);

    // İkinci tur: önceki niyetler AI'a gider; ayarla iki varyasyon.
    await t.api("PATCH", "/api/settings", { variantsPerRun: 2 });
    await t.api("POST", "/api/generate", { jobIds: [j.id] });
    await t.ctx.queue.idle();
    expect(designer.requests[1]!.previous).toHaveLength(1);
    const j2 = await job(j.id);
    expect(j2.variants.map((x: VariantSummary) => [x.no, x.aiRank])).toEqual([[1, 1], [2, 1], [3, 2]]);
  });

  it("AI hatası: iş başarısız + ai-failed; hatadaki çağrılar yine kaydedilir; yeniden deneme sorunu temizler", async () => {
    let fail = true;
    const designer = fakeDesigner({
      design: async (req) => {
        if (fail) {
          const err = new Error("Anthropic 529: aşırı yük") as AiErrorLike;
          err.calls = [{ ...call("design"), error: "529" }];
          throw err;
        }
        return fakeDesigner().design(req);
      },
    });
    t = await makeApp({ ports: fullPorts({ designer }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }], { generate: true });
    await t.ctx.queue.idle();
    let j = await job(commit.jobIds[0]);
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/529/);
    expect(j.issues.map((i: Issue) => i.code)).toContain("ai-failed");
    expect((await t.api("GET", "/api/jobs?status=failed")).json.total).toBe(1);
    const log = (await t.api("GET", `/api/jobs/${j.id}/log`)).json;
    expect(log.aiCalls[0]).toMatchObject({ purpose: "design", error: "529" });
    expect(log.steps.at(-1).step).toBe("error");
    fail = false;
    await t.api("POST", "/api/generate", { jobIds: [j.id] });
    await t.ctx.queue.idle();
    j = await job(j.id);
    expect(j).toMatchObject({ status: "ready", error: null });
    expect(j.issues.map((i: Issue) => i.code)).not.toContain("ai-failed");
  });

  it("müşteri metnini değiştiren aday kullanılmaz; hiçbiri uymazsa no-layout", async () => {
    const designer = fakeDesigner({
      design: async (req) => ({
        candidates: [
          { lines: [{ text: req.text.toUpperCase(), role: "other", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "" },
          ...(req.text === "Anna" ? [] : [{ lines: [{ text: req.text, role: "other" as const, tier: "primary" as const, fontId: "Great Vibes/Regular" }], rationale: "" }]),
        ],
        model: "m",
        promptVersion: "p",
        calls: [],
      }),
    });
    t = await makeApp({ ports: fullPorts({ designer }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Elena" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Anna" },
    ], { generate: true });
    await t.ctx.queue.idle();
    const ok = await job(commit.jobIds[0]);
    expect(ok.variants).toHaveLength(1);
    const bad = await job(commit.jobIds[1]);
    expect(bad.status).toBe("failed");
    expect(bad.issues.map((i: Issue) => i.code)).toContain("no-layout");
  });

  it("eksik port ya da engelleyen sorun varsa kuyruğa alınmaz", async () => {
    t = await makeApp();
    await seedLanguage(t);
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "zz", adet: 1, text: "Marco" },
    ]);
    const r = await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
    expect(r.json.queued).toEqual([]);
    expect(r.json.skipped[0].reason).toMatch(/bağlı değil/);
    t.ctx.ports.geometry = fullPorts().geometry!;
    t.ctx.ports.engine = fullPorts().engine!;
    t.ctx.ports.designer = fakeDesigner();
    const r2 = await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
    expect(r2.json.queued).toEqual([commit.jobIds[0]]);
    expect(r2.json.skipped[0].reason).toMatch(/zz/);
    const r3 = await t.api("POST", "/api/generate", { jobIds: [commit.jobIds[0]] });
    expect(r3.json.skipped[0]?.reason ?? "").toMatch(/zaten/);
    await t.ctx.queue.idle();
  });

  it("açılışta yarıda kalan görev kurtarılır; üst üste yarıda kalan durdurulur", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "studio-kurtar-"));
    try {
      t = await makeApp({ dir, startQueue: false });
      await seedLanguage(t);
      const { commit } = await importJobs(t, [
        { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
        { siparis: "2", etiket: "a1", adet: 1, text: "Marco" },
      ]);
      const [a, b] = commit.jobIds;
      const now = new Date().toISOString();
      t.raw.run("INSERT INTO gen_tasks (org_id, id, job_id, mode, params, status, attempts, created_at) VALUES (?, 't1', ?, 'text', '{}', 'running', 1, ?)", t.org, a, now);
      t.raw.run("INSERT INTO gen_tasks (org_id, id, job_id, mode, params, status, attempts, created_at) VALUES (?, 't2', ?, 'text', '{}', 'running', 3, ?)", t.org, b, now);
      t.raw.run("UPDATE jobs SET gen_state = 'generating'");
      await t.close();

      t = await makeApp({ dir, ports: fullPorts() });
      await t.ctx.queue.idle();
      expect((await job(a)).status).toBe("ready");
      const jb = await job(b);
      expect(jb).toMatchObject({ status: "failed", error: "Üretim yarıda kaldı." });
      expect(t.raw.get("SELECT status FROM gen_tasks WHERE id = 't2'")).toEqual({ status: "failed" });
      await t.close();
      t = undefined as unknown as TestApp;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bekleyenler iptal edilebilir", async () => {
    t = await makeApp({ ports: fullPorts(), startQueue: false });
    await seedLanguage(t);
    await t.api("PATCH", "/api/settings", { concurrency: 1 });
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Marco" },
    ]);
    let release = () => undefined as void;
    t.ctx.queue.setRunner(async () => new Promise<void>((r) => (release = r))); // ilk görev bırakılana kadar sürer
    await t.api("POST", "/api/generate", { jobIds: commit.jobIds });
    await new Promise((r) => setTimeout(r, 10));
    const st = (await t.api("GET", "/api/generate/status")).json;
    expect(st).toMatchObject({ running: 1, queued: 1, concurrency: 1 });
    expect((await t.api("POST", "/api/generate/cancel", {})).json.cancelled).toBe(1);
    expect((await job(commit.jobIds[1])).status).toBe("new");
    expect((await job(commit.jobIds[0])).status).toBe("generating");
    release();
    await t.ctx.queue.idle();
    expect((await job(commit.jobIds[0])).status).toBe("new");
  });

  // Para incelemesi R2b-4: geçidin hız reddi (`sod_rate_limited`) görevi `retryAfter` sonra yeni istekle yeniden kuyruğa alır.
  it("geçit yoğun (sod_rate_limited): görev beklenip yeni istekle yeniden kuyruğa girer; iş başarısız sayılmaz", async () => {
    let busy = 1;
    const designer = fakeDesigner({
      design: async (req) => {
        if (busy-- > 0) throw new AiBusyError("Yapay zekâ geçidi: yapay zekâ şu an yoğun (sod_rate_limited).", [{ ...call("design"), error: "sod_rate_limited" }], 20);
        return fakeDesigner().design(req);
      },
    });
    const spy = { n: 0 };
    const counting = { ...designer, design: (req: Parameters<typeof designer.design>[0]) => (spy.n++, designer.design(req)) };
    t = await makeApp({ ports: fullPorts({ designer: counting }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    await t.ctx.queue.idle();
    expect(spy.n).toBe(2);
    const j = await job(commit.jobIds[0]);
    expect(j.status).toBe("ready");
    expect(j.issues.map((i: Issue) => i.code)).not.toContain("ai-failed");
    expect(t.raw.get("SELECT status, attempts FROM gen_tasks WHERE job_id = ?", commit.jobIds[0])).toEqual({ status: "done", attempts: 2 });
    const log = (await t.api("GET", `/api/jobs/${j.id}/log`)).json;
    expect(log.steps.some((s: ProgressStep) => /yoğun/.test(s.message))).toBe(true);
  });

  it("geçit hep yoğunsa deneme sınırında (3) görev durur: iş başarısız + ai-failed", async () => {
    let n = 0;
    const designer = fakeDesigner({
      design: async () => {
        n++;
        throw new AiBusyError("Yapay zekâ geçidi: yapay zekâ şu an yoğun (sod_rate_limited).", [], 0);
      },
    });
    t = await makeApp({ ports: fullPorts({ designer }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }], { generate: true });
    await t.ctx.queue.idle();
    expect(n).toBe(3);
    const j = await job(commit.jobIds[0]);
    expect(j.status).toBe("failed");
    expect(j.issues.map((i: Issue) => i.code)).toContain("ai-failed");
    expect(t.raw.get("SELECT status, attempts FROM gen_tasks WHERE job_id = ?", commit.jobIds[0])).toEqual({ status: "failed", attempts: 3 });
  });
});

describe("görüntü üretimi ve revizyon", () => {
  it("şablona yaz: yazı katmanı ayrı; görseldeki yazı farklıysa sorun + kontrol işareti", async () => {
    t = await makeApp({ ports: fullPorts({ imageGenerator: fakeImageGenerator({ readText: "Anna Marko" }) }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const r = await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "image-on-template" });
    expect(r.json.queued).toHaveLength(1);
    await t.ctx.queue.idle();
    const j = await job(commit.jobIds[0]);
    const v = (await t.api("GET", `/api/variants/${j.variants[0].id}`)).json;
    expect(v).toMatchObject({ kind: "image-on-template", suspect: true, layout: null, image: { readText: "Anna Marko" } });
    expect(v.issues.map((i: Issue) => i.code)).toEqual(["image-text-mismatch"]);
    expect((await t.api("GET", v.image.textLayerUrl)).status).toBe(200);
    const costs = (await t.api("GET", "/api/costs")).json;
    expect(costs.byModel[0]).toMatchObject({ model: "gemini-3.1-flash-image", usd: 0.067 });
  });

  it("şablon pikseli değişirse image-template-changed hatası", async () => {
    t = await makeApp({ ports: fullPorts({ imageGenerator: fakeImageGenerator({ untouched: false }) }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "image-on-template" });
    await t.ctx.queue.idle();
    const v = (await job(commit.jobIds[0])).variants[0];
    expect(v).toMatchObject({ suspect: true, worst: "error" });
  });

  it("temadan şablon: kütüphaneye 'generated' eklenir, normal metin akışıyla tasarlanır", async () => {
    t = await makeApp({ ports: fullPorts() });
    const lang = await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    const noTheme = await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "generated-template" });
    await t.ctx.queue.idle();
    expect((await job(commit.jobIds[0])).error).toMatch(/tema/);
    expect(noTheme.json.queued).toHaveLength(1);
    await t.api("POST", "/api/generate", { jobIds: commit.jobIds, mode: "generated-template", theme: "lavanta çelengi" });
    await t.ctx.queue.idle();
    const j = await job(commit.jobIds[0]);
    expect(j.status).toBe("ready");
    const v = (await t.api("GET", `/api/variants/${j.variants[0].id}`)).json;
    expect(v.kind).toBe("generated-template");
    expect(v.stale).toBe(false);
    const tpl = t.inOrg(() => t.ctx.templates.find(lang, v.snapshot.templateKey))!;
    expect(tpl).toMatchObject({ kind: "generated", notes: "lavanta çelengi", generatedFrom: { prompt: "lavanta çelengi" } });
    expect(existsSync(t.inOrg(() => t.ctx.templates.imagePath(lang, tpl)))).toBe(true);
    expect(j.templateKey).toBe("a1");
  });

  it("revizyon: kaynak niyet + istek AI'a gider, kaynak varyasyon kalır", async () => {
    const designer = fakeDesigner();
    t = await makeApp({ ports: fullPorts({ designer }) });
    await seedLanguage(t);
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    await t.ctx.queue.idle();
    const first = (await job(commit.jobIds[0])).variants[0];
    const r = await t.api("POST", `/api/variants/${first.id}/revise`, { request: "isimleri büyüt" });
    expect(r.json.queued).toHaveLength(1);
    await t.ctx.queue.idle();
    const last = designer.requests.at(-1)!;
    expect(last.revision).toMatchObject({ request: "isimleri büyüt" });
    expect(last.revision!.intent!.lines.length).toBeGreaterThan(0);
    const j = await job(commit.jobIds[0]);
    expect(j.variants).toHaveLength(2);
    const v2 = (await t.api("GET", `/api/variants/${j.variants[1].id}`)).json;
    expect(v2.snapshot.revision).toEqual({ fromVariantId: first.id, request: "isimleri büyüt" });
  });
});
