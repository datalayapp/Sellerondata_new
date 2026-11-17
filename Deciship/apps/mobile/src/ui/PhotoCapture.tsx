import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { compressPhoto, type Photo } from '../lib/images';
import type { PhotoSource } from '../lib/photoKind';
import { Icon } from './Icon';
import { StatusBar } from 'expo-status-bar';
import { IconButton } from './components';
import { CameraPermissionPrompt, useCameraAccess } from './CameraPermission';
import { colors, font, radius } from './theme';

type Props = {
  visible: boolean;
  title: string;
  hint?: string;
  maxEdge?: number;
  overlay?: ReactNode;
  allowGallery?: boolean;
  onClose: () => void;
  /** `source`: kamera çekimi mi, galeriden seçim mi (galeri fotoğrafı koli kanıtı sayılmaz). */
  onCapture: (p: Photo, source: PhotoSource) => void;
};

/** Tam ekran fotoğraf çekimi; çıktı 1600 px uzun kenar, JPEG %80. */
export function PhotoCapture({ visible, title, hint, maxEdge, overlay, allowGallery, onClose, onCapture }: Props) {
  const camRef = useRef<CameraView>(null);
  const [perm, requestPerm] = useCameraAccess();
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  /** Son çekim ya da galeri hatası: deklanşörün üstünde tek satır. RN `Modal` üstünde kayan bildirim görünmez. */
  const [failed, setFailed] = useState<'capture' | 'gallery' | null>(null);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('measure');

  useEffect(() => {
    if (visible) setFailed(null);
  }, [visible]);

  const shoot = async () => {
    if (!camRef.current || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      const pic = await camRef.current.takePictureAsync({ quality: 0.9, exif: false, shutterSound: false });
      if (!pic) {
        setFailed('capture');
        return;
      }
      const out = await compressPhoto(pic.uri, pic.width, pic.height, maxEdge);
      onCapture(out, 'camera');
    } catch (e) {
      console.warn('capture', e);
      setFailed('capture');
    } finally {
      setBusy(false);
    }
  };

  const pickFromGallery = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
      const a = r.canceled ? null : r.assets[0];
      if (!a) return;
      onCapture(await compressPhoto(a.uri, a.width, a.height, maxEdge), 'gallery');
    } catch (e) {
      console.warn('gallery', e);
      setFailed('gallery');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar style="light" />
      <View style={[st.root, { paddingTop: insets.top }]}>
        <View style={st.top}>
          <IconButton icon="close" label={t('ui.close')} onPress={onClose} dark />
          <Text style={st.topTxt} numberOfLines={1}>
            {title}
          </Text>
          {perm?.granted ? (
            <Pressable
              onPress={() => setTorch((t) => !t)}
              style={[st.circ, torch && { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel={torch ? t('scan.torchOff') : t('scan.torchOn')}
            >
              <Icon name="flash" color="#fff" size={22} strokeWidth={2} />
            </Pressable>
          ) : (
            // Kamera izni yokken fener işe yaramaz; başlık ortada kalsın diye yeri boş tutulur.
            <View style={st.circSpace} />
          )}
        </View>
        <View style={st.view}>
          {!perm ? null : perm.granted ? (
            visible ? (
              <CameraView ref={camRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} onCameraReady={() => setReady(true)} />
            ) : null
          ) : (
            // Kalıcı reddedildiyse düğme ayarları açar (G2 / 11-B6).
            <CameraPermissionPrompt perm={perm} request={requestPerm} place="photo" />
          )}
          {overlay}
          {hint ? (
            <View style={st.guide} pointerEvents="none">
              <Icon name="info" color="#fff" size={18} strokeWidth={2} />
              <Text style={st.guideTxt}>{hint}</Text>
            </View>
          ) : null}
          {perm?.granted && !ready ? (
            <View style={st.loading} pointerEvents="none">
              <ActivityIndicator color="#fff" />
              <Text style={st.loadingTxt}>{t('ui.cameraOpening')}</Text>
            </View>
          ) : null}
        </View>
        {failed ? (
          <View style={st.fail} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Icon name="warn" color={colors.danger} size={16} strokeWidth={2} />
            <Text style={st.failTxt} numberOfLines={2}>
              {t(failed === 'capture' ? 'ui.captureFailed' : 'ui.galleryFailed')}
            </Text>
          </View>
        ) : null}
        <View style={[st.ctl, { paddingBottom: 20 + insets.bottom }]}>
          {allowGallery ? (
            <Pressable onPress={pickFromGallery} style={({ pressed }) => [st.side, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={t('ui.gallery')} disabled={busy}>
              <View style={st.sideIcon}>
                <Icon name="image" color="#fff" size={24} />
              </View>
              <Text style={st.sideTxt}>{t('ui.galleryShort')}</Text>
            </Pressable>
          ) : (
            <View style={st.sideSpacer} />
          )}
          {perm && !perm.granted ? (
            // İzin yokken deklanşör yok: basılınca hiçbir şey olmayan düğme yerine neden yazar.
            <Text style={st.noCam}>{t('ui.shootNeedsCamera')}</Text>
          ) : (
            <Pressable
              onPress={shoot}
              disabled={!ready || busy || !perm?.granted}
              accessibilityRole="button"
              accessibilityLabel={t('ui.shoot')}
              style={({ pressed }) => [st.shutter, (!ready || !perm?.granted) && { opacity: 0.4 }, pressed && { transform: [{ scale: 0.94 }] }]}
            >
              {busy ? <ActivityIndicator color="#fff" size="large" /> : <View style={st.shutterIn} />}
            </Pressable>
          )}
          <View style={st.sideSpacer} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.night },
  top: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  topTxt: { flex: 1, color: '#fff', fontSize: 15, lineHeight: 20, ...font.semibold },
  circ: { width: 48, height: 48, borderRadius: radius.control, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  circSpace: { width: 48, height: 48 },
  view: { flex: 1, overflow: 'hidden', backgroundColor: '#000', marginHorizontal: 8, borderRadius: radius.card },
  guide: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: colors.scrim,
    borderRadius: radius.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  guideTxt: { flex: 1, color: '#fff', fontSize: 13, lineHeight: 18, ...font.regular },
  loading: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingTxt: { color: '#fff', fontSize: 13, ...font.regular },
  fail: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, marginTop: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.card, backgroundColor: colors.dangerBg },
  failTxt: { flex: 1, fontSize: 13, lineHeight: 18, color: '#7a1a12', ...font.medium },
  ctl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 16 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterIn: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  side: { width: 72, alignItems: 'center', gap: 4, minHeight: 56, justifyContent: 'center' },
  sideIcon: { width: 48, height: 48, borderRadius: radius.control, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  sideSpacer: { width: 72 },
  sideTxt: { color: '#fff', fontSize: 12, textAlign: 'center', ...font.medium },
  // Deklanşörle aynı yükseklik: düzen kaymaz.
  noCam: { flex: 1, minHeight: 76, textAlignVertical: 'center', color: 'rgba(255,255,255,0.8)', fontSize: 13, lineHeight: 18, textAlign: 'center', ...font.regular },
});
