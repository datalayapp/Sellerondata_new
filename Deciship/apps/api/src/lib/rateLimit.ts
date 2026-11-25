import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { m, requestLocale } from '../i18n/index.ts';

/**
 * API hız sınırı ve ağır yazma eşzamanlılığı (Mesaj 6, 06-B14 / 03-B9). Süreç içidir: birden çok örnekte sınır örnek başınadır.
 *
 * - `upload`: multipart uçlar (ölçüm dahil). Kişi `RATE_UPLOAD_PER_MIN_MEMBER` (60), firma `RATE_UPLOAD_PER_MIN_ORG` (300) / dk.
 * - `write`: diğer POST, PATCH, PUT, DELETE. Kişi `RATE_WRITE_PER_MIN_MEMBER` (300) / dk.
 * - `vision`: canlı ölçümün tartı ve işaret okuması. Kişi `RATE_VISION_PER_MIN_MEMBER` (60), firma `RATE_VISION_PER_MIN_ORG`
 *   (240) / dk (Y56); kuyruğun `upload` kovasından ayrı: kuyruk boşalırken canlı okuma 429 almaz.
 * - `heavy`: içe aktarma, örnek fatura, toplu yeniden hesap. Süreç genelinde aynı anda `IMPORT_CONCURRENCY` (3), firma başına 1
 *   (`POST /invoices` firma içinde zaten danışma kilidiyle sıralı: kilitte bekleyen istek başka firmanın yuvasını tutmasın).
 *   Yuvalar doluysa istek `HEAVY_QUEUE_WAIT_MS` (30 sn) sırada bekler (19-B8), sonra 503 FILE_BUSY; firmanın kendi ağır
 *   işi sürüyorsa hemen 503.
 *
 * Aşılınca 429 TOO_MANY_REQUESTS + `retry-after` (pencerenin en eski kaydının düşeceği saniye). Mobil kuyruk 429'u yeniden
 * dener; kişi başı 60/dk, 50 ölçümlük kuyruğu bir dakikada boşaltır. GET uçları burada sayılmaz (Merkez yuvaları `hub/limiter.ts`).
 * `API_RATE_LIMIT=off` ikisini de kapatır (testler ve geri dönüş); üretimde açılışta uyarı yazılır.
 */
export type RateBucket = 'upload' | 'vision' | 'write' | 'heavy';

const UPLOAD = ['upload'] as const;
const VISION = ['vision'] as const;
const WRITE = ['write'] as const;
const NONE = [] as const;

/**
 * `METHOD /url` (API önekisiz, Fastify yol kalıbı) → kova. Yazma yöntemli her uç burada olmalı: test/rateLimit.test.ts
 * yol listesiyle karşılaştırır ve multipart okuyan her ucun `upload` (ya da `vision`) olduğunu kaynaktan denetler. Tabloda olmayan uç
 * yine korunur: multipart gövde `upload`, diğer yazma `write` sayılır.
 */
