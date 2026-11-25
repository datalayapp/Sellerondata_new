/**
 * Mesaj 6 (03-B2), Y151: dosya okuma havuzu gerçek çocuk süreçle (`FILE_WORKER_MODE=thread`: eski adı, çocuk süreç
 * havuzunun eş adı). Diğer testler `inline` koşar (vitest.config). Denenen: çocuk gerçekten açılır ve ana süreçle aynı
 * sonucu verir (tablo, tarife, PDF metni), sınırlar 413 `FILE_TOO_LARGE`, bellek ve süre aşımı 422 `FILE_TOO_COMPLEX`
 * (çocuk yenilenir), çocukta yığın tükenmesi / tek büyük ayırma / çöküş API sürecini düşürmez, açılamayan çocuk 500,
 * çocuğa ortam sırları geçmez, ebeveyni ölen çocuk kendini kapatır, kuyruk doluyken 503 `FILE_BUSY`, firma başına 2
 * çocuk, `inline` geri dönüşü, uygulama kapanınca çocuk kalmaz. Uçlarda: yükleme uçları 413/503 (+ `retry-after`) döner,
 * bozuk dosyanın bugünkü 400 `INVALID_FILE` metni değişmez.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { createDeflate, deflateRawSync, deflateSync } from 'node:zlib';
import { invoiceFileMessage, readTable as coreReadTable, readTariffFile as coreReadTariffFile } from '@deciship/core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bigCsv, bigXlsx } from '../../../packages/core/test/fixtures/robustness/build.ts';
import { buildApp } from '../src/app.ts';
import { AppError } from '../src/errors.ts';
import { withLocale } from '../src/i18n/index.ts';
import {
  closeFileWorkers,
  FILE_QUEUE_PER_COMPANY,
  FileBusyError,
  fileJobsPerCompany,
  fileWorkerStats,
  readPdfLayout,
  readPdfText,
  readTable,
  readTariffFile,
  runFileWorkerTestTask,
} from '../src/lib/fileWorkers.ts';
import { FILE_WORKER_FLAG, FILE_WORKER_RSS_FD, FILE_WORKER_TEST_HOOKS_FLAG } from '../src/workers/fileWorker.ts';
import { checkPdfInflatedSize } from '../src/workers/pdfGuard.ts';
import { prisma } from '../src/db.ts';
import { getApp, inCompany, multipart, registerCompany, SAMPLES } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

// PDF fatura içe aktarma testi için sahte yapay zekâ (gerçek çağrı yok); `nextText` yanıtın metnidir.
let nextText = '';
vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: nextText }] }) }),
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

/** Firma seçeneği (zorunlu). */
const O = { companyId: 'A' };

const KEYS = ['FILE_WORKER_MODE', 'FILE_WORKER_TEST_HOOKS', 'FILE_WORKERS', 'FILE_WORKER_HEAP_MB', 'FILE_WORKER_TIMEOUT_MS', 'FILE_QUEUE_MAX', 'FILE_MAX_ROWS', 'XLSX_MAX_UNCOMPRESSED_MB', 'PDF_MAX_PAGES', 'PDF_MAX_UNCOMPRESSED_MB', 'FILE_WORKER_RSS_LIMIT_MB', 'FILE_QUEUE_WAIT_MS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(over: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
}

beforeEach(() => {
  setEnv({ FILE_WORKER_MODE: 'thread', FILE_WORKER_TEST_HOOKS: '1' });
});
afterEach(async () => {
  await closeFileWorkers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await closeFileWorkers();
});

async function appError(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('hata bekleniyordu');
}

async function pdfWithPages(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage([300, 300]).drawText(`Sayfa ${i} takip 77${i}0012345`, { x: 20, y: 150, size: 12, font });
  return Buffer.from(await doc.save());
}

/** 1 MB sınırını aşan, birkaç KB'lık zip bombası (.xlsx adıyla). */
function zipBomb(uncompressed: number): Uint8Array {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const body = deflateRawSync(Buffer.alloc(uncompressed));
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(uncompressed, 22);
  lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(uncompressed, 24);
  ch.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + body.length, 16);
  return new Uint8Array(Buffer.concat([lh, name, body, ch, name, end]));
}

