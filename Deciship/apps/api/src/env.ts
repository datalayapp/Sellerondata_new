import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_LIST_PRICES_USD, hasDevPassword, isValidNotifySecret, strictVersion, type AiPrice } from '@sellerondata/contracts';
import { config as loadEnv } from 'dotenv';

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'SPEC.md')) || fs.existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();
loadEnv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

function resolveStorage(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(REPO_ROOT, dir);
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEV_JWKS_URL = 'http://localhost:4100/api/account/.well-known/jwks.json';
const DEV_ORIGINS = ['http://localhost:8088', 'http://localhost:5173'];

/** Geliştirmede süreç başına rastgele: dosya bağlantıları 10 dakikalık, yeniden başlayınca düşmeleri sorun değil. */
const DEV_FILE_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Sıfır dahil, ondalıklı. Boş, eksi, NaN ya da sonsuz: varsayılan (sıfıra düşmez). */
function envNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Sıfırdan büyük, ondalıklı. Boş, sıfır, eksi, NaN ya da sonsuz: varsayılan. */
function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Açma/kapama anahtarı. Tanınmayan değer varsayılandır: yazım hatası bir korumayı sessizce kapatmasın. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === 'false' || raw === 'off' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes') return true;
  return fallback;
}

const PRICE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

/**
 * `AI_PRICE_TABLE` (JSON, model → USD / 1M token) liste fiyatlarının üstüne yazılır. Dört alanı da sonlu ve eksi olmayan
 * sayı olmayan model alınmaz, `invalid`e yazılır (açılışta günlüğe). Bozuk JSON: hiçbir ezme yok, liste fiyatı geçerli.
 */
export function parseAiPriceTable(raw: string | undefined): { table: Record<string, AiPrice>; invalid: string[] } {
  const table: Record<string, AiPrice> = { ...AI_LIST_PRICES_USD };
  const text = raw?.trim();
  if (!text) return { table, invalid: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { table, invalid: ['AI_PRICE_TABLE (JSON)'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { table, invalid: ['AI_PRICE_TABLE (JSON)'] };
  const invalid: string[] = [];
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = value as Record<string, unknown> | null;
    const ok = !!model.trim() && !!v && typeof v === 'object' && PRICE_FIELDS.every((f) => typeof v[f] === 'number' && Number.isFinite(v[f]) && (v[f] as number) >= 0);
    if (!ok) {
      invalid.push(model);
      continue;
    }
    table[model.trim()] = { input: v.input as number, output: v.output as number, cacheWrite: v.cacheWrite as number, cacheRead: v.cacheRead as number };
  }
  return { table, invalid };
}

/** Postgres havuzu (eskisi 10). Tek kaynak: `env.dbPoolMax` ve `db.ts` `poolConfig`. */
export const DB_POOL_MAX_DEFAULT = 20;

/**
 * `AI_DAILY_BUDGET_TRY` varsayılanı, TL (kapalı deneme). Fiyat listemizle (Sonnet 5.5, kur 100) 1.000 TL ≈ 10 USD sağlayıcı
 * maliyeti; bir firmanın aylık hakkı (500) + sonuç vermeyen çağrı payı (500) kadar: tek firma ayın tamamını bir günde
 * harcayabilir, iki firma aynı gün harcayamaz.
 */
export const AI_DAILY_BUDGET_DEFAULT_TRY = 1000;

/** `off` (büyük/küçük harf fark etmez): tavan yok. Boş: varsayılan. Düz ondalık sayı (0 dahil): o tutar. Diğerleri geçersiz. */
export function parseAiDailyBudget(raw: string | undefined): { ok: true; value: number | null } | { ok: false } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: AI_DAILY_BUDGET_DEFAULT_TRY };
  if (text.toLowerCase() === 'off') return { ok: true, value: null };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return { ok: false };
  return { ok: true, value: Number(text) };
}

/**
 * Kullanıcının kararındaki kalıcı silme süresi, gün (2026-11-12). Varsayılan DEĞİLDİR: değişken boşsa kalıcı silme kapalıdır;
 * canlıda `purge:preview` ile bakılıp bu değer bilerek yazılır. Kuru çalışma kapalıyken bu süreyle sayar.
 */
