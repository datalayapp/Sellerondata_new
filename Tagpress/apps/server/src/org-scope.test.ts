import type { ServerEvent } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentOrg, localOrg, runInOrg } from "./org/context.ts";
import type { OrgResolver } from "./org/resolver.ts";
import type { GenTask } from "./services/generation/queue.ts";
import type { PrintPlanner } from "./services/print/ports.ts";
import { pickFair } from "./services/generation/fair.ts";
import { type TestApp, fullPorts, importJobs, makeApp, png, seedLanguage } from "./test/helpers.ts";

/**
 * A2 servis kapsamı: iki firmalı kurulumda iş, parti, varyasyon, baskı oturumu, şablon görevi başka firmadan görünmez;
 * mükerrer denetimi firmalar arasında eşleşmez; üretim kuyruğu adil seçer ve her görev kendi firmasında koşar; olaylar
 * yalnız kendi firmasına gider.
 */

const headerResolver = (fallback: () => string): OrgResolver => ({
  resolve: (req) => localOrg(String(req.headers["x-test-org"] ?? fallback())),
});

let t: TestApp;
let a: string;
let b: string;
let langA: string;
let langB: string;

const asB = (method: Parameters<TestApp["api"]>[0], url: string, body?: unknown) => t.api(method, url, body, { "x-test-org": b });
const asA = (method: Parameters<TestApp["api"]>[0], url: string, body?: unknown) => t.api(method, url, body, { "x-test-org": a });

/** Bakım kapsamında ham satır (testin kendi denetimi; firma kapsamı yok). */
const rawGet = (sql: string, ...p: string[]) => t.raw.get(sql, ...p) as Record<string, unknown> | undefined;

async function importAs(org: string, records: unknown[], lang: string) {
  const headers = { "x-test-org": org };
  const prev = await t.api("POST", "/api/import/preview", { fileName: "siparis.json", content: JSON.stringify(records), languageId: lang }, headers);
  expect(prev.status).toBe(200);
  const commit = await t.api("POST", "/api/import/commit", { fileName: "siparis.json", mapping: prev.json.mapping, rows: prev.json.rows, languageId: lang }, headers);
  expect(commit.status).toBe(200);
  return { preview: prev.json, commit: commit.json };
}

const prevEnv = process.env.TAGPRESS_MAX_CONCURRENCY;

/** En basit planlayıcı: sipariş başına adet kadar öğe, şablon yuvalarına sırayla. */
const planner: PrintPlanner = {
  planLabelPages: ({ orders, template }) => [
    {
      name: "sayfa",
      kind: "mixed",
      copies: 1,
      items: orders.flatMap((o) => Array.from({ length: o.quantity }, (_, i) => ({ jobId: o.jobId, variantId: o.variantId, slotId: template.slots[i]!.id, xMm: template.slots[i]!.cx, yMm: template.slots[i]!.cy, extra: false }))),
      cellLabels: [],
    },
  ],
  planStickerPages: () => [],
};

beforeEach(async () => {
  t = await makeApp({ ports: fullPorts({ printPlanner: planner }), startQueue: true, resolver: headerResolver(() => t!.ctx.orgs.defaultOrgId()!) });
  a = t.ctx.orgs.defaultOrgId()!;
  b = t.ctx.orgs.create({ name: "B" }).id;
  langA = await runInOrg(a, () => seedLanguage(t));
  langB = await runInOrg(b, () => seedLanguage(t));
});
afterEach(async () => {
  if (prevEnv === undefined) delete process.env.TAGPRESS_MAX_CONCURRENCY;
  else process.env.TAGPRESS_MAX_CONCURRENCY = prevEnv;
  await t.close();
});

