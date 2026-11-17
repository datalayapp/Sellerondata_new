// Yalnız VITE_MOCK=1. Özel rollerin sahte Hesap servisi kuralları; `browser.ts` uçları bunu çağırır. Saf: tarayıcı API'si yok
// (birim testi `src/lib/mock-roles.test.mjs`). Sözleşme `contracts/src/roles.ts`.
// Gerçek uçlar (account-api `routes/org.ts`) yazılınca yanıt şekli kayıtla karşılaştırılmalı (bkz. rapor: kayıt henüz yok).
import {
  CUSTOM_ROLE_LIMIT,
  PRODUCTS,
  PRODUCT_KEYS,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  customRoleIdOf,
  customRoleKey,
  isProductKey,
  isRoleDeletable,
  isRolePermissionsLocked,
  orderPermissions,
  ownerOnlyPermissionsIn,
  requiredPermissionsOf,
  validateRolePermissions,
  type ApiErrorCode,
  type AuditRoleChange,
  type CreateRoleBody,
  type Locale,
  type OrgProductRole,
  type OrgRolesResponse,
  type PatchRoleBody,
  type ProductKey,
  type RoleForbiddenReason,
} from '@sellerondata/contracts';
import type { MockDb, MockMembership } from './db.ts';

/**
 * Hesap servisinin `ProductRole` satırı. Özel rolde `builtinKey` yok; hazır rolün firmadaki hali (`builtinKey`) katalogdaki rolü
 * gölgeler (`name`, `description`, `permissions`); `hidden` ise rol firmada silinmiştir.
 * `description`: `undefined` katalog açıklaması (yalnız hazır rol), `null` açıklama yok.
 */
export type MockRoleRow = {
  id: string;
  orgId: string;
  product: ProductKey;
  name?: string;
  description?: string | null;
  permissions?: string[];
  basedOn?: string;
  builtinKey?: string;
  hidden?: boolean;
  version: number;
  createdAt: string;
};

export type MockResult = { status: number; body?: unknown; error?: { code: ApiErrorCode; details?: unknown } };
const err = (status: number, code: ApiErrorCode, details?: unknown): MockResult => ({ status, error: { code, details } });

const rowsOf = (db: MockDb): MockRoleRow[] => (db.roles ??= []);

/** Rolü olan ve kapalı olmayan araçlar, kayıt sırasıyla (`GET /org/roles` ürünleri). */
export const roleProducts = (): ProductKey[] => PRODUCT_KEYS.filter((k) => PRODUCTS[k].launch !== 'off' && PRODUCTS[k].roles.length > 0);

const shadowOf = (db: MockDb, orgId: string, product: ProductKey, key: string) => rowsOf(db).find((r) => r.orgId === orgId && r.product === product && r.builtinKey === key);
const customOf = (db: MockDb, orgId: string, product: ProductKey | null, key: string) => {
  const id = customRoleIdOf(key);
  return id ? rowsOf(db).find((r) => r.id === id && r.orgId === orgId && !r.builtinKey && (product === null || r.product === product)) : undefined;
};

export type ResolvedRole = { key: string; product: ProductKey; kind: 'builtin' | 'custom'; name: string; description?: string; permissions: string[]; edited: boolean; version: number; basedOn?: string; createdAt?: string };

/** Hesap servisinin `resolveRole`'u: firmada görünen rol; gizli hazır rol, başka firmanın özel rolü ya da bilinmeyen anahtar null. */
export function resolveRole(db: MockDb, orgId: string, product: ProductKey, key: string | null | undefined, locale: Locale): ResolvedRole | null {
  if (!key) return null;
  const custom = customOf(db, orgId, product, key);
  if (custom) {
    return { key, product, kind: 'custom', name: custom.name ?? '', ...(custom.description ? { description: custom.description } : {}), permissions: orderPermissions(product, custom.permissions ?? []), edited: false, version: custom.version, ...(custom.basedOn ? { basedOn: custom.basedOn } : {}), createdAt: custom.createdAt };
  }
  const def = PRODUCTS[product].roles.find((r) => r.key === key);
  if (!def) return null;
  const shadow = shadowOf(db, orgId, product, key);
  if (shadow?.hidden) return null;
  const description = shadow && shadow.description !== undefined ? (shadow.description ?? undefined) : def.description[locale];
  return {
    key,
    product,
    kind: 'builtin',
    name: shadow?.name ?? def.label[locale],
    ...(description ? { description } : {}),
    permissions: shadow?.permissions ? orderPermissions(product, shadow.permissions) : [...def.permissions],
    edited: !!shadow,
    version: shadow?.version ?? 0,
  };
}

