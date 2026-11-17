// npm test → node --test test/*.test.ts  (Node 24 TypeScript'i doğrudan çalıştırır; tarayıcı/Playwright gerekmez)
// "Sunucu meşgul" (503 DB_UNAVAILABLE): GET bir kez, kısa beklemeyle yeniden denenir; POST/PATCH/DELETE asla.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const { ApiError, DB_BUSY_RETRY_MS, bindSessionFetch, request } = await import('../src/api/client.ts');

type Call = { url: string; method: string; at: number };
let calls: Call[] = [];
let replies: Array<() => Response> = [];

const busy = () =>
  new Response(JSON.stringify({ error: { code: 'DB_UNAVAILABLE', message: 'Sunucu meşgul, birkaç saniye sonra tekrar deneyin' } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Oturum (çerez, CSRF, 401 yenilemesi) kabuğun istemcisinde ve orada test edilir. Burada API tabanı ve tekrar kuralı sınanır.
bindSessionFetch(async (url, init) => {
  calls.push({ url, method: init.method ?? 'GET', at: Date.now() });
  const next = replies.shift();
  assert.ok(next, `beklenmeyen istek: ${init.method} ${url}`);
  return next();
});

beforeEach(() => {
  calls = [];
  replies = [];
});

describe('hata çevirisi', () => {
  it('platform kodları ve yerelleşmiş mesaj aynen taşınır', async () => {
    for (const code of ['NO_PRODUCT_ACCESS', 'READ_ONLY', 'ORG_REQUIRED']) {
      replies = [() => new Response(JSON.stringify({ error: { code, message: 'sunucu metni' } }), { status: 403 })];
      await assert.rejects(request('/invoices'), (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === code && e.message === 'sunucu metni');
    }
  });
  it('kabuğun kendi hataları kodu ve metniyle taşınır, üzerine yazılmaz', async () => {
    for (const [status, code] of [[409, 'ORG_MISMATCH'], [0, 'NETWORK_UNAVAILABLE']] as const) {
      replies = [
        () => {
          throw Object.assign(new Error('kabuk metni'), { status, code });
        },
      ];
      await assert.rejects(request('/invoices'), (e: unknown) => e instanceof ApiError && e.status === status && e.code === code && e.message === 'kabuk metni');
    }
  });
  it('ağ hatası kabuktan gelmediyse NETWORK olur', async () => {
    replies = [
      () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    await assert.rejects(request('/invoices'), (e: unknown) => e instanceof ApiError && e.status === 0 && e.code === 'NETWORK');
  });
  it('sorgu dizesi boş değerleri atlar', async () => {
    replies = [ok];
    await request('/invoices', { query: { a: 1, b: '', c: null, d: undefined, e: false } });
    assert.equal(calls[0]!.url, '/api/deciship/invoices?a=1&e=false');
  });
});

describe('503 DB_UNAVAILABLE yeniden deneme', () => {
  it('GET: tek yeniden deneme, ~1,5 sn sonra; ikincisi başarılıysa sonuç döner', async () => {
    replies = [busy, ok];
    assert.deepEqual(await request('/invoices'), { ok: true });
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.at - calls[0]!.at >= DB_BUSY_RETRY_MS - 20, 'bekleme kısa olmalı ama atlanmamalı');
    assert.equal(DB_BUSY_RETRY_MS, 1500);
  });

  it('GET: ikinci deneme de meşgulse bir daha denenmez, hata kullanıcıya gider', async () => {
    replies = [busy, busy];
    await assert.rejects(request('/invoices'), (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === 'DB_UNAVAILABLE');
    assert.equal(calls.length, 2);
  });

  for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
    it(`${method}: asla otomatik tekrar yok`, async () => {
      replies = [busy];
      await assert.rejects(request('/invoices/x', { method, body: method === 'DELETE' ? undefined : { a: 1 } }), (e: unknown) => e instanceof ApiError && e.code === 'DB_UNAVAILABLE');
      assert.equal(calls.length, 1);
    });
  }

  it('gövdesiz POST (ör. yeniden karşılaştır) da tekrar edilmez', async () => {
    replies = [busy];
    await assert.rejects(request('/invoices/x/recompare', { method: 'POST' }));
    assert.equal(calls.length, 1);
  });

  it('GET: başka 503 (DB_UNAVAILABLE değil) burada yeniden denenmez', async () => {
    replies = [() => new Response('Service Unavailable', { status: 503 })];
    await assert.rejects(request('/invoices'), (e: unknown) => e instanceof ApiError && e.status === 503);
    assert.equal(calls.length, 1);
  });
});
