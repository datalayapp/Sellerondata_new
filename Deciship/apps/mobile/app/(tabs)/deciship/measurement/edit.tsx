import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Api, jpegPart, type DimMethod, type MeasurementPatch, type MeasurementPayload, type PhotoKind } from '../../../../src/api/endpoints';
import { friendlyError } from '../../../../src/api/errors';
import { useAuth } from '../../../../src/auth/AuthContext';
import { useQueue } from '../../../../src/queue/QueueContext';
import type { QueueRow } from '../../../../src/queue/store';
import { Badge, Banner, Button, Card, EmptyState, Footer, Header, Screen, TextField } from '../../../../src/ui/components';
import { DimField } from '../../../../src/ui/DimField';
import { Icon } from '../../../../src/ui/Icon';
import { LiveCalc } from '../../../../src/ui/LiveCalc';
import { NumPad } from '../../../../src/ui/NumPad';
import { PhotoCapture } from '../../../../src/ui/PhotoCapture';
import { usePlausibilityCheck } from '../../../../src/ui/PlausibilityCheck';
import { PresetPicker } from '../../../../src/ui/PresetPicker';
import { lockedReason } from '../../../../src/draft/persist';
import { useToast } from '../../../../src/ui/Toast';
import { colors, font, radius } from '../../../../src/ui/theme';
import { dimMethodLabel, kindLabel, fmtInput, parseNum, showDecimal } from '../../../../src/lib/format';
import { deleteQuietly } from '../../../../src/lib/images';
import { emitMeasurementsChanged, measurementCache } from '../../../../src/lib/measurementCache';
import { createFormLoadGate, editFormKey } from '../../../../src/lib/formLoadGate';

/** Düzenleme öncesi değerler (sunucu ya da kuyruk kaydından). */
type Original = {
  trackingRaw: string;
  kg: number;
  l: number;
  w: number;
  h: number;
  dimMethod: DimMethod;
  boxPresetId: string | null;
  note: string;
  photos: EditPhoto[];
  version: number;
  row?: QueueRow;
};

type EditPhoto = { key: string; uri: string; kind: PhotoKind; /** sunucu fotoğraf id'si */ remoteId?: string; added?: boolean };

const sameNum = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.0005;
let seq = 0;

