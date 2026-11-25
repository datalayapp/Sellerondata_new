// Types mirror SPEC §4/§5. Keep in sync with apps/api serializers.
// Core'da tanımlı olanlar oradan gelir (tek kaynak); yalnız API'ye özgü olanlar burada yazılır.
import type {
  CarrierCode,
  ComparisonStatus,
  DiffType,
  EdgeRounding,
  ImportHeadline,
  ImportIssue,
  Packaging,
  PackagingLimits,
  ReviewCode,
  SurchargeKind,
  TariffImportFix,
  TariffImportOptions,
} from '@deciship/core';
export type { CarrierCode, DiffType, EdgeRounding, ImportHeadline, ImportIssue, Packaging, PackagingLimits, ReviewCode, SurchargeKind };

export type DimMethod = 'LIDAR' | 'AR' | 'REFERENCE' | 'MANUAL' | 'PRESET';
export type WeightMethod = 'OCR' | 'MANUAL';
export type PhotoKind = 'PHOTO_BOX' | 'PHOTO_SCALE' | 'PHOTO_LABEL' | 'PHOTO_OTHER';
export type LineStatus = ComparisonStatus;
export type Decision = 'OPEN' | 'VERIFIED' | 'ACCEPTED';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}


export interface CompanySettings {
  edgeTolCm: number;
  weightTolKg: number;
  amountTol: number;
  desiDivisor: number;
  requiredBoxPhotos: number;
  /** Y44: mobilde akla aykırı ölçü uyarısının eşikleri (varsayılan 150 cm, 70 kg). Yalnız uyarı; ölçüm reddedilmez. */
  warnEdgeCm?: number;
  warnWeightKg?: number;
  /** Kullanıcı kararı 2026-11-12: tartı fotoğrafını ücretli yapay zekâ okusun mu (varsayılan false). Ölçen rol de görür. */
  scaleAiRead?: boolean;
  currency?: string;
  /** Firmanın ülkesi (ISO-2), Merkez'den gelir; bilinmiyorsa null. Türk Ticaret Kanunu süresi buna bağlıdır. Fatura görmeyene gelmez. */
  country?: string | null;
  /** SPEC §FX: kur çevrilen satırlarda tolerans (%), varsayılan 1,5 */
  fxTolerancePct?: number;
  /** SPEC §FX: kur kaynağı (salt okunur, yalnız yönetici yanıtında) */
  fxSource?: string;
  /** Tarifede tanımlı olmayan ek ücretler satırı "Fark var" yapsın mı (varsayılan false: bilgi olarak listelenir) */
  unknownSurchargesAsDiff?: boolean;
  /** Mesaj 14: itiraz süresi hatırlatması (e-posta); varsayılan açık. Yalnız ayar yetkisi olanın yanıtında. */
  disputeReminders?: boolean;
  /** Mesaj 14: örnek veriyle deneme açıksa dolu (herkesin yanıtında; `byMemberId` yalnız ayar yetkisi olanda). Yalnız `demo.start/end` değiştirir. */
  demo?: { startedAt: string; byMemberId?: string | null } | null;
  /** İlk kurulum ilerlemesi (yalnız yönetici yanıtında) */
  onboarding?: OnboardingState;
  /**
   * Yalnız `GET /settings`: taşıyıcı poşeti / zarfı sınırları ve ambalaj adının taşıyıcısı (`/me` yanıtında yok).
   * `primaryCarrier`: varsayılan tarifesi olan etkin taşıyıcı, yoksa tek etkin taşıyıcı, yoksa null.
   */
  packaging?: { primaryCarrier: CarrierCode | null; carriers: Partial<Record<CarrierCode, PackagingLimits>> };
}

// ---- İlk kurulum sihirbazı (/setup) ----
/** `'sirket'` yalnız eski kayıtta kalır (firma bilgileri artık Merkez'de); sihirbazın adımları `WizardStep` (pages/onboarding/steps). */
export type OnboardingStep = 'sirket' | 'tasiyicilar' | 'faturalar' | 'tarifeler' | 'olcum' | 'koliler' | 'ozet';

export interface OnboardingState {
  step?: OnboardingStep;
  done?: OnboardingStep[];
  skipped?: OnboardingStep[];
  startedAt?: string;
  completedAt?: string | null;
  bannerDismissedAt?: string | null;
}

/** GET /me (yalnız yönetici): giriş sonrası yönlendirme ve Pano bandı */
export interface OnboardingFlags {
  completed: boolean;
  /** tamamlanmamış ve hiç taşıyıcı yok → /setup'a yönlendir */
  required: boolean;
  showBanner: boolean;
}

export interface OnboardingStatus extends OnboardingFlags {
  state: OnboardingState;
  requiredSteps: OnboardingStep[];
  /**
   * Firma bilgisinin DeciShip'teki kopyası (Merkez olayından). `confirmed`: Merkez'de onaylandı mı. Panel önce Merkez `/me`
   * `activeOrg`'a bakar (daha taze); bu yalnız yedektir.
   */
  company: { name: string; currency: string; country: string; timeZone: string; confirmed: boolean };
  carriers: {
    id: string;
    code: CarrierCode;
    name: string;
    active: boolean;
    tariffs: { id: string; name: string; active: boolean; isDefault: boolean }[];
    activeTariffCount: number;
  }[];
  boxPresets: number;
  /** Hazır koli adımı tamam mı. Örnek K1-K3 kendiliğinden tamamlamaz: Merkez ile aynı tanım. */
  boxPresetsReady?: boolean;
  /** `linesWithoutTariff`: hiçbir tarifeyle hesaplanmamış satır sayısı (tarifeden önce yüklenen örnek fatura) */
  invoices: (InvoiceListItem & { linesWithoutTariff?: number })[];
  /** Mesaj 14: örnek veriyle deneme. `available`: firma boş ve sunucuda `DEMO_TOUR` kapalı değil (eski sunucuda alan yok). */
  demo?: { active: boolean; available: boolean };
}

export interface OnboardingPatch {
  step?: OnboardingStep;
  done?: OnboardingStep;
  skipped?: OnboardingStep;
  complete?: boolean;
  dismissBanner?: true;
}

export interface Company {
  id: string;
  name: string;
  settings: CompanySettings;
}

/** `GET /api/deciship/me`: firmanın DeciShip tarafı. Kişi, firmalar ve izinler Merkez `/api/account/me` yanıtındadır. */
export interface MeResponse {
  member?: { id: string; name: string };
  company: Company;
  /** Yapay zekâ anahtarı var mı: PDF fatura okuma buna bağlı. */
  aiAvailable: boolean;
  /**
   * Y62-E3: yapay zekâ durumu (tutarsız). `quotaExhausted`: bu ayki hak doldu, yeni okuma 429 `AI_QUOTA_EXCEEDED` alır.
   * Eski sunucuda yok.
   */
  ai?: { available: boolean; quotaExhausted: boolean };
  /** yalnız deciship.settings.manage izniyle */
  onboarding?: OnboardingFlags;
}

/** Ölçüm süzgecindeki kişi: `Member` projeksiyonu. */
export interface MemberSummary {
  id: string;
  name: string;
}

export interface BoxPreset {
  id: string;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  sortOrder: number;
  active: boolean;
}

export interface Photo {
  id: string;
  kind: PhotoKind;
  url: string;
}

export interface MeasurementListItem {
  id: string;
  trackingNo: string;
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  desi: number;
  volumetricKg5000: number;
  dimMethod: DimMethod;
  weightMethod: WeightMethod;
  measuredAt: string;
  measuredBy: { id: string; name: string };
  photoCount: number;
  version: number;
  invoiceStatus?: LineStatus | null;
  boxPresetId?: string | null;
  /** Gönderinin ambalajı (kendi ambalajı / taşıyıcı poşeti / zarfı); eski sunucuda yok = kendi ambalajı. */
  packaging?: Packaging;
  /** set only in `deleted=true` listings (SPEC §10.1) */
  deletedAt?: string | null;
  deleted?: boolean;
  /** yerini düzeltilmiş yeni sürüme bırakmış (eski sürüm; API `superseded`) */
  superseded?: boolean;
}

interface MeasurementHistoryItem {
  id: string;
  version: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  dimMethod?: DimMethod;
  measuredAt: string;
  createdAt?: string;
  measuredBy?: { id: string; name: string };
  measuredByName?: string;
  note?: string | null;
}

interface MatchedInvoiceLine {
  id: string;
  invoiceId: string;
  invoiceNo?: string;
  status: LineStatus;
  diffTypes?: DiffType[];
  diffAmount?: number | null;
  netAmount?: number;
  currency?: string | null;
  /** faturadaki ambalaj; null = faturada bilgi yok */
  packaging?: Packaging | null;
}

