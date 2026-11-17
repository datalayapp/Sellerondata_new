/**
 * Abonelik durum makinesi ve destek komutlarının mantığı. Müşteriye açık HTTP ucu yoktur: abonelik yalnız
 * sunucudaki komutla değişir (`scripts/{subscription-set,product-launch,org-close,org-reopen,members-announce,org-list}.ts`).
 * Hiçbir işlev veri silmez.
 *
 * Kilit sırası (tek işlemde): Organization (`FOR NO KEY UPDATE`) → Subscription (`FOR UPDATE`, ürün sırasıyla) → kişi → üyelik
 * (`lockMemberships`) → davet. Firma satırı `FOR UPDATE` değil `FOR NO KEY UPDATE` ile kilitlenir: davet ve üyelik eklemenin yabancı
 * anahtar denetimi (`FOR KEY SHARE`) firmayı bekletmesin. Yoksa kişiyi kilitlemiş bir davet akışı firmayı, firmayı kilitlemiş kapatma
 * da kişiyi beklerdi (ölü kilit). İki abonelik yazarı firma kilidinde sıraya girer: satırı olmayan aboneliğin kilidi yoktur.
 */

import {
  PLAN_EARLY_ACCESS,
  PRODUCTS,
  isProductKey,
  type AuditOrgClosed,
  type AuditSubscriptionChange,
  type ProductKey,
  type SubscriptionStatus,
} from '@sellerondata/contracts';
import { prisma, type Prisma, type Tx } from '../db.ts';
import { writeAudit } from './audit.ts';
import { PRODUCT_LAUNCH_ENV, assertLaunchConfig, isProductOn, productLaunch } from './launch.ts';
import { applyMemberUpdate, bumpEpoch, lockMemberships } from './members.ts';
import { enqueueEvent, eventProductsOf, orgUpdatedEvent, type OrgForEvent } from './outbox.ts';
import { loadRoleBook, resolveFromBook } from './roleBook.ts';
import { requireOperator } from './support.ts';

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'READ_ONLY', 'CANCELED'] as const satisfies readonly SubscriptionStatus[];
export const PLAN_RE = /^[a-z][a-z0-9_]{1,39}$/;
/** İptalden sonra okunur kalma süresi (KARARLAR "İptal: 90 gün salt okunur"). */
export const RETENTION_DAYS_DEFAULT = 90;
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 3650;
/** LIKE kaçışı: Prisma `contains` `%` ve `_` karakterlerini kaçışlamaz. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const DAY_MS = 86_400_000;

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export function assertPlan(plan: string): string {
  if (!PLAN_RE.test(plan)) throw new Error(`Plan geçersiz: "${plan}" (küçük harf, rakam, alt çizgi; 2-40 karakter, harfle başlar).`);
  return plan;
}

export function assertRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < RETENTION_DAYS_MIN || days > RETENTION_DAYS_MAX) {
    throw new Error(`--days ${RETENTION_DAYS_MIN} ile ${RETENTION_DAYS_MAX} arasında tam sayı olmalı (verilen: ${days}).`);
  }
  return days;
}

/** İptalin bittiği an: tam gün (UTC, 24 saat × gün), takvim ya da yaz saati kayması yok. */
export function deleteAfterOf(canceledAt: Date, days: number): Date {
  return new Date(canceledAt.getTime() + assertRetentionDays(days) * DAY_MS);
}

function productName(product: ProductKey): string {
  return PRODUCTS[product].name;
}

function assertProduct(product: string): asserts product is ProductKey {
  if (!isProductKey(product)) throw new Error(`Bilinmeyen ürün: "${product}".`);
}

function assertProductOn(product: ProductKey) {
  if (!isProductOn(product)) {
    throw new Error(`${productName(product)} kapalı (off): önce ${PRODUCT_LAUNCH_ENV} ile pilot ya da public yapın.`);
  }
}

type LockedOrg = OrgForEvent;

