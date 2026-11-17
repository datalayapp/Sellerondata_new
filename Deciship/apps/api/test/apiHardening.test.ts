import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { missingProductionEnv } from '../src/env.ts';
import { redactFileToken, signFileToken, verifyFileToken } from '../src/lib/storage.ts';
import { prisma, TX_DEFAULTS } from '../src/db.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';

/** pg: aynı bağlantıda (işlem içinde) önceki sorgu bitmeden yeni sorgu → DeprecationWarning (pg 9'da hata). */
const pgWarnings: string[] = [];
const onWarning = (w: Error) => {
  if (/already executing a query/.test(w.message)) pgWarnings.push(w.message);
};

function tariff(carrierId: string, over: Record<string, unknown> = {}) {
  const rates = [];
  for (const zone of ['A', 'B', 'C']) for (let i = 1; i <= 100; i++) rates.push({ zone, weightUpto: i / 2, price: 100 + i });
  return {
    carrierId,
    name: uniq('Tarife '),
    currency: 'TRY',
    divisor: 3000,
    weightSteps: [{ upto: null, step: 0.5 }],
    zones: [{ country: 'DE', zone: 'A' }, { country: 'FR', zone: 'B' }, { country: 'GB', zone: 'C' }],
    rates,
    overflow: [{ zone: 'A', perUnit: 10 }],
    surcharges: [{ code: 'FUEL', name: 'Yakıt', kind: 'PCT', amount: 10 }],
    ...over,
  };
}

