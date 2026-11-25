/**
 * `INVOICE_PDF_READ` (Mesaj 7, plan §4.2, §4.5, §4.7): PDF faturanın yapay zekâyla okunması ve PDF metin denetimi.
 *
 * Uç (`POST /invoices/preview` PDF dalı) dosyayı ve sayfa metnini istek içinde okur ve saklar; okuma bu işte yapılır.
 * PDF okuma yalnız bu iştir: `?async=1` yoksa uç 400 `ASYNC_REQUIRED` (Y83; eski eşzamanlı yol kaldırıldı).
 *
 * Çift ücret olmaması (§4.7): yapay zekâ sonucu önbelleğe girer; yeniden deneme (`attempts > 1`) önbellekten `CACHED` alır.
 * "Yeniden oku" (`fresh`) işinde `cacheNotBefore = job.createdAt`: işten önceki eski sonuç gelmez, işin kendi sonucu gelir.
 *
 * Sonuç bugünkü PDF önizleme yanıtıdır. Ayrıca `File.preview`'a sayfa metni (≤ 1 MB) ve takip no'suz satırlar yazılır:
 * içe aktarma PDF'i ikinci kez okumaz (Mesaj 6 E2) ve takip no'suz satır sayısı sunucu yeniden başlasa da kalır (E6).
 *
 * Temizlik kancası (başarısız, durdurulmuş, bırakılmış iş): önizleme dosyası silinir (§4.12).
 */
import { normalizeTracking, pdfVatRateCheck, type Locale, type PdfReadNote, type PdfTotalsCheck } from '@deciship/core';
import type { Prisma } from '../../../db.ts';
import { prisma } from '../../../db.ts';
import { notFound } from '../../../errors.ts';
import { currentLocale, m as msg, withLocale } from '../../../i18n/index.ts';
import { firmCurrency } from '../../../lib/settings.ts';
import { readStored } from '../../../lib/storage.ts';
import { discardPreviewFile } from '../../fileCleanup.ts';
import { readInvoicePdfAll, type PdfPartProgress } from '../../invoicePdfRead.ts';
import { aiJobContext, type AiCallContext, type MeterLog } from '../../aiMeter.ts';
import { alignPdfSurchargeCodesReport, pdfKnownSurchargeList, type PdfKnownSurcharge } from '../../ai.ts';
import {
  checkInvoicePdfLines,
  findPdfMissedLines,
  flagAllPdfRows,
  knownPdfVatPct,
  parsePdfLines,
  pdfCheckUnitsOf,
  pdfPageTexts,
  pdfTotalsCheck,
  pdfPreviewValue,
  pdfReadNoteOf,
  pdfSkippedRows,
  readPdfPreview,
  type PdfLineCheck,
} from '../../invoicePdfCheck.ts';
import { jobCancelSignal } from '../runner.ts';
import { JobCancelled, type ClaimedJob, type JobContext, type JobHandler, type JobStage } from '../types.ts';

/** İşin girdisi (`Job.input`, dışarı verilmez). Firma satırın sütunundan alınır, burada yok. */
export type InvoicePdfInput = {
  v: 1;
  locale: Locale;
  /** başlatma anındaki abonelik limitleri (kota hesabı) */
  aiLimits: Record<string, number | boolean>;
  /** `?fresh=1`: önceki okumayı kullanma */
  fresh: boolean;
  fileId: string;
  /** 05-B10: seçilen taşıyıcı (tarife ek ücret kodları istemde); eski satırda yok: liste boş */
  carrierId?: string;
};

/**
 * Tekillik anahtarı (§4.2): aynı dosya (bayt bayt) aynı dilde aynı taşıyıcıyla (05-B10: istem taşıyıcının tarife ek
 * ücretlerini taşır; başka taşıyıcıyla süren işe bağlanılmaz). `fresh` ayrı iştir.
 */
export const invoicePdfDedupeKey = (sha256: string, locale: Locale, fresh: boolean, carrierId?: string | null) =>
  `pdf:${sha256}:${locale}${carrierId ? `:c:${carrierId}` : ''}${fresh ? ':fresh' : ''}`;

