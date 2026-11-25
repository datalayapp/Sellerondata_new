import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { createJwksClient } from '@sellerondata/auth-kit';
import {
  ACCESS_TTL_SECONDS,
  COOKIE_ACCESS,
  CSRF_HEADER,
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  STEP_UP_HEADER,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from '@sellerondata/contracts';
import { buildApp, type BuildAppOptions } from '../src/app.ts';
import { getPrisma } from '../src/db.ts';
import { TEST_JWKS_URL, TEST_ORIGIN, TEST_SUPER_DB_URL } from './testEnv.ts';

// ---------- Sahte Hesap: JWKS ve jetonlar ----------

type KeyEntry = { kid: string; privateKey: CryptoKey; publicJwk: JWK };

async function newKey(kid: string): Promise<KeyEntry> {
  const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALG, { crv: 'Ed25519', extractable: true });
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: TOKEN_ALG, use: 'sig' } };
}

export type AccessInput = {
  personId?: string;
  sessionId?: string;
  /** Oturum ailesi (`fid`). Verilmezse jetonda yok (eski jeton). */
  familyId?: string;
  name?: string;
  op?: unknown;
  orgId?: string | null;
  orgRole?: string | null;
  expiresInSeconds?: number;
  audience?: string;
  issuer?: string;
  foreignKey?: boolean;
};

export type StepUpInput = {
  personId?: string;
  sessionId?: string;
  /** Oturum ailesi (`fid`). Verilmezse jetonda yok (eski jeton). */
  familyId?: string;
  op?: unknown;
  ttlSeconds?: number;
  iatOffsetSeconds?: number;
  audience?: string;
  foreignKey?: boolean;
};

export const OPERATOR = { personId: 'person-op', sessionId: 'session-op', name: 'Platform Sahibi' } as const;

export async function createTestAccount() {
  const active = await newKey('test-1');
  const foreign = await newKey('foreign');
  let offline = false;
  const fetchJwks = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== TEST_JWKS_URL) throw new Error(`beklenmeyen JWKS adresi ${url}`);
    if (offline) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ keys: [active.publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const sign = (claims: Record<string, unknown>, opts: { aud: string; iss?: string; sub: string; iat: number; exp: number; foreign?: boolean }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: TOKEN_ALG, kid: active.kid, typ: 'JWT' })
      .setIssuer(opts.iss ?? TOKEN_ISSUER)
      .setAudience(opts.aud)
      .setSubject(opts.sub)
      .setJti(randomUUID())
      .setIssuedAt(opts.iat)
      .setExpirationTime(opts.exp)
      .sign(opts.foreign ? foreign.privateKey : active.privateKey);

  return {
    jwks: () => createJwksClient({ url: TEST_JWKS_URL, fetch: fetchJwks }),
    setOffline: (v: boolean) => {
      offline = v;
    },
    async access(input: AccessInput = {}) {
      const now = Math.floor(Date.now() / 1000);
      const orgId = input.orgId === undefined ? 'org-a' : input.orgId;
      const claims: Record<string, unknown> = {
        sid: input.sessionId ?? OPERATOR.sessionId,
        name: input.name ?? OPERATOR.name,
        locale: 'tr',
        org: orgId,
        orgName: orgId ? 'Test Firma' : null,
        mid: orgId ? 'member-1' : null,
        orgRole: orgId ? (input.orgRole === undefined ? 'OWNER' : input.orgRole) : null,
        ep: 0,
        prod: {},
      };
      if (input.op !== undefined) claims.op = input.op;
      if (input.familyId !== undefined) claims.fid = input.familyId;
      return sign(claims, {
        aud: input.audience ?? TOKEN_AUDIENCE,
        iss: input.issuer,
        sub: input.personId ?? OPERATOR.personId,
        iat: now,
        exp: now + (input.expiresInSeconds ?? ACCESS_TTL_SECONDS),
        foreign: input.foreignKey,
      });
    },
    async stepUp(input: StepUpInput = {}) {
      const now = Math.floor(Date.now() / 1000) + (input.iatOffsetSeconds ?? 0);
      return sign(
        {
          sid: input.sessionId ?? OPERATOR.sessionId,
          ...(input.familyId !== undefined ? { fid: input.familyId } : {}),
          ...(input.op === undefined ? { op: true } : input.op === null ? {} : { op: input.op }),
        },
        {
          aud: input.audience ?? OPERATOR_STEP_UP_AUDIENCE,
          sub: input.personId ?? OPERATOR.personId,
          iat: now,
          exp: now + (input.ttlSeconds ?? OPERATOR_STEP_UP_TTL_SECONDS),
          foreign: input.foreignKey,
        },
      );
    },
  };
}

