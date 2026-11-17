/**
 * Tarife PDF'inin uzun yapay zekâ adımları (Mesaj 7, plan §4.2): `TARIFF_PDF_SCAN` (yapay zekâ ile tablo arama) ve
 * `TARIFF_PDF_EXTRACT` (seçilen tablolardan fiyat okuma → içe aktarma taslağı).
 *
 * Uçlar (`routes/tariffs.ts`) `?async=1` ile işi kuyruğa koyar; `async` yoksa 400 `ASYNC_REQUIRED` (Y83: eski eşzamanlı
 * yol ve eski `GET /tariff-documents/:id/jobs/:jobId` ucu kaldırıldı, Y90). İş yalnız `GET /jobs/:id` ile okunur.
 *
 * Metinler işin dilinde (`input.locale`, çalıştırıcı `withLocale` açar): tarama yanıtı ve taslak bu dilde üretilir. Denetim
 * kaydı işi başlatanın adıyla (`createdById`).
 */
import crypto from 'node:crypto';
import { localizePdfSectionTitle, localizeText, suggestPdfSectionChoice, type Locale } from '@deciship/core';
import { z } from 'zod';
import { prisma } from '../../../db.ts';
import { AppError, badRequest, notFound } from '../../../errors.ts';
import { currentLocale, m, withLocale } from '../../../i18n/index.ts';
import { audit } from '../../../lib/audit.ts';
import { firmCurrency } from '../../../lib/settings.ts';
import { readStored } from '../../../lib/storage.ts';
import { aiDisabled, aiEnabled, type AiUsage } from '../../ai.ts';
import { aiJobContext, type AiCallContext } from '../../aiMeter.ts';
import { tariffInclude } from '../../compare.ts';
import { analyze, cleanupDrafts, previewResponse, recentInvoiceContext, type DraftData, type ImportBase, type PdfDraftInfo } from '../../tariffImport.ts';
import {
  applyListDiscountSelection,
  buildPdfImport,
  discoverPdf,
  extractPdfSections,
  listDiscountLinks,
  loadDocument,
  type PdfExtraction,
  type StoredScan,
  type StoredScans,
} from '../../tariffPdf.ts';
import { serializeTariffFull, type TariffFull } from '../../tariffs.ts';
import { jobCancelSignal } from '../runner.ts';
import { JobCancelled, type ClaimedJob, type JobHandler, type JobStage } from '../types.ts';
import { meterLogOf } from './invoicePdf.ts';

export type TariffDocRow = Awaited<ReturnType<typeof loadDocument>>;

/** `POST /tariff-documents/:id/extract` gövdesi (uç iş açmadan önce bununla doğrular, iş girdisi de aynı). */
export const extractBody = z.object({
  sectionIds: z.array(z.string()).min(1, 'v.chooseTable'),
  includeCountryZones: z.boolean().default(true),
  /** listDiscount: seçilen tablolar liste fiyatı × indirim tablosuyla hesaplanır (karşılığı olanlar); table: tablodaki fiyat */
  pricing: z.enum(['table', 'listDiscount']).default('table'),
  target: z.union([
    z.object({ tariffId: z.string().min(1) }),
    z.object({
      newTariff: z.object({
        name: z.string().trim().max(120).nullable().optional(),
        service: z.string().trim().max(200).nullable().optional(),
      }),
    }),
  ]),
});
export type ExtractBody = z.infer<typeof extractBody>;

// ---------------------------------------------------------------------------------------------
// İş girdileri ve tekillik anahtarları (§4.2)

type BaseInput = { v: 1; locale: Locale; aiLimits: Record<string, number | boolean>; fresh: boolean; documentId: string };
export type TariffScanInput = BaseInput;
/**
 * `scans`: seçimin dayandığı taramaların zamanı (`discovery.code/ai.scannedAt`, R0 5). İş kuyrukta beklerken PDF yeniden
 * taranırsa bölüm kimlikleri (`c1`, `s1`…) başka tabloyu gösterebilir; çalışma anında zamanlar tutmazsa iş 409 `SCAN_CHANGED`.
 */
export type TariffExtractInput = BaseInput & { body: ExtractBody; scans: ScanStamp };

/** Belgenin o anki taramalarının zamanı (yoksa null). */
export type ScanStamp = { code: string | null; ai: string | null };
export function scanStampOf(doc: Pick<TariffDocRow, 'discovery'>): ScanStamp {
  const scans = (doc.discovery ?? {}) as StoredScans;
  return { code: scans.code?.scannedAt ?? null, ai: scans.ai?.scannedAt ?? null };
}

