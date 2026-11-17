/**
 * Mesaj 5 (07-B2, 05-B7, 05-B14): sağlayıcının kısa kesintisi arka plan işini öldürmez, kullanıcıyı 30 dk kilitlemez, çift
 * ücret doğurmaz. Sağlayıcı sahtedir (gerçek çağrı yok); çalıştırıcı satır içi (`JOB_RUNNER=inline`): ilk deneme başlatan
 * istekte, yeniden deneme `kickJob` ile (satır içi kip `runAfter`'ı beklemez; bekleme süresi satırdan okunur, uyku yok).
 */
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../src/db.ts';
import { absolutePath, sha256 } from '../src/lib/storage.ts';
import { AI_MAX_REQUEST_BYTES, meteredCall, resetAiMeterState, type AiCallContext, type MeterLog } from '../src/services/aiMeter.ts';
import { AI_RETRY_AFTER_MAX_MS, AI_RETRY_DELAYS_MS, isTransientJobError, retryDelayMs } from '../src/services/jobs/runner.ts';
import { AppError } from '../src/errors.ts';
import { createWorker, getApp, inCompany, JPEG, multipart, registerCompany, uniq } from './helpers.ts';

// ---------- sahte sağlayıcı ----------

type Reply = {
  text?: string;
  stop_reason?: string;
  usage?: Record<string, unknown>;
  error?: unknown;
  /** akış koptuğunda SDK'nın elindeki yarım mesaj (`stream.currentMessage`); `error` ile birlikte */
  partial?: { text: string; usage: Record<string, unknown> };
  /** yanıt hiç gelmez; istek kesilince (toplam süre sınırı) SDK'nın kesme hatası */
  hang?: boolean;
};
const calls: { user: string }[] = [];
/** Sırayla kullanılır; boşsa `reply`. */
const queue: Reply[] = [];
let reply: (user: string) => Reply = () => ({});
let sdk: typeof import('@anthropic-ai/sdk');

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          const msgs = (params.messages ?? []) as { content: { type: string; text?: string }[] }[];
          const user = msgs.flatMap((x) => x.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
          calls.push({ user });
          const r = queue.shift() ?? reply(user);
          return {
            currentMessage: r.partial ? { model: 'claude-sonnet-5-5', usage: r.partial.usage, content: [{ type: 'text', text: r.partial.text }] } : undefined,
            finalMessage: async () => {
              if (r.hang) await new Promise<void>((_res, rej) => opts?.signal?.addEventListener('abort', () => rej(new actual.APIUserAbortError())));
              if (r.error) throw r.error;
              return {
                model: 'claude-sonnet-5-5',
                stop_reason: r.stop_reason ?? 'end_turn',
                usage: r.usage ?? { input_tokens: 1000, output_tokens: 300 },
                content: [{ type: 'text', text: r.text ?? '{}' }],
              };
            },
          };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const overloaded = (headers: Record<string, string> = {}) =>
  sdk.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(headers));

// ---------- PDF ve önizleme ----------

