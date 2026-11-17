// Tur 3 regresyonları: istenen davranışı doğrular. Düşen test bulgudur.
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { releasePhone } from '../src/lib/support.ts';
import { addMember, API, errorCode, getApp, login, PASSWORD, randomEmail, randomIp, randomTrPhone, registerOrg, webHeadersFrom, isOrgWrite } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Firma yazması tarayıcı oturumuyla (KARARLAR "Firma yönetimi yalnız tarayıcıdan"): Bearer ikiz web oturumuna çevrilir.
const call = async (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({
    method: method as 'POST',
    url: `${API}${url}`,
    remoteAddress: randomIp(),
    headers: isOrgWrite(method, url) ? await webHeadersFrom(headers) : headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

describe('phone:release ve kimliksiz kişi', () => {
  it('komutun HTTP yolu yok, API ile suspendedAt yazılamaz, kimliksiz kişi açılamaz', async () => {
    const routes = (app as unknown as { sodRoutes: string[] }).sodRoutes;
    expect(routes.filter((r) => /release|support|suspend/i.test(r))).toEqual([]);

    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    const res = await call('PATCH', '/me', worker.headers, { phone: null, currentPassword: PASSWORD, suspendedAt: new Date().toISOString() });
    expect(res.statusCode).toBe(400);
    const row = await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } });
    expect(row.phone).toBe(phone);
    expect(row.suspendedAt).toBeNull();

    const named = await call('PATCH', '/me', worker.headers, { name: 'Yeni Ad', suspendedAt: new Date().toISOString(), phoneVerifiedAt: new Date().toISOString() });
    expect(named.statusCode).toBe(200);
    const after = await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } });
    expect(after.suspendedAt).toBeNull();
    expect(after.phoneVerifiedAt).toBeNull();

    // Veritabanı askısız kimliksiz kişiyi reddeder.
    await expect(prisma.person.update({ where: { id: worker.personId }, data: { phone: null } })).rejects.toThrow();
  });

  it('askıya alınan kişide eşzamanlı giriş oturum bırakmaz', async () => {
    let logins = 0;
    let survivors = 0;
    for (let i = 0; i < 16; i++) {
      const owner = await registerOrg(app);
      const phone = randomTrPhone();
      await addMember(app, owner.orgId, { email: null, phone });
      const started = login(app, phone);
      await sleep(10 + i * 12);
      await releasePhone(phone, { operator: 'test' });
      const l = await started;
      if (l.statusCode !== 200) continue;
      logins += 1;
      const r = await call('POST', '/auth/refresh', {}, { refreshToken: l.json().refreshToken });
      if (r.statusCode === 200) survivors += 1;
    }
    console.log('[KANIT] askı + giriş: başarılı giriş', logins, 'askı sonrası yaşayan oturum', survivors);
    expect(survivors).toBe(0);
  }, 180_000);

  it('askıdaki kişinin üyeliği yeniden etkinleştirilirse şifre kodu izni görünmez, davetler bozulmaz', async () => {
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    await releasePhone(phone, { operator: 'test' });
    const pendingMail = await call('POST', '/org/members/invite', owner.headers, { kind: 'EMAIL', email: randomEmail('bekleyen') });
    expect(pendingMail.statusCode).toBe(201);

    const reactivate = await call('PATCH', `/org/members/${worker.membershipId}`, owner.headers, { status: 'ACTIVE' });
    const list = await call('GET', '/org/members', owner.headers);
    const row = list.json().members.find((m: { id: string }) => m.id === worker.membershipId);
    const code = await call('POST', `/org/members/${worker.membershipId}/reset-code`, owner.headers, {});
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: pendingMail.json().invitation.id } });
    console.log('[KANIT] askı + etkinleştirme:', reactivate.statusCode, 'resetCodeAllowed', row?.resetCodeAllowed, 'kod', code.statusCode, errorCode(code), 'e-posta daveti iptal', inv.revokedAt !== null);
    expect(code.statusCode).toBeLessThan(500);
    expect(inv.revokedAt).toBeNull();
    expect(row?.resetCodeAllowed).toBe(false);
    expect(code.json().error?.code).toBe('RESET_CODE_NOT_ALLOWED');
  });
});

describe('ölü kilit taraması', () => {
  it('karışık uçlar: 500 yok', async () => {
    const saved = process.env.REFRESH_REUSE_GRACE_SECONDS;
    process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
    const tally: Record<string, number> = {};
    const note = (name: string, r: { statusCode: number; json: () => unknown }) => {
      if (r.statusCode < 400) return;
      const k = `${name} ${r.statusCode} ${(r.json() as { error?: { code?: string } }).error?.code ?? ''}`;
      tally[k] = (tally[k] ?? 0) + 1;
    };
    try {
      for (let i = 0; i < 14; i++) {
        const owner = await registerOrg(app);
        const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
        const member = await addMember(app, owner.orgId);
        const leaver = await addMember(app, owner.orgId);
        const phone = randomTrPhone();
        const worker = await addMember(app, owner.orgId, { email: null, phone });
        const { code } = (await call('POST', `/org/members/${worker.membershipId}/reset-code`, owner.headers, {})).json();
        const firstRefresh = await call('POST', '/auth/refresh', {}, { refreshToken: member.refreshToken });
        const newest = firstRefresh.json().refreshToken;
        const ops: [string, Promise<{ statusCode: number; json: () => unknown }>][] = [
          ['şifre-üye', call('POST', '/me/password', member.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' })],
          ['şifre-yönetici', call('POST', '/me/password', admin.headers, { currentPassword: PASSWORD, newPassword: 'CokYeniSifre123!' })],
          ['askı-üye', call('PATCH', `/org/members/${member.membershipId}`, owner.headers, { status: 'SUSPENDED' })],
          ['çıkar-üye', call('DELETE', `/org/members/${member.membershipId}`, owner.headers)],
          ['rol-çalışan', call('PATCH', `/org/members/${worker.membershipId}`, owner.headers, { orgRole: 'ADMIN' })],
          ['kod-kabul', call('POST', '/auth/join/accept', {}, { phone, code, password: 'CalisanSifre123!', client: 'mobile' })],
          ['devir', call('POST', '/org/transfer-ownership', owner.headers, { membershipId: admin.membershipId, password: PASSWORD })],
          ['ayrıl', call('POST', '/org/leave', leaver.headers, {})],
          ['çıkış-yönetici', call('POST', '/auth/logout', {}, { refreshToken: admin.refreshToken })],
          ['tekrar-yenile', call('POST', '/auth/refresh', {}, { refreshToken: member.refreshToken })],
          ['yenile', call('POST', '/auth/refresh', {}, { refreshToken: newest })],
          ['davet', call('POST', '/org/members/invite', admin.headers, { kind: 'EMAIL', email: randomEmail('tarama') })],
        ];
        await sleep(i * 6);
        for (const [name, p] of ops) note(name, await p);
        const owners = await prisma.membership.count({ where: { orgId: owner.orgId, orgRole: 'OWNER', status: 'ACTIVE' } });
        expect(owners).toBe(1);
      }
    } finally {
      process.env.REFRESH_REUSE_GRACE_SECONDS = saved;
    }
    console.log('[KANIT] tarama hata dağılımı:', JSON.stringify(tally));
    expect(Object.keys(tally).filter((k) => / 5\d\d /.test(k))).toEqual([]);
    expect(Object.keys(tally).filter((k) => /CONFLICT/.test(k))).toEqual([]);
  }, 300_000);
});
