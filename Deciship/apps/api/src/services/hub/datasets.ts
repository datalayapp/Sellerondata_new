import { desi, normalizeTracking, disputeDeadlines, ttkApplies, turkeyDate, PAK_NOTE } from '@deciship/core';
import type { HubColumn, HubDatasetDef, HubDatasetList, HubDatasetPage, HubFilterDef, HubRow, Permission } from '@sellerondata/contracts';
import { prisma, Prisma } from '../../db.ts';
import { zonedRange } from '../../lib/time.ts';
import { likeEscape, num, numOrNull } from '../../lib/util.ts';
import { readLinePricing, type InvoiceTotals } from '../compare.ts';
import { ACTIVITY_GROUPS, activityRows, auditWhere, visibleActions } from './activity.ts';
import { asList } from './analytics.ts';
import { countryName, type HubKey } from './i18n.ts';
import { deciship } from './links.ts';
import { memberNames } from './members.ts';
import { DIM_METHODS, companyCountry, companySettings, invoiceScope, measurementScope, upcomingDeadlines } from './metrics.ts';
import { invoiceDisputeSummaries, lineDisputeStates } from '../disputes.ts';
import { makePeriod, parseDayOrThrow } from './period.ts';
import { P, hubError, queryInt, type HubCtx } from './types.ts';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
export const MAX_EXPORT_ROWS = 100_000;
const EXPORT_BATCH = 2_000;

export type DatasetQuery = { page: number; pageSize: number; q?: string; sort?: string; dir: 'asc' | 'desc'; filters: Record<string, string[]> };

export function parseDatasetQuery(query: unknown, ctx: HubCtx): DatasetQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const filters = Object.create(null) as Record<string, string[]>;
  for (const [k, v] of Object.entries(q)) if (k.startsWith('filter.')) filters[k.slice(7)] = asList(v);
  const text = typeof q.q === 'string' ? q.q.trim() : '';
  return {
    page: queryInt(q.page, 1, 'page', ctx.t),
    pageSize: Math.min(MAX_PAGE_SIZE, queryInt(q.pageSize, DEFAULT_PAGE_SIZE, 'pageSize', ctx.t)),
    q: text || undefined,
    sort: typeof q.sort === 'string' && q.sort ? q.sort : undefined,
    dir: q.dir === 'asc' ? 'asc' : 'desc',
    filters,
  };
}

type Fetched = { rows: HubRow[]; total: number; currencies?: string[]; ids?: string[] };
/**
 * Sayfa ya da dışa aktarma dilimi.
 * `idsOnly`: yalnız eşleşen kimlikler, istenen sırada. `only`: yalnız bu kimlikler; yalnız dışa aktarma partisi için — toplam
 * süzgecin gerçek toplamı değil partideki kimlik sayısıdır, para birimi listesi dolmaz (6.14).
 */
type Slice = { skip: number; take: number; only?: string[]; idsOnly?: boolean };

/** `only` varsa kimlik süzgeci, sayfa kayması yok. */
const sliceOf = (slice: Slice) => (slice.only ? { skip: 0, take: slice.only.length } : { skip: slice.skip, take: slice.take });
function onlyIds<W extends object>(where: W, slice: Slice): W {
  return slice.only ? ({ AND: [where, { id: { in: slice.only } }] } as unknown as W) : where;
}
const idList = (total: number, rows: { id: string }[]): Fetched => ({ total, rows: [], ids: rows.map((r) => r.id) });
/**
 * KALANLAR 6.14: dışa aktarma partisi (`only`) toplam sayıyı ve para birimi listesini kullanmaz (`datasetExport`
 * yalnız satırları okur): parti başına süzgecin tam sayımı yapılmaz. Sayfa ve kayıt sayımı eskisi gibi.
 */
const unlessOnly = <T>(slice: Slice, run: () => PromiseLike<T>, skipped: T): PromiseLike<T> => (slice.only ? Promise.resolve(skipped) : run());

type DatasetSpec = {
  id: string;
  requires: Permission[];
  filters: (ctx: HubCtx, shared: SharedOptions) => HubFilterDef[];
  /** `country`: firmanın çözülmüş ülkesi; Türk Ticaret Kanunu süresine dayanan sütun yalnız Türkiye'de. */
  columns: (ctx: HubCtx, money: MoneyColumn, country: string | null) => HubColumn[];
  fetch: (ctx: HubCtx, q: DatasetQuery, slice: Slice) => Promise<Fetched>;
  /** Para birimi sütunu olan set: tutarlar faturanın ya da tarifenin para biriminde. */
  hasMoney?: boolean;
};

type SharedOptions = { carriers: { value: string; label: string }[]; users: { value: string; label: string }[]; currencies: { value: string; label: string }[]; country: string | null };

/** Bir sayfada tek para birimi varsa sütun o para biriminde biçimlenir; karışıksa ham sayı + "Para birimi" sütunu, yanlış simge gösterilmez. */
type MoneyColumn = { cols: (defs: { id: string; label: string; sortable?: boolean }[]) => HubColumn[]; currencyColumn: (ctx: HubCtx) => HubColumn[] };

function moneyColumns(currencies: string[] | undefined, forExport: boolean): MoneyColumn {
  const single = !forExport && currencies?.length === 1 ? currencies[0] : undefined;
  return {
    cols: (defs) => defs.map((d) => (single ? { ...d, format: 'money' as const, currency: single, align: 'right' as const } : { ...d, format: forExport ? ('money' as const) : ('number' as const), align: 'right' as const, currencyCell: 'currency' })),
    currencyColumn: (ctx) => (single ? [] : [{ id: 'currency', label: ctx.t('col.currency'), format: 'text' }]),
  };
}

const sel = (ctx: HubCtx, id: string, labelKey: HubKey, options: { value: string; label: string }[], multiple = false): HubFilterDef => ({ id, kind: 'select', label: ctx.t(labelKey), options, ...(multiple ? { multiple } : {}) });
const txt = (ctx: HubCtx, id: string, labelKey: HubKey): HubFilterDef => ({ id, kind: 'text', label: ctx.t(labelKey) });

const STATUSES = ['MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF'] as const;
const DECISIONS = ['OPEN', 'VERIFIED', 'ACCEPTED'] as const;
const DIFF_TYPES = ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE'] as const;
const DISPUTE_STATUSES = ['NONE', 'SENT', 'CLOSED'] as const;

