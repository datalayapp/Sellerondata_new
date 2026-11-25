/**
 * Özel roller ve hazır rol düzenleme (sözleşme `contracts/src/roles.ts`).
 * Çözücü `roleBook.ts`'tedir; burada yönetim uçlarının işi (liste, oluşturma, düzenleme, silme, varsayılana dönüş) durur.
 *
 * Güvenlik kuralları (plan "Orkestratörün eklediği güvenlik kuralları"):
 * - Rolü yalnız OWNER ve ADMIN yönetir. ADMIN bir rolü yalnız o rolün bütün sahiplerini (üyelik ve bekleyen davet) yönetebiliyorsa
 *   düzenler, siler ya da varsayılana döndürür: kendisi, OWNER ya da başka ADMIN taşıyorsa `ROLE_FORBIDDEN unmanageable_holder`.
 *   OWNER kendi araç rolünü de yönetebildiği için (`authorizeMemberChange`) kendi rolünü düzenleyebilir.
 * - Sahibe özel izin (`ownerOnlyPermissions`) bulunan rolü (önceki ya da yeni hali) yalnız OWNER oluşturur, düzenler, siler, başka
 *   role taşır (`owner_only`). Rolde OWNER olmayan birinin açtığı süresi geçmemiş bekleyen davet varken o role sahibe özel izin
 *   eklenmez, davetler o role taşınmaz (`pending_admin_invites`, `assertInvitesKeepInviter`): kabulde ölürlerdi.
 * - ADMIN kendinde olmayan izni role koyamaz (`escalation`): yeni rolde bütün izinler, düzenlemede eklenen izinler.
 * - Sahip rolü (ve `lockedRoles`) izinleri kilitli (`ROLE_LOCKED`), sahip rolü silinemez; adı değişebilir.
 * - İzin seti ürünün kataloğunun alt kümesi ve bağımlılıkları karşılanmış olmalı; eksik kendiliğinden eklenmez (`INVALID_ROLE_PERMISSIONS`).
 * - Ürün başına en çok `CUSTOM_ROLE_LIMIT` özel rol (`ROLE_LIMIT`); ad ürün içinde büyük/küçük harf duyarsız tekil, katalog adları dahil
 *   (`ROLE_NAME_TAKEN`); eski `version` → `ROLE_VERSION`.
 *
 * Kilit sırası (her yazma): ürün rol kilidi (özel, `lockRoleProducts`), rol satırı `FOR UPDATE`, kişi + üyelik (`lockMemberships`:
 * isteği yapan ve rolün sahipleri), davet. İzni değişen rolün her sahibi için aynı işlemde `bumpEpoch` + `member.upserted`.
 */

import {
  CUSTOM_ROLE_LIMIT,
  PRODUCTS,
  customRoleIdOf,
  customRoleKey,
  isProductKey,
  isRoleDeletable,
  isRolePermissionsLocked,
  orderPermissions,
  ownerOnlyPermissionsIn,
  permissionGroupOf,
  productRole,
  requiredPermissionsOf,
  validateRolePermissions,
  type AuditRoleChange,
  type CreateRoleBody,
  type DeleteRoleResponse,
  type Locale,
  type OrgProductRole,
  type OrgRole,
  type OrgRolesResponse,
  type PatchRoleBody,
  type Permission,
  type ProductKey,
  type RoleBlockingInvitation,
} from '@sellerondata/contracts';
import { Prisma, type PrismaClient, type Tx } from '../db.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { writeAudit, type Actor } from './audit.ts';
import { authorizeInvitedRole, authorizeMemberChange, bumpEpoch, lockMemberships, roleForbidden } from './members.ts';
import { productAccessFor } from './productAccess.ts';
import {
  ROLE_ROW_SELECT,
  loadRoleBook,
  lockRoleProducts,
  resolveBuiltin,
  resolveCustom,
  resolveFromBook,
  visibleRoles,
  type ResolvedRole,
  type RoleBook,
} from './roleBook.ts';

export { resolveRole, resolveFromBook, loadRoleBook } from './roleBook.ts';

type Db = PrismaClient | Tx;

/** Uç bağlamı: istek yapanın üyeliği, denetim kimliği ve yanıt dili. */
export type RoleRequestCtx = { orgId: string; actorMembershipId: string; audit: Actor; locale: Locale };

