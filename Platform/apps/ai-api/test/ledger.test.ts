import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_LIST_PRICES_USD, aiCostMicroUsd } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma } from '../src/db.ts';
import { uuidv7, UUID_V7_PATTERN } from '../src/ledger/ids.ts';
import {
  cancelledUsage,
  costOf,
  estimateInput,
  IMAGE_TOKENS,
  paidFeatures,
  PDF_BYTES_PER_TOKEN,
  PDF_DOC_TOKENS,
  upperInputTokens,
  upperMicroUsd,
  ZERO_USAGE,
  UPPER_INPUT_TOKENS_CAP,
} from '../src/ledger/pricing.ts';
import { Ledger, type OpenPending } from '../src/ledger/store.ts';
import { createMeter } from '../src/proxy/meter.ts';
import { SseParser, type SseEvent } from '../src/proxy/sse.ts';
import { proxyRoutes } from '../src/proxy/routes.ts';
import { closeSuper, createTestAccount, superClient } from './helpers.ts';
import { fakeUpstream, ledgerRows, makeProxyApp, newRequestId, resetLedger } from './proxyHelpers.ts';

/** Defter (G2): kimlik, fiyat ve tahmin kuralları, ölçer, tek kapanış, benzersizlik, çökme taraması. */

const z = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
const usage = (u: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...u });

