import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { randomToken, sha256 } from '../src/lib/crypto.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { identityKey, RATE_RULES } from '../src/lib/rateLimit.ts';
import { MAX_ACTIVE_TOKENS, verifyResendKey } from '../src/routes/auth.ts';
import { addMember, API, errorCode, getApp, lastMailTo, login, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, uniq, type Ctx, webHeadersFrom, isOrgWrite } from './helpers.ts';

/**
 * 02-B1 (doğrulanmamış e-postayla hesap kullanılamaz) ve 02-B2 (e-posta değişikliği bekleyen adresle, onaya kadar eski adres geçerli).
 * Sözleşme: "verify-email kuralları" ve jetonlar.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
});

// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}, ip = randomIp()) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: ip, headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });
const verify = (token: string, password?: string, ip = randomIp()) =>
  post('/auth/verify-email', { token, ...(password !== undefined ? { password } : {}) }, {}, ip);
const patchMe = (ctx: Ctx, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `${API}/me`, remoteAddress: randomIp(), headers: ctx.headers, payload });

function tokenIn(body: string | undefined, path: 'verify-email' | 'reset-password') {
  const token = new RegExp(`${path}/(\\S+)`).exec(body ?? '')?.[1];
  if (!token) throw new Error(`postada ${path} bağlantısı yok: ${body}`);
  return token;
}

async function mailsTo(to: string) {
  await flushMail();
  return prisma.mailLog.findMany({ where: { to }, orderBy: { createdAt: 'asc' } });
}

async function personOf(id: string) {
  return prisma.person.findUniqueOrThrow({ where: { id } });
}

/** Ayarı yalnız bu iş süresince değiştirir. */
async function withVerification<T>(value: 'true' | 'false', work: () => Promise<T>): Promise<T> {
  const before = process.env.EMAIL_VERIFICATION_REQUIRED;
  process.env.EMAIL_VERIFICATION_REQUIRED = value;
  try {
    return await work();
  } finally {
    process.env.EMAIL_VERIFICATION_REQUIRED = before;
  }
}

/** Doğrulama zorunluyken kayıt: oturum yok, kişi kimliği veritabanından. */
async function registerUnverified(email = randomEmail('kayit')) {
  const res = await withVerification('true', () =>
    post('/auth/register', { orgName: `Firma ${uniq()}`, name: 'Sahip', email, password: PASSWORD, client: 'mobile' }),
  );
  expect(res.statusCode, res.body).toBe(202);
  const person = await prisma.person.findUniqueOrThrow({ where: { email } });
  return { email, personId: person.id };
}

