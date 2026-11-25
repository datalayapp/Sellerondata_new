import { round2, sumMoney } from '../calc';
import { fmtNumber } from '../format';
import { DEFAULT_LOCALE, messages, t as tt, type Locale, type MessageKey } from '../i18n/index';
import { cleanTracking, normalizeTracking } from '../tracking';
import { chargesMatchNet } from './constants';
import { cellNumber, columnMostCommonNumber, parseCountry, parseCurrency, parseRows, resolveNumberFormat, tableWeightAmbiguity } from './parse';
import { MAPPING_FIELDS, META_FIELDS, REQUIRED_MAPPING_FIELDS, type ColumnMapping, type HeaderField, type ParseErrorCode, type ParsedInvoiceLine, type Table } from './types';
import { resolveDateOrder } from './meta';
import { unreadSheetsOf } from './mapping';
import { checkMappingVat } from './vat';
import { fmtLongDay, fmtWeightNumber } from '../format';
import { parseDateAs, type DateOrder, type NumberFormat } from './values';
import { isNumericCell } from './read';

/**
 * Okuma kontrolü (SPEC §11). Eşlemenin her alanı için karar, satır bayrakları ve genel karar üretir.
 * Saf ve deterministiktir; yapay zekâ olsun olmasın her önizlemede ve içe aktarmada çalışır.
 */

export type FieldStatus = 'ok' | 'check' | 'missing';
export type FieldVerdict = { status: FieldStatus; confidence: number; reasons: string[] };

/** Satır bayrakları. `soft` olanlar genel kararı ve içe aktarma onayını etkilemez, yalnızca bilgi verir. */
export type RowFlagCode =
  | 'TRACKING_FORMAT'
  | 'DUPLICATE_TRACKING'
  | 'AMOUNT_PARSE'
  | 'CHARGES_MISMATCH'
  | 'WEIGHT_RANGE'
  | 'DIMS_RANGE'
  | 'DATE_PARSE'
  | 'UNIT_UNKNOWN'
  | 'BILLED_WEIGHT_ODD'
  /** PDF faturada yapay zekânın okuduğu takip no PDF metninde yok (Mesaj 5, `checkPdfLines`). */
  | 'PDF_TRACKING_UNVERIFIED'
  /** PDF faturada okunan net tutar (ya da KDV dahil hâli) PDF metninde yok. */
  | 'PDF_AMOUNT_UNVERIFIED'
  /**
   * Tutarların KDV dahil olup olmadığı belirsiz: büyük PDF'in grupları çelişiyor ya da söylemiyor (Mesaj 7 E1), okunan oran
   * metinde yok (Y20), satır toplamı fatura toplamının öbür KDV kipine eşit ya da satırın penceresinde X ve X ÷ (1 + oran)
   * basılı (05-B2).
   */
  | 'PDF_VAT_UNCLEAR'
  /** Büyük PDF'te satır sayfa sınırında bölünmüş olabilir (sonraki sayfanın ilk satırı takip no'suz ya da aynı takip no). */
  | 'PDF_PAGE_BREAK'
  /** 05-B4: okunan ağırlık (ücretli ve/veya gerçek) PDF metninde satırın penceresinde yok. */
  | 'PDF_WEIGHT_UNVERIFIED'
  /** 05-B4: okunan ölçülerden biri PDF metninde satırın penceresinde yok. */
  | 'PDF_DIMS_UNVERIFIED'
  /** 05-B4: okunan bir ek ücret ya da yakıt tutarı PDF metninde satırın penceresinde yok. */
  | 'PDF_SURCHARGE_UNVERIFIED'
  /**
   * DENETIM-2 01-B8: satırın kendi para birimi faturanınkinden (verilmediyse satırlarda en sık görülenden) farklı. Fatura
   * toplamı, Pano ve itiraz metni satırları faturanın para birimiyle toplar; farklı para birimli satır ayrı faturada yüklenmeli.
   */
  | 'CURRENCY_MISMATCH';

/** Mükerrer takip no bir okuma hatası değil fatura bulgusudur (karşılaştırma DUPLICATE olarak işaretler); bilgi amaçlı. */
export const SOFT_ROW_FLAGS: RowFlagCode[] = ['BILLED_WEIGHT_ODD', 'DUPLICATE_TRACKING'];

/** Sert bayraklar: içe aktarma onayını, "Kontrol edilecek" sayısını ve satır rozetini belirler. */
export const HARD_ROW_FLAGS: RowFlagCode[] = [
  'TRACKING_FORMAT',
  'AMOUNT_PARSE',
  'CHARGES_MISMATCH',
  'WEIGHT_RANGE',
  'DIMS_RANGE',
  'DATE_PARSE',
  'UNIT_UNKNOWN',
  'PDF_TRACKING_UNVERIFIED',
  'PDF_AMOUNT_UNVERIFIED',
  'PDF_VAT_UNCLEAR',
  'PDF_PAGE_BREAK',
  'PDF_WEIGHT_UNVERIFIED',
  'PDF_DIMS_UNVERIFIED',
  'PDF_SURCHARGE_UNVERIFIED',
  'CURRENCY_MISMATCH',
];

