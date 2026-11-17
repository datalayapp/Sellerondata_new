import { m as msg, currentLocale } from '../i18n/index.ts';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  buildImportReport,
  CARRIER_PRESETS,
  columnFillCounts,
  currencyCode,
  detectFormat,
  flagParsedLines,
  InvoiceFileError,
  invoiceFileMessage,
  isTariffSuspect,
  type ImportReport,
  unsupportedFileError,
  mergeAiMapping,
  shouldSuggestAi,
  sourcesFor,
  type FieldSources,
  type MappingDiagnostics,
  type MappingVerification,
  guessInvoiceMeta,
  mappingDiagnostics,
  normalizeTracking,
  parseRows,
  pdfLineEdits,
  type PdfLineEdits,
  scientificTrackingRows,
  sha256Hex,
  suggestMapping,
  type CarrierCode,
  type ColumnMapping,
  type DiagnosticWarning,
  type Locale,
  MAPPING_FIELDS,
  META_FIELDS,
  type ParsedInvoiceLine,
  type Table,
} from '@deciship/core';
import { prisma, Prisma, TX_DEFAULTS, type Tx } from '../db.ts';
import { env } from '../env.ts';
import {
  assertInvoiceHasNoActiveDispute,
  activeRoundWhere,
  assertLineNotInActiveDispute,
  invoiceDispute,
  invoiceDisputeSummaries,
  lineDisputeStates,
  lockInvoice,
} from '../services/disputes.ts';
import { AppError, badRequest, conflict, emptyFile, forbiddenFor, notFound } from '../errors.ts';
import { can, requireAny } from '../lib/access.ts';
import { readTable, registerFileErrorHeaders, renderReport } from '../lib/fileWorkers.ts';
import { TableCache } from '../lib/tableCache.ts';
import { audit } from '../lib/audit.ts';
import { mappingSchema, savedMappingOf } from '../lib/mappingSchema.ts';
import { firmCurrency, readSettings } from '../lib/settings.ts';
import { zonedDate } from '../lib/time.ts';
import { discardStored, extFor, fileUrl, readStored, sha256, storeBuffer } from '../lib/storage.ts';
import { discardPreviewFile, isForeignKeyViolation, keepPreviewFile, listResumablePreviews, sharePreviewFile } from '../services/fileCleanup.ts';
import { assertStorageQuota } from '../services/storageQuota.ts';
import { idParam, paged, paginationSchema, parseDateInput, parseDayInput, normInvoiceNo, invoiceNoKey, mapSliced, yieldToLoop } from '../lib/util.ts';
import { aiEnabled, aiDisabled } from '../services/ai.ts';
import { suggestMappingWithAi } from '../services/aiMapping.ts';
import { aiContext, assertAiQuota, assertAiRate, freshQuery, registerAiErrorHeaders } from '../services/aiMeter.ts';
import {
  applyRecompare,
  invoiceHasActiveRound,
  restoreComparisonNote,
  resolveLatestVersion,
  buildContext,
  compareAll,
  compareAllSliced,
  prefetchFx,
  computeTotals,
  lineRowToParsed,
  loadBasisInfo,
  parsedToLineData,
  pendingCauseOf,
  previewRecompare,
  importRecheck,
  lockImportsExclusive,
  lockImportsShared,
  markLaterDuplicates,
  refreshTotals,
  resultToLineData,
  sameCompareSettings,
  type ApplyRecompareResult,
  type InvoicePatch,
  type InvoiceTotals,
  type RecalcCause,
  type RecompareBasisInfo,
  type RecompareOptions,
  tariffForDate,
} from '../services/compare.ts';
import { limited } from '../services/hub/limiter.ts';
import { invoiceBasisView, lineInclude, serializeImportReport, serializeLine, type InvoiceBasisView } from '../services/invoiceSerialize.ts';
import { invoiceTariffHealth } from '../services/tariffHealth.ts';
import { atStoredPrecision, insertInvoiceLines } from '../services/lineWrite.ts';
import { queueInvoiceRecheck, queueMeasurementRecompare } from '../services/measurementQueue.ts';
import { loadDisputeDraft, renderDisputeText, streamEvidenceZip } from '../services/evidence.ts';
import {
  checkInvoicePdfLines,
  findPdfMissedLines,
  isPdfFlag,
  mergePdfFlags,
  pdfLinesToParsed,
  pdfPageTexts,
  pdfPreviewValue,
  PDF_VAT_PCT,
  pdfCheckUnitsOf,
  pdfCurrencyGate,
  pdfReviewFlags,
  readPdfPreview,
  dropPdfPageTexts,
  serverPdfLines,
  storedPdfPageTexts,
} from '../services/invoicePdfCheck.ts';
import { readInvoicePdfAll } from '../services/invoicePdfRead.ts';
import { BULK_DECIDE_MAX, bulkDecide, buildLineWhere, decisionFields, hasClaim, likeEscape, listSelection, reopenPendingLines } from '../services/bulkDecide.ts';
import { invoicePdfDedupeKey, type InvoicePdfInput } from '../services/jobs/handlers/invoicePdf.ts';
import { enqueueJob, findActiveJob, findJobLean, jobView, kickJob, requireAsync } from '../services/jobs/queue.ts';
import type { JobStarted } from '../services/jobs/types.ts';
import type { ReportInput } from '../services/reports.ts';
import { clearFailedRecalc, failedRecalcInvoices } from '../services/recalcFailed.ts';
import { CARRIER_CODES } from './carriers.ts';

const MAX_INVOICE_BYTES = 30 * 1024 * 1024;
/** PDF faturada en çok satır (yapay zekâ okuması ve metin denetimi). CSV/Excel bu sınıra bağlı değil. */
const MAX_PDF_LINES = 5000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sütun sınırları (Decimal(14,2) tutar, (10,3) kg, (8,1) cm): büyüğü 500 yerine 400. */
const MAX_AMOUNT = 999_999_999_999;
const amount = z.number().min(-MAX_AMOUNT).max(MAX_AMOUNT);
const kg = z.number().min(0).max(9_999_999);
const cm = z.number().positive().max(999_999);
const optNum = (n: z.ZodNumber) => n.nullable().optional().transform((v) => v ?? undefined);
const optStr = z.string().max(500).nullable().optional().transform((v) => (v ? v : undefined));
const lineSchema = z.object({
  rowIndex: z.number().int().min(0).max(10_000_000).optional(),
  trackingNo: z.string().trim().min(1).max(200),
  shipDate: optStr,
  service: optStr,
  destCountry: optStr,
  actualKg: optNum(kg),
  billedKg: optNum(kg),
  dims: z
    .object({ l: cm, w: cm, h: cm })
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  billedDivisor: optNum(z.number().min(0).max(100_000)),
  baseAmount: optNum(amount),
  discountAmount: optNum(amount),
  fuelAmount: optNum(amount),
  surcharges: z
    .array(z.object({ code: z.string().min(1).max(60), name: optStr, amount }))
    .max(200)
    .default([]),
  netAmount: amount,
  currency: optStr,
  reference: optStr,
  rawHash: optStr,
});

const dateStr = z.string().trim().min(1).refine((v) => toDate(v) != null, 'v.invalidDate');
const invoiceNoSchema = z.string().transform(normInvoiceNo).pipe(z.string().min(1).max(100));

const importBody = z.object({
  fileId: z.string().min(1),
  carrierId: z.string().min(1),
  invoiceNo: invoiceNoSchema,
  invoiceDate: z.string().refine((s) => parseDateInput(s) != null, 'v.invalidDate'),
  periodFrom: dateStr.nullable().optional(),
  periodTo: dateStr.nullable().optional(),
  /** Verilmezse firmanın para birimi (`settings.currency`). */
  currency: z.string().trim().length(3).toUpperCase().optional(),
  /** Faturanın tarifesi; yok/null = taşıyıcının varsayılan tarifesi (kaydedilir). */
  tariffId: z.string().min(1).nullable().optional(),
  mapping: mappingSchema.optional(),
  /** PDF (yapay zekâ ile okunan) satırları. Üst sınır: sunucu her satırı PDF metniyle denetler (tek istek kilitlemesin). */
  lines: z.array(lineSchema).max(MAX_PDF_LINES).optional(),
  saveMapping: z.boolean().default(false),
  /** SPEC §11.4: okuma kontrolü "kontrol edin" diyorsa kullanıcının sorunları gördüğünü onaylaması gerekir. */
  acknowledgeIssues: z.boolean().default(false),
  /** Dosyadaki gönderilerin çoğu başka bir faturada varken kullanıcı "yine de yükle" dedi. */
  confirmOverlap: z.boolean().default(false),
  /**
   * K36: PDF satırlarından ağırlığı "1.500" gibi iki türlü basılı olanlar için kullanıcının seçim yaptığı (ya da hücreyi
   * düzelttiği) satır no'ları. Listede olmayan böyle satır varsa içe aktarılmaz (409 `PDF_WEIGHT_CHOICE_REQUIRED`; onayla geçilmez).
   */
  pdfWeightConfirmed: z.array(z.number().int().min(0).max(10_000_000)).max(MAX_PDF_LINES).default([]),
});

const fieldSourceSchema = z.enum(['preset', 'saved', 'ai', 'user']);
/** Y80-E3: kurulum örnek faturası, arka planda okunmuş PDF önizlemesinden (`POST /invoices/preview?async=1` işinin dosyası). */
const sampleFromPreviewBody = z.object({
  fileId: z.string().min(1).max(200),
  carrierId: z.string().min(1).max(200),
});
const verifyBody = z.object({
  fileId: z.string().min(1),
  carrierId: z.string().min(1),
  mapping: mappingSchema,
});
const aiMappingBody = z.object({
  fileId: z.string().min(1),
  carrierId: z.string().min(1),
  /** Ekrandaki güncel eşleme (kullanıcı düzenlemeleri korunur); yoksa kalıp/kayıtlı eşleme kullanılır. */
  mapping: mappingSchema.optional(),
  sources: z.record(z.string(), fieldSourceSchema).optional(),
});

const listQuery = paginationSchema.extend({
  carrierId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** 08-B9: fatura no (parça, büyük-küçük harf duyarsız) ya da takip no (tam, normalleştirilmiş, 4+ karakter). */
  q: z.string().trim().max(64).optional(),
  /** `DIFF`: fark satırı var; `UNMATCHED`: ölçümü eksik satır var; `TO_DISPUTE`: fazla ödeme var, etkin itiraz turu yok. */
  status: z.enum(['DIFF', 'UNMATCHED', 'TO_DISPUTE']).optional(),
});

/** Takip no ile arama bu uzunluktan başlar (kısa metin her faturada geçer; tam eşleşme dizinden okunur). */
const TRACKING_SEARCH_MIN = 4;

const lineStatusEnum = z.enum(['MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF']);
const diffTypeEnum = z.enum(['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE']);
const decisionEnum = z.enum(['OPEN', 'VERIFIED', 'ACCEPTED']);

const linesQuery = paginationSchema.extend({
  status: lineStatusEnum.optional(),
  diffType: diffTypeEnum.optional(),
  /** Virgülle birden çok değer: "OPEN,VERIFIED". */
  decision: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(decisionEnum).min(1))
    .optional(),
  q: z.string().trim().optional(),
  /** Yalnız yeniden hesap bekleyen (donmuş, `recalcPending` dolu) satırlar. */
  recalcPending: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Y2: yalnız "İncele" (güveni düşük: `pricing.confidence = 'LOW'`) satırlar; fark çıkan da uyumlu çıkan da. */
  review: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** SPEC §11.5: yalnız "Kontrol edilecek" (okuma bayrağı olan, kontrol edilmemiş) satırlar. */
  flagged: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
});

/**
 * Toplu karar. Süzgeç liste ucunun süzgeciyle aynı alanlardır (JSON gövdede gerçek mantıksal değer);
 * tanınmayan alan 400 (sunucunun yok saydığı bir süzgeç, kullanıcının gördüğünden geniş seçim yapmasın).
 */
