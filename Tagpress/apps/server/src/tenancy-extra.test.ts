import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProfileSchema, defaultProfile } from "@tagpress/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDesigner } from "./adapters/ai.ts";
import { FontRegistryCache } from "./adapters/fonts.ts";
import { FairScheduler, pickFair } from "./services/generation/fair.ts";
import { maybeOrg, runInOrg } from "./org/context.ts";
import type { DataPaths } from "./config.ts";
import { makeApp, png } from "./test/helpers.ts";
import { LocalOrgResolver } from "./org/resolver.ts";
import { type SeedA, type SeedB, type TwoOrgs, b64, makeTwoOrgs, orgRoot, seedA, seedB } from "./test/two-orgs.ts";
import { isUuidv7 } from "./util/ids.ts";

/**
 * A4 izolasyon takımının ek denemeleri (ikinci inceleme, saldırgan gözüyle): süreç geneli bağdaştırıcı önbellekleri,
 * dosya yollarında ters yön (düzen 1'de B'nin kökü A'nın kökünün içinde), kurulum düzeyi yedekler ve kaynak payı.
 * Uç uca HTTP denemeleri `tenancy.test.ts`'te; burada uçların arkasındaki paylaşılan durum.
 */

const FONTS = path.resolve(import.meta.dirname, "../../../packages/typeset/test-fonts");
const GV = { id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script" as const, roles: ["primary" as const], file: "GreatVibes-Regular.ttf" };

describe("süreç geneli önbellekler firma ayırır", () => {
  it("tasarımcı: A'nın tasarım çağrısının benzer örnekleri B'nin (aynı metinli) aday seçimine girmez; A'nınkine girer", async () => {
    const seen: string[] = [];
    const claude = {
      model: "sahte",
      async callJson(req: unknown) {
        seen.push(JSON.stringify(req));
        throw new Error("sahte claude");
      },
    };
    const TEXT = "Ayse ve Mehmet 12.10.2026";
    const designer = createDesigner({
      apiKey: () => "x",
      claude: () => claude as never,
      fonts: new FontRegistryCache("yok"),
      engine: {} as never,
      breakExamples: (lang: string) =>
        lang === "dil-a" ? [{ text: "Alfagizli Fatma ve Ali 01.05.2025", lines: ["Alfagizli Fatma ve Ali", "01.05.2025"], templateKey: "a1", referenceId: "ref-alfa" }] : [],
    } as never);
    const profile = defaultProfile();
    const geometry = { key: "a1", imagePath: null, areaBounds: { x: 0, y: 0, w: 100, h: 50 }, background: { dark: false }, rows: [], framePx: 440 } as never;
    const design = (org: string, jobId: string) =>
      runInOrg(org, () =>
        designer
          .design({ jobId, text: TEXT, segments: [], aiNote: "", kind: "label", profile, profileVersion: 1, template: null, sticker: null, geometry, previous: [], revision: null, candidates: 2, log: () => undefined, languageId: "dil-a" } as never)
          .catch(() => undefined),
      );
    const prev = await png(20, 20);
    const pick = (org: string, jobId: string) =>
      runInOrg(org, () =>
        designer
          .pick({ jobId, text: TEXT, profile, candidates: [0, 1].map(() => ({ intent: { lines: [{ text: TEXT }] }, layout: {}, preview: prev })), log: () => undefined } as never)
          .catch(() => undefined),
      );
    await design("org-a", "is-a");
    let n = seen.length;
    await pick("org-b", "is-b");
    expect(seen.slice(n).join("\n"), "B'nin isteğinde A'nın örneği").not.toContain("Alfagizli");
    // Aynı firma, başka iş: o işin tasarım çağrısı olmadıkça örnek taşınmaz.
    n = seen.length;
    await pick("org-a", "baska-is");
    expect(seen.slice(n).join("\n")).not.toContain("Alfagizli");
    // Aynı işin aday seçimi kendi tasarım çağrısının örneklerini kullanmaya devam eder.
    n = seen.length;
    await pick("org-a", "is-a");
    expect(seen.slice(n).join("\n")).toContain("Alfagizli");
  });

  describe("font kayıtları", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "font-firma-"));
      for (const o of ["a", "b"]) mkdirSync(path.join(dir, o, "fontlar"), { recursive: true });
      mkdirSync(path.join(dir, "ortak"), { recursive: true });
      copyFileSync(path.join(FONTS, GV.file), path.join(dir, "a", "fontlar", GV.file));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("B, A'nın kullandığı kayıtları (findWith, resolveFace) bulamaz; A bulur", () => {
      const cache = new FontRegistryCache(path.join(dir, "ortak"), () => [path.join(dir, maybeOrg()?.orgId ?? "x", "fontlar")]);
      const profile = ProfileSchema.parse({ ...defaultProfile(), fonts: { list: [GV] } });
      runInOrg("a", () => cache.forProfile(path.join(dir, "a", "fontlar"), profile));
      expect(runInOrg("a", () => cache.findWith([GV.id]))).not.toBeNull();
      expect(runInOrg("a", () => cache.resolveFace("Great Vibes", "Regular"))).not.toBeNull();
      expect(runInOrg("b", () => cache.findWith([GV.id]))).toBeNull();
      expect(runInOrg("b", () => cache.resolveFace("Great Vibes", "Regular"))).toBeNull();
      expect(cache.findWith([GV.id]), "bağlamsız çağrı firmalı kaydı görmez").toBeNull();
    });
  });
});

