import { sumMoney } from '../calc';
import { normalizeSurchargeCode } from '../surcharges';
import { normalizeTracking } from '../tracking';
import type { PdfCheckMethod } from './pdfCheck';
import { PDF_MISSED_MAX_LIST } from './pdfMissed';
import { pdfReadNote, pdfReadNoteWorthy, type PdfReadNote, type PdfReadNoteInput } from './pdfRead';
import type { ParsedInvoiceLine, ParseErrorCode, SkippedInvoiceRow } from './types';
import { currencyCode } from './verify';

/**
 * İçe aktarma raporu (Mesaj 5, denetim 04-B11): faturaya alınmayan satırlar sayısı, nedeni ve değeriyle. Faturaya
 * `Invoice.importReport` olarak yazılır; özet kartı tek satır uyarı ve "Ayrıntı" penceresi bundan okur.
 */

export type ImportSkipReason = 'BAD_TRACKING' | 'BAD_NET' | 'NO_TRACKING';

export type ImportSkippedRow = {
  /** Dosyadaki 1 tabanlı veri satırı (`rowIndex + 1`). */
  row: number;
  reason: ImportSkipReason;
  trackingRaw?: string;
  rawNet?: string;
  /** Yalnız `NO_TRACKING`: satırlarla aynı KDV kuralıyla tutar. */
  amount?: number;
};

export type ImportReport = {
  version: 1;
  source: 'table' | 'pdf';
  rowsInFile: number;
  linesImported: number;
  /** Faturaya alınmayan satırların tamamı (`skippedRows` en çok 200 satır gösterir). */
  skippedCount: number;
  byReason: Partial<Record<ImportSkipReason, number>>;
  skippedRows: ImportSkippedRow[];
  /** Takip no'suz ücret satırlarının toplamı (yalnız böyle satır varsa). */
  noTrackingAmount?: number;
  pdfCheck?: { method: PdfCheckMethod; checked: number; unverified: number };
  /**
   * Y31: PDF metninde geçen ama okunan satırlarda olmayan takip no'lar ("okunmamış olabilir"; `pdfMissedTrackings`).
   * Yalnız en az bir aday varsa yazılır. `trackings` en çok 200, `count` tamdır. Bu satırlar `skippedCount`'a girmez.
   * `tooLarge`: metin tarama sınırını (`PDF_MISSED_MAX_TEXT_CHARS`) aştı, denetim yapılamadı (`count` 0).
   */
  pdfMissed?: { count: number; trackings: string[]; tooLarge?: true };
  /**
   * Y20: PDF okumasında kullanılan KDV oranı, ağırlık ve ölçü birimi; yalnız söylenecek bir şey varsa yazılır (varsayım,
   * metinde doğrulanamayan oran, birim çevirisi, kullanılmayan değer; `pdfReadNoteWorthy`). Bayraklar yalnız `true` iken.
   */
  pdfRead?: PdfReadNote;
};

/** `skippedRows` üst sınırı (rapor faturaya JSON olarak yazılır). */
export const IMPORT_REPORT_MAX_ROWS = 200;
/** Ham hücre değerinin rapora yazılan en uzun hâli. */
const MAX_RAW_LENGTH = 80;

export type ImportReportInput = {
  source: 'table' | 'pdf';
  rowsInFile: number;
  linesImported: number;
  /** `parseRows` hataları; yalnız `BAD_TRACKING` ve `BAD_NET` satırı faturadan düşürür (tarih hatası satırı düşürmez). */
  errors: readonly { rowIndex: number; code?: ParseErrorCode; message?: string; value?: string; trackingRaw?: string }[];
  skipped: readonly SkippedInvoiceRow[];
  /** `checkPdfLines` sonucu ya da özeti; `unverified` verilmezse bayraklı satır sayısıdır. */
  pdfCheck?: { method: PdfCheckMethod; checked: number; unverified?: number; rows?: readonly { codes: readonly string[] }[] };
  /** `tooLarge`: metin tarama sınırını aştı, denetim yapılmadı (raporda not). */
  pdfMissed?: { count: number; trackings: readonly string[]; tooLarge?: boolean };
  pdfRead?: PdfReadNoteInput;
};

const clip = (v: string | undefined): string | undefined => {
  if (v == null) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > MAX_RAW_LENGTH ? `${s.slice(0, MAX_RAW_LENGTH - 1)}…` : s;
};

// ---------------------------------------------------------------------------------------------
// Denetim 05-B16: PDF satırları içe aktarmada tarayıcıdan gelir. Gönderilen satırlar okuma işinin sunucuda yazdığı sonuçla
// (`aiLines`) satır no'suyla karşılaştırılır; değişen alanlar denetim kaydına yazılır (tutar ya da değer değil, alan adı).

export const PDF_EDIT_FIELDS = [
  'trackingNo',
  'shipDate',
  'service',
  'destCountry',
  'actualKg',
  'billedKg',
  'dims',
  'billedDivisor',
  'baseAmount',
  'discountAmount',
  'fuelAmount',
  'surcharges',
  'netAmount',
  'currency',
  'reference',
] as const;
export type PdfEditField = (typeof PDF_EDIT_FIELDS)[number];

export type PdfEditLine = Partial<Omit<ParsedInvoiceLine, 'rowIndex' | 'surcharges' | 'dims'>> & {
  rowIndex: number;
  dims?: { l: number; w: number; h: number } | null;
  surcharges?: readonly { code: string; name?: string | null; amount: number }[] | null;
};