export const PURGE_DEFAULT_DAYS = 30;
/** Daha kısa süre yazılsa da en erken bu kadar gün sonra silinir. */
export const PURGE_MIN_DAYS = 7;
/** Kalıcı silme sürelerinin değişkenleri (`services/deletedPurge.ts`). */
export const PURGE_DAYS_VARS = ['DELETED_INVOICE_PURGE_DAYS', 'DELETED_MEASUREMENT_PHOTO_PURGE_DAYS'] as const;

/**
 * Tek kural (ortam ve kuru çalışma komutu): boş, `off`, `false`, `no` ya da yalnız sıfırlardan oluşan sayı (`0`, `00`):
 * kapalı. Tam sayı: o kadar gün; 7'den küçükse 7 (daha erken silmez). Başka her değer bozuktur: açılış durur (`invalidEnv`);
 * süreç içinde bozulursa kalıcı silme kapalı sayılır (silmeme yönü).
 */
export function parsePurgeDays(raw: string | undefined): { ok: boolean; days: number | null } {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text || text === 'off' || text === 'false' || text === 'no' || /^0+$/.test(text)) return { ok: true, days: null };
  if (!/^\d{1,6}$/.test(text)) return { ok: false, days: null };
  return { ok: true, days: Math.max(PURGE_MIN_DAYS, Number(text)) };
}

/**
 * Yapay zekâ geçidinin adresi geçerli mi: yalın http(s) kökeni ya da yol öneki (kullanıcı adı, sorgu, parça yok). Geçit iç ağdadır
 * (`http://ai-api:4300`); düz http serbesttir.
 */
export function isAiGatewayUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
}

/**
 * Yapay zekânın yolu (YAPAY-ZEKA-GECIDI §6):
 * - `gateway`: `AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN` dolu; SDK geçide gider, anahtar yerine aracın geçit jetonu.
 * - `direct`: geçit yok, `ANTHROPIC_API_KEY` dolu ve `SOD_ENV` üretim değil (yerel geliştirme; bugünkü yol).
 * - `off`: ikisi de yok, ya da üretimde geçit yok (üretimde anahtar ortamda durmaz), ya da geçit adresi var ama jeton yok
 *   (açılış bunu zaten durdurur, `invalidEnv`; süreç içinde bozulursa doğrudan yola düşülmez).
 */
export type AiMode = 'gateway' | 'direct' | 'off';

export function aiModeOf(source: NodeJS.ProcessEnv): AiMode {
  if ((source.AI_GATEWAY_URL ?? '').trim()) return (source.AI_GATEWAY_TOKEN ?? '').trim() ? 'gateway' : 'off';
  if (source.SOD_ENV?.trim() === 'production') return 'off';
  return (source.ANTHROPIC_API_KEY ?? '').trim() ? 'direct' : 'off';
}

/** Her ortamda açılışı durduran bozuk ayarlar (üretimde eksik ayarlar ayrıca `missingProductionEnv`). */
export function invalidEnv(source: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (!parseAiDailyBudget(source.AI_DAILY_BUDGET_TRY).ok) out.push('AI_DAILY_BUDGET_TRY (a TRY amount such as 1000 or 250.50, or off)');
  for (const k of PURGE_DAYS_VARS) if (!parsePurgeDays(source[k]).ok) out.push(`${k} (a whole number of days, at least 7, or off)`);
  const gatewayUrl = (source.AI_GATEWAY_URL ?? '').trim();
  if (gatewayUrl && !isAiGatewayUrl(gatewayUrl)) out.push('AI_GATEWAY_URL (the AI gateway address, e.g. http://ai-api:4300)');
  if (gatewayUrl && !(source.AI_GATEWAY_TOKEN ?? '').trim()) out.push('AI_GATEWAY_TOKEN (required when AI_GATEWAY_URL is set)');
  // Üretimde sağlayıcı anahtarı ortamda durmaz: anahtar geçitte (TagPress'in kuralıyla aynı, SOD_ENV=production).
  if (source.SOD_ENV?.trim() === 'production' && (source.ANTHROPIC_API_KEY ?? '').trim()) {
    out.push('ANTHROPIC_API_KEY (must be empty in production: the key lives in the AI gateway; set AI_GATEWAY_URL and AI_GATEWAY_TOKEN)');
  }
  return out;
}

