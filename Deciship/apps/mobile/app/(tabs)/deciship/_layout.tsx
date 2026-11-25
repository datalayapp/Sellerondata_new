import { useEffect } from 'react';
import { View } from 'react-native';
import { router, Stack, useSegments } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useTranslation } from 'react-i18next';
import { PRODUCTS } from '@sellerondata/contracts';
import { isCaptureRoute } from '../../../src/auth/access';
import { useAuth } from '../../../src/auth/AuthContext';
import { BandContext, Button, EmptyState, Header, Screen } from '../../../src/ui/components';
import { colors } from '../../../src/ui/theme';

export const unstable_settings = { anchor: 'today' };

/**
 * DeciShip: Merkez'den ayrı bir uygulama gibi. Üst çubuk DeciShip kimliğinde (mavi, DeciShip işareti), altında
 * DeciShip'in kendi sekmeleri (Bugün · Geçmiş, `useDeciShipTabs`); Hesap sağ üstteki profil düğmesinden bu yığında açılır.
 * Alttaki uygulama çubuğu sekme katmanında (`(tabs)/_layout`); ölçüm adımları, ölçüm ayrıntısı, düzenleme ve Hesap çubuksuz.
 * Ürün erişimi yoksa anlaşılır durum; ölçüm izni kalktıysa ölçüm adımlarından çıkılır.
 */
/** Ölçüm adımlarında ekran kararmaz (11-B15); adımdan çıkınca (akış bitince) bileşen ayrılır, ekran yine kararabilir. */
function KeepScreenOn() {
  useKeepAwake('deciship-capture', { suppressDeactivateWarnings: true });
  return null;
}

export default function DeciShipLayout() {
  const { t } = useTranslation('auth');
  const { me, access } = useAuth();
  const segments = useSegments();
  const capturing = isCaptureRoute(segments);
  const blocked = access.canUse && !access.canCapture && capturing;

  useEffect(() => {
    if (blocked) router.replace('/deciship/today');
  }, [blocked]);

  if (!access.canUse) {
    return (
      <BandContext.Provider value="deciship">
        <View style={{ flex: 1 }}>
          <Header title={t('access.noToolTitle')} hideTitle />
          <Screen>
            <EmptyState
              icon="lock"
              title={t('access.noToolTitle')}
              text={t('access.noToolText', { org: me?.activeOrg?.name ?? '', product: PRODUCTS.deciship.name })}
              action={<Button label={t('access.openAccount')} kind="secondary" icon="user" onPress={() => router.navigate('/account')} />}
            />
          </Screen>
        </View>
      </BandContext.Provider>
    );
  }

  return (
    <BandContext.Provider value="deciship">
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
          {/* Sekmeler arası geçiş kaydırmasız; ölçüm adımları ve Hesap sağdan gelir. */}
          <Stack.Screen name="today" options={{ animation: 'none' }} />
          <Stack.Screen name="history" options={{ animation: 'none' }} />
        </Stack>
        {capturing && !blocked ? <KeepScreenOn /> : null}
      </View>
    </BandContext.Provider>
  );
}
