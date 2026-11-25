import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { permissionsOf } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { addMember, API, bearer, claimsOf, errorCode, getApp, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, uniq, webTokenFor, asWeb, type Ctx } from './helpers.ts';
import { TEST_ORIGIN } from './testEnv.ts';

/**
 * §11 "her uç × her rol". Tablo elle yazılır; kayıtlı rota listesiyle birebir karşılaştırılır: yeni uç eklenince bu dosya kırılır.
 * Her hücre iki yoldan gezilir: Bearer (mobil oturum) ve çerez + CSRF + `X-SOD-Org` (tarayıcı oturumu).
 * Firma yönetimi yalnız tarayıcıdan (KARARLAR): `/org` ve `/org/*` yazmalarında Bearer, yetki reddi beklenmeyen her hücrede
 * `FORBIDDEN` alır (`bearerCell`); kimlik ve firma reddi (401, `ORG_REQUIRED`, `FORBIDDEN`) önce gelir. Ayrıntı aşağıdaki
 * "firma yazmaları yalnız tarayıcı oturumuyla" bölümünde.
 * - `allow`: yetki reddi almaz (400, 404, 409, 501 serbest). Asıl işin yapıldığı aşağıdaki "olumlu yol" tablosunda sınanır.
 * - `OWN`: başka firmanın üyesi kendi firmasına iner; yanıtta hedef firmanın kaydı görünmez, kendi kaydı görünür.
 * - Diğerleri tam hata kodunu bekler.
 */

type Actor = 'OWNER' | 'ADMIN' | 'MEMBER' | 'SUSPENDED' | 'OTHER_ORG' | 'ANON' | 'ORG_NULL';
const ACTORS: Actor[] = ['OWNER', 'ADMIN', 'MEMBER', 'SUSPENDED', 'OTHER_ORG', 'ANON', 'ORG_NULL'];
type Cell = 'allow' | 'UNAUTHORIZED' | 'TOKEN_STALE' | 'ORG_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'OWN';

type Row = {
  /** Çalıştırılacak somut yol ve gövde. `:id` hedef firmanın kaydıyla değişir. */
  url?: string;
  payload?: Record<string, unknown>;
  /** Yan etkili uç: hücre başına yeni aktör. */
  fresh?: boolean;
  access: Record<Actor, Cell>;
};

/** Herkese açık: yetki reddi olmaz. */
const PUBLIC: Record<Actor, Cell> = { OWNER: 'allow', ADMIN: 'allow', MEMBER: 'allow', SUSPENDED: 'allow', OTHER_ORG: 'allow', ANON: 'allow', ORG_NULL: 'allow' };
/** Oturum yeter, firma gerekmez. */
const SESSION: Record<Actor, Cell> = { OWNER: 'allow', ADMIN: 'allow', MEMBER: 'allow', SUSPENDED: 'allow', OTHER_ORG: 'allow', ANON: 'UNAUTHORIZED', ORG_NULL: 'allow' };
/** Etkin firma üyesi. Başka firmanın üyesi kendi firmasına iner. */
const MEMBER: Record<Actor, Cell> = { OWNER: 'allow', ADMIN: 'allow', MEMBER: 'allow', SUSPENDED: 'TOKEN_STALE', OTHER_ORG: 'OWN', ANON: 'UNAUTHORIZED', ORG_NULL: 'ORG_REQUIRED' };
/** OWNER veya ADMIN. */
const MANAGER: Record<Actor, Cell> = { OWNER: 'allow', ADMIN: 'allow', MEMBER: 'FORBIDDEN', SUSPENDED: 'TOKEN_STALE', OTHER_ORG: 'OWN', ANON: 'UNAUTHORIZED', ORG_NULL: 'ORG_REQUIRED' };
/** OWNER veya ADMIN, hedef kaydı `:id`: başka firmaya 404. */
const MANAGER_ID: Record<Actor, Cell> = { ...MANAGER, OTHER_ORG: 'NOT_FOUND' };
/** Yalnız OWNER. */
const OWNER_ONLY: Record<Actor, Cell> = { ...MANAGER, ADMIN: 'FORBIDDEN' };
/** Platform yöneticisi (`PLATFORM_OPERATORS`): firmadan bağımsız; matrisin hiçbir aktörü yönetici değil (operator.test.ts olumlu yolu sınar). */
const OPERATOR: Record<Actor, Cell> = { OWNER: 'FORBIDDEN', ADMIN: 'FORBIDDEN', MEMBER: 'FORBIDDEN', SUSPENDED: 'FORBIDDEN', OTHER_ORG: 'FORBIDDEN', ANON: 'UNAUTHORIZED', ORG_NULL: 'FORBIDDEN' };