let warnedMobileVersion = false;

export const env = {
  /**
   * En düşük desteklenen mobil sürüm (katı x.y.z, `strictVersion`; hesap servisiyle aynı kural). Boş ya da bozuk: denetim yok.
   * Üretimde bozuk değer açılışı durdurur (`missingProductionEnv`); geliştirmede bir kez uyarılır.
   */
  get minMobileVersion() {
    const raw = process.env.MIN_MOBILE_VERSION?.trim();
    const v = strictVersion(raw);
    if (raw && !v && !warnedMobileVersion) {
      warnedMobileVersion = true;
      console.warn('[uyarı] MIN_MOBILE_VERSION geçersiz: x.y.z biçiminde olmalı (ör. 1.1.0); yok sayılacak.');
    }
    return v;
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
  get databaseUrl() {
    return process.env.DATABASE_URL ?? 'postgresql://sod_deciship:sod_deciship_dev@localhost:5434/sellerondata';
  },
  /** Hesap'ın açık anahtarları, iç adresle (ARCHITECTURE §5). */
  get accountJwksUrl() {
    return process.env.ACCOUNT_JWKS_URL?.trim() || DEV_JWKS_URL;
  },
  /** Çerezli yazmada ve CORS'ta kabul edilen kökenler. */
  get allowedOrigins(): string[] {
    const origins = list(process.env.ALLOWED_ORIGINS);
    if (origins.length) return origins;
    return process.env.NODE_ENV === 'production' ? [] : DEV_ORIGINS;
  },
  /**
   * Uygulamanın dış adresi (`https://app.sellerondata.com`): üretimde dosya bağlantıları bununla kurulur, istek başlığıyla
   * değil (`publicBase`). Üretimde zorunlu (`missingProductionEnv`); geliştirmede boş, adres istekten kurulur.
   */
  get appBaseUrl(): string {
    return (process.env.APP_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
  },
  /** İmzalı dosya bağlantısı anahtarı. Kullanıcı jetonuyla ilgisi yoktur. */
  get fileTokenSecret() {
    return process.env.FILE_TOKEN_SECRET?.trim() || DEV_FILE_TOKEN_SECRET;
  },
  /** Önümüzdeki vekil sayısı (gateway). Sıfırsa X-Forwarded-For okunmaz. */
  get trustProxyHops() {
    const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
    return Number.isInteger(hops) && hops > 0 ? hops : 0;
  },
  /** ARCHITECTURE §11: sıfırlama ucu yalnız açıkça istenirse vardır. */
  /** Firma başına aynı anda çalışan pahalı istek (Merkez, Pano, satır listesi, rapor). Aşılırsa 429: tek firma havuzu doldurup diğerlerini bekletemez. */
  get hubConcurrencyPerOrg() {
    return envPositiveInt('HUB_CONCURRENCY_PER_ORG', 6);
  },
  /** Firma başına aynı anda çalışan liste isteği (ölçüm, fatura). Geniş: olağan kullanımı değil, kaçağı keser. */
  get readConcurrencyPerOrg() {
    return envPositiveInt('READ_CONCURRENCY_PER_ORG', 20);
  },
  /** Firma başına aynı anda çalışan dışa aktarma akışı. Ayrı sayılır: uzun akış ekranları bekletmez. */
  get hubExportConcurrencyPerOrg() {
    return envPositiveInt('HUB_EXPORT_CONCURRENCY_PER_ORG', 2);
  },
  /** Okumayan istemci: akış bu süre ilerlemezse kesilir, yuva döner. */
  get hubExportIdleMs() {
    return envPositiveInt('HUB_EXPORT_IDLE_MS', 120_000);
  },
  get hubExportMaxMs() {
    return envPositiveInt('HUB_EXPORT_MAX_MS', 30 * 60_000);
  },
  /** Koruyucu üst süre: işleyici ya da yanıt hiç bitmezse firma kilitli kalmasın. */
  get hubSlotMaxMs() {
    return envPositiveInt('HUB_SLOT_MAX_MS', 5 * 60_000);
  },
  // ---------- Mesaj 6: yapay zekâ kotası, dosya işleme, hız sınırı (her okumada process.env; testler değiştirebilir) ----------
  /** false: kota sayılır ve gösterilir ama durdurmaz (geri dönüş anahtarı). */
  get aiQuotaEnforced() {
    return envFlag('AI_QUOTA_ENFORCED', true);
  },
  /**
   * Plan limitinde `aiCreditMonthly` yoksa aylık ücretsiz hak, TL. 0 = ücretsiz hak yok. Varsayılan 2.500 TL (KALANLAR 1.10):
   * PDF sayfası kabaca 8 TL, 100 sayfalık bir fatura PDF'i ~800 TL; ayda birkaç büyük PDF yarıda kalmasın. Değeri sahip
   * belirler (KALANLAR "Yayından önce" 3).
   */
  get aiFreeCreditMonthlyTry() {
    return envNonNegativeNumber('AI_FREE_CREDIT_MONTHLY_TRY', 2500);
  },
  /** 1 USD sağlayıcı maliyeti = bizde kaç TL. */
  get aiPriceTryPerUsd() {
    return envPositiveNumber('AI_PRICE_TRY_PER_USD', 100);
  },
  /** Etkin fiyat tablosu (USD / 1M token): liste fiyatı + `AI_PRICE_TABLE` ezmeleri. Bozuk ezme alınmaz (`parseAiPriceTable`). */
  get aiPriceTable(): Record<string, AiPrice> {
    return parseAiPriceTable(process.env.AI_PRICE_TABLE).table;
  },
  get aiCacheTtlDays() {
    return envPositiveInt('AI_CACHE_TTL_DAYS', 30);
  },
  get aiConcurrencyPerOrg() {
    return envPositiveInt('AI_CONCURRENCY_PER_ORG', 2);
  },
  /**
   * Sonuç vermeyen çağrıların (FAILED) aylık tavanı, firmanın aylık hakkına oranla (1 = hak kadar). Kotadan düşmezler ama
   * tavan dolunca yeni çağrı durur. 0: ilk başarısız çağrıdan sonra durur. Bozuk ya da eksi değer varsayılana (1) düşer.
   */
  get aiFailedBudgetRatio() {
    return envNonNegativeNumber('AI_FAILED_BUDGET_RATIO', 1);
  },
  /**
   * Sistemin günlük yapay zekâ tavanı, TL (bütün firmaların toplamı; `services/aiDailyBudget.ts`). `null` = `off` (tavan yok).
   * Boş: varsayılan. `0`: yeni sağlayıcı çağrısı hiç yapılmaz. Bozuk değer açılışı durdurur (`invalidEnv`); süreç içinde
   * bozulursa varsayılan geçer (hiçbir zaman sınırsız değil).
   */
  get aiDailyBudgetTry(): number | null {
    const r = parseAiDailyBudget(process.env.AI_DAILY_BUDGET_TRY);
    return r.ok ? r.value : AI_DAILY_BUDGET_DEFAULT_TRY;
  },
  /** Kişi başı dakika sınırları: tartı okuma, PDF (fatura ve tarife), diğer yapay zekâ işlemleri. */
  get aiRateScalePerMin() {
    return envPositiveInt('AI_RATE_SCALE_PER_MIN', 30);
  },
  get aiRatePdfPerMin() {
    return envPositiveInt('AI_RATE_PDF_PER_MIN', 6);
  },
  get aiRateOtherPerMin() {
    return envPositiveInt('AI_RATE_OTHER_PER_MIN', 10);
  },
  /**
   * `process` (varsayılan): dosya ayrı çocuk süreçlerde okunur (Y151). `inline`: ana süreçte (eski davranış, geri dönüş;
   * testte varsayılan). Eski `thread` değeri ve tanınmayan değer `process` sayılır.
   */
  get fileWorkerMode(): 'process' | 'inline' {
    return process.env.FILE_WORKER_MODE?.trim().toLowerCase() === 'inline' ? 'inline' : 'process';
  },
  /** Dosya çalışanı (çocuk süreç) sayısı. */
  get fileWorkers() {
    return envPositiveInt('FILE_WORKERS', 2);
  },
  /** Çocuk sürecin JS yığını, MB (`--max-old-space-size`). */
  get fileWorkerHeapMb() {
    return envPositiveInt('FILE_WORKER_HEAP_MB', 512);
  },
  get fileWorkerTimeoutMs() {
    return envPositiveInt('FILE_WORKER_TIMEOUT_MS', 60_000);
  },
  /**
   * Fatura raporunu (PDF, Excel) üreten çocuğun JS yığını, MB (yeni denetim Mesaj 6, 19-B1). Varsayılan 1024: rapor eskiden
   * API sürecinde (`--max-old-space-size=1024`) üretiliyordu; o yığına sığan rapor çocukta da sığar. 20.000 fark satırlı PDF
   * yaklaşık 800 MB tutar.
   */
  get reportWorkerHeapMb() {
    return envPositiveInt('REPORT_WORKER_HEAP_MB', 1024);
  },
  /** Rapor üretiminin süre sınırı, ms (çocuğun açılışı dahil); aşılırsa 422 REPORT_TOO_LARGE. */
  get reportWorkerTimeoutMs() {
    return envPositiveInt('REPORT_WORKER_TIMEOUT_MS', 180_000);
  },
  /**
   * PDF raporunun fark tablosunda en çok bu kadar satır (karar 2026-11-12): aşan faturada PDF en büyük farklı satırları
   * gösterir, tamamı Excel'de; özet ve toplamlar yine bütün faturadır. Varsayılan 1000.
   */
  get reportPdfMaxRows() {
    return envPositiveInt('REPORT_PDF_MAX_ROWS', 1000);
  },
  /**
   * Fatura önizlemesinin okunmuş tablolarının API belleğindeki toplam tahmini boyutu, MB (06-B1, 19-B7). Aşılınca en uzun
   * süredir kullanılmayan tablo bırakılır; tek başına bu sınırı aşan tablo hiç tutulmaz (her doğrulamada dosyadan yeniden
   * okunur). `0`: önbellek kapalı.
   */
  get invoiceTableCacheMb() {
    return envNonNegativeNumber('INVOICE_TABLE_CACHE_MB', 150);
  },
  /** Önizleme tablosu bu süre kullanılmazsa önbellekten düşer, ms. */
  get invoiceTableCacheTtlMs() {
    return envPositiveInt('INVOICE_TABLE_CACHE_TTL_MS', 15 * 60_000);
  },
  /** Bekleyen dosya işi; aşılırsa 503 FILE_BUSY. */
  get fileQueueMax() {
    return envPositiveInt('FILE_QUEUE_MAX', 16);
  },
  /** Bir dosya işinin kuyrukta (worker'a verilmeden) bekleyebileceği en uzun süre, ms; aşılırsa 503 FILE_BUSY. */
  get fileQueueWaitMs() {
    return envPositiveInt('FILE_QUEUE_WAIT_MS', 60_000);
  },
  /** Fatura ya da tarife tablosunun satır sınırı. */
  get fileMaxRows() {
    return envPositiveInt('FILE_MAX_ROWS', 200_000);
  },
  /** XLSX zip içi açılmış toplam boyut, MB. */
  get xlsxMaxUncompressedMb() {
    return envPositiveInt('XLSX_MAX_UNCOMPRESSED_MB', 200);
  },
  get pdfMaxPages() {
    return envPositiveInt('PDF_MAX_PAGES', 300);
  },
  /** PDF içindeki sıkıştırılmış (FlateDecode) akışların açılmış toplamı, MB; pdfjs'e vermeden önce sayılır (413). */
  get pdfMaxUncompressedMb() {
    return envPositiveInt('PDF_MAX_UNCOMPRESSED_MB', 300);
  },
  /**
   * Dosya işi sürerken bellek bekçisinin sınırı, MB: API sürecinin RSS'i + çocukların açılıştan beri büyümesi
   * (`--max-old-space-size` yığın dışı belleği saymaz). Aşılınca en çok büyüyen çocuk sonlandırılır, istek 422
   * `FILE_TOO_COMPLEX` alır. Kap sınırının (2 GB) altında tutulur.
   */
  get fileWorkerRssLimitMb() {
    return envPositiveInt('FILE_WORKER_RSS_LIMIT_MB', 1200);
  },
  /** API hız sınırı ve ağır yazma eşzamanlılığı (`lib/rateLimit.ts`); yalnız açıkça `off` (ya da false/0/no) kapatır. */
  get apiRateLimitEnabled() {
    return envFlag('API_RATE_LIMIT', true);
  },
  get rateUploadPerMinMember() {
    return envPositiveInt('RATE_UPLOAD_PER_MIN_MEMBER', 60);
  },
  get rateUploadPerMinOrg() {
    return envPositiveInt('RATE_UPLOAD_PER_MIN_ORG', 300);
  },
  get rateWritePerMinMember() {
    return envPositiveInt('RATE_WRITE_PER_MIN_MEMBER', 300);
  },
  /** Canlı ölçümün tartı ve işaret okuması (`/vision/scale`, `/vision/reference/detect`): çevrimdışı kuyruğun `upload` kovasından ayrı. */
  get rateVisionPerMinMember() {
    return envPositiveInt('RATE_VISION_PER_MIN_MEMBER', 60);
  },
  /** Aynı okumanın firma başına üst sınırı (Y56): çok çalışanlı firma görüntü servisini tek başına meşgul etmesin. */
  get rateVisionPerMinOrg() {
    return envPositiveInt('RATE_VISION_PER_MIN_ORG', 240);
  },
  /** Ağır yazma (içe aktarma, örnek veri, toplu yeniden hesap), süreç geneli; firma başına 1; dolu → 503 FILE_BUSY. */
  get importConcurrency() {
    return envPositiveInt('IMPORT_CONCURRENCY', 3);
  },
  /**
   * 19-B8: ağır yazma yuvaları doluyken (başka firmalar) istek hemen reddedilmez, en çok bu kadar sırada bekler, ms;
   * süre dolarsa 503 FILE_BUSY. `0`: beklemeden 503 (eski davranış). Firmanın kendi ağır işi sürüyorsa yine hemen 503.
   */
  get heavyQueueWaitMs() {
    return envNonNegativeNumber('HEAVY_QUEUE_WAIT_MS', 30_000);
  },
  /** Havuz boyutu. `db.ts` `poolConfig` aynı varsayılanı (`DB_POOL_MAX_DEFAULT`) kullanır. */
  get dbPoolMax() {
    return envPositiveInt('DB_POOL_MAX', DB_POOL_MAX_DEFAULT);
  },
  /** Merkez, Pano ve rapor isteklerinin aynı anda çalıştırabileceği tekil sorgu (süreç geneli; db.ts withDbLane). */
  get hubDbSlots() {
    return envPositiveInt('HUB_DB_SLOTS', 8);
  },
  // ---------- Mesaj 7: arka plan iş kuyruğu ve dosyalar (her okumada process.env; testler değiştirebilir) ----------
  /**
   * `on`: bu süreç kuyruktan iş alır (varsayılan). `off`: almaz, yalnız kuyruğa yazar (ayrı çalışan kabı için).
   * `inline`: işi başlatan istek onu sonuna kadar çalıştırır (testlerin varsayılanı, vitest.config.ts). Tanınmayan değer `on`.
   */
  get jobRunner(): 'on' | 'off' | 'inline' {
    const raw = process.env.JOB_RUNNER?.trim().toLowerCase();
    return raw === 'off' || raw === 'inline' ? raw : 'on';
  },
  /** Sunucu başına aynı anda çalışan yapay zekâ işi (PDF fatura, tarife PDF tarama ve okuma). */
  get jobSlotsAi() {
    return envPositiveInt('JOB_SLOTS_AI', 2);
  },
  /** Sunucu başına aynı anda çalışan toplu yeniden hesap işi (önizleme ve uygulama). */
  get jobSlotsRecalc() {
    return envPositiveInt('JOB_SLOTS_RECALC', 1);
  },
  /** Ölçüm kaydından sonraki fatura karşılaştırması: süreç içi sıranın aynı anda çalışan sayısı (iş tablosuna girmez). */
  get measureRecompareSlots() {
    return envPositiveInt('MEASURE_RECOMPARE_SLOTS', 2);
  },
  /** Kuyruk boşken yoklama aralığı, ms. Aynı süreçte eklenen iş döngüyü beklemeden uyandırır. */
  get jobPollMs() {
    return envPositiveInt('JOB_POLL_MS', 2000);
  },
  /** İşin kirası, ms; kalp atışı bunun dörtte birinde bir. Kira dolan işi başka çalıştırıcı devralır. */
  get jobLeaseMs() {
    return envPositiveInt('JOB_LEASE_MS', 60_000);
  },
  /** Yeni işin deneme hakkı (her sahiplenme bir deneme). Biterse iş FAILED, JOB_ABANDONED. */
  get jobMaxAttempts() {
    return envPositiveInt('JOB_MAX_ATTEMPTS', 5);
  },
  /** Kapanışta süren işlere tanınan süre, ms; bitmeyenlerin kirası bırakılır (compose stop_grace_period bundan uzun). */
  get jobShutdownGraceMs() {
    return envPositiveInt('JOB_SHUTDOWN_GRACE_MS', 30_000);
  },
  /** (Ek E1) PDF fatura bu sayıdan çok sayfalıysa sayfa gruplarıyla okunur; grup başına sayfa. */
  get pdfInvoicePagesPerCall() {
    return envPositiveInt('PDF_INVOICE_PAGES_PER_CALL', 5);
  },
  /**
   * KALANLAR 6.18: CSV/Excel faturanın veri satırı bundan çoksa içe aktarma arka plan işidir (`INVOICE_IMPORT`, 202);
   * eşik ve altı istek içinde (201). PDF fatura en çok 5.000 satırdır, hep istek içinde.
   */
  get invoiceImportQueueRows() {
    return envPositiveInt('INVOICE_IMPORT_QUEUE_ROWS', 5000);
  },
  /** (Ek E4) Firma başına dosya alanı, GB; yalnız fatura ve tarife dosyası yüklemelerinde. 0 = kapalı. */
  get storageQuotaGbPerOrg() {
    return envNonNegativeNumber('STORAGE_QUOTA_GB_PER_ORG', 10);
  },
  /**
   * Silinen fatura (satırları ve kaynak dosyasıyla) silinmesinden bu kadar gün sonra kalıcı silinir; `null` = kapalı
   * (varsayılan: boş). Kural `services/deletedPurge.ts`; değer `parsePurgeDays` (en az 7).
   */
  get deletedInvoicePurgeDays(): number | null {
    return parsePurgeDays(process.env.DELETED_INVOICE_PURGE_DAYS).days;
  },
  /** Silinen ölçümün (ve eski sürümlerin) fotoğrafları bu kadar gün sonra kalıcı silinir; ölçüm kaydı kalır. `null` = `off`. */
  get deletedMeasurementPhotoPurgeDays(): number | null {
    return parsePurgeDays(process.env.DELETED_MEASUREMENT_PHOTO_PURGE_DAYS).days;
  },
  get dataResetEnabled() {
    return process.env.ENABLE_DATA_RESET === 'true';
  },
  // ---------- Mesaj 14: itiraz süresi hatırlatması ve örnek veriyle deneme turu (her okumada process.env) ----------
  /** Hesap servisinin ürün bildirimi ucu (`POST /api/account/internal/notify`). Boşsa hatırlatma kapalıdır. */
  get notifyUrl() {
    return (process.env.ACCOUNT_NOTIFY_URL ?? '').trim();
  },
  /** Bildirim ucuna giden ortak anahtar (`Authorization: Bearer`). Hesap servisindeki `PRODUCT_NOTIFY_SECRETS` haritasındaki değerle aynı. */
  get notifySecret() {
    return (process.env.PRODUCT_NOTIFY_SECRET ?? '').trim();
  },
  /** `DEMO_TOUR=off`: örnek veriyle deneme turu kapalı (uçlar 404). Tanınmayan değer açıktır. */
  get demoTourEnabled() {
    return envFlag('DEMO_TOUR', true);
  },
  /** Yalnız `direct` yolunda kullanılır (`aiMode`); geçit yolunda okunmaz. */
  get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY ?? '').trim();
  },
  /** Yapay zekâ geçidinin iç adresi (`http://ai-api:4300`), sondaki `/` atılmış; boşsa geçit yok. */
  get aiGatewayUrl() {
    return (process.env.AI_GATEWAY_URL ?? '').trim().replace(/\/+$/, '');
  },
  /** Aracın geçit jetonu (geçidin `AI_GATEWAY_TOKENS` içindeki `deciship=` değeri); SDK anahtar başlığında gider. */
  get aiGatewayToken() {
    return (process.env.AI_GATEWAY_TOKEN ?? '').trim();
  },
  /** Yapay zekânın yolu: `gateway`, `direct` ya da `off` (`aiModeOf`). */
  get aiMode(): AiMode {
    return aiModeOf(process.env);
  },
  get claudeModel() {
    return process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5-5';
  },
  get visionUrl() {
    return (process.env.VISION_URL ?? 'http://localhost:8001').replace(/\/$/, '');
  },
  get storageDir() {
    return resolveStorage(process.env.STORAGE_DIR ?? './storage');
  },
  get port() {
    return Number(process.env.PORT ?? 4000);
  },
  get host() {
    return process.env.HOST ?? '::';
  },
};

