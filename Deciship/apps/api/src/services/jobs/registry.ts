/**
 * İş türleri tablosu (Mesaj 7, plan §4.2, §4.8). Her tür: yuva grubu, görme ve durdurma izni, durdurulabilirlik, dışarı
 * verilen girdi parçası, işleyici (tembel içe aktarma) ve başarısız/durdurulmuş iş sonrası temizlik kancası.
 *
 * İşleyici satırı DAİMA düz metin yolla `import('./handlers/<ad>.ts')` biçiminde yazılır: üretim paketi (tsup, `splitting`)
 * yalnız düz yolları ayrı parçaya alır; değişkenle verilen yol paketlenmez ve üretimde bulunamaz. Dosyası henüz yazılmamış
 * türün satırı `notInstalled(kind)` taşır: iş açılırsa `INTERNAL` ile biter (derleme ve testler kırılmaz).
 *
 * Satır sahipleri: INVOICE_PDF_READ, TARIFF_PDF_SCAN, TARIFF_PDF_EXTRACT → P2 (`handlers/invoicePdf.ts`, `handlers/tariffPdf.ts`);
 * BULK_RECOMPARE_PREVIEW, BULK_RECOMPARE_APPLY → P5 (`handlers/bulkRecompare.ts`); INVOICE_IMPORT, TARIFF_IMPORT_REVIEW →
 * KALANLAR 6.18 (`handlers/invoiceImport.ts`, `handlers/tariffReview.ts`). Kuyruk motoru (P1) yalnız `jobSpec`,
 * `laneKinds` ve test kancasını değiştirir.
 */
import type { Permission } from '@sellerondata/contracts';
import { env } from '../../env.ts';
import { AI_CALL_MAX_MS } from '../ai.ts';
import { JOB_KIND_LIST, type JobHandler, type JobKind, type JobKindSpec, type JobLane } from './types.ts';

/** Dosyası henüz olmayan türün işleyicisi: iş `FAILED`, `INTERNAL` (günlüğe yazılır). */
const notInstalled =
  (kind: JobKind): (() => Promise<JobHandler>) =>
  async () =>
  async () => {
    throw new Error(`${kind}: job handler not installed yet (services/jobs/registry.ts)`);
  };

/**
 * Toplu yeniden hesabın izni kapsamına göre (plan §4.2): `input.scope === 'tariff'` → tarife düzenleme, değilse (ayar kapsamı
 * ya da tanınmayan girdi) ayar yönetimi. Tanınmayan girdide dar olan izin seçilir.
 */
const bulkPermission = (input: Record<string, unknown>): Permission =>
  input.scope === 'tariff' ? 'deciship.tariffs.edit' : 'deciship.settings.manage';

/** Tarife PDF çıkarma işinin dışarı verilen seçimi (`input.body`'nin yalnız bu üç alanı; hedef ve diğerleri verilmez). */
function tariffExtractParams(input: Record<string, unknown>): Record<string, unknown> {
  const b = (input.body && typeof input.body === 'object' ? input.body : {}) as { sectionIds?: unknown; includeCountryZones?: unknown; pricing?: unknown };
  return {
    ...(Array.isArray(b.sectionIds) ? { sectionIds: b.sectionIds.filter((s): s is string => typeof s === 'string') } : {}),
    ...(typeof b.includeCountryZones === 'boolean' ? { includeCountryZones: b.includeCountryZones } : {}),
    ...(b.pricing === 'table' || b.pricing === 'listDiscount' ? { pricing: b.pricing } : {}),
  };
}

