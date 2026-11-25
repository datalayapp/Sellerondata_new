import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AI_PROVIDERS, AI_SPEND_PATHS, type AiAdminKey, type AiAdminKeysResponse, type AiProvider } from '@sellerondata/contracts';
import type { PlatformAuth } from '../auth/platform.ts';
import { AppError, invalidField, notFound } from '../errors.ts';
import { SealError } from '../keystore/seal.ts';
import { KeyFormatError, type KeyActor, type KeyStore } from '../keystore/store.ts';

/**
 * Platform yöneticisinin anahtar uçları (sözleşme `aiSpend.ts` "Platform yöneticisi"):
 * - `GET  /api/ai/admin/keys`                  op                → `{ keys }` (anahtar yok; son 4 hane, kim, ne zaman, son sınama)
 * - `PUT  /api/ai/admin/keys/:provider`        op + adım artırma → önce sınar; ret `400 AI_KEY_REJECTED`, ulaşılamıyor
 *   `503 AI_PROVIDER_UNREACHABLE` (ikisinde de kaydedilmez)
 * - `DELETE /api/ai/admin/keys/:provider`      op + adım artırma → `state: 'missing'`
 * - `POST /api/ai/admin/keys/:provider/test`   op                → son sınama güncellenir; anahtar yoksa `404 NOT_FOUND`
 * Bilinmeyen sağlayıcı `404 NOT_FOUND`. Gövde doğrulama hatası alan adını ve kodu söyler, girilen değeri hiçbir zaman yansıtmaz.
 */

const SetKeyBody = z.object({ key: z.string() }).strict();

function providerParam(req: FastifyRequest): AiProvider {
  const p = (req.params as { provider?: string }).provider;
  if (!p || !(AI_PROVIDERS as readonly string[]).includes(p)) throw notFound();
  return p as AiProvider;
}

function actorOf(req: FastifyRequest): KeyActor {
  const p = req.principal!;
  return { id: p.personId, name: p.name };
}

function sealFailure(req: FastifyRequest, provider: AiProvider, err: SealError): never {
  req.log.error({ provider, reason: err.reason }, 'anahtar mührü açılamadı (AI_KEY_MASTER / AI_KEY_MASTER_PREVIOUS)');
  throw new AppError(500, 'INTERNAL');
}

export function adminKeyRoutes(app: FastifyInstance, deps: { keys: KeyStore; auth: PlatformAuth }) {
  const { authenticate, requireOperator, requireStepUp } = deps.auth;
  const op = [authenticate, requireOperator];
  const opStepUp = [authenticate, requireOperator, requireStepUp];
  const base = AI_SPEND_PATHS.adminKeys;

  app.get(base, { onRequest: op }, async (): Promise<AiAdminKeysResponse> => ({ keys: await deps.keys.list() }));

  app.put(`${base}/:provider`, { onRequest: opStepUp, bodyLimit: 4096 }, async (req): Promise<AiAdminKey> => {
    const provider = providerParam(req);
    const parsed = SetKeyBody.safeParse(req.body);
    if (!parsed.success) throw invalidField('key', 'invalid_type');
    let result;
    try {
      result = await deps.keys.set(provider, parsed.data.key, actorOf(req));
    } catch (e) {
      if (e instanceof KeyFormatError) throw invalidField('key', 'invalid_format');
      throw e;
    }
    if (!result.ok) {
      req.log.info({ provider, reason: result.reason, httpStatus: result.httpStatus }, 'anahtar kaydedilmedi');
      if (result.reason === 'rejected') throw new AppError(400, 'AI_KEY_REJECTED');
      throw new AppError(503, 'AI_PROVIDER_UNREACHABLE');
    }
    req.log.info({ provider, last4: result.key.last4 }, 'anahtar kaydedildi');
    return result.key;
  });

  app.delete(`${base}/:provider`, { onRequest: opStepUp }, async (req): Promise<AiAdminKey> => {
    const provider = providerParam(req);
    const key = await deps.keys.remove(provider, actorOf(req));
    req.log.info({ provider }, 'anahtar kaldırıldı');
    return key;
  });

  app.post(`${base}/:provider/test`, { onRequest: op, bodyLimit: 1024 }, async (req): Promise<AiAdminKey> => {
    const provider = providerParam(req);
    let key: AiAdminKey | null;
    try {
      key = await deps.keys.test(provider, actorOf(req));
    } catch (e) {
      if (e instanceof SealError) sealFailure(req, provider, e);
      throw e;
    }
    if (!key) throw notFound();
    return key;
  });
}
