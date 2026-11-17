/**
 * Sistemin günlük yapay zekâ tavanı (`AI_DAILY_BUDGET_TRY`, `services/aiDailyBudget.ts`; kapalı deneme kararı 2026-11-12).
 * Sağlayıcı sahtedir. Saat sahtedir (yalnız `Date`): her test 2031'de kendi gününü kullanır, başka testlerin satırları
 * (bugünün tarihinde) toplama girmez. Harcama satırları ayrı bir "dolgu" firmasına yazılır: çağıran firmanın kotası dolmasın.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiPeriodOf } from '@sellerondata/contracts';
import { runAiUsageCli } from '../src/cli/aiUsage.ts';
import { Prisma, prisma, withAiBudgetScope } from '../src/db.ts';
import { AI_DAILY_BUDGET_DEFAULT_TRY, env, invalidEnv, parseAiDailyBudget } from '../src/env.ts';
import { AI_DAILY_BUDGET_JOB_GRACE, AI_DAILY_BUDGET_REFRESH_MS, aiSystemDay } from '../src/services/aiDailyBudget.ts';
import { schemaProblems } from '../src/lib/schemaCheck.ts';
import {
  AI_UPPER_INPUT_TOKENS_CAP,
  aiAllowance,
  aiCallUpperMicros,
  aiJobContext,
  meteredCall,
  resetAiMeterState,
  type AiCallContext,
  type MeterLog,
} from '../src/services/aiMeter.ts';
import { runInJobScope } from '../src/services/jobs/jobScope.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { TEST_ADMIN_URL } from './testEnv.ts';

/** Çıktı tokeni istekteki `max_tokens`'ı aşamaz (gerçek sağlayıcı gibi). `text` verilmezse `{ value: 'ok' }`. */
type FakeReply = { usage?: { input_tokens: number; output_tokens: number }; delayMs?: number; text?: string };
const calls: Record<string, unknown>[] = [];
let defaultReply: FakeReply = {};

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          const r = defaultReply;
          return {
            currentMessage: undefined,
            finalMessage: async () => {
              if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
              const u = r.usage ?? { input_tokens: 1000, output_tokens: 1000 };
              return {
                model: 'claude-sonnet-5-5',
                stop_reason: 'end_turn',
                usage: { input_tokens: u.input_tokens, output_tokens: Math.min(u.output_tokens, Number(params.max_tokens)) },
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
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'AI_DAILY_BUDGET_TRY', 'AI_CONCURRENCY_PER_ORG', 'AI_PRICE_TRY_PER_USD', 'AI_PRICE_TABLE', 'API_RATE_LIMIT', 'AI_RATE_OTHER_PER_MIN'];
const saved: Record<string, string | undefined> = {};
/** Sonnet 5.5, kur 100: girdi tokeni 200, çıktı 1.000 mikro TL. 500 girdi + 12.000 çıktı = 12,10 TL. */
const EXPENSIVE = { input_tokens: 500, output_tokens: 12_000 };
const TL = 1_000_000;

let app: FastifyInstance;
let A: Awaited<ReturnType<typeof registerCompany>>;
let B: Awaited<ReturnType<typeof registerCompany>>;
let F: Awaited<ReturnType<typeof registerCompany>>;

const errors: { obj: unknown; msg?: string }[] = [];
const log: MeterLog = { warn: () => undefined, error: (obj, msg) => void errors.push({ obj, msg }) };
const budgetLines = () => errors.filter((e) => e.msg?.startsWith('ai-daily-budget-reached'));
const ctxOf = (who: { companyId: string; userId: string }, over: Partial<AiCallContext> = {}): AiCallContext => ({
  companyId: who.companyId,
  memberId: who.userId,
  kind: 'INVOICE_MAPPING',
  limits: {},
  log,
  ...over,
});
const opts = (content: string, maxTokens = 100) => ({ schema, system: 'sys', maxTokens, effort: 'low' as const, content: [{ type: 'text' as const, text: content }] });
const call = (ctx: AiCallContext, content: string, cache = false, maxTokens = 100) => meteredCall(ctx, { ...opts(content, maxTokens), cache });
/** PDF fatura grubu gibi: base64 belge + kısa metin, `maxTokens` 64.000 (`services/ai.ts` `readInvoicePdfPart`). */
const pdfOpts = (data: Buffer) => ({
  schema,
  system: 'sys',
  maxTokens: 64_000,
  effort: 'medium' as const,
  content: [
    { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: data.toString('base64') } },
    { type: 'text' as const, text: 'Extract every shipment line printed on these pages.' },
  ],
});
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'OK' : (r.reason as { code?: string }).code);

