/**
 * Yapay zekâ sayacı ve kotası (Mesaj 6, 03-B1). Bütün yapay zekâ çağrıları buradan geçer: `structuredCall` yalnız bu dosyada
 * içe aktarılır (test/aiMeter.test.ts kaynakta denetler).
 *
 * `meteredCall` sırası:
 *  1. anahtar yoksa 503 AI_DISABLED;
 *  2. kişi başı dakika sınırı → 429 TOO_MANY_REQUESTS (`retry-after`; `API_RATE_LIMIT=off` kapatır). Arka plan işinde
 *     (`origin: 'job'`, Mesaj 7) atlanır: başlatırken `assertAiRate` ile bir kez sayıldı;
 *  3. önbellek (yalnız `cache` ve `fresh` değilse; `cacheNotBefore` varsa yalnız ondan yeni kayıt): isabet → `CACHED` satırı
 *     (ücret 0), sonuç ücretsiz döner;
 *  4. süreç içi tek uçuş: aynı firmada aynı girdi sürüyorsa onun sonucu beklenir (çift tık iki kez ücretlenmez);
 *  4b. sistemin günlük tavanı (`aiDailyBudget.ts`, `AI_DAILY_BUDGET_TRY`): bütün firmaların bugünkü toplamı doluysa 429
 *     AI_DAILY_BUDGET (sağlayıcı çağrılmaz, satır yazılmaz; firma kotası gibi gösterilmez);
 *  5. kota: kullanılan ≥ hak → 429 AI_QUOTA_EXCEEDED (ayrıntıda tutar yok). Yumuşak sınır: aşım en çok firma başı
 *     eşzamanlı çağrı sayısı kadar olur;
 *  6. firma başı eşzamanlılık yuvası; doluysa 429 TOO_MANY_REQUESTS;
 *  7. sağlayıcı çağrısı; kullanım yanıttaki `message.usage`'tan;
 *  8. fiyat yanıtı veren modelden (`usage.iterations` varsa kalem kalem); model istenenden farklıysa pahalı olan;
 *  9. `AiUsage` satırı (`OK` ya da hata kodlu `FAILED`), her zaman `withCompany(ctx.companyId)` içinde;
 * 10. `OK` ve `cache` ise sonuç önbelleğe (upsert), `OK` satırıyla AYNI işlemde (Mesaj 7: ya ikisi ya hiçbiri);
 * 11. sayaç yazılamazsa sonuç yine döner, günlüğe `ai-meter-write-failed` yazılır (ödenmiş sonuç atılmaz). Firma başı sigorta:
 *     art arda 3 yazım hatasından sonra o firmanın yeni sağlayıcı çağrıları 5 dk (ya da bir yazım başarılı olana kadar) 503.
 *
 * Sonuç vermeyen çağrı (`FAILED`) gerçek token ve maliyetle yazılır ama kotadan DÜŞMEZ: kota toplamı yalnız `OK` satırlarıdır
 * (kullanıcı kararına açık, geri alması tek süzgeç). Ama dönemdeki `FAILED` maliyetinin kendi tavanı var (hak ×
 * `AI_FAILED_BUDGET_RATIO`); dolunca yeni çağrı 429 AI_QUOTA_EXCEEDED, `reason: 'failed_budget'`. Kesilme, ret ve toplam süre
 * dolması (ücret doğmuş hatalar) aynı içerik (firma + tür + içerik özeti) için 30 dk hatırlanır: dil ve `fresh` atlatmaz,
 * sağlayıcı çağrılmadan aynı hata, "N dakika sonra yeniden deneyin" ve `retry-after` ile döner. Sağlayıcının geçici hatası
 * (`AiTransientError`: aşırı yük, ulaşılamadı, bağlantı zaman aşımı; ücret yok) hatırlanmaz (05-B7).
 *
 * Sağlayıcıya gidecek istek `AI_MAX_REQUEST_BYTES`'ı aşıyorsa çağrı yapılmaz: 413 `FILE_TOO_LARGE` (05-B14).
 *
 * KALANLAR 6.5: bağlamın `signal`'i (arka plan işinde durdurma isteği) süren çağrıyı sağlayıcıda da keser: 409 `AI_CANCELLED`,
 * `FAILED` satırı üst tahminle (`cancelledUsage`), hatırlanmaz. Ücretli `OK` satırından sonra hak %80'i geçtiyse ayar
 * yetkililerine ayda bir posta (`aiQuotaNotice.ts`).
 *
 * Sayaçlar (dakika sınırı, yuva, tek uçuş) süreç içidir: birden çok örnekte sınır örnek başınadır (Y maddesi).
 */
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AI_CURRENCY,
  AI_LIMIT_CREDIT_MONTHLY,
  AI_MICROS_PER_UNIT,
  aiCostMicros,
  aiNextPeriod,
  aiPeriodOf,
  mostExpensiveAiPrice,
  type AiPrice,
  type AiTokenUsage,
} from '@sellerondata/contracts';
import { Prisma, prisma, withCompany } from '../db.ts';
import { env, parseAiPriceTable } from '../env.ts';
import { AppError } from '../errors.ts';
import { currentLocale, m } from '../i18n/index.ts';
import { readSettings } from '../lib/settings.ts';
import { DEFAULT_TIME_ZONE, isTimeZone, zonedDayStart } from '../lib/time.ts';
import { currentJobScope } from './jobs/jobScope.ts';
import { AI_DAILY_BUDGET_BUSY_RETRY_S, AiBudgetBusy, isAiDailyBudgetError, resetAiDailyBudgetState, takeAiDailyBudget, type AiBudgetTicket } from './aiDailyBudget.ts';
import { AiCancelledError, AiKeyInvalidError, AiTransientError, aiDisabled, aiEnabled, structuredCall, type AiCallUsage, type AiUsage } from './ai.ts';
import { AI_QUOTA_NOTICE_PCT, noticeAiQuota, resetAiQuotaNoticeState } from './aiQuotaNotice.ts';

export type AiKind = 'SCALE_READ' | 'INVOICE_PDF' | 'INVOICE_MAPPING' | 'TARIFF_PDF_DISCOVER' | 'TARIFF_PDF_EXTRACT' | 'TARIFF_REVIEW';
export const AI_KINDS: readonly AiKind[] = ['SCALE_READ', 'INVOICE_PDF', 'INVOICE_MAPPING', 'TARIFF_PDF_DISCOVER', 'TARIFF_PDF_EXTRACT', 'TARIFF_REVIEW'];

