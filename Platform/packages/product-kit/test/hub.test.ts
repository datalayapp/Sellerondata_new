import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerProductAuth } from '@sellerondata/auth-kit';
import { createTestAuthority, TEST_ORIGIN, type TestAuthority } from '@sellerondata/auth-kit/testing';
import type { HubActivityPage, HubAnalytics, HubDatasetList, HubOverview } from '@sellerondata/contracts';
import { registerHubRoutes, registerProductIdentity, type HubProviders, type HubRoutesOptions, type SqlDb } from '../src/index.ts';
import { ORNEKARAC } from './ornekarac/product.ts';

/** Merkez çatısı, veritabanısız: kimlik auth-kit + bellekteki üye kaydı, sağlayıcılar bellekte. */

let authority: TestAuthority;
let app: FastifyInstance | null = null;
const savedEnv = process.env.NODE_ENV;

beforeAll(async () => {
  authority = await createTestAuthority();
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
  await app?.close();
  app = null;
});

const NOW_DAY = new Date().toISOString().slice(0, 10);

async function build(providers: HubProviders = {}, extra: Partial<HubRoutesOptions> = {}) {
  app = Fastify();
  registerProductAuth(app, {
    product: 'ornekarac',
    definition: ORNEKARAC,
    ...authority.authOptions,
    allowedOrigins: [TEST_ORIGIN],
    loadMember: async () => ({ epoch: 0, active: true }),
  });
  // Firma kaynağı bellekte (veritabanlı yol: ornekarac.db.test.ts).
  registerHubRoutes(app, { product: 'ornekarac', definition: ORNEKARAC, providers, org: async () => ({ companyConfirmed: true }), ...extra });
  await app.ready();
  return app;
}

const token = (role: string | null = 'ADMIN', extra: Parameters<TestAuthority['accessToken']>[0] = {}) =>
  authority.accessToken({ product: 'ornekarac', role, orgId: 'org-a', ...extra });
const get = async (url: string, tok: string, headers: Record<string, string> = {}) =>
  app!.inject({ url: `/api/ornekarac/platform${url}`, headers: { ...authority.bearer(tok), ...headers } });

describe('boş Merkez yanıtları (sağlayıcı yok)', () => {
  it('dört uç geçerli boş şekil döner, dönem isteği yansıtır', async () => {
    await build();
    const t = await token();
    const overview = await get('/overview?from=2026-10-01&to=2026-10-31', t);
    expect(overview.statusCode).toBe(200);
    expect(overview.json<HubOverview>()).toEqual({ product: 'ornekarac', from: '2026-10-01', to: '2026-10-31', kpis: [], alerts: [] });
    expect((await get('/analytics?from=2026-10-01&to=2026-10-02', t)).json<HubAnalytics>()).toEqual({
      product: 'ornekarac',
      from: '2026-10-01',
      to: '2026-10-02',
      filters: [],
      sections: [],
    });
    expect((await get('/datasets', t)).json<HubDatasetList>()).toEqual({ product: 'ornekarac', datasets: [] });
    expect((await get('/activity?page=2', t)).json<HubActivityPage>()).toEqual({ items: [], page: 2, pageSize: 25, total: 0 });
    expect((await get('/datasets/kayitlar', t)).statusCode).toBe(404);
    expect((await get('/datasets/kayitlar/export', t)).statusCode).toBe(404);
  });

  it('dönem verilmezse firmanın gününe göre son 30 gün', async () => {
    await build({}, { org: async () => ({ timeZone: 'UTC', companyConfirmed: true }) });
    const body = (await get('/overview', await token())).json<HubOverview>();
    expect(body.to).toBe(NOW_DAY);
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(29);
  });

  it('yanıt kişisel önbellekli', async () => {
    await build();
    const res = await get('/overview', await token());
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.vary).toContain('Accept-Language');
  });
});

