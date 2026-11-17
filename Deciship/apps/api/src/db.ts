import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { SqlDriverAdapter, SqlDriverAdapterFactory, SqlQuery, Transaction } from '@prisma/driver-adapter-utils';
import { Prisma, PrismaClient } from './generated/prisma/client.ts';
import { DB_POOL_MAX_DEFAULT, env } from './env.ts';

let client: PrismaClient | undefined;

/**
 * Etkileşimli işlem ($transaction(async tx => …)) varsayılan süreleri. Prisma'nınkiler (bağlantı bekleme 2 sn,
 * işlem 5 sn) yavaş/meşgul makinede aşılıyordu: süre dolunca commit reddedilir → ara sıra 500 "Beklenmeyen bir
 * hata oluştu" (ör. 1500 satırlık tarife içe aktarmada 12 sn, kayıt işleminde 10 sn ölçüldü).
 */
export const TX_DEFAULTS = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * pg havuzu: boşta bekleyen bağlantılar Docker/ağ katmanında sessizce düşebiliyor → sonraki sorgu P1017
 * "Server has closed the connection" / ECONNRESET. TCP keepAlive ölü soketi erken fark ettirir; bağlantılar
 * 5 dakikada bir yenilenir (bayatlamış bağlantı havuzda kalmaz). Kopma yine olursa errors.ts 503 döner.
 */
export const POOL_DEFAULTS = { keepAlive: true, keepAliveInitialDelayMillis: 10_000, maxLifetimeSeconds: 300 } as const;

/**
 * Yeni bağlantıya kalıcı boş dinleyici. Hazır iletisi ile sunucunun kapatma iletisi aynı TCP parçasında gelirse pg ikisini
 * art arda işler: havuz bağlantıyı teslim edip kendi dinleyicisini kaldırmış, bağdaştırıcı henüz kendininkini takmamış olur.
 * Dinleyicisiz `error` süreci düşürür. Asıl işleme havuz ve bağdaştırıcıdadır; sorgu hatası yine 503 olur.
 */
const keepErrorListener = (client: { on(event: 'error', listener: () => void): unknown }) => {
  client.on('error', () => undefined);
};

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Havuzdan bağlantı bekleme üst süresi; Merkez sorgu kapısı da en çok bu kadar bekletir (sonra 503). */
export const connectWaitMs = (source: NodeJS.ProcessEnv = process.env) => positiveInt(source.DB_CONNECT_TIMEOUT_MS, 10_000);

/**
 * Havuz ayarları. Bağlantı beklemesi ve sorgu süresi sınırsız kalırsa tek pahalı uç herkesi bekletir: süre dolunca 503.
 * Oturum ayarları bağlantı açılırken verilir: arama yolu, UTC (ham SQL `now()`) ve sorgu üst süresi.
 *
 * KALANLAR 6.14: JIT kapalı. Büyük firmada Merkez özet sorgularının tahmini maliyeti JIT eşiğini aşıyor; derleme sorgunun
 * kendisinden uzun sürüyordu (1 milyon satırlı firmada 30 günlük genel bakışta 1,2 sn derleme, 0,4 sn iş). Bu API kısa,
 * dizinli sorgular atar; JIT'in kazandırdığı uzun analitik tarama yok.
 */
export function poolConfig(source: NodeJS.ProcessEnv = process.env) {
  const statementTimeout = positiveInt(source.DB_STATEMENT_TIMEOUT_MS, 60_000);
  return {
    ...POOL_DEFAULTS,
    max: positiveInt(source.DB_POOL_MAX, DB_POOL_MAX_DEFAULT),
    connectionTimeoutMillis: connectWaitMs(source),
    options: `-c search_path=deciship -c TimeZone=UTC -c statement_timeout=${statementTimeout} -c jit=off`,
    onConnect: keepErrorListener,
  };
}

// ---------- Satır düzeyinde güvenlik bağlamı (ARCHITECTURE §4) ----------

type DbScope = { companyId?: string; scope?: 'events' | 'maintenance' | 'support' | 'jobs' | 'ai_budget' };

const scopeStore = new AsyncLocalStorage<DbScope>();

