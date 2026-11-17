import { prisma } from '../../db.ts';
import { likeEscape } from '../../lib/util.ts';

/**
 * Kişi adlarına tek erişim noktası. Yalnız `id` ve `name` okunur (`measuredById`, `userId` Member.id'dir).
 */
export async function memberNames(companyId: string, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await prisma.member.findMany({ where: { companyId, id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Adında aranan metin geçen kişilerin id'leri (denetim kayıtlarında arama). */
export async function memberIdsByName(companyId: string, q: string): Promise<string[]> {
  const rows = await prisma.member.findMany({ where: { companyId, name: { contains: likeEscape(q), mode: 'insensitive' } }, select: { id: true } });
  return rows.map((r) => r.id);
}