const bulkFilterSchema = z
  .object({
    status: lineStatusEnum.optional(),
    diffType: diffTypeEnum.optional(),
    decision: z.array(decisionEnum).min(1).max(3).optional(),
    q: z.string().trim().max(200).optional(),
    review: z.boolean().optional(),
    recalcPending: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .strict();
/** Karar gerekçesinin üst sınırı: tek satır (`PATCH /invoice-lines/:id`) ve toplu karar aynı. */
const DECISION_REASON_MAX = 1000;
const bulkDecideBody = z.object({
  decision: decisionEnum,
  /** `ACCEPTED`'da zorunlu (boşluk yok sayılır); `OPEN`'da yok sayılır */
  reason: z.string().trim().max(DECISION_REASON_MAX).nullable().optional(),
  /** üst sınır gövde güvencesi; asıl sınır `BULK_DECIDE_MAX` (400 BULK_TOO_MANY) */
  lineIds: z.array(z.string().min(1).max(100)).min(1).max(100_000).optional(),
  filter: bulkFilterSchema.optional(),
  expectedCount: z.number().int().min(0).max(10_000_000).optional(),
  /**
   * `filter` ile zorunlu (Y127): satır listesi yanıtının `selectionDigest`'i (süzgecin bütün satırlarının özeti). Göndermeyen
   * eski istemci 400 VALIDATION alır; eski `listedAt` alanı tanınmaz (yok sayılır), ona geri düşülmez.
   */
  selectionDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** "Geri al": yalnız `decision: 'OPEN'` + `lineIds` ile; ilk işlemin yanıtındaki `opId` ve `decidedAt` */
  undoOf: z.object({ opId: z.uuid(), decidedAt: z.iso.datetime({ offset: true }) }).strict().optional(),
});

const linePatchBody = z.object({
  decision: z.enum(['OPEN', 'VERIFIED', 'ACCEPTED']).optional(),
  reason: z.string().trim().max(DECISION_REASON_MAX).optional().nullable(),
  trackingNo: z.string().trim().min(1).max(200).optional(),
  measurementId: z.string().min(1).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  /** SPEC §11.5: "Kontrol ettim" (true) / geri al (false). Bayraklar silinmez. */
  parseChecked: z.boolean().optional(),
  /**
   * 10-B13: panelin gördüğü karar. Verilirse fatura kilidi altında satırın bugünkü kararıyla karşılaştırılır; tutmazsa
   * 409 LINE_CHANGED ve hiçbir alan yazılmaz (eski ekrandaki kişi satırı sessizce listeden çıkaramaz). Web her zaman gönderir.
   */
  expectedDecision: z.enum(['OPEN', 'VERIFIED', 'ACCEPTED']).optional(),
});

const invoicePatchBody = z.object({
  invoiceNo: invoiceNoSchema.optional(),
  invoiceDate: dateStr.optional(),
  periodFrom: dateStr.nullable().optional(),
  periodTo: dateStr.nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  carrierId: z.string().min(1).optional(),
  /** null = taşıyıcının varsayılan tarifesi. Taşıyıcı değişirse (ve tarife verilmezse) yeni taşıyıcının varsayılanı. */
  tariffId: z.string().min(1).nullable().optional(),
  /**
   * Hesabı değiştiren dört alandan (taşıyıcı, tarife, tarih, para birimi) biri değişiyorsa zorunlu: aynı değişikliğin
   * önizlemesinin (`POST /invoices/:id/recalculate/preview` `{ basis: 'pinned', patch }`) `token`'ı.
   */
  token: z.string().min(1).max(200).optional(),
});

/** `pinned`: faturanın sabit dayanağı. `tariff`: yalnız tarife sürümü güncellenir. `rules`: yalnız ayar güncellenir. */
const recalcBasis = z.enum(['pinned', 'tariff', 'rules']);
const recalcLineIds = z.array(z.string().min(1)).min(1).max(100_000).optional();
/** Önizleme: `patch` = düzenleme penceresindeki değişiklik (fatura o alanlar değişmiş gibi hesaplanır, yazılmaz). */
const recalcPreviewBody = z.object({
  basis: recalcBasis,
  lineIds: recalcLineIds,
  patch: z
    .object({
      carrierId: z.string().min(1).optional(),
      tariffId: z.string().min(1).nullable().optional(),
      invoiceDate: dateStr.optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
    })
    .optional(),
});
/** Onay: önizlemenin `token`'ı zorunlu; kilit altında yeniden kurulan özet tutmazsa 409 PREVIEW_STALE. */
const recalcBody = z.object({ basis: recalcBasis, lineIds: recalcLineIds, token: z.string().min(1).max(200) });
/** Önizleme yanıtındaki satır listesinin sınırı (sayılar tamdır). */
const RECALC_LINE_LIMIT = 200;

/** Satır seçimi ve başlık değişikliği yalnız sabit dayanakla: dayanağı değiştiren kiple birleşirse 400. */
function assertPinnedOnly(body: { basis: string; lineIds?: string[]; patch?: object }) {
  if (body.basis === 'pinned') return;
  const path = body.lineIds ? 'lineIds' : body.patch ? 'patch' : null;
  if (path) throw badRequest('VALIDATION', msg('recalc.pinnedOnly'), [{ path, message: msg('recalc.pinnedOnly') }]);
}

/** Motorun reddi → 409 (kodlar web sözleşmesiyle aynı). */
function refusal(code: 'LINE_IN_DISPUTE' | 'INVOICE_HAS_DISPUTE' | 'PREVIEW_STALE'): AppError {
  if (code === 'LINE_IN_DISPUTE') return conflict('LINE_IN_DISPUTE', msg('line.inDispute'));
  if (code === 'INVOICE_HAS_DISPUTE') return conflict('INVOICE_HAS_DISPUTE', msg('invoice.hasDisputeLocked'));
  return conflict('PREVIEW_STALE', msg('invoice.previewStale'));
}

/** `applyRecompare` sonucu: fatura yoksa 404, reddedildiyse 409. */
function applied(r: Awaited<ReturnType<typeof applyRecompare>>): ApplyRecompareResult {
  if (r === null) throw notFound(msg('invoice.notFound'));
  if (typeof r === 'string') throw refusal(r);
  return r;
}

/**
 * Fatura numarası yazımı. Ön denetim hızlı yanıt içindir; asıl sınır kısmi tekil dizindir (Invoice_current_no_key):
 * iki istek denetimi birlikte geçerse (kur beklerken sayfa yenilenip dosya yeniden yüklenince) ikincisi burada düşer.
 */
async function writeInvoiceNo<T>(write: () => PromiseLike<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('INVOICE_EXISTS', msg('invoice.exists'));
    throw e;
  }
}

type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Dizinden geniş kural: büyük/küçük harf, Türkçe İ/ı, NFKC ve görünmez karakterler yok sayılır (FATURA-I9 = fatura-ı9);
 * silinmiş ve kurulum örneği sayılmaz. Dizin yalnız lower() katlar; bu denetim eski kayıtlardaki farkı da yakalar.
 */
async function invoiceNoTaken(db: RawDb, companyId: string, carrierId: string, invoiceNo: string, exceptId?: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Invoice"
    WHERE "companyId" = ${companyId} AND "carrierId" = ${carrierId} AND translate(lower(translate(regexp_replace(normalize("invoiceNo", NFKC), '[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', '', 'g'), chr(304), 'i')), chr(305), 'i') = ${invoiceNoKey(invoiceNo)}
      AND "deletedAt" IS NULL AND NOT "isSample" AND "id" <> ${exceptId ?? ''}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Dosyadaki takip numaralarının çoğu başka canlı fatura(lar)da varsa (aynı dosya Excel/CSV olarak, ya da yalnız referansı
 * değişmiş hâlde yeniden yüklenmiş olabilir) bunu bildirir. Satır kimliği değişmez; yalnız yükleme öncesi uyarı içindir.
 */
const OVERLAP_MIN_SHARE = 0.5;
/** Ayrıntıda en çok kaç fatura adı (en çok çakışan + öbürleri); pencere metni kısa kalsın. */
const OVERLAP_MAX_INVOICES = 10;
/** Aynı tablo ve eşlemenin `parseRows` sonucu (19-B1: önizleme uçları tabloyu bir kez ayrıştırıp paylaşır). */
type Parsed = ReturnType<typeof parseRows>;

/**
 * `parsed` verilirse (aynı tablo ve eşlemenin, herhangi bir dildeki ayrıştırması: dil yalnız hata metnini değiştirir, satırları
 * değil) tablo yeniden ayrıştırılmaz.
 */
async function invoiceOverlap(companyId: string, table: Table, mapping: ColumnMapping, parsed?: Parsed) {
  if (!mapping.trackingNo || !mapping.netAmount) return null;
  return trackingOverlap(companyId, (parsed ?? parseRows(table, mapping, currentLocale())).lines.map((l) => l.trackingNo));
}

/**
 * Yükleme önizlemesinin "N satır" sayısı (Y32): ayrıştırıcının okuyacağı veri satırları. TOPLAM, ara toplam ve boş satır
 * sayılmaz; kural ayrıştırıcının kendisidir (`parseRows`), burada kopyası yok. Bir satır birden çok uyarı taşıyabilir:
 * satır sırası tekil sayılır. Takip no ya da tutar sütunu eşlenmemişse ayrıştırıcı satır okumaz: ham satır sayısı.
 * `parsed`: aynı tablo ve eşlemenin ayrıştırması (yeniden ayrıştırılmaz; sayım dilden bağımsızdır).
 */
export function previewRowCount(table: Table, mapping: ColumnMapping, parsed?: Parsed): number {
  if (!mapping.trackingNo || !mapping.netAmount) return table.rows.length;
  const r = parsed ?? parseRows(table, mapping, currentLocale());
  const rows = new Set<number>();
  for (const l of r.lines) rows.add(l.rowIndex);
  for (const e of r.errors) if (e.rowIndex >= 0) rows.add(e.rowIndex);
  for (const s of r.skipped) rows.add(s.rowIndex);
  return rows.size;
}

type TrackingOverlap = {
  total: number;
  /** Başka herhangi bir canlı faturada bulunan (birleşik, tekrarsız) gönderi sayısı. */
  matched: number;
  /** En çok çakışan fatura. */
  invoiceId: string;
  invoiceNo: string;
  /** Çakışan öbür faturalar (çoktan aza); yalnız varsa yazılır. */
  otherInvoices?: { invoiceId: string; invoiceNo: string; matched: number }[];
};

/**
 * Aynı denetim, okunmuş satırların takip numaralarıyla. İçe aktarma bunu sunucuda yeniden yapar: birebir aynı satırlar artık
 * atlanmadığı için (KARARLAR "Birebir aynı satır") aynı dosyanın başka fatura numarasıyla ikinci kez yüklenmesi bütün
 * satırları "Mükerrer" yapar; kullanıcı "yine de yükle" demeden fatura oluşmaz.
 * Kural (KARARLAR "Birebir aynı satır"): dosyadaki gönderilerin en az yarısı başka fatura(lar)da varsa; pay birleşiktir, gönderiler
 * iki eski faturaya yayılmış olsa da (%30 + %30) sayılır. Önizleme uyarısı ve içe aktarma denetimi bu tek işlevi kullanır.
 */
async function trackingOverlap(companyId: string, trackingNos: string[], db: RawDb = prisma): Promise<TrackingOverlap | null> {
  const trackings = [...new Set(trackingNos)];
  if (!trackings.length) return null;
  const rows = await db.$queryRaw<{ id: string; invoiceNo: string; matched: number; combined: number }[]>`
    WITH hits AS (
      SELECT i."id", i."invoiceNo", i."createdAt", l."trackingNo"
      FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE l."companyId" = ${companyId} AND l."trackingNo" = ANY(${trackings}::text[]) AND i."deletedAt" IS NULL AND NOT i."isSample"
    )
    SELECT h."id", h."invoiceNo", count(DISTINCT h."trackingNo")::int AS matched,
      (SELECT count(DISTINCT "trackingNo") FROM hits)::int AS combined
    FROM hits h
    GROUP BY h."id", h."invoiceNo", h."createdAt" ORDER BY matched DESC, h."createdAt", h."id" LIMIT ${OVERLAP_MAX_INVOICES}`;
  const top = rows[0];
  if (!top || top.combined / trackings.length < OVERLAP_MIN_SHARE) return null;
  const others = rows.slice(1).map((r) => ({ invoiceId: r.id, invoiceNo: r.invoiceNo, matched: r.matched }));
  return {
    total: trackings.length,
    matched: top.combined,
    invoiceId: top.id,
    invoiceNo: top.invoiceNo,
    ...(others.length ? { otherInvoices: others } : {}),
  };
}

/** Gün alanı (fatura tarihi, dönem): Türkiye günü, UTC gece yarısı (bkz. parseDayInput). */
function toDate(s: string | null | undefined): Date | null {
  return parseDayInput(s) ?? null;
}

/** Fatura no / tarih / para birimi sütunlardan (core); fatura no bulunamazsa dosya adından, para birimi bulunamazsa firmanınki. */
function guessMeta(table: Table, mapping: ColumnMapping, fileName: string, carrierCode: string, defaultCurrency: string) {
  const meta = guessInvoiceMeta(table, mapping);
  meta.currency ??= defaultCurrency;
  if (!meta.invoiceNo) {
    const base = fileName.replace(/\.[^.]+$/, '');
    const stripped = base.replace(new RegExp(`^${carrierCode}[-_ ]+`, 'i'), '');
    if (stripped && stripped !== base && /\d/.test(stripped)) meta.invoiceNo = stripped;
  }
  return meta;
}

function isSavedMappingUsable(saved: unknown, headers: string[]): saved is ColumnMapping {
  if (!saved || typeof saved !== 'object') return false;
  const m = saved as Record<string, unknown>;
  const needed = ['trackingNo', 'netAmount'];
  if (!needed.every((k) => typeof m[k] === 'string' && headers.includes(m[k] as string))) return false;
  // Satır alanları dosyada olmalı; meta sütunları (fatura no/tarih/toplam) ve ipuçları (numberFormat…) zorunlu değil.
  for (const k of MAPPING_FIELDS) {
    const v = m[k];
    if (typeof v === 'string' && v && !headers.includes(v)) return false;
  }
  if (Array.isArray(m.chargePairs)) {
    for (const p of m.chargePairs as { label?: unknown; amount?: unknown }[]) {
      if (!headers.includes(String(p?.label)) || !headers.includes(String(p?.amount))) return false;
    }
  }
  return true;
}

/** Eski sürümde kaydedilmiş eşlemede olmayan yeni alanları (birimler, ücret çiftleri) öneriden tamamlar. */
function completeSavedMapping(saved: ColumnMapping, suggested: ColumnMapping, headers: string[]): ColumnMapping {
  const out: ColumnMapping = { ...saved, surchargeColumns: saved.surchargeColumns ?? [] };
  for (const k of ['dimUnit', 'actualKgUnit', 'billedKgUnit'] as const) {
    if (!(k in saved) && suggested[k]) out[k] = suggested[k];
  }
  if (!Array.isArray(saved.chargePairs)) out.chargePairs = suggested.chargePairs ?? [];
  for (const k of META_FIELDS) {
    if (!saved[k] || !headers.includes(saved[k]!)) {
      if (suggested[k]) out[k] = suggested[k];
      else delete out[k];
    }
  }
  return out;
}


/** İtiraz metni ve kanıt ZIP'inin dili: `?lang=tr|en`, yoksa isteğin dili. */
function disputeLang(req: FastifyRequest): 'tr' | 'en' {
  return z.object({ lang: z.enum(['tr', 'en']).optional() }).parse(req.query).lang ?? req.locale;
}

/** Satırı faturadan düşüren okuma hataları (`buildImportReport` ile aynı kural: takip no ya da tutar okunamadı). */
function droppedRows(errors: readonly { rowIndex: number; code?: string }[]): number {
  return new Set(errors.filter((e) => e.rowIndex >= 0 && (e.code === 'BAD_TRACKING' || e.code === 'BAD_NET')).map((e) => e.rowIndex)).size;
}

/** Core'un Türkçe okuma hatası (boş dosya, yalnız başlık, bozuk Excel…) varsa onu, yoksa genel mesajı döner. */
function readErrorMessage(e: unknown): string {
  return e instanceof InvoiceFileError || (e as Error | null)?.name === 'InvoiceFileError' ? invoiceFileMessage((e as InvoiceFileError).code, currentLocale()) : msg('invoice.fileUnreadable');
}

/** Okuma hatası → uç hatası. Dosya havuzunun yük hataları (413 sınır, 422 karmaşık, 503 meşgul) olduğu gibi geçer. */
function readFailure(e: unknown): AppError {
  return e instanceof AppError ? e : badRequest('INVALID_FILE', readErrorMessage(e));
}

/**
 * Önizleme dosyalarının okunmuş tabloları (doğrulama ve yapay zekâ eşleme her değişiklikte dosyayı yeniden okumasın).
 * 06-B1, 19-B7: bayt, süre ve sayıyla sınırlı (`lib/tableCache.ts`); sınırı aşan tablo tutulmaz, gerekince dosyadan okunur.
 */
export const tableCache = new TableCache();

async function loadSourceTable(file: { id: string; path: string; mime: string; originalName: string | null; companyId: string }): Promise<Table> {
  const hit = tableCache.get(file.id);
  if (hit) return hit;
  const bytes = await readStored(file.path);
  let table: Table;
  try {
    table = await readTable(file.originalName ?? `invoice.${file.mime === 'text/csv' ? 'csv' : 'xlsx'}`, new Uint8Array(bytes), { companyId: file.companyId });
  } catch (e) {
    throw readFailure(e);
  }
  tableCache.set(file.id, table);
  return table;
}

async function loadPreviewFile(companyId: string, fileId: string) {
  const file = await prisma.file.findFirst({ where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', purgedAt: null } });
  if (!file) throw notFound(msg('invoice.uploadNotFound'));
  if (file.mime === 'application/pdf') throw badRequest('UNSUPPORTED_FORMAT', msg('invoice.pdfNoMapping'));
  // Kullanılan önizleme "unutulmuş" sayılmasın; bakım 24 saat dokunulmayanı siler.
  if (!file.invoiceId) await prisma.file.updateMany({ where: { id: file.id, companyId, invoiceId: null, purgedAt: null }, data: { updatedAt: new Date() } });
  return file;
}

function carrierCodeOf(carrier: { code: string }): CarrierCode {
  return (CARRIER_CODES as readonly string[]).includes(carrier.code) ? (carrier.code as CarrierCode) : 'generic';
}

/** Ücretli ağırlık kontrolünün böleni: taşıyıcının varsayılan (yoksa son) etkin tarifesi, yoksa kalıp, yoksa 5000. */
async function divisorFor(companyId: string, carrier: { id: string; code: string }): Promise<number> {
  const t = await prisma.tariff.findFirst({
    where: { companyId, carrierId: carrier.id, active: true },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    select: { divisor: true },
  });
  return t?.divisor || CARRIER_PRESETS[carrierCodeOf(carrier)]?.defaultDivisor || 5000;
}

type DeterministicMapping = {
  mapping: ColumnMapping;
  source: 'saved' | 'preset';
  confidence: number;
  missing: string[];
  notices: DiagnosticWarning[];
  diagnostics: MappingDiagnostics;
  /** Taşıyıcının kendi kalıbı var mı (generic değil)? */
  hasPreset: boolean;
  /** Seçilen eşlemenin ayrıştırması (satır sayısı ve çakışma denetimi yeniden ayrıştırmasın). */
  parsed: Parsed;
};

/**
 * Okuma kontrolü, tablonun tek ayrıştırmasıyla (19-B1). `mappingDiagnostics` kendisi de `parseRows(t, m)` (varsayılan dil)
 * çağırırdı: aynı ayrıştırma önceden yapılıp verilir, sonuç birebir aynıdır; aradaki olay döngüsü molası başka isteklere
 * sıra verir (iki eşzamanlı parça tek blok olmaz).
 */
async function diagnosticsOf(table: Table, mapping: ColumnMapping, divisor: number): Promise<{ parsed: Parsed; diagnostics: MappingDiagnostics }> {
  await yieldToLoop();
  const parsed = parseRows(table, mapping);
  await yieldToLoop();
  return { parsed, diagnostics: mappingDiagnostics(table, mapping, { divisor, locale: currentLocale(), parsed }) };
}

/** SPEC §11.3: varsayılan, ücretsiz ve anında eşleme — kayıtlı eşleme, yoksa kalıp önerisi. */
async function deterministicMapping(table: Table, carrier: { code: string; defaultMapping: unknown }, divisor: number): Promise<DeterministicMapping> {
  const code = carrierCodeOf(carrier);
  let source: 'saved' | 'preset' = 'preset';
  let suggested = suggestMapping(table.headers, code, table.rows);
  let { parsed, diagnostics } = await diagnosticsOf(table, suggested.mapping, divisor);
  const notices: DiagnosticWarning[] = [];
  if (isSavedMappingUsable(carrier.defaultMapping, table.headers)) {
    // K36: kayıtlı eşlemede ağırlık seçimi olsa da (eski kayıt) okunmaz; her dosyada sorulur
    const saved = completeSavedMapping(savedMappingOf(carrier.defaultMapping as ColumnMapping), suggested.mapping, table.headers);
    const savedRead = await diagnosticsOf(table, saved, divisor);
    const savedDiag = savedRead.diagnostics;
    // Kayıtlı eşleme bu dosyada hiç takip no / satır bulamıyorsa kalıp önerisine düşülür.
    if (table.rows.length > 0 && (savedDiag.trackingFilled === 0 || savedDiag.parsedLines === 0) && diagnostics.parsedLines > 0) {
      notices.push({ code: 'SAVED_MAPPING_FALLBACK', message: msg('invoice.savedMappingFallback') });
    } else {
      source = 'saved';
      suggested = { mapping: saved, confidence: 1, missing: [] };
      diagnostics = savedDiag;
      parsed = savedRead.parsed;
    }
  }
  return { ...suggested, source, notices, diagnostics, parsed, hasPreset: code !== 'generic' };
}

/** Yanıtta satır bayraklarını sınırlar (büyük dosyalarda tüm liste gerekmez; sayılar tamdır). */
const ROW_FLAG_LIMIT = 200;
function slimDiagnostics(d: MappingDiagnostics, notices: DiagnosticWarning[] = []): MappingDiagnostics {
  return {
    ...d,
    warnings: [...notices, ...d.warnings],
    verification: { ...d.verification, rowFlags: d.verification.rowFlags.slice(0, ROW_FLAG_LIMIT) },
  };
}

function issuesPayload(v: MappingVerification) {
  return {
    issues: v.issues,
    verdict: v.verdict,
    flaggedRows: v.flaggedRows,
    flagCounts: v.flagCounts,
    examples: v.rowFlags.filter((r) => r.codes.length).slice(0, 10),
  };
}

function emptyMappingLike(): ColumnMapping {
  return { surchargeColumns: [], chargePairs: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false };
}

/** SPEC §11.4: kaynak dosya ve eşleme ile satır bayraklarını yeniden hesaplar (eski faturalar için de). */
export async function refreshParseFlags(invoiceId: string): Promise<number | null> {
  const inv = await prisma.invoice.findFirst({ where: { id: invoiceId }, include: { sourceFile: true, carrier: true } });
  if (!inv || inv.deletedAt) return null;
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const divisor = await divisorFor(inv.companyId, inv.carrier);
  let byRow: Map<number, string[]>;
  const m = inv.mapping as Partial<ColumnMapping> | null;
  if (inv.sourceFile.mime !== 'application/pdf' && m && typeof m.trackingNo === 'string' && typeof m.netAmount === 'string') {
    const table = await loadSourceTable(inv.sourceFile);
    const mapping = { ...emptyMappingLike(), ...m } as ColumnMapping;
    // 19-B1: ayrıştırma ve okuma kontrolü iki ayrı eşzamanlı parça (`mappingDiagnostics`'in kendi ayrıştırmasıyla aynı)
    await yieldToLoop();
    const parsed = parseRows(table, mapping);
    await yieldToLoop();
    // 01-B8: satır para birimi faturanınkiyle denetlenir (içe aktarmadaki gibi)
    const d = mappingDiagnostics(table, mapping, { divisor, locale: currentLocale(), invoiceCurrency: inv.currency, parsed });
    byRow = new Map(d.verification.rowFlags.map((r) => [r.rowIndex, r.codes as string[]]));
  } else {
    byRow = new Map(flagParsedLines(lines.map(lineRowToParsed), { divisor, invoiceCurrency: inv.currency }).map((r) => [r.rowIndex, r.codes as string[]]));
  }
  // PDF metin denetiminin bayrakları (`PDF_*`) içe aktarmada bir kez konur; burada yeniden hesaplanmaz ve
  // silinmez (yeniden karşılaştırma okuma bayraklarını tazeler, PDF kanıtını değil).
  const all = lines.map((l) => ({
    id: l.id,
    next: mergePdfFlags((byRow.get(l.rowIndex) ?? []).filter((c) => !isPdfFlag(c)), l.parseFlags.filter(isPdfFlag)),
    prev: l.parseFlags,
  }));
  const updates = all.filter((u) => u.next.join(',') !== u.prev.join(','));
  if (updates.length) {
    // aynı bayrak kümesine sahip satırlar tek updateMany ile (satır başına sorgu yok)
    const groups = new Map<string, { flags: string[]; ids: string[] }>();
    for (const u of updates) {
      const key = u.next.join(',');
      const g = groups.get(key) ?? { flags: u.next, ids: [] };
      g.ids.push(u.id);
      groups.set(key, g);
    }
    // Önce fatura kilidi (satır yazan her yolun sırası: bulkDecide, tek satır kararı, yeniden karşılaştırma). Kilitsiz
    // updateMany satır kilitlerini kendi sırasıyla alıyordu; aynı satırları başka sırayla kilitleyen toplu kararla ölümcül
    // kilitlenebilirdi. Fatura bu arada silindiyse 404 (yeniden karşılaştırma zaten yapılamaz).
    await prisma.$transaction(async (tx) => {
      await lockInvoice(tx, inv.companyId, invoiceId);
      for (const g of groups.values()) await tx.invoiceLine.updateMany({ where: { invoiceId, id: { in: g.ids } }, data: { parseFlags: g.flags } });
    }, TX_DEFAULTS);
  }
  return all.filter((u) => u.next.length > 0).length;
}

/**
 * Faturaya kaydedilecek tarife: verilmediyse (K2) fatura gününde geçerli etkin tarife, o gün geçerli tarife yoksa
 * taşıyıcının varsayılanı (`tariffForDate`; tarifesi yoksa null). Verilen tarife şirketin ve faturanın taşıyıcısının
 * olmalı (başka şirket 404, başka taşıyıcı / pasif 400).
 */
async function resolveInvoiceTariff(companyId: string, carrierId: string, tariffId: string | null | undefined, invoiceDate: Date | null) {
  if (!tariffId) {
    const list = await prisma.tariff.findMany({
      where: { companyId, carrierId },
      select: { id: true, active: true, isDefault: true, updatedAt: true, validFrom: true, validTo: true },
    });
    return tariffForDate(list, invoiceDate)?.id ?? null;
  }
  const t = await prisma.tariff.findFirst({ where: { id: tariffId, companyId }, select: { id: true, carrierId: true, active: true } });
  if (!t) throw notFound(msg('invoice.tariffNotFound'));
  if (t.carrierId !== carrierId) {
    throw badRequest('TARIFF_CARRIER_MISMATCH', msg('invoice.tariffCarrierMismatch'), [
      { path: 'tariffId', message: msg('v.otherCarrierTariff') },
    ]);
  }
  if (!t.active) {
    throw badRequest('TARIFF_INACTIVE', msg('invoice.tariffInactive'), [
      { path: 'tariffId', message: msg('v.inactiveTariff') },
    ]);
  }
  return t.id;
}

const invoiceTariffSelect = { select: { id: true, name: true } } as const;

async function loadInvoice(id: string, companyId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, companyId, deletedAt: null },
    include: { carrier: true, sourceFile: true, tariff: invoiceTariffSelect },
  });
  if (!inv) throw notFound(msg('invoice.notFound'));
  return inv;
}

/** Y11: yalnız faturanın kendi sütunları (ilişkisiz, tek sorgu); yeniden hesabın önizlemesi bunu kullanır. */
async function loadInvoiceRow(id: string, companyId: string) {
  const inv = await prisma.invoice.findFirst({ where: { id, companyId, deletedAt: null } });
  if (!inv) throw notFound(msg('invoice.notFound'));
  return inv;
}

/** Satırlarda kullanılan tarifeler (satır sayısına göre çoktan aza): tek sorgu (Y11; eskiden groupBy + ad sorgusu). */
async function tariffsUsed(invoiceId: string) {
  const groups = await prisma.$queryRaw<{ id: string; name: string | null; lines: number }[]>`
    SELECT l."tariffId" AS "id", t."name", count(*)::int AS "lines"
    FROM "InvoiceLine" l LEFT JOIN "Tariff" t ON t."id" = l."tariffId"
    WHERE l."invoiceId" = ${invoiceId} AND l."tariffId" IS NOT NULL
    GROUP BY l."tariffId", t."name"`;
  return sortTariffsUsed(groups);
}

function sortTariffsUsed(groups: { id: string; name: string | null; lines: number }[]) {
  return groups
    .map((g) => ({ id: g.id, name: g.name ?? '—', lines: g.lines }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name, 'tr'));
}

/**
 * 19-B14: fatura ayrıntısının satır özeti tek taramada: kullanılan tarifeler (`tariffsUsed` ile aynı) ve tarife şüphesi
 * (`services/invoiceHints.ts` `tariffSuspect` ile aynı sayımlar; eskiden satırlar iki ayrı sorguyla taranıyordu).
 */
async function tariffFacts(invoiceId: string): Promise<{ tariffsUsed: ReturnType<typeof sortTariffsUsed>; tariffSuspect: boolean }> {
  const groups = await prisma.$queryRaw<{ id: string | null; name: string | null; lines: number; compared: number; priceDiff: number }[]>`
    SELECT l."tariffId" AS "id", t."name", count(*)::int AS "lines",
      (count(*) FILTER (WHERE l."status" IN ('MATCH', 'DIFF')))::int AS "compared",
      (count(*) FILTER (WHERE l."status" = 'DIFF' AND 'PRICE' = ANY(l."diffTypes")))::int AS "priceDiff"
    FROM "InvoiceLine" l LEFT JOIN "Tariff" t ON t."id" = l."tariffId"
    WHERE l."invoiceId" = ${invoiceId}
    GROUP BY l."tariffId", t."name"`;
  const compared = groups.reduce((n, g) => n + g.compared, 0);
  const priceDiff = groups.reduce((n, g) => n + g.priceDiff, 0);
  return {
    tariffsUsed: sortTariffsUsed(groups.filter((g): g is typeof g & { id: string } => g.id !== null)),
    tariffSuspect: isTariffSuspect(compared, priceDiff),
  };
}

/**
 * Rapor özeti: ekrandaki gibi faturanın hesaplandığı sürümün tarifesi (`basis.tariffName`; tarife silindiyse sürümdeki ad,
 * "Ad (silindi)"). Dayanağı olmayan faturada seçili tarife; o da yoksa satırlarda kullanılanlar.
 */
function tariffSummaryText(basis: InvoiceBasisView, chosen: { name: string } | null, used: { name: string; lines: number }[]) {
  if (basis.tariffName) return basis.state === 'TARIFF_REMOVED' ? msg('report.tariffRemoved', { name: basis.tariffName }) : basis.tariffName;
  if (chosen) return chosen.name;
  if (!used.length) return msg('invoice.noTariff');
  if (used.length === 1) return used[0]!.name;
  return used.map((u) => msg('invoice.tariffUsedLines', { name: u.name, lines: u.lines })).join(', ');
}

function serializeInvoiceHeader(
  inv: Prisma.InvoiceGetPayload<{ include: { carrier: true; tariff: typeof invoiceTariffSelect } }>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: inv.id,
    invoiceNo: inv.invoiceNo,
    invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
    periodFrom: inv.periodFrom ? inv.periodFrom.toISOString().slice(0, 10) : null,
    periodTo: inv.periodTo ? inv.periodTo.toISOString().slice(0, 10) : null,
    currency: inv.currency,
    status: inv.status,
    carrier: { id: inv.carrier.id, code: inv.carrier.code, name: inv.carrier.name },
    /** Faturanın tarifesi; null = taşıyıcının varsayılanı (eski fatura) ya da tarife yok. */
    tariffId: inv.tariffId,
    tariff: inv.tariff ? { id: inv.tariff.id, name: inv.tariff.name } : null,
    totals: inv.totals as InvoiceTotals,
    mapping: inv.mapping,
    sourceFileId: inv.sourceFileId,
    createdAt: inv.createdAt,
    ...extra,
  };
}