/** Kullanıcıya gösterilen sade Türkçe açıklamalar. */
export const ROW_FLAG_LABELS: Record<RowFlagCode, string> = {
  TRACKING_FORMAT: tt('tr', 'verify.flag.TRACKING_FORMAT'),
  DUPLICATE_TRACKING: tt('tr', 'verify.flag.DUPLICATE_TRACKING'),
  AMOUNT_PARSE: tt('tr', 'verify.flag.AMOUNT_PARSE'),
  CHARGES_MISMATCH: tt('tr', 'verify.flag.CHARGES_MISMATCH'),
  WEIGHT_RANGE: tt('tr', 'verify.flag.WEIGHT_RANGE'),
  DIMS_RANGE: tt('tr', 'verify.flag.DIMS_RANGE'),
  DATE_PARSE: tt('tr', 'verify.flag.DATE_PARSE'),
  UNIT_UNKNOWN: tt('tr', 'verify.flag.UNIT_UNKNOWN'),
  BILLED_WEIGHT_ODD: tt('tr', 'verify.flag.BILLED_WEIGHT_ODD'),
  PDF_TRACKING_UNVERIFIED: tt('tr', 'verify.flag.PDF_TRACKING_UNVERIFIED'),
  PDF_AMOUNT_UNVERIFIED: tt('tr', 'verify.flag.PDF_AMOUNT_UNVERIFIED'),
  PDF_VAT_UNCLEAR: tt('tr', 'verify.flag.PDF_VAT_UNCLEAR'),
  PDF_PAGE_BREAK: tt('tr', 'verify.flag.PDF_PAGE_BREAK'),
  PDF_WEIGHT_UNVERIFIED: tt('tr', 'verify.flag.PDF_WEIGHT_UNVERIFIED'),
  PDF_DIMS_UNVERIFIED: tt('tr', 'verify.flag.PDF_DIMS_UNVERIFIED'),
  PDF_SURCHARGE_UNVERIFIED: tt('tr', 'verify.flag.PDF_SURCHARGE_UNVERIFIED'),
  CURRENCY_MISMATCH: tt('tr', 'verify.flag.CURRENCY_MISMATCH'),
};

/** `ROW_FLAG_LABELS` istenen dilde. */
export function rowFlagLabel(code: RowFlagCode, locale: Locale = DEFAULT_LOCALE): string {
  return tt(locale, `verify.flag.${code}`);
}

export type RowFlag = { rowIndex: number; trackingNo?: string; codes: RowFlagCode[] };

export type MappingVerification = {
  verdict: 'ok' | 'check';
  /** Eşlenen her başlık alanı ve eşlenmemiş zorunlu alanlar. */
  fields: Partial<Record<HeaderField, FieldVerdict>>;
  /** Bayraklı satırlar (rowIndex = tablodaki 0 tabanlı veri satırı). */
  rowFlags: RowFlag[];
  /** Sert (soft olmayan) bayrağı olan satır sayısı. */
  flaggedRows: number;
  flagCounts: Partial<Record<RowFlagCode, number>>;
  checks: {
    tracking: { filled: number; total: number; formatOk: number; unique: number };
    charges: { rowsChecked: number; rowsMatching: number };
    invoiceTotal: { value: number; linesTotal: number; difference: number } | null;
    billedWeight: { rowsChecked: number; rowsOdd: number; divisor: number };
  };
  /** Açık sorunlar (Türkçe, kullanıcıya gösterilebilir). Karar `ok` ise boş. */
  issues: string[];
};

export type VerifyOptions = {
  /** Hacim böleni (eşleme/satır böleni yoksa). Varsayılan 5000. */
  divisor?: number;
  numberFormat?: NumberFormat;
  dateOrder?: DateOrder;
  /** parseRows sonucu verildiyse yeniden okunmaz. */
  lines?: ParsedInvoiceLine[];
  /** `code` verilmezse (eski çağıran) ileti metninden çıkarılır. */
  errors?: { rowIndex: number; code?: ParseErrorCode; message: string }[];
  /** Yalnız sebep ve sorun metinleri; kararlar, güven ve bayraklar her dilde aynı. */
  locale?: Locale;
  /** Faturanın para birimi (içe aktarmada belli); verilmezse satırlarda en sık görülen (01-B8, `CURRENCY_MISMATCH`). */
  invoiceCurrency?: string;
};

/**
 * Satır para birimlerinin karşılaştırılacağı para birimi (01-B8): faturanınki verildiyse o, yoksa satırlarda en sık görülen
 * (eşitlikte ilk görülen; önizlemede faturanın para birimi de böyle tahmin edilir). Satırlarda para birimi yoksa null.
 */
export function referenceCurrency(lines: readonly Pick<ParsedInvoiceLine, 'currency'>[], invoiceCurrency?: string | null): string | null {
  const given = currencyCode(invoiceCurrency);
  if (given) return given;
  const counts = new Map<string, number>();
  for (const l of lines) {
    const c = currencyCode(l.currency);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [c, k] of counts) if (k > n) [best, n] = [c, k];
  return best;
}

/**
 * Para birimi yazımı karşılaştırma için: tanınan yazım ISO koduna ("TL", "₺", "tl", "Türk Lirası" → TRY; "€" → EUR;
 * `parseCurrency`), tanınmayan büyük harfe (farklı sayılır). Harfsiz yazım ("-") yazılmamış sayılır. PDF satırında yapay
 * zekânın yazdığı "TL" faturanın "TRY"sinden farklı sayılmaz. API PDF satırının para birimini de bununla saklar.
 */
export function currencyCode(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  if (!s || !/[\p{L}₺€$£¥]/u.test(s)) return undefined;
  return parseCurrency(s) ?? s.toUpperCase();
}

/** Satırın kendi para birimi yazılı ve `reference`'tan farklı mı. */
const currencyDiffers = (l: Pick<ParsedInvoiceLine, 'currency'>, reference: string | null) => {
  const c = currencyCode(l.currency);
  return !!c && !!reference && c !== reference;
};

