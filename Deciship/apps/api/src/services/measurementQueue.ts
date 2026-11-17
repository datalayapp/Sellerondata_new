/**
 * Ölçüm değişikliğinin faturalarla yeniden karşılaştırması, yanıttan sonra (Mesaj 7, plan §4.10, 04-B13). İş tablosu yok:
 * kalıcılık ölçümün `recomparePendingAt` işaretinde (03-B4). Ölçüm işlemi işareti yazar; karşılaştırma başarıyla bitince
 * `settleMeasurementRecompares` işareti (yalnız aynı değeri taşıyorsa) boşaltır.
 *
 * Mesaj 4 (07-B1): aynı sıra faturanın "Mükerrer" yeniden hesabını da taşır (kalıcılık `InvoiceRecheck` satırında; fatura
 * silme, başlık ya da takip no düzeltmesi yazar, `settleInvoiceRecheck` siler).
 *
 * Sıra süreç içidir ve sınırlıdır: aynı anda en çok `MEASURE_RECOMPARE_SLOTS` (2) karşılaştırma. Mesaj 4 kuralları:
 *  - 07-B7: firma başına aynı anda en çok bir karşılaştırma; boş yuva, bekleyen firmalar arasında sırayla (en uzun süredir
 *    hizmet almamış firma önce) dağıtılır. Bir firmanın 500 ölçümü başka firmanın ölçümünü bekletmez.
 *  - 19-B2: bir firmanın bekleyen ölçümleri tek karşılaştırmada birleşir (en çok `MEASURE_BATCH_MAX`, aynı dil): faturalar
 *    bir kez hesaplanır. Aynı faturaya giden 20 ölçüm en çok iki hesap eder (biri sürerken gelenler sonrakinde toplanır).
 *    Birleşik karşılaştırma düşerse ölçümler tek tek yeniden sıraya girer (bozuk tek ölçüm ötekileri düşürmesin).
 *  - Aynı ölçüm (ya da fatura) sırada ikinci kez durmaz (bekleyen kayıt en yeni işareti alır, karşılaştırma başlarken son hâli
 *    okur) ve kendi karşılaştırması sürerken ikinci kez başlamaz. Her karşılaştırma firmanın bağlamında ve kaydedenin dilinde.
 *
 * Düşen karşılaştırma kısa aralıklarla yeniden denenir (`RETRY_DELAYS_MS`; eskiden telefon 500 görüp hemen yeniden
 * gönderiyordu). Yine düşerse ya da süreç ölürse işaret kalır: `startMeasurementSweep` (JOB_RUNNER=on) işaretleri sık
 * aralıkla sıraya alır, saatlik bakım da tamamlar. Bakım kapsamının dar yolu yalnız `RECOMPARE_STALE_MS`'den (2 dk; Y93,
 * eskiden 10 dk) eski işaretleri gösterir (migration 20261110120000, süre 20261119090000; fatura işareti 20261122090000):
 * yeni açılan süreç daha genç işareti göremez, onu en geç 2 dk + bir tarama aralığı (~3,5 dk) sonra alır. Taramada düşen
 * işaret sayılır ve geri çekilir; 5 denemeden sonra taramaya girmez (07-B7, `services/maintenance.ts`).
 *
 * `JOB_RUNNER=inline` (testler): bugünkü gibi istek karşılaştırmayı bekler; ölçümde hata isteğe döner, faturanın mükerrer
 * hesabında günlüğe yazılır (silme ya da düzeltme yine başarılı döner, işaret kalır).
 */
import type { Locale } from '@deciship/core';
import { prisma, withCompany, withMaintenanceScope } from '../db.ts';
import { env } from '../env.ts';
import { currentLocale, withLocale } from '../i18n/index.ts';
import { settleInvoiceRecheck, settleMeasurementRecompares } from './compare.ts';
import { RECOMPARE_MAX_ATTEMPTS, RECOMPARE_STALE_MS, recompareBackoffMs, recordRecompareFailure } from './maintenance.ts';

type Log = { warn(o: unknown, msg: string): void };
type Kind = 'measurement' | 'invoice';
type Task = {
  key: string;
  kind: Kind;
  companyId: string;
  /** ölçüm ya da fatura kimliği */
  refId: string;
  pendingAt: Date | null;
  locale: Locale;
  log?: Log;
  /** bu denemeden önceki düşen deneme sayısı */
  failures: number;
  /** taramadan geldi: son denemesi de düşerse işaretin deneme sayısı artar (07-B7) */
  swept: boolean;
  /** başka ölçümlerle birleştirilmez (birleşik karşılaştırma düştükten sonra tek tek) */
  solo: boolean;
  /** karşılaştırmayı bekleyenler (`recompareWithin`): true = başarıyla bitti, false = düştü */
  waiters: ((ok: boolean) => void)[];
};

