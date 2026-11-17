import type React from 'react';
import { createContext, forwardRef, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { useAuth } from '../auth/AuthContext';
import { useQueue } from '../queue/QueueContext';
import { PRODUCTS } from '@sellerondata/contracts';
import { showsConnection } from '../auth/access';
import { getServerUrl } from '../api/client';
import { webOriginFor } from '../hub/links';
import { APP_ENV } from '../version/client';
import { canOpenWebPanel, webPanelLabelFits, webPanelUrl } from './webPanel';
import { bands, colors, font, hubColors, nightChip, radius, touch, type, type BandKey, type BandTheme } from './theme';
import { BrandMarkSmall, SellerOnDataMark } from './BrandMark';
import { Icon, type IconName } from './Icon';

/*
 * D05 "Yoğun çalışma masası" bileşenleri.
 * Üstte kimlik renginde çubuk (geri + logo kilidi + bağlantı durumu + adımlar), altında kâğıt zemin,
 * beyaz kartlar (1 px çizgi, r6), altta beyaz eylem şeridi ve tek birincil düğme.
 */

/* ───────────────────────── Başlık + adım göstergesi ───────────────────────── */

/**
 * Üst çubuk kimliği. Sekme yerleşimi Merkez (`hub`), DeciShip yerleşimi `deciship` sağlar;
 * dışarıdaki giriş ekranları `site` (gece mavisi, SellerOnData).
 */
export const BandContext = createContext<BandKey>('site');

export function useBand(): BandTheme & { key: BandKey } {
  const key = useContext(BandContext);
  return { key, ...bands[key] };
}

export const STEP_COUNT = 5;
/** Adım adı (etkin dilde; çalışma anında okunur). */
const stepName = (n: number): string => (n >= 1 && n <= STEP_COUNT ? i18n.t(`ui.steps.${n}`, { ns: 'measure' }) : '');

export function Header({
  title,
  subtitle,
  back,
  onBack,
  right,
  step,
  subtitleMono = true,
  brand,
  mark,
  status,
  hideTitle,
  tabs,
  profile,
}: {
  title: string;
  subtitle?: string;
  /** Alt başlık takip no / ağırlık özeti ise mono (varsayılan). */
  subtitleMono?: boolean;
  back?: boolean;
  onBack?: () => void;
  /** Çubuğun sağında, bağlantı durumundan önce (ör. ⋯ menüsü). Simgeler gece zemine göre: `IconButton onNight`. */
  right?: ReactNode;
  /** Akış ekranlarında 1–5 arası adım; çubuğun altında ilerleme + "Adım 2/5 · Ağırlık". */
  step?: number;
  /** Çubuktaki marka adı (yalnız giriş ekranlarında). Merkez ve DeciShip kendi logo kilidini çizer. */
  brand?: string;
  /** Marka işareti (24 px). Verilmezse çubuk kimliğinin işareti. */
  mark?: ReactNode;
  /** Bağlantı / kuyruk durumu rozeti. Verilmezse yalnız DeciShip'te, oturum açıkken görünür. */
  status?: boolean;
  /** Sayfa başlığını gövdede çizme (ekran kendi başlığını çiziyorsa). */
  hideTitle?: boolean;
  /** Uygulamanın kendi bölümleri: çubuğun altında, bantta sekmeler (web bandındaki sekmeler gibi). */
  tabs?: BandTabs;
  /** Sağda profil düğmesi (Hesap). Verilmezse oturum açıkken ana ekranlarda (geri ve adım yokken) görünür. */
  profile?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const band = useBand();
  const { t } = useTranslation('measure');
  const { t: tHub } = useTranslation('hub');
  const { status: authStatus, me } = useAuth();
  const signedIn = authStatus === 'signedIn';
  const showStatus = status ?? (signedIn && showsConnection(band.key));
  const showProfile = profile ?? (signedIn && !back && !step && band.key !== 'site' && brand == null);
  // Yönetim paneli düğmesi yalnız DeciShip'in sekme ekranlarında (Bugün · Geçmiş), web giriş izni olana (`canOpenWebPanel`).
  const showWebPanel = band.key === 'deciship' && !!tabs && showProfile && canOpenWebPanel(me);
  const fit = useWebPanelFit();
  const lockup =
    band.key === 'site' || brand != null
      ? { name: brand ?? 'SellerOnData', sub: null, icon: mark ?? <SellerOnDataMark size={24} /> }
      : band.key === 'hub'
        ? { name: tHub('title'), sub: 'SellerOnData', icon: mark ?? <SellerOnDataMark size={24} /> }
        : { name: PRODUCTS.deciship.name, sub: 'SellerOnData', icon: mark ?? <BrandMarkSmall size={24} /> };
  const fallback = band.key === 'hub' ? '/hub' : '/deciship/today';
  return (
    <View>
      <StatusBar style="light" />
      <View style={[s.top, { paddingTop: insets.top, backgroundColor: band.bg }]}>
        <View style={[s.topRow, !back && { paddingLeft: 12 }, showProfile && { paddingRight: 2 }]}>
          {back ? (
            <IconButton icon="back" label={t('ui.back')} onNight onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace(fallback)))} />
          ) : null}
          <View
            style={s.brand}
            accessible
            accessibilityLabel={lockup.sub ? `${lockup.name}, ${lockup.sub}` : lockup.name}
            onLayout={showWebPanel ? fit.onBrand : undefined}
          >
            <View style={lockup.sub ? s.markRing : null}>{lockup.icon}</View>
            <View style={s.brandTxtCol}>
              <Text style={[s.brandTxt, { color: band.on }, band.key === 'hub' && lockup.sub ? s.brandHub : null]} numberOfLines={1}>
                {lockup.name}
              </Text>
              {lockup.sub ? (
                <Text style={[s.brandSub, { color: band.on2 }]} numberOfLines={1}>
                  {lockup.sub}
                </Text>
              ) : null}
            </View>
          </View>
          {right ? <View style={s.topR}>{right}</View> : null}
          {showStatus ? <ConnectionChip /> : null}
          {showWebPanel ? <WebPanelButton compact={!fit.label} onLayout={fit.onButton} /> : null}
          {showProfile ? <ProfileButton /> : null}
        </View>
        {showWebPanel ? <WebPanelMeasure name={lockup.name} sub={lockup.sub} onLabel={fit.onLabel} onBrandNeed={fit.onBrandNeed} /> : null}
        {tabs ? <BandTabRow {...tabs} /> : null}
        {step ? <StepIndicator step={step} /> : null}
      </View>
      {hideTitle ? null : <PageTitle title={title} subtitle={subtitle} mono={subtitleMono} />}
    </View>
  );
}