const TRACKING_RE = /^[A-Z0-9]{8,35}$/;
const LENGTH_UNIT_RE = /^(c|cm|cms|santim|santimetre|i|in|inch|inches|inc|inç|ınç)$/;
const WEIGHT_UNIT_RE = /^(k|kg|kgs|kilo|kilogram|l|lb|lbs|pound|pounds)$/;
const MAX_KG = 1000;
const MIN_CM = 1;
const MAX_CM = 300;

function unitWord(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-zçı]/g, '');
}
export function isKnownLengthUnit(v: string): boolean {
  return LENGTH_UNIT_RE.test(unitWord(v));
}
export function isKnownWeightUnit(v: string): boolean {
  return WEIGHT_UNIT_RE.test(unitWord(v));
}

export function trackingLooksValid(raw: string): boolean {
  return TRACKING_RE.test(cleanTracking(raw));
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * KALANLAR 1.13: Excel'in bilimsel yazıma çevirdiği takip no ("1,23457E+11", "7.94612E+11"). Excel 11 haneden uzun sayıyı
 * böyle gösterir ve CSV'yi böyle kaydeder; hanelerin çoğu kaybolur, numara hiçbir ölçümle eşleşmez ve geri alınamaz.
 * Gerçek takip no'da "+" bulunmaz.
 */
const SCIENTIFIC_TRACKING = /^[+-]?\d+(?:[.,]\d+)?E\+\d{1,3}$/i;

export function isScientificTracking(raw: string): boolean {
  return SCIENTIFIC_TRACKING.test(String(raw ?? '').replace(/\s+/g, ''));
}

/** Takip no sütununda bilimsel yazıma dönmüş hücreler: satır sayısı ve ilk örnek. Yoksa null. */
export function scientificTrackingRows(t: Pick<Table, 'headers' | 'rows'>, m: Pick<ColumnMapping, 'trackingNo'>): { count: number; sample: string } | null {
  const i = m.trackingNo ? t.headers.indexOf(m.trackingNo) : -1;
  if (i < 0) return null;
  let count = 0;
  let sample = '';
  for (const r of t.rows) {
    const v = String(r[i] ?? '').trim();
    if (!v || !isScientificTracking(v)) continue;
    count++;
    sample ||= v;
  }
  return count ? { count, sample } : null;
}

/** Excel'in sayıda sakladığı anlamlı hane sayısı: 16. haneden sonrası sıfırlanır. */
const EXCEL_DIGITS = 15;
const LONG_DIGITS = /^\d{16,}$/;

/**
 * KALANLAR 5.19 (B4.20): Excel'in sayıya çevirdiği uzun takip no. Excel 15 haneden sonrasını sıfırlar (19 haneli iki farklı
 * numara aynı sayı olur); değer geri alınamaz ve düzeltilmez, yalnız uyarılır.
 * - XLSX gerçek sayı hücresi, 16+ hane: kesin işaret (hücrenin metni `numberToCell` çıktısı, rakamlardan oluşur).
 * - Metin hücresi (Excel'de kaydedilmiş CSV), 16+ hane ve 15. haneden sonrası hep sıfır: Excel'in izi. Gerçek uzun numaralarda
 *   bu tesadüfen olabilir; bu yüzden ancak sütundaki 16+ haneli metin numaraların en az yarısı böyleyse sayılır.
 * Bilimsel yazım (`scientificTrackingRows`) ayrı uyarıdır, burada sayılmaz. Baştaki düşen sıfırlar değerden anlaşılmaz;
 * eşleşme onları sonek kuralıyla yakalar (`trackingMatchLevel`).
 */
export function excelNumberTrackingRows(t: Pick<Table, 'headers' | 'rows' | 'numeric'>, m: Pick<ColumnMapping, 'trackingNo'>): { count: number; sample: string } | null {
  const i = m.trackingNo ? t.headers.indexOf(m.trackingNo) : -1;
  if (i < 0) return null;
  let numeric = 0;
  let numericSample = '';
  let longText = 0;
  let zeroTail = 0;
  let zeroSample = '';
  t.rows.forEach((r, ri) => {
    const v = String(r[i] ?? '').trim();
    if (!LONG_DIGITS.test(v)) return;
    if (isNumericCell(t, ri, i)) {
      numeric++;
      numericSample ||= v;
      return;
    }
    longText++;
    if (/^0+$/.test(v.slice(EXCEL_DIGITS))) {
      zeroTail++;
      zeroSample ||= v;
    }
  });
  const text = zeroTail > 0 && zeroTail * 2 >= longText ? zeroTail : 0;
  const count = numeric + text;
  return count ? { count, sample: numericSample || zeroSample } : null;
}

function rate(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

/** Ücretli ağırlık beklenen aralıkta mı? `expected = max(gerçek, hacimsel)`; yuvarlama basamağına ve desiye pay bırakılır. */
export function billedWeightPlausible(billed: number, actual: number | undefined, volumetric: number): boolean {
  const expected = Math.max(actual ?? 0, volumetric);
  if (expected <= 0) return true;
  const low = expected - Math.max(0.5, expected * 0.05);
  const high = Math.ceil(expected) + Math.max(1, expected * 0.1);
  return billed >= low && billed <= high;
}

function addFlag(map: Map<number, RowFlag>, rowIndex: number, code: RowFlagCode, trackingNo?: string) {
  let f = map.get(rowIndex);
  if (!f) {
    f = { rowIndex, ...(trackingNo ? { trackingNo } : {}), codes: [] };
    map.set(rowIndex, f);
  }
  if (!f.codes.includes(code)) f.codes.push(code);
}

/**
 * Okunan satırlar için bayraklar (PDF/yapay zekâ satırlarında da kullanılır). Tablo tabanlı kontroller
 * (birim hücresi, tarih hücresi, okunamayan tutar) `verifyMapping` içinde eklenir.
 */
export function flagParsedLines(
  lines: ParsedInvoiceLine[],
  opts: { divisor?: number; desiAsWeight?: boolean; vatFactor?: number; invoiceCurrency?: string | null } = {},
): RowFlag[] {
  const map = new Map<number, RowFlag>();
  const seen = new Set<string>();
  const divisorFallback = opts.divisor && opts.divisor > 0 ? opts.divisor : 5000;
  const currency = referenceCurrency(lines, opts.invoiceCurrency);
  for (const l of [...lines].sort((a, b) => a.rowIndex - b.rowIndex)) {
    const t = normalizeTracking(l.trackingNo);
    if (!TRACKING_RE.test(cleanTracking(l.trackingNo))) addFlag(map, l.rowIndex, 'TRACKING_FORMAT', t);
    if (seen.has(t)) addFlag(map, l.rowIndex, 'DUPLICATE_TRACKING', t);
    seen.add(t);
    for (const kg of [l.actualKg, l.billedKg]) if (kg != null && (kg < 0 || kg > MAX_KG)) addFlag(map, l.rowIndex, 'WEIGHT_RANGE', t);
    if (l.dims && [l.dims.l, l.dims.w, l.dims.h].some((e) => e < MIN_CM || e > MAX_CM)) addFlag(map, l.rowIndex, 'DIMS_RANGE', t);
    if (l.baseAmount != null && !chargesMatchNet(l, opts.vatFactor)) addFlag(map, l.rowIndex, 'CHARGES_MISMATCH', t);
    if (!opts.desiAsWeight && l.dims && l.billedKg != null && l.billedKg > 0) {
      const div = l.billedDivisor && l.billedDivisor > 0 ? l.billedDivisor : divisorFallback;
      const vol = (l.dims.l * l.dims.w * l.dims.h) / div;
      if (!billedWeightPlausible(l.billedKg, l.actualKg, vol)) addFlag(map, l.rowIndex, 'BILLED_WEIGHT_ODD', t);
    }
    if (currencyDiffers(l, currency)) addFlag(map, l.rowIndex, 'CURRENCY_MISMATCH', t);
  }
  return [...map.values()];
}

/** Yalnız sert bayraklar. */
export function hardFlags(codes: readonly string[]): string[] {
  return codes.filter((c) => !SOFT_ROW_FLAGS.includes(c as RowFlagCode));
}

type Col = { idx: number; values: string[] };

/** `parseRows` hata kodu → satır bayrağı (sütun hataları satır bayrağı değildir). */
const ERROR_FLAG: Record<ParseErrorCode, RowFlagCode | null> = {
  NO_TRACKING_COLUMN: null,
  NO_NET_COLUMN: null,
  BAD_TRACKING: 'TRACKING_FORMAT',
  BAD_NET: 'AMOUNT_PARSE',
  BAD_DATE: 'DATE_PARSE',
};

/** Kodsuz (eski) hata iletisinden kod: TR ve EN `parseRows` iletileri. Yeni kod `code` alanını kullanır. */
function errorCodeFromMessage(message: string): ParseErrorCode | null {
  if (/takip no/i.test(message) || /^Row \d+: invalid tracking no /.test(message)) return 'BAD_TRACKING';
  if (/tutar/i.test(message) || /^Row \d+: net amount could not be read /.test(message)) return 'BAD_NET';
  if (/tarih/i.test(message) || /^Row \d+: date could not be read /.test(message)) return 'BAD_DATE';
  return null;
}

/**
 * Eşlemeyi tablonun tüm satırlarında doğrular. `lines` verilmezse `parseRows` ile okunur
 * (çağıran `parseRows` sonucunu geçirerek ikinci okumadan kaçınabilir).
 */
export function verifyMapping(t: Table, m: ColumnMapping, opts: VerifyOptions = {}): MappingVerification {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const n = (x: number) => fmtNumber(x, 0, locale);
  const msg = (key: MessageKey, params?: Record<string, string | number>) => tt(locale, key, params);
  const numFmt: NumberFormat = opts.numberFormat ?? resolveNumberFormat(t, m).format;
  const dateReading = resolveDateOrder(t, m);
  const dateOrder: DateOrder = opts.dateOrder ?? dateReading.order;
  const parsed = opts.lines ? { lines: opts.lines, errors: opts.errors ?? [] } : parseRows(t, m);
  const { lines, errors } = parsed;
  const divisor = opts.divisor && opts.divisor > 0 ? opts.divisor : 5000;

  const col = (h: string | undefined): Col | null => {
    if (!h) return null;
    const idx = t.headers.indexOf(h);
    if (idx < 0) return null;
    return { idx, values: t.rows.map((r) => String(r[idx] ?? '').trim()) };
  };

  const trk = col(m.trackingNo);
  // Satır adayları: takip no hücresi dolu satırlar (toplam satırları dahil olabilir; okunan satırlar ayrıca sayılır).
  const candidateRows = trk ? trk.values.map((v, i) => (v ? i : -1)).filter((i) => i >= 0) : [];
  const lineRows = new Set(lines.map((l) => l.rowIndex));
  const denom = Math.max(lines.length, 1);
  const total = t.rows.length;

  const flags = new Map<number, RowFlag>();
  const vatFactor = m.amountsIncludeVat ? 1 + (m.vatPct ?? 20) / 100 : 1;
  const currency = referenceCurrency(lines, opts.invoiceCurrency);
  for (const f of flagParsedLines(lines, { divisor, desiAsWeight: m.desiAsWeight, vatFactor, invoiceCurrency: currency })) flags.set(f.rowIndex, { ...f, codes: [...f.codes] });
  for (const e of errors) {
    if (e.rowIndex < 0) continue;
    const raw = trk?.values[e.rowIndex] ?? '';
    const code = e.code ?? errorCodeFromMessage(e.message);
    const flag = code ? ERROR_FLAG[code] : null;
    if (flag) addFlag(flags, e.rowIndex, flag, normalizeTracking(raw) || undefined);
  }
  const trackingOf = (i: number) => (trk?.values[i] ? normalizeTracking(trk.values[i]!) : undefined);
  // 01-B8: para birimi hücresi dolu ama tanınmıyor ("Fr."): satır sessizce faturanın para birimini alırdı. Sütunun başka
  // satırında tanınan para birimi varsa (sütun gerçekten para birimi) bu satır da faturanınkinden farklı sayılır. Harfsiz
  // hücre ("-") yazılmamış sayılır. Satır no → hücrenin yazısı (sorun metni için).
  const unknownCurrency = new Map<number, string>();
  const curCol = col(m.currency);
  if (curCol && lines.some((l) => l.currency)) {
    for (const l of lines) {
      const raw = curCol.values[l.rowIndex];
      if (!l.currency && raw && /[\p{L}₺€$£¥]/u.test(raw)) {
        unknownCurrency.set(l.rowIndex, raw.toUpperCase().slice(0, 20));
        addFlag(flags, l.rowIndex, 'CURRENCY_MISMATCH', trackingOf(l.rowIndex));
      }
    }
  }

  const fields: Partial<Record<HeaderField, FieldVerdict>> = {};
  const set = (f: HeaderField, status: FieldStatus, confidence: number, reasons: string[]) => {
    fields[f] = { status, confidence: Math.max(0, Math.min(1, round2(confidence))), reasons };
  };

  /** Satır alanlarında doluluk: okunan satırlar üzerinden. */
  const fillOn = (c: Col) => {
    let filled = 0;
    for (const i of lineRows) if (c.values[i]) filled++;
    return filled;
  };

  // ---- Takip no ----
  let trackingStats = { filled: 0, total, formatOk: 0, unique: 0 };
  if (trk) {
    const filledVals = candidateRows.map((i) => trk.values[i]!);
    const formatOk = filledVals.filter(trackingLooksValid).length;
    const unique = new Set(filledVals.map(normalizeTracking)).size;
    trackingStats = { filled: filledVals.length, total, formatOk, unique };
    const fill = rate(filledVals.length, total);
    const fmt = rate(formatOk, filledVals.length);
    const uniq = rate(unique, filledVals.length);
    const reasons: string[] = [msg('verify.filled', { filled: n(filledVals.length), total: n(total) })];
    let status: FieldStatus = 'ok';
    if (filledVals.length === 0) {
      status = 'check';
      reasons[0] = msg('verify.columnEmptyAll');
    } else {
      reasons.push(msg('verify.valuesAre', { pct: pct(formatOk, filledVals.length), what: msg('verify.what.trackingFormat') }));
      if (fmt < 0.9) status = 'check';
      // Tek bir mükerrer satır (küçük faturada %80'in altına düşürse de) fatura bulgusudur, okuma hatası değil.
      if (filledVals.length >= 3 && uniq < 0.8 && filledVals.length - unique >= 2) {
        status = 'check';
        reasons.push(msg('verify.fewDistinct', { count: n(unique) }));
      }
      if (fill < 0.8 && total >= 5) {
        status = 'check';
        reasons.push(msg('verify.mostlyEmpty'));
      }
    }
    set('trackingNo', status, filledVals.length ? Math.min(fmt, uniq, Math.max(fill, 0.5)) : 0, reasons);
  }

  // ---- Net tutar ----
  const net = col(m.netAmount);
  let chargesChecked = 0;
  let chargesMatching = 0;
  for (const l of lines) {
    if (l.baseAmount == null) continue;
    chargesChecked++;
    if (chargesMatchNet(l, vatFactor)) chargesMatching++;
  }
  const netTotal = sumMoney(lines.map((l) => l.netAmount));
  let invoiceTotal: MappingVerification['checks']['invoiceTotal'] = null;
  const totCol = col(m.invoiceTotal);
  if (totCol) {
    const value = columnMostCommonNumber(t, m.invoiceTotal, numFmt);
    if (value != null) invoiceTotal = { value, linesTotal: netTotal, difference: round2(netTotal - value) };
  }
  // KDV dahil tutarlar satırda düşüldüyse fatura toplamı KDV dahil olabilir: iki yolu da kabul et.
  const totalOk = invoiceTotal
    ? Math.abs(invoiceTotal.difference) <= 1 || (vatFactor !== 1 && Math.abs(round2(netTotal * vatFactor) - invoiceTotal.value) <= 1)
    : null;
  if (net) {
    const cand = candidateRows;
    let filled = 0;
    let parsed = 0;
    const distinct = new Set<string>();
    for (const i of cand) {
      const v = net.values[i]!;
      if (!v) continue;
      filled++;
      distinct.add(v);
      if (cellNumber(t, i, net.idx, v, numFmt) != null) parsed++;
    }
    const reasons: string[] = [msg('verify.filled', { filled: n(filled), total: n(cand.length) })];
    let status: FieldStatus = 'ok';
    let conf = rate(parsed, Math.max(filled, 1));
    if (filled === 0) {
      status = 'check';
      conf = 0;
      reasons[0] = msg('verify.columnEmptyTracked');
    } else {
      if (parsed < filled) {
        status = 'check';
        reasons.push(msg('verify.unparsedNumbers', { count: n(filled - parsed) }));
      }
      if (filled >= 5 && distinct.size === 1) {
        status = 'check';
        conf = Math.min(conf, 0.3);
        reasons.push(msg('verify.sameValue'));
      }
      if (rate(filled, cand.length) < 0.9) {
        status = 'check';
        conf = Math.min(conf, rate(filled, cand.length));
      }
    }
    if (chargesChecked > 0) {
      reasons.push(msg('verify.chargesMatch', { matching: n(chargesMatching), checked: n(chargesChecked) }));
      if (chargesMatching < chargesChecked) {
        status = 'check';
        conf = Math.min(conf, rate(chargesMatching, chargesChecked));
      }
    }
    if (invoiceTotal) {
      if (totalOk) reasons.push(msg('verify.totalOk'));
      else {
        status = 'check';
        conf = Math.min(conf, 0.5);
        reasons.push(msg('verify.totalDiff', { diff: fmtNumber(invoiceTotal.difference, 2, locale) }));
      }
    }
    // 1.3: ayrı KDV sütunu varsa "Tutarlar KDV dahil" seçimi ve oranı satırlarla sınanır; uymuyorsa ya da anlaşılmıyorsa sorulur.
    const vat = filled > 0 ? checkMappingVat(t, m, numFmt) : null;
    if (vat?.problem) {
      status = 'check';
      conf = Math.min(conf, 0.5);
      const pctText = (p: number) => fmtNumber(p, Number.isInteger(p) ? 0 : 2, locale);
      const mapped = m.vatPct ?? 20;
      reasons.push(msg(`verify.vat.${vat.problem}`, { column: vat.evidence.vatColumn, pct: pctText(vat.evidence.pct ?? mapped), mapped: pctText(mapped), zero: n(vat.evidence.zeroRows) }));
    }
    set('netAmount', status, conf, reasons);
  }

  // ---- Diğer alanlar ----
  /** `row`, `col`: hücrenin yeri (XLSX'in gerçek sayı hücresi biçime bakılmadan okunur, 01-B4). */
  type Check = { ok: (v: string, row: number, col: number) => boolean; what: string; min?: number };
  const numIn = (lo: number, hi: number) => (v: string, row: number, c: number) => {
    const x = cellNumber(t, row, c, v, numFmt);
    return x != null && x >= lo && x <= hi;
  };
  const isNum = (v: string, row: number, c: number) => cellNumber(t, row, c, v, numFmt) != null;
  const checks: Partial<Record<HeaderField, Check>> = {
    shipDate: { ok: (v) => parseDateAs(v, dateOrder) != null, what: msg('verify.what.date'), min: 0.95 },
    destCountry: { ok: (v) => parseCountry(v) != null, what: msg('verify.what.country'), min: 0.8 },
    actualKg: { ok: numIn(0, MAX_KG), what: msg('verify.what.kgRange'), min: 0.95 },
    billedKg: { ok: numIn(0, m.desiAsWeight ? 10000 : MAX_KG), what: m.desiAsWeight ? msg('verify.what.number') : msg('verify.what.kgRange'), min: 0.95 },
    dimL: { ok: numIn(MIN_CM, MAX_CM + 0.0001), what: msg('verify.what.cmRange'), min: 0.95 },
    dimW: { ok: numIn(MIN_CM, MAX_CM + 0.0001), what: msg('verify.what.cmRange'), min: 0.95 },
    dimH: { ok: numIn(MIN_CM, MAX_CM + 0.0001), what: msg('verify.what.cmRange'), min: 0.95 },
    dims: { ok: (v) => /\d\s*[x×*X]\s*\d.*[x×*X]\s*\d/.test(v), what: msg('verify.what.dims'), min: 0.9 },
    billedDivisor: { ok: numIn(1000, 10000), what: msg('verify.what.divisor'), min: 0.95 },
    baseAmount: { ok: isNum, what: msg('verify.what.number'), min: 0.95 },
    discountAmount: { ok: isNum, what: msg('verify.what.number'), min: 0.95 },
    fuelAmount: { ok: isNum, what: msg('verify.what.number'), min: 0.95 },
    currency: { ok: (v) => parseCurrency(v) != null, what: msg('verify.what.currency'), min: 0.9 },
    dimUnit: { ok: isKnownLengthUnit, what: msg('verify.what.lengthUnit'), min: 0.95 },
    actualKgUnit: { ok: isKnownWeightUnit, what: msg('verify.what.weightUnit'), min: 0.95 },
    billedKgUnit: { ok: isKnownWeightUnit, what: msg('verify.what.weightUnit'), min: 0.95 },
  };
  // Ölçü kenarları birim sütunu inç olabilir: aralığı cm'ye çevrilmiş satırlardan kontrol etmek için okunan satırlar kullanılır.
  const dimsFromLines = lines.filter((l) => l.dims).length;

  for (const f of MAPPING_FIELDS) {
    if (f === 'trackingNo' || f === 'netAmount') continue;
    const c = col(m[f]);
    if (!m[f]) continue;
    if (!c) {
      set(f, 'check', 0, [msg('verify.columnMissing')]);
      continue;
    }
    if (lines.length === 0) {
      set(f, 'check', 0.5, [msg('verify.noLinesYet')]);
      continue;
    }
    const filled = fillOn(c);
    const reasons = [msg('verify.filled', { filled: n(filled), total: n(lines.length) })];
    if (lines.length > 0 && filled === 0) {
      set(f, 'check', 0.2, [msg('verify.columnEmptyLines')]);
      continue;
    }
    const chk = checks[f];
    let status: FieldStatus = 'ok';
    let conf = lines.length ? Math.max(0.6, rate(filled, denom)) : 0.5;
    if (chk && filled > 0) {
      let good = 0;
      for (const i of lineRows) {
        const v = c.values[i];
        if (v && chk.ok(v, i, c.idx)) good++;
      }
      // Ölçü kenarları inç olabilir: okunan (cm'ye çevrilmiş) ölçülerden aralık kontrolü.
      if ((f === 'dimL' || f === 'dimW' || f === 'dimH') && dimsFromLines > 0) {
        const key = f === 'dimL' ? 'l' : f === 'dimW' ? 'w' : 'h';
        good = lines.filter((l) => l.dims && l.dims[key] >= MIN_CM && l.dims[key] <= MAX_CM).length;
      }
      const r = rate(good, filled);
      reasons.push(msg('verify.valuesAre', { pct: pct(good, filled), what: chk.what }));
      conf = Math.min(conf, r);
      if (r < (chk.min ?? 0.95)) status = 'check';
    }
    set(f, status, conf, reasons);
  }

  // Ücretli ağırlık ↔ max(gerçek, hacimsel): yumuşak kontrol, çoğu satır uyuşmazsa alan "kontrol edin" olur.
  let bwChecked = 0;
  let bwOdd = 0;
  if (!m.desiAsWeight) {
    for (const l of lines) {
      if (!l.dims || l.billedKg == null || l.billedKg <= 0) continue;
      bwChecked++;
      const div = l.billedDivisor && l.billedDivisor > 0 ? l.billedDivisor : divisor;
      if (!billedWeightPlausible(l.billedKg, l.actualKg, (l.dims.l * l.dims.w * l.dims.h) / div)) bwOdd++;
    }
  }
  if (bwChecked > 0 && fields.billedKg) {
    const fv = fields.billedKg;
    // Yumuşak kontrol: alan kararını değiştirmez (taşıyıcı hacimsel ağırlığı her gönderide uygulamayabilir).
    fv.reasons.push(msg('verify.billedPlausible', { ok: n(bwChecked - bwOdd), checked: n(bwChecked) }));
  }

  // Satır düzeyinde tablo kontrolleri: tarih hücresi, birim hücreleri.
  const dateCol = col(m.shipDate);
  const unitCols = [
    { c: col(m.dimUnit), ok: isKnownLengthUnit },
    { c: col(m.actualKgUnit), ok: isKnownWeightUnit },
    { c: col(m.billedKgUnit), ok: isKnownWeightUnit },
  ];
  for (const i of lineRows) {
    const d = dateCol?.values[i];
    if (d && parseDateAs(d, dateOrder) == null) addFlag(flags, i, 'DATE_PARSE', trackingOf(i));
    for (const u of unitCols) {
      const v = u.c?.values[i];
      if (v && !u.ok(v)) addFlag(flags, i, 'UNIT_UNKNOWN', trackingOf(i));
    }
  }

  // ---- Meta alanlar ----
  for (const f of META_FIELDS) {
    const c = col(m[f]);
    if (!m[f]) continue;
    if (!c) {
      set(f, 'check', 0, [msg('verify.columnMissing')]);
      continue;
    }
    const vals = c.values.filter(Boolean);
    const distinct = new Set(vals).size;
    const reasons = [msg('verify.filled', { filled: n(vals.length), total: n(total) })];
    let status: FieldStatus = vals.length ? 'ok' : 'check';
    let conf = vals.length ? 0.9 : 0;
    if (distinct > 1) reasons.push(msg('verify.distinct', { count: n(distinct) }));
    if (f === 'invoiceDate' && vals.length) {
      const ok = vals.filter((v) => parseDateAs(v, dateOrder) != null).length;
      reasons.push(msg('verify.valuesAre', { pct: pct(ok, vals.length), what: msg('verify.what.date') }));
      if (ok < vals.length) status = 'check';
    }
    if (f === 'invoiceTotal' && invoiceTotal) {
      if (totalOk) {
        reasons.push(msg('verify.metaTotalOk'));
        conf = 1;
      } else {
        status = 'check';
        conf = 0.4;
        reasons.push(msg('verify.metaTotalDiff', { diff: fmtNumber(invoiceTotal.difference, 2, locale) }));
      }
    }
    set(f, status, conf, reasons);
  }

  // ---- Zorunlu ama eşlenmemiş ----
  for (const f of REQUIRED_MAPPING_FIELDS) {
    if (!m[f]) set(f, 'missing', 0, [msg('verify.notSelected')]);
  }

  const rowFlags = [...flags.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  const flagCounts: Partial<Record<RowFlagCode, number>> = {};
  for (const r of rowFlags) for (const c of r.codes) flagCounts[c] = (flagCounts[c] ?? 0) + 1;
  const flaggedRows = rowFlags.filter((r) => hardFlags(r.codes).length > 0).length;

  const issues: string[] = [];
  const label = (f: HeaderField) => {
    const key = `verify.field.${f}` as MessageKey;
    return key in messages.tr ? msg(key) : f;
  };
  for (const f of REQUIRED_MAPPING_FIELDS) {
    const v = fields[f];
    if (v?.status === 'missing') issues.push(msg('verify.issue.notSelected', { field: label(f) }));
  }
  for (const [f, v] of Object.entries(fields) as [HeaderField, FieldVerdict][]) {
    if (v.status === 'check') issues.push(msg('verify.issue.field', { field: label(f), reasons: v.reasons.join(', ') }));
  }
  if (lines.length === 0 && t.rows.length > 0 && m.trackingNo && m.netAmount) issues.push(msg('verify.issue.noLines'));
  // 1.6: XLSX'in öbür sayfalarında gönderi satırı var ama okunmadı: o satırlar faturaya girmez, onay ister.
  const unreadInvoiceSheets = t.sheets ? unreadSheetsOf(t, m).filter((s) => s.invoiceLike) : [];
  if (unreadInvoiceSheets.length) {
    const sheets = unreadInvoiceSheets.map((s) => msg('verify.issue.sheetPart', { name: s.name, count: n(s.rows) })).join(', ');
    issues.push(msg('verify.issue.sheetsNotRead', { sheets, read: t.sheets!.read }));
  }
  // 1.13: Excel'in bozduğu takip no'lar geri alınamaz; ne yapılacağı söylenir (içe aktarma da reddeder).
  const scientific = scientificTrackingRows(t, m);
  if (scientific) issues.push(msg('verify.issue.trackingScientific', { count: n(scientific.count), sample: scientific.sample }));
  // 5.19: Excel'in sayıya çevirdiği uzun takip no'nun son haneleri bozulmuş olabilir; tek uyarı, onay ister (değer düzeltilmez).
  if (excelNumberTrackingRows(t, m)) issues.push(msg('verify.issue.trackingExcelNumber'));
  // Sessizce gün/ay okumak dönemi, kuru ve itiraz süresini yanlış yazar: seçim yapılana dek onay ister.
  if (dateReading.ambiguous && m.dateOrder !== 'dmy' && m.dateOrder !== 'mdy') {
    const { sample, dmy, mdy } = dateReading.ambiguous;
    issues.push(msg('verify.issue.dateAmbiguous', { sample, dmy: fmtLongDay(dmy, locale), mdy: fmtLongDay(mdy, locale) }));
  }
  // K36: "1.500" ağırlık 1,5 kg da 1500 kg da olabilir; dosyanın sayı biçimi seçilene dek onay ister (sessizce seçilmez).
  // Seçim yalnız ağırlığı belirler (`weightFormat`); dosyanın sayı biçimi ipucu (`numberFormat`) bu soruyu cevaplamaz.
  const weightAmbiguity = m.weightFormat === 'tr' || m.weightFormat === 'en' ? null : tableWeightAmbiguity(t, m);
  if (weightAmbiguity) {
    const { sample, rows, decimal, thousands } = weightAmbiguity;
    issues.push(
      msg('verify.issue.weightAmbiguous', { sample, count: n(rows), decimal: fmtWeightNumber(decimal, locale), thousands: fmtNumber(thousands, 0, locale) }),
    );
  }
  // Para birimi farkı okuma sorunu değildir, kendi metniyle söylenir (01-B8); genel "okuma sorunu" metninde sayılmaz.
  const readingFlagged = rowFlags.filter((r) => hardFlags(r.codes).some((c) => c !== 'CURRENCY_MISMATCH')).length;
  if (readingFlagged > 0) {
    const parts = (Object.entries(flagCounts) as [RowFlagCode, number][])
      .filter(([c]) => !SOFT_ROW_FLAGS.includes(c) && c !== 'CURRENCY_MISMATCH')
      .map(([c, k]) => msg('verify.issue.flagItem', { label: rowFlagLabel(c, locale).toLocaleLowerCase(locale), count: n(k) }));
    issues.push(msg('verify.issue.flagged', { count: n(readingFlagged), parts: parts.join('; ') }));
  }
  const mismatched = lines.filter((l) => currencyDiffers(l, currency) || unknownCurrency.has(l.rowIndex));
  if (mismatched.length && currency) {
    const byCurrency = new Map<string, number>();
    for (const l of mismatched) {
      const c = unknownCurrency.get(l.rowIndex) ?? currencyCode(l.currency)!;
      byCurrency.set(c, (byCurrency.get(c) ?? 0) + 1);
    }
    const parts = [...byCurrency].map(([c, k]) => msg('verify.issue.currencyPart', { count: n(k), currency: c }));
    issues.push(msg('verify.issue.currencyMismatch', { count: n(mismatched.length), parts: parts.join(', '), invoice: currency }));
  }

  return {
    verdict: issues.length ? 'check' : 'ok',
    fields,
    rowFlags,
    flaggedRows,
    flagCounts,
    checks: {
      tracking: trackingStats,
      charges: { rowsChecked: chargesChecked, rowsMatching: chargesMatching },
      invoiceTotal,
      billedWeight: { rowsChecked: bwChecked, rowsOdd: bwOdd, divisor },
    },
    issues,
  };
}

/** Eşleme doğrulamasının yapay zekâ önerisine ihtiyaç duyup duymadığı (SPEC §11.3). */
export function shouldSuggestAi(v: MappingVerification, source: 'saved' | 'preset' | 'ai' | 'user', hasPreset: boolean): boolean {
  if (source === 'preset' && !hasPreset) return true;
  if (REQUIRED_MAPPING_FIELDS.some((f) => v.fields[f]?.status !== 'ok')) return true;
  return v.verdict === 'check';
}

