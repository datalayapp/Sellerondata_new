import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import {
  addMember,
  API,
  bearer,
  claimsOf,
  cookieHeader,
  epochOf,
  errorCode,
  getApp,
  login,
  outboxFor,
  parseSetCookies,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg,
  uniq,
  webHeaders,
  type Ctx, asWeb, webHeadersFrom, withCookieToken } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.REGISTRATION_ENABLED = 'true';
});

const createOrg = (headers: Record<string, string>, payload: Record<string, unknown> = {}, ip = randomIp()) =>
  app.inject({ method: 'POST', url: `${API}/orgs`, remoteAddress: ip, headers, payload: { name: `Yeni ${uniq()}`, country: 'TR', ...payload } });
// Ayrılma firma yazmasıdır: tarayıcı oturumuyla (Bearer ikiz web oturumuna çevrilir).
const leave = async (headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
  withCookieToken(await app.inject({ method: 'POST', url: `${API}/org/leave`, remoteAddress: randomIp(), headers: await webHeadersFrom(headers), payload }));
const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });

/** Kişiyi başka bir firmaya da üye yapar, o firmaya geçer. */
async function joinAndSwitch(ctx: Ctx, orgId: string, deciship: string | null = 'AUDITOR') {
  const membership = await prisma.membership.create({
    data: { personId: ctx.personId, orgId, ...(deciship ? { productAccess: { create: { product: 'deciship', role: deciship } } } : {}) },
  });
  const res = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: ctx.headers, payload: { orgId } });
  expect(res.statusCode).toBe(200);
  return { membershipId: membership.id, headers: bearer(res.json().accessToken) };
}

describe('POST /orgs: giriş yapmış kişi firma açar', () => {
  it('OWNER olur, DeciShip early_access ACTIVE + ADMIN, yeni firma etkin olur, eski üyelik durur', async () => {
    const first = await registerOrg(app);
    const res = await createOrg(first.headers, { name: 'İkinci İşim', country: 'TR' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const orgId = body.activeOrgId as string;
    expect(orgId).not.toBe(first.orgId);
    expect(body.refreshToken).toBeUndefined();

    const claims = claimsOf(body.accessToken);
    expect(claims).toMatchObject({ org: orgId, orgName: 'İkinci İşim', orgRole: 'OWNER', ep: 0 });
    expect(claims.prod.deciship).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', plan: 'early_access' });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'deciship' } } });
    expect(sub).toMatchObject({ status: 'ACTIVE', plan: 'early_access', version: 1 });
    expect(await prisma.membership.count({ where: { personId: first.personId } })).toBe(2);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: first.personId } })).lastOrgId).toBe(orgId);
    expect(body.me.activeOrg).toMatchObject({ id: orgId, name: 'İkinci İşim', orgRole: 'OWNER', currency: 'TRY' });
    expect(body.me.orgs).toHaveLength(2);

    // Oturumun etkin firması da değişti: yenileme aynı firmada kalır.
    const refreshed = await refresh(first.refreshToken);
    expect(claimsOf(refreshed.json().accessToken).org).toBe(orgId);
    // Yeni firmada yönetici yetkisi hemen çalışır.
    const members = await app.inject({ url: `${API}/org/members`, headers: bearer(body.accessToken) });
    expect(members.statusCode).toBe(200);
  });

  it('olaylar ve denetim yazılır', async () => {
    const first = await registerOrg(app);
    const orgId = (await createOrg(first.headers)).json().activeOrgId as string;
    const events = await prisma.outbox.findMany({ where: { orgId } });
    expect(events.map((e) => e.type).sort()).toEqual(['member.upserted', 'org.updated', 'subscription.updated']);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'org.created', actorPersonId: first.personId } })).toBe(1);
  });

  it('ülke para birimini belirler; dil kişinindir', async () => {
    const first = await registerOrg(app, { locale: 'en' });
    const res = await createOrg(first.headers, { country: 'de' });
    expect(res.statusCode).toBe(201);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: res.json().activeOrgId } });
    expect(org).toMatchObject({ country: 'DE', currency: 'EUR', locale: 'en' });
  });

  it('REGISTRATION_ENABLED=false iken kapalı', async () => {
    const first = await registerOrg(app);
    process.env.REGISTRATION_ENABLED = 'false';
    const res = await createOrg(first.headers);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('REGISTRATION_CLOSED');
    expect(await prisma.membership.count({ where: { personId: first.personId } })).toBe(1);
  });

  it('kimliksiz 401; geçersiz ad ve ülke 400, hak yemez', async () => {
    const none = await app.inject({ method: 'POST', url: `${API}/orgs`, payload: { name: 'X', country: 'TR' } });
    expect(none.statusCode).toBe(401);
    const first = await registerOrg(app);
    for (const payload of [{ name: '' }, { name: 'A\r\nB' }, { country: 'TUR' }, { country: '1' }]) {
      const res = await createOrg(first.headers, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await prisma.rateBucket.count({ where: { key: `orgcreate:person:${first.personId}` } })).toBe(0);
  });

  it('hız sınırı veritabanında, kişi başına', async () => {
    const first = await registerOrg(app);
    for (let i = 0; i < RATE_RULES.orgCreatePerson.limit; i++) {
      expect((await createOrg(first.headers)).statusCode).toBe(201);
    }
    const blocked = await createOrg(first.headers);
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
  });

  it('web: çerez yazar, gövdede jeton yok, CSRF ister', async () => {
    const first = await registerOrg(app);
    const web = parseSetCookies(await login(app, first.email as string, PASSWORD, 'web'));
    const cookie = cookieHeader({ sod_at: web.sod_at });
    const denied = await createOrg({ cookie });
    expect(errorCode(denied)).toBe('CSRF_FAILED');
    const ok = await createOrg(webHeaders(cookie));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().accessToken).toBeUndefined();
    const cookies = parseSetCookies(ok);
    expect(claimsOf(cookies.sod_at.value).org).toBe(ok.json().activeOrgId);
    expect(cookies.sod_rt).toBeUndefined();
  });

  it('e-postasız kişi firma açamaz: OWNER\'ın şifresini kurtarabilecek başkası yok', async () => {
    const owner = await registerOrg(app);
    const worker = await addMember(app, owner.orgId, { email: null, phone: randomTrPhone() });
    const res = await createOrg(worker.headers);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('OWNER_REQUIRES_EMAIL');
  });
});

