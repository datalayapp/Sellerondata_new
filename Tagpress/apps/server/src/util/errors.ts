import { ERROR_MESSAGES, type ErrorCode, type MessageParams, type ParamArgs, type PlainErrorCode, renderMessage } from "@tagpress/domain";
import type { z } from "zod";

export type FieldError = { path: string; message: string };

/**
 * Kullanıcıya gösterilecek HTTP hatası. Mesaj Türkçe ve tek cümle; `code` kararlı kod (`ERROR_MESSAGES`),
 * `params` cümledeki değişkenler. Yeni hata `fail(code, params)` ile atılır (durum ve metin listeden gelir).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: FieldError[],
    readonly code?: ErrorCode,
    readonly params?: MessageParams,
  ) {
    super(message);
  }
}

type ErrorTemplate<C extends ErrorCode> = (typeof ERROR_MESSAGES)[C]["tr"];

/** Listeden hata: durum kodu, Türkçe cümle ve parametreler tek yerden. */
export function fail<C extends ErrorCode>(code: C, ...[params]: ParamArgs<ErrorTemplate<C>>): HttpError {
  return failWith(code, params as MessageParams | undefined);
}

/** `fail` + doğrulama alanları. */
export function failFields<C extends PlainErrorCode>(code: C, fields: FieldError[]): HttpError {
  return failWith(code, undefined, fields);
}

function failWith(code: ErrorCode, params: MessageParams | undefined, fields?: FieldError[], status?: number): HttpError {
  const def = ERROR_MESSAGES[code];
  return new HttpError(status ?? def.status ?? 400, renderMessage(def.tr, params), fields, code, params && Object.keys(params).length ? params : undefined);
}

/** Durumu çağıranın verdiği kodlar (`status: null`) için. */
export function failStatus<C extends ErrorCode>(status: number, code: C, ...[params]: ParamArgs<ErrorTemplate<C>>): HttpError {
  return failWith(code, params as MessageParams | undefined, undefined, status);
}

/** Yanıt gövdesi: `{ error, code, params?, fields?, provider?, feature?, …ek alanlar }` (ek alanlar: `extra` taşıyan alt sınıf, ör. oluşturucunun `HttpErrorWithBody`'si). */
export function errorBody(err: HttpError): Record<string, unknown> {
  const { provider, feature, extra } = err as { provider?: string; feature?: string; extra?: Record<string, unknown> };
  return {
    ...(extra ?? {}),
    error: err.message,
    ...(err.fields && { fields: err.fields }),
    ...(err.code && { code: err.code }),
    ...(err.params && { params: err.params }),
    ...(provider && { provider }),
    ...(feature && { feature }),
  };
}

/** zod sorunlarını alan yolu + mesaj listesine çevirir. */
export function zodFields(error: z.ZodError, prefix = ""): FieldError[] {
  return error.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

/** Şemayla doğrular; geçersizse 400 + alan yolları. `code`: hatanın kodu (ör. "query-invalid"). */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown, code: PlainErrorCode = "request-invalid"): z.output<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw failFields(code, zodFields(r.error));
  return r.data;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
