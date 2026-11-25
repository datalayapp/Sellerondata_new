import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STEP_UP_HEADER } from '@sellerondata/contracts';
import { disconnectPrisma } from '../src/db.ts';
import { bearer, closeSuper, cookie, createTestAccount, fakeKey, fakeProvider, makeApp, OPERATOR, resetKeys, stepUpHeader, type TestAccount } from './helpers.ts';

/**
 * Yönetici uçlarının yetkisi: jetonsuz ve yanlış jetonlu istek 401; `op` olmadan 403 FORBIDDEN; değiştiren uçlar adım artırma
 * jetonu olmadan 403 STEP_UP_REQUIRED (eksik, süresi dolmuş, başka kişinin, başka oturumun, yanlış kitlenin, `op`'suz, uzun ömürlü).
 */

let account: TestAccount;
let app: FastifyInstance;
const provider = fakeProvider();

beforeAll(async () => {
  account = await createTestAccount();
  app = await makeApp(account, { fetch: provider.fetch });
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetKeys);

const put = (headers: Record<string, string>, key = fakeKey()) =>
  app.inject({ method: 'PUT', url: '/api/ai/admin/keys/anthropic', headers: { ...headers, 'content-type': 'application/json' }, payload: { key } });

describe('kimlik (401)', () => {
  it('jetonsuz, bozuk, yabancı imzalı, yanlış kitleli, yanlış yayıncılı ve süresi dolmuş jeton: 401', async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, 'UNAUTHORIZED'],
      [{ authorization: 'Bearer' }, 'UNAUTHORIZED'],
      [{ authorization: 'Basic abc' }, 'UNAUTHORIZED'],
      [bearer('bozuk.jeton.degeri'), 'UNAUTHORIZED'],
      [bearer(await account.access({ op: true, foreignKey: true })), 'UNAUTHORIZED'],
      [bearer(await account.access({ op: true, audience: 'product-events' })), 'UNAUTHORIZED'],
      [bearer(await account.access({ op: true, issuer: 'baska-yayinci' })), 'UNAUTHORIZED'],
      [bearer(await account.access({ op: true, expiresInSeconds: -60 })), 'TOKEN_EXPIRED'],
      // Adım artırma jetonu erişim jetonu yerine geçmez (kitle `ai-admin`).
      [bearer(await account.stepUp()), 'UNAUTHORIZED'],
    ];
    for (const [headers, code] of cases) {
      for (const req of [
        { method: 'GET' as const, url: '/api/ai/admin/keys' },
        { method: 'POST' as const, url: '/api/ai/admin/keys/anthropic/test' },
        { method: 'DELETE' as const, url: '/api/ai/admin/keys/anthropic' },
      ]) {
        const res = await app.inject({ ...req, headers: { ...headers, ...stepUpHeader(await account.stepUp()) } });
        expect(res.statusCode, `${req.method} ${req.url} ${JSON.stringify(headers).slice(0, 40)}`).toBe(401);
        expect(res.json().error.code).toBe(code);
      }
      const res = await put({ ...headers, ...stepUpHeader(await account.stepUp()) });
      expect(res.statusCode).toBe(401);
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('aynı adlı iki sod_at çerezi geçersiz (401)', async () => {
    const t = await account.access({ op: true });
    const res = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: { cookie: `sod_at=${t}; sod_at=${t}` } });
    expect(res.statusCode).toBe(401);
  });

  it('Hesap anahtarı doğrulanamıyorsa 503 AUTH_UNAVAILABLE (oturum kusuru değil)', async () => {
    const acc = await createTestAccount();
    const a = await makeApp(acc);
    try {
      acc.setOffline(true);
      const res = await a.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: bearer(await acc.access({ op: true })) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('AUTH_UNAVAILABLE');
    } finally {
      await a.close();
    }
  });
});

