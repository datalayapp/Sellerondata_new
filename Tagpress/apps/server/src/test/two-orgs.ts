import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InjectOptions } from "fastify";
import { expect } from "vitest";
import { localOrg, runInOrg } from "../org/context.ts";
import type { OrgResolver } from "../org/resolver.ts";
import { TENANT_TABLES } from "../org/tables.ts";
import type { Engine, FontCatalog, KeyTester } from "../ports.ts";
import type { GenTask } from "../services/generation/queue.ts";
import type { PrintPlanner, PrintRenderer } from "../services/print/ports.ts";
import { type ApiJson, TEST_PROFILE, type TestApp, fakeEngine, fullPorts, makeApp, png } from "./helpers.ts";
import { FakeBuilderModel, fake as fakeModel } from "@tagpress/ai/builder/testing";
import { samplePng } from "./builder.ts";

/**
 * İki firmalı izolasyon takımının (A4, `tenancy.test.ts`) kurulumu: A dolu, B'nin yalnız kendi küçük verisi var.
 * İsteğin firması `x-test-org` başlığından (yoksa varsayılan firma = A). Sahte portlar; AI çağrısı ve para yok.
 *
 * - `makeTwoOrgs()`: uygulama + iki firma + istek kısayolları.
 * - `seedA()` / `seedB()`: veriler (kimlikler `SeedA` / `SeedB`).
 * - `snapshotOrg()` / `diffSnapshots()`: bir firmanın bütün kiracı satırları, firma satırı, kurulum ayarları, dosya ağacı
 *   ve kuyruk durumu; önce/sonra karşılaştırması.
 * - `Harness`: B adına istek atar; her yanıtta A'nın kimliklerinin/işaretlerinin ya da A'ya özgü dosya baytlarının
 *   (istekte B'nin kendisinin göndermedikleri hariç) görünmediğini denetler.
 */

export const ORG_HEADER = "x-test-org";

/** A'nın bütün metin verisinde geçen işaretler: B'nin yanıtında görünmemeli. */
export const A_MARKERS = ["Alfagizli", "ALFA FIRMA", "ALFA-1001", "ALFA-1002", "ALFA-PROFIL", "ALFA-ONAYAR", "ALFA-REF", "ALFA-NOT", "ALFA-TASLAK", "ALFA-YAYIN"] as const;

export const headerResolver = (fallback: () => string): OrgResolver => ({
  resolve: (req) => localOrg(String(req.headers[ORG_HEADER] ?? fallback())),
});

type Method = InjectOptions["method"];
export type Res = { status: number; json: ApiJson; body: string; raw: Buffer; headers: Record<string, unknown> };

/** Rota kaydı ve isabetler (`tenancy.test.ts`'teki Fastify sarmalayıcısı doldurur). */
export interface RouteLog {
  routes: WeakMap<object, { method: string; url: string }[]>;
  hits: { key: string; org: string | null }[];
}

