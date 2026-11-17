/**
 * Merkez → Abonelik "Yapay zekâ kullanımı" kartı ve ayrıntılı döküm sayfasının üstü (`GET /platform/ai-usage`, contracts
 * `HubAiUsage`). Dönem firmanın saat dilimindeki takvim ayıdır; en çok 12 ay geri bakılır. Tutarlar mikro TL toplamından 2 haneye
 * yuvarlanır, "hak doldu" kararı sunucuda yuvarlanmamış değerle verilir (aiMeter `aiPeriodAllowance`).
 * Para alanları (`*Amount`, `byKind[].amount`, `byMember[].amount`, `previous.usedAmount`) fiyat izni olmayana gitmez: burada
 * çıkarılır, `app.ts` `stripMoney` ikinci güvencedir. `byMember` kişi adı taşır: uç zaten ayar iznine bağlı (`routes/platform.ts`).
 */
import { AI_CURRENCY, AI_PERIOD_PATTERN, aiMicrosToAmount, aiPeriodOf, type HubAiCallStatus, type HubAiUsage } from '@sellerondata/contracts';
import { prisma, withCompany } from '../../db.ts';
import { AI_KINDS, BILLABLE_STATUS, aiPeriodAllowance, aiPeriodBounds, aiTimeZone, aiUsedPct } from '../aiMeter.ts';
import { memberNames } from './members.ts';
import { P, hubError, type HubCtx } from './types.ts';

/** Geriye bakılabilecek en çok ay (bu ay hariç). */
export const AI_USAGE_MAX_MONTHS_BACK = 12;

const monthIndex = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return y * 12 + (m - 1);
};
const periodOfIndex = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

const microsOf = (d: { toString(): string } | null | undefined) => (d ? Math.round(Number(d.toString()) * 1_000_000) : 0);

/**
 * İstenen dönem (yoksa bu ay) ve firmanın saat dilimi. Biçim bozuksa, gelecekteyse ya da 12 aydan eskiyse 400 VALIDATION.
 * Özet ve ayrıntılı döküm (`aiCalls.ts`) aynı kuralı kullanır.
 */
export async function resolveAiPeriod(ctx: HubCtx, period?: string): Promise<{ period: string; current: string; timeZone: string }> {
  const timeZone = await aiTimeZone(ctx.companyId);
  const current = aiPeriodOf(ctx.now, timeZone);
  const p = period ?? current;
  if (!AI_PERIOD_PATTERN.test(p)) throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name: 'period' }));
  const back = monthIndex(current) - monthIndex(p);
  if (back < 0 || back > AI_USAGE_MAX_MONTHS_BACK) throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name: 'period' }));
  return { period: p, current, timeZone };
}

/** Sorgu değeri: yok ya da boşsa `undefined`; metin değilse 400. */
export function queryText(ctx: HubCtx, value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name }));
  return value;
}

/**
 * Satırın sonucu (contracts `HubAiCallStatus`). `OK` başarılı; ret `refused`; kesilme ya da çıktısı tahmin edilen kopuk akış
 * `truncated`; geri kalan hatalar `failed`. `CACHED` satırları bu sayıma girmez. Vazgeçilip kesilen çağrı (`AI_CANCELLED`,
 * KALANLAR 6.5) tahmini kullanımla yazılır ama kesilme değildir: `failed`.
 */
export function aiCallStatus(r: { status: string; errorCode: string | null; estimated: boolean }): HubAiCallStatus {
  if (r.status === BILLABLE_STATUS) return 'ok';
  if (r.errorCode === 'AI_CANCELLED') return 'failed';
  if (r.errorCode === 'AI_REFUSED') return 'refused';
  if (r.errorCode === 'AI_TRUNCATED' || r.estimated) return 'truncated';
  return 'failed';
}

/**
 * Seçilebilen en eski ay: 12 ay geri ile firmanın açıldığı ay arasından yenisi (bu aydan yeni olamaz). Firma bulunamazsa 12 ay geri.
 */
async function firstSelectablePeriod(companyId: string, current: string, timeZone: string): Promise<string> {
  const floor = monthIndex(current) - AI_USAGE_MAX_MONTHS_BACK;
  const company = await withCompany(companyId, () => prisma.company.findFirst({ where: { id: companyId }, select: { createdAt: true } }));
  const created = company ? monthIndex(aiPeriodOf(company.createdAt, timeZone)) : floor;
  return periodOfIndex(Math.min(monthIndex(current), Math.max(floor, created)));
}

