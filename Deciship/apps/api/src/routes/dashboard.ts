import { limited } from '../services/hub/limiter.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.ts';
import { readSettings } from '../lib/settings.ts';
import { zonedDate, zonedDayStart } from '../lib/time.ts';
import { num, sum } from '../lib/util.ts';
import { countsAsOvercharge, type InvoiceTotals } from '../services/compare.ts';
import { disputeFacts, disputeTotalsByCurrency, invoiceDateScope } from '../services/disputes.ts';
import { aggregateTotals, primaryCurrency } from '../services/hub/metrics.ts';

const DIM_METHODS = ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET'] as const;

type TopDiffType = { type: string; count: number; amount: number };

/** Fark türleri, `overchargeTotal` ile aynı küme: toplamları fazla ödemeye eşittir. */
function topDiffTypes(lines: { diffTypes: string[]; diffAmount: unknown }[]): TopDiffType[] {
  const byType = new Map<string, { count: number; amounts: number[] }>();
  for (const l of lines) {
    const type = l.diffTypes[0];
    if (!type) continue;
    const e = byType.get(type) ?? { count: 0, amounts: [] };
    e.count++;
    e.amounts.push(Math.max(0, num(l.diffAmount as number)));
    byType.set(type, e);
  }
  return [...byType.entries()]
    .map(([type, e]) => ({ type, count: e.count, amount: sum(e.amounts) }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count);
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', { onRequest: app.requirePermission('deciship.reports.view') }, limited(async (req) => {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'v.monthFormat').optional() })
      .parse(req.query);
    const { orgId: companyId } = req.auth;
    const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
    const settings = readSettings(company.settings);
    const now = new Date();
    const period = month ?? zonedDate(now, settings.timeZone).slice(0, 7);
    const [y, m] = period.split('-').map(Number) as [number, number];
    // Fatura tarihi gündür, UTC gece yarısı saklanır: ay sınırı da öyle.
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    // Ölçüm anı gerçek andır: ay sınırı firmanın gününe göre.
    const measuredRange = {
      gte: zonedDayStart(from.toISOString().slice(0, 10), settings.timeZone),
      lt: zonedDayStart(to.toISOString().slice(0, 10), settings.timeZone),
    };

    const measurementWhere = { companyId, deletedAt: null, supersededById: null };
    const [byMethodRaw, today, invoiceRows, recent] = await Promise.all([
      prisma.measurement.groupBy({
        by: ['dimMethod'],
        where: { ...measurementWhere, measuredAt: measuredRange },
        _count: { _all: true },
      }),
      prisma.measurement.count({ where: { ...measurementWhere, measuredAt: { gte: zonedDayStart(zonedDate(now, settings.timeZone), settings.timeZone) } } }),
      prisma.invoice.findMany({
        where: { companyId, deletedAt: null, isSample: false, invoiceDate: { gte: from, lt: to } },
        select: { id: true, totals: true, currency: true },
      }),
      prisma.invoice.findMany({
        where: { companyId, deletedAt: null, isSample: false },
        include: { carrier: { select: { id: true, name: true, code: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    const invoices = invoiceRows.map((i) => ({ id: i.id, currency: i.currency.toUpperCase(), totals: i.totals as InvoiceTotals }));

    const byMethod = Object.fromEntries(DIM_METHODS.map((k) => [k, 0])) as Record<(typeof DIM_METHODS)[number], number>;
    for (const r of byMethodRaw) byMethod[r.dimMethod] = r._count._all;
    const count = Object.values(byMethod).reduce((a, b) => a + b, 0);

    // Sayılar para biriminden bağımsızdır, tutarlar değildir: tutarlar para birimine göre ayrı (Merkez ile aynı kural).
    const all = aggregateTotals(invoices);

    const diffLines = invoices.length
      ? await prisma.invoiceLine.findMany({
          where: { invoiceId: { in: invoices.map((i) => i.id) }, status: 'DIFF' },
          select: { invoiceId: true, status: true, decision: true, pricing: true, diffTypes: true, diffAmount: true },
        })
      : [];
    const currencyOf = new Map(invoices.map((i) => [i.id, i.currency]));
    const overchargeLines = diffLines.filter(countsAsOvercharge);

    // İtiraz: geri alınan ve itirazda bekleyen, fatura ayına göre (aynı fatura kümesi), para birimi başına.
    const disputes = disputeTotalsByCurrency((await disputeFacts(companyId, invoiceDateScope(from, to))).values());

    const { primary, others } = primaryCurrency(invoices, settings.currency);
    const byCurrency = (invoices.length ? [primary, ...others] : []).map((currency) => {
      const inCurrency = aggregateTotals(invoices.filter((i) => i.currency === currency));
      return {
        currency,
        invoices: inCurrency.count,
        lines: inCurrency.lines,
        billedTotal: inCurrency.billed,
        overchargeTotal: inCurrency.overcharge,
        estimatedOverchargeTotal: inCurrency.estimated,
        verifiedTotal: inCurrency.verified,
        recoveredTotal: disputes.get(currency)?.recoveredAmount ?? 0,
        disputePendingTotal: disputes.get(currency)?.pendingAmount ?? 0,
        topDiffTypes: topDiffTypes(overchargeLines.filter((l) => currencyOf.get(l.invoiceId) === currency)),
      };
    });
    const main = byCurrency[0];

    return {
      month: `${y}-${String(m).padStart(2, '0')}`,
      measurements: { count, byMethod, today },
      invoices: {
        count: all.count,
        lines: all.lines,
        match: all.match,
        diff: all.diff,
        unmatched: all.unmatched,
        noTariff: all.noTariff,
      },
      /** `currency` cinsinden. Diğer para birimleri `byCurrency` içinde. */
      overchargeTotal: main?.overchargeTotal ?? 0,
      verifiedTotal: main?.verifiedTotal ?? 0,
      /** Alacak dekontuyla geri alınan ve gönderilmiş itirazda sonuç bekleyen talep (geçerli satır kuralı). */
      recoveredTotal: main?.recoveredTotal ?? 0,
      disputePendingTotal: main?.disputePendingTotal ?? 0,
      coveragePct: all.lines ? Math.round(((all.lines - all.unmatched) / all.lines) * 1000) / 10 : 0,
      topDiffTypes: main?.topDiffTypes ?? [],
      recentInvoices: recent.map((i) => ({
        id: i.id,
        invoiceNo: i.invoiceNo,
        invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
        currency: i.currency.toUpperCase(),
        carrier: i.carrier,
        totals: i.totals,
        createdAt: i.createdAt,
      })),
      /** Baş rakamın para birimi: firma para birimi; o para biriminde fatura yoksa en çok satırı olan. */
      currency: primary,
      otherCurrencies: others,
      byCurrency,
    };
  }));
}
