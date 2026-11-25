import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { GB_BYTES, STORAGE_WARN_PCT, countedStorageBytes, storageUsage } from '../src/services/storageQuota.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany } from './helpers.ts';

/** 06-B6: GET /platform/storage-usage (Merkez Abonelik kartı için sayılar; ekran yok). */
const API = '/api/deciship';
const QUOTA_ENV = 'STORAGE_QUOTA_GB_PER_ORG';

describe('GET /platform/storage-usage', () => {
  let app: FastifyInstance;
  let A: Fixture;
  const saved = process.env[QUOTA_ENV];

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[QUOTA_ENV];
    else process.env[QUOTA_ENV] = saved;
  });
  afterAll(() => undefined);

  const get = (auth: { authorization: string }) => app.inject({ method: 'GET', url: `${API}/platform/storage-usage`, headers: auth });

  it('kota açıkken kullanılan bayt, yüzde ve uyarı doğru', async () => {
    process.env[QUOTA_ENV] = '1';
    const used = await countedStorageBytes(A.companyId);
    expect(used).toBeGreaterThan(0);
    let r = await get(A.admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.json()).toEqual({ usedBytes: used, limitBytes: GB_BYTES, limitGb: 1, usedPct: Math.round((used / GB_BYTES) * 1000) / 10, warn: false });

    // 1 GB kotanın tam %80'ine dolgu satırı: uyarı açılır
    const target = Math.ceil((GB_BYTES * STORAGE_WARN_PCT) / 100);
    await inCompany(A.companyId, () =>
      prisma.file.create({
        data: { companyId: A.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: target - used, path: `${A.companyId}/ballast/x.csv`, sha256: 'x', createdById: A.admin.userId },
      }),
    );
    r = await get(A.admin.auth);
    expect(r.json()).toMatchObject({ usedBytes: target, usedPct: 80, warn: true });
    expect(await storageUsage(A.companyId)).toMatchObject({ usedBytes: target, warn: true });
  });

  it('kota 0 (kapalı): sınır ve yüzde null, uyarı yok', async () => {
    process.env[QUOTA_ENV] = '0';
    const r = await get(A.admin.auth);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ limitBytes: null, limitGb: null, usedPct: null, warn: false });
    expect(r.json().usedBytes).toBeGreaterThan(0);
  });

  it('bağımsız inceleme: her firma yalnız kendi kullanımını görür (firma oturumdan; adres ya da sorgu ile seçilemez)', async () => {
    process.env[QUOTA_ENV] = '1';
    const B = await companyFixture(app);
    await inCompany(A.companyId, () =>
      prisma.file.create({
        data: { companyId: A.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 12_345_678, path: `${A.companyId}/ballast/y.csv`, sha256: 'y', createdById: A.admin.userId },
      }),
    );
    const usedA = await countedStorageBytes(A.companyId);
    const usedB = await countedStorageBytes(B.companyId);
    expect(usedA).not.toBe(usedB);
    expect((await get(B.admin.auth)).json().usedBytes).toBe(usedB);
    const r = await app.inject({ method: 'GET', url: `${API}/platform/storage-usage?companyId=${A.companyId}&orgId=${A.companyId}`, headers: B.admin.auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().usedBytes).toBe(usedB);
  });

  it('ayar izni olmayan rol 403', async () => {
    expect((await get(A.worker.auth)).statusCode).toBe(403);
  });
});
