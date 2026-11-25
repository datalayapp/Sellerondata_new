import { useEffect } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { useTranslation } from 'react-i18next';
import { cameraPermAction, cameraPermButtonKey, cameraPermTextKey, type CameraPermLike } from '../lib/cameraPermission';
import { Button } from './components';
import { Icon } from './Icon';
import { font, radius } from './theme';

/**
 * Kamera izni. Ayarlardan dönünce (uygulama öne gelince) durum yeniden okunur: izin verildiyse kamera kendiliğinden açılır.
 */
export function useCameraAccess() {
  const [perm, requestPerm, getPerm] = useCameraPermissions();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') getPerm().catch(() => undefined);
    });
    return () => sub.remove();
  }, [getPerm]);
  return [perm, requestPerm] as const;
}

/**
 * Kamera izni yokken koyu kamera alanının ortasındaki açıklama ve tek düğme (barkod ekranı ve fotoğraf penceresi).
 * Kalıcı reddedildiyse düğme telefonun uygulama ayarlarını açar (G2 / 11-B6). İzin varsa ya da henüz okunmadıysa boş.
 * `compact`: barkod ekranındaki küçük alan (simge kutusuz, normal düğme).
 */
export function CameraPermissionPrompt({
  perm,
  request,
  place,
  compact = false,
}: {
  perm: CameraPermLike;
  request: () => Promise<unknown>;
  place: 'scan' | 'photo';
  compact?: boolean;
}) {
  const { t } = useTranslation('measure');
  const action = cameraPermAction(perm);
  if (!action) return null;
  const onPress = () => {
    if (action === 'settings') Linking.openSettings().catch((e) => console.warn('settings', e));
    else request().catch((e) => console.warn('camera permission', e));
  };
  return (
    <View style={compact ? st.boxCompact : st.box}>
      {compact ? (
        <Icon name="camera" color="#fff" size={26} />
      ) : (
        <View style={st.icon}>
          <Icon name="camera" color="#fff" size={28} />
        </View>
      )}
      <Text style={st.title}>{t('scan.permTitle')}</Text>
      <Text style={[st.text, compact && st.textCompact]}>{t(cameraPermTextKey(action, place))}</Text>
      <Button label={t(cameraPermButtonKey(action))} icon={action === 'settings' ? 'gear' : 'camera'} onPress={onPress} large={!compact} />
    </View>
  );
}

const st = StyleSheet.create({
  box: { flex: 1, alignItems: 'stretch', justifyContent: 'center', padding: 16, gap: 10 },
  boxCompact: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 8 },
  icon: { alignSelf: 'center', width: 48, height: 48, borderRadius: radius.control, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 15, textAlign: 'center', ...font.semibold },
  text: { color: 'rgba(255,255,255,0.8)', fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 6, ...font.regular },
  textCompact: { marginBottom: 4 },
});
