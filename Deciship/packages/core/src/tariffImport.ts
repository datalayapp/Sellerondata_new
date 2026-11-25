/**
 * Güvenli tarife içe aktarma: ham tablo → fiyat tablosu okuma (seçeneklerle) → kod kontrolleri.
 * Saf modül; dosya okuma (CSV/XLSX → hücre matrisi) api tarafındadır.
 */
import { type WeightStep, round2, round3 } from './calc';
import type { Packaging } from './packaging';
import { fmtKg, fmtMoney, fmtNumber, fmtWeightNumber, parseTrNumber } from './format';
import { DEFAULT_LOCALE, localizeText, t, type Locale, type MessageKey, type MessageParams } from './i18n/index';
import { cleanZoneLabel, distanceZoneCode, zoneKey } from './tariff';
import { countryNameToIso2, iso3ToIso2 } from './countries';
import { canonicalCountryCode } from './countryNames';
import { LB_TO_KG, parseNumberAs, type NumberFormat } from './invoice/values';
import { describeWeightStep, describeWeightSteps, sameWeightSteps, stepAbove, weightStepsFromRates } from './weightSteps';
import { DEFAULT_MAX_ROWS, detectFormat, numericCellValue, readCsvMatrix, readXlsxSheets, tooManyRowsError, type ReadLimits } from './invoice/read';

export type ImportSeverity = 'error' | 'warning' | 'info';
export type ImportIssue = {
  severity: ImportSeverity;
  code: string;
  title: string;
  detail?: string;
  suggestion?: string;
  rows?: number[];
};

/**
 * numberFormat: kullanıcının seçtiği sayı biçimi (01-B6; metin hücreleri bu biçimle okunur, tespit yapılmaz).
 * discountUnit: biçimsiz 0–1 arası indirimin anlamı (01-B12): 'percent' 0,5 = %0,5 (eski şablon), 'ratio' 0,5 = %50.
 * openBandMode: "kg başı" yazmayan, fiyatı önceki satırdan çok düşük açık uçlu satırın ("31+ | 8") anlamı (KALANLAR 1.7):
 * 'additional' her ilave birim (önceki satırın fiyatı + ilave × fiyat; varsayılan okuma), 'perKg' fiyat × toplam ağırlık.
 */
export type TariffImportOptions = {
  convertLbToKg?: boolean;
  currency?: string;
  numberFormat?: 'tr' | 'en';
  discountUnit?: 'percent' | 'ratio';
  openBandMode?: OpenBandMode;
};

export type OpenBandMode = 'additional' | 'perKg' | 'flat';
/** Açık uçlu satır neden soruldu: başlangıç tablonun sonuna uymuyor, bölgenin başka aşım kuralı var, ilave fiyatı tablodaki artışa göre çok düşük, sabit okunursa önceki satırdan ucuz. */
export type OpenBandWhy = 'start' | 'conflict' | 'price' | 'cheaper';

/** Sayfa hücreleri; dizi sırası = dosyadaki satır numarası − 1 (boş satırlar korunur). */
export type RawSheet = string[][];
/**
 * XLSX hücre işareti, `RawSheet` ile aynı biçimde: satır başına '0'/'1' dizgisi (`mask[r][c] === '1'`). Taslakta JSON
 * olarak saklandığı için boolean matris yerine kısa dizgi. Eksik satır/sütun '0' sayılır.
 */
export type CellMask = string[];
export type RawTariffFile = {
  fileName: string;
  /** pdf: PDF'ten çıkarılan tablo, kodla bu biçime dönüştürülmüş hâli. */
  kind: 'csv' | 'xlsx' | 'pdf';
  prices: RawSheet | null;
  pricesSheetName?: string | null;
  zones: RawSheet | null;
  surcharges: RawSheet | null;
  sheetNames?: string[];
  /** XLSX fiyat sayfasında gerçek sayı hücreleri (01-B6): metni sayı biçimine bakılmadan okunur. Yoksa hepsi metin. */
  pricesNumeric?: CellMask;
  /** XLSX fiyat sayfasında Excel yüzde biçimli sayı hücreleri (01-B12: İndirim sütunu). */
  pricesPercent?: CellMask;
};

/** boolean matris → `CellMask`; hiç işaret yoksa undefined (taslak küçük kalsın). */
export function cellMask(m: boolean[][] | null | undefined): CellMask | undefined {
  if (!m || !m.some((r) => r?.some(Boolean))) return undefined;
  return Array.from(m, (r) => Array.from(r ?? [], (x) => (x ? '1' : '0')).join(''));
}

const maskHas = (m: CellMask | undefined, r: number, c: number) => m?.[r]?.[c] === '1';

/** FedEx Pak / Zarf (özel ambalaj) fiyatı. */
export type SpecialPackaging = Exclude<Packaging, 'OWN'>;

/**
 * perKg: kg başı fiyat bandı (fiyat × ücretli kg). generated: "İlave 0,5 kg" kuralından üretilmiş ara satır.
 * packaging: yok = kendi ambalajı (OWN); 'PAK' / 'ENVELOPE' yalnız `packagingRates` satırlarında.
 */
export type ImportRate = { zone: string; weightUpto: number; price: number; row: number; perKg?: boolean; generated?: boolean; packaging?: Packaging };
/** Pak / Zarf fiyatı: ağırlık, tablonun biriminde (lb→kg seçilince kg); sabit fiyat (kg başı değil). */
export type ImportPackagingRate = ImportRate & { packaging: SpecialPackaging };
/** "İlave 0,5 kg" kuralı: iki açık ağırlık arasında her adım için eklenen tutar. */
export type StepExpansion = { zone: string; row: number; from: number; to: number; step: number; amount: number; count: number };
export type ImportZone = { country: string; zone: string };
export type ImportOverflow = { zone: string; perUnit: number };
export type ImportSurcharge = { code: string; name: string; kind: 'FIXED' | 'PCT' | 'PER_KG'; amount: number };
export type SkippedRow = { row: number; reason: string; text: string };

export type ParsedTariffImport = {
  rates: ImportRate[];
  zones: ImportZone[];
  overflow: ImportOverflow[];
  surcharges: ImportSurcharge[];
  sheets: { prices: boolean; zones: boolean; surcharges: boolean };
  kind: 'csv' | 'xlsx' | 'pdf';
  /** Fiyat sütunlarının temizlenmiş bölge adları (dosya sırasıyla). */
  priceZones: string[];
  zoneRenames: { from: string; to: string }[];
  duplicateZones: string[];
  skipped: SkippedRow[];
  invalidPrices: { row: number; zone: string; text: string }[];
  /** packaging: Pak / Zarf satırlarındaki mükerrer ağırlık (yoksa kendi ambalajı). */
  duplicates: { zone: string; weightUpto: number; prices: number[]; rows: number[]; packaging?: SpecialPackaging }[];
  sheetIssues: { sheet: 'zones' | 'surcharges'; row: number; reason: string }[];
  /** Başlık satırından önceki metin satırları. */
  titleLines: string[];
  /** İlk fiyat tablosundan sonra gelen başka tabloların başlıkları. */
  extraTables: { row: number; title: string }[];
  headerRow: number | null;
  weightHeader: string;
  detectedWeightUnit: 'kg' | 'lb' | null;
  detectedCurrency: string | null;
  /**
   * FedEx Pak / Zarf fiyatları (satır etiketi "FedEx Pak 1 lb", "Envelope up to 8 oz", "Zarf 0,5" ya da "Pak" / "Envelope"
   * ara başlığının altındaki satırlar). `rates` yalnız kendi ambalajıdır (OWN); tarifeye ikisi birlikte yazılır
   * (`TariffInput.rates[].packaging`). Kontroller (basamak, kapsam, karşılaştırma) yalnız `rates`'e bakar.
   */
  packagingRates: ImportPackagingRate[];
  /** Fiyat sayfasındaki İndirim sütunu (kendi ambalajı satırları). Tek değer: tarifenin indirimi. null: sütun yok ya da boş. */
  discountPct: number | null;
  /**
   * Pak / Zarf satırlarının İndirim hücreleri farklı tek bir değerse o değer (`TariffInput.pakDiscountPct` /
   * `envelopeDiscountPct`). null: hücre yok, boş ya da `discountPct` ile aynı (null = `discountPct` kullanılır).
   */
  pakDiscountPct: number | null;
  envelopeDiscountPct: number | null;
  /** İndirim sütunu kullanılamıyor: farklı değerler ya da 0-100 dışı. */
  discountIssue: { kind: 'mixed' | 'invalid'; values: string[] } | null;
  unitEvidence: string[];
  currencyEvidence: string[];
  applied: { convertLbToKg: boolean; currency: string | null; numberFormat?: 'tr' | 'en'; discountUnit?: 'percent' | 'ratio'; openBandMode?: OpenBandMode };
  /**
   * Fiyat tablosunun metin hücrelerinden sayı biçimi (01-B6; `tableNumberFormat`). `chosen`: kullanıcı seçti
   * (`options.numberFormat`). PDF taslağında her zaman auto (hücreler kodla yazılmış, eski okuma).
   */
  numberFormat: { format: NumberFormat; certain: boolean; chosen: boolean };
  /**
   * Biçim kesin değilken iki türlü okunan (biçim belirsiz) ya da eski okumadan farklı okunan (biçim zayıf kanıtla seçildi)
   * metin hücreleri. zone null: ağırlık hücresi. tr/en: iki okuma; used: kullanılan.
   */
  numberAmbiguities: { row: number; zone: string | null; text: string; tr: number; en: number; used: number }[];
  /** İndirim hücresi biçimsiz 0–1 arası (01-B12): %0,5 mi %50 mi? Seçenek verilse de kayıt kalır (düzeltme etiketi için). */
  discountChoice: { text: string; asPercent: number; asRatio: number } | null;
  /**
   * "kg başı" işareti olmayan açık uçlu satırlar ("31+ | 8", "30 desi üzeri | 8"; 01-B12, KALANLAR 1.7): fiyat önceki
   * satırdan çok düşük. additional: her ilave birim (aşım fiyatı, basamak 1; varsayılan); perKg: fiyat × toplam ağırlık
   * (yalnız `openBandMode: 'perKg'` seçilince); unclear: okunamadı (başlangıcı tablonun sonuna uymuyor ya da bölgenin
   * başka aşım fiyatı var), sorulur, satır alınmaz ve uygulama durur. prevWeight: bölgenin son sabit satırı.
   * chosen: okumayı kişi seçti (`openBandMode`).
   */
  openBands: {
    row: number;
    zone: string;
    label: string;
    price: number;
    prevPrice: number;
    prevWeight: number;
    from: number;
    reading: 'perKg' | 'additional' | 'unclear';
    chosen: boolean;
    why?: OpenBandWhy;
  }[];
  /** Kullanılamayan, sorulan ilave kuralları (KALANLAR 1.7): bölgenin başka aşım kuralı var, başlangıç ya da bölge tablosu uymuyor. */
  stepConflicts: { row: number; zone: string; reason: string }[];
  /** Açık uçlu ya da ilave satırına benzeyen ama okunamayan ağırlık etiketleri ("30 desi sonrası beher"); sorulur. */
  unreadableOpenBands: { row: number; label: string }[];
  /** "İlave X kg" kurallarından üretilen ara ağırlıklar (bölge × kural başına). */
  stepExpansions: StepExpansion[];
  /** Kullanılamayan ilave kuralları (önünde/arkasında açık ağırlık yok vb.). */
  stepIssues: { row: number; zone: string; reason: string }[];
  /** Kuralla hesaplanan değer ile bir sonraki açık satır arasında belirgin fark. */
  stepMismatches: { zone: string; row: number; from: number; to: number; expected: number; actual: number }[];
  /** "Kg başına ücret" gibi bölüm başlıkları (satır numarasıyla). */
  perKgTitles: { row: number; title: string }[];
  /**
   * Aşım fiyatı son satırdan sonraki "İlave X" kuralından geldiyse aşım basamağı (X; lb→kg çevrilince 1 kg).
   * Yoksa null: "Aşım" satırında basamak yazmaz, mevcut tarifenin son basamağı korunur.
   */
  overflowStep?: number | null;
  /** Dosyadaki "Aşım" satırı (varsa): satır no ve etiket ("Aşım (kg başı)"). */
  overflowRow?: { row: number; label: string };
};

/**
 * "Aşım" satırındaki birimden aşım basamağı: "kg başı", "her kg", "her ilave kg", "per kg", "desi başı",
 * "/kg" → 1; "her ilave 0,5 kg", "her ek 0,5 kg", "0,5 kg başı" → 0,5. Birim yoksa ("Aşım", "Aşım (her ek birim)") null.
 */
export function overflowUnitStep(label: string): number | null {
  const t = norm(String(label ?? '')).replace(/\s+/g, ' ');
  const U = '(kgs?|desi|lbs?)\\b';
  const N = '(\\d+(?:[.,]\\d+)?)';
  // "kg/desi", "desi/kg", "kg/ds" birimin iki yazılışıdır, "kg başı" değil: "Aşım (30 desi/kg üzeri)" eşiği
  // söyler (30 kg'lık basamak değil); "TL/kg", "Ücret / kg" ise kg başıdır
  const UNIT = '(?:kgs?|desi|lbs?|ds)\\b';
  const m =
    new RegExp(`(?:\\bher|\\bilave|\\bek|\\beach|\\bper|\\badditional)\\s+(?:(?:ilave|ek|additional)\\s+)?(?:${N}\\s*)?${U}`).exec(t) ??
    new RegExp(`(?:${N}\\s*)?${U}\\s*(?:basi|basina|\\/(?!\\s*${UNIT}))`).exec(t) ??
    new RegExp(`(?<!\\b${UNIT}\\s*)\\/\\s*()${U}`).exec(t);
  if (!m) return null;
  const v = m[1] ? parseTrNumber(m[1]) : 1;
  return v != null && v > 0 ? v : null;
}


const norm = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .trim();

