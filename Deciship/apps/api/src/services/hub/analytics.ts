import { isTariffSuspect, normalizeTracking, tariffHealth, type HealthLineInput } from '@deciship/core';
import type { HubAnalytics, HubColumn, HubFilterDef, HubKpi, HubRow, HubSection, HubSeries, HubWidget } from '@sellerondata/contracts';
import { prisma } from '../../db.ts';
import { zonedDate } from '../../lib/time.ts';
import { countryName, type HubKey } from './i18n.ts';
import { memberNames } from './members.ts';
import { dataLink, deciship } from './links.ts';
import {
  DIM_METHODS,
  carrierTariffStatus,
  companySettings,
  coveragePct,
  healthRows,
  invoiceFacts,
  invoiceScope,
  lineDimensions,
  loadInvoices,
  measurementCounts,
  measurementDays,
  measurementScope,
  measurementsWithoutPhoto,
  operatorFacts,
  pct,
  primaryCurrency,
  round2,
  topOverchargeLines,
  type Dimensions,
  type LineFilter,
  type LineMeasures,
} from './metrics.ts';
import { bucketize, previousPeriod, type Period } from './period.ts';
import { P, hubError, type HubCtx } from './types.ts';

const TOP_N = 10;
const BREAKDOWN_N = 8;
const DEVIATION_ROWS = 15;

type Query = Record<string, unknown>;

export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]).filter(Boolean);

export const wantsCompare = (q: Query) => {
  const v = q.compare;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'none';
};

/** Tablo ve çubuk için en büyük N + "Diğer": kırılım toplamı her zaman bütüne eşittir. */
function breakdownItems<K>(
  ctx: HubCtx,
  entries: [K, number][],
  label: (k: K) => string,
  href: (k: K) => string | undefined,
  keyOf: (k: K) => string,
  limit = BREAKDOWN_N,
) {
  const positive = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || keyOf(a[0]).localeCompare(keyOf(b[0])));
  const total = positive.reduce((a, [, v]) => a + v, 0);
  const shown = positive.slice(0, limit);
  const rest = positive.slice(limit).reduce((a, [, v]) => a + v, 0);
  const items = shown.map(([k, value]) => {
    const h = href(k);
    return { key: keyOf(k), label: label(k), value: round2(value), share: pct(value, total) ?? 0, ...(h ? { href: h } : {}) };
  });
  if (rest > 0) items.push({ key: '_other', label: ctx.t('common.other'), value: round2(rest), share: pct(rest, total) ?? 0 });
  return items;
}

function emptyWidget(ctx: HubCtx, id: string, title: HubKey, body: HubKey, extra: { href?: string; actionLabel?: string } = {}): HubWidget {
  return { kind: 'empty', id, title: ctx.t(title), body: ctx.t(body), ...extra };
}

/** `previous` yalnız karşılaştırma açıksa. Sözleşmedeki "önceki dönem" alanı. */
const withPrev = (kpi: HubKpi, prev: number | null | undefined, compare: boolean): HubKpi => (compare ? { ...kpi, previous: prev ?? null } : kpi);

