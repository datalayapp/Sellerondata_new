import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorMessage, requestLocaleOf, type ApiErrorBody, type ApiErrorCode } from '@sellerondata/contracts';

/**
 * Merkez uçlarının (`/api/ai/*`) hata gövdesi platformun ortak biçimidir (`ApiErrorBody`), metin `Accept-Language`'a göre.
 * Araç yollarının (`/internal/*`) gövdesi sağlayıcı biçimindedir (`aiRejectBody`); o yollar bu işleyiciye düşmeden yanıt verir.
 * Hiçbir hata gövdesi istek gövdesini, başlığı ya da iç hata metnini yansıtmaz: doğrulama ayrıntısı yalnız alan adı ve kod.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ApiErrorCode,
    public details?: Record<string, unknown> | unknown[],
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export const forbidden = () => new AppError(403, 'FORBIDDEN');
export const notFound = () => new AppError(404, 'NOT_FOUND');
/** Tek alan hatası (`400 VALIDATION`, `details: [{ path, code }]`). */
export const invalidField = (path: string, code = 'invalid_value') => new AppError(400, 'VALIDATION', [{ path, code }]);

function localeOf(req: FastifyRequest): 'tr' | 'en' {
  return requestLocaleOf(req.headers['accept-language'] as string | undefined, (req as { principal?: { locale?: string } }).principal?.locale);
}

export function sendError(req: FastifyRequest, reply: FastifyReply, status: number, code: ApiErrorCode, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message: errorMessage(code, localeOf(req)), ...(details !== undefined ? { details } : {}) } };
  void reply.header('cache-control', 'no-store');
  if (status === 503) void reply.header('retry-after', '3');
  return reply.status(status).send(body);
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSeconds) void reply.header('retry-after', String(err.retryAfterSeconds));
      return sendError(req, reply, err.statusCode, err.code, err.details);
    }
    if (err instanceof ZodError) {
      return sendError(req, reply, 400, 'VALIDATION', err.issues.map((i) => ({ path: i.path.join('.'), code: i.code })));
    }
    const fe = err as FastifyError;
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(req, reply, 413, 'VALIDATION', [{ path: '', code: 'too_large' }]);
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return sendError(req, reply, 415, 'VALIDATION', [{ path: '', code: 'media_type' }]);
    if (fe.validation || fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || (fe.statusCode === 400 && fe.code?.startsWith('FST_ERR_CTP'))) {
      return sendError(req, reply, 400, 'VALIDATION', [{ path: '', code: 'invalid_body' }]);
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) return sendError(req, reply, 400, 'BAD_REQUEST');
    // Yalnız tür ve kod: ileti ve yığın gizli değer taşıyabilir (günlük süzgeci ikinci kattır).
    req.log.error({ errName: err.name, errCode: fe.code }, 'beklenmeyen hata');
    return sendError(req, reply, 500, 'INTERNAL');
  });
  app.setNotFoundHandler((req, reply) => sendError(req, reply, 404, 'NOT_FOUND'));
}