describe('worker gerçekten açılır ve ana süreçle aynı sonucu verir', () => {
  it('fatura tablosu (CSV ve XLSX), tarife dosyası, PDF metni ve konumlu metin', async () => {
    const csv = bigCsv(40);
    const xlsx = await bigXlsx(25);
    expect(await readTable('f.csv', csv, O)).toEqual(await coreReadTable('f.csv', csv));
    expect(fileWorkerStats().workers).toBe(1);
    expect(await readTable('f.xlsx', xlsx, O)).toEqual(await coreReadTable('f.xlsx', xlsx));
    const tariff = new Uint8Array(fs.readFileSync(path.join(SAMPLES, 'tariff-template-example.xlsx')));
    expect(await readTariffFile('t.xlsx', tariff, O)).toEqual(await coreReadTariffFile('t.xlsx', tariff));

    const pdf = await pdfWithPages(3);
    const text = await readPdfText(pdf, O);
    expect(text.pages).toHaveLength(3);
    expect(text.pages[1]).toContain('Sayfa 2 takip 7720012345');
    const layout = await readPdfLayout(pdf, O);
    expect(layout).toHaveLength(3);
    expect(layout[0]!.items.map((i) => i.str).join(' ')).toContain('Sayfa 1');
    // çağıranın tamponu aktarılmaz (kopya gider): sonra saklanabilir ya da yeniden okunabilir
    expect(pdf.length).toBeGreaterThan(0);
    expect((await readPdfText(pdf, O)).pages).toEqual(text.pages);
    // `inline` geri dönüşü aynı sonucu verir ve worker açmaz
    await closeFileWorkers();
    setEnv({ FILE_WORKER_MODE: 'inline' });
    expect((await readPdfText(pdf, O)).pages).toEqual(text.pages);
    expect(await readTable('f.csv', csv, O)).toEqual(await coreReadTable('f.csv', csv));
    expect(fileWorkerStats().workers).toBe(0);
  });

  it('okuma hatası (bozuk dosya) core hatası olarak döner; uçların bugünkü metinleri değişmez', async () => {
    const e = await readTable('bozuk.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), O).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'InvoiceFileError', code: 'XLSX_UNREADABLE' });
    expect(await readTable('bos.csv', new TextEncoder().encode('a,b,c\n'), O).catch((x: { code: string }) => x.code)).toBe('NO_ROWS');
    await expect(readPdfText(Buffer.from('%PDF-1.4 bozuk'), O)).rejects.not.toBeInstanceOf(AppError);
  });
});

describe('sınırlar: 413 FILE_TOO_LARGE (worker ve inline aynı)', () => {
  for (const mode of ['thread', 'inline'] as const) {
    it(`${mode}: satır, açılmış boyut ve sayfa; metin isteğin dilinde, ayrıntıda tür ve sınır`, async () => {
      setEnv({ FILE_WORKER_MODE: mode, FILE_MAX_ROWS: '1500', XLSX_MAX_UNCOMPRESSED_MB: '1', PDF_MAX_PAGES: '2' });
      const rows = await appError(readTable('f.csv', bigCsv(1501), O));
      expect(rows).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE', details: { kind: 'rows', limit: 1500 } });
      expect(rows.message).toBe('Dosyada çok fazla satır var (en çok 1.500). Dosyayı bölerek yükleyin.');
      expect((await readTable('f.csv', bigCsv(1500), O)).rows).toHaveLength(1500);

      const bomb = await withLocale('en', () => appError(readTable('bomba.xlsx', zipBomb(3 * 1024 * 1024), O)));
      expect(bomb).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE', details: { kind: 'uncompressed', limit: 1 } });
      expect(bomb.message).toBe('The file is too large when unpacked (at most 1 MB). Split the file and upload the parts.');
      expect((await appError(readTariffFile('bomba.xlsx', zipBomb(3 * 1024 * 1024), O))).details).toEqual({ kind: 'uncompressed', limit: 1 });

      const pages = await appError(readPdfText(await pdfWithPages(3), O));
      expect(pages).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE', details: { kind: 'pages', limit: 2 } });
      expect(pages.message).toContain('en çok 2 sayfa');
      expect((await appError(readPdfLayout(await pdfWithPages(3), O))).details).toEqual({ kind: 'pages', limit: 2 });
      expect((await readPdfText(await pdfWithPages(2), O)).pages).toHaveLength(2);
    });
  }
});

describe('bellek ve süre aşımı: 422 FILE_TOO_COMPLEX, worker yenilenir', () => {
  it('bellek aşımı (resourceLimits) worker\'ı düşürür, ana süreç yaşar, sonraki iş yeni worker\'da çalışır', async () => {
    // Y151: çocuğun yığını `--max-old-space-size` 128 MB; açılış yığınının (tsx + core) rahat üstünde, sınıra doldurma
    // döngüsünde varılır. Çocuk V8'in "Reached heap limit" hatasıyla ölür (stderr'de görünür), API süreci yaşar.
    setEnv({ FILE_WORKER_HEAP_MB: '128', FILE_WORKERS: '1' });
    const e = await appError(runFileWorkerTestTask('testAllocate'));
    expect(e).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
    expect(e.message).toBe('Dosya çok büyük ya da bozuk; işlenemedi. Dosyayı bölerek yükleyin.');
    expect(fileWorkerStats()).toEqual({ workers: 0, busy: 0, queued: 0 });
    expect((await readTable('f.csv', bigCsv(5), O)).rows).toHaveLength(5);
    expect(fileWorkerStats().workers).toBe(1);
  }, 60_000);

  it('süre aşımı worker\'ı sonlandırır; sıradaki iş beklemez, yeni worker\'da çalışır', async () => {
    setEnv({ FILE_WORKER_TIMEOUT_MS: '1500', FILE_WORKERS: '1' });
    // ilk worker'ın açılışı süreye girmesin diye önce ısıt
    expect(await runFileWorkerTestTask('testEcho', { value: 1 })).toBe(1);
    const started = Date.now();
    const spin = appError(runFileWorkerTestTask('testSpin'));
    const next = runFileWorkerTestTask('testEcho', { value: 'sonra' });
    const e = await spin;
    expect(e).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await next).toBe('sonra');
  }, 60_000);
});