/** Düşen karşılaştırmanın yeniden denemeleri arasındaki bekleme (iki yeniden deneme). */
export const RETRY_DELAYS_MS = [1_000, 5_000] as const;
/** Bekleyen işaret taraması aralığı (açılışta bir kez, sonra bu aralıkla). */
export const SWEEP_INTERVAL_MS = 90_000;
/** 19-B2: bir firmanın tek karşılaştırmada birleşen en çok ölçümü. */
export const MEASURE_BATCH_MAX = 100;
const SWEEP_BATCH = 200;

const waiting = new Map<string, Task>();
const runningKeys = new Set<string>();
/** karşılaştırması süren firmalar (firma başına en çok bir) */
const busyCompanies = new Set<string>();
/** firmanın son hizmet aldığı sıra numarası (adil dağıtım) */
const servedAt = new Map<string, number>();
let serveTick = 0;
const running = new Set<Promise<void>>();
const retryTimers = new Set<NodeJS.Timeout>();
let idleWaiters: (() => void)[] = [];
let closed = false;

const fallbackLog: Log = {
  warn: (o, msg) => {
    if (process.env.NODE_ENV !== 'test') console.warn(msg, o);
  },
};

const isIdle = () => !running.size && !waiting.size && !retryTimers.size;

function notifyIdle(): void {
  if (!isIdle() && !closed) return;
  const ws = idleWaiters;
  idleWaiters = [];
  for (const w of ws) w();
}

const keyOf = (kind: Kind, companyId: string, refId: string) => `${kind}:${companyId}:${refId}`;

/** Sıraya koyar ya da aynı kaydın bekleyen girdisine katar (en yeni işaret, bekleyenler birleşir). */
function enqueue(t: Omit<Task, 'key'>): void {
  const key = keyOf(t.kind, t.companyId, t.refId);
  const queued = waiting.get(key);
  if (queued) {
    // İşaret yalnız aynı değerle boşalır: bekleyen kayıt en yenisini taşımalı (yoksa boşalmaz, taramaya kalırdı).
    if (t.pendingAt && (!queued.pendingAt || t.pendingAt.getTime() > queued.pendingAt.getTime())) queued.pendingAt = t.pendingAt;
    queued.waiters.push(...t.waiters);
    queued.failures = Math.min(queued.failures, t.failures);
    queued.swept = queued.swept && t.swept;
    queued.solo = queued.solo || t.solo;
  } else waiting.set(key, { ...t, key });
  pump();
}

/**
 * Karşılaştırmayı sıraya koyar. `inline` kipte bekler (hata atar); diğer kiplerde hemen döner, hata günlüğe yazılır ve
 * işaret kalır. Kapanıştan sonra (`drainMeasurementQueue`) yeni karşılaştırma başlamaz; işareti tarama ya da bakım tamamlar.
 */
export function queueMeasurementRecompare(companyId: string, measurementId: string, pendingAt: Date | null, log?: Log): Promise<void> {
  if (env.jobRunner === 'inline') return settleMeasurementRecompares(companyId, [{ measurementId, pendingAt }]);
  if (!closed) enqueue({ kind: 'measurement', companyId, refId: measurementId, pendingAt, locale: currentLocale(), log, failures: 0, swept: false, solo: false, waiters: [] });
  return Promise.resolve();
}

/**
 * 07-B1: işaretlenmiş faturaların (`markLaterDuplicates`) mükerrer yeniden hesabını sıraya koyar; yanıtı beklemez. `inline`
 * kipte (testler) sırayla bekler, hata isteğe dönmez: günlüğe yazılır, işaret kalır (silme ya da düzeltme yine başarılı).
 */
export async function queueInvoiceRecheck(companyId: string, items: { invoiceId: string; pendingAt: Date | null }[], log?: Log): Promise<void> {
  if (env.jobRunner === 'inline') {
    for (const i of items) {
      try {
        await settleInvoiceRecheck(companyId, i.invoiceId, i.pendingAt);
      } catch (err) {
        (log ?? fallbackLog).warn({ err, invoiceId: i.invoiceId }, 'duplicate recheck failed; pending flag kept for sweep');
      }
    }
    return;
  }
  if (closed) return;
  for (const i of items) enqueue({ kind: 'invoice', companyId, refId: i.invoiceId, pendingAt: i.pendingAt, locale: currentLocale(), log, failures: 0, swept: false, solo: true, waiters: [] });
}

/**
 * Sıraya koyar ve en çok `waitMs` bekler (ölçüm düzeltme ve geri yükleme: yanıt güncel karşılaştırmayı taşısın). true:
 * karşılaştırma bu sürede başarıyla bitti; false: sürüyor, yeniden deneniyor ya da düştü (işaret dolu, iş arkada sürer).
 * `inline` kipte bugünkü gibi bekler, hata isteğe döner.
 */
