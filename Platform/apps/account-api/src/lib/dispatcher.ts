import type { PlatformEvent } from '@sellerondata/contracts';
import { prisma } from '../db.ts';
import { env } from '../env.ts';
import { LIFECYCLE_EVENT_TYPES } from './outbox.ts';
import { signEventToken } from './tokens.ts';

/**
 * Outbox dağıtıcısı. En az bir kez teslim eder; alıcı `eventId` ile tekrarı eler.
 *
 * Satır, ağ çağrısı boyunca kilitli tutulmaz. Kısa işlemde `SKIP LOCKED` ile sahiplenilir ve `nextAttemptAt` ileri atılır (kira).
 * Süreç ölürse kira biter, satır yeniden denenir. Birden çok kopya aynı anda çalışabilir.
 */

export const DISPATCH_BATCH = 50;
export const DISPATCH_TIMEOUT_MS = 5_000;
/** Kira, zaman aşımının üstünde olmalı: süren gönderim yeniden sahiplenilmesin. */
export const DISPATCH_LEASE_SECONDS = 60;
/**
 * Bu süre boyunca denenir, sonra DEAD. Hafta sonu kesintisi olayı düşürmesin. Kurtarma: `npm run outbox:requeue`.
 * Firma yaşam döngüsü olayları (`LIFECYCLE_EVENT_TYPES`) bu sınıra tabi değil: hiç DEAD olmaz, en çok saatte bir denenir.
 */
export const DISPATCH_GIVE_UP_AFTER_MS = 72 * 60 * 60_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** Üstel geri çekilme, %20'ye kadar sarsıntı. `attempt` 1'den başlar. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (1 + random() * 0.2));
}

type Claimed = { id: string; outboxId: string; target: string; attempts: number; createdAt: Date };

async function claimDue(limit: number): Promise<Claimed[]> {
  return prisma.$queryRaw<Claimed[]>`
    UPDATE "platform"."OutboxDelivery"
    SET "attempts" = "attempts" + 1,
        "nextAttemptAt" = now() + make_interval(secs => ${DISPATCH_LEASE_SECONDS}::double precision)
    WHERE "id" IN (
      SELECT "id" FROM "platform"."OutboxDelivery"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= now()
      ORDER BY "nextAttemptAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "outboxId", "target", "attempts", "createdAt"`;
}

export type DispatchResult = { claimed: number; delivered: number; failed: number; dead: number };