export type TestAccount = Awaited<ReturnType<typeof createTestAccount>>;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const stepUpHeader = (token: string) => ({ [STEP_UP_HEADER]: token });
export const cookie = (token: string, write = false) => ({
  cookie: `${COOKIE_ACCESS}=${token}`,
  ...(write ? { [CSRF_HEADER]: '1', origin: TEST_ORIGIN } : {}),
});

/** Yönetici + adım artırma başlıkları (Bearer). */
export async function operatorHeaders(account: TestAccount, extra: Partial<AccessInput> = {}) {
  return { ...bearer(await account.access({ op: true, ...extra })), ...stepUpHeader(await account.stepUp()) };
}

// ---------- Sahte sağlayıcı ----------

export type ProviderCall = { url: string; method: string; headers: Record<string, string> };

/**
 * Sahte sağlayıcı `fetch`'i. `status` sağlayıcı başına yanıt kodu; gövde bilerek gelen anahtarı yansıtır (sağlayıcının hata metni
 * anahtarı içerebilir: geçit bunu hiçbir yere yazmamalı).
 */
export function fakeProvider(status: { anthropic?: number | 'down'; gemini?: number | 'down' } = {}) {
  const calls: ProviderCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method: init?.method ?? 'GET', headers });
    const provider = url.startsWith('http://gemini.test') ? 'gemini' : 'anthropic';
    const s = status[provider] ?? 200;
    if (s === 'down') throw new TypeError(`fetch failed for key ${headers['x-api-key'] ?? headers['x-goog-api-key']}`);
    const echoed = headers['x-api-key'] ?? headers['x-goog-api-key'] ?? '';
    const body = s >= 200 && s < 300 ? { data: [{ id: 'model-x' }] } : { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${echoed}` } };
    return new Response(JSON.stringify(body), { status: s, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

// ---------- Günlük yakalayıcı ----------

export function logCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { stream, lines, text: () => lines.join('') };
}

// ---------- Uygulama ve veritabanı ----------

export async function makeApp(account: TestAccount, opts: Omit<BuildAppOptions, 'jwks' | 'prisma'> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ prisma: getPrisma(), jwks: account.jwks(), ...opts });
  await app.ready();
  return app;
}

let su: pg.Client | null = null;

/** Süper kullanıcı (test gözü; şemaya her şeyi yapar). */
export async function superClient(): Promise<pg.Client> {
  if (!su) {
    su = new pg.Client({ connectionString: TEST_SUPER_DB_URL });
    await su.connect();
  }
  return su;
}

export async function closeSuper() {
  await su?.end();
  su = null;
}

export async function resetKeys() {
  const c = await superClient();
  await c.query('TRUNCATE ai."ProviderKey", ai."AdminAudit"');
}

/** Gerçeğe benzer biçimli, koşu başına rastgele anahtar (Anthropic `sk-ant-…` biçimi günlük süzgecinin desenine girer). */
export function fakeKey(kind: 'anthropic' | 'gemini' | 'plain' = 'plain'): string {
  const r = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  if (kind === 'anthropic') return `sk-ant-api03-${r}`;
  if (kind === 'gemini') return `AIza${r.slice(0, 35)}`;
  return `test-saglayici-anahtari-${r}`;
}