export interface TwoOrgs {
  t: TestApp;
  a: string;
  b: string;
  log: RouteLog;
  asA: (method: Method, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  asB: (method: Method, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  /** Bütün arka plan işleri (bütün firmalar) bitene kadar. */
  settle: () => Promise<void>;
  /** SSE için geçici dinleyici (rastgele port, 127.0.0.1); ilk çağrıda açılır, `t.close()` kapatır. */
  listen: () => Promise<number>;
  /** Üretim görevlerini bekleten çalıştırıcı (kuyruk denemesi); `release()` hepsini bırakır ve gerçeğini geri koyar. */
  blockQueue: () => { started: string[]; release: () => Promise<void> };
}

// ---------------------------------------------------------------- sahte portlar

/** Sipariş başına adet kadar öğe, şablon yuvalarına sırayla; yuva biterse yeni sayfa. */
const planner: PrintPlanner = {
  planLabelPages: ({ orders, template }) => {
    const items = orders.flatMap((o) => Array.from({ length: o.quantity }, () => ({ jobId: o.jobId, variantId: o.variantId })));
    const pages = [];
    for (let i = 0; i < items.length; i += template.slots.length) {
      pages.push({
        name: "sayfa",
        kind: "mixed" as const,
        copies: 1,
        items: items.slice(i, i + template.slots.length).map((it, k) => ({ ...it, slotId: template.slots[k]!.id, xMm: template.slots[k]!.cx, yMm: template.slots[k]!.cy, extra: false })),
        cellLabels: [],
      });
    }
    return pages;
  },
  planStickerPages: () => [],
};

const renderer: PrintRenderer = {
  renderPagePng: async ({ widthPx }) => png(widthPx ?? 30, 40, { r: 10, g: 200, b: 10, alpha: 1 }),
  renderPdf: async ({ pages, onPage }) => {
    pages.forEach((_, i) => onPage?.(i + 1, pages.length));
    return Buffer.from("%PDF-1.7 sahte");
  },
};

/** Sahte motor + hafif düzeltme yetenekleri (yazı katmanı, elle düzenleme): uçlar 501'de durmasın, kaydı arasın. */
function richEngine(): Engine {
  return {
    ...fakeEngine(),
    textLayerSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
    editLines: ({ layout }) => ({ edits: [], layout, issues: [], textEdited: false, linesChanged: false }),
  };
}

const fontCatalog: FontCatalog = {
  describe: async (file) => ({ family: path.basename(file, path.extname(file)), style: "Regular" }),
  specimen: async () => png(48, 16, { r: 1, g: 2, b: 3, alpha: 1 }),
};

const keyTester: KeyTester = async (_provider, _key) => ({ ok: true, message: "sahte", model: "sahte" });

/** Font imzası taşıyan sahte dosya (yükleme denetimi `\0\1\0\0` arar). */
export const fakeFont = (tag: string) => Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from(`sahte-font-${tag}`)]);

/** Derlenmiş arayüz yerine (statik işleyicinin yol kaçışı denemesi). */
export const WEB_INDEX = "<!doctype html><title>TagPress test</title>";

// ---------------------------------------------------------------- kurulum

/**
 * `layout`: dosya düzeni. 1 (bugün): A (varsayılan firma, eski kökün sahibi) veri klasörünün kökünde, B `firmalar/<b>`;
 * B'nin kökü A'nınkinin içinde. 2: ikisi de `firmalar/<id>` (kardeş klasörler).
 */
