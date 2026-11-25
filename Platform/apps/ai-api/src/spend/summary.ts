import {
  AI_SPEND_KPI,
  AI_SPEND_MEMBER_NONE,
  AI_SPEND_PRODUCT,
  AI_SPEND_SECTIONS,
  AI_SPEND_WIDGETS,
  AI_CALL_STATUSES,
  PRODUCTS,
  aiPriceFor,
  aiProductKeys,
  aiPurposeLabel,
  type AiSpendSummary,
  type HubFilterDef,
  type HubKpi,
  type HubSection,
  type HubWidget,
  type ProductKey,
} from '@sellerondata/contracts';
import { Prisma, type PrismaClient } from '../db.ts';
import { orgUsage } from '../limits/usage.ts';
import { amountOf, type DayWindow, type SpendContext } from './query.ts';

/**
 * `GET /api/ai/spend/summary` → `HubAnalytics` (sözleşme `AiSpendSummary`).
 *
 * Kaynak: defter (`ai.AiCall`, `pending` hariç). Platform görünümünde kalıcı silinmiş firmaların günlük özeti (`ai.AiSpendDaily`) de
 * eklenir: o firmaların ayrıntılı satırı yoktur (silmede özete taşındı, `maintenance/purge.ts`), çift sayım olmaz. Firma görünümü
 * yalnız kendi firmasının satırlarını okur (firma kimliği jetondan). Günler firma görünümünde firmanın saat diliminde, platformda UTC
 * (günlük özet de UTC günüdür).
 * Tek sorgu, `GROUPING SETS` ile bütün kırılımlar (gün × araç, sonuç, araç, amaç, model, kişi ya da firma, toplam).
 */

type Group = 'daily' | 'status' | 'product' | 'purpose' | 'model' | 'who' | 'total';

type AggRow = {
  g: Group;
  day: string | null;
  product: string | null;
  purpose: string | null;
  model: string | null;
  status: string | null;
  who: string | null;
  calls: bigint;
  input: bigint;
  output: bigint;
  cache_read: bigint;
  cache_write: bigint;
  cost: bigint;
};

type Agg = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

const n = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Defter satırının süzgeçleri (`c` takma adı). Firma kimliği firma görünümünde jetondan, platformda `org` süzgecinden. */
function callConditions(ctx: SpendContext, w: DayWindow, opts: { includePending?: boolean } = {}): Prisma.Sql[] {
  const f = ctx.filters;
  const parts: Prisma.Sql[] = [Prisma.sql`c."startedAt" >= ${w.start}`, Prisma.sql`c."startedAt" < ${w.end}`];
  if (!opts.includePending) parts.push(Prisma.sql`c."status" <> 'pending'`);
  if (ctx.orgId) parts.push(Prisma.sql`c."orgId" = ${ctx.orgId}`);
  if (f.product) parts.push(Prisma.sql`c."product" = ${f.product}`);
  if (f.purpose) parts.push(Prisma.sql`c."purpose" = ${f.purpose}`);
  if (f.status) parts.push(Prisma.sql`c."status" = ${f.status}`);
  if (f.model) parts.push(Prisma.sql`COALESCE(c."servedModel", c."requestedModel") = ${f.model}`);
  if (f.member === AI_SPEND_MEMBER_NONE) parts.push(Prisma.sql`c."memberId" IS NULL`);
  else if (f.member) parts.push(Prisma.sql`c."memberId" = ${f.member}`);
  return parts;
}

