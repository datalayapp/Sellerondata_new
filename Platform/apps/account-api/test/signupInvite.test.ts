// Kayıt yalnız davetle (kullanıcı kararı 2026-11-12, kapalı deneme): SIGNUP_MODE=invite.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { assertConfig, env } from '../src/env.ts';
import { sha256 } from '../src/lib/crypto.ts';
import { createSignupInvite, listSignupInvites, revokeSignupInvites } from '../src/lib/signupInvites.ts';
import { API, PASSWORD, claimsOf, errorCode, getApp, randomEmail, randomIp, randomTrPhone, registerOrg, uniq, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.SIGNUP_MODE = 'open';
  process.env.REGISTRATION_ENABLED = 'true';
  process.env.NODE_ENV = 'test';
});

function register(email: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `${API}/auth/register`,
    remoteAddress: randomIp(),
    headers: { 'accept-language': 'tr' },
    payload: { orgName: `Davetli ${uniq()}`, name: 'Davetli Kişi', email, password: PASSWORD, client: 'mobile', ...extra },
  });
}

const tokenOf = (url: string) => new URL(url).searchParams.get('invite') as string;

describe('SIGNUP_MODE', () => {
  it('varsayılan: geliştirme ve testte open, üretimde invite; bozuk değer açılışı durdurur', () => {
    delete process.env.SIGNUP_MODE;
    expect(env.signupMode).toBe('open');
    process.env.NODE_ENV = 'production';
    expect(env.signupMode).toBe('invite');
    process.env.SIGNUP_MODE = 'open';
    expect(env.signupMode).toBe('open');
    process.env.NODE_ENV = 'test';
    for (const bad of ['davet', 'closed', 'true']) {
      process.env.SIGNUP_MODE = bad;
      expect(() => assertConfig()).toThrow(/SIGNUP_MODE geçersiz: open veya invite olmalı/);
    }
    process.env.SIGNUP_MODE = ' INVITE ';
    expect(env.signupMode).toBe('invite');
    expect(() => assertConfig()).not.toThrow();
  });

  it('katalog kipi taşır; invite iken "Yeni firma" kapalı', async () => {
    const owner = await registerOrg(app);
    const open = await app.inject({ url: `${API}/catalog` });
    expect(open.json().signupMode).toBe('open');
    process.env.SIGNUP_MODE = 'invite';
    const closed = await app.inject({ url: `${API}/catalog` });
    expect(closed.json()).toMatchObject({ signupMode: 'invite', registrationEnabled: true });
    const me = await app.inject({ url: `${API}/me`, headers: owner.headers });
    expect(me.json().account.canCreateOrg).toBe(false);
  });
});

