import type { HubSeries } from './contracts';

/**
 * Grafik geometrisi: saf hesap, çizim yok. Kurallar dataviz becerisinden: tek eksen, 2px çizgi, ≤24px çubuk,
 * veri ucu 4px yuvarlak, taban düz, ızgara kıl çizgi, ≥2 seride lejant.
 * Kategori sırası sabit, doğrulandı: validate_palette "#1d5bd8,#dc6803,#0e9384,#7a5af8" (ΔE ≥ 12.4). Web ile aynı.
 */
export const SERIES_COLORS = ['#1d5bd8', '#dc6803', '#0e9384', '#7a5af8'] as const;
export const PREVIOUS_COLOR = '#98a2b3';
export const GRID_COLOR = '#eef0f3';
export const AXIS_COLOR = '#cfd4dc';

export type ChartKind = 'line' | 'area' | 'bar';
export type Plotted = HubSeries & { color: string; previous: boolean };
export type BarRect = { i: number; d: string; x: number; width: number };

export type ChartGeometry = {
  n: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotted: Plotted[];
  /** Grafiğe sığmayan seri sayısı. Renk üretilmez, döndürülmez; tablo ikizinde hepsi var. */
  omitted: number;
  yTicks: { value: number; y: number }[];
  xTicks: { i: number; x: number; anchor: 'start' | 'middle' | 'end' }[];
  baseline: number;
  lines: { id: string; color: string; previous: boolean; line: string; area: string | null }[];
  bars: { id: string; color: string; rects: BarRect[] }[];
  lastIndex: number;
  xAt: (i: number) => number;
  yAt: (v: number) => number;
};

/** Renk seriden gelir: "previous" gri, diğerleri sabit sırayla. Dördünden sonrası çizilmez. */
export function assignColors(series: readonly HubSeries[]): { plotted: Plotted[]; omitted: number } {
  let i = 0;
  let omitted = 0;
  const plotted: Plotted[] = [];
  for (const s of series) {
    if (s.role === 'previous') {
      plotted.push({ ...s, previous: true, color: PREVIOUS_COLOR });
      continue;
    }
    const color = SERIES_COLORS[i++];
    if (color) plotted.push({ ...s, previous: false, color });
    else omitted++;
  }
  return { plotted, omitted };
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(v));
  const n = v / base;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * base;
}

const f = (v: number) => v.toFixed(1);