export interface MeasurementDetail extends MeasurementListItem {
  ocrWeightKg?: number | null;
  dimConfidence?: number | null;
  note?: string | null;
  photos: Photo[];
  history: MeasurementHistoryItem[];
  invoiceLines?: MatchedInvoiceLine[];
  /** false for superseded / deleted versions — SPEC §10.1 */
  canEdit?: boolean;
  /** Yalnız silinmiş son sürümde ve ölçüm yönetme iznine: kalıcı silme açık mı, değilse neden (SPEC §10.1). */
  purge?: { allowed: boolean; reason: MeasurementPurgeBlock | null };
}

/** Kalıcı silmeyi engelleyen koruma: itiraz kaydı ya da kararlı fatura satırı. */
export type MeasurementPurgeBlock = 'DISPUTE' | 'DECIDED_LINE';

export interface MeasurementPatch {
  trackingRaw?: string;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
  dimMethod?: DimMethod;
  boxPresetId?: string | null;
  note?: string | null;
  /** Ambalaj düzeltmesi (yeni sürüm açar, faturalarla yeniden karşılaştırılır). */
  packaging?: Packaging;
  /** multipart only (SPEC §10.1) */
  removePhotoIds?: string[];
  photoKinds?: PhotoKind[];
}

export interface MeasurementCreateData {
  clientId: string;
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  dimMethod: DimMethod;
  weightMethod: WeightMethod;
  boxPresetId?: string;
  measuredAt: string;
  note?: string;
  /** yok = kendi ambalajı */
  packaging?: Packaging;
  photoKinds: PhotoKind[];
}

export interface Carrier {
  id: string;
  code: CarrierCode;
  name: string;
  active: boolean;
  defaultMapping?: ColumnMapping | null;
  /** Kayıtlı poşet / zarf sınırı ayarı; null = taşıyıcı kodunun varsayılanı (eski sunucuda yok). */
  packagingLimits?: PackagingLimits | null;
  /** Karşılaştırmanın kullandığı sınırlar: ayar > taşıyıcı kodunun varsayılanı; ambalajın sınırı bilinmiyorsa null. */
  effectivePackagingLimits?: PackagingLimits;
}

interface WeightStep {
  upto: number | null;
  step: number;
}

export interface TariffSummary {
  id: string;
  carrierId: string;
  carrier?: { id: string; name: string; code: CarrierCode };
  name: string;
  service?: string | null;
  currency: string;
  divisor: number;
  edgeRounding?: EdgeRounding;
  discountPct?: number;
  fuelPct?: number;
  /** true = faturadaki yakıt oranı kabul edilir; false = tarifedeki oranla beklenir. */
  fuelVariable?: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  active: boolean;
  isDefault: boolean;
  zoneCount?: number;
  rateCount?: number;
  updatedAt?: string;
}

export interface TariffBody {
  carrierId: string;
  name: string;
  service?: string | null;
  currency: string;
  divisor: number;
  edgeRounding: EdgeRounding;
  weightSteps: WeightStep[];
  discountPct: number;
  fuelPct: number;
  /** Yoksa sunucu taşıyıcıya göre varsayılan atar. */
  fuelVariable?: boolean;
  /** Poşet (Pak) ve zarf fiyatlarının indirimi (%); null = tarifenin indirimi. Gönderilmezse sunucu mevcut değeri korur. */
  pakDiscountPct?: number | null;
  envelopeDiscountPct?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  active: boolean;
  isDefault: boolean;
  zones: { country: string; zone: string }[];
  rates: TariffRate[];
  overflow: { zone: string; perUnit: number }[];
  surcharges: { code: string; name: string; kind: SurchargeKind; amount: number }[];
  /** SPEC §3.8: ülke istisnaları (varış ülkesinin taşıma bedeline işaretli yüzde); eski API'de yok */
  countryAdjustments?: CountryAdjustment[];
}

/** Ülke istisnası: -15,45 → o ülkede taşıma %15,45 daha ucuz. `source: 'invoice'` → fatura tarife uyumu raporundan. */
export interface CountryAdjustment {
  country: string;
  pct: number;
  note?: string | null;
  source: 'manual' | 'invoice';
  invoiceId?: string | null;
}

/** Bir fiyat hücresi. `perKg`: bu ağırlık bandında fiyat kg başıdır (ör. 71–99 kg: 7,27 $/kg). */
interface TariffRate {
  zone: string;
  weightUpto: number;
  price: number;
  perKg?: boolean;
  /** Fiyatın ambalajı: yok = kendi ambalajı (koli); PAK / ENVELOPE taşıyıcı poşeti ve zarfı (ayrı fiyat listesi). */
  packaging?: Packaging;
}

export interface Tariff extends TariffBody {
  id: string;
  /** Sunucudaki son değişiklik anı; kayıtta `expectedUpdatedAt` olarak geri gönderilir (tutmazsa 409 STALE). Eski API'de yok. */
  updatedAt?: string;
}

// ---- güvenli tarife içe aktarma (taslak → kontrol → yapay zekâ → onay → sürüm) ----
export type ImportOptions = TariffImportOptions;
/** `resolves`: çözdüğü kontrol kodları */
export type ImportFix = TariffImportFix;
export interface TariffImportDraft {
  /** 'table' = Excel/CSV, 'pdf' = PDF'ten çıkarılan tablolar */
  kind?: 'table' | 'pdf';
  draftId: string;
  fileName: string;
  summary: {
    weightCount: number;
    zoneCount: number;
    countryCount: number;
    surchargeCount: number;
    minWeight: number | null;
    maxWeight: number | null;
    detectedWeightUnit: 'kg' | 'lb' | null;
    detectedCurrency: string | null;
    tariffCurrency: string;
  };
  zones: { country: string; zone: string }[];
  rates: TariffRate[];
  /** Poşet / zarf fiyatları (her satırda `packaging`); eski sunucuda yok. Tarifeye `rates` ile birlikte yazılır. */
  packagingRates?: (TariffRate & { packaging: 'PAK' | 'ENVELOPE' })[];
  /** Dosyadaki poşet / zarf indirimi (null = tarifenin indirimi ya da dosyada yok). */
  pakDiscountPct?: number | null;
  envelopeDiscountPct?: number | null;
  overflow: { zone: string; perUnit: number }[];
  surcharges: { code: string; name: string; kind: SurchargeKind; amount: number }[];
  /** error → warning → info sıralı; error varsa uygulanamaz */
  checks: ImportIssue[];
  canApply: boolean;
  fixes: ImportFix[];
  comparison: { zone: string; oldMedian: number; newMedian: number; ratio: number }[] | null;
  aiAvailable: boolean;
  /** yalnız kind:'pdf' — hangi sayfalardan / tablolardan çıkarıldı */
  source?: { documentId: string; sectionTitles: string[]; pages: number[] };
  /** yalnız kind:'pdf' — çıkarılan fiyatların PDF ile karşılaştırması (taranmış PDF'te null) */
  verification?: {
    /** code: fiyatlar doğrudan PDF metninden okundu · text: okunan fiyatlar PDF metninde arandı */
    method?: 'code' | 'text';
    checked: number;
    matched: number;
    unmatched: { zone: string; weight: number; price: number; page: number | null }[];
  } | null;
  /** yalnız kind:'pdf' — belgeden okunan, kullanıcının onayıyla uygulanacak bilgiler */
  suggestedMeta?: { fuelPct?: number; discountPct?: number; validFrom?: string; currency?: string; service?: string };
  /** POST /tariff-imports (yeni tarife) → {kind:'new'}; mevcut tarifeye → {kind:'existing'} */
  target?: ImportTarget;
  /** yeni tarife için önerilen varsayılanlar */
  suggestedDefaults?: NewTariffDefaults;
  /** Özet: ekranın başında gösterilen tek cümlelik sonuç + en çok 3 satır */
  headline?: ImportHeadline;
}
type ImportTarget = { kind: 'new'; carrierId: string } | { kind: 'existing'; tariffId: string };
interface NewTariffDefaults {
  currency?: string;
  divisor?: number;
  /** yakıt değişken mi (taşıyıcının kapsamı ya da kaynak tarife; KALANLAR 1.1) */
  fuelVariable?: boolean;
}

