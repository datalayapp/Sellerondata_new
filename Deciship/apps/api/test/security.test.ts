import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { companyFixture, tariffPayload, type Fixture } from './fixtures.ts';
import { createMember, createWorker, findMoneyKeys, getApp, getAuthority, inCompany, JPEG, measurementPayload, multipart, registerCompany, sendEvent, uniq, type Part } from './helpers.ts';

/**
 * Güvenlik denetimi: şirketler arası sızıntı, ölçüm rolünün yetkileri ve fiyat gizliliği,
 * dosya yükleme sınırları, oturum/jeton, girdi doğrulama.
 */

type Auth = { authorization: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Req = { method: Method; url: string; payload?: unknown; multipart?: Part[] };

function registerSecondAdmin(app: FastifyInstance, adminAuth: Auth) {
  return createMember(app, adminAuth, 'ADMIN', 'İkinci Yönetici');
}

async function send(app: FastifyInstance, auth: Auth | Record<string, never>, r: Req) {
  if (r.multipart) {
    const form = multipart(r.multipart);
    return app.inject({ method: r.method, url: r.url, headers: { ...auth, ...form.headers }, payload: form.payload });
  }
  return app.inject({ method: r.method, url: r.url, headers: auth, ...(r.payload !== undefined ? { payload: r.payload as object } : {}) });
}

describe('şirketler arası sızıntı', () => {
  let A: Fixture;
  let B: Fixture;

  beforeAll(async () => {
    const app = await getApp();
    A = await companyFixture(app);
    B = await companyFixture(app);
  });

  it('B yöneticisi A\'nın hiçbir kaydına id ile ulaşamaz (tüm rotalar)', async () => {
    const app = await getApp();
    const mPatch = { lengthCm: 99 };
    // A'nın bekleyen tarife PDF işi (kuyrukta; satır içi kipte kimse almaz)
    const aJob = await inCompany(A.companyId, () =>
      prisma.job.create({
        data: { companyId: A.companyId, kind: 'TARIFF_PDF_EXTRACT', dedupeKey: `security:${crypto.randomUUID()}`, input: { v: 1, locale: 'tr' }, refType: 'TariffDocument', refId: A.documentId, createdById: A.admin.userId },
        select: { id: true },
      }),
    );
    const aJobId = aJob.id;
    const reqs: Req[] = [
      // ölçümler
      { method: 'GET', url: `/api/deciship/measurements/${A.measurement.id}` },
      { method: 'PATCH', url: `/api/deciship/measurements/${A.measurement.id}`, payload: mPatch },
      { method: 'DELETE', url: `/api/deciship/measurements/${A.measurement.id}` },
      { method: 'POST', url: `/api/deciship/measurements/${A.measurement.id}/restore` },
      // dosyalar
      { method: 'GET', url: `/api/deciship/files/${A.photoId}` },
      { method: 'GET', url: `/api/deciship/files/${A.invoiceFileId}` },
      // faturalar
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}` },
      { method: 'PATCH', url: `/api/deciship/invoices/${A.invoiceId}`, payload: { invoiceNo: 'X1' } },
      { method: 'DELETE', url: `/api/deciship/invoices/${A.invoiceId}` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/lines` },
      { method: 'POST', url: `/api/deciship/invoices/${A.invoiceId}/recompare` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/report.xlsx` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/report.pdf` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/dispute` },
      { method: 'PATCH', url: `/api/deciship/invoice-lines/${A.lineId}`, payload: { decision: 'VERIFIED' } },
      // B'nin kendi kaydına A'nın id'sini bağlamak
      { method: 'PATCH', url: `/api/deciship/invoice-lines/${B.lineId}`, payload: { measurementId: A.measurement.id } },
      { method: 'PATCH', url: `/api/deciship/invoices/${B.invoiceId}`, payload: { carrierId: A.carrierId } },
      { method: 'PATCH', url: `/api/deciship/invoices/${B.invoiceId}`, payload: { tariffId: A.tariffId } },
      { method: 'POST', url: '/api/deciship/invoices/preview/verify', payload: { fileId: A.invoiceFileId, carrierId: B.carrierId, mapping: { trackingNo: 'Takip No', netAmount: 'Tutar' } } },
      { method: 'POST', url: '/api/deciship/invoices', payload: { fileId: A.invoiceFileId, carrierId: B.carrierId, invoiceNo: 'Y1', invoiceDate: '2026-10-15', mapping: { trackingNo: 'Takip No', netAmount: 'Tutar' } } },
      { method: 'POST', url: '/api/deciship/invoices', payload: { fileId: B.invoiceFileId, carrierId: A.carrierId, invoiceNo: 'Y2', invoiceDate: '2026-10-15', mapping: { trackingNo: 'Takip No', netAmount: 'Tutar' } } },
      { method: 'POST', url: '/api/deciship/invoices/preview', multipart: [{ name: 'carrierId', value: A.carrierId }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from('Takip No;Tutar\n1;2') }] },
      // tarifeler
      { method: 'GET', url: `/api/deciship/tariffs/${A.tariffId}` },
      { method: 'PUT', url: `/api/deciship/tariffs/${A.tariffId}`, payload: tariffPayload(B.carrierId) },
      { method: 'DELETE', url: `/api/deciship/tariffs/${A.tariffId}` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/default` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/duplicate` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/quote`, payload: { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1 } },
      // Y83: toplu hesap yalnız arka planda; `?async=1` ile istek gerçekten kayıt aramasına (404) ulaşır
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/recompare-invoices?async=1`, payload: { token: 'x' } },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/recompare-invoices/preview?async=1`, payload: {} },
      { method: 'GET', url: `/api/deciship/tariffs/${A.tariffId}/versions` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/versions/${A.versionId}/restore` },
      { method: 'POST', url: `/api/deciship/tariffs/${B.tariffId}/versions/${A.versionId}/restore` },
      { method: 'GET', url: `/api/deciship/tariffs/template.xlsx?tariffId=${A.tariffId}` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/import`, multipart: [{ name: 'file', filename: 't.csv', contentType: 'text/csv', data: Buffer.from('a;b\n1;2') }] },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(A.carrierId) },
      { method: 'POST', url: `/api/deciship/tariff-imports`, multipart: [{ name: 'carrierId', value: A.carrierId }, { name: 'file', filename: 't.csv', contentType: 'text/csv', data: Buffer.from('a;b\n1;2') }] },
      { method: 'POST', url: `/api/deciship/tariff-imports/${A.draftId}/recheck`, payload: {} },
      { method: 'POST', url: `/api/deciship/tariff-imports/${A.draftId}/apply`, payload: { acknowledged: true } },
      { method: 'GET', url: `/api/deciship/tariff-documents/${A.documentId}` },
      { method: 'POST', url: `/api/deciship/tariff-documents/${A.documentId}/scan`, payload: { mode: 'code' } },
      { method: 'POST', url: `/api/deciship/tariff-documents/${A.documentId}/scan?async=1`, payload: { mode: 'ai' } },
      { method: 'POST', url: `/api/deciship/tariff-documents/${A.documentId}/extract?async=1`, payload: { sectionIds: ['c1'], target: { tariffId: A.tariffId } } },
      // Y83/Y90: eski `GET /tariff-documents/:documentId/jobs/:jobId` kaldırıldı; iş yalnız `GET /jobs/:id` ile, A'nın gerçek işiyle
      { method: 'GET', url: `/api/deciship/jobs/${aJobId}` },
      { method: 'POST', url: `/api/deciship/jobs/${aJobId}/cancel`, payload: {} },
      // taşıyıcılar, hazır koliler
      { method: 'PATCH', url: `/api/deciship/carriers/${A.carrierId}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/api/deciship/carriers/${A.carrierId}` },
      { method: 'PATCH', url: `/api/deciship/box-presets/${A.presetId}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/api/deciship/box-presets/${A.presetId}` },
    ];
    const leaks: string[] = [];
    for (const r of reqs) {
      const res = await send(app, B.admin.auth, r);
      if (res.statusCode < 400 || res.statusCode >= 500) leaks.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      else expect(res.json().error?.message, `${r.method} ${r.url}`).toEqual(expect.any(String));
    }
    expect(leaks).toEqual([]);

    // A'nın verisi değişmedi
    await inCompany(A.companyId, async () => {
      const m = await prisma.measurement.findUniqueOrThrow({ where: { id: A.measurement.id } });
      expect(m).toMatchObject({ deletedAt: null, supersededById: null });
      expect(Number(m.lengthCm)).toBe(30);
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: A.invoiceId } })).toMatchObject({ deletedAt: null });
      expect(await prisma.invoiceLine.findUniqueOrThrow({ where: { id: A.lineId } })).toMatchObject({ decision: 'OPEN' });
      expect(await prisma.tariff.findUniqueOrThrow({ where: { id: A.tariffId } })).toMatchObject({ name: 'Değişti' });
      expect(await prisma.member.findUniqueOrThrow({ where: { id: A.worker.userId } })).toMatchObject({ active: true });
      expect(await prisma.boxPreset.findUnique({ where: { id: A.presetId } })).not.toBeNull();
      expect(await prisma.carrier.findUniqueOrThrow({ where: { id: A.carrierId } })).toMatchObject({ name: 'Aras', active: true });
      expect(await prisma.job.findUniqueOrThrow({ where: { id: aJobId } })).toMatchObject({ status: 'QUEUED', cancelRequestedAt: null });
    });
    const bLine = await inCompany(B.companyId, () => prisma.invoiceLine.findUniqueOrThrow({ where: { id: B.lineId } }));
    expect(bLine.measurementId).not.toBe(A.measurement.id);
  });

  it('listeler, arama ve ölçüm kontrolü yalnız kendi şirketini gösterir', async () => {
    const app = await getApp();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: B.admin.auth }).then((r) => r.json());
    const all = JSON.stringify([
      await get('/api/deciship/carriers'),
      await get('/api/deciship/tariffs'),
      await get(`/api/deciship/tariffs?carrierId=${A.carrierId}`),
      await get('/api/deciship/invoices'),
      await get(`/api/deciship/invoices?carrierId=${A.carrierId}`),
      await get('/api/deciship/measurements?pageSize=500'),
      await get(`/api/deciship/measurements?userId=${A.worker.userId}`),
      await get(`/api/deciship/measurements?q=${A.measurement.trackingNo}`),
      await get('/api/deciship/box-presets'),
      await get('/api/deciship/dashboard'),
    ]);
    for (const id of [A.admin.user.id, A.worker.userId, A.carrierId, A.tariffId, A.invoiceId, A.measurement.id, A.presetId]) {
      expect(all.includes(id), id).toBe(false);
    }
    const check = await get(`/api/deciship/measurements/check?tracking=${A.measurement.trackingNo}`);
    expect(check).toEqual({ exists: false });
  });

  it('başka şirketin clientId\'si ya da hazır kolisi ölçümde veri sızdırmaz', async () => {
    const app = await getApp();
    const dup = measurementPayload({ clientId: A.measurement.clientId });
    const r1 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...B.admin.auth, ...dup.headers }, payload: dup.payload });
    expect(r1.statusCode).toBe(201);
    expect(r1.body.includes(A.measurement.id)).toBe(false);
    const withPreset = measurementPayload({ boxPresetId: A.presetId });
    const r2 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...B.admin.auth, ...withPreset.headers }, payload: withPreset.payload });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().measurement.boxPresetId).toBeNull();
  });

  it('dosya bağlantısı başka dosya / başka şirket için kullanılamaz; yol hilesi 404', async () => {
    const app = await getApp();
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${A.measurement.id}`, headers: A.admin.auth });
    const url = new URL(detail.json().measurement.photos[0].url);
    const t = url.searchParams.get('t')!;
    const own = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(own.statusCode).toBe(200);
    // aynı imza başka dosya id'siyle
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${B.photoId}?t=${t}` })).statusCode).toBe(404);
    // imza kurcalanmış
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${A.photoId}?t=${t.slice(0, -2)}xx` })).statusCode).toBe(404);
    // yol hilesi
    for (const u of ['/api/deciship/files/..%2F..%2Fpackage.json', '/api/deciship/files/%2E%2E%2F%2E%2E%2F.env', '/api/deciship/files/../../.env']) {
      const r = await app.inject({ method: 'GET', url: u, headers: A.admin.auth });
      expect(r.statusCode, u).toBe(404);
    }
    // indirilen dosya tarayıcıda çalıştırılamaz
    expect(own.headers['x-content-type-options']).toBe('nosniff');
  });

  it('WORKER yönetici uçlarına erişemez (403)', async () => {
    const app = await getApp();
    const reqs: Req[] = [
      { method: 'PATCH', url: '/api/deciship/settings', payload: { desiDivisor: 4000 } },
      { method: 'POST', url: '/api/deciship/box-presets', payload: { name: 'X', lengthCm: 1, widthCm: 1, heightCm: 1 } },
      { method: 'PATCH', url: `/api/deciship/box-presets/${A.presetId}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/api/deciship/box-presets/${A.presetId}` },
      { method: 'GET', url: '/api/deciship/dashboard' },
      { method: 'GET', url: '/api/deciship/carriers' },
      { method: 'POST', url: '/api/deciship/carriers', payload: { code: 'ups' } },
      { method: 'PATCH', url: `/api/deciship/carriers/${A.carrierId}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/api/deciship/carriers/${A.carrierId}` },
      { method: 'GET', url: '/api/deciship/tariffs' },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(A.carrierId) },
      { method: 'GET', url: `/api/deciship/tariffs/${A.tariffId}` },
      { method: 'PUT', url: `/api/deciship/tariffs/${A.tariffId}`, payload: tariffPayload(A.carrierId) },
      { method: 'DELETE', url: `/api/deciship/tariffs/${A.tariffId}` },
      { method: 'POST', url: `/api/deciship/tariffs/${A.tariffId}/quote`, payload: { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1 } },
      { method: 'GET', url: `/api/deciship/tariffs/${A.tariffId}/versions` },
      { method: 'GET', url: '/api/deciship/tariffs/template.xlsx' },
      { method: 'POST', url: `/api/deciship/tariff-imports/${A.draftId}/recheck`, payload: {} },
      { method: 'GET', url: `/api/deciship/tariff-documents/${A.documentId}` },
      { method: 'GET', url: '/api/deciship/invoices' },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/lines` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/report.xlsx` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/report.pdf` },
      { method: 'GET', url: `/api/deciship/invoices/${A.invoiceId}/dispute` },
      { method: 'PATCH', url: `/api/deciship/invoice-lines/${A.lineId}`, payload: { decision: 'VERIFIED' } },
      { method: 'DELETE', url: `/api/deciship/invoices/${A.invoiceId}` },
      { method: 'POST', url: '/api/deciship/invoices/preview', multipart: [{ name: 'carrierId', value: A.carrierId }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from('a;b\n1;2') }] },
    ];
    const open: string[] = [];
    for (const r of reqs) {
      const res = await send(app, A.worker.auth, r);
      if (res.statusCode !== 403) open.push(`${r.method} ${r.url} → ${res.statusCode}`);
      else expect(res.json().error).toEqual({ code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz yok.' });
    }
    expect(open).toEqual([]);
    expect(await inCompany(A.companyId, () => prisma.member.findUniqueOrThrow({ where: { id: A.worker.userId } }))).toMatchObject({ role: 'MEASURE' });
  });

  it('WORKER fatura kaynak dosyasını (fiyatlı) indiremez, kendi fotoğrafını görebilir', async () => {
    const app = await getApp();
    const inv = await app.inject({ method: 'GET', url: `/api/deciship/files/${A.invoiceFileId}`, headers: A.worker.auth });
    expect(inv.statusCode).toBe(404);
    const photo = await app.inject({ method: 'GET', url: `/api/deciship/files/${A.photoId}`, headers: A.worker.auth });
    expect(photo.statusCode).toBe(200);
    // başka çalışanın fotoğrafı (ölçüm 404 olduğu gibi) görünmez
    const other = await createWorker(app, A.admin.auth);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${A.photoId}`, headers: other.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/measurements/${A.measurement.id}`, headers: other.auth })).statusCode).toBe(404);
  });

  it('WORKER yanıtlarında fiyat/tutar alanı yok (faturalı ölçüm dahil)', async () => {
    const app = await getApp();
    const w = A.worker.auth;
    const p = measurementPayload();
    const urls = [
      `/api/deciship/measurements/${A.measurement.id}`,
      '/api/deciship/measurements',
      `/api/deciship/measurements/check?tracking=${A.measurement.trackingNo}`,
      '/api/deciship/measurements/stats/today',
      '/api/deciship/me',
      '/api/deciship/settings',
      '/api/deciship/box-presets',
    ];
    for (const url of urls) {
      const r = await app.inject({ method: 'GET', url, headers: w });
      expect(r.statusCode, url).toBe(200);
      expect(findMoneyKeys(r.json()), url).toEqual([]);
      expect(r.body.includes('invoiceLines'), url).toBe(false);
      expect(r.body.includes('invoiceStatus'), url).toBe(false);
    }
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...w, ...p.headers }, payload: p.payload });
    expect(findMoneyKeys(created.json())).toEqual([]);
    const patched = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${A.measurement.id}`, headers: w, payload: { weightKg: 2.5 } });
    expect(patched.statusCode).toBe(200);
    expect(findMoneyKeys(patched.json())).toEqual([]);
    expect(patched.body.includes('invoiceLines')).toBe(false);
    // yöneticide aynı ölçümün fatura bilgisi var (kontrol: gerçekten bağlı)
    const adminView = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${patched.json().measurement.id}`, headers: A.admin.auth });
    expect(adminView.json().measurement.invoiceLines.length).toBeGreaterThan(0);
    const settings = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: w });
    expect(Object.keys(settings.json()).sort()).toEqual(['dataResetEnabled', 'desiDivisor', 'name', 'requiredBoxPhotos', 'scaleAiRead', 'warnEdgeCm', 'warnWeightKg']);
  });
});

