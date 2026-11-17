// Yalnız VITE_MOCK=1. Hesap servisinin (`/api/account`) DeciShip'in ihtiyaç duyduğu kısmı ve ürün tarafı denetim sırası (ARCHITECTURE §5).
// Tohum ve depo Merkez'le ortak (`@sellerondata/shell/mock-seed`): tek kökende ikisi aynı oturumu ve veriyi görür.
import { delay, http, HttpResponse } from 'msw';
import {
  ERROR_MESSAGES,
  ORG_HEADER,
  PRODUCTS,
  PRODUCT_KEYS,
  localeFromAcceptLanguage,
  permissionsOf,
  productRole,
  type ApiErrorCode,
  type Locale,
  type MeResponse,
  type Permission,
} from '@sellerondata/contracts';
import { loadMockDb, readMockSession, saveMockDb, writeMockSession, type MockDb, type MockMembership, type MockOrg, type MockPerson } from '@sellerondata/shell/mock-seed';

export const loadDb = loadMockDb;
const readSession = readMockSession;
const writeSession = writeMockSession;

const localeOf = (req: Request): Locale => localeFromAcceptLanguage(req.headers.get('accept-language'));

export function fail(req: Request, status: number, code: ApiErrorCode, message?: string) {
  return HttpResponse.json({ error: { code, message: message ?? ERROR_MESSAGES[code][localeOf(req)] } }, { status });
}

/** Test kancaları: `sod_mock_expire` bir sonraki isteği TOKEN_EXPIRED/TOKEN_STALE yapar; `sod_mock_force` bir sonraki yazma isteğini verilen kodla reddeder. */
function take(key: string): string | null {
  const v = localStorage.getItem(key);
  if (v) localStorage.removeItem(key);
  return v;
}
const flag = (key: string) => !!localStorage.getItem(key);
export const latency = () => delay(flag('sod_mock_fast') ? 0 : 80 + Math.random() * 120);

type Ctx = { db: MockDb; person: MockPerson; membership: MockMembership | null };

/** Test kancası: `sod_mock_suspended` oturumdaki firmanın üyeliğini askıya alır. */
const suspendedOrg = (orgId: string | null | undefined) => !!orgId && flag('sod_mock_suspended');

function context(): Ctx | null {
  const s = readSession();
  if (!s) return null;
  const db = loadDb();
  const p = db.persons.find((x) => x.id === s.personId);
  if (!p) return null;
  const membership = suspendedOrg(s.orgId) ? null : (db.memberships.find((m) => m.personId === p.id && m.orgId === s.orgId && m.status === 'ACTIVE') ?? null);
  return { db, person: p, membership };
}

export function activeOrg() {
  const ctx = context();
  return ctx?.membership ? (ctx.db.orgs.find((o) => o.id === ctx.membership!.orgId) ?? null) : null;
}

/**
 * Merkez kurulumu: firma bilgileri onaylandı mı (`activeOrg.companyConfirmedAt`). Ortak tohum alanı taşıyorsa (Merkez sahte
 * sunucusu onaylayınca) o okunur, yoksa firma açılışında onaylı sayılır (Hesap'ın geriye dönük doldurması gibi).
 * Test kancası: `sod_mock_company_unconfirmed` firmayı onay bekliyor gösterir (yeni firma).
 */
function companyConfirmedAt(o: MockOrg): string | null {
  if (flag('sod_mock_company_unconfirmed')) return null;
  const v = (o as MockOrg & { companyConfirmedAt?: string | null }).companyConfirmedAt;
  return v === undefined ? o.createdAt : v;
}

/** Sihirbaz yanıtındaki `company.confirmed` (DeciShip'in olaydan tuttuğu kopya): Merkez'le aynı değer. */
export function activeCompanyConfirmed(): boolean {
  const o = activeOrg();
  return !!o && companyConfirmedAt(o) !== null;
}

export function activeMemberName() {
  return context()?.person.name ?? 'Kullanıcı';
}

/** Oturumdaki kişi (itiraz kayıtlarında "kim"). */
export function activePerson(): { id: string; name: string } {
  const p = context()?.person;
  return p ? { id: p.id, name: p.name } : { id: 'p0', name: 'Kullanıcı' };
}

const subscriptionStatus = () => (flag('sod_mock_readonly') ? ('READ_ONLY' as const) : ('ACTIVE' as const));