// ---- PDF tarife: yükle (hızlı) → tuşla tara (kod ya da yapay zekâ) → tablo seç → çıkar (sonra taslakla aynı akış) ----
type PdfPriceType = 'net' | 'list' | 'unknown';
/** Fiyat tablosu bölümü: koli tabloları ve (ayrı bölüm olarak) taşıyıcı zarfı / poşeti tabloları (`packaging`). */
export interface TariffPdfSection {
  id: string;
  title: string;
  service: string | null;
  /** Bölümün ambalajı (eski sunucuda yok): zarf / poşet bölümünün fiyatları tarifeye ayrı satır olarak girer. */
  packaging?: 'envelope' | 'pak' | 'box' | 'all' | null;
  direction: 'export' | 'import' | 'domestic' | null;
  priceType: PdfPriceType;
  zones: string[];
  weightMin: number | null;
  weightMax: number | null;
  currency: string | null;
  pages: number[];
  hasAdditionalStep?: boolean;
  hasPerKgBands?: boolean;
  /** liste fiyatı × indirim tablosuyla hesaplanabiliyorsa: karşılık gelen liste tablosu + indirim tablosu (yalnız kod taraması) */
  listDiscount?: TariffPdfListDiscount | null;
}
export interface TariffPdfListDiscount {
  listSectionId: string;
  discountTableId: string;
  listPages: number[];
  discountPages: number[];
  /** yalnız net tablolarda: net sayfa ile liste × indirim arasında farklı fiyat sayısı */
  diff: { compared: number; differing: number; maxDiff: number } | null;
}
/** 'listDiscount' = liste fiyatı × indirim tablosu (sözleşmedeki kesin hesap); 'table' = tablodaki fiyat */
export type PdfPricing = 'table' | 'listDiscount';
export interface TariffPdfDiscountTable {
  id: string;
  title: string;
  service: string;
  direction: 'export' | 'import' | 'domestic' | null;
  pages: number[];
  zones: string[];
  /** ağırlık bandı sayısı (koli) */
  bands: number;
}
interface TariffPdfDocument {
  carrier: string | null;
  validFrom: string | null;
  currency: string | null;
  weightUnit: 'kg' | 'lb' | null;
  dimDivisor: number | null;
  fuel: { kind: 'FIXED_PCT' | 'INDEXED' | 'UNKNOWN'; pct: number | null };
  notes: string[];
  countryZonePages: number[];
}
/** POST /tariffs/:id/import ya da /tariff-imports ile .pdf yüklenince (tarama yapılmaz, hızlı) */
export interface TariffPdfUpload {
  kind: 'pdf';
  documentId: string;
  fileName: string;
  pages: number;
  /** false → taranmış görüntü; büyük olasılıkla yalnız yapay zekâ ile okunur */
  textLayer: boolean;
  /** sunucuda yapay zekâ kapalıysa false: düğme baştan pasif */
  aiAvailable?: boolean;
  target?: ImportTarget;
  suggestedDefaults?: NewTariffDefaults;
}
export type PdfScanMode = 'code' | 'ai';
/** POST /tariff-documents/:documentId/scan { mode } */
export interface TariffPdfScan {
  mode: PdfScanMode;
  document: TariffPdfDocument;
  sections: TariffPdfSection[];
  suggestedSectionIds: string[];
  /** where the suggestion came from: recent invoices, the target tariff's service, or none matched */
  suggestionSource?: 'invoices' | 'tariff' | 'default' | null;
  /** önerilen tablolar liste × indirimle hesaplanabiliyorsa 'listDiscount' */
  suggestedPricing?: PdfPricing;
  /** indirim yüzdesi tabloları (FedEx "İhracat İndirimi" / "İthalat İndirimi") */
  discountTables?: TariffPdfDiscountTable[];
  hasCountryZones: boolean;
  /** ör. kod taraması tablo bulamadıysa yapay zekâ önerisi */
  message: string | null;
}
export type TariffImportUpload = TariffImportDraft | TariffPdfUpload;
export type PdfExtractTarget = { tariffId: string } | { newTariff: { name: string | null; service: string | null } };
export interface PdfExtractBody {
  sectionIds: string[];
  includeCountryZones: boolean;
  /** 'listDiscount': seçilen tablolar liste fiyatı × indirim tablosuyla hesaplanır (karşılığı olanlar) */
  pricing?: PdfPricing;
  target: PdfExtractTarget;
}
type AiVerdict = 'ok' | 'caution' | 'reject';
export interface AiTariffReview {
  verdict: AiVerdict;
  summary: string;
  issues: ImportIssue[];
  detected: {
    carrier?: string | null;
    service?: string | null;
    origin?: string | null;
    weightUnit?: 'kg' | 'lb' | null;
    currency?: string | null;
    effectiveDate?: string | null;
    isListRate?: boolean | null;
  };
  /** yapay zekânın "bu dosya ne?" yorumu ve tarife bilgisi önerileri */
  identity?: {
    description: string;
    suggestedName: string;
    suggestedService: string | null;
    /** YYYY-MM-DD */
    suggestedValidFrom: string | null;
    suggestedValidTo: string | null;
  } | null;
  model: string;
}
/** Tarifenin değiştirilmeden önceki hali (içe aktarma, elle kayıt ya da sürüme dönüş öncesi). */
export interface TariffVersion {
  id: string;
  createdAt: string;
  reason: 'IMPORT' | 'EDIT' | 'RESTORE';
  label: string;
  user: { name: string } | null;
  rateCount: number;
  zoneCount: number;
  countryCount: number;
  currency: string;
}
/** apply ile birlikte değiştirilecek tarife bilgileri (yalnız değişenler gönderilir) */
export interface ImportMeta {
  name?: string;
  service?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  /** PDF'ten önerilen yakıt oranı kabul edilince */
  fuelPct?: number;
  /** yeni tarife taslaklarında (name zorunlu) */
  currency?: string;
  divisor?: number;
  edgeRounding?: EdgeRounding;
  discountPct?: number;
  /** yeni tarifenin yakıt türü */
  fuelVariable?: boolean;
}
export interface TariffReplaceResult {
  tariff: Tariff;
  /** değişiklikten önceki halin sürümü: "Geri al" bunu geri yükler */
  versionId: string;
  /** toplu önizlemenin kapsamı: bu tarifeye düşen ama bugünkü sürümünde olmayan faturalar (itirazdakiler dahil, önizleme atlar) */
  affectedInvoices: number;
  /** taşıyıcının başka tarifeye düşen faturaları (bu tarife onları değiştirmez) */
  otherInvoices: number;
}
/** Elle kayıt: önceki sürüm saklanır, geri alma bildirimi gösterilmez. */
export type TariffSaveResult = Omit<TariffReplaceResult, 'versionId'>;
/** apply sonucu: PDF'ten yeni tarife oluşturulunca önceki sürüm yoktur (versionId null). */
export interface TariffImportApplyResult extends Omit<TariffReplaceResult, 'versionId'> {
  versionId: string | null;
}

export type QuoteResult =
  | {
      ok: true;
      zone: string;
      lines: { label: string; amount: number }[];
      base: number;
      discount: number;
      fuel: number;
      surcharges: number;
      total: number;
      chargeableKg?: number;
      volumetricKg?: number;
    }
  | { ok: false; reason: string };

export interface ColumnMapping {
  trackingNo?: string;
  netAmount?: string;
  shipDate?: string;
  service?: string;
  destCountry?: string;
  actualKg?: string;
  billedKg?: string;
  dimL?: string;
  dimW?: string;
  dimH?: string;
  dims?: string;
  billedDivisor?: string;
  baseAmount?: string;
  discountAmount?: string;
  fuelAmount?: string;
  currency?: string;
  reference?: string;
  /** Ambalaj sütunu (FedEx "Service Packaging", UPS "Package Type" …); önerilir, eşleme ekranında alan değildir. */
  packaging?: string;
  /** Ambalaj sütunundaki sayısal kodların tablosu; yok = FedEx. */
  packagingCodes?: 'fedex' | 'ups';
  dimUnit?: string;
  actualKgUnit?: string;
  billedKgUnit?: string;
  defaultDimUnit?: 'cm' | 'in';
  defaultWeightUnit?: 'kg' | 'lb';
  surchargeColumns: { header: string; code: string }[];
  chargePairs?: { label: string; amount: string }[];
  chargeLabelOverrides?: { label: string; kind: 'base' | 'discount' | 'fuel' | 'surcharge'; code?: string }[];
  numberFormat?: 'tr' | 'en' | 'auto';
  dateOrder?: 'dmy' | 'mdy' | 'auto';
  /** K36: yalnız ağırlık sütununun "1.500" gibi hücreleri (tutarları değiştirmez); dosya başına, kayıtlı eşlemeye yazılmaz. */
  weightFormat?: 'tr' | 'en';
  invoiceNo?: string;
  invoiceDate?: string;
  invoiceTotal?: string;
  amountsIncludeVat: boolean;
  /** Navlun/indirim/yakıt/ek ücret sütunları KDV dahil mi; tanımsız = çekirdek karar verir. */
  componentsIncludeVat?: boolean;
  vatPct: number;
  desiAsWeight: boolean;
}

export interface ParsedInvoiceLine {
  rowIndex: number;
  trackingNo: string;
  shipDate?: string;
  service?: string;
  destCountry?: string;
  actualKg?: number;
  billedKg?: number;
  dims?: { l: number; w: number; h: number };
  billedDivisor?: number;
  baseAmount?: number;
  discountAmount?: number;
  fuelAmount?: number;
  surcharges: { code: string; name?: string; amount: number }[];
  netAmount: number;
  currency?: string;
  reference?: string;
  /** Faturadaki ambalaj (ambalaj sütunundan ya da hizmet adından); bilinmiyorsa yok. */
  packaging?: Packaging;
  rawHash: string;
}

interface GuessedMeta {
  invoiceNo?: string;
  invoiceDate?: string;
  currency?: string;
}

