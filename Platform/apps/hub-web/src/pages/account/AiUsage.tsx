import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { HUB_AI_MEMBER_NONE, PRODUCTS, PRODUCT_KEYS, type HubAiCall, type HubAiCallPage, type HubAiUsage, type ProductKey } from '@sellerondata/contracts';
import {
  ApiError,
  Button,
  Empty,
  ErrorState,
  Field,
  PageHeader,
  Skel,
  TableSkeleton,
  Tag,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  rowProps,
  shellTimeZone,
  toast,
  useMe,
} from '@sellerondata/shell';
import { exportAiCalls, fetchAiCalls, fetchAiUsage, type AiCallsFilter } from '../../api/hub.ts';
import { formatDuration } from '../../components/AiUsageCard.tsx';
import { canExport, meProduct } from '../../lib/access.ts';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { isoDay } from '../../lib/period.ts';
import { CallDrawer, MonthPicker, PERIOD_RE, RecordLink, StatusTag, addMonths, dayRangeLabel, monthLabel, type MonthOption } from './AiUsageParts.tsx';

/*
 * Abonelik → Yapay zekâ kullanımı (`/account/billing/ai/:product`): bir ayın özeti, türe ve kişiye göre dağılım, tek tek
 * bütün işlemler. Ay adreste (`?period=YYYY-MM`), süzgeçler de (`?kind=&member=`): yenileyince ve geri gelince korunur.
 * Fiyat izni olmayana para alanları gelmez: tutar metinleri gizlenir, oran (yüzde) kalır.
 */

/** Gerçek uçta da en çok 12 ay geri seçilebilir (contracts `HubAiUsage.months`). */
const MAX_BACK = 12;

const isAbsent = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);
const isInvalid = (e: unknown) => e instanceof ApiError && e.status === 400;

export function AiUsagePage() {
  const { product } = useParams();
  const key = (PRODUCT_KEYS as readonly string[]).includes(product ?? '') ? (product as ProductKey) : null;
  if (!key) return <Absent />;
  return <AiUsageView key={key} product={key} />;
}

/** Bu araçta döküm yok ya da görme izni yok: kısa durum, Abonelik'e dönüş. */
function Absent({ product }: { product?: ProductKey }) {
  const { t } = useTranslation();
  return (
    <div className="hub-page d9">
      <PageHeader title={t('aiUsage.title')} sub={product ? PRODUCTS[product].name : undefined} crumbs={<Crumb />} />
      <div className="d9-wrap">
        <section className="d9-panel d9-lift">
          <Empty
            icon="info"
            title={t('aiUsage.page.absentTitle')}
            actions={
              <Link className="btn btn-secondary" to="/account/billing">
                {t('aiUsage.page.absentBack')}
              </Link>
            }
          >
            {t('aiUsage.page.absentBody')}
          </Empty>
        </section>
      </div>
    </div>
  );
}

function Crumb() {
  const { t } = useTranslation();
  return (
    <>
      <Link to="/account/billing">{t('aiUsage.page.crumb')}</Link>
      <span className="sep" aria-hidden="true">
        ›
      </span>
    </>
  );
}

/** Sunucu ay listesi vermezse (eski sunucu): bu aydan `firstPeriod`a (yoksa 12 ay geriye) kadar, kullanım bilgisi olmadan. */
function fallbackMonths(current: string, first: string | undefined): MonthOption[] {
  const out: MonthOption[] = [];
  const oldest = first && PERIOD_RE.test(first) && first <= current ? first : addMonths(current, -MAX_BACK);
  for (let p = current; p >= oldest && out.length <= MAX_BACK; p = addMonths(p, -1)) out.push({ period: p });
  return out;
}