const cellsOf = (row: string[] | undefined): string[] =>
  (row ?? []).map((c) => String(c ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim());

const isEmptyRow = (c: string[]) => c.every((x) => x === '');

const LB_RE = /(?:^|[^a-z])(lbs?|pounds?|libre|oz)(?:[^a-z]|$)/i;
const KG_RE = /(?:^|[^a-z])(kgs?|kilograms?|kilogram|desi)(?:[^a-z]|$)/i;
const WEIGHT_SUFFIX = /\s*(lbs?|pounds?|kgs?|kilograms?|desi)\.?\s*$/i;
const WEIGHT_PREFIX = /^(≤|<=|<|up to|kadar)\s*/i;
const PACKAGE_RE = /envelope|\bpak\b|zarf|dok[uü]man|document|\bbox\b|kutu|letter|mektup/i;
/**
 * Taşıyıcı poşeti (PAK: FedEx Pak, UPS Express Pak, DHL Flyer, poşet) ve taşıyıcı zarfı (ENVELOPE: Envelope, Letter,
 * Zarf, Dosya, Evrak, Mektup) kelimeleri; bütün taşıyıcılar için. Kutu (FedEx Box, UPS Box) kendi ambalajı tarifesidir,
 * burada değil (`PACKAGE_RE` satırı atlar). "Documents" / "Doküman" zarf değil, ayrı belge ürünüdür (DHL Documents
 * 0,5–2 kg; DHL zarfı ayrı ürün): bölümü alınmaz, satırları uyarıyla gösterilir.
 */
const PAK_WORD_RE = /\bpak\b|\bflyers?\b|po[sş]et/i;
const ENVELOPE_WORD_RE = /envelope|\bzarf|\bletters?\b|\bdosya|\bevrak|\bmektup/i;
const DOCUMENT_WORD_RE = /\bdocuments?\b|\bdocs?\b|d[oö]k[uü]man/i;
/** Ambalaj kelimesi (dışlama kalıbı için). */
const PACK_W = String.raw`(?:paks?|flyers?|po[sş]et\w*|envelopes?|zarf\w*|letters?|dosya\w*|evrak\w*|mektup\w*|documents?|docs?|d[oö]k[uü]man\w*)`;
const PACK_LIST = String.raw`${PACK_W}(?:\s*(?:\/|,|&|\bve\b|\band\b|\bveya\b|\bor\b)\s*${PACK_W})*`;
/**
 * Ambalajı dışlayan / olumsuzlayan yazım: "non-Pak", "Non-documents", "excluding Pak", "except envelopes",
 * "Zarf/Pak dışında", "Pak hariç", "Pak dahil tüm gönderiler". Kelimeler bitişik olmalı ("Pak (KDV hariç)" dışlama değil).
 */
const PACK_EXCLUDE_RE = new RegExp(
  String.raw`\b(?:excluding|excl\.?|except|without|other\s+than|non)[\s-]*${PACK_LIST}|\b${PACK_LIST}\s*(?:d[ıi][şs][ıi]nda|hari[çc]|dahil\s+t[üu]m)`,
  'i',
);
/** Kendi ambalajı bölümü başlığı ("Diğer ambalaj malzemeleri kullanıldığında", "Your Packaging", "Pak dahil tüm gönderiler"). */
const OWN_PACKAGING_TITLE_RE =
  /di[gğ]er\s+ambalaj|kendi\s+ambalaj|other\s+packag|your\s+packag|customer\s+packag|dahil\s+t[üu]m|t[üu]m\s+g[öo]nderi|\ball\s+shipments\b|\bincluding\s+all\b/i;
const isOwnPackagingText = (text: string) => OWN_PACKAGING_TITLE_RE.test(text) || PACK_EXCLUDE_RE.test(text);

/** Pak / Zarf etiketindeki ağırlık birimi. */
export type WeightUnitWord = 'kg' | 'g' | 'lb' | 'oz';
const OZ_TO_KG = 0.028349523125;

/**
 * Ara başlık: kendi ambalajı bölümü (OWN; önce denenir: "Diğer ambalaj (Zarf/Pak dışında)", "Your Packaging (non-Pak)"),
 * Pak / Zarf bölümü, ikisi birden (UNCLEAR), belge bölümü (DOCUMENT); başka başlık undefined.
 */
export function packagingTitle(text: string): SpecialPackaging | 'UNCLEAR' | 'OWN' | 'DOCUMENT' | undefined {
  if (isOwnPackagingText(text)) return 'OWN';
  const env = ENVELOPE_WORD_RE.test(text);
  const pak = PAK_WORD_RE.test(text);
  if (env && pak) return 'UNCLEAR';
  if (env) return 'ENVELOPE';
  if (pak) return 'PAK';
  return DOCUMENT_WORD_RE.test(text) ? 'DOCUMENT' : undefined;
}

const PACK_BRAND_RE = /\b(?:fedex|ups|dhl|tnt)\b|®|™|\(r\)/gi;
const PACK_WORD_STRIP =
  /envelope|\bzarf[ıi]?|\bpak\b|\bflyers?\b|po[sş]et[iı]?|\bletters?\b|\bdosya(?:s[ıi])?|\bevrak[ıi]?|\bmektup|\bexpress\b|\bekspres\b|\bworldwide\b|\bfiyat[ıi]?|[üu]cret[ıi]?|\bprice\b|\brate\b/gi;
const PACK_UPTO_STRIP = /\bup\s*to\b|\bmax(?:imum)?\.?|\bmaks(?:imum)?\.?|\ben\s*[çc]ok\b|['’]?\s*(?:y?[ae])?\s*kadar\b|≤|<=|</gi;
const PACK_UNIT = '(kgs?|kilograms?|g|gr|grams?|lbs?|pounds?|oz|ounces?)';
const PACK_WEIGHT_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${PACK_UNIT}?\\.?$`, 'i');
/** "0,5 - 2,5 kg": aralık → üst sınır (kendi ambalajı aralık satırı gibi). */
const PACK_RANGE_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${PACK_UNIT}?\\.?\\s*[-–—]\\s*(\\d+(?:[.,]\\d+)?)\\s*${PACK_UNIT}?\\.?$`, 'i');
const unitWord = (u: string | undefined): WeightUnitWord | null => {
  const x = (u ?? '').toLowerCase();
  return !x ? null : x.startsWith('k') ? 'kg' : x.startsWith('g') ? 'g' : x.startsWith('o') ? 'oz' : 'lb';
};

/**
 * Pak / Zarf satır etiketi: "FedEx® Pak 1 lb." → PAK 1 lb; "FedEx® Envelope up to 8 oz." → ENVELOPE 8 oz;
 * "UPS Express Envelope" / "Dosya" → ENVELOPE ağırlıksız (anyWeight); "DHL Flyer 0,5 - 2 kg" → PAK 2 kg (aralığın üstü);
 * "Zarf 0,5" / "Pak 0,5 kg'a kadar" → 0,5 (birim yoksa tablonun birimi). Etikette Pak / Zarf yoksa null.
 * packaging null: ikisi birden yazıyor ("Zarf/Pak 0,5"), hangisi belli değil. weight null + anyWeight false: etikette sayı
 * var ama okunamadı ("IP Pak 2 lbs") → alınmaz. anyWeight: etikette hiç sayı yok, tek fiyat (taşıyıcının sınırına kadar).
 * Ağırlık etiketin biriminde; tablonun birimine `packagingWeightIn`.
 */
export function parsePackagingLabel(
  text: string,
  num: NumberReader = trReader,
): { packaging: SpecialPackaging | null; weight: number | null; unit: WeightUnitWord | null; anyWeight: boolean } | null {
  const raw = String(text ?? '').replace(/\u00a0/g, ' ');
  // "Your Packaging (non-Pak)", "Pak hariç": kendi ambalajı
  if (isOwnPackagingText(raw)) return null;
  const env = ENVELOPE_WORD_RE.test(raw);
  const pak = PAK_WORD_RE.test(raw);
  if (!env && !pak) return null;
  const packaging: SpecialPackaging | null = env && pak ? null : env ? 'ENVELOPE' : 'PAK';
  const rest = raw
    .replace(PACK_BRAND_RE, ' ')
    .replace(PACK_WORD_STRIP, ' ')
    .replace(PACK_UPTO_STRIP, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s()[\]:/;-]+|[\s()[\]:/;-]+$/g, '')
    .trim();
  if (!/\d/.test(rest)) return { packaging, weight: null, unit: null, anyWeight: true };
  const m = PACK_WEIGHT_RE.exec(rest);
  if (m) {
    const w = num(m[1]!);
    return w != null && w > 0 ? { packaging, weight: w, unit: unitWord(m[2]), anyWeight: false } : { packaging, weight: null, unit: null, anyWeight: false };
  }
  const r = PACK_RANGE_RE.exec(rest);
  const from = r ? num(r[1]!) : null;
  const to = r ? num(r[3]!) : null;
  if (r && from != null && to != null && to > 0 && to >= from && (!r[2] || !r[4] || unitWord(r[2]) === unitWord(r[4]))) {
    return { packaging, weight: to, unit: unitWord(r[4] ?? r[2]), anyWeight: false };
  }
  return { packaging, weight: null, unit: null, anyWeight: false };
}

/** Etiket birimindeki ağırlık → tablonun birimi (lb tablosunda "8 oz" = 0,5 lb; kg tablosunda 0,227 kg). */
export function packagingWeightIn(w: number, unit: WeightUnitWord, table: 'kg' | 'lb'): number {
  if (w >= OPEN_WEIGHT) return w;
  if (table === 'kg') return unit === 'kg' ? w : round3(unit === 'g' ? w / 1000 : unit === 'oz' ? w * OZ_TO_KG : w * LB_TO_KG);
  if (unit === 'lb') return w;
  const lb = unit === 'oz' ? w / 16 : (unit === 'g' ? w / 1000 : w) / LB_TO_KG;
  return Math.round(lb * 1e6) / 1e6;
}

/**
 * Pak / Zarf fiyat satırının etiketi (PDF taslağı gibi kodla yazılan tablolar için): `packagingRowLabel('PAK', '0,5')`
 * → "Pak 0,5"; ağırlıksız satır (`weightLabel` boş / yok) → "Zarf" (her ağırlıkta tek fiyat). İçe aktarma bunu aynı
 * biçimde okur (`parsePackagingLabel`).
 */
export function packagingRowLabel(p: SpecialPackaging, weightLabel?: string | null): string {
  return `${p === 'PAK' ? 'Pak' : 'Zarf'} ${weightLabel ?? ''}`.trim();
}

const CURRENCIES: [RegExp, string][] = [
  [/US\$|\$|\bUSD\b/i, 'USD'],
  [/€|\bEUR\b|\bEURO\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/₺|\bTL\b|\bTRY\b/, 'TRY'],
  [/\bCHF\b/, 'CHF'],
];

function currencyOf(text: string): string | null {
  for (const [re, code] of CURRENCIES) if (re.test(text)) return code;
  return null;
}

/** Hücre sayısı okuyucu: varsayılan `parseTrNumber` (eski okuma); tarife tablosunda dosyanın sayı biçimine göre (01-B6). */
export type NumberReader = (s: string) => number | null;
const trReader: NumberReader = (s) => parseTrNumber(s);

/** "1 lb." / "0,5" / "≤ 2 kg" → sayı; okunamazsa null. */
export function parseWeightCell(text: string, num: NumberReader = trReader): number | null {
  const t = text.replace(WEIGHT_PREFIX, '').trim();
  const direct = num(t);
  if (direct != null) return direct;
  const stripped = t.replace(WEIGHT_SUFFIX, '');
  return stripped !== t ? num(stripped) : null;
}

/** Son kg başı bandının ("1000+") üst sınırı: pratikte sınırsız. */
export const OPEN_WEIGHT = 99999;

const PER_KG_RE = /kg\s*ba[sş][iı]|per\s*kg|\/\s*kg|kilo(?:gram)?\s*ba[sş]|[cç]arp[iı]n[iı]z|multipl/i;
const PER_KG_STRIP = /\(?\s*(?:kg\s*ba[sş][iı](?:na)?(?:\s*(?:fiyat|[üu]cret)[ıi]?)?|per\s*kg|\/\s*kg)\s*\)?/gi;
const STEP_RE = /^(?:[iİI]lave|her\s+ek|ek|additional|each\s+additional|add'?l\.?|plus)\s*(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|lb|lbs|desi)?(?![a-z])/i;
const RANGE_RE = /^(\d+(?:[.,]\d+)?)\s*(?:kg|lb|desi)?\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*(?:kg|lbs?|desi)?\.?$/i;
const PLUS_RE = /^(?:>|over\s*)?\s*(\d+(?:[.,]\d+)?)\s*(?:kg|lbs?|desi)?\s*(?:\+|ve\s*[üu]zeri|[üu]zeri|and\s*over|and\s*above|plus)$/i;
/**
 * Açık uçlu ağırlığın diğer yazımları (KALANLAR 1.7), sadeleşmiş (`norm`) metinde: "30+ desi", "31 ve üstü", "30 DESİ ÜZERİ",
 * "> 30", "≥ 31 kg", "31-∞", "31 - +".
 */
const OPEN_UNIT = /(?:kgs?|lbs?|desi|ds)\.?/.source;
const OPEN_NUM = /(\d+(?:[.,]\d+)?)/.source;
const OPEN_SUFFIX = /(?:\+|ve\s*uzeri|uzeri|ve\s*ustu|ustu|ve\s*yukarisi|ve\s*fazlasi|and\s*over|and\s*above|and\s*up|or\s*more|plus)/.source;
const OPEN_RES = [
  new RegExp(String.raw`^${OPEN_NUM}\s*(?:${OPEN_UNIT})?\s*${OPEN_SUFFIX}\s*(?:${OPEN_UNIT})?$`),
  new RegExp(String.raw`^(?:>=?|≥|over|above)\s*${OPEN_NUM}\s*(?:${OPEN_UNIT})?$`),
  new RegExp(String.raw`^${OPEN_NUM}\s*(?:${OPEN_UNIT})?\s*[-–—]\s*(?:∞|sonsuz|\+|max|maks)\s*(?:${OPEN_UNIT})?$`),
];
/** Açık uç ya da ilave satırına benzeyen etiket (sadeleşmiş metin; okunamazsa sorulur, KALANLAR 1.7). */
const isOpenish = (n: string) =>
  (/\d/.test(n) && /\+|∞|>|≥|uzeri|ustu|fazla|sonra|\bover\b|above|\bplus\b|\bup\b/.test(n)) || /ilave|beher|\bher\b|additional|\beach\b/.test(n);

/** newSpelling: açık uç yalnız yeni yazımlardan tanındı ("> 30", "30+ desi", "31-∞"; eski "31+" ve "30 üzeri" değil). */
export type WeightLabel = { weight: number; perKg: boolean; kind: 'single' | 'range' | 'open'; from: number | null; newSpelling?: boolean };

/**
 * Ağırlık hücresi: "0,5" / "≤ 2 kg" (tek), "71-99" / "71–99 kg başı" (aralık → üst sınır), "1000+" (açık uç → 99999).
 * perKg: hücrede "kg başı"/"per kg" işareti varsa.
 */
export function parseWeightLabel(text: string, num: NumberReader = trReader): WeightLabel | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const perKg = PER_KG_RE.test(raw);
  const t = raw.replace(PER_KG_STRIP, ' ').replace(/\s+/g, ' ').trim();
  const range = RANGE_RE.exec(t);
  if (range) {
    const from = num(range[1]!);
    const to = num(range[2]!);
    if (from != null && to != null && to > 0 && to >= from) return { weight: to, perKg, kind: 'range', from };
  }
  const nt = norm(t);
  const old = PLUS_RE.exec(t);
  const plus = old ?? OPEN_RES.reduce<RegExpExecArray | null>((m, re) => m ?? re.exec(nt), null);
  if (plus) {
    const from = num(plus[1]!);
    if (from != null) return { weight: OPEN_WEIGHT, perKg, kind: 'open', from, ...(old ? {} : { newSpelling: true }) };
  }
  const w = parseWeightCell(t, num);
  return w == null ? null : { weight: w, perKg, kind: 'single', from: null };
}

/** "İlave 0,5kg" / "Additional 0.5 kg" → adım (0,5); değilse null. */
export function parseStepLabel(text: string, num: NumberReader = trReader): number | null {
  return parseStepRule(text, num)?.step ?? null;
}

const STEP_UNIT = /(?:kgs?|lbs?|desi|ds)\b\.?/.source;
const STEP_N = /(\d+(?:[.,]\d+)?)/.source;
const STEP_TAIL = /(?:\s*(?:icin|basi|basina|ucreti))?\.?/.source;
/** "her ilave desi", "ilave 1 desi", "her ek 0,5 kg", "each additional kg", "+1 desi" (sayısız birim = 1). */
const STEP_WORD_RE = new RegExp(String.raw`^(?:(?:her|each)\s+)?(?:ilave|ek|additional|add'?l\.?)\s*(?:her\s+)?(?:${STEP_N}\s*)?${STEP_UNIT}${STEP_TAIL}$`);
const STEP_PLUS_RE = new RegExp(String.raw`^\+\s*${STEP_N}?\s*${STEP_UNIT}${STEP_TAIL}$`);
/** "30 desi üzeri her desi için", "30 kg üstü her ilave kg", "30 desiden sonra her ilave desi", "over 30 kg each additional kg". */
const STEP_FROM_RE = new RegExp(
  String.raw`^(?:over\s+|above\s+)?${STEP_N}\s*(?:${STEP_UNIT})?\s*(?:(?:kgs?|desi|lbs?)?'?\s*(?:dan|den|tan|ten)\s*sonra|ve\s*uzeri|uzeri|ve\s*ustu|ustu|sonrasi|\+)?\s*,?\s*(?:her|each|per)\s+(?:(?:ilave|ek|additional)\s*)?(?:${STEP_N}\s*)?${STEP_UNIT}${STEP_TAIL}$`,
);

/**
 * İlave kuralı: adım ve (yazıyorsa) başlangıç ağırlığı. "İlave 0,5 kg" → { step: 0,5, from: null }; "Her ilave desi" →
 * { step: 1, from: null }; "30 desi üzeri her desi için" → { step: 1, from: 30 } (KALANLAR 1.7). Değilse null.
 */
