import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, Tabs, useSegments, type ErrorBoundaryProps } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appOf, dockApps, showsDock } from '../../src/auth/access';
import { useAuth } from '../../src/auth/AuthContext';
import { AppDock } from '../../src/ui/AppDock';
import { BandContext, Button, TabBarVisibleContext } from '../../src/ui/components';
import { Icon } from '../../src/ui/Icon';
import { colors, font, radius } from '../../src/ui/theme';

/**
 * Sekme katmanının hata ekranı: bir ekran çökünce beyaz ekran yerine ne olduğunu ve ne yapılacağını söyler.
 * Kök sağlayıcılar ayakta (oturum, kuyruk, taslak); yarım ölçüm diskte saklı. Birincil eylem yeniden dene.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const { t } = useTranslation('common');
  const insets = useSafeAreaInsets();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <View style={[crash.root, { paddingTop: 16 + insets.top, paddingBottom: 16 + insets.bottom }]}>
      <View style={crash.icon}>
        <Icon name="warn" size={24} color={colors.danger} strokeWidth={2} />
      </View>
      <Text style={crash.title} accessibilityRole="header">
        {t('crash.title')}
      </Text>
      <Text style={crash.text}>{t('crash.text')}</Text>
      <Button label={t('crash.retry')} icon="sync" onPress={() => void retry()} large />
      <Button
        label={t('crash.home')}
        kind="ghost"
        // Önce sekmeler yeniden çizilir (gezgin yerinde olsun), sonra Bugün'e geçilir.
        onPress={() => void retry().then(() => router.replace('/deciship/today'))}
      />
    </View>
  );
}

const crash = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', gap: 10, paddingHorizontal: 16, backgroundColor: colors.bg },
  icon: { alignSelf: 'center', width: 48, height: 48, borderRadius: radius.control, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, lineHeight: 24, color: colors.text, textAlign: 'center', ...font.semibold },
  text: { fontSize: 14, lineHeight: 20, color: colors.text2, textAlign: 'center', marginBottom: 6, ...font.regular },
});

/**
 * Uygulama katmanı: Merkez ve araçlar birer sekme ekranı; alttaki çubuk sekme düğmeleri yerine uygulama geçiş çubuğu
 * (`AppDock`: Merkez · DeciShip · OrderLoom · TagPress). Her uygulamanın kendi bölümleri üst çubuktaki sekmelerde,
 * Hesap üst çubuktaki profil düğmesinde (`Header`). Çubuk yalnız ana ekranlarda (`showsDock`); ölçüm adımları,
 * kayıt ekranları ve Hesap çubuksuz. Geri tuşu uygulamanın içinde yığını boşaltır, sonra önceki uygulamaya döner
 * (`backBehavior="history"`; geçmişte her sekme bir kez durur, yığın büyümez).
 */
export default function TabsLayout() {
  const { me, tabs } = useAuth();
  const segments = useSegments();
  const showBar = showsDock(tabs, segments);
  const apps = dockApps(me, appOf(segments));
  return (
    <BandContext.Provider value="hub">
      <TabBarVisibleContext.Provider value={showBar}>
        <Tabs
          backBehavior="history"
          tabBar={(props) => (showBar ? <AppDock apps={apps} nav={props} /> : null)}
          screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, lazy: true }}
        >
          <Tabs.Screen name="hub" />
          <Tabs.Screen name="deciship" />
          {/* Hesap: üst çubuktaki profil düğmesinden açılır, geri ile dönülür. */}
          <Tabs.Screen name="account" />
        </Tabs>
      </TabBarVisibleContext.Provider>
    </BandContext.Provider>
  );
}
