import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createJwksClient } from '@sellerondata/auth-kit';
import {
  ACCESS_TTL_SECONDS,
  EVENT_AUDIENCE,
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  SERVICE_EVENT_AUDIENCE,
  STEP_UP_HEADER,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from '@sellerondata/contracts';
import { buildApp, type BuildAppOptions } from '../src/app.ts';
import { getPrisma } from '../src/db.ts';
import { uuidv7 } from '../src/ledger/ids.ts';
import { superClient } from './helpers.ts';
import { TEST_JWKS_URL } from './testEnv.ts';

/**
 * G4 testlerinin yardımcıları: sahte Hesap (erişim, adım artırma ve hizmet olayı jetonları tek anahtarla), defter satırı tohumu,
 * tablo sıfırlama, zip okuyucu (XLSX denetimi).
 */

export type Who = { personId?: string; sessionId?: string; name?: string; orgId?: string | null; orgRole?: string | null; mid?: string | null; op?: boolean };

export async function createG4Account() {
  const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALG, { crv: 'Ed25519', extractable: true });
  const foreign = await generateKeyPair(TOKEN_ALG, { crv: 'Ed25519', extractable: true });
  const kid = 'g4-test';
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: TOKEN_ALG, use: 'sig' };
  const fetchJwks = (async () =>
    new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const sign = (claims: Record<string, unknown>, aud: string, sub: string, ttl: number, opts: { foreign?: boolean; jti?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: TOKEN_ALG, kid, typ: 'JWT' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(aud)
      .setSubject(sub)
      .setJti(opts.jti ?? randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .sign(opts.foreign ? foreign.privateKey : privateKey);
  };
  return {
    jwks: () => createJwksClient({ url: TEST_JWKS_URL, fetch: fetchJwks }),
    async access(w: Who = {}) {
      const orgId = w.orgId === undefined ? 'org-a' : w.orgId;
      const claims: Record<string, unknown> = {
        sid: w.sessionId ?? 'sess-1',
        name: w.name ?? 'Deneme Kişi',
        locale: 'tr',
        org: orgId,
        orgName: orgId ? `Firma ${orgId}` : null,
        mid: orgId ? (w.mid ?? `mem-${orgId}`) : null,
        orgRole: orgId ? (w.orgRole === undefined ? 'OWNER' : w.orgRole) : null,
        ep: 0,
        prod: {},
      };
      if (w.op) claims.op = true;
      return sign(claims, TOKEN_AUDIENCE, w.personId ?? 'person-1', ACCESS_TTL_SECONDS);
    },
    async stepUp(w: { personId?: string; sessionId?: string } = {}) {
      return sign({ sid: w.sessionId ?? 'sess-1', op: true }, OPERATOR_STEP_UP_AUDIENCE, w.personId ?? 'person-1', OPERATOR_STEP_UP_TTL_SECONDS);
    },
    /** Hizmet olayı jetonu (Hesap dağıtıcısının biçimi). `aud`, `sub`, `jti`, `foreign` sınama için değiştirilebilir. */
    async serviceEvent(event: Record<string, unknown>, opts: { aud?: string; sub?: string; jti?: string; foreign?: boolean } = {}) {
      const ev = { eventId: randomUUID(), ...event };
      const token = await sign({ event: ev, occurredAt: new Date().toISOString() }, opts.aud ?? SERVICE_EVENT_AUDIENCE, opts.sub ?? 'ai', 300, {
        jti: opts.jti ?? (ev.eventId as string),
        foreign: opts.foreign,
      });
      return { token, eventId: ev.eventId as string };
    },
    PRODUCT_EVENT_AUDIENCE: EVENT_AUDIENCE,
  };
}

export type G4Account = Awaited<ReturnType<typeof createG4Account>>;

export async function makeG4App(account: G4Account, opts: Omit<BuildAppOptions, 'jwks' | 'prisma'> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ prisma: getPrisma(), jwks: account.jwks(), ...opts });
  await app.ready();
  return app;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
export const stepUp = (token: string) => ({ [STEP_UP_HEADER]: token });

/** G4'ün dokunduğu tabloları ve platform tavan satırını sıfırlar. */
export async function resetG4() {
  const c = await superClient();
  await c.query('TRUNCATE ai."AiCall", ai."AiSpendDaily", ai."Org", ai."OrgProductCap", ai."ProcessedEvent", ai."AdminAudit"');
  await c.query(
    `UPDATE ai."PlatformLimits" SET "dailyCapMicroUsd" = NULL, "monthlyCapMicroUsd" = NULL, "paused" = false, "pausedAt" = NULL, "pausedBy" = NULL WHERE "id" = 1`,
  );
}

export type SeedCall = {
  orgId: string;
  product?: 'deciship' | 'tagpress';
  purpose?: string;
  memberId?: string | null;
  model?: string;
  servedModel?: string | null;
  status?: 'pending' | 'ok' | 'failed' | 'cancelled' | 'rejected' | 'interrupted';
  costMicroUsd?: number;
  reservedMicroUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  outputImages?: number;
  startedAt: Date;
  keySource?: 'platform' | 'org';
};

const DEFAULT_PURPOSE = { deciship: 'deciship.invoice_pdf', tagpress: 'tagpress.design' } as const;
const DEFAULT_MODEL = { deciship: 'claude-sonnet-5-5', tagpress: 'claude-haiku-5-5' } as const;

export async function seedCalls(rows: SeedCall[]): Promise<string[]> {
  const prisma = getPrisma();
  const ids: string[] = [];
  await prisma.aiCall.createMany({
    data: rows.map((r) => {
      const product = r.product ?? 'deciship';
      const id = uuidv7(r.startedAt.getTime());
      ids.push(id);
      const status = r.status ?? 'ok';
      return {
        id,
        product,
        orgId: r.orgId,
        memberId: r.memberId === undefined ? 'mem-1' : r.memberId,
        purpose: r.purpose ?? DEFAULT_PURPOSE[product],
        origin: 'request',
        provider: (r.model ?? DEFAULT_MODEL[product]).startsWith('gemini') ? 'gemini' : 'anthropic',
        requestedModel: r.model ?? DEFAULT_MODEL[product],
        servedModel: r.servedModel === undefined ? (status === 'pending' ? null : (r.model ?? DEFAULT_MODEL[product])) : r.servedModel,
        inputTokens: r.inputTokens ?? 1000,
        outputTokens: r.outputTokens ?? 1000,
        cacheReadTokens: r.cacheReadTokens ?? 0,
        cacheWrite5mTokens: r.cacheWrite5mTokens ?? 0,
        outputImages: r.outputImages ?? 0,
        costMicroUsd: BigInt(r.costMicroUsd ?? 12_000),
        reservedMicroUsd: BigInt(status === 'pending' ? (r.reservedMicroUsd ?? 50_000) : 0),
        priceVersion: 'r100:test',
        status,
        keySource: r.keySource ?? 'platform',
        toolRequestId: randomUUID(),
        attempt: 0,
        startedAt: r.startedAt,
        finishedAt: status === 'pending' ? null : r.startedAt,
        durationMs: status === 'pending' ? null : 1200,
      };
    }),
  });
  return ids;
}

/** Bu UTC ayının `day`. günü, `hour`:`minute` (geçmiş bir an olsun diye bugünden ileri değil). */
export function thisMonth(day: number, hour = 10, minute = 0, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(day, now.getUTCDate()), hour, minute));
  return d.getTime() > now.getTime() ? new Date(now.getTime() - 60_000) : d;
}

/** Önceki UTC ayının `day`. günü (yerel saat dilimi denemeleri için; her zaman geçmiş). */
export function lastMonth(day: number, hour = 10, minute = 0, now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day, hour, minute));
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Zip arşivinin girdileri (merkezi dizinden; deflate ya da saklı). XLSX denetimi için. */
export function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip değil');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bozuk merkezi dizin');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
