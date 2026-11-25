import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ROUTE_FEATURES } from "./features/route-map.ts";
import { runInOrg } from "./org/context.ts";
import { TEST_PROFILE, png } from "./test/helpers.ts";
import {
  Harness,
  ORG_HEADER,
  type ProbeOptions,
  type SeedA,
  type SeedB,
  type TwoOrgs,
  WEB_INDEX,
  b64,
  fakeFont,
  makeTwoOrgs,
  orgRoot,
  seedA,
  seedB,
  snapshotOrg,
} from "./test/two-orgs.ts";

/**
 * A4 — iki firmalı izolasyon takımı (SUNUCU-PLANI §2.5, §2.6). Fastify'a kaydedilen BÜTÜN uçlar programla okunur
 * (`onRoute`); her (yöntem, yol) ya aşağıdaki `PROBES` tablosunda denenir ya da `EXEMPT` listesinde gerekçesiyle
 * durur. Yeni uç eklenince ya da tablodaki uç kalkınca kapsam testi kırılır.
 *
 * Her denemede: B'nin bağlamında A'nın kimlikleriyle istek → "bulunamadı" (ya da uç sözleşmesindeki "atlandı");
 * B'nin yanıtında A'nın hiçbir kimliği/işareti ya da A'ya özgü dosya baytı yok (B'nin kendi gönderdikleri hariç);
 * denemenin önünde ve ardında A'nın bütün kiracı satırları, firma satırı, kurulum ayarları, dosya ağacı ve kuyruk
 * durumu aynı. Fastify'ın GET'ler için kendiliğinden açtığı HEAD kopyası GET denemesiyle birlikte denenir.
 *
 * Kip: varsayılan sıkı; `TAGPRESS_TENANCY=audit` ile de yeşil olmalı (denetim kipinde ayrıca hiçbir kapsam dışı erişim
 * sayılmamalı).
 */

// ---------------------------------------------------------------- rota kaydı (Fastify sarmalayıcısı)

const log = vi.hoisted(() => ({
  routes: new WeakMap<object, { method: string; url: string }[]>(),
  hits: [] as { key: string; org: string | null }[],
}));

vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const real = mod.default as unknown as (...args: unknown[]) => FastifyInstance;
  const wrapped = (...args: unknown[]) => {
    const app = real(...args);
    const list: { method: string; url: string }[] = [];
    log.routes.set(app, list);
    app.addHook("onRoute", (r: { method: string | string[]; url: string }) => {
      for (const m of [r.method].flat()) list.push({ method: m, url: r.url });
    });
    app.addHook("onRequest", (req: { method: string; routeOptions?: { url?: string }; headers: Record<string, unknown> }, _reply: unknown, done: () => void) => {
      const url = req.routeOptions?.url;
      // Başlık adı `ORG_HEADER` ile aynı (sarmalayıcı içe aktarmalardan önce kurulur, sabiti burada kullanamaz).
      if (url) log.hits.push({ key: `${req.method} ${url}`, org: (req.headers["x-test-org"] as string | undefined) ?? null });
      done();
    });
    return app;
  };
  return { ...mod, default: wrapped };
});

// ---------------------------------------------------------------- kurulum

// Takım iki dosya düzeninde koşar (`describe` başına bir kurulum); denemeler o anki kuruluma bakar.
let env: TwoOrgs;
let A: SeedA;
let B: SeedB;

const GRID = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true, sizeId: "3.8" };
const enc = encodeURIComponent;
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/**
 * `fromDir`'den A'nın dosyasına (`rel`: A'nın köküne göre) giden yol kaçışı denemeleri, tek yol parçası olarak
 * kodlanmış: göreli, ters eğik çizgili, mutlak, çift kodlanmış.
 */
function escapes(fromDir: string, rel: string, base = orgRoot(env.t, env.a)): string[] {
  const target = path.join(base, rel);
  const up = path.relative(fromDir, target).replace(/\\/g, "/");
  return [up, up.replace(/\//g, "\\"), target, target.replace(/\\/g, "/"), `./${up}`].flatMap((p) => [enc(p), enc(enc(p))]);
}

const bRoot = () => orgRoot(env.t, env.b);

function refBody(languageId: string, image: string | null) {
  const line = { text: "Beta Ref", family: "Great Vibes", style: "Regular", sizePx: 30, segments: [{ text: "Beta Ref", family: "Great Vibes", style: "Regular", sizePx: 30 }], ink: { x: 100, y: 200, w: 240, h: 30 } };
  return { languageId, source: "migrated", orderNo: "B-REF", quantity: 1, templateKey: "a1", labelFramePx: 440, text: "Beta Ref", user: [line], program: null, programMeta: null, image, split: "train" };
}

// ---------------------------------------------------------------- denemeler

type Probe = ProbeOptions & { run: (h: Harness) => Promise<void> };
const PROBES: Record<string, Probe> = {};
const probe = (key: string, run: Probe["run"], opts: ProbeOptions = {}) => {
  if (PROBES[key]) throw new Error(`Deneme iki kez tanımlı: ${key}`);
  PROBES[key] = { run, ...opts };
};

/** Kayıtlı ama denenmeyen uçlar ve gerekçesi (otomatik HEAD kopyaları ayrıca: GET denemesi HEAD'i de dener). */
const EXEMPT: Record<string, string> = {};

// ------------------------------------------------ sistem

probe("GET /api/health", async (h) => {
  const r = await h.ok("GET", "/api/health");
  expect(r.json.languages).toBe(env.t.raw.get("SELECT COUNT(*) AS n FROM languages WHERE org_id = ? AND deleted_at IS NULL", env.b)!.n);
});
probe("GET /api/settings", async (h) => {
  const r = await h.ok("GET", "/api/settings");
  expect(r.json.settings.defaultLanguageId).not.toBe(A.lang);
});
probe("PATCH /api/settings", async (h) => {
  await h.rejected("PATCH", "/api/settings", { defaultLanguageId: A.lang }, "language-unknown");
  expect((await h.ok("PATCH", "/api/settings", { variantsPerRun: 3 })).json.settings.variantsPerRun).toBe(3);
  await h.ok("PATCH", "/api/settings", { variantsPerRun: 1 });
});
// Yapay zekâ anahtarları kurulum düzeyinde (tables.ts `isInstallSettingKey`, YOL-HARITASI 2026-11-21): B'nin yazdığı
// anahtar kurulumun anahtarıdır. A'nın firma verisi ve dosyaları değişmez; kurulum ayarı değişebilir.
const keyProbe = async (h: Harness) => {
  await h.ok("PUT", "/api/settings/keys/gemini", { apiKey: "beta-anahtar-12345678" });
  await h.ok("DELETE", "/api/settings/keys/gemini");
};
probe("PUT /api/settings/keys/:provider", keyProbe, { install: true });
probe("DELETE /api/settings/keys/:provider", keyProbe, { install: true });
probe("POST /api/settings/keys/:provider/test", async (h) => {
  await h.ok("POST", "/api/settings/keys/anthropic/test", {});
});
probe("GET /api/costs", async (h) => {
  const calls = (r: { json: { byModel: { calls: number }[] } }) => r.json.byModel.reduce((s, x) => s + x.calls, 0);
  const own = Number(env.t.raw.get("SELECT COUNT(*) AS n FROM ai_calls WHERE org_id = ?", env.b)!.n);
  expect(calls(await h.ok("GET", "/api/costs"))).toBe(own);
  expect(calls(await h.ok("GET", `/api/costs?languageId=${A.lang}`))).toBe(0);
});
probe("GET /api/ai-calls/:id", async (h) => {
  await h.miss("GET", `/api/ai-calls/${A.aiCall}`, undefined, "ai-call-not-found");
});
probe("POST /api/undo/:token", async (h) => {
  await h.miss("POST", `/api/undo/${A.undoToken}`, {}, "undo-not-found");
});
probe("GET /api/profile-docs", async (h) => {
  await h.ok("GET", "/api/profile-docs");
});

// ------------------------------------------------ olaylar (SSE)

probe(
  "GET /api/events",
  async (h) => {
    const port = await env.listen();
    const since = env.log.hits.length;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctl.signal, headers: { [ORG_HEADER]: env.b } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    // A'nın olayları: istekle (parti), arka plan göreviyle (baskı çıktısı) ve doğrudan yayınla.
    expect((await env.asA("PATCH", `/api/batches/${A.batch}`, { name: "ALFA-PARTI Alfagizli yeni" })).status).toBe(200);
    const exA = await env.asA("POST", `/api/print/sessions/${A.session}/export`, { format: "png" });
    expect(exA.status).toBe(202);
    runInOrg(env.a, () => env.t.ctx.events.emit({ type: "job", jobId: A.job }));
    // B'nin kendi arka plan olayı da gelmeli (akış gerçekten çalışıyor).
    const exB = await env.asB("POST", `/api/print/sessions/${B.session}/export`, { format: "png" });
    expect(exB.status).toBe(202);
    await env.settle();
    // Bitiş işareti: B'nin ayar olayı.
    expect((await env.asB("PATCH", "/api/settings", { variantsPerRun: 1 })).status).toBe(200);
    const timeout = () => new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 5000).unref());
    while (!buf.includes("event: settings")) {
      const chunk = await Promise.race([reader.read(), timeout()]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value);
    }
    ctl.abort();
    for (const hit of env.log.hits.slice(since)) if (hit.org === env.b) h.hits.add(hit.key);
    expect(buf).toContain("event: settings");
    expect(buf).toContain(exB.json.id);
    expect(buf).not.toContain(exA.json.id);
    h.refresh(snapshotOrg(env, env.a));
    h.checkLeak("SSE", { body: buf, raw: Buffer.alloc(0), headers: {} }, "");
  },
  { custom: true },
);