/** Görünen roller: önce hazır (katalog sırası), sonra özel (oluşturulma sırası). */
export function visibleRoles(db: MockDb, orgId: string, product: ProductKey, locale: Locale): ResolvedRole[] {
  const builtin = PRODUCTS[product].roles.map((r) => resolveRole(db, orgId, product, r.key, locale)).filter((r): r is ResolvedRole => r !== null);
  const custom = rowsOf(db)
    .filter((r) => r.orgId === orgId && r.product === product && !r.builtinKey)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => resolveRole(db, orgId, product, customRoleKey(r.id), locale)!)
    .filter(Boolean);
  return [...builtin, ...custom];
}

const holdersOf = (db: MockDb, orgId: string, product: ProductKey, key: string) => db.memberships.filter((m) => m.orgId === orgId && m.productRoles[product] === key);
const invitesOf = (db: MockDb, orgId: string, product: ProductKey, key: string) => db.invitations.filter((i) => i.orgId === orgId && i.productRoles?.[product] === key);

/** İsteği yapanın bu araçtaki izinleri (yetki yükseltme denetimi). */
function viewerPermissions(db: MockDb, viewer: MockMembership, product: ProductKey): string[] {
  return resolveRole(db, viewer.orgId, product, viewer.productRoles[product], 'tr')?.permissions ?? [];
}

/** Firma yöneticisi bu rolü yönetebilir mi (plan: sahibe özel izin yalnız sahipte; rolün bütün sahipleri yöneticinin yönetebildiği kişiler). */
function manageBlock(db: MockDb, viewer: MockMembership, role: ResolvedRole): RoleForbiddenReason | null {
  if (viewer.orgRole === 'OWNER') return null;
  if (ownerOnlyPermissionsIn(role.product, role.permissions).length) return 'owner_only';
  if (holdersOf(db, viewer.orgId, role.product, role.key).some((h) => h.id === viewer.id || h.orgRole === 'OWNER' || h.orgRole === 'ADMIN')) return 'unmanageable_holder';
  return null;
}

function roleView(db: MockDb, viewer: MockMembership, role: ResolvedRole): OrgProductRole {
  const editable = manageBlock(db, viewer, role) === null;
  const locked = role.kind === 'builtin' && isRolePermissionsLocked(role.product, role.key);
  return {
    key: role.key,
    kind: role.kind,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    permissions: role.permissions,
    memberCount: holdersOf(db, viewer.orgId, role.product, role.key).length,
    inviteCount: invitesOf(db, viewer.orgId, role.product, role.key).length,
    editable,
    permissionsLocked: locked,
    deletable: editable && (role.kind === 'custom' || isRoleDeletable(role.product, role.key)),
    edited: role.edited,
    ...(role.basedOn ? { basedOn: role.basedOn } : {}),
    version: role.version,
  };
}

export function rolesResponse(db: MockDb, viewer: MockMembership, locale: Locale): OrgRolesResponse {
  return {
    products: roleProducts().map((k) => {
      const def = PRODUCTS[k];
      const ownerOnly = new Set<string>(def.ownerOnlyPermissions ?? []);
      return {
        key: k,
        groups: (def.permissionGroups ?? []).map((g) => ({ key: g.key, label: g.label })),
        permissions: Object.entries(def.permissions).map(([key, label]) => ({
          key,
          label: label!,
          group: def.permissionGroups?.find((g) => (g.permissions as readonly string[]).includes(key))?.key ?? '',
          requires: requiredPermissionsOf(k, key),
          ownerOnly: ownerOnly.has(key),
        })),
        roles: visibleRoles(db, viewer.orgId, k, locale).map((r) => roleView(db, viewer, r)),
        hiddenBuiltins: def.roles.filter((r) => shadowOf(db, viewer.orgId, k, r.key)?.hidden).map((r) => ({ key: r.key, name: r.label[locale] })),
        customRoleLimit: CUSTOM_ROLE_LIMIT,
      };
    }),
  };
}

function audit(db: MockDb, viewer: MockMembership, actor: string, action: string, details: AuditRoleChange) {
  db.audit.unshift({ id: `a${Date.now()}${Math.floor(Math.random() * 1000)}`, orgId: viewer.orgId, at: new Date().toISOString(), actor, action, target: details.role, meta: details, details });
}