describe('izinler kaydın hub alanından', () => {
  it('VIEWER Genel Bakış ve veriyi görür, CSV alamaz', async () => {
    await build();
    const t = await token('VIEWER');
    expect((await get('/overview', t)).statusCode).toBe(200);
    expect((await get('/datasets', t)).statusCode).toBe(200);
    const exp = await get('/datasets/kayitlar/export', t);
    expect(exp.statusCode).toBe(403);
    expect(exp.json().error.code).toBe('FORBIDDEN');
  });

  it('jetonda araç yoksa 403 NO_PRODUCT_ACCESS; jetonsuz 401', async () => {
    await build();
    const other = await authority.accessToken({ product: 'deciship', role: 'ADMIN', orgId: 'org-a' });
    const res = await get('/overview', other);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NO_PRODUCT_ACCESS');
    expect((await app!.inject({ url: '/api/ornekarac/platform/overview' })).statusCode).toBe(401);
  });

  it('bilinmeyen rol hiçbir uca giremez', async () => {
    await build();
    const t = await token('AUDITOR');
    for (const url of ['/overview', '/analytics', '/datasets', '/activity']) expect((await get(url, t)).statusCode).toBe(403);
  });

  it('salt okunur abonelikte Merkez okunur', async () => {
    await build();
    expect((await get('/overview', await token('ADMIN', { status: 'READ_ONLY' }))).statusCode).toBe(200);
  });
});

describe('doğrulama ve hata gövdesi', () => {
  it('bozuk tarih 400 VALIDATION, istek dilinde', async () => {
    await build();
    const t = await token();
    const tr = await get('/overview?from=2026-02-30', t);
    expect(tr.statusCode).toBe(400);
    expect(tr.json()).toEqual({ error: { code: 'VALIDATION', message: 'Tarih YYYY-AA-GG biçiminde olmalı' } });
    const en = await get('/analytics?from=2026-10-05&to=2026-10-01', t, { 'accept-language': 'en-GB,en;q=0.9' });
    expect(en.json()).toEqual({ error: { code: 'VALIDATION', message: 'Start date cannot be after the end date' } });
    const range = await get('/overview?from=2020-01-01&to=2026-01-01', t);
    expect(range.json().error.message).toBe('Tarih aralığı en çok 732 gün olabilir');
    expect((await get('/activity?page=1e9', t)).json().error.code).toBe('VALIDATION');
  });

  it('geçersiz veri kümesi kimliği sağlayıcıya gitmez', async () => {
    const seen: string[] = [];
    await build({
      datasets: {
        list: async () => ({ product: 'ornekarac', datasets: [] }),
        page: async (_ctx, id) => {
          seen.push(id);
          return null;
        },
      },
    });
    const res = await get(`/datasets/${encodeURIComponent('a"b')}`, await token());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(seen).toEqual([]);
  });
});

