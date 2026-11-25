import { beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsOf, type MeResponse, type OrgRole } from '@sellerondata/contracts';

// Gezinme çağrıları sınanır: firma değişince Hesap ekranı yığından çıkmalı, hedef ekran ikinci kez eklenmemeli (E1-M15).
const nav = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({ router: nav }));

const { goAfterOrgSwitch } = await import('../src/lib/navigation');

function me(opts: { role?: string | null; orgRole?: OrgRole } = {}): MeResponse {
  const role = opts.role === undefined ? 'MEASURE' : opts.role;
  const orgRole = opts.orgRole ?? 'MEMBER';
  return {
    person: { id: 'p1', name: 'Ayşe', email: null, phone: '+905320000000', locale: 'tr', emailVerified: false },
    orgs: [{ id: 'o2', name: 'Yeni', orgRole, status: 'ACTIVE' }],
    activeOrg: { id: 'o2', name: 'Yeni', country: 'TR', currency: 'TRY', orgRole, membershipId: 'm2' },
    products: [
      {
        key: 'deciship',
        available: true,
        subscription: role ? { status: 'ACTIVE', plan: 'early_access' } : null,
        role,
        permissions: role ? [...permissionsOf('deciship', role)] : [],
      },
      { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
      { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
    ],
  };
}

/** Yığına ekran ekleyen çağrılar: hiçbiri olmamalı. */
const stacked = () => [...nav.navigate.mock.calls, ...nav.push.mock.calls];

describe('firma değişince gezinme', () => {
  beforeEach(() => {
    for (const fn of Object.values(nav)) fn.mockReset();
  });

  it('DeciShip Hesap ekranından: yeni firmada DeciShip varsa Bugün e geri inilir, Bugün yığına ikinci kez eklenmez', () => {
    goAfterOrgSwitch(me(), 'deciship');
    expect(nav.dismissTo).toHaveBeenCalledWith('/deciship/today');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(stacked()).toEqual([]);
  });

  it('DeciShip Hesap ekranından: yeni firmada DeciShip yoksa Hesap, Merkez ile yer değiştirir', () => {
    goAfterOrgSwitch(me({ role: null, orgRole: 'OWNER' }), 'deciship');
    expect(nav.replace).toHaveBeenCalledWith('/hub');
    expect(nav.dismissTo).not.toHaveBeenCalled();
    expect(stacked()).toEqual([]);
  });

  it('Merkez Hesap ekranından: Hesap, açılış ekranıyla yer değiştirir (geri tuşu Hesap a dönmez)', () => {
    goAfterOrgSwitch(me({ role: 'ADMIN', orgRole: 'OWNER' }), 'hub');
    expect(nav.replace).toHaveBeenCalledWith('/hub');
    expect(stacked()).toEqual([]);

    nav.replace.mockReset();
    // Yeni firmada Merkez yetkisi yok: açılış DeciShip; Hesap sekmesi yine yer değiştirir.
    goAfterOrgSwitch(me(), 'hub');
    expect(nav.replace).toHaveBeenCalledWith('/deciship/today');
    expect(nav.dismissTo).not.toHaveBeenCalled();
    expect(stacked()).toEqual([]);
  });

  it('profil yoksa da yığına ekleme yok, tek yer değiştirme', () => {
    goAfterOrgSwitch(null, 'hub');
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(stacked()).toEqual([]);
  });
});
