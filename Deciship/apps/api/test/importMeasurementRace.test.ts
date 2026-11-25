/**
 * 02-B1 (Mesaj 4): fatura yüklenirken kaydedilen ya da düzeltilen ölçüm o faturaya yansımalı.
 *
 * İçe aktarma ölçümleri okur, kuru bekler, karşılaştırır, sonra faturayı yazar. İki pencere sınanır:
 *  1. Karşılaştırma ile yazım işlemi arası (kur beklemesi): kanca kur servisinde. Ölçüm bu arada kaydedilir; ölçümün kendi
 *     karşılaştırması henüz yazılmamış faturayı göremez. Fatura yazılırken ölçüm kümesi yeniden okunur, değiştiyse fatura
 *     yeniden karşılaştırılır ve ölçümün işareti tazelenir.
 *  2. Yazım işleminin içi (satırlar yazılırken): kanca satır yazımında. Ölçümün karşılaştırması içe aktarmanın kilidini
 *     paylaşımlı alır, işlem bitene dek bekler, sonra faturayı görür.
 * Tarife USD, fatura TRY: karşılaştırma kur ister (kanca 1 için).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { importLockName, lockImportsExclusive } from '../src/services/compare.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { drainMeasurementQueue, measurementQueueState } from '../src/services/measurementQueue.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { patchInvoice } from './recalcHelpers.ts';

const gate = vi.hoisted(() => ({ lines: null as Promise<void> | null, linesReached: null as (() => void) | null }));
vi.mock('../src/services/lineWrite.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/lineWrite.ts')>();
  return {
    ...orig,
    insertInvoiceLines: async (...args: Parameters<typeof orig.insertInvoiceLines>) => {
      if (gate.lines) {
        gate.linesReached?.();
        await gate.lines;
      }
      return orig.insertInvoiceLines(...args);
    },
  };
});

const API = '/api/deciship';
type Auth = { authorization: string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-import-race-'));
const fetcher: FxFetcher = async (url) => {
  if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
  return {
    status: 200,
    text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
  };
};

/** `hold` doluyken kur isteği bekler; `reached` ilk bekleyişte çağrılır. */
class HoldFx extends FxService {
  hold: Promise<void> | null = null;
  reached: (() => void) | null = null;
  constructor() {
    super({ fetcher, cacheDir: tmp, now: () => new Date('2026-11-04T12:00:00Z') });
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    if (this.hold) {
      const h = this.hold;
      this.reached?.();
      await h;
    }
    return super.prefetch(...args);
  }
}
const fx = new HoldFx();
beforeAll(() => setFxService(fx));
afterAll(() => {
  setFxService(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

async function usdFirm(app: FastifyInstance) {
  const admin = await registerCompany(app, uniq('Yükleme yarışı '));
  const worker = await createWorker(app, admin.auth);
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx') } });
  const carrierId = c.json().carrier.id as string;
  const tariff = await app.inject({
    method: 'POST',
    url: `${API}/tariffs`,
    headers: admin.auth,
    payload: {
      carrierId,
      name: 'USD',
      currency: 'USD',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      active: true,
      isDefault: true,
      zones: [{ country: '*', zone: 'A' }],
      rates: [{ zone: 'A', weightUpto: 30, price: 100 }],
      overflow: [],
      surcharges: [],
    },
  });
  expect(tariff.statusCode, tariff.body).toBe(201);
  return { admin, worker, carrierId };
}

async function previewFile(app: FastifyInstance, auth: Auth, carrierId: string, trackings: string[]) {
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;5000`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  return preview.json().fileId as string;
}

const importInvoice = (app: FastifyInstance, auth: Auth, carrierId: string, fileId: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    payload: {
      fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...extra,
    },
  });

async function lineOf(app: FastifyInstance, auth: Auth, invoiceId: string, tracking: string) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  const line = (r.json().items as { trackingNo: string; status: string; measurementId: string | null; ourChargeableKg: number | null }[]).find((l) => l.trackingNo === tracking);
  expect(line, tracking).toBeDefined();
  return line!;
}

const measure = async (app: FastifyInstance, worker: Auth, tracking: string, dims = { lengthCm: 30, widthCm: 20, heightCm: 15 }) => {
  const p = measurementPayload({ trackingRaw: tracking, ...dims, weightKg: 2 });
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement.id as string;
};

/** Bekleyen (verilmemiş) danışma kilidi var mı: ölçüm karşılaştırması içe aktarmanın kilidini bekliyor. */
async function advisoryWaiters(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
  return r?.n ?? 0;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`zaman aşımı: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('02-B1: fatura yüklenirken ölçüm değişir', () => {
  it('karşılaştırma ile yazım arasında kaydedilen ölçüm satıra yansır; ölçümün işareti boşalır', async () => {
    const app = await getApp();
    const { admin, worker, carrierId } = await usdFirm(app);
    const tracking = trackingNo();
    const fileId = await previewFile(app, admin.auth, carrierId, [tracking]);

    let release!: () => void;
    const reached = new Promise<void>((r) => (fx.reached = r));
    fx.hold = new Promise<void>((r) => (release = r));
    let pendingImport: ReturnType<typeof importInvoice> | undefined;
    let id = '';
    try {
      pendingImport = importInvoice(app, admin.auth, carrierId, fileId);
      await reached; // ölçümler okundu, kur bekleniyor
      fx.hold = null;
      id = await measure(app, worker.auth, tracking);
    } finally {
      fx.hold = null;
      fx.reached = null;
      release();
    }
    const inv = await pendingImport!;
    expect(inv.statusCode, inv.body).toBe(201);
    const invoiceId = inv.json().invoice.id as string;
    // 5 desi faturalandı, 30×20×15 / 3000 = 3 desi ölçüldü
    expect(await lineOf(app, admin.auth, invoiceId, tracking)).toMatchObject({ measurementId: id, status: 'DIFF', ourChargeableKg: 3 });
    const pending = await inCompany(admin.auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);
    expect(pending).toBeNull();
  });

  it('karşılaştırma ile yazım arasında düzeltilen ölçüm: satır düzeltilmiş ölçüyle hesaplanır', async () => {
    const app = await getApp();
    const { admin, worker, carrierId } = await usdFirm(app);
    const tracking = trackingNo();
    const first = await measure(app, worker.auth, tracking);
    const fileId = await previewFile(app, admin.auth, carrierId, [tracking]);

    let release!: () => void;
    const reached = new Promise<void>((r) => (fx.reached = r));
    fx.hold = new Promise<void>((r) => (release = r));
    let pendingImport: ReturnType<typeof importInvoice> | undefined;
    let corrected = '';
    try {
      pendingImport = importInvoice(app, admin.auth, carrierId, fileId);
      await reached;
      fx.hold = null;
      // 40×30×25 / 3000 = 10 desi
      const r = await app.inject({ method: 'PATCH', url: `${API}/measurements/${first}`, headers: admin.auth, payload: { lengthCm: 40, widthCm: 30, heightCm: 25 } });
      expect(r.statusCode, r.body).toBe(200);
      corrected = r.json().measurement.id as string;
    } finally {
      fx.hold = null;
      fx.reached = null;
      release();
    }
    const inv = await pendingImport!;
    expect(inv.statusCode, inv.body).toBe(201);
    expect(await lineOf(app, admin.auth, inv.json().invoice.id, tracking)).toMatchObject({ measurementId: corrected, ourChargeableKg: 10 });
  });

  it('yazım işlemi sürerken kaydedilen ölçüm: karşılaştırması işlemin bitmesini bekler ve yeni faturayı görür', async () => {
    const app = await getApp();
    const { admin, worker, carrierId } = await usdFirm(app);
    const tracking = trackingNo();
    const fileId = await previewFile(app, admin.auth, carrierId, [tracking]);

    let release!: () => void;
    const reached = new Promise<void>((r) => (gate.linesReached = r));
    gate.lines = new Promise<void>((r) => (release = r));
    let pendingImport: ReturnType<typeof importInvoice> | undefined;
    let pendingMeasure: Promise<string> | undefined;
    try {
      pendingImport = importInvoice(app, admin.auth, carrierId, fileId);
      await reached; // yazım işlemi açık, satırlar yazılmak üzere
      gate.lines = null;
      let measured = false;
      pendingMeasure = measure(app, worker.auth, tracking).then((x) => ((measured = true), x));
      // ölçüm ya bitti (kilit yoksa) ya da içe aktarmanın kilidini bekliyor
      await until(async () => measured || (await advisoryWaiters()) > 0, 10_000, 'ölçüm karşılaştırması');
    } finally {
      gate.lines = null;
      gate.linesReached = null;
      release();
    }
    const inv = await pendingImport!;
    expect(inv.statusCode, inv.body).toBe(201);
    const id = await pendingMeasure!;
    expect(await lineOf(app, admin.auth, inv.json().invoice.id, tracking)).toMatchObject({ measurementId: id, status: 'DIFF' });
  });
});

type DupLine = { trackingNo: string; diffTypes: string[]; confidence?: string | null; pricing?: { confidence?: string } | null };
const confidenceOf = (l: DupLine) => l.pricing?.confidence ?? l.confidence ?? null;

/** Bağımsız inceleme (Mesaj 4): kilitten önce okunan girdinin kilit altında yeniden okunması satır sayısıyla sınırlı değil. */
describe('içe aktarma kilidinden önce değişen girdi', () => {
  it('önceki faturanın taşıyıcısı içe aktarma sürerken düzeltilir: yeni fatura eski başlıkla kesin "Mükerrer" kalmaz', async () => {
    const app = await getApp();
    const { admin, carrierId } = await usdFirm(app);
    const t = [trackingNo(), trackingNo()];
    const f1 = await importInvoice(app, admin.auth, carrierId, await previewFile(app, admin.auth, carrierId, t));
    expect(f1.statusCode, f1.body).toBe(201);
    const ups = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'ups', name: uniq('UPS') } });
    expect(ups.statusCode, ups.body).toBe(201);
    const f2File = await previewFile(app, admin.auth, carrierId, t);

    let release!: () => void;
    const reached = new Promise<void>((r) => (fx.reached = r));
    fx.hold = new Promise<void>((r) => (release = r));
    let pendingImport: ReturnType<typeof importInvoice> | undefined;
    try {
      pendingImport = importInvoice(app, admin.auth, carrierId, f2File, { confirmOverlap: true });
      await reached; // önceki satırlar (F1: FedEx) okundu, kur bekleniyor
      fx.hold = null;
      // satır sayısı değişmez; F1'in mükerrer işareti henüz yazılmamış F2'yi göremez
      const moved = await patchInvoice(app, admin.auth, f1.json().invoice.id, { carrierId: ups.json().carrier.id });
      expect(moved.statusCode, moved.body).toBe(200);
    } finally {
      fx.hold = null;
      fx.reached = null;
      release();
    }
    const f2 = await pendingImport!;
    expect(f2.statusCode, f2.body).toBe(201);
    const f2Id = f2.json().invoice.id as string;
    const rows = async () => (await app.inject({ method: 'GET', url: `${API}/invoices/${f2Id}/lines?pageSize=100`, headers: admin.auth })).json().items as DupLine[];
    const imported = await rows();
    expect(imported).toHaveLength(2);
    // önceki görünüm başka taşıyıcıda: "İncele" (kesin değil), yeniden karşılaştırmanın vereceği sonuçla aynı
    expect(imported.every((l) => l.diffTypes.includes('DUPLICATE') && confidenceOf(l) === 'LOW')).toBe(true);
    const totals = f2.json().invoice.totals;
    expect((await app.inject({ method: 'POST', url: `${API}/invoices/${f2Id}/recompare`, headers: admin.auth })).statusCode).toBe(200);
    const fresh = (await app.inject({ method: 'GET', url: `${API}/invoices/${f2Id}`, headers: admin.auth })).json().invoice.totals;
    expect(totals).toEqual(fresh);
  });

  it('örnek fatura (kurulum) yüklenirken kaydedilen ölçüm satıra yansır', async () => {
    const app = await getApp();
    const { admin, worker, carrierId } = await usdFirm(app);
    const tracking = trackingNo();
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'ornek.csv', contentType: 'text/csv', data: Buffer.from(['Takip No;Desi;Tutar', `${tracking};5;5000`].join('\n')) },
    ]);

    let release!: () => void;
    const reached = new Promise<void>((r) => (fx.reached = r));
    fx.hold = new Promise<void>((r) => (release = r));
    let pendingSample: Promise<{ statusCode: number; body: string; json(): { invoice: { id: string } } }> | undefined;
    let id = '';
    try {
      pendingSample = app.inject({ method: 'POST', url: `${API}/invoices/samples`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
      await reached; // ölçümler okundu, kur bekleniyor
      fx.hold = null;
      id = await measure(app, worker.auth, tracking);
    } finally {
      fx.hold = null;
      fx.reached = null;
      release();
    }
    const r = await pendingSample!;
    expect(r.statusCode, r.body).toBe(201);
    const invoiceId = r.json().invoice.id;
    const line = await inCompany(admin.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId }, select: { measurementId: true } }));
    expect(line.measurementId).toBe(id);
    const pending = await inCompany(admin.auth, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);
    expect(pending).toBeNull();
  });
});

