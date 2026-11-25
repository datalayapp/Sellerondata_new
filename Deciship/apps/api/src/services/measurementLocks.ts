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

/**
 * FedEx Ground takip no'su (15 hane): `extractTracking` öncesi kaydedilmiş ölçümde aynı gönderi 22 haneli "96" barkoduyla
 * (96 + 2 SCNC + 3 hizmet + 15 takip no) durabilir. Önceki ölçüm aranırken o değer de aday sayılır; yoksa null.
 */
export function legacyFedex96Suffix(trackingNo: string): string | null {
  return /^\d{15}$/.test(trackingNo) ? trackingNo : null;
}

/**
 * Bu numaranın güncel sürümü, satır kilidiyle: eşzamanlı silme ya da düzeltme araya giremez. 15 haneli FedEx Ground numarası
 * için eski 22 haneli "96" kaydı da bulunur (`legacyFedex96Suffix`); ikisi birden varsa birebir eşleşen önce.
 */
export async function lockCurrent(tx: Tx, companyId: string, trackingNo: string) {
  const legacy = legacyFedex96Suffix(trackingNo);
  const rows = await tx.$queryRaw<{ id: string; version: number; measuredAt: Date; createdAt: Date; packaging: string }[]>`
    SELECT "id", "version", "measuredAt", "createdAt", "packaging"::text AS "packaging" FROM "Measurement"
    WHERE "companyId" = ${companyId} AND "supersededById" IS NULL AND "deletedAt" IS NULL
      AND ("trackingNo" = ${trackingNo}
        OR (${legacy}::text IS NOT NULL AND length("trackingNo") = 22 AND left("trackingNo", 2) = '96' AND right("trackingNo", 15) = ${legacy}::text))
    ORDER BY ("trackingNo" = ${trackingNo}) DESC, "measuredAt" DESC, "id"
    FOR UPDATE`;
  return rows[0] ?? null;
}
