/*
 * Özel roller: Merkez'in saf yardımcıları (React ve tarayıcı yok; birim testi `roles.test.mjs`).
 * Kaynak `GET /api/account/org/roles` (`OrgRolesResponse`); yanıt gelmeden ya da gelmezse katalog (`catalogRolesProduct`).
 * Kurallar: bağımlılık kendiliğinden işaretlenir, sahibe özel izni yalnız firma sahibi verir,
 * firma yöneticisi kendinde olmayan izni role ekleyemez, sahip rolünün izinleri kilitli. Gerçek kapı sunucudadır; arayüz yalnız yansıtır.
 */
import {
  PRODUCTS,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  isRoleDeletable,
  pickInviteRole,
  requiredPermissionsOf,
  CUSTOM_ROLE_LIMIT,
  type Locale,
  type OrgProductRole,
  type OrgRolesResponse,
  type ProductKey,
  type RoleForbiddenReason,
} from '@sellerondata/contracts';

export type RolesProduct = OrgRolesResponse['products'][number];

/** Yanıt yokken (yükleniyor, hata) katalogdaki hazır roller: seçiciler ve etiketler boş kalmasın. Sayılar 0, düzenleme kapalı. */
export function catalogRolesProduct(k: ProductKey, locale: Locale): RolesProduct {
  const def = PRODUCTS[k];
  const ownerOnly = new Set<string>(def.ownerOnlyPermissions ?? []);
  const groupOf = (perm: string) => def.permissionGroups?.find((g) => (g.permissions as readonly string[]).includes(perm))?.key ?? '';
  return {
    key: k,
    groups: (def.permissionGroups ?? []).map((g) => ({ key: g.key, label: g.label })),
    permissions: Object.entries(def.permissions).map(([key, label]) => ({ key, label: label!, group: groupOf(key), requires: requiredPermissionsOf(k, key), ownerOnly: ownerOnly.has(key) })),
    roles: def.roles.map((r) => ({
      key: r.key,
      kind: 'builtin',
      name: r.label[locale],
      description: r.description[locale],
      permissions: [...r.permissions],
      memberCount: 0,
      inviteCount: 0,
      editable: false,
      permissionsLocked: r.key === def.ownerRole || (def.lockedRoles ?? []).includes(r.key),
      deletable: false,
      edited: false,
      version: 0,
    })),
    hiddenBuiltins: [],
    customRoleLimit: CUSTOM_ROLE_LIMIT,
  };
}

/** Yanıttaki ürün; yoksa katalog. */
export function rolesProductOf(data: OrgRolesResponse | undefined, k: ProductKey, locale: Locale): RolesProduct {
  return data?.products.find((p) => p.key === k) ?? catalogRolesProduct(k, locale);
}

export function findRole(p: RolesProduct, key: string | null | undefined): OrgProductRole | undefined {
  return key ? p.roles.find((r) => r.key === key) : undefined;
}

/** Rolün görünen adı: firmadaki ad, yoksa katalog adı (gizlenmiş ya da eski rol), yoksa undefined. */
export function roleName(p: RolesProduct, key: string | null | undefined, locale: Locale): string | undefined {
  if (!key) return undefined;
  return findRole(p, key)?.name ?? PRODUCTS[p.key].roles.find((r) => r.key === key)?.label[locale];
}

/** Yeni rol öncekinin tüm izinlerini kapsıyorsa yükseltmedir ("kaldırılır" denmez). */
export function isUpgrade(p: RolesProduct, from: string | null | undefined, to: string): boolean {
  const next = findRole(p, to)?.permissions ?? [];
  const prev = findRole(p, from)?.permissions ?? [];
  return next.length > prev.length && prev.every((x) => next.includes(x));
}

export type RoleKindView = 'builtin' | 'edited' | 'custom';
export const roleKindOf = (r: OrgProductRole): RoleKindView => (r.kind === 'custom' ? 'custom' : r.edited ? 'edited' : 'builtin');

/** Setteki sahibe özel izinler (yanıtın `ownerOnly` alanından). */
export function ownerOnlyIn(p: RolesProduct, perms: Iterable<string>): string[] {
  const set = new Set(perms);
  return p.permissions.filter((x) => x.ownerOnly && set.has(x.key)).map((x) => x.key);
}

