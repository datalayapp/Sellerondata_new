import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PRODUCTS, PRODUCT_KEYS, isProductKey, type ProductKey } from '@sellerondata/contracts';
import { useQueries } from '@tanstack/react-query';
import { ActionMenu, ApiError, Empty, ErrorState, PageHeader, ProductMark, Skel, formatDateRange, formatHubValue, isProductOpen, useMe } from '@sellerondata/shell';
import { ToolPicker } from '../components/ToolPicker.tsx';
import { SmartLink } from '../components/values.tsx';
import { fetchAnalytics, fetchOverview } from '../api/hub.ts';
import { FilterControls, PeriodControl, useFilterPanel, readFilters, writeFilters } from '../components/Controls.tsx';
import { Section, sectionExports } from '../components/Widgets.tsx';
import { downloadCsv } from '../lib/csv.ts';
import { NotFound } from './NotFound.tsx';
import { analyticsProducts, canExport, isSetupOpen, meProduct } from '../lib/access.ts';
import { usePeriod } from '../lib/period.ts';
import { useScope } from '../lib/hooks.ts';

/** Araç sekmeleri. Açık olmayan araç görünür ama tıklanmaz, odak almaz. */
export function ToolTabs({ base, allowed, current }: { base: string; allowed: ProductKey[]; current: ProductKey }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const qs = params.toString();
  // Tek araçta sekme gerekmez; "Yakında" araçları ray zaten söyler.
  if (allowed.length < 2) return null;
  return (
    <nav className="ptabs hub-tool-tabs" aria-label={t('analytics.toolTabs')}>
      {PRODUCT_KEYS.map((key) => {
        const def = PRODUCTS[key];
        // `allowed` yalnız bu firmada açık araçları taşır (`analyticsProducts`).
        if (!allowed.includes(key)) return null;
        return (
          <Link key={key} to={`${base}/${key}${qs ? `?${qs}` : ''}`} className={`hub-tool-tab${key === current ? ' on' : ''}`} aria-current={key === current ? 'page' : undefined}>
            <ProductMark product={key} size={18} />
            {def.name}
          </Link>
        );
      })}
    </nav>
  );
}

