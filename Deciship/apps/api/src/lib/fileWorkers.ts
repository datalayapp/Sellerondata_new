/**
 * Dosya okuma havuzu (Mesaj 6, 03-B2; Y151). Excel/CSV/PDF API sürecinde değil ayrı, yeniden kullanılan küçük çocuk
 * süreçlerde (`child_process.fork`) açılır; böylece tek bir kötü dosya (zip bombası, binlerce sayfalık PDF, tek büyük
 * bellek ayırması) ne bütün firmaların isteklerini durdurur ne API sürecini düşürür: çocuk ölür, istek 422 alır.
 *
 * - Çocuk sayısı `FILE_WORKERS`, her birinin JS yığını `FILE_WORKER_HEAP_MB` (`--max-old-space-size`). Çocuğa ebeveynin
 *   ortamı verilmez (yalnız `CHILD_ENV` listesi: sırlar, veritabanı adresi gitmez); ebeveynin `execArgv`'si devralınmaz.
 * - Yığın dışı bellek (pdfjs ve JSZip'in açtığı tamponlar) için bellek bekçisi: çocuktaki izleme iş parçacığı RSS'i
 *   100 ms'de bir ayrı boruya yazar (ana iş parçacığı meşgulken de). İş sürerken 150 ms'de bir "toplam" = API RSS'i +
 *   Σ(çocuk RSS'i − çocuğun açılış RSS'i) hesaplanır; `FILE_WORKER_RSS_LIMIT_MB` aşıldıysa ve iş başladığından beri toplam
 *   en az sınırın dörtte biri büyüdüyse (ya da toplam sınırın 1,3 katını aştıysa) suçlu çocuk öldürülür (`pickVictim`): 422.
 * - Dosya başına süre `FILE_WORKER_TIMEOUT_MS` (çocuğun açılışı dahil). Süre ya da bellek aşılınca çocuk öldürülür, yerine
 *   gerekince yenisi açılır: 422 `FILE_TOO_COMPLEX` (`details.reason`). Çocuğun kendi ölümü: yığın tükenmesi (stderr'de
 *   "heap limit"/"out of memory") ya da dışarıdan SIGKILL (Linux'ta çekirdeğin bellek katili) `memory`, diğeri `crash`.
 *   Linux'ta çocuk `oom_score_adj` değerini 1000 yapar: kap dolarsa çekirdek API'yi değil çocuğu öldürür.
 *   Açılamayan (hazır iletisinden önce ölen) çocuk yapılandırma hatasıdır: 500, dosya suçlanmaz.
 * - Çocuk `RECYCLE_JOBS` işten sonra ya da açılıştan beri büyümesi sınırın dörtte birini aşınca yenilenir.
 * - Firma adaleti: bir firma aynı anda en çok `max(1, FILE_WORKERS - 1)` çocuk kullanır; sıradaki işler firmalar arasında
 *   sırayla (round-robin) seçilir; bir firmanın bekleyen işi en çok `FILE_QUEUE_PER_COMPANY` (aşan yalnız o firmaya 503).
 *   Bütün bekleyenler `FILE_QUEUE_MAX`; dolu → 503 `FILE_BUSY` (`retry-after`). Kuyrukta bekleme en çok `FILE_QUEUE_WAIT_MS`
 *   (aşan iş 503). Firmanın kendi bekleyen işi tavandaysa metin bunu söyler (`err.fileBusyOwn`, `details.scope: 'company'`).
 * - Sınırlar (satır, açılmış boyut, sayfa) iki biçimde de uygulanır: 413 `FILE_TOO_LARGE` (`details: { kind, limit }`).
 * - Fatura raporu da (PDF, Excel; yeni denetim Mesaj 6, 19-B1) burada üretilir: aynı kuyruk ve bekçi, ama kendi yığını
 *   (`REPORT_WORKER_HEAP_MB`) ve süresi (`REPORT_WORKER_TIMEOUT_MS`); çocuk her iş için aynı yığınlı çocuğa verilir, büyük
 *   yığınlı rapor çocuğu iş bitince kapanır (`renderReport`). Bekçi, en eski rapor işini kendi yığını içindeki büyümesi
 *   yüzünden öldürmez (`exemptReport`; rapor API'deyken de öyleydi).
 * - `FILE_WORKER_MODE=inline`: eski davranış (ana süreçte, kuyruk, süre ve bekçi yok), geri dönüş anahtarı; testlerde varsayılan.
 *
 * Diğer okuma hataları (boş dosya, eski .xls…) olduğu gibi core'un `InvoiceFileError`'ı olarak döner; uçların mevcut
 * hata metinleri değişmez. Çocuk girişi: geliştirme ve testte `.ts` kaynak (`--import tsx`), üretimde `dist/fileWorker.js`.
 * Girdi ve sonuç IPC ile (`serialization: 'advanced'`: tamponlar kopyalanarak, JSON'suz) taşınır.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fmtNumber,
  InvoiceFileError,
  type InvoiceFileErrorCode,
  type Locale,
  type PdfPageLayout,
  type RawTariffFile,
  type ReadLimits,
  type Table,
} from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { currentLocale, m } from '../i18n/index.ts';
import type { ReportInput } from '../services/reports.ts';
import {
  FILE_WORKER_FLAG,
  FILE_WORKER_RSS_FD,
  FILE_WORKER_TEST_HOOKS_FLAG,
  runFileTask,
  type FileTask,
  type FileTaskResult,
  type FileWorkerReady,
  type FileWorkerRequest,
  type FileWorkerResponse,
  type PdfSliceStrict,
  type SerializedFileError,
} from '../workers/fileWorker.ts';

const MB = 1024 * 1024;
/** Bir firmanın bekleyen (henüz çocuğa verilmemiş) işi en çok bu kadar; aşan iş yalnız o firmaya 503 alır. */
export const FILE_QUEUE_PER_COMPANY = 4;
/** 503 `FILE_BUSY` yanıtının `retry-after` değeri (sn). */
export const FILE_BUSY_RETRY_AFTER = 3;
/** Bellek bekçisinin denetim aralığı ve bir çocuğu öldürdükten sonra belleğin düşmesi için bekleme. */
const WATCH_MS = 150;
const WATCH_COOLDOWN_MS = 1000;
/** Mutlak tavan: toplam sınırın bu katını aştıysa büyüme koşuluna bakılmaz, en büyük iş öldürülür. */
const WATCH_HARD_FACTOR = 1.3;
/** Çocuğun RSS ölçüsü bundan eskiyse "ölçü vermiyor" sayılır (izleme 100 ms'de bir yazar). */
const RSS_STALE_MS = 1000;
/** Bu kadar işten sonra çocuk yenilenir (birikmiş parçalanma, sızıntı). */
const RECYCLE_JOBS = 200;
/** Tutulan stderr sonu (çöküş nedeni ve günlük için). */
const STDERR_TAIL = 8 * 1024;
/** Yığın tükenmesi (V8 "FATAL ERROR: Reached heap limit … JavaScript heap out of memory"). */
const OOM_RE = /out of memory|heap limit/i;
/**
 * Çocuğa geçen ortam değişkenleri (izinli liste). Ayrıştırıcının sırlara (veritabanı, yapay zekâ anahtarı) ihtiyacı yok;
 * `NODE_OPTIONS` de geçmez. Windows'ta Node'un kendisi `SystemRoot` ister; `TEMP`/`TMP` tsx önbelleği için.
 */
