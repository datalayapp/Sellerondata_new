import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, SignJWT } from 'jose';
import pg from 'pg';
import { disconnectPrisma, prisma } from '../src/db.ts';
import { assertConfig } from '../src/env.ts';
import { hashJoinCode, normalizeJoinCode, sha256 } from '../src/lib/crypto.ts';
import { dispatchOnce, DISPATCH_GIVE_UP_AFTER_MS, requeueDeadDeliveries } from '../src/lib/dispatcher.ts';
import { ipBucket, normalizeEmail } from '../src/lib/identity.ts';
import { keys } from '../src/lib/keys.ts';
import { runMaintenance, startMaintenance } from '../src/lib/maintenance.ts';
import { RATE_RULES } from '../src/lib/rateLimit.ts';
import { newPassword } from '../src/lib/schemas.ts';
import { refreshSession } from '../src/lib/sessions.ts';
import { MAX_CODE_ATTEMPTS } from '../src/routes/join.ts';
import { SEED_PASSWORD } from '../src/seed.ts';
import {
  addMember,
  API,
  bearer,
  claimsOf,
  cookieHeader,
  errorCode,
  getApp,
  lastMailTo,
  login,
  parseSetCookies,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg,
  webHeaders,
  type Ctx, asWeb, webHeadersFrom, isOrgWrite } from './helpers.ts';
import { SUPER_URL, TEST_DB_NAME } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const META = { ip: '10.9.9.9', userAgent: null };

// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });
const patchMember = async (actor: Ctx, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `${API}/org/members/${id}`, headers: await asWeb(actor), payload });
const joinAccept = (phone: string, code: string, password: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, ip = randomIp()) =>
  app.inject({ method: 'POST', url: `${API}/auth/join/accept`, remoteAddress: ip, headers, payload: { phone, code, password, client: 'mobile', ...extra } });
