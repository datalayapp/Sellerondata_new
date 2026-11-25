import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { createProviderProbe } from '../src/keystore/probe.ts';
import { KeyStore, startupSealWarning } from '../src/keystore/store.ts';
import { runAiKeyCli } from '../src/cli/aiKey.ts';
import { masterKeyRing, keyAad, openSecret } from '../src/keystore/seal.ts';
import { closeSuper, createTestAccount, fakeKey, fakeProvider, makeApp, OPERATOR, operatorHeaders, resetKeys, superClient, type TestAccount } from './helpers.ts';
import { TEST_ANTHROPIC_URL, TEST_GEMINI_URL, TEST_KEY_MASTER } from './testEnv.ts';

/** Anahtar deposu uçtan uca: gir (önce sına), listele, sına, kaldır; mühür veritabanında; vekil için açma; ana anahtar döndürme. */

let account: TestAccount;

beforeAll(async () => {
  account = await createTestAccount();
});
afterAll(async () => {
  await closeSuper();
  await disconnectPrisma();
});
beforeEach(resetKeys);

async function withApp(status: Parameters<typeof fakeProvider>[0], fn: (app: FastifyInstance, p: ReturnType<typeof fakeProvider>) => Promise<void>) {
  const p = fakeProvider(status);
  const app = await makeApp(account, { fetch: p.fetch });
  try {
    await fn(app, p);
  } finally {
    await app.close();
  }
}

const put = async (app: FastifyInstance, provider: string, key: unknown) =>
  app.inject({ method: 'PUT', url: `/api/ai/admin/keys/${provider}`, headers: { ...(await operatorHeaders(account)), 'content-type': 'application/json' }, payload: { key } });

describe('anahtar girme', () => {
  it('önce ücretsiz sınama (model listesi), kabulde mühürlü kayıt; yanıtta yalnız son 4 hane', async () => {
    await withApp({}, async (app, p) => {
      const key = fakeKey('anthropic');
      const res = await put(app, 'anthropic', `  ${key}  `);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ provider: 'anthropic', state: 'ok', last4: key.slice(-4), setBy: OPERATOR.name, lastTest: { ok: true, httpStatus: 200 } });
      expect(res.body).not.toContain(key);
      expect(p.calls).toHaveLength(1);
      expect(p.calls[0]).toMatchObject({ method: 'GET', url: `${TEST_ANTHROPIC_URL}/v1/models?limit=1` });
      expect(p.calls[0]!.headers['x-api-key']).toBe(key);

      const su = await superClient();
      const rows = (await su.query('SELECT * FROM ai."ProviderKey"')).rows;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(key);
      expect(rows[0].sealed).toMatch(/^v1\./);
      expect(openSecret(rows[0].sealed, keyAad(rows[0]), masterKeyRing(TEST_KEY_MASTER))).toBe(key);
      const audit = (await su.query('SELECT * FROM ai."AdminAudit" ORDER BY at')).rows;
      expect(audit.map((a) => a.action)).toEqual(['key.set']);
      expect(audit[0]).toMatchObject({ actorId: OPERATOR.personId, actorName: OPERATOR.name, provider: 'anthropic' });
      expect(JSON.stringify(audit)).not.toContain(key);

      const list = await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: await operatorHeaders(account) });
      expect(list.json().keys).toEqual([body, { provider: 'gemini', state: 'missing', last4: null, setBy: null, setAt: null, lastTest: null }]);
      expect(list.body).not.toContain(key);
    });
  });

  it('Gemini: x-goog-api-key ile model listesi', async () => {
    await withApp({}, async (app, p) => {
      const key = fakeKey('gemini');
      expect((await put(app, 'gemini', key)).statusCode).toBe(200);
      expect(p.calls[0]!.url).toBe(`${TEST_GEMINI_URL}/v1beta/models?pageSize=1`);
      expect(p.calls[0]!.headers['x-goog-api-key']).toBe(key);
      expect(p.calls[0]!.headers['x-api-key']).toBeUndefined();
    });
  });

  it('sağlayıcı reddederse 400 AI_KEY_REJECTED, ulaşılamazsa 503 AI_PROVIDER_UNREACHABLE; ikisinde de kaydedilmez, eski anahtar kalır', async () => {
    const old = fakeKey();
    await withApp({}, async (app) => {
      expect((await put(app, 'anthropic', old)).statusCode).toBe(200);
    });
    for (const [status, code, http] of [
      [401, 'AI_KEY_REJECTED', 400],
      [403, 'AI_KEY_REJECTED', 400],
      [500, 'AI_PROVIDER_UNREACHABLE', 503],
      [429, 'AI_PROVIDER_UNREACHABLE', 503],
      ['down', 'AI_PROVIDER_UNREACHABLE', 503],
    ] as const) {
      await withApp({ anthropic: status }, async (app) => {
        const key = fakeKey();
        const res = await put(app, 'anthropic', key);
        expect(res.statusCode, String(status)).toBe(http);
        expect(res.json().error.code).toBe(code);
        expect(res.body).not.toContain(key);
        const k = (await app.inject({ method: 'GET', url: '/api/ai/admin/keys', headers: await operatorHeaders(account) })).json().keys[0];
        expect(k.last4).toBe(old.slice(-4));
      });
    }
    // Gemini'de geçersiz anahtar 400 döner: ret sayılır.
    await withApp({ gemini: 400 }, async (app) => {
      expect((await put(app, 'gemini', fakeKey('gemini'))).json().error.code).toBe('AI_KEY_REJECTED');
    });
    const audit = (await (await superClient()).query(`SELECT action FROM ai."AdminAudit" WHERE action = 'key.set_refused'`)).rows;
    expect(audit.length).toBe(6);
  });

  it('biçim: boşluklu, kısa, sayı, eksik ya da fazla alanlı gövde 400 VALIDATION; değer yanıtta yok; sınamaya gidilmez', async () => {
    await withApp({}, async (app, p) => {
      for (const payload of [{ key: 'kisa' }, { key: 'iki parca anahtar 0123456789abcdef' }, { key: 12345 }, {}, { key: fakeKey(), fazla: 1 }]) {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/ai/admin/keys/anthropic',
          headers: { ...(await operatorHeaders(account)), 'content-type': 'application/json' },
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION');
        expect(res.json().error.details).toEqual([{ path: 'key', code: expect.any(String) }]);
        if (typeof payload.key === 'string') expect(res.body).not.toContain(payload.key);
      }
      expect(p.calls).toHaveLength(0);
    });
  });

  it('bilinmeyen sağlayıcı 404', async () => {
    await withApp({}, async (app) => {
      expect((await put(app, 'openai', fakeKey())).statusCode).toBe(404);
      const del = await app.inject({ method: 'DELETE', url: '/api/ai/admin/keys/openai', headers: await operatorHeaders(account) });
      expect(del.statusCode).toBe(404);
    });
  });
});

