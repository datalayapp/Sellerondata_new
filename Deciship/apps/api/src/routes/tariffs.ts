import { firmCurrency, readSettings } from '../lib/settings.ts';
import { currentLocale, m } from '../i18n/index.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  carrierScope,
  chargeableWeight,
  detectDocumentFacts,
  detectFormat,
  expectedCharge,
  scanPdfLayout,
  scopeDivisor,
  type RawTariffFile,
  type Locale,
  type TariffImportOptions,
} from '@deciship/core';
import { prisma } from '../db.ts';
import { AppError, badRequest, emptyFile, forbiddenFor, notFound } from '../errors.ts';
import { can } from '../lib/access.ts';
import { readTariffFile, registerFileErrorHeaders } from '../lib/fileWorkers.ts';
import { audit } from '../lib/audit.ts';
import { discardStored, readStored, storeBuffer } from '../lib/storage.ts';
import { idParam, num } from '../lib/util.ts';
import { tariffInclude, toTariffInput } from '../services/compare.ts';
import { buildTariffTemplate } from '../services/tariffExcel.ts';
import {
  applyCountryAdjustment,
  countryAdjustmentSchema,
  createTariff,
  lockCarrierDefault,
  readVersionLabel,
  versionLabel,
  assertNoDuplicateRows,
  replaceTariffVersioned,
  serializeTariffFull,
  tariffBody,
  type TariffFull,
} from '../services/tariffs.ts';
import { invoiceTariffHealth } from '../services/tariffHealth.ts';
import { assertStorageQuota } from '../services/storageQuota.ts';
import { aiDisabled, aiEnabled } from '../services/ai.ts';
import { aiContext, assertAiQuota, assertAiRate, freshQuery, registerAiErrorHeaders, type AiCallContext, type AiKind } from '../services/aiMeter.ts';
import { reviewTariffImport, type AiTariffReview } from '../services/aiTariffReview.ts';
import {
  analyze,
  appliedBody,
  applyMetaSchema,
  cleanupDrafts,
  importOptionsSchema,
  loadDraft,
  optionsKey,
  previewResponse,
  recentInvoiceContext,
  reviewInput,
  type DraftData,
  type ImportBase,
} from '../services/tariffImport.ts';
import {
  cleanupDocuments,
  loadDocument,
  pageHasText,
  readPdfLayout,
  readPdfText,
  type StoredScan,
  type StoredScans,
} from '../services/tariffPdf.ts';
import { tariffSaveCounts } from '../services/bulkRecalc.ts';
import { startBulkJob } from '../services/jobs/handlers/bulkRecompare.ts';
import {
  assertAiScanAvailable,
  extractBody,
  resolveSections,
  scanResponseOf,
  scanStampOf,
  suggestionServices,
  tariffExtractDedupeKey,
  tariffScanDedupeKey,
  type TariffExtractInput,
  type TariffScanInput,
} from '../services/jobs/handlers/tariffPdf.ts';
import { enqueueJob, findActiveJob, jobView, kickJob, requireAsync } from '../services/jobs/queue.ts';
import type { JobView } from '../services/jobs/types.ts';

/** Excel/CSV/PDF tarife dosyası üst sınırı (PDF sözleşmeler 10 MB'ı aşabilir). */
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

const quoteBody = z.object({
  lengthCm: z.number().positive().max(1000),
  widthCm: z.number().positive().max(1000),
  heightCm: z.number().positive().max(1000),
  weightKg: z.number().nonnegative().max(10000),
  destCountry: z.string().trim().max(3).toUpperCase().optional().nullable(),
  surchargeCodes: z.array(z.string()).optional(),
});

/** Toplu onay: önizlemenin özeti. */
const bulkConfirm = z.object({ token: z.string().min(1).max(200) });

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** PUT /tariffs/:id: düzenlenen hâlin `updatedAt`'i (GET yanıtındaki gibi ISO). Tutmazsa 409 STALE (rapor 10-B17). */
const expectedUpdatedAtBody = z.object({
  expectedUpdatedAt: z
    .string()
    .max(40)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), 'v.invalidDate')
    .optional(),
});

async function getOwned(id: string, companyId: string) {
  const t = await prisma.tariff.findFirst({
    where: { id, companyId },
    include: { ...tariffInclude, carrier: { select: { id: true, name: true, code: true } } },
  });
  if (!t) throw notFound(m('invoice.tariffNotFound'));
  return t;
}

async function getCarrier(carrierId: string, companyId: string) {
  const c = await prisma.carrier.findFirst({ where: { id: carrierId, companyId }, select: { id: true, name: true, code: true } });
  if (!c) throw notFound(m('carrier.notFound'));
  return c;
}

/** Taslağın içe aktarma bağlamı (önizleme, kontrol, inceleme ve uygulama aynı hâlden kurar). Yoksa ya da süresi geçtiyse 404. */
async function draftContext(draftId: string, companyId: string) {
  const draft = await loadDraft(draftId, companyId);
  const data = draft.data as unknown as DraftData;
  const carrier = await getCarrier(draft.carrierId, companyId);
  let base: ImportBase;
  if (draft.tariffId && !data.newTariff) {
    base = { kind: 'existing', current: serializeTariffFull(await getOwned(draft.tariffId, companyId)) };
  } else {
    const srcId = data.newTariff?.sourceTariffId ?? null;
    const src = srcId ? await prisma.tariff.findFirst({ where: { id: srcId, companyId }, include: tariffInclude }) : null;
    base = {
      kind: 'new',
      carrier,
      source: src ? serializeTariffFull(src) : null,
      name: data.newTariff?.name ?? null,
      service: data.newTariff?.service ?? null,
      defaultCurrency: await firmCurrency(companyId),
    };
  }
  const recent = await recentInvoiceContext(companyId, carrier.id);
  return { draft, data, carrier, base, recent };
}

