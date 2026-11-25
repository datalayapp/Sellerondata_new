/**
 * Yapay zekâ harcama defteri ve geçidin (`ai-api`) uçları: defter satırı, günlük özet, tavanlar ve hak, Merkez harcama görünümü,
 * platform yöneticisi uçları. Fiyat, başlık ve ret kodları `ai.ts`'te.
 *
 * Erişim (Merkez uçları, gateway `/api/ai/`, kimlik Hesap erişim jetonu):
 * - Firma görünümü: etkin firmanın OWNER'ı ya da ADMIN'i (jetondaki `orgRole`), bütün araçlarıyla. Diğer üyeler `403 FORBIDDEN`.
 *   Tutar TL'dir (karar 2026-11-21); dönem ve günler firmanın saat diliminde (geçit `org.updated.timeZone`'dan bilir).
 * - Platform görünümü (`scope=platform`): yalnız platform yöneticisi (jetonda `op: true`); bütün firmalar, `org` süzgeciyle; TL ve
 *   USD birlikte; günler UTC. `op` olmayana `403 FORBIDDEN`.
 * - Yönetici uçları (`/api/ai/admin/*`): `op`; değiştirenler ayrıca adım artırma jetonu (`STEP_UP_HEADER`, `tokens.ts`), yoksa
 *   `403 STEP_UP_REQUIRED`. Acil durdurma (`paused: true`) adım artırma istemez; geri açma ister.
 * Hata gövdesi platformun ortak biçimi (`ApiErrorBody`).
 */

import type { ProductKey } from './catalog.ts';
import type { AiCallOrigin, AiProvider } from './ai.ts';
import type { HubAnalytics, HubDatasetPage } from './hub.ts';

// ---------- Defter ----------

/**
 * Defter satırının durumu.
 * - `pending`: kabul edildi, sağlayıcı yanıtı sürüyor; üst sınır payı (`reservedMicroUsd`) tavanlarda sayılır. Tek koşullu güncellemeyle
 *   (`WHERE status = 'pending'`) kapanır; iki kez kapanamaz.
 * - `ok`: yanıt tamam. `failed`: sağlayıcı hata döndü (ücret sağlayıcının saydığı kadar, çoğunlukla 0).
 * - `cancelled`: araç bağlantıyı kesti, geçit de sağlayıcıyı kesti; kullanım tahmini (`estimated`), bilinmeyen kısım fazla sayılır.
 * - `rejected`: geçidin kendi reddi (`errorCode` = `AiRejectCode`); tutar 0, sağlayıcıya gidilmedi.
 * - `interrupted`: süreç çöktü; açılış taraması `pending` satırı üst tahminle kapatır (`estimated`).
 */
export const AI_CALL_STATUSES = ['pending', 'ok', 'failed', 'cancelled', 'rejected', 'interrupted'] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

/** Anahtarın kaynağı: `platform` (bugün tek kaynak) ya da ileride firmanın kendi anahtarı (`org`; platform tavanına girmez). */
export const AI_KEY_SOURCES = ['platform', 'org'] as const;
export type AiKeySource = (typeof AI_KEY_SOURCES)[number];

/**
 * `ai.AiCall` satırı (JSON biçimi: zamanlar ISO, tutar mikro USD tamsayı; Postgres'te BIGINT). Her yukarı akış denemesi ayrı satırdır
 * (sağlayıcı her denemeyi ücretlendirir); `UNIQUE(product, toolRequestId, attempt)`.
 */