const API = '/api/deciship';
const blank = {
  shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
  billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null,
};
const aiLine = (trackingNo: string, netAmount: number) => ({ ...blank, trackingNo, netAmount });
const invoiceAi = (lines: unknown[], amountsIncludeVat: boolean | null = false) =>
  JSON.stringify({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', amountsIncludeVat, lines });

const TRACK = ['794812345305', '794812345316'];
/** Metin katmanlı, sayfa başına bir gönderi; her testte farklı bayt (önbellek ve hatırlama karışmasın). */
async function invoicePdf(pages: number, tag = uniq('t')): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    ['FATURA 9-482-11735', `${TRACK[i]} 20.10.2026 1.642,50`, `ref ${tag} sayfa ${i + 1}`].forEach((r, j) => page.drawText(r, { x: 40, y: 800 - j * 18, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

let app: FastifyInstance;
let admin: Awaited<ReturnType<typeof registerCompany>>;
let carrierId: string;

function previewReq(pdf: Buffer, query = '?async=1') {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
  ]);
  return app.inject({ method: 'POST', url: `${API}/invoices/preview${query}`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
}
const jobOf = (id: string) => app.inject({ method: 'GET', url: `${API}/jobs/${id}`, headers: admin.auth }).then((r) => r.json());
const jobRow = (id: string) => inCompany(admin.companyId, () => prisma.job.findFirstOrThrow({ where: { id } }));
const filesWithSha = (sha: string) => inCompany(admin.companyId, () => prisma.file.findMany({ where: { companyId: admin.companyId, sha256: sha }, select: { id: true, path: true } }));
const usageFor = (refId: string) =>
  inCompany(admin.companyId, () =>
    prisma.aiUsage.findMany({ where: { companyId: admin.companyId, refId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { status: true, errorCode: true, cost: true } }),
  );
const kick = async (id: string) => (await import('../src/services/jobs/queue.ts')).kickJob(id);

// ---------- doğrudan sayaç çağrısı ----------

const schema = z.object({ value: z.string() });
const silent: MeterLog = { warn: () => undefined, error: () => undefined };
const ctxOf = (over: Partial<AiCallContext> = {}): AiCallContext => ({ companyId: admin.companyId, memberId: admin.userId, kind: 'TARIFF_REVIEW', limits: {}, log: silent, ...over });
const call = (content: string, over: Partial<AiCallContext> = {}) =>
  meteredCall(ctxOf(over), { schema, system: 'sys', maxTokens: 100, effort: 'low', content: [{ type: 'text', text: content }] });
const ok = (value = 'ok'): Reply => ({ text: JSON.stringify({ value }) });

const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'PDF_INVOICE_PAGES_PER_CALL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  sdk = await import('@anthropic-ai/sdk');
  app = await getApp();
  admin = await registerCompany(app, uniq('Kesinti '));
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  calls.length = 0;
  queue.length = 0;
  reply = () => ok();
  resetAiMeterState();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => resetAiMeterState());

describe('07-B2: sağlayıcının geçici hatası işte geçici', () => {
  it('529, 429 (retry-after), ulaşılamadı, bağlantı zaman aşımı ve sayaç sigortası iş için geçici; ret, kesilme, kota, anahtar kalıcı', async () => {
    const { aiFailed } = await import('../src/services/ai.ts');
    const busy = aiFailed(overloaded());
    expect(busy).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(busy)).toBe(true);
    const limited = aiFailed(sdk.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, undefined, new Headers({ 'retry-after': '45' })));
    expect(limited).toMatchObject({ statusCode: 503, code: 'AI_BUSY', retryAfter: 45 });
    expect(isTransientJobError(limited)).toBe(true);
    expect(isTransientJobError(aiFailed(new sdk.APIConnectionError({ message: 'ECONNRESET' })))).toBe(true);
    const connectTimeout = aiFailed(new sdk.APIConnectionTimeoutError());
    expect(connectTimeout).toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    expect(isTransientJobError(connectTimeout)).toBe(true);
    // sağlayıcının kendi sunucu hatası geçici; istek hatası (400) kalıcı
    const server = aiFailed(sdk.APIError.generate(500, { type: 'error', error: { type: 'api_error', message: 'x' } }, undefined, new Headers()));
    expect(server).toMatchObject({ statusCode: 502, code: 'AI_FAILED', details: { status: 500 } });
    expect(isTransientJobError(server)).toBe(true);
    expect(isTransientJobError(aiFailed(sdk.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, undefined, new Headers())))).toBe(false);
    const key =aiFailed(sdk.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, undefined, new Headers()));
    expect(key).toMatchObject({ statusCode: 503, code: 'AI_DISABLED' });
    for (const e of [key, new AppError(422, 'AI_TRUNCATED', 'x'), new AppError(422, 'AI_REFUSED', 'x'), new AppError(504, 'AI_FAILED', 'x'), new AppError(429, 'AI_QUOTA_EXCEEDED', 'x')]) {
      expect(isTransientJobError(e), e.code).toBe(false);
    }
  });

  it('bekleme artar (30 sn, 2 dk, 5 dk, 10 dk) ±%20 rastgele; sağlayıcının retry-after değeri daha uzunsa o, en çok 15 dk; diğer geçici hatalar eskisi gibi', async () => {
    const { AiTransientError } = await import('../src/services/ai.ts');
    const e = new AiTransientError(503, 'AI_BUSY', 'x');
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5].map((a) => retryDelayMs(e, a, mid))).toEqual([30_000, 120_000, 300_000, 600_000, 600_000]);
    expect(AI_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 300_000, 600_000]);
    // kayma: en düşük %80, en yüksek %120
    expect(retryDelayMs(e, 1, () => 0)).toBe(24_000);
    expect(retryDelayMs(e, 1, () => 0.999_999)).toBe(36_000);
    expect(retryDelayMs(e, 2, () => 0.25)).toBe(108_000);
    expect(retryDelayMs(new AiTransientError(503, 'AI_BUSY', 'x', 45), 1, mid)).toBe(45_000);
    expect(retryDelayMs(new AiTransientError(503, 'AI_BUSY', 'x', 45), 2, mid)).toBe(120_000);
    expect(retryDelayMs(new AiTransientError(503, 'AI_BUSY', 'x', 86_400), 1, mid)).toBe(AI_RETRY_AFTER_MAX_MS);
    // diğer geçici hatalar kaymasız (eski kural)
    expect(retryDelayMs(new AppError(503, 'FILE_BUSY', 'x'), 2, () => 0)).toBe(20_000);
  });

  it('PDF okuması: 529 sonra başarı → iş kuyruğa döner (30 sn), sonra SUCCEEDED; tek OK ücret satırı, önizleme dosyası duruyor', async () => {
    const pdf = await invoicePdf(1);
    queue.push({ error: overloaded() });
    reply = () => ({ text: invoiceAi([aiLine(TRACK[0]!, 1642.5)]) });
    const r = await previewReq(pdf);
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(job.error).toBeUndefined();
    const row = await jobRow(job.id);
    expect(row.error).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    // 30 sn ± %20 (rastgele kayma)
    const wait = row.runAfter.getTime() - row.updatedAt.getTime();
    expect(wait).toBeGreaterThanOrEqual(24_000);
    expect(wait).toBeLessThanOrEqual(36_000);
    // temizlik kancası çalışmadı: önizleme dosyası satırda ve diskte
    const [file] = await filesWithSha(sha256(pdf));
    expect(file).toBeTruthy();
    expect(fs.existsSync(absolutePath(file!.path))).toBe(true);

    await kick(job.id);
    const done = await jobOf(job.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 2, result: { aiCached: false, fileId: file!.id } });
    expect(calls).toHaveLength(2);
    const usage = await usageFor(file!.id);
    expect(usage.map((u) => [u.status, u.errorCode])).toEqual([
      ['FAILED', 'AI_BUSY'],
      ['OK', null],
    ]);
    // aşırı yük ücretsiz: sonuç vermeyen satır 0 TL
    expect(usage[0]!.cost.toString()).toBe('0');
    expect(await filesWithSha(sha256(pdf))).toHaveLength(1);
  });

  it('çift ücret yok: "Yeniden oku" (fresh) iki gruplu okumada 1. grup ödendi, 2. grupta 529 → yeniden deneme 1. grubu CACHED (0 TL) alır', async () => {
    process.env.PDF_INVOICE_PAGES_PER_CALL = '1';
    const pdf = await invoicePdf(2);
    let failSecond = true;
    reply = (user) => {
      const second = /pages 2/.test(user);
      if (second && failSecond) {
        failSecond = false;
        return { error: overloaded() };
      }
      return { text: invoiceAi([aiLine(TRACK[second ? 1 : 0]!, 100)]) };
    };
    const r = await previewReq(pdf, '?async=1&fresh=1');
    expect(r.statusCode, r.body).toBe(202);
    const { job } = r.json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(2);
    await kick(job.id);
    const done = await jobOf(job.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
    expect(done.result.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(TRACK);
    // 1. grup sağlayıcıya ikinci kez gitmedi
    expect(calls).toHaveLength(3);
    const usage = await usageFor(job.ref.id);
    expect(usage.map((u) => [u.status, u.errorCode])).toEqual([
      ['OK', null],
      ['FAILED', 'AI_BUSY'],
      ['CACHED', null],
      ['OK', null],
    ]);
    expect(usage.filter((u) => u.status !== 'OK').map((u) => u.cost.toString())).toEqual(['0', '0']);
  });

  it('bağlantı zaman aşımı da işte yeniden denenir; deneme hakkı bitince kullanıcı asıl hatayı görür (JOB_ABANDONED değil)', async () => {
    const pdf = await invoicePdf(1);
    queue.push({ error: new sdk.APIConnectionTimeoutError() });
    reply = () => ({ error: overloaded() });
    const { job } = (await previewReq(pdf)).json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect((await jobRow(job.id)).error).toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    // son deneme: hep yoğun
    const max = (await jobRow(job.id)).maxAttempts;
    await inCompany(admin.companyId, () => prisma.job.updateMany({ where: { id: job.id }, data: { attempts: max - 1 } }));
    await kick(job.id);
    const failed = await jobOf(job.id);
    expect(failed).toMatchObject({ status: 'FAILED', attempt: max, error: { statusCode: 503, code: 'AI_BUSY' } });
    expect(failed.error.message).toMatch(/yoğun/);
    expect(calls).toHaveLength(2);
  });
});

