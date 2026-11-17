import { dateToIso, fmtNumber, parseTrDate, parseTrNumber } from '../format';
import { DEFAULT_LOCALE, t, type Locale, type MessageParams } from '../i18n/index';
import type { Table, TableSheets, UnreadSheet } from './types';
import { checkZipSize, countJsZipInflated, type JsZipLike } from './zipGuard';

export type FileFormat = 'csv' | 'xlsx' | 'pdf' | 'unknown';

/** Son üçü yük sınırıdır (Mesaj 6): `TOO_MANY_ROWS` ve `PDF_TOO_MANY_PAGES` metni `{limit}` ister (`params`). */
export type InvoiceFileErrorCode =
  | 'EMPTY_FILE'
  | 'NO_ROWS'
  | 'XLSX_UNREADABLE'
  | 'OLD_EXCEL'
  | 'HTML_AS_EXCEL'
  | 'UNSUPPORTED_FORMAT'
  | 'XLSX_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'PDF_TOO_MANY_PAGES';

/** Dosya okunamadığında kullanıcıya gösterilecek Türkçe açıklama (ne oldu + ne yapmalı). */
export class InvoiceFileError extends Error {
  readonly code: InvoiceFileErrorCode;
  /** metnin yer tutucuları (ör. `{ limit }`); API başka dilde yeniden üretirken aynısını verir */
  readonly params?: MessageParams;
  constructor(code: InvoiceFileErrorCode, message: string, params?: MessageParams) {
    super(message);
    this.name = 'InvoiceFileError';
    this.code = code;
    if (params) this.params = params;
  }
}

/** Hata kodunun metni, istenen dilde. Okuma derinden fırlattığı için hata Türkçe gelir; API `e.code` (ve `e.params`) ile buradan alır. */
export function invoiceFileMessage(code: InvoiceFileErrorCode, locale: Locale = DEFAULT_LOCALE, params?: MessageParams): string {
  return t(locale, `read.${code}`, params);
}

export function invoiceFileError(code: InvoiceFileErrorCode, params?: MessageParams): InvoiceFileError {
  return new InvoiceFileError(code, invoiceFileMessage(code, DEFAULT_LOCALE, params), params);
}

/**
 * Dosya okuma sınırları (Mesaj 6, 03-B2). Verilmeyen alan varsayılandır; API değerleri ortamdan verir
 * (`FILE_MAX_ROWS`, `XLSX_MAX_UNCOMPRESSED_MB`). Aşılınca `TOO_MANY_ROWS` / `XLSX_TOO_LARGE` atılır, dosya açılmadan önce
 * (zip boyutu) ya da satırlar tabloya çevrilmeden önce (XLSX sayfa satır sayısı).
 */
export type ReadLimits = { maxRows?: number; maxUncompressedBytes?: number };
export const DEFAULT_MAX_ROWS = 200_000;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
/** Başlık aranan ön satırlar (`findHeaderRow`): XLSX satır ön denetimi bunları sınırdan saymaz. */
const HEADER_SCAN_ROWS = 20;

const maxRowsOf = (limits?: ReadLimits) => limits?.maxRows ?? DEFAULT_MAX_ROWS;
const maxBytesOf = (limits?: ReadLimits) => limits?.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;

/** Satır sınırı hatası; metindeki `{limit}` Türkçe biçimlenir (API kendi dilinde yeniden üretir). */
export function tooManyRowsError(maxRows: number): InvoiceFileError {
  return invoiceFileError('TOO_MANY_ROWS', { limit: fmtNumber(maxRows, 0) });
}

/**
 * XLSX'i açmadan önce zip içindeki açılmış boyutu denetler (`zipGuard`). Aşarsa `XLSX_TOO_LARGE`, JSZip açamıyorsa
 * `XLSX_UNREADABLE`.
 * Son adım okuyucunun kendi görüşüdür: exceljs'in kullandığı JSZip dosyayı ayrıştırır (açmadan), parçalar akışla ve
 * bütçeyle sayılır (`countJsZipInflated`). JSZip exceljs'in bağımlılığıdır (aynı kopya; core'a ayrıca yazılı değil).
 */