export type AiLedgerCall = {
  /** UUIDv7; yanıttaki `x-sod-ai-call-id` ile aynı. */
  id: string;
  /** Araç jetonundan. */
  product: ProductKey;
  /** `x-sod-org`. */
  orgId: string;
  /** `x-sod-member`; arka plan işinde null. */
  memberId: string | null;
  /** `x-sod-purpose`, kayıttaki `ai.purposes` anahtarı. */
  purpose: string;
  origin: AiCallOrigin;
  provider: AiProvider;
  /** Gövdedeki `model` (Gemini: yoldaki model). */
  requestedModel: string;
  /** Yanıtı veren model (sunucu tarafı yedek modele düşülmüşse farklı); yanıt gelmediyse null. */
  servedModel: string | null;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Gövdedeki görsel girdi sayısı (bilgi; fiyat tokenle). */
  inputImages: number;
  /** Gemini'nin ürettiği görsel sayısı. */
  outputImages: number;
  /** `aiCostMicroUsd` (yanıtı veren model, yoksa istenen; tabloda yoksa en pahalı fiyat). */
  costMicroUsd: number;
  /** Kabulde ayrılan üst sınır payı; satır kapanınca 0. */
  reservedMicroUsd: number;
  /** `aiPriceVersion(tablo, kur)`. */
  priceVersion: string;
  status: AiCallStatus;
  /** Ret kodu (`rejected`), sağlayıcının hata türü (`failed`: Anthropic `error.type`, Gemini `error.status`) ya da null. */
  errorCode: string | null;
  httpStatus: number | null;
  estimated: boolean;
  keySource: AiKeySource;
  /** `x-sod-request-id`. */
  toolRequestId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Sağlayıcının `request-id` başlığı. */
  upstreamRequestId: string | null;
};

/**
 * `ai.AiSpendDaily`: gün (UTC, `YYYY-MM-DD`) × firma × ürün × amaç × model × durum × anahtar kaynağı. Bakım işi yazar; süresiz tutulur.
 * Firma kalıcı silinince (`org.purged`) ayrıntılı satırlar silinir, bu özet kalır: firma kimliği kalır, firma adı ve kişi hiç yoktur
 * (karar 2026-11-21).
 */
export type AiSpendDaily = {
  day: string;
  orgId: string;
  product: ProductKey;
  purpose: string;
  /** `servedModel ?? requestedModel`. */
  model: string;
  status: Exclude<AiCallStatus, 'pending'>;
  keySource: AiKeySource;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputImages: number;
  costMicroUsd: number;
};

/** Ayrıntılı satırların saklama süresi (ay) [V]; bakım işi eskisini siler, günlük özet kalır. */
export const AI_LEDGER_RETENTION_MONTHS = 24;

// ---------- Tavanlar ve hak ----------

/**
 * Geçidin varsayılanları [V]. Ortam değişkenleri ezer (`AI_PLATFORM_DAILY_USD`, `AI_PLATFORM_MONTHLY_USD`, `AI_ORG_MONTHLY_USD`),
 * yönetici ekranı platform tavanlarını ve firma başına hakkı ezer. Firma × araç tavanı: `Subscription.limits.aiSpendCapMonthlyUsd`,
 * yoksa kayıttaki `ai.defaultCapUsd`.
 * - Pay: kabulden önce isteğin üst sınır tutarı ayrılır (`max_tokens` × çıktı fiyatı + gövde baytından tahmini girdi); `harcanan +
 *   ayrılan + bu pay > tavan` ise ret. Tavan dolmadan açılmış arka plan işi (`origin: job`, aynı `x-sod-request-id` zinciri) tavanın
 *   `jobOverrunPct` üstüne kadar sürer.
 * - `warnPct`: hak bu yüzdeye gelince `state: 'warn'`; firma sahibine ve yöneticisine ayda bir posta.
 */
export const AI_LIMIT_DEFAULTS = {
  platformDailyUsd: 10,
  platformMonthlyUsd: 150,
  orgMonthlyUsd: 30,
  warnPct: 80,
  jobOverrunPct: 20,
  orgCallsPerMinute: 30,
  orgConcurrentStreams: 4,
  toolConcurrent: 12,
  maxBodyBytes: 32 * 1024 * 1024,
  maxStreamMs: 15 * 60 * 1000,
} as const;

/** Hak durumu: `ok`; `warn` (`warnPct` aşıldı); `capped` (firma hakkı ya da araç tavanı doldu); `paused` (platform durdu). */
export const AI_ALLOWANCE_STATES = ['ok', 'warn', 'capped', 'paused'] as const;
export type AiAllowanceState = (typeof AI_ALLOWANCE_STATES)[number];

/**
 * `GET /internal/allowance?orgId=` (araç jetonuyla; iç ağ). Firmanın tek ortak aylık hakkı (bütün araçlar) ve çağıran aracın tavanı.
 * Dönem firmanın saat diliminde. Araç bunu en çok 30 sn önbellekler (TagPress aylık sınırı, DeciShip `/me`).
 * `state`: platform durduysa `paused`; hak ya da araç tavanı dolduysa `capped`; birinden biri `warnPct`'i aştıysa `warn`.
 */
