// 2. aşama (S-AI): yapay zekâ geçidi sözleşmesi. Fiyat ve ücret, kayıttaki `ai` girdileri, başlıklar, ret kodları, yollar.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_LIST_PRICES_USD,
  AI_UNKNOWN_MODEL_PRICE,
  AI_PROVIDERS,
  AI_PRICES_CHECKED_AT,
  AI_CACHE_WRITE_1H_MULTIPLIER,
  AI_HEADERS,
  AI_CHARGED_MAYBE,
  AI_CONTEXT_HEADERS,
  AI_REJECT_CODES,
  AI_REJECT_STATUS,
  AI_REJECT_KIND,
  AI_PURPOSE_PATTERN,
  AI_GATEWAY_PATHS,
  AI_SPEND_PATHS,
  AI_SPEND_KPI,
  AI_SPEND_CALL_COLUMNS,
  AI_LIMIT_DEFAULTS,
  aiCostMicros,
  aiCostMicroUsd,
  aiMicroUsdToMicroTry,
  aiPriceFor,
  aiProviderOfModel,
  aiPriceVersion,
  aiPriceUsdRateOf,
  aiStalePriceProviders,
  aiPurposeKey,
  aiContextHeaders,
  parseAiContextHeaders,
  aiRejectBody,
  aiRejectHeaders,
  aiRejectCodeOf,
  isAiRejectCode,
  aiGatewayBaseUrl,
  aiGeminiPath,
  aiProductKeys,
  isAiPurposeOf,
  isAiModelAllowed,
  aiPurposeLabel,
  PRODUCTS,
  PRODUCT_REGISTRY,
  validateRegistry,
  type AiPrice,
  type AiMeteredUsage,
  type ProductEntry,
} from '../src/index.ts';

const sonnet = AI_LIST_PRICES_USD['claude-sonnet-5-5']!;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const meter = (u: Partial<AiMeteredUsage>): AiMeteredUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...u,
});

/** 2026-11-13 sürümündeki `aiCostMicros`'un birebir kopyası: yeni tablo ve sarmalayıcı DeciShip'in TL sonucunu değiştirmemeli. */
function legacyAiCostMicros(
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  price: AiPrice,
  tryPerUsd: number,
): number {
  const t = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const prompt = t(u.inputTokens) + t(u.cacheReadTokens) + t(u.cacheWriteTokens);
  const p = price.above && prompt > price.above.promptTokens ? price.above.price : price;
  const usd = t(u.inputTokens) * p.input + t(u.outputTokens) * p.output + t(u.cacheWriteTokens) * p.cacheWrite + t(u.cacheReadTokens) * p.cacheRead;
  return Math.round(usd * tryPerUsd);
}

