import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '../src/db.ts';
import { resetSecretsForTest, scrubSecrets, registerSecret } from '../src/keystore/scrub.ts';
import { closeSuper, createTestAccount, fakeKey, fakeProvider, logCapture, makeApp, operatorHeaders, resetKeys, superClient, type TestAccount } from './helpers.ts';
import { TEST_KEY_MASTER, TEST_TOOL_TOKENS } from './testEnv.ts';

/**
 * Yakalayıcı: gerçek anahtar, araç jetonu ve ana anahtar hiçbir yanıtta (gövde ve başlık) ve hiçbir günlük satırında yok. Sağlayıcı
 * hata gövdesinde anahtarı yansıtsa, ağ hatası metninde taşısa, bir rota hata metnine koysa da. Günlükte süzgecin maskesi de yok:
 * asıl kural yazmamaktır, süzgeç (keystore/scrub.ts) ikinci kattır ve burada hiç devreye girmemeli.
 */

let account: TestAccount;
let app: FastifyInstance;
const logs = logCapture();
const responses: LightMyRequestResponse[] = [];
let provider = fakeProvider();
const keys = { a: fakeKey(), b: fakeKey(), c: fakeKey(), bad: fakeKey(), gem: fakeKey() };

beforeAll(async () => {
  account = await createTestAccount();
  await resetKeys();
  app = await makeApp(account, {
    logger: true,
    logStream: logs.stream,
    logLevel: 'debug',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => provider.fetch(input, init)) as typeof fetch,
    internalRoutes: () => [
      (scope) => {
        // Hatalı bir vekil rotası: hata metnine anahtarı koyar (G2'de olmamalı; olsa da dışarı çıkmamalı).
        scope.post('/anthropic/v1/messages', async () => {
          throw new Error(`yukarı akış başarısız: x-api-key=${keys.a}`);
        });
      },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await closeSuper();
  await disconnectPrisma();
});

async function call(opts: InjectOptions) {
  const res = await app.inject(opts);
  responses.push(res);
  return res;
}

const put = async (provider: string, key: string) =>
  call({ method: 'PUT', url: `/api/ai/admin/keys/${provider}`, headers: { ...(await operatorHeaders(account)), 'content-type': 'application/json' }, payload: { key } });

describe('gizli değer sızıntısı', () => {
  beforeEach(() => {
    provider = fakeProvider();
  });

  it('senaryo: gir, reddedilen, ulaşılamayan, bozuk biçim, listele, sına, kaldır, hatalı rota, sorguda jeton', async () => {
    expect((await put('anthropic', keys.a)).statusCode).toBe(200);
    provider = fakeProvider({ anthropic: 401 });
    expect((await put('anthropic', keys.bad)).statusCode).toBe(400);
    provider = fakeProvider({ anthropic: 'down' });
    expect((await put('anthropic', keys.b)).statusCode).toBe(503);
    provider = fakeProvider();
    expect((await put('anthropic', `${keys.c} ikinci-parca`)).statusCode).toBe(400);
    expect((await put('gemini', keys.gem)).statusCode).toBe(200);
    expect((await call({ method: 'GET', url: '/api/ai/admin/keys', headers: await operatorHeaders(account) })).statusCode).toBe(200);
    provider = fakeProvider({ anthropic: 403 });
    expect((await call({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers: await operatorHeaders(account) })).statusCode).toBe(200);
    provider = fakeProvider();
    expect((await call({ method: 'POST', url: '/api/ai/admin/keys/anthropic/test', headers: await operatorHeaders(account) })).statusCode).toBe(200);
    const boom = await call({
      method: 'POST',
      url: '/internal/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TOOL_TOKENS.deciship },
      payload: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: keys.a }] },
    });
    expect(boom.statusCode).toBe(500);
    expect((await call({ method: 'GET', url: `/internal/status?key=${TEST_TOOL_TOKENS.tagpress}` })).statusCode).toBe(401);
    expect((await call({ method: 'DELETE', url: '/api/ai/admin/keys/gemini', headers: await operatorHeaders(account) })).statusCode).toBe(200);

    const secrets = [...Object.values(keys), TEST_TOOL_TOKENS.deciship, TEST_TOOL_TOKENS.tagpress, TEST_KEY_MASTER];
    const logText = logs.text();
    // Günlük gerçekten yazıldı: istekler, kayıt satırları ve hatalı rotanın hatası.
    expect(logText).toContain('incoming request');
    expect(logText).toContain('anahtar kaydedildi');
    expect(logText).toContain('anahtar kaydedilmedi');
    expect(logText).toContain('beklenmeyen hata');
    for (const res of responses) {
      const all = `${res.body}\n${JSON.stringify(res.headers)}`;
      for (const s of secrets) expect(all, `${res.statusCode} yanıtında gizli değer`).not.toContain(s);
    }
    for (const s of secrets) expect(logText, 'günlükte gizli değer').not.toContain(s);
    expect(logText, 'günlük süzgeci devreye girdi: bir yer gizli değeri yazmaya çalıştı').not.toContain('[gizli]');
    // Günlükte başlık ve gövde hiç yok.
    expect(logText).not.toMatch(/x-api-key|x-goog-api-key|authorization|x-sod-step-up|"payload"|"body"/i);
    expect(logText).toContain('/internal/status?…');

    // Yönetici kaydı ve veritabanının düz sütunları da temiz.
    const su = await superClient();
    const dump = JSON.stringify([(await su.query('SELECT * FROM ai."AdminAudit"')).rows, (await su.query('SELECT * FROM ai."ProviderKey"')).rows]);
    for (const s of secrets) expect(dump).not.toContain(s);
  });
});

describe('günlük süzgeci (ikinci kat)', () => {
  it('kayıtlı değeri ve JSON kaçışlı biçimini, Anthropic ve Google anahtar biçimlerini siler; kısa değeri kaydetmez', () => {
    resetSecretsForTest();
    const k = 'gizli"deger\\0123456789';
    registerSecret(k);
    registerSecret('kisa');
    expect(scrubSecrets(`a ${k} b ${JSON.stringify(k)} c`)).toBe('a [gizli] b "[gizli]" c');
    expect(scrubSecrets('x sk-ant-api03-AbC_dEf-0123456789 y')).toBe('x [gizli] y');
    expect(scrubSecrets('x AIzaSyA0123456789abcdefghijKLMNOP y')).toBe('x [gizli] y');
    expect(scrubSecrets('kisa metin')).toBe('kisa metin');
  });
});
