import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { JwksUnavailableError, UnknownKeyError, type JwksClient } from '@sellerondata/auth-kit';
import {
  COOKIE_ACCESS,
  CSRF_HEADER,
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  STEP_UP_HEADER,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type Locale,
  type OrgRole,
  stepUpMatchesSession,
} from '@sellerondata/contracts';
import { sendError } from '../errors.ts';

/**
 * Merkez uçlarının kimliği (`/api/ai/*`): Hesap erişim jetonu (Bearer ya da `sod_at` çerezi), Hesap'ın JWKS'iyle doğrulanır.
 * Geçit ürün değildir: `prod` iddiasına ve üye kaydına bakılmaz. Yetki üç katmandır:
 * - `authenticate`: geçerli erişim jetonu (yoksa `401 UNAUTHORIZED`, süresi dolmuşsa `401 TOKEN_EXPIRED`, anahtar doğrulanamıyorsa
 *   `503 AUTH_UNAVAILABLE`). Çerezli yazma `X-SOD-CSRF: 1` + izinli `Origin` ister (`403 CSRF_FAILED`).
 * - `requireOperator`: jetonda `op: true` (platform yöneticisi), yoksa `403 FORBIDDEN`.
 * - `requireStepUp`: `x-sod-step-up` başlığında Hesap'ın adım artırma jetonu (`aud: ai-admin`, ömür ≤ 5 dk, `op: true`, `sub` erişim
 *   jetonuyla aynı; oturum: iki jetonda `fid` varsa aynı aile, yoksa aynı `sid` — `stepUpMatchesSession`). Eksik, süresi dolmuş,
 *   başka kişinin ya da başka oturum ailesinin jetonu `403 STEP_UP_REQUIRED`. Geçit durumsuzdur: Hesap'ta çıkış ya da aile iptali
 *   burada görünmez; eski erişim + adım artırma jetonu çifti kendi süresi (≤ 5 dk) dolana kadar imzaca geçerli kalır.
 * Kancalar `onRequest`'te verilir (gövde ayrıştırılmadan önce): kimliksiz istek gövde hatasıyla alan adı öğrenemez.
 */

export type Principal = {
  personId: string;
  sessionId: string;
  /** Oturum ailesi (`AccessClaims.fid`); eski jetonda yok. */
  familyId: string | null;
  name: string;
  locale: Locale;
  orgId: string | null;
  orgName: string | null;
  membershipId: string | null;
  orgRole: OrgRole | null;
  /** Platform yöneticisi (`AccessClaims.op === true`). */
  operator: boolean;
};

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export type AuthHook = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/** Merkez uçlarının kancaları (rotada `onRequest` dizisi olarak, bu sırayla). */
export type PlatformAuth = { authenticate: AuthHook; requireOperator: AuthHook; requireStepUp: AuthHook };

