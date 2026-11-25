// Derleme duman testi (Dockerfile, Mesaj 6; Y151): derlenmiş dosya çalışanı (dist/fileWorker.js) havuzun açtığı gibi ayrı
// bir çocuk süreçte açılır (child_process.fork, IPC "advanced", 4. dosya tanımlayıcısında RSS borusu). Hazır iletisi ve
// izleme iş parçacığının RSS ölçüsü beklenir; küçük bir CSV (papaparse), örnek tarife Excel'i (exceljs), örnek PDF
// (pdfjs-dist/legacy) okunur ve PDF'ten sayfa kesilir (pdf-lib). Budama ya da paketleme çocuğun bir bağımlılığını
// kırdıysa derleme burada durur.
// Kullanım: node scripts/file-worker-smoke.mjs [dist klasörü]   (varsayılan: ../dist)
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '../dist'));
const samples = path.resolve(here, '../../../samples');
// src/workers/fileWorker.ts ile aynı (FILE_WORKER_FLAG, FILE_WORKER_RSS_FD)
const FLAG = '--deciship-file-worker';
const RSS_FD = 4;

let child = null;
let done = false;
function fail(...msg) {
  console.error('file worker duman testi:', ...msg);
  child?.kill('SIGKILL');
  process.exit(1);
}

const guard = setTimeout(() => fail('süre doldu'), 60_000);

// havuzdaki gibi: yalnız izinli ortam, ebeveynin execArgv'si yok, yığın sınırı
const env = {};
for (const k of ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'windir']) if (process.env[k] !== undefined) env[k] = process.env[k];
child = fork(path.join(dist, 'fileWorker.js'), [FLAG], {
  cwd: path.resolve(dist, '..'),
  env,
  execArgv: ['--max-old-space-size=256'],
  serialization: 'advanced',
  stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
  windowsHide: true,
});
child.on('error', (e) => fail('çocuk hatası', e));
child.on('exit', (code, signal) => {
  if (!done) fail(`çocuk beklenmedik biçimde çıktı (code ${code}, signal ${signal})`);
});

let rss = 0;
const rssSeen = new Promise((resolve) => {
  child.stdio[RSS_FD].setEncoding('latin1');
  child.stdio[RSS_FD].on('data', (s) => {
    const v = Number(s.trim().split('\n').at(-1));
    if (v > 0) {
      rss = v;
      resolve();
    }
  });
});

const waiters = new Map();
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
child.on('message', (res) => {
  if (res?.ready) return readyResolve();
  const w = waiters.get(res?.id);
  if (!w) return;
  waiters.delete(res.id);
  if (res.ok) w.resolve(res.result);
  else w.reject(new Error(`${res.error.name}: ${res.error.message}`));
});

let nextId = 1;
function ask(task) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    child.send({ id, task });
  });
}

try {
  await ready;
  await rssSeen;

  const csv = new TextEncoder().encode('Takip No;Tutar\n7712345;12,50\n7712346;8,00\n');
  const table = await ask({ kind: 'readTable', fileName: 'duman.csv', bytes: csv, limits: {} });
  if (table.rows.length !== 2 || table.headers[0] !== 'Takip No') throw new Error(`CSV beklenmedik: ${JSON.stringify(table)}`);

  const xlsx = new Uint8Array(readFileSync(path.join(samples, 'tariff-template-example.xlsx')));
  const tariff = await ask({ kind: 'readTariffFile', fileName: 'tarife.xlsx', bytes: xlsx, limits: {} });
  if (!tariff.prices?.length) throw new Error('tarife Excel\'i okunamadı');

  const pdf = new Uint8Array(readFileSync(path.join(samples, 'reference-card.pdf')));
  const text = await ask({ kind: 'pdfText', bytes: pdf, maxPages: 300, maxUncompressedBytes: 300 * 1024 * 1024 });
  if (!text.pages.length) throw new Error('PDF metni okunamadı');

  const slice = await ask({ kind: 'pdfSlice', bytes: pdf, pages: [1], maxUncompressedBytes: 300 * 1024 * 1024 });
  if (!(slice.bytes instanceof Uint8Array) || slice.bytes.byteLength < 100) throw new Error('PDF sayfa kesme sonucu beklenmedik');

  // Yeni denetim Mesaj 6: fatura raporu çocukta (pdfmake + yazı tipleri assets/fonts, exceljs; dinamik yüklenen parça)
  const report = {
    companyName: 'Duman',
    carrierName: 'FedEx',
    invoiceNo: 'D-1',
    invoiceDate: '2026-10-01',
    periodFrom: null,
    periodTo: null,
    currency: 'TRY',
    totals: { lines: 1, match: 0, diff: 1, unmatched: 0, noTariff: 0, overchargeTotal: 40, verifiedTotal: 0, billedTotal: 140, expectedTotal: 100 },
    lines: [{ rowIndex: 0, trackingNo: '7712345', status: 'DIFF', diffTypes: ['WEIGHT'], decision: 'OPEN', confidence: 'HIGH', dims: null, measurement: null, ourChargeableKg: 4, billedChargeableKg: 6, expectedAmount: 100, netAmount: 140, diffAmount: 40, fx: null }],
  };
  const reportPdf = await ask({ kind: 'reportPdf', input: report, locale: 'tr' });
  if (!(reportPdf.bytes instanceof Uint8Array) || Buffer.from(reportPdf.bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('rapor PDF\'i üretilemedi');
  const reportXlsx = await ask({ kind: 'reportXlsx', input: report, locale: 'en' });
  if (!(reportXlsx.bytes instanceof Uint8Array) || reportXlsx.bytes[0] !== 0x50 || reportXlsx.bytes[1] !== 0x4b) throw new Error('rapor Excel\'i üretilemedi');

  done = true;
  clearTimeout(guard);
  console.log(
    `file worker duman testi: tamam (çocuk süreç, RSS ${Math.round(rss / 1024 / 1024)} MB; CSV ${table.rows.length} satır, tarife ${tariff.prices.length} satır, PDF ${text.pages.length} sayfa, kesme ${slice.bytes.byteLength} bayt, rapor PDF ${reportPdf.bytes.byteLength} / Excel ${reportXlsx.bytes.byteLength} bayt)`,
  );
  // kanal kapanınca çocuk kendini kapatır (havuz kapanışı ve ebeveynin ölümü aynı yol)
  const exited = new Promise((r) => child.once('exit', r));
  child.disconnect();
  child.stdio[RSS_FD].destroy();
  const t = setTimeout(() => fail('kanal kapandı, çocuk çıkmadı'), 10_000);
  await exited;
  clearTimeout(t);
} catch (e) {
  fail(e);
}
