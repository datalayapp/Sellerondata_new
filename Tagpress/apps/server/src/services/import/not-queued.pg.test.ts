import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, type TestAuthority, createTestAuthority } from "@sellerondata/auth-kit/testing";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.ts";
import type { AppContext } from "../../context.ts";
import { runInOrg } from "../../org/context.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../secret-box.ts";
import { type ApiJson, fullPorts, png } from "../../test/helpers.ts";
import { type TestPgDb, createTestDb } from "../../test/pg.ts";
import { ManualClock } from "../../util/clock.ts";

/**
 * Para incelemesi R2b-2, platform kipi, gerçek Postgres (`pnpm test:pg`): yapay zekâ geçidi yokken (`ai-unavailable`; aynı
 * yol `ai-paused`, `budget-exceeded`) "içe aktar ve üret" ve "elle iş + üret" hata dönmez: işler açılır, kuyruğa görev
 * girmez, yanıtta neden (`notQueued`). Eskiden 409 dönüp işleri yazmış oluyordu (yeniden aktarımda çift iş).
 */

let authority: TestAuthority;
let db: TestPgDb;
let su: pg.Client;
let dir: string;
let app: FastifyInstance;
let ctx: AppContext;

beforeAll(async () => {
  authority = await createTestAuthority();
  db = await createTestDb({ template: false, migrate: true, orgs: false });
  su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-r2b-"));
  ({ app, ctx } = await buildApp({
    config: {
      auth: "platform",
      dataDir: dir,
      port: 4200,
      dev: true,
      webDist: path.join(dir, "web-yok"),
      platform: { jwksUrl: authority.jwksUrl, allowedOrigins: [TEST_ORIGIN], production: false, aiGateway: null },
    },
    databaseUrl: db.appUrl,
    platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
    clock: new ManualClock(),
    secretKeys: fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
    legacyDpapi: null,
    startQueue: false,
    ports: fullPorts(),
    // Sahte portlarla da ön denetim (KeyGuard) zorlanır: platformda geçit yok → `ai-unavailable`.
    enforceKeys: true,
  }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await su?.end().catch(() => undefined);
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const who = { orgId: randomUUID(), membershipId: randomUUID() };

async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: ApiJson; body: string }> {
  const token = await authority.accessToken({ product: "tagpress", orgId: who.orgId, membershipId: who.membershipId, role: "ADMIN", epoch: 0, orgName: "R2b Firma" });
  const res = await app.inject({ method, url, headers: { ...authority.bearer(token), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, json: res.json() as ApiJson, body: res.body };
}

const count = async (table: "jobs" | "gen_tasks") => Number((await su.query(`SELECT count(*)::int AS n FROM tagpress.${table} WHERE org_id = $1`, [who.orgId])).rows[0].n);

describe("platform kipi, geçit yok: içe aktar ve üret", () => {
  it("commit({ generate: true }) → 200, işler açılır, queued: [], notQueued ai-unavailable; görev yok. Elle iş de aynı", async () => {
    expect((await call("GET", "/api/tagpress/org")).status).toBe(200);
    const lang = await runInOrg(who.orgId, async () => {
      const l = ctx.languages.list()[0]!;
      const d = ctx.paths.templates(l.id);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "a1.png"), await png(40, 40));
      await ctx.templates.sync(l.id);
      return l.id;
    });
    const records = [
      { siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" },
      { siparis: "2", etiket: "a1", adet: 1, text: "Ayşe" },
    ];
    const prev = await call("POST", "/api/tagpress/import/preview", { fileName: "siparis.json", content: JSON.stringify(records), languageId: lang });
    expect(prev.status, prev.body).toBe(200);
    const commit = await call("POST", "/api/tagpress/import/commit", { fileName: "siparis.json", languageId: lang, mapping: prev.json.mapping, rows: prev.json.rows, generate: true });
    expect(commit.status, commit.body).toBe(200);
    expect(commit.json.created).toBeGreaterThan(0);
    expect(commit.json.queued).toEqual([]);
    expect(commit.json.notQueued).toMatchObject({ code: "ai-unavailable" });
    expect(commit.json.notQueued.message).toBeTruthy();
    expect(await count("jobs")).toBe(commit.json.created);
    expect(await count("gen_tasks")).toBe(0);

    const manual = await call("POST", "/api/tagpress/jobs/manual", { languageId: lang, text: "Mehmet", templateKey: "a1", quantity: 1, generate: true });
    expect(manual.status, manual.body).toBe(200);
    expect(manual.json.id).toBeTruthy();
    expect(await count("jobs")).toBe(commit.json.created + 1);
    expect(await count("gen_tasks")).toBe(0);
  }, 120_000);
});
