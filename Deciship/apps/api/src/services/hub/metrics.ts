/**
 * Merkez sayılarının tek kaynağı.
 *
 * Fatura toplamları Pano ile aynı yerden okunur: `Invoice.totals` (compare.ts `computeTotals`). Saklı toplamın yetmediği
 * kırılımlar (hizmet, ülke, karar...) satırlardan SQL ile toplanır; `OVERCHARGE_SQL` ve `ESTIMATED_SQL`
 * `computeTotals`'ın kuralıyla bire birdir, testler kırılımların saklı toplama eşit çıktığını doğrular.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PAK_NOTE, disputeDeadlines, turkeyDate } from '@deciship/core';
import { prisma, Prisma } from '../../db.ts';
import { firmCountry, readSettings } from '../../lib/settings.ts';
import { zonedRange } from '../../lib/time.ts';
import { sum } from '../../lib/util.ts';
import { defaultTariff, type InvoiceTotals } from '../compare.ts';
import { isoShift, type Period } from './period.ts';

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** Sıfıra bölme yok: payda 0 ise oran yoktur. */
export const pct = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : null);

export type InvoiceRow = { id: string; currency: string; invoiceNo: string; invoiceDate: Date; carrierId: string; totals: InvoiceTotals };

export const invoiceScope = (companyId: string) => ({ companyId, deletedAt: null, isSample: false });

export async function loadInvoices(companyId: string, p: Period): Promise<InvoiceRow[]> {
  const rows = await prisma.invoice.findMany({
    where: { ...invoiceScope(companyId), invoiceDate: { gte: p.start, lt: p.end } },
    select: { id: true, currency: true, invoiceNo: true, invoiceDate: true, carrierId: true, totals: true },
  });
  return rows.map((r) => ({ ...r, currency: r.currency.toUpperCase(), totals: r.totals as InvoiceTotals }));
}

export type Aggregate = {
  count: number;
  lines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  billed: number;
  overcharge: number;
  verified: number;
  estimated: number;
  flagged: number;
  fxMissing: number;
};

/** Pano'nun faturalar üzerindeki toplaması (routes/dashboard.ts). Sayılar her para biriminde geçerlidir, tutarlar değil. */
export function aggregateTotals(invoices: Pick<InvoiceRow, 'totals'>[]): Aggregate {
  const totals = invoices.map((i) => i.totals);
  const agg = (k: keyof InvoiceTotals) => totals.reduce((a, t) => a + (Number(t?.[k]) || 0), 0);
  const money = (k: keyof InvoiceTotals) => sum(totals.map((t) => Number(t?.[k]) || 0));
  return {
    count: invoices.length,
    lines: agg('lines'),
    match: agg('match'),
    diff: agg('diff'),
    unmatched: agg('unmatched'),
    noTariff: agg('noTariff'),
    billed: money('billedTotal'),
    overcharge: money('overchargeTotal'),
    verified: money('verifiedTotal'),
    estimated: money('estimatedOverchargeTotal'),
    flagged: agg('flaggedLines'),
    fxMissing: agg('fxMissing'),
  };
}

/** Pano'nun ölçüm kapsamı: (satır − eşleşmeyen) / satır, tek ondalık. Satır yoksa `null` (Pano 0 yazar). */
export const coveragePct = (lines: number, unmatched: number) => (lines ? Math.round(((lines - unmatched) / lines) * 1000) / 10 : null);