async function lockOrg(tx: Tx, orgId: string): Promise<LockedOrg> {
  await tx.$queryRaw`SELECT 1 FROM "platform"."Organization" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, country: true, currency: true, timeZone: true, companyConfirmedAt: true, version: true },
  });
  if (!org) throw new Error(`Firma bulunamadı: ${orgId}`);
  return org;
}

async function lockSubscriptions(tx: Tx, orgId: string, product?: ProductKey) {
  if (product) {
    await tx.$queryRaw`SELECT 1 FROM "platform"."Subscription" WHERE "orgId" = ${orgId} AND "product" = ${product} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT 1 FROM "platform"."Subscription" WHERE "orgId" = ${orgId} ORDER BY "product" FOR UPDATE`;
  }
  return tx.subscription.findMany({ where: { orgId, ...(product ? { product } : {}) }, orderBy: { product: 'asc' } });
}

/**
 * Üyeliğin güncel halini YALNIZ bu ürüne yayınlar (ilk açılış, `members:announce`). Epoch artmaz. Rol ve izinler `emitMemberUpserted`
 * ile aynı kuralla (rol defteri) çözülür: `members:announce` özel rollerin izinlerini de ürüne taşır.
 */
async function emitMemberTo(tx: Tx, membershipId: string, product: ProductKey) {
  const m = await tx.membership.findUniqueOrThrow({
    where: { id: membershipId },
    include: { person: { select: { name: true } }, productAccess: true },
  });
  const resolved = resolveFromBook(await loadRoleBook(tx, m.orgId), product, m.productAccess.find((a) => a.product === product)?.role);
  await enqueueEvent(tx, {
    type: 'member.upserted',
    orgId: m.orgId,
    product,
    membershipId: m.id,
    personId: m.personId,
    name: m.person.name,
    orgRole: m.orgRole,
    role: resolved?.key ?? null,
    permissions: resolved ? [...resolved.permissions] : [],
    active: m.status === 'ACTIVE',
    epoch: m.epoch,
  });
}

/**
 * Firmanın güncel ad, ülke, para birimi, saat dilimi ve sürümünü YALNIZ bu ürüne yayınlar. Sürüm artmaz. Yeniden duyurudur:
 * varsayılan saat dilimi gönderilmez (`orgUpdatedEvent`), araçtaki değer ezilmez.
 */
async function emitOrgTo(tx: Tx, org: LockedOrg, product: ProductKey) {
  await enqueueEvent(tx, orgUpdatedEvent(org, product));
}

async function orgMembershipIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.membership.findMany({ where: { orgId }, select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}

/** Firmaya katılma davetleri. `PHONE_RESET` (şifre kodu) kişiye aittir, üyelik açmaz: kapatma onu düşürmez. Şema: `InvitationKind`. */
export const JOIN_INVITATION_KINDS = ['EMAIL', 'PHONE_CODE'] as const;

/**
 * Firmanın bekleyen katılma davetlerini kilitler (kilit sırasında kişi ve üyelikten SONRA). Üyelik eklemek firma satırında yalnız
 * `KEY SHARE` alır, `FOR NO KEY UPDATE` onu durdurmaz; davet kabulü ise önce kişiyi, sonra daveti kilitler. Bu kilitten sonra:
 * kabul bitmişse yeni üyelik görünür (çağıran yeniden listeler), bitmemişse kabul bu işlemin sonunu bekler ve yeni durumu okur.
 * Kalan dar boşluk: işlem sürerken açılıp aynı anda kabul edilen yepyeni davet (kilitlenecek satır yoktu).
 */
async function lockJoinInvitations(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "platform"."Invitation"
    WHERE "orgId" = ${orgId} AND "kind" IN ('EMAIL', 'PHONE_CODE') AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
    ORDER BY "id" FOR UPDATE`;
  return rows.map((r) => r.id);
}

/**
 * Firmadaki her üyeliğin epoch'u artar, `member.upserted` her olay ürününe gider: eski jeton araçta `401 TOKEN_STALE` alır.
 * Askıdaki üyelikler de artar (jetonları yok, zararsız; askı kalkınca eski bir jeton dirilmesin).
 * Sonra bekleyen katılma davetleri kilitlenir (`revokeAt` verilirse aynı adımda düşer), üyelikler yeniden listelenir ve bu arada
 * katılmış olanlar da artırılır: durum değişimi sürerken katılanın jetonu eski durumla yaşamasın.
 */
