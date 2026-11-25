/**
 * Yapay zekâ sözleşmesi: fiyat tablosu ve ücret hesabı, yapay zekâ geçidinin (`Platform/apps/ai-api`, port 4300) araç tarafı
 * (yollar, bağlam başlıkları, ret kodları, amaç adları). Defter ve Merkez uçlarının tipleri `aiSpend.ts`'tedir.
 *
 * Harcama defteri tek yerde, geçidin `ai` şemasındadır ve USD tutar (mikro USD tamsayı, `aiCostMicroUsd`). Satırı geçit yazar;
 * araçlar deftere yazmaz. DeciShip'in araç içi TL sayacı (`AiUsage`, aylık hak, `aiCostMicros`) geçide taşınana dek kendi
 * veritabanında sürer; iki hesap aynı ham tutardan çıkar (aynı fiyat kuralı, yalnız yuvarlama yeri farklı).
 * Saf işlevler; bağımlılık yok (tarayıcıda da çalışır).
 */

// ---------- Sağlayıcı ve fiyat ----------

/** Geçidin ilettiği sağlayıcılar. Yol öneki (`/internal/<sağlayıcı>`) ve anahtar deposunun satırı bu adla yazılır. */
export const AI_PROVIDERS = ['anthropic', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Sağlayıcı liste fiyatı, USD / 1 milyon token (görsel fiyatı görsel başına USD).
 * - `cacheWrite`: 5 dakikalık önbelleğe yazma; `cacheWrite1h`: 1 saatlik önbelleğe yazma (yoksa girdinin
 *   `AI_CACHE_WRITE_1H_MULTIPLIER` katı, aynı kademenin girdisi); `cacheRead`: önbellekten okuma.
 * - `perOutputImage`: üretilen görsel başına (görüntü modelleri). Görsel üreten çağrıda çıktı ücreti
 *   `max(çıktı tokeni × output, görsel × perOutputImage)`: görsel fiyatı çıktının metnini de kapsar, hiçbir yönden eksik sayılmaz.
 * - `above` (05-B13): istem uzunluğuna göre fiyatlanan model (Haiku 5.5): isteğin istemi (girdi + önbellekten okuma + 5 dk ve 1 sa
 *   önbelleğe yazma tokeni) `promptTokens`'ı aşarsa bütün istek `price` ile fiyatlanır (sağlayıcının kuralı: istek başına ayrı).
 * - `provider`: liste tablosunda her zaman var (`AiListPrice`); araçtaki `AI_PRICE_TABLE` ezmesi taşımayabilir.
 */
export type AiPrice = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cacheWrite1h?: number;
  perOutputImage?: number;
  above?: { promptTokens: number; price: Omit<AiPrice, 'above' | 'provider'> };
  provider?: AiProvider;
};

/** Liste tablosunun satırı: sağlayıcısı belli. */
export type AiListPrice = AiPrice & { provider: AiProvider };