/** Para birimleri toplanmaz. Baş rakam firma para biriminde; o para biriminde fatura yoksa en çok satırı olan para biriminde. */
export function primaryCurrency(invoices: Pick<InvoiceRow, 'currency' | 'totals'>[], companyCurrency: string): { primary: string; others: string[] } {
  const byCur = new Map<string, number>();
  for (const i of invoices) byCur.set(i.currency, (byCur.get(i.currency) ?? 0) + (Number(i.totals?.lines) || 0));
  const company = companyCurrency.toUpperCase();
  const ranked = [...byCur.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const primary = byCur.has(company) ? company : (ranked[0] ?? company);
  return { primary, others: ranked.filter((c) => c !== primary) };
}

/** Firmanın çözülmüş ülkesi, bilinmiyorsa null (`firmCountry`). */
export async function companyCountry(companyId: string): Promise<string | null> {
  const company = await prisma.company.findFirst({ where: { id: companyId }, select: { settings: true, nameVersion: true } });
  return company ? firmCountry(company) : null;
}

/**
 * 19-B14: bir isteğin içinde firma ayarı bir kez okunur (Analiz isteği 6+ kez okuyup her seferinde Merkez kapısında yuva
 * alıyordu). Kapsam isteğin kendisi (`hub/limiter.ts` `limited` açar); kapsam dışında her çağrı okur (eski davranış).
 */
const settingsMemo = new AsyncLocalStorage<Map<string, Promise<ReturnType<typeof readSettings>>>>();

export function withSettingsMemo<T>(work: () => Promise<T>): Promise<T> {
  return settingsMemo.run(new Map(), work);
}

export function companySettings(companyId: string): Promise<ReturnType<typeof readSettings>> {
  const memo = settingsMemo.getStore();
  const hit = memo?.get(companyId);
  if (hit) return hit;
  const read = prisma.company.findFirst({ where: { id: companyId }, select: { settings: true } }).then((company) => readSettings(company?.settings));
  memo?.set(companyId, read);
  return read;
}

// ---------- satır toplamları ----------

/** computeTotals: `overchargeTotal` kümesi. */
const OVERCHARGE_SQL = Prisma.sql`l."status" = 'DIFF' AND l."decision" <> 'ACCEPTED' AND COALESCE(l."pricing"->>'confidence', '') <> 'LOW'`;
/** computeTotals: `estimatedOverchargeTotal` kümesi. */
const ESTIMATED_SQL = Prisma.sql`l."status" = 'DIFF' AND l."decision" <> 'ACCEPTED' AND COALESCE(l."pricing"->>'confidence', '') = 'LOW'`;
const PAK_LIKE = `${PAK_NOTE}%`;

/**
 * Satırın geçerli itiraz satırı (geri çekilmemiş en son tur), yoksa boş; `measures` `e` adıyla okur.
 * services/disputes.ts `disputeFacts` ile aynı kural: Pano, Merkez ve itiraz listesi aynı rakamı verir. B12: yerini yeniye
 * bırakmış turda RECOVERED ve (K38) satır hâlâ itiraz listesindeyse REJECTED geçerlidir; orada sonuçsuz kalan satır yeniden
 * gönderilecek satırdır.
 *
 * KALANLAR 6.14: satır başına alt sorgu (LATERAL) yerine firmanın itiraz satırları bir kez okunur (satır başına en son tur,
 * `DISTINCT ON`) ve karma birleştirmeyle bağlanır; kural aynı (en son turdaki satır koşulu sağlamıyorsa satırın geçerli itirazı
 * yok, daha eski tura bakılmaz). 1 milyon satırlı firmada yıllık özette 515 bin dizin aramasıydı.
 */
const effectiveDisputeLine = (companyId: string) => Prisma.sql`LEFT JOIN (
      SELECT DISTINCT ON (dl."invoiceLineId") dl."invoiceLineId", dl."outcome"::text AS "outcome", dl."claimedAmount", dl."recoveredAmount",
        d."supersededAt" IS NOT NULL AS "superseded"
      FROM "DisputeLine" dl JOIN "Dispute" d ON d."id" = dl."disputeId"
      WHERE dl."companyId" = ${companyId} AND d."companyId" = ${companyId} AND d."withdrawnAt" IS NULL
      ORDER BY dl."invoiceLineId", d."round" DESC
    ) e ON e."invoiceLineId" = l."id"
      AND (NOT e."superseded" OR e."outcome" = 'RECOVERED' OR (e."outcome" = 'REJECTED' AND l."decision" = 'VERIFIED' AND l."status" = 'DIFF'))`;

/**
 * Bir kırılımın ölçüleri. Tutarlar `numeric` toplanır, kuruş kaybı yoktur.
 * Sayılar para biriminden bağımsızdır. `amountCurrency` verilirse tutarlar ve `amountLines` yalnız o para biriminden gelir:
 * para birimleri toplanmaz ama satır sayısı ve kapsam tüm faturaları kapsar (Pano ile aynı).
 */
function measures(amountCurrency: string | null | undefined) {
  const inCurrency = amountCurrency ? Prisma.sql`upper(i."currency") = ${amountCurrency}` : Prisma.sql`TRUE`;
  return Prisma.sql`
  count(*)::int AS "lines",
  (count(*) FILTER (WHERE l."status" = 'MATCH'))::int AS "match",
  (count(*) FILTER (WHERE l."status" = 'DIFF'))::int AS "diff",
  (count(*) FILTER (WHERE l."status" = 'UNMATCHED'))::int AS "unmatched",
  (count(*) FILTER (WHERE l."status" = 'NO_TARIFF'))::int AS "noTariff",
  (count(*) FILTER (WHERE l."status" = 'DIFF' AND l."decision" = 'OPEN'))::int AS "open",
  (count(*) FILTER (WHERE ${inCurrency}))::int AS "amountLines",
  COALESCE(sum(l."netAmount") FILTER (WHERE ${inCurrency}), 0)::text AS "billed",
  COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${inCurrency} AND ${OVERCHARGE_SQL}), 0)::text AS "overcharge",
  COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${inCurrency} AND ${ESTIMATED_SQL}), 0)::text AS "estimated",
  COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${inCurrency} AND l."status" = 'DIFF' AND l."decision" = 'VERIFIED'), 0)::text AS "verified",
  COALESCE(sum(e."recoveredAmount") FILTER (WHERE ${inCurrency} AND e."outcome" = 'RECOVERED'), 0)::text AS "recovered",
  COALESCE(sum(e."claimedAmount") FILTER (WHERE ${inCurrency} AND e."outcome" = 'PENDING'), 0)::text AS "disputePending"`;
}

export type LineMeasures = {
  lines: number;
  /** Tutarlara giren satır: seçili para birimindekiler. */
  amountLines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  open: number;
  billed: number;
  overcharge: number;
  estimated: number;
  verified: number;
  /** İtiraz: geçerli satırı RECOVERED olanların geri alınan payı (services/disputes.ts `disputeFacts` ile aynı kural). */
  recovered: number;
  /** İtiraz: gönderilmiş, sonuç bekleyen talep. */
  disputePending: number;
};
type MoneyKeys = 'billed' | 'overcharge' | 'estimated' | 'verified' | 'recovered' | 'disputePending';
type RawMeasures = Omit<LineMeasures, MoneyKeys> & Record<MoneyKeys, string>;

const toMeasures = (r: RawMeasures): LineMeasures => ({
  lines: r.lines,
  amountLines: r.amountLines,
  match: r.match,
  diff: r.diff,
  unmatched: r.unmatched,
  noTariff: r.noTariff,
  open: r.open,
  billed: Number(r.billed),
  overcharge: Number(r.overcharge),
  estimated: Number(r.estimated),
  verified: Number(r.verified),
  recovered: Number(r.recovered),
  disputePending: Number(r.disputePending),
});

export const emptyMeasures = (): LineMeasures => ({ lines: 0, amountLines: 0, match: 0, diff: 0, unmatched: 0, noTariff: 0, open: 0, billed: 0, overcharge: 0, estimated: 0, verified: 0, recovered: 0, disputePending: 0 });

export type LineFilter = {
  currency?: string | null;
  carrierIds?: string[];
  service?: string;
  country?: string;
  /** normalizeTracking'den geçmiş metin */
  tracking?: string;
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Firma, dönem ve süzgeç kapsamı. Pano ile aynı: silinen ve örnek faturalar yok. */
function lineScope(companyId: string, p: Period, f: LineFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`l."companyId" = ${companyId}`,
    Prisma.sql`i."companyId" = ${companyId}`,
    Prisma.sql`i."deletedAt" IS NULL`,
    Prisma.sql`NOT i."isSample"`,
    Prisma.sql`i."invoiceDate" >= ${p.start}`,
    Prisma.sql`i."invoiceDate" < ${p.end}`,
  ];
  if (f.currency) parts.push(Prisma.sql`upper(i."currency") = ${f.currency}`);
  if (f.carrierIds?.length) parts.push(Prisma.sql`i."carrierId" = ANY(${f.carrierIds}::text[])`);
  if (f.service) parts.push(Prisma.sql`l."service" = ${f.service}`);
  if (f.country) parts.push(Prisma.sql`l."destCountry" = ${f.country}`);
  if (f.tracking) parts.push(Prisma.sql`l."trackingNo" LIKE ${`%${likeEscape(f.tracking)}%`}`);
  return Prisma.join(parts, ' AND ');
}

export type Dimensions = {
  total: LineMeasures;
  byCarrier: Map<string, LineMeasures>;
  byType: Map<string, LineMeasures>;
  byCountry: Map<string | null, LineMeasures>;
  byService: Map<string | null, LineMeasures>;
  byDecision: Map<string, LineMeasures>;
  byDay: Map<string, LineMeasures>;
  /** kararı verilmiş satırlarda, yüklemeden karara ortalama gün */
  avgDecisionDays: number | null;
};

/** Tüm kırılımlar tek taramada (GROUPING SETS): satır sayısıyla sorgu sayısı artmaz. */
export async function lineDimensions(companyId: string, p: Period, f: LineFilter = {}, amountCurrency?: string | null): Promise<Dimensions> {
  const rows = await prisma.$queryRaw<
    (RawMeasures & { g: number; carrierId: string | null; dtype: string | null; country: string | null; service: string | null; decision: string | null; day: string | null; decisionDays: number | null })[]
  >`
    SELECT
      GROUPING(i."carrierId", l."diffTypes"[1], l."destCountry", l."service", l."decision", i."invoiceDate")::int AS "g",
      i."carrierId" AS "carrierId",
      l."diffTypes"[1] AS "dtype",
      l."destCountry" AS "country",
      l."service" AS "service",
      l."decision"::text AS "decision",
      to_char(i."invoiceDate", 'YYYY-MM-DD') AS "day",
      (avg(EXTRACT(EPOCH FROM (l."decidedAt" - i."createdAt"))) FILTER (WHERE l."status" = 'DIFF' AND l."decision" <> 'OPEN' AND l."decidedAt" IS NOT NULL) / 86400)::float8 AS "decisionDays",
      ${measures(amountCurrency)}
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    ${effectiveDisputeLine(companyId)}
    WHERE ${lineScope(companyId, p, f)}
    GROUP BY GROUPING SETS ((), (i."carrierId"), (l."diffTypes"[1]), (l."destCountry"), (l."service"), (l."decision"), (i."invoiceDate"))`;
  const out: Dimensions = {
    total: emptyMeasures(),
    byCarrier: new Map(),
    byType: new Map(),
    byCountry: new Map(),
    byService: new Map(),
    byDecision: new Map(),
    byDay: new Map(),
    avgDecisionDays: null,
  };
  // GROUPING bit maskesi: 6 sütun, soldaki en yüksek bit; grupta olan sütunun biti 0.
  const ONLY = { all: 0b111111, carrier: 0b011111, type: 0b101111, country: 0b110111, service: 0b111011, decision: 0b111101, day: 0b111110 };
  for (const r of rows) {
    const m = toMeasures(r);
    if (r.g === ONLY.all) {
      out.total = m;
      out.avgDecisionDays = r.decisionDays == null ? null : round1(r.decisionDays);
    } else if (r.g === ONLY.carrier) out.byCarrier.set(r.carrierId!, m);
    else if (r.g === ONLY.type) {
      if (r.dtype) out.byType.set(r.dtype, m);
    } else if (r.g === ONLY.country) out.byCountry.set(r.country, m);
    else if (r.g === ONLY.service) out.byService.set(r.service, m);
    else if (r.g === ONLY.decision) out.byDecision.set(r.decision!, m);
    else if (r.g === ONLY.day) out.byDay.set(r.day!, m);
  }
  return out;
}

export type StatusFact = {
  currency: string;
  status: string;
  decision: string;
  pak: boolean;
  lines: number;
  billed: number;
  overcharge: number;
  estimated: number;
};

/** Genel Bakış: para birimi × durum × karar × pak kırılımı (split ve bekleyenler). */
export async function statusFacts(companyId: string, p: Period): Promise<StatusFact[]> {
  const rows = await prisma.$queryRaw<(Omit<StatusFact, 'billed' | 'overcharge' | 'estimated'> & { billed: string; overcharge: string; estimated: string })[]>`
    SELECT
      upper(i."currency") AS "currency",
      l."status"::text AS "status",
      l."decision"::text AS "decision",
      COALESCE(l."note" LIKE ${PAK_LIKE}, false) AS "pak",
      count(*)::int AS "lines",
      COALESCE(sum(l."netAmount"), 0)::text AS "billed",
      COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${OVERCHARGE_SQL}), 0)::text AS "overcharge",
      COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${ESTIMATED_SQL}), 0)::text AS "estimated"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE ${lineScope(companyId, p, {})}
    GROUP BY 1, 2, 3, 4`;
  return rows.map((r) => ({ ...r, billed: Number(r.billed), overcharge: Number(r.overcharge), estimated: Number(r.estimated) }));
}

/** Dönemde karar bekleyen fark satırı sayısı. */
export async function openDecisionCount(companyId: string, p: Period): Promise<number> {
  return prisma.invoiceLine.count({
    where: { companyId, status: 'DIFF', decision: 'OPEN', invoice: { ...invoiceScope(companyId), invoiceDate: { gte: p.start, lt: p.end } } },
  });
}

/** Verilen faturalarda karar bekleyen fazla ödeme, para birimi başına. Bekleyenler'de aynı tutar iki kez görünmesin diye. */
export async function openOverchargeOn(companyId: string, p: Period, invoiceIds: string[]): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ currency: string; amount: string }[]>`
    SELECT upper(i."currency") AS "currency", COALESCE(sum(GREATEST(0, l."diffAmount")), 0)::text AS "amount"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE ${lineScope(companyId, p, {})} AND i."id" = ANY(${invoiceIds}::text[]) AND l."decision" = 'OPEN' AND ${OVERCHARGE_SQL}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.currency, Number(r.amount)]));
}

export type TopLine = {
  id: string;
  invoiceId: string;
  trackingNo: string;
  invoiceNo: string;
  carrierId: string;
  destCountry: string | null;
  service: string | null;
  status: string;
  diffTypes: string[];
  netAmount: number;
  expectedAmount: number | null;
  diffAmount: number;
};

export async function topOverchargeLines(companyId: string, p: Period, f: LineFilter, limit: number): Promise<TopLine[]> {
  const rows = await prisma.$queryRaw<(Omit<TopLine, 'netAmount' | 'expectedAmount' | 'diffAmount'> & { netAmount: string; expectedAmount: string | null; diffAmount: string })[]>`
    SELECT l."id", l."invoiceId", l."trackingNo", i."invoiceNo", i."carrierId", l."destCountry", l."service", l."status"::text AS "status", l."diffTypes",
      l."netAmount"::text AS "netAmount", l."expectedAmount"::text AS "expectedAmount", l."diffAmount"::text AS "diffAmount"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE ${lineScope(companyId, p, f)} AND ${OVERCHARGE_SQL} AND l."diffAmount" > 0
    ORDER BY l."diffAmount" DESC, l."id"
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, netAmount: Number(r.netAmount), expectedAmount: r.expectedAmount == null ? null : Number(r.expectedAmount), diffAmount: Number(r.diffAmount) }));
}

