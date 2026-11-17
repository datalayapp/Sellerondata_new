import { errors as joseErrors, jwtVerify } from 'jose';
import type { FastifyInstance } from 'fastify';
import {
  EVENT_AUDIENCE,
  TOKEN_ALG,
  TOKEN_ISSUER,
  type PlatformEvent,
} from '@sellerondata/contracts';
import { createJwksClient, JwksUnavailableError, UnknownKeyError, type JwksClient } from './jwks.ts';
import { catalogPermissionsOf, effectivePermissions, resolveProductDefinition, sendAuthError, type ProductDefinitionSeam } from './productAuth.ts';

export type EventMeta = { occurredAt: string | null };

export type EventReceiverOptions<Tx> = {
  /** Kayıt anahtarı. Kayıtta olmayan anahtar yalnız `definition` ile ve yalnız `NODE_ENV=test` iken kabul edilir (`resolveProductDefinition`). */
  product: string;
  /** Yalnız test fikstürü. `NODE_ENV` `test` değilse açılış durur. */
  definition?: ProductDefinitionSeam;
  /** Varsayılan `/api/<ürün>/internal/events`. */
  path?: string;
  /** Verilmezse `registerProductAuth`un önbelleği, o da yoksa `jwksUrl` kullanılır. */
  jwks?: JwksClient;
  jwksUrl?: string;
  fetch?: typeof fetch;
  /**
   * Tüm adımlar aynı veritabanı işleminde çalışsın diye. `work` fırlatırsa geri alınmalı:
   * böylece işlenemeyen olay "işlendi" sayılmaz ve dağıtıcı yeniden dener.
   * Ör. `(work) => prisma.$transaction(work)`.
   */
  transaction: <R>(work: (tx: Tx) => Promise<R>) => Promise<R>;
  /**
   * İşlemin ilk adımı, olayın firmasıyla: `SELECT set_config('app.company_id', $1, true)`. RLS varsa zorunludur.
   * Yoksa `memberEpoch` satır göremez, null döner, bayatlık denetimi atlanır, güncelleme sıfır satıra yazar ve olay
   * işlendi sayılıp iptal kaybolur.
   */
  eventContext?: (tx: Tx, event: PlatformEvent) => Promise<void>;
  /** İlk kez görülüyorsa işaretleyip true, daha önce işlendiyse false döner (ör. `ProcessedEvent` eklemesi). */
  claimEvent: (tx: Tx, eventId: string) => Promise<boolean>;
  /**
   * `membershipId` için yerel epoch, kayıt yoksa null. Küçük epoch'lu üye olayı uygulanmaz.
   * SATIRI KİLİTLEYEREK okumalıdır (`SELECT ... FOR UPDATE`). Düz okumada eşzamanlı ep6 ve ep7 ikisi de eski değeri görür,
   * son yazan ep6 ise askı kaybolur.
   */
  memberEpoch: (tx: Tx, membershipId: string, event: PlatformEvent) => Promise<number | null>;
  /**
   * `org.updated`, `subscription.updated`, `org.closed` ve `org.reopened` için yerel sürüm, kayıt yoksa null. Küçük sürümlü olay
   * uygulanmaz (`stale`). Satırı kilitleyerek okumalıdır. Verilmezse bu türler için sıra koruması yoktur.
   * Kapatma ve geri açmada sözleşme eşit sürümü de uygulamaz: alıcı `onEvent`'te koşullu yazar (`closedVersion < sürüm`).
   * `org.purged` sürümsüzdür, buraya gelmez: son olaydır, her durumda uygulanır.
   */
  currentVersion?: (tx: Tx, event: Extract<PlatformEvent, { version?: number }>) => Promise<number | null>;
  /**
   * Olayı uygular. Bilinmeyen `type` buraya gelmez. `member.upserted.permissions` buraya katalogla kesişmiş gelir (katalog sırası,
   * bilinmeyen izin düşmüş); alanı olmayan olay alansız gelir (eski biçim: alıcı rolden türetir), rolü null olan olayda alan yoktur.
   * Üye olayında satır yoksa `FOR UPDATE` koruyamaz: eklemeyi `ON CONFLICT (id) DO UPDATE ... WHERE epoch <= EXCLUDED.epoch` ile yapın.
   */
  onEvent: (tx: Tx, event: PlatformEvent, meta: EventMeta) => Promise<void>;
};

/** Alıcının tanıdığı olay türleri. Hesap'ın ürettiği her tür burada olmalı (test sabitler). */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<PlatformEvent['type']>([
  'member.upserted',
  'member.removed',
  'org.updated',
  'org.closed',
  'org.reopened',
  'org.purged',
  'subscription.updated',
]);
const KNOWN_TYPES = KNOWN_EVENT_TYPES;

export type EventOutcome = 'processed' | 'duplicate' | 'stale';

function hasEpoch(event: PlatformEvent): event is Extract<PlatformEvent, { epoch: number }> {
  return event.type === 'member.upserted' || event.type === 'member.removed';
}

const isStr = (v: unknown) => typeof v === 'string' && v.length > 0;
const isEpoch = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isStrList = (v: unknown) => Array.isArray(v) && v.every((p) => typeof p === 'string');
const isIsoTime = (v: unknown) => isStr(v) && Number.isFinite(Date.parse(v as string));

