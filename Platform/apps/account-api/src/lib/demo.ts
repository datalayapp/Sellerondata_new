import { env, LOCAL_HOSTS } from '../env.ts';
import { SEED_PEOPLE } from '../seed.ts';
import type { prisma } from '../db.ts';

export const DEMO_EMAIL_DOMAIN = 'demo.sellerondata.com';

/** Adres yapılandırmadan okunur (APP_BASE_URL), istek başlığından değil: başlığı istemci yazar. */
export function isLocalAppAddress(): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(env.appBaseUrl).hostname);
  } catch {
    return false;
  }
}

/** Canlı kurulumda demo hesap (bilinen şifre) bulunursa açılış durur. Yerel üretim sınamasında çalışmaz. */
export async function assertNoDemoAccounts(db: Pick<typeof prisma, 'person'>): Promise<void> {
  if (!env.isProduction || isLocalAppAddress()) return;
  const found = await db.person.findMany({
    where: {
      OR: [{ id: { in: SEED_PEOPLE.map((p) => p.id) } }, { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}`, mode: 'insensitive' } }],
    },
    select: { id: true, email: true },
    take: 20,
  });
  if (found.length) {
    const who = found.map((p) => p.email ?? p.id).join(', ');
    throw new Error(`Üretim veritabanında demo hesap var (${who}). Demo verisi canlıya taşınamaz: veritabanını sıfırdan kurun.`);
  }
}
