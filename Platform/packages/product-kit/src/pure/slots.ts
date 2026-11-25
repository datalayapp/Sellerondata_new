/**
 * Firma başına yuva sayacı, saf (Fastify yok). DeciShip `apps/api/src/services/hub/limiter.ts`'in sayım ve bırakma kuralı;
 * istek ve yanıt bağlantısı çağıranda (product-kit `hub/limiter.ts`). Sayaç nesne başınadır: iki uygulama aynı süreçte
 * birbirinin yuvasını saymaz.
 */

export type SlotCounter<P extends string> = {
  /** Yuva alır; havuzun firma sınırı doluysa `null`. Dönen bırakma bir kez çalışır (sonraki çağrılar etkisiz). */
  take(pool: P, orgId: string): (() => void) | null;
  /** Firmanın bütün havuzlarda tuttuğu yuva sayısı. */
  inUse(orgId: string): number;
};

export function createSlotCounter<P extends string>(limitOf: (pool: P) => number): SlotCounter<P> {
  /** firma → havuz → tutulan yuva; boşalan kayıt silinir */
  const inFlight = new Map<string, Map<P, number>>();
  return {
    take(pool, orgId) {
      const pools = inFlight.get(orgId) ?? new Map<P, number>();
      const used = pools.get(pool) ?? 0;
      if (used >= limitOf(pool)) return null;
      pools.set(pool, used + 1);
      inFlight.set(orgId, pools);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (pools.get(pool) ?? 1) - 1;
        if (left > 0) pools.set(pool, left);
        else pools.delete(pool);
        if (pools.size === 0 && inFlight.get(orgId) === pools) inFlight.delete(orgId);
      };
    },
    inUse(orgId) {
      let n = 0;
      for (const used of inFlight.get(orgId)?.values() ?? []) n += used;
      return n;
    },
  };
}

/**
 * Yuva, işleyici bitince VE yanıt kapanınca bırakılır (ikisi de gerekir, sıra önemsiz). Yalnız yanıtın kapanmasını beklemek iki
 * yönden yanlıştır: istemci kimlik denetimi sırasında koparsa olay kaçar ve yuva hiç dönmez; istemci koptuğunda sorgular sürerken
 * yuva boşalır ve sınır aşılır. Koruyucu süre (`maxMs`) ikisinden biri hiç gelmezse firmayı kilitlemesin diyedir: süre dolunca
 * yuva bırakılır ve `onExpire` çağrılır (çağıran bağlantıyı keser). Zamanlayıcı süreci açık tutmaz.
 */
export function releaseWhenBoth(release: () => void, maxMs: number, onExpire: () => void): { handlerDone(): void; responseClosed(): void } {
  let handlerDone = false;
  let responseClosed = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    release();
  };
  const guard = setTimeout(() => {
    if (done) return;
    finish();
    onExpire();
  }, maxMs);
  guard.unref?.();
  return {
    handlerDone() {
      handlerDone = true;
      if (responseClosed) finish();
    },
    responseClosed() {
      responseClosed = true;
      if (handlerDone) finish();
    },
  };
}