describe('POST /org/leave: kişi kendi üyeliğinden çıkar', () => {
  it('üyelik silinir, etkin firma sonrakine geçer, olay epoch+1 taşır, diğer üyelik etkilenmez', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const person = await addMember(app, a.orgId, { deciship: 'AUDITOR' });
    const inB = await joinAndSwitch(person, b.orgId);
    const epochA = await epochOf(person.membershipId);
    const epochB = await epochOf(inB.membershipId);

    const res = await leave(inB.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeOrgId).toBe(a.orgId);
    expect(body.me.orgs.map((o: { id: string }) => o.id)).toEqual([a.orgId]);
    expect(body.me.activeOrg.id).toBe(a.orgId);
    expect(claimsOf(body.accessToken)).toMatchObject({ org: a.orgId, mid: person.membershipId });

    expect(await prisma.membership.count({ where: { id: inB.membershipId } })).toBe(0);
    const events = await outboxFor(inB.membershipId);
    expect(events.at(-1)?.payload).toMatchObject({ type: 'member.removed', orgId: b.orgId, epoch: epochB + 1, personId: person.personId });
    expect(await epochOf(person.membershipId)).toBe(epochA);
    expect(await prisma.auditLog.count({ where: { orgId: b.orgId, action: 'member.left', target: inB.membershipId } })).toBe(1);

    // Ayrılınan firmanın eski jetonu Hesap'ta geçmez.
    const stale = await app.inject({ url: `${API}/org`, headers: inB.headers });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    // Yenileme yeni firmada kalır.
    const refreshed = await refresh(person.refreshToken);
    expect(claimsOf(refreshed.json().accessToken).org).toBe(a.orgId);
  });

  it('son üyelik: org null jeton, me firma oluşturmaya yeter, sonra firma açınca çıkmaz biter', async () => {
    const owner = await registerOrg(app);
    const person = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
    const res = await leave(person.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeOrgId).toBeNull();
    const claims = claimsOf(body.accessToken);
    expect(claims).toMatchObject({ org: null, orgName: null, mid: null, orgRole: null, ep: 0, prod: {} });

    const headers = bearer(body.accessToken);
    const me = (await app.inject({ url: `${API}/me`, headers })).json();
    expect(me.activeOrg).toBeNull();
    expect(me.orgs).toEqual([]);
    expect(me.person.id).toBe(person.personId);
    expect(me.account).toMatchObject({ canCreateOrg: true, canLeaveActiveOrg: false, defaultCountry: 'TR', passwordRecovery: 'email' });
    expect(me.products.every((p: { role: unknown; permissions: unknown[] }) => p.role === null && p.permissions.length === 0)).toBe(true);

    const org = await app.inject({ url: `${API}/org`, headers });
    expect(errorCode(org)).toBe('ORG_REQUIRED');

    // Ayrılma tarayıcı oturumuyla yapıldı (firma yazması): bu jetonla açılan firmanın yeni jetonu da çerezde döner.
    const created = withCookieToken(await createOrg(headers, { name: 'Kendi Firmam' }));
    expect(created.statusCode).toBe(201);
    expect(claimsOf(created.json().accessToken)).toMatchObject({ orgName: 'Kendi Firmam', orgRole: 'OWNER' });
    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.personId } })).passwordHash).toBeTruthy();
  });

  it('kapalı kayıtta me firma açılamayacağını söyler', async () => {
    const owner = await registerOrg(app);
    process.env.REGISTRATION_ENABLED = 'false';
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.account.canCreateOrg).toBe(false);
  });

  it('OWNER çıkamaz: LAST_OWNER; devirden sonra çıkabilir', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
    const denied = await leave(owner.headers);
    expect(denied.statusCode).toBe(409);
    expect(errorCode(denied)).toBe('LAST_OWNER');
    expect(await prisma.membership.count({ where: { id: owner.membershipId } })).toBe(1);
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.account.canLeaveActiveOrg).toBe(false);

    const transfer = await app.inject({
      method: 'POST',
      url: `${API}/org/transfer-ownership`,
      headers: await asWeb(owner),
      payload: { membershipId: member.membershipId, password: PASSWORD },
    });
    expect(transfer.statusCode).toBe(200);
    const again = await login(app, owner.email as string);
    const ok = await leave(bearer(again.json().accessToken));
    expect(ok.statusCode).toBe(200);
    expect(await prisma.membership.count({ where: { orgId: owner.orgId, orgRole: 'OWNER' } })).toBe(1);
  });

  it('ADMIN çıkabilir, bekleyen davetleri düşer, kalanlar etkilenmez', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
    const phone = randomTrPhone();
    const invite = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(admin),
      payload: { kind: 'PHONE_CODE', phone, name: 'Kaçak' },
    });
    expect(invite.statusCode).toBe(201);
    expect((await leave(admin.headers)).statusCode).toBe(200);
    const preview = await app.inject({
      method: 'POST',
      url: `${API}/auth/join/preview`,
      remoteAddress: randomIp(),
      payload: { phone, code: invite.json().code },
    });
    expect(errorCode(preview)).toBe('INVITE_INVALID');
    expect((await app.inject({ url: `${API}/org/members`, headers: owner.headers })).statusCode).toBe(200);
  });

  it('diğer cihaz: eski jeton bayat, yenilemede firma değişir', async () => {
    const owner = await registerOrg(app);
    const person = await addMember(app, owner.orgId);
    const other = (await login(app, person.email as string)).json();
    expect((await leave(person.headers)).statusCode).toBe(200);
    const stale = await app.inject({ url: `${API}/org`, headers: bearer(other.accessToken) });
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const refreshed = await refresh(other.refreshToken);
    expect(claimsOf(refreshed.json().accessToken).org).toBeNull();
    const rows = await prisma.session.findMany({ where: { personId: person.personId, activeOrgId: owner.orgId, revokedAt: null } });
    expect(rows).toEqual([]);
  });

  it('eşzamanlı iki ayrılma: biri geçer, tek olay', async () => {
    const owner = await registerOrg(app);
    const person = await addMember(app, owner.orgId);
    const results = await Promise.all([leave(person.headers), leave(person.headers)]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401 && errorCode(r) === 'TOKEN_STALE')).toHaveLength(1);
    expect((await outboxFor(person.membershipId)).filter((e) => e.type === 'member.removed')).toHaveLength(1);
  });

  it('kimliksiz 401, firmasız 403, askıdaki eski jetonla TOKEN_STALE; çerezle CSRF', async () => {
    expect((await app.inject({ method: 'POST', url: `${API}/org/leave`, payload: {} })).statusCode).toBe(401);

    const owner = await registerOrg(app);
    const person = await addMember(app, owner.orgId);
    const web = parseSetCookies(await login(app, person.email as string, PASSWORD, 'web'));
    const cookie = cookieHeader({ sod_at: web.sod_at });
    const noCsrf = await leave({ cookie });
    expect(errorCode(noCsrf)).toBe('CSRF_FAILED');
    expect(await prisma.membership.count({ where: { id: person.membershipId } })).toBe(1);

    await prisma.membership.update({ where: { id: person.membershipId }, data: { status: 'SUSPENDED', epoch: { increment: 1 } } });
    expect(errorCode(await leave(person.headers))).toBe('TOKEN_STALE');
    await prisma.membership.delete({ where: { id: person.membershipId } });

    const none = (await refresh(person.refreshToken)).json();
    expect(errorCode(await leave(bearer(none.accessToken)))).toBe('ORG_REQUIRED');
  });

  it('yeniden davetle dönen kişi yeni üyelik kimliği alır', async () => {
    const owner = await registerOrg(app);
    const person = await addMember(app, owner.orgId, { deciship: 'AUDITOR' });
    expect((await leave(person.headers)).statusCode).toBe(200);
    const invite = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'EMAIL', email: person.email, name: 'Dönen', productRoles: { deciship: 'ACCOUNTING' } },
    });
    expect(invite.statusCode).toBe(201);
    const token = /invite\/(\S+)$/.exec(invite.json().link)?.[1] as string;
    const fresh = (await login(app, person.email as string)).json();
    const accepted = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      headers: bearer(fresh.accessToken),
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    const claims = claimsOf(accepted.json().accessToken);
    expect(claims.mid).not.toBe(person.membershipId);
    expect(claims.prod.deciship?.role).toBe('ACCOUNTING');
  });
});

