// Yalnız VITE_MOCK=1. Sözleşmeye (ARCHITECTURE §6, §7) uyan sahte API'nin işleyicileri. Tarayıcıda `browser.ts` çalıştırır;
// `npm test` (test/account-contract.test.mjs) aynı işleyicileri Node'da (`msw/node`) çağırıp gerçek Hesap kaydına karşı sınar.
import { delay, http, HttpResponse } from 'msw';
import {
  AUDIT_ACTION_LABEL,
  ERROR_MESSAGES,
  ORG_ROLES,
  ORG_ROLE_LABEL,
  PERMISSION_LABEL,
  PRODUCTS,
  PRODUCT_KEYS,
  defaultTimeZone,
  type CatalogResponse,
  type Permission,
  localeFromAcceptLanguage,
  ROLE_FORBIDDEN_REASONS,
  type ApiErrorCode,
  type AuditEntry,
  type AuditMemberChange,
  type CreateRoleBody,
  type PatchRoleBody,
  type JoinPreview,
  type Locale,
  type MeResponse,
  type OrgRole,
  type ProductKey,
  currencyForCountry,
} from '@sellerondata/contracts';
import type { InviteBody, InvitePreview, OrgInfo, OrgMember, OrgSubscription, ProductRoles } from '../api/types.ts';
import { companyConfirmedAt, loadDb, MOCK_PASSWORD, readSession, saveDb, shouldFail, takeExpired, writeSession, type MockDb, type MockMembership, type MockPerson } from './db.ts';
import { aiCalls, aiCallsExport, aiCallsParams, aiPeriodOk, aiUsage, type DatasetParams, type MockCtx } from './deciship.ts';
import { hubPermissions, hubProvider, type HubProvider, type HubReply, type Recordings } from './hub.ts';
import { checkAssignment, createRole, deleteRole, patchRole, resetRole, resolveRole, rolesResponse, type MockResult, type RoleTarget } from './roles.ts';
import { closeOrg, firstOpenMembership, isOrgOpen, meOrgs, orgState, reopenOrg } from './orgClose.ts';

const localeOf = (req: Request): Locale => localeFromAcceptLanguage(req.headers.get('accept-language'));

function fail(req: Request, status: number, code: ApiErrorCode, message?: string, details?: unknown) {
  return HttpResponse.json({ error: { code, message: message ?? ERROR_MESSAGES[code][localeOf(req)], details } }, { status });
}

/** Rol kurallarının sonucu (`roles.ts`) yanıta: `ROLE_FORBIDDEN` metni nedene göre (Hesap gibi, `ROLE_FORBIDDEN_REASONS`). */
function roleReply(req: Request, r: MockResult) {
  if (!r.error) return r.body === undefined ? new HttpResponse(null, { status: r.status }) : HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  const reason = (r.error.details as { reason?: keyof typeof ROLE_FORBIDDEN_REASONS } | undefined)?.reason;
  const message = r.error.code === 'ROLE_FORBIDDEN' && reason && ROLE_FORBIDDEN_REASONS[reason] ? ROLE_FORBIDDEN_REASONS[reason][localeOf(req)] : undefined;
  return fail(req, r.status, r.error.code, message, r.error.details);
}

const normalizePhone = (raw: string) => {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `+9${digits}`;
  if (digits.length === 10) return `+90${digits}`;
  return digits;
};

/** Hesap gibi: Türkçe klavyeden gelen `İ` ve `ı` da `I` sayılır. */
const normalizeCode = (raw: string) => raw.trim().replace(/[İı]/g, 'I').toLocaleUpperCase('en');

type Ctx = { db: MockDb; person: MockPerson; membership: MockMembership | null };

/** Oturum yoksa 401, test kancası varsa TOKEN_EXPIRED/TOKEN_STALE. */
function authed(req: Request): Ctx | Response {
  const s = readSession();
  if (!s) return fail(req, 401, 'UNAUTHORIZED');
  // Hesap gibi (requireMember): firmaya bağlı yazmada başlık zorunlu ve oturumunkiyle aynı olmalı. Okuma denetlenmez.
  const path = new URL(req.url).pathname;
  // Kapalı firmanın geri açılması etkin firma istemez (Hesap gibi): başlık denetimi dışında.
  const orgFree = /^\/api\/account\/(me(\/|$)|orgs$|auth\/|org\/reopen$)/.test(path);
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (s.orgId && write && !orgFree && req.headers.get('x-sod-org') !== s.orgId) return fail(req, 409, 'ORG_MISMATCH');
  const expired = takeExpired();
  if (expired) return fail(req, 401, expired as ApiErrorCode);
  const db = loadDb();
  const person = db.persons.find((p) => p.id === s.personId);
  if (!person) return fail(req, 401, 'UNAUTHORIZED');
  // Kapalı firma etkin olamaz (Hesap gibi): eski oturum o firmada kaldıysa yazma `409 ORG_CLOSED`, okumada firmasız sayılır.
  if (s.orgId && write && !orgFree && !isOrgOpen(db, s.orgId)) return fail(req, 409, 'ORG_CLOSED');
  const membership = db.memberships.find((m) => m.personId === person.id && m.orgId === s.orgId && m.status === 'ACTIVE' && isOrgOpen(db, m.orgId)) ?? null;
  return { db, person, membership };
}

/**
 * Test kancası: `sod_mock_subscription` taklit firmanın aboneliğinin durumunu belirler (varsayılan ACTIVE):
 * `READ_ONLY` (durdurulmuş), `CANCELED` (iptal, 30 gün sonrasına kadar okunur), `EXPIRED` (iptal, saklama süresi dolmuş: `/me`'de abonelik ve rol düşer).
 */