/**
 * Yalın köken (yol, sorgu, kullanıcı adı yok), https. Yerel üretim sınaması için localhost'ta http serbest (Hesap servisinin
 * `APP_BASE_URL` kuralıyla aynı).
 */
function isPublicBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return false;
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
}

/** Üretimde varsayılana düşmesi güvenli olmayan ayarlar. Eksikse servis başlamaz. */
export function missingProductionEnv(source: NodeJS.ProcessEnv = process.env): string[] {
  if (source.NODE_ENV !== 'production') return [];
  const missing = ['DATABASE_URL', 'ACCOUNT_JWKS_URL', 'ALLOWED_ORIGINS', 'FILE_TOKEN_SECRET', 'APP_BASE_URL'].filter((k) => !source[k]?.trim());
  // Dosya bağlantısının kökü: telefon düz HTTP'yi açmaz, yol taşıyan adres bağlantıyı bozar.
  if (source.APP_BASE_URL?.trim() && !isPublicBaseUrl(source.APP_BASE_URL.trim())) {
    missing.push('APP_BASE_URL (must be a bare https:// origin, e.g. https://app.sellerondata.com)');
  }
  // Geliştirme parolasıyla üretim açılmaz.
  if (source.DATABASE_URL && hasDevPassword(source.DATABASE_URL)) missing.push('DATABASE_URL (geliştirme parolası)');
  // Firma verisini silen uç üretimde açılamaz.
  if (source.ENABLE_DATA_RESET === 'true') missing.push('ENABLE_DATA_RESET (üretimde kapalı olmalı)');
  // Bozuk sürüm ayarı sessizce "denetim yok"a düşmesin (hesap servisi `assertMobileVersions` ile aynı).
  if (source.MIN_MOBILE_VERSION?.trim() && !strictVersion(source.MIN_MOBILE_VERSION)) missing.push('MIN_MOBILE_VERSION (x.y.z olmalı)');
  // Satır içi iş kipi yalnız testler içindir: üretimde istek işi sonuna kadar bekler, geçici hatayla dönen iş hiç alınmaz.
  if (source.JOB_RUNNER?.trim().toLowerCase() === 'inline') missing.push('JOB_RUNNER (inline üretimde kapalı olmalı)');
  // Bildirim adresi doluysa anahtar sözleşmedeki kurala uymalı (`isValidNotifySecret`, Hesap servisiyle aynı): 32..512 görünür
  // ASCII, geliştirme anahtarı değil. Zayıf ya da başlıkta bozulan anahtarla hatırlatma Hesap servisine gitmesin.
  if (source.ACCOUNT_NOTIFY_URL?.trim() && !isValidNotifySecret(source.PRODUCT_NOTIFY_SECRET?.trim() ?? '')) {
    missing.push('PRODUCT_NOTIFY_SECRET (32-512 visible ASCII characters, not the development key, when ACCOUNT_NOTIFY_URL is set)');
  }
  return missing;
}
