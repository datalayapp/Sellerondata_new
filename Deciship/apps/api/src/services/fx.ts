import fs from 'node:fs/promises';
import path from 'node:path';
import type { FxRate } from '@deciship/core';
import { env } from '../env.ts';

/**
 * Döviz kurları — kaynak: TCMB günlük kur bülteni (https://www.tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml).
 *
 * Kur seçimi: ForexBuying ile ForexSelling'in ortalaması (döviz alış/satış ortası), `Unit`'e bölünerek
 * 1 birim yabancı para = x TRY. Taşıyıcılar (FedEx: OANDA) orta kura yakın bir kur kullanır; alış ya da satış
 * kurunu seçmek her satırda sistematik ±%0,1–0,2 sapma yaratırdı, ortalama bunu en aza indirir. Kalan kaynak farkı
 * şirket ayarındaki kur toleransı (`fxTolerancePct`, varsayılan %1,5) ile tolere edilir.
 *
 * Gün seçimi: istenen günün bülteni; yoksa (hafta sonu, tatil, bugün 15:30 öncesi) en çok 10 gün geriye gidilir (9 günlük bayram tatili dahil).
 * Bugün için `today.xml` okunur. Çapraz kurlar (EUR→USD) TRY üzerinden hesaplanır.
 *
 * Önbellek: bellek + STORAGE_DIR/fx/ altında günlük JSON (yeniden başlatmada tekrar indirilmez).
 *
 * Ağ (TCMB 5–10 sn, bazen daha yavaş yanıt verir): istek başına zaman aşımı FX_TIMEOUT_MS (varsayılan 30 sn); zaman
 * aşımı/ağ hatası/5xx'te en çok 3 deneme, aralarda kısa bekleme (1 sn, 3 sn).
 * - `prefetch` (fatura yükleme / Yeniden karşılaştır): günler sırayla indirilir; devre kesiciye bakılmaz ve prefetch
 *   içinde açılmaz, yani bir günün yavaşlığı diğer günleri "bulunamadı" yapmaz. Yalnız arka arkaya 2 gün 3 denemenin
 *   hepsinde düşerse (TCMB kapalı) kalan günler yalnız önbellekten okunur. Kur alınamayan satırlar "Kur bulunamadı" olur;
 *   fatura düzeyinde `totals.fxMissing` ile "Yeniden karşılaştır" uyarısı gösterilir.
 * - Süre üst sınırı (FX_PREFETCH_BUDGET_MS, varsayılan 45 sn): TCMB istek başına yaklaşık 5,5 sn yanıt verir, arada TLS
 *   el sıkışması 10 sn'de kopar ve 3 deneme 34 sn eder. Günler sırayla indiği için bekleme, kullanıcıya bağlı HTTP isteğinde
 *   gün sayısıyla büyüyordu. Sınır dolunca istek beklemez: kalan günler önbellekten okunur, gelmeyenler arka planda iner,
 *   "Yeniden karşılaştır" önbellekten tamamlar. Beklerken veritabanı bağlantısı ve işlem tutulmaz.
 * - `patient: false` (ölçüm değişince arka planda yeniden karşılaştırma): devre kesici kullanılır; arka arkaya 2 başarısız
 *   denemeden sonra 60 sn TCMB'ye gidilmez, böylece ölçüm kaydı TCMB kapalıyken uzun beklemez.
 * - Saklı kur (Y18): `prefetch`te kur ağ hatası ya da süre sınırı yüzünden alınamazsa, aynı çift için önbellekte (bellek +
 *   STORAGE_DIR/fx) saklı en yakın önceki günün bülteni kullanılır; anahtar `failed`'e girmez. Arada atlanan her gün
 *   önbellekte "bülten yok" işaretliyse ya da Cumartesi/Pazar ise bu, taze yolun da bulacağı kurdur: bayat DEĞİLDİR (pencere
 *   taze yolla aynı, MAX_BACK_DAYS). Bülteni bilinmeyen bir iş günü atlandıysa kur bayattır (`stale: true`), en çok
 *   STALE_MAX_DAYS (7) gün geriye. Saklı kur da yoksa anahtar `failed`'de kalır (satır "Kur alınamadı"). Sabit yedek oran yok.
 * - Alınamayan (ağ hatası, süre sınırı, TCMB kapalı) her gün arka planda yeniden indirilir: süre sınırına takılan hemen,
 *   ağ hatası alan RETRY_AFTER_MS (60 sn, devre kesiciyle aynı) sonra; "Yeniden karşılaştır" önbellekten tamamlar.
 */

