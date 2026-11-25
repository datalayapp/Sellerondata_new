import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, type TestAuthority, createTestAuthority } from "@sellerondata/auth-kit/testing";
import type { PlatformEvent } from "@sellerondata/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { type BuildOptions, buildApp } from "../app.ts";
import type { AppContext } from "../context.ts";
import { isOrgOpen, runInOrg } from "../org/context.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../services/secret-box.ts";
import { type ApiJson, fullPorts, png } from "../test/helpers.ts";
import { type TestPgDb, createTestDb } from "../test/pg.ts";
import { ManualClock } from "../util/clock.ts";

/**
 * R1 (bağımsız yetki/izolasyon incelemesi) bulgularının kalıcı testleri, platform kipi, gerçek Postgres (`pnpm test:pg`):
 * 1. Harcama izni (`spend` = `tagpress.ai.use` + `tagpress.work.edit`) uç kapısından bağımsız: içe aktarma ve elle iş
 *    `generate: true` izinsiz 403, kuyruğa görev girmez; oturum sınırını artırmak `spend`.
 * 2. Yeniden açılışta durumu okunmamış firma kapalı sayılır: kapalı firmanın bekleyen görevi `queued` kalır, açık firmanınki
 *    çalışır; firma geri açılınca görev sürer.
 * 3. SSE akışı üye çıkarılınca, firma kapanınca ve jeton bitince kapanır (gerçek port).
 * 4–6. Görsellerde `private` önbellek (yerel test: `generation.test.ts`), yedek font adresleri dış yolla, harcama tutarları
 *    yalnız Yöneticiye.
 */

const USER_PERMS = ["tagpress.web.access", "tagpress.work.edit"];

type Who = { orgId: string; membershipId: string; role?: string; perms?: string[]; epoch?: number; expiresInSeconds?: number };
const member = (orgId = randomUUID(), role = "ADMIN", perms?: string[]): Who => ({ orgId, membershipId: randomUUID(), role, ...(perms ? { perms } : {}) });

let authority: TestAuthority;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  authority = await createTestAuthority();
});

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

/** Platform kipinde uygulama (kendi veritabanı ve veri klasörüyle). */
async function platformApp(opts: Partial<BuildOptions> = {}): Promise<{ app: FastifyInstance; ctx: AppContext; db: TestPgDb; su: pg.Client; dir: string }> {
  const db = await createTestDb({ template: false, migrate: true, orgs: false });
  const su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  const dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-r1-"));
  const { app, ctx } = await buildApp({
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
    ...opts,
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close().catch(() => undefined);
    await su.end().catch(() => undefined);
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, ctx, db, su, dir };
}

const token = (w: Who) =>
  authority.accessToken({
    product: "tagpress",
    orgId: w.orgId,
    membershipId: w.membershipId,
    role: w.role ?? "ADMIN",
    epoch: w.epoch ?? 0,
    orgName: "R1 Firma",
    ...(w.perms ? { perms: w.perms } : {}),
    ...(w.expiresInSeconds ? { expiresInSeconds: w.expiresInSeconds } : {}),
  });

type Res = { status: number; json: ApiJson; body: string; headers: Record<string, unknown> };
async function call(app: FastifyInstance, method: InjectOptions["method"], url: string, who: Who, body?: unknown): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: { ...authority.bearer(await token(who)), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function postEvent(app: FastifyInstance, ctx: AppContext, event: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/tagpress/internal/events",
    payload: { token: await authority.eventToken({ eventId: randomUUID(), product: "tagpress", ...event } as unknown as PlatformEvent) },
  });
  await ctx.platformOrgs!.settle();
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { ok: boolean; outcome: string };
}

const genTasks = async (su: pg.Client, orgId: string) => Number((await su.query(`SELECT count(*)::int AS n FROM tagpress.gen_tasks WHERE org_id = $1`, [orgId])).rows[0].n);
const jobCount = async (su: pg.Client, orgId: string) => Number((await su.query(`SELECT count(*)::int AS n FROM tagpress.jobs WHERE org_id = $1`, [orgId])).rows[0].n);

