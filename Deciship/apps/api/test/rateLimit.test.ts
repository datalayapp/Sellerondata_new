import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify, { type FastifyInstance, type onRequestHookHandler } from 'fastify';
import multipartPlugin from '@fastify/multipart';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/app.ts';
import { registerErrorHandling } from '../src/errors.ts';
import { registerLocale } from '../src/i18n/index.ts';
import { RATE_TABLE, SlidingWindow, bucketsFor, heavyInUse, heavyWaiting, registerRateLimit, resetRateLimits } from '../src/lib/rateLimit.ts';
import { JPEG, createWorker, getApp, measurementPayload, multipart, registerCompany } from './helpers.ts';

/** Sınır testlerde kapalıdır (vitest.config.ts); açık hâli yalnız bu dosyada, her testte geri alınarak denenir. */
const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  resetRateLimits();
});

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('kayan pencere', () => {
  it('sınırda reddeder; retry-after en eski kaydın düşeceği saniye; pencere kayınca yine açılır', () => {
    const w = new SlidingWindow(60_000);
    const c = [{ key: 'k', limit: 2 }];
    expect(w.take(c, 0)).toEqual({ ok: true });
    expect(w.take(c, 10_000)).toEqual({ ok: true });
    expect(w.take(c, 20_000)).toEqual({ ok: false, retryAfterSec: 40 });
    // Reddedilen istek sayılmadı: ilk kayıt düşünce tek yer açılır.
    expect(w.take(c, 60_001)).toEqual({ ok: true });
    expect(w.take(c, 65_000)).toEqual({ ok: false, retryAfterSec: 5 });
    expect(w.take(c, 70_001)).toEqual({ ok: true });
  });

  it('retry-after en az 1 sn; sınır sonradan düşerse de doğru bekleme', () => {
    const w = new SlidingWindow(60_000);
    for (let t = 0; t < 5; t++) expect(w.take([{ key: 'k', limit: 5 }], t * 1000).ok).toBe(true);
    // Sınır 5'ten 2'ye indi: yer açılması için son ikiden öncekinin (t=3 sn) düşmesi gerekir.
    expect(w.take([{ key: 'k', limit: 2 }], 5_000)).toEqual({ ok: false, retryAfterSec: 58 });
    expect(w.take([{ key: 'k', limit: 5 }], 59_999.5)).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it('ya hepsine yazılır ya hiçbirine: firma sınırına takılan istek kişinin hakkını harcamaz', () => {
    const w = new SlidingWindow(60_000);
    expect(w.take([{ key: 'org', limit: 1 }], 0).ok).toBe(true);
    expect(w.take([{ key: 'member', limit: 1 }, { key: 'org', limit: 1 }], 1_000).ok).toBe(false);
    expect(w.take([{ key: 'member', limit: 1 }], 2_000).ok).toBe(true);
  });

  it('penceresi boşalan anahtar bellekten silinir', () => {
    const w = new SlidingWindow(60_000);
    for (let i = 0; i < 100; i++) w.take([{ key: `k${i}`, limit: 1 }], 0);
    expect(w.size).toBe(100);
    w.take([{ key: 'yeni', limit: 1 }], 120_001);
    expect(w.size).toBe(1);
  });
});

/**
 * Multipart okuyan uçlar kaynaktan bulunur: işleyicinin gövdesinde `req.parts(`, `req.file(`, `req.isMultipart(` ya da
 * bunları çağıran yerel yardımcı (`readMultipart`, `readUpload`, `readImage`…) geçiyorsa uç multipart'tır.
 */
function multipartRoutesFromSource(): string[] {
  const dir = path.resolve(import.meta.dirname, '../src/routes');
  const found: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Bölümler: her uç tanımı ya da işlev bildirimi yeni bölüm başlatır.
    const starts = [...src.matchAll(/(?:\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'|(?:async\s+)?function\s+(\w+)\s*\()/g)];
    const sections = starts.map((s, i) => ({ method: s[1], url: s[2], fn: s[3], body: src.slice(s.index, starts[i + 1]?.index ?? src.length) }));
    const tokens = ['.parts(', '.file(', '.files(', '.isMultipart(', 'saveRequestFiles('];
    const readsMultipart = (body: string) => tokens.some((t) => body.includes(t));
    const helpers = sections.filter((s) => s.fn && readsMultipart(s.body)).map((s) => `${s.fn}(`);
    for (const s of sections) {
      if (!s.method || !s.url) continue;
      if (readsMultipart(s.body) || helpers.some((h) => s.body.includes(h))) found.push(`${s.method.toUpperCase()} ${s.url}`);
    }
  }
  return found.sort();
}

describe('kova tablosu', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('yazma yöntemli her uç tabloda; tabloda yol listesinde olmayan uç yok', () => {
    const routes = app.routeTable.filter((r) => r.url.startsWith(API_PREFIX)).map((r) => `${r.method} ${r.url.slice(API_PREFIX.length)}`);
    const writes = routes.filter((k) => WRITE_METHODS.has(k.split(' ')[0]!));
    expect(writes.filter((k) => !(k in RATE_TABLE)), 'tabloda eksik').toEqual([]);
    expect(Object.keys(RATE_TABLE).filter((k) => !routes.includes(k)), 'tabloda fazla').toEqual([]);
    expect(Object.keys(RATE_TABLE).filter((k) => !WRITE_METHODS.has(k.split(' ')[0]!)), 'GET tabloya girmez').toEqual([]);
  });

  it('her multipart uç tabloda ve `upload` (tartı/işaret okuma: `vision`) kovasında', () => {
    const multipartRoutes = multipartRoutesFromSource();
    // Tarama çalışıyor mu: bilinen multipart uçlar bulundu.
    expect(multipartRoutes).toEqual(
      expect.arrayContaining(['POST /measurements', 'PATCH /measurements/:id', 'POST /invoices/preview', 'POST /invoices/samples', 'POST /tariffs/:id/import', 'POST /tariff-imports', 'POST /vision/scale']),
    );
    const fileBucket = (k: string) => RATE_TABLE[k]?.some((b) => b === 'upload' || b === 'vision');
    expect(multipartRoutes.filter((k) => !fileBucket(k))).toEqual([]);
    // Tabloda dosya kovası olup multipart okumayan uç da yok: kişi başı 60/dk yalnız dosya uçlarına uygulanır.
    expect(Object.keys(RATE_TABLE).filter((k) => fileBucket(k) && !multipartRoutes.includes(k))).toEqual([]);
    // Canlı ölçümün okuma istekleri kuyruğun gönderimiyle aynı kovayı paylaşmaz.
    expect(Object.keys(RATE_TABLE).filter((k) => RATE_TABLE[k]!.includes('vision')).sort()).toEqual(['POST /vision/reference/detect', 'POST /vision/scale']);
  });

  it('ağır yazma uçları: içe aktarma, örnek fatura, tarife uygulama, toplu yeniden hesap', () => {
    const heavy = Object.keys(RATE_TABLE).filter((k) => RATE_TABLE[k]!.includes('heavy')).sort();
    expect(heavy).toEqual(
      ['POST /invoices', 'POST /invoices/samples', 'POST /settings/recompare-invoices', 'POST /tariff-imports/:draftId/apply', 'POST /tariffs/:id/recompare-invoices'].sort(),
    );
    // Ağır uç da hız kovasında sayılır.
    for (const k of heavy) expect(RATE_TABLE[k]!.some((b) => b === 'upload' || b === 'write'), k).toBe(true);
  });

  it('tabloda olmayan uç yine korunur: multipart gövde upload, diğer yazma write, GET sayılmaz', () => {
    expect(bucketsFor('POST', '/yeni-uc', true)).toEqual(['upload']);
    expect(bucketsFor('DELETE', '/yeni-uc/:id', false)).toEqual(['write']);
    expect(bucketsFor('GET', '/platform/overview', false)).toEqual([]);
    expect(bucketsFor('POST', '/internal/events', false)).toEqual([]);
  });
});

describe('hız sınırı (gerçek uygulama)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  const postMeasurement = (auth: { authorization: string }, locale = 'tr') => {
    const p = measurementPayload();
    return app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers, 'accept-language': locale }, payload: p.payload });
  };

  it('sınır kapalıyken (testlerin varsayılanı) geçer', async () => {
    expect(process.env.API_RATE_LIMIT).toBe('off');
    setEnv({ RATE_UPLOAD_PER_MIN_MEMBER: '1', RATE_UPLOAD_PER_MIN_ORG: '1' });
    const admin = await registerCompany(app);
    for (let i = 0; i < 3; i++) expect((await postMeasurement(admin.auth)).statusCode).toBe(201);
  });

  it('yükleme: kişi sınırında 429 + retry-after; aynı firmada firma sınırı; başka firma etkilenmez', async () => {
    setEnv({ API_RATE_LIMIT: 'on', RATE_UPLOAD_PER_MIN_MEMBER: '3', RATE_UPLOAD_PER_MIN_ORG: '5' });
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    const other = await registerCompany(app);

    for (let i = 0; i < 3; i++) expect((await postMeasurement(worker.auth)).statusCode).toBe(201);
    const limited = await postMeasurement(worker.auth);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'TOO_MANY_REQUESTS', message: 'Çok fazla istek yapıldı. Biraz sonra yeniden deneyin.' } });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await postMeasurement(worker.auth, 'en')).json().error.message).toBe('Too many requests. Try again shortly.');

    // Firma: 3 + 2 = 5, altıncı istek kişinin hakkı olsa da firmada takılır.
    expect((await postMeasurement(admin.auth)).statusCode).toBe(201);
    expect((await postMeasurement(admin.auth)).statusCode).toBe(201);
    const orgLimited = await postMeasurement(admin.auth);
    expect(orgLimited.statusCode).toBe(429);
    expect(orgLimited.headers['retry-after']).toBeDefined();

    // Başka firma ayrı sayılır.
    expect((await postMeasurement(other.auth)).statusCode).toBe(201);

    // Okuma sayılmaz.
    expect((await app.inject({ method: 'GET', url: '/api/deciship/measurements', headers: worker.auth })).statusCode).toBe(200);
  });

  it('yetkisiz ve izinsiz istek kova harcamaz (kanca kimlik ve izin denetiminden sonra); yazma kovası kişi başı', async () => {
    setEnv({ API_RATE_LIMIT: 'on', RATE_WRITE_PER_MIN_MEMBER: '3' });
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'POST', url: '/api/deciship/carriers', payload: { name: 'X' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: worker.auth, payload: { name: 'X' } })).statusCode).toBe(403);
    }
    const del = () => app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${crypto.randomUUID()}`, headers: worker.auth });
    for (let i = 0; i < 3; i++) expect((await del()).statusCode).not.toBe(429);
    const limited = await del();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_REQUESTS');

    // Yazma ve yükleme ayrı kovalar; aynı firmadaki yönetici kendi hakkını kullanır.
    expect((await postMeasurement(worker.auth)).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: `/api/deciship/measurements/${crypto.randomUUID()}`, headers: admin.auth })).statusCode).not.toBe(429);
  });
});

describe('canlı okuma kovası ve üretim uyarısı', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  it('kuyruk yükleme kovasını doldurunca canlı tartı/işaret okuma 429 almaz; kendi kovası kişi başı', async () => {
    setEnv({ API_RATE_LIMIT: 'on', RATE_UPLOAD_PER_MIN_MEMBER: '2', RATE_VISION_PER_MIN_MEMBER: '2' });
    const admin = await registerCompany(app);
    const worker = await createWorker(app, admin.auth);
    for (let i = 0; i < 2; i++) {
      const p = measurementPayload();
      expect((await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload })).statusCode).toBe(201);
    }
    const p = measurementPayload();
    expect((await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...worker.auth, ...p.headers }, payload: p.payload })).statusCode).toBe(429);
    const detect = () => {
      const img = multipart([{ name: 'image', filename: 'a.jpg', contentType: 'image/jpeg', data: JPEG }]);
      return app.inject({ method: 'POST', url: '/api/deciship/vision/reference/detect', headers: { ...worker.auth, ...img.headers }, payload: img.payload });
    };
    for (let i = 0; i < 2; i++) expect((await detect()).statusCode).not.toBe(429);
    const limited = await detect();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('üretimde API_RATE_LIMIT=off açılışta uyarı yazar, servisi durdurmaz', async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    for (const [nodeEnv, flag, expected] of [['production', 'off', 1], ['production', 'on', 0], ['test', 'off', 0]] as const) {
      setEnv({ NODE_ENV: nodeEnv, API_RATE_LIMIT: flag });
      lines.length = 0;
      const a = Fastify({ logger: { level: 'warn', stream } });
      registerRateLimit(a, API_PREFIX);
      await a.ready();
      await a.close();
      expect(lines.filter((l) => l.includes('API_RATE_LIMIT')), `${nodeEnv} ${flag}`).toHaveLength(expected);
    }
  });
});

describe('ağır yazma eşzamanlılığı', () => {
  let app: FastifyInstance;
  let gate: { open: () => void; wait: Promise<void> };
  const newGate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    return { open, wait };
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerErrorHandling(app);
    registerLocale(app);
    await app.register(multipartPlugin);
    app.decorateRequest('auth', null as never);
    const auth: onRequestHookHandler = async (req, reply) => {
      const raw = req.headers['x-test-org'];
      if (!raw) return reply.status(401).send({ error: { code: 'UNAUTHORIZED' } });
      (req as unknown as { auth: unknown }).auth = { orgId: String(raw), membershipId: String(req.headers['x-test-member'] ?? `${raw}-m`) };
    };
    registerRateLimit(app, API_PREFIX);
    await app.register(
      async (api) => {
        api.post('/invoices', { onRequest: auth }, async () => {
          await gate.wait;
          return { ok: true };
        });
        api.post('/tariff-imports/:draftId/apply', { onRequest: auth }, async () => {
          await gate.wait;
          throw new Error('beklenmeyen');
        });
        api.post('/carriers', { onRequest: auth }, async () => ({ ok: true }));
        api.post('/vision/scale', { onRequest: auth }, async () => ({ ok: true }));
        api.post('/vision/reference/detect', { onRequest: auth }, async () => ({ ok: true }));
      },
      { prefix: API_PREFIX },
    );
    await app.ready();
  });
  afterAll(() => app.close());

  const post = (url: string, org: string | null = 'org-a', locale = 'tr', member?: string) =>
    app.inject({
      method: 'POST',
      url: `${API_PREFIX}${url}`,
      headers: { ...(org ? { 'x-test-org': org } : {}), ...(member ? { 'x-test-member': member } : {}), 'accept-language': locale },
      payload: {},
    });

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };

  it('süreç genelinde IMPORT_CONCURRENCY; sırasız kipte (HEAVY_QUEUE_WAIT_MS=0) dolunca hemen 503 FILE_BUSY + retry-after; yanıt ve hata sonrası yuva döner', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '2', HEAVY_QUEUE_WAIT_MS: '0' });
    gate = newGate();
    const first = post('/invoices', 'org-a');
    const second = post('/tariff-imports/d1/apply', 'org-b');
    expect(await waitFor(() => heavyInUse() === 2)).toBe(true);

    const busy = await post('/invoices', 'org-c');
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('5');
    expect(busy.json()).toEqual({ error: { code: 'FILE_BUSY', message: 'Şu an çok sayıda dosya işleniyor. Birkaç saniye sonra yeniden deneyin.' } });
    expect((await post('/invoices', 'org-c', 'en')).json().error.message).toBe('Many files are being processed right now. Try again in a few seconds.');
    // Reddedilen istek yuva tutmaz; ağır olmayan yazma etkilenmez; kimliksiz istek kancaya gelmez.
    expect(heavyInUse()).toBe(2);
    expect((await post('/carriers', 'org-c')).statusCode).toBe(200);
    expect((await post('/invoices', null)).statusCode).toBe(401);

    gate.open();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(500);
    expect(await waitFor(() => heavyInUse() === 0)).toBe(true);
    expect((await post('/invoices', 'org-c')).statusCode).toBe(200);
    expect(heavyInUse()).toBe(0);
  });

  it('firma başına tek ağır yuva: aynı firmanın ikinci ağır isteği 503 FILE_BUSY alır, başka firmaların yuvasını tüketmez', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '3', HEAVY_QUEUE_WAIT_MS: '0' });
    gate = newGate();
    // A firmasının üç kişisi aynı anda içe aktarır: firma içinde zaten danışma kilidiyle sıralı, yalnız biri yuva alır.
    const a1 = post('/invoices', 'org-a', 'tr', 'a-1');
    expect(await waitFor(() => heavyInUse() === 1)).toBe(true);
    const a2 = await post('/invoices', 'org-a', 'tr', 'a-2');
    const a3 = await post('/tariff-imports/d1/apply', 'org-a', 'tr', 'a-3');
    for (const r of [a2, a3]) {
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('FILE_BUSY');
      expect(r.headers['retry-after']).toBe('5');
      // kendi işi sürüyor: "çok sayıda dosya" değil, firmanın işinin sürdüğü söylenir
      expect(r.json().error).toEqual({ code: 'FILE_BUSY', message: 'Firmanızın başka bir dosya işlemi sürüyor. O bitince yeniden deneyin.', details: { scope: 'company' } });
    }
    expect((await post('/invoices', 'org-a', 'en', 'a-4')).json().error.message).toBe('Another file operation for your company is still running. Try again when it finishes.');
    expect(heavyInUse()).toBe(1);
    // B ve C firmaları kalan iki yuvayı alır; genel sınır yine 3.
    const b = post('/invoices', 'org-b');
    const c = post('/invoices', 'org-c');
    expect(await waitFor(() => heavyInUse() === 3)).toBe(true);
    expect((await post('/invoices', 'org-d')).statusCode).toBe(503);
    gate.open();
    for (const r of await Promise.all([a1, b, c])) expect(r.statusCode).toBe(200);
    expect(await waitFor(() => heavyInUse() === 0)).toBe(true);
    // Yuva dönünce A yeniden içe aktarabilir.
    expect((await post('/invoices', 'org-a', 'tr', 'a-2')).statusCode).toBe(200);
  });

  it('19-B8: yuvalar doluyken dördüncü firma hemen reddedilmez, sırada bekleyip yuva boşalınca başarıyla biter', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '3', HEAVY_QUEUE_WAIT_MS: '30000' });
    gate = newGate();
    const running = ['org-a', 'org-b', 'org-c'].map((o) => post('/invoices', o));
    expect(await waitFor(() => heavyInUse() === 3)).toBe(true);
    const fourth = post('/invoices', 'org-d');
    expect(await waitFor(() => heavyWaiting() === 1)).toBe(true);
    // sıradaki firmanın ikinci ağır isteği beklemeden kendi işini söyler; sıraya ikinci kez girmez
    const again = await post('/tariff-imports/d1/apply', 'org-d');
    expect(again.statusCode).toBe(503);
    expect(again.json().error).toMatchObject({ code: 'FILE_BUSY', details: { scope: 'company' } });
    expect(heavyWaiting()).toBe(1);
    expect(heavyInUse()).toBe(3);
    gate.open();
    for (const r of await Promise.all([...running, fourth])) expect(r.statusCode).toBe(200);
    expect(await waitFor(() => heavyInUse() === 0 && heavyWaiting() === 0)).toBe(true);
  });

  it('19-B8: sırada bekleme süresi dolarsa 503 FILE_BUSY + retry-after; yuva tutulmaz, sıra boşalır', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '1', HEAVY_QUEUE_WAIT_MS: '150' });
    gate = newGate();
    const first = post('/invoices', 'org-a');
    expect(await waitFor(() => heavyInUse() === 1)).toBe(true);
    const late = await post('/invoices', 'org-b');
    expect(late.statusCode).toBe(503);
    expect(late.headers['retry-after']).toBe('5');
    expect(late.json()).toEqual({ error: { code: 'FILE_BUSY', message: 'Şu an çok sayıda dosya işleniyor. Birkaç saniye sonra yeniden deneyin.' } });
    expect(heavyWaiting()).toBe(0);
    expect(heavyInUse()).toBe(1);
    gate.open();
    expect((await first).statusCode).toBe(200);
    expect(await waitFor(() => heavyInUse() === 0)).toBe(true);
  });

  it('19-B8: sırada beklerken hız sınırına takılan istek yuvasını sıradakine bırakır', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '1', HEAVY_QUEUE_WAIT_MS: '30000', RATE_WRITE_PER_MIN_MEMBER: '1' });
    gate = newGate();
    const first = post('/invoices', 'org-a');
    expect(await waitFor(() => heavyInUse() === 1)).toBe(true);
    // org-b'nin kişisi hakkını başka yazmayla doldurur; sıradaki ağır isteği yuva alınca 429 olur
    expect((await post('/carriers', 'org-b')).statusCode).toBe(200);
    const b = post('/invoices', 'org-b');
    expect(await waitFor(() => heavyWaiting() === 1)).toBe(true);
    const c = post('/invoices', 'org-c');
    expect(await waitFor(() => heavyWaiting() === 2)).toBe(true);
    gate.open();
    expect((await first).statusCode).toBe(200);
    expect((await b).statusCode).toBe(429);
    expect((await c).statusCode).toBe(200);
    expect(await waitFor(() => heavyInUse() === 0 && heavyWaiting() === 0)).toBe(true);
  });

  it('bağımsız inceleme: sırada beklerken ya da yuvayı aldıktan sonra bağlantısı kopan istek yuva kaçırmaz', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '1', HEAVY_QUEUE_WAIT_MS: '30000' });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = new URL(address);
    /** Gerçek TCP bağlantısıyla ağır istek; dönen işlev bağlantıyı koparır. */
    const rawPost = (org: string) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `${API_PREFIX}/invoices`, headers: { 'x-test-org': org, 'content-type': 'application/json' } });
      req.on('error', () => {});
      req.end('{}');
      return () => req.destroy();
    };
    gate = newGate();
    const first = post('/invoices', 'org-a');
    expect(await waitFor(() => heavyInUse() === 1)).toBe(true);
    // 1) sırada beklerken kopan istek sıradan çıkar; yuva almaz
    const dropWaiting = rawPost('org-b');
    expect(await waitFor(() => heavyWaiting() === 1)).toBe(true);
    dropWaiting();
    expect(await waitFor(() => heavyWaiting() === 0)).toBe(true);
    expect(heavyInUse()).toBe(1);
    // 2) sırada bekleyen istek yuvayı alır, işleyici sürerken bağlantısı kopar: işleyici bitince yuva yine döner
    const dropRunning = rawPost('org-c');
    expect(await waitFor(() => heavyWaiting() === 1)).toBe(true);
    const firstGate = gate;
    gate = newGate();
    firstGate.open();
    expect((await first).statusCode).toBe(200);
    expect(await waitFor(() => heavyInUse() === 1 && heavyWaiting() === 0)).toBe(true);
    dropRunning();
    await new Promise((r) => setTimeout(r, 50));
    gate.open();
    expect(await waitFor(() => heavyInUse() === 0)).toBe(true);
    // yuva gerçekten boş: sonraki firma beklemeden çalışır
    expect((await post('/invoices', 'org-d')).statusCode).toBe(200);
    expect(heavyInUse()).toBe(0);
  });

  it('sınır kapalıyken ağır yuva da sayılmaz', async () => {
    setEnv({ API_RATE_LIMIT: 'off', IMPORT_CONCURRENCY: '1' });
    gate = newGate();
    const runs = [post('/invoices'), post('/invoices'), post('/invoices')];
    await new Promise((r) => setTimeout(r, 50));
    expect(heavyInUse()).toBe(0);
    gate.open();
    for (const r of await Promise.all(runs)) expect(r.statusCode).toBe(200);
  });

  it('hız kovası ağır uçta da sayılır (write)', async () => {
    setEnv({ API_RATE_LIMIT: 'on', IMPORT_CONCURRENCY: '5', RATE_WRITE_PER_MIN_MEMBER: '2' });
    gate = newGate();
    gate.open();
    expect((await post('/invoices', 'org-d')).statusCode).toBe(200);
    expect((await post('/carriers', 'org-d')).statusCode).toBe(200);
    const limited = await post('/invoices', 'org-d');
    expect(limited.statusCode).toBe(429);
    expect(heavyInUse()).toBe(0);
  });

  it('Y56: canlı okuma kovasında firma başına üst sınır; kişi sınırı aynen; başka firma etkilenmez; reddedilen istek sayılmaz', async () => {
    setEnv({ API_RATE_LIMIT: 'on', RATE_VISION_PER_MIN_MEMBER: '2', RATE_VISION_PER_MIN_ORG: '5' });
    // Kişi sınırı: aynı kişinin üçüncü okuması 429 (firmada yer olsa da).
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-1')).statusCode).toBe(200);
    expect((await post('/vision/reference/detect', 'org-v', 'tr', 'v-1')).statusCode).toBe(200);
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-1')).statusCode).toBe(429);
    // Firma: 2 (v-1) + 2 (v-2) + 1 (v-3) = 5; altıncı, kişinin hakkı olsa da firmada takılır.
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-2')).statusCode).toBe(200);
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-2')).statusCode).toBe(200);
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-3')).statusCode).toBe(200);
    const orgLimited = await post('/vision/reference/detect', 'org-v', 'tr', 'v-3');
    expect(orgLimited.statusCode).toBe(429);
    // Mevcut 429 biçimi: aynı kod ve metin, `retry-after` başlığı.
    expect(orgLimited.json()).toEqual({ error: { code: 'TOO_MANY_REQUESTS', message: 'Çok fazla istek yapıldı. Biraz sonra yeniden deneyin.' } });
    const retryAfter = Number(orgLimited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await post('/vision/scale', 'org-v', 'tr', 'v-4')).statusCode).toBe(429);
    // Başka firma ayrı sayılır; firma kovası yazma kovasını tüketmez.
    expect((await post('/vision/scale', 'org-w', 'tr', 'w-1')).statusCode).toBe(200);
    expect((await post('/carriers', 'org-v', 'tr', 'v-4')).statusCode).toBe(200);
  });

  it('Y56: firma sınırının varsayılanı kişi sınırının dört katı (240/dk) ve ortam değişkeniyle ayarlanır', async () => {
    // boş değer = ayarlanmamış (varsayılan)
    setEnv({ API_RATE_LIMIT: 'on', RATE_VISION_PER_MIN_MEMBER: '1000', RATE_VISION_PER_MIN_ORG: '' });
    for (let i = 0; i < 240; i++) expect((await post('/vision/scale', 'org-x', 'tr', `x-${i % 10}`)).statusCode).toBe(200);
    expect((await post('/vision/scale', 'org-x', 'tr', 'x-99')).statusCode).toBe(429);
  });
});