describe('yeniden yetki: e-postasız kişi', () => {
  /** İki firmada üye, e-postasız. Etkin firma B. */
  async function twoOrgWorker() {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, a.orgId, { email: null, phone });
    const inB = await joinAndSwitch(worker, b.orgId);
    return { a, b, phone, worker, inB };
  }

  it('çalınmış oturum + kalan firmanın yöneticisi: parolasız ayrılıp şifre kodu üretemez (hesap ele geçirme)', async () => {
    const { a, worker, inB, phone } = await twoOrgWorker();
    const hash = (await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).passwordHash;

    const denied = await leave(inB.headers);
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('PASSWORD_CONFIRM_REQUIRED');
    expect(await prisma.membership.count({ where: { id: inB.membershipId } })).toBe(1);

    const wrong = await leave(inB.headers, { password: 'YanlisSifre123' });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    expect(await prisma.membership.count({ where: { id: inB.membershipId } })).toBe(1);

    const code = await app.inject({ method: 'POST', url: `${API}/org/members/${worker.membershipId}/reset-code`, headers: await asWeb(a) });
    expect(code.statusCode).toBe(409);
    // 04-B10: neden ayrılmaz (e-postalı kişiyle aynı), başka firmadaki üyelik ele verilmez.
    expect(code.json().error.details.reason).toBe('SELF_RESET');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).passwordHash).toBe(hash);
    expect((await login(app, phone)).statusCode).toBe(200);
  });

  it('kişi şifresini bilerek ayrılabilir; me bunu önceden söyler', async () => {
    const { a, inB } = await twoOrgWorker();
    const me = (await app.inject({ url: `${API}/me`, headers: inB.headers })).json();
    expect(me.account).toMatchObject({ canLeaveActiveOrg: true, leaveRequiresPassword: true, passwordRecovery: 'none' });
    const ok = await leave(inB.headers, { password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().activeOrgId).toBe(a.orgId);
    expect(ok.json().me.account).toMatchObject({ leaveRequiresPassword: true, passwordRecovery: 'org_admin' });
  });

  it('son firmadan ayrılan e-postasız kişinin kurtarma yolu kalmaz: me söyler', async () => {
    const owner = await registerOrg(app);
    const worker = await addMember(app, owner.orgId, { email: null, phone: randomTrPhone() });
    const res = await leave(worker.headers, { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().me.account.passwordRecovery).toBe('none');
    expect(res.json().activeOrgId).toBeNull();
  });

  it('parola denemesi sınırlıdır', async () => {
    const { inB, worker } = await twoOrgWorker();
    let last = await leave(inB.headers, { password: 'Yanlis12345' });
    for (let i = 0; i < RATE_RULES.passwordConfirm.limit; i++) last = await leave(inB.headers, { password: `Yanlis1234${i}` });
    expect(last.statusCode).toBe(429);
    await prisma.rateBucket.deleteMany({ where: { key: `password:person:${worker.personId}` } });
  });

  it('e-postalı kişi parola gerekmeden ayrılır', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { email: randomEmail() });
    const me = (await app.inject({ url: `${API}/me`, headers: member.headers })).json();
    expect(me.account.leaveRequiresPassword).toBe(false);
    expect((await leave(member.headers)).statusCode).toBe(200);
  });
});

