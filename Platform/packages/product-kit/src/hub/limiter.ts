import { finished } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { KitError, kitMessage } from '../errors.ts';
import { createSlotCounter, releaseWhenBoth } from '../pure/slots.ts';
import { requestLocale } from './http.ts';

/**
 * Firma başına çalışan pahalı istek sınırı (DeciShip `services/hub/limiter.ts`; sayım ve bırakma kuralı saf: `pure/slots.ts`).
 * Süreç içidir: birden çok örnekte sınır örnek başınadır. `general`: Merkez uçları. `export`: uzun CSV akışları; ötekileri bekletmez.
 * Sınırlayıcı nesne başınadır (modül düzeyinde durum yok): iki uygulama aynı süreçte birbirinin yuvasını saymaz.
 */
export type SlotPool = 'general' | 'export';

export type OrgLimiterOptions = {
  /** Firma başına aynı anda `general` istek. Varsayılan 6. */
  general?: number;
  /** Firma başına aynı anda CSV akışı. Varsayılan 2. */
  export?: number;
  /** Koruyucu süre: yuva bu sürede bırakılmazsa bırakılır ve bağlantı kesilir. Varsayılan 5 dk / 30 dk. */
  generalMaxMs?: number;
  exportMaxMs?: number;
};

export type OrgLimiter = {
  /** İşleyiciyi yuvayla sarar. Yetki denetimi önce çalışmalı (`onRequest`): yetkisiz istek yuva tutmaz. */
  limited<R>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R>, pool?: SlotPool): (req: FastifyRequest, reply: FastifyReply) => Promise<R>;
  /** Firmanın şu an tuttuğu yuva sayısı (test ve gözlem). */
  inUse(orgId: string): number;
};

export function createOrgLimiter(opts: OrgLimiterOptions = {}): OrgLimiter {
  const slots = createSlotCounter<SlotPool>((pool) => (pool === 'export' ? (opts.export ?? 2) : (opts.general ?? 6)));
  const maxMsOf = (pool: SlotPool) => (pool === 'export' ? (opts.exportMaxMs ?? 30 * 60_000) : (opts.generalMaxMs ?? 5 * 60_000));

  /** Yuva, yanıt kapanınca VE işleyici bitince bırakılır (`releaseWhenBoth`). `finished` kapanmış akışta da çalışır. */
  function acquire(req: FastifyRequest, reply: FastifyReply, pool: SlotPool): () => void {
    const orgId = req.auth.orgId;
    const release = slots.take(pool, orgId);
    if (!release) {
      void reply.header('retry-after', '3');
      throw new KitError(429, 'TOO_MANY_ATTEMPTS', kitMessage('busy', requestLocale(req, req.auth.locale)));
    }
    const hold = releaseWhenBoth(release, maxMsOf(pool), () => {
      req.log.warn({ pool, orgId }, 'product-kit: yuva koruyucu süreyle bırakıldı');
      reply.raw.destroy();
    });
    finished(reply.raw, () => hold.responseClosed());
    return () => hold.handlerDone();
  }

  return {
    limited(handler, pool = 'general') {
      return async (req, reply) => {
        const handlerFinished = acquire(req, reply, pool);
        try {
          return await handler(req, reply);
        } finally {
          handlerFinished();
        }
      };
    },
    inUse: (orgId) => slots.inUse(orgId),
  };
}