/** Sayacın günlüğü: isteğin `req.log`'u, yoksa (komut satırı, test) konsol. */
export type MeterLog = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
const consoleLog: MeterLog = {
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

export type AiCallContext = {
  companyId: string;
  memberId: string | null;
  kind: AiKind;
  /** req.auth.subscription.limits (istek anındaki; arka plan işinde de o an alınmış kopya) */
  limits: Record<string, number | boolean>;
  ref?: { type: 'File' | 'TariffDocument' | 'TariffImportDraft'; id: string | null };
  /** önbelleği atla (yeni sonuç yine yazılır); `cacheNotBefore` verilirse yalnız ondan eski kayıtlar atlanır */
  fresh?: boolean;
  log?: MeterLog;
  /**
   * Mesaj 7 (plan §4.7). `request`: istek içi çağrı (varsayılan). `job`: arka plan işi; kişi başı dakika sınırı atlanır, çünkü
   * iş başlatılırken bir kez sayıldı (`assertAiRate`). Firma yuvası, kota ve önbellek aynen geçerli. Yalnız `aiJobContext`
   * `job` verir; istekten (`aiContext`) atlanamaz.
   */
  origin?: 'request' | 'job';
  /**
   * Bu andan eski önbellek kaydı kullanılmaz. "Yeniden oku" (`fresh`) işinde = işin oluşturulma anı: işten önceki eski sonuç
   * gelmez, ama bu işin kendi ürettiği sonuç (önceki denemede yazılmış) yeniden denemede ücretsiz alınır (çift ücret olmaz).
   */
  cacheNotBefore?: Date;
  /**
   * KALANLAR 6.5: vazgeçme sinyali. Kesilirse süren sağlayıcı çağrısı kesilir (`structuredCall`), 409 `AI_CANCELLED` atılır;
   * harcama `FAILED` satırına üst tahminle yazılır (`cancelledUsage`; kotadan düşmez, sonuç vermeyen çağrı tavanına ve
   * sistemin günlük tavanına girer). Önceden kesilmişse sağlayıcıya gidilmez, satır yazılmaz. Arka plan işinde yalnız
   * durdurma isteği keser (`aiJobContext`, `runner.ts` `jobCancelSignal`); kapanış, kira kaybı ve süre aşımı kesmez.
   */
  signal?: AbortSignal;
};

/** İstekten bağlam. `?fresh=1` önbelleği atlar. Limitler kopyalanır: arka plan işi isteğin bitişinden etkilenmez. */
export function aiContext(req: FastifyRequest, kind: AiKind, ref?: AiCallContext['ref']): AiCallContext {
  return {
    companyId: req.auth.orgId,
    memberId: req.auth.membershipId ?? null,
    kind,
    limits: { ...(req.auth.subscription?.limits ?? {}) },
    ...(ref ? { ref } : {}),
    fresh: freshQuery(req),
    log: req.log,
    origin: 'request',
  };
}

/** `?fresh=1` (ya da `true`): önceki okumayı kullanma, yeniden oku. */
export function freshQuery(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return q.fresh === '1' || q.fresh === 'true';
}

/**
 * Arka plan işinin bağlamı (plan §4.7). Firma ve kişi satırın sütunlarından; limitler başlatma anının kopyası (`input.aiLimits`);
 * `fresh` işinde `cacheNotBefore = job.createdAt`: ilk ve sonraki denemeler aynı kuralla, işin kendi sonucu ücretsiz.
 */
export function aiJobContext(
  job: { companyId: string; createdById: string | null; createdAt: Date; input: Record<string, unknown> },
  kind: AiKind,
  ref?: AiCallContext['ref'],
  log?: MeterLog,
  /** KALANLAR 6.5: işin durdurma sinyali (`jobCancelSignal(ctx.signal)`); verilirse durdurma süren çağrıyı keser */
  signal?: AbortSignal,
): AiCallContext {
  const limits = job.input.aiLimits && typeof job.input.aiLimits === 'object' ? (job.input.aiLimits as Record<string, number | boolean>) : {};
  const fresh = job.input.fresh === true;
  return {
    companyId: job.companyId,
    memberId: job.createdById,
    kind,
    limits: { ...limits },
    ...(ref ? { ref } : {}),
    origin: 'job',
    fresh,
    ...(fresh ? { cacheNotBefore: job.createdAt } : {}),
    ...(log ? { log } : {}),
    ...(signal ? { signal } : {}),
  };
}

export type MeteredResult<T> = { data: T; usageId: string | null; cached: boolean; usage: AiUsage | null };

/** Sinyal çağrı seçeneği değil, bağlamdır (`AiCallContext.signal`): önbellek anahtarına ve tek uçuşa girmez. */
type CallOpts<T extends z.ZodType> = Omit<Parameters<typeof structuredCall<T>>[0], 'onUsage' | 'signal'>;
export type MeteredOpts<T extends z.ZodType> = CallOpts<T> & {
  /** sonuç firma içinde önbelleğe girer ve aynı girdide ücretsiz kullanılır */
  cache?: boolean;
  /**
   * Önbellek anahtarında `content` yerine kullanılır. Gönderilen içerik her seferinde farklı bayt üretiyorsa (pdf-lib ile
   * kesilmiş PDF tarihi taşır) kararlı bir karşılık verilir: kaynak dosyanın sha256'sı ve sayfa listesi.
   */
  cacheContent?: unknown;
};

/** Kota ve dakika sınırı hatası: `retryAfter` saniye, `registerAiErrorHeaders` başlığa yazar. */
export class AiLimitError extends AppError {
  constructor(
    message: string,
    public retryAfter: number,
  ) {
    super(429, 'TOO_MANY_REQUESTS', message, { retryAfter });
  }
}

/**
 * Hatırlanan (ücret doğmuş) hata: aynı içerik sağlayıcıya gitmeden aynı kodla döner; metin nedeni ve kaç dakika sonra yeniden
 * denenebileceğini söyler. `retryAfter` saniye (hatırlamanın kalan süresi), `details.retryAfter` ve başlıkta.
 */
export class AiRememberedError extends AppError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    public retryAfter: number,
  ) {
    super(statusCode, code, message, { retryAfter });
  }
}

/**
 * Rota eklentisinde `retry-after` başlığı (hata işleyicisi `AppError` başlığı taşımaz). `onError` kancası hata işleyicisinden
 * önce çalışır; kancayı ekleyen eklentinin rotalarına uygulanır. Sağlayıcının geçici hatası başlığı yalnız sağlayıcı bir süre
 * söylediyse taşır.
 */
export function registerAiErrorHeaders(app: FastifyInstance) {
  app.addHook('onError', async (_req, reply, err) => {
    if (err instanceof AiLimitError || err instanceof AiRememberedError) reply.header('retry-after', String(err.retryAfter));
    else if (err instanceof AiTransientError && err.retryAfter) reply.header('retry-after', String(err.retryAfter));
  });
}

// ---------------------------------------------------------------------------------------------
// Fiyat

const DATED_MODEL = /-\d{8}$/;

/**
 * Etkin fiyat (USD / 1M token). Tarih ekli ad (`…-20261001`) tablodaki kök adla eşleşir. Bilinmeyen: etkin tablonun (liste +
 * `AI_PRICE_TABLE` ezmesi) en pahalı fiyatı (contracts `mostExpensiveAiPrice`; inceleme 2026-11-13).
 */
export function priceFor(model: string): { price: AiPrice; known: boolean } {
  const table = env.aiPriceTable;
  const name = model.trim();
  const hit = Object.hasOwn(table, name) ? table[name] : Object.hasOwn(table, name.replace(DATED_MODEL, '')) ? table[name.replace(DATED_MODEL, '')] : undefined;
  return hit ? { price: hit, known: true } : { price: mostExpensiveAiPrice(table), known: false };
}

const warnedModels = new Set<string>();
function warnUnknown(model: string, log: MeterLog) {
  if (warnedModels.has(model)) return;
  warnedModels.add(model);
  log.warn({ model }, 'ai-meter-unknown-model: priced with the most expensive list price');
}

/**
 * Modelin fiyatı. Adı yoksa istenen modelinki. Adı var ama tabloda yoksa en pahalı fiyat (05-B13, SPEC §5.12): yanıtı veren
 * bilinmeyen model (ör. tabloya girmemiş daha pahalı yedek model) istenenin fiyatıyla eksik sayılmasın. İstenen de
 * bilinmiyorsa en pahalı fiyat.
 */
function effectivePrice(model: string | null, requested: string, log: MeterLog): AiPrice {
  if (model) {
    const p = priceFor(model);
    if (p.known) return p.price;
    warnUnknown(model, log);
    return p.price;
  }
  const r = priceFor(requested);
  if (r.known) return r.price;
  warnUnknown(requested, log);
  return r.price;
}

let warnedPriceTable: string | undefined;
function warnInvalidPriceTable(log: MeterLog) {
  const raw = process.env.AI_PRICE_TABLE ?? '';
  if (raw === warnedPriceTable) return;
  warnedPriceTable = raw;
  const { invalid } = parseAiPriceTable(raw);
  if (invalid.length) log.warn({ invalid }, 'AI_PRICE_TABLE: invalid entries ignored, list price applies');
}

/** Etkin fiyat tablosu + kurun kısa özeti. Geçmiş satır yeniden fiyatlanmaz; hangi fiyatla yazıldığı buradan bilinir. */
export function priceVersion(): string {
  const table = env.aiPriceTable;
  const sorted = Object.keys(table)
    .sort()
    .map((k) => [k, table[k]!.input, table[k]!.output, table[k]!.cacheWrite, table[k]!.cacheRead, ...(table[k]!.above ? [table[k]!.above] : [])]);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ t: sorted, r: env.aiPriceTryPerUsd })).digest('hex');
  return `r${env.aiPriceTryPerUsd}:${digest.slice(0, 12)}`;
}