describe('kimlik ve fiyat (saf)', () => {
  it('uuidv7: biçim ve zamana göre sıra', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_V7_PATTERN);
    expect(a < b).toBe(true);
    expect(a.slice(0, 13).replace('-', '')).toBe((1_700_000_000_000).toString(16).padStart(12, '0'));
  });

  it('pay: girdi düz girdi fiyatından (önbellek isteniyorsa yazma fiyatından), metin bayt / 2 + 1000 (en çok 200.000); Haiku kademesi istem uzunluğuyla', () => {
    expect(upperInputTokens(10_000)).toBe(6_000);
    expect(upperInputTokens(10_000_000)).toBe(UPPER_INPUT_TOKENS_CAP);
    const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
    expect(upperMicroUsd({ inputTokens: 6_000, outputTokens: 1_000, outputImages: 0 }, 'claude-sonnet-5-5')).toBe(Math.round(6_000 * sonnet.input + 1_000 * sonnet.output));
    expect(upperMicroUsd({ inputTokens: 6_000, outputTokens: 1_000, outputImages: 0, inputKind: 'write5m' }, 'claude-sonnet-5-5')).toBe(Math.round(6_000 * sonnet.cacheWrite + 1_000 * sonnet.output));
    expect(upperMicroUsd({ inputTokens: 6_000, outputTokens: 1_000, outputImages: 0, inputKind: 'write1h' }, 'claude-sonnet-5-5')).toBe(Math.round(6_000 * sonnet.cacheWrite1h! + 1_000 * sonnet.output));
    const haiku = AI_LIST_PRICES_USD['claude-haiku-5-5']!;
    expect(upperMicroUsd({ inputTokens: 150_000, outputTokens: 0, outputImages: 0, inputKind: 'write1h' }, 'claude-haiku-5-5')).toBe(Math.round(150_000 * haiku.above!.price.cacheWrite1h!));
    expect(upperMicroUsd({ inputTokens: 150_000, outputTokens: 0, outputImages: 0 }, 'claude-haiku-5-5')).toBe(Math.round(150_000 * haiku.above!.price.input));
    const gem = AI_LIST_PRICES_USD['gemini-3.1-flash-image']!;
    expect(upperMicroUsd({ inputTokens: 0, outputTokens: 10, outputImages: 2 }, 'gemini-3.1-flash-image')).toBe(Math.round(2 * gem.perOutputImage! * 1_000_000));
    // Yedek model: pay istenen ve yedeklerin en pahalısından.
    const opus5 = AI_LIST_PRICES_USD['claude-opus-5']!;
    expect(upperMicroUsd({ inputTokens: 1_000, outputTokens: 1_000, outputImages: 0, fallbackModels: ['claude-opus-5'] }, 'claude-opus-5-5')).toBe(Math.round(1_000 * opus5.input + 1_000 * opus5.output));
    expect(upperMicroUsd({ inputTokens: 1_000, outputTokens: 1_000, outputImages: 0, fallbackModels: ['claude-sonnet-5'] }, 'claude-opus-5-5')).toBe(Math.round(1_000 * 4 + 1_000 * 20));
  });

  it('girdi tahmini: base64 alanları ayrı (görsel sabit, PDF bayt / 8 + bir sayfa), kalan metin bayt / 2; önbellek isteği fiyat kalemini seçer', () => {
    const text = { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'merhaba' }] };
    const textBytes = Buffer.byteLength(JSON.stringify(text));
    expect(estimateInput(text, textBytes)).toEqual({ inputTokens: upperInputTokens(textBytes), inputKind: 'input' });
    // DeciShip PDF faturası: 1,5 MB PDF (≈2 MB base64), max_tokens 64.000 (R2 örneği).
    const pdf = Buffer.alloc(1_500_000, 7).toString('base64');
    const pdfBody = { model: 'claude-sonnet-5-5', max_tokens: 64_000, system: 'oku', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }, { type: 'text', text: 'oku' }] }] };
    const pdfBytes = Buffer.byteLength(JSON.stringify(pdfBody));
    const e = estimateInput(pdfBody, pdfBytes);
    expect(e.inputKind).toBe('input');
    expect(e.inputTokens).toBe(Math.ceil((pdfBytes - pdf.length) / 2) + 1_000 + Math.ceil(1_500_000 / PDF_BYTES_PER_TOKEN) + PDF_DOC_TOKENS);
    const reserve = upperMicroUsd({ inputTokens: e.inputTokens, inputKind: e.inputKind, outputTokens: 64_000, outputImages: 0 }, 'claude-sonnet-5-5');
    const old = upperMicroUsd({ inputTokens: upperInputTokens(pdfBytes), inputKind: 'write1h', outputTokens: 64_000, outputImages: 0 }, 'claude-sonnet-5-5');
    expect(old).toBe(1_440_000);
    expect(reserve).toBeLessThan(1_100_000);
    // Görsel: boyundan bağımsız; Gemini `inlineData` da sayılır; 1 sa önbellek isteği yazma fiyatını seçer.
    const img = Buffer.alloc(3_000_000, 1).toString('base64');
    const imgBody = { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }], contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: img } }] }] };
    const imgBytes = Buffer.byteLength(JSON.stringify(imgBody));
    expect(estimateInput(imgBody, imgBytes)).toEqual({ inputTokens: Math.ceil((imgBytes - img.length) / 2) + 1_000 + IMAGE_TOKENS, inputKind: 'write1h' });
    expect(estimateInput({ tools: [{ name: 'a', cache_control: { type: 'ephemeral' } }] }, 100).inputKind).toBe('write5m');
    // Düz metin belgesi base64 değildir; çok büyük gövde tavanda kalır.
    expect(estimateInput({ source: { type: 'text', media_type: 'text/plain', data: 'x'.repeat(4_000) } }, 4_100).inputTokens).toBe(Math.ceil(100 / 2) + 1_000 + 2_000);
    const huge = Buffer.alloc(20_000_000, 1).toString('base64');
    expect(estimateInput({ data: huge, media_type: 'application/pdf' }, huge.length + 40).inputTokens).toBe(UPPER_INPUT_TOKENS_CAP);
  });

  it('ücretli özellikler: sağlayıcı araçları ve MCP ret; yedek model "default" ya da fiyatı bilinen Anthropic modelleri; Gemini yalnız işlev bildirimi', () => {
    expect(paidFeatures('anthropic', { tools: [{ name: 'kaydet', input_schema: {} }, { type: 'custom', name: 'b', input_schema: {} }] })).toEqual({ ok: true, fallbackModels: [], fallbackMaxTokens: 0 });
    for (const type of ['web_search_20260209', 'web_fetch_20260209', 'code_execution_20260521', 'bash_20250124', 'mcp_toolset']) {
      expect(paidFeatures('anthropic', { tools: [{ type, name: 'x' }] }).ok, type).toBe(false);
    }
    expect(paidFeatures('anthropic', { tools: {} }).ok).toBe(false);
    expect(paidFeatures('anthropic', { mcp_servers: [{ type: 'url', url: 'https://x', name: 'x' }] }).ok).toBe(false);
    expect(paidFeatures('anthropic', { fallbacks: 'default' })).toEqual({ ok: true, fallbackModels: [], fallbackMaxTokens: 0 });
    expect(paidFeatures('anthropic', { fallbacks: [{ model: 'claude-opus-5' }, { model: 'claude-opus-4-8-20260101', max_tokens: 90_000 }] })).toEqual({
      ok: true,
      fallbackModels: ['claude-opus-5', 'claude-opus-4-8-20260101'],
      fallbackMaxTokens: 90_000,
    });
    for (const fallbacks of [[{ model: 'claude-yok-1' }], [{ model: 'gemini-3.1-flash-image' }], [{}], [], 'all', 5]) {
      expect(paidFeatures('anthropic', { fallbacks }).ok, JSON.stringify(fallbacks)).toBe(false);
    }
    expect(paidFeatures('gemini', { tools: [{ functionDeclarations: [] }] }).ok).toBe(true);
    expect(paidFeatures('gemini', { tools: [{ googleSearch: {} }] }).ok).toBe(false);
    expect(paidFeatures('gemini', { tools: [{ google_search: {} }] }).ok).toBe(false);
  });

  it('ücret: yanıtı veren model; kalemler kendi modelinden; bilinmeyen en pahalı ve bildirilir', () => {
    const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
    expect(costOf(usage({ inputTokens: 1000, outputTokens: 1000 }), 'claude-sonnet-5-5')).toEqual({ costMicroUsd: 12_000, unknownModels: [] });
    const its = usage({ iterations: [{ model: null, inputTokens: 10, outputTokens: 0, ...z }, { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 0, ...z }] });
    expect(costOf(its, 'claude-sonnet-5-5').costMicroUsd).toBe(aiCostMicroUsd({ inputTokens: 10, outputTokens: 0, ...z }, sonnet) + aiCostMicroUsd({ inputTokens: 10, outputTokens: 0, ...z }, AI_LIST_PRICES_USD['claude-opus-5-5']!));
    const unk = costOf(usage({ inputTokens: 1000 }), 'claude-yok-1');
    expect(unk.unknownModels).toEqual(['claude-yok-1']);
    expect(unk.costMicroUsd).toBeGreaterThanOrEqual(1000 * 10);
    expect(costOf(usage({ inputTokens: 1000 }), 'claude-sonnet-5-5-20261001').unknownModels).toEqual([]);
  });

  it('kesilme tahmini: girdi bilinen ya da üst tahmin; çıktı max(bilinen, karakter/3,5, süre × 110), en az 1, en çok üst sınır', () => {
    const bound = { inputTokens: 5000, outputTokens: 800, outputImages: 0 };
    expect(cancelledUsage(null, bound, 0, 0)).toMatchObject({ inputTokens: 5000, outputTokens: 1 });
    expect(cancelledUsage(usage({ inputTokens: 300, cacheReadTokens: 50, outputTokens: 2 }), bound, 2000, 70)).toMatchObject({ inputTokens: 300, cacheReadTokens: 50, outputTokens: 220 });
    expect(cancelledUsage(usage({ inputTokens: 300 }), bound, 60_000, 0).outputTokens).toBe(800);
    expect(cancelledUsage(null, { inputTokens: 10, outputTokens: 100, outputImages: 1 }, 0, 0).outputImages).toBe(1);
  });
});

