import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { IconButton } from './components';
import { colors, font } from './theme';

export type ViewerPhoto = { key: string; uri: string; label: string };

/** Tam ekran fotoğraf görüntüleyici; yana kaydırarak diğer fotoğraflar. */
export function PhotoViewer({ photos, index, onClose }: { photos: ViewerPhoto[]; index: number | null; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('measure');
  const [cur, setCur] = useState(index ?? 0);
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    if (index !== null) {
      setCur(index);
      requestAnimationFrame(() => ref.current?.scrollTo({ x: index * width, animated: false }));
    }
  }, [index, width]);

  const p = photos[cur];
  return (
    <Modal visible={index !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar style="light" />
      <View style={[st.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={st.top}>
          <IconButton icon="close" label={t('ui.close')} onPress={onClose} dark />
          <Text style={st.ttl} numberOfLines={1}>
            {p ? p.label : ''}
          </Text>
          <Text style={st.count}>
            {photos.length ? `${cur + 1}/${photos.length}` : ''}
          </Text>
        </View>
        <ScrollView
          ref={ref}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setCur(Math.round(e.nativeEvent.contentOffset.x / width))}
          style={{ flex: 1 }}
        >
          {photos.map((ph) => (
            <View key={ph.key} style={{ width, flex: 1, justifyContent: 'center' }}>
              <ActivityIndicator color="#fff" style={StyleSheet.absoluteFill} />
              <Image source={{ uri: ph.uri }} style={{ width, height: '100%' }} resizeMode="contain" accessibilityLabel={t('photos.captureTitle', { kind: ph.label })} />
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.night },
  top: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  ttl: { flex: 1, color: '#fff', fontSize: 15, lineHeight: 20, ...font.semibold },
  count: { color: colors.onNight2, fontSize: 13, paddingRight: 10, ...font.mono },
});
