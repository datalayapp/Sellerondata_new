/**
 * Bağımsız değerlendirmede bulunan kusurlar. Her `describe` bulgu numarasını taşır; test önce kırmızı görüldü.
 * Hub tutar/sayı eşitliği (B1) `hub/consistency.test.ts`, bağlantı kopması `dbConnection.test.ts` içindedir.
 */
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, missingProductionEnv } from '../src/env.ts';
import { poolConfig, prisma, withCompany } from '../src/db.ts';
import { buildApp, stripMoney } from '../src/app.ts';
import { isTimeZone } from '../src/lib/time.ts';
import { signFileToken } from '../src/lib/storage.ts';
import { csvRows } from '../src/services/hub/csv.ts';
import { datasetExport } from '../src/services/hub/datasets.ts';
import { hubSlotsInUse } from '../src/services/hub/limiter.ts';
import { translator } from '../src/services/hub/i18n.ts';
import { companyFixture } from './fixtures.ts';
import { getApp, getAuthority, issueIdentity, measurementPayload, multipart, registerCompany, uniq, writeTimeZone } from './helpers.ts';
import { testSuperDbUrl } from './testEnv.ts';

const API = '/api/deciship';
type Fixture = Awaited<ReturnType<typeof companyFixture>>;
type Auth = { authorization: string };

let app: FastifyInstance;
let sup: pg.Client;

beforeAll(async () => {
  app = await getApp();
  sup = new pg.Client({ connectionString: testSuperDbUrl(), options: '-c search_path=deciship' });
  await sup.connect();
});
afterAll(async () => {
  await sup.end();
});

async function invoiceFor(f: { auth: Auth; carrierId: string }, date: string, rows: string[], over: Record<string, unknown> = {}) {
  const csv = ['Takip No;Desi;Tutar', ...rows].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: `${uniq('f')}.csv`, contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...f.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: f.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId: f.carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: date,
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...over,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice as { id: string; sourceFileId?: string };
}

async function carrierSetup() {
  const admin = await registerCompany(app, uniq('Firma '));
  const r = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: 'FedEx' } });
  expect(r.statusCode, r.body).toBe(201);
  return { admin, auth: admin.auth, carrierId: r.json().carrier.id as string, companyId: admin.companyId };
}

const postMeasurement = (auth: Auth, over: Record<string, unknown> = {}) => {
  const p = measurementPayload(over);
  return app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...p.headers }, payload: p.payload });
};

const firstLine = async (auth: Auth, invoiceId: string) => {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items[0] as { id: string; diffTypes: string[]; diffAmount: number | null; status: string; measurementId: string | null };
};

const liveCount = async (companyId: string, trackingNo: string) => {
  const r = await sup.query(`SELECT count(*)::int AS n FROM "Measurement" WHERE "companyId"=$1 AND "trackingNo"=$2 AND "supersededById" IS NULL AND "deletedAt" IS NULL`, [companyId, trackingNo]);
  return r.rows[0].n as number;
};

describe('B2: fatura silinince aynı takip no taşıyan sonraki faturalar yeniden karşılaştırılır', () => {
  // KARARLAR "Birebir aynı satır" + "Mükerrer" (2026-11-10): aynı takip no ikinci faturada açık onay ister (confirmOverlap); tutar
  // farklıysa mükerrer "İncele" olup overchargeTotal'a girmediği için kesin mükerrer (aynı tutar, artık atlanmıyor) kullanılır.
  it('ilk fatura silinir: sonrakinin DUPLICATE farkı ve fazla ödemesi kalkar', async () => {
    const c = await carrierSetup();
    const tracking = uniq('DUP');
    const first = await invoiceFor(c, '2026-09-10', [`${tracking};5;50`]);
    const second = await invoiceFor(c, '2026-09-11', [`${tracking};5;50`], { confirmOverlap: true });
    const dash = async () => (await app.inject({ method: 'GET', url: `${API}/dashboard?month=2026-09`, headers: c.auth })).json();
    expect((await firstLine(c.auth, second.id)).diffTypes).toContain('DUPLICATE');
    expect((await dash()).overchargeTotal).toBeGreaterThan(0);

    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${first.id}`, headers: c.auth });
    expect(del.statusCode).toBe(204);

    expect((await firstLine(c.auth, second.id)).diffTypes).not.toContain('DUPLICATE');
    expect((await dash()).overchargeTotal).toBe(0);
    const inv = await app.inject({ method: 'GET', url: `${API}/invoices/${second.id}`, headers: c.auth });
    expect(inv.json().invoice.totals.overchargeTotal).toBe(0);
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): aynı takip no başka faturada varsa yükleme açık onay ister (confirmOverlap).
  it('ortadaki fatura silinir: daha eskisi durduğu için üçüncü mükerrer kalır; ilgisiz fatura yazılmaz', async () => {
    const c = await carrierSetup();
    const tracking = uniq('DUP');
    await invoiceFor(c, '2026-09-10', [`${tracking};5;50`]);
    const middle = await invoiceFor(c, '2026-09-11', [`${tracking};5;51`], { confirmOverlap: true });
    const third = await invoiceFor(c, '2026-09-12', [`${tracking};5;52`], { confirmOverlap: true });
    const other = await invoiceFor(c, '2026-09-13', [`${uniq('X')};5;53`]);
    const before = await sup.query(`SELECT "updatedAt" FROM "Invoice" WHERE id=$1`, [other.id]);

    await app.inject({ method: 'DELETE', url: `${API}/invoices/${middle.id}`, headers: c.auth });

    expect((await firstLine(c.auth, third.id)).diffTypes).toContain('DUPLICATE');
    const after = await sup.query(`SELECT "updatedAt" FROM "Invoice" WHERE id=$1`, [other.id]);
    expect(after.rows[0].updatedAt).toEqual(before.rows[0].updatedAt);
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): aynı takip no başka faturada varsa yükleme açık onay ister (confirmOverlap).
  it('son fatura silinir: önceki faturalar değişmez', async () => {
    const c = await carrierSetup();
    const tracking = uniq('DUP');
    const first = await invoiceFor(c, '2026-09-10', [`${tracking};5;50`]);
    const second = await invoiceFor(c, '2026-09-11', [`${tracking};5;51`], { confirmOverlap: true });
    await app.inject({ method: 'DELETE', url: `${API}/invoices/${second.id}`, headers: c.auth });
    expect((await firstLine(c.auth, first.id)).diffTypes).not.toContain('DUPLICATE');
    const list = await app.inject({ method: 'GET', url: `${API}/invoices`, headers: c.auth });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([first.id]);
  });
});

describe('B2: satırın takip numarası düzeltilince diğer faturalar da güncellenir', () => {
  // KARARLAR "Birebir aynı satır" (2026-11-10): aynı takip no başka faturada varsa yükleme açık onay ister (confirmOverlap).
  it('eski numaradaki mükerrer kalkar, yeni numaradaki mükerrer doğar', async () => {
    const c = await carrierSetup();
    const a = uniq('AAA');
    const b = uniq('BBB');
    const first = await invoiceFor(c, '2026-09-10', [`${a};5;50`]);
    const dupOfA = await invoiceFor(c, '2026-09-11', [`${a};5;51`], { confirmOverlap: true });
    const thirdB = await invoiceFor(c, '2026-09-12', [`${b};5;52`]);
    expect((await firstLine(c.auth, dupOfA.id)).diffTypes).toContain('DUPLICATE');
    expect((await firstLine(c.auth, thirdB.id)).diffTypes).not.toContain('DUPLICATE');

    const line = await firstLine(c.auth, first.id);
    const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${line.id}`, headers: c.auth, payload: { trackingNo: b } });
    expect(r.statusCode, r.body).toBe(200);

    expect((await firstLine(c.auth, dupOfA.id)).diffTypes).not.toContain('DUPLICATE');
    expect((await firstLine(c.auth, thirdB.id)).diffTypes).toContain('DUPLICATE');
  });
});

