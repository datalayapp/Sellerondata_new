import type { FormatCtx } from '../format';
import type { HubOverview, MeResponse } from '../contracts';

/** Sahte sözleşme verisi: `contracts/hub.ts` ve `tokens.ts` şekliyle. */

export const ctxTr: FormatCtx = { lng: 'tr', units: { days: 'gün', points: 'puan', thousand: 'B', million: 'Mn' } };
export const ctxEn: FormatCtx = { lng: 'en', units: { days: 'days', points: 'pts', thousand: 'K', million: 'M' } };

const ADMIN_PERMS = ['deciship.web.access', 'deciship.reports.view', 'deciship.invoices.view', 'deciship.measurements.view_all', 'deciship.prices.view'];

export function makeMe(opts: { orgRole?: 'OWNER' | 'ADMIN' | 'MEMBER'; role?: string | null; permissions?: string[]; subscribed?: boolean; suspended?: boolean; org?: boolean; orgId?: string; personId?: string } = {}): MeResponse {
  const { orgRole = 'MEMBER', role = 'ACCOUNTING', permissions = ADMIN_PERMS, subscribed = true, suspended = false, org = true, orgId = 'org-1', personId = 'p-1' } = opts;
  return {
    person: { id: personId, name: 'Selin Aydın', email: 'selin@ornek.test', phone: null, locale: 'tr', emailVerified: true },
    orgs: org ? [{ id: orgId, name: 'Örnek Ltd', orgRole, status: suspended ? 'SUSPENDED' : 'ACTIVE' }] : [],
    activeOrg: org ? { id: orgId, name: 'Örnek Ltd', country: 'TR', currency: 'TRY', orgRole, membershipId: 'm-1' } : null,
    products: [
      { key: 'deciship', available: true, launch: 'public', subscription: subscribed ? { status: 'ACTIVE', plan: 'early_access' } : null, role, permissions: role ? permissions : [] },
      { key: 'orderloom', available: false, subscription: null, role: null, permissions: [] },
      { key: 'tagpress', available: false, subscription: null, role: null, permissions: [] },
    ],
  };
}

export const overview: HubOverview = {
  product: 'deciship',
  from: '2026-10-08',
  to: '2026-11-06',
  kpis: [
    {
      id: 'overcharge',
      label: 'Fazla faturalanan',
      value: 18432.5,
      format: 'money',
      currency: 'TRY',
      previous: 16000,
      goodDirection: 'down',
      tone: 'bad',
      href: '/analytics/deciship',
      trend: [
        { id: 'current', label: 'Bu dönem', role: 'current', points: [{ x: '2026-11-05', y: 100 }, { x: '2026-11-06', y: 200 }] },
        { id: 'previous', label: 'Önceki dönem', role: 'previous', points: [{ x: '2026-10-06', y: 90 }, { x: '2026-10-07', y: 150 }] },
      ],
    },
    { id: 'match', label: 'Fatura uyum oranı', value: 84.6, format: 'percent', previous: 81.2, goodDirection: 'up' },
  ],
  alerts: [
    { id: 'tariff', tone: 'warning', title: 'Tarife doluyor', href: '/deciship/tariffs/ups' },
    { id: 'small', tone: 'bad', title: 'Küçük fark', amount: { value: 1200, format: 'money', currency: 'TRY' } },
    { id: 'photos', tone: 'info', title: 'Fotoğrafsız ölçüm', href: '/deciship/measurements?missingPhotos=1' },
    { id: 'big', tone: 'warning', title: 'Eşleşmeyen satırlar', amount: { value: 9000, format: 'money', currency: 'TRY' } },
    { id: 'urgent', tone: 'bad', title: 'Tutarsız acil' },
  ],
  setup: { completed: true, href: '/deciship/setup', label: '' },
};
