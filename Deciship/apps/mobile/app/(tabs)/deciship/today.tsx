import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Api, type MeasurementItem } from '../../../src/api/endpoints';
import { ApiError } from '../../../src/api/client';
import { friendlyError } from '../../../src/api/errors';
import { useAuth } from '../../../src/auth/AuthContext';
import { scopeKey } from '../../../src/auth/token';
import { useQueue } from '../../../src/queue/QueueContext';
import { useDraft } from '../../../src/draft/DraftContext';
import { resumeStep } from '../../../src/draft/persist';
import { ExpiredDraftNotice } from '../../../src/draft/ExpiredDraftNotice';
import { Banner, Button, EmptyState, Footer, Header } from '../../../src/ui/components';
import { OtherSessionsBanner } from '../../../src/ui/OtherSessionsBanner';
import { Icon } from '../../../src/ui/Icon';
import { MeasurementRow, type MeasurementRowItem } from '../../../src/ui/MeasurementRow';
import { colors, font, radius } from '../../../src/ui/theme';
import { fmtToday, fmtWhen, isToday, startOfToday } from '../../../src/lib/format';
import { measurementCache, useMeasurementsChanged } from '../../../src/lib/measurementCache';
import { openMeasurement } from '../../../src/lib/navigation';
import { useDeciShipTabs } from '../../../src/ui/DeciShipTabs';
import { todayCount as countToday } from '../../../src/lib/todayCount';
import { listReloadNeeded } from '../../../src/lib/listReload';

type Item = MeasurementRowItem;