export async function bumpOrgMemberships(tx: Tx, orgId: string, opts: { revokeAt?: Date } = {}): Promise<{ bumped: number; invitationsRevoked: number }> {
  const ids = await orgMembershipIds(tx, orgId);
  if (ids.length) {
    await lockMemberships(tx, ids);
    for (const id of ids) await bumpEpoch(tx, id);
  }
  const pending = await lockJoinInvitations(tx, orgId);
  let invitationsRevoked = 0;
  if (opts.revokeAt && pending.length) {
    const r = await tx.invitation.updateMany({ where: { id: { in: pending }, acceptedAt: null, revokedAt: null }, data: { revokedAt: opts.revokeAt } });
    invitationsRevoked = r.count;
  }
  const seen = new Set(ids);
  const late = (await orgMembershipIds(tx, orgId)).filter((id) => !seen.has(id));
  if (late.length) {
    await lockMemberships(tx, late);
    for (const id of late) await bumpEpoch(tx, id);
  }
  return { bumped: ids.length + late.length, invitationsRevoked };
}

/**
 * Firma kapatılmış mı: sahip kapattı (`Organization.closedAt`, `POST /org/close`) YA DA destek kapattı (`org:close`: son kapatma/yeniden
 * açma kaydı kapatma VE iptal edilmemiş abonelik yok; kapatmadan sonra elle açılan firma kapalı sayılmaz). Tek sorgu; işlem istemcisi
 * ya da `prisma` alır. Kapalı firmada davet açılmaz (A1, 409), yeni araç açılmaz (`product:launch`).
 */