/** KALANLAR 6.18: içe aktarmanın gövdesi (`POST /invoices`); arka plan işinin girdisinde de bu biçimde durur. */
export const invoiceImportBody = importBody;
export type InvoiceImportBody = z.infer<typeof importBody>;

/** Satır içi ve arka plan içe aktarmanın ortak adımları (KALANLAR 6.18). İstekte verilmez, işte `handlers/invoiceImport.ts`. */
export type InvoiceImportHooks = {
  /** ilerleme aşaması (ekran: `jobs.stage.<aşama>`) */
  stage?(stage: 'importRead' | 'importCompare' | 'importWrite'): Promise<void>;
  /** adım arasında: durdurma istendiyse atar (yazımdan önce; hiçbir şey yazılmamıştır) */
  checkCancel?(): void;
  /** yazım işleminin sonunda, aynı işlemde; atarsa işlem (fatura, satırlar, dosya bağı) geri alınır */
  inWrite?(tx: Tx, written: ImportWritten): Promise<void>;
  /** yazım işlemi işlendi (commit): fatura artık geri alınamaz; durdurma bundan sonra işi durduramaz */
  committed?(): void;
  /** yazım sonrası adımlar (tazeleme, ölçüm sırası) bitti */
  settled?(): Promise<void>;
};

/** Yazım işleminin sonunda kancaya verilen bilgi: fatura, satır hataları ve yazım sonrası tazeleme gerekip gerekmediği. */
export type ImportWritten = { invoiceId: string; errors: InvoiceImportOutcome['errors']; recompare: 'MEASUREMENT' | 'DUPLICATE' | null };

export type InvoiceImportRun = {
  companyId: string;
  /** denetim kaydının kişisi */
  userId: string | null;
  body: InvoiceImportBody;
  /** taşıyıcının kayıtlı eşlemesini yazma izni (`settings.manage`; K3). İşte başlatanın izni, başlatma anında. */
  mayRemember: boolean;
  log: { warn(o: unknown, m: string): void };
  /** dosya çalışanının bağlantı izlemesi (istek kopunca çocuk süreç bırakılır); işte yok */
  connection?: Socket;
  hooks?: InvoiceImportHooks;
};

export type InvoiceImportOutcome = {
  invoice: Prisma.InvoiceGetPayload<{ include: { carrier: true; tariff: typeof invoiceTariffSelect } }>;
  fileId: string;
  errors: ReturnType<typeof parseRows>['errors'];
  importReport: ImportReport | null;
};

/**
 * Faturayı içe aktarır: denetimler, karşılaştırma, tek işlemde yazım, sonradan tazeleme ve denetim kaydı. Satır içi
 * (`POST /invoices`, 201) ve arka plan işi (`INVOICE_IMPORT`) bunu çağırır: aynı dosya ve gövde aynı faturayı aynı
 * rakamlarla yazar. Firma bağlamında çağrılır (istek ya da `withCompany`); hata `AppError` olarak atılır.
 */
