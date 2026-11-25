import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Api, type MeasurementItem } from '../../../src/api/endpoints';
import { friendlyError } from '../../../src/api/errors';
import { useAuth } from '../../../src/auth/AuthContext';
import { scopeKey } from '../../../src/auth/token';
import { useQueue } from '../../../src/queue/QueueContext';
import { Banner, Button, EmptyState, Header } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/Icon';
import { MeasurementRow, type MeasurementRowItem } from '../../../src/ui/MeasurementRow';
import { colors, font, radius } from '../../../src/ui/theme';
import { dayKey, fmtDayTitle, fmtNum } from '../../../src/lib/format';
import { measurementCache, useMeasurementsChanged } from '../../../src/lib/measurementCache';
import { openMeasurement } from '../../../src/lib/navigation';
import { packagingOf } from '../../../src/lib/packaging';
import { useDeciShipTabs } from '../../../src/ui/DeciShipTabs';

const PAGE_SIZE = 30;

export default function History() {
  const { t } = useTranslation('measure');
  const { me, settings, access, scope } = useAuth();
  const tabs = useDeciShipTabs('history');
  const sessionKey = scopeKey(scope);
  const { online } = useQueue();
  const isAdmin = access.canViewAll;
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MeasurementItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState<'first' | 'more' | 'refresh' | null>('first');
  const [err, setErr] = useState<{ title: string; text: string } | null>(null);
  const reqId = useRef(0);

  // Arama kutusu: yazmayı bırakınca (300 ms) ara.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    async (p: number, mode: 'first' | 'more' | 'refresh') => {
      const my = ++reqId.current;
      setLoading(mode);
      setErr(null);
      try {
        const r = await Api.listMeasurements({ q: q || undefined, page: p, pageSize: PAGE_SIZE });
        if (my !== reqId.current) return;
        measurementCache.putMany(r.items);
        setItems((prev) => {
          if (p === 1) return r.items;
          const seen = new Set(prev.map((x) => x.id));
          return [...prev, ...r.items.filter((x) => !seen.has(x.id))];
        });
        setTotal(r.total);
        setPage(p);
      } catch (e) {
        if (my === reqId.current) setErr(friendlyError(e, 'load'));
      } finally {
        if (my === reqId.current) setLoading(null);
      }
    },
    // Firma değişince liste baştan okunur.
    [q, sessionKey],
  );

  useEffect(() => {
    fetchPage(1, 'first');
  }, [fetchPage]);

  useMeasurementsChanged(() => fetchPage(1, 'refresh'));

  const hasMore = total !== null && items.length < total;
  const loadMore = () => {
    if (loading || !hasMore || err) return;
    fetchPage(page + 1, 'more');
  };

  const sections = useMemo(() => {
    const map = new Map<string, { title: string; data: MeasurementRowItem[] }>();
    for (const m of items) {
      const k = dayKey(m.measuredAt);
      let s = map.get(k);
      if (!s) {
        s = { title: fmtDayTitle(m.measuredAt), data: [] };
        map.set(k, s);
      }
      s.data.push({
        key: m.id,
        serverId: m.id,
        trackingRaw: m.trackingRaw || m.trackingNo,
        l: m.lengthCm,
        w: m.widthCm,
        h: m.heightCm,
        kg: m.weightKg,
        dimMethod: m.dimMethod,
        packaging: packagingOf(m),
        measuredAt: m.measuredAt,
        status: 'SENT',
        photoCount: m.photoCount ?? 0,
        version: m.version,
        byName: isAdmin && m.measuredBy && m.measuredBy.id !== me?.activeOrg?.membershipId ? m.measuredBy.name : undefined,
      });
    }
    return [...map.values()];
  }, [items, isAdmin, me, t]);

  const subtitle =
    total === null
      ? isAdmin
        ? t('history.subtitleAdmin')
        : t('history.subtitleMine')
      : q
        ? t('history.countQuery', { count: total, n: fmtNum(total, 0), q })
        : t('history.count', { count: total, n: fmtNum(total, 0) });

  return (
    <View style={{ flex: 1 }}>
      <Header tabs={tabs} title={isAdmin ? t('today.allAdmin') : t('today.allMine')} subtitle={subtitle} subtitleMono={false} />
      <View style={st.searchBar}>
        <View style={st.search}>
          <Icon name="search" size={18} color={colors.text2} strokeWidth={2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('history.search')}
            placeholderTextColor={colors.placeholder}
            cursorColor={colors.primary}
            selectionColor="rgba(29,91,216,0.25)"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => setQ(query.trim())}
            style={[st.searchInput, !query && st.searchPh]}
            accessibilityLabel={t('history.searchLabel')}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('history.clear')} style={st.clear}>
              <Icon name="close" size={18} color={colors.text2} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.key}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: 12, paddingTop: 0, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        renderSectionHeader={({ section }) => (
          <View style={st.day}>
            <Text style={st.dayT} accessibilityRole="header">
              {section.title}
            </Text>
            <Text style={st.dayN}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item, index, section }) => (
          <MeasurementRow
            item={item}
            desiDivisor={settings.desiDivisor}
            first={false}
            last={index === section.data.length - 1}
            onPress={() => openMeasurement(item)}
          />
        )}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={loading === 'refresh'} colors={[colors.primary]} onRefresh={() => fetchPage(1, 'refresh')} />}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            {!online ? <Banner kind="warn" icon="cloudoff" title={t('common.offline')} text={t('history.offlineText')} /> : null}
            {err && items.length > 0 ? (
              <Banner kind="error" title={err.title} text={err.text} action={<Button label={t('common.retry')} kind="secondary" small icon="sync" onPress={() => fetchPage(hasMore ? page + 1 : 1, hasMore ? 'more' : 'refresh')} />} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading === 'first' ? (
            <View style={st.center}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : err ? (
            <EmptyState icon="warn" title={err.title} text={err.text} action={<Button label={t('common.retry')} kind="secondary" icon="sync" onPress={() => fetchPage(1, 'first')} />} />
          ) : q ? (
            <EmptyState icon="search" title={t('history.noResults')} text={t('history.noResultsText', { q })} />
          ) : (
            <EmptyState icon="box" title={t('history.empty')} text={t('history.emptyText')} />
          )
        }
        ListFooterComponent={
          items.length > 0 ? (
            <View style={st.footer}>
              {loading === 'more' ? (
                <ActivityIndicator color={colors.primary} />
              ) : hasMore ? (
                <Button label={t('history.loadMore')} kind="ghost" onPress={loadMore} small />
              ) : (
                <Text style={st.end}>{t('history.end', { count: total ?? items.length, n: fmtNum(total ?? items.length, 0) })}</Text>
              )}
            </View>
          ) : undefined
        }
      />
    </View>
  );
}

const st = StyleSheet.create({
  searchBar: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingLeft: 10,
    paddingRight: 0,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, minHeight: 46, fontSize: 15, color: colors.text, ...font.mono },
  searchPh: { ...font.regular },
  clear: { width: 48, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: radius.control },
  day: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 36,
    marginTop: 10,
    paddingHorizontal: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  dayT: { fontSize: 12, lineHeight: 16, color: colors.text, ...font.semibold },
  dayN: { fontSize: 12, color: colors.text2, ...font.mono },
  center: { paddingVertical: 48, alignItems: 'center' },
  footer: { paddingVertical: 12, alignItems: 'center' },
  end: { fontSize: 12, color: colors.text2, ...font.regular },
});