const CHILD_ENV = ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'windir'] as const;

/** Bir firmanın aynı anda kullanabileceği çocuk: en az biri her zaman başka firmalara kalır (tek çocuk varsa 1). */
export function fileJobsPerCompany(): number {
  return Math.max(1, env.fileWorkers - 1);
}

/** İsteğin bağlantısı: kapanırsa (istemci gitti) iş kuyruktaysa çıkarılır. Çalışan iş bırakılır. */
export type FileJobConnection = {
  once(event: 'close', f: () => void): unknown;
  off(event: 'close', f: () => void): unknown;
  destroyed?: boolean;
};

/** `companyId` zorunlu: firma adaleti ve sınırı bunun üzerinden işler. `connection`: genelde `req.raw.socket`. */
export type FileJobOptions = { companyId: string; connection?: FileJobConnection | null };

/** `retry-after` başlığı taşıyan uygulama hatası; başlığı `registerFileErrorHeaders` yazar. */
export class FileBusyError extends AppError {
  readonly retryAfter = FILE_BUSY_RETRY_AFTER;
  constructor(message: string, details?: unknown) {
    super(503, 'FILE_BUSY', message, details);
  }
}

/**
 * Rota eklentisinde 503 `FILE_BUSY` için `retry-after` başlığı (hata işleyicisi `AppError` başlığı taşımaz; `aiMeter`
 * `registerAiErrorHeaders` ile aynı desen). `onError` kancası yalnız ekleyen eklentinin rotalarına uygulanır.
 */
export function registerFileErrorHeaders(app: FastifyInstance) {
  app.addHook('onError', async (_req, reply, err) => {
    if (err instanceof FileBusyError) reply.header('retry-after', String(err.retryAfter));
  });
}

/** Yük hatası mı (havuz meşgul ya da iş süre/bellek sınırında düştü): çağıran "denetim yapılamadı" sayabilir. */
export function isFileLoadError(e: unknown): e is AppError {
  return e instanceof AppError && (e.code === 'FILE_BUSY' || e.code === 'FILE_TOO_COMPLEX');
}

type PoolFailure = 'busy' | 'busyOwn' | 'memory' | 'timeout' | 'crash' | 'closed' | 'gone';
/** Havuzun kendi hatası; isteğin bağlamında (dil) `toAppError` ile kullanıcı hatasına çevrilir. */
class FilePoolError extends Error {
  constructor(readonly reason: PoolFailure) {
    super(`file worker: ${reason}`);
    this.name = 'FilePoolError';
  }
}

// ---------------------------------------------------------------------------------------------
// Çocuk süreç havuzu

type TaskLike = FileTask | { kind: string };
type Job = {
  id: number;
  owner: string;
  /** Kuyruktayken çağıranın baytları (kopya yok); çocuğa gönderilirken IPC kopyalar ve bırakılır. */
  bytes: Uint8Array | null;
  /** Kurban seçiminde girdinin boyutu. */
  size: number;
  /** İşin istediği çocuk yığını (MB) ve süre sınırı (ms): dosya okuma `FILE_WORKER_*`, rapor `REPORT_WORKER_*`. */
  heapMb: number;
  timeoutMs: number;
  /**
   * Bekçinin dokunmadığı büyüme payı, MB (0: yok). Rapor işi: kendi yığını (`REPORT_WORKER_HEAP_MB`); V8 o yığını zaten
   * keser (çocuk düşer, 422), bekçi yalnız bunu aşan (yığın dışı) büyümeye bakar. Bkz. `exemptReport`.
   */
  watchAllowanceMb: number;
  build: (bytes: Uint8Array | null) => TaskLike;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** bağlantı dinleyicisini kaldırır (iş çocuğa verilince ya da bitince) */
  detach: () => void;
};
type Slot = {
  child: ChildProcess;
  /** Çocuğun `--max-old-space-size` değeri; iş yalnız aynı yığınlı çocuğa verilir (`pump`). */
  heapMb: number;
  job: Job | null;
  /** Çocuk hazır olmadan verilen işin iletisi; hazır iletisi gelince gönderilir. Yuva ve süre sayacı yine hemen kurulur. */
  pending: FileWorkerRequest | null;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  ready: boolean;
  dead: boolean;
  /** Son RSS ölçüsü ve zamanı; `baseRss` ilk ölçü (açılış), `jobRss` işin başındaki ölçü (0: henüz yok). */
  rss: number;
  rssAt: number;
  baseRss: number;
  jobRss: number;
  /** İş verildiğinde bekçi toplamı (`watchedRss`): bekçi yalnız iş başladıktan sonra büyüyen belleğe tepki verir. */
  totalAtStart: number;
  jobs: number;
  stderrTail: string;
  oom: boolean;
  /** Çocuk çıkıp boruları kapanınca (ya da hiç açılamayınca) çözülür. */
  exited: Promise<void>;
};

