import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ROLE_FORBIDDEN_REASONS, errorMessage, type ApiErrorCode, type Locale, type RoleForbiddenReason } from '@sellerondata/contracts';
import { Prisma } from './db.ts';
import { FORBIDDEN_REASONS, lengthMessage, localeOf, OWNER_EMAIL_REASONS, RESET_CODE_REASONS, VALIDATION_MESSAGES, validationMessage } from './i18n.ts';

export type ErrorDetails = Record<string, unknown> | unknown[];

/** Metin taşımaz: yerelleştirme hata işleyicide `code` üzerinden yapılır. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ApiErrorCode,
    public details?: ErrorDetails,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export const unauthorized = () => new AppError(401, 'UNAUTHORIZED');
export const forbidden = () => new AppError(403, 'FORBIDDEN');
export const notFound = () => new AppError(404, 'NOT_FOUND');
export const validation = (path: string, key: string) => new ValidationIssue(path, key);

/** Tek alan hatası. Metni `VALIDATION_MESSAGES` anahtarıdır. */
export class ValidationIssue extends Error {
  constructor(
    public path: string,
    public key: string,
  ) {
    super(key);
  }
}

/** Zod 4 girdiyi hatada taşımaz: eksik alan yalnız mesajdan anlaşılır. */
function issueKey(issue: ZodError['issues'][number]): string {
  if (issue.code === 'invalid_type' && /received undefined/.test(issue.message)) return 'required';
  if (issue.code === 'custom' && issue.message in VALIDATION_MESSAGES) return issue.message;
  if (issue.code === 'too_small' || issue.code === 'too_big' || issue.code === 'invalid_format' || issue.code === 'invalid_value') return issue.code;
  return 'invalid_value';
}

export function zodDetails(err: ZodError, locale: Locale, url = '') {
  // Firma uçlarında `name` firma adıdır.
  const orgForm = /\/orgs?(\?|$)/.test(url);
  return err.issues.map((i) => {
    const code = issueKey(i);
    const path = i.path.join('.');
    const generic = validationMessage(code, locale);
    if ((i.code === 'too_big' || i.code === 'too_small') && i.origin === 'string') {
      const bound = i.code === 'too_big' ? 'max' : 'min';
      const limit = Number(i.code === 'too_big' ? i.maximum : i.minimum);
      const field = orgForm && path === 'name' ? 'orgName' : path;
      return { path, code, message: lengthMessage(field, bound, limit, locale) ?? generic, [bound]: limit };
    }
    return { path, code, message: generic };
  });
}

/**
 * Prisma benzersizlik ihlalini hata koduna çevirir: `pre-check` ile yazma arasındaki yarışta da doğru yanıt dönsün.
 * pg bağdaştırıcısı alanı değil dizin adını verir (`Person_email_key`), bu yüzden tablo + dizin parçasına bakılır.
 */
export function uniqueViolationCode(err: unknown): ApiErrorCode | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  const cause = (err.meta as { driverAdapterError?: { cause?: { table?: string; constraint?: { index?: string; fields?: string[] } } } } | undefined)
    ?.driverAdapterError?.cause;
  const parts = cause?.constraint?.fields ?? cause?.constraint?.index?.split('_') ?? [];
  if (cause?.table === 'Person' && parts.includes('email')) return 'EMAIL_TAKEN';
  if (cause?.table === 'Person' && parts.includes('phone')) return 'PHONE_TAKEN';
  if (cause?.table === 'Membership' && parts.includes('personId')) return 'ALREADY_MEMBER';
  // Rol adı dizini (`ProductRole_orgId_product_name_key`, `lower(name)`): uygulama denetimiyle yazma arasındaki yarışta da doğru kod.
  if (cause?.table === 'ProductRole' && (parts.includes('name') || /name/.test(cause?.constraint?.index ?? ''))) return 'ROLE_NAME_TAKEN';
  return 'CONFLICT';
}

const DB_CONNECTION_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2037', 'P2024']);
const DB_CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300']);
const DB_ADAPTER_KINDS = new Set(['ConnectionClosed', 'DatabaseNotReachable', 'SocketTimeout', 'TooManyConnections']);
const DB_CONNECTION_MESSAGE = /Server has closed the connection|Connection terminated|Can't reach database server|Connection ended unexpectedly/i;

