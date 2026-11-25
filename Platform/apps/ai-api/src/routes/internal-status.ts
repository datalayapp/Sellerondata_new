import type { AiGatewayStatus } from '@sellerondata/contracts';
import type { PrismaClient } from '../db.ts';
import type { InternalRoutes } from '../internal/scope.ts';
import type { KeyStore } from '../keystore/store.ts';
import { platformStopped, platformUsage } from '../limits/usage.ts';

/**
 * `GET /internal/status` (araç jetonuyla, iç ağ; kapsamın kancası denetler) → `AiGatewayStatus`. Araç `aiEnabled()` / `/me
 * ai.available` değerini buradan okur (30 sn önbellek). `paused`: yönetici durdurdu ya da platformun günlük / aylık tavanı doldu;
 * `available`: durmamış ve en az bir sağlayıcının anahtarı `ok`. Firma ya da tutar bilgisi yok.
 */
export function internalStatusRoutes(deps: { prisma: PrismaClient; keys: Pick<KeyStore, 'providerStates'>; now?: () => Date }): InternalRoutes {
  const now = deps.now ?? (() => new Date());
  return (scope) => {
    // Testin `internalRoutes` ile önce verdiği aynı adresli yol kalır (G1 testlerinin yer tutucuları); üretimde liste boştur.
    if ((scope.sodRoutes ?? []).includes(`GET ${scope.prefix}/status`)) return;
    scope.get('/status', async (_req, reply) => {
      const [providers, platform] = await Promise.all([deps.keys.providerStates(), platformUsage(deps.prisma, now())]);
      const paused = platformStopped(platform);
      const body: AiGatewayStatus = { available: !paused && Object.values(providers).some((s) => s === 'ok'), paused, providers };
      void reply.header('cache-control', 'no-store');
      return body;
    });
  };
}
