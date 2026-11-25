import crypto from 'node:crypto';
import {
  DEFAULT_ORG_TIME_ZONE,
  isOrgTimeZone,
  isProductKey,
  serviceEventOf,
  type OrgCurrency,
  type PlatformEvent,
  type PlatformServiceKey,
  type ProductKey,
  type ServiceEvent,
} from '@sellerondata/contracts';
import { prisma, type Prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { isProductOn } from './launch.ts';
import { loadRoleBook, resolveFromBook } from './roleBook.ts';

// Dağılımlı `Omit`: birleşim türünün her kolunu korur.
type EventBody<T> = T extends unknown ? Omit<T, 'eventId'> : never;
export type NewEvent = EventBody<PlatformEvent>;

/**
 * Olayı değişiklikle aynı işlemde yazar. Teslim satırı her zaman açılır: hedef tanımsızsa dağıtıcı bekletir, olay kaybolmaz.
 * `eventId == Outbox.id`, yeniden denemelerde değişmez.
 */
export async function enqueueEvent(tx: Tx, event: NewEvent): Promise<string> {
  const id = crypto.randomUUID();
  await tx.outbox.create({
    data: {
      id,
      type: event.type,
      orgId: event.orgId,
      payload: { ...event, eventId: id } as unknown as Prisma.InputJsonValue,
      deliveries: { create: { target: event.product } },
    },
  });
  await enqueueServiceEvents(tx, event);
  return id;
}

// ---------- Ürün dışı hizmet olayları (yapay zekâ geçidi; contracts `ServiceEvent`) ----------

export type ServiceEventBody = EventBody<ServiceEvent>;
/** Hizmete giden firma olayı, ürünsüz (`org.*`). Ürün olayından da verilebilir: `product` atılır. */
type ServiceEventInput = NewEvent | Exclude<ServiceEventBody, { type: 'subscription.updated' }>;

/** Bu işlemde hizmete yazılmış olaylar: firma olayı ürün başına değil, değişiklik başına bir kez gider. İşlem bitince düşer. */
const writtenInTx = new WeakMap<object, Set<string>>();

function serviceDedupeKey(service: PlatformServiceKey, event: ServiceEventBody): string {
  if (event.type === 'subscription.updated') return `${service}|${event.type}|${event.orgId}|${event.product}|${event.version ?? '-'}`;
  if (event.type === 'org.purged') return `${service}|${event.type}|${event.orgId}`;
  return `${service}|${event.type}|${event.orgId}|${event.version ?? '-'}`;
}

/** `Subscription.limits` (Json): yalnız sayı ve mantıksal değerli anahtarlar (`ProductClaim.limits` ile aynı biçim). */
function limitsOf(value: unknown): Record<string, number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean'));
}

/**
 * Olayın hizmet kopyalarını yazar (değişiklikle aynı işlemde). Adresi tanımlı her hizmete (`PLATFORM_SERVICE_TARGETS`), aldığı türse
 * (`SERVICE_EVENT_TYPES`), ayrı `Outbox` satırı ve kendi `eventId`'siyle; ürünlere giden kopyalar etkilenmez. `enqueueEvent` her ürün
 * olayında bunu kendisi çağırır, böylece olay yazan hiçbir yer hizmeti unutamaz; aynı işlemde aynı firma olayı (aynı tür, firma,
 * sürüm) ikinci kez yazılmaz. Firmanın aboneliği yoksa ürün olayı da yoktur: firma olayını yazan yer bunu ayrıca çağırır
 * (`emitOrgUpdated`, firma kapatma, geri açma, silme). `subscription.updated` abonelik satırının güncel `limits`'ini taşır.
 * Adresi olmayan hizmete satır açılmaz: geçitsiz kurulumda bekleyen teslimler birikmesin; adres sonradan yazılırsa `org:announce`
 * firmaları yeniden duyurur.
 */
export async function enqueueServiceEvents(tx: Tx, event: ServiceEventInput): Promise<void> {
  const services = [...env.serviceTargets.keys()];
  if (!services.length) return;
  // İşlem dışı istemciyle (`prisma`) çağrılırsa eleme yapılmaz: küresel istemcinin kümesi süreç boyunca yaşardı.
  let written = writtenInTx.get(tx);
  if (!written) {
    written = new Set();
    if ((tx as unknown) !== prisma) writtenInTx.set(tx, written);
  }
  for (const service of services) {
    let input = event as NewEvent;
    if (event.type === 'subscription.updated') {
      const sub = await tx.subscription.findUnique({ where: { orgId_product: { orgId: event.orgId, product: event.product } }, select: { limits: true } });
      const limits = limitsOf(sub?.limits);
      input = { ...event, ...(limits ? { limits } : {}) } as NewEvent;
    }
    const body = serviceEventOf(service, input);
    if (!body) continue;
    const key = serviceDedupeKey(service, body);
    if (written.has(key)) continue;
    written.add(key);
    const id = crypto.randomUUID();
    await tx.outbox.create({
      data: {
        id,
        type: body.type,
        orgId: body.orgId,
        payload: { ...body, eventId: id } as unknown as Prisma.InputJsonValue,
        deliveries: { create: { target: service } },
      },
    });
  }
}

/**
 * Firmanın aboneliği olan (her durumda), kapalı olmayan ürünler. Ürün tarafında yalnız bunlar için projeksiyon vardır.
 * Kapalı ürüne olay gitmez: `off → pilot` dönüşünden sonra `members:announce` eksikleri tamamlar.
 */
