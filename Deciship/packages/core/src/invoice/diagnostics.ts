import { round2, sumMoney } from '../calc';
import { DEFAULT_LOCALE, t as tt, type Locale } from '../i18n/index';
import { classifyCharge } from './charges';
import { CHARGE_TOLERANCE, chargesMatchNet } from './constants';
import { unreadSheetsOf, type UnreadSheetInfo } from './mapping';
import { detectMetaColumns, resolveDateOrder } from './meta';
import { normalizeHeader } from './normalize';
import { cellNumber, columnMostCommonNumber, parseCurrency, parseRows, resolveNumberFormat, tableWeightAmbiguity, type ComponentsVatDecision, type WeightAmbiguity } from './parse';
import { MAPPING_FIELDS, META_FIELDS, type ChargeKind, type ColumnMapping, type HeaderField, type Table } from './types';
import { parseDateAs, type DateAmbiguity, type DateOrder, type NumberFormat } from './values';
import { verifyMapping, type MappingVerification } from './verify';

export type DiagnosticWarningCode =
  | 'NO_TRACKING_COLUMN'
  | 'TRACKING_EMPTY'
  | 'NO_NET_COLUMN'
  | 'NET_EMPTY'
  | 'NET_CONSTANT'
  | 'NO_LINES'
  | 'ROW_ERRORS'
  | 'CHARGES_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'SAVED_MAPPING_FALLBACK';

export type DiagnosticWarning = { code: DiagnosticWarningCode; message: string; field?: HeaderField };

export type FieldDiagnostics = { header: string; /** dolu satır */ filled: number; /** farklı değer sayısı */ distinct: number };

export type ChargeLabelSummary = { label: string; kind: ChargeKind; code?: string; rows: number };

export type MappingDiagnostics = {
  /** Tablodaki veri satırı sayısı. */
  rowCount: number;
  /** Bu eşlemeyle okunabilen fatura satırı sayısı. */
  parsedLines: number;
  /** Satır düzeyindeki okuma hatası sayısı. */
  errorCount: number;
  /** Takip no / net tutar sütunlarının dolu satır sayısı (kısa yol; `fields` içinde de var). */
  trackingFilled: number;
  netFilled: number;
  /** Eşlenen her başlık alanı için doluluk. */
  fields: Partial<Record<HeaderField, FieldDiagnostics>>;
  /** Kullanılan sayı biçimi ve kaynağı: dosyadan tespit; dosyada kanıt yoksa eşlemedeki ipucu (`hint`, KALANLAR 1.4). */
  numberFormat: NumberFormat;
  numberFormatSource: 'hint' | 'detected';
  dateOrder: DateOrder;
  dateOrderSource: 'hint' | 'detected';
  /** Dosyadaki tarihlerden sıra anlaşılamıyorsa dolu; kullanıcı seçene dek okuma kontrolü sorun gösterir. */
  dateAmbiguity?: DateAmbiguity;
  /**
   * K36: ağırlık sütununda "1.500" gibi yazım var ve dosyanın sayı biçimi anlaşılamıyor: eşleme ekranı biçimi sordurur
   * (`numberFormat` 'en' = 1,5 kg, 'tr' = 1500 kg). Seçimden sonra da (seçili hâliyle) dolu kalır; seçilene dek okuma kontrolü sorun gösterir.
   */
  weightAmbiguity?: WeightAmbiguity;
  /**
   * KALANLAR 1.6: XLSX'in okunan sayfası ve okunmayan görünür dolu sayfaları (yalnız böyle sayfa varsa). `invoiceLike`
   * sayfalar için okuma kontrolü ayrıca sorun yazar (onay ister); eşleme ekranı hepsini bilgi olarak gösterir.
   */
  sheets?: { read: string; unread: UnreadSheetInfo[] };
  /** Okunan satırların net tutar toplamı. */
  netTotal: number;
  /** "Tutarlar KDV dahil" iken bileşen sütunlarının (navlun, yakıt, ek ücret) KDV kararı ve dayanağı; eşleme ekranı gösterir. */
  componentsVat?: ComponentsVatDecision;
  /**
   * Ücret kalemleri kontrolü: navlun tutarı olan satırlarda navlun − indirim + yakıt + ek ücretler
   * toplamı net tutara `tolerance` içinde eşit mi.
   */
  charges: {
    pairs: number;
    rowsChecked: number;
    rowsMatchingNet: number;
    tolerance: number;
    /** Çiftlerde görülen etiketler ve sınıfları. */
    labels: ChargeLabelSummary[];
  };
  /** Fatura toplamı sütunu varsa satır toplamıyla karşılaştırma. */
  invoiceTotal: { header: string; value: number; linesTotal: number; difference: number } | null;
  warnings: DiagnosticWarning[];
  /** Okuma kontrolü (SPEC §11): alan kararları, satır bayrakları, genel karar. */
  verification: MappingVerification;
};