describe('platform yöneticisi (403)', () => {
  it('op olmayan (firma sahibi dahil), op: "true" / 1 gibi gevşek değer: 403 FORBIDDEN, adım artırma olsa da', async () => {
    for (const op of [undefined, false, 'true', 1, {}]) {
      const headers = { ...bearer(await account.access({ op, orgRole: 'OWNER' })), ...stepUpHeader(await account.stepUp()) };
      for (const res of [
        await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers }),
        await app.inject({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers }),
        await app.inject({ method: 'DELETE', url: '/api/ai/admin/keys/anthropic', headers }),
        await put(headers),
      ]) {
        expect(res.statusCode, String(op)).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('op okuma ve sınama uçlarına adım artırmasız girer', async () => {
    const headers = bearer(await account.access({ op: true }));
    const list = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const test = await app.inject({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers });
    expect(test.statusCode).toBe(404);
  });
});

describe('adım artırma (403 STEP_UP_REQUIRED)', () => {
  it('eksik, bozuk, süresi dolmuş, başka kişinin, başka oturumun, yanlış kitleli, op’suz, yabancı imzalı, uzun ömürlü, ileri tarihli', async () => {
    const access = bearer(await account.access({ op: true }));
    const bad: [string, Record<string, string>][] = [
      ['yok', {}],
      ['boş', { [STEP_UP_HEADER]: '' }],
      ['bozuk', { [STEP_UP_HEADER]: 'a.b.c' }],
      ['süresi dolmuş', stepUpHeader(await account.stepUp({ iatOffsetSeconds: -400 }))],
      ['başka kişi', stepUpHeader(await account.stepUp({ personId: 'baska-kisi' }))],
      ['başka oturum', stepUpHeader(await account.stepUp({ sessionId: 'baska-oturum' }))],
      ['erişim jetonu', stepUpHeader(await account.access({ op: true }))],
      ['op yok', stepUpHeader(await account.stepUp({ op: null }))],
      ['op "true"', stepUpHeader(await account.stepUp({ op: 'true' }))],
      ['yabancı imza', stepUpHeader(await account.stepUp({ foreignKey: true }))],
      ['uzun ömür', stepUpHeader(await account.stepUp({ ttlSeconds: 3600 }))],
      ['ileri tarih', stepUpHeader(await account.stepUp({ iatOffsetSeconds: 120 }))],
    ];
    for (const [name, header] of bad) {
      for (const res of [
        await put({ ...access, ...header }),
        await app.inject({ method: 'DELETE', url: '/api/ai/admin/keys/anthropic', headers: { ...access, ...header } }),
      ]) {
        expect(res.statusCode, name).toBe(403);
        expect(res.json().error.code, name).toBe('STEP_UP_REQUIRED');
      }
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('oturum ailesi: yenilenmiş oturum (yeni sid, aynı fid) 200; başka aile 403; fid’siz eski jetonda sid kuralı', async () => {
    const stepUp = await account.stepUp({ sessionId: 'session-op', familyId: 'aile-1' });
    // Hesap yenilemede yeni satır açar: erişim jetonunun sid'i değişir, aile aynı kalır.
    const renewed = bearer(await account.access({ op: true, sessionId: 'session-op-yenilendi', familyId: 'aile-1' }));
    const ok = await put({ ...renewed, ...stepUpHeader(stepUp) });
    expect(ok.statusCode, ok.body).toBe(200);

    const cases: [string, Record<string, string>, Record<string, string>][] = [
      // Başka aile: sid aynı olsa da geçmez.
      ['başka aile', bearer(await account.access({ op: true, sessionId: 'session-op', familyId: 'aile-2' })), stepUpHeader(stepUp)],
      ['başka aile, yeni sid', bearer(await account.access({ op: true, sessionId: 'baska-sid', familyId: 'aile-2' })), stepUpHeader(stepUp)],
      // Aynı aile ama başka kişi.
      ['başka kişi', renewed, stepUpHeader(await account.stepUp({ personId: 'baska-kisi', familyId: 'aile-1' }))],
      // Biri fid taşımıyor: sid kuralına düşer, sid farklı → red.
      ['erişimde fid yok', bearer(await account.access({ op: true, sessionId: 'session-op-yenilendi' })), stepUpHeader(stepUp)],
      ['adım artırmada fid yok', renewed, stepUpHeader(await account.stepUp({ sessionId: 'session-op' }))],
    ];
    for (const [name, access, header] of cases) {
      const res = await put({ ...access, ...header });
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error.code, name).toBe('STEP_UP_REQUIRED');
    }
    // fid'siz eski çift: sid aynıysa geçer (geriye uyum).
    const legacy = await put({ ...bearer(await account.access({ op: true, sessionId: 'session-op-yenilendi' })), ...stepUpHeader(await account.stepUp({ sessionId: 'session-op-yenilendi' })) });
    expect(legacy.statusCode, legacy.body).toBe(200);
  });

  it('geçerli adım artırma: anahtar girilir (Bearer)', async () => {
    const res = await put({ ...bearer(await account.access({ op: true })), ...stepUpHeader(await account.stepUp()) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'anthropic', state: 'ok', setBy: OPERATOR.name });
  });
});

describe('çerezli istek', () => {
  it('çerezli yazma CSRF ister (403 CSRF_FAILED); başlık ve izinli kökenle geçer', async () => {
    const t = await account.access({ op: true });
    const su = stepUpHeader(await account.stepUp());
    const noCsrf = await put({ ...cookie(t), ...su });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_FAILED');
    const wrongOrigin = await put({ ...cookie(t, true), origin: 'https://evil.example', ...su });
    expect(wrongOrigin.json().error.code).toBe('CSRF_FAILED');
    const ok = await put({ ...cookie(t, true), ...su });
    expect(ok.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: cookie(t) });
    expect(read.statusCode).toBe(200);
  });
});
