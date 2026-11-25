import { AI_LIMIT_DEFAULTS, type AiCallOrigin, type AiKeySource, type AiRejectCode, type ProductKey } from '@sellerondata/contracts';
import type { PrismaClient, Tx } from '../db.ts';
import { RateGate, RATE_DEFAULTS, type RateConfig } from './rate.ts';
import { orgUsage, platformUsage, type Bucket } from './usage.ts';

/**
 * Tavanlar, pay, hız (G3). Vekil (G2) ile arayüz:
 *
 * 1. Vekil amaç kaydını, model izin listesini ve sağlayıcı anahtarını kendisi denetler (`sod_purpose_unknown`,
 *    `sod_model_not_allowed`, `sod_provider_missing`); `count_tokens` ücretsizdir, buraya gelmez.
 * 2. Vekil `pending` satırını `reservedMicroUsd = estimateMicroUsd` ile yazar ve commit eder, SONRA `admit` çağırır.
 * 3. `admit` kendi kısa işleminde danışma kilitlerini hep aynı sırayla alır (platform, sonra firma) ve karar verir:
 *    firma kapalı → platform durdurma → platform günlük / aylık → firmanın tek ortak aylık hakkı → firma × araç tavanı → hız.
 *    Toplam = kapanmış satırların tutarı + açık satırların payı; ÇAĞIRANIN KENDİ SATIRI açık satırlar arasında zaten vardır (pay bir
 *    daha eklenmez). Satırı bulunamazsa (sözleşme dışı) pay `estimateMicroUsd` olarak eklenir.
 *    Kararlar kilit altında sırayla verilir; sonra karar veren, önce kabul edilenin payını her zaman görür: tavan aşılmaz. Bu süreçte
 *    kararı henüz verilmemiş ya da reddedilmiş çağrıların açık payı sayılmaz (`awaiting`, `rejectedIds`; aşağıda), yoksa aynı anda
 *    gelen istekler birbirinin satırı yüzünden toptan geri çevrilirdi.
 * 4. Ret → vekil satırı `rejected` kapatır (tutar 0, pay 0) ve aracın yolunun biçiminde ret gövdesi + `x-sod-ai-reject` +
 *    `x-should-retry: false` (+ `retry-after`) döner. `admit` fırlatırsa vekil satırı `failed` kapatır, araca 503.
 * 5. `ok` dönen her `admit` için tam bir `settle` (satır kapandıktan sonra; deftere yazmaz) ya da `release` (istek sağlayıcıya hiç
 *    gitmedi) gelir. Bellekte para payı tutulmaz; yalnız hız ve eşzamanlılık kiraları (`rate.ts`).
 *
 * Tavan kararı (her tavan için; `limit` = tavan, süren işte tavan × 1,2):
 * - tavan 0 → ret (o araçta yapay zekâ kapalı);
 * - `harcanan ≥ limit` → kesin ret (dönem sonuna kadar): `sod_platform_paused` / `sod_org_cap` / `sod_tool_cap`;
 * - `harcanan + kendi payı > limit` (harcanan tavanın altında) → geçici ret `sod_rate_limited` (R2 2026-11-22: pay kaba üst tahmindir,
 *   1,44 $ paylı PDF çağrısı 8,70/10 $'da "platform durdu" alıyordu; tavan dolmadan kesin ret verilmez). Süren işte asıl tavan
 *   (× 1) dolmuşsa ve pay %20'ye sığmıyorsa kesin;
 * - `harcanan + bütün açık paylar > limit` → geçici ret `sod_rate_limited` (`retryAfterSec` 15): süren çağrılar bitince ya pay döner
 *   ya da tavan gerçek tutarla dolar (DeciShip `AiBudgetBusy` kuralı);
 * - aksi hâlde kabul. Birden çok tavan takılırsa kesin ret geçiciden önce gelir; sıra platform, firma, araç.
 * Süren iş payı (DeciShip `AI_DAILY_BUDGET_JOB_GRACE`): `origin: job` ve aynı istek kimliği zincirinde (`product` +
 * `x-sod-request-id`) son 24 saatte sağlayıcıya gitmiş bir satır varsa iş tavan dolmadan başlamıştır; tavanın %20 üstüne kadar sürer.
 * Zincirin ilk kabulü paysız yapıldığından bu durum "tavandan önce açılmış iş" ile aynıdır. Platformun elle durdurulması pay tanımaz.
 * Firmanın kendi anahtarı (`keySource: 'org'`, ileride) para tavanlarına girmez; durdurma, kapalı firma ve hız yine geçerli [V].
 */

