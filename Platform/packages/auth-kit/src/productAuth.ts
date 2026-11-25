import { errors as joseErrors, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import {
  COOKIE_ACCESS,
  CSRF_HEADER,
  ORG_HEADER,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  PRODUCTS,
  errorMessage,
  isProductKey,
  requestLocaleOf,
  rolePermissions,
  type AccessClaims,
  type ApiErrorCode,
  type Locale,
  type OrgRole,
  type Permission,
  type ProductClaim,
  type ProductDef,
  type ProductEntry,
  type SubscriptionStatus,
} from '@sellerondata/contracts';
import { createJwksClient, JwksUnavailableError, UnknownKeyError, type JwksClient } from './jwks.ts';

/** Ürünün yerel üye kaydının auth-kit'in baktığı kısmı. */
/**
 * Yerel üye kaydı. `orgClosed`: firma kapatıldı (`org.closed`, saklama süresinde) ya da kalıcı silindi (`org.purged`); jeton ne olursa
 * olsun `409 ORG_CLOSED` (kapanışta epoch artar, açık oturum zaten düşer; bu çift güvencedir). Yoksa açık sayılır.
 */
export type MemberProjection = { epoch: number; active: boolean; orgClosed?: boolean };

/** §5 madde 3. Yanıtlarda değil, istek içinde kullanılır. */
export type ProductAuthContext = {
  personId: string;
  membershipId: string;
  orgId: string;
  orgName: string | null;
  orgRole: OrgRole;
  productRole: string;
  subscription: { status: SubscriptionStatus; plan: string; limits: Record<string, number | boolean> };
  /** Geçerli izinler, katalog sırasıyla. Jetonda `perms` varsa onun katalogla kesişimi, yoksa rolün katalogdaki izinleri. */
  permissions: readonly Permission[];
  /**
   * İzinlerin kaynağı: `token` jetondaki `perms` (özel ya da düzenlenmiş hazır rol), `role` eski biçim jeton (rol adından katalog).
   * Yerel üye kaydı buna göre yazar: `token` ise izin listesi, `role` ise null (katalogdan türet).
   */
  permissionsSource: 'token' | 'role';
  name: string;
  locale: Locale;
  sessionId: string;
  epoch: number;
  /**
   * Jetonun bitiş anı (ms, `exp` × 1000). Uzun süren yanıtlar (SSE akışı) bu anda kapanır; istemci yeniden bağlanıp kimlik
   * denetiminden geçer. İsteğe bağlı: elle kurulan bağlamlarda (testler, eski çağıranlar) olmayabilir.
   */
  expiresAt?: number;
};

/** Doğrulanmış jeton, ürün talebi kesinleşmiş biçimde. */
export type VerifiedMember = {
  claims: AccessClaims;
  auth: ProductAuthContext;
};

export type ProductAuthHook = (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void;

export type RequirePermissionOptions = {
  /** Durum değiştirmeyen POST için. Yalnız bu kancayı etkiler; zincirde `authenticate` de varsa rota `config: { readOnlyExempt: true }` kullanın. */
  readOnlyExempt?: boolean;
};

/**
 * Kimlik ve olay alıcısının araç tanımından okuduğu kısım. `permissions` (izin kataloğu) test fikstüründe yazılmayabilir:
 * o zaman katalog rollerin izinlerinin birleşimidir.
 */
export type ProductDefinitionSeam = Pick<ProductEntry, 'key' | 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>;

const NO_PERMISSIONS: readonly Permission[] = Object.freeze([]);

/**
 * Jetondaki ürün talebinin izinleri ve kaynağı. Yalnız `perms` alanının hiç olmaması eski biçimdir (rolden türet). `null` ya da
 * dizi olmayan değer bozuk imzalı veridir: boş liste ve kaynak `token`, yerel kayda da boş liste yazılır (rol varsayılanına
 * dönmesin).
 */
function tokenPermissions(
  definition: Pick<ProductEntry, 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>,
  claim: ProductClaim,
  catalog: readonly string[],
): { permissions: readonly Permission[]; permissionsSource: 'token' | 'role' } {
  const perms: unknown = claim.perms;
  if (perms === undefined) return { permissions: effectivePermissions(definition, claim.role, undefined, catalog), permissionsSource: 'role' };
  if (!Array.isArray(perms)) return { permissions: NO_PERMISSIONS, permissionsSource: 'token' };
  return { permissions: effectivePermissions(definition, claim.role, perms, catalog), permissionsSource: 'token' };
}

/** Aracın izin kataloğu, katalog sırasıyla: `permissions` anahtarları, yoksa rollerin izinleri (ilk görülme sırası). */
export function catalogPermissionsOf(definition: Pick<ProductEntry, 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>): readonly string[] {
  if (definition.permissions) return Object.freeze(Object.keys(definition.permissions));
  return Object.freeze([...new Set(definition.roles.flatMap((r) => r.permissions as readonly string[]))]);
}

/**
 * Geçerli izinler (özel roller). Yerel üye kaydının kuralı (`Member.role` + `Member.permissions`):
 * - `perms` dizi ise: katalogla kesişimi, katalog sırasıyla, tekil. Bilinmeyen ya da başka aracın izni düşer. Rol adına bakılmaz.
 * - `perms` yoksa (`undefined`/`null`: sütun NULL, eski olay ya da eski jetonla yazılmış): rolün katalogdaki izinleri; katalogda
 *   olmayan rol boş liste.
 * - `perms` dizi değilse (bozuk veri): boş liste. Rolden türetmek, Hesap'ın daraltmak istediği izni geri açabilirdi.
 * Rol yoksa (`null`, üründe erişim yok) her durumda boş liste.
 * Jetonda kural daha dar (`tokenPermissions`): yalnız alanın hiç olmaması eski biçimdir, `null` bozuk sayılır.
 */
export function effectivePermissions(
  definition: Pick<ProductEntry, 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>,
  role: string | null | undefined,
  perms: unknown,
  catalog: readonly string[] = catalogPermissionsOf(definition),
): readonly Permission[] {
  if (!role) return NO_PERMISSIONS;
  if (perms === undefined || perms === null) return rolePermissions(definition, role) as readonly Permission[];
  if (!Array.isArray(perms)) return NO_PERMISSIONS;
  const held = new Set(perms.filter((p): p is string => typeof p === 'string'));
  return Object.freeze(catalog.filter((p) => held.has(p))) as readonly Permission[];
}

/**
 * Aracın tanımı: `definition` verilmişse o (yalnız test fikstürü, ör. product-kit `ornekarac`), yoksa kayıttaki `PRODUCTS[product]`.
 * Açılışta fırlatır: kayıtta olmayan anahtar `definition` olmadan; anahtarı tutmayan `definition`; test koşusu dışında (`NODE_ENV` `test` değilse:
 * boş, `development`, `staging`, `production`) herhangi bir `definition`. İzin listesi: vitest `NODE_ENV=test` koyar; kurulumda
 * izinler yalnız kayıttan türer, kayıtta olmayan araçla kimlik kurulamaz.
 */
export function resolveProductDefinition<D extends { key: string }>(product: string, definition: D | undefined, caller: string): D | ProductDef {
  if (definition === undefined) {
    if (!isProductKey(product)) throw new Error(`${caller}: "${product}" araç kaydında yok (contracts products.ts).`);
    return PRODUCTS[product];
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${caller}: "definition" yalnız test koşusunda (NODE_ENV=test) kabul edilir; araç tanımı kayıttan okunur.`);
  }
  if (definition.key !== product) throw new Error(`${caller}: definition.key "${definition.key}" ile product "${product}" aynı değil.`);
  return definition;
}

export type ProductAuthOptions = {
  /** Kayıt anahtarı (`PRODUCTS`). Kayıtta olmayan anahtar yalnız `definition` ile ve yalnız `NODE_ENV=test` iken kabul edilir. */
  product: string;
  /** Yalnız test fikstürü: kayıtta olmayan aracın rolleri. `NODE_ENV` `test` değilse açılış durur. */
  definition?: ProductDefinitionSeam;
  /** Hesap'ın iç adresi, ör. `http://account-api:4100/api/account/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Hazır istemci. Verilirse `jwksUrl` ve `fetch` kullanılmaz. */
  jwks?: JwksClient;
  fetch?: typeof fetch;
  /** Çerezli yazma isteklerinde kabul edilen `Origin` değerleri. Boşsa çerezli yazma hep reddedilir. */
  allowedOrigins: readonly string[];
  /**
   * `loadMember`, `provisionMember`, `syncMember` bu sarmalın içinde çalışır. RLS varsa zorunludur:
   * bu aşamada `runInContext` henüz çalışmadı, bağlamsız okuma satır göremez ve geçerli üye `403 NO_PRODUCT_ACCESS` alır.
   */
  withOrgContext?: <T>(orgId: string, work: () => Promise<T>) => Promise<T>;
  /** Yerel üye kaydını getirir, yoksa null. Jeton doğrulandıktan sonra her istekte çağrılır. */
  loadMember: (membershipId: string, claims: AccessClaims) => Promise<MemberProjection | null>;
  /**
   * JIT: tanınmayan `mid` için Company ve Member açar. Yalnız `ON CONFLICT DO NOTHING` ile ekler ve satırı YENİDEN OKUYUP döner:
   * araya giren `member.removed` üzerine yazılırsa çıkarılan üye geri açılır. Verilmezse tanınmayan üye `403 NO_PRODUCT_ACCESS` alır.
   */
  provisionMember?: (verified: VerifiedMember) => Promise<MemberProjection>;
  /**
   * Jeton yerel kayıttan yeni (`ep > Member.epoch`): olay gecikmiş ya da kaybolmuş demektir.
   * Yerel kaydı jetondan günceller: `WHERE epoch < $jeton` koşuluyla, sonra satırı YENİDEN OKUYUP döner. Koşulsuz yazmak
   * araya giren yeni iptali geri alır. DeciShip ve product-kit eşitlemesi askıdan dönen pasif üyeyi de açar (jetonun epoch'u
   * büyükse; çıkarılmış üye `removedAt` ile hiç açılmaz). Verilmezse veya void dönerse yerel kayıt olduğu gibi denetlenir:
   * pasif üye geçemez.
   */
  syncMember?: (verified: VerifiedMember, current: MemberProjection) => Promise<MemberProjection | void>;
  /**
   * İsteğin geri kalanını bir bağlam içinde çalıştırır (RLS için AsyncLocalStorage):
   * `runInContext: (auth, next) => store.run({ companyId: auth.orgId }, next)`.
   */
  runInContext?: (auth: ProductAuthContext, next: () => void) => void;
  /** Saat kayması payı, saniye. Varsayılan 5. */
  clockToleranceSeconds?: number;
  onJwksError?: (err: unknown) => void;
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Durum değiştirmeyen POST (ör. POST ile sorgu): READ_ONLY denetimi bu rotada hiçbir kancada uygulanmaz. */
    readOnlyExempt?: boolean;
  }
  interface FastifyInstance {
    authenticate: ProductAuthHook;
    requirePermission: (permission: Permission, opts?: RequirePermissionOptions) => ProductAuthHook;
    productAuthJwks: JwksClient;
  }
  interface FastifyRequest {
    auth: ProductAuthContext;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Aynı addaki tüm çerez değerleri. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      values.push(raw);
    }
  }
  return values;
}

export function sendAuthError(req: FastifyRequest, reply: FastifyReply, status: number, code: ApiErrorCode, details?: Record<string, unknown>) {
  void reply.header('cache-control', 'no-store');
  if (status === 503) void reply.header('retry-after', '3');
  void reply.status(status).send({
    // Dil: başlık → oturumun dili (kimlik doğrulandıysa) → İngilizce (karar 2026-11-12).
    error: { code, message: errorMessage(code, requestLocaleOf(req.headers['accept-language'], (req as { auth?: { locale?: string } | null }).auth?.locale)), ...(details ? { details } : {}) },
  });
}

type TokenSource = { kind: 'none' } | { kind: 'invalid' } | { kind: 'bearer' | 'cookie'; token: string };

/** `Authorization` varsa yalnız ona bakılır. Geçersiz Bearer çerezle telafi edilmez. */
function extractToken(req: FastifyRequest): TokenSource {
  const header = req.headers.authorization;
  if (header !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match?.[1] ? { kind: 'bearer', token: match[1] } : { kind: 'invalid' };
  }
  const cookies = cookieValues(req.headers.cookie, COOKIE_ACCESS);
  // Alt alan adından yazılan ikinci çerez firmalar arası oturum sabitleme yoludur: hangisi seçilirse seçilsin yanlış olabilir.
  if (cookies.length > 1) return { kind: 'invalid' };
  return cookies[0] ? { kind: 'cookie', token: cookies[0] } : { kind: 'none' };
}

/** Çerezli yazma isteği: `X-SOD-CSRF: 1` ve izin listesindeki `Origin` birlikte zorunlu. */
export function csrfOk(req: FastifyRequest, allowedOrigins: ReadonlySet<string>): boolean {
  if (req.headers[CSRF_HEADER] !== '1') return false;
  const origin = req.headers.origin;
  return typeof origin === 'string' && allowedOrigins.has(origin.toLowerCase());
}

function normalizeOrigins(origins: readonly string[]): Set<string> {
  return new Set(origins.map((o) => o.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean));
}

function claimsShapeOk(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.sub === 'string' &&
    typeof payload.sid === 'string' &&
    typeof payload.ep === 'number' &&
    typeof payload.prod === 'object' &&
    payload.prod !== null
  );
}