describe('kayıt daveti', () => {
  it('davetsiz kayıt 403 SIGNUP_INVITE_REQUIRED; kişi ve firma açılmaz; open kipinde davet gerekmez', async () => {
    process.env.SIGNUP_MODE = 'invite';
    const email = randomEmail('davetsiz');
    const res = await register(email);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('SIGNUP_INVITE_REQUIRED');
    expect(res.json().error.message).toMatch(/yalnız davetle/);
    expect(await prisma.person.count({ where: { email } })).toBe(0);

    const en = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      headers: { 'accept-language': 'en' },
      payload: { orgName: 'X', name: 'Y', email, password: PASSWORD, client: 'mobile' },
    });
    expect(en.json().error.message).toMatch(/invitation-only/);

    process.env.SIGNUP_MODE = 'open';
    expect((await register(email)).statusCode).toBe(201);
  });

  it('geçerli davetle kayıt açılır, davet tükenir, iz yazılır; jeton saklanmaz', async () => {
    const email = randomEmail('davetli');
    const invite = await createSignupInvite({ email: email.toUpperCase(), operator: 'destek-test' });
    expect(invite.email).toBe(email);
    expect(invite.url).toMatch(/\/register\?invite=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(invite.url);
    const row = await prisma.signupInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.createdBy).toBe('destek-test');
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);

    process.env.SIGNUP_MODE = 'invite';
    const res = await register(email, { signupInvite: token });
    expect(res.statusCode).toBe(201);
    const claims = claimsOf(res.json().accessToken);
    expect(claims.orgRole).toBe('OWNER');
    expect(claims.prod.deciship).toMatchObject({ status: 'ACTIVE', plan: 'early_access' });

    const used = await prisma.signupInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(used.usedAt).not.toBeNull();
    expect(used.usedByPersonId).toBe(claims.sub);
    expect(used.orgId).toBe(claims.org);
    const audit = await prisma.auditLog.findMany({ where: { target: invite.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['support.signup_invite_created', 'signup.invite_used']);
    expect(audit[1].orgId).toBe(claims.org);
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain(token);

    // Aynı davet ikinci kez: tükenmiş.
    const again = await register(randomEmail('ikinci'), { signupInvite: token });
    expect(errorCode(again)).toBe('SIGNUP_INVITE_INVALID');
  });

  it('başka adres, süresi geçmiş ya da uydurma davet 403 SIGNUP_INVITE_INVALID; işlem geri alınır, davet harcanmaz', async () => {
    process.env.SIGNUP_MODE = 'invite';
    const email = randomEmail('bagli');
    const invite = await createSignupInvite({ email, operator: 'destek-test' });
    const token = tokenOf(invite.url);

    const other = randomEmail('baska');
    const wrong = await register(other, { signupInvite: token });
    expect(wrong.statusCode).toBe(403);
    expect(errorCode(wrong)).toBe('SIGNUP_INVITE_INVALID');
    expect(await prisma.person.count({ where: { email: other } })).toBe(0);
    expect((await prisma.signupInvite.findUniqueOrThrow({ where: { id: invite.id } })).usedAt).toBeNull();

    expect(errorCode(await register(email, { signupInvite: 'x'.repeat(43) }))).toBe('SIGNUP_INVITE_INVALID');

    // Doğru adres hâlâ kullanabilir.
    expect((await register(email, { signupInvite: token })).statusCode).toBe(201);

    // Süresi geçmiş.
    const late = randomEmail('gec');
    const old = await createSignupInvite({ email: late, operator: 'destek-test', days: 1, now: new Date(Date.now() - 2 * 86_400_000) });
    const expired = await register(late, { signupInvite: tokenOf(old.url) });
    expect(errorCode(expired)).toBe('SIGNUP_INVITE_INVALID');
    expect(await prisma.person.count({ where: { email: late } })).toBe(0);
  });

  it('adresle hesap varsa EMAIL_TAKEN, davet harcanmaz', async () => {
    const owner = await registerOrg(app);
    const invite = await createSignupInvite({ email: owner.email as string, operator: 'destek-test' });
    expect(invite.personExists).toBe(true);
    process.env.SIGNUP_MODE = 'invite';
    const res = await register(owner.email as string, { signupInvite: tokenOf(invite.url) });
    expect(errorCode(res)).toBe('EMAIL_TAKEN');
    expect((await prisma.signupInvite.findUniqueOrThrow({ where: { id: invite.id } })).usedAt).toBeNull();
  });

  it('davetsiz ya da uydurma davetle kayıt ucu adres yoklamasına dönmez: kayıtlı adreste de EMAIL_TAKEN yok', async () => {
    const owner = await registerOrg(app);
    process.env.SIGNUP_MODE = 'invite';
    expect(errorCode(await register(owner.email as string))).toBe('SIGNUP_INVITE_REQUIRED');
    expect(errorCode(await register(owner.email as string, { signupInvite: 'y'.repeat(43) }))).toBe('SIGNUP_INVITE_INVALID');
    // Başka adrese bağlı geçerli davet de aynı yanıtı alır.
    const other = await createSignupInvite({ email: randomEmail('baskasi'), operator: 'destek-test' });
    expect(errorCode(await register(owner.email as string, { signupInvite: tokenOf(other.url) }))).toBe('SIGNUP_INVITE_INVALID');
  });

  it('aynı davetle eşzamanlı iki kayıt: yalnız biri geçer', async () => {
    const email = randomEmail('yaris');
    const invite = await createSignupInvite({ email, operator: 'destek-test' });
    process.env.SIGNUP_MODE = 'invite';
    const token = tokenOf(invite.url);
    const results = await Promise.all([register(email, { signupInvite: token }), register(email, { signupInvite: token })]);
    // Yalnız biri geçer. Kaybedenin yanıtı zamanlamaya bağlı, ikisi de tasarlanmış: kazanan commit ettikten sonra okursa davet
    // kullanılmıştır (403 SIGNUP_INVITE_INVALID, `consumeSignupInvite`), aynı anda yazarsa e-posta tekilliği tutar (409).
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(201);
    expect([403, 409]).toContain(codes[1]);
    expect(await prisma.person.count({ where: { email } })).toBe(1);
  });

  it('REGISTRATION_ENABLED=false her kipte önce gelir: geçerli davetle de REGISTRATION_CLOSED', async () => {
    const email = randomEmail('kapali');
    const invite = await createSignupInvite({ email, operator: 'destek-test' });
    process.env.SIGNUP_MODE = 'invite';
    process.env.REGISTRATION_ENABLED = 'false';
    expect(errorCode(await register(email, { signupInvite: tokenOf(invite.url) }))).toBe('REGISTRATION_CLOSED');
  });

  it('üretim komutu: adres ve süre denetlenir, operatör zorunlu, EN bağlantı', async () => {
    await expect(createSignupInvite({ email: 'adres-degil', operator: 'destek-test' })).rejects.toThrow(/E-posta adresi geçersiz/);
    await expect(createSignupInvite({ email: randomEmail(), operator: ' ' })).rejects.toThrow(/operator zorunlu/);
    for (const days of [0, 91, 1.5]) {
      await expect(createSignupInvite({ email: randomEmail(), operator: 'destek-test', days })).rejects.toThrow(/--days 1 ile 90/);
    }
    const en = await createSignupInvite({ email: randomEmail(), operator: 'destek-test', lang: 'en', days: 3 });
    expect(en.url).toMatch(/&lang=en$/);
  });
});

