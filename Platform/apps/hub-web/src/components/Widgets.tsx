import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HubColumn, HubKpi, HubRow, HubSection, HubWidget } from '@sellerondata/contracts';
import { Empty, formatHubValue, Icon } from '@sellerondata/shell';
import { BreakdownBars, SeriesTable, TimeSeriesChart } from './charts.tsx';
import { DataTable } from './DataTable.tsx';
import { DeltaBadge, SmartLink, useKpiDelta } from './values.tsx';

/** KPI dizisi: ilk KPI baş rakam, kalanı cetvel satırı. Eş boy kutu dizisi yok; Genel Bakış ile aynı okuma. */
export function KpiStrip({ items }: { items: HubKpi[] }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const delta = useKpiDelta();
  // Baş rakam: en ciddi tonlu KPI; yoksa ilki. Sıra üründen gelir, Merkez ürüne özel kimlik bilmez.
  const lead = items.find((k) => k.tone === 'bad') ?? items[0];
  if (!lead) return null;
  const rest = items.filter((k) => k !== lead);
  return (
    <div className="hub-kpis">
      <div className="hub-kpis-lead">
        <span className="hub-kpi-label">{lead.label}</span>
        <span className="hub-kpi-value">{formatHubValue(lead, lng)}</span>
        <span className="hub-kpi-foot">
          <DeltaBadge delta={delta(lead)} />
          {typeof lead.previous === 'number' && <span className="hub-lead-prev">{t('home.previous', { value: formatHubValue({ value: lead.previous, format: lead.format, currency: lead.currency }, lng) })}</span>}
        </span>
        {lead.hint && <span className="hub-kpi-hint">{lead.hint}</span>}
      </div>
      <div className="hub-kpis-rows">
        {rest.map((k) => {
          const body = (
            <>
              <span className="hub-ledger-label">{k.label}</span>
              <span className="hub-ledger-value">{formatHubValue(k, lng)}</span>
              <span className="hub-ledger-delta">
                <DeltaBadge delta={delta(k)} />
              </span>
            </>
          );
          return k.href ? (
            <SmartLink key={k.id} href={k.href} className="hub-ledger-row is-link">
              {body}
            </SmartLink>
          ) : (
            <div key={k.id} className="hub-ledger-row">
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WidgetFrame({
  title,
  description,
  actions,
  children,
  flush,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={`hub-widget${flush ? ' flush' : ''}`}>
      <header className="hub-widget-head">
        <div className="grow">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="hub-widget-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

const TABLE_PREVIEW = 5;
const TABLE_PREVIEW_PHONE = 3;

/** Uzun özet tablo ilk bakışta sayfayı uzatmasın: ilk 5 satır, gerisi istekle. */
function TableBody({ columns, rows }: { columns: HubColumn[]; rows: HubRow[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  // Telefonda satırlar karta döner ve uzar: daha az satır.
  const preview = window.matchMedia('(max-width: 767px)').matches ? TABLE_PREVIEW_PHONE : TABLE_PREVIEW;
  const shown = all ? rows : rows.slice(0, preview);
  return (
    <>
      <DataTable columns={columns} rows={shown} compact />
      {rows.length > preview && (
        <div className="hub-table-more">
          <button type="button" className="link-btn" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? t('widget.showLess') : t('widget.showAll', { count: rows.length })}
          </button>
        </div>
      )}
    </>
  );
}

type Cell = string | number | null | undefined;
type TFn = (key: string) => string;

/** Bir bölümdeki CSV'ye çevrilebilen her bileşen: Analiz sayfa başındaki tek "Dışa aktar" menüsü bunlardan oluşur. */
export type Exportable = { id: string; name: string; file: string; rows: Cell[][] };

function exportRows(w: HubWidget, t: TFn): Cell[][] | null {
  switch (w.kind) {
    case 'timeseries':
      return [[t('chart.point'), ...w.series.map((s) => (w.currency ? `${s.label} (${w.currency})` : s.label))], ...(w.series[0]?.points ?? []).map((p, i) => [p.x, ...w.series.map((s) => s.points[i]?.y ?? null)])];
    case 'breakdown':
      return w.currency
        ? [[t('widget.item'), t('widget.value'), t('widget.currency')], ...w.items.map((i) => [i.label, i.value, w.currency!])]
        : [[t('widget.item'), t('widget.value')], ...w.items.map((i) => [i.label, i.value])];
    case 'table':
      return [w.columns.map((c) => c.label), ...w.rows.map((r) => w.columns.map((c) => r.cells[c.id] ?? null))];
    default:
      return null;
  }
}

/** Sayfadaki indirilebilir tablolar (seri, kırılım, tablo); sırası ekrandaki sıra. */
export function sectionExports(section: HubSection, filePrefix: string, t: TFn): Exportable[] {
  const out: Exportable[] = [];
  for (const w of section.widgets) {
    if (w.kind === 'kpis' || w.kind === 'empty') continue;
    const rows = exportRows(w, t);
    if (rows) out.push({ id: w.id, name: w.title, file: `${filePrefix}-${w.id}`, rows });
  }
  return out;
}

function TimeseriesWidget({ w }: { w: Extract<HubWidget, { kind: 'timeseries' }> }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  return (
    <WidgetFrame
      title={w.title}
      description={w.description}
      actions={
        <button type="button" className="hub-mini" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          <Icon name={asTable ? 'chart' : 'table'} size={14} /> {asTable ? t('widget.asChart') : t('widget.asTable')}
        </button>
      }
    >
      {asTable ? (
        <SeriesTable series={w.series} format={w.format} currency={w.currency} />
      ) : (
        <TimeSeriesChart series={w.series} chart={w.chart} format={w.format} currency={w.currency} label={w.title} height={240} />
      )}
    </WidgetFrame>
  );
}

/** Sözleşmedeki her `HubWidget` türünü çizer. Yeni ürün Merkez koduna dokunmadan takılır. */
export function Widget({ widget: w }: { widget: HubWidget }) {
  const { t } = useTranslation();
  switch (w.kind) {
    case 'kpis':
      return <KpiStrip items={w.items} />;
    case 'timeseries':
      return <TimeseriesWidget w={w} />;
    case 'breakdown':
      return (
        <WidgetFrame title={w.title} description={w.description}>
          {w.items.length ? <BreakdownBars items={w.items} format={w.format} currency={w.currency} /> : <Empty compact icon="chart" title={t('widget.noData')} />}
        </WidgetFrame>
      );
    case 'table':
      return (
        <WidgetFrame flush title={w.title} description={w.description}>
          {w.rows.length ? <TableBody columns={w.columns} rows={w.rows} /> : <Empty compact icon="table" title={t('widget.noData')} />}
        </WidgetFrame>
      );
    case 'empty':
      return (
        <section className="hub-widget">
          <Empty
            compact
            icon="chart"
            title={w.title}
            actions={
              w.href ? (
                <SmartLink href={w.href} className="btn btn-secondary btn-sm">
                  {w.actionLabel ?? t('widget.go')}
                </SmartLink>
              ) : undefined
            }
          >
            {w.body}
          </Empty>
        </section>
      );
  }
}

const BIG_TABLE_COLUMNS = 4;
type Slot = { widget: HubWidget; span: 'full' | 'wide' | 'narrow' | 'half' | 'third' };

/**
 * Bölüm yerleşimi verilerden çıkar, widget kimliği bilinmez:
 * KPI en üstte; seri ve kırılımlar yan yana (seri 3/5, ilk kırılım 2/5, kalanlar eşit sütunlarda, tek kalan boş alan bırakmaz);
 * az kolonlu tablo tek kırılımın yanına oturur; büyük tablolar en sonda tam genişlik.
 */
function layout(widgets: HubWidget[]): Slot[] {
  const kpis = widgets.filter((w) => w.kind === 'kpis');
  const empties = widgets.filter((w) => w.kind === 'empty');
  const series = widgets.filter((w) => w.kind === 'timeseries');
  const bars = widgets.filter((w) => w.kind === 'breakdown');
  const tables = widgets.filter((w) => w.kind === 'table');
  const slots: Slot[] = kpis.map((widget) => ({ widget, span: 'full' }));
  const pendingBars = [...bars];
  for (const s of series) {
    const partner = pendingBars.shift();
    if (partner) slots.push({ widget: s, span: 'wide' }, { widget: partner, span: 'narrow' });
    else slots.push({ widget: s, span: 'full' });
  }
  const smallTables = tables.filter((t) => t.kind === 'table' && t.columns.length <= BIG_TABLE_COLUMNS);
  if (pendingBars.length === 1 && smallTables[0]) {
    slots.push({ widget: pendingBars[0]!, span: 'narrow' }, { widget: smallTables[0], span: 'wide' });
    pendingBars.length = 0;
    tables.splice(tables.indexOf(smallTables[0]), 1);
  }
  if (pendingBars.length === 1) slots.push({ widget: pendingBars[0]!, span: 'full' });
  else if (pendingBars.length === 2 || pendingBars.length === 4) for (const widget of pendingBars) slots.push({ widget, span: 'half' });
  else for (const widget of pendingBars) slots.push({ widget, span: 'third' });
  for (const widget of tables) slots.push({ widget, span: 'full' });
  for (const widget of empties) slots.push({ widget, span: 'full' });
  return slots;
}

/** `tabbed`: bölüm adı üstteki sekmede yazılı; başlık yalnız ekran okuyucuya kalır, tekrar etmez. */
export function Section({ section, busy, tabbed }: { section: HubSection; busy?: boolean; tabbed?: boolean }) {
  const { t } = useTranslation();
  const slots = layout(section.widgets);
  return (
    <section id={`section-${section.id}`} className={`hub-section${busy ? ' is-busy' : ''}`}>
      <header className="hub-section-head">
        <h2 className={tabbed ? 'sr-only' : undefined}>{section.title}</h2>
        {section.description && <p>{section.description}</p>}
        {section.finding && (
          <p className="hub-finding">
            <b>{section.finding.text}</b>
            {section.finding.href && (
              <SmartLink href={section.finding.href} className="link-btn">
                {section.finding.actionLabel ?? t('widget.go')} <Icon name="arrow" />
              </SmartLink>
            )}
          </p>
        )}
      </header>
      <div className="hub-grid">
        {slots.map(({ widget, span }) => (
          <div key={widget.id} className={`hub-cell ${span}`}>
            <Widget widget={widget} />
          </div>
        ))}
      </div>
    </section>
  );
}