export default function EditMeasurement() {
  const { t } = useTranslation('measure');
  const params = useLocalSearchParams<{ id: string; local?: string }>();
  const isLocal = params.local === '1';
  const id = params.id;
  const { settings, presets } = useAuth();
  const { online, getLocal, editLocal, noteServerEdit } = useQueue();
  const toast = useToast();

  const [orig, setOrig] = useState<Original | null>(null);
  const [loadErr, setLoadErr] = useState<{ title: string; text: string } | null>(null);
  const [tracking, setTracking] = useState('');
  const [kgText, setKgText] = useState('');
  const [padOpen, setPadOpen] = useState(false);
  const [l, setL] = useState<number | null>(null);
  const [w, setW] = useState<number | null>(null);
  const [h, setH] = useState<number | null>(null);
  const [dimMethod, setDimMethod] = useState<DimMethod>('MANUAL');
  const [presetId, setPresetId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<EditPhoto[]>([]);
  const [cam, setCam] = useState<PhotoKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<{ title: string; text: string } | null>(null);
  const addedRef = useRef<string[]>([]);

  const init = useCallback((o: Original) => {
    setOrig(o);
    setTracking(o.trackingRaw);
    setKgText(fmtInput(o.kg, 3));
    setL(o.l);
    setW(o.w);
    setH(o.h);
    setDimMethod(o.dimMethod);
    setPresetId(o.boxPresetId);
    setNote(o.note);
    setPhotos(o.photos);
  }, []);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      if (isLocal) {
        const r = await getLocal(id);
        if (!r || (r.status !== 'PENDING' && r.status !== 'ERROR')) {
          setLoadErr({ title: t('edit.cannotEdit'), text: t('edit.cannotEditText') });
          return;
        }
        init({
          trackingRaw: r.data.trackingRaw,
          kg: r.data.weightKg,
          l: r.data.lengthCm,
          w: r.data.widthCm,
          h: r.data.heightCm,
          dimMethod: r.data.dimMethod,
          boxPresetId: r.data.boxPresetId ?? null,
          note: r.data.note ?? '',
          photos: r.photos.map((p, i) => ({ key: `q${i}`, uri: p.uri, kind: p.kind })),
          version: 1,
          row: r,
        });
      } else {
        const d = measurementCache.getDetail(id) ?? (await Api.measurement(id));
        measurementCache.put(d);
        init({
          trackingRaw: d.trackingRaw || d.trackingNo,
          kg: d.weightKg,
          l: d.lengthCm,
          w: d.widthCm,
          h: d.heightCm,
          dimMethod: d.dimMethod,
          boxPresetId: d.boxPresetId ?? null,
          note: d.note ?? '',
          photos: d.photos.map((p) => ({ key: p.id, uri: p.url, kind: p.kind, remoteId: p.id })),
          version: d.version ?? 1,
        });
      }
    } catch (e) {
      setLoadErr(friendlyError(e, 'load'));
    }
  }, [getLocal, id, init, isLocal, t]);

  // Form kayıt başına bir kez doldurulur: `t` ya da bağlam yenilenince (öne gelişte profil yenilemesi) yazılan ezilmez (G4).
  const [gate] = useState(createFormLoadGate);
  const formKey = editFormKey(id, isLocal);
  useEffect(() => {
    if (gate.claim(formKey)) void load();
  }, [formKey, gate, load]);

  // Kaydedilmeden çıkılırsa yeni çekilen geçici fotoğrafları temizle.
  useEffect(
    () => () => {
      addedRef.current.forEach(deleteQuietly);
    },
    [],
  );

  /* ─────────── Değişiklik ve doğrulama ─────────── */

  const kg = parseNum(kgText);
  const kgValid = kg !== null && kg > 0 && kg < 1000;
  const dimsValid = [l, w, h].every((v) => v !== null && v > 0 && v <= 400);
  const boxCount = photos.filter((p) => p.kind === 'PHOTO_BOX').length;
  const required = settings.requiredBoxPhotos;

  const changes = useMemo(() => {
    if (!orig) return null;
    const removed = orig.photos.filter((p) => !photos.some((x) => x.key === p.key));
    const added = photos.filter((p) => p.added);
    return {
      tracking: tracking.trim() !== orig.trackingRaw,
      weight: !sameNum(kg, orig.kg),
      dims: !sameNum(l, orig.l) || !sameNum(w, orig.w) || !sameNum(h, orig.h) || dimMethod !== orig.dimMethod || presetId !== orig.boxPresetId,
      note: note.trim() !== orig.note.trim(),
      removed,
      added,
    };
  }, [orig, tracking, kg, l, w, h, dimMethod, presetId, note, photos]);

  const photosChanged = !!changes && (changes.removed.length > 0 || changes.added.length > 0);
  const dirty = !!changes && (changes.tracking || changes.weight || changes.dims || changes.note || photosChanged);
  const needsNet = !isLocal && !online;

  const problems: string[] = [];
  if (!tracking.trim()) problems.push(t('edit.enterTracking'));
  if (!kgValid) problems.push(t('weight.enter'));
  if (!dimsValid) problems.push(t('dims.enterAll'));
  // Sunucu kuralı (§10.2.1): yalnızca düzenleme koli fotoğrafı sayısını eşiğin altına DÜŞÜRÜYORSA engellenir;
  // eşiği zaten karşılamayan eski kayıtlar fotoğraf eklenmeden de düzenlenebilir.
  const origBox = orig ? orig.photos.filter((p) => p.kind === 'PHOTO_BOX').length : 0;
  const photoShort = boxCount < required && boxCount < origBox;
  if (photoShort) problems.push(t('edit.addBoxPhoto', { boxCount, required }));

  // Akla aykırı değer (Y44): özetteki uyarının aynısı. Yalnız ölçü ya da ağırlık değiştiyse sorulur (eski değer kayıtta onaylanmıştı).
  const check = usePlausibilityCheck({ l, w, h, kg: kgValid ? kg : null, settings, active: !!changes && (changes.weight || changes.dims) });

  const preventRemove = usePreventRemove(dirty && !saving, ({ repeat }) => {
    Alert.alert(t('edit.unsaved'), t('edit.unsavedText'), [
      { text: t('edit.keepEditing'), style: 'cancel' },
      { text: t('edit.leave'), style: 'destructive', onPress: repeat },
    ]);
  });

  /* ─────────── Olaylar ─────────── */

  const setDim = (which: 'l' | 'w' | 'h', v: number | null) => {
    ({ l: setL, w: setW, h: setH })[which](v);
    setDimMethod('MANUAL');
    setPresetId(null);
  };

  const removePhoto = (p: EditPhoto) => {
    Haptics.selectionAsync().catch(() => undefined);
    setPhotos((list) => list.filter((x) => x.key !== p.key));
    if (p.added) {
      deleteQuietly(p.uri);
      addedRef.current = addedRef.current.filter((u) => u !== p.uri);
    }
  };

  const restoreRemoved = () => {
    if (!orig || !changes) return;
    setPhotos((list) => [...orig.photos.filter((p) => changes.removed.some((r) => r.key === p.key)), ...list]);
  };

  const save = async () => {
    if (!orig || !changes || problems.length || !dirty || needsNet || saving || check.needsConfirm) return;
    setSaving(true);
    setSaveErr(null);
    const done = (msg: string) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      emitMeasurementsChanged();
      toast.show({ text: msg, kind: 'success' });
      preventRemove();
      router.back();
    };
    try {
      if (isLocal && orig.row) {
        const r = orig.row;
        const data: MeasurementPayload = {
          ...r.data,
          trackingRaw: tracking.trim(),
          weightKg: kg!,
          weightMethod: changes.weight ? 'MANUAL' : r.data.weightMethod,
          lengthCm: l!,
          widthCm: w!,
          heightCm: h!,
          dimMethod,
          note: note.trim() || undefined,
        };
        if (changes.dims) {
          delete data.dimConfidence;
          if (presetId) data.boxPresetId = presetId;
          else delete data.boxPresetId;
        }
        const ok = await editLocal(r.clientId, data, photos.map((p) => ({ uri: p.uri, kind: p.kind })));
        if (!ok) {
          setSaving(false);
          // Bu arada gönderime alındıysa "gönderildi" denmez (Y48).
          const sending = lockedReason(await getLocal(r.clientId).catch(() => null)) === 'sending';
          Alert.alert(sending ? t('edit.sendingNow') : t('edit.sentMeanwhile'), sending ? t('edit.sendingNowText') : t('edit.sentMeanwhileText'), [
            { text: t('common.ok'), onPress: () => (preventRemove(), router.back()) },
          ]);
          return;
        }
        addedRef.current.forEach(deleteQuietly); // kuyruk klasörüne kopyalandı
        addedRef.current = [];
        done(t('edit.editedQueued'));
        return;
      }

      const patch: MeasurementPatch = {};
      if (changes.tracking) patch.trackingRaw = tracking.trim();
      if (changes.weight) {
        patch.weightKg = kg!;
        patch.weightMethod = 'MANUAL';
      }
      if (changes.dims) {
        patch.lengthCm = l!;
        patch.widthCm = w!;
        patch.heightCm = h!;
        patch.dimMethod = dimMethod;
        patch.boxPresetId = dimMethod === 'PRESET' ? presetId : null;
      }
      if (changes.note) patch.note = note.trim() || null;

      let body: Parameters<typeof Api.patchMeasurement>[1];
      if (photosChanged) {
        const fd = new FormData();
        fd.append(
          'data',
          JSON.stringify({
            ...patch,
            removePhotoIds: changes.removed.map((p) => p.remoteId).filter(Boolean),
            photoKinds: changes.added.map((p) => p.kind),
          }),
        );
        changes.added.forEach((p) => fd.append('photos', jpegPart(p.uri)));
        body = { form: fd };
      } else body = { json: patch };

      const next = await Api.patchMeasurement(id, body);
      measurementCache.replace(id, next);
      // Telefondaki gönderilmiş satır da yeni sürüme geçer ("Son okunanlar"). Yazılamazsa düzeltme yine kaydedilmiştir.
      await noteServerEdit(id, next).catch((e) => console.warn('queue sent edit', e));
      addedRef.current.forEach(deleteQuietly);
      addedRef.current = [];
      done(t('edit.savedVersion', { n: next.version ?? orig.version + 1 }));
    } catch (e) {
      const f = friendlyError(e, 'save');
      setSaveErr(f);
      setSaving(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    }
  };

  /* ─────────── Görünüm ─────────── */

  if (!orig) {
    return (
      <View style={{ flex: 1 }}>
        <Header title={t('edit.title')} back />
        <Screen>
          {loadErr ? (
            <EmptyState icon="warn" title={loadErr.title} text={loadErr.text} action={<Button label={t('common.retry')} kind="secondary" icon="sync" onPress={load} />} />
          ) : (
            <View style={{ paddingVertical: 64, alignItems: 'center' }}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          )}
        </Screen>
      </View>
    );
  }

  const footerLabel = needsNet
    ? t('edit.needsNet')
    : problems.length
      ? problems[0]!
      : !dirty
        ? t('edit.noChanges')
        : isLocal
          ? t('common.save')
          : t('edit.saveVersion', { n: orig.version + 1 });

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('edit.title')} subtitle={orig.trackingRaw} back />
      <Screen>
        {needsNet ? (
          <Banner kind="warn" icon="cloudoff" title={t('common.offline')} text={t('edit.offlineText')} />
        ) : isLocal ? (
          <Banner kind="warn" icon="clock" title={t('detail.notSent')} text={t('edit.localText')} />
        ) : (
          <Banner kind="info" icon="info" text={t('edit.versionText')} />
        )}
        {saveErr ? <Banner kind="error" title={saveErr.title} text={saveErr.text} /> : null}

        {/* Takip no */}
        <Card>
          <TextField
            label={t('summary.tracking')}
            value={tracking}
            onChangeText={setTracking}
            monoValue
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={200}
            error={!tracking.trim() ? t('edit.trackingEmpty') : null}
            hint={changes?.tracking ? t('edit.previous', { value: orig.trackingRaw }) : undefined}
          />
        </Card>

        {/* Ağırlık */}
        <Card>
          <SecHead title={t('summary.weight')} changed={changes?.weight} />
          <Pressable
            onPress={() => setPadOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={t('edit.weightA11y', { value: kgText || t('edit.empty') })}
            style={[st.display, padOpen && st.displayOn, !kgValid && st.displayErr]}
          >
            <Icon name="scale" size={22} color={padOpen ? colors.primary : colors.text3} />
            <View style={{ flex: 1 }} />
            <Text style={[st.val, !kgText && { color: colors.placeholder }]} numberOfLines={1} adjustsFontSizeToFit>
              {kgText ? showDecimal(kgText) : '0'}
            </Text>
            <Text style={st.unit}>kg</Text>
          </Pressable>
          {!kgValid ? (
            <Text style={st.err}>{t('edit.weightErr')}</Text>
          ) : (
            <Text style={st.help}>{padOpen ? t('edit.holdClear') : t('edit.tapChange')}</Text>
          )}
          {padOpen ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              <NumPad onChange={setKgText} maxDecimals={3} />
              <Button label={t('common.ok')} kind="secondary" icon="check" onPress={() => setPadOpen(false)} />
            </View>
          ) : null}
        </Card>

        {/* Ölçüler */}
        <Card>
          <SecHead
            title={t('dims.sizes')}
            changed={changes?.dims}
            right={<Badge label={dimMethodLabel(dimMethod)} kind="info" dot={false} />}
          />
          {presets.length > 0 ? (
            <View style={{ marginBottom: 10 }}>
              <Text style={st.sub}>{t('dims.preset')}</Text>
              <PresetPicker
                presets={presets}
                selectedId={dimMethod === 'PRESET' ? presetId : null}
                onPick={(p) => {
                  setL(p.lengthCm);
                  setW(p.widthCm);
                  setH(p.heightCm);
                  setDimMethod('PRESET');
                  setPresetId(p.id);
                }}
              />
            </View>
          ) : null}
          <Text style={st.sub}>{t('summary.manual')}</Text>
          <View style={st.dims}>
            <DimField label={t('dims.length')} value={l} onChange={(v) => setDim('l', v)} />
            <DimField label={t('dims.width')} value={w} onChange={(v) => setDim('w', v)} />
            <DimField label={t('dims.height')} value={h} onChange={(v) => setDim('h', v)} />
          </View>
          {!dimsValid ? <Text style={st.err}>{t('edit.dimsErr')}</Text> : null}
        </Card>

        <LiveCalc l={l} w={w} h={h} kg={kgValid ? kg : null} desiDivisor={settings.desiDivisor} />

        {/* Fotoğraflar */}
        <Card>
          <SecHead
            title={t('photos.title')}
            changed={photosChanged}
            right={<Badge label={t('photos.boxBadge', { boxCount, required })} kind={boxCount < required ? 'warning' : 'success'} />}
          />
          {photoShort ? (
            <Banner
              kind="warn"
              icon="camera"
              text={t('edit.photoShort', { count: required })}
              style={{ marginBottom: 8 }}
            />
          ) : null}
          <View style={st.grid}>
            {photos.map((p) => (
              <View key={p.key} style={st.cell}>
                <View>
                  <Image source={{ uri: p.uri }} style={st.img} />
                  {p.added ? (
                    <View style={st.newTag}>
                      <Text style={st.newTxt}>{t('edit.new')}</Text>
                    </View>
                  ) : null}
                  <Pressable
                    onPress={() => removePhoto(p)}
                    hitSlop={8}
                    style={({ pressed }) => [st.del, pressed && { backgroundColor: colors.dangerBg }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('edit.removePhoto', { kind: kindLabel(p.kind) })}
                  >
                    <Icon name="close" size={16} color={colors.danger} strokeWidth={2.4} />
                  </Pressable>
                </View>
                <Text style={st.cap} numberOfLines={1}>
                  {kindLabel(p.kind)}
                </Text>
              </View>
            ))}
            <Pressable style={st.cell} onPress={() => setCam('PHOTO_BOX')} accessibilityRole="button" accessibilityLabel={t('edit.addBoxLabel')}>
              {({ pressed }) => (
                <View style={[st.add, boxCount < required && st.addReq, pressed && { backgroundColor: colors.primarySoft }]}>
                  <Icon name="camera" size={26} color={boxCount < required ? colors.primary : colors.text2} />
                  <Text style={[st.addTxt, boxCount < required && { color: colors.primary }]}>{t('photos.boxPhoto')}</Text>
                </View>
              )}
            </Pressable>
          </View>
          {changes && changes.removed.length > 0 ? (
            <View style={st.removed}>
              <Text style={st.removedTxt}>{t('edit.removedOnSave', { count: changes.removed.length })}</Text>
              <Button label={t('common.undo')} kind="ghost" icon="undo" small onPress={restoreRemoved} />
            </View>
          ) : null}
          <View style={st.extra}>
            <Button label={kindLabel('PHOTO_LABEL')} kind="secondary" icon="plus" onPress={() => setCam('PHOTO_LABEL')} style={{ flex: 1 }} />
            <Button label={kindLabel('PHOTO_OTHER')} kind="secondary" icon="plus" onPress={() => setCam('PHOTO_OTHER')} style={{ flex: 1 }} />
          </View>
        </Card>

        {/* Not */}
        <Card>
          <TextField
            label={t('summary.note')}
            value={note}
            onChangeText={setNote}
            placeholder={t('summary.notePlaceholder')}
            maxLength={500}
            multiline
            inputStyle={{ minHeight: 72, textAlignVertical: 'top', paddingTop: 12 }}
          />
        </Card>
      </Screen>
      <Footer>
        {/* Özetteki gibi: onay olmadan Kaydet kapalı, neden düğmenin hemen üstünde. Tuş takımı açıkken uyarı gösterilmez
            (G6): sabit alt şeridi büyütüp tuş takımının "Tamam" düğmesini örtüyordu; "Tamam"a basınca çıkar. */}
        {!problems.length && !needsNet && !padOpen ? check.banner : null}
        <Button
          label={footerLabel}
          icon={dirty && !problems.length && !needsNet ? 'check' : needsNet ? 'cloudoff' : undefined}
          onPress={save}
          loading={saving}
          disabled={!dirty || problems.length > 0 || needsNet || saving || check.needsConfirm}
          large
        />
      </Footer>
      <PhotoCapture
        visible={cam !== null}
        title={cam ? t('photos.captureTitle', { kind: kindLabel(cam) }) : ''}
        hint={cam === 'PHOTO_BOX' ? t('photos.captureHint') : undefined}
        onClose={() => setCam(null)}
        onCapture={(p) => {
          if (cam) {
            addedRef.current.push(p.uri);
            setPhotos((list) => [...list, { key: `n${++seq}`, uri: p.uri, kind: cam, added: true }]);
          }
          setCam(null);
        }}
      />
    </View>
  );
}