export async function assertXlsxSize(bytes: Uint8Array, limits?: ReadLimits): Promise<void> {
  const max = maxBytesOf(limits);
  const tooLarge = () => invoiceFileError('XLSX_TOO_LARGE', { limit: fmtNumber(Math.round(max / (1024 * 1024)), 0) });
  // Hızlı ret: beyan ya da kendi ayrıştırmamızla sayılan sınırı aşıyor. `untrusted` (yapı kuralına uymayan) dosya
  // reddedilmez: karar aşağıda, JSZip'in gerçekten açacağını sayan adımdadır.
  const r = await checkZipSize(bytes, max);
  if (!r.ok && r.reason === 'tooLarge') throw tooLarge();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('jszip');
  const JSZip = mod.default ?? mod;
  let zip: JsZipLike;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw invoiceFileError('XLSX_UNREADABLE');
  }
  const c = await countJsZipInflated(zip, max);
  if (!c.ok) throw c.reason === 'unreadable' ? invoiceFileError('XLSX_UNREADABLE') : tooLarge();
}

/** `detectFormat` 'unknown' döndüğünde nedenini söyler (boş dosya, eski .xls, HTML'den .xls…). */
export function unsupportedFileError(fileName: string, bytes: Uint8Array): InvoiceFileError {
  if (bytes.length === 0 || (looksLikeText(bytes) && decodeText(bytes).trim() === '')) return invoiceFileError('EMPTY_FILE');
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return invoiceFileError('OLD_EXCEL');
  const ext = extOf(fileName);
  if (ext === 'xls' || ext === 'xlsx') {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048)).toLowerCase();
    if (/<(html|table|\?xml|!doctype)/.test(head)) return invoiceFileError('HTML_AS_EXCEL');
    return invoiceFileError(ext === 'xls' ? 'OLD_EXCEL' : 'XLSX_UNREADABLE');
  }
  return invoiceFileError('UNSUPPORTED_FORMAT');
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

function extOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : '';
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return false;
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) bad++;
  }
  return bad / n < 0.02;
}

export function detectFormat(fileName: string, bytes: Uint8Array): FileFormat {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return 'xlsx';
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'unknown';
  const ext = extOf(fileName);
  if (ext === 'pdf' || ext === 'xlsx' || ext === 'xls') return 'unknown';
  if (looksLikeText(bytes)) return 'csv';
  return 'unknown';
}

/** Metni çözer: UTF-8 (BOM'lu/BOM'suz), UTF-16 (BOM'lu), geçersiz UTF-8 ise Windows-1254 (Türkçe). */
export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1254').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

function countOutsideQuotes(line: string, delim: string): number {
  let inQ = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === delim) n++;
  }
  return n;
}

/** CSV ayırıcısını tahmin eder: `,` `;` `\t` `|` içinden satırlar arasında en tutarlı ve en sık olanı. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 30);
  const candidates = ['\t', ';', ',', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeFreq = 0;
    for (const [c, f] of freq) {
      if (f > modeFreq || (f === modeFreq && c > mode)) {
        mode = c;
        modeFreq = f;
      }
    }
    if (mode === 0) continue;
    const score = modeFreq * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function isTextCell(v: string): boolean {
  if (!v) return false;
  return parseTrNumber(v) == null && parseTrDate(v) == null;
}

/**
 * Başlık satırı: ilk 20 satırda en çok **farklı** dolu metin hücresi olan satır (eşitlikte ilki).
 * Farklı değer sayılır ki birleştirilmiş başlık/logo satırı (aynı metin her hücrede) başlık sanılmasın.
 */
