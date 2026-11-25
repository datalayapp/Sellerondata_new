import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInOrg } from "./org/context.ts";
import { DAY_MS } from "./util/clock.ts";
import { type TestApp, fakeLayout, fullPorts, importJobs, makeApp, png, seedLanguage } from "./test/helpers.ts";
import type { Issue, JobSummary, Skipped } from "@tagpress/domain";

/** Servisi doğrudan çağıran test satırları sunucudaki gibi firma bağlamında çalışır (bağlamsız çağrı sayılmaz). */
function inOrg<T>(t: TestApp, fn: () => T): T {
  return runInOrg(t.ctx.orgs.defaultOrgId()!, fn);
}

describe("işler: liste, sıralama, filtre", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await seedLanguage(t);
  });
  afterEach(() => t.close());

  it("varsayılan sıra en yeni üstte; sipariş no sayısal; filtreler; arama", async () => {
    await importJobs(t, [
      { siparis: "10", etiket: "a2", adet: 1, text: "Onuncu" },
      { siparis: "9", etiket: "a1", adet: 1, text: "Dokuzuncu" },
    ]);
    t.clock.advance(60_000);
    await importJobs(t, [
      { siparis: "100", etiket: "yok", adet: 1, text: "Yüzüncü" },
      { etiket: "a1", adet: 1, text: "Siparişsiz" },
    ]);
    const list = async (q = "") => (await t.api("GET", `/api/jobs${q}`)).json.jobs.map((j: JobSummary) => j.text);
    expect((await list()).slice(0, 2)).toEqual(["Siparişsiz", "Yüzüncü"]);
    expect(await list("?sort=created&dir=asc")).toEqual(["Onuncu", "Dokuzuncu", "Yüzüncü", "Siparişsiz"]);
    expect(await list("?sort=order&dir=asc")).toEqual(["Dokuzuncu", "Onuncu", "Yüzüncü", "Siparişsiz"]);
    expect(await list("?sort=order&dir=desc")).toEqual(["Yüzüncü", "Onuncu", "Dokuzuncu", "Siparişsiz"]);
    expect(await list("?sort=template&dir=asc")).toEqual(["Siparişsiz", "Dokuzuncu", "Onuncu", "Yüzüncü"]);
    // Sorun var: şablonu olmayan (hata) + sipariş no'suz (uyarı).
    expect((await list("?issues=yes")).sort()).toEqual(["Siparişsiz", "Yüzüncü"]);
    expect((await list("?issues=no")).sort()).toEqual(["Dokuzuncu", "Onuncu"]);
    expect(await list("?q=onunc")).toEqual(["Onuncu"]);
    expect(await list("?q=100")).toEqual(["Yüzüncü"]);
    expect(await list("?status=new")).toHaveLength(4);
    expect(await list("?status=ready")).toHaveLength(0);
    const batches = (await t.api("GET", "/api/batches")).json.batches;
    expect(batches).toHaveLength(2);
    expect(batches[0].withIssues).toBe(2);
    expect(await list(`?batchId=${batches[1].id}`)).toHaveLength(2);
  });

  it("düzenleme sorunları yeniden hesaplar; geçersiz alan reddedilir", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "yok", adet: 1, text: "Anna" }]);
    const id = commit.jobIds[0];
    expect((await t.api("GET", `/api/jobs/${id}`)).json.issues.map((i: Issue) => i.code)).toContain("template-unknown");
    const r = await t.api("PATCH", `/api/jobs/${id}`, { templateKey: "A2", text: "Anna  Marco", aiNote: "altın" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ templateKey: "a2", segments: ["Anna", "Marco"], aiNote: "altın", issues: [] });
    expect((await t.api("PATCH", `/api/jobs/${id}`, { bilinmeyen: 1 })).status).toBe(400);
    const bulk = await t.api("POST", "/api/jobs/bulk", { ids: [id], patch: { labelSize: "9.9" } });
    expect(bulk.json.jobs[0].issues.map((i: Issue) => i.code)).toEqual(["size-unknown"]);
  });
});

