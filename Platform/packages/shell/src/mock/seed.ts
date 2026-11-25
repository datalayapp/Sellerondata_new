// Yalnız mock modu (VITE_MOCK=1). Üretim derlemesine girmez: ana giriş buradan bir şey dışa aktarmaz, `@sellerondata/shell/mock-seed` ile alınır.
// Merkez ve DeciShip tek kökende aynı `sod_mock_*` deposunu okur; tohum tek yerde durur. Kayıtlar örnektir, gerçek kişi veya firma değildir.

export const MOCK_PASSWORD = 'Test12345!';
export const MOCK_DB_KEY = 'sod_mock_db';
export const MOCK_SESSION_KEY = 'sod_mock_session';

type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MockPerson = { id: string; name: string; email: string | null; phone: string | null; locale: 'tr' | 'en'; emailVerified: boolean; password: string; otherOrgs: number };
export type MockMembership = { id: string; personId: string; orgId: string; orgRole: OrgRole; status: 'ACTIVE' | 'SUSPENDED'; lastActiveAt: string | null; productRoles: Record<string, string | null> };
export type MockOrg = { id: string; name: string; country: string; currency: string; createdAt: string; empty?: boolean };
export type MockInvitation = {
  id: string;
  orgId: string;
  kind: 'EMAIL' | 'PHONE_CODE' | 'PHONE_RESET';
  email: string | null;
  phone: string | null;
  name: string | null;
  orgRole: OrgRole;
  productRoles: Record<string, string | null> | null;
  createdAt: string;
  expiresAt: string;
  code?: string;
  token?: string;
};
export type MockPersonSession = { id: string; client: 'web' | 'mobile'; userAgent: string | null; ip: string | null; lastUsedAt: string; current?: boolean };
export type MockAudit = { id: string; orgId: string; at: string; actor: string | null; action: string; target: string | null; meta?: Record<string, unknown>; details?: Record<string, unknown> };
export type MockDb = { persons: MockPerson[]; orgs: MockOrg[]; memberships: MockMembership[]; invitations: MockInvitation[]; sessions: MockPersonSession[]; audit: MockAudit[] };
export type MockSession = { personId: string; orgId: string | null };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const person = (id: string, name: string, email: string | null, phone: string | null = null, otherOrgs = 0): MockPerson => ({
  id,
  name,
  email,
  phone,
  locale: 'tr',
  emailVerified: !!email,
  password: MOCK_PASSWORD,
  otherOrgs,
});
/**
 * Araç rolleri: DeciShip rolü elle; TagPress'te firma sahibi ve yöneticisi Yönetici (ADMIN), DeciShip'te web rolü olan çalışan
 * Kullanıcı (USER), erişimsiz kişi erişimsiz. Hesap demo tohumundan (`apps/account-api/src/seed.ts`) tek fark: yalnız mobil rolü
 * (Ölçüm) olan çalışanın TagPress rolü yok; sahte API'de "yalnız mobil uygulamayla çalışan kişi" senaryosu (sade Merkez, mobil
 * uygulama sayfası) bu kişilerle sınanır.
 */
const member = (id: string, personId: string, orgId: string, orgRole: OrgRole, deciship: string | null, lastH: number | null, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'): MockMembership => ({
  id,
  personId,
  orgId,
  orgRole,
  status,
  lastActiveAt: lastH === null ? null : hoursAgo(lastH),
  productRoles: { deciship, tagpress: orgRole !== 'MEMBER' ? 'ADMIN' : deciship && deciship !== 'MEASURE' ? 'USER' : null },
});