test('bugünkü DeciShip örnekleri aynı TL (aiMeter.test.ts değerleri + eski formülle ızgara)', () => {
  // Deciship/apps/api/test/aiMeter.test.ts'teki sabit değerler
  assert.equal(aiCostMicros({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 100), 1_200_000);
  assert.equal(aiCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, sonnet, 100), 260_000_000);
  assert.equal(aiCostMicros({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sonnet, 100), 1_200);
  // Her model (bilinmeyen dahil), kesirli kurlar, Haiku eşiğinin iki yanı
  const prices = [...Object.values(AI_LIST_PRICES_USD), AI_UNKNOWN_MODEL_PRICE];
  const counts = [0, 1, 3, 7, 999, 50_000, 99_999, 100_001, 1_234_567];
  for (const price of prices) {
    for (const rate of [100, 42.5, 7.77, 1]) {
      for (const a of counts) {
        for (const b of [0, 1, 333, 100_000]) {
          const u = { inputTokens: a, outputTokens: b, cacheReadTokens: (a * 7) % 100_003, cacheWriteTokens: (b * 3) % 40_001 };
          assert.equal(aiCostMicros(u, price, rate), legacyAiCostMicros(u, price, rate), JSON.stringify({ u, rate }));
        }
      }
    }
  }
});

test('aiCostMicroUsd: mikro USD tamsayı; TL sarmalayıcısı aynı ham tutardan', () => {
  assert.equal(aiCostMicroUsd(meter({ inputTokens: 1000, outputTokens: 1000 }), sonnet), 12_000);
  // satır başına tek yuvarlama: 0,3 mikro USD → 0; TL yuvarlanmamış tutardan (0,3 × 100)
  assert.equal(aiCostMicroUsd(meter({ cacheReadTokens: 3 }), sonnet), 0);
  assert.equal(aiCostMicros({ ...zero, cacheReadTokens: 3 }, sonnet, 100), 30);
  assert.equal(aiCostMicroUsd(meter({ inputTokens: -1, outputTokens: Number.NaN, outputImages: -2 }), sonnet), 0);
  for (const n of [1, 17, 12_345]) {
    assert.equal(aiCostMicroUsd(meter({ inputTokens: n, outputTokens: n * 2 }), sonnet), aiCostMicros({ ...zero, inputTokens: n, outputTokens: n * 2 }, sonnet, 1));
  }
  assert.equal(aiMicroUsdToMicroTry(12_000, 100), 1_200_000);
  for (const bad of [0, -1, Number.NaN, Infinity]) assert.throws(() => aiMicroUsdToMicroTry(1, bad), RangeError);
});

test('1 saatlik önbelleğe yazma: açık değer; yoksa girdinin 2 katı', () => {
  const opus = AI_LIST_PRICES_USD['claude-opus-5-5']!;
  assert.equal(aiCostMicroUsd(meter({ cacheWrite1hTokens: 1_000_000 }), opus), 8_000_000);
  assert.equal(aiCostMicroUsd(meter({ cacheWrite5mTokens: 1_000_000 }), opus), 5_000_000);
  const noExplicit = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  assert.equal(aiCostMicroUsd(meter({ cacheWrite1hTokens: 1000 }), noExplicit), 1000 * 3 * AI_CACHE_WRITE_1H_MULTIPLIER);
  // Anthropic kuralı: tablodaki her 1 sa değeri girdinin 2 katı (üst kademe dahil)
  for (const [model, p] of Object.entries(AI_LIST_PRICES_USD)) {
    if (p.provider !== 'anthropic') continue;
    assert.equal(p.cacheWrite1h, p.input * 2, model);
    if (p.above) assert.equal(p.above.price.cacheWrite1h, p.above.price.input * 2, model);
  }
});

test('Haiku kademesi istemin tamamına bakar (girdi + okuma + 5 dk + 1 sa yazma)', () => {
  const haiku = AI_LIST_PRICES_USD['claude-haiku-5-5']!;
  const lo = { input: 0.1, output: 0.5, w5: 0.125, w1: 0.2, read: 0.01 };
  const hi = { input: 0.5, output: 2.5, w5: 0.625, w1: 1, read: 0.05 };
  const at = (input: number, read: number, w5: number, w1: number) =>
    meter({ inputTokens: input, cacheReadTokens: read, cacheWrite5mTokens: w5, cacheWrite1hTokens: w1, outputTokens: 1000 });
  const cost = (r: typeof lo, input: number, read: number, w5: number, w1: number) =>
    Math.round(input * r.input + 1000 * r.output + w5 * r.w5 + w1 * r.w1 + read * r.read);
  // tam 100.000: alt kademe
  assert.equal(aiCostMicroUsd(at(40_000, 30_000, 20_000, 10_000), haiku), cost(lo, 40_000, 30_000, 20_000, 10_000));
  // 1 saatlik yazmadaki bir token eşiği aşar: bütün istek üst kademeden
  assert.equal(aiCostMicroUsd(at(40_000, 30_000, 20_000, 10_001), haiku), cost(hi, 40_000, 30_000, 20_000, 10_001));
  // girdi tek başına eşiğin çok altında, okuma ile aşar (TagPress'in eski kuralı yalnız girdiye bakıyordu)
  assert.equal(aiCostMicroUsd(at(1_000, 99_001, 0, 0), haiku), cost(hi, 1_000, 99_001, 0, 0));
});

test('Gemini görseli görsel başına; metin çıktısı görselden pahalıysa o', () => {
  const g = AI_LIST_PRICES_USD['gemini-3.1-flash-image']!;
  assert.equal(g.provider, 'gemini');
  assert.equal(g.perOutputImage, 0.067);
  // 1 görsel (1.290 çıktı tokeni): 0,067 $ + girdi
  assert.equal(aiCostMicroUsd(meter({ inputTokens: 1000, outputTokens: 1290, outputImages: 1 }), g), Math.round(1000 * 0.3 + 67_000));
  assert.equal(aiCostMicroUsd(meter({ outputImages: 3 }), g), 201_000);
  // görselsiz çağrı token fiyatından
  assert.equal(aiCostMicroUsd(meter({ inputTokens: 1000, outputTokens: 1000 }), g), 1000 * 0.3 + 1000 * 2.5);
  // metin tokeni görsel fiyatını aşarsa eksik sayılmaz
  assert.equal(aiCostMicroUsd(meter({ outputTokens: 100_000, outputImages: 1 }), g), 250_000);
  // görsel fiyatı olmayan modelde görsel sayısı ücreti değiştirmez
  assert.equal(aiCostMicroUsd(meter({ outputTokens: 1000, outputImages: 2 }), sonnet), 10_000);
});

test('bilinmeyen model en pahalıdan; tarih ekli ad kök modelden', () => {
  assert.deepEqual(aiPriceFor('claude-sonnet-5-5'), { price: AI_LIST_PRICES_USD['claude-sonnet-5-5'], known: true });
  assert.deepEqual(aiPriceFor(' claude-sonnet-5-5-20261001 '), { price: AI_LIST_PRICES_USD['claude-sonnet-5-5'], known: true });
  // bilinmeyen: en pahalı token fiyatı (DeciShip'in `AI_UNKNOWN_MODEL_PRICE`'ı) + tablonun en yüksek görsel fiyatı
  const unknown = { ...AI_UNKNOWN_MODEL_PRICE, perOutputImage: 0.067 };
  for (const name of ['claude-mystery-9', 'constructor', '__proto__', '', 'gemini-9-ultra']) {
    assert.deepEqual(aiPriceFor(name), { price: unknown, known: false }, name);
  }
  assert.deepEqual(AI_UNKNOWN_MODEL_PRICE, { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.5 });
  // her kullanımda bilinmeyen modelin ücreti bilinen her modelinkinden az değil (1 sa yazma ve görsel dahil)
  const samples = [
    meter({ inputTokens: 5000, outputTokens: 800, cacheReadTokens: 20_000, cacheWrite5mTokens: 3000, cacheWrite1hTokens: 2000 }),
    meter({ inputTokens: 200_000, outputTokens: 50 }),
    meter({ inputTokens: 300, outputTokens: 1290, outputImages: 2 }),
  ];
  for (const u of samples) {
    for (const [model, p] of Object.entries(AI_LIST_PRICES_USD)) assert.ok(aiCostMicroUsd(u, unknown) >= aiCostMicroUsd(u, p), model);
  }
  // ezme tablosunda (DeciShip `AI_PRICE_TABLE`) bilinmeyen model o tablonun en pahalısından
  const table = { ...AI_LIST_PRICES_USD, 'claude-x': { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 } };
  assert.equal(aiPriceFor('claude-unknown', table).price.input, 99);
  assert.equal(aiProviderOfModel('claude-haiku-5-5'), 'anthropic');
  assert.equal(aiProviderOfModel('gemini-3.1-flash-image'), 'gemini');
  assert.equal(aiProviderOfModel('claude-new-9'), 'anthropic');
  assert.equal(aiProviderOfModel('gpt-x'), null);
});

test('fiyat tarihi: her sağlayıcının tarihi var, geçerli, gelecekte değil; eskime uyarısı', () => {
  const providers = new Set(Object.values(AI_LIST_PRICES_USD).map((p) => p.provider));
  for (const p of providers) assert.ok((AI_PROVIDERS as readonly string[]).includes(p), p);
  for (const p of AI_PROVIDERS) {
    const d = AI_PRICES_CHECKED_AT[p];
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/, p);
    const at = Date.parse(`${d}T00:00:00Z`);
    assert.ok(Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === d, `${p} geçersiz tarih ${d}`);
    assert.ok(at <= Date.now(), `${p} fiyat tarihi gelecekte: ${d}`);
  }
  assert.equal(AI_PRICES_CHECKED_AT.anthropic, '2026-11-13');
  assert.deepEqual(aiStalePriceProviders(new Date('2026-11-20T00:00:00Z')), []);
  assert.deepEqual(aiStalePriceProviders(new Date('2027-02-07T00:00:00Z')), ['gemini']);
  assert.deepEqual(aiStalePriceProviders(new Date('2027-06-01T00:00:00Z')), ['anthropic', 'gemini']);
});

