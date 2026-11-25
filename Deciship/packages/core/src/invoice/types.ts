import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index';
import type { Packaging } from '../packaging';
export type CarrierCode = 'fedex' | 'ups' | 'dhl' | 'aras' | 'yurtici' | 'mng' | 'ptt' | 'generic';

export type ChargePair = { label: string; amount: string };

export type InvoiceSurcharge = { code: string; name?: string; amount: number };

export type ParsedInvoiceLine = {
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
  surcharges: InvoiceSurcharge[];
  netAmount: number;
  currency?: string;
  reference?: string;
  /**
   * Faturadaki ambalaj: ambalaj sütunundan (`ColumnMapping.packaging`, `parsePackaging`), sütun yoksa ya da okunamazsa
   * hizmet adından (`servicePackaging`, yalnız Pak/Zarf); bilinmiyorsa alan yok.
   */
  packaging?: Packaging;
  rawHash: string;
};

/** `parseRows` hata kodu (Mesaj 5): `verify.ts` ve içe aktarma raporu metne değil koda bakar. */
export type ParseErrorCode = 'NO_TRACKING_COLUMN' | 'NO_NET_COLUMN' | 'BAD_TRACKING' | 'BAD_NET' | 'BAD_DATE';

/**
 * `parseRows` hatası. `rowIndex` tablodaki 0 tabanlı veri satırı; sütun hatalarında -1. `value` okunamayan hücrenin ham
 * değeri, `trackingRaw` satırın ham takip no hücresi (içe aktarma raporu için; sütun hatalarında yok).
 */
export type ParseRowError = { rowIndex: number; code: ParseErrorCode; message: string; value?: string; trackingRaw?: string };

/**
 * Faturaya alınmayan, hata da sayılmayan satır (Mesaj 5): takip no hücresi boş ama net tutarı 0 değil (takip no'suz ücret).
 * Toplam satırları buraya girmez. `amount` satırlarla aynı KDV kuralıyla (KDV dahil tutarlardan KDV düşülmüş).
 */
export type SkippedInvoiceRow = { rowIndex: number; reason: 'NO_TRACKING'; amount: number };

/** Alan → başlık adı. trackingNo ve netAmount zorunludur (öneride bulunamazsa boş kalır, `missing` listesinde görünür). */
export type ColumnMapping = {
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
  /**
   * Ambalaj sütunu (FedEx "Service Packaging"/"Paketleme", UPS "Package Type"/"Container Type"…; `parsePackaging`). Satır
   * alanıdır ama eşleme ekranının alanlarında yok (`MAPPING_FIELDS` dışında): `suggestMapping` başlıktan bulur.
   */
  packaging?: string;
  /** Ambalaj sütunundaki sayısal kodların tablosu (`parsePackaging`): FedEx kalıbında `fedex`, UPS'te `ups`; yoksa sayı okunmaz. */
  packagingCodes?: 'fedex' | 'ups';
  /** Ölçü birimi sütunu (C/CM = cm, I/IN = inç → ×2,54). Boşsa cm. */
  dimUnit?: string;
  /** Gerçek ağırlık birimi sütunu (K/KG = kg, L/LB = lb → ×0,45359237). Boşsa kg. */
  actualKgUnit?: string;
  /** Ücretli ağırlık birimi sütunu (K/KG, L/LB). Boşsa kg. */
  billedKgUnit?: string;
  /** Ölçü birimi sütunu yoksa ya da hücre boşsa kullanılacak sabit birim (varsayılan cm). */
  defaultDimUnit?: LengthUnit;
  /** Ağırlık birimi sütunu yoksa ya da hücre boşsa kullanılacak sabit birim (varsayılan kg). */
  defaultWeightUnit?: WeightUnit;
  surchargeColumns: { header: string; code: string }[];
  /**
   * Etiket/tutar sütun çiftleri (FedEx "Tracking ID Charge Description/Amount", "Ücret Etiketi/Ücret Tutarı").
   * Her satırda etiket okunur ve tutar navlun / indirim / yakıt / ek ücret olarak sınıflanır.
   */
  chargePairs?: ChargePair[];
  /** Etiket → kategori geçersiz kılmaları (yerleşik sınıflandırmadan önce uygulanır; etiket normalleştirilerek eşlenir). */
  chargeLabelOverrides?: ChargeLabelOverride[];
  /**
   * Sayı biçimi ipucu (kayıtlı eşleme, yapay zekâ). Yalnız dosyadan biçim anlaşılmazken kullanılır: eşlenen sayısal sütunların
   * metin hücrelerinde kanıt varsa (ör. "2.010,00") dosyanınki geçer (KALANLAR 1.4, `resolveNumberFormat`).
   */
  numberFormat?: 'tr' | 'en' | 'auto';
  /** Gün/ay sırası ipucu ("05/06/2026" için); yoksa ya da `auto` ise değerlerden tahmin edilir. */
  dateOrder?: 'dmy' | 'mdy' | 'auto';
  /**
   * K36: ağırlık sütunundaki "1.500" / "1,500" gibi iki türlü okunan hücreler hangi yazımla okunsun: `tr` (nokta binlik:
   * "1.500" = 1500 kg, "1,500" = 1,5 kg) ya da `en` (tersi). Her hücre kendi ayırıcısına göre okunur.
   * Yalnız ağırlık sütunlarının (`actualKg`, `billedKg`) iki türlü okunan metin hücrelerine uygulanır; tutarları ve öbür
   * sütunları değiştirmez (`numberFormat` değildir). Dosya başına kullanıcı seçer: taşıyıcının kayıtlı eşlemesine yazılmaz,
   * yapay zekâ önermez. Dosyanın biçimi kanıtla belliyse (`detectTableNumberFormat` ≠ auto) yok sayılır.
   */
  weightFormat?: 'tr' | 'en';
  /** Fatura düzeyi sütunlar (her satırda tekrarlanır): fatura no, fatura tarihi, faturanın ödenecek toplamı. */
  invoiceNo?: string;
  invoiceDate?: string;
  invoiceTotal?: string;
  amountsIncludeVat: boolean;
  vatPct: number;
  /**
   * `amountsIncludeVat` iken bileşen sütunları (navlun, indirim, yakıt, ek ücretler) da KDV dahil mi. Verilmezse veriden
   * karar verilir: navlun + … satırları KDV dahil toplama eşitse dahil; eşit değilse ya da navlun sütunu yoksa KDV hariç
   * sayılır (Aras: "Toplam" KDV dahil, "Kapıda Ödeme Bedeli" KDV hariç). `amountsIncludeVat` kapalıyken etkisizdir.
   */
  componentsIncludeVat?: boolean;
  desiAsWeight: boolean;
};