export async function isOrgClosed(db: Pick<Tx, '$queryRaw'>, orgId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<{ closed: boolean | null }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM "platform"."Organization" WHERE "id" = ${orgId} AND "closedAt" IS NOT NULL)
      OR (
        (SELECT "action" FROM "platform"."AuditLog"
          WHERE "orgId" = ${orgId} AND "action" IN ('support.org_closed', 'support.org_reopened')
          ORDER BY "createdAt" DESC, "id" DESC LIMIT 1) = 'support.org_closed'
        AND NOT EXISTS (SELECT 1 FROM "platform"."Subscription" WHERE "orgId" = ${orgId} AND "status" <> 'CANCELED')
      )
    ) AS "closed"`;
  return row?.closed === true;
}

export type SubscriptionChange = { status: SubscriptionStatus; plan?: string; days?: number };
export type SubscriptionAuditInput = { operator: string; reason?: string; via: AuditSubscriptionChange['via'] };

export type SetSubscriptionResult = {
  changed: boolean;
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
  version: number;
  firstOpen: boolean;
  /** Epoch'u artan üyelik sayısı (durum değiştiyse firmadaki bütün üyelikler). */
  bumped: number;
  orgName: string;
  plan: string;
  deleteAfter: Date | null;
  /** İlk açılışta bu ürüne duyurulan üyelik sayısı. */
  announced: number;
  /** İlk açılışta aracın sahip rolü verilen sahip sayısı (0 ya da 1). */
  ownerRoleGranted: number;
};

type CoreOptions = {
  /** `product:launch`: satır varsa (hangi durumda olursa olsun) dokunma. */
  createOnly?: boolean;
  /** `product:launch`: kapatılmış firmaya yeni araç açma. */
  skipClosed?: boolean;
  /** `org:reopen`: kapatmanın iptal ettiği READ_ONLY satırı doğrudan READ_ONLY'ye döner. */
  allowRestore?: boolean;
  /** `org:close`: kapalı (off) araçtaki abonelik de iptal edilir; olay gitmez. */
  allowOff?: boolean;
  now?: Date;
};

type CoreResult = Omit<SetSubscriptionResult, 'bumped'> & { needsBump: boolean; skipped?: 'exists' | 'closed' };

async function changeSubscription(
  tx: Tx,
  orgId: string,
  product: ProductKey,
  change: SubscriptionChange,
  audit: SubscriptionAuditInput,
  opts: CoreOptions = {},
): Promise<CoreResult> {
  const operator = requireOperator(audit.operator);
  assertProduct(product);
  // Servisin açılışta reddedeceği yapılandırmayla (ör. rolü olmayan aracı pilot yapmak) abonelik yazılmaz.
  assertLaunchConfig();
  if (!isSubscriptionStatus(change.status)) throw new Error(`Durum geçersiz: "${String(change.status)}" (ACTIVE, READ_ONLY, CANCELED).`);
  if (change.plan !== undefined) assertPlan(change.plan);
  if (change.days !== undefined) {
    assertRetentionDays(change.days);
    if (change.status !== 'CANCELED') throw new Error('--days yalnız CANCELED ile verilir.');
  }
  const on = isProductOn(product);
  if (!on && !opts.allowOff) assertProductOn(product);
  const reason = audit.reason?.trim() || undefined;
  const now = opts.now ?? new Date();

  const org = await lockOrg(tx, orgId);
  const [sub] = await lockSubscriptions(tx, orgId, product);
  const unchanged = (s: NonNullable<typeof sub>, skipped?: CoreResult['skipped']): CoreResult => ({
    changed: false,
    from: s.status,
    to: s.status,
    version: s.version,
    firstOpen: false,
    orgName: org.name,
    plan: s.plan,
    deleteAfter: s.deleteAfter,
    announced: 0,
    ownerRoleGranted: 0,
    needsBump: false,
    ...(skipped ? { skipped } : {}),
  });

  if (!sub) {
    if (change.status !== 'ACTIVE') throw new Error(`${org.name} · ${productName(product)}: abonelik yok. Önce ACTIVE ile açın.`);
    if (opts.skipClosed && (await isOrgClosed(tx, orgId))) {
      return {
        changed: false,
        from: null,
        to: 'ACTIVE',
        version: 0,
        firstOpen: false,
        orgName: org.name,
        plan: change.plan ?? PLAN_EARLY_ACCESS,
        deleteAfter: null,
        announced: 0,
        ownerRoleGranted: 0,
        needsBump: false,
        skipped: 'closed',
      };
    }
    return firstOpen(tx, org, product, change.plan ?? PLAN_EARLY_ACCESS, { operator, reason, via: audit.via });
  }
  if (opts.createOnly) return unchanged(sub, 'exists');

  const from = sub.status;
  const to = change.status;
  const plan = change.plan ?? sub.plan;
  if (from === 'CANCELED' && to === 'READ_ONLY' && !opts.allowRestore) {
    throw new Error(`${org.name} · ${productName(product)}: CANCELED → READ_ONLY yapılamaz. Önce ACTIVE yapın.`);
  }
  if (from === to && plan === sub.plan) return unchanged(sub);

  const statusChanged = from !== to;
  const updated = await tx.subscription.update({
    where: { id: sub.id },
    data: {
      status: to,
      plan,
      version: { increment: 1 },
      ...(statusChanged
        ? to === 'CANCELED'
          ? { canceledAt: now, deleteAfter: deleteAfterOf(now, change.days ?? RETENTION_DAYS_DEFAULT) }
          : { canceledAt: null, deleteAfter: null }
        : {}),
    },
  });
  // Kapalı araca olay gitmez (teslim edilemez, bekler). DeciShip `subscription.updated`'ı yok sayar; durum jetonla gelir.
  if (on) {
    await enqueueEvent(tx, { type: 'subscription.updated', orgId, product, status: updated.status, plan: updated.plan, version: updated.version });
  }
  await writeAudit(tx, {
    orgId,
    actor: {},
    action: 'support.subscription_changed',
    target: updated.id,
    meta: { product, from, to, plan, via: audit.via, operator, ...(reason ? { reason } : {}) } satisfies AuditSubscriptionChange,
  });
  return {
    changed: true,
    from,
    to,
    version: updated.version,
    firstOpen: false,
    orgName: org.name,
    plan: updated.plan,
    deleteAfter: updated.deleteAfter,
    announced: 0,
    ownerRoleGranted: 0,
    // Plan değişimi jetonu bayatlatmaz (plan bugün hiçbir izni değiştirmiyor); durum değişimi bayatlatır.
    needsBump: statusChanged,
  };
}

/**
 * İlk açılış (satır yoktu → ACTIVE). Sırayla: `subscription.updated`, bu ürüne `org.updated` (sürüm artmaz), sahibe aracın sahip
 * rolü (rol değişimi yolu: epoch artar, olay gider), sonra firmanın her üyeliği bu ürüne `member.upserted` (rolü yoksa `role: null`,
 * askıdaysa `active: false`). Firma satırı kilitli: aynı firmaya aynı anda iki açılış gelirse ikincisi satırı görür.
 */
async function firstOpen(
  tx: Tx,
  org: LockedOrg,
  product: ProductKey,
  plan: string,
  audit: { operator: string; reason?: string; via: AuditSubscriptionChange['via'] },
): Promise<CoreResult> {
  assertPlan(plan);
  const sub = await tx.subscription.create({ data: { orgId: org.id, product, status: 'ACTIVE', plan, version: 1 } });
  await enqueueEvent(tx, { type: 'subscription.updated', orgId: org.id, product, status: 'ACTIVE', plan, version: 1 });
  await emitOrgTo(tx, org, product);

  const ids = await orgMembershipIds(tx, org.id);
  if (ids.length) await lockMemberships(tx, ids);
  const members = await tx.membership.findMany({
    where: { id: { in: ids } },
    select: { id: true, orgRole: true, productAccess: { where: { product }, select: { role: true } } },
    orderBy: { id: 'asc' },
  });
  const ownerRole = PRODUCTS[product].ownerRole;
  const granted = new Set<string>();
  if (ownerRole) {
    for (const m of members) {
      if (m.orgRole !== 'OWNER' || m.productAccess.length) continue;
      await applyMemberUpdate(tx, m.id, { productRoles: { [product]: ownerRole } });
      granted.add(m.id);
    }
  }
  // Rol değişimi olayı bu ürüne zaten gittiyse aynısı ikinci kez yazılmaz.
  const covered = (await eventProductsOf(tx, org.id)).includes(product) ? granted : new Set<string>();
  let announced = 0;
  for (const m of members) {
    if (!covered.has(m.id)) await emitMemberTo(tx, m.id, product);
    announced += 1;
  }
  // Açılış sürerken katılan: katılım olayı bu ürünü görmemiş olabilir (abonelik henüz yoktu). Davet kilidinden sonra yeniden listelenir.
  await lockJoinInvitations(tx, org.id);
  const seen = new Set(ids);
  const late = (await orgMembershipIds(tx, org.id)).filter((id) => !seen.has(id));
  if (late.length) {
    await lockMemberships(tx, late);
    for (const id of late) await emitMemberTo(tx, id, product);
    announced += late.length;
  }

  await writeAudit(tx, {
    orgId: org.id,
    actor: {},
    action: 'support.subscription_changed',
    target: sub.id,
    meta: {
      product,
      from: null,
      to: 'ACTIVE',
      plan,
      via: audit.via,
      operator: audit.operator,
      ...(audit.reason ? { reason: audit.reason } : {}),
    } satisfies AuditSubscriptionChange,
  });
  return {
    changed: true,
    from: null,
    to: 'ACTIVE',
    version: 1,
    firstOpen: true,
    orgName: org.name,
    plan,
    deleteAfter: null,
    announced,
    ownerRoleGranted: granted.size,
    needsBump: false,
  };
}

/**
 * Tek aboneliği değiştirir. Aynı durum ve aynı plan: değişiklik yok (olay, sürüm, denetim yok).
 * Durum değişince firmadaki her üyeliğin epoch'u artar. Çağıran işlemi verir; kilit sırası dosya başında.
 */
export async function setSubscription(
  tx: Tx,
  orgId: string,
  product: ProductKey,
  change: SubscriptionChange,
  audit: SubscriptionAuditInput,
): Promise<SetSubscriptionResult> {
  const r = await changeSubscription(tx, orgId, product, change, audit);
  const bumped = r.needsBump ? (await bumpOrgMemberships(tx, orgId)).bumped : 0;
  return {
    changed: r.changed,
    from: r.from,
    to: r.to,
    version: r.version,
    firstOpen: r.firstOpen,
    bumped,
    orgName: r.orgName,
    plan: r.plan,
    deleteAfter: r.deleteAfter,
    announced: r.announced,
    ownerRoleGranted: r.ownerRoleGranted,
  };
}

export type LaunchResult = {
  /** Açılan (dry-run'da açılacak) firmalar. */
  orgs: { id: string; name: string }[];
  opened: number;
  /** Bu üründe zaten abonelik satırı olan firmalar (durumu ne olursa olsun dokunulmadı). */
  skipped: number;
  /** Kapatılmış firmalar (`org:close`): yeni araç açılmadı. */
  closed: number;
  dryRun: boolean;
};

/**
 * Ürünü abonelik satırı OLMAYAN her firmaya açar (geri doldurma). Durdurulmuş ya da iptal edilmiş satıra dokunmaz, kapatılmış firmaya
 * açmaz. Firma başına ayrı işlem: yarıda kalırsa yeniden çalıştırmak zararsız. Yalnız `public` araçta.
 */
export async function launchProduct(product: ProductKey, opts: { operator: string; plan?: string; dryRun?: boolean }): Promise<LaunchResult> {
  const operator = requireOperator(opts.operator);
  assertProduct(product);
  assertLaunchConfig();
  const launch = productLaunch(product);
  if (launch !== 'public') {
    throw new Error(`${productName(product)} durumu ${launch}: product:launch yalnız public araçta çalışır (pilotta firmalara tek tek subscription:set).`);
  }
  if (opts.plan !== undefined) assertPlan(opts.plan);

  const skipped = await prisma.subscription.count({ where: { product } });
  const candidates = await prisma.organization.findMany({
    where: { subscriptions: { none: { product } } },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  if (opts.dryRun) {
    const orgs: { id: string; name: string }[] = [];
    let closed = 0;
    for (const c of candidates) {
      if (await isOrgClosed(prisma, c.id)) closed += 1;
      else orgs.push(c);
    }
    return { orgs, opened: 0, skipped, closed, dryRun: true };
  }

  const orgs: { id: string; name: string }[] = [];
  let raced = 0;
  let closed = 0;
  for (const c of candidates) {
    let r: CoreResult;
    try {
      r = await prisma.$transaction((tx) =>
        changeSubscription(tx, c.id, product, { status: 'ACTIVE', plan: opts.plan }, { operator, via: 'launch' }, { createOnly: true, skipClosed: true }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${orgs.length} firmaya açıldıktan sonra durdu (${c.name}, ${c.id}): ${msg}. Yeniden çalıştırmak zararsız.`);
    }
    if (r.skipped === 'closed') closed += 1;
    else if (r.skipped === 'exists') raced += 1;
    else orgs.push({ id: c.id, name: r.orgName });
  }
  return { orgs, opened: orgs.length, skipped: skipped + raced, closed, dryRun: false };
}

