import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCESS_TTL_SECONDS,
  COOKIE_ACCESS,
  COOKIE_LANG,
  COOKIE_REFRESH,
  CSRF_HEADER,
  ORG_HEADER,
  REFRESH_TTL_SECONDS,
  type AccessClaims,
  type AuthResponse,
  type Locale,
} from '@sellerondata/contracts';
import { prisma } from './db.ts';
import { env } from './env.ts';
import { AppError, forbidden, unauthorized } from './errors.ts';
import { buildMe, isPlatformOperator } from './lib/me.ts';
import { signForSession, type ClientKind, type ClientMeta } from './lib/sessions.ts';
import { verifyAccessToken } from './lib/tokens.ts';

export const PATH_ACCESS_COOKIE = '/api';
export const PATH_REFRESH_COOKIE = '/api/account/auth';

/** Doğrulanmış istek sahibi. */
export type Principal = {
  claims: AccessClaims;
  personId: string;
  sessionId: string;
  familyId: string;
  client: ClientKind;
};

/** İstek sahibinin etkin firmadaki güncel üyeliği. Jetondan değil, veritabanından. */
export type MemberContext = { id: string; orgId: string; orgRole: 'OWNER' | 'ADMIN' | 'MEMBER'; personId: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    member: MemberContext | null;
  }
  interface FastifyContextConfig {
    /** Yanıt oturum çerezi yazabilir: çerez olmasa da CSRF denetlenir (giriş CSRF'ine karşı). */
    setsCookies?: boolean;
    /**
     * Tanıtım sitesi kökenine (SITE_ORIGINS) açık uç: CORS yanıtı ve CSRF'in Origin denetimi site kökenini de kabul eder.
     * Yalnız `GET /auth/site-session` ve `POST /auth/logout` (ve ön uçuş kardeşleri) taşır. Karar yoldan değil bu işaretten okunur.
     */
    siteOrigin?: boolean;
    /**
     * Firma yazma ucunun mobil istisnası (`routes/org.ts` `guardOrgWrites`): yalnız `POST /org/members/invite` taşır. Telefonla
     * çalışan daveti (`kind: PHONE_CODE`, `orgRole: MEMBER`) mobil oturumla da kabul edilir; başka her davet tarayıcı oturumu ister.
     */
    mobileWorkerInvite?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function clientMeta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

/** Aynı adlı ikinci çerez alt alan adından yazılmış olabilir (oturum sabitleme): hangisi seçilirse seçilsin yanlış olabilir. */
export function hasDuplicateCookie(req: FastifyRequest, name: string): boolean {
  const header = req.headers.cookie;
  if (!header) return false;
  return header.split(';').filter((part) => part.split('=', 1)[0]?.trim() === name).length > 1;
}

function tokenFromRequest(req: FastifyRequest): { token: string } | null {
  const header = req.headers.authorization;
  if (header !== undefined) {
    // `Authorization` varsa yalnız ona bakılır: geçersiz Bearer çerezle telafi edilmez.
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match?.[1]) throw unauthorized();
    return { token: match[1] };
  }
  if (hasDuplicateCookie(req, COOKIE_ACCESS)) throw unauthorized();
  const cookie = req.cookies?.[COOKIE_ACCESS];
  return cookie ? { token: cookie } : null;
}

