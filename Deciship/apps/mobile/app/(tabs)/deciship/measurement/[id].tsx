import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Api, type DimMethod, type MeasurementDetail, type PhotoKind, type WeightMethod } from '../../../../src/api/endpoints';
import { friendlyError } from '../../../../src/api/errors';
import { useAuth } from '../../../../src/auth/AuthContext';
import { useQueue } from '../../../../src/queue/QueueContext';
import type { QueueRow } from '../../../../src/queue/store';
import { Badge, Banner, Button, Card, EmptyState, Footer, Header, OverflowMenu, Screen } from '../../../../src/ui/components';
import { Icon } from '../../../../src/ui/Icon';
import { LiveCalc } from '../../../../src/ui/LiveCalc';
import { StatusBadge, type RowStatus } from '../../../../src/ui/MeasurementRow';
import { PhotoViewer, type ViewerPhoto } from '../../../../src/ui/PhotoViewer';
import { useToast } from '../../../../src/ui/Toast';
import { colors, font, radius } from '../../../../src/ui/theme';
import { dimMethodLabel, kindLabel, fmtDateTime, fmtDims, fmtNum } from '../../../../src/lib/format';
import { emitMeasurementsChanged, measurementCache } from '../../../../src/lib/measurementCache';

/** Detayda gösterilen ortak biçim: sunucu kaydı ya da kuyruktaki (gönderilmemiş) kayıt. */
type Model = {
  local: boolean;
  id: string;
  trackingRaw: string;
  l: number;
  w: number;
  h: number;
  kg: number;
  dimMethod: DimMethod;
  weightMethod: WeightMethod;
  dimConfidence: number | null;
  measuredAt: string;
  note: string | null;
  version: number;
  byName: string | null;
  status: RowStatus;
  error: string | null;
  photos: (ViewerPhoto & { kind: PhotoKind })[] | null;
  canEdit: boolean;
  superseded: boolean;
};

function fromServer(m: MeasurementDetail | ReturnType<typeof measurementCache.get>): Model | null {
  if (!m) return null;
  return {
    local: false,
    id: m.id,
    trackingRaw: m.trackingRaw || m.trackingNo,
    l: m.lengthCm,
    w: m.widthCm,
    h: m.heightCm,
    kg: m.weightKg,
    dimMethod: m.dimMethod,
    weightMethod: m.weightMethod,
    dimConfidence: m.dimConfidence ?? null,
    measuredAt: m.measuredAt,
    note: m.note ?? null,
    version: m.version ?? 1,
    byName: m.measuredBy?.name ?? null,
    status: 'SENT',
    error: null,
    photos: 'photos' in m ? m.photos.map((p) => ({ key: p.id, uri: p.url, kind: p.kind, label: kindLabel(p.kind) })) : null,
    canEdit: 'photos' in m ? m.canEdit !== false : true,
    superseded: !!m.superseded,
  };
}

function fromLocal(r: QueueRow): Model {
  return {
    local: true,
    id: r.clientId,
    trackingRaw: r.data.trackingRaw,
    l: r.data.lengthCm,
    w: r.data.widthCm,
    h: r.data.heightCm,
    kg: r.data.weightKg,
    dimMethod: r.data.dimMethod,
    weightMethod: r.data.weightMethod,
    dimConfidence: r.data.dimConfidence ?? null,
    measuredAt: r.data.measuredAt,
    note: r.data.note ?? null,
    version: 1,
    byName: null,
    status: r.status,
    error: r.lastError,
    photos: r.photos.map((p, i) => ({ key: `${i}-${p.uri}`, uri: p.uri, kind: p.kind, label: kindLabel(p.kind) })),
    canEdit: r.status === 'PENDING' || r.status === 'ERROR',
    superseded: false,
  };
}