/**
 * İsteğin geri kalanını firma bağlamında çalıştırır (auth-kit `runInContext`).
 * Bağlam yoksa RLS sıfır satır gösterir: unutulan bağlam veri sızdırmaz, boş sonuç verir.
 */
export function runInCompany(companyId: string, next: () => void): void {
  scopeStore.run({ companyId }, next);
}

/**
 * Yetki denetiminden geçmiş bir iş için firma bağlamı açar: `loadMember`, imzalı dosya bağlantısı, JIT, testler.
 * Prisma sözü tembeldir, `await` burada olmalı: yoksa sorgu bağlamın dışında başlar.
 */
export function withCompany<T>(companyId: string, work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ companyId }, async () => await work());
}

/** Olay alıcısının kapısı: yalnız `ProcessedEvent` açılır. Firma tabloları için `setTxCompany` gerekir. */
export function withEventScope<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ scope: 'events' }, async () => await work());
}

/** Bakım işinin kapısı: yalnız süresi dolmuş satırlar görünür ve silinebilir (migration 20261107000000). */
export function withMaintenanceScope<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ scope: 'maintenance' }, async () => await work());
}

/**
 * Destek komutunun kapısı (yalnız komut satırı, `src/cli/aiUsage.ts`; HTTP isteğinde açılmaz). Bütün firmaların `AiUsage`,
 * `AiCreditEntry` ve `Company` satırları okunur; başka tablo, ekleme, güncelleme ve silme açılmaz (migration 20261113120000).
 */
export function withSupportScope<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ scope: 'support' }, async () => await work());
}

/**
 * Sistemin günlük yapay zekâ tavanının kapısı (yalnız `services/aiDailyBudget.ts`): bütün firmaların yalnız son 2 günlük
 * `AiUsage` satırları okunur (toplam için); başka tablo, ekleme, güncelleme ve silme açılmaz (migration 20261123090000).
 */
export function withAiBudgetScope<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ scope: 'ai_budget' }, async () => await work());
}

/**
 * İş kuyruğu çalıştırıcısının kapısı (Mesaj 7, src/services/jobs/runner.ts): sahiplenme, kalp atışı, kira bırakma ve
 * deneme hakkı biten işlerin aday listesi. Bütün firmaların yalnız QUEUED/RUNNING `Job` satırları görünür ve güncellenir;
 * güncelleme satırı yalnız QUEUED ya da RUNNING bırakabilir (bitmiş duruma geçiş 42501). Ekleme, silme, bitmiş iş ve başka
 * tablo açılmaz (migration 20261114120000); tek istisna `Company` yalnız okunur: kapalı firmanın işi alınmaz (migration 20261125090000). Bitiş yazımı (JOB_ABANDONED dahil) ve işin kendisi bu kapıda çalışmaz:
 * `withCompany(job.companyId, …)` ile, firma satırın sütunundan alınır.
 */
export function withJobScope<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return scopeStore.run({ scope: 'jobs' }, async () => await work());
}

/** Firma, olay çözülünce belli olur: açık işlemin bağlamını bu işlemin sonuna kadar belirler. */
export async function setTxCompany(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
}

// ---------- Merkez sorgu kapısı (Mesaj 6, 03-B9 / 05-B1) ----------

/**
 * Sorgu şeridi. `hub`: Merkez, Pano, rapor ve dışa aktarma istekleri (`services/hub/limiter.ts` `HUB_LANE_ROUTES`).
 * Bu istekler tek ekranda `Promise.all` ile 10'dan fazla sorgu atar; şerit, süreç genelinde aynı anda en çok
 * `HUB_DB_SLOTS` tekil sorguya, tek firmaya en çok yarısına izin verir. Böylece havuzun geri kalanı ölçüm, yükleme,
 * fatura listesi ve satır kararına kalır; bir firmanın analizi başka firmanın Merkez'ini kapının dışında bırakmaz.
 * Firma bağlamından (`scopeStore`) ayrı tutulur: RLS bağlamı şeritten etkilenmez.
 */
export type DbLane = 'hub';

const laneStore = new AsyncLocalStorage<DbLane>();

export function withDbLane<T>(lane: DbLane, work: () => PromiseLike<T> | T): Promise<T> {
  return laneStore.run(lane, async () => await work());
}