describe('sağlayıcılar', () => {
  it('bağlam: firma, üye, dil, izin, saat dilimi', async () => {
    let seen: unknown = null;
    await build(
      {
        overview: async (ctx, period) => {
          seen = {
            orgId: ctx.orgId,
            memberId: ctx.memberId,
            locale: ctx.locale,
            timeZone: ctx.timeZone,
            companyConfirmed: ctx.companyConfirmed,
            canExport: ctx.can('ornekarac.data.export'),
            days: period.days,
          };
          return { product: 'ornekarac', from: period.from, to: period.to, kpis: [], alerts: [] };
        },
      },
      { org: async (orgId) => (orgId === 'org-a' ? { timeZone: 'Europe/Berlin', companyConfirmed: true } : null) },
    );
    await get('/overview?from=2026-10-01&to=2026-10-07', await token('VIEWER', { membershipId: 'm-7', locale: 'en' }));
    expect(seen).toEqual({ orgId: 'org-a', memberId: 'm-7', locale: 'en', timeZone: 'Europe/Berlin', companyConfirmed: true, canExport: false, days: 7 });
  });

  it('firma kaydı yoksa ya da saat dilimi bozuksa varsayılan saat dilimi, onay yok', async () => {
    const seen: unknown[] = [];
    let profile: { timeZone?: string | null; companyConfirmed?: boolean } | null = null;
    await build(
      {
        overview: async (ctx, period) => {
          seen.push({ timeZone: ctx.timeZone, companyConfirmed: ctx.companyConfirmed });
          return { product: 'ornekarac', from: period.from, to: period.to, kpis: [], alerts: [] };
        },
      },
      { org: async () => profile },
    );
    const t = await token();
    await get('/overview?from=2026-10-01&to=2026-10-07', t);
    profile = { timeZone: '+03:00', companyConfirmed: true };
    await get('/overview?from=2026-10-01&to=2026-10-07', t);
    profile = { timeZone: null };
    await get('/overview?from=2026-10-01&to=2026-10-07', t);
    expect(seen).toEqual([
      { timeZone: 'Europe/Istanbul', companyConfirmed: false },
      { timeZone: 'Europe/Istanbul', companyConfirmed: true },
      { timeZone: 'Europe/Istanbul', companyConfirmed: false },
    ]);
  });

  it('kurulum Merkez onayına bağlı: onaysız firmada setup.completed false döner, onaylıda sağlayıcının değeri', async () => {
    let confirmed = false;
    const setup = { completed: true, href: '/ornekarac/kurulum', label: '' };
    await build(
      { overview: async (_ctx, period) => ({ product: 'ornekarac', from: period.from, to: period.to, kpis: [], alerts: [], setup }) },
      { org: async () => ({ companyConfirmed: confirmed }) },
    );
    const t = await token();
    expect((await get('/overview?from=2026-10-01&to=2026-10-07', t)).json<HubOverview>().setup).toEqual({ ...setup, completed: false });
    confirmed = true;
    expect((await get('/overview?from=2026-10-01&to=2026-10-07', t)).json<HubOverview>().setup).toEqual(setup);
    // setup vermeyen sağlayıcıya çatı alan eklemez
    expect((await get('/analytics?from=2026-10-01&to=2026-10-07', t)).json()).not.toHaveProperty('setup');
  });

  it('CSV: başlık, dil, dosya adı, saat dilimi, formül nötrleme', async () => {
    await build(
      {
        datasets: {
          list: async () => ({ product: 'ornekarac', datasets: [] }),
          page: async () => null,
          export: async (_ctx, id) =>
            id === 'kayitlar'
              ? {
                  columns: [
                    { id: 'title', label: 'Başlık', format: 'text' },
                    { id: 'n', label: 'Tutar', format: 'money' },
                    { id: 'at', label: 'An', format: 'datetime' },
                  ],
                  async *batches() {
                    yield [{ id: '1', cells: { title: '=1+1', n: 12.5, at: '2026-10-01T21:30:00.000Z' } }];
                    yield [{ id: '2', cells: { title: 'a;b', n: null, at: null } }];
                  },
                }
              : null,
        },
      },
      { org: async () => ({ timeZone: 'Europe/Istanbul', companyConfirmed: true }) },
    );
    const res = await get('/datasets/kayitlar/export', await token());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ornekarac-kayitlar-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toBe('\uFEFFBaşlık;Tutar;An\r\n\'=1+1;12,50;2026-10-02 00:30\r\n"a;b";;\r\n');
    expect((await get('/datasets/baska/export', await token())).statusCode).toBe(404);
  });

  it('sağlayıcı hatası: KitError sözleşme gövdesi, beklenmeyen hata 500', async () => {
    const { KitError } = await import('../src/index.ts');
    await build({
      analytics: async () => {
        throw new KitError(409, 'CONFLICT', 'çakışma');
      },
      activity: async () => {
        throw new Error('beklenmeyen');
      },
    });
    const t = await token();
    expect((await get('/analytics', t)).json()).toEqual({ error: { code: 'CONFLICT', message: 'çakışma' } });
    expect((await get('/activity', t)).statusCode).toBe(500);
  });
});

describe('firma başına sınır', () => {
  it('sınır dolunca 429 + Retry-After; başka firma etkilenmez; yuva bırakılır', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    await build(
      {
        overview: async (_ctx, period) => {
          entered += 1;
          await gate;
          return { product: 'ornekarac', from: period.from, to: period.to, kpis: [], alerts: [] };
        },
      },
      { limits: { general: 2 } },
    );
    const t = await token();
    const slow = [get('/overview', t), get('/overview', t)];
    while (entered < 2) await new Promise((r) => setTimeout(r, 5));
    const busy = await get('/overview', t);
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('3');
    expect(busy.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    // Başka firma: kendi yuvası
    const otherOrg = get('/overview', await token('ADMIN', { orgId: 'org-b' }));
    while (entered < 3) await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await Promise.all([...slow, otherOrg])).map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect((await get('/overview', t)).statusCode).toBe(200);
  });

  it('yetkisiz istek yuva tutmaz', async () => {
    await build({}, { limits: { general: 1 } });
    const viewer = await token('AUDITOR');
    for (let i = 0; i < 3; i++) expect((await get('/overview', viewer)).statusCode).toBe(403);
    expect((await get('/overview', await token())).statusCode).toBe(200);
  });
});

