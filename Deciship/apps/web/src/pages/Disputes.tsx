import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { disputes } from '../api/endpoints';
import type { DisputeCurrencySums, DisputeListItem, DisputeListResponse, DisputeListStatus } from '../api/types';
import { usePermission } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { Button, Card, Empty, ErrorState, Field, PageHeader, Pager, Skel, TableSkeleton, rowProps, tabListKeyDown, tabStop } from '../components/ui';
import { fmtDate, fmtMoney, fmtNum } from '../lib/format';
import { pageParam } from '../lib/urlParams';
import { DeadlineLine, ListStatusTag } from './disputes/parts';

const PAGE_SIZE = 25;
const STATUSES: DisputeListStatus[] = ['UNSENT', 'SENT', 'CLOSED'];

/** Faturalar arası itiraz listesi: tek toplam satırı, durum sekmeleri, fatura no araması; süresi yaklaşan varsa üstte. */
export function DisputesPage() {
  const { t } = useTranslation('disputes');
  const nav = useNavigate();
  const showPrices = usePermission('deciship.prices.view');
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('status');
  const status: DisputeListStatus | '' = raw && (STATUSES as string[]).includes(raw) ? (raw as DisputeListStatus) : '';
  const q = sp.get('q') ?? '';
  const page = pageParam(sp.get('page'));
  const [qText, setQText] = useState(q);

  const setParams = (patch: Record<string, string | null>) => {
    // adresin şu anki hali: art arda iki güncelleme birbirini geri almasın
    const n = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) n.set(k, v);
      else n.delete(k);
    }
    if (!('page' in patch)) n.delete('page');
    setSp(n, { replace: true });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (qText.trim() !== q) setParams({ q: qText.trim() || null });
    }, 300);
    return () => clearTimeout(timer);
  }, [qText]);
  // geri/ileri ya da "Temizle": kutu adresle aynı kalsın
  useEffect(() => setQText((cur) => (cur.trim() === q ? cur : q)), [q]);

  const list = useQuery({
    queryKey: ['disputes', { status, q, page }],
    queryFn: () => disputes.list({ status, q, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const d = list.data;
  const counts = d?.summary.counts;
  const clear = () => {
    setQText('');
    setParams({ q: null });
  };

  const totalCount = counts ? (counts.ALL ?? counts.UNSENT + counts.SENT + counts.CLOSED) : 0;
  const tabs: { key: DisputeListStatus | ''; label: string; count?: number }[] = [
    // gönderimden sonra satır eklenen fatura hem Gönderilmedi hem Gönderildi/Kapandı sayılır: Tümü toplam değil
    { key: '', label: t('listStatus.ALL'), count: counts ? (counts.ALL ?? counts.UNSENT + counts.SENT + counts.CLOSED) : undefined },
    ...STATUSES.map((s) => ({ key: s, label: t(`listStatus.${s}`), count: counts?.[s] })),
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        sub={totalCount ? t('sub', { count: totalCount, n: fmtNum(totalCount), unsent: fmtNum(counts?.UNSENT ?? 0) }) : undefined}
        tabs={
          <div className="ptabs dsp-tabs" role="tablist" aria-label={t('tabs.label')} onKeyDown={tabListKeyDown}>
            {tabs.map((x, i) => (
              <button
                key={x.key || 'ALL'}
                type="button"
                role="tab"
                aria-selected={status === x.key}
                tabIndex={tabStop(i, tabs.findIndex((y) => y.key === status))}
                className={status === x.key ? 'on' : ''}
                onClick={() => setParams({ status: x.key || null })}
              >
                {x.label}
                {x.count !== undefined && <span className={`cnt${x.key === 'UNSENT' && x.count > 0 ? ' warn' : ''}`}>{fmtNum(x.count)}</span>}
              </button>
            ))}
          </div>
        }
      />
      <div className="content dsp">
        {list.isError && !d ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <>
            {showPrices && <Totals rows={d?.summary.byCurrency} />}
            {d && d.summary.dueSoon.length > 0 && <DueSoon items={d.summary.dueSoon} />}

            <div className="filters dsp-filters">
              <Field label={t('filters.search')} htmlFor="dq" className="sr-label">
                <div className="search">
                  <Icon name="search" />
                  <input id="dq" className="inp sm w-lg" placeholder={t('filters.searchPh')} value={qText} onChange={(e) => setQText(e.target.value)} />
                </div>
              </Field>
            </div>

            {!d ? (
              <TableSkeleton cols={5} />
            ) : d.items.length === 0 ? (
              <ListEmpty data={d} status={status} searched={!!q} onClear={clear} />
            ) : (
              <>
                <div className={`table-wrap${list.isPlaceholderData ? ' is-stale' : ''}`}>
                  <DisputeTable items={d.items} showPrices={showPrices} onOpen={(id) => nav(`/invoices/${id}`)} />
                </div>
                <Pager page={page} pageSize={d.pageSize || PAGE_SIZE} total={d.total} onPage={(p) => setParams({ page: String(p) })} label={t('unit')} />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ListEmpty({ data, status, searched, onClear }: { data: DisputeListResponse; status: DisputeListStatus | ''; searched: boolean; onClear: () => void }) {
  const { t } = useTranslation('disputes');
  const c = data.summary.counts;
  if ((c.ALL ?? c.UNSENT + c.SENT + c.CLOSED) === 0)
    return (
      <Empty
        icon="flag"
        title={t('empty.none.title')}
        actions={
          <Link className="btn btn-secondary" to="/invoices">
            <Icon name="doc" /> {t('empty.none.action')}
          </Link>
        }
      >
        {t('empty.none.body')}
      </Empty>
    );
  if (searched)
    return (
      <Empty
        icon="search"
        title={t('empty.filtered.title')}
        actions={
          <Button kind="secondary" icon="close" onClick={onClear}>
            {t('filters.clear')}
          </Button>
        }
      />
    );
  return <Empty icon={status === 'UNSENT' ? 'ok' : 'flag'} title={t(`empty.${status || 'UNSENT'}.title`)} />;
}

/** Para birimi başına tek satır, dört rakam. Eksik kalan ve gönderilmeyen tutar alt satırda; para birimleri toplanmaz. */
function Totals({ rows }: { rows?: DisputeCurrencySums[] }) {
  const { t } = useTranslation('disputes');
  if (rows && rows.length === 0) return null;
  const multi = (rows?.length ?? 0) > 1;
  const cell = (label: string, value: number | undefined, cur: string, sub?: ReactNode, cls = '') => (
    <div className={`dsp-k ${cls}`}>
      <dt>{label}</dt>
      <dd className="num">{fmtMoney(value, cur)}</dd>
      {sub && <dd className="dsp-k-s">{sub}</dd>}
    </div>
  );
  return (
    <section className="dsp-sum" aria-label={t('sum.aria')}>
      <p className="dsp-period t3 s13">{t('sum.period')}</p>
      {!rows ? (
        <div className="dsp-sum-row">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="dsp-k">
              <Skel w={90} h={12} />
              <Skel w={120} h={28} />
            </div>
          ))}
        </div>
      ) : (
        rows.map((r) => (
          <dl key={r.currency} className="dsp-sum-row">
            {multi && <div className="dsp-cur">{r.currency}</div>}
            {cell(t('sum.claimed'), r.claimedAmount, r.currency, (r.unsentAmount ?? 0) > 0 ? t('sum.unsent', { amount: fmtMoney(r.unsentAmount, r.currency) }) : null)}
            {cell(t('sum.pending'), r.pendingAmount, r.currency)}
            {cell(
              t('sum.recovered'),
              r.recoveredAmount,
              r.currency,
              (r.shortfallAmount ?? 0) > 0 ? <span className="warn-t">{t('sum.shortfall', { amount: fmtMoney(r.shortfallAmount, r.currency) })}</span> : null,
              (r.recoveredAmount ?? 0) > 0 ? 'good' : '',
            )}
            {cell(t('sum.rejected'), r.rejectedAmount, r.currency, null, (r.rejectedAmount ?? 0) > 0 ? 'bad' : '')}
          </dl>
        ))
      )}
    </section>
  );
}

/**
 * Tek süre satırı. Gönderilmemişte en yakın açık süre (TTK, sonra taşıyıcı); gönderilmişte TTK'ya göre zamanında mı
 * (TTK yoksa taşıyıcı süresine göre).
 */
function Deadline({ x }: { x: DisputeListItem }) {
  const { t } = useTranslation('disputes');
  const { ttk, carrier } = x.deadlines ?? {};
  const carrierLabel = x.carrier?.name ?? t('deadline.carrierFallback');
  // gönderilmemiş satırı varsa süre sayılır ("zamanında" denmez)
  // KALANLAR 4a: süreye esas gün ilk gönderim (yeniden gönderimin günü değil)
  const sentOn = (x.unsentLineCount ?? 0) > 0 ? null : (x.ttkSentOn ?? x.sentOn);
  const pick = sentOn ? (ttk ? 'ttk' : carrier ? 'carrier' : null) : ttk && !ttk.expired ? 'ttk' : carrier ? 'carrier' : ttk ? 'ttk' : null;
  if (!pick) return <span className="t3">—</span>;
  return pick === 'ttk' ? (
    <DeadlineLine label={t('deadline.ttk')} info={ttk!} sentOn={sentOn} ttkStatus={x.ttkStatus} />
  ) : (
    <DeadlineLine label={carrierLabel} info={carrier!} sentOn={sentOn} />
  );
}

function DueSoon({ items }: { items: DisputeListItem[] }) {
  const { t } = useTranslation('disputes');
  return (
    <Card title={t('due.title')} className="dsp-due">
      <ul className="dsp-due-list">
        {items.map((x) => (
          <li key={x.invoiceId}>
            <Link to={`/invoices/${x.invoiceId}`} className="dsp-due-a">
              <span className="id mono">{x.invoiceNo}</span>
              <span className="t3 s13">{x.carrier?.name}</span>
            </Link>
            <Deadline x={x} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DisputeTable({ items, showPrices, onOpen }: { items: DisputeListItem[]; showPrices: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation('disputes');
  return (
    <table className="dt dt-cards dsp-list">
      <thead>
        <tr>
          <th>{t('cols.invoice')}</th>
          <th>{t('cols.status')}</th>
          {showPrices && <th className="r">{t('cols.claimed')}</th>}
          {showPrices && <th className="r">{t('cols.recovered')}</th>}
          <th>{t('cols.deadlines')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((x) => {
          const sent = x.status !== 'UNSENT';
          const shortfall = x.sums.shortfallAmount ?? 0;
          const unsent = sent ? (x.unsentLineCount ?? 0) : 0;
          return (
            <tr key={x.invoiceId} {...rowProps(() => onOpen(x.invoiceId), false)}>
              <td className="card-title">
                <span className="dsp-id">
                  <span className="id mono">{x.invoiceNo}</span>
                  <span className="sub">{[x.carrier?.name, fmtDate(x.invoiceDate)].filter(Boolean).join(' · ')}</span>
                </span>
              </td>
              <td data-label={t('cols.status')}>
                <span className="dsp-cell">
                  <ListStatusTag status={x.status} recovered={x.sums.recoveredAmount} />
                  <span className="sub">{sent ? t('row.sentOn', { date: fmtDate(x.sentOn) }) : t('row.notSent', { count: x.lineCount, n: fmtNum(x.lineCount) })}</span>
                  {unsent > 0 && <span className="sub warn-t">{t('row.unsentAfterSend', { count: unsent, n: fmtNum(unsent) })}</span>}
                </span>
              </td>
              {showPrices && (
                <td data-label={t('cols.claimed')} className="r num">
                  {fmtMoney(x.sums.claimedAmount, x.currency)}
                </td>
              )}
              {showPrices && (
                <td data-label={t('cols.recovered')} className="r num">
                  <span className="dsp-cell r">
                    {sent ? <span className={(x.sums.recoveredAmount ?? 0) > 0 ? 'green sb' : 't3'}>{fmtMoney(x.sums.recoveredAmount, x.currency)}</span> : <span className="t3">—</span>}
                    {shortfall > 0 && <span className="sub warn-t">{t('row.shortfall', { amount: fmtMoney(shortfall, x.currency) })}</span>}
                  </span>
                </td>
              )}
              <td data-label={t('cols.deadlines')}>
                <Deadline x={x} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