type Holder = { id: string; orgRole: OrgRole };
type InviteHolder = {
  id: string;
  orgRole: OrgRole;
  productRoles: Prisma.JsonValue;
  invitedById: string;
  expiresAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
};
type Usage = { holders: Map<string, Holder[]>; invites: Map<string, InviteHolder[]> };
type ActorRow = { id: string; orgId: string; orgRole: OrgRole };

// ---------- Okuma yardımcıları ----------

/** Firmada rolü olan araçlar: bu firmada açık ve hazır rolü olan ürünler, kayıt sırasıyla (`GET /org/roles` ve yazma uçları). */
async function roleProducts(db: Db, orgId: string): Promise<ProductKey[]> {
  const subscriptions = await db.subscription.findMany({ where: { orgId } });
  return productAccessFor([], subscriptions)
    .filter((s) => s.available && PRODUCTS[s.key].roles.length > 0)
    .map((s) => s.key);
}

async function assertRoleProduct(db: Db, orgId: string, product: string, notFoundOtherwise: boolean): Promise<ProductKey> {
  if (isProductKey(product) && (await roleProducts(db, orgId)).includes(product)) return product;
  if (notFoundOtherwise) throw notFound();
  if (!isProductKey(product)) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product });
  throw new AppError(400, 'PRODUCT_NOT_AVAILABLE', { product });
}

/** Ürünün rol sahipleri (üyelik, kimlik sırasıyla) ve bekleyen davetleri, rol anahtarına göre. */
async function productUsage(db: Db, orgId: string, product: ProductKey): Promise<Usage> {
  const access = await db.productAccess.findMany({
    where: { product, membership: { orgId } },
    select: { role: true, membership: { select: { id: true, orgRole: true } } },
    orderBy: { membershipId: 'asc' },
  });
  const pending = await db.invitation.findMany({
    where: { orgId, acceptedAt: null, revokedAt: null, kind: { not: 'PHONE_RESET' } },
    select: { id: true, orgRole: true, productRoles: true, invitedById: true, expiresAt: true, name: true, email: true, phone: true },
    orderBy: { id: 'asc' },
  });
  const holders = new Map<string, Holder[]>();
  for (const a of access) holders.set(a.role, [...(holders.get(a.role) ?? []), a.membership]);
  const invites = new Map<string, InviteHolder[]>();
  for (const i of pending) {
    const role = ((i.productRoles ?? {}) as Record<string, unknown>)[product];
    if (typeof role === 'string') invites.set(role, [...(invites.get(role) ?? []), i]);
  }
  return { holders, invites };
}

/** İstek yapan rolün bütün sahiplerini yönetebiliyor mu (`authorizeMemberChange`, davette `authorizeInvitedRole`). */
function managesHolders(actor: ActorRow, holders: readonly Holder[], invites: readonly InviteHolder[]): boolean {
  try {
    for (const h of holders) authorizeMemberChange(actor, h, { productRoles: {} });
    for (const i of invites) authorizeInvitedRole(actor, i.orgRole);
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

function ownerOnlyBlocked(actor: ActorRow, product: ProductKey, perms: Iterable<string>): Permission[] {
  return actor.orgRole === 'OWNER' ? [] : ownerOnlyPermissionsIn(product, perms);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

const diff = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));

/** Büyük/küçük harf duyarsız karşılaştırma anahtarları (Türkçe ve genel küçük harf; veritabanı dizini `lower(name)` ayrıca korur). */
function nameKeys(name: string): string[] {
  const n = name.normalize('NFC').trim();
  return [...new Set([n.toLowerCase(), n.toLocaleLowerCase('tr')])];
}

/** Ad üründe görünen başka bir rolün (katalog adının iki dili dahil) adıyla çakışıyor mu. */
function assertNameFree(book: RoleBook, product: ProductKey, names: readonly string[], exceptKey: string | null) {
  const wanted = new Set(names.flatMap(nameKeys));
  for (const r of visibleRoles(book, product)) {
    if (r.key === exceptKey) continue;
    const taken = r.label.tr === r.label.en ? [r.label.tr] : [r.label.tr, r.label.en];
    if (taken.flatMap(nameKeys).some((k) => wanted.has(k))) throw new AppError(409, 'ROLE_NAME_TAKEN');
  }
}

async function orgLocale(db: Db, orgId: string): Promise<Locale> {
  return (await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { locale: true } })).locale;
}

