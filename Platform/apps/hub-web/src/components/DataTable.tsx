import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HubColumn, HubRow } from '@sellerondata/contracts';
import { Icon, formatHubValue, formatNumber } from '@sellerondata/shell';
import { useIsPhone } from '../lib/hooks.ts';
import { SmartLink } from './values.tsx';

const RIGHT: HubColumn['format'][] = ['number', 'money', 'percent', 'duration_days'];
const alignOf = (c: HubColumn) => c.align ?? (RIGHT.includes(c.format) ? 'right' : 'left');
/** Tek kural (DeciShip ile aynı): bu kadar sütuna kadar telefonda kart, fazlasında yapışkan ilk sütun ve yatay kaydırma. */
const CARD_MAX_COLUMNS = 4;
const CURRENCY_CELL = 'currency';
const PRIMARY_AMOUNT = 'overcharge';

export type SortState = { sort?: string; dir?: 'asc' | 'desc' };

/** Satırın para birimini taşıyan hücre: sözleşmedeki `currencyCell`, yoksa `currency` adlı hücre. */
const currencyCellOf = (c: HubColumn) => c.currencyCell ?? CURRENCY_CELL;

/**
 * Tutar sütunu mu? `money`, ya da para birimi satırda duran sağa hizalı sayı (DeciShip veri setleri `number` + `align: right` döner).
 * Satır sayısı gibi hizası açıkça verilmemiş sayılar tutar sayılmaz.
 */
export function isMoneyColumn(c: HubColumn, rows: HubRow[]): boolean {
  if (c.format === 'money' || c.currencyCell) return true;
  return c.format === 'number' && c.align === 'right' && rows.some((r) => typeof r.cells[currencyCellOf(c)] === 'string');
}

/** Satır başına para birimi olan tutar sütunu: farklı para birimleri birbirine karşı sıralanamaz. */
export function hasRowCurrency(c: HubColumn, rows: HubRow[]): boolean {
  return !c.currency && isMoneyColumn(c, rows);
}

function cellText(c: HubColumn, row: HubRow, money: boolean, lng: string): string {
  const value = row.cells[c.id] ?? null;
  if (!money) return formatHubValue({ value, format: c.format, currency: c.currency }, lng);
  const rowCurrency = row.cells[currencyCellOf(c)];
  const currency = c.currency ?? (typeof rowCurrency === 'string' ? rowCurrency : undefined);
  // Para birimi bilinmiyorsa simge uydurulmaz (formatMoney TRY varsayar): iki ondalıklı sayı.
  if (!currency && typeof value === 'number') return formatNumber(value, lng, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatHubValue({ value, format: 'money', currency }, lng);
}

/**
 * Sözleşmedeki kolon ve satırları çizen genel tablo. Satır araca derin bağlantı verir; tablo içinde iş yapılmaz.
 * Kolonlar araçtan gelir ve sayısı bilinmez: taşarsa yatay kayar, ilk kolon her genişlikte sabit kalır, kenar gölgesi ve ipucu görünür.
 */
export function DataTable({
  columns: givenColumns,
  rows,
  sort,
  onSort,
  compact,
  busy,
  sortHint,
}: {
  columns: HubColumn[];
  rows: HubRow[];
  sort?: SortState;
  onSort?: (s: SortState) => void;
  compact?: boolean;
  busy?: boolean;
  /** Kapalı sıralamanın nedeni (sütun başlığında ipucu). */
  sortHint?: string;
}) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const anyLink = rows.some((r) => r.href);
  const cards = givenColumns.length <= CARD_MAX_COLUMNS;
  const phone = useIsPhone();
  // Dar ekranda para görünür kalsın: yapışkan ilk sütunun hemen yanına "Fazla ödeme", yoksa ilk tutar.
  const columns = useMemo(() => {
    if (!phone || cards) return givenColumns;
    const money = givenColumns.slice(1).filter((c) => isMoneyColumn(c, rows));
    const lead = money.find((c) => c.id === PRIMARY_AMOUNT) ?? money[0];
    if (!lead) return givenColumns;
    return [givenColumns[0]!, lead, ...givenColumns.slice(1).filter((c) => c !== lead)];
  }, [givenColumns, rows, phone, cards]);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);

  return (
    <div className="hub-table-frame" data-left={edges.left} data-right={edges.right}>
      {edges.right && (
        <div className="hub-scroll-bar">
          <button
            type="button"
            className="hub-scroll-hint"
            onClick={() => scroller.current?.scrollBy({ left: 320, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
          >
            {t('table.moreColumns')} <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
      <div
        ref={scroller}
        className={`table-wrap hub-table${busy ? ' is-busy' : ''}`}
        // Taşan tablo klavyeyle de kaydırılır.
        tabIndex={edges.left || edges.right ? 0 : undefined}
        role={edges.left || edges.right ? 'region' : undefined}
        aria-label={edges.left || edges.right ? t('table.scrollRegion') : undefined}
      >
        <table className={`dt${compact ? ' compact' : ''}${cards ? ' dt-cards' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = sort?.sort === c.id ? sort.dir : undefined;
                const right = alignOf(c) === 'right';
                return (
                  <th key={c.id} className={right ? 'r' : undefined} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
                    {c.sortable && onSort ? (
                      <button
                        type="button"
                        className={`hub-sort${sorted ? ' on' : ''}`}
                        onClick={() => onSort({ sort: c.id, dir: sorted === 'asc' ? 'desc' : sorted === 'desc' ? 'asc' : RIGHT.includes(c.format) ? 'desc' : 'asc' })}
                      >
                        {c.label}
                        <Icon name={sorted === 'asc' ? 'up' : 'down'} size={12} className={sorted ? '' : 'idle'} />
                      </button>
                    ) : (
                      <span title={sortHint && hasRowCurrency(c, rows) ? sortHint : undefined}>{c.label}</span>
                    )}
                  </th>
                );
              })}
              {anyLink && (
                <th className="r hub-open-col">
                  <span className="sr-only">{t('table.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={row.href ? 'hub-row-link' : undefined}
                onClick={
                  row.href
                    ? (e) => {
                        // Satırın her hücresi açar; bağlantıya ya da düğmeye tıklanınca kendi işi yürür (klavye de o bağlantıdan).
                        if ((e.target as HTMLElement).closest('a,button')) return;
                        e.currentTarget.querySelector<HTMLAnchorElement>('a.hub-row-main, a.link-btn')?.click();
                      }
                    : undefined
                }
              >
                {columns.map((c, i) => {
                  const money = isMoneyColumn(c, rows);
                  const text = cellText(c, row, money, lng);
                  const right = alignOf(c) === 'right';
                  const numeric = RIGHT.includes(c.format);
                  const cls = [right ? 'r' : '', numeric ? 'num' : '', money || c.format === 'date' || c.format === 'datetime' ? 'nowrap' : ''].filter(Boolean).join(' ');
                  return (
                    <td key={c.id} className={[cls, cards && i === 0 ? 'card-title' : ''].filter(Boolean).join(' ') || undefined} data-label={cards && i > 0 ? c.label : undefined}>
                      {i === 0 && row.href ? (
                        <SmartLink href={row.href} className="hub-row-main">
                          {text}
                        </SmartLink>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
                {anyLink && (
                  <td className="r hub-open-col">
                    {row.href && (
                      <SmartLink href={row.href} className="link-btn" aria-label={t('table.openRow')} title={t('table.openRow')}>
                        <Icon name="arrow" />
                      </SmartLink>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