const slots: Slot[] = [];
/** Firma → bekleyen işler. Anahtar sırası round-robin sırasıdır: hizmet alan firma sona geçer. */
const queues = new Map<string, Job[]>();
const runningByOwner = new Map<string, number>();
/** Sonlandırılan ama henüz çıkmamış çocuklar; `closeFileWorkers` bunları da bekler. */
const terminating = new Set<Promise<void>>();
let queuedTotal = 0;
let nextId = 1;
let watch: NodeJS.Timeout | null = null;
let cooldownUntil = 0;
/** Bekçinin son denetimi: zamanlayıcı bundan çok geç çalıştıysa API süreci takılmıştı (bkz. `checkMemory`). */
let lastCheckAt = 0;

const IS_TS = import.meta.url.endsWith('.ts');

/** Çocuğun giriş dosyası, çalışma klasörü (API klasörü) ve Node bayrakları. */
function childEntry(): { entry: string; cwd: string; execArgv: string[] } {
  if (IS_TS) {
    // `.ts` girişi tsx yükler (core uzantısız içe aktarır; Node'un tür ayıklaması çözemez). Mutlak yol: cwd'den bağımsız.
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    return {
      entry: fileURLToPath(new URL('../workers/fileWorker.ts', import.meta.url)),
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      execArgv: ['--import', tsx],
    };
  }
  // Üretim: tsup girişi `fileWorker` → dist/fileWorker.js (bu kod dist/ kökündeki bir parçada çalışır)
  return { entry: fileURLToPath(new URL('./fileWorker.js', import.meta.url)), cwd: fileURLToPath(new URL('..', import.meta.url)), execArgv: [] };
}

function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

type Handle = { ref?: () => void; unref?: () => void } | null | undefined;

/** Boştaki çocuk API sürecini açık tutmaz (süreç, IPC kanalı, borular); iş sürerken tutar. */
function setRef(slot: Slot, on: boolean) {
  const c = slot.child;
  for (const h of [c, c.channel, c.stderr, c.stdio[FILE_WORKER_RSS_FD]] as Handle[]) {
    const f = on ? h?.ref : h?.unref;
    f?.call(h);
  }
}

function spawnSlot(heapMb: number): Slot {
  const { entry, cwd, execArgv } = childEntry();
  const args = [FILE_WORKER_FLAG];
  if (process.env.NODE_ENV === 'test' && process.env.FILE_WORKER_TEST_HOOKS === '1') args.push(FILE_WORKER_TEST_HOOKS_FLAG);
  const child = fork(entry, args, {
    cwd,
    env: childEnv(),
    execArgv: [`--max-old-space-size=${heapMb}`, ...execArgv],
    serialization: 'advanced',
    // 0 yok, 1 API'nin çıktısına, 2 izlenir (çöküş nedeni) ve API'nin stderr'ine aktarılır, 3 IPC, 4 RSS borusu
    stdio: ['ignore', 'inherit', 'pipe', 'ipc', 'pipe'],
    windowsHide: true,
  });
  let markExited!: () => void;
  const slot: Slot = {
    child,
    heapMb,
    job: null,
    pending: null,
    startedAt: 0,
    timer: null,
    ready: false,
    dead: false,
    rss: 0,
    rssAt: 0,
    baseRss: 0,
    jobRss: 0,
    totalAtStart: 0,
    jobs: 0,
    stderrTail: '',
    oom: false,
    exited: new Promise<void>((r) => (markExited = r)),
  };

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (s: string) => {
    // satır iki parçaya bölünmüş olabilir: önceki parçanın sonuyla birlikte aranır
    if (OOM_RE.test(slot.stderrTail.slice(-64) + s)) slot.oom = true;
    slot.stderrTail = (slot.stderrTail + s).slice(-STDERR_TAIL);
    process.stderr.write(s);
  });
  child.stderr?.on('error', () => {});

  const rssPipe = child.stdio[FILE_WORKER_RSS_FD] as Readable | null | undefined;
  let rssBuf = '';
  rssPipe?.setEncoding('latin1');
  rssPipe?.on('data', (s: string) => {
    rssBuf += s;
    const end = rssBuf.lastIndexOf('\n');
    if (end < 0) {
      if (rssBuf.length > 64) rssBuf = '';
      return;
    }
    const v = Number(rssBuf.slice(rssBuf.lastIndexOf('\n', end - 1) + 1, end));
    rssBuf = rssBuf.slice(end + 1);
    if (!Number.isFinite(v) || v <= 0) return;
    slot.rss = v;
    slot.rssAt = Date.now();
    if (!slot.baseRss) slot.baseRss = v;
    if (slot.job && !slot.jobRss) slot.jobRss = v;
  });
  rssPipe?.on('error', () => {});

  child.on('message', (msg: FileWorkerResponse | FileWorkerReady) => {
    if (typeof msg !== 'object' || msg === null) return;
    if ('ready' in msg) {
      slot.ready = true;
      const p = slot.pending;
      slot.pending = null;
      if (p && !slot.dead) post(slot, p);
      return;
    }
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    // yakalanan bellek ayırma hatası: çocuk güvenilmez, öldürülür; istek 422 memory
    if (!msg.ok && msg.fatal === 'memory') return kill(slot, 'memory');
    release(slot);
    if (msg.ok) job.resolve(msg.result);
    else job.reject(deserializeError(msg.error));
    recycleIfWorn(slot);
    pump();
  });
  child.on('close', (code, signal) => {
    const job = retire(slot);
    job?.reject(exitError(slot, code, signal));
    markExited();
    pump();
  });
  child.on('error', (err) => {
    // Açılamayan çocuk (`fork` başarısız, pid yok): 'close' gelmeyebilir. Diğer hatalar (öldürülemedi) 'close' ile biter.
    if (child.pid !== undefined) return;
    retire(slot)?.reject(err);
    markExited();
    pump();
  });
  slots.push(slot);
  return slot;
}