/**
 * Dosyadaki gönderilerin en az yarısı başka canlı fatura(lar)da var (aynı fatura yeniden yükleniyor olabilir). Pay birleşiktir:
 * gönderiler birden çok eski faturaya yayılmış olabilir. `invoiceId`/`invoiceNo` en çok çakışan fatura.
 */
export interface InvoiceOverlap {
  total: number;
  /** başka herhangi bir faturada bulunan gönderi sayısı (birleşik) */
  matched: number;
  invoiceId: string;
  invoiceNo: string;
  /** çakışan öbür faturalar (çoktan aza); tek faturada yok */
  otherInvoices?: { invoiceId: string; invoiceNo: string; matched: number }[];
}

export interface InvoicePreviewTable {
  fileId: string;
  format: 'csv' | 'xlsx';
  headers: string[];
  sampleRows: string[][];
  rowCount: number;
  suggestedMapping: ColumnMapping;
  mappingSource: 'saved' | 'preset';
  confidence: number;
  missing: string[];
  guessedMeta: GuessedMeta;
  /** Önerilen eşlemenin tüm dosyadaki tanılaması (eski sunucularda yok). */
  diagnostics?: import('@deciship/core').MappingDiagnostics;
  /** Her sütunun kaç satırda dolu olduğu (headers sırasıyla). */
  columnFill?: number[];
  /** SPEC §11: her alanın kaynağı (kalıp / kayıtlı / yapay zekâ / kullanıcı). */
  fieldSources?: FieldSources;
  /** SPEC §11.3: otomatik eşleme emin değil → yapay zekâ önerilir. */
  suggestAi?: boolean;
  /** Sunucuda yapay zekâ anahtarı tanımlı mı? */
  aiAvailable?: boolean;
  overlap?: InvoiceOverlap | null;
}

export type { MappingDiagnostics, MappingVerification, RowFlag, RowFlagCode, FieldSource, FieldSources, HeaderField } from '@deciship/core';
import type { FieldSources, HeaderField, MappingDiagnostics, MappingVerification, RowFlag, RowFlagCode } from '@deciship/core';

/** POST /invoices/preview/verify */
export interface MappingVerifyResult {
  diagnostics: MappingDiagnostics;
  suggestAi: boolean;
  guessedMeta?: Partial<GuessedMeta>;
  overlap?: InvoiceOverlap | null;
}

/** POST /invoices/preview/ai-mapping (SPEC §11.2) */
export interface AiMappingResult {
  mapping: ColumnMapping;
  fieldSources: FieldSources;
  aiConfidence: Partial<Record<HeaderField, { header: string | null; confidence: number; reason: string; dropped?: string }>>;
  decisions: Partial<Record<HeaderField, 'agree' | 'kept' | 'ai' | 'reverted'>>;
  dropped: { field: string; header: string }[];
  diagnostics: MappingDiagnostics;
  suggestAi: boolean;
  guessedMeta: GuessedMeta;
  overlap?: InvoiceOverlap | null;
  usage: { model: string; inputTokens: number; outputTokens: number } | null;
}

/** 409 MAPPING_UNVERIFIED details (SPEC §11.4) */
export interface MappingIssues {
  issues: string[];
  verdict: MappingVerification['verdict'];
  flaggedRows: number;
  flagCounts: MappingVerification['flagCounts'];
  examples: RowFlag[];
}

interface InvoicePreviewPdf {
  fileId: string;
  format: 'pdf';
  aiLines: ParsedInvoiceLine[];
  guessedMeta: GuessedMeta;
  warning?: string;
  /** Mesaj 5: yapay zekânın okuduğu satırların PDF metniyle denetimi (eski sunucuda yok). */
  pdfCheck?: InvoicePdfCheck;
  /** Mesaj 5: yapay zekânın okuyup takip no'suz olduğu için almadığı ücret satırları (eski sunucuda yok). */
  aiSkipped?: { count: number; amount?: number };
  /** Mesaj 6: okuma önceki sonuçtan geldi (aynı dosya 30 gün içinde okunmuştu; ücretsiz). "Yeniden oku" `fresh` ile atlar. */
  aiCached?: boolean;
}

export type InvoicePreview = InvoicePreviewTable | InvoicePreviewPdf;

// ---- Mesaj 5: kullanıcıya açık ol ----
// Core'daki karşılıkları (invoice/importReport.ts, invoiceSummary.ts) Mesaj 5'te yazılıyor; core dışa verince oradan alınabilir.
/**
 * text: sayfalarda metin vardı, satırlar arandı. none: metin katmanı yok (taranmış PDF), bayrak konmadı.
 * skipped: içe aktarmada denetim o an yapılamadı (dosya okuma havuzu meşgul ya da süre/bellek sınırı; Mesaj 6), bayrak konmadı.
 */
export type PdfCheckMethod = 'text' | 'none' | 'skipped';
/** POST /invoices/preview (PDF) yanıtındaki denetim: işaretli satırlar ve kodları. */
export interface InvoicePdfCheck {
  method: PdfCheckMethod;
  checked: number;
  unverified: number;
  /** `weightAmbiguity` (K36): ağırlık PDF'te "1.500" gibi iki türlü basılı; seçilmeden içe aktarılmaz (bayrak değil). */
  rows: { rowIndex: number; codes: RowFlagCode[]; weightAmbiguity?: PdfWeightAmbiguity }[];
}
/** `sep`, `text`: basılı ayırıcı ve yazım (seçilen yazım biçimi her yazıma kendi ayırıcısıyla uygulanır). */
export type PdfWeightAmbiguity = Partial<Record<'actualKg' | 'billedKg', { decimal: number; thousands: number; sep?: '.' | ','; text?: string }>>;
export type ImportSkipReason = 'BAD_TRACKING' | 'BAD_NET' | 'NO_TRACKING';
/** Faturanın yükleme özeti (`Invoice.importReport`); Mesaj 5 öncesi faturada null. */
export interface ImportReport {
  version: 1;
  source: 'table' | 'pdf';
  rowsInFile: number;
  linesImported: number;
  skippedCount: number;
  byReason: Partial<Record<ImportSkipReason, number>>;
  /** en çok 200; `row` dosyadaki satır numarası (rowIndex + 1) */
  skippedRows: { row: number; reason: ImportSkipReason; trackingRaw?: string; rawNet?: string; amount?: number }[];
  noTrackingAmount?: number;
  pdfCheck?: { method: PdfCheckMethod; checked: number; unverified: number };
  /** Y31: PDF metninde geçen ama okunmamış olabilecek takip no'lar (`trackings` en çok 200; `skippedCount`'a girmez) */
  /** `tooLarge`: metin çok büyüktü, denetim yapılmadı */
  pdfMissed?: { count: number; trackings: string[]; tooLarge?: true };
  /** Y20: PDF okumasının KDV oranı ve birimleri; varsayım, doğrulanamayan oran, çeviri ya da kullanılmayan değer varsa (core `PdfReadNote`) */
  pdfRead?: {
    vatPct: number;
    weightUnit: 'kg' | 'lb' | 'g';
    dimUnit?: 'cm' | 'in';
    vatAssumed?: true;
    vatUnverified?: true;
    weightAssumed?: true;
    weightUnusable?: true;
    weightKeptLines?: number;
    dimAssumed?: true;
    dimUnusable?: true;
    unitsMixed?: true;
  };
}
export type ReconStepKey = 'netDiff' | 'uncompared' | 'matchLines' | 'accepted' | 'review' | 'favourable' | 'other';
/** "Nasıl hesaplandı?" adımı: `amount` Fazla ödeme'ye imzalı katkı. Adımların toplamı = `overchargeTotal`. */
export interface ReconStep {
  key: ReconStepKey;
  amount: number;
  lines: number;
}
export interface OverchargeReconciliation {
  steps: ReconStep[];
  overchargeTotal: number;
}
/** Fazla ödemenin fark türlerine dağılımı (satırın ilk fark türüne göre, Pano ile aynı), büyükten küçüğe. */
export interface OverchargeByType {
  type: DiffType;
  lines: number;
  amount: number;
}
/** POST /invoices yanıtı. Atlanan ve alınmayan satırların sayıları `importReport` içinde. */
export interface InvoiceCreateResult {
  invoice: Invoice;
  errors: { rowIndex: number; code?: string; message: string }[];
  importReport?: ImportReport;
}

/**
 * `POST /invoices?async=1` (KALANLAR 6.18): küçük dosya ve PDF hemen 201 (`InvoiceCreateResult`); büyük CSV/Excel 202 iş,
 * sonucu `job.result` aynı gövde (`invoice.fileUrl` yok, satır hataları en çok 200).
 */
export type InvoiceCreateStart = InvoiceCreateResult | { job: JobView; joined: boolean };