/** Ad ve açıklama denetimi (Hesap gibi: VALIDATION alan hatası, ad tekil `ROLE_NAME_TAKEN`). */
function checkText(db: MockDb, orgId: string, product: ProductKey, name: string | undefined, description: string | null | undefined, selfKey: string | null, locale: Locale): MockResult | null {
  if (name !== undefined) {
    const n = name.trim();
    if (n.length < 1 || n.length > ROLE_NAME_MAX_LENGTH) return err(400, 'VALIDATION', [{ path: 'name', code: 'too_long', message: locale === 'tr' ? `Rol adı 1-${ROLE_NAME_MAX_LENGTH} karakter olmalı.` : `Role name must be 1-${ROLE_NAME_MAX_LENGTH} characters.` }]);
    const folded = n.toLocaleLowerCase('tr');
    if (visibleRoles(db, orgId, product, locale).some((r) => r.key !== selfKey && r.name.trim().toLocaleLowerCase('tr') === folded)) return err(409, 'ROLE_NAME_TAKEN');
  }
  if (typeof description === 'string' && description.trim().length > ROLE_DESCRIPTION_MAX_LENGTH) {
    return err(400, 'VALIDATION', [{ path: 'description', code: 'too_long', message: locale === 'tr' ? `Açıklama en çok ${ROLE_DESCRIPTION_MAX_LENGTH} karakter olabilir.` : `Description can be at most ${ROLE_DESCRIPTION_MAX_LENGTH} characters.` }]);
  }
  return null;
}

/** İzin seti: bağımlılık (kendiliğinden eklenmez), sahibe özel izin, eklenen izinde yetki yükseltme. */
function checkPermissions(db: MockDb, viewer: MockMembership, product: ProductKey, perms: string[], before: readonly string[]): MockResult | null {
  const v = validateRolePermissions(product, perms);
  if (!v.ok) return err(400, 'INVALID_ROLE_PERMISSIONS', { missing: v.missing, unknown: v.unknown });
  if (viewer.orgRole === 'OWNER') return null;
  const ownerOnly = ownerOnlyPermissionsIn(product, perms);
  if (ownerOnly.length) return err(403, 'ROLE_FORBIDDEN', { reason: 'owner_only', permissions: ownerOnly });
  const mine = new Set(viewerPermissions(db, viewer, product));
  const added = perms.filter((p) => !before.includes(p) && !mine.has(p));
  if (added.length) return err(403, 'ROLE_FORBIDDEN', { reason: 'escalation', permissions: orderPermissions(product, added) });
  return null;
}

/** `POST /org/roles`. */
export function createRole(db: MockDb, viewer: MockMembership, actor: string, body: CreateRoleBody, locale: Locale): MockResult {
  if (!isProductKey(body?.product) || !roleProducts().includes(body.product)) return err(400, 'VALIDATION', [{ path: 'product', code: 'invalid', message: 'product' }]);
  const product = body.product;
  if (typeof body.name !== 'string' || !Array.isArray(body.permissions)) return err(400, 'VALIDATION');
  const text = checkText(db, viewer.orgId, product, body.name, body.description, null, locale);
  if (text) return text;
  const perms = [...new Set(body.permissions)];
  const p = checkPermissions(db, viewer, product, perms, []);
  if (p) return p;
  if (rowsOf(db).filter((r) => r.orgId === viewer.orgId && r.product === product && !r.builtinKey).length >= CUSTOM_ROLE_LIMIT) return err(409, 'ROLE_LIMIT');
  const row: MockRoleRow = {
    id: crypto.randomUUID(),
    orgId: viewer.orgId,
    product,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    permissions: orderPermissions(product, perms),
    ...(body.basedOn && PRODUCTS[product].roles.some((r) => r.key === body.basedOn) ? { basedOn: body.basedOn } : {}),
    version: 1,
    createdAt: new Date().toISOString(),
  };
  rowsOf(db).push(row);
  const role = resolveRole(db, viewer.orgId, product, customRoleKey(row.id), locale)!;
  audit(db, viewer, actor, 'role.created', { product, role: role.key, kind: 'custom', name: role.name, permissions: role.permissions, ...(row.basedOn ? { basedOn: row.basedOn } : {}) });
  return { status: 201, body: { role: roleView(db, viewer, role) } };
}