describe('katalog', () => {
  it('kayıt anahtarını söyler', async () => {
    const open = (await app.inject({ url: `${API}/catalog` })).json();
    expect(open.registrationEnabled).toBe(true);
    process.env.REGISTRATION_ENABLED = 'false';
    const closed = (await app.inject({ url: `${API}/catalog` })).json();
    expect(closed.registrationEnabled).toBe(false);
  });
});

describe('abonelik ve kayıtta açılış çalışırken duruma bakar (PRODUCT_LAUNCH)', () => {
  async function withLaunch<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PRODUCT_LAUNCH;
    process.env.PRODUCT_LAUNCH = value;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.PRODUCT_LAUNCH;
      else process.env.PRODUCT_LAUNCH = saved;
    }
  }
  const subscriptions = (headers: Record<string, string>) =>
    app.inject({ url: `${API}/org/subscriptions`, headers }).then((r) => (r.json() as { subscriptions: { product: string; name: string }[] }).subscriptions);

  it('abonelik listesi yalnız kayıtta olan ve kapalı olmayan ürünü gösterir', async () => {
    const owner = await registerOrg(app);
    await prisma.subscription.create({ data: { orgId: owner.orgId, product: 'orderloom', status: 'ACTIVE', plan: 'early_access' } });
    await prisma.subscription.create({ data: { orgId: owner.orgId, product: 'eskiurun', status: 'ACTIVE', plan: 'early_access' } });
    expect((await subscriptions(owner.headers)).map((s) => [s.product, s.name])).toEqual([['deciship', 'DeciShip']]);
    await withLaunch('deciship=pilot', async () => {
      expect((await subscriptions(owner.headers)).map((s) => s.product)).toEqual(['deciship']);
    });
    await withLaunch('deciship=off', async () => {
      expect(await subscriptions(owner.headers)).toEqual([]);
    });
  });

  it('kayıt ve POST /orgs yalnız public ürünü açar; olaylar yalnız açılan ürüne', async () => {
    const owner = await registerOrg(app);
    const publicOrg = await createOrg(owner.headers);
    expect(publicOrg.statusCode).toBe(201);
    const publicSubs = await prisma.subscription.findMany({ where: { orgId: publicOrg.json().activeOrgId } });
    expect(publicSubs.map((s) => [s.product, s.status, s.plan])).toEqual([['deciship', 'ACTIVE', 'early_access']]);

    await withLaunch('deciship=pilot', async () => {
      const pilotOrg = await createOrg(owner.headers);
      expect(pilotOrg.statusCode).toBe(201);
      const orgId = pilotOrg.json().activeOrgId as string;
      expect(await prisma.subscription.count({ where: { orgId } })).toBe(0);
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { personId_orgId: { personId: owner.personId, orgId } },
        include: { productAccess: true },
      });
      expect(membership.orgRole).toBe('OWNER');
      expect(membership.productAccess).toEqual([]);
      // Ürünü olmayan firma için ürün olayı yazılmaz.
      expect(await prisma.outbox.count({ where: { orgId } })).toBe(0);
    });
  });
});
