/**
 * Mesaj 6 bağımsız inceleme: rapor çocuğu ile bellek bekçisi. Rapor eskiden API sürecinde (1 GB yığın) üretiliyordu; bekçi
 * o belleği toplamda görüyor ama API'yi öldüremediği için raporu hiç kesmiyordu. Rapor çocuğa taşınınca bekçi, çocuğun
 * kendi yığını (`REPORT_WORKER_HEAP_MB`) içindeki olağan büyümesini "suçlu iş" sayıp öldürüyordu: 20.000 fark satırlı rapor
 * (çocukta ~760 MB büyüme, API ~450 MB: toplam 1.200 MB sınırının üstü) artık hiç üretilemiyordu (gerileme).
 *
 * Kural: en eski başlamış rapor işi, büyümesi kendi yığın sınırı içinde kaldıkça bekçinin adayı değildir (büyümesi toplama
 * yine sayılır; yanındaki dosya işleri eskisi gibi değerlendirilir). Yığın sınırını aşan büyüme (yığın dışı bellek) ve aynı
 * anda çalışan ikinci rapor olağan aday kalır.
 *
 * Sınırlar bu sürecin o anki RSS'ine göre kurulur (makineden bağımsız); bellek gerçek rapor üretimiyle büyür, en çok ~900 MB.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import { closeFileWorkers, renderReport, runFileWorkerTestTask } from '../src/lib/fileWorkers.ts';
import type { ReportInput } from '../src/services/reports.ts';

const MB = 1024 * 1024;
const KEYS = ['FILE_WORKER_MODE', 'FILE_WORKER_TEST_HOOKS', 'FILE_WORKERS', 'FILE_WORKER_RSS_LIMIT_MB', 'REPORT_WORKER_HEAP_MB', 'REPORT_WORKER_TIMEOUT_MS', 'FILE_WORKER_TIMEOUT_MS', 'REPORT_PDF_MAX_ROWS'] as const;
/**
 * Bu testler büyük PDF'in bellek büyümesini sınar: PDF satır sınırı (`REPORT_PDF_MAX_ROWS`, varsayılan 1.000; karar
 * 2026-11-12) burada kaldırılır, yoksa 3.000-5.000 satırlık rapor 1.000 satıra kısalır ve bekçiye hiç ulaşmaz.
 */
const NO_PDF_ROW_LIMIT = '1000000';
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const setEnv = (over: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
};
const rssMb = () => Math.ceil(process.memoryUsage.rss() / MB);

afterEach(async () => {
  await closeFileWorkers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => closeFileWorkers());

/** Bütün satırları fark, ölçümlü (raporun en pahalı hâli): satır başına çocukta ~35 KB büyüme. */
function reportInput(n: number): ReportInput {
  const lines = Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    rowIndex: i,
    trackingNo: `7712${String(i).padStart(8, '0')}`,
    shipDate: '2026-10-01',
    destCountry: 'DE',
    service: 'IP',
    status: 'DIFF',
    diffTypes: ['WEIGHT', 'DIMS'],
    decision: i % 3 ? 'OPEN' : 'ACCEPTED',
    confidence: i % 5 ? 'HIGH' : 'LOW',
    dims: { l: 40.5, w: 30.2, h: 20.1 },
    billedChargeableKg: 12.345,
    ourChargeableKg: 10.5,
    netAmount: 1234.56,
    expectedAmount: 1100.12,
    diffAmount: 134.44,
    fx: null,
    pricingBasis: 'TARIFF',
    note: 'Ağırlık farkı',
    parseFlags: [],
    measurement: { id: `m${i}`, lengthCm: 38, widthCm: 29, heightCm: 19, weightKg: 10.5, measuredAt: '2026-10-01T10:11:12.000Z', photoCount: 3, dimMethod: 'LIDAR', weightMethod: 'SCALE', measuredBy: 'Ayşe' },
  }));
  const totals = { lines: n, match: 0, diff: n, unmatched: 0, noTariff: 0, overchargeTotal: 1000, verifiedTotal: 0, billedTotal: 2000, expectedTotal: 1000 };
  return { companyName: 'Demo', carrierName: 'FedEx', invoiceNo: 'F-1', invoiceDate: '2026-10-31', periodFrom: null, periodTo: null, currency: 'TRY', totals, lines, timeZone: 'Europe/Istanbul' } as never;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return { ok: false, error: e as AppError };
  }
}

describe('bellek bekçisi ve rapor çocuğu', () => {
  it('raporun kendi yığını içindeki büyümesi (toplam bekçi sınırının üstünde) raporu düşürmez', async () => {
    // Toplam sınır bu sürecin 100 MB üstü: 5.000 satırlık PDF çocukta ~270 MB büyür, toplam sınırın 1,3 katını da aşar.
    setEnv({ FILE_WORKER_MODE: 'process', FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 100), REPORT_WORKER_HEAP_MB: '1024', REPORT_WORKER_TIMEOUT_MS: '120000', REPORT_PDF_MAX_ROWS: NO_PDF_ROW_LIMIT });
    const r = await settle(renderReport('pdf', reportInput(5000), { companyId: 'A' }));
    expect(r.ok, r.ok ? '' : JSON.stringify({ code: r.error.code, details: r.error.details })).toBe(true);
    if (r.ok) expect(r.value.subarray(0, 4).toString('latin1')).toBe('%PDF');
  }, 180_000);

  it('aynı anda ikinci rapor sınırı aşarsa o düşer (422 REPORT_TOO_LARGE); önce başlayan rapor biter', async () => {
    setEnv({ FILE_WORKER_MODE: 'process', FILE_WORKERS: '2', FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 100), REPORT_WORKER_HEAP_MB: '1024', REPORT_WORKER_TIMEOUT_MS: '120000', REPORT_PDF_MAX_ROWS: NO_PDF_ROW_LIMIT });
    const first = settle(renderReport('pdf', reportInput(3000), { companyId: 'A' }));
    const second = settle(renderReport('pdf', reportInput(3000), { companyId: 'B' }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok, a.ok ? '' : JSON.stringify({ code: a.error.code, details: a.error.details })).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.error.statusCode).toBe(422);
      expect(b.error.code).toBe('REPORT_TOO_LARGE');
      expect(b.error.details).toEqual({ reason: 'memory' });
    }
  }, 180_000);

  it('rapor işinin yığın sınırını aşan büyümesi (yığın dışı bellek) bekçiye takılır', async () => {
    // rapor sınıfında yığın dışı ayıran test görevi: --max-old-space-size bunu saymaz, yalnız bekçi keser
    setEnv({ FILE_WORKER_MODE: 'process', FILE_WORKER_TEST_HOOKS: '1', FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 150), REPORT_WORKER_HEAP_MB: '64', REPORT_WORKER_TIMEOUT_MS: '60000' });
    const r = await settle(runFileWorkerTestTask('testAllocateExternal', { companyId: 'A', report: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
  }, 120_000);
});