type MockSub = { status: OrgSubscription['status']; plan: string; deleteAfter: string | null };
function mockSubscription(): MockSub | null {
  const hook = localStorage.getItem('sod_mock_subscription');
  if (hook === 'READ_ONLY') return { status: 'READ_ONLY', plan: 'early_access', deleteAfter: null };
  if (hook === 'CANCELED') return { status: 'CANCELED', plan: 'early_access', deleteAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  if (hook === 'EXPIRED') return null;
  return { status: 'ACTIVE', plan: 'early_access', deleteAfter: null };
}

/** Firmanın dili ve saat dilimi: tohumda yok; PATCH yazdıysa o, yoksa Hesap'ın açılış değeri gibi (dil `tr`, saat dilimi ülkeden). */
function orgSettings(org: MockDb['orgs'][number]): { locale: Locale; timeZone: string } {
  const saved = org as { locale?: Locale; timeZone?: string };
  return { locale: saved.locale ?? 'tr', timeZone: saved.timeZone ?? defaultTimeZone(org.country) };
}

/** `GET /org` ve `PATCH /org` yanıtı (Hesap `routes/org.ts`): okuma kişinin firma rolünü de taşır. */
function orgView(org: MockDb['orgs'][number], orgRole?: OrgRole): OrgInfo & { orgRole?: OrgRole } {
  return { id: org.id, name: org.name, country: org.country, currency: org.currency, ...orgSettings(org), createdAt: org.createdAt, companyConfirmedAt: companyConfirmedAt(org), ...(orgRole ? { orgRole } : {}) };
}

/** Hesap gibi (`lib/me.ts`): hazır rol adı kişinin kayıtlı dilinde (`locale` verilmezse); isteğin dili değil. */
function buildMe({ db, person, membership }: Ctx, locale: Locale = person.locale): MeResponse {
  const org = membership ? db.orgs.find((o) => o.id === membership.orgId) : null;
  // Kapalı firma yalnız sahibinin listesinde, süresi dolan hiç kimsenin (`orgClose.ts`).
  const orgs = meOrgs(db, person.id);
  return {
    person: { id: person.id, name: person.name, email: person.email, phone: person.phone, locale: person.locale, emailVerified: person.emailVerified, pendingEmail: person.pendingEmail ?? null },
    orgs,
    activeOrg: org && membership ? { id: org.id, name: org.name, country: org.country, currency: org.currency, ...orgSettings(org), orgRole: membership.orgRole, membershipId: membership.id, companyConfirmedAt: companyConfirmedAt(org) } : null,
    account: {
      canCreateOrg: !localStorage.getItem('sod_mock_register_closed') && !inviteOnly() && person.email !== null,
      createOrgRequiresEmail: person.email === null,
      suspendedOrgCount: orgs.filter((o) => o.status === 'SUSPENDED').length,
      mailEnabled: !localStorage.getItem('sod_mock_mail_off'),
      // Posta gerçek adrese gider mi (SMTP): taklitte posta açıksa gider.
      mailDelivers: !localStorage.getItem('sod_mock_mail_off'),
      canLeaveActiveOrg: !!membership && membership.orgRole !== 'OWNER',
      leaveRequiresPassword: person.email === null,
      passwordRecovery: person.email ? 'email' : orgs.length === 1 && orgs[0]!.status === 'ACTIVE' && orgs[0]!.orgRole !== 'OWNER' ? 'org_admin' : 'none',
      defaultCountry: org?.country ?? 'TR',
    },
    // Hesap servisiyle aynı kural (`productAccessFor`): kapalı (`off`) üründe abonelik yok; canlı abonelik ürüne rol ve izin verir;
    // bu firmada açık = `public`, ya da `pilot` ve canlı abonelik.
    products: PRODUCT_KEYS.map((key) => {
      const launch = PRODUCTS[key].launch;
      const sub = launch !== 'off' && membership ? mockSubscription() : null;
      // Hesap gibi (`resolveRole`): rol firmada görünmüyorsa (gizlenmiş hazır rol, silinmiş özel rol) düşer.
      const resolved = sub && membership ? resolveRole(db, membership.orgId, key, membership.productRoles[key], locale) : null;
      return {
        key,
        available: launch === 'public' || (launch === 'pilot' && sub !== null),
        launch,
        subscription: sub ? { status: sub.status, plan: sub.plan } : null,
        role: resolved?.key ?? null,
        permissions: resolved ? resolved.permissions : [],
        ...(resolved ? { roleLabel: resolved.name, roleKind: resolved.kind } : {}),
      };
    }),
  };
}

function memberView(db: MockDb, m: MockMembership): OrgMember & { createdAt: string; personSuspended: boolean } {
  const p = db.persons.find((x) => x.id === m.personId)!;
  // Hesap gibi: rolü olmayan araç listede hiç yok (null yazılmaz); kişi askısı (`personSuspended`) taklitte yok.
  const productRoles = Object.fromEntries(Object.entries(m.productRoles).filter(([, role]) => !!role)) as ProductRoles;
  const createdAt = m.createdAt ?? db.orgs.find((o) => o.id === m.orgId)?.createdAt ?? new Date().toISOString();
  return { id: m.id, personId: p.id, name: p.name, email: p.email, phone: p.phone, orgRole: m.orgRole, status: m.status, lastActiveAt: m.lastActiveAt, createdAt, productRoles, emailVerified: p.emailVerified, resetCodeAllowed: m.status === 'ACTIVE' && !p.email && p.otherOrgs === 0, personSuspended: false };
}

/** Davet görünümü (Hesap `routes/org.ts`): süresi doldu mu, kod denemesi, daveti açan üyelik (tohumda yazılı değilse firmanın sahibi). */
function invitationView<T extends { expiresAt: string; attempts?: number; invitedById?: string | null }>(i: T, db?: MockDb, orgId?: string) {
  const owner = db?.memberships.find((m) => m.orgId === orgId && m.orgRole === 'OWNER')?.id ?? null;
  return { ...i, expired: Date.parse(i.expiresAt) <= Date.now(), attempts: i.attempts ?? 0, invitedById: i.invitedById ?? owner };
}

function requireAdmin(req: Request, ctx: Ctx): Response | null {
  if (!ctx.membership || (ctx.membership.orgRole !== 'OWNER' && ctx.membership.orgRole !== 'ADMIN')) return fail(req, 403, 'FORBIDDEN');
  return null;
}

function newCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % 32]).join('');
}

function auditAdd(db: MockDb, ctx: Ctx, action: string, target: string | null, meta?: Record<string, unknown>) {
  db.audit.unshift({ id: `a${Date.now()}`, orgId: ctx.membership!.orgId, at: new Date().toISOString(), actor: ctx.person.name, action, target, meta });
}

/** Hesap gibi (`lib/orgs.ts`): yeni firmanın sahibine, herkese açık (`public`) ve sahip rolü olan her aracın sahip rolü. */
const ownerProductRoles = (): ProductRoles =>
  Object.fromEntries(PRODUCT_KEYS.filter((k) => PRODUCTS[k].launch === 'public' && PRODUCTS[k].ownerRole).map((k) => [k, PRODUCTS[k].ownerRole]));

const productGuard = (req: Request, ctx: Ctx, perm: string, product: ProductKey): Response | null => {
  if (!ctx.membership) return fail(req, 403, 'ORG_REQUIRED');
  const role = resolveRole(ctx.db, ctx.membership.orgId, product, ctx.membership.productRoles[product], localeOf(req));
  if (!role) return fail(req, 403, 'NO_PRODUCT_ACCESS');
  if (!role.permissions.includes(perm)) return fail(req, 403, 'FORBIDDEN', perm);
  return null;
};

/** Ürün bağlamı: dil, o araçtaki izinler, boş firma. */
function productCtx(req: Request, ctx: Ctx, product: ProductKey): MockCtx {
  const m = ctx.membership;
  const perms = (m ? resolveRole(ctx.db, m.orgId, product, m.productRoles[product], localeOf(req))?.permissions : undefined) ?? [];
  return { locale: localeOf(req), can: (p) => perms.includes(p), empty: !!ctx.db.orgs.find((o) => o.id === ctx.membership?.orgId)?.empty };
}

function readFilterParams(url: URL): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of new Set(url.searchParams.keys())) if (key.startsWith('filter.')) out[key.slice(7)] = url.searchParams.getAll(key);
  return out;
}

function datasetParams(url: URL): DatasetParams {
  return {
    page: Math.max(1, Number(url.searchParams.get('page')) || 1),
    pageSize: Math.min(200, Number(url.searchParams.get('pageSize')) || 25),
    q: url.searchParams.get('q') ?? '',
    sort: url.searchParams.get('sort') ?? undefined,
    dir: url.searchParams.get('dir') ?? undefined,
    filters: readFilterParams(url),
  };
}

/** Test kancası: `EMAIL_VERIFICATION_REQUIRED=true` gibi davranır. */
const verificationRequired = () => !!localStorage.getItem('sod_mock_verify_required');
/** Kapalı deneme kipi (SIGNUP_MODE=invite): `sod_mock_signup_invite` doluysa kayıt yalnız davetle, yeni firma kapalı. */
const inviteOnly = () => !!localStorage.getItem('sod_mock_signup_invite');
const latency = () => delay(localStorage.getItem('sod_mock_fast') ? 0 : 120 + Math.random() * 180);

/** Hesap gibi: yaygın şifre alan hatası olarak döner. */
const WEAK_PASSWORDS = new Set(['1234567890', 'password123', 'qwertyuiop']);
const weakPassword = (req: Request, password: unknown) =>
  typeof password === 'string' && WEAK_PASSWORDS.has(password.toLowerCase())
    ? fail(req, 400, 'VALIDATION', undefined, [{ path: 'password', code: 'weak_password', message: 'Şifre en az 10 karakter olmalı ve yaygın kullanılan bir şifre olmamalı.' }])
    : null;

