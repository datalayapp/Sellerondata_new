import type { FastifyInstance } from 'fastify';
import { errors as joseErrors, jwtVerify } from 'jose';
import { JwksUnavailableError, UnknownKeyError, type JwksClient } from '@sellerondata/auth-kit';
import {
  AI_LIMIT_SPEND_CAP_MONTHLY_USD,
  AI_SPEND_PATHS,
  SERVICE_EVENT_AUDIENCE,
  SERVICE_EVENT_TYPES,
  TOKEN_ALG,
  TOKEN_ISSUER,
  aiProductKeys,
  isOrgTimeZone,
  type ServiceEvent,
} from '@sellerondata/contracts';
import type { PrismaClient, Tx } from '../db.ts';
import { sendError } from '../errors.ts';
import { usdToMicro } from '../limits/usage.ts';
import { moveOrgDetailsToDaily } from '../maintenance/purge.ts';
import { ORG_ID_PATTERN } from '../spend/query.ts';

/**
 * Hesap hizmet olaylarının alıcısı: `POST /api/ai/internal/events` (gövde `{ token }`; gateway `internal` geçen yolu dışarıya 404 yapar).
 * Sözleşme `events.ts` (`ServiceEvent`, `ServiceEventClaims`). Ürün olay alıcısının (auth-kit `registerEventReceiver`) kuralları:
 * - Jeton Hesap'ın Ed25519 anahtarıyla (JWKS, erişim jetonuyla aynı küme), kitle `service-events`, `sub = 'ai'`, `jti = event.eventId`.
 *   Ürün olay jetonu (kitle `product-events`) burada geçmez. İmza hatası `401 INVALID_EVENT`, Hesap anahtarına ulaşılamazsa
 *   `503 AUTH_UNAVAILABLE` (dağıtıcı yeniden dener), biçim ya da hedef hatası `400 INVALID_EVENT`, tanınmayan tür `422
 *   UNKNOWN_EVENT_TYPE` (işaretlenmez: geçit güncellenince yeniden gelip işlenir).
 * - İdempotans: `ProcessedEvent` (eventId) aynı işlemde; yinelenen teslim `duplicate`, hiçbir şey yazmaz. Kimlikler bakımda 30 gün
 *   sonra silinir (`maintenance/index.ts`); sürüm koşulları eski olayı yine eler.
 * - Sıra: bir firmanın olayları firma kilidiyle (`ai:org-events:<orgId>`) sıralanır. Sürüm kuralı ürün olaylarıyla aynı:
 *   `org.updated` küçük sürümü uygulamaz (sürümsüz olay yalnız hiç sürümlü ad yazılmadıysa: `version = 0`); `org.closed` /
 *   `org.reopened` eşit ya da küçük sürümü uygulamaz (`stateVersion`); `subscription.updated` firma × araç başına küçük sürümü
 *   uygulamaz (`OrgProductCap.version`); `org.purged` her durumda uygulanır ve sonra gelen hiçbir olay firmayı yeniden kurmaz (`stale`).
 *
 * Yazılanlar (G3 tavanları bunlardan okur, `limits/usage.ts`):
 * - `Org.name`, `Org.timeZone` (`org.updated`; saat dilimi yalnız `TIME_ZONES` içindeyse, yoksa kayıtlı değer kalır), `Org.version`.
 * - `Org.closedAt`, `Org.stateVersion` (`org.closed` / `org.reopened`).
 * - `Org.purgedAt` + ad ve yöneticinin hak ezmesi silinir, firma × araç tavanları silinir; ayrıntılı defter satırları günlük özete
 *   taşınıp silinir (`maintenance/purge.ts`), hepsi aynı işlemde (`org.purged`).
 * - `OrgProductCap.capMicroUsd`, `version` (`subscription.updated.limits.aiSpendCapMonthlyUsd`: sayı → USD tavanı, `false` ya da 0 →
 *   0 (o araçta kapalı), başka değer ya da anahtar yok → null (kayıttaki varsayılan); `limits` alanı yoksa eski biçim: tavana
 *   dokunulmaz). Geçidi kullanmayan aracın olayı işaretlenir ama yazılmaz.
 */

export type EventOutcome = 'processed' | 'duplicate' | 'stale';

const SERVICE = 'ai';
const KNOWN = new Set<string>(SERVICE_EVENT_TYPES.ai);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIso = (v: unknown) => isStr(v) && Number.isFinite(Date.parse(v));

/** İmzalı olay da doğrulanır: eksik alan kuralları sessizce atlatmasın. Bilinmeyen tür yalnız kimlik alanlarıyla geçer (sonra 422). */
function shapeOk(e: unknown): e is ServiceEvent {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (!isStr(r.eventId) || !isStr(r.type)) return false;
  if (!KNOWN.has(r.type)) return true;
  if (!isStr(r.orgId) || !ORG_ID_PATTERN.test(r.orgId)) return false;
  switch (r.type) {
    case 'org.updated':
      return isStr(r.name) && (r.version === undefined || isVersion(r.version));
    case 'org.closed':
      return isIso(r.closedAt) && isIso(r.purgeAfter) && isVersion(r.version);
    case 'org.reopened':
      return isVersion(r.version);
    case 'org.purged':
      return true;
    case 'subscription.updated':
      return (
        isStr(r.product) &&
        isStr(r.status) &&
        isStr(r.plan) &&
        (r.version === undefined || isVersion(r.version)) &&
        (r.limits === undefined || (typeof r.limits === 'object' && r.limits !== null && !Array.isArray(r.limits)))
      );
    default:
      return false;
  }
}

