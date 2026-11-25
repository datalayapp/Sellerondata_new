/**
 * Sahibin firmayı kapatması, geri açması ve saklama süresi dolunca kalıcı silme (kullanıcı kararı
 * 2026-11-13). Destek komutunun kapatmasından (`subscriptions.ts` `closeOrg`, abonelik iptali) ayrıdır: bu yol aboneliğe dokunmaz,
 * firmayı `Organization.closedAt` ile kapatır. Kapalı firma:
 * - etkin firma olamaz (`chooseActiveOrg`, `/auth/switch-org` `409 ORG_CLOSED`), jetonda firma ve ürün vermez (`buildAccessPayload`),
 * - firma uçlarında `409 ORG_CLOSED` (`requireMember`), araç bildirimi gönderilmez,
 * - yalnız sahibinin `/me` listesinde görünür (`buildMe`), diğer üyelerde hiç görünmez.
 *
 * Kilit sırası (`subscriptions.ts` dosya başı): firma (`FOR NO KEY UPDATE`) → abonelik → kişi → üyelik (`lockMemberships`) → davet.
 * Şifre işlem dışında doğrulanır; işlemde kişi kilidinden sonra özetin değişmediği denetlenir (`assertPasswordUnchanged` kuralı).
 * Kişi satırları `lockMemberships` ile firmanın bütün üyeleriyle birlikte kimlik sırasıyla kilitlenir: sahibi önce tek başına
 * kilitlemek sıra dışı olurdu.
 *
 * Saat: `closedAt`/`purgeAfter` veritabanı saatinden yazılır, geri açma ve silme penceresi de veritabanı saatiyle denetlenir
 * (`dbNow`): birden çok sunucu kopyasının saati kaysa da pencere tek saate göre işler.
 *
 * Olaylar (`org.closed`, `org.reopened`, `org.purged`) firmanın aboneliği olan ya da önceden olay almış her ürüne, çalışma durumundan
 * bağımsız gider (`lifecycleProductsOf`); dağıtıcı onları hiç bırakmaz (`LIFECYCLE_EVENT_TYPES`).
 */

import type { ProductKey } from '@sellerondata/contracts';
import { prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { AppError, unauthorized } from '../errors.ts';
import { writeAudit, type Actor } from './audit.ts';
import { lockMemberships } from './members.ts';
import { enqueueEvent, enqueueServiceEvents, lifecycleProductsOf } from './outbox.ts';
import { chooseActiveOrg, familyHead, touchActiveOrg } from './sessions.ts';
import { bumpOrgMemberships } from './subscriptions.ts';

const DAY_MS = 86_400_000;

/** Kalıcı silmenin anı: tam gün (UTC, 24 saat × gün). */
export function purgeAfterOf(closedAt: Date, days = env.orgPurgeDays): Date {
  return new Date(closedAt.getTime() + days * DAY_MS);
}

/** Veritabanı saati. İşlem içinde işlemin başlangıç anıdır (`now()`): kilit beklemesi pencereyi yalnız daraltır. */
async function dbNow(client: Tx | typeof prisma): Promise<Date> {
  const [row] = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return row.now;
}

type LockedOrg = { id: string; name: string; closedAt: Date | null; purgeAfter: Date | null; version: number };

/** Firma satırını kilitler (sıranın ilk adımı) ve okur. Yoksa null. */
async function lockOrgRow(tx: Tx, orgId: string): Promise<LockedOrg | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "platform"."Organization" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;
  if (!rows.length) return null;
  return tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, closedAt: true, purgeAfter: true, version: true } });
}

/** Firmanın bütün üyeliklerini (kişileriyle birlikte, kural sırasıyla) kilitler. */
async function lockOrgMembers(tx: Tx, orgId: string) {
  const rows = await tx.membership.findMany({ where: { orgId }, select: { id: true }, orderBy: { id: 'asc' } });
  if (rows.length) await lockMemberships(tx, rows.map((r) => r.id));
}

/** Kişi kilitliyken: şifre doğrulamadan bu yana değişmedi ve kişi bu firmanın etkin sahibi. */
async function assertOwnerUnchanged(tx: Tx, orgId: string, personId: string, verifiedHash: string) {
  const person = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { passwordHash: true } });
  if (person.passwordHash !== verifiedHash) throw new AppError(401, 'INVALID_CREDENTIALS');
  const m = await tx.membership.findUnique({ where: { personId_orgId: { personId, orgId } }, select: { orgRole: true, status: true } });
  return m?.orgRole === 'OWNER' && m.status === 'ACTIVE';
}