describe('kayıt daveti: iptal, liste, alan biçimi (inceleme 8a, 8b)', () => {
  it('iptal adresin bekleyen davetlerini hemen geçersiz kılar, kullanılmışa dokunmaz; iz yazılır', async () => {
    process.env.SIGNUP_MODE = 'invite';
    const email = randomEmail('iptal');
    const used = await createSignupInvite({ email, operator: 'destek-test' });
    expect((await register(email, { signupInvite: tokenOf(used.url) })).statusCode).toBe(201);
    const a = await createSignupInvite({ email, operator: 'destek-test' });
    const b = await createSignupInvite({ email, operator: 'destek-test' });
    expect(await revokeSignupInvites({ email: email.toUpperCase(), operator: 'destek-iptal' })).toBe(2);
    expect(await revokeSignupInvites({ email, operator: 'destek-iptal' })).toBe(0);
    for (const inv of [a, b]) expect(errorCode(await register(randomEmail(), { signupInvite: tokenOf(inv.url) }))).toBe('SIGNUP_INVITE_INVALID');
    const rows = await listSignupInvites({ email });
    expect(rows.map((r) => r.status).sort()).toEqual(['expired', 'expired', 'used']);
    expect(JSON.stringify(rows)).not.toMatch(/tokenHash|invite=/);
    const audit = await prisma.auditLog.findMany({ where: { action: 'support.signup_invite_revoked', target: { in: [a.id, b.id] } } });
    expect(audit).toHaveLength(2);
    expect(audit[0].meta).toEqual({ operator: 'destek-iptal' });
    await expect(revokeSignupInvites({ email, operator: '' })).rejects.toThrow(/operator zorunlu/);
    await expect(listSignupInvites({ limit: 0 })).rejects.toThrow(/--limit/);
  });

  it('open kipinde davet alanı ne olursa olsun yok sayılır (400 yok); invite kipinde biçimsiz alan SIGNUP_INVITE_INVALID', async () => {
    for (const junk of ['x'.repeat(5000), 42, { a: 1 }, '']) {
      const res = await register(randomEmail('acik'), { signupInvite: junk });
      expect(res.statusCode, JSON.stringify(junk).slice(0, 20)).toBe(201);
    }
    process.env.SIGNUP_MODE = 'invite';
    expect(errorCode(await register(randomEmail(), { signupInvite: 'x'.repeat(201) }))).toBe('SIGNUP_INVITE_INVALID');
    expect(errorCode(await register(randomEmail(), { signupInvite: 42 }))).toBe('SIGNUP_INVITE_INVALID');
    expect(errorCode(await register(randomEmail(), { signupInvite: '   ' }))).toBe('SIGNUP_INVITE_REQUIRED');
    expect(errorCode(await register(randomEmail(), { signupInvite: null }))).toBe('SIGNUP_INVITE_REQUIRED');
  });
});

describe('kapalı denemede etkilenmeyen ve kapanan yollar', () => {
  it('giriş yapmış kişi davetsiz yeni firma açamaz (POST /orgs 403 SIGNUP_INVITE_REQUIRED)', async () => {
    const owner = await registerOrg(app);
    process.env.SIGNUP_MODE = 'invite';
    const res = await app.inject({ method: 'POST', url: `${API}/orgs`, headers: owner.headers, payload: { name: 'İkinci Firma' } });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('SIGNUP_INVITE_REQUIRED');
    expect(await prisma.membership.count({ where: { personId: owner.personId } })).toBe(1);
  });

  it('ekip daveti (e-posta bağlantısı ve telefon kodu) aynen çalışır', async () => {
    const owner = await registerOrg(app);
    process.env.SIGNUP_MODE = 'invite';

    const email = randomEmail('ekip');
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'EMAIL', email, name: 'Ekip Üyesi', orgRole: 'MEMBER', productRoles: { deciship: 'AUDITOR' } },
    });
    expect(inv.statusCode).toBe(201);
    const token = /invite\/(\S+)$/.exec(inv.json().link)?.[1] as string;
    const accepted = await app.inject({
      method: 'POST',
      url: `${API}/invites/${token}/accept`,
      remoteAddress: randomIp(),
      payload: { client: 'mobile', password: 'DavetSifre123!' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(claimsOf(accepted.json().accessToken).org).toBe(owner.orgId);

    const phoneInv = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Depo Çalışanı', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } },
    });
    expect(phoneInv.statusCode).toBe(201);
    const { code, invitation } = phoneInv.json();
    const phone = (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).phone as string;
    const joined = await app.inject({
      method: 'POST',
      url: `${API}/auth/join/accept`,
      remoteAddress: randomIp(),
      payload: { phone, code, password: 'CalisanSifre1!', client: 'mobile' },
    });
    expect(joined.statusCode).toBe(201);
    expect(claimsOf(joined.json().accessToken).org).toBe(owner.orgId);
  });
});