/** Geçici bağlantı sorunu: kullanıcı hatası değil, 503. Yazma tekrar edilmez (sunucuda tamamlanmış olabilir). */
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

/**
 * Eşzamanlı yazma çakışması: serileştirme (P2034), kilitlenme (40P01), kilidi atlayan CHECK ihlali (23514), yabancı anahtar ihlali
 * (23503, P2003: ör. eşzamanlı silinen özel role bağlanan üyelik; rol silme kilitleri sırayla aldığından yalnız yarışta görülür).
 */
function isConflictError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2034' || err.code === 'P2003')) return true;
  const cause = (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause;
  if (cause?.originalCode === '23514' || cause?.originalCode === '23503' || cause?.originalCode === '40P01' || cause?.originalCode === '40001') return true;
  const message = err instanceof Error ? err.message : '';
  return /40P01|40001|23514|23503|deadlock detected|could not serialize|violates check constraint|violates foreign key constraint/i.test(message);
}

function messageFor(err: AppError, locale: Locale): string {
  if (err.code === 'RESET_CODE_NOT_ALLOWED') {
    const reason = (err.details as { reason?: keyof typeof RESET_CODE_REASONS } | undefined)?.reason;
    if (reason && RESET_CODE_REASONS[reason]) return RESET_CODE_REASONS[reason][locale];
  }
  if (err.code === 'ROLE_FORBIDDEN') {
    const reason = (err.details as { reason?: RoleForbiddenReason } | undefined)?.reason;
    if (reason && ROLE_FORBIDDEN_REASONS[reason]) return ROLE_FORBIDDEN_REASONS[reason][locale];
  }
  if (err.code === 'FORBIDDEN') {
    const reason = (err.details as { reason?: keyof typeof FORBIDDEN_REASONS } | undefined)?.reason;
    if (reason && FORBIDDEN_REASONS[reason]) return FORBIDDEN_REASONS[reason][locale];
  }
  if (err.code === 'OWNER_REQUIRES_EMAIL') {
    const reason = (err.details as { reason?: keyof typeof OWNER_EMAIL_REASONS } | undefined)?.reason;
    if (reason && OWNER_EMAIL_REASONS[reason]) return OWNER_EMAIL_REASONS[reason][locale];
  }
  return errorMessage(err.code, locale);
}

function body(req: FastifyRequest, code: ApiErrorCode, details?: unknown) {
  const locale = localeOf(req);
  return { error: { code, message: errorMessage(code, locale), ...(details !== undefined ? { details } : {}) } };
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(body(req, 'NOT_FOUND'));
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    const locale = localeOf(req);
    if (err instanceof AppError) {
      if (err.retryAfterSeconds) void reply.header('retry-after', String(err.retryAfterSeconds));
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: messageFor(err, locale), ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(body(req, 'VALIDATION', zodDetails(err, locale, req.url)));
    }
    if (err instanceof ValidationIssue) {
      return reply
        .status(400)
        .send(body(req, 'VALIDATION', [{ path: err.path, code: err.key, message: validationMessage(err.key, locale) }]));
    }
    const uniqueCode = uniqueViolationCode(err);
    if (uniqueCode) return reply.status(409).send(body(req, uniqueCode));
    const fe = err as FastifyError;
    const code = fe.code ?? '';
    if (fe.validation || code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send(body(req, 'VALIDATION'));
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send(body(req, 'BAD_REQUEST'));
    }
    if (isDbConnectionError(err)) {
      req.log.warn({ err }, 'veritabanı bağlantısı koptu');
      return reply.status(503).header('retry-after', '3').send(body(req, 'DB_UNAVAILABLE'));
    }
    if (isConflictError(err)) {
      req.log.warn({ err }, 'eşzamanlı yazma çakışması');
      return reply.status(409).send(body(req, 'CONFLICT'));
    }
    req.log.error(err);
    return reply.status(500).send(body(req, 'INTERNAL'));
  });
}