describe('Y151: çocuk süreç yalıtımı (çocuk ölür, API süreci yaşar)', () => {
  it('yığın sınırına yakınken TEK büyük ayırma (worker_threads\'te bütün süreci düşürüyordu): 422 memory, havuz sürer', async () => {
    setEnv({ FILE_WORKER_HEAP_MB: '128', FILE_WORKERS: '1' });
    const pid = process.pid;
    const e = await appError(runFileWorkerTestTask('testAllocateHuge'));
    expect(e).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
    expect(process.pid).toBe(pid);
    expect(fileWorkerStats()).toEqual({ workers: 0, busy: 0, queued: 0 });
    expect((await readTable('f.csv', bigCsv(5), O)).rows).toHaveLength(5);
  }, 60_000);

  it('çocuk kendiliğinden çıkarsa (çöküş) 422 crash; yakalanan ayırma hatası çocuğu öldürür, 422 memory', async () => {
    setEnv({ FILE_WORKERS: '1' });
    expect(await appError(runFileWorkerTestTask('testExit'))).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'crash' } });
    expect(fileWorkerStats().workers).toBe(0);
    // "Array buffer allocation failed": çocuk yanıt verebilir ama güvenilmez; havuz onu öldürür
    expect(await runFileWorkerTestTask('testEcho', { value: 1 })).toBe(1);
    expect(await appError(runFileWorkerTestTask('testAllocFail'))).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
    expect(fileWorkerStats().workers).toBe(0);
    expect(await runFileWorkerTestTask('testEcho', { value: 2 })).toBe(2);
  }, 60_000);

  it('Y151 inceleme: çocuğa gönderilemeyen görev (klonlanamayan veri) asılı kalmaz; yalnız o iş düşer, çocuk sürer', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_WORKER_TIMEOUT_MS: '30000' });
    expect(await runFileWorkerTestTask('testEcho', { value: 1 })).toBe(1);
    const started = Date.now();
    const e = await runFileWorkerTestTask('testEcho', { value: () => 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AppError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fileWorkerStats()).toEqual({ workers: 1, busy: 0, queued: 0 });
    expect(await runFileWorkerTestTask('testEcho', { value: 2 })).toBe(2);
  }, 60_000);

  it('Y151 inceleme: Linux\'ta çocuğun oom_score_adj değeri 1000 (kap belleği dolarsa çekirdek API yerine çocuğu öldürür)', async () => {
    expect(await runFileWorkerTestTask('testOomScore')).toBe(process.platform === 'linux' ? '1000' : null);
  }, 60_000);

  it('açılamayan çocuk (yığın açılışa yetmiyor) yapılandırma hatasıdır: 500, dosya suçlanmaz', async () => {
    setEnv({ FILE_WORKER_HEAP_MB: '1', FILE_WORKERS: '1' });
    const e = await readTable('f.csv', bigCsv(3), O).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(AppError);
    expect((e as Error).message).toContain('before it was ready');
    expect(fileWorkerStats()).toEqual({ workers: 0, busy: 0, queued: 0 });
  }, 60_000);

  it('çocuğa ebeveynin ortamı geçmez (yalnız izinli liste: veritabanı adresi, sırlar yok)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await closeFileWorkers();
      const keys = (await runFileWorkerTestTask('testEnv')) as string[];
      expect(keys).toContain('NODE_ENV');
      // vitest.config'in ve testin koyduğu sırlar ve adresler
      for (const k of ['DATABASE_URL', 'FILE_TOKEN_SECRET', 'ANTHROPIC_API_KEY', 'STORAGE_DIR', 'ALLOWED_ORIGINS', 'FILE_WORKER_TEST_HOOKS', 'NODE_OPTIONS']) expect(keys).not.toContain(k);
      // Windows'ta libuv eksik "zorunlu" değişkenleri (USERPROFILE, PATH, HOMEDRIVE…) ebeveynden ekler; Linux'ta yalnız liste
      if (process.platform !== 'win32') for (const k of keys) expect(['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'TEMP', 'TMP', 'TMPDIR']).toContain(k);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 60_000);

  it('ebeveyni ölen çocuk (kanal ve ölçü borusu kapandı) sonsuz döngüdeyken de kendini kapatır', async () => {
    // Havuzun açtığı gibi bir çocuk; ebeveynin ölümü, kanalın ve RSS borusunun kapanmasıyla canlandırılır
    const entry = fileURLToPath(new URL('../src/workers/fileWorker.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = fork(entry, [FILE_WORKER_FLAG, FILE_WORKER_TEST_HOOKS_FLAG], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { NODE_ENV: 'test', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) },
      execArgv: ['--import', tsx],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
      windowsHide: true,
    });
    const exited = once(child, 'exit');
    try {
      const pipe = child.stdio[FILE_WORKER_RSS_FD] as import('node:stream').Readable;
      pipe.resume();
      await once(child, 'message'); // hazır
      child.send({ id: 1, task: { kind: 'testSpin' } });
      await new Promise((r) => setTimeout(r, 300));
      pipe.destroy();
      child.disconnect();
      const started = Date.now();
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
      // kendini kapattı (ana iş parçacığı döngüde; izleme iş parçacığı yazamayınca): yedek öldürme hiç çalışmadı
      expect(child.killed).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('kuyruk ve firma sınırı', () => {
  it('kuyruk doluyken 503 FILE_BUSY (retry-after); kuyruk boşalınca bekleyen iş çalışır', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_QUEUE_MAX: '1', FILE_WORKER_TIMEOUT_MS: '3000' });
    expect(await runFileWorkerTestTask('testEcho', { value: 0 })).toBe(0);
    const spin = runFileWorkerTestTask('testSpin').catch((x: unknown) => x);
    const waiting = runFileWorkerTestTask('testEcho', { value: 'bekleyen' });
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: 1 });
    const busy = await appError(readTable('f.csv', bigCsv(3), O));
    expect(busy).toBeInstanceOf(FileBusyError);
    expect(busy).toMatchObject({ statusCode: 503, code: 'FILE_BUSY', retryAfter: 3 });
    expect(busy.message).toBe('Şu an çok sayıda dosya işleniyor. Birkaç saniye sonra yeniden deneyin.');
    expect(await spin).toMatchObject({ code: 'FILE_TOO_COMPLEX' });
    expect(await waiting).toBe('bekleyen');
  }, 60_000);

  it('bir firma aynı anda en çok 2 worker kullanır; başka firmanın işi sırada öne geçer', async () => {
    setEnv({ FILE_WORKERS: '3', FILE_WORKER_TIMEOUT_MS: '30000' });
    const a1 = runFileWorkerTestTask('testSpin', { companyId: 'A' }).catch((x: unknown) => x);
    const a2 = runFileWorkerTestTask('testSpin', { companyId: 'A' }).catch((x: unknown) => x);
    const a3 = runFileWorkerTestTask('testEcho', { companyId: 'A', value: 'a3' }).catch((x: unknown) => x);
    expect(fileWorkerStats()).toMatchObject({ busy: 2, queued: 1 });
    expect(await runFileWorkerTestTask('testEcho', { companyId: 'B', value: 'b1' })).toBe('b1');
    expect(fileWorkerStats()).toMatchObject({ busy: 2, queued: 1 });
    // kapanışta süren ve bekleyen işler 503 alır, worker kalmaz
    await closeFileWorkers();
    for (const r of await Promise.all([a1, a2, a3])) expect(r).toMatchObject({ statusCode: 503, code: 'FILE_BUSY' });
    expect(fileWorkerStats()).toEqual({ workers: 0, busy: 0, queued: 0 });
  }, 60_000);
});

describe('uygulama kapanınca worker kalmaz', () => {
  it('app.close worker\'ları sonlandırır', async () => {
    const app = await buildApp();
    await app.ready();
    expect((await readTable('f.csv', bigCsv(3), O)).rows).toHaveLength(3);
    expect(fileWorkerStats().workers).toBe(1);
    await app.close();
    expect(fileWorkerStats().workers).toBe(0);
  });
});

describe('uçlar: dosya okuyan uçlar havuzun hatalarını olduğu gibi döner', () => {
  const API = '/api/deciship';
  type Ctx = { auth: { authorization: string }; carrierId: string };
  /** Varsayılan sınırın (200 MB) üstünde açılan, ~200 KB'lık zip; bir kez üretilir. */
  let bigBomb: Uint8Array | undefined;
  async function setup(): Promise<Ctx> {
    const app = await getApp();
    const admin = await registerCompany(app);
    const r = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: 'FedEx Dosya' } });
    expect(r.statusCode, r.body).toBe(201);
    return { auth: admin.auth, carrierId: r.json().carrier.id };
  }
  async function upload(c: Ctx, url: string, filename: string, contentType: string, data: Buffer | Uint8Array, lang = 'tr') {
    const app = await getApp();
    const form = multipart([
      { name: 'carrierId', value: c.carrierId },
      { name: 'file', filename, contentType, data: Buffer.from(data) },
    ]);
    return app.inject({ method: 'POST', url: `${API}${url}`, headers: { ...c.auth, ...form.headers, 'accept-language': lang }, payload: form.payload });
  }

  for (const mode of ['thread', 'inline'] as const) {
    it(`${mode}: fatura önizleme satır sınırı 413, tarife PDF'i sayfa sınırı 413, bozuk Excel bugünkü 400`, async () => {
      setEnv({ FILE_WORKER_MODE: mode, FILE_MAX_ROWS: '20', PDF_MAX_PAGES: '2' });
      const c = await setup();
      const ok = await upload(c, '/invoices/preview', 'fatura.csv', 'text/csv', bigCsv(20));
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().rowCount).toBe(20);

      const rows = await upload(c, '/invoices/preview', 'fatura.csv', 'text/csv', bigCsv(21), 'en');
      expect(rows.statusCode, rows.body).toBe(413);
      expect(rows.json().error).toEqual({
        code: 'FILE_TOO_LARGE',
        message: 'The file has too many rows (at most 20). Split the file and upload the parts.',
        details: { kind: 'rows', limit: 20 },
      });

      const pages = await upload(c, '/tariff-imports', 'tarife.pdf', 'application/pdf', await pdfWithPages(3));
      expect(pages.statusCode, pages.body).toBe(413);
      expect(pages.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { kind: 'pages', limit: 2 } });

      const bomb = await upload(c, '/tariff-imports', 'tarife.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (bigBomb ??= zipBomb(201 * 1024 * 1024)));
      expect(bomb.statusCode, bomb.body).toBe(413);
      expect(bomb.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { kind: 'uncompressed', limit: 200 } });

      const broken = await upload(c, '/invoices/preview', 'bozuk.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]));
      expect(broken.statusCode, broken.body).toBe(400);
      expect(broken.json().error.code).toBe('INVALID_FILE');
      expect(broken.json().error.message).toBe(invoiceFileMessage('XLSX_UNREADABLE', 'tr'));
    }, 120_000);
  }

  it('thread: kuyruk doluyken yükleme 503 FILE_BUSY ve retry-after döner', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_QUEUE_MAX: '1', FILE_WORKER_TIMEOUT_MS: '20000' });
    const c = await setup();
    expect(await runFileWorkerTestTask('testEcho', { value: 0 })).toBe(0);
    const spin = runFileWorkerTestTask('testSpin').catch((x: unknown) => x);
    const waiting = runFileWorkerTestTask('testEcho', { value: 1 }).catch((x: unknown) => x);
    const r = await upload(c, '/invoices/preview', 'fatura.csv', 'text/csv', bigCsv(3));
    expect(r.statusCode, r.body).toBe(503);
    expect(r.headers['retry-after']).toBe('3');
    expect(r.json().error).toMatchObject({ code: 'FILE_BUSY', message: 'Şu an çok sayıda dosya işleniyor. Birkaç saniye sonra yeniden deneyin.' });
    await closeFileWorkers();
    await Promise.all([spin, waiting]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// R2 (Mesaj 6 bağımsız incelemesi): yığın dışı bellek, firma adaleti, içe aktarmada denetim, bağlantı kopması.

/** İncelemenin kanıtı: tek sayfalı, içerik akışı FlateDecode bombası olan PDF. `length`: 'direct' | 'indirect' | 'short' (yalan). */
function pdfBomb(size: number, length: 'direct' | 'indirect' | 'short' = 'direct'): Buffer {
  return pdfWithContent(deflateSync(Buffer.concat([BOMB_HEAD, Buffer.alloc(size, 0x20)])), length);
}

const BOMB_HEAD = Buffer.from('BT /F1 12 Tf 10 10 Td (takip 123) Tj ET\n');

/**
 * `pdfBomb` ile aynı PDF, ama akış 1 MB'lık parçalarla sıkıştırılır: `size` boyutunda geçici tampon ayrılmaz. Büyük
 * bomba için: `deflateSync` yolu ~1,2 GB çöp bırakır, ana süreç onu ne zaman toplayacağı belirsizdir; bekçi testinin RSS
 * tabanı bu çöple ölçülürse sınır o kadar yükselir, çöp iş sürerken toplanınca bomba sınıra hiç ulaşmayabilir.
 */
async function pdfBombStreamed(size: number): Promise<Buffer> {
  const z = createDeflate();
  const out: Buffer[] = [];
  z.on('data', (c: Buffer) => out.push(c));
  const done = once(z, 'end');
  z.write(BOMB_HEAD);
  const chunk = Buffer.alloc(MB, 0x20);
  for (let left = size; left > 0; left -= chunk.length) {
    if (!z.write(left >= chunk.length ? chunk : chunk.subarray(0, left))) await once(z, 'drain');
  }
  z.end();
  await done;
  return pdfWithContent(Buffer.concat(out));
}

function pdfWithContent(content: Buffer, length: 'direct' | 'indirect' | 'short' = 'direct'): Buffer {
  const len = length === 'indirect' ? '6 0 R' : length === 'short' ? '10' : String(content.length);
  const objs: Buffer[] = [
    Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'),
    Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'),
    Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n'),
    Buffer.concat([Buffer.from(`4 0 obj << /Length ${len} /Filter /FlateDecode >> stream\n`), content, Buffer.from('\nendstream endobj\n')]),
    Buffer.from('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'),
    Buffer.from(`6 0 obj ${content.length} endobj\n`),
  ];
  let pdf = Buffer.from('%PDF-1.4\n');
  const offs: number[] = [];
  for (const o of objs) {
    offs.push(pdf.length);
    pdf = Buffer.concat([pdf, o]);
  }
  const xref = pdf.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(x)]);
}