const TABLE: Record<string, Row> = {
  'GET /api/account/health': { access: PUBLIC },
  'GET /api/account/.well-known/jwks.json': { access: PUBLIC },
  'GET /api/account/catalog': { access: PUBLIC },
  'GET /api/account/client-policy': { access: PUBLIC },
  // Kimlik öncesi uçlar: gövde hatası veya geçersiz kimlik, yetki reddi değil.
  'POST /api/account/auth/register': { payload: { client: 'mobile' }, access: PUBLIC },
  'POST /api/account/auth/login': { payload: { identifier: 'yok@test.sellerondata.com', password: 'x', client: 'mobile' }, access: PUBLIC },
  // Yenileme jetonun kendisine bakar, erişim jetonuna değil: geçersiz jeton herkese 401.
  'POST /api/account/auth/refresh': {
    payload: { refreshToken: 'uydurma' },
    access: { OWNER: 'UNAUTHORIZED', ADMIN: 'UNAUTHORIZED', MEMBER: 'UNAUTHORIZED', SUSPENDED: 'UNAUTHORIZED', OTHER_ORG: 'UNAUTHORIZED', ANON: 'UNAUTHORIZED', ORG_NULL: 'UNAUTHORIZED' },
  },
  'POST /api/account/auth/logout': { payload: { refreshToken: 'uydurma' }, fresh: true, access: PUBLIC },
  // Sitenin "kimim" yoklaması: yetki reddi yok, oturum yoksa `{ signedIn: false }` (site-session.test.ts ayrıntılı sınar).
  'GET /api/account/auth/site-session': { access: PUBLIC },
  'POST /api/account/auth/forgot-password': { payload: {}, access: PUBLIC },
  'POST /api/account/auth/reset-password': { payload: {}, access: PUBLIC },
  'POST /api/account/auth/verify-email': { payload: {}, access: PUBLIC },
  'POST /api/account/auth/resend-verification': { payload: {}, access: PUBLIC },
  'POST /api/account/auth/join/preview': { payload: {}, access: PUBLIC },
  'POST /api/account/auth/join/accept': { payload: { client: 'mobile' }, access: PUBLIC },
  'GET /api/account/invites/:token': { url: '/api/account/invites/uydurma', access: PUBLIC },
  'POST /api/account/invites/:token/accept': { url: '/api/account/invites/uydurma/accept', payload: { client: 'mobile' }, access: PUBLIC },

  'POST /api/account/auth/switch-org': { payload: { orgId: 'yok' }, access: SESSION },
  'POST /api/account/orgs': { payload: {}, access: SESSION },
  'GET /api/account/me': { access: SESSION },
  'PATCH /api/account/me': { payload: {}, access: SESSION },
  'POST /api/account/me/password': { payload: {}, access: SESSION },
  'GET /api/account/me/sessions': { access: SESSION },
  'POST /api/account/me/email/resend': { payload: {}, access: SESSION },
  'DELETE /api/account/me/pending-email': { access: SESSION },
  'DELETE /api/account/me/sessions/:id': { url: '/api/account/me/sessions/yok', access: SESSION },
  // Kapalı firmayı geri açma: etkin firma gerekmez; bilinmeyen firma herkese 404 ORG_NOT_FOUND (yetki reddi değil).
  'POST /api/account/org/reopen': { payload: { orgId: 'yok', password: 'YanlisSifre1' }, access: SESSION },

  'GET /api/account/org': { access: MEMBER },
  'POST /api/account/org/leave': { payload: {}, fresh: true, access: MEMBER },

  'PATCH /api/account/org': { payload: {}, access: MANAGER },
  'GET /api/account/org/members': { access: MANAGER },
  'POST /api/account/org/members/invite': { payload: {}, access: MANAGER },
  'PATCH /api/account/org/members/:id': { payload: {}, access: MANAGER_ID },
  'DELETE /api/account/org/members/:id': { fresh: true, access: MANAGER_ID },
  'POST /api/account/org/members/:id/reset-code': { fresh: true, access: MANAGER_ID },
  'POST /api/account/org/transfer-ownership': { payload: { membershipId: ':id', password: 'YanlisSifre1' }, access: OWNER_ONLY },
  // Firmayı kapatma (orgClosure.test.ts ayrıntılı sınar): yanlış onay adı, sahip 400 alır (yetki reddi değil), firma açık kalır.
  'POST /api/account/org/close': { payload: { confirmName: 'Bu ad tutmaz', password: 'YanlisSifre1' }, access: OWNER_ONLY },
  'GET /api/account/org/invitations': { access: MANAGER },
  'POST /api/account/org/invitations/:id/resend': { url: '/api/account/org/invitations/:invitation/resend', access: MANAGER_ID },
  'DELETE /api/account/org/invitations/:id': { url: '/api/account/org/invitations/:invitation', fresh: true, access: MANAGER_ID },
  // Roller (roles.test.ts ayrıntılı sınar). `:id` burada var olmayan bir rol kimliğidir: izinli aktör 404 alır (yetki reddi değil).
  'GET /api/account/org/roles': { access: MANAGER },
  'POST /api/account/org/roles': { payload: {}, access: MANAGER },
  'PATCH /api/account/org/roles/:id': { url: '/api/account/org/roles/00000000-0000-7000-8000-000000000000', payload: { version: 1 }, access: MANAGER_ID },
  'DELETE /api/account/org/roles/:id': { url: '/api/account/org/roles/00000000-0000-7000-8000-000000000000', access: MANAGER_ID },
  'PATCH /api/account/org/roles/builtin/:product/:key': { url: '/api/account/org/roles/builtin/deciship/MEASURE', payload: {}, access: MANAGER },
  'DELETE /api/account/org/roles/builtin/:product/:key': { url: '/api/account/org/roles/builtin/deciship/MEASURE', fresh: true, access: MANAGER },
  'POST /api/account/org/roles/builtin/:product/:key/reset': { url: '/api/account/org/roles/builtin/deciship/MEASURE/reset', access: MANAGER },
  'GET /api/account/org/subscriptions': { access: MANAGER },
  'POST /api/account/org/billing/*': { url: '/api/account/org/billing/checkout', payload: {}, access: MANAGER },
  'GET /api/account/org/audit': { access: MANAGER },

  // Adım artırma: yönetici olmayan gövdeye bakılmadan 403 (yanlış şifre bile denenmez).
  'POST /api/account/operator/step-up': { payload: { password: 'YanlisSifre1' }, access: OPERATOR },

  // Araç iç ucu: kimlik ürün anahtarıdır, kullanıcı jetonu ve çerezi hiçbir rolde geçmez (productNotice.test.ts ayrıntılı sınar).
  'POST /api/account/internal/notify': {
    payload: {},
    access: { OWNER: 'UNAUTHORIZED', ADMIN: 'UNAUTHORIZED', MEMBER: 'UNAUTHORIZED', SUSPENDED: 'UNAUTHORIZED', OTHER_ORG: 'UNAUTHORIZED', ANON: 'UNAUTHORIZED', ORG_NULL: 'UNAUTHORIZED' },
  },
};