export interface InvoiceTotals {
  lines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  billedTotal: number;
  expectedTotal: number;
  overchargeTotal: number;
  verifiedTotal: number;
  /** SPEC §11: okuma bayrağı olan ve "Kontrol ettim" denmemiş satırlar. */
  flaggedLines?: number;
  /** Fark olup uyumlu sayılan satır: "Fark var" sekmesinde görünmez. */
  acceptedLines?: number;
  /** billed total of the compared lines (those with an expected amount), unchecked surcharges INCLUDED; absent on old invoices.
   *  Show it via core `invoiceSummaryAmounts` (covers the same charges as expectedTotal). */
  comparedBilledTotal?: number;
  /** pak/zarf lines (out of scope), counted inside unmatched / noTariff; absent on old invoices */
  pakUnmatched?: number;
  pakNoTariff?: number;
  /** lines whose FX rate could not be fetched (TCMB did not answer) */
  fxMissing?: number;
  /** Y18: saklı (eski tarihli) kurla hesaplanan, "İncele" sayılan satırlar; yalnız sıfırdan büyükse gelir. */
  fxStale?: number;
  /** Tarifede tanımlı olmayan, Beklenen'e faturadaki tutarıyla eklenen ek ücretlerin toplamı (bilgi); eski faturalarda yok. */
  uncheckedSurchargeTotal?: number;
  /** SPEC §3.8: tahmini (LOW güvenli) fark satırlarının fazlası — Fazla ödeme'ye girmez; eski faturalarda yok. */
  estimatedOverchargeTotal?: number;
  estimatedLines?: number;
  /** Mesaj 4: donmuş (kararlı ya da itirazdaki) satırlardan yeniden hesap bekleyenler (`recalcPending` dolu); eski sunucuda yok. */
  pendingLines?: number;
  /** Mesaj 5: "Nasıl hesaplandı?" adımları ve türlere göre dağılım; fiyat izni olmayana ve eski sunucuda yok. */
  reconciliation?: OverchargeReconciliation;
  overchargeByType?: OverchargeByType[];
}

// ---- Mesaj 4: geçmiş sonuçlar donar (Deciship/SPEC.md §3.14) ----
/**
 * Faturanın hesap dayanağı. CURRENT: tarifenin bugünkü sürümü ve bugünkü ayarla hesaplı. TARIFF_CHANGED: tarife sonradan
 * değişti. TARIFF_REMOVED: tarife silindi (ya da başka taşıyıcıya taşındı), fatura sürümdeki fiyatlarla duruyor.
 * RULES_CHANGED: tolerans ayarı değişti. NONE: dayanaksız (tarifesiz ya da eski fatura). İkisi birden değiştiyse sunucu
 * TARIFF_CHANGED döner; "Yeni tarifeyle hesapla" yalnız tarifeyi günceller, ardından durum RULES_CHANGED olur.
 */
export type InvoiceBasisState = 'CURRENT' | 'TARIFF_CHANGED' | 'TARIFF_REMOVED' | 'RULES_CHANGED' | 'NONE';
export interface InvoiceBasis {
  state: InvoiceBasisState;
  /** hesabın dayandığı tarife sürümünün adı (tarife silindiyse de dolu) */
  tariffName: string | null;
  /** faturanın en son hesaplandığı an (ISO) */
  calculatedAt: string | null;
}
/**
 * Hesap isteğinin dayanağı: pinned = faturanın sabit sürümü ve ayarı; tariff = yalnız tarife sürümü bugünküne geçer;
 * rules = yalnız ayar bugünküne geçer. `lineIds` ve `patch` yalnız pinned ile (sunucu yoksa 400).
 */
export type RecalcBasis = 'pinned' | 'tariff' | 'rules';
/**
 * Donmuş satırda bekleyen değişikliğin sınıfı (`InvoiceLine.recalcPending`): yalnız üç değer. `prevResult.cause`'un yedi
 * değerinden farklıdır. Bilinmeyen değer OTHER gibi gösterilir ("Yeniden hesap bekliyor", `pendingKey`).
 */
export type RecalcPendingCause = 'MEASUREMENT' | 'DUPLICATE' | 'OTHER';
/** `prevResult.cause`: eski sonucu neyin değiştirdiği. Bilinmeyen değer OTHER gibi gösterilir. */
export type PrevResultCause = 'MEASUREMENT' | 'DUPLICATE' | 'TRACKING' | 'MATCH' | 'TARIFF' | 'RULES' | 'OTHER';
/** Satırın bir adım önceki sonucu (yalnız para sonucu değiştiyse dolar). */
export interface PrevResult {
  status: LineStatus;
  diffTypes: DiffType[];
  expectedAmount: number | null;
  diffAmount: number | null;
  ourChargeableKg: number | null;
  /** eski sonucun yerini yenisine bıraktığı an (ISO) */
  at: string;
  cause: PrevResultCause;
}

/** Önizlemedeki bir tarafın dayanağı. */
export interface RecalcBasisRef {
  tariffId: string | null;
  tariffName: string | null;
  revisionId: string | null;
  /** sürümün oluştuğu an (ISO) */
  revisionAt: string | null;
}
/** Önizlemede bir satırın önceki ya da sonraki sonucu. */
export interface RecalcLineResult {
  status: LineStatus;
  diffTypes: DiffType[];
  expectedAmount: number | null;
  diffAmount: number | null;
}
export interface RecalcPreviewLine {
  id: string;
  rowIndex: number;
  trackingNo: string;
  decision: Decision;
  before: RecalcLineResult;
  after: RecalcLineResult;
}
/** Önizlemedeki toplam: en az fazla ödeme; sunucu `InvoiceTotals`'ın tamamını da gönderebilir. */
export type RecalcTotals = Pick<InvoiceTotals, 'overchargeTotal'> & Partial<InvoiceTotals>;
/** Fatura önizlemesinde değiştirilmek istenen alanlar (düzenleme penceresi). */
export interface RecalcPatch {
  carrierId?: string;
  tariffId?: string | null;
  invoiceDate?: string;
  currency?: string;
}
/** POST /invoices/:id/recalculate/preview yanıtı. Yazmaz. */
export interface InvoiceRecalcPreview {
  token: string;
  /** `rulesChanged`: hesap ayarı faturadakinden farklı (yalnız current ya da patch) */
  basis: { from: RecalcBasisRef; to: RecalcBasisRef; rulesChanged?: boolean };
  totals: { before: RecalcTotals; after: RecalcTotals };
  /** yazılacak ve sonucu görünür biçimde değişen satır sayısı (donmuş olanlar dahil) */
  changedLines: number;
  /**
   * Uygulanınca dokunulacak satır (görünür değişiklik olmasa da: yeni ölçüme bağlanma, "yeniden hesap bekliyor" işaretinin
   * silinmesi, tolerans içi Beklenen kayması). `changedLines` 0 iken > 0 ise sormadan uygulanır. Eski sunucuda yok.
   */
  writeLines?: number;
  /** bunlardan kararı verilmiş satırlar (kararları korunur) */
  frozenChanged: number;
  /** sonucu değişecek ama etkin itirazda olduğu için yazılmayacak satırlar */
  skippedInDispute: number;
  /** değişen satırlar, ilk 200 */
  lines: RecalcPreviewLine[];
}
/** Toplu önizlemede bir fatura. `currency` varsayım: sunucu fatura para birimini de gönderir. */
export interface BulkRecalcInvoice {
  id: string;
  invoiceNo: string;
  carrierName: string;
  currency?: string;
  before: RecalcTotals;
  after: RecalcTotals;
  changedLines: number;
}
/** Toplu önizlemede bir para biriminin fazla ödeme toplamı (farklı para birimleri toplanmaz). */
export interface BulkCurrencyTotal {
  currency: string;
  /** bu para birimindeki geçirilecek fatura sayısı */
  invoices: number;
  before: RecalcTotals;
  after: RecalcTotals;
}
/** POST /tariffs/:id/recompare-invoices/preview ve POST /settings/recompare-invoices/preview yanıtı. */
export interface BulkRecalcPreview {
  token: string;
  /** geçirilecek faturalar, ilk 200 */
  invoices: BulkRecalcInvoice[];
  /**
   * Geçirilecek TÜM faturaların para birimine göre toplamı, para birimi sırasıyla. Fiyat izni yoksa sunucu alanı siler
   * (`totals` sözcüğü para alanıdır).
   */
  totalsByCurrency?: BulkCurrencyTotal[];
  /** yeni dayanağa geçirilecek fatura sayısı (rakamı değişmese de) */
  changedInvoices: number;
  /** etkin itirazı olduğu için atlanan fatura sayısı */
  skippedInDispute: number;
}
export interface BulkRecalcResult {
  /** yeni dayanağa geçirilen fatura sayısı */
  invoices: number;
  /** geçirilen faturaların TOPLAM satır sayısı (değişen satır sayısı değil) */
  lines: number;
  /** inDispute: etkin itirazı olduğu için geçirilmeyen; stale: önizlemeden sonra değiştiği için yazılmayan fatura */
  skipped: { inDispute: number; stale: number };
  /**
   * K4: `skipped.stale` > 0 ise var: önizlemeden sonra değiştiği için yazılmayan faturalar, en çok 200 (silinmiş fatura
   * listede yok). Aynı kapsamın yeni önizlemesi bunları yeniden gösterir.
   */
  staleInvoices?: BulkStaleInvoice[];
  /**
   * K4: iş bütünüyle bittiyse ve > 0 ise: hâlâ eski dayanakta kalan, itirazda olmayan fatura sayısı (atlananlar,
   * önizlemeden sonra eklenenler, itirazı kapananlar). Panel "Yeniden önizle" önerir.
   */
  remaining?: number;
  /** Mesaj 7: iş durdurulduysa geçirilmeden kalan fatura sayısı (yazılanlar yeni hâlinde kalır) */
  stopped?: number;
}
/** K4: toplu geçişte atlanan faturanın kısa kaydı; `deleted`: bu arada silindi (bağlantı yok). */
export interface BulkStaleInvoice {
  id: string;
  invoiceNo: string;
  carrierName: string;
  deleted?: true;
}