const ZERO: AiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const tokensOf = (u: AiTokenUsage): AiTokenUsage => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheReadTokens: u.cacheReadTokens,
  cacheWriteTokens: u.cacheWriteTokens,
});
const addTokens = (a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/**
 * Sağlayıcı kullanımının ücreti (mikro TL). `iterations` varsa her kalem kendi modeliyle; kalemde model adı yoksa yanıtı veren
 * ve istenen modelden pahalı olanı. Token toplamı da kalemlerden. Kalem yoksa yanıtı veren modelle; o model istenenden farklıysa
 * iki fiyattan pahalı olanı. Tabloda olmayan model en pahalı fiyatı alır (05-B13).
 */
export function usageCost(u: AiCallUsage, requestedModel: string, tryPerUsd: number, log: MeterLog = consoleLog): { micros: number; tokens: AiTokenUsage } {
  if (u.iterations?.length) {
    let micros = 0;
    let tokens = ZERO;
    for (const it of u.iterations) {
      micros += it.model
        ? aiCostMicros(it, effectivePrice(it.model, requestedModel, log), tryPerUsd)
        : Math.max(aiCostMicros(it, effectivePrice(u.model, requestedModel, log), tryPerUsd), aiCostMicros(it, effectivePrice(requestedModel, requestedModel, log), tryPerUsd));
      tokens = addTokens(tokens, tokensOf(it));
    }
    return { micros, tokens };
  }
  const tokens = tokensOf(u);
  const served = aiCostMicros(tokens, effectivePrice(u.model, requestedModel, log), tryPerUsd);
  if (u.model === requestedModel) return { micros: served, tokens };
  return { micros: Math.max(served, aiCostMicros(tokens, effectivePrice(requestedModel, requestedModel, log), tryPerUsd)), tokens };
}

// ---------------------------------------------------------------------------------------------
// Dönem ve hak

/** Firmanın saat dilimi; kayıtlı değer geçersizse varsayılan (dönem hesabı hiçbir firmada patlamasın). */
export async function aiTimeZone(companyId: string): Promise<string> {
  const company = await withCompany(companyId, () => prisma.company.findFirst({ where: { id: companyId }, select: { settings: true } }));
  const tz = readSettings(company?.settings).timeZone;
  return typeof tz === 'string' && isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

/** Dönemin ilk anı ve bir sonraki dönemin ilk anı, firmanın saat diliminde. */
export function aiPeriodBounds(period: string, timeZone: string): { start: Date; resetsAt: Date } {
  return { start: zonedDayStart(`${period}-01`, timeZone), resetsAt: zonedDayStart(`${aiNextPeriod(period)}-01`, timeZone) };
}

/**
 * Planın aylık ücretsiz hakkı (mikro TL). `false` ya da `0`: ücretsiz hak yok. Sonlu, eksi olmayan sayı: o tutar. Diğerleri
 * (yok, `true`, metin, eksi, NaN): ortam varsayılanı.
 */
export function aiFreeMicros(limits: Record<string, unknown> | null | undefined): number {
  const v = limits?.[AI_LIMIT_CREDIT_MONTHLY];
  const tl = v === false ? 0 : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : env.aiFreeCreditMonthlyTry;
  return Math.round(tl * AI_MICROS_PER_UNIT);
}

const decimalMicros = (d: Prisma.Decimal | null | undefined) => (d ? Number(new Prisma.Decimal(d).mul(AI_MICROS_PER_UNIT).toFixed(0)) : 0);
export const microsToDecimal = (micros: number) => new Prisma.Decimal(micros).div(AI_MICROS_PER_UNIT);

/** Yüzde (tamsayı, aşağı yuvarlanır: %100 yalnız hak gerçekten dolunca). Hak sıfır ya da eksiyse 100. */
export function aiUsedPct(usedMicros: number, allowanceMicros: number): number {
  if (allowanceMicros <= 0) return 100;
  return Math.max(0, Math.floor((usedMicros * 100) / allowanceMicros));
}

/** Kotadan düşen satır durumu. Sonuç vermeyen çağrıyı da saymak istenirse burası `{ in: ['OK', 'FAILED'] }` olur. */
export const BILLABLE_STATUS = 'OK' as const;

export type AiAllowance = {
  period: string;
  timeZone: string;
  periodStart: Date;
  resetsAt: Date;
  freeMicros: number;
  creditMicros: number;
  /** yalnız `OK` satırları (kotadan düşen) */
  usedMicros: number;
  exhausted: boolean;
  /** sonuç vermeyen çağrıların (`FAILED`) gerçek maliyeti; kotadan düşmez, kendi tavanı var */
  failedMicros: number;
  /** `FAILED` tavanı = hak × `AI_FAILED_BUDGET_RATIO` */
  failedBudgetMicros: number;
  failedExhausted: boolean;
  enforced: boolean;
};

/**
 * Bir dönemin hakkı: ücretsiz hak (plan limiti ya da ortam) + o döneme yazılmış kredi (GRANT/ADJUST/PURCHASE, `period` eşit).
 * `period` null kredi (devreden bakiye) bugün yazılmaz ve sayılmaz. Kullanılan yalnız `OK` satırları: `FAILED` (sonuç vermeyen)
 * ve `CACHED` kotadan düşmez. Toplamlar SQL'de, yuvarlanmamış.
 */
export async function aiPeriodAllowance(companyId: string, period: string, limits: Record<string, unknown>, timeZone: string): Promise<AiAllowance> {
  const { used, failed, credit } = await withCompany(companyId, async () => ({
    used: await prisma.aiUsage.aggregate({ where: { companyId, period, status: BILLABLE_STATUS }, _sum: { cost: true } }),
    failed: await prisma.aiUsage.aggregate({ where: { companyId, period, status: 'FAILED' }, _sum: { cost: true } }),
    credit: await prisma.aiCreditEntry.aggregate({ where: { companyId, period }, _sum: { amount: true } }),
  }));
  const freeMicros = aiFreeMicros(limits);
  const creditMicros = decimalMicros(credit._sum.amount);
  const usedMicros = decimalMicros(used._sum.cost);
  const failedMicros = decimalMicros(failed._sum.cost);
  const failedBudgetMicros = Math.max(0, Math.round((freeMicros + creditMicros) * env.aiFailedBudgetRatio));
  const { start, resetsAt } = aiPeriodBounds(period, timeZone);
  return {
    period,
    timeZone,
    periodStart: start,
    resetsAt,
    freeMicros,
    creditMicros,
    usedMicros,
    exhausted: usedMicros >= freeMicros + creditMicros,
    failedMicros,
    failedBudgetMicros,
    // tavan 0 iken ilk başarısız çağrıdan sonra durur (hiç başarısız çağrı yokken değil)
    failedExhausted: failedMicros > 0 && failedMicros >= failedBudgetMicros,
    enforced: env.aiQuotaEnforced,
  };
}

/** Anın dönemi ve hakkı (firmanın saat diliminde). */
export async function aiAllowance(companyId: string, limits: Record<string, number | boolean>, at: Date = new Date()): Promise<AiAllowance> {
  const timeZone = await aiTimeZone(companyId);
  return aiPeriodAllowance(companyId, aiPeriodOf(at, timeZone), limits, timeZone);
}

function quotaExceeded(a: AiAllowance, reason?: 'failed_budget'): AppError {
  const date = new Intl.DateTimeFormat(currentLocale() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: a.timeZone }).format(a.resetsAt);
  // Ayrıntıda tutar yok: ölçüm rolü (fiyat izni yok) de bu hatayı görür.
  return new AppError(429, 'AI_QUOTA_EXCEEDED', m(reason ? 'err.aiFailedBudgetExceeded' : 'err.aiQuotaExceeded', { resetsAt: date }), {
    period: a.period,
    resetsAt: a.resetsAt.toISOString(),
    usedPct: aiUsedPct(a.usedMicros, a.freeMicros + a.creditMicros),
    ...(reason ? { reason } : {}),
  });
}

/**
 * Hak dolduysa 429 AI_QUOTA_EXCEEDED. Sonuç vermeyen çağrıların tavanı dolduysa da aynı kod, `details.reason: 'failed_budget'`
 * ve ayrı metin (kullanıcının `usedAmount`'u değişmez). `AI_QUOTA_ENFORCED=false` iken ikisi de durdurmaz. Hakkı döner.
 */
export async function assertAiQuota(ctx: AiCallContext, at: Date = new Date()): Promise<AiAllowance> {
  const a = await aiAllowance(ctx.companyId, ctx.limits, at);
  if (a.enforced && a.exhausted) throw quotaExceeded(a);
  if (a.enforced && a.failedExhausted) throw quotaExceeded(a, 'failed_budget');
  return a;
}

// ---------------------------------------------------------------------------------------------
// Dakika sınırı, eşzamanlılık, tek uçuş (süreç içi)

const RATE_WINDOW_MS = 60_000;
const rateHits = new Map<string, number[]>();

function rateLimitOf(kind: AiKind): { bucket: string; limit: number } {
  if (kind === 'SCALE_READ') return { bucket: 'scale', limit: env.aiRateScalePerMin };
  if (kind === 'INVOICE_PDF' || kind === 'TARIFF_PDF_DISCOVER' || kind === 'TARIFF_PDF_EXTRACT') return { bucket: 'pdf', limit: env.aiRatePdfPerMin };
  return { bucket: 'other', limit: env.aiRateOtherPerMin };
}

/** Kişi başı kayan pencere. Sınırdaysa bekleme süresi (sn), değilse null ve isabet sayılır. */
function takeRate(ctx: AiCallContext, now: number): number | null {
  if (!env.apiRateLimitEnabled) return null;
  const { bucket, limit } = rateLimitOf(ctx.kind);
  const key = `${bucket}:${ctx.companyId}:${ctx.memberId ?? '-'}`;
  const hits = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= limit) {
    rateHits.set(key, hits);
    return Math.max(1, Math.ceil((hits[0]! + RATE_WINDOW_MS - now) / 1000));
  }
  hits.push(now);
  rateHits.set(key, hits);
  if (rateHits.size > 5000) {
    for (const [k, v] of rateHits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(k);
  }
  return null;
}

/**
 * Kişi başı dakika sınırı (Mesaj 6), arka plan işi başlatılırken bir kez: sınırdaysa 429 TOO_MANY_REQUESTS (`retry-after`),
 * değilse isabet sayılır. İşin içindeki çağrı (`origin: 'job'`) sınırı yeniden saymaz.
 */
export function assertAiRate(ctx: AiCallContext, now: number = Date.now()): void {
  const wait = takeRate(ctx, now);
  if (wait != null) throw new AiLimitError(m('err.aiRateLimited'), wait);
}

/** `takeRate`'in `now` anında saydığı isabeti geri alır (sağlayıcıya gitmeyen ret: sistemin günlük tavanı). */
function refundAiRate(ctx: AiCallContext, now: number): void {
  if (!env.apiRateLimitEnabled) return;
  const { bucket } = rateLimitOf(ctx.kind);
  const hits = rateHits.get(`${bucket}:${ctx.companyId}:${ctx.memberId ?? '-'}`);
  const i = hits ? hits.lastIndexOf(now) : -1;
  if (hits && i >= 0) hits.splice(i, 1);
}

const slots = new Map<string, number>();
/** Tartı okuma kendi küçük yuva grubunda: uzun PDF işleri sürerken çalışanın tartı okuması beklemesin. */
export const AI_SCALE_CONCURRENCY_PER_ORG = 2;

function takeSlot(companyId: string, kind: AiKind): (() => void) | null {
  const scale = kind === 'SCALE_READ';
  const key = `${scale ? 'scale' : 'main'}:${companyId}`;
  const used = slots.get(key) ?? 0;
  if (used >= (scale ? AI_SCALE_CONCURRENCY_PER_ORG : env.aiConcurrencyPerOrg)) return null;
  slots.set(key, used + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (slots.get(key) ?? 1) - 1;
    if (left > 0) slots.set(key, left);
    else slots.delete(key);
  };
}

/**
 * Ücret doğmuş sonuçsuz çağrı aynı içerik için hatırlanır (süreç içi): aynı dosyayı yeniden göndermek yeniden ücret doğurmasın.
 * Hatırlanan: kesilme, ret ve toplam süre dolması (`AI_CALL_MAX_MS`; akış başlamış, sağlayıcı girdiyi işlemiştir; eldeki
 * kullanım görünmese de ücretli sayılır). Hatırlanmayan (05-B7): `AiTransientError` (aşırı yük, ulaşılamadı, bağlantı zaman
 * aşımı: yanıt hiç başlamadı, token yok), bozuk biçim, kota. Böylece arka plan işinin kendi yeniden denemesi kendi yazdığı
 * kayda takılmaz: hatırlanan hata işte kalıcıdır (iş `FAILED`), geçici hata hiç hatırlanmaz.
 * Anahtar firma + tür + içerik özetidir: istemin dili, model ve `?fresh=1` hatırlamayı atlatmaz (`fresh` yalnız başarılı sonuç
 * önbelleğini atlar). İçerik değişirse (tek bayt bile) yeni çağrı yapılır; buna karşı sonuç vermeyen çağrıların aylık tavanı var.
 */
export const AI_FAILURE_MEMORY_MS = 30 * 60_000;
const failures = new Map<string, { kind: 'truncated' | 'refused' | 'timeout'; at: number }>();

function failureKindOf(err: unknown): 'truncated' | 'refused' | 'timeout' | null {
  if (!(err instanceof AppError) || err instanceof AiTransientError) return null;
  if (err.code === 'AI_TRUNCATED') return 'truncated';
  if (err.code === 'AI_REFUSED') return 'refused';
  if (err.code === 'AI_FAILED' && err.statusCode === 504) return 'timeout';
  return null;
}

function rememberFailure(key: string, err: unknown, now: number) {
  const kind = failureKindOf(err);
  if (!kind) return;
  failures.set(key, { kind, at: now });
  if (failures.size > 5000) for (const [k, v] of failures) if (now - v.at >= AI_FAILURE_MEMORY_MS) failures.delete(k);
}

function rememberedFailure(key: string, now: number): AiRememberedError | null {
  const f = failures.get(key);
  if (!f) return null;
  const left = AI_FAILURE_MEMORY_MS - (now - f.at);
  if (left <= 0) {
    failures.delete(key);
    return null;
  }
  return rememberedError(f.kind, left);
}

/**
 * Hatırlanan hatanın metni. Kesilme ve ret: aynı içeriği yeniden göndermek yine ücretli olur ve büyük olasılıkla yine düşer;
 * metin yeniden denemeye çağırmaz, nedenin kendi önerisini (dosyayı bölün, başka dosya) tekrarlar. Süre dolması: kaç dakika
 * sonra yeniden denenebileceği. `retryAfter` (sn) her durumda hatırlamanın kalan süresi.
 */
function rememberedError(kind: 'truncated' | 'refused' | 'timeout', leftMs: number): AiRememberedError {
  const retryAfter = Math.max(1, Math.ceil(leftMs / 1000));
  if (kind === 'truncated') return new AiRememberedError(422, 'AI_TRUNCATED', m('ai.rememberedFinal', { reason: m('ai.truncated') }), retryAfter);
  if (kind === 'refused') return new AiRememberedError(422, 'AI_REFUSED', m('ai.rememberedFinal', { reason: m('ai.refused') }), retryAfter);
  return new AiRememberedError(504, 'AI_FAILED', m('ai.rememberedTimeout', { minutes: Math.max(1, Math.ceil(leftMs / 60_000)) }), retryAfter);
}

/** İş içi bakışın geriye payı: iş satırı veritabanı saatiyle, sayaç satırı uygulama saatiyle yazılır (küçük kayma). */
const JOB_FAILURE_LOOKBACK_SLACK_MS = 60_000;

/**
 * Bu iş içinde aynı içerik (aynı önbellek anahtarı) kesildi ya da reddedildiyse (ücretli `FAILED` satırı) yeniden
 * gönderilmez (inceleme B): süreç içi hatırlama başka kopyada, yeniden başlamadan sonra ya da 30 dakikayı aşan yeniden deneme
 * beklemesinde yoktur. Yalnız `origin: 'job'` ve çalışan işin bağlamında (`jobScope.ts`); satırlar işin oluşturulmasından
 * (eksi küçük pay) bu yana. Sorgu firmanın dönem dizinini (`companyId, period`) kullanır; yalnız sağlayıcıya gidilecekken.
 */
async function paidFailureInJob(ctx: AiCallContext, key: string, allowance: AiAllowance, log: MeterLog): Promise<AiRememberedError | null> {
  const job = ctx.origin === 'job' ? currentJobScope() : undefined;
  if (!job) return null;
  const since = new Date(job.createdAt.getTime() - JOB_FAILURE_LOOKBACK_SLACK_MS);
  const periods = [...new Set([aiPeriodOf(since, allowance.timeZone), allowance.period])];
  try {
    const row = await withCompany(ctx.companyId, () =>
      prisma.aiUsage.findFirst({
        where: { companyId: ctx.companyId, period: { in: periods }, kind: ctx.kind, status: 'FAILED', errorCode: { in: ['AI_TRUNCATED', 'AI_REFUSED'] }, cacheKey: key, createdAt: { gte: since } },
        select: { errorCode: true },
      }),
    );
    if (!row) return null;
    return rememberedError(row.errorCode === 'AI_REFUSED' ? 'refused' : 'truncated', AI_FAILURE_MEMORY_MS);
  } catch (err) {
    // okunamazsa çağrı yapılır (bugünkü davranış; en kötü ihtimalle bir kez daha ücretli deneme)
    log.warn({ err, kind: ctx.kind }, 'ai-meter-job-failure-read-failed');
    return null;
  }
}

/**
 * Sağlayıcının istek boyu sınırı (Messages API, 32 MB). Base64 belge 4/3 büyür: ~24 MB'tan büyük PDF tek istekte gidemez.
 * Sınırı aşan istek gönderilmez (05-B14): sağlayıcı 413 dönerdi, kullanıcı "yeniden deneyin" görürdü; denemek işe yaramaz.
 */
export const AI_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** İstemin, şemanın ve JSON çerçevesinin payı (içerikten ayrı, cömert). */
const AI_REQUEST_OVERHEAD_BYTES = 256 * 1024;

/** İsteğin yaklaşık boyu (bayt): base64 verisi (karakter = bayt) ve metinler; çerçeve payı ayrıca. */
export function aiRequestBytes(system: string, content: unknown): number {
  let n = Buffer.byteLength(system, 'utf8');
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    else if (typeof v === 'string') n += Buffer.byteLength(v, 'utf8');
  };
  walk(content);
  return n;
}