/** Firma yönetimi yazması: `/org` ya da `/org/*` altında okuma olmayan uç (`routes/org.ts` `guardOrgWrites`). */
function isOrgWrite(route: string): boolean {
  const [method, path] = route.split(' ');
  return method !== 'GET' && /^\/api\/account\/org(\/|$)/.test(path ?? '');
}

/** Bearer yolunda beklenen: firma yazmasında kimlik ve firma denetimini geçen her aktör tarayıcı oturumu ister. */
function bearerCell(route: string, cell: Cell): Cell {
  return isOrgWrite(route) && (cell === 'allow' || cell === 'OWN' || cell === 'NOT_FOUND') ? 'FORBIDDEN' : cell;
}

/** Yetki reddi sayılan kodlar. */
const DENIALS = new Set(['UNAUTHORIZED', 'TOKEN_STALE', 'TOKEN_EXPIRED', 'ORG_REQUIRED', 'FORBIDDEN', 'CSRF_FAILED', 'ORG_MISMATCH', 'NOT_FOUND_ROUTE']);

type World = {
  owner: Ctx;
  admin: Ctx;
  member: Ctx;
  phoneWorker: Ctx;
  suspended: Ctx;
  other: Ctx;
  orgNull: Ctx;
  invitationId: string;
  invitationEmail: string;
  /** Aynı kişilerin tarayıcı oturumu jetonu: mobil jetonun ikizi (`webTokenFor`), bayatlığı da aynı. */
  web: Record<Exclude<Actor, 'ANON'>, string>;
};

let app: FastifyInstance;

async function makeWorld(): Promise<World> {
  const owner = await registerOrg(app);
  const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
  const member = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
  const phoneWorker = await addMember(app, owner.orgId, { email: null, phone: randomTrPhone(), deciship: 'MEASURE' });
  const suspended = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
  // Jeton elinde, sonra askı.
  await app.inject({ method: 'PATCH', url: `${API}/org/members/${suspended.membershipId}`, headers: await asWeb(owner), payload: { status: 'SUSPENDED' } });
  const other = await registerOrg(app);
  const orphan = await addMember(app, other.orgId);
  await prisma.membership.delete({ where: { id: orphan.membershipId } });
  const refreshed = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: orphan.refreshToken } });
  const orgNull = { ...orphan, accessToken: refreshed.json().accessToken, headers: bearer(refreshed.json().accessToken) };
  expect(claimsOf(orgNull.accessToken).org).toBeNull();
  const invitationEmail = randomEmail('matris');
  const invite = await app.inject({
    method: 'POST',
    url: `${API}/org/members/invite`,
    headers: await asWeb(owner),
    payload: { kind: 'EMAIL', email: invitationEmail, name: 'Matris' },
  });
  const web = {
    OWNER: await webTokenFor(owner.accessToken),
    ADMIN: await webTokenFor(admin.accessToken),
    MEMBER: await webTokenFor(member.accessToken),
    SUSPENDED: await webTokenFor(suspended.accessToken),
    OTHER_ORG: await webTokenFor(other.accessToken),
    ORG_NULL: await webTokenFor(orgNull.accessToken),
  };
  return { owner, admin, member, phoneWorker, suspended, other, orgNull, invitationId: invite.json().invitation.id, invitationEmail, web };
}