/** Normalize satır kaynağı: defter (+ platformda silinmiş firmaların günlük özeti). */
function sourceSql(ctx: SpendContext, w: DayWindow): Prisma.Sql {
  const platform = ctx.scope === 'platform';
  const dayExpr = platform ? Prisma.sql`c."startedAt"::date` : Prisma.sql`((c."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ctx.timeZone})::date`;
  const whoExpr = platform ? Prisma.sql`c."orgId"` : Prisma.sql`c."memberId"`;
  const calls = Prisma.sql`
    SELECT ${dayExpr} AS day, c."product", c."purpose", COALESCE(c."servedModel", c."requestedModel") AS model, c."status",
      ${whoExpr} AS who, 1::bigint AS calls, c."inputTokens"::bigint AS input, c."outputTokens"::bigint AS output,
      c."cacheReadTokens"::bigint AS cache_read, (c."cacheWrite5mTokens" + c."cacheWrite1hTokens")::bigint AS cache_write,
      c."costMicroUsd" AS cost
    FROM ai."AiCall" c
    WHERE ${Prisma.join(callConditions(ctx, w), ' AND ')}`;
  if (!platform) return calls;
  const f = ctx.filters;
  const dc: Prisma.Sql[] = [
    Prisma.sql`d."day" >= ${w.from}::date`,
    Prisma.sql`d."day" <= ${w.to}::date`,
    Prisma.sql`EXISTS (SELECT 1 FROM ai."Org" o WHERE o."id" = d."orgId" AND o."purgedAt" IS NOT NULL)`,
  ];
  if (ctx.orgId) dc.push(Prisma.sql`d."orgId" = ${ctx.orgId}`);
  if (f.product) dc.push(Prisma.sql`d."product" = ${f.product}`);
  if (f.purpose) dc.push(Prisma.sql`d."purpose" = ${f.purpose}`);
  if (f.status) dc.push(Prisma.sql`d."status" = ${f.status}`);
  if (f.model) dc.push(Prisma.sql`d."model" = ${f.model}`);
  return Prisma.sql`${calls}
    UNION ALL
    SELECT d."day", d."product", d."purpose", d."model", d."status", d."orgId" AS who, d."calls"::bigint, d."inputTokens", d."outputTokens",
      d."cacheReadTokens", (d."cacheWrite5mTokens" + d."cacheWrite1hTokens"), d."costMicroUsd"
    FROM ai."AiSpendDaily" d
    WHERE ${Prisma.join(dc, ' AND ')}`;
}

async function aggregate(prisma: PrismaClient, ctx: SpendContext): Promise<AggRow[]> {
  return prisma.$queryRaw<AggRow[]>`
    WITH src AS (${sourceSql(ctx, ctx.window)})
    SELECT
      CASE
        WHEN GROUPING(day) = 0 THEN 'daily'
        WHEN GROUPING(status) = 0 THEN 'status'
        WHEN GROUPING(product) = 0 THEN 'product'
        WHEN GROUPING(purpose) = 0 THEN 'purpose'
        WHEN GROUPING(model) = 0 THEN 'model'
        WHEN GROUPING(who) = 0 THEN 'who'
        ELSE 'total'
      END AS g,
      day::text AS day, product, purpose, model, status, who,
      COALESCE(SUM(calls), 0)::bigint AS calls, COALESCE(SUM(input), 0)::bigint AS input, COALESCE(SUM(output), 0)::bigint AS output,
      COALESCE(SUM(cache_read), 0)::bigint AS cache_read, COALESCE(SUM(cache_write), 0)::bigint AS cache_write,
      COALESCE(SUM(cost), 0)::bigint AS cost
    FROM src
    GROUP BY GROUPING SETS ((day, product), (status), (product), (purpose), (model), (who), ())`;
}

async function previousCost(prisma: PrismaClient, ctx: SpendContext): Promise<number> {
  const rows = await prisma.$queryRaw<{ cost: bigint }[]>`
    WITH src AS (${sourceSql(ctx, ctx.previous)}) SELECT COALESCE(SUM(cost), 0)::bigint AS cost FROM src`;
  return n(rows[0]?.cost);
}

function agg(r: AggRow | undefined): Agg {
  return { calls: n(r?.calls), input: n(r?.input), output: n(r?.output), cacheRead: n(r?.cache_read), cacheWrite: n(r?.cache_write), cost: n(r?.cost) };
}

const share = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/** Önbellekten okumanın girdi fiyatına göre tasarrufu (mikro USD): model başına okunan × (girdi − okuma fiyatı). Kademe yok sayılır [V]. */
function cacheSavingsMicroUsd(models: AggRow[]): number {
  let total = 0;
  for (const r of models) {
    const read = n(r.cache_read);
    if (!r.model || read <= 0) continue;
    const { price } = aiPriceFor(r.model);
    total += read * Math.max(0, price.input - price.cacheRead);
  }
  return Math.round(total);
}

/** Araçtaki ayrıntı sayfası (sözleşme: DeciShip). */
const PRODUCT_HREF: Partial<Record<ProductKey, string>> = { deciship: '/account/billing/ai/deciship' };

const productName = (key: string) => (PRODUCTS as Record<string, { name: string } | undefined>)[key]?.name ?? key;

