import { finished } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withDbLane } from '../../db.ts';
import { env } from '../../env.ts';
import { AppError } from '../../errors.ts';
import { m } from '../../i18n/index.ts';
import { withSettingsMemo } from './metrics.ts';

/**
 * Firma başına çalışan pahalı istek. Süreç içidir: birden çok örnekte sınır örnek başınadır.
 * `general`: Merkez, Pano, satır listesi, rapor. `export`: uzun süren CSV akışları, ötekileri bekletmez.
 * `read`: sık kullanılan listeler. Sınır geniştir: yalnız bir firmanın havuzu tek başına doldurmasını önler.
 */
export type SlotPool = 'general' | 'export' | 'read';

const inFlight = new Map<string, number>();
const keyOf = (pool: SlotPool, orgId: string) => `${pool}:${orgId}`;

export const hubSlotsInUse = (orgId: string) => (['general', 'export', 'read'] as const).reduce((n, pool) => n + (inFlight.get(keyOf(pool, orgId)) ?? 0), 0);

const limitOf = (pool: SlotPool) => (pool === 'export' ? env.hubExportConcurrencyPerOrg : pool === 'read' ? env.readConcurrencyPerOrg : env.hubConcurrencyPerOrg);

/**
 * Yuva, yanıt kapanınca VE işleyici bitince bırakılır. Yalnız `close` dinlemek iki yönden yanlıştır: istemci kimlik denetimi
 * sırasında koparsa olay kaçar ve yuva hiç dönmez; istemci koptuğunda sorgular sürerken yuva boşalır ve sınır aşılır.
 * `finished` kapanmış akışta da çalışır. Koruyucu süre, ikisinden biri hiç gelmezse firmayı kilitlemesin diyedir.
 */
function acquire(req: FastifyRequest, reply: FastifyReply, pool: SlotPool): () => void {
  const orgId = req.auth.orgId;
  const key = keyOf(pool, orgId);
  const limit = limitOf(pool);
  const used = inFlight.get(key) ?? 0;
  if (used >= limit) {
    reply.header('retry-after', '3');
    throw new AppError(429, 'TOO_MANY_REQUESTS', m(pool === 'read' ? 'err.busy' : 'err.hubBusy'));
  }
  inFlight.set(key, used + 1);

  let released = false;
  let handlerDone = false;
  let responseClosed = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(guard);
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };
  const guard = setTimeout(() => {
    req.log.warn({ pool, orgId }, 'yuva koruyucu süreyle bırakıldı');
    release();
    reply.raw.destroy();
  }, pool === 'export' ? env.hubExportMaxMs : env.hubSlotMaxMs);
  guard.unref();

  finished(reply.raw, () => {
    responseClosed = true;
    if (handlerDone) release();
  });
  return () => {
    handlerDone = true;
    if (responseClosed) release();
  };
}

/**
 * Merkez sorgu kapısından (db.ts `withDbLane('hub')`) geçen uçlar: Merkez (`/platform/*`), Pano, fatura raporu ve itiraz
 * kanıtı. Havuzdan bağımsızdır: `general` havuzundaki `/invoices/:id/lines` ve `/invoices/:id/tariff-health` günlük
 * çalışma ekranıdır, kapıya girmez (başka firmanın analizi yüzünden beklemesin). Yol, önek ne olursa olsun sonundan eşlenir.
 */
export const HUB_LANE_ROUTES = ['/dashboard', '/invoices/:id/report.xlsx', '/invoices/:id/report.pdf', '/invoices/:id/dispute/evidence.zip'] as const;

export function usesHubLane(routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  return /\/platform\//.test(routeUrl) || HUB_LANE_ROUTES.some((r) => routeUrl.endsWith(r));
}

/** İşleyiciyi yuvayla sarar. Yetki denetimi önce çalışır: yetkisiz istek yuva tutmaz. */
export function limited<R>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R>, pool: SlotPool = 'general') {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<R> => {
    const handlerFinished = acquire(req, reply, pool);
    try {
      // 19-B14: firma ayarı istek başına bir kez okunur (`metrics.ts` `companySettings`)
      const run = () => withSettingsMemo(() => handler(req, reply));
      return usesHubLane(req.routeOptions.url) ? await withDbLane('hub', run) : await run();
    } finally {
      handlerFinished();
    }
  };
}
