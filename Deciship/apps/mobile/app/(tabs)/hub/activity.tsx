import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../src/auth/AuthContext';
import { groupByDay, mergeFeeds, readAudit, type ActivityItem, type AuditPage, type LoadedFeed } from '../../../src/hub/activity';
import { ORG_ROLE_LABEL, PRODUCTS, PRODUCT_KEYS, type HubActivityPage, type OrgRole } from '../../../src/hub/contracts';
import { ProductMark } from '../../../src/hub/glyphs';
import { useHub } from '../../../src/hub/HubContext';
import { WEB_ROUTES } from '../../../src/hub/links';
import { hub, HubPage, LinkRow, SectionError, Skel, StaleNote, WebLink } from '../../../src/hub/ui';
import { useFeed, type Feed } from '../../../src/hub/useActivity';
import { dayKey, fmtDayTitle, fmtTime } from '../../../src/lib/format';
import { Button, EmptyState } from '../../../src/ui/components';
import { useToast } from '../../../src/ui/Toast';
import { colors, font, hubColors, type as typo } from '../../../src/ui/theme';

/** Kaynağın adı: hesap olayları "Hesap", araç olayları aracın adı. */
function useSourceName() {
  const { t } = useTranslation('hub');
  return (source: Feed['source']) => (source === 'platform' ? t('activity.platform') : PRODUCTS[source].name);
}

function Row({ item, first }: { item: ActivityItem; first: boolean }) {
  const { t } = useTranslation('hub');
  const sourceName = useSourceName();
  const who = item.actor ?? t('activity.system');
  const time = fmtTime(item.at);
  return (
    <LinkRow href={item.href} label={[sourceName(item.source), who, item.action, item.target, time].filter(Boolean).join('. ')} style={[st.row, !first && hub.hair]}>
      <View style={st.mark}>{item.source === 'platform' ? <View style={st.dot} /> : <ProductMark product={item.source} size={18} />}</View>
      <View style={st.main}>
        <Text style={st.what}>
          <Text style={st.who}>{who}</Text> {item.action}
        </Text>
        {item.target ? (
          <Text style={st.detail} numberOfLines={2}>
            {item.target}
          </Text>
        ) : null}
      </View>
      <Text style={st.time}>{time}</Text>
    </LinkRow>
  );
}

/**
 * Etkinlik (web Merkez `/activity` ile aynı kaynaklar): hesap olayları (yalnız yönetici) + rapor izni olan araçların akışı,
 * günlere ayrılmış. Süzgeç yok; süzgeçler ve tüm geçmiş için altta web bağlantısı. Bir kaynak düşerse yalnız o kaynak hata gösterir.
 */
export default function Activity() {
  const { t } = useTranslation('hub');
  const { canTeam, reportTools, lng } = useHub();
  const { me } = useAuth();
  const toast = useToast();
  const sourceName = useSourceName();
  const locale = lng === 'en' ? 'en' : 'tr';
  // Kanca sayısı sabit: hesap + kayıttaki her araç; açık olanlar `enabled`.
  const platform = useFeed('platform', canTeam);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- PRODUCT_KEYS modül sabiti: kanca sayısı ve sırası değişmez.
  const tools = PRODUCT_KEYS.map((key) => useFeed(key, reportTools.includes(key)));
  const feeds = [platform, ...tools].filter((f) => (f.source === 'platform' ? canTeam : reportTools.includes(f.source)) && f.first.status !== 'forbidden');

  const orgRole = (role: string) => ORG_ROLE_LABEL[role as OrgRole]?.[locale] ?? role;
  const loaded: LoadedFeed[] = feeds.map((f) => ({
    source: f.source,
    pages: f.source === 'platform' ? (f.pages as AuditPage[]).map((p) => ({ ...p, items: p.items.map((it) => readAudit(it, t, locale, orgRole, me)) })) : (f.pages as HubActivityPage[]),
  }));
  const items = mergeFeeds(loaded);
  // Gün firma saat diliminde (web Y132 ile aynı): `lib/format` `dayKey`; başlık "Bugün", "Dün", sonra tarih.
  const groups = groupByDay(items, dayKey);

  const loading = feeds.some((f) => f.first.status === 'loading');
  const errors = feeds.filter((f) => f.first.status === 'error');
  const stale = feeds.find((f) => f.first.failed && f.first.data);
  const more = feeds.some((f) => f.hasMore);
  const loadingMore = feeds.some((f) => f.loadingMore);
  const refresh = () => Promise.allSettled(feeds.map((f) => f.first.refresh()));
  const loadMore = async () => {
    const kinds = await Promise.all(feeds.filter((f) => f.hasMore && !f.loadingMore).map((f) => f.loadMore()));
    const failed = kinds.find((k) => k !== null);
    if (failed) toast.show({ text: t(failed === 'network' ? 'error.network' : 'error.server'), kind: 'error' });
  };

  return (
    <HubPage onRefresh={refresh}>
      {errors.map((f) => (
        <SectionError key={f.source} title={t('activity.sourceError', { name: sourceName(f.source) })} kind={f.first.failed} onRetry={() => void f.first.refresh()} />
      ))}
      {stale ? <StaleNote failed={stale.first.failed} at={stale.first.at} onRetry={() => void refresh()} /> : null}
      {loading && items.length === 0 ? (
        <View style={[hub.sheet, hub.sheetPad, { gap: 16 }]} accessibilityState={{ busy: true }}>
          <Skel w="70%" />
          <Skel w="55%" />
          <Skel w="80%" />
          <Skel w="60%" />
        </View>
      ) : null}
      {!loading && items.length === 0 && errors.length === 0 ? <EmptyState icon="clock" title={t('activity.emptyTitle')} text={t('activity.emptyBody')} /> : null}
      {groups.map((g) => (
        <View key={g.day} style={st.day}>
          <Text style={st.dayTitle} accessibilityRole="header">
            {fmtDayTitle(g.items[0]!.at)}
          </Text>
          <View style={hub.sheet}>
            {g.items.map((it, i) => (
              <Row key={`${it.source}-${it.id}`} item={it} first={i === 0} />
            ))}
          </View>
        </View>
      ))}
      {more ? <Button kind="secondary" label={t('activity.more')} loading={loadingMore} onPress={() => void loadMore()} /> : null}
      <WebLink label={t('activity.web')} path={WEB_ROUTES.activity} />
    </HubPage>
  );
}

const st = StyleSheet.create({
  day: { gap: 6 },
  dayTitle: { ...typo.label, color: colors.text2, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, minHeight: 56 },
  mark: { width: 28, height: 28, borderRadius: 6, backgroundColor: hubColors.inkSoft, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: hubColors.ink },
  main: { flex: 1, minWidth: 0, gap: 2 },
  what: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.regular },
  who: { ...font.semibold },
  detail: { ...typo.small },
  time: { fontSize: 12, lineHeight: 17, color: colors.text3, ...font.mono },
});