test('priceVersion kararlı, sıradan bağımsız, fiyat ve kurla değişir; kur geri okunur', () => {
  const v = aiPriceVersion(AI_LIST_PRICES_USD, 100);
  assert.match(v, /^r100:[0-9a-f]{12}$/);
  assert.equal(aiPriceVersion({ ...AI_LIST_PRICES_USD }, 100), v);
  assert.equal(aiPriceVersion(Object.fromEntries(Object.entries(AI_LIST_PRICES_USD).reverse()), 100), v);
  assert.notEqual(aiPriceVersion({ ...AI_LIST_PRICES_USD, 'claude-opus-5-5': { ...AI_LIST_PRICES_USD['claude-opus-5-5']!, cacheWrite1h: 9 } }, 100), v);
  assert.notEqual(aiPriceVersion(AI_LIST_PRICES_USD, 42.5), v);
  assert.equal(aiPriceUsdRateOf(v), 100);
  assert.equal(aiPriceUsdRateOf(aiPriceVersion(AI_LIST_PRICES_USD, 42.5)), 42.5);
  assert.equal(aiPriceUsdRateOf('fixture'), null);
});

test('kayıttaki yapay zekâ girdileri: modeller fiyat tablosunda, amaçlar biçimde, araç amaçları kodla aynı', () => {
  assert.deepEqual(aiProductKeys(), ['deciship', 'tagpress']);
  for (const key of aiProductKeys()) {
    const ai = PRODUCTS[key].ai!;
    for (const m of ai.models) assert.ok(Object.hasOwn(AI_LIST_PRICES_USD, m), `${key}: ${m} fiyat tablosunda yok`);
    for (const p of Object.keys(ai.purposes)) {
      assert.match(p, AI_PURPOSE_PATTERN);
      assert.ok(p.startsWith(`${key}.`), p);
    }
    assert.ok(ai.defaultCapUsd > 0);
  }
  assert.deepEqual(PRODUCTS.deciship.ai!.models, ['claude-sonnet-5-5']);
  assert.equal(PRODUCTS.deciship.ai!.defaultCapUsd, 15);
  assert.equal(PRODUCTS.tagpress.ai!.defaultCapUsd, 20);
  // DeciShip `AiKind` (aiMeter.ts AI_KINDS) → amaç, birebir
  const kinds = ['SCALE_READ', 'INVOICE_PDF', 'INVOICE_MAPPING', 'TARIFF_PDF_DISCOVER', 'TARIFF_PDF_EXTRACT', 'TARIFF_REVIEW'];
  assert.deepEqual(kinds.map((k) => aiPurposeKey('deciship', k)).sort(), Object.keys(PRODUCTS.deciship.ai!.purposes).sort());
  // TagPress'in bugünkü `purpose` değerleri (packages/ai, adapters/ai.ts, builder, şablon görevi, deneme), birebir
  const base = ['design', 'rank', 'transcribe', 'image'];
  const tp = [...base, 'builder-turn', 'builder-transcribe', ...base.flatMap((b) => [`builder-try-${b}`, `sablon-${b}`, `deneme-${b}`])];
  assert.deepEqual(tp.map((p) => aiPurposeKey('tagpress', p)).sort(), Object.keys(PRODUCTS.tagpress.ai!.purposes).sort());
  // TagPress `domain/ai.ts` MODELS
  for (const m of ['claude-haiku-5-5', 'claude-opus-5-5', 'gemini-3.1-flash-image']) assert.ok(isAiModelAllowed('tagpress', m), m);
  assert.equal(isAiModelAllowed('tagpress', 'claude-sonnet-5-5'), false);
  assert.equal(isAiModelAllowed('deciship', 'claude-sonnet-5-5-20261001'), true);
  assert.equal(isAiModelAllowed('orderloom', 'claude-sonnet-5-5'), false);
  assert.equal(isAiPurposeOf('deciship', 'tagpress.design'), false);
  assert.equal(isAiPurposeOf('orderloom', 'orderloom.x'), false);
  assert.equal(isAiPurposeOf('tagpress', 'constructor'), false);
  assert.equal(aiPurposeLabel('tagpress.builder_turn', 'tr'), 'Tasarım dili oluşturucu');
  assert.equal(aiPurposeLabel('deciship.invoice_pdf', 'en'), 'PDF invoice reading');
  assert.equal(aiPurposeLabel('nope.x', 'tr'), 'nope.x');
  assert.equal(aiPurposeLabel('constructor', 'tr'), 'constructor');
  assert.throws(() => aiPurposeKey('tagpress', 'Bad Purpose!'), RangeError);
  assert.throws(() => (PRODUCTS.tagpress.ai!.models as string[]).push('x'), TypeError);
});

