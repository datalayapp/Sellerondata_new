/**
 * K37 (Y26, kullanıcı kararı 2026-11-13): arka plandaki yeniden hesap `RECOMPARE_MAX_ATTEMPTS` (5) kez üst üste düşüp
 * taramadan çıktıysa fatura bunu gösterir ("Yeniden hesap yapılamadı" + "Yeniden karşılaştır"). İki kaynak:
 *  - faturanın kendi "Mükerrer" yeniden hesabı (`InvoiceRecheck.attempts` ≥ 5);
 *  - faturaya dokunan bir ölçüm değişikliğinin karşılaştırması (`Measurement.recompareAttempts` ≥ 5, işaret dolu). Ölçümün
 *    işareti tek faturaya ait değildir: o ölçümün takip numarasını (ya da zincirinin bir sürümünü) taşıyan her fatura uyarır.
 *    Eşleşme `recompareForTracking` ile aynı kural (ölçümün ve önceki sürümünün aday numaraları, son 10 karakter, satırın
 *    zincirdeki ölçüm kimliği).
 *
 * Sıcak yollar (fatura ayrıntısı, Merkez Genel Bakış) için sorgu sayısı sabittir: bitmiş ölçümler, sürümleri ve zincirleri
 * birer sorguyla okunur, satır eşleşmesi tek sorgudur (çok ölçüm birden düşse de; en çok `GAVE_UP_MAX` ölçüm okunur).
 *
 * Elle "Yeniden karşılaştır" (`POST /invoices/:id/recompare`) başarıyla bitince `clearFailedRecalc`: faturanın bitmiş
 * işareti silinir (hesap az önce yapıldı), faturaya dokunan bitmiş ölçüm işaretlerinin sayacı sıfırlanır (öbür faturalar
 * için tarama baştan dener; yine 5 kez düşerse uyarı geri gelir). Okumalar firma bağlamında (RLS).
 */
import { trackingCandidates } from '@deciship/core';
import { prisma, Prisma } from '../db.ts';
import { RECOMPARE_MAX_ATTEMPTS } from './maintenance.ts';

/** Bir okumada en çok bu kadar bitmiş ölçüm (sistem çapında bir arızada sıcak yol uzamasın; fazlası sonraki okumada). */
export const GAVE_UP_MAX = 500;

type GaveUpMeasurement = { id: string; recomparePendingAt: Date | null };

/** Firmanın denemesi bitmiş ölçüm işaretleri (seyrek: dizinli `recomparePendingAt` üzerinden). */
async function gaveUpMeasurements(companyId: string): Promise<GaveUpMeasurement[]> {
  return prisma.measurement.findMany({
    where: { companyId, recomparePendingAt: { not: null }, recompareAttempts: { gte: RECOMPARE_MAX_ATTEMPTS } },
    select: { id: true, recomparePendingAt: true },
    orderBy: { recomparePendingAt: 'asc' },
    take: GAVE_UP_MAX,
  });
}

/**
 * Ölçümlerin dokunduğu (silinmemiş) faturalar, sabit sayıda sorguyla; `within` verilirse yalnız onlar arasından. Takip
 * numaraları ölçümün ve bir önceki sürümünün (`settleMeasurementRecompares` ile aynı), kimlikler zincirin bütün sürümleri.
 */