function buildMe({ db, person: p, membership }: Ctx): MeResponse {
  const org = membership ? db.orgs.find((o) => o.id === membership.orgId) : null;
  const sessionOrg = readSession()?.orgId;
  const orgs = db.memberships
    .filter((m) => m.personId === p.id)
    .map((m) => ({ id: m.orgId, name: db.orgs.find((o) => o.id === m.orgId)!.name, orgRole: m.orgRole, status: m.orgId === sessionOrg && suspendedOrg(sessionOrg) ? ('SUSPENDED' as const) : m.status }));
  return {
    person: { id: p.id, name: p.name, email: p.email, phone: p.phone, locale: (localStorage.getItem('sod_mock_locale') as Locale | null) ?? p.locale, emailVerified: p.emailVerified },
    orgs,
    account: { canCreateOrg: true, createOrgRequiresEmail: false, suspendedOrgCount: orgs.filter((o) => o.status === 'SUSPENDED').length, mailEnabled: false, canLeaveActiveOrg: false, leaveRequiresPassword: false, passwordRecovery: 'email', defaultCountry: 'TR' },
    activeOrg: org && membership ? { id: org.id, name: org.name, country: org.country, currency: org.currency, companyConfirmedAt: companyConfirmedAt(org), orgRole: membership.orgRole, membershipId: membership.id } : null,
    products: PRODUCT_KEYS.map((key) => {
      // test kancası: `sod_mock_role_closed` rol Hesap'ta kapandı, ürün API'si olayı henüz almadı (eski jetonu kabul ediyor)
      const role = key === 'deciship' && flag('sod_mock_role_closed') ? null : (membership?.productRoles[key] ?? null);
      // Hesap servisiyle aynı kural: kapalı (`off`) üründe abonelik yok; açık = `public`, ya da `pilot` ve abonelik var.
      const launch = PRODUCTS[key].launch;
      const subscription = launch !== 'off' && membership ? { status: subscriptionStatus(), plan: 'early_access' } : null;
      const available = launch === 'public' || (launch === 'pilot' && subscription !== null);
      return {
        key,
        available,
        launch,
        subscription,
        role,
        // Rol adı sunucudan gelir (düzenlenmiş/özel rol); sahte API'de hazır rolün katalog adı.
        ...(role && productRole(key, role) ? { roleLabel: productRole(key, role)!.label[(localStorage.getItem('sod_mock_locale') as Locale | null) ?? p.locale], roleKind: 'builtin' as const } : {}),
        // test kancası: `sod_mock_strip_perm` listedeki izni kaldırır (katalogda olmayan bir izin kombinasyonu için)
        permissions: subscription ? permissionsOf(key, role).filter((p) => p !== localStorage.getItem('sod_mock_strip_perm')) : [],
      };
    }),
  };
}

/**
 * Test kancaları: `sod_mock_offline` varken sunucuya ulaşılamaz (Merkez'le aynı). `sod_mock_account_down` varken yalnız Hesap kesiktir:
 * ağ geçidi 503 döner, DeciShip API çalışır (ARCHITECTURE §5: açık oturumlar sürer).
 */
const offline = http.all('/api/*', () => (flag('sod_mock_offline') ? HttpResponse.error() : undefined));
const accountDown = http.all('/api/account/*', () => (flag('sod_mock_account_down') ? new HttpResponse('Service Unavailable', { status: 503 }) : undefined));

export const accountHandlers = [
  offline,
  accountDown,
  http.post('/api/account/auth/refresh', async ({ request }) => {
    await latency();
    if (!request.headers.get('x-sod-csrf')) return fail(request, 403, 'CSRF_FAILED');
    if (!readSession() || flag('sod_mock_no_refresh')) return fail(request, 401, 'UNAUTHORIZED');
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
    if (!request.headers.get('x-sod-csrf')) return fail(request, 403, 'CSRF_FAILED');
    const ctx = context();
    if (!ctx) return fail(request, 401, 'UNAUTHORIZED');
    const { orgId } = (await request.json()) as { orgId: string };
    const m = ctx.db.memberships.find((x) => x.personId === ctx.person.id && x.orgId === orgId && x.status === 'ACTIVE');
    if (!m) return fail(request, 403, 'FORBIDDEN');
    writeSession({ personId: ctx.person.id, orgId });
    return HttpResponse.json({ expiresIn: 600, activeOrgId: orgId });
  }),
  http.get('/api/account/me', async ({ request }) => {
    await latency();
    const ctx = context();
    if (!ctx) return fail(request, 401, 'UNAUTHORIZED');
    return HttpResponse.json(buildMe(ctx));
  }),
  http.patch('/api/account/me', async ({ request }) => {
    await latency();
    const ctx = context();
    if (!ctx) return fail(request, 401, 'UNAUTHORIZED');
    const body = (await request.json()) as { locale?: Locale };
    if (body.locale) {
      ctx.person.locale = body.locale;
      saveMockDb(ctx.db);
    }
    return HttpResponse.json(buildMe(ctx));
  }),
];