/** Bantta sekmeler: uygulamanın kendi bölümleri (Merkez: Genel Bakış · Analiz · Ekip; DeciShip: Bugün · Geçmiş). */
export type BandTabs<K extends string = string> = { items: readonly { key: K; label: string }[]; value: K; onChange(key: K): void; label?: string };

/** Etkin sekme beyaz ve kalın, altında kimlik vurgusunda 2 dp çizgi (Merkez güneş, DeciShip açık mavi). Her sekme ≥48 dp. */
function BandTabRow({ items, value, onChange, label }: BandTabs) {
  const band = useBand();
  const accent = band.key === 'hub' ? hubColors.sun : colors.onNightAccent;
  return (
    <View style={s.tabs} accessibilityRole="tablist" accessibilityLabel={label}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) onChange(it.key);
            }}
            style={({ pressed }) => [s.tab, pressed && !on && { backgroundColor: band.pressed }]}
          >
            <Text style={[s.tabTxt, { color: on ? band.on : band.on2 }, on && s.tabTxtOn]} numberOfLines={1}>
              {it.label}
            </Text>
            <View style={[s.tabLine, on && { backgroundColor: accent }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Üst çubuğun sağında profil düğmesi: adın baş harfleri, dokununca Hesap. DeciShip'te Hesap DeciShip kimliğinde açılır
 * (yığında, geri ile Bugün/Geçmiş'e döner); Merkez'de ve DeciShip erişimi yokken Merkez'in Hesap ekranı.
 */
function ProfileButton() {
  const { t } = useTranslation('auth');
  const band = useBand();
  const { me, access } = useAuth();
  const initials = initialsOf(me?.person.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('account.open')}
      hitSlop={4}
      onPress={() => (band.key === 'deciship' && access.canUse ? router.push('/deciship/account') : router.navigate('/account'))}
      style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: band.pressed }]}
    >
      <View style={s.avatar}>
        {initials ? <Text style={s.avatarTxt}>{initials}</Text> : <Icon name="user" size={18} color={colors.onNight} strokeWidth={2} />}
      </View>
    </Pressable>
  );
}

/* ───────────── Yönetim paneli düğmesi (tasarım 3-A) ───────────── */

/** Dışarı açılan bağlantı işareti (kutudan çıkan ok). */
function ExternalGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
        stroke={color}
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

type FitSizes = { brand?: number; button?: number; label?: number; brandNeed?: number };

/**
 * Düğme yazılı mı, yalnız simge mi: bant satırındaki gerçek genişliklerden (`webPanelLabelFits`). Ölçü gelene kadar simge;
 * dar telefonda, büyük yazı boyutunda ya da uzun bağlantı rozetinde logo kilidini sıkıştırmak yerine simgeye iner.
 */