describe("kaynak payı (kurulumun eşzamanlılık yuvaları)", () => {
  /** Elle bitirilen işler. */
  const blocking = () => {
    const open: { org: string; finish: () => void }[] = [];
    const job = (org: string) => () => new Promise<void>((r) => open.push({ org, finish: r }));
    return { open, job };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("çok firmalı kurulumda tek başına çalışan firma bir yuvayı boş bırakır: sonradan gelen firma beklemeden başlar", async () => {
    const s = new FairScheduler({ maxTotal: () => 4, maxPerOrg: () => 8, orgCount: () => 2 });
    const { open, job } = blocking();
    for (let i = 0; i < 6; i++) void s.submit("a", job("a"));
    await tick();
    expect(s.runningOf("a")).toBe(3);
    void s.submit("b", job("b"));
    await tick();
    expect([s.runningOf("a"), s.runningOf("b")]).toEqual([3, 1]);
    // İkisi de bekliyorken pay ceil(4/2): A'nın işi bitince boşalan yuva B'ye gider.
    void s.submit("b", job("b"));
    open.find((o) => o.org === "a")!.finish();
    await tick();
    await tick();
    expect([s.runningOf("a"), s.runningOf("b")]).toEqual([2, 2]);
    for (let i = 0; i < 10; i++) {
      for (const o of open.splice(0)) o.finish();
      await tick();
    }
    await s.idle();
  });

  it("tek firmalı kurulumda davranış aynı: bütün yuvalar kullanılır", async () => {
    const s = new FairScheduler({ maxTotal: () => 4, maxPerOrg: () => 8, orgCount: () => 1 });
    const { open, job } = blocking();
    for (let i = 0; i < 6; i++) void s.submit("a", job("a"));
    await tick();
    expect(s.runningOf("a")).toBe(4);
    for (let i = 0; i < 6; i++) {
      for (const o of open.splice(0)) o.finish();
      await tick();
    }
    await s.idle();
  });

  it("pickFair: rakip bekleyen yokken ayrılan yuva; rakip varken en az çalışan", () => {
    const a = { orgId: "a", oldest: 1 };
    const b = { orgId: "b", oldest: 2 };
    expect(pickFair([a], () => 3, () => 8, { total: 4, reserve: true })).toBeNull();
    expect(pickFair([a], () => 3, () => 8, { total: 4, reserve: false })?.orgId).toBe("a");
    expect(pickFair([a], () => 0, () => 8, { total: 1, reserve: true })?.orgId).toBe("a"); // tek yuvada ayırma yok
    expect(pickFair([a, b], (o) => (o === "a" ? 2 : 1), () => 8, { total: 4, reserve: true })?.orgId).toBe("b");
  });

  it("öğrenme koşuları firma başına 1", () => {
    const src = readFileSync(path.join(import.meta.dirname, "services/learn.ts"), "utf8");
    expect(src).toMatch(/maxPerOrg: \(\) => 1\b/);
  });
});

describe("iki firmalı uygulama (düzen 1: B'nin kökü A'nın kökünün içinde)", () => {
  const log = { routes: new WeakMap<object, { method: string; url: string }[]>(), hits: [] as { key: string; org: string | null }[] };
  let env: TwoOrgs;
  let A: SeedA;
  let B: SeedB;
  beforeAll(async () => {
    env = await makeTwoOrgs(log, { layout: 1 });
    A = await seedA(env);
    B = await seedB(env);
    await env.settle();
  }, 90_000);
  afterAll(async () => {
    await env?.settle();
    await env?.t.close();
  });

  it("dil kimliği: istenen kimlik başka firmada dolu da boş da olsa yanıt yeni UUIDv7 (varlık ele verilmez)", async () => {
    const taken = await env.asB("POST", "/api/languages", { name: "x1", id: A.lang });
    const free = await env.asB("POST", "/api/languages", { name: "x2", id: "boyle-bir-dil-yok" });
    expect([taken.status, free.status]).toEqual([200, 200]);
    expect([isUuidv7(taken.json.id), isUuidv7(free.json.id)]).toEqual([true, true]);
    for (const r of [taken, free]) await env.asB("DELETE", `/api/languages/${r.json.id}`);
  });

  it("şablon yedeği firmanın kökünde (B: firmalar/<b>/yedek/sablonlar); sahibin eski kökünde yol aynı (data/yedek/sablonlar)", async () => {
    const r = await env.asB("POST", `/api/languages/${B.lang}/templates`, { key: "a1", fileName: "a1.png", png: b64(await png(43, 43, { r: 5, g: 5, b: 5, alpha: 1 })) });
    expect(r.status, r.body).toBe(200);
    expect(existsSync(path.join(env.t.dir, "yedek", "sablonlar", B.lang))).toBe(false);
    expect(readdirSync(path.join(orgRoot(env.t, env.b), "yedek", "sablonlar", B.lang)).length).toBeGreaterThan(0);
    expect(runInOrg(env.a, () => env.t.ctx.paths.templateBackups(A.lang))).toBe(path.join(env.t.dir, "yedek", "sablonlar", A.lang));
  });

  it("ters yön: A'nın yolları firmalar/ altına inemez (kimlik bölümü tek klasör adı olmalı)", async () => {
    const bTpl = path.relative(env.t.dir, path.join(orgRoot(env.t, env.b), "diller", B.lang));
    for (const id of [bTpl, `../firmalar/${env.b}`, "..", "a/b", "a\b", ".gizli"]) {
      for (const get of [(p: DataPaths) => p.language(id), (p: DataPaths) => p.templates(id), (p: DataPaths) => p.fonts(id), (p: DataPaths) => p.references(id), (p: DataPaths) => p.templateBackups(id)]) {
        expect(() => runInOrg(env.a, () => get(env.t.ctx.paths)), id).toThrow();
      }
    }
    // Uçtan: A, B'nin şablon görselini kendi kökü üzerinden isteyemez.
    for (const lang of [encodeURIComponent(bTpl), encodeURIComponent(`../firmalar/${env.b}/diller/${B.lang}`)]) {
      const res = await env.asA("GET", `/api/languages/${lang}/templates/a1/image.png`);
      expect(res.status, lang).toBe(404);
    }
  });

  it("kaynak payı uçtan: A eşzamanlılığı 8 ve 6 iş; A'nın işleri sürerken B'nin işi beklemeden başlar", async () => {
    expect((await env.asA("PATCH", "/api/settings", { concurrency: 8 })).status).toBe(200);
    const recs = Array.from({ length: 6 }, (_, i) => ({ siparis: `ALFA-Y${i}`, etiket: "a1", adet: 1, text: `Alfagizli Yuk ${i}` }));
    const prev = await env.asA("POST", "/api/import/preview", { fileName: "y.json", content: JSON.stringify(recs), languageId: A.lang });
    const commit = await env.asA("POST", "/api/import/commit", { fileName: "y.json", mapping: prev.json.mapping, rows: prev.json.rows, languageId: A.lang, batchName: "yuk" });
    const aJobs: string[] = commit.json.jobIds;
    const blk = env.blockQueue();
    try {
      await env.asA("POST", "/api/generate", { jobIds: aJobs });
      await new Promise((r) => setTimeout(r, 50));
      expect(blk.started.filter((j) => aJobs.includes(j))).toHaveLength(3); // 4 yuvanın biri boş kalır
      await env.asB("POST", "/api/generate", { jobIds: [B.job] });
      await new Promise((r) => setTimeout(r, 50));
      expect(blk.started).toContain(B.job);
    } finally {
      await blk.release();
      await env.asA("PATCH", "/api/settings", { concurrency: 1 });
    }
  });
});

describe("firma kimliği biçimi", () => {
  it("büyük harfli UUID küçük harfe çevrilir (aynı firmanın kopyası açılamaz); UUID olmayan kimlik reddedilir; çözücü de çevirir", async () => {
    const t = await makeApp();
    try {
      const a = t.ctx.orgs.defaultOrgId()!;
      expect(isUuidv7(a)).toBe(true);
      expect(() => t.ctx.orgs.create({ name: "KOPYA", id: a.toUpperCase() }, { seed: false })).toThrow();
      expect(t.ctx.orgs.list()).toHaveLength(1);
      expect(() => t.ctx.orgs.create({ name: "X", id: "kopya-firma" }, { seed: false })).toThrow(/UUID/);
      const up = "0197A000-0000-7000-8000-00000000ABCD";
      expect(t.ctx.orgs.create({ name: "Y", id: up }, { seed: false }).id).toBe(up.toLowerCase());
      expect(runInOrg(up, () => maybeOrg()?.orgId)).toBe(up.toLowerCase());
      expect(new LocalOrgResolver(t.ctx.orgs, up).orgId).toBe(up.toLowerCase());
    } finally {
      await t.close();
    }
  });
});