export const FX_SOURCE = 'TCMB';
const TCMB_BASE = 'https://www.tcmb.gov.tr/kurlar';
const MAX_BACK_DAYS = 10;
const OFFLINE_MS = 60_000;
/** Devre kesicinin açılması için gereken arka arkaya başarısız deneme sayısı. */
const FAILURES_TO_OPEN = 2;
const DEFAULT_TIMEOUT_MS = Number(process.env.FX_TIMEOUT_MS) > 0 ? Number(process.env.FX_TIMEOUT_MS) : 30_000;
/** Bir isteğin en çok deneme sayısı ve denemeler arası bekleme (ms). */
const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1_000, 3_000];
/** prefetch: arka arkaya bu kadar gün tamamen düşerse kalan günler yalnız önbellekten okunur (TCMB kapalı). */
const DAYS_FAILED_TO_STOP = 2;
const DEFAULT_PREFETCH_BUDGET_MS = Number(process.env.FX_PREFETCH_BUDGET_MS) > 0 ? Number(process.env.FX_PREFETCH_BUDGET_MS) : 45_000;
/** Y18: kur alınamayınca saklı bülten en çok bu kadar gün geriden alınır (karar: 7 gün). */
export const STALE_MAX_DAYS = 7;
/** Ağ hatası alan günün arka planda yeniden indirilmesinden önceki bekleme (ms; devre kesici süresi). */
const RETRY_AFTER_MS = OFFLINE_MS;

/** patient: devre kesiciye bakma/açma (fatura yükleme, Yeniden karşılaştır). offline: ağa hiç gitme (yalnız önbellek). */
type NetMode = { patient: boolean; offline?: boolean };

export type FxFetchResult = { status: number; text: string };
/** Test ve özel kurulumlar için değiştirilebilir indirici. */
export type FxFetcher = (url: string, signal: AbortSignal) => Promise<FxFetchResult>;

/** Bir bültenin TRY karşılıkları: kod → 1 birim için TRY (orta kur). */
export type Bulletin = { date: string; rates: Record<string, number> };

type Stored = Bulletin | { date: string; missing: true };

const defaultFetcher: FxFetcher = async (url, signal) => {
  const res = await fetch(url, { signal, headers: { 'user-agent': 'DeciShip/1.0 (+fx)' } });
  return { status: res.status, text: res.status === 200 ? await res.text() : '' };
};

