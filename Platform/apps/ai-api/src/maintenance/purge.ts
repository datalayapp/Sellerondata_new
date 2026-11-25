import { Prisma, type PrismaClient, type Tx } from '../db.ts';

/**
 * Günlük özet (`ai.AiSpendDaily`, UTC günü × firma × araç × amaç × model × sonuç × anahtar kaynağı) ve ayrıntılı satırların silinmesi.
 * Özetin bütün yazarları (bakım turu, saklama süresi, firma silme) aynı danışma kilidini alır: `ai:spend-daily`; firma silme önce
 * firma olay kilidini (`ai:org-events:<orgId>`) alır. Böylece iki yazar aynı grubu birbirinin eski görüntüsüyle ezmez.
 *
 * Kurallar:
 * - Özet satırı her zaman ayrıntılı satırlardan hesaplanır; `pending` satır sayılmaz (kapanınca bir sonraki turda girer).
 * - Kalıcı silinmiş firmanın (`Org.purgedAt`) ayrıntılı satırları yoktur: silme anında satırlar TEK ifadede silinip özete yazılır
 *   (`DELETE … RETURNING` → `INSERT … ON CONFLICT`); silinen ile özete giren aynı kümedir. İlk silmede grup değeri yeniden yazılır
 *   (`recompute`: önceki turların değeri o satırlardan zaten hesaplanmıştı), sonra kapanan artık satırlar (silme anında süren
 *   çağrı) eklenir (`add`). Bakım turu silinmiş firmaya `recompute` yazmaz.
 * - Saklama süresi (`AI_LEDGER_RETENTION_MONTHS`) dolan ayrıntılı satırlar aynı biçimde (UTC gün sınırında, bütün gün birden) silinir.
 */

export const SPEND_DAILY_LOCK = 'ai:spend-daily';

export type DailyMode = 'recompute' | 'add';

const COLUMNS = Prisma.raw(
  `"day", "orgId", "product", "purpose", "model", "status", "keySource", "calls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputImages", "costMicroUsd"`,
);

/** `src` takma adlı satır kümesinin gruplanmış hâli (ayrıntılı satır sütunlarıyla). */
const AGGREGATE = Prisma.raw(`
  SELECT src."startedAt"::date, src."orgId", src."product", src."purpose", COALESCE(src."servedModel", src."requestedModel"), src."status",
    src."keySource", COUNT(*)::int, SUM(src."inputTokens")::bigint, SUM(src."outputTokens")::bigint, SUM(src."cacheReadTokens")::bigint,
    SUM(src."cacheWrite5mTokens")::bigint, SUM(src."cacheWrite1hTokens")::bigint, SUM(src."outputImages")::bigint, SUM(src."costMicroUsd")::bigint
  FROM src
  GROUP BY 1, 2, 3, 4, 5, 6, 7`);

const CONFLICT = Prisma.raw(`ON CONFLICT ("day", "orgId", "product", "purpose", "model", "status", "keySource")`);

const FIELDS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'outputImages', 'costMicroUsd'];
const SET_RECOMPUTE = Prisma.raw(`DO UPDATE SET ${FIELDS.map((f) => `"${f}" = EXCLUDED."${f}"`).join(', ')}`);
const SET_ADD = Prisma.raw(`DO UPDATE SET ${FIELDS.map((f) => `"${f}" = d."${f}" + EXCLUDED."${f}"`).join(', ')}`);

export async function lockDaily(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SPEND_DAILY_LOCK}, 0))`;
}

/**
 * Firmanın kapanmış ayrıntılı satırlarını tek ifadede siler ve özete yazar. Çağıran firma olay kilidini tutmalı (işlem içinde);
 * özet kilidini bu işlev alır. Silinen satır sayısı.
 */
export async function moveOrgDetailsToDaily(tx: Tx, orgId: string, mode: DailyMode): Promise<number> {
  await lockDaily(tx);
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    WITH src AS (DELETE FROM ai."AiCall" WHERE "orgId" = ${orgId} AND "status" <> 'pending' RETURNING *),
    ins AS (
      INSERT INTO ai."AiSpendDaily" AS d (${COLUMNS}) ${AGGREGATE}
      ${CONFLICT} ${mode === 'recompute' ? SET_RECOMPUTE : SET_ADD}
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM src)::bigint AS n, (SELECT COUNT(*) FROM ins) AS _ins`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Silinmiş firmalarda silme anında süren (sonra kapanan) satırları özete ekleyip siler. Taşınan satır sayısı.
 */
export async function sweepPurgedOrgs(prisma: PrismaClient): Promise<number> {
  const orgs = await prisma.$queryRaw<{ orgId: string }[]>`
    SELECT DISTINCT c."orgId" FROM ai."AiCall" c JOIN ai."Org" o ON o."id" = c."orgId"
    WHERE o."purgedAt" IS NOT NULL AND c."status" <> 'pending'`;
  let moved = 0;
  for (const { orgId } of orgs) {
    moved += await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:org-events:${orgId}`}, 0))`;
      const org = await tx.org.findUnique({ where: { id: orgId }, select: { purgedAt: true } });
      if (!org?.purgedAt) return 0;
      return moveOrgDetailsToDaily(tx, orgId, 'add');
    });
  }
  return moved;
}

/**
 * [`start`, `end`) aralığında açılmış kapanmış satırlardan özeti yeniden hesaplar (silinmemiş firmalar). Yazılan grup sayısı.
 */
export async function rollupRange(tx: Tx, start: Date, end: Date): Promise<number> {
  await lockDaily(tx);
  return tx.$executeRaw`
    WITH src AS (
      SELECT c.* FROM ai."AiCall" c
      WHERE c."status" <> 'pending' AND c."startedAt" >= ${start} AND c."startedAt" < ${end}
        AND NOT EXISTS (SELECT 1 FROM ai."Org" o WHERE o."id" = c."orgId" AND o."purgedAt" IS NOT NULL)
    )
    INSERT INTO ai."AiSpendDaily" AS d (${COLUMNS}) ${AGGREGATE}
    ${CONFLICT} ${SET_RECOMPUTE}`;
}

/**
 * Saklama süresi: `cutoff`'tan (UTC gün başı) önce açılmış kapanmış satırlar özete yazılır ve silinir, tek ifadede (silinmemiş
 * firmalar; silinmiş firmanın artık satırını `sweepPurgedOrgs` taşır). Gün bütün olarak silindiği için grup değeri yeniden yazılır.
 * Silinen satır sayısı.
 */
export async function expireDetails(tx: Tx, cutoff: Date): Promise<number> {
  await lockDaily(tx);
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    WITH src AS (
      DELETE FROM ai."AiCall" c
      WHERE c."status" <> 'pending' AND c."startedAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM ai."Org" o WHERE o."id" = c."orgId" AND o."purgedAt" IS NOT NULL)
      RETURNING c.*
    ),
    ins AS (
      INSERT INTO ai."AiSpendDaily" AS d (${COLUMNS}) ${AGGREGATE}
      ${CONFLICT} ${SET_RECOMPUTE}
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM src)::bigint AS n, (SELECT COUNT(*) FROM ins) AS _ins`;
  return Number(rows[0]?.n ?? 0);
}