function useWebPanelFit() {
  const [m, setM] = useState<FitSizes>({});
  const put = (k: keyof FitSizes) => (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setM((prev) => (prev[k] === w ? prev : { ...prev, [k]: w }));
  };
  const ready = m.brand != null && m.button != null && m.label != null && m.brandNeed != null;
  return {
    label: ready && webPanelLabelFits(m as Required<FitSizes>),
    onBrand: put('brand'),
    onButton: put('button'),
    onLabel: put('label'),
    onBrandNeed: put('brandNeed'),
  };
}

/** Beyaz hap içinde mavi "Yönetim paneli ↗"; dokununca DeciShip web paneli telefonun tarayıcısında açılır. Dokunma alanı 48 dp. */
function WebPanelButton({ compact, onLayout }: { compact: boolean; onLayout: (e: LayoutChangeEvent) => void }) {
  const { t } = useTranslation('auth');
  const open = () => {
    const origin = webOriginFor({ envOrigin: process.env.EXPO_PUBLIC_WEB_ORIGIN, development: APP_ENV === 'development', serverUrl: getServerUrl() });
    void Linking.openURL(webPanelUrl(origin)).catch(() => undefined);
  };
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t('webPanel.a11y')}
      hitSlop={4}
      onPress={open}
      onLayout={onLayout}
      style={[s.webBtn, compact && s.webBtnIcon]}
    >
      {({ pressed }) => (
        <View style={[s.webPill, compact && s.webPillIcon, pressed && { backgroundColor: colors.primarySoft }]}>
          {compact ? null : (
            <Text style={s.webTxt} numberOfLines={1}>
              {t('webPanel.label')}
            </Text>
          )}
          <ExternalGlyph size={compact ? 16 : 13} color={colors.primary} />
        </View>
      )}
    </Pressable>
  );
}

