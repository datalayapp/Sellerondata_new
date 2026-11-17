/**
 * KALANLAR 6.14: büyük firmada hız. Veriyi kendisi üretir (`test/perfData.ts`, generate_series): bir büyük firma (varsayılan
 * 25 bin fatura, 500 bin satır, 100 bin ölçüm; `PERF_SCALE=1` ile 1 milyon satır) ve RLS altında planlayıcının ayırması gereken
 * üç küçük firma (her biri büyüğün onda biri). En sık ve en ağır uçları gerçek uygulama rolüyle (`sod_deciship`, firma
 * bağlamı) ölçer; sonucu tablo olarak yazar (vitest geçen testin çıktısını göstersin diye betik `--silent=false` ile koşar).
 *
 * Kapı değil, bilgi (`npm run test:perf:db`, kökte `perf` grubu `api-perf-db`): eşikler gevşek, yalnız "bir şey patladı mı"
 * sorusunu yakalar (dizin düştü, sayfa başına tam tarama, dışa aktarmada parti başına tam sayım). Ölçek `PERF_SCALE` ile
 * (varsayılan 0.5; 0.2 hızlı deneme, 1 milyon satır için 1). `PERF_SQL=1` her ölçümün en yavaş sorgularını da yazar.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recompareForTracking } from '../src/services/compare.ts';
import { MAX_EXPORT_ROWS } from '../src/services/hub/datasets.ts';
import { withCompany } from '../src/db.ts';
import { getApp, registerCompany } from './helpers.ts';
import { analyzeAll, generateCompanyData, perfTracking, type PerfCompany, type PerfShape } from './perfData.ts';
import { testSuperDbUrl } from './testEnv.ts';

const SCALE = Number(process.env.PERF_SCALE ?? 0.5) || 0.5;
const SHOW_SQL = process.env.PERF_SQL === '1';
const big: PerfShape = {
  invoices: Math.round(50_000 * SCALE),
  linesPerInvoice: 20,
  bigInvoiceLines: Math.round(20_000 * SCALE),
  measurements: Math.round(200_000 * SCALE),
  workers: 20,
  audit: Math.round(50_000 * SCALE),
  days: 730,
};
const small: PerfShape = { ...big, invoices: Math.round(big.invoices / 10), bigInvoiceLines: 0, measurements: Math.round(big.measurements / 10), workers: 5, audit: Math.round(big.audit / 5) };

// Sorgu süreleri: uygulamanın pg istemcisi sarılır (test/performance.test.ts deseni). Bağlam ifadeleri sayılmaz.
const pgLib = createRequire(import.meta.url)('pg') as { Client: { prototype: { query: (...a: unknown[]) => unknown } } };
const origQuery = pgLib.Client.prototype.query;
type Q = { sql: string; values?: unknown[]; ms: number };
/** `PERF_DUMP=<dosya>`: her ölçümün en yavaş sorguları (metin ve değerler) dosyaya; planı ayrıca incelemek için. */
const DUMP = process.env.PERF_DUMP;
const dumped: { name: string; queries: Q[] }[] = [];
let capture: Q[] | null = null;

type Row = { name: string; ms: number; limit: number; queries: number; slowest: number; note?: string };
const results: Row[] = [];