test('kayıt denetimi yapay zekâ girdisini yakalar', () => {
  const base = (PRODUCT_REGISTRY as readonly ProductEntry[]).find((e) => e.key === 'tagpress')!;
  const bad = (ai: unknown) => validateRegistry([{ ...base, ai } as ProductEntry]);
  const ok = { 'tagpress.ok': { tr: 'a', en: 'b' } };
  assert.deepEqual(validateRegistry([base]), []);
  assert.ok(bad({ purposes: {}, models: ['m1'], defaultCapUsd: 1 }).some((e) => e.includes('ai.purposes boş')));
  assert.ok(bad({ purposes: { 'deciship.x_y': { tr: 'a', en: 'b' } }, models: ['m1'], defaultCapUsd: 1 }).some((e) => e.includes('deciship.x_y')));
  assert.ok(bad({ purposes: { 'tagpress.Bad-Name': { tr: 'a', en: 'b' } }, models: ['m1'], defaultCapUsd: 1 }).some((e) => e.includes('Bad-Name')));
  assert.ok(bad({ purposes: { 'tagpress.ok': { tr: '', en: 'b' } }, models: ['m1'], defaultCapUsd: 1 }).some((e) => e.includes('etiketi eksik')));
  assert.ok(bad({ purposes: ok, models: [], defaultCapUsd: 1 }).some((e) => e.includes('ai.models boş')));
  assert.ok(bad({ purposes: ok, models: ['m1', 'm1'], defaultCapUsd: 1 }).some((e) => e.includes('tekil')));
  assert.ok(bad({ purposes: ok, models: ['Bad Model'], defaultCapUsd: 1 }).some((e) => e.includes('Bad Model')));
  assert.ok(bad({ purposes: ok, models: ['m1'], defaultCapUsd: 0 }).some((e) => e.includes('defaultCapUsd')));
  assert.ok(bad({ purposes: ok, models: ['m1'], defaultCapUsd: Number.NaN }).some((e) => e.includes('defaultCapUsd')));
});