function oneOf<T extends string>(ctx: HubCtx, q: DatasetQuery, name: string, allowed: readonly T[]): T[] {
  const vals = q.filters[name] ?? [];
  for (const v of vals) if (!allowed.includes(v as T)) throw hubError(400, 'VALIDATION', ctx.t('err.filter', { name }));
  return vals as T[];
}

/** `filter.from` / `filter.to`: fatura tarihi ya da ölçüm zamanı. Analizdeki sayıya tıklayan aynı dönemi görür. */
function dateRange(ctx: HubCtx, q: DatasetQuery): { gte?: Date; lt?: Date } | undefined {
  const from = q.filters.from?.[0];
  const to = q.filters.to?.[0];
  if (!from && !to) return undefined;
  const out: { gte?: Date; lt?: Date } = {};
  if (from) out.gte = makePeriod(parseDayOrThrow(from, ctx), parseDayOrThrow(from, ctx)).start;
  if (to) out.lt = makePeriod(parseDayOrThrow(to, ctx), parseDayOrThrow(to, ctx)).end;
  return out;
}

/** Ölçüm süzgeci: gün, firmanın günüdür. */
async function measuredDateRange(ctx: HubCtx, q: DatasetQuery): Promise<{ gte?: Date; lt?: Date } | undefined> {
  const from = q.filters.from?.[0];
  const to = q.filters.to?.[0];
  if (!from && !to) return undefined;
  const { timeZone } = await companySettings(ctx.companyId);
  const out: { gte?: Date; lt?: Date } = {};
  if (from) out.gte = zonedRange(parseDayOrThrow(from, ctx), from, timeZone).gte;
  if (to) out.lt = zonedRange(parseDayOrThrow(to, ctx), to, timeZone).lt;
  return out;
}

/** Yalnız tablonun kendi anahtarı: `?sort=constructor` Object.prototype'a düşmez. */
const pick = <T>(table: Record<string, T>, key: string | undefined): T | undefined => (key && Object.hasOwn(table, key) ? table[key] : undefined);
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

// ---------- faturalar ----------

const invoiceSort: Record<string, { sql: string; money?: boolean }> = {
  no: { sql: 'i."invoiceNo"' },
  carrier: { sql: 'c."name"' },
  date: { sql: 'i."invoiceDate"' },
  lines: { sql: `COALESCE((i."totals"->>'lines')::int, 0)` },
  diff: { sql: `COALESCE((i."totals"->>'diff')::int, 0)` },
  unmatched: { sql: `COALESCE((i."totals"->>'unmatched')::int, 0)` },
  billed: { sql: `COALESCE((i."totals"->>'billedTotal')::numeric, 0)`, money: true },
  overcharge: { sql: `COALESCE((i."totals"->>'overchargeTotal')::numeric, 0)`, money: true },
  verified: { sql: `COALESCE((i."totals"->>'verifiedTotal')::numeric, 0)`, money: true },
};

