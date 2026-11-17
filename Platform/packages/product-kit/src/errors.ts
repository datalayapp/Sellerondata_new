import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorMessage, type ApiErrorCode, type Locale, type LocalizedText } from '@sellerondata/contracts';

/**
 * Paketin kendi ayrıntı metinleri (API hata iletisi; arayüz metni değil). Kod ve genel metin `contracts/errors.ts`'tedir,
 * istemci yalnız `code`'a bakar. `{name}` ve `{days}` yer tutucudur.
 */
export const KIT_MESSAGES = {
  dateFormat: { tr: 'Tarih YYYY-AA-GG biçiminde olmalı', en: 'Date must be in YYYY-MM-DD format' },
  dateOrder: { tr: 'Başlangıç tarihi bitişten sonra olamaz', en: 'Start date cannot be after the end date' },
  dateRange: { tr: 'Tarih aralığı en çok {days} gün olabilir', en: 'The date range can be at most {days} days' },
  filter: { tr: 'Filtre değeri geçersiz: {name}', en: 'Invalid filter value: {name}' },
  busy: {
    tr: 'Firmanızda çok sayıda rapor aynı anda hazırlanıyor; birkaç saniye sonra yeniden deneyin',
    en: 'Too many reports are being prepared for your company at once. Try again in a few seconds',
  },
  datasetNotFound: { tr: 'Veri kümesi bulunamadı', en: 'Dataset not found' },
} as const satisfies Record<string, LocalizedText>;

export type KitMessageKey = keyof typeof KIT_MESSAGES;

export function kitMessage(key: KitMessageKey, locale: Locale, vars: Record<string, string | number> = {}): string {
  return KIT_MESSAGES[key][locale].replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

/** İstemciye `{ error: { code, message, details? } }` olarak dönen hata. Merkez sağlayıcıları da fırlatabilir. */
export class KitError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'KitError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

/** Kodun genel metniyle (contracts) hata. */
export function kitError(status: number, code: ApiErrorCode, locale: Locale, details?: Record<string, unknown>): KitError {
  return new KitError(status, code, errorMessage(code, locale), details);
}

export function sendKitError(_req: FastifyRequest, reply: FastifyReply, err: KitError) {
  void reply.header('cache-control', 'no-store');
  return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
}