function requestTooLarge(content: unknown): AppError {
  const hasDocument = Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === 'document');
  return new AppError(413, 'FILE_TOO_LARGE', m(hasDocument ? 'ai.pdfTooLarge' : 'err.fileTooLarge'), {
    kind: 'aiRequest',
    limitMb: AI_MAX_REQUEST_BYTES / (1024 * 1024),
  });
}

/** Hatırlama anahtarı: firma + tür + içerik özeti (dil, model, istem ve şema dışarıda). */
function failureKeyOf(ctx: AiCallContext, content: unknown): string | null {
  try {
    return `${ctx.companyId}:${ctx.kind}:${sha256(JSON.stringify(hashBinary(content)))}`;
  } catch {
    return null;
  }
}

/**
 * Sayaç sigortası: sayaç yazımı sürekli düşerse ücretsiz sınırsız kullanım olmasın. Art arda `AI_METER_FUSE_FAILURES` yazım
 * hatasından sonra firmanın yeni sağlayıcı çağrıları `AI_METER_FUSE_MS` boyunca (ya da bir yazım başarılı olana kadar) reddedilir.
 */
export const AI_METER_FUSE_FAILURES = 3;
export const AI_METER_FUSE_MS = 5 * 60_000;
const writeFailures = new Map<string, { count: number; lastAt: number }>();