export function findHeaderRow(matrix: string[][]): number {
  let best = 0;
  let bestCount = -1;
  for (let i = 0; i < Math.min(20, matrix.length); i++) {
    const count = new Set(matrix[i]!.filter(isTextCell)).size;
    if (count > bestCount) {
      best = i;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Hücre temizliği: bölünmez boşluk → boşluk, kırpma, Excel metin sarmalayıcısı `="0012"` → `0012`
 * (CSV dışa aktarımları baştaki sıfırlar kaybolmasın diye takip/fatura numarasını böyle yazar).
 */
function cleanCell(c: unknown): string {
  const s = String(c ?? '').replace(/\u00a0/g, ' ').trim();
  const m = /^="(.*)"$/.exec(s);
  return m ? m[1]!.replace(/""/g, '"').trim() : s;
}

/**
 * İki katlı başlık (Excel'de birleştirilmiş grup hücresi): üst satırda "Ağırlık" iki sütunu kapsar, altında
 * "Gerçek" / "Ücretli". Okurken yatay birleşik hücrelerin devamı boş, dikey birleşik hücreler (ör. "Gönderi No"
 * iki satırı kapsar) iki satırda da aynı gelir. Üst satırda en az bir dikey birleşik hücre varsa grup adı alt
 * başlığa eklenir: "Ağırlık / Gerçek". Dikey birleşik kanıtı yoksa (sıradan ön satırlar) başlık değişmez.
 */
function combineGroupHeader(top: string[] | undefined, header: string[], width: number): string[] {
  if (!top) return header;
  const filled = top.filter((c) => c !== '').length;
  const vertical = top.some((c, i) => c !== '' && c === header[i]);
  if (filled < 2 || !vertical) return header;
  const out = header.slice();
  let group = '';
  for (let i = 0; i < width; i++) {
    const t = top[i] ?? '';
    if (t !== '') group = t === header[i] ? '' : t;
    const sub = header[i] ?? '';
    if (group && sub && sub !== group) out[i] = `${group} / ${sub}`;
    else if (group && !sub) out[i] = group;
  }
  return out;
}

/**
 * Ham hücre matrisinden başlık + satır tablosu üretir. `numeric` (XLSX): matrisle aynı biçimde, hücre gerçek sayıydı;
 * verilirse tabloya `numeric` düz dizisi olarak taşınır (bkz. `Table`, `isNumericCell`).
 */
export function tableFromMatrix(matrix: string[][], numeric?: boolean[][]): Table {
  const cleanAll = matrix.map((r) => Array.from(r, cleanCell));
  const keep = cleanAll.map((r) => r.some((c) => c !== ''));
  const nonEmpty = cleanAll.filter((_, i) => keep[i]);
  const nonEmptyNumeric = numeric ? matrix.map((_, i) => numeric[i] ?? []).filter((_, i) => keep[i]) : null;
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const h = findHeaderRow(nonEmpty);
  const body = nonEmpty.slice(h + 1);
  let width = 0;
  for (const r of [nonEmpty[h]!, ...body]) {
    let last = r.length;
    while (last > 0 && r[last - 1] === '') last--;
    width = Math.max(width, last);
  }
  const headerRow = combineGroupHeader(h > 0 ? nonEmpty[h - 1] : undefined, nonEmpty[h]!, width);
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = headerRow[i] || `Sütun ${i + 1}`;
    const key = name.toLocaleLowerCase('tr');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) name = `${name} (${n})`;
    headers.push(name);
  }
  const rows = body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  if (!nonEmptyNumeric) return { headers, rows };
  const bodyNumeric = nonEmptyNumeric.slice(h + 1);
  let flat: Uint8Array | null = null;
  bodyNumeric.forEach((r, ri) => {
    for (let ci = 0; ci < width; ci++) {
      if (!r[ci]) continue;
      flat ??= new Uint8Array(rows.length * width);
      flat[ri * width + ci] = 1;
    }
  });
  return flat ? { headers, rows, numeric: flat } : { headers, rows };
}

/** Tablonun `row` satırı, `col` sütunu XLSX'te gerçek sayı hücresiydi (01-B4). CSV/PDF tablosunda her zaman false. */
export function isNumericCell(t: Pick<Table, 'headers' | 'numeric'>, row: number, col: number): boolean {
  const n = t.numeric;
  if (!n || col < 0 || col >= t.headers.length || row < 0) return false;
  return n[row * t.headers.length + col] === 1;
}

/**
 * Gerçek sayı hücresinin metnini (`numberToCell` çıktısı: "0,453", "1234,5", "12", "1e-7") sayıya çevirir; sayı biçimine
 * bakılmaz. Okunamazsa null.
 */
export function numericCellValue(v: string): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** exceljs hücre değeri gerçek sayı mı (formül sonucu dahil). */
export function cellIsNumber(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as Record<string, unknown>)) return cellIsNumber((v as Record<string, unknown>).result);
  return false;
}

