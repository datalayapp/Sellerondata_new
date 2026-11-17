/**
 * Mesaj 6 P1: yapay zekâ sayacı, kota, önbellek, destek komutları. Sağlayıcı sahtedir (gerçek çağrı yok).
 * Para kuralları kuruşu kuruşuna (mikro TL) sabitlenir.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AI_LIST_PRICES_USD, AI_UNKNOWN_MODEL_PRICE, aiCostMicros, aiMicrosToAmount, aiPeriodOf } from '@sellerondata/contracts';
import { grantCredit, runAiUsageCli, usageReport } from '../src/cli/aiUsage.ts';
import { prisma, withSupportScope } from '../src/db.ts';
import { env } from '../src/env.ts';
import {
  aiAllowance,
  aiCacheKey,
  aiFreeMicros,
  aiJobContext,
  aiUsedPct,
  assertAiRate,
  meteredCall,
  priceFor,
  resetAiMeterState,
  usageCost,
  type AiCallContext,
  type AiKind,
  type MeterLog,
} from '../src/services/aiMeter.ts';
import { buildAiUsage } from '../src/services/hub/aiUsage.ts';
import { translator } from '../src/services/hub/i18n.ts';
import { runMaintenance } from '../src/services/maintenance.ts';
import { createMember, createWorker, findMoneyKeys, getApp, inCompany, JPEG, multipart, registerCompany } from './helpers.ts';
import { setFxService } from '../src/services/fx.ts';
import { anyDayFx } from './fxFake.ts';

// Y9: bakım işi (`runMaintenance`) bütün firmalarda bekleyen ölçüm karşılaştırmasını tamamlar; önceki test dosyalarından
// kalan dövizli faturalar (USD tarife, 15.10.2026) kur ister. Gerçek TCMB'ye gidilmesin diye her güne yanıt veren sahte kur.
beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

/** `partial`: akış koptuğunda SDK'nın elindeki yarım mesaj (`stream.currentMessage`); `error` ile birlikte verilir. */
type FakeReply = {
  model?: string;
  stop_reason?: string;
  usage?: Record<string, unknown> | null;
  text?: string;
  error?: unknown;
  delayMs?: number;
  partial?: { text: string; usage: Record<string, unknown> };
};
const calls: Record<string, unknown>[] = [];
const replies: FakeReply[] = [];
let defaultReply: FakeReply = {};

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          calls.push(params);
          const r = replies.shift() ?? defaultReply;
          return {
            currentMessage: r.partial
              ? { model: r.model ?? 'claude-sonnet-5-5', usage: r.partial.usage, content: [{ type: 'text', text: r.partial.text }] }
              : undefined,
            finalMessage: async () => {
              if (r.delayMs) {
                await new Promise<void>((res, rej) => {
                  const t = setTimeout(res, r.delayMs);
                  opts?.signal?.addEventListener('abort', () => {
                    clearTimeout(t);
                    rej(new actual.APIUserAbortError());
                  });
                });
              }
              if (r.error) throw r.error;
              return {
                model: r.model ?? 'claude-sonnet-5-5',
                stop_reason: r.stop_reason ?? 'end_turn',
                usage: r.usage === null ? undefined : (r.usage ?? { input_tokens: 1000, output_tokens: 1000 }),
                content: [{ type: 'text', text: r.text ?? JSON.stringify({ value: 'ok' }) }],
              };
            },
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const schema = z.object({ value: z.string() });
const API = '/api/deciship';
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_MODEL',
  'AI_QUOTA_ENFORCED',
  'AI_FREE_CREDIT_MONTHLY_TRY',
  'AI_PRICE_TRY_PER_USD',
  'AI_PRICE_TABLE',
  'AI_CONCURRENCY_PER_ORG',
  'AI_FAILED_BUDGET_RATIO',
  'AI_RATE_SCALE_PER_MIN',
  'AI_RATE_OTHER_PER_MIN',
  'API_RATE_LIMIT',
  'AI_CACHE_TTL_DAYS',
];
const saved: Record<string, string | undefined> = {};

let app: FastifyInstance;
let A: Awaited<ReturnType<typeof registerCompany>>;
let B: Awaited<ReturnType<typeof registerCompany>>;

const silent: MeterLog = { warn: () => undefined, error: () => undefined };
const ctxOf = (who: { companyId: string; userId: string }, kind: AiKind = 'INVOICE_MAPPING', over: Partial<AiCallContext> = {}): AiCallContext => ({
  companyId: who.companyId,
  memberId: who.userId,
  kind,
  limits: {},
  log: silent,
  ...over,
});
const text = (t: string) => [{ type: 'text' as const, text: t }];
const call = (ctx: AiCallContext, content = 'girdi', cache = true) =>
  meteredCall(ctx, { schema, system: 'sys', maxTokens: 100, effort: 'low', content: text(content), cache });