const joinPreview = (phone: string, code: string, headers: Record<string, string> = {}, ip = randomIp(), extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}/auth/join/preview`, remoteAddress: ip, headers, payload: { phone, code, ...extra } });
const phoneInvite = (actor: Ctx, phone: string, over: Record<string, unknown> = {}) =>
  post('/org/members/invite', actor.headers, { kind: 'PHONE_CODE', phone, name: 'Çalışan', ...over });

async function phoneWorker(owner: Ctx, over: Record<string, unknown> = {}) {
  const phone = randomTrPhone();
  const worker = await addMember(app, owner.orgId, { email: null, phone, deciship: 'MEASURE', ...over });
  return { worker, phone };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('K1: şifre kodu üretildikten sonra rol değişimi', () => {
  async function codeFor(owner: Ctx, worker: Ctx) {
    const res = await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers);
    expect(res.statusCode).toBe(201);
    return res.json().code as string;
  }

  it('kişi ADMIN yapılırsa kod ölür: kodu üreten yönetici hesabı alamaz', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const { worker, phone } = await phoneWorker(owner);
    const code = await codeFor(admin, worker);
    expect((await patchMember(owner, worker.membershipId, { orgRole: 'ADMIN' })).statusCode).toBe(200);
    expect(errorCode(await joinPreview(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await joinAccept(phone, code, 'ElGecirme12345!'))).toBe('INVITE_INVALID');
    expect((await login(app, phone, 'ElGecirme12345!')).statusCode).toBe(401);
  });

  it('rol geri alınsa da eski kod dirilmez', async () => {
    const owner = await registerOrg(app);
    const { worker, phone } = await phoneWorker(owner);
    const code = await codeFor(owner, worker);
    await patchMember(owner, worker.membershipId, { orgRole: 'ADMIN' });
    await patchMember(owner, worker.membershipId, { orgRole: 'MEMBER' });
    expect(errorCode(await joinAccept(phone, code, 'ElGecirme12345!'))).toBe('INVITE_INVALID');
  });

  it('kabulde rol denetlenir: veritabanından değişmiş rolde de kod ölür', async () => {
    const owner = await registerOrg(app);
    const { worker, phone } = await phoneWorker(owner);
    const code = await codeFor(owner, worker);
    await prisma.membership.update({ where: { id: worker.membershipId }, data: { orgRole: 'ADMIN' } });
    expect(errorCode(await joinPreview(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await joinAccept(phone, code, 'ElGecirme12345!'))).toBe('INVITE_INVALID');
  });

  it('sahiplik devrinde hedefin kodu ölür (devir e-postalı hedefe; sonra e-posta silinse de)', async () => {
    const owner = await registerOrg(app);
    const { worker, phone } = await phoneWorker(owner);
    const code = await codeFor(owner, worker);
    await prisma.person.update({ where: { id: worker.personId }, data: { email: randomEmail() } });
    const transfer = await post('/org/transfer-ownership', owner.headers, { membershipId: worker.membershipId, password: PASSWORD });
    expect(transfer.statusCode).toBe(200);
    const row = await prisma.invitation.findFirstOrThrow({ where: { targetPersonId: worker.personId, kind: 'PHONE_RESET' } });
    expect(row.revokedAt).not.toBeNull();
    await prisma.person.update({ where: { id: worker.personId }, data: { email: null } });
    expect(errorCode(await joinAccept(phone, code, 'ElGecirme12345!'))).toBe('INVITE_INVALID');
  });
});

describe('B2: resend kodu bilen yöneticiyi kaydeder', () => {
  it('kodu yeniden üreten ADMIN askıya alınınca kod ölür', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const phone = randomTrPhone();
    const invite = await phoneInvite(owner, phone);
    const id = invite.json().invitation.id;
    const resent = await post(`/org/invitations/${id}/resend`, admin.headers);
    expect(resent.statusCode).toBe(200);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id } })).invitedById).toBe(admin.membershipId);
    await patchMember(owner, admin.membershipId, { status: 'SUSPENDED' });
    expect(errorCode(await joinPreview(phone, resent.json().code))).toBe('INVITE_INVALID');
  });
});

describe('B3: telefon yalnız kodlu kabulle bağlanır', () => {
  it('PATCH /me telefon ekleyemez ve değiştiremez', async () => {
    const owner = await registerOrg(app);
    const add = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { phone: randomTrPhone(), currentPassword: PASSWORD } });
    expect(add.statusCode).toBe(403);
    expect(errorCode(add)).toBe('PHONE_CHANGE_NOT_ALLOWED');
    const person = await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } });
    expect(person.phone).toBeNull();

    const { worker, phone } = await phoneWorker(owner);
    const change = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: worker.headers, payload: { phone: randomTrPhone(), currentPassword: PASSWORD } });
    expect(errorCode(change)).toBe('PHONE_CHANGE_NOT_ALLOWED');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).phone).toBe(phone);
    // Aynı numarayı göndermek değişiklik değildir.
    const same = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: worker.headers, payload: { phone, name: 'Aynı' } });
    expect(same.statusCode).toBe(200);
  });

  it('doğrulanmış e-postası olan kişi telefonu kaldırabilir', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId, { phone: randomTrPhone() });
    // Doğrulanmamış adres yetmez (emailVerification.test.ts): tek giriş yolu yanlış yazılmış adrese kalmasın.
    await prisma.person.update({ where: { id: member.personId }, data: { emailVerifiedAt: new Date() } });
    const res = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: member.headers, payload: { phone: null, currentPassword: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().me.person.phone).toBeNull();
  });

  // KABUL EDİLEN RİSK, SMS ile kapanır (ARCHITECTURE §11): kod sahibinin numaranın gerçek sahibi olduğu kanıtlanamıyor. Bu test
  // davranışı sabitler, "güvenli" demez. Hesap ele geçirme değildir; azaltmalar review2.test.ts'te.
  it('telefonsuz hesap oturumla kodu kabul eder: telefon ona yazılır, üyelik eklenir, yeni kişi açılmaz (kabul edilen risk, SMS ile kapanır)', async () => {
    const owner = await registerOrg(app);
    const other = await registerOrg(app);
    const phone = randomTrPhone();
    const { code } = (await phoneInvite(owner, phone, { productRoles: { deciship: 'ACCOUNTING' } })).json();

    // Bağlamak açıkça seçilmezse oturum yok sayılır (2026-11-13).
    expect((await joinPreview(phone, code, other.headers)).json()).toMatchObject({ linksCurrentAccount: false });
    const pv = await joinPreview(phone, code, other.headers, undefined, { linkCurrentAccount: true });
    expect(pv.json()).toMatchObject({ personExists: false, purpose: 'JOIN', linksCurrentAccount: true });

    const wrong = await joinAccept(phone, code, 'YanlisSifre123', { linkCurrentAccount: true }, other.headers);
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: other.personId } })).phone).toBeNull();

    const ok = await joinAccept(phone, code, PASSWORD, { linkCurrentAccount: true }, other.headers);
    expect(ok.statusCode).toBe(200);
    expect(claimsOf(ok.json().accessToken)).toMatchObject({ sub: other.personId, org: owner.orgId });
    expect(ok.json().refreshToken).toBeUndefined();
    expect((await prisma.person.findUniqueOrThrow({ where: { id: other.personId } })).phone).toBe(phone);
    expect(await prisma.person.count({ where: { phone } })).toBe(1);
    expect((await login(app, phone)).statusCode).toBe(200);
  });

  it('oturum açıkken bağlama seçilmeden kodla katılan yeni kişi olur; açık hesaba dokunulmaz (2026-11-13)', async () => {
    const owner = await registerOrg(app);
    const signedIn = await registerOrg(app);
    const phone = randomTrPhone();
    const { code } = (await phoneInvite(owner, phone)).json();
    const ok = await joinAccept(phone, code, PASSWORD, { name: 'Yeni Çalışan' }, signedIn.headers);
    expect(ok.statusCode).toBe(201);
    const newcomer = await prisma.person.findFirstOrThrow({ where: { phone } });
    expect(newcomer.id).not.toBe(signedIn.personId);
    expect(claimsOf(ok.json().accessToken)).toMatchObject({ sub: newcomer.id, org: owner.orgId });
    expect((await prisma.person.findUniqueOrThrow({ where: { id: signedIn.personId } })).phone).toBeNull();
  });

  it('telefonu olan hesap başka numaranın kodunu kabul edemez; numara başkasınınsa da', async () => {
    const owner = await registerOrg(app);
    const { worker } = await phoneWorker(owner);
    const phone = randomTrPhone();
    const { code } = (await phoneInvite(owner, phone)).json();
    expect(errorCode(await joinAccept(phone, code, PASSWORD, { linkCurrentAccount: true }, worker.headers))).toBe('INVITE_WRONG_ACCOUNT');

    const stranger = await registerOrg(app);
    const taken = await phoneWorker(owner);
    const third = await registerOrg(app);
    const inv = (await phoneInvite(third, taken.phone)).json();
    expect(errorCode(await joinAccept(taken.phone, inv.code, PASSWORD, { linkCurrentAccount: true }, stranger.headers))).toBe('INVITE_WRONG_ACCOUNT');
  });
});

describe('O4: firma başına telefon daveti', () => {
  it('yeni firma sıkı sınırda, personExists taraması daralır', async () => {
    const owner = await registerOrg(app);
    let last = await phoneInvite(owner, randomTrPhone());
    for (let i = 0; i < RATE_RULES.phoneInviteNewOrg.limit; i++) last = await phoneInvite(owner, randomTrPhone());
    expect(last.statusCode).toBe(429);
  });

  it('eski firmada sınır daha geniş', async () => {
    const owner = await registerOrg(app);
    await prisma.organization.update({ where: { id: owner.orgId }, data: { createdAt: new Date(Date.now() - 40 * 3600_000) } });
    for (let i = 0; i < RATE_RULES.phoneInviteNewOrg.limit + 2; i++) {
      expect((await phoneInvite(owner, randomTrPhone())).statusCode).toBe(201);
    }
    await prisma.rateBucket.update({ where: { key: `invite:phone:${owner.orgId}` }, data: { count: RATE_RULES.phoneInvite.limit } });
    expect((await phoneInvite(owner, randomTrPhone())).statusCode).toBe(429);
  });
});

describe('O5: davetle şifre denemesi', () => {
  it('mevcut şifre denemeleri login kovasını doldurur: yeni davetle sınırsız tahmin yok', async () => {
    const firmA = await registerOrg(app);
    const { phone, worker } = await phoneWorker(firmA);
    const attacker = await registerOrg(app);
    await prisma.organization.update({ where: { id: attacker.orgId }, data: { createdAt: new Date(Date.now() - 40 * 3600_000) } });
    const bucket = `login:person:${worker.personId}`;
    await prisma.rateBucket.upsert({
      where: { key: bucket },
      create: { key: bucket, count: RATE_RULES.loginIdentity.limit, windowEnd: new Date(Date.now() + 600_000) },
      update: { count: RATE_RULES.loginIdentity.limit, windowEnd: new Date(Date.now() + 600_000) },
    });
    const { code } = (await phoneInvite(attacker, phone)).json();
    const res = await joinAccept(phone, code, 'Tahmin12345!');
    expect(res.statusCode).toBe(429);
    expect(worker.personId).toBeTruthy();
  });

  it('bir kabul denemesi login kovasına yazılır', async () => {
    const firmA = await registerOrg(app);
    const { phone, worker } = await phoneWorker(firmA);
    const attacker = await registerOrg(app);
    const { code } = (await phoneInvite(attacker, phone)).json();
    const key = `login:person:${worker.personId}`;
    const before = (await prisma.rateBucket.findUnique({ where: { key } }))?.count ?? 0;
    await joinAccept(phone, code, 'Tahmin12345!');
    expect((await prisma.rateBucket.findUnique({ where: { key } }))?.count).toBe(before + 1);
  });

  it('resend hakkı sıfırlamaz; hak bittiyse resend reddeder, yeni davet gerekir', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { code, invitation } = (await phoneInvite(owner, phone)).json();
    const bad = code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`;
    await joinPreview(phone, bad);
    const resent = await post(`/org/invitations/${invitation.id}/resend`, owner.headers);
    expect(resent.json().invitation.attempts).toBe(1);
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) await joinPreview(phone, bad);
    const exhausted = await post(`/org/invitations/${invitation.id}/resend`, owner.headers);
    expect(exhausted.statusCode).toBe(409);
    expect(errorCode(exhausted)).toBe('INVITE_ATTEMPTS_EXHAUSTED');
  });
});

