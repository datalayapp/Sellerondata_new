import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from "node:sqlite";
import { FEATURE_KEYS, type DesignIntent, type FeatureExplicit, type LayoutResult, type ProfileInput, type TemplateGeometry } from "@tagpress/domain";
import type { FastifyInstance, InjectOptions } from "fastify";
import sharp from "sharp";
import { buildApp, type BuildOptions } from "../app.ts";
import type { AppContext } from "../context.ts";
import { SyncPgBridge } from "../db/pg/bridge.ts";
import { toPg, toPgScript } from "../db/pg/dialect.ts";
import { PgStatement } from "../db/pg/pg-tenant-db.ts";
import { maintenance, maybeOrg, runInOrg } from "../org/context.ts";
import type { AiCallRecord, Designer, Engine, GeometryProvider, ImageGenerator, Ports } from "../ports.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../services/secret-box.ts";
import { ManualClock } from "../util/clock.ts";
import { type TestPgDb, createTestDb, pgTestMode, testDbHandle } from "./pg.ts";

/**
 * Test isteğinin çözülmüş JSON gövdesi (çözülemezse `null`). Bilerek serbest tip: yanıtın biçimini her testin beklentileri
 * (`expect`) denetler; yüzlerce yanıt erişimine tek tek tip yazmak testi denetim değil tip töreni yapardı.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test HTTP yanıtı serbest JSON; biçimi beklentiler denetler
export type ApiJson = any;

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  clock: ManualClock;
  /** Kurulumun varsayılan firması (çözücü verilmediyse isteklerin firması). */
  org: string;
  /** Uygulamanın veritabanı: `sqlite` (yerel kip) ya da `pg` (`pnpm test:pg`; şablondan açılmış test veritabanı). */
  dialect: "sqlite" | "pg";
  /** Postgres test veritabanı (yalnız `pg`). */
  pg: TestPgDb | null;
  /**
   * `fn`'i firma bağlamında çalıştırır (servisler bağlamsız çağrılamaz): `org` verilmezse varsayılan firma. Zaten bir
   * firma bağlamındaysa ve `org` verilmediyse o bağlam korunur.
   */
  inOrg: <T>(fn: () => T, org?: string) => T;
  /**
   * Testin kendi denetimleri için ham erişim (bakım kapsamında, firma kapsamı yok): satır sayısı, kayıt bozma, kurulum
   * tablosu okuma. Servis kodu bunu kullanmaz. Postgres'te ayrı süper kullanıcı bağlantısı (RLS'yi aşar; SQL aynı
   * çeviriciden geçer, yalnız `?` parametreleri).
   */
  raw: {
    get: (sql: string, ...params: SQLInputValue[]) => Record<string, SQLOutputValue> | undefined;
    all: (sql: string, ...params: SQLInputValue[]) => Record<string, SQLOutputValue>[];
    run: (sql: string, ...params: SQLInputValue[]) => StatementResultingChanges;
    exec: (sql: string) => void;
  };
  /** `X-Studio: 1` ile istek (değiştiren isteklerde zorunlu). */
  api: (method: InjectOptions["method"], url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: ApiJson; body: string; headers: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/**
 * Sahibin göçle gelen özellik seçimi (göç 11 ile aynı): bütün özellikler açık (`by: 'migration'`). Testlerin çoğu
 * uygulamanın bütün yeteneklerini dener.
 */
export function ownerFeatures(at: string): FeatureExplicit {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, { on: true, by: "migration" as const, at }])) as FeatureExplicit;
}

/**
 * Test uygulaması. `features`: firmaların özellik seçimi. `"owner"` (varsayılan): varsayılan firmaya ve sonradan
 * `ctx.orgs.create` ile açılan her firmaya `ownerFeatures` yazılır (sahibin günlük kullanımı); `"registry"`: kayıt
 * varsayılanları (yeni firma, kurulum `pending`; özellik ve kurulum testleri).
 */
