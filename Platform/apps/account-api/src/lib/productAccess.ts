/**
 * Bir firmada ürünlerin erişim durumu. Jeton (`prod`) ve `/me products[]` buradan türer: ikisi ayrışamaz (Mesaj 11 §3.2).
 *
 * Kurallar (ürün başına, kayıt sırasıyla):
 * - `launch`: çalışırken geçerli durum (`PRODUCT_LAUNCH ?? kayıt`, `launch.ts`).
 * - Kapalı (`off`) üründe abonelik, rol ve jeton yok; veritabanında satır olsa bile.
 * - `subscription`: ürün kapalı değilse ve abonelik canlıysa (`isSubscriptionLive`).
 * - `role`: abonelik varsa ve rol firmada geçerliyse (`resolveFromBook`: katalogdaki görünen hazır rol ya da firmanın özel rolü).
 *   Geçersiz rol (katalogda yok, gizlenmiş hazır rol, silinmiş özel rol) yok sayılır.
 * - `available` (bu firmada açık): `public`, ya da `pilot` ve canlı abonelik.
 * - `claim` (jetona giren): rol ve canlı abonelik birlikte; `perms` rolün firmadaki izinleridir.
 */

import {
  PRODUCT_KEYS,
  type Permission,
  type ProductClaim,
  type ProductKey,
  type ProductLaunch,
  type SubscriptionStatus,
} from '@sellerondata/contracts';
import type { Prisma } from '../db.ts';
import { launchOverrides, productLaunch, type LaunchOverrides } from './launch.ts';
import { EMPTY_ROLE_BOOK, resolveFromBook, type ResolvedRole, type RoleBook } from './roleBook.ts';

export type SubscriptionRow = {
  product: string;
  status: SubscriptionStatus;
  plan: string;
  limits: Prisma.JsonValue;
  deleteAfter: Date | null;
};

/** CANCELED: saklama süresince salt okunur (ürün yazmayı READ_ONLY ile keser), `deleteAfter` geçince erişim biter. */
export function isSubscriptionLive(sub: { status: string; deleteAfter: Date | null }, now = new Date()): boolean {
  return !(sub.status === 'CANCELED' && sub.deleteAfter && sub.deleteAfter <= now);
}

export type ProductAccessState = {
  key: ProductKey;
  launch: ProductLaunch;
  /** Bu firmada açık: `public`, ya da `pilot` ve canlı abonelik. */
  available: boolean;
  /** Canlı abonelik; ürün kapalıysa null. */
  subscription: SubscriptionRow | null;
  /** Kişinin firmada geçerli rolü; abonelik yoksa null. */
  role: string | null;
  /** Çözülmüş rol (ad, tür, izinler); `role` null ise null. */
  resolved: ResolvedRole | null;
  /** Rolün firmadaki izinleri; rol yoksa boş. */
  permissions: Permission[];
  /** Jetona giren değer; rol ya da abonelik yoksa null. */
  claim: ProductClaim | null;
};

/**
 * `roles`: firmanın rol defteri (`loadRoleBook`). Verilmezse yalnız katalog hazır rolleri tanınır (özel rol düşer); üretim
 * yolları her zaman defteri verir.
 */
export function productAccessFor(
  access: readonly { product: string; role: string }[],
  subscriptions: readonly SubscriptionRow[],
  opts: { now?: Date; overrides?: LaunchOverrides; roles?: RoleBook } = {},
): ProductAccessState[] {
  const now = opts.now ?? new Date();
  const overrides = opts.overrides ?? launchOverrides();
  const book = opts.roles ?? EMPTY_ROLE_BOOK;
  return (PRODUCT_KEYS as readonly ProductKey[]).map((key) => {
    const launch = productLaunch(key, overrides);
    const found = launch === 'off' ? undefined : subscriptions.find((s) => s.product === key);
    const subscription = found && isSubscriptionLive(found, now) ? found : null;
    const raw = subscription ? access.find((a) => a.product === key)?.role : undefined;
    const resolved = raw ? resolveFromBook(book, key, raw) : null;
    const role = resolved ? resolved.key : null;
    const claim: ProductClaim | null =
      subscription && resolved
        ? {
            role: resolved.key,
            perms: [...resolved.permissions],
            status: subscription.status,
            plan: subscription.plan,
            limits: (subscription.limits ?? {}) as Record<string, number | boolean>,
          }
        : null;
    return {
      key,
      launch,
      available: launch === 'public' || (launch === 'pilot' && subscription !== null),
      subscription,
      role,
      resolved,
      permissions: resolved ? [...resolved.permissions] : [],
      claim,
    };
  });
}

/** Jetonun `prod` alanı: yalnız `claim`'i olan ürünler. */
export function productClaimsOf(states: readonly ProductAccessState[]): Partial<Record<ProductKey, ProductClaim>> {
  const prod: Partial<Record<ProductKey, ProductClaim>> = {};
  for (const s of states) if (s.claim) prod[s.key] = s.claim;
  return prod;
}