/** `subscription.updated.limits` → firma × araç tavanı (mikro USD; null: kayıttaki varsayılan; 0: kapalı). */
export function toolCapFromLimits(limits: Record<string, unknown>): bigint | null {
  const v = limits[AI_LIMIT_SPEND_CAP_MONTHLY_USD];
  if (v === false) return 0n;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(usdToMicro(v));
  return null;
}

export const orgEventLock = (orgId: string) => `ai:org-events:${orgId}`;

async function apply(tx: Tx, event: ServiceEvent): Promise<EventOutcome> {
  const org = await tx.org.findUnique({ where: { id: event.orgId }, select: { version: true, stateVersion: true, purgedAt: true } });
  // Kalıcı silinmiş firmaya sonradan gelen olay yazılmaz (yeniden silme dışında: yarım kalan taşıma tamamlanır, zararsız).
  if (org?.purgedAt && event.type !== 'org.purged') return 'stale';
  switch (event.type) {
    case 'org.updated': {
      const stored = org?.version ?? 0;
      if (event.version === undefined ? stored > 0 : event.version < stored) return 'stale';
      const data = {
        name: event.name,
        ...(event.timeZone !== undefined && isOrgTimeZone(event.timeZone) ? { timeZone: event.timeZone } : {}),
        ...(event.version !== undefined ? { version: event.version } : {}),
      };
      await tx.org.upsert({ where: { id: event.orgId }, create: { id: event.orgId, ...data }, update: data });
      return 'processed';
    }
    case 'org.closed':
    case 'org.reopened': {
      if (org && event.version <= org.stateVersion) return 'stale';
      const closedAt = event.type === 'org.closed' ? new Date(event.closedAt) : null;
      const data = { closedAt, stateVersion: event.version };
      await tx.org.upsert({ where: { id: event.orgId }, create: { id: event.orgId, ...data }, update: data });
      return 'processed';
    }
    case 'org.purged': {
      const first = !org?.purgedAt;
      const purgedAt = org?.purgedAt ?? new Date();
      // Ad ve hakkı ezen yöneticinin adı silinir (firma kimliği özetlerde kalır; kişi ve ad hiç yok).
      const wipe = { purgedAt, name: null, capOverrideMicroUsd: null, capOverriddenBy: null, capOverriddenAt: null };
      await tx.org.upsert({ where: { id: event.orgId }, create: { id: event.orgId, ...wipe, closedAt: purgedAt }, update: wipe });
      await tx.orgProductCap.deleteMany({ where: { orgId: event.orgId } });
      // İlk silmede günlük özet ayrıntılı satırlardan yeniden hesaplanır (önceki toplamlar dahil), sonra satırlar silinir; tekrar
      // gelen silmede yalnız arada kapanmış satırlar özete eklenir (`moveOrgDetailsToDaily`).
      await moveOrgDetailsToDaily(tx, event.orgId, first ? 'recompute' : 'add');
      return 'processed';
    }
    case 'subscription.updated': {
      if (!(aiProductKeys() as string[]).includes(event.product)) return 'processed';
      const cur = await tx.orgProductCap.findUnique({ where: { orgId_product: { orgId: event.orgId, product: event.product } }, select: { version: true } });
      const stored = cur?.version ?? 0;
      if (event.version === undefined ? stored > 0 : event.version < stored) return 'stale';
      const cap = event.limits === undefined ? undefined : toolCapFromLimits(event.limits as Record<string, unknown>);
      const version = event.version ?? stored;
      await tx.orgProductCap.upsert({
        where: { orgId_product: { orgId: event.orgId, product: event.product } },
        create: { orgId: event.orgId, product: event.product, capMicroUsd: cap ?? null, version },
        update: { version, ...(cap !== undefined ? { capMicroUsd: cap } : {}) },
      });
      return 'processed';
    }
  }
}

export function eventRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; jwks: JwksClient }) {
  // Olay jetonu küçüktür. İmzasız hiçbir şey işlenmez.
  app.post(AI_SPEND_PATHS.events, { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const token = (req.body as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== 'string' || !token || token.length > 12_000) return sendError(req, reply, 400, 'INVALID_EVENT');

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, deps.jwks.getKey, {
        issuer: TOKEN_ISSUER,
        audience: SERVICE_EVENT_AUDIENCE,
        algorithms: [TOKEN_ALG],
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      }));
    } catch (err) {
      if (err instanceof JwksUnavailableError) return sendError(req, reply, 503, 'AUTH_UNAVAILABLE');
      if (err instanceof UnknownKeyError || err instanceof joseErrors.JOSEError) {
        req.log.warn({ errName: (err as Error).name }, 'ai-api: olay imzası reddedildi');
        return sendError(req, reply, 401, 'INVALID_EVENT');
      }
      throw err;
    }
    if (payload.sub !== SERVICE) return sendError(req, reply, 400, 'INVALID_EVENT');
    const event = payload.event;
    if (!shapeOk(event) || event.eventId !== payload.jti) return sendError(req, reply, 400, 'INVALID_EVENT');
    // Tanınmayan tür işaretlenmez ve işlem açılmaz.
    if (!KNOWN.has(event.type)) return sendError(req, reply, 422, 'UNKNOWN_EVENT_TYPE');

    const outcome = await deps.prisma.$transaction(async (tx): Promise<EventOutcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgEventLock(event.orgId)}, 0))`;
      const claimed = await tx.$executeRaw`INSERT INTO ai."ProcessedEvent" ("eventId") VALUES (${event.eventId}) ON CONFLICT DO NOTHING`;
      if (claimed === 0) return 'duplicate';
      return apply(tx, event);
    });
    req.log.info({ type: event.type, orgId: event.orgId, outcome }, 'hizmet olayı');
    return { ok: true, outcome };
  });
}
