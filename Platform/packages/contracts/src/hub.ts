import type { ProductKey } from './catalog.ts';

/**
 * Merkez sözleşmesi. Her ürün `/api/<ürün>/platform/*` altında bu şekilleri döner.
 * Etiketler ürün tarafında Accept-Language'a göre yerelleşmiş gelir; Merkez ürüne özel metin bilmez.
 * Para ve sayı biçimlemesi Merkez'dedir: değer ham sayı + `format`.
 */

export type HubValueFormat = 'number' | 'money' | 'percent' | 'duration_days' | 'text' | 'date' | 'datetime';
export type HubTone = 'neutral' | 'good' | 'bad' | 'warning' | 'info';

export type HubValue = {
  /** format: percent ise 0-100 arası: 86.4 = %86,4. */
  value: number | string | null;
  format: HubValueFormat;
  /** format: money için ISO kod. */
  currency?: string;
};

export type HubKpi = HubValue & {
  id: string;
  label: string;
  hint?: string;
  tone?: HubTone;
  /** Önceki dönem. Karşılaştırma açıksa. */
  previous?: number | null;
  /** Artış iyi mi kötü mü (renk için). */
  goodDirection?: 'up' | 'down' | 'none';
  href?: string;
  /** Eklendi (hub-web). Baş KPI'ın (kpis[0]) seyri: dönem ve önceki dönem (`role`). */
  trend?: HubSeries[];
};

export type HubAlert = {
  id: string;
  tone: HubTone;
  title: string;
  body?: string;
  href?: string;
  actionLabel?: string;
  at?: string;
  /** Eklendi (hub-web). Söz konusu tutar. Merkez "Bekleyenler"de sağa hizalar, tutara göre sıralar. */
  amount?: HubValue;
  /** Eklendi (hub-web). Son gün (ISO). Merkez kalan günü rozetle yazar ve sırada öne alır; `body` aynı süreyi tekrar etmemeli. */
  dueAt?: string;
};

/** Eklendi (hub-web). Bir bütünün parçaları: "faturalanan tutar nereye gitti". En çok 6 parça. */
export type HubSplit = {
  title: string;
  total: HubValue;
  /** `note`: eklendi (hub-web). Parçanın ne olduğunu açıklar: "farklı satırların toplam tutarı". */
  parts: { key: string; label: string; value: number; tone: HubTone; href?: string; note?: string }[];
};

/** Eklendi (hub-web). Bir kırılımın başı: etiket + kim + ne kadar. */
export type HubLeader = { id: string; label: string; name: string; value: HubValue; share?: number; href?: string };

/** Eklendi (hub-web). Başlangıç listesinin bir adımı. `href` adımın derin bağlantısı. */
export type HubSetupStep = { id: string; label: string; done: boolean; href: string; required: boolean };

export type HubOverview = {
  product: string;
  from: string;
  to: string;
  /** İlk KPI baş rakamdır: Genel Bakış onu büyük gösterir. Sıra önem sırasıdır. */
  kpis: HubKpi[];
  alerts: HubAlert[];
  /** Eklendi (hub-web). İsteğe bağlı. */
  split?: HubSplit;
  /** Eklendi (hub-web). Kaçağın en büyük kaynakları. `label` grup adıdır ("Taşıyıcı", "Fark türü"); Merkez grup başına ilk 3'ü gösterir. En çok 6 kayıt, baş para biriminde, fiyat izni yoksa yok. */
  leaders?: HubLeader[];
  /** Kurulum tamamlanmadıysa Merkez yönlendirir. `steps`: eklendi (hub-web), Başlangıç listesi. Ekip adımını Merkez ekler. */
  setup?: { completed: boolean; href: string; label: string; steps?: HubSetupStep[] };
  /** Eklendi (hub-web, Y122). Sayılar araçtaki deneme turunun örnek verisinden: yalnız `true` iken gelir, Merkez araç kartına "Örnek veri" notu koyar. */
  sample?: true;
};

