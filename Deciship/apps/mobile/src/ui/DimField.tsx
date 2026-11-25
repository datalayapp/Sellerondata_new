import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors, font, radius } from './theme';
import { Icon } from './Icon';
import { fmtNum, parseNum } from '../lib/format';
import { stepDim } from '../lib/dimStep';

type Props = {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
};

const show = (v: number | null) => (v === null ? '' : fmtNum(v, 1, true));

/**
 * Büyük rakamlı ölçü alanı, altında − / + düğmeleri; dokununca 0,1 hassasiyetli klavye.
 * Sınır dışı değer kırpılmaz: geçersiz sayılır (`onChange(null)`), yazılan metin kalır, altında nedeni yazar.
 */
export function DimField({ label, value, onChange, step = 1, min = 0.1, max = 400 }: Props) {
  const { t } = useTranslation('measure');
  const [text, setText] = useState(show(value));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<'max' | 'min' | null>(null);
  const ref = useRef<React.ComponentRef<typeof TextInput>>(null);
  /** Bu alanın son bildirdiği değer: dışarıdan gelen değişikliği (hazır koli, ölçüm) ayırt etmek için. */
  const emitted = useRef<number | null | undefined>(undefined);

  const emit = (v: number | null) => {
    emitted.current = v;
    onChange(v);
  };

  // Değer dışarıdan değişti: metin ona döner, hata temizlenir.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setError(null);
    setText(show(value));
  }, [value]);

  const bump = (dir: 1 | -1) => {
    Haptics.selectionAsync().catch(() => undefined);
    // Son bildirilen değer: hızlı ardışık basışta ekran henüz yenilenmemiş olabilir, basış kaybolmasın (G3).
    const current = emitted.current !== undefined ? emitted.current : value;
    const next = stepDim(current, dir, { step, min, max }, error === 'max');
    setError(null);
    setText(show(next));
    emit(next);
  };

  const commit = (raw: string) => {
    const n = parseNum(raw);
    if (n === null) {
      setError(null);
      emit(null);
      return;
    }
    const r = Math.round(n * 10) / 10;
    if (r > max) {
      setError('max');
      emit(null);
    } else if (r <= 0) {
      setError('min');
      emit(null);
    } else {
      setError(null);
      emit(r);
    }
  };

  const errorText = error === 'max' ? t('ui.maxCm', { max }) : error === 'min' ? t('ui.minCm') : '';

  return (
    <View style={st.col}>
      <Text style={st.lbl} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={() => ref.current?.focus()} style={[st.fld, focused && st.fldOn, error && st.fldErr]}>
        <TextInput
          ref={ref}
          value={text}
          onChangeText={(t) => {
            const clean = t.replace(/[^0-9.,]/g, '');
            setText(clean);
            commit(clean);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Geçerli değer biçimlenir (45,50 → 45,5); geçersiz metin düzeltilsin diye kalır.
            if (!error) setText(show(value));
          }}
          keyboardType="decimal-pad"
          selectTextOnFocus
          placeholder="0"
          placeholderTextColor={colors.placeholder}
          cursorColor={colors.primary}
          selectionColor="rgba(29,91,216,0.25)"
          style={st.input}
          maxLength={6}
          accessibilityLabel={t('ui.cmLabel', { label })}
          accessibilityHint={error ? errorText : undefined}
        />
        <Text style={st.unit}>cm</Text>
      </Pressable>
      <View style={st.step}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('ui.decrease', { label })} onPress={() => bump(-1)} style={({ pressed }) => [st.stepBtn, pressed && st.pressed]}>
          <Icon name="minus" size={22} strokeWidth={2.2} color={colors.text2} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('ui.increase', { label })} onPress={() => bump(1)} style={({ pressed }) => [st.stepBtn, pressed && st.pressed]}>
          <Icon name="plus" size={22} strokeWidth={2.2} color={colors.text2} />
        </Pressable>
      </View>
      {error ? (
        <Text style={st.err} accessibilityLiveRegion="polite">
          {errorText}
        </Text>
      ) : null}
    </View>
  );
}

// D05: 56 dp alan, 24 px rakam; − / + düğmeleri 48 dp (dokunma sınırı).
const st = StyleSheet.create({
  col: { flex: 1, minWidth: 0 },
  lbl: { fontSize: 12, lineHeight: 16, color: colors.text2, marginBottom: 4, ...font.medium },
  fld: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.control,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  fldOn: { borderColor: colors.primary, boxShadow: '0 0 0 1px #1d5bd8' },
  fldErr: { borderColor: colors.danger, boxShadow: '0 0 0 1px #c4271b' },
  err: { fontSize: 12, lineHeight: 16, color: colors.danger, marginTop: 4, ...font.medium },
  input: { fontSize: 24, color: colors.text, textAlign: 'right', minWidth: 32, maxWidth: '76%', padding: 0, ...font.semibold, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 12, color: colors.text2, marginLeft: 3, marginTop: 6, ...font.regular },
  step: { flexDirection: 'row', gap: 6, marginTop: 6 },
  stepBtn: {
    flex: 1,
    height: 48,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
});
