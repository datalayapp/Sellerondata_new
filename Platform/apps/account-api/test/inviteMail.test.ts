import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { JOIN_CODE_MAX_ATTEMPTS } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { configureMailer, flushMail, invitationMail } from '../src/lib/mailer.ts';
import { MAX_CODE_ATTEMPTS } from '../src/routes/join.ts';
import { API, addMember, getApp, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, uniq, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

const register = (over: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `${API}/auth/register`,
    remoteAddress: randomIp(),
    headers,
    payload: { orgName: `Firma ${uniq()}`, name: 'Sahip Kişi', email: randomEmail('sahip'), password: PASSWORD, country: 'TR', client: 'mobile', ...over },
  });

async function invite(who: { accessToken: string }, email: string, name = 'Davetli') {
  return app.inject({ method: 'POST', url: `${API}/org/members/invite`, headers: await asWeb(who), payload: { kind: 'EMAIL', email, name } });
}

async function verified() {
  const owner = await registerOrg(app);
  await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
  return owner;
}

const mailsTo = (email: string) => prisma.mailLog.count({ where: { to: email } });

/** ASCII metnin tam genişlik karşılığı (U+FF01..U+FF5E); kaynakta özel karakter tutulmaz. */
const fullWidth = (s: string) => [...s].map((c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)).join('');
const IDEO_DOT = String.fromCodePoint(0x3002);