export type InvoiceFact = {
  currency: string;
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  carrierId: string;
  lines: number;
  compared: number;
  diff: number;
  priceDiff: number;
  overcharge: number;
};

/** Fatura başına sayımlar: en çok fark çıkanlar ve tarife şüphesi (services/invoiceHints.ts ile aynı iki sayım). */
export async function invoiceFacts(companyId: string, p: Period, f: LineFilter): Promise<InvoiceFact[]> {
  const rows = await prisma.$queryRaw<(Omit<InvoiceFact, 'overcharge'> & { overcharge: string })[]>`
    SELECT i."id", i."invoiceNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."carrierId", upper(i."currency") AS "currency",
      count(*)::int AS "lines",
      (count(*) FILTER (WHERE l."status" IN ('MATCH', 'DIFF')))::int AS "compared",
      (count(*) FILTER (WHERE l."status" = 'DIFF'))::int AS "diff",
      (count(*) FILTER (WHERE l."status" = 'DIFF' AND 'PRICE' = ANY(l."diffTypes")))::int AS "priceDiff",
      COALESCE(sum(GREATEST(0, l."diffAmount")) FILTER (WHERE ${OVERCHARGE_SQL}), 0)::text AS "overcharge"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE ${lineScope(companyId, p, f)}
    GROUP BY i."id", i."invoiceNo", i."invoiceDate", i."carrierId", i."currency"`;
  return rows.map((r) => ({ ...r, overcharge: Number(r.overcharge) }));
}