export function parseStepRule(text: string, num: NumberReader = trReader): { step: number; from: number | null } | null {
  const raw = String(text ?? '').trim();
  const old = STEP_RE.exec(raw);
  if (old) {
    const v = num(old[1]!);
    return v != null && v > 0 ? { step: v, from: null } : null;
  }
  const n = norm(raw).replace(/\s+/g, ' ');
  const word = STEP_WORD_RE.exec(n) ?? STEP_PLUS_RE.exec(n);
  if (word) {
    const v = word[1] ? num(word[1]) : 1;
    return v != null && v > 0 ? { step: v, from: null } : null;
  }
  const from = STEP_FROM_RE.exec(n);
  if (from) {
    const f = num(from[1]!);
    const v = from[2] ? num(from[2]) : 1;
    return f != null && f > 0 && v != null && v > 0 ? { step: v, from: f } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sayı biçimi (01-B6)

const NUM_TOKEN = /\d[\d.,]*\d|\d/g;
const STRONG_EN = /^\d{1,3}(,\d{3})+\.\d+$/;
const STRONG_TR = /^\d{1,3}(\.\d{3})+,\d+$/;
/** Tek ayırıcı ve ardından 1–2 ya da 4+ hane, ya da tam kısmı 0 ("0.500": binlik olamaz). */
const WEAK_EN = /^(?:\d+\.(?:\d{1,2}|\d{4,})|0\.\d+)$/;
const WEAK_TR = /^(?:\d+,(?:\d{1,2}|\d{4,})|0,\d+)$/;
/** Saat ("09.00", "18:30"), tarih, yüzde: kanıt sayılmaz (tarife PDF'indeki kuralla aynı). */
const NOT_EVIDENCE = /[:/%]|^\s*0\d[.,]\d{2}\s*$/;
/** Güçlü kanıt yokken zayıf kanıtla biçim seçmek için en az bu kadar sayı (karşı kanıt hiç yokken). */
export const TABLE_NUMBER_FORMAT_MIN_WEAK = 3;

export type TableNumberFormat = { format: NumberFormat; certain: boolean; strong: { en: number; tr: number }; weak: { en: number; tr: number } };

/**
 * Tarife tablosunun sayı biçimi, yalnız ağırlık ve fiyat hücrelerinin sayılarından (01-B6). Kural tarife PDF'indeki
 * `cellNumberFormat` (Y27) ile aynı: güçlü kanıt iki ayırıcılı sayı ("1.234,56" / "1,234.56"); zayıf kanıt tek ayırıcı ve
 * ardından 1–2 hane ("12,50" / "12.50"), 4+ hane ya da tam kısmı 0 ("0.500"); tek ayırıcı ve tam 3 hane ("1.250", "1,125")
 * kanıt değildir (iki biçimde de geçerli).
 * - güçlü kanıt tek yönde, karşı yönde hiç kanıt yok → o biçim, `certain`;
 * - güçlü kanıt yok, zayıf kanıt tek yönde en az `TABLE_NUMBER_FORMAT_MIN_WEAK` → o biçim, kesin değil;
 * - diğer her durum `auto`: eski okuma (`parseTrNumber`).
 */
export function tableNumberFormat(cells: Iterable<string>): TableNumberFormat {
  const strong = { en: 0, tr: 0 };
  const weak = { en: 0, tr: 0 };
  for (const c of cells) {
    if (!c || NOT_EVIDENCE.test(c)) continue;
    for (const m of c.matchAll(NUM_TOKEN)) {
      const b = m[0];
      if (STRONG_EN.test(b)) strong.en++;
      else if (STRONG_TR.test(b)) strong.tr++;
      else if (WEAK_EN.test(b)) weak.en++;
      else if (WEAK_TR.test(b)) weak.tr++;
    }
  }
  let format: NumberFormat = 'auto';
  let certain = false;
  if (strong.en > 0 && strong.tr === 0 && weak.tr === 0) [format, certain] = ['en', true];
  else if (strong.tr > 0 && strong.en === 0 && weak.en === 0) [format, certain] = ['tr', true];
  else if (strong.en === 0 && strong.tr === 0) {
    if (weak.en >= TABLE_NUMBER_FORMAT_MIN_WEAK && weak.tr === 0) format = 'en';
    else if (weak.tr >= TABLE_NUMBER_FORMAT_MIN_WEAK && weak.en === 0) format = 'tr';
  }
  return { format, certain, strong, weak };
}

/** İki türlü okunan sayı: tek ayırıcı ve ardından tam 3 hane, tam kısım 1–999 ("1,250" / "1.500"; "0,125" belirsiz değil). */
const AMBIGUOUS_TOKEN = /^[1-9]\d{0,2}[.,]\d{3}$/;
const hasAmbiguousNumber = (s: string) => !NOT_EVIDENCE.test(s) && [...s.matchAll(NUM_TOKEN)].some((m) => AMBIGUOUS_TOKEN.test(m[0]));

/** Biçimle sayı: `en` → `parseNumberAs(…, 'en')` ("1,250" → 1250, "1.500" → 1,5); `tr`/`auto` → `parseTrNumber` (eski okuma). */
export function numberReader(format: NumberFormat): NumberReader {
  return format === 'en' ? (s) => parseNumberAs(s, 'en') : trReader;
}

/**
 * Açık uçlu satır ("31+ | 8", "30 desi üzeri | 8") "kg başı" işareti olmadan (01-B12, KALANLAR 1.7). Fiyat önceki sabit
 * satırın dörtte birinden azsa sabit fiyat olağan değildir (30 desi 195 TL iken 31 desi üstü her koli 8 TL):
 * - Varsayılan okuma "her ilave birim" (`additional`): son satırın fiyatı + her ilave desi/kg × fiyat (35 desi = 195 + 5 × 8
 *   = 235). Türk taşıyıcıların 30 desi üstü fiyatı böyledir; "fiyat × toplam desi" (280) sınırda sıçrar (195 → 248). İki
 *   okumanın farkı her ağırlıkta aynıdır (fiyat × son ağırlık − son fiyat); kg başı okuması olağansa fark küçüktür.
 * - Başlangıç tablonun son satırına uymuyorsa ("50+" ama tablo 30'da bitiyor; "30 üzeri" ve "31+" uyar) okunmaz, sorulur.
 * - `mode` (kişinin seçimi, `openBandMode`) okumayı belirler.
 * Diğer durumlar sabit fiyat (eski okuma). PDF yolu açık uçlu satırı "kg başı" etiketiyle yazar (`pdfScan`); bu kural ona
 * dokunmaz.
 */
export function openBandReading(
  price: number,
  prevPrice: number | null | undefined,
  from: number | null | undefined,
  prevWeight?: number | null,
  mode?: OpenBandMode,
  extra: { slope?: number | null; strict?: boolean } = {},
): 'flat' | 'perKg' | 'additional' | 'unclear' {
  return readOpenBand(price, prevPrice, from, prevWeight, mode, extra).reading;
}

/**
 * `openBandReading` ve sorulma nedeni. extra.slope: bölgenin son iki sabit satırının birim artışı (yoksa son fiyat / son
 * ağırlık); ilave fiyatı bunun yarısından azsa (30 desi 195 iken "31+ | 1") sorulur. extra.strict: etiket yeni tanınan
 * yazımlardan ("> 30", "30+ desi", "31-∞", "31 ve üstü"); fiyat önceki satırın %25–%100'ü arasındaysa sabit okunmaz, sorulur
 * (eski "31+" yazımı eskisi gibi sabit). Kişinin seçimi (`mode`, 'flat' dahil) sorulan satırlarda da geçerlidir.
 */
export function readOpenBand(
  price: number,
  prevPrice: number | null | undefined,
  from: number | null | undefined,
  prevWeight?: number | null,
  mode?: OpenBandMode,
  extra: { slope?: number | null; strict?: boolean } = {},
): { reading: 'flat' | 'perKg' | 'additional' | 'unclear'; why?: OpenBandWhy } {
  if (prevPrice == null || !(prevPrice > 0) || !(price > 0)) return { reading: 'flat' };
  const low = price < prevPrice * 0.25;
  const cheaper = !low && !!extra.strict && price < prevPrice;
  if (!low && !cheaper) return { reading: 'flat' };
  if (mode) return { reading: mode };
  if (cheaper) return { reading: 'unclear', why: 'cheaper' };
  if (prevWeight != null && from != null && from > 0) {
    const f = grams(from);
    const last = grams(prevWeight);
    if (f < last || f > last + 1000) return { reading: 'unclear', why: 'start' };
  }
  if (extra.slope != null && extra.slope > 0 && price < extra.slope * 0.5) return { reading: 'unclear', why: 'price' };
  return { reading: 'additional' };
}

function kindOf(raw: string): ImportSurcharge['kind'] | null {
  const k = norm(raw).replace(/[\s_-]/g, '');
  if (['fixed', 'sabit', 'tutar'].includes(k)) return 'FIXED';
  if (['pct', 'percent', 'yuzde', '%'].includes(k)) return 'PCT';
  if (['perkg', 'kgbasi', 'kg', 'kilogram'].includes(k)) return 'PER_KG';
  return null;
}

function short(s: string, n = 60) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Ham dosyayı seçeneklerle okur. Seçenekler (lb→kg, para birimi) okumanın parçasıdır; kontroller sonuca bakar. */
export function parseTariffImport(raw: RawTariffFile, options: TariffImportOptions = {}): ParsedTariffImport {
  const out: ParsedTariffImport = {
    rates: [],
    packagingRates: [],
    zones: [],
    overflow: [],
    surcharges: [],
    sheets: { prices: !!raw.prices, zones: !!raw.zones, surcharges: !!raw.surcharges },
    kind: raw.kind,
    priceZones: [],
    zoneRenames: [],
    duplicateZones: [],
    skipped: [],
    invalidPrices: [],
    duplicates: [],
    sheetIssues: [],
    titleLines: [],
    extraTables: [],
    headerRow: null,
    weightHeader: '',
    detectedWeightUnit: null,
    detectedCurrency: null,
    discountPct: null,
    pakDiscountPct: null,
    envelopeDiscountPct: null,
    discountIssue: null,
    unitEvidence: [],
    currencyEvidence: [],
    applied: {
      convertLbToKg: !!options.convertLbToKg,
      currency: options.currency?.trim().toUpperCase() || null,
      ...(options.numberFormat && raw.kind !== 'pdf' ? { numberFormat: options.numberFormat } : {}),
      ...(options.discountUnit ? { discountUnit: options.discountUnit } : {}),
      ...(options.openBandMode ? { openBandMode: options.openBandMode } : {}),
    },
    numberFormat: { format: 'auto', certain: false, chosen: false },
    numberAmbiguities: [],
    discountChoice: null,
    openBands: [],
    unreadableOpenBands: [],
    stepConflicts: [],
    stepExpansions: [],
    stepIssues: [],
    stepMismatches: [],
    perKgTitles: [],
  };
  if (raw.prices) parsePriceSheet(raw.prices, out, { numeric: raw.pricesNumeric, percent: raw.pricesPercent, options });
  if (raw.kind === 'pdf' && out.detectedCurrency) out.currencyEvidence = [`belgedeki fiyatlar ${out.detectedCurrency}`];
  if (raw.zones) parseZonesSheet(raw.zones, out);
  if (raw.surcharges) parseSurchargesSheet(raw.surcharges, out);

  if (options.convertLbToKg) {
    for (const r of out.rates) {
      if (r.weightUpto < OPEN_WEIGHT) r.weightUpto = round3(r.weightUpto * LB_TO_KG);
      if (r.perKg) r.price = round2(r.price / LB_TO_KG);
    }
    // Pak / Zarf: sabit fiyat, yalnız ağırlık çevrilir ("Envelope up to 8 oz" = 0,5 lb → 0,227 kg)
    for (const r of out.packagingRates) if (r.weightUpto < OPEN_WEIGHT) r.weightUpto = round3(r.weightUpto * LB_TO_KG);
    // "İlave X lb" aşımı: tutar X lb başınadır ve öyle kalır; birim X lb'nin kg karşılığı (01-B5). Kg başına çevirip 1 kg
    // basamakla saymak taşıyıcının lb yuvarlamasını kaybederdi (6,536 kg = 14,41 lb → 15 lb; kg başı 2 kg sayılırdı).
    // Birimi yazmayan "Aşım" satırı null kalır (OVERFLOW_UNIT_MISSING söyler; birim 1 lb sayılır, `lbWeightSteps`).
    if (out.overflowStep != null) out.overflowStep = out.overflowStep * LB_TO_KG;
  }
  dedupeRates(out);
  return out;
}

const isDiscountHeader = (h: string) => /^(indirim|iskonto|discount)\b/.test(h.trim().replace(/[İI]/g, 'i').toLowerCase());

type DiscountCell = { text: string; numeric: boolean; percent: boolean };

/**
 * Tek oran beklenir. "38", "%38", "38,5" ve Excel yüzde hücresi (0,38 → %38) kabul edilir. Biçimsiz 0–1 arası değer
 * (01-B12) iki türlü okunur: eski şablon oranı olduğu gibi yazıyordu (0,5 = %0,5), Excel'de 0,5 yazıp yüzde demek de
 * olur (%50). `discountUnit` seçilmediyse sorulur (`discountChoice`, DISCOUNT_UNCLEAR).
 */
function readDiscountColumn(cells: DiscountCell[], out: ParsedTariffImport, unit: 'percent' | 'ratio' | undefined) {
  const r = readDiscountValues(cells, out, unit);
  if (r.issue) out.discountIssue = r.issue;
  else if (r.pct != null) out.discountPct = r.pct;
}

/** `readDiscountColumn` okuması: tek değer, sorun ya da (biçimsiz 0–1 değer yanıtlanmadıysa) ikisi de yok. */
function readDiscountValues(
  cells: DiscountCell[],
  out: ParsedTariffImport,
  unit: 'percent' | 'ratio' | undefined,
): { pct: number | null; issue: ParsedTariffImport['discountIssue'] } {
  const seen = new Map<number, string>();
  const invalid: string[] = [];
  let unclear = false;
  for (const cell of cells) {
    const text = cell.text.trim();
    if (!text) continue;
    const hasPct = text.includes('%');
    const value = cell.numeric ? numericCellValue(text) : parseTrNumber(text.replace('%', '').trim());
    // Excel yüzde hücresi: değer orandır (0,38 = %38; 0,005 = %0,5)
    const n = value != null && cell.percent && !hasPct ? Math.round(value * 1000000) / 10000 : value;
    if (n == null || n < 0 || n > 100) {
      invalid.push(text);
      continue;
    }
    if (!hasPct && !cell.percent && n > 0 && n < 1) {
      const choice = { text, asPercent: n, asRatio: Math.round(n * 1000000) / 10000 };
      out.discountChoice ??= choice;
      if (!unit) {
        unclear = true;
        continue;
      }
      seen.set(unit === 'ratio' ? choice.asRatio : choice.asPercent, text);
      continue;
    }
    seen.set(n, text);
  }
  if (invalid.length) return { pct: null, issue: { kind: 'invalid', values: invalid.slice(0, 3) } };
  // biçimsiz 0–1 değer yanıtlanmadı: indirim yok sayılmaz, DISCOUNT_UNCLEAR sorar (discountPct null kalır)
  if (unclear) return { pct: null, issue: null };
  if (seen.size > 1) return { pct: null, issue: { kind: 'mixed', values: [...seen.values()].slice(0, 3) } };
  return { pct: seen.size === 1 ? [...seen.keys()][0]! : null, issue: null };
}

/**
 * İndirim sütunu, satırın ambalajına göre: kendi ambalajı satırları tarifenin indirimi (`discountPct`), Pak / Zarf
 * satırları ayrı (`pakDiscountPct` / `envelopeDiscountPct`; kendi ambalajıyla aynıysa null). Pak / Zarf hücreleri
 * kendi içinde farklı ya da bozuksa indirim sorunu olur (MIXED_DISCOUNT / INVALID_DISCOUNT): yanlış indirimle
 * sessizce hesaplanmasın.
 */
function readDiscountColumns(
  cells: (DiscountCell & { packaging: Packaging | 'SKIP' })[],
  out: ParsedTariffImport,
  unit: 'percent' | 'ratio' | undefined,
) {
  readDiscountColumn(cells.filter((c) => c.packaging === 'OWN'), out, unit);
  for (const p of ['PAK', 'ENVELOPE'] as const) {
    const own = cells.filter((c) => c.packaging === p);
    if (!own.length) continue;
    const r = readDiscountValues(own, out, unit);
    if (r.issue) {
      out.discountIssue ??= { kind: r.issue.kind, values: r.issue.values.map((v) => `${p === 'PAK' ? 'Pak' : 'Zarf'}: ${v}`) };
      continue;
    }
    if (r.pct == null || r.pct === out.discountPct) continue;
    if (p === 'PAK') out.pakDiscountPct = r.pct;
    else out.envelopeDiscountPct = r.pct;
  }
}

type PriceSheetContext = { numeric?: CellMask; percent?: CellMask; options: TariffImportOptions };

function parsePriceSheet(sheet: RawSheet, out: ParsedTariffImport, ctx: PriceSheetContext) {
  const rows = Array.from({ length: sheet.length }, (_, i) => cellsOf(sheet[i]));
  let headerIdx = rows.findIndex((c) => c.filter((x) => x !== '').length >= 2);
  if (headerIdx < 0) headerIdx = rows.findIndex((c) => !isEmptyRow(c));
  if (headerIdx < 0) return;
  out.headerRow = headerIdx + 1;
  for (let i = 0; i < headerIdx; i++) {
    const t = rows[i]!.filter((x) => x !== '').join(' ');
    if (t) out.titleLines.push(t);
  }
  const header = rows[headerIdx]!;
  out.weightHeader = header[0] ?? '';
  const zoneCols: { zone: string; i: number }[] = [];
  const seenKeys = new Set<string>();
  let discountCol: number | null = null;
  for (let i = 1; i < header.length; i++) {
    const h = header[i]!;
    if (!h) continue;
    // Bölge değil: tarifenin indirimi. Bölge sanılsa fiyat satırı gibi okunurdu. Satırların ambalajı belli olunca okunur.
    if (isDiscountHeader(h)) {
      discountCol = i;
      continue;
    }
    // yurt içi mesafe sütunu ("Şehir içi", "Kısa Mesafe") PDF'teki gibi kısa koda ("SEHIRICI", "KISA");
    // "Bölge içi" de "içi"ye kısalmaz
    const label = distanceZoneCode(h) ?? cleanZoneLabel(h);
    if (label !== h) out.zoneRenames.push({ from: h, to: label });
    const k = zoneKey(label);
    if (seenKeys.has(k)) {
      out.duplicateZones.push(label);
      continue;
    }
    seenKeys.add(k);
    zoneCols.push({ zone: label, i });
  }
  out.priceZones = zoneCols.map((z) => z.zone);

  // Birim / para birimi kanıtları
  const unitCells: string[] = [out.weightHeader];
  const currencyCount = new Map<string, number>();
  const bumpCurrency = (text: string, n = 1) => {
    const c = currencyOf(text);
    if (c) currencyCount.set(c, (currencyCount.get(c) ?? 0) + n);
  };
  for (const h of header) bumpCurrency(h);

  // Sayı biçimi (01-B6): metin hücreleri dosyanın biçimiyle okunur. XLSX'in gerçek sayı hücreleri biçimden bağımsızdır
  // (`numericCellValue`) ve kanıt sayılmaz. PDF taslağının hücreleri kodla yazılmıştır: eski okuma, tespit yok.
  const isNum = (r: number, i: number) => maskHas(ctx.numeric, r, i);
  const chosen = out.kind !== 'pdf' ? (ctx.options.numberFormat ?? null) : null;
  let detected: TableNumberFormat | null = null;
  if (out.kind !== 'pdf' && !chosen) {
    const evidence: string[] = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const c = rows[r]!;
      const zoneCells = zoneCols.filter((z) => (c[z.i] ?? '') !== '');
      if (!zoneCells.length) continue;
      if (c[0] && !isNum(r, 0)) evidence.push(c[0]);
      for (const z of zoneCells) if (!isNum(r, z.i)) evidence.push(c[z.i]!);
    }
    detected = tableNumberFormat(evidence);
  }
  const format: NumberFormat = chosen ?? detected?.format ?? 'auto';
  out.numberFormat = { format, certain: !!chosen || !!detected?.certain, chosen: !!chosen };
  const textNum = numberReader(format);
  const enNum = numberReader('en');
  const watch = out.kind !== 'pdf' && !out.numberFormat.certain;
  const noteNumber = (row: number, zone: string | null, text: string, tr: number | null | undefined, en: number | null | undefined, used: number) => {
    if (tr == null || en == null || tr === en) return;
    // biçim belirsiz: iki türlü okunan sayı; biçim zayıf kanıtla seçildi: eski okumadan farklı okunan sayı
    if (format === 'auto' ? !hasAmbiguousNumber(text) : used === tr) return;
    out.numberAmbiguities.push({ row, zone, text: short(text, 30), tr, en, used });
  };
  const readNumber = (text: string, r: number, i: number, zone: string): number | null => {
    if (isNum(r, i)) return numericCellValue(text);
    const v = textNum(text);
    if (watch && v != null) noteNumber(r + 1, zone, text, parseTrNumber(text), enNum(text), v);
    return v;
  };
  const readWeight = (text: string, r: number): WeightLabel | null => {
    if (isNum(r, 0)) return parseWeightLabel(text, numericCellValue);
    const label = parseWeightLabel(text, textNum);
    if (watch && label) noteNumber(r + 1, null, text, parseWeightLabel(text)?.weight, parseWeightLabel(text, enNum)?.weight, label.weight);
    return label;
  };
  /** Açık uçlu satır kuralı için: bölgenin son sabit fiyatlı satırı (01-B12). */
  const lastFlat = new Map<string, { weight: number; price: number; before?: { weight: number; price: number } }>();
  /** Bölgenin son iki sabit satırının birim artışı; yoksa son fiyat / son ağırlık (açık uç fiyat denetimi, KALANLAR 1.7). */
  const slopeOf = (p: { weight: number; price: number; before?: { weight: number; price: number } }) =>
    p.before && p.weight > p.before.weight && p.price > p.before.price ? (p.price - p.before.price) / (p.weight - p.before.weight) : p.weight > 0 ? p.price / p.weight : null;

  let ended = false;
  let lastTitle = '';
  let prevWasTitle = false;
  let perKgMode = false;
  const steps: StepRule[] = [];
  /**
   * Pak / Zarf ara başlığı ("Envelope", "FedEx Pak", "Zarf/Pak (0,5 - 2,5 kg)") altındaki satırlar o ambalajın fiyatıdır;
   * "Diğer ambalaj" / "Your Packaging" başlığı kendi ambalajına döner. UNCLEAR: hangisi olduğu belli değil (ortak başlık
   * ya da Pak / Zarf / belge bölümünden sonra tanınmayan başlık) → satırlar alınmaz, uyarıda gösterilir. DOCUMENT: belge
   * ("Documents") bölümü → satırlar alınmaz, uyarıda gösterilir.
   */
  let packMode: SpecialPackaging | 'UNCLEAR' | 'DOCUMENT' | null = null;
  /** Satırın ambalajı (İndirim sütunu için); SKIP: alınmayan Pak / Zarf satırı. Yoksa kendi ambalajı. */
  const rowPackaging = new Map<number, Packaging | 'SKIP'>();
  /** Etiketin kendi birimi ("8 oz", "1 lb"): tablonun birimi belli olunca çevrilir. */
  const labelUnits = new Map<ImportPackagingRate, WeightUnitWord>();
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const c = rows[r]!;
    if (isEmptyRow(c)) continue;
    const rowNo = r + 1;
    const first = c[0] ?? '';
    const rest = c.slice(1);
    const restEmpty = rest.every((x) => x === '');
    const titleOnly = restEmpty && parseWeightLabel(first) == null;
    const repeatHeader = !!first && norm(first) === norm(out.weightHeader) && rest.some((x) => x !== '' && parseTrNumber(x) == null);
    if (ended) {
      if (repeatHeader) out.extraTables.push({ row: rowNo, title: lastTitle || first });
      if (titleOnly && first && !prevWasTitle) lastTitle = first;
      prevWasTitle = titleOnly;
      out.skipped.push({ row: rowNo, reason: t('tr', 'import.reason.afterFirstTable'), text: short(first || rest.find((x) => x) || '') });
      continue;
    }
    if (titleOnly && first) {
      // ambalaj bölümü başlığı tabloyu bitirmez (kendi ambalajı başlığı da: "Pak dahil tüm gönderiler" tablonun ortasında)
      const sec = packagingTitle(first);
      if (sec != null) {
        packMode = sec === 'OWN' ? null : sec;
        if (!out.rates.length && !out.packagingRates.length && !out.overflow.length) {
          out.titleLines.push(first);
          out.skipped.push({ row: rowNo, reason: t('tr', 'import.reason.descriptionRow'), text: short(first) });
        }
        continue;
      }
    }
    if (!ended && titleOnly && out.rates.length && PER_KG_RE.test(first)) {
      // "Kg başına ücret (toplam gönderi ağırlığıyla çarpınız)" → sonraki satırlar kg başı bant; tablo bitmez
      perKgMode = true;
      packMode = null;
      out.perKgTitles.push({ row: rowNo, title: short(first, 80) });
      continue;
    }
    if (titleOnly && packMode != null) {
      // Pak / Zarf / belge bölümünden sonra ne olduğu tanınmayan başlık: sonraki satırlar alınmaz, uyarıda gösterilir
      packMode = 'UNCLEAR';
      out.skipped.push({ row: rowNo, reason: t('tr', 'import.reason.descriptionRow'), text: short(first) });
      continue;
    }
    if ((out.rates.length || out.overflow.length) && (titleOnly || repeatHeader)) {
      ended = true;
      lastTitle = titleOnly ? first : '';
      prevWasTitle = titleOnly;
      if (repeatHeader) out.extraTables.push({ row: rowNo, title: first });
      out.skipped.push({ row: rowNo, reason: t('tr', 'import.reason.afterFirstTable'), text: short(first) });
      continue;
    }
    if (titleOnly) {
      out.titleLines.push(first);
      out.skipped.push({ row: rowNo, reason: t('tr', 'import.reason.descriptionRow'), text: short(first) });
      continue;
    }
    unitCells.push(first);
    for (const z of zoneCols) bumpCurrency(c[z.i] ?? '');
    // Pak / Zarf satırı: etiketinden ("FedEx Pak 1 lb", "Envelope up to 8 oz") ya da Pak / Zarf bölümünde
    const pl = isNum(r, 0) ? null : parsePackagingLabel(first, textNum);
    const rowPack = pl ? (pl.packaging ?? 'UNCLEAR') : packMode;
    if (rowPack != null) {
      let weight: number | null = null;
      let unit: WeightUnitWord | null = null;
      if (pl) {
        // ağırlık yazmayan zarf / poşet ("UPS Express Envelope", "Dosya"): tek fiyat, taşıyıcının sınırına kadar her ağırlık
        weight = pl.anyWeight ? OPEN_WEIGHT : pl.weight;
        unit = pl.unit;
      } else {
        const wl = readWeight(first, r);
        // Pak / Zarf sabit fiyattır: tek ağırlık ya da aralığın üstü; açık uç, kg başı ya da ilave satırı okunmaz
        weight = wl && (wl.kind === 'single' || wl.kind === 'range') && !wl.perKg ? wl.weight : null;
      }
      if (rowPack === 'UNCLEAR' || rowPack === 'DOCUMENT' || weight == null || !(weight > 0)) {
        // fiyatı tahmin edilmez: alınmaz, SKIPPED_ROWS uyarısında gösterilir
        rowPackaging.set(r, 'SKIP');
        const reason =
          rowPack === 'UNCLEAR' ? 'import.reason.packageUnclear' : rowPack === 'DOCUMENT' ? 'import.reason.documentRow' : 'import.reason.packageNoWeight';
        out.skipped.push({ row: rowNo, reason: t('tr', reason), text: short(first) });
        continue;
      }
      rowPackaging.set(r, rowPack);
      for (const z of zoneCols) {
        const cell = c[z.i] ?? '';
        if (cell === '' || cell === '-' || cell === '—') continue;
        const price = readNumber(cell, r, z.i, z.zone);
        if (price == null || price < 0) {
          out.invalidPrices.push({ row: rowNo, zone: z.zone, text: short(cell, 30) });
          continue;
        }
        const rate: ImportPackagingRate = { zone: z.zone, weightUpto: weight, price, row: rowNo, packaging: rowPack };
        out.packagingRates.push(rate);
        if (unit) labelUnits.set(rate, unit);
      }
      continue;
    }
    const n = norm(first);
    if (n.startsWith('asim') || n.startsWith('overflow')) {
      for (const z of zoneCols) {
        const cell = c[z.i] ?? '';
        const v = cell === '' ? null : readNumber(cell, r, z.i, z.zone);
        if (v != null && v >= 0) out.overflow.push({ zone: z.zone, perUnit: v });
      }
      // "Aşım (kg başı)", "her ilave 0,5 kg" → tutarın basamağı; yazmıyorsa null (mevcut tarifenin son basamağı)
      out.overflowRow = { row: rowNo, label: short(first, 60) };
      out.overflowStep = overflowUnitStep(first);
      continue;
    }
    const rule = isNum(r, 0) ? null : parseStepRule(first, textNum);
    if (rule != null) {
      for (const z of zoneCols) {
        const cell = c[z.i] ?? '';
        if (cell === '' || cell === '-' || cell === '—') continue;
        const v = readNumber(cell, r, z.i, z.zone);
        if (v == null || v < 0) {
          out.invalidPrices.push({ row: rowNo, zone: z.zone, text: short(cell, 30) });
          continue;
        }
        steps.push({ zone: z.zone, step: rule.step, amount: v, row: rowNo, from: rule.from });
      }
      continue;
    }
    const label = readWeight(first, r);
    const weight = label?.weight ?? null;
    if (label == null || weight == null || weight <= 0) {
      // açık uç ya da ilave satırına benziyor, fiyatı var ama okunamadı ("30 desi sonrası beher"): tahmin edilmez, sorulur
      if (first && !PACKAGE_RE.test(first) && isOpenish(norm(first)) && zoneCols.some((z) => (c[z.i] ?? '') !== '' && readNumber(c[z.i]!, r, z.i, z.zone) != null)) {
        out.unreadableOpenBands.push({ row: rowNo, label: short(first, 40) });
        continue;
      }
      const reason = PACKAGE_RE.test(first)
        ? t('tr', 'import.reason.packageRow')
        : first
          ? t('tr', 'import.reason.weightUnreadable')
          : t('tr', 'import.reason.weightEmpty');
      out.skipped.push({ row: rowNo, reason, text: short(first) });
      continue;
    }
    for (const z of zoneCols) {
      const cell = c[z.i] ?? '';
      if (cell === '' || cell === '-' || cell === '—') continue;
      const price = readNumber(cell, r, z.i, z.zone);
      if (price == null || price < 0) {
        out.invalidPrices.push({ row: rowNo, zone: z.zone, text: short(cell, 30) });
        continue;
      }
      let perKg = label.perKg || perKgMode;
      const zk = zoneKey(z.zone);
      if (!perKg && label.kind === 'open') {
        // "31+ | 8" işaretsiz açık uç: fiyat önceki satırdan çok düşükse her ilave birim (aşım fiyatı) ya da sorulur
        // (01-B12, KALANLAR 1.7); kişi "kg başı" seçerse fiyat × toplam ağırlık
        const prev = lastFlat.get(zk);
        const mode = ctx.options.openBandMode;
        const { reading, why } = readOpenBand(price, prev?.price, label.from, prev?.weight, mode, {
          slope: prev ? slopeOf(prev) : null,
          // önceki satırdan ucuz sabit fiyat her yazımda sorulur (eski "31+" dahil; inceleme bulgusu)
          strict: true,
        });
        if (reading !== 'flat') {
          out.openBands.push({
            row: rowNo,
            zone: z.zone,
            label: short(first, 40),
            price,
            prevPrice: prev!.price,
            prevWeight: prev!.weight,
            from: label.from ?? 0,
            reading,
            chosen: !!mode,
            ...(why ? { why } : {}),
          });
          if (reading === 'perKg') perKg = true;
          else {
            // ilave: son satırdan sonraki "İlave 1" kuralı gibi aşım fiyatı olur (expandSteps); okunamayan satır alınmaz
            if (reading === 'additional') steps.push({ zone: z.zone, step: 1, amount: price, row: rowNo, from: null, open: true });
            continue;
          }
        }
      }
      if (!perKg && weight < OPEN_WEIGHT) {
        const prev = lastFlat.get(zk);
        if (!prev || weight > prev.weight) lastFlat.set(zk, { weight, price, ...(prev ? { before: { weight: prev.weight, price: prev.price } } : {}) });
        else if (weight === prev.weight) lastFlat.set(zk, { ...prev, price });
      }
      out.rates.push({ zone: z.zone, weightUpto: weight, price, row: rowNo, ...(perKg ? { perKg: true } : {}) });
    }
  }
  expandSteps(steps, out);
  if (discountCol != null) {
    const col = discountCol;
    const cells = rows.slice(headerIdx + 1).map((c, k) => ({
      text: c[col] ?? '',
      numeric: maskHas(ctx.numeric, headerIdx + 1 + k, col),
      percent: maskHas(ctx.percent, headerIdx + 1 + k, col),
      packaging: rowPackaging.get(headerIdx + 1 + k) ?? ('OWN' as const),
    }));
    readDiscountColumns(cells, out, ctx.options.discountUnit);
  }

  // Ağırlık birimi: önce ağırlık sütunu + başlık, sonra üst başlıklar
  const lbCells = unitCells.filter((t) => LB_RE.test(t));
  const kgCells = unitCells.filter((t) => KG_RE.test(t));
  const titles = [...out.titleLines, ...out.extraTables.map((t) => t.title)];
  if (lbCells.length) {
    out.detectedWeightUnit = 'lb';
    out.unitEvidence.push(...lbCells.slice(0, 3).map((t) => `"${short(t, 40)}"`));
  } else if (kgCells.length) {
    out.detectedWeightUnit = 'kg';
    out.unitEvidence.push(...kgCells.slice(0, 3).map((t) => `"${short(t, 40)}"`));
  } else {
    const lbT = titles.filter((t) => LB_RE.test(t));
    const kgT = titles.filter((t) => KG_RE.test(t));
    if (lbT.length) {
      out.detectedWeightUnit = 'lb';
      out.unitEvidence.push(...lbT.slice(0, 2).map((t) => `"${short(t, 60)}"`));
    } else if (kgT.length) {
      out.detectedWeightUnit = 'kg';
      out.unitEvidence.push(...kgT.slice(0, 2).map((t) => `"${short(t, 60)}"`));
    }
  }
  // Pak / Zarf etiketinin kendi birimi tablonun birimine ("8 oz" lb tablosunda 0,5 lb; kg tablosunda 0,227 kg)
  const tableUnit = out.detectedWeightUnit === 'lb' ? 'lb' : 'kg';
  for (const [rate, unit] of labelUnits) rate.weightUpto = packagingWeightIn(rate.weightUpto, unit, tableUnit);
  for (const t of out.titleLines) bumpCurrency(t);
  const best = [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    out.detectedCurrency = best[0];
    out.currencyEvidence.push(t('tr', 'import.reason.currencyEvidence', { count: best[1], currency: best[0] }));
  }
}