/** 1 saatlik önbelleğe yazma, girdi fiyatının katı (Anthropic kuralı; tabloda açık değer yoksa). */
export const AI_CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * Liste fiyatları.
 * Anthropic, tarih 2026-11-13: resmî fiyat sayfası (https://platform.claude.com/docs/en/about-claude/pricing, "Model pricing";
 * 05-B13). Değerler sayfadan birebir: girdi, 5 dk ve 1 sa önbelleğe yazma, önbellekten okuma ("Cache hits and refreshes"), çıktı.
 * - Sonnet 5.5 önbellekten okuma 0,10 $ (Sonnet 5'in fiyatı 0,20).
 * - Haiku 5.5: 100.000 tokene kadar istem 0,10 / 0,50 $, üstü 0,50 / 2,50 $ (`above`).
 * - Opus 4.8: TagPress oluşturucusunun izinli yedek modeli (TagPress `domain/ai.ts` tablosu, 2026-10-09).
 * Gemini, tarih 2026-10-09: TagPress `domain/ai.ts` tablosundan (Nano Banana 2, 1K görsel 0,067 $). Gemini önbelleği TagPress'te
 * kullanılmıyor; sayfa yeniden okunana dek önbellek kalemleri girdi fiyatından sayılır (eksik sayılmaz) [V].
 * Fiyat değişirse bu tablo ve `AI_PRICES_CHECKED_AT` birlikte güncellenir. Model adları araçların `CLAUDE_MODEL`/`MODELS`
 * değerleri, sunucu tarafı yedek model listeleri ve kayıttaki `ai.models` ile aynı olmalı (contracts testi kayıt modellerini denetler).
 */
export const AI_LIST_PRICES_USD: Readonly<Record<string, AiListPrice>> = {
  'claude-sonnet-5-5': { provider: 'anthropic', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  'claude-sonnet-5': { provider: 'anthropic', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-opus-5': { provider: 'anthropic', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-8': { provider: 'anthropic', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-fable-5-2': { provider: 'anthropic', input: 8, output: 40, cacheWrite: 10, cacheWrite1h: 16, cacheRead: 0.2 },
  'claude-fable-5-1': { provider: 'anthropic', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'claude-haiku-5-5': {
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    above: { promptTokens: 100_000, price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } },
  },
  'gemini-3.1-flash-image': { provider: 'gemini', input: 0.3, output: 2.5, cacheWrite: 0.3, cacheWrite1h: 0.3, cacheRead: 0.3, perOutputImage: 0.067 },
};

/** Sağlayıcı başına fiyatların okunduğu gün (`YYYY-MM-DD`). Tabloda satırı olan her sağlayıcının tarihi olmalı (test). */
export const AI_PRICES_CHECKED_AT: Readonly<Record<AiProvider, string>> = { anthropic: '2026-11-13', gemini: '2026-10-09' };

/** Bu kadar günden eski fiyat tarihi yönetici ekranında "fiyatları doğrulayın" uyarısı doğurur (kapı değil, bilgi). */
export const AI_PRICE_MAX_AGE_DAYS = 120;

/** Fiyat tarihi `maxAgeDays`'ten eski sağlayıcılar (yönetici durumu için; test/CI'ı kırmaz). */
export function aiStalePriceProviders(now: Date, maxAgeDays = AI_PRICE_MAX_AGE_DAYS): AiProvider[] {
  return AI_PROVIDERS.filter((p) => now.getTime() - Date.parse(`${AI_PRICES_CHECKED_AT[p]}T00:00:00Z`) > maxAgeDays * 86_400_000);
}

/** Kalemin 1 saatlik yazma fiyatı: açık değer, yoksa girdinin 2 katı. */
const write1hOf = (p: Omit<AiPrice, 'above' | 'provider'>) => p.cacheWrite1h ?? p.input * AI_CACHE_WRITE_1H_MULTIPLIER;

/**
 * Tablonun en pahalı token fiyatı: her kalem (girdi, çıktı, 5 dk önbelleğe yazma, önbellekten okuma) tablodaki en yüksek değer,
 * kademeli fiyatın üst kademesi dahil (düz fiyat, sağlayıcısız). Tabloda olmayan model bundan sayılır: hiçbir modelden eksik
 * ücretlendirilmez. İnceleme 2026-11-13: eskiden sabit bir modelin liste fiyatıydı; `AI_PRICE_TABLE` bir modeli onun üstüne
 * çıkarınca bilinmeyen model ucuz sayılıyordu. Araç bunu etkin tabloyla (liste + ezme) çağırır. Boş tabloda liste fiyatlarının en pahalısı.
 * 1 saatlik yazma: sonuçta açık değer yalnız tablodaki en yüksek açık değer `2 × en yüksek girdi`yi aşarsa yazılır; yoksa ücret
 * hesabı `2 × girdi`yi kullanır, o da tablodaki her 1 sa değerinden az değildir. Sonucun biçimi DeciShip'in 2026-11-13 biçimidir
 * (dört alan). Görsel kalemi burada yok: bilinmeyen modelin görsel fiyatı `aiPriceFor`'dadır.
 */
export function mostExpensiveAiPrice(table: Readonly<Record<string, AiPrice>>): AiPrice {
  const prices = Object.values(table).flatMap((p) => (p.above ? [p, p.above.price] : [p]));
  if (!prices.length) return table === AI_LIST_PRICES_USD ? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } : mostExpensiveAiPrice(AI_LIST_PRICES_USD);
  const max = (k: 'input' | 'output' | 'cacheWrite' | 'cacheRead') => Math.max(...prices.map((p) => p[k]));
  const out: AiPrice = { input: max('input'), output: max('output'), cacheWrite: max('cacheWrite'), cacheRead: max('cacheRead') };
  const write1h = Math.max(...prices.map(write1hOf));
  if (write1h > out.input * AI_CACHE_WRITE_1H_MULTIPLIER) out.cacheWrite1h = write1h;
  return out;
}

/** Liste fiyatlarının en pahalısı (`mostExpensiveAiPrice`); araç ezmeli etkin tabloyu kullanır. */
export const AI_UNKNOWN_MODEL_PRICE: AiPrice = mostExpensiveAiPrice(AI_LIST_PRICES_USD);

/** Tablonun en yüksek görsel fiyatı (görsel fiyatı olan model yoksa 0). */
function maxImagePrice(table: Readonly<Record<string, AiPrice>>): number {
  return Math.max(0, ...Object.values(table).map((p) => p.perOutputImage ?? 0));
}

const DATED_MODEL = /-\d{8}$/;

/**
 * Modelin fiyatı (geçit ve TagPress): tam ad, yoksa tarih ekli adın kökü (`claude-sonnet-5-5-20261001` → `claude-sonnet-5-5`),
 * yoksa tablonun en pahalı fiyatı (`known: false`; çağıran bir kez uyarı yazar): `mostExpensiveAiPrice` + tablonun en yüksek görsel
 * fiyatı. Geçit yanıtı veren (sunucu tarafı yedek) modeli böyle fiyatlar.
 */
export function aiPriceFor(model: string, table: Readonly<Record<string, AiPrice>> = AI_LIST_PRICES_USD): { price: AiPrice; known: boolean } {
  const name = model.trim();
  if (name && Object.hasOwn(table, name)) return { price: table[name]!, known: true };
  const root = name.replace(DATED_MODEL, '');
  if (root !== name && Object.hasOwn(table, root)) return { price: table[root]!, known: true };
  const price = mostExpensiveAiPrice(table);
  const image = maxImagePrice(table);
  return { price: image > 0 ? { ...price, perOutputImage: image } : price, known: false };
}

/** Modelin sağlayıcısı: tablodan, yoksa ad önekinden (`claude-` → anthropic, `gemini-` → gemini), o da yoksa null. */
export function aiProviderOfModel(model: string, table: Readonly<Record<string, AiPrice>> = AI_LIST_PRICES_USD): AiProvider | null {
  const name = model.trim();
  const hit = Object.hasOwn(table, name) ? table[name] : Object.hasOwn(table, name.replace(DATED_MODEL, '')) ? table[name.replace(DATED_MODEL, '')] : undefined;
  if (hit?.provider) return hit.provider;
  if (name.startsWith('claude-')) return 'anthropic';
  if (name.startsWith('gemini-')) return 'gemini';
  return null;
}

// ---------- Kullanım ve ücret ----------

/** Araç içi sayacın kullanımı (DeciShip): `message.usage` input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens (5 dk). */
export type AiTokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/**
 * Geçidin ölçtüğü kullanım (defter satırının belirteç alanları).
 * - Anthropic: `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`; yazma `cache_creation.ephemeral_5m_input_tokens` ve
 *   `ephemeral_1h_input_tokens` (ayrıntı yoksa `cache_creation_input_tokens`'ın tamamı 5 dk sayılır). Akışta `message_start` + son
 *   `message_delta`.
 * - Gemini: `usageMetadata.promptTokenCount` (önbellekten okunan `cachedContentTokenCount` düşülmüş) → input, `cachedContentTokenCount`
 *   → cacheRead, `candidatesTokenCount` (+ `thoughtsTokenCount`) → output; `outputImages` yanıttaki görsel parça (`inlineData`
 *   image/*) sayısı.
 */
export type AiMeteredUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputImages?: number;
};

/** Abonelik limit anahtarı (`Subscription.limits`): DeciShip'in araç içi aylık ücretsiz hakkı, TL. Sayı değilse araç varsayılanı geçer. */
export const AI_LIMIT_CREDIT_MONTHLY = 'aiCreditMonthly';

/**
 * Abonelik limit anahtarı (`Subscription.limits`): firma × araç aylık koruma tavanı, USD (geçit uygular, `sod_tool_cap`). Sayı değilse
 * kayıttaki `ai.defaultCapUsd`. `false` ya da `0`: o araçta yapay zekâ kapalı.
 */
export const AI_LIMIT_SPEND_CAP_MONTHLY_USD = 'aiSpendCapMonthlyUsd';

/** Araç içi sayacın fiyat listesi para birimi (DeciShip `HubAiUsage`); firmanın para biriminden bağımsız. Defterin birimi `AI_LEDGER_CURRENCY`. */
export const AI_CURRENCY = 'TRY' as const;

/** Geçit defterinin para birimi. Tutar mikro USD tamsayıdır. */
export const AI_LEDGER_CURRENCY = 'USD' as const;

/** 1 birim (TL ya da USD) = 1.000.000 mikro. Satır ücreti ve kota karşılaştırması mikro tamsayıyla yapılır. */
export const AI_MICROS_PER_UNIT = 1_000_000;

/** Ekran kuru varsayılanı: 1 USD = 100 TL (DeciShip `AI_PRICE_TRY_PER_USD` ile aynı). Geçit ortamla ezer; satırın kuru `priceVersion`'dadır. */
export const AI_TRY_PER_USD_DEFAULT = 100;

/** Dönem biçimi `YYYY-MM`. */
export const AI_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const tokens = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Yuvarlanmamış ücret, mikro USD. USD / 1M token × token = mikro USD. Toplama sırası eski `aiCostMicros` ile aynı (girdi, çıktı,
 * 5 dk yazma, 1 sa yazma, okuma, görsel): DeciShip'in TL sonucu bit bit aynı kalsın.
 */
function rawMicroUsd(u: AiMeteredUsage, price: AiPrice): number {
  const input = tokens(u.inputTokens);
  const output = tokens(u.outputTokens);
  const read = tokens(u.cacheReadTokens);
  const w5 = tokens(u.cacheWrite5mTokens);
  const w1 = tokens(u.cacheWrite1hTokens);
  const prompt = input + read + w5 + w1;
  const p = price.above && prompt > price.above.promptTokens ? price.above.price : price;
  const images = tokens(u.outputImages);
  const imagePrice = price.perOutputImage ?? 0;
  const textOut = output * p.output;
  const out = images > 0 && imagePrice > 0 ? Math.max(textOut, images * imagePrice * AI_MICROS_PER_UNIT) : textOut;
  return input * p.input + out + w5 * p.cacheWrite + (w1 ? w1 * write1hOf(p) : 0) + read * p.cacheRead;
}

/**
 * Geçidin ücreti: mikro USD, tamsayı (satır başına tek `Math.round`; toplamlar yuvarlanmamış tamsayılarla alınır).
 * Örnek: Sonnet 5.5, 1.000 girdi + 1.000 çıktı → 1000×2 + 1000×10 = 12.000 mikro USD = 0,012 $.
 * Eksi ya da sayı olmayan token ve görsel 0 sayılır. Bilinmeyen model için çağıran `aiPriceFor` kullanır (en pahalı fiyat).
 */
export function aiCostMicroUsd(u: AiMeteredUsage, price: AiPrice): number {
  return Math.round(rawMicroUsd(u, price));
}

/**
 * Araç içi sayacın ücreti (mikro TL, tamsayı) = yuvarlanmamış mikro USD × kur, tek `Math.round`. 1 USD = `tryPerUsd` TL.
 * `cacheWriteTokens` 5 dakikalık yazmadır. Örnek: Sonnet 5.5, 1.000 girdi + 1.000 çıktı, kur 100 → 1.200.000 mikro TL = 1,20 TL.
 * Kur sonlu ve sıfırdan büyük değilse RangeError (sessizce 0 ücret olmasın).
 */
export function aiCostMicros(u: AiTokenUsage, price: AiPrice, tryPerUsd: number): number {
  if (!Number.isFinite(tryPerUsd) || tryPerUsd <= 0) throw new RangeError(`aiCostMicros: invalid rate ${tryPerUsd}`);
  const usd = rawMicroUsd(
    { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWrite5mTokens: u.cacheWriteTokens, cacheWrite1hTokens: 0 },
    price,
  );
  return Math.round(usd * tryPerUsd);
}

/** Mikro USD → mikro TL (ekran; defter USD kalır). Kur geçersizse RangeError. */
export function aiMicroUsdToMicroTry(microUsd: number, tryPerUsd: number): number {
  if (!Number.isFinite(tryPerUsd) || tryPerUsd <= 0) throw new RangeError(`aiMicroUsdToMicroTry: invalid rate ${tryPerUsd}`);
  return Math.round(microUsd * tryPerUsd);
}

/** Mikro (TL ya da USD) → ekrandaki tutar (2 hane, yarım yukarı). Toplamlar ve kota yuvarlanmamış mikro değerle karşılaştırılır. */
export function aiMicrosToAmount(micros: number): number {
  return Math.round(micros / 10_000) / 100;
}

/** Kısa, kararlı özet (cyrb53; kriptografik değil, yalnız sürüm etiketi). Tarayıcıda da çalışsın diye `node:crypto` yok. */
function digest12(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(0, 12);
}

/**
 * Geçit satırının `priceVersion`'ı: `r<kur>:<12 hane özet>` (DeciShip'in biçimi; `aiPriceUsdRateOf` kuru okur). Özet etkin tablonun
 * bütün alanlarından, model adına göre sıralı. Geçmiş satır yeniden fiyatlanmaz; hangi fiyat ve kurla yazıldığı buradan bilinir.
 */
export function aiPriceVersion(table: Readonly<Record<string, AiPrice>>, tryPerUsd: number): string {
  const rows = Object.keys(table)
    .sort()
    .map((k) => {
      const p = table[k]!;
      return [k, p.provider ?? null, p.input, p.output, p.cacheWrite, write1hOf(p), p.cacheRead, p.perOutputImage ?? 0, p.above ? [p.above.promptTokens, p.above.price.input, p.above.price.output, p.above.price.cacheWrite, write1hOf(p.above.price), p.above.price.cacheRead] : null];
    });
  return `r${tryPerUsd}:${digest12(JSON.stringify(rows))}`;
}

/** `priceVersion`'dan kur (`r<kur>:…`); başka biçimde null. */
export function aiPriceUsdRateOf(priceVersion: string): number | null {
  const m = /^r(\d+(?:\.\d+)?):/.exec(priceVersion);
  return m ? Number(m[1]) : null;
}

/**
 * Anın dönemi: `YYYY-MM`, verilen saat diliminde (firmanın saat dilimi; IANA adı). Satıra çağrı anında yazılır, saat dilimi
 * sonradan değişse de eski satır yerinde kalır. Geçersiz saat dilimi Intl'in RangeError'ını fırlatır.
 */
export function aiPeriodOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = parts.find((x) => x.type === 'year')?.value;
  const month = parts.find((x) => x.type === 'month')?.value;
  if (!year || !month) throw new RangeError(`aiPeriodOf: ${timeZone}`);
  return `${year}-${month}`;
}

/** Sonraki dönem: '2026-12' → '2027-01'. Biçim bozuksa RangeError. */
export function aiNextPeriod(period: string): string {
  if (!AI_PERIOD_PATTERN.test(period)) throw new RangeError(`aiNextPeriod: ${period}`);
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ---------- Geçit: yollar ----------

/** Geçidin konteyner portu (`ai-api`). */
export const AI_GATEWAY_PORT = 4300;

/**
 * Araç yolları (yalnız iç ağ; gateway `internal` geçen yolu dışarıya 404 yapar). Araç SDK'nın taban adresini `aiGatewayBaseUrl` ile
 * kurar; SDK yolun kalanını kendisi ekler. Listede olmayan sağlayıcı yolu geçitte 404 (izin listesi).
 * - `POST /internal/anthropic/v1/messages` (akışlı ya da değil), `POST /internal/anthropic/v1/messages/count_tokens` (ücretsiz;
 *   deftere yazılmaz, bağlam başlıkları yine zorunlu).
 * - `POST /internal/gemini/v1beta/models/{model}:generateContent` ve `:streamGenerateContent` (`aiGeminiPath`).
 * - `GET /internal/status` → `AiGatewayStatus`; `GET /internal/allowance?orgId=` → `AiAllowance` (`aiSpend.ts`). İkisi de araç jetonuyla
 *   (`x-api-key`), bağlam başlığı istemez.
 */
export const AI_GATEWAY_PATHS = {
  anthropicBase: '/internal/anthropic',
  anthropicMessages: '/internal/anthropic/v1/messages',
  anthropicCountTokens: '/internal/anthropic/v1/messages/count_tokens',
  geminiBase: '/internal/gemini/v1beta',
  status: '/internal/status',
  allowance: '/internal/allowance',
} as const;

/** Gemini üretim yolu. */
export function aiGeminiPath(model: string, stream: boolean): string {
  return `${AI_GATEWAY_PATHS.geminiBase}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
}

/**
 * SDK taban adresi: `AI_GATEWAY_URL` (ör. `http://ai-api:4300`) + sağlayıcı öneki. Anthropic: `new Anthropic({ baseURL, apiKey:
 * AI_GATEWAY_TOKEN })`; Gemini (TagPress `createGemini({ baseUrl })`, `/v1beta` dahil): `x-goog-api-key` = `AI_GATEWAY_TOKEN`.
 */
export function aiGatewayBaseUrl(gatewayUrl: string, provider: AiProvider): string {
  const base = gatewayUrl.replace(/\/+$/, '');
  return `${base}${provider === 'anthropic' ? AI_GATEWAY_PATHS.anthropicBase : AI_GATEWAY_PATHS.geminiBase}`;
}

/**
 * Aracın kimliği: SDK'nın kendi anahtar başlığı (`x-api-key` ya da `x-goog-api-key`) = geçidin `AI_GATEWAY_TOKENS`
 * (`deciship=…,tagpress=…`) içindeki araç jetonu; ürün jetondan çözülür. Yanlış ya da eksik jeton `sod_unauthorized`.
 */
export const AI_GATEWAY_KEY_HEADERS: Readonly<Record<AiProvider, string>> = { anthropic: 'x-api-key', gemini: 'x-goog-api-key' };

// ---------- Geçit: bağlam başlıkları ----------

/**
 * Başlık adları (küçük harf). İstekte bağlam: `org` (zorunlu), `member` (kişi yoksa gönderilmez: arka plan işi), `purpose` (zorunlu,
 * kayıttaki `ai.purposes` anahtarı), `requestId` (zorunlu, aracın mantıksal çağrı kimliği), `origin` (zorunlu, `request` | `job`),
 * `attempt` (isteğe bağlı; yoksa SDK'nın `x-stainless-retry-count`'u, o da yoksa 0). Geçit bunları ve gelen anahtar başlığını
 * sağlayıcıya göndermez (gerçek anahtarı kendisi ekler); gövdeyi saklamaz, günlüğe yazmaz.
 * Yanıtta: `callId` (defter satırının kimliği, UUIDv7; ret yanıtında da var), retlerde `reject` (`AiRejectCode`) ve `shouldRetry`
 * (`false`: SDK bu başlığa uyar, kendiliğinden yeniden denemez). Sağlayıcının durum kodu, gövdesi ve `retry-after`/`request-id`
 * başlıkları değişmeden geçer. `x-sod-org` adı Hesap'ın tarayıcı başlığıyla (`ORG_HEADER`) aynıdır; burada araç → geçit iç isteğidir.
 */
export const AI_HEADERS = {
  org: 'x-sod-org',
  member: 'x-sod-member',
  purpose: 'x-sod-purpose',
  requestId: 'x-sod-request-id',
  origin: 'x-sod-origin',
  attempt: 'x-sod-attempt',
  callId: 'x-sod-ai-call-id',
  reject: 'x-sod-ai-reject',
  shouldRetry: 'x-should-retry',
  /**
   * Geçidin kendi 5xx yanıtında, istek sağlayıcıya gittikten sonra (bağlantı koptu, süre doldu, aktarım hatası): değer
   * `AI_CHARGED_MAYBE`. Ücret doğmuş olabilir (defter satırı üst tahminle yazıldı); araç bunu geçici hata sayıp kendiliğinden
   * yeniden DENEMEZ (iş kuyruğu dahil), kalıcı hata verir, kullanıcı isterse yeniden başlatır. Başlık yoksa geçidin 5xx'i ücretsizdir.
   */
  charged: 'x-sod-ai-charged',
  /** SDK'nın deneme sayısı (Anthropic SDK gönderir). */
  sdkRetryCount: 'x-stainless-retry-count',
} as const;

/** `x-sod-ai-charged` değeri: ücret doğmuş olabilir. */
export const AI_CHARGED_MAYBE = 'maybe' as const;

/** Geçidin sağlayıcıya iletmeden sildiği istek başlıkları (bağlam). Ayrıca `x-sod-` ile başlayan her başlık silinir. */
export const AI_CONTEXT_HEADERS: readonly string[] = [AI_HEADERS.org, AI_HEADERS.member, AI_HEADERS.purpose, AI_HEADERS.requestId, AI_HEADERS.origin, AI_HEADERS.attempt];

/** Çağrının çıkışı: kişinin isteği (`request`) ya da arka plan işi (`job`; tavan dolmadan açılmış işe %20 pay kuralı buna bakar). */
export const AI_CALL_ORIGINS = ['request', 'job'] as const;
export type AiCallOrigin = (typeof AI_CALL_ORIGINS)[number];

/**
 * Amaç: `<ürün>.<amaç>`; amaç küçük harf, rakam, `_` (ör. `tagpress.builder_turn`, `deciship.invoice_pdf`). Kayıttaki
 * `ai.purposes`'ta olmayan amaç geçitte `sod_purpose_unknown`.
 */
export const AI_PURPOSE_PATTERN = /^[a-z][a-z0-9]{2,19}\.[a-z][a-z0-9_]{1,39}$/;

/** Aracın bugünkü amaç adından geçit amacı: `aiPurposeKey('tagpress', 'builder-turn')` → `tagpress.builder_turn`. Geçersizse RangeError. */
export function aiPurposeKey(product: string, local: string): string {
  const key = `${product}.${local.trim().toLowerCase().replace(/-/g, '_')}`;
  if (!AI_PURPOSE_PATTERN.test(key)) throw new RangeError(`aiPurposeKey: ${key}`);
  return key;
}

/** `x-sod-request-id`: aracın mantıksal çağrı kimliği (UUID önerilir). Defterde `UNIQUE(product, toolRequestId, attempt)`. */
export const AI_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Firma ve kişi kimliği başlığı (Hesap kimlikleri). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Araç → geçit çağrısının bağlamı. */
export type AiCallContext = {
  orgId: string;
  /** Hesap `Membership.id`; arka plan işinde kişi yoksa null. */
  memberId: string | null;
  purpose: string;
  requestId: string;
  origin: AiCallOrigin;
  /** Aracın kendi yeniden denemesi (SDK dışı); yoksa SDK sayacı. */
  attempt?: number;
};

/** Araç tarafı: bağlam başlıkları (SDK'nın istek başına `headers` seçeneğine). Değerleri denetlemez; geçit denetler. */
export function aiContextHeaders(ctx: AiCallContext): Record<string, string> {
  const h: Record<string, string> = {
    [AI_HEADERS.org]: ctx.orgId,
    [AI_HEADERS.purpose]: ctx.purpose,
    [AI_HEADERS.requestId]: ctx.requestId,
    [AI_HEADERS.origin]: ctx.origin,
  };
  if (ctx.memberId) h[AI_HEADERS.member] = ctx.memberId;
  if (ctx.attempt !== undefined) h[AI_HEADERS.attempt] = String(ctx.attempt);
  return h;
}

type HeaderBag = { get(name: string): string | null } | Readonly<Record<string, string | readonly string[] | undefined>>;

function headerOf(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  const bag = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : bag[key];
  return Array.isArray(v) ? v[0] : (v as string | undefined);
}

/**
 * Geçit tarafı: başlıklardan bağlam. Biçim hatası `sod_context_invalid` (alan adlarıyla); amacın kayıtta olup olmadığına ve araç
 * ürününe ait olduğuna (`purpose` öneki = jetonun ürünü) çağıran ayrıca bakar (`sod_purpose_unknown`). Deneme: `x-sod-attempt`,
 * yoksa `x-stainless-retry-count`, yoksa 0.
 */
export function parseAiContextHeaders(headers: HeaderBag): { ok: true; ctx: Required<AiCallContext> } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const org = headerOf(headers, AI_HEADERS.org)?.trim() ?? '';
  const memberRaw = headerOf(headers, AI_HEADERS.member)?.trim() ?? '';
  const purpose = headerOf(headers, AI_HEADERS.purpose)?.trim() ?? '';
  const requestId = headerOf(headers, AI_HEADERS.requestId)?.trim() ?? '';
  const origin = headerOf(headers, AI_HEADERS.origin)?.trim() ?? '';
  const attemptRaw = (headerOf(headers, AI_HEADERS.attempt) ?? headerOf(headers, AI_HEADERS.sdkRetryCount) ?? '0').trim();
  if (!ID_PATTERN.test(org)) invalid.push(AI_HEADERS.org);
  if (memberRaw && !ID_PATTERN.test(memberRaw)) invalid.push(AI_HEADERS.member);
  if (!AI_PURPOSE_PATTERN.test(purpose)) invalid.push(AI_HEADERS.purpose);
  if (!AI_REQUEST_ID_PATTERN.test(requestId)) invalid.push(AI_HEADERS.requestId);
  if (!(AI_CALL_ORIGINS as readonly string[]).includes(origin)) invalid.push(AI_HEADERS.origin);
  const attempt = /^\d{1,3}$/.test(attemptRaw) ? Number(attemptRaw) : -1;
  if (attempt < 0) invalid.push(AI_HEADERS.attempt);
  if (invalid.length) return { ok: false, invalid };
  return { ok: true, ctx: { orgId: org, memberId: memberRaw || null, purpose, requestId, origin: origin as AiCallOrigin, attempt } };
}

// ---------- Geçit: ret kodları ----------

/**
 * Geçidin kendi reddi ve HTTP durumu. Sağlayıcının hataları bu listede değildir, olduğu gibi geçer.
 * - `sod_unauthorized` (401): araç jetonu yok ya da yanlış.
 * - `sod_context_invalid` (400): bağlam başlığı eksik ya da bozuk (`parseAiContextHeaders`).
 * - `sod_purpose_unknown` (400): amaç kayıtta yok ya da başka aracın.
 * - `sod_model_not_allowed` (400): istenen model kayıttaki `ai.models`'ta yok (sunucu tarafı yedek modeller denetlenmez, fiyatlanır).
 * - `sod_body_too_large` (413): gövde `AI_LIMIT_DEFAULTS.maxBodyBytes`'ı aşıyor.
 * - `sod_org_closed` (403): firma kapalı ya da silinmiş (`org.closed`/`org.purged` olayı).
 * - `sod_platform_paused` (429): platform tavanı doldu ya da yönetici durdurdu. Firmaya "geçici olarak durduruldu" denir.
 * - `sod_org_cap` (429): firmanın tek ortak aylık hakkı doldu (dönem sonuna kadar).
 * - `sod_tool_cap` (429): firma × araç koruma tavanı doldu (dönem sonuna kadar, yalnız o araç).
 * - `sod_rate_limited` (429): hız ya da eşzamanlılık sınırı; `retry-after` saniye gelir.
 * - `sod_provider_missing` (503): sağlayıcı anahtarı girilmemiş.
 */
export const AI_REJECT_STATUS = {
  sod_unauthorized: 401,
  sod_context_invalid: 400,
  sod_purpose_unknown: 400,
  sod_model_not_allowed: 400,
  sod_body_too_large: 413,
  sod_org_closed: 403,
  sod_platform_paused: 429,
  sod_org_cap: 429,
  sod_tool_cap: 429,
  sod_rate_limited: 429,
  sod_provider_missing: 503,
} as const;
export type AiRejectCode = keyof typeof AI_REJECT_STATUS;
export const AI_REJECT_CODES = Object.freeze(Object.keys(AI_REJECT_STATUS)) as readonly AiRejectCode[];

/**
 * Retlerin araçtaki anlamı (araç kodu buna göre seçer; hiçbiri aynı istekte yeniden denenmez):
 * - `paused`: platform durdu → TagPress `ai-paused`, DeciShip `AI_PLATFORM_PAUSED`.
 * - `cap`: hak ya da araç tavanı doldu → TagPress `budget-exceeded`, DeciShip `AI_SPEND_CAP`.
 * - `busy`: geçici; iş kuyruğu `retry-after`'dan sonra yeni bir istekle dener → DeciShip `AI_BUSY`.
 * - `unavailable`: anahtar yok → TagPress `ai-unavailable`, DeciShip yapay zekâ kapalı (`ai.available: false`).
 * - `closed`: firma kapalı → araç zaten `ORG_CLOSED` döner.
 * - `misconfigured`: aracın ya da kurulumun hatası (jeton, başlık, amaç, model, gövde); günlüğe hata, kullanıcıya genel hata.
 */
export type AiRejectKind = 'paused' | 'cap' | 'busy' | 'unavailable' | 'closed' | 'misconfigured';
export const AI_REJECT_KIND: Readonly<Record<AiRejectCode, AiRejectKind>> = {
  sod_unauthorized: 'misconfigured',
  sod_context_invalid: 'misconfigured',
  sod_purpose_unknown: 'misconfigured',
  sod_model_not_allowed: 'misconfigured',
  sod_body_too_large: 'misconfigured',
  sod_org_closed: 'closed',
  sod_platform_paused: 'paused',
  sod_org_cap: 'cap',
  sod_tool_cap: 'cap',
  sod_rate_limited: 'busy',
  sod_provider_missing: 'unavailable',
};

export function isAiRejectCode(value: unknown): value is AiRejectCode {
  return typeof value === 'string' && Object.hasOwn(AI_REJECT_STATUS, value);
}

/** Yanıt başlıklarından geçidin ret kodu (`x-sod-ai-reject`); sağlayıcı hatasında ya da başarıda null. Araç kararını buradan verir. */
export function aiRejectCodeOf(headers: HeaderBag): AiRejectCode | null {
  const v = headerOf(headers, AI_HEADERS.reject)?.trim();
  return isAiRejectCode(v) ? v : null;
}

/** Ret gövdesi, Anthropic biçimi (SDK'nın hata ayrıştırması kırılmasın diye; araç kararı başlıktan verir). */
export type AiAnthropicRejectBody = { type: 'error'; error: { type: AiRejectCode; message: string } };
/** Ret gövdesi, Gemini biçimi. `reason` = ret kodu. */
export type AiGeminiRejectBody = { error: { code: number; message: string; status: string; reason: AiRejectCode } };

const GEMINI_STATUS: Readonly<Record<number, string>> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 503: 'UNAVAILABLE' };

/** Ret gövdesi: istek hangi sağlayıcı yolundaysa onun biçimi. `message` İngilizce geliştirici metnidir (kullanıcıya gösterilmez). */
export function aiRejectBody(provider: AiProvider, code: AiRejectCode, message: string = code): AiAnthropicRejectBody | AiGeminiRejectBody {
  if (provider === 'anthropic') return { type: 'error', error: { type: code, message } };
  const status = AI_REJECT_STATUS[code];
  return { error: { code: status, message, status: GEMINI_STATUS[status] ?? 'UNKNOWN', reason: code } };
}

/** Ret yanıtının başlıkları (+ `x-sod-ai-call-id` geçit ekler). `retryAfterSeconds` yalnız `sod_rate_limited` ve tavanlarda anlamlı. */
export function aiRejectHeaders(code: AiRejectCode, retryAfterSeconds?: number): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', [AI_HEADERS.reject]: code, [AI_HEADERS.shouldRetry]: 'false' };
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) h['retry-after'] = String(Math.ceil(retryAfterSeconds));
  return h;
}