export async function runInvoiceImport(o: InvoiceImportRun): Promise<InvoiceImportOutcome> {
  const { companyId, userId, body, hooks } = o;
  const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId } });
  if (!carrier) throw notFound(msg('carrier.notFound'));
  const currency = body.currency ?? (await firmCurrency(companyId));
  // Diskten temizlenmiş dosyadan fatura yazılmaz (kaynak dosyası olmayan canlı fatura doğmasın). İşlem içinde yeniden denetlenir.
  const file = await prisma.file.findFirst({ where: { id: body.fileId, companyId, kind: 'INVOICE_SOURCE', purgedAt: null } });
  if (!file) throw notFound(msg('invoice.uploadNotFound'));
  if (await invoiceNoTaken(prisma, companyId, carrier.id, body.invoiceNo)) throw conflict('INVOICE_EXISTS', msg('invoice.exists'));
  // K2: tarife verilmediyse fatura gününde geçerli olan (yoksa varsayılan)
  const tariffId = await resolveInvoiceTariff(companyId, carrier.id, body.tariffId, toDate(body.invoiceDate));
  await hooks?.stage?.('importRead');

  let parsed: ParsedInvoiceLine[];
  let parseErrors: ReturnType<typeof parseRows>['errors'] = [];
  let mappingToStore: unknown;
  let verification: MappingVerification | null = null;
  let rowFlags = new Map<number, string[]>();
  /** 04-B11: faturaya alınmayan satırların kaydı; faturaya yazılır ve yanıtta döner. */
  let importReport: ImportReport | null = null;
  /** Yapılırsa: PDF satırlarının metin denetimi (yanıt sayısı `importReport.pdfCheck`). */
  let pdfUnverified = 0;
  /** 05-B16: PDF satırlarında istemcinin yapay zekâ okumasından farklı gönderdiği alanlar (yalnız denetim kaydında). */
  let pdfEdits: PdfLineEdits | null = null;
  if (file.mime === 'application/pdf') {
    if (!body.lines) throw badRequest('VALIDATION', msg('invoice.pdfLinesMissing'));
    // Boş liste PDF okunmadan reddedilir (yoksa 30 MB'lık belge boşuna ayrıştırılırdı).
    if (!body.lines.length) throw badRequest('NO_LINES', msg('invoice.noLines'));
    // Satır no istemciden gelir: yinelenen no bayrakları başka satıra taşırdı (satır no ile eşlenir); o zaman sıraya göre.
    // Y23: ölçek yapay zekâ çıktısındaki sıra (0 tabanlı); no'suz satır verilenlerin en büyüğünden sonra numaralanır
    // (çakışmasın), yinelenen no'da bütün satırlar sırayla 0'dan.
    let nextRow = body.lines.reduce((m, l) => Math.max(m, l.rowIndex ?? -1), -1) + 1;
    const given = body.lines.map((l) => l.rowIndex ?? nextRow++);
    const unique = new Set(given).size === given.length;
    parsed = body.lines.map((l, i) => {
      // 01-B8: satırın para birimi ISO koduyla ("TL", "₺" → TRY): karşılaştırma ve bayrak bu kodla, saklanan da bu
      const { currency: rawCurrency, ...rest } = l;
      const lineCurrency = currencyCode(rawCurrency);
      const line: ParsedInvoiceLine = { ...rest, ...(lineCurrency ? { currency: lineCurrency } : {}), rowIndex: unique ? given[i]! : i, rawHash: l.rawHash ?? '' };
      if (!line.rawHash) line.rawHash = sha256Hex(JSON.stringify({ ...line, rawHash: undefined, rowIndex: undefined }));
      return line;
    });
    // K43: faturanın bilinen KDV oranı (önizleme kaydından) eşlemeyle saklanır; itiraz metni KDV dahil tutarı da yazar
    const pdfVat = readPdfPreview(file.preview)?.invoiceVatPct;
    mappingToStore = { source: 'ai', ...(pdfVat != null ? { vatPct: pdfVat } : {}) };
    // 01-B8: satırın kendi para birimi faturanınkinden farklıysa tablo yolundaki gibi onay kapısı (409 MAPPING_UNVERIFIED,
    // aynı metin); onaylanırsa satır sert bayrakla ("Kontrol edilecek") yüklenir.
    const currencyGate = pdfCurrencyGate(parsed, currency, currentLocale());
    if (currencyGate && !body.acknowledgeIssues) throw new AppError(409, 'MAPPING_UNVERIFIED', msg('invoice.pdfCurrencyUnverified'), currencyGate);
    // 01-B7: bayraklar saklanacak sayılarla ("Yeniden karşılaştır" `refreshParseFlags` saklananı okur, aynı bayrak çıkar).
    rowFlags = new Map(
      flagParsedLines(parsed.map(atStoredPrecision), { divisor: await divisorFor(companyId, carrier), invoiceCurrency: currency }).map((r) => [r.rowIndex, r.codes as string[]]),
    );
    // 04-B12: sunucu saklanan PDF'in metnini kendisi okur ve gönderilen satırları onunla denetler (istemcinin
    // önizlemede gördüğü sonuca güvenilmez; kullanıcı düzelttiği satırı metindeki değere getirdiyse satır temiz çıkar).
    // Tutmayan satır işaretlenir ("Kontrol edilecek"); fatura yine yüklenir, onay kapısı yok (kullanıcı kararı).
    // E2, E6: metin ve takip no'suz satırlar önizlemenin kaydından (`File.preview`, sunucu yazar);
    // metin kayıtta yoksa (1 MB üstü ya da eski önizleme) saklanan dosyadan okunur.
    const preview = readPdfPreview(file.preview);
    const pageTexts = preview?.pageTexts ?? (await storedPdfPageTexts(file.path, { companyId, connection: o.connection }));
    // Y20: okumanın KDV oranıyla (önizleme kaydı; yoksa %20) denetlenir; varsayım rapora yazılır
    // 05-B4: ağırlık, ölçü ve ek ücret de, önizleme kaydındaki basılı birimle (kayıt yoksa bütün karşılıklar)
    const check = checkInvoicePdfLines(pageTexts, parsed, preview?.read?.vatPct ?? PDF_VAT_PCT, pdfCheckUnitsOf(preview?.read));
    // K36: ağırlığı "1.500" gibi iki türlü basılı satır kullanıcı seçmeden alınmaz (onayla da geçilmez). Satır no'ları yeniden
    // numaralandıysa seçim gönderilen sıraya göre eşlenir.
    const chosen = new Set(body.pdfWeightConfirmed);
    const chosenRows = new Set(parsed.filter((_, i) => chosen.has(given[i]!)).map((l) => l.rowIndex));
    const unchosen = check.rows.filter((r) => r.weightAmbiguity && !chosenRows.has(r.rowIndex));
    if (unchosen.length) {
      throw new AppError(409, 'PDF_WEIGHT_CHOICE_REQUIRED', msg('invoice.pdfWeightChoiceRequired', { count: unchosen.length }), {
        rows: unchosen.map((r) => ({ rowIndex: r.rowIndex, weightAmbiguity: r.weightAmbiguity })),
      });
    }
    // 05-B16: gönderilen satırlar okuma işinin sunucudaki sonucuyla karşılaştırılır; değişen alanlar denetim kaydına.
    // Satır no'ları yinelendiyse (yukarıda yeniden numaralandı) satırlar eşlenemez: karşılaştırma yapılmaz.
    const serverLines = unique ? await serverPdfLines(companyId, file.id) : null;
    pdfEdits = serverLines ? pdfLineEdits(serverLines, parsed) : null;
    // Y31: metinde geçen ama gönderilen satırlarda olmayan takip no'lar ("okunmamış olabilir"; fatura yine yüklenir)
    const pdfMissed = check.method === 'text' ? findPdfMissedLines(pageTexts, parsed, body.invoiceNo) : undefined;
    for (const r of check.rows) if (r.codes.length) rowFlags.set(r.rowIndex, mergePdfFlags(rowFlags.get(r.rowIndex) ?? [], r.codes));
    pdfUnverified = check.unverified;
    // Ek E1: büyük PDF'in gruplu okumasındaki şüpheler (KDV belirsiz, sayfa sınırı) sunucunun kaydından sert bayrak olur
    for (const [row, codes] of pdfReviewFlags(preview?.review, parsed, normalizeTracking)) rowFlags.set(row, mergePdfFlags(rowFlags.get(row) ?? [], codes));
    // Kayıtta yoksa (okuma bitmemiş ya da eski önizleme) takip no'suz satır bilinmez: `NO_TRACKING` yazılmaz.
    const skipped = preview?.skipped ?? [];
    importReport = buildImportReport({
      source: 'pdf',
      // alınan + alınmayan (tutarı 0 olan takip no'suz satır ücret değildir, sayılmaz)
      rowsInFile: parsed.length + skipped.length,
      linesImported: parsed.length,
      errors: [],
      skipped,
      pdfCheck: { method: check.method, checked: check.checked, unverified: check.unverified },
      ...(pdfMissed ? { pdfMissed } : {}),
      ...(preview?.read ? { pdfRead: preview.read } : {}),
    });
  } else {
    if (!body.mapping) throw badRequest('VALIDATION', msg('invoice.mappingMissing'));
    const mapping = body.mapping as ColumnMapping;
    if (!mapping.trackingNo || !mapping.netAmount) {
      throw badRequest('MAPPING_INCOMPLETE', msg('invoice.mappingIncomplete'));
    }
    const table = await loadSourceTable(file);
    hooks?.checkCancel?.();
    const result = parseRows(table, mapping, currentLocale());
    // 19-B1: ayrıştırma ile okuma kontrolü iki ayrı eşzamanlı parça (arada başka isteklerin sırası)
    await yieldToLoop();
    parsed = result.lines;
    parseErrors = result.errors;
    mappingToStore = mapping;
    if (!parsed.length && parseErrors.some((e) => e.rowIndex < 0)) {
      throw badRequest('MAPPING_INCOMPLETE', parseErrors[0]!.message, parseErrors);
    }
    // KALANLAR 1.13: Excel'in bilimsel yazıma çevirdiği takip no'lar geri alınamaz, hiçbir ölçümle eşleşmez: onayla da
    // alınmaz; ileti dosyanın nasıl yeniden alınacağını söyler (önizlemede okuma kontrolü aynı şeyi yazar).
    const scientific = scientificTrackingRows(table, mapping);
    if (scientific) throw badRequest('TRACKING_SCIENTIFIC', msg('invoice.trackingScientific', { count: scientific.count, sample: scientific.sample }), scientific);
    // SPEC §11.4: okuma kontrolü sunucuda yeniden çalışır; sorun varsa açık onay gerekir.
    // 01-B8: satır para birimleri faturanın (istekteki ya da firmanın) para birimiyle denetlenir; çelişki onay ister
    const d = mappingDiagnostics(table, mapping, { divisor: await divisorFor(companyId, carrier), parsed: result, locale: currentLocale(), invoiceCurrency: currency });
    verification = d.verification;
    // K36: "1.500" ağırlık seçilmeden alınmaz; okuma kontrolünün onayı bunu geçmez (yalnız ağırlık hücrelerine uygulanır)
    if (d.weightAmbiguity && mapping.weightFormat !== 'tr' && mapping.weightFormat !== 'en') {
      throw new AppError(409, 'WEIGHT_FORMAT_REQUIRED', msg('invoice.weightFormatRequired', { sample: d.weightAmbiguity.sample }), { weightAmbiguity: d.weightAmbiguity });
    }
    if (verification.verdict !== 'ok' && !body.acknowledgeIssues) {
      throw new AppError(409, 'MAPPING_UNVERIFIED', msg('invoice.mappingUnverified'), issuesPayload(verification));
    }
    rowFlags = new Map(verification.rowFlags.map((r) => [r.rowIndex, r.codes as string[]]));
    importReport = buildImportReport({
      source: 'table',
      // Dosyanın veri satırları = alınan + alınmayan. Toplam/ara toplam ve boş satırlar sessizce atlanır, sayılmaz
      // (tarayıcı denemesi: 10 veri + 1 TOPLAM satırında 11 yazıyordu).
      rowsInFile: parsed.length + droppedRows(result.errors) + result.skipped.length,
      linesImported: parsed.length,
      errors: result.errors,
      skipped: result.skipped,
    });
  }
  if (!parsed.length) {
    throw badRequest(
      'NO_LINES',
      msg('invoice.noLines'),
      parseErrors.slice(0, 20),
    );
  }

  // KARARLAR "Birebir aynı satır" (2026-11-10): önceden yüklenmiş ya da dosyada yinelenen birebir aynı satır atlanmaz;
  // içeri alınır ve karşılaştırmada "Mükerrer" olur (taşıyıcının aynı gönderiyi iki kez yazması tam da aranan şeydir).
  // Aynı dosyanın yanlışlıkla yeniden yüklenmesine karşı: gönderilerin çoğu başka faturada varsa açık onay istenir.
  // DENETIM-2 01-B7: karşılaştırma veritabanının saklayacağı sayılarla (kenar 0,1 cm yukarı, kg 3, tutar 2 ondalık;
  // `atStoredPrecision`); yeniden karşılaştırma aynı sayıyı okur. CSV/XLSX ve PDF satırları buradan geçer.
  // 19-B1: 50.000 satırda ~0,7 sn; dilimlerle (sonuç aynı)
  const fresh = await mapSliced(parsed, atStoredPrecision);
  const trackings = [...new Set(parsed.map((l) => normalizeTracking(l.trackingNo)))];
  const overlapError = (o: TrackingOverlap) =>
    new AppError(
      409,
      'INVOICE_OVERLAP',
      o.otherInvoices?.length
        ? msg('invoice.overlapMany', { total: o.total, matched: o.matched, invoiceNo: [o.invoiceNo, ...o.otherInvoices.map((x) => x.invoiceNo)].join(', ') })
        : msg('invoice.overlap', { total: o.total, matched: o.matched, invoiceNo: o.invoiceNo }),
      { overlap: o },
    );
  const overlap = body.confirmOverlap ? null : await trackingOverlap(companyId, trackings);
  if (overlap) throw overlapError(overlap);

  hooks?.checkCancel?.();
  await hooks?.stage?.('importCompare');
  const invoiceDate = toDate(body.invoiceDate)!;
  const ctx = await buildContext(
    companyId,
    carrier.id,
    fresh.map((l) => normalizeTracking(l.trackingNo)),
    null,
    tariffId,
    false,
    undefined,
    fresh.map((l) => l.trackingNo),
  );
  await prefetchFx(fresh, ctx, invoiceDate, currency);
  // 19-B1: 2.000 satırlık dilimlerle (sonuç `compareAll` ile aynı)
  const results = await compareAllSliced(fresh, ctx, invoiceDate);

  // Satır, sonucunun hesaplandığı tarife sürümünü taşır; fatura aynı bağlamın dayanağını (`ctx.basis`) alır.
  hooks?.checkCancel?.();
  await hooks?.stage?.('importWrite');
  const compared = results.map(({ line, result, measurementId, tariffId, tariffRevisionId }) => ({
    companyId,
    ...parsedToLineData(line),
    ...resultToLineData(result, measurementId, tariffId, tariffRevisionId),
    parseFlags: rowFlags.get(line.rowIndex) ?? [],
    decision: 'OPEN' as const,
  }));

  const { invoice: created, stalePriors, movedMarks } = await prisma.$transaction(async (tx) => {
    // Üstteki denetimler kur beklemesinden önce: sayfa yenilenip dosya yeniden yüklenince iki istek ikisini de geçebilir.
    // Firma içinde içe aktarmalar burada sıraya girer; aynı kural kilit altında yeniden uygulanır.
    await lockImportsExclusive(tx, companyId);
    // R1: dosya işlemin sonuna kadar paylaşımlı kilitlenir. Bu arada vazgeçilen ya da temizlenen dosya
    // (`services/fileCleanup.ts`, FOR UPDATE) bu kilidi bekler; kilitten önce silindiyse ya da temizlendiyse 404.
    const held = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "File" WHERE "id" = ${file.id} AND "companyId" = ${companyId} AND "kind" = 'INVOICE_SOURCE' AND "purgedAt" IS NULL FOR SHARE`;
    if (!held.length) throw notFound(msg('invoice.uploadNotFound'));
    if (await invoiceNoTaken(tx, companyId, carrier.id, body.invoiceNo)) throw conflict('INVOICE_EXISTS', msg('invoice.exists'));
    // Çakışma onayı da kilit altında yeniden: aynı dosya iki sekmeden farklı numarayla aynı anda yüklenirse ikincisi burada durur.
    if (!body.confirmOverlap) {
      const raced = await trackingOverlap(companyId, trackings, tx);
      if (raced) throw overlapError(raced);
    }
    // Karşılaştırma kilitten önce yapıldı; bu arada aynı takip numaralarını taşıyan önceki faturalar değiştiyse (yeni fatura,
    // silme, başlık ya da takip no düzeltmesi) mükerrer sonucu eskidir: fatura yazıldıktan sonra yeniden karşılaştırılır.
    // 02-B1: ölçümler de kilitten önce okundu. Bu arada kaydedilen, düzeltilen, silinen ya da geri yüklenen ölçümün kendi
    // karşılaştırması bu faturayı göremedi (henüz yazılmadı). Ölçüm kümesi kilit altında aynı kapsamla yeniden okunur;
    // değişen ölçümlerin işareti bu işlemde yeniden yazılır (kalıcı), fatura yazıldıktan sonra yeniden karşılaştırılır.
    // Kilitten sonra değişen ölçümün araması bu kilidi paylaşımlı bekler ve yeni faturayı görür (`recompareForTracking`).
    const { stalePriors, movedMarks } = await importRecheck(
      tx,
      companyId,
      ctx,
      fresh.map((l) => normalizeTracking(l.trackingNo)),
      fresh.map((l) => l.trackingNo),
      false,
    );
    const lineData = compared;
    const totals = computeTotals(lineData.map((l) => ({ ...l, decision: 'OPEN' })));
    const inv = await writeInvoiceNo(() =>
      tx.invoice.create({
        data: {
          companyId,
          carrierId: carrier.id,
          tariffId,
          // hesabın dayanağı: satırların hesaplandığı sürüm ve o günkü firma ayarı (hesap ile kayıt aynı bağlamdan)
          tariffRevisionId: ctx.basis.tariffRevisionId,
          compareSettings: ctx.basis.compareSettings,
          invoiceNo: body.invoiceNo,
          invoiceDate,
          periodFrom: toDate(body.periodFrom),
          periodTo: toDate(body.periodTo),
          currency,
          sourceFileId: file.id,
          mapping: mappingToStore as Prisma.InputJsonValue,
          status: 'PROCESSED',
          totals,
          // Alınmayan satırların kaydı ve son hesap anı (motor bu istekte koştu).
          ...(importReport ? { importReport: importReport as unknown as Prisma.InputJsonValue } : {}),
          calculatedAt: new Date(),
        },
        include: { carrier: true, tariff: invoiceTariffSelect },
      }),
    );
    // toplu ekleme (createMany 5.000 satırda ~7 sn, 20.000 satırda ~70 sn sürüyordu)
    await insertInvoiceLines(tx, inv.id, lineData);
    await tx.file.update({ where: { id: file.id }, data: { invoiceId: inv.id } });
    // KALANLAR 6.5: PDF'in ham metni içe aktarmadan sonra gerekmez (PDF dosyası itiraz kanıtı olarak kalır)
    if (file.mime === 'application/pdf') await dropPdfPageTexts(tx, companyId, file.id);
    // K3: taşıyıcının kayıtlı eşlemesi bir taşıyıcı ayarıdır (PATCH /carriers ile aynı izin, `settings.manage`). İzni
    // olmayanın (ör. Muhasebe) isteği yok sayılır: fatura yine yüklenir, kayıtlı eşleme değişmez (eski sekme kutuyu
    // işaretli gönderse de yükleme düşmesin).
    if (body.saveMapping && file.mime !== 'application/pdf' && o.mayRemember) {
      // K36: ağırlık seçimi (`weightFormat`) dosya başınadır; faturanın kendi eşlemesinde kalır, taşıyıcınınkine yazılmaz
      await tx.carrier.update({ where: { id: carrier.id }, data: { defaultMapping: savedMappingOf(mappingToStore) as Prisma.InputJsonValue } });
    }
    // KALANLAR 6.18: arka plan işinde çit, faturanın işe bağlanması ve durdurma denetimi bu işlemde (geri alınırsa fatura da yok)
    // KALANLAR 6.18 (inceleme): denetim kaydı faturayla aynı işlemde (tam bir kez; yazımdan sonra süreç ölse de eksik kalmaz)
    await tx.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'invoice.import',
        entity: 'Invoice',
        entityId: inv.id,
        data: toAuditJson({
          invoiceNo: inv.invoiceNo,
          tariffId,
          lines: lineData.length,
          flaggedLines: lineData.filter((l) => l.parseFlags.length).length,
          skippedRows: importReport?.skippedCount ?? 0,
          ...(file.mime === 'application/pdf' ? { pdfUnverified, ...(pdfEdits ? { pdfEdits } : {}) } : {}),
        }),
      },
    });
    if (verification && verification.verdict !== 'ok') {
      await tx.auditLog.create({
        data: { companyId, userId, action: 'invoice.importUnverified', entity: 'Invoice', entityId: inv.id, data: toAuditJson(issuesPayload(verification)) },
      });
    }
    await hooks?.inWrite?.(tx, { invoiceId: inv.id, errors: parseErrors, recompare: movedMarks.length ? 'MEASUREMENT' : stalePriors ? 'DUPLICATE' : null });
    return { invoice: inv, stalePriors, movedMarks };
    // Binlerce satırlık faturada satır yazımı Prisma'nın varsayılan 5 sn'lik işlem süresini aşıyordu (500 hatası).
  }, { timeout: 120_000, maxWait: 10_000 }).catch(async (err: unknown) => {
    // Son güvence: kilit varken olmaz; yabancı anahtar düştüyse ve yükleme artık yoksa 500 değil, "yükleme bulunamadı".
    if (isForeignKeyViolation(err) && !(await prisma.file.findFirst({ where: { id: file.id, companyId, purgedAt: null }, select: { id: true } }))) {
      throw notFound(msg('invoice.uploadNotFound'));
    }
    throw err;
  });
  hooks?.committed?.();
  let invoice = created;
  // 06-B1: önizleme bitti; tablonun bellekteki kopyası bırakılır (yeniden karşılaştırma gerekirse dosyadan okur)
  tableCache.delete(file.id);
  if (stalePriors || movedMarks.length) {
    await settleImportRecompare(created.id, movedMarks.length ? 'MEASUREMENT' : 'DUPLICATE', o.log);
    invoice = await prisma.invoice.findFirstOrThrow({ where: { id: created.id }, include: { carrier: true, tariff: invoiceTariffSelect } });
  }
  // İşaretler kendi sırasında boşalır (satır içi kipte burada; hatası yüklemeyi düşürmez, işaret taramaya kalır).
  for (const m of movedMarks) {
    await queueMeasurementRecompare(companyId, m.id, m.pendingAt, o.log).catch((err: unknown) => o.log.warn({ err, measurementId: m.id }, 'import: measurement recompare failed; pending flag kept'));
  }
  await hooks?.settled?.();
  return { invoice, fileId: file.id, errors: parseErrors, importReport };
}

const toAuditJson = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;

/**
 * Yazım sonrası tazeleme: sabit dayanak, açık satırlar (yeni faturada hepsi açık); mükerrer sonucu ve (02-B1) içe aktarma
 * sürerken değişen ölçümler. Yeniden çalıştırmak güvenlidir (aynı dayanakla aynı sonuç): arka plan işinin yeniden denemesi
 * de bunu çağırır. Ölçüm nedeniyle düşerse işaretler yazılıdır (sıra ya da tarama tamamlar), hata yutulur.
 */
export async function settleImportRecompare(invoiceId: string, cause: 'MEASUREMENT' | 'DUPLICATE', log: { warn(o: unknown, m: string): void }): Promise<void> {
  try {
    await applyRecompare(invoiceId, { basis: 'pinned', scope: 'open', cause });
  } catch (err) {
    if (cause !== 'MEASUREMENT') throw err;
    log.warn({ err, invoiceId }, 'import: recompare for measurements changed during import failed; left to measurement queue');
  }
}

/** `INVOICE_IMPORT` işinin girdisi (`Job.input`, dışarı verilmez). Firma satırın sütunundan, kişi `createdById`. */
export type InvoiceImportInput = {
  v: 1;
  locale: Locale;
  body: InvoiceImportBody;
  /** başlatanın kayıtlı eşlemeyi yazma izni, başlatma anında */
  mayRemember: boolean;
  /** gövde özeti: süren işe yalnız aynı gövdeyle bağlanılır */
  digest: string;
};

/** Tekillik anahtarı: dosya başına aynı anda tek içe aktarma. */
export const invoiceImportDedupeKey = (fileId: string) => `import:${fileId}`;

/** İş sonucundaki satır hatası üst sınırı (sonuç `Job.result`'ta saklanır; tamamı faturanın `importReport`'unda sayılır). */
export const IMPORT_JOB_ERRORS_MAX = 200;

/**
 * İşin sonucu: bugünkü 201 gövdesi, `fileUrl` olmadan (imzalı bağlantı okuyan üyeye göre üretilir; panel kullanmaz) ve
 * satır hataları en çok `IMPORT_JOB_ERRORS_MAX`. Tutarlar fiyat izni olmayana `GET /jobs/:id`'de gitmez (`stripMoney`).
 */
export function invoiceImportJobResult(invoice: InvoiceImportOutcome['invoice'], errors: InvoiceImportOutcome['errors'], importReport: unknown) {
  return {
    invoice: serializeInvoiceHeader(invoice),
    errors: errors.slice(0, IMPORT_JOB_ERRORS_MAX),
    importReport: serializeImportReport(importReport, null),
  };
}

/** Yazılmış faturanın sonucu (yeniden deneme): fatura bugünkü hâliyle, kayıtlı yükleme raporuyla. Yoksa 404. */
export async function importedInvoiceResult(companyId: string, invoiceId: string, errors: InvoiceImportOutcome['errors']) {
  const inv = await prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, include: { carrier: true, tariff: invoiceTariffSelect } });
  if (!inv) throw notFound(msg('invoice.notFound'));
  return invoiceImportJobResult(inv, errors, inv.importReport);
}

/** İçe aktarma gövdesinin özeti (tek iş kuralı): aynı dosyanın süren işine yalnız aynı gövdeyle bağlanılır. */
function importDigest(body: InvoiceImportBody, mayRemember: boolean): string {
  return crypto.createHash('sha256').update(JSON.stringify({ body, mayRemember })).digest('hex').slice(0, 32);
}

/**
 * KALANLAR 6.18: CSV/Excel dosyasının veri satırı `INVOICE_IMPORT_QUEUE_ROWS`'u (varsayılan 5.000) aşıyorsa içe aktarma
 * arka plan işidir (`INVOICE_IMPORT`): `?async=1` → 202 `{ job, joined }`, yoksa 400 `ASYNC_REQUIRED` (hiçbir şey yazılmaz).
 * Küçük dosya, PDF ve hemen düşecek istek (taşıyıcı ya da dosya yok, eşleme eksik, fatura no kullanılıyor) için null: satır
 * içi yol bugünkü gibi çalışır, aynı hatayı hemen verir. Tarife seçiminin hatası (400/404) burada da hemen döner.
 * Tek iş: anahtar dosya başına (`import:<dosya>`); süren iş başka gövdeyle açılmışsa 409 `JOB_ACTIVE` (`details.job`).
 */
async function startLargeImport(req: FastifyRequest, body: InvoiceImportBody): Promise<JobStarted | null> {
  const { orgId: companyId, membershipId: userId } = req.auth;
  const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId }, select: { id: true } });
  const file = await prisma.file.findFirst({ where: { id: body.fileId, companyId, kind: 'INVOICE_SOURCE', purgedAt: null } });
  if (!carrier || !file || file.mime === 'application/pdf') return null;
  if (!body.mapping?.trackingNo || !body.mapping.netAmount) return null;
  if (await invoiceNoTaken(prisma, companyId, carrier.id, body.invoiceNo)) return null;
  await resolveInvoiceTariff(companyId, carrier.id, body.tariffId, toDate(body.invoiceDate));
  const table = await loadSourceTable(file);
  if (table.rows.length <= env.invoiceImportQueueRows) return null;
  requireAsync(req);
  const mayRemember = can(req, 'deciship.settings.manage');
  const digest = importDigest(body, mayRemember);
  const input: InvoiceImportInput = { v: 1, locale: req.locale, body, mayRemember, digest };
  const { jobId, joined } = await enqueueJob({
    companyId,
    createdById: userId,
    kind: 'INVOICE_IMPORT',
    dedupeKey: invoiceImportDedupeKey(file.id),
    ref: { type: 'File', id: file.id },
    label: (file.originalName ?? body.invoiceNo).slice(0, 200),
    input,
  });
  if (joined) {
    const row = await findJobLean(companyId, jobId);
    const active = row?.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>).digest : undefined;
    if (row && active !== digest) throw new AppError(409, 'JOB_ACTIVE', msg('job.active'), { job: await jobView(req, jobId) });
  }
  await kickJob(jobId, req.log);
  return { job: await jobView(req, jobId), joined };
}

export async function invoiceRoutes(app: FastifyInstance) {
  const upload = { onRequest: app.requirePermission('deciship.invoices.upload') };
  const view = { onRequest: app.requirePermission('deciship.invoices.view') };
  const reports = { onRequest: app.requirePermission('deciship.reports.view') };
  const decide = { onRequest: app.requirePermission('deciship.lines.decide') };
  /**
   * Y123: başlık düzeltmenin önce/sonra önizlemesi. Hesabı değiştiren başlık alanı (taşıyıcı, tarife, tarih, para birimi)
   * `PATCH /invoices/:id` (yükleme izni) ile önizlemenin token'ıyla kaydedilir; önizleme hiçbir şey yazmaz. Karar izni her
   * kipe girer; yalnız yükleme izni olan (Muhasebe) yalnız düzenleme penceresinin önizlemesine: `basis: 'pinned'` + `patch`,
   * `lineIds` yok (burada) ve en az bir başlık alanı gerçekten değişiyor (işleyicide, `resolveHeaderChange` sonrası). Öbür
   * kipler ("Yeni tarifeyle hesapla" vb.) ve uygulama (`/recalculate`) karar izninde kalır. Kararı verilmiş satırın sonucunu
   * değiştiren düzeltme karar izni ister (`PATCH /invoices/:id`, 403 DECIDED_LINES_CHANGE).
   */
  const editPreview = {
    onRequest: requireAny(app, ['deciship.lines.decide', 'deciship.invoices.upload']),
    preHandler: async (req: FastifyRequest) => {
      if (can(req, 'deciship.lines.decide')) return;
      const b = (req.body ?? {}) as { basis?: unknown; patch?: unknown; lineIds?: unknown };
      const headerEdit = b.basis === 'pinned' && typeof b.patch === 'object' && b.patch !== null && b.lineIds === undefined;
      if (!headerEdit) throw forbiddenFor(req);
    },
  };
  const exportData = { onRequest: app.requirePermission('deciship.data.export') };
  /**
   * Rapor dosyası (XLSX, PDF) tutar taşır ve `stripMoney` ikili dosyaya işlemez: dışa aktarma izninin yanında fiyat izni de
   * aranır. Hesap `data.export → prices.view` bağımlılığını zorunlu tutar (özel roller v1); bu ikinci kat, bağımlılığı
   * taşımayan jetonda (hata ya da eski kural) bile raporun fiyatsız kişiye gitmemesi içindir.
   */
  const exportPriced = {
    ...exportData,
    preHandler: async (req: FastifyRequest) => {
      if (!can(req, 'deciship.prices.view')) throw forbiddenFor(req);
    },
  };
  /** Örnek fatura yalnız kurulum sihirbazından yüklenir. */
  const setup = { onRequest: app.requirePermission('deciship.settings.manage') };
  registerAiErrorHeaders(app);
  registerFileErrorHeaders(app);

  app.post('/invoices/preview', upload, async (req, reply) => {
    if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg('err.fileNotSent'));
    const { orgId: companyId, membershipId: userId } = req.auth;
    let carrierId: string | undefined;
    let upload: { buffer: Buffer; fileName: string; mime: string } | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_INVOICE_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        if (part.fieldname === 'file') upload = { buffer: await part.toBuffer(), fileName: part.filename, mime: part.mimetype };
        else await part.toBuffer();
      } else if (part.fieldname === 'carrierId') {
        carrierId = String(part.value);
      }
    }
    if (!upload) throw badRequest('VALIDATION', msg('invoice.noFileSelected'));
    if (!upload.buffer.length) throw emptyFile();
    if (!carrierId) throw badRequest('VALIDATION', msg('carrier.notSelected'));
    const carrier = await prisma.carrier.findFirst({ where: { id: carrierId, companyId } });
    if (!carrier) throw notFound(msg('carrier.notFound'));
    // Y65: firmanın dosya alanı dolduysa dosya okunmadan ve saklanmadan 413 STORAGE_QUOTA_EXCEEDED.
    await assertStorageQuota(companyId, upload.buffer.length);

    const format = detectFormat(upload.fileName, new Uint8Array(upload.buffer));
    if (format === 'unknown') throw badRequest('UNSUPPORTED_FORMAT', invoiceFileMessage(unsupportedFileError(upload.fileName, new Uint8Array(upload.buffer)).code, currentLocale()));
    // Anahtar yoksa PDF okunamaz: dosyayı saklamadan (sahipsiz dosya bırakmadan) hemen bildir.
    if (format === 'pdf' && !aiEnabled()) throw aiDisabled(msg('ai.disabled.pdfInvoice'));
    // Y83: PDF okuma yalnız arka planda; `?async=1` yoksa dosya okunmadan ve saklanmadan 400 ASYNC_REQUIRED.
    if (format === 'pdf') requireAsync(req);
    const mimeByFormat = { csv: 'text/csv', xlsx: XLSX_MIME, pdf: 'application/pdf' } as const;
    // dosya önce okunur (dosya havuzu), sonra saklanır: sınır (413), karmaşık dosya (422), meşgul havuz (503) ya da
    // okunamayan dosyada sahipsiz `File` kaydı ve dosya kalmaz. PDF'te metin, yapay zekâya gitmeden (ücretlenmeden) okunur.
    let pageTexts: string[] = [];
    let table: Table | null = null;
    if (format === 'pdf') {
      pageTexts = await pdfPageTexts(upload.buffer, { companyId, connection: req.raw.socket });
    } else {
      try {
        table = await readTable(upload.fileName, new Uint8Array(upload.buffer), { companyId, connection: req.raw.socket });
      } catch (e) {
        throw readFailure(e);
      }
    }
    // PDF → okuma kuyruktaki iş (`INVOICE_PDF_READ`), 202 `{ job, joined }`.
    // Aynı dosya (bayt bayt) aynı dilde zaten okunuyorsa süren işe bağlanılır: ikinci dosya ve ikinci iş açılmaz.
    // Kota ve kişi başı dakika sınırı iş açılmadan denetlenir (429; dosya saklanmaz).
    let dedupeKey: string | null = null;
    if (format === 'pdf') {
      // 05-B10: taşıyıcı da anahtarda (istem taşıyıcının tarife ek ücret kodlarını taşır)
      dedupeKey = invoicePdfDedupeKey(sha256(upload.buffer), req.locale, freshQuery(req), carrier.id);
      const active = await findActiveJob(companyId, 'INVOICE_PDF_READ', dedupeKey);
      if (active) {
        // Y91: süren işin önizleme dosyası bu üyenin de önizlemesi; yükleyenin vazgeçmesi onu silmesin.
        await sharePreviewFile(companyId, active, userId);
        return reply.status(202).send({ job: await jobView(req, active), joined: true });
      }
      const ctx = aiContext(req, 'INVOICE_PDF');
      await assertAiQuota(ctx);
      assertAiRate(ctx);
    }

    const stored = await storeBuffer(companyId, upload.buffer, extFor(mimeByFormat[format], upload.fileName));
    // 06-B4: kayıt yazılamazsa (veritabanı hatası) dosya diskte sahipsiz kalmaz
    const file = await prisma.file
      .create({
        data: {
          companyId,
          kind: 'INVOICE_SOURCE',
          mime: mimeByFormat[format],
          size: stored.size,
          path: stored.path,
          sha256: stored.sha256,
          originalName: upload.fileName,
          createdById: userId,
          // PDF: sayfa metni şimdiden (işin ve içe aktarmanın ikinci kez okumaması için); takip no'suz satırlar okumadan sonra.
          ...(format === 'pdf' ? { preview: pdfPreviewValue({ pageTexts }) as Prisma.InputJsonValue } : {}),
        },
      })
      .catch(async (e: unknown) => {
        await discardStored(stored.path, req.log);
        throw e;
      });

    if (format === 'pdf' && dedupeKey) {
      const input: InvoicePdfInput = { v: 1, locale: req.locale, aiLimits: { ...(req.auth.subscription?.limits ?? {}) }, fresh: freshQuery(req), fileId: file.id, carrierId: carrier.id };
      const started = await enqueueJob({
        companyId,
        createdById: userId,
        kind: 'INVOICE_PDF_READ',
        dedupeKey,
        ref: { type: 'File', id: file.id },
        label: upload.fileName.slice(0, 200),
        input,
      });
      if (started.joined) {
        // Aynı anda gelen iki yükleme: diğeri kazandı; bu isteğin dosyası boşta kalmasın.
        await discardPreviewFile(companyId, file.id, { log: req.log });
        await sharePreviewFile(companyId, started.jobId, userId);
      } else {
        await kickJob(started.jobId, req.log);
      }
      return reply.status(202).send({ job: await jobView(req, started.jobId), joined: started.joined });
    }

    if (!table) throw readFailure(null);
    tableCache.set(file.id, table);
    const divisor = await divisorFor(companyId, carrier);
    const det = await deterministicMapping(table, carrier, divisor);
    return {
      fileId: file.id,
      format,
      headers: table.headers,
      sampleRows: table.rows.slice(0, 10),
      rowCount: previewRowCount(table, det.mapping, det.parsed),
      suggestedMapping: det.mapping,
      mappingSource: det.source,
      fieldSources: sourcesFor(det.mapping, det.source),
      confidence: det.confidence,
      missing: det.missing,
      guessedMeta: guessMeta(table, det.mapping, upload.fileName, carrier.code, await firmCurrency(companyId)),
      diagnostics: slimDiagnostics(det.diagnostics, det.notices),
      suggestAi: shouldSuggestAi(det.diagnostics.verification, det.source, det.hasPreset),
      aiAvailable: aiEnabled(),
      divisor,
      columnFill: columnFillCounts(table),
      overlap: await invoiceOverlap(companyId, table, det.mapping, det.parsed),
    };
  });

  /** SPEC §11.1: eşleme değişince okuma kontrolünü yeniden çalıştırır (dosya yeniden yüklenmez). */
  app.post('/invoices/preview/verify', upload, async (req) => {
    const body = verifyBody.parse(req.body);
    const { orgId: companyId } = req.auth;
    const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId } });
    if (!carrier) throw notFound(msg('carrier.notFound'));
    const file = await loadPreviewFile(companyId, body.fileId);
    const table = await loadSourceTable(file);
    const divisor = await divisorFor(companyId, carrier);
    const { parsed, diagnostics: d } = await diagnosticsOf(table, body.mapping as ColumnMapping, divisor);
    return {
      diagnostics: slimDiagnostics(d),
      suggestAi: shouldSuggestAi(d.verification, 'user', true),
      // Tarih sırası seçilince ekrandaki fatura tarihi de yeni okumayla güncellenir.
      guessedMeta: guessInvoiceMeta(table, body.mapping as ColumnMapping),
      overlap: await invoiceOverlap(companyId, table, body.mapping as ColumnMapping, parsed),
    };
  });

  /** SPEC §11.2: yapay zekâ ile sütun eşleme + deterministik birleştirme + okuma kontrolü. */
  app.post('/invoices/preview/ai-mapping', upload, async (req) => {
    const body = aiMappingBody.parse(req.body);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId } });
    if (!carrier) throw notFound(msg('carrier.notFound'));
    const file = await loadPreviewFile(companyId, body.fileId);
    const table = await loadSourceTable(file);
    const divisor = await divisorFor(companyId, carrier);
    let base: ColumnMapping;
    let baseSources: FieldSources;
    if (body.mapping) {
      base = body.mapping as ColumnMapping;
      baseSources = { ...sourcesFor(base, 'user'), ...(body.sources as FieldSources | undefined) };
    } else {
      const det = await deterministicMapping(table, carrier, divisor);
      base = det.mapping;
      baseSources = sourcesFor(base, det.source);
    }
    const ai = await suggestMappingWithAi(table, { code: carrier.code, name: carrier.name }, aiContext(req, 'INVOICE_MAPPING', { type: 'File', id: file.id }));
    const merged = mergeAiMapping(table, base, baseSources, ai.input, { divisor });
    const { parsed: mergedParsed, diagnostics } = await diagnosticsOf(table, merged.mapping, divisor);
    await audit(companyId, userId, 'invoice.aiMapping', 'File', file.id, {
      carrierId: carrier.id,
      usage: ai.usage,
      aiUsageId: ai.usageId,
      aiCached: ai.cached,
      dropped: ai.dropped,
      decisions: merged.decisions,
      verdict: diagnostics.verification.verdict,
    });
    return {
      mapping: merged.mapping,
      fieldSources: merged.sources,
      aiConfidence: ai.perField,
      decisions: merged.decisions,
      dropped: ai.dropped,
      diagnostics: slimDiagnostics(diagnostics),
      suggestAi: false,
      overlap: await invoiceOverlap(companyId, table, merged.mapping, mergedParsed),
      guessedMeta: guessMeta(table, merged.mapping, file.originalName ?? '', carrier.code, await firmCurrency(companyId)),
      usage: ai.usage,
    };
  });

  /**
   * Vazgeçilen önizlemenin dosyası. 204: dosya firmada (silindi ya da faturaya bağlı / süren
   * işi var diye korundu); 404 `file.notFound`: firmada böyle önizleme yok (başka firmanın, hiç olmayan ya da zaten silinmiş).
   * Silme ve bütün denetimler `services/fileCleanup.ts` `discardPreviewFile` içinde (firma bağlamı, satır kilidi).
   */
  app.delete('/invoices/preview/:fileId', upload, async (req, reply) => {
    const { fileId } = z.object({ fileId: z.string().min(1).max(200) }).parse(req.params);
    const companyId = req.auth.orgId;
    // Kişiye bağlı (R1): yalnız isteği yapan üyenin yüklediği ya da süren okumasına bağlanıp paylaştığı (Y91, `holders`)
    // önizleme. Başkasınınki 404 (yokla ayırt edilmez).
    const me = req.auth.membershipId;
    const file = await prisma.file.findFirst({
      where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', OR: [{ createdById: me }, { holders: { has: me } }] },
      select: { id: true },
    });
    if (!file) throw notFound(msg('file.notFound'));
    // Bağlı, süren işi olan, temizlenmiş ya da başka üyenin hâlâ tuttuğu dosya korunur (false); yanıt yine 204.
    await discardPreviewFile(companyId, file.id, { releasedBy: me, log: req.log });
    // 06-B1: vazgeçilen önizlemenin tablosu bellekte kalmasın (başka üye hâlâ tutuyorsa gerekince dosyadan yeniden okunur)
    tableCache.delete(file.id);
    return reply.status(204).send();
  });

  /**
   * Y80-E2 (sürdürme bandı): isteği yapan üyenin okunmuş ya da okunmakta olan, içe aktarılmamış PDF önizlemeleri
   * (`services/fileCleanup.ts` `listResumablePreviews`). Sonuç `GET /jobs/:jobId` ile alınır. Salt okunur.
   */
  app.get('/invoices/preview/resumable', upload, async (req) => {
    const items = await listResumablePreviews(req.auth.orgId, req.auth.membershipId);
    return { items: items.map((i) => ({ ...i, updatedAt: i.updatedAt.toISOString() })) };
  });

  /**
   * Y95: açık önizlemede çalışan kullanıcının dosyası bakımın 24 saatinde silinmesin (`keepPreviewFile`). 204: tazelendi;
   * 404 `invoice.uploadNotFound`: üyenin tuttuğu böyle önizleme yok (silinmiş, faturaya bağlanmış, başkasının).
   */
  app.post('/invoices/preview/:fileId/keep', upload, async (req, reply) => {
    const { fileId } = z.object({ fileId: z.string().min(1).max(200) }).parse(req.params);
    if (!(await keepPreviewFile(req.auth.orgId, fileId, req.auth.membershipId))) throw notFound(msg('invoice.uploadNotFound'));
    return reply.status(204).send();
  });

  app.post('/invoices', upload, async (req, reply) => {
    const body = importBody.parse(req.body);
    const { orgId: companyId, membershipId: userId } = req.auth;
    // KALANLAR 6.18: büyük CSV/Excel arka planda (`?async=1` → 202 `{ job, joined }`); küçük dosya bugünkü gibi hemen 201
    const queued = await startLargeImport(req, body);
    if (queued) return reply.status(202).send(queued);
    const r = await runInvoiceImport({
      companyId,
      userId,
      body,
      mayRemember: can(req, 'deciship.settings.manage'),
      log: req.log,
      connection: req.raw.socket,
    });
    return reply.status(201).send({
      invoice: serializeInvoiceHeader(r.invoice, { fileUrl: fileUrl(req, r.fileId, companyId) }),
      errors: r.errors,
      importReport: serializeImportReport(r.importReport, req),
    });
  });

  /**
   * Kurulum sihirbazı: örnek fatura. Eşleme ekranı yok — sütunlar kalıp/kayıtlı eşlemeyle (gerekirse yapay zekâyla),
   * PDF yapay zekâyla okunur; fatura no/tarih/para birimi dosyadan tahmin edilir. `isSample` fatura listede, Pano'da,
   * ölçümlerde ve mükerrer kontrolünde yok sayılır; yalnız tarife uyumu ve PDF tablo önerisi için kullanılır.
   */
  app.post('/invoices/samples', setup, async (req, reply) => {
    const { orgId: companyId, membershipId: userId } = req.auth;
    // Y80-E3: PDF örnek fatura arka planda okunur (panel önce `POST /invoices/preview?async=1`, sonra burası JSON ile):
    // satırlar işin sunucuda yazdığı sonuçtan alınır (istemciden gelmez), dosya önizlemenin kendisidir (yeniden saklanmaz).
    if (!req.isMultipart() && req.body && typeof req.body === 'object') return importSampleFromPreview(req, reply, sampleFromPreviewBody.parse(req.body));
    if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg('err.fileNotSent'));
    let carrierId: string | undefined;
    let upload: { buffer: Buffer; fileName: string; mime: string } | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_INVOICE_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        if (part.fieldname === 'file') upload = { buffer: await part.toBuffer(), fileName: part.filename, mime: part.mimetype };
        else await part.toBuffer();
      } else if (part.fieldname === 'carrierId') {
        carrierId = String(part.value);
      }
    }
    if (!upload) throw badRequest('VALIDATION', msg('invoice.noFileSelected'));
    if (!upload.buffer.length) throw emptyFile();
    if (!carrierId) throw badRequest('VALIDATION', msg('carrier.notSelected'));
    const carrier = await prisma.carrier.findFirst({ where: { id: carrierId, companyId } });
    if (!carrier) throw notFound(msg('carrier.notFound'));
    // Y65: örnek fatura da fatura dosyasıdır (saklanır, kotaya sayılır).
    await assertStorageQuota(companyId, upload.buffer.length);
    const format = detectFormat(upload.fileName, new Uint8Array(upload.buffer));
    if (format === 'unknown') throw badRequest('UNSUPPORTED_FORMAT', invoiceFileMessage(unsupportedFileError(upload.fileName, new Uint8Array(upload.buffer)).code, currentLocale()));
    if (format === 'pdf' && !aiEnabled()) throw aiDisabled(msg('ai.disabled.pdfInvoice'));
    const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
    const divisor = await divisorFor(companyId, carrier);

    let parsed: ParsedInvoiceLine[];
    let meta: { invoiceNo?: string; invoiceDate?: string; currency?: string };
    let mappingToStore: unknown;
    if (format === 'pdf') {
      // sayfa sınırı yapay zekâdan önce (ücretlenmeden); metin lb çift çevirme denetiminde de kullanılır (Y20)
      const pageTexts = await pdfPageTexts(upload.buffer, { companyId, connection: req.raw.socket });
      // büyük örnek PDF de sayfa gruplarıyla (Ek E1)
      const ai = (await readInvoicePdfAll(upload.buffer, pageTexts, aiContext(req, 'INVOICE_PDF'))).data;
      parsed = pdfLinesToParsed(ai, { pageTexts });
      meta = { invoiceNo: ai.invoiceNo ?? undefined, invoiceDate: ai.invoiceDate ?? undefined, currency: ai.currency ?? undefined };
      mappingToStore = { source: 'ai', sample: true };
    } else {
      let table: Table;
      try {
        table = await readTable(upload.fileName, new Uint8Array(upload.buffer), { companyId, connection: req.raw.socket });
      } catch (e) {
        throw readFailure(e);
      }
      let mapping = (await deterministicMapping(table, carrier, divisor)).mapping;
      let result = parseRows(table, mapping, currentLocale());
      // kalıp tutmadıysa (zorunlu sütun yok ya da satır okunamadı) yapay zekâyla eşle
      if ((!mapping.trackingNo || !mapping.netAmount || !result.lines.length) && aiEnabled()) {
        const ai = await suggestMappingWithAi(table, { code: carrier.code, name: carrier.name }, aiContext(req, 'INVOICE_MAPPING'));
        mapping = mergeAiMapping(table, mapping, sourcesFor(mapping, 'preset'), ai.input, { divisor }).mapping;
        result = parseRows(table, mapping, currentLocale());
      }
      if (!mapping.trackingNo || !mapping.netAmount || !result.lines.length) {
        throw badRequest(
          'MAPPING_INCOMPLETE',
          msg('invoice.sampleColumnsUnknown'),
        );
      }
      parsed = result.lines;
      meta = guessMeta(table, mapping, upload.fileName, carrier.code, readSettings(company.settings).currency);
      mappingToStore = { ...mapping, sample: true };
    }
    return writeSample(reply, {
      companyId,
      userId,
      carrierId: carrier.id,
      firmCurrency: readSettings(company.settings).currency,
      parsed,
      meta,
      mappingToStore,
      format,
      fileName: upload.fileName,
      source: { kind: 'upload', buffer: upload.buffer },
    });
  });

  /** Y80-E3: okunmuş PDF önizlemesinden örnek fatura (`POST /invoices/samples` JSON gövdesi). */
  async function importSampleFromPreview(req: FastifyRequest, reply: FastifyReply, body: z.infer<typeof sampleFromPreviewBody>) {
    const { orgId: companyId, membershipId: userId } = req.auth;
    const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId } });
    if (!carrier) throw notFound(msg('carrier.notFound'));
    // Yalnız bu üyenin tuttuğu, faturaya bağlanmamış PDF önizlemesi (vazgeçme ucuyla aynı sahiplik kuralı).
    const file = await prisma.file.findFirst({
      where: {
        id: body.fileId,
        companyId,
        kind: 'INVOICE_SOURCE',
        mime: 'application/pdf',
        invoiceId: null,
        purgedAt: null,
        OR: [{ createdById: userId, holders: { isEmpty: true } }, { holders: { has: userId } }],
      },
      select: { id: true, originalName: true, holders: true },
    });
    if (!file) throw notFound(msg('invoice.uploadNotFound'));
    // Aynı PDF'in okumasını başka üye de paylaşıyorsa (Y91) dosya onun önizlemesidir: örnek faturaya bağlanmaz.
    if (file.holders.some((h) => h !== userId)) throw conflict('PREVIEW_SHARED', msg('invoice.samplePreviewShared'));
    // Satırlar istemciden değil, okuma işinin sunucuda yazdığı sonuçtan (`InvoicePdfPreview.aiLines`).
    const job = await prisma.job.findFirst({
      where: { companyId, kind: 'INVOICE_PDF_READ', refType: 'File', refId: file.id, status: 'SUCCEEDED' },
      orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }],
      select: { result: true },
    });
    const result = job?.result as { aiLines?: ParsedInvoiceLine[]; guessedMeta?: { invoiceNo?: string; invoiceDate?: string; currency?: string } } | null | undefined;
    if (!result || !Array.isArray(result.aiLines)) throw notFound(msg('invoice.uploadNotFound'));
    return writeSample(reply, {
      companyId,
      userId,
      carrierId: carrier.id,
      firmCurrency: await firmCurrency(companyId),
      parsed: result.aiLines,
      meta: { invoiceNo: result.guessedMeta?.invoiceNo, invoiceDate: result.guessedMeta?.invoiceDate, currency: result.guessedMeta?.currency },
      mappingToStore: { source: 'ai', sample: true },
      format: 'pdf',
      fileName: file.originalName ?? 'invoice.pdf',
      source: { kind: 'preview', fileId: file.id },
    });
  }

  /**
   * Örnek faturanın ortak kuyruğu: tekrar eden satırlar bir kez, karşılaştırma, fatura + satırlar tek işlemde. Kaynak:
   * yüklenen bayt (saklanır, yeni `File`) ya da okunmuş önizleme (Y80-E3: satır kilitlenir, faturaya bağlanır; bu arada
   * vazgeçildiyse ya da temizlendiyse 404).
   */
  async function writeSample(
    reply: FastifyReply,
    o: {
      companyId: string;
      userId: string;
      carrierId: string;
      firmCurrency: string;
      parsed: ParsedInvoiceLine[];
      meta: { invoiceNo?: string; invoiceDate?: string; currency?: string };
      mappingToStore: unknown;
      format: 'csv' | 'xlsx' | 'pdf';
      fileName: string;
      source: { kind: 'upload'; buffer: Buffer } | { kind: 'preview'; fileId: string };
    },
  ) {
    const { companyId, userId, meta, mappingToStore, format, source } = o;
    // dosya içindeki tekrar eden satırlar bir kez
    const seen = new Set<string>();
    // 01-B7: veritabanı hassasiyetinde (içe aktarmadaki gibi)
    const parsed = o.parsed.filter((l) => (seen.has(l.rawHash) ? false : (seen.add(l.rawHash), true))).map(atStoredPrecision);
    if (!parsed.length) throw badRequest('NO_LINES', msg('invoice.sampleNoLines'));
    const carrier = { id: o.carrierId };

    const mimeByFormat = { csv: 'text/csv', xlsx: XLSX_MIME, pdf: 'application/pdf' } as const;
    // Dosyada fatura tarihi yoksa satırların en geç gönderim tarihi (kur ve tarife geçerliliği o güne göre); o da yoksa bugün.
    // Y6: "bugün" firmanın saat dilimindeki gündür (UTC günü İstanbul'da 00–03 arası bir gün geri kalırdı).
    const latestShip = parsed.map((l) => l.shipDate).filter((d): d is string => !!d && toDate(d) != null).sort().pop();
    const invoiceDate =
      toDate(meta.invoiceDate) ??
      toDate(latestShip) ??
      toDate(zonedDate(new Date(), readSettings((await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } })).settings).timeZone))!;
    const currency = (meta.currency && /^[A-Z]{3}$/i.test(meta.currency) ? meta.currency : o.firmCurrency).toUpperCase();
    const ctx = await buildContext(
      companyId,
      carrier.id,
      parsed.map((l) => normalizeTracking(l.trackingNo)),
      null,
      null,
      true,
      undefined,
      parsed.map((l) => l.trackingNo),
    );
    await prefetchFx(parsed, ctx, invoiceDate, currency);
    const results = compareAll(parsed, ctx, invoiceDate);
    const lineData = results.map(({ line, result, measurementId, tariffId, tariffRevisionId }) => ({
      companyId,
      ...parsedToLineData(line),
      ...resultToLineData(result, measurementId, tariffId, tariffRevisionId),
      parseFlags: [] as string[],
      decision: 'OPEN' as const,
    }));
    const totals = computeTotals(lineData);
    // 06-B4: dosya hesaptan sonra, işlemden hemen önce saklanır; işlem düşerse (kayıt yazılamadı, 404) dosya silinir
    const stored = source.kind === 'upload' ? await storeBuffer(companyId, source.buffer, extFor(mimeByFormat[format], o.fileName)) : null;
    const { inv: written, movedMarks } = await prisma.$transaction(
      async (tx) => {
        // 02-B1 (bağımsız inceleme): örnek fatura da ölçümlerle eşleşir; içe aktarmayla aynı kilit ve yeniden okuma (örnek
        // mükerrer saymaz: yalnız ölçümler).
        await lockImportsExclusive(tx, companyId);
        const { movedMarks } = await importRecheck(tx, companyId, ctx, [], parsed.map((l) => l.trackingNo), true);
        let file: { id: string };
        if (stored) {
          file = await tx.file.create({
            data: {
              companyId,
              kind: 'INVOICE_SOURCE',
              mime: mimeByFormat[format],
              size: stored.size,
              path: stored.path,
              sha256: stored.sha256,
              originalName: o.fileName,
              createdById: userId,
            },
          });
        } else {
          // Önizleme satırı işlem sonuna dek kilitlenir: vazgeçme ve bakım temizliği (`fileCleanup.ts`, FOR UPDATE) sıraya
          // girer; kilitten önce silindiyse, temizlendiyse ya da bu arada faturaya bağlandıysa hiçbir şey yazılmaz.
          const fileId = (source as { fileId: string }).fileId;
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "File" WHERE "id" = ${fileId} AND "companyId" = ${companyId} AND "kind" = 'INVOICE_SOURCE'
              AND "invoiceId" IS NULL AND "purgedAt" IS NULL FOR UPDATE`;
          if (!held.length || (await tx.invoice.count({ where: { companyId, sourceFileId: fileId } })) > 0) throw notFound(msg('invoice.uploadNotFound'));
          file = { id: fileId };
        }
        const inv = await tx.invoice.create({
          data: {
            companyId,
            carrierId: carrier.id,
            tariffRevisionId: ctx.basis.tariffRevisionId,
            compareSettings: ctx.basis.compareSettings,
            invoiceNo: normInvoiceNo(meta.invoiceNo ?? '') || o.fileName.replace(/\.[^.]+$/, '').slice(0, 100) || msg('invoice.sampleDefaultNo'),
            invoiceDate,
            currency,
            sourceFileId: file.id,
            mapping: mappingToStore as Prisma.InputJsonValue,
            status: 'PROCESSED',
            totals,
            calculatedAt: new Date(),
            isSample: true,
          },
          include: { carrier: true, tariff: invoiceTariffSelect },
        });
        await insertInvoiceLines(tx, inv.id, lineData);
        await tx.file.update({ where: { id: file.id }, data: { invoiceId: inv.id } });
        // KALANLAR 6.5: okunmuş PDF önizlemesinin ham metni silinir (yüklenen bayt yolunda kayıt yok)
        if (format === 'pdf') await dropPdfPageTexts(tx, companyId, file.id);
        return { inv, movedMarks };
      },
      { timeout: 120_000, maxWait: 10_000 },
    ).catch(async (e: unknown) => {
      if (stored) await discardStored(stored.path, reply.log);
      throw e;
    });
    let invoice = written;
    if (movedMarks.length) {
      // bu arada değişen ölçümler: içe aktarmadaki gibi hemen yeniden karşılaştırılır; düşerse işaretler sırada tamamlanır
      try {
        await applyRecompare(written.id, { basis: 'pinned', scope: 'open', cause: 'MEASUREMENT' });
        invoice = await prisma.invoice.findFirstOrThrow({ where: { id: written.id }, include: { carrier: true, tariff: invoiceTariffSelect } });
      } catch (err) {
        reply.log.warn({ err, invoiceId: written.id }, 'sample import: recompare for measurements changed during import failed; left to measurement queue');
      }
      for (const m of movedMarks) {
        await queueMeasurementRecompare(companyId, m.id, m.pendingAt, reply.log).catch((err: unknown) => reply.log.warn({ err, measurementId: m.id }, 'sample import: measurement recompare failed; pending flag kept'));
      }
    }
    await audit(companyId, userId, 'invoice.sampleImport', 'Invoice', invoice.id, { lines: lineData.length, format, ...(source.kind === 'preview' ? { fromPreview: true } : {}) });
    return reply.status(201).send({ invoice: serializeInvoiceHeader(invoice, {}), lines: lineData.length });
  }

  app.get('/invoices', view, limited(async (req) => {
    const q = listQuery.parse(req.query);
    const { orgId: companyId } = req.auth;
    // örnek faturalar (kurulum) listede yok
    const where: Prisma.InvoiceWhereInput = { companyId, deletedAt: null, isSample: false };
    if (q.carrierId) where.carrierId = q.carrierId;
    const from = parseDateInput(q.from);
    const to = parseDateInput(q.to);
    if (from || to) where.invoiceDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    // 08-B9: arama. Fatura no parça eşleşir; takip no normalleştirilip tam eşleşir (satır dizininden).
    if (q.q) {
      const tracking = normalizeTracking(q.q);
      // `%` ve `_` kaçışlanır (Prisma `contains` kaçışlamaz: bulkDecide.ts `likeEscape`); takip no tam eşleşir (LIKE yok).
      const or: Prisma.InvoiceWhereInput[] = [{ invoiceNo: { contains: likeEscape(q.q), mode: 'insensitive' } }];
      if (tracking.length >= TRACKING_SEARCH_MIN) or.push({ lines: { some: { companyId, trackingNo: tracking } } });
      where.OR = or;
    }
    // Durum: kayıtlı toplamdan (satırlarla aynı işlemde yazılır). "İtiraz bekliyor" = fazla ödeme var, etkin tur yok.
    if (q.status === 'DIFF') where.totals = { path: ['diff'], gt: 0 };
    else if (q.status === 'UNMATCHED') where.totals = { path: ['unmatched'], gt: 0 };
    else if (q.status === 'TO_DISPUTE') {
      where.totals = { path: ['overchargeTotal'], gt: 0 };
      where.disputes = { none: activeRoundWhere };
    }
    const [total, rows] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: { carrier: { select: { id: true, name: true, code: true } } },
        orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const disputes = await invoiceDisputeSummaries(companyId, rows.map((i) => i.id));
    return paged(
      rows.map((i) => ({
        id: i.id,
        invoiceNo: i.invoiceNo,
        invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
        currency: i.currency,
        carrier: i.carrier,
        totals: i.totals,
        createdAt: i.createdAt,
        disputeStatus: disputes.get(i.id)?.status ?? 'NONE',
        disputeSums: disputes.get(i.id)?.sums ?? null,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }, 'read'));

  /** `o.recalcFailed`: çağıran biliyorsa (az önce temizlendi) yeniden okunmaz. */
  async function invoiceDetail(req: FastifyRequest, inv: Awaited<ReturnType<typeof loadInvoice>>, o: { recalcFailed?: boolean } = {}) {
    const lineFacts = await tariffFacts(inv.id);
    return serializeInvoiceHeader(inv, {
      tariffsUsed: lineFacts.tariffsUsed,
      /** Karşılaştırılan satırların çoğunda fiyat farkı var: tarife yanlış ya da eski olabilir. */
      tariffSuspect: lineFacts.tariffSuspect,
      fileUrl: fileUrl(req, inv.sourceFileId, inv.companyId),
      fileName: inv.sourceFile.originalName,
      fileFormat: inv.sourceFile.mime === 'application/pdf' ? 'pdf' : inv.sourceFile.mime === 'text/csv' ? 'csv' : 'xlsx',
      dispute: await invoiceDispute(inv.companyId, inv),
      /** Hesabın dayanağı bugünkü tarife ve ayara göre nerede. */
      basis: await invoiceBasisView(inv.companyId, inv),
      /** Yüklemede faturaya alınmayan satırlar (eski faturada null); tutarlar fiyat iznine bağlı. */
      importReport: serializeImportReport(inv.importReport, req),
      /** K37: arka plandaki yeniden hesap 5 kez düştü (yalnız doluyken; eylem "Yeniden karşılaştır"). */
      ...((o.recalcFailed ?? (await failedRecalcInvoices(inv.companyId, [inv.id])).has(inv.id)) ? { recalcFailed: true } : {}),
    });
  }

  /**
   * Başlık düzeltmesinin çözümü (PATCH ve önizlemedeki `patch` aynı kuralı kullanır): yalnız gerçekten değişen alanlar.
   * Tarife taşıyıcıya bağlıdır: taşıyıcı değişince (yeni tarife verilmediyse) yeni taşıyıcının varsayılanı seçilir.
   */
  async function resolveHeaderChange(
    inv: Pick<Awaited<ReturnType<typeof loadInvoiceRow>>, 'id' | 'companyId' | 'carrierId' | 'tariffId' | 'invoiceDate' | 'currency'>,
    body: { carrierId?: string; tariffId?: string | null; invoiceDate?: string; currency?: string },
  ) {
    const companyId = inv.companyId;
    const patch: InvoicePatch = {};
    if (body.carrierId !== undefined && body.carrierId !== inv.carrierId) {
      const carrier = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId } });
      if (!carrier) throw notFound(msg('carrier.notFound'));
      patch.carrierId = carrier.id;
    }
    const nextCarrierId = patch.carrierId ?? inv.carrierId;
    // K2: tarife verilmediyse faturanın (düzeltilen ya da bugünkü) gününde geçerli olan, yoksa varsayılan
    const nextDate = body.invoiceDate !== undefined ? toDate(body.invoiceDate) : inv.invoiceDate;
    const nextTariffId =
      body.tariffId !== undefined || patch.carrierId !== undefined ? await resolveInvoiceTariff(companyId, nextCarrierId, body.tariffId, nextDate) : inv.tariffId;
    if (nextTariffId !== inv.tariffId) patch.tariffId = nextTariffId;
    if (body.invoiceDate !== undefined) {
      const d = toDate(body.invoiceDate)!;
      if (+d !== +inv.invoiceDate) patch.invoiceDate = d;
    }
    if (body.currency !== undefined && body.currency !== inv.currency) {
      await assertLinesAllowCurrency(inv.id, companyId, body.currency);
      patch.currency = body.currency;
    }
    return patch;
  }

  /**
   * DENETIM-2 01-B8: satırlarda kendi para birimi yazılıysa ve yeni fatura para birimiyle çelişiyorsa başlık değişmez
   * (toplamlar, Pano ve itiraz metni satırları faturanın para birimiyle toplar). Satırlar da değiştirilmez: dosyada yazanı
   * sessizce ezmek geri alınamazdı; yanlış okunan para birimi doğru eşlemeyle yeniden yüklenir. 409 CURRENCY_CONFLICT.
   * Para birimi yazılı olmayan satırlar faturanınkini alır, engel değildir.
   */
  async function assertLinesAllowCurrency(invoiceId: string, companyId: string, next: string) {
    const groups = await prisma.invoiceLine.groupBy({ by: ['currency'], where: { invoiceId, companyId, currency: { not: null } }, _count: { _all: true } });
    const target = next.trim().toUpperCase();
    const other = new Map<string, number>();
    for (const g of groups) {
      const c = g.currency?.trim().toUpperCase();
      if (c && c !== target) other.set(c, (other.get(c) ?? 0) + g._count._all);
    }
    if (!other.size) return;
    const count = [...other.values()].reduce((a, b) => a + b, 0);
    throw conflict('CURRENCY_CONFLICT', msg('invoice.currencyConflict', { count, currencies: [...other.keys()].join(', '), next: target }));
  }

  app.get('/invoices/:id', view, limited(async (req) => {
    const { id } = idParam.parse(req.params);
    const inv = await loadInvoice(id, req.auth.orgId);
    return { invoice: await invoiceDetail(req, inv) };
  }, 'read'));

  /** `invoice.recalculate` denetim kaydı (plan "Uçlar"): dayanak, neden, sürümler, önce/sonra toplam, değişen satır. */
  async function auditRecalculate(req: FastifyRequest, invoiceId: string, r: ApplyRecompareResult, extra: Record<string, unknown> = {}) {
    await audit(req.auth.orgId, req.auth.membershipId, 'invoice.recalculate', 'Invoice', invoiceId, { ...r.summary, ...extra });
  }

  /**
   * SPEC 10.2: fatura başlığını düzeltir. Taşıyıcı / tarife değişince fatura yeni tarifenin bugünkü sürümüyle (yalnız
   * tarife parçası güncellenir, ayar faturadaki kalır), yalnız tarih / para birimi değişince kendi sabit dayanağıyla
   * baştan hesaplanır; ikisinde de karar verilmiş satırlar dahil (`all`). Bu dört alandan biri değişiyorsa aynı
   * değişikliğin önizleme `token`'ı zorunludur (yoksa 400 VALIDATION); önizlemeden sonra ölçüm, karar, tarife ya da satır
   * değiştiyse hiçbir şey yazılmaz, 409 PREVIEW_STALE. Gönderilmiş itirazı olan faturada bu dört alan kilitlidir (talep o
   * rakamlarla yazıldı): 409 INVOICE_HAS_DISPUTE (token'dan önce denetlenir). Fatura no ve dönem serbesttir.
   */
  app.patch('/invoices/:id', upload, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = invoicePatchBody.parse(req.body);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const inv = await loadInvoice(id, companyId);
    const data: Prisma.InvoiceUncheckedUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

    const patch = await resolveHeaderChange(inv, body);
    if (patch.carrierId !== undefined) {
      data.carrierId = patch.carrierId;
      changes.carrierId = { from: inv.carrierId, to: patch.carrierId };
    }
    if (patch.tariffId !== undefined) {
      data.tariffId = patch.tariffId;
      changes.tariffId = { from: inv.tariffId, to: patch.tariffId };
    }
    if (body.invoiceNo !== undefined && body.invoiceNo !== inv.invoiceNo) {
      data.invoiceNo = body.invoiceNo;
      changes.invoiceNo = { from: inv.invoiceNo, to: body.invoiceNo };
    }
    if (patch.invoiceDate !== undefined) {
      data.invoiceDate = patch.invoiceDate;
      changes.invoiceDate = { from: iso(inv.invoiceDate), to: iso(patch.invoiceDate) };
    }
    let periodFrom = inv.periodFrom;
    let periodTo = inv.periodTo;
    if (body.periodFrom !== undefined) {
      const d = toDate(body.periodFrom);
      if ((d ? +d : null) !== (inv.periodFrom ? +inv.periodFrom : null)) {
        data.periodFrom = d;
        changes.periodFrom = { from: iso(inv.periodFrom), to: iso(d) };
      }
      periodFrom = d;
    }
    if (body.periodTo !== undefined) {
      const d = toDate(body.periodTo);
      if ((d ? +d : null) !== (inv.periodTo ? +inv.periodTo : null)) {
        data.periodTo = d;
        changes.periodTo = { from: iso(inv.periodTo), to: iso(d) };
      }
      periodTo = d;
    }
    if (periodFrom && periodTo && periodFrom > periodTo) {
      throw badRequest('VALIDATION', msg('invoice.periodOrder'), [{ path: 'periodFrom', message: msg('v.invalidPeriod') }]);
    }
    if (patch.currency !== undefined) {
      data.currency = patch.currency;
      changes.currency = { from: inv.currency, to: patch.currency };
    }

    if (data.invoiceNo !== undefined || data.carrierId !== undefined) {
      const carrierId = (data.carrierId as string | undefined) ?? inv.carrierId;
      const invoiceNo = (data.invoiceNo as string | undefined) ?? inv.invoiceNo;
      if (await invoiceNoTaken(prisma, companyId, carrierId, invoiceNo, id)) throw conflict('INVOICE_EXISTS', msg('invoice.exists'));
    }

    if (Object.keys(data).length) {
      // Mükerrer kararı önceki faturanın taşıyıcısına ve para birimine, gerekçesi fatura numarasına bakar: bunlar değişince
      // aynı takip numaralarını taşıyan sonraki faturalar da yeniden karşılaştırılır (inceleme 2026-11-10). 07-B1: işaret
      // (`InvoiceRecheck`) başlıkla aynı işlemde yazılır; hesap yanıttan sonra, yarıda kalırsa tarama tamamlar.
      const touchesDuplicates = data.carrierId !== undefined || data.currency !== undefined || data.invoiceNo !== undefined;
      let rechecks: { invoiceId: string; pendingAt: Date }[] = [];
      const markLater = async (tx: Prisma.TransactionClient) => {
        if (touchesDuplicates) rechecks = await markLaterDuplicates(tx, companyId, id, null);
      };
      // Kilit sırası (bağımsız inceleme): işaret yazılacaksa içe aktarma kilidi fatura kilidinden ÖNCE (`lockImportsShared`).
      const importLockFirst = async (tx: Prisma.TransactionClient) => {
        if (touchesDuplicates) await lockImportsShared(tx, companyId);
      };
      /** Tarife başka: fatura yeni tarifenin bugünkü sürümüne bağlanır. */
      const moved = patch.carrierId !== undefined || patch.tariffId !== undefined;
      /** Hesabı değiştiren (itiraz varken kilitli) dört alandan biri değişti. */
      const recompared = moved || patch.invoiceDate !== undefined || patch.currency !== undefined;
      const updateLog = (tx: Prisma.TransactionClient) =>
        tx.auditLog.create({
          data: { companyId, userId, action: 'invoice.update', entity: 'Invoice', entityId: id, data: JSON.parse(JSON.stringify({ changes, recompared })) },
        });
      if (recompared) {
        if (!body.token) {
          if (await invoiceHasActiveRound(companyId, id)) throw refusal('INVOICE_HAS_DISPUTE');
          throw badRequest('VALIDATION', msg('invoice.previewRequired'), [{ path: 'token', message: msg('v.required') }]);
        }
        // Başlık, yeniden hesap, dayanak, toplam ve denetim kaydı fatura kilidi altında TEK işlemde (motor `patch`'i satırlarla
        // birlikte yazar): itiraz gönderimi (aynı kilit) araya girerse hiçbiri yazılmaz, 409 INVOICE_HAS_DISPUTE. Hesap
        // önizlemeyle aynı seçeneklerle (`pinned` + `patch`; taşıyıcı / tarife değişince motor `tariff`'e yükseltir) yapılır;
        // özet önizlemeninkiyle tutmazsa 409 PREVIEW_STALE. Yeni taşıyıcının tarifesi yoksa dayanak boşalır (motor kuralı).
        const { carrierId: _c, tariffId: _t, invoiceDate: _d, currency: _cur, ...free } = data;
        // Y123: yükleme izni karar izni değildir. Bu yeniden hesap kararı verilmiş satırları da yazar (`all`); karar izni
        // olmayan (Muhasebe) yalnız kararlı satırın sonucunu değiştirmeyen düzeltmeyi yapabilir. Denetim önizlemeye değil,
        // kilit altında kurulan plana bakar (`frozenChanged`, önizlemedeki sayıyla aynı kural); tutarsa 403, hiçbir şey yazılmaz.
        const decider = can(req, 'deciship.lines.decide');
        const r = applied(
          await writeInvoiceNo(() =>
            applyRecompare(id, {
              basis: 'pinned',
              scope: 'all',
              cause: moved ? 'TARIFF' : 'OTHER',
              patient: true,
              patch,
              expectedToken: body.token,
              beforeLock: importLockFirst,
              onWrite: async (tx, _target, plan) => {
                if (!decider && plan.frozenChanged > 0) throw new AppError(403, 'DECIDED_LINES_CHANGE', msg('invoice.decidedLinesChange'), { frozenChanged: plan.frozenChanged });
                // içe aktarma kilidi fatura no yazılmadan önce (aynı numarayı yazan içe aktarmayla kilitlenmesin)
                await markLater(tx);
                if (Object.keys(free).length) await tx.invoice.update({ where: { id }, data: free });
                await updateLog(tx);
              },
            }),
          ),
        );
        await auditRecalculate(req, id, r, { via: 'invoice.update' });
      } else {
        // Fatura no / dönem: hesap yok; kilit altında, denetim kaydıyla tek işlemde.
        await writeInvoiceNo(() =>
          prisma.$transaction(async (tx) => {
            await importLockFirst(tx);
            await lockInvoice(tx, companyId, id);
            await markLater(tx);
            await tx.invoice.update({ where: { id }, data });
            await updateLog(tx);
          }, TX_DEFAULTS),
        );
      }
      if (rechecks.length) await queueInvoiceRecheck(companyId, rechecks, req.log);
      // 01-B8: para birimi düzeltildi (satırlardaki para birimine getirildi): "Para birimi faturanınkinden farklı" bayrağı yeni
      // para birimiyle tazelenir. Değişiklik yazıldı; tazeleme düşerse "Yeniden karşılaştır" yapar.
      if (data.currency !== undefined) {
        await refreshParseFlags(id).catch((err: unknown) => req.log.warn({ err, invoiceId: id }, 'invoice.update: parse flags not refreshed after currency change'));
      }
    }
    return { invoice: await invoiceDetail(req, await loadInvoice(id, companyId)) };
  });

  app.get('/invoices/:id/lines', view, limited(async (req) => {
    const { id } = idParam.parse(req.params);
    const q = linesQuery.parse(req.query);
    await loadInvoice(id, req.auth.orgId);
    // Süzgecin tek tanımı: toplu kararın "bu süzgeçteki tümü" aynı işlevle aynı satırları seçer.
    const where = buildLineWhere(id, q);
    // Y127: "tümünü seç" süzgecin BÜTÜN satırlarının özetini (`selectionDigest`) geri gönderir; toplu karar kilit altında
    // yeniden üretir, tutmazsa 409 SELECTION_CHANGED. Yalnız karar izni olana ve en çok `BULK_DECIDE_MAX` satırlık süzgeçte
    // (yoksa null: "tümünü seç" sunulmaz). Toplam da aynı sorgudan: `expectedCount` ile özet aynı anın kümesidir.
    const selection = can(req, 'deciship.lines.decide') ? await listSelection(where) : null;
    const [total, rows, selectionEligible] = await Promise.all([
      selection ? selection.total : prisma.invoiceLine.count({ where }),
      prisma.invoiceLine.findMany({
        where,
        include: lineInclude,
        orderBy: { rowIndex: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      // 10-B14: "tümünü seç"te toplu kararın değiştirebileceği satırlar (kutusu açık olanlar: kararı bekleyen, fark var,
      // hesabı güncel, etkin itirazda olmayan; web `isEligible` ile aynı). Onay metni süzgecin toplamını değil bunu söyler.
      selection
        ? prisma.invoiceLine.count({
            where: { AND: [where, { status: 'DIFF', decision: 'OPEN', recalcPending: null, disputeLines: { none: { companyId: req.auth.orgId, dispute: activeRoundWhere } } }] },
          })
        : Promise.resolve(null),
    ]);
    const disputes = await lineDisputeStates(req.auth.orgId, rows.map((l) => l.id));
    return {
      ...paged(
        rows.map((l) => ({ ...serializeLine(l, req), dispute: disputes.get(l.id) ?? null })),
        total,
        q.page,
        q.pageSize,
      ),
      selectionDigest: selection?.digest ?? null,
      selectionEligible,
    };
  }));

  /**
   * SPEC 10.2: karar, takip no düzeltmesi, elle eşleştirme, not. Bütün alanlar isteğe bağlı. §3.14:
   *  - Takip no düzeltmesi ve elle eşleştirme düzeltilen satırı kararı verilmiş olsa da hesaplar (kullanıcının o satırda
   *    bilerek yaptığı değişiklik; eski rakam `prevResult`'ta kalır), faturanın öbür satırları sabit dayanak + açık kipte.
   *  - Not yazmak / silmek hiçbir satırın para sonucunu değiştirmez: elle not silinince karşılaştırma notu yalnız sonuç
   *    kayıtlıyla aynıysa geri gelir (`restoreComparisonNote`).
   *  - Kararı `OPEN`'a dönen ve `recalcPending` taşıyan satır aynı istekte güncel ölçüm ve faturanın sabit dayanağıyla
   *    hesaplanır (eski rakam `prevResult`'a, işaret silinir).
   */
  app.patch('/invoice-lines/:id', decide, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = linePatchBody.parse(req.body);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const line = await prisma.invoiceLine.findFirst({ where: { id, companyId, invoice: { deletedAt: null } } });
    if (!line) throw notFound(msg('line.notFound'));
    if (body.decision === 'ACCEPTED' && !body.reason) {
      throw badRequest('REASON_REQUIRED', msg('line.reasonRequired'), [{ path: 'reason', message: msg('v.required') }]);
    }

    const data: Prisma.InvoiceLineUncheckedUpdateManyInput = {};
    let recompare = false;
    /** Yeniden hesabın nedeni (`prevResult.cause`): takip no düzeltmesi ya da elle eşleştirme. */
    let why: RecalcCause = 'OTHER';
    /** Elle not silindi: karşılaştırma notu (rakam değişmeden) geri getirilir. */
    let restoreNote = false;

    // Karar alanları toplu kararla aynı işlevden (services/bulkDecide.ts).
    if (body.decision !== undefined) Object.assign(data, decisionFields(body.decision, body.reason, userId));

    if (body.trackingNo !== undefined) {
      const next = normalizeTracking(body.trackingNo);
      if (!next) throw badRequest('VALIDATION', msg('line.trackingEmpty'), [{ path: 'trackingNo', message: msg('v.required') }]);
      if (next !== line.trackingNo) {
        const original = line.originalTrackingNo ?? line.trackingNo;
        data.trackingNo = next;
        // reverting to the printed value clears the "Faturada: X" hint
        data.originalTrackingNo = next === original ? null : original;
        recompare = true;
        why = 'TRACKING';
      }
    }

    if (body.measurementId !== undefined) {
      if (body.measurementId === null) {
        if (line.measurementPinned) {
          data.measurementPinned = false;
          data.measurementId = null;
          recompare = true;
          why = 'MATCH';
        }
      } else {
        const m = await prisma.measurement.findFirst({ where: { id: body.measurementId, companyId, deletedAt: null } });
        if (!m) throw notFound(msg('measurement.notFound'));
        // Zincirin son sürümü silinmişse eski sürüme de eşleştirilmez (silinmiş ölçüm; kalıcı silmeyle yarışmasın).
        if (m.supersededById && (await resolveLatestVersion(companyId, m.id))?.deletedAt) throw notFound(msg('measurement.notFound'));
        data.measurementPinned = true;
        data.measurementId = m.id;
        recompare = true;
        why = 'MATCH';
      }
    }

    if (body.note !== undefined) {
      const note = body.note || null;
      data.note = note;
      data.noteManual = note != null;
      // elle not silinince karşılaştırma notu geri gelir; satır yeniden hesaplanmaz (not rakam değiştirmez)
      if (!note && line.noteManual) restoreNote = true;
    }
    // Karar geri alındı ve satır donmuşken yeni sonucu bekliyordu: aynı istekte o satır hesaplanır (yalnız o satır).
    const reopened = body.decision === 'OPEN' && line.decision !== 'OPEN' && line.recalcPending != null && !recompare;

    if (body.parseChecked !== undefined && body.parseChecked !== line.parseChecked) data.parseChecked = body.parseChecked;

    let totals: InvoiceTotals | null = null;
    let rechecks: { invoiceId: string; pendingAt: Date }[] = [];
    if (Object.keys(data).length) {
      // 05-B2: satır ve toplam fatura kilidi altında aynı işlemde yazılır; aynı faturadaki başka karar ya da yeniden
      // karşılaştırma sıraya girer, toplam hiçbir an satırlarla çelişmez.
      totals = await prisma.$transaction(async (tx) => {
        // kilit sırası: takip no düzeltmesi sonraki faturalara işaret yazar, içe aktarma kilidi fatura kilidinden önce
        if (typeof data.trackingNo === 'string') await lockImportsShared(tx, companyId);
        await lockInvoice(tx, companyId, line.invoiceId);
        // 10-B13: karar kuralları kilit altındaki okumaya bakar (kilit dışındaki `line` eski olabilir: başka kişi ya da
        // yeniden karşılaştırma araya girmiş olabilir).
        const cur = await tx.invoiceLine.findFirst({
          where: { id, companyId },
          select: { decision: true, status: true, diffTypes: true, netAmount: true, diffAmount: true },
        });
        if (!cur) throw notFound(msg('line.notFound'));
        if (body.expectedDecision !== undefined && cur.decision !== body.expectedDecision) throw conflict('LINE_CHANGED', msg('line.changed'));
        // Y126: "İtiraz listesine ekle" toplu kararla aynı kurala bağlı (`hasClaim`, toplu yolda `noClaim`): talebi sıfır olan
        // ya da "Fark var" olmayan satır listeye girmez (itiraz metnine de girmezdi). Aynı istekte takip no / eşleşme düzeltmesi
        // varsa satır bu istekte yeniden hesaplanır; kural bugünkü rakama bakamayacağı için o birleşik istek denetlenmez.
        if (body.decision === 'VERIFIED' && cur.decision !== 'VERIFIED' && !recompare && !(cur.status === 'DIFF' && hasClaim(cur))) {
          throw conflict('NO_CLAIM', msg('line.noClaim'));
        }
        // Gönderilmiş itirazdaki satırın talebi dayanağını kaybetmesin: karar, takip no ve ölçüm eşleşmesi kilitli (not serbest).
        // Fatura kilidi gönderme ile aynı sırada: satır pakete girerken kararı değişemez.
        const touchesClaim = (body.decision !== undefined && body.decision !== cur.decision) || data.trackingNo !== undefined || data.measurementPinned !== undefined;
        if (touchesClaim) await assertLineNotInActiveDispute(tx, companyId, id);
        // Okunan karar yazımda yeniden: kilidi almayan bir yazıcı araya girdiyse hiçbir şey yazılmaz.
        const n = await tx.invoiceLine.updateMany({ where: { id, companyId, decision: cur.decision }, data });
        if (n.count !== 1) throw conflict('LINE_CHANGED', msg('line.changed'));
        // 07-B1: takip no değişti: eski ve yeni numarayı taşıyan sonraki faturalar "Mükerrer yeniden hesabı bekliyor" (aynı işlemde)
        if (typeof data.trackingNo === 'string') rechecks = await markLaterDuplicates(tx, companyId, line.invoiceId, [line.trackingNo, data.trackingNo]);
        return recompare ? null : refreshTotals(line.invoiceId, tx);
      }, TX_DEFAULTS);
    }
    // Yeniden eşleştirme faturanın tamamında koşar (mükerrer ve toplam tutarlı kalsın): sabit dayanak, açık satırlar.
    // Düzeltilen satır kararlı olsa da hesaplanır (`forceLineIds`); kararı değişmez, eski rakamı `prevResult`'ta kalır.
    // Öbür kararlı satırlar yazılmaz, sonucu değişen `recalcPending` ile işaretlenir. Etkin itirazdaki satır yazılmaz.
    if (recompare) {
      totals = applied(await applyRecompare(line.invoiceId, { basis: 'pinned', scope: 'open', forceLineIds: [id], cause: why, patient: true })).totals;
    } else if (reopened) {
      // Yalnız bu satır, faturanın sabit dayanağıyla; neden işaretin nedeni. Bu arada satıra yeniden karar verildiyse
      // (yarış) yazılmaz: kilit altında karar yeniden okunur, hesap geri alınır, satır işaretli kalır. Toplu "Geri al" ile
      // aynı işlev (services/bulkDecide.ts `reopenPendingLines`).
      totals = await reopenPendingLines(line.invoiceId, [{ id, recalcPending: line.recalcPending }]);
    } else if (restoreNote) {
      if (await restoreComparisonNote(line.invoiceId, id)) totals = null;
    }
    totals ??= await refreshTotals(line.invoiceId);
    // Takip no değişti: eski ve yeni numarayı taşıyan sonraki faturaların mükerrer sonucu da değişir (işaret yukarıda yazıldı).
    if (rechecks.length) await queueInvoiceRecheck(companyId, rechecks, req.log);
    const updated = await prisma.invoiceLine.findFirstOrThrow({ where: { id }, include: lineInclude });

    const action =
      body.measurementId !== undefined
        ? body.measurementId
          ? 'invoiceLine.pin'
          : 'invoiceLine.unpin'
        : body.trackingNo !== undefined
          ? 'invoiceLine.trackingFix'
          : body.decision !== undefined
            ? 'invoiceLine.decision'
            : body.parseChecked !== undefined && body.note === undefined
              ? 'invoiceLine.parseChecked'
              : 'invoiceLine.update';
    await audit(companyId, userId, action, 'InvoiceLine', id, {
      ...body,
      ...(data.trackingNo !== undefined ? { previousTrackingNo: line.trackingNo } : {}),
      ...(body.measurementId !== undefined ? { previousMeasurementId: line.measurementId } : {}),
    });
    const lineDispute = (await lineDisputeStates(companyId, [id])).get(id) ?? null;
    return { line: { ...serializeLine(updated, req), dispute: lineDispute }, totals };
  });

  /**
   * 08-B1: toplu karar. `lineIds` (seçilen satırlar) ya da `filter` + `expectedCount` + `selectionDigest`
   * ("bu süzgeçteki tümü": süzgecin bugünkü toplamı ya da kümenin özeti tutmazsa 409 SELECTION_CHANGED, Y127) ile tam olarak biri. `VERIFIED` / `ACCEPTED` yalnız
   * kararı bekleyen, "Fark var" ve yeniden hesap beklemeyen satıra; "İncele" işaretli satır itiraz listesine toplu girmez.
   * `OPEN` (geri al) yalnız kararı verilmiş satıra; işaretli satır tek satır kuralıyla hesaplanır. Etkin itirazdaki satıra
   * dokunulmaz. Atlananlar nedenine göre sayılır. Kurallar tek satırlık kararla ortak: services/bulkDecide.ts.
   */
  app.post('/invoices/:id/lines/decide', decide, async (req) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    // Kayıt gövdeden önce aranır (itiraz uçlarıyla aynı): başka firmanın / silinmiş faturası gövdesi ne olursa olsun 404.
    const exists = await prisma.invoice.findFirst({ where: { id, companyId, deletedAt: null }, select: { id: true } });
    if (!exists) throw notFound(msg('invoice.notFound'));
    const body = bulkDecideBody.parse(req.body);
    if ((body.lineIds === undefined) === (body.filter === undefined)) {
      const path = body.lineIds ? 'filter' : 'lineIds';
      throw badRequest('VALIDATION', msg('err.validation'), [{ path, message: msg(body.lineIds ? 'v.invalid' : 'v.required') }]);
    }
    // Y127: özet zorunlu. Özet göndermeyen (eski) istemci reddedilir; liste anına geri düşülmez (o denetimde boşluk vardı).
    for (const path of ['expectedCount', 'selectionDigest'] as const) {
      if (body.filter && body[path] === undefined) throw badRequest('VALIDATION', msg('err.validation'), [{ path, message: msg('v.required') }]);
    }
    if (body.undoOf && (body.decision !== 'OPEN' || !body.lineIds)) {
      throw badRequest('VALIDATION', msg('err.validation'), [{ path: 'undoOf', message: msg('v.invalid') }]);
    }
    const reason = body.reason ? body.reason : null;
    if (body.decision === 'ACCEPTED' && !reason) {
      throw badRequest('REASON_REQUIRED', msg('line.reasonRequired'), [{ path: 'reason', message: msg('v.required') }]);
    }
    if (body.lineIds && new Set(body.lineIds).size > BULK_DECIDE_MAX) throw new AppError(400, 'BULK_TOO_MANY', msg('err.bulkTooMany'));
    return bulkDecide({ companyId, userId }, id, {
      decision: body.decision,
      reason,
      ...(body.lineIds ? { lineIds: body.lineIds } : {}),
      ...(body.filter ? { filter: body.filter, expectedCount: body.expectedCount, selectionDigest: body.selectionDigest } : {}),
      ...(body.undoOf ? { undoOf: { opId: body.undoOf.opId, decidedAt: new Date(body.undoOf.decidedAt) } } : {}),
    });
  });

  /** SPEC §3.9: tarife uyumu raporu (ülke + bölge + hizmet gruplarında taşıyıcının fiyatı ↔ tarife). */
  app.get('/invoices/:id/tariff-health', reports, limited(async (req) => {
    const { id } = idParam.parse(req.params);
    return { health: await invoiceTariffHealth(id, req.auth.orgId) };
  }));

  /**
   * Önizlemesiz yeniden karşılaştırma (kur yeniden denemesi, yeni gelen ölçümler): faturanın sabit dayanağıyla, yalnız
   * karar verilmemiş satırlar. Karar verilmiş / itirazdaki satır yazılmaz; sonucu değişen `recalcPending` ile işaretlenir
   * ve sayısı `pendingLines` olarak döner. Dayanaksız fatura (içe aktarılırken taşıyıcının tarifesi yoktu) burada yalnız
   * tarife parçasını benimser: §3.12 kuralıyla bulunan tarifenin (faturada seçilen, yoksa taşıyıcının varsayılanı)
   * bugünkü sürümü; ayar faturadaki kalır. Etkin itiraz turu varsa benimseme yapılmaz, faturanın kendi (tarifesiz)
   * dayanağıyla hesaplanır.
   */
  app.post('/invoices/:id/recompare', decide, async (req) => {
    const { id } = idParam.parse(req.params);
    const before = await loadInvoice(id, req.auth.orgId);
    // SPEC §11.4: okuma bayrakları kaynak dosya + eşlemeden yeniden hesaplanır (eski faturalar için doldurma).
    const flaggedLines = await refreshParseFlags(id);
    const opts: RecompareOptions = { basis: 'pinned', scope: 'open', cause: 'OTHER', patient: true };
    let r = before.tariffRevisionId == null ? await applyRecompare(id, { ...opts, basis: 'tariff' }) : await applyRecompare(id, opts);
    // dayanaksız ama itirazı gönderilmiş fatura: dayanak benimsenmez, sabit hesap yine yapılır
    if (r === 'INVOICE_HAS_DISPUTE') r = await applyRecompare(id, opts);
    const done = applied(r);
    // K37: fatura az önce baştan hesaplandı; bitmiş arka plan işaretleri temizlenir (ölçümünki yeniden denenir)
    if ((await failedRecalcInvoices(req.auth.orgId, [id])).has(id)) await clearFailedRecalc(req.auth.orgId, id);
    await audit(req.auth.orgId, req.auth.membershipId, 'invoice.recompare', 'Invoice', id, { flaggedLines, pendingLines: done.pendingLines });
    const inv = await loadInvoice(id, req.auth.orgId);
    return {
      invoice: serializeInvoiceHeader(inv, { fileUrl: fileUrl(req, inv.sourceFileId, inv.companyId), basis: await invoiceBasisView(inv.companyId, inv) }),
      pendingLines: done.pendingLines,
    };
  });

  /** Önizlemedeki dayanak tarafı: tarife (silinmişse null), ad (silinmişse sürümdeki ad), sürüm ve doğduğu an. */
  async function basisRefs(companyId: string, sides: RecompareBasisInfo[]) {
    const info = await loadBasisInfo(companyId, sides.map((b) => b.tariffRevisionId));
    return sides.map((b) => {
      const rev = b.tariffRevisionId ? info.get(b.tariffRevisionId) : undefined;
      return {
        tariffId: rev?.tariff?.id ?? null,
        tariffName: rev ? (rev.tariff?.name ?? rev.tariffName) : b.tariffName,
        revisionId: b.tariffRevisionId,
        revisionAt: rev ? rev.createdAt.toISOString() : null,
      };
    });
  }

  /** Seçili satırların ortak bekleyen nedeni (MEASUREMENT / DUPLICATE / OTHER); işaret yoksa ya da farklıysa OTHER. */
  async function selectedCause(lineIds: string[]): Promise<RecalcCause> {
    const rows = await prisma.invoiceLine.findMany({ where: { id: { in: lineIds } }, select: { recalcPending: true } });
    const causes = new Set(rows.map((r) => (r.recalcPending ? pendingCauseOf(r.recalcPending as RecalcCause) : 'OTHER')));
    return causes.size === 1 ? [...causes][0]! : 'OTHER';
  }

  /** İstekteki satırlar bu faturanın satırları mı (başka faturanın / firmanın kimliği 404). */
  async function assertLinesOfInvoice(invoiceId: string, lineIds: string[] | undefined) {
    if (!lineIds) return undefined;
    const ids = [...new Set(lineIds)];
    const found = await prisma.invoiceLine.count({ where: { invoiceId, id: { in: ids } } });
    if (found !== ids.length) throw notFound(msg('line.notFound'));
    return ids;
  }

  /**
   * Yeniden hesabın önizlemesi (önce / sonra). Hiçbir şey yazmaz.
   *  - `pinned`: faturanın sabit tarife sürümü ve ayarıyla ("Yeniden karşılaştır"); `tariff`: yalnız tarife sürümü
   *    bugünküne geçer ("Yeni tarifeyle hesapla"); `rules`: yalnız ayar bugünküne geçer ("Yeni ayarla hesapla").
   *  - `lineIds`: yalnız bu satırlar (donmuş satırda "Yeni ölçümle hesapla"); verilmezse karar verilmiş satırlar dahil tümü.
   *  - `patch`: düzenleme penceresindeki değişiklik; taşıyıcı / tarife değişiyorsa tarife parçası bugünküne geçer.
   *  - `lineIds` ve `patch` yalnız `pinned` ile; `tariff` / `rules` ile birleşirse 400 VALIDATION.
   * Etkin itiraz: `tariff`, `rules` ya da `patch` → 409 INVOICE_HAS_DISPUTE; `lineIds` içinde itirazdaki satır → 409
   * LINE_IN_DISPUTE; `pinned` serbesttir, itirazdaki satırlar yazılmaz ve `skippedInDispute` olarak sayılır.
   */
  app.post('/invoices/:id/recalculate/preview', editPreview, async (req) => {
    const { id } = idParam.parse(req.params);
    // Y11: ilişkiler gerekmez (tek sorgu); hesap aynı satırı yeniden okumaz
    const inv = await loadInvoiceRow(id, req.auth.orgId);
    const body = recalcPreviewBody.parse(req.body);
    assertPinnedOnly(body);
    const lineIds = await assertLinesOfInvoice(id, body.lineIds);
    const patch = body.patch ? await resolveHeaderChange(inv, body.patch) : undefined;
    // Y123: yükleme izniyle yalnız gerçekten değişen bir başlık alanının önizlemesi. Boş ya da etkisiz `patch` tam
    // "Yeniden karşılaştır" önizlemesi olurdu: karar izninde kalır.
    if (!can(req, 'deciship.lines.decide') && !(patch && Object.keys(patch).length)) throw forbiddenFor(req);
    const comp = await previewRecompare(id, { basis: body.basis, scope: 'all', lineIds, ...(patch && Object.keys(patch).length ? { patch } : {}), invoice: inv });
    if (comp === null) throw notFound(msg('invoice.notFound'));
    if (typeof comp === 'string') throw refusal(comp);
    const [from, to] = await basisRefs(req.auth.orgId, [comp.from, comp.to]);
    const written = comp.lines.filter((l) => l.action === 'write');
    const side = (m: (typeof written)[number]['before']) => ({ status: m.status, diffTypes: m.diffTypes, expectedAmount: m.expectedAmount, diffAmount: m.diffAmount });
    return {
      token: comp.token,
      basis: {
        from,
        to,
        /** hesap ayarı faturadakinden farklı (ayarı hiç yazılmamış eski faturada fark sayılmaz) */
        rulesChanged: comp.from.compareSettings != null && !sameCompareSettings(comp.from.compareSettings, comp.to.compareSettings),
      },
      totals: comp.totals,
      changedLines: comp.changedLines,
      /** uygulanınca dokunulacak satır (görünür değişiklik olmasa da; web `changedLines` 0 ve bu > 0 ise sormadan uygular) */
      writeLines: comp.writeLines,
      frozenChanged: comp.frozenChanged,
      skippedInDispute: comp.skippedInDispute,
      lines: written.slice(0, RECALC_LINE_LIMIT).map((l) => ({ id: l.id, rowIndex: l.rowIndex, trackingNo: l.trackingNo, decision: l.decision, before: side(l.before), after: side(l.after) })),
    };
  });

  /**
   * önizlenen yeniden hesabı uygular. `token` önizlemeninkidir; hesap ile onay arasında ölçüm, karar, tarife, ayar
   * ya da satır değiştiyse hiçbir şey yazılmaz: 409 PREVIEW_STALE (web önizlemeyi yeniler). Karar durumu değişmez; rakamı
   * değişen satırın eski sonucu `prevResult`'ta kalır. `tariff` faturayı tarifenin bugünkü sürümüne, `rules` bugünkü
   * ayara bağlar; öbür parça faturadaki kalır. `lineIds` yalnız `pinned` ile (yoksa 400) ve dayanağı değiştirmez.
   * Yetki her kipte `deciship.lines.decide`: tek faturada bugünkü tarife ya da ayarı benimsemek o faturanın incelemesidir
   * (tarife ve ayarı değiştirmek değil); toplu geçişler kaynağının izniyle (`tariffs.edit`, `settings.manage`).
   */
  app.post('/invoices/:id/recalculate', decide, async (req) => {
    const { id } = idParam.parse(req.params);
    const before = await loadInvoice(id, req.auth.orgId);
    const body = recalcBody.parse(req.body);
    assertPinnedOnly(body);
    const lineIds = await assertLinesOfInvoice(id, body.lineIds);
    // Neden: seçili satırlar = işaretlerinin nedeni (hepsinde aynıysa; ör. "Yeni ölçümle hesapla" MEASUREMENT), yoksa
    // OTHER; `pinned` tümü = genel; `tariff` / `rules` = motor seçer (parça değişiyorsa TARIFF / RULES).
    const why: RecalcCause | undefined = lineIds ? await selectedCause(lineIds) : body.basis === 'pinned' ? 'OTHER' : undefined;
    // Tarifesi silinmiş / hiç seçilmemiş fatura `current` ile bir tarifeye bağlanırsa o tarife faturaya da yazılır (sonradan
    // "Varsayılan yap" başka tarifeyi seçince fatura kendiliğinden ona kaymaz). Dayanak, satırlar ve toplamla aynı işlemde,
    // fatura kilidi altında: yeniden hesap yazılmazsa (bayat önizleme, itiraz) tarife de yazılmaz.
    const bindTariff =
      body.basis === 'tariff'
        ? async (tx: Prisma.TransactionClient, target: { tariffRevisionId: string | null }) => {
            if (!target.tariffRevisionId) return;
            // Y11: sürümün tarifesi ve yazım tek ifadede (eskiden okuma + güncelleme); koşullar aynı
            await tx.$executeRaw`
              UPDATE "Invoice" i SET "tariffId" = r."tariffId", "updatedAt" = (now() AT TIME ZONE 'UTC')
              FROM "TariffRevision" r
              WHERE i."id" = ${id} AND i."tariffId" IS NULL
                AND r."id" = ${target.tariffRevisionId} AND r."companyId" = ${before.companyId} AND r."tariffId" IS NOT NULL`;
          }
        : undefined;
    const r = applied(
      await applyRecompare(id, { basis: body.basis, scope: 'all', lineIds, cause: why, expectedToken: body.token, patient: true, onWrite: bindTariff, invoice: before }),
    );
    await auditRecalculate(req, id, r, lineIds ? { lineIds: lineIds.length } : {});
    // K37: bütün fatura baştan hesaplandı (seçili satırlarla değil): bitmiş arka plan işaretleri temizlenir; yanıtta uyarı yok
    // (bakış bir sorgu, temizlik yalnız uyarı varken)
    const recalcFailed = lineIds ? undefined : false;
    if (!lineIds && (await failedRecalcInvoices(req.auth.orgId, [id])).has(id)) await clearFailedRecalc(req.auth.orgId, id);
    // Y11: yanıt yazımı yapan işlemin döndürdüğü fatura satırından (yeniden okuma yok). Taşıyıcı ve kaynak dosya bu uçta
    // değişmez; tarife yalnız `bindTariff` ile boştan dolabilir, o zaman adı okunur.
    const tariff =
      r.invoice.tariffId === before.tariffId
        ? before.tariff
        : r.invoice.tariffId
          ? await prisma.tariff.findFirst({ where: { id: r.invoice.tariffId, companyId: before.companyId }, ...invoiceTariffSelect })
          : null;
    return { invoice: await invoiceDetail(req, { ...before, ...r.invoice, tariff }, { recalcFailed }) };
  });

  app.delete('/invoices/:id', upload, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const invoice = await loadInvoice(id, req.auth.orgId);
    // Gönderilmiş itirazı olan fatura silinmez (geri çekilince silinebilir). Kilit gönderme ile aynı sırada.
    // Bu faturadan ötürü "mükerrer" sayılan sonraki satırlar artık öyle değil (örnek fatura mükerrer saymaz). 07-B1: sonraki
    // faturaların işareti silmeyle aynı işlemde yazılır; hesap yanıttan sonra, düşerse tarama ve bakım tamamlar. Yanıt
    // silmenin sonucudur: yeniden hesabın hatası silmeyi başarısız göstermez.
    const rechecks = await prisma.$transaction(async (tx) => {
      // kilit sırası: işaret yazılacaksa içe aktarma kilidi fatura kilidinden önce (`lockImportsShared`)
      if (!invoice.isSample) await lockImportsShared(tx, req.auth.orgId);
      await lockInvoice(tx, req.auth.orgId, id);
      await assertInvoiceHasNoActiveDispute(tx, req.auth.orgId, id);
      await tx.invoice.update({ where: { id }, data: { deletedAt: new Date() } });
      return invoice.isSample ? [] : markLaterDuplicates(tx, req.auth.orgId, id, null);
    }, TX_DEFAULTS);
    await audit(req.auth.orgId, req.auth.membershipId, 'invoice.delete', 'Invoice', id);
    if (rechecks.length) await queueInvoiceRecheck(req.auth.orgId, rechecks, req.log);
    return reply.status(204).send();
  });

  async function reportInput(id: string, companyId: string): Promise<ReportInput> {
    const inv = await loadInvoice(id, companyId);
    const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: id }, include: lineInclude, orderBy: { rowIndex: 'asc' } });
    return {
      companyName: company.name,
      carrierName: inv.carrier.name,
      tariffSummary: tariffSummaryText(await invoiceBasisView(companyId, inv), inv.tariff, await tariffsUsed(id)),
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      periodFrom: inv.periodFrom ? inv.periodFrom.toISOString().slice(0, 10) : null,
      periodTo: inv.periodTo ? inv.periodTo.toISOString().slice(0, 10) : null,
      currency: inv.currency,
      totals: inv.totals as InvoiceTotals,
      // 19-B1: büyük faturada dilimlerle (sonuç aynı)
      lines: await mapSliced(lines, (l) => serializeLine(l, null)),
      /** Ölçüm zamanı firmanın saat diliminde yazılır. */
      timeZone: readSettings(company.settings).timeZone,
    };
  }

  const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

  app.get('/invoices/:id/report.xlsx', exportPriced, limited(async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = await reportInput(id, req.auth.orgId);
    // 19-B1: rapor dosya çalışanında (API'nin olay döngüsü rapor süresince kilitlenmez); içerik aynı
    const buf = await renderReport('xlsx', input, { companyId: req.auth.orgId, connection: req.raw.socket });
    reply.header('Content-Type', XLSX_MIME);
    reply.header('Content-Disposition', `attachment; filename="${msg('report.fileName', { no: safeName(input.invoiceNo) })}.xlsx"`);
    return reply.send(buf);
  }));

  app.get('/invoices/:id/report.pdf', exportPriced, limited(async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = await reportInput(id, req.auth.orgId);
    const buf = await renderReport('pdf', input, { companyId: req.auth.orgId, connection: req.raw.socket });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${msg('report.fileName', { no: safeName(input.invoiceNo) })}.pdf"`);
    return reply.send(buf);
  }));

  /**
   * İtiraz metni. 04-B8: satırda ölçüm kanıtı (firma saat dilimindeki ölçüm anı, ölçü ve ağırlık yöntemi,
   * fotoğraf sayısı); ölçen kişinin adı metne girmez (kargo firmasına gider; ad yalnız firmanın kendi raporunda).
   * Satır kümesi ve kanıt kanıt ZIP'iyle tek kaynaktan (`loadDisputeDraft`): silinmiş ölçüm kanıt sayılmaz, mükerrer
   * satırda kanıt yazılmaz; fotoğraf yalnız dosyası diskte bulunuyorsa sayılır (Y54, ZIP ile aynı işlev). Yanıt
   * `{ subject, body, lineCount, total, photoCount, linesWithoutPhoto }`.
   */
  // 06-B5: fotoğrafları diskte tarar; ZIP ucu gibi dışa aktarma yuvasında (firma başına sınırlı)
  app.get('/invoices/:id/dispute', exportData, limited(async (req) => {
    const { id } = idParam.parse(req.params);
    return renderDisputeText(await loadDisputeDraft(req, id, disputeLang(req)));
  }, 'export'));

  /**
   * 04-B8: itiraz metni ve fotoğraflar tek ZIP (sıkıştırmasız akış). Satırlar metindekiyle aynı küme; içerik ve
   * sınırlar `services/evidence.ts`. Uzun süren akış: dışa aktarma havuzu.
   */
  app.get('/invoices/:id/dispute/evidence.zip', exportData, limited(async (req, reply) => {
    const { id } = idParam.parse(req.params);
    // firma sınırı, fiyat izni ve satır kümesi servis içinde (`loadDisputeDraft`, metinle aynı)
    return streamEvidenceZip(req, reply, id, disputeLang(req));
  }, 'export'));
}