export async function makeTwoOrgs(log: RouteLog, opts: { layout?: 1 | 2 } = {}): Promise<TwoOrgs> {
  const t: TestApp = await makeApp({
    ports: fullPorts({ engine: richEngine(), printPlanner: planner, printRenderer: renderer, fontCatalog, keyTester }),
    startQueue: true,
    resolver: headerResolver(() => t.ctx.orgs.defaultOrgId()!),
    // Oluşturucu: her tur sahte modelle tek metin yanıtı (ücretsiz).
    builder: { model: () => new FakeBuilderModel([fakeModel.reply([fakeModel.text("ALFA-OZET Alfagizli")])]), transcriber: () => null },
    prepare: (dir) => {
      mkdirSync(path.join(dir, "web-yok", "assets"), { recursive: true });
      writeFileSync(path.join(dir, "web-yok", "index.html"), WEB_INDEX);
    },
  });
  const a = t.ctx.orgs.defaultOrgId()!;
  t.ctx.orgs.rename(a, "ALFA FIRMA");
  if (opts.layout === 2) {
    t.ctx.settings.setInstall("files.layout", 2);
    t.ctx.roots.reload();
  }
  const b = t.ctx.orgs.create({ name: "BETA FIRMA" }).id;
  const as = (org: string) => async (method: Method, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await t.app.inject({
      method,
      url,
      headers: { "x-studio": "1", [ORG_HEADER]: org, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let json: ApiJson = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, body: res.body, raw: res.rawPayload, headers: res.headers };
  };
  let port: number | null = null;
  return {
    t,
    a,
    b,
    log,
    asA: as(a),
    asB: as(b),
    settle: async () => {
      await t.ctx.queue.idle();
      await t.ctx.templateTasks.idle();
      await t.ctx.printExports.idle();
      await t.ctx.learning.running;
      await t.ctx.builder.idle();
    },
    listen: async () => {
      if (port !== null) return port;
      await t.app.listen({ port: 0, host: "127.0.0.1" });
      const addr = t.app.server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      return port;
    },
    blockQueue: () => {
      const started: string[] = [];
      const waiting: (() => void)[] = [];
      t.ctx.queue.setRunner(async (task: GenTask) => {
        started.push(task.jobId);
        await new Promise<void>((r) => waiting.push(r));
      });
      return {
        started,
        release: async () => {
          const gen = t.ctx.generation as unknown as { run(task: GenTask): Promise<void> };
          t.ctx.queue.setRunner((task) => gen.run(task));
          while (waiting.length) waiting.shift()!();
          await t.ctx.queue.idle();
        },
      };
    },
  };
}

/** PNG baytları base64 (yükleme gövdeleri). */
export const b64 = (buf: Buffer) => buf.toString("base64");

async function importAs(env: TwoOrgs, org: string, lang: string, records: unknown[], batchName: string) {
  const call = org === env.a ? env.asA : env.asB;
  const prev = await call("POST", "/api/import/preview", { fileName: "siparis.json", content: JSON.stringify(records), languageId: lang });
  expect(prev.status, prev.body).toBe(200);
  const commit = await call("POST", "/api/import/commit", { fileName: "siparis.json", mapping: prev.json.mapping, rows: prev.json.rows, languageId: lang, batchName });
  expect(commit.status, commit.body).toBe(200);
  return commit.json as { batchId: string; jobIds: string[] };
}

/** Dil + şablon PNG'leri (renk firmaya özgü: A'nın dosya baytları B'ninkilerle karışmasın). */
async function seedLanguageIn(env: TwoOrgs, org: string, id: string, name: string, color: { r: number; g: number; b: number }) {
  const { t } = env;
  return runInOrg(org, async () => {
    const lang = t.ctx.languages.createWithTrustedId({ name, id, profile: { ...TEST_PROFILE, name } });
    const dir = t.ctx.paths.templates(lang.id);
    mkdirSync(dir, { recursive: true });
    for (const [i, k] of ["a1", "a2"].entries()) writeFileSync(path.join(dir, `${k}.png`), await png(40 + i, 40, { ...color, alpha: 1 }));
    await t.ctx.templates.sync(lang.id);
    return lang.id;
  });
}

const GRID = { paper: { wMm: 210, hMm: 297 }, columns: 2, rows: 2, diameterMm: 37, center: true, sizeId: "3.8" };

export interface SeedA {
  lang: string;
  key: string;
  fontFile: string;
  batch: string;
  /** Onaylı, düzeltilmiş (adjust), baskı oturumunda. */
  job: string;
  variant: string;
  /** Görüntü modunda (yazı katmanı dosyası var). */
  imageJob: string;
  imageVariant: string;
  /** Kuyruk denemesi için (onaysız). */
  spareJob: string;
  undoToken: string;
  aiCall: string;
  printTemplate: string;
  preset: string;
  session: string;
  page: string;
  item: string;
  export: string;
  templateTask: string;
  reference: string;
  proposal: string;
  learnRun: string;
  learnPreview: { dir: string; file: string };
  trialPreview: string;
  designSession: string;
  /** Sitedeki oluşturucu oturumu: bir örnek, bir revizyon (tabana dönüşle). */
  build: string;
  buildSample: string;
  /** A'nın kökündeki dosyaların göreli yolları (yol kaçışı denemeleri). */
  files: { preview: string; textLayer: string; reference: string; template: string; font: string; export: string; buildSample: string };
  orderNo: string;
  text: string;
}

export async function seedA(env: TwoOrgs): Promise<SeedA> {
  const { t, a, asA } = env;
  const lang = await seedLanguageIn(env, a, "alfa-dili", "ALFA-DILI Alfagizli", { r: 200, g: 30, b: 30 });
  const fontFile = "AlfagizliFont.ttf";
  runInOrg(a, () => writeFileSync(path.join(t.ctx.paths.fonts(lang), fontFile), fakeFont("alfa")));

  // Profil: v1 (başlangıç) + v2 yayınlanmış + taslak (v3).
  const prof = (n: number) => ({ ...TEST_PROFILE, name: `ALFA-PROFIL ${n}`, lineBreaking: { maxLineChars: 20 + n, maxLines: 4 } });
  expect((await asA("PUT", `/api/languages/${lang}/profile/draft`, { data: prof(2), note: "ALFA-NOT" })).status).toBe(200);
  expect((await asA("POST", `/api/languages/${lang}/profile/publish`, { note: "ALFA-YAYIN" })).status).toBe(200);
  expect((await asA("PUT", `/api/languages/${lang}/profile/draft`, { data: prof(3), note: "ALFA-TASLAK" })).status).toBe(200);

  const orderNo = "ALFA-1001";
  const text = "Alfagizli Anna Marco";
  const { batchId, jobIds } = await importAs(
    env,
    a,
    lang,
    [
      { siparis: orderNo, etiket: "a1", adet: 2, text },
      { siparis: "ALFA-1002", etiket: "a2", adet: 1, text: "Alfagizli Bora Ece" },
      { siparis: "ALFA-1003", etiket: "a1", adet: 1, text: "Alfagizli Cem Naz" },
      { siparis: "ALFA-1004", etiket: "a1", adet: 1, text: "Alfagizli Deniz Su" },
    ],
    "ALFA-PARTI Alfagizli",
  );
  const [job, imageJob, deletedJob, spareJob] = jobIds as [string, string, string, string];
  expect((await asA("POST", "/api/generate", { jobIds: [job] })).json.queued).toEqual([job]);
  expect((await asA("POST", "/api/generate", { jobIds: [imageJob], mode: "image-on-template" })).json.queued).toEqual([imageJob]);
  await env.settle();
  const approved = (await asA("POST", "/api/jobs/approve-best", { ids: [job, imageJob] })).json;
  expect(approved.approved, JSON.stringify(approved)).toHaveLength(2);
  const variant = approved.approved.find((x: { jobId: string }) => x.jobId === job).variantId as string;
  const imageVariant = approved.approved.find((x: { jobId: string }) => x.jobId === imageJob).variantId as string;
  const adj = await asA("PUT", `/api/variants/${variant}/adjust`, { adjust: { dx: 3, dy: -2, scale: 1 } });
  expect(adj.status, adj.body).toBe(200);
  const undo = await asA("POST", "/api/jobs/delete", { ids: [deletedJob] });
  expect(undo.status, undo.body).toBe(200);
  const aiCall = t.raw.get("SELECT id FROM ai_calls WHERE org_id = ? ORDER BY created_at LIMIT 1", a)?.id as string;
  expect(aiCall).toBeTruthy();

  // Baskı: ızgara şablonu, ön ayar, oturum (sayfa + öğe), PNG çıktısı.
  const g = await asA("POST", "/api/print/templates/grid", { languageId: lang, name: "ALFA-SABLON Alfagizli", ...GRID });
  expect(g.status, g.body).toBe(200);
  const printTemplate = g.json.template.id as string;
  const pr = await asA("POST", "/api/print/presets", { languageId: lang, name: "ALFA-ONAYAR", grid: GRID, note: "Alfagizli" });
  expect(pr.status, pr.body).toBe(200);
  const s = await asA("POST", "/api/print/sessions", { languageId: lang, templateId: printTemplate, jobIds: [job], name: "ALFA-OTURUM Alfagizli" });
  expect(s.status, s.body).toBe(200);
  const session = s.json.session;
  const page = session.pages[0].id as string;
  const item = session.pages[0].items[0].id as string;
  const ex = await asA("POST", `/api/print/sessions/${session.id}/export`, { format: "png" });
  expect(ex.status, ex.body).toBe(202);
  await env.settle();
  expect((await asA("GET", `/api/print/exports/${ex.json.id}`)).json.status).toBe("done");

  // Şablon görevi (sahte görüntü üretici; para yok).
  const task = await asA("POST", `/api/languages/${lang}/templates/generate`, { theme: "ALFA-TEMA Alfagizli", key: "alfa-uretilen" });
  expect(task.status, task.body).toBe(200);
  await env.settle();

  // Referans + görseli, öğrenme önerisi, öğrenme koşusu (kayıt + önizleme dosyası), tasarım oturumu.
  const refFile = "alfagizli-ref.png";
  runInOrg(a, () => {
    const dir = t.ctx.paths.references(lang);
    mkdirSync(dir, { recursive: true });
  });
  writeFileSync(path.join(runInOrg(a, () => t.ctx.paths.references(lang)), refFile), await png(44, 44, { r: 210, g: 20, b: 90, alpha: 1 }));
  const line = { text: "Alfagizli Referans", family: "Great Vibes", style: "Regular", sizePx: 30, segments: [{ text: "Alfagizli Referans", family: "Great Vibes", style: "Regular", sizePx: 30 }], ink: { x: 100, y: 200, w: 240, h: 30 } };
  const ref = await asA("POST", "/api/references", {
    languageId: lang,
    source: "migrated",
    orderNo: "ALFA-REF",
    quantity: 1,
    templateKey: "a1",
    labelFramePx: 440,
    text: "Alfagizli Referans",
    user: [line],
    program: null,
    programMeta: null,
    image: `referanslar/${lang}/${refFile}`,
    split: "train",
  });
  expect(ref.status, ref.body).toBe(200);
  const proposal = await asA("POST", "/api/learn/proposals", { languageId: lang, title: "ALFA-ONERI Alfagizli", patch: [{ path: "lineBreaking.maxLines", to: 3 }] });
  expect(proposal.status, proposal.body).toBe(200);
  const learnRun = randomUUID();
  const now = t.clock.now().toISOString();
  t.raw.run(
    `INSERT INTO learn_runs (org_id, id, language_id, status, base, profile_version, step, done, total, message, started_at, finished_at, error, result)
     VALUES (?, ?, ?, 'done', 'published', 2, 'bitti', 1, 1, 'ALFA-KOSU Alfagizli', ?, ?, NULL, NULL)`,
    a,
    learnRun,
    lang,
    now,
    now,
  );
  const previews = runInOrg(a, () => t.ctx.paths.previews);
  const learnPreview = { dir: learnRun, file: "alfagizli-onizleme.png" };
  mkdirSync(path.join(previews, "ogrenme", learnRun), { recursive: true });
  writeFileSync(path.join(previews, "ogrenme", learnRun, learnPreview.file), await png(33, 33, { r: 240, g: 10, b: 200, alpha: 1 }));
  const trialPreview = randomUUID();
  mkdirSync(path.join(previews, "deneme"), { recursive: true });
  writeFileSync(path.join(previews, "deneme", `${trialPreview}.png`), await png(34, 34, { r: 250, g: 250, b: 10, alpha: 1 }));
  const ds = await asA("POST", `/api/languages/${lang}/design-session`, { title: "ALFA-TASARIM Alfagizli" });
  expect(ds.status, ds.body).toBe(200);
  expect((await asA("POST", `/api/languages/${lang}/design-session/entries`, { kind: "note", text: "Alfagizli not" })).status).toBe(200);

  // Sitedeki oluşturucu: oturum, yüklenen örnek, ilk tur (sahte model), revizyon 1 (tabana dönüş), örnek etiketler.
  const bc = await asA("POST", `/api/languages/${lang}/builds`, { base: "published", fromSetup: true, labelTypes: ["wedding"] });
  expect(bc.status, bc.body).toBe(201);
  const build = bc.json.id as string;
  const up = await asA("POST", `/api/builds/${build}/samples`, { files: [{ name: "ALFA-ORNEK Alfagizli.png", dataBase64: (await samplePng()).toString("base64") }] });
  expect(up.status, up.body).toBe(200);
  const buildSample = up.json.samples[0].id as string;
  expect((await asA("POST", `/api/builds/${build}/skip-samples`)).status).toBe(202);
  await t.ctx.builder.idle();
  expect((await asA("POST", `/api/builds/${build}/restore`, { rev: 0 })).status).toBe(200);
  expect((await asA("GET", `/api/builds/${build}/revisions/1/showcase`)).status).toBe(200);

  // Firma ayarı (org_settings `app`).
  expect((await asA("PATCH", "/api/settings", { variantsPerRun: 2 })).status).toBe(200);
  await env.settle();

  const vrow = t.raw.get("SELECT preview_file, image FROM variants WHERE id = ?", variant)!;
  const irow = t.raw.get("SELECT image FROM variants WHERE id = ?", imageVariant)!;
  const textLayer = JSON.parse(String(irow.image)).textLayerFile as string;
  const exportDir = path.join("baski", ex.json.id);
  const root = orgRoot(t, a);
  const exportFile = readdirSync(path.join(root, exportDir))[0]!;
  const seed: SeedA = {
    lang,
    key: "a1",
    fontFile,
    batch: batchId,
    job,
    variant,
    imageJob,
    imageVariant,
    spareJob,
    undoToken: undo.json.undoToken,
    aiCall,
    printTemplate,
    preset: pr.json.id,
    session: session.id,
    page,
    item,
    export: ex.json.id,
    templateTask: task.json.id,
    reference: ref.json.id,
    proposal: proposal.json.id,
    learnRun,
    learnPreview,
    trialPreview,
    designSession: ds.json.id,
    build,
    buildSample,
    files: {
      preview: path.join("onizleme", String(vrow.preview_file)).replace(/\\/g, "/"),
      textLayer: path.join("onizleme", textLayer).replace(/\\/g, "/"),
      reference: `referanslar/${lang}/${refFile}`,
      template: `diller/${lang}/sablonlar/a1.png`,
      font: `diller/${lang}/fontlar/${fontFile}`,
      buildSample: `tasarim-oturumlari/${build}/ornekler/${buildSample}.png`,
      export: `${exportDir.replace(/\\/g, "/")}/${exportFile}`,
    },
    orderNo,
    text,
  };
  for (const rel of Object.values(seed.files)) expect(existsSync(path.join(root, rel)), rel).toBe(true);
  return seed;
}

export interface SeedB {
  lang: string;
  job: string;
  variant: string;
  printTemplate: string;
  session: string;
  page: string;
  item: string;
}

/** B'nin kendi küçük verisi: dil, onaylı iş, baskı şablonu ve oturumu (gövdesinde A'nın kimliği taşınan istekler için). */
export async function seedB(env: TwoOrgs): Promise<SeedB> {
  const { b, asB } = env;
  const lang = await seedLanguageIn(env, b, "beta-dili", "BETA DILI", { r: 20, g: 40, b: 220 });
  const { jobIds } = await importAs(env, b, lang, [{ siparis: "BETA-1", etiket: "a1", adet: 1, text: "Beta Ece Can" }], "BETA PARTI");
  const job = jobIds[0]!;
  expect((await asB("POST", "/api/generate", { jobIds: [job] })).json.queued).toEqual([job]);
  await env.settle();
  const approved = (await asB("POST", "/api/jobs/approve-best", { ids: [job] })).json;
  expect(approved.approved).toHaveLength(1);
  const g = await asB("POST", "/api/print/templates/grid", { languageId: lang, name: "BETA SABLON", ...GRID });
  expect(g.status, g.body).toBe(200);
  const s = await asB("POST", "/api/print/sessions", { languageId: lang, templateId: g.json.template.id, jobIds: [job], name: "BETA OTURUM" });
  expect(s.status, s.body).toBe(200);
  return {
    lang,
    job,
    variant: approved.approved[0].variantId,
    printTemplate: g.json.template.id,
    session: s.json.session.id,
    page: s.json.session.pages[0].id,
    item: s.json.session.pages[0].items[0].id,
  };
}

// ---------------------------------------------------------------- durum özeti

export interface OrgSnapshot {
  tables: Record<string, string[]>;
  org: string;
  install: string[];
  files: Map<string, string>;
  queue: string;
}

const canon = (row: Record<string, unknown>): string =>
  JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? `hex:${Buffer.from(v).toString("hex")}` : typeof v === "bigint" ? String(v) : v));

