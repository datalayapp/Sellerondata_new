import '../src/i18n';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, StyleSheet, Text, View } from 'react-native';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { QueueProvider } from '../src/queue/QueueContext';
import { DraftProvider } from '../src/draft/DraftContext';
import { ToastProvider } from '../src/ui/Toast';
import { Button, EmptyState, Screen } from '../src/ui/components';
import { Icon } from '../src/ui/Icon';
import { colors, font, radius } from '../src/ui/theme';
import { getCapabilities } from '../src/measure/boxMeasure';
import { fetchClientPolicy } from '../src/api/client';
import { checkPolicy, loadUpgradeFlag, onUpgradeChange } from '../src/version/policy';
import { UpdateRequired, useUpgradeState } from '../src/ui/UpdateRequired';

function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

/** Oturum var, profil hiç okunamadı ve önbellekte yok: izinler bilinmeden uygulama açılmaz. */
function ProfileGate() {
  const { t } = useTranslation('auth');
  const { profileFailed, refreshProfile, logout } = useAuth();
  if (!profileFailed) return <Loading />;
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
      <Screen scroll={false} style={{ justifyContent: 'center' }}>
        <EmptyState
          icon="cloudoff"
          title={t('profile.failedTitle')}
          text={t('profile.failedText')}
          action={<Button label={t('profile.retry')} icon="sync" onPress={() => refreshProfile()} />}
        />
        <Button label={t('account.logout')} kind="ghost" onPress={() => logout()} />
      </Screen>
    </View>
  );
}

/**
 * Son çare hata ekranı (expo-router): kök düzen çökünce sağlayıcılar da gider. Bu yüzden burada sağlayıcıya bağlı
 * kanca (useAuth, useSafeAreaInsets) yok; düz görünüm ve sabit dolgu. Metin i18n'den (kökte yan etkiyle yüklü).
 * Yarım ölçüm diskte saklı olduğu için bu ekran veri kaybettirmez.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const { t } = useTranslation('common');
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <View style={crash.root}>
      <StatusBar style="dark" />
      <View style={crash.icon}>
        <Icon name="warn" size={24} color={colors.danger} strokeWidth={2} />
      </View>
      <Text style={crash.title} accessibilityRole="header">
        {t('crash.title')}
      </Text>
      <Text style={crash.text}>{t('crash.text')}</Text>
      <Button label={t('crash.retry')} icon="sync" onPress={() => void retry()} large />
    </View>
  );
}

const crash = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 48, paddingBottom: 32, backgroundColor: colors.bg },
  icon: { alignSelf: 'center', width: 48, height: 48, borderRadius: radius.control, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, lineHeight: 24, color: colors.text, textAlign: 'center', ...font.semibold },
  text: { fontSize: 14, lineHeight: 20, color: colors.text2, textAlign: 'center', marginBottom: 6, ...font.regular },
});

function RootStack() {
  const { status, me, needsOrgChoice } = useAuth();
  if (status === 'loading') return <Loading />;
  const signedIn = status === 'signedIn';
  if (signedIn && !me) return <ProfileGate />;
  const inApp = signedIn && !needsOrgChoice;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
      <Stack.Protected guard={!inApp}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={inApp}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Screen name="index" />
    </Stack>
  );
}

/**
 * Sürüm denetimi (Mesaj 13 §3.3): açılışta (girişten önce de) ve uygulama öne gelince en düşük sürüm sorulur.
 * Sunucu bu sürümü kabul etmiyorsa gezinme yerine tam ekran güncelleme ekranı çizilir; sağlayıcılar (oturum, kuyruk,
 * taslak) yerinde kalır, kuyruk silinmez. Ağ hatası ekranı açmaz. Durum kalkınca profil yeniden okunur, kuyruk kendisi sürer.
 */
function AppBody() {
  const { status, refreshProfile } = useAuth();
  const upgrade = useUpgradeState();
  const checked = useRef(false);

  useEffect(() => {
    void loadUpgradeFlag();
  }, []);

  // İlk denetim oturum yüklenince: geliştirmede kayıtlı sunucu adresi o zaman bellektedir.
  useEffect(() => {
    if (status === 'loading' || checked.current) return;
    checked.current = true;
    void checkPolicy(fetchClientPolicy);
  }, [status]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void checkPolicy(fetchClientPolicy);
    });
    return () => sub.remove();
  }, []);

  // Güncelleme ekranındayken profil 426 almış olabilir: ekran kalkınca bir kez yeniden okunur.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(
    () =>
      onUpgradeChange((s) => {
        if (!s.required && statusRef.current === 'signedIn') void refreshProfile();
      }),
    [refreshProfile],
  );

  if (upgrade.required) return <UpdateRequired state={upgrade} />;
  return <RootStack />;
}

export default function RootLayout() {
  // Cihaz kontrolü (LiDAR/AR) açılışta başlar; ölçü ekranına gelindiğinde sonuç hazır olur, kartlar sonradan eklenip kaymaz.
  useEffect(() => {
    getCapabilities().catch(() => undefined);
  }, []);
  // Edge-to-edge (SDK 58) Android'de adjustResize pencereyi küçültmez; klavye açılınca
  // alttaki giriş alanı ve sabit buton klavyenin üstüne itilsin diye tüm ekranlar burada sarılır.
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AuthProvider>
        <QueueProvider>
          <DraftProvider>
            <ToastProvider>
            <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
              <AppBody />
            </KeyboardAvoidingView>
            </ToastProvider>
          </DraftProvider>
        </QueueProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