const grams = (kg: number) => Math.round(kg * 1000);

/**
 * İlave kuralı satırı (bölge başına). from: etiketin yazdığı başlangıç ("30 desi üzeri her desi" → 30). open: işaretsiz açık
 * uçlu satırın ilave okuması ("31+ | 8"); kullanılamazsa satır `openBands`'te belirsiz olur (sorulur).
 */
type StepRule = { zone: string; step: number; amount: number; row: number; from: number | null; open?: boolean };

/**
 * "İlave X kg" kuralları: kuraldan önceki son açık (sabit) satır ile sonraki ilk açık satır arasındaki
 * her X kg için önceki fiyat + k × tutar. Açık satırların değerleri olduğu gibi kalır.
 */
function expandSteps(steps: StepRule[], out: ParsedTariffImport) {
  if (!steps.length) return;
  const generated: ImportRate[] = [];
  for (const s of steps) {
    const flat = out.rates.filter((r) => !r.perKg && zoneKey(r.zone) === zoneKey(s.zone));
    const prev = flat.filter((r) => r.row < s.row).sort((a, b) => b.row - a.row)[0];
    const next = flat.filter((r) => r.row > s.row).sort((a, b) => a.row - b.row)[0];
    if (s.open) {
      // açık uç yalnız tablonun sonunda ve bölgenin başka aşım fiyatı yokken aşım fiyatıdır; değilse sorulur
      const later = out.rates.some((r) => zoneKey(r.zone) === zoneKey(s.zone) && r.row > s.row);
      const existing = out.overflow.find((o) => zoneKey(o.zone) === zoneKey(s.zone));
      const stepOk = out.overflowStep == null || grams(out.overflowStep) === grams(s.step);
      // aynı tutar ve basamakla önce yazılmış kural ("Her ilave desi | 8", sonra "31+ | 8") aynı şeyi söyler: sorun yok
      if (prev && !next && !later && existing && stepOk && round2(existing.perUnit) === round2(s.amount)) continue;
      const taken = !!existing;
      if (prev && !next && !later && !taken && stepOk) {
        out.overflow.push({ zone: s.zone, perUnit: s.amount });
        out.overflowStep = s.step;
      } else {
        const band = out.openBands.find((b) => b.row === s.row && zoneKey(b.zone) === zoneKey(s.zone));
        if (band) {
          band.reading = 'unclear';
          band.why = taken || !stepOk ? 'conflict' : 'start';
        }
      }
      continue;
    }
    const conflict = (reason: string) => out.stepConflicts.push({ row: s.row, zone: s.zone, reason });
    if (!prev) {
      out.stepIssues.push({ row: s.row, zone: s.zone, reason: t('tr', 'import.reason.stepNoPrev') });
      continue;
    }
    // "30 desi üzeri her desi": başlangıç tablonun son satırı ("30") ya da bir adım sonrası ("31") olmalı
    if (s.from != null && (grams(s.from) < grams(prev.weightUpto) || grams(s.from) > grams(prev.weightUpto) + grams(s.step))) {
      conflict(t('tr', 'import.reason.stepFrom', { from: numText(s.from, 'tr'), last: numText(prev.weightUpto, 'tr') }));
      continue;
    }
    if (!next) {
      // son satırdan sonraki "İlave X" (ör. "30 desi üzeri her desi", "150 lb üstü her ilave lb") → aşım fiyatı
      const later = out.rates.some((r) => zoneKey(r.zone) === zoneKey(s.zone) && r.row > s.row);
      const existing = out.overflow.find((o) => zoneKey(o.zone) === zoneKey(s.zone));
      const sameStep = out.overflowStep == null || grams(out.overflowStep) === grams(s.step);
      if (!later && existing) {
        // bölgenin başka aşım kuralı ("Aşım" satırı, "31+" ya da ikinci ilave satırı): aynı tutar ve basamaksa sorun yok,
        // farklıysa hangisinin geçerli olduğu sorulur (KALANLAR 1.7 incelemesi; eskiden ilki sessizce kalırdı)
        if (sameStep && round2(existing.perUnit) === round2(s.amount)) continue;
        conflict(t('tr', 'import.reason.stepConflict', { amount: fmtNumber(existing.perUnit, 2, 'tr') }));
        continue;
      }
      // tablonun son satırı bölgelere göre farklıysa başlangıç belli değil (ör. B 20'de, A 30'da biterken "Her ilave desi")
      const tableLast = Math.max(...out.rates.filter((r) => !r.perKg && r.row < s.row && r.weightUpto < OPEN_WEIGHT).map((r) => r.weightUpto));
      if (!later && s.from == null && grams(prev.weightUpto) < grams(tableLast)) {
        conflict(t('tr', 'import.reason.stepShortZone', { last: numText(prev.weightUpto, 'tr'), max: numText(tableLast, 'tr') }));
        continue;
      }
      if (!later && sameStep) {
        out.overflow.push({ zone: s.zone, perUnit: s.amount });
        out.overflowStep = s.step;
        continue;
      }
      out.stepIssues.push({ row: s.row, zone: s.zone, reason: t('tr', 'import.reason.stepNoNext') });
      continue;
    }
    const fromG = grams(prev.weightUpto);
    const toG = grams(next.weightUpto);
    const stepG = grams(s.step);
    if (toG <= fromG || stepG <= 0) {
      out.stepIssues.push({ row: s.row, zone: s.zone, reason: t('tr', 'import.reason.stepOrder') });
      continue;
    }
    if ((toG - fromG) / stepG > 20000) {
      out.stepIssues.push({ row: s.row, zone: s.zone, reason: t('tr', 'import.reason.stepTooWide') });
      continue;
    }
    const existing = new Set(out.rates.filter((r) => zoneKey(r.zone) === zoneKey(s.zone)).map((r) => grams(r.weightUpto)));
    let count = 0;
    let k = 1;
    for (let g = fromG + stepG; g < toG; g += stepG, k++) {
      if (existing.has(g)) continue;
      generated.push({ zone: s.zone, weightUpto: g / 1000, price: round2(prev.price + k * s.amount), row: s.row, generated: true });
      count++;
    }
    const n = (toG - fromG) / stepG;
    const expected = round2(prev.price + n * s.amount);
    if (Number.isInteger(n) && next.price > 0 && Math.abs(expected - next.price) / next.price > 0.03) {
      out.stepMismatches.push({ zone: s.zone, row: s.row, from: prev.weightUpto, to: next.weightUpto, expected, actual: next.price });
    }
    out.stepExpansions.push({ zone: s.zone, row: s.row, from: prev.weightUpto, to: next.weightUpto, step: s.step, amount: s.amount, count });
  }
  out.rates.push(...generated);
}

