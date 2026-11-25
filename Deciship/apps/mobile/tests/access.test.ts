import { describe, expect, it } from 'vitest';
import { PRODUCT_KEYS, PRODUCTS, permissionsOf, type MeResponse, type OrgRole, type SubscriptionStatus } from '@sellerondata/contracts';
import {
  activeOrgs,
  afterOrgSwitchHref,
  appOf,
  bandOf,
  DECISHIP_TABS,
  decishipAccess,
  dockApps,
  homeHref,
  isCaptureRoute,
  isDecishipTabRoute,
  isDockUsable,
  isMainRoute,
  showsConnection,
  showsDock,
  tabsFor,
  toolsFor,
  withoutClosedOrgs,
} from '../src/auth/access';
import { canSeeHub } from '../src/hub/access';
import { MOBILE_TOOLS, toolAccess } from '../src/tools/registry';

function me(opts: { role?: string | null; orgRole?: OrgRole; status?: SubscriptionStatus | null; noOrg?: boolean } = {}): MeResponse {
  const role = opts.role === undefined ? 'MEASURE' : opts.role;
  const status = opts.status === undefined ? 'ACTIVE' : opts.status;
  const orgRole = opts.orgRole ?? 'MEMBER';
  return {
    person: { id: 'p1', name: 'Ayşe', email: null, phone: '+905320000000', locale: 'tr', emailVerified: false },
    orgs: opts.noOrg ? [] : [{ id: 'o1', name: 'Firma', orgRole, status: 'ACTIVE' }],
    activeOrg: opts.noOrg ? null : { id: 'o1', name: 'Firma', country: 'TR', currency: 'TRY', orgRole, membershipId: 'm1' },
    products: [
      {
        key: 'deciship',
        available: true,
        subscription: status ? { status, plan: 'early_access' } : null,
        role: status ? role : null,
        permissions: status ? [...permissionsOf('deciship', role)] : [],
      },
      { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
      { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
    ],
  };
}

describe('ölçüm izni', () => {
  it('Ölçüm rolü ölçer, tümünü görmez', () => {
    const a = decishipAccess(me());
    expect(a).toMatchObject({ state: 'active', canUse: true, canCapture: true, canViewAll: false });
    expect(a.has('deciship.prices.view')).toBe(false);
  });

  it('Muhasebe ölçüm izni olmadığı için ölçemez, görebilir', () => {
    expect(decishipAccess(me({ role: 'ACCOUNTING' }))).toMatchObject({ canUse: true, canCapture: false, canViewAll: true, canWrite: true });
  });

  it('abonelik READ_ONLY veya CANCELED ise yazma kapalı', () => {
    for (const status of ['READ_ONLY', 'CANCELED'] as const) {
      expect(decishipAccess(me({ status }))).toMatchObject({ state: 'read_only', canUse: true, canWrite: false, canCapture: false });
    }
  });

  it('rol veya abonelik yoksa erişim yok', () => {
    expect(decishipAccess(me({ role: null })).state).toBe('no_access');
    expect(decishipAccess(me({ status: null })).state).toBe('no_access');
  });

  it('firma veya profil yoksa kapalı', () => {
    expect(decishipAccess(me({ noOrg: true })).state).toBe('no_org');
    expect(decishipAccess(null)).toMatchObject({ state: 'no_org', canCapture: false });
  });
});

describe('sekmeler', () => {
  it('Ölçüm rolü uygulama çubuğu görmez (geçeceği uygulama yok), Merkez yok, doğrudan DeciShip Bugün ekranına açılır', () => {
    expect(tabsFor(me())).toEqual({ hub: false, deciship: true, dock: false });
    expect(canSeeHub(me())).toBe(false);
    expect(homeHref(me())).toBe('/deciship/today');
  });

  it('rapor izni olan veya yönetici Merkez görür ve Merkez ile açılır', () => {
    expect(tabsFor(me({ role: 'ACCOUNTING' }))).toEqual({ hub: true, deciship: true, dock: true });
    expect(tabsFor(me({ role: 'ADMIN', orgRole: 'OWNER' }))).toEqual({ hub: true, deciship: true, dock: true });
    expect(homeHref(me({ role: 'ACCOUNTING' }))).toBe('/hub');
    expect(homeHref(me({ role: 'ADMIN', orgRole: 'OWNER' }))).toBe('/hub');
  });

  it('aracı olmayan firma sahibi Merkez ile başlar; çubukta araçların durumunu görür', () => {
    const m = me({ role: null, orgRole: 'OWNER' });
    expect(tabsFor(m)).toEqual({ hub: true, deciship: false, dock: true });
    expect(homeHref(m)).toBe('/hub');
  });

  it('hiç aracı olmayan çalışan erişim yok durumunu görür, çubuk yok', () => {
    expect(tabsFor(me({ role: null }))).toEqual({ hub: false, deciship: true, dock: false });
  });

  it('askıdaki firmada Merkez kapalı', () => {
    const m = me({ orgRole: 'OWNER', role: 'ADMIN' });
    m.orgs[0]!.status = 'SUSPENDED';
    expect(canSeeHub(m)).toBe(false);
    expect(activeOrgs(m)).toEqual([]);
  });
});

describe('kapalı firma', () => {
  it('mobilde listede görünmez, seçilemez; alan yoksa yanıt aynen kalır', () => {
    const m = me({ orgRole: 'OWNER', role: 'ADMIN' });
    expect(withoutClosedOrgs(m)).toBe(m);
    m.orgs.push({ id: 'o2', name: 'Kapalı Firma', orgRole: 'OWNER', status: 'ACTIVE', orgStatus: 'CLOSED', closedAt: '2026-11-13T10:00:00Z', purgeAfter: '2026-12-13T10:00:00Z' });
    expect(withoutClosedOrgs(m).orgs.map((o) => o.id)).toEqual(['o1']);
    expect(activeOrgs(m).map((o) => o.id)).toEqual(['o1']);
  });
});

describe('kimlik, üst sekmeler ve alt uygulama çubuğu', () => {
  const flow = (s: string) => ['(tabs)', 'deciship', s];
  const tab = (s: string) => ['(tabs)', 'deciship', s];
  const ownerMe = me({ role: 'ADMIN', orgRole: 'OWNER' });
  const owner = tabsFor(ownerMe);
  const measure = tabsFor(me());

  it('DeciShip rotaları DeciShip kimliğinde, diğerleri Merkez', () => {
    expect(bandOf(tab('today'))).toBe('deciship');
    expect(bandOf(flow('scan'))).toBe('deciship');
    expect(bandOf(['(tabs)', 'hub'])).toBe('hub');
    expect(bandOf(['(tabs)', 'account'])).toBe('hub');
    expect(appOf(tab('history'))).toBe('deciship');
    expect(appOf(['(tabs)', 'hub', 'analytics'])).toBe('hub');
    expect(appOf(['(tabs)', 'account'])).toBe('hub');
  });

  it('DeciShip üst sekmeleri Bugün · Geçmiş; Hesap sekme değil (profil düğmesi)', () => {
    expect([...DECISHIP_TABS]).toEqual(['today', 'history']);
    expect(isDecishipTabRoute(tab('today'))).toBe(true);
    expect(isDecishipTabRoute(tab('history'))).toBe(true);
    expect(isDecishipTabRoute(['(tabs)', 'deciship'])).toBe(true);
    expect(isDecishipTabRoute(tab('account'))).toBe(false);
  });

  it('ana ekranlar: Merkez bölümleri ve DeciShip sekmeleri; Hesap, ölçüm adımları ve kayıt ekranları değil', () => {
    for (const s of [['(tabs)', 'hub'], ['(tabs)', 'hub', 'analytics'], ['(tabs)', 'hub', 'team'], tab('today'), tab('history'), ['(tabs)', 'deciship']]) {
      expect(isMainRoute(s)).toBe(true);
    }
    for (const s of [['(tabs)', 'account'], tab('account'), ['(tabs)', 'deciship', 'measurement', '[id]'], ['(tabs)', 'deciship', 'measurement', 'edit'], [], ['(auth)', 'login']]) {
      expect(isMainRoute(s)).toBe(false);
    }
  });

  it('çubuk sırası: en solda Merkez, sonra araçlar katalog sırasıyla', () => {
    expect(dockApps(ownerMe, 'hub').map((a) => a.key)).toEqual(['hub', ...PRODUCT_KEYS]);
    expect(dockApps(null, 'hub').map((a) => a.key)).toEqual(['hub', ...PRODUCT_KEYS]);
  });

  it('açık uygulama işaretli: Merkez ekranında Merkez, DeciShip ekranında DeciShip; her zaman tek hücre', () => {
    const here = (segments: string[]) => dockApps(ownerMe, appOf(segments)).filter((a) => a.here).map((a) => a.key);
    expect(here(['(tabs)', 'hub'])).toEqual(['hub']);
    expect(here(['(tabs)', 'hub', 'team'])).toEqual(['hub']);
    expect(here(tab('today'))).toEqual(['deciship']);
    expect(here(tab('history'))).toEqual(['deciship']);
  });

  it('hazır olmayan araçlar (bugün OrderLoom, TagPress) soluk ve dokunulmaz; Merkez ve DeciShip dokunulur', () => {
    const apps = dockApps(ownerMe, 'hub');
    for (const a of apps) {
      const ready = a.key === 'hub' || PRODUCTS[a.key].launch === 'public';
      expect(isDockUsable(a)).toBe(ready);
      if (!ready) expect(a.state).toBe('soon');
    }
    expect(apps.find((a) => a.key === 'hub')?.state).toBe('open');
    expect(apps.find((a) => a.key === 'deciship')?.state).toBe('open');
  });

  it('Merkez yetkisi olmayana Merkez hücresi erişim yok; DeciShip erişimi olmayan firma sahibinde DeciShip erişim yok', () => {
    expect(dockApps(me(), 'deciship').find((a) => a.key === 'hub')).toMatchObject({ state: 'no_access', here: false });
    const noTool = dockApps(me({ role: null, orgRole: 'OWNER' }), 'hub');
    expect(noTool.find((a) => a.key === 'deciship')?.state).toBe('no_access');
    expect(noTool.filter(isDockUsable).map((a) => a.key)).toEqual(['hub']);
  });

  it('Merkez yetkisi olan her ana ekranda çubuğu görür; ölçüm adımları, kayıt ekranları ve Hesap çubuksuz', () => {
    for (const s of [['(tabs)', 'hub'], ['(tabs)', 'hub', 'analytics'], tab('today'), tab('history'), ['(tabs)', 'deciship']]) {
      expect(showsDock(owner, s)).toBe(true);
    }
    for (const s of ['scan', 'weight', 'dims', 'reference', 'photos', 'summary']) expect(showsDock(owner, flow(s))).toBe(false);
    expect(showsDock(owner, ['(tabs)', 'deciship', 'measurement', '[id]'])).toBe(false);
    expect(showsDock(owner, ['(tabs)', 'deciship', 'measurement', 'edit'])).toBe(false);
    expect(showsDock(owner, ['(tabs)', 'account'])).toBe(false);
    expect(showsDock(owner, tab('account'))).toBe(false);
  });

  it('yalnız DeciShip kullanan çalışan (Merkez yetkisi yok) çubuğu hiç görmez: geçeceği başka uygulama yok', () => {
    for (const s of [tab('today'), tab('history'), ['(tabs)', 'hub'], flow('scan')]) expect(showsDock(measure, s)).toBe(false);
  });

  it('bağlantı / kuyruk şeridi yalnız DeciShip kimliğinde', () => {
    expect(showsConnection('deciship')).toBe(true);
    expect(showsConnection('hub')).toBe(false);
    expect(showsConnection('site')).toBe(false);
  });

  it('firma değişince DeciShip içindeki kişi erişimi varsa DeciShip te kalır', () => {
    const m = me({ role: 'ADMIN', orgRole: 'OWNER' });
    expect(afterOrgSwitchHref(m, 'deciship')).toBe('/deciship/today');
    expect(afterOrgSwitchHref(m, 'hub')).toBe('/hub');
    expect(afterOrgSwitchHref(me({ role: null, orgRole: 'OWNER' }), 'deciship')).toBe('/hub');
  });
});

describe('araç durumları (uygulama çubuğu)', () => {
  it('DeciShip açık, hazır olmayan araçlar Yakında', () => {
    const list = toolsFor(me({ role: 'ADMIN', orgRole: 'OWNER' }));
    expect(list.map((x) => x.key)).toEqual([...PRODUCT_KEYS]);
    for (const x of list) expect(x.state).toBe(PRODUCTS[x.key].launch === 'public' ? 'open' : 'soon');
    expect(list.find((x) => x.key === 'deciship')?.state).toBe('open');
  });

  it('me yokken yalnız launch public olan araç açık sayılır (pilot ve off Yakında)', () => {
    for (const x of toolsFor(null)) {
      if (PRODUCTS[x.key].launch === 'public') expect(x.state).not.toBe('soon');
      else expect(x.state).toBe('soon');
    }
  });

  it('DeciShip erişimi olmayan kişide DeciShip "erişim yok", dokunulmaz', () => {
    expect(toolsFor(me({ role: null, orgRole: 'OWNER' })).find((x) => x.key === 'deciship')?.state).toBe('no_access');
  });
});

describe('araç kaydı ve sunucudan erişilebilirlik', () => {
  const withOrderloom = (m: MeResponse, available: boolean, role: string | null = 'ADMIN'): MeResponse => ({
    ...m,
    products: m.products.map((p) =>
      p.key === 'orderloom'
        ? { ...p, available, subscription: role ? { status: 'ACTIVE' as const, plan: 'early_access' } : null, role, permissions: [] }
        : p,
    ),
  });

  it('sunucu available:false derse Yakında (gömülü katalog ne derse desin)', () => {
    const m = me({ role: 'ADMIN', orgRole: 'OWNER' });
    m.products = m.products.map((p) => (p.key === 'deciship' ? { ...p, available: false } : p));
    expect(toolsFor(m).find((x) => x.key === 'deciship')?.state).toBe('soon');
  });

  it('launch durumları: off kapalı, pilot + available açık, launch yok (eski sunucu) + available açık, available:false kapalı', () => {
    const state = (patch: { available: boolean; launch?: 'off' | 'pilot' | 'public' }) => {
      const m = me({ role: 'ADMIN', orgRole: 'OWNER' });
      m.products = m.products.map((p) => (p.key === 'deciship' ? { ...p, ...patch } : p));
      return toolsFor(m).find((x) => x.key === 'deciship')?.state;
    };
    expect(state({ available: true, launch: 'off' })).toBe('soon');
    expect(state({ available: true, launch: 'pilot' })).toBe('open');
    expect(state({ available: true })).toBe('open');
    expect(state({ available: false, launch: 'public' })).toBe('soon');
    const off = me({ role: 'ADMIN', orgRole: 'OWNER' });
    off.products = off.products.map((p) => (p.key === 'deciship' ? { ...p, launch: 'off' as const } : p));
    expect(decishipAccess(off).canUse).toBe(false);
  });

  it('sunucu aracı hazır diyor, kişinin erişimi var, mobil ekran yok: web', () => {
    const list = toolsFor(withOrderloom(me({ role: 'ADMIN', orgRole: 'OWNER' }), true));
    expect(list.find((x) => x.key === 'orderloom')?.state).toBe('web');
    expect(list.find((x) => x.key === 'deciship')?.state).toBe('open');
  });

  it('hazır ama kişinin rolü yok: erişim yok', () => {
    expect(toolsFor(withOrderloom(me({ role: 'ADMIN', orgRole: 'OWNER' }), true, null)).find((x) => x.key === 'orderloom')?.state).toBe('no_access');
  });

  it('yalnız OrderLoom erişimli kişi DeciShip erişim yok ekranına düşmez', () => {
    const m = withOrderloom(me({ role: null }), true);
    expect(tabsFor(m)).toEqual({ hub: false, deciship: false, dock: false });
    expect(toolsFor(m).find((x) => x.key === 'deciship')?.state).toBe('no_access');
  });

  it('Merkez yetkisi olmayan çalışan iki uygulama kullanıyorsa (DeciShip + web OrderLoom) çubuğu görür, Merkez soluk', () => {
    const m = withOrderloom(me(), true);
    expect(tabsFor(m)).toEqual({ hub: false, deciship: true, dock: true });
    const apps = dockApps(m, 'deciship');
    expect(apps.filter(isDockUsable).map((a) => a.key)).toEqual(['deciship', 'orderloom']);
    expect(apps.find((a) => a.key === 'orderloom')?.state).toBe('web');
    expect(apps.find((a) => a.key === 'hub')?.state).toBe('no_access');
  });

  it('kayıtsız araçta genel kural: abonelik ve rol', () => {
    expect(toolAccess(withOrderloom(me(), true), 'orderloom')).toMatchObject({ canUse: true, state: 'active' });
    expect(toolAccess(withOrderloom(me(), false), 'orderloom').canUse).toBe(false);
    expect(toolAccess(null, 'orderloom').state).toBe('no_org');
  });

  it('kayıt: yalnız DeciShip mobil ekranlı', () => {
    expect(Object.keys(MOBILE_TOOLS)).toEqual(['deciship']);
    expect(MOBILE_TOOLS.deciship).toMatchObject({ href: '/deciship/today', band: 'deciship' });
  });
});

describe('rota sınıfları', () => {
  const flow = (s: string) => ['(tabs)', 'deciship', s];

  it('ölçüm adımı tespiti', () => {
    expect(isCaptureRoute(flow('scan'))).toBe(true);
    expect(isCaptureRoute(flow('summary'))).toBe(true);
    expect(isCaptureRoute(flow('today'))).toBe(false);
    expect(isCaptureRoute(flow('history'))).toBe(false);
    expect(isCaptureRoute(['(tabs)', 'deciship', 'measurement', 'edit'])).toBe(false);
    expect(isCaptureRoute(['(tabs)', 'account'])).toBe(false);
  });
});