async function measure<T>(name: string, run: () => Promise<T>, o: { limit: number; runs?: number; note?: (v: T) => string } = { limit: 2000 }): Promise<T> {
  await run(); // ısınma (önbellek, Prisma sorgu planı)
  const times: number[] = [];
  let last!: T;
  let qs: Q[] = [];
  for (let i = 0; i < (o.runs ?? 3); i++) {
    capture = [];
    const t0 = performance.now();
    last = await run();
    times.push(performance.now() - t0);
    qs = capture;
    capture = null;
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(times.length / 2)]!;
  const slowest = qs.reduce((m, q) => Math.max(m, q.ms), 0);
  results.push({ name, ms, limit: o.limit, queries: qs.length, slowest, note: o.note?.(last) });
  if (DUMP) dumped.push({ name, queries: [...qs].sort((a, b) => b.ms - a.ms).slice(0, 3) });
  if (SHOW_SQL) {
    for (const q of [...qs].sort((a, b) => b.ms - a.ms).slice(0, 3)) console.info(`  [sql ${Math.round(q.ms)} ms] ${q.sql.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return last;
}

describe('büyük firma: liste, arama, Merkez, dışa aktarma süreleri', () => {
  let co: PerfCompany;
  let auth: { authorization: string };
  let app: Awaited<ReturnType<typeof getApp>>;
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/deciship${url}`, headers: auth });
    if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body.slice(0, 300)}`);
    return r;
  };

  beforeAll(async () => {
    pgLib.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
      const first = args[0] as { text?: string } | string | undefined;
      const sql = String(typeof first === 'string' ? first : (first?.text ?? ''));
      const values = (typeof first === 'object' && first && 'values' in first ? (first as { values?: unknown[] }).values : undefined) ?? (Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined);
      const out = origQuery.apply(this, args) as Promise<unknown> | undefined;
      if (capture && out && typeof (out as Promise<unknown>).then === 'function' && !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql)) {
        const t0 = performance.now();
        const list = capture;
        (out as Promise<unknown>).then(
          () => list.push({ sql, values, ms: performance.now() - t0 }),
          () => list.push({ sql, values, ms: performance.now() - t0 }),
        );
      }
      return out;
    };
    app = await getApp();
    const admin = await registerCompany(app, 'Büyük Firma');
    auth = admin.auth;
    const others = [];
    for (let i = 0; i < 3; i++) others.push(await registerCompany(app, `Küçük Firma ${i + 1}`));
    const su = new pg.Client({ connectionString: testSuperDbUrl() });
    await su.connect();
    try {
      await su.query('SET search_path = deciship');
      const t0 = performance.now();
      const log = (s: string) => console.info(s);
      co = await generateCompanyData(su, admin.companyId, admin.userId, big, log);
      for (const o of others) await generateCompanyData(su, o.companyId, o.userId, small);
      await analyzeAll(su, log);
      const sizes = await su.query<{ t: string; n: string }>(
        `SELECT relname AS t, n_live_tup::text AS n FROM pg_stat_user_tables WHERE schemaname = 'deciship' AND relname IN ('Invoice','InvoiceLine','Measurement','DisputeLine') ORDER BY relname`,
      );
      console.info(`[veri] toplam ${Math.round((performance.now() - t0) / 1000)} sn; ${sizes.rows.map((r) => `${r.t} ${r.n}`).join(', ')}`);
    } finally {
      await su.end();
    }
  });

  afterAll(() => {
    pgLib.Client.prototype.query = origQuery;
    if (DUMP) fs.writeFileSync(DUMP, JSON.stringify({ companyId: co?.companyId, dumped }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
    const w = Math.max(...results.map((r) => r.name.length));
    console.info(`\n[süre] ölçek ${SCALE} (büyük firma ${big.invoices} fatura, ${big.invoices * big.linesPerInvoice + big.bigInvoiceLines} satır, ${big.measurements} ölçüm)`);
    console.info(`${'ölçüm'.padEnd(w)} | medyan ms | sınır ms | sorgu | en yavaş ms | not`);
    for (const r of results) console.info(`${r.name.padEnd(w)} | ${String(Math.round(r.ms)).padStart(9)} | ${String(r.limit).padStart(8)} | ${String(r.queries).padStart(5)} | ${String(Math.round(r.slowest)).padStart(11)} | ${r.note ?? ''}`);
  });

  const L = (ms: number) => Math.round(ms * Math.max(1, SCALE));

  it('fatura listesi ve ayrıntısı (satır sayfalama)', async () => {
    await measure('GET /invoices (1. sayfa)', () => get('/invoices?page=1&pageSize=25'), { limit: L(1500) });
    await measure('GET /invoices (sayfa 400)', () => get('/invoices?page=400&pageSize=50'), { limit: L(2000) });
    await measure('GET /invoices ?q=takip no', () => get(`/invoices?q=${perfTracking(5_005)}`), { limit: L(1500), note: (r) => `${r.json().total} fatura` });
    await measure('GET /invoices ?q=fatura no parçası', () => get('/invoices?q=INV-00012'), { limit: L(2000), note: (r) => `${r.json().total} fatura` });
    await measure('GET /invoices ?status=TO_DISPUTE', () => get('/invoices?status=TO_DISPUTE&page=1&pageSize=25'), { limit: L(2500), note: (r) => `${r.json().total} fatura` });
    await measure('GET /invoices/:büyük', () => get(`/invoices/${co.bigInvoiceId}`), { limit: L(2500) });
    await measure('GET /invoices/:büyük/lines (1. sayfa)', () => get(`/invoices/${co.bigInvoiceId}/lines?page=1&pageSize=50`), { limit: L(2000), note: (r) => `${r.json().total} satır` });
    await measure('GET /invoices/:büyük/lines (son sayfa)', () => get(`/invoices/${co.bigInvoiceId}/lines?page=400&pageSize=50`), { limit: L(2500) });
    await measure('GET /invoices/:büyük/lines ?status=UNMATCHED', () => get(`/invoices/${co.bigInvoiceId}/lines?status=UNMATCHED&page=1&pageSize=50`), { limit: L(2000) });
  });

  it('Merkez veri setleri: fatura satırları (arama, sıralama, süzme, sayfalama, toplam)', async () => {
    const ds = (q: string) => get(`/platform/datasets/invoice-lines?${q}`);
    const total = (r: { json: () => { total: number } }) => `${r.json().total} satır`;
    await measure('Merkez satırlar (1. sayfa)', () => ds('page=1&pageSize=25'), { limit: L(3000), note: total });
    await measure('Merkez satırlar (sayfa 2000)', () => ds('page=2000&pageSize=50'), { limit: L(4000) });
    await measure('Merkez satırlar ?q=takip no', () => ds(`q=${perfTracking(5_005)}`), { limit: L(3000), note: total });
    await measure('Merkez satırlar ?q=fatura no', () => ds('q=INV-0001234'), { limit: L(3000), note: total });
    await measure('Merkez satırlar sırala fark tutarı', () => ds('sort=diffAmount&dir=desc'), { limit: L(4000) });
    await measure('Merkez satırlar sırala takip no', () => ds('sort=tracking&dir=asc'), { limit: L(4000) });
    await measure('Merkez satırlar durum=DIFF', () => ds('filter.status=DIFF'), { limit: L(3000), note: total });
    await measure('Merkez satırlar son 30 gün', () => ds(`filter.from=${day(-30)}&filter.to=${day(0)}`), { limit: L(3000), note: total });
    await measure('Merkez satırlar taşıyıcı + fark türü', () => ds(`filter.carrier=${co.carrierIds[0]}&filter.diff=DIMENSION`), { limit: L(3000), note: total });
    await measure('Merkez faturalar (1. sayfa)', () => get('/platform/datasets/invoices?page=1&pageSize=25'), { limit: L(2000), note: total });
    await measure('Merkez faturalar sırala fazla ödeme', () => get('/platform/datasets/invoices?sort=overcharge&dir=desc'), { limit: L(2500) });
    await measure('Merkez ölçümler (1. sayfa)', () => get('/platform/datasets/measurements?page=1&pageSize=25'), { limit: L(2000), note: total });
    await measure('Merkez ölçümler ?q=takip no', () => get(`/platform/datasets/measurements?q=${perfTracking(5_005)}`), { limit: L(2000), note: total });
    await measure('Merkez veri seti listesi', () => get('/platform/datasets'), { limit: L(2000) });
  });

  it('CSV dışa aktarma: akış, bellek', async () => {
    let peak = 0;
    const r = await measure(
      'Merkez CSV satırlar durum=DIFF',
      async () => {
        const base = process.memoryUsage().heapUsed;
        peak = 0;
        const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - base)), 20);
        try {
          const res = await app.inject({ method: 'GET', url: '/api/deciship/platform/datasets/invoice-lines/export?filter.status=DIFF', headers: auth, payloadAsStream: true });
          if (res.statusCode !== 200) throw new Error(`export ${res.statusCode}`);
          let bytes = 0;
          let lines = 0;
          for await (const chunk of res.stream() as AsyncIterable<Buffer>) {
            bytes += chunk.length;
            for (const b of chunk) if (b === 10) lines++;
          }
          return { bytes, lines };
        } finally {
          clearInterval(timer);
        }
      },
      { limit: L(30_000), runs: 1, note: (v) => `${v.lines - 1} satır, ${(v.bytes / 1e6).toFixed(1)} MB, yığın artışı en çok ${Math.round(peak / 1e6)} MB` },
    );
    expect(r.lines).toBeGreaterThan(1);
    // Sınırı aşan dışa aktarma: yalnız büyük firmanın satırları sınırı aşıyorsa (küçük ölçekte aşmaz).
    if (big.invoices * big.linesPerInvoice + big.bigInvoiceLines > MAX_EXPORT_ROWS) await measure('Merkez CSV çok büyük (reddedilir)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/deciship/platform/datasets/invoice-lines/export', headers: auth });
      expect(res.statusCode).toBe(400);
      return res;
    }, { limit: L(5000), runs: 1 });
  });

  it('Pano ve analiz özetleri', async () => {
    await measure('GET /dashboard', () => get('/dashboard'), { limit: L(3000) });
    await measure('Merkez genel bakış (30 gün)', () => get('/platform/overview'), { limit: L(4000) });
    await measure('Merkez genel bakış (1 yıl)', () => get(`/platform/overview?from=${day(-364)}&to=${day(0)}`), { limit: L(8000) });
    await measure('Merkez analiz (30 gün)', () => get('/platform/analytics'), { limit: L(4000) });
    await measure('Merkez analiz (1 yıl)', () => get(`/platform/analytics?from=${day(-364)}&to=${day(0)}`), { limit: L(8000) });
  });

  it('ölçüm listesi, takip no araması, yeniden karşılaştırma, itiraz listesi', async () => {
    await measure('GET /measurements (1. sayfa)', () => get('/measurements?page=1&pageSize=25'), { limit: L(1500) });
    await measure('GET /measurements ?q=takip no', () => get(`/measurements?q=${perfTracking(5_005)}`), { limit: L(2000), note: (r) => `${r.json().total} ölçüm` });
    await measure('GET /measurements/check', () => get(`/measurements/check?tracking=${perfTracking(5_005)}`), { limit: L(500) });
    await measure('recompareForTracking (1 takip no)', () => withCompany(co.companyId, () => recompareForTracking(co.companyId, [perfTracking(5_005)])), { limit: L(3000), note: (ids) => `${ids.length} fatura` });
    await measure('GET /disputes', () => get('/disputes'), { limit: L(4000), note: (r) => `${(r.json().items ?? r.json().invoices ?? []).length} kayıt` });
  });

  it('sınırlar aşılmadı', () => {
    const over = results.filter((r) => r.ms > r.limit);
    expect(over.map((r) => `${r.name}: ${Math.round(r.ms)} ms > ${r.limit} ms`)).toEqual([]);
  });
});

function day(offset: number) {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}