test('bağlam başlıkları: araç yazar, geçit okur; eksik ve bozuk alanlar adıyla', () => {
  const ctx = { orgId: 'org_1', memberId: 'mem-2', purpose: 'tagpress.builder_turn', requestId: '0190f0c1-aaaa-7bbb-8ccc-ddddeeeeffff', origin: 'request' as const };
  const h = aiContextHeaders(ctx);
  assert.deepEqual(Object.keys(h).sort(), [AI_HEADERS.org, AI_HEADERS.member, AI_HEADERS.purpose, AI_HEADERS.requestId, AI_HEADERS.origin].sort());
  assert.deepEqual(parseAiContextHeaders(h), { ok: true, ctx: { ...ctx, attempt: 0 } });
  // Fetch `Headers` nesnesi ve SDK deneme sayacı
  assert.deepEqual(parseAiContextHeaders(new Headers({ ...h, 'x-stainless-retry-count': '2' })), { ok: true, ctx: { ...ctx, attempt: 2 } });
  // aracın kendi denemesi SDK sayacına üstün; kişisiz arka plan işi; başlık adı büyük harfle de okunur
  const job = aiContextHeaders({ ...ctx, memberId: null, origin: 'job', attempt: 1 });
  assert.equal(job[AI_HEADERS.member], undefined);
  assert.deepEqual(parseAiContextHeaders({ ...job, 'X-Stainless-Retry-Count': '5' }), { ok: true, ctx: { ...ctx, memberId: null, origin: 'job', attempt: 1 } });
  const r = parseAiContextHeaders({ [AI_HEADERS.purpose]: 'Design', [AI_HEADERS.origin]: 'cron', [AI_HEADERS.attempt]: '-1' });
  assert.deepEqual(r, { ok: false, invalid: [AI_HEADERS.org, AI_HEADERS.purpose, AI_HEADERS.requestId, AI_HEADERS.origin, AI_HEADERS.attempt] });
  for (const name of AI_CONTEXT_HEADERS) assert.ok(name.startsWith('x-sod-'), name);
  const names = Object.values(AI_HEADERS);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.equal(n, n.toLowerCase());
  // R2: "ücret doğmuş olabilir" yanıt başlığı; bağlam başlığı değil (araç göndermez, geçit sağlayıcıdan gelirse siler: `x-sod-*`)
  assert.equal(AI_HEADERS.charged, 'x-sod-ai-charged');
  assert.equal(AI_CHARGED_MAYBE, 'maybe');
  assert.ok(!AI_CONTEXT_HEADERS.includes(AI_HEADERS.charged));
});