export type PdfLineEdits = {
  /** Yapay zekânın okuduğu ve gönderilen, en az bir alanı farklı satır sayısı. */
  edited: number;
  /** Okumada olmayan satır no'suyla gönderilen (elle eklenen) satır sayısı. */
  added: number;
  /** Okunan ama gönderilmeyen satır sayısı. */
  removed: number;
  /** Alan başına değişen satır sayısı. */
  fields: Partial<Record<PdfEditField, number>>;
  /** Değişen satırların no'su (`rowIndex + 1`), en çok `PDF_EDIT_MAX_ROWS`. */
  rows: number[];
};

export const PDF_EDIT_MAX_ROWS = 200;

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
function editKey(l: PdfEditLine, f: PdfEditField): string {
  switch (f) {
    case 'trackingNo':
      return normalizeTracking(l.trackingNo ?? '');
    case 'shipDate':
      return str(l.shipDate)?.slice(0, 10) ?? '';
    case 'destCountry':
      return str(l.destCountry)?.toUpperCase() ?? '';
    case 'currency':
      return currencyCode(l.currency) ?? '';
    case 'dims':
      return l.dims ? [l.dims.l, l.dims.w, l.dims.h].map(num).join('x') : '';
    case 'surcharges':
      return (l.surcharges ?? [])
        .map((s) => `${normalizeSurchargeCode(s.code)}=${num(s.amount)}`)
        .sort()
        .join(';');
    case 'service':
    case 'reference':
      return str(l[f]) ?? '';
    default: {
      const v = num(l[f]);
      return v == null ? '' : String(v);
    }
  }
}

/** Gönderilen satırlar ile okunan satırların farkı; fark yoksa null. Satırlar `rowIndex` ile eşlenir. */
export function pdfLineEdits(ai: readonly PdfEditLine[], sent: readonly PdfEditLine[]): PdfLineEdits | null {
  const byRow = new Map(ai.map((l) => [l.rowIndex, l]));
  const seen = new Set<number>();
  const fields: Partial<Record<PdfEditField, number>> = {};
  const rows: number[] = [];
  let edited = 0;
  let added = 0;
  for (const s of sent) {
    const a = byRow.get(s.rowIndex);
    if (!a || seen.has(s.rowIndex)) {
      added++;
      continue;
    }
    seen.add(s.rowIndex);
    const changed = PDF_EDIT_FIELDS.filter((f) => editKey(a, f) !== editKey(s, f));
    if (!changed.length) continue;
    edited++;
    for (const f of changed) fields[f] = (fields[f] ?? 0) + 1;
    rows.push(s.rowIndex + 1);
  }
  const removed = ai.filter((l) => !seen.has(l.rowIndex)).length;
  if (!edited && !added && !removed) return null;
  return { edited, added, removed, fields, rows: rows.sort((x, y) => x - y).slice(0, PDF_EDIT_MAX_ROWS) };
}

export function buildImportReport(i: ImportReportInput): ImportReport {
  const rows: ImportSkippedRow[] = [];
  for (const e of i.errors) {
    if (e.rowIndex < 0) continue;
    if (e.code === 'BAD_TRACKING') {
      const trackingRaw = clip(e.trackingRaw ?? e.value);
      rows.push({ row: e.rowIndex + 1, reason: 'BAD_TRACKING', ...(trackingRaw ? { trackingRaw } : {}) });
    } else if (e.code === 'BAD_NET') {
      const trackingRaw = clip(e.trackingRaw);
      const rawNet = clip(e.value);
      rows.push({ row: e.rowIndex + 1, reason: 'BAD_NET', ...(trackingRaw ? { trackingRaw } : {}), ...(rawNet ? { rawNet } : {}) });
    }
  }
  for (const s of i.skipped) rows.push({ row: s.rowIndex + 1, reason: 'NO_TRACKING', amount: s.amount });
  rows.sort((a, b) => a.row - b.row);

  const byReason: Partial<Record<ImportSkipReason, number>> = {};
  for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;

  const report: ImportReport = {
    version: 1,
    source: i.source,
    rowsInFile: i.rowsInFile,
    linesImported: i.linesImported,
    skippedCount: rows.length,
    byReason,
    skippedRows: rows.slice(0, IMPORT_REPORT_MAX_ROWS),
  };
  if (i.skipped.length) report.noTrackingAmount = sumMoney(i.skipped.map((s) => s.amount));
  if (i.pdfCheck) {
    const unverified = i.pdfCheck.unverified ?? (i.pdfCheck.rows ?? []).filter((r) => r.codes.length > 0).length;
    report.pdfCheck = { method: i.pdfCheck.method, checked: i.pdfCheck.checked, unverified };
  }
  if (i.pdfMissed?.tooLarge) report.pdfMissed = { count: 0, trackings: [], tooLarge: true };
  else if (i.pdfMissed && i.pdfMissed.count > 0) {
    report.pdfMissed = { count: i.pdfMissed.count, trackings: i.pdfMissed.trackings.slice(0, PDF_MISSED_MAX_LIST) };
  }
  if (i.pdfRead) {
    const note = pdfReadNote(i.pdfRead);
    if (pdfReadNoteWorthy(note)) report.pdfRead = note;
  }
  return report;
}