export type DiagnosticsOptions = {
  /** Ücretli ağırlık kontrolünde kullanılacak hacim böleni (tarife/kalıp); yoksa 5000. */
  divisor?: number;
  /**
   * Aynı tablo ve eşlemeyle önceden alınmış `parseRows` sonucu: verilirse tablo yeniden okunmaz (içe aktarmada
   * satırlar zaten okunmuş olur; büyük faturada ikinci okuma saniyeler sürüyordu). Sonuç değiştirilmez.
   */
  parsed?: ReturnType<typeof parseRows>;
  /** Yalnız uyarı ve kontrol metinleri; sayımlar ve kararlar her dilde aynı. */
  locale?: Locale;
  /**
   * Faturanın para birimi (içe aktarmada belli). Satırın kendi para birimi bundan farklıysa okuma kontrolü sert bayrak
   * koyar (01-B8); verilmezse satırlarda en sık görülen para birimiyle karşılaştırılır.
   */
  invoiceCurrency?: string;
};

export { CHARGE_TOLERANCE };

function fieldStats(t: Table, header: string): FieldDiagnostics | undefined {
  const i = t.headers.indexOf(header);
  if (i < 0) return undefined;
  const seen = new Set<string>();
  let filled = 0;
  for (const r of t.rows) {
    const v = String(r[i] ?? '').trim();
    if (!v) continue;
    filled++;
    seen.add(v);
  }
  return { header, filled, distinct: seen.size };
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function columnValues(t: Table, header: string | undefined): string[] {
  const i = header ? t.headers.indexOf(header) : -1;
  if (i < 0) return [];
  return t.rows.map((r) => String(r[i] ?? '').trim()).filter(Boolean);
}

/** Eşlemenin bu tabloda ne kadar satır okuyacağını ve olası sorunları yapılandırılmış biçimde özetler. */
export function mappingDiagnostics(t: Table, m: ColumnMapping, opts: DiagnosticsOptions = {}): MappingDiagnostics {
  const rowCount = t.rows.length;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const fields: Partial<Record<HeaderField, FieldDiagnostics>> = {};
  for (const f of [...MAPPING_FIELDS, ...META_FIELDS] as HeaderField[]) {
    const h = m[f];
    if (typeof h === 'string' && h) {
      const s = fieldStats(t, h);
      if (s) fields[f] = s;
    }
  }
  const trackingFilled = fields.trackingNo?.filled ?? 0;
  const netFilled = fields.netAmount?.filled ?? 0;
  const { lines, errors, componentsVat } = opts.parsed ?? parseRows(t, m);
  const rowErrors = errors.filter((e) => e.rowIndex >= 0);

  // 1.4: dosyanın kanıtı eşlemedeki ipucunu ezer; ipucu yalnız kanıt yokken
  const { format: numberFormat, source: numberFormatSource } = resolveNumberFormat(t, m);
  const dateReading = resolveDateOrder(t, m);
  const weightAmbiguity = tableWeightAmbiguity(t, m);
  const dateOrderSource = dateReading.ambiguous && !dateReading.evident && (m.dateOrder === 'dmy' || m.dateOrder === 'mdy') ? 'hint' : 'detected';
  const dateOrder: DateOrder = dateReading.order;
  const netTotal = sumMoney(lines.map((l) => l.netAmount));

  // Ücret kalemleri ↔ net tutar
  let rowsChecked = 0;
  let rowsMatchingNet = 0;
  for (const l of lines) {
    if (l.baseAmount == null) continue;
    rowsChecked++;
    if (chargesMatchNet(l, m.amountsIncludeVat ? 1 + (m.vatPct ?? 20) / 100 : 1)) rowsMatchingNet++;
  }
  const labelMap = new Map<string, ChargeLabelSummary>();
  for (const p of m.chargePairs ?? []) {
    const li = t.headers.indexOf(p.label);
    const ai = t.headers.indexOf(p.amount);
    if (li < 0 || ai < 0) continue;
    for (let ri = 0; ri < t.rows.length; ri++) {
      const r = t.rows[ri]!;
      const label = String(r[li] ?? '').trim();
      const amount = cellNumber(t, ri, ai, String(r[ai] ?? ''), numberFormat);
      if (!label || amount == null || amount === 0) continue;
      const key = normalizeHeader(label);
      const cur = labelMap.get(key);
      if (cur) cur.rows++;
      else {
        const c = classifyCharge(label, amount, m.chargeLabelOverrides);
        labelMap.set(key, { label, kind: c.kind, ...(c.code ? { code: c.code } : {}), rows: 1 });
      }
    }
  }

  // Fatura toplamı ↔ satırlar
  let invoiceTotal: MappingDiagnostics['invoiceTotal'] = null;
  if (m.invoiceTotal) {
    const value = columnMostCommonNumber(t, m.invoiceTotal, numberFormat);
    if (value != null) invoiceTotal = { header: m.invoiceTotal, value, linesTotal: netTotal, difference: round2(netTotal - value) };
  }

  const warnings: DiagnosticWarning[] = [];
  if (!m.trackingNo) warnings.push({ code: 'NO_TRACKING_COLUMN', field: 'trackingNo', message: tt(locale, 'diag.noTrackingColumn') });
  else if (rowCount > 0 && trackingFilled === 0)
    warnings.push({
      code: 'TRACKING_EMPTY',
      field: 'trackingNo',
      message: tt(locale, 'diag.trackingEmpty', { column: m.trackingNo }),
    });
  if (!m.netAmount) warnings.push({ code: 'NO_NET_COLUMN', field: 'netAmount', message: tt(locale, 'diag.noNetColumn') });
  else if (rowCount > 0 && netFilled === 0)
    warnings.push({ code: 'NET_EMPTY', field: 'netAmount', message: tt(locale, 'diag.netEmpty', { column: m.netAmount }) });
  if (m.netAmount && rowCount >= 5 && netFilled >= 5 && fields.netAmount?.distinct === 1) {
    warnings.push({
      code: 'NET_CONSTANT',
      field: 'netAmount',
      message: tt(locale, 'diag.netConstant', { column: m.netAmount }),
    });
  }
  if (rowCount > 0 && m.trackingNo && m.netAmount && trackingFilled > 0 && lines.length === 0) {
    warnings.push({ code: 'NO_LINES', message: tt(locale, 'diag.noLines') });
  }
  if (rowErrors.length) warnings.push({ code: 'ROW_ERRORS', message: tt(locale, 'diag.rowErrors', { count: rowErrors.length }) });
  if (rowsChecked > 0 && rowsMatchingNet < rowsChecked) {
    warnings.push({
      code: 'CHARGES_MISMATCH',
      message: tt(locale, 'diag.chargesMismatch', { count: rowsChecked - rowsMatchingNet }),
    });
  }
  if (invoiceTotal && Math.abs(invoiceTotal.difference) > 1) {
    warnings.push({
      code: 'TOTAL_MISMATCH',
      field: 'invoiceTotal',
      message: tt(locale, 'diag.totalMismatch', { diff: invoiceTotal.difference.toFixed(2) }),
    });
  }

  return {
    rowCount,
    parsedLines: lines.length,
    ...(componentsVat ? { componentsVat } : {}),
    errorCount: rowErrors.length,
    trackingFilled,
    netFilled,
    fields,
    numberFormat,
    numberFormatSource,
    dateOrder,
    dateOrderSource,
    ...(dateReading.ambiguous ? { dateAmbiguity: dateReading.ambiguous } : {}),
    ...(weightAmbiguity ? { weightAmbiguity } : {}),
    ...(t.sheets ? { sheets: { read: t.sheets.read, unread: unreadSheetsOf(t, m) } } : {}),
    netTotal,
    charges: {
      pairs: (m.chargePairs ?? []).length,
      rowsChecked,
      rowsMatchingNet,
      tolerance: CHARGE_TOLERANCE,
      labels: [...labelMap.values()],
    },
    invoiceTotal,
    warnings,
    verification: verifyMapping(t, m, { lines, errors, numberFormat, dateOrder, divisor: opts.divisor, locale, ...(opts.invoiceCurrency ? { invoiceCurrency: opts.invoiceCurrency } : {}) }),
  };
}

export type GuessedInvoiceMeta = { invoiceNo?: string; invoiceDate?: string; currency?: string };

const CURRENCY_HEADER = /\b(currency|curr|cur|ccy|para birimi|doviz)\b/;
const NOT_CURRENCY = /\b(alternatif|alternate|kuru|rate|exchange)\b/;

/**
 * Fatura no / tarih / para birimini tahmin eder. Eşlemedeki meta sütunları (`invoiceNo`, `invoiceDate`)
 * ve `currency` kullanılır; yoksa sütunlar başlıklardan bulunur. Satırlarda en sık görülen değer alınır.
 */
export function guessInvoiceMeta(t: Table, m?: ColumnMapping): GuessedInvoiceMeta {
  const meta: GuessedInvoiceMeta = {};
  const detected = detectMetaColumns(t.headers, t.rows);
  const noCol = m?.invoiceNo && columnValues(t, m.invoiceNo).length ? m.invoiceNo : detected.invoiceNo;
  const dateCol = m?.invoiceDate && columnValues(t, m.invoiceDate).length ? m.invoiceDate : detected.invoiceDate;
  const no = mostCommon(columnValues(t, noCol));
  if (no) meta.invoiceNo = no;
  const order = resolveDateOrder(t, { ...m, invoiceDate: dateCol }).order;
  const d = mostCommon(
    columnValues(t, dateCol)
      .map((v) => parseDateAs(v, order) ?? '')
      .filter(Boolean),
  );
  if (d) meta.invoiceDate = d;
  let curCol = m?.currency && columnValues(t, m.currency).length ? m.currency : undefined;
  if (!curCol) {
    const nh = t.headers.map(normalizeHeader);
    const i = nh.findIndex((h, idx) => CURRENCY_HEADER.test(h) && !NOT_CURRENCY.test(h) && columnValues(t, t.headers[idx]).length > 0);
    if (i >= 0) curCol = t.headers[i];
  }
  const c = mostCommon(columnValues(t, curCol).map((v) => parseCurrency(v) ?? '').filter(Boolean));
  if (c) meta.currency = c;
  return meta;
}