describe('O1: bir takip numarasının tek güncel sürümü olur', () => {
  it('paralel yeniden ölçüm: tek güncel sürüm, sürümler ardışık zincir', async () => {
    const c = await carrierSetup();
    const trackingRaw = uniq('PAR');
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => postMeasurement(c.auth, { trackingRaw, weightKg: i + 1 })));
    expect(res.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    const trackingNo = res[0]!.json().measurement.trackingNo as string;
    expect(await liveCount(c.companyId, trackingNo)).toBe(1);
    const all = await sup.query(`SELECT version FROM "Measurement" WHERE "companyId"=$1 AND "trackingNo"=$2 ORDER BY version`, [c.companyId, trackingNo]);
    expect(all.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const list = await app.inject({ method: 'GET', url: `${API}/measurements?q=${trackingNo}`, headers: c.auth });
    expect(list.json().items).toHaveLength(1);
  });

  it('paralel düzeltme: biri geçer, diğerlerine anlaşılır 409', async () => {
    const c = await carrierSetup();
    const created = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string };
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => app.inject({ method: 'PATCH', url: `${API}/measurements/${created.id}`, headers: c.auth, payload: { weightKg: i + 10 } })),
    );
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    const refused = res.find((r) => r.statusCode === 409)!.json().error;
    expect(refused.code).toBe('NOT_LATEST_VERSION');
    expect(refused.message.length).toBeGreaterThan(10);
    expect(await liveCount(c.companyId, created.trackingNo)).toBe(1);
  });

  it('düzeltme ve yeniden ölçüm yarışırsa da tek güncel sürüm kalır', async () => {
    const c = await carrierSetup();
    const created = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string; trackingRaw: string };
    await Promise.all([
      app.inject({ method: 'PATCH', url: `${API}/measurements/${created.id}`, headers: c.auth, payload: { weightKg: 11 } }),
      postMeasurement(c.auth, { trackingRaw: created.trackingRaw, weightKg: 12 }),
      app.inject({ method: 'PATCH', url: `${API}/measurements/${created.id}`, headers: c.auth, payload: { weightKg: 13 } }),
      postMeasurement(c.auth, { trackingRaw: created.trackingRaw, weightKg: 14 }),
    ]);
    expect(await liveCount(c.companyId, created.trackingNo)).toBe(1);
  });

  it('düzeltme takip numarasını başka güncel ölçümün numarasına çeviremez: 409, kayıt değişmez', async () => {
    const c = await carrierSetup();
    const a = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string };
    const b = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string; trackingRaw: string };
    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${a.id}`, headers: c.auth, payload: { trackingRaw: b.trackingRaw } });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('TRACKING_IN_USE');
    expect(await liveCount(c.companyId, a.trackingNo)).toBe(1);
    expect(await liveCount(c.companyId, b.trackingNo)).toBe(1);
  });

  it('veritabanı ikinci güncel sürümü reddeder; firmalar birbirini etkilemez; silinen ve eski sürüm engel değil', async () => {
    const c = await carrierSetup();
    const m = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string };
    const insert = (id: string, companyId: string, measuredById: string, extra = '') =>
      sup.query(
        `INSERT INTO "Measurement" (id, "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg", "dimMethod", "weightMethod", "measuredById", "measuredAt", "updatedAt"${extra ? ', "deletedAt"' : ''})
         VALUES ($1, $2, $1, $3, $3, 1, 1, 1, 1, 'MANUAL', 'MANUAL', $4, now(), now()${extra ? ', now()' : ''})`,
        [id, companyId, m.trackingNo, measuredById],
      );
    await expect(insert(crypto.randomUUID(), c.companyId, c.admin.userId)).rejects.toMatchObject({ code: '23505' });
    await insert(crypto.randomUUID(), c.companyId, c.admin.userId, 'deleted');
    const other = await registerCompany(app, uniq('Diğer '));
    await insert(crypto.randomUUID(), other.companyId, other.userId);
  });

  it('faturadaki satır en son sürüme bağlanır: paralel yeniden ölçümden sonra da', async () => {
    const c = await carrierSetup();
    const trackingRaw = uniq('EŞ').replace('Ş', 'S');
    const inv = await invoiceFor(c, '2026-09-10', [`${trackingRaw};5;50`]);
    await Promise.all(Array.from({ length: 6 }, (_, i) => postMeasurement(c.auth, { trackingRaw, weightKg: i + 1 })));
    const head = await sup.query(`SELECT id FROM "Measurement" WHERE "companyId"=$1 AND "trackingRaw"=$2 AND "supersededById" IS NULL AND "deletedAt" IS NULL`, [c.companyId, trackingRaw]);
    expect(head.rows).toHaveLength(1);
    const row = await sup.query(`SELECT "measurementId" FROM "InvoiceLine" WHERE "invoiceId"=$1`, [inv.id]);
    expect(row.rows[0].measurementId).toBe(head.rows[0].id);
  });

  it('silinmiş ölçüm, aynı numaraya yeni ölçüm varken geri yüklenemez: 409 NEWER_EXISTS', async () => {
    const c = await carrierSetup();
    const m = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingRaw: string };
    await app.inject({ method: 'DELETE', url: `${API}/measurements/${m.id}`, headers: c.auth });
    expect((await postMeasurement(c.auth, { trackingRaw: m.trackingRaw })).statusCode).toBe(201);
    const r = await app.inject({ method: 'POST', url: `${API}/measurements/${m.id}/restore`, headers: c.auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NEWER_EXISTS');
  });
});

describe('O2: ölçüm geçmişi kişiye göre süzülür', () => {
  it('başkasının sürümü ölçüm rolüne dönmez; hepsini görme izni görür', async () => {
    const f = await companyFixture(app);
    const secret = uniq('GIZLI-');
    const raw = uniq('HIS');
    const other = await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: 'MEASURE', name: 'Başka Kişi' });
    const first = await postMeasurement(f.worker.auth, { trackingRaw: raw, note: secret, weightKg: 77 });
    expect(first.statusCode, first.body).toBe(201);
    const mine = await postMeasurement(other.auth, { trackingRaw: raw, weightKg: 5 });
    expect(mine.statusCode, mine.body).toBe(201);
    const id = mine.json().measurement.id as string;

    const asWorker = await app.inject({ method: 'GET', url: `${API}/measurements/${id}`, headers: other.auth });
    expect(asWorker.statusCode).toBe(200);
    expect(asWorker.json().measurement.history).toEqual([]);
    expect(asWorker.body).not.toContain(secret);

    const asAdmin = await app.inject({ method: 'GET', url: `${API}/measurements/${id}`, headers: f.admin.auth });
    expect(asAdmin.json().measurement.history).toHaveLength(1);
    expect(asAdmin.json().measurement.history[0].note).toBe(secret);
  });

  it('kendi eski sürümünü görmeye devam eder', async () => {
    const f = await companyFixture(app);
    const a = (await postMeasurement(f.worker.auth, { note: 'ilk' })).json().measurement as { id: string };
    const b = await app.inject({ method: 'PATCH', url: `${API}/measurements/${a.id}`, headers: f.worker.auth, payload: { weightKg: 9 } });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().measurement.history.map((h: { note: string }) => h.note)).toEqual(['ilk']);
  });
});

describe('O3: clientId kişi ve firma kapsamında tekildir', () => {
  it('başka firmanın değeri çakışma sinyali vermez', async () => {
    const a = await carrierSetup();
    const b = await carrierSetup();
    const clientId = crypto.randomUUID();
    expect((await postMeasurement(a.auth, { clientId })).statusCode).toBe(201);
    const r = await postMeasurement(b.auth, { clientId });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('aynı firmada başkasının clientId değeri onun ölçümünü döndürmez', async () => {
    const f = await companyFixture(app);
    const other = await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: 'MEASURE' });
    const r = await postMeasurement(other.auth, { clientId: f.measurement.clientId });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().measurement.id).not.toBe(f.measurement.id);
  });

  it('aynı kişinin tekrar gönderimi tek kayıt: sıralı ve paralel', async () => {
    const c = await carrierSetup();
    const clientId = crypto.randomUUID();
    const trackingRaw = uniq('TEK');
    const res = await Promise.all(Array.from({ length: 10 }, () => postMeasurement(c.auth, { clientId, trackingRaw })));
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes.filter((x) => x === 201)).toHaveLength(1);
    expect(codes.filter((x) => x === 200)).toHaveLength(9);
    expect((await postMeasurement(c.auth, { clientId, trackingRaw })).statusCode).toBe(200);
    const n = await sup.query(`SELECT count(*)::int AS n FROM "Measurement" WHERE "companyId"=$1 AND "clientId"=$2`, [c.companyId, clientId]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('O4: fiyat izni olmayana açık alan seti', () => {
  const MEASUREMENT_KEYS = [
    'boxPresetId', 'clientId', 'createdAt', 'deleted', 'deletedAt', 'desi', 'dimConfidence', 'dimMethod', 'heightCm', 'id', 'lengthCm', 'measuredAt', 'measuredBy', 'note',
    'ocrWeightKg', 'photoCount', 'superseded', 'trackingNo', 'trackingRaw', 'version', 'volumetricKg5000', 'weightKg', 'weightMethod', 'widthCm',
  ].sort();
  const SETTINGS_KEYS = ['dataResetEnabled', 'desiDivisor', 'name', 'requiredBoxPhotos', 'scaleAiRead', 'warnEdgeCm', 'warnWeightKg'].sort();

  it('ölçüm rolü: ölçüm ve ayar yanıtı yalnız izin listesindeki alanları taşır', async () => {
    const f = await companyFixture(app);
    const list = await app.inject({ method: 'GET', url: `${API}/measurements`, headers: f.worker.auth });
    expect(Object.keys(list.json().items[0]).sort()).toEqual(MEASUREMENT_KEYS);
    const settings = await app.inject({ method: 'GET', url: `${API}/settings`, headers: f.worker.auth });
    expect(Object.keys(settings.json()).sort()).toEqual(SETTINGS_KEYS);
    const detail = await app.inject({ method: 'GET', url: `${API}/measurements/${f.measurement.id}`, headers: f.worker.auth });
    expect(Object.keys(detail.json().measurement).sort()).toEqual([...MEASUREMENT_KEYS, 'canEdit', 'history', 'photos'].sort());
  });

  // KARARLAR "Birebir aynı satır" (2026-11-10): fikstür faturası aynı takip numarasını taşıdığı için yükleme açık onay ister (confirmOverlap).
  it('para değerinin kendisi yanıta düşmez (anahtar adından bağımsız)', async () => {
    const f = await companyFixture(app);
    const amount = '98765.43';
    const tol = '4321.09';
    await invoiceFor({ auth: f.admin.auth, carrierId: f.carrierId }, '2026-10-16', [`${f.measurement.trackingNo};5;${amount}`], { confirmOverlap: true });
    const patched = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: f.admin.auth, payload: { amountTol: Number(tol) } });
    expect(patched.statusCode, patched.body).toBe(200);
    for (const url of ['/measurements', `/measurements/${f.measurement.id}`, '/measurements/stats/today', `/measurements/check?tracking=${f.measurement.trackingNo}`, '/settings', '/me', '/box-presets']) {
      const r = await app.inject({ method: 'GET', url: `${API}${url}`, headers: f.worker.auth });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
      expect(r.body, url).not.toContain(amount);
      expect(r.body, url).not.toContain(tol);
    }
  });

  it('son güvence: tutar taşıyan anahtarlar adı ne olursa olsun çıkar, sayfa toplamı kalır', () => {
    const out = stripMoney({
      total: 3,
      page: 1,
      items: [{ id: 'a', createdAt: 'x', generated: true, operator: 'y' }],
      totals: { billedTotal: 1 },
      overchargeTotal: 2,
      verifiedTotal: 3,
      estimatedOverchargeTotal: 4,
      pricing: { rateKg: 1 },
      cost: 5,
      charge: 6,
      fee: 7,
      rate: 8,
      fx: { rate: 40 },
      nested: { lineCost: 1, unitPrice: 2, netAmount: 3, fxRate: 4, surchargeFee: 5, keep: 1 },
    });
    expect(out).toEqual({ total: 3, page: 1, items: [{ id: 'a', createdAt: 'x', generated: true, operator: 'y' }], nested: { keep: 1 } });
  });
});

describe('O5: firmalar arası yabancı anahtar', () => {
  const FK_LIST = `
    SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
      (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols,
      (SELECT array_agg(a.attname::text) FROM unnest(c.confkey) k JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k) AS refs
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'deciship'`;

  it('firma tablosu dışındaki her yabancı anahtar firma sütununu da taşır', async () => {
    const { rows } = await sup.query(FK_LIST);
    const business = rows.filter((r) => !/Company"?$/.test(r.parent));
    expect(business.length).toBeGreaterThanOrEqual(26);
    const single = business.filter((r) => !(r.cols.includes('companyId') && r.refs.includes('companyId'))).map((r) => r.conname);
    expect(single).toEqual([]);
  });

  it('A kaydı B kaydına bağlanamaz: para, fatura ve ölçüm ilişkileri', async () => {
    const A = await companyFixture(app);
    const B = await companyFixture(app);
    const attempts: [string, unknown[]][] = [
      [`UPDATE "Measurement" SET "boxPresetId"=$1 WHERE id=$2`, [B.presetId, A.measurement.id]],
      [`UPDATE "InvoiceLine" SET "measurementId"=$1 WHERE id=$2`, [B.measurement.id, A.lineId]],
      [`UPDATE "InvoiceLine" SET "tariffId"=$1 WHERE id=$2`, [B.tariffId, A.lineId]],
      [`UPDATE "InvoiceLine" SET "invoiceId"=$1 WHERE id=$2`, [B.invoiceId, A.lineId]],
      [`UPDATE "InvoiceLine" SET "decidedById"=$1 WHERE id=$2`, [B.admin.userId, A.lineId]],
      [`UPDATE "Invoice" SET "tariffId"=$1 WHERE id=$2`, [B.tariffId, A.invoiceId]],
      [`UPDATE "Invoice" SET "carrierId"=$1 WHERE id=$2`, [B.carrierId, A.invoiceId]],
      [`UPDATE "Invoice" SET "sourceFileId"=$1 WHERE id=$2`, [B.invoiceFileId, A.invoiceId]],
      [`UPDATE "Tariff" SET "carrierId"=$1 WHERE id=$2`, [B.carrierId, A.tariffId]],
      [`UPDATE "File" SET "measurementId"=$1 WHERE id=$2`, [B.measurement.id, A.photoId]],
    ];
    for (const [sql, params] of attempts) await expect(sup.query(sql, params), sql).rejects.toMatchObject({ code: '23503' });
  });

  it('isteğe bağlı ilişkide üst kayıt silinince yalnız o sütun boşalır, firma sütunu kalır', async () => {
    const f = await companyFixture(app);
    await sup.query(`UPDATE "Measurement" SET "boxPresetId"=$1 WHERE id=$2`, [f.presetId, f.measurement.id]);
    await sup.query(`DELETE FROM "BoxPreset" WHERE id=$1`, [f.presetId]);
    const r = await sup.query(`SELECT "boxPresetId", "companyId" FROM "Measurement" WHERE id=$1`, [f.measurement.id]);
    expect(r.rows[0]).toEqual({ boxPresetId: null, companyId: f.companyId });
  });
});

describe('O7: dışa aktarma sessizce kesilmez', () => {
  const seed = (f: Fixture, n: number) =>
    sup.query(
      `INSERT INTO "Measurement" (id, "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg", "dimMethod", "weightMethod", "measuredById", "measuredAt", "updatedAt")
       SELECT gen_random_uuid()::text, $1, gen_random_uuid()::text, 'K' || g, 'K' || g, 10, 10, 10, 1, 'MANUAL', 'MANUAL', $2, now() - (g || ' seconds')::interval, now() FROM generate_series(1, $3::int) g`,
      [f.companyId, f.worker.userId, n],
    );
  const ctxOf = (f: Fixture) => ({ companyId: f.companyId, userId: f.admin.userId, locale: 'tr' as const, t: translator('tr'), can: () => true, now: new Date() });

  it('parti arası satır kaybolursa üreteç hata verir', async () => {
    const f = await companyFixture(app);
    await seed(f, 4500);
    await withCompany(f.companyId, async () => {
      const e = await datasetExport(ctxOf(f), 'measurements', {});
      let i = 0;
      const drain = async () => {
        for await (const rows of e.batches()) {
          expect(rows.length).toBeGreaterThan(0);
          if (i++ === 0) await sup.query(`UPDATE "Measurement" SET "deletedAt"=now() WHERE "companyId"=$1`, [f.companyId]);
        }
      };
      await expect(drain()).rejects.toThrow(/eksik|incomplete/i);
    });
  });

  it('dışa aktarma ortasında yeni satır gelirse kayma olmaz: her satır bir kez, ilk andaki sırayla', async () => {
    const f = await companyFixture(app);
    await seed(f, 4500);
    await withCompany(f.companyId, async () => {
      const e = await datasetExport(ctxOf(f), 'measurements', {});
      const ids: string[] = [];
      let i = 0;
      for await (const rows of e.batches()) {
        ids.push(...rows.map((r) => r.id));
        if (i++ === 0) {
          await sup.query(
            `INSERT INTO "Measurement" (id, "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg", "dimMethod", "weightMethod", "measuredById", "measuredAt", "updatedAt")
             SELECT gen_random_uuid()::text, $1, gen_random_uuid()::text, 'Y' || g, 'Y' || g, 10, 10, 10, 1, 'MANUAL', 'MANUAL', $2, now() + interval '1 hour', now() FROM generate_series(1, 300) g`,
            [f.companyId, f.worker.userId],
          );
        }
      }
      expect(ids).toHaveLength(e.total);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it('her veri seti: dışa aktarılan satırlar sayfa listesiyle aynı sayıda ve aynı sırada', async () => {
    const f = await companyFixture(app);
    await invoiceFor({ auth: f.admin.auth, carrierId: f.carrierId }, '2026-10-17', [`${uniq('Z')};5;50`]);
    const q = 'from=2020-01-01&to=2030-01-01';
    for (const id of ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log']) {
      const page = await app.inject({ method: 'GET', url: `${API}/platform/datasets/${id}?${q}&pageSize=200`, headers: f.admin.auth });
      expect(page.statusCode, `${id} ${page.body}`).toBe(200);
      const rows: { id: string }[] = await withCompany(f.companyId, async () => {
        const e = await datasetExport(ctxOf(f), id, Object.fromEntries(new URLSearchParams(q)));
        const out: { id: string }[] = [];
        for await (const b of e.batches()) out.push(...b);
        expect(out).toHaveLength(e.total);
        return out;
      });
      expect(rows.map((r) => r.id), id).toEqual(page.json().rows.map((r: { id: string }) => r.id));
    }
  });

  it('gerçek bağlantı: eksik kalan akış istemcide hata olur, tamamlandı sanılmaz', async () => {
    const authority = await getAuthority();
    const server = await buildApp({ identity: authority.authOptions });
    await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const f = await companyFixture(app);
      // Üst sınıra yakın: gövde okunmadıkça akış tamponlar dolunca durur, kalan partiler silmeden sonra okunur. Süreye bağlı değil.
      await seed(f, 90_000);
      const port = (server.server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}${API}/platform/datasets/measurements/export`, { headers: f.admin.auth });
      expect(res.status).toBe(200);
      await sup.query(`UPDATE "Measurement" SET "deletedAt"=now() WHERE "companyId"=$1`, [f.companyId]);
      await expect(res.text()).rejects.toThrow();
    } finally {
      await server.close();
    }
  }, 180_000);
});