type LaneWaiter = { company: string; grant: () => void };
const hubGate = { active: 0, byCompany: new Map<string, number>(), waiters: [] as LaneWaiter[] };

/** Firma başı tavan: kapının yarısı (yukarı yuvarlanmış). Tek firma kapının tamamını tutamaz; kapı 1 ise 1. */
const companyCap = () => Math.max(1, Math.ceil(env.hubDbSlots / 2));
const companyActive = (company: string) => hubGate.byCompany.get(company) ?? 0;

/** Testler ve günlük için anlık durum. */
export const hubLaneStats = () => ({
  active: hubGate.active,
  waiting: hubGate.waiters.length,
  slots: env.hubDbSlots,
  companyCap: companyCap(),
  activeFor: (companyId: string) => companyActive(companyId),
});

function take(company: string) {
  hubGate.active++;
  hubGate.byCompany.set(company, companyActive(company) + 1);
}

/** Bekleyenler geliş sırasıyla alır; tavanındaki firmanın bekleyeni atlanır, arkasındaki başka firma öne geçer. */
function pumpHubGate() {
  for (let i = 0; i < hubGate.waiters.length && hubGate.active < env.hubDbSlots; ) {
    const w = hubGate.waiters[i]!;
    if (companyActive(w.company) < companyCap()) {
      hubGate.waiters.splice(i, 1);
      w.grant();
    } else i++;
  }
}

/**
 * Kapıdan yuva alır; bırakma işlevini döner (bir kez çalışır). Sıra ilk gelen ilk alır, firma tavanı içinde. Kapı
 * `connectWaitMs()` içinde açılmazsa havuz zaman aşımıyla aynı ileti: errors.ts bunu bağlantı hatası tanır, 503
 * DB_UNAVAILABLE + retry-after. Firma bağlamı yoksa (Merkez isteğinde olmaz) hepsi tek ortak firma sayılır.
 */
function acquireHubSlot(): Promise<() => void> {
  const company = scopeStore.getStore()?.companyId ?? '';
  const release = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      hubGate.active--;
      const left = companyActive(company) - 1;
      if (left > 0) hubGate.byCompany.set(company, left);
      else hubGate.byCompany.delete(company);
      pumpHubGate();
    };
  };
  const companyWaiting = hubGate.waiters.some((w) => w.company === company);
  if (!companyWaiting && hubGate.active < env.hubDbSlots && companyActive(company) < companyCap()) {
    take(company);
    return Promise.resolve(release());
  }
  return new Promise((resolve, reject) => {
    const waiter: LaneWaiter = {
      company,
      grant: () => {
        clearTimeout(timer);
        take(company);
        resolve(release());
      },
    };
    const timer = setTimeout(() => {
      const i = hubGate.waiters.indexOf(waiter);
      if (i >= 0) hubGate.waiters.splice(i, 1);
      reject(Object.assign(new Error('timeout exceeded when trying to connect (hub db lane full)'), { code: 'HUB_DB_LANE_TIMEOUT' }));
    }, connectWaitMs());
    timer.unref();
    hubGate.waiters.push(waiter);
  });
}

/**
 * Yalnız işlem dışındaki tekil sorgu kapıdan geçer. Etkileşimli işlemin sorguları `startTransaction`ın döndürdüğü
 * bağlantıda çalışır, bu sarmalayıcıya hiç uğramaz: iç içe bekleme yok, kilitlenme yok.
 */
async function throughLane<R>(run: () => Promise<R>): Promise<R> {
  if (laneStore.getStore() !== 'hub') return run();
  const release = await acquireHubSlot();
  try {
    return await run();
  } finally {
    release();
  }
}

const SET_SCOPE_SQL = `SELECT set_config('app.company_id', $1, true), set_config('app.scope', $2, true)`;
const STRING_ARG = { scalarType: 'string', arity: 'scalar' } as const;

async function applyScope(tx: Transaction, scope: DbScope): Promise<void> {
  await tx.executeRaw({ sql: SET_SCOPE_SQL, args: [scope.companyId ?? '', scope.scope ?? ''], argTypes: [STRING_ARG, STRING_ARG] });
}

