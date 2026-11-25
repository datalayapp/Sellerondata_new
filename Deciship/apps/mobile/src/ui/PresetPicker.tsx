import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoxPreset } from '../api/endpoints';
import { fmtNum } from '../lib/format';
import { Icon } from './Icon';
import { colors, font, radius } from './theme';

/** Hazır koli seçimi: tek dokunuşla üç ölçü. */
export function PresetPicker({ presets, selectedId, onPick }: { presets: BoxPreset[]; selectedId: string | null; onPick: (p: BoxPreset) => void }) {
  const { t } = useTranslation('measure');
  return (
    <View style={st.chips}>
      {presets.map((p) => {
        const sel = selectedId === p.id;
        return (
          <Pressable
            key={p.id}
            onPress={() => onPick(p)}
            style={({ pressed }) => [st.chip, pressed && st.chipPressed, sel && st.chipSel]}
            accessibilityRole="radio"
            accessibilityState={{ selected: sel }}
            accessibilityLabel={t('ui.presetLabel', { name: p.name })}
          >
            <View style={st.chipTop}>
              <Text style={[st.chipT, sel && { color: colors.primary }]} numberOfLines={1}>
                {p.name}
              </Text>
              {sel ? <Icon name="check" size={16} color={colors.primary} strokeWidth={2.6} /> : null}
            </View>
            <Text style={st.chipS} numberOfLines={1}>
              {fmtNum(p.lengthCm, 1, true)}×{fmtNum(p.widthCm, 1, true)}×{fmtNum(p.heightCm, 1, true)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 52,
    flexBasis: '30%',
    flexGrow: 1,
    maxWidth: '31.75%',
    justifyContent: 'center',
  },
  chipPressed: { backgroundColor: colors.surface2 },
  chipSel: { borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.primarySoft, paddingHorizontal: 7, paddingVertical: 5 },
  chipTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
  chipT: { fontSize: 14, lineHeight: 19, color: colors.text, flexShrink: 1, ...font.semibold },
  chipS: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 1, ...font.mono },
});