/** Seçim yapıldığından beri belge yeniden tarandıysa 409 `SCAN_CHANGED` (taslak yanlış tablodan oluşmasın). */
export function assertSameScans(doc: Pick<TariffDocRow, 'discovery'>, expected: unknown) {
  const now = scanStampOf(doc);
  const e = (expected ?? {}) as Partial<ScanStamp>;
  if (e.code !== now.code || e.ai !== now.ai) throw new AppError(409, 'SCAN_CHANGED', m('tariff.scanChanged'));
}

const freshSuffix = (fresh: boolean) => (fresh ? ':fresh' : '');
export const tariffScanDedupeKey = (documentId: string, locale: Locale, fresh: boolean) => `scan-ai:${documentId}:${locale}${freshSuffix(fresh)}`;
/** Seçim ve dayandığı taramalar anahtarda: yeniden taramadan sonra aynı seçim eski (bayatlamış) işe bağlanmaz, yeni iş açar. */
export const tariffExtractDedupeKey = (documentId: string, body: ExtractBody, scans: ScanStamp, locale: Locale, fresh: boolean) =>
  `extract:${documentId}:${crypto.createHash('sha256').update(JSON.stringify({ body, scans })).digest('hex')}:${locale}${freshSuffix(fresh)}`;

// ---------------------------------------------------------------------------------------------
// Ortak yardımcılar (uç ve iş)

async function getCarrier(carrierId: string, companyId: string) {
  const c = await prisma.carrier.findFirst({ where: { id: carrierId, companyId }, select: { id: true, name: true, code: true } });
  if (!c) throw notFound(m('carrier.notFound'));
  return c;
}

/** Öneri kaynakları: son faturalardaki hizmetler (sıklık sırasıyla) önce; hedef tarifenin hizmeti yalnız fatura yoksa. */
export async function suggestionServices(doc: TariffDocRow, companyId: string) {
  const recent = await recentInvoiceContext(companyId, doc.carrierId);
  const tariff = doc.tariffId ? await prisma.tariff.findFirst({ where: { id: doc.tariffId, companyId }, select: { service: true } }) : null;
  return { invoiceServices: recent.services, tariffService: tariff?.service ?? null };
}

/** Tarama yanıtı (`POST …/scan`, `GET /tariff-documents/:id` `lastScan`), istenen dilde. */
export function scanResponseOf(locale: Locale, doc: TariffDocRow, scan: StoredScan, services: { invoiceServices: string[]; tariffService: string | null }) {
  // liste × indirim: net bölüm → karşılık gelen liste bölümü + indirim tablosu (ve net sayfayla fark sayısı)
  const links = listDiscountLinks(scan);
  const sections = scan.sections.map(({ table: _t, ...rest }) => {
    const l = links.get(rest.id);
    return {
      ...rest,
      title: localizePdfSectionTitle(rest.title, locale),
      notes: rest.notes?.map((n) => localizeText(n, locale)),
      listDiscount: l
        ? {
            listSectionId: l.listSectionId,
            discountTableId: l.discountTableId,
            listPages: l.listPages,
            discountPages: l.discountPages,
            diff: l.diff ? { compared: l.diff.compared, differing: l.diff.differing, maxDiff: l.diff.maxDiff } : null,
          }
        : null,
    };
  });
  const hasCountryZones = scan.mode === 'code' ? (scan.countries?.length ?? 0) > 0 : scan.document.countryZonePages.length > 0;
  let message: string | null = null;
  if (!sections.length) {
    message = scan.mode === 'ai' ? m('tariff.scan.aiNone', undefined, locale) : doc.textLayer ? m('tariff.scan.codeNone', undefined, locale) : m('tariff.scan.imageOnly', undefined, locale);
  }
  const d = scan.document;
  const suggestion = suggestPdfSectionChoice(sections, services);
  return {
    mode: scan.mode,
    document: {
      carrier: d.carrier,
      validFrom: d.validFrom,
      currency: d.currency,
      weightUnit: d.weightUnit,
      dimDivisor: d.dimDivisor,
      fuel: d.fuel,
      notes: d.notes.map((n) => localizeText(n, locale)),
      surchargeNotes: d.surchargeNotes.map((n) => localizeText(n, locale)),
      countryZonePages: d.countryZonePages,
    },
    sections,
    suggestedSectionIds: suggestion.ids,
    /** 'invoices' → "Faturanıza uygun", 'tariff' → "Tarifenizle aynı hizmet", 'default' → "Önerilen" */
    suggestionSource: suggestion.source,
    /** 'listDiscount' → önerilen tablolar liste fiyatı × indirim tablosuyla hesaplanabilir (sözleşmedeki kesin hesap) */
    suggestedPricing: suggestion.pricing,
    discountTables: (scan.mode === 'code' ? (scan.discountTables ?? []) : []).map((t) => ({
      id: t.id,
      title: localizePdfSectionTitle(t.title, locale),
      service: t.service,
      direction: t.direction,
      pages: t.pages,
      zones: t.zones,
      bands: t.rows.filter((r) => r.packaging == null).length,
    })),
    hasCountryZones,
    message,
  };
}