const control = (sql: string): SqlQuery => ({ sql, args: [], argTypes: [] });

async function abort(tx: Transaction) {
  await tx.executeRaw(control('ROLLBACK')).catch(() => undefined);
  await tx.rollback();
}

/**
 * Bağlam sürücü bağdaştırıcısında uygulanır. Prisma'nın ürettiği her SQL buradan geçer: model sorguları, ham sorgu,
 * iç içe yazma, dizi ve etkileşimli `$transaction`. `$extends` kancası bunların hepsini göremez: etkileşimli işlemde
 * `tx` bağlantısına erişemez, kendi işlemini açarsa sorgu başka bağlantıda çalışır.
 *
 * - İşlem başlarken: `set_config(..., true)`, yani SET LOCAL. Bağlantı havuza dönünce bağlam kalmaz.
 * - İşlem dışı tekil sorgu: bağlam varsa kısa bir işleme sarılır. Bağlam yoksa olduğu gibi gider (sıfır satır).
 *   `hub` şeridindeyse önce Merkez sorgu kapısından yuva alır (`throughLane`).
 *
 * İki Prisma kalıbı yasak, çünkü Prisma onları `process.nextTick` ile toplu gönderir ve sorgu o tikte ilk çağıranın
 * bağlamında çalışır, yani aynı tikteki başka firmanın bağlamında (test/rls.test.ts bunu yakaladı):
 * - `findUnique`: `findFirst` kullanın. test/rls.test.ts kaynakta kalmadığını denetler.
 * - Dizi biçimi `$transaction`: `$transaction(async (tx) => ...)` kullanın. Aşağıdaki `prisma` dizi biçimini reddeder.
 */
function scopedAdapter(inner: SqlDriverAdapter): SqlDriverAdapter {
  async function once<R>(run: (q: Pick<Transaction, 'queryRaw' | 'executeRaw'>) => Promise<R>): Promise<R> {
    const scope = scopeStore.getStore();
    if (!scope) return run(inner);
    const tx = await inner.startTransaction();
    try {
      await applyScope(tx, scope);
      const result = await run(tx);
      await tx.executeRaw(control('COMMIT'));
      await tx.commit();
      return result;
    } catch (err) {
      await abort(tx);
      throw err;
    }
  }

  return {
    provider: inner.provider,
    adapterName: inner.adapterName,
    getConnectionInfo: () => inner.getConnectionInfo?.() ?? { supportsRelationJoins: true },
    dispose: () => inner.dispose(),
    executeScript: (script) => inner.executeScript(script),
    queryRaw: (query) => throughLane(() => once((q) => q.queryRaw(query))),
    executeRaw: (query) => throughLane(() => once((q) => q.executeRaw(query))),
    async startTransaction(isolationLevel) {
      const tx = await inner.startTransaction(isolationLevel);
      const scope = scopeStore.getStore();
      if (scope) {
        try {
          await applyScope(tx, scope);
        } catch (err) {
          await abort(tx);
          throw err;
        }
      }
      return tx;
    },
  };
}

function scopedAdapterFactory(inner: SqlDriverAdapterFactory): SqlDriverAdapterFactory {
  return {
    provider: inner.provider,
    adapterName: inner.adapterName,
    connect: async () => scopedAdapter(await inner.connect()),
  };
}

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      adapter: scopedAdapterFactory(
        // Prisma model sorgularını şemayla yazar; `search_path` kodun ham SQL'i içindir. `public`e hiç bakılmaz.
        new PrismaPg({ connectionString: env.databaseUrl, ...poolConfig() }, { schema: 'deciship' }),
      ),
      transactionOptions: TX_DEFAULTS,
    });
  }
  return client;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const c = getPrisma() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    if (prop === '$transaction') {
      return (work: unknown, options: unknown) => {
        if (Array.isArray(work)) throw new Error('Dizi biçimi $transaction firma bağlamını koruyamaz: $transaction(async (tx) => ...) kullanın');
        return (v as (w: unknown, o: unknown) => unknown).call(c, work, options);
      };
    }
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export async function disconnectPrisma() {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

export type Tx = Prisma.TransactionClient;
export type { PrismaClient };
export { Prisma };
