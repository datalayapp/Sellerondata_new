import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './Icon';
import { colors, font, radius, shadow } from './theme';

type ToastOptions = {
  text: string;
  kind?: 'default' | 'success' | 'error';
  icon?: IconName;
  /** Ör. "Geri al". Dokununca bildirim kapanır (eylem bitene dek dönen gösterge). */
  action?: { label: string; onPress: () => Promise<void> | void };
  durationMs?: number;
  /** Süre dolunca ya da yerine yenisi gelince (eyleme dokunulmadıysa) çağrılır. */
  onExpire?: () => void;
};

type Current = ToastOptions & { id: number };

const ToastCtx = createContext<{ show: (o: ToastOptions) => void; hide: () => void } | null>(null);
let seq = 0;

/** Altta, sabit ana eylemin üstünde çıkan tek satırlık bildirim ("Silindi · Geri al"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [cur, setCur] = useState<Current | null>(null);
  const [busy, setBusy] = useState(false);
  const curRef = useRef<Current | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(1)).current;
  const insets = useSafeAreaInsets();

  const close = useCallback(
    (expired: boolean) => {
      const c = curRef.current;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      curRef.current = null;
      if (c && expired) c.onExpire?.();
      Animated.timing(anim, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
        if (!curRef.current) setCur(null);
      });
    },
    [anim],
  );

  const show = useCallback(
    (o: ToastOptions) => {
      if (curRef.current) close(true);
      const next = { ...o, id: ++seq };
      const ms = o.durationMs ?? (o.action ? 6000 : 3500);
      curRef.current = next;
      setBusy(false);
      setCur(next);
      anim.setValue(0);
      progress.setValue(1);
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      Animated.timing(progress, { toValue: 0, duration: ms, useNativeDriver: false }).start();
      timer.current = setTimeout(() => {
        if (curRef.current?.id === next.id) close(true);
      }, ms);
    },
    [anim, close, progress],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onAction = async () => {
    const c = curRef.current;
    if (!c?.action || busy) return;
    // Eyleme dokunuldu: süre dolma davranışı (ör. dosyaları kalıcı silme) artık çalışmasın.
    c.onExpire = undefined;
    if (timer.current) clearTimeout(timer.current);
    progress.stopAnimation();
    setBusy(true);
    try {
      await c.action.onPress();
    } finally {
      setBusy(false);
      if (curRef.current?.id === c.id) close(false);
    }
  };

  const value = useMemo(() => ({ show, hide: () => close(true) }), [show, close]);
  const tone = cur?.kind === 'error' ? colors.danger : cur?.kind === 'success' ? '#9de0bf' : colors.onNightAccent;

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {cur ? (
        <Animated.View
          pointerEvents="box-none"
          style={[
            st.wrap,
            { bottom: insets.bottom + 100, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
          ]}
        >
          <View style={st.box} accessibilityLiveRegion="polite" accessibilityRole="alert">
            <View style={st.row}>
              <Icon name={cur.icon ?? (cur.kind === 'error' ? 'warn' : 'check')} size={20} color={tone} strokeWidth={2.2} />
              <Text style={st.txt} numberOfLines={3}>
                {cur.text}
              </Text>
              {cur.action ? (
                <Pressable
                  onPress={onAction}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={cur.action.label}
                  style={({ pressed }) => [st.act, pressed && { backgroundColor: 'rgba(255,255,255,0.12)' }]}
                >
                  {busy ? <ActivityIndicator color={colors.onNightAccent} size="small" /> : <Icon name="undo" size={18} color={colors.onNightAccent} strokeWidth={2.2} />}
                  <Text style={st.actTxt}>{cur.action.label}</Text>
                </Pressable>
              ) : null}
            </View>
            {cur.action ? (
              <View style={st.track}>
                <Animated.View style={[st.bar, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
              </View>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('ToastProvider eksik');
  return v;
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12 },
  box: { backgroundColor: colors.night, borderRadius: radius.card, overflow: 'hidden', boxShadow: shadow.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 4, minHeight: 52, paddingVertical: 4 },
  txt: { flex: 1, color: '#fff', fontSize: 14, lineHeight: 20, ...font.medium },
  act: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 12, borderRadius: radius.control },
  actTxt: { color: colors.onNightAccent, fontSize: 14, ...font.semibold },
  track: { height: 3, backgroundColor: colors.nightLine },
  bar: { height: 3, backgroundColor: colors.onNightAccent },
});