/** Veri kökünün kurulum düzeyi ya da başka firmaya ait girdileri (dosya düzeni 1'de sahibin kökü = veri klasörü). */
const INSTALL_ENTRIES = new Set(["firmalar", "yedek", "web-yok", "ortak", "studio.db", "studio.db-wal", "studio.db-shm", "studio.db-journal"]);

export function orgRoot(t: TestApp, org: string): string {
  return t.ctx.roots.rootOf(org);
}

/** Dosya ağacı: göreli yol → sha1 (kökün kurulum girdileri hariç; kurulumun ortak klasörleri ayrıca `installFiles`). */
export function fileTree(root: string, skipInstall: boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (!rel && skipInstall && INSTALL_ENTRIES.has(name)) continue;
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else out.set(r, createHash("sha1").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(root, "");
  return out;
}

export function snapshotOrg(env: TwoOrgs, org: string): OrgSnapshot {
  const { t } = env;
  const tables: Record<string, string[]> = {};
  for (const table of TENANT_TABLES) tables[table] = t.raw.all(`SELECT * FROM ${table} WHERE org_id = ?`, org).map(canon).sort();
  const root = orgRoot(t, org);
  const files = fileTree(root, root === t.dir);
  // Kurulumun ortak font klasörü bütün firmaların: başka firma oraya yazamamalı.
  for (const [k, v] of fileTree(path.join(t.dir, "ortak"), false)) files.set(`<ortak>/${k}`, v);
  // Kurulum düzeyi yedek klasörü (düzen 1'de sahibin şablon yedekleri de burada): başka firma oraya yazamamalı.
  for (const [k, v] of fileTree(path.join(t.dir, "yedek"), false)) files.set(`<yedek>/${k}`, v);
  return {
    tables,
    org: canon(t.raw.get("SELECT * FROM orgs WHERE id = ?", org) ?? {}),
    install: t.raw.all("SELECT key, value FROM settings ORDER BY key").map(canon),
    files,
    queue: JSON.stringify(runInOrg(org, () => t.ctx.queue.status())),
  };
}

/** Farklar (boşsa aynı). `install: false`: kurulum ayarları karşılaştırılmaz (kurulum düzeyi anahtar uçları). */
export function diffSnapshots(before: OrgSnapshot, after: OrgSnapshot, opts: { install?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const table of Object.keys(before.tables)) {
    const x = before.tables[table]!;
    const y = after.tables[table]!;
    if (x.join("\n") === y.join("\n")) continue;
    const gone = x.filter((r) => !y.includes(r));
    const added = y.filter((r) => !x.includes(r));
    out.push(`${table}: -${gone.length} +${added.length} ${(added[0] ?? gone[0] ?? "").slice(0, 300)}`);
  }
  if (before.org !== after.org) out.push(`orgs: ${before.org} → ${after.org}`);
  if (opts.install !== false && before.install.join("\n") !== after.install.join("\n")) out.push(`settings (kurulum): ${after.install.filter((r) => !before.install.includes(r)).join(" | ").slice(0, 300)}`);
  for (const [k, v] of before.files) if (after.files.get(k) !== v) out.push(`dosya ${after.files.has(k) ? "değişti" : "silindi"}: ${k}`);
  for (const k of after.files.keys()) if (!before.files.has(k)) out.push(`dosya eklendi: ${k}`);
  if (before.queue !== after.queue) out.push(`kuyruk: ${before.queue} → ${after.queue}`);
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A'ya özgü işaretler: kayıtlarındaki bütün UUID'ler, `id`/`token` değerleri, dil kimlikleri, firma kimliği + metin işaretleri. */
export function secretTokens(env: TwoOrgs, snap: OrgSnapshot, org: string): Set<string> {
  const out = new Set<string>([org, ...A_MARKERS]);
  for (const rows of Object.values(snap.tables)) {
    for (const r of rows) {
      for (const m of r.match(UUID) ?? []) out.add(m.toLowerCase());
      const obj = JSON.parse(r) as Record<string, unknown>;
      for (const col of ["id", "token"]) if (typeof obj[col] === "string" && String(obj[col]).length >= 8) out.add(String(obj[col]));
    }
  }
  for (const r of env.t.raw.all("SELECT id FROM languages WHERE org_id = ?", org)) out.add(String(r.id));
  return out;
}

// ---------------------------------------------------------------- deneme düzeneği

export interface ProbeOptions {
  /** Düzenek A'nın durumunu karşılaştırmaz; deneme kendisi `h.isolated(...)` çağırır (A tarafında kurulum gerekenler). */
  custom?: boolean;
  /** Kurulum düzeyi ayar değişebilir (karar gereği kurulum düzeyindeki yapay zekâ anahtarları). */
  install?: boolean;
}

export class Harness {
  /** Bu denemede B'nin isteklerinin eşleştiği rotalar. */
  readonly hits = new Set<string>();
  private tokens = new Set<string>();
  private secretFiles = new Set<string>();

  constructor(
    readonly env: TwoOrgs,
    readonly a: SeedA,
    readonly b: SeedB,
  ) {}

  /** A'nın şu anki durumundan işaret kümesini tazeler (deneme başında; A tarafında kurulum yapan denemeler sonra yeniden). */
  refresh(snap: OrgSnapshot): void {
    this.tokens = secretTokens(this.env, snap, this.env.a);
    const bFiles = new Set(fileTree(orgRoot(this.env.t, this.env.b), false).values());
    this.secretFiles = new Set([...snap.files.values()].filter((h) => !bFiles.has(h)));
  }

  /** `fn` boyunca A'nın durumu (kayıtlar, dosyalar, kuyruk) değişmez. `settle: false`: arka plan işleri beklenmez. */
  async isolated(fn: () => Promise<void>, opts: { install?: boolean; settle?: boolean } = {}): Promise<void> {
    if (opts.settle !== false) await this.env.settle();
    const before = snapshotOrg(this.env, this.env.a);
    this.refresh(before);
    await fn();
    if (opts.settle !== false) await this.env.settle();
    const after = snapshotOrg(this.env, this.env.a);
    expect(diffSnapshots(before, after, { install: opts.install !== true }), "A'nın verisi değişti").toEqual([]);
  }

  /** B adına istek + sızıntı denetimi (B'nin kendi gönderdiği değerler hariç). */
  async req(method: Method, url: string, body?: unknown, headers?: Record<string, string>): Promise<Res> {
    const before = this.env.log.hits.length;
    const res = await this.env.asB(method, url, body, headers);
    for (const h of this.env.log.hits.slice(before)) if (h.org === this.env.b) this.hits.add(h.key);
    this.checkLeak(`${method} ${url}`, res, `${safeDecode(url)}\n${body === undefined ? "" : JSON.stringify(body)}`);
    return res;
  }

  checkLeak(what: string, res: Pick<Res, "body" | "raw" | "headers">, sent: string): void {
    const hay = `${res.body}\n${JSON.stringify(res.headers)}`.toLowerCase();
    const sentLower = sent.toLowerCase();
    const leaked = [...this.tokens].filter((tok) => hay.includes(tok.toLowerCase()) && !sentLower.includes(tok.toLowerCase()));
    expect(leaked, `${what}: yanıtta A'nın işaretleri`).toEqual([]);
    if (res.raw.length) expect(this.secretFiles.has(createHash("sha1").update(res.raw).digest("hex")), `${what}: yanıt A'nın dosyası`).toBe(false);
  }

  /**
   * B'nin isteği "bulunamadı" ile döner (`code` verilirse o kod; durum o kodun durumu, varsayılan 404). GET ise HEAD de
   * aynı durumla döner (Fastify'ın otomatik HEAD kopyası).
   */
  async miss(method: Method, url: string, body?: unknown, code?: string, status = 404): Promise<Res> {
    const res = await this.req(method, url, body);
    expect(res.status, `${method} ${url} → ${res.body.slice(0, 300)}`).toBe(status);
    if (code) expect(res.json?.code, `${method} ${url}`).toBe(code);
    if (method === "GET") {
      const head = await this.req("HEAD", url);
      expect(head.status, `HEAD ${url}`).toBe(status);
    }
    return res;
  }

  /** B'nin isteği başarılı (200 ya da `status`) döner. */
  async ok(method: Method, url: string, body?: unknown, status = 200): Promise<Res> {
    const res = await this.req(method, url, body);
    expect(res.status, `${method} ${url} → ${res.body.slice(0, 300)}`).toBe(status);
    return res;
  }

  /** B'nin isteği reddedilir (4xx, 200 değil). */
  async rejected(method: Method, url: string, body?: unknown, code?: string): Promise<Res> {
    const res = await this.req(method, url, body);
    expect(res.status >= 400 && res.status < 500, `${method} ${url} → ${res.status} ${res.body.slice(0, 300)}`).toBe(true);
    if (code) expect(res.json?.code, `${method} ${url}`).toBe(code);
    return res;
  }
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}
