/**
 * Sistemin günlük yapay zekâ tavanı (kapalı deneme kararı, 2026-11-12; denetim 05-B3). Bütün firmaların bugünkü `AiUsage`
 * tutarlarının toplamı `AI_DAILY_BUDGET_TRY`'ye ulaşınca yeni sağlayıcı çağrısı sağlayıcıya gitmeden 429 `AI_DAILY_BUDGET`
 * alır. Firma kotasından ayrıdır: firmanın hakkı ve `/me` bayrakları değişmez. Kurallar SPEC §5.12.
 *
 * - Gün: sistem günü, `DEFAULT_TIME_ZONE` (Europe/Istanbul) takvim günü; firmanın saat dilimi değil. Satırın `createdAt`'i
 *   [gün başı, ertesi gün başı) aralığındaysa o güne sayılır. Durum (`OK`, `FAILED`, `CACHED`) ayrımı yok: tutar neyse o
 *   (`CACHED` 0; ücret doğmuş `FAILED` sayılır).
 * - Sayım: veritabanı toplamı en çok `AI_DAILY_BUDGET_REFRESH_MS`'de bir (süreç içi), arada bu sürecin yazdığı satırlar
 *   artımlı eklenir. Toplama sorgusu `app.scope = 'ai_budget'` kapısında: yalnız `AiUsage`, yalnız okuma, yalnız son 2 gün
 *   (göç 20261123090000). Kapı yalnız bu dosyada açılır (test/aiDailyBudget.test.ts kaynakta denetler).
 * - Yarış: kabul edilen her çağrı sonucu gelene dek kendi üst sınır tutarı kadar pay ayırır (`aiMeter.ts`
 *   `aiCallUpperMicros`: `maxTokens` × çıktı fiyatı + istek boyundan tahmini girdi × girdi fiyatı); sonuç gelince pay bırakılır,
 *   gerçek tutar eklenir. Yeni çağrı `harcanan + ayrılan >= tavan` ise reddedilir. Süreç başına aşım en çok bir çağrının
 *   üst sınırı kadardır (son kabul edilen çağrı).
 * - Süren iş: tavan bu süreçte ilk dolduğu andan önce oluşturulmuş arka plan işinin çağrıları tavanın %20 üstüne kadar sürer
 *   (`AI_DAILY_BUDGET_JOB_GRACE`); sonra o iş de durur (okunmuş parçalar önbellekte, yarın ücretsiz alınır). Sonra açılan iş
 *   payı almaz.
 * - Günlük: tavan o gün bu süreçte ilk dolduğunda `error` düzeyinde tek satır `ai-daily-budget-reached`.
 */
import { AI_MICROS_PER_UNIT, aiPeriodOf } from '@sellerondata/contracts';
import { Prisma, prisma, withAiBudgetScope } from '../db.ts';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { m } from '../i18n/index.ts';
import { DEFAULT_TIME_ZONE, zonedDate, zonedDayStart } from '../lib/time.ts';
import { currentJobScope } from './jobs/jobScope.ts';

/** Sistem gününün saat dilimi (firmanınki değil). */
export const AI_DAILY_BUDGET_TIME_ZONE = DEFAULT_TIME_ZONE;
/** Veritabanı toplamının süreç içi ömrü, ms. Arada bu sürecin harcaması artımlı eklenir. */
export const AI_DAILY_BUDGET_REFRESH_MS = 10_000;
/** Tavan dolmadan önce açılmış arka plan işinin payı: tavanın bu oranı kadar üstü. */
export const AI_DAILY_BUDGET_JOB_GRACE = 0.2;

const DAY_MS = 86_400_000;

export type AiSystemDay = { day: string; start: Date; end: Date };

/** Anın sistem günü: `YYYY-MM-DD` ve [başı, ertesi günün başı). */
export function aiSystemDay(at: Date): AiSystemDay {
  const day = zonedDate(at, AI_DAILY_BUDGET_TIME_ZONE);
  const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  return { day, start: zonedDayStart(day, AI_DAILY_BUDGET_TIME_ZONE), end: zonedDayStart(next, AI_DAILY_BUDGET_TIME_ZONE) };
}