export type HubFilterDef =
  /** `default`: eklendi (hub-web). Seçim yokken API bu değeri uygular; Merkez "Tümü" yazmaz, gerçeği gösterir. */
  | { id: string; kind: 'select'; label: string; options: { value: string; label: string }[]; multiple?: boolean; default?: string }
  | { id: string; kind: 'text'; label: string };

export type HubSeries = {
  id: string;
  label: string;
  points: { x: string; y: number | null }[];
  /** Eklendi (hub-web). `previous` gri çizilir ve dönemle sıra numarasına göre hizalanır. */
  role?: 'current' | 'previous';
};

export type HubWidget =
  | { kind: 'kpis'; id: string; items: HubKpi[] }
  | {
      kind: 'timeseries';
      id: string;
      title: string;
      description?: string;
      chart: 'line' | 'area' | 'bar';
      format: HubValueFormat;
      currency?: string;
      series: HubSeries[];
    }
  | {
      kind: 'breakdown';
      id: string;
      title: string;
      description?: string;
      format: HubValueFormat;
      currency?: string;
      /** `color`: eklendi (hub-web). Kalemin sabit rengi varsa (ör. ölçüm yöntemi, DESIGN.md). Yoksa tek renk. */
      items: { key: string; label: string; value: number; share?: number; href?: string; color?: string }[];
    }
  | ({ kind: 'table'; id: string; title: string; description?: string } & HubTable)
  | { kind: 'empty'; id: string; title: string; body?: string; href?: string; actionLabel?: string };

/** `finding`: eklendi (hub-web). Bölümün tek cümlelik sonucu ve sıradaki adım. */
export type HubSection = {
  id: string;
  title: string;
  description?: string;
  finding?: { text: string; href?: string; actionLabel?: string };
  widgets: HubWidget[];
};

export type HubAnalytics = {
  product: string;
  from: string;
  to: string;
  compare?: { from: string; to: string };
  filters: HubFilterDef[];
  sections: HubSection[];
};

export type HubColumn = {
  id: string;
  label: string;
  format: HubValueFormat;
  currency?: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  /** Eklendi (hub-web). Karışık para birimli sütun (`format: 'number'` ya da `money`): tutarın para birimi bu hücrededir. */
  currencyCell?: string;
  /** Eklendi (hub-web). Sütun seçicide açılabilir, ilk görünümde yok. */
  hiddenByDefault?: boolean;
};

export type HubRow = {
  id: string;
  /** Araçtaki kayda derin bağlantı. İş burada değil orada yapılır. */
  href?: string;
  cells: Record<string, string | number | null>;
};

export type HubTable = { columns: HubColumn[]; rows: HubRow[] };

export type HubDatasetDef = {
  id: string;
  label: string;
  description?: string;
  filters: HubFilterDef[];
  exportable: boolean;
};

export type HubDatasetList = { product: string; datasets: HubDatasetDef[] };

export type HubDatasetPage = HubTable & {
  id: string;
  page: number;
  pageSize: number;
  total: number;
};

export type HubActivityItem = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  target?: string;
  href?: string;
};

export type HubActivityPage = { items: HubActivityItem[]; page: number; pageSize: number; total: number };

/**
 * Yapay zekâ kullanımı (`GET /api/<ürün>/platform/ai-usage`, ayar izni). Dönem firmanın saat dilimindeki takvim ayıdır.
 * Para alanlarının adı `amount` ile biter: fiyat izni olmayana ürün tarafında gitmez. `label` isteğin dilinde gelir.
 * Ayrıntılı döküm: `GET …/ai-usage/calls` (`HubAiCallPage`) ve Excel `GET …/ai-usage/calls/export` (aynı süzgeçler,
 * ayar + dışa aktarma izni; başlıklar isteğin dilinde, tutar sütunları yalnız fiyat izniyle).
 */