export async function recompareWithin(companyId: string, measurementId: string, pendingAt: Date | null, waitMs: number, log?: Log): Promise<boolean> {
  if (env.jobRunner === 'inline') {
    await settleMeasurementRecompares(companyId, [{ measurementId, pendingAt }]);
    return true;
  }
  if (closed) return false;
  let timer: NodeJS.Timeout | undefined;
  const settled = new Promise<boolean>((resolve) => {
    enqueue({ kind: 'measurement', companyId, refId: measurementId, pendingAt, locale: currentLocale(), log, failures: 0, swept: false, solo: false, waiters: [resolve] });
  });
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    timer.unref();
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Firmanın sıradaki karşılaştırması: ilk bekleyen; ölçümse aynı dildeki, birleştirilebilir öbür ölçümleriyle birlikte. */
function batchOf(companyId: string): Task[] {
  let first: Task | undefined;
  const out: Task[] = [];
  for (const t of waiting.values()) {
    if (t.companyId !== companyId || runningKeys.has(t.key)) continue;
    if (!first) {
      first = t;
      out.push(t);
      if (t.kind !== 'measurement' || t.solo) return out;
      continue;
    }
    if (out.length >= MEASURE_BATCH_MAX) break;
    if (t.kind === 'measurement' && !t.solo && t.locale === first.locale) out.push(t);
  }
  return out;
}

function pump(): void {
  if (closed) return;
  const slots = env.measureRecompareSlots;
  while (running.size < slots) {
    // 07-B7: bekleyen, karşılaştırması sürmeyen firmalardan en uzun süredir hizmet almamış olan (eşitlikte sıradaki ilk)
    let pick: string | null = null;
    for (const t of waiting.values()) {
      if (busyCompanies.has(t.companyId) || runningKeys.has(t.key)) continue;
      if (pick === null || (servedAt.get(t.companyId) ?? -1) < (servedAt.get(pick) ?? -1)) pick = t.companyId;
    }
    if (pick === null) return;
    const batch = batchOf(pick);
    if (!batch.length) return;
    const companyId = pick;
    servedAt.set(companyId, ++serveTick);
    busyCompanies.add(companyId);
    for (const t of batch) {
      waiting.delete(t.key);
      runningKeys.add(t.key);
    }
    const p: Promise<void> = run(batch).finally(() => {
      running.delete(p);
      busyCompanies.delete(companyId);
      for (const t of batch) runningKeys.delete(t.key);
      pump();
      notifyIdle();
    });
    running.add(p);
  }
}

async function settle(batch: Task[]): Promise<void> {
  const head = batch[0]!;
  await withCompany(head.companyId, () =>
    withLocale(head.locale, () =>
      head.kind === 'invoice'
        ? settleInvoiceRecheck(head.companyId, head.refId, head.pendingAt)
        : settleMeasurementRecompares(head.companyId, batch.map((t) => ({ measurementId: t.refId, pendingAt: t.pendingAt }))),
    ),
  );
}

async function run(batch: Task[]): Promise<void> {
  try {
    await settle(batch);
    for (const t of batch) for (const w of t.waiters) w(true);
  } catch (err) {
    if (batch.length > 1) {
      // Birleşik karşılaştırma düştü: hangi ölçümün düşürdüğü bilinmez. Her biri tek başına, deneme sayısı değişmeden yeniden
      // sıraya girer; bekleyenler tek başına karşılaştırmanın sonucunu alır.
      (batch[0]!.log ?? fallbackLog).warn({ err, measurements: batch.length }, 'batched measurement recompare failed; retrying one by one');
      if (closed) {
        for (const t of batch) for (const w of t.waiters) w(false);
        return;
      }
      for (const t of batch) enqueue({ ...t, solo: true });
      return;
    }
    const t = batch[0]!;
    for (const w of t.waiters) w(false);
    const delay = RETRY_DELAYS_MS[t.failures];
    if (delay === undefined || closed) {
      (t.log ?? fallbackLog).warn({ err, kind: t.kind, id: t.refId, attempts: t.failures + 1 }, 'recompare failed; pending flag kept for sweep');
      if (t.swept) await recordRecompareFailure(t.kind, t.companyId, t.refId, t.pendingAt, t.log ?? fallbackLog);
      return;
    }
    (t.log ?? fallbackLog).warn({ err, kind: t.kind, id: t.refId, retryInMs: delay }, 'recompare failed; retrying');
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!closed) enqueue({ ...t, failures: t.failures + 1, waiters: [] });
      notifyIdle();
    }, delay);
    timer.unref();
    retryTimers.add(timer);
  }
}

