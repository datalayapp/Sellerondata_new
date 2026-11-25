/**
 * Yapay zekânın kullanıcıya dönen serbest metni kullanıcının dilinde. Türkçe istekte prompt bayt bayt aynı kalır,
 * yapısal alanların şeması dile göre değişmez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../src/i18n/index.ts';
import type { AiCallContext, AiKind } from '../src/services/aiMeter.ts';
import { getApp, registerCompany } from './helpers.ts';

const calls: { system: string; output_config: unknown }[] = [];

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: { system: string; output_config: unknown }) => {
          calls.push(params);
          // Yalnız gönderilen istek sınanır: yanıt şemaya uymaz, işlev hata verir.
          return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const EN_LINE = 'Write free text in English, not Turkish; codes and enums unchanged.';

type Sender = { name: string; send: () => Promise<unknown> };

/** Sayaç gerçek firmaya yazar (Mesaj 6). */
let company: { companyId: string; userId: string } | null = null;
async function ctx(kind: AiKind): Promise<AiCallContext> {
  company ??= await registerCompany(await getApp(), 'AI Dil');
  return { companyId: company.companyId, memberId: company.userId, kind, limits: {} };
}

async function senders(): Promise<Sender[]> {
  const { suggestMappingWithAi } = await import('../src/services/aiMapping.ts');
  const { reviewTariffImport } = await import('../src/services/aiTariffReview.ts');
  const { discoverPdf, extractPdfSections } = await import('../src/services/tariffPdf.ts');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage();
  const pdf = Buffer.from(await doc.save());
  const carrier = { code: 'fedex', name: 'FedEx' };
  const [mapping, review, discover, extract] = await Promise.all([ctx('INVOICE_MAPPING'), ctx('TARIFF_REVIEW'), ctx('TARIFF_PDF_DISCOVER'), ctx('TARIFF_PDF_EXTRACT')]);
  const section = { id: 'c1', title: 't', service: null, direction: null, priceType: 'net', packaging: null, zones: ['A'], weightMin: 1, weightMax: 2, currency: null, pages: [1], hasAdditionalStep: false, hasPerKgBands: false };
  return [
    { name: 'eşleme', send: () => suggestMappingWithAi({ headers: ['Takip'], rows: [['1']] } as never, carrier, mapping) },
    {
      name: 'tarife incelemesi',
      send: () =>
        reviewTariffImport({
          companyName: 'F',
          carrier,
          tariff: {},
          fileName: 'x.csv',
          rawRows: { text: '', totalRows: 0, truncated: false },
          options: {},
          parsed: { zones: [], weightCount: 0, minWeight: null, maxWeight: null, detectedWeightUnit: null, detectedCurrency: null, resultingCurrency: 'TRY', samplePrices: [], overflow: [], countryMappingCount: 0 },
          checks: [],
          comparison: null,
          recent: { lineCount: 0, services: [], currencies: [], countries: [] },
        } as never, review),
    },
    { name: 'PDF bölüm bulma', send: () => discoverPdf(pdf, ['metin'], { carrier }, discover) },
    { name: 'PDF tablo okuma', send: () => extractPdfSections(pdf, ['metin'], [section] as never, [], extract) },
  ];
}

describe('yapay zekâ çıktı dili', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    calls.length = 0;
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('İngilizce istekte dil satırı eklenir; Türkçe istekte prompt aynen kalır; şema değişmez', async () => {
    for (const { name, send } of await senders()) {
      calls.length = 0;
      await withLocale('tr', () => send()).catch(() => undefined);
      await withLocale('en', () => send()).catch(() => undefined);
      expect(calls, name).toHaveLength(2);
      const [tr, en] = calls as [(typeof calls)[0], (typeof calls)[0]];
      expect(tr.system, name).not.toContain(EN_LINE);
      expect(en.system, name).toBe(`${tr.system}\n\n${EN_LINE}`);
      expect(JSON.stringify(en.output_config), name).toBe(JSON.stringify(tr.output_config));
    }
  });

  it('serbest metni olmayan okumalara satır eklenmez', async () => {
    const { readScale } = await import('../src/services/ai.ts');
    const scale = await ctx('SCALE_READ');
    await withLocale('en', () => readScale(Buffer.from('x'), 'image/jpeg', scale)).catch(() => undefined);
    expect(calls[0]!.system).not.toContain(EN_LINE);
  });
});
