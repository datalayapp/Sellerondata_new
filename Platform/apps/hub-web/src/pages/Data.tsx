import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PRODUCTS, isProductKey, type HubColumn, type ProductKey } from '@sellerondata/contracts';
import { ActionMenu, ApiError, Button, Empty, ErrorState, Field, Icon, PageHeader, Pager, Skel, isProductOpen, toast, useMe, type MenuItem } from '@sellerondata/shell';
import { exportDataset, fetchDataset, fetchDatasets } from '../api/hub.ts';
import { FilterControls, readFilters, useFilterPanel, writeFilters } from '../components/Controls.tsx';
import { DataTable, hasRowCurrency, isMoneyColumn } from '../components/DataTable.tsx';
import { ToolTabs } from './Analytics.tsx';
import { NotFound } from './NotFound.tsx';
import { canExport, dataProducts, meProduct } from '../lib/access.ts';
import { apiMessage, useDebounced, useIsPhone, useScope } from '../lib/hooks.ts';

const PAGE_SIZE = 25;

const CURRENCY_FILTER = 'currency';
const CURRENCY_CELL = 'currency';

/** Gizli sütunlar kişinin tarayıcısında kalır. Varsayılan: para birimi tutar hücresinde yazıyorsa ayrı sütun gizli. */
function useHiddenColumns(storeKey: string) {
  const [stored, setStored] = useState<string[] | null>(() => {
    try {
      const raw = localStorage.getItem(storeKey);
      return raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  });
  const save = (next: string[] | null) => {
    setStored(next);
    try {
      if (next) localStorage.setItem(storeKey, JSON.stringify(next));
      else localStorage.removeItem(storeKey);
    } catch {
      /* depo kapalı olabilir */
    }
  };
  return [stored, save] as const;
}

/** Sütun seçimi: ⋯ menüsündeki "Sütunlar…" açar (`open`); kendi düğmesi yoktur. Esc ve dışarı tıklama kapatır. */
function ColumnPicker({ columns, hidden, open, onClose, onChange, onReset, children }: { columns: HubColumn[]; hidden: string[]; open: boolean; onClose: () => void; onChange: (next: string[]) => void; onReset: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
    // `onClose` her çizimde yeni olabilir; açık/kapalı değişimi yeter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="hub-columns" ref={wrap}>
      {children}
      {open && (
        <div className="hub-columns-pop" role="group" aria-label={t('table.columns')} ref={pop}>
          {columns.map((c, i) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={!hidden.includes(c.id)} disabled={i === 0} onChange={(e) => onChange(e.target.checked ? hidden.filter((x) => x !== c.id) : [...hidden, c.id])} />
              {c.label}
            </label>
          ))}
          <button type="button" className="link-btn" onClick={onReset}>
            {t('table.columnsReset')}
          </button>
        </div>
      )}
    </div>
  );
}