const MB = 1024 * 1024;
const rssMb = () => Math.round(process.memoryUsage.rss() / MB);
/**
 * Testin ana süreçte ayırdığı büyük tamponu hemen geri verir (`ArrayBuffer.transfer(0)`: bellek GC'yi beklemeden serbest).
 * Bırakılmazsa sonraki testlerde varsayılan bekçi sınırına (1200 MB) sayılır: büyük yığınlı makinede (CI, 16 GB) GC geç
 * çalışır, 550 MB'lık tampon sonraki testte hâlâ RSS'tedir ve küçük bir PDF bile "memory" ile öldürülür (422).
 */
const releaseHog = (b: Buffer) => (b.buffer as ArrayBuffer & { transfer(length: number): ArrayBuffer }).transfer(0);

describe('PDF akış bombası: pdfjs\'e vermeden önce sayılır (413)', () => {
  it('akışların açılmış toplamı sayılır; doğrudan, dolaylı ve yalan /Length aynı sonucu verir', async () => {
    for (const kind of ['direct', 'indirect', 'short'] as const) {
      const r = await checkPdfInflatedSize(pdfBomb(4 * MB, kind), 2 * MB);
      expect(r.ok, kind).toBe(false);
    }
    const ok = await checkPdfInflatedSize(pdfBomb(MB), 2 * MB);
    expect(ok.ok).toBe(true);
    expect(ok.size).toBeGreaterThan(MB);
    expect((await checkPdfInflatedSize(await pdfWithPages(3), MB)).ok).toBe(true);
  });

  for (const mode of ['thread', 'inline'] as const) {
    it(`${mode}: sınırı aşan akış 413 uncompressed; küçük PDF okunur`, async () => {
      setEnv({ FILE_WORKER_MODE: mode, PDF_MAX_UNCOMPRESSED_MB: '8' });
      const bomb = pdfBomb(20 * MB);
      expect(bomb.length).toBeLessThan(100 * 1024);
      const e = await appError(readPdfText(bomb, O));
      expect(e).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE', details: { kind: 'uncompressed', limit: 8 } });
      expect(e.message).toBe('Dosyanın açılmış hâli çok büyük (en çok 8 MB). Dosyayı bölerek yükleyin.');
      expect((await appError(readPdfLayout(pdfBomb(20 * MB, 'indirect'), O))).details).toEqual({ kind: 'uncompressed', limit: 8 });
      expect((await readPdfText(pdfBomb(MB), O)).pages[0]).toContain('takip 123');
    });
  }
});

