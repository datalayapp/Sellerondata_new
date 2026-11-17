import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_ACTION_LABEL,
  NAME_MAX_LENGTH,
  ORG_CURRENCIES,
  PRODUCTS,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  ROLE_NAME_MIN_LENGTH,
  TIME_ZONES,
  confirmNameMatches,
  isProductKey,
  isRolePermissionsLocked,
  type AuditEntry,
  type AuditMemberChange,
  type DeleteRoleResponse,
  type OrgRolesResponse,
  type ProductKey,
  type RoleResponse,
} from '@sellerondata/contracts';
import { prisma, Prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { localeOf } from '../i18n.ts';
import { AppError, forbidden, notFound, unauthorized, validation } from '../errors.ts';
import { isWebSession, memberOf, principalOf, requireAuth, requireManager, requireMember, requireWebSession, sendSession, webSessionRequired } from '../auth.ts';
import { writeAudit, type Actor } from '../lib/audit.ts';
import { generateJoinCode, hashJoinCode, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { ipBucket, normalizeEmail, normalizePhone } from '../lib/identity.ts';
import { isProductOn } from '../lib/launch.ts';
import { productAccessFor } from '../lib/productAccess.ts';
import { isOrgClosed } from '../lib/subscriptions.ts';
import { invitationMail, sendMailNow } from '../lib/mailer.ts';
import {
  applyMemberUpdate,
  assertAssignableRoles,
  assertProductRolesForOrg,
  authorizeInvitedRole,
  authorizeMemberChange,
  bumpEpoch,
  invitationOwnerOnlyPermissions,
  lockMemberships,
  removeMembership,
  roleForbidden,
  revokeInvitationsBy,
  revokeOwnerOnlyInvitationsBy,
  revokeResetCodesFor,
  validateProductRoles,
  type ProductRolesInput,
} from '../lib/members.ts';
import { assertReopenTarget, closeOrganization, reopenOrganization } from '../lib/orgClosure.ts';
import { createOrganizationWithOwner } from '../lib/orgs.ts';
import { emitOrgUpdated } from '../lib/outbox.ts';
import { loadRoleBook, lockAssignedRoles, resolveFromBook } from '../lib/roleBook.ts';
import { createRole, deleteRole, listOrgRoles, patchRole, resetBuiltinRole, type RoleRequestCtx } from '../lib/roles.ts';
import { countryCode, displayName, emailField, existingPassword } from '../lib/schemas.ts';
import { consumeRateLimit, enforceRateLimit, identityKey, RATE_RULES } from '../lib/rateLimit.ts';
import { assertPasswordUnchanged, chooseActiveOrg, familyHead, lockPerson, touchActiveOrg } from '../lib/sessions.ts';
import { MAX_CODE_ATTEMPTS } from './join.ts';

const EMAIL_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const PHONE_CODE_TTL_MS = 72 * 60 * 60_000;

const orgRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
// Rol değeri hazır rol anahtarı ya da `custom:<uuid>` (43 karakter).
const productRolesSchema = z.record(z.string().max(40), z.string().max(64).nullable());

// ---------- Rol uçlarının gövdeleri (sözleşme `contracts/src/roles.ts`) ----------
// Ad ve açıklama Merkez ekranına, denetim izine ve olaya girer: `displayName` kuralı gibi kontrol, biçim (bidi, sıfır genişlik:
// "Yönetici" + U+200B başka ad sayılıp aynı görünürdü) ve eşlenmemiş vekil karakter yok; açıklamada yalnız satır sonu serbest.
// Ad NFC'ye çevrilir: aynı görünen iki yazım (birleşik ve ayrık aksan) tekillik denetiminde de aynı olsun.
const roleNameField = z
  .string()
  .trim()
  .transform((v) => v.normalize('NFC'))
  .pipe(z.string().min(ROLE_NAME_MIN_LENGTH).max(ROLE_NAME_MAX_LENGTH).regex(/^[^\p{Cc}\p{Cf}\p{Cs}]+$/u));
const roleDescriptionField = z
  .string()
  .trim()
  .transform((v) => v.normalize('NFC'))
  .pipe(z.string().max(ROLE_DESCRIPTION_MAX_LENGTH).regex(/^(?:[^\p{Cc}\p{Cf}\p{Cs}]|\n)*$/u));
const rolePermissionsField = z.array(z.string().max(80)).max(64);
const createRoleSchema = z.object({
  product: z.string().max(40),
  name: roleNameField,
  description: roleDescriptionField.optional(),
  permissions: rolePermissionsField,
  basedOn: z.string().max(40).optional(),
});
const patchRoleSchema = z.object({
  name: roleNameField.optional(),
  description: roleDescriptionField.nullable().optional(),
  permissions: rolePermissionsField.optional(),
  version: z.number().int().min(0),
});
const deleteRoleQuery = z.object({ reassignTo: z.string().min(1).max(64).optional() });
const customRoleIdParam = z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) });

const inviteSchema = z.object({
  kind: z.enum(['EMAIL', 'PHONE_CODE']),
  email: emailField.optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  name: displayName.optional(),
  orgRole: orgRoleSchema.default('MEMBER'),
  productRoles: productRolesSchema.default({}),
});

