import { ttkApplies } from '@deciship/core';
import type { HubAlert, HubKpi, HubLeader, HubOverview, HubSeries, HubSetupStep, HubSplit } from '@sellerondata/contracts';
import { prisma } from '../../db.ts';
import { zonedDate } from '../../lib/time.ts';
import { readOnboarding } from '../../lib/settings.ts';
import { sum } from '../../lib/util.ts';
import { disputeFacts, disputeTotalsByCurrency, invoiceDateScope } from '../disputes.ts';
import { onboardingFlags, setupFacts, type SetupFacts } from '../onboarding.ts';
import { failedRecalcInvoices } from '../recalcFailed.ts';
import { formatDay, type HubKey } from './i18n.ts';
import { dataLink, deciship } from './links.ts';
import {
  aggregateTotals,
  carrierTariffStatus,
  companyCountry,
  companySettings,
  coveragePct,
  lineDimensions,
  loadInvoices,
  measurementCounts,
  measurementsWithoutPhoto,
  openDecisionCount,
  openOverchargeOn,
  pct,
  primaryCurrency,
  round2,
  statusFacts,
  upcomingDeadlines,
  type CarrierTariffStatus,
  type DeadlineRow,
  type InvoiceRow,
  type StatusFact,
} from './metrics.ts';
import { bucketize, previousPeriod, type Period } from './period.ts';
import { P, type HubCtx } from './types.ts';

const MAX_DEADLINE_ALERTS = 5;
const TARIFF_SOON_DAYS = 30;
const LEADERS_PER_KIND = 3;

/** Tutarı seçili para biriminde en büyükler. Eşitlikte ada göre: sıra istekten isteğe değişmez. */
function topLeaders<K>(entries: [K, number][], nameOf: (k: K) => string): [K, number][] {
  return entries
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
    .slice(0, LEADERS_PER_KIND);
}

/**
 * "En çok kaçıran": baş para biriminde fazla ödeme, Analiz'deki taşıyıcı ve fark türü kırılımıyla aynı hesap.
 * Yalnız fiyat izniyle çağrılır: sıralama da tutarı ele verir.
 */
