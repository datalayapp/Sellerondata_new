// Hata ekranları (Y149): kök ve sekme katmanının ErrorBoundary'si ile Merkez'in SectionBoundary'si.
// Mobilde bileşen çizen test kitaplığı yok: bileşenler düz işlev / sınıf olarak çağrılır, dönen React öğe ağacı gezilir.
// React Native, gezgin ve sağlayıcılar burada sahte; yalnız ekranın kendi davranışı (metin, düğme, eylem) sınanır.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useEffect: (f: () => void) => void f() }));
vi.mock('react-native', () => {
  const host = (name: string) => Object.assign((p: unknown) => p, { displayName: name });
  return {
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    AppState: { addEventListener: () => ({ remove() {} }) },
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    RefreshControl: host('RefreshControl'),
    ActivityIndicator: host('ActivityIndicator'),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: (ns: string) => ({ t: (k: string) => `${ns}:${k}` }) }));
vi.mock('expo-router', () => ({ router: { replace: h.replace }, Stack: {}, Tabs: {}, useSegments: () => [] }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: () => null, useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock('../src/i18n', () => ({}));
vi.mock('../src/ui/components', () => {
  const Button = (p: unknown) => p;
  return { Button, EmptyState: () => null, Screen: () => null, Badge: () => null, Banner: () => null, BandContext: {}, TabBarVisibleContext: {}, useBottomInset: () => 0 };
});
vi.mock('../src/ui/Icon', () => ({ Icon: () => null }));
vi.mock('../src/ui/Toast', () => ({ ToastProvider: () => null }));
vi.mock('../src/ui/AppDock', () => ({ AppDock: () => null }));
vi.mock('../src/ui/UpdateRequired', () => ({ UpdateRequired: () => null, useUpgradeState: () => ({ required: false }) }));
vi.mock('../src/ui/orgPick', () => ({ pickOrg: () => null }));
vi.mock('../src/auth/AuthContext', () => ({ AuthProvider: () => null, useAuth: () => ({}) }));
vi.mock('../src/auth/access', () => ({ appOf: () => 'hub', dockApps: () => [], showsDock: () => true }));
vi.mock('../src/auth/errors', () => ({ authErrorKey: () => 'x' }));
vi.mock('../src/queue/QueueContext', () => ({ QueueProvider: () => null, useQueue: () => ({}) }));
vi.mock('../src/draft/DraftContext', () => ({ DraftProvider: () => null }));
vi.mock('../src/measure/boxMeasure', () => ({ getCapabilities: async () => ({}) }));
vi.mock('../src/api/client', () => ({ ApiError: class extends Error {}, fetchClientPolicy: async () => null }));
vi.mock('../src/version/policy', () => ({ checkPolicy: async () => undefined, loadUpgradeFlag: async () => undefined, onUpgradeChange: () => () => undefined }));
vi.mock('../src/hub/HubContext', () => ({ useHub: () => ({ lng: 'tr' }) }));
vi.mock('../src/hub/views', () => ({ toolPickerItems: () => [] }));
vi.mock('../src/hub/glyphs', () => ({ Glyph: () => null, ProductMark: () => null }));

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Öğe ağacındaki her öğe (derinlik öncelikli). Bileşenler çağrılmaz: yalnız ekranın döndürdüğü ağaç. */
function all(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...all(el.props.children)];
}
const name = (el: El) => (typeof el.type === 'function' ? ((el.type as { displayName?: string }).displayName ?? el.type.name) : String(el.type));
const texts = (tree: ReactNode) => all(tree).filter((e) => name(e) === 'Text').map((e) => e.props.children);
const buttons = (tree: ReactNode) => all(tree).filter((e) => name(e) === 'Button') as ReactElement<{ label: string; kind?: string; onPress: () => void }>[];

beforeEach(() => {
  h.replace.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('kök hata ekranı (app/_layout.tsx)', () => {
  it('başlık, tek cümle ve tek düğme: "Yeniden dene" yeniden çizer; hata günlüğe yazılır', async () => {
    const { ErrorBoundary } = await import('../app/_layout');
    const error = new Error('çöktü');
    const retry = vi.fn(async () => undefined);
    const tree = ErrorBoundary({ error, retry });
    expect(texts(tree)).toEqual(['common:crash.title', 'common:crash.text']);
    const b = buttons(tree);
    expect(b.map((x) => x.props.label)).toEqual(['common:crash.retry']);
    b[0]!.props.onPress();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(error);
    // Başlık ekran okuyucuya başlık olarak bildirilir.
    expect(all(tree).find((e) => e.props.children === 'common:crash.title')?.props.accessibilityRole).toBe('header');
  });
});

describe('sekme hata ekranı (app/(tabs)/_layout.tsx)', () => {
  it('birincil "Yeniden dene", ikincil "Bugün\'e dön": önce yeniden çizer, sonra Bugün\'e gider', async () => {
    const { ErrorBoundary } = await import('../app/(tabs)/_layout');
    const order: string[] = [];
    const retry = vi.fn(async () => void order.push('retry'));
    h.replace.mockImplementation((to: string) => void order.push(`replace ${to}`));
    const tree = ErrorBoundary({ error: new Error('sekme'), retry });
    expect(texts(tree)).toEqual(['common:crash.title', 'common:crash.text']);
    const [again, home, ...rest] = buttons(tree);
    expect(rest).toEqual([]);
    expect(again!.props.label).toBe('common:crash.retry');
    expect(again!.props.kind).toBeUndefined(); // birincil
    expect(home!.props).toMatchObject({ label: 'common:crash.home', kind: 'ghost' });

    again!.props.onPress();
    await Promise.resolve();
    expect(order).toEqual(['retry']);
    expect(h.replace).not.toHaveBeenCalled();

    home!.props.onPress();
    await vi.waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(order).toEqual(['retry', 'retry', 'replace /deciship/today']);
  });
  it('güvenli alan payı üstte ve altta eklenir (çentik, gezinme çubuğu)', async () => {
    const { ErrorBoundary } = await import('../app/(tabs)/_layout');
    const tree = ErrorBoundary({ error: new Error('x'), retry: async () => undefined }) as El;
    expect(tree.props.style).toEqual([expect.anything(), { paddingTop: 16 + 24, paddingBottom: 16 + 16 }]);
  });
});

describe('Merkez bölüm sınırı (SectionBoundary)', () => {
  it('çocuk çökünce yalnız o bölüm yedek görünüme döner', async () => {
    const { SectionBoundary } = await import('../src/hub/ui');
    expect(SectionBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const fallback = 'yedek';
    const children = 'içerik';
    const b = new SectionBoundary({ fallback, children });
    expect(b.state).toEqual({ failed: false });
    expect(b.render()).toBe(children);
    b.state = SectionBoundary.getDerivedStateFromError();
    expect(b.render()).toBe(fallback);
  });
});