/** İstek yapanın bu üründeki izinleri (yetki yükseltme denetimi). */
async function actorPermissions(db: Db, book: RoleBook, actorId: string, product: ProductKey): Promise<Permission[]> {
  const access = await db.productAccess.findUnique({ where: { membershipId_product: { membershipId: actorId, product } }, select: { role: true } });
  return resolveFromBook(book, product, access?.role)?.permissions ?? [];
}

/**
 * İstek yapanı ve rolün sahiplerini kilitler, sahipleri kilit altında yeniden okur. Ürün kilidi (özel) alınmış olduğundan yeni sahip
 * eklenemez; yine de kilitten önce okunan liste eskiyse (eşzamanlı çıkarma, firma rolü değişimi) yeniden okunan liste geçerlidir.
 */
async function lockActorAndHolders(tx: Tx, ctx: RoleRequestCtx, product: ProductKey, key: string): Promise<{ actor: ActorRow; usage: Usage }> {
  const locked = new Set<string>();
  let usage = await productUsage(tx, ctx.orgId, product);
  for (let i = 0; ; i++) {
    const need = [ctx.actorMembershipId, ...(usage.holders.get(key) ?? []).map((h) => h.id)].filter((id) => !locked.has(id));
    if (!need.length) break;
    if (i >= 3) throw new AppError(409, 'CONFLICT');
    await lockMemberships(tx, need);
    for (const id of need) locked.add(id);
    usage = await productUsage(tx, ctx.orgId, product);
  }
  const actor = await tx.membership.findUnique({ where: { id: ctx.actorMembershipId }, select: { id: true, orgId: true, orgRole: true, status: true } });
  if (!actor || actor.status !== 'ACTIVE' || actor.orgId !== ctx.orgId || (actor.orgRole !== 'OWNER' && actor.orgRole !== 'ADMIN')) throw forbidden();
  return { actor, usage };
}

/**
 * Sahibe özel izin role giderken (düzenleme ve varsayılana dönüşte eklenen izin, silmede taşınılan rol) o roldeki süresi geçmemiş
 * bekleyen davetlerden biri bugün OWNER olmayan birinin açtığı davetse istek reddedilir, davetler iptal edilmez. Yoksa kabulde açanın
 * yetkisi yetmez (`inviterStillAuthorized`: sahibe özel izinli rolü yalnız OWNER davetle verir) ve davet sessizce ölürdü (KALANLAR
 * 6.11). Ret `ROLE_FORBIDDEN pending_admin_invites`, `details.invitations` engel olan davetler: sahip onları iptal eder ya da kendisi
 * yeniden gönderir (yeniden gönderen davetin sahibi olur), sonra izni ekler.
 * Süresi geçmiş davet engel değildir: kabul edilemez, ancak yeniden gönderilerek dirilir ve yeniden gönderme o anki kişinin yetkisini
 * sınar (yönetici sahibe özel izinli daveti yeniden gönderemez). Davetler `lockActorAndHolders` altında okunmuştur: ürün kilidi yeni
 * davetin role bağlanmasını ve yeniden göndermeyi bekletir.
 */
async function assertInvitesKeepInviter(tx: Tx, orgId: string, product: ProductKey, invites: readonly InviteHolder[], granting: readonly string[]) {
  const granted = ownerOnlyPermissionsIn(product, granting);
  const now = new Date();
  const live = invites.filter((i) => i.expiresAt > now);
  if (!granted.length || !live.length) return;
  const inviters = await tx.membership.findMany({
    where: { id: { in: [...new Set(live.map((i) => i.invitedById))] }, orgId },
    select: { id: true, orgRole: true },
  });
  const ownerIds = new Set(inviters.filter((m) => m.orgRole === 'OWNER').map((m) => m.id));
  const blocking = live.filter((i) => !ownerIds.has(i.invitedById));
  if (!blocking.length) return;
  const invitations: RoleBlockingInvitation[] = blocking.map((i) => ({ id: i.id, name: i.name, contact: i.email ?? i.phone }));
  throw new AppError(403, 'ROLE_FORBIDDEN', { reason: 'pending_admin_invites', permissions: [...granted], invitations });
}

