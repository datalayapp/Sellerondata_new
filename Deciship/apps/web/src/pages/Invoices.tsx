import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { carriers, invoices } from '../api/endpoints';
import type { InvoiceListItem, InvoiceListStatus, InvoiceTotals } from '../api/types';
import { usePermission } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toast';
import { Button, Empty, ErrorState, Field, Modal, ModalAction, PageHeader, Pager, TableSkeleton, rowProps } from '../components/ui';
import { FEATURES } from '../lib/features';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../lib/format';
import { pageParam } from '../lib/urlParams';
import { InvoiceDisputeTag, disputeErrorText } from './disputes/parts';
import { MoreMenu } from './invoice-detail/MoreMenu';

const PAGE_SIZE = 25;
const STATUSES: { value: InvoiceListStatus; key: 'statusDiff' | 'statusUnmatched' | 'statusToDispute' }[] = [
  { value: 'DIFF', key: 'statusDiff' },
  { value: 'UNMATCHED', key: 'statusUnmatched' },
  { value: 'TO_DISPUTE', key: 'statusToDispute' },
];
const statusOf = (v: string | null): InvoiceListStatus | '' => STATUSES.find((s) => s.value === v)?.value ?? '';

export function InvoicesPage() {
  const { t } = useTranslation('invoices');
  const nav = useNavigate();
  const qc = useQueryClient();
  const canUpload = usePermission('deciship.invoices.upload');
  const showPrices = usePermission('deciship.prices.view');
  const [sp, setSp] = useSearchParams();
  const carrierId = sp.get('carrierId') ?? '';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const search = FEATURES.invoiceSearch;
  const q = search ? (sp.get('q') ?? '').trim().slice(0, 64) : '';
  const status = search ? statusOf(sp.get('status')) : '';
  const page = pageParam(sp.get('page'));
  const [qText, setQText] = useState(q);
  const [datesOpen, setDatesOpen] = useState(false);
  const [toDelete, setToDelete] = useState<InvoiceListItem | null>(null);

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n, { replace: true });
  };

  // Arama 300 ms gecikmeli adrese yazılır (her tuşta istek gitmez).
  useEffect(() => {
    const v = qText.trim().slice(0, 64);
    if (v === q) return;
    const id = setTimeout(() => setParam('q', v), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);

  const cs = useQuery({ queryKey: ['carriers'], queryFn: carriers.list });
  const list = useQuery({
    queryKey: ['invoices', { carrierId, from, to, q, status, page }],
    queryFn: () => invoices.list({ carrierId, from, to, q: q || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const del = useMutation({
    mutationFn: (id: string) => invoices.remove(id),
    // gönderilmiş itirazı olan fatura silinmez (409 INVOICE_HAS_DISPUTE): ne yapılacağı kendi cümlesiyle
    meta: { silent: true },
    onError: (e) => toast.err(t('toast.deleteFailed'), disputeErrorText(e)),
    onSuccess: () => {
      toast.ok(t('toast.deleted'));
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const filtered = Boolean(carrierId || from || to || q || status);
  const clear = () => {
    setQText('');
    setSp(new URLSearchParams(), { replace: true });
  };
  // Tarih alanları "Tarih" düğmesinin arkasındadır; bir tarih seçiliyse açık kalır.
  const showDates = !search || datesOpen || Boolean(from || to);

  return (
    <>
      <PageHeader
        title={t('title')}
        sub={list.data ? t('subCount', { count: list.data.total, n: fmtNum(list.data.total) }) : undefined}
        actions={
          canUpload && (
            <Link className="btn btn-primary" to="/invoices/upload">
              <Icon name="upload" /> {t('upload')}
            </Link>
          )
        }
      />
      <div className="content">
        <div className="filters inv-filters">
          {search && (
            <Field label={t('filters.search')} htmlFor="iq" className="sr-label">
              <div className="search">
                <Icon name="search" />
                <input
                  id="iq"
                  type="search"
                  className="inp sm w-lg"
                  placeholder={t('filters.searchPlaceholder')}
                  maxLength={64}
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                />
              </div>
            </Field>
          )}
          {search && (
            <Field label={t('filters.status')} htmlFor="ist">
              <select id="ist" className="sel sm w-md" value={status} onChange={(e) => setParam('status', e.target.value)}>
                <option value="">{t('filters.allStatuses')}</option>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {t(`filters.${s.key}`)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('filters.carrier')} htmlFor="icar">
            <select id="icar" className="sel sm w-md" value={carrierId} onChange={(e) => setParam('carrierId', e.target.value)}>
              <option value="">{t('filters.allCarriers')}</option>
              {cs.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {search && !showDates && (
            <Button kind="ghost" small icon="calendar" onClick={() => setDatesOpen(true)}>
              {t('filters.dates')}
            </Button>
          )}
          {showDates && (
            <>
              <Field label={t('filters.dateFrom')} htmlFor="ifrom">
                <input id="ifrom" type="date" className="inp sm w-md" value={from} onChange={(e) => setParam('from', e.target.value)} />
              </Field>
              <Field label={t('filters.dateTo')} htmlFor="ito">
                <input id="ito" type="date" className="inp sm w-md" value={to} onChange={(e) => setParam('to', e.target.value)} />
              </Field>
            </>
          )}
          {filtered && (
            <Button kind="ghost" small icon="close" onClick={clear}>
              {t('filters.clear')}
            </Button>
          )}
        </div>

        {list.isError && !list.data ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data ? (
          <TableSkeleton cols={7} />
        ) : list.data.items.length === 0 ? (
          q ? (
            <Empty
              icon="search"
              title={t('empty.search.title')}
              actions={
                <Button kind="secondary" icon="close" onClick={clear}>
                  {t('filters.clear')}
                </Button>
              }
            >
              {t('empty.search.body')}
            </Empty>
          ) : filtered ? (
            <Empty
              icon="search"
              title={t('empty.filtered.title')}
              actions={
                <Button kind="secondary" icon="close" onClick={clear}>
                  {t('filters.clear')}
                </Button>
              }
            >
              {t('empty.filtered.body')}
            </Empty>
          ) : (
            <Empty
              icon="upload"
              title={t('empty.none.title')}
              actions={
                canUpload && (
                  <Link className="btn btn-secondary" to="/invoices/upload">
                    <Icon name="upload" /> {t('upload')}
                  </Link>
                )
              }
            >
              {t('empty.none.body')}
            </Empty>
          )
        ) : (
          <>
            <div className={`table-wrap${list.isPlaceholderData ? ' is-stale' : ''}`}>
              <table className="dt dt-cards inv-list">
                <thead>
                  <tr>
                    <th>{t('cols.invoice')}</th>
                    <th className="inv-c-date">{t('cols.date')}</th>
                    <th>{t('cols.lineStatus')}</th>
                    <th className="inv-c-st">{t('cols.status')}</th>
                    {showPrices && <th className="r">{t('cols.billed')}</th>}
                    {showPrices && <th className="r">{t('cols.overpaid')}</th>}
                    {showPrices && <th className="r inv-c-ver">{t('cols.verified')}</th>}
                    {canUpload && (
                      <th>
                        <span className="sr-only">{t('cols.actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((r) => {
                    const cur = r.currency;
                    const over = r.totals.overchargeTotal > 0;
                    return (
                      <tr key={r.id} {...rowProps(() => nav(`/invoices/${r.id}`), false)}>
                        <td className="card-title">
                          <span className="inv-id">
                            <span className="lg" aria-hidden="true">
                              {(r.carrier?.name ?? '?').charAt(0).toLocaleUpperCase('tr-TR')}
                            </span>
                            <span className="inv-id-t">
                              <span className="id mono">{r.invoiceNo}</span>
                              {/* tarih sütunu sığmayınca (orta genişlik) burada */}
                              <span className="sub inv-date-inline">{fmtDate(r.invoiceDate)}</span>
                              {/* itiraz durumu sütunu sığmayınca (orta genişlik) burada; İşlendi varsayılandır, yazılmaz */}
                              {r.disputeStatus && r.disputeStatus !== 'NONE' && (
                                <span className="inv-st-inline">
                                  <InvoiceDisputeTag status={r.disputeStatus} recovered={r.disputeSums?.recoveredAmount} />
                                </span>
                              )}
                              <span className="sub">{t('uploadedAt', { carrier: r.carrier?.name, date: fmtDateTime(r.createdAt) })}</span>
                            </span>
                          </span>
                        </td>
                        <td data-label={t('cols.date')} className="inv-c-date">
                          {fmtDate(r.invoiceDate)}
                        </td>
                        <td data-label={t('cols.lineStatus')}>
                          <LineMix t={r.totals} />
                        </td>
                        <td data-label={t('cols.status')} className="inv-c-st">
                          <span className="inv-st">
                            <InvoiceDisputeTag status={r.disputeStatus ?? 'NONE'} recovered={r.disputeSums?.recoveredAmount} />
                            {/* para geldiyse (gönderildi ya da kapandı) geri alınan; hiç gelmeden kapandıysa reddedilen */}
                            {showPrices && (r.disputeSums?.recoveredAmount ?? 0) > 0 ? (
                              <span className="sub">{t('recovered', { amount: fmtMoney(r.disputeSums!.recoveredAmount, cur) })}</span>
                            ) : (
                              showPrices &&
                              r.disputeStatus === 'CLOSED' &&
                              r.disputeSums?.rejectedAmount != null && (
                                <span className="sub">{t('rejected', { amount: fmtMoney(r.disputeSums.rejectedAmount, cur) })}</span>
                              )
                            )}
                          </span>
                        </td>
                        {showPrices && (
                          <td data-label={t('cols.billed')} className="r num">
                            {fmtMoney(r.totals.billedTotal, cur)}
                          </td>
                        )}
                        {showPrices && (
                          <td data-label={t('cols.overpaid')} className={`r num${over ? ' red sb' : ' t3'}`}>
                            {fmtMoney(r.totals.overchargeTotal, cur)}
                          </td>
                        )}
                        {showPrices && (
                          <td data-label={t('cols.verified')} className={`r num inv-c-ver${r.totals.verifiedTotal > 0 ? '' : ' t3'}`}>
                            {fmtMoney(r.totals.verifiedTotal, cur)}
                          </td>
                        )}
                        {canUpload && (
                          <td className="actions">
                            <MoreMenu
                              label={t('moreAria', { no: r.invoiceNo })}
                              items={[{ label: t('delete'), icon: 'trash', danger: true, onSelect: () => setToDelete(r) }]}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pageSize={list.data.pageSize || PAGE_SIZE}
              total={list.data.total}
              onPage={(p) => setParam('page', String(p))}
              label={t('unit')}
            />
          </>
        )}
      </div>
      {toDelete && (
        <Modal
          busy={del.isPending}
          label={toDelete.carrier?.name}
          title={t('deleteDialog.title', { no: toDelete.invoiceNo })}
          onClose={() => setToDelete(null)}
          actions={
            <>
              <ModalAction kind="dark" onClick={() => setToDelete(null)}>
                {t('deleteDialog.cancel')}
              </ModalAction>
              <ModalAction kind="danger" icon="trash" loading={del.isPending} onClick={() => del.mutate(toDelete.id)}>
                {t('delete')}
              </ModalAction>
            </>
          }
        >
          <p>{t('deleteDialog.body')}</p>
        </Modal>
      )}
    </>
  );
}

/** Compact line-status mix: stacked bar (match / diff / unmatched / no tariff) + counts. */
function LineMix({ t: tt }: { t: InvoiceTotals }) {
  const { t } = useTranslation('invoices');
  const total = Math.max(tt.lines, 1);
  const parts = [
    { k: 'match', n: tt.match },
    { k: 'diff', n: tt.diff },
    { k: 'unmatched', n: tt.unmatched },
    { k: 'notariff', n: tt.noTariff },
  ];
  return (
    <span className="mix">
      <span className="mix-bar" aria-hidden="true">
        {parts.map((p) => (p.n > 0 ? <i key={p.k} className={p.k} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
      </span>
      <span className="mix-txt">
        <span className="num">{t('mix.lines', { count: tt.lines, n: fmtNum(tt.lines) })}</span>
        {tt.diff > 0 && <span className="red sb num">{t('mix.diff', { count: tt.diff, n: fmtNum(tt.diff) })}</span>}
        {tt.unmatched > 0 && <span className="num">{t('mix.unmatched', { count: tt.unmatched, n: fmtNum(tt.unmatched) })}</span>}
        {tt.noTariff > 0 && <span className="num">{t('mix.noTariff', { count: tt.noTariff, n: fmtNum(tt.noTariff) })}</span>}
        {tt.diff === 0 && tt.unmatched === 0 && tt.noTariff === 0 && tt.lines > 0 && <span className="green">{t('mix.allMatch')}</span>}
      </span>
    </span>
  );
}