function SecHead({ title, changed, right }: { title: string; changed?: boolean; right?: React.ReactNode }) {
  const { t } = useTranslation('measure');
  return (
    <View style={st.hd}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        <Text style={st.secH}>{title}</Text>
        {changed ? <Badge label={t('edit.changed')} kind="warning" dot /> : null}
      </View>
      {right}
    </View>
  );
}

const st = StyleSheet.create({
  hd: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, minHeight: 22, gap: 8 },
  secH: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  sub: { fontSize: 12, lineHeight: 16, color: colors.text2, marginBottom: 4, ...font.medium },
  display: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.card,
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  displayOn: { borderWidth: 2, borderColor: colors.primary, paddingHorizontal: 11 },
  displayErr: { borderColor: colors.danger },
  val: { fontSize: 34, lineHeight: 42, color: colors.text, flexShrink: 1, ...font.semibold, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 16, color: colors.text2, marginLeft: 8, marginTop: 8, ...font.regular },
  help: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 4, ...font.regular },
  err: { fontSize: 12, lineHeight: 16, color: colors.danger, marginTop: 4, ...font.medium },
  dims: { flexDirection: 'row', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 },
  cell: { width: '31.6%' },
  img: { width: '100%', aspectRatio: 1, borderRadius: radius.control, backgroundColor: '#1b2433', borderWidth: 1, borderColor: colors.border },
  del: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 36,
    height: 36,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  newTag: { position: 'absolute', left: 4, bottom: 4, backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  newTxt: { color: '#fff', fontSize: 11, lineHeight: 15, ...font.semibold },
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
  removed: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 },
  removedTxt: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  extra: { flexDirection: 'row', gap: 8, marginTop: 10 },
});