/** Ölen çocuğun elindeki işin hatası. */
function exitError(slot: Slot, code: number | null, signal: NodeJS.Signals | null): unknown {
  if (!slot.ready) {
    // yol, yükleyici, çok küçük yığın: yapılandırma hatası (500), dosya suçlanmaz
    return new Error(`file worker exited before it was ready (code ${code}, signal ${signal}): ${slot.stderrTail.slice(-2000)}`);
  }
  // bizim öldürmediğimiz SIGKILL: Linux'ta çekirdeğin bellek katili (kap sınırı)
  return new FilePoolError(slot.oom || signal === 'SIGKILL' ? 'memory' : 'crash');
}

/** İşi bitmiş yuvayı boşaltır (çocuk yaşar, boşta API sürecini açık tutmaz). */
function release(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  const job = slot.job;
  slot.job = null;
  slot.pending = null;
  slot.jobRss = 0;
  if (job) {
    const n = (runningByOwner.get(job.owner) ?? 1) - 1;
    if (n > 0) runningByOwner.set(job.owner, n);
    else runningByOwner.delete(job.owner);
  }
  if (!slot.dead) setRef(slot, false);
  if (!slots.some((s) => s.job) && watch) {
    clearInterval(watch);
    watch = null;
  }
}

/** Yuvayı havuzdan çıkarır; elindeki iş (varsa) döner ki çağıran onu uygun hatayla bitirsin. */
function retire(slot: Slot): Job | null {
  if (slot.dead) return null;
  const job = slot.job;
  release(slot);
  slot.dead = true;
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  return job;
}

/** Çocuğu hemen sonlandırır (iş sürüyor olabilir: sonsuz döngü); çıkışı `terminating`te beklenir. */
function stop(slot: Slot) {
  // çıkış beklenirken süreç açık kalsın (boştaki çocuğun tutamakları `unref` edilmişti)
  setRef(slot, true);
  slot.child.kill('SIGKILL');
  const t = slot.exited;
  terminating.add(t);
  void t.finally(() => terminating.delete(t));
}

/** Çocuğu öldürür, elindeki işi `reason` ile bitirir. */
function kill(slot: Slot, reason: PoolFailure) {
  const j = retire(slot);
  stop(slot);
  j?.reject(new FilePoolError(reason));
  pump();
}

/**
 * Yıpranan boş çocuğu yeniler: çok iş yaptı ya da açılıştan beri belirgin büyüdü (bellek geri verilmedi). Olağan dosya
 * yığınından farklı yığınla açılmış çocuk (rapor) işi bitince kapanır: yeri olağan çocuğa kalır, bellek geri verilir.
 */
function recycleIfWorn(slot: Slot) {
  if (slot.dead || slot.job) return;
  const grown = slot.baseRss > 0 && slot.rss - slot.baseRss > (env.fileWorkerRssLimitMb * MB) / 4;
  if (slot.jobs < RECYCLE_JOBS && !grown && slot.heapMb === env.fileWorkerHeapMb) return;
  retire(slot);
  stop(slot);
}

/** Görevi çocuğa gönderir. Gönderilemeyen görev (klonlanamayan veri): çocuk sağlam, yalnız bu iş düşer. */
function post(slot: Slot, msg: FileWorkerRequest) {
  try {
    // kanal kapandıysa geri çağırmaya hata gelir; işi çocuğun 'close' olayı bitirir
    slot.child.send(msg, () => {});
  } catch (e) {
    const job = slot.job;
    release(slot);
    job?.reject(e);
    pump();
  }
}

function dispatch(slot: Slot, job: Job) {
  job.detach();
  let task: TaskLike;
  try {
    // Düz `Uint8Array` görünümü (kopya değil): IPC `Buffer`'ı `Buffer` olarak taşır, pdfjs `Buffer`'ı reddeder.
    const b = job.bytes;
    task = job.build(b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null);
  } catch (e) {
    job.bytes = null;
    job.reject(e);
    return;
  }
  // Kopya yok: IPC gönderirken baytları kopyalar (çağıranın tamponu sağlam kalır); kuyrukta ikinci kopya tutulmaz.
  job.bytes = null;
  // Yuva ve süre sayacı burada, eşzamanlı: çocuk henüz hazır değilse de iş başlamış sayılır (süre açılışı da kapsar).
  slot.job = job;
  slot.startedAt = Date.now();
  slot.jobs++;
  slot.jobRss = slot.rssAt ? slot.rss : 0;
  slot.totalAtStart = watchedRss();
  runningByOwner.set(job.owner, (runningByOwner.get(job.owner) ?? 0) + 1);
  setRef(slot, true);
  slot.timer = setTimeout(() => kill(slot, 'timeout'), job.timeoutMs);
  startWatch();
  const msg = { id: job.id, task } as FileWorkerRequest;
  if (slot.ready) post(slot, msg);
  else slot.pending = msg;
}