export const RATE_TABLE: Record<string, readonly RateBucket[]> = {
  // Hesap'tan gelen imzalı olay: kişi ve firma yok.
  'POST /internal/events': NONE,

  'PATCH /settings': WRITE,
  'PATCH /settings/onboarding': WRITE,
  'POST /settings/data/reset': WRITE,
  'POST /settings/recompare-invoices/preview': WRITE,
  'POST /settings/recompare-invoices': ['write', 'heavy'],
  // Mesaj 14: örnek veriyle deneme. Başlatma firma başına sıralı (`services/demoTour.ts`), yalnız boş firmada bir kez yükler.
  'POST /settings/demo': WRITE,
  'DELETE /settings/demo': WRITE,
  'POST /box-presets': WRITE,
  'PATCH /box-presets/:id': WRITE,
  'DELETE /box-presets/:id': WRITE,

  'POST /measurements': UPLOAD,
  'PATCH /measurements/:id': UPLOAD,
  'DELETE /measurements/:id': WRITE,
  'POST /measurements/:id/restore': WRITE,
  'POST /measurements/:id/purge': WRITE,

  'POST /vision/scale': VISION,
  'POST /vision/reference/detect': VISION,
  'POST /vision/reference/solve': WRITE,

  'POST /carriers': WRITE,
  'PATCH /carriers/:id': WRITE,
  'DELETE /carriers/:id': WRITE,

  'POST /tariffs': WRITE,
  'PUT /tariffs/:id': WRITE,
  'DELETE /tariffs/:id': WRITE,
  'POST /tariffs/:id/default': WRITE,
  'POST /tariffs/:id/duplicate': WRITE,
  'POST /tariffs/:id/import': UPLOAD,
  'POST /tariff-imports': UPLOAD,
  'POST /tariff-documents/:documentId/scan': WRITE,
  'POST /tariff-documents/:documentId/extract': WRITE,
  'POST /tariff-imports/:draftId/recheck': WRITE,
  'POST /tariff-imports/:draftId/review': WRITE,
  'POST /tariff-imports/:draftId/apply': ['write', 'heavy'],
  'POST /tariffs/:id/versions/:versionId/restore': WRITE,
  'POST /tariffs/:id/recompare-invoices/preview': WRITE,
  'POST /tariffs/:id/recompare-invoices': ['write', 'heavy'],
  'POST /tariffs/:id/country-adjustments': WRITE,
  'POST /tariffs/:id/quote': WRITE,

  'POST /invoices/preview': UPLOAD,
  'POST /invoices/preview/verify': WRITE,
  'POST /invoices/preview/ai-mapping': WRITE,
  'DELETE /invoices/preview/:fileId': WRITE,
  'POST /invoices/preview/:fileId/keep': WRITE,
  'POST /invoices': ['write', 'heavy'],
  'POST /invoices/samples': ['upload', 'heavy'],
  'PATCH /invoices/:id': WRITE,
  'DELETE /invoices/:id': WRITE,
  'PATCH /invoice-lines/:id': WRITE,
  // Mesaj 14: toplu karar (en çok 5.000 satır, tek işlem; hesap yalnız geri alınan işaretli satırlarda)
  'POST /invoices/:id/lines/decide': WRITE,
  'POST /invoices/:id/recompare': WRITE,
  'POST /invoices/:id/recalculate/preview': WRITE,
  'POST /invoices/:id/recalculate': WRITE,

  'POST /invoices/:id/disputes': WRITE,
  'POST /disputes/:id/resend': WRITE,
  'POST /disputes/:id/withdraw': WRITE,
  'POST /disputes/:id/results': WRITE,
  'POST /dispute-results/:id/revert': WRITE,

  // Mesaj 7: arka plan işini durdurma. Başlatma `?async=1` ile mevcut uçlardan, kovaları değişmez.
  'POST /jobs/:jobId/cancel': WRITE,
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WINDOW_MS = 60_000;
/** Ağır işin yuvası: yanıt hiç gönderilmezse (işleyici asılı kaldı) bu süre sonunda kendiliğinden döner. */
const HEAVY_GUARD_MS = 10 * 60_000;
const HEAVY_RETRY_AFTER_S = '5';

/** Tablo → kova; tabloda yoksa yönteme ve gövde türüne göre. */
export function bucketsFor(method: string, relativeUrl: string, multipart: boolean): readonly RateBucket[] {
  const listed = RATE_TABLE[`${method} ${relativeUrl}`];
  if (listed) return listed;
  if (!WRITE_METHODS.has(method)) return NONE;
  return multipart ? UPLOAD : WRITE;
}

export type RateCheck = { key: string; limit: number };
export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Bellek içi kayan pencere: anahtar başına son `windowMs` içindeki istek zamanları. Ya hepsine yazılır ya hiçbirine:
 * firma sınırına takılan istek kişinin hakkından düşmez. Reddedilen istek sayılmaz.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly windowMs = WINDOW_MS) {}

  take(checks: readonly RateCheck[], now = Date.now()): TakeResult {
    this.sweep(now);
    const since = now - this.windowMs;
    let retryAt = 0;
    for (const { key, limit } of checks) {
      const list = this.hits.get(key);
      if (!list) continue;
      while (list.length && list[0]! <= since) list.shift();
      if (list.length >= limit) retryAt = Math.max(retryAt, list[list.length - limit]! + this.windowMs);
    }
    if (retryAt) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
    for (const { key } of checks) {
      const list = this.hits.get(key);
      if (list) list.push(now);
      else this.hits.set(key, [now]);
    }
    return { ok: true };
  }

  /** Penceresi boşalmış anahtarlar en geç bir pencere sonra silinir: bellek etkin kişi sayısıyla sınırlı kalır. */
  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const since = now - this.windowMs;
    for (const [key, list] of this.hits) if (!list.length || list[list.length - 1]! <= since) this.hits.delete(key);
  }

  get size() {
    return this.hits.size;
  }

  clear() {
    this.hits.clear();
  }
}