/**
 * Bekleyen ölçüm ve fatura işaretleri (dar bakım yolu; geri çekilmesi dolmuş ve deneme hakkı kalmış olanlar, 07-B7), en
 * eskisi önce. Tarama ve saatlik bakım (`services/maintenance.ts`) kullanır. Kapalı firmanın işareti alınmaz (sorguda: kapalı
 * firmanın işaretleri en eskiler olarak turun yerini doldurmasın); firma geri açılınca kaldığı yerden tamamlanır.
 */
export async function pendingRecompareCandidates(now: number, take: number) {
  const tries = Array.from({ length: RECOMPARE_MAX_ATTEMPTS }, (_, a) => ({ a, before: new Date(now - recompareBackoffMs(a)) }));
  return withMaintenanceScope(async () => ({
    measurements: await prisma.measurement.findMany({
      where: {
        recomparePendingAt: { lt: new Date(now - RECOMPARE_STALE_MS) },
        OR: tries.map((t) => ({ recompareAttempts: t.a, recomparePendingAt: { lt: t.before } })),
        company: { closedAt: null },
      },
      select: { id: true, companyId: true, recomparePendingAt: true, recompareAttempts: true },
      orderBy: { recomparePendingAt: 'asc' },
      take,
    }),
    invoices: await prisma.invoiceRecheck.findMany({
      where: { pendingAt: { lt: new Date(now - RECOMPARE_STALE_MS) }, OR: tries.map((t) => ({ attempts: t.a, pendingAt: { lt: t.before } })), company: { closedAt: null } },
      select: { invoiceId: true, companyId: true, pendingAt: true, attempts: true },
      orderBy: { pendingAt: 'asc' },
      take,
    }),
  }));
}

/**
 * Bekleyen işaretleri (ölçüm ve fatura) sıraya alır: dar bakım yolu yalnız `RECOMPARE_STALE_MS`'den eski işaretleri gösterir;
 * geri çekilmesi dolmamış ya da deneme hakkı bitmiş işaret alınmaz (07-B7). Sırada ya da sürmekte olan kayıt ikinci kez
 * girmez. Sıraya alınan sayısını döner.
 */
export async function sweepPendingMeasurements(now = Date.now(), log?: Log): Promise<number> {
  if (closed) return 0;
  const found = await pendingRecompareCandidates(now, SWEEP_BATCH);
  const rows = [
    ...found.measurements.map((r) => ({ kind: 'measurement' as const, companyId: r.companyId, refId: r.id, pendingAt: r.recomparePendingAt, attempts: r.recompareAttempts })),
    ...found.invoices.map((r) => ({ kind: 'invoice' as const, companyId: r.companyId, refId: r.invoiceId, pendingAt: r.pendingAt, attempts: r.attempts })),
  ];
  let n = 0;
  for (const r of rows) {
    const key = keyOf(r.kind, r.companyId, r.refId);
    if (waiting.has(key) || runningKeys.has(key)) continue;
    // önceden düşmüş ölçüm işareti tek başına denenir (bozuk tek ölçüm birleşik karşılaştırmayı düşürmesin)
    enqueue({ ...r, locale: currentLocale(), log, failures: RETRY_DELAYS_MS.length, swept: true, solo: r.kind === 'invoice' || r.attempts > 0, waiters: [] });
    n++;
  }
  return n;
}

/**
 * Sık tarama (main.ts, `JOB_RUNNER=on`): açılışta bir kez, sonra `intervalMs` aralıkla. Zamanlayıcılar `unref`; dönen işlev
 * durdurur. Taramada yeniden deneme yok (sonraki tur zaten yeniden alır).
 */
export function startMeasurementSweep(log: Log, o: { intervalMs?: number } = {}): () => void {
  const tick = () => {
    sweepPendingMeasurements(Date.now(), log).catch((err: unknown) => log.warn({ err }, 'measurement recompare sweep failed'));
  };
  const first = setTimeout(tick, 0);
  const timer = setInterval(tick, o.intervalMs ?? SWEEP_INTERVAL_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Kapanışta (main.ts, çalıştırıcının `stop()`'uyla birlikte): süren ve bekleyen karşılaştırmalar en çok `timeoutMs`
 * beklenir, sonra sıra kapanır (yeniden denemeler iptal). Bitmeyenlerin işareti kalır, tarama ya da bakım tamamlar.
 */
export async function drainMeasurementQueue(timeoutMs: number): Promise<void> {
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
  if (!isIdle()) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => idleWaiters.push(resolve)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
  closed = true;
  for (const t of waiting.values()) for (const w of t.waiters) w(false);
  waiting.clear();
}

/**
 * Tanı ve testler için: süren karşılaştırma (birleşik olan bir sayılır), bekleyen ve yeniden denemeyi bekleyen kayıt sayısı.
 */
export function measurementQueueState(): { running: number; waiting: number; retrying: number } {
  return { running: running.size, waiting: waiting.size, retrying: retryTimers.size };
}