/**
 * Uç kuralı (API `test/routeRules.ts` ile aynı dil): `session` üründe rolü olan herkes; izin listesi biri yeter; `{ all }` hepsi gerekir.
 * Herkese açık iki uç (`/health`, `/internal/events`) panelden çağrılmaz, tabloda yok.
 */
export type MockRouteRule = 'session' | readonly Permission[] | { all: readonly Permission[] };

const p = (...permissions: Permission[]) => permissions;
const SETTINGS = p('deciship.settings.manage');
const TARIFFS = p('deciship.tariffs.edit');
const TARIFFS_VIEW = p('deciship.tariffs.view');
const UPLOAD = p('deciship.invoices.upload');
const VIEW = p('deciship.invoices.view');
const REPORTS = p('deciship.reports.view');
const DECIDE = p('deciship.lines.decide');
const EXPORT = p('deciship.data.export');
/** Fiyatlı ikili dosya ve itiraz metni: dışa aktarma izninin yanında fiyat izni de (gerçek API'de ikinci kat). */
const EXPORT_PRICED = { all: p('deciship.data.export', 'deciship.prices.view') } as const;
const DISPUTES = p('deciship.disputes.manage');
const CAPTURE = p('deciship.measurements.capture');
const READ_MEASUREMENTS = p('deciship.measurements.capture', 'deciship.measurements.view_all');
const WRITE_MEASUREMENTS = p('deciship.measurements.capture', 'deciship.measurements.manage');
const READ_CARRIERS = p('deciship.tariffs.edit', 'deciship.invoices.upload', 'deciship.invoices.view');
const JOBS = p('deciship.invoices.upload', 'deciship.tariffs.edit', 'deciship.settings.manage');

/**
 * Hangi uç hangi izni ister: gerçek API'nin elle kopyası. `test/mock-permissions.test.ts` bunu API'nin `test/routeRules.ts`
 * tablosuyla birebir karşılaştırır (o tablo da API'nin izin matrisi testinde gerçek yol listesiyle); yeni uç ikisine birden girer.
 * Uç içi ek kurallar (ör. yeniden hesap önizlemesinde yükleme izniyle yalnız başlık düzeltme kipi) burada yok.
 */