const usageRows = (companyId: string) => inCompany(companyId, () => prisma.aiUsage.findMany({ where: { companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
const clearCompany = (companyId: string) =>
  inCompany(companyId, async () => {
    await prisma.aiUsage.deleteMany({});
    await prisma.aiResultCache.deleteMany({});
    await prisma.aiCreditEntry.deleteMany({});
  });

beforeAll(async () => {
  app = await getApp();
  A = await registerCompany(app, 'Sayaç A');
  B = await registerCompany(app, 'Sayaç B');
});

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  calls.length = 0;
  replies.length = 0;
  defaultReply = {};
  resetAiMeterState();
  await clearCompany(A.companyId);
  await clearCompany(B.companyId);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => {
  resetAiMeterState();
});

describe('ücret çevrimi (mikro TL)', () => {
  it('Sonnet 5.5, 1.000 girdi + 1.000 çıktı, kur 100 = 1,20 TL; önbellek tokenleri kendi fiyatıyla', () => {
    const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
    expect(aiCostMicros({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 100)).toBe(1_200_000);
    // 1M önbelleğe yazma = 250 TL, 1M önbellekten okuma = 10 TL (05-B13: resmî fiyat 0,10 $)
    expect(aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, sonnet, 100)).toBe(260_000_000);
    // tek token: 200 mikro TL girdi, 1.000 mikro TL çıktı
    expect(aiCostMicros({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 100)).toBe(1_200);
    // eksi / NaN token 0 sayılır; kur bozuksa ücret sessizce 0 olmaz
    expect(aiCostMicros({ inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 100)).toBe(0);
    expect(() => aiCostMicros({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 0)).toThrow(RangeError);
    expect(aiMicrosToAmount(1_234_999)).toBe(1.23);
    expect(aiMicrosToAmount(1_235_000)).toBe(1.24);
  });

  it('bilinmeyen model en pahalı fiyattan; tarih ekli ad kök adla eşleşir', () => {
    expect(priceFor('claude-sonnet-5-5')).toEqual({ price: AI_LIST_PRICES_USD['claude-sonnet-5-5'], known: true });
    expect(priceFor('claude-sonnet-5-5-20261001')).toEqual({ price: AI_LIST_PRICES_USD['claude-sonnet-5-5'], known: true });
    expect(priceFor('claude-mystery-9')).toEqual({ price: AI_UNKNOWN_MODEL_PRICE, known: false });
    expect(priceFor('constructor')).toEqual({ price: AI_UNKNOWN_MODEL_PRICE, known: false });
  });

  it('yedek model: iterations varsa her kalem kendi modeliyle; yoksa ve model farklıysa pahalı olan', () => {
    const t = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Opus 5.5 reddetti (100+10), Sonnet 5.5 yanıtladı (1000+1000)
    const it1 = usageCost(
      { model: 'claude-sonnet-5-5', ...t(1100, 1010), iterations: [{ model: 'claude-opus-5-5', ...t(100, 10) }, { model: 'claude-sonnet-5-5', ...t(1000, 1000) }] },
      'claude-opus-5-5',
      100,
      silent,
    );
    expect(it1.micros).toBe(100 * 400 + 10 * 2000 + 1_200_000);
    expect(it1.tokens).toEqual(t(1100, 1010));
    // kalemsiz, istenen Opus 5.5, yanıt Sonnet 5.5: pahalı olan (Opus)
    expect(usageCost({ model: 'claude-sonnet-5-5', ...t(1000, 1000), iterations: null }, 'claude-opus-5-5', 100, silent).micros).toBe(2_400_000);
    // kalemsiz, istenen Sonnet, yanıt bilinmeyen model: en pahalı fiyat (05-B13: tablodaki olmayan daha pahalı yedek model
    // istenenin fiyatıyla eksik sayılmasın; Fable 5.1, girdi 1.000 TL / 1M)
    expect(usageCost({ model: 'claude-x', ...t(1000, 0), iterations: null }, 'claude-sonnet-5-5', 100, silent).micros).toBe(1_000_000);
    // ikisi de bilinmiyor: en pahalı fiyat (Fable 5.1, girdi 1.000 TL / 1M)
    expect(usageCost({ model: 'claude-x', ...t(1000, 0), iterations: null }, 'claude-y', 100, silent).micros).toBe(1_000_000);
    // kalemde model yoksa yanıtı veren ve istenen modelden pahalı olanı
    expect(usageCost({ model: 'claude-sonnet-5-5', ...t(0, 0), iterations: [{ model: null, ...t(1000, 0) }] }, 'claude-sonnet-5-5', 100, silent).micros).toBe(200_000);
    expect(usageCost({ model: 'claude-sonnet-5-5', ...t(0, 0), iterations: [{ model: null, ...t(1000, 0) }] }, 'claude-opus-5-5', 100, silent).micros).toBe(400_000);
    // kalemdeki bilinmeyen model en pahalı fiyatı alır (05-B13)
    expect(usageCost({ model: 'claude-sonnet-5-5', ...t(0, 0), iterations: [{ model: 'claude-z', ...t(1000, 0) }] }, 'claude-opus-5', 100, silent).micros).toBe(1_000_000);
    // tablodaki yedek model (Fable 5.2) kendi fiyatıyla: girdi 8 $ / 1M
    expect(usageCost({ model: 'claude-fable-5-2', ...t(1000, 0), iterations: null }, 'claude-fable-5-2', 100, silent).micros).toBe(800_000);
  });

  it('ortam: bozuk, eksi, NaN değer varsayılana düşer (sıfıra değil); fiyat tablosu geçerli ezmeyi alır', () => {
    for (const bad of ['abc', '-5', 'NaN', '0', 'Infinity', '']) {
      process.env.AI_PRICE_TRY_PER_USD = bad;
      expect(env.aiPriceTryPerUsd, bad).toBe(100);
    }
    process.env.AI_PRICE_TRY_PER_USD = '40.5';
    expect(env.aiPriceTryPerUsd).toBe(40.5);
    for (const bad of ['abc', '-1', 'NaN']) {
      process.env.AI_FREE_CREDIT_MONTHLY_TRY = bad;
      expect(env.aiFreeCreditMonthlyTry, bad).toBe(2500);
    }
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '0';
    expect(env.aiFreeCreditMonthlyTry).toBe(0);
    process.env.AI_PRICE_TABLE = JSON.stringify({ 'claude-sonnet-5-5': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }, broken: { input: -1, output: 1, cacheWrite: 1, cacheRead: 1 } });
    expect(priceFor('claude-sonnet-5-5').price).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    expect(priceFor('broken').known).toBe(false);
    process.env.AI_PRICE_TABLE = '{bozuk';
    expect(priceFor('claude-sonnet-5-5').price).toEqual(AI_LIST_PRICES_USD['claude-sonnet-5-5']);
    // inceleme 2026-11-13: bilinmeyen model ezmeli etkin tablonun en pahalısından (eskiden sabit Fable 5.1 liste fiyatı)
    process.env.AI_PRICE_TABLE = JSON.stringify({ 'claude-opus-5-5': { input: 30, output: 90, cacheWrite: 37.5, cacheRead: 3 } });
    expect(priceFor('claude-mystery-9')).toEqual({ price: { input: 30, output: 90, cacheWrite: 37.5, cacheRead: 3 }, known: false });
    delete process.env.AI_PRICE_TABLE;
    expect(priceFor('claude-mystery-9').price).toEqual(AI_UNKNOWN_MODEL_PRICE);
  });

  it('plan limiti: yalnız sonlu, eksi olmayan sayı; boolean, metin, NaN ortam varsayılanına düşer', () => {
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '500';
    expect(aiFreeMicros({ aiCreditMonthly: 250 })).toBe(250_000_000);
    expect(aiFreeMicros({ aiCreditMonthly: 0 })).toBe(0);
    expect(aiFreeMicros({ aiCreditMonthly: 0.0006 })).toBe(600);
    // false ve 0: ücretsiz hak yok; eksi, sayı olmayan, true: ortam varsayılanı
    expect(aiFreeMicros({ aiCreditMonthly: false })).toBe(0);
    for (const v of [true, '250', Number.NaN, -1, Number.POSITIVE_INFINITY, null]) expect(aiFreeMicros({ aiCreditMonthly: v }), String(v)).toBe(500_000_000);
    expect(aiFreeMicros({})).toBe(500_000_000);
    expect(aiUsedPct(0, 0)).toBe(100);
    expect(aiUsedPct(599, 600)).toBe(99);
    expect(aiUsedPct(600, 600)).toBe(100);
    expect(aiUsedPct(290_000, 1_000_000)).toBe(29);
  });

  it('satıra yazılan ücret kuruşu kuruşuna: Decimal(14,6), toplam SQL ile kesin; dönem hakkı "kullanılan ≥ hak" ile durur', async () => {
    defaultReply = { usage: { input_tokens: 1, output_tokens: 0 } }; // 200 mikro TL
    const ctx = ctxOf(A, 'TARIFF_REVIEW', { limits: { aiCreditMonthly: 0.0006 } }); // hak 600 mikro TL
    await call(ctx, 'a', false);
    await call(ctx, 'b', false);
    const a = await aiAllowance(A.companyId, ctx.limits);
    expect(a).toMatchObject({ usedMicros: 400, freeMicros: 600, exhausted: false });
    await call(ctx, 'c', false);
    expect(await aiAllowance(A.companyId, ctx.limits)).toMatchObject({ usedMicros: 600, exhausted: true });
    await expect(call(ctx, 'd', false)).rejects.toMatchObject({ statusCode: 429, code: 'AI_QUOTA_EXCEEDED' });
    expect(calls).toHaveLength(3);
    const rows = await usageRows(A.companyId);
    expect(rows.map((r) => r.cost.toString())).toEqual(['0.0002', '0.0002', '0.0002']);
    expect(rows[0]).toMatchObject({ status: 'OK', kind: 'TARIFF_REVIEW', inputTokens: 1, outputTokens: 0, model: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', currency: 'TRY', memberId: A.userId });
    expect(rows[0]!.priceVersion).toMatch(/^r100:[0-9a-f]{12}$/);
    // AI_QUOTA_ENFORCED=false: sayılır ama durdurmaz
    process.env.AI_QUOTA_ENFORCED = 'false';
    await expect(call(ctx, 'e', false)).resolves.toMatchObject({ cached: false });
  });
});

describe('dönem: firmanın saat dilimindeki takvim ayı', () => {
  it('İstanbul 23:59 ve 00:00 sınırı; saat dilimi sonradan değişince eski satırın dönemi yerinde kalır', async () => {
    expect(aiPeriodOf(new Date('2026-11-30T20:59:59.999Z'), 'Europe/Istanbul')).toBe('2026-11');
    expect(aiPeriodOf(new Date('2026-11-30T21:00:00.000Z'), 'Europe/Istanbul')).toBe('2026-12');
    const ctx = ctxOf(A, 'TARIFF_REVIEW');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-30T20:59:30Z'));
    await call({ ...ctx, ref: { type: 'File', id: '1-once' } }, 'once', false);
    vi.setSystemTime(new Date('2026-11-30T21:00:30Z'));
    await call({ ...ctx, ref: { type: 'File', id: '2-sonra' } }, 'sonra', false);
    const a = await aiAllowance(A.companyId, {});
    expect(a.period).toBe('2026-12');
    expect(a.resetsAt.toISOString()).toBe('2026-12-31T21:00:00.000Z');
    expect(a.periodStart.toISOString()).toBe('2026-11-30T21:00:00.000Z');
    // saat dilimi UTC olur: aynı an artık Kasım; eski satırlar değişmez
    const company = await inCompany(A.companyId, () => prisma.company.findFirstOrThrow({ where: { id: A.companyId }, select: { settings: true } }));
    const settings = (company.settings ?? {}) as Record<string, unknown>;
    await inCompany(A.companyId, () => prisma.company.update({ where: { id: A.companyId }, data: { settings: { ...settings, timeZone: 'UTC' } } }));
    try {
      await call({ ...ctx, ref: { type: 'File', id: '3-utc' } }, 'utc', false);
      // createdAt sahte saatte eşit olabilir: sıra refId ile
      const rows = (await usageRows(A.companyId)).sort((x, y) => String(x.refId).localeCompare(String(y.refId)));
      expect(rows.map((r) => r.period)).toEqual(['2026-11', '2026-12', '2026-11']);
    } finally {
      await inCompany(A.companyId, () => prisma.company.update({ where: { id: A.companyId }, data: { settings: settings as object } }));
    }
  });
});

describe('önbellek ve tek uçuş', () => {
  it('aynı girdi: ikincisi ücretsiz (CACHED, token 0); fresh yeniden çağırır; başka firmada isabet yok', async () => {
    const first = await call(ctxOf(A));
    expect(first).toMatchObject({ cached: false, data: { value: 'ok' } });
    expect(first.usageId).toBeTruthy();
    const second = await call(ctxOf(A));
    expect(second).toMatchObject({ cached: true, usage: null, data: { value: 'ok' } });
    expect(calls).toHaveLength(1);
    const other = await call(ctxOf(B));
    expect(other.cached).toBe(false);
    expect(calls).toHaveLength(2);
    defaultReply = { text: JSON.stringify({ value: 'yeni' }) };
    const fresh = await call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true }));
    expect(fresh).toMatchObject({ cached: false, data: { value: 'yeni' } });
    expect(calls).toHaveLength(3);
    // fresh sonucu önbelleğin yerini alır
    expect((await call(ctxOf(A))).data).toEqual({ value: 'yeni' });
    const rows = await usageRows(A.companyId);
    expect(rows.map((r) => r.status)).toEqual(['OK', 'CACHED', 'OK', 'CACHED']);
    expect(rows.filter((r) => r.status === 'CACHED').map((r) => [r.cost.toString(), r.inputTokens, r.outputTokens])).toEqual([
      ['0', 0, 0],
      ['0', 0, 0],
    ]);
    expect(await inCompany(B.companyId, () => prisma.aiResultCache.count())).toBe(1);
  });

  it('Mesaj 7 cacheNotBefore: fresh + cacheNotBefore yalnız o andan yeni kaydı alır (eski sonuç gelmez, işin kendi sonucu ücretsiz)', async () => {
    defaultReply = { text: JSON.stringify({ value: 'eski' }) };
    await call(ctxOf(A));
    expect(calls).toHaveLength(1);
    // işten önceki sonuç: cacheNotBefore'dan eski → sağlayıcı yeniden çağrılır. İşin `createdAt`'i gibi veritabanı saati.
    await new Promise((r) => setTimeout(r, 10));
    const jobStart = (await prisma.$queryRaw<{ t: Date }[]>`SELECT now() AS t`)[0]!.t;
    await new Promise((r) => setTimeout(r, 10));
    defaultReply = { text: JSON.stringify({ value: 'yeni' }) };
    const first = await call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true, cacheNotBefore: jobStart }));
    expect(first).toMatchObject({ cached: false, data: { value: 'yeni' } });
    expect(calls).toHaveLength(2);
    // aynı işin yeniden denemesi: kendi yazdığı sonuç (cacheNotBefore'dan yeni) ücretsiz
    const retry = await call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true, cacheNotBefore: jobStart }));
    expect(retry).toMatchObject({ cached: true, data: { value: 'yeni' } });
    expect(calls).toHaveLength(2);
    // cacheNotBefore'suz fresh eskisi gibi önbelleği hiç okumaz
    await call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true }));
    expect(calls).toHaveLength(3);
    expect((await usageRows(A.companyId)).map((r) => r.status)).toEqual(['OK', 'OK', 'CACHED', 'OK']);
  });

  it('Y62-E3 "Yeniden oku" işi bir parçada düşerse: okunan parça önbellekte en yeni kayıt, fresh olmayan tekrar ücretsiz alır; yeni fresh iş yeniden ücretler', async () => {
    const dbNow = async () => {
      await new Promise((r) => setTimeout(r, 10));
      const t = (await prisma.$queryRaw<{ t: Date }[]>`SELECT now() AS t`)[0]!.t;
      await new Promise((r) => setTimeout(r, 10));
      return t;
    };
    // ilk okuma: iki parçalı belge (gruplu PDF okuması gibi parça başına bir çağrı)
    defaultReply = { text: JSON.stringify({ value: 'eski' }) };
    await call(ctxOf(A), 'parça-1');
    await call(ctxOf(A), 'parça-2');
    expect(calls).toHaveLength(2);
    // "Yeniden oku" işi: 1. parça yeniden okunup ücretlenir, 2. parçada sağlayıcı reddeder, iş düşer
    const job1 = await dbNow();
    replies.push({ text: JSON.stringify({ value: 'yeni' }) });
    replies.push({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } });
    const fresh1 = ctxOf(A, 'INVOICE_MAPPING', { fresh: true, cacheNotBefore: job1 });
    await expect(call(fresh1, 'parça-1')).resolves.toMatchObject({ cached: false, data: { value: 'yeni' } });
    await expect(call(fresh1, 'parça-2')).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect(calls).toHaveLength(4);
    // panelin "Tekrar dene"si (iş başlamıştı: fresh değil, `retryFresh`): işin okuduğu yeni sonuç ücretsiz gelir
    await expect(call(ctxOf(A), 'parça-1')).resolves.toMatchObject({ cached: true, data: { value: 'yeni' } });
    expect(calls).toHaveLength(4);
    // yeni bir fresh iş (eski panel davranışı) aynı parçayı ikinci kez ücretlerdi
    const job2 = await dbNow();
    replies.push({ text: JSON.stringify({ value: 'yeni' }) });
    await expect(call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true, cacheNotBefore: job2 }), 'parça-1')).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(5);
    expect((await usageRows(A.companyId)).map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'FAILED', 'CACHED', 'OK']);
  });

  it('Mesaj 7 aiJobContext: firma ve kişi satırdan, limitler girdiden; fresh işinde cacheNotBefore = createdAt; origin job', () => {
    const createdAt = new Date('2026-11-11T10:00:00.000Z');
    const job = { companyId: A.companyId, createdById: A.userId, createdAt, input: { aiLimits: { 'deciship.ai.creditMonthly': 7 }, fresh: true, companyId: B.companyId } };
    const ctx = aiJobContext(job, 'INVOICE_PDF', { type: 'File', id: 'f1' });
    expect(ctx).toEqual({ companyId: A.companyId, memberId: A.userId, kind: 'INVOICE_PDF', limits: { 'deciship.ai.creditMonthly': 7 }, ref: { type: 'File', id: 'f1' }, origin: 'job', fresh: true, cacheNotBefore: createdAt });
    const plain = aiJobContext({ ...job, input: {} }, 'TARIFF_PDF_DISCOVER');
    expect(plain).toEqual({ companyId: A.companyId, memberId: A.userId, kind: 'TARIFF_PDF_DISCOVER', limits: {}, origin: 'job', fresh: false });
  });

  it('Mesaj 7 dakika sınırı: assertAiRate başlatmada sayar; işteki çağrı (origin job) sınırı yeniden saymaz ve ona takılmaz', async () => {
    process.env.API_RATE_LIMIT = 'on';
    process.env.AI_RATE_OTHER_PER_MIN = '1';
    assertAiRate(ctxOf(A));
    expect(() => assertAiRate(ctxOf(A))).toThrow(expect.objectContaining({ statusCode: 429, code: 'TOO_MANY_REQUESTS' }));
    // istekten gelen çağrı sınırda
    await expect(call(ctxOf(A), 'r1')).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
    // iş içindeki çağrı (başlatırken sayıldı) geçer, sınırı da tüketmez
    await expect(call(ctxOf(A, 'INVOICE_MAPPING', { origin: 'job' }), 'r2')).resolves.toMatchObject({ cached: false });
    await expect(call(ctxOf(A, 'INVOICE_MAPPING', { origin: 'job' }), 'r3')).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(2);
  });

  it('önbellek anahtarı: dosya içeriği kendi sha256 karşılığıyla; dil, model ya da şema değişince değişir', () => {
    const base = { model: 'm', system: 's', schema, maxTokens: 1, effort: 'low', content: [{ type: 'document', source: { type: 'base64', data: Buffer.from('pdf').toString('base64') } }] };
    const k = aiCacheKey('INVOICE_PDF', base);
    expect(aiCacheKey('INVOICE_PDF', { ...base, content: [{ type: 'document', source: { type: 'base64', data: Buffer.from('pdf').toString('base64') } }] })).toBe(k);
    expect(aiCacheKey('INVOICE_PDF', { ...base, content: [{ type: 'document', source: { type: 'base64', data: Buffer.from('pdf2').toString('base64') } }] })).not.toBe(k);
    expect(aiCacheKey('INVOICE_PDF', { ...base, system: 's\n\nWrite free text in English' })).not.toBe(k);
    expect(aiCacheKey('INVOICE_PDF', { ...base, model: 'n' })).not.toBe(k);
    expect(aiCacheKey('INVOICE_PDF', { ...base, schema: z.object({ other: z.number() }) })).not.toBe(k);
    expect(aiCacheKey('INVOICE_MAPPING', base)).not.toBe(k);
  });

  it('aynı anda gelen aynı istek tek kez ücretlenir (tek uçuş); ilki başarısızsa ikincisi de hata alır, ücret yazılmaz', async () => {
    defaultReply = { delayMs: 150 };
    const [x, y] = await Promise.all([call(ctxOf(A), 'çift tık'), call(ctxOf(A), 'çift tık')]);
    expect(calls).toHaveLength(1);
    expect([x.cached, y.cached].sort()).toEqual([false, true]);
    const rows = await usageRows(A.companyId);
    expect(rows.map((r) => r.status).sort()).toEqual(['CACHED', 'OK']);
    expect(rows.reduce((s, r) => s + Number(r.cost), 0)).toBe(1.2);

    calls.length = 0;
    defaultReply = { delayMs: 100, stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } };
    const both = await Promise.allSettled([call(ctxOf(A), 'ret'), call(ctxOf(A), 'ret')]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toHaveLength(1);
    const failed = (await usageRows(A.companyId)).filter((r) => r.status === 'FAILED');
    expect(failed).toHaveLength(1);
    // ret token taşır ve ücretlenir: 10×200 + 5×1000
    expect(failed[0]).toMatchObject({ errorCode: 'AI_REFUSED', inputTokens: 10, outputTokens: 5 });
    expect(failed[0]!.cost.toString()).toBe('0.007');
    // başarısız sonuç önbelleğe girmez
    expect(await inCompany(A.companyId, () => prisma.aiResultCache.count({ where: { kind: 'INVOICE_MAPPING' } }))).toBe(1);
    // sonuç vermeyen çağrı kotadan düşmez: kullanılan yalnız OK satırı (1,20 TL)
    expect((await aiAllowance(A.companyId, {})).usedMicros).toBe(1_200_000);
    // ret hatırlanır: aynı içerik sağlayıcı çağrılmadan aynı hatayı alır; fresh de, istemin dili de atlatmaz
    defaultReply = {};
    await expect(call(ctxOf(A), 'ret')).rejects.toMatchObject({ statusCode: 422, code: 'AI_REFUSED' });
    await expect(call(ctxOf(A, 'INVOICE_MAPPING', { fresh: true }), 'ret')).rejects.toMatchObject({ code: 'AI_REFUSED' });
    await expect(
      meteredCall(ctxOf(A), { schema, system: 'sys\n\nWrite free text in English, not Turkish; codes and enums unchanged.', maxTokens: 100, effort: 'low', content: text('ret'), cache: true }),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect(calls).toHaveLength(1);
    // içerik değişince yeni çağrı (buna karşı aylık tavan var)
    await expect(call(ctxOf(A), 'ret2')).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(2);
  });

  it('sonuç vermeyen çağrıların aylık tavanı: dolunca 429 AI_QUOTA_EXCEEDED reason failed_budget; kullanılan tutar değişmez', async () => {
    const limits = { aiCreditMonthly: 0.01 }; // hak 10.000 mikro TL, tavan (oran 1) 10.000
    defaultReply = { stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } }; // 7.000 mikro TL
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r1', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    // tek bayt farklı içerik hatırlamayı atlatır ama tavana sayılır
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r2', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect(calls).toHaveLength(2);
    const blocked = await call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r3', false).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ statusCode: 429, code: 'AI_QUOTA_EXCEEDED', details: { reason: 'failed_budget', usedPct: 0 } });
    expect(String((blocked as Error).message)).toMatch(/okunamayan belgeler için ayrılan deneme hakkı doldu/);
    expect(findMoneyKeys((blocked as { details: unknown }).details)).toEqual([]);
    expect(calls).toHaveLength(2);
    const a = await aiAllowance(A.companyId, limits);
    expect(a).toMatchObject({ usedMicros: 0, exhausted: false, failedMicros: 14_000, failedBudgetMicros: 10_000, failedExhausted: true });
    // oran 2: tavan büyür, çağrı geçer
    process.env.AI_FAILED_BUDGET_RATIO = '2';
    defaultReply = { usage: { input_tokens: 1, output_tokens: 0 } }; // 200 mikro TL: normal hak dolmasın
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r3', false)).resolves.toMatchObject({ cached: false });
    // oran 0: ilk başarısız çağrıdan sonra durur; bozuk değer varsayılana (1) düşer
    process.env.AI_FAILED_BUDGET_RATIO = '0';
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r4', false)).rejects.toMatchObject({ details: { reason: 'failed_budget' } });
    process.env.AI_FAILED_BUDGET_RATIO = '-3';
    expect(env.aiFailedBudgetRatio).toBe(1);
    // AI_QUOTA_ENFORCED=false durdurmaz
    process.env.AI_FAILED_BUDGET_RATIO = '0';
    process.env.AI_QUOTA_ENFORCED = 'false';
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { limits }), 'r5', false)).resolves.toMatchObject({ cached: false });
  });

  it('kesilme önbelleksiz türde de hatırlanır (30 dk): yeniden gönderim ücretlenmez, başka firmayı etkilemez', async () => {
    defaultReply = { stop_reason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 100 } };
    await expect(call(ctxOf(A, 'SCALE_READ'), 'foto', false)).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    await expect(call(ctxOf(A, 'SCALE_READ'), 'foto', false)).rejects.toMatchObject({ code: 'AI_TRUNCATED', message: expect.stringContaining('bölerek') });
    expect(calls).toHaveLength(1);
    expect((await usageRows(A.companyId)).map((r) => [r.status, r.errorCode])).toEqual([['FAILED', 'AI_TRUNCATED']]);
    await expect(call(ctxOf(B, 'SCALE_READ'), 'foto', false)).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    expect(calls).toHaveLength(2);
    // süre dolunca yeniden denenir
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 31 * 60_000));
    defaultReply = {};
    await expect(call(ctxOf(A, 'SCALE_READ'), 'foto', false)).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(3);
  });

  it('bağlantı hatasında kullanım bilinmez: FAILED, token 0, ücret 0', async () => {
    const { APIConnectionError } = await import('@anthropic-ai/sdk');
    defaultReply = { error: new APIConnectionError({ message: 'ECONNRESET' }) };
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'kopuk', false)).rejects.toMatchObject({ code: 'AI_FAILED' });
    const [row] = await usageRows(A.companyId);
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AI_FAILED', inputTokens: 0, outputTokens: 0, servedModel: null });
    expect(row!.cost.toString()).toBe('0');
  });
});

