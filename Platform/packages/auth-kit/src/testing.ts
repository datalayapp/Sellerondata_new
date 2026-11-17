import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  ACCESS_TTL_SECONDS,
  COOKIE_ACCESS,
  CSRF_HEADER,
  ORG_HEADER,
  EVENT_AUDIENCE,
  EVENT_TOKEN_TTL_SECONDS,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type Locale,
  type OrgRole,
  type PlatformEvent,
  type ProductClaim,
  type SubscriptionStatus,
} from '@sellerondata/contracts';

if (process.env.NODE_ENV === 'production') {
  throw new Error('auth-kit/testing üretimde içe aktarılamaz: jeton basma aracıdır.');
}

/**
 * Hesap'ı çalıştırmadan ürün testi: anahtar üretir, jeton basar, JWKS'i `fetch` sahtesiyle sunar.
 *
 * ```ts
 * const authority = await createTestAuthority();
 * registerProductAuth(app, { product: 'deciship', ...authority.authOptions, allowedOrigins: [ORIGIN], loadMember });
 * const token = await authority.accessToken({ role: 'AUDITOR', orgId: 'org-a', membershipId: 'm-1' });
 * await app.inject({ url: '/x', headers: authority.bearer(token) });
 * ```
 * Yalnız test kodundan içe aktarın. Üretim paketine girmez.
 */

export type TestTokenInput = {
  personId?: string;
  sessionId?: string;
  name?: string;
  locale?: Locale;
  /** `null`: üyeliği olmayan kişi jetonu. */
  orgId?: string | null;
  orgName?: string | null;
  membershipId?: string | null;
  orgRole?: OrgRole | null;
  epoch?: number;
  /** Ürün anahtarı; kayıtta olmayan test fikstürü (ör. `ornekarac`) de olabilir. Varsayılan `deciship`. */
  product?: string;
  /** `null`: `prod` içinde ürün yok ("Erişim yok"). */
  role?: string | null;
  /**
   * Rolün firmadaki geçerli izinleri (`ProductClaim.perms`; özel rol `custom:<uuid>` ya da düzenlenmiş hazır rol).
   * Verilmezse alan jetona yazılmaz: eski biçim jeton, izinler rolden türer.
   */
  perms?: string[];
  status?: SubscriptionStatus;
  plan?: string;
  limits?: Record<string, number | boolean>;
  /** Tam `prod` nesnesi. Verilirse `product`, `role`, `perms`, `status` yok sayılır. */
  prod?: Partial<Record<string, ProductClaim>>;
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
  /** Yabancı anahtarla imzala (yanlış imza testi). `kid` yine geçerli anahtarınki kalır. */
  foreignKey?: boolean;
  /** Başlıktaki `kid`i değiştir. */
  kid?: string;
};

export type TestEventOptions = {
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  foreignKey?: boolean;
  occurredAt?: string;
  jti?: string;
};

export type TestAuthority = {
  jwksUrl: string;
  /** `registerProductAuth`a yayılabilir: `{ jwksUrl, fetch }`. */
  authOptions: { jwksUrl: string; fetch: typeof fetch };
  /** Sahte JWKS sunan `fetch`. */
  fetch: typeof fetch;
  kid: () => string;
  accessToken: (input?: TestTokenInput) => Promise<string>;
  eventToken: (event: PlatformEvent, options?: TestEventOptions) => Promise<string>;
  /** Yeni anahtara geç. Eskisi JWKS'te kalır (`dropPrevious` true ise çıkar). */
  rotateKey: (opts?: { dropPrevious?: boolean }) => Promise<string>;
  /** Hesap kesintisi: `fetch` hata fırlatır. */
  setOffline: (offline: boolean) => void;
  /** JWKS'e yapılan istek sayısı. */
  fetchCount: () => number;
  bearer: (token: string) => { authorization: string };
  /** Çerezli istek başlıkları. `write: true` ise CSRF, `Origin` ve jetonun firmasıyla `X-SOD-Org` de eklenir (`org` ile değiştirilir). */
  cookie: (token: string, opts?: { write?: boolean; origin?: string; org?: string }) => Record<string, string>;
};

type KeyEntry = { kid: string; privateKey: CryptoKey; publicJwk: JWK };

async function newKey(kid: string): Promise<KeyEntry> {
  const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALG, { crv: 'Ed25519', extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: TOKEN_ALG, use: 'sig' } };
}

export const TEST_ORIGIN = 'http://localhost:8088';