function numberToCell(n: number): string {
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
  // XLSX sayıları ondalık virgülle yazılır ki parseTrNumber "1.234" gibi değerleri binlik sanmasın.
  return String(n).replace('.', ',');
}

/** exceljs hücre değerini metne çevirir. */
export function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToCell(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : dateToIso(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    if ('result' in o) return cellToString(o.result);
    if ('text' in o) return cellToString(o.text);
    if ('error' in o) return '';
  }
  return String(v);
}

/**
 * Excel sayı biçimi değeri yüze katlıyor mu ("0%", "0.00%", "#,##0.0 %"). Tırnak içindeki (`"%"0`, `0" %"`), ters bölüyle
 * kaçılmış (`0\%`), `_`/`*` ardındaki ve köşeli ayraç içindeki `%` düz metindir: değer yüze katlanmaz, olduğu gibi gösterilir.
 */
export function isPercentFormat(fmt: unknown): boolean {
  if (typeof fmt !== 'string' || !fmt.includes('%')) return false;
  return fmt
    .replace(/"[^"]*"?/g, '')
    .replace(/\[[^\]]*\]?/g, '')
    .replace(/[\\_*]./g, '')
    .includes('%');
}

/**
 * XLSX sayfası (tarife okuyucusu). `numeric[r][c]`: hücre gerçek sayıydı (metni `numberToCell` biçiminde, sayı biçimine
 * bakılmadan `numericCellValue` ile okunur; 01-B4/01-B6); `percent[r][c]`: sayı hücresinin Excel biçimi yüzde ("0.00%";
 * 01-B12). İkisi de `rows` ile aynı biçimde, eksik satır/sütun false sayılır.
 */
export type XlsxSheetRows = { name: string; rows: string[][]; numeric: boolean[][]; percent: boolean[][] };

/**
 * Çalışma kitabının tüm sayfaları; satır dizisi sırası = satır numarası − 1 (boş satırlar korunur).
 * Açmadan önce açılmış boyut, açtıktan sonra her sayfanın dolu satır sayısı sınırla denetlenir (`limits`).
 */
export async function readXlsxSheets(bytes: Uint8Array, limits?: ReadLimits): Promise<XlsxSheetRows[]> {
  await assertXlsxSize(bytes, limits);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('exceljs');
  const Workbook = mod.Workbook ?? mod.default?.Workbook;
  const wb = new Workbook();
  const NodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  const input = NodeBuffer ? NodeBuffer.from(bytes) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await wb.xlsx.load(input);
  const maxRows = maxRowsOf(limits);
  const sheets = (wb.worksheets as { name: string; actualRowCount: number; eachRow: Function }[]).filter(Boolean);
  if (sheets.some((ws) => ws.actualRowCount > maxRows)) throw tooManyRowsError(maxRows);
  const out: XlsxSheetRows[] = [];
  for (const ws of sheets) {
    const matrix: string[][] = [];
    const numeric: boolean[][] = [];
    const percent: boolean[][] = [];
    if (ws.actualRowCount > 0) {
      ws.eachRow({ includeEmpty: true }, (row: { values: unknown[]; getCell?(c: number): { numFmt?: unknown } }, rowNumber: number) => {
        const values = Array.isArray(row.values) ? row.values : [];
        const cells: string[] = [];
        const nums: boolean[] = [];
        const pcts: boolean[] = [];
        for (let c = 1; c < values.length; c++) {
          cells[c - 1] = cellToString(values[c]);
          const isNum = cellIsNumber(values[c]);
          nums[c - 1] = isNum;
          let pct = false;
          if (isNum && typeof row.getCell === 'function') pct = isPercentFormat(row.getCell(c)?.numFmt);
          pcts[c - 1] = pct;
        }
        matrix[rowNumber - 1] = Array.from(cells, (x) => x ?? '');
        numeric[rowNumber - 1] = Array.from(nums, (x) => x === true);
        percent[rowNumber - 1] = Array.from(pcts, (x) => x === true);
      });
    }
    out.push({
      name: ws.name,
      rows: Array.from(matrix, (r) => r ?? []),
      numeric: Array.from(numeric, (r) => r ?? []),
      percent: Array.from(percent, (r) => r ?? []),
    });
  }
  return out;
}