function linePath(points: HubSeries['points'], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.y === null || !Number.isFinite(p.y)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${f(x(i))} ${f(y(p.y))}`;
    pen = true;
  });
  return d;
}

function areaPath(points: HubSeries['points'], x: (i: number) => number, y: (v: number) => number, base: number): string {
  const pts = points.map((p, i) => [i, p.y] as const).filter((q): q is readonly [number, number] => q[1] !== null && Number.isFinite(q[1]));
  if (!pts.length) return '';
  return `M${f(x(pts[0]![0]))} ${f(base)}${pts.map(([i, v]) => `L${f(x(i))} ${f(y(v))}`).join('')}L${f(x(pts[pts.length - 1]![0]))} ${f(base)}Z`;
}

/** Çubuk: veri ucu 4px yuvarlak, taban düz. Negatif değer tabandan aşağı iner. */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (y1 <= y0) return `M${f(x)} ${f(y0)}V${f(y1 + r)}Q${f(x)} ${f(y1)} ${f(x + r)} ${f(y1)}H${f(x + w - r)}Q${f(x + w)} ${f(y1)} ${f(x + w)} ${f(y1 + r)}V${f(y0)}Z`;
  return `M${f(x)} ${f(y0)}V${f(y1 - r)}Q${f(x)} ${f(y1)} ${f(x + r)} ${f(y1)}H${f(x + w - r)}Q${f(x + w)} ${f(y1)} ${f(x + w)} ${f(y1 - r)}V${f(y0)}Z`;
}

export function lastPointIndex(plotted: readonly Plotted[]): number {
  const main = plotted.find((s) => !s.previous) ?? plotted[0];
  if (!main) return -1;
  for (let i = main.points.length - 1; i >= 0; i--) if (main.points[i]!.y !== null) return i;
  return -1;
}

export function buildChart(input: { series: readonly HubSeries[]; chart: ChartKind; width: number; height: number; left?: number }): ChartGeometry {
  const { width, height, chart } = input;
  const { plotted, omitted } = assignColors(input.series);
  const left = input.left ?? 44;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const n = Math.max(0, ...plotted.map((s) => s.points.length));
  const values = plotted.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null && Number.isFinite(y)));
  const maxY = niceMax(Math.max(0, ...values));
  const minY = Math.min(0, ...values);
  const w = Math.max(0, width - left - right);
  const h = Math.max(0, height - top - bottom);
  const yAt = (v: number) => top + h - ((v - minY) / (maxY - minY || 1)) * h;
  const barMode = chart === 'bar';
  const band = n ? w / n : 0;
  const xAt = (i: number) => left + (barMode ? band * (i + 0.5) : n > 1 ? (w * i) / (n - 1) : w / 2);
  const base = yAt(0);

  // Dar ekranda üç yatay ızgara yeter: 0, orta, tepe.
  const yTicks = [0, 0.5, 1].map((t) => {
    const value = minY + (maxY - minY) * t;
    return { value, y: yAt(value) };
  });

  const room = Math.max(2, Math.min(n, Math.floor(w / 76)));
  const step = (n - 1) / (room - 1 || 1);
  const xIdx = n === 0 ? [] : Array.from(new Set(Array.from({ length: room }, (_, i) => Math.round(i * step))));
  const xTicks = xIdx.map((i, idx) => ({
    i,
    x: xAt(i),
    anchor: (!barMode && idx === 0 ? 'start' : !barMode && idx === xIdx.length - 1 ? 'end' : 'middle') as 'start' | 'middle' | 'end',
  }));

  const lines = barMode
    ? []
    : plotted.map((s) => ({
        id: s.id,
        color: s.color,
        previous: s.previous,
        line: linePath(s.points, xAt, yAt),
        area: chart === 'area' && !s.previous ? areaPath(s.points, xAt, yAt, base) : null,
      }));

  const groups = plotted.length || 1;
  const gap = 2;
  const barWidth = Math.max(1.5, Math.min(24, (band * 0.72 - gap * (groups - 1)) / groups));
  const groupWidth = barWidth * groups + gap * (groups - 1);
  const bars = barMode
    ? plotted.map((s, si) => ({
        id: s.id,
        color: s.color,
        rects: s.points.flatMap((p, i): BarRect[] => {
          if (p.y === null || !Number.isFinite(p.y) || p.y === 0) return [];
          const x = xAt(i) - groupWidth / 2 + si * (barWidth + gap);
          const y1 = yAt(p.y);
          // Çok küçük değer de görünür kalsın.
          const end = Math.abs(y1 - base) < 1 ? base + (p.y > 0 ? -1 : 1) : y1;
          return [{ i, d: barPath(x, barWidth, base, end), x, width: barWidth }];
        }),
      }))
    : [];

  return { n, width, height, left, right, top, bottom, plotted, omitted, yTicks, xTicks, baseline: base, lines, bars, lastIndex: lastPointIndex(plotted), xAt, yAt };
}

/** Parmak konumu → en yakın veri noktası. Grafik dışına taşan parmak uçta kalır. */
export function pickIndex(geom: Pick<ChartGeometry, 'n' | 'width' | 'left' | 'right'>, chart: ChartKind, touchX: number): number | null {
  const { n, width, left, right } = geom;
  if (n <= 0) return null;
  const w = width - left - right;
  if (w <= 0) return null;
  const rel = Math.max(0, Math.min(w, touchX - left));
  const i = chart === 'bar' ? Math.floor(rel / (w / n)) : Math.round((rel / w) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}