export type HealthRow = {
  carrierId: string;
  country: string | null;
  service: string | null;
  zone: string | null;
  deviation: number | null;
  adjustment: number;
  fuel: number | null;
  fx: boolean;
  lines: number;
};

/**
 * Tarife uyumu girdileri (services/tariffHealth.ts ile aynı satırlar: mükerrer ve pak/zarf yok). Aynı değerli satırlar
 * tek kayıt olarak gelir, belleğe yüzbinlerce satır çekilmez.
 */
export async function healthRows(companyId: string, p: Period, f: LineFilter): Promise<{ rows: HealthRow[]; stale: number }> {
  const rows = await prisma.$queryRaw<(HealthRow & { hasPricing: boolean })[]>`
    SELECT i."carrierId", l."destCountry" AS "country", l."service" AS "service",
      l."pricing"->>'zone' AS "zone",
      (l."pricing"->>'rateDeviationPct')::float8 AS "deviation",
      COALESCE((l."pricing"->>'adjustmentPct')::float8, 0) AS "adjustment",
      (l."pricing"->>'fuelPct')::float8 AS "fuel",
      COALESCE(upper(COALESCE(l."currency", i."currency")) <> upper(t."currency"), false) AS "fx",
      (l."pricing" IS NOT NULL AND l."pricing" <> 'null'::jsonb) AS "hasPricing",
      count(*)::int AS "lines"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      LEFT JOIN "Tariff" t ON t."id" = COALESCE(l."tariffId", i."tariffId") AND t."companyId" = ${companyId}
    WHERE ${lineScope(companyId, p, f)} AND NOT ('DUPLICATE' = ANY(l."diffTypes")) AND NOT COALESCE(l."note" LIKE ${PAK_LIKE}, false)
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;
  let stale = 0;
  const out: HealthRow[] = [];
  for (const r of rows) {
    if (r.hasPricing) out.push(r);
    else stale += r.lines;
  }
  return { rows: out, stale };
}

// ---------- ölçümler ----------

export const DIM_METHODS = ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET'] as const;

export const measurementScope = (companyId: string) => ({ companyId, deletedAt: null, supersededById: null });

/** Ölçüm anı gerçek andır: dönem sınırları firmanın gününe göre. Fatura tarihi gündür, `p.start`/`p.end` onun içindir. */
async function measuredRange(companyId: string, p: Period) {
  const { timeZone } = await companySettings(companyId);
  return { range: zonedRange(p.from, p.to, timeZone), timeZone };
}

/** Pano ile aynı küme: güncel, silinmemiş sürümler, `measuredAt` dönem içinde. */
export async function measurementCounts(companyId: string, p: Period) {
  const { range } = await measuredRange(companyId, p);
  const rows = await prisma.measurement.groupBy({
    by: ['dimMethod'],
    where: { ...measurementScope(companyId), measuredAt: range },
    _count: { _all: true },
  });
  const byMethod = Object.fromEntries(DIM_METHODS.map((k) => [k, 0])) as Record<(typeof DIM_METHODS)[number], number>;
  for (const r of rows) byMethod[r.dimMethod] = r._count._all;
  return { count: Object.values(byMethod).reduce((a, b) => a + b, 0), byMethod };
}

export async function measurementsWithoutPhoto(companyId: string, p: Period): Promise<number> {
  const { range } = await measuredRange(companyId, p);
  return prisma.measurement.count({ where: { ...measurementScope(companyId), measuredAt: range, files: { none: {} } } });
}

export async function measurementDays(companyId: string, p: Period): Promise<Map<string, number>> {
  const { range, timeZone } = await measuredRange(companyId, p);
  // measuredAt UTC saklanır: önce "bu UTC'dir" denir, sonra firmanın saatine çevrilir.
  const rows = await prisma.$queryRaw<{ day: string; n: number }[]>`
    SELECT to_char((m."measuredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text, 'YYYY-MM-DD') AS "day", count(*)::int AS "n"
    FROM "Measurement" m
    WHERE m."companyId" = ${companyId} AND m."deletedAt" IS NULL AND m."supersededById" IS NULL AND m."measuredAt" >= ${range.gte} AND m."measuredAt" < ${range.lt}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.day, r.n]));
}