/** Rol satırı (özel rol kimliğiyle ya da hazır rolün gölgesi) `FOR UPDATE`. */
async function lockRoleRow(tx: Tx, orgId: string, target: { product: ProductKey; key: string }) {
  const id = customRoleIdOf(target.key);
  if (id) await tx.$queryRaw`SELECT 1 FROM "platform"."ProductRole" WHERE "id" = ${id} AND "orgId" = ${orgId} FOR UPDATE`;
  else await tx.$queryRaw`SELECT 1 FROM "platform"."ProductRole" WHERE "orgId" = ${orgId} AND "product" = ${target.product} AND "builtinKey" = ${target.key} FOR UPDATE`;
}

function assertPermissionsValid(product: ProductKey, perms: readonly string[]): Permission[] {
  const check = validateRolePermissions(product, perms);
  if (!check.ok) throw new AppError(400, 'INVALID_ROLE_PERMISSIONS', { missing: check.missing, unknown: check.unknown });
  return orderPermissions(product, perms);
}

/** Denetimdeki ad anlık görüntüsü: firmanın yazdığı ad, yoksa katalog adı firmanın dilinde. */
const auditName = (r: ResolvedRole, locale: Locale) => r.label[locale];

// ---------- Görünüm ----------

function roleView(r: ResolvedRole, usage: Usage, actor: ActorRow, locale: Locale): OrgProductRole {
  const holders = usage.holders.get(r.key) ?? [];
  const invites = usage.invites.get(r.key) ?? [];
  const manageable = managesHolders(actor, holders, invites) && ownerOnlyBlocked(actor, r.product, r.permissions).length === 0;
  const view: OrgProductRole = {
    key: r.key,
    kind: r.kind,
    name: r.label[locale],
    permissions: [...r.permissions],
    memberCount: holders.length,
    inviteCount: invites.length,
    editable: manageable,
    permissionsLocked: r.kind === 'builtin' && isRolePermissionsLocked(r.product, r.key),
    deletable: manageable && (r.kind === 'custom' || isRoleDeletable(r.product, r.key)),
    edited: r.edited,
    version: r.version,
  };
  if (r.description) view.description = r.description[locale];
  if (r.basedOn) view.basedOn = r.basedOn;
  return view;
}

async function viewOf(db: Db, ctx: RoleRequestCtx, product: ProductKey, key: string): Promise<OrgProductRole> {
  const book = await loadRoleBook(db, ctx.orgId);
  const r = resolveFromBook(book, product, key);
  if (!r) throw notFound();
  const actor = await db.membership.findUniqueOrThrow({ where: { id: ctx.actorMembershipId }, select: { id: true, orgId: true, orgRole: true } });
  return roleView(r, await productUsage(db, ctx.orgId, product), actor, ctx.locale);
}

// ---------- Uçlar ----------

/** `GET /org/roles`. */
export async function listOrgRoles(db: Db, ctx: RoleRequestCtx): Promise<OrgRolesResponse> {
  const actor = await db.membership.findUniqueOrThrow({ where: { id: ctx.actorMembershipId }, select: { id: true, orgId: true, orgRole: true } });
  const book = await loadRoleBook(db, ctx.orgId);
  const products: OrgRolesResponse['products'] = [];
  for (const key of await roleProducts(db, ctx.orgId)) {
    const def = PRODUCTS[key];
    const usage = await productUsage(db, ctx.orgId, key);
    const ownerOnly = new Set<string>(def.ownerOnlyPermissions ?? []);
    products.push({
      key,
      groups: (def.permissionGroups ?? []).map((g) => ({ key: g.key, label: g.label })),
      permissions: (Object.keys(def.permissions) as Permission[]).map((p) => ({
        key: p,
        label: def.permissions[p] as { tr: string; en: string },
        group: permissionGroupOf(key, p) ?? '',
        requires: requiredPermissionsOf(key, p),
        ownerOnly: ownerOnly.has(p),
      })),
      roles: visibleRoles(book, key).map((r) => roleView(r, usage, actor, ctx.locale)),
      hiddenBuiltins: def.roles
        .filter((r) => resolveBuiltin(book, key, r.key)?.hidden)
        .map((r) => ({ key: r.key, name: r.label[ctx.locale] })),
      customRoleLimit: CUSTOM_ROLE_LIMIT,
    });
  }
  return { products };
}