describe('O6: hız sınırı kovaları', () => {
  it('geniş kova doluysa dar kovaya yazılmaz: dolu IP kurbanın kişi kovasını tüketemez', async () => {
    const ip = randomIp();
    const email = randomEmail('kurban');
    await prisma.rateBucket.create({ data: { key: `login:ip:${ip}`, count: RATE_RULES.loginIp.limit, windowEnd: new Date(Date.now() + 600_000) } });
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, remoteAddress: ip, payload: { identifier: email, password: 'Yanlis12345', client: 'mobile' } });
    expect(res.statusCode).toBe(429);
    expect(await prisma.rateBucket.count({ where: { key: { contains: sha256(email).slice(0, 32) } } })).toBe(0);
  });

  it('bakım açılışta da çalışır', async () => {
    const key = `eski:${randomIp()}`;
    await prisma.rateBucket.create({ data: { key, count: 1, windowEnd: new Date(Date.now() - 1000) } });
    const stop = startMaintenance();
    try {
      for (let i = 0; i < 50 && (await prisma.rateBucket.count({ where: { key } })) > 0; i++) await sleep(50);
      expect(await prisma.rateBucket.count({ where: { key } })).toBe(0);
    } finally {
      stop();
    }
  });
});

describe('O7: IPv6 /64', () => {
  it('aynı /64 tek kova; IPv4 ve eşlenmiş IPv4 olduğu gibi', () => {
    expect(ipBucket('2001:db8:1:2::a')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(ipBucket('2001:db8:1:2::a')).not.toBe(ipBucket('2001:db8:1:3::a'));
    expect(ipBucket('2001:DB8:0001:0002::a')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('10.1.2.3')).toBe('10.1.2.3');
    expect(ipBucket('::ffff:10.1.2.3')).toBe('10.1.2.3');
  });

  it('/64 içinde adres değiştirerek giriş sınırı aşılamaz', async () => {
    const prefix = `2001:db8:${Math.floor(Math.random() * 65535).toString(16)}:1`;
    let last;
    for (let i = 0; i <= RATE_RULES.loginIp.limit; i++) {
      last = await app.inject({
        method: 'POST',
        url: `${API}/auth/login`,
        remoteAddress: `${prefix}::${(i + 1).toString(16)}`,
        payload: { identifier: randomEmail('tara'), password: 'x', client: 'mobile' },
      });
    }
    expect(last?.statusCode).toBe(429);
  });
});

describe('O8: DEAD kurtarma', () => {
  beforeEach(async () => {
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
  });
  const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

  it('uzun kesintide olay düşmez: pencere dolana kadar yeniden denenir', async () => {
    await registerOrg(app);
    // Eski üst sınır (20 deneme, ~10 saat) aşılmış ama pencere dolmamış.
    await prisma.outboxDelivery.updateMany({ data: { attempts: 40, createdAt: new Date(Date.now() - 10 * 3600_000) } });
    const result = await dispatchOnce({ fetch: failing });
    expect(result.dead).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(await prisma.outboxDelivery.count({ where: { status: 'DEAD' } })).toBe(0);
  });

  it('pencere dolunca DEAD, requeue geri alır ve yeni pencere başlar', async () => {
    await registerOrg(app);
    await prisma.outboxDelivery.updateMany({ data: { createdAt: new Date(Date.now() - DISPATCH_GIVE_UP_AFTER_MS - 1000) } });
    const warnings: string[] = [];
    const log = { warn: (_o: unknown, m?: string) => warnings.push(m ?? ''), error: (_o: unknown, m?: string) => warnings.push(m ?? '') };
    const result = await dispatchOnce({ fetch: failing, log });
    expect(result.dead).toBeGreaterThan(0);
    expect(warnings.length).toBeGreaterThan(0);

    const requeued = await requeueDeadDeliveries();
    expect(requeued).toBe(result.dead);
    expect(await prisma.outboxDelivery.count({ where: { status: 'DEAD' } })).toBe(0);
    const ok = await dispatchOnce({ fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch });
    expect(ok.delivered).toBe(result.dead);
  });

  it('bakım DEAD için uyarır, silmeden önce denetim izine işaret bırakır', async () => {
    await registerOrg(app);
    await prisma.outboxDelivery.updateMany({ data: { status: 'DEAD' } });
    const lines: string[] = [];
    const log = { warn: (_o: unknown, m?: string) => lines.push(m ?? ''), error: () => {} };
    await runMaintenance(new Date(), log);
    expect(lines.some((l) => l.includes('DEAD'))).toBe(true);
    expect(await prisma.outbox.count()).toBeGreaterThan(0);

    const total = await prisma.outbox.count();
    await prisma.outbox.updateMany({ data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    await runMaintenance(new Date(), log);
    expect(await prisma.outbox.count()).toBe(0);
    const mark = await prisma.auditLog.findFirstOrThrow({ where: { action: 'outbox.dead_purged' }, orderBy: { createdAt: 'desc' } });
    expect((mark.meta as { count: number }).count).toBe(total);
  });
});

describe('O9: e-postasız OWNER', () => {
  it('devir e-postası olmayan kişiye yapılamaz', async () => {
    const owner = await registerOrg(app);
    const { worker } = await phoneWorker(owner);
    const res = await post('/org/transfer-ownership', owner.headers, { membershipId: worker.membershipId, password: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('OWNER_REQUIRES_EMAIL');
    expect(await prisma.membership.count({ where: { id: owner.membershipId, orgRole: 'OWNER' } })).toBe(1);
  });

  it('OWNER e-postasını silemez; e-postasız kişi firma açamaz', async () => {
    const owner = await registerOrg(app);
    await prisma.person.update({ where: { id: owner.personId }, data: { phone: randomTrPhone() } });
    const del = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { email: null, currentPassword: PASSWORD } });
    expect(del.statusCode).toBe(409);
    expect(errorCode(del)).toBe('OWNER_REQUIRES_EMAIL');

    const other = await registerOrg(app);
    const { worker } = await phoneWorker(other);
    const create = await post('/orgs', worker.headers, { name: 'Telefonlu', country: 'TR' });
    expect(create.statusCode).toBe(409);
    expect(errorCode(create)).toBe('OWNER_REQUIRES_EMAIL');
    const me = (await app.inject({ url: `${API}/me`, headers: worker.headers })).json();
    expect(me.account).toMatchObject({ canCreateOrg: false, createOrgRequiresEmail: true });
  });

  it('e-postasız tek firmalı OWNER (eski veri) için kurtarma yolu yok der', async () => {
    const owner = await registerOrg(app);
    await prisma.person.update({ where: { id: owner.personId }, data: { email: null, phone: randomTrPhone() } });
    const me = (await app.inject({ url: `${API}/me`, headers: owner.headers })).json();
    expect(me.account.passwordRecovery).toBe('none');
  });
});

describe('O10: davet spam', () => {
  it('konu serbest metin taşımaz, gövdede kaçışlı', async () => {
    // Adlarda bağlantı artık yasak (02-B4, A2): serbest metin bağlantısız yazılır; konu yine adı taşımamalı.
    const owner = await registerOrg(app, { orgName: 'Bedava<b>Para</b> kotu.example', name: 'Dolandırıcı' });
    // Davet postası yalnız e-postası doğrulanmış davet edenden gider (02-B4).
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const email = randomEmail('alici');
    const res = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email, name: 'X' });
    expect(res.statusCode).toBe(201);
    const mail = await lastMailTo(email);
    expect(mail?.subject).not.toContain('Bedava');
    expect(mail?.subject).not.toContain('Dolandırıcı');
    expect(mail?.body).toContain('Bedava');
  });

  it('alıcı başına sınır: aşınca posta gitmez, davet ve bağlantı çalışır (kurban engellenemez)', async () => {
    const email = randomEmail('spam');
    const owners = await Promise.all(Array.from({ length: RATE_RULES.inviteRecipient.limit + 1 }, () => registerOrg(app)));
    // Davet postası yalnız e-postası doğrulanmış davet edenden gider (02-B4).
    await prisma.person.updateMany({ where: { id: { in: owners.map((o) => o.personId) } }, data: { emailVerifiedAt: new Date() } });
    const results = [];
    for (const owner of owners) results.push(await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email, name: 'X' }));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(results.at(-1)?.json().mailSent).toBe(false);
    expect(results.at(-1)?.json().link).toContain('/invite/');
    expect(results[0].json().mailSent).toBe(true);
    await lastMailTo(email);
    expect(await prisma.mailLog.count({ where: { to: email, template: 'invitation' } })).toBe(RATE_RULES.inviteRecipient.limit);
  });
});