async function buildLeaders(ctx: HubCtx, p: Period, currency: string, multi: boolean): Promise<{ leaders: HubLeader[]; foreignCarriers: string[] }> {
  const { companyId, t } = ctx;
  const dims = await lineDimensions(companyId, p, {}, currency);
  const carrierIds = [...dims.byCarrier.keys()];
  const names = new Map((await prisma.carrier.findMany({ where: { companyId, id: { in: carrierIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const total = dims.total.overcharge;
  const value = (amount: number) => ({ value: round2(amount), format: 'money' as const, currency });
  const inCurrency = multi ? { currency } : {};
  const carrierName = (id: string) => names.get(id) ?? id;
  const typeName = (k: string) => t(`diffType.${k}` as HubKey);
  const leaders: HubLeader[] = [];
  for (const [id, amount] of topLeaders([...dims.byCarrier.entries()].map(([k, m]) => [k, m.overcharge] as [string, number]), carrierName)) {
    const href = dataLink(ctx, 'invoice-lines', { status: 'DIFF', carrier: id, ...inCurrency }, p);
    leaders.push({ id: `carrier:${id}`, label: t('leader.carrier'), name: carrierName(id), value: value(amount), share: pct(amount, total) ?? 0, ...(href ? { href } : {}) });
  }
  for (const [type, amount] of topLeaders([...dims.byType.entries()].map(([k, m]) => [k, m.overcharge] as [string, number]), typeName)) {
    const href = dataLink(ctx, 'invoice-lines', { status: 'DIFF', diff: type, ...inCurrency }, p);
    leaders.push({ id: `type:${type}`, label: t('leader.type'), name: typeName(type), value: value(amount), share: pct(amount, total) ?? 0, ...(href ? { href } : {}) });
  }
  // Yalnız başka para biriminde faturalanan taşıyıcı baş para biriminde 0 görünür ve listeye girmez: susmak yerine söylenir.
  const foreignCarriers = [...dims.byCarrier.entries()].filter(([, m]) => m.lines > 0 && m.amountLines === 0).map(([id]) => carrierName(id)).sort((a, b) => a.localeCompare(b));
  return { leaders, foreignCarriers };
}

/** Kurulum listesi. Her adım firmanın verisinden: işaretlemeyle değil, yapılan işle tamamlanır. "Ekibi davet et"i Merkez ekler. */
function setupSteps(ctx: HubCtx, facts: SetupFacts): HubSetupStep[] {
  const { t } = ctx;
  const wizard = (step: string) => `${deciship.setup}?adim=${step}`;
  const step = (id: string, labelKey: HubKey, href: string, done: boolean, required: boolean): HubSetupStep => ({ id, label: t(labelKey), done, href, required });
  return [
    step('carriers', 'setup.step.carriers', wizard('tasiyicilar'), facts.activeCarriers > 0, true),
    step('tariffs', 'setup.step.tariffs', wizard('tarifeler'), facts.activeTariffs > 0, true),
    step('measure-rules', 'setup.step.measureRules', wizard('olcum'), facts.rulesReady, true),
    // Ürünün kalbi: ölçüm olmadan fatura karşılaştırılamaz.
    step('first-measurement', 'setup.step.firstMeasurement', deciship.measurements, facts.measurements > 0, true),
    // Sihirbazın "faturalar" adımı örnek faturadır, listeye girmez ve bu adımı tamamlamaz: gerçek yükleme ekranı.
    step('first-invoice', 'setup.step.firstInvoice', deciship.invoiceUpload, facts.invoices > 0, true),
    step('box-presets', 'setup.step.boxPresets', wizard('koliler'), facts.presetsReady, false),
  ];
}

/** Dönem boyunca birikimli fazla ödeme: `Invoice.totals`'tan, baş rakamla aynı toplam. */
export function overchargeSeries(invoices: InvoiceRow[], currency: string, p: Period, today?: string) {
  const byDay = new Map<string, number[]>();
  for (const i of invoices) {
    if (i.currency !== currency) continue;
    const day = i.invoiceDate.toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), Number(i.totals?.overchargeTotal) || 0]);
  }
  return bucketize(p, (d) => sum(byDay.get(d) ?? []), { cumulative: true, today, round: round2 });
}

function deadlineAlert(ctx: HubCtx, d: DeadlineRow): HubAlert {
  const { t, locale } = ctx;
  const params = { carrier: d.carrierName, date: formatDay(d.lastDay, locale) };
  // Kalan günü Merkez `dueAt`tan rozetle yazar: gövde hangi süre olduğunu ve tarihi söyler.
  const when = d.kind === 'ttk' ? t('alert.deadline.ttk', params) : t('alert.deadline.carrier', params);
  const estimatedOnly = d.overcharge <= 0;
  const alert: HubAlert = {
    id: `deadline:${d.id}`,
    tone: d.daysLeft <= 2 ? 'bad' : 'warning',
    title: t('alert.deadline.title', { carrier: d.carrierName, invoice: d.invoiceNo, count: d.diff }),
    body: estimatedOnly && ctx.can(P.prices) ? `${when} ${t('alert.deadline.estimated')}` : when,
    href: deciship.invoice(d.id),
    actionLabel: t('alert.openInvoice'),
    at: d.createdAt.toISOString(),
    dueAt: d.lastDay,
  };
  if (ctx.can(P.prices)) alert.amount = { value: estimatedOnly ? d.estimated : d.overcharge, format: 'money', currency: d.currency };
  return alert;
}

function tariffAlerts(ctx: HubCtx, status: CarrierTariffStatus[]): HubAlert[] {
  const { t } = ctx;
  const out: HubAlert[] = [];
  for (const s of status) {
    if (!s.tariff) {
      out.push({
        id: `tariff-none:${s.carrierId}`,
        tone: 'warning',
        title: t('alert.tariff.none.title', { carrier: s.carrierName }),
        body: t('alert.tariff.none.body'),
        href: deciship.tariffs(s.carrierId),
        actionLabel: t('alert.seeTariffs'),
      });
    } else if (s.daysLeft != null && s.daysLeft <= TARIFF_SOON_DAYS) {
      const tariff = s.tariff.name;
      out.push({
        id: `tariff-expiry:${s.tariff.id}`,
        tone: s.daysLeft < 0 ? 'bad' : 'warning',
        title:
          s.daysLeft < 0
            ? t('alert.tariff.expired.title', { tariff, days: -s.daysLeft })
            : s.daysLeft === 0
              ? t('alert.tariff.today.title', { tariff })
              : t('alert.tariff.soon.title', { tariff, days: s.daysLeft }),
        body: s.daysLeft < 0 ? t('alert.tariff.expired.body') : t('alert.tariff.soon.body'),
        href: deciship.tariff(s.tariff.id),
        actionLabel: t('alert.openTariff'),
      });
    }
  }
  return out;
}

/** Karar, ölçümsüz ve tarifesiz satırlar için para birimi başına bir bekleyen: farklı para birimleri tek tutarda toplanmaz. */
function lineAlerts(ctx: HubCtx, p: Period, facts: StatusFact[], coveredByDeadlines: Map<string, number>): HubAlert[] {
  const { t } = ctx;
  const money = ctx.can(P.prices);
  const out: HubAlert[] = [];
  const currencies = [...new Set(facts.map((f) => f.currency))].sort();
  const many = currencies.length > 1;
  for (const currency of currencies) {
    const of = (test: (f: StatusFact) => boolean) => facts.filter((f) => f.currency === currency && test(f));
    const amount = (value: number) => (money ? { amount: { value: round2(value), format: 'money' as const, currency } } : {});
    const cur = many ? { currency } : {};
    // Kuyruklar para birimi başınadır: birden çok kuyruk varsa başlık hangisi olduğunu söyler, toplamı KPI verir.
    const queueTitle = (title: string) => (many ? t('alert.inCurrency', { title, currency }) : title);

    const open = of((f) => f.status === 'DIFF' && f.decision === 'OPEN');
    const openLines = open.reduce((a, f) => a + f.lines, 0);
    const remaining = round2(sum(open.map((f) => f.overcharge)) - (coveredByDeadlines.get(currency) ?? 0));
    if (openLines > 0) {
      out.push({
        id: `open:${currency}`,
        tone: 'warning',
        title: queueTitle(t('alert.open.title', { count: openLines })),
        body: t('alert.open.body'),
        // Süresi yaklaşan faturanın tutarı kendi maddesinde: aynı para iki kez görünmesin. Sayı toplamı KPI ile aynı kalır.
        ...(remaining > 0 ? amount(remaining) : {}),
        href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'OPEN', ...cur }, p),
        actionLabel: t('alert.seeLines'),
      });
    }
    // Pak/zarf kapsam dışıdır: ölçülmez, koli tarifesiyle karşılaştırılmaz; iş listesine girmez.
    const unmatched = of((f) => f.status === 'UNMATCHED' && !f.pak);
    const unmatchedLines = unmatched.reduce((a, f) => a + f.lines, 0);
    if (unmatchedLines > 0) {
      out.push({
        id: `unmatched:${currency}`,
        tone: 'warning',
        title: queueTitle(t('alert.unmatched.title', { count: unmatchedLines })),
        body: t('alert.unmatched.body'),
        ...amount(sum(unmatched.map((f) => f.billed))),
        href: dataLink(ctx, 'invoice-lines', { status: 'UNMATCHED', scope: 'in', ...cur }, p),
        actionLabel: t('alert.seeUnmatched'),
      });
    }
    const noTariff = of((f) => f.status === 'NO_TARIFF' && !f.pak);
    const noTariffLines = noTariff.reduce((a, f) => a + f.lines, 0);
    if (noTariffLines > 0) {
      out.push({
        id: `no-tariff:${currency}`,
        tone: 'warning',
        title: queueTitle(t('alert.noTariff.title', { count: noTariffLines })),
        body: t('alert.noTariff.body'),
        ...amount(sum(noTariff.map((f) => f.billed))),
        href: dataLink(ctx, 'invoice-lines', { status: 'NO_TARIFF', scope: 'in', ...cur }, p),
        actionLabel: t('alert.seeLines'),
      });
    }
  }
  return out;
}

function buildSplit(ctx: HubCtx, p: Period, facts: StatusFact[], currency: string, multi: boolean, total: number): HubSplit | undefined {
  const { t } = ctx;
  const inCurrency = facts.filter((f) => f.currency === currency);
  if (!inCurrency.length) return undefined;
  const billed = (test: (f: StatusFact) => boolean) => sum(inCurrency.filter(test).map((f) => f.billed));
  const accepted = billed((f) => f.status === 'DIFF' && f.decision === 'ACCEPTED');
  const link = (filters: Record<string, string | string[]>) => dataLink(ctx, 'invoice-lines', { ...filters, ...(multi ? { currency } : {}) }, p);
  const parts: HubSplit['parts'] = [
    { key: 'match', label: t('split.match'), value: billed((f) => f.status === 'MATCH'), tone: 'good', href: link({ status: 'MATCH' }), note: t('split.match.note') },
    { key: 'diff', label: t('split.diff'), value: billed((f) => f.status === 'DIFF' && f.decision !== 'ACCEPTED'), tone: 'bad', href: link({ status: 'DIFF', decision: ['OPEN', 'VERIFIED'] }), note: t('split.diff.note') },
  ];
  if (accepted > 0) parts.push({ key: 'accepted', label: t('split.accepted'), value: accepted, tone: 'info', href: link({ status: 'DIFF', decision: 'ACCEPTED' }), note: t('split.accepted.note') });
  parts.push(
    { key: 'unmatched', label: t('split.unmatched'), value: billed((f) => f.status === 'UNMATCHED'), tone: 'warning', href: link({ status: 'UNMATCHED' }), note: t('split.unmatched.note') },
    { key: 'noTariff', label: t('split.noTariff'), value: billed((f) => f.status === 'NO_TARIFF'), tone: 'neutral', href: link({ status: 'NO_TARIFF' }), note: t('split.noTariff.note') },
  );
  return {
    title: multi ? t('split.titleIn', { currency }) : t('split.title'),
    total: { value: total, format: 'money', currency },
    parts,
  };
}

export async function buildOverview(ctx: HubCtx, p: Period): Promise<HubOverview> {
  const { companyId, t } = ctx;
  const money = ctx.can(P.prices);
  const seeMeasurements = ctx.can(P.measurements);
  const prev = previousPeriod(p);
  const today = zonedDate(ctx.now, (await companySettings(companyId)).timeZone);

  const [country, settings, invoices, prevInvoices, facts, prevOpen, measured, prevMeasured, deadlines, tariffs, noPhoto] = await Promise.all([
    companyCountry(companyId),
    companySettings(companyId),
    loadInvoices(companyId, p),
    loadInvoices(companyId, prev),
    statusFacts(companyId, p),
    openDecisionCount(companyId, prev),
    measurementCounts(companyId, p),
    measurementCounts(companyId, prev),
    upcomingDeadlines(companyId, ctx.now),
    carrierTariffStatus(companyId, ctx.now),
    seeMeasurements ? measurementsWithoutPhoto(companyId, p) : Promise.resolve(0),
  ]);

  const all = aggregateTotals(invoices);
  const prevAll = aggregateTotals(prevInvoices);
  const { primary, others } = primaryCurrency(invoices, settings.currency);
  const inCurrency = (list: InvoiceRow[], c: string) => aggregateTotals(list.filter((i) => i.currency === c));
  const cur = inCurrency(invoices, primary);
  const prevCur = inCurrency(prevInvoices, primary);
  const hasAnything = all.count > 0 || measured.count > 0;
  // Karar bekleyen tek tanım: bekleyenlerdeki kuyruklarla aynı satırlar.
  const open = sum(facts.filter((f) => f.status === 'DIFF' && f.decision === 'OPEN').map((f) => f.lines));

  const kpis: HubKpi[] = [];
  if (money) {
    const trend: HubSeries[] = [
      { id: 'current', label: t('common.thisPeriod'), role: 'current', points: overchargeSeries(invoices, primary, p, today) },
      { id: 'previous', label: t('common.previousPeriod'), role: 'previous', points: overchargeSeries(prevInvoices, primary, prev) },
    ];
    kpis.push({
      id: 'overcharge',
      label: t('kpi.overcharge'),
      hint: all.count ? t('kpi.overcharge.hint') : t('kpi.overcharge.noInvoices'),
      // Hiç veri yoksa boş: "0,00 ₺ yakalandı" denmez, Merkez kurulum ya da boş durum gösterir.
      value: hasAnything ? cur.overcharge : null,
      format: 'money',
      currency: primary,
      previous: prevCur.count ? prevCur.overcharge : null,
      goodDirection: 'down',
      tone: cur.overcharge > 0 ? 'bad' : 'neutral',
      href: '/analytics/deciship',
      trend,
    });
  }
  // Türk Ticaret Kanunu süresi yalnız Türkiye'de. Başka ülkede yaklaşan süre taşıyıcınındır: varsa adıyla söylenir, yoksa "0 fatura" denmez.
  const ttk = ttkApplies(country);
  kpis.push(
    {
      id: 'diffs',
      label: t('kpi.diffs'),
      hint: t('kpi.diffs.hint'),
      value: hasAnything ? all.diff : null,
      format: 'number',
      previous: prevAll.diff,
      goodDirection: 'down',
      tone: all.diff > 0 ? 'warning' : 'neutral',
      href: dataLink(ctx, 'invoice-lines', { status: 'DIFF' }, p),
    },
    ...(ttk || deadlines.length
      ? [
          {
            id: 'deadlines',
            label: t(ttk ? 'kpi.deadlines' : 'kpi.deadlines.carrier'),
            hint: t('kpi.deadlines.hint'),
            value: deadlines.length,
            format: 'number' as const,
            goodDirection: 'none' as const,
            tone: deadlines.length ? ('warning' as const) : ('neutral' as const),
            href: dataLink(ctx, 'invoices', { deadline: 'soon' }),
          },
        ]
      : []),
  );
  // Baş rakamın diğer para birimleri: "süresi yaklaşan" üçüncü sırada kalır.
  if (money) {
    for (const c of others) {
      const o = inCurrency(invoices, c);
      const po = inCurrency(prevInvoices, c);
      kpis.push({
        id: `overcharge:${c}`,
        label: t('kpi.overchargeIn', { currency: c }),
        hint: t('kpi.overchargeIn.hint'),
        value: o.overcharge,
        format: 'money',
        currency: c,
        previous: po.count ? po.overcharge : null,
        goodDirection: 'down',
        tone: o.overcharge > 0 ? 'bad' : 'neutral',
        href: `/analytics/deciship?filter.currency=${c}`,
      });
    }
  }
  kpis.push(
    {
      id: 'open',
      label: t('kpi.open'),
      value: open,
      format: 'number',
      previous: prevOpen,
      goodDirection: 'down',
      tone: open > 0 ? 'warning' : 'neutral',
      href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'OPEN' }, p),
    },
    {
      id: 'coverage',
      label: t('kpi.coverage'),
      hint: t('kpi.coverage.hint'),
      value: coveragePct(all.lines, all.unmatched),
      format: 'percent',
      previous: coveragePct(prevAll.lines, prevAll.unmatched),
      goodDirection: 'up',
      href: dataLink(ctx, 'invoice-lines', { status: 'UNMATCHED' }, p),
    },
  );
  if (money) {
    kpis.push({
      id: 'verified',
      label: t('kpi.verified'),
      hint: t('kpi.verified.hint'),
      value: cur.verified,
      format: 'money',
      currency: primary,
      previous: prevCur.count ? prevCur.verified : null,
      goodDirection: 'none',
      href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'VERIFIED', ...(others.length ? { currency: primary } : {}) }, p),
    });
    // İtiraz: geri alınan ve itirazda bekleyen, fatura ayına göre (Pano ile aynı küme ve kural), baş para biriminde.
    const [disputes, prevDisputes] = await Promise.all([
      disputeFacts(companyId, invoiceDateScope(p.start, p.end)).then((f) => disputeTotalsByCurrency(f.values()).get(primary)),
      disputeFacts(companyId, invoiceDateScope(prev.start, prev.end)).then((f) => disputeTotalsByCurrency(f.values()).get(primary)),
    ]);
    kpis.push(
      {
        id: 'recovered',
        label: t('kpi.recovered'),
        hint: t('kpi.recovered.hint'),
        value: disputes?.recoveredAmount ?? 0,
        format: 'money',
        currency: primary,
        previous: prevCur.count ? (prevDisputes?.recoveredAmount ?? 0) : null,
        goodDirection: 'up',
        tone: (disputes?.recoveredAmount ?? 0) > 0 ? 'good' : 'neutral',
        href: deciship.disputes,
      },
      {
        id: 'disputePending',
        label: t('kpi.disputePending'),
        hint: t('kpi.disputePending.hint'),
        value: disputes?.pendingAmount ?? 0,
        format: 'money',
        currency: primary,
        previous: prevCur.count ? (prevDisputes?.pendingAmount ?? 0) : null,
        goodDirection: 'none',
        tone: (disputes?.pendingAmount ?? 0) > 0 ? 'warning' : 'neutral',
        href: `${deciship.disputes}?status=SENT`,
      },
    );
    if (cur.estimated > 0 || prevCur.estimated > 0) {
      kpis.push({
        id: 'estimated',
        label: t('kpi.estimated'),
        hint: t('kpi.estimated.hint'),
        value: cur.estimated,
        format: 'money',
        currency: primary,
        previous: prevCur.count ? prevCur.estimated : null,
        goodDirection: 'down',
        tone: cur.estimated > 0 ? 'warning' : 'neutral',
        href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', confidence: 'LOW', ...(others.length ? { currency: primary } : {}) }, p),
      });
    }
  }
  kpis.push(
    {
      id: 'measured',
      label: t('kpi.measured'),
      value: measured.count,
      format: 'number',
      previous: prevMeasured.count,
      goodDirection: 'up',
      href: dataLink(ctx, 'measurements', {}, p),
    },
    {
      id: 'invoices',
      label: t('kpi.invoices'),
      value: all.count,
      format: 'number',
      previous: prevAll.count,
      goodDirection: 'none',
      href: dataLink(ctx, 'invoices', {}, p),
    },
  );

  const alerts: HubAlert[] = deadlines.slice(0, MAX_DEADLINE_ALERTS).map((d) => deadlineAlert(ctx, d));
  const hiddenDeadlines = deadlines.length - MAX_DEADLINE_ALERTS;
  if (hiddenDeadlines > 0) {
    alerts.push({
      id: 'deadline-more',
      tone: 'warning',
      title: t(ttk ? 'alert.deadline.more' : 'alert.deadline.more.carrier', { count: hiddenDeadlines }),
      href: dataLink(ctx, 'invoices', { deadline: 'soon' }),
      actionLabel: t('alert.seeInvoices'),
    });
  }
  const shownDeadlines = deadlines.slice(0, MAX_DEADLINE_ALERTS).map((d) => d.id);
  alerts.push(...lineAlerts(ctx, p, facts, money && shownDeadlines.length ? await openOverchargeOn(companyId, p, shownDeadlines) : new Map()));
  // Y18 (inceleme): eski tarihli (saklı) kurla hesaplanan satırlar da aynı uyarıya girer: TCMB yanıt vermedi, yeniden
  // karşılaştırma güncel kurla tamamlar.
  const fxLines = all.fxMissing + invoices.reduce((a, i) => a + (Number(i.totals?.fxStale) || 0), 0);
  if (fxLines > 0) {
    alerts.push({
      id: 'fx-missing',
      tone: 'warning',
      title: t('alert.fx.title', { count: fxLines }),
      body: t('alert.fx.body'),
      href: dataLink(ctx, 'invoices', {}, p),
      actionLabel: t('alert.seeInvoices'),
    });
  }
  // K37: arka plandaki yeniden hesap 5 kez düşen faturalar (dönemden bağımsız: sorun sürüyor). Tek faturada ona, çoksa listeye.
  const recalcFailed = [...(await failedRecalcInvoices(companyId))];
  if (recalcFailed.length > 0) {
    alerts.push({
      id: 'recalc-failed',
      tone: 'warning',
      title: t('alert.recalcFailed.title', { count: recalcFailed.length }),
      body: t('alert.recalcFailed.body'),
      href: recalcFailed.length === 1 ? deciship.invoice(recalcFailed[0]!, 'ALL') : dataLink(ctx, 'invoices', {}),
      actionLabel: t(recalcFailed.length === 1 ? 'alert.openInvoice' : 'alert.seeInvoices'),
    });
  }
  if (all.flagged > 0) {
    alerts.push({
      id: 'flagged',
      tone: 'info',
      title: t('alert.flagged.title', { count: all.flagged }),
      body: t('alert.flagged.body'),
      href: dataLink(ctx, 'invoices', {}, p),
      actionLabel: t('alert.seeInvoices'),
    });
  }
  alerts.push(...tariffAlerts(ctx, tariffs));
  if (seeMeasurements && noPhoto > 0 && settings.requiredBoxPhotos > 0) {
    alerts.push({
      id: 'no-photo',
      tone: 'info',
      title: t('alert.photos.title', { count: noPhoto }),
      body: t('alert.photos.body'),
      href: dataLink(ctx, 'measurements', { photos: 'none' }, p),
      actionLabel: t('alert.seeMeasurements'),
    });
  }

  const overview: HubOverview = { product: 'deciship', from: p.from, to: p.to, kpis, alerts };
  // Deneme turu açık (Y122): sayılar örnek faturalardan. Merkez araç kartına "Örnek veri" notu koyar; alan yalnız turda gelir.
  if (settings.demo) overview.sample = true;
  if (money) {
    const split = buildSplit(ctx, p, facts, primary, others.length > 0, cur.billed);
    if (split) overview.split = split;
    const { leaders, foreignCarriers } = await buildLeaders(ctx, p, primary, others.length > 0);
    if (leaders.length) overview.leaders = leaders;
    if (foreignCarriers.length) {
      overview.alerts.push({
        id: 'other-currency',
        tone: 'info',
        title: t('alert.otherCurrency.title', { names: foreignCarriers.join(', ') }),
        body: t('alert.otherCurrency.body'),
      });
    }
  }
  // Kurulum yönlendirmesi yalnız kurulumu yapabilecek kişiye. Pano bandıyla aynı kural.
  if (ctx.can(P.settings)) {
    const facts = await setupFacts(companyId, settings);
    const { completed } = onboardingFlags(readOnboarding(settings.onboarding), facts);
    overview.setup = { completed, href: deciship.setup, label: completed ? '' : t('setup.label'), steps: setupSteps(ctx, facts) };
  }
  // Bağlantısı izinle düşen alanlar yanıtta `undefined` kalmasın.
  return JSON.parse(JSON.stringify(overview)) as HubOverview;
}