/** Tek tohum: kişiler, firmalar, üyelikler, davetler, oturumlar, denetim izi. */
export function createMockSeed(): MockDb {
  return {
    persons: [
      person('p1', 'Selin Aydın', 'sahip@ornek.test', null, 1),
      person('p2', 'Elif Şahin', 'yonetici@ornek.test'),
      person('p3', 'Zeynep Arslan', 'denetci@ornek.test'),
      person('p4', 'Can Yıldız', 'muhasebe@ornek.test'),
      person('p5', 'Mehmet Demir', null, '+905320000004'),
      person('p6', 'Ayşe Yılmaz', null, '+905320000006'),
      person('p7', 'Murat Koç', null, '+905320000007', 1),
      person('p8', 'Deniz Kurt', 'erisimsiz@ornek.test'),
      person('p9', 'Yeni Sahip', 'yeni@ornek.test'),
      person('p10', 'Firmasız Kişi', 'firmasiz@ornek.test'),
    ],
    orgs: [
      { id: 'o1', name: 'Örnek Firma', country: 'TR', currency: 'TRY', createdAt: hoursAgo(24 * 90) },
      { id: 'o2', name: 'Örnek İhracat Ltd.', country: 'TR', currency: 'USD', createdAt: hoursAgo(24 * 40) },
      { id: 'o3', name: 'Yeni Atölye', country: 'TR', currency: 'TRY', createdAt: hoursAgo(1), empty: true },
    ],
    memberships: [
      member('m1', 'p1', 'o1', 'OWNER', 'ADMIN', 0),
      member('m2', 'p2', 'o1', 'ADMIN', 'AUDITOR', 3),
      member('m3', 'p3', 'o1', 'MEMBER', 'AUDITOR', 26),
      member('m4', 'p4', 'o1', 'MEMBER', 'ACCOUNTING', 50),
      member('m5', 'p5', 'o1', 'MEMBER', 'MEASURE', 1),
      member('m6', 'p6', 'o1', 'MEMBER', 'MEASURE', 180, 'SUSPENDED'),
      member('m7', 'p7', 'o1', 'MEMBER', 'MEASURE', 7),
      member('m8', 'p8', 'o1', 'MEMBER', null, null),
      member('m9', 'p1', 'o2', 'ADMIN', 'ACCOUNTING', 100),
      member('m10', 'p9', 'o3', 'OWNER', 'ADMIN', 0),
      member('m11', 'p7', 'o2', 'MEMBER', 'MEASURE', 40),
    ],
    invitations: [
      {
        id: 'i1',
        orgId: 'o1',
        kind: 'PHONE_CODE',
        email: null,
        phone: '+905320000011',
        name: 'Hakan Çelik',
        orgRole: 'MEMBER',
        productRoles: { deciship: 'MEASURE' },
        createdAt: hoursAgo(20),
        expiresAt: daysFromNow(2),
        code: 'K7M2QX9P',
      },
      {
        id: 'i2',
        orgId: 'o1',
        kind: 'EMAIL',
        email: 'muhasebe2@ornek.test',
        phone: null,
        name: 'Burcu Tan',
        orgRole: 'MEMBER',
        productRoles: { deciship: 'ACCOUNTING' },
        createdAt: hoursAgo(50),
        expiresAt: daysFromNow(5),
        token: 'ornek-davet',
      },
    ],
    sessions: [
      { id: 's1', client: 'web', userAgent: navigator.userAgent, ip: '203.0.113.10', lastUsedAt: hoursAgo(0), current: true },
      { id: 's2', client: 'mobile', userAgent: 'SellerOnData/1.0 (Android 15)', ip: '203.0.113.44', lastUsedAt: hoursAgo(9) },
      { id: 's3', client: 'web', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', ip: '198.51.100.7', lastUsedAt: hoursAgo(72) },
    ],
    audit: [
      { id: 'a1', orgId: 'o1', at: hoursAgo(1.2), actor: 'Selin Aydın', action: 'member.updated', target: 'm3', details: { changes: [{ field: 'productRole', product: 'deciship', from: 'ACCOUNTING', to: 'AUDITOR' }] } },
      { id: 'a6', orgId: 'o1', at: hoursAgo(30), actor: 'Mehmet Demir', action: 'person.phone_linked', target: null },
      { id: 'a7', orgId: 'o1', at: hoursAgo(40), actor: 'Mehmet Demir', action: 'person.password_reset_by_code', target: null },
      { id: 'a2', orgId: 'o1', at: hoursAgo(20), actor: 'Selin Aydın', action: 'invitation.created', target: 'i1', meta: { name: 'Hakan Çelik' } },
      { id: 'a3', orgId: 'o1', at: hoursAgo(50), actor: 'Elif Şahin', action: 'invitation.created', target: 'i2', meta: { name: 'Burcu Tan' } },
      { id: 'a4', orgId: 'o1', at: hoursAgo(74), actor: 'Selin Aydın', action: 'member.updated', target: 'm6', details: { changes: [{ field: 'status', from: 'ACTIVE', to: 'SUSPENDED' }] } },
      { id: 'a5', orgId: 'o1', at: hoursAgo(120), actor: 'Selin Aydın', action: 'org.updated', target: 'o1' },
    ],
  };
}

export function saveMockDb(db: MockDb) {
  localStorage.setItem(MOCK_DB_KEY, JSON.stringify(db));
}

/** Depodaki veri, yoksa tohum. İki uygulama aynı kaydı okur ve yazar. */
export function loadMockDb(): MockDb {
  try {
    const raw = localStorage.getItem(MOCK_DB_KEY);
    if (raw) return JSON.parse(raw) as MockDb;
  } catch {
    /* bozuk kayıt: yeniden üret */
  }
  const db = createMockSeed();
  saveMockDb(db);
  return db;
}

export function readMockSession(): MockSession | null {
  try {
    const raw = localStorage.getItem(MOCK_SESSION_KEY);
    return raw ? (JSON.parse(raw) as MockSession) : null;
  } catch {
    return null;
  }
}

export function writeMockSession(s: MockSession | null) {
  if (s) localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(MOCK_SESSION_KEY);
}
