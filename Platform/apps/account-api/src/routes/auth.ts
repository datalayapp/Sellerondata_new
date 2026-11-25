import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COOKIE_REFRESH, localeFromAcceptLanguage, type VerifyEmailResponse } from '@sellerondata/contracts';
import { Prisma, prisma } from '../db.ts';
import { env } from '../env.ts';
import { AppError, unauthorized } from '../errors.ts';
import { clearSessionCookies, clientMeta, hasDuplicateCookie, optionalAuth, principalOf, requireAuth, sendSession } from '../auth.ts';
import { writeAudit } from '../lib/audit.ts';
import { hashPassword, passwordNeedsRehash, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { ipBucket, normalizeEmail, parseIdentifier } from '../lib/identity.ts';
import {
  emailChangedMail,
  emailChangeVerifyMail,
  emailVerifyMail,
  loginLockedMail,
  passwordChangedMail,
  passwordResetMail,
  queueMail,
  runInBackground,
} from '../lib/mailer.ts';
import { bumpPersonEpochs, lockPersons } from '../lib/members.ts';
import { createOrganizationWithOwner } from '../lib/orgs.ts';
import { assertSignupInviteUsable, consumeSignupInvite, SIGNUP_INVITE_TOKEN_MAX } from '../lib/signupInvites.ts';
import { appendVary, readSiteSession } from '../lib/siteSession.ts';
import {
  clearPersonLoginBuckets,
  clearRateLimit,
  consumeRateLimit,
  enforceRateLimit,
  hitPersonPasswordBuckets,
  hitRateLimit,
  identityKey,
  isKnownDevice,
  personLoginDayKey,
  personLoginKey,
  RATE_RULES,
  refundRateLimit,
  type RateRule,
} from '../lib/rateLimit.ts';
import { clientKind, countryCode, displayName, emailField, existingPassword, newPassword } from '../lib/schemas.ts';
import {
  createSession,
  assertPasswordUnchanged,
  familyHead,
  lockPerson,
  refreshSession,
  revokeAllSessions,
  revokeByRefreshToken,
  revokeFamily,
  touchActiveOrg,
} from '../lib/sessions.ts';

const RESET_TOKEN_TTL_MS = 60 * 60_000;
const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * Kişi ve tür başına aynı anda geçerli en çok jeton.
 * - `PASSWORD_RESET`: tavan doluysa yeni jeton (ve posta) yok; yeni istek eski bağlantıyı öldürmez.
 * - `EMAIL_VERIFY`: tavan doluysa en eski jeton silinir, yenisi üretilir. Bağlantı aynı posta kutusuna gider; kötüye kullanımı
 *   kişi başına posta sınırı (`verify:mail`) tutar. Böylece "yeniden gönder" günlerce boşa dönmez.
 */
export const MAX_ACTIVE_TOKENS = 3;

/** Oturumsuz "yeniden gönder" kovası: yazılan adrese göre (kişi olsun olmasın). Girişteki kendiliğinden gönderim de sayar. */
export const verifyResendKey = (email: string) => `verifyResend:id:${identityKey(email)}`;

const registerSchema = z.object({
  orgName: displayName,
  name: displayName,
  email: emailField,
  password: newPassword,
  country: countryCode.default('TR'),
  locale: z.enum(['tr', 'en']).optional(),
  client: clientKind,
  /**
   * Kayıt daveti jetonu (`/register?invite=`). Yalnız `SIGNUP_MODE=invite` iken okunur ve denetlenir (`signupInviteOf`);
   * `open` kipinde ne olursa olsun yok sayılır: eski sekmeden gelen uzun ya da bozuk bağlantı kaydı 400'e düşürmesin.
   */
  signupInvite: z.unknown().optional(),
});

/**
 * `invite` kipinde gövdedeki davet: yok ya da boşsa 403 `SIGNUP_INVITE_REQUIRED`; metin değilse ya da jeton boyunu aşıyorsa
 * 403 `SIGNUP_INVITE_INVALID` (veritabanına hiç sorulmaz).
 */
function signupInviteOf(raw: unknown): string {
  const token = typeof raw === 'string' ? raw.trim() : raw;
  if (token === undefined || token === null || token === '') throw new AppError(403, 'SIGNUP_INVITE_REQUIRED');
  if (typeof token !== 'string' || token.length > SIGNUP_INVITE_TOKEN_MAX) throw new AppError(403, 'SIGNUP_INVITE_INVALID');
  return token;
}

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: existingPassword,
  client: clientKind,
});