export type OperatorFact = { userId: string; count: number; noPhoto: number; corrected: number; manual: number; last: Date | null };

/**
 * Çalışan başına ölçüm. Sayılan küme: güncel sürümler, sahibine. KALANLAR 6.7: geç gelen eski ölçüm (`arrivedLate`) de onu
 * ölçene yazılır, hemen sonraki sürüm başkasının silinmemiş güncel sürümüyse (çalışanın kendi listesiyle aynı kural,
 * `routes/measurements.ts` `currentScope`). "Düzeltilen": zincirinde geç gelmemiş eski sürüm olan güncel sürüm; geç kaydın
 * kaydırdığı sürüm numarası güncel kaydın sahibine düzeltme yazmaz.
 */
export async function operatorFacts(companyId: string, p: Period): Promise<OperatorFact[]> {
  const { range } = await measuredRange(companyId, p);
  const where = { ...measurementScope(companyId), measuredAt: range };
  const late = {
    companyId,
    deletedAt: null,
    arrivedLate: true,
    measuredAt: range,
    supersededBy: { supersededById: null, deletedAt: null },
  } satisfies Prisma.MeasurementWhereInput;
  const lateRows = await prisma.measurement.findMany({
    where: late,
    select: { measuredById: true, measuredAt: true, dimMethod: true, supersededBy: { select: { measuredById: true } }, _count: { select: { files: true } } },
  });
  const [all, noPhoto, corrected, manual] = await Promise.all([
    prisma.measurement.groupBy({ by: ['measuredById'], where, _count: { _all: true }, _max: { measuredAt: true } }),
    prisma.measurement.groupBy({ by: ['measuredById'], where: { ...where, files: { none: {} } }, _count: { _all: true } }),
    prisma.$queryRaw<{ userId: string; n: number }[]>`
      WITH RECURSIVE ch("head", "id", "late", "depth") AS (
        SELECT m."id", m."id", false, 0 FROM "Measurement" m
        WHERE m."companyId" = ${companyId} AND m."deletedAt" IS NULL AND m."supersededById" IS NULL AND m."version" > 1
          AND m."measuredAt" >= ${range.gte} AND m."measuredAt" < ${range.lt}
        UNION ALL
        SELECT ch."head", v."id", v."arrivedLate", ch."depth" + 1 FROM "Measurement" v JOIN ch ON v."supersededById" = ch."id"
        WHERE v."companyId" = ${companyId} AND ch."depth" < 1000
      )
      SELECT h."measuredById" AS "userId", count(DISTINCT h."id")::int AS "n"
      FROM ch JOIN "Measurement" h ON h."id" = ch."head"
      WHERE ch."depth" > 0 AND NOT ch."late"
      GROUP BY 1`,
    prisma.measurement.groupBy({ by: ['measuredById'], where: { ...where, dimMethod: 'MANUAL' }, _count: { _all: true } }),
  ]);
  const facts = new Map<string, OperatorFact>();
  const fact = (userId: string) => {
    let f = facts.get(userId);
    if (!f) facts.set(userId, (f = { userId, count: 0, noPhoto: 0, corrected: 0, manual: 0, last: null }));
    return f;
  };
  const later = (a: Date | null, b: Date | null) => (a && (!b || a > b) ? a : b);
  for (const r of all) Object.assign(fact(r.measuredById), { count: r._count._all, last: r._max.measuredAt });
  for (const r of noPhoto) fact(r.measuredById).noPhoto = r._count._all;
  for (const r of corrected) fact(r.userId).corrected = r.n;
  for (const r of manual) fact(r.measuredById).manual = r._count._all;
  for (const r of lateRows) {
    if (r.supersededBy?.measuredById === r.measuredById) continue;
    const f = fact(r.measuredById);
    f.count++;
    if (!r._count.files) f.noPhoto++;
    if (r.dimMethod === 'MANUAL') f.manual++;
    f.last = later(r.measuredAt, f.last);
  }
  return [...facts.values()].sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId));
}

