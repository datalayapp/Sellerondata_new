import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { desi } from '@deciship/core/calc';
import type { DimMethod } from '../api/endpoints';
import { fmtDims, fmtNum, fmtTime } from '../lib/format';
import { Badge } from './components';
import type { IconName } from './Icon';
import { colors, font, radius } from './theme';

export type RowStatus = 'SENT' | 'PENDING' | 'SENDING' | 'ERROR';

export type MeasurementRowItem = {
  key: string;
  /** Sunucu kaydı ise id; yalnızca yerelde ise null. */
  serverId: string | null;
  /** Kuyruk kaydı ise clientId. */
  clientId?: string;
  trackingRaw: string;
  l: number;
  w: number;
  h: number;
  kg: number;
  dimMethod: DimMethod;
  measuredAt: string;
  status: RowStatus;
  error?: string | null;
  photoCount: number;
  version?: number;
  /** Yönetici başkasının ölçümünü görürken. */
  byName?: string;
};

/** Kısa yöntem adı (etkin dilde; çalışma anında okunur). */
export const methodShort = (m: DimMethod): string => (m in METHOD_ICON ? i18n.t(`ui.methodShort.${m}`, { ns: 'measure' }) : m);
export const METHOD_ICON: Record<DimMethod, IconName> = { LIDAR: 'cube', AR: 'cube', REFERENCE: 'card', MANUAL: 'ruler', PRESET: 'box' };

export function StatusBadge({ status, style }: { status: RowStatus; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation('measure');
  if (status === 'SENT') return <Badge label={t('ui.status.sent')} kind="success" style={style} />;
  if (status === 'ERROR') return <Badge label={t('ui.status.error')} kind="danger" style={style} />;
  if (status === 'SENDING') return <Badge label={t('ui.status.sending')} kind="info" style={style} />;
  return <Badge label={t('ui.status.queued')} kind="warning" style={style} />;
}

/**
 * D05 yoğun ölçüm satırı. Ardışık satırlar tek kart gibi görünür: `first` üst kenarı, `last` alt kenarı yuvarlatır.
 * Sol: takip no (mono) + ölçü · kg. Sağ: gönderilmediyse durum rozeti, gönderildiyse desi; altında desi/saat.
 */
export function MeasurementRow({
  item,
  desiDivisor,
  onPress,
  first = true,
  last = true,
}: {
  item: MeasurementRowItem;
  desiDivisor: number;
  onPress?: () => void;
  first?: boolean;
  last?: boolean;
}) {
  const { t } = useTranslation('measure');
  const d = fmtNum(desi({ l: item.l, w: item.w, h: item.h }, desiDivisor), 2);
  const meta = [
    `${fmtDims(item.l, item.w, item.h)} · ${fmtNum(item.kg, 2)} kg`,
    methodShort(item.dimMethod),
    item.version && item.version > 1 ? t('ui.edited') : null,
    item.byName ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  const sent = item.status === 'SENT';
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={t('ui.openDetails', { tracking: item.trackingRaw })}
      style={({ pressed }) => [st.row, first && st.first, last && st.last, item.status === 'ERROR' && st.err, pressed && st.pressed]}
    >
      <View style={st.l}>
        <Text style={st.trk} numberOfLines={1}>
          {item.trackingRaw}
        </Text>
        <Text style={st.cap} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <View style={st.r}>
        {sent ? <Text style={st.desi}>{d}</Text> : <StatusBadge status={item.status} style={{ alignSelf: 'flex-end' }} />}
        <Text style={st.cap} numberOfLines={1}>
          {sent ? `${t('ui.desiUnit')} · ${fmtTime(item.measuredAt)}` : `${d} ${t('ui.desiUnit')} · ${fmtTime(item.measuredAt)}`}
        </Text>
      </View>
      {item.status === 'ERROR' && item.error ? (
        <Text style={st.errTxt} numberOfLines={2}>
          {item.error}
        </Text>
      ) : null}
    </Pressable>
  );
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 10,
    minHeight: 56,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    borderBottomColor: colors.borderSoft,
  },
  first: { borderTopWidth: 1, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  last: { borderBottomColor: colors.border, borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
  err: { backgroundColor: '#fffafa' },
  pressed: { backgroundColor: colors.surface2 },
  l: { flex: 1, minWidth: 0, gap: 2 },
  r: { alignItems: 'flex-end', gap: 2, flexShrink: 0, maxWidth: '45%' },
  trk: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.monoSemibold },
  desi: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.monoSemibold },
  cap: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  errTxt: { width: '100%', fontSize: 12, lineHeight: 16, color: colors.danger, marginTop: 4, ...font.regular },
});