export type AiAllowance = {
  period: string;
  /** ISO: dönemin bittiği (yeni hakkın başladığı) an. */
  resetsAt: string;
  capMicroUsd: number;
  usedMicroUsd: number;
  reservedMicroUsd: number;
  /** `max(0, cap - used - reserved)`. */
  remainingMicroUsd: number;
  state: AiAllowanceState;
  /** Çağıran aracın firma × araç tavanı; `capMicroUsd` null: tavan yok (yalnız firma hakkı). */
  tool: { product: ProductKey; capMicroUsd: number | null; usedMicroUsd: number };
};

/** Sağlayıcı anahtarının durumu: `ok`; `missing` (girilmemiş); `rejected` (sağlayıcı son denemede 401/403 döndü). */
export const AI_PROVIDER_STATES = ['ok', 'missing', 'rejected'] as const;
export type AiProviderState = (typeof AI_PROVIDER_STATES)[number];

/**
 * `GET /internal/status` (araç jetonuyla; iç ağ). `available`: en az bir sağlayıcı `ok` ve platform durmamış. Araç `aiEnabled()` /
 * `/me ai.available` değerini buradan okur (30 sn önbellek); geçide ulaşılamazsa geçici hata sayar.
 */
export type AiGatewayStatus = {
  available: boolean;
  paused: boolean;
  providers: Record<AiProvider, AiProviderState>;
};

// ---------- Merkez: harcama görünümü ----------

/** Merkez uçları (gateway `/api/ai/` → `ai-api:4300`). Olay alıcısı `/api/ai/internal/events` (dışarıya 404). */
export const AI_SPEND_PATHS = {
  summary: '/api/ai/spend/summary',
  calls: '/api/ai/spend/calls',
  export: '/api/ai/spend/calls/export',
  allowance: '/api/ai/spend/allowance',
  adminKeys: '/api/ai/admin/keys',
  adminLimits: '/api/ai/admin/limits',
  adminStatus: '/api/ai/admin/status',
  events: '/api/ai/internal/events',
} as const;

/** Merkez yanıtlarının `product` alanı (geçit ürün değil, ürünler arası görünüm). */
export const AI_SPEND_PRODUCT = 'ai';

/** Görünüm: etkin firma ya da (yalnız `op`) platform. */
export type AiSpendScope = 'org' | 'platform';

/**
 * Sorgu (`summary`, `calls`, `export` ortak). Bilinmeyen değerli süzgeç `400 VALIDATION`.
 * - `from`/`to`: `YYYY-MM-DD`, ikisi dahil; firma görünümünde firmanın saat diliminde, platformda UTC. En çok `AI_SPEND_MAX_MONTHS_BACK`
 *   ay geri, aralık en çok 366 gün. Yoksa bu ayın başından bugüne.
 * - `member`: `Membership.id` ya da `AI_SPEND_MEMBER_NONE` (kişisiz: arka plan işi ya da silinmiş kişi). Yalnız firma görünümünde.
 * - `org`: yalnız platform görünümünde.
 * - `currency`: tutar birimi; firma görünümünde yalnız `TRY` (başka değer `400 VALIDATION`), platformda `TRY` (varsayılan) ya da `USD`.
 */
export type AiSpendQuery = {
  scope?: AiSpendScope;
  from?: string;
  to?: string;
  product?: ProductKey;
  purpose?: string;
  model?: string;
  status?: Exclude<AiCallStatus, 'pending'>;
  member?: string;
  org?: string;
  currency?: 'TRY' | 'USD';
};

export const AI_SPEND_MAX_MONTHS_BACK = 12;
export const AI_SPEND_MEMBER_NONE = 'none';
export const AI_SPEND_CALLS_PAGE_SIZE = 50;
export const AI_SPEND_CALLS_PAGE_SIZE_MAX = 200;
/** Dışa aktarma üst sınırı; aşan aralık `400 VALIDATION` (`details: { reason: 'too_many_rows', maxRows }`). */
export const AI_SPEND_EXPORT_MAX_ROWS = 50_000;