function AiUsageView({ product }: { product: ProductKey }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const scope = useScope();
  const { me } = useMe();
  const tz = shellTimeZone();
  const today = isoDay(new Date(), tz);
  const clientCurrent = today.slice(0, 7);

  const [params, setParams] = useSearchParams();
  const rawPeriod = params.get('period');
  // Biçimi bozuk ya da pencere dışında (gelecek, 12 aydan eski) ay: bu ay sayılır, adresten silinir.
  const period = rawPeriod && PERIOD_RE.test(rawPeriod) && rawPeriod <= clientCurrent && rawPeriod >= addMonths(clientCurrent, -MAX_BACK) ? rawPeriod : null;
  const kind = params.get('kind') ?? '';
  const member = params.get('member') ?? '';
  // Adres değişikliği tarayıcının güncel adresinden kurulur: yönlendirici çizimi geçiş içinde erteler, art arda iki
  // değişiklikte (tür sonra kişi) kancanın değeri bir önceki hâlde kalabilir.
  const update = (mutate: (next: URLSearchParams) => void, replace: boolean) => {
    const next = new URLSearchParams(window.location.search);
    mutate(next);
    setParams(next, { replace });
  };
  const dropParams = (keys: string[]) => update((next) => keys.forEach((k) => next.delete(k)), true);
  const setFilter = (k: 'kind' | 'member', v: string) =>
    update((next) => {
      if (v) next.set(k, v);
      else next.delete(k);
    }, true);
  // Ay değişince süzgeçler düşer (o ayda olmayan tür ya da kişi kalmasın); geçmişe kayıt eklenir, geri tuşu önceki aya döner.
  const setPeriod = (p: string) =>
    update((next) => {
      next.set('period', p);
      next.delete('kind');
      next.delete('member');
    }, false);

  useEffect(() => {
    if (rawPeriod !== null && period === null) dropParams(['period']);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız adresteki değer izlenir.
  }, [rawPeriod, period]);

  const summary = useQuery({
    queryKey: [...scope, 'ai-usage', product, period ?? 'current'],
    queryFn: () => fetchAiUsage(product, period ?? undefined),
    // Yetki yok, uç yok ya da ay geçersiz: yeniden denemenin anlamı yok.
    retry: (n, err) => !isAbsent(err) && !isInvalid(err) && n < 2,
  });
  const u = summary.data;

  // Sunucu ayı reddetti (pencere dışı) ya da listesinde yok: bu aya dön.
  useEffect(() => {
    if (!period) return;
    if ((summary.isError && isInvalid(summary.error)) || (u?.months && !u.months.some((m) => m.period === period))) dropParams(['period']);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız yanıt değişince.
  }, [period, summary.isError, summary.error, u]);

  const months = useMemo<MonthOption[]>(
    () => (u?.months?.length ? u.months : fallbackMonths(u && !period ? u.period : clientCurrent, u?.firstPeriod)),
    [u, period, clientCurrent],
  );
  const current = months[0]?.period ?? clientCurrent;
  const filter: AiCallsFilter = { period: period ?? undefined, kind: kind || undefined, member: member || undefined };
  const calls = useInfiniteQuery<HubAiCallPage>({
    queryKey: [...scope, 'ai-usage-calls', product, period ?? 'current', kind, member],
    enabled: !!u && u.calls > 0,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchAiCalls(product, filter, pageParam as number),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    retry: (n, err) => !isInvalid(err) && n < 1,
  });
  // Sunucu süzgeci reddetti (bilinmeyen tür ya da kişi): süzgeç düşer.
  useEffect(() => {
    if (calls.isError && isInvalid(calls.error) && (kind || member)) dropParams(['kind', 'member']);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız hata değişince.
  }, [calls.isError, calls.error, kind, member]);

  const [exporting, setExporting] = useState(false);
  const exportable = canExport(meProduct(me, product));
  const doExport = async () => {
    setExporting(true);
    try {
      await exportAiCalls(product, { ...filter, period: u?.period ?? filter.period });
      toast.ok(t('aiUsage.page.exported'));
    } catch (e) {
      toast.err(t('aiUsage.page.exportFailed'), apiMessage(e, t('common.unexpected')));
    } finally {
      setExporting(false);
    }
  };

  if (summary.isError && isAbsent(summary.error)) return <Absent product={product} />;

  const name = PRODUCTS[product].name;
  let sub: ReactNode = name;
  if (u) {
    const from = isoDay(new Date(u.periodStart), tz);
    const to = u.period === current && u.period === clientCurrent ? today : isoDay(new Date(Date.parse(u.resetsAt) - 1), tz);
    sub = t('aiUsage.page.sub', { product: name, month: monthLabel(u.period, lng), range: dayRangeLabel(from, to, lng) });
  }
  const actions = u ? (
    <>
      <MonthPicker value={u.period} months={months} onChange={setPeriod} />
      {exportable && (
        <Button
          kind="secondary"
          icon="download"
          className="aiu-dl"
          aria-label={t('aiUsage.page.export')}
          loading={exporting}
          disabled={u.calls === 0}
          onClick={() => void doExport()}
        >
          <span className="aiu-dl-text">{t('aiUsage.page.export')}</span>
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <div className="hub-page d9">
      <PageHeader title={t('aiUsage.title')} sub={sub} crumbs={<Crumb />} actions={actions} />
      <div className="d9-wrap">
        <div className="aiu d9-lift">
          {summary.isPending && <SummarySkeleton />}
          {summary.isError && !isInvalid(summary.error) && <ErrorState error={summary.error} onRetry={() => summary.refetch()} />}
          {u && (
            <>
              <Kpis u={u} />
              {u.calls === 0 ? (
                <section className="aiu-card">
                  <Empty icon="spark" title={t('aiUsage.page.emptyTitle')}>
                    {t('aiUsage.page.emptyBody')}
                  </Empty>
                </section>
              ) : (
                <>
                  <div className="aiu-cols">
                    <Breakdown
                      title={t('aiUsage.page.byKind')}
                      u={u}
                      rows={u.byKind.map((k) => ({ key: k.kind, label: k.label, calls: k.calls, tokens: k.tokens, amount: k.amount }))}
                    />
                    {(u.byMember?.length ?? 0) > 0 && (
                      <Breakdown
                        title={t('aiUsage.page.byMember')}
                        u={u}
                        rows={u.byMember!.map((m) => ({
                          key: m.memberId ?? HUB_AI_MEMBER_NONE,
                          label: m.name,
                          calls: m.calls,
                          tokens: m.tokens,
                          amount: m.amount,
                        }))}
                      />
                    )}
                  </div>
                  <Calls u={u} q={calls} kind={kind} member={member} onFilter={setFilter} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div aria-busy="true" className="aiu">
      <div className="aiu-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="aiu-kpi">
            <Skel h={14} w={120} />
            <Skel h={32} w={140} />
            <Skel h={12} />
          </div>
        ))}
      </div>
      <div className="aiu-card">
        <Skel h={160} />
      </div>
    </div>
  );
}

const hasMoney = (u: HubAiUsage) => typeof u.usedAmount === 'number' && typeof u.allowanceAmount === 'number';

function Kpis({ u }: { u: HubAiUsage }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const money = (v: number) => formatMoney(v, u.currency, lng);
  const compact = (n: number) => formatNumber(n, lng, { notation: 'compact', maximumFractionDigits: 2 });
  const compact1 = (n: number) => formatNumber(n, lng, { notation: 'compact', maximumFractionDigits: 1 });
  const unit = { hour: t('aiUsage.unit.hour'), minute: t('aiUsage.unit.minute'), second: t('aiUsage.unit.second') };
  const showMoney = hasMoney(u);
  const pct = Math.min(100, Math.max(0, u.usedPct));
  const meter = u.exhausted ? ' is-full' : pct >= 80 ? ' is-warn' : '';
  const prevAmount = u.previous && typeof u.previous.usedAmount === 'number' ? u.previous.usedAmount : null;
  const counts = u.statusCounts
    ? (['ok', 'refused', 'truncated', 'failed'] as const)
        .filter((s) => (u.statusCounts?.[s] ?? 0) > 0)
        .map((s) => t(`aiUsage.page.statusCount.${s}`, { n: formatNumber(u.statusCounts![s], lng) }))
        .join(' · ')
    : '';
  return (
    <div className="aiu-kpis">
      {showMoney ? (
        <div className="aiu-kpi" data-kpi="cost">
          <span className="aiu-kpi-l">{t('aiUsage.page.kpi.cost')}</span>
          <span className="aiu-kpi-v">{money(u.usedAmount)}</span>
          <span className="aiu-kpi-s">
            {[t('aiUsage.page.kpi.costSub'), prevAmount !== null ? t('aiUsage.page.kpi.costPrev', { amount: money(prevAmount) }) : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ) : (
        <div className="aiu-kpi" data-kpi="duration">
          <span className="aiu-kpi-l">{t('aiUsage.page.kpi.duration')}</span>
          <span className="aiu-kpi-v">{formatDuration(u.durationMs, unit)}</span>
          <span className="aiu-kpi-s">{u.cachedCalls > 0 ? t('aiUsage.cached', { count: formatNumber(u.cachedCalls, lng) }) : ''}</span>
        </div>
      )}
      <div className="aiu-kpi" data-kpi="tokens">
        <span className="aiu-kpi-l">{t('aiUsage.page.kpi.tokens')}</span>
        <span className="aiu-kpi-v">{compact(u.tokens.total)}</span>
        <span className="aiu-kpi-s">{t('aiUsage.page.kpi.tokensSub', { input: compact1(u.tokens.input), output: compact1(u.tokens.output) })}</span>
      </div>
      <div className="aiu-kpi" data-kpi="calls">
        <span className="aiu-kpi-l">{t('aiUsage.page.kpi.calls')}</span>
        <span className="aiu-kpi-v">{formatNumber(u.calls, lng)}</span>
        <span className="aiu-kpi-s">{counts}</span>
      </div>
      <div className="aiu-kpi" data-kpi="allowance">
        <span className="aiu-kpi-l">
          {t('aiUsage.page.kpi.allowance')}
          {u.exhausted && (
            <>
              {' '}
              <Tag tone="red" small>
                {t('aiUsage.exhausted')}
              </Tag>
            </>
          )}
          {!u.enforced && (
            <>
              {' '}
              <Tag tone="gray" small>
                {t('aiUsage.notEnforced')}
              </Tag>
            </>
          )}
        </span>
        <span className="aiu-kpi-v">{formatPercent(u.usedPct, lng, 0)}</span>
        {showMoney && (
          <span className="aiu-kpi-s">{t('aiUsage.page.kpi.allowanceSub', { used: money(u.usedAmount), allowance: money(u.allowanceAmount) })}</span>
        )}
        <span
          className={`aiu-meter${meter}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('aiUsage.page.kpi.allowance')}
        >
          <i style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
}

type BarRow = { key: string; label: string; calls: number; tokens: number; amount?: number };

/** Dağılım: çubuk boyu tutardan (fiyat izni yoksa tokenden); yanında işlem sayısı ve tutar (ya da token). */
function Breakdown({ title, u, rows }: { title: string; u: HubAiUsage; rows: BarRow[] }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const showMoney = hasMoney(u);
  const size = (r: BarRow) => (showMoney ? (r.amount ?? 0) : r.tokens);
  const max = Math.max(0, ...rows.map(size)) || 1;
  return (
    <section className="aiu-card" aria-label={title}>
      <h2>{title}</h2>
      <ul className="hub-bars">
        {rows.map((r) => (
          <li key={r.key} className="hub-bars-row">
            <span className="hub-bars-label">{r.label}</span>
            <span className="hub-bars-value">
              {t('aiUsage.page.count', { count: r.calls, n: formatNumber(r.calls, lng) })}
              <b className="aiu-bar-amount">
                {showMoney
                  ? formatMoney(r.amount ?? 0, u.currency, lng)
                  : t('aiUsage.tokens', { count: formatNumber(r.tokens, lng, { notation: 'compact', maximumFractionDigits: 1 }) })}
              </b>
            </span>
            <span className="hub-bars-track" aria-hidden="true">
              <i style={{ width: `${Math.max(1, (size(r) / max) * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type CallsQuery = UseInfiniteQueryResult<InfiniteData<HubAiCallPage>>;

function Calls({
  u,
  q,
  kind,
  member,
  onFilter,
}: {
  u: HubAiUsage;
  q: CallsQuery;
  kind: string;
  member: string;
  onFilter: (k: 'kind' | 'member', v: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const showMoney = hasMoney(u);
  const unit = { hour: t('aiUsage.unit.hour'), minute: t('aiUsage.unit.minute'), second: t('aiUsage.unit.second') };
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const total = q.data?.pages[0]?.total;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: HubAiCall | undefined = items.find((c) => c.id === selectedId);
  const cols = showMoney ? 9 : 8;
  return (
    <section className="aiu-card aiu-calls" aria-labelledby="aiu-calls-h">
      <div className="aiu-tbar">
        <h2 id="aiu-calls-h">{t('aiUsage.page.tableTitle')}</h2>
        <div className="aiu-filters">
          <Field label={t('aiUsage.page.filterKind')} htmlFor="aiu-kind">
            <select id="aiu-kind" className="sel sm" value={kind} onChange={(e) => onFilter('kind', e.target.value)}>
              <option value="">{t('aiUsage.page.all')}</option>
              {u.byKind.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          {(u.byMember?.length ?? 0) > 0 && (
            <Field label={t('aiUsage.page.filterPerson')} htmlFor="aiu-member">
              <select id="aiu-member" className="sel sm" value={member} onChange={(e) => onFilter('member', e.target.value)}>
                <option value="">{t('aiUsage.page.all')}</option>
                {u.byMember!.map((m) => (
                  <option key={m.memberId ?? HUB_AI_MEMBER_NONE} value={m.memberId ?? HUB_AI_MEMBER_NONE}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {total !== undefined && <span className="aiu-total">{t('aiUsage.page.count', { count: total, n: formatNumber(total, lng) })}</span>}
      </div>
      {q.isPending && <TableSkeleton cols={cols} rows={6} />}
      {q.isError && !q.data && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && (
        <Empty compact icon="search" title={t('aiUsage.page.noMatchTitle')}>
          {t('aiUsage.page.noMatchBody')}
        </Empty>
      )}
      {items.length > 0 && (
        <div className="tbl-wrap bare">
          <table className="dt compact tight aiu-table">
            <thead>
              <tr>
                <th scope="col">{t('aiUsage.page.col.time')}</th>
                <th scope="col">{t('aiUsage.page.col.person')}</th>
                <th scope="col">{t('aiUsage.page.col.kind')}</th>
                <th scope="col">{t('aiUsage.page.col.record')}</th>
                <th scope="col" className="r">
                  {t('aiUsage.page.col.input')}
                </th>
                <th scope="col" className="r">
                  {t('aiUsage.page.col.output')}
                </th>
                <th scope="col" className="r">
                  {t('aiUsage.page.col.duration')}
                </th>
                {showMoney && (
                  <th scope="col" className="r">
                    {t('aiUsage.page.col.cost')}
                  </th>
                )}
                <th scope="col">{t('aiUsage.page.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} data-call={c.id} {...rowProps(() => setSelectedId(c.id), c.id === selectedId)}>
                  <td>{formatDate(c.at, lng, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="aiu-person">{c.person}</td>
                  <td>{c.label}</td>
                  <td className="aiu-record">
                    <RecordLink call={c} />
                  </td>
                  <td className="r num">{formatNumber(c.tokens.input, lng)}</td>
                  <td className="r num">{formatNumber(c.tokens.output, lng)}</td>
                  <td className="r num">{formatDuration(c.durationMs, unit)}</td>
                  {showMoney && (
                    <td className="r num">
                      <b>{typeof c.amount === 'number' ? formatMoney(c.amount, u.currency, lng) : ''}</b>
                      {!c.deducted && <small className="aiu-cell-note">{t('aiUsage.page.notDeducted')}</small>}
                    </td>
                  )}
                  <td>
                    <StatusTag call={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.isError && q.data && <ErrorState error={q.error} onRetry={() => q.fetchNextPage()} />}
      {q.hasNextPage && (
        <div className="aiu-more">
          <Button kind="secondary" small loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('aiUsage.page.more')}
          </Button>
        </div>
      )}
      {u.cachedCalls > 0 && <p className="aiu-hint">{t('aiUsage.page.cachedNote', { count: u.cachedCalls, n: formatNumber(u.cachedCalls, lng) })}</p>}
      {selected && <CallDrawer call={selected} currency={u.currency} onClose={() => setSelectedId(null)} />}
    </section>
  );
}