describe('sınırlar', () => {
  it('firma başı eşzamanlılık: yuva doluysa 429 TOO_MANY_REQUESTS; kota aşımı en çok yuva sayısı kadar', async () => {
    process.env.AI_CONCURRENCY_PER_ORG = '1';
    defaultReply = { delayMs: 150 };
    const r = await Promise.allSettled([call(ctxOf(A, 'TARIFF_REVIEW'), 'x', false), call(ctxOf(A, 'TARIFF_REVIEW'), 'y', false)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const err = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(err.reason).toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS', retryAfter: 3 });
    // başka firma etkilenmez
    await expect(call(ctxOf(B, 'TARIFF_REVIEW'), 'z', false)).resolves.toMatchObject({ cached: false });
  });

  it('tartı okuma ayrı yuva grubunda: uzun işler sürerken tartı okuması 429 almaz (firma başı 2)', async () => {
    process.env.AI_CONCURRENCY_PER_ORG = '1';
    replies.push({ delayMs: 300 });
    const long = call(ctxOf(A, 'TARIFF_PDF_EXTRACT'), 'uzun pdf', false);
    try {
      await new Promise((res) => setTimeout(res, 50));
      defaultReply = { delayMs: 100 };
      const scales = await Promise.allSettled([call(ctxOf(A, 'SCALE_READ'), 's1', false), call(ctxOf(A, 'SCALE_READ'), 's2', false), call(ctxOf(A, 'SCALE_READ'), 's3', false)]);
      // Yuva, kota denetiminin veritabanı okumasından SONRA alınır (`callProvider`: `assertAiQuota` → `takeSlot`): aynı anda
      // başlayan çağrılardan hangisinin yuvasız kalacağı okumaların dönüş sırasına bağlıdır. Sözleşme sıra değil sayıdır:
      // tam iki tartı okuması geçer, tam biri 429 alır (ilk sınır testindeki gibi sıralı karşılaştırma).
      expect(scales.map((x) => x.status).sort()).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      expect((scales.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
      await expect(call(ctxOf(A, 'INVOICE_MAPPING'), 'eşleme', false)).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
    } finally {
      // Uzun çağrı her durumda beklenir: test erken kırılırsa arkada biten çağrı sonraki testin temizlenmiş kullanım
      // tablosuna OK satırı yazıyor ve yuvayı tutuyordu (sonraki testteki fazladan 'OK' bundandı).
      await long;
    }
  });

  it('sağlayıcı süre sınırı: akış durursa istek kesilir (504), yuva bırakılır', async () => {
    process.env.AI_CONCURRENCY_PER_ORG = '1';
    replies.push({ delayMs: 5_000 });
    const t0 = Date.now();
    await expect(meteredCall(ctxOf(A, 'TARIFF_REVIEW'), { schema, system: 's', maxTokens: 10, effort: 'low', content: text('asılı'), timeoutMs: 150 })).rejects.toMatchObject({
      statusCode: 504,
      code: 'AI_FAILED',
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'sonraki', false)).resolves.toMatchObject({ cached: false });
    expect((await usageRows(A.companyId)).map((r) => r.status).sort()).toEqual(['FAILED', 'OK']);
    // süre dolması da hatırlanır: aynı içerik sağlayıcıya gitmeden 504
    const before = calls.length;
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { fresh: true }), 'asılı', false)).rejects.toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    expect(calls).toHaveLength(before);
  });

  it('kişi başı dakika sınırı (API_RATE_LIMIT açıkken): 429 ve retry-after başlığı; kapalıyken sınır yok', async () => {
    process.env.API_RATE_LIMIT = 'on';
    process.env.AI_RATE_SCALE_PER_MIN = '2';
    const worker = await createWorker(app, A.auth);
    const send = () => {
      const form = multipart([{ name: 'image', filename: 't.jpg', contentType: 'image/jpeg', data: JPEG }]);
      return app.inject({ method: 'POST', url: `${API}/vision/scale`, headers: { ...worker.auth, ...form.headers }, payload: form.payload });
    };
    defaultReply = { text: JSON.stringify({ weight: 4.02, unit: 'kg', rawText: '4.02 kg', confidence: 0.9 }) };
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(2);
    process.env.API_RATE_LIMIT = 'off';
    expect((await send()).statusCode).toBe(200);
  });

  it('hak dolunca tartı okuma 429 AI_QUOTA_EXCEEDED; ayrıntıda tutar yok; ek kredi hakkı artırır; plan limiti ortamı ezer', async () => {
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '0';
    const worker = await createWorker(app, A.auth);
    const send = (auth = worker.auth) => {
      const form = multipart([{ name: 'image', filename: 't.jpg', contentType: 'image/jpeg', data: JPEG }]);
      return app.inject({ method: 'POST', url: `${API}/vision/scale`, headers: { ...auth, ...form.headers }, payload: form.payload });
    };
    defaultReply = { text: JSON.stringify({ weight: 1, unit: 'kg', rawText: '1 kg', confidence: 1 }) };
    const r = await send();
    expect(r.statusCode, r.body).toBe(429);
    const error = r.json().error;
    expect(error.code).toBe('AI_QUOTA_EXCEEDED');
    expect(Object.keys(error.details).sort()).toEqual(['period', 'resetsAt', 'usedPct']);
    expect(findMoneyKeys(r.json())).toEqual([]);
    expect(error.message).toMatch(/yapay zekâ kullanım hakkınız doldu/);
    expect(error.message).not.toMatch(/TL|₺|\d+,\d\d/);
    expect(calls).toHaveLength(0);

    const g = await grantCredit({ companyId: A.companyId, amount: 25, operator: 'Destek Test', note: 'deneme' });
    expect(g).toMatchObject({ status: 'granted', allowanceAmount: 25, usedAmount: 0 });
    expect((await send()).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const row = (await usageRows(A.companyId))[0]!;
    expect(row).toMatchObject({ kind: 'SCALE_READ', memberId: worker.userId, status: 'OK' });

    // plan limiti (jetonda) ortamı ezer: ortam 0, plan 5 TL → geçer; limit boolean ise ortam (0) → durur
    await clearCompany(A.companyId);
    const withPlan = await worker.token({ limits: { aiCreditMonthly: 5 } });
    expect((await send(withPlan.auth)).statusCode).toBe(200);
    const boolPlan = await worker.token({ limits: { aiCreditMonthly: true } });
    expect((await send(boolPlan.auth)).statusCode).toBe(429); // boolean: ortam varsayılanı (0)
  });

  it('sayaç yazılamazsa sonuç yine döner, günlüğe ai-meter-write-failed', async () => {
    const errors: string[] = [];
    const log: MeterLog = { warn: () => undefined, error: (_o, msg) => errors.push(msg ?? '') };
    // yerelde olmayan firma: satır yazılamaz (yabancı anahtar)
    const ghost: AiCallContext = { companyId: '00000000-0000-4000-8000-000000000001', memberId: null, kind: 'TARIFF_REVIEW', limits: {}, log };
    const r = await call(ghost, 'hayalet', false);
    expect(r).toMatchObject({ data: { value: 'ok' }, usageId: null, cached: false });
    expect(errors).toContain('ai-meter-write-failed');
  });

  it('sigorta: art arda 3 sayaç yazım hatasından sonra firmanın çağrıları 503 (5 dk ya da bir yazım başarılı olana kadar)', async () => {
    const errors: string[] = [];
    const log: MeterLog = { warn: () => undefined, error: (_o, msg) => errors.push(msg ?? '') };
    const ghost: AiCallContext = { companyId: '00000000-0000-4000-8000-000000000003', memberId: null, kind: 'TARIFF_REVIEW', limits: {}, log };
    for (const c of ['1', '2', '3']) await expect(call(ghost, c, false)).resolves.toMatchObject({ usageId: null });
    expect(calls).toHaveLength(3);
    const blocked = await call(ghost, '4', false).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(String((blocked as Error).message)).not.toMatch(/meter|sayaç|veritabanı|database/i);
    expect(calls).toHaveLength(3);
    expect(errors.some((e) => e.startsWith('ai-meter-fuse-open'))).toBe(true);
    // başka firma etkilenmez
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'a', false)).resolves.toMatchObject({ cached: false });
    // 5 dk sonra yeniden denenir
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1000));
    await expect(call(ghost, '5', false)).resolves.toMatchObject({ usageId: null });
    expect(calls).toHaveLength(5);
  });
});