/**
 * 05-B10: taşıyıcının etkin tarifelerindeki ek ücretler (kod + ad; firma bağlamında). Taşıyıcı yoksa boş liste. Sıra ve
 * tekillik `pdfKnownSurchargeList`'te (istem aynı tarifelerde aynı kalır, önbellek tutar).
 */
export async function carrierKnownSurcharges(companyId: string, carrierId: string | null | undefined): Promise<PdfKnownSurcharge[]> {
  if (!carrierId) return [];
  const rows = await prisma.tariffSurcharge.findMany({
    where: { companyId, tariff: { companyId, carrierId, active: true } },
    select: { code: true, name: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return pdfKnownSurchargeList(rows);
}

/** Bugünkü PDF önizleme yanıtı (`POST /invoices/preview`, `format: 'pdf'`). */
export type InvoicePdfPreview = {
  fileId: string;
  format: 'pdf';
  aiLines: ReturnType<typeof parsePdfLines>['lines'];
  pdfCheck: PdfLineCheck;
  aiSkipped: { count: number; amount?: number };
  aiCached: boolean;
  guessedMeta: { invoiceNo?: string; invoiceDate?: string; currency: string };
  warning: string;
  /**
   * Yalnız büyük PDF'in gruplu okumasında şüphe varsa (Ek E1): `vatUnclear` (bütün satırlar `PDF_VAT_UNCLEAR`),
   * `pageBreakRows` (`aiLines` satır no'ları, `PDF_PAGE_BREAK`), `metaConflict` (başlık sayfalar arasında farklı).
   * Gruplar KDV oranında çelişir ve tutarlar KDV dahilse de `vatUnclear` (Y20).
   * İçe aktarma aynı bayrakları sunucunun kaydından (`File.preview.review`) koyar; `warning` metni de bunları söyler.
   */
  pdfReview?: { vatUnclear: boolean; pageBreakRows: number[]; metaConflict: boolean };
  /**
   * 05-B2: satır toplamının fatura toplamıyla karşılaştırması (core `PdfTotalsCheck`; okumada toplam alanı yoksa yok).
   * `vatSwapped`'ta bütün satırlar `pdfCheck.rows` içinde `PDF_VAT_UNCLEAR` ve `pdfReview.vatUnclear`; öbürleri yalnız uyarı.
   */
  pdfTotals?: PdfTotalsCheck;
};

/**
 * Yapay zekâ okuması + metin denetimi + `File.preview` yazımı. Firma bağlamında çağrılır (istek ya da `withCompany`).
 * - `buffer` verilmezse saklanan dosya okunur; `pageTexts` verilmezse PDF'ten okunur (dosya havuzu; meşgulse 503 `FILE_BUSY`,
 *   işte geçici hata sayılır).
 * - `signal` kesildiyse yapay zekâ çağrısından sonra `JobCancelled` atılır. Süren çağrıyı `ctx.signal` keser (KALANLAR 6.5:
 *   işte durdurma isteği, `jobCancelSignal`): çağrı 409 `AI_CANCELLED` ile düşer, harcama `FAILED` satırında (üst tahmin).
 * - Büyük PDF sayfa gruplarıyla okunur (Ek E1, `services/invoicePdfRead.ts`): `onPart` her gruptan önce (ilerleme ve durdurma;
 *   durdurma grup arasında etkili). Sayfa sayısı metin okumasından gelir; bu yüzden metin yapay zekâdan önce okunur.
 */
export async function readInvoicePdfPreview(o: {
  companyId: string;
  file: { id: string; path: string };
  ctx: AiCallContext;
  buffer?: Buffer;
  pageTexts?: string[] | null;
  onStage?: (stage: JobStage, p?: { done?: number }) => Promise<void>;
  onPart?: (p: PdfPartProgress) => Promise<void>;
  signal?: AbortSignal;
  /** 05-B10: seçilen taşıyıcı; tarifelerinin ek ücret kodları istemde ve okumadan sonra kodlar onlara hizalanır */
  carrierId?: string | null;
}): Promise<InvoicePdfPreview> {
  await o.onStage?.('pdfRead');
  const buffer = o.buffer ?? (await readStored(o.file.path));
  const pageTexts = o.pageTexts ?? (await pdfPageTexts(buffer, { companyId: o.companyId }));
  const knownSurcharges = await carrierKnownSurcharges(o.companyId, o.carrierId);
  const metered = await readInvoicePdfAll(buffer, pageTexts, o.ctx, {
    beforePart: async (p) => {
      if (o.signal?.aborted) throw new JobCancelled();
      await o.onPart?.(p);
    },
    knownSurcharges,
  });
  if (o.signal?.aborted) throw new JobCancelled();
  await o.onStage?.('pdfCheck', metered.parts > 1 ? { done: pageTexts.length } : undefined);
  // 05-B10: model tarifedeki ücrete başka kod yazdıysa (istemdeki listeye uymadıysa) kod basılı adla tarifeye hizalanır
  // İnceleme 2: kodu basılı addan türeyen (model kodu tarifeyle uyuşmayan) satırlar "Kontrol edilecek" olur
  const aligned = alignPdfSurchargeCodesReport(metered.data, knownSurcharges);
  const ai = aligned.data;
  // Y20: okunan KDV oranı, ağırlık ve ölçü birimi (okunmadıysa %20 / kg / cm, varsayım uyarıda ve kayıtta). lb'de değer
  // zaten kg yazılmışsa (metinle denetlenir) ikinci kez çevrilmez.
  const read = parsePdfLines(ai, { pageTexts });
  const { units } = read;
  const aiLines = read.lines;
  const { review } = metered;
  // 05-B4: ağırlık, ölçü ve ek ücret de metinde aranır (basılı birimle; gruplar farklı birim söylediyse bütün karşılıklar)
  const checkUnits = pdfCheckUnitsOf({ weightUnit: units.weightUnit, dimUnit: units.dimUnit, unitsMixed: review.unitsMixed ? true : undefined });
  // 05-B2: satır toplamı fatura toplamıyla; toplam öbür KDV kipine eşitse bütün satırlar "KDV belirsiz" (içe aktarmada
  // sunucunun kaydından: `review.vatUnclear`)
  const totals = pdfTotalsCheck(ai, pageTexts, units.vatPct);
  const totalsSwapped = totals?.status === 'vatSwapped';
  const lineCheck = checkInvoicePdfLines(pageTexts, aiLines, units.vatPct, checkUnits);
  const surchargeCodeTracking = [...new Set(aligned.unverifiedLines.map((i) => normalizeTracking(ai.lines[i]?.trackingNo ?? '')).filter(Boolean))];
  const codeRows = new Set(surchargeCodeTracking);
  const lineCheck2 = codeRows.size
    ? flagAllPdfRows(lineCheck, aiLines.filter((l) => codeRows.has(normalizeTracking(l.trackingNo))).map((l) => l.rowIndex), 'PDF_SURCHARGE_UNVERIFIED')
    : lineCheck;
  const check = totalsSwapped ? flagAllPdfRows(lineCheck2, aiLines.map((l) => l.rowIndex), 'PDF_VAT_UNCLEAR') : lineCheck2;
  // İnceleme 1: tutarlar KDV dahilken oran metinde doğrulanır; doğrulanamazsa (ya da olağan dışıysa) bütün satırlar
  // "KDV belirsiz" (`PDF_VAT_UNCLEAR`, "İncele"): tutar denetimi aynı oranla geri çarptığı için yanlış oranı yakalayamaz.
  const vatCheck = pdfVatRateCheck(pageTexts, { vatPct: units.vatPct, assumed: units.vatAssumed, amountsIncludeVat: ai.amountsIncludeVat });
  const skippedRows = pdfSkippedRows(ai);
  // Y31: metinde geçen ama okunmayan takip no'lar (önizlemede uyarı; içe aktarma gönderilen satırlarla yeniden bakar)
  const missed = findPdfMissedLines(pageTexts, aiLines, ai.invoiceNo);
  // Gruplu okumanın şüpheleri: birleşik satır sırası = `aiLines` satır no'su (Y23; takip no'suzlar `aiLines`'ta yok)
  const tracked = new Set(aiLines.map((l) => l.rowIndex));
  const pageBreakRows = review.pageBreakLines.filter((i) => tracked.has(i));
  const pageBreakTracking = [...new Set(review.pageBreakLines.map((i) => normalizeTracking(ai.lines[i]?.trackingNo ?? '')).filter(Boolean))];
  const vatUnclear = review.vatUnclear || !vatCheck.trusted || totalsSwapped;
  const note = pdfReadNoteOf(read, { vatUnverified: !vatCheck.trusted, unitsMixed: review.unitsMixed });
  const suspicious = vatUnclear || pageBreakRows.length > 0 || review.metaConflict;
  // Tekrarlanabilir yazım: aynı dosyanın yeniden okunması aynı değeri yazar. KALANLAR 6.5: faturaya bağlanmış dosyaya yazılmaz
  // (içe aktarma sayfa metnini sildi; içe aktarmadan sonra biten okuma onu geri yazmasın).
  await prisma.file.updateMany({
    where: { id: o.file.id, companyId: o.companyId, kind: 'INVOICE_SOURCE', invoiceId: null },
    data: {
      preview: pdfPreviewValue({
        pageTexts,
        skipped: skippedRows,
        method: check.method,
        review: { vatUnclear, pageBreak: pageBreakTracking, surchargeCode: surchargeCodeTracking },
        read: note,
        // K43: itiraz metninin KDV dahil tutarı için faturanın oranı (yalnız biliniyorsa)
        invoiceVatPct: knownPdfVatPct({ rawVatPct: ai.vatPct, amountsIncludeVat: ai.amountsIncludeVat, usedVatPct: units.vatPct, vatUnclear, pageTexts }),
      }) as Prisma.InputJsonValue,
    },
  });
  const warning = [
    msg('invoice.aiReadWarning'),
    ...(review.vatUnclear ? [msg('invoice.pdfVatUnclear')] : []),
    ...(pageBreakRows.length ? [msg('invoice.pdfPageBreak', { count: pageBreakRows.length })] : []),
    ...(review.metaConflict ? [msg('invoice.pdfMetaConflict')] : []),
    ...(review.sliceUnchecked ? [msg('invoice.pdfSliceUnchecked')] : []),
    ...pdfReadWarnings(note),
    ...pdfTotalsWarnings(totals),
    ...(missed.count ? [msg('invoice.pdfMissed', { count: missed.count, list: missed.trackings.slice(0, 3).join(', ') })] : []),
    ...(missed.tooLarge ? [msg('invoice.pdfMissedTooLarge')] : []),
  ].join('. ');
  const skippedAmount = Math.round(skippedRows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  return {
    fileId: o.file.id,
    format: 'pdf',
    aiLines,
    pdfCheck: check,
    aiSkipped: skippedRows.length ? { count: skippedRows.length, amount: skippedAmount } : { count: 0 },
    aiCached: metered.cached,
    guessedMeta: {
      invoiceNo: ai.invoiceNo ?? undefined,
      invoiceDate: ai.invoiceDate ?? undefined,
      currency: ai.currency ?? (await firmCurrency(o.companyId)),
    },
    warning,
    ...(suspicious ? { pdfReview: { vatUnclear, pageBreakRows, metaConflict: review.metaConflict } } : {}),
    ...(totals ? { pdfTotals: totals } : {}),
  };
}

/** 05-B2: toplam denetiminin önizleme uyarısı (toplam alanı olmayan eski okumada yok). */
export function pdfTotalsWarnings(t: PdfTotalsCheck | null): string[] {
  if (!t || t.status === 'ok') return [];
  if (t.status === 'vatSwapped') return [msg(t.basis === 'net' ? 'invoice.pdfTotalsVatIncluded' : 'invoice.pdfTotalsVatExcluded')];
  if (t.status === 'mismatch') return [msg('invoice.pdfTotalsMismatch', { pct: Math.max(1, Math.round(Math.abs(t.deviationPct ?? 0))) })];
  return [msg('invoice.pdfTotalsUnavailable')];
}

/** Okuma notunun önizleme uyarıları (Y20): varsayımlar, doğrulanamayan oran, çeviriler, kullanılmayan değerler. */
export function pdfReadWarnings(n: PdfReadNote): string[] {
  return [
    ...(n.vatUnverified ? [msg('invoice.pdfVatRateUnverified', { pct: n.vatPct })] : n.vatAssumed ? [msg('invoice.pdfVatAssumed', { pct: n.vatPct })] : []),
    ...(n.weightUnusable ? [msg('invoice.pdfWeightUnusable')] : n.weightAssumed ? [msg('invoice.pdfWeightAssumed')] : []),
    ...(n.weightUnit === 'lb' ? [msg('invoice.pdfWeightLb')] : n.weightUnit === 'g' ? [msg('invoice.pdfWeightG')] : []),
    ...(n.weightKeptLines ? [msg('invoice.pdfWeightKept', { count: n.weightKeptLines })] : []),
    ...(n.dimUnusable ? [msg('invoice.pdfDimUnusable')] : n.dimAssumed ? [msg('invoice.pdfDimAssumed')] : []),
    ...(n.dimUnit === 'in' ? [msg('invoice.pdfDimIn')] : []),
    ...(n.unitsMixed ? [msg('invoice.pdfUnitsMixed')] : []),
  ];
}

/** İşin girdisini okur; biçimi bozuksa (elle yazılmış satır) işi açık bir hatayla bitirir. */
function inputOf(job: ClaimedJob): InvoicePdfInput {
  const i = job.input as Partial<InvoicePdfInput>;
  if (i.v !== 1 || typeof i.fileId !== 'string' || !i.fileId) throw notFound(msg('invoice.uploadNotFound'));
  return {
    v: 1,
    locale: i.locale === 'en' ? 'en' : 'tr',
    aiLimits: i.aiLimits ?? {},
    fresh: i.fresh === true,
    fileId: i.fileId,
    ...(typeof i.carrierId === 'string' && i.carrierId ? { carrierId: i.carrierId } : {}),
  };
}

/** `JobContext.log`'u sayacın günlüğüne uydurur (sayaç `error` da yazar). */
export function meterLogOf(log: JobContext['log']): MeterLog {
  return { warn: (o, m) => log.warn(o, m ?? ''), error: (o, m) => log.warn(o, m ?? '') };
}

export const invoicePdfHandler: JobHandler = async (ctx) => {
  const { job } = ctx;
  const input = inputOf(job);
  const file = await prisma.file.findFirst({
    where: { id: input.fileId, companyId: job.companyId, kind: 'INVOICE_SOURCE', purgedAt: null },
    select: { id: true, path: true, preview: true },
  });
  if (!file) throw notFound(msg('invoice.uploadNotFound'));
  // Dil arka planda: çalıştırıcı `withLocale(input.locale)` açar; açmadıysa (eski satır) burada.
  const run = () =>
    readInvoicePdfPreview({
      companyId: job.companyId,
      file,
      // KALANLAR 6.5: durdurma süren yapay zekâ çağrısını da keser (yalnız durdurma; kapanış ve kira kaybı kesmez)
      ctx: aiJobContext(job, 'INVOICE_PDF', { type: 'File', id: file.id }, meterLogOf(ctx.log), jobCancelSignal(ctx.signal)),
      pageTexts: readPdfPreview(file.preview)?.pageTexts ?? null,
      onStage: (stage, p) => ctx.progress({ stage, ...p }),
      // ilerleme sayfa cinsinden: `done` / `total` okunmuş / toplam sayfa, okunan grup `counters.from`–`counters.to`
      onPart: (p) => ctx.progress({ stage: 'pdfPages', done: p.done, total: p.total, counters: { from: p.from, to: p.to } }),
      signal: ctx.signal,
      carrierId: input.carrierId ?? null,
    });
  return currentLocale() === input.locale ? run() : withLocale(input.locale, run);
};

// ---------------------------------------------------------------------------------------------
// Temizlik kancası: önizleme dosyası (§4.12)

/** `JOB_KINDS.INVOICE_PDF_READ.cleanup`: başarısız, durdurulmuş ya da bırakılmış okumanın önizleme dosyası silinir. */
export async function invoicePdfCleanup(job: ClaimedJob): Promise<void> {
  const fileId = typeof job.input.fileId === 'string' ? job.input.fileId : null;
  if (!fileId) return;
  await discardPreviewFile(job.companyId, fileId, { exceptJobId: job.id });
}