describe('dosya yükleme sınırları', () => {
  let admin: Awaited<ReturnType<typeof registerCompany>>;
  let carrierId: string;
  let tariffId: string;

  beforeAll(async () => {
    const app = await getApp();
    admin = await registerCompany(app);
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'aras' } });
    carrierId = c.json().carrier.id;
    const t = await app.inject({ method: 'POST', url: '/api/deciship/tariffs', headers: admin.auth, payload: tariffPayload(carrierId) });
    tariffId = t.json().tariff.id;
  });

  function photoForm(file: { filename: string; contentType: string; data: Buffer }) {
    const data = measurementPayload({}, 0).data;
    return multipart([{ name: 'data', value: JSON.stringify({ ...data, photoKinds: ['PHOTO_BOX'] }) }, { name: 'photos', ...file }]);
  }

  it('fotoğraf: SVG/HTML reddedilir, boş dosya reddedilir, 8 MB üstü 413 — Türkçe hata', async () => {
    const app = await getApp();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    for (const f of [
      { filename: 'x.svg', contentType: 'image/svg+xml', data: svg },
      { filename: 'x.html', contentType: 'image/jpeg', data: Buffer.from('<html><script>alert(1)</script></html>') },
    ]) {
      const form = photoForm(f);
      const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...form.headers }, payload: form.payload });
      expect(r.statusCode, f.filename).toBe(400);
      expect(r.json().error).toMatchObject({ code: 'INVALID_FILE', message: expect.stringMatching(/JPEG/) });
    }
    const empty = photoForm({ filename: 'x.jpg', contentType: 'image/jpeg', data: Buffer.alloc(0) });
    const r0 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...empty.headers }, payload: empty.payload });
    expect(r0.statusCode).toBe(400);
    expect(r0.json().error.code).toBe('EMPTY_FILE');
    const big = photoForm({ filename: 'x.jpg', contentType: 'image/jpeg', data: Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024 + 10)]) });
    const r1 = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...big.headers }, payload: big.payload });
    expect(r1.statusCode).toBe(413);
    expect(r1.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', message: expect.stringMatching(/büyük/) });
    // geçerli PNG/WebP kabul edilir, uzantı içerikten değil türden gelir
    const png = photoForm({ filename: 'x.html', contentType: 'image/png', data: Buffer.from('89504e470d0a1a0a0000', 'hex') });
    const ok = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...png.headers }, payload: png.payload });
    expect(ok.statusCode, ok.body).toBe(201);
    const f = await inCompany(admin.auth, () => prisma.file.findFirstOrThrow({ where: { measurementId: ok.json().measurement.id } }));
    expect(f.path.endsWith('.png')).toBe(true);
  });

  it('fatura: boş, desteklenmeyen, çok büyük, birden fazla dosya → anlaşılır 4xx', async () => {
    const app = await getApp();
    const post = (parts: Part[]) => {
      const form = multipart(parts);
      return app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    };
    const cid = { name: 'carrierId', value: carrierId };
    const empty = await post([cid, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.alloc(0) }]);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('EMPTY_FILE');
    const exe = await post([cid, { name: 'file', filename: 'f.exe', contentType: 'application/octet-stream', data: Buffer.from('MZ\x90\x00') }]);
    expect(exe.statusCode).toBe(400);
    expect(exe.json().error.code).toBe('UNSUPPORTED_FORMAT');
    const big = await post([cid, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.alloc(30 * 1024 * 1024 + 10, 0x41) }]);
    expect(big.statusCode).toBe(413);
    expect(big.json().error.message).toMatch(/büyük/);
    const two = await post([
      cid,
      { name: 'file', filename: 'a.csv', contentType: 'text/csv', data: Buffer.from('a;b\n1;2') },
      { name: 'file', filename: 'b.csv', contentType: 'text/csv', data: Buffer.from('a;b\n1;2') },
    ]);
    expect(two.statusCode).toBe(413);
    expect(two.json().error).toMatchObject({ code: 'TOO_MANY_FILES', message: expect.stringMatching(/dosya/) });
    const notMultipart = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: admin.auth, payload: {} });
    expect(notMultipart.statusCode).toBe(415);
  });

  it('tarife: boş ya da okunamayan dosya → 400 Türkçe', async () => {
    const app = await getApp();
    const post = (data: Buffer, filename: string) => {
      const form = multipart([{ name: 'file', filename, contentType: 'application/octet-stream', data }]);
      return app.inject({ method: 'POST', url: `/api/deciship/tariffs/${tariffId}/import`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    };
    const empty = await post(Buffer.alloc(0), 't.xlsx');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('EMPTY_FILE');
    const junk = await post(crypto.randomBytes(512), 't.xlsx');
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error.message).toMatch(/okunamadı|açılamadı/);
    const pdf = await post(Buffer.from('%PDF-1.4 bozuk'), 't.pdf');
    expect(pdf.statusCode).toBe(400);
    const big = await post(Buffer.alloc(30 * 1024 * 1024 + 10, 0x41), 't.csv');
    expect(big.statusCode).toBe(413);
  });
});