export const MOCK_ROUTE_RULES: Record<string, MockRouteRule> = {
  'GET /me': 'session',
  'GET /members': p('deciship.measurements.view_all'),

  'GET /settings': 'session',
  'PATCH /settings': SETTINGS,
  'GET /settings/onboarding': SETTINGS,
  'PATCH /settings/onboarding': SETTINGS,
  'POST /settings/data/reset': SETTINGS,
  'POST /settings/recompare-invoices/preview': SETTINGS,
  'POST /settings/recompare-invoices': SETTINGS,
  'POST /settings/demo': SETTINGS,
  'DELETE /settings/demo': SETTINGS,

  'GET /box-presets': CAPTURE,
  'POST /box-presets': SETTINGS,
  'PATCH /box-presets/:id': SETTINGS,
  'DELETE /box-presets/:id': SETTINGS,

  'GET /measurements/check': CAPTURE,
  'GET /measurements/stats/today': READ_MEASUREMENTS,
  'POST /measurements': CAPTURE,
  'GET /measurements': READ_MEASUREMENTS,
  'GET /measurements/:id': READ_MEASUREMENTS,
  'PATCH /measurements/:id': WRITE_MEASUREMENTS,
  'DELETE /measurements/:id': WRITE_MEASUREMENTS,
  'POST /measurements/:id/restore': WRITE_MEASUREMENTS,
  'POST /measurements/:id/purge': p('deciship.measurements.manage'),

  'GET /files/:id': 'session',
  'GET /reference-card.pdf': CAPTURE,

  'POST /vision/scale': CAPTURE,
  'POST /vision/reference/detect': CAPTURE,
  'POST /vision/reference/solve': CAPTURE,

  'GET /carriers': READ_CARRIERS,
  'POST /carriers': SETTINGS,
  'PATCH /carriers/:id': SETTINGS,
  'DELETE /carriers/:id': SETTINGS,

  'GET /tariffs/template.xlsx': { all: [...TARIFFS, 'deciship.prices.view'] },
  'GET /tariffs': TARIFFS_VIEW,
  'POST /tariffs': TARIFFS,
  'GET /tariffs/:id': TARIFFS_VIEW,
  'PUT /tariffs/:id': TARIFFS,
  'DELETE /tariffs/:id': TARIFFS,
  'POST /tariffs/:id/default': TARIFFS,
  'POST /tariffs/:id/duplicate': TARIFFS,
  'POST /tariffs/:id/import': TARIFFS,
  'POST /tariff-imports': TARIFFS,
  'GET /tariff-documents/:documentId': TARIFFS_VIEW,
  'POST /tariff-documents/:documentId/scan': TARIFFS,
  'POST /tariff-documents/:documentId/extract': TARIFFS,
  'POST /tariff-imports/:draftId/recheck': TARIFFS,
  'POST /tariff-imports/:draftId/review': TARIFFS,
  'POST /tariff-imports/:draftId/apply': TARIFFS,
  'GET /tariffs/:id/versions': TARIFFS_VIEW,
  'POST /tariffs/:id/versions/:versionId/restore': TARIFFS,
  'POST /tariffs/:id/recompare-invoices/preview': TARIFFS,
  'POST /tariffs/:id/recompare-invoices': TARIFFS,
  'POST /tariffs/:id/country-adjustments': TARIFFS,
  'POST /tariffs/:id/quote': TARIFFS_VIEW,

  'POST /invoices/preview': UPLOAD,
  'POST /invoices/preview/verify': UPLOAD,
  'POST /invoices/preview/ai-mapping': UPLOAD,
  'DELETE /invoices/preview/:fileId': UPLOAD,
  'GET /invoices/preview/resumable': UPLOAD,
  'POST /invoices/preview/:fileId/keep': UPLOAD,
  'POST /invoices': UPLOAD,
  'POST /invoices/samples': SETTINGS,
  'GET /invoices': VIEW,
  'GET /invoices/:id': VIEW,
  'PATCH /invoices/:id': UPLOAD,
  'GET /invoices/:id/lines': VIEW,
  'PATCH /invoice-lines/:id': DECIDE,
  'POST /invoices/:id/lines/decide': DECIDE,
  'GET /invoices/:id/tariff-health': REPORTS,
  'POST /invoices/:id/recompare': DECIDE,
  'POST /invoices/:id/recalculate/preview': p('deciship.lines.decide', 'deciship.invoices.upload'),
  'POST /invoices/:id/recalculate': DECIDE,
  'DELETE /invoices/:id': UPLOAD,
  'GET /invoices/:id/report.xlsx': EXPORT_PRICED,
  'GET /invoices/:id/report.pdf': EXPORT_PRICED,
  'GET /invoices/:id/dispute': EXPORT_PRICED,
  'GET /invoices/:id/dispute/evidence.zip': { all: [...EXPORT_PRICED.all, 'deciship.measurements.view_all'] },

  // itiraz takibi: görme fatura izniyle, gönderme / sonuç / geri alma itiraz izniyle
  'GET /disputes': VIEW,
  'POST /invoices/:id/disputes': DISPUTES,
  'POST /disputes/:id/resend': DISPUTES,
  'POST /disputes/:id/withdraw': DISPUTES,
  'POST /disputes/:id/results': DISPUTES,
  'POST /dispute-results/:id/revert': DISPUTES,

  'GET /dashboard': REPORTS,

  'GET /jobs': JOBS,
  'GET /jobs/:jobId': JOBS,
  'POST /jobs/:jobId/cancel': JOBS,

  'GET /platform/overview': REPORTS,
  'GET /platform/analytics': REPORTS,
  'GET /platform/activity': REPORTS,
  'GET /platform/datasets': VIEW,
  'GET /platform/datasets/:id': VIEW,
  'GET /platform/datasets/:id/export': { all: [...EXPORT, ...VIEW] },
  'GET /platform/ai-usage': SETTINGS,
  'GET /platform/ai-usage/calls': SETTINGS,
  'GET /platform/ai-usage/calls/export': { all: [...SETTINGS, ...EXPORT] },
  'GET /platform/storage-usage': SETTINGS,
};

/** Salt okunur abonelikte de çalışan yazma uçları: fiyat hesabı kayıt değiştirmez (API `READ_ONLY_EXEMPT`). */
export const MOCK_READ_ONLY_EXEMPT: ReadonlySet<string> = new Set(['POST /tariffs/:id/quote']);

