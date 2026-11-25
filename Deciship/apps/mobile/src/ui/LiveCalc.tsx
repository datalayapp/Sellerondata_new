import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { baremNote } from '@deciship/core/barem';
import { useTranslation } from 'react-i18next';
import { colors, font, radius } from './theme';
import { Icon } from './Icon';
import { fmtNum, showDecimal } from '../lib/format';
import { computeLive, VOLUMETRIC_DIVISOR, type LiveCalcInput } from '../lib/liveCalc';

export { computeLive };

type Props = LiveCalcInput;

/**
 * Canlı desi / hacimsel / gerçek / ücretlenecek gösterimi. Fiyat yok.
 * `barem`: ücretli ağırlık bir basamağı az farkla aşıyorsa tek satır bilgi notu (ölçü ve özet ekranı).
 * Çalışan tarife basamaklarını görmez; taşıyıcılarda yaygın basamak (20 kg'a kadar 0,5, üstü 1 kg) kullanılır.
 */
/** 6 → "6,0", 0.05 → "0,05" (çekirdekteki baremText ile aynı biçim; TR'de virgül). */
const kgText = (n: number): string => {
  const s = Number(n.toFixed(3)).toString();
  return showDecimal((s.includes('.') ? s : s + '.0').replace('.', ','));
};

/** `extra`: kutunun altına eklenen kısa satır (ör. ambalaj bilgisi). */
export function LiveCalc({ barem, extra, ...props }: Props & { barem?: boolean; extra?: ReactNode }) {
  const { t } = useTranslation('measure');
  const r = computeLive(props);
  const note =
    barem && r && props.kg
      ? baremNote({ dims: { l: props.l!, w: props.w!, h: props.h! }, actualKg: props.kg, divisor: VOLUMETRIC_DIVISOR })
      : null;
  return (
    <View style={st.box} accessibilityLabel={t('calc.chargeable')}>
      <Row label={t('calc.desi', { divisor: props.desiDivisor })} value={r ? fmtNum(r.desi, 2) : '–'} />
      <Row label={t('calc.volumetricKg')} value={r ? fmtNum(r.volumetric, 2) : '–'} on={r?.basis === 'VOLUMETRIC'} />
      <Row label={t('calc.actualKg')} value={props.kg !== null ? fmtNum(props.kg, 2) : '–'} on={r?.basis === 'ACTUAL'} />
      <View style={st.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={st.headL}>{t('calc.chargeable')}</Text>
          <Text style={st.headS}>{r ? (r.basis === 'VOLUMETRIC' ? t('calc.basisVolumetric') : t('calc.basisActual')) : t('calc.enterDims')}</Text>
        </View>
        <Text style={[st.big, !r && { color: colors.placeholder }]} numberOfLines={1}>
          {r ? fmtNum(r.chargeable, 2) : '–'}
          <Text style={st.bigU}> kg</Text>
        </Text>
      </View>
      {note ? (
        <View style={st.note} accessibilityRole="text">
          <Icon name="info" size={14} color={colors.warningInk} strokeWidth={2} />
          <Text style={st.noteTxt}>{t('calc.baremOver', { boundary: kgText(note.boundaryKg), over: kgText(note.overKg) })}</Text>
        </View>
      ) : null}
      {extra}
    </View>
  );
}

/** `.cr` satırı: solda etiket, sağda değer. Esas alınan ağırlık mavi. */
function Row({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <View style={st.row}>
      <Text style={[st.lbl, on && { color: colors.primaryHover }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[st.val, on && { color: colors.primaryHover }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  box: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  lbl: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  val: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold, fontVariant: ['tabular-nums'] },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 },
  headL: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
  headS: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  big: { fontSize: 24, lineHeight: 28, color: colors.primaryHover, ...font.semibold, fontVariant: ['tabular-nums'] },
  bigU: { fontSize: 14, color: colors.text2, ...font.regular },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginHorizontal: 10, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.control, backgroundColor: colors.warningBg },
  noteTxt: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.warningInk, ...font.regular },
});