/**
 * `GET /api/ai/spend/summary` → `HubAnalytics` (`product: AI_SPEND_PRODUCT`). Etiketler `Accept-Language`'a göre geçitte (araç adı
 * ve amaç etiketi kayıttan); Merkez mevcut Analiz çizimiyle gösterir. Kimlikler sabittir (aşağıda); tutar `format: 'money'`,
 * `currency` sorgunun birimi. `filters`: `product`, `purpose`, `model`, `status`, firma görünümünde `member`, platformda `org`.
 * Bölümler ve araçlar:
 * - `overview`: `kpis` (`AI_SPEND_KPI` sırasıyla; `spend_usd` yalnız platformda, `cap_used` yalnız firma görünümünde ya da `org`
 *   süzgeçli platformda), `daily` (timeseries `bar`, seri kimliği = ürün anahtarı, renk Merkez'de kayıttan), `by_status` (breakdown, anahtar = durum).
 * - `products` (`by_product`, anahtar = ürün; `href` araçtaki ayrıntı: DeciShip `/account/billing/ai/deciship`), `purposes`
 *   (`by_purpose`, anahtar = amaç), `models` (`by_model`, anahtar = model).
 * - `members` (`by_member`, anahtar = `memberId` ya da `none`, `label` boş: ad Merkez'de ekip listesinden çözülür): yalnız firma görünümü.
 * - `orgs` (`by_org`, anahtar = firma kimliği, `label` firma adı ya da silinmiş firmada boş): yalnız platform görünümü.
 * Boş dönem geçerli yanıttır (KPI'lar 0, `daily` boş seri).
 */
export type AiSpendSummary = HubAnalytics;

export const AI_SPEND_SECTIONS = { overview: 'overview', products: 'products', purposes: 'purposes', models: 'models', members: 'members', orgs: 'orgs' } as const;
export const AI_SPEND_WIDGETS = {
  kpis: 'kpis',
  daily: 'daily',
  byStatus: 'by_status',
  byProduct: 'by_product',
  byPurpose: 'by_purpose',
  byModel: 'by_model',
  byMember: 'by_member',
  byOrg: 'by_org',
} as const;

/**
 * KPI kimlikleri, gösterim sırasıyla: `spend` (tutar, sorgunun biriminde; `previous` önceki eşit dönem), `spend_usd` (platform: USD),
 * `calls` (çağrı sayısı, `pending` hariç; `hint` başarılı / başarısız / iptal), `tokens` (toplam belirteç), `cache_savings`
 * (önbellekten okumanın girdi fiyatına göre tasarrufu, tutar), `cap_used` (firma hakkının kullanılan yüzdesi, `percent`).
 */
export const AI_SPEND_KPI = ['spend', 'spend_usd', 'calls', 'tokens', 'cache_savings', 'cap_used'] as const;
export type AiSpendKpiId = (typeof AI_SPEND_KPI)[number];

/**
 * `GET /api/ai/spend/calls?…&page&pageSize` → `HubDatasetPage` (`id: 'calls'`), en yeni önce, `pending` dahil (durumu `pending`).
 * Satır `id` = çağrı kimliği. Sütunlar `AI_SPEND_CALL_COLUMNS` sırasıyla; `hiddenByDefault` olanlar ayrıntı panelindedir. `member`
 * hücresi `memberId` (ad Merkez'de çözülür), `org` sütunu yalnız platformda.
 * `GET /api/ai/spend/calls/export?…&format=csv|xlsx`: aynı süzgeçler ve sütunlar, başlıklar isteğin dilinde.
 */
export type AiSpendCallsPage = HubDatasetPage;

export const AI_SPEND_CALL_COLUMNS = [
  'at',
  'product',
  'purpose',
  'member',
  'model',
  'served_model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'images',
  'amount',
  'status',
  'estimated',
  'error_code',
  'duration_ms',
  'org',
] as const;
export type AiSpendCallColumn = (typeof AI_SPEND_CALL_COLUMNS)[number];

/**
 * `GET /api/ai/spend/allowance` (firma görünümü): tek ortak aylık hak (karar 2026-11-21 §9.3) ve araç kırılımı; Merkez "kalan hak"
 * kartı ve durdurma bandı. Tutarlar TL, 2 hane (`aiMicrosToAmount`). `pausedBy`: `platform` (platform durdu), `org` (hak doldu) ya da null.
 */
