import { useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../src/auth/AuthContext';
import { useDraft, type DraftPhoto } from '../../../src/draft/DraftContext';
import { Badge, Banner, Button, Card, Footer, Header, Screen } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/Icon';
import { PhotoCapture } from '../../../src/ui/PhotoCapture';
import { colors, font, radius } from '../../../src/ui/theme';
import type { PhotoKind } from '../../../src/api/endpoints';
import { kindLabel } from '../../../src/lib/format';

export default function Photos() {
  const { t } = useTranslation('measure');
  const { settings } = useAuth();
  const { draft, addPhoto, removePhoto } = useDraft();
  const [cam, setCam] = useState<PhotoKind | null>(null);

  const required = settings.requiredBoxPhotos;
  const boxCount = draft.photos.filter((p) => p.kind === 'PHOTO_BOX').length;
  const missing = Math.max(0, required - boxCount);

  const confirmRemove = (p: DraftPhoto) =>
    Alert.alert(t('photos.deleteAsk'), kindLabel(p.kind), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: () => removePhoto(p.id) },
    ]);

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('photos.title')} subtitle={draft.trackingRaw} back step={4} />
      <Screen>
        {missing > 0 ? (
          <Banner
            kind="warn"
            icon="camera"
            title={t('photos.missing', { count: missing })}
            text={t('photos.missingText', { count: required })}
          />
        ) : (
          <Banner kind="ok" title={t('photos.done')} text={t('photos.doneText', { boxCount, required })} />
        )}
        <Card>
          <View style={st.hd}>
            <Text style={st.secH} accessibilityRole="header">{t('photos.taken')}</Text>
            <Badge label={t('photos.boxBadge', { boxCount, required })} kind={missing > 0 ? 'warning' : 'success'} />
          </View>
          <View style={st.grid}>
            {draft.photos.map((p) => (
              <Pressable
                key={p.id}
                style={st.cell}
                onLongPress={() => confirmRemove(p)}
                onPress={() => confirmRemove(p)}
                accessibilityRole="button"
                accessibilityLabel={t('photos.tapDelete', { kind: kindLabel(p.kind) })}
              >
                <View>
                  <Image source={{ uri: p.uri }} style={st.img} />
                  <View style={st.del}>
                    <Icon name="trash" size={16} color={colors.danger} strokeWidth={2} />
                  </View>
                </View>
                <Text style={st.cap} numberOfLines={1}>
                  {kindLabel(p.kind)}
                </Text>
              </Pressable>
            ))}
            <Pressable style={st.cell} onPress={() => setCam('PHOTO_BOX')} accessibilityRole="button" accessibilityLabel={t('photos.takeBox')}>
              {({ pressed }) => (
                <View style={[st.add, missing > 0 && st.addReq, pressed && { backgroundColor: colors.primarySoft }]}>
                  <Icon name="camera" size={24} color={missing > 0 ? colors.primary : colors.text2} />
                  <Text style={[st.addTxt, missing > 0 && { color: colors.primary }]}>{t('photos.boxPhoto')}</Text>
                </View>
              )}
            </Pressable>
          </View>
          <Text style={st.extraL}>{t('photos.extra')}</Text>
          <View style={st.extra}>
            <Button label={kindLabel('PHOTO_LABEL')} kind="secondary" icon="plus" onPress={() => setCam('PHOTO_LABEL')} style={{ flex: 1 }} />
            <Button label={kindLabel('PHOTO_OTHER')} kind="secondary" icon="plus" onPress={() => setCam('PHOTO_OTHER')} style={{ flex: 1 }} />
          </View>
        </Card>
      </Screen>
      <Footer>
        {missing > 0 ? (
          <Button label={t('photos.takeNext', { n: boxCount + 1, required })} icon="camera" onPress={() => setCam('PHOTO_BOX')} large />
        ) : (
          <Button label={t('photos.toSummary')} iconRight="arrow" onPress={() => router.push('/deciship/summary')} large />
        )}
      </Footer>
      <PhotoCapture
        visible={cam !== null}
        title={cam ? t('photos.captureTitle', { kind: kindLabel(cam) }) : ''}
        hint={cam === 'PHOTO_BOX' ? t('photos.captureHint') : undefined}
        onClose={() => setCam(null)}
        onCapture={(p) => {
          if (cam) addPhoto({ uri: p.uri, kind: cam, width: p.width, height: p.height });
          setCam(null);
        }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  hd: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  secH: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 },
  cell: { width: '31.6%' },
  img: { width: '100%', aspectRatio: 1, borderRadius: radius.control, backgroundColor: '#1b2433', borderWidth: 1, borderColor: colors.border },
  del: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cap: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 3, ...font.medium },
  add: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.control,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  addReq: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  addTxt: { fontSize: 12, lineHeight: 16, color: colors.text2, textAlign: 'center', paddingHorizontal: 4, ...font.medium },
  extraL: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 12, marginBottom: 6, ...font.medium },
  extra: { flexDirection: 'row', gap: 8 },
});
