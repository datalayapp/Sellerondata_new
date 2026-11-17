import { PRODUCT_KEYS, PRODUCTS, type MeResponse, type Permission, type ProductKey } from '@sellerondata/contracts';
import { canSeeHub } from '../hub/access';
import { isProductOpen, MOBILE_TOOLS, toolAccess } from '../tools/registry';

export type ToolState = 'no_org' | 'no_access' | 'read_only' | 'active';

export type ToolAccess = {
  state: ToolState;
  /** Kişinin rolü ve firmanın aboneliği var: ürün ekranları açılır. */
  canUse: boolean;
  /** Abonelik yazmaya açık. Sunucu da `403 READ_ONLY` döner. */
  canWrite: boolean;
  /** Yeni ölçüm: izin + yazılabilir abonelik. */
  canCapture: boolean;
  canViewAll: boolean;
  has: (permission: Permission) => boolean;
};

const none = (state: ToolState): ToolAccess => ({
  state,
  canUse: false,
  canWrite: false,
  canCapture: false,
  canViewAll: false,
  has: () => false,
});

/** Kod rol adına bakmaz, izne ve abonelik durumuna bakar (ARCHITECTURE §1). */
export function decishipAccess(me: MeResponse | null | undefined): ToolAccess {
  if (!me?.activeOrg) return none('no_org');
  const product = me.products.find((p) => p.key === 'deciship');
  if (!product || !isProductOpen(product) || !product.subscription || !product.role) return none('no_access');
  const has = (permission: Permission) => product.permissions.includes(permission);
  const canWrite = product.subscription.status === 'ACTIVE';
  return {
    state: canWrite ? 'active' : 'read_only',
    canUse: true,
    canWrite,
    canCapture: canWrite && has('deciship.measurements.capture'),
    canViewAll: has('deciship.measurements.view_all'),
    has,
  };
}

/**
 * Kapalı firmalar (`orgStatus: 'CLOSED'`, yalnız sahibine gelir) mobilde hiç görünmez: geri açma yalnız
 * web Merkez'den. `/me` alındığı yerde bir kez süzülür (AuthContext, Merkez önbelleği); alan yoksa yanıt aynen kalır.
 */
export function withoutClosedOrgs(me: MeResponse): MeResponse {
  return me.orgs.some((o) => o.orgStatus === 'CLOSED') ? { ...me, orgs: me.orgs.filter((o) => o.orgStatus !== 'CLOSED') } : me;
}

/** Geçilebilir firmalar. Askıdaki üyelik seçilemez. */
export function activeOrgs(me: MeResponse | null | undefined): MeResponse['orgs'] {
  return me?.orgs.filter((o) => o.status === 'ACTIVE' && o.orgStatus !== 'CLOSED') ?? [];
}

export type TabsVisibility = {
  /** Merkez: alttaki uygulama çubuğunda Merkez dokunulur, Merkez ile açılır. */
  hub: boolean;
  /** DeciShip alanı. Hiç aracı olmayan kişide "erişim yok" durumu burada gösterilir. */
  deciship: boolean;
  /**
   * Alttaki uygulama geçiş çubuğu. Merkez yetkisi olan her zaman görür (araçların durumu da orada);
   * olmayan yalnız kullanabildiği en az iki uygulama varsa görür. Tek uygulamalı çalışanın geçeceği yer yok.
   */
  dock: boolean;
};

/** Kişinin, mobilde ekranı olan araçlar dışında erişimi olan bir aracı var mı (ör. yalnız OrderLoom). */
function hasOtherToolAccess(me: MeResponse | null | undefined): boolean {
  return PRODUCT_KEYS.some((key) => !MOBILE_TOOLS[key] && toolAccess(me, key).canUse);
}

export function tabsFor(me: MeResponse | null | undefined): TabsVisibility {
  const hub = !!me && canSeeHub(me);
  const usable = dockApps(me, 'hub').filter(isDockUsable).length;
  // Hiç aracı olmayan kişi DeciShip'in "erişim yok" ekranını görür; başka araca erişimi olan görmez.
  return { hub, deciship: decishipAccess(me).canUse || (!hub && !hasOtherToolAccess(me)), dock: hub || usable >= 2 };
}

/** Mobil ekranı olan araçlardan, kişinin erişebildiği ilkinin açılış adresi; yoksa ilk kayıtlı araç. */
function firstMobileHref(me: MeResponse | null | undefined): '/deciship/today' {
  const tools = Object.values(MOBILE_TOOLS).filter((t): t is NonNullable<typeof t> => !!t?.href);
  return (tools.find((t) => t.access(me).canUse) ?? tools[0])!.href!;
}

/**
 * Açılış ekranı. Merkez yetkisi olan Merkez'de açılır; DeciShip alttaki uygulama çubuğundan açılır.
 * Merkez yetkisi olmayan (Ölçüm rolü, aracı olmayan çalışan) doğrudan DeciShip'te açılır.
 */
export function homeHref(me: MeResponse | null | undefined): '/deciship/today' | '/hub' {
  return tabsFor(me).hub ? '/hub' : firstMobileHref(me);
}

/** Firma değişince gidilecek yer: DeciShip içindeyken yeni firmada da erişim varsa DeciShip'te kalınır. */
export function afterOrgSwitchHref(me: MeResponse | null | undefined, band: AppBand): '/deciship/today' | '/hub' {
  const tool = Object.values(MOBILE_TOOLS).find((t) => t?.band === band && t.href && t.access(me).canUse);
  if (tool?.href) return tool.href;
  return homeHref(me);
}