export interface AdmitInput {
  product: string;
  orgId: string;
  memberId: string | null;
  purpose: string;
  model: string;
  provider: 'anthropic' | 'gemini';
  estimateMicroUsd: number;
  requestId: string;
  attempt: number;
  /** Defter satırının kimliği (UUIDv7); `reservationId` budur. */
  callId: string;
  origin: AiCallOrigin;
  stream: boolean;
  keySource: AiKeySource;
}

export type AdmitResult = { ok: true; reservationId: string } | { ok: false; code: AiRejectCode; retryAfterSec?: number };

export interface Limits {
  admit(input: AdmitInput): Promise<AdmitResult>;
  /** Satır kapandıktan sonra bildirim (deftere yazmaz). Bir kez; ikincisi etkisiz. */
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
  /** İstek sağlayıcıya hiç gitmedi (dakika hakkı geri verilir). */
  release(reservationId: string): Promise<void>;
}

/** Tavansız (test ve G3 bağlanmamış kurulum). */
export const allowAll: Limits = {
  async admit(input) {
    return { ok: true, reservationId: input.callId };
  },
  async settle() {},
  async release() {},
};

/** Süren işin tavan üstü payı. */
export const JOB_GRACE_FACTOR = 1 + AI_LIMIT_DEFAULTS.jobOverrunPct / 100;
/** Geçici retin (süren çağrıların payı tavanı dolduruyor) önerilen beklemesi, sn (DeciShip `AI_DAILY_BUDGET_BUSY_RETRY_S`). */
export const BUSY_RETRY_SEC = 15;
/** Süren iş zincirinin geriye bakma süresi. */
export const JOB_CHAIN_WINDOW_MS = 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_LOCK = 'ai:limits:platform';
const orgLock = (orgId: string) => `ai:limits:org:${orgId}`;

type Verdict = 'ok' | 'cap' | 'busy';

/** Tek tavanın kararı (yukarıdaki kural). */
export function judge(b: Bucket, own: number, factor = 1): Verdict {
  if (b.cap === null) return 'ok';
  if (b.cap <= 0) return 'cap';
  const limit = Math.round(b.cap * factor);
  if (b.used >= limit) return 'cap';
  // Kendi payı sığmıyor ama harcanan tavanın altında: pay kaba üst tahmindir (gerçek tutar çoğu kez çok daha az), tavan dolmadı
  // demektir; geçici. Süren işin payında (factor > 1) asıl tavan zaten dolduysa kesin.
  if (b.used + own > limit) return b.used >= b.cap ? 'cap' : 'busy';
  if (b.used + b.reserved > limit) return 'busy';
  return 'ok';
}

type Check = { code: AiRejectCode; bucket: Bucket };

function decide(checks: Check[], own: number, factor: number): { verdict: Verdict; code?: AiRejectCode } {
  let busy: AiRejectCode | undefined;
  for (const c of checks) {
    const v = judge(c.bucket, own, factor);
    if (v === 'cap') return { verdict: 'cap', code: c.code };
    if (v === 'busy') busy ??= c.code;
  }
  return busy ? { verdict: 'busy', code: busy } : { verdict: 'ok' };
}

export type LimitsDeps = {
  prisma: PrismaClient;
  now?: () => Date;
  rate?: Partial<RateConfig>;
};

export type GatewayLimits = Limits & { readonly rate: RateGate };