describe('oturum', () => {
  function jwt(payload: Record<string, unknown>, secret: string, alg = 'HS256') {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg, typ: 'JWT' });
    const body = enc(payload);
    const sig = alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  }

  it('süresi dolmuş / bozuk / imzasız / başka anahtarlı jeton → 401 ortak hata', async () => {
    const app = await getApp();
    const authority = await getAuthority();
    const reg = await registerCompany(app);
    // Dil açıkça Türkçe: geçersiz jetonda oturum dili okunmaz, başlıksız istek İngilizce alır (karar 2026-11-12). Burada sınanan ortak hata.
    const me = (token: string) => app.inject({ method: 'GET', url: '/api/deciship/me', headers: { authorization: `Bearer ${token}`, 'accept-language': 'tr' } });
    const expired = await me((await reg.token({ expiresInSeconds: -60 })).accessToken);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toEqual({ code: 'TOKEN_EXPIRED', message: 'Oturumunuzun süresi doldu.' });
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: reg.personId, sid: 's', ep: 0, org: reg.companyId, mid: reg.userId, orgRole: 'OWNER', prod: { deciship: { role: 'ADMIN', status: 'ACTIVE', plan: 'x' } }, iss: 'sellerondata-account', aud: 'sellerondata', iat: now, exp: now + 600 };
    for (const token of [
      jwt(claims, 'yanlis-anahtar'),
      jwt(claims, 'x', 'none'),
      `${reg.accessToken.slice(0, -3)}abc`,
      'a.b.c',
      await authority.accessToken({ foreignKey: true, orgId: reg.companyId, membershipId: reg.userId }),
      await authority.accessToken({ audience: 'baska', orgId: reg.companyId, membershipId: reg.userId }),
      await authority.accessToken({ issuer: 'baska', orgId: reg.companyId, membershipId: reg.userId }),
    ]) {
      const r = await me(token);
      expect(r.statusCode, token.slice(0, 40)).toBe(401);
      expect(r.json().error).toEqual({ code: 'UNAUTHORIZED', message: 'Oturum geçersiz, lütfen tekrar giriş yapın.' });
    }
  });

  it('askıya alınan ya da çıkarılan üyenin jetonu çalışmaz; rol düşürülünce hemen etkili', async () => {
    const app = await getApp();
    const reg = await registerCompany(app);
    const worker = await createWorker(app, reg.auth);
    const me = (auth: { authorization: string }) => app.inject({ method: 'GET', url: '/api/deciship/me', headers: auth });
    expect((await me(worker.auth)).statusCode).toBe(200);
    const removed = await sendEvent(app, { eventId: crypto.randomUUID(), type: 'member.removed', orgId: reg.companyId, product: 'deciship', membershipId: worker.userId, epoch: 1 });
    expect(removed.json()).toEqual({ ok: true, outcome: 'processed' });
    const stale = await me(worker.auth);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('TOKEN_STALE');

    // ikinci yönetici Ölçüm'e düşürülünce eski yönetici jetonu yönetici uçlarını açmaz
    const second = await registerSecondAdmin(app, reg.auth);
    await sendEvent(app, {
      eventId: crypto.randomUUID(),
      type: 'member.upserted',
      orgId: reg.companyId,
      product: 'deciship',
      membershipId: second.userId,
      personId: second.personId,
      name: second.name,
      orgRole: 'MEMBER',
      role: 'MEASURE',
      active: true,
      epoch: 1,
    });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/dashboard', headers: second.auth })).statusCode).toBe(401);
    const demoted = await second.token({ role: 'MEASURE', epoch: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/dashboard', headers: demoted.auth })).statusCode).toBe(403);
  });
});

