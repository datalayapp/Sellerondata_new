import { m as msg } from '../i18n/index.ts';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  checkTracking,
  desi,
  extractTracking,
  normalizeTracking,
  stripScanNoise,
  trackingCandidates,
  TRACKING_HARD_MAX,
  TRACKING_HARD_MIN,
  volumetricWeight,
  type TrackingReason,
} from '@deciship/core';
import { prisma, Prisma, type Tx } from '../db.ts';
import { AppError, badRequest, conflict, emptyFile, forbiddenFor, notFound } from '../errors.ts';
import { can, requireAny } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { readSettings } from '../lib/settings.ts';
import { isCleanOutcome, stripImageMetadata, type StripOutcome } from '../lib/imageMeta.ts';
import { deleteStored, extFor, fileUrl, PHOTO_MIMES, storeBuffer } from '../lib/storage.ts';
import { zonedDate, zonedDayStart } from '../lib/time.ts';
import { idParam, likeEscape, num, paged, paginationSchema, parseDateInput } from '../lib/util.ts';
import { measurementChainIds } from '../services/compare.ts';
import { DEMO_CLIENT_ID_PREFIX } from '../services/demoTour.ts';
import { legacyFedex96Suffix, lockCurrent, lockTracking } from '../services/measurementLocks.ts';
import { arrivesLate, correctDeviceClock, lateVersionPlace, linkLateVersion, measuredAtOutOfRange } from '../services/measurementOrder.ts';
import { measurementPurgeBlock, purgeDeletedMeasurement } from '../services/measurementPurge.ts';
// Ölçüm kaydı karşılaştırmayı beklemez (Mesaj 7, §4.10): yanıttan sonra, süreç içi sınırlı sırada; işaret `recomparePendingAt`.
import { queueMeasurementRecompare, recompareWithin } from '../services/measurementQueue.ts';
import { limited } from '../services/hub/limiter.ts';
import { packagingOf, packagingSchema } from '../lib/packaging.ts';

/** Düzeltme ve geri yükleme yanıtı karşılaştırmayı en çok bu kadar bekler; dolarsa `recomparePending: true` (iş arkada sürer). */
const RECOMPARE_RESPONSE_WAIT_MS = 2_000;
const PHOTO_KINDS = ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER'] as const;
const DIM_METHODS = ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET'] as const;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Y147: ölçüm kaydı (ya da düzeltmesi) yazılamadıysa bu istekte diske yazılan fotoğraflar silinir; yoksa sahipsiz kalırdı.
 * Yollar bu istekte `storeBuffer` ile üretilen yeni adlardır; yine de bir `File` satırı yolu gösteriyorsa (işlem sonucu
 * belirsiz biten kayıt, aynı yolu taşıyan başka kayıt) o dosya silinmez. Okuma ya da silme hatası günlüğe yazılır,
 * asıl hatayı örtmez; dosya diskte kalır.
 */
export async function discardUnsavedPhotos(paths: string[], log: Pick<FastifyRequest['log'], 'warn'>): Promise<void> {
  if (!paths.length) return;
  let used: Set<string>;
  try {
    used = new Set((await prisma.file.findMany({ where: { path: { in: paths } }, select: { path: true } })).map((f) => f.path));
  } catch (err) {
    log.warn({ err, count: paths.length }, 'unsaved measurement photos kept: reference check failed');
    return;
  }
  for (const p of paths) {
    if (used.has(p)) continue;
    try {
      await deleteStored(p);
    } catch (err) {
      log.warn({ err }, 'unsaved measurement photo could not be deleted (orphan file left)');
    }
  }
}

const dim = z.coerce.number().positive().max(1000);
const createData = z.object({
  // Örnek veri öneki yalnız sunucunundur: deneme bitince bu önekli ölçümler silinir (services/demoTour.ts).
  clientId: z.string().trim().min(8).max(100).refine((v) => !v.startsWith(DEMO_CLIENT_ID_PREFIX), 'v.invalid'),
  trackingRaw: z.string().trim().min(1).max(200),
  lengthCm: dim,
  widthCm: dim,
  heightCm: dim,
  weightKg: z.coerce.number().positive().max(10000),
  dimMethod: z.enum(DIM_METHODS),
  weightMethod: z.enum(['OCR', 'MANUAL']),
  ocrWeightKg: z.coerce.number().nonnegative().max(10000).nullable().optional(),
  dimConfidence: z.coerce.number().min(0).max(1).nullable().optional(),
  boxPresetId: z.string().nullable().optional(),
  measuredAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
  note: z.string().max(1000).nullable().optional(),
  /** Gönderinin ambalajı (ölçü ekranındaki seçim). Eski uygulama göndermez: kendi ambalajı (OWN). */
  packaging: packagingSchema.optional(),
  photoKinds: z.array(z.enum(PHOTO_KINDS)).default([]),
  /** KALANLAR 6.7-a: kontrol ekranında görülüp bilerek yerine konan güncel ölçüm. Güncel değilse yok sayılır. */
  replacesId: z.string().trim().min(1).max(100).nullable().optional(),
  /** KALANLAR 6.7-b: cihazın gönderim anındaki saati (her denemede yeniden); saat farkı düzeltmesi için. */
  sentAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
});

/** SPEC 10.1 — JSON body, or the `data` field of a multipart body. */
const patchData = z.object({
  trackingRaw: z.string().trim().min(1).max(200).optional(),
  lengthCm: dim.optional(),
  widthCm: dim.optional(),
  heightCm: dim.optional(),
  weightKg: z.coerce.number().positive().max(10000).optional(),
  dimMethod: z.enum(DIM_METHODS).optional(),
  weightMethod: z.enum(['OCR', 'MANUAL']).optional(),
  boxPresetId: z.string().min(1).nullable().optional(),
  measuredAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
  note: z.string().max(1000).nullable().optional(),
  /** Ambalaj düzeltmesi: yeni sürüm açar ve faturalarla yeniden karşılaştırılır (ölçü düzeltmesi gibi). */
  packaging: packagingSchema.optional(),
  removePhotoIds: z.array(z.string()).default([]),
  photoKinds: z.array(z.enum(PHOTO_KINDS)).default([]),
});

