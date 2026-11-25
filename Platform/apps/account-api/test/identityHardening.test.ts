import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { sha256 } from '../src/lib/crypto.ts';
import { flushMail, productNoticeMail } from '../src/lib/mailer.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import { addMember, API, errorCode, getApp, login, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, type Ctx, asWeb, webHeadersFrom, isOrgWrite } from './helpers.ts';

/**
 * Mesaj 8 (DENETIM-2): kimlik ve yetki sıkılaştırma. Her blok bir bulguyu önce kırmızı gösterdi (düzeltmeden önceki kodla koşuldu).
 * 03-B1 eski sahibin kodları, 04-B5 doğrulanmamış üyeye devir, 04-B6 günlük giriş tavanı ve kilit postası, 04-B9 şifre değişti
 * postası, 03-B9 yönetim yazma sınırı ve kilit sırası, 04-B1 olaya bağlı yenileme toleransı, 03-B10 destek izinin müşteri yüzü,
 * 03-B6 bildirim postasında bağlantı etkisizleştirme.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
  process.env.REFRESH_REUSE_GRACE_SECONDS = '10';
});

const NEW_PASSWORD = 'TuzluDeniz-8352';

// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}, ip = randomIp()) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: ip, headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });
const joinPreview = (phone: string, code: string) =>
  app.inject({ method: 'POST', url: `${API}/auth/join/preview`, remoteAddress: randomIp(), payload: { phone, code } });
const joinAccept = (phone: string, code: string, password: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}/auth/join/accept`, remoteAddress: randomIp(), payload: { phone, code, password, client: 'mobile', ...extra } });
const transfer = (owner: Ctx, to: Ctx) => post('/org/transfer-ownership', owner.headers, { membershipId: to.membershipId, password: PASSWORD });
const tokenOfLink = (link: string) => new URL(link).pathname.split('/').pop() as string;
const acceptEmailInvite = (token: string) =>
  app.inject({ method: 'POST', url: `${API}/invites/${token}/accept`, remoteAddress: randomIp(), payload: { name: 'Davetli', password: NEW_PASSWORD, client: 'mobile' } });
const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken } });
const attempt = (identifier: string, ip: string, password = 'YanlisSifre123') =>
  app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: ip, payload: { identifier, password, client: 'mobile' } });

async function countOf(key: string) {
  return (await prisma.rateBucket.findUnique({ where: { key } }))?.count ?? 0;
}
async function fill(key: string, count: number) {
  const windowEnd = new Date(Date.now() + 3600_000);
  await prisma.rateBucket.upsert({ where: { key }, create: { key, count, windowEnd }, update: { count, windowEnd } });
}
async function mails(to: string, template: string) {
  await flushMail();
  return prisma.mailLog.findMany({ where: { to, template }, orderBy: { createdAt: 'asc' } });
}
async function verifyEmail(personId: string) {
  await prisma.person.update({ where: { id: personId }, data: { emailVerifiedAt: new Date() } });
}

describe('03-B1: devirden sonra eski sahibin yönetici kodları ve davetleri', () => {
  it('yöneticiye üretilmiş şifre kodu devirden sonra çalışmaz (önizleme ve kabul), şifre değişmez', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', email: null, phone });
    const issued = await post(`/org/members/${admin.membershipId}/reset-code`, owner.headers);
    expect(issued.statusCode, issued.body).toBe(201);
    const { code } = issued.json() as { code: string };
    const heir = await addMember(app, owner.orgId);
    expect((await transfer(owner, heir)).statusCode).toBe(200);

    expect(errorCode(await joinPreview(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await joinAccept(phone, code, NEW_PASSWORD))).toBe('INVITE_INVALID');
    expect((await login(app, phone)).statusCode).toBe(200);
    const row = await prisma.invitation.findFirstOrThrow({ where: { phone, kind: 'PHONE_RESET' } });
    expect(row.revokedAt).not.toBeNull();
  });

  it('yönetici rolüyle e-posta daveti devirden sonra açılmaz ve kabul edilmez; listeden düşer', async () => {
    const owner = await registerOrg(app);
    const heir = await addMember(app, owner.orgId);
    const email = randomEmail('yonetici');
    const invite = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email, name: 'Yeni Yönetici', orgRole: 'ADMIN' });
    expect(invite.statusCode, invite.body).toBe(201);
    const token = tokenOfLink(invite.json().link);
    expect((await transfer(owner, heir)).statusCode).toBe(200);

    expect(errorCode(await app.inject({ url: `${API}/invites/${token}`, remoteAddress: randomIp() }))).toBe('INVITE_INVALID');
    expect(errorCode(await acceptEmailInvite(token))).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { email } })).toBe(0);
    // Bekleyen davetler listesinden düşer (`GET /org/invitations` iptal edilmemişleri listeler).
    expect((await prisma.invitation.findFirstOrThrow({ where: { email, orgId: owner.orgId } })).revokedAt).not.toBeNull();
  });

  it('yönetici rolüyle telefon daveti devirden sonra kabul edilmez', async () => {
    const owner = await registerOrg(app);
    const heir = await addMember(app, owner.orgId);
    const phone = randomTrPhone();
    const invite = await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'Yeni Yönetici', orgRole: 'ADMIN' });
    expect(invite.statusCode, invite.body).toBe(201);
    expect((await transfer(owner, heir)).statusCode).toBe(200);
    expect(errorCode(await joinAccept(phone, invite.json().code, NEW_PASSWORD))).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { phone } })).toBe(0);
  });

  it('eski sahibin üye düzeyindeki daveti geçerli kalır: yönetici de açabilirdi', async () => {
    const owner = await registerOrg(app);
    const heir = await addMember(app, owner.orgId);
    const email = randomEmail('uye');
    const invite = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email, name: 'Yeni Üye', orgRole: 'MEMBER' });
    expect((await transfer(owner, heir)).statusCode).toBe(200);
    const accepted = await acceptEmailInvite(tokenOfLink(invite.json().link));
    expect(accepted.statusCode, accepted.body).toBe(201);
    const member = await prisma.membership.findFirstOrThrow({ where: { orgId: owner.orgId, person: { email } } });
    expect(member.orgRole).toBe('MEMBER');
  });

  it('kabulde üretenin bugünkü yetkisi denetlenir: iptal yolu atlansa da (rolü elle düşürülen yönetici) kod çalışmaz', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const phone = randomTrPhone();
    const invite = await post('/org/members/invite', admin.headers, { kind: 'PHONE_CODE', phone, name: 'Çalışan' });
    expect(invite.statusCode, invite.body).toBe(201);
    // İptal etmeden rol düşer (iptal yolunu unutan gelecekteki bir akışın benzeri).
    await prisma.membership.update({ where: { id: admin.membershipId }, data: { orgRole: 'MEMBER' } });
    expect(errorCode(await joinAccept(phone, invite.json().code, NEW_PASSWORD))).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { phone } })).toBe(0);
  });
});

describe('04-B5: sahiplik yalnız doğrulanmış e-postaya', () => {
  it('doğrulama zorunluyken doğrulanmamış üyeye devir 409 (TR ve EN neden), doğrulayınca geçer; liste emailVerified taşır', async () => {
    const owner = await registerOrg(app);
    const heir = await addMember(app, owner.orgId);
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const listed = async () =>
      ((await app.inject({ url: `${API}/org/members`, headers: owner.headers })).json() as { members: { id: string; emailVerified: boolean }[] }).members.find(
        (m) => m.id === heir.membershipId,
      );
    expect((await listed())?.emailVerified).toBe(false);

    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const denied = await post('/org/transfer-ownership', { ...owner.headers, 'accept-language': 'tr' }, { membershipId: heir.membershipId, password: PASSWORD });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toMatchObject({ code: 'OWNER_REQUIRES_EMAIL', details: { reason: 'EMAIL_NOT_VERIFIED' } });
    expect(denied.json().error.message).toMatch(/doğrulamadı/);
    const en = await app.inject({
      method: 'POST',
      url: `${API}/org/transfer-ownership`,
      remoteAddress: randomIp(),
      headers: { ...(await asWeb(owner)), 'accept-language': 'en' },
      payload: { membershipId: heir.membershipId, password: PASSWORD },
    });
    expect(en.json().error.message).toMatch(/not verified/);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId } })).orgRole).toBe('OWNER');

    await verifyEmail(heir.personId);
    expect((await listed())?.emailVerified).toBe(true);
    expect((await transfer(owner, heir)).statusCode).toBe(200);
  });
});

describe('04-B6: kişi başına günlük giriş tavanı', () => {
  const DAY = RATE_RULES.loginPersonDay;

  it('3 IP ile 30 hatalı deneme günlük kovaya sayılır (15 dakikalık kovalar dolmadan)', async () => {
    const owner = await registerOrg(app);
    for (const ip of [randomIp(), randomIp(), randomIp()]) {
      for (let i = 0; i < RATE_RULES.loginPair.limit; i++) expect((await attempt(owner.email as string, ip)).statusCode).toBe(401);
    }
    expect(await countOf(`login:day:${owner.personId}`)).toBe(30);
    expect(DAY.limit).toBeGreaterThanOrEqual(100);
    expect(DAY.windowSeconds).toBe(24 * 3600);
  });

  it('günlük kova doluyken yeni ağdan doğru şifre de 429; daha önce girilen ağdan (bilinen cihaz) girilir', async () => {
    const owner = await registerOrg(app);
    const home = randomIp();
    expect((await attempt(owner.email as string, home, PASSWORD)).statusCode).toBe(200);
    await fill(`login:day:${owner.personId}`, DAY.limit);
    const fresh = await attempt(owner.email as string, randomIp(), PASSWORD);
    expect(fresh.statusCode).toBe(429);
    expect(errorCode(fresh)).toBe('TOO_MANY_ATTEMPTS');
    expect((await attempt(owner.email as string, home, PASSWORD)).statusCode).toBe(200);
  });

  it('kilit ilk dolduğunda doğrulanmış adrese bilgi postası gider; günde en çok bir kez', async () => {
    const owner = await registerOrg(app);
    await verifyEmail(owner.personId);
    const email = owner.email as string;
    await fill(`login:person:${owner.personId}`, RATE_RULES.loginIdentity.limit);
    expect((await attempt(email, randomIp())).statusCode).toBe(429);
    const sent = await mails(email, 'login_locked');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('/forgot-password');
    expect(sent[0].body).not.toMatch(/reset-password\//);

    // Sonraki pencerede yeniden kilitlenir: iz yazılır, posta yine gitmez.
    await prisma.rateBucket.deleteMany({ where: { key: `login:locked:${owner.personId}` } });
    await fill(`login:person:${owner.personId}`, RATE_RULES.loginIdentity.limit);
    expect((await attempt(email, randomIp())).statusCode).toBe(429);
    expect(await mails(email, 'login_locked')).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'login.locked', target: owner.personId } })).toBe(2);
  });

  it('doğrulanmamış adrese kilit postası gitmez (başkasının adresiyle açılmış hesap posta yağdıramaz)', async () => {
    const owner = await registerOrg(app);
    await fill(`login:person:${owner.personId}`, RATE_RULES.loginIdentity.limit);
    expect((await attempt(owner.email as string, randomIp())).statusCode).toBe(429);
    expect(await mails(owner.email as string, 'login_locked')).toHaveLength(0);
  });

  it('"şifremi unuttum" ile şifre yenilenince kilit kalkar: yeni ağdan girilir', async () => {
    const owner = await registerOrg(app);
    const email = owner.email as string;
    await fill(`login:day:${owner.personId}`, DAY.limit);
    await fill(`login:person:${owner.personId}`, RATE_RULES.loginIdentity.limit);
    expect((await attempt(email, randomIp(), PASSWORD)).statusCode).toBe(429);

    await post('/auth/forgot-password', {}, { identifier: email });
    const mail = (await mails(email, 'password_reset')).at(-1);
    const token = /reset-password\/(\S+)/.exec(mail?.body ?? '')?.[1] as string;
    expect(token).toBeTruthy();
    expect((await post('/auth/reset-password', {}, { token, password: NEW_PASSWORD })).statusCode).toBe(200);
    expect((await attempt(email, randomIp(), NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('yöneticinin koduyla şifre yenileyen e-postasız çalışanın kilidi de kalkar', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    await fill(`login:day:${worker.personId}`, DAY.limit);
    expect((await attempt(phone, randomIp(), PASSWORD)).statusCode).toBe(429);
    const { code } = (await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers)).json() as { code: string };
    expect((await joinAccept(phone, code, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await attempt(phone, randomIp(), NEW_PASSWORD)).statusCode).toBe(200);
  });
});

describe('04-B9: şifre değişti postası', () => {
  it('Profil’den şifre değişince kişinin adresine posta gider; bağlantı yalnız "şifremi unuttum" sayfası', async () => {
    const owner = await registerOrg(app);
    const res = await post('/me/password', owner.headers, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    const sent = await mails(owner.email as string, 'password_changed');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('SellerOnData şifreniz değiştirildi');
    expect(sent[0].body).toContain('/forgot-password');
    expect(sent[0].body).not.toMatch(/reset-password\/|verify-email\//);
  });

  it('bağlantıyla sıfırlamada da posta gider (EN kişiye İngilizce)', async () => {
    const owner = await registerOrg(app, { locale: 'en' });
    const email = owner.email as string;
    await post('/auth/forgot-password', {}, { identifier: email });
    const token = /reset-password\/(\S+)/.exec((await mails(email, 'password_reset')).at(-1)?.body ?? '')?.[1] as string;
    expect((await post('/auth/reset-password', {}, { token, password: NEW_PASSWORD })).statusCode).toBe(200);
    const sent = await mails(email, 'password_changed');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Your SellerOnData password was changed');
  });
});

describe('03-B9: yönetim yazma uçları', () => {
  it('yöneticinin kovası dolunca üye güncelleme, çıkarma, firma ayarı ve davet iptali 429', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const invite = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: randomEmail('iptal'), name: 'X' });
    await fill(`admin:write:${owner.orgId}:${owner.membershipId}`, RATE_RULES.orgAdminWrite.limit);
    const calls = [
      app.inject({ method: 'PATCH', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner), payload: { productRoles: { deciship: 'AUDITOR' } } }),
      app.inject({ method: 'DELETE', url: `${API}/org/members/${member.membershipId}`, headers: await asWeb(owner) }),
      app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name: 'Yeni Ad' } }),
      app.inject({ method: 'DELETE', url: `${API}/org/invitations/${invite.json().invitation.id}`, headers: await asWeb(owner) }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode, res.body).toBe(429);
      expect(errorCode(res)).toBe('TOO_MANY_ATTEMPTS');
    }
    expect(await prisma.membership.count({ where: { id: member.membershipId } })).toBe(1);
  });

  it('kova yapan başınadır: kovasını dolduran yönetici, sahibin onu askıya almasını engelleyemez', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const target = await addMember(app, owner.orgId);
    // Yönetici kendi kovasını sonuna kadar kullanır (ör. ele geçirilmiş oturumla toplu değişiklik).
    await fill(`admin:write:${owner.orgId}:${admin.membershipId}`, RATE_RULES.orgAdminWrite.limit);
    const flood = await app.inject({
      method: 'PATCH',
      url: `${API}/org/members/${target.membershipId}`,
      headers: await asWeb(admin),
      payload: { productRoles: { deciship: 'AUDITOR' } },
    });
    expect(flood.statusCode, flood.body).toBe(429);
    // Sahibin kovası ayrı: yöneticiyi hemen askıya alır.
    const suspend = await app.inject({
      method: 'PATCH',
      url: `${API}/org/members/${admin.membershipId}`,
      headers: await asWeb(owner),
      payload: { status: 'SUSPENDED' },
    });
    expect(suspend.statusCode, suspend.body).toBe(200);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: admin.membershipId } })).status).toBe('SUSPENDED');
  });

  it('başka firmanın üyelik kimliği: kilit beklemeden 404 (satır başka işlemde kilitliyken)', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const foreign = await addMember(app, b.orgId);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    const aWeb = await asWeb(a);
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "platform"."Membership" WHERE "id" = ${foreign.membershipId} FOR UPDATE`;
        markLocked();
        await hold;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await locked;
    let finished = false;
    const pending = app
      .inject({ method: 'PATCH', url: `${API}/org/members/${foreign.membershipId}`, headers: aWeb, payload: { orgRole: 'MEMBER' } })
      .finally(() => (finished = true));
    // İstek ya biter ya da bir bağlantı kilit bekler: hangisi önce olursa. Sabit süre yok, yalnız yoklama.
    let blocked = false;
    while (!finished && !blocked) {
      const waiting = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      blocked = waiting[0].n > 0;
      await new Promise((r) => setImmediate(r));
    }
    release();
    await holder;
    const res = await pending;
    expect(blocked).toBe(false);
    expect(res.statusCode).toBe(404);
  });
});

describe('04-B1: yenileme toleransı olaya bağlı', () => {
  /** Döndürülmüş satırı geçmişe iter (sahte saat yerine veritabanındaki zaman). */
  async function ageRotation(refreshToken: string, seconds: number) {
    await prisma.session.update({ where: { refreshHash: sha256(refreshToken) }, data: { rotatedAt: new Date(Date.now() - seconds * 1000) } });
  }

  it('yanıtı kaybolan yenileme 30 sn sonra eski jetonla tekrarlanınca aile düşmez (varsayılan pencere), hırsızlık izi yazılmaz', async () => {
    delete process.env.REFRESH_REUSE_GRACE_SECONDS;
    const owner = await registerOrg(app);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(200); // yanıt kayboldu
    await ageRotation(owner.refreshToken, 30);
    const retry = await refresh(owner.refreshToken);
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await refresh(retry.json().refreshToken)).statusCode).toBe(200);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: { not: null } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { actorPersonId: owner.personId, action: 'session.reuse_detected' } })).toBe(0);
  });

  it('yeni jeton bir kez kullanıldıktan sonra eski jeton pencere içinde de hırsızlıktır; iz ayırt eder', async () => {
    const owner = await registerOrg(app);
    const second = (await refresh(owner.refreshToken)).json().refreshToken as string;
    expect((await refresh(second)).statusCode).toBe(200);
    const replay = await refresh(owner.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
    const trace = await prisma.auditLog.findFirstOrThrow({ where: { actorPersonId: owner.personId, action: 'session.reuse_detected' } });
    expect(trace.meta).toMatchObject({ successorUsed: true });
  });

  it('çalınmış eski jeton toleransla yeni jeton alsa da meşru sahibin jetonu gelince aile düşer (gidip gelme yok)', async () => {
    const owner = await registerOrg(app);
    const legit = (await refresh(owner.refreshToken)).json().refreshToken as string;
    const thief = await refresh(owner.refreshToken);
    expect(thief.statusCode).toBe(200);
    const caught = await refresh(legit);
    expect(caught.statusCode).toBe(401);
    expect((await refresh(thief.json().refreshToken)).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { personId: owner.personId, revokedAt: null } })).toBe(0);
  });

  it('mobilin tekrarları: iki yanıt kaybolsa da üçüncü deneme geçer; tek geçerli dal kalır, kaybolan halefler hırsızlık sayılır', async () => {
    const owner = await registerOrg(app);
    const lost1 = (await refresh(owner.refreshToken)).json().refreshToken as string;
    const lost2 = (await refresh(owner.refreshToken)).json().refreshToken as string;
    const kept = await refresh(owner.refreshToken);
    expect(kept.statusCode, kept.body).toBe(200);
    const head = kept.json().refreshToken as string;
    // Ailede tek döndürülmemiş satır: iki geçerli dal oluşmaz.
    const family = await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(head) } });
    expect(await prisma.session.count({ where: { familyId: family.familyId, rotatedAt: null, revokedAt: null } })).toBe(1);
    expect(family.parentId).toBe((await prisma.session.findUniqueOrThrow({ where: { refreshHash: sha256(owner.refreshToken) } })).id);
    // Elde kalmış ara halef gelirse (istemci yanıtı sonradan yazdıysa) aile düşer: halefi o değil.
    expect([lost1, lost2].every((t) => t !== head)).toBe(true);
    expect((await refresh(lost1)).statusCode).toBe(401);
    expect((await refresh(head)).statusCode).toBe(401);
  });

  it('pencere dışında, yeni jeton kullanılmamış olsa da eski jeton hırsızlık sayılır; iz süreyi yazar', async () => {
    const owner = await registerOrg(app);
    await refresh(owner.refreshToken);
    await ageRotation(owner.refreshToken, 120);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
    const trace = await prisma.auditLog.findFirstOrThrow({ where: { actorPersonId: owner.personId, action: 'session.reuse_detected' } });
    expect(trace.meta).toMatchObject({ successorUsed: false });
    expect((trace.meta as { ageSeconds: number }).ageSeconds).toBeGreaterThanOrEqual(120);
  });
});

