import { normalizeLocale, type Locale } from '@deciship/core';
import { errorMessage } from '@sellerondata/contracts';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from './db.ts';
import { isMessageKey, m, requestLocale, type MessageKey } from './i18n/index.ts';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const notFound = (message = m('err.recordNotFound')) => new AppError(404, 'NOT_FOUND', message);
/** Ortak hata metni, isteğin diline göre (contracts; başlık → oturumun dili → İngilizce). */
export const forbiddenFor = (req: FastifyRequest) => new AppError(403, 'FORBIDDEN', errorMessage('FORBIDDEN', requestLocale(req)));
export const emptyFile = () => new AppError(400, 'EMPTY_FILE', m('err.emptyFile'));
export const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Şemadaki özel metinler anahtardır, burada çevrilir. Zod'un kendi metinleri olduğu gibi kalır. */
export function zodDetails(err: ZodError, locale?: Locale) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: isMessageKey(i.message) ? m(i.message, undefined, locale) : zodIssueText(i, locale) }));
}

/** Tanınan alanın adı. Dizi yolunda son ad ("rates.0.price" → price). */
function fieldLabel(path: readonly PropertyKey[] | string | undefined, locale?: Locale): string | null {
  const parts = typeof path === 'string' ? [path] : (path ?? []);
  const name = [...parts].reverse().find((p): p is string => typeof p === 'string');
  const key = name ? `field.${name}` : '';
  return key && isMessageKey(key) ? m(key, undefined, locale) : null;
}

/** Üstteki metin ilk sorunu alanıyla söyler: "Takip no: En çok 200 karakter olabilir". Alan tanınmıyorsa genel metin. */
function validationMessage(err: ZodError, locale?: Locale): string {
  const first = err.issues[0];
  const field = first ? fieldLabel(first.path, locale) : null;
  if (!first || !field) return m('err.validation', undefined, locale);
  const detail = isMessageKey(first.message) ? m(first.message, undefined, locale) : zodIssueText(first, locale);
  return m('err.validationField', { field, detail }, locale);
}

/** Zod'un kendi metni İngilizcedir ve kullanıcıya göre yazılmamıştır: türüne göre kullanıcı metni. */
function zodIssueText(i: ZodError['issues'][number], locale?: Locale): string {
  const text = (key: MessageKey, params?: Record<string, string | number>) => m(key, params, locale);
  switch (i.code) {
    case 'invalid_type':
      return text(/received undefined/.test(i.message) ? 'v.required' : 'v.invalid');
    case 'too_small':
      if (i.origin === 'string') return text(Number(i.minimum) === 1 ? 'v.tooShortOne' : 'v.tooShort', { min: Number(i.minimum) });
      return text('v.tooSmall', { min: Number(i.minimum) });
    case 'too_big':
      if (i.origin === 'string') return text(Number(i.maximum) === 1 ? 'v.tooLongOne' : 'v.tooLong', { max: Number(i.maximum) });
      return text('v.tooBig', { max: Number(i.maximum) });
    case 'unrecognized_keys':
      return text('v.unknownField', { fields: i.keys.join(', ') });
    default:
      return text('v.invalid');
  }
}

/**
 * Prisma: sütuna sığmayan değer — P2020 (sayı taşması, Postgres 22003), P2000 (metin çok uzun).
 * Toplu satır yazımı ham SQL'dir: orada aynı hata P2010 + Postgres kodu (22003 / 22001) olarak gelir.
 */
function isOutOfRange(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2000' || err.code === 'P2020') return true;
  const pgCode = (err.meta as { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined)?.driverAdapterError?.cause?.originalCode;
  return err.code === 'P2010' && (pgCode === '22003' || pgCode === '22001');
}

/** Prisma: veritabanına ulaşılamadı / bağlantı koptu / zaman aşımı / çok fazla bağlantı. */
const DB_CONNECTION_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2037']);
/** Soket düzeyi (node) ve Postgres: sunucu kapanıyor (57P01-03), çok fazla bağlantı (53300); 08xxx ayrıca. */
const DB_CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '57014']);
const DB_ADAPTER_KINDS = new Set(['ConnectionClosed', 'DatabaseNotReachable', 'SocketTimeout', 'TooManyConnections']);
const DB_CONNECTION_MESSAGE = /Server has closed the connection|Connection terminated|Can't reach database server|Connection ended unexpectedly|terminating connection|timeout exceeded when trying to connect|canceling statement due to|Transaction already closed|not queryable/i;

