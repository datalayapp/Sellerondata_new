import { isTariffSuspect } from '@deciship/core';
import { prisma } from '../db.ts';

/**
 * Tarife şüphesi (SPEC "Wiki'den eklenenler"): karşılaştırılan (Uyumlu + Fark var) satırların çoğunda fiyat farkı
 * varsa tarife yanlış ya da eski olabilir. Fatura ayrıntısı okunurken iki sayımla hesaplanır (saklanmaz); Y11: iki sayım
 * tek sorguda (`FILTER`).
 */
export async function tariffSuspect(invoiceId: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ compared: number; priceDiff: number }[]>`
    SELECT (count(*) FILTER (WHERE "status" IN ('MATCH', 'DIFF')))::int AS "compared",
      (count(*) FILTER (WHERE "status" = 'DIFF' AND 'PRICE' = ANY("diffTypes")))::int AS "priceDiff"
    FROM "InvoiceLine" WHERE "invoiceId" = ${invoiceId}`;
  return isTariffSuspect(row?.compared ?? 0, row?.priceDiff ?? 0);
}
