/**
 * Dosya okuma görevleri (Mesaj 6, 03-B2): Excel/CSV tablosu, tarife dosyası, PDF metni, konumlu PDF metni ve PDF'ten
 * sayfa kesme (Y96); ayrıca fatura raporu (PDF ve Excel üretimi, yeni denetim Mesaj 6: 19-B1, 06-B2).
 *
 * İki biçimde çalışır:
 * - Ayrı çocuk süreçte (Y151; `lib/fileWorkers.ts` `child_process.fork` ile açar, `FILE_WORKER_FLAG` argv işaretiyle):
 *   IPC'den görev alır, sonucu ya da hatayı geri yollar. Bellek (`--max-old-space-size`, bellek bekçisi) ve süre sınırı
 *   ebeveyndedir; burada çökmek (yığın tükenmesi dahil) API sürecini düşürmez.
 * - Ana süreçte (`FILE_WORKER_MODE=inline`, testler): `runFileTask` doğrudan çağrılır.
 *
 * Bu dosya bilerek hafiftir: veritabanı, ortam ve i18n içe aktarılmaz (çocukta Prisma açılmasın); rapor görevi rapor
 * modülünü ve sözlüğü yalnız gerektiğinde (dinamik içe aktarma) yükler. Sınır değerleri her
 * görevle birlikte gelir. Sınır aşımı core'un `InvoiceFileError`'ıdır (`XLSX_TOO_LARGE`, `TOO_MANY_ROWS`,
 * `PDF_TOO_MANY_PAGES`), `PdfTooLargeError` (PDF akışlarının açılmış hâli, `pdfGuard`) ya da `PdfTooComplexError`
 * (ön denetimin süresi); API karşılığına `fileWorkers.ts` çevirir.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  fmtNumber,
  invoiceFileError,
  readTable,
  readTariffFile,
  type Locale,
  type PdfPageLayout,
  type PdfTextItem,
  type RawTariffFile,
  type ReadLimits,
  type Table,
} from '@deciship/core';
import type { ReportInput } from '../services/reports.ts';
import { checkPdfInflatedSize } from './pdfGuard.ts';

export type FileTask =
  | { kind: 'readTable'; fileName: string; bytes: Uint8Array; limits: ReadLimits }
  | { kind: 'readTariffFile'; fileName: string; bytes: Uint8Array; limits: ReadLimits }
  | { kind: 'pdfText'; bytes: Uint8Array; maxPages: number; maxUncompressedBytes: number }
  | { kind: 'pdfLayout'; bytes: Uint8Array; maxPages: number; maxUncompressedBytes: number }
  | { kind: 'pdfSlice'; bytes: Uint8Array; pages: number[]; maxUncompressedBytes: number; strict?: PdfSliceStrict }
  | { kind: 'reportPdf'; input: ReportInput; locale: Locale; maxRows?: number }
  | { kind: 'reportXlsx'; input: ReportInput; locale: Locale };

/**
 * Y96: kesmenin "güvenli değil" sayıldığı durumlar (`strict`): `pageCount` tutmuyorsa ya da `refuseEncrypted` ve belge
 * şifreliyse kesilmez (`bytes: null`). `strict` yoksa bugünkü tarife kesmesi: belge dışı sayfa atlanır, şifre denetlenmez.
 */
export type PdfSliceStrict = { pageCount: number; refuseEncrypted: boolean };

export type FileTaskResult = {
  readTable: Table;
  readTariffFile: RawTariffFile;
  pdfText: { pages: string[] };
  pdfLayout: PdfPageLayout[];
  pdfSlice: { bytes: Uint8Array | null };
  reportPdf: { bytes: Uint8Array };
  reportXlsx: { bytes: Uint8Array };
};

/** Çocuktan dönen hata: yalnız düz alanlar taşınır, ebeveynde yeniden kurulur. */
export type SerializedFileError = { name: string; message: string; code?: string; params?: Record<string, string | number> };

export type FileWorkerRequest = { id: number; task: FileTask };
/**
 * `fatal: 'memory'`: çocukta yakalanabilen bir bellek ayırma hatası oldu ("Array buffer allocation failed"); süreç
 * güvenilmez, ebeveyn çocuğu öldürür ve isteğe 422 `FILE_TOO_COMPLEX` (`reason: 'memory'`) döner.
 */
export type FileWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedFileError; fatal?: 'memory' };
/** Çocuk IPC dinleyicisini kurunca bir kez yollar; ebeveyn görevi ancak bundan sonra gönderir. */
export type FileWorkerReady = { ready: true };