describe('girdi doğrulama: 500 yerine 400', () => {
  let admin: Awaited<ReturnType<typeof registerCompany>>;
  let carrierId: string;

  beforeAll(async () => {
    const app = await getApp();
    admin = await registerCompany(app);
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'aras' } });
    carrierId = c.json().carrier.id;
  });

  it('aşırı büyük / negatif / çok uzun değerler → 400 VALIDATION', async () => {
    const app = await getApp();
    const presets = await app.inject({ method: 'GET', url: '/api/deciship/box-presets', headers: admin.auth });
    const presetId = presets.json().items[0].id;
    const reqs: Req[] = [
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { rates: [{ zone: 'TR', weightUpto: 1, price: 1e15 }] }) },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { overflow: [{ zone: 'TR', perUnit: 1e15 }] }) },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { surcharges: [{ code: 'X', kind: 'FIXED', amount: -1e15 }] }) },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { rates: [{ zone: 'TR', weightUpto: 1, price: -5 }] }) },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { name: 'x'.repeat(201) }) },
      { method: 'POST', url: '/api/deciship/tariffs', payload: tariffPayload(carrierId, { weightSteps: [{ upto: null, step: 1e-9 }] }) },
      { method: 'POST', url: '/api/deciship/box-presets', payload: { name: 'X', lengthCm: 10, widthCm: 10, heightCm: 10, sortOrder: 1e12 } },
      { method: 'PATCH', url: `/api/deciship/box-presets/${presetId}`, payload: { sortOrder: -1e12 } },
      { method: 'POST', url: '/api/deciship/box-presets', payload: { name: 'X', lengthCm: -1, widthCm: 10, heightCm: 10 } },
      { method: 'PATCH', url: '/api/deciship/settings', payload: { name: 'x'.repeat(201) } },
      { method: 'PATCH', url: '/api/deciship/settings', payload: { desiDivisor: -5 } },
      { method: 'GET', url: '/api/deciship/measurements?pageSize=100000' },
      { method: 'GET', url: '/api/deciship/measurements?page=-1' },
      { method: 'GET', url: '/api/deciship/dashboard?month=2026-13x' },
      { method: 'POST', url: '/api/deciship/vision/reference/solve', payload: { imageSize: { w: 1, h: 1 }, marker: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, points: Array.from({ length: 5000 }, () => [1, 1]) } },
    ];
    const bad: string[] = [];
    for (const r of reqs) {
      const res = await send(app, admin.auth, r);
      if (res.statusCode !== 400 || res.json().error?.code !== 'VALIDATION') bad.push(`${r.method} ${r.url} ${JSON.stringify(r.payload ?? '').slice(0, 80)} → ${res.statusCode} ${res.body.slice(0, 100)}`);
    }
    expect(bad).toEqual([]);
  });

  it('ölçüm: negatif / sıfır / aşırı büyük ölçü, uzun not ve takip no → 400', async () => {
    const app = await getApp();
    for (const over of [
      { lengthCm: -1 },
      { widthCm: 0 },
      { heightCm: 1e9 },
      { weightKg: 1e9 },
      { weightKg: -2 },
      { lengthCm: 'abc' },
      { note: 'x'.repeat(1001) },
      { trackingRaw: 'x'.repeat(201) },
      { measuredAt: 'dün' },
    ]) {
      const p = measurementPayload(over);
      const r = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload });
      expect(r.statusCode, JSON.stringify(over)).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
    }
    const p = measurementPayload();
    const ok = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload });
    const id = ok.json().measurement.id;
    for (const payload of [{ lengthCm: 1e9 }, { weightKg: -1 }, { note: 'x'.repeat(1001) }]) {
      const r = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${id}`, headers: admin.auth, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('fatura: CSV\'de ya da PDF satırlarında aşırı büyük tutar/ölçü → 400 (500 değil)', async () => {
    const app = await getApp();
    const csv = ['Takip No;Desi;Tutar', `${uniq('5')};3;999999999999999999`].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    expect(preview.statusCode, preview.body).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: admin.auth,
      payload: {
        fileId: preview.json().fileId,
        carrierId,
        invoiceNo: uniq('F'),
        invoiceDate: '2026-10-15',
        mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
        acknowledgeIssues: true,
      },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALUE_OUT_OF_RANGE');
    expect(r.json().error.message).toMatch(/sayı|değer/i);

    // PDF satırları (kullanıcı düzeltmeli) — yapay zekâsız: dosya kaydını doğrudan oluştur
    const file = await inCompany(admin.auth, () =>
      prisma.file.create({
        data: { companyId: admin.companyId, kind: 'INVOICE_SOURCE', mime: 'application/pdf', size: 1, path: 'yok.pdf', sha256: 'x', createdById: admin.userId },
      }),
    );
    for (const line of [
      { trackingNo: '1', netAmount: 1e15 },
      { trackingNo: '1', netAmount: 10, dims: { l: 1e9, w: 1, h: 1 } },
      { trackingNo: '1', netAmount: 10, billedKg: 1e12 },
      { trackingNo: 'x'.repeat(500), netAmount: 10 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/deciship/invoices',
        headers: admin.auth,
        payload: { fileId: file.id, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-15', lines: [line] },
      });
      expect(res.statusCode, `${JSON.stringify(line).slice(0, 60)} ${res.body}`).toBe(400);
    }
  });

  it('geçersiz JSON gövdesi → 400', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: { ...admin.auth, 'content-type': 'application/json' }, payload: '{bozuk' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
  });
});
