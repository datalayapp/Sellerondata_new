import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors, font, radius } from './theme';
import { Icon } from './Icon';
import { showDecimal } from '../lib/format';
import { numKeyUpdater, type NumKey } from '../lib/numKey';

const KEYS: readonly NumKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'del'];

/**
 * Büyük sayısal tuş takımı. Değer Türkçe ondalık (virgül) ile metin olarak tutulur.
 * `onChange` işlevsel güncelleme alır (ör. `useState` ayarlayıcısı): her basış bir öncekinin sonucuna uygulanır,
 * hızlı basışta rakam kaybolmaz (G3). Değeri ekran kendisi gösterir.
 */
export function NumPad({
  onChange,
  maxDecimals = 2,
  maxLength = 7,
  compact = false,
}: {
  onChange: (update: (prev: string) => string) => void;
  maxDecimals?: number;
  maxLength?: number;
  /** Kısa ekranlarda daha alçak tuşlar (yine ≥ 52 px dokunma alanı). */
  compact?: boolean;
}) {
  const { t } = useTranslation('measure');
  const press = (k: NumKey) => {
    Haptics.selectionAsync().catch(() => undefined);
    onChange(numKeyUpdater(k, { maxDecimals, maxLength }));
  };
  return (
    <View style={st.pad}>
      {KEYS.map((k) => (
        <Pressable
          key={k}
          onPress={() => press(k)}
          onLongPress={k === 'del' ? () => onChange(() => '') : undefined}
          accessibilityRole="button"
          accessibilityLabel={k === 'del' ? t('ui.delKey') : k === ',' ? t('ui.commaKey') : k}
          style={({ pressed }) => [st.key, compact && st.keyCompact, (k === 'del' || k === ',') && st.fn, pressed && st.pressed]}
        >
          {k === 'del' ? <Icon name="backspace" size={26} color={colors.text2} strokeWidth={1.9} /> : <Text style={[st.txt, k === ',' && st.comma]}>{showDecimal(k)}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

// D05: 3 sütun, 6 dp ara, r6. Tuşlar büyük (56 dp; kısa ekranda 52 dp), eldivenle de basılır.
const st = StyleSheet.create({
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: {
    width: '31.5%',
    flexGrow: 1,
    height: 56,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyCompact: { height: 52 },
  fn: { backgroundColor: colors.surface2 },
  pressed: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  txt: { fontSize: 24, color: colors.text, ...font.medium, fontVariant: ['tabular-nums'] },
  comma: { fontSize: 28, lineHeight: 32 },
});