const memberPatchSchema = z.object({
  orgRole: orgRoleSchema.optional(),
  productRoles: productRolesSchema.optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

/**
 * Davet postası gider mi? Doğrulanmamış (ya da e-postasız) yönetici adına posta gitmez: sahte ad ve bağlantıyla oltalama olmasın.
 * Önce kişi başına sınır, sonra alıcı başına sınır sayılır; aşılınca hata değil, posta gitmez (`mailSent: false`, bağlantı yanıtta döner).
 */
async function mayMailInvite(inviterVerified: boolean, inviterId: string, recipient: string): Promise<boolean> {
  if (!inviterVerified) return false;
  if (!(await consumeRateLimit(`invite:mailby:${inviterId}`, RATE_RULES.inviteMailPerson))) return false;
  return consumeRateLimit(`invite:to:${identityKey(recipient)}`, RATE_RULES.inviteRecipient);
}

function actorOf(req: FastifyRequest): Actor {
  const member = req.member;
  return { personId: req.principal?.personId, membershipId: member?.id, ip: req.ip };
}

/**
 * Hedef ve yapan satırları kilitlenir, rol kilit altında yeniden okunur: yetki kararı ile yazma arasında rol değişemez.
 * Hedef yalnız yapanın firmasında aranır. Başka firmanın üyeliği yoktur (404), varlığı da belli olmaz.
 */
async function lockActorAndTarget(tx: Tx, req: FastifyRequest, targetId: string) {
  const self = memberOf(req);
  // Önce firma denetimi (03-B9): başka firmanın üyelik kimliği kilitlenmeden 404 alır, o satırı bekletemez.
  const inOrg = await tx.membership.findFirst({ where: { id: targetId, orgId: self.orgId }, select: { id: true } });
  if (!inOrg) throw notFound();
  await lockMemberships(tx, [self.id, targetId]);
  const actor = await tx.membership.findUnique({ where: { id: self.id } });
  if (!actor || actor.status !== 'ACTIVE' || actor.orgId !== self.orgId) throw forbidden();
  const target = await tx.membership.findFirst({
    where: { id: targetId, orgId: actor.orgId },
    include: { person: true },
  });
  if (!target) throw notFound();
  return { actor, target };
}

/**
 * Şifre kodu kuralı: kişi yalnız bu firmanın aktif üyesi ve e-postasız olmalı. E-postası olan ve başka firmada da üye olan kişi
 * aynı nedeni alır (`SELF_RESET`, 04-B10): yönetici, çalışanın başka firmada çalıştığını buradan öğrenmesin. Nedeni kişinin kendi
 * ekranı (`me.account.passwordRecovery`) söyler.
 */
async function assertResetCodeAllowed(tx: Tx, target: { status: string; personId: string; person: { email: string | null; suspendedAt: Date | null; phone: string | null } }) {
  if (target.status !== 'ACTIVE' || target.person.suspendedAt) throw new AppError(409, 'RESET_CODE_NOT_ALLOWED', { reason: 'NOT_ACTIVE' });
  if (target.person.email) throw new AppError(409, 'RESET_CODE_NOT_ALLOWED', { reason: 'SELF_RESET' });
  const count = await tx.membership.count({ where: { personId: target.personId } });
  if (count !== 1) throw new AppError(409, 'RESET_CODE_NOT_ALLOWED', { reason: 'SELF_RESET' });
}

/**
 * Yönetim yazma uçlarının kovası (03-B9): üye rolü, askı, çıkarma, firma ayarı ve davet iptali. Her değişiklik araçlara olay yazıp
 * üyenin oturumunu yeniletir; ele geçirilmiş yönetici oturumu dakikada yüzlerce değişiklikle kuyruğu şişiremesin.
 * Kova YAPAN yönetici başınadır, firma başına değil: firma başı kovayı dolduran kötü niyetli (ya da ele geçirilmiş) bir yönetici
 * sahibin onu askıya almasını ve çıkarmasını 15 dakika boyunca engelleyebilirdi.
 */
async function limitAdminWrite(req: FastifyRequest) {
  const self = memberOf(req);
  await enforceRateLimit([{ key: `admin:write:${self.orgId}:${self.id}`, rule: RATE_RULES.orgAdminWrite }]);
}

async function revokePendingFor(tx: Tx, orgId: string, contact: { email?: string; phone?: string }) {
  await tx.invitation.updateMany({
    where: { orgId, acceptedAt: null, revokedAt: null, ...contact },
    data: { revokedAt: new Date() },
  });
}

/** Davet edene kod veya bağlantı döner. Sonradan bir daha gösterilmez: `resend` yenisini üretir. */
function inviteLink(token: string) {
  return `${env.appBaseUrl}/invite/${token}`;
}

function publicInvitation(i: {
  id: string;
  kind: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  orgRole: string;
  productRoles: Prisma.JsonValue;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
  invitedById: string;
}) {
  return {
    id: i.id,
    kind: i.kind,
    email: i.email,
    phone: i.phone,
    name: i.name,
    orgRole: i.orgRole,
    productRoles: i.productRoles,
    expiresAt: i.expiresAt,
    expired: i.expiresAt <= new Date(),
    attempts: i.attempts,
    createdAt: i.createdAt,
    invitedById: i.invitedById,
  };
}

/**
 * Firma denetim izinde müşteriye giden ayrıntı (03-B10). Destek işlemlerinin (`support.*`) operatör adı ve iç gerekçesi yalnız
 * sunucudaki kayıtta kalır: "ödeme gecikti, şüpheli" gibi iç not ve destek çalışanının adı firma yöneticisine gösterilmez.
 */
const SUPPORT_PRIVATE_KEYS = new Set(['operator', 'reason']);
function customerDetails(action: string, meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta || !action.startsWith('support.')) return meta;
  return Object.fromEntries(Object.entries(meta).filter(([k]) => !SUPPORT_PRIVATE_KEYS.has(k)));
}

/** Mobil uygulamanın "Çalışan ekle" daveti: telefon kodu, firma rolü çalışan (gövdede yoksa varsayılan MEMBER). */
function isWorkerPhoneInvite(req: FastifyRequest): boolean {
  const body = req.body as { kind?: unknown; orgRole?: unknown } | null | undefined;
  return body?.kind === 'PHONE_CODE' && (body.orgRole === undefined || body.orgRole === 'MEMBER');
}

/**
 * Mobil davetin verebildiği araç rolleri (mobil `src/hub/invite.ts` `inviteRoleOptions` ile aynı sınır): izinleri kilitli rol (sahip
 * rolü, DeciShip "Yönetici") ve sahibe özel izinli rol yok. Bekçi yalnız gövdenin türüne bakar; rol tanımı veritabanındadır, davet
 * ucunda rol kilidi altında burada denetlenir (bugünkü tanımıyla: özel rol sonradan sahibe özel izin almış olabilir).
 */
async function mobileGrantable(tx: Tx, orgId: string, productRoles: Prisma.JsonValue | ProductRolesInput | undefined): Promise<boolean> {
  for (const [product, role] of Object.entries((productRoles ?? {}) as Record<string, unknown>)) {
    if (typeof role === 'string' && isProductKey(product) && isRolePermissionsLocked(product, role)) return false;
  }
  return (await invitationOwnerOnlyPermissions(tx, orgId, productRoles as Prisma.JsonValue)).length === 0;
}

/** Davet ucu: tarayıcı oturumu ya da (mobil dahil) telefonla çalışan daveti. Araç rolü sınırı davet ucunda (`mobileGrantable`). */
async function requireWebSessionOrWorkerInvite(req: FastifyRequest) {
  await requireAuth(req);
  if (!isWebSession(req) && !isWorkerPhoneInvite(req)) throw webSessionRequired();
}

const SAFE_ROUTE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Firma yönetimi yalnız tarayıcıdan (KARARLAR "Firma yönetimi yalnız tarayıcıdan", C2.4-A1): `/org` ve `/org/*` altındaki her yazma
 * ucu tarayıcı oturumu (çerez + `web` oturum satırı, CSRF ve `X-SOD-Org` ayrıca) ister. Mobil ya da Bearer jeton, uzun ömürlü
 * yenileme jetonu çalınsa da üye, rol, davet ve firma ayarı değiştiremez. Tek istisna mobilin "Çalışan ekle" daveti
 * (`config.mobileWorkerInvite`). Okumalar (mobil ekip listesi, roller, etkinlik) serbest; `/orgs` (firma açma) kapsam dışı.
 * Bekçi rotanın kendi `preHandler`ından SONRA eklenir: kimlik ve firma hataları (401, `ORG_REQUIRED`) önce, bu ret sonra gelir.
 * Kayıt sırasında eklenir: bu dosyaya yeni yazma ucu girince kendiliğinden korunur.
 */
function guardOrgWrites(app: FastifyInstance) {
  app.addHook('onRoute', (route) => {
    if ([route.method].flat().every((m) => SAFE_ROUTE_METHODS.has(m))) return;
    if (!/\/org(\/|$)/.test(route.url)) return;
    const guard: preHandlerAsyncHookHandler = route.config?.mobileWorkerInvite === true ? requireWebSessionOrWorkerInvite : requireWebSession;
    const own = route.preHandler === undefined ? [] : [route.preHandler].flat();
    route.preHandler = [...own, guard];
  });
}

export async function orgRoutes(app: FastifyInstance) {
  guardOrgWrites(app);

  // Giriş yapmış kişi yeni firma açar. "Kişi birden çok firmada olabilir" kararının yarısı; üyeliği kalmayanın da çıkışı.
  app.post('/orgs', { preHandler: requireAuth }, async (req, reply) => {
    if (!env.registrationEnabled) throw new AppError(403, 'REGISTRATION_CLOSED');
    // Kapalı deneme (2026-11-12): giriş yapmış kişi (ör. ekip davetiyle gelen çalışan) de davetsiz yeni firma açamaz; yoksa
    // her ekip daveti yeni bir firma (ve yeni yapay zekâ kotası) kapısı olurdu. Kayıt daveti yalnız kayıt ekranında kullanılır.
    if (env.signupMode === 'invite') throw new AppError(403, 'SIGNUP_INVITE_REQUIRED');
    const principal = principalOf(req);
    const body = z.object({ name: displayName, country: countryCode.default('TR') }).parse(req.body);
    await enforceRateLimit([
      { key: `orgcreate:ip:${ipBucket(req.ip)}`, rule: RATE_RULES.orgCreateIp },
      { key: `orgcreate:person:${principal.personId}`, rule: RATE_RULES.orgCreatePerson },
    ]);

    const { person, session } = await prisma.$transaction(async (tx) => {
      await lockPerson(tx, principal.personId);
      const person = await tx.person.findUniqueOrThrow({ where: { id: principal.personId } });
      // OWNER'ın şifresini kurtarabilecek başka kimse yok: e-posta şart. Kayıt da aynı şeyi ister.
      if (!person.email) throw new AppError(409, 'OWNER_REQUIRES_EMAIL');
      const head = await familyHead(tx, principal.familyId);
      if (!head) throw unauthorized();
      const { org } = await createOrganizationWithOwner(tx, {
        personId: person.id,
        name: body.name,
        country: body.country,
        locale: person.locale,
        ip: req.ip,
      });
      const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: org.id } });
      await touchActiveOrg(tx, person.id, org.id);
      return { person, session };
    });
    return sendSession(reply, { person, session, refreshToken: null, status: 201 });
  });

  /**
   * Kişi etkin firmadaki kendi üyeliğinden çıkar. OWNER çıkamaz: önce devir.
   * Parola genelde istenmez (yalnız kişinin kendi erişimini etkiler, yeniden davetle geri alınır).
   * E-postasız kişide istenir: üyelik sayısı şifre kodu koşuludur (ARCHITECTURE §5). Çalınmış oturumla ikinci firmadan
   * ayrılıp kalan firmanın yöneticisine şifre sıfırlatmak hesabı kalıcı ele geçirirdi.
   */
  app.post('/org/leave', { preHandler: requireMember }, async (req, reply) => {
    const member = memberOf(req);
    const principal = principalOf(req);
    const body = z.object({ password: existingPassword.optional() }).parse(req.body ?? {});
    if (member.orgRole === 'OWNER') throw new AppError(409, 'LAST_OWNER');

    const current = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId } });
    if (!current.email) {
      if (!body.password) throw new AppError(403, 'PASSWORD_CONFIRM_REQUIRED');
      await enforceRateLimit([{ key: `password:person:${current.id}`, rule: RATE_RULES.passwordConfirm }]);
      if (!(await verifyPassword(current.passwordHash, body.password))) throw new AppError(401, 'INVALID_CREDENTIALS');
    }

    const { person, session } = await prisma.$transaction(async (tx) => {
      if (body.password) await assertPasswordUnchanged(tx, current.id, current.passwordHash);
      await lockMemberships(tx, [member.id]);
      const target = await tx.membership.findUnique({ where: { id: member.id }, include: { person: true } });
      if (!target || target.status !== 'ACTIVE') throw new AppError(401, 'TOKEN_STALE');
      if (target.orgRole === 'OWNER') throw new AppError(409, 'LAST_OWNER');
      await removeMembership(tx, target);
      await writeAudit(tx, {
        orgId: target.orgId,
        actor: { personId: target.personId, ip: req.ip },
        action: 'member.left',
        target: target.id,
        meta: { personId: target.personId, name: target.person.name },
      });
      const person = await tx.person.findUniqueOrThrow({ where: { id: target.personId } });
      const head = await familyHead(tx, principal.familyId);
      if (!head) throw unauthorized();
      const nextOrgId = await chooseActiveOrg(tx, person);
      const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: nextOrgId } });
      await touchActiveOrg(tx, person.id, nextOrgId);
      return { person, session };
    });
    return sendSession(reply, { person, session, refreshToken: null });
  });

  app.get('/org', { preHandler: requireMember }, async (req) => {
    const member = memberOf(req);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: member.orgId } });
    return {
      id: org.id,
      name: org.name,
      country: org.country,
      currency: org.currency,
      locale: org.locale,
      timeZone: org.timeZone,
      // Merkez kurulumu: firma bilgileri onaylandı mı (ISO an; `null` = onay bekliyor).
      companyConfirmedAt: org.companyConfirmedAt?.toISOString() ?? null,
      createdAt: org.createdAt,
      orgRole: member.orgRole,
    };
  });

  app.patch('/org', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    await limitAdminWrite(req);
    const body = z
      .object({
        name: displayName.optional(),
        country: countryCode.optional(),
        currency: z.enum(ORG_CURRENCIES).optional(),
        locale: z.enum(['tr', 'en']).optional(),
        // Firmanın saat dilimi: yalnız `TIME_ZONES` (geçersiz değer 400 VALIDATION).
        timeZone: z.enum(TIME_ZONES).optional(),
        // Merkez kurulumu: firma bilgilerini onayla. Yalnız `true` (onay geri alınmaz; `false` 400 VALIDATION). Diğer alanlarla
        // aynı istekte gelebilir. Zaten onaylıysa değişmez.
        confirmCompany: z.literal(true).optional(),
      })
      .parse(req.body);
    const { confirmCompany, ...fields } = body;
    const org = await prisma.$transaction(async (tx) => {
      // Satır kilidi altında: sürüm sırası yazma sırasıyla aynı olur, en büyük sürüm son adı taşır.
      await tx.$queryRaw`SELECT 1 FROM "platform"."Organization" WHERE "id" = ${member.orgId} FOR UPDATE`;
      const before = await tx.organization.findUniqueOrThrow({ where: { id: member.orgId } });
      // Ürünler ad, para birimi, ülke, saat dilimi ve firma onayını olaydan öğrenir. Dil ürüne gitmez (davet ve bildirim
      // Hesap'tan gider): sürüm boşuna artmasın. Onay yalnız ilk kez sürüm artırır; tekrar onay zararsızdır.
      const timeZoneChanged = fields.timeZone !== undefined && fields.timeZone !== before.timeZone;
      const confirming = confirmCompany === true && before.companyConfirmedAt === null;
      const announced =
        (fields.name !== undefined && fields.name !== before.name) ||
        (fields.currency !== undefined && fields.currency !== before.currency) ||
        (fields.country !== undefined && fields.country !== before.country) ||
        timeZoneChanged ||
        confirming;
      const updated = await tx.organization.update({
        where: { id: member.orgId },
        data: {
          ...fields,
          ...(confirming ? { companyConfirmedAt: new Date() } : {}),
          ...(announced ? { version: { increment: 1 } } : {}),
        },
      });
      // Değişen saat dilimi varsayılana dönse de söylenir; değişmediyse varsayılan gönderilmez (`orgUpdatedEvent`).
      if (announced) await emitOrgUpdated(tx, updated, { sayTimeZone: timeZoneChanged });
      await writeAudit(tx, { orgId: updated.id, actor: actorOf(req), action: 'org.updated', target: updated.id, meta: body });
      return updated;
    });
    return {
      id: org.id,
      name: org.name,
      country: org.country,
      currency: org.currency,
      locale: org.locale,
      timeZone: org.timeZone,
      companyConfirmedAt: org.companyConfirmedAt?.toISOString() ?? null,
    };
  });

  // ---------- Üyeler ----------

  app.get('/org/members', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    const rows = await prisma.membership.findMany({
      where: { orgId: member.orgId },
      orderBy: { createdAt: 'asc' },
      include: { person: { select: { id: true, name: true, email: true, emailVerifiedAt: true, phone: true, suspendedAt: true } }, productAccess: true },
    });
    const counts = await prisma.membership.groupBy({
      by: ['personId'],
      where: { personId: { in: rows.map((r) => r.personId) } },
      _count: { _all: true },
    });
    const orgCount = new Map(counts.map((c) => [c.personId, c._count._all]));
    // Jetonla aynı kural (`productAccessFor`): kapalı ürünün, aboneliği olmayan `pilot` ürünün ve katalogda olmayan rolün
    // satırı listede görünmez. Satır silinmez: ürün yeniden açılınca rol geri gelir.
    const subscriptions = await prisma.subscription.findMany({ where: { orgId: member.orgId } });
    // Rol defteriyle: gizlenmiş hazır rol ve silinmiş özel rol de görünmez (jetonla aynı). Rol adları `GET /org/roles`'tadır.
    const roles = await loadRoleBook(prisma, member.orgId);
    const visibleRoles = (access: { product: string; role: string }[]) =>
      Object.fromEntries(productAccessFor(access, subscriptions, { roles }).flatMap((s) => (s.role ? [[s.key, s.role]] : [])));
    return {
      members: rows.map((m) => ({
        id: m.id,
        personId: m.personId,
        name: m.person.name,
        email: m.person.email,
        // Sahiplik yalnız doğrulanmış adrese devredilir (04-B5): Merkez devir penceresi buna göre seçtirir.
        emailVerified: !!m.person.email && m.person.emailVerifiedAt !== null,
        phone: m.person.phone,
        orgRole: m.orgRole,
        status: m.status,
        lastActiveAt: m.lastActiveAt,
        createdAt: m.createdAt,
        productRoles: visibleRoles(m.productAccess),
        resetCodeAllowed: m.status === 'ACTIVE' && !m.person.email && !!m.person.phone && !m.person.suspendedAt && orgCount.get(m.personId) === 1,
        personSuspended: m.person.suspendedAt !== null,
      })),
    };
  });

  app.post('/org/members/invite', { preHandler: requireManager, config: { mobileWorkerInvite: true } }, async (req, reply) => {
    const member = memberOf(req);
    const body = inviteSchema.parse(req.body);
    // Rol atamadaki kuralla aynı: kapalı ürüne ve aboneliği olmayan firmada `pilot` ürüne rol davete yazılmaz.
    const productRoles = await assertProductRolesForOrg(prisma, member.orgId, body.productRoles as ProductRolesInput);

    const email = body.kind === 'EMAIL' ? (body.email ? normalizeEmail(body.email) : null) : null;
    if (body.kind === 'EMAIL' && !email) throw validation('email', 'required');
    let phone: string | null = null;
    if (body.kind === 'PHONE_CODE') {
      if (!body.phone) throw validation('phone', 'required');
      phone = normalizePhone(body.phone);
      if (!phone) throw validation('phone', 'invalid_phone');
      if (!body.name) throw validation('name', 'name_required');
    }

    const secret = body.kind === 'EMAIL' ? randomToken() : generateJoinCode();
    const tokenHash = body.kind === 'EMAIL' ? sha256(secret) : hashJoinCode(phone as string, secret);
    const ttl = body.kind === 'EMAIL' ? EMAIL_INVITE_TTL_MS : PHONE_CODE_TTL_MS;

    const { invitation, orgName, inviterName, inviterId, inviterVerified } = await prisma.$transaction(async (tx) => {
      await assertOrgOpenForInvites(tx, member.orgId);
      // Kilit sırası: firma, rol (paylaşımlı; rol düzenlemesiyle sıraya girer), kişi + üyelik.
      await lockAssignedRoles(tx, member.orgId, productRoles);
      await lockMemberships(tx, [member.id]);
      const actor = await tx.membership.findUniqueOrThrow({ where: { id: member.id } });
      if (actor.status !== 'ACTIVE') throw forbidden();
      authorizeInvitedRole(actor, body.orgRole);
      // Rol firmada geçerli olmalı (gizlenmiş hazır rol, başka firmanın özel rolü verilmez); sahibe özel izinli rolü yalnız OWNER verir.
      await assertAssignableRoles(tx, actor, actor.orgId, productRoles);
      // Mobil istisna (`guardOrgWrites`) yalnız mobilin verebildiği rolleri kapsar: sahip rolü ve sahibe özel izinli rol web ister.
      const viaMobile = !isWebSession(req);
      if (viaMobile && !(await mobileGrantable(tx, actor.orgId, productRoles))) throw webSessionRequired();

      const contact = email ? { email } : { phone: phone as string };
      const existing = await tx.person.findUnique({ where: contact, select: { id: true } });
      if (existing) {
        const already = await tx.membership.findUnique({
          where: { personId_orgId: { personId: existing.id, orgId: actor.orgId } },
          select: { id: true },
        });
        if (already) throw new AppError(409, 'ALREADY_MEMBER');
      }
      // ADMIN, OWNER'ın açtığı yönetici davetini üzerine yazarak düşüremez.
      const pending = await tx.invitation.findMany({
        where: { orgId: actor.orgId, acceptedAt: null, revokedAt: null, ...contact },
        select: { kind: true, orgRole: true, productRoles: true },
      });
      for (const p of pending) authorizeInvitedRole(actor, p.orgRole);
      // Mobil yol yalnız kendisinin de açabileceği bekleyen daveti (telefon kodu, çalışan, mobil rolü) yeniler; web'in açtığı yönetici
      // ya da sahip rollü daveti düşüremez (çalınmış mobil jetonla web davetini öldürüp yerine kod almak).
      if (viaMobile) {
        for (const p of pending) {
          if (p.kind !== 'PHONE_CODE' || p.orgRole !== 'MEMBER' || !(await mobileGrantable(tx, actor.orgId, p.productRoles))) throw webSessionRequired();
        }
      }
      // `personExists` akış gereği kod ve bağlantı sahibine görünür (§11). Tarama davet açmayı gerektirir: firma başına sınır, yeni firmaya sıkı.
      // Denetimlerden sonra sayılır: geçersiz girdi, zaten üye ve yetkisiz deneme hak yemez.
      const orgAge = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { createdAt: true } });
      const isNewOrg = Date.now() - orgAge.createdAt.getTime() < 24 * 60 * 60_000;
      await enforceRateLimit([
        { key: `invite:org:${actor.orgId}`, rule: RATE_RULES.orgInvite },
        body.kind === 'PHONE_CODE'
          ? { key: `invite:phone:${actor.orgId}`, rule: isNewOrg ? RATE_RULES.phoneInviteNewOrg : RATE_RULES.phoneInvite }
          : { key: `invite:email:${actor.orgId}`, rule: isNewOrg ? RATE_RULES.emailInviteNewOrg : RATE_RULES.emailInvite },
      ]);
      // Aynı kişiye yeni davet: eski kod veya bağlantı düşer.
      await revokePendingFor(tx, actor.orgId, contact);
      const invitation = await tx.invitation.create({
        data: {
          orgId: actor.orgId,
          kind: body.kind,
          email,
          phone,
          name: body.name ?? null,
          orgRole: body.orgRole,
          productRoles: productRoles as Prisma.InputJsonValue,
          tokenHash,
          expiresAt: new Date(Date.now() + ttl),
          invitedById: actor.id,
        },
      });
      await writeAudit(tx, {
        orgId: actor.orgId,
        actor: actorOf(req),
        action: 'invitation.created',
        target: invitation.id,
        meta: { kind: body.kind, orgRole: body.orgRole },
      });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { name: true, locale: true } });
      const inviter = await tx.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { name: true, email: true, emailVerifiedAt: true } });
      return { invitation, orgName: org, inviterName: inviter.name, inviterId: actor.personId, inviterVerified: !!inviter.email && !!inviter.emailVerifiedAt };
    });

    if (body.kind === 'EMAIL') {
      const link = inviteLink(secret);
      // Gerçek sonuç: yönetici "gönderildi" okumasın, bağlantıyı kendisi iletsin. Davet işlemi bitti, posta işlem dışında.
      const allowed = await mayMailInvite(inviterVerified, inviterId, email as string);
      const mailSent = allowed && (await sendMailNow(invitationMail(email as string, orgName.locale, { orgName: orgName.name, inviterName, url: link })));
      return reply.status(201).send({ invitation: publicInvitation(invitation), link, mailSent });
    }
    return reply.status(201).send({ invitation: publicInvitation(invitation), code: secret });
  });

  app.patch('/org/members/:id', { preHandler: requireManager }, async (req) => {
    const { id } = req.params as { id: string };
    const body = memberPatchSchema.parse(req.body);
    await limitAdminWrite(req);
    const productRoles = body.productRoles ? validateProductRoles(body.productRoles as ProductRolesInput) : undefined;

    const changed = await prisma.$transaction(async (tx) => {
      // Kilit sırası: atanan rol (paylaşımlı), sonra kişi + üyelik. Rol düzenlemesi aynı sırayla alır.
      if (productRoles) await lockAssignedRoles(tx, memberOf(req).orgId, productRoles);
      const { actor, target } = await lockActorAndTarget(tx, req, id);
      authorizeMemberChange(actor, target, { orgRole: body.orgRole, status: body.status, productRoles });
      // Destek işlemiyle askıya alınan kişinin giriş kimliği yok: üyeliği açmak bir işe yaramaz, geri alma destek komutuyla.
      if (body.status === 'ACTIVE' && target.status !== 'ACTIVE' && target.person.suspendedAt) throw new AppError(409, 'PERSON_SUSPENDED');

      const accessBefore = await tx.productAccess.findMany({ where: { membershipId: target.id } });
      // Rol firmada geçerli olmalı; sahibe özel izinli rolü yalnız OWNER atar (değişmeyen rol yeniden denetlenmez).
      if (productRoles) {
        await assertAssignableRoles(tx, actor, actor.orgId, productRoles, Object.fromEntries(accessBefore.map((a) => [a.product, a.role])));
      }
      const book = await loadRoleBook(tx, actor.orgId);
      const orgLocale = (await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { locale: true } })).locale;
      // Rol adı değişiklik anındaki haliyle (firmanın yazdığı ad, yoksa katalog adı firmanın dilinde): rol sonradan silinse de iz okunur.
      const labelOf = (product: string, role: string | null) => {
        const resolved = resolveFromBook(book, product, role);
        return resolved ? resolved.label[orgLocale] : null;
      };
      const changed = await applyMemberUpdate(tx, target.id, { orgRole: body.orgRole, status: body.status, productRoles });
      if (changed.length) {
        // Denetim izi neyin neye döndüğünü söyler: "Üyelik güncellendi" tek başına bir şey anlatmaz.
        const changes: AuditMemberChange[] = [];
        if (changed.includes('orgRole') && body.orgRole) changes.push({ field: 'orgRole', from: target.orgRole, to: body.orgRole });
        if (changed.includes('status') && body.status) changes.push({ field: 'status', from: target.status, to: body.status });
        for (const [product, role] of Object.entries(productRoles ?? {})) {
          const from = accessBefore.find((a) => a.product === product)?.role ?? null;
          if (from !== role) changes.push({ field: 'productRole', product, from, to: role, fromLabel: labelOf(product, from), toLabel: labelOf(product, role) });
        }
        const lostAuthority = body.status === 'SUSPENDED' || (changed.includes('orgRole') && body.orgRole === 'MEMBER');
        if (lostAuthority) await revokeInvitationsBy(tx, target.id);
        await writeAudit(tx, {
          orgId: actor.orgId,
          actor: actorOf(req),
          action: 'member.updated',
          target: target.id,
          meta: { changed, changes, name: target.person.name } as Prisma.InputJsonValue,
        });
      }
      return changed;
    });
    return { ok: true, changed };
  });

  app.delete('/org/members/:id', { preHandler: requireManager }, async (req) => {
    const { id } = req.params as { id: string };
    await limitAdminWrite(req);
    await prisma.$transaction(async (tx) => {
      const { actor, target } = await lockActorAndTarget(tx, req, id);
      authorizeMemberChange(actor, target, { remove: true });
      await removeMembership(tx, target);
      await writeAudit(tx, {
        orgId: actor.orgId,
        actor: actorOf(req),
        action: 'member.removed',
        target: target.id,
        meta: { personId: target.personId, name: target.person.name },
      });
    });
    return { ok: true };
  });

  app.post('/org/members/:id/reset-code', { preHandler: requireManager }, async (req, reply) => {
    const member = memberOf(req);
    await enforceRateLimit([{ key: `invite:org:${member.orgId}`, rule: RATE_RULES.orgInvite }]);
    const { id } = req.params as { id: string };

    const result = await prisma.$transaction(async (tx) => {
      const { actor, target } = await lockActorAndTarget(tx, req, id);
      // ADMIN, OWNER veya başka ADMIN için kod üretseydi o hesabı ele geçirirdi.
      authorizeMemberChange(actor, target, { resetCode: true });
      await assertResetCodeAllowed(tx, target);

      const phone = target.person.phone as string;
      const code = generateJoinCode();
      await revokePendingFor(tx, actor.orgId, { phone });
      const invitation = await tx.invitation.create({
        data: {
          orgId: actor.orgId,
          kind: 'PHONE_RESET',
          phone,
          name: target.person.name,
          orgRole: target.orgRole,
          tokenHash: hashJoinCode(phone, code),
          expiresAt: new Date(Date.now() + PHONE_CODE_TTL_MS),
          invitedById: actor.id,
          targetPersonId: target.personId,
        },
      });
      await writeAudit(tx, {
        orgId: actor.orgId,
        actor: actorOf(req),
        action: 'member.reset_code_issued',
        target: target.id,
        meta: { invitationId: invitation.id },
      });
      return { invitation, code };
    });
    return reply.status(201).send({ invitation: publicInvitation(result.invitation), code: result.code });
  });

  // ---------- Roller (özel roller ve hazır rol düzenleme; kurallar `lib/roles.ts`) ----------

  const roleCtx = (req: FastifyRequest): RoleRequestCtx => {
    const member = memberOf(req);
    return { orgId: member.orgId, actorMembershipId: member.id, audit: actorOf(req), locale: localeOf(req) };
  };

  app.get('/org/roles', { preHandler: requireManager }, async (req): Promise<OrgRolesResponse> => listOrgRoles(prisma, roleCtx(req)));

  app.post('/org/roles', { preHandler: requireManager }, async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    await limitAdminWrite(req);
    const role = await prisma.$transaction((tx) => createRole(tx, roleCtx(req), body as Parameters<typeof createRole>[2]));
    return reply.status(201).send({ role } satisfies RoleResponse);
  });

  app.patch('/org/roles/:id', { preHandler: requireManager }, async (req): Promise<RoleResponse> => {
    const params = customRoleIdParam.safeParse(req.params);
    if (!params.success) throw notFound();
    const body = patchRoleSchema.parse(req.body);
    await limitAdminWrite(req);
    return { role: await prisma.$transaction((tx) => patchRole(tx, roleCtx(req), { customId: params.data.id }, body)) };
  });

  app.patch('/org/roles/builtin/:product/:key', { preHandler: requireManager }, async (req): Promise<RoleResponse> => {
    const { product, key } = req.params as { product: string; key: string };
    const body = patchRoleSchema.parse(req.body);
    await limitAdminWrite(req);
    return { role: await prisma.$transaction((tx) => patchRole(tx, roleCtx(req), { product, key }, body)) };
  });

  app.delete('/org/roles/:id', { preHandler: requireManager }, async (req): Promise<DeleteRoleResponse> => {
    const params = customRoleIdParam.safeParse(req.params);
    if (!params.success) throw notFound();
    const { reassignTo } = deleteRoleQuery.parse(req.query ?? {});
    await limitAdminWrite(req);
    return prisma.$transaction((tx) => deleteRole(tx, roleCtx(req), { customId: params.data.id }, reassignTo));
  });

  app.delete('/org/roles/builtin/:product/:key', { preHandler: requireManager }, async (req): Promise<DeleteRoleResponse> => {
    const { product, key } = req.params as { product: string; key: string };
    const { reassignTo } = deleteRoleQuery.parse(req.query ?? {});
    await limitAdminWrite(req);
    return prisma.$transaction((tx) => deleteRole(tx, roleCtx(req), { product, key }, reassignTo));
  });

  app.post('/org/roles/builtin/:product/:key/reset', { preHandler: requireManager }, async (req): Promise<RoleResponse> => {
    const { product, key } = req.params as { product: string; key: string };
    await limitAdminWrite(req);
    return { role: await prisma.$transaction((tx) => resetBuiltinRole(tx, roleCtx(req), product, key)) };
  });

  // ---------- Firmayı kapatma ve geri açma ----------

  /**
   * Etkin firmayı kapatır. Yalnız OWNER; firma adı aynen yazılır (`confirmNameMatches`) ve şifre yeniden girilir (şifre onayı kovası,
   * devirle aynı). Sıra: yetki → ad (sır değil, kovayı harcamaz) → kova → şifre. Yanıt oturum yanıtıdır: sahip başka açık firmasına
   * geçer ya da firmasız kalır; ek olarak kapanış anları.
   */
  app.post('/org/close', { preHandler: requireMember }, async (req, reply) => {
    const member = memberOf(req);
    const principal = principalOf(req);
    const body = z.object({ confirmName: z.string().max(NAME_MAX_LENGTH * 2), password: existingPassword }).parse(req.body);
    if (member.orgRole !== 'OWNER') throw forbidden();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: member.orgId }, select: { name: true } });
    if (!confirmNameMatches(body.confirmName, org.name)) throw new AppError(400, 'CONFIRM_NAME_MISMATCH');
    await enforceRateLimit([{ key: `password:person:${principal.personId}`, rule: RATE_RULES.passwordConfirm }]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId }, select: { passwordHash: true } });
    if (!(await verifyPassword(person.passwordHash, body.password))) throw new AppError(401, 'INVALID_CREDENTIALS');

    const result = await closeOrganization({
      orgId: member.orgId,
      personId: principal.personId,
      membershipId: member.id,
      familyId: principal.familyId,
      verifiedHash: person.passwordHash,
      ip: req.ip,
    });
    return sendSession(reply, {
      person: result.person,
      session: result.session,
      refreshToken: null,
      extra: { closedAt: result.closedAt.toISOString(), purgeAfter: result.purgeAfter.toISOString() },
    });
  });

  /**
   * Kapalı firmayı geri açar. Etkin firma gerekmez (kapalı firma etkin olamaz): `requireAuth`, firma gövdede. Yalnız o firmanın OWNER'ı
   * ve saklama süresi içinde; başkasına firma yok sayılır (`404 ORG_NOT_FOUND`). Şifre onayı kovası. Geri açılan firma etkin olur.
   */
  app.post('/org/reopen', { preHandler: requireAuth }, async (req, reply) => {
    const principal = principalOf(req);
    const body = z.object({ orgId: z.string().min(1).max(64), password: existingPassword }).parse(req.body);
    await assertReopenTarget(body.orgId, principal.personId);
    await enforceRateLimit([{ key: `password:person:${principal.personId}`, rule: RATE_RULES.passwordConfirm }]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId }, select: { passwordHash: true } });
    if (!(await verifyPassword(person.passwordHash, body.password))) throw new AppError(401, 'INVALID_CREDENTIALS');

    const result = await reopenOrganization({
      orgId: body.orgId,
      personId: principal.personId,
      familyId: principal.familyId,
      verifiedHash: person.passwordHash,
      ip: req.ip,
    });
    return sendSession(reply, { person: result.person, session: result.session, refreshToken: null });
  });

  // ---------- Sahiplik devri ----------

  app.post('/org/transfer-ownership', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    const principal = principalOf(req);
    const body = z.object({ membershipId: z.string().min(1).max(64), password: existingPassword }).parse(req.body);
    if (member.orgRole !== 'OWNER') throw forbidden();
    await enforceRateLimit([{ key: `password:person:${principal.personId}`, rule: RATE_RULES.passwordConfirm }]);

    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId } });
    if (!(await verifyPassword(person.passwordHash, body.password))) throw new AppError(401, 'INVALID_CREDENTIALS');

    await prisma.$transaction(async (tx) => {
      // Devreden ve hedef kişi kilitli: e-posta silme ve şifre değişimiyle yarışmaz.
      const { actor, target } = await lockActorAndTarget(tx, req, body.membershipId);
      await assertPasswordUnchanged(tx, person.id, person.passwordHash);
      if (actor.orgRole !== 'OWNER') throw forbidden();
      if (actor.id === target.id) throw new AppError(403, 'CANNOT_MANAGE_SELF');
      if (target.status !== 'ACTIVE') throw new AppError(409, 'CONFLICT');
      // OWNER'ı yönetecek kimse yok: e-posta olmadan şifresini kurtaramaz.
      if (!target.person.email) throw new AppError(409, 'OWNER_REQUIRES_EMAIL');
      // Doğrulama zorunluyken doğrulanmamış adres giriş yapamaz (04-B5): devir yapılsaydı firma girebilen sahipsiz kalırdı.
      // Kural girişle aynı ayara bağlı: doğrulamasız ortamda (yerel e2e yığını) doğrulanmamış üye zaten girer.
      if (env.emailVerificationRequired && !target.person.emailVerifiedAt) {
        throw new AppError(409, 'OWNER_REQUIRES_EMAIL', { reason: 'EMAIL_NOT_VERIFIED' });
      }
      // Sıra önemli: tek OWNER dizini ara durumda iki OWNER'a izin vermez.
      await tx.membership.update({ where: { id: actor.id }, data: { orgRole: 'ADMIN' } });
      await tx.membership.update({ where: { id: target.id }, data: { orgRole: 'OWNER' } });
      await revokeResetCodesFor(tx, actor.personId);
      await revokeResetCodesFor(tx, target.personId);
      // Eski sahip artık yönetici (03-B1): sahipken açtığı yönetici davetleri ve yöneticiye ürettiği şifre kodları düşer.
      // Kabulde üretenin bugünkü yetkisi ayrıca denetlenir (`inviterStillAuthorized`).
      await revokeOwnerOnlyInvitationsBy(tx, actor.id);
      await bumpEpoch(tx, actor.id);
      await bumpEpoch(tx, target.id);
      await writeAudit(tx, {
        orgId: actor.orgId,
        actor: actorOf(req),
        action: 'org.ownership_transferred',
        target: target.id,
        meta: { from: actor.id, to: target.id },
      });
    });
    return { ok: true };
  });

  // ---------- Davetler ----------

  app.get('/org/invitations', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    const rows = await prisma.invitation.findMany({
      where: { orgId: member.orgId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { invitations: rows.map(publicInvitation) };
  });

  /**
   * Kapalı firmada (`org:close`) yeni davet açılmaz: `409 ORG_CLOSED`. Firma satırı `FOR SHARE`: eşzamanlı kapatma
   * (`FOR NO KEY UPDATE`) ile sıraya girer, kapatmanın düşürdüğü davetlerin arasına yenisi sızmaz. Kilit sırasında ilk adımdır.
   */
  async function assertOrgOpenForInvites(tx: Tx, orgId: string) {
    await tx.$queryRaw`SELECT 1 FROM "platform"."Organization" WHERE "id" = ${orgId} FOR SHARE`;
    if (await isOrgClosed(tx, orgId)) throw new AppError(409, 'ORG_CLOSED');
  }

  /** Kilit altında daveti ve yapanı okur. ADMIN yalnız MEMBER davetine dokunur. */
  async function lockInvitation(tx: Tx, req: FastifyRequest, id: string) {
    const member = memberOf(req);
    await lockMemberships(tx, [member.id]);
    const actor = await tx.membership.findUniqueOrThrow({ where: { id: member.id } });
    if (actor.status !== 'ACTIVE') throw forbidden();
    await tx.$queryRaw`SELECT 1 FROM "platform"."Invitation" WHERE "id" = ${id} AND "orgId" = ${actor.orgId} FOR UPDATE`;
    const invitation = await tx.invitation.findFirst({
      where: { id, orgId: actor.orgId, acceptedAt: null, revokedAt: null },
    });
    if (!invitation) throw notFound();
    authorizeInvitedRole(actor, invitation.orgRole);
    return { actor, invitation };
  }

  app.post('/org/invitations/:id/resend', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    await enforceRateLimit([{ key: `invite:org:${member.orgId}`, rule: RATE_RULES.orgInvite }]);
    const { id } = req.params as { id: string };

    const result = await prisma.$transaction(async (tx) => {
      // Firma satırı önce (kilit sırası). Şifre kodu (PHONE_RESET) davet değildir: kapalı firmada da okuma için gerekir.
      await tx.$queryRaw`SELECT 1 FROM "platform"."Organization" WHERE "id" = ${member.orgId} FOR SHARE`;
      // Sonra davetin rollerinin ürün kilidi (paylaşımlı; davet açmayla aynı sıra): rol düzenlemesi (`patchRole`, özel kilit) rolün
      // iznini değiştirirken aşağıdaki sahibe özel izin denetimi eski tanımı okumasın. Ürün kümesi rol taşımada değişmez (taşıma aynı
      // üründe olur), kilitsiz okuma yeter; rol değeri kilit altında `lockInvitation` ile yeniden okunur.
      const roles = await tx.invitation.findFirst({ where: { id, orgId: member.orgId }, select: { productRoles: true } });
      if (roles) await lockAssignedRoles(tx, member.orgId, (roles.productRoles ?? {}) as Record<string, string | null>);
      const { actor, invitation } = await lockInvitation(tx, req, id);
      if (invitation.kind !== 'PHONE_RESET' && (await isOrgClosed(tx, actor.orgId))) throw new AppError(409, 'ORG_CLOSED');
      // Yeniden gönderen davetin sahibi olur (`invitedById`). Sahibe özel izinli rol taşıyan sahip davetini yönetici yeniden
      // gönderseydi davet sessizce kabul edilemez hale gelirdi (kabulde açanın yetkisi denetlenir): açıkça reddedilir.
      if (actor.orgRole !== 'OWNER') {
        const ownerOnly = await invitationOwnerOnlyPermissions(tx, actor.orgId, invitation.productRoles);
        if (ownerOnly.length) throw roleForbidden('owner_only', ownerOnly);
      }
      if (invitation.kind === 'PHONE_RESET') {
        const target = await tx.membership.findFirst({
          where: { orgId: actor.orgId, personId: invitation.targetPersonId as string },
          include: { person: true },
        });
        if (!target) throw notFound();
        authorizeMemberChange(actor, target, { resetCode: true });
        await assertResetCodeAllowed(tx, target);
      }
      // Hak sıfırlanmaz: yeni kodla sınırsız tahmin olmasın. Hakkı biten daveti iptal edip yeniden açmak gerekir (firma sınırına tabidir).
      if (invitation.kind !== 'EMAIL' && invitation.attempts >= MAX_CODE_ATTEMPTS) throw new AppError(409, 'INVITE_ATTEMPTS_EXHAUSTED');
      const isEmail = invitation.kind === 'EMAIL';
      const secret = isEmail ? randomToken() : generateJoinCode();
      const updated = await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          tokenHash: isEmail ? sha256(secret) : hashJoinCode(invitation.phone as string, secret),
          expiresAt: new Date(Date.now() + (isEmail ? EMAIL_INVITE_TTL_MS : PHONE_CODE_TTL_MS)),
          // Kodu artık bu yönetici biliyor: yetkisi düşerse kod da düşsün.
          invitedById: actor.id,
        },
      });
      await writeAudit(tx, { orgId: actor.orgId, actor: actorOf(req), action: 'invitation.resent', target: invitation.id });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { name: true, locale: true } });
      const inviter = await tx.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { name: true, email: true, emailVerifiedAt: true } });
      return { updated, secret, isEmail, org, inviterName: inviter.name, inviterId: actor.personId, inviterVerified: !!inviter.email && !!inviter.emailVerifiedAt };
    });

    if (result.isEmail) {
      const link = inviteLink(result.secret);
      const allowed = await mayMailInvite(result.inviterVerified, result.inviterId, result.updated.email as string);
      const mailSent =
        allowed &&
        (await sendMailNow(
          invitationMail(result.updated.email as string, result.org.locale, {
            orgName: result.org.name,
            inviterName: result.inviterName,
            url: link,
          }),
        ));
      return { invitation: publicInvitation(result.updated), link, mailSent };
    }
    return { invitation: publicInvitation(result.updated), code: result.secret };
  });

  app.delete('/org/invitations/:id', { preHandler: requireManager }, async (req) => {
    const { id } = req.params as { id: string };
    await limitAdminWrite(req);
    await prisma.$transaction(async (tx) => {
      const { actor, invitation } = await lockInvitation(tx, req, id);
      await tx.invitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      await writeAudit(tx, { orgId: actor.orgId, actor: actorOf(req), action: 'invitation.revoked', target: invitation.id });
    });
    return { ok: true };
  });

  // ---------- Abonelik, ödeme, denetim ----------

  app.get('/org/subscriptions', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    const rows = await prisma.subscription.findMany({ where: { orgId: member.orgId } });
    // Kayıtta olmayan ya da kapalı (`off`) ürünün satırı gösterilmez (veritabanında elle yazılmış olsa da).
    const visible = rows.filter((s): s is typeof s & { product: ProductKey } => isProductKey(s.product) && isProductOn(s.product));
    return {
      subscriptions: visible.map((s) => ({
        product: s.product,
        name: PRODUCTS[s.product].name,
        status: s.status,
        plan: s.plan,
        limits: s.limits,
        currentPeriodEnd: s.currentPeriodEnd,
        canceledAt: s.canceledAt,
        deleteAfter: s.deleteAfter,
      })),
    };
  });

  app.post('/org/billing/*', { preHandler: requireManager }, async () => {
    throw new AppError(501, 'PAYMENT_NOT_AVAILABLE');
  });

  app.get('/org/audit', { preHandler: requireManager }, async (req) => {
    const member = memberOf(req);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where = { orgId: member.orgId };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    const targets = rows.map((r) => r.target).filter((v): v is string => !!v);
    const targetMembers = await prisma.membership.findMany({ where: { id: { in: targets }, orgId: member.orgId }, select: { id: true, personId: true } });
    const personIds = [
      ...new Set([...rows.map((r) => r.actorPersonId), ...targets, ...targetMembers.map((m) => m.personId)].filter((v): v is string => !!v)),
    ];
    const people = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } });
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const memberPerson = new Map(targetMembers.map((m) => [m.id, m.personId]));
    const locale = localeOf(req);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((r) => {
        const details = customerDetails(r.action, (r.meta ?? null) as Record<string, unknown> | null);
        const targetPerson = r.target ? (memberPerson.get(r.target) ?? r.target) : null;
        const metaName = typeof details?.name === 'string' ? details.name : null;
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          actor: r.actorPersonId ? (nameOf.get(r.actorPersonId) ?? null) : null,
          action: r.action,
          label: AUDIT_ACTION_LABEL[r.action]?.[locale] ?? r.action,
          target: r.target,
          // Çıkarılan üyenin kaydı yok: ad denetim izinden gelir. Hedef firma ise ad yoktur.
          targetName: (targetPerson ? nameOf.get(targetPerson) : undefined) ?? metaName,
          details,
          meta: details,
        } satisfies AuditEntry;
      }),
    };
  });
}

