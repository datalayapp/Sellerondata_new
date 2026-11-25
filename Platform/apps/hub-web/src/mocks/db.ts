// Yalnız VITE_MOCK=1. Üretim derlemesine girmez. Tüm kayıtlar açıkça örnektir: gerçek kişi, firma veya veri değildir.
import type { OrgRole } from '@sellerondata/contracts';
import { MOCK_PASSWORD, loadMockDb, readMockSession, saveMockDb, writeMockSession, type MockPerson as SeedPerson, type MockOrg as SeedOrg, type MockSession as SeedSession } from '@sellerondata/shell/mock-seed';
import type { OrgInvitation, PersonSession, ProductRoles } from '../api/types.ts';
import type { MockRoleRow } from './roles.ts';

export { MOCK_PASSWORD };

/**
 * `pendingEmail`: onay bekleyen yeni adres; `email` onaya kadar eski kalır. `platformOperator`: platform yöneticisi (Hesap'ta
 * `PLATFORM_OPERATORS` listesi); `/me` yalnız e-postası doğrulanmışsa `true` döner (Hesap kuralı). Tohumda kimse yönetici değil.
 */
export type MockPerson = SeedPerson & { pendingEmail?: string | null; platformOperator?: boolean };
export type MockMembership = {
  id: string;
  personId: string;
  orgId: string;
  orgRole: OrgRole;
  status: 'ACTIVE' | 'SUSPENDED';
  lastActiveAt: string | null;
  /** Üyeliğin açılışı; ortak tohumda yok (görünümde firmanın açılışı). */
  createdAt?: string;
  productRoles: ProductRoles;
};
/** `companyConfirmedAt`: Merkez kurulumunun firma onayı; ortak tohumda yok, PATCH `confirmCompany` yazar (`companyConfirmedAt()`). */
export type MockOrg = SeedOrg & {
  companyConfirmedAt?: string | null;
  /** Firma kapatma (`orgClose.ts`): ortak tohumda yok; `POST /org/close` yazar, `POST /org/reopen` boşaltır. */
  closedAt?: string | null;
  closedById?: string | null;
  purgeAfter?: string | null;
};
/** `invitedById`: daveti açan üyelik (Hesap gibi); ortak tohumda yok. */
export type MockInvitation = OrgInvitation & { orgId: string; code?: string; token?: string; invitedById?: string | null };
export type MockDb = {
  persons: MockPerson[];
  orgs: MockOrg[];
  memberships: MockMembership[];
  invitations: MockInvitation[];
  sessions: PersonSession[];
  audit: { id: string; orgId: string; at: string; actor: string | null; action: string; target: string | null; meta?: Record<string, unknown>; details?: Record<string, unknown> }[];
  /** Firmaya özel roller ve hazır rollerin firmadaki hali (`roles.ts`). Ortak tohumda yok: ilk yazışta açılır. */
  roles?: MockRoleRow[];
};
export type MockSession = SeedSession;

/* Tohum, depo anahtarları ve oturum kaydı ortak: DeciShip'in mock'u da aynısını okur. */
export const loadDb = loadMockDb as () => MockDb;
export const saveDb = saveMockDb as (db: MockDb) => void;
export const readSession = readMockSession;
export const writeSession = writeMockSession;

/**
 * Firma onayı (Hesap `Organization.companyConfirmedAt`). Yazılmadıysa: boş firma (yeni kayıt, tohumdaki "Yeni Atölye") onay bekler,
 * veri dolu örnek firma onaylı (gerçekte göç öncesi firmalar onaylı doldurulur). Test kancası `sod_mock_company_confirmed`: boş firma da onaylı başlar.
 */
export function companyConfirmedAt(org: MockOrg): string | null {
  if (org.companyConfirmedAt !== undefined) return org.companyConfirmedAt;
  return !org.empty || localStorage.getItem('sod_mock_company_confirmed') ? org.createdAt : null;
}

/** Test kancası: `sod_mock_fail` içindeki uç adları 500 döner (bölüm bazlı hata). */
export function shouldFail(name: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem('sod_mock_fail') ?? '[]') as string[]).includes(name);
  } catch {
    return false;
  }
}

/** Test kancası: bir sonraki istek TOKEN_EXPIRED veya TOKEN_STALE döner; yenileme sonrası geçer. */
export function takeExpired(): string | null {
  const v = localStorage.getItem('sod_mock_expire');
  if (v) localStorage.removeItem('sod_mock_expire');
  return v;
}