/** Dolgu firmasına `tl` tutarında satır (sistem toplamına girer; çağıran firmanın kotasına girmez). */
const spend = (tl: number, createdAt: Date = new Date(), period = aiPeriodOf(createdAt, 'Europe/Istanbul')) =>
  inCompany(F.companyId, () =>
    prisma.aiUsage.create({
      data: { companyId: F.companyId, kind: 'INVOICE_PDF', status: 'OK', period, model: 'claude-sonnet-5-5', cost: new Prisma.Decimal(tl), priceVersion: 'test', durationMs: 1, createdAt },
      select: { id: true },
    }),
  );
const rowCount = (companyId: string) => inCompany(companyId, () => prisma.aiUsage.count({ where: { companyId } }));

/** Sahte duvar saati (yalnız `Date`; zamanlayıcılar gerçek). */
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

const clear = (companyId: string) =>
  inCompany(companyId, async () => {
    await prisma.aiUsage.deleteMany({});
    await prisma.aiResultCache.deleteMany({});
  });

beforeAll(async () => {
  app = await getApp();
  A = await registerCompany(app, 'Tavan A');
  B = await registerCompany(app, 'Tavan B');
  F = await registerCompany(app, 'Tavan dolgu');
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  delete process.env.AI_PRICE_TRY_PER_USD;
  delete process.env.AI_PRICE_TABLE;
  calls.length = 0;
  errors.length = 0;
  defaultReply = {};
  resetAiMeterState();
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(async () => {
  resetAiMeterState();
  for (const c of [A, B, F]) await clear(c.companyId);
});

describe('günlük tavan', () => {
  it('tavan altı geçer; dolunca sağlayıcı çağrılmadan, satır yazılmadan ayrı kodla (AI_DAILY_BUDGET) reddedilir; firma kotası dolmuş sayılmaz', async () => {
    at('2031-03-01T09:00:00+03:00');
    process.env.AI_DAILY_BUDGET_TRY = '100';
    await spend(99.8);
    const ok = await call(ctxOf(A), 'bir');
    expect(ok.cached).toBe(false);
    expect(calls).toHaveLength(1);
    const before = await rowCount(A.companyId);
    // 99,80 + 0,30 (1.000 girdi + 100 çıktı) = 100,10 >= 100: yeni çağrı durur, başka firmada da (sistemin toplamı)
    for (const who of [A, B]) {
      const err = await call(ctxOf(who), `iki-${who.companyId}`).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 429, code: 'AI_DAILY_BUDGET', details: { resetsAt: '2031-03-01T21:00:00.000Z' } });
      expect((err as Error).message).toBe('Yapay zekâ bugün için durduruldu; yarın yeniden açılır. Elle giriş ve Excel/CSV yükleme çalışır.');
      // ayrıntıda tutar yok (ölçüm rolü de görür)
      expect(Object.keys((err as { details: object }).details)).toEqual(['resetsAt']);
    }
    expect(calls).toHaveLength(1);
    expect(await rowCount(A.companyId)).toBe(before);
    expect(await rowCount(B.companyId)).toBe(0);
    const quota = await aiAllowance(B.companyId, {});
    expect(quota.exhausted || quota.failedExhausted).toBe(false);
  });

  it('önbellekten gelen ücretsiz sonuç tavan doluyken de döner; yeni içerik durur', async () => {
    at('2031-03-02T10:00:00+03:00');
    process.env.AI_DAILY_BUDGET_TRY = '100';
    expect((await call(ctxOf(A, { kind: 'INVOICE_PDF' }), 'onbellek', true)).cached).toBe(false);
    await spend(500);
    // başka kopyanın harcaması gibi: süreç içi toplam yenilenince görünür
    vi.setSystemTime(new Date(Date.now() + AI_DAILY_BUDGET_REFRESH_MS + 1000));
    const hit = await call(ctxOf(A, { kind: 'INVOICE_PDF' }), 'onbellek', true);
    expect(hit).toMatchObject({ cached: true, data: { value: 'ok' } });
    expect(calls).toHaveLength(1);
    await expect(call(ctxOf(A, { kind: 'INVOICE_PDF' }), 'yeni', true)).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    expect(calls).toHaveLength(1);
  });

  it('off: tavan yok (toplam ne olursa olsun çağrı yapılır)', async () => {
    at('2031-03-03T10:00:00+03:00');
    process.env.AI_DAILY_BUDGET_TRY = 'OFF';
    expect(env.aiDailyBudgetTry).toBeNull();
    await spend(1_000_000);
    await call(ctxOf(A), 'off');
    expect(calls).toHaveLength(1);
  });

  it('varsayılan 1.000 TL (yok ya da boş); 0 hiç sağlayıcı çağrısı yaptırmaz; bozuk değer açılışı durdurur, süreçte sınırsıza düşmez', async () => {
    for (const v of [undefined, '', '   ']) {
      if (v === undefined) delete process.env.AI_DAILY_BUDGET_TRY;
      else process.env.AI_DAILY_BUDGET_TRY = v;
      expect(env.aiDailyBudgetTry).toBe(AI_DAILY_BUDGET_DEFAULT_TRY);
    }
    expect(AI_DAILY_BUDGET_DEFAULT_TRY).toBe(1000);
    for (const [raw, value] of [['0', 0], ['1500', 1500], ['250.50', 250.5], ['off', null], [' Off ', null]] as const) expect(parseAiDailyBudget(raw), raw).toEqual({ ok: true, value });
    for (const bad of ['-5', 'abc', '1e3', '0x10', '5,5', 'false', 'unlimited', 'none', '1.005', 'Infinity']) {
      expect(parseAiDailyBudget(bad), bad).toEqual({ ok: false });
      expect(invalidEnv({ AI_DAILY_BUDGET_TRY: bad }), bad).toEqual(['AI_DAILY_BUDGET_TRY (a TRY amount such as 1000 or 250.50, or off)']);
      process.env.AI_DAILY_BUDGET_TRY = bad;
      expect(env.aiDailyBudgetTry, bad).toBe(AI_DAILY_BUDGET_DEFAULT_TRY);
    }
    expect(invalidEnv({})).toEqual([]);
    expect(invalidEnv({ AI_DAILY_BUDGET_TRY: 'off' })).toEqual([]);

    // varsayılan tavan gerçekten uygulanır
    at('2031-03-04T10:00:00+03:00');
    delete process.env.AI_DAILY_BUDGET_TRY;
    await spend(1000);
    await expect(call(ctxOf(A), 'varsayilan')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    // 0: o gün hiç harcama yokken de durur
    resetAiMeterState();
    at('2031-03-05T10:00:00+03:00');
    process.env.AI_DAILY_BUDGET_TRY = '0';
    await expect(call(ctxOf(A), 'sifir')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    expect(calls).toHaveLength(0);
  });

  it('gün dönümü: sistem günü Europe/Istanbul (firmanın saat dilimi değil); gece yarısı yeni gün açılır, önceki dönemin satırı da sayılır', async () => {
    expect(aiSystemDay(new Date('2031-03-06T20:59:59Z')).day).toBe('2031-03-06');
    expect(aiSystemDay(new Date('2031-03-06T21:00:00Z'))).toEqual({ day: '2031-03-07', start: new Date('2031-03-06T21:00:00Z'), end: new Date('2031-03-07T21:00:00Z') });
    process.env.AI_DAILY_BUDGET_TRY = '10';
    at('2031-03-06T23:59:00+03:00');
    await spend(10);
    await expect(call(ctxOf(A), 'gece')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET', details: { resetsAt: '2031-03-06T21:00:00.000Z' } });
    vi.setSystemTime(new Date('2031-03-07T00:00:30+03:00'));
    await call(ctxOf(A), 'sabah');
    expect(calls).toHaveLength(1);

    // Ay dönümü: İstanbul'da 1 Nisan 00:30, New York saatli firmanın satırı hâlâ Mart dönemiyle yazılır; yine bugüne sayılır.
    resetAiMeterState();
    at('2031-04-01T00:40:00+03:00');
    const createdAt = new Date('2031-03-31T21:30:00Z');
    expect(aiPeriodOf(createdAt, 'America/New_York')).toBe('2031-03');
    await spend(10, createdAt, '2031-03');
    await expect(call(ctxOf(A), 'nisan')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
  });

  it('üst sınır payı: maxTokens × çıktı fiyatı + istek boyundan tahmini girdi; gerçek tutar bunu aşmaz', () => {
    // 12.000 çıktı = 12 TL; girdi: ("sys" + içerik + JSON şeması) / 2 + 1.000 token, önbelleğe yazma fiyatıyla (250 mikro TL)
    const upper = aiCallUpperMicros(opts('pahali-0', 12_000));
    expect(upper).toBeGreaterThan(12 * TL);
    expect(upper).toBeLessThan(12.4 * TL);
    expect(upper).toBeGreaterThan(500 * 200 + 12_000 * 1000); // EXPENSIVE'in gerçek tutarı (12,10 TL)
    // PDF grubu: 64.000 çıktı (64 TL) + 100 KB'lık belge (base64 ~136 KB -> ~69.000 token ~17 TL)
    const pdf = aiCallUpperMicros(pdfOpts(Buffer.alloc(100_000, 7)));
    expect(pdf / TL).toBeGreaterThan(80);
    expect(pdf / TL).toBeLessThan(82);
    // girdi tahmini bağlam penceresinde durur (200.000 token = 50 TL): 64 + 50 = 114 TL
    expect(aiCallUpperMicros(pdfOpts(Buffer.alloc(5_000_000, 7)))).toBe(64 * TL + AI_UPPER_INPUT_TOKENS_CAP * 250);
  });

  it('yarış (soğuk başlangıç, pahalı çağrılar): 60 eşzamanlı çağrıdan yalnız tavana sığanlar gider; aşım en çok bir çağrının üst sınırı', async () => {
    process.env.AI_CONCURRENCY_PER_ORG = '100';
    process.env.AI_DAILY_BUDGET_TRY = '100';
    at('2031-03-08T10:00:00+03:00');
    defaultReply = { usage: EXPENSIVE, delayMs: 30 };
    const upper = aiCallUpperMicros(opts('pahali-0', 12_000));
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => call(ctxOf(A), `pahali-${i}`, false, 12_000)));
    const admitted = results.filter((r) => r.status === 'fulfilled').length;
    // k. çağrı (k-1) × üst sınır < 100 TL iken kabul edilir: ceil(100 / ~12,27) = 9
    expect(admitted).toBe(Math.ceil((100 * TL) / upper));
    expect(admitted).toBe(9);
    expect(calls).toHaveLength(admitted);
    // geri kalanlar harcanan tavanın altındayken reddedildi: geçici "yoğun" (süren çağrıların payı), kesin ret değil
    expect(new Set(results.filter((r) => r.status === 'rejected').map(codeOf))).toEqual(new Set(['AI_BUSY']));
    const spent = admitted * (500 * 200 + 12_000 * 1000);
    expect(spent).toBe(108_900_000);
    // ölçülen aşım 8,90 TL; sınır: bir çağrının üst sınırı (~12,27 TL)
    expect(spent - 100 * TL).toBeLessThanOrEqual(upper);
    // süren çağrılar bitti: artık kesin ret
    await expect(call(ctxOf(A), 'pahali-son', false, 12_000)).rejects.toMatchObject({ statusCode: 429, code: 'AI_DAILY_BUDGET' });
    expect(calls).toHaveLength(admitted);

    // tavana yakın başlangıç: 95 TL harcanmışken aynı patlama yalnız bir çağrı geçirir (107,10 TL)
    resetAiMeterState();
    calls.length = 0;
    at('2031-03-09T10:00:00+03:00');
    await spend(95);
    const near = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => call(ctxOf(A), `yakin-${i}`, false, 12_000)));
    expect(near.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(95 * TL + 12.1 * TL - 100 * TL).toBeLessThanOrEqual(upper);
  });

  it('1.000 TL varsayılan tavanda olağan kullanım reddedilmez: 20 PDF grubu, aynı anda 4 (64.000 çıktı tokeni payı)', async () => {
    delete process.env.AI_DAILY_BUDGET_TRY;
    process.env.AI_CONCURRENCY_PER_ORG = '4';
    at('2031-05-20T10:00:00+03:00');
    // gerçekçi PDF grubu: 20.000 girdi + 8.000 çıktı = 12 TL
    defaultReply = { usage: { input_tokens: 20_000, output_tokens: 8_000 }, delayMs: 20 };
    const codes: unknown[] = [];
    for (let round = 0; round < 5; round++) {
      const r = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => meteredCall(ctxOf(B, { kind: 'INVOICE_PDF' }), { ...pdfOpts(Buffer.alloc(100_000, round * 4 + i)), cache: false })));
      codes.push(...r.map(codeOf));
    }
    expect(codes).toEqual(Array(20).fill('OK'));
    expect(calls).toHaveLength(20);
    // 240 TL harcandı; 4 × ~81 TL pay ile 1.000 TL'ye ~436 TL kala ilk geçici ret görülür
  });

  it("günlüğe tavan o gün bu süreçte ilk dolduğunda tek 'error' satırı; ertesi gün yeniden", async () => {
    process.env.AI_DAILY_BUDGET_TRY = '10';
    at('2031-03-10T10:00:00+03:00');
    await spend(10);
    for (const c of ['g1', 'g2', 'g3']) await expect(call(ctxOf(A), c)).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    expect(budgetLines()).toHaveLength(1);
    expect(budgetLines()[0]!.obj).toMatchObject({ day: '2031-03-10', budgetTry: 10, spentTry: 10 });
    vi.setSystemTime(new Date('2031-03-11T10:00:00+03:00'));
    await spend(10);
    for (const c of ['h1', 'h2']) await expect(call(ctxOf(A), c)).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    expect(budgetLines()).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it('süren iş: tavandan önce açılmış arka plan işi tavanın %20 üstüne kadar sürer, sonra durur; tavandan sonra açılan iş durur', async () => {
    expect(AI_DAILY_BUDGET_JOB_GRACE).toBe(0.2);
    process.env.AI_DAILY_BUDGET_TRY = '10';
    at('2031-03-12T10:00:00+03:00');
    const early = new Date(Date.now() - 60_000);
    await spend(9.8);
    const jobCall = (createdAt: Date, content: string) => {
      const ctx = { ...aiJobContext({ companyId: A.companyId, createdById: A.userId, createdAt, input: {} }, 'INVOICE_PDF'), log };
      // 1.000 girdi + 1.000 çıktı = 1,20 TL
      return runInJobScope({ jobId: `job-${createdAt.getTime()}`, createdAt }, () => call(ctx, content, false, 1000));
    };
    await call(ctxOf(A), 'istek-1'); // 9,80 + 0,30 = 10,10
    await expect(call(ctxOf(A), 'istek-2')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    // erken iş: 10,10 -> 11,30 (< 12) -> 12,50; sonra o da durur
    await jobCall(early, 'is-1');
    await jobCall(early, 'is-2');
    await expect(jobCall(early, 'is-3')).rejects.toMatchObject({ statusCode: 429, code: 'AI_DAILY_BUDGET' });
    expect(calls).toHaveLength(3);
    // tavan dolduktan sonra açılan iş pay almaz
    resetAiMeterState();
    calls.length = 0;
    at('2031-03-13T10:00:00+03:00');
    await spend(10);
    await expect(call(ctxOf(A), 'dolu')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    await expect(jobCall(new Date(Date.now() + 1), 'gec-is')).rejects.toMatchObject({ code: 'AI_DAILY_BUDGET' });
    expect(calls).toHaveLength(0);
  });
});

describe('veritabanı kapısı ve destek komutu', () => {
  it('bütçe kapısı yalnız son 2 günün AiUsage satırlarını okur; başka tablo ve yazma kapalı; kapıyı yalnız aiDailyBudget.ts açar', async () => {
    const recent = await spend(1);
    const old = await spend(1, new Date(Date.now() - 3 * 86_400_000));
    const seen = await withAiBudgetScope(() => prisma.aiUsage.findMany({ where: { id: { in: [recent.id, old.id] } }, select: { id: true } }));
    expect(seen).toEqual([{ id: recent.id }]);
    expect(await withAiBudgetScope(() => prisma.company.count())).toBe(0);
    expect(await withAiBudgetScope(() => prisma.aiCreditEntry.count())).toBe(0);
    expect(await withAiBudgetScope(() => prisma.aiResultCache.count())).toBe(0);
    expect(await withAiBudgetScope(() => prisma.member.count())).toBe(0);
    await expect(
      withAiBudgetScope(() =>
        prisma.aiUsage.create({ data: { companyId: F.companyId, kind: 'INVOICE_PDF', status: 'OK', period: '2031-01', model: 'x', cost: 1, priceVersion: 't', durationMs: 1 } }),
      ),
    ).rejects.toThrow();
    expect(await withAiBudgetScope(() => prisma.aiUsage.updateMany({ where: { id: recent.id }, data: { durationMs: 2 } }))).toEqual({ count: 0 });
    expect(await withAiBudgetScope(() => prisma.aiUsage.deleteMany({ where: { id: recent.id } }))).toEqual({ count: 0 });

    const SRC = path.resolve(import.meta.dirname, '../src');
    const files = fs
      .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('generated'))
      .map((f) => f.replace(/\\/g, '/'));
    const code = (f: string) =>
      fs
        .readFileSync(path.join(SRC, f), 'utf8')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    expect(files.filter((f) => f !== 'db.ts' && /\bwithAiBudgetScope\b/.test(code(f)))).toEqual(['services/aiDailyBudget.ts']);
  });

  it('destek komutu (ai:usage) günün toplamını ve tavanı yazar (ASCII); off ve dolu hâli', async () => {
    const run = async () => {
      const out: string[] = [];
      expect(await runAiUsageCli(['usage', '--company', F.companyId], { log: (l) => out.push(l), error: (l) => out.push(l) })).toBe(0);
      const text = out.join('\n');
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      return text;
    };
    process.env.AI_DAILY_BUDGET_TRY = '1000000';
    expect(await run()).toMatch(/Today \d{4}-\d{2}-\d{2} \(Europe\/Istanbul\), all companies: \d+\.\d{2} TRY of AI_DAILY_BUDGET_TRY=1000000 \(\d+%\)\.$/m);
    process.env.AI_DAILY_BUDGET_TRY = 'off';
    expect(await run()).toMatch(/AI_DAILY_BUDGET_TRY=off \(no daily cap\)/);
    process.env.AI_DAILY_BUDGET_TRY = '0';
    expect(await run()).toMatch(/DAILY-BUDGET-FULL/);
  });

  it('/me yapay zekâ alanı şekli değişmez: tavan dolunca da available (yapılandırıldı) ve firmanın kotası dolmuş görünmez', async () => {
    process.env.AI_DAILY_BUDGET_TRY = '0';
    const me = (await app.inject({ method: 'GET', url: '/api/deciship/me', headers: A.auth })).json();
    expect(me.ai).toEqual({ available: true, quotaExhausted: false });
    expect(me.aiAvailable).toBe(true);
  });
});

describe('inceleme bulguları', () => {
  it('tavan reddi (kesin ya da geçici) kişinin dakika hız sınırı hakkından düşmez; sınır yine işler', async () => {
    process.env.API_RATE_LIMIT = 'on';
    process.env.AI_RATE_OTHER_PER_MIN = '3';
    process.env.AI_DAILY_BUDGET_TRY = '0';
    at('2031-03-14T10:00:00+03:00');
    const codes: unknown[] = [];
    for (let i = 0; i < 4; i++) codes.push(codeOf(await Promise.allSettled([call(ctxOf(A), `hiz-${i}`)]).then((r) => r[0]!)));
    expect(codes).toEqual(Array(4).fill('AI_DAILY_BUDGET'));
    // geçici ret (süren çağrının payı) de hak yemez
    resetAiMeterState();
    process.env.AI_DAILY_BUDGET_TRY = '1';
    defaultReply = { delayMs: 50 };
    const slow = call(ctxOf(A), 'hiz-uzun', false, 1000); // pay ~1,27 TL >= 1 TL
    expect(codeOf((await Promise.allSettled([call(ctxOf(A), 'hiz-mesgul')]))[0]!)).toBe('AI_BUSY');
    await slow;
    process.env.AI_DAILY_BUDGET_TRY = 'off';
    defaultReply = {};
    const after: unknown[] = [];
    for (let i = 0; i < 3; i++) after.push(codeOf((await Promise.allSettled([call(ctxOf(A), `hiz-sonra-${i}`)]))[0]!));
    // dakikada 3: uzun çağrı 1 hak yedi, sonra 2 çağrı geçer, üçüncüsü dakika sınırında
    expect(after).toEqual(['OK', 'OK', 'TOO_MANY_REQUESTS']);
  });

  it('açılış denetimi: tavan açıkken okuma ilkesi (AiUsage.ai_budget_read) yoksa şema sorunu, servis açılmaz; off iken aranmaz', async () => {
    const query = (sql: string) => prisma.$queryRaw<Record<string, unknown>[]>(Prisma.raw(sql));
    const policyProblems = async (o?: { aiDailyBudget?: boolean }) => (await schemaProblems(query, o)).filter((p) => p.includes('ai_budget_read'));
    process.env.AI_DAILY_BUDGET_TRY = '10';
    expect(await policyProblems()).toEqual([]);
    const adm = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await adm.connect();
    try {
      await adm.query(`DROP POLICY ai_budget_read ON "deciship"."AiUsage"`);
      expect(await policyProblems()).toHaveLength(1);
      expect(await policyProblems({ aiDailyBudget: true })).toHaveLength(1);
      process.env.AI_DAILY_BUDGET_TRY = 'off';
      expect(await policyProblems()).toEqual([]);
      // ilke yokken toplam sessizce 0 görünür (bulgunun kendisi): denetim bu yüzden açılışta
      process.env.AI_DAILY_BUDGET_TRY = '10';
      const recent = await spend(500);
      expect(await withAiBudgetScope(() => prisma.aiUsage.count({ where: { id: recent.id } }))).toBe(0);
    } finally {
      await adm.query(
        `CREATE POLICY ai_budget_read ON "deciship"."AiUsage" FOR SELECT USING (current_setting('app.scope', true) = 'ai_budget' AND "createdAt" >= (now() AT TIME ZONE 'UTC') - interval '2 days')`,
      );
      await adm.end();
    }
    expect(await policyProblems()).toEqual([]);
  });

  it('arka plan işi tavana takılınca aynı iletiyle FAILED biter, kendiliğinden yeniden denenmez; kullanıcı yeniden başlatabilir', async () => {
    // gerçek saat (oturum jetonu); 0 TL: ilk sağlayıcı çağrısı reddedilir
    process.env.AI_DAILY_BUDGET_TRY = '0';
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: A.auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
    expect(c.statusCode, c.body).toBe(201);
    const carrierId = c.json().carrier.id as string;
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ['FATURA 9-482-11735', '794812345305 20.10.2026 1.642,50', `ref ${uniq('t')}`].forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
    const pdf = Buffer.from(await doc.save());
    const preview = () => {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
      ]);
      return app.inject({ method: 'POST', url: '/api/deciship/invoices/preview?async=1', headers: { ...A.auth, ...form.headers }, payload: form.payload });
    };
    const blank = { shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null, billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null };
    defaultReply = { text: JSON.stringify({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: null, amountsIncludeVat: false, lines: [{ ...blank, trackingNo: '794812345305', netAmount: 1642.5 }] }) };

    const r = await preview();
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job).toMatchObject({
      status: 'FAILED',
      attempt: 1,
      error: { statusCode: 429, code: 'AI_DAILY_BUDGET', message: 'Yapay zekâ bugün için durduruldu; yarın yeniden açılır. Elle giriş ve Excel/CSV yükleme çalışır.' },
    });
    expect(calls).toHaveLength(0);
    // kuyruğa dönmedi (ertesi gün kendiliğinden sürmez)
    const row = await inCompany(A.companyId, () => prisma.job.findFirst({ where: { id: job.id }, select: { status: true, runAfter: true, attempts: true } }));
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });

    // tavan açılınca kullanıcı aynı dosyayla yeniden başlatır: yeni iş, sağlayıcıya gider
    process.env.AI_DAILY_BUDGET_TRY = 'off';
    const again = (await preview()).json();
    expect(again.joined).toBe(false);
    expect(again.job.id).not.toBe(job.id);
    expect(again.job.status, JSON.stringify(again.job.error)).toBe('SUCCEEDED');
    expect(calls).toHaveLength(1);
  });
});