export type ClosePreview = {
  orgName: string;
  subscriptions: { product: ProductKey; from: Exclude<SubscriptionStatus, 'CANCELED'> }[];
  pendingInvitations: number;
  days: number;
  deleteAfter: Date;
};

/** `org:close --yes` olmadan: ne olacağını söyler, yazmaz. */
export async function previewCloseOrg(orgId: string, opts: { days?: number } = {}): Promise<ClosePreview> {
  const days = assertRetentionDays(opts.days ?? RETENTION_DAYS_DEFAULT);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  if (!org) throw new Error(`Firma bulunamadı: ${orgId}`);
  const subs = await prisma.subscription.findMany({ where: { orgId, status: { not: 'CANCELED' } }, orderBy: { product: 'asc' } });
  const pendingInvitations = await prisma.invitation.count({
    where: { orgId, kind: { in: [...JOIN_INVITATION_KINDS] }, acceptedAt: null, revokedAt: null },
  });
  return {
    orgName: org.name,
    subscriptions: subs.map((s) => ({ product: s.product as ProductKey, from: s.status as Exclude<SubscriptionStatus, 'CANCELED'> })),
    pendingInvitations,
    days,
    deleteAfter: deleteAfterOf(new Date(), days),
  };
}

export type CloseResult = { changed: boolean; orgName: string; canceled: ProductKey[]; invitationsRevoked: number; deleteAfter: Date | null; bumped: number };