// ---------- Rol düzenleyici ----------

/** İsteği yapan: firma sahibi mi, bu araçta kendi izinleri neler (`me.products[].permissions`). */
export type RoleViewer = { isOwner: boolean; permissions: readonly string[] };

/** Bir izin neden seçilemiyor. `dependency`: gerektirdiği `via` izni seçilemiyor. */
export type PermBlock = { reason: 'locked' | 'owner_only' | 'escalation' | 'dependency'; via?: string };

export type PermRow = {
  key: string;
  /** İşaretli (seçilmiş ya da başka bir seçili iznin gereği). */
  checked: boolean;
  /** Başka bir işaretli izin bunu gerektiriyor: soluk işaret, kaldırılamaz. */
  neededBy: string[];
  /** Tıklanamaz ve nedeni. */
  disabled: boolean;
  block?: PermBlock;
};

/** Seçilenler + geçişli gereksinimleri, katalog sırasıyla. Bilinmeyen izin düşer. */
export function effectivePermissions(p: RolesProduct, chosen: Iterable<string>): string[] {
  const set = new Set<string>();
  const byKey = new Map(p.permissions.map((x) => [x.key, x]));
  for (const c of chosen) {
    const perm = byKey.get(c);
    if (!perm) continue;
    set.add(c);
    for (const r of perm.requires) if (byKey.has(r)) set.add(r);
  }
  return p.permissions.filter((x) => set.has(x.key)).map((x) => x.key);
}

/**
 * İznin eklenmesini engelleyen kural. `original`: rolün düzenlemeden önceki izinleri (yeni rolde boş): firma yöneticisi rolde
 * zaten olan izni koruyabilir, yalnız kendinde olmayanı ekleyemez (yetki yükseltme yalnız eklenen izinde denetlenir).
 */
export function permissionBlock(p: RolesProduct, viewer: RoleViewer, original: ReadonlySet<string>, perm: string, locked: boolean, seen = new Set<string>()): PermBlock | undefined {
  if (locked) return { reason: 'locked' };
  if (viewer.isOwner || original.has(perm)) return undefined;
  const def = p.permissions.find((x) => x.key === perm);
  if (!def) return undefined;
  if (def.ownerOnly) return { reason: 'owner_only' };
  if (!viewer.permissions.includes(perm)) return { reason: 'escalation' };
  seen.add(perm);
  for (const r of def.requires) {
    if (seen.has(r)) continue;
    if (permissionBlock(p, viewer, original, r, false, seen)) return { reason: 'dependency', via: r };
  }
  return undefined;
}

/** Düzenleyicinin satırları: işaret, soluk gereklilik, kapalılık ve nedeni. */
export function permissionRows(p: RolesProduct, viewer: RoleViewer, chosen: readonly string[], original: ReadonlySet<string>, locked: boolean): PermRow[] {
  const effective = new Set(effectivePermissions(p, chosen));
  return p.permissions.map((perm) => {
    const checked = effective.has(perm.key);
    const neededBy = p.permissions.filter((o) => o.key !== perm.key && effective.has(o.key) && o.requires.includes(perm.key)).map((o) => o.key);
    const block = checked ? (locked ? { reason: 'locked' as const } : undefined) : permissionBlock(p, viewer, original, perm.key, locked);
    return { key: perm.key, checked, neededBy, disabled: locked || neededBy.length > 0 || !!block, ...(block ? { block } : {}) };
  });
}

/** Tıklama: işaretli ve kimsenin gereği değilse kaldırır; işaretsiz ve engelsizse ekler (gereksinimler kendiliğinden işaretlenir). */
export function togglePermission(p: RolesProduct, viewer: RoleViewer, chosen: readonly string[], original: ReadonlySet<string>, locked: boolean, perm: string): string[] {
  const row = permissionRows(p, viewer, chosen, original, locked).find((r) => r.key === perm);
  if (!row || row.disabled) return [...chosen];
  if (row.checked) {
    // Kendisi seçili değilse (yalnız gereklilikti) kaldırılacak bir şey yok; kapalı satır zaten buraya gelmez.
    return chosen.filter((c) => c !== perm);
  }
  return [...chosen, perm];
}