const invoices: DatasetSpec = {
  id: 'invoices',
  requires: [],
  hasMoney: true,
  filters: (ctx, s) => [
    sel(ctx, 'carrier', 'filter.carrier', s.carriers, true),
    ...(s.currencies.length > 1 && ctx.can(P.prices) ? [sel(ctx, 'currency', 'filter.currency', s.currencies)] : []),
    // Türkiye dışında yaklaşan süre yalnız taşıyıcının düzeltme süresidir: süzgeç onu söyler.
    sel(ctx, 'deadline', ttkApplies(s.country) ? 'filter.deadline' : 'filter.deadline.carrier', [{ value: 'soon', label: ctx.t('filter.deadline.soon') }]),
    sel(ctx, 'dispute', 'filter.dispute', DISPUTE_STATUSES.map((v) => ({ value: v, label: ctx.t(`disputeStatus.${v}`) }))),
    txt(ctx, 'from', 'filter.from'),
    txt(ctx, 'to', 'filter.to'),
  ],
  columns: (ctx, m, country) => [
    { id: 'no', label: ctx.t('col.invoice'), format: 'text', sortable: true },
    { id: 'carrier', label: ctx.t('col.carrier'), format: 'text', sortable: true },
    { id: 'date', label: ctx.t('col.date'), format: 'date', sortable: true },
    // Önce para: fazla ödeme, faturalanan, fark. Kalanlar açılabilir ayrıntı.
    ...(ctx.can(P.prices)
      ? [
          ...m.currencyColumn(ctx),
          ...m.cols([
            { id: 'overcharge', label: ctx.t('col.overcharge'), sortable: true },
            { id: 'billed', label: ctx.t('col.billed'), sortable: true },
          ]),
        ]
      : []),
    { id: 'diff', label: ctx.t('col.diff'), format: 'number', sortable: true },
    { id: 'lines', label: ctx.t('col.lines'), format: 'number', sortable: true },
    { id: 'unmatched', label: ctx.t('col.unmatched'), format: 'number', sortable: true },
    ...(ttkApplies(country) ? [{ id: 'lastDay', label: ctx.t('col.lastDay'), format: 'date' as const }] : []),
    { id: 'dispute', label: ctx.t('col.dispute'), format: 'text' },
    { id: 'sentOn', label: ctx.t('col.sentOn'), format: 'date' },
    ...(ctx.can(P.prices)
      ? m.cols([
          { id: 'verified', label: ctx.t('col.verified'), sortable: true },
          { id: 'recovered', label: ctx.t('col.recovered') },
          { id: 'estimated', label: ctx.t('col.estimated') },
        ])
      : []),
    { id: 'match', label: ctx.t('col.match'), format: 'number', hiddenByDefault: true },
    { id: 'noTariff', label: ctx.t('col.noTariff'), format: 'number', hiddenByDefault: true },
  ],
  fetch: async (ctx, q, slice) => {
    const { companyId } = ctx;
    const carrierIds = q.filters.carrier ?? [];
    const currency = q.filters.currency?.[0]?.toUpperCase();
    const range = dateRange(ctx, q);
    const deadline = oneOf(ctx, q, 'deadline', ['soon'] as const)[0];
    const parts: Prisma.Sql[] = [Prisma.sql`i."companyId" = ${companyId}`, Prisma.sql`i."deletedAt" IS NULL`, Prisma.sql`NOT i."isSample"`];
    if (carrierIds.length) parts.push(Prisma.sql`i."carrierId" = ANY(${carrierIds}::text[])`);
    if (currency) parts.push(Prisma.sql`upper(i."currency") = ${currency}`);
    if (range?.gte) parts.push(Prisma.sql`i."invoiceDate" >= ${range.gte}`);
    if (range?.lt) parts.push(Prisma.sql`i."invoiceDate" < ${range.lt}`);
    if (deadline) {
      const ids = (await upcomingDeadlines(companyId, ctx.now)).map((d) => d.id);
      parts.push(Prisma.sql`i."id" = ANY(${ids}::text[])`);
    }
    // İtiraz durumu: etkin tur yoksa İşlendi; etkin turda bekleyen satır varsa gönderildi, yoksa kapandı (services/disputes.ts).
    const dispute = oneOf(ctx, q, 'dispute', DISPUTE_STATUSES)[0];
    if (dispute) {
      const active = Prisma.sql`SELECT 1 FROM "Dispute" d WHERE d."invoiceId" = i."id" AND d."withdrawnAt" IS NULL AND d."supersededAt" IS NULL`;
      const pending = Prisma.sql`SELECT 1 FROM "Dispute" d JOIN "DisputeLine" dl ON dl."disputeId" = d."id" WHERE d."invoiceId" = i."id" AND d."withdrawnAt" IS NULL AND d."supersededAt" IS NULL AND dl."outcome" = 'PENDING'`;
      if (dispute === 'NONE') parts.push(Prisma.sql`NOT EXISTS (${active})`);
      if (dispute === 'SENT') parts.push(Prisma.sql`EXISTS (${pending})`);
      if (dispute === 'CLOSED') parts.push(Prisma.sql`EXISTS (${active}) AND NOT EXISTS (${pending})`);
    }
    if (q.q) {
      const like = `%${likeEscape(q.q)}%`;
      parts.push(Prisma.sql`(i."invoiceNo" ILIKE ${like} OR c."name" ILIKE ${like})`);
    }
    const where = Prisma.join(parts, ' AND ');
    // Para izni olmayan tutara göre sıralayamaz: sıra tutarı ele verir.
    const sort = pick(invoiceSort, q.sort);
    const usable = sort && (!sort.money || ctx.can(P.prices)) ? sort : null;
    // Tutar sıralamasında önce para birimi: 300 USD ile 500 TRY aynı ölçekte değil.
    const order = usable
      ? Prisma.raw(`${usable.money ? 'upper(i."currency"), ' : ''}${usable.sql} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, i."id"`)
      : Prisma.raw(`i."invoiceDate" DESC, i."createdAt" DESC, i."id"`);
    if (slice.idsOnly) {
      const [count, ids] = await Promise.all([
        prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "Invoice" i JOIN "Carrier" c ON c."id" = i."carrierId" WHERE ${where}`,
        prisma.$queryRaw<{ id: string }[]>`SELECT i."id" FROM "Invoice" i JOIN "Carrier" c ON c."id" = i."carrierId" WHERE ${where} ORDER BY ${order} LIMIT ${MAX_EXPORT_ROWS}`,
      ]);
      return idList(count[0]?.n ?? 0, ids);
    }
    const page = sliceOf(slice);
    const rowWhere = slice.only ? Prisma.sql`${where} AND i."id" = ANY(${slice.only}::text[])` : where;
    const [count, rows, currencies] = await Promise.all([
      unlessOnly(slice, () => prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "Invoice" i JOIN "Carrier" c ON c."id" = i."carrierId" WHERE ${where}`, [{ n: slice.only?.length ?? 0 }]),
      prisma.$queryRaw<{ id: string; invoiceNo: string; invoiceDate: Date; currency: string; totals: InvoiceTotals; carrier: string; carrierCode: string }[]>`
        SELECT i."id", i."invoiceNo", i."invoiceDate", i."currency", i."totals", c."name" AS "carrier", c."code" AS "carrierCode"
        FROM "Invoice" i JOIN "Carrier" c ON c."id" = i."carrierId"
        WHERE ${rowWhere} ORDER BY ${order} LIMIT ${page.take} OFFSET ${page.skip}`,
      unlessOnly(slice, () => prisma.$queryRaw<{ currency: string }[]>`SELECT DISTINCT upper(i."currency") AS "currency" FROM "Invoice" i JOIN "Carrier" c ON c."id" = i."carrierId" WHERE ${where}`, []),
    ]);
    const today = turkeyDate(ctx.now);
    const country = await companyCountry(companyId);
    const pageIds = rows.map((r) => r.id);
    const [disputes, sent] = await Promise.all([
      invoiceDisputeSummaries(companyId, pageIds),
      pageIds.length
        ? prisma.dispute.findMany({ where: { companyId, invoiceId: { in: pageIds }, withdrawnAt: null, supersededAt: null }, select: { invoiceId: true, sentOn: true } })
        : Promise.resolve([]),
    ]);
    const sentOn = new Map(sent.map((d) => [d.invoiceId, dayOf(d.sentOn)]));
    return {
      total: count[0]?.n ?? 0,
      currencies: currencies.map((c) => c.currency),
      rows: rows.map((r) => {
        const t = r.totals ?? ({} as InvoiceTotals);
        const iso = dayOf(new Date(r.invoiceDate))!;
        const d = disputes.get(r.id);
        return {
          id: r.id,
          href: deciship.invoice(r.id, 'ALL'),
          cells: {
            no: r.invoiceNo,
            carrier: r.carrier,
            date: iso,
            lines: Number(t.lines) || 0,
            match: Number(t.match) || 0,
            diff: Number(t.diff) || 0,
            unmatched: Number(t.unmatched) || 0,
            noTariff: Number(t.noTariff) || 0,
            lastDay: (Number(t.diff) || 0) > 0 ? (disputeDeadlines(iso, r.carrierCode, today, country)?.ttk?.lastDay ?? null) : null,
            dispute: ctx.t(`disputeStatus.${d?.status ?? 'NONE'}`),
            sentOn: sentOn.get(r.id) ?? null,
            ...(ctx.can(P.prices)
              ? {
                  currency: r.currency.toUpperCase(),
                  billed: Number(t.billedTotal) || 0,
                  overcharge: Number(t.overchargeTotal) || 0,
                  verified: Number(t.verifiedTotal) || 0,
                  recovered: d?.sums?.recoveredAmount ?? 0,
                  estimated: Number(t.estimatedOverchargeTotal) || 0,
                }
              : {}),
          },
        };
      }),
    };
  },
};

// ---------- fatura satırları ----------

