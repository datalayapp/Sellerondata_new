import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_ORIGIN, type TestAuthority, createTestAuthority } from "@sellerondata/auth-kit/testing";
import { AI_HEADERS, type AiAllowance } from "@tagpress/domain";
import type { FastifyInstance } from "fastify";
import { productionPorts } from "../adapters/index.ts";
import { buildApp } from "../app.ts";
import type { AppContext } from "../context.ts";
import { type OrgContext, runInOrg } from "../org/context.ts";
import { KEY_FILE_NAME, fileKeyProvider } from "../services/secret-box.ts";
import { SecretService } from "../services/secrets.ts";
import { type TestPgDb, createTestDb } from "../test/pg.ts";
import { ManualClock } from "../util/clock.ts";
import { HttpError } from "../util/errors.ts";

/**
 * Platform kipi + yapay zekâ geçidi (TP-AI, plan §S9) gerçek Postgres'le (`pnpm test:pg`): gerçek bağlantılar
 * (`productionPorts`), gerçek istemciler, sahte geçit (`fetch`). İstek geçidin adresine gider, anahtar başlığı = araç jetonu,
 * `X-SOD-*` firma ve üye bağlamından; `SecretService.get` hiç çağrılmaz (casus); aylık hak geçitten (oluşturucu bütçesi ve
 * ön denetim); `ai_calls` satırına üye ve geçit çağrı kimliği yazılır.
 */

const GW = "http://ai-gateway.test:4300";
const TOKEN = "tp-arac-jetonu";

type Captured = { url: string; headers: Record<string, string>; body: unknown };
const captured: Captured[] = [];
let allowanceState: AiAllowance["state"] = "ok";

const gatewayFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const h: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (h[k] = v));
  const u = String(url);
  captured.push({ url: u, headers: h, body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  if (u.startsWith(`${GW}/internal/allowance`)) {
    return json({
      period: "2026-11",
      resetsAt: "2026-12-01T00:00:00.000Z",
      capMicroUsd: 30_000_000,
      usedMicroUsd: 2_500_000,
      reservedMicroUsd: 0,
      remainingMicroUsd: 27_500_000,
      state: allowanceState,
      tool: { product: "tagpress", capMicroUsd: null, usedMicroUsd: 2_500_000 },
    } satisfies AiAllowance);
  }
  if (u.startsWith(`${GW}/internal/anthropic/v1/messages/count_tokens`)) return json({ input_tokens: 5000 }, { [AI_HEADERS.callId]: "gc-sayim" });
  return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "sahte geçitte yok" } }), { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let db: TestPgDb;
let su: pg.Client;
let authority: TestAuthority;
let dir: string;
let app: FastifyInstance;
let ctx: AppContext;
const getSpy = vi.spyOn(SecretService.prototype, "get");

beforeAll(async () => {
  db = await createTestDb({ template: false, migrate: true, orgs: false });
  su = new pg.Client({ connectionString: db.superUrl });
  await su.connect();
  authority = await createTestAuthority();
  dir = mkdtempSync(path.join(os.tmpdir(), "tagpress-ai-"));
  ({ app, ctx } = await buildApp({
    config: {
      auth: "platform",
      dataDir: dir,
      port: 4200,
      dev: true,
      webDist: path.join(dir, "web-yok"),
      platform: { jwksUrl: authority.jwksUrl, allowedOrigins: [TEST_ORIGIN], production: false, aiGateway: { url: GW, token: TOKEN } },
    },
    databaseUrl: db.appUrl,
    platform: { fetch: authority.fetch, purgeRetryEveryMs: 0 },
    clock: new ManualClock(),
    secretKeys: fileKeyProvider(path.join(dir, KEY_FILE_NAME), { protector: null }),
    legacyDpapi: null,
    startQueue: false,
    ports: productionPorts({ aiFetch: gatewayFetch, systemFallbacks: false }),
    aiGateway: { fetch: gatewayFetch },
  }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await su?.end();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  getSpy.mockRestore();
});

const who = { orgId: randomUUID(), membershipId: randomUUID() };
const bearer = async () =>
  authority.bearer(await authority.accessToken({ product: "tagpress", orgId: who.orgId, membershipId: who.membershipId, role: "ADMIN", epoch: 0, orgName: "Geçit Firma" }));
const org: OrgContext = { orgId: who.orgId, memberId: who.membershipId, permissions: "all", locale: "tr", source: "platform" };

async function call(method: "GET" | "POST", url: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: { ...(await bearer()), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> & { languages?: { id: string }[] }, body: res.body };
}

describe("platform kipi: yapay zekâ geçidi", () => {
  it("oluşturucu tahmini: count_tokens geçide gider (jeton, X-SOD-*, Authorization yok); anahtar okunmaz", async () => {
    const langs = await call("GET", "/api/tagpress/languages");
    expect(langs.status, langs.body).toBe(200);
    const languageId = langs.json.languages![0]!.id;
    captured.length = 0;
    const r = await call("POST", "/api/tagpress/builds/estimate", { languageId, samples: 0 });
    expect(r.status, r.body).toBe(200);
    expect(r.json.keySource).toBe("product");
    const count = captured.find((c) => c.url.startsWith(`${GW}/internal/anthropic/v1/messages/count_tokens`));
    expect(count, JSON.stringify(captured.map((c) => c.url))).toBeTruthy();
    expect(count!.headers["x-api-key"]).toBe(TOKEN);
    expect(count!.headers.authorization).toBeUndefined();
    expect(count!.headers).toMatchObject({
      [AI_HEADERS.org]: who.orgId,
      [AI_HEADERS.member]: who.membershipId,
      [AI_HEADERS.purpose]: "tagpress.builder_turn",
      [AI_HEADERS.origin]: "job",
    });
    expect(count!.headers[AI_HEADERS.requestId]).toBeTruthy();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("aylık hak geçitten: tahminde sınır ve harcama geçidin değeri; dolunca ön denetim 409 budget-exceeded, durunca ai-paused", async () => {
    allowanceState = "ok";
    await ctx.aiGateway!.refresh(who.orgId);
    const languageId = (await call("GET", "/api/tagpress/languages")).json.languages![0]!.id;
    const r = await call("POST", "/api/tagpress/builds/estimate", { languageId, samples: 0 });
    expect(r.json).toMatchObject({ monthLimitUsd: 30, monthUsd: 2.5 });
    expect(captured.some((c) => c.url === `${GW}/internal/allowance?orgId=${who.orgId}` && c.headers["x-api-key"] === TOKEN)).toBe(true);
    const guard = () => {
      try {
        runInOrg(org, () => ctx.keyGuard.require("anthropic", "gemini"));
        return null;
      } catch (e) {
        return e instanceof HttpError ? e.code : String(e);
      }
    };
    expect(guard()).toBeNull();
    allowanceState = "capped";
    await ctx.aiGateway!.refresh(who.orgId);
    expect(guard()).toBe("budget-exceeded");
    allowanceState = "paused";
    await ctx.aiGateway!.refresh(who.orgId);
    expect(guard()).toBe("ai-paused");
    allowanceState = "ok";
    await ctx.aiGateway!.refresh(who.orgId);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("ai_calls satırına üye ve geçit çağrı kimliği yazılır; ayarlar görünümünde anahtar uyarısı yok", async () => {
    runInOrg(org, () =>
      ctx.costs.record(
        { purpose: "design", model: "claude-haiku-5-5", summary: "s", response: "", usage: { model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 100, gatewayCallId: "gc-1" }, durationMs: 5 },
        {},
      ),
    );
    const row = (await su.query(`SELECT member_id, gateway_call_id, cost_usd FROM tagpress.ai_calls WHERE org_id = $1`, [who.orgId])).rows[0];
    expect(row).toEqual({ member_id: who.membershipId, gateway_call_id: "gc-1", cost_usd: (1000 * 0.1 + 100 * 0.5) / 1e6 });
    const s = await call("GET", "/api/tagpress/settings");
    expect(s.status, s.body).toBe(200);
    expect(s.json.warnings).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
