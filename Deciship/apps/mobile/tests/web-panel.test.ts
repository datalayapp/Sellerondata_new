// Tasarım 3-A: DeciShip üst bandındaki "Yönetim paneli ↗" düğmesi. Yalnız web paneline giriş izni olan görür;
// adres web kökü + `/deciship/`; dar bantta yazı yerine simge.
import { describe, expect, it } from 'vitest';
import { permissionsOf, type MeResponse, type OrgRole, type SubscriptionStatus } from '@sellerondata/contracts';
import { canOpenWebPanel, webPanelLabelFits, webPanelUrl } from '../src/ui/webPanel';

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
        permissions: status && role ? [...permissionsOf('deciship', role)] : [],
      },
      { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
      { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
    ],
  };
}

describe('Yönetim paneli düğmesi: kim görür', () => {
  it('Yönetici, Muhasebe ve Denetleyici görür', () => {
    expect(canOpenWebPanel(me({ role: 'ADMIN', orgRole: 'OWNER' }))).toBe(true);
    expect(canOpenWebPanel(me({ role: 'ACCOUNTING' }))).toBe(true);
    expect(canOpenWebPanel(me({ role: 'AUDITOR' }))).toBe(true);
  });

  it('Ölçüm çalışanı görmez', () => {
    expect(canOpenWebPanel(me())).toBe(false);
  });

  it('kural rol adına değil web giriş iznine bakar', () => {
    const m = me({ role: 'ACCOUNTING' });
    m.products[0]!.permissions = m.products[0]!.permissions.filter((p) => p !== 'deciship.web.access');
    expect(canOpenWebPanel(m)).toBe(false);
    const measure = me();
    measure.products[0]!.permissions = [...measure.products[0]!.permissions, 'deciship.web.access'];
    expect(canOpenWebPanel(measure)).toBe(true);
  });

  it('salt okunur abonelikte panel yine açılır (veriyi görmek için)', () => {
    expect(canOpenWebPanel(me({ role: 'ADMIN', status: 'READ_ONLY' }))).toBe(true);
  });

  it('erişim yoksa, firma yoksa ya da araç kapalıysa görünmez', () => {
    expect(canOpenWebPanel(me({ role: null, orgRole: 'OWNER' }))).toBe(false);
    expect(canOpenWebPanel(me({ role: 'ADMIN', noOrg: true }))).toBe(false);
    expect(canOpenWebPanel(null)).toBe(false);
    const off = me({ role: 'ADMIN', orgRole: 'OWNER' });
    off.products[0]!.available = false;
    expect(canOpenWebPanel(off)).toBe(false);
  });

  it('web uygulaması olmayan araçta düğme yok', () => {
    expect(canOpenWebPanel(me({ role: 'ADMIN' }), 'orderloom')).toBe(false);
  });
});

describe('Yönetim paneli adresi', () => {
  it('web kökü + /deciship/', () => {
    expect(webPanelUrl('http://127.0.0.1:8088')).toBe('http://127.0.0.1:8088/deciship/');
    expect(webPanelUrl('https://app.sellerondata.com/')).toBe('https://app.sellerondata.com/deciship/');
  });
});

describe('Yönetim paneli: yazılı mı simge mi', () => {
  // Logo kilidi kendi genişliği kadar yer bulmalı; yoksa düğme simgeye iner (48 dp).
  it('yer yetiyorsa yazılı, yetmiyorsa simge', () => {
    expect(webPanelLabelFits({ brand: 60, button: 48, label: 110, brandNeed: 100 })).toBe(false);
    expect(webPanelLabelFits({ brand: 170, button: 48, label: 110, brandNeed: 100 })).toBe(true);
  });

  it('karar düğmenin şimdiki biçiminden bağımsız (gidip gelmez)', () => {
    // Aynı satır: simge biçiminde kilit 162, yazılı biçimde 100 dp alır.
    expect(webPanelLabelFits({ brand: 162, button: 48, label: 110, brandNeed: 100 })).toBe(true);
    expect(webPanelLabelFits({ brand: 100, button: 110, label: 110, brandNeed: 100 })).toBe(true);
    // Sığmayan satırda yazılı biçimde kilit sıfıra iner: yine simge.
    expect(webPanelLabelFits({ brand: 0, button: 110, label: 110, brandNeed: 100 })).toBe(false);
  });
});
