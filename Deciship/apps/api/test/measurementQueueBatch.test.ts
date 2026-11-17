/**
 * Mesaj 4: ölçüm karşılaştırma sırası (`services/measurementQueue.ts`, JOB_RUNNER=on).
 *  - 19-B2: aynı faturaya giden ölçümler tek hesapta birleşir (20 ölçüm → en çok 2 hesap; sonuç tek tek karşılaştırmayla aynı).
 *  - 07-B7: boş yuva firmalar arasında sırayla dağıtılır; taramada düşen işaret sayılır, geri çekilir, 5 denemeden sonra
 *    taramaya girmez ve günlükte uyarılır.
 * Tarife USD, fatura TRY: her fatura hesabı kur servisine tam bir kez uğrar (hesap sayısı kur çağrısından sayılır).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { RECOMPARE_MAX_ATTEMPTS, RECOMPARE_STALE_MS } from '../src/services/maintenance.ts';
import { drainMeasurementQueue, measurementQueueState, sweepPendingMeasurements } from '../src/services/measurementQueue.ts';
import { createWorker, getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-mqueue-'));
const fetcher: FxFetcher = async (url) => {
  if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
  return {
    status: 200,
    text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
  };
};

/** Kur çağrılarını sayar; `gated` iken her çağrı sıradaki kapıyı bekler (`next()` bir kapı açar). */
class GateFx extends FxService {
  calls = 0;
  down = false;
  gated = false;
  private arrivals: (() => void)[] = [];
  private opens: (() => void)[] = [];
  private arrivedCount = 0;
  constructor() {
    super({ fetcher, cacheDir: tmp, now: () => new Date('2026-11-04T12:00:00Z') });
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    this.calls++;
    if (this.gated) {
      this.arrivedCount++;
      for (const a of this.arrivals.splice(0)) a();
      await new Promise<void>((r) => this.opens.push(r));
    }
    if (this.down) throw new Error('kur servisi yanıt vermedi');
    return super.prefetch(...args);
  }
  /** en az `n` çağrı kapıda bekleyene dek */
  async arrived(n: number) {
    while (this.arrivedCount < n) await new Promise<void>((r) => this.arrivals.push(r));
  }
  /** kapıda bekleyen ilk çağrıyı bırakır */
  next() {
    this.opens.shift()?.();
  }
  reset() {
    this.gated = false;
    for (const o of this.opens.splice(0)) o();
    this.arrivedCount = 0;
    this.calls = 0;
    this.down = false;
  }
}
const fx = new GateFx();
beforeAll(() => setFxService(fx));
afterEach(() => {
  fx.reset();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  fx.reset();
  await drainMeasurementQueue(10_000);
  setFxService(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

async function usdFirmWithInvoice(app: FastifyInstance, trackings: string[]) {
  const admin = await registerCompany(app, uniq('Sıra '));
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
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;5000`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  const inv = await app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: admin.auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return { admin, worker, invoiceId: inv.json().invoice.id as string };
}

const measure = async (app: FastifyInstance, worker: Auth, tracking: string) => {
  const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker, ...p.headers }, payload: p.payload });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().measurement?.id as string;
};

const linesOf = async (app: FastifyInstance, auth: Auth, invoiceId: string) =>
  (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth })).json().items as {
    trackingNo: string;
    status: string;
    measurementId: string | null;
    ourChargeableKg: number | null;
  }[];

const pendingIds = (auth: Auth, ids: string[]) =>
  inCompany(auth, async () => (await prisma.measurement.findMany({ where: { id: { in: ids }, recomparePendingAt: { not: null } }, select: { id: true } })).map((m) => m.id));

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`zaman aşımı: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const idle = (ms = 15_000) =>
  until(
    () => {
      const s = measurementQueueState();
      return s.running === 0 && s.waiting === 0 && s.retrying === 0;
    },
    ms,
    'ölçüm sırası',
  );

describe('19-B2: aynı faturaya giden ölçümler tek hesapta', () => {
  it('20 ölçüm, aynı fatura: fatura en çok 2 kez hesaplanır; her satır kendi ölçümüyle, bütün işaretler boş', async () => {
    const app = await getApp();
    const trackings = Array.from({ length: 20 }, trackingNo);
    const { admin, worker, invoiceId } = await usdFirmWithInvoice(app, trackings);
    vi.stubEnv('JOB_RUNNER', 'on');
    fx.calls = 0;
    fx.gated = true;
    const ids: string[] = [];
    ids.push(await measure(app, worker.auth, trackings[0]!));
    await fx.arrived(1); // ilk hesap sürüyor (kur bekliyor)
    for (const t of trackings.slice(1)) ids.push(await measure(app, worker.auth, t));
    fx.gated = false;
    fx.next();
    await idle();
    expect(fx.calls).toBeLessThanOrEqual(2);
    expect(await pendingIds(admin.auth, ids)).toEqual([]);
    const lines = await linesOf(app, admin.auth, invoiceId);
    expect(lines).toHaveLength(20);
    for (const [i, t] of trackings.entries()) {
      // 5 desi faturalandı, 30×20×15 / 3000 = 3 desi ölçüldü
      expect(lines.find((l) => l.trackingNo === t), t).toMatchObject({ measurementId: ids[i], status: 'DIFF', ourChargeableKg: 3 });
    }
  });
});

describe('07-B7: sıra firmalar arasında adil, düşen işaret sonsuza dek denenmez', () => {
  it('tek yuvada: A firmasının hesabı sürerken gelen B ölçümü, A\'nın bekleyen ölçümlerinden önce alınır', async () => {
    const app = await getApp();
    const tA = Array.from({ length: 3 }, trackingNo);
    const tB = trackingNo();
    const A = await usdFirmWithInvoice(app, tA);
    const B = await usdFirmWithInvoice(app, [tB]);
    vi.stubEnv('JOB_RUNNER', 'on');
    vi.stubEnv('MEASURE_RECOMPARE_SLOTS', '1');
    fx.gated = true;
    const a1 = await measure(app, A.worker.auth, tA[0]!);
    await fx.arrived(1); // A'nın ilk hesabı sürüyor
    const aRest = [await measure(app, A.worker.auth, tA[1]!), await measure(app, A.worker.auth, tA[2]!)];
    const b1 = await measure(app, B.worker.auth, tB);
    fx.next(); // A'nın ilk hesabı biter; sıradaki hesap kapıda bekler
    await fx.arrived(2);
    expect(await pendingIds(A.admin.auth, [a1])).toEqual([]);
    // ikinci hesap B'nin: A'nın bekleyenleri hâlâ işaretli, B henüz bitmedi
    expect((await pendingIds(A.admin.auth, aRest)).sort()).toEqual([...aRest].sort());
    fx.next();
    await until(async () => (await pendingIds(B.admin.auth, [b1])).length === 0, 8000, 'B');
    expect((await pendingIds(A.admin.auth, aRest)).sort()).toEqual([...aRest].sort());
    fx.gated = false;
    fx.next();
    await idle();
    expect(await pendingIds(A.admin.auth, aRest)).toEqual([]);
  });

  it('taramada düşen işaret sayılır ve geri çekilir; 5. düşüşten sonra taramaya girmez, günlükte uyarılır', async () => {
    const app = await getApp();
    const tracking = trackingNo();
    const { admin, worker } = await usdFirmWithInvoice(app, [tracking]);
    // satır içi kipte kur düşük: ölçüm yazılır, karşılaştırma düşer, işaret kalır
    fx.down = true;
    const p = measurementPayload({ trackingRaw: tracking, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
    const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...worker.auth, ...p.headers }, payload: p.payload });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    const id = (await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { clientId: p.data.clientId } }))).id;
    const state = () => inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id }, select: { recomparePendingAt: true, recompareAttempts: true } }));
    const age = (ms: number) => inCompany(admin.auth, () => prisma.measurement.update({ where: { id }, data: { recomparePendingAt: new Date(Date.now() - ms) } }));
    const warns: string[] = [];
    const log = { warn: (_o: unknown, msg: string) => void warns.push(msg) };

    vi.stubEnv('JOB_RUNNER', 'on');
    await age(RECOMPARE_STALE_MS + 60_000);
    expect(await sweepPendingMeasurements(Date.now(), log)).toBeGreaterThanOrEqual(1);
    await idle();
    expect((await state()).recompareAttempts).toBe(1);
    // geri çekilme: bir kez düşmüş işaret 3 dk'lıkken alınmaz, 9 dk'lıkken alınır (2 dk × 4)
    await age(3 * 60_000);
    await sweepPendingMeasurements(Date.now(), log);
    expect(measurementQueueState().waiting + measurementQueueState().running).toBe(0);
    await age(9 * 60_000);
    expect(await sweepPendingMeasurements(Date.now(), log)).toBeGreaterThanOrEqual(1);
    await idle();
    expect((await state()).recompareAttempts).toBe(2);

    // son hak: 4 kez düşmüş, çok eski işaret alınır, düşer, uyarı yazılır; sonra hiç alınmaz
    await inCompany(admin.auth, () => prisma.measurement.update({ where: { id }, data: { recompareAttempts: RECOMPARE_MAX_ATTEMPTS - 1 } }));
    await age(24 * 60 * 60_000);
    expect(await sweepPendingMeasurements(Date.now(), log)).toBeGreaterThanOrEqual(1);
    await idle();
    expect((await state()).recompareAttempts).toBe(RECOMPARE_MAX_ATTEMPTS);
    expect(warns).toContain('recompare gave up after max attempts; pending flag kept, no longer swept');
    await sweepPendingMeasurements(Date.now(), log);
    expect(measurementQueueState().waiting + measurementQueueState().running).toBe(0);
    expect((await state()).recomparePendingAt).not.toBeNull();

    // yeni değişiklik (yeniden ölçüm) sayacı sıfırlar ve karşılaştırma tamamlanır
    fx.down = false;
    vi.stubEnv('JOB_RUNNER', 'inline');
    const again = await app.inject({ method: 'PATCH', url: `${API}/measurements/${id}`, headers: admin.auth, payload: { lengthCm: 31 } });
    expect(again.statusCode, again.body).toBe(200);
    const next = again.json().measurement.id as string;
    const fresh = await inCompany(admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { id: next }, select: { recomparePendingAt: true, recompareAttempts: true } }));
    expect(fresh).toEqual({ recomparePendingAt: null, recompareAttempts: 0 });
  });
});