describe('sınama, kaldırma, durum', () => {
  it('sına: sonuç yazılır; ret durumu `rejected` yapar, sonra kabul `ok`a döndürür', async () => {
    const key = fakeKey();
    await withApp({}, async (app) => {
      expect((await put(app, 'anthropic', key)).statusCode).toBe(200);
    });
    await withApp({ anthropic: 401 }, async (app) => {
      const res = await app.inject({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers: await operatorHeaders(account) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'rejected', lastTest: { ok: false, httpStatus: 401 } });
      expect(res.body).not.toContain(key);
    });
    await withApp({ anthropic: 503 }, async (app) => {
      // Ulaşılamıyor: karar verilmez, durum değişmez.
      const res = await app.inject({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers: await operatorHeaders(account) });
      expect(res.json()).toMatchObject({ state: 'rejected', lastTest: { ok: false, httpStatus: 503 } });
    });
    await withApp({}, async (app, p) => {
      const res = await app.inject({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers: await operatorHeaders(account) });
      expect(res.json()).toMatchObject({ state: 'ok', lastTest: { ok: true, httpStatus: 200 } });
      expect(p.calls[0]!.headers['x-api-key']).toBe(key);
    });
  });

  it('kaldır: satır gider, durum `missing`; yoksa da missing döner', async () => {
    await withApp({}, async (app) => {
      await put(app, 'gemini', fakeKey('gemini'));
      const del = await app.inject({ method: 'DELETE', url: '/api/ai/admin/keys/gemini', headers: await operatorHeaders(account) });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ provider: 'gemini', state: 'missing', last4: null, setBy: null, setAt: null, lastTest: null });
      expect((await (await superClient()).query('SELECT count(*)::int AS n FROM ai."ProviderKey"')).rows[0].n).toBe(0);
      const again = await app.inject({ method: 'DELETE', url: '/api/ai/admin/keys/gemini', headers: await operatorHeaders(account) });
      expect(again.json().state).toBe('missing');
      const actions = (await (await superClient()).query('SELECT action FROM ai."AdminAudit" ORDER BY at')).rows.map((r) => r.action);
      expect(actions).toEqual(['key.set', 'key.remove']);
    });
  });

  it('değiştirme: yeni anahtar eskisinin yerine (sağlayıcı başına tek satır)', async () => {
    await withApp({}, async (app) => {
      const a = fakeKey();
      const b = fakeKey();
      await put(app, 'anthropic', a);
      await put(app, 'anthropic', b);
      const rows = (await (await superClient()).query('SELECT last4 FROM ai."ProviderKey"')).rows;
      expect(rows).toEqual([{ last4: b.slice(-4) }]);
    });
  });
});