/** GET /tariffs/:id yanıtı. `pinnedInvoices`: bu tarifenin sürümleriyle hesaplı (silinmemiş) fatura sayısı. */
export interface TariffDetail {
  tariff: Tariff;
  pinnedInvoices: number;
}

/** POST /invoices/:id/recompare yanıtı. `pendingLines`: donmuş olduğu için yazılmayıp işaretlenen satır sayısı. */
export interface InvoiceRecompareResult {
  invoice: Invoice;
  pendingLines: number;
}

export interface InvoiceListItem {
  id: string;
  invoiceNo: string;
  invoiceDate: string;
  carrier: { id: string; name: string; code?: CarrierCode };
  totals: InvoiceTotals;
  currency?: string;
  createdAt: string;
  /** İtiraz durumu (eski sunucuda yok: İşlendi sayılır). */
  disputeStatus?: InvoiceDisputeStatus;
  disputeSums?: DisputeSums | null;
}

export interface Invoice extends InvoiceListItem {
  carrierId?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  status?: 'PROCESSED' | 'FAILED';
  sourceFileId?: string;
  file?: { id?: string; url: string; name?: string; mime?: string } | null;
  fileUrl?: string | null;
  fileName?: string | null;
  /** Seçilen tarife; null = Otomatik (satırdaki hizmete uyan, yoksa varsayılan tarife). */
  tariffId?: string | null;
  tariff?: { id: string; name: string } | null;
  /** Satırlarda kullanılan tarifeler (satır sayısına göre çoktan aza; yalnız detayda). */
  tariffsUsed?: { id: string; name: string; lines: number }[];
  /** Karşılaştırılan satırların çoğunda fiyat farkı var: tarife yanlış ya da eski olabilir (yalnız detayda). */
  tariffSuspect?: boolean;
  /** İtiraz paketi, sonuçlar ve geçmiş turlar (yalnız detayda; eski sunucuda yok). */
  dispute?: InvoiceDispute;
  /** Hesabın dayanağı (yalnız detayda; eski sunucuda yok). */
  basis?: InvoiceBasis;
  /** Mesaj 5: yükleme özeti (yalnız detayda; eski faturada null, eski sunucuda yok). */
  importReport?: ImportReport | null;
  /** K37: arka plandaki yeniden hesap 5 kez düştü (yalnız detayda, yalnız doluyken). Eylem "Yeniden karşılaştır". */
  recalcFailed?: boolean;
}

export interface InvoiceCreateBody {
  fileId: string;
  carrierId: string;
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  /** null/yok = Otomatik */
  tariffId?: string | null;
  mapping?: ColumnMapping;
  lines?: ParsedInvoiceLine[];
  saveMapping: boolean;
  /** SPEC §11.4: okuma kontrolü sorunluysa kullanıcı onayı. */
  acknowledgeIssues?: boolean;
  /** Çakışma onayı: çakışma varken false ise sunucu 409 INVOICE_OVERLAP döner. */
  confirmOverlap?: boolean;
  /** K36: ağırlığı PDF'te iki türlü basılı satırlardan kullanıcının seçtiği (ya da düzelttiği) satır no'ları. */
  pdfWeightConfirmed?: number[];
}

interface LineMeasurement {
  id: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  measuredAt: string;
  measuredByName: string;
  photos: Photo[];
  /** sunucu zaten gönderiyor; Mesaj 5'te tipe eklendi */
  dimMethod?: DimMethod;
  /** Mesaj 5 (eski sunucuda yok) */
  weightMethod?: WeightMethod;
  /** Gönderinin kayıtlı ambalajı (eski sunucuda yok = kendi ambalajı). */
  packaging?: Packaging;
  photoCount?: number;
}

/** Mesaj 14 §4.2: `GET /invoices` parametreleri. `q`: fatura no ya da takip no (en çok 64 karakter). */
export type InvoiceListStatus = 'DIFF' | 'UNMATCHED' | 'TO_DISPUTE';
export interface InvoiceListParams {
  carrierId?: string;
  from?: string;
  to?: string;
  q?: string;
  status?: InvoiceListStatus;
  page?: number;
  pageSize?: number;
}

/**
 * `GET /invoices/:id/lines` yanıtı. `selectionDigest` (Y127): süzgecin bütün satırlarının (yalnız bu sayfa değil) özeti;
 * "tümünü seç" bunu geri gönderir. Karar izni yoksa ya da süzgeç 5.000 satırı aşıyorsa null ("tümünü seç" sunulmaz).
 */
export type LinePage = Page<InvoiceLine> & {
  selectionDigest: string | null;
  /**
   * 10-B14: süzgeçte toplu kararın değiştirebileceği satır sayısı (kararı bekleyen, fark var, hesabı güncel, itirazda
   * olmayan; `isEligible` ile aynı). `selectionDigest` ile birlikte gelir; eski sunucuda yok.
   */
  selectionEligible?: number | null;
};

/**
 * Mesaj 14 §4.1: toplu karar. `lineIds` ile `filter`'dan tam biri verilir; `filter` varsa `expectedCount` ve
 * `selectionDigest` zorunlu.
 */
export interface BulkDecideFilter {
  status?: LineStatus;
  diffType?: DiffType;
  decision?: Decision[];
  q?: string;
  review?: boolean;
  recalcPending?: boolean;
  flagged?: boolean;
}
export interface BulkDecideBody {
  decision: Decision;
  /** `ACCEPTED`'da zorunlu (1..1000, tek satır kararıyla aynı) */
  reason?: string;
  lineIds?: string[];
  filter?: BulkDecideFilter;
  expectedCount?: number;
  /** `filter` ile: satır listesi yanıtının `selectionDigest`'i */
  selectionDigest?: string;
  /** Geri al (yalnız `OPEN` + `lineIds`): ilk işlemin `opId` ve `decidedAt`'i; yalnız o kararı taşıyan satırlar açılır */
  undoOf?: { opId: string; decidedAt: string };
}
/** Atlama nedenleri. Adlarda para sözcüğü yok (fiyat izni olmayan rolde silinmesinler). */
export interface BulkDecideSkipped {
  inDispute: number;
  /** "Fark var" değil */
  noGap: number;
  review: number;
  decided: number;
  pending: number;
  notDecided: number;
  /** itiraz listesi: talebi sıfır */
  noClaim: number;
  /** geri al: karar bu arada başkasınca ya da sonradan verildi */
  changedSince: number;
}
export interface BulkDecideResult {
  opId: string;
  decision: Decision;
  changed: number;
  /** Geri al: bu kimliklerle `decision: 'OPEN'` ve `undoOf` gönderilir. */
  changedLineIds: string[];
  /** yazılan karar anı (ISO; `OPEN`'da ya da hiçbir satır değişmediyse null) */
  decidedAt: string | null;
  skipped: BulkDecideSkipped;
  totals: InvoiceTotals;
}