function ctxFor(world: World, actor: Actor): Ctx | null {
  switch (actor) {
    case 'OWNER':
      return world.owner;
    case 'ADMIN':
      return world.admin;
    case 'MEMBER':
      return world.member;
    case 'SUSPENDED':
      return world.suspended;
    case 'OTHER_ORG':
      return world.other;
    case 'ORG_NULL':
      return world.orgNull;
    case 'ANON':
      return null;
  }
}

/** Tarayıcının gönderdiği çerezli istek: yazmada CSRF, Origin ve jetonun firması. Jeton tarayıcı oturumunun (`World.web`). */
function cookieHeaders(token: string, method: string): Record<string, string> {
  const headers: Record<string, string> = { cookie: `sod_at=${token}` };
  if (method !== 'GET') {
    headers['x-sod-csrf'] = '1';
    headers.origin = TEST_ORIGIN;
    const org = claimsOf(token).org;
    if (org) headers['x-sod-org'] = org;
  }
  return headers;
}

function requestFor(route: string, row: Row, w: World) {
  const [method, path] = route.split(' ');
  const url = (row.url ?? path).replace(':invitation', w.invitationId).replace(':id', w.member.membershipId);
  const payload = row.payload ? JSON.parse(JSON.stringify(row.payload).replace(':id', w.member.membershipId)) : undefined;
  return { method, url, payload };
}

async function send(request: { method: string; url: string; payload?: unknown }, headers: Record<string, string>) {
  return app.inject({
    method: request.method as 'GET',
    url: request.url,
    remoteAddress: randomIp(),
    headers,
    ...(request.payload ? { payload: request.payload as Record<string, string> } : {}),
  });
}