export function createLimits(deps: LimitsDeps): GatewayLimits {
  const now = deps.now ?? (() => new Date());
  const rate = new RateGate({ ...RATE_DEFAULTS, ...deps.rate }, () => now().getTime());

  async function ownReserve(tx: Tx, input: AdmitInput): Promise<{ own: number; extra: number }> {
    const fallback = Math.max(0, Math.ceil(Number.isFinite(input.estimateMicroUsd) ? input.estimateMicroUsd : 0));
    if (!UUID_PATTERN.test(input.callId)) return { own: fallback, extra: fallback };
    const row = await tx.aiCall.findUnique({ where: { id: input.callId }, select: { status: true, reservedMicroUsd: true, orgId: true, product: true, keySource: true } });
    if (row && row.status === 'pending' && row.orgId === input.orgId && row.product === input.product && row.keySource === 'platform') {
      return { own: Number(row.reservedMicroUsd), extra: 0 };
    }
    return { own: fallback, extra: fallback };
  }

  async function chainStarted(tx: Tx, input: AdmitInput, at: Date): Promise<boolean> {
    if (input.origin !== 'job') return false;
    const prior = await tx.aiCall.findFirst({
      where: {
        product: input.product,
        orgId: input.orgId,
        toolRequestId: input.requestId,
        id: { not: input.callId },
        status: { notIn: ['pending', 'rejected'] },
        startedAt: { gte: new Date(at.getTime() - JOB_CHAIN_WINDOW_MS) },
      },
      select: { id: true },
    });
    return prior !== null;
  }

  /**
   * Bu süreçte kabul kararı bekleyen çağrılar (satırı yazılmış, `admit` başlamış, karar verilmemiş) ve reddedilenler (satırı vekil
   * `rejected` kapatana dek açık durur). İkisinin de açık payı başka bir kararda sayılmaz: bekleyen henüz kabul edilmedi (kendi
   * sırasında kilit altında kabul edilenlerin hepsini görür), reddedilen hiç gitmeyecek. Para payı değildir, yalnız hariç tutma
   * ipucudur: listede olmayan her açık satır (başka süreçteki bekleyen dahil) sayılır, yani temkinli taraf. Böylece eşzamanlı
   * istekler birbirinin henüz kabul edilmemiş payı yüzünden toptan reddedilmez.
   */
  const awaiting = new Set<string>();
  const rejectedIds = new Map<string, number>();
  const REJECTED_TTL_MS = 5 * 60_000;
  const markRejected = (id: string, t: number) => {
    for (const [k, at] of rejectedIds) if (t - at >= REJECTED_TTL_MS) rejectedIds.delete(k);
    rejectedIds.set(id, t);
  };

  async function decideInTx(input: AdmitInput, at: Date): Promise<AdmitResult> {
    const product = input.product as ProductKey;
    return deps.prisma.$transaction(async (tx): Promise<AdmitResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PLATFORM_LOCK}, 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgLock(input.orgId)}, 0))`;
      const verdict = await (async (): Promise<AdmitResult | null> => {
        const org = await tx.org.findUnique({ where: { id: input.orgId }, select: { closedAt: true, purgedAt: true } });
        if (org?.closedAt || org?.purgedAt) return { ok: false, code: 'sod_org_closed' };
        const limits = await tx.platformLimits.findUnique({ where: { id: 1 }, select: { paused: true } });
        if (limits?.paused) return { ok: false, code: 'sod_platform_paused' };
        if (input.keySource !== 'platform') return null;

        const { own, extra } = await ownReserve(tx, input);
        const excludeIds = [...awaiting, ...rejectedIds.keys()].filter((id) => id !== input.callId && UUID_PATTERN.test(id));
        const p = await platformUsage(tx, at, { extraReserved: extra, excludeIds });
        const o = await orgUsage(tx, input.orgId, product, at, { extraReserved: extra, excludeIds });
        const checks: Check[] = [
          { code: 'sod_platform_paused', bucket: p.day },
          { code: 'sod_platform_paused', bucket: p.month },
          { code: 'sod_org_cap', bucket: o.org },
          { code: 'sod_tool_cap', bucket: o.tool },
        ];
        let d = decide(checks, own, 1);
        if (d.verdict !== 'ok' && (await chainStarted(tx, input, at))) d = decide(checks, own, JOB_GRACE_FACTOR);
        if (d.verdict === 'cap') return { ok: false, code: d.code! };
        if (d.verdict === 'busy') return { ok: false, code: 'sod_rate_limited', retryAfterSec: BUSY_RETRY_SEC };
        return null;
      })();
      // Karar, kilit bırakılmadan (commit'ten önce) ve aradaki `await` olmadan yazılır: kilidi sonra alan karar bunu görür.
      let result: AdmitResult;
      if (verdict) result = verdict;
      else {
        // Hız en sonda: kabul edilen her çağrı tam bir kira alır.
        const r = rate.acquire(input.callId, { orgId: input.orgId, product: input.product, stream: input.stream });
        result = r.ok ? { ok: true, reservationId: input.callId } : { ok: false, code: 'sod_rate_limited', retryAfterSec: r.retryAfterSec };
      }
      if (!result.ok) markRejected(input.callId, now().getTime());
      awaiting.delete(input.callId);
      return result;
    });
  }

  return {
    rate,
    async admit(input) {
      awaiting.add(input.callId);
      try {
        return await decideInTx(input, now());
      } catch (e) {
        // Karar düşmedi ya da commit edilemedi: vekil satırı `failed` kapatır, çağrı gitmez; kira varsa geri verilir.
        rate.release(input.callId, true);
        markRejected(input.callId, now().getTime());
        throw e;
      } finally {
        awaiting.delete(input.callId);
      }
    },
    async settle(reservationId) {
      rate.release(reservationId);
    },
    async release(reservationId) {
      rate.release(reservationId, true);
    },
  };
}