export type HubAiUsage = {
  product: ProductKey;
  /** '2026-11' */
  period: string;
  /** ISO, firmanın saat diliminde ayın ilk anı */
  periodStart: string;
  /** ISO, bir sonraki ayın ilk anı */
  resetsAt: string;
  /** fiyat listemizin para birimi; firmanın para biriminden bağımsız */
  currency: 'TRY';
  /** AI_QUOTA_ENFORCED: false ise kota sayılır ama durdurmaz */
  enforced: boolean;
  /** planın aylık ücretsiz hakkı (TL, 2 hane) */
  freeAmount: number;
  /** bu döneme verilen ek kredi (TL) */
  creditAmount: number;
  /** freeAmount + creditAmount */
  allowanceAmount: number;
  /** bu dönem (TL, 2 hane; karşılaştırma yuvarlanmamış değerle sunucuda) */
  usedAmount: number;
  /** max(0, allowance - used) */
  remainingAmount: number;
  /** 0..100+ (tamsayı) */
  usedPct: number;
  exhausted: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** OK + FAILED */
  calls: number;
  /** önceki sonuçtan, ücretsiz */
  cachedCalls: number;
  durationMs: number;
  byKind: { kind: string; label: string; calls: number; tokens: number; amount: number; durationMs: number }[];
  /**
   * Y60: `calls` içinde, çıktı tokeni akan metinden tahmin edilen işlem (bağlantı koptu ya da süre doldu; alt sınır).
   * Sayılar aynen toplamlara girer; yalnız bilgi. Eski sunucuda yok.
   */
  estimatedCalls?: number;
  /**
   * Y62-E5: kişi başına döküm, `tokens` büyükten küçüğe (tutar sırası değil: fiyat izni olmayana maliyet sırası sızmasın).
   * `memberId` null: kişi silinmiş ya da kayıtta yok (`name` sunucunun "bilinmiyor" etiketi). `amount` yalnız fiyat izniyle.
   * Eski sunucuda yok.
   */
  byMember?: { memberId: string | null; name: string; calls: number; cachedCalls: number; tokens: number; amount: number }[];
  /**
   * Eklendi (hub-web, ayrıntılı döküm). `calls`'un sonuca göre dağılımı (toplamı `calls`): başarılı, okunamadı (sağlayıcı
   * reddetti), yarıda kaldı (kesildi ya da bağlantı koptu), başarısız (diğer hatalar). Eski sunucuda yok.
   */
  statusCounts?: Record<HubAiCallStatus, number>;
  /**
   * Eklendi (hub-web). Geçen ayın aynı süresi: bu ay seçiliyse geçen ayın başından bugünkü ana kadar, geçmiş ay seçiliyse
   * önceki ayın tamamı. `from`/`to` ISO (`to` hariç). `usedAmount` yalnız fiyat izniyle. Eski sunucuda yok.
   */
  previous?: { period: string; from: string; to: string; calls: number; tokens: number; usedAmount: number };
  /**
   * Eklendi (hub-web). Seçilebilir aylar, yeniden eskiye: bu ay ile `firstPeriod` arası (en çok 12 ay geri, firmanın
   * açıldığı aydan önce değil). `calls` o ayın işlem sayısı (0: kullanım yok). Eski sunucuda yok.
   */
  months?: { period: string; calls: number }[];
  /**
   * Eklendi (hub-web). Ekranda seçilebilen en eski ay ('YYYY-MM'). Sunucu `?period` için yine 12 ay geriyi kabul eder (firma
   * açılmadan önceki ay boş döner). Eski sunucuda yok.
   */
  firstPeriod?: string;
};

/**
 * Yapay zekâ çağrısının sonucu. `ok` başarılı (tutar aylık haktan düşer); `refused` sağlayıcı okumayı reddetti;
 * `truncated` yanıt yarıda kaldı (kesildi ya da bağlantı koptu); `failed` diğer hatalar. Sonuç vermeyen çağrılar haktan düşmez.
 */
export type HubAiCallStatus = 'ok' | 'refused' | 'truncated' | 'failed';

