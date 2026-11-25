import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { activeOrgs } from '../../src/auth/access';
import { useAuth } from '../../src/auth/AuthContext';
import { OrgRows } from '../../src/hub/ui';
import { Button, EmptyState, Header, OverflowMenu, Screen } from '../../src/ui/components';
import { OtherSessionsBanner } from '../../src/ui/OtherSessionsBanner';
import { colors, font } from '../../src/ui/theme';

/** Girişten sonra firma seçimi. Seçim yapılınca kök yerleşim uygulamaya geçirir. Çıkış nadir: ⋯ menüsünde. */
export default function SelectOrg() {
  const { t } = useTranslation('auth');
  const { me, logout } = useAuth();
  const hasChoice = activeOrgs(me).length > 0;
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={t('org.title')}
        right={<OverflowMenu onNight items={[{ label: t('account.logout'), icon: 'logout', danger: true, onPress: () => void logout() }]} />}
      />
      <Screen>
        {hasChoice ? (
          <>
            <Text style={st.lead}>{t('org.lead')}</Text>
            {/* Henüz seçim yapılmadı: hiçbir firma "Etkin" görünmez. */}
            <OrgRows orgs={me?.orgs ?? []} activeId={null} />
          </>
        ) : (
          <EmptyState
            icon="info"
            title={t('org.emptyTitle')}
            text={t('org.emptyText')}
            action={<Button small kind="secondary" icon="logout" label={t('account.logout')} onPress={() => void logout()} />}
          />
        )}
        <OtherSessionsBanner />
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  lead: { fontSize: 13, lineHeight: 18, color: colors.text2, ...font.regular },
});
