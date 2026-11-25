import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { prisma } from '../src/db.ts';
import { lockMemberships } from '../src/lib/members.ts';
import { refreshSession } from '../src/lib/sessions.ts';
import { releasePhone, restorePerson } from '../src/lib/support.ts';
import { addMember, API, claimsOf, errorCode, getApp, login, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, asWeb, webHeadersFrom, isOrgWrite } from './helpers.ts';
import { TEST_APP_URL } from './testEnv.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const post = async (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers: isOrgWrite('POST', url) ? await webHeadersFrom(headers) : headers, payload });
const META = { ip: '10.9.9.9', userAgent: null };

async function suspendedWorker() {
  const owner = await registerOrg(app);
  const phone = randomTrPhone();
  const worker = await addMember(app, owner.orgId, { email: null, phone, deciship: 'MEASURE' });
  return { owner, phone, worker };
}

describe('askıdaki kişi oturum alamaz', () => {
  it('giriş kilit altında suspendedAt görür: doğrulanmış şifre de geçmez', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await prisma.person.update({ where: { id: member.personId }, data: { suspendedAt: new Date() } });
    const res = await login(app, member.email as string);
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
  });

  it('yenileme suspendedAt görür', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    await prisma.person.update({ where: { id: member.personId }, data: { suspendedAt: new Date() } });
    const res = await post('/auth/refresh', {}, { refreshToken: member.refreshToken });
    expect(res.statusCode).toBe(401);
    expect(await prisma.$transaction((tx) => refreshSession(tx, member.refreshToken, META))).toEqual({ kind: 'invalid' });
  });

  it('kod kabulü: askıdaki kişi numarayla katılamaz, oturumlu bağlama yapamaz', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    const other = await registerOrg(app);
    const { code } = (await post('/org/members/invite', other.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).json();
    await prisma.person.update({ where: { id: worker.personId }, data: { suspendedAt: new Date() } });
    const res = await post('/auth/join/accept', {}, { phone, code, password: PASSWORD, client: 'mobile' });
    expect(res.statusCode).toBe(401);
    expect(await prisma.membership.count({ where: { personId: worker.personId, orgId: other.orgId } })).toBe(0);

    const linker = await registerOrg(app);
    const phone2 = randomTrPhone();
    const inv = (await post('/org/members/invite', other.headers, { kind: 'PHONE_CODE', phone: phone2, name: 'Y' })).json();
    await prisma.person.update({ where: { id: linker.personId }, data: { suspendedAt: new Date() } });
    const linked = await post('/auth/join/accept', linker.headers, { phone: phone2, code: inv.code, password: PASSWORD, client: 'mobile', linkCurrentAccount: true });
    expect(linked.statusCode).toBe(401);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: linker.personId } })).phone).toBeNull();
  });

  it('e-posta daveti: askıdaki kişi kabul edemez', async () => {
    const owner = await registerOrg(app);
    const invited = await registerOrg(app);
    const { link } = (await post('/org/members/invite', owner.headers, { kind: 'EMAIL', email: invited.email, name: 'X' })).json();
    const token = /invite\/(\S+)$/.exec(link)?.[1] as string;
    await prisma.person.update({ where: { id: invited.personId }, data: { suspendedAt: new Date() } });
    const res = await post(`/invites/${token}/accept`, invited.headers);
    expect(res.statusCode).toBe(401);
    expect(await prisma.membership.count({ where: { personId: invited.personId, orgId: owner.orgId } })).toBe(0);
  });

  it('şifre kodu kabulü: askıdaki kişiye şifre belirlenemez', async () => {
    const { owner, phone, worker } = await suspendedWorker();
    const { code } = (await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers)).json();
    await prisma.person.update({ where: { id: worker.personId }, data: { suspendedAt: new Date() } });
    expect(errorCode(await post('/auth/join/accept', {}, { phone, code, password: 'YeniMavi-Kedi-81', client: 'mobile' }))).toBe('INVITE_INVALID');
  });
});

describe('phone:release oturumları düşürür', () => {
  it('başka girişi olan kişide de: oturum ve açık jeton düşer, sonra e-postayla girer', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const epoch = (await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).epoch;
    const result = await releasePhone(phone, { operator: 'test' });
    expect(result.suspended).toBe(false);
    expect((await post('/auth/refresh', {}, { refreshToken: member.refreshToken })).statusCode).toBe(401);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: member.membershipId } })).epoch).toBe(epoch + 1);
    expect((await login(app, member.email as string)).statusCode).toBe(200);
  });

  it('operator zorunlu', async () => {
    await expect(releasePhone(randomTrPhone(), { operator: '  ' })).rejects.toThrow(/operator/);
  });
});

