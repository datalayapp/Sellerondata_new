import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiCallContext, AiKind } from '../src/services/aiMeter.ts';
import { getApp, registerCompany } from './helpers.ts';

const calls: Record<string, unknown>[] = [];
let nextText = '';
let nextError: unknown = null;
const clientOptions: Record<string, unknown>[] = [];

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    constructor(opts: Record<string, unknown>) {
      clientOptions.push(opts);
    }
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          if (nextError) {
            const e = nextError;
            nextError = null;
            return { finalMessage: async () => Promise.reject(e) };
          }
          return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: nextText }] }) };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

/** Sayaç gerçek firmaya yazar (Mesaj 6): her okuma bir firma bağlamıyla çağrılır. */
let company: { companyId: string; userId: string };
const ctx = (kind: AiKind): AiCallContext => ({ companyId: company.companyId, memberId: company.userId, kind, limits: {} });

describe('Claude integration (mocked SDK)', () => {
  beforeAll(async () => {
    company = await registerCompany(await getApp(), 'AI Test');
  });
  afterEach(() => {
    calls.length = 0;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('reads a scale display and converts grams to kg', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
    const { readScale } = await import('../src/services/ai.ts');
    nextText = JSON.stringify({ weight: 4020, unit: 'g', rawText: '4020 g', confidence: 0.93 });
    const r = await readScale(Buffer.from('x'), 'image/jpeg', ctx('SCALE_READ'));
    expect(r).toEqual({ weightKg: 4.02, unit: 'g', rawText: '4020 g', confidence: 0.93 });
    const p = calls[0]!;
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.fallbacks).toBe('default');
    expect((p.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('rejects malformed model output', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { readScale } = await import('../src/services/ai.ts');
    nextText = JSON.stringify({ nope: true });
    await expect(readScale(Buffer.from('x'), 'image/jpeg', ctx('SCALE_READ'))).rejects.toMatchObject({ code: 'AI_FAILED' });
  });

  it('extracts PDF invoice lines', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { readInvoicePdf } = await import('../src/services/ai.ts');
    const line = {
      trackingNo: '794812345305', shipDate: '2026-10-20', service: null, destCountry: 'DE', actualKg: 4, billedKg: 9.5,
      dimL: 50, dimW: 40, dimH: 38, billedDivisor: 5000, baseAmount: null, discountAmount: null, fuelAmount: null,
      surcharges: [], netAmount: 1642.5, currency: 'TRY', reference: null,
    };
    nextText = JSON.stringify({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', amountsIncludeVat: false, lines: [line] });
    const r = (await readInvoicePdf(Buffer.from('%PDF'), ctx('INVOICE_PDF'))).data;
    expect(r.lines[0]!.netAmount).toBe(1642.5);
    // Y20: yanıtta KDV oranı ve ağırlık birimi yoksa (eski yanıt / önbellek) okunmamış sayılır; modele giden şemada zorunlu
    expect(r).toMatchObject({ vatPct: null, weightUnit: null });
    const format = (calls[0]!.output_config as { format: { schema: { required: string[] } } }).format;
    expect(format.schema.required).toEqual(expect.arrayContaining(['vatPct', 'weightUnit', 'amountsIncludeVat']));
    expect(calls[0]!.system).toContain('weightUnit');
    const content = (calls[0]!.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content[0]!.type).toBe('document');
  });

  it('05-B10 / Y44: PDF istemi taşıyıcının tarife ek ücret kodlarını taşır; yakıt yüzdesi tutara çevrilir', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { readInvoicePdf } = await import('../src/services/ai.ts');
    nextText = JSON.stringify({ invoiceNo: null, invoiceDate: null, currency: null, amountsIncludeVat: false, lines: [] });
    await readInvoicePdf(Buffer.from('%PDF-known'), ctx('INVOICE_PDF'), { knownSurcharges: [{ code: 'UZAK_BOLGE', name: 'Uzak Bölge' }, { code: 'mobil', name: null }] });
    const system = String(calls[0]!.system);
    expect(system).toContain('MOBIL, UZAK_BOLGE ("Uzak Bölge")');
    expect(system).toContain('only as a percentage');
    // tarife yoksa istemde tarife satırı yok
    await readInvoicePdf(Buffer.from('%PDF-none'), ctx('INVOICE_PDF'));
    expect(String(calls[1]!.system)).not.toContain('contract tariff');
  });

  it('keeps the SDK connect timeout × retries under the 300 s web proxy limit', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { readScale, AI_CONNECT_TIMEOUT_MS, AI_MAX_RETRIES } = await import('../src/services/ai.ts');
    nextText = JSON.stringify({ weight: 1, unit: 'kg', rawText: '1 kg', confidence: 1 });
    await readScale(Buffer.from('x'), 'image/jpeg', ctx('SCALE_READ'));
    const opts = clientOptions.at(-1)!;
    expect(opts.timeout).toBe(AI_CONNECT_TIMEOUT_MS);
    expect(opts.maxRetries).toBe(AI_MAX_RETRIES);
    expect(AI_CONNECT_TIMEOUT_MS * (AI_MAX_RETRIES + 1)).toBeLessThan(300_000 - 30_000);
  });

  it('turns a timeout into a clear 504 instead of a generic failure', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { APIConnectionTimeoutError } = await import('@anthropic-ai/sdk');
    const { readScale } = await import('../src/services/ai.ts');
    nextError = new APIConnectionTimeoutError();
    await expect(readScale(Buffer.from('x'), 'image/jpeg', ctx('SCALE_READ'))).rejects.toMatchObject({
      statusCode: 504,
      code: 'AI_FAILED',
      message: expect.stringContaining('zamanında yanıt vermedi'),
    });
  });

  it('maps connection errors and 529 overload to clear messages', async () => {
    const { APIConnectionError, APIError } = await import('@anthropic-ai/sdk');
    const { aiFailed } = await import('../src/services/ai.ts');
    const conn = aiFailed(new APIConnectionError({ message: 'ECONNRESET' }));
    expect(conn).toMatchObject({ statusCode: 503, code: 'AI_FAILED' });
    expect(conn.message).toContain('ulaşılamadı');
    const overloaded = aiFailed(APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()));
    expect(overloaded).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    const other = aiFailed(APIError.generate(500, { type: 'error', error: { type: 'api_error', message: 'x' } }, undefined, new Headers()));
    expect(other).toMatchObject({ statusCode: 502, code: 'AI_FAILED' });
  });
});