// ------------------------------------------------ diller ve profil

probe("GET /api/languages", async (h) => {
  const r = await h.ok("GET", "/api/languages");
  expect(r.json.languages.map((l: { id: string }) => l.id)).toContain(B.lang);
});
probe("POST /api/languages", async (h) => {
  // A'nın dil kimliği B'de boş görünür ama kurulumda dolu: B'ye yeni kimlik verilir, A'nın dili değişmez.
  const r = await h.ok("POST", "/api/languages", { name: "Beta ikinci", id: A.lang });
  expect(r.json.id).not.toBe(A.lang);
  await h.miss("POST", "/api/languages", { name: "Beta kopya", copyFrom: A.lang }, "language-not-found");
});
probe("PATCH /api/languages/:lang", (h) => h.miss("PATCH", `/api/languages/${A.lang}`, { name: "Ele geçir" }, "language-not-found").then(() => undefined));
probe("DELETE /api/languages/:lang", (h) => h.miss("DELETE", `/api/languages/${A.lang}`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/default", (h) => h.miss("POST", `/api/languages/${A.lang}/default`, {}, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/profile", (h) => h.miss("GET", `/api/languages/${A.lang}/profile`, undefined, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/profile/draft", (h) => h.miss("GET", `/api/languages/${A.lang}/profile/draft`, undefined, "language-not-found").then(() => undefined));
probe("PUT /api/languages/:lang/profile/draft", (h) =>
  h.miss("PUT", `/api/languages/${A.lang}/profile/draft`, { data: { ...TEST_PROFILE, name: "Beta" } }, "language-not-found").then(() => undefined),
);
probe("DELETE /api/languages/:lang/profile/draft", (h) => h.miss("DELETE", `/api/languages/${A.lang}/profile/draft`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/profile/publish", (h) => h.miss("POST", `/api/languages/${A.lang}/profile/publish`, {}, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/profile/versions", (h) => h.miss("GET", `/api/languages/${A.lang}/profile/versions`, undefined, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/profile/versions/:version", (h) =>
  h.miss("GET", `/api/languages/${A.lang}/profile/versions/1`, undefined, "language-not-found").then(() => undefined),
);
probe("GET /api/languages/:lang/profile/diff", (h) => h.miss("GET", `/api/languages/${A.lang}/profile/diff?from=1&to=2`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/profile/revert", (h) => h.miss("POST", `/api/languages/${A.lang}/profile/revert`, { version: 1 }, "language-not-found").then(() => undefined));

// ------------------------------------------------ şablonlar ve fontlar

probe("GET /api/languages/:lang/templates", (h) => h.miss("GET", `/api/languages/${A.lang}/templates`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/templates", async (h) => {
  await h.miss("POST", `/api/languages/${A.lang}/templates`, { fileName: "a9.png", png: b64(await png(20, 20)) }, "language-not-found");
});
probe("POST /api/languages/:lang/templates/sync", (h) => h.miss("POST", `/api/languages/${A.lang}/templates/sync`, {}, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/templates/:key", (h) => h.miss("GET", `/api/languages/${A.lang}/templates/${A.key}`, undefined, "language-not-found").then(() => undefined));
probe("PATCH /api/languages/:lang/templates/:key", async (h) => {
  await h.miss("PATCH", `/api/languages/${A.lang}/templates/${A.key}`, { notes: "Ele geçir" }, "language-not-found");
  // B kendi şablonunun dosya yolunu A'nın dosyasına çeviremez (dosya alanı değiştirilemez).
  const up = path.relative(path.join(bRoot(), "diller", B.lang, "sablonlar"), path.join(orgRoot(env.t, env.a), A.files.template)).replace(/\\/g, "/");
  await h.rejected("PATCH", `/api/languages/${B.lang}/templates/${A.key}`, { file: up }, "template-fields-readonly");
});
probe("POST /api/languages/:lang/templates/:key/cut-preview", async (h) => {
  await h.miss("POST", `/api/languages/${A.lang}/templates/${A.key}/cut-preview`, { cut: null }, "language-not-found");
  // B'nin aynı anahtarlı şablonu: sayı yalnız B'nin onaylı işlerinden (A'nın aynı anahtarlı onaylı işi sayılmaz).
  const own = env.t.raw.all("SELECT j.id FROM jobs j WHERE j.org_id = ? AND j.template_key = ? AND j.status = 'approved' AND j.deleted_at IS NULL", env.b, A.key).length;
  expect(env.t.raw.all("SELECT j.id FROM jobs j WHERE j.org_id = ? AND j.template_key = ? AND j.status = 'approved'", env.a, A.key).length).toBeGreaterThan(0);
  const r = await h.ok("POST", `/api/languages/${B.lang}/templates/${A.key}/cut-preview`, { cut: { shape: "rect", wMm: 50, hMm: 30 } });
  expect(r.json).toEqual({ changed: true, approvals: own });
});
probe("GET /api/languages/:lang/templates/:key/image.png", async (h) => {
  await h.miss("GET", `/api/languages/${A.lang}/templates/${A.key}/image.png`, undefined, "language-not-found");
  // B'nin kendi diliyle yol kaçışı: anahtar kayıtta aranır, A'nın dosyasına inilmez.
  for (const k of escapes(path.join(bRoot(), "diller", B.lang, "sablonlar"), A.files.template)) await h.rejected("GET", `/api/languages/${B.lang}/templates/${k}/image.png`);
});
probe("GET /api/languages/:lang/templates/:key/overlay.png", (h) =>
  h.miss("GET", `/api/languages/${A.lang}/templates/${A.key}/overlay.png`, undefined, "language-not-found").then(() => undefined),
);
probe("GET /api/languages/:lang/fonts", (h) => h.miss("GET", `/api/languages/${A.lang}/fonts`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/fonts", (h) =>
  h.miss("POST", `/api/languages/${A.lang}/fonts`, { fileName: "Beta.ttf", data: b64(fakeFont("beta")) }, "language-not-found").then(() => undefined),
);
probe("GET /api/languages/:lang/fonts/:file/specimen.png", async (h) => {
  await h.miss("GET", `/api/languages/${A.lang}/fonts/${A.fontFile}/specimen.png`, undefined, "language-not-found");
  // B'nin diliyle A'nın font adı: B'nin klasöründe ve ortak klasörde yok.
  await h.miss("GET", `/api/languages/${B.lang}/fonts/${A.fontFile}/specimen.png`, undefined, "font-file-not-found");
  await h.miss("GET", `/api/languages/${B.lang}/fonts/${A.fontFile}/specimen.png?scope=shared`, undefined, "font-file-not-found");
  for (const f of escapes(path.join(bRoot(), "diller", B.lang, "fontlar"), A.files.font)) {
    await h.rejected("GET", `/api/languages/${B.lang}/fonts/${f}/specimen.png`);
    await h.rejected("GET", `/api/languages/${B.lang}/fonts/${f}/specimen.png?scope=shared`);
  }
});

// ------------------------------------------------ içe aktarma, işler, partiler, varyasyonlar, üretim

const records = (siparis: string, text: string) => JSON.stringify([{ siparis, etiket: "a1", adet: 2, text }]);

probe("POST /api/import/preview", async (h) => {
  await h.miss("POST", "/api/import/preview", { content: records("B-9", "Beta Dokuz"), languageId: A.lang }, "language-not-found");
  // Mükerrer denetimi firmalar arasında eşleşmez: A'nın siparişinin aynısı A'da "zaten var", B'de değil.
  const inA = await env.asA("POST", "/api/import/preview", { content: records(A.orderNo, A.text), languageId: A.lang });
  expect(inA.json.rows[0].issues.map((i: { code: string }) => i.code)).toContain("duplicate-existing");
  const r = await h.ok("POST", "/api/import/preview", { content: records(A.orderNo, A.text), languageId: B.lang });
  const codes: string[] = r.json.rows[0].issues.map((i: { code: string }) => i.code);
  expect(codes.filter((c) => c.startsWith("duplicate"))).toEqual([]);
});
probe("POST /api/import/validate", async (h) => {
  await h.miss("POST", "/api/import/validate", { languageId: A.lang, rows: [] }, "language-not-found");
  const prev = await h.ok("POST", "/api/import/preview", { content: records(A.orderNo, A.text), languageId: B.lang });
  const r = await h.ok("POST", "/api/import/validate", { languageId: B.lang, rows: prev.json.rows });
  expect(r.json.rows[0].issues.map((i: { code: string }) => i.code).filter((c: string) => c.startsWith("duplicate"))).toEqual([]);
});
probe("POST /api/import/commit", async (h) => {
  const prev = await h.ok("POST", "/api/import/preview", { content: records("B-10", "Beta On"), languageId: B.lang });
  await h.miss("POST", "/api/import/commit", { mapping: prev.json.mapping, rows: prev.json.rows, languageId: A.lang }, "language-not-found");
});
probe("GET /api/jobs", async (h) => {
  expect((await h.ok("GET", "/api/jobs")).json.jobs.map((j: { id: string }) => j.id)).toContain(B.job);
  expect((await h.ok("GET", `/api/jobs?batchId=${A.batch}`)).json.jobs).toEqual([]);
  expect((await h.ok("GET", `/api/jobs?languageId=${A.lang}`)).json.jobs).toEqual([]);
  expect((await h.ok("GET", `/api/jobs?q=${enc(A.orderNo)}`)).json.jobs).toEqual([]);
  expect((await h.ok("GET", "/api/jobs?q=Alfagizli")).json.jobs).toEqual([]);
});
probe("POST /api/jobs/manual", async (h) => {
  await h.miss("POST", "/api/jobs/manual", { languageId: A.lang, text: "Beta el" }, "language-not-found");
  // B'nin diline ama A'nın partisine iş eklenemez.
  await h.miss("POST", "/api/jobs/manual", { languageId: B.lang, batchId: A.batch, text: "Beta el" }, "batch-not-found");
});
probe("POST /api/jobs/bulk", (h) => h.miss("POST", "/api/jobs/bulk", { ids: [A.job], patch: { aiNote: "Ele geçir" } }, "job-not-found").then(() => undefined));
probe("POST /api/jobs/delete", async (h) => {
  await h.miss("POST", "/api/jobs/delete", { ids: [A.job, A.imageJob] }, "jobs-to-delete-not-found");
  // Karışık liste: yalnız B'nin işi silinir; geri alma da yalnız onu geri getirir.
  const r = await h.ok("POST", "/api/jobs/delete", { ids: [A.job, B.job] });
  const payload = JSON.parse(String(env.t.raw.get("SELECT payload FROM undo WHERE token = ?", r.json.undoToken)!.payload));
  expect(payload.jobs).toEqual([B.job]);
  expect((await h.ok("POST", `/api/undo/${r.json.undoToken}`, {})).json.restored.jobs).toBe(1);
});
probe("POST /api/jobs/approve-best", async (h) => {
  const r = await h.ok("POST", "/api/jobs/approve-best", { ids: [A.job, A.imageJob] });
  expect(r.json.approved).toEqual([]);
  expect(r.json.skipped.map((s: { id: string }) => s.id)).toEqual([A.job, A.imageJob]);
});
probe("GET /api/jobs/:id", (h) => h.miss("GET", `/api/jobs/${A.job}`, undefined, "job-not-found").then(() => undefined));
probe("PATCH /api/jobs/:id", (h) => h.miss("PATCH", `/api/jobs/${A.job}`, { aiNote: "Ele geçir" }, "job-not-found").then(() => undefined));
probe("DELETE /api/jobs/:id", (h) => h.miss("DELETE", `/api/jobs/${A.job}`, undefined, "job-not-found").then(() => undefined));
probe("POST /api/jobs/:id/approve", async (h) => {
  await h.miss("POST", `/api/jobs/${A.job}/approve`, { variantId: null }, "job-not-found");
  await h.miss("POST", `/api/jobs/${A.job}/approve`, { variantId: A.variant }, "job-not-found");
  // B'nin işine A'nın varyasyonu onaylanamaz.
  await h.miss("POST", `/api/jobs/${B.job}/approve`, { variantId: A.variant }, "variant-not-found");
});
probe("GET /api/jobs/:id/log", (h) => h.miss("GET", `/api/jobs/${A.job}/log`, undefined, "job-not-found").then(() => undefined));
probe("GET /api/batches", async (h) => {
  expect((await h.ok("GET", "/api/batches")).json.batches.length).toBeGreaterThan(0);
  expect((await h.ok("GET", `/api/batches?languageId=${A.lang}`)).json.batches).toEqual([]);
});
probe("PATCH /api/batches/:id", (h) => h.miss("PATCH", `/api/batches/${A.batch}`, { name: "Ele geçir" }, "batch-not-found").then(() => undefined));
probe("DELETE /api/batches/:id", (h) => h.miss("DELETE", `/api/batches/${A.batch}`, undefined, "batch-not-found").then(() => undefined));
probe("GET /api/variants/:id", async (h) => {
  await h.miss("GET", `/api/variants/${A.variant}`, undefined, "variant-not-found");
  await h.miss("GET", `/api/variants/${A.imageVariant}`, undefined, "variant-not-found");
});
probe("PATCH /api/variants/:id", async (h) => {
  await h.miss("PATCH", `/api/variants/${A.variant}`, {}, "variant-not-found");
  await h.miss("PATCH", `/api/variants/${A.variant}`, { suspect: true }, "variant-not-found");
});
probe("DELETE /api/variants/:id", (h) => h.miss("DELETE", `/api/variants/${A.variant}`, undefined, "variant-not-found").then(() => undefined));
probe("GET /api/variants/:id/preview.png", async (h) => {
  await h.miss("GET", `/api/variants/${A.variant}/preview.png`, undefined, "preview-not-found");
  await h.miss("GET", `/api/variants/${A.imageVariant}/preview.png`, undefined, "preview-not-found");
});
probe("GET /api/variants/:id/text-layer.png", (h) => h.miss("GET", `/api/variants/${A.imageVariant}/text-layer.png`, undefined, "text-layer-not-found").then(() => undefined));
probe("POST /api/variants/:id/revise", (h) => h.miss("POST", `/api/variants/${A.variant}/revise`, { request: "daha büyük" }, "variant-not-found").then(() => undefined));
probe("POST /api/generate", async (h) => {
  for (const mode of ["text", "image-on-template"]) {
    const r = await h.ok("POST", "/api/generate", { jobIds: [A.job, A.spareJob], mode });
    expect(r.json.queued).toEqual([]);
    expect(r.json.skipped.map((s: { id: string }) => s.id).sort()).toEqual([A.job, A.spareJob].sort());
  }
});

/**
 * Kuyruk: A'nın işleri çalışırken/beklerken (çalıştırıcı bekletilir) B'nin durumu boş, B'nin iptali (A'nın
 * kimlikleriyle ya da "hepsi") A'nın bekleyen görevine dokunmaz.
 */
const queueProbe = async (h: Harness) => {
  await env.settle();
  const prevConcurrency = runInOrg(env.a, () => env.t.ctx.settings.get().concurrency);
  runInOrg(env.a, () => env.t.ctx.settings.update({ concurrency: 1 }));
  const block = env.blockQueue();
  try {
    const jobs = [A.spareJob, A.imageJob];
    expect(runInOrg(env.a, () => env.t.ctx.queue.enqueue(jobs.map((jobId) => ({ jobId, mode: "text" as const })))).queued).toEqual(jobs);
    await tick();
    expect(runInOrg(env.a, () => env.t.ctx.queue.status())).toMatchObject({ running: 1, queued: 1, runningJobIds: [A.spareJob] });
    await h.isolated(
      async () => {
        expect((await h.ok("GET", "/api/generate/status")).json).toMatchObject({ running: 0, queued: 0, runningJobIds: [] });
        expect((await h.ok("POST", "/api/generate/cancel", { jobIds: jobs })).json.cancelled).toBe(0);
        expect((await h.ok("POST", "/api/generate/cancel", {})).json.cancelled).toBe(0);
        const log = await h.miss("GET", `/api/jobs/${A.spareJob}/log`, undefined, "job-not-found");
        expect(log.body).not.toContain("running");
      },
      { settle: false },
    );
    expect(runInOrg(env.a, () => env.t.ctx.queue.status())).toMatchObject({ running: 1, queued: 1 });
  } finally {
    await block.release();
    runInOrg(env.a, () => env.t.ctx.settings.update({ concurrency: prevConcurrency }));
    await env.settle();
  }
};
probe("POST /api/generate/cancel", queueProbe, { custom: true });
probe("GET /api/generate/status", queueProbe, { custom: true });

// ------------------------------------------------ hafif düzeltme

probe("GET /api/variants/:id/edit", (h) => h.miss("GET", `/api/variants/${A.variant}/edit`, undefined, "variant-not-found").then(() => undefined));
probe("GET /api/variants/:id/edit/text.svg", (h) => h.miss("GET", `/api/variants/${A.variant}/edit/text.svg`, undefined, "variant-not-found").then(() => undefined));
probe("POST /api/variants/:id/edit/relayout", (h) => h.miss("POST", `/api/variants/${A.variant}/edit/relayout`, { edits: [] }, "variant-not-found").then(() => undefined));
probe("POST /api/variants/:id/adjust/check", (h) => h.miss("POST", `/api/variants/${A.variant}/adjust/check`, { adjust: { dx: 1 } }, "variant-not-found").then(() => undefined));
probe("PUT /api/variants/:id/adjust", (h) => h.miss("PUT", `/api/variants/${A.variant}/adjust`, { adjust: { dx: 1 } }, "variant-not-found").then(() => undefined));
probe("DELETE /api/variants/:id/adjust", (h) => h.miss("DELETE", `/api/variants/${A.variant}/adjust`, undefined, "variant-not-found").then(() => undefined));

// ------------------------------------------------ referanslar ve öneriler

probe("GET /api/references", async (h) => {
  await h.ok("GET", "/api/references");
  expect((await h.ok("GET", `/api/references?languageId=${A.lang}`)).json.references).toEqual([]);
});
probe("POST /api/references", async (h) => {
  await h.miss("POST", "/api/references", refBody(A.lang, null), "language-not-found");
  // Görsel yolu yalnız kendi dilinin referans klasörü: A'nın görseline işaret eden yol reddedilir.
  await h.rejected("POST", "/api/references", refBody(B.lang, A.files.reference), "reference-invalid");
  await h.rejected("POST", "/api/references", refBody(B.lang, `referanslar/${B.lang}/../../referanslar/${A.lang}/x.png`), "reference-invalid");
  await h.rejected("POST", "/api/references", refBody(B.lang, `referanslar/${B.lang}/..\\..\\..\\${A.files.reference}`), "reference-invalid");
});
probe("GET /api/references/:id", (h) => h.miss("GET", `/api/references/${A.reference}`, undefined, "reference-not-found").then(() => undefined));
probe("PATCH /api/references/:id", (h) => h.miss("PATCH", `/api/references/${A.reference}`, { split: "test" }, "reference-not-found").then(() => undefined));
probe("DELETE /api/references/:id", (h) => h.miss("DELETE", `/api/references/${A.reference}`, undefined, "reference-not-found").then(() => undefined));
probe("GET /api/learn/proposals", async (h) => {
  await h.ok("GET", "/api/learn/proposals");
  expect((await h.ok("GET", `/api/learn/proposals?languageId=${A.lang}`)).json.proposals).toEqual([]);
});
probe("POST /api/learn/proposals", (h) => h.miss("POST", "/api/learn/proposals", { languageId: A.lang, title: "Ele geçir" }, "language-not-found").then(() => undefined));
probe("GET /api/learn/proposals/:id", (h) => h.miss("GET", `/api/learn/proposals/${A.proposal}`, undefined, "proposal-not-found").then(() => undefined));
probe("PATCH /api/learn/proposals/:id", (h) => h.miss("PATCH", `/api/learn/proposals/${A.proposal}`, { status: "rejected" }, "proposal-not-found").then(() => undefined));
probe("DELETE /api/learn/proposals/:id", (h) => h.miss("DELETE", `/api/learn/proposals/${A.proposal}`, undefined, "proposal-not-found").then(() => undefined));

// ------------------------------------------------ öğrenme

probe("POST /api/languages/:lang/learn/run", (h) => h.miss("POST", `/api/languages/${A.lang}/learn/run`, {}, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/learn/run", (h) => h.miss("GET", `/api/languages/${A.lang}/learn/run`, undefined, "language-not-found").then(() => undefined));
probe("DELETE /api/languages/:lang/learn/run", (h) => h.miss("DELETE", `/api/languages/${A.lang}/learn/run`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/learn/proposals/:id/apply", (h) => h.miss("POST", `/api/learn/proposals/${A.proposal}/apply`, {}, "proposal-not-found").then(() => undefined));
probe("POST /api/learn/proposals/:id/reject", (h) => h.miss("POST", `/api/learn/proposals/${A.proposal}/reject`, {}, "proposal-not-found").then(() => undefined));
probe("POST /api/learn/proposals/:id/revert", (h) => h.miss("POST", `/api/learn/proposals/${A.proposal}/revert`, {}, "proposal-not-found").then(() => undefined));
probe("GET /api/languages/:lang/learn/measure", (h) => h.miss("GET", `/api/languages/${A.lang}/learn/measure`, undefined, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/learn/samples", (h) => h.miss("GET", `/api/languages/${A.lang}/learn/samples`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/learn/replay", (h) => h.miss("POST", `/api/languages/${A.lang}/learn/replay`, {}, "language-not-found").then(() => undefined));
probe("GET /api/learn/previews/:dir/:file", async (h) => {
  const { dir, file } = A.learnPreview;
  await h.miss("GET", `/api/learn/previews/${dir}/${file}`, undefined, "preview-not-found");
  const from = path.join(bRoot(), "onizleme", "ogrenme");
  for (const d of escapes(from, path.join("onizleme", "ogrenme", dir))) await h.rejected("GET", `/api/learn/previews/${d}/${file}`);
  for (const f of escapes(path.join(from, "x"), path.join("onizleme", "ogrenme", dir, file))) await h.rejected("GET", `/api/learn/previews/x/${f}`);
  await h.rejected("GET", `/api/learn/previews/..%2F..%2F..%2F..%2Fonizleme%2Fogrenme%2F${dir}/${file}`);
});
probe("GET /api/learn/references/:id/thumb.png", async (h) => {
  await h.miss("GET", `/api/learn/references/${A.reference}/thumb.png`, undefined, "reference-not-found");
  await h.miss("GET", `/api/learn/references/${A.reference}/thumb.png?template=1&w=64`, undefined, "reference-not-found");
});
probe("GET /api/languages/:lang/learn/templates/:key/thumb.png", async (h) => {
  await h.miss("GET", `/api/languages/${A.lang}/learn/templates/${A.key}/thumb.png`, undefined, "language-not-found");
  for (const k of escapes(path.join(bRoot(), "diller", B.lang, "sablonlar"), A.files.template)) await h.rejected("GET", `/api/languages/${B.lang}/learn/templates/${k}/thumb.png`);
});

// ------------------------------------------------ tasarım oturumu

probe("GET /api/languages/:lang/design-session", (h) => h.miss("GET", `/api/languages/${A.lang}/design-session`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/design-session", (h) => h.miss("POST", `/api/languages/${A.lang}/design-session`, { title: "Ele geçir" }, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/design-session/entries", (h) =>
  h.miss("POST", `/api/languages/${A.lang}/design-session/entries`, { kind: "note", text: "Ele geçir" }, "language-not-found").then(() => undefined),
);
probe("POST /api/languages/:lang/design-session/draft", (h) =>
  h.miss("POST", `/api/languages/${A.lang}/design-session/draft`, { patch: { name: "Ele geçir" } }, "language-not-found").then(() => undefined),
);

// ------------------------------------------------ araçlar

probe("POST /api/languages/:lang/templates/:key/suggest-area", (h) =>
  h.miss("POST", `/api/languages/${A.lang}/templates/${A.key}/suggest-area`, {}, "language-not-found").then(() => undefined),
);
probe("POST /api/languages/:lang/templates/:key/try", (h) => h.miss("POST", `/api/languages/${A.lang}/templates/${A.key}/try`, { text: "Beta" }, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/templates/generate", (h) => h.miss("POST", `/api/languages/${A.lang}/templates/generate`, { theme: "Ele geçir" }, "language-not-found").then(() => undefined));
probe("GET /api/template-tasks/:id", (h) => h.miss("GET", `/api/template-tasks/${A.templateTask}`, undefined, "template-task-not-found").then(() => undefined));
probe("GET /api/languages/:lang/export", (h) => h.miss("GET", `/api/languages/${A.lang}/export`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/import", async (h) => {
  // Paket A'nın dil kimliğini, kaçışlı şablon dosya adını ve kaçışlı font adlarını taşır: B'ye yeni dil açılır, A'ya yazılmaz.
  const pkg = {
    format: "etiket-studio-dil",
    version: 1,
    exportedAt: "2026-11-21T00:00:00.000Z",
    language: { id: A.lang, name: "Beta paket" },
    profile: { ...TEST_PROFILE, name: "Beta paket" },
    profileVersion: 1,
    draft: null,
    templates: [{ record: { key: A.key, file: `../../../../../${A.files.template}` }, png: b64(await png(41, 41, { r: 1, g: 99, b: 1, alpha: 1 })) }],
    fonts: [
      { file: `../../../../../${A.files.font}`, data: b64(fakeFont("beta")) },
      { file: `..\\..\\${A.fontFile}`, data: b64(fakeFont("beta")) },
    ],
    id: A.lang,
  };
  const r = await h.ok("POST", "/api/languages/import", pkg);
  expect(r.json.language.id).not.toBe(A.lang);
  expect(r.json.fonts).toBe(0);
});
probe("POST /api/languages/:lang/profile/try", async (h) => {
  const body = (referenceId: string | null) => ({ samples: [{ id: "s1", text: "Beta Deneme", templateKey: "a1", referenceId }], mode: "engine" });
  await h.miss("POST", `/api/languages/${A.lang}/profile/try`, body(null), "language-not-found");
  // B'nin dilinde A'nın referansı: "bulunamadı" sayılır (atlanır), A'nın satırları kullanılmaz.
  const r = await h.ok("POST", `/api/languages/${B.lang}/profile/try`, body(A.reference));
  expect(r.json.results[0].error).toContain("Referans bulunamadı");
});
probe("GET /api/trials/:id/preview.png", (h) => h.miss("GET", `/api/trials/${A.trialPreview}/preview.png`, undefined, "trial-preview-not-found").then(() => undefined));
probe("GET /api/references/:id/image.png", (h) => h.miss("GET", `/api/references/${A.reference}/image.png`, undefined, "reference-not-found").then(() => undefined));

// ------------------------------------------------ baskı masası

probe("GET /api/print/templates", async (h) => {
  await h.miss("GET", `/api/print/templates?languageId=${A.lang}`, undefined, "language-not-found");
  await h.miss("GET", `/api/print/templates?languageId=${A.lang}&archived=1`, undefined, "language-not-found");
  expect((await h.ok("GET", `/api/print/templates?languageId=${B.lang}&archived=1`)).json.templates.map((x: { id: string }) => x.id)).toContain(B.printTemplate);
});
probe("POST /api/print/templates", (h) =>
  h.miss("POST", "/api/print/templates", { languageId: A.lang, name: "Ele geçir", paper: { wMm: 100, hMm: 100 }, slots: [] }, "language-not-found").then(() => undefined),
);
probe("POST /api/print/templates/grid", async (h) => {
  await h.miss("POST", "/api/print/templates/grid", { languageId: A.lang, ...GRID }, "language-not-found");
  await h.miss("POST", "/api/print/templates/grid", { languageId: B.lang, templateId: A.printTemplate, ...GRID }, "print-template-not-found");
  await h.miss("POST", "/api/print/templates/grid", { languageId: B.lang, templateId: A.printTemplate, dryRun: true, ...GRID }, "print-template-not-found");
});
probe("GET /api/print/templates/:id", (h) => h.miss("GET", `/api/print/templates/${A.printTemplate}`, undefined, "print-template-not-found").then(() => undefined));
probe("PATCH /api/print/templates/:id", (h) => h.miss("PATCH", `/api/print/templates/${A.printTemplate}`, { name: "Ele geçir" }, "print-template-not-found").then(() => undefined));
probe("DELETE /api/print/templates/:id", (h) => h.miss("DELETE", `/api/print/templates/${A.printTemplate}`, undefined, "print-template-not-found").then(() => undefined));
probe("POST /api/print/templates/:id/archive", (h) => h.miss("POST", `/api/print/templates/${A.printTemplate}/archive`, { archived: true }, "print-template-not-found").then(() => undefined));
probe("POST /api/print/templates/:id/duplicate", (h) => h.miss("POST", `/api/print/templates/${A.printTemplate}/duplicate`, {}, "print-template-not-found").then(() => undefined));
probe("GET /api/print/presets", async (h) => {
  await h.miss("GET", `/api/print/presets?languageId=${A.lang}`, undefined, "language-not-found");
  await h.ok("GET", `/api/print/presets?languageId=${B.lang}`);
});
probe("POST /api/print/presets", (h) => h.miss("POST", "/api/print/presets", { languageId: A.lang, name: "Ele geçir", grid: GRID }, "language-not-found").then(() => undefined));
probe("PATCH /api/print/presets/:id", async (h) => {
  await h.miss("PATCH", `/api/print/presets/${A.preset}`, { languageId: A.lang, name: "Ele geçir" }, "language-not-found");
  await h.miss("PATCH", `/api/print/presets/${A.preset}`, { languageId: B.lang, name: "Ele geçir" }, "preset-not-found");
});
probe("DELETE /api/print/presets/:id", async (h) => {
  await h.miss("DELETE", `/api/print/presets/${A.preset}?languageId=${A.lang}`, undefined, "language-not-found");
  await h.miss("DELETE", `/api/print/presets/${A.preset}?languageId=${B.lang}`, undefined, "preset-not-found");
});
probe("GET /api/print/shelf", (h) => h.miss("GET", `/api/print/shelf?languageId=${A.lang}`, undefined, "language-not-found").then(() => undefined));
probe("GET /api/print/sessions", async (h) => {
  expect((await h.ok("GET", "/api/print/sessions")).json.sessions.map((s: { id: string }) => s.id)).toContain(B.session);
  expect((await h.ok("GET", `/api/print/sessions?languageId=${A.lang}`)).json.sessions).toEqual([]);
  expect((await h.ok("GET", `/api/print/sessions?q=${enc(A.orderNo)}`)).json.sessions).toEqual([]);
  expect((await h.ok("GET", "/api/print/sessions?q=Alfagizli")).json.sessions).toEqual([]);
});
probe("POST /api/print/sessions", async (h) => {
  await h.miss("POST", "/api/print/sessions", { languageId: A.lang, templateId: A.printTemplate }, "language-not-found");
  await h.miss("POST", "/api/print/sessions", { languageId: B.lang, templateId: A.printTemplate }, "print-template-not-found");
  // B'nin şablonuyla A'nın işi: "bulunamadı" sayılır, eşleşen iş kalmaz.
  await h.rejected("POST", "/api/print/sessions", { languageId: B.lang, templateId: B.printTemplate, jobIds: [A.job] }, "session-no-matching-jobs");
});
probe("GET /api/print/sessions/:id", (h) => h.miss("GET", `/api/print/sessions/${A.session}`, undefined, "print-session-not-found").then(() => undefined));
probe("PATCH /api/print/sessions/:id", async (h) => {
  await h.miss("PATCH", `/api/print/sessions/${A.session}`, { version: 0, ops: [{ op: "renameSession", name: "Ele geçir" }] }, "print-session-not-found");
  // B'nin kendi taslağında A'nın sayfa/öğe/iş/varyasyon/şablon kimlikleri.
  const free = { slotId: null, xMm: 10, yMm: 10 };
  const cases: [Record<string, unknown>, string][] = [
    [{ op: "addItem", pageId: B.page, jobId: A.job, ...free }, "job-not-found"],
    [{ op: "addItem", pageId: A.page, jobId: B.job, ...free }, "print-page-not-found"],
    [{ op: "addItem", pageId: B.page, jobId: B.job, variantId: A.variant, ...free }, "variant-not-found"],
    [{ op: "moveItem", itemId: A.item, ...free }, "print-item-not-found"],
    [{ op: "moveItem", itemId: B.item, pageId: A.page, ...free }, "print-page-not-found"],
    [{ op: "updateItem", itemId: A.item, rotation: 5 }, "print-item-not-found"],
    [{ op: "updateItem", itemId: B.item, variantId: A.variant }, "variant-not-found"],
    [{ op: "removeItem", itemId: A.item }, "print-item-not-found"],
    [{ op: "addPage", templateId: A.printTemplate }, "print-template-not-found"],
    [{ op: "removePage", pageId: A.page }, "print-page-not-found"],
    [{ op: "updatePage", pageId: A.page, name: "Ele geçir" }, "print-page-not-found"],
    [{ op: "setPageTemplate", pageId: B.page, templateId: A.printTemplate }, "print-template-not-found"],
    [{ op: "setPageTemplate", pageId: A.page, templateId: B.printTemplate }, "print-page-not-found"],
  ];
  for (const [op, code] of cases) {
    const version = (await h.ok("GET", `/api/print/sessions/${B.session}`)).json.version;
    await h.rejected("PATCH", `/api/print/sessions/${B.session}`, { version, ops: [op] }, code);
  }
  // A'nın sayfa/öğe kimliğini istemci kimliği olarak verir: kimlik başka firmada dolu olsa da hata yok (varlığı ele
  // verilmez); sunucu sessizce yeni kimlik verir, aynı yamadaki başvuru çevrilir, yanıt gerçek kimliği döner.
  const version = (await h.ok("GET", `/api/print/sessions/${B.session}`)).json.version;
  const r = await h.ok("PATCH", `/api/print/sessions/${B.session}`, {
    version,
    ops: [
      { op: "addPage", id: A.page },
      { op: "addItem", id: A.item, pageId: A.page, jobId: B.job, ...free },
    ],
  });
  const pageId = r.json.ids[A.page] as string;
  const itemId = r.json.ids[A.item] as string;
  expect([pageId, itemId].every((x) => typeof x === "string" && x !== A.page && x !== A.item)).toBe(true);
  const added = r.json.session.pages.find((p: { id: string }) => p.id === pageId);
  expect(added.items.map((i: { id: string }) => i.id)).toEqual([itemId]);
  expect(env.t.raw.get("SELECT org_id FROM print_pages WHERE id = ?", A.page)).toEqual({ org_id: env.a });
  expect(env.t.raw.get("SELECT org_id FROM print_items WHERE id = ?", A.item)).toEqual({ org_id: env.a });
  // B'nin oturumu eski hâline döner (sonraki denemeler aynı düzeneği kullanır).
  await h.ok("PATCH", `/api/print/sessions/${B.session}`, { version: r.json.session.version, ops: [{ op: "removePage", pageId }] });
});
probe("DELETE /api/print/sessions/:id", (h) => h.miss("DELETE", `/api/print/sessions/${A.session}`, undefined, "print-session-not-found").then(() => undefined));
probe("POST /api/print/sessions/:id/replan", (h) => h.miss("POST", `/api/print/sessions/${A.session}/replan`, { version: 0 }, "print-session-not-found").then(() => undefined));
probe("POST /api/print/sessions/:id/jobs", async (h) => {
  await h.miss("POST", `/api/print/sessions/${A.session}/jobs`, { version: 0, jobIds: [B.job] }, "print-session-not-found");
  // B'nin taslağına A'nın işi eklenemez: atlanır.
  const version = (await h.ok("GET", `/api/print/sessions/${B.session}`)).json.version;
  const r = await h.req("POST", `/api/print/sessions/${B.session}/jobs`, { version, jobIds: [A.job] });
  if (r.status === 200) expect(r.json.skipped.map((s: { jobId: string }) => s.jobId)).toEqual([A.job]);
  else expect(r.status, r.body).toBeGreaterThanOrEqual(400);
  const items = (await h.ok("GET", `/api/print/sessions/${B.session}`)).json.pages.flatMap((p: { items: { jobId: string }[] }) => p.items.map((i) => i.jobId));
  expect(items).not.toContain(A.job);
});
probe("POST /api/print/sessions/:id/printed", (h) => h.miss("POST", `/api/print/sessions/${A.session}/printed`, { printed: true }, "print-session-not-found").then(() => undefined));
probe("POST /api/print/sessions/:id/reprint", (h) => h.miss("POST", `/api/print/sessions/${A.session}/reprint`, {}, "print-session-not-found").then(() => undefined));
probe("GET /api/print/pages/:id/preview.png", (h) => h.miss("GET", `/api/print/pages/${A.page}/preview.png`, undefined, "print-page-not-found").then(() => undefined));
probe("POST /api/print/sessions/:id/export", async (h) => {
  await h.miss("POST", `/api/print/sessions/${A.session}/export`, { format: "png" }, "print-session-not-found");
  await h.miss("POST", `/api/print/sessions/${B.session}/export`, { format: "pdf", pages: [A.page] }, "print-page-not-found");
});
probe("GET /api/print/exports/:id", (h) => h.miss("GET", `/api/print/exports/${A.export}`, undefined, "export-not-found").then(() => undefined));
probe("GET /api/print/exports/:id/files/:index", async (h) => {
  await h.miss("GET", `/api/print/exports/${A.export}/files/0`, undefined, "export-not-found");
  await h.miss("GET", `/api/print/exports/${A.export}/files/-1`, undefined, "export-not-found");
});

// ------------------------------------------------ uygulamayla gelen yedek fontlar (firma verisi yok; yol kaçışı)

probe("GET /api/fallback-fonts", (h) => h.ok("GET", "/api/fallback-fonts").then(() => undefined));
probe("GET /api/fallback-fonts.css", (h) => h.ok("GET", "/api/fallback-fonts.css").then(() => undefined));
probe("GET /api/fallback-fonts/:file", async (h) => {
  await h.miss("GET", `/api/fallback-fonts/${A.fontFile}`);
  for (const f of escapes(path.join(env.t.dir, "ortak", "fontlar"), A.files.font)) await h.rejected("GET", `/api/fallback-fonts/${f}`);
});

// ------------------------------------------------ firma

probe("GET /api/org", async (h) => {
  expect((await h.ok("GET", "/api/org")).json.org).toEqual({ id: env.b, name: "BETA FIRMA" });
});
probe("PATCH /api/org", async (h) => {
  // Yalnız isteğin firması değişir (A'nın satırı ve adı aynı kalır: durum karşılaştırması).
  expect((await h.ok("PATCH", "/api/org", { name: "BETA YENI" })).json.org).toEqual({ id: env.b, name: "BETA YENI" });
  await h.rejected("PATCH", "/api/org", { name: "X", id: env.a });
  expect((await h.ok("PATCH", "/api/org", { name: "BETA FIRMA" })).json.org.name).toBe("BETA FIRMA");
  expect(env.t.ctx.orgs.get(env.a)?.name).toBe("ALFA FIRMA");
});

// ------------------------------------------------ özellikler ve kurulum (B2): yalnız isteğin firmasının ayarı değişir

probe("GET /api/features", async (h) => {
  const r = await h.ok("GET", "/api/features");
  expect(r.json.effective.learn).toBe(true);
  expect(Object.values(r.json.explicit).every((c) => (c as { by: string }).by === "migration")).toBe(true);
});
probe("PATCH /api/features", async (h) => {
  expect((await h.ok("PATCH", "/api/features", { "print.stickers": false })).json.effective["print.stickers"]).toBe(false);
  await h.rejected("PATCH", "/api/features", { "core.production": false }, "feature-always-on");
  expect((await h.ok("PATCH", "/api/features", { "print.stickers": true })).json.effective["print.stickers"]).toBe(true);
  expect(runInOrg(env.a, () => env.t.ctx.features.explicit()["print.stickers"]?.by)).toBe("migration");
});
probe("GET /api/setup", async (h) => {
  expect((await h.ok("GET", "/api/setup")).json).toMatchObject({ status: expect.any(String), step: expect.any(Number) });
});
probe("POST /api/setup/preview", async (h) => {
  // B'nin özellikleri göçle açık (kurulum onaysız kapatmaz): öneri değişiklik getirmez.
  expect((await h.ok("POST", "/api/setup/preview", { answers: { labelTypes: ["sticker"] } })).json.changes).toEqual([]);
  await h.rejected("POST", "/api/setup/preview", { answers: { labelTypes: ["yok"] } }, "setup-invalid");
});
probe("PUT /api/setup/answers", async (h) => {
  expect((await h.ok("PUT", "/api/setup/answers", { step: 2, answers: { labelTypes: ["wedding"] } })).json.answers.labelTypes).toEqual(["wedding"]);
});
probe("POST /api/setup/complete", async (h) => {
  const r = await h.ok("POST", "/api/setup/complete", { answers: { labelTypes: ["wedding"] }, features: ["core.production", "print"] });
  expect(r.json.setup.status).toBe("completed");
  // Listede olmayan (elle açılmış) özellik kurulumda bilerek kapatılmış sayılır.
  expect(r.json.features.effective.learn).toBe(false);
});
probe("POST /api/setup/skip", async (h) => {
  expect((await h.ok("POST", "/api/setup/skip", {})).json.setup).toMatchObject({ status: "completed", skipped: true });
});
probe("POST /api/setup/restart", async (h) => {
  expect((await h.ok("POST", "/api/setup/restart", {})).json.status).toBe("in-progress");
  expect(runInOrg(env.a, () => env.t.ctx.setup.state().status)).toBe("pending");
});

// ------------------------------------------------ sitede tasarım dili oluşturucu (C3): A'nın oturumu, örneği, revizyonu

const bp = (rest = "") => `/api/builds/${A.build}${rest}`;
const missBuild = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", rest: string, body?: unknown, code = "build-not-found") => (h: Harness) => h.miss(method, bp(rest), body, code).then(() => undefined);

probe("POST /api/builds/estimate", (h) => h.miss("POST", "/api/builds/estimate", { languageId: A.lang, samples: 0 }, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/builds", (h) => h.miss("POST", `/api/languages/${A.lang}/builds`, { base: "published" }, "language-not-found").then(() => undefined));
probe("GET /api/languages/:lang/builds/current", (h) => h.miss("GET", `/api/languages/${A.lang}/builds/current`, undefined, "language-not-found").then(() => undefined));
probe("POST /api/languages/:lang/showcase", (h) => h.miss("POST", `/api/languages/${A.lang}/showcase`, { source: "published" }, "language-not-found").then(() => undefined));
probe("GET /api/builds/:id", async (h) => {
  await h.miss("GET", bp(), undefined, "build-not-found");
  // MCP oturumunun kimliği de site oturumu olarak okunmaz.
  await h.miss("GET", `/api/builds/${A.designSession}`, undefined, "build-not-found");
});
probe("GET /api/builds/:id/messages", missBuild("GET", "/messages"));
probe("POST /api/builds/:id/messages", missBuild("POST", "/messages", { kind: "note", text: "Ele geçir" }));
probe("PUT /api/builds/:id/intake", missBuild("PUT", "/intake", { labelTypes: ["wedding"] }));
probe("POST /api/builds/:id/samples", async (h) => h.miss("POST", bp("/samples"), { files: [{ name: "b.png", dataBase64: b64(await png(80, 80)) }] }, "build-not-found").then(() => undefined));
probe("PATCH /api/builds/:id/samples/:sid", async (h) => {
  await h.miss("PATCH", bp(`/samples/${A.buildSample}`), { exclude: true }, "build-not-found");
  // B'nin kendi oturumunda A'nın örnek kimliği: bulunamadı.
  const own = await h.ok("POST", `/api/languages/${B.lang}/builds`, { base: "default", fromSetup: true, labelTypes: ["wedding"] }, 201);
  await h.miss("PATCH", `/api/builds/${own.json.id}/samples/${A.buildSample}`, { exclude: true }, "sample-not-found");
  await h.miss("GET", `/api/builds/${own.json.id}/samples/${A.buildSample}/image.png`, undefined, "sample-not-found");
  await h.ok("POST", `/api/builds/${own.json.id}/close`, {});
});
probe("DELETE /api/builds/:id/samples/:sid", (h) => missBuild("DELETE", `/samples/${A.buildSample}`)(h));
probe("GET /api/builds/:id/samples/:sid/image.png", async (h) => {
  await h.miss("GET", bp(`/samples/${A.buildSample}/image.png`), undefined, "build-not-found");
  for (const f of escapes(path.join(orgRoot(env.t, env.b), "tasarim-oturumlari"), A.files.buildSample)) await h.rejected("GET", bp(`/samples/${f}/image.png`));
});
probe("POST /api/builds/:id/skip-samples", missBuild("POST", "/skip-samples", {}));
probe("POST /api/builds/:id/analyze", missBuild("POST", "/analyze", {}));
probe("POST /api/builds/:id/cancel", missBuild("POST", "/cancel", {}));
probe("POST /api/builds/:id/resume", missBuild("POST", "/resume", {}));
probe("POST /api/builds/:id/budget/raise", missBuild("POST", "/budget/raise", {}));
probe("GET /api/builds/:id/stream", missBuild("GET", "/stream"));
probe("GET /api/builds/:id/revisions", missBuild("GET", "/revisions"));
probe("GET /api/builds/:id/revisions/:rev", missBuild("GET", "/revisions/1"));
probe("GET /api/builds/:id/diff", missBuild("GET", "/diff?from=0&to=1"));
probe("GET /api/builds/:id/revisions/:rev/showcase", missBuild("GET", "/revisions/1/showcase"));
probe("GET /api/builds/:id/revisions/:rev/showcase/:item", missBuild("GET", "/revisions/1/showcase/p-tr-wedding-0"));
probe("POST /api/builds/:id/try", missBuild("POST", "/try", { text: "Ele geçir", mode: "engine" }));
probe("POST /api/builds/:id/restore", missBuild("POST", "/restore", { rev: 0 }));
probe("POST /api/builds/:id/publish", missBuild("POST", "/publish", {}));
probe("GET /api/builds/:id/quality", missBuild("GET", "/quality"));
probe("POST /api/builds/:id/quality/ai", missBuild("POST", "/quality/ai", { confirm: true }));
probe("POST /api/builds/:id/close", missBuild("POST", "/close", {}));

// ---------------------------------------------------------------- takım

/** Kayıtlı uçlar: (yöntem, yol); GET'in otomatik HEAD kopyası ayrı uç sayılmaz. */
function registeredRoutes(): { keys: string[]; autoHead: string[] } {
  const list = log.routes.get(env.t.app) ?? [];
  const all = new Set(list.map((r) => `${r.method} ${r.url}`));
  const autoHead = [...all].filter((k) => k.startsWith("HEAD ") && all.has(`GET ${k.slice(5)}`));
  return { keys: [...all].filter((k) => !autoHead.includes(k)).sort(), autoHead };
}

describe.each([1, 2] as const)("A4 iki firmalı izolasyon (dosya düzeni %i)", (layout) => {
  beforeAll(async () => {
    env = await makeTwoOrgs(log, { layout });
    A = await seedA(env);
    B = await seedB(env);
    await env.settle();
    // Düzen 1'de B'nin kökü A'nınkinin içinde, düzen 2'de kardeş.
    expect(path.relative(orgRoot(env.t, env.a), orgRoot(env.t, env.b)).startsWith("..")).toBe(layout === 2);
  }, 60_000);

  afterAll(async () => {
    await env?.settle();
    await env?.t.close();
  });

  it("bütün kayıtlı uçlar ya denenir ya da gerekçesiyle muaf; tabloda olup kaydı kalkan uç yok", () => {
    expect(env.t.ctx.tenancy.mode).toBe(process.env.TAGPRESS_TENANCY?.trim() === "audit" ? "audit" : "strict");
    const { keys, autoHead } = registeredRoutes();
    expect(keys.length).toBeGreaterThan(100);
    const covered = new Set([...Object.keys(PROBES), ...Object.keys(EXEMPT)]);
    expect(keys.filter((k) => !covered.has(k)), "denenmeyen yeni uç (PROBES'a ekle ya da EXEMPT'e gerekçesiyle yaz)").toEqual([]);
    expect([...covered].filter((k) => !keys.includes(k)), "tabloda olup kayıtlı olmayan uç").toEqual([]);
    expect(Object.keys(PROBES).filter((k) => k in EXEMPT)).toEqual([]);
    // Özellik tablosu (B2) aynı kayıtla: her uç `features/route-map.ts`'te, tabloda olup kaydı olmayan uç yok.
    expect(keys.filter((k) => !(k in ROUTE_FEATURES)), "özellik tablosunda olmayan uç (features/route-map.ts)").toEqual([]);
    expect(Object.keys(ROUTE_FEATURES).filter((k) => !keys.includes(k)), "özellik tablosunda olup kayıtlı olmayan uç").toEqual([]);
    // Fastify HEAD kopyası açıyorsa her GET için açar.
    if (autoHead.length) expect(autoHead.length).toBe(keys.filter((k) => k.startsWith("GET ")).length);
  });

  describe("B, A'nın verisine ulaşamaz ve A'yı değiştiremez", () => {
    for (const [key, p] of Object.entries(PROBES)) {
      it(key, async () => {
        const h = new Harness(env, A, B);
        if (p.custom) await p.run(h);
        else await h.isolated(() => p.run(h), { install: p.install === true });
        expect([...h.hits], "deneme kendi ucuna B olarak ulaşmalı").toContain(key);
      });
    }
  });

  it("statik arayüz işleyicisi: yol kaçışıyla A'nın dosyaları ve veritabanı sunulmaz", async () => {
    const h = new Harness(env, A, B);
    await h.isolated(async () => {
      const root = orgRoot(env.t, env.a);
      const targets = [...Object.values(A.files).map((f) => path.join(root, f)), path.join(env.t.dir, "studio.db"), path.join(env.t.dir, "ana-anahtar.json")];
      for (const file of targets) {
        for (const p of escapes(path.join(env.t.dir, "web-yok"), file, "")) {
          for (const url of [`/${p}`, `/assets/${p}`, `/${p.replace(/%2F/gi, "/")}`]) {
            const r = await h.req("GET", url);
            expect(r.status === 404 || r.body === WEB_INDEX, `${url} → ${r.status}`).toBe(true);
          }
        }
      }
    });
  });

  it("denetim kipinde hiçbir kapsam dışı erişim sayılmadı", () => {
    expect(env.t.ctx.tenancy.audit.list()).toEqual([]);
  });
});
