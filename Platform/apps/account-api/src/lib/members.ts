import {
  customRoleIdOf,
  isCustomRoleKey,
  isProductKey,
  isValidProductRole,
  ownerOnlyPermissionsIn,
  type OrgRole,
  type ProductKey,
  type RoleForbiddenReason,
} from '@sellerondata/contracts';
import { Prisma, type PrismaClient, type Tx } from '../db.ts';
import { AppError, forbidden } from '../errors.ts';
import { isProductOn, productLaunch } from './launch.ts';
import { emitMemberUpserted, enqueueEvent, eventProductsOf } from './outbox.ts';
import { loadRoleBook, lockAssignedRoles, resolveFromBook } from './roleBook.ts';

/**
 * Yetki sınırı (ARCHITECTURE §5). Saf işlev: veritabanına bakmaz, çağıran satırları kilitleyip verir.
 *
 * - MEMBER hiçbir üyeliği yönetemez.
 * - ADMIN yalnız MEMBER'ı yönetir. OWNER'a ve başka ADMIN'e dokunamaz, ADMIN atayamaz.
 * - Sahiplik yalnız devirle değişir.
 * - Kimse kendi üyeliğini yönetemez. Tek istisna: OWNER kendi araç rollerini değiştirebilir, çünkü onu yönetebilecek başkası yoktur.
 */
export type MemberChange = {
  orgRole?: OrgRole;
  status?: 'ACTIVE' | 'SUSPENDED';
  productRoles?: unknown;
  remove?: boolean;
  resetCode?: boolean;
};

export function authorizeMemberChange(
  actor: { id: string; orgRole: OrgRole },
  target: { id: string; orgRole: OrgRole },
  change: MemberChange,
): void {
  if (actor.orgRole !== 'OWNER' && actor.orgRole !== 'ADMIN') throw forbidden();

  const self = actor.id === target.id;
  if (self && target.orgRole === 'OWNER') {
    if (change.remove || change.status === 'SUSPENDED' || (change.orgRole && change.orgRole !== 'OWNER')) {
      throw new AppError(409, 'LAST_OWNER');
    }
    if (change.resetCode) throw new AppError(403, 'CANNOT_MANAGE_SELF');
    return;
  }
  if (self) throw new AppError(403, 'CANNOT_MANAGE_SELF');
  if (target.orgRole === 'OWNER') throw new AppError(403, 'CANNOT_MANAGE_OWNER');
  if (change.orgRole === 'OWNER') throw new AppError(403, 'USE_OWNERSHIP_TRANSFER');
  if (actor.orgRole === 'ADMIN') {
    if (target.orgRole === 'ADMIN' || change.orgRole === 'ADMIN') throw forbidden();
  }
}

/** Davet edenin atayabileceği rol. OWNER davetle verilmez. */
export function authorizeInvitedRole(actor: { orgRole: OrgRole }, invited: OrgRole): void {
  if (actor.orgRole !== 'OWNER' && actor.orgRole !== 'ADMIN') throw forbidden();
  if (invited === 'OWNER') throw new AppError(403, 'USE_OWNERSHIP_TRANSFER');
  if (invited === 'ADMIN' && actor.orgRole !== 'OWNER') throw forbidden();
}

export type ProductRolesInput = Record<string, string | null>;

/**
 * Biçim doğrulaması (firmasız): ürün tanınmalı, kapalı olmamalı (`off` ürüne rol verilmez, `isProductOn`), rol katalogdaki bir
 * hazır rol ya da özel rol anahtarı (`custom:<uuid>`) olmalı. `null` "Erişim yok" demektir ve her üründe kabul edilir.
 * Firmaya bağlı kurallar: rolün firmada geçerliliği ve sahibe özel izin `assertAssignableRoles`'ta, `pilot` üründe abonelik
 * `applyProductRoles`'ta.
 */
export function validateProductRoles(input: ProductRolesInput): ProductRolesInput {
  for (const [product, role] of Object.entries(input)) {
    if (!isProductKey(product)) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product });
    if (role === null) continue;
    if (!isProductOn(product)) throw new AppError(400, 'PRODUCT_NOT_AVAILABLE', { product });
    if (!isValidProductRole(product, role) && !isCustomRoleKey(role)) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product, role });
  }
  return input;
}