describe('B1: doğrulama zorunlu', () => {
  beforeEach(() => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
  });

  it('kayıt oturum vermez; giriş yalnız doğru şifreyle EMAIL_NOT_VERIFIED alır ve bağlantı yeniden gider; doğrulayınca girer', async () => {
    const { email, personId } = await registerUnverified();
    const res = await post('/auth/register', { orgName: 'X', name: 'Y', email: randomEmail(), password: PASSWORD, client: 'mobile' });
    expect(res.json()).toEqual({ verificationRequired: true });
    expect(await prisma.session.count({ where: { personId } })).toBe(0);

    const wrong = await login(app, email, 'YanlisSifre123');
    expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
    expect(await mailsTo(email)).toHaveLength(1);

    const denied = await login(app, email);
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe('EMAIL_NOT_VERIFIED');
    const mails = await mailsTo(email);
    expect(mails.map((m) => m.template)).toEqual(['email_verify', 'email_verify']);
    expect(await prisma.session.count({ where: { personId } })).toBe(0);

    // İlk bağlantı yenisi gelince ölmez (§3.4).
    const first = await verify(tokenIn(mails[0].body, 'verify-email'), PASSWORD);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ ok: true, result: 'verified' });
    expect((await personOf(personId)).emailVerifiedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'person.email_verified', target: personId, orgId: null } })).toBe(1);
    // Aynı adrese giden diğer bağlantılar işini gördü.
    expect(await prisma.oneTimeToken.count({ where: { personId, kind: 'EMAIL_VERIFY', usedAt: null } })).toBe(0);

    expect((await login(app, email)).statusCode).toBe(200);
  });

  it('kullanılmış bağlantı yeniden açılınca already; süresi dolmuş, uydurma ve sıfırlama jetonu TOKEN_INVALID', async () => {
    const { email, personId } = await registerUnverified();
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');
    expect((await verify(token, PASSWORD)).json().result).toBe('verified');
    // Yenilenen sayfa şifre istemez.
    const again = await verify(token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, result: 'already' });

    expect(errorCode(await verify(randomToken()))).toBe('TOKEN_INVALID');

    const expired = randomToken();
    await prisma.oneTimeToken.create({
      data: { personId, kind: 'EMAIL_VERIFY', email, tokenHash: sha256(expired), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(errorCode(await verify(expired))).toBe('TOKEN_INVALID');

    await post('/auth/forgot-password', { identifier: email });
    const reset = tokenIn((await lastMailTo(email))?.body, 'reset-password');
    expect(errorCode(await verify(reset))).toBe('TOKEN_INVALID');
  });

  it('already yalnız adres hâlâ doğrulanmış mevcut adresse: adres sonra değiştiyse eski bağlantı TOKEN_INVALID', async () => {
    const { email, personId } = await registerUnverified();
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');
    expect((await verify(token, PASSWORD)).json().result).toBe('verified');
    await prisma.person.update({ where: { id: personId }, data: { email: randomEmail('sonra') } });
    expect(errorCode(await verify(token))).toBe('TOKEN_INVALID');
  });

  it('davetle gelen yeni kişi de doğrular: oturum yok, doğrulama postası gider', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    const owner = await registerOrg(app);
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const email = randomEmail('davetli');
    const invite = await post('/org/members/invite', { kind: 'EMAIL', email, name: 'Davetli' }, owner.headers);
    const token = /invite\/(\S+)$/.exec(invite.json().link)?.[1] as string;
    const accepted = await post(`/invites/${token}/accept`, { client: 'mobile', password: PASSWORD });
    expect(accepted.statusCode).toBe(202);
    const person = await prisma.person.findUniqueOrThrow({ where: { email } });
    expect(person.emailVerifiedAt).toBeNull();
    expect(await prisma.session.count({ where: { personId: person.id } })).toBe(0);
    expect((await lastMailTo(email))?.template).toBe('email_verify');
  });

  it('yalnız telefonlu kişide doğrulama yok', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    await addMember(app, owner.orgId, { email: null, phone });
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    expect((await login(app, phone)).statusCode).toBe(200);
  });
});