/** Gün (YYYY-AA-GG) ya da tam zaman. `2026-1-1` motor yorumuna bırakılmaz: gün sınırı hesabı yanlış olurdu. */
function isDateInput(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return z.iso.datetime({ offset: true }).safeParse(s).success;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dateInput = z.string().refine(isDateInput, 'v.invalidDate').optional();

const listQuery = paginationSchema.extend({
  q: z.string().trim().optional(),
  from: dateInput,
  to: dateInput,
  userId: z.string().optional(),
  method: z.enum(DIM_METHODS).optional(),
  deleted: z.enum(['true', 'false', '1', '0']).optional(),
});

const measurementInclude = {
  measuredBy: { select: { id: true, name: true } },
  files: { select: { id: true, kind: true }, orderBy: { createdAt: 'asc' } },
} as const;
type MeasurementFull = Prisma.MeasurementGetPayload<{ include: typeof measurementInclude }>;

function dims(m: { lengthCm: Prisma.Decimal; widthCm: Prisma.Decimal; heightCm: Prisma.Decimal }) {
  return { l: num(m.lengthCm), w: num(m.widthCm), h: num(m.heightCm) };
}

export function serializeMeasurement(
  m: MeasurementFull,
  ctx: { showInvoiceStatus: boolean; desiDivisor: number; invoiceStatus?: string | null },
) {
  const d = dims(m);
  return {
    id: m.id,
    clientId: m.clientId,
    trackingNo: m.trackingNo,
    trackingRaw: m.trackingRaw,
    lengthCm: d.l,
    widthCm: d.w,
    heightCm: d.h,
    weightKg: num(m.weightKg),
    desi: desi(d, ctx.desiDivisor),
    volumetricKg5000: volumetricWeight(d, 5000),
    dimMethod: m.dimMethod,
    weightMethod: m.weightMethod,
    ocrWeightKg: m.ocrWeightKg != null ? num(m.ocrWeightKg) : null,
    dimConfidence: m.dimConfidence,
    boxPresetId: m.boxPresetId,
    packaging: m.packaging,
    note: m.note,
    measuredAt: m.measuredAt.toISOString(),
    measuredBy: { id: m.measuredBy.id, name: m.measuredBy.name },
    photoCount: m.files.length,
    version: m.version,
    superseded: m.supersededById != null,
    deleted: m.deletedAt != null,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    ...(ctx.showInvoiceStatus ? { invoiceStatus: ctx.invoiceStatus ?? null } : {}),
  };
}

async function desiDivisorOf(companyId: string) {
  const c = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
  return readSettings(c.settings).desiDivisor;
}

/** İçerik imzası: JPEG, PNG, WebP, HEIC/HEIF (ftyp). Tür başlığı tek başına güvenilmez. */
function looksLikeImage(b: Buffer): boolean {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return true;
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return true;
  return false;
}

/** `meta`: üst veri temizliğinin sonucu (Y24); temizlenemeyen kayıttan sonra dosya kimliğiyle günlüğe yazılır. */
type UploadedPhoto = { buffer: Buffer; mime: string; fileName: string; meta: StripOutcome };

/**
 * Y24 (inceleme B3): üst verisi temizlenemeyen (okunamayan ya da desteklenmeyen) fotoğraf olduğu gibi saklanır; hangi
 * dosya olduğu günlüğe dosya kimliğiyle yazılır. Kanıt ZIP'i bu dosyayı yeniden temizlemeyi dener, olmazsa eklemez
 * (`services/evidence.ts`). Günlük hatası kaydı düşürmez.
 */
export async function logUncleanPhotos(
  log: Pick<FastifyRequest['log'], 'warn'>,
  companyId: string,
  photos: { path: string; meta: StripOutcome; mime: string }[],
): Promise<void> {
  const unclean = photos.filter((p) => !isCleanOutcome(p.meta));
  if (!unclean.length) return;
  try {
    const rows = await prisma.file.findMany({ where: { companyId, path: { in: unclean.map((p) => p.path) } }, select: { id: true, path: true } });
    const idOf = new Map(rows.map((r) => [r.path, r.id]));
    for (const p of unclean) log.warn({ fileId: idOf.get(p.path) ?? null, outcome: p.meta, mime: p.mime }, 'measurement photo metadata not removed');
  } catch (err) {
    log.warn({ err, count: unclean.length }, 'measurement photo metadata not removed (file ids unknown)');
  }
}

async function readMultipart(req: FastifyRequest) {
  let dataRaw: string | undefined;
  const photos: UploadedPhoto[] = [];
  for await (const part of req.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 20 } })) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.fieldname === 'photos' || part.fieldname === 'photos[]' || part.fieldname === 'photo') {
        if (!buffer.length) throw emptyFile();
        if (!PHOTO_MIMES.has(part.mimetype.toLowerCase()) || !looksLikeImage(buffer)) {
          throw badRequest('INVALID_FILE', msg('measurement.photoType'));
        }
        // Y24: konum ve cihaz bilgisi (EXIF, XMP, IPTC) kaydetmeden önce kalkar; yön korunur. Saklanan bayt, boyut ve
        // sha256 temizlenmiş dosyanındır. Okunamayan ya da desteklenmeyen dosya olduğu gibi saklanır (ölçüm reddedilmez);
        // kayıttan sonra kimliğiyle günlüğe yazılır (`logUncleanPhotos`).
        const clean = stripImageMetadata(buffer);
        photos.push({ buffer: clean.buffer, mime: part.mimetype.toLowerCase(), fileName: part.filename, meta: clean.outcome });
      }
    } else if (part.fieldname === 'data') {
      dataRaw = String(part.value);
    }
  }
  return { dataRaw, photos };
}

/** Görebileceği ölçümler: hepsini görme izni yoksa yalnız kendi ölçümleri (başkasınınki → 404). */
function readScope(req: FastifyRequest): Prisma.MeasurementWhereInput {
  return {
    companyId: req.auth.orgId,
    ...(can(req, 'deciship.measurements.view_all') ? {} : { measuredById: req.auth.membershipId }),
  };
}

/**
 * Listede ve "Bugün" sayısında güncel sürümler. Hepsini görme izni olmayan çalışan ayrıca kendi geç gelen ölçümünü görür
 * (KALANLAR 6.7): güncel sürüm başkasınınsa ona görünmez, yoksa yaptığı ölçüm listesinden ve sayısından düşerdi. Yalnız
 * hemen sonraki sürüm başkasının silinmemiş güncel sürümüyse (kendi güncel kaydı zaten listededir; zincir sonra büyürse düşer).
 */
function currentScope(viewAll: boolean, userId: string): Prisma.MeasurementWhereInput {
  const current = { supersededById: null, deletedAt: null };
  if (viewAll) return current;
  return {
    measuredById: userId,
    OR: [current, { arrivedLate: true, deletedAt: null, supersededBy: { supersededById: null, deletedAt: null, measuredById: { not: userId } } }],
  };
}

