import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.ts';
import { env } from './env.ts';

let client: PrismaClient | undefined;

export const TX_DEFAULTS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Oturum saat dilimi UTC: Prisma `DateTime` değerini UTC yazar, ham SQL `now()` ile karşılaştırılır. Boşta düşen bağlantı erken
 * fark edilir, havuz 5 dakikada bir yenilenir (Hesap servisiyle aynı ayar).
 */
export const POOL_DEFAULTS = {
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  maxLifetimeSeconds: 300,
  options: '-c TimeZone=UTC',
} as const;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.databaseUrl, ...POOL_DEFAULTS }),
      transactionOptions: TX_DEFAULTS,
    });
  }
  return client;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const c = getPrisma() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export async function disconnectPrisma() {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

export type Tx = Prisma.TransactionClient;
export type { PrismaClient };
export { Prisma };