describe('B1: ilk doğrulama şifre ister (bağlantı şifreyi kimin koyduğunu kanıtlamaz)', () => {
  beforeEach(() => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
  });
  const ATTACKER_PASSWORD = 'SaldirganSifre-913';

  it('kayıt yolu: saldırgan kurbanın adresiyle kayıt olur; kurban şifresiz açınca 401 ve hesap doğrulanmaz, saldırgan giremez', async () => {
    const email = randomEmail('kurban');
    const reg = await post('/auth/register', { orgName: `Firma ${uniq()}`, name: 'Saldırgan', email, password: ATTACKER_PASSWORD, client: 'mobile' });
    expect(reg.statusCode).toBe(202);
    const person = await prisma.person.findUniqueOrThrow({ where: { email } });
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');

    const bare = await verify(token);
    expect(bare.statusCode).toBe(401);
    expect(errorCode(bare)).toBe('PASSWORD_REQUIRED');
    const guessed = await verify(token, PASSWORD);
    expect(guessed.statusCode).toBe(401);
    expect(errorCode(guessed)).toBe('INVALID_CREDENTIALS');
    expect((await personOf(person.id)).emailVerifiedAt).toBeNull();
    // Jeton harcanmadı.
    expect((await prisma.oneTimeToken.findUniqueOrThrow({ where: { tokenHash: sha256(token) } })).usedAt).toBeNull();
    expect(errorCode(await login(app, email, ATTACKER_PASSWORD))).toBe('EMAIL_NOT_VERIFIED');
    expect(await prisma.session.count({ where: { personId: person.id } })).toBe(0);
  });

  it('kurtuluş yolu: kurban şifremi unuttum ile kendi şifresini koyar, adres doğrulanır, saldırganın şifresi ölür', async () => {
    const email = randomEmail('kurban');
    await post('/auth/register', { orgName: `Firma ${uniq()}`, name: 'Saldırgan', email, password: ATTACKER_PASSWORD, client: 'mobile' });
    const person = await prisma.person.findUniqueOrThrow({ where: { email } });
    await post('/auth/forgot-password', { identifier: email });
    const reset = tokenIn((await lastMailTo(email))?.body, 'reset-password');
    expect((await post('/auth/reset-password', { token: reset, password: 'KurbaninSifresi-77' })).statusCode).toBe(200);
    expect((await personOf(person.id)).emailVerifiedAt).not.toBeNull();
    expect(errorCode(await login(app, email, ATTACKER_PASSWORD))).toBe('INVALID_CREDENTIALS');
    expect((await login(app, email, 'KurbaninSifresi-77')).statusCode).toBe(200);
    // Saldırgan hiç giremedi: kişinin tek oturumu kurbanın.
    expect(await prisma.session.count({ where: { personId: person.id } })).toBe(1);
  });

  it('davet yolu: yönetici bağlantıyı kendisi açıp şifre koyar; davetli şifresiz açınca 401, yönetici davetli kimliğiyle giremez', async () => {
    const owner = await withVerification('false', () => registerOrg(app));
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const email = randomEmail('davetli');
    const invite = await post('/org/members/invite', { kind: 'EMAIL', email, name: 'Davetli' }, owner.headers);
    const inviteToken = /invite\/(\S+)$/.exec(invite.json().link)?.[1] as string;
    expect((await post(`/invites/${inviteToken}/accept`, { client: 'mobile', password: ATTACKER_PASSWORD })).statusCode).toBe(202);
    const person = await prisma.person.findUniqueOrThrow({ where: { email } });
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');

    expect(errorCode(await verify(token))).toBe('PASSWORD_REQUIRED');
    expect((await personOf(person.id)).emailVerifiedAt).toBeNull();
    expect(errorCode(await login(app, email, ATTACKER_PASSWORD))).toBe('EMAIL_NOT_VERIFIED');
    expect(await prisma.session.count({ where: { personId: person.id } })).toBe(0);
  });

  it('yanlış şifre girişteki kişi kovasına sayılır, doğru şifre payını geri verir; kova doluysa 429 ve jeton harcanmaz', async () => {
    const { email, personId } = await registerUnverified();
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');
    const key = `login:person:${personId}`;
    const count = async () => (await prisma.rateBucket.findUnique({ where: { key } }))?.count ?? 0;
    await verify(token, 'YanlisSifre123');
    expect(await count()).toBe(1);
    // Şifresiz istek tahmin değildir, sayılmaz.
    await verify(token);
    expect(await count()).toBe(1);

    await prisma.rateBucket.update({ where: { key }, data: { count: RATE_RULES.loginIdentity.limit } });
    const blocked = await verify(token, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect((await prisma.oneTimeToken.findUniqueOrThrow({ where: { tokenHash: sha256(token) } })).usedAt).toBeNull();

    await prisma.rateBucket.update({ where: { key }, data: { count: 3 } });
    const ok = await verify(token, PASSWORD);
    expect(ok.json().result).toBe('verified');
    expect(await count()).toBe(3);
  });

  it('IP ve ikili kova: tek IP aynı jetona en çok loginPair yanlış şifre dener', async () => {
    const { email } = await registerUnverified();
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');
    const ip = randomIp();
    for (let i = 0; i < RATE_RULES.loginPair.limit; i++) expect((await verify(token, `Tahmin${i}Sifre!`, ip)).statusCode).toBe(401);
    expect((await verify(token, PASSWORD, ip)).statusCode).toBe(429);
    expect((await verify(token, PASSWORD)).json().result).toBe('verified');
  });

  it('bekleyen adres onayı ve already şifre istemez', async () => {
    const owner = await withVerification('false', () => registerOrg(app));
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const pending = randomEmail('bekleyen');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    const token = tokenIn((await lastMailTo(pending))?.body, 'verify-email');
    expect((await verify(token)).json().result).toBe('changed');
    expect((await verify(token)).json().result).toBe('already');
  });

  it('zaten doğrulanmış adrese giden kullanılmamış bağlantı şifresiz verified döner', async () => {
    const { email, personId } = await registerUnverified();
    const token = tokenIn((await lastMailTo(email))?.body, 'verify-email');
    await prisma.person.update({ where: { id: personId }, data: { emailVerifiedAt: new Date() } });
    expect((await verify(token)).json().result).toBe('verified');
  });
});