/** Düzeltip silebileceği ölçümler: yönetme izni yoksa yalnız kendi ölçümleri (başkasınınki → 404). */
function writeScope(req: FastifyRequest): Prisma.MeasurementWhereInput {
  return {
    companyId: req.auth.orgId,
    ...(can(req, 'deciship.measurements.manage') ? {} : { measuredById: req.auth.membershipId }),
  };
}

function canEdit(m: { measuredById: string; supersededById: string | null; deletedAt: Date | null }, req: FastifyRequest) {
  const allowed = can(req, 'deciship.measurements.manage') || (can(req, 'deciship.measurements.capture') && m.measuredById === req.auth.membershipId);
  return allowed && !m.supersededById && !m.deletedAt;
}

/**
 * Güncel ölçümlerin sürüm zincirleri, toplu: her sürüm kimliği (kendisi dahil) → zincirin başındaki güncel ölçüm.
 * Zincirin her adımı tek sorgu; düzeltilmemiş ölçümlerde ilk sorgu boş döner.
 */
async function olderVersionHeads(companyId: string, headIds: string[]): Promise<Map<string, string>> {
  const headOf = new Map(headIds.map((id) => [id, id]));
  let frontier = headIds;
  for (let i = 0; i < 100 && frontier.length; i++) {
    const older = await prisma.measurement.findMany({ where: { companyId, supersededById: { in: frontier } }, select: { id: true, supersededById: true } });
    frontier = [];
    for (const o of older) {
      if (headOf.has(o.id)) continue;
      headOf.set(o.id, headOf.get(o.supersededById!)!);
      frontier.push(o.id);
    }
  }
  return headOf;
}

