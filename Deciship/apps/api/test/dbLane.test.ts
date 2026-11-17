import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectWaitMs, hubLaneStats, poolConfig, prisma, withCompany, withDbLane } from '../src/db.ts';
import { usesHubLane } from '../src/services/hub/limiter.ts';
import { getApp, measurementPayload, registerCompany } from './helpers.ts';

/**
 * Merkez sorgu kapısı (db.ts `withDbLane`): Merkez, Pano ve rapor isteklerinin tekil sorguları süreç genelinde
 * `HUB_DB_SLOTS` ile sınırlı; ölçüm, yükleme ve işlem içi sorgular kapıdan geçmez. Kapının doluluğu testte `pg_sleep`
 * tutan şerit sorgularıyla kurulur.
 */
const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  return cond();
};

/** Kapıda bir yuvayı `seconds` boyunca tutan tekil sorgu. */
const hold = (companyId: string, seconds: number) => withDbLane('hub', () => withCompany(companyId, () => prisma.$executeRaw`SELECT pg_sleep(${seconds})`));

/**
 * Kapıyı tutan sorgulardan biri bitti mi. 15-B7: "kapıda beklemedi"nin kanıtı süre değil sıradır: kapıdan geçmeyen
 * (ya da boş yuva bulan) istek, tutucular bitmeden döner. Kapıda bekleseydi bir tutucunun bitmesini beklemek zorundaydı.
 * Sabit süre (eski 1.000 / 1.500 ms) yük altındaki CI'da kodda değişiklik yokken kırılabilir; tutma süresinin altında
 * kalmak zorunda olduğundan makineye göre ölçeklenemez.
 */
function releaseWatch(holders: Promise<unknown>[]) {
  let released = false;
  const mark = () => {
    released = true;
  };
  for (const h of holders) h.then(mark, mark);
  return () => released;
}