describe('B1: bağlantıyı yeniden gönder (oturumsuz)', () => {
  it('yanıt her zaman aynı; posta yalnız doğrulanmamış mevcut adrese gider', async () => {
    const unverified = await registerUnverified();
    const verified = await registerOrg(app);
    await prisma.person.update({ where: { id: verified.personId }, data: { emailVerifiedAt: new Date() } });
    const verifiedBefore = (await mailsTo(verified.email as string)).length;

    const a = await post('/auth/resend-verification', { email: unverified.email.toUpperCase() });
    const b = await post('/auth/resend-verification', { email: verified.email });
    const c = await post('/auth/resend-verification', { email: randomEmail('yok') });
    for (const r of [a, b, c]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(a.body);
    }
    expect(a.json()).toEqual({ ok: true });
    expect((await mailsTo(unverified.email)).map((m) => m.template)).toEqual(['email_verify', 'email_verify']);
    expect(await mailsTo(verified.email as string)).toHaveLength(verifiedBefore);
  });

  it('bekleyen adrese bu uçtan posta gitmez', async () => {
    const owner = await registerOrg(app);
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    const pending = randomEmail('bekleyen');
    expect((await patchMe(owner, { email: pending, currentPassword: PASSWORD })).statusCode).toBe(200);
    const before = (await mailsTo(pending)).length;
    expect((await post('/auth/resend-verification', { email: pending })).statusCode).toBe(200);
    expect(await mailsTo(pending)).toHaveLength(before);
  });

  it('kimlik başına 3/saat aşılınca 429 (Y39: "gönderildi" denmez); IP başına 20/saat aşılınca 429', async () => {
    const { email } = await registerUnverified();
    for (let i = 0; i < RATE_RULES.verifyResendIdentity.limit; i++) {
      expect((await post('/auth/resend-verification', { email })).statusCode).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const limited = await post('/auth/resend-verification', { email });
      expect(limited.statusCode).toBe(429);
      expect(errorCode(limited)).toBe('TOO_MANY_ATTEMPTS');
    }
    // Kayıt postası + kimlik sınırı kadar; fazlası gitmez.
    expect(await mailsTo(email)).toHaveLength(1 + RATE_RULES.verifyResendIdentity.limit);

    // Varlığı ele vermez: kayıtsız adres de aynı sayıda istekten sonra aynı yanıtı alır.
    const nobody = randomEmail('yok');
    const replies: number[] = [];
    for (let i = 0; i < RATE_RULES.verifyResendIdentity.limit + 2; i++) replies.push((await post('/auth/resend-verification', { email: nobody })).statusCode);
    expect(replies).toEqual([...Array(RATE_RULES.verifyResendIdentity.limit).fill(200), 429, 429]);

    const ip = randomIp();
    for (let i = 0; i < RATE_RULES.verifyResendIp.limit; i++) {
      expect((await post('/auth/resend-verification', { email: randomEmail('ip') }, {}, ip)).statusCode).toBe(200);
    }
    const blocked = await post('/auth/resend-verification', { email: randomEmail('ip') }, {}, ip);
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
  });

  it('doğrulama jetonu tavanı dolunca en eski jeton silinir, yenisi gider: yeniden gönder hep çalışır', async () => {
    const { email, personId } = await registerUnverified();
    // Sınırlar ilgisiz: farklı IP'ler, kimlik kovası temiz.
    for (let i = 0; i < 4; i++) {
      await prisma.rateBucket.deleteMany({ where: { key: { startsWith: 'verifyResend:id:' } } });
      await prisma.rateBucket.deleteMany({ where: { key: `verify:mail:${personId}` } });
      await post('/auth/resend-verification', { email });
    }
    const mails = await mailsTo(email);
    expect(mails).toHaveLength(5);
    expect(await prisma.oneTimeToken.count({ where: { personId, kind: 'EMAIL_VERIFY', usedAt: null } })).toBe(MAX_ACTIVE_TOKENS);
    // En eski iki bağlantı yer açmak için silindi; üçüncü ve sonrası çalışır.
    expect(errorCode(await verify(tokenIn(mails[0].body, 'verify-email'), PASSWORD))).toBe('TOKEN_INVALID');
    expect(errorCode(await verify(tokenIn(mails[1].body, 'verify-email'), PASSWORD))).toBe('TOKEN_INVALID');
    expect((await verify(tokenIn(mails[2].body, 'verify-email'), PASSWORD)).json().result).toBe('verified');
  });

  it('girişteki kendiliğinden gönderim yeniden gönderme kovasını sayar: kişi sınırı dolmadan ekran 429 görür (Y39)', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const { email, personId } = await registerUnverified();
    const key = verifyResendKey(email);
    expect(key).toBe(`verifyResend:id:${identityKey(email)}`);
    const count = async () => (await prisma.rateBucket.findUnique({ where: { key } }))?.count ?? 0;
    // Yanlış şifre saymaz: şifreyi bilmeyen bu yoldan kovayı dolduramaz.
    expect(errorCode(await login(app, email, 'YanlisSifre123'))).toBe('INVALID_CREDENTIALS');
    expect(await count()).toBe(0);
    for (let i = 0; i < RATE_RULES.verifyResendIdentity.limit; i++) {
      expect(errorCode(await login(app, email))).toBe('EMAIL_NOT_VERIFIED');
      await flushMail();
      await prisma.oneTimeToken.deleteMany({ where: { personId } });
    }
    expect(await count()).toBe(RATE_RULES.verifyResendIdentity.limit);
    // Kayıt + 3 giriş = 4 posta; kişi sınırı (5) dolmadı ama ekran "gönderildi" demeden önce dürüstçe 429 alır.
    expect(await mailsTo(email)).toHaveLength(1 + RATE_RULES.verifyResendIdentity.limit);
    expect(1 + RATE_RULES.verifyResendIdentity.limit).toBeLessThan(RATE_RULES.verifyMailPerson.limit);
    const limited = await post('/auth/resend-verification', { email });
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe('TOO_MANY_ATTEMPTS');
    // Giriş yanıtı değişmez: kova dolu olsa da giriş yine EMAIL_NOT_VERIFIED.
    expect(errorCode(await login(app, email))).toBe('EMAIL_NOT_VERIFIED');
  });

  it('kişi başına doğrulama postası 5/saat: girişteki kendiliğinden gönderim de bu sınıra takılır', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const { email, personId } = await registerUnverified();
    // Jeton tavanı ilgisiz: her girişten sonra jetonlar silinir.
    for (let i = 0; i < RATE_RULES.verifyMailPerson.limit + 2; i++) {
      expect(errorCode(await login(app, email))).toBe('EMAIL_NOT_VERIFIED');
      await flushMail();
      await prisma.oneTimeToken.deleteMany({ where: { personId } });
    }
    expect(await mailsTo(email)).toHaveLength(RATE_RULES.verifyMailPerson.limit);
  });
});