/**
 * Şablondan başlarken seçilecek izinler. Firma yöneticisi için sahibe özel ya da kendinde olmayan izinler düşer (`dropped`);
 * arayüz bunu bir kez söyler. Düşen iznin gereği olan izin de düşer (bağımlılık eksik kalmasın).
 */
export function templatePermissions(p: RolesProduct, viewer: RoleViewer, perms: readonly string[]): { chosen: string[]; dropped: string[] } {
  const none = new Set<string>();
  const known = effectivePermissions(p, perms);
  const chosen = known.filter((x) => !permissionBlock(p, viewer, none, x, false));
  const kept = new Set(chosen);
  return { chosen, dropped: known.filter((x) => !kept.has(x)) };
}

/** Kayıt için izin seti: kapanmış, katalog sırasıyla. */
export const permissionsToSave = (p: RolesProduct, chosen: readonly string[]) => effectivePermissions(p, chosen);

export const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export type NameIssue = 'required' | 'tooLong' | 'taken';

/** Ad denetimi (sunucu da denetler: `ROLE_NAME_TAKEN`). Büyük/küçük harf ve baştaki/sondaki boşluk fark etmez. */
export function roleNameIssue(p: RolesProduct, name: string, selfKey?: string): NameIssue | null {
  const n = name.trim();
  if (!n) return 'required';
  if (n.length > ROLE_NAME_MAX_LENGTH) return 'tooLong';
  const folded = n.toLocaleLowerCase('tr');
  if (p.roles.some((r) => r.key !== selfKey && r.name.trim().toLocaleLowerCase('tr') === folded)) return 'taken';
  return null;
}

export const descriptionTooLong = (d: string) => d.trim().length > ROLE_DESCRIPTION_MAX_LENGTH;

/** Kopyanın adı: sözlükteki kalıp (`{{name}} kopyası`), sınırı aşarsa addan kırpılır; çakışırsa sona sayı eklenir. */
export function copyName(p: RolesProduct, pattern: (name: string) => string, source: string): string {
  const fit = (base: string, suffix = '') => {
    let s = pattern(base) + suffix;
    let b = base;
    while (s.length > ROLE_NAME_MAX_LENGTH && b.length > 1) {
      b = b.slice(0, -1);
      s = pattern(b.trimEnd()) + suffix;
    }
    return s.slice(0, ROLE_NAME_MAX_LENGTH);
  };
  let out = fit(source);
  for (let i = 2; roleNameIssue(p, out) === 'taken' && i < 100; i++) out = fit(source, ` ${i}`);
  return out;
}

// ---------- Silme ----------

export type ReassignTarget = { key: string; name: string; disabled: boolean; ownerOnly: boolean };

/** Silinen rolün kişileri ve davetleri hangi role geçebilir: görünen başka roller. Sahibe özel izinli rol yalnız firma sahibine açık. */
export function reassignTargets(p: RolesProduct, roleKey: string, viewer: RoleViewer): ReassignTarget[] {
  return p.roles
    .filter((r) => r.key !== roleKey)
    .map((r) => {
      const ownerOnly = ownerOnlyIn(p, r.permissions).length > 0;
      return { key: r.key, name: r.name, ownerOnly, disabled: ownerOnly && !viewer.isOwner };
    });
}

/**
 * Önseçili hedef: davet varsayılanı (katalog `inviteRole`) seçilebilirse o; değilse en az yetkili seçilebilir rol (eşitlikte
 * gösterim sırası). Kalan ilk rol çoğu zaman sahip rolüdür: yanlışlıkla herkese tam yetki verilmesin.
 */
export function defaultReassign(p: RolesProduct, roleKey: string, viewer: RoleViewer): string | null {
  const open = reassignTargets(p, roleKey, viewer).filter((t) => !t.disabled);
  const invite = pickInviteRole(p.key, open.map((t) => t.key));
  if (invite !== null && invite === PRODUCTS[p.key].inviteRole) return invite;
  const size = (key: string) => findRole(p, key)?.permissions.length ?? 0;
  return open.reduce<string | null>((best, t) => (best === null || size(t.key) < size(best) ? t.key : best), null);
}