describe('ölçer ve SSE', () => {
  const sse = (evs: [string, unknown][]) => evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

  it('SSE ayrıştırıcı bayt bayt parçalamada aynı olayları verir (CRLF, çok satırlı data, yorum)', () => {
    const text = ': merhaba\r\nevent: a\r\ndata: {"x":1,\r\ndata: "y":"ğ"}\r\n\r\nevent: b\ndata: 2\n\ndata: 3\r\r';
    const whole: SseEvent[] = [];
    const p1 = new SseParser((e) => whole.push(e));
    p1.push(new TextEncoder().encode(text));
    p1.end();
    const bytes = Buffer.from(text, 'utf8');
    const split: SseEvent[] = [];
    const p2 = new SseParser((e) => split.push(e));
    for (const b of bytes) p2.push(Uint8Array.of(b));
    p2.end();
    expect(whole).toEqual([
      { event: 'a', data: '{"x":1,\n"y":"ğ"}' },
      { event: 'b', data: '2' },
      { event: 'message', data: '3' },
    ]);
    expect(split).toEqual(whole);
  });

  it('Anthropic: message_delta önbellek toplamını ayrıntısız verirse 1 sa kısmı korunur; iterations toplamları', () => {
    const m = createMeter('anthropic', 'text/event-stream');
    m.push(
      new TextEncoder().encode(
        sse([
          ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } } }],
          ['message_delta', { type: 'message_delta', usage: { output_tokens: 9, cache_creation_input_tokens: 30 } }],
          ['message_stop', { type: 'message_stop' }],
        ]),
      ),
    );
    const r = m.finish();
    expect(r).toMatchObject({ completed: true, hasUsage: true, servedModel: 'claude-sonnet-5-5' });
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 9, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20 });
  });

  it('Gemini JSON bozuksa ölçüm okunamaz (tahmine düşer)', () => {
    const m = createMeter('gemini', 'application/json');
    m.push(new TextEncoder().encode('{"candidates": ['));
    expect(m.finish()).toMatchObject({ unreadable: true, completed: false });
  });
});