/**
 * Atanan rollerin firmada geçerliliği (rol defteriyle): gizlenmiş hazır rol ve bu firmanın o ürününde olmayan özel rol
 * `400 INVALID_PRODUCT_ROLE`. Sahibe özel izin (`ownerOnlyPermissions`, ör. DeciShip ayarları) taşıyan rolü yalnız OWNER verir:
 * aksi `403 ROLE_FORBIDDEN { reason: 'owner_only' }`. `current`: hedefin bugünkü rolleri; değişmeyen rol yeniden denetlenmez
 * (yönetici, sahibin verdiği rolü taşıyan çalışanın başka alanını değiştirebilsin). Çağıran `lockAssignedRoles` almış olmalı.
 *
 * Karar (güvenlik incelemesi, 2026-11-13): yetki yükseltme kuralı ("yönetici kendinde olmayan izni role koyamaz") yalnız rol
 * TANIMINI korur (`roles.ts`: oluşturma, düzenleme, varsayılana dönüş). Var olan bir rolü atamak (üye rolü, davet, silmede
 * `reassignTo`) bugünkü gibi yalnız "hedefi yönetebilir mi" (`authorizeMemberChange`/`authorizeInvitedRole`) ve sahibe özel izin
 * kuralıyla sınırlıdır: Denetleyici olan yönetici Muhasebe rolünü (kendinde olmayan itiraz izniyle) çalışana verebilir.
 */
export async function assertAssignableRoles(
  tx: Tx,
  actor: { orgRole: OrgRole },
  orgId: string,
  roles: ProductRolesInput,
  current: Readonly<Record<string, string | null | undefined>> = {},
): Promise<void> {
  const granted = Object.entries(roles).filter((e): e is [string, string] => e[1] !== null);
  if (!granted.length) return;
  const book = await loadRoleBook(tx, orgId);
  for (const [product, role] of granted) {
    const resolved = resolveFromBook(book, product, role);
    if (!resolved) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product, role });
    if (current[product] === role) continue;
    const ownerOnly = ownerOnlyPermissionsIn(resolved.product, resolved.permissions);
    if (ownerOnly.length && actor.orgRole !== 'OWNER') throw roleForbidden('owner_only', ownerOnly);
  }
}

/** `403 ROLE_FORBIDDEN`; metni nedene göre (`ROLE_FORBIDDEN_REASONS`, hata işleyici). */
export function roleForbidden(reason: RoleForbiddenReason, permissions?: readonly string[]): AppError {
  return new AppError(403, 'ROLE_FORBIDDEN', { reason, ...(permissions?.length ? { permissions: [...permissions] } : {}) });
}

/** Rol verilen `pilot` ürünlerden firmada aboneliği olmayanlar. Abonelik satırı her durumda sayılır (rol, yeniden açılınca geçerli olur). */
async function pilotProductsWithoutSubscription(db: Tx | PrismaClient, orgId: string, products: ProductKey[]): Promise<ProductKey[]> {
  const pilots = products.filter((p) => productLaunch(p) === 'pilot');
  if (!pilots.length) return [];
  const subs = await db.subscription.findMany({ where: { orgId, product: { in: pilots } }, select: { product: true } });
  return pilots.filter((p) => !subs.some((s) => s.product === p));
}

/**
 * Davet kabulünde rol süzgeci. Davet yazıldıktan sonra ürün kapanmış (`off`), kayıttan çıkmış ya da `pilot` olup firmada
 * aboneliği yoksa o ürünün rolü hata vermeden düşer: eski davet kabul edilebilsin, kapalı ürüne rol yazılmasın.
 * Açık üründe firmada geçerli olmayan rol (katalogda yok, gizlenmiş hazır rol, silinmiş özel rol) bugünkü gibi `INVALID_PRODUCT_ROLE` verir.
 *
 * Özel roller: rol kilit altında (`lockAssignedRoles`) çözülür; sahibe özel izin taşıyan rolü daveti açanın BUGÜNKÜ firma rolü
 * vermeye yetmiyorsa (yönetici açtı, rol sonradan o izni aldı ya da açan sahiplikten düştü) davet geçersizdir (`400 INVITE_INVALID`).
 */
