import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { HubSeries, HubSplit, HubTone, HubValueFormat } from '@sellerondata/contracts';
import { formatDate, formatHubValue, formatPercent, Icon } from '@sellerondata/shell';
import { useWidth } from '../lib/hooks.ts';
import { compactValue, SmartLink } from './values.tsx';

/*
 * Grafikler kütüphanesiz, düz SVG. Kurallar dataviz becerisinden: tek eksen, 2px çizgi, ≤24px çubuk,
 * dolgu %10, ızgara kıl çizgi, metin hiçbir zaman seri renginde değil, ≥2 seride lejant, her grafiğin tablo ikizi.
 * Kategori sırası sabit ve doğrulandı: validate_palette "#1d5bd8,#dc6803,#0e9384,#7a5af8" (ΔE ≥ 12.4).
 */
const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
const PREV_COLOR = 'var(--chart-prev)';

type Plotted = HubSeries & { color: string; previous: boolean };

/** Renk sıradan değil seriden gelir: "previous" gri, diğerleri sabit sırayla. Dördünden sonrası gelmez. */
function assignColors(series: HubSeries[]): Plotted[] {
  let i = 0;
  return series.map((s) => {
    const previous = s.role === 'previous';
    return { ...s, previous, color: previous ? PREV_COLOR : SERIES_COLORS[i++ % SERIES_COLORS.length]! };
  });
}

/** Eksen için temiz adım: 1, 2, 5, 10 × 10^n. Tam sayı serisinde kesirli çentik çıkmaz. */
function niceStep(range: number, count: number): number {
  const raw = (range || 1) / count;
  const e = Math.floor(Math.log10(raw));
  const base = 10 ** e;
  const n = raw / base;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * base;
}

const looksDate = (x: string) => /^\d{4}-\d{2}-\d{2}/.test(x);