/**
 * Firmayı kapatır: iptal edilmemiş bütün abonelikler CANCELED (okunur kalma süresi `days`), bekleyen davetler düşer, her üyeliğin
 * epoch'u bir kez artar. Veri silinmez. Kapatılacak abonelik yoksa değişiklik yok: önceki kapatma kaydı ezilmesin (`org:reopen` onu okur).
 */
export async function closeOrg(orgId: string, opts: { operator: string; days?: number; reason?: string }): Promise<CloseResult> {
  const operator = requireOperator(opts.operator);
  const days = assertRetentionDays(opts.days ?? RETENTION_DAYS_DEFAULT);
  const reason = opts.reason?.trim() || undefined;
  return prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, orgId);
    const subs = await lockSubscriptions(tx, orgId);
    const open = subs.filter((s) => s.status !== 'CANCELED');
    if (!open.length) return { changed: false, orgName: org.name, canceled: [], invitationsRevoked: 0, deleteAfter: null, bumped: 0 };
    const now = new Date();
    for (const s of open) {
      await changeSubscription(tx, orgId, s.product as ProductKey, { status: 'CANCELED', days }, { operator, reason, via: 'close' }, { allowOff: true, now });
    }
    // Yalnız katılma davetleri düşer; şifre kodları (PHONE_RESET) kişiye ait, kalır.
    const { bumped, invitationsRevoked } = await bumpOrgMemberships(tx, orgId, { revokeAt: now });
    const meta: AuditOrgClosed = {
      subscriptions: open.map((s) => ({ product: s.product, from: s.status as Exclude<SubscriptionStatus, 'CANCELED'> })),
      days,
      operator,
      ...(reason ? { reason } : {}),
    };
    await writeAudit(tx, { orgId, actor: {}, action: 'support.org_closed', target: orgId, meta: meta as Prisma.InputJsonValue });
    return {
      changed: true,
      orgName: org.name,
      canceled: open.map((s) => s.product as ProductKey),
      invitationsRevoked,
      deleteAfter: deleteAfterOf(now, days),
      bumped,
    };
  });
}