/** Kapalı firmada açık kalan oturumlar ve son firma tercihi boşalır: kişi yeniden girdiğinde başka firmaya ya da firmasız açılır. */
async function forgetActiveOrg(tx: Tx, orgId: string) {
  // Yalnız firmanın üyeleri (kişi satırları `lockOrgMembers` ile kilitli). Eski üyenin tercihi zararsızdır: `chooseActiveOrg` kapalı
  // ya da üyeliği olmayan firmayı zaten seçmez.
  const personIds = (await tx.membership.findMany({ where: { orgId }, select: { personId: true } })).map((m) => m.personId);
  if (!personIds.length) return;
  await tx.person.updateMany({ where: { id: { in: personIds }, lastOrgId: orgId }, data: { lastOrgId: null } });
  await tx.session.updateMany({ where: { personId: { in: personIds }, activeOrgId: orgId, revokedAt: null }, data: { activeOrgId: null } });
}

export type CloseOrgInput = {
  orgId: string;
  personId: string;
  membershipId: string;
  familyId: string;
  /** İşlem dışında doğrulanmış şifre özeti. */
  verifiedHash: string;
  ip: string;
};

/**
 * Etkin firmayı kapatır (çağıran: `POST /org/close`; sahiplik, ad ve şifre orada denetlendi). Tek işlemde: alanlar yazılır, firma
 * sürümü artar, bütün üyeliklerin epoch'u artar (açık oturumlar ürünlerde `TOKEN_STALE`), bekleyen katılma davetleri düşer (şifre
 * kodları kişiye ait, kalır), kişilerin etkin firması boşalır, denetim `org.closed`, olay `org.closed`. Kapatanın oturumu başka açık
 * firmasına (yoksa firmasız) geçer; dönen oturum satırı yanıtta kullanılır.
 */
export async function closeOrganization(input: CloseOrgInput) {
  return prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const purgeAfter = purgeAfterOf(now);
    const org = await lockOrgRow(tx, input.orgId);
    if (!org) throw new AppError(404, 'ORG_NOT_FOUND');
    if (org.closedAt) throw new AppError(409, 'ORG_CLOSED');
    await lockOrgMembers(tx, input.orgId);
    if (!(await assertOwnerUnchanged(tx, input.orgId, input.personId, input.verifiedHash))) throw new AppError(403, 'FORBIDDEN');

    const updated = await tx.organization.update({
      where: { id: input.orgId },
      data: { closedAt: now, closedById: input.personId, purgeAfter, version: { increment: 1 } },
      select: { version: true },
    });
    const { bumped } = await bumpOrgMemberships(tx, input.orgId, { revokeAt: now });
    await forgetActiveOrg(tx, input.orgId);
    const actor: Actor = { personId: input.personId, membershipId: input.membershipId, ip: input.ip };
    await writeAudit(tx, {
      orgId: input.orgId,
      actor,
      action: 'org.closed',
      target: input.orgId,
      meta: { closedAt: now.toISOString(), purgeAfter: purgeAfter.toISOString(), members: bumped },
    });
    // Hizmete (geçit) firma başına bir kez, aboneliği olmayan firmada da; ürün kopyaları aynısını yeniden yazmaz.
    await enqueueServiceEvents(tx, {
      type: 'org.closed',
      orgId: input.orgId,
      closedAt: now.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
      version: updated.version,
    });
    for (const product of await lifecycleProductsOf(tx, input.orgId)) {
      await enqueueEvent(tx, {
        type: 'org.closed',
        orgId: input.orgId,
        product,
        closedAt: now.toISOString(),
        purgeAfter: purgeAfter.toISOString(),
        version: updated.version,
      });
    }

    const person = await tx.person.findUniqueOrThrow({ where: { id: input.personId } });
    const head = await familyHead(tx, input.familyId);
    if (!head) throw unauthorized();
    const nextOrgId = await chooseActiveOrg(tx, person);
    const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: nextOrgId } });
    await touchActiveOrg(tx, person.id, nextOrgId);
    return { person, session, closedAt: now, purgeAfter };
  });
}

/**
 * Silinmiş firma için geri açma isteği: kişi silinen firmanın sahibiyse `410 ORG_PURGED`, değilse `404 ORG_NOT_FOUND` (firmanın
 * varlığı başkasına ele verilmez). İz `org.purged` denetim kaydındadır (`meta.ownerPersonId`).
 */