/** `POST /org/roles`. */
export async function createRole(tx: Tx, ctx: RoleRequestCtx, body: CreateRoleBody): Promise<OrgProductRole> {
  const product = await assertRoleProduct(tx, ctx.orgId, body.product, false);
  if (body.basedOn !== undefined && !productRole(product, body.basedOn)) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product, role: body.basedOn });
  await lockRoleProducts(tx, ctx.orgId, [product], 'exclusive');
  const permissions = assertPermissionsValid(product, body.permissions);
  await lockMemberships(tx, [ctx.actorMembershipId]);
  const actor = await tx.membership.findUnique({ where: { id: ctx.actorMembershipId }, select: { id: true, orgId: true, orgRole: true, status: true } });
  if (!actor || actor.status !== 'ACTIVE' || actor.orgId !== ctx.orgId || (actor.orgRole !== 'OWNER' && actor.orgRole !== 'ADMIN')) throw forbidden();
  const book = await loadRoleBook(tx, ctx.orgId);

  const ownerOnly = ownerOnlyBlocked(actor, product, permissions);
  if (ownerOnly.length) throw roleForbidden('owner_only', ownerOnly);
  if (actor.orgRole !== 'OWNER') {
    const escalated = diff(permissions, await actorPermissions(tx, book, actor.id, product));
    if (escalated.length) throw roleForbidden('escalation', escalated);
  }
  const count = await tx.productRole.count({ where: { orgId: ctx.orgId, product, builtinKey: null } });
  if (count >= CUSTOM_ROLE_LIMIT) throw new AppError(409, 'ROLE_LIMIT');
  assertNameFree(book, product, [body.name], null);

  const description = body.description ? body.description : null;
  const row = await tx.productRole.create({
    data: {
      orgId: ctx.orgId,
      product,
      name: body.name,
      description,
      permissions,
      basedOn: body.basedOn ?? null,
      version: 1,
      createdById: actor.id,
    },
    select: ROLE_ROW_SELECT,
  });
  const key = customRoleKey(row.id);
  const meta: AuditRoleChange = { product, role: key, kind: 'custom', name: body.name, permissions, ...(body.basedOn ? { basedOn: body.basedOn } : {}) };
  await writeAudit(tx, { orgId: ctx.orgId, actor: ctx.audit, action: 'role.created', target: key, meta: meta as Prisma.InputJsonValue });
  return viewOf(tx, ctx, product, key);
}

