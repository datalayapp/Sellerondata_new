/**
 * 07-B1 (Mesaj 4): fatura silinince ya da başlığı düzeltilince sonraki faturaların "Mükerrer" yeniden hesabı kalıcı işaretle
 * (`InvoiceRecheck`) güvencede. Hesap düşerse silme yine başarılı döner, işaret kalır; bakım ve sık tarama tamamlar.
 *
 * Hata, kur servisinin geçici olarak düşmesiyle kurulur (tarife USD, fatura TRY: yeniden hesap kur ister; içe aktarma kuru
 * önceden önbelleğe almıştır ama `down` iken servis hiç yanıt vermez).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, withMaintenanceScope } from '../src/db.ts';
import { importLockName, lockImportsExclusive } from '../src/services/compare.ts';
import { FxService, setFxService, tcmbUrl, type FxFetcher } from '../src/services/fx.ts';
import { RECOMPARE_STALE_MS, runMaintenance } from '../src/services/maintenance.ts';
import { drainMeasurementQueue, measurementQueueState, sweepPendingMeasurements } from '../src/services/measurementQueue.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
type Auth = { authorization: string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deciship-recheck-'));
const fetcher: FxFetcher = async (url) => {
  if (url !== tcmbUrl('2026-10-15')) return { status: 404, text: '' };
  return {
    status: 200,
    text: '<Tarih_Date Tarih="15.10.2026"><Currency CurrencyCode="USD"><Unit>1</Unit><ForexBuying>40</ForexBuying><ForexSelling>40.1</ForexSelling></Currency></Tarih_Date>',
  };
};
class FlakyFx extends FxService {
  down = false;
  constructor() {
    super({ fetcher, cacheDir: tmp, now: () => new Date('2026-11-04T12:00:00Z') });
  }
  override async prefetch(...args: Parameters<FxService['prefetch']>) {
    if (this.down) throw new Error('kur servisi yanıt vermedi');
    return super.prefetch(...args);
  }
}
const fx = new FlakyFx();
beforeAll(() => setFxService(fx));
afterAll(async () => {
  fx.down = false;
  await drainMeasurementQueue(10_000);
  setFxService(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const trackingNo = () => `7948${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

async function usdFirm(app: FastifyInstance) {
  const admin = await registerCompany(app, uniq('Mükerrer işareti '));
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
  return { auth: admin.auth, companyId: admin.companyId as string, carrierId };
}

async function upload(app: FastifyInstance, f: { auth: Auth; carrierId: string }, trackings: string[], confirmOverlap = false) {
  const csv = ['Takip No;Desi;Tutar', ...trackings.map((t) => `${t};5;5000`)].join('\n');
  const form = multipart([
    { name: 'carrierId', value: f.carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
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
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...(confirmOverlap ? { confirmOverlap: true } : {}),
    },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  return inv.json().invoice.id as string;
}

async function dupes(app: FastifyInstance, auth: Auth, invoiceId: string) {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as { trackingNo: string; diffTypes: string[] }[]).filter((l) => l.diffTypes.includes('DUPLICATE')).length;
}

const recheckOf = (f: { companyId: string }, invoiceId: string) => inCompany(f.companyId, () => prisma.invoiceRecheck.findUnique({ where: { invoiceId } }));
const ageRecheck = (f: { companyId: string }, invoiceId: string) =>
  inCompany(f.companyId, () => prisma.invoiceRecheck.update({ where: { invoiceId }, data: { pendingAt: new Date(Date.now() - RECOMPARE_STALE_MS - 60_000) } }));

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`zaman aşımı: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('07-B1: sonraki faturaların mükerrer yeniden hesabı kalıcı', () => {
  it('silme sonrası hesap düşer: silme yine 204, sonraki faturada işaret kalır; bakım işi sahte "Mükerrer"i kaldırır', async () => {
    const app = await getApp();
    const f = await usdFirm(app);
    const t = [trackingNo(), trackingNo()];
    const f1 = await upload(app, f, t);
    const f2 = await upload(app, f, t, true);
    expect(await dupes(app, f.auth, f2)).toBe(2);

    fx.down = true;
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${f1}`, headers: f.auth });
    fx.down = false;
    expect(del.statusCode, del.body).toBe(204);
    // hesap düştü: F2 hâlâ mükerrer görünür ama işaretli
    expect(await dupes(app, f.auth, f2)).toBe(2);
    expect(await recheckOf(f, f2)).not.toBeNull();

    // dar yol: 2 dk'dan genç işaret bakımda görünmez
    expect(await withMaintenanceScope(() => prisma.invoiceRecheck.findMany({ where: { invoiceId: f2 }, select: { invoiceId: true } }))).toEqual([]);
    await ageRecheck(f, f2);
    expect(await withMaintenanceScope(() => prisma.invoiceRecheck.findMany({ where: { invoiceId: f2 }, select: { invoiceId: true } }))).toEqual([{ invoiceId: f2 }]);
    // bakım kapsamı yalnız işareti okur: güncelleyemez, silemez, faturayı göremez
    await withMaintenanceScope(async () => {
      expect((await prisma.invoiceRecheck.updateMany({ where: { invoiceId: f2 }, data: { attempts: 3 } })).count).toBe(0);
      expect((await prisma.invoiceRecheck.deleteMany({ where: { invoiceId: f2 } })).count).toBe(0);
      expect(await prisma.invoice.findMany({ where: { id: f2 }, select: { id: true } })).toEqual([]);
    });

    const r = await runMaintenance();
    expect(r.rechecked).toBeGreaterThanOrEqual(1);
    expect(await dupes(app, f.auth, f2)).toBe(0);
    expect(await recheckOf(f, f2)).toBeNull();
  });

  it('başarılı silmede işaret aynı istekte (satır içi kip) boşalır; başlık düzeltmesi de işaret yazar ve boşaltır', async () => {
    const app = await getApp();
    const f = await usdFirm(app);
    const t = [trackingNo()];
    const f1 = await upload(app, f, t);
    const f2 = await upload(app, f, t, true);
    const f3 = await upload(app, f, t, true);
    // fatura no düzeltmesi (hesap yok): sonraki faturalar işaretlenir, hemen hesaplanır, işaret boşalır
    const p = await app.inject({ method: 'PATCH', url: `${API}/invoices/${f2}`, headers: f.auth, payload: { invoiceNo: uniq('F2-') } });
    expect(p.statusCode, p.body).toBe(200);
    expect(await recheckOf(f, f3)).toBeNull();
    expect(await dupes(app, f.auth, f3)).toBe(1);

    expect((await app.inject({ method: 'DELETE', url: `${API}/invoices/${f1}`, headers: f.auth })).statusCode).toBe(204);
    // F2 artık ilk fatura; F3 hâlâ F2'nin mükerreri
    expect(await dupes(app, f.auth, f2)).toBe(0);
    expect(await dupes(app, f.auth, f3)).toBe(1);
    expect(await recheckOf(f, f2)).toBeNull();
    expect(await recheckOf(f, f3)).toBeNull();
  });

  it('JOB_RUNNER=on: silme yanıtı hesabı beklemez; düşen hesabın işaretini sık tarama tamamlar', async () => {
    const app = await getApp();
    const f = await usdFirm(app);
    const t = [trackingNo()];
    const f1 = await upload(app, f, t);
    const f2 = await upload(app, f, t, true);
    vi.stubEnv('JOB_RUNNER', 'on');
    try {
      fx.down = true;
      const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${f1}`, headers: f.auth });
      expect(del.statusCode, del.body).toBe(204);
      // ilk deneme + iki yeniden deneme (1 sn, 5 sn) düşer
      await until(() => {
        const s = measurementQueueState();
        return s.running === 0 && s.waiting === 0 && s.retrying === 0;
      }, 15_000, 'sıra');
      fx.down = false;
      expect(await recheckOf(f, f2)).not.toBeNull();
      expect(await dupes(app, f.auth, f2)).toBe(1);

      await ageRecheck(f, f2);
      expect(await sweepPendingMeasurements()).toBeGreaterThanOrEqual(1);
      await until(async () => (await recheckOf(f, f2)) === null, 8000, 'tarama');
      expect(await dupes(app, f.auth, f2)).toBe(0);
    } finally {
      fx.down = false;
      vi.unstubAllEnvs();
    }
  });

  // Bağımsız inceleme: işaret yazan düzeltme içe aktarma kilidini fatura satırını tutarken bekliyordu. Sırada özel kilit isteyen
  // içe aktarma varken iki düzeltme (biri öbürünün faturasına işaret yazar) ile içe aktarma birbirini bekler (kilitlenme).
  it('kilit sırası: silme ve düzeltmeler içe aktarma kilidini beklerken fatura satırını tutmaz', async () => {
    const app = await getApp();
    const f = await usdFirm(app);
    const t = [trackingNo()];
    const f1 = await upload(app, f, t);
    await upload(app, f, t, true);
    const ups = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: f.auth, payload: { code: 'ups', name: uniq('UPS') } });
    expect(ups.statusCode, ups.body).toBe(201);

    const waiters = () => prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${importLockName(f.companyId)}, 0)`;
    const rowFree = () =>
      inCompany(f.companyId, () => prisma.$transaction((tx) => tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${f1} FOR UPDATE NOWAIT`)).then(
        () => true,
        () => false,
      );
    /** Süren içe aktarmanın özel kilidi tutulurken isteği başlatır; istek kilidi beklerken fatura satırı serbest mi. */
    const whileImporting = async (label: string, start: () => Promise<{ statusCode: number; body: string }>, status: number) => {
      let unlock!: () => void;
      const held = new Promise<void>((r) => (unlock = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const holder = inCompany(f.companyId, () =>
        prisma.$transaction(async (tx) => {
          await lockImportsExclusive(tx, f.companyId);
          locked();
          await held;
        }, { timeout: 60_000 }),
      );
      let pending: Promise<{ statusCode: number; body: string }> | undefined;
      let free: boolean;
      try {
        await lockTaken;
        pending = start();
        await until(async () => (await waiters()).length > 0, 10_000, label);
        free = await rowFree();
      } finally {
        unlock();
        await holder;
      }
      const r = await pending!;
      expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
      expect(free, label).toBe(true);
    };

    await whileImporting('fatura no', () => app.inject({ method: 'PATCH', url: `${API}/invoices/${f1}`, headers: f.auth, payload: { invoiceNo: uniq('F1-') } }), 200);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/${f1}/recalculate/preview`, headers: f.auth, payload: { basis: 'pinned', patch: { carrierId: ups.json().carrier.id } } });
    expect(preview.statusCode, preview.body).toBe(200);
    await whileImporting(
      'taşıyıcı (yeniden hesaplı)',
      () => app.inject({ method: 'PATCH', url: `${API}/invoices/${f1}`, headers: f.auth, payload: { carrierId: ups.json().carrier.id, token: preview.json().token } }),
      200,
    );
    const lines = await app.inject({ method: 'GET', url: `${API}/invoices/${f1}/lines?pageSize=10`, headers: f.auth });
    const lineId = lines.json().items[0].id as string;
    await whileImporting('satırın takip no', () => app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${lineId}`, headers: f.auth, payload: { trackingNo: trackingNo() } }), 200);
    await whileImporting('silme', () => app.inject({ method: 'DELETE', url: `${API}/invoices/${f1}`, headers: f.auth }), 204);
  });

  it('"yarıda kaldı" süresi göçteki ilkede ve kodda aynı (2 dk)', async () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261122090000_recompare_marks/migration.sql'), 'utf8');
    expect(sql).toMatch(/POLICY maintenance_recheck_read[\s\S]*interval '2 minutes'/);
    expect(RECOMPARE_STALE_MS).toBe(2 * 60 * 1000);
    const [policy] = await prisma.$queryRaw<{ qual: string }[]>`SELECT qual FROM pg_policies WHERE schemaname = 'deciship' AND tablename = 'InvoiceRecheck' AND policyname = 'maintenance_recheck_read'`;
    expect(policy?.qual).toMatch(/'00:02:00'::interval/);
  });
});