describe("firma kapsamı: kimlikle okuma ve listeler", () => {
  it("A'nın işi, partisi, varyasyonu B bağlamında 404 ve B'nin listelerinde yok", async () => {
    const { commit } = await importJobs(t, [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    expect((await asA("POST", "/api/generate", { jobIds: commit.jobIds })).status).toBe(200);
    await t.ctx.queue.idle();
    const job = (await asA("GET", `/api/jobs/${commit.jobIds[0]}`)).json;
    const variantId = job.variants[0].id as string;
    expect(variantId).toBeTruthy();

    expect((await asB("GET", `/api/jobs/${job.id}`)).status).toBe(404);
    expect((await asB("GET", `/api/variants/${variantId}`)).status).toBe(404);
    expect((await asB("GET", `/api/variants/${variantId}/preview.png`)).status).toBe(404);
    expect((await asB("PATCH", `/api/batches/${commit.batchId}`, { name: "Ele geçir" })).status).toBe(404);
    expect((await asB("GET", "/api/jobs")).json.jobs).toEqual([]);
    expect((await asB("GET", "/api/batches")).json.batches).toEqual([]);
    // B, A'nın işini üretime alamaz (görev açılmaz) ve onaylayamaz.
    const gen = (await asB("POST", "/api/generate", { jobIds: [job.id] })).json;
    expect(gen.queued).toEqual([]);
    expect(gen.skipped.map((s: { id: string }) => s.id)).toEqual([job.id]);
    expect(runInOrg(b, () => t.ctx.queue.enqueue([{ jobId: job.id, mode: "text" }])).queued).toEqual([]);
    expect((await asB("POST", "/api/jobs/approve-best", { ids: [job.id] })).json.approved).toEqual([]);
    // B'nin kendi bağlamında doğrudan çağrılar da A'nın satırına ulaşmaz.
    expect(runInOrg(b, () => t.ctx.jobs.row(job.id))).toBeNull();
    expect(runInOrg(b, () => t.ctx.variants.row(variantId, true))).toBeNull();
    await expect(runInOrg(b, () => t.ctx.variants.create({ ...variantInput(job.id) }))).rejects.toMatchObject({ code: "job-not-found" });
    expect(() => runInOrg(b, () => t.ctx.jobs.createMany(commit.batchId, []))).toThrow(expect.objectContaining({ code: "batch-not-found" }));
    expect(() => runInOrg(b, () => t.ctx.batches.create({ languageId: langA, name: "x", sourceFile: null, mapping: null }))).toThrow(
      expect.objectContaining({ code: "language-not-found" }),
    );
    // A için hepsi yerinde.
    expect((await asA("GET", "/api/jobs")).json.jobs).toHaveLength(1);
    expect((await asA("GET", `/api/variants/${variantId}`)).status).toBe(200);
  });

  it("baskı oturumu: A'nın oturumu B'de 404; B, A'nın işini kendi oturumuna ekleyemez", async () => {
    const { commit } = await importJobs(t, [{ siparis: "4849", etiket: "a1", adet: 1, text: "Anna Marco" }]);
    await asA("POST", "/api/generate", { jobIds: commit.jobIds });
    await t.ctx.queue.idle();
    expect((await asA("POST", "/api/jobs/approve-best", { ids: commit.jobIds })).json.approved).toHaveLength(1);
    const grid = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true, sizeId: "3.8" };
    const g = await asA("POST", "/api/print/templates/grid", { languageId: langA, ...grid });
    expect(g.status, g.body).toBe(200);
    const tplA = g.json.template;
    const sA = (await asA("POST", "/api/print/sessions", { languageId: langA, templateId: tplA.id, jobIds: commit.jobIds })).json.session;
    expect(sA.id).toBeTruthy();

    expect((await asB("GET", `/api/print/sessions/${sA.id}`)).status).toBe(404);
    expect((await asB("GET", `/api/print/sessions?languageId=${langB}`)).json.sessions ?? []).toEqual([]);
    expect((await asB("GET", `/api/print/shelf?languageId=${langA}`)).json.items ?? []).toEqual([]);
    // B'nin dili ve şablonuyla oturum; A'nın işi atlanır.
    const tplB = (await asB("POST", "/api/print/templates/grid", { languageId: langB, ...grid })).json.template;
    const r = await asB("POST", "/api/print/sessions", { languageId: langB, templateId: tplB.id, jobIds: commit.jobIds });
    // A'nın işi B'de "bulunamadı" sayılır: eşleşen onaylı iş kalmaz.
    expect(r.json.code).toBe("session-no-matching-jobs");
    // B, A'nın şablonuyla oturum açamaz.
    expect((await asB("POST", "/api/print/sessions", { languageId: langB, templateId: tplA.id })).status).toBe(404);
  });

  it("şablon görevi kendi firmasında koşar; başka firmadan 404", async () => {
    const r = await asB("POST", `/api/languages/${langB}/templates/generate`, { theme: "deniz", key: "b-deniz" });
    expect(r.status).toBe(200);
    await t.ctx.templateTasks.idle();
    expect((await asB("GET", `/api/template-tasks/${r.json.id}`)).json.status).toBe("done");
    expect((await asA("GET", `/api/template-tasks/${r.json.id}`)).status).toBe(404);
    expect(rawGet("SELECT org_id FROM template_tasks WHERE id = ?", r.json.id)?.org_id).toBe(b);
    expect(rawGet("SELECT org_id FROM templates WHERE key = ?", "b-deniz")?.org_id).toBe(b);
    // A, B'nin diline görev açamaz.
    expect((await asA("POST", `/api/languages/${langB}/templates/generate`, { theme: "x" })).status).toBe(404);
  });
});

describe("mükerrer denetimi firma kapsamında", () => {
  it("B'deki aynı sipariş A'nın işini 'zaten içe aktarıldı' diye göstermez; aynı firmada gösterir", async () => {
    const rec = [{ siparis: "777", etiket: "a1", adet: 1, text: "Anna Marco" }];
    await importAs(a, rec, langA);
    const again = await importAs(a, rec, langA);
    expect(again.preview.rows[0].issues.map((i: { code: string }) => i.code)).toContain("duplicate-existing");
    const inB = await importAs(b, rec, langB);
    const codes = inB.preview.rows[0].issues.map((i: { code: string }) => i.code);
    expect(codes).not.toContain("duplicate-existing");
    expect(codes.filter((c: string) => c.startsWith("duplicate-similar"))).toEqual([]);
    // Doğrudan doğrulayıcı: B bağlamında A'nın anahtarı eşleşmez.
    const key = again.preview.rows[0].dedupeKey as string;
    expect(runInOrg(b, () => t.ctx.validator.existing(langA, [key]))).toEqual([]);
    expect(runInOrg(a, () => t.ctx.validator.existing(langA, [key])).length).toBeGreaterThan(0);
  });
});

describe("üretim kuyruğu: adil seçim ve görev bağlamı", () => {
  it("pickFair: en az çalışan firma, eşitse en eski; sınırı dolan firma atlanır", () => {
    const c = [
      { orgId: "a", oldest: "2026-01-01" },
      { orgId: "b", oldest: "2026-01-02" },
    ];
    expect(pickFair(c, () => 0, () => 2)?.orgId).toBe("a");
    expect(pickFair(c, (o) => (o === "a" ? 1 : 0), () => 2)?.orgId).toBe("b");
    expect(pickFair(c, (o) => (o === "a" ? 2 : 1), () => 2)?.orgId).toBe("b");
    expect(pickFair(c, () => 2, () => 2)).toBeNull();
  });

  it("iki firmada bekleyen iş varken sıra firmalar arasında dönüşümlü; her görev kendi firmasında yazar; durum firmaya göre", async () => {
    process.env.TAGPRESS_MAX_CONCURRENCY = "2";
    const ja = (await importAs(a, [1, 2, 3].map((n) => ({ siparis: `a${n}`, etiket: "a1", adet: 1, text: `Anna ${n}` })), langA)).commit.jobIds as string[];
    const jb = (await importAs(b, [1, 2].map((n) => ({ siparis: `b${n}`, etiket: "a1", adet: 1, text: `Bora ${n}` })), langB)).commit.jobIds as string[];

    const started: { jobId: string; org: string; taskOrg: string }[] = [];
    const release = new Map<string, () => void>();
    t.ctx.queue.setRunner(async (task: GenTask) => {
      started.push({ jobId: task.jobId, org: currentOrg().orgId, taskOrg: task.orgId });
      // Görevin içinden yazılan satır görevin firmasında.
      t.ctx.progress.push(task.jobId, task.id, "deneme", "görev içi");
      await new Promise<void>((r) => release.set(task.jobId, r));
    });
    const seen: { a: ServerEvent[]; b: ServerEvent[] } = { a: [], b: [] };
    const offA = t.ctx.events.subscribe((e) => seen.a.push(e), { orgId: a });
    const offB = t.ctx.events.subscribe((e) => seen.b.push(e), { orgId: b });

    // İki firma aynı anda sıraya alır (seçim mikro görevde, ikisinden sonra).
    runInOrg(a, () => t.ctx.queue.enqueue(ja.map((jobId) => ({ jobId, mode: "text" as const }))));
    runInOrg(b, () => t.ctx.queue.enqueue(jb.map((jobId) => ({ jobId, mode: "text" as const }))));
    const tick = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    await tick();
    expect(started.map((s) => s.jobId)).toEqual([ja[0], jb[0]]);
    // Durum firmaya göre: A'da 1 çalışan + 2 bekleyen, B'de 1 + 1.
    expect(runInOrg(a, () => t.ctx.queue.status())).toMatchObject({ running: 1, queued: 2, runningJobIds: [ja[0]], concurrency: 2 });
    expect(runInOrg(b, () => t.ctx.queue.status())).toMatchObject({ running: 1, queued: 1, runningJobIds: [jb[0]] });

    release.get(ja[0]!)!();
    await tick();
    release.get(jb[0]!)!();
    await tick();
    release.get(ja[1]!)!();
    await tick();
    // FIFO olsaydı a1,a2,a3,b1,b2; adil sıra: a1,b1,a2,b2,a3.
    expect(started.map((s) => s.jobId)).toEqual([ja[0], jb[0], ja[1], jb[1], ja[2]]);
    for (const id of release.keys()) release.get(id)!();
    await t.ctx.queue.idle();

    for (const s of started) expect(s.org).toBe(s.taskOrg);
    expect(started.filter((s) => s.org === a).map((s) => s.jobId)).toEqual([ja[0], ja[1], ja[2]]);
    for (const id of ja) expect(rawGet("SELECT org_id FROM job_log WHERE job_id = ? AND step = 'deneme'", id)?.org_id).toBe(a);
    for (const id of jb) expect(rawGet("SELECT org_id FROM job_log WHERE job_id = ? AND step = 'deneme'", id)?.org_id).toBe(b);
    for (const id of [...ja, ...jb]) expect(rawGet("SELECT org_id FROM gen_tasks WHERE job_id = ?", id)?.org_id).toBe(ja.includes(id) ? a : b);

    // Olaylar: B, A'nın job/queue/progress olayını görmez (ve tersi).
    const jobIdsOf = (es: ServerEvent[]) => new Set(es.flatMap((e) => (e.type === "job" || e.type === "progress" ? [e.type === "job" ? e.jobId : e.step.jobId] : [])));
    expect([...jobIdsOf(seen.b)].every((id) => jb.includes(id))).toBe(true);
    expect([...jobIdsOf(seen.a)].every((id) => ja.includes(id))).toBe(true);
    const queueB = seen.b.filter((e) => e.type === "queue");
    expect(queueB.length).toBeGreaterThan(0);
    for (const e of queueB) if (e.type === "queue") expect(e.status.runningJobIds.every((id) => jb.includes(id))).toBe(true);
    offA();
    offB();
  });

  it("firma sınırı: kurulum sınırı boşken bile firma kendi eşzamanlılığını aşmaz", async () => {
    process.env.TAGPRESS_MAX_CONCURRENCY = "4";
    expect((await asA("PATCH", "/api/settings", { concurrency: 1 })).status).toBe(200);
    const ja = (await importAs(a, [1, 2].map((n) => ({ siparis: `s${n}`, etiket: "a1", adet: 1, text: `Anna ${n}` })), langA)).commit.jobIds as string[];
    const jb = (await importAs(b, [1, 2].map((n) => ({ siparis: `s${n}`, etiket: "a1", adet: 1, text: `Bora ${n}` })), langB)).commit.jobIds as string[];
    const started: string[] = [];
    const release: Array<() => void> = [];
    t.ctx.queue.setRunner(async (task) => {
      started.push(task.jobId);
      await new Promise<void>((r) => release.push(r));
    });
    runInOrg(a, () => t.ctx.queue.enqueue(ja.map((jobId) => ({ jobId, mode: "text" as const }))));
    runInOrg(b, () => t.ctx.queue.enqueue(jb.map((jobId) => ({ jobId, mode: "text" as const }))));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // A en çok 1 (kendi ayarı), B en çok 2 (varsayılan).
    expect(started).toEqual([ja[0], jb[0], jb[1]]);
    expect(runInOrg(a, () => t.ctx.queue.status()).concurrency).toBe(1);
    while (release.length) {
      release.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    await t.ctx.queue.idle();
    expect(started).toHaveLength(4);
  });
});

function variantInput(jobId: string) {
  return {
    jobId,
    kind: "text" as const,
    intent: null,
    layout: null,
    snapshot: { languageId: "x", profileVersion: 1, templateKey: "a1", labelSize: null, text: "x", model: null, promptVersion: null, costUsd: null, revision: null },
    preview: Buffer.from(""),
    score: null,
    aiRank: null,
    suspect: false,
    issues: [],
    rationale: "",
  };
}

void png;
