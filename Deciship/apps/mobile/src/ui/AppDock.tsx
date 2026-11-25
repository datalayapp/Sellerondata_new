import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { PRODUCT_PALETTE, PRODUCTS } from '@sellerondata/contracts';
import { isDockUsable, type AppKey, type DockApp } from '../auth/access';
import { getServerUrl } from '../api/client';
import { ProductMark } from '../hub/glyphs';
import { webOriginFor } from '../hub/links';
import { MOBILE_TOOLS } from '../tools/registry';
import { APP_ENV } from '../version/client';
import { SellerOnDataMark } from './BrandMark';
import { useKeyboardVisible } from './components';
import { colors, font, hubColors } from './theme';

/** Hücre renkleri: üst çizgi, açık ton zemin, etiket. Merkez SellerOnData lacivertinde; araç paletten, palette yoksa katalog rengi. */
function toneOf(key: AppKey): { line: string; soft: string; text: string } {
  if (key === 'hub') return { line: hubColors.ink, soft: hubColors.inkSoft, text: hubColors.ink };
  const p = (PRODUCT_PALETTE as Partial<Record<string, { main: string; soft: string; text: string }>>)[key];
  return p ? { line: p.main, soft: p.soft, text: p.text } : { line: PRODUCTS[key].color, soft: colors.surface2, text: colors.text };
}

/** Sekme gezginindeki rota adı: Merkez `hub`, mobil ekranı olan araç kendi anahtarı. */
const routeOf = (key: AppKey): string | null => (key === 'hub' ? 'hub' : MOBILE_TOOLS[key]?.href ? key : null);

/**
 * Alttaki uygulama geçiş çubuğu (tasarım A3 "Üstte kalın çizgi"): Merkez · DeciShip · OrderLoom · TagPress.
 * Açık uygulamanın hücresinde üstte kendi renginde 3 dp çizgi, aşağı doğru solan açık ton zemin, kalın etiket.
 * Hazır olmayan ve erişilmeyen soluk, dokunulmaz. Mobil ekranı olmayan ama erişimi olan araç web'de açılır.
 * Sekme geçişi gezginin kendi yoluyla: uygulamanın yığını yerinde kalır; açık uygulamaya yeniden dokunmak yığını başa alır (Bugün).
 * Görünürlük `(tabs)/_layout` içinde (`showsDock`); klavye açıkken çizilmez.
 */
export function AppDock({ apps, nav }: { apps: DockApp[]; nav: Pick<BottomTabBarProps, 'state' | 'emitter' | 'navigateToTab'> }) {
  const { t } = useTranslation('auth');
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  if (keyboard) return null;

  const open = (app: DockApp) => {
    if (app.state === 'web') {
      if (app.key === 'hub') return;
      const origin = webOriginFor({ envOrigin: process.env.EXPO_PUBLIC_WEB_ORIGIN, development: APP_ENV === 'development', serverUrl: getServerUrl() });
      void Linking.openURL(`${origin}${PRODUCTS[app.key].basePath}`).catch(() => undefined);
      return;
    }
    const name = routeOf(app.key);
    const route = name ? nav.state.routes.find((r) => r.name === name) : undefined;
    if (!route) return;
    const focused = nav.state.routes[nav.state.index]?.key === route.key;
    // Gezginin kendi sekme basışı: odaktaki sekmede iç yığın başa döner (DeciShip Geçmiş → Bugün).
    const event = nav.emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) nav.navigateToTab(route.key);
  };

  return (
    <View style={[st.bar, { paddingBottom: insets.bottom }]} accessibilityRole="tablist" accessibilityLabel={t('dock.label')}>
      {apps.map((app) => {
        const usable = isDockUsable(app);
        const tone = toneOf(app.key);
        const name = app.key === 'hub' ? t('tabs.hub') : PRODUCTS[app.key].name;
        const note = app.state === 'soon' ? t('dock.soon') : app.state === 'no_access' ? t('dock.noAccess') : app.state === 'web' ? t('dock.openWeb') : null;
        return (
          <Pressable
            key={app.key}
            accessibilityRole="tab"
            accessibilityLabel={note ? `${name}, ${note}` : name}
            accessibilityState={{ selected: app.here, disabled: !usable }}
            disabled={!usable}
            onPress={() => open(app)}
            style={({ pressed }) => [st.item, !usable && st.off, pressed && !app.here && { backgroundColor: colors.surface2 }]}
          >
            {app.here ? (
              <>
                <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" accessible={false} pointerEvents="none">
                  <Defs>
                    <LinearGradient id={`dock-${app.key}`} x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor={tone.soft} />
                      <Stop offset="0.85" stopColor={colors.surface} />
                    </LinearGradient>
                  </Defs>
                  <Rect width="100%" height="100%" fill={`url(#dock-${app.key})`} />
                </Svg>
                <View style={[st.line, { backgroundColor: tone.line }]} />
              </>
            ) : null}
            {app.key === 'hub' ? <SellerOnDataMark size={24} /> : <ProductMark product={app.key} size={24} />}
            <Text style={[st.label, app.here ? [st.labelOn, { color: tone.text }] : null]} numberOfLines={1}>
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  // D05: beyaz çubuk, 1 px üst çizgi; hücreler eşit genişlik, ≥48 dp.
  bar: { flexDirection: 'row', backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1 },
  item: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 3, paddingTop: 8, paddingBottom: 5, overflow: 'hidden' },
  off: { opacity: 0.38 },
  line: { position: 'absolute', top: 0, left: 8, right: 8, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  label: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  labelOn: font.bold,
});