export function registerProductAuth(app: FastifyInstance, opts: ProductAuthOptions) {
  const definition: Pick<ProductEntry, 'roles'> & Partial<Pick<ProductEntry, 'permissions'>> = resolveProductDefinition(
    opts.product,
    opts.definition,
    'registerProductAuth',
  );
  const catalog = catalogPermissionsOf(definition);
  const jwks = opts.jwks ?? (() => {
    if (!opts.jwksUrl) throw new Error('registerProductAuth: jwksUrl veya jwks gerekli');
    return createJwksClient({ url: opts.jwksUrl, fetch: opts.fetch, onRefreshError: opts.onJwksError });
  })();
  const allowedOrigins = normalizeOrigins(opts.allowedOrigins);
  const clockTolerance = opts.clockToleranceSeconds ?? 5;

  /** Yanıt gönderdiyse false döner. Aynı istekte ikinci kez çalışmaz. */
  async function authenticateCore(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (req.auth) return true;

    const source = extractToken(req);
    if (source.kind === 'none' || source.kind === 'invalid') {
      sendAuthError(req, reply, 401, 'UNAUTHORIZED');
      return false;
    }
    if (source.kind === 'cookie' && isWriteMethod(req.method) && !csrfOk(req, allowedOrigins)) {
      sendAuthError(req, reply, 403, 'CSRF_FAILED');
      return false;
    }

    let claims: AccessClaims;
    try {
      const { payload } = await jwtVerify(source.token, jwks.getKey, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: [TOKEN_ALG],
        clockTolerance,
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      if (!claimsShapeOk(payload)) {
        sendAuthError(req, reply, 401, 'UNAUTHORIZED');
        return false;
      }
      claims = payload as unknown as AccessClaims;
    } catch (err) {
      if (err instanceof JwksUnavailableError) {
        req.log.warn({ err }, 'auth-kit: anahtar doğrulanamıyor');
        sendAuthError(req, reply, 503, 'AUTH_UNAVAILABLE');
      } else if (err instanceof joseErrors.JWTExpired) {
        sendAuthError(req, reply, 401, 'TOKEN_EXPIRED');
      } else {
        // Jeton saldırgan girdisidir: beklenmeyen doğrulama hatası da kimlik yok demektir, 500 değil.
        if (!(err instanceof UnknownKeyError || err instanceof joseErrors.JOSEError)) req.log.warn({ err }, 'auth-kit: jeton doğrulama hatası');
        sendAuthError(req, reply, 401, 'UNAUTHORIZED');
      }
      return false;
    }

    // §5 denetim sırası
    if (!claims.org || !claims.mid || !claims.orgRole) {
      sendAuthError(req, reply, 403, 'ORG_REQUIRED');
      return false;
    }
    // Etkin firma çerezde ve sekmeler arasında ortak: eski sekmenin yazması başka firmaya gitmesin. Bearer'da istemci jetonu kendisi tutar.
    if (source.kind === 'cookie' && isWriteMethod(req.method) && req.headers[ORG_HEADER] !== claims.org) {
      sendAuthError(req, reply, 409, 'ORG_MISMATCH');
      return false;
    }
    const orgId = claims.org;
    const inContext = <T>(work: () => Promise<T>): Promise<T> => (opts.withOrgContext ? opts.withOrgContext(orgId, work) : work());
    const mid = claims.mid;

    let member = await inContext(() => opts.loadMember(mid, claims));
    // Kapalı firma: rol, epoch ve abonelikten önce. Kapanışta Hesap ürün erişimini de kaldırır; istemci yenileme döngüsüne girmesin.
    if (member?.orgClosed) {
      sendAuthError(req, reply, 409, 'ORG_CLOSED');
      return false;
    }
    const productClaim = (claims.prod as Partial<Record<string, ProductClaim>>)[opts.product];
    if (!productClaim) {
      // Rol jeton basıldıktan sonra verilmiş olabilir. Yerel kayıt daha yeniyse jeton bayattır: istemci yeniler, 10 dakika beklemez.
      if (member && claims.ep < member.epoch) {
        sendAuthError(req, reply, 401, 'TOKEN_STALE');
        return false;
      }
      // Olay gecikmiş veya ilk kez verilen rol olabilir: projeksiyon bunu bilemez, kesin karar Hesap'tadır. İstemci bir kez sessizce yeniler.
      sendAuthError(req, reply, 403, 'NO_PRODUCT_ACCESS', { refreshable: true });
      return false;
    }

    const auth: ProductAuthContext = {
      personId: claims.sub,
      membershipId: claims.mid,
      orgId: claims.org,
      orgName: claims.orgName,
      orgRole: claims.orgRole,
      productRole: productClaim.role,
      subscription: { status: productClaim.status, plan: productClaim.plan, limits: productClaim.limits ?? {} },
      // Rol adı kodda kullanılmaz. Jetondaki `perms` katalogla kesişir; yoksa (eski jeton) rolün katalogdaki izinleri.
      ...tokenPermissions(definition, productClaim, catalog),
      name: claims.name,
      locale: claims.locale,
      sessionId: claims.sid,
      epoch: claims.ep,
      // `exp` zorunlu talep (jwtVerify `requiredClaims`); sayı değilse doğrulama zaten düşerdi.
      ...(typeof (claims as { exp?: unknown }).exp === 'number' ? { expiresAt: (claims as { exp: number }).exp * 1000 } : {}),
    };
    const verified: VerifiedMember = { claims, auth };

    if (!member) {
      const { provisionMember } = opts;
      if (!provisionMember) {
        sendAuthError(req, reply, 403, 'NO_PRODUCT_ACCESS');
        return false;
      }
      member = await inContext(() => provisionMember(verified));
    }
    if (claims.ep > member.epoch && opts.syncMember) {
      const { syncMember } = opts;
      const current = member;
      member = (await inContext(() => syncMember(verified, current))) ?? member;
    }
    // JIT ya da eşitleme kapalı firmayı bildirebilir (üye kaydı yokken kapanmış firma).
    if (member.orgClosed) {
      sendAuthError(req, reply, 409, 'ORG_CLOSED');
      return false;
    }
    // Eşitleme sonrası da denetlenir: araya yeni olay girmiş olabilir.
    if (claims.ep < member.epoch) {
      sendAuthError(req, reply, 401, 'TOKEN_STALE');
      return false;
    }
    // Yerel pasif kayıt: jeton kaç olursa olsun geçmez. Eşitleme gerekliyse aktif kaydı o döndürür. Döngü olmasın diye 403.
    if (!member.active) {
      sendAuthError(req, reply, 403, 'FORBIDDEN');
      return false;
    }

    void reply.header('cache-control', 'no-store');
    req.auth = auth;
    return true;
  }

  function buildHook(after: (req: FastifyRequest, reply: FastifyReply) => boolean): ProductAuthHook {
    return (req, reply, done) => {
      authenticateCore(req, reply)
        .then((passed) => {
          if (!passed || !after(req, reply)) return;
          if (!opts.runInContext) return done();
          // Bağlam kurulamazsa istek asılı kalmaz. `next` çağrıldıysa istek zaten yürüyor, ikinci yanıt gönderilmez.
          let continued = false;
          const failed = (err: unknown) => {
            if (continued) req.log.error({ err }, 'auth-kit: runInContext hatası');
            else done(err as Error);
          };
          try {
            const result = opts.runInContext(req.auth, () => {
              continued = true;
              done();
            }) as unknown;
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
              (result as PromiseLike<unknown>).then(undefined, failed);
            }
          } catch (err) {
            failed(err);
          }
        })
        .catch((err) => done(err as Error));
    };
  }

  function readOnlyGate(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.routeOptions.config.readOnlyExempt) return true;
    if (isWriteMethod(req.method) && req.auth.subscription.status !== 'ACTIVE') {
      sendAuthError(req, reply, 403, 'READ_ONLY');
      return false;
    }
    return true;
  }

  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null as unknown as ProductAuthContext);
  app.decorate('productAuthJwks', jwks);
  app.decorate('authenticate', buildHook(readOnlyGate));
  app.decorate('requirePermission', (permission: Permission, permOpts: RequirePermissionOptions = {}) =>
    buildHook((req, reply) => {
      if (!req.auth.permissions.includes(permission)) {
        sendAuthError(req, reply, 403, 'FORBIDDEN');
        return false;
      }
      return permOpts.readOnlyExempt ? true : readOnlyGate(req, reply);
    }),
  );
}