/** Görünmez ölçü: yazılı düğmenin ve logo kilidinin kendi genişliği (bant satırında sıkışmadan önce). */
function WebPanelMeasure({
  name,
  sub,
  onLabel,
  onBrandNeed,
}: {
  name: string;
  sub: string | null;
  onLabel: (e: LayoutChangeEvent) => void;
  onBrandNeed: (e: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation('auth');
  return (
    <View style={s.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={s.webPill} onLayout={onLabel}>
        <Text style={s.webTxt} numberOfLines={1}>
          {t('webPanel.label')}
        </Text>
        <ExternalGlyph size={13} color={colors.primary} />
      </View>
      <View style={s.measureBrand} onLayout={onBrandNeed}>
        {/* İşaret 24 dp + 1 dp halka kenarı iki yanda. */}
        <View style={{ width: sub ? 26 : 24 }} />
        <View>
          <Text style={s.brandTxt} numberOfLines={1}>
            {name}
          </Text>
          {sub ? (
            <Text style={s.brandSub} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Adın ilk iki sözcüğünün baş harfleri ("Ayşe Yılmaz" → "AY"). */
export function initialsOf(name: string | null | undefined): string {
  return (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase())
    .join('');
}

/** Gövdedeki sayfa başlığı (`.hd`): 18/600 başlık, yanında 13 px alt bilgi (takip no mono). */
export function PageTitle({ title, subtitle, mono = true, right }: { title: string; subtitle?: string; mono?: boolean; right?: ReactNode }) {
  return (
    <View style={s.hd}>
      <View style={s.hdMain}>
        <Text style={s.h1} numberOfLines={2} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={[s.sub, mono && s.subMono]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

/**
 * Bağlantı ve kuyruk durumu. Yalnız DeciShip çubuğunda görünür (`showsConnection`).
 * Her şey gönderilmiş ve bağlantı varken çizilmez (sade bant): yalnız bekleyen, gönderilen, hatalı iş ya da bağlantı yokken çıkar.
 */
export function ConnectionChip() {
  const { t } = useTranslation('measure');
  const { online, flushing, pending, errors } = useQueue();
  const waiting = pending + errors;
  let kind: keyof typeof nightChip;
  let icon: IconName;
  let label: string;
  if (!online) {
    kind = 'warn';
    icon = 'cloudoff';
    label = waiting > 0 ? t('ui.conn.offlineN', { count: waiting }) : t('ui.conn.offline');
  } else if (flushing && waiting > 0) {
    kind = 'info';
    icon = 'upload';
    label = t('ui.conn.sending', { count: waiting });
  } else if (errors > 0) {
    kind = 'danger';
    icon = 'warn';
    label = t('ui.conn.failed', { count: errors });
  } else if (pending > 0) {
    kind = 'warn';
    icon = 'clock';
    label = t('ui.conn.waiting', { count: pending });
  } else {
    return null;
  }
  const c = nightChip[kind];
  const a11y = waiting > 0 ? `${label}. ${t('ui.conn.a11yWaiting', { count: waiting })}` : label;
  return (
    <View style={[s.chip, { backgroundColor: c.bg }]} accessible accessibilityRole="text" accessibilityLabel={a11y} accessibilityLiveRegion="polite">
      <Icon name={icon} size={13} color={c.fg} strokeWidth={2.4} />
      <Text style={[s.chipTxt, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function StepIndicator({ step, total = STEP_COUNT }: { step: number; total?: number }) {
  const { t } = useTranslation('measure');
  const band = useBand();
  const name = stepName(step);
  const next = step < STEP_COUNT ? stepName(step + 1) : '';
  return (
    <View style={s.step} accessibilityRole="progressbar" accessibilityLabel={t('ui.stepA11y', { step, total, name })}>
      <View style={s.track}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[s.seg, { backgroundColor: i < step ? band.trackOn : band.track }]} />
        ))}
      </View>
      <View style={s.stepRow}>
        <Text style={[s.stepTxt, { color: band.on2 }]} numberOfLines={1}>
          {t('ui.step', { step, total })}
          {' · '}
          <Text style={[s.stepName, { color: band.on }]}>{name}</Text>
        </Text>
        <Text style={[s.stepTxt, { color: band.on2 }]} numberOfLines={1}>
          {next ? t('ui.next', { name: next }) : t('ui.lastStep')}
        </Text>
      </View>
    </View>
  );
}

/** Eski ad — StepIndicator artık Header içinde (`step` prop). */
export function StepBar({ step, total }: { step: number; total?: number }) {
  return <StepIndicator step={step} total={total} />;
}

export function IconButton({
  icon,
  label,
  onPress,
  color = colors.text,
  style,
  dark,
  onNight,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  style?: StyleProp<ViewStyle>;
  /** Kamera üstünde: yarı saydam koyu kare */
  dark?: boolean;
  /** Gece çubuğunda: beyaz simge */
  onNight?: boolean;
}) {
  const band = useBand();
  const fg = dark || onNight ? colors.onNight : color;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        s.iconBtn,
        dark && s.iconBtnDark,
        pressed && { backgroundColor: dark ? 'rgba(255,255,255,0.22)' : onNight ? band.pressed : colors.surface2 },
        style,
      ]}
    >
      <Icon name={icon} color={fg} size={22} strokeWidth={2} />
    </Pressable>
  );
}

/* ───────────────────────── ⋯ menüsü ───────────────────────── */

export type MenuItem = { label: string; icon?: IconName; onPress: () => void; danger?: boolean; disabled?: boolean };

/**
 * Nadir eylemler için "⋯" düğmesi + alttan açılan liste. Her satır 52 dp.
 * Gece çubuğunda `onNight`, kart içinde varsayılan.
 */
export function OverflowMenu({ items, label, onNight, title }: { items: MenuItem[]; label?: string; onNight?: boolean; title?: string }) {
  const { t } = useTranslation('measure');
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <>
      <IconButton icon="more" label={label ?? t('ui.more')} onNight={onNight} color={colors.text2} onPress={() => setOpen(true)} />
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent navigationBarTranslucent>
        <Pressable style={s.scrim} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={t('ui.close')}>
          <Pressable style={[s.sheet, { paddingBottom: 8 + insets.bottom }]} onPress={() => undefined} accessible={false}>
            {title ? <Text style={s.sheetTitle}>{title}</Text> : null}
            {shown.map((it, i) => (
              <Pressable
                key={`${it.label}-${i}`}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: !!it.disabled }}
                disabled={it.disabled}
                onPress={() => {
                  setOpen(false);
                  it.onPress();
                }}
                style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: colors.surface2 }]}
              >
                {it.icon ? <Icon name={it.icon} size={20} color={it.disabled ? colors.disabledText : it.danger ? colors.danger : colors.text2} strokeWidth={2} /> : null}
                <Text style={[s.sheetTxt, it.danger && { color: colors.danger }, it.disabled && { color: colors.disabledText }]} numberOfLines={1}>
                  {it.label}
                </Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={({ pressed }) => [s.sheetRow, s.sheetCancel, pressed && { backgroundColor: colors.surface2 }]}>
              <Text style={[s.sheetTxt, { color: colors.text2 }]}>{t('common.cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/* ───────────────────────── Düzen ───────────────────────── */

/**
 * Klavye açılınca odaktaki alanı görünür alana kaydırır. Android'de kök KeyboardAvoidingView ekranı
 * odaklanmadan sonra küçülttüğü için ScrollView alanı kendiliğinden göstermez; alan alttaki eylem
 * şeridinin arkasında kalırdı. `extra`: alanın altında da görünmesi gereken pay (ör. − / + düğmeleri).
 */
export function useKeepFocusedInputVisible(extra = 16) {
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      // Kök yerleşim önce klavye payını uygulasın, sonra ölç.
      timer = setTimeout(() => {
        type Host = React.ComponentRef<typeof View>;
        const input = TextInput.State.currentlyFocusedInput() as unknown as Host | null;
        const sv = ref.current as unknown as Host | null;
        if (!input?.measureInWindow || !sv?.measureInWindow) return;
        sv.measureInWindow((_sx, sy, _sw, sh) => {
          input.measureInWindow((_ix, iy, _iw, ih) => {
            const over = iy + ih + extra - (sy + sh);
            const under = sy - iy;
            if (over > 0) ref.current?.scrollTo({ y: offset.current + over, animated: true });
            else if (under > 0) ref.current?.scrollTo({ y: Math.max(0, offset.current - under - 8), animated: true });
          });
        });
      }, 120);
    });
    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [extra]);
  return {
    ref,
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      offset.current = e.nativeEvent.contentOffset.y;
    },
    scrollEventThrottle: 32,
  };
}

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle> }) {
  const keep = useKeepFocusedInputVisible(KEYBOARD_EXTRA);
  if (!scroll) return <View style={[s.wrap, { flex: 1 }, style]}>{children}</View>;
  return (
    <ScrollView {...keep} style={{ flex: 1 }} contentContainerStyle={[s.wrap, style]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

/** Odaktaki alanın altında görünür kalan pay: ölçü alanlarının − / + satırı (6 + 48 dp) sığsın. */
const KEYBOARD_EXTRA = 72;

/** Alttaki uygulama çubuğu görünüyor mu? Sekme yerleşimi sağlar; çubuk güvenli alanı zaten kendisi boşaltır. */
export const TabBarVisibleContext = createContext(false);

/** Yazılım klavyesi açık mı (Android'de `keyboardDidShow/Hide`). */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return visible;
}

/**
 * Ekranın altındaki boşluk: sistem gezinme çubuğu payı. Altta sekme çubuğu ya da açık klavye varsa
 * pay onlarda kalır; eklenirse düğme ile çubuk/klavye arasında boş şerit oluşur.
 */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  const tabBar = useContext(TabBarVisibleContext);
  const keyboard = useKeyboardVisible();
  return tabBar || keyboard ? 0 : insets.bottom;
}

/** Ekranın altında sabit eylem şeridi (beyaz, üst çizgi, güvenli alan boşluğuyla). */
export function Footer({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const bottom = useBottomInset();
  return <View style={[s.footer, { paddingBottom: 12 + bottom }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

/** Bölüm başlığı (`.sh` 13/600) + sağda isteğe bağlı öğe. */
export function Section({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={s.sec}>
      <Text style={s.secH} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

/**
 * Başlık şeritli liste kartı (`.recc`): 36 px açık başlık + satırlar.
 * Satırlar `ListRow` ile; ayırıcıyı satır kendisi çizer.
 */
export function ListCard({ title, meta, right, children, style }: { title?: string; meta?: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.list, style]}>
      {title ? (
        <View style={s.listH}>
          <Text style={s.listHT} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {meta ? <Text style={s.listHM}>{meta}</Text> : null}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Liste satırı: en az 48 dp, basılabilir ya da düz. `last` son satırda ayırıcıyı kaldırır. */
export function ListRow({
  children,
  onPress,
  last,
  label,
  style,
  chevron,
}: {
  children: ReactNode;
  onPress?: () => void;
  last?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
  chevron?: boolean;
}) {
  const body = (
    <>
      <View style={s.rowMain}>{children}</View>
      {chevron ? <Icon name="chev" size={18} color={colors.text3} strokeWidth={2} /> : null}
    </>
  );
  if (!onPress) return <View style={[s.row, last && s.rowLast, style]}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.row, last && s.rowLast, pressed && { backgroundColor: colors.surface2 }, style]}
    >
      {body}
    </Pressable>
  );
}

/** Seçenek kartı (`.mc`): simge kutusu + başlık + açıklama + ok. Ölçüm yöntemi, bağlantılar. */
export function ActionRow({
  icon,
  title,
  sub,
  badge,
  onPress,
  disabled,
  selected,
  style,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  badge?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.mc, selected && s.mcOn, pressed && { backgroundColor: colors.surface2 }, disabled && { opacity: 0.55 }, style]}
    >
      <View style={s.mcI}>
        <Icon name={icon} size={20} color={colors.primary} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.mcTRow}>
          <Text style={s.mcT} numberOfLines={2}>
            {title}
          </Text>
          {badge}
        </View>
        {sub ? (
          <Text style={s.mcS} numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Icon name="chev" size={18} color={colors.text2} strokeWidth={2} />
    </Pressable>
  );
}

/** Hesap satırı (`.cr`): solda etiket, sağda kalın değer. 36 px. */
export function KeyValue({ label, value, mono, last, tone }: { label: string; value: ReactNode; mono?: boolean; last?: boolean; tone?: 'primary' | 'warning' | 'danger' }) {
  const color = tone === 'primary' ? colors.primaryHover : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.text;
  return (
    <View style={[s.kv, last && { borderBottomWidth: 0 }]}>
      <Text style={s.kvL} numberOfLines={1}>
        {label}
      </Text>
      {typeof value === 'string' ? (
        <Text style={[s.kvV, mono && font.monoMedium, { color }]} numberOfLines={1}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

/** Büyük sayı göstergesi (`.disp`): ağırlık, desi. Seçiliyken mavi çerçeve. */
export function NumberDisplay({ value, unit, active = true, label, tone }: { value: string; unit?: string; active?: boolean; label?: string; tone?: 'danger' }) {
  return (
    <View style={[s.disp, active && s.dispOn, tone === 'danger' && { borderColor: colors.danger }]} accessible accessibilityLabel={label ? `${label}: ${value} ${unit ?? ''}` : undefined}>
      <Text style={s.dispV} numberOfLines={1}>
        {value}
      </Text>
      {unit ? <Text style={s.dispU}>{unit}</Text> : null}
    </View>
  );
}

/* ───────────────────────── Buton ───────────────────────── */

type BtnKind = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'dark';

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  iconRight,
  disabled,
  loading,
  large,
  small,
  style,
}: {
  label: string;
  onPress?: () => void;
  kind?: BtnKind;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** 52 dp — ekranın ana eylemi */
  large?: boolean;
  /** Kart içi eylem: sıkı dolgu ve 13 px yazı, dokunma yüksekliği yine 48 dp */
  small?: boolean;
  /** @deprecated içerik her zaman ortalanır */
  center?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const k = btnKinds[kind === 'outline' ? 'secondary' : kind === 'dark' ? 'primary' : kind];
  const off = !!disabled || !!loading;
  const fg = disabled ? colors.disabledText : k.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!loading }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        large && s.btnLg,
        small && s.btnSm,
        { backgroundColor: k.bg, borderColor: k.border ?? k.bg },
        pressed && { backgroundColor: k.pressed, borderColor: k.border ?? k.pressed },
        disabled && { backgroundColor: kind === 'ghost' ? 'transparent' : colors.disabledBg, borderColor: kind === 'ghost' ? 'transparent' : colors.border },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={k.fg} />
      ) : icon ? (
        <Icon name={icon} color={fg} size={small ? 18 : 20} strokeWidth={2} />
      ) : null}
      <Text style={[s.btnTxt, kind === 'primary' || kind === 'dark' ? s.btnTxtPri : null, large && s.btnTxtLg, small && s.btnTxtSm, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
      {iconRight && !loading ? <Icon name={iconRight} color={fg} size={20} strokeWidth={2} /> : null}
    </Pressable>
  );
}

const btnKinds: Record<'primary' | 'secondary' | 'ghost' | 'danger', { bg: string; fg: string; pressed: string; border?: string }> = {
  primary: { bg: colors.primary, fg: '#fff', pressed: colors.primaryHover },
  secondary: { bg: colors.surface, fg: colors.text, pressed: colors.surface2, border: colors.borderStrong },
  ghost: { bg: 'transparent', fg: colors.primary, pressed: colors.primarySoft, border: 'transparent' },
  danger: { bg: colors.surface, fg: colors.danger, pressed: colors.dangerBg, border: colors.dangerLine },
};

/* ───────────────────────── Rozet ───────────────────────── */

export type BadgeKind = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const badgeColors: Record<BadgeKind, { bg: string; fg: string; dot: string }> = {
  success: { bg: colors.successBg, fg: colors.success, dot: '#17a35d' },
  warning: { bg: colors.warningBg, fg: colors.warning, dot: '#e09400' },
  danger: { bg: colors.dangerBg, fg: '#a8231a', dot: colors.danger },
  info: { bg: colors.primarySoft, fg: colors.primaryHover, dot: colors.primary },
  neutral: { bg: '#efede8', fg: colors.text2, dot: colors.borderHover },
};

/** Durum rozeti (`.chip`): yumuşak zemin, koyu metin, isteğe bağlı nokta ya da simge. */
export function Badge({ label, kind = 'neutral', dot = false, icon, style }: { label: string; kind?: BadgeKind; dot?: boolean; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  const c = badgeColors[kind];
  return (
    <View style={[s.badge, { backgroundColor: c.bg }, style]}>
      {icon ? <Icon name={icon} size={12} color={c.fg} strokeWidth={2.4} /> : dot ? <View style={[s.dot, { backgroundColor: c.dot }]} /> : null}
      <Text style={[s.badgeTxt, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/* ───────────────────────── Bilgi kutusu ───────────────────────── */

/** Bilgi notu (`.note`): renkli zemin, r6, 12–13 px metin. */
export function Banner({
  kind = 'info',
  title,
  text,
  icon,
  action,
  style,
}: {
  kind?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  text: string;
  icon?: IconName;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const map = {
    info: { bg: colors.primarySoft, fg: '#0f2f73', ic: colors.primaryHover, icon: 'info' as IconName },
    warn: { bg: colors.warningBg, fg: colors.warningInk, ic: colors.warningInk, icon: 'warn' as IconName },
    error: { bg: colors.dangerBg, fg: '#7a1a12', ic: colors.danger, icon: 'warn' as IconName },
    ok: { bg: colors.successBg, fg: '#08502c', ic: colors.success, icon: 'check' as IconName },
  }[kind];
  return (
    <View style={[s.banner, { backgroundColor: map.bg }, style]} accessibilityRole={kind === 'error' ? 'alert' : undefined}>
      <Icon name={icon ?? map.icon} size={18} color={map.ic} strokeWidth={2} />
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={[s.bannerTitle, { color: map.fg }]}>{title}</Text> : null}
        <Text style={[s.bannerTxt, { color: map.fg }]}>{text}</Text>
        {action ? <View style={{ marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{action}</View> : null}
      </View>
    </View>
  );
}

/* ───────────────────────── Form ───────────────────────── */

export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.lbl, style]}>{children}</Text>;
}

type FieldProps = TextInputProps & {
  label?: string;
  hint?: string;
  error?: string | null;
  right?: ReactNode;
  monoValue?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
};

/** Etiketli metin alanı (`.inrow`): beyaz zemin, r6, odakta 2 px mavi çerçeve. */
export const TextField = forwardRef<React.ComponentRef<typeof TextInput>, FieldProps>(function TextField(
  { label, hint, error, right, monoValue, containerStyle, inputStyle, onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={containerStyle}>
      {label ? <Label>{label}</Label> : null}
      <View style={[s.field, focused && s.fieldOn, !!error && s.fieldErr]}>
        <TextInput
          ref={ref}
          placeholderTextColor={colors.placeholder}
          cursorColor={colors.primary}
          selectionColor="rgba(29,91,216,0.25)"
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[s.input, monoValue && s.inputMono, inputStyle]}
        />
        {right}
      </View>
      {error ? <Text style={s.err}>{error}</Text> : hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
});

/* ───────────────────────── Boş durum, istatistik ───────────────────────── */

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={22} color={colors.primary} />
      </View>
      <Text style={s.emptyT}>{title}</Text>
      <Text style={s.emptyS}>{text}</Text>
      {action ? <View style={{ marginTop: 8, alignSelf: 'stretch' }}>{action}</View> : null}
    </View>
  );
}

export function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'primary' | 'warning' | 'danger' }) {
  const color = tone === 'primary' ? colors.primaryHover : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.text;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={s.statL} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[s.statV, { color }]} numberOfLines={1}>
        {value}
        {unit ? <Text style={s.statU}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

/* ───────────────────────── Stiller ───────────────────────── */

export const s = StyleSheet.create({
  top: { backgroundColor: colors.night },
  topRow: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingLeft: 2, paddingRight: 10, gap: 6 },
  brand: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  /** İşaretin karesi bant rengine yakın: ince halka kenarı belli eder (web `.sod-brand-mark`). */
  markRing: { borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  brandTxtCol: { flexShrink: 1, minWidth: 0 },
  brandTxt: { flexShrink: 1, fontSize: 15, lineHeight: 19, color: colors.onNight, ...font.semibold },
  /** Merkez adı büyük harf, hafif aralıklı (web `.is-hub .sod-brand-n`). */
  brandHub: { textTransform: 'uppercase', letterSpacing: 0.6 },
  brandSub: { fontSize: 11, lineHeight: 14, ...font.regular },
  topR: { flexDirection: 'row', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 24, paddingHorizontal: 9, borderRadius: radius.pill, flexShrink: 0, maxWidth: 190 },
  chipTxt: { fontSize: 12, lineHeight: 16, flexShrink: 1, ...font.medium },

  hd: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 12 },
  hdMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8 },
  h1: { ...type.title, flexShrink: 1 },
  sub: { fontSize: 13, lineHeight: 18, color: colors.text2, flexShrink: 1, ...font.regular },
  subMono: { color: colors.text, ...font.mono },

  iconBtn: { width: touch.min, height: touch.min, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  iconBtnDark: { backgroundColor: 'rgba(10,26,58,0.7)' },

  step: { paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  track: { flexDirection: 'row', gap: 4 },
  seg: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.nightLine },
  segOn: { backgroundColor: colors.onNightAccent },
  stepRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  stepTxt: { fontSize: 12, lineHeight: 16, color: colors.onNight2, ...font.regular },
  stepName: { color: colors.onNight, ...font.semibold },

  scrim: { flex: 1, backgroundColor: 'rgba(10,26,58,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingTop: 6 },
  sheetTitle: { fontSize: 12, lineHeight: 16, color: colors.text2, paddingHorizontal: 16, paddingVertical: 8, ...font.semibold },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  sheetTxt: { flex: 1, fontSize: 15, lineHeight: 20, color: colors.text, ...font.medium },
  sheetCancel: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4 },

  tabs: { flexDirection: 'row', gap: 4, paddingHorizontal: 4 },
  tab: { minHeight: touch.min, paddingHorizontal: 10, justifyContent: 'center', borderRadius: radius.control },
  tabTxt: { fontSize: 14, lineHeight: 19, ...font.medium },
  tabTxtOn: font.semibold,
  tabLine: { position: 'absolute', left: 10, right: 10, bottom: 0, height: 2, borderRadius: 1, backgroundColor: 'transparent' },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 12, lineHeight: 16, color: colors.onNight, ...font.semibold },
  /** Yönetim paneli: 48 dp dokunma alanı içinde 30 dp beyaz hap; yazı ürün mavisi. Simge biçiminde 48 dp kare alan. */
  webBtn: { minHeight: touch.min, justifyContent: 'center', flexShrink: 0 },
  webBtnIcon: { width: touch.min, alignItems: 'center' },
  webPill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.surface },
  webPillIcon: { width: 36, paddingHorizontal: 0, justifyContent: 'center' },
  webTxt: { fontSize: 12, lineHeight: 16, color: colors.primary, ...font.semibold },
  measure: { position: 'absolute', left: 0, top: 0, opacity: 0, alignItems: 'flex-start' },
  measureBrand: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  wrap: { padding: 12, paddingBottom: 20, gap: 10 },
  footer: { backgroundColor: colors.surface, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: 10 },
  sec: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 24, gap: 8 },
  secH: { ...type.cardTitle, flexShrink: 1 },

  list: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  listH: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 10, backgroundColor: colors.surface2, borderBottomWidth: 1, borderBottomColor: colors.border },
  listHT: { flex: 1, fontSize: 12, lineHeight: 16, color: colors.text, ...font.semibold },
  listHM: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: touch.row, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderSoft },
  rowLast: { borderBottomWidth: 0 },
  rowMain: { flex: 1, minWidth: 0 },

  mc: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  mcOn: { borderColor: colors.primary, borderWidth: 2, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: colors.primarySoft },
  mcI: { width: 36, height: 36, borderRadius: radius.control, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  mcTRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  mcT: { ...type.rowTitle, flexShrink: 1 },
  mcS: { fontSize: 12, lineHeight: 16, color: colors.text2, marginTop: 1, ...font.regular },

  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 36, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  kvL: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: colors.text2, ...font.regular },
  kvV: { fontSize: 13, lineHeight: 18, color: colors.text, ...font.semibold, fontVariant: ['tabular-nums'] },

  disp: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end', gap: 10, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.card, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  dispOn: { borderColor: colors.primary },
  dispV: { ...type.display, flexShrink: 1 },
  dispU: { fontSize: 20, lineHeight: 26, color: colors.text2, ...font.regular },

  btn: {
    minHeight: touch.primary,
    paddingHorizontal: 14,
    borderRadius: radius.control,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnLg: { minHeight: 52 },
  btnSm: { paddingHorizontal: 12 },
  btnTxt: { fontSize: 14, lineHeight: 20, flexShrink: 1, ...font.medium },
  btnTxtPri: { fontSize: 15, ...font.semibold },
  btnTxtLg: { fontSize: 16, ...font.semibold },
  btnTxtSm: { fontSize: 13 },

  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 22, paddingHorizontal: 8, borderRadius: radius.pill, alignSelf: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeTxt: { fontSize: 11, lineHeight: 15, ...font.medium },

  banner: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.card },
  bannerTitle: { fontSize: 13, lineHeight: 18, ...font.semibold },
  bannerTxt: { fontSize: 12, lineHeight: 17, ...font.regular },

  lbl: { ...type.label, marginBottom: 4 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.min,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.control,
  },
  fieldOn: { borderColor: colors.primary, boxShadow: '0 0 0 1px #1d5bd8' },
  fieldErr: { borderColor: colors.danger },
  input: { flex: 1, minHeight: 46, paddingHorizontal: 12, fontSize: 16, color: colors.text, ...font.regular },
  inputMono: { ...font.monoSemibold, fontSize: 16 },
  hint: { ...type.small, marginTop: 4 },
  err: { fontSize: 12, lineHeight: 17, color: colors.danger, marginTop: 4, ...font.medium },

  empty: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 16, gap: 4, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border },
  emptyIcon: { width: 40, height: 40, borderRadius: radius.control, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyT: { ...type.rowTitle, textAlign: 'center' },
  emptyS: { fontSize: 13, lineHeight: 18, color: colors.text2, textAlign: 'center', ...font.regular },

  statV: { fontSize: 22, lineHeight: 28, color: colors.text, ...font.monoSemibold },
  statU: { fontSize: 12, color: colors.text2, ...font.regular },
  statL: { ...type.label, marginBottom: 2 },
});