describe('ad bağlantı içeremez (02-B4)', () => {
  it('firma adında bağlantı: 400 ve name_no_links', async () => {
    for (const orgName of ['Firma http://x.com', 'Git www.x.com', 'a://b']) {
      // Dil açıkça Türkçe: başlıksız istek İngilizce alır (karar 2026-11-12); burada sınanan metnin içeriği.
      const res = await register({ orgName }, { 'accept-language': 'tr' });
      expect(res.statusCode).toBe(400);
      const detail = res.json().error.details.find((d: { path: string }) => d.path === 'orgName');
      expect(detail.code).toBe('name_no_links');
      expect(detail.message).toBe('Ad bağlantı içeremez (http, www, ://).');
    }
  });

  it('kişi adında bağlantı: kayıtta ve davette 400', async () => {
    const res = await register({ name: 'Ali http://x.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.find((d: { path: string }) => d.path === 'name').code).toBe('name_no_links');

    const owner = await verified();
    const inv = await invite(owner, randomEmail('davetli'), 'HTTPS://kotu.com');
    expect(inv.statusCode).toBe(400);
    expect(inv.json().error.details.find((d: { path: string }) => d.path === 'name').code).toBe('name_no_links');
  });

  it('"firma.com" gibi ad serbest', async () => {
    const res = await register({ orgName: 'firma.com Lojistik', name: 'Ali firma.com' });
    expect(res.statusCode).toBe(201);
  });

  it('tam genişlik ve ideografik noktalı bağlantı da reddedilir (Y36): kayıt, davet, profil, firma', async () => {
    for (const orgName of [`Firma ${fullWidth('www.')}kotu`, `${fullWidth('https://')}x`, `Git www${IDEO_DOT}kotu`]) {
      const res = await register({ orgName });
      expect(res.statusCode, orgName).toBe(400);
      expect(res.json().error.details.find((d: { path: string }) => d.path === 'orgName').code).toBe('name_no_links');
    }
    const owner = await verified();
    const inv = await invite(owner, randomEmail('davetli'), `Ali ${fullWidth('http:')}kotu`);
    expect(inv.json().error.details.find((d: { path: string }) => d.path === 'name').code).toBe('name_no_links');
    const me = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { name: `${fullWidth('www.')}x` } });
    expect(me.statusCode).toBe(400);
    expect(me.json().error.details.find((d: { path: string }) => d.path === 'name').code).toBe('name_no_links');
    const org = await app.inject({ method: 'PATCH', url: `${API}/org`, headers: await asWeb(owner), payload: { name: `${fullWidth('www.')}x` } });
    expect(org.statusCode).toBe(400);
    expect(org.json().error.details.find((d: { path: string }) => d.path === 'name').code).toBe('name_no_links');
  });

  it('gerçek firma adları serbest: "Örnek A.Ş.", "3M", "Kargo.com Lojistik", "San.Tic.Ltd.Şti."', async () => {
    for (const orgName of ['Örnek A.Ş.', '3M', 'Kargo.com Lojistik', 'Örnek San.Tic.Ltd.Şti.']) {
      const res = await register({ orgName });
      expect(res.statusCode, orgName).toBe(201);
    }
  });

  it('kuraldan önce yazılmış ad kırılmaz: ad gönderilmeyen güncelleme geçer', async () => {
    const owner = await verified();
    await prisma.person.update({ where: { id: owner.personId }, data: { name: `Eski ${fullWidth('www.')}ad` } });
    const res = await app.inject({ method: 'PATCH', url: `${API}/me`, headers: owner.headers, payload: { locale: 'en' } });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('davet postasında ad bağlantı olmaz (Y36)', () => {
  it('çıplak alan adı ve tam genişlik ad postada tıklanır bağlantıya dönmez; Türkçe kısaltma aynen kalır', () => {
    const tr = invitationMail('a@x.co', 'tr', { orgName: 'Kargo.com Lojistik', inviterName: `${fullWidth('kotu.com')}`, url: 'http://x/y' });
    expect(tr.text).toContain('“kotu. com” sizi SellerOnData üzerinde “Kargo. com Lojistik” firmasına davet etti.');
    expect(tr.html).toContain('“kotu. com” sizi SellerOnData üzerinde “Kargo. com Lojistik” firmasına davet etti.');
    expect(tr.text).not.toMatch(/kargo\.com|kotu\.com/i);
    const en = invitationMail('a@x.co', 'en', { orgName: 'Örnek A.Ş.', inviterName: 'Ayşe', url: 'u' });
    expect(en.text).toContain('“Ayşe” invited you to join “Örnek A.Ş.” on SellerOnData.');
    // Kuraldan önce yazılmış bağlantılı ad da etkisizleşir.
    const legacy = invitationMail('a@x.co', 'tr', { orgName: 'Git www.kotu.com', inviterName: 'http://kotu.com', url: 'u' });
    expect(legacy.text).toContain('“http: //kotu. com” sizi SellerOnData üzerinde “Git www. kotu. com” firmasına');
  });
});

describe('davet postası metni', () => {
  it('adlar tırnak içinde; uzun ad 60 karakter ve …', () => {
    const long = 'U'.repeat(80);
    const tr = invitationMail('a@x.co', 'tr', { orgName: long, inviterName: 'Ayşe', url: 'http://x/y' });
    const body = tr.html as string;
    expect(body).toContain(`“Ayşe” sizi SellerOnData üzerinde “${'U'.repeat(60)}…” firmasına davet etti. Bağlantı yedi gün geçerlidir.`);
    expect(body).not.toContain('U'.repeat(61));
    expect(tr.subject).toBe('SellerOnData üzerinde bir firmaya davet edildiniz');
    const en = invitationMail('a@x.co', 'en', { orgName: 'Acme', inviterName: 'V'.repeat(61), url: 'u' });
    expect(en.html).toContain(`“${'V'.repeat(60)}…” invited you to join “Acme” on SellerOnData. The link works for seven days.`);
  });
});

describe('davet eden doğrulanmış olmalı, kişi başına sınır', () => {
  it('doğrulanmamış yönetici: mailSent false, davet oluşur, MailLog yok', async () => {
    const owner = await registerOrg(app);
    await flushMail();
    configureMailer();
    const email = randomEmail('davetli');
    const res = await invite(owner, email);
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(false);
    expect(res.json().link).toContain('/invite/');
    await flushMail();
    expect(await mailsTo(email)).toBe(0);
  });

  it('yalnız telefonlu yönetici: mailSent false, MailLog yok; yeniden gönderme de aynı', async () => {
    const owner = await verified();
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN', email: null, phone: randomTrPhone() });
    const email = randomEmail('davetli');
    const res = await invite(admin, email);
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(false);
    const again = await app.inject({ method: 'POST', url: `${API}/org/invitations/${res.json().invitation.id}/resend`, headers: await asWeb(admin) });
    expect(again.statusCode).toBe(200);
    expect(again.json().mailSent).toBe(false);
    await flushMail();
    expect(await mailsTo(email)).toBe(0);
  });

  it('doğrulanmış yönetici: posta gider', async () => {
    const owner = await verified();
    const email = randomEmail('davetli');
    const res = await invite(owner, email);
    expect(res.json().mailSent).toBe(true);
    await flushMail();
    expect(await mailsTo(email)).toBe(1);
  });

  it('51. davet postası gitmez (hata değil, mailSent false)', async () => {
    const owner = await verified();
    await prisma.rateBucket.create({ data: { key: `invite:mailby:${owner.personId}`, count: 50, windowEnd: new Date(Date.now() + 3600_000) } });
    const email = randomEmail('davetli');
    const res = await invite(owner, email);
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(false);
    expect(res.json().link).toContain('/invite/');
    await flushMail();
    expect(await mailsTo(email)).toBe(0);
  });
});

describe('yeniden gönderme ve deneme hakkı', () => {
  it('altı hatalı denemeden sonra yeniden gönderme çalışır (eşik join ile aynı sabit)', async () => {
    expect(MAX_CODE_ATTEMPTS).toBeGreaterThan(6);
    const owner = await registerOrg(app);
    const res = await app.inject({ method: 'POST', url: `${API}/org/members/invite`, headers: await asWeb(owner), payload: { kind: 'PHONE_CODE', phone: randomTrPhone(), name: 'Telefonlu' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().invitation.id as string;
    await prisma.invitation.update({ where: { id }, data: { attempts: 6 } });
    const again = await app.inject({ method: 'POST', url: `${API}/org/invitations/${id}/resend`, headers: await asWeb(owner) });
    expect(again.statusCode).toBe(200);
    await prisma.invitation.update({ where: { id }, data: { attempts: MAX_CODE_ATTEMPTS } });
    const exhausted = await app.inject({ method: 'POST', url: `${API}/org/invitations/${id}/resend`, headers: await asWeb(owner) });
    expect(exhausted.statusCode).toBe(409);
    // Y34: Ekip ekranı tükenmiş kodu listeden tanır (`attempts` ≥ sözleşmedeki sınır) ve "iptal et ve yeniden davet et" der.
    expect(MAX_CODE_ATTEMPTS).toBe(JOIN_CODE_MAX_ATTEMPTS);
    const list = await app.inject({ url: `${API}/org/invitations`, headers: owner.headers });
    const row = list.json().invitations.find((i: { id: string }) => i.id === id);
    expect(row).toMatchObject({ kind: 'PHONE_CODE', attempts: JOIN_CODE_MAX_ATTEMPTS });
  });
});