describe('05-B7: ücretsiz hata hatırlanmaz, ücretli hata kendiliğinden yeniden denenmez', () => {
  it('bağlantı zaman aşımından sonra ikinci deneme sağlayıcıya gider (hatırlanmaz)', async () => {
    queue.push({ error: new sdk.APIConnectionTimeoutError() });
    await expect(call('zaman aşımı')).rejects.toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    await expect(call('zaman aşımı')).resolves.toMatchObject({ cached: false, data: { value: 'ok' } });
    expect(calls).toHaveLength(2);
    // aşırı yük de hatırlanmaz
    queue.push({ error: overloaded() });
    await expect(call('yoğun')).rejects.toMatchObject({ code: 'AI_BUSY' });
    await expect(call('yoğun')).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(4);
  });

  it('akış içi hata olayı (SDK: durum kodsuz APIError + tür): aşırı yük ve sağlayıcı hatası ücretsizse geçici', async () => {
    const inStream = (type: string) => new sdk.APIError(undefined, { type: 'error', error: { type, message: 'x' } }, undefined, new Headers(), type as never);
    const { aiFailed } = await import('../src/services/ai.ts');
    expect(aiFailed(inStream('overloaded_error'))).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(aiFailed(inStream('overloaded_error')))).toBe(true);
    expect(isTransientJobError(aiFailed(inStream('api_error')))).toBe(true);
    expect(isTransientJobError(aiFailed(inStream('invalid_request_error')))).toBe(false);
    // kullanıcının durdurması (APIUserAbortError da durum kodsuz APIError) geçici değil
    expect(isTransientJobError(aiFailed(new sdk.APIUserAbortError()))).toBe(false);
    queue.push({ error: inStream('overloaded_error') });
    const err = await call('akışta yoğun').catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(err)).toBe(true);
  });

  it('akış başlayıp koptu (kullanım > 0): akış içi aşırı yük, SDK kopma hatası, bağlantı hatası iş için kalıcı (ikinci ücret olmasın)', async () => {
    const paid = { text: '{"value":"ya', usage: { input_tokens: 500, output_tokens: 1 } };
    const cases: [string, unknown][] = [
      ['akış içi aşırı yük', new sdk.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error' as never)],
      ['SDK kopma (AnthropicError)', new sdk.AnthropicError('terminated')],
      ['bağlantı hatası', new sdk.APIConnectionError({ message: 'terminated' })],
    ];
    for (const [name, error] of cases) {
      queue.push({ error, partial: paid });
      const err = await call(`kopuk ${name}`).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(AppError);
      expect(isTransientJobError(err), name).toBe(false);
    }
    const rows = await inCompany(admin.companyId, () => prisma.aiUsage.findMany({ where: { companyId: admin.companyId, status: 'FAILED', inputTokens: 500 } }));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(Number(r.cost)).toBeGreaterThan(0);
  });

  it('hatırlanan süre dolması: "N dakika sonra yeniden deneyebilirsiniz" (çelişen "biraz sonra" yok, "dosya" denmez)', async () => {
    queue.push({ hang: true });
    const opts = { schema, system: 'sys', maxTokens: 100, effort: 'low' as const, content: [{ type: 'text' as const, text: 'asılı inceleme' }], timeoutMs: 50 };
    await expect(meteredCall(ctxOf(), opts)).rejects.toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    const again = await meteredCall(ctxOf(), opts).catch((e: unknown) => e);
    expect(again).toMatchObject({ statusCode: 504, code: 'AI_FAILED' });
    const msg = (again as Error).message;
    expect(msg).toMatch(/az önce zamanında okuyamadı; (29|30) dakika sonra yeniden deneyebilirsiniz/);
    expect(msg).not.toMatch(/biraz sonra|dosya/);
    expect(calls).toHaveLength(1);
  });

  it('hatırlanan kesilme: yeniden denemeye çağırmaz, nedenin önerisi (bölerek); details.retryAfter; tartı ucunda retry-after başlığı', async () => {
    const worker = await createWorker(app, admin.auth);
    const send = (lang = 'tr') => {
      const form = multipart([{ name: 'image', filename: 't.jpg', contentType: 'image/jpeg', data: JPEG }]);
      return app.inject({ method: 'POST', url: `${API}/vision/scale`, headers: { ...worker.auth, ...form.headers, 'accept-language': lang }, payload: form.payload });
    };
    reply = () => ({ stop_reason: 'max_tokens', text: '{', usage: { input_tokens: 100, output_tokens: 100 } });
    const first = await send();
    expect(first.statusCode, first.body).toBe(422);
    expect(first.json().error.code).toBe('AI_TRUNCATED');
    expect(first.headers['retry-after']).toBeUndefined();
    const again = await send();
    expect(again.statusCode, again.body).toBe(422);
    const e = again.json().error;
    expect(e.code).toBe('AI_TRUNCATED');
    expect(e.message).toContain('bölerek');
    expect(e.message).toMatch(/Aynı içerik az önce de okunamadı; aynısını yeniden göndermek sonucu değiştirmez/);
    expect(e.message).not.toMatch(/dakika sonra/);
    expect(e.details.retryAfter).toBeGreaterThan(29 * 60);
    expect(e.details.retryAfter).toBeLessThanOrEqual(30 * 60);
    expect(Number(again.headers['retry-after'])).toBe(e.details.retryAfter);
    const en = (await send('en')).json().error;
    expect(en.message).toMatch(/Split the file.*The same content could not be read just now either; sending it again will not change the result/);
    expect(calls).toHaveLength(1);
  });

  it('sayaç sigortası: 503 AI_BUSY, iş için geçici, retryAfter en çok 5 dk (sağlayıcı çağrılmaz)', async () => {
    const ghost: AiCallContext = { companyId: '00000000-0000-4000-8000-0000000000b5', memberId: null, kind: 'TARIFF_REVIEW', limits: {}, log: silent };
    for (const c of ['1', '2', '3']) await expect(call(c, ghost)).resolves.toMatchObject({ usageId: null });
    const blocked = await call('4', ghost).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(isTransientJobError(blocked)).toBe(true);
    const after = (blocked as { retryAfter: number }).retryAfter;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(300);
    expect(calls).toHaveLength(3);
  });
});

