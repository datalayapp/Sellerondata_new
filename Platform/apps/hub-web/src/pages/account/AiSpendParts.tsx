import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  AI_SPEND_MEMBER_NONE,
  AI_SPEND_SECTIONS,
  AI_SPEND_WIDGETS,
  PRODUCTS,
  type AiOrgAllowanceView,
  type AiSpendCallsPage,
  type AiSpendScope,
  type AiSpendSummary,
  type HubFilterDef,
  type HubKpi,
  type HubRow,
  type HubSection,
} from '@sellerondata/contracts';
import {
  ActionMenu,
  ApiError,
  Button,
  Empty,
  ErrorState,
  Field,
  Notice,
  Pager,
  PageHeader,
  Skel,
  SlideOver,
  formatDate,
  formatDateRange,
  formatHubValue,
  toast,
} from '@sellerondata/shell';
import { exportAiSpendCalls, fetchAiAllowance, fetchAiSpendCalls, fetchAiSpendSummary, type AiSpendParams } from '../../api/ai.ts';
import type { Filters } from '../../api/hub.ts';
import { asList, type OrgMember } from '../../api/types.ts';
import { FilterControls, PeriodControl, readFilters, useFilterPanel, writeFilters } from '../../components/Controls.tsx';
import { DataTable } from '../../components/DataTable.tsx';
import { KpiStrip, Section } from '../../components/Widgets.tsx';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { rangeDates, usePeriod } from '../../lib/period.ts';
import { client } from '../../lib/session.ts';

/*
 * Yapay zekâ harcaması görünümü (firma: Abonelik › Yapay zekâ harcaması; platform: Platform › Yapay zekâ › Harcama). Mevcut
 * bileşenlerle çizilir: bölümler Analiz'in `Section`'ı (`HubAnalytics`), çağrılar Veriler'in `DataTable`'ı (`HubDatasetPage`).
 * Dönem, bölüm, süzgeç, sayfa ve açık çağrı adreste durur (`range`/`from`/`to`, `section`, `filter.<id>`, `page`, `call`).
 * Kişi adı geçitte yok: firma görünümünde ekip listesinden çözülür (`member` kimliği = Membership.id).
 */

const KNOWN_FILTERS = ['product', 'purpose', 'model', 'status', 'member', 'org'];

/** Dönem: adreste yoksa bu ay (uçların varsayılanı), değilse Analiz'in hazır ve özel aralıkları. */
function useSpendPeriod() {
  const p = usePeriod();
  const [params] = useSearchParams();
  if (params.get('range')) return p;
  return { ...p, range: 'mtd' as const, ...rangeDates('mtd') };
}