// Bu dosya kendi sürecinde çalışır (vitest isolate); pg uyarısı süreç başına bir kez basıldığından uyarı testi İLK sırada.
describe('API sağlamlığı', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.on('warning', onWarning);
    app = await getApp();
  });
  afterAll(() => {
    process.off('warning', onWarning);
  });

  it('tarife oluşturma/düzenleme/geri yükleme ve büyük fatura içe aktarma işlem içinde paralel sorgu atmaz (pg uyarısı yok)', async () => {
    const { auth } = await registerCompany(app);
    const carrierId = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'aras' } })).json().carrier.id;
    const created = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: auth, payload: tariff(carrierId) });
    expect(created.statusCode, created.body).toBe(201);
    const t = created.json().tariff;
    expect(t.rates).toHaveLength(300);
    expect(t.zones).toHaveLength(3);
    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${t.id}`, headers: auth, payload: tariff(carrierId, { name: 'Yeni ad', fuelPct: 5 }) });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().tariff).toMatchObject({ name: 'Yeni ad', fuelPct: 5 });
    expect(put.json().tariff.rates).toHaveLength(300);
    const dup = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/duplicate`, headers: auth });
    expect(dup.statusCode, dup.body).toBe(201);
    const versions = (await app.inject({ method: 'GET', url: `/api/deciship/tariffs/${t.id}/versions`, headers: auth })).json().items;
    const restore = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${t.id}/versions/${versions[0].id}/restore`, headers: auth });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json().tariff.name).toBe(t.name);

    // büyük fatura: satırlar tek createMany'de parametre sınırını aşınca Prisma parçaları paralel gönderiyordu
    const rows = Array.from({ length: 5000 }, (_, i) => `TR${String(i).padStart(10, '0')};Express;${1 + (i % 7)};${30 + (i % 13)}`);
    const csv = ['Takip No;Hizmet;Desi;Tutar', ...rows].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'buyuk.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(preview.statusCode, preview.body).toBe(200);
    const inv = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: {
        fileId: preview.json().fileId,
        carrierId,
        invoiceNo: uniq('F'),
        invoiceDate: '2026-10-15',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', service: 'Hizmet', billedKg: 'Desi', netAmount: 'Tutar' },
      },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    expect(await inCompany(auth, () => prisma.invoiceLine.count({ where: { invoiceId: inv.json().invoice.id } }))).toBe(5000);

    await new Promise((r) => setTimeout(r, 20)); // 'warning' olayı bir sonraki turda yayılır
    expect(pgWarnings).toEqual([]);
  });

  it('etkileşimli işlemler Prisma\'nın 5 sn varsayılanına takılmaz (yavaş makinede büyük tarife içe aktarma 500 veriyordu)', async () => {
    expect(TX_DEFAULTS.maxWait).toBeGreaterThanOrEqual(10_000);
    expect(TX_DEFAULTS.timeout).toBeGreaterThanOrEqual(60_000);
    // 5 sn'yi aşan işlem: eskiden "A commit cannot be executed on an expired transaction" → 500
    const { companyId } = await registerCompany(app);
    const n = await inCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(5.5)::text`;
        return tx.company.count();
      }),
    );
    expect(n).toBeGreaterThan(0);
  });

  it('üretimde güvenlik ayarları eksikse servis başlamaz; dosya imzası kendi anahtarıyla', () => {
    const full = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x', APP_BASE_URL: 'https://app.example.test' };
    expect(missingProductionEnv(full)).toEqual([]);
    expect(missingProductionEnv({ ...full, FILE_TOKEN_SECRET: ' ' })).toEqual(['FILE_TOKEN_SECRET']);
    expect(missingProductionEnv({ NODE_ENV: 'production' })).toEqual(['DATABASE_URL', 'ACCOUNT_JWKS_URL', 'ALLOWED_ORIGINS', 'FILE_TOKEN_SECRET', 'APP_BASE_URL']);
    expect(missingProductionEnv({ NODE_ENV: 'development' })).toEqual([]);
    expect(missingProductionEnv({ ...full, DATABASE_URL: 'postgresql://sod_deciship:sod_deciship_dev@db/sellerondata' })).toEqual(['DATABASE_URL (geliştirme parolası)']);
    expect(missingProductionEnv({ ...full, DATABASE_URL: 'postgresql://sod_deciship:gercek@db/sellerondata' })).toEqual([]);
    const grant = { fileId: 'dosya', companyId: 'firma', membershipId: 'uye', epoch: 3 };
    expect(verifyFileToken(signFileToken(grant))).toEqual(grant);
    expect(verifyFileToken(signFileToken(grant, -1))).toBeNull();
    expect(redactFileToken('/api/deciship/files/x?t=gizli.imza&y=1')).toBe('/api/deciship/files/x?t=[gizli]&y=1');
  });

  it('PATCH /carriers defaultMapping eşleme şemasıyla doğrulanır, boyutu sınırlıdır; null temizler', async () => {
    const { auth } = await registerCompany(app);
    const id = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex' } })).json().carrier.id;
    const patch = (defaultMapping: unknown) => app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${id}`, headers: auth, payload: { defaultMapping } });

    const ok = await patch({ trackingNo: ' Takip No ', netAmount: 'Tutar', surchargeColumns: [{ header: 'Yakıt', code: 'FUEL' }], uydurma: 'x'.repeat(10) });
    expect(ok.statusCode, ok.body).toBe(200);
    const saved = ok.json().carrier.defaultMapping;
    expect(saved).toMatchObject({ trackingNo: 'Takip No', netAmount: 'Tutar', surchargeColumns: [{ header: 'Yakıt', code: 'FUEL' }] });
    expect(saved).not.toHaveProperty('uydurma');

    const bad = await patch({ trackingNo: 'A', vatPct: 'yirmi', surchargeColumns: [{ header: '' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION');
    expect((await patch('metin')).statusCode).toBe(400);
    const huge = await patch({ trackingNo: 'A', chargePairs: Array.from({ length: 5000 }, (_, i) => ({ label: `Etiket ${i}`, amount: `Tutar ${i}` })) });
    expect(huge.statusCode).toBe(400);

    const cleared = await patch(null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().carrier.defaultMapping).toBeNull();
    // eşleme verilmezse dokunulmaz
    await patch({ trackingNo: 'T' });
    const renamed = await app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${id}`, headers: auth, payload: { name: 'FedEx TR' } });
    expect(renamed.json().carrier).toMatchObject({ name: 'FedEx TR', defaultMapping: { trackingNo: 'T' } });
  });

});