export type AiOrgAllowanceView = {
  period: string;
  periodStart: string;
  resetsAt: string;
  currency: 'TRY';
  capAmount: number;
  usedAmount: number;
  remainingAmount: number;
  /** 0..100+ tamsayı, aşağı yuvarlanır. */
  usedPct: number;
  state: AiAllowanceState;
  pausedBy: 'platform' | 'org' | null;
  byProduct: { product: ProductKey; usedAmount: number; capAmount: number | null; state: AiAllowanceState }[];
};

// ---------- Platform yöneticisi ----------

/**
 * `GET /api/ai/admin/keys` → `{ keys: AiAdminKey[] }` (her sağlayıcı bir satır). Anahtar hiçbir yanıtta dönmez; yalnız son 4 hane.
 * `PUT /api/ai/admin/keys/:provider` `{ key }` (adım artırma) → `AiAdminKey`: kaydetmeden önce sınar; sağlayıcı reddederse
 * `400 AI_KEY_REJECTED`, ulaşılamazsa `503 AI_PROVIDER_UNREACHABLE` (kaydedilmez). `DELETE …/:provider` (adım artırma) → `AiAdminKey`
 * (`state: 'missing'`). `POST …/:provider/test` (yalnız `op`; ücretsiz: `count_tokens` ya da model listesi) → `AiAdminKey`.
 */
export type AiAdminKey = {
  provider: AiProvider;
  state: AiProviderState;
  last4: string | null;
  /** Giren platform yöneticisinin adı (Hesap jetonundaki `name`). */
  setBy: string | null;
  setAt: string | null;
  lastTest: { at: string; ok: boolean; httpStatus: number | null } | null;
};
export type AiAdminKeysResponse = { keys: AiAdminKey[] };
export type AiAdminSetKeyBody = { key: string };

/** Yönetici firma tablosunun satırı (bu ay, UTC değil firmanın saat dilimindeki dönem). */
export type AiAdminOrgRow = {
  orgId: string;
  /** Silinmiş firmada null. */
  orgName: string | null;
  usedMicroUsd: number;
  byProduct: Partial<Record<ProductKey, number>>;
  capMicroUsd: number;
  /** Hak yöneticice ezildi mi (yoksa `AI_ORG_MONTHLY_USD`). */
  capOverridden: boolean;
  usedPct: number;
  state: AiAllowanceState;
};

/**
 * `GET /api/ai/admin/limits` → `AiAdminLimits`. `PATCH /api/ai/admin/limits` `AiAdminLimitsPatch`: `paused: true` yalnız `op`,
 * diğer her alan adım artırma ister. `PUT /api/ai/admin/limits/orgs/:orgId` `{ capUsd: number | null }` (adım artırma; null: varsayılana dön).
 */
export type AiAdminLimits = {
  platform: {
    dailyCapMicroUsd: number;
    monthlyCapMicroUsd: number;
    todayUsedMicroUsd: number;
    monthUsedMicroUsd: number;
    paused: boolean;
    pausedAt: string | null;
    pausedBy: string | null;
  };
  orgDefaultCapMicroUsd: number;
  /** Kayıttaki `ai.defaultCapUsd` (mikro USD); abonelik limiti firmada ezer. */
  tools: Partial<Record<ProductKey, { defaultCapMicroUsd: number }>>;
  /** Bu ay harcaması olan ya da hakkı ezilmiş firmalar, tutara göre büyükten küçüğe. */
  orgs: AiAdminOrgRow[];
  /** Ekran kuru (1 USD = ? TL). */
  tryPerUsd: number;
};
export type AiAdminLimitsPatch = { platformDailyUsd?: number; platformMonthlyUsd?: number; paused?: boolean };
export type AiAdminOrgCapBody = { capUsd: number | null };

/** `GET /api/ai/admin/status` (`op`): geçit durumu + fiyat tarihi eski sağlayıcılar (`aiStalePriceProviders`). */
export type AiAdminStatus = AiGatewayStatus & { checkedAt: string; stalePrices: AiProvider[] };