describe('ölçüm karşılaştırması içe aktarma kilidini beklerken (JOB_RUNNER=on)', () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    await drainMeasurementQueue(10_000);
  });

  it('ölçüm kaydı beklemez; kilit beklemesi düşerse (sorgu süresi) işaret kalır ve yeniden deneme tamamlar', async () => {
    const app = await getApp();
    const { admin, worker, carrierId } = await usdFirm(app);
    const tracking = trackingNo();
    const inv = await importInvoice(app, admin.auth, carrierId, await previewFile(app, admin.auth, carrierId, [tracking]));
    expect(inv.statusCode, inv.body).toBe(201);
    const companyId = admin.companyId as string;
    vi.stubEnv('JOB_RUNNER', 'on');

    // süren büyük bir içe aktarmanın yazım işlemi: özel kilit tutulur
    let unlock!: () => void;
    const held = new Promise<void>((r) => (unlock = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = inCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        await lockImportsExclusive(tx, companyId);
        locked();
        await held;
      }, { timeout: 60_000 }),
    );
    let id = '';
    try {
      await lockTaken;
      const started = Date.now();
      id = await measure(app, worker.auth, tracking);
      expect(Date.now() - started).toBeLessThan(5_000);
      // karşılaştırma bu firmanın kilidini bekliyor; bekleyen sorgu iptal edilir (statement_timeout ile aynı hata yolu)
      const waiters = () => prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${importLockName(companyId)}, 0)`;
      await until(async () => (await waiters()).length > 0, 10_000, 'kilit bekleyen karşılaştırma');
      for (const w of await waiters()) await prisma.$queryRaw`SELECT pg_cancel_backend(${w.pid}::int)`;
      await until(() => measurementQueueState().retrying > 0 || measurementQueueState().running > 0, 5_000, 'yeniden deneme');
      const flag = await inCompany(companyId, async () => (await prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } })).recomparePendingAt);
      expect(flag).not.toBeNull();
    } finally {
      unlock();
      await holder;
    }
    await until(
      async () => (await inCompany(companyId, () => prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true } }))).recomparePendingAt === null,
      15_000,
      'işaret boşalır',
    );
    expect(await lineOf(app, admin.auth, inv.json().invoice.id, tracking)).toMatchObject({ measurementId: id, status: 'DIFF' });
  });
});