/** `TARIFF_IMPORT_REVIEW` işinin girdisi (`Job.input`, dışarı verilmez). */
export type TariffReviewJobInput = {
  v: 1;
  locale: Locale;
  /** başlatma anındaki abonelik limitleri (kota hesabı) */
  aiLimits: Record<string, number | boolean>;
  draftId: string;
  options: TariffImportOptions;
};

/** Tekillik anahtarı: aynı taslağın aynı seçeneklerle aynı dildeki incelemesi tek iş. */
export const tariffReviewDedupeKey = (draftId: string, options: TariffImportOptions, locale: Locale) => `review:${draftId}:${optionsKey(options)}:${locale}`;

type StoredReview = AiTariffReview & { options?: TariffImportOptions; optionsKey?: string; reviewedAt?: string; jobId?: string };

/**
 * KALANLAR 6.18: tarife içe aktarmanın yapay zekâ incelemesi (arka plan işi `TARIFF_IMPORT_REVIEW` çağırır). Kod
 * kontrolleri bugünkü hâlden yeniden kurulur, inceleme taslağa (`aiReview`, seçeneklerin özetiyle) ve denetim kaydına
 * yazılır. Çift ücret olmaz: çağrı işe özgü önbellekle yapılır (kira kaybı, kapanış, süreç ölümünden sonraki deneme ödenmiş
 * sonucu ücretsiz alır), işin önceki denemesi incelemeyi taslağa yazdıysa (`aiReview.jobId`) hiç çağrılmaz. Taslak bu arada
 * uygulanıp silindiyse 404. Firma bağlamında çağrılır.
 */
export async function runTariffReview(o: { companyId: string; userId: string | null; draftId: string; options: TariffImportOptions; jobId: string; ai: AiCallContext }): Promise<AiTariffReview> {
  const { draft, data, carrier, base, recent } = await draftContext(o.draftId, o.companyId);
  const stored = draft.aiReview as StoredReview | null;
  if (stored?.jobId === o.jobId) {
    const { options: _o, optionsKey: _k, reviewedAt: _r, jobId: _j, ...review } = stored;
    return review;
  }
  if (!aiEnabled()) throw aiDisabled(m('pdf.aiOffReview'));
  const company = await prisma.company.findFirst({ where: { id: o.companyId }, select: { name: true } });
  const a = analyze(data.raw, base, recent, o.options, data.pdf);
  const { review, usage, usageId: aiUsageId } = await reviewTariffImport(
    reviewInput(a, draft.fileName, company?.name ?? '', { name: carrier.name, code: carrier.code }, recent),
    o.ai,
    { jobId: o.jobId },
  );
  // inceleme sürerken taslak uygulanıp silindiyse 404 (iç hata değil)
  const saved = await prisma.tariffImportDraft.updateMany({
    where: { id: draft.id, companyId: o.companyId },
    data: {
      aiReview: JSON.parse(
        JSON.stringify({ ...review, options: o.options, optionsKey: optionsKey(o.options), reviewedAt: new Date().toISOString(), jobId: o.jobId }),
      ),
    },
  });
  if (!saved.count) throw notFound(m('tariff.draftNotFound'));
  await audit(o.companyId, o.userId, 'tariff.import.review', 'Tariff', draft.tariffId, { draftId: draft.id, verdict: review.verdict, usage, ...(aiUsageId ? { aiUsageId } : {}) });
  return review;
}