describe('kaynak kuralları', () => {
  const SRC = path.resolve(import.meta.dirname, '../src');
  const files = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.includes('generated'))
    .map((f) => f.replace(/\\/g, '/'));

  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
  /** Yorum satırları atılmış kaynak (açıklamada geçen ad sayılmaz). */
  const code = (f: string) =>
    read(f)
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it('structuredCall yalnız kendi tanımında (ai.ts) ve aiMeter.ts içinde geçer; ai.ts onu kendisi çağırmaz', () => {
    const users = files.filter((f) => /\bstructuredCall\b/.test(code(f)));
    expect(users.sort()).toEqual(['services/ai.ts', 'services/aiMeter.ts']);
    const ai = code('services/ai.ts');
    expect(ai.match(/\bstructuredCall\b/g)).toHaveLength(1);
    expect(ai).toMatch(/export async function structuredCall</);
  });

  it('sağlayıcı SDK değer olarak yalnız ai.ts içinde içe aktarılır; başka yerde istemci ya da doğrudan istek yok', () => {
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+'@anthropic-ai\/sdk[^']*'/m;
    expect(files.filter((f) => valueImport.test(code(f)))).toEqual(['services/ai.ts']);
    expect(files.filter((f) => /new\s+Anthropic\b/.test(code(f)))).toEqual(['services/ai.ts']);
    expect(files.filter((f) => /messages\.(create|stream)\s*\(/.test(code(f)))).toEqual(['services/ai.ts']);
  });

  it('komut satırı modülü (cli/aiUsage.ts) yalnız kendi çalıştırma girişinde (bin/aiUsage.ts) içe aktarılır', () => {
    expect(files.filter((f) => /from\s+'[^']*cli\/aiUsage(\.ts)?'|import\(\s*'[^']*cli\/aiUsage/.test(read(f)))).toEqual(['bin/aiUsage.ts']);
  });

  it('destek kapsamı (withSupportScope) yalnız komut satırından açılır', () => {
    const users = files.filter((f) => f !== 'db.ts' && /\bwithSupportScope\b/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(users).toEqual(['cli/aiUsage.ts']);
  });
});

describe('Merkez ucu ve destek komutları', () => {
  it('GET /platform/ai-usage: dönem, hak, kullanım, türlere göre döküm; dönem doğrulanır', async () => {
    // hak açıkça 500 TL: test yanıtın biçimini sınar, ortam varsayılanını değil (varsayılan yukarıda)
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '500';
    defaultReply = { usage: { input_tokens: 1000, output_tokens: 1000 } }; // 1,20 TL
    await call(ctxOf(A, 'INVOICE_MAPPING'), 'bir');
    await call(ctxOf(A, 'INVOICE_MAPPING'), 'bir'); // önbellekten
    await call(ctxOf(A, 'TARIFF_REVIEW'), 'iki', false);
    await grantCredit({ companyId: A.companyId, amount: 10.5, operator: 'Destek Test' });
    // sonuç vermeyen çağrı: işlem ve tokende görünür, tutara (kotaya) girmez
    replies.push({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'üç', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    const r = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: A.auth });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      product: 'deciship',
      period: aiPeriodOf(new Date(), 'Europe/Istanbul'),
      currency: 'TRY',
      enforced: true,
      freeAmount: 500,
      creditAmount: 10.5,
      allowanceAmount: 510.5,
      usedAmount: 2.4,
      remainingAmount: 508.1,
      calls: 3,
      usedPct: 0,
      exhausted: false,
      tokens: { input: 2010, output: 2005, cacheRead: 0, cacheWrite: 0, total: 4015 },
      cachedCalls: 1,
    });
    expect(body.byKind).toEqual([
      { kind: 'INVOICE_MAPPING', label: 'Sütun eşleme', calls: 1, tokens: 2000, amount: 1.2, durationMs: expect.any(Number) },
      { kind: 'TARIFF_REVIEW', label: 'Tarife incelemesi', calls: 2, tokens: 2015, amount: 1.2, durationMs: expect.any(Number) },
    ]);
    const en = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: { ...A.auth, 'accept-language': 'en' } });
    expect(en.json().byKind[0].label).toBe('Column mapping');
    for (const bad of ['2026-13', 'abc', '2099-01', '2020-01']) {
      const v = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage?period=${bad}`, headers: A.auth });
      expect(v.statusCode, bad).toBe(400);
    }
    // ölçüm rolü ayar izni taşımaz
    const worker = await createWorker(app, A.auth);
    expect((await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: worker.auth })).statusCode).toBe(403);
  });

  it('fiyat izni olmayana para alanları gitmez', async () => {
    const t = translator('tr');
    const out = await buildAiUsage({ companyId: A.companyId, userId: null, locale: 'tr', t, can: () => false, now: new Date() }, undefined, {});
    expect(findMoneyKeys(out)).toEqual([]);
    expect(out).toMatchObject({ usedPct: 0, exhausted: false });
  });

  it('Y60: kopan akışta tahmin edilen çıktı satırda işaretlenir; satır aynen sayılır; Merkez ucu tahminli işlemi sayar', async () => {
    defaultReply = { usage: { input_tokens: 1000, output_tokens: 1000 } }; // 1,20 TL
    await call(ctxOf(A, 'TARIFF_REVIEW'), 'tam', false);
    // akış koptu: sağlayıcının çıktı sayısı 1'de kaldı, akan 70 karakter → en az 20 çıktı tokeni (karakter / 3,5)
    const streamed = `{"value":"${'x'.repeat(60)}`;
    expect(streamed).toHaveLength(70);
    replies.push({ error: new TypeError('terminated'), partial: { text: streamed, usage: { input_tokens: 5000, output_tokens: 1 } } });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'kopuk', false)).rejects.toMatchObject({ code: expect.stringMatching(/^AI_/) });
    // ret: sağlayıcının kendi sayısı (tahmin değil)
    replies.push({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'ret', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    const rows = await usageRows(A.companyId);
    expect(rows.map((r) => [r.status, r.inputTokens, r.outputTokens, r.estimated, r.cost.toString()])).toEqual([
      ['OK', 1000, 1000, false, '1.2'],
      ['FAILED', 5000, 20, true, '1.02'], // 5000×200 + 20×1000 mikro TL: tahmin tutara aynen girer
      ['FAILED', 10, 5, false, '0.007'],
    ]);
    // kota ve tutar değişmez: yalnız OK satırı kullanılandan düşer; tahminli satır sonuç vermeyen tavanına gerçek tutarıyla girer
    const allowance = await aiAllowance(A.companyId, {});
    expect(allowance.usedMicros).toBe(1_200_000);
    expect(allowance.failedMicros).toBe(1_020_000 + 7_000);
    const r = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: A.auth });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      calls: 3,
      estimatedCalls: 1,
      usedAmount: 1.2,
      tokens: { input: 6010, output: 1025, total: 7035 },
    });
    expect(r.json().byKind).toEqual([{ kind: 'TARIFF_REVIEW', label: 'Tarife incelemesi', calls: 3, tokens: 7035, amount: 1.2, durationMs: expect.any(Number) }]);
  });

  it('Y62-E5: kişi başına döküm token sırasıyla; silinmiş kişi "bilinmiyor"; fiyat izni yoksa tutar yok, sıra aynı', async () => {
    const second = await createMember(app, A.auth, 'ADMIN', 'İkinci Kişi');
    defaultReply = { usage: { input_tokens: 1000, output_tokens: 1000 } }; // 2.000 token, 1,20 TL
    await call(ctxOf(A, 'INVOICE_MAPPING'), 'bir');
    await call(ctxOf(A, 'INVOICE_MAPPING'), 'bir'); // önbellekten, ücretsiz
    replies.push({ usage: { input_tokens: 3000, output_tokens: 1000 } }); // 4.000 token, 1,60 TL
    await call(ctxOf({ companyId: A.companyId, userId: second.userId }, 'TARIFF_REVIEW'), 'iki', false);
    // üyesiz satır (kişi silinince `memberId` boşalır): sonuç vermeyen çağrı, işlemde ve tokende görünür, tutara girmez
    replies.push({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW', { memberId: null }), 'üç', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });

    const expected = [
      { memberId: second.userId, name: 'İkinci Kişi', calls: 1, cachedCalls: 0, tokens: 4000, amount: 1.6 },
      { memberId: A.userId, name: 'Yönetici Test', calls: 1, cachedCalls: 1, tokens: 2000, amount: 1.2 },
      { memberId: null, name: 'Kişi bilinmiyor', calls: 1, cachedCalls: 0, tokens: 15, amount: 0 },
    ];
    const r = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: A.auth });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().byMember).toEqual(expected);
    // kişi dökümünün toplamı genel toplamla aynı
    expect(r.json()).toMatchObject({ calls: 3, cachedCalls: 1, tokens: { total: 6015 }, usedAmount: 2.8 });
    const en = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: { ...A.auth, 'accept-language': 'en' } });
    expect(en.json().byMember.at(-1)).toMatchObject({ memberId: null, name: 'Unknown person' });

    // Fiyat izni yok: tutar çıkar, sıra tutara göre değil tokene göre kalır (tutar sırası maliyet sızdırmasın).
    const out = await buildAiUsage({ companyId: A.companyId, userId: null, locale: 'tr', t: translator('tr'), can: () => false, now: new Date() }, undefined, {});
    expect(findMoneyKeys(out)).toEqual([]);
    expect(out.byMember).toEqual(expected.map(({ amount: _a, ...m }) => m));
    // B firması A'nın kişilerini görmez
    const b = await app.inject({ method: 'GET', url: `${API}/platform/ai-usage`, headers: B.auth });
    expect(b.json().byMember).toEqual([]);
  });

  it('Y62-E3: /me yanıtında yapay zekâ durumu (tutarsız): hak dolunca quotaExhausted; sınır kapalıysa ya da anahtar yoksa dolmuş sayılmaz', async () => {
    const me = async (auth = A.auth) => {
      const r = await app.inject({ method: 'GET', url: `${API}/me`, headers: auth });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    const first = (await me()).ai;
    expect(first).toEqual({ available: true, quotaExhausted: false });
    expect(first).not.toHaveProperty('usedPct');
    defaultReply = { usage: { input_tokens: 1000, output_tokens: 1000 } }; // 1,20 TL
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '2';
    await call(ctxOf(A, 'TARIFF_REVIEW'), 'a', false);
    expect((await me()).ai).toEqual({ available: true, quotaExhausted: false });
    await call(ctxOf(A, 'TARIFF_REVIEW'), 'b', false); // 2,40 ≥ 2
    const full = await me();
    expect(full.ai).toEqual({ available: true, quotaExhausted: true });
    expect(full.aiAvailable).toBe(true);
    // ölçüm rolü de görür; para alanı yok
    const worker = await createWorker(app, A.auth);
    const wm = await me(worker.auth);
    expect(wm.ai).toEqual({ available: true, quotaExhausted: true });
    expect(findMoneyKeys(wm.ai)).toEqual([]);
    // gerçekten 429 alır: ekran ile sunucu aynı kural
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'c', false)).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
    process.env.AI_QUOTA_ENFORCED = 'false';
    expect((await me()).ai).toEqual({ available: true, quotaExhausted: false });
    delete process.env.AI_QUOTA_ENFORCED;
    // sonuç vermeyen çağrı tavanı dolunca da (yeni çağrı 429 failed_budget)
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '500';
    process.env.AI_FAILED_BUDGET_RATIO = '0';
    replies.push({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'd', false)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect((await me()).ai).toMatchObject({ available: true, quotaExhausted: true });
    await expect(call(ctxOf(A, 'TARIFF_REVIEW'), 'e', false)).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED', details: { reason: 'failed_budget' } });
    delete process.env.ANTHROPIC_API_KEY;
    expect((await me()).ai).toEqual({ available: false, quotaExhausted: false });
  });

  it('destek: firma listesi bütün firmaları okur; destek kapsamı yazamaz ve başka tablo görmez', async () => {
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '500'; // hak açıkça: test hakkın biçimini sınar, ortam varsayılanını değil
    defaultReply = { usage: { input_tokens: 1000, output_tokens: 1000 } };
    await call(ctxOf(A, 'TARIFF_REVIEW'), 'a', false);
    await call(ctxOf(B, 'TARIFF_REVIEW'), 'b', false);
    await call(ctxOf(B, 'TARIFF_REVIEW'), 'c', false);
    // kesilme: gerçek maliyet "faturalanmayan" sütununda, kullanılan tutara girmez (100×200 + 100×1000 = 0,12 TL)
    replies.push({ stop_reason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 100 } });
    await expect(call(ctxOf(B, 'TARIFF_REVIEW'), 'd', false)).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    const rows = await usageReport();
    const a = rows.find((r) => r.companyId === A.companyId)!;
    const b = rows.find((r) => r.companyId === B.companyId)!;
    expect(a).toMatchObject({ name: 'Sayaç A', calls: 1, inputTokens: 1000, outputTokens: 1000, usedAmount: 1.2, unbilledAmount: 0, allowanceAmount: 500, usedPct: 0 });
    expect(b).toMatchObject({ calls: 3, usedAmount: 2.4, unbilledAmount: 0.12, failedBudgetAmount: 500, failedBudgetExhausted: false });
    await withSupportScope(async () => {
      await expect(prisma.aiCreditEntry.create({ data: { companyId: A.companyId, kind: 'GRANT', amount: 1, period: '2026-11', operator: 'x' } })).rejects.toThrow();
      expect((await prisma.aiUsage.updateMany({ data: { durationMs: 1 } })).count).toBe(0);
      expect((await prisma.aiUsage.deleteMany({})).count).toBe(0);
      expect(await prisma.invoice.count()).toBe(0);
      expect(await prisma.aiResultCache.count()).toBe(0);
    });
    const out: string[] = [];
    const code = await runAiUsageCli(['usage', '--company', A.companyId], { log: (l) => out.push(l), error: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(A.companyId);
    expect(out.join('\n')).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('ek kredi: --ref ile iki kez (aynı anda) çalışsa da tek kayıt; operatör zorunlu; tutar doğrulanır', async () => {
    process.env.AI_FREE_CREDIT_MONTHLY_TRY = '500'; // hak açıkça (ortam varsayılanı yukarıda sınanır)
    const input = { companyId: A.companyId, amount: 100, operator: 'Destek', ref: 'ticket-42' };
    const [x, y] = await Promise.all([grantCredit(input), grantCredit(input)]);
    expect([x.status, y.status].sort()).toEqual(['already-applied', 'granted']);
    expect(x.entryId).toBe(y.entryId);
    expect(await inCompany(A.companyId, () => prisma.aiCreditEntry.count())).toBe(1);
    await expect(grantCredit({ ...input, ref: undefined, operator: ' ' })).rejects.toThrow(/operator/);
    await expect(grantCredit({ ...input, ref: undefined, amount: -5 })).rejects.toThrow(/positive/);
    await expect(grantCredit({ ...input, ref: undefined, amount: 1.005 })).rejects.toThrow(/decimals/);
    await expect(grantCredit({ ...input, ref: undefined, period: '2026-13' })).rejects.toThrow(/YYYY-MM/);
    await expect(grantCredit({ ...input, ref: undefined, companyId: '00000000-0000-4000-8000-000000000002' })).rejects.toThrow(/not found/);
    const adj = await grantCredit({ ...input, ref: undefined, amount: -30, adjust: true });
    expect(adj.allowanceAmount).toBe(570);
    const out: string[] = [];
    expect(await runAiUsageCli(['grant', '--company', A.companyId, '--amount', '5'], { log: (l) => out.push(l), error: (l) => out.push(l) })).toBe(1);
    expect(out.join('\n')).toMatch(/operator/);
    // tutar yalnız düz ondalık sayı; eksi yalnız --adjust ile; --ref yoksa uyarı yazılır ama çalışır
    for (const bad of ['1e3', '0x10', '5,5', '1.005', '-5', 'abc']) {
      out.length = 0;
      expect(await runAiUsageCli(['grant', '--company', A.companyId, '--amount', bad, '--operator', 'D'], { log: (l) => out.push(l), error: (l) => out.push(l) }), bad).toBe(1);
      expect(out.join('\n'), bad).toMatch(/plain decimal/);
    }
    out.length = 0;
    expect(await runAiUsageCli(['grant', '--company', A.companyId, '--amount', '12.50', '--operator', 'D'], { log: (l) => out.push(l), error: (l) => out.push(l) })).toBe(0);
    expect(out.join('\n')).toMatch(/Warning: no --ref/);
    expect(out.join('\n')).toMatch(/Granted 12\.50 TRY/);
    out.length = 0;
    expect(await runAiUsageCli(['grant', '--company', A.companyId, '--amount', '-2.5', '--adjust', '--operator', 'D', '--ref', 'adj-1'], { log: (l) => out.push(l), error: (l) => out.push(l) })).toBe(0);
    expect(out.join('\n')).not.toMatch(/Warning/);
  });

  it('bakım: süresi dolan önbellek satırları tüm firmalarda silinir, tazeye dokunulmaz', async () => {
    await call(ctxOf(A), 'taze');
    await call(ctxOf(B), 'eski');
    await inCompany(B.companyId, () => prisma.aiResultCache.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }));
    // süresi geçmiş satır isabet saymaz
    await call(ctxOf(B), 'eski');
    expect(calls).toHaveLength(3);
    await inCompany(B.companyId, () => prisma.aiResultCache.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }));
    const result = await runMaintenance();
    expect(result.aiCache).toBeGreaterThanOrEqual(1);
    expect(await inCompany(B.companyId, () => prisma.aiResultCache.count())).toBe(0);
    expect(await inCompany(A.companyId, () => prisma.aiResultCache.count())).toBe(1);
  });
});