/** Kuyruktan bir sonraki işi seçer: firmalar sırayla, firma tavanını aşan firma atlanır. Seçilen firma sona geçer. */
function takeNext(): Job | null {
  const cap = fileJobsPerCompany();
  for (const [owner, list] of queues) {
    if ((runningByOwner.get(owner) ?? 0) >= cap) continue;
    const job = list.shift()!;
    queuedTotal--;
    queues.delete(owner);
    if (list.length) queues.set(owner, list);
    return job;
  }
  return null;
}

/** Sıradaki işleri boş (ya da yeni açılan) çocuklara verir. */
function pump() {
  while (queuedTotal > 0) {
    const idle = slots.find((s) => !s.job && !s.dead);
    if (!idle && slots.length >= env.fileWorkers) return;
    const job = takeNext();
    if (!job) return;
    let slot: Slot;
    try {
      // İş aynı yığınlı boş çocuğa verilir. Yoksa yeni çocuk açılır; havuz doluysa farklı yığınlı boş çocuk kapatılıp yeri
      // kullanılır (çocuk sayısı `FILE_WORKERS`'ı aşmaz). Olağan dosya okuması büyük yığınlı rapor çocuğunda çalışmaz.
      const same = slots.find((s) => !s.job && !s.dead && s.heapMb === job.heapMb);
      if (same) slot = same;
      else {
        if (slots.length >= env.fileWorkers && idle) {
          retire(idle);
          stop(idle);
        }
        slot = spawnSlot(job.heapMb);
      }
    } catch (e) {
      // `fork` eşzamanlı hata verdi (ör. EMFILE): iş asılı kalmasın, yapılandırma/sistem hatası olarak düşsün
      job.detach();
      job.reject(e);
      continue;
    }
    dispatch(slot, job);
  }
}

function unqueue(job: Job): boolean {
  const list = queues.get(job.owner);
  const i = list ? list.indexOf(job) : -1;
  if (i < 0) return false;
  list!.splice(i, 1);
  queuedTotal--;
  if (!list!.length) queues.delete(job.owner);
  return true;
}

/** İşin çocuk yığını, süre sınırı ve bekçi payı. */
type JobClass = { heapMb: number; timeoutMs: number; watchAllowanceMb: number };

/** Dosya okuma (tablo, tarife, PDF metni, sayfa kesme). */
function fileJobClass(): JobClass {
  return { heapMb: env.fileWorkerHeapMb, timeoutMs: env.fileWorkerTimeoutMs, watchAllowanceMb: 0 };
}

/**
 * Fatura raporu (Mesaj 6, 19-B1): 20.000 fark satırlı PDF yaklaşık 800 MB tutar, olağan 512 MB'lık çocuğa sığmaz. Rapor
 * çocuğu `REPORT_WORKER_HEAP_MB` (varsayılan 1024: raporun eskiden üretildiği API yığınıyla aynı) ile açılır, işi bitince
 * kapanır; süre `REPORT_WORKER_TIMEOUT_MS`. Bekçi payı yığının kendisi (`exemptReport`): rapor API'deyken bekçi bu belleği
 * görür ama raporu kesemezdi; çocukta da kendi yığını içindeki büyümesi yüzünden kesilmez.
 */
function reportJobClass(): JobClass {
  return { heapMb: env.reportWorkerHeapMb, timeoutMs: env.reportWorkerTimeoutMs, watchAllowanceMb: env.reportWorkerHeapMb };
}

function enqueue<T>(
  owner: string,
  bytes: Uint8Array | null,
  build: Job['build'],
  connection?: FileJobConnection | null,
  size = bytes?.byteLength ?? 0,
  jobClass: JobClass = fileJobClass(),
): Promise<T> {
  if (connection?.destroyed) return Promise.reject(new FilePoolError('gone'));
  const mine = queues.get(owner)?.length ?? 0;
  if (queuedTotal >= env.fileQueueMax || mine >= FILE_QUEUE_PER_COMPANY) {
    // boş çocuk varsa iş beklemeden başlar: sınır yalnız gerçekten bekleyecek işe uygulanır
    const free = slots.some((s) => !s.job && !s.dead) || slots.length < env.fileWorkers;
    const canRun = free && (runningByOwner.get(owner) ?? 0) < fileJobsPerCompany() && mine === 0;
    // firmanın kendi bekleyen işi tavanda: metin bunu söyler (genel kuyruk dolu değilse)
    if (!canRun) return Promise.reject(new FilePoolError(mine >= FILE_QUEUE_PER_COMPANY ? 'busyOwn' : 'busy'));
  }
  return new Promise<T>((resolve, reject) => {
    const job: Job = { id: nextId++, owner, bytes, size, ...jobClass, build, resolve: resolve as (v: unknown) => void, reject, detach: () => {} };
    // Kuyrukta bekleme sınırı (`FILE_QUEUE_WAIT_MS`): aşan iş 503 alır, istek sonsuz beklemez
    const waitTimer = setTimeout(() => {
      if (unqueue(job)) {
        job.detach();
        reject(new FilePoolError('busy'));
      }
    }, env.fileQueueWaitMs);
    waitTimer.unref();
    let onClose: (() => void) | null = null;
    if (connection && typeof connection.once === 'function') {
      onClose = () => {
        if (unqueue(job)) {
          job.detach();
          reject(new FilePoolError('gone'));
        }
      };
      connection.once('close', onClose);
    }
    job.detach = () => {
      clearTimeout(waitTimer);
      if (onClose) connection!.off('close', onClose);
      job.detach = () => {};
    };
    const list = queues.get(owner);
    if (list) list.push(job);
    else queues.set(owner, [job]);
    queuedTotal++;
    pump();
  });
}