/** Firmayı açar (ilk istek) ve varsayılan dile `a1` şablonunu ekler; dil kimliği. */
async function prepareOrg(app: FastifyInstance, ctx: AppContext, who: Who): Promise<string> {
  expect((await call(app, "GET", "/api/tagpress/org", who)).status).toBe(200);
  return runInOrg(who.orgId, async () => {
    const lang = ctx.languages.list()[0]!;
    const d = ctx.paths.templates(lang.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "a1.png"), await png(40, 40));
    await ctx.templates.sync(lang.id);
    return lang.id;
  });
}

// ---------------------------------------------------------------- 1. harcama izni

describe("R1-1: harcama izni (spend = ai.use + work.edit)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let su: pg.Client;
  beforeAll(async () => {
    ({ app, ctx, su } = await platformApp());
  }, 120_000);

  it("ai.use yok: elle iş ve içe aktarma generate:true → 403 FORBIDDEN, iş ve görev yazılmaz; ai.use ile görev 1", async () => {
    const orgId = randomUUID();
    const noAi = member(orgId, "USER", USER_PERMS);
    const lang = await prepareOrg(app, ctx, noAi);
    const org = await call(app, "GET", "/api/tagpress/org", noAi);
    expect(org.json.access).toEqual({ edit: true, spend: false, manage: false });

    const manual = { languageId: lang, text: "Ayşe & Mehmet", templateKey: "a1", quantity: 1, generate: true };
    const jobsBefore = await jobCount(su, orgId);
    const r = await call(app, "POST", "/api/tagpress/jobs/manual", noAi, manual);
    expect(r.status, r.body).toBe(403);
    expect(r.json.error.code).toBe("FORBIDDEN");
    expect(r.json.error.details.missing).toEqual(["tagpress.ai.use"]);
    expect(await genTasks(su, orgId)).toBe(0);
    expect(await jobCount(su, orgId)).toBe(jobsBefore);
    // Üretimsiz elle iş yazma izniyle açılır.
    expect((await call(app, "POST", "/api/tagpress/jobs/manual", noAi, { ...manual, generate: false })).status).toBe(200);
    expect(await genTasks(su, orgId)).toBe(0);

    const records = [{ siparis: "1", etiket: "a1", adet: 1, text: "Anna Marco" }];
    const prev = await call(app, "POST", "/api/tagpress/import/preview", noAi, { fileName: "siparis.json", content: JSON.stringify(records), languageId: lang });
    expect(prev.status, prev.body).toBe(200);
    const commitBody = { fileName: "siparis.json", languageId: lang, mapping: prev.json.mapping, rows: prev.json.rows, generate: true };
    const jobsMid = await jobCount(su, orgId);
    const commit = await call(app, "POST", "/api/tagpress/import/commit", noAi, commitBody);
    expect(commit.status, commit.body).toBe(403);
    expect(commit.json.error.code).toBe("FORBIDDEN");
    expect(await genTasks(su, orgId)).toBe(0);
    expect(await jobCount(su, orgId)).toBe(jobsMid);

    // Aynı firmada ai.use olan üye: görev kuyruğa girer.
    const withAi = member(orgId, "USER", [...USER_PERMS, "tagpress.ai.use"]);
    expect((await call(app, "GET", "/api/tagpress/org", withAi)).json.access).toEqual({ edit: true, spend: true, manage: false });
    const ok = await call(app, "POST", "/api/tagpress/jobs/manual", withAi, manual);
    expect(ok.status, ok.body).toBe(200);
    expect(await genTasks(su, orgId)).toBe(1);
    const okCommit = await call(app, "POST", "/api/tagpress/import/commit", withAi, commitBody);
    expect(okCommit.status, okCommit.body).toBe(200);
    expect(okCommit.json.queued).toHaveLength(1);
    expect(await genTasks(su, orgId)).toBe(2);
    await ctx.queue.idle();
  }, 120_000);

  it("ai.use var ama work.edit yok: harcama uçları 403 (spend iki izni ister)", async () => {
    const who = member(randomUUID(), "USER", ["tagpress.web.access", "tagpress.ai.use"]);
    expect((await call(app, "GET", "/api/tagpress/org", who)).json.access).toEqual({ edit: false, spend: false, manage: false });
    const r = await call(app, "POST", "/api/tagpress/generate", who, { jobIds: ["x"], mode: "text" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("FORBIDDEN");
    expect(r.json.error.details.missing).toEqual(["tagpress.work.edit"]);
  });

  it("oturum sınırını artırmak spend: ai.use olmadan 403", async () => {
    const who = member(randomUUID(), "USER", USER_PERMS);
    const r = await call(app, "POST", `/api/tagpress/builds/${randomUUID()}/budget/raise`, who, {});
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("FORBIDDEN");
    // İzinli üyede kapı geçer (oturum yok: 404).
    const ok = await call(app, "POST", `/api/tagpress/builds/${randomUUID()}/budget/raise`, member(), {});
    expect(ok.status).not.toBe(403);
  });

  it("servis düzeyi: bağlamda ai.use yoksa üretim ve şablon görevi kuyruğa girmez", async () => {
    const orgId = randomUUID();
    const lang = await prepareOrg(app, ctx, member(orgId));
    const ctxNoAi = { orgId, memberId: randomUUID(), permissions: USER_PERMS, locale: "tr" as const, source: "platform" as const };
    runInOrg(ctxNoAi, () => {
      expect(() => ctx.generation.enqueue({ jobIds: ["x"], mode: "text" })).toThrow(/İzin yok/);
      expect(() => ctx.templateTasks.enqueue(lang, { theme: "deniz" })).toThrow(/İzin yok/);
    });
    expect(await genTasks(su, orgId)).toBe(0);
  });

  // ---------------------------------------------------------------- 6. harcama tutarları

  it("harcama tutarları yalnız Yöneticiye: costs ve çağrı ayrıntısı 403, iş günlüğünde tutar null", async () => {
    const orgId = randomUUID();
    const admin = member(orgId, "ADMIN");
    const user = member(orgId, "USER");
    const lang = await prepareOrg(app, ctx, admin);
    const made = await call(app, "POST", "/api/tagpress/jobs/manual", admin, { languageId: lang, text: "Anna Marco", templateKey: "a1", quantity: 1, generate: true });
    expect(made.status, made.body).toBe(200);
    await ctx.queue.idle();
    const jobId = made.json.id as string;

    const costsUser = await call(app, "GET", "/api/tagpress/costs", user);
    expect(costsUser.status).toBe(403);
    expect(costsUser.json.error.code).toBe("FORBIDDEN");
    const costsAdmin = await call(app, "GET", "/api/tagpress/costs", admin);
    expect(costsAdmin.status, costsAdmin.body).toBe(200);
    expect(costsAdmin.json.totalUsd).toBeGreaterThan(0);

    const logAdmin = await call(app, "GET", `/api/tagpress/jobs/${jobId}/log`, admin);
    expect(logAdmin.status).toBe(200);
    expect(logAdmin.json.aiCalls.length).toBeGreaterThan(0);
    expect(logAdmin.json.aiCalls.some((c: { costUsd: number | null }) => typeof c.costUsd === "number" && c.costUsd > 0)).toBe(true);
    const logUser = await call(app, "GET", `/api/tagpress/jobs/${jobId}/log`, user);
    expect(logUser.status).toBe(200);
    expect(logUser.json.aiCalls).toHaveLength(logAdmin.json.aiCalls.length);
    for (const c of logUser.json.aiCalls) expect(c.costUsd).toBeNull();

    const callId = logAdmin.json.aiCalls[0].id as string;
    expect((await call(app, "GET", `/api/tagpress/ai-calls/${callId}`, admin)).status).toBe(200);
    const callUser = await call(app, "GET", `/api/tagpress/ai-calls/${callId}`, user);
    expect(callUser.status).toBe(403);
    expect(callUser.json.error.code).toBe("FORBIDDEN");

    const variantId = (await call(app, "GET", `/api/tagpress/jobs/${jobId}`, admin)).json.variants[0].id as string;
    expect((await call(app, "GET", `/api/tagpress/variants/${variantId}`, admin)).json.snapshot.costUsd).toBeGreaterThan(0);
    expect((await call(app, "GET", `/api/tagpress/variants/${variantId}`, user)).json.snapshot.costUsd).toBeNull();

    // 4. Kimlik isteyen görsel paylaşılan önbelleğe girmez.
    const preview = await call(app, "GET", `/api/tagpress/variants/${variantId}/preview.png`, user);
    expect(preview.status).toBe(200);
    expect(String(preview.headers["cache-control"])).toContain("private");
    expect(String(preview.headers["cache-control"])).not.toContain("public");
  }, 120_000);

  // ---------------------------------------------------------------- 5. yedek fontlar

  it("yedek fontlar: liste ve CSS'teki adresler /api/tagpress/ önekli, önbellek private, adres çalışır", async () => {
    const who = member(randomUUID(), "USER");
    const list = await call(app, "GET", "/api/tagpress/fallback-fonts", who);
    expect(list.status).toBe(200);
    expect(list.json.css).toBe("/api/tagpress/fallback-fonts.css");
    for (const f of list.json.fonts) expect(f.url).toMatch(/^\/api\/tagpress\/fallback-fonts\/[^/]+\?v=[0-9a-f]{16}$/);
    const css = await call(app, "GET", "/api/tagpress/fallback-fonts.css", who);
    expect(css.status).toBe(200);
    expect(css.body).toMatch(/src: url\("\/api\/tagpress\/fallback-fonts\/Twemoji\.ttf\?v=[0-9a-f]{16}"\)/);
    expect(css.body).not.toMatch(/url\("\/api\/fallback-fonts/);
    expect(String(css.headers["cache-control"])).toMatch(/^private/);
    const font = await call(app, "GET", list.json.fonts[0].url as string, who);
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/ttf");
    expect(String(font.headers["cache-control"])).toMatch(/^private/);
  });
});

// ---------------------------------------------------------------- 2. yeniden açılış

describe("R1-2: yeniden açılışta kapalı firmanın bekleyen görevi", () => {
  it("açılışta kapalı firmanın görevi queued kalır, açık firmanınki çalışır; firma açılınca görev sürer", async () => {
    // Önce veritabanı: iki firma (biri kapalı) ve ikisinin bekleyen görevi; sonra uygulama açılır (kuyruk başlar). Süreç
    // bu firmaları hiç görmedi (yeniden açılış).
    const closed = randomUUID();
    const open = randomUUID();
    const prepared = await createTestDb({ template: false, migrate: true, orgs: false });
    const pre = new pg.Client({ connectionString: prepared.superUrl });
    await pre.connect();
    await pre.query(`INSERT INTO tagpress."Company"("id","name","closedAt","closedVersion") VALUES ($1,'Kapalı', now(), 1), ($2,'Açık', NULL, NULL)`, [closed, open]);
    for (const org of [closed, open]) {
      await pre.query(`INSERT INTO tagpress.gen_tasks(id, job_id, mode, params, status, created_at, org_id) VALUES ($1, 'yok', 'text', '{}', 'queued', '2026-01-01T00:00:00Z', $2)`, [randomUUID(), org]);
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-r1-acilis-"));
    const { app, ctx } = await buildApp({
      config: {
        auth: "platform",
        dataDir: dir,
        port: 4200,
        dev: true,
        webDist: path.join(dir, "web-yok"),
        platform: { jwksUrl: authority.jwksUrl, allowedOrigins: [TEST_ORIGIN], production: false, aiGateway: null },
      },
      databaseUrl: prepared.appUrl,
      platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
      clock: new ManualClock(),
      secretKeys: fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
      legacyDpapi: null,
      startQueue: true,
      ports: fullPorts(),
    });
    cleanups.push(async () => {
      await app.close().catch(() => undefined);
      await pre.end().catch(() => undefined);
      await prepared.drop();
      rmSync(dir, { recursive: true, force: true });
    });
    await app.ready();
    const state = async (org: string) => (await pre.query(`SELECT status, attempts::int AS attempts FROM tagpress.gen_tasks WHERE org_id = $1`, [org])).rows[0] as { status: string; attempts: number };
    const settled = async (org: string) => {
      for (let i = 0; i < 100 && ["queued", "running"].includes((await state(org)).status); i++) await new Promise((r) => setTimeout(r, 50));
    };
    // `queue.idle()` beklenmez: kapalı firmanın görevi sırada kaldıkça kuyruk boşalmaz (beklenen).
    await settled(open);
    await new Promise((r) => setTimeout(r, 300));
    expect(await state(closed)).toEqual({ status: "queued", attempts: 0 });
    const ran = await state(open);
    expect(ran.status).not.toBe("queued");
    expect(Number(ran.attempts)).toBe(1);
    expect(isOrgOpen(closed)).toBe(false);
    expect(isOrgOpen(open)).toBe(true);

    // Firma geri açılınca (olay) kapı tazelenir ve kuyruk dürtülür: görev sürer.
    await postEvent(app, ctx, { type: "org.reopened", orgId: closed, version: 2 });
    await settled(closed);
    expect((await state(closed)).status).not.toBe("queued");
    expect(Number((await state(closed)).attempts)).toBe(1);
    await ctx.queue.idle();
  }, 120_000);
});

// ---------------------------------------------------------------- 3. SSE

describe("R1-3: SSE akışı kimliği aşmaz (gerçek port)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let base: string;
  beforeAll(async () => {
    ({ app, ctx } = await platformApp());
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 120_000);

  /** Akışı açar; ilk satır gelince döner. `ended`: sunucu akışı kapatınca çözülür. */
  async function openStream(url: string, who: Who): Promise<{ status: number; ended: Promise<number>; close: () => void }> {
    const tok = await token(who);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const req = http.get(`${base}${url}`, { headers: authority.bearer(tok) }, (res) => {
        const ended = new Promise<number>((done) => {
          res.on("end", () => done(Date.now() - started));
          res.on("close", () => done(Date.now() - started));
        });
        res.once("data", () => resolve({ status: res.statusCode ?? 0, ended, close: () => req.destroy() }));
        res.on("error", () => undefined);
      });
      req.on("error", reject);
    });
  }

  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"zaman-aşımı">((r) => setTimeout(() => r("zaman-aşımı"), ms))]);

  it("member.removed sonrası üyenin akışı birkaç saniyede biter; aynı firmadaki başka üyeninki sürer", async () => {
    const orgId = randomUUID();
    const a = member(orgId, "USER");
    const b = member(orgId, "USER");
    const sa = await openStream("/api/tagpress/events", a);
    const sb = await openStream("/api/tagpress/events", b);
    expect(sa.status).toBe(200);
    expect(ctx.liveStreams.size).toBeGreaterThanOrEqual(2);
    await postEvent(app, ctx, { type: "member.removed", orgId, membershipId: a.membershipId, epoch: 5 });
    expect(await within(sa.ended, 5000)).not.toBe("zaman-aşımı");
    expect(await within(sb.ended, 300)).toBe("zaman-aşımı");
    sb.close();
  }, 60_000);

  it("org.closed sonrası firmanın bütün akışları biter", async () => {
    const orgId = randomUUID();
    const s1 = await openStream("/api/tagpress/events", member(orgId, "USER"));
    const s2 = await openStream("/api/tagpress/events", member(orgId, "ADMIN"));
    const other = await openStream("/api/tagpress/events", member(randomUUID(), "USER"));
    await postEvent(app, ctx, { type: "org.closed", orgId, closedAt: new Date().toISOString(), purgeAfter: new Date(Date.now() + 86_400_000).toISOString(), version: 3 });
    expect(await within(s1.ended, 5000)).not.toBe("zaman-aşımı");
    expect(await within(s2.ended, 5000)).not.toBe("zaman-aşımı");
    expect(await within(other.ended, 300)).toBe("zaman-aşımı");
    other.close();
  }, 60_000);

  it("jeton bitince akış kapanır (istemci yeniden bağlanıp kimlik denetiminden geçer)", async () => {
    const who = { ...member(randomUUID(), "USER"), expiresInSeconds: 2 };
    const s = await openStream("/api/tagpress/events", who);
    expect(s.status).toBe(200);
    const took = await within(s.ended, 6000);
    expect(took).not.toBe("zaman-aşımı");
    expect(took as number).toBeGreaterThanOrEqual(1000);
  }, 60_000);
});
