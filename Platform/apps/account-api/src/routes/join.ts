import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JOIN_CODE_MAX_ATTEMPTS, type JoinPreview, localeFromAcceptLanguage } from '@sellerondata/contracts';
import { prisma, Prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { AppError, validation } from '../errors.ts';
import { clientMeta, optionalAuth, sendSession } from '../auth.ts';
import { writeAudit } from '../lib/audit.ts';
import { hashPassword, isKnownPepper, joinCodeCandidates, normalizeJoinCode, safeEqual, sha256, verifyPassword } from '../lib/crypto.ts';
import { ipBucket, normalizePhone } from '../lib/identity.ts';
import { bumpPersonEpochs, createMembershipWithRoles, invitedProductRoles, inviterStillAuthorized, lockPersons } from '../lib/members.ts';
import { lockInvitationRoleProducts } from '../lib/roleBook.ts';
import { clearPersonLoginBuckets, enforceRateLimit, hitPersonPasswordBuckets, identityKey, RATE_RULES, refundRateLimit } from '../lib/rateLimit.ts';
import { clientKind, displayName, existingPassword, newPassword } from '../lib/schemas.ts';
import { createSession, familyHead, revokeAllSessions, touchActiveOrg } from '../lib/sessions.ts';
import { sendVerificationMail } from './auth.ts';

/**
 * Bir telefondaki bekleyen kodların ortak yanlış deneme hakkı. Kod tahmin edilemeyecek kadar uzun; asıl fren IP ve ikili kovası.
 * Hak bütün bekleyen kodlardan birlikte düşer: küçük tutulursa saldırgan kurbanın kodunu birkaç denemede yakardı (02-B6).
 */
export const MAX_CODE_ATTEMPTS = JOIN_CODE_MAX_ATTEMPTS;

// `linkCurrentAccount`: kişi açık oturumundaki hesaba bağlamayı açıkça seçti. Seçmediyse oturum yok sayılır: kod başka biri için
// olabilir (kullanıcı isteği 2026-11-13; önceden açık oturum "Bu davet başka bir hesap için" hatası veriyordu).
const joinBody = z.object({ phone: z.string().trim().min(1).max(40), code: z.string().trim().min(1).max(32), linkCurrentAccount: z.boolean().optional() });

type PendingCode = {
  id: string;
  orgId: string;
  kind: 'EMAIL' | 'PHONE_CODE' | 'PHONE_RESET';
  name: string | null;
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  productRoles: Prisma.JsonValue;
  tokenHash: string;
  attempts: number;
  invitedById: string;
  targetPersonId: string | null;
};

/**
 * Telefondaki bekleyen kodları kilitleyip okur. Paralel tahminler sıraya girer: deneme sınırı yarışla aşılamaz.
 * Süresi dolmuş, tükenmiş, iptal edilmiş veya kabul edilmiş kod hiç gelmez.
 */
async function lockPendingCodes(tx: Tx, phone: string): Promise<PendingCode[]> {
  return tx.$queryRaw<PendingCode[]>`
    SELECT "id", "orgId", "kind", "name", "orgRole", "productRoles", "tokenHash", "attempts", "invitedById", "targetPersonId"
    FROM "platform"."Invitation"
    WHERE "phone" = ${phone}
      AND "kind" IN ('PHONE_CODE', 'PHONE_RESET')
      AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
      AND "expiresAt" > now()
      AND "attempts" < ${MAX_CODE_ATTEMPTS}
    ORDER BY "id"
    FOR UPDATE`;
}

/** Kilitsiz bakış (`lockPendingCodes` ile aynı süzgeç): kabulün ürün rol kilidini kişi ve davet kilidinden önce alabilmesi için. */
async function peekPendingCodes(tx: Tx, phone: string) {
  return tx.invitation.findMany({
    where: { phone, kind: 'PHONE_CODE', acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_CODE_ATTEMPTS } },
    select: { orgId: true, productRoles: true },
  });
}

/** Biçimi geçersiz kod sayılmaz: yazım hatası hak yemesin. Yanlış kod: telefondaki tüm bekleyen kodların hakkı azalır. Saldırgan hangi firmaya ait olduğunu bilemez. */
async function countWrongAttempt(tx: Tx, ids: string[]) {
  if (ids.length) await tx.invitation.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 } } });
}

