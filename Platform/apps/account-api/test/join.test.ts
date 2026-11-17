import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { hashJoinCode, normalizeJoinCode, sha256, verifyPassword } from '../src/lib/crypto.ts';
import { MAX_CODE_ATTEMPTS } from '../src/routes/join.ts';
import {
  addMember,
  API,
  claimsOf,
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
  type Ctx, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

async function phoneInvite(owner: Ctx, over: Record<string, unknown> = {}) {
  const phone = (over.phone as string) ?? randomTrPhone();
  const res = await app.inject({
    method: 'POST',
    url: `${API}/org/members/invite`,
    headers: await asWeb(owner),
    payload: { kind: 'PHONE_CODE', phone, name: 'Depo Çalışanı', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' }, ...over },
  });
  return { res, phone };
}

function preview(phone: string, code: string, ip = randomIp()) {
  return app.inject({ method: 'POST', url: `${API}/auth/join/preview`, remoteAddress: ip, payload: { phone, code } });
}

function accept(phone: string, code: string, password = 'CalisanSifre1!', extra: Record<string, unknown> = {}, ip = randomIp()) {
  return app.inject({
    method: 'POST',
    url: `${API}/auth/join/accept`,
    remoteAddress: ip,
    payload: { phone, code, password, client: 'mobile', ...extra },
  });
}

const wrongCode = (code: string) => (code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`);

describe('telefon daveti', () => {
  it('kod 8 karakter Crockford, bir kez döner, yalnız özeti saklanır, listede görünmez', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    expect(res.statusCode).toBe(201);
    const { code, invitation } = res.json();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.tokenHash).toBe(hashJoinCode(phone, code));
    expect(row.tokenHash).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code);
    // 72 saat
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);

    const list = await app.inject({ url: `${API}/org/invitations`, headers: owner.headers });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(code);
    expect(list.body).not.toContain('tokenHash');
    const audit = await app.inject({ url: `${API}/org/audit`, headers: owner.headers });
    expect(audit.body).not.toContain(code);
  });

  it('kod girişi esnek: küçük harf, tire, O/0, I/1 karışıklığı', () => {
    expect(normalizeJoinCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeJoinCode('o1il 2345')).toBe('01112345');
    expect(normalizeJoinCode('ABC')).toBeNull();
    expect(normalizeJoinCode('ABCDEFGU')).toBeNull();
  });

  it('yeni kişi: önizleme, şifresini kendisi belirler, üyelik ve rol eklenir, oturum açılır', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code } = res.json();

    const pv = await preview(phone, code.toLowerCase());
    expect(pv.statusCode).toBe(200);
    expect(pv.json()).toMatchObject({ name: 'Depo Çalışanı', personExists: false, purpose: 'JOIN' });
    expect(pv.json().orgName).toBeTruthy();

    const res2 = await accept(phone, code);
    expect(res2.statusCode).toBe(201);
    const claims = claimsOf(res2.json().accessToken);
    expect(claims.org).toBe(owner.orgId);
    expect(claims.orgRole).toBe('MEMBER');
    expect(claims.prod.deciship?.role).toBe('MEASURE');

    const person = await prisma.person.findUniqueOrThrow({ where: { phone } });
    expect(person.email).toBeNull();
    expect(person.name).toBe('Depo Çalışanı');
    expect(await verifyPassword(person.passwordHash, 'CalisanSifre1!')).toBe(true);

    // Telefonla giriş çalışır
    expect((await login(app, phone, 'CalisanSifre1!')).statusCode).toBe(200);
  });

  it('kod bir kez kullanılır', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code } = res.json();
    expect((await accept(phone, code)).statusCode).toBe(201);
    const second = await accept(phone, code);
    expect(second.statusCode).toBe(400);
    expect(errorCode(second)).toBe('INVITE_INVALID');
    expect((await preview(phone, code)).statusCode).toBe(400);
  });

  it('aynı kodla eşzamanlı kabul: tek kişi, tek üyelik', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code } = res.json();
    const results = await Promise.all([1, 2, 3].map(() => accept(phone, code)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const person = await prisma.person.findUniqueOrThrow({ where: { phone } });
    expect(await prisma.membership.count({ where: { personId: person.id } })).toBe(1);
  });

  it('süresi dolmuş kod geçersiz', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code, invitation } = res.json();
    await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(errorCode(await preview(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await accept(phone, code))).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { phone } })).toBe(0);
  });

  it('MAX_CODE_ATTEMPTS hatalı denemede geçersiz: doğru kod da artık çalışmaz, sayaç önizlemede de işler', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code, invitation } = res.json();
    const bad = wrongCode(code);
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 2; i++) expect((await preview(phone, bad)).statusCode).toBe(400);
    for (let i = 0; i < 2; i++) expect((await accept(phone, bad)).statusCode).toBe(400);
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.attempts).toBe(MAX_CODE_ATTEMPTS);

    expect(errorCode(await accept(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await preview(phone, code))).toBe('INVITE_INVALID');
    expect(await prisma.person.count({ where: { phone } })).toBe(0);
  });

  it('MAX_CODE_ATTEMPTS - 1 hatalı denemeden sonra doğru kod çalışır', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code } = res.json();
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) await preview(phone, wrongCode(code));
    expect((await accept(phone, code)).statusCode).toBe(201);
  });

  it('paralel tahminler sınırı aşamaz', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code, invitation } = res.json();
    await Promise.all(Array.from({ length: MAX_CODE_ATTEMPTS + 7 }, () => preview(phone, wrongCode(code))));
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.attempts).toBe(MAX_CODE_ATTEMPTS);
    expect(errorCode(await preview(phone, code))).toBe('INVITE_INVALID');
  });

  it('bilinmeyen telefon ve yanlış kod aynı yanıtı alır', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const a = await preview(phone, wrongCode(res.json().code));
    const b = await preview(randomTrPhone(), 'ABCD2345');
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.body).toBe(b.body);
  });

  it('yeni davet eski kodu düşürür, iptal edilen kod çalışmaz', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const first = (await phoneInvite(owner, { phone })).res.json();
    const second = (await phoneInvite(owner, { phone })).res.json();
    expect(errorCode(await preview(phone, first.code))).toBe('INVITE_INVALID');
    expect((await preview(phone, second.code)).statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `${API}/org/invitations/${second.invitation.id}`, headers: await asWeb(owner) });
    expect(del.statusCode).toBe(200);
    expect(errorCode(await preview(phone, second.code))).toBe('INVITE_INVALID');
  });

  it('yeniden gönderim yeni kod üretir, eskisini düşürür, deneme hakkını sıfırlamaz', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    const { code, invitation } = res.json();
    await preview(phone, wrongCode(code));
    const resend = await app.inject({ method: 'POST', url: `${API}/org/invitations/${invitation.id}/resend`, headers: await asWeb(owner) });
    expect(resend.statusCode).toBe(200);
    const fresh = resend.json().code;
    expect(fresh).not.toBe(code);
    expect(resend.json().invitation.attempts).toBe(1);
    expect(errorCode(await preview(phone, code))).toBe('INVITE_INVALID');
    expect((await accept(phone, fresh)).statusCode).toBe(201);
  });
});

describe('hesap ele geçirme kapısı kapalı', () => {
  it('var olan kişide kod şifre belirletmez: saldırganın şifresi reddedilir, hash değişmez, oturum açılmaz', async () => {
    const victimOrg = await registerOrg(app);
    const phone = randomTrPhone();
    const victim = await addMember(app, victimOrg.orgId, { email: null, phone });
    const hashBefore = (await prisma.person.findUniqueOrThrow({ where: { id: victim.personId } })).passwordHash;
    const sessionsBefore = await prisma.session.count({ where: { personId: victim.personId } });

    // Saldırgan kendi firmasından kurbanın telefonuna kod üretir.
    const attacker = await registerOrg(app);
    const { res } = await phoneInvite(attacker, { phone });
    const { code } = res.json();

    const pv = await preview(phone, code);
    expect(pv.json()).toMatchObject({ personExists: true, purpose: 'JOIN' });

    const attempt = await accept(phone, code, 'SaldirganSifre1!', { name: 'Saldırgan' });
    expect(attempt.statusCode).toBe(401);
    expect(errorCode(attempt)).toBe('INVALID_CREDENTIALS');

    const after = await prisma.person.findUniqueOrThrow({ where: { id: victim.personId } });
    expect(after.passwordHash).toBe(hashBefore);
    expect(after.name).not.toBe('Saldırgan');
    expect(await prisma.session.count({ where: { personId: victim.personId } })).toBe(sessionsBefore);
    expect(await prisma.membership.count({ where: { personId: victim.personId, orgId: attacker.orgId } })).toBe(0);
    expect((await login(app, phone, 'SaldirganSifre1!')).statusCode).toBe(401);
    expect((await login(app, phone, PASSWORD)).statusCode).toBe(200);
  });

  it('kişi mevcut şifresiyle onaylarsa üyelik eklenir, şifre ve ad değişmez', async () => {
    const firstOrg = await registerOrg(app);
    const phone = randomTrPhone();
    const person = await addMember(app, firstOrg.orgId, { email: null, phone });
    const before = await prisma.person.findUniqueOrThrow({ where: { id: person.personId } });

    const secondOrg = await registerOrg(app);
    const { code } = (await phoneInvite(secondOrg, { phone, name: 'Başka Ad', productRoles: { deciship: 'ACCOUNTING' } })).res.json();

    const res = await accept(phone, code, PASSWORD, { name: 'Başka Ad' });
    expect(res.statusCode).toBe(200);
    const claims = claimsOf(res.json().accessToken);
    expect(claims.org).toBe(secondOrg.orgId);
    expect(claims.prod.deciship?.role).toBe('ACCOUNTING');

    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.personId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe(before.name);
    expect(await prisma.membership.count({ where: { personId: person.personId } })).toBe(2);
  });

  it('geçerli kodla şifre denemesi de MAX_CODE_ATTEMPTS hakla sınırlı', async () => {
    const firstOrg = await registerOrg(app);
    const phone = randomTrPhone();
    await addMember(app, firstOrg.orgId, { email: null, phone });
    const secondOrg = await registerOrg(app);
    const { code, invitation } = (await phoneInvite(secondOrg, { phone })).res.json();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect(errorCode(await accept(phone, code, `Tahmin${i}Sifre!`))).toBe('INVALID_CREDENTIALS');
    }
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).attempts).toBe(MAX_CODE_ATTEMPTS);
    // Artık doğru şifre de işe yaramaz.
    expect(errorCode(await accept(phone, code, PASSWORD))).toBe('INVITE_INVALID');
  });

  it('zaten üye olan telefona davet 409, başka firmadaki üyelik davette ele verilmez', async () => {
    const org = await registerOrg(app);
    const phone = randomTrPhone();
    await addMember(app, org.orgId, { email: null, phone });
    const { res } = await phoneInvite(org, { phone });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('ALREADY_MEMBER');

    const other = await registerOrg(app);
    const { res: otherRes } = await phoneInvite(other, { phone });
    expect(otherRes.statusCode).toBe(201);
    expect(otherRes.body).not.toContain('personExists');
  });

  it('kabul anında kişi oluşmuşsa yeni kişi yolu değil şifre onayı yolu çalışır', async () => {
    const a = await registerOrg(app);
    const b = await registerOrg(app);
    const phone = randomTrPhone();
    const fromA = (await phoneInvite(a, { phone })).res.json();
    const fromB = (await phoneInvite(b, { phone })).res.json();

    expect((await accept(phone, fromA.code, 'IlkSifre1234!')).statusCode).toBe(201);
    // B'nin kodu kişi yokken üretildi; şimdi kişi var.
    const hijack = await accept(phone, fromB.code, 'BaskaSifre1234!');
    expect(errorCode(hijack)).toBe('INVALID_CREDENTIALS');
    expect((await login(app, phone, 'IlkSifre1234!')).statusCode).toBe(200);
    expect((await accept(phone, fromB.code, 'IlkSifre1234!')).statusCode).toBe(200);
  });

  it('yeni kişide zayıf şifre deneme hakkı yemez', async () => {
    const org = await registerOrg(app);
    const { res, phone } = await phoneInvite(org);
    const { code, invitation } = res.json();
    const weak = await accept(phone, code, 'kisa');
    expect(weak.statusCode).toBe(400);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).attempts).toBe(0);
    expect((await accept(phone, code)).statusCode).toBe(201);
  });
});

describe('web ile katılım', () => {
  it('çerez yazar, CSRF ister', async () => {
    const org = await registerOrg(app);
    const { res, phone } = await phoneInvite(org);
    const { code } = res.json();
    const payload = { phone, code, password: 'CalisanSifre1!', client: 'web' };
    const denied = await app.inject({ method: 'POST', url: `${API}/auth/join/accept`, remoteAddress: randomIp(), payload });
    expect(errorCode(denied)).toBe('CSRF_FAILED');
    const ok = await app.inject({ method: 'POST', url: `${API}/auth/join/accept`, remoteAddress: randomIp(), headers: webHeaders(), payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().accessToken).toBeUndefined();
    expect(parseSetCookies(ok).sod_at.value).toBeTruthy();
  });
});

describe('reset-code', () => {
  async function setup() {
    const org = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, org.orgId, { email: null, phone, deciship: 'MEASURE' });
    return { org, phone, worker };
  }
  // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); EN metni ayrıca başlıkla sınanır.
  const resetCode = async (actor: Ctx, membershipId: string) =>
    app.inject({ method: 'POST', url: `${API}/org/members/${membershipId}/reset-code`, headers: { ...(await asWeb(actor)), 'accept-language': 'tr' } });

  it('tek firmalı, e-postasız kişi: kod yeni şifre belirletir, eski oturumlar düşer, epoch artar', async () => {
    const { org, phone, worker } = await setup();
    const res = await resetCode(org, worker.membershipId);
    expect(res.statusCode).toBe(201);
    const { code } = res.json();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const epochBefore = (await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } })).epoch;

    const pv = await preview(phone, code);
    expect(pv.json()).toMatchObject({ personExists: true, purpose: 'PASSWORD_RESET' });

    const accepted = await accept(phone, code, 'YeniIsciSifre1!');
    expect(accepted.statusCode).toBe(200);
    expect(claimsOf(accepted.json().accessToken).org).toBe(org.orgId);

    expect((await login(app, phone, PASSWORD)).statusCode).toBe(401);
    expect((await login(app, phone, 'YeniIsciSifre1!')).statusCode).toBe(200);
    const refreshOld = await app.inject({ method: 'POST', url: `${API}/auth/refresh`, remoteAddress: randomIp(), payload: { refreshToken: worker.refreshToken } });
    expect(refreshOld.statusCode).toBe(401);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } })).epoch).toBe(epochBefore + 1);
    // Üyelik sayısı değişmez.
    expect(await prisma.membership.count({ where: { personId: worker.personId } })).toBe(1);
    // Kod bir kez
    expect(errorCode(await accept(phone, code, 'BaskaSifre1234!'))).toBe('INVITE_INVALID');
  });

  it('e-postası olan kişi: RESET_CODE_NOT_ALLOWED, "kendisi yenilemeli" (04-B10: nedeni ayırmayan tek metin)', async () => {
    const org = await registerOrg(app);
    const member = await addMember(app, org.orgId, { phone: randomTrPhone() });
    const res = await resetCode(org, member.membershipId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'RESET_CODE_NOT_ALLOWED', details: { reason: 'SELF_RESET' } });
    expect(res.json().error.message).toMatch(/kendisi yenilemeli/);
  });

  it('birden çok firmadaki kişi: RESET_CODE_NOT_ALLOWED, başka firmada çalıştığı ele verilmez (04-B10, TR ve EN)', async () => {
    const { org, worker } = await setup();
    const other = await registerOrg(app);
    await prisma.membership.create({ data: { personId: worker.personId, orgId: other.orgId } });
    const res = await resetCode(org, worker.membershipId);
    expect(res.statusCode).toBe(409);
    // E-postalı kişiyle aynı neden ve metin: yönetici, çalışanın başka firmada da çalıştığını buradan öğrenmez.
    expect(res.json().error).toMatchObject({ code: 'RESET_CODE_NOT_ALLOWED', details: { reason: 'SELF_RESET' } });
    expect(res.json().error.message).toMatch(/kendisi yenilemeli/);
    expect(res.json().error.message).not.toMatch(/firma/);
    const en = await app.inject({
      method: 'POST',
      url: `${API}/org/members/${worker.membershipId}/reset-code`,
      headers: { ...(await asWeb(org)), 'accept-language': 'en' },
    });
    expect(en.json().error.message).toMatch(/reset their password themselves/);
    expect(en.json().error.message).not.toMatch(/compan/);
  });

  it('askıdaki üye: RESET_CODE_NOT_ALLOWED', async () => {
    const { org, worker } = await setup();
    await prisma.membership.update({ where: { id: worker.membershipId }, data: { status: 'SUSPENDED' } });
    const res = await resetCode(org, worker.membershipId);
    expect(res.json().error).toMatchObject({ code: 'RESET_CODE_NOT_ALLOWED', details: { reason: 'NOT_ACTIVE' } });
  });

  it('kod üretildikten sonra kişi ikinci firmaya girerse kod ölür (yarış)', async () => {
    const { org, phone, worker } = await setup();
    const { code } = (await resetCode(org, worker.membershipId)).json();
    const other = await registerOrg(app);
    await prisma.membership.create({ data: { personId: worker.personId, orgId: other.orgId } });
    const hash = (await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).passwordHash;
    expect(errorCode(await preview(phone, code))).toBe('INVITE_INVALID');
    expect(errorCode(await accept(phone, code, 'ElGecirme1234!'))).toBe('INVITE_INVALID');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).passwordHash).toBe(hash);
  });

  it('kod üretildikten sonra kişi e-posta eklerse kod ölür', async () => {
    const { org, phone, worker } = await setup();
    const { code } = (await resetCode(org, worker.membershipId)).json();
    await prisma.person.update({ where: { id: worker.personId }, data: { email: randomEmail() } });
    expect(errorCode(await accept(phone, code, 'ElGecirme1234!'))).toBe('INVITE_INVALID');
  });

  it('ADMIN, OWNER için ve başka ADMIN için kod üretemez (ele geçirme), kendine de', async () => {
    const owner = await registerOrg(app, { email: randomEmail('sahipe') });
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const otherAdmin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', email: null, phone: randomTrPhone() });
    // Telefonlu ve e-postasız OWNER kurgusu: kural kimlikten önce çalışmalı.
    await prisma.person.update({ where: { id: owner.personId }, data: { email: null, phone: randomTrPhone() } });

    const onOwner = await resetCode(admin, owner.membershipId);
    expect(onOwner.statusCode).toBe(403);
    expect(errorCode(onOwner)).toBe('CANNOT_MANAGE_OWNER');

    const onAdmin = await resetCode(admin, otherAdmin.membershipId);
    expect(onAdmin.statusCode).toBe(403);
    expect(errorCode(onAdmin)).toBe('FORBIDDEN');

    const self = await resetCode(admin, admin.membershipId);
    expect(errorCode(self)).toBe('CANNOT_MANAGE_SELF');
  });

  it('başka firmanın üyesi için üretilemez: 404', async () => {
    const { worker } = await setup();
    const stranger = await registerOrg(app);
    const res = await resetCode(stranger, worker.membershipId);
    expect(res.statusCode).toBe(404);
  });

  it('kod bu firmadan başka bir kişinin telefonuyla kullanılamaz', async () => {
    const { org, worker } = await setup();
    const { code } = (await resetCode(org, worker.membershipId)).json();
    expect(errorCode(await accept(randomTrPhone(), code, 'ElGecirme1234!'))).toBe('INVITE_INVALID');
  });
});

describe('e-posta daveti', () => {
  async function emailInvite(owner: Ctx, email = randomEmail('davet'), over: Record<string, unknown> = {}) {
    // Davet postası yalnız e-postası doğrulanmış davet edenden gider (02-B4, A2): bu testler posta ve bağlantıyı sınar.
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const res = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'EMAIL', email, name: 'Davetli', orgRole: 'MEMBER', productRoles: { deciship: 'AUDITOR' }, ...over },
    });
    return { res, email, token: res.statusCode === 201 ? (/invite\/(\S+)$/.exec(res.json().link)?.[1] as string) : '' };
  }

  it('bağlantı döner ve posta gider, yalnız özet saklanır, 7 gün', async () => {
    const owner = await registerOrg(app);
    const { res, email, token } = await emailInvite(owner);
    expect(res.statusCode).toBe(201);
    expect(res.json().link).toContain('/invite/');
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: res.json().invitation.id } });
    expect(row.tokenHash).toBe(sha256(token));
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const mail = await lastMailTo(email);
    expect(mail?.template).toBe('invitation');
    expect(mail?.body).toContain(token);
  });

  it('yeni kişi: şifre belirler, üyelik eklenir, e-posta doğrulanmış sayılmaz (bağlantı kopyalanabilir)', async () => {
    const owner = await registerOrg(app);
    const { res, email, token } = await emailInvite(owner);
    expect(res.statusCode).toBe(201);

    const pv = await app.inject({ url: `${API}/invites/${token}`, remoteAddress: randomIp() });
    expect(pv.json()).toMatchObject({ email, personExists: false, orgRole: 'MEMBER' });

    const noPassword = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      payload: { client: 'mobile' },
    });
    expect(noPassword.statusCode).toBe(400);

    const accepted = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      payload: { client: 'mobile', password: 'DavetSifre123!' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(claimsOf(accepted.json().accessToken).prod.deciship?.role).toBe('AUDITOR');
    const person = await prisma.person.findUniqueOrThrow({ where: { email } });
    expect(person.emailVerifiedAt).toBeNull();

    const again = await app.inject({ method: 'POST', url: `${API}/invites/${token}/accept`, remoteAddress: randomIp(), payload: { client: 'mobile', password: 'DavetSifre123!' } });
    expect(errorCode(again)).toBe('INVITE_INVALID');
  });

  it('var olan e-posta: oturum yoksa LOGIN_REQUIRED, başka hesapla INVITE_WRONG_ACCOUNT, şifre vererek geçilemez', async () => {
    const owner = await registerOrg(app);
    const existing = await registerOrg(app);
    const stranger = await registerOrg(app);
    const { token } = await emailInvite(owner, existing.email as string);

    const anonymous = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      payload: { client: 'mobile', password: 'SaldirganSifre1!' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous)).toBe('LOGIN_REQUIRED');

    const wrong = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      headers: stranger.headers,
      payload: {},
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorCode(wrong)).toBe('INVITE_WRONG_ACCOUNT');

    const hashBefore = (await prisma.person.findUniqueOrThrow({ where: { id: existing.personId } })).passwordHash;
    const ok = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      headers: existing.headers,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(claimsOf(ok.json().accessToken).org).toBe(owner.orgId);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.personId } })).passwordHash).toBe(hashBefore);
  });

  it('süresi dolmuş veya iptal edilmiş bağlantı INVITE_INVALID', async () => {
    const owner = await registerOrg(app);
    const { res, token } = await emailInvite(owner);
    await prisma.invitation.update({ where: { id: res.json().invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const pv = await app.inject({ url: `${API}/invites/${token}`, remoteAddress: randomIp() });
    expect(errorCode(pv)).toBe('INVITE_INVALID');
  });

  it('telefon kodu e-posta bağlantısı olarak kullanılamaz', async () => {
    const owner = await registerOrg(app);
    const { res } = await phoneInvite(owner);
    const pv = await app.inject({ url: `${API}/invites/${res.json().code}`, remoteAddress: randomIp() });
    expect(errorCode(pv)).toBe('INVITE_INVALID');
  });

  it('davet katalog doğrulamasından geçer; hazır olmayan ürüne rol verilmez', async () => {
    const owner = await registerOrg(app);
    const notAvailable = await emailInvite(owner, randomEmail(), { productRoles: { orderloom: 'ADMIN' } });
    expect(notAvailable.res.statusCode).toBe(400);
    expect(errorCode(notAvailable.res)).toBe('PRODUCT_NOT_AVAILABLE');
    const unknownRole = await emailInvite(owner, randomEmail(), { productRoles: { deciship: 'PATRON' } });
    expect(errorCode(unknownRole.res)).toBe('INVALID_PRODUCT_ROLE');
    const unknownProduct = await emailInvite(owner, randomEmail(), { productRoles: { baska: 'ADMIN' } });
    expect(errorCode(unknownProduct.res)).toBe('INVALID_PRODUCT_ROLE');
  });

  it('davetten sonra kapanan ürünün rolü düşer; kabul hata vermez', async () => {
    const owner = await registerOrg(app);
    const { email, token } = await emailInvite(owner);
    await withLaunch('deciship=off', async () => {
      const accepted = await app.inject({
        method: 'POST',
        url: `${API}/invites/${token}/accept`,
        remoteAddress: randomIp(),
        payload: { client: 'mobile', password: 'DavetSifre123!' },
      });
      expect(accepted.statusCode).toBe(201);
      expect(claimsOf(accepted.json().accessToken)).toMatchObject({ org: owner.orgId, prod: {} });
      const person = await prisma.person.findUniqueOrThrow({ where: { email } });
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { personId_orgId: { personId: person.id, orgId: owner.orgId } },
        include: { productAccess: true },
      });
      expect(membership.productAccess).toEqual([]);
    });
  });
});

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

describe('telefon daveti çalışırken duruma bakar (PRODUCT_LAUNCH)', () => {
  const accessOf = async (personPhone: string, orgId: string) => {
    const person = await prisma.person.findUniqueOrThrow({ where: { phone: personPhone } });
    const m = await prisma.membership.findUniqueOrThrow({ where: { personId_orgId: { personId: person.id, orgId } }, include: { productAccess: true } });
    return m.productAccess.map((a) => [a.product, a.role]);
  };

  it('off: davetteki rol düşer, kişi firmaya katılır, jetonda ürün yok', async () => {
    const owner = await registerOrg(app);
    const { res, phone } = await phoneInvite(owner);
    await withLaunch('deciship=off', async () => {
      const joined = await accept(phone, res.json().code);
      expect(joined.statusCode).toBe(201);
      expect(claimsOf(joined.json().accessToken)).toMatchObject({ org: owner.orgId, prod: {} });
      expect(await accessOf(phone, owner.orgId)).toEqual([]);
    });
  });

  it('pilot: aboneliği olan firmada rol kalır; aboneliği olmayan firmanın davetindeki rol düşer', async () => {
    const withSub = await registerOrg(app);
    await withLaunch('deciship=pilot', async () => {
      const a = await phoneInvite(withSub);
      const joinedA = await accept(a.phone, a.res.json().code);
      expect(joinedA.statusCode).toBe(201);
      expect(claimsOf(joinedA.json().accessToken).prod.deciship?.role).toBe('MEASURE');
      expect(await accessOf(a.phone, withSub.orgId)).toEqual([['deciship', 'MEASURE']]);

      // Aboneliği olmayan firmada pilot rolüyle davet yazılamaz (members.test); burada davet abonelik varken yazıldı,
      // abonelik sonra kalktı: kabulde rol düşer.
      const fresh = await withLaunch('', () => registerOrg(app));
      const b = await withLaunch('', () => phoneInvite(fresh));
      expect(b.res.statusCode).toBe(201);
      await prisma.subscription.deleteMany({ where: { orgId: fresh.orgId } });
      const joinedB = await accept(b.phone, b.res.json().code);
      expect(joinedB.statusCode).toBe(201);
      expect(claimsOf(joinedB.json().accessToken)).toMatchObject({ org: fresh.orgId, prod: {} });
      expect(await accessOf(b.phone, fresh.orgId)).toEqual([]);
    });
  });
});