const lineSort: Record<string, { order: (dir: 'asc' | 'desc') => Prisma.InvoiceLineOrderByWithRelationInput; money?: boolean }> = {
  tracking: { order: (d) => ({ trackingNo: d }) },
  carrier: { order: (d) => ({ invoice: { carrier: { name: d } } }) },
  invoice: { order: (d) => ({ invoice: { invoiceNo: d } }) },
  date: { order: (d) => ({ shipDate: { sort: d, nulls: 'last' } }) },
  country: { order: (d) => ({ destCountry: { sort: d, nulls: 'last' } }) },
  status: { order: (d) => ({ status: d }) },
  decision: { order: (d) => ({ decision: d }) },
  billedKg: { order: (d) => ({ billedKg: { sort: d, nulls: 'last' } }) },
  net: { order: (d) => ({ netAmount: d }), money: true },
  expected: { order: (d) => ({ expectedAmount: { sort: d, nulls: 'last' } }), money: true },
  diffAmount: { order: (d) => ({ diffAmount: { sort: d, nulls: 'last' } }), money: true },
};

const invoiceLines: DatasetSpec = {
  id: 'invoice-lines',
  requires: [],
  hasMoney: true,
  filters: (ctx, s) => [
    sel(ctx, 'carrier', 'filter.carrier', s.carriers, true),
    sel(ctx, 'status', 'filter.status', STATUSES.map((v) => ({ value: v, label: ctx.t(`status.${v}`) }))),
    sel(ctx, 'decision', 'filter.decision', DECISIONS.map((v) => ({ value: v, label: ctx.t(`decision.${v}`) })), true),
    sel(ctx, 'diff', 'filter.diff', DIFF_TYPES.map((v) => ({ value: v, label: ctx.t(`diffType.${v}`) }))),
    ...(ctx.can(P.prices) ? [sel(ctx, 'confidence', 'filter.confidence', (['HIGH', 'LOW'] as const).map((v) => ({ value: v, label: ctx.t(`confidence.${v}`) })))] : []),
    sel(ctx, 'scope', 'filter.scope', [
      { value: 'in', label: ctx.t('filter.scope.in') },
      { value: 'pak', label: ctx.t('filter.scope.pak') },
    ]),
    ...(s.currencies.length > 1 && ctx.can(P.prices) ? [sel(ctx, 'currency', 'filter.currency', s.currencies)] : []),
    txt(ctx, 'country', 'filter.country'),
    txt(ctx, 'service', 'filter.service'),
    txt(ctx, 'from', 'filter.from'),
    txt(ctx, 'to', 'filter.to'),
  ],
  columns: (ctx, m) => [
    { id: 'tracking', label: ctx.t('col.tracking'), format: 'text', sortable: true },
    { id: 'carrier', label: ctx.t('col.carrier'), format: 'text', sortable: true },
    { id: 'invoice', label: ctx.t('col.invoice'), format: 'text', sortable: true },
    ...(ctx.can(P.prices)
      ? [
          ...m.currencyColumn(ctx),
          ...m.cols([
            { id: 'diffAmount', label: ctx.t('col.diff'), sortable: true },
            { id: 'net', label: ctx.t('col.billed'), sortable: true },
            { id: 'expected', label: ctx.t('col.expected'), sortable: true },
          ]),
        ]
      : []),
    { id: 'status', label: ctx.t('col.status'), format: 'text', sortable: true },
    { id: 'types', label: ctx.t('col.diffType'), format: 'text' },
    { id: 'decision', label: ctx.t('col.decision'), format: 'text', sortable: true },
    { id: 'disputeOutcome', label: ctx.t('col.disputeOutcome'), format: 'text' },
    ...(ctx.can(P.prices) ? m.cols([{ id: 'recovered', label: ctx.t('col.recovered') }]) : []),
    { id: 'date', label: ctx.t('col.shipDate'), format: 'date', sortable: true },
    { id: 'country', label: ctx.t('col.country'), format: 'text', sortable: true },
    { id: 'service', label: ctx.t('col.service'), format: 'text' },
    { id: 'ourKg', label: ctx.t('col.ourKg'), format: 'number' },
    { id: 'billedKg', label: ctx.t('col.billedKg'), format: 'number', sortable: true },
    ...(ctx.can(P.prices) ? [{ id: 'confidence', label: ctx.t('col.confidence'), format: 'text' as const }] : []),
  ],
  fetch: async (ctx, q, slice) => {
    const { companyId } = ctx;
    const invoice: Prisma.InvoiceWhereInput = { ...invoiceScope(companyId) };
    const range = dateRange(ctx, q);
    if (range) invoice.invoiceDate = range;
    if (q.filters.carrier?.length) invoice.carrierId = { in: q.filters.carrier };
    const currency = q.filters.currency?.[0]?.toUpperCase();
    if (currency) invoice.currency = { equals: currency, mode: 'insensitive' };
    const and: Prisma.InvoiceLineWhereInput[] = [];
    const where: Prisma.InvoiceLineWhereInput = { companyId, invoice };
    const status = oneOf(ctx, q, 'status', STATUSES);
    if (status.length) where.status = { in: status };
    const decision = oneOf(ctx, q, 'decision', DECISIONS);
    if (decision.length) where.decision = { in: decision };
    const diff = oneOf(ctx, q, 'diff', DIFF_TYPES);
    if (diff.length) where.diffTypes = { hasSome: diff };
    const scope = oneOf(ctx, q, 'scope', ['in', 'pak'] as const)[0];
    if (scope === 'pak') where.note = { startsWith: PAK_NOTE };
    if (scope === 'in') and.push({ OR: [{ note: null }, { NOT: { note: { startsWith: PAK_NOTE } } }] });
    // Güven süzgeci para izni ister; tahmini ayrımı tutar bilgisidir.
    const confidence = ctx.can(P.prices) ? oneOf(ctx, q, 'confidence', ['HIGH', 'LOW'] as const)[0] : undefined;
    if (confidence === 'LOW') where.pricing = { path: ['confidence'], equals: 'LOW' };
    // `pricing` boş olan eski satırlar kesin sayılır (compare.ts `isEstimated`); NOT ile yazılırsa NULL satırlar düşer.
    if (confidence === 'HIGH') and.push({ OR: [{ pricing: { equals: Prisma.AnyNull } }, { pricing: { path: ['confidence'], equals: 'HIGH' } }] });
    const country = q.filters.country?.[0]?.trim().toUpperCase();
    if (country) where.destCountry = country;
    const service = q.filters.service?.[0]?.trim();
    if (service) where.service = service;
    if (q.q) {
      const norm = normalizeTracking(q.q);
      and.push({ OR: [...(norm ? [{ trackingNo: { contains: likeEscape(norm) } }] : []), { invoice: { invoiceNo: { contains: likeEscape(q.q), mode: 'insensitive' as const } } }] });
    }
    if (and.length) where.AND = and;

    const sort = pick(lineSort, q.sort);
    const usable = sort && (!sort.money || ctx.can(P.prices)) ? sort : null;
    const orderBy: Prisma.InvoiceLineOrderByWithRelationInput[] = [
      // Tutar sıralamasında önce para birimi: 300 USD ile 500 TRY aynı ölçekte değil.
      ...(usable?.money ? [{ invoice: { currency: 'asc' as const } }] : []),
      ...(usable ? [usable.order(q.dir)] : [{ invoice: { invoiceDate: 'desc' as const } }]),
      { invoiceId: 'asc' },
      { rowIndex: 'asc' },
      { id: 'asc' },
    ];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.invoiceLine.count({ where }), prisma.invoiceLine.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const [total, rows, currencies] = await Promise.all([
      unlessOnly(slice, () => prisma.invoiceLine.count({ where }), slice.only?.length ?? 0),
      prisma.invoiceLine.findMany({
        where: onlyIds(where, slice),
        orderBy,
        ...sliceOf(slice),
        select: {
          id: true,
          invoiceId: true,
          trackingNo: true,
          shipDate: true,
          destCountry: true,
          service: true,
          status: true,
          diffTypes: true,
          decision: true,
          billedKg: true,
          ourChargeableKg: true,
          netAmount: true,
          expectedAmount: true,
          diffAmount: true,
          pricing: true,
          invoice: { select: { invoiceNo: true, currency: true, carrier: { select: { name: true } } } },
        },
      }),
      // Fatura kapsamından: satır süzgeci de hesaba katılsa pahalı olurdu, sonuç en kötü bir fazla "Para birimi" sütunudur.
      unlessOnly(slice, () => prisma.invoice.groupBy({ by: ['currency'], where: invoice }), [] as { currency: string }[]),
    ]);
    // Satırın geçerli itiraz sonucu (fatura ayrıntısındaki satır tablosuyla aynı)
    const disputes = await lineDisputeStates(companyId, rows.map((l) => l.id));
    return {
      total,
      currencies: [...new Set(currencies.map((c) => c.currency.toUpperCase()))],
      rows: rows.map((l) => ({
        id: l.id,
        href: deciship.invoiceLine(l.invoiceId, l.id, l.status),
        cells: {
          tracking: l.trackingNo,
          carrier: l.invoice.carrier.name,
          invoice: l.invoice.invoiceNo,
          date: dayOf(l.shipDate),
          country: l.destCountry ? (countryName(l.destCountry, ctx.locale) ?? l.destCountry) : null,
          service: l.service,
          status: ctx.t(`status.${l.status}`),
          types: l.diffTypes.map((d) => ctx.t(`diffType.${d}` as HubKey)).join(', ') || null,
          // Karar yalnız fark satırında anlamlıdır; diğerlerinde alan varsayılan OPEN durur.
          decision: l.status === 'DIFF' ? ctx.t(`decision.${l.decision}`) : null,
          disputeOutcome: disputes.has(l.id) ? ctx.t(`disputeOutcome.${disputes.get(l.id)!.outcome}`) : null,
          ourKg: numOrNull(l.ourChargeableKg),
          billedKg: numOrNull(l.billedKg),
          ...(ctx.can(P.prices)
            ? {
                currency: l.invoice.currency.toUpperCase(),
                recovered: disputes.get(l.id)?.recoveredAmount ?? null,
                net: num(l.netAmount),
                expected: numOrNull(l.expectedAmount),
                diffAmount: numOrNull(l.diffAmount),
                confidence: l.status === 'DIFF' ? ctx.t(readLinePricing(l.pricing)?.confidence === 'LOW' ? 'confidence.LOW' : 'confidence.HIGH') : null,
              }
            : {}),
        },
      })),
    };
  },
};