/**
 * Günün toplam tutarı (mikro TL), çağıranın veritabanı kapısında (bütçe kapısı ya da destek komutunun kapısı). `period`
 * süzgeci dönem dizinini kullandırır: satırın dönemi firmanın saat diliminde, günün ±1 gün çevresindeki UTC ayları onu kapsar.
 */
export async function sumDailyMicros(d: AiSystemDay): Promise<number> {
  const periods = [...new Set([aiPeriodOf(new Date(d.start.getTime() - DAY_MS), 'UTC'), aiPeriodOf(d.start, 'UTC'), aiPeriodOf(new Date(d.end.getTime() + DAY_MS), 'UTC')])];
  const r = await prisma.aiUsage.aggregate({ where: { period: { in: periods }, createdAt: { gte: d.start, lt: d.end } }, _sum: { cost: true } });
  return r._sum.cost ? Number(new Prisma.Decimal(r._sum.cost).mul(AI_MICROS_PER_UNIT).toFixed(0)) : 0;
}

type DayState = {
  day: AiSystemDay;
  /** son okunan veritabanı toplamı */
  dbMicros: number;
  /** okuma sürerken: okumadan önce eklenmiş artımlar (okuma bitince düşer, toplamda zaten vardır) */
  carryMicros: number;
  /** son okumadan sonra bu sürecin eklediği */
  localMicros: number;
  fetchedAt: number;
  refreshing: Promise<void> | null;
  /** tavanın bu süreçte ilk dolu görüldüğü an (süren iş payı ve tek günlük satırı) */
  fullSince: number | null;
};

let state: DayState | null = null;
/** Sonucu beklenen çağrıların ayırdığı pay (günden bağımsız: gece yarısını aşan çağrı yeni güne yazılır). */
let reservedMicros = 0;

/** Testler için. */
export function resetAiDailyBudgetState() {
  state = null;
  reservedMicros = 0;
}

function dayState(now: number): DayState {
  const day = aiSystemDay(new Date(now));
  if (!state || state.day.day !== day.day) {
    state = { day, dbMicros: 0, carryMicros: 0, localMicros: 0, fetchedAt: Number.NEGATIVE_INFINITY, refreshing: null, fullSince: null };
  }
  return state;
}

/** Bayatsa veritabanından okur (aynı anda gelenler tek okumayı bekler). Okuma düşerse hata çağrıya geçer (kapalı kalır). */
async function fresh(s: DayState, now: number): Promise<void> {
  if (now - s.fetchedAt < AI_DAILY_BUDGET_REFRESH_MS && !s.refreshing) return;
  if (!s.refreshing) {
    s.carryMicros += s.localMicros;
    s.localMicros = 0;
    s.refreshing = (async () => {
      try {
        const micros = await withAiBudgetScope(() => sumDailyMicros(s.day));
        s.dbMicros = micros;
        s.carryMicros = 0;
        s.fetchedAt = Date.now();
      } finally {
        s.refreshing = null;
      }
    })();
  }
  await s.refreshing;
}

const spentOf = (s: DayState) => s.dbMicros + s.carryMicros + s.localMicros;

export type AiBudgetTicket = {
  /** çağrının tutarı, satır yazıldıktan sonra (yazılamasa da): sayaç artar */
  spend: (micros: number) => void;
  /** ayrılan pay bırakılır (bir kez) */
  release: () => void;
};
const NO_TICKET: AiBudgetTicket = { spend: () => undefined, release: () => undefined };

type BudgetLog = { error: (obj: unknown, msg?: string) => void };

function budgetReached(s: DayState): AppError {
  return new AppError(429, 'AI_DAILY_BUDGET', m('err.aiDailyBudget'), { resetsAt: s.day.end.toISOString() });
}