export const roleInUse = (r: Pick<OrgProductRole, 'memberCount' | 'inviteCount'>) => r.memberCount + r.inviteCount > 0;

/** Menüde "Sil" hiç görünür mü: sahip rolü hiç silinemez (öğe yok). Diğerlerinde yetki `deletable`. */
export const canEverDelete = (p: RolesProduct, r: OrgProductRole) => r.kind === 'custom' || isRoleDeletable(p.key, r.key);

// ---------- Uç adresleri ----------

const enc = encodeURIComponent;
const CUSTOM = /^custom:/;

/** Rolün düzenleme adresi: özel rol `/org/roles/:id`, hazır rol `/org/roles/builtin/:product/:key`. */
export function rolePath(product: ProductKey, key: string): string {
  return CUSTOM.test(key) ? `/api/account/org/roles/${enc(key.slice(7))}` : `/api/account/org/roles/builtin/${enc(product)}/${enc(key)}`;
}
export const deleteRolePath = (product: ProductKey, key: string, reassignTo?: string | null) => `${rolePath(product, key)}${reassignTo ? `?reassignTo=${enc(reassignTo)}` : ''}`;
export const resetRolePath = (product: ProductKey, key: string) => `/api/account/org/roles/builtin/${enc(product)}/${enc(key)}/reset`;

// ---------- Hatalar ----------

export type RoleErrorView =
  | { kind: 'name_taken' }
  | { kind: 'version' }
  | { kind: 'forbidden'; reason: RoleForbiddenReason | null; permissions: string[]; invitations?: string[] }
  | { kind: 'invalid_permissions'; missing: { perm: string; requires: string[] }[]; unknown: string[] }
  | { kind: 'in_use'; members: number; invites: number }
  | { kind: 'limit' }
  | { kind: 'locked' }
  | { kind: 'other' };

const REASONS: readonly RoleForbiddenReason[] = ['escalation', 'owner_only', 'unmanageable_holder', 'pending_admin_invites'];

/** Engel olan davetlerin görünen adı (`pending_admin_invites`): ad (iletişim), yoksa iletişim. Biçimi bozuk olan atlanır. */
function blockingInvitations(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((i) => {
    const name = typeof i?.name === 'string' && i.name.trim() ? i.name.trim() : null;
    const contact = typeof i?.contact === 'string' && i.contact.trim() ? i.contact.trim() : null;
    if (name && contact) return [`${name} (${contact})`];
    return name || contact ? [(name ?? contact) as string] : [];
  });
}

/** Sunucu hatasını ekranın anlayacağı türe çevirir (`ApiError` gibi `{ code, details }` taşıyan her nesne). */
export function roleErrorOf(e: unknown): RoleErrorView {
  const code = (e as { code?: unknown } | null)?.code;
  const d = ((e as { details?: unknown } | null)?.details ?? {}) as Record<string, unknown>;
  const nums = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  switch (code) {
    case 'ROLE_NAME_TAKEN':
      return { kind: 'name_taken' };
    case 'ROLE_VERSION':
      return { kind: 'version' };
    case 'ROLE_FORBIDDEN': {
      const reason = REASONS.includes(d.reason as RoleForbiddenReason) ? (d.reason as RoleForbiddenReason) : null;
      if (reason === 'pending_admin_invites') return { kind: 'forbidden', reason, permissions: strs(d.permissions), invitations: blockingInvitations(d.invitations) };
      return { kind: 'forbidden', reason, permissions: strs(d.permissions) };
    }
    case 'INVALID_ROLE_PERMISSIONS': {
      const missing = Array.isArray(d.missing) ? (d.missing as { perm?: unknown; requires?: unknown }[]).filter((m) => typeof m?.perm === 'string').map((m) => ({ perm: m.perm as string, requires: strs(m.requires) })) : [];
      return { kind: 'invalid_permissions', missing, unknown: strs(d.unknown) };
    }
    case 'ROLE_IN_USE':
      return { kind: 'in_use', members: nums(d.members), invites: nums(d.invites) };
    case 'ROLE_LIMIT':
      return { kind: 'limit' };
    case 'ROLE_LOCKED':
      return { kind: 'locked' };
    default:
      return { kind: 'other' };
  }
}