/** Belgede yapay zekâ taraması açılabilir mi (anahtar yoksa 503; metin katmanı yoksa Excel/CSV'ye yönlendiren metin). */
export function assertAiScanAvailable(doc: TariffDocRow) {
  // Metin katmanı yoksa kodla tarama da bir şey bulamaz; kullanıcıyı iki ekran arasında döndürmeyelim.
  if (!aiEnabled()) throw aiDisabled(doc.textLayer ? m('pdf.aiOff') : m('pdf.aiOffImage'));
}

/** Bölümleri çözer: c… = kod taraması, s… = yapay zekâ taraması. Geçersiz seçim 400. */
export function resolveSections(doc: TariffDocRow, ids: string[]) {
  const scans = (doc.discovery ?? {}) as StoredScans;
  const found = ids.map((sid) => (sid.startsWith('c') ? scans.code : scans.ai)?.sections.find((s) => s.id === sid));
  if (!ids.length || found.some((s) => !s)) {
    throw badRequest('VALIDATION', m('tariff.sectionNotInDoc'), [{ path: 'sectionIds', message: m('v.invalid') }]);
  }
  const sections = found as StoredScan['sections'];
  return { scans, sections, code: sections.filter((s) => s.id.startsWith('c')), ai: sections.filter((s) => s.id.startsWith('s')) };
}

type StepHooks = { onStage?: (stage: JobStage) => Promise<void>; signal?: AbortSignal };

// ---------------------------------------------------------------------------------------------
// Yapay zekâ taraması

/**
 * Yapay zekâ ile tarama: bölüm listesi belgenin `discovery.ai` alanına yazılır (kod taraması korunur), denetim kaydı, yanıt.
 * Firma bağlamında çağrılır.
 */
export async function runAiScan(o: { companyId: string; userId: string | null; doc: TariffDocRow; ctx: AiCallContext } & StepHooks) {
  const { companyId, userId, doc } = o;
  const carrier = await getCarrier(doc.carrierId, companyId);
  assertAiScanAvailable(doc);
  await o.onStage?.('tariffScan');
  const started = Date.now();
  const r = await discoverPdf(await readStored(doc.path), doc.pageTexts as unknown as string[], { carrier: { name: carrier.name, code: carrier.code } }, o.ctx);
  if (o.signal?.aborted) throw new JobCancelled();
  const scan: StoredScan = { mode: 'ai', document: r.document, sections: r.sections, scannedAt: new Date().toISOString() };
  // Tarama uzun sürer: o arada yapılmış kod taraması ezilmesin diye belge yeniden okunur.
  const now = await prisma.tariffDocument.findFirst({ where: { id: doc.id, companyId }, select: { discovery: true } });
  const scans = { ...((now?.discovery ?? doc.discovery ?? {}) as StoredScans), ai: scan };
  await prisma.tariffDocument.updateMany({ where: { id: doc.id, companyId }, data: { discovery: JSON.parse(JSON.stringify(scans)) } });
  const usage: AiUsage | null = r.usage;
  await audit(companyId, userId, 'tariff.import.pdf.scan', 'Tariff', doc.tariffId, {
    documentId: doc.id,
    mode: 'ai',
    sections: scan.sections.length,
    countries: null,
    usage,
    ...(r.usageId ? { aiUsageId: r.usageId } : {}),
    ms: Date.now() - started,
  });
  return scanResponseOf(currentLocale(), doc, scan, await suggestionServices(doc, companyId));
}

// ---------------------------------------------------------------------------------------------
// Fiyat okuma (çıkarma) → taslak