export function istanbulToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Cumartesi ya da Pazar (TCMB bülten yayımlamaz). */
function isWeekend(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function tcmbUrl(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${TCMB_BASE}/${y}${m}/${d}${m}${y}.xml`;
}

const num = (s: string | undefined) => {
  const v = s ? Number(s.trim().replace(',', '.')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** TCMB XML → bülten. ForexBuying/ForexSelling ortalaması / Unit; biri yoksa olan kullanılır. */
export function parseTcmbXml(xml: string): Bulletin | null {
  const tarih = /<Tarih_Date[^>]*\bTarih="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (!tarih) return null;
  const date = `${tarih[3]}-${tarih[2]}-${tarih[1]}`;
  const rates: Record<string, number> = {};
  const re = /<Currency\b[^>]*\bCurrencyCode="([A-Z]{3})"[^>]*>([\s\S]*?)<\/Currency>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const body = m[2]!;
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1];
    const unit = num(tag('Unit')) ?? 1;
    const buy = num(tag('ForexBuying'));
    const sell = num(tag('ForexSelling'));
    const mid = buy != null && sell != null ? (buy + sell) / 2 : (buy ?? sell);
    if (mid != null) rates[m[1]!] = mid / unit;
  }
  return Object.keys(rates).length ? { date, rates } : null;
}

/** Bültenden 1 `b` = ? `q` (TRY üzerinden); para birimi bültende yoksa null. */
function rateFromBulletin(bulletin: Bulletin, b: string, q: string): FxRate | null {
  const tryOf = (c: string) => (c === 'TRY' ? 1 : (bulletin.rates[c] ?? null));
  const rb = tryOf(b);
  const rq = tryOf(q);
  if (rb == null || rq == null) return null;
  const raw = rb / rq;
  // TCMB 4 ondalık yayımlar; TRY karşılığı 4, çapraz kur 6 ondalık
  const rate = q === 'TRY' ? Math.round(raw * 1e4) / 1e4 : Math.round(raw * 1e6) / 1e6;
  return { base: b, quote: q, rate, date: bulletin.date, source: FX_SOURCE };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Toplam süre bütçesi: tek zamanlayıcı. Dolunca `expired` true olur ve `late` çözülür. "Süre doldu mu" ile "beklemeyi
 * kes" aynı saatten okunur: `Date.now()` ile hesaplanan kalan süre, zamanlayıcının saatiyle (tekdüze, ms'ye yuvarlı) 1 ms
 * kayabildiğinden zamanlayıcı çaldıktan sonra bir istek daha çıkabiliyordu (Linux'ta zamanlayıcılar tam vaktinde çalar).
 * Süren indirme iptal edilmez: bitince önbelleğe yazılır.
 */
function startBudget(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const budget = { expired: ms <= 0, late: Promise.resolve<'late'>('late'), clear: () => clearTimeout(timer) };
  if (!budget.expired) {
    budget.late = new Promise<'late'>((r) => {
      timer = setTimeout(() => {
        budget.expired = true;
        r('late');
      }, ms);
    });
  }
  return budget;
}

export class FxService {
  private fetcher: FxFetcher;
  private cacheDir: string | null;
  private timeoutMs: number;
  private backoffMs: number[];
  private prefetchBudgetMs: number;
  private now: () => Date;
  private retryAfterMs: number;
  /** arka planda yeniden indirilmesi zamanlanmış anahtarlar (aynı gün iki kez zamanlanmaz) */
  private retrying = new Set<string>();
  /** istenen gün → bulunan bülten (ya da null) */
  private resolved = new Map<string, { p: Promise<Bulletin | 'missing' | 'error'>; patient: boolean }>();
  /** bülten günü → içerik / yok */
  private days = new Map<string, Stored>();
  /** devre kesici: bu zamana kadar ağa gidilmez (Date.now ms) */
  private offlineUntil = 0;
  /** arka arkaya başarısız deneme sayısı (başarılı yanıtta sıfırlanır) */
  private failures = 0;

  constructor(
    opts: {
      fetcher?: FxFetcher;
      cacheDir?: string | null;
      timeoutMs?: number;
      backoffMs?: number[];
      now?: () => Date;
      prefetchBudgetMs?: number;
      /** ağ hatası alan günün arka planda yeniden indirilmesinden önceki bekleme (ms); testler kısaltır */
      retryAfterMs?: number;
    } = {},
  ) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.cacheDir = opts.cacheDir === undefined ? path.join(env.storageDir, 'fx') : opts.cacheDir;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.prefetchBudgetMs = opts.prefetchBudgetMs ?? DEFAULT_PREFETCH_BUDGET_MS;
    this.now = opts.now ?? (() => new Date());
    this.retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS;
  }

  private file(iso: string) {
    return this.cacheDir ? path.join(this.cacheDir, `tcmb-${iso}.json`) : null;
  }

  private async readStored(iso: string): Promise<Stored | null> {
    const mem = this.days.get(iso);
    if (mem) return mem;
    const f = this.file(iso);
    if (!f) return null;
    try {
      const s = JSON.parse(await fs.readFile(f, 'utf8')) as Stored;
      this.days.set(iso, s);
      return s;
    } catch {
      return null;
    }
  }

  private async store(iso: string, s: Stored) {
    this.days.set(iso, s);
    const f = this.file(iso);
    if (!f) return;
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(s));
    } catch {
      /* önbellek yazılamazsa yalnız bellekte kalır */
    }
  }

  private fail(mode: NetMode) {
    if (mode.patient) return;
    this.failures++;
    if (this.failures >= FAILURES_TO_OPEN) {
      this.offlineUntil = Date.now() + OFFLINE_MS;
      this.failures = 0;
    }
  }

  /** Tek deneme; zaman aşımı/ağ hatası/5xx → 'error'. */
  private async attempt(url: string, mode: NetMode): Promise<FxFetchResult | 'error'> {
    try {
      const r = await this.fetcher(url, AbortSignal.timeout(this.timeoutMs));
      if (r.status >= 500) {
        this.fail(mode);
        return 'error';
      }
      this.failures = 0;
      this.offlineUntil = 0;
      return r;
    } catch {
      this.fail(mode);
      return 'error';
    }
  }

  /** En çok 3 deneme, aralarda kısa bekleme; sabırsız modda açık devre kesicide ağa gidilmez. */
  private async download(url: string, mode: NetMode): Promise<FxFetchResult | 'error'> {
    if (mode.offline) return 'error';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (!mode.patient && Date.now() < this.offlineUntil) return 'error';
      if (i > 0) await sleep(this.backoffMs[Math.min(i - 1, this.backoffMs.length - 1)] ?? 0);
      const r = await this.attempt(url, mode);
      if (r !== 'error') return r;
    }
    return 'error';
  }

  /** Tek bir günün bülteni: 'missing' = o gün bülten yok (404), 'error' = ağ hatası. */
  private async day(iso: string, today: string, mode: NetMode): Promise<Bulletin | 'missing' | 'error'> {
    const cached = await this.readStored(iso);
    if (cached) return 'missing' in cached ? 'missing' : cached;
    const isToday = iso === today;
    const res = await this.download(isToday ? `${TCMB_BASE}/today.xml` : tcmbUrl(iso), mode);
    if (res === 'error') return 'error';
    if (res.status === 404 || (res.status === 200 && !res.text.includes('<Tarih_Date'))) {
      // bugünün/geleceğin "yok"u kalıcı değil (bülten 15:30'da yayımlanır)
      if (iso < today) await this.store(iso, { date: iso, missing: true });
      return 'missing';
    }
    if (res.status !== 200) return 'error';
    const b = parseTcmbXml(res.text);
    if (!b) return 'error';
    if (isToday && b.date !== iso) {
      // today.xml henüz bugünün değil (dünkü bülten): onu kendi gününe kaydet, bugün "yok"
      if (b.date < iso) await this.store(b.date, b);
      return 'missing';
    }
    await this.store(b.date, b);
    return b;
  }

  /** İstenen gün ya da en çok 10 gün öncesine kadar en yakın bülten; ağ hatasında null. */
  bulletinFor(iso: string, mode: NetMode = { patient: false }): Promise<Bulletin | null> {
    return this.bulletinResult(iso, mode).then((r) => (r === 'error' || r === 'missing' ? null : r));
  }

  /** Bülten; 'missing' = 10 gün içinde bülten yok, 'error' = ağ hatası (sonra tekrar denenebilir). */
  private bulletinResult(iso: string, mode: NetMode): Promise<Bulletin | 'missing' | 'error'> {
    const today = istanbulToday(this.now());
    const start = iso > today ? today : iso;
    // yalnız-önbellek sorguları paylaşılan sonuca yazılmaz
    const shared = mode.offline ? undefined : this.resolved.get(start);
    if (shared) {
      // Sabırsız (arka plan, devre kesicili) bir istek sürerken gelen sabırlı istek (yükleme / Yeniden karşılaştır)
      // onun hızlı "hata"sını devralmasın: hata dönerse kendi denemelerini yapar.
      if (mode.patient && !shared.patient) {
        return shared.p.then((r) => (r === 'error' ? this.bulletinResult(iso, mode) : r));
      }
      return shared.p;
    }
    const p = (async () => {
      for (let i = 0; i <= MAX_BACK_DAYS; i++) {
        const r = await this.day(addDays(start, -i), today, mode);
        if (r !== 'missing') return r;
      }
      return 'missing' as const;
    })();
    if (mode.offline) return p;
    const entry = { p, patient: mode.patient };
    this.resolved.set(start, entry);
    // başarısız/bugünkü sonuçları kalıcı tutma: sonra tekrar denenebilsin
    p.then((b) => {
      if ((b === 'error' || b === 'missing' || start === today) && this.resolved.get(start) === entry) this.resolved.delete(start);
    });
    return p;
  }

  /** 1 `base` = ? `quote`; bulunamazsa null. `date`: ISO (YYYY-MM-DD). */
  async getRate(base: string, quote: string, date: string, mode: NetMode = { patient: false }): Promise<FxRate | null> {
    const r = await this.rateResult(base, quote, date, mode);
    return r === 'error' ? null : r;
  }

  /** getRate gibi; ağ hatasını ('error') "kur yok"tan (null) ayırır. */
  private async rateResult(base: string, quote: string, date: string, mode: NetMode): Promise<FxRate | null | 'error'> {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    const iso = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    if (b === q) return { base: b, quote: q, rate: 1, date: iso, source: FX_SOURCE };
    const res = await this.bulletinResult(iso, mode);
    if (res === 'error') return 'error';
    if (res === 'missing') return null;
    return rateFromBulletin(res, b, q);
  }

  /**
   * Y18: kur alınamadığında (ağ hatası, süre sınırı) önbellekteki en yakın önceki bültenden kur; ağa gidilmez. Taze yolla
   * aynı pencere (MAX_BACK_DAYS) ve aynı kural: ilk bulunan bülten kullanılır, para birimi orada yoksa null. Arada atlanan
   * her gün "bülten yok" işaretliyse ya da hafta sonuysa sonuç taze yolun vereceği kurdur (bayat değil). Bülteni bilinmeyen
   * bir gün atlandıysa kur `stale: true` taşır ve en çok STALE_MAX_DAYS gün geriden alınır. Yoksa null.
   */
  private async storedRate(base: string, quote: string, date: string): Promise<FxRate | null> {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    const iso = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const today = istanbulToday(this.now());
    const start = iso > today ? today : iso;
    let unknown = false;
    for (let i = 0; i <= MAX_BACK_DAYS; i++) {
      if (unknown && i > STALE_MAX_DAYS) return null;
      const day = addDays(start, -i);
      const s = await this.readStored(day);
      if (s && !('missing' in s)) {
        const r = rateFromBulletin(s, b, q);
        return r && unknown ? { ...r, stale: true } : r;
      }
      // "bülten yok" işareti ya da hafta sonu: TCMB o gün yayımlamaz, taze yol da geçer
      if (!s && !isWeekend(day)) unknown = true;
    }
    return null;
  }

  /**
   * Bir faturanın gereken (çift, gün) kurlarını sırayla toplar; anahtar: fxKey. `failed`: ağ hatası yüzünden
   * alınamayan anahtarlar (Yeniden karşılaştır ile tekrar denenebilir). `patient` (varsayılan true): devre kesici
   * kullanılmaz; arka arkaya 2 gün tamamen düşerse kalan günler yalnız önbellekten okunur. Toplam süre üst sınırı
   * dolunca da öyle; TCMB kapalı değilse kalan günler arka planda iner.
   */
  async prefetch(
    reqs: { base: string; quote: string; date: string }[],
    opts: { patient?: boolean } = {},
  ): Promise<{ rates: Map<string, FxRate | null>; failed: string[] }> {
    const mode: NetMode = { patient: opts.patient ?? true };
    const rates = new Map<string, FxRate | null>();
    const failed: string[] = [];
    const unique = [...new Map(reqs.map((r) => [fxKey(r.base, r.quote, r.date), r])).entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const budget = startBudget(this.prefetchBudgetMs);
    const postponed: { base: string; quote: string; date: string }[] = [];
    const retry: { key: string; r: { base: string; quote: string; date: string } }[] = [];
    let daysFailed = 0;
    try {
      for (const [key, r] of unique) {
        const down = daysFailed >= DAYS_FAILED_TO_STOP;
        const net = !down && !budget.expired;
        const work = this.rateResult(r.base, r.quote, r.date, net ? mode : { ...mode, offline: true }).catch(() => 'error' as const);
        const res = net ? await Promise.race([work, budget.late]) : await work;
        if (net && res !== 'late') daysFailed = res === 'error' ? daysFailed + 1 : 0;
        const missed = res === 'error' || res === 'late';
        // Y18: alınamayan kur yerine saklı en yakın önceki günün kuru (en çok 7 gün); o da yoksa "alınamadı"
        const stored = missed ? await this.storedRate(r.base, r.quote, r.date).catch(() => null) : null;
        if (missed && !stored) failed.push(key);
        // süre sınırına takılan (TCMB kapalı değil) gün hemen, ağ hatası alan ya da TCMB kapalıyken atlanan gün bir süre sonra
        if (missed && !down && (res === 'late' || !net)) postponed.push(r);
        else if (missed) retry.push({ key, r });
        rates.set(key, missed ? stored : res);
      }
    } finally {
      budget.clear();
    }
    if (postponed.length && mode.patient) void this.fillCache(postponed);
    this.scheduleRetry(retry);
    return { rates, failed };
  }

  /** Ağ hatası alan günleri `retryAfterMs` sonra arka planda indirir (devre kesicili mod; ilk hatada bırakır). */
  private scheduleRetry(items: { key: string; r: { base: string; quote: string; date: string } }[]) {
    const fresh = items.filter((x) => !this.retrying.has(x.key));
    if (!fresh.length) return;
    for (const x of fresh) this.retrying.add(x.key);
    const timer = setTimeout(() => {
      for (const x of fresh) this.retrying.delete(x.key);
      void this.fillCache(fresh.map((x) => x.r)).catch(() => undefined);
    }, this.retryAfterMs);
    timer.unref?.();
  }

  /** Süre sınırına takılan günleri sırayla önbelleğe indirir; ilk ağ hatasında bırakır (devre kesicili mod). */
  private async fillCache(reqs: { base: string; quote: string; date: string }[]) {
    for (const r of reqs) {
      const res = await this.rateResult(r.base, r.quote, r.date, { patient: false }).catch(() => 'error' as const);
      if (res === 'error') return;
    }
  }
}

export function fxKey(base: string, quote: string, date: string) {
  return `${base.toUpperCase()}>${quote.toUpperCase()}@${date.slice(0, 10)}`;
}

let service: FxService | null = null;
export function fxService(): FxService {
  service ??= new FxService();
  return service;
}
/** Testler için: sahte indiricili servis takmak (null → varsayılana dön). */
export function setFxService(s: FxService | null) {
  service = s;
}