describe('Merkez sorgu kapısı', () => {
  let app: FastifyInstance;
  let a: Awaited<ReturnType<typeof registerCompany>>;
  let b: Awaited<ReturnType<typeof registerCompany>>;
  let c: Awaited<ReturnType<typeof registerCompany>>;

  beforeAll(async () => {
    app = await getApp();
    a = await registerCompany(app, 'Analiz A');
    b = await registerCompany(app, 'Analiz B');
    c = await registerCompany(app, 'Depo C');
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    expect(await waitFor(() => hubLaneStats().active === 0 && hubLaneStats().waiting === 0)).toBe(true);
  });

  it('havuz 20, kapı varsayılanı 8, bekleme bağlantı beklemesiyle aynı (10 sn)', () => {
    expect(poolConfig({}).max).toBe(20);
    expect(poolConfig({ DB_POOL_MAX: '35' }).max).toBe(35);
    expect(poolConfig({ DB_POOL_MAX: 'abc' }).max).toBe(20);
    expect(connectWaitMs({})).toBe(10_000);
    expect(poolConfig({}).connectionTimeoutMillis).toBe(connectWaitMs({}));
    const prev = process.env.HUB_DB_SLOTS;
    delete process.env.HUB_DB_SLOTS;
    try {
      expect(hubLaneStats().slots).toBe(8);
    } finally {
      if (prev !== undefined) process.env.HUB_DB_SLOTS = prev;
    }
  });

  it('iki firmanın analiz isteği kapıda beklerken üçüncü firmanın ölçüm kaydı 1 sn içinde döner', async () => {
    setEnv({ HUB_DB_SLOTS: '2' });
    const holders = [hold(a.companyId, 2), hold(b.companyId, 2)];
    expect(await waitFor(() => hubLaneStats().active === 2)).toBe(true);

    const month = new Date().toISOString().slice(0, 7);
    const urls = ['/platform/overview', `/dashboard?month=${month}`, '/platform/activity', '/platform/datasets/invoices'];
    const hub = [a, b].flatMap((who) => urls.map((u) => app.inject({ method: 'GET', url: `/api/deciship${u}`, headers: who.auth })));
    expect(await waitFor(() => hubLaneStats().waiting > 0)).toBe(true);

    const p = measurementPayload();
    const released = releaseWatch(holders);
    const created = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...c.auth, ...p.headers }, payload: p.payload });
    expect(created.statusCode).toBe(201);
    expect(released(), 'ölçüm kaydı kapıyı tutan sorguları (2 sn) bekledi').toBe(false);
    // Ölçüm listesi (sık okuma) de kapıdan geçmez.
    const list = await app.inject({ method: 'GET', url: '/api/deciship/measurements', headers: c.auth });
    expect(list.statusCode).toBe(200);
    expect(released(), 'ölçüm listesi kapıyı tutan sorguları bekledi').toBe(false);
    // Kapı hiç aşılmadı; analiz istekleri hâlâ bekliyor.
    expect(hubLaneStats().active).toBeLessThanOrEqual(2);
    expect(hubLaneStats().waiting).toBeGreaterThan(0);

    await Promise.all(holders);
    const results = await Promise.all(hub);
    expect(results.map((r) => r.statusCode)).toEqual(results.map(() => 200));
  });

  it('kapı aynı anda en çok HUB_DB_SLOTS sorgu çalıştırır; sıradakiler sırayla alır', async () => {
    setEnv({ HUB_DB_SLOTS: '3' });
    const firms = [a, b, c];
    let peak = 0;
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        peak = Math.max(peak, hubLaneStats().active);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const order: number[] = [];
    await Promise.all(Array.from({ length: 10 }, (_, i) => hold(firms[i % 3]!.companyId, 0.1).then(() => order.push(i))));
    stop = true;
    await sampler;
    expect(peak).toBe(3);
    expect(order).toHaveLength(10);
  });

  it('tek firma kapının tamamını tutamaz: A doldururken B firmasının Merkez isteği makul sürede döner', async () => {
    setEnv({ HUB_DB_SLOTS: '4' });
    const holders = Array.from({ length: 6 }, () => hold(a.companyId, 3));
    expect(await waitFor(() => hubLaneStats().waiting > 0)).toBe(true);
    // Firma tavanı ceil(4 / 2) = 2: A'nın fazlası sırada, iki yuva boş.
    expect(hubLaneStats().activeFor(a.companyId)).toBe(2);
    expect(hubLaneStats().active).toBe(2);
    const released = releaseWatch(holders);
    const res = await app.inject({ method: 'GET', url: '/api/deciship/platform/overview', headers: b.auth });
    expect(res.statusCode).toBe(200);
    expect(released(), "B'nin isteği A'nın sorgularının (3 sn) bitmesini bekledi").toBe(false);
    expect(hubLaneStats().activeFor(a.companyId)).toBeLessThanOrEqual(2);
    await Promise.all(holders);
  });

  it('fatura listesi, detayı ve satırları kapıya girmez: kapı doluyken B hiç beklemez', async () => {
    setEnv({ HUB_DB_SLOTS: '2' });
    const holders = [hold(a.companyId, 3), hold(c.companyId, 3)];
    expect(await waitFor(() => hubLaneStats().active === 2)).toBe(true);
    const id = crypto.randomUUID();
    const released = releaseWatch(holders);
    for (const u of ['/invoices', `/invoices/${id}`, `/invoices/${id}/lines`, `/invoices/${id}/tariff-health`, '/measurements', '/disputes']) {
      const res = await app.inject({ method: 'GET', url: `/api/deciship${u}`, headers: b.auth });
      expect(res.statusCode, u).toBeLessThan(500);
      expect(released(), `${u} kapıyı tutan sorguları (3 sn) bekledi`).toBe(false);
      expect(hubLaneStats().waiting, u).toBe(0);
    }
    await Promise.all(holders);
  });

  it('kapıya yalnız Merkez, Pano, rapor ve dışa aktarma uçları girer', () => {
    const yes = ['/platform/overview', '/platform/analytics', '/platform/datasets/:id/export', '/platform/ai-usage', '/dashboard', '/invoices/:id/report.xlsx', '/invoices/:id/report.pdf', '/invoices/:id/dispute/evidence.zip'];
    const no = ['/invoices', '/invoices/:id', '/invoices/:id/lines', '/invoices/:id/tariff-health', '/measurements', '/disputes'];
    for (const u of yes) expect(usesHubLane(`/api/deciship${u}`), u).toBe(true);
    for (const u of no) expect(usesHubLane(`/api/deciship${u}`), u).toBe(false);
    expect(usesHubLane(undefined)).toBe(false);
  });

  it('kapı bekleme süresinde açılmazsa 503 DB_UNAVAILABLE + retry-after (kapı ve havuz aynı süre)', async () => {
    setEnv({ HUB_DB_SLOTS: '1', DB_CONNECT_TIMEOUT_MS: '300' });
    const holder = hold(a.companyId, 1.5);
    expect(await waitFor(() => hubLaneStats().active === 1)).toBe(true);
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/deciship/platform/overview', headers: b.auth });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json().error.code).toBe('DB_UNAVAILABLE');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(hubLaneStats().waiting).toBe(0);
    await holder;
  });

  it('işlem içi sorgular kapıdan geçmez; RLS bağlamı şeritte de doğru', async () => {
    setEnv({ HUB_DB_SLOTS: '1' });
    const holder = hold(a.companyId, 1.5);
    expect(await waitFor(() => hubLaneStats().active === 1)).toBe(true);

    const started = Date.now();
    const released = releaseWatch([holder]);
    const inTx = await withDbLane('hub', () =>
      withCompany(b.companyId, () => prisma.$transaction(async (tx) => tx.$queryRaw<{ c: string }[]>`SELECT current_setting('app.company_id', true) AS c`)),
    );
    expect(released(), 'işlem içi sorgu kapıyı tutan sorguyu (1,5 sn) bekledi').toBe(false);
    expect(inTx[0]!.c).toBe(b.companyId);

    // Tekil sorgu ise sırasını bekler ve kendi firmasının bağlamında çalışır.
    const single = await withDbLane('hub', () => withCompany(c.companyId, () => prisma.$queryRaw<{ c: string }[]>`SELECT current_setting('app.company_id', true) AS c`));
    expect(single[0]!.c).toBe(c.companyId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    // Şerit dışındaki tekil sorgu beklemez.
    await holder;
    const outside = await withCompany(a.companyId, () => prisma.carrier.count());
    expect(outside).toBeGreaterThanOrEqual(0);
  });

  it('hata veren sorgu yuvayı bırakır', async () => {
    setEnv({ HUB_DB_SLOTS: '1' });
    await expect(withDbLane('hub', () => withCompany(a.companyId, () => prisma.$queryRaw`SELECT 1 / 0`))).rejects.toThrow();
    expect(hubLaneStats().active).toBe(0);
    const ok = await withDbLane('hub', () => withCompany(a.companyId, () => prisma.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`));
    expect(ok[0]!.n).toBe(1);
  });
});