describe('O11: saklama süresi geçmiş abonelik', () => {
  it('me jetonla aynı kuralı uygular', async () => {
    const owner = await registerOrg(app);
    await prisma.subscription.update({
      where: { orgId_product: { orgId: owner.orgId, product: 'deciship' } },
      data: { status: 'CANCELED', deleteAfter: new Date(Date.now() - 1000) },
    });
    const res = await login(app, owner.email as string);
    expect(claimsOf(res.json().accessToken).prod.deciship).toBeUndefined();
    const deciship = res.json().me.products.find((p: { key: string }) => p.key === 'deciship');
    expect(deciship).toMatchObject({ subscription: null, role: null, permissions: [] });
  });
});

describe('O12: kod biçimi', () => {
  it('biçimi geçersiz kod hak yemez', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { invitation } = (await phoneInvite(owner, phone)).json();
    for (const bad of ['ABC', 'ÇÇÇÇÇÇÇÇ', 'A'.repeat(20)]) {
      expect(errorCode(await joinPreview(phone, bad))).toBe('INVITE_INVALID');
      expect(errorCode(await joinAccept(phone, bad, 'Sifre1234567'))).toBe('INVITE_INVALID');
    }
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).attempts).toBe(0);
  });

  it('Türkçe İ ve ı 1 sayılır', () => {
    expect(normalizeJoinCode('AİBıCİDL')).toBe('A1B1C1D1');
    expect(normalizeJoinCode('aibicidl')).toBe('A1B1C1D1');
  });
});

