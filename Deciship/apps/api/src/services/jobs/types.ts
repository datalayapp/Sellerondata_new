/**
 * Arka plan iş kuyruğunun ortak tipleri (Mesaj 7). Çalışma kodu yok;
 * kuyruk `queue.ts`, çalıştırıcı `runner.ts`, tür tablosu `registry.ts`, işleyiciler `handlers/*.ts`.
 * Web paneli `JobView`i `Deciship/apps/web/src/api/types.ts` içinde birebir tutar (elle; derleme farkı yakalamaz).
 */
import type { Permission } from '@sellerondata/contracts';
import type { Prisma } from '../../db.ts';
import type { JobKind as DbJobKind, JobStatus as DbJobStatus } from '../../generated/prisma/enums.ts';

export type JobKind =
  | 'INVOICE_PDF_READ'
  | 'TARIFF_PDF_SCAN'
  | 'TARIFF_PDF_EXTRACT'
  | 'BULK_RECOMPARE_PREVIEW'
  | 'BULK_RECOMPARE_APPLY'
  | 'INVOICE_IMPORT'
  | 'TARIFF_IMPORT_REVIEW';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
/** Yuva grubu: sunucu başına `JOB_SLOTS_AI` / `JOB_SLOTS_RECALC`; firma başına grup başına aynı anda 1 iş. */
export type JobLane = 'ai' | 'recalc';
export type JobRefType = 'File' | 'TariffDocument' | 'Tariff' | 'Company' | 'TariffImportDraft';

export const JOB_KIND_LIST = [
  'INVOICE_PDF_READ',
  'TARIFF_PDF_SCAN',
  'TARIFF_PDF_EXTRACT',
  'BULK_RECOMPARE_PREVIEW',
  'BULK_RECOMPARE_APPLY',
  'INVOICE_IMPORT',
  'TARIFF_IMPORT_REVIEW',
] as const satisfies readonly JobKind[];
export const JOB_REF_TYPES = ['File', 'TariffDocument', 'Tariff', 'Company', 'TariffImportDraft'] as const satisfies readonly JobRefType[];
/** Bitmiş durumlar değişmez; tekillik dizini (`Job_active_key`) yalnız bitmemişler arasındadır. */
export const JOB_FINISHED = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const satisfies readonly JobStatus[];
/** İlerleme aşaması (ekran anahtarı `jobs.stage.<aşama>`). */
export type JobStage =
  | 'pdfRead'
  | 'pdfPages'
  | 'pdfCheck'
  | 'tariffScan'
  | 'tariffExtract'
  | 'bulkCheck'
  | 'bulkWrite'
  | 'importRead'
  | 'importCompare'
  | 'importWrite'
  | 'tariffReview';

/** Sahiplenme sorgusunun döndürdüğü satır (`RETURNING`). Firma her zaman bu satırdan alınır, `input`'tan değil. */
export type ClaimedJob = {
  id: string;
  companyId: string;
  kind: JobKind;
  input: Record<string, unknown>;
  checkpoint: unknown;
  attempts: number;
  createdById: string | null;
  createdAt: Date;
  cancelRequestedAt: Date | null;
};

export type JobContext = {
  job: ClaimedJob;
  /** durdurma ya da kira kaybı */
  signal: AbortSignal;
  /** en çok saniyede 1 yazım */
  progress(p: { done?: number; total?: number | null; stage?: string; counters?: Record<string, number> }): Promise<void>;
  saveCheckpoint(c: unknown): Promise<void>;
  /**
   * Aynı veritabanı işleminde ilerleme (ve verilirse işin kaydı, `checkpoint`) yazar; kira bu çalıştırıcıda değilse atar
   * (işlem geri alınır). KALANLAR 6.18: içe aktarma faturanın kimliğini fatura yazımıyla aynı işlemde buraya yazar.
   */
  fence(tx: Prisma.TransactionClient, p: { done?: number; counters?: Record<string, number>; checkpoint?: unknown }): Promise<void>;
  log: { info(o: unknown, m: string): void; warn(o: unknown, m: string): void };
  /**
   * Y57 (adil paylaşım): iş kaldığı yerden sürebilen bir adım sınırındaysa sorar. true: bu çalıştırma payını doldurdu
   * (`JOB_FAIR_SLICE_MS`) ve aynı gruptan başka firmanın bekleyen işi var; işleyici kaydını bırakıp `JobYield` atar, iş
   * kuyruğun sonuna döner (deneme hakkı yemez). Satır içi kipte hep false. Sorgu en çok `JOB_FAIR_CHECK_MS`'de bir.
   */
  shouldYield(): Promise<boolean>;
  /**
   * KALANLAR 6.18: iş geri alınamaz yazımı yaptı (işlem commit edildi; içe aktarmada fatura). Bundan sonra durdurma isteği
   * işi durdurmaz: sinyal kesilmez, zorla durdurma yazılmaz, işleyicinin sonucu yazılır.
   */
  markCommitted(): void;
};