const windows = new SlidingWindow();
let heavyInFlight = 0;
/** Firma başına ağır iş: en çok 1. */
const heavyByOrg = new Set<string>();

/** Testler için: süreç genelindeki ağır iş sayısı. */
export const heavyInUse = () => heavyInFlight;

/** Testler için: pencereleri boşaltır. */
export function resetRateLimits() {
  windows.clear();
}

function acquireHeavy(orgId: string): () => void {
  heavyInFlight++;
  heavyByOrg.add(orgId);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(guard);
    heavyInFlight--;
    heavyByOrg.delete(orgId);
    // boşalan yuva sıradaki firmaya (19-B8)
    pumpHeavy();
  };
  const guard = setTimeout(release, HEAVY_GUARD_MS);
  guard.unref();
  return release;
}

/**
 * 19-B8: ağır yazma yuvaları (başka firmalarla) doluyken bekleyen istekler, gelme sırasıyla. Firma başına en çok bir
 * bekleyen (firmanın kendi ağır işi sürerken ya da zaten bekliyorken ikincisi hemen 503 `scope: 'company'`). Yuva
 * boşalınca sıradakine doğrudan verilir (`acquireHeavy`); `HEAVY_QUEUE_WAIT_MS` dolarsa ya da istemci bağlantıyı kaparsa
 * sıradan çıkar, 503 FILE_BUSY.
 */
type HeavyWaiter = { orgId: string; grant: (release: () => void) => void; detach: () => void };
const heavyQueue: HeavyWaiter[] = [];
const heavyWaitingOrgs = new Set<string>();

/** Testler için: sırada bekleyen ağır istek sayısı. */
export const heavyWaiting = () => heavyQueue.length;

function pumpHeavy() {
  while (heavyQueue.length && heavyInFlight < env.importConcurrency) {
    const w = heavyQueue.shift()!;
    heavyWaitingOrgs.delete(w.orgId);
    w.detach();
    w.grant(acquireHeavy(w.orgId));
  }
}

function waitForHeavy(orgId: string, req: FastifyRequest, busy: () => AppError): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = req.raw.socket as { once?: (e: 'close', f: () => void) => unknown; off?: (e: 'close', f: () => void) => unknown } | undefined;
    const leave = () => {
      const i = heavyQueue.indexOf(w);
      if (i < 0) return;
      heavyQueue.splice(i, 1);
      heavyWaitingOrgs.delete(orgId);
      w.detach();
      reject(busy());
    };
    const timer = setTimeout(leave, env.heavyQueueWaitMs);
    timer.unref();
    const w: HeavyWaiter = {
      orgId,
      grant: resolve,
      detach: () => {
        clearTimeout(timer);
        socket?.off?.('close', leave);
      },
    };
    socket?.once?.('close', leave);
    heavyQueue.push(w);
    heavyWaitingOrgs.add(orgId);
  });
}

const heavyRelease = new WeakMap<FastifyRequest, () => void>();

function releaseHeavy(req: FastifyRequest) {
  const release = heavyRelease.get(req);
  if (!release) return;
  heavyRelease.delete(req);
  release();
}