/**
 * Harcanan tavanın altında ama sonucu beklenen çağrıların payıyla tavan doluyor. Geçicidir: `aiMeter.ts` bunu 503 `AI_BUSY`
 * (`AiTransientError`, "biraz sonra yeniden deneyin") yapar; arka plan işi beklemeyle yeniden dener, süren çağrılar bitince
 * ya pay döner ya da gerçek tutarla tavan dolar (o zaman `AI_DAILY_BUDGET`).
 */
export class AiBudgetBusy extends Error {
  constructor() {
    super('ai-daily-budget-busy');
  }
}
/** Geçici retin önerilen bekleme süresi, sn. */
export const AI_DAILY_BUDGET_BUSY_RETRY_S = 15;

/** Hata günlük tavandan mı (kesin ya da geçici): dakika hız sınırının hakkı geri verilir. */
export const isAiDailyBudgetError = (err: unknown): boolean =>
  err instanceof AiBudgetBusy || (err instanceof AppError && err.code === 'AI_DAILY_BUDGET') || (err as { aiBudget?: unknown } | null)?.aiBudget === true;

/**
 * Sağlayıcıya gidecek çağrı için. `upperMicros`: bu çağrının olabilecek en yüksek tutarı (`aiCallUpperMicros`).
 * Harcanan (bu süreçte görülen bugünkü toplam) tavana ulaştıysa 429 `AI_DAILY_BUDGET` (kesin; sağlayıcı çağrılmaz, satır
 * yazılmaz). Harcanan + sonucu beklenenlerin payı tavana ulaştıysa `AiBudgetBusy` (geçici). Değilse `upperMicros` kadar pay
 * ayrılır ve bilet döner. `AI_DAILY_BUDGET_TRY=off`: denetim yok, sorgu yok.
 */
export async function takeAiDailyBudget(origin: 'request' | 'job' | undefined, log: BudgetLog, upperMicros: number, now: number = Date.now()): Promise<AiBudgetTicket> {
  const budgetTry = env.aiDailyBudgetTry;
  if (budgetTry === null) return NO_TICKET;
  const budget = Math.round(budgetTry * AI_MICROS_PER_UNIT);
  const s = dayState(now);
  await fresh(s, now);
  const spent = spentOf(s);
  if (spent >= budget && s.fullSince === null) {
    s.fullSince = now;
    log.error(
      { day: s.day.day, budgetTry, spentTry: spent / AI_MICROS_PER_UNIT, inFlightTry: reservedMicros / AI_MICROS_PER_UNIT },
      'ai-daily-budget-reached: new AI provider calls are rejected until the next system day (AI_DAILY_BUDGET_TRY)',
    );
  }
  const job = origin === 'job' ? currentJobScope() : undefined;
  const graced = !!job && s.fullSince !== null && job.createdAt.getTime() < s.fullSince;
  const limit = graced ? Math.round(budget * (1 + AI_DAILY_BUDGET_JOB_GRACE)) : budget;
  if (spent >= limit) throw budgetReached(s);
  // Harcanan tavanın altında ama sonucu beklenen çağrıların payı tavanı dolduruyor: geçici (onlar bitince pay döner).
  if (spent + reservedMicros >= limit) throw new AiBudgetBusy();
  const reserve = Math.max(1, Math.round(upperMicros));
  reservedMicros += reserve;
  let released = false;
  return {
    spend: (micros) => {
      if (!(micros > 0)) return;
      dayState(Date.now()).localMicros += micros;
    },
    release: () => {
      if (released) return;
      released = true;
      reservedMicros = Math.max(0, reservedMicros - reserve);
    },
  };
}

/** Destek komutu için: anın günü, toplamı (çağıranın kapısında okunur) ve tavan (`null` = off). */
export async function aiDailyBudgetReport(at: Date = new Date()): Promise<{ day: string; timeZone: string; spentMicros: number; budgetTry: number | null }> {
  const d = aiSystemDay(at);
  return { day: d.day, timeZone: AI_DAILY_BUDGET_TIME_ZONE, spentMicros: await sumDailyMicros(d), budgetTry: env.aiDailyBudgetTry };
}