// ---------------------------------------------------------------------------------------------
// Bellek bekçisi

function startWatch() {
  if (watch) return;
  lastCheckAt = Date.now();
  watch = setInterval(checkMemory, WATCH_MS);
  watch.unref();
}

/**
 * Bekçinin "RSS"i: API sürecinin RSS'i + her çocuğun açılıştan beri büyümesi. Çocukların açılış belleği (tsx/core
 * yüklü boş süreç) sayılmaz: sınırın anlamı tek süreçli (worker_threads) havuzdakiyle aynı kalır.
 */
function watchedRss(): number {
  let total = process.memoryUsage.rss();
  for (const s of slots) if (s.baseRss) total += Math.max(0, s.rss - s.baseRss);
  return total;
}

/** Çocuğun işin başından beri büyümesi (ölçü yoksa 0). */
function growth(s: Slot): number {
  return s.jobRss ? Math.max(0, s.rss - s.jobRss) : 0;
}

/**
 * Sonlandırılacak çocuk; `null`: kimse öldürülmez.
 * - ölçüsü taze olanların en çok büyüyeni "büyük" (sınırın dörtte biri) ise o;
 * - yoksa ölçüsü eskiyen (hazır olduğu hâlde izleme borusu susan: süreç takıldı, en olası suçlu) çocuklardan en büyük
 *   girdili, eşitse en uzun süredir çalışanı;
 * - herkes ölçü veriyor ve hepsi küçükse (büyüyen API süreci, işler masum) `null`; yalnız mutlak tavanda (`hard`) en büyüğü.
 * Hazır olmamış çocuk (iş henüz başlamadı) aday değildir.
 */
function pickVictim(busy: Slot[], hard: boolean, now: number): Slot | null {
  const big = (env.fileWorkerRssLimitMb * MB) / 4;
  const measured = busy.filter((s) => s.rssAt > 0 && now - s.rssAt <= RSS_STALE_MS).sort((a, b) => growth(b) - growth(a));
  const silent = busy.filter((s) => s.ready && !measured.includes(s));
  const biggest = measured[0];
  if (biggest && growth(biggest) >= big) return biggest;
  if (silent.length) {
    return silent.reduce((a, b) => {
      const sa = a.job?.size ?? 0;
      const sb = b.job?.size ?? 0;
      if (sb !== sa) return sb > sa ? b : a;
      return b.startedAt < a.startedAt ? b : a;
    });
  }
  return hard && biggest ? biggest : null;
}

/**
 * Mesaj 6 bağımsız inceleme: bekçinin aday saymadığı rapor işi. Rapor eskiden API sürecinde üretilirdi: bekçi o belleği
 * toplamda görür ama raporu kesemezdi (20.000 fark satırlı rapor üretilebiliyordu). Çocuğa taşınınca kendi yığını içindeki
 * olağan büyümesi (20.000 satırda ~760 MB) "suçlu iş" sayılıp rapor 422 alıyordu. Şimdi en eski başlamış rapor işi, büyümesi
 * payı (`watchAllowanceMb`, kendi yığını: onu V8 keser) içinde kaldıkça aday değildir; büyümesi toplama yine sayılır
 * (yanındaki dosya işleri eskisi gibi değerlendirilir). Payı aşan (yığın dışı) büyüme ve aynı anda çalışan ikinci rapor
 * olağan adaydır: iki büyük rapor birlikte kabı doldurmaz, sonra başlayan düşer.
 */
function exemptReport(): Slot | null {
  let oldest: Slot | null = null;
  for (const s of slots) {
    if (s.dead || !s.job?.watchAllowanceMb) continue;
    if (!oldest || s.startedAt < oldest.startedAt) oldest = s;
  }
  return oldest && growth(oldest) <= oldest.job!.watchAllowanceMb * MB ? oldest : null;
}

/**
 * Toplam sınırı aştıysa VE iş başladığından beri en az sınırın dörtte biri kadar büyüdüyse aday o işlerdir: iş dışı
 * nedenle zaten yüksek olan bellek (API'de büyük bir dışa aktarma) dosya işlerini öldürmez. Toplam sınırın 1,3 katını
 * aştıysa (mutlak tavan, kap sınırına yakın) büyüme koşulu aranmaz: bütün çalışan işler adaydır. Payı içindeki en eski rapor
 * işi hiçbir durumda aday değildir (`exemptReport`).
 */
function checkMemory() {
  const now = Date.now();
  if (now - lastCheckAt > RSS_STALE_MS) {
    // API'nin olay döngüsü takıldı (zamanlayıcı geç çalıştı): borulardaki taze ölçüler bu turda henüz okunmadı, sağlıklı
    // çocuklar "susan" görünür. Ölçüler okunduktan sonra (aynı turun sonunda) yeniden denetlenir.
    lastCheckAt = now;
    setImmediate(checkMemory);
    return;
  }
  lastCheckAt = now;
  if (now < cooldownUntil) return;
  const limit = env.fileWorkerRssLimitMb * MB;
  const total = watchedRss();
  if (total <= limit) return;
  const hard = total > limit * WATCH_HARD_FACTOR;
  const exempt = exemptReport();
  const busy = slots.filter((s) => s !== exempt && s.job && !s.dead && (hard || total - s.totalAtStart >= limit / 4));
  if (!busy.length) return;
  const victim = pickVictim(busy, hard, now);
  if (!victim || victim.dead || !victim.job) return;
  cooldownUntil = now + WATCH_COOLDOWN_MS;
  kill(victim, 'memory');
}