describe('O8: normalleştirilince boş kalan takip no', () => {
  it.each(['---', '///', '- -', '. .'])('%s ile ölçüm 400; ilgisiz koliler zincirlenmez', async (trackingRaw) => {
    const c = await carrierSetup();
    const r = await postMeasurement(c.auth, { trackingRaw });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    expect(r.json().error.message.length).toBeGreaterThan(5);
  });

  it('düzeltmede de 400, kayıt değişmez', async () => {
    const c = await carrierSetup();
    const m = (await postMeasurement(c.auth)).json().measurement as { id: string; trackingNo: string };
    const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${m.id}`, headers: c.auth, payload: { trackingRaw: '---' } });
    expect(r.statusCode, r.body).toBe(400);
    expect(await liveCount(c.companyId, m.trackingNo)).toBe(1);
  });
});

describe('O9: havuz, zaman aşımı, firma başına eşzamanlılık', () => {
  it('havuz ayarları env ile gelir, varsayılanları tanımlı', () => {
    expect(poolConfig({})).toMatchObject({ max: 20, connectionTimeoutMillis: 10_000 });
    expect(poolConfig({ DB_POOL_MAX: '25', DB_CONNECT_TIMEOUT_MS: '2500', DB_STATEMENT_TIMEOUT_MS: '7000' })).toMatchObject({ max: 25, connectionTimeoutMillis: 2500 });
    expect(poolConfig({ DB_STATEMENT_TIMEOUT_MS: '7000' }).options).toContain('statement_timeout=7000');
    expect(poolConfig({ DB_POOL_MAX: 'abc' }).max).toBe(20);
  });

  it('uygulama bağlantısında statement_timeout ve UTC açık', async () => {
    const f = await registerCompany(app);
    const rows = await withCompany(f.companyId, () => prisma.$queryRaw<{ t: string; z: string }[]>`SELECT current_setting('statement_timeout') AS t, current_setting('TimeZone') AS z`);
    expect(rows[0]!.t).not.toBe('0');
    expect(['UTC', 'Etc/UTC']).toContain(rows[0]!.z);
  });

  it('bir firma hub uçlarını doldurursa 429 ve anlaşılır mesaj; diğer firma etkilenmez; yuvalar geri döner', async () => {
    const a = await companyFixture(app);
    const b = await companyFixture(app);
    const get = (auth: Auth, url = '/platform/overview?from=2026-10-01&to=2026-10-31') => app.inject({ method: 'GET', url: `${API}${url}`, headers: auth });
    const flood = await Promise.all([...Array.from({ length: env.hubConcurrencyPerOrg + 6 }, () => get(a.admin.auth)), get(b.admin.auth)]);
    const other = flood.pop()!;
    expect(other.statusCode, other.body).toBe(200);
    const codes = flood.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    const busy = flood.find((r) => r.statusCode === 429)!;
    expect(busy.json().error.code).toBe('TOO_MANY_REQUESTS');
    expect(busy.json().error.message.length).toBeGreaterThan(10);
    expect(busy.headers['retry-after']).toBeDefined();
    expect((await get(a.admin.auth)).statusCode).toBe(200);
    // hatalı istek de yuvasını bırakır
    for (let i = 0; i < env.hubConcurrencyPerOrg * 2; i++) expect((await get(a.admin.auth, '/platform/datasets/yok')).statusCode).toBe(404);
    expect((await get(a.admin.auth)).statusCode).toBe(200);
  });

  it('istemci akışı keserse yuva boşa çıkar', async () => {
    const authority = await getAuthority();
    const server = await buildApp({ identity: authority.authOptions });
    await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const f = await companyFixture(app);
      await sup.query(
        `INSERT INTO "Measurement" (id, "companyId", "clientId", "trackingRaw", "trackingNo", "lengthCm", "widthCm", "heightCm", "weightKg", "dimMethod", "weightMethod", "measuredById", "measuredAt", "updatedAt")
         SELECT gen_random_uuid()::text, $1, gen_random_uuid()::text, 'K' || g, 'K' || g, 10, 10, 10, 1, 'MANUAL', 'MANUAL', $2, now() - (g || ' seconds')::interval, now() FROM generate_series(1, 9000) g`,
        [f.companyId, f.worker.userId],
      );
      const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}${API}`;
      for (let i = 0; i < env.hubExportConcurrencyPerOrg * 3; i++) {
        const ctrl = new AbortController();
        const res = await fetch(`${base}/platform/datasets/measurements/export`, { headers: f.admin.auth, signal: ctrl.signal });
        expect(res.status).toBe(200);
        ctrl.abort();
        for (let w = 0; w < 500 && hubSlotsInUse(f.companyId) > 0; w++) await new Promise((r) => setTimeout(r, 10));
        expect(hubSlotsInUse(f.companyId)).toBe(0);
      }
      const after = await fetch(`${base}/platform/overview?from=2026-10-01&to=2026-10-31`, { headers: f.admin.auth });
      expect(after.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('O10: saat dilimi yalnız IANA adı', () => {
  it.each(['+03:00', '-05:00', 'GMT+3', 'EST', 'utc+3', 'Foo/Bar', '03:00', 'Europe/', '/Istanbul'])('%s reddedilir', async (timeZone) => {
    const c = await carrierSetup();
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: c.auth, payload: { timeZone } });
    expect(r.statusCode, r.body).toBe(400);
  });

  // Y131: saat diliminin tek yazarı Merkez (`org.updated`); geçerli IANA adı da bu uçtan yazılmaz, değer değişmez.
  it.each(['Europe/Istanbul', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Etc/GMT+3'])('%s de ayar ucundan yazılmaz', async (timeZone) => {
    const c = await carrierSetup();
    const before = (await app.inject({ method: 'GET', url: `${API}/settings`, headers: c.auth })).json().timeZone;
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: c.auth, payload: { timeZone } });
    expect(r.statusCode, r.body).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${API}/settings`, headers: c.auth })).json().timeZone).toBe(before);
  });

  it('kabul edilen her ad Intl ve Postgres için aynı saat farkı demek', async () => {
    const at = '2026-07-01T12:00:00Z';
    const names = Intl.supportedValuesOf('timeZone').filter(isTimeZone);
    // Intl'in bilip Postgres'in bilmediği ad (Africa/Asmera gibi eski yazım) uçta reddedilir, aşağıdaki testte.
    const { rows } = await sup.query(
      `SELECT z.name, to_char($1::timestamptz AT TIME ZONE z.name, 'YYYY-MM-DD"T"HH24:MI') AS local FROM pg_timezone_names z WHERE z.name = ANY($2::text[])`,
      [at, names],
    );
    expect(rows.length).toBeGreaterThan(300);
    const wrong = rows.filter((r) => {
      const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: r.name, dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)).replace(' ', 'T');
      return fmt !== r.local;
    });
    expect(wrong).toEqual([]);
  });
});

describe('O10: Postgres ortak ad', () => {
  it('Intl bilir, Postgres bilmez: reddedilir', async () => {
    const { rows } = await sup.query(`SELECT name FROM pg_timezone_names`);
    const known = new Set(rows.map((r) => r.name as string));
    const onlyIntl = Intl.supportedValuesOf('timeZone').find((n) => isTimeZone(n) && !known.has(n));
    if (!onlyIntl) return; // bu Postgres sürümünde fark yok
    const c = await carrierSetup();
    const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: c.auth, payload: { timeZone: onlyIntl } });
    expect(r.statusCode, `${onlyIntl} ${r.body}`).toBe(400);
  });
});

describe('küçük bulgular', () => {
  it('çok baytlı imza 500 değil 404', async () => {
    const f = await companyFixture(app);
    const good = signFileToken({ fileId: f.photoId, companyId: f.companyId, membershipId: f.worker.userId, epoch: 0 });
    const [payload, sig] = good.split('.');
    const broken = `${payload}.${'ş'.repeat(Math.ceil(sig!.length / 2))}`;
    const r = await app.inject({ method: 'GET', url: `${API}/files/${f.photoId}?t=${encodeURIComponent(broken)}` });
    expect(r.statusCode).toBe(404);
  });

  it.each([
    '/platform/datasets/invoices?page=1e30',
    '/platform/datasets/measurements?page=Infinity',
    '/platform/datasets/invoice-lines?page=99999999999999999',
    '/platform/datasets/invoices?pageSize=1e30',
    '/platform/activity?page=1e30',
    '/platform/activity?page=Infinity',
    '/measurements?from=2026-1-1',
    '/measurements?to=2026-13-45',
    '/platform/overview?from=0000-01-01&to=0000-01-02',
    '/platform/analytics?from=9999-12-30&to=9999-12-31',
  ])('uç girdi 400: %s', async (url) => {
    const c = await carrierSetup();
    const r = await app.inject({ method: 'GET', url: `${API}${url}`, headers: c.auth });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('oturumla alınan dosya önbelleğe yazılmaz, imzalı bağlantı kısa süre önbelleklenir', async () => {
    const f = await companyFixture(app);
    const session = await app.inject({ method: 'GET', url: `${API}/files/${f.photoId}`, headers: f.admin.auth });
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('private, no-store');
    const detail = await app.inject({ method: 'GET', url: `${API}/measurements/${f.measurement.id}`, headers: f.worker.auth });
    const signed = new URL(detail.json().measurement.photos[0].url);
    const viaToken = await app.inject({ method: 'GET', url: signed.pathname + signed.search });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.headers['cache-control']).toBe('private, max-age=600');
  });

  it('silinen fatura dosyası 404; silinen ölçüm dosyası yalnız yönetme izniyle', async () => {
    const f = await companyFixture(app);
    const url = (id: string) => `${API}/files/${id}`;
    const detail = await app.inject({ method: 'GET', url: `${API}/measurements/${f.measurement.id}`, headers: f.worker.auth });
    const signed = new URL(detail.json().measurement.photos[0].url);

    expect((await app.inject({ method: 'GET', url: url(f.invoiceFileId), headers: f.admin.auth })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `${API}/invoices/${f.invoiceId}`, headers: f.admin.auth });
    expect((await app.inject({ method: 'GET', url: url(f.invoiceFileId), headers: f.admin.auth })).statusCode).toBe(404);

    await app.inject({ method: 'DELETE', url: `${API}/measurements/${f.measurement.id}`, headers: f.worker.auth });
    expect((await app.inject({ method: 'GET', url: url(f.photoId), headers: f.worker.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: signed.pathname + signed.search })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: url(f.photoId), headers: f.admin.auth })).statusCode).toBe(200);
  });

  it('dosyası diskte olmayan belge 500 değil 404', async () => {
    const f = await companyFixture(app);
    const r = await app.inject({ method: 'POST', url: `${API}/tariff-documents/${f.documentId}/scan`, headers: f.admin.auth, payload: { mode: 'code' } });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('henüz faturaya bağlanmamış yüklenen dosya açılır', async () => {
    const c = await carrierSetup();
    const form = multipart([
      { name: 'carrierId', value: c.carrierId },
      { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from('Takip No;Desi;Tutar\nA1;1;1') },
    ]);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.auth, ...form.headers }, payload: form.payload });
    const r = await app.inject({ method: 'GET', url: `${API}/files/${preview.json().fileId}`, headers: c.auth });
    expect(r.statusCode).toBe(200);
  });

  it('CSV: satır sonu ve boşlukla gizlenen formül de etkisiz; tarih firma saatinde', () => {
    const col = { id: 'a', label: 'A', format: 'text' as const };
    const cell = (v: string) => csvRows([col], [{ id: '1', cells: { a: v } }], 'en', 'UTC');
    for (const v of ['\n=1+1', ' =1+1', '\t=1+1', '\r=1+1', '  @SUM(A1)', '\n\n+1', '＝1+1']) expect(cell(v), JSON.stringify(v)).toContain(`'`);
    expect(cell('normal')).toBe('normal\r\n');
    const when = { id: 'w', label: 'W', format: 'datetime' as const };
    const row = [{ id: '1', cells: { w: '2026-10-15T22:30:00.000Z' } }];
    expect(csvRows([when], row, 'en', 'UTC')).toBe('2026-10-15 22:30\r\n');
    expect(csvRows([when], row, 'en', 'Europe/Istanbul')).toBe('2026-10-16 01:30\r\n');
    expect(csvRows([when], row, 'en', 'America/New_York')).toBe('2026-10-15 18:30\r\n');
  });

  it('dönem varsayılanı firmanın günü: New York firması Türkiye gününe atlamaz', async () => {
    const c = await carrierSetup();
    await writeTimeZone(c.companyId, 'Pacific/Kiritimati');
    const east = await app.inject({ method: 'GET', url: `${API}/platform/overview`, headers: c.auth });
    expect(east.statusCode, east.body).toBe(200);
    const expected = (tz: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short' }).format(new Date());
    expect(east.json().to).toBe(expected('Pacific/Kiritimati'));
    await writeTimeZone(c.companyId, 'Pacific/Pago_Pago');
    const west = await app.inject({ method: 'GET', url: `${API}/platform/overview`, headers: c.auth });
    expect(west.json().to).toBe(expected('Pacific/Pago_Pago'));
  });

  it('aynı üyelik kimliği başka firmada: 500 değil 401', async () => {
    const a = await registerCompany(app);
    const clash = await issueIdentity({ orgName: 'Başka', role: 'ADMIN', userId: a.userId });
    const r = await app.inject({ method: 'GET', url: `${API}/me`, headers: clash.auth });
    expect(r.statusCode, r.body).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHORIZED');
  });

  it('üretimde veri sıfırlama açılamaz', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://a:guclu@h/d', ACCOUNT_JWKS_URL: 'http://x', ALLOWED_ORIGINS: 'http://x', FILE_TOKEN_SECRET: 's', APP_BASE_URL: 'https://app.example.test' };
    expect(missingProductionEnv(prod as NodeJS.ProcessEnv)).toEqual([]);
    expect(missingProductionEnv({ ...prod, ENABLE_DATA_RESET: 'true' } as NodeJS.ProcessEnv).join()).toContain('ENABLE_DATA_RESET');
    expect(missingProductionEnv({ NODE_ENV: 'development', ENABLE_DATA_RESET: 'true' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('paralel ayar yazımı birbirini ezmez: ayar ve kurulum ilerlemesi', async () => {
    const c = await carrierSetup();
    const writes = [
      { edgeTolCm: 7 },
      { weightTolKg: 8 },
      { amountTol: 9 },
      { desiDivisor: 4000 },
      { requiredBoxPhotos: 3 },
      { fxTolerancePct: 4 },
      { unknownSurchargesAsDiff: true },
      { disputeReminders: false },
    ];
    const res = await Promise.all([
      ...writes.map((payload) => app.inject({ method: 'PATCH', url: `${API}/settings`, headers: c.auth, payload })),
      app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: c.auth, payload: { done: 'sirket' } }),
      app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: c.auth, payload: { done: 'olcum' } }),
    ]);
    for (const r of res) expect(r.statusCode, r.body).toBe(200);
    const s = (await app.inject({ method: 'GET', url: `${API}/settings`, headers: c.auth })).json();
    for (const w of writes) expect(s).toMatchObject(w);
    const onboarding = (await app.inject({ method: 'GET', url: `${API}/settings/onboarding`, headers: c.auth })).json();
    const done = JSON.stringify(onboarding);
    expect(done).toContain('sirket');
    expect(done).toContain('olcum');
    const row = await sup.query(`SELECT settings->'onboarding'->'done' AS done FROM "Company" WHERE id=$1`, [c.companyId]);
    expect((row.rows[0].done as string[]).sort()).toEqual(['olcum', 'sirket']);
  });
});