/** Mesaj 14 §4.3: `POST /settings/demo` yanıtı (201). */
export interface DemoStartResult {
  carriers: number;
  tariffs: number;
  measurements: number;
  invoices: number;
}
/** `DELETE /settings/demo` yanıtı (200). */
export interface DemoEndResult {
  removed: { invoices: number; tariffs: number; carriers: number; measurements: number };
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  rowIndex: number;
  trackingNo: string;
  shipDate?: string | null;
  service?: string | null;
  destCountry?: string | null;
  actualKg?: number | null;
  billedKg?: number | null;
  dimL?: number | null;
  dimW?: number | null;
  dimH?: number | null;
  billedDivisor?: number | null;
  baseAmount?: number | null;
  discountAmount?: number | null;
  fuelAmount?: number | null;
  surcharges: { code: string; name?: string; amount: number }[];
  netAmount: number;
  currency?: string | null;
  reference?: string | null;
  /** Faturadaki ambalaj; null = faturada bilgi yok (eski sunucuda yok). */
  packaging?: Packaging | null;
  measurementId?: string | null;
  tariffId?: string | null;
  /** Karşılaştırmada kullanılan tarife */
  tariff?: { id: string; name: string } | null;
  status: LineStatus;
  diffTypes: DiffType[];
  ourChargeableKg?: number | null;
  billedChargeableKg?: number | null;
  expectedAmount?: number | null;
  diffAmount?: number | null;
  /** `unchecked`: tarifede tanımlı olmayan ek ücret; Beklenen'e faturadaki tutarıyla dahil (kontrol edilemez) */
  breakdown: { label: string; amount: number; currency?: string; unchecked?: boolean; info?: boolean; fx?: unknown }[];
  /** SPEC §3.8: beklenenin dayanağı — TARIFF (sözleşme tarifesi) | INVOICE (taşıyıcının faturadaki fiyatı, bizim kg'a ölçekli) */
  pricingBasis?: 'TARIFF' | 'INVOICE' | null;
  /** faturadaki taşıma bedelinin tarifeye göre sapması (%, −15 = %15 ucuz) */
  rateDeviationPct?: number | null;
  /** HIGH = kesin; LOW = tahmini (Fazla ödeme'ye girmez) */
  confidence?: 'HIGH' | 'LOW';
  confidenceReason?: string | null;
  /** "İncele" nedeninin sınıfı (yalnız LOW satırda; kısa etiketi `common:reviewCode.*`). Tutar taşımaz. */
  reviewCode?: ReviewCode | null;
  /** Beklenen taşıyıcı poşeti / zarfı fiyatıyla hesaplandıysa o ambalaj; kendi ambalajında null. */
  pricedPackaging?: 'PAK' | 'ENVELOPE' | null;
  note?: string | null;
  decision: Decision;
  decisionReason?: string | null;
  decidedAt?: string | null;
  measurement: LineMeasurement | null;
  /** manual match (SPEC §10.2): recompares use the pinned measurement instead of tracking no */
  measurementPinned?: boolean;
  /** tracking no as printed on the invoice before the first correction */
  originalTrackingNo?: string | null;
  /** SPEC §11: okuma kontrolü bayrakları */
  parseFlags?: string[];
  /** SPEC §11: "Kontrol ettim" */
  parseChecked?: boolean;
  /** SPEC §FX: tarife para birimi farklıysa uygulanan kur (beklenen tutar satır para birimine çevrildi) */
  fx?: import('@deciship/core').FxApplied | null;
  /** Satır etkin itiraz paketindeyse sonucu; değilse null (eski sunucuda yok). Paketteki satırın kararı değişmez (409 LINE_IN_DISPUTE). */
  dispute?: LineDispute | null;
  /** Bir adım önceki sonuç: "ölçüm değişti, eski fark şuydu" (eski sunucuda yok). */
  prevResult?: PrevResult | null;
  /** Donmuş satırda sonuç farklı çıktı ama yazılmadı: neden (eski sunucuda yok). */
  recalcPending?: RecalcPendingCause | null;
  recalcPendingAt?: string | null;
}

/** PATCH /invoice-lines/:id — every field optional (SPEC §10.2) */
export interface InvoiceLinePatch {
  decision?: Decision;
  reason?: string;
  trackingNo?: string;
  measurementId?: string | null;
  note?: string | null;
  parseChecked?: boolean;
  /** 10-B13: panelin gördüğü karar; sunucuda tutmazsa 409 LINE_CHANGED (hiçbir alan yazılmaz). */
  expectedDecision?: Decision;
}

export interface InvoiceLinePatchResult {
  line: InvoiceLine;
  totals?: InvoiceTotals;
}

/** PATCH /invoices/:id (SPEC §10.2) */
export interface InvoicePatch {
  invoiceNo?: string;
  invoiceDate?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  currency?: string;
  carrierId?: string;
  /** null = Otomatik; taşıyıcı değişince sunucu Otomatik'e döndürür */
  tariffId?: string | null;
  /**
   * Taşıyıcı, tarife, tarih ya da para birimi değişiyorsa zorunlu: aynı değişikliğin önizlemesinin (`recalculatePreview`
   * `{ basis: 'pinned', patch }`) `token`'ı. Yoksa 400 VALIDATION; önizlemeden sonra rakamlar değiştiyse 409 PREVIEW_STALE.
   */
  token?: string;
}

export interface DisputeText {
  subject: string;
  body: string;
  lineCount: number;
  total: number;
  /** K43: faturanın KDV oranı biliniyorsa oran ve toplam talebin KDV dahil hâli (metindeki toplamla aynı); yoksa yok. */
  vatPct?: number;
  totalInclVat?: number;
  /** Mesaj 5: metindeki satırların fotoğraf sayısı (> 0 ise ZIP bağlantısı) ve fotoğrafsız satırlar; eski sunucuda yok. */
  photoCount?: number;
  linesWithoutPhoto?: number;
  /** 10-B3: metnin satır kümesinin özeti; "Gönderildi olarak işaretle" bunu geri gönderir (küme değiştiyse 409 SELECTION_CHANGED). */
  selectionDigest?: string;
}

// ---- İtiraz takibi (Deciship/spec/itiraz.md "API sözleşmesi") ----
// Para alanları `prices.view` yoksa sunucuda silinir: hepsi isteğe bağlı yazıldı, arayüz yokken de çizer.
export type DisputeChannel = 'EMAIL' | 'PORTAL' | 'OTHER';
export type DisputeLineOutcome = 'PENDING' | 'RECOVERED' | 'REJECTED';
export type InvoiceDisputeStatus = 'NONE' | 'SENT' | 'CLOSED';
/** UNSENT: listede satır var, paket gönderilmedi */
export type DisputeListStatus = 'UNSENT' | 'SENT' | 'CLOSED';
export type DisputeTtk = 'ON_TIME' | 'LATE' | null;

export interface PersonRef {
  id: string;
  name: string;
}

/** Hepsi fatura para biriminde. */
export interface DisputeSums {
  /** gönderilen talep */
  claimedAmount?: number;
  /** canlı dekont toplamı */
  recoveredAmount?: number;
  /** reddedilen satırların talebi */
  rejectedAmount?: number;
  /** sonuçsuz satırların talebi */
  pendingAmount?: number;
  /** kısmi geri almada talep − geri alınan */
  shortfallAmount?: number;
}

export interface DisputeLineView {
  id: string;
  invoiceLineId: string;
  lineNo: number | null;
  trackingNo: string | null;
  claimedAmount?: number;
  outcome: DisputeLineOutcome;
  recoveredAmount?: number | null;
  resultId: string | null;
}

export interface DisputeResultView {
  id: string;
  kind: 'RECOVERED' | 'REJECTED';
  creditNoteNo: string | null;
  /** dekont ya da ret tarihi, YYYY-MM-DD */
  resultOn: string;
  reason: string | null;
  /** RECOVERED: dekont toplamı; REJECTED: reddedilen talep */
  amount?: number;
  lines: { disputeLineId: string; amount?: number }[];
  enteredBy: PersonRef;
  enteredAt: string;
  revertedAt: string | null;
  revertedBy: PersonRef | null;
  revertReason: string | null;
}

export interface DisputeRound {
  id: string;
  round: number;
  currency: string;
  sentOn: string;
  channel: DisputeChannel;
  channelNote: string | null;
  reference: string | null;
  sentBy: PersonRef;
  createdAt: string;
  /** TTK uygulanmıyorsa null */
  ttk: DisputeTtk;
  /**
   * TTK'ya esas gönderim günü: turdaki satırların taşıyıcıya ilk bildirildiği günlerin en geçi; yeniden gönderilen turda ilk
   * gönderim (KALANLAR 4a). Eski sunucuda yok: `sentOn`.
   */
  ttkSentOn?: string;
  withdrawnAt: string | null;
  withdrawnBy: PersonRef | null;
  withdrawReason: string | null;
  supersededById: string | null;
  /** yerini yeniye bıraktığı an (API ekledi) */
  supersededAt?: string | null;
  version: number;
  sums: DisputeSums;
  lines: DisputeLineView[];
  /** geri alınanlar dahil, yeni önce */
  results: DisputeResultView[];
}

/** GET /invoices/:id yanıtındaki `dispute`. */
export interface InvoiceDispute {
  status: InvoiceDisputeStatus;
  /** geri çekilmemiş ve yerine yenisi gelmemiş tur */
  active: DisputeRound | null;
  /** geri çekilen / yerini yeniye bırakan turlar, yeni önce */
  history: DisputeRound[];
  /** şimdi gönderilse pakete girecek satır sayısı */
  sendableLineCount: number;
  /** o satırların talebi */
  sendableAmount?: number;
  /** gönderilecek satırlardan yeniden hesap bekleyen (`recalcPending`) sayısı; gönderimi engellemez */
  recalcPendingLines?: number;
  /** listede olup etkin turda olmayan satırlar (gönderimden sonra eklenen); etkin tur yoksa = sendableLineCount */
  unsentLineCount?: number;
  unsentAmount?: number;
  /** 10-B3: gönderilecek satır kümesinin özeti (itiraz metniyle aynı); satır yoksa null */
  selectionDigest?: string | null;
  /** faturanın itiraz toplamı ("geçerli satır" kuralı); hiç gönderilmediyse null (API ekledi) */
  sums?: DisputeSums | null;
}

