/**
 * Aynı takip numarasına ölçüm yazanların kilitleri: ölçüm ucu (kayıt, düzeltme, geri yükleme) ve örnek ölçüm yazımı
 * (`services/companyData.ts`) aynı sıraya girer.
 */
import type { Tx } from '../db.ts';

/**
 * Aynı takip numarasına yazanlar sıraya girer: yeniden ölçüm, düzeltme, geri yükleme. Kilit işlem bitince kendiliğinden kalkar.
 * Asıl sınır kısmi tekil dizindir (Measurement_current_tracking_key); kilit, yarışanın hata almadan zincire eklenmesini sağlar.
 */
export async function lockTracking(tx: Tx, companyId: string, trackingNos: string[]) {
  // Sabit sıra: iki numarayı birden kilitleyen düzeltmeler kilitlenmesin.
  for (const t of [...new Set(trackingNos)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`measurement:${companyId}:${t}`}, 0))`;
  }
}

/** Bu numaranın güncel sürümü, satır kilidiyle: eşzamanlı silme ya da düzeltme araya giremez. */
export async function lockCurrent(tx: Tx, companyId: string, trackingNo: string) {
  const rows = await tx.$queryRaw<{ id: string; version: number; measuredAt: Date; createdAt: Date }[]>`
    SELECT "id", "version", "measuredAt", "createdAt" FROM "Measurement"
    WHERE "companyId" = ${companyId} AND "trackingNo" = ${trackingNo} AND "supersededById" IS NULL AND "deletedAt" IS NULL
    FOR UPDATE`;
  return rows[0] ?? null;
}
