import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../src/auth/AuthContext';
import { useDraft } from '../../../src/draft/DraftContext';
import { useQueue } from '../../../src/queue/QueueContext';
import { MEASURE_UNAVAILABLE, measureUnavailableText, getCapabilities, peekCapabilities, measureWithAR, measureWithLidar, type Capabilities, type MeasureResult } from '../../../src/measure/boxMeasure';
import { Badge, Banner, Button, Card, Footer, Header, Screen } from '../../../src/ui/components';
import { DimField } from '../../../src/ui/DimField';
import { Icon, type IconName } from '../../../src/ui/Icon';
import { PackagingCalc, PackagingPicker, usePackagingContext } from '../../../src/ui/Packaging';
import { PresetPicker } from '../../../src/ui/PresetPicker';
import { colors, font, radius } from '../../../src/ui/theme';
import { dimMethodLabel, fmtNum } from '../../../src/lib/format';
import { compressUnknown } from '../../../src/lib/images';
import { packagingOf } from '../../../src/lib/packaging';
import type { DimMethod } from '../../../src/api/endpoints';

const round1 = (n: number) => Math.round(n * 10) / 10;

export default function Dims() {
  const { t } = useTranslation('measure');
  const { settings, presets } = useAuth();
  const { draft, update, replacePhotoOfKind } = useDraft();
  const { online } = useQueue();
  const [caps, setCaps] = useState<Capabilities | null>(peekCapabilities);
  const [busy, setBusy] = useState<DimMethod | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!caps) getCapabilities().then(setCaps);
  }, [caps]);

  const applyNative = async (method: 'LIDAR' | 'AR', r: MeasureResult | null) => {
    if (!r) return;
    update({
      lengthCm: round1(r.lengthCm),
      widthCm: round1(r.widthCm),
      heightCm: round1(r.heightCm),
      dimMethod: method,
      dimConfidence: r.confidence,
      boxPresetId: null,
    });
    if (r.snapshotUri) {
      try {
        const p = await compressUnknown(r.snapshotUri);
        replacePhotoOfKind({ uri: p.uri, kind: 'PHOTO_BOX', width: p.width, height: p.height }, 'measure-snapshot');
      } catch {
        /* anlık görüntü isteğe bağlı */
      }
    }
  };

  const runNative = async (method: 'LIDAR' | 'AR') => {
    setErr(null);
    setBusy(method);
    try {
      const r = method === 'LIDAR' ? await measureWithLidar() : await measureWithAR();
      await applyNative(method, r);
    } catch (e) {
      setErr(e instanceof Error && e.message === MEASURE_UNAVAILABLE ? measureUnavailableText() : t('dims.measureFailedRetry'));
    } finally {
      setBusy(null);
    }
  };

  const setDim = (key: 'lengthCm' | 'widthCm' | 'heightCm', v: number | null) => {
    update({ [key]: v, dimMethod: 'MANUAL', dimConfidence: null, boxPresetId: null });
  };

  const pickPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    update({ lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm, dimMethod: 'PRESET', dimConfidence: null, boxPresetId: p.id });
  };

  // Ambalaj: taşıyıcı barkoddan (yoksa firmanın ana taşıyıcısı); poşet/zarfta hazır koli yok, ölçü yine zorunlu.
  const packaging = packagingOf(draft);
  const special = packaging !== 'OWN';
  const pack = usePackagingContext(draft.trackingRaw, settings);

  const { lengthCm: l, widthCm: w, heightCm: h } = draft;
  const valid = !!l && !!w && !!h && l > 0 && w > 0 && h > 0;
  const hasValues = l !== null || w !== null || h !== null;

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('dims.title')} subtitle={`${draft.trackingRaw} · ${fmtNum(draft.weightKg, 2)} kg`} back step={3} />
      <Screen>
        <PackagingPicker value={packaging} onChange={(p) => update({ packaging: p })} ctx={pack} />
        <View style={{ gap: 6 }}>
          <Text style={st.secH} accessibilityRole="header">{t('dims.method')}</Text>
          {/* Cihaz kontrolü bitmediyse LiDAR/AR'ın yeri bir kart boyunda tutulur; referans kartı ve hazır koliler yerinde kalır. */}
          {caps === null ? (
            <View style={st.loading}>
              <ActivityIndicator color={colors.primary} />
              <Text style={st.loadingTxt}>{t('dims.checking')}</Text>
            </View>
          ) : (
            <>
              {caps.lidar ? (
                <MethodCard
                  icon="cube"
                  title={t('dims.lidar')}
                  sub={t('dims.lidarSub')}
                  badge={t('dims.recommended')}
                  busy={busy === 'LIDAR'}
                  onPress={() => runNative('LIDAR')}
                />
              ) : null}
              {/* AR yalnızca destekleyen cihazda görünür (SPEC 6); kullanılamayan seçenek ekranı kalabalıklaştırmasın. */}
              {caps.ar ? (
                <MethodCard icon="cube" title={t('dims.ar')} sub={t('dims.arSub')} busy={busy === 'AR'} onPress={() => runNative('AR')} />
              ) : null}
            </>
          )}
          <MethodCard
            icon="card"
            title={t('dims.reference')}
            sub={online ? (special ? t('packaging.referenceSub') : t('dims.referenceSub')) : t('dims.referenceOffline')}
            disabled={!online}
            disabledLabel={t('common.offline')}
            onPress={() => router.push('/deciship/reference')}
          />
        </View>
        {err ? <Banner kind="error" title={t('dims.failed')} text={t('dims.failedText', { error: err })} /> : null}

        {presets.length > 0 && !special ? (
          <Card>
            <View style={st.cardHd}>
              <Text style={st.secH}>{t('dims.preset')}</Text>
              <Text style={st.secS}>{t('dims.presetSub')}</Text>
            </View>
            <PresetPicker
              presets={presets}
              selectedId={draft.dimMethod === 'PRESET' ? draft.boxPresetId : null}
              onPick={(p) => pickPreset(p.id)}
            />
          </Card>
        ) : null}

        <Card>
          <View style={st.cardHd}>
            <Text style={st.secH}>{t('dims.sizes')}</Text>
            {hasValues ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Badge label={dimMethodLabel(draft.dimMethod)} kind="info" dot={false} />
                {draft.dimConfidence !== null ? (
                  <Badge label={t('common.confidence', { n: Math.round(draft.dimConfidence * 100) })} kind={draft.dimConfidence >= 0.7 ? 'success' : 'warning'} />
                ) : null}
              </View>
            ) : (
              <Text style={st.secS}>{special ? t('packaging.dimsHint') : t('dims.enterManually')}</Text>
            )}
          </View>
          <View style={st.dims}>
            <DimField label={t('dims.length')} value={l} onChange={(v) => setDim('lengthCm', v)} />
            <DimField label={t('dims.width')} value={w} onChange={(v) => setDim('widthCm', v)} />
            <DimField label={t('dims.height')} value={h} onChange={(v) => setDim('heightCm', v)} />
          </View>
        </Card>

        <PackagingCalc packaging={packaging} l={l} w={w} h={h} kg={draft.weightKg} desiDivisor={settings.desiDivisor} ctx={pack} barem fitHint />
      </Screen>
      <Footer>
        <Button
          label={valid ? t('common.continue') : t('dims.enterAll')}
          iconRight={valid ? 'arrow' : undefined}
          onPress={() => router.push('/deciship/photos')}
          disabled={!valid}
          large
        />
      </Footer>
    </View>
  );
}