// ---------- ölçümler ----------

const measurementSort: Record<string, (dir: 'asc' | 'desc') => Prisma.MeasurementOrderByWithRelationInput> = {
  tracking: (d) => ({ trackingNo: d }),
  method: (d) => ({ dimMethod: d }),
  kg: (d) => ({ weightKg: d }),
  at: (d) => ({ measuredAt: d }),
};

const measurements: DatasetSpec = {
  id: 'measurements',
  requires: [P.measurements],
  filters: (ctx, s) => [
    sel(ctx, 'method', 'filter.method', DIM_METHODS.map((v) => ({ value: v, label: ctx.t(`method.${v}`) }))),
    sel(ctx, 'user', 'filter.user', s.users),
    sel(ctx, 'photos', 'filter.photos', [
      { value: 'none', label: ctx.t('filter.photos.none') },
      { value: 'some', label: ctx.t('filter.photos.some') },
    ]),
    txt(ctx, 'from', 'filter.from'),
    txt(ctx, 'to', 'filter.to'),
  ],
  columns: (ctx) => [
    { id: 'tracking', label: ctx.t('col.tracking'), format: 'text', sortable: true },
    { id: 'method', label: ctx.t('col.method'), format: 'text', sortable: true },
    { id: 'dims', label: ctx.t('col.dims'), format: 'text' },
    { id: 'kg', label: ctx.t('col.kg'), format: 'number', sortable: true },
    { id: 'desi', label: ctx.t('col.desi'), format: 'number' },
    { id: 'by', label: ctx.t('col.measuredBy'), format: 'text' },
    { id: 'at', label: ctx.t('col.time'), format: 'datetime', sortable: true },
    { id: 'photos', label: ctx.t('col.photos'), format: 'number' },
    { id: 'version', label: ctx.t('col.version'), format: 'number' },
  ],
  fetch: async (ctx, q, slice) => {
    const { companyId } = ctx;
    const where: Prisma.MeasurementWhereInput = { ...measurementScope(companyId) };
    const range = await measuredDateRange(ctx, q);
    if (range) where.measuredAt = range;
    const method = oneOf(ctx, q, 'method', DIM_METHODS);
    if (method.length) where.dimMethod = { in: method };
    if (q.filters.user?.length) where.measuredById = { in: q.filters.user };
    const photos = oneOf(ctx, q, 'photos', ['none', 'some'] as const)[0];
    if (photos === 'none') where.files = { none: {} };
    if (photos === 'some') where.files = { some: {} };
    if (q.q) {
      const norm = normalizeTracking(q.q);
      where.OR = [...(norm ? [{ trackingNo: { contains: likeEscape(norm) } }] : []), { trackingRaw: { contains: likeEscape(q.q), mode: 'insensitive' as const } }];
    }
    const sort = pick(measurementSort, q.sort);
    const orderBy: Prisma.MeasurementOrderByWithRelationInput[] = [sort ? sort(q.dir) : { measuredAt: 'desc' }, { id: 'asc' }];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.measurement.count({ where }), prisma.measurement.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const [total, rows, settings] = await Promise.all([
      unlessOnly(slice, () => prisma.measurement.count({ where }), slice.only?.length ?? 0),
      prisma.measurement.findMany({
        where: onlyIds(where, slice),
        orderBy,
        ...sliceOf(slice),
        select: { id: true, trackingNo: true, dimMethod: true, lengthCm: true, widthCm: true, heightCm: true, weightKg: true, measuredById: true, measuredAt: true, version: true },
      }),
      companySettings(companyId),
    ]);
    // KALANLAR 6.14: fotoğraf sayısı yalnız sayfadaki ölçümler için (Prisma `_count` firmanın bütün dosyalarını gruplayıp birleştiriyordu).
    const [names, photoRows] = await Promise.all([
      memberNames(companyId, rows.map((r) => r.measuredById)),
      rows.length
        ? prisma.file.groupBy({ by: ['measurementId'], where: { companyId, measurementId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
        : Promise.resolve([]),
    ]);
    const photoCount = new Map(photoRows.map((p) => [p.measurementId, p._count._all]));
    return {
      total,
      rows: rows.map((m) => {
        const d = { l: num(m.lengthCm), w: num(m.widthCm), h: num(m.heightCm) };
        return {
          id: m.id,
          href: deciship.measurement(m.id),
          cells: {
            tracking: m.trackingNo,
            method: ctx.t(`method.${m.dimMethod}`),
            dims: `${d.l} × ${d.w} × ${d.h}`,
            kg: num(m.weightKg),
            desi: desi(d, settings.desiDivisor),
            by: names.get(m.measuredById) ?? null,
            at: m.measuredAt.toISOString(),
            photos: photoCount.get(m.id) ?? 0,
            version: m.version,
          },
        };
      }),
    };
  },
};

// ---------- tarifeler ----------

const tariffSort: Record<string, (dir: 'asc' | 'desc') => Prisma.TariffOrderByWithRelationInput> = {
  name: (d) => ({ name: d }),
  carrier: (d) => ({ carrier: { name: d } }),
  from: (d) => ({ validFrom: { sort: d, nulls: 'last' } }),
  to: (d) => ({ validTo: { sort: d, nulls: 'last' } }),
};

const tariffs: DatasetSpec = {
  id: 'tariffs',
  requires: [],
  filters: (ctx, s) => [
    sel(ctx, 'carrier', 'filter.carrier', s.carriers, true),
    sel(ctx, 'active', 'filter.active', [
      { value: 'yes', label: ctx.t('filter.active.yes') },
      { value: 'no', label: ctx.t('filter.active.no') },
    ]),
  ],
  columns: (ctx) => [
    { id: 'name', label: ctx.t('col.tariff'), format: 'text', sortable: true },
    { id: 'carrier', label: ctx.t('col.carrier'), format: 'text', sortable: true },
    { id: 'service', label: ctx.t('col.service'), format: 'text' },
    { id: 'divisor', label: ctx.t('col.divisor'), format: 'number' },
    { id: 'from', label: ctx.t('col.from'), format: 'date', sortable: true },
    { id: 'to', label: ctx.t('col.to'), format: 'date', sortable: true },
    { id: 'rates', label: ctx.t('col.rates'), format: 'number' },
    { id: 'countries', label: ctx.t('col.countries'), format: 'number' },
    { id: 'active', label: ctx.t('col.active'), format: 'text' },
    { id: 'default', label: ctx.t('col.default'), format: 'text' },
    // Para birimi, indirim ve yakıt oranı sözleşme fiyatının parçasıdır.
    ...(ctx.can(P.prices)
      ? ([
          { id: 'currency', label: ctx.t('col.currency'), format: 'text' },
          { id: 'discount', label: ctx.t('col.discount'), format: 'percent' },
          { id: 'fuel', label: ctx.t('col.fuel'), format: 'percent' },
        ] as HubColumn[])
      : []),
  ],
  fetch: async (ctx, q, slice) => {
    const where: Prisma.TariffWhereInput = { companyId: ctx.companyId };
    if (q.filters.carrier?.length) where.carrierId = { in: q.filters.carrier };
    const active = oneOf(ctx, q, 'active', ['yes', 'no'] as const)[0];
    if (active) where.active = active === 'yes';
    if (q.q) where.OR = [{ name: { contains: likeEscape(q.q), mode: 'insensitive' } }, { service: { contains: likeEscape(q.q), mode: 'insensitive' } }, { carrier: { name: { contains: likeEscape(q.q), mode: 'insensitive' } } }];
    const sort = pick(tariffSort, q.sort);
    const orderBy: Prisma.TariffOrderByWithRelationInput[] = sort ? [sort(q.dir), { id: 'asc' }] : [{ carrier: { name: 'asc' } }, { isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.tariff.count({ where }), prisma.tariff.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const [total, rows] = await Promise.all([
      unlessOnly(slice, () => prisma.tariff.count({ where }), slice.only?.length ?? 0),
      prisma.tariff.findMany({
        where: onlyIds(where, slice),
        orderBy,
        ...sliceOf(slice),
        select: {
          id: true,
          name: true,
          service: true,
          currency: true,
          divisor: true,
          validFrom: true,
          validTo: true,
          active: true,
          isDefault: true,
          discountPct: true,
          fuelPct: true,
          carrier: { select: { name: true } },
          _count: { select: { rates: true, zones: true } },
        },
      }),
    ]);
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        href: deciship.tariff(r.id),
        cells: {
          name: r.name,
          carrier: r.carrier.name,
          service: r.service,
          divisor: r.divisor,
          from: dayOf(r.validFrom),
          to: dayOf(r.validTo),
          rates: r._count.rates,
          countries: r._count.zones,
          active: ctx.t(r.active ? 'common.yes' : 'common.no'),
          default: ctx.t(r.isDefault ? 'common.yes' : 'common.no'),
          ...(ctx.can(P.prices) ? { currency: r.currency.toUpperCase(), discount: num(r.discountPct), fuel: num(r.fuelPct) } : {}),
        },
      })),
    };
  },
};

// ---------- taşıyıcılar ----------

const carriers: DatasetSpec = {
  id: 'carriers',
  requires: [],
  filters: (ctx) => [
    sel(ctx, 'active', 'filter.active', [
      { value: 'yes', label: ctx.t('filter.active.yes') },
      { value: 'no', label: ctx.t('filter.active.no') },
    ]),
  ],
  columns: (ctx) => [
    { id: 'name', label: ctx.t('col.carrier'), format: 'text', sortable: true },
    { id: 'code', label: ctx.t('col.code'), format: 'text', sortable: true },
    { id: 'active', label: ctx.t('col.active'), format: 'text' },
    { id: 'tariffs', label: ctx.t('col.tariffs'), format: 'number' },
    { id: 'invoices', label: ctx.t('col.invoices'), format: 'number' },
    { id: 'lastInvoice', label: ctx.t('col.lastInvoice'), format: 'date' },
  ],
  fetch: async (ctx, q, slice) => {
    const where: Prisma.CarrierWhereInput = { companyId: ctx.companyId };
    const active = oneOf(ctx, q, 'active', ['yes', 'no'] as const)[0];
    if (active) where.active = active === 'yes';
    if (q.q) where.OR = [{ name: { contains: likeEscape(q.q), mode: 'insensitive' } }, { code: { contains: likeEscape(q.q), mode: 'insensitive' } }];
    const orderBy: Prisma.CarrierOrderByWithRelationInput[] = [q.sort === 'code' ? { code: q.dir } : q.sort === 'name' ? { name: q.dir } : { name: 'asc' }, { id: 'asc' }];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.carrier.count({ where }), prisma.carrier.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const [total, rows] = await Promise.all([
      unlessOnly(slice, () => prisma.carrier.count({ where }), slice.only?.length ?? 0),
      prisma.carrier.findMany({ where: onlyIds(where, slice), orderBy, ...sliceOf(slice), select: { id: true, name: true, code: true, active: true, _count: { select: { tariffs: true } } } }),
    ]);
    // Fatura sayısı Pano'yla aynı kümeden: silinen ve örnek faturalar yok.
    const stats = rows.length
      ? await prisma.invoice.groupBy({ by: ['carrierId'], where: { ...invoiceScope(ctx.companyId), carrierId: { in: rows.map((r) => r.id) } }, _count: { _all: true }, _max: { invoiceDate: true } })
      : [];
    const byCarrier = new Map(stats.map((s) => [s.carrierId, s]));
    return {
      total,
      rows: rows.map((r) => {
        const s = byCarrier.get(r.id);
        return {
          id: r.id,
          href: deciship.tariffs(r.id),
          cells: { name: r.name, code: r.code, active: ctx.t(r.active ? 'common.yes' : 'common.no'), tariffs: r._count.tariffs, invoices: s?._count._all ?? 0, lastInvoice: dayOf(s?._max.invoiceDate) },
        };
      }),
    };
  },
};

// ---------- hazır koliler ----------

const presetSort: Record<string, (d: 'asc' | 'desc') => Prisma.BoxPresetOrderByWithRelationInput> = {
  name: (d) => ({ name: d }),
  lengthCm: (d) => ({ lengthCm: d }),
  widthCm: (d) => ({ widthCm: d }),
  heightCm: (d) => ({ heightCm: d }),
  sortOrder: (d) => ({ sortOrder: d }),
};

/**
 * Ayar yetkisi olmayan etkin olmayan koliyi görmez: `GET /box-presets` ile aynı kural. Tutar ve kişi adı yoktur.
 * Kullanım sayısı ölçüm kaydından gelir: ölçümleri görme izni ister.
 */
const boxPresets: DatasetSpec = {
  id: 'box-presets',
  requires: [],
  filters: (ctx) =>
    ctx.can(P.settings)
      ? [
          sel(ctx, 'active', 'filter.active', [
            { value: 'yes', label: ctx.t('filter.active.yes') },
            { value: 'no', label: ctx.t('filter.active.no') },
          ]),
        ]
      : [],
  columns: (ctx) => [
    { id: 'name', label: ctx.t('col.boxPreset'), format: 'text', sortable: true },
    { id: 'lengthCm', label: ctx.t('col.lengthCm'), format: 'number', sortable: true },
    { id: 'widthCm', label: ctx.t('col.widthCm'), format: 'number', sortable: true },
    { id: 'heightCm', label: ctx.t('col.heightCm'), format: 'number', sortable: true },
    { id: 'desi', label: ctx.t('col.desi'), format: 'number' },
    { id: 'active', label: ctx.t('col.active'), format: 'text' },
    ...(ctx.can(P.measurements) ? [{ id: 'measurements', label: ctx.t('col.presetMeasurements'), format: 'number' as const }] : []),
    { id: 'sortOrder', label: ctx.t('col.sortOrder'), format: 'number', sortable: true, hiddenByDefault: true },
  ],
  fetch: async (ctx, q, slice) => {
    const { companyId } = ctx;
    const where: Prisma.BoxPresetWhereInput = { companyId };
    const active = oneOf(ctx, q, 'active', ['yes', 'no'] as const)[0];
    const manager = ctx.can(P.settings);
    if (!manager) {
      // Süzgeç sunulmaz ama adresle gelebilir: etkin olmayan yine açılmaz.
      if (active === 'no') where.id = { in: [] };
      where.active = true;
    } else if (active) where.active = active === 'yes';
    if (q.q) where.name = { contains: likeEscape(q.q), mode: 'insensitive' };
    const sort = pick(presetSort, q.sort);
    const orderBy: Prisma.BoxPresetOrderByWithRelationInput[] = sort ? [sort(q.dir), { id: 'asc' }] : [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.boxPreset.count({ where }), prisma.boxPreset.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const seesUse = ctx.can(P.measurements);
    const [total, rows, settings] = await Promise.all([
      unlessOnly(slice, () => prisma.boxPreset.count({ where }), slice.only?.length ?? 0),
      prisma.boxPreset.findMany({
        where: onlyIds(where, slice),
        orderBy,
        ...sliceOf(slice),
        select: {
          id: true,
          name: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
          sortOrder: true,
          active: true,
          ...(seesUse ? { _count: { select: { measurements: { where: measurementScope(companyId) } } } } : {}),
        },
      }),
      companySettings(companyId),
    ]);
    return {
      total,
      rows: rows.map((r) => {
        const d = { l: num(r.lengthCm), w: num(r.widthCm), h: num(r.heightCm) };
        return {
          id: r.id,
          ...(manager ? { href: deciship.settings } : {}),
          cells: {
            name: r.name,
            lengthCm: d.l,
            widthCm: d.w,
            heightCm: d.h,
            desi: desi(d, settings.desiDivisor),
            active: ctx.t(r.active ? 'common.yes' : 'common.no'),
            ...(seesUse ? { measurements: (r as { _count?: { measurements: number } })._count?.measurements ?? 0 } : {}),
            sortOrder: r.sortOrder,
          },
        };
      }),
    };
  },
};

// ---------- denetim kayıtları ----------

const auditLog: DatasetSpec = {
  id: 'audit-log',
  requires: [P.reports],
  filters: (ctx) => [sel(ctx, 'group', 'filter.group', ACTIVITY_GROUPS.filter((g) => visibleActions(ctx, g).length).map((g) => ({ value: g, label: ctx.t(`group.${g}`) })))],
  columns: (ctx) => [
    { id: 'at', label: ctx.t('col.time'), format: 'datetime', sortable: true },
    { id: 'actor', label: ctx.t('col.actor'), format: 'text' },
    { id: 'action', label: ctx.t('col.action'), format: 'text' },
    { id: 'target', label: ctx.t('col.target'), format: 'text' },
  ],
  fetch: async (ctx, q, slice) => {
    const group = oneOf(ctx, q, 'group', ACTIVITY_GROUPS)[0];
    const where = await auditWhere(ctx, visibleActions(ctx, group), q.q);
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: q.sort === 'at' ? q.dir : 'desc' }, { id: 'desc' }];
    if (slice.idsOnly) {
      const [total, ids] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.findMany({ where, orderBy, select: { id: true }, take: MAX_EXPORT_ROWS })]);
      return idList(total, ids);
    }
    const [total, rows] = await Promise.all([unlessOnly(slice, () => prisma.auditLog.count({ where }), slice.only?.length ?? 0), activityRows(ctx, onlyIds(where, slice), { ...sliceOf(slice), orderBy })]);
    return { total, rows: rows.map((r) => ({ id: r.id, ...(r.href ? { href: r.href } : {}), cells: { at: r.at, actor: r.actor, action: r.action, target: r.target ?? null } })) };
  },
};