describe('O13: eski sekme başka firmaya yazamaz', () => {
  async function webSession() {
    const a = await registerOrg(app);
    const member = await addMember(app, a.orgId, { orgRole: 'ADMIN', deciship: 'ADMIN' });
    const res = await login(app, member.email as string, PASSWORD, 'web');
    const cookies = parseSetCookies(res);
    return { a, member, cookie: cookieHeader({ sod_at: cookies.sod_at }), orgId: a.orgId };
  }

  it('çerezli firma yazmasında X-SOD-Org zorunlu ve jetonla uyuşmalı', async () => {
    const { cookie, orgId } = await webSession();
    const noHeader = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: webHeaders(cookie), payload: { name: 'Yeni Ad' } });
    expect(noHeader.statusCode).toBe(409);
    expect(errorCode(noHeader)).toBe('ORG_MISMATCH');

    // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
    const wrong = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: { ...webHeaders(cookie), 'x-sod-org': 'baska-firma', 'accept-language': 'tr' }, payload: { name: 'Yeni Ad' } });
    expect(errorCode(wrong)).toBe('ORG_MISMATCH');
    expect(wrong.json().error.message).toMatch(/yenile/i);

    const ok = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: { ...webHeaders(cookie), 'x-sod-org': orgId }, payload: { name: 'Yeni Ad' } });
    expect(ok.statusCode).toBe(200);
  });

  it('senaryo: sekme A firmasında açık, öbür sekme B\'ye geçti, A sekmesinin yazması reddedilir', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const person = await addMember(app, a.orgId, { orgRole: 'ADMIN' });
    await prisma.membership.create({ data: { personId: person.personId, orgId: b.orgId, orgRole: 'ADMIN' } });
    const first = parseSetCookies(await login(app, person.email as string, PASSWORD, 'web'));
    const switched = await app.inject({
      method: 'POST',
      url: `${API}/auth/switch-org`,
      headers: webHeaders(cookieHeader({ sod_at: first.sod_at })),
      payload: { orgId: b.orgId },
    });
    const cookie = cookieHeader({ sod_at: parseSetCookies(switched).sod_at });
    const staleTab = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: { ...webHeaders(cookie), 'x-sod-org': a.orgId },
      payload: { kind: 'EMAIL', email: randomEmail(), name: 'X' },
    });
    expect(errorCode(staleTab)).toBe('ORG_MISMATCH');
    expect(await prisma.invitation.count({ where: { orgId: b.orgId } })).toBe(0);
  });

  it('Bearer ve okuma muaf; firmaya bağlı olmayan çerezli yazma etkilenmez', async () => {
    const { cookie, member } = await webSession();
    const bearerWrite = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(member), payload: {} });
    expect(errorCode(bearerWrite)).not.toBe('ORG_MISMATCH');
    expect((await app.inject({ url: `${API}/org`, headers: { cookie } })).statusCode).toBe(200);
    const me = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: webHeaders(cookie), payload: { name: 'Ad' } });
    expect(me.statusCode).toBe(200);
  });
});