export async function buildAnalytics(ctx: HubCtx, p: Period, query: Query): Promise<HubAnalytics> {
  const { companyId, t } = ctx;
  const money = ctx.can(P.prices);
  const compare = wantsCompare(query);
  const prev = previousPeriod(p);
  const today = zonedDate(ctx.now, (await companySettings(companyId)).timeZone);

  const carrierIds = asList(query['filter.carrier']);
  const service = asList(query['filter.service'])[0];
  const countryRaw = asList(query['filter.country'])[0]?.trim().toUpperCase();
  const trackingRaw = asList(query['filter.tracking'])[0];
  const tracking = trackingRaw ? normalizeTracking(trackingRaw) : undefined;
  const currencyRaw = asList(query['filter.currency'])[0]?.toUpperCase();
  if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) throw hubError(400, 'VALIDATION', t('err.filter', { name: 'currency' }));
  const baseFilter: LineFilter = { carrierIds, service, country: countryRaw, tracking };
  const narrowed = Boolean(carrierIds.length || service || countryRaw || tracking);

  const [settings, carriers, invoices, services, everInvoice, everMeasurement] = await Promise.all([
    companySettings(companyId),
    prisma.carrier.findMany({ where: { companyId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    loadInvoices(companyId, p),
    prisma.$queryRaw<{ service: string }[]>`
      SELECT DISTINCT l."service" AS "service" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE l."companyId" = ${companyId} AND i."companyId" = ${companyId} AND i."deletedAt" IS NULL AND NOT i."isSample"
        AND i."invoiceDate" >= ${p.start} AND i."invoiceDate" < ${p.end} AND l."service" IS NOT NULL
      ORDER BY 1 LIMIT 200`,
    prisma.invoice.count({ where: invoiceScope(companyId), take: 1 }),
    prisma.measurement.count({ where: measurementScope(companyId), take: 1 }),
  ]);

  // Para birimleri toplanmaz: tutarlar tek para biriminde. Para izni yoksa tutar yok, sayılar tüm faturalardan.
  const { primary, others } = primaryCurrency(invoices, settings.currency);
  const allCurrencies = [primary, ...others];
  const currency = money ? (currencyRaw ?? primary) : null;
  const multi = money && allCurrencies.length > 1;
  // Para birimi süzgeci yalnız tutarlara uygulanır: sayılar ve kapsam Pano ile aynı küme.
  const amountFilter: LineFilter = { ...baseFilter, currency };
  const carrierName = new Map(carriers.map((c) => [c.id, c.name]));

  const filters: HubFilterDef[] = [
    { id: 'carrier', kind: 'select', multiple: true, label: t('filter.carrier'), options: carriers.map((c) => ({ value: c.id, label: c.name })) },
    { id: 'service', kind: 'select', label: t('filter.service'), options: services.map((s) => ({ value: s.service, label: s.service })) },
    { id: 'country', kind: 'text', label: t('filter.country') },
    { id: 'tracking', kind: 'text', label: t('filter.tracking') },
  ];
  if (multi) filters.unshift({ id: 'currency', kind: 'select', label: t('filter.currency'), options: allCurrencies.map((c) => ({ value: c, label: c })), default: primary });

  const base = { product: 'deciship', from: p.from, to: p.to, filters, ...(compare ? { compare: { from: prev.from, to: prev.to } } : {}) };
  const setupable = ctx.can(P.settings);
  if (!everInvoice && !everMeasurement) {
    return JSON.parse(
      JSON.stringify({
        ...base,
        sections: [
          {
            id: 'start',
            title: t('section.start'),
            widgets: [emptyWidget(ctx, 'start', 'empty.start.title', 'empty.start.body', { href: setupable ? deciship.setup : deciship.invoices, actionLabel: t('empty.start.action') })],
          },
        ],
      }),
    ) as HubAnalytics;
  }

  const [dims, prevDims, facts, top, health, measured, prevMeasured, days, prevDays, noPhoto, operators, tariffStatus] = await Promise.all([
    lineDimensions(companyId, p, baseFilter, currency),
    compare ? lineDimensions(companyId, prev, baseFilter, currency) : Promise.resolve(null),
    invoiceFacts(companyId, p, baseFilter),
    money ? topOverchargeLines(companyId, p, amountFilter, TOP_N) : Promise.resolve([]),
    money ? healthRows(companyId, p, baseFilter) : Promise.resolve({ rows: [], stale: 0 }),
    measurementCounts(companyId, p),
    compare ? measurementCounts(companyId, prev) : Promise.resolve(null),
    measurementDays(companyId, p),
    compare ? measurementDays(companyId, prev) : Promise.resolve(null),
    ctx.can(P.measurements) ? measurementsWithoutPhoto(companyId, p) : Promise.resolve(0),
    ctx.can(P.measurements) ? operatorFacts(companyId, p) : Promise.resolve([]),
    carrierTariffStatus(companyId, ctx.now),
  ]);

  const shared: Shared = { ctx, p, compare, money, currency, narrowed, multi, today, carrierName, dims, prevDims, carrierIds, filterCurrency: multi ? currency : null };
  const sections: HubSection[] = [
    overchargeSection(shared, facts, top),
    decisionSection(shared),
    await measureSection(shared, measured, prevMeasured, days, prevDays, noPhoto, operators, prev),
    tariffSection(shared, health, facts, tariffStatus, settings.fxTolerancePct),
  ].filter((s): s is HubSection => s != null);
  return JSON.parse(JSON.stringify({ ...base, sections })) as HubAnalytics;
}

type Shared = {
  ctx: HubCtx;
  p: Period;
  compare: boolean;
  money: boolean;
  currency: string | null;
  narrowed: boolean;
  multi: boolean;
  today: string;
  carrierName: Map<string, string>;
  dims: Dimensions;
  prevDims: Dimensions | null;
  carrierIds: string[];
  filterCurrency: string | null;
};

/** Tutarın bağlantısı: seçili para birimiyle açılır. */
function lineLink(s: Shared, filters: Record<string, string | null | undefined>) {
  return dataLink(s.ctx, 'invoice-lines', { ...filters, ...(s.filterCurrency ? { currency: s.filterCurrency } : {}) }, s.p);
}

/** Sayının bağlantısı: para birimi süzülmez, açılan listede aynı sayı görünür. */
const countLink = (s: Shared, filters: Record<string, string | null | undefined>) => dataLink(s.ctx, 'invoice-lines', filters, s.p);

function overchargeSection(s: Shared, facts: Awaited<ReturnType<typeof invoiceFacts>>, top: Awaited<ReturnType<typeof topOverchargeLines>>): HubSection {
  const { ctx, p, compare, money, currency, dims, prevDims, carrierName, multi } = s;
  const { t, locale } = ctx;
  const moneyAttrs = money ? ({ format: 'money', currency: currency! } as const) : ({ format: 'number' } as const);
  const total = dims.total;
  const prevTotal = prevDims?.total;
  const head = money
    ? { id: 'overcharge', title: t('section.overcharge'), description: multi ? t('section.overcharge.descIn', { currency: currency! }) : t('section.overcharge.desc') }
    : { id: 'diffs', title: t('section.diffs'), description: t('section.diffs.desc') };

  if (!total.lines) {
    return { ...head, widgets: [s.narrowed ? emptyWidget(ctx, 'no-lines', 'empty.filter.title', 'empty.filter.body') : emptyWidget(ctx, 'no-lines', 'empty.period.title', 'empty.period.body')] };
  }

  const items: HubKpi[] = [];
  // Önceki dönemde hiç satır yoksa "önceki 0" değil, karşılaştırma yok.
  const prevMoney = (v: number | undefined) => (prevTotal?.amountLines ? (v ?? null) : null);
  if (money) {
    items.push(
      withPrev({ id: 'billed', label: t('kpi.billed'), value: total.billed, format: 'money', currency: currency!, goodDirection: 'none' }, prevMoney(prevTotal?.billed), compare),
      withPrev({ id: 'overcharge', label: t('kpi.overcharge'), hint: t('kpi.overcharge.hint'), value: total.overcharge, format: 'money', currency: currency!, goodDirection: 'down', tone: total.overcharge > 0 ? 'bad' : 'neutral' }, prevMoney(prevTotal?.overcharge), compare),
      withPrev({ id: 'verified', label: t('kpi.verified'), hint: t('kpi.verified.hint'), value: total.verified, format: 'money', currency: currency!, goodDirection: 'none', href: lineLink(s, { status: 'DIFF', decision: 'VERIFIED' }) }, prevMoney(prevTotal?.verified), compare),
    );
    // İtiraz: satırın geçerli itiraz sonucundan (Genel Bakış ve Pano ile aynı kural), seçili süzgeç ve para biriminde.
    items.push(
      withPrev({ id: 'recovered', label: t('kpi.recovered'), hint: t('kpi.recovered.hint'), value: total.recovered, format: 'money', currency: currency!, goodDirection: 'up', tone: total.recovered > 0 ? 'good' : 'neutral', href: deciship.disputes }, prevMoney(prevTotal?.recovered), compare),
      withPrev({ id: 'disputePending', label: t('kpi.disputePending'), hint: t('kpi.disputePending.hint'), value: total.disputePending, format: 'money', currency: currency!, goodDirection: 'none', tone: total.disputePending > 0 ? 'warning' : 'neutral', href: `${deciship.disputes}?status=SENT` }, prevMoney(prevTotal?.disputePending), compare),
    );
    if (total.estimated > 0 || (prevTotal?.estimated ?? 0) > 0) {
      items.push(withPrev({ id: 'estimated', label: t('kpi.estimated'), hint: t('kpi.estimated.hint'), value: total.estimated, format: 'money', currency: currency!, goodDirection: 'down', tone: total.estimated > 0 ? 'warning' : 'neutral', href: lineLink(s, { status: 'DIFF', confidence: 'LOW' }) }, prevMoney(prevTotal?.estimated), compare));
    }
  }
  items.push(
    withPrev({ id: 'lines', label: t('kpi.lines'), value: total.lines, format: 'number', goodDirection: 'none', href: countLink(s, {}) }, prevTotal?.lines, compare),
    withPrev({ id: 'diffs', label: t('kpi.diffs'), hint: t('kpi.diffs.hint'), value: total.diff, format: 'number', goodDirection: 'down', tone: total.diff > 0 ? 'warning' : 'neutral', href: countLink(s, { status: 'DIFF' }) }, prevTotal?.diff, compare),
    withPrev({ id: 'diff-rate', label: t('kpi.diffRate'), value: pct(total.diff, total.lines), format: 'percent', goodDirection: 'down' }, prevTotal ? pct(prevTotal.diff, prevTotal.lines) : null, compare),
  );

  const widgets: HubWidget[] = [{ kind: 'kpis', id: 'overcharge-kpis', items }];

  const series = (d: Dimensions, period: Period, id: string, label: HubKey, role: 'current' | 'previous', today?: string): HubSeries => ({
    id,
    label: t(label),
    role,
    points: money
      ? bucketize(period, (day) => d.byDay.get(day)?.overcharge ?? 0, { cumulative: true, today, round: round2 })
      : bucketize(period, (day) => d.byDay.get(day)?.diff ?? 0, { today }),
  });
  widgets.push({
    kind: 'timeseries',
    id: money ? 'overcharge-trend' : 'diff-trend',
    title: money ? t('widget.overTrend') : t('widget.diffTrend'),
    description: money ? t('widget.overTrend.desc') : t('widget.diffTrend.desc'),
    chart: money ? 'area' : 'bar',
    ...moneyAttrs,
    series: [
      series(dims, p, 'current', 'common.thisPeriod', 'current', s.today),
      ...(prevDims ? [series(prevDims, previousPeriod(p), 'previous', 'common.previousPeriod', 'previous')] : []),
    ],
  });

  const measure = (m: LineMeasures) => (money ? m.overcharge : m.diff);
  widgets.push({
    kind: 'breakdown',
    id: 'diff-types',
    title: t('widget.types'),
    description: money ? t('widget.types.desc') : t('widget.types.descCount'),
    ...moneyAttrs,
    items: breakdownItems(
      ctx,
      [...dims.byType.entries()].map(([k, m]) => [k, measure(m)]),
      (k) => t(`diffType.${k}` as HubKey),
      (k) => lineLink(s, { status: 'DIFF', diff: k }),
      (k) => k,
    ),
  });

  const carriers = [...dims.byCarrier.entries()];
  widgets.push({
    kind: 'breakdown',
    id: 'by-carrier',
    title: t('widget.byCarrier'),
    ...moneyAttrs,
    items: breakdownItems(
      ctx,
      carriers.map(([k, m]) => [k, measure(m)]),
      (k) => carrierName.get(k) ?? k,
      (k) => lineLink(s, { status: 'DIFF', carrier: k }),
      (k) => k,
    ),
  });
  const isForeign = (m: LineMeasures) => m.lines > 0 && m.amountLines === 0;
  const foreign = carriers.some(([, m]) => isForeign(m));
  const carrierColumns: HubColumn[] = [
    { id: 'carrier', label: t('col.carrier'), format: 'text' },
    { id: 'lines', label: t('col.lines'), format: 'number' },
    { id: 'diff', label: t('col.diffLines'), format: 'number' },
    { id: 'diffRate', label: t('col.diffRate'), format: 'percent' },
    ...(money && foreign
      ? ([{ id: 'note', label: t('col.note'), format: 'text' }] as HubColumn[])
      : []),
    ...(money
      ? ([
          { id: 'billed', label: t('col.billed'), format: 'money', currency: currency! },
          { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
          { id: 'overchargeRate', label: t('col.overchargeRate'), format: 'percent' },
        ] as HubColumn[])
      : []),
  ];
  widgets.push({
    kind: 'table',
    id: 'carrier-rates',
    title: t('widget.carrierRates'),
    description: t('widget.carrierRates.desc'),
    columns: carrierColumns,
    rows: carriers
      .sort((a, b) => measure(b[1]) - measure(a[1]) || (carrierName.get(a[0]) ?? '').localeCompare(carrierName.get(b[0]) ?? ''))
      .map(([id, m]): HubRow => {
        const href = countLink(s, { carrier: id });
        return {
          id,
          ...(href ? { href } : {}),
          cells: {
            carrier: carrierName.get(id) ?? id,
            lines: m.lines,
            diff: m.diff,
            diffRate: pct(m.diff, m.lines),
            // Tutarlar yalnız seçili para biriminden toplanır: başka para biriminde faturalanan taşıyıcıda 0 değil boş yazılır.
            ...(money && foreign ? { note: isForeign(m) ? t('note.otherCurrency') : null } : {}),
            ...(money
              ? isForeign(m)
                ? { billed: null, overcharge: null, overchargeRate: null }
                : { billed: m.billed, overcharge: m.overcharge, overchargeRate: pct(m.overcharge, m.billed) }
              : {}),
          },
        };
      }),
  });

  widgets.push({
    kind: 'breakdown',
    id: 'by-country',
    title: t('widget.byCountry'),
    ...moneyAttrs,
    items: breakdownItems(
      ctx,
      [...dims.byCountry.entries()].map(([k, m]) => [k, measure(m)]),
      (k) => countryName(k, locale) ?? t('common.unspecified'),
      (k) => (k ? lineLink(s, { status: 'DIFF', country: k }) : undefined),
      (k) => k ?? '_none',
    ),
  });
  widgets.push({
    kind: 'breakdown',
    id: 'by-service',
    title: t('widget.byService'),
    ...moneyAttrs,
    items: breakdownItems(
      ctx,
      [...dims.byService.entries()].map(([k, m]) => [k, measure(m)]),
      (k) => k ?? t('common.unspecified'),
      (k) => (k ? lineLink(s, { status: 'DIFF', service: k }) : undefined),
      (k) => k ?? '_none',
    ),
  });

  if (money) {
    const seeInvoices = ctx.can(P.invoices);
    widgets.push({
      kind: 'table',
      id: 'top-shipments',
      title: t('widget.topShipments'),
      columns: [
        { id: 'tracking', label: t('col.tracking'), format: 'text' },
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'invoice', label: t('col.invoice'), format: 'text' },
        { id: 'country', label: t('col.country'), format: 'text' },
        { id: 'type', label: t('col.diffType'), format: 'text' },
        { id: 'billed', label: t('col.billed'), format: 'money', currency: currency! },
        { id: 'expected', label: t('col.expected'), format: 'money', currency: currency! },
        { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
      ],
      rows: top.map((l) => ({
        id: l.id,
        ...(seeInvoices ? { href: deciship.invoiceLine(l.invoiceId, l.id, l.status) } : {}),
        cells: {
          tracking: l.trackingNo,
          carrier: carrierName.get(l.carrierId) ?? l.carrierId,
          invoice: l.invoiceNo,
          country: l.destCountry,
          type: l.diffTypes.map((d) => t(`diffType.${d}` as HubKey)).join(', '),
          billed: l.netAmount,
          expected: l.expectedAmount,
          overcharge: l.diffAmount,
        },
      })),
    });
    const topInvoices = facts
      .filter((f) => f.overcharge > 0 && f.currency === currency)
      .sort((a, b) => b.overcharge - a.overcharge || a.id.localeCompare(b.id))
      .slice(0, TOP_N);
    widgets.push({
      kind: 'table',
      id: 'top-invoices',
      title: t('widget.topInvoices'),
      columns: [
        { id: 'invoice', label: t('col.invoice'), format: 'text' },
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'date', label: t('col.date'), format: 'date' },
        { id: 'lines', label: t('col.lines'), format: 'number' },
        { id: 'diff', label: t('col.diffLines'), format: 'number' },
        { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
      ],
      rows: topInvoices.map((f) => ({
        id: f.id,
        ...(seeInvoices ? { href: deciship.invoice(f.id) } : {}),
        cells: { invoice: f.invoiceNo, carrier: carrierName.get(f.carrierId) ?? f.carrierId, date: f.invoiceDate, lines: f.lines, diff: f.diff, overcharge: f.overcharge },
      })),
    });
  }
  return { ...head, widgets };
}

function decisionSection(s: Shared): HubSection | null {
  const { ctx, dims, money, currency, compare, prevDims } = s;
  const { t } = ctx;
  if (!dims.total.diff) return null;
  const decisions = ['OPEN', 'VERIFIED', 'ACCEPTED'] as const;
  // Karar kırılımı yalnız fark satırları içindir; `decision` alanı diğer satırlarda da OPEN durur.
  const diffLines = (key: string) => dims.byDecision.get(key)?.diff ?? 0;
  const widgets: HubWidget[] = [
    {
      kind: 'kpis',
      id: 'decision-kpis',
      items: [
        withPrev({ id: 'open', label: t('kpi.open'), value: dims.total.open, format: 'number', goodDirection: 'down', tone: dims.total.open > 0 ? 'warning' : 'neutral', href: countLink(s, { status: 'DIFF', decision: 'OPEN' }) }, prevDims?.total.open, compare),
        withPrev({ id: 'decision-days', label: t('kpi.decisionDays'), hint: t('kpi.decisionDays.hint'), value: dims.avgDecisionDays, format: 'duration_days', goodDirection: 'down' }, prevDims?.avgDecisionDays, compare),
      ],
    },
    {
      kind: 'breakdown',
      id: 'decision-lines',
      title: t('widget.decisionLines'),
      format: 'number',
      items: breakdownItems(
        ctx,
        decisions.map((k) => [k, diffLines(k)]),
        (k) => t(`decision.${k}`),
        (k) => countLink(s, { status: 'DIFF', decision: k }),
        (k) => k,
      ),
    },
  ];
  if (money) {
    widgets.push({
      kind: 'table',
      id: 'decision-summary',
      title: t('widget.decisionTable'),
      description: t('widget.decisionTable.desc'),
      columns: [
        { id: 'decision', label: t('col.decision'), format: 'text' },
        { id: 'lines', label: t('col.lines'), format: 'number' },
        { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
        { id: 'estimated', label: t('col.estimated'), format: 'money', currency: currency! },
      ],
      rows: decisions.map((k) => {
        const m = dims.byDecision.get(k);
        const href = countLink(s, { status: 'DIFF', decision: k });
        // Uyumlu sayılan satır fazla ödemeye girmez (computeTotals): tutarı 0 gösterilir, "kaç satır" ayrı sütunda.
        return { id: k, ...(href ? { href } : {}), cells: { decision: t(`decision.${k}`), lines: diffLines(k), overcharge: m?.overcharge ?? 0, estimated: m?.estimated ?? 0 } };
      }),
    });
  }
  return { id: 'decisions', title: t('section.decisions'), description: t('section.decisions.desc'), widgets };
}

async function measureSection(
  s: Shared,
  measured: Awaited<ReturnType<typeof measurementCounts>>,
  prevMeasured: Awaited<ReturnType<typeof measurementCounts>> | null,
  days: Map<string, number>,
  prevDays: Map<string, number> | null,
  noPhoto: number,
  operators: Awaited<ReturnType<typeof operatorFacts>>,
  prev: Period,
): Promise<HubSection> {
  const { ctx, p, dims, prevDims, compare, today } = s;
  const { t, companyId } = ctx;
  const head = { id: 'measure', title: t('section.measure'), description: t('section.measure.desc') };
  if (!measured.count) {
    const empty = emptyWidget(ctx, 'no-measurements', 'empty.measure.title', 'empty.measure.body');
    if (!dims.total.lines) return { ...head, widgets: [empty] };
    // Kapsam faturadaki satırlardan gelir, dönemdeki ölçümden değil: Pano ve Genel Bakış burada da gösterir.
    const coverage = withPrev({ id: 'coverage', label: t('kpi.coverage'), hint: t('kpi.coverage.hint'), value: coveragePct(dims.total.lines, dims.total.unmatched), format: 'percent', goodDirection: 'up', href: countLink(s, { status: 'UNMATCHED' }) }, prevDims ? coveragePct(prevDims.total.lines, prevDims.total.unmatched) : null, compare);
    return { ...head, widgets: [{ kind: 'kpis', id: 'measure-kpis', items: [coverage] }, empty] };
  }

  const items: HubKpi[] = [
    withPrev({ id: 'measured', label: t('kpi.measured'), value: measured.count, format: 'number', goodDirection: 'up', href: dataLink(ctx, 'measurements', {}, p) }, prevMeasured?.count, compare),
    withPrev({ id: 'coverage', label: t('kpi.coverage'), hint: t('kpi.coverage.hint'), value: coveragePct(dims.total.lines, dims.total.unmatched), format: 'percent', goodDirection: 'up', href: countLink(s, { status: 'UNMATCHED' }) }, prevDims ? coveragePct(prevDims.total.lines, prevDims.total.unmatched) : null, compare),
  ];
  if (ctx.can(P.measurements)) items.push({ id: 'no-photo', label: t('kpi.noPhoto'), value: noPhoto, format: 'number', goodDirection: 'down', href: dataLink(ctx, 'measurements', { photos: 'none' }, p) });

  const widgets: HubWidget[] = [
    { kind: 'kpis', id: 'measure-kpis', items },
    {
      kind: 'timeseries',
      id: 'measured-trend',
      title: t('widget.measureTrend'),
      chart: 'bar',
      format: 'number',
      series: [
        { id: 'current', label: t('common.thisPeriod'), role: 'current', points: bucketize(p, (d) => days.get(d) ?? 0, { today }) },
        ...(prevDays ? [{ id: 'previous', label: t('common.previousPeriod'), role: 'previous' as const, points: bucketize(prev, (d) => prevDays.get(d) ?? 0) }] : []),
      ],
    },
    {
      kind: 'breakdown',
      id: 'methods',
      title: t('widget.methods'),
      format: 'number',
      items: breakdownItems(
        ctx,
        DIM_METHODS.map((k) => [k, measured.byMethod[k]]),
        (k) => t(`method.${k}`),
        (k) => dataLink(ctx, 'measurements', { method: k }, p),
        (k) => k,
      ),
    },
  ];
  // Çalışan adı yalnız tüm ölçümleri görme izni olana (measurements.view_all).
  if (ctx.can(P.measurements)) {
    const names = await memberNames(companyId, operators.map((o) => o.userId));
    widgets.push({
      kind: 'table',
      id: 'operators',
      title: t('widget.operators'),
      columns: [
        { id: 'name', label: t('col.person'), format: 'text' },
        { id: 'count', label: t('col.parcels'), format: 'number' },
        { id: 'noPhoto', label: t('col.noPhoto'), format: 'number' },
        { id: 'corrected', label: t('col.corrected'), format: 'number' },
        { id: 'manualShare', label: t('col.manualShare'), format: 'percent' },
        { id: 'last', label: t('col.lastMeasurement'), format: 'datetime' },
      ],
      rows: operators.map((o) => ({
        id: o.userId,
        href: deciship.measurementsBy(o.userId, p),
        cells: { name: names.get(o.userId) ?? null, count: o.count, noPhoto: o.noPhoto, corrected: o.corrected, manualShare: pct(o.manual, o.count), last: o.last ? o.last.toISOString() : null },
      })),
    });
  }
  return { ...head, widgets };
}

function tariffSection(
  s: Shared,
  health: Awaited<ReturnType<typeof healthRows>>,
  facts: Awaited<ReturnType<typeof invoiceFacts>>,
  status: Awaited<ReturnType<typeof carrierTariffStatus>>,
  fxTolerancePct: number,
): HubSection | null {
  const { ctx, money, carrierName, carrierIds, dims } = s;
  const { t, locale } = ctx;
  const widgets: HubWidget[] = [];

  if (money) {
    // Taşıyıcı başına core `tariffHealth`: "uyumlu" bandı ve gruplar fatura ayrıntısındaki raporla aynı kuraldan.
    const byCarrier = new Map<string, HealthLineInput[]>();
    for (const r of health.rows) {
      const list = byCarrier.get(r.carrierId) ?? [];
      const input: HealthLineInput = { destCountry: r.country, service: r.service, zone: r.zone, rateDeviationPct: r.deviation, adjustmentPct: r.adjustment, fx: r.fx, fuelPct: r.fuel };
      for (let i = 0; i < r.lines; i++) list.push(input);
      byCarrier.set(r.carrierId, list);
    }
    let checked = 0;
    let ok = 0;
    let skipped = health.stale;
    const rows: { carrierId: string; g: ReturnType<typeof tariffHealth>['groups'][number] }[] = [];
    for (const [carrierId, lines] of byCarrier) {
      const report = tariffHealth(lines, { fxTolerancePct, carrierName: carrierName.get(carrierId) ?? null });
      checked += report.checkedLines;
      ok += report.okLines;
      skipped += report.skippedLines;
      for (const g of report.groups) if (g.status !== 'ok') rows.push({ carrierId, g });
    }
    if (checked + skipped > 0) {
      widgets.push({
        kind: 'kpis',
        id: 'tariff-kpis',
        items: [
          { id: 'tariff-ok', label: t('kpi.tariffOk'), hint: t('kpi.tariffOk.hint'), value: pct(ok, checked), format: 'percent', goodDirection: 'up' },
          { id: 'tariff-unchecked', label: t('kpi.tariffUnchecked'), value: skipped, format: 'number', goodDirection: 'down' },
        ],
      });
    }
    if (rows.length) {
      rows.sort((a, b) => b.g.lines - a.g.lines || Math.abs(b.g.medianDeviationPct) - Math.abs(a.g.medianDeviationPct) || a.g.key.localeCompare(b.g.key));
      widgets.push({
        kind: 'table',
        id: 'tariff-deviations',
        title: t('widget.deviations'),
        description: t('widget.deviations.desc'),
        columns: [
          { id: 'carrier', label: t('col.carrier'), format: 'text' },
          { id: 'country', label: t('col.country'), format: 'text' },
          { id: 'zone', label: t('col.zone'), format: 'text' },
          { id: 'service', label: t('col.service'), format: 'text' },
          { id: 'lines', label: t('col.lines'), format: 'number' },
          { id: 'deviation', label: t('col.deviation'), format: 'percent' },
          { id: 'status', label: t('col.status'), format: 'text' },
        ],
        rows: rows.slice(0, DEVIATION_ROWS).map(({ carrierId, g }) => {
          const href = countLink(s, { carrier: carrierId, country: g.country, service: g.service });
          return {
            id: `${carrierId}|${g.key}`,
            ...(href ? { href } : {}),
            cells: {
              carrier: carrierName.get(carrierId) ?? carrierId,
              country: countryName(g.country, locale),
              zone: g.zone,
              service: g.service,
              lines: g.lines,
              deviation: g.medianDeviationPct,
              status: t(`health.${g.status}`),
            },
          };
        }),
      });
    }
  }

  const suspects = facts.filter((f) => isTariffSuspect(f.compared, f.priceDiff)).sort((a, b) => b.priceDiff - a.priceDiff || a.id.localeCompare(b.id));
  if (suspects.length) {
    const seeInvoices = ctx.can(P.invoices);
    widgets.push({
      kind: 'table',
      id: 'tariff-suspects',
      title: t('widget.suspect'),
      description: t('widget.suspect.desc'),
      columns: [
        { id: 'invoice', label: t('col.invoice'), format: 'text' },
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'date', label: t('col.date'), format: 'date' },
        { id: 'compared', label: t('col.compared'), format: 'number' },
        { id: 'priceDiff', label: t('col.priceDiffs'), format: 'number' },
      ],
      rows: suspects.slice(0, TOP_N).map((f) => ({
        id: f.id,
        ...(seeInvoices ? { href: deciship.invoice(f.id) } : {}),
        cells: { invoice: f.invoiceNo, carrier: carrierName.get(f.carrierId) ?? f.carrierId, date: f.invoiceDate, compared: f.compared, priceDiff: f.priceDiff },
      })),
    });
  }

  const shown = carrierIds.length ? status.filter((c) => carrierIds.includes(c.carrierId)) : status;
  if (shown.length) {
    widgets.push({
      kind: 'table',
      id: 'tariff-status',
      title: t('widget.tariffStatus'),
      description: t('widget.tariffStatus.desc'),
      columns: [
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'tariff', label: t('col.tariff'), format: 'text' },
        { id: 'to', label: t('col.to'), format: 'date' },
        { id: 'daysLeft', label: t('col.daysLeft'), format: 'number' },
        { id: 'noTariff', label: t('col.noTariff'), format: 'number' },
      ],
      rows: shown.map((c) => ({
        id: c.carrierId,
        href: c.tariff ? deciship.tariff(c.tariff.id) : deciship.tariffs(c.carrierId),
        cells: { carrier: c.carrierName, tariff: c.tariff?.name ?? null, to: c.tariff?.validTo ?? null, daysLeft: c.daysLeft, noTariff: dims.byCarrier.get(c.carrierId)?.noTariff ?? 0 },
      })),
    });
  }
  return widgets.length ? { id: 'tariffs', title: t('section.tariffs'), description: t('section.tariffs.desc'), widgets } : null;
}