function MethodCard({
  icon,
  title,
  sub,
  badge,
  busy,
  disabled,
  disabledLabel,
  onPress,
}: {
  icon: IconName;
  title: string;
  sub: string;
  badge?: string;
  busy?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [st.mc, badge && st.mcRec, pressed && st.mcPressed, disabled && st.mcOff]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      accessibilityLabel={`${title}. ${sub}`}
    >
      <View style={[st.mcIcon, disabled && st.mcIconOff]}>
        <Icon name={icon} size={20} color={disabled ? colors.disabledText : colors.primary} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={st.mcTop}>
          <Text style={[st.mcT, disabled && { color: colors.text3 }]} numberOfLines={1}>
            {title}
          </Text>
          {badge ? <Badge label={badge} kind="success" /> : null}
          {disabled && disabledLabel ? <Badge label={disabledLabel} kind="neutral" /> : null}
        </View>
        <Text style={st.mcS}>{sub}</Text>
      </View>
      {busy ? <ActivityIndicator color={colors.primary} /> : disabled ? null : <Icon name="chev" color={colors.text2} size={18} strokeWidth={2} />}
    </Pressable>
  );
}

const st = StyleSheet.create({
  secH: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  secS: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  cardHd: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, minHeight: 22, gap: 8 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, minHeight: 56 },
  loadingTxt: { fontSize: 13, color: colors.text2, ...font.regular },
  mc: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 56,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mcRec: { borderColor: colors.successLine },
  mcPressed: { backgroundColor: colors.primarySoft, borderColor: colors.primaryLine },
  mcOff: { backgroundColor: colors.surface2 },
  mcIcon: { width: 36, height: 36, borderRadius: radius.control, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  mcIconOff: { backgroundColor: colors.disabledBg },
  mcTop: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  mcT: { fontSize: 14, lineHeight: 19, color: colors.text, flexShrink: 1, ...font.semibold },
  mcS: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 1, ...font.regular },
  dims: { flexDirection: 'row', gap: 8 },
});