/** Hesap uçları ve araçlara özel uçlar. Araçların ortak Merkez uçları `productHandlers`. */
export const accountHandlers = [
  // Test kancası: ağ düştü. Yanıt yerine ağ hatası.
  http.all('/api/*', () => (localStorage.getItem('sod_mock_offline') ? HttpResponse.error() : undefined)),
  // Test kancası: Hesap kesik, ağ geçidinin yanıtı. DeciShip uçları çalışır.
  http.all('/api/account/*', () => (localStorage.getItem('sod_mock_account_down') ? HttpResponse.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503 }) : undefined)),

  // ---------- oturum ----------
  http.post('/api/account/auth/login', async ({ request }) => {
    await latency();
    if (!request.headers.get('x-sod-csrf')) return fail(request, 403, 'CSRF_FAILED');
    const body = (await request.json()) as { identifier: string; password: string };
    const db = loadDb();
    const id = body.identifier.trim().toLowerCase();
    const phone = normalizePhone(id);
    const person = db.persons.find((p) => p.email === id || p.phone === phone);
    if (!person || person.password !== body.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    if (verificationRequired() && person.email && !person.emailVerified) return fail(request, 403, 'EMAIL_NOT_VERIFIED');
    const first = firstOpenMembership(db, person.id);
    writeSession({ personId: person.id, orgId: first?.orgId ?? null });
    // Hesap gibi: tarayıcı girişi kişinin `/me`'sini de döner.
    const membership = first ? (db.memberships.find((m) => m.id === first.id) ?? null) : null;
    return HttpResponse.json({ expiresIn: 600, activeOrgId: first?.orgId ?? null, me: buildMe({ db, person, membership }) });
  }),
  http.post('/api/account/auth/refresh', async ({ request }) => {
    await latency();
    // Test kancaları: yenileme ucu ayakta değil / yenileme jetonu kesin reddedildi.
    if (localStorage.getItem('sod_mock_refresh_down')) return fail(request, 503, 'INTERNAL');
    if (localStorage.getItem('sod_mock_no_refresh')) {
      writeSession(null);
      return fail(request, 401, 'UNAUTHORIZED');
    }
    if (!readSession()) return fail(request, 401, 'UNAUTHORIZED');
    localStorage.setItem('sod_mock_refreshes', String(Number(localStorage.getItem('sod_mock_refreshes') ?? 0) + 1));
    return HttpResponse.json({ expiresIn: 600, activeOrgId: readSession()!.orgId });
  }),
  http.post('/api/account/auth/logout', async () => {
    await latency();
    writeSession(null);
    localStorage.removeItem('sod_refreshed_at');
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/account/auth/switch-org', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const { orgId } = (await request.json()) as { orgId: string };
    const m = ctx.db.memberships.find((x) => x.personId === ctx.person.id && x.orgId === orgId && x.status === 'ACTIVE');
    // Süresi dolmuş firma gerçekte silinmiştir (üyelik yok); kapalı firma etkin yapılamaz.
    const state = orgState(ctx.db.orgs.find((o) => o.id === orgId));
    if (!m || state === 'PURGED') return fail(request, 403, 'FORBIDDEN');
    if (state === 'CLOSED') return fail(request, 409, 'ORG_CLOSED');
    writeSession({ personId: ctx.person.id, orgId });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: orgId });
  }),
  http.post('/api/account/auth/register', async ({ request }) => {
    await latency();
    if (localStorage.getItem('sod_mock_register_closed')) return fail(request, 403, 'REGISTRATION_CLOSED');
    const body = (await request.json()) as { orgName: string; name: string; email: string; password: string; country: string; locale: Locale; signupInvite?: string };
    // Kapalı deneme (SIGNUP_MODE=invite): davetsiz kayıt reddedilir. Sahte sunucu her davet jetonunu geçerli sayar, `gecersiz` hariç.
    if (inviteOnly() && !body.signupInvite) return fail(request, 403, 'SIGNUP_INVITE_REQUIRED');
    if (inviteOnly() && body.signupInvite === 'gecersiz') return fail(request, 403, 'SIGNUP_INVITE_INVALID');
    const weak = weakPassword(request, body.password);
    if (weak) return weak;
    const db = loadDb();
    if (db.persons.some((p) => p.email === body.email.toLowerCase())) return fail(request, 409, 'EMAIL_TAKEN');
    const seq = Date.now();
    const pid = `p${seq}`;
    const oid = `o${seq}`;
    const mid = `m${seq}`;
    db.persons.push({ id: pid, name: body.name, email: body.email.toLowerCase(), phone: null, locale: body.locale, emailVerified: false, password: body.password, otherOrgs: 0 });
    db.orgs.push({ id: oid, name: body.orgName, country: body.country, currency: currencyForCountry(body.country), createdAt: new Date().toISOString(), empty: true });
    db.memberships.push({ id: mid, personId: pid, orgId: oid, orgRole: 'OWNER', status: 'ACTIVE', lastActiveAt: new Date().toISOString(), productRoles: ownerProductRoles() });
    saveDb(db);
    if (verificationRequired()) return HttpResponse.json({ verificationRequired: true }, { status: 202 });
    writeSession({ personId: pid, orgId: oid });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: oid });
  }),
  http.post('/api/account/auth/forgot-password', async () => {
    await latency();
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/account/auth/reset-password', async ({ request }) => {
    await latency();
    const { token } = (await request.json()) as { token: string };
    if (token === 'gecersiz') return fail(request, 400, 'INVITE_INVALID');
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/account/auth/verify-email', async ({ request }) => {
    await latency();
    const { token, password } = (await request.json()) as { token: string; password?: string };
    if (token === 'gecersiz') return fail(request, 400, 'TOKEN_INVALID');
    if (token === 'sifreli') {
      // Kod henüz ApiErrorCode listesinde değil (contracts başka parçada): ham yanıt.
      if (!password) return HttpResponse.json({ error: { code: 'PASSWORD_REQUIRED', message: '' } }, { status: 401 });
      if (password !== 'Demo12345!') return fail(request, 401, 'INVALID_CREDENTIALS');
      return HttpResponse.json({ ok: true, result: 'verified' });
    }
    if (token === 'cakisma') return fail(request, 409, 'EMAIL_TAKEN');
    // Bekleyen adres jetonu: oturumdaki kişinin bekleyen adresi uygulanır.
    const s = readSession();
    const db = loadDb();
    const owner = s ? db.persons.find((p) => p.id === s.personId) : undefined;
    if (owner?.pendingEmail && token !== 'zaten') {
      owner.email = owner.pendingEmail;
      owner.pendingEmail = null;
      owner.emailVerified = true;
      saveDb(db);
      return HttpResponse.json({ ok: true, result: 'changed' });
    }
    return HttpResponse.json({ ok: true, result: token === 'zaten' ? 'already' : 'verified' });
  }),
  // Her zaman { ok: true }: adres var mı yok mu belli edilmez.
  http.post('/api/account/auth/resend-verification', async () => {
    await latency();
    return HttpResponse.json({ ok: true });
  }),
  http.post('/api/account/auth/join/preview', async ({ request }) => {
    await latency();
    const { phone, code, linkCurrentAccount } = (await request.json()) as { phone: string; code: string; linkCurrentAccount?: boolean };
    const db = loadDb();
    const normalized = normalizePhone(phone);
    const inv = db.invitations.find((i) => i.kind === 'PHONE_CODE' && i.phone === normalized && i.code === normalizeCode(code));
    if (!inv) return fail(request, 400, 'INVITE_INVALID');
    const existing = db.persons.find((p) => p.phone === normalized);
    // Gerçek API gibi: oturum yalnız bağlama açıkça seçilince kullanılır.
    const current = linkCurrentAccount && readSession() ? db.persons.find((p) => p.id === readSession()!.personId) : undefined;
    const preview: JoinPreview = { linksCurrentAccount: !existing && !!current && current.phone === null, orgName: db.orgs.find((o) => o.id === inv.orgId)!.name, name: inv.name, personExists: !!existing, purpose: 'JOIN' };
    return HttpResponse.json(preview);
  }),
  http.post('/api/account/auth/join/accept', async ({ request }) => {
    await latency();
    const body = (await request.json()) as { phone: string; code: string; name?: string; password: string; linkCurrentAccount?: boolean };
    const db = loadDb();
    const normalized = normalizePhone(body.phone);
    const idx = db.invitations.findIndex((i) => i.kind === 'PHONE_CODE' && i.phone === normalized && i.code === normalizeCode(body.code));
    if (idx < 0) return fail(request, 400, 'INVITE_INVALID');
    const inv = db.invitations[idx]!;
    let person = db.persons.find((p) => p.phone === normalized);
    // Oturum açık, hesapta telefon yok: numara bu hesaba yazılır, şifre bu hesabın şifresidir.
    const signedIn = body.linkCurrentAccount && readSession() ? db.persons.find((p) => p.id === readSession()!.personId) : undefined;
    if (!person && signedIn && signedIn.phone === null) {
      if (signedIn.password !== body.password) return fail(request, 401, 'INVALID_CREDENTIALS');
      signedIn.phone = normalized;
      person = signedIn;
    }
    if (person && person.password !== body.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    if (!person) {
      person = { id: `p${Date.now()}`, name: body.name ?? inv.name ?? '', email: null, phone: normalized, locale: localeOf(request), emailVerified: false, password: body.password, otherOrgs: 0 };
      db.persons.push(person);
    }
    db.memberships.push({ id: `m${Date.now()}`, personId: person.id, orgId: inv.orgId, orgRole: inv.orgRole, status: 'ACTIVE', lastActiveAt: new Date().toISOString(), productRoles: inv.productRoles ?? {} });
    db.invitations.splice(idx, 1);
    saveDb(db);
    writeSession({ personId: person.id, orgId: inv.orgId });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: inv.orgId });
  }),
  http.get('/api/account/invites/:token', async ({ request, params }) => {
    await latency();
    const db = loadDb();
    const inv = db.invitations.find((i) => i.token === params.token);
    if (!inv) return fail(request, 400, 'INVITE_INVALID');
    const preview: InvitePreview = {
      orgName: db.orgs.find((o) => o.id === inv.orgId)!.name,
      email: inv.email,
      name: inv.name,
      orgRole: inv.orgRole,
      personExists: db.persons.some((p) => p.email === inv.email),
      expiresAt: inv.expiresAt,
    };
    return HttpResponse.json(preview);
  }),
  http.post('/api/account/invites/:token/accept', async ({ request, params }) => {
    await latency();
    const body = (await request.json()) as { name?: string; password?: string };
    const db = loadDb();
    const idx = db.invitations.findIndex((i) => i.token === params.token);
    if (idx < 0) return fail(request, 400, 'INVITE_INVALID');
    const inv = db.invitations[idx]!;
    let person = db.persons.find((p) => p.email === inv.email);
    if (person) {
      const s = readSession();
      if (!s) return fail(request, 401, 'LOGIN_REQUIRED');
      if (s.personId !== person.id) return fail(request, 403, 'INVITE_WRONG_ACCOUNT');
    } else {
      person = { id: `p${Date.now()}`, name: body.name ?? inv.name ?? '', email: inv.email, phone: null, locale: localeOf(request), emailVerified: true, password: body.password ?? MOCK_PASSWORD, otherOrgs: 0 };
      db.persons.push(person);
    }
    db.memberships.push({ id: `m${Date.now()}`, personId: person.id, orgId: inv.orgId, orgRole: inv.orgRole, status: 'ACTIVE', lastActiveAt: new Date().toISOString(), productRoles: inv.productRoles ?? {} });
    db.invitations.splice(idx, 1);
    saveDb(db);
    writeSession({ personId: person.id, orgId: inv.orgId });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: inv.orgId });
  }),

  // ---------- kişi ----------
  http.get('/api/account/me', async ({ request }) => {
    await latency();
    if (shouldFail('me')) return fail(request, 500, 'INTERNAL');
    // Test kancası: yavaş ağda /me geç döner.
    const slow = Number(localStorage.getItem('sod_mock_me_delay'));
    if (slow) await delay(slow);
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    return HttpResponse.json(buildMe(ctx));
  }),
  http.patch('/api/account/me', async ({ request }) => {
    await latency();
    // Test kancası: kayıt yavaş, kişi bu sırada sayfa değiştirir.
    const slowPatch = Number(localStorage.getItem('sod_mock_me_patch_delay'));
    if (slowPatch) await delay(slowPatch);
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const { currentPassword, ...body } = (await request.json()) as Partial<Pick<MockPerson, 'name' | 'email' | 'phone' | 'locale'>> & { currentPassword?: string };
    // Telefon kendi kendine değiştirilemez (SMS gelene kadar).
    if (body.phone && body.phone !== ctx.person.phone) return fail(request, 403, 'PHONE_CHANGE_NOT_ALLOWED');
    if ('email' in body || 'phone' in body) {
      if (!currentPassword) return fail(request, 400, 'VALIDATION');
      if (currentPassword !== ctx.person.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    }
    if ('email' in body && !body.email && ctx.db.memberships.some((m) => m.personId === ctx.person.id && m.orgRole === 'OWNER')) return fail(request, 409, 'OWNER_REQUIRES_EMAIL');
    const { email: nextEmail, ...rest } = body;
    Object.assign(ctx.person, rest);
    if ('email' in body) {
      if (!nextEmail) {
        ctx.person.email = null;
        ctx.person.pendingEmail = null;
      } else if (nextEmail.toLowerCase() !== ctx.person.email) {
        ctx.person.pendingEmail = nextEmail.trim().toLowerCase();
      }
    }
    saveDb(ctx.db);
    return HttpResponse.json({ expiresIn: 600, activeOrgId: ctx.membership?.orgId ?? null, me: buildMe(ctx) });
  }),
  http.post('/api/account/me/email/resend', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const sentTo = ctx.person.pendingEmail ? 'pending' : ctx.person.email && !ctx.person.emailVerified ? 'current' : null;
    return HttpResponse.json({ ok: true, sentTo });
  }),
  http.delete('/api/account/me/pending-email', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    ctx.person.pendingEmail = null;
    saveDb(ctx.db);
    return HttpResponse.json({ ok: true });
  }),
  http.post('/api/account/me/password', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const body = (await request.json()) as { currentPassword: string; newPassword: string };
    const weak = weakPassword(request, body.newPassword);
    if (weak) return weak;
    if (body.currentPassword !== ctx.person.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    ctx.person.password = body.newPassword;
    saveDb(ctx.db);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/account/me/sessions', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    // Hesap gibi: açılış anı da var (tohumda yoksa son kullanım).
    return HttpResponse.json({ sessions: ctx.db.sessions.map((x) => ({ ...x, createdAt: x.createdAt ?? x.lastUsedAt })) });
  }),
  http.delete('/api/account/me/sessions/:id', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    ctx.db.sessions = ctx.db.sessions.filter((s) => s.id !== params.id);
    saveDb(ctx.db);
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------- firma ----------
  http.post('/api/account/orgs', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (localStorage.getItem('sod_mock_register_closed')) return fail(request, 403, 'REGISTRATION_CLOSED');
    if (inviteOnly()) return fail(request, 403, 'SIGNUP_INVITE_REQUIRED');
    if (!ctx.person.email) return fail(request, 409, 'OWNER_REQUIRES_EMAIL');
    const body = (await request.json()) as { name: string; country?: string };
    const seq = Date.now();
    ctx.db.orgs.push({ id: `o${seq}`, name: body.name, country: body.country ?? 'TR', currency: 'TRY', createdAt: new Date().toISOString(), empty: true });
    ctx.db.memberships.push({ id: `m${seq}`, personId: ctx.person.id, orgId: `o${seq}`, orgRole: 'OWNER', status: 'ACTIVE', lastActiveAt: new Date().toISOString(), productRoles: ownerProductRoles() });
    saveDb(ctx.db);
    writeSession({ personId: ctx.person.id, orgId: `o${seq}` });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: `o${seq}` }, { status: 201 });
  }),
  http.post('/api/account/org/leave', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (!ctx.membership) return fail(request, 403, 'ORG_REQUIRED');
    if (ctx.membership.orgRole === 'OWNER') return fail(request, 409, 'LAST_OWNER');
    const body = (await request.json()) as { password?: string };
    if (!ctx.person.email) {
      if (!body.password) return fail(request, 403, 'PASSWORD_CONFIRM_REQUIRED');
      if (body.password !== ctx.person.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    }
    const orgId = ctx.membership.orgId;
    ctx.db.memberships = ctx.db.memberships.filter((m) => m.id !== ctx.membership!.id);
    const next = ctx.db.memberships.find((m) => m.personId === ctx.person.id && m.status === 'ACTIVE');
    ctx.db.audit.unshift({ id: `a${Date.now()}`, orgId, at: new Date().toISOString(), actor: ctx.person.name, action: 'member.left', target: ctx.membership.id });
    saveDb(ctx.db);
    writeSession({ personId: ctx.person.id, orgId: next?.orgId ?? null });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: next?.orgId ?? null });
  }),
  // Firmayı kapatma ve geri açma (`orgClose.ts`). Test kancası `org.close.limit`: şifre denemesi sınırı (429).
  http.post('/api/account/org/close', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (shouldFail('org.close.limit')) return HttpResponse.json({ error: { code: 'TOO_MANY_ATTEMPTS', message: ERROR_MESSAGES.TOO_MANY_ATTEMPTS[localeOf(request)] } }, { status: 429, headers: { 'Retry-After': '900' } });
    const r = closeOrg(ctx.db, ctx.person, ctx.membership, (await request.json()) as Record<string, unknown>);
    if (r.error) return fail(request, r.status, r.error.code);
    saveDb(ctx.db);
    writeSession({ personId: ctx.person.id, orgId: (r.body as { activeOrgId: string | null }).activeOrgId });
    return HttpResponse.json(r.body as Record<string, unknown>);
  }),
  http.post('/api/account/org/reopen', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (shouldFail('org.close.limit')) return HttpResponse.json({ error: { code: 'TOO_MANY_ATTEMPTS', message: ERROR_MESSAGES.TOO_MANY_ATTEMPTS[localeOf(request)] } }, { status: 429, headers: { 'Retry-After': '900' } });
    const r = reopenOrg(ctx.db, ctx.person, (await request.json()) as Record<string, unknown>);
    if (r.error) return fail(request, r.status, r.error.code);
    saveDb(ctx.db);
    writeSession({ personId: ctx.person.id, orgId: (r.body as { activeOrgId: string }).activeOrgId });
    return HttpResponse.json(r.body as Record<string, unknown>);
  }),
  http.get('/api/account/catalog', async ({ request }) => {
    await latency();
    // Hesap gibi (`routes/public.ts`): araç, firma rolü ve izin adları kayıttan, isteğin dilinde.
    const locale = localeOf(request);
    const body: CatalogResponse = {
      locale,
      registrationEnabled: !localStorage.getItem('sod_mock_register_closed'),
      signupMode: inviteOnly() ? 'invite' : 'open',
      mailEnabled: !localStorage.getItem('sod_mock_mail_off'),
      products: PRODUCT_KEYS.map((key) => {
        const p = PRODUCTS[key];
        return {
          key,
          name: p.name,
          tagline: p.tagline[locale],
          basePath: p.basePath,
          color: p.color,
          available: p.launch === 'public',
          launch: p.launch,
          roles: p.roles.map((r) => ({ key: r.key, label: r.label[locale], description: r.description[locale], permissions: r.permissions })),
        };
      }),
      orgRoles: ORG_ROLES.map((key) => ({ key, label: ORG_ROLE_LABEL[key][locale] })),
      permissions: (Object.keys(PERMISSION_LABEL) as Permission[]).map((key) => ({ key, label: PERMISSION_LABEL[key][locale] })),
    };
    return HttpResponse.json(body);
  }),
  http.get('/api/account/org', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    // Hesap gibi (`requireMember`): firmanın her üyesi okur; yanıtta kişinin firma rolü.
    if (!ctx.membership) return fail(request, 403, 'ORG_REQUIRED');
    const org = ctx.db.orgs.find((o) => o.id === ctx.membership!.orgId)!;
    return HttpResponse.json(orgView(org, ctx.membership.orgRole));
  }),
  http.patch('/api/account/org', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const org = ctx.db.orgs.find((o) => o.id === ctx.membership!.orgId)!;
    // Hesap servisi gibi: `confirmCompany` yalnız `true`; onaysız firmada onay tarihini yazar, onaylıda değişmez (tekrar zararsız).
    const { confirmCompany, ...fields } = (await request.json()) as Record<string, unknown> & { confirmCompany?: unknown };
    if (confirmCompany !== undefined && confirmCompany !== true) return fail(request, 400, 'VALIDATION');
    Object.assign(org, fields);
    if (confirmCompany === true && companyConfirmedAt(org) === null) org.companyConfirmedAt = new Date().toISOString();
    saveDb(ctx.db);
    const { createdAt: _createdAt, ...view } = orgView(org);
    return HttpResponse.json(view);
  }),
  http.post('/api/account/org/transfer-ownership', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (ctx.membership?.orgRole !== 'OWNER') return fail(request, 403, 'FORBIDDEN');
    const body = (await request.json()) as { membershipId: string; password: string };
    if (body.password !== ctx.person.password) return fail(request, 401, 'INVALID_CREDENTIALS');
    const target = ctx.db.memberships.find((m) => m.id === body.membershipId && m.orgId === ctx.membership!.orgId);
    if (!target) return fail(request, 404, 'NOT_FOUND');
    const targetPerson = ctx.db.persons.find((p) => p.id === target.personId);
    if (shouldFail('transfer.email') || !targetPerson?.email) return fail(request, 409, 'OWNER_REQUIRES_EMAIL');
    if (!targetPerson.emailVerified) return fail(request, 409, 'OWNER_REQUIRES_EMAIL', undefined, { reason: 'EMAIL_NOT_VERIFIED' });
    target.orgRole = 'OWNER';
    ctx.membership.orgRole = 'ADMIN';
    saveDb(ctx.db);
    return HttpResponse.json({ ok: true });
  }),
  http.get('/api/account/org/members', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    return HttpResponse.json({ members: ctx.db.memberships.filter((m) => m.orgId === ctx.membership!.orgId).map((m) => memberView(ctx.db, m)) });
  }),
  http.post('/api/account/org/members/invite', async ({ request }) => {
    await latency();
    if (shouldFail('invite.limit')) return HttpResponse.json({ error: { code: 'TOO_MANY_ATTEMPTS', message: ERROR_MESSAGES.TOO_MANY_ATTEMPTS[localeOf(request)] } }, { status: 429, headers: { 'Retry-After': '1800' } });
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const body = (await request.json()) as InviteBody;
    if (body.orgRole === 'ADMIN' && ctx.membership!.orgRole !== 'OWNER') return fail(request, 403, 'FORBIDDEN');
    const assign = checkAssignment(ctx.db, ctx.membership!, body.productRoles, localeOf(request));
    if (assign) return roleReply(request, assign);
    const orgId = ctx.membership!.orgId;
    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.kind === 'PHONE_CODE' && (!phone || phone.length < 12)) return fail(request, 400, 'VALIDATION');
    const existing = ctx.db.persons.find((p) => (phone && p.phone === phone) || (body.email && p.email === body.email.toLowerCase()));
    if (existing && ctx.db.memberships.some((m) => m.personId === existing.id && m.orgId === orgId)) return fail(request, 409, 'ALREADY_MEMBER');
    const id = `i${Date.now()}`;
    const base = {
      id,
      orgId,
      kind: body.kind,
      email: body.email?.toLowerCase() ?? null,
      phone,
      name: body.name,
      orgRole: body.orgRole,
      productRoles: body.productRoles,
      createdAt: new Date().toISOString(),
      invitedById: ctx.membership!.id,
    };
    auditAdd(ctx.db, ctx, 'invitation.created', id, { kind: body.kind, orgRole: body.orgRole });
    if (body.kind === 'PHONE_CODE') {
      const code = newCode();
      const inv = { ...base, code, expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString() };
      ctx.db.invitations.unshift(inv);
      saveDb(ctx.db);
      const { code: _hidden, orgId: _org, ...view } = inv;
      return HttpResponse.json({ invitation: invitationView(view), code }, { status: 201 });
    }
    const token = `ornek-${id}`;
    const link = `${window.location.origin}/invite/${token}`;
    const inv = { ...base, token, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
    ctx.db.invitations.unshift(inv);
    saveDb(ctx.db);
    const { token: _token, orgId: _orgId, ...view } = inv;
    return HttpResponse.json({ invitation: invitationView(view), link, mailSent: !localStorage.getItem('sod_mock_mail_limited') }, { status: 201 });
  }),
  http.patch('/api/account/org/members/:id', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const target = ctx.db.memberships.find((m) => m.id === params.id && m.orgId === ctx.membership!.orgId);
    if (!target) return fail(request, 404, 'NOT_FOUND');
    const body = (await request.json()) as { orgRole?: OrgRole; productRoles?: ProductRoles; status?: 'ACTIVE' | 'SUSPENDED' };
    const self = target.id === ctx.membership!.id;
    if (self && target.orgRole === 'OWNER') {
      if (body.status === 'SUSPENDED' || (body.orgRole && body.orgRole !== 'OWNER')) return fail(request, 409, 'LAST_OWNER');
    } else {
      if (self) return fail(request, 403, 'CANNOT_MANAGE_SELF');
      if (target.orgRole === 'OWNER') return fail(request, 403, 'CANNOT_MANAGE_OWNER');
      if (body.orgRole === 'OWNER') return fail(request, 403, 'USE_OWNERSHIP_TRANSFER');
      if (ctx.membership!.orgRole === 'ADMIN' && (target.orgRole === 'ADMIN' || body.orgRole === 'ADMIN')) return fail(request, 403, 'FORBIDDEN');
    }
    if (shouldFail('team.patch')) return fail(request, 403, 'CANNOT_MANAGE_OWNER');
    const assign = checkAssignment(ctx.db, ctx.membership!, body.productRoles, localeOf(request));
    if (assign) return roleReply(request, assign);
    // Hesap gibi (org.ts PATCH /org/members/:id): `changed` yalnız gerçekten değişen alanlar; denetim izi neyin neye
    // döndüğünü (`changes`) ve kişinin adını taşır; hiçbir şey değişmediyse iz yazılmaz.
    const changed: string[] = [];
    const changes: AuditMemberChange[] = [];
    if (body.orgRole && body.orgRole !== target.orgRole) {
      changed.push('orgRole');
      changes.push({ field: 'orgRole', from: target.orgRole, to: body.orgRole });
    }
    if (body.status && body.status !== target.status) {
      changed.push('status');
      changes.push({ field: 'status', from: target.status, to: body.status });
    }
    // Hesap gibi: değişiklik anındaki rol adı (`fromLabel`/`toLabel`), rol sonradan silinse ya da adı değişse de iz okunur kalsın.
    const labelOf = (product: string, key: string | null) => (key ? (resolveRole(ctx.db, target.orgId, product as ProductKey, key, localeOf(request))?.name ?? null) : null);
    const roleChanges = Object.entries(body.productRoles ?? {})
      .map(([product, role]) => {
        const from = target.productRoles[product as ProductKey] ?? null;
        const to = role ?? null;
        return { field: 'productRole' as const, product, from, to, fromLabel: labelOf(product, from), toLabel: labelOf(product, to) };
      })
      .filter((c) => c.from !== c.to);
    if (roleChanges.length) {
      changed.push('productRoles');
      changes.push(...roleChanges);
    }
    if (body.orgRole) target.orgRole = body.orgRole;
    if (body.productRoles) target.productRoles = { ...target.productRoles, ...body.productRoles };
    if (body.status) target.status = body.status;
    if (changed.length) auditAdd(ctx.db, ctx, 'member.updated', target.id, { changed, changes, name: ctx.db.persons.find((p) => p.id === target.personId)?.name });
    saveDb(ctx.db);
    return HttpResponse.json({ ok: true, changed });
  }),
  http.delete('/api/account/org/members/:id', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const target = ctx.db.memberships.find((m) => m.id === params.id && m.orgId === ctx.membership!.orgId);
    if (!target) return fail(request, 404, 'NOT_FOUND');
    if (target.id === ctx.membership!.id) return fail(request, 403, 'CANNOT_MANAGE_SELF');
    if (target.orgRole === 'OWNER') return fail(request, 403, 'CANNOT_MANAGE_OWNER');
    if (ctx.membership!.orgRole === 'ADMIN' && target.orgRole === 'ADMIN') return fail(request, 403, 'FORBIDDEN');
    const removed = ctx.db.persons.find((p) => p.id === target.personId);
    auditAdd(ctx.db, ctx, 'member.removed', target.id, { name: removed?.name });
    ctx.db.memberships = ctx.db.memberships.filter((m) => m.id !== target.id);
    saveDb(ctx.db);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/account/org/members/:id/reset-code', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const target = ctx.db.memberships.find((m) => m.id === params.id && m.orgId === ctx.membership!.orgId);
    if (!target) return fail(request, 404, 'NOT_FOUND');
    const person = ctx.db.persons.find((p) => p.id === target.personId)!;
    if (ctx.membership!.orgRole === 'ADMIN' && target.orgRole === 'ADMIN') return fail(request, 403, 'FORBIDDEN');
    if (target.status !== 'ACTIVE') return fail(request, 409, 'RESET_CODE_NOT_ALLOWED', undefined, { reason: 'NOT_ACTIVE' });
    if (person.email || person.otherOrgs > 0) return fail(request, 409, 'RESET_CODE_NOT_ALLOWED', undefined, { reason: 'SELF_RESET' });
    return HttpResponse.json({ code: newCode() }, { status: 201 });
  }),
  http.get('/api/account/org/invitations', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const items = ctx.db.invitations.filter((i) => i.orgId === ctx.membership!.orgId).map(({ code: _c, token: _t, orgId: _o, ...view }) => invitationView(view, ctx.db, ctx.membership!.orgId));
    return HttpResponse.json({ invitations: items });
  }),
  http.post('/api/account/org/invitations/:id/resend', async ({ request, params }) => {
    await latency();
    if (shouldFail('invite.exhausted')) return fail(request, 409, 'INVITE_ATTEMPTS_EXHAUSTED');
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const inv = ctx.db.invitations.find((i) => i.id === params.id && i.orgId === ctx.membership!.orgId);
    if (!inv) return fail(request, 404, 'NOT_FOUND');
    if (inv.kind === 'PHONE_CODE') {
      inv.code = newCode();
      inv.expiresAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
      saveDb(ctx.db);
      return HttpResponse.json({ code: inv.code });
    }
    inv.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    saveDb(ctx.db);
    return HttpResponse.json({ link: `${window.location.origin}/invite/${inv.token}`, mailSent: !localStorage.getItem('sod_mock_mail_limited') });
  }),
  http.delete('/api/account/org/invitations/:id', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    ctx.db.invitations = ctx.db.invitations.filter((i) => i.id !== params.id);
    saveDb(ctx.db);
    return new HttpResponse(null, { status: 204 });
  }),
  // ---------- Özel roller (sözleşme contracts/src/roles.ts) ----------
  http.get('/api/account/org/roles', async ({ request }) => {
    await latency();
    if (shouldFail('roles.list')) return fail(request, 500, 'INTERNAL');
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    return HttpResponse.json(rolesResponse(ctx.db, ctx.membership!, localeOf(request)));
  }),
  http.post('/api/account/org/roles', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const r = createRole(ctx.db, ctx.membership!, ctx.person.name, (await request.json()) as CreateRoleBody, localeOf(request));
    if (!r.error) saveDb(ctx.db);
    return roleReply(request, r);
  }),
  http.post('/api/account/org/roles/builtin/:product/:key/reset', async ({ request, params }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const r = resetRole(ctx.db, ctx.membership!, ctx.person.name, String(params.product), String(params.key), localeOf(request));
    if (!r.error) saveDb(ctx.db);
    return roleReply(request, r);
  }),
  // Hazır rol önce: `/org/roles/:id` deseni `builtin/...` yolunu yakalamaz (tek parça), sıra yine de açık olsun.
  ...['/api/account/org/roles/builtin/:product/:key', '/api/account/org/roles/:id'].flatMap((path) => {
    const target = (params: Record<string, unknown>): RoleTarget => (params.id !== undefined ? { custom: String(params.id) } : { product: String(params.product), key: String(params.key) });
    return [
      http.patch(path, async ({ request, params }) => {
        await latency();
        if (shouldFail('roles.version')) return fail(request, 409, 'ROLE_VERSION');
        const ctx = authed(request);
        if (ctx instanceof Response) return ctx;
        const guard = requireAdmin(request, ctx);
        if (guard) return guard;
        const r = patchRole(ctx.db, ctx.membership!, ctx.person.name, target(params), (await request.json()) as PatchRoleBody, localeOf(request));
        if (!r.error) saveDb(ctx.db);
        return roleReply(request, r);
      }),
      http.delete(path, async ({ request, params }) => {
        await latency();
        const ctx = authed(request);
        if (ctx instanceof Response) return ctx;
        const guard = requireAdmin(request, ctx);
        if (guard) return guard;
        const r = deleteRole(ctx.db, ctx.membership!, ctx.person.name, target(params), new URL(request.url).searchParams.get('reassignTo'), localeOf(request));
        if (!r.error) saveDb(ctx.db);
        return roleReply(request, r);
      }),
    ];
  }),
  http.get('/api/account/org/subscriptions', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    // Hesap gibi (org.ts GET /org/subscriptions): satır yalnız firmada aboneliği olan araca; aboneliği olmayan araç listede
    // hiç yok (Merkez "Açık değil" yazar). Firma açılırken `public` araçlara satır yazılır (lib/orgs.ts); `pilot` araç
    // `product:launch` ister, taklitte yok. `EXPIRED`: satır silinmez, CANCELED ve `deleteAfter` geçmiş; `/me`'de ürün düşer.
    const subscriptions: (OrgSubscription & { name: string; limits: Record<string, unknown>; canceledAt: string | null; deleteAfter: string | null })[] = PRODUCT_KEYS.filter(
      (k) => PRODUCTS[k].launch === 'public',
    ).map((product) => {
      const s = mockSubscription() ?? { status: 'CANCELED' as const, plan: 'early_access', deleteAfter: new Date(Date.now() - 86_400_000).toISOString() };
      const canceledAt = s.status === 'CANCELED' && s.deleteAfter ? new Date(Date.parse(s.deleteAfter) - 30 * 86_400_000).toISOString() : null;
      return { product, name: PRODUCTS[product].name, status: s.status, plan: s.plan, limits: {}, currentPeriodEnd: null, canceledAt, deleteAfter: s.deleteAfter };
    });
    return HttpResponse.json({ subscriptions });
  }),
  http.post('/api/account/org/billing/*', async ({ request }) => {
    await latency();
    return fail(request, 501, 'PAYMENT_NOT_AVAILABLE');
  }),
  http.get('/api/account/org/audit', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = requireAdmin(request, ctx);
    if (guard) return guard;
    const page = Math.max(1, Number(new URL(request.url).searchParams.get('page')) || 1);
    const pageSize = Number(new URL(request.url).searchParams.get('pageSize')) || 50;
    const all = ctx.db.audit.filter((a) => a.orgId === ctx.membership!.orgId);
    const locale = localeOf(request);
    // Hesap gibi (org.ts GET /org/audit, contracts AuditEntry): `details` ve `meta` aynı; `targetName` hedef üyenin adı, yoksa kayıttaki ad.
    const items: AuditEntry[] = all.slice((page - 1) * pageSize, page * pageSize).map((a) => {
      const details = a.details ?? a.meta ?? null;
      const member = ctx.db.memberships.find((m) => m.id === a.target);
      const person = ctx.db.persons.find((p) => p.id === (member?.personId ?? a.target));
      const metaName = typeof details?.name === 'string' ? details.name : null;
      // Hesap gibi: firmanın her izinin hedefi var; tohumdaki hedefsiz kişi izinde (`person.*`) hedef işlemi yapan kişidir.
      const target = a.target ?? ctx.db.persons.find((p) => p.name === a.actor)?.id ?? null;
      return { id: a.id, at: a.at, actor: a.actor, action: a.action, label: AUDIT_ACTION_LABEL[a.action]?.[locale] ?? a.action, target, targetName: person?.name ?? metaName, details, meta: details };
    });
    return HttpResponse.json({ items, page, pageSize, total: all.length });
  }),

  // ---------- DeciShip'e özel Merkez uçları (yapay zekâ kullanımı). Ortak Merkez uçları aşağıda, araç kaydından (`hubRoutes`). ----------
  http.get('/api/deciship/platform/ai-usage', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = productGuard(request, ctx, 'deciship.settings.manage', 'deciship');
    if (guard) return guard;
    // Yapay zekâ ayrıntılı dökümü: `?period=YYYY-MM` (pencere dışı 400), test kancası `sod_mock_fail` içinde `deciship.ai-usage`.
    const pctx = productCtx(request, ctx, 'deciship');
    const period = new URL(request.url).searchParams.get('period') || undefined;
    if (period && !aiPeriodOk(period, pctx)) return fail(request, 400, 'VALIDATION');
    if (shouldFail('deciship.ai-usage')) return fail(request, 500, 'INTERNAL');
    const usage = aiUsage(pctx, period);
    if (!usage) return fail(request, 404, 'NOT_FOUND');
    return HttpResponse.json(usage);
  }),
  // Döküm sayfası; test kancası `deciship.ai-calls` (500).
  http.get('/api/deciship/platform/ai-usage/calls', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = productGuard(request, ctx, 'deciship.settings.manage', 'deciship');
    if (guard) return guard;
    if (shouldFail('deciship.ai-calls')) return fail(request, 500, 'INTERNAL');
    const pctx = productCtx(request, ctx, 'deciship');
    const q = aiCallsParams(new URL(request.url), pctx);
    if (!q) return fail(request, 400, 'VALIDATION');
    const page = aiCalls(q, pctx);
    if (!page) return fail(request, 404, 'NOT_FOUND');
    return HttpResponse.json(page);
  }),
  // Excel: ayar + dışa aktarma izni; test kancası `deciship.ai-export` (500). İçerik örnek (bkz. aiCallsExport).
  http.get('/api/deciship/platform/ai-usage/calls/export', async ({ request }) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const guard = productGuard(request, ctx, 'deciship.settings.manage', 'deciship') ?? productGuard(request, ctx, 'deciship.data.export', 'deciship');
    if (guard) return guard;
    if (shouldFail('deciship.ai-export')) return fail(request, 500, 'INTERNAL');
    const pctx = productCtx(request, ctx, 'deciship');
    const q = aiCallsParams(new URL(request.url), pctx);
    if (!q) return fail(request, 400, 'VALIDATION');
    const file = aiCallsExport(q, pctx);
    if (!file) return fail(request, 404, 'NOT_FOUND');
    return new HttpResponse(file.body, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${file.name}"` } });
  }),
];