function findMatch(pending: PendingCode[], phone: string, code: string | null): PendingCode | undefined {
  if (!code) return undefined;
  const candidates = joinCodeCandidates(phone, code);
  return pending.find((p) => candidates.some((hash) => safeEqual(p.tokenHash, hash)));
}

/** Biberi artık bilinmeyen kod doğrulanamaz: yanlış tahmin sayılmaz, hak yakılmaz. */
const countable = (pending: PendingCode[]) => pending.filter((p) => isKnownPepper(p.tokenHash)).map((p) => p.id);

function parsePhone(input: string): string {
  const phone = normalizePhone(input);
  if (!phone) throw validation('phone', 'invalid_phone');
  return phone;
}

/** Kod hala kurallara uyuyor mu? Üretildikten sonra kişi başka firmaya girmiş veya e-posta eklemiş olabilir. */
async function resetTargetStillEligible(tx: Tx, invitation: PendingCode, phone: string) {
  if (!invitation.targetPersonId) return null;
  const person = await tx.person.findUnique({
    where: { id: invitation.targetPersonId },
    include: { memberships: { select: { orgId: true, status: true, orgRole: true } } },
  });
  if (!person || person.phone !== phone || person.email || person.suspendedAt) return null;
  if (person.memberships.length !== 1) return null;
  const only = person.memberships[0];
  if (only.orgId !== invitation.orgId || only.status !== 'ACTIVE') return null;
  // Kod üretildiği andaki role bağlı. Sonradan yükselen kişiyi üreten yönetici yönetemez, hesabını da alamaz.
  if (only.orgRole !== invitation.orgRole) return null;
  return person;
}

type AcceptResult =
  | { kind: 'error'; error: AppError }
  | {
      kind: 'ok';
      personId: string;
      session: { id: string; activeOrgId: string | null; client: 'web' | 'mobile' };
      refreshToken: string | null;
      created: boolean;
      /** Yöneticinin koduyla şifre yenilendi: kişinin giriş kovaları boşalır (04-B6). */
      passwordReset?: boolean;
    };

