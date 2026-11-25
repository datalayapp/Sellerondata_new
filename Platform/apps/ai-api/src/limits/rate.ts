import { AI_LIMIT_DEFAULTS } from '@sellerondata/contracts';

/**
 * Hız ve eşzamanlılık (süreç içi; para payı değil, o defterdedir). Kabul edilen her çağrı bir kira alır; `settle` ya da `release`
 * kirayı bırakır (bir kez; ikinci bildirim etkisiz). Sınırlar [V]:
 * - firma başına dakikada `orgCallsPerMinute` çağrı (kayan 60 sn pencere; sağlayıcıya gitmeyen çağrı `release` ile pencereden düşer);
 * - firma başına aynı anda `orgConcurrentStreams` akışlı çağrı;
 * - araç başına aynı anda `toolConcurrent` çağrı (akışlı ya da değil).
 * Bildirimi hiç gelmeyen kira (hata) `leaseMs` sonra kendiliğinden düşer: sayaç sonsuza dek dolu kalmasın.
 * Birden çok geçit süreci açılırsa sınırlar süreç başınadır (bugün tek süreç).
 */

export type RateConfig = {
  orgCallsPerMinute: number;
  orgConcurrentStreams: number;
  toolConcurrent: number;
  /** Kiranın en uzun ömrü (ms): akışın üst süresi + pay. */
  leaseMs: number;
};

export const RATE_DEFAULTS: RateConfig = {
  orgCallsPerMinute: AI_LIMIT_DEFAULTS.orgCallsPerMinute,
  orgConcurrentStreams: AI_LIMIT_DEFAULTS.orgConcurrentStreams,
  toolConcurrent: AI_LIMIT_DEFAULTS.toolConcurrent,
  leaseMs: AI_LIMIT_DEFAULTS.maxStreamMs + 60_000,
};

/** Eşzamanlılık retinde önerilen bekleme (sn). */
export const CONCURRENCY_RETRY_SEC = 5;
const WINDOW_MS = 60_000;

type Lease = { orgId: string; product: string; stream: boolean; at: number };

export type RateRequest = { orgId: string; product: string; stream: boolean };

export class RateGate {
  private readonly minute = new Map<string, Map<string, number>>();
  private readonly streams = new Map<string, number>();
  private readonly tools = new Map<string, number>();
  private readonly leases = new Map<string, Lease>();

  constructor(
    private readonly cfg: RateConfig = RATE_DEFAULTS,
    private readonly now: () => number = Date.now,
  ) {}

  private inc(map: Map<string, number>, key: string, by: number) {
    const v = (map.get(key) ?? 0) + by;
    if (v > 0) map.set(key, v);
    else map.delete(key);
  }

  private prune(t: number) {
    for (const [id, lease] of this.leases) if (t - lease.at >= this.cfg.leaseMs) this.drop(id, lease, false);
    for (const [org, calls] of this.minute) {
      for (const [id, at] of calls) if (t - at >= WINDOW_MS) calls.delete(id);
      if (calls.size === 0) this.minute.delete(org);
    }
  }

  private drop(id: string, lease: Lease, refundMinute: boolean) {
    this.leases.delete(id);
    if (lease.stream) this.inc(this.streams, lease.orgId, -1);
    this.inc(this.tools, lease.product, -1);
    if (refundMinute) {
      const calls = this.minute.get(lease.orgId);
      calls?.delete(id);
      if (calls?.size === 0) this.minute.delete(lease.orgId);
    }
  }

  /** Denetle ve al (eşzamanlı çağrıda arada `await` yok: denetim ile sayaç artışı bölünmez). */
  acquire(id: string, req: RateRequest): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    this.prune(t);
    if (this.leases.has(id)) return { ok: true };
    const calls = this.minute.get(req.orgId);
    if (calls && calls.size >= this.cfg.orgCallsPerMinute) {
      const oldest = Math.min(...calls.values());
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - t) / 1000)) };
    }
    if (req.stream && (this.streams.get(req.orgId) ?? 0) >= this.cfg.orgConcurrentStreams) return { ok: false, retryAfterSec: CONCURRENCY_RETRY_SEC };
    if ((this.tools.get(req.product) ?? 0) >= this.cfg.toolConcurrent) return { ok: false, retryAfterSec: CONCURRENCY_RETRY_SEC };
    this.leases.set(id, { ...req, at: t });
    if (req.stream) this.inc(this.streams, req.orgId, 1);
    this.inc(this.tools, req.product, 1);
    let bucket = this.minute.get(req.orgId);
    if (!bucket) this.minute.set(req.orgId, (bucket = new Map()));
    bucket.set(id, t);
    return { ok: true };
  }

  /** Kirayı bırakır. `refundMinute`: çağrı sağlayıcıya hiç gitmedi, dakika hakkı geri verilir. Kira yoksa false. */
  release(id: string, refundMinute = false): boolean {
    const lease = this.leases.get(id);
    if (!lease) return false;
    this.drop(id, lease, refundMinute);
    return true;
  }

  /** Test ve tanı: açık kira sayısı. */
  get inFlight(): number {
    return this.leases.size;
  }
}
