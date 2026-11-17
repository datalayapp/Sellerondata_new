// Merkez Genel Bakış'ta "Tümü" yok (web Home ile aynı): her zaman tek aracın özeti, seçim yoksa ilk açık araç.
// Telefonda Analiz yok; ayrıntı için Genel Bakış'taki kart web'i açar.
// Bileşenler düz işlev olarak çağrılır, dönen React öğe ağacı gezilir (error-screens.test.ts gibi).
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hub: { tool: null as string | null, tools: ['deciship'] as string[], setTool: (_: string) => undefined as void },
  resourceKeys: [] as (string | null)[],
  data: null as unknown,
}));

vi.mock('react-native', () => {
  const host = (name: string) => Object.assign((p: unknown) => p, { displayName: name });
  return {
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    Linking: { openURL: async () => undefined },
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    RefreshControl: host('RefreshControl'),
    ActivityIndicator: host('ActivityIndicator'),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: (ns: string) => ({ t: (k: string) => `${ns}:${k}` }) }));
vi.mock('../src/ui/components', () => ({ Badge: () => null, Banner: () => null, Button: () => null, EmptyState: () => null, useBottomInset: () => 0 }));
vi.mock('../src/ui/Icon', () => ({ Icon: () => null }));
vi.mock('../src/ui/orgPick', () => ({ pickOrg: () => null }));
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ me: null }) }));
vi.mock('../src/auth/errors', () => ({ authErrorKey: () => 'x' }));
vi.mock('../src/queue/QueueContext', () => ({ useQueue: () => ({}) }));
vi.mock('../src/api/client', () => ({ ApiError: class extends Error {} }));
vi.mock('../src/hub/glyphs', () => ({ Glyph: () => null, ProductMark: () => null }));
vi.mock('../src/hub/TimeSeries', () => ({ TimeSeries: () => null }));
vi.mock('../src/hub/api', () => ({ fetchOverview: async () => null }));
vi.mock('../src/hub/HubContext', () => ({
  useHub: () => ({
    ...h.hub,
    scope: 's',
    lng: 'tr',
    from: '2026-10-14',
    to: '2026-11-12',
    open: () => undefined,
    linkOf: () => ({ kind: 'none' }),
    fmt: { lng: 'tr', units: {} },
  }),
}));
vi.mock('../src/hub/useHubResource', () => ({
  useHubResource: (key: string | null) => {
    h.resourceKeys.push(key);
    return { status: !key ? 'idle' : h.data ? 'ready' : 'loading', data: h.data, failed: null, at: null, holding: false, refresh: async () => undefined };
  },
}));

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function all(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...all(el.props.children)];
}
const name = (el: El) => (typeof el.type === 'function' ? ((el.type as { displayName?: string }).displayName ?? el.type.name) : String(el.type));
const radios = (tree: ReactNode) =>
  all(tree)
    .filter((e) => name(e) === 'Pressable' && e.props.accessibilityRole === 'radio')
    .map((e) => ({ label: e.props.accessibilityLabel as string, checked: (e.props.accessibilityState as { checked: boolean }).checked }));

beforeEach(() => {
  h.hub = { tool: null, tools: ['deciship'], setTool: () => undefined };
  h.resourceKeys = [];
  h.data = null;
});

describe('araç seçici (ToolPicker)', () => {
  it('Tümü yok; seçim yokken ilk açık araç seçili', async () => {
    const { ToolPicker } = await import('../src/hub/ui');
    const tree = ToolPicker({ tools: ['deciship'] });
    expect(radios(tree)).toEqual([{ label: 'DeciShip', checked: true }]);
    expect(all(tree).some((e) => String(e.props.children).includes('tools.all'))).toBe(false);
  });

  it('izinsiz seçimde de ilk açık araç seçili', async () => {
    const { ToolPicker } = await import('../src/hub/ui');
    h.hub.tool = 'orderloom';
    expect(radios(ToolPicker({ tools: ['deciship'] }))).toEqual([{ label: 'DeciShip', checked: true }]);
  });
});

describe('Genel Bakış ekranı (app/(tabs)/hub/index.tsx)', () => {
  it('seçim yokken ilk açık aracın verisi istenir; süzgeçte yalnız araçlar', async () => {
    const { default: Overview } = await import('../app/(tabs)/hub/index');
    const { HubFilters } = await import('../src/hub/ui');
    h.hub.tools = ['deciship', 'orderloom'];
    const tree = Overview();
    const filters = all(tree).filter((e) => e.type === HubFilters);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.props).toEqual({ tools: ['deciship', 'orderloom'] });
    expect(h.resourceKeys).toEqual(['s:tr:overview:deciship:2026-10-14:2026-11-12']);
  });

  it('seçili araç izinliyse o aracın verisi istenir', async () => {
    const { default: Overview } = await import('../app/(tabs)/hub/index');
    h.hub.tools = ['deciship', 'orderloom'];
    h.hub.tool = 'orderloom';
    Overview();
    expect(h.resourceKeys).toEqual(['s:tr:overview:orderloom:2026-10-14:2026-11-12']);
  });

  it('veri gelince baş rakamın hemen altında seçili aracın web analizi kartı', async () => {
    const { default: Overview } = await import('../app/(tabs)/hub/index');
    h.hub.tools = ['deciship', 'orderloom'];
    h.hub.tool = 'orderloom';
    h.data = { product: 'orderloom', from: 'a', to: 'b', kpis: [{ id: 'k', label: 'K', value: 1, format: 'number' }], alerts: [] };
    const names = all(Overview()).map(name);
    const lead = names.indexOf('Lead');
    expect(lead).toBeGreaterThan(-1);
    expect(names.indexOf('WebAnalyticsCard')).toBeGreaterThan(lead);
    expect(names.indexOf('WebAnalyticsCard')).toBeLessThan(names.indexOf('Queue'));
    const card = all(Overview()).find((e) => name(e) === 'WebAnalyticsCard')!;
    expect(card.props).toEqual({ tool: 'orderloom' });
  });

  it('hiç araç yoksa veri istenmez', async () => {
    const { default: Overview } = await import('../app/(tabs)/hub/index');
    h.hub.tools = [];
    Overview();
    expect(h.resourceKeys).toEqual([null]);
  });
});
