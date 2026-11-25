import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { measurements, members } from '../api/endpoints';
import type { DimMethod } from '../api/types';
import { usePermission } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorState, Field, PageHeader, Pager, TableSkeleton, tabListKeyDown, tabStop } from '../components/ui';
import { fmtNum } from '../lib/format';
import { DIM_METHOD_LABEL } from '../lib/labels';
import { enumParam, pageParam } from '../lib/urlParams';
import { AddMeasurementModal } from './measurements/MeasurementModals';
import { MeasurementPanel } from './measurements/MeasurementPanel';
import { DeletedRow, MeasurementRow } from './measurements/Rows';
import { restoreMeasurement } from './measurements/shared';

const PAGE_SIZE = 50;

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function MeasurementsPage() {
  const { t } = useTranslation('measurements');
  const [sp, setSp] = useSearchParams();
  const [qText, setQText] = useState(sp.get('q') ?? '');
  const q = useDebounced(qText);
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const userId = sp.get('userId') ?? '';
  const method = enumParam(sp.get('method'), Object.keys(DIM_METHOD_LABEL) as DimMethod[], '');
  const page = pageParam(sp.get('page'));
  const canManage = usePermission('deciship.measurements.manage');
  const canCapture = usePermission('deciship.measurements.capture');
  const deletedMode = canManage && sp.get('deleted') === '1';
  const selected = sp.get('id');
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);
  const restore = async (id: string) => {
    setRestoring(id);
    await restoreMeasurement(qc, id);
    setRestoring(null);
  };
  const [moreOpen, setMoreOpen] = useState(Boolean(from || to || userId || method));

  const setParam = (k: string, v: string, resetPage = true) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (resetPage && k !== 'page') n.delete('page');
    setSp(n, { replace: true });
  };

  useEffect(() => {
    if ((sp.get('q') ?? '') !== q) setParam('q', q);
  }, [q]);

  const list = useQuery({
    queryKey: ['measurements', { q, from, to, userId, method, page, deleted: deletedMode }],
    queryFn: () => measurements.list({ q, from, to, userId, method, page, pageSize: PAGE_SIZE, deleted: deletedMode || undefined }),
    placeholderData: keepPreviousData,
  });
  const people = useQuery({ queryKey: ['members'], queryFn: members.list, meta: { silent: true } });

  const filtered = Boolean(q || from || to || userId || method);
  const activeExtra = [from, to, userId, method].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title={t('title')}
        sub={
          deletedMode
            ? list.data
              ? t('sub.deleted', { count: list.data.total, n: fmtNum(list.data.total) })
              : t('sub.deletedEmpty')
            : list.data
              ? t('sub.list', { count: list.data.total, n: fmtNum(list.data.total) })
              : t('sub.listEmpty')
        }
        actions={
          !deletedMode &&
          canCapture && (
            <Button icon="plus" onClick={() => setAdding(true)}>
              {t('add.title')}
            </Button>
          )
        }
        tabs={
          canManage && (
            <div className="ptabs" role="tablist" aria-label={t('tabs.aria')} onKeyDown={tabListKeyDown}>
              {[
                { on: !deletedMode, label: t('tabs.saved'), v: '' },
                { on: deletedMode, label: t('tabs.deleted'), v: '1' },
              ].map((t, i) => (
                <button
                  key={t.label}
                  type="button"
                  role="tab"
                  aria-selected={t.on}
                  tabIndex={tabStop(i, deletedMode ? 1 : 0)}
                  className={t.on ? 'on' : ''}
                  onClick={() => {
                    const n = new URLSearchParams(sp);
                    if (t.v) n.set('deleted', t.v);
                    else n.delete('deleted');
                    n.delete('id');
                    n.delete('page');
                    setSp(n, { replace: true });
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )
        }
      />
      <div className="layout">
        <div className="main">
          <div className="filters m-filters">
            <Field label={t('col.trackingNo')} htmlFor="mq" className="m-q">
              <div className="search">
                <Icon name="search" />
                <input
                  id="mq"
                  className="inp sm w-lg"
                  placeholder={t('filter.trackingSearch')}
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                />
              </div>
            </Field>
            <Button
              kind="secondary"
              small
              icon="filter"
              className="m-toggle"
              aria-expanded={moreOpen}
              aria-controls="m-more"
              onClick={() => setMoreOpen((o) => !o)}
            >
              {t('filter.toggle')}{activeExtra > 0 ? ` (${activeExtra})` : ''}
            </Button>
            <div id="m-more" className={`m-more${moreOpen ? ' open' : ''}`}>
            <Field label={t('filter.from')} htmlFor="mfrom">
              <input id="mfrom" type="date" className="inp sm w-sm" value={from} onChange={(e) => setParam('from', e.target.value)} />
            </Field>
            <Field label={t('filter.to')} htmlFor="mto">
              <input id="mto" type="date" className="inp sm w-sm" value={to} onChange={(e) => setParam('to', e.target.value)} />
            </Field>
            {!!people.data?.length && (
            <Field label={t('col.measuredByOnly')} htmlFor="muser">
              <select id="muser" className="sel sm w-md" value={userId} onChange={(e) => setParam('userId', e.target.value)}>
                <option value="">{t('filter.everyone')}</option>
                {people.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            )}
            <Field label={t('col.method')} htmlFor="mmethod">
              <select id="mmethod" className="sel sm w-md" value={method} onChange={(e) => setParam('method', e.target.value)}>
                <option value="">{t('filter.allMethods')}</option>
                {(Object.keys(DIM_METHOD_LABEL) as DimMethod[]).map((m) => (
                  <option key={m} value={m}>
                    {DIM_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            </div>
            {filtered && (
              <Button
                kind="ghost"
                small
                icon="close"
                onClick={() => {
                  setQText('');
                  setSp(new URLSearchParams(deletedMode ? { deleted: '1' } : {}), { replace: true });
                }}
              >
                {t('filter.clear')}
              </Button>
            )}
          </div>

          {list.isError && !list.data ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !list.data ? (
            <TableSkeleton cols={7} />
          ) : list.data.items.length === 0 ? (
            deletedMode && !filtered ? (
              <Empty icon="trash" title={t('empty.deletedTitle')}>
                {t('empty.deletedText')}
              </Empty>
            ) : filtered ? (
              <Empty icon="search" title={t('empty.noMatchTitle')}>
                {t('empty.noMatchText')}
              </Empty>
            ) : (
              <Empty icon="ruler" title={t('empty.noneTitle')}>
                {t('empty.noneText')}
              </Empty>
            )
          ) : (
            <>
              <div className="tbl-wrap" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
                <table className={`dt dt-cards m-table${selected ? ' tight' : ''}${deletedMode ? ' m-deleted' : ''}`}>
                  <thead>
                    <tr>
                      <th>{t('col.trackingNo')}</th>
                      <th className="r">{t('col.dims')}</th>
                      <th className="r">{t('col.actualKg')}</th>
                      <th className="r">{t('col.desi')}</th>
                      {!selected && <th className="r m-hide-sm">{t('col.volKg')}</th>}
                      <th className="m-c-how">{t('col.method')}</th>
                      {!selected && <th className="m-c-who">{t('col.measuredBy')}</th>}
                      {!selected && <th className="r m-hide-sm">{t('col.photos')}</th>}
                      <th>{deletedMode ? t('col.status') : t('col.invoice')}</th>
                      {deletedMode && (
                        <th>
                          <span className="sr-only">{t('col.action')}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((m) =>
                      deletedMode ? (
                        <DeletedRow
                          key={m.id}
                          m={m}
                          compact={Boolean(selected)}
                          selected={m.id === selected}
                          onOpen={() => setParam('id', m.id === selected ? '' : m.id, false)}
                          busy={restoring === m.id}
                          onRestore={() => restore(m.id)}
                        />
                      ) : (
                        <MeasurementRow key={m.id} m={m} compact={Boolean(selected)} selected={m.id === selected} onOpen={() => setParam('id', m.id === selected ? '' : m.id, false)} />
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pageSize={list.data.pageSize || PAGE_SIZE} total={list.data.total} onPage={(p) => setParam('page', String(p), false)} label={t('pagerLabel')} />
            </>
          )}
        </div>
        {selected && <MeasurementPanel id={selected} onClose={() => setParam('id', '', false)} onNewVersion={(nid) => setParam('id', nid, false)} />}
      </div>
      {adding && <AddMeasurementModal onClose={() => setAdding(false)} />}
    </>
  );
}