/** Taslağın içe aktarma tabanı (`routes/tariffs.ts` `draftContext` ile aynı kural; yeni oluşturulmuş taslak için). */
async function importBase(companyId: string, carrier: { id: string; name: string; code: string }, tariff: TariffFull | null, newTariff: DraftData['newTariff']): Promise<ImportBase> {
  if (tariff && !newTariff) return { kind: 'existing', current: tariff };
  const srcId = newTariff?.sourceTariffId ?? null;
  const src = srcId ? await prisma.tariff.findFirst({ where: { id: srcId, companyId }, include: tariffInclude }) : null;
  return {
    kind: 'new',
    carrier,
    source: src ? serializeTariffFull(src) : null,
    name: newTariff?.name ?? null,
    service: newTariff?.service ?? null,
    defaultCurrency: await firmCurrency(companyId),
  };
}

/**
 * Seçilen bölümleri okur → taslak (`previewResponse`). Kodla bulunan bölümler anında; yapay zekâ bölümleri 1–3 dk sürebilir.
 * Firma bağlamında çağrılır. `aiCtx` istekten (`aiContext`) ya da işten (`aiJobContext`).
 */
export async function runExtraction(o: { companyId: string; userId: string | null; doc: TariffDocRow; body: ExtractBody; aiCtx: AiCallContext } & StepHooks) {
  const { companyId, userId, doc, body, aiCtx } = o;
  const resolved = resolveSections(doc, body.sectionIds);
  const { scans, ai } = resolved;
  let { sections, code } = resolved;
  let discountIssues: PdfDraftInfo['issues'] = [];
  if (body.pricing === 'listDiscount') {
    const r = applyListDiscountSelection(code, scans.code);
    code = r.sections;
    sections = [...code, ...ai];
    discountIssues = r.issues;
  }
  const carrier = await getCarrier(doc.carrierId, companyId);
  let tariff: TariffFull | null = null;
  if ('tariffId' in body.target) {
    if (!doc.tariffId) throw badRequest('VALIDATION', m('tariff.pdfForNewTariff'), [{ path: 'target', message: m('v.invalid') }]);
    const t = await prisma.tariff.findFirst({
      where: { id: body.target.tariffId, companyId },
      include: { ...tariffInclude, carrier: { select: { id: true, name: true, code: true } } },
    });
    if (!t) throw notFound(m('invoice.tariffNotFound'));
    if (t.carrierId !== doc.carrierId) throw badRequest('VALIDATION', m('tariff.targetCarrierMismatch'), [{ path: 'target.tariffId', message: m('v.invalid') }]);
    tariff = serializeTariffFull(t);
  }
  const pageTexts = doc.pageTexts as unknown as string[];
  const codeCountries = scans.code?.countries ?? [];
  // ülkeler: kod taramasında liste varsa o (yapay zekâsız); yoksa yapay zekâ bölümleri okunurken onunla
  const aiCountryPages = body.includeCountryZones && !codeCountries.length && ai.length ? (scans.ai?.document.countryZonePages ?? []) : [];
  let usage: AiUsage | null = null;
  let aiUsageId: string | null = null;
  const started = Date.now();
  const extraction: PdfExtraction = { tables: code.map((s) => s.table!), countries: [], notes: code.flatMap((s) => s.notes ?? []) };
  let pages = [...new Set(code.flatMap((s) => s.pages))];
  if (ai.length) {
    if (!aiEnabled()) throw aiDisabled(m('pdf.aiOffSections'));
    await o.onStage?.('tariffExtract');
    const r = await extractPdfSections(await readStored(doc.path), pageTexts, ai, aiCountryPages, aiCtx);
    if (o.signal?.aborted) throw new JobCancelled();
    usage = r.usage;
    aiUsageId = r.usageId;
    extraction.tables.push(...r.extraction.tables);
    extraction.countries.push(...r.extraction.countries);
    extraction.notes.push(...r.extraction.notes);
    pages.push(...r.pages);
  }
  const countriesFromCode = body.includeCountryZones && codeCountries.length > 0;
  if (countriesFromCode) {
    extraction.countries.push(...codeCountries);
    pages.push(...(scans.code?.document.countryZonePages ?? []));
  }
  pages = [...new Set(pages)].sort((x, y) => x - y);
  const document = (code.length ? scans.code?.document : scans.ai?.document) ?? scans.code?.document ?? scans.ai!.document;
  const built = buildPdfImport({
    fileName: doc.fileName,
    extraction,
    sections,
    document,
    pageTexts,
    includeCountryZones: countriesFromCode || aiCountryPages.length > 0,
    current: tariff ? { divisor: tariff.divisor, currency: tariff.currency } : null,
    codeSectionIds: new Set(code.map((s) => s.id)),
    currentZones: tariff?.zones ?? [],
  });
  const pdf: PdfDraftInfo = {
    documentId: doc.id,
    sectionIds: body.sectionIds,
    sectionTitles: built.sectionTitles,
    pages,
    includeCountryZones: body.includeCountryZones,
    verification: built.verification,
    issues: [...discountIssues, ...built.issues],
    suggestedMeta: built.suggestedMeta,
    document: document as unknown as Record<string, unknown>,
    priceType: built.priceType,
    ...(body.pricing === 'listDiscount' ? { pricing: body.pricing } : {}),
  };
  const newTariff =
    'newTariff' in body.target
      ? {
          name: body.target.newTariff.name?.trim() || null,
          service: body.target.newTariff.service?.trim() || null,
          sourceTariffId: doc.tariffId,
        }
      : undefined;
  const data: DraftData = { raw: built.raw, pdf, ...(newTariff ? { newTariff } : {}) };
  await cleanupDrafts();
  const draft = await prisma.tariffImportDraft.create({
    data: { companyId, carrierId: carrier.id, tariffId: tariff?.id ?? null, userId, fileName: doc.fileName, data: JSON.parse(JSON.stringify(data)) },
  });
  const recent = await recentInvoiceContext(companyId, carrier.id);
  const a = analyze(built.raw, await importBase(companyId, carrier, tariff, newTariff), recent, {}, pdf);
  await audit(companyId, userId, 'tariff.import.pdf.extract', 'Tariff', tariff?.id ?? null, {
    draftId: draft.id,
    documentId: doc.id,
    sectionIds: body.sectionIds,
    method: ai.length ? 'ai' : 'code',
    pricing: body.pricing,
    pages,
    rates: a.parsed.rates.length,
    verification: built.verification ? { checked: built.verification.checked, matched: built.verification.matched } : null,
    usage,
    ...(aiUsageId ? { aiUsageId } : {}),
    ms: Date.now() - started,
  });
  return previewResponse(draft.id, doc.fileName, a);
}

