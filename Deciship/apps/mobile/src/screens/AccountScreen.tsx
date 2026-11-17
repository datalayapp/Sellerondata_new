import { Alert, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { deviceLabel, supportMailto, versionLabel } from '../lib/supportMail';
import { homeHref } from '../auth/access';
import { goAfterOrgSwitch } from '../lib/navigation';
import { LangPicker, OrgRows } from '../hub/ui';
import { useQueue } from '../queue/QueueContext';
import { Button, Card, Header, initialsOf, Screen, useBand } from '../ui/components';
import { useToast } from '../ui/Toast';
import { colors, font, space } from '../ui/theme';
import { APP_VERSION, BUILD, VERSION_KNOWN } from '../version/client';

/** "1.1.0 (2)"; okunamadıysa null (ekranda ve e-postada yazılmaz). */
const VERSION = VERSION_KNOWN ? versionLabel(APP_VERSION, BUILD) : null;

export default function Account() {
  const { t } = useTranslation('auth');
  const { me, logout, changeLocale, localePending } = useAuth();
  const band = useBand().key;
  const { pending, errors, others, deletableOthers, purgeOtherSessions } = useQueue();
  const askAdmin = others.total - deletableOthers;
  const toast = useToast();
  const unsent = pending + errors;

  const confirmLogout = () => {
    Alert.alert(t('account.logoutTitle'), unsent > 0 ? t('account.logoutPending', { count: unsent }) : t('account.logoutConfirm'), [
      { text: t('account.cancel'), style: 'cancel' },
      { text: t('account.logout'), onPress: () => logout() },
    ]);
  };

  const confirmPurge = () => {
    Alert.alert(t('others.purgeTitle'), t('others.purgeConfirm', { count: deletableOthers }), [
      { text: t('account.cancel'), style: 'cancel' },
      {
        text: t('others.purgeAction'),
        style: 'destructive',
        onPress: async () => {
          const n = await purgeOtherSessions();
          toast.show({ text: t('others.purged', { count: n }), kind: 'success' });
        },
      },
    ]);
  };

  const initials = initialsOf(me?.person.name);
  const contact = [me?.person.phone, me?.person.email].filter(Boolean).join(' · ');
  const tc = (key: string, o?: Record<string, unknown>) => t(key, { ns: 'common', ...o });
  const device = deviceLabel(Platform);
  // Destek "hangi sürüm, hangi telefon?" diye sormasın (11-B16).
  const mailSupport = () =>
    void Linking.openURL(
      supportMailto(
        [tc('support.title'), me?.activeOrg?.name],
        [VERSION ? tc('support.version', { version: VERSION }) : null, device ? tc('support.device', { device }) : null],
      ),
    );

  return (
    <View style={{ flex: 1 }}>
      {/* Üst çubuktaki profil düğmesinden açılır: geri geldiği ekrana döner; geçmiş yoksa açılış ekranına. */}
      <Header title={t('account.title')} back onBack={() => (router.canGoBack() ? router.back() : router.navigate(homeHref(me)))} />
      <Screen>
        <View style={st.who}>
          <View style={st.av} accessible={false}>
            <Text style={st.avTxt}>{initials}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={st.name} numberOfLines={2}>
              {me?.person.name}
            </Text>
            {contact ? <Text style={st.contact}>{contact}</Text> : null}
          </View>
        </View>

        <View style={st.group}>
          <Text style={st.section}>{t('account.company')}</Text>
          <OrgRows orgs={me?.orgs ?? []} activeId={me?.activeOrg?.id ?? null} onSwitched={(next) => goAfterOrgSwitch(next ?? me, band === 'deciship' ? 'deciship' : 'hub')} />
          {(me?.orgs.length ?? 0) > 1 ? <Text style={st.hint}>{t('account.switchHint')}</Text> : null}
        </View>

        {others.total > 0 ? (
          <View style={st.group}>
            <Text style={st.section}>{t('others.sectionTitle')}</Text>
            <Card style={{ gap: 8, padding: 12 }}>
              <Text style={st.sessions}>{t('others.count', { count: others.total })}</Text>
              <Text style={st.hint}>{t('others.sectionHint')}</Text>
              {askAdmin > 0 ? <Text style={st.hint}>{t('others.askAdmin', { count: askAdmin })}</Text> : null}
              {deletableOthers > 0 ? (
                <>
                  <Text style={st.hint}>{t('others.canDeleteHint', { count: deletableOthers })}</Text>
                  <Button label={t('others.purgeOpen')} kind="danger" icon="trash" onPress={confirmPurge} />
                </>
              ) : null}
            </Card>
          </View>
        ) : null}

        <View style={st.group}>
          <Text style={st.section}>{t('support.title', { ns: 'common' })}</Text>
          <Button label={tc('support.sub')} kind="secondary" icon="send" onPress={mailSupport} />
        </View>

        <View style={st.group}>
          <LangPicker
            variant="row"
            onChange={(locale) => {
              void changeLocale(locale).then((result) => {
                if (result === 'rejected') toast.show({ text: t('account.languageFailed'), kind: 'error' });
              });
            }}
          />
          {localePending ? <Text style={st.hint}>{t('account.languagePending')}</Text> : null}
        </View>

        <Button label={t('account.logout')} kind="danger" icon="logout" onPress={confirmLogout} style={{ marginTop: space.md }} />
        {VERSION ? <Text style={st.version}>{tc('support.version', { version: VERSION })}</Text> : null}
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  who: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: 2 },
  av: { width: 48, height: 48, borderRadius: 6, backgroundColor: colors.night, alignItems: 'center', justifyContent: 'center' },
  avTxt: { fontSize: 16, lineHeight: 22, color: colors.onNight, ...font.semibold },
  name: { fontSize: 16, lineHeight: 22, color: colors.text, ...font.semibold },
  contact: { fontSize: 13, lineHeight: 18, color: colors.text2, ...font.regular },
  group: { gap: space.sm },
  section: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  sessions: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
  hint: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  version: { fontSize: 12, lineHeight: 17, color: colors.text3, textAlign: 'center', ...font.regular },
});