describe('03-B10: destek işleminin müşteriye görünen izi', () => {
  it('firma denetim izinde destek çalışanının adı ve iç gerekçe görünmez, işlemin kendisi görünür', async () => {
    const owner = await registerOrg(app);
    await prisma.auditLog.create({
      data: {
        orgId: owner.orgId,
        action: 'support.subscription_changed',
        target: owner.orgId,
        meta: { product: 'deciship', from: 'ACTIVE', to: 'READ_ONLY', plan: 'early_access', via: 'set', operator: 'Ayşe Destek', reason: 'ödeme gecikti, şüpheli' },
      },
    });
    const res = await app.inject({ url: `${API}/org/audit`, headers: owner.headers });
    const item = (res.json() as { items: { action: string; details: Record<string, unknown> | null; meta: unknown }[] }).items.find(
      (i) => i.action === 'support.subscription_changed',
    );
    expect(item?.details).toMatchObject({ product: 'deciship', to: 'READ_ONLY' });
    expect(item?.details).not.toHaveProperty('operator');
    expect(item?.details).not.toHaveProperty('reason');
    expect(JSON.stringify(res.json())).not.toMatch(/Ayşe Destek|şüpheli/);
  });
});

describe('03-B6: araç bildirimi postasında bağlantı etkisizleşir', () => {
  it('tam genişlikli ve çıplak alan adı tıklanır bağlantıya dönmez (konu, satır, düğme, dipnot)', () => {
    const mail = productNoticeMail(
      'kisi@test.sellerondata.com',
      'tr',
      {
        subject: 'Fatura ｅｖｉｌ．com hatırlatma',
        lines: ['Taşıyıcı: evil-kargo.com/odeme', 'Tutar 12.50 TRY'],
        action: { label: 'Aç kargo.com', path: '/deciship' },
        footer: 'Kaynak: kargo.com',
      },
      { product: 'deciship', url: 'http://localhost:8088/deciship' },
    );
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(/evil\.com|evil-kargo\.com|kargo\.com/);
    }
    expect(mail.text).toContain('evil-kargo. com/odeme');
    expect(mail.text).toContain('12.50 TRY');
    expect(mail.text).toContain('http://localhost:8088/deciship');
  });
});