async function missingOrgError(orgId: string, personId: string): Promise<AppError> {
  const purged = await prisma.auditLog.findFirst({
    where: { action: 'org.purged', target: orgId, meta: { path: ['ownerPersonId'], equals: personId } },
    select: { id: true },
  });
  return purged ? new AppError(410, 'ORG_PURGED') : new AppError(404, 'ORG_NOT_FOUND');
}

/** Geri açmadan önce, işlem dışında: istek sahibi bu firmanın sahibi mi (değilse firma yok sayılır). */
export async function assertReopenTarget(orgId: string, personId: string) {
  const now = await dbNow(prisma);
  const m = await prisma.membership.findUnique({
    where: { personId_orgId: { personId, orgId } },
    select: { orgRole: true, status: true, org: { select: { closedAt: true, purgeAfter: true } } },
  });
  if (!m) throw await missingOrgError(orgId, personId);
  if (m.orgRole !== 'OWNER' || m.status !== 'ACTIVE') throw new AppError(404, 'ORG_NOT_FOUND');
  if (!m.org.closedAt) throw new AppError(409, 'CONFLICT');
  if (!m.org.purgeAfter || m.org.purgeAfter <= now) throw new AppError(410, 'ORG_PURGED');
}

export type ReopenOrgInput = Omit<CloseOrgInput, 'membershipId'>;

/**
 * Kapalı firmayı geri açar (çağıran: `POST /org/reopen`, şifre orada doğrulandı). Yalnız firmanın sahibi ve `purgeAfter > now`.
 * Alanlar boşalır, sürüm ve epoch'lar artar, denetim `org.reopened`, olay `org.reopened`. Geri açılan firma oturumun etkin firması olur.
 * Kapanışta düşen davetler geri gelmez (destek `org:reopen` gibi).
 */
export async function reopenOrganization(input: ReopenOrgInput) {
  return prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const org = await lockOrgRow(tx, input.orgId);
    if (!org) throw new AppError(404, 'ORG_NOT_FOUND');
    await lockOrgMembers(tx, input.orgId);
    if (!(await assertOwnerUnchanged(tx, input.orgId, input.personId, input.verifiedHash))) throw new AppError(404, 'ORG_NOT_FOUND');
    if (!org.closedAt) throw new AppError(409, 'CONFLICT');
    // Süre doldu ama bakım henüz silmedi: geri açılmaz (silme işi bu satırı birazdan siler).
    if (!org.purgeAfter || org.purgeAfter <= now) throw new AppError(410, 'ORG_PURGED');

    const membership = await tx.membership.findUniqueOrThrow({ where: { personId_orgId: { personId: input.personId, orgId: input.orgId } }, select: { id: true } });
    const updated = await tx.organization.update({
      where: { id: input.orgId },
      data: { closedAt: null, closedById: null, purgeAfter: null, version: { increment: 1 } },
      select: { version: true },
    });
    await bumpOrgMemberships(tx, input.orgId);
    await writeAudit(tx, {
      orgId: input.orgId,
      actor: { personId: input.personId, membershipId: membership.id, ip: input.ip },
      action: 'org.reopened',
      target: input.orgId,
      meta: { closedAt: org.closedAt.toISOString(), purgeAfter: org.purgeAfter.toISOString() },
    });
    await enqueueServiceEvents(tx, { type: 'org.reopened', orgId: input.orgId, version: updated.version });
    for (const product of await lifecycleProductsOf(tx, input.orgId)) {
      await enqueueEvent(tx, { type: 'org.reopened', orgId: input.orgId, product, version: updated.version });
    }

    const head = await familyHead(tx, input.familyId);
    if (!head) throw unauthorized();
    const session = await tx.session.update({ where: { id: head.id }, data: { activeOrgId: input.orgId } });
    await touchActiveOrg(tx, input.personId, input.orgId);
    const person = await tx.person.findUniqueOrThrow({ where: { id: input.personId } });
    return { person, session };
  });
}

export type PurgeOrgResult = { purged: true; orgId: string; products: ProductKey[]; memberships: number; invitations: number } | { purged: false; reason: 'not_found' | 'not_closed' | 'not_due' };

