import type { FastifyBaseLogger } from 'fastify';
import { AI_LEDGER_RETENTION_MONTHS } from '@sellerondata/contracts';
import type { PrismaClient } from '../db.ts';
import { expireDetails, rollupRange, sweepPurgedOrgs } from './purge.ts';

/**
 * Geçidin bakım turu (G4): her `everyMs`'te bir, açılıştan `firstRunMs` sonra ilk kez.
 * 1. Günlük özet: son `ROLLUP_DAYS` UTC gününün kapanmış satırlarından yeniden hesaplanır (geç kapanan çağrı da girer).
 * 2. Silinmiş firmaların artık satırları özete taşınır (`sweepPurgedOrgs`).
 * 3. Saklama süresi (`AI_LEDGER_RETENTION_MONTHS`, 24 ay) dolan ayrıntılı satırlar özete yazılıp silinir.
 * 4. 30 günden eski işlenmiş olay kimlikleri silinir (ürün olay alıcısıyla aynı süre).
 * Her adım ayrı işlemde; biri düşerse ötekiler sürer, hata günlüğe yazılır (ayrıntı yok, yalnız adım ve hata türü).
 * Testte (`NODE_ENV=test`) zamanlayıcı kendiliğinden kurulmaz; testler `runMaintenance`'ı doğrudan çağırır.
 */

export const MAINTENANCE_EVERY_MS = 60 * 60_000;
export const MAINTENANCE_FIRST_RUN_MS = 60_000;
export const ROLLUP_DAYS = 3;
export const PROCESSED_EVENT_TTL_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

export type MaintenanceResult = { rolledGroups: number; sweptRows: number; expiredRows: number; expiredEvents: number };

/** Saklama sınırı: `now`'dan `months` ay önceki UTC gününün başı. */
export function retentionCutoff(now: Date, months = AI_LEDGER_RETENTION_MONTHS): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
}

export async function runMaintenance(prisma: PrismaClient, opts: { now?: Date; log?: FastifyBaseLogger } = {}): Promise<MaintenanceResult> {
  const now = opts.now ?? new Date();
  const result: MaintenanceResult = { rolledGroups: 0, sweptRows: 0, expiredRows: 0, expiredEvents: 0 };
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      opts.log?.error({ step: name, errName: (err as Error)?.name, errCode: (err as { code?: string })?.code }, 'ai-api bakım adımı düştü');
    }
  };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  await step('rollup', async () => {
    result.rolledGroups = await prisma.$transaction((tx) => rollupRange(tx, new Date(today - (ROLLUP_DAYS - 1) * DAY_MS), new Date(today + DAY_MS)));
  });
  await step('purged', async () => {
    result.sweptRows = await sweepPurgedOrgs(prisma);
  });
  await step('retention', async () => {
    result.expiredRows = await prisma.$transaction((tx) => expireDetails(tx, retentionCutoff(now)));
  });
  await step('events', async () => {
    const r = await prisma.processedEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - PROCESSED_EVENT_TTL_MS) } } });
    result.expiredEvents = r.count;
  });
  return result;
}

export type Maintenance = { start(): void; stop(): Promise<void> };

export function createMaintenance(opts: { prisma: PrismaClient; log: FastifyBaseLogger; everyMs?: number; firstRunMs?: number }): Maintenance {
  const everyMs = opts.everyMs ?? (process.env.NODE_ENV === 'test' ? 0 : MAINTENANCE_EVERY_MS);
  const firstRunMs = Math.min(opts.firstRunMs ?? MAINTENANCE_FIRST_RUN_MS, everyMs || MAINTENANCE_FIRST_RUN_MS);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const tick = (delay: number) => {
    if (stopped || everyMs <= 0) return;
    timer = setTimeout(() => {
      running = runMaintenance(opts.prisma, { log: opts.log })
        .then((r) => opts.log.info(r, 'ai-api bakım turu'))
        .catch(() => {})
        .finally(() => {
          running = null;
          tick(everyMs);
        });
    }, delay);
    timer.unref();
  };
  return {
    start: () => tick(firstRunMs),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
