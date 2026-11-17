/**
 * Yapay zekâ kullanım sözleşmesi (Mesaj 6). Sayaç ve defter her aracın kendi veritabanındadır; fiyat hesabı, limit anahtarı,
 * dönem kuralı ve Merkez ucu (`GET /api/<ürün>/platform/ai-usage`, yanıtı `HubAiUsage`) bütün araçlarda aynıdır.
 * Saf işlevler; bağımlılık yok.
 */

/**
 * Sağlayıcı liste fiyatı, USD / 1 milyon token. `cacheWrite` 5 dakikalık önbelleğe yazma, `cacheRead` önbellekten okuma.
 * `above` (05-B13): istem uzunluğuna göre fiyatlanan model (Haiku 5.5): isteğin istemi (girdi + önbellekten okuma + önbelleğe
 * yazma tokeni) `promptTokens`'ı aşarsa bütün istek `price` ile fiyatlanır (sağlayıcının kuralı: istek başına ayrı).
 */
export type AiPrice = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  above?: { promptTokens: number; price: Omit<AiPrice, 'above'> };
};

/**
 * Tarih: 2026-11-13. Kaynak: Anthropic resmî fiyat sayfası (https://platform.claude.com/docs/en/about-claude/pricing,
 * "Model pricing" tablosu; o gün okundu, 05-B13). Değerler sayfadan birebir: girdi, 5 dakikalık önbelleğe yazma, önbellekten
 * okuma ("Cache hits and refreshes"), çıktı. Fiyat değişirse bu tablo ve tarih birlikte güncellenir; araçta
 * `AI_PRICE_TABLE` ortam değişkeniyle ezilir (ezme kademeli fiyat taşımaz, düz fiyattır). Model adları `CLAUDE_MODEL` ve
 * sunucu tarafı yedek model listesiyle (DeciShip `services/ai.ts` FALLBACK_MODELS) aynı olmalı.
 * - Sonnet 5.5 önbellekten okuma 0,10 $ (eski tabloda 0,20 yazıyordu; Sonnet 5'in fiyatı).
 * - Haiku 5.5: 100.000 tokene kadar istem 0,10 / 0,50 $, üstü 0,50 / 2,50 $ (`above`).
 */
export const AI_LIST_PRICES_USD: Readonly<Record<string, AiPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-fable-5-2': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    above: { promptTokens: 100_000, price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
  },
};

/**
 * Tablonun en pahalı fiyatı: her kalem (girdi, çıktı, önbelleğe yazma, önbellekten okuma) tablodaki en yüksek değer, kademeli
 * fiyatın üst kademesi dahil (düz fiyat). Tabloda olmayan model bundan sayılır: hiçbir modelden eksik ücretlendirilmez.
 * İnceleme 2026-11-13: eskiden sabit bir modelin liste fiyatıydı; `AI_PRICE_TABLE` bir modeli onun üstüne çıkarınca bilinmeyen
 * model ucuz sayılıyordu. Araç bunu etkin tabloyla (liste + ezme) çağırır. Boş tabloda liste fiyatlarının en pahalısı.
 */
export function mostExpensiveAiPrice(table: Readonly<Record<string, AiPrice>>): AiPrice {
  const prices = Object.values(table).flatMap((p) => (p.above ? [p, p.above.price] : [p]));
  if (!prices.length) return table === AI_LIST_PRICES_USD ? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } : mostExpensiveAiPrice(AI_LIST_PRICES_USD);
  const max = (k: 'input' | 'output' | 'cacheWrite' | 'cacheRead') => Math.max(...prices.map((p) => p[k]));
  return { input: max('input'), output: max('output'), cacheWrite: max('cacheWrite'), cacheRead: max('cacheRead') };
}

/** Liste fiyatlarının en pahalısı (`mostExpensiveAiPrice`); araç ezmeli etkin tabloyu kullanır. */
export const AI_UNKNOWN_MODEL_PRICE: AiPrice = mostExpensiveAiPrice(AI_LIST_PRICES_USD);

/** Sağlayıcı yanıtındaki kullanım (`message.usage`): input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens. */
export type AiTokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** Abonelik limit anahtarı (`Subscription.limits`): aylık ücretsiz yapay zekâ hakkı, TL. Sayı değilse araç varsayılanı geçer. */
export const AI_LIMIT_CREDIT_MONTHLY = 'aiCreditMonthly';

/** Fiyat listemizin para birimi; firmanın para biriminden bağımsız. */
export const AI_CURRENCY = 'TRY' as const;

/** 1 TL = 1.000.000 mikro TL. Satır ücreti ve kota karşılaştırması mikro TL tamsayıyla yapılır. */
export const AI_MICROS_PER_UNIT = 1_000_000;

/** Dönem biçimi `YYYY-MM`. */
export const AI_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Ücret (mikro TL, tamsayı) = Σ token × (USD/1M × kur). 1 USD = `tryPerUsd` TL. Sonuç Math.round ile tamsayı.
 * USD/1M token × kur = token başına mikro TL olduğundan çarpım doğrudan mikro TL verir.
 * Örnek: Sonnet 5.5, 1.000 girdi + 1.000 çıktı, kur 100 → 1000×200 + 1000×1000 = 1.200.000 mikro TL = 1,20 TL.
 * Eksi ya da sayı olmayan token 0 sayılır. Kur sonlu ve sıfırdan büyük değilse RangeError (sessizce 0 ücret olmasın).
 */
export function aiCostMicros(u: AiTokenUsage, price: AiPrice, tryPerUsd: number): number {
  if (!Number.isFinite(tryPerUsd) || tryPerUsd <= 0) throw new RangeError(`aiCostMicros: invalid rate ${tryPerUsd}`);
  // 05-B13: istem uzunluğuna göre fiyatlanan modelde istem eşiği aşarsa bütün istek üst fiyattan
  const prompt = tokens(u.inputTokens) + tokens(u.cacheReadTokens) + tokens(u.cacheWriteTokens);
  const p = price.above && prompt > price.above.promptTokens ? price.above.price : price;
  const usd =
    tokens(u.inputTokens) * p.input +
    tokens(u.outputTokens) * p.output +
    tokens(u.cacheWriteTokens) * p.cacheWrite +
    tokens(u.cacheReadTokens) * p.cacheRead;
  return Math.round(usd * tryPerUsd);
}

/** Mikro TL → ekrandaki tutar (TL, 2 hane, yarım yukarı). Toplamlar ve kota yuvarlanmamış mikro değerle karşılaştırılır. */
export function aiMicrosToAmount(micros: number): number {
  return Math.round(micros / 10_000) / 100;
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