describe("yumuşak silme ve geri alma", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({ ports: fullPorts() });
    await seedLanguage(t);
  });
  afterEach(() => t.close());

  it("iş silinir, listeden kalkar, geri alınır; aynı anahtar ikinci kez kullanılamaz", async () => {
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Marco" },
    ]);
    const del = await t.api("POST", "/api/jobs/delete", { ids: commit.jobIds });
    expect(del.status).toBe(200);
    expect(del.json.label).toMatch(/2 iş/);
    expect((await t.api("GET", "/api/jobs")).json.total).toBe(0);
    expect((await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).status).toBe(404);
    const undo = await t.api("POST", `/api/undo/${del.json.undoToken}`);
    expect(undo.json.restored.jobs).toBe(2);
    expect((await t.api("GET", "/api/jobs")).json.total).toBe(2);
    expect((await t.api("POST", `/api/undo/${del.json.undoToken}`)).status).toBe(409);
  });

  it("parti silme işlerini de götürür; geri alma yalnızca o işlemde silinenleri getirir", async () => {
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Marco" },
    ]);
    const single = await t.api("DELETE", `/api/jobs/${commit.jobIds[0]}`);
    const batch = await t.api("DELETE", `/api/batches/${commit.batchId}`);
    expect(batch.json.label).toMatch(/1 işi/);
    expect((await t.api("GET", "/api/batches")).json.batches).toHaveLength(0);
    await t.api("POST", `/api/undo/${batch.json.undoToken}`);
    expect((await t.api("GET", "/api/jobs")).json.jobs.map((j: JobSummary) => j.text)).toEqual(["Marco"]);
    await t.api("POST", `/api/undo/${single.json.undoToken}`);
    expect((await t.api("GET", "/api/jobs")).json.total).toBe(2);
  });

  it("varyasyon silme onayı kaldırır, geri alma onayı geri getirir; 30 gün sonra kalıcı temizlik", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }], { generate: true });
    await t.ctx.queue.idle();
    const job = (await t.api("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
    const vid = job.variants[0].id;
    await t.api("POST", `/api/jobs/${job.id}/approve`, { variantId: vid });
    const del = await t.api("DELETE", `/api/variants/${vid}`);
    let after = (await t.api("GET", `/api/jobs/${job.id}`)).json;
    expect(after).toMatchObject({ approvedVariantId: null, status: "new", variants: [] });
    await t.api("POST", `/api/undo/${del.json.undoToken}`);
    after = (await t.api("GET", `/api/jobs/${job.id}`)).json;
    expect(after).toMatchObject({ approvedVariantId: vid, status: "approved" });

    const preview = inOrg(t, () => t.ctx.variants.previewPath(t.ctx.variants.row(vid)!))!;
    expect(existsSync(preview)).toBe(true);
    const del2 = await t.api("DELETE", `/api/jobs/${job.id}`);
    t.clock.advance(31 * DAY_MS);
    const purged = await inOrg(t, () => t.ctx.undo.purge());
    expect(purged).toMatchObject({ jobs: 1, variants: 1 });
    expect(existsSync(preview)).toBe(false);
    expect((await t.api("POST", `/api/undo/${del2.json.undoToken}`)).status).toBe(404);
  });

  it("süresi dolan geri alma 410", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    const del = await t.api("DELETE", `/api/jobs/${commit.jobIds[0]}`);
    t.clock.advance(30 * DAY_MS + 1000);
    expect((await t.api("POST", `/api/undo/${del.json.undoToken}`)).status).toBe(410);
  });
});

describe("en iyiyi onayla", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await seedLanguage(t);
  });
  afterEach(() => t.close());

  const addVariant = async (jobId: string, o: { score: number; aiRank: number | null; suspect: boolean; text?: string }) => {
    const preview = await png();
    return inOrg(t, () => t.ctx.variants.create({
      jobId,
      kind: "text",
      intent: { lines: [{ text: "Anna", role: "name", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "" },
      layout: fakeLayout({ lines: [{ text: "Anna", role: "name", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "" }, o.score),
      snapshot: { languageId: "deneme", profileVersion: 1, templateKey: "a1", labelSize: null, text: o.text ?? "Anna", model: null, promptVersion: null, costUsd: null, revision: null },
      preview,
      score: o.score,
      aiRank: o.aiRank,
      suspect: o.suspect,
      issues: [],
      rationale: "",
    }));
  };

  it("AI'ın ilk tercihi önce, sonra puan; kontrol işaretli ve eski varyasyon seçilmez", async () => {
    const { commit } = await importJobs(t, [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Anna" },
      { siparis: "3", etiket: "a1", adet: 1, text: "Anna" },
    ]);
    const [j1, j2, j3] = commit.jobIds;
    await addVariant(j1, { score: 95, aiRank: 2, suspect: false });
    const best1 = await addVariant(j1, { score: 80, aiRank: 1, suspect: false });
    await addVariant(j1, { score: 99, aiRank: 1, suspect: true });
    await addVariant(j2, { score: 99, aiRank: 1, suspect: true });
    await addVariant(j2, { score: 99, aiRank: 1, suspect: false, text: "Eski metin" });
    const r = await t.api("POST", "/api/jobs/approve-best", { ids: [j1, j2, j3] });
    expect(r.json.approved).toEqual([{ jobId: j1, variantId: best1 }]);
    expect(r.json.skipped.map((s: Skipped) => s.id)).toEqual([j2, j3]);
    expect((await t.api("GET", `/api/jobs/${j1}`)).json.status).toBe("approved");
    // Kontrol işareti elle kaldırılınca seçilebilir.
    const v = (await t.api("GET", `/api/jobs/${j2}`)).json.variants[0];
    await t.api("PATCH", `/api/variants/${v.id}`, { suspect: false });
    expect((await t.api("POST", "/api/jobs/approve-best", { ids: [j2] })).json.approved).toHaveLength(1);
  });

  it("onaylı işin metni değişirse onay kalkar ve varyasyon eski işaretlenir", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna" }]);
    const vid = await addVariant(commit.jobIds[0], { score: 90, aiRank: null, suspect: false });
    await t.api("POST", `/api/jobs/${commit.jobIds[0]}/approve`, { variantId: vid });
    const r = await t.api("PATCH", `/api/jobs/${commit.jobIds[0]}`, { text: "Anna B" });
    expect(r.json).toMatchObject({ approvedVariantId: null, status: "ready" });
    expect(r.json.variants[0].stale).toBe(true);
  });
});