export type RoleTarget = { custom: string } | { product: string; key: string };

function findTarget(db: MockDb, orgId: string, target: RoleTarget, locale: Locale): ResolvedRole | null {
  if ('custom' in target) {
    const row = rowsOf(db).find((r) => r.id === target.custom && r.orgId === orgId && !r.builtinKey);
    return row ? resolveRole(db, orgId, row.product, customRoleKey(row.id), locale) : null;
  }
  if (!isProductKey(target.product) || !roleProducts().includes(target.product)) return null;
  return resolveRole(db, orgId, target.product, target.key, locale);
}

/** `PATCH /org/roles/:id` ve `PATCH /org/roles/builtin/:product/:key`. */
export function patchRole(db: MockDb, viewer: MockMembership, actor: string, target: RoleTarget, body: PatchRoleBody, locale: Locale): MockResult {
  const role = findTarget(db, viewer.orgId, target, locale);
  if (!role) return err(404, 'NOT_FOUND');
  if (typeof body?.version !== 'number') return err(400, 'VALIDATION', [{ path: 'version', code: 'required', message: 'version' }]);
  if (body.version !== role.version) return err(409, 'ROLE_VERSION');
  const block = manageBlock(db, viewer, role);
  if (block) return err(403, 'ROLE_FORBIDDEN', { reason: block });
  const locked = role.kind === 'builtin' && isRolePermissionsLocked(role.product, role.key);
  const perms = body.permissions ? [...new Set(body.permissions)] : undefined;
  if (perms && locked && !sameSet(orderPermissions(role.product, perms), role.permissions)) return err(403, 'ROLE_LOCKED');
  const text = checkText(db, viewer.orgId, role.product, body.name, body.description, role.key, locale);
  if (text) return text;
  if (perms && !locked) {
    const p = checkPermissions(db, viewer, role.product, perms, role.permissions);
    if (p) return p;
  }
  let row = role.kind === 'custom' ? customOf(db, viewer.orgId, role.product, role.key)! : shadowOf(db, viewer.orgId, role.product, role.key);
  if (!row) {
    row = { id: crypto.randomUUID(), orgId: viewer.orgId, product: role.product, builtinKey: role.key, version: 0, createdAt: new Date().toISOString() };
    rowsOf(db).push(row);
  }
  const previousName = role.name;
  if (body.name !== undefined) row.name = body.name.trim();
  if (body.description !== undefined) row.description = body.description === null ? null : body.description.trim() || null;
  if (perms && !locked) row.permissions = orderPermissions(role.product, perms);
  row.version += 1;
  const next = resolveRole(db, viewer.orgId, role.product, role.key, locale)!;
  const added = next.permissions.filter((p) => !role.permissions.includes(p));
  const removed = role.permissions.filter((p) => !next.permissions.includes(p));
  audit(db, viewer, actor, 'role.updated', {
    product: role.product,
    role: role.key,
    kind: role.kind,
    name: next.name,
    ...(next.name !== previousName ? { previousName } : {}),
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(body.description !== undefined && (next.description ?? null) !== (role.description ?? null) ? { descriptionChanged: true } : {}),
  });
  return { status: 200, body: { role: roleView(db, viewer, next) } };
}