function deserializeError(e: SerializedFileError): Error {
  if (e.name === 'InvoiceFileError' && e.code) return new InvoiceFileError(e.code as InvoiceFileErrorCode, e.message, e.params);
  const err = new Error(e.message);
  err.name = e.name;
  if (e.code) (err as Error & { code?: string }).code = e.code;
  return err;
}

/**
 * Bütün çocukları kapatır; bekleyen ve süren işler 503 `FILE_BUSY` alır. Süre ya da bellek yüzünden az önce öldürülen
 * çocukların çıkışı da beklenir (dönünce çocuk süreç kalmaz). Sonraki iş havuzu yeniden açar (testler).
 */
export async function closeFileWorkers(): Promise<void> {
  const pending = [...queues.values()].flat();
  queues.clear();
  queuedTotal = 0;
  for (const j of pending) {
    j.detach();
    j.reject(new FilePoolError('closed'));
  }
  const all = slots.slice();
  for (const s of all) {
    retire(s)?.reject(new FilePoolError('closed'));
    stop(s);
  }
  await Promise.all([...all.map((s) => s.exited), ...terminating]);
}

/** Testler ve tanı için: açık çocuk, çalışan ve bekleyen iş sayısı. */
export function fileWorkerStats() {
  return { workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queuedTotal };
}

// ---------------------------------------------------------------------------------------------
// Hata çevirisi ve dış yüz

const LIMIT_KIND: Record<string, 'uncompressed' | 'rows' | 'pages'> = {
  XLSX_TOO_LARGE: 'uncompressed',
  PDF_UNCOMPRESSED_TOO_LARGE: 'uncompressed',
  TOO_MANY_ROWS: 'rows',
  PDF_TOO_MANY_PAGES: 'pages',
};

type Limits = { maxRows: number; maxMb: number; maxPages: number; maxPdfMb: number };

function currentLimits(): Limits {
  return { maxRows: env.fileMaxRows, maxMb: env.xlsxMaxUncompressedMb, maxPages: env.pdfMaxPages, maxPdfMb: env.pdfMaxUncompressedMb };
}

function readLimits(l: Limits): ReadLimits {
  return { maxRows: l.maxRows, maxUncompressedBytes: l.maxMb * MB };
}

/** Havuz ve sınır hatalarını uç hatasına çevirir; diğer okuma hataları olduğu gibi geçer. Dil, isteği başlatanınki. */
function toAppError(e: unknown, limits: Limits, locale: Locale): unknown {
  if (e instanceof FilePoolError) {
    if (e.reason === 'busyOwn') return new FileBusyError(m('err.fileBusyOwn', undefined, locale), { scope: 'company' });
    if (e.reason === 'busy' || e.reason === 'closed' || e.reason === 'gone') return new FileBusyError(m('err.fileBusy', undefined, locale));
    return new AppError(422, 'FILE_TOO_COMPLEX', m('err.fileTooComplex', undefined, locale), { reason: e.reason });
  }
  const err = e as { code?: unknown; name?: unknown } | null;
  // Y59: ön denetim kendi süre sınırında durdu (çok sayıda akış): dosya süre sınırıyla aynı yanıt, beklemeden
  if (err?.name === 'PdfTooComplexError') return new AppError(422, 'FILE_TOO_COMPLEX', m('err.fileTooComplex', undefined, locale), { reason: 'timeout' });
  const limitError = e instanceof InvoiceFileError || err?.name === 'InvoiceFileError' || err?.name === 'PdfTooLargeError';
  const code = typeof err?.code === 'string' ? err.code : '';
  const kind = limitError ? LIMIT_KIND[code] : undefined;
  if (!kind) return e;
  const limit = kind === 'rows' ? limits.maxRows : kind === 'pages' ? limits.maxPages : code === 'PDF_UNCOMPRESSED_TOO_LARGE' ? limits.maxPdfMb : limits.maxMb;
  return new AppError(413, 'FILE_TOO_LARGE', m(`err.fileTooLarge.${kind}`, { limit: fmtNumber(limit, 0, locale) }, locale), { kind, limit });
}

async function run<K extends FileTask['kind']>(
  build: (l: Limits, bytes: Uint8Array) => Extract<FileTask, { kind: K }>,
  bytes: Uint8Array,
  opts: FileJobOptions,
): Promise<FileTaskResult[K]> {
  const limits = currentLimits();
  const locale = currentLocale();
  try {
    // Satır içinde kopya: pdfjs aldığı tamponu ayırabilir (detach); çağıranın tamponu sağlam kalmalı. Havuzda IPC kopyalar.
    if (env.fileWorkerMode === 'inline') return await runFileTask<K>(build(limits, new Uint8Array(bytes)));
    return await enqueue<FileTaskResult[K]>(opts.companyId, bytes, (b) => build(limits, b!), opts.connection);
  } catch (e) {
    throw toAppError(e, limits, locale);
  }
}

/** Fatura tablosu (CSV/XLSX), core `readTable` ile aynı sonuç; sınırlar ortamdan. */
export function readTable(fileName: string, bytes: Uint8Array, opts: FileJobOptions): Promise<Table> {
  return run<'readTable'>((l, b) => ({ kind: 'readTable', fileName, bytes: b, limits: readLimits(l) }), bytes, opts);
}