export type LengthUnit = 'cm' | 'in';
export type WeightUnit = 'kg' | 'lb';
export type ChargeKind = 'base' | 'discount' | 'fuel' | 'surcharge';
/** `kind: 'surcharge'` için `code` verilmezse etiketten türetilir. */
export type ChargeLabelOverride = { label: string; kind: ChargeKind; code?: string };

/** Fatura düzeyi (meta) başlık alanları: satır alanı değildir, eşleme ekranındaki satır alanlarında görünmez. */
export type MetaField = 'invoiceNo' | 'invoiceDate' | 'invoiceTotal';
export const META_FIELDS: MetaField[] = ['invoiceNo', 'invoiceDate', 'invoiceTotal'];

/** ColumnMapping'in satır düzeyinde başlık adı tutan alanları. */
export type MappingField = Exclude<
  keyof ColumnMapping,
  | 'surchargeColumns'
  | 'chargePairs'
  | 'chargeLabelOverrides'
  | 'amountsIncludeVat'
  | 'vatPct'
  | 'componentsIncludeVat'
  | 'desiAsWeight'
  | 'defaultDimUnit'
  | 'defaultWeightUnit'
  | 'numberFormat'
  | 'dateOrder'
  | 'weightFormat'
  | 'packaging'
  | 'packagingCodes'
  | MetaField
>;

/** Başlık adı tutan tüm alanlar (satır + meta). */
export type HeaderField = MappingField | MetaField;

export const MAPPING_FIELDS: MappingField[] = [
  'trackingNo',
  'netAmount',
  'shipDate',
  'service',
  'destCountry',
  'actualKg',
  'billedKg',
  'dimL',
  'dimW',
  'dimH',
  'dims',
  'billedDivisor',
  'baseAmount',
  'discountAmount',
  'fuelAmount',
  'currency',
  'reference',
  'dimUnit',
  'actualKgUnit',
  'billedKgUnit',
];

export const REQUIRED_MAPPING_FIELDS: MappingField[] = ['trackingNo', 'netAmount'];

/** Arayüz için alan adı, istenen dilde. */
export function mappingFieldLabel(field: MappingField, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, `mapping.${field}`);
}

/** Arayüz için Türkçe alan adları. */
export const MAPPING_FIELD_LABELS = Object.fromEntries(MAPPING_FIELDS.map((f) => [f, mappingFieldLabel(f, 'tr')])) as Record<MappingField, string>;

export function emptyMapping(): ColumnMapping {
  return { surchargeColumns: [], chargePairs: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false };
}

/**
 * `numeric` (yalnız XLSX'ten okunan tabloda): hücre dosyada metin değil gerçek sayıydı (DENETIM-2 01-B4). Düz dizi,
 * `satır * headers.length + sütun` sırasıyla; 1 = sayı. Sayı hücresinin metni `numberToCell` biçimindedir (ondalık virgül)
 * ve dosyanın sayı biçimine (tr/en) bakılmadan okunur. Okuma: `read.ts` `isNumericCell`.
 */
export type Table = { headers: string[]; rows: string[][]; numeric?: Uint8Array; sheets?: TableSheets };

/**
 * KALANLAR 1.6: XLSX'te yalnız bir sayfa okunur (en çok veri satırı olan görünür sayfa). Öbür görünür, dolu sayfalar
 * okunmaz; okuma kontrolü bunları söyler. Yalnız böyle sayfa varsa dolu. `headers` ve `sample` (ilk 20 dolu veri satırı)
 * sayfanın fatura satırı taşıyıp taşımadığını anlamak için (`unreadSheetsOf`); gizli sayfalar sayılmaz.
 */
export type TableSheets = { read: string; unread: UnreadSheet[] };
export type UnreadSheet = { name: string; /** dolu veri satırı (başlığın altında) */ rows: number; headers: string[]; sample: string[][] };
