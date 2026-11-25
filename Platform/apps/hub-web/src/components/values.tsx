import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { HubKpi, ProductKey } from '@sellerondata/contracts';
import { PRODUCTS } from '@sellerondata/contracts';
import { Icon, ProductMark, formatHubValue, formatMoney, formatNumber, formatPercent, safeHref } from '@sellerondata/shell';
import { isHubPath } from '../lib/nav.ts';

/** Merkez içi adres router ile, araca giden adres tam sayfa gezintiyle (görünüm geçişi orada çalışır). */
export function SmartLink({ href, className, children, title, 'aria-label': ariaLabel }: { href: string; className?: string; children: ReactNode; title?: string; 'aria-label'?: string }) {
  const safe = safeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  if (isHubPath(safe)) {
    return (
      <Link to={safe} className={className} title={title} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <a href={safe} className={className} title={title} aria-label={ariaLabel}>
      {children}
    </a>
  );
}

export type Delta = { dir: 'up' | 'down' | 'flat'; tone: 'good' | 'bad' | 'neutral'; text: string; srText: string };

/** Önceki döneme göre fark: yön, iyi/kötü, metin. Yüzde KPI'larda fark puan olarak okunur. */
export function useKpiDelta() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  return (kpi: Pick<HubKpi, 'value' | 'previous' | 'goodDirection' | 'format' | 'currency'>): Delta | null => {
    const { value, previous } = kpi;
    if (typeof value !== 'number' || previous === undefined || previous === null) return null;
    const diff = value - previous;
    const dir = Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'up' : 'down';
    const good = kpi.goodDirection ?? 'none';
    const tone = dir === 'flat' || good === 'none' ? 'neutral' : (dir === 'up') === (good === 'up') ? 'good' : 'bad';
    let amount: string;
    if (kpi.format === 'percent') amount = t('delta.points', { value: formatNumber(Math.abs(diff), lng, { maximumFractionDigits: 1 }) });
    else if (previous === 0) amount = formatHubValue({ value: Math.abs(diff), format: kpi.format, currency: kpi.currency }, lng);
    else amount = formatPercent((Math.abs(diff) / Math.abs(previous)) * 100, lng, Math.abs(diff / previous) < 0.1 ? 1 : 0);
    const prevText = formatHubValue({ value: previous, format: kpi.format, currency: kpi.currency }, lng);
    return {
      dir,
      tone,
      text: dir === 'flat' ? t('delta.same') : amount,
      srText: t(`delta.${dir}`, { amount, previous: prevText }),
    };
  };
}

export function DeltaBadge({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  return (
    <span className={`hub-delta ${delta.tone}`} title={delta.srText}>
      <Icon name={delta.dir === 'up' ? 'arrowup' : delta.dir === 'down' ? 'arrowdown' : 'minus'} size={12} />
      <span aria-hidden="true">{delta.text}</span>
      <span className="sr-only">{delta.srText}</span>
    </span>
  );
}

/** Eksen için kısa sayı. `scale` eksenin en büyüğü: bir eksende tek biçim olsun (5 B, 10 B; 5.000 ile 10 B karışmasın). */
export function compactValue(v: number, format: string, currency: string | undefined, lng: string, scale = Math.abs(v)): string {
  // Tek eşik: sütuna sığmayana dek tam yazılır. Aynı eksende biçim karışmaz.
  const compact = scale >= 100000;
  if (format === 'money') {
    if (compact) return formatMoney(v, currency, lng, { compact: true });
    return formatMoney(v, currency, lng).replace(/[.,]00(?=\D*$)/, '');
  }
  if (format === 'percent') return formatPercent(v, lng, 0);
  return formatNumber(v, lng, { notation: compact ? 'compact' : 'standard', maximumFractionDigits: 1 });
}

/** Araç adı + işareti. Etkinlik ve Bekleyenler'de kaynağı gösterir. */
export function ToolLabel({ product }: { product: ProductKey }) {
  return (
    <span className="hub-tool">
      <ProductMark product={product} size={16} />
      {PRODUCTS[product].name}
    </span>
  );
}