const SPECS: DatasetSpec[] = [invoices, invoiceLines, measurements, tariffs, carriers, boxPresets, auditLog];

const allowed = (ctx: HubCtx, spec: DatasetSpec) => spec.requires.every((p) => ctx.can(p));

function specOf(ctx: HubCtx, id: string): DatasetSpec {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) throw hubError(404, 'NOT_FOUND', ctx.t('err.dataset'));
  if (!allowed(ctx, spec)) throw hubError(403, 'FORBIDDEN', ctx.t('err.forbidden'));
  return spec;
}

export async function listDatasets(ctx: HubCtx): Promise<HubDatasetList> {
  const { companyId } = ctx;
  const [country, carrierRows, currencyRows, measurerRows] = await Promise.all([
    companyCountry(companyId),
    prisma.carrier.findMany({ where: { companyId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.invoice.groupBy({ by: ['currency'], where: invoiceScope(companyId) }),
    ctx.can(P.measurements) ? prisma.measurement.groupBy({ by: ['measuredById'], where: measurementScope(companyId) }) : Promise.resolve([]),
  ]);
  const names = await memberNames(companyId, measurerRows.map((m) => m.measuredById));
  const shared: SharedOptions = {
    carriers: carrierRows.map((c) => ({ value: c.id, label: c.name })),
    currencies: [...new Set(currencyRows.map((c) => c.currency.toUpperCase()))].sort().map((c) => ({ value: c, label: c })),
    users: [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], ctx.locale)).map(([value, label]) => ({ value, label })),
    country,
  };
  const canExport = ctx.can(P.export);
  const datasets: HubDatasetDef[] = SPECS.filter((s) => allowed(ctx, s)).map((s) => ({
    id: s.id,
    label: ctx.t(`dataset.${s.id}` as HubKey),
    description: ctx.t(`dataset.${s.id}.desc` as HubKey),
    filters: s.filters(ctx, shared),
    exportable: canExport,
  }));
  return { product: 'deciship', datasets };
}

export async function datasetPage(ctx: HubCtx, id: string, query: unknown): Promise<HubDatasetPage> {
  const spec = specOf(ctx, id);
  const q = parseDatasetQuery(query, ctx);
  const { rows, total, currencies } = await spec.fetch(ctx, q, { skip: (q.page - 1) * q.pageSize, take: q.pageSize });
  const columns = spec.columns(ctx, moneyColumns(currencies, false), await companyCountry(ctx.companyId));
  // Sütunu olmayan hücre gönderilmez (ör. tek para biriminde `currency`).
  const known = new Set(columns.map((c) => c.id));
  const trimmed = rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => known.has(k))) }));
  return { id, columns, rows: trimmed, page: q.page, pageSize: q.pageSize, total };
}