/** Full detail shape of GET /measurements/:id (also returned by PATCH and restore). */
async function measurementDetail(req: FastifyRequest, m: MeasurementFull) {
  const { orgId: companyId } = req.auth;
  const showInvoiceStatus = can(req, 'deciship.invoices.view');
  const desiDivisor = await desiDivisorOf(companyId);
  const seesAll = can(req, 'deciship.measurements.view_all');

  const history: MeasurementFull[] = [];
  let cursor: string = m.id;
  for (let i = 0; i < 50; i++) {
    const prev: MeasurementFull | null = await prisma.measurement.findFirst({
      where: { supersededById: cursor, companyId },
      include: measurementInclude,
    });
    if (!prev) break;
    // Hepsini görme izni yoksa başkasının eski sürümü (not, ölçü, ad) açılmaz; yeniden ölçmek yetki vermez.
    if (seesAll || prev.measuredById === req.auth.membershipId) history.push(prev);
    cursor = prev.id;
  }

  const base = serializeMeasurement(m, { showInvoiceStatus, desiDivisor });
  const photos = m.files.map((f) => ({ id: f.id, kind: f.kind, url: fileUrl(req, f.id, companyId) }));
  const result: Record<string, unknown> = {
    ...base,
    photos,
    history: history.map((h) => serializeMeasurement(h, { showInvoiceStatus, desiDivisor })),
    canEdit: canEdit(m, req),
  };
  // Silinmiş son sürüm: kalıcı silme açık mı, değilse neden (yalnız yönetme iznine; kural `services/measurementPurge.ts`).
  if (m.deletedAt && !m.supersededById && can(req, 'deciship.measurements.manage')) {
    const block = await measurementPurgeBlock(prisma, companyId, m.id);
    result.purge = { allowed: block == null, reason: block };
  }
  if (showInvoiceStatus) {
    // Karar verilmiş / itirazdaki (donmuş) satır ölçüm düzeltilince eski sürümde kalır (Mesaj 4): güncel sürüm, zincirinin
    // herhangi bir sürümüne bağlı satırı kendi faturası sayar; yoksa düzeltilen ölçüm "faturada yok" görünürdü.
    const chain = m.supersededById ? [m.id] : await measurementChainIds(companyId, m.id);
    const lines = await prisma.invoiceLine.findMany({
      where: { measurementId: { in: chain }, invoice: { deletedAt: null, isSample: false } },
      include: { invoice: { select: { id: true, invoiceNo: true, invoiceDate: true, carrier: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    result.invoiceStatus = lines[0]?.status ?? null;
    result.invoiceLines = lines.map((l) => ({
      id: l.id,
      invoiceId: l.invoiceId,
      invoiceNo: l.invoice.invoiceNo,
      invoiceDate: l.invoice.invoiceDate.toISOString().slice(0, 10),
      carrierName: l.invoice.carrier.name,
      trackingNo: l.trackingNo,
      /** faturadaki ambalaj; null = faturada bilgi yok */
      packaging: l.packaging,
      status: l.status,
      diffTypes: l.diffTypes,
      measurementPinned: l.measurementPinned,
      billedChargeableKg: l.billedChargeableKg != null ? num(l.billedChargeableKg) : null,
      ourChargeableKg: l.ourChargeableKg != null ? num(l.ourChargeableKg) : null,
      dims: l.dimL != null && l.dimW != null && l.dimH != null ? { l: num(l.dimL), w: num(l.dimW), h: num(l.dimH) } : null,
      netAmount: num(l.netAmount),
      expectedAmount: l.expectedAmount != null ? num(l.expectedAmount) : null,
      diffAmount: l.diffAmount != null ? num(l.diffAmount) : null,
      decision: l.decision,
    }));
  }
  return result;
}

/**
 * Yeni sürüme geçiş. Kısmi tekil dizin ertelenemez: yeni satır silinmiş işaretiyle açılır (dizine girmez), eskisi bağlanır,
 * sonra işaret kaldırılır. Ara durumu işlem dışından kimse görmez.
 */
async function promoteVersion(tx: Tx, previousId: string, nextId: string) {
  await tx.measurement.update({ where: { id: previousId }, data: { supersededById: nextId } });
  await tx.measurement.update({ where: { id: nextId }, data: { deletedAt: null } });
}

/** Kesin geçersiz takip no metni: alan adıyla ("Takip no: En az 5 karakter olmalı"). */
function trackingInvalidMessage(reason: TrackingReason | undefined): string {
  // Yalnız işaretten oluşan numara ("---", "///") barkod değildir: boş kalsa ilgisiz koliler aynı zincire girerdi.
  if (reason === 'empty') return msg('measurement.trackingEmpty');
  const detail =
    reason === 'tooShort' ? msg('v.tooShort', { min: TRACKING_HARD_MIN }) : reason === 'tooLong' ? msg('v.tooLong', { max: TRACKING_HARD_MAX }) : msg('v.invalid');
  return msg('err.validationField', { field: msg('field.trackingRaw'), detail });
}

/**
 * KALANLAR 4.8: okutma temizliği ve kesin kurallar (core `trackingFormat.ts`, telefonla aynı işlev). `raw`: saklanacak ham
 * değer (görünmez karakter, AIM öneki, GS1 parantezi silinmiş); `trackingNo`: eşleşme değeri (`normalizeTracking`, faturayla
 * aynı). Olağan dışı biçim (ürün barkodu gibi) burada reddedilmez: telefon okuma anında sorar.
 */
function trackingOrThrow(input: string): { raw: string; trackingNo: string } {
  // Barkodun tamamı gelirse (2D PDF417 iletisi, FedEx "96" barkodu) yalnız takip no alınır (eski uygulama ayıklamadan gönderir).
  input = extractTracking(input).value;
  const c = checkTracking(input);
  if (c.verdict === 'invalid') {
    const message = trackingInvalidMessage(c.reason);
    throw badRequest('VALIDATION', message, [{ path: 'trackingRaw', message }]);
  }
  return { raw: stripScanNoise(input), trackingNo: c.value };
}

/**
 * KALANLAR 6.7: cihazın bildirdiği ölçüm anı kabul aralığında olmalı (`services/measurementOrder.ts`); değilse kayda özgü
 * red (telefonda "Hatalı"). `past: false`: yalnız gelecek sınırı (yöneticinin düzeltmesi).
 */
function measuredAtOrThrow(at: Date, opts?: { past?: boolean }) {
  if (measuredAtOutOfRange(at, new Date(), opts)) {
    throw badRequest('MEASURED_AT_INVALID', msg('measurement.measuredAtInvalid'), [{ path: 'measuredAt', message: msg('measurement.measuredAtInvalid') }]);
  }
  return at;
}

/** KALANLAR 6.7-b: istemcinin gönderim anı başlığı (mobil `client.ts` `SENT_AT_HEADER`). */
const SENT_AT_HEADER = 'x-sod-sent-at';
const sentAtSchema = z.iso.datetime({ offset: true }).or(z.iso.datetime());
/** Okunamayan başlık yok sayılır (gövdedeki alana ya da ham ana düşülür); kaydı reddettirmez. */
function sentAtOf(raw: string | string[] | undefined): Date | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && sentAtSchema.safeParse(v).success ? new Date(v) : null;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function measurementRoutes(app: FastifyInstance) {
  const capture = { onRequest: app.requirePermission('deciship.measurements.capture') };
  const read = { onRequest: requireAny(app, ['deciship.measurements.capture', 'deciship.measurements.view_all']) };
  /** Kendi ölçümü için ölçüm izni yeter, başkasınınki için yönetme izni gerekir (writeScope). */
  const write = { onRequest: requireAny(app, ['deciship.measurements.capture', 'deciship.measurements.manage']) };
  /** Kalıcı silme: yalnız yönetme izni (silinenler listesi de bu izinle açılır). */
  const manage = { onRequest: app.requirePermission('deciship.measurements.manage') };

  app.get('/measurements/check', capture, async (req) => {
    const { tracking: asked } = z.object({ tracking: z.string().trim().min(1) }).parse(req.query);
    const tracking = extractTracking(asked).value;
    const candidates = trackingCandidates(tracking);
    // 15 haneli FedEx Ground numarası: `extractTracking` öncesi 22 haneli "96" barkoduyla kaydedilmiş ölçüm de bulunur
    const legacy = legacyFedex96Suffix(normalizeTracking(tracking));
    const found = await prisma.measurement.findMany({
      where: {
        companyId: req.auth.orgId,
        supersededById: null,
        deletedAt: null,
        OR: [
          { trackingNo: { in: candidates } },
          { trackingRaw: { in: [...new Set([tracking, asked])] } },
          ...(legacy ? [{ trackingNo: { startsWith: '96', endsWith: legacy } }] : []),
        ],
      },
      orderBy: { measuredAt: 'desc' },
      take: 5,
      include: { measuredBy: { select: { name: true } } },
    });
    // eski kayıt yalnız tam 22 haneli "96" barkoduysa sayılır (başka uzunlukta aynı sonla biten numara başka gönderidir)
    const legacyOnly = (no: string) => !!legacy && no !== legacy && !candidates.includes(no) && no.endsWith(legacy);
    const last = found.find((m) => !legacyOnly(m.trackingNo) || m.trackingNo.length === 22 || m.trackingRaw === tracking || m.trackingRaw === asked) ?? null;
    if (!last) return { exists: false };
    // Başkasının ölçüsü yeni ölçümü yönlendirmesin: yalnız ne zaman ve kim. Ayrıntı kendi kaydında ya da hepsini görme izniyle.
    if (!can(req, 'deciship.measurements.view_all') && last.measuredById !== req.auth.membershipId) {
      return { exists: true, last: { measuredAt: last.measuredAt.toISOString(), measuredByName: last.measuredBy.name } };
    }
    const d = dims(last);
    return {
      exists: true,
      last: {
        id: last.id,
        measuredAt: last.measuredAt.toISOString(),
        measuredByName: last.measuredBy.name,
        lengthCm: d.l,
        widthCm: d.w,
        heightCm: d.h,
        weightKg: num(last.weightKg),
        packaging: last.packaging,
      },
    };
  });

  app.get('/measurements/stats/today', read, async (req) => {
    const { orgId: companyId, membershipId: userId } = req.auth;
    const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
    const settings = readSettings(company.settings);
    const required = settings.requiredBoxPhotos;
    const items = await prisma.measurement.findMany({
      where: {
        companyId,
        ...currentScope(can(req, 'deciship.measurements.view_all'), userId),
        measuredAt: { gte: zonedDayStart(zonedDate(new Date(), settings.timeZone), settings.timeZone) },
      },
      select: { files: { where: { kind: 'PHOTO_BOX' }, select: { id: true } } },
    });
    return { count: items.length, missingPhotos: items.filter((m) => m.files.length < required).length };
  });

  app.post('/measurements', capture, async (req, reply) => {
    // Gövde (fotoğraflar) okunmadan önceki an: cihaz saati farkı yükleme süresini katmadan ölçülür.
    const receivedAt = new Date();
    if (!req.isMultipart()) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg('measurement.notSent'));
    }
    const { orgId: companyId, membershipId: userId } = req.auth;
    const { dataRaw, photos } = await readMultipart(req);
    if (!dataRaw) throw badRequest('VALIDATION', msg('measurement.dataMissing'));
    let json: unknown;
    try {
      json = JSON.parse(dataRaw);
    } catch {
      throw badRequest('VALIDATION', msg('measurement.dataUnreadable'));
    }
    const data = createData.parse(json);
    const { raw: trackingRaw, trackingNo } = trackingOrThrow(data.trackingRaw);
    const desiDivisor = await desiDivisorOf(companyId);
    const showInvoiceStatus = can(req, 'deciship.invoices.view');

    // Yeniden gönderim: clientId kişinin kendi kuyruğuna aittir. Başka kişinin ya da firmanın aynı değeri ayrı kayıttır.
    const sameSubmission = { companyId, measuredById: userId, clientId: data.clientId };
    const existing = await prisma.measurement.findFirst({ where: sameSubmission, include: measurementInclude });
    if (existing) {
      // İlk gönderimde ölçüm yazıldı ama karşılaştırma bitmedi (03-B4): tekrar gönderim onu tamamlar. Bitmişse ek iş yok.
      if (existing.recomparePendingAt) await queueMeasurementRecompare(companyId, existing.id, existing.recomparePendingAt, req.log);
      return reply.status(200).send({ measurement: serializeMeasurement(existing, { showInvoiceStatus, desiDivisor }) });
    }
    // Yeniden gönderimden sonra: önceden kaydedilmiş kayıt, zamanı ne olursa olsun aynı yanıtı alır (idempotent).
    // Önce cihaz saati farkı düzeltilir (6.7-b), aralık denetimi düzeltilmiş anla yapılır.
    // Gönderim anı: önce başlık (istemci jeton yenilemesinden sonra, istek çıkarken yazar), yoksa gövdedeki alan.
    const sentAt = sentAtOf(req.headers[SENT_AT_HEADER]) ?? (data.sentAt ? new Date(data.sentAt) : null);
    const clock = correctDeviceClock(new Date(data.measuredAt), sentAt, receivedAt);
    // `clamped` (eski uygulama, aralık dışı an) reddedilmez; gönderim anını bildiren istemcide aralık dışı an reddedilir.
    const measuredAt = clock.clamped ? clock.measuredAt : measuredAtOrThrow(clock.measuredAt);

    if (data.boxPresetId) {
      const preset = await prisma.boxPreset.findFirst({ where: { id: data.boxPresetId, companyId } });
      if (!preset) data.boxPresetId = null;
    }

    const stored: { path: string; size: number; sha256: string; mime: string; kind: (typeof PHOTO_KINDS)[number]; originalName: string }[] = [];
    let created: MeasurementFull;
    const pendingAt = new Date();
    try {
      for (const [i, p] of photos.entries()) {
        const s = await storeBuffer(companyId, p.buffer, extFor(p.mime));
        stored.push({ ...s, mime: p.mime, kind: data.photoKinds[i] ?? 'PHOTO_OTHER', originalName: p.fileName });
      }
      created = await prisma.$transaction(async (tx) => {
        await lockTracking(tx, companyId, [trackingNo]);
        const prev = await lockCurrent(tx, companyId, trackingNo);
        // KALANLAR 6.7: kuyrukta bekleyip geç gelen eski ölçüm güncel ölçümün yerine geçmez; zincire ölçüm anına göre eski
        // sürüm olarak girer (kaybolmaz). Güncel sürüm ve faturadaki rakam değişmez.
        const late = prev && (clock.clamped ? data.replacesId !== prev.id : arrivesLate(measuredAt, prev, data.replacesId)) ? await lateVersionPlace(tx, companyId, prev.id, measuredAt) : null;
        const m = await tx.measurement.create({
          data: {
            companyId,
            clientId: data.clientId,
            trackingRaw,
            trackingNo,
            lengthCm: data.lengthCm,
            widthCm: data.widthCm,
            heightCm: data.heightCm,
            weightKg: data.weightKg,
            dimMethod: data.dimMethod,
            weightMethod: data.weightMethod,
            ocrWeightKg: data.ocrWeightKg ?? null,
            dimConfidence: data.dimConfidence ?? null,
            boxPresetId: data.boxPresetId ?? null,
            // Eski uygulama ambalajı göndermez: yeniden ölçümde önceki güncel ölçümün ambalajı korunur (yoksa kendi ambalajı)
            packaging: data.packaging ?? packagingOf(prev?.packaging),
            measuredById: userId,
            measuredAt,
            deviceMeasuredAt: clock.deviceMeasuredAt,
            note: data.note ?? null,
            version: late ? late.version : prev ? prev.version + 1 : 1,
            deletedAt: prev ? new Date() : null,
            recomparePendingAt: pendingAt,
            files: {
              create: stored.map((s) => ({
                companyId,
                kind: s.kind,
                mime: s.mime,
                size: s.size,
                path: s.path,
                sha256: s.sha256,
                originalName: s.originalName,
                createdById: userId,
              })),
            },
          },
          include: measurementInclude,
        });
        if (late) await linkLateVersion(tx, companyId, late, m.id);
        else if (prev) await promoteVersion(tx, prev.id, m.id);
        // Denetim izi ölçümle aynı işlemde: kuyruktan toplu gönderimde ek bağlantı ve ek işlem açmaz, tekrar gönderimde yazılmaz.
        await tx.auditLog.create({
          data: {
            companyId,
            userId,
            action: prev ? 'measurement.remeasure' : 'measurement.create',
            entity: 'Measurement',
            entityId: m.id,
            data: {
              ...(late ? { trackingNo, late: true, currentId: prev!.id } : prev ? { previousId: prev.id, trackingNo } : { trackingNo }),
              ...(prev && data.replacesId === prev.id ? { replaced: true } : {}),
              ...(clock.offsetMs != null ? { clockOffsetMs: clock.offsetMs } : {}),
              ...(clock.clamped ? { clockClamped: true } : {}),
            },
          },
        });
        if (late) return tx.measurement.findFirstOrThrow({ where: { id: m.id, companyId }, include: measurementInclude });
        return { ...m, deletedAt: null };
      });
    } catch (e) {
      // Y147: kayıt yazılmadı; bu istekte diske yazılan fotoğraflar sahipsiz kalmasın.
      await discardUnsavedPhotos(stored.map((x) => x.path), req.log);
      if (isUniqueViolation(e)) {
        // Aynı gönderim paralel geldi: ilk kayıt döner. Numara çakışması kilit altında beklenmez, son güvence dizindir.
        const again = await prisma.measurement.findFirst({ where: sameSubmission, include: measurementInclude });
        if (again) return reply.status(200).send({ measurement: serializeMeasurement(again, { showInvoiceStatus, desiDivisor }) });
        throw conflict('TRACKING_IN_USE', msg('measurement.trackingInUse'));
      }
      throw e;
    }

    await logUncleanPhotos(req.log, companyId, photos.map((p, i) => ({ path: stored[i]!.path, meta: p.meta, mime: p.mime })));
    await queueMeasurementRecompare(companyId, created.id, pendingAt, req.log);
    return reply.status(201).send({ measurement: serializeMeasurement(created, { showInvoiceStatus, desiDivisor }) });
  });

  app.get('/measurements', read, limited(async (req) => {
    const q = listQuery.parse(req.query);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const viewAll = can(req, 'deciship.measurements.view_all');
    const showInvoiceStatus = can(req, 'deciship.invoices.view');
    const deleted = q.deleted === 'true' || q.deleted === '1';
    if (deleted && !can(req, 'deciship.measurements.manage')) throw forbiddenFor(req);
    const where: Prisma.MeasurementWhereInput = deleted
      ? { companyId, supersededById: null, deletedAt: { not: null } }
      : // Çalışana göre süzen yönetici de o çalışanın geç kaydını görür (Merkez sayımı ve çalışanın kendi listesiyle aynı küme).
        { companyId, ...(viewAll && !q.userId ? currentScope(true, userId) : currentScope(false, viewAll ? q.userId! : userId)) };
    const measuredAt: Prisma.DateTimeFilter = {};
    const { timeZone } = readSettings((await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } })).settings);
    const dayOnly = (v: string | undefined) => !!v && v.length <= 10;
    const from = parseDateInput(q.from);
    const to = parseDateInput(q.to);
    if (from) measuredAt.gte = dayOnly(q.from) ? zonedDayStart(q.from!, timeZone) : from;
    if (to) measuredAt.lte = dayOnly(q.to) ? new Date(zonedDayStart(new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10), timeZone).getTime() - 1) : to;
    // SPEC 10.1: no 7-day cap any more — an employee sees all of their own measurements
    if (!viewAll) where.measuredById = userId;
    else if (q.userId) where.measuredById = q.userId;
    if (Object.keys(measuredAt).length) where.measuredAt = measuredAt;
    if (q.method) where.dimMethod = q.method;
    if (q.q) {
      const norm = normalizeTracking(q.q);
      // AND içinde: kapsamın kendi OR'u (çalışanın geç kaydı, `currentScope`) ezilmesin.
      where.AND = [{ OR: [{ trackingNo: { contains: likeEscape(norm) } }, { trackingRaw: { contains: likeEscape(q.q), mode: 'insensitive' } }] }];
    }
    const [total, rows, desiDivisor] = await Promise.all([
      prisma.measurement.count({ where }),
      prisma.measurement.findMany({
        where,
        include: measurementInclude,
        orderBy: deleted ? [{ deletedAt: 'desc' }, { measuredAt: 'desc' }] : { measuredAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      desiDivisorOf(companyId),
    ]);
    const statusById = new Map<string, string>();
    if (showInvoiceStatus && rows.length) {
      // Donmuş satır ölçümün eski sürümünde kalır (Mesaj 4): listedeki güncel sürümün durumu zincirinin tamamından okunur.
      const headOf = await olderVersionHeads(companyId, rows.map((r) => r.id));
      const lines = await prisma.invoiceLine.findMany({
        where: { measurementId: { in: [...headOf.keys()] }, invoice: { deletedAt: null, isSample: false } },
        select: { measurementId: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const l of lines) if (l.measurementId) statusById.set(headOf.get(l.measurementId)!, l.status);
    }
    return paged(
      rows.map((m) => serializeMeasurement(m, { showInvoiceStatus, desiDivisor, invoiceStatus: statusById.get(m.id) })),
      total,
      q.page,
      q.pageSize,
    );
  }, 'read'));

  app.get('/measurements/:id', read, async (req) => {
    const { id } = idParam.parse(req.params);
    const m = await prisma.measurement.findFirst({ where: { id, ...readScope(req) }, include: measurementInclude });
    if (!m) throw notFound(msg('measurement.notFound'));
    return { measurement: await measurementDetail(req, m) };
  });

  /** SPEC 10.1: correction = new version. JSON or multipart (`data` + `photos`). */
  app.patch('/measurements/:id', write, async (req) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;

    let raw: unknown = req.body ?? {};
    let photos: UploadedPhoto[] = [];
    if (req.isMultipart()) {
      const mp = await readMultipart(req);
      photos = mp.photos;
      raw = {};
      if (mp.dataRaw) {
        try {
          raw = JSON.parse(mp.dataRaw);
        } catch {
          throw badRequest('VALIDATION', msg('measurement.dataUnreadable'));
        }
      }
    }
    const parsedBody = patchData.parse(raw);
    const nextTracking = parsedBody.trackingRaw !== undefined ? trackingOrThrow(parsedBody.trackingRaw) : null;

    const m = await prisma.measurement.findFirst({
      where: { id, ...writeScope(req), deletedAt: null },
      include: { files: { orderBy: { createdAt: 'asc' } } },
    });
    if (!m) throw notFound(msg('measurement.notFound'));
    if (m.supersededById) throw conflict('NOT_LATEST_VERSION', msg('measurement.notLatest'));
    // Aynı ambalajı yeniden göndermek değişiklik değildir (her düzeltmede ambalajı gönderen istemci boş sürüm açmasın).
    const body = parsedBody.packaging === m.packaging ? { ...parsedBody, packaging: undefined } : parsedBody;
    // Ölçüm anını yalnız yönetme izni değiştirir (öbüründen yok sayılır). Değişiyorsa geleceğe alınamaz (KALANLAR 6.7): gelecek
    // tarihli güncel sürüm, sonraki gerçek ölçümleri geç gelen kayıt sayardı. Geçmişe çekmek serbest (gerçek anı düzeltmek).
    const measuredAt = can(req, 'deciship.measurements.manage') && body.measuredAt ? new Date(body.measuredAt) : m.measuredAt;
    if (measuredAt.getTime() !== m.measuredAt.getTime()) measuredAtOrThrow(measuredAt, { past: false });

    // nothing to change → no new version (avoids empty versions in the history)
    const { removePhotoIds: _rm, photoKinds: _pk, ...fieldChanges } = body;
    const noFieldChanges = Object.values(fieldChanges).every((v) => v === undefined);
    if (noFieldChanges && body.removePhotoIds.length === 0 && photos.length === 0) {
      const current = await prisma.measurement.findFirstOrThrow({ where: { id: m.id }, include: measurementInclude });
      return { measurement: await measurementDetail(req, current) };
    }

    // dimensions, preset and method rules
    let lengthCm: number = body.lengthCm ?? num(m.lengthCm);
    let widthCm: number = body.widthCm ?? num(m.widthCm);
    let heightCm: number = body.heightCm ?? num(m.heightCm);
    let dimMethod = m.dimMethod;
    let dimConfidence = m.dimConfidence;
    let boxPresetId = m.boxPresetId;
    if (body.boxPresetId) {
      const preset = await prisma.boxPreset.findFirst({ where: { id: body.boxPresetId, companyId } });
      if (!preset) throw notFound(msg('preset.notFound'));
      lengthCm = body.lengthCm ?? num(preset.lengthCm);
      widthCm = body.widthCm ?? num(preset.widthCm);
      heightCm = body.heightCm ?? num(preset.heightCm);
      boxPresetId = preset.id;
      dimMethod = 'PRESET';
      dimConfidence = null;
    } else {
      const dimsChanged =
        lengthCm !== num(m.lengthCm) || widthCm !== num(m.widthCm) || heightCm !== num(m.heightCm);
      if (body.boxPresetId === null) boxPresetId = null;
      if (body.dimMethod) {
        dimMethod = body.dimMethod;
        if (dimsChanged || body.dimMethod !== m.dimMethod) dimConfidence = null;
        if (dimsChanged && body.dimMethod !== 'PRESET') boxPresetId = null;
      } else if (dimsChanged) {
        dimMethod = 'MANUAL';
        dimConfidence = null;
        boxPresetId = null;
      }
    }
    const weightKg: number = body.weightKg ?? num(m.weightKg);
    const weightMethod = body.weightMethod ?? (weightKg !== num(m.weightKg) ? 'MANUAL' : m.weightMethod);

    // photos: keep all but removePhotoIds, then add the new ones
    const remove = new Set(body.removePhotoIds);
    const kept = m.files.filter((f) => !remove.has(f.id));
    const newKinds = photos.map((_, i) => body.photoKinds[i] ?? 'PHOTO_OTHER');
    const required = readSettings(
      (await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } })).settings,
    ).requiredBoxPhotos;
    const boxBefore = m.files.filter((f) => f.kind === 'PHOTO_BOX').length;
    const boxAfter = kept.filter((f) => f.kind === 'PHOTO_BOX').length + newKinds.filter((k) => k === 'PHOTO_BOX').length;
    // an edit may not drop the box photos below the company requirement (legacy records that never met it stay editable)
    if (boxAfter < required && boxAfter < boxBefore) {
      throw badRequest('PHOTO_REQUIRED', msg('measurement.photoRequired', { required }), { required, boxPhotos: boxAfter });
    }
    const stored: { path: string; size: number; sha256: string; mime: string; kind: (typeof PHOTO_KINDS)[number]; originalName: string }[] = [];
    const trackingRaw = nextTracking?.raw ?? m.trackingRaw;
    const trackingNo = nextTracking?.trackingNo ?? normalizeTracking(m.trackingRaw);
    const pendingAt = new Date();
    const save = () => prisma.$transaction(async (tx) => {
      await lockTracking(tx, companyId, [m.trackingNo, trackingNo]);
      // Bu arada başkası düzeltti ya da sildiyse eski görünümün üstüne yazılmaz.
      // Sürüm numarası kilit altında okunur: bu arada geç gelen eski ölçüm zincire girdiyse güncel sürümün numarası artmıştır.
      const current = await tx.$queryRaw<{ id: string; version: number }[]>`
        SELECT "id", "version" FROM "Measurement" WHERE "id" = ${m.id} AND "companyId" = ${companyId} AND "supersededById" IS NULL AND "deletedAt" IS NULL FOR UPDATE`;
      if (!current.length) throw conflict('NOT_LATEST_VERSION', msg('measurement.notLatest'));
      if (trackingNo !== m.trackingNo && (await lockCurrent(tx, companyId, trackingNo))) {
        throw conflict('TRACKING_IN_USE', msg('measurement.trackingInUse'));
      }
      const next = await tx.measurement.create({
        data: {
          companyId,
          // Örnek ölçümün düzeltmesi de örnektir: deneme bitince zinciriyle birlikte silinir (gerçek veri gibi kalmaz).
          clientId: `${m.clientId.startsWith(DEMO_CLIENT_ID_PREFIX) ? DEMO_CLIENT_ID_PREFIX : ''}${crypto.randomUUID()}`,
          trackingRaw,
          trackingNo,
          lengthCm,
          widthCm,
          heightCm,
          weightKg,
          dimMethod,
          weightMethod,
          ocrWeightKg: m.ocrWeightKg,
          dimConfidence,
          boxPresetId,
          packaging: body.packaging ?? m.packaging,
          measuredById: m.measuredById,
          measuredAt,
          note: body.note === undefined ? m.note : body.note || null,
          version: current[0]!.version + 1,
          deletedAt: new Date(),
          recomparePendingAt: pendingAt,
          files: {
            create: [
              ...kept.map((f) => ({
                companyId,
                kind: f.kind,
                mime: f.mime,
                size: f.size,
                path: f.path,
                sha256: f.sha256,
                originalName: f.originalName,
                createdById: f.createdById,
              })),
              ...stored.map((st) => ({
                companyId,
                kind: st.kind,
                mime: st.mime,
                size: st.size,
                path: st.path,
                sha256: st.sha256,
                originalName: st.originalName,
                createdById: userId,
              })),
            ],
          },
        },
        include: measurementInclude,
      });
      await promoteVersion(tx, m.id, next.id);
      return { ...next, deletedAt: null };
    });
    let created: Awaited<ReturnType<typeof save>>;
    try {
      for (const [i, p] of photos.entries()) {
        const st = await storeBuffer(companyId, p.buffer, extFor(p.mime));
        stored.push({ ...st, mime: p.mime, kind: newKinds[i]!, originalName: p.fileName });
      }
      created = await save();
    } catch (e) {
      // Y147: yeni sürüm yazılmadı; yalnız bu istekte yazılan fotoğraflar silinir (korunan eski fotoğraflar `kept` değil).
      await discardUnsavedPhotos(stored.map((x) => x.path), req.log);
      if (isUniqueViolation(e)) throw conflict('TRACKING_IN_USE', msg('measurement.trackingInUse'));
      throw e;
    }
    await logUncleanPhotos(req.log, companyId, photos.map((p, i) => ({ path: stored[i]!.path, meta: p.meta, mime: p.mime })));
    const { removePhotoIds: _r, photoKinds: _k, ...changes } = body;
    await audit(companyId, userId, 'measurement.correct', 'Measurement', created.id, {
      previousId: m.id,
      changes,
      removedPhotoIds: m.files.filter((f) => remove.has(f.id)).map((f) => f.id),
      addedPhotos: newKinds,
    });
    // Yanıt (ve paneldeki hemen yeniden okuma) güncel karşılaştırmayı taşısın: kısa süre beklenir, dolarsa iş arkada sürer.
    await recompareWithin(companyId, created.id, pendingAt, RECOMPARE_RESPONSE_WAIT_MS, req.log);
    const fresh = await prisma.measurement.findFirstOrThrow({ where: { id: created.id, companyId }, include: measurementInclude });
    return { measurement: { ...(await measurementDetail(req, fresh)), recomparePending: fresh.recomparePendingAt != null } };
  });

  app.delete('/measurements/:id', write, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const m = await prisma.measurement.findFirst({ where: { id, ...writeScope(req), deletedAt: null } });
    if (!m) throw notFound(msg('measurement.notFound'));
    if (m.supersededById) throw conflict('NOT_LATEST_VERSION', msg('measurement.notLatest'));
    const pendingAt = new Date();
    await prisma.measurement.update({ where: { id }, data: { deletedAt: pendingAt, recomparePendingAt: pendingAt, recompareAttempts: 0 } });
    await audit(companyId, userId, 'measurement.delete', 'Measurement', id, { trackingNo: m.trackingNo });
    await queueMeasurementRecompare(companyId, m.id, pendingAt, req.log);
    return reply.status(204).send();
  });

  /** SPEC 10.1: undo a soft delete. 409 NEWER_EXISTS if a newer live measurement of the same tracking no exists. */
  app.post('/measurements/:id/restore', write, async (req) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const m = await prisma.measurement.findFirst({ where: { id, ...writeScope(req) } });
    if (!m) throw notFound(msg('measurement.notFound'));
    if (m.deletedAt) {
      // Ara sürüm geri yüklense de listede görünmez: güncel sürüm geri yüklenir.
      if (m.supersededById) throw conflict('NOT_LATEST_VERSION', msg('measurement.notLatest'));
      const pendingAt = new Date();
      let restored = 0;
      let absorbedId: string | null = null;
      try {
        restored = await prisma.$transaction(async (tx) => {
          await lockTracking(tx, companyId, [m.trackingNo]);
          const live = await lockCurrent(tx, companyId, m.trackingNo);
          // KALANLAR 6.7: silinmişken geç gelen eski ölçüm güncel kayıt olmuştu. Geri yüklenen kayıt ondan yeniyse sıra düzelir:
          // geç kayıt (tek sürümlü, kendisinin ya da yönetme izni varsa) geri yüklenen zincire eski sürüm olarak girer.
          // Gerçekten daha yeni ölçüm varsa (ya da geç kaydın kendi zinciri varsa) eskisi gibi NEWER_EXISTS.
          const absorb =
            live != null &&
            arrivesLate(live.measuredAt, m) &&
            (can(req, 'deciship.measurements.manage') || (await tx.measurement.count({ where: { id: live.id, measuredById: req.auth.membershipId } })) > 0) &&
            (await tx.measurement.count({ where: { companyId, supersededById: live.id } })) === 0;
          if (live && !absorb) throw conflict('NEWER_EXISTS', msg('measurement.newerExists'));
          // Geç kayıt önce kısmi tekil dizinden çıkar (silinmiş işareti), sonra geri yüklenen zincire bağlanır.
          if (live) await tx.measurement.update({ where: { id: live.id }, data: { deletedAt: new Date() } });
          // Bu arada kalıcı silindiyse satır yoktur (404); başkası geri yüklediyse yazacak bir şey yok (idempotent).
          const u = await tx.measurement.updateMany({ where: { id, companyId, deletedAt: { not: null } }, data: { deletedAt: null, recomparePendingAt: pendingAt, recompareAttempts: 0 } });
          if (live && u.count) {
            await linkLateVersion(tx, companyId, await lateVersionPlace(tx, companyId, id, live.measuredAt), live.id);
            absorbedId = live.id;
          } else if (live) throw conflict('NEWER_EXISTS', msg('measurement.newerExists'));
          return u.count;
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('NEWER_EXISTS', msg('measurement.newerExists'));
        throw e;
      }
      if (restored) {
        await audit(companyId, userId, 'measurement.restore', 'Measurement', id, { trackingNo: m.trackingNo, ...(absorbedId ? { lateId: absorbedId } : {}) });
        await recompareWithin(companyId, m.id, pendingAt, RECOMPARE_RESPONSE_WAIT_MS, req.log);
      }
    }
    const full = await prisma.measurement.findFirst({ where: { id, companyId }, include: measurementInclude });
    if (!full) throw notFound(msg('measurement.notFound'));
    return { measurement: { ...(await measurementDetail(req, full)), recomparePending: full.recomparePendingAt != null } };
  });

  /**
   * Kullanıcı kararı 2026-11-13 (SPEC §10.1, §5.13): silinmiş ölçümü, bütün eski sürümlerini ve fotoğraflarını kalıcı
   * siler; geri gelmez. Yalnız `measurements.manage`. Kural ve kilitler `services/measurementPurge.ts`.
   */
  app.post('/measurements/:id/purge', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const { orgId: companyId, membershipId: userId } = req.auth;
    const r = await purgeDeletedMeasurement(companyId, id, userId, req.log);
    if (r.ok) return { purged: { id, trackingNo: r.trackingNo, versions: r.versions, photos: r.photos } };
    switch (r.code) {
      case 'NOT_FOUND':
        throw notFound(msg('measurement.notFound'));
      case 'NOT_DELETED':
        throw conflict('NOT_DELETED', msg('measurement.purgeNotDeleted'));
      case 'NOT_LATEST_VERSION':
        throw conflict('NOT_LATEST_VERSION', msg('measurement.purgeNotLatest'));
      case 'CHANGED':
      case 'RECOMPARE_PENDING':
        throw conflict('MEASUREMENT_CHANGED', msg('measurement.purgeChanged'));
      case 'PROTECTED':
        throw new AppError(409, 'MEASUREMENT_PROTECTED', msg(r.reason === 'DISPUTE' ? 'measurement.purgeDispute' : 'measurement.purgeDecided'), { reason: r.reason });
    }
  });
}