export async function invitedProductRoles(
  tx: Tx,
  invitation: { orgId: string; invitedById: string; productRoles: Prisma.JsonValue },
): Promise<ProductRolesInput> {
  const { orgId } = invitation;
  const input = (invitation.productRoles ?? {}) as ProductRolesInput;
  const kept: ProductRolesInput = {};
  for (const [product, role] of Object.entries(input)) {
    if (!isProductKey(product)) continue;
    if (role !== null && !isProductOn(product)) continue;
    kept[product] = role;
  }
  const granted = Object.keys(kept).filter((p): p is ProductKey => kept[p] !== null && isProductKey(p));
  for (const p of await pilotProductsWithoutSubscription(tx, orgId, granted)) delete kept[p];
  validateProductRoles(kept);
  await lockAssignedRoles(tx, orgId, kept);
  const inviter = await tx.membership.findFirst({ where: { id: invitation.invitedById, orgId }, select: { orgRole: true } });
  try {
    await assertAssignableRoles(tx, { orgRole: inviter?.orgRole ?? 'MEMBER' }, orgId, kept);
  } catch (err) {
    if (err instanceof AppError && err.code === 'ROLE_FORBIDDEN') throw new AppError(400, 'INVITE_INVALID');
    throw err;
  }
  return kept;
}

/**
 * Firmaya bağlı rol kuralı (rol atama ve davet oluşturma aynı yardımcıyı kullanır): `validateProductRoles` (kapalı ürün,
 * katalog) artı `pilot` ürüne rol yalnız o üründe abonelik satırı olan firmada. Aksi `400 PRODUCT_NOT_AVAILABLE`:
 * pilot araç aboneliği olmayan firmada görünmesin.
 */
export async function assertProductRolesForOrg(db: Tx | PrismaClient, orgId: string, roles: ProductRolesInput): Promise<ProductRolesInput> {
  validateProductRoles(roles);
  const granted = Object.keys(roles).filter((p): p is ProductKey => roles[p] !== null && isProductKey(p));
  const missing = await pilotProductsWithoutSubscription(db, orgId, granted);
  if (missing.length) throw new AppError(400, 'PRODUCT_NOT_AVAILABLE', { product: missing[0] });
  return roles;
}

/**
 * Değişiklik olduysa true. `pilot` ürüne rol yalnız o üründe aboneliği olan firmada yazılır (`assertProductRolesForOrg`).
 * Çağıran işlem içindedir; hata işlemi geri alır.
 */
export async function applyProductRoles(tx: Tx, membershipId: string, roles: ProductRolesInput): Promise<boolean> {
  const granted = Object.keys(roles).filter((p): p is ProductKey => roles[p] !== null && isProductKey(p));
  if (granted.some((p) => productLaunch(p) === 'pilot')) {
    const { orgId } = await tx.membership.findUniqueOrThrow({ where: { id: membershipId }, select: { orgId: true } });
    const missing = await pilotProductsWithoutSubscription(tx, orgId, granted);
    if (missing.length) throw new AppError(400, 'PRODUCT_NOT_AVAILABLE', { product: missing[0] });
  }
  let changed = false;
  const current = await tx.productAccess.findMany({ where: { membershipId } });
  for (const [product, role] of Object.entries(roles)) {
    const existing = current.find((a) => a.product === product);
    // Özel rolde yabancı anahtar da yazılır (göçteki CHECK: rol anahtarı ile `customRoleId` birlikte).
    const customRoleId = customRoleIdOf(role);
    if (role === null) {
      if (existing) {
        await tx.productAccess.delete({ where: { membershipId_product: { membershipId, product } } });
        changed = true;
      }
    } else if (!existing) {
      await tx.productAccess.create({ data: { membershipId, product, role, customRoleId } });
      changed = true;
    } else if (existing.role !== role) {
      await tx.productAccess.update({ where: { membershipId_product: { membershipId, product } }, data: { role, customRoleId } });
      changed = true;
    }
  }
  return changed;
}

/**
 * Kişinin oturum, kimlik ve üyelik değişikliklerini sıraya koyar. NO KEY: yabancı anahtar denetimlerini bekletmez.
 * Tek kilit sırası (ARCHITECTURE §5): kişi, sonra üyelik, sonra davet. Birden çok kişi kimliğe göre sıralanır.
 */
export async function lockPersons(tx: Tx, personIds: string[]) {
  const unique = [...new Set(personIds)];
  if (unique.length) await tx.$queryRaw`SELECT 1 FROM "platform"."Person" WHERE "id" IN (${Prisma.join(unique)}) ORDER BY "id" FOR NO KEY UPDATE`;
}

export async function lockPerson(tx: Tx, personId: string) {
  await lockPersons(tx, [personId]);
}

/**
 * Şifre işlem dışında doğrulanır (argon2 uzun sürer). Kilit alındıktan sonra özet değiştiyse doğrulama geçersizdir:
 * eşzamanlı şifre değişimi sonrası eski şifreyle oturum açılmasın, işlem yapılmasın.
 */
export async function assertPasswordUnchanged(tx: Tx, personId: string, verifiedHash: string) {
  await lockPerson(tx, personId);
  const current = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { passwordHash: true } });
  if (current.passwordHash !== verifiedHash) throw new AppError(401, 'INVALID_CREDENTIALS');
}