describe('yetki matrisi', () => {
  let world: World;
  let registered: string[];

  beforeAll(async () => {
    app = await getApp();
    world = await makeWorld();
    registered = (app as unknown as { sodRoutes: string[] }).sodRoutes;
  });

  it('tablo kayıtlı rotalarla birebir aynı: yeni uç tabloya girmeden geçmez', () => {
    expect([...registered].sort()).toEqual(Object.keys(TABLE).sort());
  });

  for (const via of ['bearer', 'cookie'] as const) {
    for (const [route, row] of Object.entries(TABLE)) {
      for (const actor of ACTORS) {
        if (via === 'cookie' && actor === 'ANON') continue; // Kimliksiz yol ikisinde de aynı.
        const expected = via === 'bearer' ? bearerCell(route, row.access[actor]) : row.access[actor];
        it(`[${via}] ${route} × ${actor} -> ${expected}`, async () => {
          const w = row.fresh ? await makeWorld() : world;
          const request = requestFor(route, row, w);
          const ctx = ctxFor(w, actor);
          const headers = !ctx ? {} : via === 'bearer' ? ctx.headers : cookieHeaders(w.web[actor as Exclude<Actor, 'ANON'>], request.method);
          const res = await send(request, headers);
          // 501: ödeme uçlarının sözleşmedeki yanıtı.
          expect(res.statusCode < 500 || res.statusCode === 501, res.body).toBe(true);
          const code = res.statusCode >= 400 ? errorCode(res) : undefined;
          if (expected === 'allow') {
            expect(DENIALS.has(code ?? ''), `${code}: ${res.body}`).toBe(false);
          } else if (expected === 'OWN') {
            // Kendi firmasına iner: yetki reddi yok, hedef firmanın kaydı sızmaz.
            expect(DENIALS.has(code ?? ''), `${code}: ${res.body}`).toBe(false);
            for (const secret of [w.owner.orgId, w.owner.membershipId, w.member.membershipId, w.member.email as string, w.invitationId, w.invitationEmail]) {
              expect(res.body, `${route} sızıntı: ${secret}`).not.toContain(secret);
            }
          } else {
            expect(code, res.body).toBe(expected);
          }
        });
      }
    }
  }

  describe('çerezli yazma: firmaya bağlı her uç CSRF ve X-SOD-Org ister', () => {
    const firmWrites = Object.entries(TABLE).filter(
      ([route, row]) => !route.startsWith('GET') && [MEMBER, MANAGER, MANAGER_ID, OWNER_ONLY].includes(row.access),
    );
    it('liste boş değil', () => {
      expect(firmWrites.length).toBeGreaterThan(8);
    });
    for (const [route, row] of firmWrites) {
      it(`${route}: başlık yok, yanlış firma, CSRF yok`, async () => {
        const request = requestFor(route, row, world);
        const base = cookieHeaders(world.web.OWNER, request.method);
        const { 'x-sod-org': _org, ...noOrg } = base;
        expect(errorCode(await send(request, noOrg))).toBe('ORG_MISMATCH');
        expect(errorCode(await send(request, { ...base, 'x-sod-org': world.other.orgId }))).toBe('ORG_MISMATCH');
        const { 'x-sod-csrf': _csrf, ...noCsrf } = base;
        expect(errorCode(await send(request, noCsrf))).toBe('CSRF_FAILED');
      });
    }
    const sessionWrites = Object.entries(TABLE).filter(([route, row]) => !route.startsWith('GET') && row.access === SESSION);
    for (const [route, row] of sessionWrites) {
      it(`${route}: firmaya bağlı değil, X-SOD-Org istemez`, async () => {
        const request = requestFor(route, row, world);
        const { 'x-sod-org': _org, ...noOrg } = cookieHeaders(world.web.MEMBER, request.method);
        const res = await send(request, noOrg);
        expect(errorCode(res)).not.toBe('ORG_MISMATCH');
      });
    }
  });

  describe('firma yazmaları yalnız tarayıcı oturumuyla (C2.4-A1)', () => {
    const orgWrites = Object.entries(TABLE).filter(([route]) => isOrgWrite(route));
    const reasonOf = (res: { json: () => unknown }) => (res.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason;

    it('liste kayıtlı bütün /org yazmalarını kapsar', () => {
      expect(orgWrites.length).toBeGreaterThan(15);
      expect(orgWrites.map(([r]) => r).sort()).toEqual(registered.filter(isOrgWrite).sort());
    });

    for (const [route, row] of orgWrites) {
      it(`${route}: mobil Bearer, çerezdeki mobil jeton ve Bearer'daki web jetonu reddedilir`, async () => {
        const w = row.fresh ? await makeWorld() : world;
        const request = requestFor(route, row, w);
        const viaBearer = await send(request, w.owner.headers);
        expect(errorCode(viaBearer), viaBearer.body).toBe('FORBIDDEN');
        expect(reasonOf(viaBearer)).toBe('WEB_SESSION_REQUIRED');
        // Çalınmış mobil jeton tarayıcı gibi çerezle (CSRF başlığı tarayıcı dışında elle yazılır) gönderilse de geçmez.
        const mobileCookie = await send(request, cookieHeaders(w.owner.accessToken, request.method));
        expect(errorCode(mobileCookie), mobileCookie.body).toBe('FORBIDDEN');
        expect(reasonOf(mobileCookie)).toBe('WEB_SESSION_REQUIRED');
        const webBearer = await send(request, bearer(w.web.OWNER));
        expect(errorCode(webBearer), webBearer.body).toBe('FORBIDDEN');
        expect(reasonOf(webBearer)).toBe('WEB_SESSION_REQUIRED');
      });
    }

    it('ret metni yerelleşir', async () => {
      const res = await app.inject({ method: 'PATCH', url: `${API}/org`, remoteAddress: randomIp(), headers: { ...world.owner.headers, 'accept-language': 'tr' }, payload: { name: 'X' } });
      expect(res.json().error.message).toMatch(/Merkez/);
      const en = await app.inject({ method: 'PATCH', url: `${API}/org`, remoteAddress: randomIp(), headers: { ...world.owner.headers, 'accept-language': 'en' }, payload: { name: 'X' } });
      expect(en.json().error.message).toMatch(/Hub/);
    });

    it('kimlik reddi önce gelir: bayat Bearer 401 TOKEN_STALE alır, istemci yeniler', async () => {
      const w = await makeWorld();
      const res = await send({ method: 'PATCH', url: `${API}/org`, payload: { name: 'X' } }, w.suspended.headers);
      expect(errorCode(res)).toBe('TOKEN_STALE');
    });

    it('mobilin okumaları Bearer ile açık: ekip listesi, roller, etkinlik', async () => {
      for (const url of ['/org/members', '/org/roles', '/org/audit', '/org']) {
        const res = await send({ method: 'GET', url: `${API}${url}` }, world.owner.headers);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      }
    });

    for (const actor of ['OWNER', 'ADMIN'] as const) {
      it(`istisna × ${actor}: mobil "Çalışan ekle" (telefon kodu, çalışan) Bearer ile açılır; diğer davetler açılmaz`, async () => {
        const w = await makeWorld();
        const headers = actor === 'OWNER' ? w.owner.headers : w.admin.headers;
        // Mobil uygulamanın gönderdiği gövde (`Deciship/apps/mobile/src/hub/invite.ts` `inviteBody`).
        const mobile = await send(
          { method: 'POST', url: `${API}/org/members/invite`, payload: { kind: 'PHONE_CODE', name: 'Çalışan', phone: randomTrPhone(), orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } } },
          headers,
        );
        expect(mobile.statusCode, mobile.body).toBe(201);
        expect(mobile.json().code).toBeTruthy();
        const noRole = await send({ method: 'POST', url: `${API}/org/members/invite`, payload: { kind: 'PHONE_CODE', name: 'Çalışan', phone: randomTrPhone() } }, headers);
        expect(noRole.statusCode, noRole.body).toBe(201);
        for (const payload of [
          { kind: 'PHONE_CODE', name: 'Yönetici', phone: randomTrPhone(), orgRole: 'ADMIN' },
          { kind: 'EMAIL', email: randomEmail('mobil'), name: 'Davetli' },
          { kind: 'EMAIL', email: randomEmail('mobil'), name: 'Davetli', orgRole: 'MEMBER' },
        ]) {
          const res = await send({ method: 'POST', url: `${API}/org/members/invite`, payload }, headers);
          expect(errorCode(res), res.body).toBe('FORBIDDEN');
          expect(reasonOf(res)).toBe('WEB_SESSION_REQUIRED');
        }
        expect(await prisma.invitation.count({ where: { orgId: w.owner.orgId, kind: 'EMAIL', email: { startsWith: 'mobil' } } })).toBe(0);
      });
    }

    it('istisna yetkiyi genişletmez: mobil MEMBER telefon daveti açamaz', async () => {
      const res = await send({ method: 'POST', url: `${API}/org/members/invite`, payload: { kind: 'PHONE_CODE', name: 'Çalışan', phone: randomTrPhone() } }, world.member.headers);
      expect(errorCode(res)).toBe('FORBIDDEN');
      expect(reasonOf(res)).toBeUndefined();
    });

    // İnceleme (C2.4-A1 sonrası): istisna yalnız mobilin verebildiği rolleri kapsar (`mobile/src/hub/invite.ts` `inviteRoleOptions`:
    // izinleri kilitli sahip rolü ve sahibe özel izinli roller listede yok). Sahibin mobil jetonuyla bile web gerekir.
    it('istisna araç rolünü sınırlar: sahip rolü (deciship ADMIN) ve sahibe özel izinli özel rol mobil davetle verilmez, web ile verilir', async () => {
      const w = await makeWorld();
      const created = await send(
        { method: 'POST', url: `${API}/org/roles`, payload: { product: 'deciship', name: `Ayarlı ${uniq()}`, permissions: ['deciship.web.access', 'deciship.prices.view', 'deciship.settings.manage'] } },
        await asWeb(w.owner),
      );
      expect(created.statusCode, created.body).toBe(201);
      const settingsRole = created.json().role.key as string;
      for (const role of ['ADMIN', settingsRole]) {
        const phone = randomTrPhone();
        const payload = { kind: 'PHONE_CODE', name: 'Çalışan', phone, orgRole: 'MEMBER', productRoles: { deciship: role } };
        const mobile = await send({ method: 'POST', url: `${API}/org/members/invite`, payload }, w.owner.headers);
        expect(errorCode(mobile), `${role}: ${mobile.body}`).toBe('FORBIDDEN');
        expect(reasonOf(mobile)).toBe('WEB_SESSION_REQUIRED');
        expect(await prisma.invitation.count({ where: { orgId: w.owner.orgId, phone } })).toBe(0);
        const web = await send({ method: 'POST', url: `${API}/org/members/invite`, payload }, await asWeb(w.owner));
        expect(web.statusCode, `${role}: ${web.body}`).toBe(201);
      }
    });

    it('istisna web daveti düşüremez: aynı telefona webden açılmış yönetici ya da sahip rollü bekleyen davet mobil davetle iptal olmaz', async () => {
      const w = await makeWorld();
      for (const pending of [
        { orgRole: 'ADMIN', productRoles: {} },
        { orgRole: 'MEMBER', productRoles: { deciship: 'ADMIN' } },
      ]) {
        const phone = randomTrPhone();
        const web = await send({ method: 'POST', url: `${API}/org/members/invite`, payload: { kind: 'PHONE_CODE', name: 'Yönetici', phone, ...pending } }, await asWeb(w.owner));
        expect(web.statusCode, web.body).toBe(201);
        const mobile = await send(
          { method: 'POST', url: `${API}/org/members/invite`, payload: { kind: 'PHONE_CODE', name: 'Çalışan', phone, orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } } },
          w.owner.headers,
        );
        expect(errorCode(mobile), mobile.body).toBe('FORBIDDEN');
        expect(reasonOf(mobile)).toBe('WEB_SESSION_REQUIRED');
        const row = await prisma.invitation.findUniqueOrThrow({ where: { id: web.json().invitation.id } });
        expect(row.revokedAt).toBeNull();
      }
    });

    it('mobil kendi verebileceği bekleyen daveti yeniler: aynı telefona ikinci çalışan daveti eskisini düşürür', async () => {
      const w = await makeWorld();
      const phone = randomTrPhone();
      const payload = { kind: 'PHONE_CODE', name: 'Çalışan', phone, orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } };
      const first = await send({ method: 'POST', url: `${API}/org/members/invite`, payload }, w.owner.headers);
      expect(first.statusCode, first.body).toBe(201);
      const second = await send({ method: 'POST', url: `${API}/org/members/invite`, payload }, w.owner.headers);
      expect(second.statusCode, second.body).toBe(201);
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: first.json().invitation.id } })).revokedAt).not.toBeNull();
    });
  });

  describe('olumlu yol: izinli aktör işi gerçekten yapar', () => {
    const call = (method: string, url: string, headers: Record<string, string>, payload?: Record<string, unknown>) =>
      send({ method, url: `${API}${url}`, payload }, headers);

    for (const actor of ['OWNER', 'ADMIN'] as const) {
      const actorOf = (w: World) => (actor === 'OWNER' ? w.owner : w.admin);

      it(`reset-code × ${actor}: e-postasız MEMBER için kod üretir, kişi yeni şifre belirler`, async () => {
        const w = await makeWorld();
        const res = await call('POST', `/org/members/${w.phoneWorker.membershipId}/reset-code`, await asWeb(actorOf(w)));
        expect(res.statusCode).toBe(201);
        const accept = await call('POST', '/auth/join/accept', {}, { phone: w.phoneWorker.phone, code: res.json().code, password: 'YeniMavi-Kedi-81', client: 'mobile' });
        expect(accept.statusCode).toBe(200);
      });

      it(`üye listesi × ${actor}: kendi firması, başka firma yok`, async () => {
        const w = await makeWorld();
        const res = await call('GET', '/org/members', actorOf(w).headers);
        expect(res.statusCode).toBe(200);
        const ids = res.json().members.map((m: { id: string }) => m.id);
        expect(ids).toEqual(expect.arrayContaining([w.owner.membershipId, w.admin.membershipId, w.member.membershipId]));
        expect(ids).not.toContain(w.other.membershipId);
      });

      it(`üye güncelleme ve çıkarma × ${actor}`, async () => {
        const w = await makeWorld();
        const patch = await call('PATCH', `/org/members/${w.member.membershipId}`, await asWeb(actorOf(w)), { productRoles: { deciship: 'ACCOUNTING' } });
        expect(patch.json().changed).toEqual(['productRoles']);
        const del = await call('DELETE', `/org/members/${w.member.membershipId}`, await asWeb(actorOf(w)));
        expect(del.statusCode).toBe(200);
        expect(await prisma.membership.count({ where: { id: w.member.membershipId } })).toBe(0);
      });

      it(`davet, liste, yeniden gönderme, iptal × ${actor}`, async () => {
        const w = await makeWorld();
        const email = randomEmail('olumlu');
        const created = await call('POST', '/org/members/invite', await asWeb(actorOf(w)), { kind: 'EMAIL', email, name: 'Yeni' });
        expect(created.statusCode).toBe(201);
        const list = await call('GET', '/org/invitations', actorOf(w).headers);
        expect(list.json().invitations.map((i: { email: string }) => i.email)).toContain(email);
        const id = created.json().invitation.id;
        expect((await call('POST', `/org/invitations/${id}/resend`, await asWeb(actorOf(w)))).statusCode).toBe(200);
        expect((await call('DELETE', `/org/invitations/${id}`, await asWeb(actorOf(w)))).statusCode).toBe(200);
      });

      it(`firma, abonelik, denetim × ${actor}`, async () => {
        const w = await makeWorld();
        const name = `Yeni ${uniq()}`;
        expect((await call('PATCH', '/org', await asWeb(actorOf(w)), { name })).json().name).toBe(name);
        expect((await call('GET', '/org', actorOf(w).headers)).json().name).toBe(name);
        expect((await call('GET', '/org/subscriptions', actorOf(w).headers)).json().subscriptions[0].product).toBe('deciship');
        expect((await call('GET', '/org/audit', actorOf(w).headers)).json().total).toBeGreaterThan(0);
        expect((await call('POST', '/org/billing/checkout', await asWeb(actorOf(w)), {})).statusCode).toBe(501);
      });

      it(`çerezle firma yazması × ${actor} doğru başlıkla işi yapar`, async () => {
        const w = await makeWorld();
        const name = `Çerez ${uniq()}`;
        const res = await call('PATCH', '/org', cookieHeaders(await webTokenFor(actorOf(w).accessToken), 'PATCH'), { name });
        expect(res.statusCode).toBe(200);
        expect(res.json().name).toBe(name);
      });
    }

    it('devir × OWNER: gerçek şifreyle yapılır', async () => {
      const w = await makeWorld();
      const res = await call('POST', '/org/transfer-ownership', await asWeb(w.owner), { membershipId: w.member.membershipId, password: PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(await prisma.membership.count({ where: { id: w.member.membershipId, orgRole: 'OWNER' } })).toBe(1);
    });

    it('ayrılma × MEMBER ve ADMIN', async () => {
      const w = await makeWorld();
      expect((await call('POST', '/org/leave', await asWeb(w.member), {})).statusCode).toBe(200);
      expect((await call('POST', '/org/leave', await asWeb(w.admin), {})).statusCode).toBe(200);
      expect(await prisma.membership.count({ where: { id: { in: [w.member.membershipId, w.admin.membershipId] } } })).toBe(0);
    });

    it('oturum uçları: me, profil, oturumlar, firma açma, firma değiştirme', async () => {
      const w = await makeWorld();
      expect((await call('GET', '/me', w.member.headers)).json().person.id).toBe(w.member.personId);
      expect((await call('PATCH', '/me', w.member.headers, { name: 'Yeni Ad' })).json().me.person.name).toBe('Yeni Ad');
      const sessions = await call('GET', '/me/sessions', w.member.headers);
      expect(sessions.json().sessions.length).toBeGreaterThan(0);
      const created = await call('POST', '/orgs', w.orgNull.headers, { name: 'Çıkış Yolu', country: 'TR' });
      expect(created.statusCode).toBe(201);
      await prisma.membership.create({ data: { personId: w.member.personId, orgId: w.other.orgId } });
      const sw = await call('POST', '/auth/switch-org', w.member.headers, { orgId: w.other.orgId });
      expect(sw.json().activeOrgId).toBe(w.other.orgId);
      const own = await call('DELETE', `/me/sessions/${sessions.json().sessions[0].id}`, w.member.headers);
      expect(own.statusCode).toBe(200);
    });

    it('OWN: başka firmanın yöneticisi kendi kayıtlarını görür', async () => {
      const w = await makeWorld();
      expect((await call('GET', '/org', w.other.headers)).json().id).toBe(w.other.orgId);
      const members = await call('GET', '/org/members', w.other.headers);
      expect(members.json().members.map((m: { id: string }) => m.id)).toContain(w.other.membershipId);
      expect(members.body).not.toContain(w.owner.orgId);
    });
  });
});