export default function Today() {
  const { t } = useTranslation('measure');
  const { t: tAuth } = useTranslation('auth');
  const { me, settings, refreshProfile, access, scope } = useAuth();
  const tabs = useDeciShipTabs('today');
  const sessionKey = scopeKey(scope);
  const { rows, pending, errors, online, flushing, flush, reload, serverIssue } = useQueue();
  const { draft, ready, hasContent, missingPhotos, ackMissingPhotos, reset } = useDraft();
  const params = useLocalSearchParams<{ saved?: string }>();
  // "Kaydedildi" bilgisi kısa süre görünür; sonra listeyi kalabalıklaştırmasın.
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!params.saved) return;
    setSavedMsg(params.saved);
    router.setParams({ saved: undefined });
  }, [params.saved]);
  // Zamanlayıcı ayrı tutulur: setParams parametreyi temizleyince yukarıdaki etki yeniden çalışır
  // ve kendi zamanlayıcısını iptal ederdi; bilgi hiç kapanmazdı.
  useEffect(() => {
    if (!savedMsg) return;
    const t = setTimeout(() => setSavedMsg(null), 5000);
    return () => clearTimeout(t);
  }, [savedMsg]);
  const [server, setServer] = useState<MeasurementItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Sunucu listesi bu oturumda en az bir kez geldiyse gönderilmiş kayıtlar oradan gösterilir (düzeltme/silme yansısın). */
  const [loadedAt, setLoadedAt] = useState(0);
  /** Sunucunun bugün sayacı (11-B13; liste 200 ile sınırlı). `from`: hangi günün sayısı; gün değişince kullanılmaz. */
  const [stats, setStats] = useState<{ count: number; from: number } | null>(null);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const my = ++loadSeq.current;
    setLoading(true);
    try {
      const startedAt = Date.now();
      const from = startOfToday();
      // Sayaç yoksa (eski sunucu) ya da hata verirse sayı listeden sayılır.
      const statsCall = Api.todayStats().catch(() => null);
      const list = await Api.todayMeasurements(from);
      // Firma değişti ya da daha yeni istek var.
      if (my !== loadSeq.current) return;
      measurementCache.putMany(list);
      setServer(list);
      setLoadedAt(startedAt);
      setLoadError(null);
      const s = await statsCall;
      if (my === loadSeq.current && s && s.count !== null) setStats({ count: s.count, from: from.getTime() });
    } catch (e) {
      if (my === loadSeq.current) setLoadError(e instanceof ApiError && e.isNetwork ? null : friendlyError(e, 'load').text);
    } finally {
      if (my === loadSeq.current) setLoading(false);
    }
  }, []);

  // Firma değişti: önceki firmanın listesi bir an bile görünmez.
  const shownKey = useRef(sessionKey);
  useEffect(() => {
    if (shownKey.current === sessionKey) return;
    shownKey.current = sessionKey;
    setServer([]);
    setLoadedAt(0);
    setStats(null);
    if (sessionKey) load();
  }, [sessionKey, load]);

  // Firma saat dilimi profil yenilenince değişti: "bugün" başka bir anda başlar, liste yeniden alınır (11-B7).
  const orgTimeZone = me?.activeOrg?.timeZone;
  const shownTimeZone = useRef(orgTimeZone);
  useEffect(() => {
    if (shownTimeZone.current === orgTimeZone) return;
    shownTimeZone.current = orgTimeZone;
    if (sessionKey) load();
  }, [orgTimeZone, sessionKey, load]);

  useFocusEffect(
    useCallback(() => {
      reload();
      load();
      flush();
    }, [reload, load, flush]),
  );

  useMeasurementsChanged(() => {
    reload();
    load();
  });

  // Kuyruk boşaldı ya da bağlantı geri geldi: liste aşağı çekmeden bir kez yeniden istenir, eski hata kutusu kalmaz.
  const queueState = useRef({ waiting: pending + errors, online });
  useEffect(() => {
    const prev = queueState.current;
    const next = { waiting: pending + errors, online };
    queueState.current = next;
    if (sessionKey && listReloadNeeded(prev, next, loadError !== null || loadedAt === 0)) load();
  }, [pending, errors, online, sessionKey, loadError, loadedAt, load]);

  const items = useMemo<Item[]>(() => {
    // Gönderilmiş ve sunucu listesi ondan sonra yüklenmiş kayıtlar sunucudan gösterilir (düzeltme/silme yansısın).
    const shownLocal = rows.filter((r) => !(loadedAt > 0 && r.status === 'SENT' && (r.sentAt ?? 0) <= loadedAt));
    const local: Item[] = shownLocal
      .map((r) => ({
        key: r.clientId,
        serverId: r.status === 'SENT' ? r.serverId : null,
        clientId: r.clientId,
        trackingRaw: r.data.trackingRaw,
        l: r.data.lengthCm,
        w: r.data.widthCm,
        h: r.data.heightCm,
        kg: r.data.weightKg,
        dimMethod: r.data.dimMethod,
        measuredAt: r.data.measuredAt,
        status: r.status,
        error: r.lastError,
        photoCount: r.data.photoKinds.length,
      }));
    // Yalnızca listede gösterilen yerel kayıtların sunucu karşılığı ayıklanır; gizlenenler sunucudan gelir.
    const known = new Set(shownLocal.map((r) => r.serverId).filter(Boolean));
    const remote: Item[] = server
      .filter((m) => !known.has(m.id) && isToday(m.measuredAt))
      .map((m) => ({
        key: m.id,
        serverId: m.id,
        trackingRaw: m.trackingRaw || m.trackingNo,
        l: m.lengthCm,
        w: m.widthCm,
        h: m.heightCm,
        kg: m.weightKg,
        dimMethod: m.dimMethod,
        measuredAt: m.measuredAt,
        status: 'SENT',
        photoCount: m.photoCount ?? 0,
        version: m.version,
        byName: access.canViewAll && m.measuredBy && m.measuredBy.id !== me?.activeOrg?.membershipId ? m.measuredBy.name : undefined,
      }));
    return [...local, ...remote].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
  }, [rows, server, loadedAt, me, access.canViewAll]);

  const todayCount = countToday({
    listCount: items.filter((i) => isToday(i.measuredAt)).length,
    serverCount: stats && stats.from === startOfToday().getTime() ? stats.count : null,
    unsentToday: rows.filter((r) => r.status !== 'SENT' && isToday(r.data.measuredAt)).length,
  });

  const resumeDraft = () => {
    ackMissingPhotos();
    router.push(`/deciship/${resumeStep(draft, settings.requiredBoxPhotos)}`);
  };

  const beginFresh = () => {
    reset(true);
    router.push('/deciship/scan');
  };

  const discardDraft = () =>
    Alert.alert(t('draft.discardAsk'), t('draft.discardText'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('draft.discard'), style: 'destructive', onPress: () => reset(true) },
    ]);

  // Taslak diskten okunmadan yeni ölçüm başlamaz: boş taslak yarım ölçümü ezmesin.
  const startNew = () => {
    if (!access.canCapture || !ready) return;
    if (!hasContent) return beginFresh();
    Alert.alert(t('draft.newAsk'), t('draft.newAskText'), [
      { text: t('draft.newAskResume'), onPress: resumeDraft },
      { text: t('draft.newAskDiscard'), style: 'destructive', onPress: beginFresh },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  const showDraft = ready && hasContent && access.canCapture;

  const waiting = pending + errors;
  const header = (
    <View style={{ gap: 10, marginBottom: 10 }}>
      {access.state === 'read_only' ? (
        <Banner kind="warn" title={tAuth('access.readOnlyTitle')} text={tAuth('access.readOnlyText')} />
      ) : !access.canCapture ? (
        <Banner kind="info" title={tAuth('access.noCaptureTitle')} text={tAuth('access.noCaptureText')} />
      ) : null}
      <OtherSessionsBanner />
      <ExpiredDraftNotice />
      {showDraft ? (
        <View style={st.draft}>
          <View style={st.draftHd}>
            <Icon name="edit" size={18} color={colors.primary} strokeWidth={2} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.draftT}>{t('draft.title')}</Text>
              <Text style={st.draftS} numberOfLines={1}>
                {draft.trackingRaw.trim() ? <Text style={st.draftTrk}>{draft.trackingRaw}</Text> : t('draft.noTracking')}
                {' · '}
                {t('draft.started', { time: fmtWhen(new Date(draft.startedAt).toISOString()) })}
              </Text>
              {missingPhotos > 0 ? <Text style={st.draftWarn}>{t('draft.photosMissing', { count: missingPhotos })}</Text> : null}
            </View>
          </View>
          <View style={st.draftBtns}>
            <Button label={t('draft.resume')} kind="secondary" icon="arrow" small onPress={resumeDraft} style={{ flex: 1 }} />
            <Button label={t('draft.discard')} kind="danger" icon="trash" small onPress={discardDraft} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
      {savedMsg ? <Banner kind="ok" title={t('today.saved')} text={t('today.savedText', { tracking: savedMsg })} /> : null}
      {waiting > 0 || !online ? (
        // Çevrimdışı ve kuyruk tek kutuda: ne bekliyor, ne olacak, elle gönder. Bağlantı yokken bekleyen ölçüm varsa
        // uygulama kapanmadan önce internete bağlanılmalı (arka plan görevi yok); ayrı şerit yok (G6).
        <View style={[st.queue, errors > 0 ? st.queueErr : null]}>
          <Icon name={!online ? 'cloudoff' : errors > 0 ? 'warn' : 'clock'} size={18} color={errors > 0 ? colors.danger : colors.warningInk} strokeWidth={2} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={[st.queueT, errors > 0 && { color: '#7a1a12' }]}>{waiting > 0 ? t('today.waiting', { count: waiting }) : t('common.offline')}</Text>
            <Text style={[st.queueS, errors > 0 && { color: '#7a1a12' }]}>
              {!online ? t(pending > 0 ? 'today.offlineUnsentText' : 'today.offlineText') : flushing ? t('today.sending') : serverIssue ? t('today.serverIssue') : t('today.willRetry')}
            </Text>
          </View>
          {waiting > 0 && online ? <Button label={t('common.send')} kind="secondary" icon="send" small onPress={() => flush(true)} loading={flushing} /> : null}
        </View>
      ) : null}
      {loadError ? <Banner kind="error" title={t('today.loadFailed')} text={t('today.loadFailedText', { error: loadError })} /> : null}
      <View style={st.stats}>
        <StatCell n={todayCount} label={t('today.statMeasured')} />
        <View style={st.statDiv} />
        <StatCell n={pending} label={t('today.statQueued')} tone={pending > 0 ? colors.warning : undefined} />
        <View style={st.statDiv} />
        <StatCell n={errors} label={t('today.statFailed')} tone={errors > 0 ? colors.danger : undefined} />
      </View>
      {items.length > 0 ? (
        <View style={st.listH}>
          <Text style={st.listHT} accessibilityRole="header">
            {t('today.listTitle')}
          </Text>
          <Text style={st.listHM}>{t('today.divisor', { n: settings.desiDivisor })}</Text>
        </View>
      ) : null}
    </View>
  );
  const allLabel = access.canViewAll ? t('today.allAdmin') : t('today.allMine');

  return (
    <View style={{ flex: 1 }}>
      <Header
        tabs={tabs}
        title={t('today.title')}
        subtitle={`${fmtToday()} · ${(me?.orgs.length ?? 0) > 1 ? (me?.activeOrg?.name ?? '') : (me?.person.name ?? '')}`}
        subtitleMono={false}
      />
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            colors={[colors.primary]}
            onRefresh={() => {
              refreshProfile();
              load();
              flush(true);
            }}
          />
        }
        renderItem={({ item, index }) => (
          <MeasurementRow item={item} desiDivisor={settings.desiDivisor} first={false} last={index === items.length - 1} onPress={() => openMeasurement(item)} />
        )}
        ListEmptyComponent={<EmptyState icon="box" title={t('today.empty')} text={t(access.canCapture ? 'today.emptyText' : 'today.emptyTextNoCapture')} />}
        ListFooterComponent={
          items.length > 0 ? (
            <Pressable onPress={() => router.push('/deciship/history')} accessibilityRole="button" style={({ pressed }) => [st.all, pressed && { backgroundColor: colors.surface2 }]}>
              <Text style={st.allT}>{allLabel}</Text>
              <Icon name="chev" size={18} color={colors.primary} strokeWidth={2} />
            </Pressable>
          ) : undefined
        }
      />
      {access.canCapture ? (
        <Footer>
          <Button label={t('common.newMeasurement')} icon="scan" onPress={startNew} large />
        </Footer>
      ) : null}
    </View>
  );
}

function StatCell({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <View style={st.stat}>
      <Text style={[st.statN, tone ? { color: tone } : null]}>{n}</Text>
      {/* Otomatik yazı küçültme Android'de kısa etiketi birkaç piksele indiriyordu; uzun etiket alt satıra geçer. */}
      <Text style={st.statL} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  stats: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
  },
  stat: { flex: 1, paddingHorizontal: 12 },
  statDiv: { width: 1, backgroundColor: colors.border },
  statN: { fontSize: 22, lineHeight: 28, color: colors.text, ...font.monoSemibold },
  statL: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: radius.card,
    backgroundColor: colors.warningBg,
  },
  queueErr: { backgroundColor: colors.dangerBg },
  draft: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 10 },
  draftHd: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  draftT: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold },
  draftS: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  draftTrk: { color: colors.text, ...font.monoSemibold },
  draftWarn: { fontSize: 12, lineHeight: 17, color: colors.warningInk, marginTop: 2, ...font.medium },
  draftBtns: { flexDirection: 'row', gap: 8 },
  queueT: { fontSize: 13, lineHeight: 18, color: colors.warningInk, ...font.semibold },
  queueS: { fontSize: 12, lineHeight: 17, color: colors.warningInk, ...font.regular },
  listH: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
    marginBottom: -10,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  listHT: { fontSize: 12, lineHeight: 16, color: colors.text, ...font.semibold },
  listHM: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  all: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48, marginTop: 6 },
  allT: { fontSize: 13, lineHeight: 18, color: colors.primary, ...font.semibold },
});
