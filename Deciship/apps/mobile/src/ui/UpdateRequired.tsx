import { useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchClientPolicy } from '../api/client';
import { useQueue } from '../queue/QueueContext';
import { APP_VERSION, BUILD } from '../version/client';
import { checkPolicy, getUpgradeState, onUpgradeChange, type UpgradeState } from '../version/policy';
import { Banner, Button, EmptyState, Screen } from './components';
import { colors, type } from './theme';

/** Güncelleme durumu (426 ya da politika). Değişince yeniden çizer. */
export function useUpgradeState(): UpgradeState {
  return useSyncExternalStore(onUpgradeChange, getUpgradeState, getUpgradeState);
}

/**
 * Tam ekran "Uygulamayı güncelleyin" (Mesaj 13 §3.3). `app/_layout.tsx` sağlayıcıların içinde, gezinme yerine çizer:
 * sekme, geri ve çıkış yok. Tek birincil eylem: bağlantı varsa "Yeni sürümü indir", yoksa "Yeniden denetle".
 * Kuyruk bu ekranda gönderilmez ve silinmez; kaç ölçüm beklediği gösterilir, "silmeyin, üzerine kurun" denir.
 */
export function UpdateRequired({ state }: { state: Extract<UpgradeState, { required: true }> }) {
  const { t } = useTranslation('common');
  const insets = useSafeAreaInsets();
  const { pending, errors, others } = useQueue();
  const [checking, setChecking] = useState(false);
  // Telefondaki bütün gönderilmemiş kayıtlar: bu oturumun bekleyen ve Hatalı kayıtları, başka oturumlarınkiler.
  const unsent = pending + errors + others.total;
  const current = BUILD !== null ? `${APP_VERSION} (${BUILD})` : APP_VERSION;

  const recheck = async () => {
    setChecking(true);
    try {
      await checkPolicy(fetchClientPolicy);
    } finally {
      setChecking(false);
    }
  };

  // DeciShip API'nin 426'sı bağlantı taşımaz. Ekran onunla açıldıysa bağlantı Hesap servisinden bir kez sessizce
  // sorulur; yoksa "Yeni sürümü indir" düğmesi ancak elle "Yeniden denetle"den sonra görünürdü.
  const hasLink = !!state.updateUrl;
  useEffect(() => {
    if (!hasLink) void checkPolicy(fetchClientPolicy);
  }, [hasLink]);

  const download = () => {
    if (state.updateUrl) Linking.openURL(state.updateUrl).catch((e) => console.warn('update link', e));
  };

  return (
    <View style={[st.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Screen style={st.body}>
        <EmptyState icon="sync" title={t('update.title')} text={t('update.body')} />
        {unsent > 0 ? <Banner kind="warn" title={t('queue.blockedUpgrade')} text={t('update.queued', { count: unsent })} /> : null}
        <Banner kind="info" text={t('update.keep')} />
        <View style={st.actions}>
          {state.updateUrl ? (
            <>
              <Button label={t('update.download')} onPress={download} large />
              <Button label={t('update.recheck')} icon="sync" kind="secondary" loading={checking} onPress={() => void recheck()} />
            </>
          ) : (
            <>
              <Text style={st.note}>{t('update.noLink')}</Text>
              <Button label={t('update.recheck')} icon="sync" loading={checking} onPress={() => void recheck()} large />
            </>
          )}
        </View>
        <Text style={st.version} selectable>
          {t('update.version', { current, min: state.minVersion ?? '-' })}
        </Text>
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flexGrow: 1, justifyContent: 'center', gap: 12 },
  actions: { gap: 10, marginTop: 4 },
  note: { ...type.body, color: colors.text2, textAlign: 'center' },
  version: { ...type.id, color: colors.text3, textAlign: 'center', marginTop: 8 },
});
