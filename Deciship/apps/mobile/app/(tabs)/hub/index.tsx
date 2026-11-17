import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { fetchOverview } from '../../../src/hub/api';
import { PRODUCTS, type HubAlert, type HubTone, type ProductKey } from '../../../src/hub/contracts';
import { hubValue, kpiDelta } from '../../../src/hub/format';
import { Glyph } from '../../../src/hub/glyphs';
import { useHub } from '../../../src/hub/HubContext';
import { TimeSeries } from '../../../src/hub/TimeSeries';
import { DeltaText, hub, HubFilters, HubPage, KpiLedger, LinkMark, LinkRow, SectionBoundary, SectionError, Skel, StaleNote, useAgo } from '../../../src/hub/ui';
import { useHubResource } from '../../../src/hub/useHubResource';
import { WEB_ROUTES } from '../../../src/hub/links';
import { overviewTool, overviewView, type OverviewView } from '../../../src/hub/views';
import { Badge, Banner, Button, EmptyState } from '../../../src/ui/components';
import { Icon, type IconName } from '../../../src/ui/Icon';
import { colors, font, hubColors, radius, type as typo } from '../../../src/ui/theme';

const TONE_ICON: Record<HubTone, { icon: IconName; color: string }> = {
  bad: { icon: 'warn', color: colors.danger },
  warning: { icon: 'warn', color: colors.warning },
  info: { icon: 'info', color: hubColors.ink },
  neutral: { icon: 'info', color: colors.text3 },
  good: { icon: 'check', color: colors.success },
};

