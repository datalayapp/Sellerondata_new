import { catalogPermissionsOf, effectivePermissions } from '@sellerondata/auth-kit';
import { errorMessage, PRODUCTS, type Permission } from '@sellerondata/contracts';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { prisma } from '../db.ts';
import { requestLocale } from '../i18n/index.ts';

const CATALOG = catalogPermissionsOf(PRODUCTS.deciship);

/** Yerel üye kaydının yetkiyi belirleyen kısmı (`Member.role` + `Member.permissions`). */
export type MemberAccess = { role: string | null; permissions: readonly string[] | null };

/**
 * Yerel üye kaydının geçerli izinleri; istekteki jetonla aynı kural (auth-kit `effectivePermissions`): izin listesi varsa
 * katalogla kesişimi (özel ya da düzenlenmiş hazır rol), null ise rolden katalogla türetilir, rol yoksa boş.
 * İstek dışında yetki gereken yerler (imzalı dosya bağlantısı, örnek veri) rol adına değil buna bakar.
 */
export function memberPermissions(member: MemberAccess): readonly Permission[] {
  return effectivePermissions(PRODUCTS.deciship, member.role, member.permissions, CATALOG);
}

export type MemberAccessRow = MemberAccess & { id: string; active: boolean; epoch: number };

/**
 * Üyelerin yetki alanları ham SQL ile: `Member.permissions` TEXT[] NULL (NULL = rolden türet, boş liste = izin yok); Prisma
 * liste alanında ikisini ayırmaz (şemada `String[]`), bu alan Prisma ile okunmaz.
 * Firma bağlamı (RLS) çağıranın: `withCompany` ya da istek bağlamı. `ids` verilmezse firmanın bütün üyeleri, açılış sırasıyla.
 */
export async function loadMemberAccess(companyId: string, ids?: readonly string[]): Promise<MemberAccessRow[]> {
  if (ids && ids.length === 0) return [];
  return ids
    ? prisma.$queryRaw<MemberAccessRow[]>`
        SELECT "id", "role", "permissions", "active", "epoch" FROM "Member"
        WHERE "companyId" = ${companyId} AND "id" = ANY(${[...ids]}::text[]) ORDER BY "createdAt", "id"`
    : prisma.$queryRaw<MemberAccessRow[]>`
        SELECT "id", "role", "permissions", "active", "epoch" FROM "Member"
        WHERE "companyId" = ${companyId} ORDER BY "createdAt", "id"`;
}

/** Kod rol adına bakmaz, izne bakar (ARCHITECTURE §1). */
export function can(req: FastifyRequest, permission: Permission): boolean {
  return req.auth.permissions.includes(permission);
}

/**
 * İzinlerden biri yetsin (ör. kendi ölçümünü gören çalışan ya da hepsini gören muhasebe). Tek izin için
 * `app.requirePermission`. `authenticate` READ_ONLY denetimini de yapar, firma bağlamını da açar.
 */
export function requireAny(app: FastifyInstance, permissions: readonly Permission[]): onRequestHookHandler[] {
  const gate: onRequestHookHandler = (req, reply, done) => {
    if (permissions.some((p) => req.auth.permissions.includes(p))) return done();
    void reply.status(403).send({
      error: { code: 'FORBIDDEN', message: errorMessage('FORBIDDEN', requestLocale(req)) },
    });
  };
  return [app.authenticate, gate];
}