export async function buildSpendSummary(prisma: PrismaClient, ctx: SpendContext, now = new Date()): Promise<AiSpendSummary> {
  const { t, currency, rate } = ctx;
  const platform = ctx.scope === 'platform';
  const [rows, prevCost] = await Promise.all([aggregate(prisma, ctx), previousCost(prisma, ctx)]);
  const by = (g: Group) => rows.filter((r) => r.g === g);
  const total = agg(by('total')[0]);
  const money = (micro: number) => amountOf(micro, currency, rate);

  // ---------- KPI ----------
  const statusCount = new Map(by('status').map((r) => [r.status ?? '', n(r.calls)]));
  const failed = (statusCount.get('failed') ?? 0) + (statusCount.get('interrupted') ?? 0) + (statusCount.get('rejected') ?? 0);
  const kpis: HubKpi[] = [];
  for (const id of AI_SPEND_KPI) {
    if (id === 'spend') {
      kpis.push({ id, label: t('kpi.spend'), value: money(total.cost), format: 'money', currency, previous: money(prevCost), goodDirection: 'down' });
    } else if (id === 'spend_usd') {
      if (platform)
        kpis.push({
          id,
          label: t('kpi.spend_usd'),
          value: amountOf(total.cost, 'USD', rate),
          format: 'money',
          currency: 'USD',
          previous: amountOf(prevCost, 'USD', rate),
          goodDirection: 'down',
        });
    } else if (id === 'calls') {
      kpis.push({
        id,
        label: t('kpi.calls'),
        value: total.calls,
        format: 'number',
        hint: t('kpi.calls.hint', { ok: statusCount.get('ok') ?? 0, failed, cancelled: statusCount.get('cancelled') ?? 0 }),
        goodDirection: 'none',
      });
    } else if (id === 'tokens') {
      kpis.push({
        id,
        label: t('kpi.tokens'),
        value: total.input + total.output + total.cacheRead + total.cacheWrite,
        format: 'number',
        goodDirection: 'none',
      });
    } else if (id === 'cache_savings') {
      kpis.push({ id, label: t('kpi.cache_savings'), value: money(cacheSavingsMicroUsd(by('model'))), format: 'money', currency, goodDirection: 'up' });
    } else if (id === 'cap_used') {
      if (!ctx.orgId) continue;
      // Hak bu aya ait (seçili aralıktan bağımsız), bütün araçlar için tek; araç seçimi hakkı etkilemez.
      const usage = await orgUsage(prisma, ctx.orgId, aiProductKeys()[0]!, now);
      const cap = usage.org.cap;
      const pct = cap > 0 ? Math.round((usage.org.used / cap) * 1000) / 10 : usage.org.used > 0 ? 100 : 0;
      kpis.push({
        id,
        label: t('kpi.cap_used'),
        hint: t('kpi.cap_used.hint'),
        value: pct,
        format: 'percent',
        tone: pct >= 100 ? 'bad' : pct >= 80 ? 'warning' : 'neutral',
        goodDirection: 'down',
      });
    }
  }

  // ---------- Günlük ----------
  const dailyRows = by('daily');
  const dailyProducts = [...new Set(dailyRows.map((r) => r.product ?? ''))].filter(Boolean);
  const order = aiProductKeys() as string[];
  dailyProducts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const daily: HubWidget = {
    kind: 'timeseries',
    id: AI_SPEND_WIDGETS.daily,
    title: t('widget.daily'),
    chart: 'bar',
    format: 'money',
    currency,
    series: dailyProducts.map((p) => {
      const perDay = new Map(dailyRows.filter((r) => r.product === p).map((r) => [r.day ?? '', n(r.cost)]));
      return { id: p, label: productName(p), points: ctx.window.days.map((d) => ({ x: d, y: money(perDay.get(d) ?? 0) })) };
    }),
  };

  const statusOrder = AI_CALL_STATUSES as readonly string[];
  const byStatus: HubWidget = {
    kind: 'breakdown',
    id: AI_SPEND_WIDGETS.byStatus,
    title: t('widget.byStatus'),
    format: 'number',
    items: by('status')
      .map((r) => ({
        key: r.status ?? '',
        label: t(`status.${r.status}` as Parameters<typeof t>[0]),
        value: n(r.calls),
        share: share(n(r.calls), total.calls),
      }))
      .sort((a, b) => statusOrder.indexOf(a.key) - statusOrder.indexOf(b.key)),
  };

  const moneyBreakdown = (id: string, title: string, items: { key: string; label: string; cost: number; href?: string }[]): HubWidget => ({
    kind: 'breakdown',
    id,
    title,
    format: 'money',
    currency,
    items: items
      .sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
      .map((i) => ({ key: i.key, label: i.label, value: money(i.cost), share: share(i.cost, total.cost), ...(i.href ? { href: i.href } : {}) })),
  });

  const byProduct = moneyBreakdown(
    AI_SPEND_WIDGETS.byProduct,
    t('widget.byProduct'),
    by('product').map((r) => ({ key: r.product ?? '', label: productName(r.product ?? ''), cost: n(r.cost), href: PRODUCT_HREF[r.product as ProductKey] })),
  );
  const byPurpose = moneyBreakdown(
    AI_SPEND_WIDGETS.byPurpose,
    t('widget.byPurpose'),
    by('purpose').map((r) => ({ key: r.purpose ?? '', label: aiPurposeLabel(r.purpose ?? '', ctx.locale), cost: n(r.cost) })),
  );
  const modelRows = by('model');
  const byModel = moneyBreakdown(
    AI_SPEND_WIDGETS.byModel,
    t('widget.byModel'),
    modelRows.map((r) => ({ key: r.model ?? '', label: r.model ?? '', cost: n(r.cost) })),
  );

  const whoRows = by('who');
  let orgNames = new Map<string, string | null>();
  if (platform && whoRows.length) {
    const ids = whoRows.map((r) => r.who).filter((x): x is string => !!x);
    const orgs = await prisma.org.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    orgNames = new Map(orgs.map((o) => [o.id, o.name]));
  }
  const who: HubWidget = platform
    ? moneyBreakdown(
        AI_SPEND_WIDGETS.byOrg,
        t('widget.byOrg'),
        whoRows.map((r) => ({ key: r.who ?? '', label: orgNames.get(r.who ?? '') ?? '', cost: n(r.cost) })),
      )
    : moneyBreakdown(
        AI_SPEND_WIDGETS.byMember,
        t('widget.byMember'),
        whoRows.map((r) => ({ key: r.who ?? AI_SPEND_MEMBER_NONE, label: '', cost: n(r.cost) })),
      );

  const sections: HubSection[] = [
    { id: AI_SPEND_SECTIONS.overview, title: t('section.overview'), widgets: [{ kind: 'kpis', id: AI_SPEND_WIDGETS.kpis, items: kpis }, daily, byStatus] },
    { id: AI_SPEND_SECTIONS.products, title: t('section.products'), widgets: [byProduct] },
    { id: AI_SPEND_SECTIONS.purposes, title: t('section.purposes'), widgets: [byPurpose] },
    { id: AI_SPEND_SECTIONS.models, title: t('section.models'), widgets: [byModel] },
    platform
      ? { id: AI_SPEND_SECTIONS.orgs, title: t('section.orgs'), widgets: [who] }
      : { id: AI_SPEND_SECTIONS.members, title: t('section.members'), widgets: [who] },
  ];

  // ---------- Süzgeçler ----------
  const products = aiProductKeys().filter((p) => !ctx.filters.product || p === ctx.filters.product);
  const purposeOptions = products.flatMap((p) =>
    Object.keys(PRODUCTS[p].ai?.purposes ?? {}).map((key) => ({ value: key, label: aiPurposeLabel(key, ctx.locale) })),
  );
  const modelSet = new Set<string>([...products.flatMap((p) => [...(PRODUCTS[p].ai?.models ?? [])]), ...modelRows.map((r) => r.model ?? '').filter(Boolean)]);
  const filters: HubFilterDef[] = [
    { id: 'product', kind: 'select', label: t('filter.product'), options: aiProductKeys().map((p) => ({ value: p, label: productName(p) })) },
    { id: 'purpose', kind: 'select', label: t('filter.purpose'), options: purposeOptions },
    { id: 'model', kind: 'select', label: t('filter.model'), options: [...modelSet].sort().map((m) => ({ value: m, label: m })) },
    {
      id: 'status',
      kind: 'select',
      label: t('filter.status'),
      options: statusOrder.filter((s) => s !== 'pending').map((s) => ({ value: s, label: t(`status.${s}` as Parameters<typeof t>[0]) })),
    },
  ];
  if (platform) {
    filters.push({
      id: 'org',
      kind: 'select',
      label: t('filter.org'),
      options: whoRows.filter((r) => r.who).map((r) => ({ value: r.who!, label: orgNames.get(r.who!) ?? '' })),
    });
  } else {
    // Kişi adları Merkez'de ekip listesinden çözülür (geçit ad tutmaz); seçenek yalnız kimlik, kişisiz satır etiketli.
    filters.push({
      id: 'member',
      kind: 'select',
      label: t('filter.member'),
      options: whoRows.map((r) => (r.who ? { value: r.who, label: '' } : { value: AI_SPEND_MEMBER_NONE, label: t('filter.member.none') })),
    });
  }

  return {
    product: AI_SPEND_PRODUCT,
    from: ctx.window.from,
    to: ctx.window.to,
    compare: { from: ctx.previous.from, to: ctx.previous.to },
    filters,
    sections,
  };
}