describe('bellek bekçisi: yığın dışı bellek RSS ile izlenir (422 memory)', () => {
  it('yığın dışı ayıran iş (resourceLimits saymaz) RSS sınırında sonlandırılır; havuz çalışmaya devam eder', async () => {
    setEnv({ FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 300), FILE_WORKER_TIMEOUT_MS: '60000' });
    const e = await appError(runFileWorkerTestTask('testAllocateExternal'));
    expect(e).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
    expect(fileWorkerStats()).toEqual({ workers: 0, busy: 0, queued: 0 });
    expect(await runFileWorkerTestTask('testEcho', { value: 'yine' })).toBe('yine');
  }, 60_000);

  it('gerçek pdfjs bombası (ön denetim kapalıyken) de bekçiye takılır', async () => {
    // Sınır şimdiki RSS'e göre: taban çöpsüz ölçülsün (akışla kurulan bomba; önceki testin öldürülen worker'ı
    // `closeFileWorkers` ile tamamen kapandı). Yoksa iş sürerken düşen taban bombanın sınırı aşmasını engelleyebilir.
    const bomb = await pdfBombStreamed(600 * MB);
    setEnv({ PDF_MAX_UNCOMPRESSED_MB: '100000', FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 300), FILE_WORKER_TIMEOUT_MS: '60000' });
    const e = await appError(readPdfText(bomb, O));
    expect(e).toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
  }, 120_000);

  it('iki iş sürerken büyüyen (ölçü veren) worker öldürülür, eşzamanlı çalışan masum iş sürer', async () => {
    setEnv({ FILE_WORKERS: '3', FILE_WORKER_TIMEOUT_MS: '60000' });
    // ısıt: worker açılışı ölçüme girmesin
    await Promise.all([runFileWorkerTestTask('testEcho', { companyId: 'X' }), runFileWorkerTestTask('testEcho', { companyId: 'Y' })]);
    setEnv({ FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 300) });
    const spin = runFileWorkerTestTask('testSpin', { companyId: 'X', size: 10 * MB }).catch((x: unknown) => x);
    const grow = await appError(runFileWorkerTestTask('testAllocateExternal', { companyId: 'Y', size: 1024 }));
    expect(grow).toMatchObject({ code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
    expect(fileWorkerStats().busy).toBe(1); // masum iş hâlâ çalışıyor
    await closeFileWorkers();
    expect(await spin).toMatchObject({ code: 'FILE_BUSY' });
  }, 60_000);
});