describe('(a) oturum iptali ile döndürme yarışı', () => {
  async function holdRotation(refreshToken: string) {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let rotatedSignal = () => {};
    const rotated = new Promise<void>((r) => (rotatedSignal = r));
    const done = prisma.$transaction(async (tx) => {
      const out = await refreshSession(tx, refreshToken, META);
      rotatedSignal();
      await gate;
      return out;
    });
    await rotated;
    return { release, done };
  }

  it('şifre değişimi sürerken döndürülen oturum hayatta kalmaz', async () => {
    const owner = await registerOrg(app);
    const other = (await login(app, owner.email as string)).json();
    const { release, done } = await holdRotation(other.refreshToken);
    const change = post('/me/password', owner.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' });
    await sleep(250);
    release();
    const out = await done;
    expect((await change).statusCode).toBe(200);
    expect(out.kind).toBe('rotated');
    const again = await post('/auth/refresh', {}, { refreshToken: (out as { refreshToken: string }).refreshToken });
    expect(again.statusCode).toBe(401);
  });

  it('firması olmayan kişide de şifre değişimi sürerken döndürülen oturum hayatta kalmaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await prisma.membership.delete({ where: { id: member.membershipId } });
    const other = (await login(app, member.email as string)).json();
    const { release, done } = await holdRotation(other.refreshToken);
    const change = post('/me/password', member.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' });
    await sleep(250);
    release();
    const out = await done;
    expect((await change).statusCode).toBe(200);
    const again = await post('/auth/refresh', {}, { refreshToken: (out as { refreshToken: string }).refreshToken });
    expect(again.statusCode).toBe(401);
  });

  it('çıkış sürerken döndürülen oturum hayatta kalmaz', async () => {
    const owner = await registerOrg(app);
    const { release, done } = await holdRotation(owner.refreshToken);
    const logout = post('/auth/logout', {}, { refreshToken: owner.refreshToken });
    await sleep(250);
    release();
    const out = await done;
    expect((await logout).statusCode).toBe(200);
    const again = await post('/auth/refresh', {}, { refreshToken: (out as { refreshToken: string }).refreshToken });
    expect(again.statusCode).toBe(401);
  });

  it('şifre kodu kabulü sürerken de oturum hayatta kalmaz', async () => {
    const owner = await registerOrg(app);
    const { worker, phone } = await phoneWorker(owner);
    const { code } = (await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers)).json();
    const { release, done } = await holdRotation(worker.refreshToken);
    const accept = joinAccept(phone, code, 'YeniIsciSifre1!');
    await sleep(250);
    release();
    const out = await done;
    expect((await accept).statusCode).toBe(200);
    const again = await post('/auth/refresh', {}, { refreshToken: (out as { refreshToken: string }).refreshToken });
    expect(again.statusCode).toBe(401);
  });
});

describe('(b) firma değişimi ile döndürme yarışı', () => {
  it('döndürme sırasında yapılan firma değişimi kaybolmaz', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const person = await addMember(app, a.orgId, { deciship: 'AUDITOR' });
    await prisma.membership.create({ data: { personId: person.personId, orgId: b.orgId } });

    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let signal = () => {};
    const rotated = new Promise<void>((r) => (signal = r));
    const hold = prisma.$transaction(async (tx) => {
      const out = await refreshSession(tx, person.refreshToken, META);
      signal();
      await gate;
      return out;
    });
    await rotated;
    const sw = app.inject({ method: 'POST', url: `${API}/auth/switch-org`, headers: person.headers, payload: { orgId: b.orgId } });
    await sleep(250);
    release();
    const out = (await hold) as { refreshToken: string };
    const swRes = await sw;
    expect(swRes.statusCode).toBe(200);
    expect(swRes.json().activeOrgId).toBe(b.orgId);
    const next = await post('/auth/refresh', {}, { refreshToken: out.refreshToken });
    expect(next.statusCode).toBe(200);
    expect(claimsOf(next.json().accessToken).org).toBe(b.orgId);
  });
});