/** Tarife dosyası (CSV/XLSX), core `readTariffFile` ile aynı sonuç; sınırlar ortamdan. */
export function readTariffFile(fileName: string, bytes: Uint8Array, opts: FileJobOptions): Promise<RawTariffFile> {
  return run<'readTariffFile'>((l, b) => ({ kind: 'readTariffFile', fileName, bytes: b, limits: readLimits(l) }), bytes, opts);
}

/** PDF'in sayfa metinleri; `PDF_MAX_PAGES` ya da `PDF_MAX_UNCOMPRESSED_MB` üstü 413. */
export function readPdfText(bytes: Uint8Array, opts: FileJobOptions): Promise<{ pages: string[] }> {
  return run<'pdfText'>((l, b) => ({ kind: 'pdfText', bytes: b, maxPages: l.maxPages, maxUncompressedBytes: l.maxPdfMb * MB }), bytes, opts);
}

/** PDF'in konumlu metin parçaları (kodla tarama); sınırlar `readPdfText` ile aynı. */
export function readPdfLayout(bytes: Uint8Array, opts: FileJobOptions): Promise<PdfPageLayout[]> {
  return run<'pdfLayout'>((l, b) => ({ kind: 'pdfLayout', bytes: b, maxPages: l.maxPages, maxUncompressedBytes: l.maxPdfMb * MB }), bytes, opts);
}

/**
 * Y96: PDF'ten sayfa kesme (pdf-lib) dosya çalışanında; ön denetim ve açılmış boyut sınırı `readPdfText` ile aynı. `strict`
 * verilirse sayfa sayısı tutmayan ya da (`refuseEncrypted`) şifreli belge kesilmez: `null`.
 */
export async function slicePdfPages(bytes: Uint8Array, pages: number[], opts: FileJobOptions & { strict?: PdfSliceStrict }): Promise<Buffer | null> {
  const r = await run<'pdfSlice'>(
    (l, b) => ({ kind: 'pdfSlice', bytes: b, pages: [...pages], maxUncompressedBytes: l.maxPdfMb * MB, ...(opts.strict ? { strict: { ...opts.strict } } : {}) }),
    bytes,
    opts,
  );
  return r.bytes ? Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) : null;
}

/**
 * Mesaj 6 (19-B1, 06-B2): fatura raporu dosya çalışanında üretilir; API'nin olay döngüsü rapor süresince kilitlenmez.
 * Firma adaleti, kuyruk ve bellek bekçisi dosya okumayla aynı; yığın ve süre rapor sınıfından (`reportJobClass`).
 * Çocuk sınırda düşerse (bellek, süre, çöküş) 422 `REPORT_TOO_LARGE`; havuz meşgulse 503 `FILE_BUSY`. İçerik ana süreçte
 * üretilenle aynıdır (`FILE_WORKER_MODE=inline`: ana süreçte, eski davranış). PDF'in fark tablosu en çok
 * `REPORT_PDF_MAX_ROWS` satır (karar 2026-11-12; sınır görevle gider, çocuk ortam okumaz); Excel sınırsız.
 */
export async function renderReport(kind: 'pdf' | 'xlsx', input: ReportInput, opts: FileJobOptions): Promise<Buffer> {
  const locale = currentLocale();
  const task: Extract<FileTask, { kind: 'reportPdf' | 'reportXlsx' }> =
    kind === 'pdf' ? { kind: 'reportPdf', input, locale, maxRows: env.reportPdfMaxRows } : { kind: 'reportXlsx', input, locale };
  let r: { bytes: Uint8Array };
  try {
    if (env.fileWorkerMode === 'inline') r = await runFileTask(task);
    // kurban seçimindeki "girdi boyutu": satır başına ~1 KB (seri hâldeki satır)
    else r = await enqueue<{ bytes: Uint8Array }>(opts.companyId, null, () => task, opts.connection, input.lines.length * 1024, reportJobClass());
  } catch (e) {
    if (e instanceof FilePoolError && (e.reason === 'memory' || e.reason === 'timeout' || e.reason === 'crash')) {
      throw new AppError(422, 'REPORT_TOO_LARGE', m('err.reportTooLarge', undefined, locale), { reason: e.reason });
    }
    throw toAppError(e, currentLimits(), locale);
  }
  return Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
}

export type FileWorkerTestKind =
  | 'testAllocate'
  | 'testAllocateHuge'
  | 'testAllocateExternal'
  | 'testAllocFail'
  | 'testExit'
  | 'testEnv'
  | 'testOomScore'
  | 'testSpin'
  | 'testEcho'
  | 'testSleep';

/**
 * Yalnız testler: çocukta bellek doldurma (yığın / tek büyük ayırma / yığın dışı) / yakalanan ayırma hatası / çıkış /
 * ortam adları / sonsuz döngü / yankı görevi (`FILE_WORKER_TEST_HOOKS=1` ve `NODE_ENV=test` ile açılan çocukta çalışır; değilse çocuk
 * görevi tanımaz ve hata döner). `size`: bekçinin kurban seçimi için girdinin boyutu sayılır (bayt gönderilmez). Hata
 * çevirisi gerçek görevlerle aynıdır.
 */
export async function runFileWorkerTestTask(
  kind: FileWorkerTestKind,
  opts: Partial<FileJobOptions> & { value?: unknown; size?: number; report?: boolean } = {},
): Promise<unknown> {
  const limits = currentLimits();
  const locale = currentLocale();
  try {
    // `report`: rapor sınıfında (yığın, süre ve bekçi payı `REPORT_WORKER_*`)
    return await enqueue(opts.companyId ?? 'test', null, () => ({ kind, value: opts.value }), opts.connection, opts.size ?? 0, opts.report ? reportJobClass() : fileJobClass());
  } catch (e) {
    throw toAppError(e, limits, locale);
  }
}