describe('firma adaleti (varsayılan worker sayısıyla)', () => {
  it('A 6 yavaş iş, B 1 küçük iş: B beklemeden çalışır; A\'nın fazlası yalnız A\'ya 503', async () => {
    setEnv({ FILE_WORKER_TIMEOUT_MS: '20000' });
    expect(process.env.FILE_WORKERS).toBeUndefined();
    expect(fileJobsPerCompany()).toBe(1); // varsayılan 2 worker: biri her zaman başka firmalara kalır
    await Promise.all([runFileWorkerTestTask('testEcho', { companyId: 'W' }), runFileWorkerTestTask('testEcho', { companyId: 'W2' })]);
    const a = Array.from({ length: 6 }, () => runFileWorkerTestTask('testSpin', { companyId: 'A' }).catch((x: unknown) => x));
    // A: 1 çalışıyor + 4 bekliyor; 6. iş yalnız A'ya 503
    // firmanın kendi bekleyen işi tavanda: metin bunu söyler ("çok sayıda dosya" değil)
    expect(await a[5]).toMatchObject({
      statusCode: 503,
      code: 'FILE_BUSY',
      message: 'Firmanızın başka bir dosya işlemi sürüyor. O bitince yeniden deneyin.',
      details: { scope: 'company' },
    });
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: FILE_QUEUE_PER_COMPANY });
    const started = Date.now();
    expect(await runFileWorkerTestTask('testEcho', { companyId: 'B', value: 'b' })).toBe('b');
    expect(Date.now() - started).toBeLessThan(5_000);
    await closeFileWorkers();
    for (const r of await Promise.all(a.slice(0, 5))) expect(r).toMatchObject({ code: 'FILE_BUSY' });
  }, 60_000);

  it('sıra firmalar arasında döner (round-robin): A\'nın birikmiş işi B\'nin ve C\'nin önüne geçmez', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_WORKER_TIMEOUT_MS: '1500' });
    await runFileWorkerTestTask('testEcho', { companyId: 'W' });
    const order: string[] = [];
    const hold = runFileWorkerTestTask('testSpin', { companyId: 'H' }).catch(() => order.push('H'));
    const jobs = (
      [
        ['A', 1],
        ['A', 2],
        ['A', 3],
        ['B', 1],
        ['C', 1],
      ] as const
    ).map(([c, i]) => runFileWorkerTestTask('testEcho', { companyId: c, value: `${c}${i}` }).then((v) => order.push(String(v))));
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: 5 });
    // tutan iş süre sınırında düşer; kuyruk tek worker'da firmalar arasında sırayla boşalır
    setEnv({ FILE_WORKER_TIMEOUT_MS: '20000' });
    await hold;
    await Promise.all(jobs);
    expect(order).toEqual(['H', 'A1', 'B1', 'C1', 'A2', 'A3']);
  }, 60_000);

  it('istemci bağlantıyı keserse kuyruktaki iş çıkarılır (çalışan iş bırakılır)', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_WORKER_TIMEOUT_MS: '20000' });
    await runFileWorkerTestTask('testEcho', { companyId: 'W' });
    const spin = runFileWorkerTestTask('testSpin', { companyId: 'A' }).catch((x: unknown) => x);
    const socket = new EventEmitter();
    const queued = runFileWorkerTestTask('testEcho', { companyId: 'B', connection: socket as never }).catch((x: unknown) => x);
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: 1 });
    socket.emit('close');
    expect(await queued).toMatchObject({ code: 'FILE_BUSY' });
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: 0 });
    expect(socket.listenerCount('close')).toBe(0);
    await closeFileWorkers();
    await spin;
  }, 60_000);
});

describe('POST /invoices: saklı PDF metin denetimi havuz yüzünden içe aktarmayı düşürmez', () => {
  const API = '/api/deciship';
  const blank = {
    shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
    billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null,
  };
  let auth: { authorization: string };
  let carrierId: string;
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const app = await getApp();
    const admin = await registerCompany(app, 'PDF Havuz');
    auth = admin.auth;
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'fedex', name: 'FedEx Havuz' } });
    expect(c.statusCode, c.body).toBe(201);
    carrierId = c.json().carrier.id;
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  let seq = 0;
  async function preview() {
    seq++;
    const pdf = Buffer.concat([await pdfWithPages(3), Buffer.from(`\n%${seq}-${Date.now()}\n`)]);
    nextText = JSON.stringify({ invoiceNo: `H-${seq}`, invoiceDate: '2026-10-27', currency: 'TRY', amountsIncludeVat: false, lines: [{ ...blank, trackingNo: `77${seq}0012345`, netAmount: 10 }] });
    const app = await getApp();
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: `fatura-${seq}.pdf`, contentType: 'application/pdf', data: pdf },
    ]);
    // Y83: PDF okuma yalnız arka planda; `viaJob` işin sonucunu eski yanıt biçiminde verir (503/413 istekten doğrudan)
    return viaJob(app, { method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  }
  async function importPdf(p: { fileId: string; aiLines: unknown[] }) {
    const app = await getApp();
    return app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: auth,
      payload: { fileId: p.fileId, carrierId, invoiceNo: `HV-${seq}-${Date.now()}`, invoiceDate: '2026-10-27', currency: 'TRY', lines: p.aiLines, confirmOverlap: true },
    });
  }
  /**
   * Mesaj 7 (Mesaj 6 E2): içe aktarma sayfa metnini önizlemenin kaydından (`File.preview.pageTexts`) alır, PDF'i yeniden
   * okumaz. Bu testler dosyadan okuma yolunu (kayıtta metin yok: 1 MB üstü ya da Mesaj 7 öncesi önizleme) dener: metin
   * kayıttan silinir.
   */
  async function dropPreviewText(fileId: string) {
    await inCompany(auth, () => prisma.file.update({ where: { id: fileId }, data: { preview: { v: 1, skipped: [] } } }));
  }
  /** Tek worker'ı tutar ve kuyruğu doldurur: sonraki her iş 503 alır. */
  async function fillPool() {
    setEnv({ FILE_WORKERS: '1', FILE_QUEUE_MAX: '1', FILE_WORKER_TIMEOUT_MS: '30000' });
    await runFileWorkerTestTask('testEcho', { companyId: 'W' });
    return [runFileWorkerTestTask('testSpin', { companyId: 'W' }).catch(() => 0), runFileWorkerTestTask('testEcho', { companyId: 'W' }).catch(() => 0)];
  }

  it('havuz doluyken (503) içe aktarma yüklenir, denetim "skipped" ("metin katmanı yok" değil); önizleme bugünkü gibi 503 döner', async () => {
    const p = await preview();
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().pdfCheck.method).toBe('text');
    // kayıtta metin varken (Mesaj 7) havuz dolu olsa da içe aktarma havuza gitmez: denetim önizlemenin metniyle yapılır
    const withText = await preview();
    expect(withText.statusCode, withText.body).toBe(200);
    await dropPreviewText(p.json().fileId);
    const held = await fillPool();
    const r = await importPdf(p.json());
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfCheck).toEqual({ method: 'skipped', checked: 0, unverified: 0 });
    const t = await importPdf(withText.json());
    expect(t.statusCode, t.body).toBe(201);
    // sahte PDF'in metninde takip no yok: satır işaretlenir (denetim gerçekten metinle yapıldı)
    expect(t.json().importReport.pdfCheck).toEqual({ method: 'text', checked: 1, unverified: 1 });
    const busy = await preview();
    expect(busy.statusCode, busy.body).toBe(503);
    expect(busy.json().error.code).toBe('FILE_BUSY');
    await closeFileWorkers();
    await Promise.all(held);
  }, 60_000);

  it('süre aşımında (422) içe aktarma yüklenir, denetim "skipped"; sayfa sınırı (413) içe aktarmayı reddeder', async () => {
    const p = await preview();
    expect(p.statusCode, p.body).toBe(200);
    await dropPreviewText(p.json().fileId);
    await closeFileWorkers();
    setEnv({ FILE_WORKER_TIMEOUT_MS: '1' });
    const r = await importPdf(p.json());
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfCheck.method).toBe('skipped');

    setEnv({ FILE_WORKER_TIMEOUT_MS: '60000' });
    const q = await preview();
    expect(q.statusCode, q.body).toBe(200);
    await dropPreviewText(q.json().fileId);
    setEnv({ PDF_MAX_PAGES: '2' });
    const big = await importPdf(q.json());
    expect(big.statusCode, big.body).toBe(413);
    expect(big.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { kind: 'pages', limit: 2 } });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// İkinci inceleme (Mesaj 6 R2b): pdfGuard atlatma yolları, bekçinin mutlak tavanı ve masum iş, kuyruk bekleme süresi,