/** `DELETE /org/roles/:id?reassignTo=` ve `DELETE /org/roles/builtin/:product/:key?reassignTo=`. */
export function deleteRole(db: MockDb, viewer: MockMembership, actor: string, target: RoleTarget, reassignTo: string | null, locale: Locale): MockResult {
  const role = findTarget(db, viewer.orgId, target, locale);
  if (!role) return err(404, 'NOT_FOUND');
  if (role.kind === 'builtin' && !isRoleDeletable(role.product, role.key)) return err(403, 'ROLE_LOCKED');
  const block = manageBlock(db, viewer, role);
  if (block) return err(403, 'ROLE_FORBIDDEN', { reason: block });
  const holders = holdersOf(db, viewer.orgId, role.product, role.key);
  const invites = invitesOf(db, viewer.orgId, role.product, role.key);
  let to: ResolvedRole | null = null;
  if (holders.length || invites.length) {
    if (!reassignTo) return err(409, 'ROLE_IN_USE', { members: holders.length, invites: invites.length });
    to = reassignTo === role.key ? null : resolveRole(db, viewer.orgId, role.product, reassignTo, locale);
    if (!to) return err(400, 'INVALID_PRODUCT_ROLE');
    if (viewer.orgRole !== 'OWNER' && ownerOnlyPermissionsIn(role.product, to.permissions).length) return err(403, 'ROLE_FORBIDDEN', { reason: 'owner_only', permissions: ownerOnlyPermissionsIn(role.product, to.permissions) });
    for (const m of holders) m.productRoles = { ...m.productRoles, [role.product]: to.key };
    for (const i of invites) i.productRoles = { ...i.productRoles, [role.product]: to.key };
  }
  if (role.kind === 'custom') {
    const id = customRoleIdOf(role.key);
    db.roles = rowsOf(db).filter((r) => r.id !== id);
  } else {
    const shadow = shadowOf(db, viewer.orgId, role.product, role.key);
    if (shadow) {
      shadow.hidden = true;
      shadow.version += 1;
    } else rowsOf(db).push({ id: crypto.randomUUID(), orgId: viewer.orgId, product: role.product, builtinKey: role.key, hidden: true, version: 1, createdAt: new Date().toISOString() });
  }
  audit(db, viewer, actor, 'role.deleted', {
    product: role.product,
    role: role.key,
    kind: role.kind,
    name: role.name,
    ...(to ? { reassignTo: to.key, reassignToLabel: to.name, members: holders.length, invites: invites.length } : {}),
  });
  return { status: 200, body: { ok: true, reassigned: { members: to ? holders.length : 0, invites: to ? invites.length : 0 } } };
}

/** `POST /org/roles/builtin/:product/:key/reset`: katalog ad ve izinlerine döner, gizliyse geri getirir. */
export function resetRole(db: MockDb, viewer: MockMembership, actor: string, product: string, key: string, locale: Locale): MockResult {
  if (!isProductKey(product) || !roleProducts().includes(product)) return err(404, 'NOT_FOUND');
  const def = PRODUCTS[product].roles.find((r) => r.key === key);
  if (!def) return err(404, 'NOT_FOUND');
  const shadow = shadowOf(db, viewer.orgId, product, key);
  const current = resolveRole(db, viewer.orgId, product, key, locale);
  const catalogPerms = [...def.permissions] as string[];
  if (current) {
    const block = manageBlock(db, viewer, current);
    if (block) return err(403, 'ROLE_FORBIDDEN', { reason: block });
  }
  // Sahibe özel izinli ya da yöneticide olmayan izni geri getirmek de yetki yükseltmesidir.
  const p = checkPermissions(db, viewer, product, catalogPerms, current?.permissions ?? []);
  if (p && p.error?.code !== 'INVALID_ROLE_PERMISSIONS') return p;
  if (shadow) db.roles = rowsOf(db).filter((r) => r !== shadow);
  const next = resolveRole(db, viewer.orgId, product, key, locale)!;
  const before = current?.permissions ?? [];
  const added = next.permissions.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !next.permissions.includes(x));
  audit(db, viewer, actor, 'role.reset', {
    product,
    role: key,
    kind: 'builtin',
    name: next.name,
    ...(current && current.name !== next.name ? { previousName: current.name } : {}),
    ...(current && added.length ? { added } : {}),
    ...(current && removed.length ? { removed } : {}),
    ...(shadow?.hidden ? { unhidden: true } : {}),
  });
  return { status: 200, body: { role: roleView(db, viewer, next) } };
}

/**
 * Üyeye ya da davete rol verirken (`PATCH /org/members/:id`, `POST /org/members/invite`): rol firmada görünmeli
 * (`INVALID_PRODUCT_ROLE`), sahibe özel izinli rolü yalnız firma sahibi verir (`ROLE_FORBIDDEN owner_only`).
 */
export function checkAssignment(db: MockDb, viewer: MockMembership, productRoles: Record<string, string | null | undefined> | null | undefined, locale: Locale): MockResult | null {
  for (const [product, key] of Object.entries(productRoles ?? {})) {
    if (!key) continue;
    if (!isProductKey(product)) return err(400, 'INVALID_PRODUCT_ROLE');
    const role = resolveRole(db, viewer.orgId, product, key, locale);
    if (!role) return err(400, 'INVALID_PRODUCT_ROLE');
    const ownerOnly = ownerOnlyPermissionsIn(product, role.permissions);
    if (viewer.orgRole !== 'OWNER' && ownerOnly.length) return err(403, 'ROLE_FORBIDDEN', { reason: 'owner_only', permissions: ownerOnly });
  }
  return null;
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