/**
 * Ayrıntılı dökümün bir satırı: tek yapay zekâ çağrısı (`GET /api/<ürün>/platform/ai-usage/calls`, ayar izni). Önceki
 * sonuçtan gelen ücretsiz işlemler (`HubAiUsage.cachedCalls`) listede yoktur. Para alanları (`amount`, `price*`) yalnız fiyat
 * izniyle gelir. `record` ve `href` yalnız kişinin o kaydı görme izni varsa.
 */
export type HubAiCall = {
  id: string;
  /** ISO, çağrının yazıldığı an */
  at: string;
  memberId: string | null;
  /** kişinin adı; kişi silinmişse sunucunun "bilinmiyor" etiketi */
  person: string;
  kind: string;
  /** türün adı, isteğin dilinde (`byKind[].label` ile aynı) */
  label: string;
  /** ilgili kaydın adı: fatura dosyası, tarife belgesi. Kayıt yoksa, silinmişse ya da görme izni yoksa yok. */
  record?: string;
  /** araçtaki kayda derin bağlantı (ARCHITECTURE §3); kaydın sayfası varsa */
  href?: string;
  status: HubAiCallStatus;
  /** sağlayıcı ya da sayaç hata kodu (`AI_REFUSED`, `AI_TRUNCATED`…); başarılıda null */
  errorCode: string | null;
  /** Y60: çıktı tokeni akan metinden tahmin edildi (alt sınır) */
  estimated: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  durationMs: number;
  /** istenen model */
  model: string;
  /** yanıtı veren model (sağlayıcı yedek modele düşmüş olabilir); yanıt gelmediyse null */
  servedModel: string | null;
  /** TL, 2 hane; fiyat izniyle */
  amount: number;
  /** tutar aylık haktan düştü mü (yalnız `ok`) */
  deducted: boolean;
  /** satırın fiyatlandığı fiyat tablosunun kısa özeti; fiyat izniyle */
  priceVersion: string;
  /** satır yazılırken geçen kur (1 USD = ? TL); fiyat izniyle; özetten okunamazsa null */
  priceUsdRate: number | null;
};

/** `GET /api/<ürün>/platform/ai-usage/calls?period=&kind=&member=&page=&pageSize=`. Sıra: en yeni önce. */
export type HubAiCallPage = {
  product: ProductKey;
  period: string;
  currency: 'TRY';
  page: number;
  pageSize: number;
  total: number;
  items: HubAiCall[];
};

/** Ayrıntılı döküm sayfa boyu varsayılanı; en çok `HUB_AI_CALLS_PAGE_SIZE_MAX`. */
export const HUB_AI_CALLS_PAGE_SIZE = 50;
export const HUB_AI_CALLS_PAGE_SIZE_MAX = 200;
/** `member` süzgecinde kişisi silinmiş satırlar (`memberId` null). */
export const HUB_AI_MEMBER_NONE = 'none';

// ---------- Boş Merkez yanıtları ----------
// Merkez sağlayıcısı olmayan araç (ya da sağlamadığı uç) bu boş ama geçerli şekilleri döner; Merkez'de hemen görünür, hata vermez.
// `product-kit` `registerHubRoutes` ve Merkez taklidi kullanır. Her çağrı yeni nesne döner (paylaşılan dizi yok).

/** Dönem: `from`/`to` takvim günü (`YYYY-MM-DD`), isteğin dönemi aynen yansır. */
export type HubPeriodRange = { from: string; to: string };

export function emptyHubOverview(product: string, period: HubPeriodRange): HubOverview {
  return { product, from: period.from, to: period.to, kpis: [], alerts: [] };
}

export function emptyHubAnalytics(product: string, period: HubPeriodRange): HubAnalytics {
  return { product, from: period.from, to: period.to, filters: [], sections: [] };
}

export function emptyHubDatasetList(product: string): HubDatasetList {
  return { product, datasets: [] };
}

/** Etkinlik sayfa boyu varsayılanı (DeciShip ile aynı). */
export const HUB_ACTIVITY_PAGE_SIZE = 25;

export function emptyHubActivityPage(page = 1, pageSize = HUB_ACTIVITY_PAGE_SIZE): HubActivityPage {
  return { items: [], page, pageSize, total: 0 };
}