export type PlatformAuthOptions = {
  jwks: JwksClient;
  allowedOrigins: () => ReadonlySet<string>;
  clockToleranceSeconds?: number;
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ORG_ROLES = new Set(['OWNER', 'ADMIN', 'MEMBER']);

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

type TokenSource = { kind: 'none' } | { kind: 'invalid' } | { kind: 'bearer'; token: string } | { kind: 'cookie'; token: string };

/** `Authorization` varsa yalnız ona bakılır; aynı adlı birden çok `sod_at` çerezi geçersiz (oturum sabitleme yolu). */
function extractToken(req: FastifyRequest): TokenSource {
  const header = req.headers.authorization;
  if (header !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m?.[1] ? { kind: 'bearer', token: m[1] } : { kind: 'invalid' };
  }
  const cookies = cookieValues(req.headers.cookie, COOKIE_ACCESS);
  if (cookies.length > 1) return { kind: 'invalid' };
  return cookies[0] ? { kind: 'cookie', token: cookies[0] } : { kind: 'none' };
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
}

export function createPlatformAuth(opts: PlatformAuthOptions): PlatformAuth {
  const clockTolerance = opts.clockToleranceSeconds ?? 5;

  async function verify(token: string, audience: string, required: string[]): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, opts.jwks.getKey, {
      issuer: TOKEN_ISSUER,
      audience,
      algorithms: [TOKEN_ALG],
      clockTolerance,
      requiredClaims: required,
    });
    return payload;
  }

  const authenticate: AuthHook = async (req, reply) => {
    if (req.principal) return;
    void reply.header('cache-control', 'no-store');
    const source = extractToken(req);
    if (source.kind === 'none' || source.kind === 'invalid') return sendError(req, reply, 401, 'UNAUTHORIZED');
    if (source.kind === 'cookie' && !SAFE_METHODS.has(req.method)) {
      const origin = headerValue(req, 'origin')?.replace(/\/$/, '').toLowerCase();
      if (headerValue(req, CSRF_HEADER) !== '1' || !origin || !opts.allowedOrigins().has(origin)) return sendError(req, reply, 403, 'CSRF_FAILED');
    }
    let p: JWTPayload;
    try {
      p = await verify(source.token, TOKEN_AUDIENCE, ['exp', 'iat', 'sub', 'sid']);
    } catch (err) {
      if (err instanceof JwksUnavailableError) {
        req.log.warn({ errName: err.name }, 'ai-api: Hesap anahtarı doğrulanamıyor');
        return sendError(req, reply, 503, 'AUTH_UNAVAILABLE');
      }
      if (err instanceof joseErrors.JWTExpired) return sendError(req, reply, 401, 'TOKEN_EXPIRED');
      if (!(err instanceof UnknownKeyError || err instanceof joseErrors.JOSEError)) req.log.warn({ errName: (err as Error).name }, 'ai-api: jeton doğrulama hatası');
      return sendError(req, reply, 401, 'UNAUTHORIZED');
    }
    const claims = p as Record<string, unknown>;
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || !claims.sub || !claims.sid) return sendError(req, reply, 401, 'UNAUTHORIZED');
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    req.principal = {
      personId: claims.sub,
      sessionId: claims.sid,
      familyId: str(claims.fid),
      name: typeof claims.name === 'string' ? claims.name : '',
      locale: claims.locale === 'en' ? 'en' : 'tr',
      orgId: str(claims.org),
      orgName: str(claims.orgName),
      membershipId: str(claims.mid),
      orgRole: typeof claims.orgRole === 'string' && ORG_ROLES.has(claims.orgRole) ? (claims.orgRole as OrgRole) : null,
      // Yalnız tam `true`: "true", 1 ya da nesne yönetici yapmaz.
      operator: claims.op === true,
    };
  };

  const requireOperator: AuthHook = async (req, reply) => {
    if (!req.principal) return sendError(req, reply, 401, 'UNAUTHORIZED');
    if (!req.principal.operator) return sendError(req, reply, 403, 'FORBIDDEN');
  };

  const requireStepUp: AuthHook = async (req, reply) => {
    const principal = req.principal;
    if (!principal?.operator) return sendError(req, reply, 403, 'FORBIDDEN');
    const raw = headerValue(req, STEP_UP_HEADER)?.trim();
    if (!raw || raw.length > 4096) return sendError(req, reply, 403, 'STEP_UP_REQUIRED');
    let p: JWTPayload;
    try {
      p = await verify(raw, OPERATOR_STEP_UP_AUDIENCE, ['exp', 'iat', 'sub', 'sid', 'jti']);
    } catch (err) {
      if (err instanceof JwksUnavailableError) return sendError(req, reply, 503, 'AUTH_UNAVAILABLE');
      return sendError(req, reply, 403, 'STEP_UP_REQUIRED');
    }
    const c = p as Record<string, unknown>;
    const lifetime = Number(p.exp) - Number(p.iat);
    const ok =
      c.op === true &&
      // Aynı kişi ve aynı oturum ailesi (iki jetonda `fid` varsa; yoksa aynı `sid`): oturum yenilemesi bağı koparmaz.
      stepUpMatchesSession(c, { sub: principal.personId, sid: principal.sessionId, fid: principal.familyId ?? undefined }) &&
      Number.isFinite(lifetime) &&
      lifetime > 0 &&
      lifetime <= OPERATOR_STEP_UP_TTL_SECONDS &&
      // İleri tarihli `iat`: saat payından fazlası kabul edilmez (ömür sınırı atlatılmasın).
      Number(p.iat) <= Math.floor(Date.now() / 1000) + clockTolerance;
    if (!ok) return sendError(req, reply, 403, 'STEP_UP_REQUIRED');
  };

  return { authenticate, requireOperator, requireStepUp };
}