// ---------- itiraz süresi ----------

export const CARRIER_WINDOW_ALERT_DAYS = 7;
/** FedEx düzeltme penceresinden eskisine bakılmaz. */
const DEADLINE_LOOKBACK_DAYS = 30;

export type DeadlineRow = {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  carrierName: string;
  createdAt: Date;
  diff: number;
  overcharge: number;
  estimated: number;
  kind: 'ttk' | 'carrier';
  lastDay: string;
  daysLeft: number;
};

/**
 * Fark tutarı olan ve itiraz süresi yaklaşan faturalar, bugüne göre (seçili dönemden bağımsız). Süre core'daki
 * `disputeDeadlines` ile hesaplanır: TTK 8 gün yalnız Türkiye firmasında; TTK geçtiyse ya da firma başka ülkedeyse FedEx
 * düzeltme süresinin son 7 günü (taşıyıcının kendi kuralı, ülkeden bağımsız).
 */
export async function upcomingDeadlines(companyId: string, now: Date): Promise<DeadlineRow[]> {
  const today = turkeyDate(now);
  const country = await companyCountry(companyId);
  const since = new Date(`${isoShift(today, -DEADLINE_LOOKBACK_DAYS)}T00:00:00.000Z`);
  // İtirazı gönderilmiş (etkin turu olan) fatura için süre işlemez: TTK "zamanında itiraz edildi" olur.
  const rows = await prisma.invoice.findMany({
    where: { ...invoiceScope(companyId), invoiceDate: { gte: since }, disputes: { none: { withdrawnAt: null, supersededAt: null } } },
    select: { id: true, invoiceNo: true, invoiceDate: true, currency: true, totals: true, createdAt: true, carrier: { select: { name: true, code: true } } },
  });
  const out: DeadlineRow[] = [];
  for (const r of rows) {
    const t = r.totals as InvoiceTotals;
    const overcharge = Number(t?.overchargeTotal) || 0;
    const estimated = Number(t?.estimatedOverchargeTotal) || 0;
    if (overcharge + estimated <= 0) continue;
    const iso = r.invoiceDate.toISOString().slice(0, 10);
    const dl = disputeDeadlines(iso, r.carrier.code, today, country);
    if (!dl) continue;
    const base = { id: r.id, invoiceNo: r.invoiceNo, invoiceDate: iso, currency: r.currency.toUpperCase(), carrierName: r.carrier.name, createdAt: r.createdAt, diff: Number(t?.diff) || 0, overcharge, estimated };
    if (dl.ttk && !dl.ttk.expired) out.push({ ...base, kind: 'ttk', lastDay: dl.ttk.lastDay, daysLeft: dl.ttk.daysLeft });
    else if (dl.carrier && !dl.carrier.expired && dl.carrier.daysLeft <= CARRIER_WINDOW_ALERT_DAYS) out.push({ ...base, kind: 'carrier', lastDay: dl.carrier.lastDay, daysLeft: dl.carrier.daysLeft });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || b.overcharge - a.overcharge || a.id.localeCompare(b.id));
}

// ---------- tarife durumu ----------

export type CarrierTariffStatus = {
  carrierId: string;
  carrierName: string;
  tariff: { id: string; name: string; validTo: string | null } | null;
  daysLeft: number | null;
};

/** Etkin taşıyıcıların karşılaştırmada kullanılan tarifesi (compare.ts `defaultTariff`) ve geçerliliği. */
export async function carrierTariffStatus(companyId: string, now: Date): Promise<CarrierTariffStatus[]> {
  const carriers = await prisma.carrier.findMany({
    where: { companyId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, tariffs: { select: { id: true, name: true, active: true, isDefault: true, updatedAt: true, validTo: true } } },
  });
  const today = Date.parse(`${turkeyDate(now)}T00:00:00.000Z`);
  return carriers.map((c) => {
    const t = defaultTariff(c.tariffs);
    const validTo = t?.validTo ? t.validTo.toISOString().slice(0, 10) : null;
    return {
      carrierId: c.id,
      carrierName: c.name,
      tariff: t ? { id: t.id, name: t.name, validTo } : null,
      daysLeft: validTo ? Math.round((Date.parse(`${validTo}T00:00:00.000Z`) - today) / 86_400_000) : null,
    };
  });
}