test('ret kodları: durum, anlam, iki sağlayıcı biçimi, yeniden denememe başlığı', () => {
  assert.deepEqual([...AI_REJECT_CODES].sort(), Object.keys(AI_REJECT_KIND).sort());
  for (const code of AI_REJECT_CODES) {
    assert.match(code, /^sod_[a-z_]+$/);
    assert.ok(isAiRejectCode(code));
    const h = aiRejectHeaders(code);
    assert.equal(h[AI_HEADERS.reject], code);
    assert.equal(h[AI_HEADERS.shouldRetry], 'false');
    assert.equal(aiRejectCodeOf(h), code);
    assert.deepEqual(aiRejectBody('anthropic', code), { type: 'error', error: { type: code, message: code } });
    const g = aiRejectBody('gemini', code, 'm') as { error: { code: number; reason: string; status: string } };
    assert.equal(g.error.code, AI_REJECT_STATUS[code]);
    assert.equal(g.error.reason, code);
    assert.notEqual(g.error.status, 'UNKNOWN');
  }
  // plan §S9 kodları ve durumları
  const s9 = { sod_platform_paused: 429, sod_org_cap: 429, sod_tool_cap: 429, sod_rate_limited: 429, sod_model_not_allowed: 400, sod_purpose_unknown: 400, sod_unauthorized: 401, sod_provider_missing: 503 };
  for (const [code, status] of Object.entries(s9)) assert.equal(AI_REJECT_STATUS[code as keyof typeof AI_REJECT_STATUS], status, code);
  assert.equal(AI_REJECT_KIND.sod_platform_paused, 'paused');
  assert.equal(AI_REJECT_KIND.sod_org_cap, 'cap');
  assert.equal(AI_REJECT_KIND.sod_tool_cap, 'cap');
  assert.equal(AI_REJECT_KIND.sod_rate_limited, 'busy');
  assert.equal(aiRejectHeaders('sod_rate_limited', 2.2)['retry-after'], '3');
  assert.equal(aiRejectHeaders('sod_org_cap')['retry-after'], undefined);
  assert.equal(aiRejectCodeOf(new Headers({ 'x-sod-ai-reject': 'sod_org_cap' })), 'sod_org_cap');
  assert.equal(aiRejectCodeOf({ 'x-sod-ai-reject': 'rate_limit_error' }), null);
  assert.equal(aiRejectCodeOf({}), null);
  assert.equal(isAiRejectCode('constructor'), false);
});

test('geçit yolları, SDK taban adresi ve Merkez uçları', () => {
  assert.equal(aiGatewayBaseUrl('http://ai-api:4300/', 'anthropic'), 'http://ai-api:4300/internal/anthropic');
  assert.equal(aiGatewayBaseUrl('http://ai-api:4300', 'gemini'), 'http://ai-api:4300/internal/gemini/v1beta');
  assert.equal(`${AI_GATEWAY_PATHS.anthropicBase}/v1/messages`, AI_GATEWAY_PATHS.anthropicMessages);
  assert.equal(aiGeminiPath('gemini-3.1-flash-image', false), '/internal/gemini/v1beta/models/gemini-3.1-flash-image:generateContent');
  assert.equal(aiGeminiPath('gemini-3.1-flash-image', true), '/internal/gemini/v1beta/models/gemini-3.1-flash-image:streamGenerateContent');
  for (const p of Object.values(AI_GATEWAY_PATHS)) assert.ok(p.startsWith('/internal/'), p);
  for (const p of Object.values(AI_SPEND_PATHS)) assert.ok(p.startsWith('/api/ai/'), p);
  assert.equal(new Set(AI_SPEND_KPI).size, AI_SPEND_KPI.length);
  assert.equal(new Set(AI_SPEND_CALL_COLUMNS).size, AI_SPEND_CALL_COLUMNS.length);
  assert.equal(AI_LIMIT_DEFAULTS.maxBodyBytes, 32 * 1024 * 1024);
});