export const JOB_KINDS: Record<JobKind, JobKindSpec> = {
  // ---------- P2: PDF fatura okuma ----------
  INVOICE_PDF_READ: {
    lane: 'ai',
    permission: () => 'deciship.invoices.upload',
    cancellable: true,
    handler: async () => (await import('./handlers/invoicePdf.ts')).invoicePdfHandler,
    // başarısız, durdurulmuş ya da bırakılmış okumanın önizleme dosyası silinir (§4.12, `discardPreviewFile` + `exceptJobId`)
    cleanup: async (job) => (await import('./handlers/invoicePdf.ts')).invoicePdfCleanup(job),
  },

  // ---------- P2: tarife PDF'inde yapay zekâ ile tarama ----------
  TARIFF_PDF_SCAN: {
    lane: 'ai',
    permission: () => 'deciship.tariffs.edit',
    cancellable: true,
    handler: async () => (await import('./handlers/tariffPdf.ts')).tariffScanHandler,
  },

  // ---------- P2: tarife PDF'inden fiyat okuma ----------
  TARIFF_PDF_EXTRACT: {
    lane: 'ai',
    permission: () => 'deciship.tariffs.edit',
    cancellable: true,
    // pencere yeniden açılınca süren işe bağlanırken seçim buradan geri gelir (§4.15)
    publicParams: tariffExtractParams,
    handler: async () => (await import('./handlers/tariffPdf.ts')).tariffExtractHandler,
  },

  // ---------- P5: toplu yeniden hesap önizlemesi ----------
  BULK_RECOMPARE_PREVIEW: {
    lane: 'recalc',
    permission: bulkPermission,
    cancellable: true,
    handler: async () => (await import('./handlers/bulkRecompare.ts')).bulkPreviewHandler,
  },

  // ---------- P5: toplu yeniden hesap uygulaması (yazılan faturalar durdurulunca da kalır) ----------
  BULK_RECOMPARE_APPLY: {
    lane: 'recalc',
    permission: bulkPermission,
    cancellable: true,
    handler: async () => (await import('./handlers/bulkRecompare.ts')).bulkApplyHandler,
    // durdurulan ya da başarısız iş fatura yazdıysa kapsamın denetim kaydı (zorla durdurma ve bırakılmış iş dahil)
    cleanup: async (job, outcome) => (await import('./handlers/bulkRecompare.ts')).bulkApplyCleanup(job, outcome),
  },

  // ---------- KALANLAR 6.18: büyük CSV/Excel fatura içe aktarma (yazım yükü: toplu hesapla aynı grup) ----------
  INVOICE_IMPORT: {
    lane: 'recalc',
    permission: () => 'deciship.invoices.upload',
    // yazım işleminden önce durur; yazım işlemi durdurma istenmişse geri alınır (`handlers/invoiceImport.ts`)
    cancellable: true,
    // 50.000 satır birkaç dakika sürer; takılan iş grubun tek yuvasını 2 saat tutmasın
    maxRunMs: 30 * 60_000,
    // fatura yazıldıysa (kayıtta fatura kimliği) durdurma reddedilir; iş sonucuyla biter
    committed: (checkpoint) => !!checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { invoiceId?: unknown }).invoiceId === 'string',
    handler: async () => (await import('./handlers/invoiceImport.ts')).invoiceImportHandler,
  },

  // ---------- KALANLAR 6.18: tarife içe aktarmanın yapay zekâ incelemesi ----------
  TARIFF_IMPORT_REVIEW: {
    lane: 'ai',
    permission: () => 'deciship.tariffs.edit',
    cancellable: true,
    handler: async () => (await import('./handlers/tariffReview.ts')).tariffReviewHandler,
  },
};

// ---------- Okuma (kuyruk ve çalıştırıcı yalnız bunları kullanır) ----------

const overrides = new Map<JobKind, Partial<JobKindSpec>>();

/** Türün geçerli satırı (test kancası varsa onunla birleşik). */
export function jobSpec(kind: JobKind): JobKindSpec {
  const o = overrides.get(kind);
  return o ? { ...JOB_KINDS[kind], ...o } : JOB_KINDS[kind];
}

/**
 * Bir denemenin en uzun çalışma süresi (tür satırında `maxRunMs` yoksa). Yapay zekâ: tek çağrının üst sınırının üç katı
 * (çok gruplu PDF ve sağlayıcının kendi yeniden denemeleri sığsın, 30 dk). Toplu hesap: 2 saat (kaldığı yerden sürdüğü için
 * aşılırsa yeni deneme yazılanı tekrar yazmaz).
 */
export const LANE_MAX_RUN_MS: Record<JobLane, number> = { ai: 3 * AI_CALL_MAX_MS, recalc: 2 * 60 * 60_000 };

export function jobMaxRunMs(kind: JobKind): number {
  const spec = jobSpec(kind);
  return spec.maxRunMs ?? LANE_MAX_RUN_MS[spec.lane];
}

/** Yuva grubunun türleri; sahiplenme sorgusu bunları alır. */
export function laneKinds(lane: JobLane): JobKind[] {
  return JOB_KIND_LIST.filter((k) => jobSpec(k).lane === lane);
}

/**
 * YALNIZ TESTLER: bir türün satırını geçici olarak değiştirir (ör. sahte işleyici). `kind` sütunu veritabanında enum
 * olduğundan sahte tür eklenemez; testler var olan bir türü ödünç alır. Geri alma işlevini döner (`afterEach`'te çağırın).
 * Üretimde (`NODE_ENV=production`) atar: üretim kaydı bu yoldan değişemez.
 */
export function overrideJobKindForTest(kind: JobKind, spec: Partial<JobKindSpec>): () => void {
  if (env.isProduction) throw new Error('overrideJobKindForTest is not allowed in production');
  overrides.set(kind, spec);
  return () => {
    if (overrides.get(kind) === spec) overrides.delete(kind);
  };
}