// ---------------------------------------------------------------------------------------------
// İşleyiciler

function baseInputOf(job: ClaimedJob): BaseInput {
  const i = job.input as Partial<BaseInput>;
  if (i.v !== 1 || typeof i.documentId !== 'string' || !i.documentId) throw notFound(m('pdf.notFound'));
  return { v: 1, locale: i.locale === 'en' ? 'en' : 'tr', aiLimits: i.aiLimits ?? {}, fresh: i.fresh === true, documentId: i.documentId };
}

const inLocale = <T>(locale: Locale, run: () => Promise<T>) => (currentLocale() === locale ? run() : withLocale(locale, run));

export const tariffScanHandler: JobHandler = async (ctx) => {
  const { job } = ctx;
  const input = baseInputOf(job);
  return inLocale(input.locale, async () => {
    const doc = await loadDocument(input.documentId, job.companyId);
    return runAiScan({
      companyId: job.companyId,
      userId: job.createdById,
      doc,
      ctx: aiJobContext(job, 'TARIFF_PDF_DISCOVER', { type: 'TariffDocument', id: doc.id }, meterLogOf(ctx.log), jobCancelSignal(ctx.signal)),
      onStage: (stage) => ctx.progress({ stage }),
      signal: ctx.signal,
    });
  });
};

export const tariffExtractHandler: JobHandler = async (ctx) => {
  const { job } = ctx;
  const input = baseInputOf(job);
  // gövde başlatırken doğrulandı; satırdaki değer yine şemadan geçer (elle yazılmış ya da eski satır)
  const body = extractBody.parse((job.input as { body?: unknown }).body);
  return inLocale(input.locale, async () => {
    const doc = await loadDocument(input.documentId, job.companyId);
    // iş beklerken belge yeniden tarandıysa seçim başka tabloyu gösterebilir: açık hatayla bit (R0 5)
    assertSameScans(doc, (job.input as { scans?: unknown }).scans);
    await ctx.progress({ stage: 'tariffExtract' });
    return runExtraction({
      companyId: job.companyId,
      userId: job.createdById,
      doc,
      body,
      aiCtx: aiJobContext(job, 'TARIFF_PDF_EXTRACT', { type: 'TariffDocument', id: doc.id }, meterLogOf(ctx.log), jobCancelSignal(ctx.signal)),
      signal: ctx.signal,
    });
  });
};