/** argv işareti: dosya başka bir süreçte (API, vitest'in çatallı süreci: onlarda da `process.send` var) içe aktarılınca dinleyici kurulmasın. */
export const FILE_WORKER_FLAG = '--deciship-file-worker';
/** Test görevlerini açan argv işareti (ebeveyn yalnız `NODE_ENV=test` ve `FILE_WORKER_TEST_HOOKS=1` iken ekler). */
export const FILE_WORKER_TEST_HOOKS_FLAG = '--deciship-file-worker-test-hooks';
/**
 * Bellek ölçüsü borusu: çocuktaki izleme iş parçacığı RSS'i (bayt, satır başına bir sayı) bu dosya tanımlayıcısına
 * yazar (`stdio` dizisinin 4. elemanı; 3 IPC). Ana iş parçacığı uzun eşzamanlı işte (pdfjs akışı açarken) meşgulken de ölçü gelir.
 */
export const FILE_WORKER_RSS_FD = 4;
export const FILE_WORKER_RSS_MS = 100;

/** Testin bellek/süre aşımını ve çöküşü gerçekten denemesi için yalnız test işaretiyle açılan çocukta çalışan görevler. */
type TestTask =
  | { kind: 'testAllocate' }
  | { kind: 'testAllocateHuge' }
  | { kind: 'testAllocateExternal' }
  | { kind: 'testAllocFail' }
  | { kind: 'testExit' }
  | { kind: 'testEnv' }
  | { kind: 'testOomScore' }
  | { kind: 'testSpin' }
  | { kind: 'testEcho'; value: unknown }
  | { kind: 'testSleep'; value: unknown };

/** PDF'in açılmış akışları sınırı aşıyor (`pdfGuard`); API 413 `FILE_TOO_LARGE` (`kind: 'uncompressed'`) yapar. */
export class PdfTooLargeError extends Error {
  readonly code = 'PDF_UNCOMPRESSED_TOO_LARGE';
  constructor() {
    super('PDF uncompressed streams exceed the limit');
    this.name = 'PdfTooLargeError';
  }
}

/**
 * Ön denetim kendi süre sınırını aştı (`pdfGuard`, Y59: çok sayıda akış); API 422 `FILE_TOO_COMPLEX` (`reason: 'timeout'`)
 * yapar, dosya başına süre sınırını (`FILE_WORKER_TIMEOUT_MS`) beklemeden.
 */
export class PdfTooComplexError extends Error {
  readonly code = 'PDF_GUARD_TIMEOUT';
  constructor() {
    super('PDF pre-check took too long');
    this.name = 'PdfTooComplexError';
  }
}

/** Akış bombası: pdfjs ya da pdf-lib açmadan önce, bütçeli ve akışlı sayım (çıktı tutulmaz). */
async function guardPdf(bytes: Uint8Array, maxUncompressedBytes: number): Promise<void> {
  const r = await checkPdfInflatedSize(bytes, maxUncompressedBytes);
  if (r.ok) return;
  throw r.reason === 'size' ? new PdfTooLargeError() : new PdfTooComplexError();
}