/**
 * Ürün rolü × izin: `/me`'nin döndürdüğü izinler tek kaynaktan (contracts `products.ts`). Jeton yalnız rolü taşır; izin her
 * istekte rolden türer, bu yüzden katalog değişikliği eldeki jetona yenilemeden yansır.
 */
describe('ürün rolleri: /me izinleri katalogla aynı', () => {
  beforeAll(async () => {
    app = await getApp();
  });

  it('her DeciShip rolü katalogdaki izinleri alır; Muhasebe fatura yükler ama karar, tarife ve ayar izni yok (Y123)', async () => {
    const owner = await registerOrg(app);
    const seen: Record<string, string[]> = {};
    for (const role of ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE']) {
      const member = await addMember(app, owner.orgId, { deciship: role });
      const res = await app.inject({ url: `${API}/me`, remoteAddress: randomIp(), headers: member.headers });
      expect(res.statusCode, res.body).toBe(200);
      const deciship = res.json().products.find((p: { key: string }) => p.key === 'deciship') as { role: string; permissions: string[] };
      expect(deciship.role).toBe(role);
      expect(deciship.permissions).toEqual([...permissionsOf('deciship', role)]);
      seen[role] = deciship.permissions;
    }
    expect(seen.ACCOUNTING).toContain('deciship.invoices.upload');
    for (const p of ['deciship.lines.decide', 'deciship.tariffs.edit', 'deciship.settings.manage', 'deciship.measurements.capture']) {
      expect(seen.ACCOUNTING, p).not.toContain(p);
    }
    expect(seen.AUDITOR).toContain('deciship.invoices.upload');
    expect(seen.MEASURE).toEqual(['deciship.measurements.capture']);
  });
});