describe('askıdaki kişinin üyeliği', () => {
  it('etkinleştirme anlamlı hata verir, listede şifre kodu izni yok', async () => {
    const { owner, phone, worker } = await suspendedWorker();
    await releasePhone(phone, { operator: 'test' });
    const res = await app.inject({ method: 'PATCH', url: `${API}/org/members/${worker.membershipId}`, headers: await asWeb(owner), payload: { status: 'ACTIVE' } });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('PERSON_SUSPENDED');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } })).status).toBe('SUSPENDED');
    const list = await app.inject({ url: `${API}/org/members`, headers: owner.headers });
    const row = list.json().members.find((m: { id: string }) => m.id === worker.membershipId);
    expect(row).toMatchObject({ resetCodeAllowed: false, personSuspended: true });
    const code = await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers);
    expect(errorCode(code)).toBe('RESET_CODE_NOT_ALLOWED');
  });

  it('elle etkin bırakılmış üyelikte de izin yok', async () => {
    const { owner, worker } = await suspendedWorker();
    await prisma.person.update({ where: { id: worker.personId }, data: { suspendedAt: new Date() } });
    const list = await app.inject({ url: `${API}/org/members`, headers: owner.headers });
    expect(list.json().members.find((m: { id: string }) => m.id === worker.membershipId).resetCodeAllowed).toBe(false);
    expect(errorCode(await post(`/org/members/${worker.membershipId}/reset-code`, owner.headers))).toBe('RESET_CODE_NOT_ALLOWED');
  });
});

describe('phone:restore', () => {
  it('askıyı kaldırır, numarayı yazar, yalnız komutun askıya aldığı üyelikleri açar, iz bırakır', async () => {
    const { owner, phone, worker } = await suspendedWorker();
    const other = await registerOrg(app);
    const earlier = await prisma.membership.create({ data: { personId: worker.personId, orgId: other.orgId, status: 'SUSPENDED' } });
    await releasePhone(phone, { operator: 'test' });

    const result = await restorePerson(worker.personId, { phone, operator: 'test' });
    expect(result).toEqual({ personId: worker.personId, reactivated: 1 });
    const person = await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } });
    expect(person).toMatchObject({ phone, suspendedAt: null });
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: worker.membershipId } })).status).toBe('ACTIVE');
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: earlier.id } })).status).toBe('SUSPENDED');
    const res = await login(app, phone);
    expect(res.statusCode).toBe(200);
    expect(claimsOf(res.json().accessToken).org).toBe(owner.orgId);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'support.phone_restored', target: worker.personId } });
    expect(audit.meta).toMatchObject({ phoneLast4: phone.slice(-4), operator: 'test', reactivated: 1 });
  });

  it('kişi askıda değilse, numara yoksa, numara başkasınınsa veya operator yoksa durur', async () => {
    const { phone, worker } = await suspendedWorker();
    await expect(restorePerson(worker.personId, { phone, operator: 'test' })).rejects.toThrow(/askıda değil/);
    await releasePhone(phone, { operator: 'test' });
    await expect(restorePerson(worker.personId, { operator: 'test' })).rejects.toThrow(/telefon/i);
    await expect(restorePerson(worker.personId, { phone, operator: ' ' })).rejects.toThrow(/operator/);
    const owner = await registerOrg(app);
    const other = await addMember(app, owner.orgId, { email: null, phone: randomTrPhone() });
    await expect(restorePerson(worker.personId, { phone: other.phone as string, operator: 'test' })).rejects.toThrow(/başka/);
    await expect(restorePerson('olmayan-kisi', { phone, operator: 'test' })).rejects.toThrow(/bulunamadı/);
  });
});

describe('kilit sırası, davranış', () => {
  it('lockMemberships tutarken sahip kişi satırı kilitlidir: başka işlem kişiyi alamaz', async () => {
    const owner = await registerOrg(app);
    const member = await addMember(app, owner.orgId);
    const client = new pg.Client({ connectionString: TEST_APP_URL });
    await client.connect();
    try {
      await prisma.$transaction(async (tx) => {
        await lockMemberships(tx, [member.membershipId]);
        await client.query('BEGIN');
        await expect(client.query(`SELECT 1 FROM platform."Person" WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [member.personId])).rejects.toMatchObject({ code: '55P03' });
        await client.query('ROLLBACK');
      });
      // Bırakınca serbest.
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM platform."Person" WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [member.personId]);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});

describe('numara kapma izi', () => {
  it('kodla yeni hesap açan da person.phone_linked izi bırakır, son 4 hane', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const { code } = (await post('/org/members/invite', owner.headers, { kind: 'PHONE_CODE', phone, name: 'Yeni' })).json();
    const res = await post('/auth/join/accept', {}, { phone, code, password: 'MaviKedi-4729', client: 'mobile' });
    expect(res.statusCode).toBe(201);
    const person = await prisma.person.findUniqueOrThrow({ where: { phone } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'person.phone_linked', actorPersonId: person.id } });
    expect(audit.orgId).toBe(owner.orgId);
    expect(audit.meta).toMatchObject({ phoneLast4: phone.slice(-4), personCreated: true });
    expect(JSON.stringify(audit.meta)).not.toContain(phone);
  });

  it('kayıtlı numarayla mevcut şifre onayında iz yok: numara zaten onundu', async () => {
    const firm = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, firm.orgId, { email: null, phone });
    const other = await registerOrg(app);
    const { code } = (await post('/org/members/invite', other.headers, { kind: 'PHONE_CODE', phone, name: 'X' })).json();
    expect((await post('/auth/join/accept', {}, { phone, code, password: PASSWORD, client: 'mobile' })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'person.phone_linked', actorPersonId: worker.personId } })).toBe(0);
  });
});

void randomEmail;