/** CSV'yi satır numaraları korunarak hücre matrisine çevirir (kodlama ve ayırıcı otomatik). */
export async function readCsvMatrix(bytes: Uint8Array): Promise<string[][]> {
  const text = decodeText(bytes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('papaparse');
  const Papa = mod.default ?? mod;
  const res = Papa.parse(text.replace(/(\r\n|\n|\r)$/, ''), { delimiter: detectDelimiter(text), skipEmptyLines: false });
  return (res.data as unknown[][]).map((r) => r.map((c) => String(c ?? '')));
}

type XlsxCell = { isMerged?: boolean; master?: XlsxCell; col: number | string; value: unknown };
type XlsxRow = { values: unknown[]; getCell(c: number): XlsxCell };
type XlsxSheet = { name: string; actualRowCount: number; state?: string; hasMerges?: boolean; eachRow: Function };

/**
 * Sayfanın hücre matrisi. Birleştirilmiş hücreler: yatay devam hücreleri boş (başlık/logo satırı her sütunda
 * tekrarlanmasın), dikey devam hücreleri ana hücrenin değerini alır (iki satırlık başlıkta "Gönderi No" iki satırda da görünsün).
 */
function sheetMatrix(ws: XlsxSheet): { matrix: string[][]; numeric: boolean[][] } {
  const matrix: string[][] = [];
  const numeric: boolean[][] = [];
  const merges = ws.hasMerges !== false;
  ws.eachRow({ includeEmpty: true }, (row: XlsxRow, rowNumber: number) => {
    const values = Array.isArray(row.values) ? row.values : [];
    const cells: string[] = [];
    const nums: boolean[] = [];
    for (let c = 1; c < values.length; c++) {
      if (merges) {
        const cell = row.getCell(c);
        if (cell.isMerged && cell.master && cell.master !== cell) {
          const own = Number(cell.master.col) === c;
          cells[c - 1] = own ? cellToString(cell.master.value) : '';
          nums[c - 1] = own && cellIsNumber(cell.master.value);
          continue;
        }
      }
      cells[c - 1] = cellToString(values[c]);
      nums[c - 1] = cellIsNumber(values[c]);
    }
    matrix[rowNumber - 1] = Array.from(cells, (x) => x ?? '');
    numeric[rowNumber - 1] = Array.from(nums, (x) => x === true);
  });
  return { matrix: Array.from(matrix, (r) => r ?? []), numeric: Array.from(numeric, (r) => r ?? []) };
}

const UNREAD_SAMPLE_ROWS = 20;

/**
 * Sayfanın özeti: fatura verisi olma puanı (`score`: başlığın altındaki, en az 3 dolu hücreli satır sayısı; okunacak sayfa
 * bununla seçilir) ve okunmazsa söylenecek hâli (`summary`: başlık, dolu veri satırı sayısı ve ilk 20 dolu satır; iki
 * sütunlu "Takip No | Tutar" sayfası da sayılır; fatura satırı taşıyor mu, `unreadSheetsOf`).
 */
function sheetSummary(name: string, matrix: string[][]): { score: number; summary: UnreadSheet } {
  const t = tableFromMatrix(matrix);
  const score = t.rows.filter((r) => r.filter((c) => c !== '').length >= 3).length;
  return { score, summary: { name, rows: t.rows.length, headers: t.headers, sample: t.rows.slice(0, UNREAD_SAMPLE_ROWS) } };
}

/**
 * Fatura sayfasını seçer: görünür sayfalardan en çok veri satırı olan (eşitlikte ilki). Böylece önde bir "Özet"
 * ya da "Kapak" sayfası olsa da gönderi satırları okunur. Gizli sayfalar ancak görünür dolu sayfa yoksa seçilir.
 */
async function readXlsxMatrix(bytes: Uint8Array, limits?: ReadLimits): Promise<{ matrix: string[][]; numeric: boolean[][]; sheets?: TableSheets }> {
  await assertXlsxSize(bytes, limits);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('exceljs');
  const Workbook = mod.Workbook ?? mod.default?.Workbook;
  const wb = new Workbook();
  const NodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  const input = NodeBuffer ? NodeBuffer.from(bytes) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    await wb.xlsx.load(input);
  } catch {
    throw invoiceFileError('XLSX_UNREADABLE');
  }
  // Matris kurulmadan önce: sınırın çok üstündeki sayfa belleğe ikinci kez (metin olarak) yazılmasın.
  const maxRows = maxRowsOf(limits);
  if ((wb.worksheets as XlsxSheet[]).some((ws) => ws && ws.actualRowCount > maxRows + HEADER_SCAN_ROWS + 1)) throw tooManyRowsError(maxRows);
  let best: { index: number; name: string; matrix: string[][]; numeric: boolean[][]; score: number; visible: boolean } | null = null;
  // 1.6: okunmayan görünür dolu sayfalar okuma kontrolünde söylenir (özetleri; matrisleri tutulmaz)
  const visibleSheets: { index: number; summary: UnreadSheet }[] = [];
  for (const [index, ws] of (wb.worksheets as XlsxSheet[]).entries()) {
    if (!ws || ws.actualRowCount === 0) continue;
    const { matrix, numeric } = sheetMatrix(ws);
    if (!matrix.some((r) => r.some((c) => c.trim() !== ''))) continue;
    const visible = ws.state !== 'hidden' && ws.state !== 'veryHidden';
    const { score, summary } = sheetSummary(ws.name, matrix);
    if (visible) visibleSheets.push({ index, summary });
    if (!best || (visible && !best.visible) || (visible === best.visible && score > best.score)) best = { index, name: ws.name, matrix, numeric, score, visible };
  }
  if (!best) return { matrix: [], numeric: [] };
  const chosen = best;
  const unread = visibleSheets.filter((s) => s.index !== chosen.index).map((s) => s.summary);
  return { matrix: chosen.matrix, numeric: chosen.numeric, ...(unread.length ? { sheets: { read: chosen.name, unread } } : {}) };
}