/** `PATCH /org/roles/:id` (özel) ve `PATCH /org/roles/builtin/:product/:key` (hazır; ilk düzenleme gölge satırı açar). */
export async function patchRole(
  tx: Tx,
  ctx: RoleRequestCtx,
  target: { customId: string } | { product: string; key: string },
  body: PatchRoleBody,
): Promise<OrgProductRole> {
  const { product, key } = await locateRole(tx, ctx, target);
  await lockRoleProducts(tx, ctx.orgId, [product], 'exclusive');
  await lockRoleRow(tx, ctx.orgId, { product, key });
  let book = await loadRoleBook(tx, ctx.orgId);
  const current = currentRole(book, product, key);
  if (body.version !== current.version) throw new AppError(409, 'ROLE_VERSION');

  let nextPermissions: Permission[] = current.permissions;
  if (body.permissions !== undefined) {
    const wanted = assertPermissionsValid(product, body.permissions);
    if (current.kind === 'builtin' && isRolePermissionsLocked(product, key) && !sameSet(wanted, current.permissions)) throw new AppError(403, 'ROLE_LOCKED');
    nextPermissions = wanted;
  }
  const permsChanged = !sameSet(nextPermissions, current.permissions);
  const added = diff(nextPermissions, current.permissions);
  const removed = diff(current.permissions, nextPermissions);

  const { actor, usage } = await lockActorAndHolders(tx, ctx, product, key);
  if (!managesHolders(actor, usage.holders.get(key) ?? [], usage.invites.get(key) ?? [])) throw roleForbidden('unmanageable_holder');
  const ownerOnly = ownerOnlyBlocked(actor, product, [...current.permissions, ...nextPermissions]);
  if (ownerOnly.length) throw roleForbidden('owner_only', ownerOnly);
  if (actor.orgRole !== 'OWNER' && added.length) {
    const escalated = diff(added, await actorPermissions(tx, book, actor.id, product));
    if (escalated.length) throw roleForbidden('escalation', escalated);
  }
  await assertInvitesKeepInviter(tx, ctx.orgId, product, usage.invites.get(key) ?? [], added);

  // Ad: özel rolde satırdaki ad; hazır rolde firmanın yazdığı ad (boşsa katalog adı, iki dilde). Hazır role katalog adını yazmak
  // firmanın adını kaldırır (katalog adına döner).
  const def = productRole(product, key);
  const storedName = current.row?.name ?? null;
  let nextName = storedName;
  if (body.name !== undefined) {
    nextName = current.kind === 'builtin' && def && (body.name === def.label.tr || body.name === def.label.en) ? null : body.name;
  }
  const nameChanged = nextName !== storedName;
  if (nameChanged) assertNameFree(book, product, nextName !== null ? [nextName] : def ? [def.label.tr, def.label.en] : [], key);

  const storedDescription = current.row?.description ?? null;
  const nextDescription = body.description === undefined ? storedDescription : body.description ? body.description : null;
  const descriptionChanged = nextDescription !== storedDescription;

  if (!permsChanged && !nameChanged && !descriptionChanged) return viewOf(tx, ctx, product, key);

  if (current.kind === 'custom') {
    await tx.productRole.update({
      where: { id: customRoleIdOf(key) as string },
      data: { name: nextName, description: nextDescription, permissions: nextPermissions, version: { increment: 1 } },
    });
  } else if (current.row) {
    await tx.productRole.update({
      where: { id: current.row.id },
      data: {
        name: nextName,
        description: nextDescription,
        ...(permsChanged ? { permissions: nextPermissions, inheritPermissions: false } : {}),
        version: { increment: 1 },
      },
    });
  } else {
    await tx.productRole.create({
      data: {
        orgId: ctx.orgId,
        product,
        builtinKey: key,
        name: nextName,
        description: nextDescription,
        permissions: permsChanged ? nextPermissions : [],
        inheritPermissions: !permsChanged,
        version: 1,
        createdById: actor.id,
      },
    });
  }

  // İzin değiştiyse her sahibin jetonu bayatlar ve ürünler yeni izinleri olaydan öğrenir. Yalnız ad/açıklama değişimi yetkiyi değiştirmez.
  if (permsChanged) for (const h of usage.holders.get(key) ?? []) await bumpEpoch(tx, h.id);

  book = await loadRoleBook(tx, ctx.orgId);
  const after = currentRole(book, product, key);
  const locale = await orgLocale(tx, ctx.orgId);
  const meta: AuditRoleChange = {
    product,
    role: key,
    kind: current.kind,
    name: auditName(after, locale),
    ...(nameChanged ? { previousName: auditName(current, locale) } : {}),
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(descriptionChanged ? { descriptionChanged: true } : {}),
  };
  await writeAudit(tx, { orgId: ctx.orgId, actor: ctx.audit, action: 'role.updated', target: key, meta: meta as Prisma.InputJsonValue });
  return viewOf(tx, ctx, product, key);
}

/**
 * `DELETE /org/roles/:id?reassignTo=` (satır silinir) ve `DELETE /org/roles/builtin/:product/:key?reassignTo=` (hazır rol firmada
 * gizlenir). Kullanımdaki rol `reassignTo` olmadan `409 ROLE_IN_USE`; sahipler ve davetler aynı işlemde yeni role taşınır.
 */