export async function joinRoutes(app: FastifyInstance) {
  app.post('/auth/join/preview', async (req) => {
    const body = joinBody.parse(req.body);
    const phone = parsePhone(body.phone);
    const ip = ipBucket(req.ip);
    await enforceRateLimit([
      { key: `join:ip:${ip}`, rule: RATE_RULES.joinIp },
      { key: `join:pair:${identityKey(phone)}:${ip}`, rule: RATE_RULES.joinPair },
    ]);
    const code = normalizeJoinCode(body.code);
    await optionalAuth(req);
    const principal = body.linkCurrentAccount ? req.principal : undefined;

    const result = await prisma.$transaction(async (tx): Promise<JoinPreview | null> => {
      const pending = await lockPendingCodes(tx, phone);
      const match = findMatch(pending, phone, code);
      if (!match) {
        if (code) await countWrongAttempt(tx, countable(pending));
        return null;
      }
      // Kodu üretenin bugünkü yetkisi yetmiyorsa (devir, rol düşürme) kod geçersizdir (03-B1). Doğru kod: hak düşmez.
      if (!(await inviterStillAuthorized(tx, match))) return null;
      const org = await tx.organization.findUniqueOrThrow({ where: { id: match.orgId }, select: { name: true } });
      const person = await tx.person.findUnique({ where: { phone }, select: { id: true, name: true } });
      if (match.kind === 'PHONE_RESET') {
        if (!(await resetTargetStillEligible(tx, match, phone))) return null;
        return { orgName: org.name, name: person?.name ?? match.name, personExists: true, purpose: 'PASSWORD_RESET' };
      }
      let linksCurrentAccount = false;
      if (!person && principal) {
        const current = await tx.person.findUniqueOrThrow({ where: { id: principal.personId }, select: { phone: true } });
        linksCurrentAccount = current.phone === null;
      }
      return { orgName: org.name, name: match.name, personExists: person !== null, purpose: 'JOIN', linksCurrentAccount };
    });
    if (!result) throw new AppError(400, 'INVITE_INVALID');
    return result;
  });

  app.post('/auth/join/accept', { config: { setsCookies: true } }, async (req, reply) => {
    const body = joinBody
      .extend({
        name: displayName.optional(),
        // Kişi varsa mevcut şifredir: uzunluk kuralı yalnız yeni şifrede uygulanır.
        password: existingPassword,
        client: clientKind,
      })
      .parse(req.body);
    const phone = parsePhone(body.phone);
    const ip = ipBucket(req.ip);
    await enforceRateLimit([
      { key: `join:ip:${ip}`, rule: RATE_RULES.joinIp },
      { key: `join:pair:${identityKey(phone)}:${ip}`, rule: RATE_RULES.joinPair },
    ]);
    const code = normalizeJoinCode(body.code);
    await optionalAuth(req);
    const principal = body.linkCurrentAccount ? req.principal : undefined;
    const meta = clientMeta(req);
    const locale = localeFromAcceptLanguage(req.headers['accept-language']);

    // Hata döndürülür, fırlatılmaz: deneme sayacı işlemle birlikte kalıcı olmalı.
    const result = await prisma.$transaction(async (tx): Promise<AcceptResult> => {
      // Kilit sırası: ürün rol kilidi (paylaşımlı, bekleyen kodların rolleri), kişi, sonra davet. Şifre bu kilit altında doğrulanır:
      // eşzamanlı şifre değişimiyle yarışmaz. Rol kilidi önce: rol silme (özel kilit, sonra davet yazımı) ile ölü kilit olmasın.
      await lockInvitationRoleProducts(tx, await peekPendingCodes(tx, phone));
      const phoneOwner = await tx.person.findUnique({ where: { phone }, select: { id: true } });
      await lockPersons(tx, [phoneOwner?.id, principal?.personId].filter((id): id is string => !!id));
      const pending = await lockPendingCodes(tx, phone);
      const match = findMatch(pending, phone, code);
      if (!match) {
        if (code) await countWrongAttempt(tx, countable(pending));
        return { kind: 'error', error: new AppError(400, 'INVITE_INVALID') };
      }
      // Kodu üretenin bugünkü yetkisi (03-B1): devirden ya da rol düşürmeden önce üretilmiş yönetici kodu ve daveti çalışmaz.
      if (!(await inviterStillAuthorized(tx, match))) return { kind: 'error', error: new AppError(400, 'INVITE_INVALID') };

      // ---------- Şifre kodu: kişi bu firmaya ait, e-postası yok ----------
      if (match.kind === 'PHONE_RESET') {
        const person = await resetTargetStillEligible(tx, match, phone);
        if (!person) return { kind: 'error', error: new AppError(400, 'INVITE_INVALID') };
        if (!newPassword.safeParse(body.password).success) throw validation('password', 'weak_password');
        const passwordHash = await hashPassword(body.password);
        await tx.person.update({ where: { id: person.id }, data: { passwordHash } });
        await tx.invitation.update({ where: { id: match.id }, data: { acceptedAt: new Date() } });
        await revokeAllSessions(tx, person.id);
        await bumpPersonEpochs(tx, person.id);
        await writeAudit(tx, {
          orgId: match.orgId,
          actor: { personId: person.id, ip: req.ip },
          action: 'person.password_reset_by_code',
          target: person.id,
        });
        const { session, refreshToken } = await createSession(tx, { person, client: body.client, meta, preferredOrgId: match.orgId });
        return { kind: 'ok', personId: person.id, session, refreshToken, created: false, passwordReset: true };
      }

      // ---------- Davet: telefon zaten bir kişiye aitse kod şifre belirletmez ----------
      const existing = await tx.person.findUnique({ where: { phone } });
      // Şifre denemesi girişle aynı kişi kovasına yazılır: yeni davetle sayaç sıfırlanıp sınırsız tahmin yapılamasın.
      // Girişle aynı kural (ARCHITECTURE §11): önce atomik say, şifre doğruysa payı geri ver. Bilinen cihaz istisnası yok.
      // 15 dakikalık ve günlük kişi kovası (04-B6), girişle ortak.
      let counted: string[] = [];
      const guardPassword = async (candidate: { id: string }) => {
        counted = await hitPersonPasswordBuckets(candidate.id);
      };
      const passwordAccepted = async (_candidate: { id: string }) => {
        for (const key of counted) await refundRateLimit(key);
      };
      let personId: string;
      let created = false;

      // Oturum açık ve hesapta telefon yok: numara kodla bu hesaba bağlanır (ARCHITECTURE §5). Başka hesaba katılma olmaz.
      if (principal && (existing ? existing.id !== principal.personId : false)) {
        return { kind: 'error', error: new AppError(403, 'INVITE_WRONG_ACCOUNT') };
      }
      if (principal && !existing) {
        const current = await tx.person.findUniqueOrThrow({ where: { id: principal.personId } });
        if (current.suspendedAt) return { kind: 'error', error: new AppError(401, 'INVALID_CREDENTIALS') };
        if (current.phone) return { kind: 'error', error: new AppError(403, 'INVITE_WRONG_ACCOUNT') };
        try {
          await guardPassword(current);
        } catch (err) {
          return { kind: 'error', error: err as AppError };
        }
        if (!(await verifyPassword(current.passwordHash, body.password))) {
          await countWrongAttempt(tx, [match.id]);
          return { kind: 'error', error: new AppError(401, 'INVALID_CREDENTIALS') };
        }
        await passwordAccepted(current);
        const already = await tx.membership.findUnique({
          where: { personId_orgId: { personId: current.id, orgId: match.orgId } },
          select: { id: true },
        });
        if (already) {
          await tx.invitation.update({ where: { id: match.id }, data: { revokedAt: new Date() } });
          return { kind: 'error', error: new AppError(409, 'ALREADY_MEMBER') };
        }
        await tx.person.update({ where: { id: current.id }, data: { phone } });
        const membership = await createMembershipWithRoles(tx, {
          personId: current.id,
          orgId: match.orgId,
          orgRole: match.orgRole,
          productRoles: await invitedProductRoles(tx, match),
        });
        await tx.invitation.update({ where: { id: match.id }, data: { acceptedAt: new Date() } });
        await writeAudit(tx, {
          orgId: match.orgId,
          actor: { personId: current.id, membershipId: membership.id, ip: req.ip },
          action: 'member.joined',
          target: membership.id,
          meta: { kind: 'PHONE_CODE', invitationId: match.id, personCreated: false, phoneLinked: true },
        });
        // Numara sahipliği kanıtlanamıyor (§11, kabul edilen risk): itiraz olursa destek bu izden bulur. Numaranın tamamı yazılmaz.
        await writeAudit(tx, {
          orgId: match.orgId,
          actor: { personId: current.id, membershipId: membership.id, ip: req.ip },
          action: 'person.phone_linked',
          target: current.id,
          meta: { phoneLast4: phone.slice(-4), invitationId: match.id, personCreated: false },
        });
        const head = await familyHead(tx, principal.familyId);
        if (!head) return { kind: 'error', error: new AppError(401, 'UNAUTHORIZED') };
        const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: match.orgId } });
        await touchActiveOrg(tx, current.id, match.orgId);
        return { kind: 'ok', personId: current.id, session, refreshToken: null, created: false };
      }

      if (existing) {
        try {
          await guardPassword(existing);
        } catch (err) {
          return { kind: 'error', error: err as AppError };
        }
        const ok = await verifyPassword(existing.passwordHash, body.password);
        if (!ok) {
          // Geçerli kodu olan da mevcut şifreyi sınırsız deneyemez.
          await countWrongAttempt(tx, [match.id]);
          return { kind: 'error', error: new AppError(401, 'INVALID_CREDENTIALS') };
        }
        await passwordAccepted(existing);
        if (existing.suspendedAt) return { kind: 'error', error: new AppError(401, 'INVALID_CREDENTIALS') };
        if (env.emailVerificationRequired && existing.email && !existing.emailVerifiedAt) {
          return { kind: 'error', error: new AppError(403, 'EMAIL_NOT_VERIFIED') };
        }
        const already = await tx.membership.findUnique({
          where: { personId_orgId: { personId: existing.id, orgId: match.orgId } },
          select: { id: true },
        });
        if (already) {
          await tx.invitation.update({ where: { id: match.id }, data: { revokedAt: new Date() } });
          return { kind: 'error', error: new AppError(409, 'ALREADY_MEMBER') };
        }
        personId = existing.id;
      } else {
        if (!newPassword.safeParse(body.password).success) throw validation('password', 'weak_password');
        const name = body.name ?? match.name;
        if (!name) throw validation('name', 'name_required');
        const passwordHash = await hashPassword(body.password);
        const person = await tx.person.create({ data: { name, phone, passwordHash, locale } });
        personId = person.id;
        created = true;
      }

      const membership = await createMembershipWithRoles(tx, {
        personId,
        orgId: match.orgId,
        orgRole: match.orgRole,
        productRoles: await invitedProductRoles(tx, match),
      });
      await tx.invitation.update({ where: { id: match.id }, data: { acceptedAt: new Date() } });
      await writeAudit(tx, {
        orgId: match.orgId,
        actor: { personId, membershipId: membership.id, ip: req.ip },
        action: 'member.joined',
        target: membership.id,
        meta: { kind: 'PHONE_CODE', invitationId: match.id, personCreated: created },
      });
      // Yeni hesap da numarayı kanıtsız alır (§11, kabul edilen risk): itiraz olursa destek bu izden bulur.
      if (created) {
        await writeAudit(tx, {
          orgId: match.orgId,
          actor: { personId, membershipId: membership.id, ip: req.ip },
          action: 'person.phone_linked',
          target: personId,
          meta: { phoneLast4: phone.slice(-4), invitationId: match.id, personCreated: true },
        });
      }
      const person = await tx.person.findUniqueOrThrow({ where: { id: personId } });
      const { session, refreshToken } = await createSession(tx, { person, client: body.client, meta, preferredOrgId: match.orgId });
      return { kind: 'ok', personId, session, refreshToken, created };
    });

    if (result.kind === 'error') throw result.error;
    // Kod yöneticiden geldi ve şifre yenilendi: eski şifreye yapılan tahminlerin kilidi kalkar (04-B6).
    if (result.passwordReset) await clearPersonLoginBuckets(result.personId, [phone]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: result.personId } });
    return sendSession(reply, {
      person,
      session: result.session,
      refreshToken: result.refreshToken,
      status: result.created ? 201 : 200,
    });
  });

  // ---------- E-posta daveti ----------

  async function findPendingEmailInvite(db: Tx | typeof prisma, token: string) {
    return db.invitation.findFirst({
      where: {
        tokenHash: sha256(token),
        kind: 'EMAIL',
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  app.get('/invites/:token', async (req) => {
    await enforceRateLimit([{ key: `invite:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.inviteTokenIp }]);
    const { token } = req.params as { token: string };
    const invitation = await findPendingEmailInvite(prisma, token);
    if (!invitation?.email) throw new AppError(400, 'INVITE_INVALID');
    // Daveti açanın bugünkü yetkisi (03-B1): eski sahibin açtığı yönetici daveti devirden sonra geçersiz görünür.
    if (!(await inviterStillAuthorized(prisma, invitation))) throw new AppError(400, 'INVITE_INVALID');
    const [org, person] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: invitation.orgId }, select: { name: true } }),
      prisma.person.findUnique({ where: { email: invitation.email }, select: { id: true } }),
    ]);
    return {
      orgName: org.name,
      name: invitation.name,
      email: invitation.email,
      orgRole: invitation.orgRole,
      personExists: person !== null,
      expiresAt: invitation.expiresAt,
    };
  });

  app.post('/invites/:token/accept', { config: { setsCookies: true } }, async (req, reply) => {
    await enforceRateLimit([{ key: `invite:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.inviteTokenIp }]);
    const { token } = req.params as { token: string };
    const body = z
      .object({
        name: displayName.optional(),
        password: existingPassword.optional(),
        client: clientKind,
      })
      .parse(req.body ?? {});
    await optionalAuth(req);
    const principal = req.principal;
    const meta = clientMeta(req);
    const locale = localeFromAcceptLanguage(req.headers['accept-language']);

    const result = await prisma.$transaction(async (tx) => {
      // Kilit sırası: ürün rol kilidi (paylaşımlı; rol silmeyle ölü kilit olmasın), kişi, sonra davet.
      const peek = await findPendingEmailInvite(tx, token);
      if (peek) await lockInvitationRoleProducts(tx, [peek]);
      const emailOwner = peek?.email ? await tx.person.findUnique({ where: { email: peek.email }, select: { id: true } }) : null;
      await lockPersons(tx, [emailOwner?.id, principal?.personId].filter((id): id is string => !!id));
      await tx.$queryRaw`SELECT 1 FROM "platform"."Invitation" WHERE "tokenHash" = ${sha256(token)} FOR UPDATE`;
      const invitation = await findPendingEmailInvite(tx, token);
      if (!invitation?.email) throw new AppError(400, 'INVITE_INVALID');
      // Daveti açanın bugünkü yetkisi yetmiyorsa (devir, rol düşürme) davet geçersizdir (03-B1).
      if (!(await inviterStillAuthorized(tx, invitation))) throw new AppError(400, 'INVITE_INVALID');
      // Davetten sonra kapanan ürünün rolü düşer, kabul hata vermez (`invitedProductRoles`).
      const productRoles = await invitedProductRoles(tx, invitation);
      const existing = await tx.person.findUnique({ where: { email: invitation.email } });

      // Var olan e-posta: önce giriş. Şifre sormak yerine oturum ister; bağlantıyı bilen hesaba giremez.
      if (existing) {
        if (!principal) throw new AppError(401, 'LOGIN_REQUIRED');
        if (principal.personId !== existing.id) throw new AppError(403, 'INVITE_WRONG_ACCOUNT');
        if (existing.suspendedAt) throw new AppError(401, 'INVALID_CREDENTIALS');
        const already = await tx.membership.findUnique({
          where: { personId_orgId: { personId: existing.id, orgId: invitation.orgId } },
          select: { id: true },
        });
        if (already) throw new AppError(409, 'ALREADY_MEMBER');
        const membership = await createMembershipWithRoles(tx, {
          personId: existing.id,
          orgId: invitation.orgId,
          orgRole: invitation.orgRole,
          productRoles,
        });
        await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
        await writeAudit(tx, {
          orgId: invitation.orgId,
          actor: { personId: existing.id, membershipId: membership.id, ip: req.ip },
          action: 'member.joined',
          target: membership.id,
          meta: { kind: 'EMAIL', invitationId: invitation.id, personCreated: false },
        });
        const head = await familyHead(tx, principal.familyId);
        if (!head) throw new AppError(401, 'UNAUTHORIZED');
        const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: invitation.orgId } });
        await touchActiveOrg(tx, existing.id, invitation.orgId);
        return { person: existing, session, refreshToken: null, created: false };
      }

      // Başka hesapla açık oturum varken yeni kişi açılmaz: yanlış hesaba katılma olmasın.
      if (principal) throw new AppError(403, 'INVITE_WRONG_ACCOUNT');
      if (!body.password) throw validation('password', 'required');
      if (!newPassword.safeParse(body.password).success) throw validation('password', 'weak_password');
      const name = body.name ?? invitation.name;
      if (!name) throw validation('name', 'name_required');
      const passwordHash = await hashPassword(body.password);
      // Bağlantı kopyalanabilir (yönetici de görür), bu yüzden e-posta doğrulanmış sayılmaz.
      const person = await tx.person.create({ data: { name, email: invitation.email, passwordHash, locale } });
      const membership = await createMembershipWithRoles(tx, {
        personId: person.id,
        orgId: invitation.orgId,
        orgRole: invitation.orgRole,
        productRoles,
      });
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
      await writeAudit(tx, {
        orgId: invitation.orgId,
        actor: { personId: person.id, membershipId: membership.id, ip: req.ip },
        action: 'member.joined',
        target: membership.id,
        meta: { kind: 'EMAIL', invitationId: invitation.id, personCreated: true },
      });
      if (env.emailVerificationRequired) return { person, session: null, refreshToken: null, created: true };
      const { session, refreshToken } = await createSession(tx, { person, client: body.client, meta, preferredOrgId: invitation.orgId });
      return { person, session, refreshToken: refreshToken as string | null, created: true };
    });

    if (result.created && result.person.email) {
      sendVerificationMail(result.person.id, result.person.email, result.person.locale);
    }
    if (!result.session) return reply.status(202).send({ verificationRequired: true });
    return sendSession(reply, {
      person: result.person,
      session: result.session,
      refreshToken: result.refreshToken,
      status: result.created ? 201 : 200,
    });
  });
}
