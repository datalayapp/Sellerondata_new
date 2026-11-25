import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { dashboard } from '../api/endpoints';
import type { DimMethod, InvoiceListItem } from '../api/types';
import { Icon } from '../components/Icon';
import { Card, Empty, ErrorState, PageHeader, Skel, rowProps } from '../components/ui';
import { firmCurrency } from '../lib/currency';
import { fmtDate, fmtMoney, fmtMoneySplit, fmtNum, monthKey, monthLabel, recentMonthKeys } from '../lib/format';
import { DIFF_LABEL, DIM_METHOD_LABEL } from '../lib/labels';
import { DiffTypeLabel } from '../components/TermHint';
import { usePermission, useProductMe } from '../auth/AuthContext';
import { OnboardingBanner } from './onboarding/OnboardingBanner';

/** Son faturanın ayı (YYYY-MM). Fatura yoksa ya da bu aydaysa null. */
function latestInvoiceMonth(rows: { invoiceDate: string }[]): string | null {
  const latest = rows.map((r) => r.invoiceDate.slice(0, 7)).sort().at(-1);
  return latest && latest !== monthKey() ? latest : null;
}

export function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const me = useProductMe();
  const canUpload = usePermission('deciship.invoices.upload');
  const showPrices = usePermission('deciship.prices.view');
  const nav = useNavigate();
  const thisMonth = monthKey();
  const [picked, setPicked] = useState<string | null>(null);
  const currentQ = useQuery({ queryKey: ['dashboard', thisMonth], queryFn: () => dashboard.get(thisMonth) });
  // içinde bulunulan ayda fatura yoksa son faturanın ayı: Merkez'deki son 30 gün rakamıyla çelişmesin. Kişinin seçimi ezilmez.
  const lastDataMonth = !picked && currentQ.data && currentQ.data.invoices.count === 0 ? latestInvoiceMonth(currentQ.data.recentInvoices) : null;
  const month = picked ?? lastDataMonth ?? thisMonth;
  const q = useQuery({ queryKey: ['dashboard', month], queryFn: () => dashboard.get(month) });
  const d = q.data;
  const cur = d?.currency ?? firmCurrency(me);
  // Baş rakam tek para birimindedir; diğerleri toplanmaz, ayrı yazılır.
  const others = (d?.byCurrency ?? []).filter((c) => c.currency !== cur);

  const [y, mo] = month.split('-').map(Number);
  const monthRange = `from=${month}-01&to=${month}-${String(new Date(y!, mo!, 0).getDate()).padStart(2, '0')}`;

  return (
    <>
      <PageHeader
        hero
        title={t('title')}
        // Firma adı firma seçicide, ay dönem seçicide: alt satır yalnız "son veri" notunu taşır.
        sub={lastDataMonth === month ? <span className="dash-lastdata">{t('lastData', { month: monthLabel(month) })}</span> : undefined}
        actions={
          <>
            <div className="dash-month">
              <label className="sr-only" htmlFor="month">
                {t('period')}
              </label>
              <Icon name="calendar" />
              <select id="month" className="sel" value={month} onChange={(e) => setPicked(e.target.value)}>
                {Array.from(new Set([...recentMonthKeys(12), month])).map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            {canUpload && (
              <Link className="btn btn-primary" to="/invoices/upload">
                <Icon name="upload" /> {t('uploadInvoice')}
              </Link>
            )}
          </>
        }
      />
      <div className="content">
        {q.isError && !d ? (
          <>
            <OnboardingBanner />
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </>
        ) : (
          <div className="dash">
            {/* baş kart banda biner; kurulum bandı altında */}
            <section className="dash-lead lift" aria-label={t('kpi.aria')}>
              {showPrices && (
                <div className="dash-hero on-ink">
                  <div className="dash-hero-main">
                    <span className="dash-hero-l">{t('kpi.overpayment')}</span>
                    <span className={`dash-hero-v num${d && d.overchargeTotal > 0 ? ' red' : ''}`}>{d ? <MoneyBig n={d.overchargeTotal} cur={cur} /> : <Skel w={200} h={40} />}</span>
                    <span className="dash-hero-s">
                      {d ? (
                        <>
                          {t('kpi.compared', { count: d.invoices.count, invoices: fmtNum(d.invoices.count), lines: fmtNum(d.invoices.lines) })}
                          {d.invoices.diff > 0 && <b> · {t('kpi.diffLines', { count: d.invoices.diff, n: fmtNum(d.invoices.diff) })}</b>}
                        </>
                      ) : (
                        <Skel w={200} h={12} />
                      )}
                    </span>
                  </div>
                  <div className="dash-hero-side">
                    <div className="dash-hero-row">
                      <span>{t('kpi.verifiedLabel')}</span>
                      <b className="num">{d ? fmtMoney(d.verifiedTotal, cur) : <Skel w={80} h={14} />}</b>
                    </div>
                    {d && d.recoveredTotal !== undefined && (
                      <dl className="dash-disp" aria-label={t('kpi.disputes')}>
                        <div>
                          <dt>
                            <Link to="/disputes">{t('kpi.recovered')}</Link>
                          </dt>
                          <dd className={`num${d.recoveredTotal > 0 ? ' green' : ''}`}>{fmtMoney(d.recoveredTotal, cur)}</dd>
                        </div>
                        <div>
                          <dt>
                            <Link to="/disputes?status=SENT">{t('kpi.disputePending')}</Link>
                          </dt>
                          <dd className="num">{fmtMoney(d.disputePendingTotal, cur)}</dd>
                        </div>
                      </dl>
                    )}
                    <Link className="dash-hero-go" to={`/invoices?${monthRange}`}>
                      {t('kpi.periodInvoices')} <Icon name="arrow" />
                    </Link>
                  </div>
                  {!!others.length && (
                    <ul className="dash-cur" aria-label={t('kpi.otherCurrencies')}>
                      {others.map((c) => (
                        <li key={c.currency}>
                          <span>{t('kpi.inCurrency', { currency: c.currency, count: c.invoices, n: fmtNum(c.invoices) })}</span>
                          <b className="num">{fmtMoney(c.overchargeTotal, c.currency)}</b>
                          {((c.recoveredTotal ?? 0) > 0 || (c.disputePendingTotal ?? 0) > 0) && (
                            <span className="dash-cur-d">
                              {t('kpi.curDisputes', { recovered: fmtMoney(c.recoveredTotal ?? 0, c.currency), pending: fmtMoney(c.disputePendingTotal ?? 0, c.currency) })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <dl className="dash-rows">
                <Metric
                  label={month === monthKey() ? t('kpi.measurementsThisMonth') : t('kpi.measurements')}
                  loading={!d}
                  value={d && fmtNum(d.measurements.count)}
                  sub={d && month === monthKey() ? t('kpi.today', { n: fmtNum(d.measurements.today) }) : undefined}
                  to="/measurements"
                />
                <Metric label={t('kpi.billedShipments')} loading={!d} value={d && fmtNum(d.invoices.lines)} sub={d && t('kpi.invoices', { count: d.invoices.count, n: fmtNum(d.invoices.count) })} to="/invoices" />
                <Metric
                  label={t('kpi.discrepancies')}
                  loading={!d}
                  value={d && fmtNum(d.invoices.diff)}
                  sub={d && t('kpi.matchSplit', { match: fmtNum(d.invoices.match), unmatched: fmtNum(d.invoices.unmatched) })}
                  to="/invoices"
                />
                <Metric
                  label={t('kpi.coverage')}
                  loading={!d}
                  value={d && t('percent', { value: fmtNum(d.coveragePct, 0, 1) })}
                  sub={
                    <>
                      {t('kpi.coverageSub')} <span className="t3">{t('coverage.periodNote')}</span>
                    </>
                  }
                  bar={d ? Math.max(0, Math.min(100, d.coveragePct)) : undefined}
                />
              </dl>
            </section>
            <OnboardingBanner />

            <div className="dash-grid">
              <Card title={t('diffTypes.title')} description={t('diffTypes.desc')} className="dash-diff">
                {!d ? (
                  <div className="col" style={{ gap: 14 }}>
                    <Skel />
                    <Skel />
                    <Skel w="70%" />
                  </div>
                ) : d.topDiffTypes.length === 0 ? (
                  d.invoices.count === 0 ? (
                    <Empty compact icon="doc" title={t('diffTypes.noInvoices')}>
                      {t('diffTypes.noInvoicesText')}
                    </Empty>
                  ) : (
                    <Empty compact icon="check" title={t('diffTypes.none')}>
                      {t('diffTypes.noneText')}
                    </Empty>
                  )
                ) : (
                  <DiffBars rows={d.topDiffTypes} cur={cur} />
                )}
              </Card>
              <Card title={t('methods.title')} description={d ? t('methods.desc', { month: monthLabel(month), count: d.measurements.count, n: fmtNum(d.measurements.count) }) : t('methods.descEmpty', { month: monthLabel(month) })} className="dash-methods">
                {!d ? <Skel /> : <MethodBars byMethod={d.measurements.byMethod} total={d.measurements.count} />}
              </Card>
            </div>

            <Card
              flush
              title={t('recent.title')}
              actions={
                <Link className="link-btn" to="/invoices">
                  {t('recent.viewAll')} <Icon name="arrow" />
                </Link>
              }
            >
              {!d ? (
                <div style={{ padding: '0 24px 24px' }} className="col">
                  <Skel />
                  <Skel />
                  <Skel />
                </div>
              ) : d.recentInvoices.length === 0 ? (
                <Empty
                  compact
                  icon="upload"
                  title={t('recent.emptyTitle')}
                  actions={
                    canUpload && (
                      <Link className="btn btn-secondary" to="/invoices/upload">
                        <Icon name="upload" /> {t('uploadInvoice')}
                      </Link>
                    )
                  }
                >
                  {t('recent.emptyText')}
                </Empty>
              ) : (
                <RecentTable rows={d.recentInvoices} cur={cur} showPrices={showPrices} onOpen={(id) => nav(`/invoices/${id}`)} />
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

/** Büyük tutar: birim (₺ ya da bilinmeyen kod) küçük; parçalar paketten (`fmtMoneySplit`), metin ayrıştırılmaz. */
function MoneyBig({ n, cur }: { n: number; cur: string }) {
  const p = fmtMoneySplit(n, cur);
  return (
    <>
      {p.before}
      {p.small && <small>{p.small}</small>}
      {p.after}
    </>
  );
}

/** Cetvelli gösterge satırı. Merkez'in dönem satırlarıyla aynı dil: ad solda, sayı sağda. */
function Metric({ label, value, sub, to, loading, bar }: { label: string; value: ReactNode; sub?: ReactNode; to?: string; loading: boolean; bar?: number }) {
  return (
    <div className={`dash-row${bar !== undefined ? ' has-bar' : ''}`}>
      <dt>
        {to ? (
          <Link className="dash-row-a" to={to}>
            {label}
          </Link>
        ) : (
          label
        )}
        {sub && <span className="dash-row-s">{sub}</span>}
      </dt>
      <dd className="num">{loading ? <Skel w={48} h={18} /> : value}</dd>
      {bar !== undefined && (
        <span className="dash-row-bar bar" aria-hidden="true">
          <i style={{ width: `${bar}%` }} />
        </span>
      )}
    </div>
  );
}

function DiffBars({ rows, cur }: { rows: { type: keyof typeof DIFF_LABEL; count: number; amount: number }[]; cur: string }) {
  const { t } = useTranslation('dashboard');
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div role="table" aria-label={t('diffTypes.title')} className="rr-list">
      <div className="rr h" role="row">
        <div role="columnheader">{t('diffTypes.colType')}</div>
        <div className="rr-bar" aria-hidden="true" />
        <div className="right" role="columnheader">
          {t('diffTypes.colLines')}
        </div>
        <div className="right" role="columnheader">
          {t('diffTypes.colOverpayment')}
        </div>
      </div>
      {rows.map((r) => (
        <div className="rr" role="row" key={r.type}>
          <div role="cell" className="rr-name">
            <DiffTypeLabel type={r.type} label={DIFF_LABEL[r.type] ?? r.type} />
          </div>
          <div className="rr-bar bar" aria-hidden="true">
            <i style={{ width: `${Math.max((r.amount / max) * 100, 2)}%` }} />
          </div>
          <div className="right num rr-count" role="cell" data-unit={t('diffTypes.lineUnit', { count: r.count })}>
            {fmtNum(r.count)}
          </div>
          <div className="right num rr-amt" role="cell">
            {fmtMoney(r.amount, cur)}
          </div>
        </div>
      ))}
      <div className="rr tot" role="row">
        <div role="cell" className="rr-name">
          {t('diffTypes.total')}
        </div>
        <div className="rr-bar" aria-hidden="true" />
        <div className="right num rr-count" role="cell" data-unit={t('diffTypes.lineUnit', { count: totalCount })}>
          {fmtNum(totalCount)}
        </div>
        <div className="right num sb rr-amt" role="cell">
          {fmtMoney(totalAmount, cur)}
        </div>
      </div>
    </div>
  );
}

const METHOD_COLORS: Record<DimMethod, string> = {
  LIDAR: '#1d5bd8',
  AR: '#7a5af8',
  REFERENCE: '#0e9384',
  PRESET: '#dc6803',
  MANUAL: '#98a2b3',
};

function MethodBars({ byMethod, total }: { byMethod: Partial<Record<DimMethod, number>>; total: number }) {
  const { t } = useTranslation('dashboard');
  const entries = (Object.keys(METHOD_COLORS) as DimMethod[]).map((k) => [k, byMethod[k] ?? 0] as const).filter(([, v]) => v > 0);
  if (!total || !entries.length)
    return (
      <Empty compact icon="ruler" title={t('methods.emptyTitle')}>
        {t('methods.emptyText')}
      </Empty>
    );
  return (
    <>
      <div className="stack" aria-hidden="true">
        {entries.map(([k, v]) => (
          <i key={k} style={{ width: `${(v / total) * 100}%`, background: METHOD_COLORS[k] }} />
        ))}
      </div>
      <ul className="legend">
        {entries.map(([k, v]) => (
          <li key={k}>
            <i style={{ background: METHOD_COLORS[k] }} />
            <span className="grow">{DIM_METHOD_LABEL[k]}</span>
            <span className="num sb">{fmtNum(v)}</span>
            <span className="num t3 pct">{t('percent', { value: fmtNum((v / total) * 100, 0, 0) })}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function RecentTable({ rows, cur, showPrices, onOpen }: { rows: InvoiceListItem[]; cur: string; showPrices: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation('dashboard');
  return (
    <div className="table-wrap">
      <table className="dt dt-cards">
        <thead>
          <tr>
            <th>{t('recent.colInvoice')}</th>
            <th>{t('recent.colCarrier')}</th>
            <th className="r">{t('recent.colLines')}</th>
            <th className="r">{t('recent.colDiscrepancies')}</th>
            {showPrices && <th className="r">{t('recent.colBilled')}</th>}
            {showPrices && <th className="r">{t('recent.colOverpayment')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} {...rowProps(() => onOpen(r.id), false)}>
              <td className="card-title">
                <span className="id mono">{r.invoiceNo}</span>
                <span className="sub">{fmtDate(r.invoiceDate)}</span>
              </td>
              <td data-label={t('recent.colCarrier')}>{r.carrier?.name}</td>
              <td data-label={t('recent.colLines')} className="r num">
                {fmtNum(r.totals.lines)}
              </td>
              <td data-label={t('recent.colDiscrepancies')} className="r num">
                {r.totals.diff > 0 ? <span className="sb">{fmtNum(r.totals.diff)}</span> : 0}
              </td>
              {showPrices && (
                <td data-label={t('recent.colBilled')} className="r num">
                  {fmtMoney(r.totals.billedTotal, r.currency ?? cur)}
                </td>
              )}
              {showPrices && (
                <td data-label={t('recent.colOverpayment')} className={`r num ${r.totals.overchargeTotal > 0 ? 'sb' : ''}`}>
                  {fmtMoney(r.totals.overchargeTotal, r.currency ?? cur)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