export async function buildAiUsage(ctx: HubCtx, period?: string, limits: Record<string, unknown> = {}): Promise<HubAiUsage> {
  const { period: p, current, timeZone } = await resolveAiPeriod(ctx, period);

  const allowance = await aiPeriodAllowance(ctx.companyId, p, limits, timeZone);
  const where = { companyId: ctx.companyId, period: p };
  const tokenSum = { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, cost: true } as const;

  // Geçen ayın aynı süresi: bu ay seçiliyse geçen ayın başından bugünkü ana kadar (aynı geçen süre), değilse önceki ayın tamamı.
  const prevPeriod = periodOfIndex(monthIndex(p) - 1);
  const prevBounds = aiPeriodBounds(prevPeriod, timeZone);
  const prevTo = p === current ? new Date(Math.min(prevBounds.resetsAt.getTime(), prevBounds.start.getTime() + Math.max(0, ctx.now.getTime() - allowance.periodStart.getTime()))) : prevBounds.resetsAt;
  const firstPeriod = await firstSelectablePeriod(ctx.companyId, current, timeZone);
  const monthList: string[] = [];
  for (let i = monthIndex(current); i >= monthIndex(firstPeriod); i--) monthList.push(periodOfIndex(i));

  const { rows, memberRows, prevRows, monthRows } = await withCompany(ctx.companyId, async () => ({
    // `estimated` ve `errorCode` yalnız sayım için (Y60, sonuç dağılımı): satırlar toplamlara aynen girer.
    rows: await prisma.aiUsage.groupBy({ by: ['kind', 'status', 'estimated', 'errorCode'], where, _count: { _all: true }, _sum: { ...tokenSum, durationMs: true } }),
    memberRows: await prisma.aiUsage.groupBy({ by: ['memberId', 'status'], where, _count: { _all: true }, _sum: tokenSum }),
    prevRows: await prisma.aiUsage.groupBy({
      by: ['status'],
      where: { companyId: ctx.companyId, period: prevPeriod, status: { not: 'CACHED' }, createdAt: { lt: prevTo } },
      _count: { _all: true },
      _sum: tokenSum,
    }),
    monthRows: await prisma.aiUsage.groupBy({ by: ['period'], where: { companyId: ctx.companyId, period: { in: monthList }, status: { not: 'CACHED' } }, _count: { _all: true } }),
  }));

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let calls = 0;
  let cachedCalls = 0;
  let estimatedCalls = 0;
  let durationMs = 0;
  const statusCounts: Record<HubAiCallStatus, number> = { ok: 0, refused: 0, truncated: 0, failed: 0 };
  const kinds = new Map<string, { calls: number; tokens: number; micros: number; durationMs: number }>();
  for (const r of rows) {
    const k = kinds.get(r.kind) ?? { calls: 0, tokens: 0, micros: 0, durationMs: 0 };
    const input = r._sum.inputTokens ?? 0;
    const output = r._sum.outputTokens ?? 0;
    const cacheRead = r._sum.cacheReadTokens ?? 0;
    const cacheWrite = r._sum.cacheWriteTokens ?? 0;
    const sum = input + output + cacheRead + cacheWrite;
    tokens.input += input;
    tokens.output += output;
    tokens.cacheRead += cacheRead;
    tokens.cacheWrite += cacheWrite;
    tokens.total += sum;
    const d = r._sum.durationMs ?? 0;
    durationMs += d;
    if (r.status === 'CACHED') cachedCalls += r._count._all;
    else {
      calls += r._count._all;
      k.calls += r._count._all;
      if (r.estimated) estimatedCalls += r._count._all;
      statusCounts[aiCallStatus(r)] += r._count._all;
    }
    k.tokens += sum;
    // türün tutarı kotadan düşenlerdir (`OK`); sonuç vermeyen çağrı `calls` içinde görünür ama tutara girmez
    if (r.status === BILLABLE_STATUS) k.micros += microsOf(r._sum.cost);
    k.durationMs += d;
    kinds.set(r.kind, k);
  }

  // Y62-E5: kişi başına. Silinmiş kişinin satırları (`memberId` null) tek "bilinmiyor" satırında toplanır.
  const members = new Map<string | null, { calls: number; cachedCalls: number; tokens: number; micros: number }>();
  for (const r of memberRows) {
    const m = members.get(r.memberId) ?? { calls: 0, cachedCalls: 0, tokens: 0, micros: 0 };
    m.tokens += (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0) + (r._sum.cacheReadTokens ?? 0) + (r._sum.cacheWriteTokens ?? 0);
    if (r.status === 'CACHED') m.cachedCalls += r._count._all;
    else m.calls += r._count._all;
    if (r.status === BILLABLE_STATUS) m.micros += microsOf(r._sum.cost);
    members.set(r.memberId, m);
  }
  const names = await withCompany(ctx.companyId, () => memberNames(ctx.companyId, members.keys()));
  const unknown = ctx.t('aiUsage.member.unknown');
  const collator = new Intl.Collator(ctx.locale === 'en' ? 'en' : 'tr');
  // Sıra token, sonra işlem, sonra ad: tutara göre değil (fiyat izni olmayana maliyet sırası sızmasın).
  const byMember = [...members.entries()]
    .map(([memberId, m]) => ({ memberId, name: (memberId && names.get(memberId)) || unknown, calls: m.calls, cachedCalls: m.cachedCalls, tokens: m.tokens, amount: aiMicrosToAmount(m.micros) }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || collator.compare(a.name, b.name) || String(a.memberId).localeCompare(String(b.memberId)));

  const previous = { period: prevPeriod, from: prevBounds.start.toISOString(), to: prevTo.toISOString(), calls: 0, tokens: 0, usedAmount: 0 };
  let prevMicros = 0;
  for (const r of prevRows) {
    previous.calls += r._count._all;
    previous.tokens += (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0) + (r._sum.cacheReadTokens ?? 0) + (r._sum.cacheWriteTokens ?? 0);
    if (r.status === BILLABLE_STATUS) prevMicros += microsOf(r._sum.cost);
  }
  previous.usedAmount = aiMicrosToAmount(prevMicros);
  const monthCalls = new Map(monthRows.map((r) => [r.period, r._count._all]));

  const allowanceMicros = allowance.freeMicros + allowance.creditMicros;
  const allowanceAmount = aiMicrosToAmount(allowanceMicros);
  const usedAmount = aiMicrosToAmount(allowance.usedMicros);
  const out: HubAiUsage = {
    product: 'deciship',
    period: p,
    periodStart: allowance.periodStart.toISOString(),
    resetsAt: allowance.resetsAt.toISOString(),
    currency: AI_CURRENCY,
    enforced: allowance.enforced,
    freeAmount: aiMicrosToAmount(allowance.freeMicros),
    creditAmount: aiMicrosToAmount(allowance.creditMicros),
    allowanceAmount,
    usedAmount,
    // ekranda kullanılan + kalan = hak: yuvarlanmış değerlerden ("doldu" kararı yine yuvarlanmamış değerle, `exhausted`)
    remainingAmount: Math.max(0, Math.round((allowanceAmount - usedAmount) * 100) / 100),
    usedPct: aiUsedPct(allowance.usedMicros, allowanceMicros),
    exhausted: allowance.exhausted,
    tokens,
    calls,
    cachedCalls,
    durationMs,
    byKind: AI_KINDS.filter((kind) => kinds.has(kind)).map((kind) => {
      const k = kinds.get(kind)!;
      return { kind, label: ctx.t(`aiUsage.kind.${kind}`), calls: k.calls, tokens: k.tokens, amount: aiMicrosToAmount(k.micros), durationMs: k.durationMs };
    }),
    estimatedCalls,
    byMember,
    statusCounts,
    previous,
    months: monthList.map((period) => ({ period, calls: monthCalls.get(period) ?? 0 })),
    firstPeriod,
  };
  if (ctx.can(P.prices)) return out;
  // Fiyat izni yok: para alanları hiç gitmez (yüzde ve "doldu" kalır).
  const { freeAmount: _f, creditAmount: _c, allowanceAmount: _a, usedAmount: _u, remainingAmount: _r, ...rest } = out;
  const { usedAmount: _p, ...prevRest } = previous;
  return {
    ...rest,
    byKind: out.byKind.map(({ amount: _m, ...k }) => k),
    byMember: byMember.map(({ amount: _m, ...m }) => m),
    previous: prevRest,
  } as unknown as HubAiUsage;
}