/**
 * Kanca `preParsing`te çalışır: rota düzeyindeki kimlik ve izin denetiminden (`onRequest`) SONRA, gövde okunmadan ÖNCE.
 * Yetkisiz ya da izinsiz istek buraya gelmez, kova harcamaz; sınıra takılan istek gövdesi okunmadan döner.
 * Ağır işin yuvası işleyici bitip yanıt gönderilirken (`onSend`; hata yanıtı da) bırakılır, `onResponse` ikinci güvencedir.
 */
export function registerRateLimit(app: FastifyInstance, prefix: string) {
  if (env.isProduction && !env.apiRateLimitEnabled) {
    app.log.warn('API_RATE_LIMIT=off in production: API rate limits and heavy write concurrency are disabled');
  }

  app.addHook('preParsing', async (req, reply, payload) => {
    if (!env.apiRateLimitEnabled || !req.auth) return payload;
    const url = req.routeOptions.url;
    if (!url?.startsWith(prefix)) return payload;
    const buckets = bucketsFor(req.method, url.slice(prefix.length), req.isMultipart());
    if (!buckets.length) return payload;
    const locale = requestLocale(req);
    const { orgId, membershipId } = req.auth;

    // Firma başına 1, süreç genelinde IMPORT_CONCURRENCY: aynı firmanın ikinci ağır isteği başka firmanın yuvasını tutmaz.
    const heavy = buckets.includes('heavy');
    /** Sırada beklerken verilen yuva (19-B8); hız sınırına takılırsa geri verilir. */
    let reserved: (() => void) | null = null;
    if (heavy) {
      const busy = () => {
        reply.header('retry-after', HEAVY_RETRY_AFTER_S);
        return new AppError(503, 'FILE_BUSY', m('err.fileBusy', undefined, locale));
      };
      // Firmanın kendi ağır işi sürüyor ya da sırada: bunu söyler ("çok sayıda dosya" yanıltıcı); ayrıntıda `scope: 'company'`.
      if (heavyByOrg.has(orgId) || heavyWaitingOrgs.has(orgId)) {
        reply.header('retry-after', HEAVY_RETRY_AFTER_S);
        throw new AppError(503, 'FILE_BUSY', m('err.fileBusyOwn', undefined, locale), { scope: 'company' });
      }
      // Yuvalar dolu (ya da önde bekleyen var): kısa süre sırada bekler; `HEAVY_QUEUE_WAIT_MS=0` beklemeden 503.
      if (heavyInFlight >= env.importConcurrency || heavyQueue.length) {
        if (env.heavyQueueWaitMs <= 0) throw busy();
        reserved = await waitForHeavy(orgId, req, busy);
      }
    }

    const checks: RateCheck[] = [];
    if (buckets.includes('upload')) {
      checks.push({ key: `upload:m:${orgId}:${membershipId}`, limit: env.rateUploadPerMinMember });
      checks.push({ key: `upload:o:${orgId}`, limit: env.rateUploadPerMinOrg });
    } else if (buckets.includes('vision')) {
      checks.push({ key: `vision:m:${orgId}:${membershipId}`, limit: env.rateVisionPerMinMember });
      checks.push({ key: `vision:o:${orgId}`, limit: env.rateVisionPerMinOrg });
    } else if (buckets.includes('write')) {
      checks.push({ key: `write:m:${orgId}:${membershipId}`, limit: env.rateWritePerMinMember });
    }
    const taken = windows.take(checks);
    if (!taken.ok) {
      reserved?.();
      reply.header('retry-after', String(taken.retryAfterSec));
      throw new AppError(429, 'TOO_MANY_REQUESTS', m('err.rateLimited', undefined, locale));
    }

    if (heavy) heavyRelease.set(req, reserved ?? acquireHeavy(orgId));
    return payload;
  });

  app.addHook('onSend', async (req, _reply, payload) => {
    releaseHeavy(req);
    return payload;
  });
  app.addHook('onResponse', async (req) => releaseHeavy(req));
}
