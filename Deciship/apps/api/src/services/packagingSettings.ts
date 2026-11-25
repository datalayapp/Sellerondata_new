import type { CarrierCode, PackagingLimits } from '@deciship/core';
import { prisma } from '../db.ts';
import { carrierCodeOf, effectivePackagingLimits } from '../lib/packaging.ts';

/** Mobilin ölçü ekranı için taşıyıcı poşeti / zarfı bilgisi (`GET /settings` → `packaging`). */
export type PackagingSettings = {
  /**
   * Barkoddan taşıyıcı bulunamazsa kullanılan taşıyıcı: varsayılan tarifesi olan etkin taşıyıcı (birden çoksa varsayılan
   * tarifesi en son güncellenen), yoksa tek etkin taşıyıcı, yoksa null.
   */
  primaryCarrier: CarrierCode | null;
  /** Etkin taşıyıcıların etkin sınırları, koda göre (aynı koddan iki taşıyıcı varsa ada göre ilki). */
  carriers: Partial<Record<CarrierCode, PackagingLimits>>;
};

export async function packagingSettings(companyId: string): Promise<PackagingSettings> {
  const rows = await prisma.carrier.findMany({
    where: { companyId, active: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      code: true,
      packagingLimits: true,
      tariffs: { where: { active: true, isDefault: true }, select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
  });
  const carriers: PackagingSettings['carriers'] = {};
  for (const c of rows) {
    const code = carrierCodeOf(c.code);
    if (!(code in carriers)) carriers[code] = effectivePackagingLimits(c);
  }
  const withDefault = rows
    .filter((c) => c.tariffs.length)
    .sort((a, b) => +b.tariffs[0]!.updatedAt - +a.tariffs[0]!.updatedAt);
  const primary = withDefault[0] ?? (rows.length === 1 ? rows[0] : undefined);
  return { primaryCarrier: primary ? carrierCodeOf(primary.code) : null, carriers };
}