describe('defter (Postgres)', () => {
  const ledger = new Ledger(getPrisma());
  const pending = (o: Partial<OpenPending> = {}): OpenPending => ({
    id: uuidv7(),
    product: 'deciship',
    orgId: 'org-l',
    memberId: null,
    purpose: 'deciship.invoice_pdf',
    origin: 'job',
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-5-5',
    stream: false,
    inputImages: 0,
    toolRequestId: newRequestId(),
    attempt: 0,
    keySource: 'platform',
    priceVersion: 'r100:abc',
    startedAt: new Date(),
    status: 'pending',
    reservedMicroUsd: 5000,
    ...o,
  });

  beforeAll(async () => {
    await resetLedger();
  });
  afterAll(async () => {
    await closeSuper();
    await disconnectPrisma();
  });

  it('satır tek kez kapanır; kapanan satırın payı 0', async () => {
    const row = pending();
    await ledger.open(row);
    const close = { status: 'ok' as const, usage: usage({ inputTokens: 10, outputTokens: 5 }), costMicroUsd: 70, servedModel: 'claude-sonnet-5-5', errorCode: null, httpStatus: 200, estimated: false, upstreamRequestId: 'r1', finishedAt: new Date() };
    const [a, b] = await Promise.all([ledger.close(row.id, close), ledger.close(row.id, { ...close, status: 'failed', costMicroUsd: 999 })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const [r] = await ledgerRows('id = $1', [row.id]);
    expect(r!.reservedMicroUsd).toBe(0);
    expect(r!.status === 'ok' ? r!.costMicroUsd : r!.costMicroUsd).toBe(r!.status === 'ok' ? 70 : 999);
    expect(await ledger.close(row.id, close)).toBe(false);
  });

  it('UNIQUE(product, toolRequestId, attempt) veritabanında; open bir sonraki boş deneme sayısını seçer', async () => {
    const rid = newRequestId();
    const r1 = await ledger.open(pending({ toolRequestId: rid, attempt: 1 }));
    const r2 = await ledger.open(pending({ toolRequestId: rid, attempt: 1 }));
    const r3 = await ledger.open(pending({ toolRequestId: rid, attempt: 0 }));
    expect([r1.attempt, r2.attempt, r3.attempt]).toEqual([1, 2, 0]);
    // Başka ürün aynı kimliği kullanabilir.
    expect((await ledger.open(pending({ toolRequestId: rid, attempt: 1, product: 'tagpress', purpose: 'tagpress.design' }))).attempt).toBe(1);
    const su = await superClient();
    await expect(
      su.query(
        `INSERT INTO ai."AiCall" (id, product, "orgId", purpose, origin, provider, "requestedModel", "priceVersion", status, "toolRequestId", attempt) VALUES ($1, 'deciship', 'org-l', 'deciship.invoice_pdf', 'job', 'anthropic', 'm', 'v', 'ok', $2, 1)`,
        [uuidv7(), rid],
      ),
    ).rejects.toThrow(/AiCall_product_toolRequestId_attempt_key/);
  });

  it('tarama: verilen andan önce açılmış açık satırlar interrupted, tutar = pay, estimated; sonrakine ve kapanmışa dokunmaz', async () => {
    const old = pending({ startedAt: new Date(Date.now() - 60_000), reservedMicroUsd: 4321 });
    const fresh = pending({ startedAt: new Date(Date.now() + 60_000) });
    await ledger.open(old);
    await ledger.open(fresh);
    const swept = await ledger.sweep(new Date());
    expect(swept.map((s) => s.id)).toContain(old.id);
    expect(swept.map((s) => s.id)).not.toContain(fresh.id);
    const [o] = await ledgerRows('id = $1', [old.id]);
    expect(o).toMatchObject({ status: 'interrupted', estimated: true, costMicroUsd: 4321, reservedMicroUsd: 0, errorCode: 'gateway_interrupted' });
    const [f] = await ledgerRows('id = $1', [fresh.id]);
    expect(f!.status).toBe('pending');
    expect(await ledger.close(old.id, { status: 'ok', usage: ZERO_USAGE, costMicroUsd: 1, servedModel: null, errorCode: null, httpStatus: 200, estimated: false, upstreamRequestId: null, finishedAt: new Date() })).toBe(false);
    await ledger.sweep(new Date(Date.now() + 120_000));
  });

  it('açılış taraması: süreç açılmadan önce kalmış pending satırlar uygulama hazır olunca interrupted; tavana settle bildirilir', async () => {
    const left = pending({ startedAt: new Date(Date.now() - 5_000), reservedMicroUsd: 777 });
    await ledger.open(left);
    const settled: [string, number][] = [];
    const app = await makeProxyApp(await createTestAccount(), fakeUpstream().fetch, {
      internalRoutes: (deps) => [
        proxyRoutes(deps, {
          sweepEveryMs: 0,
          limits: { admit: async (i) => ({ ok: true, reservationId: i.callId }), settle: async (id, n) => void settled.push([id, n]), release: async () => {} },
        }),
      ],
    });
    try {
      const [r] = await ledgerRows('id = $1', [left.id]);
      expect(r).toMatchObject({ status: 'interrupted', costMicroUsd: 777, estimated: true });
      expect(settled).toContainEqual([left.id, 777]);
    } finally {
      await app.close();
    }
  });
});