/**
 * Üyelik satırlarını kilitler. Önce sahiplerini: kişi satırını sonradan isteyen akış (`removeMembership`, devir) şifre değişimiyle
 * karşılıklı beklemesin. Kaynakta üyelik satırını kilitleyen tek yer burasıdır, test bunu denetler.
 */
export async function lockMemberships(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)];
  const owners = await tx.membership.findMany({ where: { id: { in: unique } }, select: { personId: true } });
  await lockPersons(tx, owners.map((o) => o.personId));
  await tx.$queryRaw`SELECT 1 FROM "platform"."Membership" WHERE "id" IN (${Prisma.join(unique)}) ORDER BY "id" FOR UPDATE`;
}

/** Epoch artışı ve olay aynı işlemde. */
export async function bumpEpoch(tx: Tx, membershipId: string) {
  await tx.membership.update({ where: { id: membershipId }, data: { epoch: { increment: 1 } } });
  await emitMemberUpserted(tx, membershipId);
}

/** Şifre değişimi, aile iptali: kişinin tüm firmalardaki jetonları bayatlar. */
export async function bumpPersonEpochs(tx: Tx, personId: string) {
  const memberships = await tx.membership.findMany({ where: { personId }, select: { id: true }, orderBy: { id: 'asc' } });
  if (memberships.length) await lockMemberships(tx, memberships.map((m) => m.id));
  for (const m of memberships) await bumpEpoch(tx, m.id);
}