/** Baş rakam önce: dönemin en önemli sayısı, önceki dönemle farkı, seyri. */
function Lead({ view }: { view: OverviewView }) {
  const { t } = useTranslation('hub');
  const { fmt, linkOf } = useHub();
  const lead = view.lead!;
  const delta = kpiDelta(lead, fmt);
  const details = linkOf(lead.href);
  return (
    <View>
      <View style={st.leadBody}>
        <Text style={st.leadLabel}>{lead.label}</Text>
        <Text style={[st.hero, lead.tone === 'bad' && { color: colors.danger }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {hubValue(lead, fmt)}
        </Text>
        {delta ? (
          <View style={st.leadDelta}>
            <DeltaText delta={delta} />
            <Text style={st.leadPrev} numberOfLines={1}>
              {t('overview.previous', { value: delta.previous })}
            </Text>
          </View>
        ) : null}
        {lead.trend?.length ? (
          <View style={st.trend}>
            <TimeSeries series={lead.trend} chart="line" format={lead.format} currency={lead.currency} height={148} label={lead.label} />
          </View>
        ) : null}
        {lead.hint ? <Text style={st.leadHint}>{lead.hint}</Text> : null}
      </View>
      {details.kind !== 'none' ? (
        <LinkRow href={lead.href} style={[st.detailRow, hub.hair]}>
          <Text style={st.detailTxt}>{t('overview.details')}</Text>
          <LinkMark href={lead.href} />
        </LinkRow>
      ) : null}
      {view.rest.length ? (
        <View style={hub.hair}>
          <KpiLedger items={view.rest} />
        </View>
      ) : null}
    </View>
  );
}

function AlertRow({ a, first }: { a: HubAlert; first: boolean }) {
  const { t } = useTranslation('hub');
  const { fmt, linkOf } = useHub();
  const agoText = useAgo();
  const tone = TONE_ICON[a.tone] ?? TONE_ICON.neutral;
  const amount = a.amount ? hubValue(a.amount, fmt) : null;
  const hasLink = linkOf(a.href).kind !== 'none';
  const when = a.at ? agoText(a.at) : null;
  return (
    <LinkRow href={a.href} label={[a.title, a.body, amount, when].filter(Boolean).join('. ')} style={[st.alert, !first && hub.hair]}>
      <View style={st.alertIcon}>
        <Icon name={tone.icon} size={20} color={tone.color} strokeWidth={2} />
      </View>
      <View style={st.alertMain}>
        <Text style={st.alertTitle}>{a.title}</Text>
        {a.body ? <Text style={st.alertBody}>{a.body}</Text> : null}
        {when ? <Text style={st.alertWhen}>{when}</Text> : null}
        {amount || hasLink ? (
          <View style={st.alertFoot}>
            <Text style={[st.alertAmount, a.tone === 'bad' && { color: colors.danger }]} numberOfLines={1}>
              {amount ?? ''}
            </Text>
            {hasLink ? (
              <View style={st.alertAction}>
                <Text style={st.alertActionTxt} numberOfLines={1}>
                  {a.actionLabel ?? t('queue.open')}
                </Text>
                {linkOf(a.href).kind === 'web' ? <Glyph name="external" size={14} color={hubColors.ink} /> : <Icon name="chev" size={14} color={hubColors.ink} strokeWidth={2.2} />}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </LinkRow>
  );
}

function Queue({ alerts }: { alerts: HubAlert[] }) {
  const { t } = useTranslation('hub');
  return (
    <>
      <View style={hub.sectionHead}>
        <Text style={hub.sectionTitle}>{t('queue.title')}</Text>
        {alerts.length ? (
          <View style={hub.count}>
            <Text style={hub.countTxt}>{alerts.length}</Text>
          </View>
        ) : null}
      </View>
      {alerts.length ? (
        <View style={hub.sheet}>
          {alerts.map((a, i) => (
            <AlertRow key={a.id} a={a} first={i === 0} />
          ))}
        </View>
      ) : (
        <EmptyState icon="check" title={t('queue.emptyTitle')} text={t('queue.emptyBody')} />
      )}
    </>
  );
}

/**
 * Ayrıntılı analiz web'de (telefonda Analiz yok): baş rakamın hemen altında koyu kart, seçili aracın web analizini açar.
 * Yalnız o araçta rapor izni olana (web `/analytics` kapısı); izni yoksa web de açmaz, kart çizilmez.
 */
function WebAnalyticsCard({ tool }: { tool: ProductKey }) {
  const { t } = useTranslation('hub');
  const { reportTools, openWeb } = useHub();
  if (!reportTools.includes(tool)) return null;
  return (
    <View style={st.web}>
      <Text style={st.webTitle}>{t('webCard.title')}</Text>
      <Text style={st.webBody}>{t('webCard.body')}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('webCard.action')}
        accessibilityHint={t('link.webHint')}
        onPress={() => openWeb(WEB_ROUTES.analytics(tool))}
        style={({ pressed }) => [st.webBtn, pressed && { opacity: 0.85 }]}
      >
        <Text style={st.webBtnTxt}>{t('webCard.action')}</Text>
        <Glyph name="external" size={16} color={colors.text} />
      </Pressable>
    </View>
  );
}

function LoadingBody() {
  return (
    <>
      <View style={[hub.sheet, hub.sheetPad, { gap: 12 }]} accessibilityState={{ busy: true }}>
        <Skel w="45%" />
        <Skel w="70%" h={40} />
        <Skel w="55%" />
        <Skel h={148} />
      </View>
      <View style={[hub.sheet, hub.sheetPad, { gap: 16 }]}>
        <Skel w="80%" />
        <Skel w="65%" />
        <Skel w="72%" />
      </View>
    </>
  );
}

function NoTool() {
  const { t } = useTranslation('hub');
  const { canTeam, open } = useHub();
  return (
    <EmptyState
      icon="user"
      title={t('noTool.title')}
      text={t('noTool.body')}
      action={canTeam ? <Button small kind="secondary" label={t('noTool.action')} onPress={() => open('/account/team')} /> : undefined}
    />
  );
}

export default function Overview() {
  const { t } = useTranslation('hub');
  const { scope, lng, tools, tool: choice, from, to, open } = useHub();
  // Her zaman tek aracın özeti. Seçim yoksa ya da izinsizse ilk açık araç.
  const tool = overviewTool(choice, tools);
  const key = tool ? `${scope}:${lng}:overview:${tool}:${from}:${to}` : null;
  const res = useHubResource(key, () => fetchOverview(tool!, from, to));
  const name = tool ? PRODUCTS[tool].name : '';
  const view = res.data ? overviewView(res.data) : null;

  return (
    <HubPage onRefresh={res.refresh}>
      <HubFilters tools={tools} />
      {!tool || res.status === 'forbidden' ? <NoTool /> : null}
      {tool && res.status === 'loading' ? <LoadingBody /> : null}
      {tool && res.status === 'error' ? <SectionError title={t('overview.sectionError', { name })} kind={res.failed} onRetry={() => void res.refresh()} /> : null}
      {tool && view ? (
        <SectionBoundary fallback={<SectionError title={t('overview.sectionError', { name })} kind="server" onRetry={() => void res.refresh()} />}>
          <StaleNote failed={res.failed} at={res.at} onRetry={() => void res.refresh()} />
          <View style={{ gap: 10, opacity: res.holding ? 0.5 : 1 }}>
            {view.setup.state === 'open' ? (
              <Banner
                kind="warn"
                title={t('setup.title', { name })}
                text={view.setup.label}
                action={
                  <Button
                    small
                    kind="secondary"
                    label={t('setup.action')}
                    onPress={() => {
                      if (view.setup.state === 'open') open(view.setup.href);
                    }}
                  />
                }
              />
            ) : null}
            {view.noData ? (
              view.setup.state !== 'open' ? <EmptyState icon="info" title={t('noData.title')} text={t('noData.body')} /> : null
            ) : (
              <View style={hub.sheet}>
                <Lead view={view} />
              </View>
            )}
            <WebAnalyticsCard tool={tool} />
            <Queue alerts={view.alerts} />
            {view.setup.state === 'done' ? (
              <View style={st.setupDone}>
                <Badge kind="success" icon="check" label={t('setup.done', { name })} />
              </View>
            ) : null}
          </View>
        </SectionBoundary>
      ) : null}
    </HubPage>
  );
}

const st = StyleSheet.create({
  leadBody: { padding: 12 },
  leadLabel: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  hero: { ...typo.display, marginTop: 2 },
  leadDelta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, marginTop: 2 },
  leadPrev: { ...typo.small, flexShrink: 1 },
  trend: { marginTop: 12 },
  leadHint: { ...typo.small, marginTop: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: 12 },
  detailTxt: { fontSize: 13, lineHeight: 18, color: hubColors.ink, ...font.medium },

  alert: { flexDirection: 'row', gap: 10, padding: 12, minHeight: 56 },
  alertIcon: { width: 20, paddingTop: 1 },
  alertMain: { flex: 1, minWidth: 0, gap: 2 },
  alertTitle: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.medium },
  alertBody: { fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  alertWhen: { ...typo.small },
  alertFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 },
  alertAmount: { flexShrink: 1, fontSize: 14, lineHeight: 20, color: colors.text, ...font.monoSemibold },
  alertAction: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  alertActionTxt: { fontSize: 13, lineHeight: 18, color: hubColors.ink, ...font.medium, flexShrink: 1 },

  setupDone: { alignItems: 'flex-start', marginTop: 4 },

  web: { backgroundColor: hubColors.ink, borderRadius: radius.card, padding: 14, gap: 8 },
  webTitle: { fontSize: 15, lineHeight: 20, color: colors.surface, ...font.semibold },
  webBody: { fontSize: 13, lineHeight: 18, color: '#c9d3e8', ...font.regular },
  webBtn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 14, marginTop: 4, borderRadius: radius.control, backgroundColor: hubColors.sun },
  webBtnTxt: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
});
