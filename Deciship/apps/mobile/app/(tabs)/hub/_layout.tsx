import { ActivityIndicator, View } from 'react-native';
import { router, Slot, usePathname, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../src/auth/AuthContext';
import { scopeKey } from '../../../src/auth/token';
import { canSeeHub } from '../../../src/hub/access';
import { HubProvider, useHub } from '../../../src/hub/HubContext';
import { APP_ROUTES } from '../../../src/hub/links';
import { Button, EmptyState, Header } from '../../../src/ui/components';
import { colors, hubColors } from '../../../src/ui/theme';

// Telefonda Merkez üç bölüm: Genel Bakış · Etkinlik · Ekip. Analiz web'de (Genel Bakış'taki kart açar).
type SectionKey = 'overview' | 'activity' | 'team';
const PATH: Record<SectionKey, string> = { overview: APP_ROUTES.overview, activity: APP_ROUTES.activity, team: APP_ROUTES.team };

function Gate() {
  const { t } = useTranslation('hub');
  const { boot, me, refreshMe, canTeam } = useHub();
  const pathname = usePathname();

  if (boot === 'loading') {
    return (
      <View style={{ flex: 1 }}>
        <Header title={t('title')} hideTitle />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
          <ActivityIndicator color={hubColors.ink} size="large" />
        </View>
      </View>
    );
  }
  if (boot === 'failed') {
    return (
      <View style={{ flex: 1 }}>
        <Header title={t('title')} hideTitle />
        <View style={{ padding: 16 }}>
          <EmptyState icon="cloudoff" title={t('boot.title')} text={t('boot.body')} action={<Button small kind="secondary" icon="sync" label={t('error.retry')} onPress={() => void refreshMe()} />} />
        </View>
      </View>
    );
  }
  if (boot === 'denied' || !me || !canSeeHub(me)) {
    return (
      <View style={{ flex: 1 }}>
        <Header title={t('title')} hideTitle />
        <View style={{ padding: 16 }}>
          <EmptyState icon="lock" title={t('denied.title')} text={t('denied.body')} />
        </View>
      </View>
    );
  }

  const current: SectionKey = pathname.endsWith('/activity') ? 'activity' : pathname.endsWith('/team') ? 'team' : 'overview';
  // Etkinlik Merkez'i gören herkese (web `canSeeActivity` = yönetici ya da rapor izni = `canSeeHub`). Ekip yalnız yöneticiye.
  const items: { key: SectionKey; label: string }[] = [
    { key: 'overview', label: t('nav.overview') },
    { key: 'activity', label: t('nav.activity') },
    ...(canTeam ? [{ key: 'team' as const, label: t('nav.team') }] : []),
  ];

  // Bölümler bantta sekme (web bandı gibi); üst kısım sabit, içerik altında kayar. Tek bölüm varsa sekme yok.
  const tabs = items.length > 1 ? { items, value: current, onChange: (key: SectionKey) => router.replace(PATH[key] as Href), label: t('nav.label') } : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={me.activeOrg?.name ?? t('title')} subtitleMono={false} tabs={tabs} />
      <View style={{ flex: 1 }}>
        <Slot />
      </View>
    </View>
  );
}

/** Merkez sekmesi kökü. Sekme düzeni olmadan da `/hub` adresiyle tek başına açılır. */
export default function HubLayout() {
  // Oturum veya firma değişince bellekteki veri eski firmadan kalmasın.
  const { scope } = useAuth();
  return (
    <HubProvider key={scopeKey(scope) ?? 'none'}>
      <Gate />
    </HubProvider>
  );
}
