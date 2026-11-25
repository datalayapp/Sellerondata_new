import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { authorizeInvitedRole, authorizeMemberChange } from '../src/lib/members.ts';
import { closeOrg, reopenOrg } from '../src/lib/subscriptions.ts';
import {
  addMember,
  API,
  bearer,
  claimsOf,
  epochOf,
  errorCode,
  getApp,
  login,
  outboxFor,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg,
  type Ctx, asWeb, webHeadersFrom } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const patch = async (actor: Ctx, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `${API}/org/members/${id}`, headers: await asWeb(actor), payload });
const remove = async (actor: Ctx, id: string) => app.inject({ method: 'DELETE', url: `${API}/org/members/${id}`, headers: await asWeb(actor) });

async function team() {
  const owner = await registerOrg(app);
  const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
  const admin2 = await addMember(app, owner.orgId, { orgRole: 'ADMIN', deciship: 'AUDITOR' });
  const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
  return { owner, admin, admin2, member };
}

describe('saf yetki kuralı', () => {
  const owner = { id: 'o', orgRole: 'OWNER' as const };
  const admin = { id: 'a', orgRole: 'ADMIN' as const };
  const admin2 = { id: 'a2', orgRole: 'ADMIN' as const };
  const member = { id: 'm', orgRole: 'MEMBER' as const };
  const code = (fn: () => void) => {
    try {
      fn();
      return 'OK';
    } catch (err) {
      return (err as { code: string }).code;
    }
  };

  it('karar tablosu', () => {
    const cases: [typeof owner | typeof admin | typeof member, { id: string; orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' }, Parameters<typeof authorizeMemberChange>[2], string][] = [
      [member, member, { status: 'SUSPENDED' }, 'FORBIDDEN'],
      [member, { id: 'x', orgRole: 'MEMBER' }, { remove: true }, 'FORBIDDEN'],
      [admin, owner, { status: 'SUSPENDED' }, 'CANNOT_MANAGE_OWNER'],
      [admin, owner, { remove: true }, 'CANNOT_MANAGE_OWNER'],
      [admin, owner, { productRoles: {} }, 'CANNOT_MANAGE_OWNER'],
      [admin, owner, { resetCode: true }, 'CANNOT_MANAGE_OWNER'],
      [admin, admin2, { status: 'SUSPENDED' }, 'FORBIDDEN'],
      [admin, admin2, { orgRole: 'MEMBER' }, 'FORBIDDEN'],
      [admin, admin2, { resetCode: true }, 'FORBIDDEN'],
      [admin, member, { orgRole: 'ADMIN' }, 'FORBIDDEN'],
      [admin, member, { orgRole: 'OWNER' }, 'USE_OWNERSHIP_TRANSFER'],
      [admin, member, { status: 'SUSPENDED' }, 'OK'],
      [admin, member, { productRoles: {} }, 'OK'],
      [admin, member, { remove: true }, 'OK'],
      [admin, admin, { status: 'SUSPENDED' }, 'CANNOT_MANAGE_SELF'],
      [admin, admin, { orgRole: 'MEMBER' }, 'CANNOT_MANAGE_SELF'],
      [admin, admin, { productRoles: {} }, 'CANNOT_MANAGE_SELF'],
      [admin, admin, { remove: true }, 'CANNOT_MANAGE_SELF'],
      [owner, owner, { remove: true }, 'LAST_OWNER'],
      [owner, owner, { status: 'SUSPENDED' }, 'LAST_OWNER'],
      [owner, owner, { orgRole: 'MEMBER' }, 'LAST_OWNER'],
      [owner, owner, { resetCode: true }, 'CANNOT_MANAGE_SELF'],
      [owner, owner, { productRoles: {} }, 'OK'],
      [owner, admin, { orgRole: 'MEMBER' }, 'OK'],
      [owner, admin, { orgRole: 'OWNER' }, 'USE_OWNERSHIP_TRANSFER'],
      [owner, member, { orgRole: 'ADMIN' }, 'OK'],
      [owner, admin, { remove: true }, 'OK'],
    ];
    for (const [actor, target, change, expected] of cases) {
      expect(code(() => authorizeMemberChange(actor, target, change)), `${actor.orgRole}->${target.orgRole} ${JSON.stringify(change)}`).toBe(expected);
    }
  });

  it('davet rolleri', () => {
    expect(code(() => authorizeInvitedRole(admin, 'MEMBER'))).toBe('OK');
    expect(code(() => authorizeInvitedRole(admin, 'ADMIN'))).toBe('FORBIDDEN');
    expect(code(() => authorizeInvitedRole(admin, 'OWNER'))).toBe('USE_OWNERSHIP_TRANSFER');
    expect(code(() => authorizeInvitedRole(owner, 'ADMIN'))).toBe('OK');
    expect(code(() => authorizeInvitedRole(owner, 'OWNER'))).toBe('USE_OWNERSHIP_TRANSFER');
    expect(code(() => authorizeInvitedRole(member, 'MEMBER'))).toBe('FORBIDDEN');
  });
});

describe('ADMIN sınırları (API)', () => {
  it('OWNER\'a dokunamaz: rol, araç rolü, askı, çıkarma', async () => {
    const { owner, admin } = await team();
    const epochBefore = await epochOf(owner.membershipId);
    for (const payload of [{ orgRole: 'MEMBER' }, { status: 'SUSPENDED' }, { productRoles: { deciship: null } }]) {
      const res = await patch(admin, owner.membershipId, payload);
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('CANNOT_MANAGE_OWNER');
    }
    const del = await remove(admin, owner.membershipId);
    expect(del.statusCode).toBe(403);
    expect(errorCode(del)).toBe('CANNOT_MANAGE_OWNER');
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId }, include: { productAccess: true } });
    expect(after.orgRole).toBe('OWNER');
    expect(after.status).toBe('ACTIVE');
    expect(after.epoch).toBe(epochBefore);
    expect(after.productAccess).toHaveLength(1);
  });

  it('ADMIN atayamaz: rol değişikliğiyle de davetle de', async () => {
    const { admin, member } = await team();
    const promote = await patch(admin, member.membershipId, { orgRole: 'ADMIN' });
    expect(promote.statusCode).toBe(403);
    expect(errorCode(promote)).toBe('FORBIDDEN');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).orgRole).toBe('MEMBER');

    const invite = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(admin),
      payload: { kind: 'EMAIL', email: randomEmail(), name: 'X', orgRole: 'ADMIN' },
    });
    expect(invite.statusCode).toBe(403);
    expect(errorCode(invite)).toBe('FORBIDDEN');
  });

  it('kimse davetle veya rol değişikliğiyle OWNER yapılamaz', async () => {
    const { owner, admin, member } = await team();
    const byOwner = await patch(owner, member.membershipId, { orgRole: 'OWNER' });
    expect(errorCode(byOwner)).toBe('USE_OWNERSHIP_TRANSFER');
    const byAdmin = await patch(admin, member.membershipId, { orgRole: 'OWNER' });
    expect(errorCode(byAdmin)).toBe('USE_OWNERSHIP_TRANSFER');
    const invite = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'EMAIL', email: randomEmail(), name: 'X', orgRole: 'OWNER' },
    });
    expect(errorCode(invite)).toBe('USE_OWNERSHIP_TRANSFER');
  });

  it('başka ADMIN\'e dokunamaz', async () => {
    const { admin, admin2 } = await team();
    expect(errorCode(await patch(admin, admin2.membershipId, { status: 'SUSPENDED' }))).toBe('FORBIDDEN');
    expect(errorCode(await patch(admin, admin2.membershipId, { orgRole: 'MEMBER' }))).toBe('FORBIDDEN');
    expect(errorCode(await remove(admin, admin2.membershipId))).toBe('FORBIDDEN');
  });

  it('OWNER\'ın açtığı ADMIN davetine ADMIN dokunamaz', async () => {
    const { owner, admin } = await team();
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'X', orgRole: 'ADMIN' },
    });
    expect(inv.statusCode).toBe(201);
    const id = inv.json().invitation.id;
    const resend = await app.inject({ method: 'POST', url: `${API}/org/invitations/${id}/resend`, headers: await asWeb(admin) });
    expect(errorCode(resend)).toBe('FORBIDDEN');
    const del = await app.inject({ method: 'DELETE', url: `${API}/org/invitations/${id}`, headers: await asWeb(admin) });
    expect(errorCode(del)).toBe('FORBIDDEN');
  });

  it('MEMBER'.concat(' hesap uçlarına giremez'), async () => {
    const { member, owner } = await team();
    const urls: [string, string][] = [
      ['GET', '/org/members'],
      ['GET', '/org/invitations'],
      ['GET', '/org/subscriptions'],
      ['GET', '/org/audit'],
      ['POST', `/org/members/${owner.membershipId}/reset-code`],
      ['POST', '/org/members/invite'],
      ['PATCH', `/org/members/${owner.membershipId}`],
      ['DELETE', `/org/members/${owner.membershipId}`],
      ['PATCH', '/org'],
      ['POST', '/org/transfer-ownership'],
      ['POST', '/org/billing/checkout'],
    ];
    for (const [method, url] of urls) {
      const res = await app.inject({
        method: method as 'GET',
        url: `${API}${url}`,
        headers: member.headers,
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorCode(res), `${method} ${url}`).toBe('FORBIDDEN');
    }
    // Kendi firmasını görebilir.
    expect((await app.inject({ url: `${API}/org`, headers: member.headers })).statusCode).toBe(200);
  });

  it('jeton olmadan hiçbir yönetim ucuna girilemez', async () => {
    const urls: [string, string][] = [
      ['GET', '/me'],
      ['GET', '/org'],
      ['GET', '/org/members'],
      ['POST', '/org/members/invite'],
      ['POST', '/org/transfer-ownership'],
      ['POST', '/org/billing/x'],
      ['POST', '/auth/switch-org'],
    ];
    for (const [method, url] of urls) {
      const res = await app.inject({ method: method as 'GET', url: `${API}${url}`, ...(method === 'GET' ? {} : { payload: {} }) });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('son OWNER ve kendini yönetme', () => {
  it('son OWNER çıkarılamaz, askıya alınamaz, rolü düşürülemez', async () => {
    const owner = await registerOrg(app);
    const del = await remove(owner, owner.membershipId);
    expect(del.statusCode).toBe(409);
    expect(errorCode(del)).toBe('LAST_OWNER');
    expect(errorCode(await patch(owner, owner.membershipId, { status: 'SUSPENDED' }))).toBe('LAST_OWNER');
    expect(errorCode(await patch(owner, owner.membershipId, { orgRole: 'ADMIN' }))).toBe('LAST_OWNER');
    expect(await prisma.membership.count({ where: { id: owner.membershipId, orgRole: 'OWNER', status: 'ACTIVE' } })).toBe(1);
  });

  it('ADMIN kendini askıya alamaz, rolünü değiştiremez, araç rolünü yükseltemez, çıkaramaz', async () => {
    const { admin } = await team();
    for (const payload of [{ status: 'SUSPENDED' }, { orgRole: 'MEMBER' }, { productRoles: { deciship: 'ADMIN' } }]) {
      const res = await patch(admin, admin.membershipId, payload);
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('CANNOT_MANAGE_SELF');
    }
    expect(errorCode(await remove(admin, admin.membershipId))).toBe('CANNOT_MANAGE_SELF');
  });

  it('OWNER kendi araç rolünü değiştirebilir: onu yönetebilecek başkası yok', async () => {
    const owner = await registerOrg(app);
    const res = await patch(owner, owner.membershipId, { productRoles: { deciship: 'AUDITOR' } });
    expect(res.statusCode).toBe(200);
    const access = await prisma.productAccess.findFirstOrThrow({ where: { membershipId: owner.membershipId } });
    expect(access.role).toBe('AUDITOR');
  });
});

describe('firmalar arası izolasyon', () => {
  it('A yöneticisi B üyeliğine erişemez, varlığını da göremez', async () => {
    const a = await team();
    const b = await team();
    for (const actor of [a.owner, a.admin]) {
      for (const id of [b.member.membershipId, b.admin.membershipId, b.owner.membershipId]) {
        const up = await patch(actor, id, { status: 'SUSPENDED' });
        expect(up.statusCode).toBe(404);
        expect(errorCode(up)).toBe('NOT_FOUND');
        expect((await remove(actor, id)).statusCode).toBe(404);
        const reset = await app.inject({ method: 'POST', url: `${API}/org/members/${id}/reset-code`, headers: await asWeb(actor) });
        expect(reset.statusCode).toBe(404);
      }
    }
    const list = await app.inject({ url: `${API}/org/members`, headers: a.owner.headers });
    const ids = list.json().members.map((m: { id: string }) => m.id);
    expect(ids).toContain(a.member.membershipId);
    expect(ids).not.toContain(b.member.membershipId);
    expect(list.body).not.toContain(b.member.email as string);
    // B değişmedi
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: b.member.membershipId } });
    expect(row.status).toBe('ACTIVE');
  });

  it('A\'nın davetine B yöneticisi dokunamaz', async () => {
    const a = await team();
    const b = await team();
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(a.owner),
      payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'X' },
    });
    const id = inv.json().invitation.id;
    expect((await app.inject({ method: 'POST', url: `${API}/org/invitations/${id}/resend`, headers: await asWeb(b.owner) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${API}/org/invitations/${id}`, headers: await asWeb(b.owner) })).statusCode).toBe(404);
  });

  it('iki firmada üye kişi: A\'da yönetici olması B\'de yetki vermez, jeton hangi firmadaysa kapsam odur', async () => {
    const a = await team();
    const b = await team();
    const person = await addMember(app, a.owner.orgId, { orgRole: 'ADMIN' });
    await prisma.membership.create({ data: { personId: person.personId, orgId: b.owner.orgId, orgRole: 'MEMBER' } });

    // A jetonuyla B üyesi: yok
    expect((await patch(person, b.member.membershipId, { status: 'SUSPENDED' })).statusCode).toBe(404);

    // B'ye geçince yönetici değil
    const sw = await app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: person.headers, payload: { orgId: b.owner.orgId } });
    const bHeaders = bearer(sw.json().accessToken);
    const res = await app.inject({ method: 'PATCH', url: `${API}/org/members/${b.member.membershipId}`, headers: await webHeadersFrom(bHeaders), payload: { status: 'SUSPENDED' } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ url: `${API}/org/members`, headers: bHeaders })).statusCode).toBe(403);
  });

  it('A\'nın denetim izi B\'ye görünmez', async () => {
    const a = await team();
    const b = await team();
    await patch(a.owner, a.member.membershipId, { status: 'SUSPENDED' });
    const audit = await app.inject({ url: `${API}/org/audit`, headers: b.owner.headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(a.member.membershipId);
    const own = await app.inject({ url: `${API}/org/audit`, headers: a.owner.headers });
    expect(own.body).toContain(a.member.membershipId);
    expect(own.json().items[0]).toHaveProperty('actor');
  });

  it('yönetici kişinin şifresine ve e-postasına dokunamaz: uç yok, alan yok sayılır', async () => {
    const { owner, member } = await team();
    const before = await prisma.person.findUniqueOrThrow({ where: { id: member.personId } });
    const res = await patch(owner, member.membershipId, { password: 'Ele12345678', email: 'ele@gecir.com', name: 'Ele' });
    expect(res.statusCode).toBe(200);
    const after = await prisma.person.findUniqueOrThrow({ where: { id: member.personId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.email).toBe(before.email);
    expect(after.name).toBe(before.name);
    // PATCH /me yalnız kendi kişisini değiştirir.
    expect(res.json().changed).toEqual([]);
  });
});

describe('sahiplik devri', () => {
  const transfer = async (actor: Ctx, membershipId: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: `${API}/org/transfer-ownership`, headers: await asWeb(actor), payload: { membershipId, password } });

  it('yanlış şifreyle olmaz; doğru şifreyle roller değişir, iki epoch artar, olaylar yazılır', async () => {
    const { owner, admin, member } = await team();
    const wrong = await transfer(owner, member.membershipId, 'YanlisSifre123');
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId } })).orgRole).toBe('OWNER');

    const ownerEpoch = await epochOf(owner.membershipId);
    const memberEpoch = await epochOf(member.membershipId);
    const ownerEvents = (await outboxFor(owner.membershipId)).length;

    const ok = await transfer(owner, member.membershipId);
    expect(ok.statusCode).toBe(200);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId } })).orgRole).toBe('ADMIN');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).orgRole).toBe('OWNER');
    expect(await epochOf(owner.membershipId)).toBe(ownerEpoch + 1);
    expect(await epochOf(member.membershipId)).toBe(memberEpoch + 1);
    expect((await outboxFor(owner.membershipId)).length).toBe(ownerEvents + 1);
    expect(await prisma.membership.count({ where: { orgId: owner.orgId, orgRole: 'OWNER' } })).toBe(1);

    // Eski OWNER'ın jetonu artık bayat
    const stale = await transfer(owner, admin.membershipId);
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');
  });

  it('yalnız OWNER devreder; ADMIN doğru şifreyle de devredemez', async () => {
    const { admin, member } = await team();
    const res = await transfer(admin, member.membershipId);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('kendine, askıdakine, başka firmaya devredilemez', async () => {
    const { owner, member } = await team();
    const stranger = await team();
    expect(errorCode(await transfer(owner, owner.membershipId))).toBe('CANNOT_MANAGE_SELF');
    expect((await transfer(owner, stranger.member.membershipId)).statusCode).toBe(404);
    await patch(owner, member.membershipId, { status: 'SUSPENDED' });
    expect((await transfer(owner, member.membershipId)).statusCode).toBe(409);
  });

  it('şifre denemesi sınırlıdır', async () => {
    const { owner, member } = await team();
    let last = await transfer(owner, member.membershipId, 'Yanlis12345');
    for (let i = 0; i < 11; i++) last = await transfer(owner, member.membershipId, `Yanlis1234${i}`);
    expect(last.statusCode).toBe(429);
    expect(errorCode(last)).toBe('TOO_MANY_ATTEMPTS');
    await prisma.rateBucket.deleteMany({ where: { key: `password:person:${owner.personId}` } });
  });
});

describe('üyelik değişimi', () => {
  it('askıya alınan kişi: epoch artar, jeton bayat, yenilemede firma düşer, etkinleştirince döner', async () => {
    const { owner, member } = await team();
    const epoch = await epochOf(member.membershipId);
    const res = await patch(owner, member.membershipId, { status: 'SUSPENDED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toEqual(['status']);
    expect(await epochOf(member.membershipId)).toBe(epoch + 1);

    const stale = await app.inject({ url: `${API}/org`, headers: member.headers });
    expect(stale.statusCode).toBe(401);
    expect(errorCode(stale)).toBe('TOKEN_STALE');

    const refreshed = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: member.refreshToken } });
    const claims = claimsOf(refreshed.json().accessToken);
    expect(claims.org).toBeNull();
    expect(claims.prod).toEqual({});

    const me = await app.inject({ url: `${API}/me`, headers: bearer(refreshed.json().accessToken) });
    expect(me.json().activeOrg).toBeNull();
    expect(me.json().orgs[0]).toMatchObject({ id: owner.orgId, status: 'SUSPENDED' });
    expect(me.json().products.find((p: { key: string }) => p.key === 'deciship').role).toBeNull();

    await patch(owner, member.membershipId, { status: 'ACTIVE' });
    const back = await login(app, member.email as string);
    expect(claimsOf(back.json().accessToken).org).toBe(owner.orgId);
    expect(claimsOf(back.json().accessToken).ep).toBe(epoch + 2);
  });

  it('rolü düşürülen yönetici eski jetonla iş yapamaz: Hesap rolü veritabanından okur', async () => {
    const { owner, admin, member } = await team();
    await patch(owner, admin.membershipId, { orgRole: 'MEMBER' });
    const res = await patch(admin, member.membershipId, { status: 'SUSPENDED' });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('TOKEN_STALE');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).status).toBe('ACTIVE');
  });

  it('çıkarılan kişi: üyelik silinir, olay yazılır, yenilemede org null, kişi ve şifre kalır', async () => {
    const { owner, member } = await team();
    const epoch = await epochOf(member.membershipId);
    const res = await remove(owner, member.membershipId);
    expect(res.statusCode).toBe(200);
    expect(await prisma.membership.count({ where: { id: member.membershipId } })).toBe(0);
    const events = await outboxFor(member.membershipId);
    const removed = events.at(-1)?.payload as { type: string; epoch: number; personId: string };
    expect(removed.type).toBe('member.removed');
    expect(removed.epoch).toBe(epoch + 1);
    expect(removed.personId).toBe(member.personId);

    const refreshed = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: member.refreshToken } });
    expect(claimsOf(refreshed.json().accessToken).org).toBeNull();
    expect((await login(app, member.email as string)).statusCode).toBe(200);
  });

  it('yetkisi düşen yöneticinin bekleyen davetleri geçersiz olur', async () => {
    const { owner, admin } = await team();
    const phone = randomTrPhone();
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(admin),
      // Özel roller planı: ayar izinli rolü (DeciShip Yönetici) yalnız sahip davetle verir; yönetici en geniş kalan rolü verir.
      payload: { kind: 'PHONE_CODE', phone, name: 'Kaçak', productRoles: { deciship: 'AUDITOR' } },
    });
    expect(inv.statusCode).toBe(201);
    await patch(owner, admin.membershipId, { status: 'SUSPENDED' });
    const accept = await app.inject({
      method: 'POST',
      url: `${API}/auth/join/accept`,
      remoteAddress: randomIp(),
      payload: { phone, code: inv.json().code, password: 'Kacak12345!', client: 'mobile' },
    });
    expect(errorCode(accept)).toBe('INVITE_INVALID');
  });

  it('katalog doğrulaması: hazır olmayan ürün, bilinmeyen rol, bilinmeyen ürün', async () => {
    const { owner, member } = await team();
    const notReady = await patch(owner, member.membershipId, { productRoles: { orderloom: 'ADMIN' } });
    expect(notReady.statusCode).toBe(400);
    expect(errorCode(notReady)).toBe('PRODUCT_NOT_AVAILABLE');
    expect(errorCode(await patch(owner, member.membershipId, { productRoles: { tagpress: 'ADMIN' } }))).toBe('PRODUCT_NOT_AVAILABLE');
    expect(errorCode(await patch(owner, member.membershipId, { productRoles: { deciship: 'PATRON' } }))).toBe('INVALID_PRODUCT_ROLE');
    expect(errorCode(await patch(owner, member.membershipId, { productRoles: { baska: 'ADMIN' } }))).toBe('INVALID_PRODUCT_ROLE');
    expect(await prisma.productAccess.count({ where: { membershipId: member.membershipId, product: { not: 'deciship' } } })).toBe(0);
    // null her üründe zararsız
    expect((await patch(owner, member.membershipId, { productRoles: { orderloom: null } })).statusCode).toBe(200);
  });

  it('roller: DeciShip kataloğundaki her rol atanabilir, jetona yansır, null erişimi kaldırır', async () => {
    const { owner, member } = await team();
    for (const role of ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE']) {
      expect((await patch(owner, member.membershipId, { productRoles: { deciship: role } })).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: randomIp(), payload: { identifier: member.email, password: PASSWORD, client: 'mobile' } });
      expect(claimsOf(res.json().accessToken).prod.deciship?.role).toBe(role);
    }
    await patch(owner, member.membershipId, { productRoles: { deciship: null } });
    const res = await login(app, member.email as string);
    expect(claimsOf(res.json().accessToken).prod).toEqual({});
    const me = res.json().me.products.find((p: { key: string }) => p.key === 'deciship');
    expect(me).toMatchObject({ role: null, permissions: [] });
  });
});

describe('firma', () => {
  it('ad değişimi olay yazar, MEMBER değiştiremez', async () => {
    const { owner, member } = await team();
    const res = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name: 'Yeni Firma Adı' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Yeni Firma Adı');
    const events = await prisma.outbox.findMany({ where: { orgId: owner.orgId, type: 'org.updated' }, orderBy: { createdAt: 'desc' } });
    expect((events[0].payload as { name: string }).name).toBe('Yeni Firma Adı');
    const denied = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(member), payload: { name: 'Olmaz' } });
    expect(denied.statusCode).toBe(403);
  });

  it('abonelik listesi sağlayıcı alanı sızdırmaz', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ url: `${API}/org/subscriptions`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscriptions[0]).toMatchObject({ product: 'deciship', status: 'ACTIVE', plan: 'early_access', name: 'DeciShip' });
    expect(res.body).not.toContain('providerRef');
  });

  it('ödeme uçları 501 PAYMENT_NOT_AVAILABLE', async () => {
    const owner = await registerOrg(app);
    for (const path of ['checkout', 'portal', 'a/b/c']) {
      const res = await app.inject({ method: 'POST', url: `${API}/org/billing/${path}`, headers: await asWeb(owner), payload: {} });
      expect(res.statusCode).toBe(501);
      expect(errorCode(res)).toBe('PAYMENT_NOT_AVAILABLE');
    }
  });

  it('denetim izi sayfalanır ve kod, jeton içermez', async () => {
    const { owner, member } = await team();
    await patch(owner, member.membershipId, { productRoles: { deciship: 'AUDITOR' } });
    const res = await app.inject({ url: `${API}/org/audit?page=1&pageSize=2`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, pageSize: 2 });
    expect(res.json().items.length).toBeLessThanOrEqual(2);
    const bad = await app.inject({ url: `${API}/org/audit?pageSize=9999`, headers: owner.headers });
    expect(bad.statusCode).toBe(400);
  });
});

describe('rol doğrulaması çalışırken duruma bakar (PRODUCT_LAUNCH)', () => {
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
  const roleOf = async (membershipId: string) =>
    (await prisma.productAccess.findUnique({ where: { membershipId_product: { membershipId, product: 'deciship' } } }))?.role ?? null;

  it('off: rol verilemez (PRODUCT_NOT_AVAILABLE), "Erişim yok" verilebilir; epoch artmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await withLaunch('deciship=off', async () => {
      const before = await epochOf(member.membershipId);
      const res = await patch(owner, member.membershipId, { productRoles: { deciship: 'AUDITOR' } });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('PRODUCT_NOT_AVAILABLE');
      expect(await roleOf(member.membershipId)).toBe('MEASURE');
      expect(await epochOf(member.membershipId)).toBe(before);
      expect((await patch(owner, member.membershipId, { productRoles: { deciship: null } })).statusCode).toBe(200);
      expect(await roleOf(member.membershipId)).toBeNull();
    });
  });

  it('pilot: rol yalnız aboneliği olan firmada; aboneliksiz firmada PRODUCT_NOT_AVAILABLE ve hiçbir değişiklik yazılmaz', async () => {
    const withSub = await registerOrg(app);
    const subMember = await addMember(app, withSub.orgId);
    await withLaunch('deciship=pilot', async () => {
      expect((await patch(withSub, subMember.membershipId, { productRoles: { deciship: 'AUDITOR' } })).statusCode).toBe(200);
      expect(await roleOf(subMember.membershipId)).toBe('AUDITOR');

      const fresh = await registerOrg(app);
      const member = await addMember(app, fresh.orgId);
      const before = await epochOf(member.membershipId);
      // Rol ile birlikte gelen firma rolü değişikliği de geri alınır: tek işlem.
      const res = await patch(fresh, member.membershipId, { orgRole: 'ADMIN', productRoles: { deciship: 'AUDITOR' } });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('PRODUCT_NOT_AVAILABLE');
      expect(await roleOf(member.membershipId)).toBeNull();
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).orgRole).toBe('MEMBER');
      expect(await epochOf(member.membershipId)).toBe(before);
      expect((await patch(fresh, member.membershipId, { productRoles: { deciship: null } })).statusCode).toBe(200);
    });
  });

  const invite = async (actor: Ctx, productRoles: Record<string, string | null>) =>
    app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(actor),
      payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Davetli', orgRole: 'MEMBER', productRoles },
    });

  it('davet: kapalı ürüne ve aboneliği olmayan firmada pilot ürüne rol davete yazılmaz (PRODUCT_NOT_AVAILABLE)', async () => {
    const withSub = await registerOrg(app);
    await withLaunch('deciship=off', async () => {
      const res = await invite(withSub, { deciship: 'MEASURE' });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('PRODUCT_NOT_AVAILABLE');
    });
    await withLaunch('deciship=pilot', async () => {
      expect((await invite(withSub, { deciship: 'MEASURE' })).statusCode).toBe(201);
      const fresh = await registerOrg(app);
      const res = await invite(fresh, { deciship: 'MEASURE' });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('PRODUCT_NOT_AVAILABLE');
      expect(await prisma.invitation.count({ where: { orgId: fresh.orgId } })).toBe(0);
      // "Erişim yok" ile davet her zaman yazılır.
      expect((await invite(fresh, { deciship: null })).statusCode).toBe(201);
    });
  });

  it('üye listesi: kapalı ürünün ve aboneliği olmayan firmadaki pilot ürünün rolü görünmez; satır silinmez', async () => {
    const members = (actor: Ctx) =>
      app.inject({ url: `${API}/org/members`, headers: actor.headers }).then((r) => r.json().members as { id: string; productRoles: Record<string, string> }[]);
    const rolesOf = async (actor: Ctx, membershipId: string) => (await members(actor)).find((m) => m.id === membershipId)!.productRoles;

    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await prisma.productAccess.create({ data: { membershipId: member.membershipId, product: 'orderloom', role: 'ADMIN' } });
    expect(await rolesOf(owner, member.membershipId)).toEqual({ deciship: 'MEASURE' });
    await withLaunch('deciship=off', async () => {
      expect(await rolesOf(owner, member.membershipId)).toEqual({});
    });
    await withLaunch('deciship=pilot', async () => {
      expect(await rolesOf(owner, member.membershipId)).toEqual({ deciship: 'MEASURE' });
      await prisma.subscription.deleteMany({ where: { orgId: owner.orgId } });
      expect(await rolesOf(owner, member.membershipId)).toEqual({});
    });
    // Veri kaybı yok: satırlar duruyor.
    expect(await prisma.productAccess.count({ where: { membershipId: member.membershipId } })).toBe(2);
  });
});

describe('kapalı firmada davet açılmaz (org:close)', () => {
  const invite = async (actor: Ctx) =>
    app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(actor),
      payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Davetli', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } },
    });
  const relogin = async (ctx: Ctx) => {
    const res = await login(app, ctx.email as string);
    return { ...ctx, headers: bearer(res.json().accessToken) };
  };

  it('kapatılınca davet 409 ORG_CLOSED, yazılmaz; yeniden açılınca davet yine açılır', async () => {
    const owner = await registerOrg(app);
    await closeOrg(owner.orgId, { operator: 'test' });
    const closed = await relogin(owner);
    const res = await invite(closed);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('ORG_CLOSED');
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId, revokedAt: null } })).toBe(0);

    await reopenOrg(owner.orgId, { operator: 'test' });
    expect((await invite(await relogin(owner))).statusCode).toBe(201);
  });

  it('kapalı firmada bekleyen davet yeniden gönderilemez (409 ORG_CLOSED)', async () => {
    const owner = await registerOrg(app);
    const created = await invite(owner);
    expect(created.statusCode).toBe(201);
    const invitationId = created.json().invitation.id as string;
    await closeOrg(owner.orgId, { operator: 'test' });
    // Kapatma bekleyen daveti düşürür; düşmemiş bir satır kalsa bile yeniden gönderme kapalı.
    await prisma.invitation.update({ where: { id: invitationId }, data: { revokedAt: null } });
    const closed = await relogin(owner);
    const res = await app.inject({ method: 'POST', url: `${API}/org/invitations/${invitationId}/resend`, headers: await asWeb(closed) });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('ORG_CLOSED');
  });

  it('abonelikleri elle CANCELED olan ama kapatılmamış firma kapalı sayılmaz', async () => {
    const owner = await registerOrg(app);
    await prisma.subscription.updateMany({ where: { orgId: owner.orgId }, data: { status: 'CANCELED' } });
    expect((await invite(owner)).statusCode).toBe(201);
  });
});