export function DataPage() {
  const { t } = useTranslation();
  const { me } = useMe();
  const scope = useScope();
  const { product, dataset } = useParams();
  const allowed = dataProducts(me).map((p) => p.key);
  const current = product as ProductKey | undefined;
  const list = useQuery({
    queryKey: [...scope, 'datasets', current],
    queryFn: () => fetchDatasets(current!),
    enabled: !!current && allowed.includes(current),
  });

  // Olmayan ya da henüz açık olmayan araç: yetki değil, sayfa yok.
  if (current && !(isProductKey(current) && isProductOpen(me, current))) return <NotFound />;
  if (!current && allowed[0]) return <Navigate to={`/data/${allowed[0]}`} replace />;
  if (!current || !allowed.includes(current)) {
    return (
      <>
        <PageHeader title={t('nav.data')} />
        <div className="hub-page hub-wrap is-short">
          <section className="hub-panel">
            <Empty icon="lock" title={t('access.title')}>
              {t('access.body')}
            </Empty>
          </section>
        </div>
      </>
    );
  }
  const defs = list.data?.datasets ?? [];
  if (!dataset && defs[0]) return <Navigate to={`/data/${current}/${defs[0].id}`} replace />;
  const def = defs.find((d) => d.id === dataset);

  return (
    <>
      {/* Alt satır veri setinin açıklaması: genel "arayın, filtreleyin" cümlesi yerine (D09 `.ph-sub`). */}
      <PageHeader title={t('nav.data')} sub={def?.description} tabs={allowed.length > 1 ? <ToolTabs base="/data" allowed={allowed} current={current} /> : undefined} />
      <div className="hub-page hub-wrap is-short">
        {list.isPending && <Skel h={320} />}
        {list.isError &&
          (list.error instanceof ApiError && list.error.status === 403 ? (
            <section className="hub-panel">
              <Empty icon="lock" title={t('access.title')}>
                {t('access.body')}
              </Empty>
            </section>
          ) : (
            <ErrorState error={list.error} onRetry={() => list.refetch()} title={t('data.listError', { name: PRODUCTS[current].name })} />
          ))}
        {list.data && defs.length === 0 && (
          <section className="hub-panel">
            <Empty icon="table" title={t('data.noneTitle')}>
              {t('data.noneBody')}
            </Empty>
          </section>
        )}
        {defs.length > 0 && (
          <section className="hub-dataset" aria-label={def?.label ?? t('data.datasets')}>
            <DatasetTabs product={current} defs={defs} active={dataset} label={t('data.datasets')} />
            {def ? (
              <DatasetView key={def.id} product={current} id={def.id} label={def.label} filters={def.filters} exportable={def.exportable && canExport(meProduct(me, current))} />
            ) : (
              <div className="hub-panel">
                <Empty compact icon="table" title={t('data.notFound')} />
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}

/**
 * Telefonda sekme şeridi taşar: doğrudan adresle açılan set görünür alanın dışında kalmasın.
 * Yalnız şerit kaydırılır (scrollIntoView sayfayı da oynatabilir); ilk açılışta anında,
 * sekme değişiminde yumuşak, azaltılmış harekette anında. Veri yenilenince yeniden kaydırmaz.
 */
function DatasetTabs({ product, defs, active, label }: { product: ProductKey; defs: { id: string; label: string; description?: string }[]; active: string | undefined; label: string }) {
  const nav = useRef<HTMLElement>(null);
  // null: henüz kaydırılmadı. Aynı sekme için ikinci çalışma (StrictMode) yok sayılır.
  const scrolledFor = useRef<string | undefined | null>(null);
  useLayoutEffect(() => {
    if (scrolledFor.current === active) return;
    const first = scrolledFor.current === null;
    scrolledFor.current = active;
    const run = () => {
      const bar = nav.current;
      const tab = bar?.querySelector('a[aria-current="page"]');
      if (!bar || !tab) return;
      const edge = 12;
      const barBox = bar.getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      const overLeft = barBox.left + edge - tabBox.left;
      const overRight = tabBox.right - (barBox.right - edge);
      const delta = overLeft > 0 ? -overLeft : overRight > 0 ? overRight : 0;
      // Şerit kenarındaki sekme için kaydırma payı yoksa çağrı yapılmaz (ilk ve son sekme).
      const target = Math.max(0, Math.min(bar.scrollWidth - bar.clientWidth, bar.scrollLeft + delta));
      if (delta === 0 || Math.abs(target - bar.scrollLeft) < 1) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      bar.scrollTo({ left: target, behavior: first || reduced ? 'instant' : 'smooth' });
    };
    // İlk açılışta yazı tipi yüklenmeden ölçülürse sekme genişlikleri sonra büyür: yazı tipini bekle (tek çağrı).
    // Ölçüm yerleşimi zorlar; sekme yazısının yüzü o an yüklenmeye başlar.
    nav.current?.getBoundingClientRect();
    if (first && document.fonts?.status === 'loading') void document.fonts.ready.then(run);
    else run();
    // Şerit yalnız `active` değişince kaydırılır; `defs` yenilenmesi kullanıcının kaydırmasını bozmasın.
  }, [active]);
  return (
    <nav ref={nav} className="hub-datasets" aria-label={label}>
      {defs.map((d) => (
        <Link key={d.id} to={`/data/${product}/${d.id}`} className={d.id === active ? 'on' : undefined} aria-current={d.id === active ? 'page' : undefined} title={d.description}>
          {d.label}
        </Link>
      ))}
    </nav>
  );
}

function DatasetView({
  product,
  id,
  label,
  filters: defs,
  exportable,
}: {
  product: ProductKey;
  id: string;
  label: string;
  filters: Parameters<typeof FilterControls>[0]['defs'];
  exportable: boolean;
}) {
  const { t } = useTranslation();
  const scope = useScope();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const sort = params.get('sort') ?? undefined;
  const dir = (params.get('dir') as 'asc' | 'desc' | null) ?? undefined;
  const filters = readFilters(params);
  const [qDraft, setQDraft] = useState(params.get('q') ?? '');
  const q = useDebounced(qDraft);
  const [exporting, setExporting] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q);
        else next.delete('q');
        next.delete('page');
        return next;
      },
      { replace: true },
    );
    // yalnız arama metni durunca
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query = useQuery({
    queryKey: [...scope, 'dataset', product, id, page, q, sort, dir, JSON.stringify(filters)],
    queryFn: () => fetchDataset(product, id, { page, pageSize: PAGE_SIZE, q: q || undefined, sort, dir, filters }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const filtered = !!q || Object.keys(filters).length > 0;
  const phone = useIsPhone();
  const filterCount = Object.keys(filters).length;
  const filterPanel = useFilterPanel(filterCount, t('filter.panelTitle'));
  const [storedHidden, saveHidden] = useHiddenColumns(`sod_hub_cols_${product}_${id}`);
  const rows = data?.rows ?? [];
  const allColumns = data?.columns ?? [];
  // Tutar hücresi para birimini kendisi yazıyorsa ayrı "Para birimi" sütunu varsayılan gizli.
  const defaultHidden = useMemo(() => {
    const moneyInRow = allColumns.filter((c) => hasRowCurrency(c, rows));
    const cells = new Set(moneyInRow.map((c) => c.currencyCell ?? CURRENCY_CELL));
    return allColumns.filter((c) => c.hiddenByDefault || cells.has(c.id)).map((c) => c.id);
  }, [allColumns, rows]);
  const hidden = storedHidden ?? defaultHidden;
  // "Tümü"nde farklı para birimleri birbirine karşı sıralanamaz: para birimi seçilene dek tutar sıralaması kapalı.
  const mixed = defs.some((d) => d.id === CURRENCY_FILTER) && !filters[CURRENCY_FILTER];
  const columns = useMemo(
    () => allColumns.filter((c) => !hidden.includes(c.id)).map((c) => (mixed && hasRowCurrency(c, rows) ? { ...c, sortable: false } : c)),
    [allColumns, hidden, mixed, rows],
  );
  const sortBlocked = !!sort && mixed && allColumns.some((c) => c.id === sort && isMoneyColumn(c, rows) && hasRowCurrency(c, rows));
  const showSortNote = mixed && allColumns.some((c) => c.sortable && hasRowCurrency(c, rows));

  const canColumns = !!data && allColumns.length > 2;
  // Nadir eylemler tek ⋯ menüsünde: sütun seçimi ve CSV. Açıkta yalnız arama, tek süzgeç ve "Filtreler" kalır.
  const menuItems: MenuItem[] = [
    ...(canColumns ? [{ label: t('table.columnsItem'), icon: 'table' as const, onSelect: () => setColumnsOpen(true) }] : []),
    ...(exportable ? [{ label: t('table.csvItem'), icon: 'download' as const, disabled: !data || data.total === 0, hint: data && data.total === 0 ? t('data.exportEmpty') : undefined, onSelect: () => void doExport() }] : []),
  ];

  const doExport = async () => {
    setExporting(true);
    try {
      await exportDataset(product, id, { q: q || undefined, sort, dir, filters });
      toast.ok(t('data.exported', { name: label }));
    } catch (e) {
      const tooLarge = e instanceof ApiError && e.code === 'EXPORT_TOO_LARGE';
      toast.err(tooLarge ? t('data.exportTooLarge') : t('data.exportFailed'), apiMessage(e, t('common.unexpected')));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="hub-panel hub-dataset-panel">
      <div className="hub-dataset-tools">
        <Field label={t('data.search')} htmlFor="hub-q" className="hub-search">
          <div className="search">
            <Icon name="search" />
            <input id="hub-q" className="inp sm" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
          </div>
        </Field>
        {!phone && <FilterControls defs={defs} visible={1} value={filters} onChange={(f) => setParams((prev) => writeFilters(prev, f), { replace: true })} />}
        <div className="hub-dataset-end">
          {phone && defs.length > 0 && filterPanel.button}
          {data && <span className="muted hub-total">{t('data.total', { count: data.total })}</span>}
          {(canColumns || exportable) && (
            <ColumnPicker columns={allColumns} hidden={hidden} open={columnsOpen} onClose={() => setColumnsOpen(false)} onChange={saveHidden} onReset={() => saveHidden(null)}>
              <ActionMenu iconOnly label={t('table.moreActions')} busy={exporting} items={menuItems} />
            </ColumnPicker>
          )}
        </div>
      </div>
      {phone && filterPanel.render(<FilterControls defs={defs} value={filters} onChange={(f) => setParams((prev) => writeFilters(prev, f), { replace: true })} />)}
      {showSortNote && data && data.rows.length > 0 && <p className="hub-dataset-note">{t('data.sortNeedsCurrency')}</p>}
      {query.isPending && (
        <div className="hub-skel-stack pad" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skel key={i} h={20} />
          ))}
        </div>
      )}
      {query.isError && (
        <div className="hub-pad">
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </div>
      )}
      {data &&
        (data.rows.length === 0 ? (
          <Empty
            icon={filtered ? 'search' : 'table'}
            compact
            title={filtered ? t('data.noMatchTitle') : t('data.emptyTitle')}
            actions={
              filtered ? (
                <Button
                  kind="secondary"
                  small
                  onClick={() => {
                    setQDraft('');
                    setParams((prev) => writeFilters(prev, {}), { replace: true });
                  }}
                >
                  {t('filter.clearAll')}
                </Button>
              ) : undefined
            }
          >
            {filtered ? t('data.noMatchBody') : t('data.emptyBody')}
          </Empty>
        ) : (
          <>
            <DataTable
              compact
              columns={columns}
              rows={data.rows}
              busy={query.isPlaceholderData}
              sortHint={t('data.sortNeedsCurrency')}
              sort={sortBlocked ? {} : { sort, dir }}
              onSort={(s) =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('sort', s.sort!);
                    next.set('dir', s.dir!);
                    next.delete('page');
                    return next;
                  },
                  { replace: true },
                )
              }
            />
            <Pager
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={(p) =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set('page', String(p));
                  return next;
                })
              }
            />
          </>
        ))}
    </div>
  );
}
