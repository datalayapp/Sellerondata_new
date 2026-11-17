import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { useAudioPlayer } from 'expo-audio';
import { desi } from '@deciship/core/calc';
import { Api } from '../../../src/api/endpoints';
import { useAuth } from '../../../src/auth/AuthContext';
import { useDraft } from '../../../src/draft/DraftContext';
import { useQueue } from '../../../src/queue/QueueContext';
import { Banner, Button, Footer, Header, IconButton, ListCard, ListRow, useKeyboardVisible } from '../../../src/ui/components';
import { CameraPermissionPrompt, useCameraAccess } from '../../../src/ui/CameraPermission';
import { StatusBadge } from '../../../src/ui/MeasurementRow';
import { Icon } from '../../../src/ui/Icon';
import { colors, font, radius } from '../../../src/ui/theme';
import { fmtDims, fmtNum, fmtWhen, isToday } from '../../../src/lib/format';
import { scanDecision } from '../../../src/lib/scanCheck';

const BARCODE_TYPES: BarcodeType[] = ['code128', 'code39', 'ean13', 'qr', 'datamatrix', 'pdf417', 'itf14'];

export default function Scan() {
  const { t } = useTranslation('measure');
  const [perm, requestPerm] = useCameraAccess();
  const { draft, update } = useDraft();
  const { online, findUnsent, rows } = useQueue();
  const { settings } = useAuth();
  const [torch, setTorch] = useState(false);
  const [manual, setManual] = useState('');
  const [softKeyboard, setSoftKeyboard] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const [inFocus, setInFocus] = useState(false);
  const locked = useRef(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const beep = useAudioPlayer(require('../../../assets/beep.wav'));

  useFocusEffect(
    useCallback(() => {
      locked.current = false;
      setFocused(true);
      setChecking(false);
      return () => setFocused(false);
    }, []),
  );

  // İzin ekran açılınca yalnız bir kez kendiliğinden sorulur; ret sonrası (ya da ayarlardan dönüşte) yeniden sorulmaz, düğme kalır.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!perm || perm.granted || !perm.canAskAgain || autoAsked.current) return;
    autoAsked.current = true;
    requestPerm().catch(() => undefined);
  }, [perm, requestPerm]);

  const proceed = useCallback(
    // `replacesId`: kontrol ekranında görülüp bilerek yeniden ölçülen sunucu kaydı (KALANLAR 6.7-a); sunucu onu güncel
    // sürümse saate bakmadan yeni ölçümle değiştirir. Yeni barkodda boşalır.
    (code: string, replacesId: string | null = null) => {
      update({ trackingRaw: code, replacesId });
      setManual('');
      router.push('/deciship/weight');
    },
    [update],
  );

  const accept = useCallback(
    async (raw: string, symbology?: string) => {
      // Okuyucu işaretleri silinir; takip no'ya benzemeyen değer sorulur, kesin geçersiz olan kaydedilmez (KALANLAR 4.8).
      const { code, action } = scanDecision(raw, symbology);
      if (action === 'ignore' || locked.current) return;
      locked.current = true;
      setLastRead(code);
      const warn = action !== 'proceed';
      Haptics.notificationAsync(warn ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      try {
        beep.seekTo(0);
        beep.play();
      } catch {
        /* ses isteğe bağlı */
      }
      const release = () => {
        locked.current = false;
        setLastRead(null);
        // Bluetooth okuyucu sonraki barkodu eskisinin sonuna eklemesin.
        setManual('');
      };
      if (warn) {
        const goOn = await new Promise<boolean>((resolve) => {
          const again = { text: t('scan.scanAgain'), style: 'cancel' as const, onPress: () => resolve(false) };
          Alert.alert(
            t('scan.notTracking'),
            t('scan.notTrackingText', { code }),
            action === 'confirm' ? [again, { text: t('scan.useAnyway'), onPress: () => resolve(true) }] : [again],
            { cancelable: false },
          );
        });
        if (!goOn) return release();
      }
      const askRemeasure = (when: string, who: string, l?: number, w?: number, h?: number, kg?: number, replacesId: string | null = null) =>
        Alert.alert(
          t('scan.measuredBefore'),
          // Başkasının ölçüsü gelmez: yalnız ne zaman ve kim.
          l != null && w != null && h != null && kg != null
            ? t('scan.measuredBeforeText', { when, who, dims: fmtDims(l, w, h), kg: fmtNum(kg, 2) })
            : t('scan.measuredBeforeNoDims', { when, who }),
          [
            { text: t('common.cancel'), style: 'cancel', onPress: release },
            { text: t('scan.measureAgain'), onPress: () => proceed(code, replacesId) },
          ],
          { cancelable: false },
        );
      // Önce bu cihazın kuyruğu: henüz gönderilmemiş ölçüm sunucuda görünmez.
      try {
        const local = await findUnsent(code);
        if (local) {
          const d = local.data;
          askRemeasure(fmtWhen(d.measuredAt), t('scan.notSentYet'), d.lengthCm, d.widthCm, d.heightCm, d.weightKg);
          return;
        }
      } catch {
        /* yerel kontrol olmazsa sunucuya sorulur */
      }
      if (!online) return proceed(code);
      setChecking(true);
      try {
        const r = await Api.check(code);
        setChecking(false);
        if (r.exists && r.last) {
          const l = r.last;
          askRemeasure(fmtWhen(l.measuredAt), l.measuredByName, l.lengthCm, l.widthCm, l.heightCm, l.weightKg, l.id ?? null);
          return;
        }
      } catch {
        setChecking(false);
      }
      proceed(code);
    },
    [online, proceed, beep, findUnsent, t],
  );

  const onScanned = useCallback((r: BarcodeScanningResult) => accept(r.data, r.type), [accept]);

  // Son okunanlar: bu oturumun bugünkü kayıtları (kuyruk dahil), en yeni üçü.
  const recent = useMemo(() => rows.filter((r) => isToday(r.data.measuredAt)), [rows]);
  // Klavye açıkken kamera alanı küçülür, son okunanlar gizlenir: takip no alanı düğmenin altında kalmasın.
  const keyboard = useKeyboardVisible();

  return (
    <View style={st.root}>
      <Header title={t('scan.title')} subtitle={t('scan.subtitle')} subtitleMono={false} back step={1} />
      <View style={st.body}>
        <View style={[st.view, keyboard && st.viewKb]}>
          {perm?.granted && focused ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={checking ? undefined : onScanned}
            />
          ) : perm && !perm.granted ? (
            // Kalıcı reddedildiyse düğme ayarları açar (G2 / 11-B6).
            <CameraPermissionPrompt perm={perm} request={requestPerm} place="scan" compact />
          ) : null}
          {perm?.granted ? (
            <View pointerEvents="none" style={st.frameWrap}>
              <View style={st.frame}>
                <View style={[st.corner, st.tl]} />
                <View style={[st.corner, st.tr]} />
                <View style={[st.corner, st.bl]} />
                <View style={[st.corner, st.br]} />
                <View style={st.laser} />
              </View>
              {keyboard ? null : (
                <View style={st.guide}>
                  <Text style={st.guideTxt}>{t('scan.guide')}</Text>
                </View>
              )}
            </View>
          ) : null}
          {perm?.granted ? (
            <IconButton
              icon="flash"
              dark
              label={torch ? t('scan.torchOff') : t('scan.torchOn')}
              onPress={() => setTorch((v) => !v)}
              style={[st.torch, torch && st.torchOn]}
            />
          ) : null}
          {checking || lastRead ? (
            <View style={st.readBox}>
              {checking ? <ActivityIndicator color={colors.primary} /> : <Icon name="check" color={colors.success} strokeWidth={2.4} />}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.readL}>{checking ? t('scan.checking') : t('scan.read')}</Text>
                <Text style={st.readTxt} numberOfLines={1}>
                  {lastRead}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
        {!online ? <Banner kind="warn" icon="cloudoff" text={t('today.offlineText')} /> : null}
        <View style={st.fld}>
          <Text style={st.lbl}>{t('scan.cantScan')}</Text>
          <View style={[st.inRow, inFocus && st.inRowOn]}>
            <TextInput
              ref={inputRef}
              value={manual}
              onChangeText={setManual}
              onSubmitEditing={() => accept(manual)}
              onFocus={() => setInFocus(true)}
              onBlur={() => setInFocus(false)}
              blurOnSubmit={false}
              autoFocus
              showSoftInputOnFocus={softKeyboard}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              placeholder={t('scan.placeholder')}
              placeholderTextColor={colors.placeholder}
              cursorColor={colors.primary}
              selectionColor="rgba(29,91,216,0.25)"
              style={[st.input, !manual && st.inputEmpty]}
              accessibilityLabel={t('scan.trackingNumber')}
            />
            <Pressable
              onPress={() => {
                setSoftKeyboard(true);
                inputRef.current?.blur();
                setTimeout(() => inputRef.current?.focus(), 60);
              }}
              style={({ pressed }) => [st.kbBtn, pressed && { backgroundColor: colors.surface2 }]}
              accessibilityRole="button"
              accessibilityLabel={t('scan.openKeyboard')}
            >
              <Icon name="keypad" color={colors.text2} size={22} />
            </Pressable>
          </View>
          {draft.trackingRaw ? (
            <Text style={st.prev} numberOfLines={1}>
              {t('scan.last')} <Text style={st.prevMono}>{draft.trackingRaw}</Text>
            </Text>
          ) : null}
        </View>
        {recent.length > 0 && !keyboard ? (
          <ListCard title={t('scan.recent')} meta={t('scan.recentCount', { n: recent.length })}>
            {recent.slice(0, 3).map((r, i, arr) => (
              <ListRow key={r.clientId} last={i === arr.length - 1} style={st.rr}>
                <View style={st.rrIn}>
                  <Text style={st.rrT} numberOfLines={1}>
                    {r.data.trackingRaw}
                  </Text>
                  <Text style={st.rrM} numberOfLines={1}>
                    {fmtNum(r.data.weightKg, 2)} kg · {fmtNum(desi({ l: r.data.lengthCm, w: r.data.widthCm, h: r.data.heightCm }, settings.desiDivisor), 2)}{' '}
                    {t('ui.desiUnit')}
                  </Text>
                  <StatusBadge status={r.status} />
                </View>
              </ListRow>
            ))}
          </ListCard>
        ) : null}
      </View>
      <Footer>
        <Button label={t('common.continue')} iconRight="arrow" onPress={() => accept(manual)} disabled={!manual.trim()} large />
      </Footer>
    </View>
  );
}