export async function makeApp(
  opts: Omit<BuildOptions, "config" | "databaseUrl"> & { dir?: string; prepare?: (dir: string) => void; features?: "owner" | "registry"; db?: "sqlite" | "pg" } = {},
): Promise<TestApp> {
  const dir = opts.dir ?? mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
  opts.prepare?.(dir);
  const clock = (opts.clock as ManualClock | undefined) ?? new ManualClock();
  // Veritabanı: `db` verilmezse koşunun seçimi (`pnpm test:pg` → Postgres, şablondan yeni veritabanı).
  const dialect = opts.db ?? (pgTestMode() ? "pg" : "sqlite");
  const pgdb = dialect === "pg" ? await testDatabaseFor(dir, !!opts.dir) : null;
  // Klasörü test veriyorsa (yeniden açılış testleri) veritabanı klasörle birlikte yaşar: kapanışta silinmez, aynı klasörle
  // açılan sonraki uygulama aynı veritabanını görür (SQLite'ta `studio.db` klasörde kalır). Koşu sonunda genel kurulum siler.
  const ownsDb = !opts.dir;
  let built: Awaited<ReturnType<typeof buildApp>>;
  try {
    built = await buildApp({
      ...opts,
      clock,
      databaseUrl: pgdb?.appUrl ?? null,
      // Ortamdaki TAGPRESS_SECRET_KEY testleri etkilemesin: ana anahtar test klasöründe; DPAPI yalnız açıkça verilince.
      // Ana anahtar dosyası test klasöründe ve sarılmadan (DPAPI her açılışta PowerShell çağırırdı; sarma ayrıca denenir).
      secretKeys: opts.secretKeys ?? fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
      legacyDpapi: opts.legacyDpapi ?? null,
      config: { dataDir: dir, port: 5420, dev: true, webDist: path.join(dir, "web-yok") },
    });
  } catch (err) {
    if (ownsDb) await pgdb?.drop();
    throw err;
  }
  const { app, ctx } = built;
  const api: TestApp["api"] = async (method, url, body, headers = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: { "x-studio": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let json: ApiJson = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, body: res.body, headers: res.headers };
  };
  const org = ctx.orgs.defaultOrgId()!;
  if ((opts.features ?? "owner") === "owner") {
    const enable = (id: string) => runInOrg(id, () => ctx.features.write(ownerFeatures(clock.now().toISOString())));
    for (const o of ctx.orgs.list()) if (!runInOrg(o.id, () => Object.keys(ctx.features.explicit()).length)) enable(o.id);
    const create = ctx.orgs.create.bind(ctx.orgs);
    ctx.orgs.create = (input, o) => {
      const rec = create(input, o);
      enable(rec.id);
      return rec;
    };
  }
  const inOrg: TestApp["inOrg"] = (fn, id) => (id === undefined && maybeOrg() ? fn() : runInOrg(id ?? org, fn));
  const m = ctx.tdb.maintenance;
  let rawBridge: SyncPgBridge | null = null;
  const rawPg = (sql: string) => {
    rawBridge ??= new SyncPgBridge({ connectionString: pgdb!.superUrl, searchPath: "tagpress, pg_temp", applicationName: "tagpress-test-raw" });
    return new PgStatement(rawBridge, sql, toPg(sql), () => ({ ctx: { org: "", scope: "" }, org: null }));
  };
  const raw: TestApp["raw"] = pgdb
    ? {
        get: (sql, ...p) => rawPg(sql).get(...p),
        all: (sql, ...p) => rawPg(sql).all(...p),
        run: (sql, ...p) => rawPg(sql).run(...p),
        exec: (sql) => {
          rawPg("SELECT 1");
          rawBridge!.exec(toPgScript(sql), { org: "", scope: "" });
        },
      }
    : {
        get: (sql, ...p) => maintenance(() => m.prepare(sql).get(...p) as Record<string, SQLOutputValue> | undefined, "test"),
        all: (sql, ...p) => maintenance(() => m.prepare(sql).all(...p) as Record<string, SQLOutputValue>[], "test"),
        run: (sql, ...p) => maintenance(() => m.prepare(sql).run(...p), "test"),
        exec: (sql) => maintenance(() => m.exec(sql), "test"),
      };
  return {
    app,
    ctx,
    dir,
    clock,
    org,
    dialect,
    pg: pgdb,
    inOrg,
    raw,
    api,
    close: async () => {
      try {
        await app.close();
      } finally {
        await rawBridge?.close();
        if (ownsDb) await pgdb?.drop();
        if (!opts.dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Klasörün Postgres test veritabanı. Veritabanının adı klasöre işaretlenir (SQLite'ta `studio.db` klasörde durur):
 * aynı klasörle yeniden açılan uygulama (`makeApp({ dir: t.dir })`, yeniden başlatma testleri) aynı veritabanını görür.
 */
const PG_MARK = ".tagpress-test-pgdb";
async function testDatabaseFor(dir: string, shared: boolean): Promise<TestPgDb> {
  const mark = path.join(dir, PG_MARK);
  if (shared && existsSync(mark)) return testDbHandle(readFileSync(mark, "utf8").trim());
  const db = await createTestDb();
  writeFileSync(mark, db.name);
  return db;
}

/**
 * Testin kendi ham SQL'inde JSON alanı yazma (`t.raw.run`): SQLite `json_set`, Postgres `jsonb_set`. `text`: metin
 * değeri veren SQL ifadesi (`?` ya da `'a1'`); `json`: JSON değişmezi.
 */
export function jsonSetSql(t: Pick<TestApp, "dialect">, column: string, sets: Record<string, { text: string } | { json: string }>): string {
  const entries = Object.entries(sets);
  if (t.dialect === "sqlite") {
    const args = entries.map(([k, v]) => `'$.${k}', ${"text" in v ? v.text : `json('${v.json.replaceAll("'", "''")}')`}`);
    return `json_set(${column}, ${args.join(", ")})`;
  }
  let expr = `${column}::jsonb`;
  for (const [k, v] of entries) expr = `jsonb_set(${expr}, '{${k}}', ${"text" in v ? `to_jsonb((${v.text})::text)` : `'${v.json.replaceAll("'", "''")}'::jsonb`})`;
  return `(${expr})::text`;
}

export async function png(w = 40, h = 40, color = { r: 200, g: 120, b: 80, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
}

/** Test profili: iki boyut, sticker sayfası, bir el yazısı fontu. */
export const TEST_PROFILE: ProfileInput = {
  name: "Deneme",
  fonts: { list: [{ id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", kind: "script", roles: ["primary", "secondary"], file: "GreatVibes.ttf" }] },
  lineBreaking: { maxLineChars: 20, maxLines: 4 },
  stickers: {
    enabled: true,
    detect: "empty-template",
    sheets: [
      { id: "istiridye", frameName: "İSTİRİDYE", productKeywords: ["istiridye", "oyster"], maxW: 200, maxH: 120, slotW: 220, slotH: 140 },
      { id: "normal", frameName: "STICKER", productKeywords: [], maxW: 200, maxH: 200, slotW: 220, slotH: 220 },
    ],
  },
};

/** Dil + şablon PNG'leri oluşturur (geçerli firma bağlamında; yoksa varsayılan firmada). */
export async function seedLanguage(t: TestApp, keys: string[] = ["a1", "a2", "a15"], profile: ProfileInput = TEST_PROFILE): Promise<string> {
  return t.inOrg(async () => {
    const lang = t.ctx.languages.createWithTrustedId({ name: "Deneme Dili", id: "deneme", profile });
    const dir = t.ctx.paths.templates(lang.id);
    mkdirSync(dir, { recursive: true });
    for (const [i, k] of keys.entries()) writeFileSync(path.join(dir, `${k}.png`), await png(40 + i, 40));
    await t.ctx.templates.sync(lang.id);
    return lang.id;
  });
}

// ---------------------------------------------------------------- sahte portlar

export function fakeGeometry(): GeometryProvider {
  const g = (key: string, imagePath: string): TemplateGeometry => ({
    key,
    framePx: 440,
    cut: { kind: "circle", cx: 220, cy: 220, r: 218 },
    free: { width: 1, height: 1, scale: 1, data: new Uint8Array(1) },
    decoration: { width: 1, height: 1, scale: 1, data: new Uint8Array(1) },
    rows: [],
    areaBounds: { x: 100, y: 100, w: 240, h: 240 },
    target: { x: 220, y: 220 },
    manualArea: false,
    background: { luminance: 0.9, dark: false },
    imagePath,
    templateBox: { x: 10, y: 10, w: 420, h: 420 },
  });
  return {
    forTemplate: async ({ template, imagePath }) => g(template.key, imagePath),
    forSticker: async ({ sheet }) => g(`sticker-${sheet.id}`, ""),
    overlay: async () => png(10, 10),
  };
}

export function fakeEngine(score = 85): Engine {
  return {
    layout: ({ intent }) => fakeLayout(intent, score),
    render: async () => png(20, 20),
  };
}

export function fakeLayout(intent: DesignIntent, score = 85): LayoutResult {
  const lines = intent.lines.map((l, i) => {
    const [family = "Great Vibes", style = "Regular"] = l.fontId.split("/");
    return {
      text: l.text,
      role: l.role,
      tier: l.tier,
      sizePx: 20,
      runs: [{ text: l.text, fontId: l.fontId, family, style, sizePx: 20, baselineShiftPx: 0, fallback: false, trackingEm: 0 }],
      baselineY: 200 + i * 30,
      x: 120,
      advance: 200,
      ink: { x: 120, y: 184 + i * 30, w: 200, h: 20 },
    };
  });
  return {
    ok: true,
    lines,
    basePx: 20,
    strokePx: 0.5,
    color: "#000000",
    ink: { x: 120, y: 184, w: 200, h: lines.length * 30 - 10 },
    fill: 0.9,
    score: { total: score, parts: {} },
    issues: [],
    notes: [],
    ms: 1,
  };
}

export const call = (purpose: string, inputTokens = 1000, outputTokens = 200): AiCallRecord => ({
  purpose,
  model: "claude-haiku-5-5",
  summary: `${purpose} özeti`,
  response: `{"ham":"${purpose}"}`,
  usage: { model: "claude-haiku-5-5", inputTokens, outputTokens },
  durationMs: 12,
});

/** Metni üç farklı şekilde böler (biri ilkinin aynısı: elenmeli). */
export function fakeDesigner(overrides: Partial<Designer> = {}): Designer & { requests: Parameters<Designer["design"]>[0][] } {
  const requests: Parameters<Designer["design"]>[0][] = [];
  return {
    requests,
    design: async (req) => {
      requests.push(req);
      const words = req.text.split(" ");
      const mid = Math.ceil(words.length / 2);
      const one: DesignIntent = { lines: [{ text: req.text, role: "other", tier: "primary", fontId: "Great Vibes/Regular" }], rationale: "tek satır" };
      const two: DesignIntent = {
        lines: [
          { text: words.slice(0, mid).join(" "), role: "name", tier: "primary", fontId: "Great Vibes/Regular" },
          ...(words.length > 1 ? [{ text: words.slice(mid).join(" "), role: "other" as const, tier: "secondary" as const, fontId: "Great Vibes/Regular" }] : []),
        ],
        rationale: "iki satır",
      };
      return { candidates: [one, two, one], model: "claude-haiku-5-5", promptVersion: "test-1", calls: [call("design")] };
    },
    pick: async () => ({ ranking: [1, 0], reason: "ikinci daha dengeli", calls: [call("pick", 500, 50)] }),
    ...overrides,
  };
}

export function fakeImageGenerator(over: Partial<{ readText: string | null; untouched: boolean }> = {}): ImageGenerator {
  return {
    onTemplate: async (req) => ({
      composite: await png(30, 30),
      textLayer: await png(30, 10, { r: 0, g: 0, b: 0, alpha: 0.5 }),
      textBox: { x: 100, y: 180, w: 240, h: 80 },
      readText: over.readText === undefined ? req.text : over.readText,
      templateUntouched: over.untouched ?? true,
      model: "gemini-3.1-flash-image",
      promptVersion: "img-1",
      calls: [{ ...call("image"), model: "gemini-3.1-flash-image", usage: { model: "gemini-3.1-flash-image", inputTokens: 0, outputTokens: 0, images: 1 } }],
    }),
    newTemplate: async (req) => ({ png: await png(req.width, req.height), model: "gemini-3.1-flash-image", prompt: req.theme, calls: [call("new-template")] }),
  };
}

export function fullPorts(over: Partial<Ports> = {}): Partial<Ports> {
  return { geometry: fakeGeometry(), engine: fakeEngine(), designer: fakeDesigner(), imageGenerator: fakeImageGenerator(), ...over };
}

/** İçe aktarma + commit kısayolu. */
export async function importJobs(t: TestApp, records: unknown[], extra: Record<string, unknown> = {}) {
  const prev = await t.api("POST", "/api/import/preview", { fileName: "siparis.json", content: JSON.stringify(records) });
  if (prev.status !== 200) throw new Error(prev.body);
  const commit = await t.api("POST", "/api/import/commit", { fileName: "siparis.json", mapping: prev.json.mapping, rows: prev.json.rows, ...extra });
  if (commit.status !== 200) throw new Error(commit.body);
  return { preview: prev.json, commit: commit.json };
}