export function Analytics() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const { me } = useMe();
  const scope = useScope();
  const { product } = useParams();
  const [params, setParams] = useSearchParams();
  const { range, from, to, setRange } = usePeriod();
  const allowed = analyticsProducts(me).map((p) => p.key);
  const current = product as ProductKey | undefined;
  // Tümü = adreste araç yok (/analytics). Tek açık araç varsa Tümü onun analizidir.
  const effective = current ?? (allowed.length === 1 ? allowed[0] : undefined);
  const compare = params.get('compare') !== '0';
  const [compareBox, setCompareBox] = useState(compare);
  useEffect(() => setCompareBox(compare), [compare]);
  const filters = readFilters(params);
  const filterKey = JSON.stringify(filters);

  const q = useQuery({
    queryKey: [...scope, 'analytics', effective, from, to, compare, filterKey],
    queryFn: () => fetchAnalytics(effective!, from, to, compare, filters),
    enabled: !!effective && allowed.includes(effective),
    placeholderData: keepPreviousData,
  });

  // Kurulum bitmediyse boş grafik değil, yol gösterilir. Veri aynı önbellekten: Genel Bakış da bunu okur.
  const overview = useQuery({
    queryKey: [...scope, 'overview', effective, from, to],
    queryFn: () => fetchOverview(effective!, from, to),
    enabled: !!effective && allowed.includes(effective),
  });
  const setup = isSetupOpen(overview.data) ? overview.data!.setup! : null;
  const activeCount = Object.keys(filters).length;
  const filterPanel = useFilterPanel(activeCount, t('filter.panelTitle'));

  // Olmayan ya da henüz açık olmayan araç: yetki değil, sayfa yok.
  if (current && !(isProductKey(current) && isProductOpen(me, current))) return <NotFound />;
  const picker = (
    <ToolPicker
      allowed={allowed}
      current={current ?? null}
      hrefFor={(key) => {
        // Bölüm ve süzgeç araca özgü: araç değişince düşer; dönem ve karşılaştırma kalır.
        const next = new URLSearchParams(params);
        next.delete('section');
        const qs = next.toString();
        return `/analytics${key ? `/${key}` : ''}${qs ? `?${qs}` : ''}`;
      }}
    />
  );
  if (!effective && allowed.length > 1) {
    return (
      <>
        <PageHeader title={t('nav.analytics')} sub={<span className="hub-range">{formatDateRange(from, to, lng)}</span>} actions={<PeriodControl range={range} from={from} to={to} onChange={setRange} />} tabs={picker} />
        <div className="hub-page hub-wrap is-short">
          <AllToolsSummary tools={allowed} from={from} to={to} />
        </div>
      </>
    );
  }
  // 403 (yetki sonradan alındı ya da araç bu kişiye kapalı): Genel Bakış'a atmak yerine kilit ekranı (`RequireAccess` ile aynı).
  if (!effective || !allowed.includes(effective) || (q.error instanceof ApiError && q.error.status === 403)) {
    return (
      <>
        <PageHeader title={t('nav.analytics')} />
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
  const tabs = picker;
  const exportable = canExport(meProduct(me, effective));
  const data = q.data;
  const sectionParam = params.get('section') ?? (window.location.hash.startsWith('#section-') ? window.location.hash.slice(9) : null);
  const activeSection = data?.sections.find((x) => x.id === sectionParam) ?? data?.sections[0];
  const period = formatDateRange(from, to, lng);
  const csvItems = exportable && activeSection ? sectionExports(activeSection, `${effective}-${from}-${to}`, t) : [];
  const sectionHref = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('section', id);
    return `?${next}`;
  };

  if (setup) {
    const steps = setup.steps ?? [];
    const next = steps.find((x) => !x.done);
    return (
      <>
        <PageHeader title={t('nav.analytics')} tabs={tabs} />
        <div className="hub-page hub-wrap hub-narrow is-short">
          <section className="hub-panel">
            <Empty
              icon="flag"
              title={t('analytics.setupTitle', { name: PRODUCTS[effective].name })}
              actions={
                <>
                  <SmartLink href={next?.href ?? setup.href} className="btn btn-primary">
                    {next ? next.label : t('home.setup.action')}
                  </SmartLink>
                  <Link to="/home" className="btn btn-secondary">
                    {t('analytics.setupList')}
                  </Link>
                </>
              }
            >
              {steps.length ? t('analytics.setupBody') : setup.label}
            </Empty>
          </section>
        </div>
      </>
    );
  }

  const filterFields = (
    <>
      <label className="check hub-compare">
        <input
          type="checkbox"
          checked={compareBox}
          onChange={(e) => {
            const on = e.target.checked;
            setCompareBox(on);
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                if (on) next.delete('compare');
                else next.set('compare', '0');
                return next;
              },
              { replace: true },
            );
          }}
        />
        {t('analytics.compare')}
      </label>
      <div className="hub-filter-fields">
        <FilterControls defs={data?.filters ?? []} defaults={me?.activeOrg ? { currency: me.activeOrg.currency } : undefined} value={filters} onChange={(f) => setParams((prev) => writeFilters(prev, f), { replace: true })} />
      </div>
    </>
  );

  return (
    <>
      <PageHeader
        title={t('nav.analytics')}
        sub={
          <span className="hub-range">
            {period}
            {compare && data?.compare && <> · {t('analytics.versus', { range: formatDateRange(data.compare.from, data.compare.to, lng) })}</>}
          </span>
        }
        actions={
          <>
            <PeriodControl range={range} from={from} to={to} onChange={setRange} />
            {csvItems.length > 0 && <ActionMenu label={t('analytics.export')} items={csvItems.map((x) => ({ label: t('analytics.exportItem', { name: x.name }), icon: 'download', onSelect: () => downloadCsv(x.file, x.rows, lng) }))} />}
          </>
        }
        tabs={tabs}
      />

      <div className="hub-page hub-wrap is-short hub-sections">
        {/* Yapışkan çubuk: bölüm sekmeleri ve filtre. Bölümler gerçek sekme: sayfada tek bölüm durur. Dönem bantta yazılı. */}
        <div className="hub-analytics-bar">
          {data && data.sections.length > 1 ? (
            <nav className="hub-section-tabs" aria-label={t('analytics.sections')}>
              {data.sections.map((x) => (
                <Link key={x.id} to={sectionHref(x.id)} replace preventScrollReset className={x.id === activeSection?.id ? 'on' : undefined} aria-current={x.id === activeSection?.id ? 'page' : undefined}>
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
        {q.isPending && (
          <div className="hub-skel-stack" aria-busy="true">
            <Skel h={96} />
            <Skel h={280} />
            <Skel h={220} />
          </div>
        )}
        {q.isError && !(q.error instanceof ApiError && q.error.status === 403) && (
          <ErrorState error={q.error} onRetry={() => q.refetch()} title={t('analytics.error', { name: PRODUCTS[effective].name })} />
        )}
        {data && data.sections.length === 0 && (
          <Empty icon="chart" title={t('home.noData.title')}>
            {t('home.noData.body')}
          </Empty>
        )}
        {activeSection && <Section key={activeSection.id} section={activeSection} busy={q.isPlaceholderData} tabbed={data!.sections.length > 1} />}
      </div>
    </>
  );
}

/** Tümü ve birden çok açık araç: her aracın baş rakamları, analize bağlantıyla. */
function AllToolsSummary({ tools, from, to }: { tools: ProductKey[]; from: string; to: string }) {
  const { t, i18n } = useTranslation();
  const scope = useScope();
  const results = useQueries({ queries: tools.map((key) => ({ queryKey: [...scope, 'overview', key, from, to], queryFn: () => fetchOverview(key, from, to) })) });
  return (
    <>
      {tools.map((key, i) => {
        const r = results[i]!;
        return (
          <section key={key} className="hub-panel" aria-label={PRODUCTS[key].name}>
            <div className="hub-lift-h">
              <h2>
                <ProductMark product={key} size={20} />
                <span>{PRODUCTS[key].name}</span>
              </h2>
              <Link to={`/analytics/${key}`} className="hub-arrow-link">
                {t('home.toAnalytics')}
              </Link>
            </div>
            {r.isPending ? <Skel h={48} /> : r.isError ? <ErrorState error={r.error} onRetry={() => r.refetch()} title={t('analytics.error', { name: PRODUCTS[key].name })} /> : (
              <ul className="hub-summary-kpis">
                {r.data!.kpis.filter((k) => !k.id.includes(':')).slice(0, 3).map((k) => (
                  <li key={k.id}>
                    <span>{k.label}</span>
                    <b>{formatHubValue(k, i18n.language)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
