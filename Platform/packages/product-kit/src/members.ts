import { catalogPermissionsOf, effectivePermissions } from '@sellerondata/auth-kit';
import type { Permission, ProductEntry } from '@sellerondata/contracts';
import { sqlIdent, type SqlDb } from './db.ts';

/** Yerel üye kaydının yetkiyi belirleyen kısmı (`Member.role` + `Member.permissions`) ve askı/sıra alanları. */
export type MemberAccess = { id: string; role: string | null; permissions: readonly string[] | null; active: boolean; epoch: number };

/**
 * Üyelerin yetki alanları. `permissions` null (rolden türet) ile boş liste (izin yok) ayrı okunur. Firma bağlamında (`withOrg`)
 * çağrılır; `ids` verilmezse firmanın bütün üyeleri, açılış sırasıyla.
 */
export async function loadMemberAccess(tx: SqlDb, schema: string, orgId: string, ids?: readonly string[]): Promise<MemberAccess[]> {
  if (ids && ids.length === 0) return [];
  const s = sqlIdent(schema, 'schema');
  const cols = `"id", "role", "permissions", "active", "epoch"`;
  return ids
    ? tx.query<MemberAccess>(`SELECT ${cols} FROM ${s}."Member" WHERE "orgId" = $1 AND "id" = ANY($2::text[]) ORDER BY "createdAt", "id"`, [orgId, [...ids]])
    : tx.query<MemberAccess>(`SELECT ${cols} FROM ${s}."Member" WHERE "orgId" = $1 ORDER BY "createdAt", "id"`, [orgId]);
}

/**
 * Yerel üye kaydının geçerli izinleri; istekteki jetonla aynı kural (auth-kit `effectivePermissions`): izin listesi varsa katalogla
 * kesişimi (özel ya da düzenlenmiş hazır rol), null ise rolden türetilir, rol yoksa boş. İstek dışında yetki gereken yerler (imzalı
 * bağlantı, arka plan işi, bildirim alıcısı seçimi) rol adına değil buna bakar. Pasif üyede de liste döner: `active` ayrıca denetlenir.
 */
export function memberPermissions(
  definition: Pick<ProductEntry, 'roles'> & Partial<Pick<ProductEntry, 'permissions'>>,
  member: Pick<MemberAccess, 'role' | 'permissions'>,
): readonly Permission[] {
  return effectivePermissions(definition, member.role, member.permissions, catalogPermissionsOf(definition));
}