describe('(c) 500 üretmeyen girdiler', () => {
  it('eşlenmemiş vekil karakterli ad 400', async () => {
    const payload = `{"orgName":"Firma \\ud800 Ad","name":"Ali","email":"${randomEmail()}","password":"${PASSWORD}","client":"mobile"}`;
    const res = await app.inject({ method: 'POST', url: `${API}/auth/register`, remoteAddress: randomIp(), headers: { 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(400);
    const owner = await registerOrg(app);
    const patch = await app.inject({
      method: 'PATCH',
      url: `${API}/org`,
      headers: { ...(await asWeb(owner)), 'content-type': 'application/json' },
      payload: '{"name":"Ad \\udc00"}',
    });
    expect(patch.statusCode).toBe(400);
  });

  it('çok büyük sayfa 500 üretmez: boş sayfa döner', async () => {
    const owner = await registerOrg(app);
    const res = await app.inject({ url: `${API}/org/audit?page=9007199254740991&pageSize=200`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('eşzamanlı e-posta ve telefon silme: 500 yok, en az bir kimlik kalır', async () => {
    const owner = await registerOrg(app);
    for (let i = 0; i < 5; i++) {
      const member = await addMember(app, owner.orgId, { phone: randomTrPhone() });
      // İki silme de tek başına geçerli olsun (telefon ancak doğrulanmış e-postayla kaldırılır): yarış gerçekten sınansın.
      await prisma.person.update({ where: { id: member.personId }, data: { emailVerifiedAt: new Date() } });
      const results = await Promise.all([
        app.inject({ method: 'PATCH', url: `${API}/me`, headers: member.headers, payload: { email: null, currentPassword: PASSWORD } }),
        app.inject({ method: 'PATCH', url: `${API}/me`, headers: member.headers, payload: { phone: null, currentPassword: PASSWORD } }),
      ]);
      expect(results.map((r) => r.statusCode).every((c) => c < 500)).toBe(true);
      const person = await prisma.person.findUniqueOrThrow({ where: { id: member.personId } });
      expect(person.email !== null || person.phone !== null).toBe(true);
    }
  });
});

describe('(d) Postgres UTC dışındayken süre', () => {
  const superClient = async () => {
    const url = new URL(SUPER_URL);
    url.pathname = `/${TEST_DB_NAME}`;
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  afterAll(async () => {
    const c = await superClient();
    await c.query(`ALTER ROLE sod_platform IN DATABASE "${TEST_DB_NAME}" RESET timezone`);
    await c.end();
    await disconnectPrisma();
  });

  it('süresi dolmuş kod, oturum saat dilimi ne olursa olsun geçersiz; geçerli kod geçerli', async () => {
    const c = await superClient();
    await c.query(`ALTER ROLE sod_platform IN DATABASE "${TEST_DB_NAME}" SET timezone = 'America/New_York'`);
    await c.end();
    await disconnectPrisma();

    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { code, invitation } = (await phoneInvite(owner, phone)).json();
    await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 3600_000) } });
    expect(errorCode(await joinPreview(phone, code))).toBe('INVITE_INVALID');

    const phone2 = randomTrPhone();
    const second = (await phoneInvite(owner, phone2)).json();
    expect((await joinPreview(phone2, second.code)).statusCode).toBe(200);

    // Tokyo: geçerli süre kısalmamalı.
    const c2 = await superClient();
    await c2.query(`ALTER ROLE sod_platform IN DATABASE "${TEST_DB_NAME}" SET timezone = 'Asia/Tokyo'`);
    await c2.end();
    await disconnectPrisma();
    const phone3 = randomTrPhone();
    const third = (await phoneInvite(owner, phone3)).json();
    await prisma.invitation.update({ where: { id: third.invitation.id }, data: { expiresAt: new Date(Date.now() + 3600_000) } });
    expect((await joinPreview(phone3, third.code)).statusCode).toBe(200);
  });
});

describe('(e) dağıtıcı kira koruması', () => {
  beforeEach(async () => {
    await prisma.outboxDelivery.deleteMany({});
    await prisma.outbox.deleteMany({});
  });

  it('geç gelen hata DELIVERED kaydını bozmaz', async () => {
    await registerOrg(app);
    await prisma.outboxDelivery.updateMany({ data: { attempts: 500, createdAt: new Date(Date.now() - 400 * 3600_000) } });
    const impl = (async () => {
      // Kira doldu, başka kopya teslim etti; bu kopyanın isteği sonra hata verir.
      await prisma.outboxDelivery.updateMany({ data: { status: 'DELIVERED', deliveredAt: new Date(), attempts: { increment: 1 } } });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await dispatchOnce({ fetch: impl });
    const rows = await prisma.outboxDelivery.findMany();
    expect(rows.every((r) => r.status === 'DELIVERED' && r.lastError === null)).toBe(true);
  });
});

describe('küçükler', () => {
  afterEach(() => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    process.env.COOKIE_SECURE = '';
  });

  it('İ içeren e-posta', async () => {
    expect(normalizeEmail('ALİ@Örnek.com'.replace('Ö', 'O'))).toBe('ali@ornek.com');
    const local = `ali${Date.now()}`;
    const owner = await registerOrg(app, { email: `${local.toUpperCase().replace('I', 'İ')}@test.sellerondata.com` });
    const person = await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } });
    expect(person.email).toBe(`${local}@test.sellerondata.com`);
    expect((await login(app, `${local.toUpperCase().replace('I', 'İ')}@test.sellerondata.com`)).statusCode).toBe(200);
  });

  it('ayar doğrulaması: bozuk boolean ve sayı, üretimde COOKIE_SECURE=false', () => {
    const saved = { ...process.env };
    try {
      process.env.REGISTRATION_ENABLED = 'belki';
      expect(() => assertConfig()).toThrow(/REGISTRATION_ENABLED/);
      process.env.REGISTRATION_ENABLED = 'true';
      process.env.TRUST_PROXY_HOPS = 'bir';
      expect(() => assertConfig()).toThrow(/TRUST_PROXY_HOPS/);
      process.env.TRUST_PROXY_HOPS = '0';
      assertConfig();
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://a:b@c/d';
      process.env.ACCOUNT_CODE_PEPPER = 'x'.repeat(40);
      process.env.COOKIE_SECURE = 'false';
      expect(() => assertConfig()).toThrow(/COOKIE_SECURE/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('üretimde kod biberi zorunlu', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://a:b@c/d';
      delete process.env.ACCOUNT_CODE_PEPPER;
      expect(() => assertConfig()).toThrow(/ACCOUNT_CODE_PEPPER/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('EMAIL_VERIFICATION_REQUIRED tüm oturum veren yollarda', async () => {
    const owner = await registerOrg(app);
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const refreshed = await post('/auth/refresh', {}, { refreshToken: owner.refreshToken });
    expect(refreshed.statusCode).toBe(403);
    expect(errorCode(refreshed)).toBe('EMAIL_NOT_VERIFIED');

    const email = randomEmail('dogrulanmamis');
    const reg = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: 'X', name: 'Y', email, password: PASSWORD, client: 'mobile' },
    });
    expect(reg.statusCode).toBe(202);
    expect(reg.json()).toEqual({ verificationRequired: true });
    expect(reg.cookies).toHaveLength(0);
    expect(await prisma.person.count({ where: { email } })).toBe(1);

    const invite = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: randomEmail('davetli'), name: 'D' });
    const token = /invite\/(\S+)$/.exec(invite.json().link)?.[1] as string;
    const accepted = await post(`/invites/${token}/accept`, {}, { client: 'mobile', password: PASSWORD });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ verificationRequired: true });
  });

  it('şifre sıfırlama diğer jetonları siler', async () => {
    const owner = await registerOrg(app);
    await post('/auth/forgot-password', {}, { identifier: owner.email });
    const mail = await lastMailTo(owner.email as string);
    const token = /reset-password\/(\S+)/.exec(mail?.body as string)?.[1] as string;
    const reset = await post('/auth/reset-password', {}, { token, password: 'SifirSifre123!' });
    expect(reset.statusCode).toBe(200);
    expect(await prisma.oneTimeToken.count({ where: { personId: owner.personId, usedAt: null } })).toBe(0);
  });

  it('süresi dolmuş jetonla davet kabulü TOKEN_EXPIRED: istemci yeniler, LOGIN_REQUIRED değil', async () => {
    const owner = await registerOrg(app);
    const invited = await registerOrg(app);
    const invite = await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: invited.email, name: 'D' });
    const token = /invite\/(\S+)$/.exec(invite.json().link)?.[1] as string;
    const claims = claimsOf(invited.accessToken);
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: claims.sid, ep: 0, org: claims.org, prod: {} })
      .setProtectedHeader({ alg: 'EdDSA', kid: keys().kid })
      .setIssuer('sellerondata-account')
      .setAudience('sellerondata')
      .setSubject(claims.sub)
      .setJti('x')
      .setIssuedAt(now - 3600)
      .setExpirationTime(now - 1800)
      .sign(keys().privateKey);
    const res = await post(`/invites/${token}/accept`, bearer(expired));
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('TOKEN_EXPIRED');
    expect(decodeJwt(expired).exp).toBeLessThan(now);
  });

  it('adda bidi ve sıfır genişlikli karakter reddedilir', async () => {
    for (const name of ['Ali\u202Eilä', 'A\u200Bli', 'A\uFEFFli', 'A\u2066li']) {
      const res = await app.inject({
        method: 'POST',
        url: `${API}/auth/register`,
        remoteAddress: randomIp(),
        payload: { orgName: name, name: 'Y', email: randomEmail(), password: PASSWORD, client: 'mobile' },
      });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
    }
  });

  it('e-posta değişince eski adrese bildirim gider, bağlantı içermez', async () => {
    const owner = await registerOrg(app);
    const next = randomEmail('yeni');
    const res = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { email: next, currentPassword: PASSWORD } });
    expect(res.statusCode).toBe(200);
    // Değişiklik yeni adresin onayıyla geçerli olur (02-B2); bildirim onay anında gider.
    const confirm = /verify-email\/(\S+)/.exec((await lastMailTo(next))?.body ?? '')?.[1] as string;
    expect((await post('/auth/verify-email', {}, { token: confirm })).json().result).toBe('changed');
    const notice = await lastMailTo(owner.email as string);
    expect(notice?.template).toBe('email_changed');
    expect(notice?.body).not.toContain(next);
  });

  it('kod özeti biberli: düz SHA-256 tablodan bulunamaz', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { code, invitation } = (await phoneInvite(owner, phone)).json();
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.tokenHash).not.toBe(sha256(`${phone}:${code}`));
    expect(row.tokenHash).toBe(hashJoinCode(phone, code));
  });

  it('şifre kuralı: en az 10 karakter, yaygın şifre yok; tohum şifresi geçer', async () => {
    expect(newPassword.safeParse(SEED_PASSWORD).success).toBe(true);
    expect(newPassword.safeParse(PASSWORD).success).toBe(true);
    for (const weak of ['Kisa12345', '1234567890', 'password123', 'Qwerty12345', 'sifre12345', 'SIFRE123456']) {
      expect(newPassword.safeParse(weak).success, weak).toBe(false);
    }
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: 'X', name: 'Y', email: randomEmail(), password: 'password123', client: 'mobile' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].code).toBe('weak_password');
  });
});