function meterWriteResult(companyId: string, ok: boolean, log: MeterLog) {
  if (ok) {
    writeFailures.delete(companyId);
    return;
  }
  const f = writeFailures.get(companyId) ?? { count: 0, lastAt: 0 };
  f.count += 1;
  f.lastAt = Date.now();
  writeFailures.set(companyId, f);
  if (f.count >= AI_METER_FUSE_FAILURES) log.error({ companyId, failures: f.count }, 'ai-meter-fuse-open: AI calls for this company are blocked until the meter can write again');
}

/** Sigorta açıksa kalan süre (ms), değilse 0. */
function fuseOpenMs(companyId: string, now: number): number {
  const f = writeFailures.get(companyId);
  if (!f || f.count < AI_METER_FUSE_FAILURES) return 0;
  return Math.max(0, AI_METER_FUSE_MS - (now - f.lastAt));
}

type Flight = { data: unknown; servedModel: string };
const flights = new Map<string, Promise<Flight>>();

/** Testler için: süreç içi sayaçları sıfırlar. */
export function resetAiMeterState() {
  rateHits.clear();
  slots.clear();
  flights.clear();
  failures.clear();
  writeFailures.clear();
  warnedModels.clear();
  warnedPriceTable = undefined;
  resetAiDailyBudgetState();
  resetAiQuotaNoticeState();
}

// ---------------------------------------------------------------------------------------------
// Önbellek

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** İçerikteki base64 verisi kendi sha256'sına çevrilir (dosyanın kendisi = anahtar; ad ve `File` kaydı fark etmez). */
function hashBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hashBinary);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.type === 'base64' && typeof o.data === 'string') return { ...o, data: `sha256:${sha256(Buffer.from(o.data, 'base64'))}` };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hashBinary(v)]));
  }
  return value;
}

function jsonSchemaOf(schema: unknown): unknown {
  return schema instanceof z.ZodType ? z.toJSONSchema(schema) : schema;
}

/**
 * sha256(JSON{ v, kind, model, system, schema (JSON şeması), maxTokens, effort, content }). Dil (`system`'deki İngilizce satırı),
 * model, istem ya da şema değişince anahtar kendiliğinden değişir.
 */
export function aiCacheKey(
  kind: AiKind,
  opts: { model: string; system: string; schema: unknown; maxTokens: number; effort: string; content: unknown },
): string {
  return sha256(
    JSON.stringify({
      v: 1,
      kind,
      model: opts.model,
      system: opts.system,
      schema: jsonSchemaOf(opts.schema),
      maxTokens: opts.maxTokens,
      effort: opts.effort,
      content: hashBinary(opts.content),
    }),
  );
}

async function readCache<T extends z.ZodType>(ctx: AiCallContext, key: string, schema: T, now: Date, log: MeterLog): Promise<{ data: z.infer<T>; model: string } | null> {
  try {
    const row = await withCompany(ctx.companyId, () =>
      prisma.aiResultCache.findFirst({
        where: {
          companyId: ctx.companyId,
          kind: ctx.kind,
          cacheKey: key,
          expiresAt: { gt: now },
          // "yeniden oku" işi: yalnız işin başlamasından sonra yazılmış (bu işin kendi) sonucu
          ...(ctx.cacheNotBefore ? { createdAt: { gte: ctx.cacheNotBefore } } : {}),
        },
        select: { result: true, model: true },
      }),
    );
    if (!row) return null;
    const parsed = schema.safeParse(row.result);
    return parsed.success ? { data: parsed.data, model: row.model } : null;
  } catch (err) {
    log.warn({ err, kind: ctx.kind }, 'ai-meter-cache-read-failed');
    return null;
  }
}

