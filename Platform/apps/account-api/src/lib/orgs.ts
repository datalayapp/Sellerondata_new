import { PLAN_EARLY_ACCESS, currencyForCountry, defaultTimeZone, PRODUCTS, PRODUCT_KEYS, type Locale, type ProductKey } from '@sellerondata/contracts';
import { prisma, type Tx } from '../db.ts';
import { writeAudit } from './audit.ts';
import { productLaunches } from './launch.ts';
import { createMembershipWithRoles } from './members.ts';
import { emitOrgUpdated, enqueueEvent } from './outbox.ts';

/**
 * Firma + OWNER + herkese açık (`public`) ürünlerin aboneliği ve sahip rolü. Kayıt ve `POST /orgs` aynı yolu kullanır.
 * Abonelik `early_access` ve `ACTIVE` açılır (ARCHITECTURE §1). `pilot` ürün kayıtta açılmaz: yalnız destek komutuyla
 * (`subscription:set`), seçili firmaya.
 */
export async function createOrganizationWithOwner(
  tx: Tx,
  input: { personId: string; name: string; country: string; locale: Locale; ip: string },
) {
  // Saat dilimi ülkeden önerilir (Mesaj 15 §4.1); sonra Firma ekranında değişir. Dil açanın dilidir.
  const org = await tx.organization.create({
    data: {
      name: input.name,
      country: input.country,
      currency: currencyForCountry(input.country),
      timeZone: defaultTimeZone(input.country),
      locale: input.locale,
      version: 1,
    },
  });
  // Abonelik önce: üyelik olayı aboneliği olan ürünlere gider. Tek okuma: istek boyunca durum değişse de liste tutarlı kalır.
  const launches = productLaunches();
  const products = (PRODUCT_KEYS as readonly ProductKey[]).filter((k) => launches[k] === 'public' && PRODUCTS[k].ownerRole);
  for (const product of products) {
    await tx.subscription.create({ data: { orgId: org.id, product, status: 'ACTIVE', plan: PLAN_EARLY_ACCESS, version: 1 } });
    await enqueueEvent(tx, { type: 'subscription.updated', orgId: org.id, product, status: 'ACTIVE', plan: PLAN_EARLY_ACCESS, version: 1 });
  }
  const membership = await createMembershipWithRoles(tx, {
    personId: input.personId,
    orgId: org.id,
    orgRole: 'OWNER',
    productRoles: Object.fromEntries(products.map((p) => [p, PRODUCTS[p].ownerRole])),
  });
  // İlk olay saat dilimini her zaman söyler (varsayılan olsa da): firmanın ilk değeri budur.
  await emitOrgUpdated(tx, org, { sayTimeZone: true });
  await writeAudit(tx, {
    orgId: org.id,
    actor: { personId: input.personId, membershipId: membership.id, ip: input.ip },
    action: 'org.created',
    target: org.id,
  });
  return { org, membership };
}

/**
 * Her firmayı güncel değerleriyle ürünlere yeniden duyurur: `org.updated` yeni alan kazanınca (ülke) eski firmaların ürün tarafı
 * tamamlansın diye. Sürüm artar, satır kilidi altında: gerçek değişiklikle yarışsa da en büyük sürüm güncel değeri taşır.
 * Tekrar çalıştırmak zararsızdır. Betik: `scripts/org-announce.ts`. Varsayılan saat dilimi (göçün yazdığı değer) gönderilmez:
 * araçtaki saat dilimi ezilmez (`orgUpdatedEvent`).
 */
export async function announceAllOrgs(): Promise<number> {
  const ids = await prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of ids) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "platform"."Organization" WHERE "id" = ${id} FOR UPDATE`;
      const org = await tx.organization.update({ where: { id }, data: { version: { increment: 1 } } });
      await emitOrgUpdated(tx, org);
    });
  }
  return ids.length;
}