/** Kişi kimliği → ad (firma görünümü). Ekip listesi gelmediyse ya da kişi ayrıldıysa ad yerine kısa metin. */
function useMemberNames(enabled: boolean) {
  const scope = useScope();
  const members = useQuery({ queryKey: [...scope, 'members'], enabled, queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  return useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
}

/** Kişi kırılımı ve kişi süzgecinin boş etiketleri ekip adlarıyla doldurulur; başka hiçbir şey değişmez. */
function withMemberNames(data: AiSpendSummary, name: (id: string) => string): AiSpendSummary {
  const sections = data.sections.map((s): HubSection =>
    s.id !== AI_SPEND_SECTIONS.members
      ? s
      : {
          ...s,
          widgets: s.widgets.map((w) =>
            w.kind === 'breakdown' && w.id === AI_SPEND_WIDGETS.byMember ? { ...w, items: w.items.map((i) => ({ ...i, label: i.label || name(i.key) })) } : w,
          ),
        },
  );
  const filters = data.filters.map((f): HubFilterDef =>
    f.kind === 'select' && f.id === 'member' ? { ...f, options: f.options.map((o) => ({ ...o, label: o.label || name(o.value) })) } : f,
  );
  return { ...data, sections, filters };
}

export function SpendView({ scope, title, crumbs, tabs }: { scope: AiSpendScope; title: string; crumbs?: ReactNode; tabs?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const keyScope = useScope();
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const { range, from, to, setRange } = useSpendPeriod();
  const filters = Object.fromEntries(Object.entries(readFilters(params)).filter(([k]) => KNOWN_FILTERS.includes(k))) as Filters;
  const currency = scope === 'platform' && params.get('currency') === 'USD' ? 'USD' : 'TRY';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const q: AiSpendParams = { scope, from, to, filters, ...(scope === 'platform' ? { currency } : {}) };
  const qKey = [...keyScope, 'ai-spend', scope, from, to, currency, JSON.stringify(filters)];

  const summary = useQuery({
    queryKey: [...qKey, 'summary'],
    queryFn: () => fetchAiSpendSummary(q),
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
  const calls = useQuery({
    queryKey: [...qKey, 'calls', page],
    queryFn: () => fetchAiSpendCalls(q, page),
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
  const allowance = useQuery({
    queryKey: [...keyScope, 'ai-allowance'],
    enabled: scope === 'org',
    queryFn: fetchAiAllowance,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
  const names = useMemberNames(scope === 'org');
  const memberName = useCallback(
    (id: string | null | undefined) => (!id || id === AI_SPEND_MEMBER_NONE ? t('aiSpend.memberNone') : (names.get(id) ?? t('aiSpend.memberUnknown'))),
    [names, t],
  );
  const data = useMemo(() => (summary.data && scope === 'org' ? withMemberNames(summary.data, memberName) : summary.data), [summary.data, scope, memberName]);
  const activeCount = Object.keys(filters).length + (currency === 'USD' ? 1 : 0);
  const filterPanel = useFilterPanel(activeCount, t('filter.panelTitle'));
  const [exporting, setExporting] = useState(false);

  const setUrl = (mutate: (next: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      },
      { replace },
    );
  const sectionParam = params.get('section');
  const activeSection = data?.sections.find((x) => x.id === sectionParam) ?? data?.sections[0];
  const sectionHref = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('section', id);
    return `?${next}`;
  };

  const forbidden = summary.error instanceof ApiError && summary.error.status === 403;
  const callsKpi = data?.sections[0]?.widgets.find((w) => w.kind === 'kpis');
  const callCount = callsKpi?.kind === 'kpis' ? callsKpi.items.find((k) => k.id === 'calls')?.value : undefined;
  const filtered = Object.keys(filters).length > 0;
  const empty = typeof callCount === 'number' && callCount === 0;

  const doExport = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      await exportAiSpendCalls(q, format);
      toast.ok(t('aiSpend.exported'));
    } catch (e) {
      const tooLarge = e instanceof ApiError && e.code === 'VALIDATION' && (e.details as { reason?: string } | undefined)?.reason === 'too_many_rows';
      toast.err(tooLarge ? t('aiSpend.exportTooLarge') : t('aiSpend.exportFailed'), apiMessage(e, t('common.unexpected')));
    } finally {
      setExporting(false);
    }
  };

  const filterFields = (
    <div className="hub-filter-fields">
      <FilterControls defs={data?.filters ?? []} value={filters} onChange={(f) => setUrl((next) => replaceAll(next, writeFilters(next, f)))} />
      {scope === 'platform' && (
        <Field label={t('aiSpend.currency')} htmlFor="ai-spend-currency">
          <select
            id="ai-spend-currency"
            className="sel sm w-md"
            value={currency}
            onChange={(e) =>
              setUrl((next) => {
                if (e.target.value === 'USD') next.set('currency', 'USD');
                else next.delete('currency');
                next.delete('page');
              })
            }
          >
            <option value="TRY">{t('aiSpend.currencyTry')}</option>
            <option value="USD">{t('aiSpend.currencyUsd')}</option>
          </select>
        </Field>
      )}
    </div>
  );

  if (forbidden) {
    return (
      <>
        <PageHeader title={title} crumbs={crumbs} tabs={tabs} />
        <div className="hub-page hub-wrap is-short">
          <section className="hub-panel">
            <Empty
              icon="lock"
              title={t('access.title')}
              actions={
                <Link className="btn btn-secondary" to="/home">
                  {t('access.back')}
                </Link>
              }
            >
              {t('access.body')}
            </Empty>
          </section>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={title}
        crumbs={crumbs}
        tabs={tabs}
        sub={
          <span className="hub-range">
            {formatDateRange(from, to, lng)}
            {data?.compare && <> · {t('analytics.versus', { range: formatDateRange(data.compare.from, data.compare.to, lng) })}</>}
          </span>
        }
        actions={
          <>
            <PeriodControl range={range} from={from} to={to} onChange={setRange} />
            <ActionMenu
              label={t('aiSpend.export')}
              busy={exporting}
              items={[
                { label: t('aiSpend.exportXlsx'), icon: 'download', disabled: empty || !data, onSelect: () => void doExport('xlsx') },
                { label: t('aiSpend.exportCsv'), icon: 'download', disabled: empty || !data, onSelect: () => void doExport('csv') },
              ]}
            />
          </>
        }
      />
      <div className="hub-page hub-wrap is-short hub-sections">
        {scope === 'org' && <AllowanceBand a={allowance.data} />}
        <div className="hub-analytics-bar">
          {data && data.sections.length > 1 && !empty ? (
            <nav className="hub-section-tabs" aria-label={t('analytics.sections')}>
              {data.sections.map((x) => (
                <Link
                  key={x.id}
                  to={sectionHref(x.id)}
                  replace
                  preventScrollReset
                  className={x.id === activeSection?.id ? 'on' : undefined}
                  aria-current={x.id === activeSection?.id ? 'page' : undefined}
                >
                  {x.title}
                </Link>
              ))}
            </nav>
          ) : (
            <span />
          )}
          <div className="hub-analytics-bar-end">{filterPanel.button}</div>
        </div>
        {filterPanel.render(filterFields)}
        {summary.isPending && (
          <div className="hub-skel-stack" aria-busy="true">
            <Skel h={96} />
            <Skel h={280} />
          </div>
        )}
        {summary.isError && !data && <ErrorState error={summary.error} onRetry={() => summary.refetch()} title={t('aiSpend.error')} />}
        {data && empty && (
          <section className="hub-panel">
            <Empty
              icon={filtered ? 'search' : 'spark'}
              title={filtered ? t('aiSpend.noMatchTitle') : t('aiSpend.emptyTitle')}
              actions={
                filtered ? (
                  <Button kind="secondary" small onClick={() => setUrl((next) => replaceAll(next, writeFilters(next, {})))}>
                    {t('filter.clearAll')}
                  </Button>
                ) : undefined
              }
            >
              {filtered ? t('aiSpend.noMatchBody') : t('aiSpend.emptyBody')}
            </Empty>
          </section>
        )}
        {data && !empty && (
          <>
            {scope === 'org' && activeSection?.id === AI_SPEND_SECTIONS.overview && allowance.data && <AllowanceSummary a={allowance.data} />}
            {activeSection && <Section key={activeSection.id} section={activeSection} busy={summary.isPlaceholderData} tabbed={data.sections.length > 1} />}
            <CallsPanel
              q={calls}
              page={page}
              memberName={scope === 'org' ? memberName : undefined}
              rowHref={(id) => {
                const next = new URLSearchParams(params);
                next.set('call', id);
                return `${loc.pathname}?${next}`;
              }}
              openId={params.get('call')}
              onClose={() => setUrl((next) => next.delete('call'))}
              onPage={(p) =>
                setUrl((next) => {
                  next.set('page', String(p));
                  next.delete('call');
                }, false)
              }
            />
          </>
        )}
      </div>
    </>
  );
}

/** `URLSearchParams`'ın içeriğini başkasıyla değiştirir (süzgeç yazımı yeni nesne döner, `setUrl` yerindekini bekler). */
function replaceAll(target: URLSearchParams, source: URLSearchParams) {
  for (const k of Array.from(target.keys())) target.delete(k);
  source.forEach((v, k) => target.append(k, v));
}

/** Platform durdu, hak doldu ya da sınıra yaklaştı: açık metin ve ne zaman yeniden açılacağı. */
function AllowanceBand({ a }: { a: AiOrgAllowanceView | undefined }) {
  const { t, i18n } = useTranslation();
  if (!a) return null;
  const date = formatDate(a.resetsAt, i18n.language, { day: 'numeric', month: 'long' });
  if (a.state === 'paused' || a.pausedBy === 'platform') return <Notice tone="err">{t('aiSpend.band.paused')}</Notice>;
  if (a.state === 'capped') return <Notice tone="warn">{t('aiSpend.band.capped', { date })}</Notice>;
  if (a.state === 'warn') return <Notice tone="info">{t('aiSpend.band.warn', { pct: a.usedPct })}</Notice>;
  return null;
}

/** Tek ortak aylık hak (bütün araçlar) ve araç kırılımı: Genel Bakış'ın KPI dizisiyle. */
function AllowanceSummary({ a }: { a: AiOrgAllowanceView }) {
  const { t, i18n } = useTranslation();
  const date = formatDate(a.resetsAt, i18n.language, { day: 'numeric', month: 'long' });
  const money = (id: string, label: string, value: number, extra: Partial<HubKpi> = {}): HubKpi => ({
    id,
    label,
    value,
    format: 'money',
    currency: a.currency,
    ...extra,
  });
  const items: HubKpi[] = [
    money('remaining', t('aiSpend.allowance.remaining'), a.remainingAmount, {
      hint: t('aiSpend.allowance.resets', { date }),
      tone: a.state === 'capped' || a.state === 'paused' ? 'bad' : undefined,
    }),
    money('used', t('aiSpend.allowance.used'), a.usedAmount),
    money('cap', t('aiSpend.allowance.cap'), a.capAmount),
    ...a.byProduct.filter((p) => p.usedAmount > 0).map((p) => money(`tool:${p.product}`, PRODUCTS[p.product].name, p.usedAmount)),
  ];
  return (
    <section className="hub-section" aria-labelledby="ai-allowance-h">
      <header className="hub-section-head">
        <h2 id="ai-allowance-h">{t('aiSpend.allowance.title')}</h2>
      </header>
      <div className="hub-grid">
        <div className="hub-cell full">
          <KpiStrip items={items} />
        </div>
      </div>
    </section>
  );
}

type CallsQuery = UseQueryResult<AiSpendCallsPage>;

/** Çağrı listesi: görünür sütunlar tabloda, gizli sütunlar (`hiddenByDefault`) satıra tıklayınca açılan ayrıntı panelinde. */
function CallsPanel({
  q,
  page,
  memberName,
  rowHref,
  openId,
  onClose,
  onPage,
}: {
  q: CallsQuery;
  page: number;
  memberName?: (id: string | null) => string;
  rowHref: (id: string) => string;
  openId: string | null;
  onClose: () => void;
  onPage: (p: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const data = q.data;
  const rows: HubRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        ...r,
        href: rowHref(r.id),
        cells: memberName && 'member' in r.cells ? { ...r.cells, member: memberName(r.cells.member as string | null) } : r.cells,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rowHref` adresten türer; satırlar veriyle ve adla yenilenir.
    [data, memberName],
  );
  const columns = (data?.columns ?? []).filter((c) => !c.hiddenByDefault);
  const open = openId ? rows.find((r) => r.id === openId) : undefined;
  return (
    <section className="hub-panel hub-dataset-panel" aria-labelledby="ai-calls-h">
      <div className="hub-lift-h">
        <h2 id="ai-calls-h">{t('aiSpend.calls.title')}</h2>
        {data && <span className="muted hub-total">{t('data.total', { count: data.total })}</span>}
      </div>
      {q.isPending && (
        <div className="hub-skel-stack pad" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skel key={i} h={20} />
          ))}
        </div>
      )}
      {q.isError && (
        <div className="hub-pad">
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </div>
      )}
      {data && rows.length === 0 && <Empty compact icon="search" title={t('aiSpend.noMatchTitle')} />}
      {data && rows.length > 0 && (
        <>
          <DataTable compact columns={columns} rows={rows} busy={q.isPlaceholderData} />
          <Pager page={data.page || page} pageSize={data.pageSize} total={data.total} onPage={onPage} />
        </>
      )}
      {open && data && (
        <SlideOver
          title={String(open.cells.purpose ?? '')}
          description={[formatHubValue({ value: open.cells.at ?? null, format: 'datetime' }, lng), open.cells.product].filter(Boolean).join(' · ')}
          onClose={onClose}
        >
          <dl className="aiu-kv">
            {data.columns
              .filter((c) => c.id !== 'purpose' && c.id !== 'at')
              .map((c) => (
                <div key={c.id}>
                  <dt>{c.label}</dt>
                  <dd>
                    {open.cells[c.id] === null || open.cells[c.id] === undefined || open.cells[c.id] === ''
                      ? '—'
                      : formatHubValue({ value: open.cells[c.id] ?? null, format: c.format, currency: c.currency }, lng)}
                  </dd>
                </div>
              ))}
          </dl>
        </SlideOver>
      )}
    </section>
  );
}