/**
 * Saklama süresi dolmuş kapalı firmayı kalıcı siler (kendi işleminde; geri dönmez). Kilitler kural sırasıyla alınır, koşul kilit altında
 * yeniden denetlenir (aynı anda geri açılan firma silinmez). Silmeden önce, aynı işlemde: her olay ürününe `org.purged` (dış kutu
 * `Outbox`un firmaya yabancı anahtarı yok: firma silinince olay kalır, dağıtıcı teslim eder) ve denetim `org.purged` (firma yok,
 * `orgId` boş; `target` firma kimliği). Silme zincirlemedir: üyelik (ve araç rolleri), abonelik, davet, bildirim izi, firma rolleri.
 * Kişiler silinmez (üyeliğin kişiye bağı `Restrict`, kişi satırına dokunulmaz); kişilerin son firma tercihi ve oturumlarının etkin
 * firması boşalır. Firmanın önceki denetim kayıtları kalır (kişi ve güvenlik izi; yabancı anahtar yok). Tekrar çağrı zararsız:
 * firma yoksa `not_found`, olay ikinci kez yazılmaz.
 */
export async function purgeClosedOrg(orgId: string): Promise<PurgeOrgResult> {
  return prisma.$transaction(async (tx): Promise<PurgeOrgResult> => {
    const now = await dbNow(tx);
    const org = await lockOrgRow(tx, orgId);
    if (!org) return { purged: false, reason: 'not_found' };
    if (!org.closedAt || !org.purgeAfter) return { purged: false, reason: 'not_closed' };
    if (org.purgeAfter > now) return { purged: false, reason: 'not_due' };

    await tx.$queryRaw`SELECT 1 FROM "platform"."Subscription" WHERE "orgId" = ${orgId} ORDER BY "product" FOR UPDATE`;
    await lockOrgMembers(tx, orgId);
    const invitations = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "platform"."Invitation" WHERE "orgId" = ${orgId} ORDER BY "id" FOR UPDATE`;
    const memberships = await tx.membership.findMany({ where: { orgId }, select: { personId: true, orgRole: true } });
    const owner = memberships.find((m) => m.orgRole === 'OWNER');

    const products = await lifecycleProductsOf(tx, orgId);
    await enqueueServiceEvents(tx, { type: 'org.purged', orgId });
    for (const product of products) await enqueueEvent(tx, { type: 'org.purged', orgId, product });
    await writeAudit(tx, {
      actor: {},
      action: 'org.purged',
      target: orgId,
      // Ad yazılmaz (silinen veridir); sahip kimliği "geri aç" isteğine `410 ORG_PURGED` dönebilmek için.
      meta: {
        orgId,
        ownerPersonId: owner?.personId ?? null,
        closedAt: org.closedAt.toISOString(),
        purgeAfter: org.purgeAfter.toISOString(),
        memberships: memberships.length,
        invitations: invitations.length,
      },
    });
    await forgetActiveOrg(tx, orgId);
    // Araç erişimleri önce, açıkça: özel rol bağı (`ProductAccess.customRoleId → ProductRole`) NO ACTION ve iki ucu da firma
    // silmesinin zincirinden düşer; zincirleme tetikleyicilerin sırasına bırakılırsa yabancı anahtar hatası verebilir.
    await tx.productAccess.deleteMany({ where: { membership: { orgId } } });
    await tx.organization.delete({ where: { id: orgId } });
    return { purged: true, orgId, products, memberships: memberships.length, invitations: invitations.length };
  });
}

type PurgeLog = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

/**
 * Saatlik bakımın adımı: süresi dolmuş kapalı firmaları tek tek siler. Biri hata verirse sonrakiler yine denenir; birden çok kopyada
 * da zararsızdır (kilit + yeniden denetim; ikinci kopya firmayı bulamaz).
 */
export async function purgeDueOrgs(log?: PurgeLog): Promise<{ purged: string[]; failed: string[] }> {
  const now = await dbNow(prisma);
  const due = await prisma.organization.findMany({
    where: { closedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true },
    orderBy: { purgeAfter: 'asc' },
    take: 200,
  });
  const purged: string[] = [];
  const failed: string[] = [];
  for (const { id } of due) {
    try {
      const r = await purgeClosedOrg(id);
      if (r.purged) purged.push(id);
    } catch (err) {
      failed.push(id);
      log?.error({ err, orgId: id }, 'kapalı firma kalıcı silinemedi; sonraki bakım turunda yeniden denenecek');
    }
  }
  return { purged, failed };
}