/**
 * `retryKey` (6.8): istemcinin bu yenileme için ürettiği rastgele anahtar (en az 128 bit; mobil 32 bayt onaltılık). Aynı eski jetonla
 * birlikte tekrarlanırsa süre toleransı aranmaz (`refreshSession`). Yalnız yenilemede anlamlıdır; çıkış yok sayar.
 */
const tokenBody = z.object({
  refreshToken: z.string().min(1).max(200).optional(),
  retryKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,128}$/)
    .optional(),
});

/**
 * Yeni tek kullanımlık jeton. Tavanın altındayken eski jetonları SİLMEZ: saldırgan yeni istekle kurbanın elindeki bağlantıyı
 * öldüremesin (§11). Tavan doluysa `MAX_ACTIVE_TOKENS` kuralı (türe göre); `PASSWORD_RESET`'te null döner, çağıran sessizce geçer.
 * `email`: jetonun kanıtlayacağı adres. Kişi kilidi altında sayılır: eşzamanlı iki istek tavanı aşamaz.
 */
export async function issueOneTimeToken(
  tx: Prisma.TransactionClient,
  personId: string,
  kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY',
  ttlMs: number,
  email: string | null = null,
): Promise<string | null> {
  await lockPerson(tx, personId);
  const activeWhere = { personId, kind, usedAt: null, expiresAt: { gt: new Date() } };
  const active = await tx.oneTimeToken.findMany({ where: activeWhere, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  if (active.length >= MAX_ACTIVE_TOKENS) {
    if (kind === 'PASSWORD_RESET') return null;
    const drop = active.slice(0, active.length - MAX_ACTIVE_TOKENS + 1).map((t) => t.id);
    await tx.oneTimeToken.deleteMany({ where: { id: { in: drop } } });
  }
  const token = randomToken();
  await tx.oneTimeToken.create({
    data: { personId, kind, email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

export type VerificationPurpose = 'verify' | 'change';

/**
 * Doğrulama postası. `verify`: kişinin doğrulanmamış mevcut adresine. `change`: bekleyen adrese (§3.3).
 * Adres kilit altında yeniden okunur: bu arada değiştiyse ya da doğrulandıysa posta gitmez.
 * `limited`: kişi başına posta sınırı (`verify:mail`, aşınca sessiz). Sınırı kendisi 429 ile uygulayan uç `false` verir.
 */
export async function deliverVerificationMail(
  personId: string,
  email: string,
  locale: 'tr' | 'en',
  opts: { purpose?: VerificationPurpose; limited?: boolean } = {},
): Promise<boolean> {
  const purpose = opts.purpose ?? 'verify';
  if (opts.limited !== false && !(await consumeRateLimit(`verify:mail:${personId}`, RATE_RULES.verifyMailPerson))) return false;
  const token = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, personId);
    const current = await tx.person.findUnique({ where: { id: personId }, select: { email: true, pendingEmail: true, emailVerifiedAt: true } });
    if (!current) return null;
    const stillValid = purpose === 'change' ? current.pendingEmail === email : current.email === email && !current.emailVerifiedAt;
    if (!stillValid) return null;
    return issueOneTimeToken(tx, personId, 'EMAIL_VERIFY', VERIFY_TOKEN_TTL_MS, email);
  });
  if (!token) return false;
  const url = `${env.appBaseUrl}/verify-email/${token}`;
  queueMail(purpose === 'change' ? emailChangeVerifyMail(email, locale, url) : emailVerifyMail(email, locale, url));
  return true;
}

/** Arka planda: posta sorunu tamamlanmış kaydı 500'e çevirmesin. */
export function sendVerificationMail(
  personId: string,
  email: string,
  locale: 'tr' | 'en',
  opts: { purpose?: VerificationPurpose; limited?: boolean } = {},
) {
  runInBackground(async () => {
    await deliverVerificationMail(personId, email, locale, opts);
  });
}

/** Tek kullanımlık jetonu atomik olarak harcar. Süresi dolmuş, kullanılmış veya yanlış türde ise null. */
async function consumeOneTimeToken(tx: Prisma.TransactionClient, token: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY') {
  const tokenHash = sha256(token);
  const claimed = await tx.oneTimeToken.updateMany({
    where: { tokenHash, kind, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  return tx.oneTimeToken.findUniqueOrThrow({ where: { tokenHash } });
}

type LoginPerson = { id: string; email: string | null; emailVerifiedAt: Date | null; suspendedAt: Date | null; locale: 'tr' | 'en' };

/** Şifre değişti postası (04-B9): kişinin mevcut adresine, arka planda. Bekleyen adrese gitmez (hesabın anahtarı değildir). */
export function sendPasswordChangedMail(person: { email: string | null; locale: 'tr' | 'en' }) {
  if (!person.email) return;
  void queueMail(passwordChangedMail(person.email, person.locale, `${env.appBaseUrl}/forgot-password`));
}

/**
 * Kilit kaydı pencere başına bir kez: geri verme sayacı sınırın altına indirip yeniden aşırabilir. Kişiye günde en çok bir bilgi
 * postası (04-B6), yalnız doğrulanmış adrese: başkasının adresiyle açılmış hesaba yapılan denemeler o adrese posta yağdırmasın.
 */
async function recordLoginLock(person: LoginPerson, ip: string) {
  const first = await consumeRateLimit(`login:locked:${person.id}`, { limit: 1, windowSeconds: RATE_RULES.loginIdentity.windowSeconds });
  if (!first) return;
  await prisma.$transaction((tx) => writeAudit(tx, { actor: { ip }, action: 'login.locked', target: person.id }));
  if (!person.email || !person.emailVerifiedAt || person.suspendedAt) return;
  if (!(await consumeRateLimit(`login:lockmail:${person.id}`, RATE_RULES.loginLockMail))) return;
  void queueMail(loginLockedMail(person.email, person.locale, `${env.appBaseUrl}/forgot-password`));
}

/**
 * Giriş kimliği ve kişi kovası (ARCHITECTURE §11): önce atomik sayar. Sınır aşıldıysa yalnız kişinin bilinen cihazı (daha önce
 * şifreyle oturum açtığı IP birimi) geçer; bilinmeyen kimlikte de aynı sorgu çalışır, süre farkı varlığı ele vermesin.
 * İstisnayla geçen deneme ayrı kovaya da yazılır (`login:known:<pid>`): istisna sınırsız tahmin kapısı olmasın.
 * Döndürülen anahtarlar şifre doğruysa `refundRateLimit` ile geri verilir: kovalarda yalnız başarısız denemeler kalır.
 */
async function countLoginAttempt(person: LoginPerson | null, idBucket: string, ip: string): Promise<string[]> {
  let known: boolean | undefined;
  const knownDevice = async () => (known ??= await isKnownDevice(person?.id ?? null, ip));
  const counted: string[] = [];
  let viaKnownDevice = false;
  // Kimlik ve kişi kovası 15 dakikalık; kişinin günlük tavanı (04-B6) aynı kuralla: dolu kovada yalnız bilinen cihaz geçer.
  const buckets: [string, RateRule][] = [
    [idBucket, RATE_RULES.loginIdentity],
    ...(person
      ? ([
          [personLoginKey(person.id), RATE_RULES.loginIdentity],
          [personLoginDayKey(person.id), RATE_RULES.loginPersonDay],
        ] as [string, RateRule][])
      : []),
  ];
  for (const [key, rule] of buckets) {
    const { count, retryAfter } = await hitRateLimit(key, rule);
    counted.push(key);
    if (count <= rule.limit) continue;
    if (person && count === rule.limit + 1) await recordLoginLock(person, ip);
    const pass = await knownDevice();
    if (!person || !pass) throw new AppError(429, 'TOO_MANY_ATTEMPTS', undefined, retryAfter);
    viaKnownDevice = true;
  }
  if (person && viaKnownDevice) {
    const key = `login:known:${person.id}`;
    const { count, retryAfter } = await hitRateLimit(key, RATE_RULES.loginKnownDevice);
    counted.push(key);
    if (count > RATE_RULES.loginKnownDevice.limit) throw new AppError(429, 'TOO_MANY_ATTEMPTS', undefined, retryAfter);
  }
  return counted;
}

/**
 * Şifre sınaması, girişle aynı kovalar ve kural (IP, kimlik + IP ikilisi, kişi; önce say, doğruysa geri ver). Bilinen cihaz
 * istisnası yok: bu yol oturumu olmayan (doğrulanmamış) kişi içindir. Yanlış şifrede 401 INVALID_CREDENTIALS.
 */
async function checkPasswordLikeLogin(person: { id: string; email: string; passwordHash: string }, password: string, rawIp: string) {
  const ip = ipBucket(rawIp);
  const pairKey = `login:pair:${identityKey(person.email)}:${ip}`;
  await enforceRateLimit([
    { key: `login:ip:${ip}`, rule: RATE_RULES.loginIp },
    { key: pairKey, rule: RATE_RULES.loginPair },
  ]);
  const counted = await hitPersonPasswordBuckets(person.id);
  if (!(await verifyPassword(person.passwordHash, password))) throw new AppError(401, 'INVALID_CREDENTIALS');
  for (const key of counted) await refundRateLimit(key);
  await clearRateLimit([pairKey]);
}

/**
 * Şifre istenir mi: ilk doğrulama (jetonun adresi kişinin mevcut, doğrulanmamış adresi) ve kişinin şifresi var.
 * `passwordHash` şemada zorunlu ve her oluşturma yolu (kayıt, davet, kod) gerçek şifre yazar; boş özet yalnız elle ya da ileride
 * şifresiz bir akışla oluşabilir. O durumda doğrulama eskisi gibi şifresizdir: sınanacak şifre yok, kişi kilitlenmesin.
 */
function needsPassword(person: { email: string | null; emailVerifiedAt: Date | null; passwordHash: string }, tokenEmail: string | null) {
  const addr = tokenEmail ?? person.email;
  return !!addr && addr === person.email && !person.emailVerifiedAt && person.passwordHash !== '';
}

function refreshTokenFrom(req: FastifyRequest): string | null {
  const body = tokenBody.parse(req.body ?? {});
  if (body.refreshToken) return body.refreshToken;
  if (hasDuplicateCookie(req, COOKIE_REFRESH)) throw unauthorized();
  return req.cookies?.[COOKIE_REFRESH] ?? null;
}

function retryKeyFrom(req: FastifyRequest): string | null {
  return tokenBody.parse(req.body ?? {}).retryKey ?? null;
}

/**
 * Site kökenine açık yazma ucunun ön uçuşu. `@fastify/cors` ön uçuşu kendi `OPTIONS *` rotasında karşılar ve o rota
 * `siteOrigin` taşımaz; bu yüzden uca kardeş, aynı işaretli OPTIONS rotası kaydedilir. İzinli kökene yanıtı CORS kancası
 * verir (204); buraya ulaşan istek izinsizdir ve eklentinin kendi rotası gibi 404 alır.
 */
function sitePreflight(app: FastifyInstance, url: string) {
  app.options(url, { config: { siteOrigin: true } }, async (_req, reply) => reply.callNotFound());
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', { config: { setsCookies: true } }, async (req, reply) => {
    if (!env.registrationEnabled) throw new AppError(403, 'REGISTRATION_CLOSED');
    // Önce biçim: yazım hatası kayıt hakkını yemesin.
    const body = registerSchema.parse(req.body);
    // Kapalı deneme (2026-11-12): davetsiz istek kayıt hakkını yemeden durur. Davetin kendisi aşağıda, işlemin içinde harcanır.
    const invite = env.signupMode === 'invite' ? signupInviteOf(body.signupInvite) : undefined;
    await enforceRateLimit([{ key: `register:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.registerIp }]);
    const email = normalizeEmail(body.email);
    const locale = body.locale ?? localeFromAcceptLanguage(req.headers['accept-language']);
    const passwordHash = await hashPassword(body.password);

    const { person, session, refreshToken } = await prisma.$transaction(async (tx) => {
      // Önce davet: geçerli davet yoksa "adres kullanılıyor" yanıtı da verilmez (kayıt ucu adres yoklamasına dönmesin).
      if (invite) await assertSignupInviteUsable(tx, invite, email);
      if (await tx.person.findUnique({ where: { email }, select: { id: true } })) throw new AppError(409, 'EMAIL_TAKEN');
      const person = await tx.person.create({ data: { name: body.name, email, passwordHash, locale } });
      const { org } = await createOrganizationWithOwner(tx, { personId: person.id, name: body.orgName, country: body.country, locale, ip: req.ip });
      // Tutmayan davet (yanlış adres, kullanılmış, süresi geçmiş) bütün işlemi geri alır: kişi ve firma açılmaz.
      if (invite) await consumeSignupInvite(tx, { token: invite, email, personId: person.id, orgId: org.id, ip: req.ip });
      if (env.emailVerificationRequired) return { person, session: null, refreshToken: null };
      const { session, refreshToken } = await createSession(tx, { person, client: body.client, meta: clientMeta(req), preferredOrgId: org.id });
      return { person, session, refreshToken };
    });

    sendVerificationMail(person.id, email, locale);
    // Doğrulama zorunluysa oturum verilmez: e-posta doğrulanana kadar başkasının adresiyle hesap kullanılamasın.
    if (!session) return reply.status(202).send({ verificationRequired: true });
    return sendSession(reply, { person, session, refreshToken, status: 201 });
  });

  app.post('/auth/login', { config: { setsCookies: true } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const parsed = parseIdentifier(body.identifier);
    const canonical = parsed.kind === 'email' ? parsed.email : parsed.kind === 'phone' ? parsed.phone : body.identifier.toLowerCase();
    const idKey = identityKey(canonical);
    const ip = ipBucket(req.ip);
    const pairKey = `login:pair:${idKey}:${ip}`;
    // Saldırganın elindeki kovalar önce: dolunca kimlik kovasına yazılmaz. Tek IP kimlik kovasına pencerede en çok `loginPair` deneme ekler.
    await enforceRateLimit([
      { key: `login:ip:${ip}`, rule: RATE_RULES.loginIp },
      { key: pairKey, rule: RATE_RULES.loginPair },
    ]);

    const person =
      parsed.kind === 'email'
        ? await prisma.person.findUnique({ where: { email: parsed.email } })
        : parsed.kind === 'phone'
          ? await prisma.person.findUnique({ where: { phone: parsed.phone } })
          : null;

    // E-posta ve telefon aynı kişinin iki kapısı: deneme kişi başına da sayılır (davet kabulüyle ortak kova).
    const counted = await countLoginAttempt(person, `login:id:${idKey}`, req.ip);

    // Kişi yoksa da aynı doğrulama çalışır: süre ve yanıt aynı kalır.
    const ok = await verifyPassword(person?.passwordHash, body.password);
    if (!person || !ok) throw new AppError(401, 'INVALID_CREDENTIALS');

    // Şifre doğru: bu denemenin payı geri verilir.
    for (const key of counted) await refundRateLimit(key);
    await clearRateLimit([pairKey]);

    if (env.emailVerificationRequired && person.email && !person.emailVerifiedAt) {
      // Posta kendiliğinden yeniden gider; kişi başına posta sınırına takılırsa sessizce gitmez. Yeniden gönderme kovasına da
      // sayılır (sonucu beklenmez, giriş yanıtı değişmez): ekrandaki "yeniden gönder" kişi kovası dolmadan dürüstçe 429 alsın (Y39).
      // Yalnız şifre doğruyken sayılır: şifreyi bilmeyen bu yoldan kovayı dolduramaz.
      await hitRateLimit(verifyResendKey(person.email), RATE_RULES.verifyResendIdentity);
      sendVerificationMail(person.id, person.email, person.locale);
      throw new AppError(403, 'EMAIL_NOT_VERIFIED');
    }

    const newHash = passwordNeedsRehash(person.passwordHash) ? await hashPassword(body.password) : null;
    const { session, refreshToken } = await prisma.$transaction(async (tx) => {
      // Doğrulama işlem dışındaydı: bu arada şifre değiştiyse eski şifre oturum açamaz, yeniden özetleme de yeni şifreyi ezemez.
      await assertPasswordUnchanged(tx, person.id, person.passwordHash);
      if (newHash) await tx.person.update({ where: { id: person.id }, data: { passwordHash: newHash } });
      const fresh = await tx.person.findUniqueOrThrow({ where: { id: person.id }, select: { id: true, lastOrgId: true } });
      const created = await createSession(tx, { person: fresh, client: body.client, meta: clientMeta(req) });
      await writeAudit(tx, {
        actor: { personId: person.id, ip: req.ip },
        action: 'session.created',
        target: created.session.familyId,
        meta: { client: body.client },
      });
      return created;
    });
    return sendSession(reply, { person, session, refreshToken });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token = refreshTokenFrom(req);
    if (!token) throw unauthorized();
    const retryKey = retryKeyFrom(req);
    const outcome = await prisma.$transaction((tx) => refreshSession(tx, token, clientMeta(req), retryKey));
    if (outcome.kind !== 'rotated') {
      clearSessionCookies(reply);
      throw unauthorized();
    }
    const person = await prisma.person.findUniqueOrThrow({ where: { id: outcome.session.personId } });
    if (env.emailVerificationRequired && person.email && !person.emailVerifiedAt) {
      clearSessionCookies(reply);
      throw new AppError(403, 'EMAIL_NOT_VERIFIED');
    }
    return sendSession(reply, { person, session: outcome.session, refreshToken: outcome.refreshToken, includeMe: false });
  });

  // Tanıtım sitesinin "kimim" yoklaması. Yenileme çerezinin yolu altında: `sod_rt` yalnız buraya gider. Salt okunur (lib/siteSession.ts).
  app.get('/auth/site-session', { config: { siteOrigin: true } }, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    appendVary(reply, 'Origin', 'Cookie');
    await enforceRateLimit([{ key: `site-session:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.siteSessionIp }]);
    return readSiteSession(req);
  });

  // Site kökeninden de çağrılır (sitedeki "Çıkış yap"): CSRF başlığı ve SITE_ORIGINS içindeki Origin ile.
  sitePreflight(app, '/auth/logout');
  app.post('/auth/logout', { config: { siteOrigin: true } }, async (req, reply) => {
    const token = refreshTokenFrom(req);
    // Süresi geçmiş erişim jetonu kimlik saymaz (principal null): çıkış yalnız geçerli jetonun ya da yenileme jetonunun sahibini etkiler.
    await optionalAuth(req, { ignoreExpired: true });
    const principal = req.principal;
    await prisma.$transaction(async (tx) => {
      // Kilit sırası kişi, sonra üyelik (ARCHITECTURE §5). Çerez ve Bearer farklı kişilerden gelebilir: kilit kimliğe göre sıralı.
      const owner = token ? await tx.session.findUnique({ where: { refreshHash: sha256(token) }, select: { personId: true } }) : null;
      await lockPersons(tx, [owner?.personId, principal?.personId].filter((id): id is string => !!id));
      // Yalnız gerçekten bir oturum kapandıysa: iptal edilmiş ailenin eski jetonuyla tekrar tekrar çıkış epoch'u şişiremez.
      const people = new Set<string>();
      if (token) {
        const result = await revokeByRefreshToken(tx, token);
        if (result && result.revoked > 0) people.add(result.personId);
      }
      if (principal) {
        if ((await revokeFamily(tx, principal.familyId)) > 0) people.add(principal.personId);
      }
      // Ürünlerdeki açık erişim jetonu da hemen düşsün (02-B5). Kişinin diğer cihazları bir kez sessizce yenilenir.
      for (const personId of [...people].sort()) await bumpPersonEpochs(tx, personId);
    });
    clearSessionCookies(reply);
    return { ok: true };
  });

  app.post('/auth/switch-org', { preHandler: requireAuth }, async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().min(1).max(64) }).parse(req.body);
    const principal = principalOf(req);
    const membership = await prisma.membership.findFirst({
      where: { personId: principal.personId, orgId, status: 'ACTIVE' },
      select: { id: true, org: { select: { closedAt: true } } },
    });
    // Firma var mı yok mu ele verilmez.
    if (!membership) throw new AppError(404, 'NOT_FOUND');
    // Kapalı firma etkin olamaz. Üyeler onu listede görmez; sahip Merkez'in "geri aç" ekranını kullanır.
    if (membership.org.closedAt) throw new AppError(409, 'ORG_CLOSED');

    const { person, head } = await prisma.$transaction(async (tx) => {
      await lockPerson(tx, principal.personId);
      const head = await familyHead(tx, principal.familyId);
      if (!head) throw unauthorized();
      // Kişi kilidi altında yeniden: kapatma işlemi üyelerin kişi satırlarını kilitler, arada kapanan firma etkin yazılmasın.
      const still = await tx.organization.findUnique({ where: { id: orgId }, select: { closedAt: true } });
      if (!still || still.closedAt) throw new AppError(409, 'ORG_CLOSED');
      const updated = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: orgId } });
      await touchActiveOrg(tx, principal.personId, orgId);
      const person = await tx.person.findUniqueOrThrow({ where: { id: principal.personId } });
      return { person, head: updated };
    });
    return sendSession(reply, { person, session: head, refreshToken: null });
  });

  app.post('/auth/forgot-password', async (req) => {
    const { identifier } = z.object({ identifier: z.string().trim().min(1).max(254) }).parse(req.body);
    const parsed = parseIdentifier(identifier);
    const canonical = parsed.kind === 'email' ? parsed.email : parsed.kind === 'phone' ? parsed.phone : identifier.toLowerCase();
    await enforceRateLimit([{ key: `forgot:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.forgotIp }]);
    // Kimlik sınırı aşılınca hata değil aynı yanıt: kurban 429 görmez, saldırgan sınırı ölçemez. Posta gitmez.
    if (!(await consumeRateLimit(`forgot:id:${identityKey(canonical)}`, RATE_RULES.forgotIdentity))) return { ok: true };

    // Arka planda: yanıt ve süresi kişi olsa da olmasa da aynı.
    runInBackground(async () => {
      if (parsed.kind === 'invalid') return;
      const person = await prisma.person.findUnique({
        where: parsed.kind === 'email' ? { email: parsed.email } : { phone: parsed.phone },
      });
      // Yalnız mevcut adrese: bekleyen adres hesabın anahtarı değildir.
      const email = person?.email;
      if (!person || !email) return;
      const token = await prisma.$transaction((tx) => issueOneTimeToken(tx, person.id, 'PASSWORD_RESET', RESET_TOKEN_TTL_MS, email));
      if (!token) return;
      queueMail(passwordResetMail(email, person.locale, `${env.appBaseUrl}/reset-password/${token}`));
    });
    return { ok: true };
  });

  app.post('/auth/reset-password', async (req, reply) => {
    await enforceRateLimit([{ key: `reset:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.resetIp }]);
    const body = z.object({ token: z.string().min(1).max(200), password: newPassword }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    // Kilit sırası her yerde kişi, sonra jeton (ARCHITECTURE §5): sahibi önce okunur, kilitlenir, sonra jeton harcanır.
    const owner = await prisma.oneTimeToken.findUnique({ where: { tokenHash: sha256(body.token) }, select: { personId: true } });
    if (!owner) throw new AppError(400, 'TOKEN_INVALID');
    const changed = await prisma.$transaction(async (tx) => {
      await lockPerson(tx, owner.personId);
      const used = await consumeOneTimeToken(tx, body.token, 'PASSWORD_RESET');
      if (!used) throw new AppError(400, 'TOKEN_INVALID');
      const person = await tx.person.findUniqueOrThrow({ where: { id: used.personId }, select: { email: true, phone: true, locale: true } });
      // Jeton gönderildiği adrese bağlı. Adres değişince bütün jetonlar zaten silinir; bu ikinci kattır.
      if (!person.email || (used.email !== null && used.email !== person.email)) throw new AppError(400, 'TOKEN_INVALID');
      // Bağlantı e-postaya gitti: e-posta sahipliği de kanıtlanmış olur.
      await tx.person.update({ where: { id: used.personId }, data: { passwordHash, emailVerifiedAt: new Date() } });
      await tx.oneTimeToken.deleteMany({ where: { personId: used.personId, usedAt: null } });
      await revokeAllSessions(tx, used.personId);
      await bumpPersonEpochs(tx, used.personId);
      await writeAudit(tx, { actor: { personId: used.personId, ip: req.ip }, action: 'person.password_reset', target: used.personId });
      return { personId: used.personId, email: person.email, phone: person.phone, locale: person.locale };
    });
    // Yeni şifre posta kutusunu kanıtladı: eski şifreye yapılan tahminlerin kilidi kalkar (04-B6), kişi yeni yerden de girer.
    await clearPersonLoginBuckets(changed.personId, [changed.email, changed.phone]);
    sendPasswordChangedMail(changed);
    clearSessionCookies(reply);
    return { ok: true };
  });

  /**
   * Doğrulama bağlantısı (§3.3). Jeton bir adrese bağlıdır (`token.email`; göçten önceki jetonda kişinin o anki adresi):
   * - adres kişinin mevcut adresi: adres doğrulanır (`verified`). İLK doğrulamada (adres henüz doğrulanmamış) şifre istenir:
   *   bağlantı adresi kanıtlar ama şifreyi kimin koyduğunu kanıtlamaz (başkasının adresiyle kayıt, yöneticinin davetliye şifre
   *   koyması). Şifre yoksa `401 PASSWORD_REQUIRED`, yanlışsa `401 INVALID_CREDENTIALS`; ikisinde de jeton harcanmaz.
   *   Gerçek sahibin çıkış yolu "şifremi unuttum"dur: sıfırlama adresi de doğrular, önceki şifre ölür.
   * - adres bekleyen adres: değişiklik onaylanır, eski adrese haber gider (`changed`). Şifre istenmez: isteyen `currentPassword` verdi.
   * - başka her adres (eski bekleyen adres, değişmiş mevcut adres): `TOKEN_INVALID`.
   * Kullanılmış jeton, adresi kişinin şimdiki doğrulanmış adresiyse `already` döner: sayfa yenilenince "geçersiz" görünmesin.
   * Kilit sırası kişi, sonra jeton.
   */
  app.post('/auth/verify-email', async (req): Promise<VerifyEmailResponse> => {
    await enforceRateLimit([{ key: `reset:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.resetIp }]);
    const { token, password } = z.object({ token: z.string().min(1).max(200), password: existingPassword.optional() }).parse(req.body);

    // İşlem dışında bakış: şifre (argon2) uzun sürer, kilit altında yapılmaz. Kilit altında koşul yeniden denetlenir.
    const peek = await prisma.oneTimeToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: { personId: true, kind: true, usedAt: true, expiresAt: true, email: true },
    });
    let checkedHash: string | null = null;
    if (peek && peek.kind === 'EMAIL_VERIFY' && !peek.usedAt && peek.expiresAt > new Date()) {
      const person = await prisma.person.findUniqueOrThrow({ where: { id: peek.personId } });
      if (needsPassword(person, peek.email) && person.email) {
        if (!password) throw new AppError(401, 'PASSWORD_REQUIRED');
        await checkPasswordLikeLogin({ id: person.id, email: person.email, passwordHash: person.passwordHash }, password, req.ip);
        checkedHash = person.passwordHash;
      }
    }

    const outcome = await prisma.$transaction(async (tx) => {
      if (peek) await lockPerson(tx, peek.personId);
      const used = await consumeOneTimeToken(tx, token, 'EMAIL_VERIFY');
      if (!used) {
        const spent = await tx.oneTimeToken.findUnique({
          where: { tokenHash: sha256(token) },
          select: { kind: true, usedAt: true, email: true, person: { select: { email: true, emailVerifiedAt: true } } },
        });
        const addr = spent ? (spent.email ?? spent.person.email) : null;
        if (spent?.kind === 'EMAIL_VERIFY' && spent.usedAt && addr && addr === spent.person.email && spent.person.emailVerifiedAt) {
          return { result: 'already' as const };
        }
        throw new AppError(400, 'TOKEN_INVALID');
      }
      const person = await tx.person.findUniqueOrThrow({ where: { id: used.personId } });
      const addr = used.email ?? person.email;
      const actor = { personId: person.id, ip: req.ip };

      // Bakıştan sonra durum değiştiyse (ör. şifre değişti, adres doğrulanmamış hale geldi) harcama geri alınır.
      if (needsPassword(person, used.email)) {
        if (checkedHash === null) throw new AppError(401, 'PASSWORD_REQUIRED');
        if (checkedHash !== person.passwordHash) throw new AppError(401, 'INVALID_CREDENTIALS');
      }

      if (addr && addr === person.email) {
        if (!person.emailVerifiedAt) {
          await tx.person.update({ where: { id: person.id }, data: { emailVerifiedAt: new Date() } });
          await writeAudit(tx, { actor, action: 'person.email_verified', target: person.id });
        }
        // Aynı adrese giden diğer bağlantılar işini gördü. Bekleyen adresin bağlantıları kalır.
        await tx.oneTimeToken.deleteMany({
          where: { personId: person.id, kind: 'EMAIL_VERIFY', usedAt: null, OR: [{ email: addr }, { email: null }] },
        });
        return { result: 'verified' as const };
      }

      if (addr && addr === person.pendingEmail) {
        // Bekleyen adres benzersiz değildir: başkası bu arada aynı adresle kayıt olmuş olabilir. Yarışta P2002 de 409 EMAIL_TAKEN olur.
        const owner = await tx.person.findUnique({ where: { email: addr }, select: { id: true } });
        if (owner && owner.id !== person.id) throw new AppError(409, 'EMAIL_TAKEN');
        await tx.person.update({ where: { id: person.id }, data: { email: addr, pendingEmail: null, emailVerifiedAt: new Date() } });
        // Eski adrese giden sıfırlama ve doğrulama bağlantıları hesabı geri alma yolu olarak kalmasın.
        await tx.oneTimeToken.deleteMany({ where: { personId: person.id, usedAt: null } });
        await writeAudit(tx, { actor, action: 'person.identity_changed', target: person.id, meta: { email: true } });
        return { result: 'changed' as const, previous: person.email, locale: person.locale };
      }

      throw new AppError(400, 'TOKEN_INVALID');
    });
    if (outcome.result === 'changed' && outcome.previous) {
      queueMail(emailChangedMail(outcome.previous, outcome.locale, `${env.appBaseUrl}/login`));
    }
    return { ok: true, result: outcome.result };
  });

  /**
   * Doğrulama postasını yeniden ister (oturumsuz). Yanıt her zaman aynı; iş arka planda yürür, kişinin varlığı ele verilmez.
   * Yalnız doğrulanmamış mevcut adrese gider: bekleyen adrese bu uçtan posta gitmez.
   * Kimlik kovası doluysa `429` (Y39): ekran "gönderildi" yerine "biraz sonra deneyin" der. Kova yazılan adrese göre sayılır, kişi
   * olsun olmasın aynı dolar: yanıt varlığı ele vermez. Girişteki kendiliğinden gönderim de bu kovayı sayar (bkz. `/auth/login`).
   */
  app.post('/auth/resend-verification', async (req) => {
    const { email } = z.object({ email: emailField }).parse(req.body);
    await enforceRateLimit([
      { key: `verifyResend:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.verifyResendIp },
      { key: verifyResendKey(email), rule: RATE_RULES.verifyResendIdentity },
    ]);
    runInBackground(async () => {
      const person = await prisma.person.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerifiedAt: true, suspendedAt: true, locale: true },
      });
      if (!person?.email || person.emailVerifiedAt || person.suspendedAt) return;
      await deliverVerificationMail(person.id, person.email, person.locale);
    });
    return { ok: true };
  });
}