/** Üye olayının izin listesi katalogla kesişir; rolsüz olayda alan atılır. Alanı olmayan olay olduğu gibi kalır. */
function normalizeMemberPermissions(event: PlatformEvent, definition: Parameters<typeof effectivePermissions>[0], catalog: readonly string[]): PlatformEvent {
  if (event.type !== 'member.upserted' || event.permissions === undefined) return event;
  const { permissions, ...rest } = event;
  if (!event.role) return rest;
  return { ...rest, permissions: [...effectivePermissions(definition, event.role, permissions, catalog)] };
}

/** İmzalı olay da doğrulanır: eksik alan, kuralları sessizce atlatmasın. Bilinmeyen tür yalnız kimlik alanlarıyla geçer (sonra 422 alır). */
function shapeOk(event: unknown): event is PlatformEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  if (!isStr(e.eventId) || !isStr(e.type) || !isStr(e.product)) return false;
  if (!KNOWN_TYPES.has(e.type as PlatformEvent['type'])) return true;
  if (!isStr(e.orgId)) return false;
  switch (e.type) {
    case 'member.upserted':
      // İzin listesi isteğe bağlı; varsa metin dizisi. Bozuk liste rolden türetilmez, olay reddedilir (dağıtıcı yeniden dener).
      return isStr(e.membershipId) && isEpoch(e.epoch) && (e.permissions === undefined || isStrList(e.permissions));
    case 'member.removed':
      return isStr(e.membershipId) && isEpoch(e.epoch);
    case 'org.updated':
      return isStr(e.name) && (e.version === undefined || isEpoch(e.version));
    case 'subscription.updated':
      return isStr(e.status) && isStr(e.plan) && (e.version === undefined || isEpoch(e.version));
    // Kapatma ve geri açma sürümle sıralanır: sürümsüz olay sıralanamaz, reddedilir (dağıtıcı yeniden dener).
    case 'org.closed':
      return isIsoTime(e.closedAt) && isIsoTime(e.purgeAfter) && isEpoch(e.version);
    case 'org.reopened':
      return isEpoch(e.version);
    case 'org.purged':
      return true;
    default:
      return false;
  }
}

export function registerEventReceiver<Tx>(app: FastifyInstance, opts: EventReceiverOptions<Tx>) {
  const definition = resolveProductDefinition(opts.product, opts.definition, 'registerEventReceiver');
  const catalog = catalogPermissionsOf(definition);
  const jwks =
    opts.jwks ??
    (app.hasDecorator('productAuthJwks') ? app.productAuthJwks : undefined) ??
    (() => {
      if (!opts.jwksUrl) throw new Error('registerEventReceiver: jwksUrl veya jwks gerekli');
      return createJwksClient({ url: opts.jwksUrl, fetch: opts.fetch });
    })();
  const path = opts.path ?? `/api/${opts.product}/internal/events`;

  // Olay jetonu küçüktür. Gateway bu yolu dışarı kapatır; yine de imzasız hiçbir şey işlenmez.
  app.post(path, { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const token = (req.body as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== 'string' || !token) return sendAuthError(req, reply, 400, 'INVALID_EVENT');

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks.getKey, {
        issuer: TOKEN_ISSUER,
        audience: EVENT_AUDIENCE,
        algorithms: [TOKEN_ALG],
        clockTolerance: 30,
        requiredClaims: ['exp', 'iat', 'jti'],
      }));
    } catch (err) {
      if (err instanceof JwksUnavailableError) return sendAuthError(req, reply, 503, 'AUTH_UNAVAILABLE');
      if (err instanceof UnknownKeyError || err instanceof joseErrors.JOSEError) {
        req.log.warn({ err }, 'auth-kit: olay imzası reddedildi');
        return sendAuthError(req, reply, 401, 'INVALID_EVENT');
      }
      throw err;
    }

    const raw = payload.event;
    if (!shapeOk(raw) || raw.eventId !== payload.jti) return sendAuthError(req, reply, 400, 'INVALID_EVENT');
    const event = normalizeMemberPermissions(raw, definition, catalog);
    if (event.product !== opts.product) return sendAuthError(req, reply, 400, 'INVALID_EVENT');

    // Tanınmayan tür işaretlenmez ve işlem açılmaz: ürün güncellenince olay yeniden gelip işlenebilsin.
    if (!KNOWN_TYPES.has(event.type)) return sendAuthError(req, reply, 422, 'UNKNOWN_EVENT_TYPE');

    const meta: EventMeta = { occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : null };

    const outcome = await opts.transaction<EventOutcome>(async (tx) => {
      if (opts.eventContext) await opts.eventContext(tx, event);
      if (!(await opts.claimEvent(tx, event.eventId))) return 'duplicate';
      if (hasEpoch(event)) {
        const current = await opts.memberEpoch(tx, event.membershipId, event);
        if (current !== null && event.epoch < current) return 'stale';
      } else if (opts.currentVersion && 'version' in event && event.version !== undefined) {
        const current = await opts.currentVersion(tx, event);
        if (current !== null && event.version < current) return 'stale';
      }
      await opts.onEvent(tx, event, meta);
      return 'processed';
    });

    return { ok: true, outcome };
  });
}
