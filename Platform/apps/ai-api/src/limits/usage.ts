import { AI_MICROS_PER_UNIT, PRODUCTS, type ProductKey } from '@sellerondata/contracts';
import type { Tx } from '../db.ts';
import { env } from '../env.ts';
import { orgMonth, utcDay, utcMonth, type MonthWindow, type Window } from './periods.ts';

/**
 * Tavanların tutarları ve defterden harcanan / ayrılan toplamlar (mikro USD). Kabul (`admit`, kilit altında) ve okuma uçları
 * (`/internal/allowance`, `/internal/status`) aynı hesabı kullanır.
 *
 * - Harcanan: dönemde açılmış (`startedAt`), kapanmış satırların `costMicroUsd` toplamı (`rejected` 0'dır).
 * - Ayrılan: açık (`pending`) satırların `reservedMicroUsd` toplamı, açıldığı dönemden bağımsız (ay dönümünü aşan çağrı yeni ayın
 *   payında da durur: temkinli taraf).
 * - Yalnız platform anahtarıyla yapılan çağrılar (`keySource = 'platform'`) sayılır: firmanın kendi anahtarı (ileride) platformun
 *   parası değildir, hakka ve tavanlara girmez [V].
 * - Tavan kaynakları: platform `PlatformLimits` (null: `AI_PLATFORM_DAILY_USD` / `AI_PLATFORM_MONTHLY_USD`); firma hakkı
 *   `Org.capOverrideMicroUsd` (null ya da satır yok: `AI_ORG_MONTHLY_USD`); firma × araç `OrgProductCap.capMicroUsd` (satır yok ya
 *   da null: kayıttaki `ai.defaultCapUsd`; 0: o araçta yapay zekâ kapalı).
 */

export type Bucket = { cap: number | null; used: number; reserved: number };

export type PlatformUsage = {
  paused: boolean;
  day: Window & Bucket & { cap: number };
  month: MonthWindow & Bucket & { cap: number };
};

export type OrgUsage = {
  closed: boolean;
  timeZone: string | null;
  month: MonthWindow;
  org: Bucket & { cap: number };
  tool: Bucket & { product: ProductKey };
};

export const usdToMicro = (usd: number) => Math.round(usd * AI_MICROS_PER_UNIT);
const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Kayıttaki varsayılan firma × araç tavanı (mikro USD); kayıtta `ai` yoksa null. */
export function defaultToolCapMicroUsd(product: ProductKey): number | null {
  const usd = PRODUCTS[product]?.ai?.defaultCapUsd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usdToMicro(usd) : null;
}

/**
 * Toplam seçenekleri. `extraReserved`: satırı bulunamayan payı toplamlara ekler. `excludeIds`: payı sayılmayacak açık satırlar (bu
 * süreçte kabul kararı henüz verilmemiş ya da reddedilmiş çağrılar; `limits/index.ts`).
 */
export type UsageOptions = { extraReserved?: number; excludeIds?: readonly string[] };