/** Sağlayıcı yanıtı → HTTP: gövdesiz hata durumdan (403 FORBIDDEN, 404 NOT_FOUND); kayıttaki hata gövdesi aynen döner. */
function hubReply(req: Request, r: HubReply): Response {
  if (r.body !== undefined) return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  return r.status === 404 ? fail(req, 404, 'NOT_FOUND') : fail(req, r.status, 'FORBIDDEN');
}

/**
 * Bir aracın ortak Merkez uçları (§7), araçtan bağımsız (`hub.ts`). Kapılar kayıttaki `hub` izinleri: Genel Bakış, Analiz ve
 * Etkinlik `hub.analytics`; veri kümeleri `hub.data`; CSV `hub.export` + `hub.data`. Kaydında `hub` olmayan araçta yalnız firma
 * istenir. Test kancaları araç anahtarlı (`sod_mock_fail` içinde `<anahtar>.overview`, `<anahtar>.overview.403`, `<anahtar>.analytics`,
 * `<anahtar>.analytics.403`, `<anahtar>.activity`, `<anahtar>.export.toolarge`); DeciShip'te bugünkü adlarla aynı.
 */
function hubRoutes(key: ProductKey, provider: HubProvider) {
  const perms = hubPermissions(key);
  const base = `/api/${key}/platform`;
  const gate = (req: Request, ctx: Ctx, perm: string | undefined): Response | null => {
    if (!ctx.membership) return fail(req, 403, 'ORG_REQUIRED');
    return perm ? productGuard(req, ctx, perm, key) : null;
  };
  const period = (url: URL) => ({ from: url.searchParams.get('from') ?? '', to: url.searchParams.get('to') ?? '' });
  return [
    http.get(`${base}/overview`, async ({ request }) => {
      // Test kancası: firma başına sınır aşıldı, bir kez 429 + Retry-After.
      if (localStorage.getItem('sod_mock_rate_once')) {
        localStorage.removeItem('sod_mock_rate_once');
        return HttpResponse.json({ error: { code: 'TOO_MANY_ATTEMPTS', message: ERROR_MESSAGES.TOO_MANY_ATTEMPTS[localeOf(request)] } }, { status: 429, headers: { 'Retry-After': '1' } });
      }
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.view);
      if (guard) return guard;
      if (shouldFail(`${key}.overview`)) return fail(request, 500, 'INTERNAL');
      // Gerçek uç gibi: rol az önce verilmiş olabilir.
      if (shouldFail(`${key}.overview.403`)) return fail(request, 403, 'NO_PRODUCT_ACCESS', undefined, { refreshable: true });
      if (localStorage.getItem('sod_mock_access_once')) {
        localStorage.removeItem('sod_mock_access_once');
        return fail(request, 403, 'NO_PRODUCT_ACCESS', undefined, { refreshable: true });
      }
      const url = new URL(request.url);
      const r = provider.overview({ ...period(url), compare: false, filters: {} }, productCtx(request, ctx, key));
      // Test kancası: `sod_mock_demo_tour` deneme turu açık gibi (Y122): gerçek uç gibi `sample: true`, yoksa alan hiç yok.
      if (r.status === 200 && localStorage.getItem('sod_mock_demo_tour')) (r.body as { sample?: boolean }).sample = true;
      return hubReply(request, r);
    }),
    http.get(`${base}/analytics`, async ({ request }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.view);
      if (guard) return guard;
      if (shouldFail(`${key}.analytics`)) return fail(request, 500, 'INTERNAL');
      if (shouldFail(`${key}.analytics.403`)) return fail(request, 403, 'NO_PRODUCT_ACCESS');
      const url = new URL(request.url);
      return hubReply(request, provider.analytics({ ...period(url), compare: !!url.searchParams.get('compare'), filters: readFilterParams(url) }, productCtx(request, ctx, key)));
    }),
    http.get(`${base}/datasets`, async ({ request }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.data);
      if (guard) return guard;
      return hubReply(request, provider.datasets(productCtx(request, ctx, key)));
    }),
    http.get(`${base}/datasets/:id/export`, async ({ request, params }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.export) ?? gate(request, ctx, perms?.data);
      if (guard) return guard;
      const pctx = productCtx(request, ctx, key);
      if (shouldFail(`${key}.export.toolarge`)) return fail(request, 400, 'EXPORT_TOO_LARGE' as ApiErrorCode, provider.tooLargeMessage?.(pctx, 128_400));
      const r = provider.datasetCsv(String(params.id), datasetParams(new URL(request.url)), pctx);
      if (!('csv' in r)) return hubReply(request, r);
      const day = new Date().toISOString().slice(0, 10);
      return new HttpResponse(r.csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${key}-${params.id}-${day}.csv"` } });
    }),
    http.get(`${base}/datasets/:id`, async ({ request, params }) => {
      // Test kancası: verilen yanıtı aynen döner.
      const override = localStorage.getItem('sod_mock_dataset_override');
      if (override) return HttpResponse.json(JSON.parse(override));
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.data);
      if (guard) return guard;
      return hubReply(request, provider.dataset(String(params.id), datasetParams(new URL(request.url)), productCtx(request, ctx, key)));
    }),
    http.get(`${base}/activity`, async ({ request }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      const guard = gate(request, ctx, perms?.view);
      if (guard) return guard;
      if (shouldFail(`${key}.activity`)) return fail(request, 500, 'INTERNAL');
      const url = new URL(request.url);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Number(url.searchParams.get('pageSize')) || undefined;
      return hubReply(request, provider.activity(page, size, productCtx(request, ctx, key)));
    }),
  ];
}

/** Kayıtta olmayan araç ya da tanınmayan Merkez yolu. */
const unknownProduct = http.get('/api/:product/platform/*', ({ request }) => fail(request, 404, 'NOT_FOUND'));

/** Kayıttaki her aracın ortak Merkez uçları (sağlayıcı `hub.ts`), sonda tanınmayan araç için 404. `recordings`: aracın gerçek yanıt kaydı. */
export function productHandlers(recordings: (key: ProductKey) => Recordings | undefined) {
  return [...PRODUCT_KEYS.flatMap((key) => hubRoutes(key, hubProvider(key, recordings(key)))), unknownProduct];
}