/** Jeton + veritabanındaki oturum. Hesap iptali ürünlerin aksine anında geçerlidir. */
async function resolvePrincipal(req: FastifyRequest): Promise<Principal | null> {
  const found = tokenFromRequest(req);
  if (!found) return null;
  const claims = await verifyAccessToken(found.token);
  const session = await prisma.session.findUnique({
    where: { id: claims.sid },
    select: { id: true, personId: true, familyId: true, client: true, revokedAt: true, expiresAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.personId !== claims.sub) throw unauthorized();
  return { claims, personId: session.personId, sessionId: session.id, familyId: session.familyId, client: session.client };
}

export async function requireAuth(req: FastifyRequest) {
  if (req.principal) return;
  const principal = await resolvePrincipal(req);
  if (!principal) throw unauthorized();
  req.principal = principal;
}

/**
 * Oturum varsa doldurur, yoksa veya geçersizse sessizce geçer (davet kabulü).
 * Süresi dolmuş jeton hata olarak döner: istemci yenileyip yeniden dener, kişi girişe atılmaz.
 * Çıkış gibi oturum gerektirmeyen uçlar `ignoreExpired` verir.
 */
export async function optionalAuth(req: FastifyRequest, opts: { ignoreExpired?: boolean } = {}): Promise<void> {
  try {
    req.principal = await resolvePrincipal(req);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'TOKEN_EXPIRED' && !opts.ignoreExpired) throw err;
    req.principal = null;
  }
}

/** Etkin firma üyeliği zorunlu. Üyelik askıda, silinmiş veya jeton eski ise istemci yenilesin. */
export async function requireMember(req: FastifyRequest) {
  await requireAuth(req);
  const { claims, personId } = req.principal as Principal;
  if (!claims.org) {
    // Jeton firmasız ama kişinin etkin üyeliği var (askı kalktı, davet başka cihazda kabul edildi): firma seçmesi değil, yenilemesi gerekir.
    // Kapalı firmadaki üyelik sayılmaz: yenileme ona jeton vermez, istemci TOKEN_STALE döngüsüne girerdi.
    const active = await prisma.membership.findFirst({ where: { personId, status: 'ACTIVE', org: { closedAt: null } }, select: { id: true } });
    throw active ? new AppError(401, 'TOKEN_STALE') : new AppError(403, 'ORG_REQUIRED');
  }
  // Etkin firma çerezde ve sekmeler arasında ortak: eski sekmenin yazması başka firmaya gitmesin. Bearer'da istemci jetonu kendisi tutar.
  if (req.headers.authorization === undefined && !SAFE_METHODS.has(req.method) && req.headers[ORG_HEADER] !== claims.org) {
    throw new AppError(409, 'ORG_MISMATCH');
  }
  const membership = await prisma.membership.findUnique({
    where: { personId_orgId: { personId, orgId: claims.org } },
    select: { id: true, orgId: true, orgRole: true, status: true, epoch: true, personId: true, org: { select: { closedAt: true } } },
  });
  // Çıkarılıp yeniden eklenen kişinin yeni satırı epoch'u baştan sayar: eski jeton üyelik kimliğinden anlaşılır.
  if (!membership || membership.status !== 'ACTIVE' || membership.id !== claims.mid || claims.ep < membership.epoch) {
    throw new AppError(401, 'TOKEN_STALE');
  }
  // Kapalı firma (`POST /org/close`): kapatma epoch'u artırdığı için eski jeton yukarıda düşer; burası çift güvence (kapanışla yarışan
  // jeton). Okuma da yazma da reddedilir.
  if (membership.org.closedAt) throw new AppError(409, 'ORG_CLOSED');
  req.member = { id: membership.id, orgId: membership.orgId, orgRole: membership.orgRole, personId: membership.personId };
}

/** OWNER veya ADMIN. Rol jetondan değil veritabanından okunur. */
export async function requireManager(req: FastifyRequest) {
  await requireMember(req);
  const role = (req.member as MemberContext).orgRole;
  if (role !== 'OWNER' && role !== 'ADMIN') throw forbidden();
}

/**
 * Tarayıcı oturumu: jeton çerezden geldi (`Authorization` yok) ve oturum satırı `web` istemcisiyle açıldı. İkisi birden gerekir:
 * yalnız başlığa bakılsaydı çalınmış mobil jeton `Cookie: sod_at=…` ile gönderilir, CSRF başlığı da tarayıcı dışında elle yazılırdı.
 * Oturumun türü girişte seçilir ve sonra değişmez; mobil oturumdan web oturumu üreten yol yoktur.
 */
export function isWebSession(req: FastifyRequest): boolean {
  return req.headers.authorization === undefined && req.principal?.client === 'web';
}

/**
 * Firma yönetimi yazmaları (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): kimlik denetimlerinden SONRA koşar, böylece bayat ya da
 * geçersiz jeton yine 401 alır, istemci yeniler. Mobil ve Bearer `403 FORBIDDEN`, `details.reason: WEB_SESSION_REQUIRED`.
 */
export async function requireWebSession(req: FastifyRequest) {
  await requireAuth(req);
  if (!isWebSession(req)) throw webSessionRequired();
}

export const webSessionRequired = () => new AppError(403, 'FORBIDDEN', { reason: 'WEB_SESSION_REQUIRED' });

/**
 * Platform yöneticisi uçları (`routes/operator.ts`): tarayıcı oturumu VE kişi şu an yönetici (`isPlatformOperator`; jetondaki `op`'a
 * değil veritabanına bakılır: listeden çıkarılan ya da e-postası değişen kişi jetonu bitmeden de reddedilir). Değilse `403 FORBIDDEN`,
 * gövdeye bakılmadan (yönetici olmayan şifre denemesi yapamaz, kovası da dolmaz).
 */
export async function requirePlatformOperator(req: FastifyRequest) {
  await requireWebSession(req);
  const person = await prisma.person.findUnique({
    where: { id: (req.principal as Principal).personId },
    select: { email: true, emailVerifiedAt: true, suspendedAt: true },
  });
  if (!person || !isPlatformOperator(person)) throw forbidden();
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function memberOf(req: FastifyRequest): MemberContext {
  if (!req.member) throw unauthorized();
  return req.member;
}

// ---------- CSRF ----------

/**
 * İsteğin kökeni bu uçta ne sayılır: uygulama (ALLOWED_ORIGINS), site (SITE_ORIGINS, yalnız `siteOrigin` işaretli uçta) ya da hiçbiri.
 * CORS ve CSRF aynı karardan beslenir: biri site kökenine açıp öbürü kapatamaz.
 */
export function originKind(req: FastifyRequest): 'app' | 'site' | null {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return null;
  const value = origin.toLowerCase();
  if (env.allowedOrigins.has(value)) return 'app';
  if (req.routeOptions.config?.siteOrigin === true && env.siteOrigins.has(value)) return 'site';
  return null;
}

function originAllowed(req: FastifyRequest): boolean {
  return originKind(req) !== null;
}

/**
 * Çerezli yazma isteklerinde `X-SOD-CSRF: 1` + izinli `Origin` zorunlu. Bearer isteklerinde gerekmez.
 * Çerez yazan uçlar (`setsCookies`) çerez olmadan da denetlenir: yabancı site kurbanı kendi hesabına sokamasın.
 * `client: mobile` gövdesi çerez yazmaz, yalnız yanıt gövdesi döner; onu okumak da CORS'a takılır.
 */
async function csrfGuard(req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers.authorization !== undefined) return;
  const hasSessionCookie = Boolean(req.cookies?.[COOKIE_ACCESS] || req.cookies?.[COOKIE_REFRESH]);
  const setsCookies = req.routeOptions.config.setsCookies === true && (req.body as { client?: unknown } | null | undefined)?.client !== 'mobile';
  if (!hasSessionCookie && !setsCookies) return;
  if (req.headers[CSRF_HEADER] !== '1' || !originAllowed(req)) throw new AppError(403, 'CSRF_FAILED');
}

export function registerAuthHooks(app: FastifyInstance) {
  app.decorateRequest('principal', null);
  app.decorateRequest('member', null);
  app.addHook('preHandler', csrfGuard);
}

// ---------- Çerezler ----------

function baseCookie() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: env.cookieSecure };
}