export async function platformUsage(db: Tx, now: Date, opts: UsageOptions = {}): Promise<PlatformUsage> {
  const extraReserved = opts.extraReserved ?? 0;
  const exclude = [...(opts.excludeIds ?? [])];
  const day = utcDay(now);
  const month = utcMonth(now);
  const limits = await db.platformLimits.findUnique({ where: { id: 1 } });
  const defaults = env.limits;
  const rows = await db.$queryRaw<{ day_used: bigint; month_used: bigint; reserved: bigint }[]>`
    SELECT
      COALESCE(SUM("costMicroUsd") FILTER (WHERE "status" <> 'pending' AND "startedAt" >= ${day.start} AND "startedAt" < ${day.end}), 0)::bigint AS day_used,
      COALESCE(SUM("costMicroUsd") FILTER (WHERE "status" <> 'pending' AND "startedAt" >= ${month.start} AND "startedAt" < ${month.end}), 0)::bigint AS month_used,
      COALESCE(SUM("reservedMicroUsd") FILTER (WHERE "status" = 'pending' AND "id" <> ALL(${exclude}::uuid[])), 0)::bigint AS reserved
    FROM ai."AiCall"
    WHERE "keySource" = 'platform' AND ("status" = 'pending' OR ("startedAt" >= ${month.start} AND "startedAt" < ${month.end}))`;
  const r = rows[0];
  const reserved = num(r?.reserved) + extraReserved;
  return {
    paused: limits?.paused === true,
    day: { ...day, cap: limits?.dailyCapMicroUsd != null ? num(limits.dailyCapMicroUsd) : usdToMicro(defaults.platformDailyUsd), used: num(r?.day_used), reserved },
    month: { ...month, cap: limits?.monthlyCapMicroUsd != null ? num(limits.monthlyCapMicroUsd) : usdToMicro(defaults.platformMonthlyUsd), used: num(r?.month_used), reserved },
  };
}

export async function orgUsage(db: Tx, orgId: string, product: ProductKey, now: Date, opts: UsageOptions = {}): Promise<OrgUsage> {
  const extraReserved = opts.extraReserved ?? 0;
  const exclude = [...(opts.excludeIds ?? [])];
  // Sırayla: işlem içinde aynı bağlantı.
  const org = await db.org.findUnique({ where: { id: orgId }, select: { timeZone: true, closedAt: true, purgedAt: true, capOverrideMicroUsd: true } });
  const toolCap = await db.orgProductCap.findUnique({ where: { orgId_product: { orgId, product } }, select: { capMicroUsd: true } });
  const month = orgMonth(now, org?.timeZone);
  const rows = await db.$queryRaw<{ used: bigint; reserved: bigint; tool_used: bigint; tool_reserved: bigint }[]>`
    SELECT
      COALESCE(SUM("costMicroUsd") FILTER (WHERE "status" <> 'pending' AND "startedAt" >= ${month.start} AND "startedAt" < ${month.end}), 0)::bigint AS used,
      COALESCE(SUM("reservedMicroUsd") FILTER (WHERE "status" = 'pending' AND "id" <> ALL(${exclude}::uuid[])), 0)::bigint AS reserved,
      COALESCE(SUM("costMicroUsd") FILTER (WHERE "product" = ${product} AND "status" <> 'pending' AND "startedAt" >= ${month.start} AND "startedAt" < ${month.end}), 0)::bigint AS tool_used,
      COALESCE(SUM("reservedMicroUsd") FILTER (WHERE "product" = ${product} AND "status" = 'pending' AND "id" <> ALL(${exclude}::uuid[])), 0)::bigint AS tool_reserved
    FROM ai."AiCall"
    WHERE "orgId" = ${orgId} AND "keySource" = 'platform' AND ("status" = 'pending' OR ("startedAt" >= ${month.start} AND "startedAt" < ${month.end}))`;
  const r = rows[0];
  const orgCap = org?.capOverrideMicroUsd != null ? num(org.capOverrideMicroUsd) : usdToMicro(env.limits.orgMonthlyUsd);
  const tCap = toolCap?.capMicroUsd != null ? num(toolCap.capMicroUsd) : defaultToolCapMicroUsd(product);
  return {
    closed: !!(org?.closedAt || org?.purgedAt),
    timeZone: org?.timeZone ?? null,
    month,
    org: { cap: orgCap, used: num(r?.used), reserved: num(r?.reserved) + extraReserved },
    tool: { product, cap: tCap, used: num(r?.tool_used), reserved: num(r?.tool_reserved) + extraReserved },
  };
}

/** Platform durdu mu: yönetici durdurdu ya da günlük / aylık tavan harcananla doldu (`/internal/status`, hak). */
export function platformStopped(p: PlatformUsage): boolean {
  return p.paused || p.day.used >= p.day.cap || p.month.used >= p.month.cap;
}