type CacheEntry = { key: string; data: unknown; model: string };

/**
 * Önbellek satırı, sayaç satırıyla aynı işlemde (`recordUsage`). `createdAt` veritabanı saatiyle (Mesaj 7): `cacheNotBefore`
 * işin `createdAt`'iyle (o da veritabanı saati) karşılaştırılır; sunucu ile veritabanı saati kaysa bile işin kendi yazdığı
 * sonuç yeniden denemede bulunur. Aynı anahtar iki kez yazılırsa (iki örnek) sonuncusu kalır (`ON CONFLICT`).
 */
async function upsertCache(tx: Prisma.TransactionClient, ctx: AiCallContext, c: CacheEntry, usageId: string) {
  const expiresAt = new Date(Date.now() + env.aiCacheTtlDays * 86_400_000);
  const result = JSON.stringify(c.data);
  await tx.$executeRaw`
    INSERT INTO "AiResultCache" ("id", "companyId", "kind", "cacheKey", "model", "result", "usageId", "createdAt", "expiresAt")
    VALUES (${crypto.randomUUID()}, ${ctx.companyId}, ${ctx.kind}::"AiKind", ${c.key}, ${c.model}, ${result}::jsonb, ${usageId}, (now() AT TIME ZONE 'UTC'), ${expiresAt})
    ON CONFLICT ("companyId", "kind", "cacheKey") DO UPDATE SET
      "model" = EXCLUDED."model", "result" = EXCLUDED."result", "usageId" = EXCLUDED."usageId",
      "createdAt" = EXCLUDED."createdAt", "expiresAt" = EXCLUDED."expiresAt"`;
}

// ---------------------------------------------------------------------------------------------
// Sayaç satırı

type UsageRow = {
  status: 'OK' | 'CACHED' | 'FAILED';
  errorCode?: string | null;
  period: string;
  servedModel: string | null;
  tokens: AiTokenUsage;
  micros: number;
  durationMs: number;
  cacheKey: string | null;
  /** Y60: çıktı tokeni akan metinden tahmin edildi (alt sınır). Satır aynen sayılır, yalnız işaretlenir. */
  estimated?: boolean;
};

/**
 * Satırı yazar; `cache` verilirse sonuç önbelleği AYNI veritabanı işleminde (Mesaj 7, R0 2a): ücretli `OK` satırı ile önbellek
 * ya birlikte yazılır ya hiçbiri. Yoksa bağlantı tam araya düştüğünde sayaç yazılmış, önbellek boş kalır; işin yeniden
 * denemesi sağlayıcıyı yeniden çağırır ve firmaya ikinci `OK` yazılırdı. Yazılamazsa null döner ve günlüğe yazar (çağrının
 * sonucu atılmaz; Mesaj 6 kuralı 11). Üye yerelde yoksa üyesiz yazılır.
 */