/**
 * Postgres bağlantısı geçici olarak koptu mu (Prisma P1017 "Server has closed the connection", pg ECONNRESET…)?
 * Bu durumda istek kullanıcı hatası değil; 500 yerine 503 + "birkaç saniye sonra tekrar deneyin" dönülür.
 * Hata zinciri (`cause`, Prisma `meta.driverAdapterError`) en fazla birkaç adım gezilir.
 * Otomatik yeniden deneme YOK: yazma işleminin sunucuda tamamlanıp tamamlanmadığı bilinemez (çift kayıt riski).
 */
export function isDbConnectionError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    if (cur instanceof Prisma.PrismaClientInitializationError) return true;
    const e = cur as { code?: unknown; kind?: unknown; message?: unknown; cause?: unknown; meta?: { driverAdapterError?: unknown } };
    const code = typeof e.code === 'string' ? e.code : '';
    if (cur instanceof Prisma.PrismaClientKnownRequestError && DB_CONNECTION_PRISMA_CODES.has(code)) return true;
    if (DB_CONNECTION_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
    if (typeof e.kind === 'string' && DB_ADAPTER_KINDS.has(e.kind)) return true;
    if (typeof e.message === 'string' && DB_CONNECTION_MESSAGE.test(e.message)) return true;
    cur = e.meta?.driverAdapterError ?? e.cause;
  }
  return false;
}

/** Sütun biliniyorsa alanı söyler. Sınır veritabanı türündedir, çoğu alanda önce şema yakalar. */
function outOfRangeMessage(err: unknown, locale: Locale): string {
  const meta = (err as { meta?: { column_name?: string; driverAdapterError?: { cause?: { column?: string } } } }).meta;
  const field = fieldLabel(meta?.column_name ?? meta?.driverAdapterError?.cause?.column, locale);
  return field ? m('err.outOfRangeField', { field }, locale) : m('err.outOfRange', undefined, locale);
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: m('err.pageNotFound', undefined, normalizeLocale(req.headers['accept-language'])) } });
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    // Gövde hatası kancalardan önce gelir: bağlama bakılmaz, kural tek (başlık, yoksa oturumun dili).
    const locale = requestLocale(req);
    const say = (key: MessageKey) => m(key, undefined, locale);
    if (err instanceof AppError) {
      // 06-B4: disk doldu; işletme görmeli (kullanıcıya anlaşılır ileti, günlükte hata düzeyi)
      if (err.code === 'STORAGE_FULL') req.log.error({ err }, 'storage full: file not saved');
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION', message: validationMessage(err, locale), details: zodDetails(err, locale) } });
    }
    const fe = err as FastifyError;
    const code = fe.code ?? '';
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
      return reply.status(413).send({ error: { code: 'TOO_MANY_FILES', message: say('err.tooManyFiles') } });
    }
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: say('err.fileTooLarge') } });
    }
    // Veritabanı sütununa sığmayan sayı / metin (ör. 10^15 tutar): 500 yerine anlaşılır 400
    if (isOutOfRange(err)) {
      return reply.status(400).send({
        error: { code: 'VALUE_OUT_OF_RANGE', message: outOfRangeMessage(err, locale) },
      });
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: say('err.fileNotSent') } });
    }
    if (fe.validation || code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: say('err.validation') } });
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: code || 'BAD_REQUEST', message: say('err.badRequest') } });
    }
    if (isDbConnectionError(err)) {
      req.log.warn({ err }, 'veritabanı bağlantısı koptu');
      return reply
        .status(503)
        .header('retry-after', '3')
        .send({ error: { code: 'DB_UNAVAILABLE', message: say('err.dbUnavailable') } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: say('err.internal') } });
  });
}