export function TimeSeriesChart({
  series,
  chart,
  format,
  currency,
  height = 220,
  label,
  showEndLabel = true,
}: {
  series: HubSeries[];
  chart: 'line' | 'area' | 'bar';
  format: HubValueFormat;
  currency?: string;
  height?: number;
  label: string;
  showEndLabel?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotted = useMemo(() => assignColors(series), [series]);
  const current = plotted.find((s) => !s.previous) ?? plotted[0];
  const n = Math.max(0, ...plotted.map((s) => s.points.length));
  const values = plotted.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null));
  // Üst sınır veriye yakın kalsın: az çentikte adım iri, tepe boş kalır.
  const tickCount = height < 150 ? 2 : height < 200 ? 3 : 4;
  const step = niceStep(Math.max(0, ...values) - Math.min(0, ...values), tickCount);
  const maxY = Math.max(step, Math.ceil(Math.max(0, ...values) / step) * step);
  const minY = Math.floor(Math.min(0, ...values) / step) * step;

  const m = { top: 12, right: showEndLabel && chart !== 'bar' ? 76 : 8, bottom: 26, left: width < 420 ? 44 : 60 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const y = (v: number) => m.top + h - ((v - minY) / (maxY - minY || 1)) * h;
  const barMode = chart === 'bar';
  const band = n ? w / n : 0;
  const x = (i: number) => m.left + (barMode ? band * (i + 0.5) : n > 1 ? (w * i) / (n - 1) : w / 2);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let v = minY; v <= maxY + step / 2; v += step) out.push(v);
    return out;
  }, [maxY, minY, step]);

  const xLabel = (i: number) => {
    const v = current?.points[i]?.x ?? '';
    return looksDate(v) ? formatDate(v, lng, { day: 'numeric', month: 'short' }) : v;
  };
  const xTicks = useMemo(() => {
    if (n === 0) return [];
    const room = Math.max(2, Math.min(n, Math.floor(w / 92)));
    if (barMode) {
      // Çubukta çentik çubuğun altındadır: eşit aralık için tam sayı adım.
      const every = Math.ceil(n / room);
      return Array.from({ length: Math.ceil(n / every) }, (_, i) => i * every);
    }
    const every = (n - 1) / (room - 1 || 1);
    return Array.from(new Set(Array.from({ length: room }, (_, i) => Math.round(i * every))));
  }, [n, w, barMode]);

  const pick = (e: PointerEvent<SVGRectElement>) => {
    if (!n) return;
    const box = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - box.left;
    const i = barMode ? Math.floor(rel / (band || 1)) : Math.round((rel / (box.width || 1)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setHover((v) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return n - 1;
      const cur = v ?? n - 1;
      return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  const fmt = (v: number | null | undefined) => formatHubValue({ value: v ?? null, format, currency }, lng);
  const path = (s: Plotted) => {
    let d = '';
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.y === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.y).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaPath = (s: Plotted) => {
    const pts = s.points.map((p, i) => [i, p.y] as const).filter((q): q is readonly [number, number] => q[1] !== null);
    if (!pts.length) return '';
    return `M${x(pts[0]![0]).toFixed(1)} ${y(0)}${pts.map(([i, v]) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')}L${x(pts[pts.length - 1]![0]).toFixed(1)} ${y(0)}Z`;
  };
  const lastOf = (s: Plotted) => {
    for (let i = s.points.length - 1; i >= 0; i--) if (s.points[i]!.y !== null) return i;
    return -1;
  };

  // Son değer etiketleri: yalnız ana seride. Karşılaştırma çizgisi lejantta ve araç ipucunda okunur.
  const endIndex = current ? lastOf(current) : -1;
  const tipLeft = hover !== null ? x(hover) : 0;
  const tipFlip = tipLeft > width - 200;

  return (
    <div className="hub-chart" ref={ref}>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKey}
          onFocus={() => setHover((v) => v ?? endIndex)}
          onBlur={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'hub-axis' : 'hub-grid'} />
              <text x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="hub-tick">
                {compactValue(v, format, currency, lng, maxY)}
              </text>
            </g>
          ))}
          {xTicks.map((i, idx) => (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor={!barMode && idx === 0 ? 'start' : !barMode && idx === xTicks.length - 1 ? 'end' : 'middle'}
              className="hub-tick"
            >
              {xLabel(i)}
            </text>
          ))}

          {barMode &&
            plotted.map((s, si) => {
              const groups = plotted.length;
              const gap = 2;
              const bw = Math.max(2, Math.min(24, (band * 0.72 - gap * (groups - 1)) / groups));
              const total = bw * groups + gap * (groups - 1);
              return s.points.map((p, i) => {
                if (p.y === null) return null;
                const bx = x(i) - total / 2 + si * (bw + gap);
                const top = y(Math.max(p.y, 0));
                const bh = Math.max(p.y === 0 ? 0 : 1, Math.abs(y(p.y) - y(0)));
                const r = Math.min(4, bw / 2, bh);
                return (
                  <path
                    key={`${s.id}${i}`}
                    d={`M${bx} ${top + bh}V${top + r}Q${bx} ${top} ${bx + r} ${top}H${bx + bw - r}Q${bx + bw} ${top} ${bx + bw} ${top + r}V${top + bh}Z`}
                    fill={s.color}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                );
              });
            })}

          {!barMode &&
            plotted.map((s) => (
              <g key={s.id}>
                {chart === 'area' && !s.previous && <path d={areaPath(s)} fill={s.color} opacity={0.1} />}
                <path d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}

          {!barMode && showEndLabel && current && endIndex >= 0 && hover === null && (
            <g>
              <circle cx={x(endIndex)} cy={y(current.points[endIndex]!.y!)} r={5} fill="var(--surface)" />
              <circle cx={x(endIndex)} cy={y(current.points[endIndex]!.y!)} r={4} fill={current.color} />
              <text x={x(endIndex) + 10} y={y(current.points[endIndex]!.y!)} dy="0.32em" className="hub-end">
                {compactValue(current.points[endIndex]!.y!, format, currency, lng)}
              </text>
            </g>
          )}

          {hover !== null && !barMode && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} className="hub-cross" />
              {plotted.map((s) => {
                const v = s.points[hover]?.y;
                return v === null || v === undefined ? null : (
                  <g key={s.id}>
                    <circle cx={x(hover)} cy={y(v)} r={6} fill="var(--surface)" />
                    <circle cx={x(hover)} cy={y(v)} r={4} fill={s.color} />
                  </g>
                );
              })}
            </g>
          )}

          <rect x={m.left} y={m.top} width={w} height={h} fill="transparent" onPointerMove={pick} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {width === 0 && <div style={{ height }} />}

      {hover !== null && width > 0 && (
        <div className={`hub-tip${tipFlip ? ' flip' : ''}`} style={{ left: tipLeft, top: 4 }} role="status">
          <div className="hub-tip-x">{xLabel(hover)}</div>
          {plotted.map((s) => {
            const point = s.points[hover];
            return (
              <div className="hub-tip-row" key={s.id}>
                <i style={{ background: s.color }} />
                <b>{fmt(point?.y)}</b>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {plotted.length > 1 && (
        <div className="hub-legend" aria-label={t('chart.legend')}>
          {plotted.map((s) => (
            <span key={s.id}>
              <i className={chart === 'bar' ? 'box' : 'line'} style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Grafiğin tablo ikizi: her değer tooltip'siz de okunur. */
export function SeriesTable({ series, format, currency }: { series: HubSeries[]; format: HubValueFormat; currency?: string }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const rows = series[0]?.points ?? [];
  return (
    <div className="table-wrap hub-twin">
      <table className="dt compact">
        <thead>
          <tr>
            <th>{t('chart.point')}</th>
            {series.map((s) => (
              <th className="r" key={s.id}>
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.x}>
              <td className="mono">{looksDate(p.x) ? formatDate(p.x, lng) : p.x}</td>
              {series.map((s) => (
                <td className="r num" key={s.id}>
                  {formatHubValue({ value: s.points[i]?.y ?? null, format, currency }, lng)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sıralı yatay çubuklar: parçaları birbiriyle karşılaştırmak için. Tek renk, en büyük üstte. */
export function BreakdownBars({
  items,
  format,
  currency,
}: {
  items: { key: string; label: string; value: number; share?: number; href?: string; color?: string }[];
  format: HubValueFormat;
  currency?: string;
}) {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  const sorted = useMemo(() => [...items].sort((a, b) => b.value - a.value), [items]);
  const max = Math.max(1, ...sorted.map((i) => Math.abs(i.value)));
  return (
    <ul className="hub-bars">
      {sorted.map((it) => {
        const body = (
          <>
            <span className="hub-bars-label">{it.label}</span>
            <span className="hub-bars-value">
              {formatHubValue({ value: it.value, format, currency }, lng)}
              {it.share !== undefined && <small>{formatPercent(it.share, lng, 0)}</small>}
            </span>
            <span className="hub-bars-track" aria-hidden="true">
              <i style={{ width: `${Math.max(1, Math.min(100, it.share ?? (Math.abs(it.value) / max) * 100))}%`, ...(it.color ? { background: it.color } : {}) }} />
            </span>
          </>
        );
        return (
          <li key={it.key}>
            {it.href ? (
              <SmartLink href={it.href} className="hub-bars-row is-link">
                {body}
              </SmartLink>
            ) : (
              <div className="hub-bars-row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** `bad` kırmızı değil: bu parça kaçan para değil, farklı satırların toplam tutarıdır. Kaçan para baş rakamdır. */
const SPLIT_CLASS: Record<HubTone, string> = { good: 'good', bad: 'attn', warning: 'warning', info: 'info', neutral: 'neutral' };

/** Bir bütünün parçaları: tek bakışta "para nereye gitti". Parçalar 2px boşlukla ayrılır. */
export function SplitBar({ split, label }: { split: HubSplit; label?: string }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const id = useId();
  const sum = split.parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const fmt = (v: number) => formatHubValue({ value: v, format: split.total.format, currency: split.total.currency }, lng);
  const summary = split.parts.map((p) => `${p.label}: ${fmt(p.value)} (${formatPercent((p.value / sum) * 100, lng, 0)})`).join(', ');
  return (
    <div className="hub-split">
      <div className="hub-split-bar" role="img" aria-labelledby={id}>
        <span id={id} className="sr-only">
          {label ?? split.title}. {summary}
        </span>
        {split.parts
          .filter((p) => p.value > 0)
          .map((p) => {
            const share = (p.value / sum) * 100;
            return (
              <span key={p.key} className={`part ${SPLIT_CLASS[p.tone]}`} style={{ flexGrow: p.value, flexBasis: 0 }} title={`${p.label}: ${fmt(p.value)}`} aria-hidden="true">
                {share >= 7 && <b>{formatPercent(share, lng, 0)}</b>}
              </span>
            );
          })}
      </div>
      <ul className="hub-split-legend">
        {split.parts.map((p) => {
          const body = (
            <>
              <i className={`swatch ${SPLIT_CLASS[p.tone]}`} aria-hidden="true" />
              <span className="name">
                {p.label}
                {(p.note ?? (p.tone === 'bad' ? t('home.split.badNote') : undefined)) && <small>{p.note ?? t('home.split.badNote')}</small>}
              </span>
              <span className="val">{fmt(p.value)}</span>
              <span className="share">{formatPercent((p.value / sum) * 100, lng, 0)}</span>
              {p.href && <Icon name="chevr" size={12} />}
            </>
          );
          return (
            <li key={p.key}>
              {p.href ? (
                <SmartLink href={p.href} className="row is-link">
                  {body}
                </SmartLink>
              ) : (
                <div className="row">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
