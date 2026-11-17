import { Component, useCallback, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Locale, MeResponse } from '@sellerondata/contracts';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { authErrorKey } from '../auth/errors';
import { useQueue } from '../queue/QueueContext';
import { Badge, Banner, Button, useBottomInset } from '../ui/components';
import { pickOrg } from '../ui/orgPick';
import { Icon } from '../ui/Icon';
import { colors, font, hubColors, radius, space, touch, type as typo } from '../ui/theme';
import { PRODUCTS, type HubKpi, type ProductKey } from './contracts';
import { overviewTool, toolPickerItems } from './views';
import { ago, dateRange, hubValue, kpiDelta, RANGE_KEYS, updatedAt, type Ago, type Delta, type RangeKey } from './format';
import { Glyph, ProductMark } from './glyphs';
import { useHub } from './HubContext';

export const TOUCH = touch.min;

/* ───────────────────────── Sayfa iskeleti ───────────────────────── */

/** Kaydırılan sayfa + çekip yenileme. Yenileme kişinin yetkisini de tazeler. */
export function HubPage({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const bottom = useBottomInset();
  const { refreshMe } = useHub();
  const [pulling, setPulling] = useState(false);
  const pull = useCallback(async () => {
    setPulling(true);
    await Promise.allSettled([refreshMe(), onRefresh()]);
    setPulling(false);
  }, [refreshMe, onRefresh]);
  return (
    <ScrollView
      style={st.page}
      contentContainerStyle={[st.pageBody, { paddingBottom: 24 + bottom }]}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} colors={[hubColors.ink]} tintColor={hubColors.ink} />}
    >
      {children}
    </ScrollView>
  );
}

/* ───────────────────────── Seçiciler ───────────────────────── */