describe('inceleme B: iş içinde kesilen ya da reddedilen içerik en çok bir kez gönderilir (süreç belleği olmasa da)', () => {
  const dbNow = async () => (await prisma.$queryRaw<{ t: Date }[]>`SELECT now() AS t`)[0]!.t;

  it('iş bağlamında: kesilme ve ret veritabanındaki FAILED satırından hatırlanır; istek ve başka (sonraki) iş etkilenmez', async () => {
    const { runInJobScope } = await import('../src/services/jobs/jobScope.ts');
    const job = { jobId: 'job-b1', createdAt: await dbNow() };
    const inJob = (content: string) => runInJobScope(job, () => call(content, { origin: 'job' }));
    reply = () => ({ stop_reason: 'max_tokens', text: '{', usage: { input_tokens: 100, output_tokens: 100 } });
    await expect(inJob('uzun içerik')).rejects.toMatchObject({ code: 'AI_TRUNCATED' });
    reply = () => ({ stop_reason: 'refusal', text: '', usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(inJob('ret içerik')).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect(calls).toHaveLength(2);
    // süreç belleği yok (başka kopya, yeniden başlama, 30 dk geçti)
    resetAiMeterState();
    reply = () => ok();
    await expect(inJob('uzun içerik')).rejects.toMatchObject({ statusCode: 422, code: 'AI_TRUNCATED', message: expect.stringContaining('bölerek') });
    await expect(inJob('ret içerik')).rejects.toMatchObject({ statusCode: 422, code: 'AI_REFUSED' });
    expect(calls).toHaveLength(2);
    // istekten gelen çağrı (kullanıcı bilerek yeniden gönderdi) ve sonraki bir iş sağlayıcıya gider
    await expect(call('uzun içerik')).resolves.toMatchObject({ cached: false });
    const later = { jobId: 'job-b2', createdAt: new Date((await dbNow()).getTime() + 2 * 60_000) };
    await expect(runInJobScope(later, () => call('ret içerik', { origin: 'job' }))).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(4);
  });

  it('PDF: tek çağrı kesildi (ücretli) → ikiye bölündü → 2. sayfada 529 → bellek silindi → yeniden deneme tek çağrıyı yeniden göndermez', async () => {
    process.env.PDF_INVOICE_PAGES_PER_CALL = '2';
    const pdf = await invoicePdf(2);
    let failSecond = true;
    reply = (user) => {
      if (/Extract every shipment line of this invoice\./.test(user)) return { stop_reason: 'max_tokens', text: '{', usage: { input_tokens: 2000, output_tokens: 64000 } };
      const second = /pages 2/.test(user);
      if (second && failSecond) {
        failSecond = false;
        return { error: overloaded() };
      }
      return { text: invoiceAi([aiLine(TRACK[second ? 1 : 0]!, 100)], null) };
    };
    const { job } = (await previewReq(pdf)).json();
    expect(job).toMatchObject({ status: 'QUEUED', attempt: 1 });
    expect(calls).toHaveLength(3);
    resetAiMeterState();
    await kick(job.id);
    const done = await jobOf(job.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
    expect(done.result.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(TRACK);
    // yalnız düşen 2. sayfa yeniden gitti; ücretli kesilme bir kez
    expect(calls).toHaveLength(4);
    const usage = await usageFor(job.ref.id);
    expect(usage.filter((u) => u.errorCode === 'AI_TRUNCATED')).toHaveLength(1);
    expect(usage.map((u) => u.status)).toEqual(['FAILED', 'OK', 'FAILED', 'CACHED', 'OK']);
  });
});

describe('05-B14: sınır ve günlük', () => {
  it('sağlayıcının istek sınırını aşan PDF gönderilmez: 413 FILE_TOO_LARGE, "daha düşük çözünürlükle tarayın"; ücret satırı yok', async () => {
    const big = Buffer.alloc(Math.ceil((AI_MAX_REQUEST_BYTES * 3) / 4) + 1024).toString('base64');
    const err = await meteredCall(ctxOf({ kind: 'INVOICE_PDF' }), {
      schema,
      system: 'sys',
      maxTokens: 100,
      effort: 'low',
      cache: true,
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: big } },
        { type: 'text', text: 'oku' },
      ],
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE', details: { kind: 'aiRequest', limitMb: 32 } });
    expect((err as Error).message).toMatch(/daha düşük çözünürlükle tarayın/);
    expect(isTransientJobError(err)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await inCompany(admin.companyId, () => prisma.aiUsage.count({ where: { companyId: admin.companyId, kind: 'INVOICE_PDF', refId: null } }))).toBe(0);
  });

  it('anahtar geçersiz (401): kullanıcıya genel metin, günlüğe error (ai-key-invalid)', async () => {
    const errors: string[] = [];
    const log: MeterLog = { warn: () => undefined, error: (_o, msg) => errors.push(msg ?? '') };
    queue.push({ error: sdk.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers()) });
    await expect(call('anahtar', { log })).rejects.toMatchObject({ statusCode: 503, code: 'AI_DISABLED', message: expect.not.stringMatching(/key|anahtar|401/i) });
    expect(errors.some((e) => e.startsWith('ai-key-invalid'))).toBe(true);
  });
});