/** Bölgeler sayfasındaki ülke hücresi: ISO-2 ("de") ya da ISO-3 kodu ("DEU"), "*" ya da Türkçe/İngilizce ülke adı ("Almanya", "Germany"). */
function zoneSheetCountry(cell: string): string | null {
  const t = cell.trim();
  if (t === '*') return '*';
  if (/^[A-Za-z]{2}$/.test(t)) return canonicalCountryCode(t);
  // alfa-3 kod ("DEU", "gbr"): Bölgeler sayfasında 3 harfli ülke adı yok
  return iso3ToIso2(t) ?? (t ? countryNameToIso2(t) : null);
}

function parseZonesSheet(sheet: RawSheet, out: ParsedTariffImport) {
  const seen = new Map<string, string>();
  for (let r = 0; r < sheet.length; r++) {
    const c = cellsOf(sheet[r]);
    const rawCountry = c[0] ?? '';
    const zone = cleanZoneLabel(c[1] ?? '');
    if (!rawCountry && !zone) continue;
    const country = zoneSheetCountry(rawCountry);
    // ilk satır başlık ("Ülke kodu | Bölge") ise atlanır; başlıksız sayfada ilk satır da okunur
    if (r === 0 && !country) continue;
    if (!country || !zone) {
      out.sheetIssues.push({ sheet: 'zones', row: r + 1, reason: t('tr', 'import.reason.badZoneRow') });
      continue;
    }
    const prev = seen.get(country);
    if (prev != null) {
      // aynı ülke iki kez: aynı bölgeyse sessizce atlanır, farklıysa ilk satır geçerli ve uyarı verilir
      if (zoneKey(prev) !== zoneKey(zone)) {
        out.sheetIssues.push({ sheet: 'zones', row: r + 1, reason: t('tr', 'import.reason.zoneConflict', { country, zone: prev }) });
      }
      continue;
    }
    seen.set(country, zone);
    out.zones.push({ country, zone });
  }
}

function parseSurchargesSheet(sheet: RawSheet, out: ParsedTariffImport) {
  for (let r = 1; r < sheet.length; r++) {
    const [code = '', name = '', kindRaw = '', amountRaw = ''] = cellsOf(sheet[r]);
    if (!code) continue;
    const kind = kindOf(kindRaw);
    const amount = parseTrNumber(amountRaw);
    if (!kind || amount == null) {
      out.sheetIssues.push({ sheet: 'surcharges', row: r + 1, reason: t('tr', 'import.reason.badSurchargeRow') });
      continue;
    }
    out.surcharges.push({ code: code.toUpperCase(), name, kind, amount });
  }
}

function dedupeRates(out: ParsedTariffImport) {
  out.rates = dedupeList(out.rates, out);
  out.packagingRates = dedupeList(out.packagingRates, out);
}