async function invoicesOfMeasurements(companyId: string, ids: string[], within: string[] | null): Promise<string[]> {
  if (!ids.length) return [];
  const versions = await prisma.measurement.findMany({
    where: { companyId, OR: [{ id: { in: ids } }, { supersededById: { in: ids } }] },
    select: { trackingNo: true, trackingRaw: true },
  });
  const candidates = [...new Set(versions.flatMap((v) => [v.trackingNo, v.trackingRaw]).flatMap((t) => trackingCandidates(t)))];
  const suffixes = [...new Set(candidates.map((c) => c.slice(-10)).filter((c) => c.length >= 10))];
  // zincir: eski sürümler (supersededById ile geriye) ve yeni sürümler (ileriye), tek özyinelemeli sorgu (`measurementChainIds`)
  const chain = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE back AS (
      SELECT m."id" FROM "Measurement" m WHERE m."companyId" = ${companyId} AND m."id" = ANY(${ids}::text[])
      UNION
      SELECT p."id" FROM "Measurement" p JOIN back b ON p."supersededById" = b."id" WHERE p."companyId" = ${companyId}
    ), fwd AS (
      SELECT m."id", m."supersededById" FROM "Measurement" m WHERE m."companyId" = ${companyId} AND m."id" = ANY(${ids}::text[])
      UNION
      SELECT n."id", n."supersededById" FROM "Measurement" n JOIN fwd f ON n."id" = f."supersededById" WHERE n."companyId" = ${companyId}
    )
    SELECT "id" FROM back UNION SELECT "id" FROM fwd`;
  const chainIds = chain.map((c) => c.id);
  const scope = within ? Prisma.sql`AND l."invoiceId" = ANY(${within}::text[])` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ invoiceId: string }[]>`
    SELECT DISTINCT l."invoiceId" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE l."companyId" = ${companyId} AND i."deletedAt" IS NULL ${scope}
      AND (l."trackingNo" = ANY(${candidates}::text[])
        OR right(l."trackingNo", 10) = ANY(${suffixes}::text[])
        OR l."measurementId" = ANY(${chainIds}::text[]))`;
  return rows.map((r) => r.invoiceId);
}

/**
 * Yeniden hesabı bitmiş (5 kez düşmüş) faturalar. `invoiceIds` verilirse yalnız onlar arasından (fatura ayrıntısı); verilmezse
 * firmanın bütün silinmemiş faturaları (Merkez bekleyenleri).
 */
export async function failedRecalcInvoices(companyId: string, invoiceIds?: string[]): Promise<Set<string>> {
  const within = invoiceIds ?? null;
  if (within && !within.length) return new Set();
  // Olağan durumda (bitmiş işaret yok) tek sorgu: faturanın bitmiş işaretleri ve firmanın bitmiş ölçümleri birlikte
  const own = within ? Prisma.sql`AND r."invoiceId" = ANY(${within}::text[])` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ k: 'r' | 'm'; id: string }[]>`
    (SELECT 'r' AS k, r."invoiceId" AS id FROM "InvoiceRecheck" r JOIN "Invoice" i ON i."id" = r."invoiceId"
      WHERE r."companyId" = ${companyId} AND r."attempts" >= ${RECOMPARE_MAX_ATTEMPTS} AND i."deletedAt" IS NULL ${own})
    UNION ALL
    (SELECT 'm' AS k, m."id" AS id FROM "Measurement" m
      WHERE m."companyId" = ${companyId} AND m."recomparePendingAt" IS NOT NULL AND m."recompareAttempts" >= ${RECOMPARE_MAX_ATTEMPTS}
      ORDER BY m."recomparePendingAt" LIMIT ${GAVE_UP_MAX})`;
  const out = new Set(rows.filter((r) => r.k === 'r').map((r) => r.id));
  const gaveUp = rows.filter((r) => r.k === 'm').map((r) => r.id);
  for (const id of await invoicesOfMeasurements(companyId, gaveUp, within)) out.add(id);
  return out;
}

/**
 * Elle yeniden karşılaştırma başarıyla bittikten sonra (aynı fatura): faturanın bitmiş "Mükerrer" işareti silinir; faturaya
 * dokunan bitmiş ölçüm işaretlerinin sayacı sıfırlanır (işaret dolu kalır, tarama ~2 dk sonra baştan dener). İşaret bu arada
 * yeniden yazıldıysa (yeni değişiklik sayacı zaten sıfırlar) dokunulmaz: koşul sayacın hâlâ bitmiş olması ve aynı işaret.
 * Ölçüm başına ayrı eşleşme sorgusu: yalnız bu elle eylemde, bitmiş ölçüm varken. Uçlar önce `failedRecalcInvoices` ile
 * bakar, yalnız fatura uyarıyorsa çağırır (olağan yeniden hesapta tek ek sorgu, `test/recalcQueries.test.ts`).
 */
export async function clearFailedRecalc(companyId: string, invoiceId: string): Promise<void> {
  await prisma.invoiceRecheck.deleteMany({ where: { companyId, invoiceId, attempts: { gte: RECOMPARE_MAX_ATTEMPTS } } });
  const gaveUp = await gaveUpMeasurements(companyId);
  // önce toplu bakış: faturaya hiçbiri dokunmuyorsa ölçüm başına sorgu yok
  if (!gaveUp.length || !(await invoicesOfMeasurements(companyId, gaveUp.map((m) => m.id), [invoiceId])).length) return;
  for (const m of gaveUp) {
    if (!(await invoicesOfMeasurements(companyId, [m.id], [invoiceId])).length) continue;
    // ham SQL: ölçümün `updatedAt`'i değişmesin (sayaç ölçümün kendisi değildir; `recordRecompareFailure` ile aynı)
    await prisma.$executeRaw`
      UPDATE "Measurement" SET "recompareAttempts" = 0
      WHERE "id" = ${m.id} AND "companyId" = ${companyId} AND "recomparePendingAt" = ${m.recomparePendingAt}::timestamp(3)
        AND "recompareAttempts" >= ${RECOMPARE_MAX_ATTEMPTS}`;
  }
}