/**
 * Y57: işleyici yuvayı başka firmaya bırakıyor (`shouldYield`). İş QUEUED olur, `runAfter` = şimdi (bekleyen işler önce
 * alınır), deneme sayısı geri verilir; kaldığı yer işin kendi kaydındadır (ör. toplu uygulamanın planı ve çitli ilerlemesi).
 * `partial`: bu ana kadarki bölüm sonucu (`JobCancelled` ile aynı biçim). Bu arada durdurma istenmişse (başka kopyadan,
 * kalp atışı henüz görmeden) iş kuyruğa dönmez, bununla CANCELLED yazılır.
 */
export class JobYield extends Error {
  constructor(public partial?: unknown) {
    super('job yielded its slot');
  }
}

/** Dönen değer `result` sütununa yazılır. */
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** İş adım arasında durdurma isteğini görünce atar; `partial` bölüm sonucu olarak `result`'a yazılır, durum CANCELLED. */
export class JobCancelled extends Error {
  constructor(public partial?: unknown) {
    super('cancelled');
  }
}

/** `registry.ts` `JOB_KINDS` satırı. */
export type JobKindSpec = {
  lane: JobLane;
  /** görme ve durdurma izni; yoksa iş 404 (kapsama göre: toplu hesapta tarife ya da ayar izni) */
  permission: (input: Record<string, unknown>) => Permission;
  cancellable: boolean;
  /** dışarı verilen girdi parçası (ör. extract: sectionIds, includeCountryZones, pricing) */
  publicParams?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** tembel içe aktarma (döngüsel içe aktarma olmasın) */
  handler: () => Promise<JobHandler>;
  /** bitmiş başarısız, durdurulmuş ve bırakılmış işten sonra firma bağlamında (ör. önizleme dosyasını siler) */
  cleanup?: (job: ClaimedJob, outcome: 'FAILED' | 'CANCELLED') => Promise<void>;
  /**
   * Bir denemenin en uzun çalışma süresi, ms (verilmezse grubun varsayılanı, `registry.ts` `LANE_MAX_RUN_MS`). Aşılırsa
   * işleyici bırakılır, iş geçici hata gibi kuyruğa döner; deneme hakkı bittiyse FAILED (JOB_ABANDONED).
   */
  maxRunMs?: number;
  /**
   * KALANLAR 6.18: işin kaydı (`checkpoint`) geri alınamaz bir yazımı gösteriyor mu (içe aktarmada yazılmış fatura). true ise
   * `POST /jobs/:id/cancel` 409 `JOB_NOT_CANCELLABLE`, yeniden denemede durdurma isteği işi durdurmaz (`markCommitted` gibi).
   */
  committed?: (checkpoint: unknown) => boolean;
};

/** `error` sütunu. `messageKey` varsa serileştirici iletiyi isteğin dilinde üretir (SQL'in yazdığı JOB_ABANDONED gibi). */
export type JobError = { statusCode: number; code: string; message: string; messageKey?: string; details?: unknown };

/** Ekranın kullandığı yanıt biçimi (`GET /jobs/:jobId`, `GET /jobs`, başlatan uçların `{ job, joined }`'ı). */
export type JobView = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: { done: number; total: number | null; stage: string | null };
  /**
   * Küçük sayaçlar (`Job.counters`; toplu uygulamada `{ invoices, lines, inDispute, stale }`), her durumda; yoksa null. Para
   * değil: adları fiyat süzgecine takılmaz. Biten (durdurulmuş, başarısız) işte de "kaç fatura yazıldı" buradan okunur.
   */
  counters?: Record<string, number> | null;
  label: string | null;
  ref: { type: JobRefType; id: string | null } | null;
  /** `publicParams` */
  params?: Record<string, unknown>;
  /** > 1 ise "kaldığı yerden sürüyor" */
  attempt: number;
  /** tür durdurulabilir ve iş bitmemiş */
  cancellable: boolean;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** (finishedAt ?? şimdi) - (startedAt ?? createdAt) */
  elapsedMs: number;
  /** yalnız SUCCEEDED (ve bölüm sonucuyla CANCELLED); listede hiç yok */
  result?: unknown;
  /** yalnız FAILED */
  error?: { statusCode: number; code: string; message: string; details?: unknown };
};

/** `GET /jobs` sorgusu: `?active=1&kind=K&refType=T&refId=X&mine=1`. En çok 20, yalnız izinli türler, `result` yok. */
export type JobListQuery = { active?: boolean; kind?: JobKind; refType?: JobRefType; refId?: string; mine?: boolean };

/** Başlatan uçların 202 yanıtı. */
export type JobStarted = { job: JobView; joined: boolean };

// Derleme denetimi: bu birlikler Prisma şemasındaki enum'larla aynı kalmalı (schema.prisma `JobKind`, `JobStatus`).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsMatch: Same<JobKind, DbJobKind> = true;
const statusesMatch: Same<JobStatus, DbJobStatus> = true;
void kindsMatch;
void statusesMatch;