const CAPTURE_STEPS = new Set(['scan', 'weight', 'dims', 'reference', 'photos', 'summary']);

/** Ölçüm adımı mı? Yeni ölçüm izni kalktıysa bu ekranlardan çıkılır. */
export function isCaptureRoute(segments: readonly string[]): boolean {
  return segments.includes('deciship') && CAPTURE_STEPS.has(segments[segments.length - 1] ?? '');
}

/* ───────────── Kimlik, üst sekmeler ve alt uygulama çubuğu (web'in telefon görünümüyle aynı düzen) ───────────── */

/** Uygulama içindeki kimlik: DeciShip rotaları DeciShip, diğerleri (Merkez, Hesap) Merkez. */
export type AppBand = 'hub' | 'deciship';

const isGroup = (s: string) => s.startsWith('(') && s.endsWith(')');

export function bandOf(segments: readonly string[]): AppBand {
  const tool = Object.values(MOBILE_TOOLS).find((t) => t && segments.includes(t.key));
  return tool?.band ?? 'hub';
}

/** DeciShip'in üstteki sekmeleri (Bugün · Geçmiş). Hesap üst çubuktaki profil düğmesinden açılır. */
export const DECISHIP_TABS = ['today', 'history'] as const;

/** DeciShip sekme ekranı mı? Ölçüm adımları, ölçüm ayrıntısı, düzenleme ve Hesap değil. */
export function isDecishipTabRoute(segments: readonly string[]): boolean {
  const i = segments.indexOf('deciship');
  if (i < 0) return false;
  const rest = segments.slice(i + 1).filter((s) => !isGroup(s));
  return rest.length === 0 || (rest.length === 1 && (DECISHIP_TABS as readonly string[]).includes(rest[0]!));
}

/**
 * Ana ekran mı: Merkez bölümleri (Genel Bakış, Analiz, Ekip) ve araçların sekme ekranları.
 * Hesap, ölçüm adımları, ölçüm ayrıntısı ve düzenleme alt çubuksuz açılır.
 */
export function isMainRoute(segments: readonly string[]): boolean {
  const rest = segments.filter((s) => !isGroup(s));
  if (rest[0] === 'hub') return true;
  if (rest[0] === 'deciship') return isDecishipTabRoute(segments);
  return false;
}

/** Alttaki uygulama çubuğundaki uygulama: Merkez ya da bir araç. */
export type AppKey = 'hub' | ProductKey;

/** Çubuktaki hücre. `state` araçlarda `toolsFor` ile aynı; Merkez yetkisi olmayana Merkez `no_access`. `here`: şu an açık olan. */
export type DockApp = { key: AppKey; state: ToolEntry['state']; here: boolean };

/** Hücre dokunulur mu: mobil ekranı açılır (`open`) ya da web'de açılır (`web`). */
export const isDockUsable = (app: DockApp): boolean => app.state === 'open' || app.state === 'web';

/** Şu an hangi uygulamadayız: araç rotaları o araç, diğerleri Merkez. */
export function appOf(segments: readonly string[]): AppKey {
  const tool = Object.values(MOBILE_TOOLS).find((t) => t && segments.includes(t.key));
  return tool?.key ?? 'hub';
}

/** Alt çubuk: en solda Merkez, sonra araçlar katalog sırasıyla (`PRODUCT_KEYS`). Hazır olmayan ve erişilmeyen soluk, dokunulmaz. */
export function dockApps(me: MeResponse | null | undefined, current: AppKey): DockApp[] {
  const hub: DockApp = { key: 'hub', state: me && canSeeHub(me) ? 'open' : 'no_access', here: current === 'hub' };
  return [hub, ...toolsFor(me).map((tool) => ({ ...tool, here: tool.key === current }))];
}

/** Alt uygulama çubuğu görünür mü: kişi çubuğu görüyor (`tabs.dock`) ve ana ekrandayız. Klavye açıkken çubuk ayrıca gizlenir. */
export function showsDock(tabs: TabsVisibility, segments: readonly string[]): boolean {
  return tabs.dock && isMainRoute(segments);
}

/** Bağlantı / kuyruk şeridi yalnız DeciShip'te. Kuyruk gönderimi her ekranda arka planda sürer. */
export function showsConnection(band: AppBand | 'site'): boolean {
  return band === 'deciship';
}

/** `open`: mobil ekranı var; `web`: erişimi var ama mobil ekranı yok (Web'de aç); `soon`: sunucuya göre henüz hazır değil. */
export type ToolEntry = { key: ProductKey; state: 'open' | 'web' | 'no_access' | 'soon' };

/** Araçların durumu (alt uygulama çubuğu). Açık olup olmadığı sunucudan (`me.products[].available`) gelir; `launch` varsa `off` kapalıdır; `me` yoksa gömülü katalogda `launch === 'public'` olan açıktır. */
export function toolsFor(me: MeResponse | null | undefined): ToolEntry[] {
  return PRODUCT_KEYS.map((key) => {
    const product = me?.products.find((p) => p.key === key);
    const available = me ? (product ? isProductOpen(product) : false) : PRODUCTS[key].launch === 'public';
    if (!available) return { key, state: 'soon' as const };
    if (!toolAccess(me, key).canUse) return { key, state: 'no_access' as const };
    return { key, state: MOBILE_TOOLS[key]?.href ? ('open' as const) : ('web' as const) };
  });
}
