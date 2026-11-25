import { useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Api, imageForm } from '../../../src/api/endpoints';
import { ApiError } from '../../../src/api/client';
import { useDraft } from '../../../src/draft/DraftContext';
import { useQueue } from '../../../src/queue/QueueContext';
import { Button, Footer, Header, Screen } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/Icon';
import { NumPad } from '../../../src/ui/NumPad';
import { PhotoCapture } from '../../../src/ui/PhotoCapture';
import { colors, font, radius } from '../../../src/ui/theme';
import { fmtInput, parseNum, showDecimal } from '../../../src/lib/format';
import type { Photo } from '../../../src/lib/images';
import { scaleReadErrorKey } from '../../../src/lib/scaleReadError';
import { SCALE_CAPTURE_RESET, scaleAfterCapture, scaleCameraDisabled, scaleHintKey, weightMethodOf } from '../../../src/lib/scaleCapture';
import { useAuth } from '../../../src/auth/AuthContext';
import { WEIGHT_DECIMALS } from '../../../src/lib/numKey';

export default function Weight() {
  const { t } = useTranslation('measure');
  const { draft, update, replacePhotoOfKind } = useDraft();
  const { online } = useQueue();
  // Firma tartı okumasını açtı mı (varsayılan kapalı; kapalıyken fotoğraf yalnız kanıt, ağırlık elle).
  const aiRead = useAuth().settings.scaleAiRead;
  // Kısa ekranlarda (ör. 360×740) tuş takımının son sırası kaydırmadan görünsün.
  const { height, width, fontScale } = useWindowDimensions();
  const compact = height < 820;
  // Dar ekran veya büyük yazı: kart tek satıra iner, tuş takımı ekrana sığar.
  const narrow = width / fontScale < 330;
  // Tuş takımı ve tartı okuması 3 ondalık verir; taslaktaki değer aynı hassasiyetle geri yüklenir. 2 ondalıkta "4,025"
  // ekrana "4,03" diye döner, "Devam" ile kayıt hem ağırlığı hem yöntemi (tartı okuması → elle) değiştirirdi.
  const [text, setText] = useState(draft.weightKg !== null ? fmtInput(draft.weightKg, WEIGHT_DECIMALS) : '');
  const [camOpen, setCamOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [ocr, setOcr] = useState<{ value: number | null; confidence: number; raw: string } | null>(
    draft.ocrWeightKg !== null ? { value: draft.ocrWeightKg, confidence: 1, raw: '' } : null,
  );
  /** Okuma olmadıysa nedeni; tartı kartının alt satırında gösterilir (ayrı uyarı kutusu yok). */
  const [msg, setMsg] = useState<string | null>(null);

  const scalePhoto = draft.photos.find((p) => p.kind === 'PHOTO_SCALE');
  const value = parseNum(text);
  const valid = value !== null && value > 0 && value < 1000;
  const tooHeavy = value !== null && value >= 1000;

  const onCapture = async (p: Photo) => {
    setCamOpen(false);
    replacePhotoOfKind({ uri: p.uri, kind: 'PHOTO_SCALE', width: p.width, height: p.height });
    setMsg(null);
    // Önceki fotoğrafın okuması bu fotoğrafın değil: ekrandan ve taslaktan silinir.
    setOcr(SCALE_CAPTURE_RESET.ocr);
    update(SCALE_CAPTURE_RESET.draft);
    // Çevrimdışı ya da firma okumayı kapattı: fotoğraf taslakta kalır (kanıt), okuma yapılmaz, ağırlık elle girilir (11-B12).
    const after = scaleAfterCapture(online, aiRead);
    if (after === 'keep') return;
    if (after === 'manual') {
      setMsg(t('weight.offlineManual'));
      return;
    }
    setReading(true);
    try {
      const r = await Api.readScale(imageForm('image', p.uri));
      setOcr({ value: r.weightKg, confidence: r.confidence, raw: r.rawText });
      if (r.weightKg !== null && r.weightKg > 0) {
        setText(fmtInput(r.weightKg, WEIGHT_DECIMALS));
        update({ ocrWeightKg: r.weightKg });
      } else {
        setMsg(t('weight.unreadable'));
      }
    } catch (e) {
      // anahtar yok, bu ayki hak doldu (Y62-E4), sunucuya ulaşılamadı ya da okunamadı: hepsinde elle girilir
      setMsg(t(scaleReadErrorKey(e instanceof ApiError ? e : null)));
    } finally {
      setReading(false);
    }
  };

  const next = () => {
    if (!valid || value === null) return;
    update({ weightKg: value, weightMethod: weightMethodOf(value, ocr?.value), ocrWeightKg: ocr?.value ?? null });
    router.push('/deciship/dims');
  };

  const ocrLine = reading
    ? t('weight.reading')
    : msg
      ? msg
      : t(scaleHintKey({ online, aiRead, read: !!ocr && ocr.value !== null, hasPhoto: !!scalePhoto }), {
          n: Math.round((ocr?.confidence ?? 0) * 100),
        });

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('weight.title')} subtitle={draft.trackingRaw} back step={2} />
      <Screen>
        <View style={st.ocrCard}>
          {scalePhoto ? (
            <Image source={{ uri: scalePhoto.uri }} style={st.thumb} />
          ) : narrow ? null : (
            <View style={[st.thumb, st.thumbEmpty]}>
              <Icon name="scale" size={26} color={colors.primary} />
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={st.ocrT} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {t('weight.scalePhoto')}
            </Text>
            {narrow && !reading && !msg && ocr?.value == null ? null : <View style={st.ocrRow}>
              {reading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
              <Text
                style={[st.ocrS, ocr?.value != null && !reading && !msg && st.ocrOk, !!msg && !reading && st.ocrWarn]}
                numberOfLines={3}
              >
                {ocrLine}
              </Text>
            </View>}
          </View>
          <Button
            label={scalePhoto ? t('weight.retake') : t('weight.take')}
            icon="camera"
            kind="secondary"
            small
            onPress={() => setCamOpen(true)}
            disabled={scaleCameraDisabled({ reading, online })}
          />
        </View>

        <View>
          <Text style={st.lbl}>{t('weight.readingLabel')}</Text>
          <View style={[st.display, compact && st.displayCompact, tooHeavy && st.displayErr]}>
            <Text style={[st.val, compact && st.valCompact, !text && { color: colors.placeholder }]} numberOfLines={1} adjustsFontSizeToFit>
              {text ? showDecimal(text) : '0'}
            </Text>
            <Text style={st.unit}>kg</Text>
          </View>
          {tooHeavy ? (
            <Text style={st.err} accessibilityLiveRegion="polite">
              {t('weight.tooHeavy')}
            </Text>
          ) : ocr?.value != null ? (
            <Text style={st.help}>{t('weight.checkValue')}</Text>
          ) : null}
        </View>
        <NumPad onChange={setText} maxDecimals={WEIGHT_DECIMALS} compact={compact} />
      </Screen>
      <Footer>
        <Button label={valid ? t('common.continue') : t('weight.enter')} iconRight={valid ? 'arrow' : undefined} onPress={next} disabled={!valid} large />
      </Footer>
      <PhotoCapture
        visible={camOpen}
        title={t('weight.captureTitle')}
        hint={t('weight.captureHint')}
        onClose={() => setCamOpen(false)}
        onCapture={onCapture}
      />
    </View>
  );
}

const st = StyleSheet.create({
  ocrCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  thumb: { width: 48, height: 48, borderRadius: radius.control, backgroundColor: '#1b2433' },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  ocrT: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
  ocrRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  ocrWarn: { color: colors.warning, ...font.medium },
  ocrS: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  ocrOk: { color: colors.primaryHover, ...font.medium },
  lbl: { fontSize: 12, lineHeight: 16, color: colors.text2, marginBottom: 4, ...font.medium },
  display: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radius.card,
    height: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
  },
  displayCompact: { height: 62 },
  displayErr: { borderColor: colors.danger },
  val: { fontSize: 44, lineHeight: 54, color: colors.text, flexShrink: 1, ...font.semibold, fontVariant: ['tabular-nums'] },
  valCompact: { fontSize: 38, lineHeight: 46 },
  unit: { fontSize: 20, color: colors.text2, marginLeft: 10, marginTop: 12, ...font.regular },
  help: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 4, ...font.regular },
  err: { fontSize: 12, lineHeight: 16, color: colors.danger, marginTop: 4, ...font.medium },
});