async function recordUsage(ctx: AiCallContext, row: UsageRow, log: MeterLog, cache?: CacheEntry): Promise<string | null> {
  const data = (memberId: string | null) => ({
    companyId: ctx.companyId,
    memberId,
    kind: ctx.kind,
    status: row.status,
    errorCode: row.errorCode ?? null,
    period: row.period,
    model: env.claudeModel,
    servedModel: row.servedModel,
    inputTokens: row.tokens.inputTokens,
    outputTokens: row.tokens.outputTokens,
    cacheReadTokens: row.tokens.cacheReadTokens,
    cacheWriteTokens: row.tokens.cacheWriteTokens,
    cost: microsToDecimal(row.micros),
    currency: AI_CURRENCY,
    priceVersion: priceVersion(),
    durationMs: Math.max(0, Math.round(row.durationMs)),
    estimated: row.estimated === true,
    cacheKey: row.cacheKey,
    refType: ctx.ref?.type ?? null,
    refId: ctx.ref?.id ?? null,
  });
  const write = (memberId: string | null) =>
    withCompany(ctx.companyId, () =>
      prisma.$transaction(async (tx) => {
        const created = await tx.aiUsage.create({ data: data(memberId), select: { id: true } });
        if (cache) await upsertCache(tx, ctx, cache, created.id);
        return created;
      }),
    );
  try {
    let id: string;
    try {
      id = (await write(ctx.memberId)).id;
    } catch (err) {
      if (!(ctx.memberId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003')) throw err;
      id = (await write(null)).id;
    }
    meterWriteResult(ctx.companyId, true, log);
    return id;
  } catch (err) {
    log.error({ err, companyId: ctx.companyId, kind: ctx.kind, status: row.status, micros: row.micros, tokens: row.tokens }, 'ai-meter-write-failed');
    meterWriteResult(ctx.companyId, false, log);
    return null;
  }
}

const summary = (u: AiCallUsage | null, tokens: AiTokenUsage): AiUsage | null =>
  u ? { model: u.model, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens } : null;

// ---------------------------------------------------------------------------------------------
// Çağrı

async function cachedResult<T>(ctx: AiCallContext, data: T, servedModel: string, key: string, at: Date, log: MeterLog): Promise<MeteredResult<T>> {
  let usageId: string | null = null;
  try {
    const period = aiPeriodOf(at, await aiTimeZone(ctx.companyId));
    usageId = await recordUsage(ctx, { status: 'CACHED', period, servedModel, tokens: ZERO, micros: 0, durationMs: 0, cacheKey: key }, log);
  } catch (err) {
    log.error({ err, companyId: ctx.companyId, kind: ctx.kind, status: 'CACHED' }, 'ai-meter-write-failed');
    meterWriteResult(ctx.companyId, false, log);
  }
  return { data, usageId, cached: true, usage: null };
}

type ProviderResult<T extends z.ZodType> = { data: z.infer<T>; usageId: string | null; usage: AiUsage | null; servedModel: string };

/** Üst sınır hesabında girdi tokeninin tavanı (modelin bağlam penceresi; istek boyundan tahmin bunu aşamaz). */
export const AI_UPPER_INPUT_TOKENS_CAP = 200_000;
/** İstek boyunun (bayt) token karşılığı en çok bayt / 2 (kötü durum; olağan metin 3-4 bayt/token) + çerçeve payı. */
const AI_UPPER_BYTES_PER_TOKEN = 2;
const AI_UPPER_OVERHEAD_TOKENS = 1000;

/**
 * Çağrının olabilecek en yüksek tutarı (mikro TL), günlük tavanın ayırdığı pay: `maxTokens` × çıktı fiyatı + tahmini girdi
 * (istek boyu: istem, içerik, base64 belge, JSON şeması; bayt / 2 + 1.000, en çok `AI_UPPER_INPUT_TOKENS_CAP`) × girdi ya da
 * önbelleğe yazma fiyatından büyüğü. Fiyat istenen modelin (`usageCost` istenenden ucuzunu yazmaz); bilinmeyen model en pahalı.
 * Sağlayıcının istenenden pahalı yedek modele düşmesi bu sınırın dışındadır.
 */
export function aiCallUpperMicros(call: { system: string; content: unknown; schema: unknown; maxTokens: number }): number {
  const price = priceFor(env.claudeModel).price;
  const inputTokens = upperInputTokens(call);
  const outputTokens = Number.isFinite(call.maxTokens) && call.maxTokens > 0 ? call.maxTokens : 0;
  return aiCostMicros({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, { ...price, input: Math.max(price.input, price.cacheWrite) }, env.aiPriceTryPerUsd);
}

/** İsteğin girdi tokeninin üst tahmini (istem, içerik, base64 belge, JSON şeması; bayt / 2 + 1.000, en çok `AI_UPPER_INPUT_TOKENS_CAP`). */
function upperInputTokens(call: { system: string; content: unknown; schema: unknown }): number {
  let schemaBytes = 0;
  try {
    schemaBytes = Buffer.byteLength(JSON.stringify(jsonSchemaOf(call.schema)) ?? '', 'utf8');
  } catch {
    schemaBytes = 0;
  }
  const bytes = aiRequestBytes(call.system, call.content) + schemaBytes;
  return Math.min(AI_UPPER_INPUT_TOKENS_CAP, Math.ceil(bytes / AI_UPPER_BYTES_PER_TOKEN) + AI_UPPER_OVERHEAD_TOKENS);
}

/**
 * KALANLAR 6.5: kesilen çağrıda çıktı tokeninin tahmini için saniyede üretilen token (görünmeyen düşünme dahil; gerçekçi
 * üretim hızı, ince ayar). Kesilen akışın son sayısı (`message_delta`) hiç gelmez. Geçen süre girdinin işlenmesini de
 * kapsadığı için tahmin yine yukarı yuvarlanmış kalır. Sistemin günlük tavanı çağrı sürerken zaten üst sınır kadar pay
 * ayırmıştı (`aiCallUpperMicros`); çağrı bitince ona da bu tutar yazılır (tek tahmin).
 */
export const AI_CANCEL_OUTPUT_TOKENS_PER_SEC = 110;

/**
 * KALANLAR 6.5: kullanıcının vazgeçmesiyle kesilen çağrının sayaca yazılan kullanımı. Sağlayıcı kesilen isteğin son sayısını
 * bildirmez; bilinmeyen kısım FAZLA sayılır (güvenli yön: satır `FAILED`, firmanın kotasından düşmez; sonuç vermeyen çağrı
 * tavanı ve sistemin günlük tavanı erken dolar, zararımız eksik görünmez). Satır `estimated` işaretlidir.
 * - Girdi: sağlayıcının `message_start` sayısı (önbellek okuma ve yazma dahil) geldiyse o; gelmediyse istek boyundan üst tahmin.
 * - Çıktı: bilinen sayı, akan metinden tahmin ve geçen süre × `AI_CANCEL_OUTPUT_TOKENS_PER_SEC` içinden en büyüğü; en az 1,
 *   en çok `maxTokens`.
 * - Fiyat: yanıtı veren model biliniyorsa o (istenenden ucuzsa istenenin fiyatı, `usageCost`); kalemler (`iterations`) yok sayılır.
 * İstek sağlayıcıya hiç gitmediyse (`sent: false`) bilinen kullanım aynen (genelde yok).
 */
export function cancelledUsage(
  call: { system: string; content: unknown; schema: unknown; maxTokens: number },
  known: AiCallUsage | null,
  elapsedMs: number,
  sent: boolean,
): AiCallUsage | null {
  if (!sent) return known;
  const max = Number.isFinite(call.maxTokens) && call.maxTokens > 0 ? Math.floor(call.maxTokens) : Number.MAX_SAFE_INTEGER;
  const knownInput = known ? known.inputTokens + known.cacheReadTokens + known.cacheWriteTokens : 0;
  const byTime = Math.ceil((Math.max(0, elapsedMs) / 1000) * AI_CANCEL_OUTPUT_TOKENS_PER_SEC);
  const outputTokens = Math.min(max, Math.max(1, known?.outputTokens ?? 0, byTime));
  return {
    model: known?.model ?? env.claudeModel,
    inputTokens: knownInput > 0 ? known!.inputTokens : upperInputTokens(call),
    outputTokens,
    cacheReadTokens: knownInput > 0 ? known!.cacheReadTokens : 0,
    cacheWriteTokens: knownInput > 0 ? known!.cacheWriteTokens : 0,
    iterations: null,
    estimated: true,
  };
}

/**
 * Sistemin günlük tavanı (`aiDailyBudget.ts`) firma kotasından önce: doluysa 429 `AI_DAILY_BUDGET`, sağlayıcı çağrılmaz, satır
 * yazılmaz. Süren çağrıların payı yüzünden doluysa geçici 503 `AI_BUSY`. Tek uçuşun içinde: aynı girdiyi bekleyen ikinci
 * istek aynı sonucu alır. Ayrılan pay (çağrının üst sınırı) çağrı bitince bırakılır, gerçek tutar sayaca eklenir.
 */
async function callProvider<T extends z.ZodType>(
  ctx: AiCallContext,
  call: CallOpts<T>,
  key: string | null,
  cacheable: boolean,
  failureKey: string | null,
  startedAt: Date,
  log: MeterLog,
): Promise<ProviderResult<T>> {
  let budget: AiBudgetTicket;
  try {
    budget = await takeAiDailyBudget(ctx.origin, log, aiCallUpperMicros(call));
  } catch (err) {
    if (!(err instanceof AiBudgetBusy)) throw err;
    // ücret yok, sağlayıcı çağrılmadı; arka plan işi geçici hata gibi bekleyip yeniden dener
    throw Object.assign(new AiTransientError(503, 'AI_BUSY', m('ai.keyInvalid'), AI_DAILY_BUDGET_BUSY_RETRY_S), { aiBudget: true });
  }
  try {
    return await callAdmitted(ctx, call, key, cacheable, failureKey, startedAt, log, budget);
  } finally {
    budget.release();
  }
}

async function callAdmitted<T extends z.ZodType>(
  ctx: AiCallContext,
  call: CallOpts<T>,
  key: string | null,
  cacheable: boolean,
  failureKey: string | null,
  startedAt: Date,
  log: MeterLog,
  budget: AiBudgetTicket,
): Promise<ProviderResult<T>> {
  const allowance = await assertAiQuota(ctx, startedAt);
  if (key) {
    const paid = await paidFailureInJob(ctx, key, allowance, log);
    if (paid) throw paid;
  }
  const release = takeSlot(ctx.companyId, ctx.kind);
  if (!release) throw new AiLimitError(m('err.busy'), 3);
  const requested = env.claudeModel;
  const rate = env.aiPriceTryPerUsd;
  let usage: AiCallUsage | null = null;
  const t0 = performance.now();
  const priced = () => (usage ? usageCost(usage, requested, rate, log) : { micros: 0, tokens: ZERO });
  // `OK` satırı yazıldıktan sonra bir hata olursa ikinci (`FAILED`) satır yazılmaz.
  let recorded = false;
  try {
    const data = await structuredCall({ ...call, ...(ctx.signal ? { signal: ctx.signal } : {}), onUsage: (u) => (usage = u) });
    const { micros, tokens } = priced();
    const servedModel = (usage as AiCallUsage | null)?.model ?? requested;
    // ücretli satır ve önbellek tek işlemde (R0 2a): yeniden deneme ya önbellekten alır ya da hiç ücret yazılmamıştır
    const usageId = await recordUsage(
      ctx,
      {
        status: 'OK',
        period: allowance.period,
        servedModel,
        tokens,
        micros,
        durationMs: performance.now() - t0,
        cacheKey: key,
        // tam yanıtta sağlayıcının sayısı kullanılır; işaret yalnız yarım akışta gelir (savunma için yine aktarılır)
        estimated: (usage as AiCallUsage | null)?.estimated === true,
      },
      log,
      key && cacheable ? { key, data, model: servedModel } : undefined,
    );
    budget.spend(micros);
    recorded = true;
    // KALANLAR 6.5: hakkın %80'i geçildiyse ayar yetkililerine bir kez posta (arkada; sonucu beklemez, hatası çağrıyı düşürmez)
    if (usageId) quotaNoticeAfter(ctx, allowance, micros, log);
    return { data, usageId, usage: summary(usage, tokens), servedModel };
  } catch (err) {
    if (recorded) throw err;
    // KALANLAR 6.5: vazgeçme istek sağlayıcıya gitmeden geldi: ücret yok, satır yok
    if (err instanceof AiCancelledError && !err.sent) throw err;
    // Gerçek token ve maliyetle yazılır (zararımız görünsün) ama `FAILED` kotadan düşmez. Ret, kesilme ve bozuk biçim yanıtın
    // kullanımını taşır; kopma ve süre dolmasında eldeki son görüntünün kullanımı (alt sınır); hiç yanıt yoksa 0.
    // KALANLAR 6.5: vazgeçilen çağrıda bilinmeyen kısım fazla sayılır (`cancelledUsage`, üst tahmin).
    if (err instanceof AiCancelledError) usage = cancelledUsage(call, usage, performance.now() - t0, err.sent);
    const { micros, tokens } = priced();
    const code = err instanceof AppError ? err.code : 'AI_FAILED';
    const estimated = (usage as AiCallUsage | null)?.estimated === true;
    await recordUsage(
      ctx,
      { status: 'FAILED', errorCode: code, period: allowance.period, servedModel: (usage as AiCallUsage | null)?.model ?? null, tokens, micros, durationMs: performance.now() - t0, cacheKey: key, estimated },
      log,
    );
    budget.spend(micros);
    if (estimated) {
      log.warn(
        { companyId: ctx.companyId, kind: ctx.kind, code, tokens },
        err instanceof AiCancelledError
          ? 'ai-meter-usage-estimated: call cancelled by the user; unknown usage counted with an upper estimate'
          : 'ai-meter-usage-estimated: output tokens estimated from streamed text (lower bound)',
      );
    }
    if (err instanceof AiKeyInvalidError) log.error({ companyId: ctx.companyId, kind: ctx.kind }, 'ai-key-invalid: the provider rejected ANTHROPIC_API_KEY (401); every AI call fails until the key is replaced');
    // Ücret doğmuş geçici hata (akış başlayıp koptu): arka plan işi bunu kendiliğinden yeniden denemesin, ikinci ücret olurdu.
    // Aynı kod ve metin, ama kalıcı: iş FAILED olur, kullanıcı yeniden başlatır.
    const final = err instanceof AiTransientError && (micros > 0 || tokens.inputTokens + tokens.outputTokens > 0) ? new AppError(err.statusCode, err.code, err.message, err.details) : err;
    if (failureKey) rememberFailure(failureKey, final, Date.now());
    throw final;
  } finally {
    release();
  }
}

/**
 * KALANLAR 6.5: ücretli `OK` satırından sonra hak %`AI_QUOTA_NOTICE_PCT`'e ulaştıysa posta (`aiQuotaNotice.ts`). Yalnız hak
 * uygulanıyorsa (`AI_QUOTA_ENFORCED`) ve hak sıfırdan büyükse. Kullanılan = çağrı öncesi okunan + bu çağrı: eşzamanlı çağrılar
 * eşiği birlikte geçerse en geç bir sonraki çağrı görür.
 */
function quotaNoticeAfter(ctx: AiCallContext, allowance: AiAllowance, micros: number, log: MeterLog): void {
  const total = allowance.freeMicros + allowance.creditMicros;
  if (!allowance.enforced || total <= 0) return;
  const pct = aiUsedPct(allowance.usedMicros + micros, total);
  if (pct < AI_QUOTA_NOTICE_PCT) return;
  noticeAiQuota({ companyId: ctx.companyId, period: allowance.period, pct, resetsDay: `${aiNextPeriod(allowance.period)}-01`, timeZone: allowance.timeZone, log });
}

/** Sayaçlı yapay zekâ çağrısı. Sıra dosya başındaki açıklamada. */
export async function meteredCall<T extends z.ZodType>(ctx: AiCallContext, opts: MeteredOpts<T>): Promise<MeteredResult<z.infer<T>>> {
  if (!aiEnabled()) throw aiDisabled();
  // KALANLAR 6.5: vazgeçilmiş çağrı hiç başlamaz (sağlayıcı yok, satır yok, dakika hakkından düşmez)
  if (ctx.signal?.aborted) throw new AiCancelledError(false);
  const log = ctx.log ?? consoleLog;
  warnInvalidPriceTable(log);
  const startedAt = new Date();
  // Arka plan işinde dakika sınırı başlatmada sayıldı (`assertAiRate`); yeniden denemede ve iş içinde yeniden sayılmaz.
  if (ctx.origin !== 'job') assertAiRate(ctx, startedAt.getTime());
  try {
    return await meteredAfterRate(ctx, opts, startedAt, log);
  } catch (err) {
    // Sistemin günlük tavanı reddettiyse (sağlayıcı çağrılmadı) kişinin dakika hakkından düşmez.
    if (ctx.origin !== 'job' && isAiDailyBudgetError(err)) refundAiRate(ctx, startedAt.getTime());
    throw err;
  }
}

async function meteredAfterRate<T extends z.ZodType>(ctx: AiCallContext, opts: MeteredOpts<T>, startedAt: Date, log: MeterLog): Promise<MeteredResult<z.infer<T>>> {
  const { cache = false, cacheContent, ...call } = opts;
  // Anahtar her türde hesaplanır (kesilme/ret hatırlaması için); önbellek yalnız `cache` türlerinde okunur ve yazılır.
  let key: string | null = null;
  {
    try {
      key = aiCacheKey(ctx.kind, {
        model: env.claudeModel,
        system: call.system,
        schema: call.schema,
        maxTokens: call.maxTokens,
        effort: call.effort,
        content: cacheContent ?? (call.content as Anthropic.Beta.BetaContentBlockParam[]),
      });
    } catch (err) {
      log.warn({ err, kind: ctx.kind }, 'ai-meter-cache-key-failed');
    }
  }

  // `fresh` önbelleği atlar; `cacheNotBefore` varsa (yeniden okuma işi) yalnız ondan eski kayıtlar atlanır.
  if (key && cache && (!ctx.fresh || ctx.cacheNotBefore)) {
    const hit = await readCache(ctx, key, call.schema, startedAt, log);
    if (hit) return cachedResult(ctx, hit.data, hit.model, key, startedAt, log);
  }
  // Hatırlanan kesilme / ret / toplam süre dolması (ücretli): `fresh` de atlatmaz. Geçici hata hatırlanmaz.
  const failureKey = failureKeyOf(ctx, cacheContent ?? call.content);
  if (failureKey) {
    const remembered = rememberedFailure(failureKey, Date.now());
    if (remembered) throw remembered;
  }

  // Tek uçuş: önbellek bakışından sonra araya `await` girmeden kayıt (aynı anda gelen ikinci istek ilkini bulur).
  const flightKey = key && cache ? `${ctx.companyId}:${ctx.kind}:${key}` : null;
  const running = flightKey ? flights.get(flightKey) : undefined;
  if (running) {
    let shared: Flight;
    try {
      shared = await running;
    } catch (err) {
      // KALANLAR 6.5: süren çağrıyı başlatan vazgeçti; bekleyen vazgeçmediyse kendisi çağırır (uçuş kaydı bu arada silindi)
      if (err instanceof AiCancelledError && !ctx.signal?.aborted) return meteredAfterRate(ctx, opts, startedAt, log);
      throw err;
    }
    return cachedResult(ctx, shared.data as z.infer<T>, shared.servedModel, key!, startedAt, log);
  }
  // 05-B14: sağlayıcının istek sınırını aşan istek gönderilmez (önbellek ve hatırlama yukarıda: onlar ücretsiz).
  if (aiRequestBytes(call.system, call.content) + AI_REQUEST_OVERHEAD_BYTES > AI_MAX_REQUEST_BYTES) throw requestTooLarge(call.content);
  const fuseMs = fuseOpenMs(ctx.companyId, Date.now());
  if (fuseMs > 0) {
    log.error({ companyId: ctx.companyId, kind: ctx.kind }, 'ai-meter-fuse-open: call rejected');
    // `ai.keyInvalid`: "Yapay zekâ şu an kullanılamıyor; biraz sonra yeniden deneyin" (teknik ayrıntı yok). Geçici: sağlayıcı
    // çağrılmadı, ücret yok; arka plan işi sigorta kapanınca (en geç `retryAfter`) yeniden dener.
    throw new AiTransientError(503, 'AI_BUSY', m('ai.keyInvalid'), Math.ceil(fuseMs / 1000));
  }
  const work = callProvider(ctx, call, key, cache, failureKey, startedAt, log);
  if (flightKey) {
    flights.set(flightKey, work);
    const done = () => {
      if (flights.get(flightKey) === work) flights.delete(flightKey);
    };
    work.then(done, done);
  }
  const r = await work;
  return { data: r.data, usageId: r.usageId, cached: false, usage: r.usage };
}
