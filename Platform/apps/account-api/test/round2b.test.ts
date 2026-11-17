import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { addMember, API, cookieHeader, errorCode, getApp, login, parseSetCookies, PASSWORD, randomIp, randomTrPhone, registerOrg, webHeaders } from './helpers.ts';
let app: FastifyInstance;
beforeAll(async () => { app = await getApp(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as 'POST', url: `${API}${url}`, remoteAddress: randomIp(), headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('X-SOD-Org ek', () => {
  it('yinelenen başlık uyuşmaz; üyeliği biten doğru başlıkla TOKEN_STALE; firmasız çerez ORG_REQUIRED', async () => {
    const owner = await registerOrg(app);
    const m = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const c = parseSetCookies(await login(app, m.email as string, PASSWORD, 'web'));
    const cookie = cookieHeader({ sod_at: c.sod_at });
    const dup = await call('PATCH', '/org', { ...webHeaders(cookie), 'x-sod-org': `${owner.orgId}, ${owner.orgId}` }, { locale: 'en' });
    expect(errorCode(dup)).toBe('ORG_MISMATCH');
    await prisma.membership.delete({ where: { id: m.membershipId } });
    const stale = await call('PATCH', '/org', { ...webHeaders(cookie), 'x-sod-org': owner.orgId }, { locale: 'en' });
    expect(errorCode(stale)).toBe('TOKEN_STALE');
    const c2 = parseSetCookies(await login(app, m.email as string, PASSWORD, 'web'));
    const noOrg = await call('PATCH', '/org', webHeaders(cookieHeader({ sod_at: c2.sod_at })), { locale: 'en' });
    expect(errorCode(noOrg)).toBe('ORG_REQUIRED');
  });
});

describe('devir ve e-posta silme, iki yönlü', () => {
  it('e-postasız OWNER oluşmaz', async () => {
    const tally: Record<string, number> = {};
    let bad = 0;
    for (let i = 0; i < 30; i++) {
      const owner = await registerOrg(app);
      const t = await addMember(app, owner.orgId, { phone: randomTrPhone() });
      const delay = (i % 15) * 8;
      const first = i % 2 === 0;
      const a = first ? call('PATCH', '/me', t.headers, { email: null, currentPassword: PASSWORD }) : call('POST', '/org/transfer-ownership', owner.headers, { membershipId: t.membershipId, password: PASSWORD });
      await sleep(delay);
      const b = first ? call('POST', '/org/transfer-ownership', owner.headers, { membershipId: t.membershipId, password: PASSWORD }) : call('PATCH', '/me', t.headers, { email: null, currentPassword: PASSWORD });
      const [ra, rb] = await Promise.all([a, b]);
      const [tr, drop] = first ? [rb, ra] : [ra, rb];
      const k = `devir ${tr.statusCode} ${errorCode(tr) ?? ''}/sil ${drop.statusCode} ${errorCode(drop) ?? ''}`;
      tally[k] = (tally[k] ?? 0) + 1;
      const row = await prisma.membership.findUniqueOrThrow({ where: { id: t.membershipId }, include: { person: true } });
      if (row.orgRole === 'OWNER' && !row.person.email) bad += 1;
    }
    console.log('[KANIT] iki yönlü:', JSON.stringify(tally), 'e-postasız OWNER:', bad);
    expect(bad).toBe(0);
  }, 240_000);
});

describe('şifre sıfırlama ile eşzamanlı giriş', () => {
  it('sıfırlama sırasında başlayan eski şifreli giriş oturum bırakmaz', async () => {
    let survivors = 0; let ok = 0;
    for (let i = 0; i < 12; i++) {
      const owner = await registerOrg(app);
      const token = `tok${Date.now()}${i}`;
      const { sha256 } = await import('../src/lib/crypto.ts');
      await prisma.oneTimeToken.create({ data: { personId: owner.personId, kind: 'PASSWORD_RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
      const reset = call('POST', '/auth/reset-password', {}, { token, password: 'CokYeniSifre123!' });
      await sleep(20 + i * 15);
      const l = await login(app, owner.email as string);
      expect((await reset).statusCode).toBe(200);
      if (l.statusCode !== 200) continue;
      ok += 1;
      if ((await call('POST', '/auth/refresh', {}, { refreshToken: l.json().refreshToken })).statusCode === 200) survivors += 1;
    }
    console.log('[KANIT] sıfırlama: eski şifreyle giriş', ok, 'yaşayan', survivors);
    expect(survivors).toBe(0);
  }, 180_000);
});