describe('depo (vekil için)', () => {
  const store = (fetchImpl: typeof fetch, ring = () => env.keyRing) =>
    new KeyStore({ prisma: getPrisma(), ring, probe: createProviderProbe({ baseUrls: () => env.providerBaseUrls, fetch: fetchImpl }) });

  it('secretFor: düz anahtarı açar; yoksa null; markRejected / markAccepted durumu çevirir', async () => {
    const p = fakeProvider();
    const s = store(p.fetch);
    expect(await s.secretFor('anthropic')).toBeNull();
    const key = fakeKey();
    expect((await s.set('anthropic', key, { id: 'p1', name: 'Kişi' })).ok).toBe(true);
    const other = store(p.fetch);
    const secret = await other.secretFor('anthropic');
    expect(secret).toMatchObject({ key, keySource: 'platform' });
    await other.markRejected('anthropic', secret!.keyId);
    expect((await other.providerStates()).anthropic).toBe('rejected');
    await other.markAccepted('anthropic', secret!.keyId);
    expect(await other.providerStates()).toEqual({ anthropic: 'ok', gemini: 'missing' });
  });

  it('veritabanında başka sağlayıcının satırına kopyalanan mühür açılmaz (AAD); açılamayan mühür null + olay (gizli değersiz)', async () => {
    const p = fakeProvider();
    const s = store(p.fetch);
    await s.set('anthropic', fakeKey('anthropic'), { id: 'p1', name: 'Kişi' });
    await s.set('gemini', fakeKey('gemini'), { id: 'p1', name: 'Kişi' });
    const su = await superClient();
    await su.query(`UPDATE ai."ProviderKey" g SET sealed = a.sealed FROM ai."ProviderKey" a WHERE g.provider = 'gemini' AND a.provider = 'anthropic'`);
    const events: unknown[] = [];
    const fresh = new KeyStore({ prisma: getPrisma(), ring: () => env.keyRing, probe: createProviderProbe({ baseUrls: () => env.providerBaseUrls, fetch: p.fetch }), onSealError: (e) => events.push(e) });
    expect(await fresh.secretFor('gemini')).toBeNull();
    expect(events).toEqual([{ provider: 'gemini', reason: 'auth_failed' }]);
    expect((await fresh.secretFor('anthropic'))?.key).toMatch(/^sk-ant-/);
  });

  it('düz anahtar sütuna yazılamaz (CHECK: mühür biçimi)', async () => {
    const su = await superClient();
    await expect(
      su.query(`INSERT INTO ai."ProviderKey" (id, provider, sealed, "masterKeyId", last4, "setById", "setByName", "updatedAt") VALUES (gen_random_uuid(), 'anthropic', 'sk-ant-duz-anahtar', 'x', 'abcd', 'p', 'n', now())`),
    ).rejects.toThrow(/ProviderKey_sealed_check/);
  });

  it('ana anahtar döndürme: eski anahtarla mühürlüler yenisiyle yeniden mühürlenir; eski anahtar çıkınca hâlâ açılır', async () => {
    const p = fakeProvider();
    const oldRing = env.keyRing;
    const key = fakeKey();
    await store(p.fetch, () => oldRing).set('anthropic', key, { id: 'p1', name: 'Kişi' });
    const newMaster = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString('base64');
    const ring = masterKeyRing(newMaster, TEST_KEY_MASTER);
    const s = store(p.fetch, () => ring);
    expect((await s.secretFor('anthropic'))?.key).toBe(key);
    expect(await s.rotateMaster({ id: 'cli:test', name: 'test' })).toEqual({ resealed: 1, total: 1 });
    expect(await s.rotateMaster({ id: 'cli:test', name: 'test' })).toEqual({ resealed: 0, total: 1 });
    const only = store(p.fetch, () => masterKeyRing(newMaster));
    expect((await only.secretFor('anthropic'))?.key).toBe(key);
    const row = (await (await superClient()).query('SELECT "masterKeyId" FROM ai."ProviderKey"')).rows[0];
    expect(row.masterKeyId).toBe(ring.current.kid);
  });

  it('eski ana anahtarla mühürlü satır: status ve açılış uyarır; döndürme yalnız satır kalmadıysa "çıkarılabilir" der', async () => {
    const p = fakeProvider();
    const oldRing = env.keyRing;
    const actor = { id: 'p1', name: 'Kişi' };
    const newMaster = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256)).toString('base64');
    const ring = masterKeyRing(newMaster, TEST_KEY_MASTER);
    const cli = async (argv: string[], s: KeyStore) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runAiKeyCli(argv, s, { readSecret: async () => '', out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const key = fakeKey();
    await store(p.fetch, () => oldRing).set('anthropic', key, actor);
    const s = store(p.fetch, () => ring);

    // Döndürme öncesi: bir satır eski anahtarla.
    expect(await s.sealStatus()).toEqual({ stale: [{ provider: 'anthropic', scope: 'platform', inRing: true }], total: 1, previousKeys: 1 });
    const before = await cli(['status'], s);
    expect(before.code).toBe(0);
    expect(before.out).toMatch(/Uyarı: 1 anahtar güncel ana anahtarla \(AI_KEY_MASTER\) mühürlü değil: anthropic\./);
    expect(before.out).toMatch(/çıkarılmamalı/);
    expect(before.out).not.toMatch(/çıkarılabilir/);
    expect(await startupSealWarning(getPrisma(), ring)).toMatch(/Uyarı: 1 anahtar/);
    // Eski anahtar halkadan çıkmışsa satır açılamaz: uyarı bunu da söyler.
    expect(await startupSealWarning(getPrisma(), masterKeyRing(newMaster))).toMatch(/1 satırın ana anahtarı halkada yok/);

    // Döndürme sırasında eski ortamla çalışan bir süreç eski anahtarla yazar: "çıkarılabilir" denmez, uyarı + 1.
    const racing = store(p.fetch, () => ring);
    racing.rotateMaster = async (a) => {
      const r = await KeyStore.prototype.rotateMaster.call(racing, a);
      await store(p.fetch, () => oldRing).set('gemini', fakeKey('gemini'), actor);
      return r;
    };
    const partial = await cli(['rotate-master', '--operator', 'x'], racing);
    expect(partial.code).toBe(1);
    expect(partial.out).toMatch(/1 \/ 1 satır yeniden mühürlendi/);
    expect(partial.out).not.toMatch(/çıkarılabilir/);
    expect(partial.err).toMatch(/Uyarı: 1 anahtar .*: gemini\./);

    // Yeniden döndürme: satır kalmadı, artık çıkarılabilir; status ve açılış sessiz.
    const full = await cli(['rotate-master', '--operator', 'x'], s);
    expect(full.code).toBe(0);
    expect(full.out).toMatch(/1 \/ 2 satır yeniden mühürlendi\. Artık AI_KEY_MASTER_PREVIOUS ortamdan çıkarılabilir\./);
    expect(full.err).toBe('');
    expect((await s.sealStatus()).stale).toEqual([]);
    expect((await cli(['status'], s)).out).toMatch(/Tüm anahtarlar güncel ana anahtarla mühürlü: AI_KEY_MASTER_PREVIOUS ortamdan çıkarılabilir\./);
    expect(await startupSealWarning(getPrisma(), ring)).toBeNull();
    // Eski anahtar halkada yokken (döndürme sonrası olağan durum) status ek satır yazmaz.
    const plain = await cli(['status'], store(p.fetch, () => masterKeyRing(newMaster)));
    expect(plain.out).not.toMatch(/Uyarı|çıkarılabilir/);
    for (const r of [before, partial, full, plain]) expect(`${r.out}${r.err}`).not.toContain(key);
  });
});

describe('veritabanı hakları', () => {
  it('uygulama rolü yönetici kaydını silemez/değiştiremez, göç geçmişini okuyamaz, DDL yapamaz; tavan tablosunda tek satır', async () => {
    const prisma = getPrisma();
    await prisma.adminAudit.create({ data: { id: crypto.randomUUID(), actorId: 'x', actorName: 'x', action: 'deneme' } });
    await expect(prisma.$executeRawUnsafe('DELETE FROM ai."AdminAudit"')).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe(`UPDATE ai."AdminAudit" SET action = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(prisma.$queryRawUnsafe('SELECT * FROM ai."_prisma_migrations"')).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe('CREATE TABLE ai.kotu (id int)')).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM ai."PlatformLimits"')).rejects.toThrow(/permission denied/);
    expect(await prisma.platformLimits.count()).toBe(1);
    await expect(prisma.$queryRawUnsafe('SELECT 1 FROM platform."Person" LIMIT 1')).rejects.toThrow(/permission denied/);
  });
});
