import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NOTICE_LIMITS, type ProductKey } from '@sellerondata/contracts';
import { env } from '../env.ts';
import { AppError, unauthorized } from '../errors.ts';
import { bearerSecret, noticeBodySchema, productForSecret, sendProductNotice } from '../lib/productNotice.ts';

/**
 * Araçların iç uçları. Yalnız iç ağdan: gateway `(^|/)internal(/|$)` geçen her yolu 404 yapar (`gateway/conf/default.conf`,
 * `scripts/dev-gateway.mjs`), üretimde `account-api` portu dışarı açık değildir. Kullanıcı oturumu kabul edilmez; kimlik ürün anahtarıdır.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Bildirim anahtarından çözülen ürün (yalnız iç uçlarda). */
    notifyProduct?: ProductKey;
  }
}

/**
 * Gövde ayrıştırılmadan önce (onRequest): kimliksiz istek gövde hatası da öğrenmez. Anahtar ne günlüğe ne yanıta girer;
 * istek günlüğü yalnız yöntem, yol ve IP yazar (`app.ts` serileştirici).
 */
async function requireProductSecret(req: FastifyRequest) {
  const presented = bearerSecret(req.headers.authorization);
  const secrets = env.productNotifySecrets;
  const product = presented && secrets.size ? productForSecret(presented, secrets) : null;
  if (!product) throw unauthorized();
  req.notifyProduct = product;
}

export async function internalRoutes(app: FastifyInstance) {
  // Sınırı aşan gövde 413 değil sözleşmedeki 400 VALIDATION; diğer hatalar üst işleyiciye geçer.
  app.setErrorHandler((err: Error & { code?: string }) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') throw new AppError(400, 'VALIDATION');
    throw err;
  });

  app.post('/internal/notify', { onRequest: requireProductSecret, bodyLimit: NOTICE_LIMITS.bodyBytes }, async (req) => {
    // Bir araç başka aracın adına bildirim isteyemez: ürün anahtardan gelir, gövdedeki ad yalnız onu tekrarlar.
    // Gövde doğrulamasından önce: başka aracın kurallarına göre doğrulama sonucu da öğrenilmez.
    if ((req.body as { product?: unknown } | null | undefined)?.product !== req.notifyProduct) throw unauthorized();
    const body = noticeBodySchema.parse(req.body);
    if (body.product !== req.notifyProduct) throw unauthorized();
    return sendProductNotice(body, { log: req.log });
  });
}