export type ReopenSkip = { product: string; reason: 'not_canceled' | 'changed_after_close' | 'off' };
export type ReopenResult = {
  orgName: string;
  restored: ProductKey[];
  details: { product: ProductKey; to: Exclude<SubscriptionStatus, 'CANCELED'> }[];
  skipped: ReopenSkip[];
  bumped: number;
};

/**
 * `closeOrg`un tersi (`phone:restore` kalıbı): son `support.org_closed` kaydında listelenen ve hâlâ CANCELED olan abonelikleri
 * eski durumlarına döndürür. Kapatmadan sonra elle değiştirilmiş abonelik (`subscription:set`, önceki bir `org:reopen`) atlanır:
 * yalnız kapatmanın yaptığı geri alınır. Davetler geri gelmez. Süresi geçmiş iptal de açılır (veri durur).
 */
export async function reopenOrg(orgId: string, opts: { operator: string }): Promise<ReopenResult> {
  const operator = requireOperator(opts.operator);
  return prisma.$transaction(async (tx) => {
    const org = await lockOrg(tx, orgId);
    const close = await tx.auditLog.findFirst({
      where: { orgId, action: 'support.org_closed' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!close) throw new Error(`${org.name}: kapatma kaydı yok (org:close ile kapatılmamış).`);
    const listed = ((close.meta as AuditOrgClosed | null)?.subscriptions ?? []).filter((s) => isProductKey(s.product));
    const subs = await lockSubscriptions(tx, orgId);
    const later = await tx.auditLog.findMany({
      where: { orgId, action: 'support.subscription_changed', createdAt: { gte: close.createdAt } },
      select: { meta: true },
    });
    const touched = new Set(
      later
        .map((r) => r.meta as Partial<AuditSubscriptionChange> | null)
        .filter((m) => m && m.via !== 'close')
        .map((m) => m!.product),
    );

    const details: ReopenResult['details'] = [];
    const skipped: ReopenSkip[] = [];
    for (const item of listed) {
      const product = item.product as ProductKey;
      const sub = subs.find((s) => s.product === product);
      if (!sub || sub.status !== 'CANCELED') skipped.push({ product, reason: 'not_canceled' });
      else if (touched.has(product)) skipped.push({ product, reason: 'changed_after_close' });
      else if (!isProductOn(product)) skipped.push({ product, reason: 'off' });
      else {
        await changeSubscription(tx, orgId, product, { status: item.from }, { operator, via: 'reopen' }, { allowRestore: true });
        details.push({ product, to: item.from });
      }
    }
    let bumped = 0;
    if (details.length) {
      bumped = (await bumpOrgMemberships(tx, orgId)).bumped;
      await writeAudit(tx, {
        orgId,
        actor: {},
        action: 'support.org_reopened',
        target: orgId,
        meta: { restored: details, skipped, operator, closedAuditId: close.id } as Prisma.InputJsonValue,
      });
    }
    return { orgName: org.name, restored: details.map((d) => d.product), details, skipped, bumped };
  });
}

/**
 * Aboneliği olan firmaların bilgisini ve üyelerini YALNIZ bu ürüne yeniden duyurur (`org.updated` + her üyelik `member.upserted`,
 * güncel sürüm ve epoch; artmaz). Tekrar çalıştırmak zararsız. Ürün kapalıysa çalışmaz (olay gitmez). Firma başına ayrı işlem.
 */
export async function announceMembers(product: ProductKey, opts: { orgId?: string } = {}): Promise<{ orgs: number; members: number; orgName?: string }> {
  assertProduct(product);
  assertLaunchConfig();
  if (!isProductOn(product)) throw new Error(`${productName(product)} kapalı (off): olay gitmez. Önce ${PRODUCT_LAUNCH_ENV} ile pilot ya da public yapın.`);
  const orgIds = opts.orgId
    ? [opts.orgId]
    : (await prisma.subscription.findMany({ where: { product }, select: { orgId: true }, orderBy: { orgId: 'asc' } })).map((s) => s.orgId);
  let orgs = 0;
  let members = 0;
  let orgName: string | undefined;
  for (const id of orgIds) {
    const n = await prisma.$transaction(async (tx) => {
      const org = await lockOrg(tx, id);
      orgName = org.name;
      const [sub] = await lockSubscriptions(tx, id, product);
      if (!sub) {
        if (opts.orgId) throw new Error(`${org.name}: ${productName(product)} aboneliği yok.`);
        return null;
      }
      await emitOrgTo(tx, org, product);
      const ids = await orgMembershipIds(tx, id);
      if (ids.length) await lockMemberships(tx, ids);
      for (const m of ids) await emitMemberTo(tx, m, product);
      return ids.length;
    });
    if (n === null) continue;
    orgs += 1;
    members += n;
  }
  return { orgs, members, ...(opts.orgId ? { orgName } : {}) };
}

export type OrgRow = {
  id: string;
  name: string;
  country: string;
  createdAt: Date;
  members: { active: number; total: number };
  ownerEmail: string | null;
  /** En geç `Membership.lastActiveAt`. */
  lastActiveAt: Date | null;
  subscriptions: { product: string; status: SubscriptionStatus; plan: string; version: number; deleteAfter: Date | null }[];
};

export const ORG_LIST_LIMIT_DEFAULT = 50;
export const ORG_LIST_LIMIT_MAX = 500;

/** Salt okur, denetim kaydı yok. Sahibin e-postası tam gösterilir (yalnız sunucuda; plan §7 karar 20). En yeni firma önce. */
export async function listOrgs(opts: { q?: string; product?: ProductKey; status?: SubscriptionStatus | 'none'; limit?: number } = {}): Promise<OrgRow[]> {
  if (opts.product !== undefined) assertProduct(opts.product);
  if (opts.status !== undefined && opts.status !== 'none' && !isSubscriptionStatus(opts.status)) throw new Error(`Durum geçersiz: "${opts.status}".`);
  const limit = opts.limit ?? ORG_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ORG_LIST_LIMIT_MAX) throw new Error(`--limit 1 ile ${ORG_LIST_LIMIT_MAX} arasında olmalı.`);

  const where: Prisma.OrganizationWhereInput = {};
  const q = opts.q?.trim();
  if (q) where.name = { contains: likeEscape(q), mode: 'insensitive' };
  if (opts.status === 'none') where.subscriptions = { none: opts.product ? { product: opts.product } : {} };
  else if (opts.status) where.subscriptions = { some: { status: opts.status, ...(opts.product ? { product: opts.product } : {}) } };
  else if (opts.product) where.subscriptions = { some: { product: opts.product } };

  const rows = await prisma.organization.findMany({
    where,
    take: limit,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      subscriptions: { orderBy: { product: 'asc' } },
      memberships: { select: { orgRole: true, status: true, lastActiveAt: true, person: { select: { email: true } } } },
    },
  });
  return rows.map((o) => {
    const last = o.memberships.reduce<Date | null>((max, m) => (m.lastActiveAt && (!max || m.lastActiveAt > max) ? m.lastActiveAt : max), null);
    return {
      id: o.id,
      name: o.name,
      country: o.country,
      createdAt: o.createdAt,
      members: { active: o.memberships.filter((m) => m.status === 'ACTIVE').length, total: o.memberships.length },
      ownerEmail: o.memberships.find((m) => m.orgRole === 'OWNER')?.person.email ?? null,
      lastActiveAt: last,
      subscriptions: o.subscriptions.map((s) => ({ product: s.product, status: s.status, plan: s.plan, version: s.version, deleteAfter: s.deleteAfter })),
    };
  });
}