const C = 24;
const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, padding: 12, paddingBottom: 10, gap: 10 },
  view: { flex: 1, minHeight: 180, backgroundColor: colors.camera, overflow: 'hidden', borderRadius: radius.card },
  viewKb: { minHeight: 64 },
  torch: { position: 'absolute', top: 8, right: 8 },
  torchOn: { backgroundColor: colors.primary },
  frameWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  frame: { width: '64%', maxWidth: 260, aspectRatio: 1.7, justifyContent: 'center' },
  corner: { position: 'absolute', width: C, height: C, borderColor: '#fff' },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 10 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 10 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 10 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 10 },
  laser: { height: 2, borderRadius: 1, backgroundColor: colors.onNightAccent, marginHorizontal: 16 },
  guide: { marginTop: 10, backgroundColor: colors.scrim, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  guideTxt: { color: '#fff', fontSize: 12, lineHeight: 16, ...font.medium },
  readBox: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  readL: { fontSize: 11, lineHeight: 15, color: colors.text2, ...font.medium },
  readTxt: { color: colors.text, fontSize: 16, lineHeight: 22, ...font.monoSemibold },
  fld: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 10 },
  lbl: { fontSize: 12, lineHeight: 16, color: colors.text2, marginBottom: 6, ...font.medium },
  inRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
  },
  inRowOn: { borderColor: colors.primary, boxShadow: '0 0 0 1px #1d5bd8' },
  input: { flex: 1, height: 48, paddingHorizontal: 12, fontSize: 16, color: colors.text, ...font.monoSemibold },
  inputEmpty: { fontSize: 14, ...font.regular },
  kbBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    borderTopRightRadius: radius.control,
    borderBottomRightRadius: radius.control,
  },
  prev: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 6, ...font.regular },
  prevMono: { color: colors.text, ...font.mono },
  rr: { minHeight: 40, paddingVertical: 4 },
  rrIn: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rrT: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16, color: colors.text, ...font.mono },
  rrM: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
});