/** GET /invoices/:id satırına eklenen özet: satır etkin paketteyse dolu. */
export interface LineDispute {
  outcome: DisputeLineOutcome;
  recoveredAmount?: number | null;
}

export interface DisputeListItem {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: string | null;
  currency: string;
  carrier: { id: string; name: string; code: string } | null;
  status: DisputeListStatus;
  disputeId: string | null;
  round: number | null;
  sentOn: string | null;
  channel: DisputeChannel | null;
  sentBy: PersonRef | null;
  /** UNSENT: gönderilecek satır; diğerleri: paketteki satır */
  lineCount: number;
  resolvedCount: number;
  /** UNSENT için claimedAmount = gönderilecek talep, diğerleri 0 */
  sums: DisputeSums;
  deadlines: { ttk?: import('@deciship/core').DeadlineInfo; carrier?: import('@deciship/core').DeadlineInfo };
  ttkStatus: DisputeTtk;
  /** etkin turun TTK'ya esas gönderim günü (yeniden gönderimde ilk gönderim); UNSENT'te null, eski sunucuda yok */
  ttkSentOn?: string | null;
  /** gönderilmemiş satırlar: UNSENT'te hepsi, SENT/CLOSED'da gönderimden sonra listeye eklenenler */
  unsentLineCount?: number;
  unsentAmount?: number;
}

export type DisputeCurrencySums = DisputeSums & { currency: string; unsentAmount?: number };

export interface DisputeListResponse {
  items: DisputeListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** süzgeçten bağımsız, firmanın tamamı */
  summary: {
    /** UNSENT: gönderilecek satırı olan fatura (SENT/CLOSED içinde de sayılabilir); ALL: listedeki fatura */
    counts: { UNSENT: number; SENT: number; CLOSED: number; ALL?: number };
    byCurrency: DisputeCurrencySums[];
    /** UNSENT, süresi 7 gün içinde dolan veya dolmuş, en yakın önce, en çok 5 */
    dueSoon: DisputeListItem[];
  };
}

export interface DisputeSendBody {
  sentOn: string;
  channel: DisputeChannel;
  channelNote?: string;
  reference?: string;
  /** 10-B3: yollanan metnin (ya da ekranda gösterilen kümenin) özeti; tutmazsa 409 SELECTION_CHANGED */
  selectionDigest?: string;
}

export interface DisputeResultBody {
  version: number;
  kind: 'RECOVERED' | 'REJECTED';
  resultOn: string;
  creditNoteNo?: string;
  reason?: string;
  /** RECOVERED'da amount zorunlu */
  lines: { disputeLineId: string; amount?: number }[];
}

export interface Dashboard {
  measurements: { count: number; byMethod: Partial<Record<DimMethod, number>>; today: number };
  invoices: { count: number; lines: number; match: number; diff: number; unmatched: number; noTariff: number };
  overchargeTotal: number;
  verifiedTotal: number;
  coveragePct: number;
  topDiffTypes: { type: DiffType; count: number; amount: number }[];
  recentInvoices: InvoiceListItem[];
  currency: string;
  /** İtirazda geri alınan (canlı dekontlar) ve sonuç bekleyen talep, birincil para biriminde. Eski sunucuda yok. */
  recoveredTotal?: number;
  disputePendingTotal?: number;
  /** Para birimi başına toplamlar; ilki baş rakamınkidir. */
  byCurrency?: {
    currency: string;
    invoices: number;
    lines: number;
    billedTotal: number;
    overchargeTotal: number;
    verifiedTotal: number;
    recoveredTotal?: number;
    disputePendingTotal?: number;
  }[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---- SPEC §3.9 tarife uyumu ----
export interface TariffHealthGroup {
  key: string;
  country: string | null;
  countryName: string;
  zone: string | null;
  service: string | null;
  lines: number;
  medianDeviationPct: number;
  minDeviationPct: number;
  maxDeviationPct: number;
  status: 'ok' | 'cheaper' | 'pricier';
  /** tarifeye yazılacak toplam ülke istisnası (mevcut dahil); öneri yoksa null */
  suggestedAdjustmentPct: number | null;
  currentAdjustmentPct: number;
  weak: boolean;
  suspect: boolean;
  message: string;
}

export interface TariffHealth {
  invoiceId: string;
  carrierName: string;
  /**
   * Faturanın hesaplandığı tarife SÜRÜMÜ (Mesaj 4): tarife sonradan silindiyse `id` null ve `removed` true, ad sürümden gelir.
   */
  tariff: { id: string | null; name: string; currency: string; countryAdjustments: CountryAdjustment[]; removed?: boolean; revisionId?: string } | null;
  /** satırlarda fiyat bilgisi yok (eski karşılaştırma) — yeniden karşılaştırma gerekir */
  stale: boolean;
  checkedLines: number;
  okLines: number;
  skippedLines: number;
  okTolerancePct: number;
  groups: TariffHealthGroup[];
  overallNote: string | null;
  overallMedianPct: number | null;
  /** faturadaki yakıt oranı tarifedekinden farklıysa tek cümle */
  fuelNote?: string | null;
  invoiceFuelPct?: number | null;
}

export interface CountryAdjustmentResult {
  tariff: Tariff;
  versionId: string;
  /** Mesaj 4: sunucu fatura hesaplamaz; her zaman null */
  totals: null;
  health: TariffHealth | null;
}

// ---- Mesaj 7: arka plan işleri (API `Deciship/apps/api/src/services/jobs/types.ts` ile birebir; elle tutulur) ----
export type JobKind =
  | 'INVOICE_PDF_READ'
  | 'TARIFF_PDF_SCAN'
  | 'TARIFF_PDF_EXTRACT'
  | 'BULK_RECOMPARE_PREVIEW'
  | 'BULK_RECOMPARE_APPLY'
  | 'INVOICE_IMPORT'
  | 'TARIFF_IMPORT_REVIEW';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type JobRefType = 'File' | 'TariffDocument' | 'Tariff' | 'Company' | 'TariffImportDraft';
/** İlerleme aşaması (ekran anahtarı `common:jobs.stage.<aşama>`). */
export type JobStage =
  | 'pdfRead'
  | 'pdfPages'
  | 'pdfCheck'
  | 'tariffScan'
  | 'tariffExtract'
  | 'bulkCheck'
  | 'bulkWrite'
  | 'importRead'
  | 'importCompare'
  | 'importWrite'
  | 'tariffReview';

/** `GET /jobs/:id`, `GET /jobs` (listede `result` yok), başlatan uçların `{ job, joined }`'ı. */
export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: { done: number; total: number | null; stage: string | null };
  label: string | null;
  ref: { type: JobRefType; id: string | null } | null;
  /** türün açık parametreleri (ör. extract: sectionIds, includeCountryZones, pricing) */
  params?: Record<string, unknown>;
  /** > 1 ise "kaldığı yerden sürüyor" */
  attempt: number;
  /** tür durdurulabilir ve iş bitmemiş */
  cancellable: boolean;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** (finishedAt ?? şimdi) - (startedAt ?? createdAt) */
  elapsedMs: number;
  /** yalnız SUCCEEDED (ve bölüm sonucuyla CANCELLED); listede hiç yok */
  result?: unknown;
  /** yalnız FAILED */
  error?: { statusCode: number; code: string; message: string; details?: unknown };
  /** uygulama işinde yazım sırasında `{ invoices, lines, inDispute, stale }`; kontrol aşamasında ve diğer türlerde null/yok */
  counters?: Record<string, number> | null;
}

/** `GET /jobs` sorgusu (`?active=1&kind=K&refType=T&refId=X&mine=1`). En çok 20, `result` yok. */
export interface JobListQuery {
  active?: boolean;
  kind?: JobKind;
  refType?: JobRefType;
  refId?: string;
  mine?: boolean;
}

/** Başlatan uçların 202 yanıtı. */
export interface JobStarted {
  job: JobView;
  joined: boolean;
}

/** `POST /invoices/preview?async=1`: PDF'te iş (202), CSV/XLSX'te bugünkü önizleme (200). */
export type InvoicePreviewStart = { job: JobView; joined: boolean } | { preview: InvoicePreview };

/** Y80-E2: `GET /invoices/preview/resumable` öğesi (API `services/fileCleanup.ts` `ResumablePreview` ile elle eş). */
export interface ResumablePreview {
  fileId: string;
  name: string;
  size: number;
  /** sonuç `GET /jobs/:jobId` ile alınır */
  jobId: string;
  /** `reading`: okuma sürüyor; `ready`: okundu, içe aktarılmadı */
  status: 'reading' | 'ready';
  updatedAt: string;
}