export function Segmented<K extends string>({
  items,
  value,
  onChange,
  label,
  role = 'radio',
}: {
  items: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  role?: 'radio' | 'tab';
}) {
  return (
    <View style={st.seg} accessibilityRole={role === 'tab' ? 'tablist' : 'radiogroup'} accessibilityLabel={label}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole={role}
            accessibilityState={{ selected: on, checked: role === 'radio' ? on : undefined }}
            onPress={() => onChange(it.key)}
            style={({ pressed }) => [st.segItem, on && st.segOn, pressed && !on && st.segPressed]}
          >
            <Text style={[st.segTxt, on && st.segTxtOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Araç seçimi (web Merkez ile aynı, Tümü yok): açık araçlar · yakında gelenler. Seçim yoksa ilk açık araç seçili görünür.
 * Hazır olmayan araç görünür ama dokunulmaz. Kişinin erişmediği hazır araç gizlenir.
 */
export function ToolPicker({ tools }: { tools: ProductKey[] }) {
  const { t } = useTranslation('hub');
  const { tool, setTool } = useHub();
  const { me } = useAuth();
  const current = overviewTool(tool, tools);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.tools} accessibilityLabel={t('tools.label')} style={st.toolsBleed}>
      {toolPickerItems(tools, me).map(({ key, state }) => {
        const def = PRODUCTS[key];
        if (state === 'soon') {
          return (
            <View key={key} style={[st.tool, st.toolSoon]} accessible accessibilityLabel={`${def.name}, ${t('tools.soon')}`} accessibilityState={{ disabled: true }}>
              <ProductMark product={key} size={18} muted />
              <Text style={st.toolSoonTxt} numberOfLines={1}>
                {def.name}
              </Text>
              <Text style={st.soonTag}>{t('tools.soon')}</Text>
            </View>
          );
        }
        const on = key === current;
        return (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={def.name}
            onPress={() => setTool(key)}
            style={({ pressed }) => [st.tool, on && st.toolOn, pressed && !on && st.segPressed]}
          >
            <ProductMark product={key} size={18} />
            <Text style={[st.toolTxt, on && st.toolTxtOn]} numberOfLines={1}>
              {def.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Tek süzgeç bloğu (Genel Bakış), kapsadığı her şeyin üstünde: araç, dönem ve dönemin tarihleri. */
export function HubFilters({ tools }: { tools: ProductKey[] }) {
  const { t } = useTranslation('hub');
  const { range, setRange, from, to, lng } = useHub();
  const items = RANGE_KEYS.map((key) => ({ key, label: t(`period.${key}`) }));
  return (
    <View style={st.filters}>
      <ToolPicker tools={tools} />
      <Segmented<RangeKey> items={items} value={range} onChange={setRange} label={t('period.label')} />
      <Text style={st.rangeTxt} numberOfLines={2}>
        {dateRange(from, to, lng)}
      </Text>
    </View>
  );
}

/* ───────────────────────── Değerler ───────────────────────── */

const DELTA_COLOR = { good: colors.success, bad: colors.danger, neutral: colors.text3 } as const;

export function useAgo() {
  const { t } = useTranslation('hub');
  const { lng, fmt } = useHub();
  const timeZone = fmt.timeZone;
  return useCallback(
    (iso: string) => {
      const a: Ago = ago(iso, lng, Date.now(), timeZone);
      return a.unit === 'date' ? a.text : t(`ago.${a.unit}`, { n: a.n });
    },
    [lng, timeZone, t],
  );
}

/** Yön ikonu + değer. Renk tek başına anlam taşımaz. */
export function DeltaText({ delta }: { delta: Delta | null }) {
  const { t } = useTranslation('hub');
  if (!delta) return null;
  const color = DELTA_COLOR[delta.tone];
  const said = t(`delta.${delta.dir}`, { amount: delta.amount, previous: delta.previous });
  return (
    <View style={st.delta} accessible accessibilityLabel={said}>
      <Glyph name={delta.dir === 'up' ? 'up' : delta.dir === 'down' ? 'down' : 'flat'} size={14} color={color} strokeWidth={2.4} />
      <Text style={[st.deltaTxt, { color }]}>{delta.dir === 'flat' ? t('delta.same') : delta.amount}</Text>
    </View>
  );
}

/** Satır sonu ikonu: uygulama içi ok ya da web'e çıkış. Metin hint ekran okuyucuya söyler. */
export function LinkMark({ href }: { href?: string | null }) {
  const { linkOf } = useHub();
  const link = linkOf(href);
  if (link.kind === 'none') return null;
  return link.kind === 'web' ? <Glyph name="external" size={16} color={colors.text3} /> : <Icon name="chev" size={16} color={colors.text3} strokeWidth={2} />;
}

/** Bağlantılıysa dokunulur satır, değilse düz satır. */
export function LinkRow({ href, label, style, children }: { href?: string | null; label?: string; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { t } = useTranslation('hub');
  const { open, linkOf } = useHub();
  const link = linkOf(href);
  if (link.kind === 'none') {
    return (
      <View style={style} accessible={!!label} accessibilityLabel={label}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={link.kind === 'web' ? t('link.webHint') : undefined}
      onPress={() => open(href)}
      style={({ pressed }) => [style, pressed && st.pressed]}
    >
      {children}
    </Pressable>
  );
}

/** KPI cetveli: kutu değil satır. Etiket solda, sayı sağda aynı hizada, fark altında. */
export function KpiLedger({ items }: { items: HubKpi[] }) {
  const { fmt } = useHub();
  return (
    <View>
      {items.map((k, i) => {
        const value = hubValue(k, fmt);
        return (
          <LinkRow key={k.id} href={k.href} label={`${k.label}: ${value}`} style={[st.ledgerRow, i > 0 && st.hair]}>
            <View style={st.ledgerMain}>
              <Text style={st.ledgerLabel}>{k.label}</Text>
              {k.hint ? <Text style={st.ledgerHint}>{k.hint}</Text> : null}
            </View>
            <View style={st.ledgerNums}>
              <Text style={[st.ledgerValue, k.tone === 'bad' && { color: colors.danger }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                {value}
              </Text>
              <DeltaText delta={kpiDelta(k, fmt)} />
            </View>
            <View style={st.ledgerEnd}>
              <LinkMark href={k.href} />
            </View>
          </LinkRow>
        );
      })}
    </View>
  );
}

/* ───────────────────────── Web'e geçiş ve birincil eylem ───────────────────────── */

/** Sayfanın altındaki "… web'de ↗" bağlantısı: telefonda olmayan işler (süzgeç, rol değiştirme) web'de. */
export function WebLink({ label, path }: { label: string; path: string }) {
  const { t } = useTranslation('hub');
  const { openWeb } = useHub();
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} accessibilityHint={t('link.webHint')} onPress={() => openWeb(path)} style={({ pressed }) => [st.webLink, pressed && st.pressed]}>
      <Text style={st.webLinkTxt}>{label}</Text>
      <Glyph name="external" size={16} color={hubColors.ink} />
    </Pressable>
  );
}

/** Merkez'in birincil düğmesi (lacivert). Ekranda tek. */
export function InkButton({ label, onPress, icon, loading, disabled }: { label: string; onPress: () => void; icon?: 'plus'; loading?: boolean; disabled?: boolean }) {
  const off = !!loading || !!disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!loading }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [st.ink, pressed && st.inkPressed, disabled && st.inkOff]}
    >
      {loading ? <ActivityIndicator color={colors.surface} /> : icon ? <Icon name={icon} size={20} color={colors.surface} strokeWidth={2.2} /> : null}
      <Text style={st.inkTxt} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Alttan açılan sayfa (form, sonuç). Dışına dokunmak ve geri tuşu kapatır; `locked` iken kapanmaz (istek sürüyor). */
export function BottomSheet({ visible, title, onClose, locked, children }: { visible: boolean; title: string; onClose: () => void; locked?: boolean; children: ReactNode }) {
  const { t } = useTranslation('hub');
  const bottom = useBottomInset();
  const close = () => {
    if (!locked) onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Pressable style={st.scrim} onPress={close} accessibilityRole="button" accessibilityLabel={t('sheet.close')} />
        <View style={[st.sheetBox, { paddingBottom: space.lg + bottom }]} accessibilityViewIsModal>
          <View style={st.grab} />
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={st.sheetBody}>
            <Text style={st.sheetTitle} accessibilityRole="header">
              {title}
            </Text>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ───────────────────────── Durumlar ───────────────────────── */

export function Skel({ w = '100%', h = 14, style }: { w?: number | `${number}%`; h?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: w, height: h, borderRadius: 4, backgroundColor: colors.border }, style]} />;
}

/** Bölüm hatası: sayfa ayakta kalır, yalnız bu bölüm yeniden denenir. */
export function SectionError({ title, kind, onRetry }: { title: string; kind: 'network' | 'server' | null; onRetry: () => void }) {
  const { t } = useTranslation('hub');
  return (
    <Banner
      kind="error"
      title={title}
      text={t(kind === 'network' ? 'error.network' : 'error.server')}
      action={<Button small kind="secondary" icon="sync" label={t('error.retry')} onPress={onRetry} />}
    />
  );
}

/** Son veri gösteriliyor: nedeni ve zamanı açık. */
export function StaleNote({ failed, at, onRetry }: { failed: 'network' | 'server' | null; at: number | null; onRetry: () => void }) {
  const { t } = useTranslation('hub');
  const { lng, fmt } = useHub();
  if (!failed || at === null) return null;
  return (
    <Banner
      kind="warn"
      icon={failed === 'network' ? 'cloudoff' : 'warn'}
      text={t(failed === 'network' ? 'stale.offline' : 'stale.failed', { time: updatedAt(at, lng, Date.now(), fmt.timeZone) })}
      action={<Button small kind="secondary" icon="sync" label={t('stale.retry')} onPress={onRetry} />}
    />
  );
}

/** Üründen gelen bozuk veri bütün sayfayı düşürmez. */
export class SectionBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(e: unknown) {
    if (__DEV__) console.warn('hub section', e);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const hub = StyleSheet.create({
  /** Beyaz yaprak: içindeki satırlar kıl çizgiyle ayrılır, kart içinde kart yok. */
  sheet: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  sheetPad: { padding: 16 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.md },
  sectionTitle: { ...typo.cardTitle },
  count: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: radius.pill, backgroundColor: '#fdb022', alignItems: 'center', justifyContent: 'center' },
  countTxt: { fontSize: 12, lineHeight: 16, color: colors.text, ...font.monoSemibold },
  hair: { borderTopWidth: 1, borderTopColor: colors.borderSoft },
});

const st = StyleSheet.create({
  org: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8 },
  orgAv: { width: 36, height: 36, borderRadius: 6, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  orgAvTxt: { fontSize: 13, lineHeight: 18, color: colors.primaryHover, ...font.semibold },
  orgName: { fontSize: 14, lineHeight: 19, color: colors.text, ...font.semibold },
  orgPending: { fontSize: 12, lineHeight: 16, color: colors.warning, ...font.medium },
  page: { flex: 1, backgroundColor: colors.bg },
  pageBody: { padding: space.lg, gap: space.md },

  seg: { flexDirection: 'row', backgroundColor: '#efede8', borderRadius: radius.control, padding: 3, gap: 2 },
  segItem: { flex: 1, minHeight: TOUCH - 6, paddingHorizontal: 4, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.surface, boxShadow: '0 1px 2px rgba(15,26,46,0.12)' },
  segPressed: { backgroundColor: colors.surface2 },
  langChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 6, minHeight: TOUCH, paddingHorizontal: 14, borderRadius: radius.control },
  langChipTxt: { fontSize: 14, lineHeight: 19, color: colors.text2, ...font.semibold },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TOUCH, paddingHorizontal: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control },
  langRowLab: { flex: 1, fontSize: 15, lineHeight: 20, color: colors.text, ...font.medium },
  langRowCur: { fontSize: 14, lineHeight: 19, color: colors.text2, ...font.regular },
  langScrim: { flex: 1, backgroundColor: 'rgba(10,26,58,0.45)', justifyContent: 'flex-end' },
  langSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingTop: 6 },
  langTitle: { fontSize: 12, lineHeight: 16, color: colors.text2, paddingHorizontal: 16, paddingVertical: 8, ...font.semibold },
  langOpt: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  langOptTxt: { flex: 1, fontSize: 15, lineHeight: 20, color: colors.text, ...font.medium },
  segTxt: { fontSize: 13, lineHeight: 18, color: colors.text2, ...font.medium },
  segTxtOn: { color: colors.text, ...font.semibold },

  filters: { gap: space.md },
  toolsBleed: { marginHorizontal: -space.lg },
  tools: { paddingHorizontal: space.lg, gap: 6 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TOUCH, paddingHorizontal: 12, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  toolOn: { backgroundColor: hubColors.inkSoft, borderColor: hubColors.inkLine },
  toolSoon: { backgroundColor: 'transparent', borderColor: colors.border },
  toolTxt: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.medium },
  toolTxtOn: { color: hubColors.ink, ...font.semibold },
  toolSoonTxt: { fontSize: 13, lineHeight: 18, color: colors.text3, ...font.regular },
  soonTag: { fontSize: 11, lineHeight: 15, color: colors.text3, ...font.medium },
  rangeTxt: { ...typo.small },

  delta: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  deltaTxt: { fontSize: 12, lineHeight: 16, ...font.medium },

  pressed: { backgroundColor: colors.surface2 },
  hair: { borderTopWidth: 1, borderTopColor: colors.borderSoft },
  ledgerRow: { flexDirection: 'row', alignItems: 'center', minHeight: TOUCH, paddingVertical: 6, paddingLeft: 12, paddingRight: 8, gap: 8 },
  ledgerMain: { flex: 1, minWidth: 0 },
  ledgerLabel: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.regular },
  ledgerHint: { ...typo.small, marginTop: 2 },
  ledgerNums: { alignItems: 'flex-end', maxWidth: '56%', gap: 1 },
  ledgerValue: { fontSize: 14, lineHeight: 20, color: colors.text, ...font.monoMedium },
  ledgerEnd: { width: 16, alignItems: 'center' },

  webLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: TOUCH, paddingHorizontal: 12, borderRadius: radius.card, borderWidth: 1, borderStyle: 'dashed', borderColor: hubColors.inkLine, backgroundColor: colors.surface },
  webLinkTxt: { flexShrink: 1, fontSize: 13, lineHeight: 18, color: hubColors.ink, ...font.semibold, textAlign: 'center' },

  ink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, paddingHorizontal: 16, borderRadius: radius.control, backgroundColor: hubColors.ink },
  inkPressed: { opacity: 0.85 },
  inkOff: { backgroundColor: colors.disabledBg },
  inkTxt: { fontSize: 15, lineHeight: 20, color: colors.surface, ...font.semibold },

  scrim: { flex: 1, backgroundColor: 'rgba(10,26,58,0.45)' },
  sheetBox: { maxHeight: '88%', backgroundColor: colors.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12, paddingTop: 8 },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  sheetBody: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  sheetTitle: { fontSize: 17, lineHeight: 23, color: colors.text, ...font.semibold },
});

/* ───────────────────────── Firma satırları ve dil anahtarı (Hesap, Firma seçimi) ───────────────────────── */

/** Firma listesi: baş harf kutusu + ad + durum, satır ≥56 dp. Etkin firma onay işaretiyle. */
export function OrgRows({ orgs, activeId, onSwitched }: { orgs: MeResponse['orgs']; activeId: string | null; onSwitched?: (me: MeResponse | null) => void }) {
  const { t } = useTranslation('auth');
  const { switchOrg } = useAuth();
  const { pendingOrgs } = useQueue();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (orgId: string) => {
    if (busy) return;
    setBusy(orgId);
    setError(null);
    try {
      await pickOrg(switchOrg, orgId, onSwitched);
    } catch (e) {
      const key = e instanceof ApiError ? authErrorKey(e, 'org') : 'auth:errors.UNKNOWN';
      setError(key ? t(key) : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={{ gap: space.sm }}>
      <View style={hub.sheet}>
        {orgs.map((org, i) => {
          const active = org.id === activeId;
          const off = org.status !== 'ACTIVE';
          const pending = pendingOrgs[org.id] ?? 0;
          return (
            <Pressable
              key={org.id}
              disabled={off || !!busy}
              onPress={() => pick(org.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: off, busy: busy === org.id }}
              accessibilityLabel={org.name}
              style={({ pressed }) => [st.org, i > 0 && hub.hair, off && { backgroundColor: colors.surface2 }, pressed && st.pressed]}
            >
              <View style={[st.orgAv, off && { backgroundColor: '#efede8' }]}>
                <Text style={[st.orgAvTxt, off && { color: colors.text2 }]}>{org.name.slice(0, 2).toLocaleUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[st.orgName, off && { color: colors.text2 }]} numberOfLines={2}>
                  {org.name}
                </Text>
                {pending > 0 && !active ? <Text style={st.orgPending}>{t('org.pending', { count: pending })}</Text> : null}
              </View>
              {busy === org.id ? (
                <ActivityIndicator color={hubColors.ink} />
              ) : off ? (
                <Badge label={t('org.suspended')} kind="neutral" />
              ) : active ? (
                <Icon name="check" size={22} color={hubColors.ink} strokeWidth={2.5} />
              ) : (
                <Icon name="chev" size={20} color={colors.text3} strokeWidth={2} />
              )}
            </Pressable>
          );
        })}
      </View>
      {error ? <Banner kind="error" text={error} /> : null}
    </View>
  );
}

/**
 * Dil seçici: tek düğme, dokunulunca alttan açılan iki satırlı liste (Türkçe / English, geçerli olan işaretli).
 * `chip`: giriş ekranı (🌐 TR ⌄); `row`: hesap ekranı satırı (🌐 Dil · Türkçe ›). Dil adları kendi dilinde yazılır.
 */
export function LangPicker({ onChange, variant = 'chip' }: { onChange: (locale: Locale) => void; variant?: 'chip' | 'row' }) {
  const { t, i18n } = useTranslation('auth');
  const [open, setOpen] = useState(false);
  const bottom = useBottomInset();
  const value: Locale = i18n.language === 'en' ? 'en' : 'tr';
  const name = (l: Locale) => (l === 'tr' ? t('account.languageTr') : t('account.languageEn'));
  const label = `${t('account.language')}: ${name(value)}`;
  const pick = (l: Locale) => {
    setOpen(false);
    if (l !== value) onChange(l);
  };
  return (
    <>
      {variant === 'row' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen(true)} style={({ pressed }) => [st.langRow, pressed && st.segPressed]}>
          <Icon name="globe" size={20} color={colors.text2} strokeWidth={2} />
          <Text style={st.langRowLab}>{t('account.language')}</Text>
          <Text style={st.langRowCur}>{name(value)}</Text>
          <Icon name="chev" size={18} color={colors.text3} strokeWidth={2} />
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen(true)} style={({ pressed }) => [st.langChip, pressed && st.segPressed]}>
          <Icon name="globe" size={18} color={colors.text2} strokeWidth={2} />
          <Text style={st.langChipTxt}>{value.toUpperCase()}</Text>
          <View style={{ transform: [{ rotate: '90deg' }] }}>
            <Icon name="chev" size={14} color={colors.text3} strokeWidth={2} />
          </View>
        </Pressable>
      )}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent navigationBarTranslucent>
        <Pressable style={st.langScrim} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={t('account.cancel')}>
          <Pressable style={[st.langSheet, { paddingBottom: 8 + bottom }]} onPress={() => undefined} accessible={false}>
            <Text style={st.langTitle}>{t('account.language')}</Text>
            {(['tr', 'en'] as const).map((l) => (
              <Pressable
                key={l}
                accessibilityRole="radio"
                accessibilityState={{ checked: l === value }}
                accessibilityLabel={name(l)}
                onPress={() => pick(l)}
                style={({ pressed }) => [st.langOpt, pressed && st.segPressed]}
              >
                <Text style={st.langOptTxt}>{name(l)}</Text>
                {l === value ? <Icon name="check" size={22} color={hubColors.ink} strokeWidth={2.5} /> : null}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
