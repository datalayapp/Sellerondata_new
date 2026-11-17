// Yalnız VITE_MOCK=1. Firmayı kapatma ve geri açmanın sahte Hesap servisi kuralları; `browser.ts` uçları bunu çağırır. Saf: tarayıcı
// API'si yok (birim testi `src/lib/mock-org-close.test.mjs`). Sözleşme `contracts/src/tokens.ts`
// (`CloseOrgBody`, `ReopenOrgBody`, `confirmNameMatches`).
import { DEFAULT_ORG_TIME_ZONE, ORG_PURGE_DAYS_DEFAULT, confirmNameMatches, type ApiErrorCode, type CloseOrgBody, type MeResponse, type ReopenOrgBody } from '@sellerondata/contracts';
import type { MockDb, MockMembership, MockOrg, MockPerson } from './db.ts';
import type { MockResult } from './roles.ts';

const err = (status: number, code: ApiErrorCode): MockResult => ({ status, error: { code } });

/** Firmanın kapanış durumu: açık, kapalı (sahip geri açabilir) ya da saklama süresi dolmuş (gerçekte saatlik iş kalıcı siler). */
export type MockOrgState = 'ACTIVE' | 'CLOSED' | 'PURGED';

export function orgState(org: MockOrg | undefined, now: number = Date.now()): MockOrgState {
  if (!org?.closedAt) return 'ACTIVE';
  return org.purgeAfter && Date.parse(org.purgeAfter) <= now ? 'PURGED' : 'CLOSED';
}

/** Firma açık mı: kapalı ve süresi dolmuş firma etkin olamaz, üyeliği oturumda sayılmaz. */
export const isOrgOpen = (db: MockDb, orgId: string | null | undefined, now: number = Date.now()) => !!orgId && orgState(db.orgs.find((o) => o.id === orgId), now) === 'ACTIVE';

/**
 * `/me` `orgs[]`: Hesap gibi kapalı firma yalnız sahibinin listesinde (`orgStatus: 'CLOSED'`, `closedAt`, `purgeAfter`, `timeZone`); diğer üyelerde
 * ve süresi dolmuşsa hiç yok. Açık firmada bu alanlar hiç yazılmaz.
 */
export function meOrgs(db: MockDb, personId: string, now: number = Date.now()): MeResponse['orgs'] {
  return db.memberships
    .filter((m) => m.personId === personId)
    .flatMap((m): MeResponse['orgs'] => {
      const org = db.orgs.find((o) => o.id === m.orgId);
      if (!org) return [];
      const base = { id: m.orgId, name: org.name, orgRole: m.orgRole, status: m.status };
      const state = orgState(org, now);
      // Açık firma eski şekliyle (alan yok), Hesap gibi: kayıtlı fikstürler değişmez.
      if (state === 'ACTIVE') return [base];
      if (state === 'PURGED' || m.orgRole !== 'OWNER') return [];
      // Firmanın kendi saat dilimi (Hesap gibi): Merkez kapalı firmanın tarihlerini onunla yazar. Kaydı yoksa varsayılan.
      const timeZone = (org as { timeZone?: string }).timeZone ?? DEFAULT_ORG_TIME_ZONE;
      return [{ ...base, orgStatus: 'CLOSED', closedAt: org.closedAt!, purgeAfter: org.purgeAfter!, timeZone }];
    });
}

/** Kişinin açık firmadaki ilk etkin üyeliği (`except` hariç): kapatma ve giriş sonrası etkin firma. */
export function firstOpenMembership(db: MockDb, personId: string, except?: string, now: number = Date.now()): MockMembership | undefined {
  return db.memberships.find((m) => m.personId === personId && m.status === 'ACTIVE' && m.orgId !== except && isOrgOpen(db, m.orgId, now));
}

function audit(db: MockDb, orgId: string, actor: string, action: string, details: Record<string, unknown>, now: number) {
  db.audit.unshift({ id: `a${now}`, orgId, at: new Date(now).toISOString(), actor, action, target: orgId, meta: details, details });
}

/**
 * `POST /org/close`: etkin firmayı kapatır. Yalnız OWNER; önce ad (`400 CONFIRM_NAME_MISMATCH`), sonra şifre (`401 INVALID_CREDENTIALS`).
 * Başarıda yanıt gövdesi `CloseOrgResponse` (oturum `activeOrgId`: sahibin başka açık firması ya da null); oturumu çağıran yazar.
 */
export function closeOrg(db: MockDb, person: MockPerson, membership: MockMembership | null, body: Partial<CloseOrgBody>, now: number = Date.now(), days: number = ORG_PURGE_DAYS_DEFAULT): MockResult {
  if (!membership) return err(403, 'ORG_REQUIRED');
  if (membership.orgRole !== 'OWNER') return err(403, 'FORBIDDEN');
  const org = db.orgs.find((o) => o.id === membership.orgId);
  if (!org) return err(404, 'ORG_NOT_FOUND');
  if (orgState(org, now) !== 'ACTIVE') return err(409, 'ORG_CLOSED');
  if (typeof body.confirmName !== 'string' || typeof body.password !== 'string') return err(400, 'VALIDATION');
  if (!confirmNameMatches(body.confirmName, org.name)) return err(400, 'CONFIRM_NAME_MISMATCH');
  if (body.password !== person.password) return err(401, 'INVALID_CREDENTIALS');
  const closedAt = new Date(now).toISOString();
  const purgeAfter = new Date(now + days * 86_400_000).toISOString();
  org.closedAt = closedAt;
  org.purgeAfter = purgeAfter;
  org.closedById = person.id;
  const members = db.memberships.filter((m) => m.orgId === org.id).length;
  audit(db, org.id, person.name, 'org.closed', { closedAt, purgeAfter, members }, now);
  const next = firstOpenMembership(db, person.id, org.id, now);
  return { status: 200, body: { expiresIn: 600, activeOrgId: next?.orgId ?? null, closedAt, purgeAfter } };
}

/**
 * `POST /org/reopen`: kapalı firmayı geri açar; etkin firma gerekmez. Sunucuyla aynı sıra: önce firma (kişi o firmanın OWNER'ı değil ya
 * da firma yok `404 ORG_NOT_FOUND`, kapalı değil `409 CONFLICT`, süre dolmuş `410 ORG_PURGED`), sonra şifre (`401`). Başarıda geri açılan
 * firma etkin olur.
 */
export function reopenOrg(db: MockDb, person: MockPerson, body: Partial<ReopenOrgBody>, now: number = Date.now()): MockResult {
  if (typeof body.orgId !== 'string' || typeof body.password !== 'string') return err(400, 'VALIDATION');
  const org = db.orgs.find((o) => o.id === body.orgId);
  const owner = db.memberships.find((m) => m.personId === person.id && m.orgId === body.orgId && m.orgRole === 'OWNER');
  if (!org || !owner) return err(404, 'ORG_NOT_FOUND');
  const state = orgState(org, now);
  if (state === 'ACTIVE') return err(409, 'CONFLICT');
  if (state === 'PURGED') return err(410, 'ORG_PURGED');
  if (body.password !== person.password) return err(401, 'INVALID_CREDENTIALS');
  const details = { closedAt: org.closedAt, purgeAfter: org.purgeAfter };
  org.closedAt = null;
  org.purgeAfter = null;
  org.closedById = null;
  audit(db, org.id, person.name, 'org.reopened', details, now);
  return { status: 200, body: { expiresIn: 600, activeOrgId: org.id } };
}