export async function deleteRole(
  tx: Tx,
  ctx: RoleRequestCtx,
  target: { customId: string } | { product: string; key: string },
  reassignTo: string | undefined,
): Promise<DeleteRoleResponse> {
  const { product, key } = await locateRole(tx, ctx, target);
  if (!customRoleIdOf(key) && !isRoleDeletable(product, key)) throw new AppError(403, 'ROLE_LOCKED');
  await lockRoleProducts(tx, ctx.orgId, [product], 'exclusive');
  await lockRoleRow(tx, ctx.orgId, { product, key });
  const book = await loadRoleBook(tx, ctx.orgId);
  const current = currentRole(book, product, key);

  let next: ResolvedRole | null = null;
  if (reassignTo !== undefined) {
    next = resolveFromBook(book, product, reassignTo);
    if (!next || next.key === key) throw new AppError(400, 'INVALID_PRODUCT_ROLE', { product, role: reassignTo });
    if (next.row) await tx.$queryRaw`SELECT 1 FROM "platform"."ProductRole" WHERE "id" = ${next.row.id} FOR SHARE`;
  }

  const { actor, usage } = await lockActorAndHolders(tx, ctx, product, key);
  const holders = usage.holders.get(key) ?? [];
  const invites = usage.invites.get(key) ?? [];
  if (!managesHolders(actor, holders, invites)) throw roleForbidden('unmanageable_holder');
  const ownerOnly = ownerOnlyBlocked(actor, product, current.permissions);
  if (ownerOnly.length) throw roleForbidden('owner_only', ownerOnly);
  const inUse = holders.length + invites.length > 0;
  if (inUse && !next) throw new AppError(409, 'ROLE_IN_USE', { members: holders.length, invites: invites.length });
  if (inUse && next) {
    const nextOwnerOnly = ownerOnlyBlocked(actor, product, next.permissions);
    if (nextOwnerOnly.length) throw roleForbidden('owner_only', nextOwnerOnly);
    // Karar (güvenlik incelemesi): sahibe özel izinli role taşınacak davetlerden biri sahip olmayan birinin açtığı davetse silme
    // reddedilir (davetler iptal edilmez).
    await assertInvitesKeepInviter(tx, ctx.orgId, product, invites, next.permissions);
  }

  if (inUse && next) {
    const nextId = customRoleIdOf(next.key);
    for (const h of holders) {
      await tx.productAccess.update({ where: { membershipId_product: { membershipId: h.id, product } }, data: { role: next.key, customRoleId: nextId } });
    }
    for (const i of invites) {
      // Davet satırı da kilitlenir (yazım): eşzamanlı kabul önce biterse sahip listesine girmiş olur, sonra biterse yeni rolü görür.
      const roles = { ...((i.productRoles ?? {}) as Record<string, unknown>), [product]: next.key };
      await tx.invitation.update({ where: { id: i.id }, data: { productRoles: roles as Prisma.InputJsonValue } });
    }
  }
  if (current.kind === 'custom') {
    await tx.productRole.delete({ where: { id: customRoleIdOf(key) as string } });
  } else if (current.row) {
    await tx.productRole.update({ where: { id: current.row.id }, data: { hidden: true, version: { increment: 1 } } });
  } else {
    await tx.productRole.create({
      data: { orgId: ctx.orgId, product, builtinKey: key, hidden: true, inheritPermissions: true, version: 1, createdById: actor.id },
    });
  }
  for (const h of holders) await bumpEpoch(tx, h.id);

  const locale = await orgLocale(tx, ctx.orgId);
  const meta: AuditRoleChange = {
    product,
    role: key,
    kind: current.kind,
    name: auditName(current, locale),
    reassignTo: inUse && next ? next.key : null,
    reassignToLabel: inUse && next ? auditName(next, locale) : null,
    members: holders.length,
    invites: invites.length,
  };
  // Kim taşındı (güvenlik incelemesi): üyelik ve davet kimlikleri, eski ve yeni rol adıyla. Rol sonradan silinse de iz okunur.
  if (inUse && next) {
    const fromLabel = auditName(current, locale);
    const toLabel = auditName(next, locale);
    meta.moved = [
      ...holders.map((h) => ({ kind: 'member' as const, id: h.id, from: key, to: next.key, fromLabel, toLabel })),
      ...invites.map((i) => ({ kind: 'invitation' as const, id: i.id, from: key, to: next.key, fromLabel, toLabel })),
    ];
  }
  await writeAudit(tx, { orgId: ctx.orgId, actor: ctx.audit, action: 'role.deleted', target: key, meta: meta as Prisma.InputJsonValue });
  return { ok: true, reassigned: { members: holders.length, invites: invites.length } };
}

/**
 * `POST /org/roles/builtin/:product/:key/reset`: katalog ad ve izinlerine döner, gizliyse geri getirir. Gölge satır temizlenir
 * (silinmez) ve sürümü artar: `edited: false`, `version` öncekinden büyük (hiç düzenlenmemiş rolde 0 kalır).
 */