export async function tariffRoutes(app: FastifyInstance) {
  registerAiErrorHeaders(app);
  registerFileErrorHeaders(app);
  const edit = { onRequest: app.requirePermission('deciship.tariffs.edit') };
  const view = { onRequest: app.requirePermission('deciship.tariffs.view') };
  /** Yalnız hesap yapar, kayıt değiştirmez: salt okunur abonelikte de çalışır. */
  const compute = { onRequest: app.requirePermission('deciship.tariffs.view', { readOnlyExempt: true }) };

  async function assertCarrier(carrierId: string, companyId: string) {
    const c = await prisma.carrier.findFirst({ where: { id: carrierId, companyId } });
    if (!c) throw badRequest('VALIDATION', m('carrier.notFound'), [{ path: 'carrierId', message: m('v.invalid') }]);
  }

  /**
   * Doldurulmuş şablon tarifenin fiyatlarını taşır ve `stripMoney` ikili dosyaya işlemez: düzenleme izninin yanında fiyat
   * izni de aranır (rapor XLSX/PDF ile aynı ikinci kat). Hesap `tariffs.edit → tariffs.view → prices.view` bağımlılığını
   * zorunlu tutar; bu, bağımlılığı taşımayan jetona karşıdır.
   */
  const editPriced = {
    ...edit,
    preHandler: async (req: FastifyRequest) => {
      if (!can(req, 'deciship.prices.view')) throw forbiddenFor(req);
    },
  };

  app.get('/tariffs/template.xlsx', editPriced, async (req, reply) => {
    const { tariffId } = z.object({ tariffId: z.string().optional() }).parse(req.query);
    let source;
    if (tariffId) source = serializeTariffFull(await getOwned(tariffId, req.auth.orgId));
    const buf = await buildTariffTemplate(source);
    reply.header('Content-Type', XLSX_MIME);
    reply.header('Content-Disposition', `attachment; filename="${m('template.fileName')}"`);
    return reply.send(buf);
  });

  app.get('/tariffs', view, async (req) => {
    const { carrierId } = z.object({ carrierId: z.string().optional() }).parse(req.query);
    const tariffs = await prisma.tariff.findMany({
      where: { companyId: req.auth.orgId, ...(carrierId ? { carrierId } : {}) },
      include: {
        carrier: { select: { id: true, name: true, code: true } },
        _count: { select: { zones: true, rates: true, surcharges: true } },
        rates: { select: { zone: true } },
      },
      orderBy: [{ carrier: { name: 'asc' } }, { isDefault: 'desc' }, { name: 'asc' }],
    });
    return {
      items: tariffs.map((t) => ({
        id: t.id,
        carrierId: t.carrierId,
        carrier: t.carrier,
        name: t.name,
        service: t.service,
        currency: t.currency,
        divisor: t.divisor,
        edgeRounding: t.edgeRounding,
        discountPct: num(t.discountPct),
        fuelPct: num(t.fuelPct),
        fuelVariable: t.fuelVariable,
        validFrom: t.validFrom ? t.validFrom.toISOString().slice(0, 10) : null,
        validTo: t.validTo ? t.validTo.toISOString().slice(0, 10) : null,
        active: t.active,
        isDefault: t.isDefault,
        zoneCount: new Set(t.rates.map((r) => r.zone)).size,
        countryCount: t._count.zones,
        rateCount: t._count.rates,
        surchargeCount: t._count.surcharges,
        updatedAt: t.updatedAt,
      })),
    };
  });

  app.post('/tariffs', edit, async (req, reply) => {
    const body = tariffBody.parse(req.body);
    assertNoDuplicateRows(body);
    await assertCarrier(body.carrierId, req.auth.orgId);
    const t = await prisma.$transaction((tx) => createTariff(req.auth.orgId, body, tx));
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.create', 'Tariff', t.id, { name: t.name });
    return reply.status(201).send({ tariff: serializeTariffFull(await getOwned(t.id, req.auth.orgId)) });
  });

  app.get('/tariffs/:id', view, async (req) => {
    const { id } = idParam.parse(req.params);
    const tariff = serializeTariffFull(await getOwned(id, req.auth.orgId));
    // Bu tarifenin sürümleriyle hesaplanmış (silinmemiş) fatura sayısı: tarife silinse de bu faturalar aynı rakamda kalır
    // (silme onayındaki "geçmiş faturalar etkilenmez" metni için).
    const pinnedInvoices = await prisma.invoice.count({
      where: { companyId: req.auth.orgId, deletedAt: null, tariffRevision: { tariffId: id } },
    });
    return { tariff, pinnedInvoices };
  });

  app.put('/tariffs/:id', edit, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = tariffBody.parse(req.body);
    const { expectedUpdatedAt } = expectedUpdatedAtBody.parse(req.body);
    assertNoDuplicateRows(body);
    await getOwned(id, req.auth.orgId);
    await assertCarrier(body.carrierId, req.auth.orgId);
    // önceki hâl kilit altında okunup sürüm olur; tarife bu arada değiştiyse 409 STALE, hiçbir şey yazılmaz
    await replaceTariffVersioned(id, req.auth.orgId, body, {
      userId: req.auth.membershipId,
      reason: 'EDIT',
      label: versionLabel('version.edit'),
      ...(expectedUpdatedAt ? { expectedUpdatedAt: new Date(expectedUpdatedAt) } : {}),
    });
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.update', 'Tariff', id, { name: body.name });
    return { tariff: serializeTariffFull(await getOwned(id, req.auth.orgId)), ...(await tariffSaveCounts(req.auth.orgId, id)) };
  });

  /**
   * Gerçek silme. Tarifenin fiyat sürümleri (TariffRevision) silinmez, yalnız `tariffId`leri boşalır (FK SET NULL);
   * faturalar `tariffRevisionId` ile aynı rakamda kalır ve sürümdeki adla "silindi" diye gösterilir.
   */
  app.delete('/tariffs/:id', edit, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await getOwned(id, req.auth.orgId);
    await prisma.tariff.delete({ where: { id } });
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.delete', 'Tariff', id);
    return reply.status(204).send();
  });

  /** Tek tıkla "Varsayılan yap": yeni faturalarda önseçili gelir; taşıyıcının diğer tarifelerinden işaret kalkar. */
  app.post('/tariffs/:id/default', edit, async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await getOwned(id, req.auth.orgId);
    if (!t.active) throw badRequest('TARIFF_INACTIVE', m('tariff.defaultInactive'));
    await prisma.$transaction(async (tx) => {
      // eşzamanlı iki "Varsayılan yap" iki varsayılan bırakmasın (02-B10): önce taşıyıcının kilidi
      await lockCarrierDefault(tx, req.auth.orgId, t.carrierId);
      // yalnız önceki varsayılan değişir: öbür tarifelerin `updatedAt`'i oynamaz (düzenleyende sahte STALE olmasın)
      await tx.tariff.updateMany({ where: { companyId: req.auth.orgId, carrierId: t.carrierId, id: { not: id }, isDefault: true }, data: { isDefault: false } });
      await tx.tariff.update({ where: { id }, data: { isDefault: true } });
    });
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.setDefault', 'Tariff', id, { name: t.name });
    return { tariff: serializeTariffFull(await getOwned(id, req.auth.orgId)) };
  });

  app.post('/tariffs/:id/duplicate', edit, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const src = serializeTariffFull(await getOwned(id, req.auth.orgId));
    const body = tariffBody.parse({ ...src, name: `${src.name} (kopya)`, isDefault: false, carrier: undefined });
    const t = await prisma.$transaction((tx) => createTariff(req.auth.orgId, body, tx));
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.duplicate', 'Tariff', t.id, { from: id });
    return reply.status(201).send({ tariff: serializeTariffFull(await getOwned(t.id, req.auth.orgId)) });
  });

  // ---------- Güvenli içe aktarma: önizleme (taslak) → kontrol → yapay zekâ incelemesi → uygula ----------
  // Excel/CSV → taslak; PDF → belge keşfi (bölümler) → çıkarma → taslak. Hedef: mevcut tarife ya da yeni tarife.

  async function readUpload(req: FastifyRequest) {
    if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', m('err.fileNotSent'));
    let upload: { buffer: Buffer; fileName: string } | undefined;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.fieldname === 'file') upload = { buffer, fileName: (part.filename || 'tarife').slice(0, 200) };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!upload) throw badRequest('VALIDATION', m('invoice.noFileSelected'));
    if (!upload.buffer.length) throw emptyFile();
    return { ...upload, fields };
  }

  type DocRow = Awaited<ReturnType<typeof loadDocument>>;
  // yeni tarifenin kapsamı (core `carrierScope`; KALANLAR 1.1): yurt içi 3000, yurt dışı 5000
  const defaultDivisor = (carrier: { code: string; name?: string | null }) => scopeDivisor(carrierScope(carrier));

  /** PDF yükleme yanıtı: tarama yok (kullanıcı "Kodla tara" / "Yapay zekâ ile tara" seçer). */
  function uploadResponse(doc: DocRow, carrier: { code: string; name: string }, defaultCurrency: string) {
    const facts = detectDocumentFacts(doc.pageTexts as unknown as string[]);
    return {
      kind: 'pdf' as const,
      documentId: doc.id,
      fileName: doc.fileName,
      pages: doc.pages,
      textLayer: doc.textLayer,
      aiAvailable: aiEnabled(),
      target: doc.tariffId ? { kind: 'existing' as const, tariffId: doc.tariffId } : { kind: 'new' as const, carrierId: doc.carrierId },
      ...(doc.tariffId
        ? {}
        : { suggestedDefaults: { currency: facts.currency ?? defaultCurrency, divisor: facts.dimDivisor ?? defaultDivisor(carrier) } }),
    };
  }

  /** Tarama yanıtı isteğin dilinde (gövde `services/jobs/handlers/tariffPdf.ts` `scanResponseOf`; iş de onu kullanır). */
  function scanResponse(req: FastifyRequest, doc: DocRow, scan: StoredScan, services: { invoiceServices: string[]; tariffService: string | null }) {
    return scanResponseOf(req.locale, doc, scan, services);
  }

  /** Yüklenen dosya → taslak (Excel/CSV) ya da PDF keşfi. tariff null = yeni tarife. */
  async function handleUpload(
    req: FastifyRequest,
    carrier: { id: string; name: string; code: string },
    tariff: TariffFull | null,
    upload: { buffer: Buffer; fileName: string },
  ) {
    const { orgId: companyId, membershipId: userId } = req.auth;
    const { buffer, fileName } = upload;
    const format = detectFormat(fileName, new Uint8Array(buffer));
    if (format === 'pdf') {
      // Y65: tarife PDF'i saklanır ve kotaya sayılır; alan doluysa okunmadan 413 STORAGE_QUOTA_EXCEEDED. Excel/CSV
      // tarifesi dosya olarak saklanmaz (taslak), durmaz.
      await assertStorageQuota(companyId, buffer.length);
      let pageTexts: string[];
      try {
        pageTexts = (await readPdfText(buffer, { companyId, connection: req.raw.socket })).pages;
      } catch (e) {
        // dosya havuzunun yük hataları (413 sayfa sınırı, 422, 503; Mesaj 6) olduğu gibi geçer
        if (e instanceof AppError) throw e;
        throw badRequest('INVALID_FILE', m('tariff.pdfUnreadable'));
      }
      await cleanupDocuments();
      const stored = await storeBuffer(companyId, buffer, 'pdf');
      // 06-B4: kayıt yazılamazsa dosya diskte sahipsiz kalmaz
      const doc = await prisma.tariffDocument
        .create({
          data: {
            companyId,
            carrierId: carrier.id,
            tariffId: tariff?.id ?? null,
            userId,
            fileName,
            path: stored.path,
            size: stored.size,
            sha256: stored.sha256,
            pages: pageTexts.length,
            textLayer: pageTexts.some(pageHasText),
            pageTexts,
            discovery: {},
          },
        })
        .catch(async (e: unknown) => {
          await discardStored(stored.path, req.log);
          throw e;
        });
      await audit(companyId, userId, 'tariff.import.pdf', 'Tariff', tariff?.id ?? null, { documentId: doc.id, fileName, pages: pageTexts.length });
      return uploadResponse(doc, carrier, await firmCurrency(companyId));
    }
    let raw: RawTariffFile;
    try {
      raw = await readTariffFile(fileName, new Uint8Array(buffer), { companyId, connection: req.raw.socket });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw badRequest('INVALID_FILE', m('tariff.fileUnreadable'));
    }
    await cleanupDrafts();
    const recent = await recentInvoiceContext(companyId, carrier.id);
    const base: ImportBase = tariff ? { kind: 'existing', current: tariff } : { kind: 'new', carrier, source: null, name: null, service: null, defaultCurrency: await firmCurrency(companyId) };
    const a = analyze(raw, base, recent, {});
    const data: DraftData = tariff ? { raw } : { raw, newTariff: { name: null, service: null, sourceTariffId: null } };
    const draft = await prisma.tariffImportDraft.create({
      data: { companyId, carrierId: carrier.id, tariffId: tariff?.id ?? null, userId, fileName, data: JSON.parse(JSON.stringify(data)) },
    });
    await audit(companyId, userId, 'tariff.import.preview', 'Tariff', tariff?.id ?? null, {
      draftId: draft.id,
      fileName,
      carrierId: carrier.id,
      newTariff: !tariff,
      rates: a.parsed.rates.length,
      errors: a.checks.filter((c) => c.severity === 'error').map((c) => c.code),
    });
    return previewResponse(draft.id, fileName, a);
  }

  app.post('/tariffs/:id/import', edit, async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await getOwned(id, req.auth.orgId);
    const upload = await readUpload(req);
    return handleUpload(req, t.carrier, serializeTariffFull(t), upload);
  });

  /** "Yeni tarife" ekranından: önce boş tarife kaydetmeden içe aktarma. */
  app.post('/tariff-imports', edit, async (req) => {
    const upload = await readUpload(req);
    const carrierId = upload.fields.carrierId?.trim();
    if (!carrierId) throw badRequest('VALIDATION', m('carrier.notSelected'), [{ path: 'carrierId', message: m('v.required') }]);
    const carrier = await getCarrier(carrierId, req.auth.orgId);
    return handleUpload(req, carrier, null, upload);
  });

  app.get('/tariff-documents/:documentId', view, async (req) => {
    const { documentId } = z.object({ documentId: z.string() }).parse(req.params);
    const doc = await loadDocument(documentId, req.auth.orgId);
    const carrier = await getCarrier(doc.carrierId, req.auth.orgId);
    const scans = (doc.discovery ?? {}) as StoredScans;
    const last = [scans.code, scans.ai].filter((x): x is StoredScan => !!x).sort((x, y) => y.scannedAt.localeCompare(x.scannedAt))[0];
    return { ...uploadResponse(doc, carrier, await firmCurrency(req.auth.orgId)), lastScan: last ? scanResponse(req, doc, last, await suggestionServices(doc, req.auth.orgId)) : null };
  });

  /**
   * Mesaj 7 (plan §4.7, §4.9): tarife PDF işini başlatır ya da aynı anahtarla süren işe bağlanır. Yeni iş açılmadan önce
   * kota ve kişi başı dakika sınırı denetlenir (`ai`: yapay zekâ çağrısı olacaksa); doluysa 429, iş açılmaz.
   */
  async function startDocumentJob(
    req: FastifyRequest,
    o: { kind: 'TARIFF_PDF_SCAN' | 'TARIFF_PDF_EXTRACT'; dedupeKey: string; doc: DocRow; input: Record<string, unknown>; ai: AiKind | null },
  ): Promise<{ job: JobView; joined: boolean }> {
    const { orgId: companyId, membershipId: userId } = req.auth;
    const active = await findActiveJob(companyId, o.kind, o.dedupeKey);
    if (active) return { job: await jobView(req, active), joined: true };
    if (o.ai) {
      const ctx = aiContext(req, o.ai);
      await assertAiQuota(ctx);
      assertAiRate(ctx);
    }
    const started = await enqueueJob({
      companyId,
      createdById: userId,
      kind: o.kind,
      dedupeKey: o.dedupeKey,
      ref: { type: 'TariffDocument', id: o.doc.id },
      label: o.doc.fileName.slice(0, 200),
      input: o.input,
    });
    if (!started.joined) await kickJob(started.jobId, req.log);
    return { job: await jobView(req, started.jobId), joined: started.joined };
  }

  /** İşin girdisinin ortak parçası: dil, başlatma anındaki limitler, `?fresh=1`. */
  const jobInputBase = (req: FastifyRequest, documentId: string) => ({
    v: 1 as const,
    locale: req.locale,
    aiLimits: { ...(req.auth.subscription?.limits ?? {}) },
    fresh: freshQuery(req),
    documentId,
  });

  /**
   * Tuşla tarama: code = metin katmanından kodla (yapay zekâsız, hızlı, her zaman eşzamanlı); ai = yapay zekâ keşfi.
   * `mode: 'ai'` yalnız arka planda (Mesaj 7, Y83): `?async=1` → 202 `{ job, joined }`, sonuç `GET /jobs/:id` `result`'ta;
   * `async` yoksa 400 `ASYNC_REQUIRED`.
   */
  app.post('/tariff-documents/:documentId/scan', edit, async (req, reply) => {
    const { documentId } = z.object({ documentId: z.string() }).parse(req.params);
    const { mode } = z.object({ mode: z.enum(['code', 'ai']) }).parse(req.body ?? {});
    const { orgId: companyId, membershipId: userId } = req.auth;
    const doc = await loadDocument(documentId, companyId);
    if (mode === 'ai') {
      assertAiScanAvailable(doc);
      requireAsync(req);
      const input: TariffScanInput = jobInputBase(req, doc.id);
      const started = await startDocumentJob(req, { kind: 'TARIFF_PDF_SCAN', dedupeKey: tariffScanDedupeKey(doc.id, input.locale, input.fresh), doc, input, ai: 'TARIFF_PDF_DISCOVER' });
      return reply.status(202).send(started);
    }
    const pageTexts = doc.pageTexts as unknown as string[];
    const started = Date.now();
    let sections: StoredScan['sections'] = [];
    let countries: StoredScan['countries'] = [];
    let discountTables: StoredScan['discountTables'] = [];
    let document: StoredScan['document'];
    if (doc.textLayer) {
      const r = scanPdfLayout(await readPdfLayout(await readStored(doc.path), { companyId, connection: req.raw.socket }));
      sections = r.sections;
      countries = r.countries;
      discountTables = r.discountTables;
      document = r.document;
    } else {
      document = { ...detectDocumentFacts(pageTexts), countryZonePages: [] };
    }
    const scan: StoredScan = { mode, document, sections, countries, discountTables, scannedAt: new Date().toISOString() };
    const scans = { ...((doc.discovery ?? {}) as StoredScans), [mode]: scan };
    await prisma.tariffDocument.update({ where: { id: doc.id }, data: { discovery: JSON.parse(JSON.stringify(scans)) } });
    await audit(companyId, userId, 'tariff.import.pdf.scan', 'Tariff', doc.tariffId, {
      documentId: doc.id,
      mode,
      sections: scan.sections.length,
      countries: scan.countries?.length ?? null,
      usage: null,
      ms: Date.now() - started,
    });
    return scanResponse(req, doc, scan, await suggestionServices(doc, companyId));
  });

  /**
   * Seçilen bölümleri okur → taslak. Kodla bulunan bölümler anında; yapay zekâ bölümleri 1–3 dk sürebilir (gövde
   * `services/jobs/handlers/tariffPdf.ts` `runExtraction`, iş onu çağırır). Yalnız arka planda (Mesaj 7, Y83):
   * `?async=1` → 202 `{ job, joined }`, sonuç `GET /jobs/:id`; `async` yoksa 400 `ASYNC_REQUIRED`. Seçim hatası iş
   * açılmadan hemen 400 (VALIDATION).
   */
  app.post('/tariff-documents/:documentId/extract', edit, async (req, reply) => {
    const { documentId } = z.object({ documentId: z.string() }).parse(req.params);
    const body = extractBody.parse(req.body ?? {});
    const doc = await loadDocument(documentId, req.auth.orgId);
    const { ai } = resolveSections(doc, body.sectionIds); // geçersiz seçimi hemen bildir (arka plan işinde değil)
    requireAsync(req);
    if (ai.length && !aiEnabled()) throw aiDisabled(m('pdf.aiOffSections'));
    const input: TariffExtractInput = { ...jobInputBase(req, doc.id), body, scans: scanStampOf(doc) };
    const started = await startDocumentJob(req, {
      kind: 'TARIFF_PDF_EXTRACT',
      dedupeKey: tariffExtractDedupeKey(doc.id, body, input.scans, input.locale, input.fresh),
      doc,
      input,
      ai: ai.length ? 'TARIFF_PDF_EXTRACT' : null,
    });
    return reply.status(202).send(started);
  });

  app.post('/tariff-imports/:draftId/recheck', edit, async (req) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    const { options } = z.object({ options: importOptionsSchema }).parse(req.body ?? {});
    const { draft, data, base, recent } = await draftContext(draftId, req.auth.orgId);
    return previewResponse(draft.id, draft.fileName, analyze(data.raw, base, recent, options, data.pdf));
  });

  /**
   * KALANLAR 6.18: yapay zekâ incelemesi yalnız arka planda (Y83 ile aynı kural): `?async=1` → 202 `{ job, joined }`,
   * sonuç `GET /jobs/:id` `result` (bugünkü inceleme yanıtı). `async` yoksa 400 `ASYNC_REQUIRED`. Taslak yoksa 404,
   * anahtar yoksa 503 `AI_DISABLED` ondan önce. Kota ve kişi başı dakika sınırı iş açılmadan (429).
   */
  app.post('/tariff-imports/:draftId/review', edit, async (req, reply) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    const { options } = z.object({ options: importOptionsSchema }).parse(req.body ?? {});
    const { orgId: companyId, membershipId: userId } = req.auth;
    const draft = await loadDraft(draftId, companyId);
    if (!aiEnabled()) throw aiDisabled(m('pdf.aiOffReview'));
    requireAsync(req);
    const dedupeKey = tariffReviewDedupeKey(draft.id, options, req.locale);
    const active = await findActiveJob(companyId, 'TARIFF_IMPORT_REVIEW', dedupeKey);
    if (active) return reply.status(202).send({ job: await jobView(req, active), joined: true });
    const ai = aiContext(req, 'TARIFF_REVIEW', { type: 'TariffImportDraft', id: draft.id });
    await assertAiQuota(ai);
    assertAiRate(ai);
    const input: TariffReviewJobInput = { v: 1, locale: req.locale, aiLimits: { ...(req.auth.subscription?.limits ?? {}) }, draftId: draft.id, options };
    const started = await enqueueJob({
      companyId,
      createdById: userId,
      kind: 'TARIFF_IMPORT_REVIEW',
      dedupeKey,
      ref: { type: 'TariffImportDraft', id: draft.id },
      label: draft.fileName.slice(0, 200),
      input,
    });
    if (!started.joined) await kickJob(started.jobId, req.log);
    return reply.status(202).send({ job: await jobView(req, started.jobId), joined: started.joined });
  });

  app.post('/tariff-imports/:draftId/apply', edit, async (req) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    const parsedBody = z
      .object({ options: importOptionsSchema, acknowledged: z.boolean().default(false), meta: applyMetaSchema.optional() })
      .parse(req.body ?? {});
    const { acknowledged, meta } = parsedBody;
    const { orgId: companyId, membershipId: userId } = req.auth;
    const { draft, data, base, recent } = await draftContext(draftId, companyId);
    if (base.kind === 'new' && !meta?.name?.trim()) {
      throw badRequest('VALIDATION', m('tariff.nameRequired'), [{ path: 'meta.name', message: m('v.required') }]);
    }
    // meta.currency seçeneklerle aynı kontrolden geçer (para birimi farkı bu para birimine göre denetlenir)
    const options = meta?.currency ? { ...parsedBody.options, currency: meta.currency } : parsedBody.options;
    const a = analyze(data.raw, base, recent, options, data.pdf);
    if (a.checks.some((c) => c.severity === 'error')) {
      throw new AppError(422, 'IMPORT_BLOCKED', m('tariff.importBlocked'), { checks: a.checks });
    }
    const stored = draft.aiReview as unknown as (AiTariffReview & { optionsKey?: string; options?: TariffImportOptions }) | null;
    // inceleme başka seçeneklerle yapıldıysa (ör. para birimi sonradan değişti) yapılmamış sayılır
    const storedKey = stored ? (stored.optionsKey ?? optionsKey(stored.options ?? {})) : null;
    const review = stored && storedKey === optionsKey(options) ? stored : null;
    // Yeni tarifede indirimi kullanıcı yazdıysa "dosyada indirim yok" uyarısının onayı kalmaz. Diğer uyarılar aynen onay ister.
    const discountGiven = a.base.kind === 'new' && meta?.discountPct !== undefined;
    const warnings = a.checks.filter((c) => c.severity === 'warning' && !(discountGiven && c.code === 'NO_DISCOUNT'));
    // onay: kod uyarısı varsa ya da (istenirse yapılan) yapay zekâ incelemesi "ok" değilse; temiz dosya onaysız uygulanır
    if ((warnings.length || (review && review.verdict !== 'ok')) && !acknowledged) {
      throw new AppError(409, 'ACK_REQUIRED', m('tariff.ackRequired'), {
        warnings: warnings.map((c) => c.code),
        aiVerdict: review?.verdict ?? null,
        aiReviewed: !!review,
        aiStale: !!stored && !review,
        aiAvailable: aiEnabled(),
      });
    }
    let isDefault = false;
    if (base.kind === 'new') {
      isDefault = !(await prisma.tariff.count({ where: { companyId, carrierId: base.carrier.id, active: true } }));
    }
    const body = appliedBody(a, meta, { isDefault });
    if (body.validFrom && body.validTo && body.validFrom > body.validTo) {
      throw badRequest('VALIDATION', m('tariff.validityOrder'), [{ path: 'meta.validFrom', message: m('v.afterEnd') }]);
    }
    let tariffId: string;
    let versionId: string | null = null;
    if (base.kind === 'existing') {
      // önceki hâl kilit altında, aynı işlemde saklanır (rapor 02-B4). Gövde (dosyada olmayan ek ücret, bölge, ad…) az
      // önce okunan hâlden kuruldu: o hâl bu arada değiştiyse 409 STALE, araya giren kayıt eski hâlle ezilmez.
      ({ versionId } = await replaceTariffVersioned(base.current.id, companyId, body, {
        userId,
        reason: 'IMPORT',
        label: versionLabel('version.import', { fileName: draft.fileName }),
        expectedUpdatedAt: base.current.updatedAt,
      }));
      tariffId = base.current.id;
    } else {
      const t = await prisma.$transaction((tx) => createTariff(companyId, body, tx));
      tariffId = t.id;
    }
    await prisma.tariffImportDraft.delete({ where: { id: draft.id } }).catch(() => undefined);
    const usage = await tariffSaveCounts(companyId, tariffId);
    await audit(companyId, userId, base.kind === 'new' ? 'tariff.import.create' : 'tariff.import', 'Tariff', tariffId, {
      fileName: draft.fileName,
      versionId,
      options,
      meta: meta ?? null,
      acknowledged,
      aiVerdict: review?.verdict ?? null,
      source: data.pdf ? { documentId: data.pdf.documentId, sectionIds: data.pdf.sectionIds } : null,
      rates: body.rates.length,
      zones: body.zones.length,
      surcharges: body.surcharges.length,
    });
    return { tariff: serializeTariffFull(await getOwned(tariffId, companyId)), versionId, ...usage };
  });

  // ---------- Sürümler ----------

  app.get('/tariffs/:id/versions', view, async (req) => {
    const { id } = idParam.parse(req.params);
    await getOwned(id, req.auth.orgId);
    const items = await prisma.tariffVersion.findMany({
      where: { tariffId: id, companyId: req.auth.orgId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        createdAt: true,
        reason: true,
        label: true,
        rateCount: true,
        zoneCount: true,
        countryCount: true,
        currency: true,
        user: { select: { name: true } },
      },
    });
    // Geri alma etiketindeki saat firmanın saat diliminde (Y132; yalnız gösterim).
    const company = await prisma.company.findFirst({ where: { id: req.auth.orgId }, select: { settings: true } });
    const { timeZone } = readSettings(company?.settings);
    return { items: items.map((v) => ({ ...v, label: readVersionLabel(v.label, currentLocale(), timeZone) })) };
  });

  app.post('/tariffs/:id/versions/:versionId/restore', edit, async (req) => {
    const { id, versionId } = z.object({ id: z.string(), versionId: z.string() }).parse(req.params);
    const t = await getOwned(id, req.auth.orgId);
    const v = await prisma.tariffVersion.findFirst({ where: { id: versionId, tariffId: id, companyId: req.auth.orgId } });
    if (!v) throw notFound(m('tariff.versionNotFound'));
    const parsed = tariffBody.safeParse(v.snapshot);
    if (!parsed.success) throw badRequest('INVALID_VERSION', m('tariff.versionUnreadable'));
    const body = parsed.data;
    const carrierOk = await prisma.carrier.findFirst({ where: { id: body.carrierId, companyId: req.auth.orgId } });
    if (!carrierOk) body.carrierId = t.carrierId;
    // önceki hâl kilit altında, aynı işlemde saklanır (rapor 02-B4)
    const before = await replaceTariffVersioned(id, req.auth.orgId, body, {
      userId: req.auth.membershipId,
      reason: 'RESTORE',
      label: versionLabel('version.restore', { at: v.createdAt.toISOString() }),
    });
    const usage = await tariffSaveCounts(req.auth.orgId, id);
    await audit(req.auth.orgId, req.auth.membershipId, 'tariff.restore', 'Tariff', id, { versionId, backupVersionId: before.versionId });
    return { tariff: serializeTariffFull(await getOwned(id, req.auth.orgId)), versionId: before.versionId, ...usage };
  });

  /**
   * Mesaj 4: tarife değişince eski faturalar eski sürümle kalır; bu iki uç onları bugünkü sürüme toplu geçirir
   * (`services/bulkRecalc.ts`). Önizleme yazmaz; onay önizlemenin `token`'ıyla gelir, tutmuyorsa 409 `PREVIEW_STALE`.
   * Yalnız arka planda (Mesaj 7, Y83): `?async=1` → 202 `{ job, joined }`, iş `services/jobs/handlers/bulkRecompare.ts`;
   * sonuç `GET /jobs/:id`. `async` yoksa 400 `ASYNC_REQUIRED`. Uygulamada süren iş başka özetle açılmışsa 409
   * `JOB_ACTIVE`; işteki bayat özet `job.error.code = 'PREVIEW_STALE'`.
   */
  app.post('/tariffs/:id/recompare-invoices/preview', edit, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = await getOwned(id, req.auth.orgId);
    requireAsync(req);
    const scope = { kind: 'tariff' as const, tariffId: id };
    return reply.status(202).send(await startBulkJob(req, { kind: 'BULK_RECOMPARE_PREVIEW', scope, label: t.name }));
  });

  app.post('/tariffs/:id/recompare-invoices', edit, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = await getOwned(id, req.auth.orgId);
    const { token } = bulkConfirm.parse(req.body ?? {});
    requireAsync(req);
    const scope = { kind: 'tariff' as const, tariffId: id };
    return reply.status(202).send(await startBulkJob(req, { kind: 'BULK_RECOMPARE_APPLY', scope, label: t.name, token }));
  });

  /**
   * SPEC §3.9: ülke istisnası ekler/günceller (pct 0 → kaldırır). Önce tarifenin hâli sürüm olarak saklanır.
   * Mesaj 4: fatura hesaplanmaz (yeni tarife sürümü doğar, faturalar sabit dayanağıyla kalır; web ardından toplu
   * önizlemeyi açar), `totals` her zaman null. `invoiceId` verilirse o faturanın tarife uyumu raporu döner (faturanın
   * kayıtlı sürümüne göre).
   */
  app.post('/tariffs/:id/country-adjustments', edit, async (req) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const body = countryAdjustmentSchema.parse(req.body);
    const t = await getOwned(id, companyId);
    if (body.invoiceId) {
      const inv = await prisma.invoice.findFirst({ where: { id: body.invoiceId, companyId, deletedAt: null }, select: { id: true } });
      if (!inv) throw notFound(m('invoice.notFoundRefresh'));
    }
    const label = body.pct === 0 ? versionLabel('version.adjustmentRemoved', { country: body.country }) : versionLabel('version.adjustmentApplied', { country: body.country, pct: body.pct });
    // önceki hâl ve yeni liste kilit altında okunur: eşzamanlı kayıt ya da ikinci istisna kaybolmaz (rapor 02-B4)
    const { versionId } = await applyCountryAdjustment(t.id, companyId, body, { userId, label });
    await audit(companyId, userId, 'tariff.countryAdjustment', 'Tariff', id, { ...body, versionId });
    const health = body.invoiceId ? await invoiceTariffHealth(body.invoiceId, companyId) : null;
    return { tariff: serializeTariffFull(await getOwned(id, companyId)), versionId, totals: null, health };
  });

  app.post('/tariffs/:id/quote', compute, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = quoteBody.parse(req.body);
    const t = await getOwned(id, req.auth.orgId);
    const input = toTariffInput(t);
    const cw = chargeableWeight({
      dims: { l: body.lengthCm, w: body.widthCm, h: body.heightCm },
      actualKg: body.weightKg,
      divisor: input.divisor,
      edgeRounding: input.edgeRounding,
      steps: input.weightSteps,
      rates: input.rates,
    });
    const result = expectedCharge({
      tariff: input,
      chargeableKg: cw.chargeable,
      destCountry: body.destCountry ?? undefined,
      surchargeCodes: body.surchargeCodes,
    });
    return { ...result, chargeableKg: cw.chargeable, volumetricKg: cw.volumetric, basis: cw.basis, currency: input.currency };
  });
}
