import type { Locale, MeResponse } from '@sellerondata/contracts';
import type { PrismaClient, Tx } from '../db.ts';
import { env } from '../env.ts';
import { countryOfPhone } from './identity.ts';
import { productAccessFor } from './productAccess.ts';
import { EMPTY_ROLE_BOOK, loadRoleBook, roleLabelOf } from './roleBook.ts';

/**
 * Platform yöneticisi mi (KARARLAR / YAPAY-ZEKA-GECIDI §2): e-postası `PLATFORM_OPERATORS` listesinde VE doğrulanmış (`emailVerifiedAt`)
 * VE kişi askıda değil. Firmadan bağımsızdır. Onay bekleyen yeni adres (`pendingEmail`) sayılmaz: listedeki adresi doğrulamadan
 * yazan kişi yetki almaz. Jeton (`op`), `/me` (`platformOperator`) ve adım artırma (`POST /operator/step-up`) bu tek kuralı kullanır.
 */
export function isPlatformOperator(person: { email: string | null; emailVerifiedAt: Date | null; suspendedAt?: Date | null }): boolean {
  if (!person.email || !person.emailVerifiedAt || person.suspendedAt) return false;
  return env.platformOperators.has(person.email.toLowerCase());
}

/** Jeton için: liste boşsa veritabanına gitmez. */
export async function platformOperatorOf(db: PrismaClient | Tx, personId: string): Promise<boolean> {
  if (env.platformOperators.size === 0) return false;
  const person = await db.person.findUnique({ where: { id: personId }, select: { email: true, emailVerifiedAt: true, suspendedAt: true } });
  return !!person && isPlatformOperator(person);
}

/** `locale`: hazır rol adının dili (`roleLabel`); verilmezse kişinin dili. Firmanın yazdığı ad her dilde aynıdır. */
export async function buildMe(db: PrismaClient | Tx, personId: string, activeOrgId: string | null, locale?: Locale): Promise<MeResponse> {
  const person = await db.person.findUniqueOrThrow({
    where: { id: personId },
    include: {
      memberships: {
        orderBy: { createdAt: 'asc' },
        include: { org: true, productAccess: true },
      },
    },
  });
  // Kapalı firma (`POST /org/close`) yalnız sahibinin listesinde görünür; hiç kimsede etkin firma olamaz.
  // Diğer üyelerde üyelik hiç yokmuş gibidir (sayılar ve şifre kurtarma yolu dahil).
  const memberships = person.memberships.filter((m) => !m.org.closedAt || m.orgRole === 'OWNER');
  const open = memberships.filter((m) => !m.org.closedAt);
  const active = open.find((m) => m.orgId === activeOrgId && m.status === 'ACTIVE') ?? null;
  const subscriptions = active ? await db.subscription.findMany({ where: { orgId: active.orgId } }) : [];
  const roles = active ? await loadRoleBook(db, active.orgId) : EMPTY_ROLE_BOOK;
  const labelLocale = locale ?? person.locale;

  return {
    person: {
      id: person.id,
      name: person.name,
      email: person.email,
      phone: person.phone,
      locale: person.locale,
      emailVerified: person.emailVerifiedAt !== null,
      // Onay bekleyen yeni adres: doğrulanana kadar `email` eski adrestir ve geçerlidir.
      pendingEmail: person.pendingEmail,
    },
    orgs: memberships.map((m) => ({
      id: m.orgId,
      name: m.org.name,
      orgRole: m.orgRole,
      status: m.status,
      // Alanlar yalnız kapalı firmada yazılır (sözleşme: yoksa açık); açık firmanın yanıtı eskisiyle aynı kalır.
      // Saat dilimi de: kapalı firma etkin olamaz, Merkez'in saat dilimi başka firmanındır; tarihler bu firmanın saatiyle yazılır.
      ...(m.org.closedAt
        ? {
            orgStatus: 'CLOSED' as const,
            closedAt: m.org.closedAt.toISOString(),
            purgeAfter: (m.org.purgeAfter ?? m.org.closedAt).toISOString(),
            timeZone: m.org.timeZone,
          }
        : {}),
    })),
    activeOrg: active
      ? {
          id: active.orgId,
          name: active.org.name,
          country: active.org.country,
          currency: active.org.currency,
          // Firma saat dilimi ve dili (Firma ekranı). Kişinin dili `person.locale`'dir.
          timeZone: active.org.timeZone,
          locale: active.org.locale,
          // Merkez kurulumu: firma bilgileri onaylandı mı (ISO an; `null` = onay bekliyor). Kural `isCompanyConfirmed` (contracts).
          companyConfirmedAt: active.org.companyConfirmedAt?.toISOString() ?? null,
          orgRole: active.orgRole,
          membershipId: active.id,
        }
      : null,
    account: {
      // Kapalı denemede (`SIGNUP_MODE=invite`) `POST /orgs` kapalı: "Yeni firma" seçeneği görünmesin.
      canCreateOrg: env.registrationEnabled && env.signupMode === 'open' && person.email !== null,
      createOrgRequiresEmail: person.email === null,
      suspendedOrgCount: open.filter((m) => m.status === 'SUSPENDED').length,
      mailEnabled: env.mailEnabled,
      mailDelivers: env.mailDelivers,
      canLeaveActiveOrg: active !== null && active.orgRole !== 'OWNER',
      leaveRequiresPassword: person.email === null,
      passwordRecovery: person.email
        ? 'email'
        : open.length === 1 && open[0].status === 'ACTIVE' && open[0].orgRole !== 'OWNER'
          ? 'org_admin'
          : 'none',
      defaultCountry: active?.org.country ?? memberships[0]?.org.country ?? countryOfPhone(person.phone) ?? 'TR',
    },
    // Jetonla aynı işlev (`productAccessFor`) ve aynı rol defteri: kapalı ürün, süresi geçen abonelik, geçersiz rol (gizlenmiş hazır
    // rol, silinmiş özel rol) ikisinde de aynı düşer; izinler firmadaki rolün izinleridir.
    products: productAccessFor(active?.productAccess ?? [], subscriptions, { roles }).map((s) => ({
      key: s.key,
      available: s.available,
      launch: s.launch,
      subscription: s.subscription ? { status: s.subscription.status, plan: s.subscription.plan } : null,
      role: s.role,
      ...(s.resolved ? { roleLabel: roleLabelOf(s.resolved, labelLocale), roleKind: s.resolved.kind } : {}),
      permissions: [...s.permissions],
    })),
    // Jetondaki `op` ile aynı kural; Merkez "Platform" menüsünü yalnız `true` iken gösterir.
    platformOperator: isPlatformOperator(person),
  };
}