export async function resetBuiltinRole(tx: Tx, ctx: RoleRequestCtx, productParam: string, key: string): Promise<OrgProductRole> {
  const product = await assertRoleProduct(tx, ctx.orgId, productParam, true);
  const def = productRole(product, key);
  if (!def) throw notFound();
  await lockRoleProducts(tx, ctx.orgId, [product], 'exclusive');
  await lockRoleRow(tx, ctx.orgId, { product, key });
  const book = await loadRoleBook(tx, ctx.orgId);
  const current = resolveBuiltin(book, product, key) as ResolvedRole;
  if (!current.row || (!current.edited && !current.hidden)) return viewOf(tx, ctx, product, key);

  const catalog = [...def.permissions] as Permission[];
  const wasHidden = current.hidden;
  const before = wasHidden ? [] : current.permissions;
  const added = diff(catalog, before);
  const removed = diff(before, catalog);

  const { actor, usage } = await lockActorAndHolders(tx, ctx, product, key);
  if (!managesHolders(actor, usage.holders.get(key) ?? [], usage.invites.get(key) ?? [])) throw roleForbidden('unmanageable_holder');
  const ownerOnly = ownerOnlyBlocked(actor, product, [...current.permissions, ...catalog]);
  if (ownerOnly.length) throw roleForbidden('owner_only', ownerOnly);
  if (actor.orgRole !== 'OWNER' && added.length) {
    const escalated = diff(added, await actorPermissions(tx, book, actor.id, product));
    if (escalated.length) throw roleForbidden('escalation', escalated);
  }
  await assertInvitesKeepInviter(tx, ctx.orgId, product, usage.invites.get(key) ?? [], added);
  // Katalog adı geri gelince başka bir rolün adıyla çakışmasın (gizliyken aynı adla özel rol açılmış olabilir).
  assertNameFree(book, product, [def.label.tr, def.label.en], key);

  // Satır silinmez, temizlenir: sürüm tekdüze artsın (silinip yeniden açılsaydı sürüm 1'den başlar, eski sürümle düzenleyen
  // başka birinin sonraki değişikliğini ezerdi). Temiz satır katalog halidir (`edited: false`).
  await tx.productRole.update({
    where: { id: current.row.id },
    data: { name: null, description: null, permissions: [], inheritPermissions: true, hidden: false, version: { increment: 1 } },
  });
  if (!wasHidden && !sameSet(catalog, current.permissions)) for (const h of usage.holders.get(key) ?? []) await bumpEpoch(tx, h.id);

  const locale = await orgLocale(tx, ctx.orgId);
  const meta: AuditRoleChange = {
    product,
    role: key,
    kind: 'builtin',
    name: def.label[locale],
    ...(current.row.name !== null ? { previousName: current.row.name } : {}),
    ...(added.length && !wasHidden ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(wasHidden ? { unhidden: true } : {}),
  };
  await writeAudit(tx, { orgId: ctx.orgId, actor: ctx.audit, action: 'role.reset', target: key, meta: meta as Prisma.InputJsonValue });
  return viewOf(tx, ctx, product, key);
}

// ---------- Hedef bulma ----------

/** Uç adresindeki rolü bulur: özel rol bu firmada, hazır rol bu firmada açık araçta. Bulunamazsa 404 (varlığı belli olmaz). */
async function locateRole(tx: Tx, ctx: RoleRequestCtx, target: { customId: string } | { product: string; key: string }) {
  if ('customId' in target) {
    const row = await tx.productRole.findFirst({ where: { id: target.customId, orgId: ctx.orgId, builtinKey: null }, select: { product: true } });
    if (!row || !isProductKey(row.product)) throw notFound();
    const product = await assertRoleProduct(tx, ctx.orgId, row.product, true);
    return { product, key: customRoleKey(target.customId) };
  }
  const product = await assertRoleProduct(tx, ctx.orgId, target.product, true);
  if (!productRole(product, target.key)) throw notFound();
  return { product, key: target.key };
}

/** Kilit altında rolün bugünkü hali; gizli hazır rol ya da silinmiş özel rol 404. */
function currentRole(book: RoleBook, product: ProductKey, key: string): ResolvedRole {
  const r = customRoleIdOf(key) ? resolveCustom(book, product, key) : resolveBuiltin(book, product, key);
  if (!r || r.hidden) throw notFound();
  return r;
}