export async function createTestAuthority(opts: { jwksUrl?: string } = {}): Promise<TestAuthority> {
  const jwksUrl = opts.jwksUrl ?? 'http://account.test/api/account/.well-known/jwks.json';
  let serial = 1;
  let active = await newKey(`test-${serial}`);
  let published: KeyEntry[] = [active];
  const foreign = await newKey('foreign');
  let offline = false;
  let fetches = 0;

  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== jwksUrl) throw new Error(`createTestAuthority: beklenmeyen adres ${url}`);
    fetches += 1;
    if (offline) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ keys: published.map((k) => k.publicJwk) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    jwksUrl,
    fetch: fakeFetch,
    authOptions: { jwksUrl, fetch: fakeFetch },
    kid: () => active.kid,
    setOffline: (value) => {
      offline = value;
    },
    fetchCount: () => fetches,
    bearer: (token) => ({ authorization: `Bearer ${token}` }),
    cookie: (token, cookieOpts = {}) => ({
      cookie: `${COOKIE_ACCESS}=${token}`,
      ...(cookieOpts.write
        ? { [CSRF_HEADER]: '1', origin: cookieOpts.origin ?? TEST_ORIGIN, [ORG_HEADER]: cookieOpts.org ?? String(decodeJwt(token).org) }
        : {}),
    }),
    async rotateKey(rotateOpts = {}) {
      serial += 1;
      active = await newKey(`test-${serial}`);
      published = rotateOpts.dropPrevious ? [active] : [active, ...published];
      return active.kid;
    },
    async accessToken(input = {}) {
      const orgId = input.orgId === undefined ? 'org-test' : input.orgId;
      const role = input.role === undefined ? 'ADMIN' : input.role;
      const product = input.product ?? 'deciship';
      const prod =
        input.prod ??
        (orgId && role
          ? {
              [product]: {
                role,
                ...(input.perms ? { perms: [...input.perms] } : {}),
                status: input.status ?? 'ACTIVE',
                plan: input.plan ?? 'early_access',
                ...(input.limits ? { limits: input.limits } : {}),
              },
            }
          : {});
      const now = Math.floor(Date.now() / 1000);
      const key = input.foreignKey ? foreign.privateKey : active.privateKey;
      return new SignJWT({
        sid: input.sessionId ?? randomUUID(),
        name: input.name ?? 'Test Kişi',
        locale: input.locale ?? 'tr',
        org: orgId,
        orgName: orgId ? (input.orgName ?? 'Test Firma') : null,
        mid: orgId ? (input.membershipId === undefined ? 'member-test' : input.membershipId) : null,
        orgRole: orgId ? (input.orgRole === undefined ? 'MEMBER' : input.orgRole) : null,
        ep: input.epoch ?? 0,
        prod,
      })
        .setProtectedHeader({ alg: TOKEN_ALG, kid: input.kid ?? active.kid, typ: 'JWT' })
        .setIssuer(input.issuer ?? TOKEN_ISSUER)
        .setAudience(input.audience ?? TOKEN_AUDIENCE)
        .setSubject(input.personId ?? 'person-test')
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + (input.expiresInSeconds ?? ACCESS_TTL_SECONDS))
        .sign(key);
    },
    async eventToken(event, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ event, occurredAt: options.occurredAt ?? new Date().toISOString() })
        .setProtectedHeader({ alg: TOKEN_ALG, kid: active.kid, typ: 'JWT' })
        .setIssuer(options.issuer ?? TOKEN_ISSUER)
        .setAudience(options.audience ?? EVENT_AUDIENCE)
        .setJti(options.jti ?? event.eventId)
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresInSeconds ?? EVENT_TOKEN_TTL_SECONDS))
        .sign(options.foreignKey ? foreign.privateKey : active.privateKey);
    },
  };
}

export type EpochRaceCheckOptions = {
  /** `registerEventReceiver` kayıtlı uygulama. Gerçek veritabanıyla kullanın: sahte işlem yarışı gösteremez. */
  app: FastifyInstance;
  authority: TestAuthority;
  path?: string;
  product?: string;
  orgId: string;
  rounds?: number;
  /** Etkin olayın rolü. Varsayılan `AUDITOR` (DeciShip). */
  role?: string;
  /** Üyeyi verilen epoch ile aktif olarak yerel tabloya ekler. */
  seedMember: (membershipId: string, epoch: number) => Promise<void>;
  /** Doğrudan veritabanından (RLS'i aşan bağlantıyla) okur. */
  readMember: (membershipId: string) => Promise<{ epoch: number; active: boolean }>;
};

/**
 * Ürünün olay alıcısı sözleşmesini sınar: rol değişimi (ep6) ve askı (ep7) aynı anda iner, iki sırayla, tekrar tekrar.
 * `wrong` sıfırdan büyükse alıcı satırı kilitlemiyor veya koşulsuz yazıyordur: askıya alma kaybolur.
 */
export async function runEpochRaceCheck(opts: EpochRaceCheckOptions): Promise<{ rounds: number; wrong: number }> {
  const rounds = opts.rounds ?? 50;
  const product = opts.product ?? 'deciship';
  const path = opts.path ?? `/api/${product}/internal/events`;
  const role = opts.role ?? 'AUDITOR';
  const event = (membershipId: string, epoch: number, active: boolean): PlatformEvent =>
    ({
      eventId: randomUUID(),
      type: 'member.upserted',
      orgId: opts.orgId,
      product,
      membershipId,
      personId: 'yaris-kisi',
      name: 'Yarış',
      orgRole: 'MEMBER',
      role: active ? role : null,
      active,
      epoch,
    }) as PlatformEvent;
  let wrong = 0;
  for (let i = 0; i < rounds; i++) {
    const mid = randomUUID();
    await opts.seedMember(mid, 5);
    const tokens = [await opts.authority.eventToken(event(mid, 6, true)), await opts.authority.eventToken(event(mid, 7, false))];
    if (i % 2) tokens.reverse();
    await Promise.all(tokens.map((token) => opts.app.inject({ method: 'POST', url: path, payload: { token } })));
    const row = await opts.readMember(mid);
    if (row.epoch !== 7 || row.active) wrong += 1;
  }
  return { rounds, wrong };
}
