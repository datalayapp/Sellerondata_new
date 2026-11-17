import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type AccessibilityActionEvent, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { colors, font, mono } from '../ui/theme';
import { AXIS_COLOR, buildChart, GRID_COLOR, pickIndex, type ChartKind } from './chart';
import type { HubSeries, HubValueFormat } from './contracts';
import { axisValue, dayMonth, hubValue } from './format';
import { useHub } from './HubContext';

/**
 * Çizgi, alan ve çubuk grafik. Parmağın altında kalan yüzen kutu yerine grafiğin üstünde sabit bir okuma alanı var:
 * dokununca değer burada okunur, yerleşim oynamaz. Okuma alanı aynı zamanda lejanttır.
 */
export function TimeSeries({
  series,
  chart,
  format,
  currency,
  height = 180,
  label,
}: {
  series: readonly HubSeries[];
  chart: ChartKind;
  format: HubValueFormat;
  currency?: string;
  height?: number;
  label: string;
}) {
  const { t } = useTranslation('hub');
  const { fmt, lng } = useHub();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const geom = useMemo(() => buildChart({ series, chart, width, height }), [series, chart, width, height]);
  const { n, plotted, lastIndex } = geom;
  const shown = selected !== null && selected < n ? selected : lastIndex;
  const active = selected !== null && selected < n;
  const main = plotted.find((s) => !s.previous) ?? plotted[0];
  const moved = useRef(false);
  const before = useRef<number | null>(null);

  const pick = (e: GestureResponderEvent) => {
    const i = pickIndex(geom, chart, e.nativeEvent.locationX);
    if (i !== null) setSelected(i);
  };
  const a11yStep = (e: AccessibilityActionEvent) => {
    if (n === 0) return;
    const cur = shown < 0 ? n - 1 : shown;
    const next = e.nativeEvent.actionName === 'increment' ? cur + 1 : cur - 1;
    setSelected(Math.max(0, Math.min(n - 1, next)));
  };

  const dateText = shown >= 0 ? dayMonth(main?.points[shown]?.x ?? '', lng) : '';
  const rows = plotted.map((s) => {
    const p = shown >= 0 ? s.points[shown] : undefined;
    const ownDate = s.previous && p?.x && p.x !== main?.points[shown]?.x ? dayMonth(p.x, lng) : null;
    return { id: s.id, color: s.color, label: ownDate ? `${s.label} · ${ownDate}` : s.label, value: hubValue({ value: p?.y ?? null, format, currency }, fmt) };
  });

  return (
    <View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t('chart.a11y', { label })}
        accessibilityValue={{ text: [dateText, ...rows.map((r) => `${r.label} ${r.value}`)].join(', ') }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={a11yStep}
      >
        <View style={st.readout}>
          <Text style={st.readoutDate}>{active ? dateText : t('chart.last', { date: dateText })}</Text>
          {rows.map((r) => (
            <View key={r.id} style={st.readoutRow}>
              <View style={[chart === 'line' ? st.keyLine : st.keyBox, { backgroundColor: r.color }]} />
              <Text style={st.readoutLabel} numberOfLines={1}>
                {r.label}
              </Text>
              <Text style={st.readoutValue} numberOfLines={1}>
                {r.value}
              </Text>
            </View>
          ))}
        </View>
        <View
          style={{ height }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => n > 0}
          onMoveShouldSetResponder={() => n > 0}
          onResponderTerminationRequest={() => true}
          onResponderGrant={(e) => {
            moved.current = false;
            before.current = selected;
            pick(e);
          }}
          onResponderMove={(e) => {
            moved.current = true;
            pick(e);
          }}
          onResponderRelease={(e) => {
            // Aynı noktaya ikinci dokunuş seçimi kaldırır, okuma son değere döner.
            if (!moved.current && before.current === pickIndex(geom, chart, e.nativeEvent.locationX)) setSelected(null);
          }}
        >
          {width > 0 && n > 0 ? (
            <View pointerEvents="none">
              <Svg width={width} height={height}>
                {geom.yTicks.map((tick) => (
                  <G key={tick.value}>
                    <Line x1={geom.left} x2={width - geom.right} y1={tick.y} y2={tick.y} stroke={tick.value === 0 ? AXIS_COLOR : GRID_COLOR} strokeWidth={1} />
                    <SvgText x={geom.left - 6} y={tick.y + 4} fontSize={11} fontFamily={mono} fill={colors.text3} textAnchor="end">
                      {axisValue(tick.value, format, fmt)}
                    </SvgText>
                  </G>
                ))}
                {geom.xTicks.map((tick) => (
                  <SvgText key={tick.i} x={tick.x} y={height - 6} fontSize={11} fontFamily={mono} fill={colors.text3} textAnchor={tick.anchor}>
                    {dayMonth(main?.points[tick.i]?.x ?? '', lng)}
                  </SvgText>
                ))}

                {geom.bars.map((b) => (
                  <G key={b.id}>
                    {b.rects.map((r) => (
                      <Path key={r.i} d={r.d} fill={b.color} opacity={!active || selected === r.i ? 1 : 0.5} />
                    ))}
                  </G>
                ))}

                {/* Önceki dönem altta kalır, güncel çizgi üstte. */}
                {[...geom.lines]
                  .sort((a, b) => Number(b.previous) - Number(a.previous))
                  .map((l) => (
                    <G key={l.id}>
                      {l.area ? <Path d={l.area} fill={l.color} opacity={0.1} /> : null}
                      <Path d={l.line} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    </G>
                  ))}

                {chart !== 'bar' && active ? <Line x1={geom.xAt(shown)} x2={geom.xAt(shown)} y1={geom.top} y2={geom.baseline} stroke={colors.borderHover} strokeWidth={1} /> : null}
                {chart !== 'bar' && shown >= 0
                  ? plotted.map((s) => {
                      const y = s.points[shown]?.y;
                      if (y === null || y === undefined || (!active && s.previous)) return null;
                      return (
                        <G key={s.id}>
                          <Circle cx={geom.xAt(shown)} cy={geom.yAt(y)} r={6} fill={colors.surface} />
                          <Circle cx={geom.xAt(shown)} cy={geom.yAt(y)} r={4} fill={s.color} />
                        </G>
                      );
                    })
                  : null}
              </Svg>
            </View>
          ) : null}
        </View>
      </View>
      {geom.omitted > 0 ? <Text style={st.omitted}>{t('chart.omitted')}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  readout: { gap: 2, marginBottom: 8 },
  readoutDate: { fontSize: 13, lineHeight: 18, color: colors.text3, ...font.medium },
  readoutRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  keyLine: { width: 14, height: 2, borderRadius: 1 },
  keyBox: { width: 10, height: 10, borderRadius: 2 },
  readoutLabel: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: colors.text2, ...font.regular },
  readoutValue: { fontSize: 15, lineHeight: 20, color: colors.text, ...font.monoSemibold },
  omitted: { fontSize: 12, lineHeight: 16, color: colors.text3, marginTop: 4, ...font.regular },
});
