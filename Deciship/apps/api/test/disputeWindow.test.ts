/**
 * 06-B5: itiraz penceresi (`GET /invoices/:id/dispute`) fotoğrafları her açılışta (dil değişince de) diskten okuyup
 * yeniden taramaz: aynı dosyanın (boyutu ve değişme anı aynı) temizlenebilirliği bir kez hesaplanır. Sayı ZIP'inkiyle aynı
 * kuralla çıkar; dosya değişirse yeniden hesaplanır.
 */
import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { absolutePath } from '../src/lib/storage.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany } from './helpers.ts';

const API = '/api/deciship';

describe('itiraz penceresi fotoğraf taraması (06-B5)', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let photoAbs = '';

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
    const line = (await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/lines`, headers: A.admin.auth })).json().items.find((l: { id: string }) => l.id === A.lineId);
    expect(line.status).toBe('DIFF');
    const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${A.lineId}`, headers: A.admin.auth, payload: { decision: 'VERIFIED' } });
    expect(r.statusCode, r.body).toBe(200);
    const photo = await inCompany(A.companyId, () => prisma.file.findFirstOrThrow({ where: { companyId: A.companyId, measurementId: A.measurement.id } }));
    photoAbs = absolutePath(photo.path);
  });
  afterEach(() => vi.restoreAllMocks());

  const open = (lang?: string) => app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute${lang ? `?lang=${lang}` : ''}`, headers: A.admin.auth });

  it('pencere tekrar açılınca ve dil değişince fotoğraf yeniden okunmaz; sayı aynı', async () => {
    const reads = vi.spyOn(fsp, 'readFile');
    const photoReads = () => reads.mock.calls.filter(([p]) => String(p) === photoAbs).length;
    const first = await open();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().photoCount).toBe(1);
    expect(photoReads()).toBe(1);
    for (const lang of [undefined, 'en', 'tr']) {
      const again = await open(lang);
      expect(again.statusCode).toBe(200);
      expect(again.json().photoCount).toBe(1);
    }
    expect(photoReads()).toBe(1);
  });

  it('dosya değişirse (boyut ya da değişme anı) yeniden taranır: temizlenemeyen içerik sayılmaz', async () => {
    const original = await fsp.readFile(photoAbs);
    try {
      // görüntü değil: üst verisi temizlenemez, ZIP'e girmez; pencere de saymamalı
      await fsp.writeFile(photoAbs, Buffer.from('bu bir görüntü değil'));
      const changed = await open();
      expect(changed.statusCode).toBe(200);
      expect(changed.json().photoCount).toBe(0);
    } finally {
      await fsp.writeFile(photoAbs, original);
    }
    expect((await open()).json().photoCount).toBe(1);
  });
});