const compiledRoutes = Object.entries(MOCK_ROUTE_RULES).map(([key, rule]) => {
  const [method, pattern] = key.split(' ') as [string, string];
  return { key, rule, method, segments: pattern.split('/').slice(1) };
});

/** Somut yolun düştüğü uç. Birden çok kalıp eşleşirse soldan ilk farklı parçası sabit olan kazanır (Fastify gibi). HEAD = GET. */
export function mockRouteOf(method: string, path: string): { key: string; rule: MockRouteRule } | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const parts = path.split('/').slice(1);
  const hits = compiledRoutes.filter((r) => r.method === m && r.segments.length === parts.length && r.segments.every((s, i) => s.startsWith(':') || s === parts[i]));
  hits.sort((a, b) => {
    for (let i = 0; i < a.segments.length; i++) {
      const d = Number(a.segments[i]!.startsWith(':')) - Number(b.segments[i]!.startsWith(':'));
      if (d) return d;
    }
    return 0;
  });
  return hits[0] ? { key: hits[0].key, rule: hits[0].rule } : null;
}

const ruleAllows = (rule: MockRouteRule, held: readonly Permission[]) =>
  rule === 'session' ? true : 'all' in rule ? rule.all.every((x) => held.includes(x)) : rule.some((x) => held.includes(x));

/**
 * İzin denetimi (API `requirePermission` karşılığı): web erişimi yoksa NO_PRODUCT_ACCESS, uç izni yoksa FORBIDDEN, geçerse `null`.
 * Tabloda olmayan yol izinden geçer (işleyicisi yoksa sahte API zaten yanıt vermez).
 */
export function mockPermissionCheck(method: string, path: string, held: readonly Permission[]): 'NO_PRODUCT_ACCESS' | 'FORBIDDEN' | null {
  if (!held.includes('deciship.web.access')) return 'NO_PRODUCT_ACCESS';
  const route = mockRouteOf(method, path);
  return route && !ruleAllows(route.rule, held) ? 'FORBIDDEN' : null;
}

const readOnlyExempt = (method: string, path: string) => {
  const route = mockRouteOf(method, path);
  return !!route && MOCK_READ_ONLY_EXEMPT.has(route.key);
};

/** Ürün tarafı denetim sırası (§5). Çerez dışı kimlik kabul edilmez: `Authorization` gelirse istek geçersizdir. */
export const productGuard = http.all('/api/deciship/*', async ({ request }) => {
  await latency();
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname.replace('/api/deciship', '');
  if (request.headers.get('authorization')) return fail(request, 400, 'BAD_REQUEST', 'Web istemcisi Authorization başlığı göndermemeli');
  const write = method !== 'GET' && method !== 'HEAD';
  if (write && !request.headers.get('x-sod-csrf')) return fail(request, 403, 'CSRF_FAILED');
  const ctx = context();
  if (!ctx) return fail(request, 401, 'UNAUTHORIZED');
  const expired = take('sod_mock_expire');
  if (expired) return fail(request, 401, expired as ApiErrorCode);
  if (!ctx.membership) return fail(request, 403, 'ORG_REQUIRED');
  // Eski sekme: başlıktaki firma oturumunkinden farklıysa yazma reddedilir (§5).
  const claimedOrg = request.headers.get(ORG_HEADER);
  if (write && claimedOrg && claimedOrg !== ctx.membership.orgId) return fail(request, 409, 'ORG_MISMATCH');
  // test kancası: sunucu erişimi kapattı, kabuktaki kişi kaydı henüz eski
  if (flag('sod_mock_revoked')) return fail(request, 403, 'NO_PRODUCT_ACCESS');
  // test kancası: bu yolla başlayan sayfa sorgusu 403 alır
  const forbidden = localStorage.getItem('sod_mock_forbid');
  if (forbidden && path.startsWith(forbidden)) return fail(request, 403, 'FORBIDDEN');
  const role = ctx.membership.productRoles.deciship;
  if (!role) return fail(request, 403, 'NO_PRODUCT_ACCESS');
  const refused = mockPermissionCheck(method, path, permissionsOf('deciship', role));
  if (refused) return fail(request, 403, refused);
  if (write && !readOnlyExempt(method, path) && flag('sod_mock_readonly')) return fail(request, 403, 'READ_ONLY');
  if (write) {
    const forced = take('sod_mock_force');
    if (forced) return fail(request, 403, forced as ApiErrorCode);
  }
  return undefined;
});