export function setAccessCookie(reply: FastifyReply, accessToken: string) {
  void reply.setCookie(COOKIE_ACCESS, accessToken, { ...baseCookie(), path: PATH_ACCESS_COOKIE, maxAge: ACCESS_TTL_SECONDS });
}

export function setRefreshCookie(reply: FastifyReply, refreshToken: string) {
  void reply.setCookie(COOKIE_REFRESH, refreshToken, { ...baseCookie(), path: PATH_REFRESH_COOKIE, maxAge: REFRESH_TTL_SECONDS });
}

export function clearSessionCookies(reply: FastifyReply) {
  void reply.clearCookie(COOKIE_ACCESS, { ...baseCookie(), path: PATH_ACCESS_COOKIE });
  void reply.clearCookie(COOKIE_REFRESH, { ...baseCookie(), path: PATH_REFRESH_COOKIE });
}

/** Dil çerezi HttpOnly değildir, üretimde üst alan adında durur (ARCHITECTURE §9). Oturum çerezleri alan almaz. */
export function setLangCookie(reply: FastifyReply, locale: Locale) {
  void reply.setCookie(COOKIE_LANG, locale, {
    httpOnly: false,
    sameSite: 'lax',
    secure: env.cookieSecure,
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
    ...(env.cookieLangDomain ? { domain: env.cookieLangDomain } : {}),
  });
}

// ---------- Oturum yanıtı ----------

/**
 * Tüm oturum uçlarının ortak yanıtı.
 * Web: jetonlar çerezde, gövdede yok. Mobil: gövdede.
 * `refreshToken` null: yenileme jetonu değişmedi, istemci elindekini korur.
 */
export async function sendSession(
  reply: FastifyReply,
  input: {
    person: { id: string; name: string; locale: Locale };
    session: { id: string; activeOrgId: string | null; client: ClientKind };
    refreshToken: string | null;
    includeMe?: boolean;
    status?: number;
    /** Uca özgü ek alanlar (ör. `POST /org/close`: kapanış anları). Oturum alanlarını ezemez. */
    extra?: Record<string, unknown>;
  },
) {
  const { accessToken, activeOrgId, expiresIn } = await signForSession(prisma, input.person, input.session);
  const body: AuthResponse & Record<string, unknown> = { ...input.extra, expiresIn, activeOrgId };
  if (input.includeMe !== false) body.me = await buildMe(prisma, input.person.id, activeOrgId);
  if (input.session.client === 'web') {
    setAccessCookie(reply, accessToken);
    if (input.refreshToken) setRefreshCookie(reply, input.refreshToken);
    setLangCookie(reply, input.person.locale);
  } else {
    body.accessToken = accessToken;
    if (input.refreshToken) body.refreshToken = input.refreshToken;
  }
  return reply.status(input.status ?? 200).send(body);
}