export default function MeasurementDetailScreen() {
  const { t } = useTranslation('measure');
  const params = useLocalSearchParams<{ id: string; local?: string }>();
  const isLocal = params.local === '1';
  const { settings, access } = useAuth();
  const { online, getLocal, removeLocal, undoRemoveLocal, purgeLocal } = useQueue();
  const toast = useToast();
  const [id, setId] = useState(params.id);
  const [m, setM] = useState<Model | null>(() => (isLocal ? null : fromServer(measurementCache.get(params.id))));
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<{ title: string; text: string } | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      if (isLocal) {
        const r = await getLocal(id);
        if (r && r.status === 'SENT' && r.serverId) {
          // Bu arada gönderildi: sunucudaki kayda geç.
          router.replace({ pathname: '/deciship/measurement/[id]', params: { id: r.serverId } });
          return;
        }
        if (!r) setLoadErr({ title: t('detail.notFound'), text: t('detail.notFoundText') });
        setM(r ? fromLocal(r) : null);
      } else {
        const cur = measurementCache.resolve(id);
        if (cur !== id) setId(cur);
        const cached = measurementCache.getDetail(cur);
        if (cached) setM(fromServer(cached));
        const d = await Api.measurement(cur);
        measurementCache.put(d);
        setM(fromServer(d));
      }
    } catch (e) {
      setLoadErr(friendlyError(e, 'load'));
    } finally {
      setLoading(false);
    }
  }, [id, isLocal, getLocal, t]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const openEdit = () => {
    if (!m) return;
    router.push({ pathname: '/deciship/measurement/edit', params: { id: m.id, ...(m.local ? { local: '1' } : {}) } });
  };

  const doDelete = async () => {
    if (!m) return;
    setDeleting(true);
    const label = m.trackingRaw;
    try {
      if (m.local) {
        const row = await removeLocal(m.id);
        if (!row) {
          Alert.alert(t('errors.title.delete'), t('detail.deleteBusy'));
          return;
        }
        emitMeasurementsChanged();
        toast.show({
          text: t('detail.deleted', { label }),
          action: {
            label: t('common.undo'),
            onPress: async () => {
              await undoRemoveLocal(row);
              emitMeasurementsChanged();
              toast.show({ text: t('detail.restored'), kind: 'success' });
            },
          },
          onExpire: () => purgeLocal(row.clientId),
        });
      } else {
        const sid = m.id;
        await Api.deleteMeasurement(sid);
        emitMeasurementsChanged();
        toast.show({
          text: t('detail.deleted', { label }),
          action: {
            label: t('common.undo'),
            onPress: async () => {
              try {
                const r = await Api.restoreMeasurement(sid);
                measurementCache.put(r);
                emitMeasurementsChanged();
                toast.show({ text: t('detail.restored'), kind: 'success' });
              } catch (e) {
                const f = friendlyError(e, 'restore');
                toast.show({ text: f.text, kind: 'error', durationMs: 7000 });
              }
            },
          },
        });
      }
      router.back();
    } catch (e) {
      const f = friendlyError(e, 'delete');
      Alert.alert(f.title, f.text);
    } finally {
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (!m) return;
    if (!m.local && !online) {
      Alert.alert(t('errors.network.title'), t('detail.deleteOffline'));
      return;
    }
    Alert.alert(
      t('detail.deleteAsk'),
      m.local ? t('detail.deleteLocalText', { tracking: m.trackingRaw }) : t('detail.deleteText', { tracking: m.trackingRaw }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: doDelete },
      ],
    );
  };

  const photos = m?.photos ?? null;
  // Abonelik salt okunursa sunucudaki kayıt değişmez. Kuyruktaki kayıt telefonda düzeltilebilir.
  const canEdit = !!m && m.canEdit && (m.local || access.canWrite);

  return (
    <View style={{ flex: 1 }}>
      <Header
        title={t('detail.title')}
        subtitle={m?.trackingRaw}
        back
        right={
          canEdit ? (
            // Silme nadir: üst çubuktaki ⋯ menüsünde. Birincil eylem Düzenle.
            <OverflowMenu onNight items={[{ label: t('common.delete'), icon: 'trash', danger: true, disabled: deleting, onPress: confirmDelete }]} />
          ) : undefined
        }
      />
      {!m ? (
        <Screen>
          {loading ? (
            <View style={st.center}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : (
            <EmptyState
              icon="warn"
              title={loadErr?.title ?? t('errors.title.load')}
              text={loadErr?.text ?? t('detail.openFailed')}
              action={<Button label={t('common.retry')} kind="secondary" icon="sync" onPress={load} />}
            />
          )}
        </Screen>
      ) : (
        <>
          <Screen>
            {m.local ? (
              m.status === 'ERROR' ? (
                <Banner
                  kind="error"
                  title={t('detail.errorTitle')}
                  text={t('detail.errorText', { error: m.error ?? t('detail.rejected') })}
                />
              ) : m.status === 'SENDING' ? (
                // Gönderilmekte olan kayıt "henüz gönderilmedi" diye sunulmaz (Y48).
                <Banner kind="info" icon="sync" title={t('ui.status.sending')} text={t('detail.sendingText')} />
              ) : (
                <Banner kind="warn" icon="clock" title={t('detail.notSent')} text={t('detail.waitingText')} />
              )
            ) : null}
            {!m.local && !online ? (
              <Banner kind="warn" icon="cloudoff" title={t('common.offline')} text={t('detail.offlineText')} />
            ) : null}
            {m.superseded ? <Banner kind="info" text={t('detail.superseded')} /> : null}
            {loadErr && !m.local && online ? <Banner kind="error" title={loadErr.title} text={loadErr.text} /> : null}

            <Card style={{ gap: 6 }}>
              <View>
                <Text style={st.lbl}>{t('summary.tracking')}</Text>
                <Text style={st.trk} selectable>
                  {m.trackingRaw}
                </Text>
              </View>
              <View style={st.pills}>
                {m.local && m.status !== 'SENDING' ? (
                  <Badge label={t('detail.notSent')} kind={m.status === 'ERROR' ? 'danger' : 'warning'} />
                ) : (
                  <StatusBadge status={m.local ? 'SENDING' : 'SENT'} />
                )}
                {m.version > 1 ? <Badge label={t('detail.edited', { n: m.version })} kind="info" icon="edit" /> : null}
              </View>
              <View style={st.metaRow}>
                <Icon name="clock" size={14} color={colors.text2} strokeWidth={2} />
                <Text style={st.meta}>
                  {fmtDateTime(m.measuredAt)}
                  {m.byName ? ` · ${m.byName}` : ''}
                </Text>
              </View>
            </Card>

            <Card style={{ paddingVertical: 0 }}>
              <Line label={t('summary.weight')}>
                <Text style={st.v}>
                  {fmtNum(m.kg, 2)}
                  <Text style={st.u}> kg</Text>
                </Text>
                <Badge label={m.weightMethod === 'OCR' ? t('summary.fromPhoto') : t('summary.manual')} kind={m.weightMethod === 'OCR' ? 'info' : 'neutral'} dot={false} />
              </Line>
              <View style={st.div} />
              <Line label={t('summary.dims')}>
                <Text style={st.v} numberOfLines={1}>
                  {fmtDims(m.l, m.w, m.h)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Badge label={dimMethodLabel(m.dimMethod)} kind="info" dot={false} />
                  {m.dimConfidence !== null ? (
                    <Badge label={`%${Math.round(m.dimConfidence * 100)}`} kind={m.dimConfidence >= 0.7 ? 'success' : 'warning'} dot={false} />
                  ) : null}
                </View>
              </Line>
            </Card>

            <LiveCalc l={m.l} w={m.w} h={m.h} kg={m.kg} desiDivisor={settings.desiDivisor} />

            <Card>
              <View style={st.cardHd}>
                <Text style={st.secH}>{photos ? t('summary.photos', { n: photos.length }) : t('photos.title')}</Text>
                {photos && photos.length ? <Text style={st.secS}>{t('detail.tapEnlarge')}</Text> : null}
              </View>
              {photos === null ? (
                <View style={st.photoLoading}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={st.secS}>{t('detail.photosLoading')}</Text>
                </View>
              ) : photos.length === 0 ? (
                <Text style={st.none}>{t('summary.noPhotos')}</Text>
              ) : (
                <View style={st.grid}>
                  {photos.map((p, i) => (
                    <Pressable
                      key={p.key}
                      style={st.cell}
                      onPress={() => setViewer(i)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={t('detail.enlarge', { label: p.label })}
                    >
                      {({ pressed }) => (
                        <>
                          <Image source={{ uri: p.uri }} style={[st.img, pressed && { opacity: 0.8 }]} />
                          <Text style={st.cap} numberOfLines={1}>
                            {p.label}
                          </Text>
                        </>
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
            </Card>

            <Card>
              <Text style={[st.secH, { marginBottom: 4 }]}>{t('detail.note')}</Text>
              {m.note ? <Text style={st.note}>{m.note}</Text> : <Text style={st.none}>{t('detail.noNote')}</Text>}
            </Card>

            {!canEdit && !m.local && !m.superseded ? <Banner kind="info" text={t('detail.viewOnly')} /> : null}
          </Screen>
          {canEdit ? (
            <Footer>
              <Button label={t('common.edit')} icon="edit" onPress={openEdit} loading={deleting} disabled={deleting} large />
            </Footer>
          ) : null}
          <PhotoViewer photos={photos ?? []} index={viewer} onClose={() => setViewer(null)} />
        </>
      )}
    </View>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={st.line}>
      <Text style={st.lbl}>{label}</Text>
      <View style={st.lineRow}>{children}</View>
    </View>
  );
}

const st = StyleSheet.create({
  center: { paddingVertical: 48, alignItems: 'center' },
  lbl: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  trk: { fontSize: 18, lineHeight: 24, color: colors.text, ...font.monoSemibold },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  line: { paddingVertical: 8 },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 1 },
  div: { height: 1, backgroundColor: colors.borderSoft, marginHorizontal: -10 },
  v: { fontSize: 16, lineHeight: 22, color: colors.text, flexShrink: 1, ...font.semibold, fontVariant: ['tabular-nums'] },
  u: { fontSize: 12, color: colors.text2, ...font.regular },
  cardHd: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  secH: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  secS: { fontSize: 12, color: colors.text2, ...font.regular },
  photoLoading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31.6%' },
  img: { width: '100%', aspectRatio: 1, borderRadius: radius.control, backgroundColor: '#1b2433', borderWidth: 1, borderColor: colors.border },
  cap: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 3, ...font.medium },
  none: { fontSize: 13, lineHeight: 18, color: colors.text2, ...font.regular },
  note: { fontSize: 14, lineHeight: 20, color: colors.text, ...font.regular },
});