/** Yetkisini kaybeden yöneticinin bekleyen davetleri geçersiz olur: giderken arkasında kapı bırakamaz. */
export async function revokeInvitationsBy(tx: Tx, membershipId: string) {
  await tx.invitation.updateMany({
    where: { invitedById: membershipId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Sahiplik devrinde eski sahip yönetici olur (03-B1): sahipken açtığı ve yöneticinin açamayacağı bekleyen davetler ve şifre kodları
 * (yönetici rolüyle davet, yöneticiye üretilmiş şifre kodu) düşer. Üye düzeyindeki davetler kalır: yönetici onları yine açabilir.
 */
export async function revokeOwnerOnlyInvitationsBy(tx: Tx, membershipId: string) {
  await tx.invitation.updateMany({
    where: { invitedById: membershipId, acceptedAt: null, revokedAt: null, orgRole: { not: 'MEMBER' } },
    data: { revokedAt: new Date() },
  });
}

/**
 * Kabul anında ikinci kat (03-B1): daveti ya da şifre kodunu üretenin BUGÜNKÜ yetkisi o işi hâlâ yapmaya yetiyor mu?
 * Üretenin üyeliği yoksa, askıdaysa ya da rolü artık yetmiyorsa (devir, rol düşürme) kod geçersizdir. İptal yollarından biri
 * unutulsa da eski yetkiyle üretilmiş kod çalışmaz. Okuma kilitsizdir: devirle eşzamanlı kabul, devirden önce yapılmış sayılır.
 */
export async function inviterStillAuthorized(
  tx: Tx | PrismaClient,
  invitation: { orgId: string; invitedById: string; orgRole: OrgRole; kind: string; targetPersonId: string | null; productRoles?: Prisma.JsonValue },
): Promise<boolean> {
  const inviter = await tx.membership.findFirst({
    where: { id: invitation.invitedById, orgId: invitation.orgId },
    select: { id: true, orgRole: true, status: true },
  });
  if (!inviter || inviter.status !== 'ACTIVE') return false;
  try {
    if (invitation.kind === 'PHONE_RESET') {
      if (!invitation.targetPersonId) return false;
      const target = await tx.membership.findFirst({
        where: { orgId: invitation.orgId, personId: invitation.targetPersonId },
        select: { id: true, orgRole: true },
      });
      if (!target) return false;
      authorizeMemberChange(inviter, target, { resetCode: true });
    } else {
      authorizeInvitedRole(inviter, invitation.orgRole);
      // Sahibe özel izin taşıyan ürün rolünü yalnız OWNER davetle verir; bugünkü rol tanımıyla bakılır (rol sonradan o izni almış
      // olabilir). Geçersiz rol burada değil, kabulde (`invitedProductRoles`) hata verir.
      if (inviter.orgRole !== 'OWNER' && (await invitationGrantsOwnerOnly(tx, invitation.orgId, invitation.productRoles))) return false;
    }
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
  return true;
}

/**
 * Davetteki ürün rollerinin bugün taşıdığı sahibe özel izinler (kilitsiz okuma; kabul ayrıca kilit altında denetler). Boşsa davet
 * firma yöneticisinin de verebileceği bir davettir.
 */
export async function invitationOwnerOnlyPermissions(db: Tx | PrismaClient, orgId: string, productRoles: Prisma.JsonValue | undefined): Promise<string[]> {
  const entries = Object.entries((productRoles ?? {}) as ProductRolesInput).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (!entries.length) return [];
  const book = await loadRoleBook(db, orgId);
  const out = new Set<string>();
  for (const [product, role] of entries) {
    const resolved = resolveFromBook(book, product, role);
    if (resolved) for (const p of ownerOnlyPermissionsIn(resolved.product, resolved.permissions)) out.add(p);
  }
  return [...out];
}

async function invitationGrantsOwnerOnly(db: Tx | PrismaClient, orgId: string, productRoles: Prisma.JsonValue | undefined): Promise<boolean> {
  return (await invitationOwnerOnlyPermissions(db, orgId, productRoles)).length > 0;
}

/** Şifre kodu üretildiği andaki role bağlıdır. Rol değişince kodu üreten yönetici yükselen hesabı alamasın. */
export async function revokeResetCodesFor(tx: Tx, personId: string) {
  await tx.invitation.updateMany({
    where: { targetPersonId: personId, kind: 'PHONE_RESET', acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function emitMemberRemoved(
  tx: Tx,
  membership: { id: string; orgId: string; personId: string; epoch: number; person: { name: string } },
) {
  for (const product of await eventProductsOf(tx, membership.orgId)) {
    await enqueueEvent(tx, {
      type: 'member.removed',
      orgId: membership.orgId,
      product,
      membershipId: membership.id,
      personId: membership.personId,
      name: membership.person.name,
      epoch: membership.epoch + 1,
    });
  }
}

/** Üyeliği kaldırır: olay (epoch + 1), bekleyen davetler, son firma ve oturum kayıtları. Çağıran satırı kilitlemiş olmalı. */
export async function removeMembership(
  tx: Tx,
  membership: { id: string; orgId: string; personId: string; epoch: number; person: { name: string } },
) {
  await emitMemberRemoved(tx, membership);
  await revokeInvitationsBy(tx, membership.id);
  await tx.membership.delete({ where: { id: membership.id } });
  await tx.person.updateMany({ where: { id: membership.personId, lastOrgId: membership.orgId }, data: { lastOrgId: null } });
  await tx.session.updateMany({
    where: { personId: membership.personId, activeOrgId: membership.orgId, revokedAt: null },
    data: { activeOrgId: null },
  });
}

export type MemberUpdateInput = { orgRole?: 'ADMIN' | 'MEMBER' | 'OWNER'; status?: 'ACTIVE' | 'SUSPENDED'; productRoles?: ProductRolesInput };

/**
 * Üyelik güncellemesi. Değişiklik yoksa epoch artmaz, olay yazılmaz.
 * Dışarıdan işlem verilir: epoch ile olayın aynı işlemde olduğu test edilebilsin.
 */
export async function applyMemberUpdate(tx: Tx, targetId: string, input: MemberUpdateInput): Promise<string[]> {
  const before = await tx.membership.findUniqueOrThrow({ where: { id: targetId } });
  const changed: string[] = [];
  const data: { orgRole?: OrgRole; status?: 'ACTIVE' | 'SUSPENDED' } = {};
  if (input.orgRole && input.orgRole !== before.orgRole) {
    data.orgRole = input.orgRole;
    changed.push('orgRole');
  }
  if (input.status && input.status !== before.status) {
    data.status = input.status;
    changed.push('status');
  }
  if (Object.keys(data).length) await tx.membership.update({ where: { id: targetId }, data });
  if (data.orgRole) await revokeResetCodesFor(tx, before.personId);
  if (input.productRoles && (await applyProductRoles(tx, targetId, input.productRoles))) changed.push('productRoles');
  if (changed.length) await bumpEpoch(tx, targetId);
  return changed;
}

export async function createMembershipWithRoles(
  tx: Tx,
  input: { personId: string; orgId: string; orgRole: OrgRole; productRoles: ProductRolesInput },
) {
  const membership = await tx.membership.create({
    data: { personId: input.personId, orgId: input.orgId, orgRole: input.orgRole },
  });
  await applyProductRoles(tx, membership.id, input.productRoles);
  await emitMemberUpserted(tx, membership.id);
  return membership;
}