function dedupeList<R extends ImportRate>(rates: R[], out: ParsedTariffImport): R[] {
  const groups = new Map<string, R[]>();
  for (const r of rates) {
    const k = `${r.packaging ?? 'OWN'}|${zoneKey(r.zone)}|${Math.round(r.weightUpto * 1000)}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const kept: R[] = [];
  for (const g of groups.values()) {
    kept.push(g[0]!);
    const prices = [...new Set(g.map((r) => r.price))];
    if (prices.length > 1) {
      const p = g[0]!.packaging;
      out.duplicates.push({ zone: g[0]!.zone, weightUpto: g[0]!.weightUpto, prices, rows: g.map((r) => r.row), ...(p && p !== 'OWN' ? { packaging: p } : {}) });
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Kontroller

export type TariffImportContext = {
  tariffCurrency: string;
  currentZones: { country: string; zone: string }[];
  currentRates: { zone: string; weightUpto: number; price: number; perKg?: boolean }[];
  /** Mevcut aşım fiyatları (dosyada aşım satırı yoksa korunur). */
  currentOverflow?: { zone: string; perUnit: number }[];
  /** Mevcut ek ücretler (dosyada Ek ücretler sayfası yoksa korunur). */
  currentSurcharges?: { code: string; name: string; kind: string; amount: number }[];
  /** true: yeni tarife oluşturulacak (mevcut tarife yok; karşılaştırma yapılmaz). */
  newTariff?: boolean;
  /** Taşıyıcının kapsamı yurt içi (core `carrierScope`): yalnız o zaman eşlemesiz tek bölgeye `*` eklenir (KALANLAR 1.2). */
  domestic?: boolean;
  /** Mevcut indirim: dosyada indirim yoksa bu uygulanır. */
  currentDiscountPct?: number;
  /** Mevcut ağırlık yuvarlama basamakları (içe aktarmada tablodan yeniden çıkarılır). */
  currentWeightSteps?: WeightStep[];
  recent?: {
    countries: string[];
    currencies: string[];
    maxBilledKg?: number | null;
    lineCount?: number;
  };
};

export type ZoneComparison = { zone: string; oldMedian: number; newMedian: number; ratio: number };

/** numberFormat (value 'tr'|'en') ve discountUnit (value 'percent'|'ratio'): aynı kimlikli iki seçenek, biri seçilir. */
export type TariffImportFix = {
  id: 'convertLbToKg' | 'setCurrency' | 'numberFormat' | 'discountUnit' | 'openBandMode';
  label: string;
  value?: string;
  resolves: string[];
};

/** Gösterim için ondalık hane: en çok 3 ("1,25", "1.250", "0,005"). */
const decimalsOf = (v: number) => Math.min(3, (String(v).split('.')[1] ?? '').length);
const numText = (v: number, locale: Locale) => fmtNumber(v, decimalsOf(v), locale);
const pctText = (v: number, locale: Locale) => t(locale, 'import.discount.pct', { pct: fmtNumber(v, Math.min(4, (String(v).split('.')[1] ?? '').length), locale) });

const SEVERITY_ORDER: Record<ImportSeverity, number> = { error: 0, warning: 1, info: 2 };
/** Okunmayan satırlardan yalnız veri kaybı olanlar uyarıdır (açıklama, zarf/pak, ikinci tablo satırları değil). */
const DATA_SKIP_REASONS = new Set([
  t('tr', 'import.reason.weightUnreadable'),
  t('tr', 'import.reason.weightEmpty'),
  t('tr', 'import.reason.packageNoWeight'),
  t('tr', 'import.reason.packageUnclear'),
  t('tr', 'import.reason.documentRow'),
]);

/** "3, 5–7, 12" */
export function fmtRowList(rows: number[], max = 40): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  const shown = parts.slice(0, max).join(', ');
  return parts.length > max ? `${shown} …` : shown;
}

const fmtWeight = (w: number, locale: Locale) => (w >= OPEN_WEIGHT ? t(locale, 'import.openWeight') : fmtKg(w, locale));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Sonuçta kullanılacak bölge eşlemesi: dosyada Bölgeler sayfası varsa o, yoksa mevcut. İkisi de boşsa, yeni tarife yurt
 * içi taşıyıcınınsa (`ctx.newTariff && ctx.domestic`) ve fiyat tablosunda tek bölge varsa `* → o bölge` kendiliğinden
 * eklenir (KALANLAR 1.2; `autoStarZone`): tek fiyat sütunlu yurt içi tarifede her gönderi o fiyattan. Yurt dışı tarifede
 * (FedEx "Zone A") her ülke o bölgeden fiyatlanırdı, kayıtlı tarifede eşleme kişinindir: eşleme uyarısı kalır. Birden çok
 * bölgede tahmin yapılmaz.
 */
export function effectiveZones(parsed: ParsedTariffImport, ctx: TariffImportContext): ImportZone[] {
  const zones = parsed.sheets.zones ? parsed.zones : ctx.currentZones;
  if (zones.length || !ctx.newTariff || !ctx.domestic) return zones;
  const star = autoStarZone(parsed);
  return star ? [{ country: '*', zone: star }] : zones;
}

/** Eşlemesiz tek bölgeli fiyat tablosunda `*`'a bağlanacak bölge (fiyat satırlarındaki adıyla); değilse null. */
export function autoStarZone(parsed: Pick<ParsedTariffImport, 'rates'>): string | null {
  const keys = new Map(parsed.rates.map((r) => [zoneKey(r.zone), r.zone]));
  return keys.size === 1 ? [...keys.values()][0]! : null;
}

/** Sonuçta kullanılacak aşım fiyatları: dosyada aşım satırı varsa o, yoksa mevcut (korunur). */
export function effectiveOverflow(parsed: ParsedTariffImport, ctx: TariffImportContext) {
  if (parsed.overflow.length) return parsed.overflow;
  // kg başı bantlar üst sınırsız ağırlığa kadar gidiyorsa aşım fiyatı hiç kullanılmaz → eskisi kaldırılır
  if (coversAllWeights(parsed)) return [];
  return ctx.currentOverflow ?? [];
}

/**
 * Uygulamada yazılacak ağırlık basamakları: fiyat tablosundan (`weightStepsFromRates`). Kg başı bant yoksa ve aşım
 * fiyatı kullanılacaksa, son satırın üstündeki basamak mevcut tarifeden alınır (aşım birimi değişmesin).
 * Tablodan çıkarılamazsa null (mevcut basamaklar korunur).
 */
export function importWeightSteps(parsed: ParsedTariffImport, ctx: TariffImportContext): WeightStep[] | null {
  if (parsed.applied.convertLbToKg) return lbWeightSteps(parsed, ctx);
  const flat = parsed.rates.filter((r) => !r.perKg).map((r) => r.weightUpto);
  if (!flat.length) return null;
  const hasPerKg = parsed.rates.some((r) => r.perKg);
  const keepAbove = !hasPerKg && effectiveOverflow(parsed, ctx).length > 0;
  const max = Math.max(...flat);
  // aşım "İlave X" kuralından geldiyse basamağı X (fiyat X başınadır); değilse mevcut tarifeninki
  const ownStep = keepAbove && parsed.overflow.length && parsed.overflowStep ? parsed.overflowStep : null;
  const aboveStep = ownStep ?? (keepAbove ? stepAbove(ctx.currentWeightSteps, max) : 1);
  const steps = weightStepsFromRates(parsed.rates, { aboveStep });
  if (!steps || !keepAbove || ownStep) return steps;
  // Aşım fiyatı kullanılıyorsa son satırın üstündeki TÜM mevcut bantlar korunur (ör. "20 kg'a kadar 0,5, üstü 1"):
  // yalnız ilk üst bandı almak, tablosu 20 kg'dan kısa bir tarifede 20 kg üstünü de 0,5'e çevirirdi.
  const tail = (ctx.currentWeightSteps ?? []).filter((s) => s.upto == null || s.upto > max + 1e-9);
  if (tail.length < 2) return steps;
  // tablodan çıkan bantlar son satıra kadar (son "üstü" bandı tablonun son ağırlığında kapanır)
  const out = steps.map((s) => ({ ...s }));
  out[out.length - 1]!.upto = max;
  for (const s of tail) {
    const last = out[out.length - 1];
    if (last && Math.round(last.step * 1000) === Math.round(s.step * 1000)) last.upto = s.upto;
    else out.push({ upto: s.upto, step: s.step });
  }
  return out;
}

/**
 * lb → kg çevrilmiş tablonun basamakları (01-B5): lb basamakları, kg karşılığıyla (1 lb = 0,45359237 kg; hesap motoru
 * bunları `lbStepKg` ile tanır ve lb katına yuvarlar). Mevcut tarifenin kg basamağı (ör. 0,5) lb listesinde anlamsızdır:
 * korunursa 0,88 kg'lık koli 1 kg'a yuvarlanıp 3 lb satırından, aşım yarım kg başına fiyatlanır.
 * - Tablo içi: basamak lb ağırlıklarından çıkarılır (`weightStepsFromRates`, lb cinsinden: 1 · 2 · 3 lb → her 1 lb;
 *   0,5 · 1 · 1,5 lb → her 0,5 lb). Çıkmazsa (düzensiz lb satırları) son sabit satıra kadar yuvarlama yok (0,001 kg):
 *   her koli düştüğü ilk satırdan fiyatlanır.
 * - Son satırın üstü: dosyanın aşımı X lb başınadır (birim yazmıyorsa 1 lb); kg başı bant varsa 1 lb; aşım dosyada yok
 *   ve mevcut tarifeden kalıyorsa (fiyatı eski birim başına) mevcut basamaklar (`importWeightSteps` ile aynı kural).
 * Taşıyıcının lb yuvarlaması böylece korunur: 6,536 kg = 14,41 lb → 15 lb; 10 lb satırından sonra 5 birim aşım.
 */
function lbWeightSteps(parsed: ParsedTariffImport, ctx: TariffImportContext): WeightStep[] | null {
  if (!parsed.rates.length) return null;
  const flatKg = parsed.rates.filter((r) => !r.perKg && r.weightUpto < OPEN_WEIGHT).map((r) => r.weightUpto);
  const maxKg = flatKg.length ? Math.max(...flatKg) : 0;
  const hasPerKg = parsed.rates.some((r) => r.perKg);
  const keptOverflow = !hasPerKg && !parsed.overflow.length && effectiveOverflow(parsed, ctx).length > 0;
  let above: WeightStep[] = [{ upto: null, step: parsed.overflow.length && !hasPerKg ? (parsed.overflowStep ?? LB_TO_KG) : LB_TO_KG }];
  if (keptOverflow) {
    const tail = (ctx.currentWeightSteps ?? []).filter((s) => s.upto == null || s.upto > maxKg + 1e-9);
    above = tail.length ? tail.map((s) => ({ ...s })) : [{ upto: null, step: stepAbove(ctx.currentWeightSteps, maxKg) }];
  }
  // lb cinsinden ağırlıklar (çevrimden önceki değer, 2 haneye: round3 kg'ın lb sapması en çok 0,0011 lb)
  const lbOf = (kg: number) => Math.round((kg / LB_TO_KG) * 100) / 100;
  // aboveStep 0,001: tablo içi bantlarla birleşmez, aşağıda atılır
  const lbBands = flatKg.length ? weightStepsFromRates(flatKg.map((w) => ({ weightUpto: lbOf(w) })), { aboveStep: 0.001 }) : null;
  const inBand: WeightStep[] = lbBands
    ? lbBands.filter((b) => b.upto != null).map((b) => ({ upto: round3(b.upto! * LB_TO_KG), step: b.step * LB_TO_KG }))
    : maxKg > 0
      ? [{ upto: maxKg, step: 0.001 }]
      : [];
  const out: WeightStep[] = [];
  for (const s of [...inBand, ...above]) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.step - s.step) < 1e-9) last.upto = s.upto;
    else out.push(s);
  }
  return out;
}

/** Tablo kg başı açık bantla ("1000+") tüm ağırlıkları kapsıyor mu? */
export function coversAllWeights(parsed: ParsedTariffImport): boolean {
  return parsed.rates.some((r) => r.weightUpto >= OPEN_WEIGHT);
}

export function effectiveCurrency(ctx: TariffImportContext, options: TariffImportOptions = {}) {
  return (options.currency?.trim().toUpperCase() || ctx.tariffCurrency).toUpperCase();
}

/** Ortak bölgelerde eski/yeni medyan fiyat; aynı ağırlıklar varsa yalnız onlar karşılaştırılır. */
export function compareWithCurrent(
  allRates: { zone: string; weightUpto: number; price: number; perKg?: boolean }[],
  allCurrent: { zone: string; weightUpto: number; price: number; perKg?: boolean }[],
): ZoneComparison[] | null {
  // kg başı bant fiyatları sabit fiyatlarla aynı ölçekte değil → yalnız sabit satırlar
  const rates = allRates.filter((r) => !r.perKg);
  const current = allCurrent.filter((r) => !r.perKg);
  if (!current.length || !rates.length) return null;
  const byZone = (list: typeof rates) => {
    const m = new Map<string, { label: string; byW: Map<number, number> }>();
    for (const r of list) {
      const k = zoneKey(r.zone);
      const e = m.get(k) ?? { label: cleanZoneLabel(r.zone), byW: new Map() };
      e.byW.set(Math.round(r.weightUpto * 1000), r.price);
      m.set(k, e);
    }
    return m;
  };
  const nz = byZone(rates);
  const oz = byZone(current);
  const out: ZoneComparison[] = [];
  for (const [k, n] of nz) {
    const o = oz.get(k);
    if (!o) continue;
    const shared = [...n.byW.keys()].filter((w) => o.byW.has(w));
    const newPrices = shared.length ? shared.map((w) => n.byW.get(w)!) : [...n.byW.values()];
    const oldPrices = shared.length ? shared.map((w) => o.byW.get(w)!) : [...o.byW.values()];
    const oldMedian = round2(median(oldPrices));
    const newMedian = round2(median(newPrices));
    if (oldMedian <= 0) continue;
    out.push({ zone: n.label, oldMedian, newMedian, ratio: Math.round((newMedian / oldMedian) * 1000) / 1000 });
  }
  return out.length ? out : null;
}

export function tariffImportFixes(parsed: ParsedTariffImport, ctx: TariffImportContext, locale: Locale = DEFAULT_LOCALE): TariffImportFix[] {
  const fixes: TariffImportFix[] = [];
  if (parsed.detectedWeightUnit === 'lb') {
    fixes.push({ id: 'convertLbToKg', label: t(locale, 'import.fix.convertLb'), resolves: ['WEIGHT_UNIT_LB'] });
  }
  if (parsed.detectedCurrency && parsed.detectedCurrency !== ctx.tariffCurrency.toUpperCase()) {
    fixes.push({
      id: 'setCurrency',
      label: t(locale, 'import.fix.setCurrency', { currency: parsed.detectedCurrency }),
      value: parsed.detectedCurrency,
      resolves: ['CURRENCY_MISMATCH'],
    });
  }
  // 01-B6: sayı biçimi sorulduysa ya da seçildiyse iki seçenek (seçim geri alınabilsin diye seçimden sonra da)
  if (parsed.kind !== 'pdf' && (parsed.numberAmbiguities.length || parsed.applied.numberFormat)) {
    const resolves = ['NUMBER_FORMAT_UNCLEAR', 'NUMBER_FORMAT_ASSUMED'];
    fixes.push(
      { id: 'numberFormat', value: 'tr', label: t(locale, 'import.fix.numberFormatTr'), resolves },
      { id: 'numberFormat', value: 'en', label: t(locale, 'import.fix.numberFormatEn'), resolves },
    );
  }
  // 01-B12: biçimsiz 0–1 indirim
  if (parsed.kind !== 'pdf' && parsed.discountChoice) {
    const d = parsed.discountChoice;
    fixes.push(
      { id: 'discountUnit', value: 'percent', label: t(locale, 'import.fix.discount', { text: d.text, pct: pctText(d.asPercent, locale) }), resolves: ['DISCOUNT_UNCLEAR'] },
      { id: 'discountUnit', value: 'ratio', label: t(locale, 'import.fix.discount', { text: d.text, pct: pctText(d.asRatio, locale) }), resolves: ['DISCOUNT_UNCLEAR'] },
    );
  }
  // KALANLAR 1.7: işaretsiz açık uçlu satır ("31+ | 8") her ilave birim mi, fiyat × toplam ağırlık mı (seçimden sonra da)
  if (parsed.openBands.length || parsed.applied.openBandMode) {
    const resolves = ['OPEN_BAND_UNCLEAR', 'OPEN_BAND_ADDITIONAL'];
    fixes.push(
      { id: 'openBandMode', value: 'additional', label: t(locale, 'import.fix.openBandAdditional'), resolves },
      { id: 'openBandMode', value: 'perKg', label: t(locale, 'import.fix.openBandPerKg'), resolves },
      { id: 'openBandMode', value: 'flat', label: t(locale, 'import.fix.openBandFlat'), resolves },
    );
  }
  return fixes;
}

export function checkTariffImport(
  parsed: ParsedTariffImport,
  ctx: TariffImportContext,
  options: TariffImportOptions = {},
  locale: Locale = DEFAULT_LOCALE,
): ImportIssue[] {
  const m = (key: MessageKey, params?: MessageParams) => t(locale, key, params);
  const kg = (n: number) => fmtKg(n, locale);
  const num = (n: number) => fmtNumber(n, 2, locale);
  const issues: ImportIssue[] = [];
  const add = (i: ImportIssue) => issues.push(i);
  const currency = effectiveCurrency(ctx, options);
  const rateKeys = new Set(parsed.rates.map((r) => zoneKey(r.zone)));
  const rateZoneLabels = [...new Map(parsed.rates.map((r) => [zoneKey(r.zone), r.zone])).values()];
  const mapping = effectiveZones(parsed, ctx);
  const flatRates = parsed.rates.filter((r) => !r.perKg);
  const perKgRates = parsed.rates.filter((r) => r.perKg);
  const weights = [...new Set(flatRates.map((r) => r.weightUpto))].sort((a, b) => a - b);
  const perKgWeights = [...new Set(perKgRates.map((r) => r.weightUpto))].sort((a, b) => a - b);
  const maxWeight = weights.length ? weights[weights.length - 1]! : 0;
  const maxAll = Math.max(maxWeight, perKgWeights[perKgWeights.length - 1] ?? 0);
  const overflow = effectiveOverflow(parsed, ctx);
  const fileZonesText = parsed.priceZones.length ? parsed.priceZones.join(', ') : '—';

  // ---------- Hatalar ----------
  if (!parsed.sheets.prices || parsed.headerRow == null) {
    add({
      severity: 'error',
      code: 'NO_RATES',
      title: m('import.noTable.title'),
      suggestion: m('import.noTable.suggestion'),
    });
  } else if (!parsed.priceZones.length) {
    add({
      severity: 'error',
      code: 'NO_ZONE_COLUMNS',
      title: m('import.noZoneColumns.title'),
      detail: m('import.noZoneColumns.detail', { row: parsed.headerRow }),
      suggestion: m('import.noZoneColumns.suggestion'),
      rows: [parsed.headerRow],
    });
  } else if (!parsed.rates.length) {
    add({
      severity: 'error',
      code: 'NO_RATES',
      title: m('import.noRates.title'),
      detail: m('import.noRates.detail', { row: parsed.headerRow }),
      suggestion: m('import.noRates.suggestion'),
    });
  }

  if (parsed.duplicateZones.length) {
    add({
      severity: 'error',
      code: 'DUPLICATE_ZONE',
      title: m('import.dupZone.title'),
      detail: m('import.dupZone.detail', { zones: [...new Set(parsed.duplicateZones)].join(', ') }),
      suggestion: m('import.dupZone.suggestion'),
      rows: parsed.headerRow ? [parsed.headerRow] : undefined,
    });
  }

  if (parsed.duplicates.length) {
    const ex = parsed.duplicates
      .slice(0, 5)
      .map((d) => m('import.dupWeight.item', { zone: d.zone, kg: kg(d.weightUpto), prices: d.prices.map((p) => num(p)).join(' / '), rows: fmtRowList(d.rows) }))
      .join('; ');
    add({
      severity: 'error',
      code: 'DUPLICATE_WEIGHT',
      title: m('import.dupWeight.title', { count: parsed.duplicates.length }),
      detail: ex,
      suggestion: m('import.dupWeight.suggestion'),
      rows: parsed.duplicates.flatMap((d) => d.rows),
    });
  }

  if (parsed.invalidPrices.length) {
    const ex = parsed.invalidPrices
      .slice(0, 5)
      .map((p) => m('import.invalidPrice.item', { row: p.row, zone: p.zone, text: p.text }))
      .join('; ');
    add({
      severity: 'error',
      code: 'INVALID_PRICE',
      title: m('import.invalidPrice.title', { count: parsed.invalidPrices.length }),
      detail: ex,
      suggestion: m('import.invalidPrice.suggestion'),
      rows: parsed.invalidPrices.map((p) => p.row),
    });
  }

  // Sayı biçimi (01-B6). Belirsiz biçimde iki türlü okunan sayı uygulamayı durdurur; zayıf kanıtla seçilen biçimde eski
  // okumadan farklı okunan sayılar da durdurur (biçim seçilmeli). İkisinde de iki okuma gösterilir, biçim seçeneği (`numberFormat`) çözer.
  if (parsed.numberAmbiguities.length) {
    const list = parsed.numberAmbiguities;
    const unclear = parsed.numberFormat.format === 'auto';
    const name = (f: 'tr' | 'en') => m(f === 'tr' ? 'import.numberFormat.name.tr' : 'import.numberFormat.name.en');
    const detail = list
      .slice(0, 6)
      .map((a) =>
        m('import.numberFormat.item', {
          row: a.row,
          where: a.zone == null ? m('import.numberFormat.weight') : m('import.numberFormat.zone', { zone: a.zone }),
          text: a.text,
          tr: numText(a.tr, locale),
          en: numText(a.en, locale),
        }),
      )
      .join('; ');
    const more = list.length > 6 ? ' …' : '';
    const used = parsed.numberFormat.format === 'en' ? 'en' : 'tr';
    add(
      unclear
        ? {
            severity: 'error',
            code: 'NUMBER_FORMAT_UNCLEAR',
            title: m('import.numberFormat.unclearTitle', { count: list.length }),
            detail: detail + more,
            suggestion: m('import.numberFormat.unclearSuggestion'),
            rows: list.map((a) => a.row),
          }
        : {
            // zayıf kanıt (ör. üç "12.50") yanlış biçim seçebilir: Türkçe dosyada "0.5" ağırlıklar İngilizce
            // seçtirir ve "1.250" TL fiyatı 1,25 okunurdu (bin kat). Toplu onayla geçilmez; biçim seçilmeden uygulanmaz.
            severity: 'error',
            code: 'NUMBER_FORMAT_ASSUMED',
            title: m('import.numberFormat.assumedTitle', { format: name(used), count: list.length }),
            detail: detail + more,
            suggestion: m('import.numberFormat.assumedSuggestion', { other: name(used === 'en' ? 'tr' : 'en') }),
            rows: list.map((a) => a.row),
          },
    );
  }

  // Açık uçlu satır ("31+ | 8") işaretsiz, fiyatı önceki satırdan çok düşük ve tablonun sonuna eklenemiyor (01-B12, 1.7)
  const unclearBands = parsed.openBands.filter((b) => b.reading === 'unclear');
  if (unclearBands.length) {
    add({
      severity: 'error',
      code: 'OPEN_BAND_UNCLEAR',
      title: m('import.openBand.unclearTitle', { count: unclearBands.length }),
      detail: unclearBands
        .slice(0, 5)
        .map((b) =>
          m('import.openBand.unclearItem', {
            row: b.row,
            zone: b.zone,
            label: b.label,
            price: num(b.price),
            last: kg(b.prevWeight),
            prev: num(b.prevPrice),
            reason: m(`import.openBand.why.${b.why ?? 'start'}` as MessageKey),
          }),
        )
        .join('; '),
      suggestion: m('import.openBand.unclearSuggestion'),
      rows: unclearBands.map((b) => b.row),
    });
  }

  if (parsed.rates.length) {
    const missing = [...new Map(mapping.map((m) => [zoneKey(m.zone), m.zone])).entries()].filter(([k]) => !rateKeys.has(k));
    if (missing.length) {
      const names = missing.map(([, z]) => z);
      const countries = mapping.filter((m) => missing.some(([k]) => k === zoneKey(m.zone))).map((m) => m.country);
      add({
        severity: 'error',
        code: 'ZONE_MAPPING_MISSING',
        title: names.length === 1 ? m('import.zoneMapping.titleOne', { zone: names[0]! }) : m('import.zoneMapping.titleMany', { count: names.length }),
        detail: m('import.zoneMapping.detail', { zones: names.join(', '), countries: countries.slice(0, 15).join(', '), more: countries.length > 15 ? ' …' : '', fileZones: fileZonesText }),
        suggestion: parsed.sheets.zones ? m('import.zoneMapping.suggestionSheet') : m('import.zoneMapping.suggestionFile'),
      });
    }
  }

  // Beklenen tutar indirimle hesaplanır: indirimi olmayan dosya sessizce yanlış sonuç vermesin. PDF akışı net/liste bilgisini kendi taşır.
  if (parsed.kind !== 'pdf' && parsed.rates.length > 0) {
    if (parsed.discountIssue) {
      const values = parsed.discountIssue.values.join(', ');
      add(
        parsed.discountIssue.kind === 'mixed'
          ? { severity: 'error', code: 'MIXED_DISCOUNT', title: m('import.discount.mixed.title'), detail: m('import.discount.mixed.detail', { values }) }
          : { severity: 'error', code: 'INVALID_DISCOUNT', title: m('import.discount.invalid.title'), detail: m('import.discount.invalid.detail', { values }) },
      );
    } else if (parsed.discountChoice && !parsed.applied.discountUnit) {
      // 01-B12: biçimsiz 0–1 değer: %0,5 mi %50 mi? Düzeltme seçenekleri (`discountUnit`) iki okumayı sunar.
      const d = parsed.discountChoice;
      add({
        severity: 'error',
        code: 'DISCOUNT_UNCLEAR',
        title: m('import.discount.unclear.title', { text: d.text, asPercent: pctText(d.asPercent, locale), asRatio: pctText(d.asRatio, locale) }),
        detail: m('import.discount.unclear.detail', { text: d.text, asPercent: pctText(d.asPercent, locale), asRatio: pctText(d.asRatio, locale) }),
        suggestion: m('import.discount.unclear.suggestion'),
      });
    } else if (parsed.discountPct == null) {
      const current = ctx.currentDiscountPct ?? 0;
      add({
        severity: 'warning',
        code: 'NO_DISCOUNT',
        title: m('import.discount.missing.title'),
        detail: current > 0 ? m('import.discount.missing.detailKept', { pct: fmtNumber(current, 2, locale) }) : m('import.discount.missing.detailNet'),
        suggestion: m('import.discount.missing.suggestion'),
      });
    }
  }

  if (parsed.detectedWeightUnit === 'lb' && !parsed.applied.convertLbToKg) {
    add({
      severity: 'error',
      code: 'WEIGHT_UNIT_LB',
      title: m('import.lb.title'),
      detail: m('import.lb.detail', { evidence: parsed.unitEvidence.join(', ') }),
      suggestion: m('import.lb.suggestion'),
    });
  }

  if (parsed.detectedCurrency && parsed.detectedCurrency !== currency) {
    add({
      severity: 'error',
      code: 'CURRENCY_MISMATCH',
      title: m(parsed.kind === 'pdf' ? 'import.currency.titlePdf' : 'import.currency.titleFile', { detected: parsed.detectedCurrency, currency }),
      detail:
        parsed.kind === 'pdf'
          ? m('import.currency.detailPdf', { detected: parsed.detectedCurrency, currency })
          : m('import.currency.detailFile', { evidence: parsed.currencyEvidence.map((e) => localizeText(e, locale)).join(', '), currency }),
      suggestion: m('import.currency.suggestion', { detected: parsed.detectedCurrency }),
    });
  }

  // ---------- Uyarılar ----------
  const lostRows = parsed.skipped.filter((s) => DATA_SKIP_REASONS.has(s.reason));
  if (lostRows.length) {
    const groups = new Map<string, SkippedRow[]>();
    for (const s of lostRows) groups.set(s.reason, [...(groups.get(s.reason) ?? []), s]);
    const detail = [...groups.entries()]
      .map(([reason, list]) => {
        const ex = [...new Set(list.map((l) => l.text).filter(Boolean))].slice(0, 3).map((t) => `"${t}"`).join(', ');
        return m('import.skipped.item', { rows: fmtRowList(list.map((l) => l.row), 12), reason: localizeText(reason, locale).toLocaleLowerCase(locale), examples: ex ? ` (${ex})` : '' });
      })
      .join('. ');
    add({
      severity: 'warning',
      code: 'SKIPPED_ROWS',
      title: m('import.skipped.title', { count: lostRows.length }),
      detail,
      suggestion: m('import.skipped.suggestion'),
      rows: lostRows.map((s) => s.row),
    });
  }

  if (parsed.extraTables.length) {
    add({
      severity: 'warning',
      code: 'MULTIPLE_SECTIONS',
      title: m('import.sections.title'),
      detail: m('import.sections.detail', { tables: parsed.extraTables.map((x) => m('import.sections.item', { title: short(x.title, 70), row: x.row })).join(', ') }),
      suggestion: m('import.sections.suggestion'),
      rows: parsed.extraTables.map((x) => x.row),
    });
  }

  if (parsed.sheetIssues.length) {
    add({
      severity: 'warning',
      code: 'SHEET_ROWS_SKIPPED',
      title: m('import.sheet.title', { count: parsed.sheetIssues.length }),
      detail: parsed.sheetIssues
        .slice(0, 6)
        // yalnız sözcükle başlıyorsa ilk harf küçülür: kodlar (DE, FIXED/PCT/PER_KG) okunur kalır
        .map((s) => {
          const text = localizeText(s.reason, locale);
          const reason = /^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLocaleLowerCase(locale) + text.slice(1) : text;
          return m(s.sheet === 'zones' ? 'import.sheet.zones' : 'import.sheet.surcharges', { row: s.row, reason });
        })
        .join('; '),
    });
  }

  // fiyat sırası
  const byZone = new Map<string, ImportRate[]>();
  for (const r of parsed.rates) {
    const k = `${zoneKey(r.zone)}|${r.perKg ? 'kg' : 'flat'}`;
    byZone.set(k, [...(byZone.get(k) ?? []), r]);
  }
  const orderItem = (cur: ImportRate, prev: ImportRate) =>
    m('import.order.item', {
      zone: cur.zone,
      perKg: cur.perKg ? m('import.order.perKg') : '',
      fromKg: fmtWeight(prev.weightUpto, locale),
      fromPrice: num(prev.price),
      toKg: fmtWeight(cur.weightUpto, locale),
      toPrice: num(cur.price),
    });
  const decreases: string[] = [];
  const decreaseRows: number[] = [];
  const jumps: string[] = [];
  const jumpRows: number[] = [];
  let decreaseCount = 0;
  let jumpCount = 0;
  for (const list of byZone.values()) {
    const s = [...list].sort((a, b) => a.weightUpto - b.weightUpto);
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1]!;
      const cur = s[i]!;
      // kg başı bantlarda ağırlık arttıkça kg fiyatının düşmesi olağandır (71–99 kg 4,35 → 100+ kg 3,99); yalnız sıçrama aranır
      if (!cur.perKg && cur.price < prev.price * 0.99) {
        decreaseCount++;
        decreaseRows.push(cur.row);
        if (decreases.length < 4) {
          decreases.push(orderItem(cur, prev));
        }
      }
      if (prev.price > 0 && cur.price / prev.price > 3) {
        jumpCount++;
        jumpRows.push(cur.row);
        if (jumps.length < 4) {
          jumps.push(orderItem(cur, prev));
        }
      }
    }
  }
  if (decreaseCount) {
    add({
      severity: 'warning',
      code: 'PRICE_DECREASES',
      title: m('import.decrease.title', { count: decreaseCount }),
      detail: decreases.join('; '),
      suggestion: m('import.decrease.suggestion'),
      rows: decreaseRows,
    });
  }
  if (jumpCount) {
    add({
      severity: 'warning',
      code: 'PRICE_JUMP',
      title: m('import.jump.title', { count: jumpCount }),
      detail: jumps.join('; '),
      suggestion: m('import.jump.suggestion'),
      rows: jumpRows,
    });
  }

  // KALANLAR 1.7: işaretsiz açık uçlu satır kendiliğinden "her ilave birim" sayıldı (kişi seçtiyse uyarı yok)
  const additionalBands = parsed.openBands.filter((b) => b.reading === 'additional' && !b.chosen);
  if (additionalBands.length) {
    add({
      severity: 'warning',
      code: 'OPEN_BAND_ADDITIONAL',
      title: m('import.openBand.additionalTitle', { count: additionalBands.length }),
      detail: additionalBands
        .slice(0, 5)
        .map((b) => {
          // örnek: son satırın 5 birim üstü (30 → 35)
          const at = b.prevWeight + 5;
          return m('import.openBand.additionalItem', {
            row: b.row,
            zone: b.zone,
            label: b.label,
            price: num(b.price),
            last: kg(b.prevWeight),
            at: kg(at),
            prev: num(b.prevPrice),
            additional: num(round2(b.prevPrice + 5 * b.price)),
            perKg: num(round2(b.price * at)),
          });
        })
        .join('; '),
      suggestion: m('import.openBand.additionalSuggestion'),
      rows: additionalBands.map((b) => b.row),
    });
  }
  // KALANLAR 1.7: açık uç ya da ilave satırına benzeyen ama okunamayan etiket: tahmin yok, sorulur
  if (parsed.unreadableOpenBands.length) {
    const list = parsed.unreadableOpenBands;
    add({
      severity: 'warning',
      code: 'OPEN_BAND_UNREADABLE',
      title: m('import.openBand.unreadableTitle', { count: list.length }),
      detail: list
        .slice(0, 5)
        .map((b) => m('import.openBand.unreadableItem', { row: b.row, label: b.label }))
        .join('; '),
      suggestion: m('import.openBand.unreadableSuggestion'),
      rows: list.map((b) => b.row),
    });
  }

  // 01-B5: lb çevriminde mevcut kg basamağı korunmaz (yuvarlama yok); değişiklik varsa söylenir
  const lbSteps = parsed.applied.convertLbToKg && parsed.rates.length ? importWeightSteps(parsed, ctx) : null;
  if (lbSteps && ctx.currentWeightSteps?.length && !sameWeightSteps(lbSteps, ctx.currentWeightSteps)) {
    add({
      severity: 'warning',
      code: 'LB_WEIGHT_STEPS',
      title: m('import.lbSteps.title', { old: describeWeightSteps(ctx.currentWeightSteps, locale), new: describeWeightSteps(lbSteps, locale) }),
      detail: m('import.lbSteps.detail', { overflow: parsed.overflow.length ? m('import.lbSteps.overflow') : '' }),
    });
  }

  const hasStar = mapping.some((m) => m.country === '*');
  // KALANLAR 1.2: bölge eşlemesi yok, tek bölge → `*` kendiliğinden (effectiveZones)
  const ownZones = parsed.sheets.zones ? parsed.zones : ctx.currentZones;
  if (!ownZones.length && mapping.length === 1 && hasStar) {
    add({ severity: 'info', code: 'ZONE_STAR_AUTO', title: m('import.starAuto.title', { zone: mapping[0]!.zone }) });
  }
  // yurt içi mesafe bölgeleri: gönderinin mesafesi faturadan bilinmez (bölge yalnız varış ülkesinden / * ile bulunur)
  const distanceZones = rateZoneLabels.filter((z) => distanceZoneCode(z) != null);
  if (distanceZones.length >= 2) {
    const star = mapping.find((m) => m.country === '*');
    add({
      severity: 'warning',
      code: 'DISTANCE_ZONES',
      title: m('import.distance.title', { zones: distanceZones.join(', ') }),
      detail: m('import.distance.detail', { tail: star ? m('import.distance.star', { zone: star.zone }) : m('import.distance.noStar') }),
      suggestion: m('import.distance.suggestion'),
    });
  }
  if (distanceZones.length >= 2) {
    // eşleme uyarısı yukarıdaki DISTANCE_ZONES notunda
  } else if (parsed.rates.length && !mapping.length) {
    add({
      severity: 'warning',
      code: 'NO_COUNTRY_MAPPING',
      title: m('import.noMapping.title'),
      detail: m('import.noMapping.detail'),
      suggestion: m('import.noMapping.suggestion'),
    });
  } else if (ctx.recent?.countries.length && !hasStar) {
    const mapped = new Set(mapping.map((m) => m.country.toUpperCase()));
    const missing = [...new Set(ctx.recent.countries.map((c) => c.toUpperCase()))].filter((c) => c && !mapped.has(c)).sort();
    if (missing.length) {
      add({
        severity: 'warning',
        code: 'RECENT_COUNTRIES_UNMAPPED',
        title: m('import.recent.title', { count: missing.length }),
        detail: m('import.recent.detail', { countries: missing.slice(0, 20).join(', '), more: missing.length > 20 ? ' …' : '' }),
        suggestion: m('import.recent.suggestion'),
      });
    }
  }

  const invCurrencies = [...new Set((ctx.recent?.currencies ?? []).map((c) => c.toUpperCase()).filter(Boolean))];
  if (invCurrencies.length && !invCurrencies.includes(currency)) {
    add({
      severity: 'info',
      code: 'CURRENCY_VS_INVOICES',
      title: m('import.invoiceCurrency.title', { currencies: invCurrencies.join(' / ') }),
      detail: m('import.invoiceCurrency.detail', { currency, currencies: invCurrencies.join(', ') }),
    });
  }

  if (parsed.rates.length && !overflow.length && maxAll < OPEN_WEIGHT) {
    const recentMax = ctx.recent?.maxBilledKg ?? null;
    if (recentMax != null && recentMax > maxAll) {
      add({
        severity: 'warning',
        code: 'MAX_WEIGHT_LOW',
        title: m('import.maxWeight.recentTitle', { max: kg(maxAll), recent: kg(recentMax) }),
        detail: m('import.maxWeight.recentDetail'),
        suggestion: m('import.maxWeight.recentSuggestion'),
      });
    } else if (maxAll < 30) {
      add({
        severity: 'warning',
        code: 'MAX_WEIGHT_LOW',
        title: m('import.maxWeight.title', { max: kg(maxAll) }),
        suggestion: m('import.maxWeight.suggestion', { max: kg(maxAll) }),
      });
    }
  }

  const sameCurrency = currency === ctx.tariffCurrency.toUpperCase();
  const comparison = sameCurrency ? compareWithCurrent(parsed.rates, ctx.currentRates) : null;
  const big = (comparison ?? []).filter((c) => c.ratio < 0.5 || c.ratio > 2);
  if (big.length) {
    add({
      severity: 'warning',
      code: 'BIG_CHANGE_VS_CURRENT',
      title: m('import.bigChange.title', { count: big.length }),
      detail: big
        .slice(0, 6)
        .map((c) => m('import.bigChange.item', { zone: c.zone, old: fmtMoney(c.oldMedian, ctx.tariffCurrency, locale), new: fmtMoney(c.newMedian, parsed.detectedCurrency ?? currency, locale), ratio: num(c.ratio) }))
        .join('; '),
      suggestion: m('import.bigChange.suggestion'),
    });
  }

  // aşım fiyatları: dosyada yoksa mevcutlar korunur; varsa değişiklik uyarısı
  const curOverflow = ctx.currentOverflow ?? [];
  if (parsed.rates.length && parsed.overflow.length && curOverflow.length) {
    const fileMap = new Map(parsed.overflow.map((o) => [zoneKey(o.zone), o]));
    const changed = curOverflow
      .map((o) => {
        const n = fileMap.get(zoneKey(o.zone));
        if (!n) return m('import.overflow.removed', { zone: o.zone, old: num(o.perUnit) });
        return n.perUnit !== o.perUnit ? m('import.overflow.changedItem', { zone: o.zone, old: num(o.perUnit), new: num(n.perUnit) }) : null;
      })
      .filter((x): x is string => !!x);
    if (changed.length) {
      add({
        severity: 'warning',
        code: 'OVERFLOW_CHANGED',
        title: m('import.overflow.changedTitle', { count: changed.length }),
        detail: changed.slice(0, 8).join('; ') + (changed.length > 8 ? ' …' : ''),
        suggestion: m('import.overflow.changedSuggestion'),
      });
    }
  } else if (parsed.rates.length && !parsed.overflow.length && curOverflow.length && maxAll < OPEN_WEIGHT) {
    add({
      severity: 'warning',
      code: 'OVERFLOW_KEPT',
      title: m('import.overflow.keptTitle', { count: curOverflow.length }),
      detail: m('import.overflow.keptDetail', {
        items: curOverflow
          .slice(0, 8)
          .map((o) => m('import.overflow.keptItem', { zone: o.zone, price: num(o.perUnit) }))
          .join('; '),
        more: curOverflow.length > 8 ? ' …' : '',
        max: kg(maxAll),
      }),
      suggestion: m('import.overflow.keptSuggestion'),
    });
  }

  // "Aşım" satırında birim yok: tutar mevcut tarifenin son basamağı başına sayılır (0,5 kg basamakta kg başı tutar iki kat olur).
  // Şablonun "Aşım (her ek birim)" etiketi bilerek "tarifenin basamağı başına" der → uyarı yok.
  const declaredPerStep = /\b(?:birim|unit)/.test(norm(parsed.overflowRow?.label ?? ''));
  if (parsed.rates.length && parsed.overflow.length && parsed.overflowRow && parsed.overflowStep == null && !declaredPerStep && !parsed.rates.some((r) => r.perKg)) {
    const steps = importWeightSteps(parsed, ctx) ?? ctx.currentWeightSteps ?? [];
    const tail = steps.filter((s) => s.upto == null || s.upto > maxWeight + 1e-9);
    const unit = tail.length > 1 ? describeWeightSteps(tail, locale) : describeWeightStep(tail[0]?.step ?? 1, locale);
    // lb çevriminde birim 1 lb sayılır (kg başı değil): "iki kat" uyarısı kg basamağına göredir
    const half = !parsed.applied.convertLbToKg && tail.some((s) => Math.round(s.step * 1000) !== 1000);
    add({
      severity: 'warning',
      code: 'OVERFLOW_UNIT_MISSING',
      title: m('import.overflowUnit.title', { max: kg(maxWeight), unit }),
      detail: m('import.overflowUnit.detail', { row: parsed.overflowRow.row, label: parsed.overflowRow.label, unit, half: half ? m('import.overflowUnit.half') : '' }),
      suggestion: m('import.overflowUnit.suggestion'),
      rows: [parsed.overflowRow.row],
    });
  }

  // para birimi değişiyor ama dosyadan gelmeyen tutarlar eski para biriminde kalıyor
  if (currency !== ctx.tariffCurrency.toUpperCase() && !ctx.newTariff) {
    const left: string[] = [];
    let scLeft = 0;
    if (!parsed.sheets.surcharges) {
      for (const sc of ctx.currentSurcharges ?? []) {
        if (sc.kind === 'FIXED' || sc.kind === 'PER_KG') {
          scLeft++;
          left.push(m('import.otherCurrency.surchargeItem', { name: sc.name || sc.code, amount: num(sc.amount), currency: ctx.tariffCurrency, perKg: sc.kind === 'PER_KG' ? ' / kg' : '' }));
        }
      }
    }
    if (!parsed.overflow.length) {
      for (const o of overflow) left.push(m('import.otherCurrency.overflowItem', { zone: o.zone, amount: num(o.perUnit), currency: ctx.tariffCurrency }));
    }
    if (left.length) {
      const old = ctx.tariffCurrency.toUpperCase();
      const scope = scLeft && left.length > scLeft ? 'both' : scLeft ? 'surcharges' : 'overflow';
      const what = m(`import.otherCurrency.what.${scope}`);
      const where = m(`import.otherCurrency.where.${scope}`);
      add({
        severity: 'warning',
        code: 'SURCHARGES_OTHER_CURRENCY',
        title: m('import.otherCurrency.title', { what, old, currency, check: m(scLeft ? 'import.otherCurrency.check.surcharges' : 'import.otherCurrency.check.overflow') }),
        detail: m('import.otherCurrency.detail', { count: left.length, old, items: left.slice(0, 10).join('; '), more: left.length > 10 ? ' …' : '', currency }),
        suggestion: m('import.otherCurrency.suggestion', { where, currency }),
      });
    }
  }

  // KALANLAR 1.7 incelemesi: çelişen ya da başlangıcı belirsiz ilave kuralı tahmin edilmez, sorulur
  if (parsed.stepConflicts.length) {
    add({
      severity: 'error',
      code: 'STEP_RULE_UNCLEAR',
      title: m('import.stepUnclear.title', { count: new Set(parsed.stepConflicts.map((i) => i.row)).size }),
      detail: parsed.stepConflicts
        .slice(0, 6)
        .map((i) => m('import.stepUnused.item', { row: i.row, zone: i.zone, reason: localizeText(i.reason, locale) }))
        .join('; '),
      suggestion: m('import.stepUnclear.suggestion'),
      rows: parsed.stepConflicts.map((i) => i.row),
    });
  }
  // "İlave X kg" kuralları
  if (parsed.stepIssues.length) {
    add({
      severity: 'warning',
      code: 'STEP_RULE_UNUSED',
      title: m('import.stepUnused.title', { count: new Set(parsed.stepIssues.map((i) => i.row)).size }),
      detail: parsed.stepIssues
        .slice(0, 6)
        .map((i) => m('import.stepUnused.item', { row: i.row, zone: i.zone, reason: localizeText(i.reason, locale) }))
        .join('; '),
      suggestion: m('import.stepUnused.suggestion'),
      rows: parsed.stepIssues.map((i) => i.row),
    });
  }
  if (parsed.stepMismatches.length) {
    add({
      severity: 'warning',
      code: 'STEP_MISMATCH',
      title: m('import.stepMismatch.title', { count: parsed.stepMismatches.length }),
      detail: parsed.stepMismatches
        .slice(0, 5)
        .map((x) => m('import.stepMismatch.item', { zone: x.zone, from: kg(x.from), to: kg(x.to), expected: num(x.expected), actual: num(x.actual) }))
        .join('; '),
      suggestion: m('import.stepMismatch.suggestion'),
      rows: parsed.stepMismatches.map((x) => x.row),
    });
  }

  // ---------- Bilgi (en çok iki satır: okunanlar + dönüşümler) ----------
  if (parsed.rates.length) {
    const generated = parsed.stepExpansions.reduce((n, e) => n + e.count, 0);
    const otherSkipped = parsed.skipped.filter((x) => !DATA_SKIP_REASONS.has(x.reason));
    const notes: string[] = [];
    notes.push(
      weights.length
        ? m('import.note.weights', { min: kg(weights[0]!), max: kg(maxWeight), perKg: perKgWeights.length ? m('import.note.weightsPerKg', { count: perKgWeights.length }) : '' })
        : m('import.note.perKgOnly', { count: perKgWeights.length }),
    );
    const steps = importWeightSteps(parsed, ctx);
    // lb çevriminde mevcut basamak varken değişikliği LB_WEIGHT_STEPS söyler; yeni (basamaksız) tarifede bu not
    if (steps && !(parsed.applied.convertLbToKg && ctx.currentWeightSteps?.length) && !sameWeightSteps(steps, ctx.currentWeightSteps)) notes.push(m('import.note.steps', { steps: describeWeightSteps(steps, locale) }));
    if (generated) notes.push(m('import.note.generated', { count: generated }));
    if (parsed.overflow.length) notes.push(m('import.note.overflow', { count: parsed.overflow.length }));
    else if (curOverflow.length && maxAll >= OPEN_WEIGHT) notes.push(m('import.note.overflowRemoved'));
    if (parsed.sheets.zones) notes.push(m('import.note.zones', { count: parsed.zones.length }));
    if (parsed.sheets.surcharges) notes.push(m('import.note.surcharges', { count: parsed.surcharges.length }));
    if (parsed.kind === 'csv') notes.push(m('import.note.csv'));
    if (parsed.zoneRenames.length) notes.push(m('import.note.renamed', { list: parsed.zoneRenames.slice(0, 3).map((r) => `"${r.from}" → "${r.to}"`).join(', '), more: parsed.zoneRenames.length > 3 ? ' …' : '' }));
    if (otherSkipped.length) notes.push(m('import.note.otherSkipped', { count: otherSkipped.length }));
    const pakCount = parsed.packagingRates.filter((r) => r.packaging === 'PAK').length;
    const envelopeCount = parsed.packagingRates.length - pakCount;
    if (parsed.packagingRates.length) {
      const parts = [
        ...(pakCount ? [m('import.note.packaging.pak', { count: pakCount })] : []),
        ...(envelopeCount ? [m('import.note.packaging.envelope', { count: envelopeCount })] : []),
      ];
      notes.push(m('import.note.packaging', { list: parts.join(m('import.note.packaging.and')) }));
    }
    const anyWeight = parsed.packagingRates.filter((r) => r.weightUpto >= OPEN_WEIGHT).length;
    if (anyWeight) notes.push(m('import.note.packagingAnyWeight', { count: anyWeight }));
    add({
      severity: 'info',
      code: 'SUMMARY',
      title: m('import.summary.title', { zones: rateZoneLabels.length, weights: weights.length, perKg: perKgWeights.length ? m('import.summary.titlePerKg', { count: perKgWeights.length }) : '', prices: parsed.rates.length }),
      detail: notes.map((x) => x.charAt(0).toLocaleUpperCase(locale) + x.slice(1)).join('. ') + '.',
    });
  }
  const conversions: string[] = [];
  if (parsed.applied.convertLbToKg) conversions.push(m('import.conversion.lb'));
  if (parsed.applied.numberFormat) {
    conversions.push(m('import.conversion.numberFormat', { format: m(parsed.applied.numberFormat === 'en' ? 'import.numberFormat.name.en' : 'import.numberFormat.name.tr') }));
  }
  if (parsed.applied.currency && parsed.applied.currency !== ctx.tariffCurrency.toUpperCase() && !ctx.newTariff) {
    conversions.push(m('import.conversion.currency', { from: ctx.tariffCurrency, to: parsed.applied.currency }));
  }
  if (conversions.length) {
    const text = conversions.map((x) => x.charAt(0).toLocaleUpperCase(locale) + x.slice(1)).join('; ');
    add({ severity: 'info', code: 'CONVERSIONS', title: text });
  }

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * SURCHARGES_OTHER_CURRENCY uyarısının yönlendirdiği bölüm. Başlıktan okunur, iki dilde de: kayıtlı eski kontrollerde
 * ayrı bir alan yok ve kontrol metni API'den etkin dilde gelebilir.
 */
export function otherCurrencyCheckSection(issue: Pick<ImportIssue, 'code' | 'title'>): 'surcharges' | 'overflow' | null {
  if (issue.code !== 'SURCHARGES_OTHER_CURRENCY') return null;
  const tail = (locale: Locale) =>
    t(locale, 'import.otherCurrency.title', { what: '', old: '', currency: '', check: t(locale, 'import.otherCurrency.check.surcharges') }).split('—').pop()!;
  return issue.title.endsWith(tail('tr')) || issue.title.endsWith(tail('en')) ? 'surcharges' : 'overflow';
}

// ---------------------------------------------------------------------------------------------
// Özet başlık (önce genel durum, ayrıntı checks'te)

export type ImportHeadline = { status: 'ok' | 'warning' | 'error'; title: string; lines: string[] };

/** "9 bölge, 0,5–70,5 kg, 70,5 kg üstü kg başı fiyat · 223 ülke eşlemesi · USD" */
export function importSummaryLine(parsed: ParsedTariffImport, ctx: TariffImportContext, options: TariffImportOptions = {}, locale: Locale = DEFAULT_LOCALE): string {
  const zones = new Set(parsed.rates.map((r) => zoneKey(r.zone))).size;
  const flat = [...new Set(parsed.rates.filter((r) => !r.perKg).map((r) => r.weightUpto))].sort((a, b) => a - b);
  const perKg = parsed.rates.some((r) => r.perKg);
  const parts: string[] = [];
  let first = t(locale, 'import.line.zones', { count: zones });
  if (flat.length) first += t(locale, 'import.line.range', { min: fmtWeightNumber(flat[0]!, locale), max: fmtKg(flat[flat.length - 1]!, locale) });
  if (perKg) first += flat.length ? t(locale, 'import.line.perKgAbove', { kg: fmtKg(flat[flat.length - 1]!, locale) }) : t(locale, 'import.line.perKg');
  parts.push(first);
  const mapping = effectiveZones(parsed, ctx);
  parts.push(mapping.length ? t(locale, 'import.note.zones', { count: mapping.length }) : t(locale, 'import.line.noMapping'));
  parts.push(effectiveCurrency(ctx, options));
  return parts.join(' · ');
}

export function importHeadline(
  checks: ImportIssue[],
  parsed: ParsedTariffImport,
  ctx: TariffImportContext,
  options: TariffImportOptions = {},
  extraLines: string[] = [],
  locale: Locale = DEFAULT_LOCALE,
): ImportHeadline {
  const errors = checks.filter((c) => c.severity === 'error');
  const warnings = checks.filter((c) => c.severity === 'warning');
  if (errors.length) {
    return { status: 'error', title: t(locale, 'import.headline.error'), lines: errors.slice(0, 3).map((c) => c.title) };
  }
  const summary = parsed.rates.length ? importSummaryLine(parsed, ctx, options, locale) : null;
  if (warnings.length) {
    return {
      status: 'warning',
      title: t(locale, 'import.headline.warning', { count: warnings.length }),
      lines: [...warnings.slice(0, 2).map((c) => c.title), ...(summary ? [summary] : [])].slice(0, 3),
    };
  }
  return { status: 'ok', title: t(locale, 'import.headline.ok'), lines: [...(summary ? [summary] : []), ...extraLines].slice(0, 3) };
}

// ---------------------------------------------------------------------------------------------
// Dosya okuma

const sheetKey = (s: string) => norm(s).replace(/\s+/g, ' ');

/**
 * CSV/XLSX → ham tarife dosyası. XLSX'te "Fiyatlar"/"Bölgeler"/"Ek ücretler" sayfaları adından bulunur.
 * Sınırlar (`limits`, yoksa varsayılan; Mesaj 6): XLSX açılmış boyutu (`XLSX_TOO_LARGE`), sayfa/CSV dolu satır sayısı (`TOO_MANY_ROWS`).
 */
export async function readTariffFile(fileName: string, bytes: Uint8Array, limits?: ReadLimits): Promise<RawTariffFile> {
  const format = detectFormat(fileName, bytes);
  if (format === 'csv') {
    const prices = await readCsvMatrix(bytes);
    const maxRows = limits?.maxRows ?? DEFAULT_MAX_ROWS;
    if (prices.filter((r) => r.some((c) => c.trim() !== '')).length > maxRows) throw tooManyRowsError(maxRows);
    return { fileName, kind: 'csv', prices, pricesSheetName: null, zones: null, surcharges: null };
  }
  if (format !== 'xlsx') throw new Error(t('tr', 'import.reason.unsupportedFile'));
  const sheets = await readXlsxSheets(bytes, limits);
  const find = (names: string[]) => sheets.find((s) => names.map(sheetKey).includes(sheetKey(s.name)));
  const nonEmpty = (s: { rows: string[][] }) => s.rows.some((r) => r.some((c) => String(c ?? '').trim() !== ''));
  const prices = find(['Fiyatlar', 'Prices', 'Rates', 'Fiyat']) ?? sheets.find(nonEmpty) ?? null;
  const zones = find(['Bölgeler', 'Bolgeler', 'Zones']);
  const surcharges = find(['Ek ücretler', 'Ek ucretler', 'Surcharges']);
  const pricesNumeric = cellMask(prices?.numeric);
  const pricesPercent = cellMask(prices?.percent);
  return {
    fileName,
    kind: 'xlsx',
    prices: prices ? prices.rows : null,
    pricesSheetName: prices?.name ?? null,
    zones: zones ? zones.rows : null,
    surcharges: surcharges ? surcharges.rows : null,
    sheetNames: sheets.map((s) => s.name),
    ...(pricesNumeric ? { pricesNumeric } : {}),
    ...(pricesPercent ? { pricesPercent } : {}),
  };
}

/** Yapay zekâ için ham satır dökümü: "satırNo: hücre | hücre". Çok uzunsa baş + son. */
export function rawRowsText(sheet: RawSheet | null, maxRows = 400): { text: string; totalRows: number; truncated: boolean } {
  if (!sheet) return { text: '', totalRows: 0, truncated: false };
  const lines: string[] = [];
  sheet.forEach((r, i) => {
    const c = cellsOf(r);
    while (c.length && c[c.length - 1] === '') c.pop();
    if (c.length) lines.push(`${i + 1}: ${c.join(' | ')}`);
  });
  if (lines.length <= maxRows) return { text: lines.join('\n'), totalRows: lines.length, truncated: false };
  const head = Math.floor(maxRows * 0.7);
  const tail = maxRows - head;
  return {
    text: [...lines.slice(0, head), `… (${lines.length - maxRows} satır atlandı) …`, ...lines.slice(-tail)].join('\n'),
    totalRows: lines.length,
    truncated: true,
  };
}