export async function eventProductsOf(tx: Tx, orgId: string): Promise<ProductKey[]> {
  const subs = await tx.subscription.findMany({ where: { orgId }, select: { product: true }, orderBy: { product: 'asc' } });
  return subs.map((s) => s.product).filter((p): p is ProductKey => isProductKey(p) && isProductOn(p));
}

/**
 * Firma yaşam döngüsü olayları (`org.closed`, `org.reopened`, `org.purged`). Dağıtıcı bunları hiç bırakmaz (DEAD olmaz, kapaklı
 * geri çekilmeyle denemeye devam eder), bakım teslim edilmemiş olanı silmez: kaçan `org.purged` aracın elinde silinmiş firmanın
 * verisini sonsuza dek bırakır (abonelik satırları silmeyle gider, onarılamaz), kaçan `org.reopened` geri açılmış firmayı araçta
 * kapalı tutar (`409 ORG_CLOSED`).
 */
export const LIFECYCLE_EVENT_TYPES: readonly string[] = ['org.closed', 'org.reopened', 'org.purged'];

/**
 * Yaşam döngüsü olaylarının gideceği ürünler: firmanın aboneliği olan (her durumda) VE bu firma için önceden olay almış her ürün,
 * çalışma durumuna bakılmaksızın. `eventProductsOf`'un tersine kapalı (`off`) ürün dışarıda kalmaz: kapalıya alınmış ürünün elinde
 * firmanın verisi durabilir ve silme ya da kapanış ona da ulaşmalı. Hedef adresi tanımsız ürünün teslimi adres yazılana kadar bekler.
 */
export async function lifecycleProductsOf(tx: Tx, orgId: string): Promise<ProductKey[]> {
  const subs = await tx.subscription.findMany({ where: { orgId }, select: { product: true } });
  const past = await tx.outboxDelivery.findMany({ where: { outbox: { orgId } }, select: { target: true }, distinct: ['target'] });
  const all = new Set<string>([...subs.map((s) => s.product), ...past.map((d) => d.target)]);
  return [...all].filter(isProductKey).sort();
}

/**
 * Üyeliğin güncel halini ürünlere yayınlar. Rol firmanın rol defteriyle çözülür (jetonla aynı kural): geçersiz rol (gizlenmiş hazır
 * rol, silinmiş özel rol, katalogda olmayan anahtar) `role: null` gider. `permissions` rolün firmadaki izinleridir; rol yoksa boş.
 */
export async function emitMemberUpserted(tx: Tx, membershipId: string) {
  const m = await tx.membership.findUniqueOrThrow({
    where: { id: membershipId },
    include: { person: { select: { name: true } }, productAccess: true },
  });
  const products = await eventProductsOf(tx, m.orgId);
  if (!products.length) return;
  const book = await loadRoleBook(tx, m.orgId);
  for (const product of products) {
    const resolved = resolveFromBook(book, product, m.productAccess.find((a) => a.product === product)?.role);
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
}

export type OrgForEvent = {
  id: string;
  name: string;
  country: string;
  currency: OrgCurrency;
  timeZone: string;
  companyConfirmedAt: Date | null;
  version: number;
};

/**
 * `org.updated` gövdesi. Saat dilimi para birimi ve ülke gibi o anki değerdir; tek fark varsayılan değerdedir:
 * `DEFAULT_ORG_TIME_ZONE` göçten önce açılmış her firmada seçilmiş değil, göçün yazdığı değerdir (20261114091000). Bu yüzden
 * varsayılan yalnız gerçekten söylendiğinde gider (`sayTimeZone`: firma açılışı, saat dilimini değiştiren PATCH). Yeniden
 * duyurular (`org:announce`, `members:announce`, aracın ilk açılışı) ve başka alanın değişimi varsayılanı göndermez: alan yoksa
 * alıcı kendi değerine dokunmaz (eski biçim olay kuralı), araç tarafında önceden yazılmış değer varsayılanla ezilmez.
 * `companyConfirmed` (Merkez kurulumu: firma bilgileri onaylandı mı) her olayda o anki değerle gider: ilk olay `false`, yeniden
 * duyurular dahil. Saat diliminin tersine varsayılan sorunu yoktur: göç eski firmaları gerçekten onaylı doldurdu.
 */
export function orgUpdatedEvent(org: OrgForEvent, product: ProductKey, opts: { sayTimeZone?: boolean } = {}): NewEvent {
  return { ...orgUpdatedBody(org, opts), product };
}

/** `org.updated` gövdesi, ürünsüz (hizmet olayı da bunu taşır). Kurallar `orgUpdatedEvent`'te. */
function orgUpdatedBody(org: OrgForEvent, opts: { sayTimeZone?: boolean }): Extract<ServiceEventBody, { type: 'org.updated' }> {
  const timeZone = isOrgTimeZone(org.timeZone) && (opts.sayTimeZone || org.timeZone !== DEFAULT_ORG_TIME_ZONE) ? org.timeZone : undefined;
  return {
    type: 'org.updated',
    orgId: org.id,
    name: org.name,
    country: org.country,
    currency: org.currency,
    ...(timeZone ? { timeZone } : {}),
    companyConfirmed: org.companyConfirmedAt !== null,
    version: org.version,
  };
}

export async function emitOrgUpdated(tx: Tx, org: OrgForEvent, opts: { sayTimeZone?: boolean } = {}) {
  // Hizmete firma başına bir kez, aboneliği olmayan firmada da (ürün kopyaları aynı olayı yeniden yazmaz: `enqueueServiceEvents`).
  await enqueueServiceEvents(tx, orgUpdatedBody(org, opts));
  for (const product of await eventProductsOf(tx, org.id)) {
    await enqueueEvent(tx, orgUpdatedEvent(org, product, opts));
  }
}