/** Excel'in CSV başına yazdığı "sep=;" ipucu: ayırıcıyı verir ve satırı atar. */
export function splitSepHint(text: string): { text: string; delimiter: string | null } {
  const m = /^sep=(.)[^\S\r\n]*(\r\n|\n|\r)/i.exec(text);
  return m ? { text: text.slice(m[0].length), delimiter: m[1]! } : { text, delimiter: null };
}

async function parseCsv(text: string, delimiter: string): Promise<string[][]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('papaparse');
  const Papa = mod.default ?? mod;
  const res = Papa.parse(text, { delimiter, skipEmptyLines: 'greedy' });
  return (res.data as unknown[][]).map((r) => r.map((c) => String(c ?? '')));
}

/**
 * CSV/XLSX dosyasını { headers, rows } tablosuna çevirir. Okunamayan dosyada `InvoiceFileError` atar
 * (Türkçe mesaj: boş dosya, yalnız başlık, bozuk Excel, eski .xls…). Sınırlar: `limits` (yoksa varsayılan):
 * `XLSX_TOO_LARGE` (açılmış zip), `TOO_MANY_ROWS` (veri satırı).
 */
export async function readTable(fileName: string, bytes: Uint8Array, limits?: ReadLimits): Promise<Table> {
  const format = detectFormat(fileName, bytes);
  let table: Table;
  if (format === 'xlsx') {
    const x = await readXlsxMatrix(bytes, limits);
    table = tableFromMatrix(x.matrix, x.numeric);
    if (x.sheets) table.sheets = x.sheets;
  }
  else if (format === 'csv') {
    const hint = splitSepHint(decodeText(bytes));
    table = tableFromMatrix(await parseCsv(hint.text, hint.delimiter ?? detectDelimiter(hint.text)));
  } else if (format === 'pdf') throw new Error(t('tr', 'read.pdfNotTable'));
  else throw unsupportedFileError(fileName, bytes);
  if (table.headers.length === 0) throw invoiceFileError('EMPTY_FILE');
  if (table.rows.length === 0) throw invoiceFileError('NO_ROWS');
  const maxRows = maxRowsOf(limits);
  if (table.rows.length > maxRows) throw tooManyRowsError(maxRows);
  return table;
}