describe('açılış denetimleri', () => {
  it('kayıtta olmayan araç tanımsız: açılış durur', () => {
    const a = Fastify();
    registerProductAuth(a, { product: 'ornekarac', definition: ORNEKARAC, ...authority.authOptions, allowedOrigins: [], loadMember: async () => null });
    expect(() => registerHubRoutes(a, { product: 'ornekarac', providers: {} })).toThrow(/kaydında yok/);
  });

  it('hub alanı olmayan araç ve kimliksiz uygulama reddedilir', () => {
    const a = Fastify();
    expect(() => registerHubRoutes(a, { product: 'ornekarac', definition: ORNEKARAC, providers: {} })).toThrow(/önce registerProductIdentity/);
    registerProductAuth(a, { product: 'ornekarac', definition: ORNEKARAC, ...authority.authOptions, allowedOrigins: [], loadMember: async () => null });
    const { hub: _hub, ...noHub } = ORNEKARAC;
    expect(() => registerHubRoutes(a, { product: 'ornekarac', definition: noHub, providers: {} })).toThrow(/hub/);
    // auth-kit tek başına firma kaydı vermez: saat dilimi ve onay kaynağı olmadan açılış durur
    expect(() => registerHubRoutes(a, { product: 'ornekarac', definition: ORNEKARAC, providers: {} })).toThrow(/firma kaydı yok/);
  });

  it('test koşusu dışında fikstür tanımı kabul edilmez (kimlik ve Merkez)', () => {
    process.env.NODE_ENV = 'staging';
    const db = {} as SqlDb;
    expect(() =>
      registerProductIdentity(Fastify(), { product: 'ornekarac', definition: ORNEKARAC, db, schema: 'ornekarac', jwksUrl: authority.jwksUrl, allowedOrigins: [] }),
    ).toThrow(/NODE_ENV=test/);
    expect(() => registerHubRoutes(Fastify(), { product: 'ornekarac', definition: ORNEKARAC, providers: {} })).toThrow(/NODE_ENV=test/);
  });

  it('kimlik: kayıtta olmayan anahtar ve bozuk şema adı reddedilir', () => {
    const db = {} as SqlDb;
    expect(() => registerProductIdentity(Fastify(), { product: 'ornekarac', db, schema: 'ornekarac', jwksUrl: authority.jwksUrl, allowedOrigins: [] })).toThrow(
      /kaydında yok/,
    );
    expect(() =>
      registerProductIdentity(Fastify(), { product: 'ornekarac', definition: ORNEKARAC, db, schema: 'ornek"; DROP', jwksUrl: authority.jwksUrl, allowedOrigins: [] }),
    ).toThrow(/geçersiz SQL adı/);
  });

  it('kimlik: dosya yolu dönen silme tablosu varken onPurged (ve onRowsDeleted) zorunlu; paketin tablosu ve tekrar listeye yazılamaz', () => {
    const db = {} as SqlDb;
    const base = { product: 'ornekarac', definition: ORNEKARAC, db, schema: 'ornekarac', jwksUrl: authority.jwksUrl, allowedOrigins: [] };
    const files = [{ table: 'Item', returning: ['attachment'] }];
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: files, onRowsDeleted: async () => {} } })).toThrow(/onPurged/);
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: files, onPurged: async () => {} } })).toThrow(/onRowsDeleted/);
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: files, onRowsDeleted: async () => {}, onPurged: async () => {} } })).not.toThrow();
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: ['Item'] } })).not.toThrow();
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: ['Member'] } })).toThrow(/paketin tablosu/);
    expect(() => registerProductIdentity(Fastify(), { ...base, purge: { tables: ['Item', 'Item'] } })).toThrow(/iki kez/);
  });
});