export type DispatcherOptions = {
  fetch?: typeof fetch;
  log?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

type OutboxRow = { id: string; type: string; payload: unknown; createdAt: Date };

/** Teslim edilemeyen olay bırakılır mı: yaşam döngüsü olayı asla, öbürleri pencere dolunca. */
export function shouldGiveUp(type: string, createdAt: Date, nowMs = Date.now()): boolean {
  if (LIFECYCLE_EVENT_TYPES.includes(type)) return false;
  return nowMs - createdAt.getTime() >= DISPATCH_GIVE_UP_AFTER_MS;
}

async function deliver(claim: Claimed, outbox: OutboxRow, doFetch: typeof fetch): Promise<void> {
  const url = env.eventTargets.get(claim.target);
  if (!url) throw new Error(`hedef tanımsız: ${claim.target}`);
  const token = await signEventToken(outbox.payload as unknown as PlatformEvent, outbox.createdAt);
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    redirect: 'error',
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Aynı varlığın olayları paralel gitmez: alıcıda yarış, askıyı kaybettirebilir. Hedef + üye (veya firma + tür) başına sıra. */
function orderingKey(target: string, event: { membershipId?: string; orgId?: string; type?: string }): string {
  return event.membershipId ? `${target}:m:${event.membershipId}` : `${target}:o:${event.orgId}:${event.type}`;
}

function orderValue(event: { epoch?: number; version?: number }): number {
  return event.epoch ?? event.version ?? 0;
}

export async function dispatchOnce(opts: DispatcherOptions = {}): Promise<DispatchResult> {
  const doFetch = opts.fetch ?? fetch;
  const claims = await claimDue(DISPATCH_BATCH);
  const result: DispatchResult = { claimed: claims.length, delivered: 0, failed: 0, dead: 0 };
  if (claims.length === 0) return result;

  const outboxes = await prisma.outbox.findMany({
    where: { id: { in: claims.map((c) => c.outboxId) } },
    select: { id: true, type: true, payload: true, createdAt: true },
  });
  const outboxById = new Map(outboxes.map((o) => [o.id, o]));
  const groups = new Map<string, { claim: Claimed; outbox: OutboxRow }[]>();
  for (const claim of claims) {
    const outbox = outboxById.get(claim.outboxId);
    if (!outbox) continue;
    const key = orderingKey(claim.target, outbox.payload as { membershipId?: string; orgId?: string; type?: string });
    groups.set(key, [...(groups.get(key) ?? []), { claim, outbox }]);
  }
  for (const group of groups.values()) {
    // Aynı işlemdeki olayların createdAt'i eşit olabilir: önce epoch veya sürüm.
    group.sort(
      (a, b) =>
        orderValue(a.outbox.payload as { epoch?: number }) - orderValue(b.outbox.payload as { epoch?: number }) ||
        a.outbox.createdAt.getTime() - b.outbox.createdAt.getTime(),
    );
  }

  const attempt = async ({ claim, outbox }: { claim: Claimed; outbox: OutboxRow }) => {
    {
      try {
        await deliver(claim, outbox, doFetch);
        await prisma.outboxDelivery.updateMany({
          where: { id: claim.id, status: { not: 'DELIVERED' } },
          data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
        });
        result.delivered += 1;
      } catch (err) {
        const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const isDead = shouldGiveUp(outbox.type, new Date(claim.createdAt));
        // Kira korundu mu: başka kopya sahiplendiyse veya teslim ettiyse geç gelen hata kaydı bozmaz.
        const { count } = await prisma.outboxDelivery.updateMany({
          where: { id: claim.id, status: 'PENDING', attempts: claim.attempts },
          data: {
            lastError,
            ...(isDead
              ? { status: 'DEAD' as const }
              : { nextAttemptAt: new Date(Date.now() + backoffMs(claim.attempts)) }),
          },
        });
        if (count === 0) return;
        if (isDead) {
          result.dead += 1;
          // Güvenlik sınırı jeton ömrüdür; ölü olay yalnız projeksiyonu geride bırakır, JIT ve epoch telafi eder.
          opts.log?.error({ outboxId: claim.outboxId, target: claim.target, lastError }, 'olay teslim edilemedi, bırakıldı');
        } else {
          result.failed += 1;
          opts.log?.warn({ outboxId: claim.outboxId, target: claim.target, attempts: claim.attempts, lastError }, 'olay teslim edilemedi');
        }
      }
    }
  };

  // Gruplar paralel, grup içi sıralı. Başarısız olay sırayı kesmez: sonraki olay daha yeni, eskisi gelirse alıcı epoch ile eler.
  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const item of group) await attempt(item);
    }),
  );
  return result;
}

/** DEAD teslimleri yeniden kuyruğa alır, yeni pencere başlar. `npm run outbox:requeue`. Alıcı idempotent ve epoch korumalı: güvenli. */
export async function requeueDeadDeliveries(): Promise<number> {
  const now = new Date();
  const { count } = await prisma.outboxDelivery.updateMany({
    where: { status: 'DEAD' },
    data: { status: 'PENDING', attempts: 0, createdAt: now, nextAttemptAt: now, lastError: null },
  });
  return count;
}

export function startDispatcher(opts: DispatcherOptions = {}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> = Promise.resolve();

  const tick = () => {
    running = dispatchOnce(opts)
      .catch((err) => opts.log?.error({ err }, 'dağıtıcı turu başarısız'))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, env.dispatcherIntervalMs);
      });
  };
  timer = setTimeout(tick, env.dispatcherIntervalMs);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