// önizlemede sahipsiz dosya.

/** Akışı FlateDecode bombası olan tek sayfalı PDF; sözlük ve `stream` sonrası kurgusu değiştirilebilir (atlatma denemeleri). */
function pdfBombVariant(size: number, v: { dict: (len: number) => string; afterStream?: string; extra?: string[] }): Buffer {
  const content = deflateSync(Buffer.concat([Buffer.from('BT /F1 12 Tf 10 10 Td (takip 123) Tj ET\n'), Buffer.alloc(size, 0x20)]));
  const objs: Buffer[] = [
    Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'),
    Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'),
    Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n'),
    Buffer.concat([Buffer.from(`4 0 obj ${v.dict(content.length)} stream${v.afterStream ?? '\n'}`), content, Buffer.from('\nendstream endobj\n')]),
    Buffer.from('5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'),
    ...(v.extra ?? []).map((x) => Buffer.from(x)),
  ];
  let pdf = Buffer.from('%PDF-1.4\n');
  const offs: number[] = [];
  for (const o of objs) {
    offs.push(pdf.length);
    pdf = Buffer.concat([pdf, o]);
  }
  const xref = pdf.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(x)]);
}

const BYPASSES: Record<string, Parameters<typeof pdfBombVariant>[1]> = {
  'sözlükte (obj) dizesi': { dict: (l) => `<< /Length ${l} /Filter /FlateDecode /Note (obj) >>` },
  'dolaylı süzgeç /Filter 6 0 R': { dict: (l) => `<< /Length ${l} /Filter 6 0 R >>`, extra: ['6 0 obj /FlateDecode endobj\n'] },
  'ad kaçışı /#46lateDecode': { dict: (l) => `<< /Length ${l} /Filter /#46lateDecode >>` },
  '8 KB\'tan büyük sözlük': { dict: (l) => `<< /Filter /FlateDecode /Pad (${'x'.repeat(9000)}) /Length ${l} >>` },
  'stream sözcüğünden sonra boşluk': { dict: (l) => `<< /Length ${l} /Filter /FlateDecode >>`, afterStream: '   \r\n' },
};

describe('pdfGuard: ikinci incelemenin beş atlatma yolu', () => {
  for (const [name, v] of Object.entries(BYPASSES)) {
    it(`${name}: akış sözlüğe bakılmadan sayılır, 413`, async () => {
      setEnv({ PDF_MAX_UNCOMPRESSED_MB: '2' });
      const bomb = pdfBombVariant(8 * MB, v);
      expect((await checkPdfInflatedSize(bomb, 2 * MB)).ok).toBe(false);
      expect(await appError(readPdfText(bomb, O))).toMatchObject({ statusCode: 413, details: { kind: 'uncompressed', limit: 2 } });
      // aynı kurgu sınırın altında okunur (ön denetim yanlış alarm vermez)
      expect((await checkPdfInflatedSize(pdfBombVariant(MB, v), 2 * MB)).ok).toBe(true);
    });
  }
});