describe('B2: e-posta değişikliği bekleyen adresle', () => {
  async function verifiedOwner() {
    const owner = await withVerification('false', () => registerOrg(app));
    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    return owner;
  }

  it('istek kimliği değiştirmez: eski adres girer, yeni adres giremez; onay postası yeni adrese, eski adrese yalnız "istek yapıldı" haberi', async () => {
    const owner = await verifiedOwner();
    const oldEmail = owner.email as string;
    const oldMails = (await mailsTo(oldEmail)).length;
    const next = randomEmail('yeni');

    const res = await patchMe(owner, { email: next.toUpperCase(), currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().me.person).toMatchObject({ email: oldEmail, emailVerified: true, pendingEmail: next });
    const row = await personOf(owner.personId);
    expect(row).toMatchObject({ email: oldEmail, pendingEmail: next });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect((await app.inject({ url: `${API}/me`, headers: owner.headers })).json().person.pendingEmail).toBe(next);

    expect((await mailsTo(next)).map((m) => m.template)).toEqual(['email_change_verify']);
    // Y37: eski adrese hemen haber gider; yeni adresi ve onay bağlantısını içermez.
    const oldNow = await mailsTo(oldEmail);
    expect(oldNow.slice(oldMails).map((m) => m.template)).toEqual(['email_change_requested']);
    const notice = oldNow[oldNow.length - 1];
    expect(notice.body).not.toContain(next);
    expect(notice.body).not.toContain('verify-email');
    expect(notice.body).toContain('/login');
    expect((await login(app, oldEmail)).statusCode).toBe(200);
    expect(errorCode(await login(app, next))).toBe('INVALID_CREDENTIALS');
    expect(await prisma.auditLog.count({ where: { action: 'person.email_change_requested', target: owner.personId, orgId: null } })).toBe(1);
  });

  it('istek haberi kişinin dilinde; yanlış şifrede ve mevcut adres yeniden yazılınca gitmez (Y37)', async () => {
    const owner = await verifiedOwner();
    const oldEmail = owner.email as string;
    await prisma.person.update({ where: { id: owner.personId }, data: { locale: 'en' } });
    const before = (await mailsTo(oldEmail)).length;
    expect(errorCode(await patchMe(owner, { email: randomEmail('yanlis'), currentPassword: 'YanlisSifre123' }))).toBe('INVALID_CREDENTIALS');
    expect((await patchMe(owner, { email: oldEmail, name: 'Aynı Adres' })).statusCode).toBe(200);
    expect(await mailsTo(oldEmail)).toHaveLength(before);

    expect((await patchMe(owner, { email: randomEmail('yeni'), currentPassword: PASSWORD })).statusCode).toBe(200);
    const notice = await lastMailTo(oldEmail);
    expect(notice?.template).toBe('email_change_requested');
    expect(notice?.subject).toBe('A change to your SellerOnData email address was requested');
    expect(await mailsTo(oldEmail)).toHaveLength(before + 1);
  });

  it('onay: adres değişir, eski adrese haber gider, eski adrese giden bütün bağlantılar ölür; sonuç changed', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    const owner = await verifiedOwner();
    const oldEmail = owner.email as string;
    await post('/auth/forgot-password', { identifier: oldEmail });
    const oldReset = tokenIn((await lastMailTo(oldEmail))?.body, 'reset-password');

    const next = randomEmail('yeni');
    await patchMe(owner, { email: next, currentPassword: PASSWORD });
    // Bekleyen istek, eski adresin sıfırlama bağlantısını öldürmez: eski adres hâlâ hesabın adresi.
    expect(await prisma.oneTimeToken.count({ where: { tokenHash: sha256(oldReset), usedAt: null } })).toBe(1);

    const confirm = await verify(tokenIn((await lastMailTo(next))?.body, 'verify-email'));
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json()).toEqual({ ok: true, result: 'changed' });
    const row = await personOf(owner.personId);
    expect(row).toMatchObject({ email: next, pendingEmail: null });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect((await lastMailTo(oldEmail))?.template).toBe('email_changed');
    expect(await prisma.auditLog.count({ where: { action: 'person.identity_changed', target: owner.personId } })).toBe(1);

    expect(errorCode(await post('/auth/reset-password', { token: oldReset, password: 'SifirSifre123!' }))).toBe('TOKEN_INVALID');
    expect(await prisma.oneTimeToken.count({ where: { personId: owner.personId, usedAt: null } })).toBe(0);
    expect((await login(app, next)).statusCode).toBe(200);
    expect(errorCode(await login(app, oldEmail))).toBe('INVALID_CREDENTIALS');
  });

  it('art arda iki değişiklik: eski bekleyen adrese giden bağlantı yenisini onaylayamaz', async () => {
    const owner = await verifiedOwner();
    const b = randomEmail('b');
    const c = randomEmail('c');
    await patchMe(owner, { email: b, currentPassword: PASSWORD });
    const tokenB = tokenIn((await lastMailTo(b))?.body, 'verify-email');
    await patchMe(owner, { email: c, currentPassword: PASSWORD });
    const tokenC = tokenIn((await lastMailTo(c))?.body, 'verify-email');

    expect(errorCode(await verify(tokenB))).toBe('TOKEN_INVALID');
    expect((await personOf(owner.personId)).pendingEmail).toBe(c);
    expect((await verify(tokenC)).json().result).toBe('changed');
    expect((await personOf(owner.personId)).email).toBe(c);
  });

  it('B adresine bağlı jeton, bekleyen adres B olmayınca yine geçmez (silinmemiş olsa da)', async () => {
    const owner = await verifiedOwner();
    const b = randomEmail('b');
    const c = randomEmail('c');
    await patchMe(owner, { email: c, currentPassword: PASSWORD });
    const stray = randomToken();
    await prisma.oneTimeToken.create({
      data: { personId: owner.personId, kind: 'EMAIL_VERIFY', email: b, tokenHash: sha256(stray), expiresAt: new Date(Date.now() + 3600_000) },
    });
    expect(errorCode(await verify(stray))).toBe('TOKEN_INVALID');
    expect(await personOf(owner.personId)).toMatchObject({ email: owner.email, pendingEmail: c });
  });

  it('adresi boş eski jeton kişinin o anki adresi sayılır: mevcut adresi doğrular, bekleyen değişikliği onaylayamaz', async () => {
    const owner = await registerOrg(app);
    const legacy = randomToken();
    await prisma.oneTimeToken.create({
      data: { personId: owner.personId, kind: 'EMAIL_VERIFY', tokenHash: sha256(legacy), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const pending = randomEmail('bekleyen');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    const res = await verify(legacy, PASSWORD);
    expect(res.json().result).toBe('verified');
    const row = await personOf(owner.personId);
    expect(row).toMatchObject({ email: owner.email, pendingEmail: pending });
    expect(row.emailVerifiedAt).not.toBeNull();
    // Bekleyen adresin bağlantısı yaşıyor.
    expect((await verify(tokenIn((await lastMailTo(pending))?.body, 'verify-email'))).json().result).toBe('changed');
  });

  it('başkasının adresi istenemez; istek sonrası başkası o adresle kayıt olduysa onay 409 EMAIL_TAKEN ve adres değişmez', async () => {
    const owner = await verifiedOwner();
    const other = await registerOrg(app);
    const taken = await patchMe(owner, { email: other.email, currentPassword: PASSWORD });
    expect(taken.statusCode).toBe(409);
    expect(errorCode(taken)).toBe('EMAIL_TAKEN');

    const wanted = randomEmail('yaris');
    await patchMe(owner, { email: wanted, currentPassword: PASSWORD });
    const token = tokenIn((await lastMailTo(wanted))?.body, 'verify-email');
    await registerOrg(app, { email: wanted });
    const res = await verify(token);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('EMAIL_TAKEN');
    expect(await personOf(owner.personId)).toMatchObject({ email: owner.email, pendingEmail: wanted });
  });

  it('eşzamanlı iki kişi aynı adresi onaylarsa biri kazanır, diğeri 409', async () => {
    const a = await verifiedOwner();
    const b = await verifiedOwner();
    const wanted = randomEmail('ikili');
    await patchMe(a, { email: wanted, currentPassword: PASSWORD });
    await flushMail();
    const tokenA = tokenIn((await lastMailTo(wanted))?.body, 'verify-email');
    await patchMe(b, { email: wanted, currentPassword: PASSWORD });
    await flushMail();
    const tokenB = tokenIn((await lastMailTo(wanted))?.body, 'verify-email');
    expect(tokenA).not.toBe(tokenB);
    const results = await Promise.all([verify(tokenA), verify(tokenB)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.person.count({ where: { email: wanted } })).toBe(1);
  });

  it('vazgeç: bekleyen adres ve bağlantısı silinir; tekrar çağrılabilir', async () => {
    const owner = await verifiedOwner();
    const pending = randomEmail('vazgec');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    const token = tokenIn((await lastMailTo(pending))?.body, 'verify-email');
    const del = () => app.inject({ method: 'DELETE', url: `${API}/me/pending-email`, headers: owner.headers });
    const first = await del();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect((await del()).statusCode).toBe(200);
    expect((await personOf(owner.personId)).pendingEmail).toBeNull();
    expect(errorCode(await verify(token))).toBe('TOKEN_INVALID');
  });

  it('yeniden gönder: bekleyen adrese, yoksa doğrulanmamış mevcut adrese, ikisi de yoksa null; 5/saat sonra 429', async () => {
    const owner = await registerOrg(app);
    const resend = () => post('/me/email/resend', {}, owner.headers);
    await flushMail();
    await prisma.rateBucket.deleteMany({ where: { key: `verify:mail:${owner.personId}` } });

    const current = await resend();
    expect(current.json()).toEqual({ ok: true, sentTo: 'current' });

    await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
    expect((await resend()).json()).toEqual({ ok: true, sentTo: null });

    const pending = randomEmail('tekrar');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    await flushMail();
    expect((await resend()).json()).toEqual({ ok: true, sentTo: 'pending' });
    expect((await mailsTo(pending)).map((m) => m.template)).toEqual(['email_change_verify', 'email_change_verify']);

    // Sayılanlar: current, null, PATCH postası, pending = 4. Beşinci geçer, altıncı 429.
    expect((await resend()).statusCode).toBe(200);
    const blocked = await resend();
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('TOO_MANY_ATTEMPTS');
  });

  it('bekleyen adrese sıfırlama ve davet postası gitmez; bekleyen adres kayıt ve daveti engellemez', async () => {
    const owner = await verifiedOwner();
    const pending = randomEmail('anahtar');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    await flushMail();
    const before = (await mailsTo(pending)).length;
    expect((await post('/auth/forgot-password', { identifier: pending })).statusCode).toBe(200);
    expect(await mailsTo(pending)).toHaveLength(before);
    // Davet bekleyen adresi tanımaz: "kişi var" sayılmaz, yeni kişi davetidir.
    const other = await verifiedOwner();
    const invite = await post('/org/members/invite', { kind: 'EMAIL', email: pending, name: 'Davetli' }, other.headers);
    expect(invite.statusCode).toBe(201);
    const preview = await app.inject({ url: `${API}/invites/${/invite\/(\S+)$/.exec(invite.json().link)?.[1]}`, remoteAddress: randomIp() });
    expect(preview.json().personExists).toBe(false);
  });

  it('adresi kaldırmak hemen uygulanır ve bekleyen adresi de temizler; OWNER kaldıramaz', async () => {
    const owner = await verifiedOwner();
    // Telefonu olsa da (tek kimlik kuralı geçse de) OWNER adresini kaldıramaz.
    await prisma.person.update({ where: { id: owner.personId }, data: { phone: randomTrPhone() } });
    const ownerRemove = await patchMe(owner, { email: null, currentPassword: PASSWORD });
    expect(errorCode(ownerRemove)).toBe('OWNER_REQUIRES_EMAIL');

    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const pending = randomEmail('kaldir');
    await patchMe(member, { email: pending, currentPassword: PASSWORD });
    const token = tokenIn((await lastMailTo(pending))?.body, 'verify-email');
    const res = await patchMe(member, { email: null, currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().me.person).toMatchObject({ email: null, pendingEmail: null, emailVerified: false });
    expect(errorCode(await verify(token))).toBe('TOKEN_INVALID');
    expect((await lastMailTo(member.email as string))?.template).toBe('email_changed');
  });

  it('e-postasız kişi bekleyen adresi onaylayınca adres kazanır; eski adres postası yok', async () => {
    const owner = await verifiedOwner();
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    const email = randomEmail('ilk');
    const res = await patchMe(worker, { email, currentPassword: PASSWORD });
    expect(res.json().me.person).toMatchObject({ email: null, pendingEmail: email });
    expect((await verify(tokenIn((await lastMailTo(email))?.body, 'verify-email'))).json().result).toBe('changed');
    const row = await personOf(worker.personId);
    expect(row).toMatchObject({ email, pendingEmail: null });
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it('telefon yalnız doğrulanmış e-posta varken kaldırılır: doğrulanmamış adres ya da yalnız bekleyen adres yetmez', async () => {
    const owner = await verifiedOwner();
    const removePhone = (ctx: Ctx) => patchMe(ctx, { phone: null, currentPassword: PASSWORD });

    // Doğrulanmamış mevcut adres: yanlış yazılmış olabilir, tek giriş yolu kaybolmasın.
    const phoneA = randomTrPhone();
    const unverified = await addMember(app, owner.orgId, { phone: phoneA });
    const denied = await removePhone(unverified);
    expect(denied.statusCode).toBe(400);
    expect(errorCode(denied)).toBe('VALIDATION');
    expect(denied.json().error.details[0]).toMatchObject({ path: 'phone', code: 'contact_required' });
    expect((await personOf(unverified.personId)).phone).toBe(phoneA);

    // Yalnız bekleyen adres: onaylanmadı, giriş yolu değil.
    const phoneB = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone: phoneB });
    await patchMe(worker, { email: randomEmail('bekleyen'), currentPassword: PASSWORD });
    expect(errorCode(await removePhone(worker))).toBe('VALIDATION');
    expect((await personOf(worker.personId)).phone).toBe(phoneB);

    // Doğrulanmış adres: kaldırılır.
    await prisma.person.update({ where: { id: unverified.personId }, data: { emailVerifiedAt: new Date() } });
    const ok = await removePhone(unverified);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().me.person.phone).toBeNull();
  });

  it('mevcut adresi yeniden yazmak değişiklik sayılmaz: şifre istemez, bekleyen adres kalır', async () => {
    const owner = await verifiedOwner();
    const pending = randomEmail('kalir');
    await patchMe(owner, { email: pending, currentPassword: PASSWORD });
    const res = await patchMe(owner, { email: owner.email, name: 'Ad Değişti' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().me.person).toMatchObject({ name: 'Ad Değişti', email: owner.email, pendingEmail: pending });
  });
});