/**
 * Dışa aktarma: başta eşleşen kimlikler sırasıyla alınır, satırlar partiler hâlinde bu listeden okunur. Akış sırasında gelen
 * yeni satır kaymaya yol açmaz. Silinen ya da süzgeç dışına çıkan satır yüzünden parti eksik kalırsa üreteç hata verir:
 * eksik dosya tamamlanmış görünmez. Bir sonraki parti arasında veritabanı bağlantısı tutulmaz.
 */
export async function datasetExport(ctx: HubCtx, id: string, query: unknown) {
  const spec = specOf(ctx, id);
  const q = parseDatasetQuery(query, ctx);
  const snapshot = await spec.fetch(ctx, q, { skip: 0, take: 0, idsOnly: true });
  if (snapshot.total > MAX_EXPORT_ROWS) throw hubError(400, 'EXPORT_TOO_LARGE', ctx.t('err.exportTooLarge', { total: snapshot.total, max: MAX_EXPORT_ROWS }));
  const ids = snapshot.ids ?? [];
  const columns = spec.columns(ctx, moneyColumns(undefined, true), await companyCountry(ctx.companyId));
  const { timeZone } = await companySettings(ctx.companyId);
  async function* batches() {
    for (let i = 0; i < ids.length; i += EXPORT_BATCH) {
      const only = ids.slice(i, i + EXPORT_BATCH);
      const { rows } = await spec.fetch(ctx, q, { skip: 0, take: only.length, only });
      if (rows.length !== only.length) throw new Error(`Dışa aktarma eksik kaldı: ${id}, ${only.length} satır beklendi, ${rows.length} geldi`);
      yield rows;
    }
  }
  return { columns, total: ids.length, batches, query: q, timeZone };
}