describe('bellek bekçisi: mutlak tavan ve masum iş', () => {
  it('RSS sınırın 1,3 katını aştıysa büyüme koşulu aranmaz: iş öldürülür', async () => {
    await runFileWorkerTestTask('testEcho', { value: 0 });
    // sınır şimdiki RSS'in çok altında: iş başlamadan önce de aşılmış (büyüme yok), yine öldürülür
    setEnv({ FILE_WORKER_RSS_LIMIT_MB: String(Math.max(1, Math.floor(rssMb() / 2))), FILE_WORKER_TIMEOUT_MS: '30000' });
    const e = await appError(runFileWorkerTestTask('testSleep', { value: 20_000 }));
    expect(e).toMatchObject({ code: 'FILE_TOO_COMPLEX', details: { reason: 'memory' } });
  }, 60_000);

  it('ana süreç büyüdü, iş küçük ve ölçü veriyor (tavanın altında): iş öldürülmez', async () => {
    await runFileWorkerTestTask('testEcho', { value: 0 });
    setEnv({ FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 150), FILE_WORKER_TIMEOUT_MS: '30000' });
    const job = runFileWorkerTestTask('testSleep', { value: 1500 }).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 100));
    // ana süreç (worker değil) 250 MB büyür: RSS sınırı aşar, dörtte bir büyüme koşulu sağlanır, tavan (1,3×) aşılmaz
    const hog = Buffer.alloc(250 * MB, 1);
    try {
      expect(process.memoryUsage.rss() / MB).toBeGreaterThan(Number(process.env.FILE_WORKER_RSS_LIMIT_MB));
      expect(await job).toBe('slept');
      expect(hog.length).toBe(250 * MB);
    } finally {
      releaseHog(hog);
    }
  }, 60_000);

  it('Y151 inceleme: API süreci bir an takılırsa (ölçüler borudan henüz okunmadı) masum iş "susan çocuk" sayılıp öldürülmez', async () => {
    await runFileWorkerTestTask('testEcho', { value: 0 });
    // Sınır ve büyüme: toplam sınırı aşar, büyüme koşulu (sınırın dörtte biri) sağlanır, mutlak tavan (1,3×) süreç küçükken de
    // aşılmaz (R + 550 + pay < 1,3 × (R + 500)).
    setEnv({ FILE_WORKER_RSS_LIMIT_MB: String(rssMb() + 500), FILE_WORKER_TIMEOUT_MS: '30000' });
    const job = runFileWorkerTestTask('testSleep', { value: 2500 }).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 300));
    // önceki testteki gibi ana süreç sınırı aşar (iş masum, ölçü veriyor) ...
    const hog = Buffer.alloc(550 * MB, 1);
    try {
      expect(process.memoryUsage.rss() / MB).toBeGreaterThan(Number(process.env.FILE_WORKER_RSS_LIMIT_MB));
      // ... ve olay döngüsü 1,5 sn eşzamanlı meşgul (büyük sonuç, dışa aktarma): bekçinin zamanlayıcısı, borulardaki
      // taze ölçüler okunmadan önce çalışır; çocuğun son ölçüsü 1 sn'den eski görünür
      const until = Date.now() + 1500;
      while (Date.now() < until);
      expect(await job).toBe('slept');
      expect(hog.length).toBe(550 * MB);
    } finally {
      releaseHog(hog);
    }
  }, 60_000);
});

describe('Y151 inceleme: çocuğun hazır iletisi, ilk bellek ölçüsünden sonra gelir', () => {
  it('hazır iletisi işlendiğinde ilk RSS ölçüsü de okunmuş olur (yeni çocuk "ölçü vermiyor" sanılmaz, açılış tabanı işten önce)', async () => {
    const entry = fileURLToPath(new URL('../src/workers/fileWorker.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = fork(entry, [FILE_WORKER_FLAG], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { NODE_ENV: 'test', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) },
      execArgv: ['--import', tsx],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
      windowsHide: true,
    });
    try {
      let samples = 0;
      const pipe = child.stdio[FILE_WORKER_RSS_FD] as import('node:stream').Readable;
      pipe.on('data', () => samples++);
      await once(child, 'message'); // hazır
      // aynı döngü turunda okunan boru verisi bu noktada işlenmiş olur
      await new Promise((r) => setImmediate(r));
      expect(samples).toBeGreaterThan(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('kuyruk bekleme süresi (FILE_QUEUE_WAIT_MS)', () => {
  it('kuyrukta sınırdan uzun bekleyen iş 503 FILE_BUSY alır ve kuyruktan çıkar', async () => {
    setEnv({ FILE_WORKERS: '1', FILE_WORKER_TIMEOUT_MS: '20000', FILE_QUEUE_WAIT_MS: '300' });
    await runFileWorkerTestTask('testEcho', { companyId: 'W' });
    const spin = runFileWorkerTestTask('testSpin', { companyId: 'A' }).catch((x: unknown) => x);
    const started = Date.now();
    const waited = await appError(runFileWorkerTestTask('testEcho', { companyId: 'B' }));
    expect(waited).toMatchObject({ statusCode: 503, code: 'FILE_BUSY' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fileWorkerStats()).toMatchObject({ busy: 1, queued: 0 });
    await closeFileWorkers();
    await spin;
  }, 60_000);
});

describe('önizleme: okunamayan ya da sınırı aşan dosya sahipsiz File kaydı bırakmaz', () => {
  it('PDF sayfa sınırı (413), CSV satır sınırı (413) ve havuz meşgul (503): File kaydı yazılmaz', async () => {
    const API = '/api/deciship';
    const app = await getApp();
    const admin = await registerCompany(app, 'Sahipsiz Dosya');
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'fedex', name: 'FedEx Sahipsiz' } });
    expect(c.statusCode, c.body).toBe(201);
    const carrierId = c.json().carrier.id as string;
    const files = () => inCompany(admin.auth, () => prisma.file.count({ where: { kind: 'INVOICE_SOURCE' } }));
    const upload = (filename: string, contentType: string, data: Buffer | Uint8Array, query = '') => {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename, contentType, data: Buffer.from(data) },
      ]);
      return app.inject({ method: 'POST', url: `${API}/invoices/preview${query}`, headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    };
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      setEnv({ PDF_MAX_PAGES: '2', FILE_MAX_ROWS: '5' });
      // Y83: PDF yalnız arka plan yolundan (`?async=1`); sayfa sınırı (413) iş açılmadan istekten döner
      // yanıt gövdesi iletide: 422 gelirse `details.reason` (memory/timeout/crash) CI günlüğünde görünsün
      const pdf = await upload('f.pdf', 'application/pdf', await pdfWithPages(3), '?async=1');
      expect(pdf.statusCode, pdf.body).toBe(413);
      const csv = await upload('f.csv', 'text/csv', bigCsv(6));
      expect(csv.statusCode, csv.body).toBe(413);
      const xlsx = await upload('bozuk.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]));
      expect(xlsx.statusCode, xlsx.body).toBe(400);
      setEnv({ FILE_WORKERS: '1', FILE_QUEUE_MAX: '1', FILE_WORKER_TIMEOUT_MS: '30000' });
      await runFileWorkerTestTask('testEcho', { companyId: 'W' });
      const held = [runFileWorkerTestTask('testSpin', { companyId: 'W' }).catch(() => 0), runFileWorkerTestTask('testEcho', { companyId: 'W' }).catch(() => 0)];
      expect((await upload('f.csv', 'text/csv', bigCsv(3))).statusCode).toBe(503);
      await closeFileWorkers();
      await Promise.all(held);
      expect(await files()).toBe(0);
      // okunan dosya yine kaydedilir
      expect((await upload('f.csv', 'text/csv', bigCsv(3))).statusCode).toBe(200);
      expect(await files()).toBe(1);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 60_000);
});