async function openPdf(bytes: Uint8Array, maxPages: number, maxUncompressedBytes: number) {
  await guardPdf(bytes, maxUncompressedBytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  // Sayfa sınırı: hiçbir sayfa okunmadan önce
  if (doc.numPages > maxPages) {
    await task.destroy();
    throw invoiceFileError('PDF_TOO_MANY_PAGES', { limit: fmtNumber(maxPages, 0) });
  }
  return { task, doc };
}

async function pdfText(bytes: Uint8Array, maxPages: number, maxUncompressedBytes: number): Promise<{ pages: string[] }> {
  const { task, doc } = await openPdf(bytes, maxPages, maxUncompressedBytes);
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        s += it.str + (it.hasEOL ? '\n' : ' ');
      }
      pages.push(s.replace(/[ \t]+/g, ' ').trim());
      page.cleanup();
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

async function pdfLayout(bytes: Uint8Array, maxPages: number, maxUncompressedBytes: number): Promise<PdfPageLayout[]> {
  const { task, doc } = await openPdf(bytes, maxPages, maxUncompressedBytes);
  try {
    const pages: PdfPageLayout[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const t = it.transform as number[];
        items.push({ str: it.str, x: t[4]!, y: t[5]!, w: it.width, h: it.height || Math.abs(t[3]!) || 8 });
      }
      pages.push({ items });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * İstenen sayfalardan (1 tabanlı) yeni PDF (pdf-lib). Ana süreçte değil burada (Y96): pdf-lib bütün belgeyi ayrıştırır ve
 * nesne akışlarını açar. Önce aynı ön denetim (`pdfGuard`).
 */
async function pdfSlice(bytes: Uint8Array, pages: number[], maxUncompressedBytes: number, strict?: PdfSliceStrict): Promise<{ bytes: Uint8Array | null }> {
  await guardPdf(bytes, maxUncompressedBytes);
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  // şifreli belge (yalnız sahip parolalı da): pdf-lib içeriği çözmeden kopyalar, parçalar boş gider (R3 1)
  if (strict && (src.getPageCount() !== strict.pageCount || (strict.refuseEncrypted && src.isEncrypted))) return { bytes: null };
  const out = await PDFDocument.create();
  const idx = pages.map((p) => p - 1).filter((i) => i >= 0 && i < src.getPageCount());
  for (const p of await out.copyPages(src, idx)) out.addPage(p);
  return { bytes: await out.save() };
}

export async function runFileTask<K extends FileTask['kind']>(task: Extract<FileTask, { kind: K }>): Promise<FileTaskResult[K]>;
export async function runFileTask(task: FileTask): Promise<FileTaskResult[FileTask['kind']]> {
  switch (task.kind) {
    case 'readTable':
      return readTable(task.fileName, task.bytes, task.limits);
    case 'readTariffFile':
      return readTariffFile(task.fileName, task.bytes, task.limits);
    case 'pdfText':
      return pdfText(task.bytes, task.maxPages, task.maxUncompressedBytes);
    case 'pdfLayout':
      return pdfLayout(task.bytes, task.maxPages, task.maxUncompressedBytes);
    case 'pdfSlice':
      return pdfSlice(task.bytes, task.pages, task.maxUncompressedBytes, task.strict);
    case 'reportPdf':
      return buildReport(task.kind, task.input, task.locale, task.maxRows);
    case 'reportXlsx':
      return buildReport(task.kind, task.input, task.locale);
  }
}

/**
 * Mesaj 6 (19-B1, 06-B2): fatura raporu. `services/reports.ts` ve sözlük yalnız rapor görevi gelince yüklenir (dosya okuyan
 * çocuk hafif kalır); rapor modülü veritabanı ve ortam içe aktarmaz. Dil isteğinkidir (`withLocale`). `maxRows`: PDF fark
 * tablosunun sınırı, ana süreçten (`REPORT_PDF_MAX_ROWS`; çocuğa ortam geçmez).
 */
async function buildReport(kind: 'reportPdf' | 'reportXlsx', input: ReportInput, locale: Locale, maxRows?: number): Promise<{ bytes: Uint8Array }> {
  const [{ buildReportPdf, buildReportXlsx }, { withLocale }] = await Promise.all([import('../services/reports.ts'), import('../i18n/index.ts')]);
  const buf = await withLocale(locale, () => (kind === 'reportPdf' ? buildReportPdf(input, { maxRows }) : buildReportXlsx(input)));
  return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

export function serializeFileError(e: unknown): SerializedFileError {
  const err = e as { name?: unknown; message?: unknown; code?: unknown; params?: unknown } | null;
  const out: SerializedFileError = {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    message: typeof err?.message === 'string' ? err.message : String(e),
  };
  if (typeof err?.code === 'string') out.code = err.code;
  if (err?.params && typeof err.params === 'object') out.params = { ...(err.params as Record<string, string | number>) };
  return out;
}

/** Yakalanabilen bellek ayırma hatası (yığın dışı tampon ayrılamadı): çocuk bundan sonra güvenilmez. */
function isAllocationFailure(e: unknown): boolean {
  return e instanceof RangeError && /allocation failed/i.test(e.message);
}

async function runTestTask(task: TestTask): Promise<unknown> {
  if (task.kind === 'testEcho') return task.value;
  if (task.kind === 'testSleep') {
    // uzun süren ama küçük ve yanıt veren iş (bekçinin masum işi öldürmediğini denemek için)
    await new Promise((r) => setTimeout(r, Number(task.value) || 0));
    return 'slept';
  }
  if (task.kind === 'testSpin') for (;;);
  if (task.kind === 'testExit') process.exit(3);
  if (task.kind === 'testEnv') return Object.keys(process.env).sort();
  if (task.kind === 'testOomScore') return process.platform === 'linux' ? readFileSync('/proc/self/oom_score_adj', 'utf8').trim() : null;
  if (task.kind === 'testAllocFail') throw new RangeError('Array buffer allocation failed');
  if (task.kind === 'testAllocateHuge') {
    // TEK büyük ayırma (320 MB'lık sayı dizisi): worker_threads'te yığın sınırına yakınken bütün süreci düşürüyordu
    return new Array(4e7).fill(0.5).length;
  }
  if (task.kind === 'testAllocateExternal') {
    // yığın DIŞI bellek (pdfjs/JSZip gibi): --max-old-space-size saymaz, yalnız bellek bekçisi keser
    const keep: Buffer[] = [];
    for (;;) {
      keep.push(Buffer.alloc(32 * 1024 * 1024, 1));
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // JS yığınını doldurur (--max-old-space-size bunu keser)
  const keep: string[][] = [];
  for (let i = 0; ; i++) keep.push(Array.from({ length: 1000 }, (_, j) => `${i}-${j}-${'x'.repeat(20)}`));
}

/**
 * Çocuktaki izleme iş parçacığı (`eval`, CommonJS): RSS'i `FILE_WORKER_RSS_MS`'de bir borusuna yazar. Yazma hata
 * verirse (ebeveyn öldü, boru kapandı) çocuk kendini öldürür: ana iş parçacığı sonsuz döngüdeyse `disconnect` olayını
 * işleyemez. Boru doluysa (EAGAIN) o ölçü atlanır. İlk ölçüyü yazınca ana iş parçacığına haber verir: hazır iletisi
 * ondan sonra gider (açılış tabanı işten önce ölçülür; ebeveyn hazır çocuğu "ölçü vermiyor" sanmaz).
 */
const RSS_MONITOR = [
  "const fs = require('node:fs');",
  "const { parentPort } = require('node:worker_threads');",
  'function tick() {',
  `  try { fs.writeSync(${FILE_WORKER_RSS_FD}, process.memoryUsage.rss() + String.fromCharCode(10)); }`,
  "  catch (e) { if (e && e.code === 'EAGAIN') return; process.kill(process.pid, 'SIGKILL'); }",
  '}',
  'tick();',
  "parentPort.postMessage('measured');",
  `setInterval(tick, ${FILE_WORKER_RSS_MS});`,
].join('\n');

function send(msg: FileWorkerResponse | FileWorkerReady) {
  try {
    process.send!(msg);
  } catch (e) {
    // Kanal kapandı: ebeveyn yok, çık. Klonlanamayan sonuç: o iş hata alır, çocuk sağlam.
    if (!process.connected) process.exit(0);
    if ('id' in msg) process.send!({ id: msg.id, ok: false, error: serializeFileError(e) } satisfies FileWorkerResponse);
  }
}

function startChild() {
  const testHooks = process.argv.includes(FILE_WORKER_TEST_HOOKS_FLAG) && process.env.NODE_ENV === 'test';
  // Linux: kap belleği dolarsa çekirdeğin bellek katili API sürecini değil önce dosya çocuğunu seçsin (artırmak yetki istemez)
  if (process.platform === 'linux') {
    try {
      writeFileSync('/proc/self/oom_score_adj', '1000');
    } catch {
      // /proc yazılamıyor: varsayılan seçim
    }
  }
  const monitor = new Worker(RSS_MONITOR, { eval: true });
  monitor.unref();
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    send({ ready: true });
  };
  // izleme ilk ölçüyü yazınca hazır; izleme düşerse de hazır (ebeveyn ölçüsüz kalır: son ölçü ve süre sınırı geçerli)
  monitor.once('message', announce);
  monitor.on('error', announce);
  monitor.once('exit', announce);
  process.on('message', async (msg: FileWorkerRequest) => {
    try {
      const kind = (msg.task as { kind: string }).kind;
      const result = testHooks && kind.startsWith('test') ? await runTestTask(msg.task as unknown as TestTask) : await runFileTask(msg.task);
      send({ id: msg.id, ok: true, result });
    } catch (e) {
      send({ id: msg.id, ok: false, error: serializeFileError(e), ...(isAllocationFailure(e) ? { fatal: 'memory' as const } : {}) });
    }
  });
  // ebeveyn kanalı kapattı (öldü ya da havuz kapandı): çocuk kalmaz
  process.on('disconnect', () => process.exit(0));
}

if (typeof process.send === 'function' && process.argv.includes(FILE_WORKER_FLAG)) startChild();
