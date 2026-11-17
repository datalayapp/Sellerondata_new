/**
 * Y65 (Mesaj 7 Ek E4): firma başına dosya alanı (`STORAGE_QUOTA_GB_PER_ORG`, varsayılan 10 GB, `0` kapalı;
 * `Platform/docs/KARARLAR.md`). Yalnız fatura ve tarife dosyası yüklemesi durur: fatura önizlemesi
 * (`POST /invoices/preview`), kurulum örnek faturası (`POST /invoices/samples`) ve tarife PDF'i (`handleUpload`).
 * Ölçüm fotoğrafı hiç durdurulmaz ve sayılmaz (çalışanın ölçümü reddedilmez).
 *
 * Sayılan: diskte duran (`purgedAt` boş) fatura kaynak dosyaları (önizleme ya da canlı faturanın dosyası) ve tarife PDF'leri
 * (`TariffDocument`, 7 gün sonra bakım siler). Sayılmayan: yalnız silinmiş faturaların gösterdiği dosya (30 gün sonra
 * diskten kalkar; karar: "silinen faturanın dosyası sayılmaz"), ölçüm fotoğrafı, temizlenmiş dosya.
 *
 * Toplam her yüklemede veritabanında `SUM(size)` ile alınır (firmanın dizinli satırları; disk taranmaz). Sınır yumuşaktır:
 * aynı anda gelen iki yükleme ikisi de denetimi geçebilir, aşım en çok o anda süren yüklemelerin toplamı kadardır.
 */
import { fmtNumber } from '@deciship/core';
import { prisma, withCompany } from '../db.ts';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { currentLocale, m } from '../i18n/index.ts';

/** 1 GB = 1024³ bayt. */
export const GB_BYTES = 1024 ** 3;

/** Kota bayt olarak; `gb` 0 ya da geçersizse null (kapalı). */
export function quotaBytes(gb: number): number | null {
  return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * GB_BYTES) : null;
}

/** Yükleme sığar mı: kullanılan + gelen ≤ kota. Kota kapalıysa her zaman sığar. */
export function fitsQuota(usedBytes: number, incomingBytes: number, limitBytes: number | null): boolean {
  return limitBytes === null || usedBytes + incomingBytes <= limitBytes;
}

/** Firmanın kotaya sayılan dosyalarının toplam boyutu (bayt). */
export async function countedStorageBytes(companyId: string): Promise<number> {
  const rows = await withCompany(companyId, () =>
    prisma.$queryRaw<{ files: number; documents: number }[]>`
      SELECT
        (SELECT COALESCE(SUM(f."size"), 0)::float8 FROM "File" f
          WHERE f."companyId" = ${companyId} AND f."kind" = 'INVOICE_SOURCE' AND f."purgedAt" IS NULL
            AND (
              NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."companyId" = ${companyId} AND i."sourceFileId" = f."id")
              OR EXISTS (SELECT 1 FROM "Invoice" i WHERE i."companyId" = ${companyId} AND i."sourceFileId" = f."id" AND i."deletedAt" IS NULL)
            )) AS "files",
        (SELECT COALESCE(SUM(d."size"), 0)::float8 FROM "TariffDocument" d WHERE d."companyId" = ${companyId}) AS "documents"`,
  );
  const r = rows[0];
  return Number(r?.files ?? 0) + Number(r?.documents ?? 0);
}

/** 413 `STORAGE_QUOTA_EXCEEDED`; `details.limitGb`. Metin isteğin dilinde. */
export function storageQuotaExceeded(limitGb: number): AppError {
  const locale = currentLocale();
  const limit = fmtNumber(limitGb, Number.isInteger(limitGb) ? 0 : 1, locale);
  return new AppError(413, 'STORAGE_QUOTA_EXCEEDED', m('err.storageQuotaExceeded', { limit }, locale), { limitGb });
}

/**
 * Yükleme başında: gelen dosya firmanın kotasını aşacaksa 413 `STORAGE_QUOTA_EXCEEDED` (dosya saklanmadan, okunmadan).
 * Kota kapalıysa (`0`) veritabanına gidilmez.
 */
export async function assertStorageQuota(companyId: string, incomingBytes: number): Promise<void> {
  const gb = env.storageQuotaGbPerOrg;
  const limit = quotaBytes(gb);
  if (limit === null) return;
  if (!fitsQuota(await countedStorageBytes(companyId), incomingBytes, limit)) throw storageQuotaExceeded(gb);
}

/** Merkez Abonelik kartı: bu yüzdeden sonra uyarı gösterilir. */
export const STORAGE_WARN_PCT = 80;

export type StorageUsage = { usedBytes: number; limitBytes: number | null; limitGb: number | null; usedPct: number | null; warn: boolean };

/** 06-B6: firmanın kotaya sayılan dosya alanı kullanımı. Kota kapalıysa (`0`) sınır, yüzde null; uyarı yok. */
export async function storageUsage(companyId: string): Promise<StorageUsage> {
  const gb = env.storageQuotaGbPerOrg;
  const limitBytes = quotaBytes(gb);
  const usedBytes = await countedStorageBytes(companyId);
  if (limitBytes === null) return { usedBytes, limitBytes: null, limitGb: null, usedPct: null, warn: false };
  const usedPct = Math.round((usedBytes / limitBytes) * 1000) / 10;
  return { usedBytes, limitBytes, limitGb: gb, usedPct, warn: usedPct >= STORAGE_WARN_PCT };
}
