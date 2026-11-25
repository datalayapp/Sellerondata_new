import { currentPersonId, currentSessionScope } from '../api/client';
import { clearHubCache } from './store';

/** Önbelleğin sahibi: kişi + firma. Firmasız oturumda kişi. Oturum yoksa null. */
export function sessionOwnerKey(): string | null {
  const person = currentPersonId();
  return person ? `${person}:${currentSessionScope()?.orgId ?? ''}` : null;
}

/**
 * Merkez önbelleği kişiye ve firmaya aittir. Sahip değişince silinir: çıkış, zorunlu çıkış, hesap değişimi, firma değişimi.
 * Açılışta oturum geri yüklenirken silinmez: aynı kişi çevrimdışı son verisini görür. Oturum yoksa silinir.
 */
export function createSessionCacheGuard(ownerKey: () => string | null, clear: () => Promise<void>) {
  let armed = false;
  let last: string | null = null;
  return {
    /** Oturum yüklendikten sonra bir kez. */
    arm(): void {
      armed = true;
      last = ownerKey();
      if (last === null) void clear();
    },
    onChange(): void {
      if (!armed) return;
      const next = ownerKey();
      if (next === last) return;
      last = next;
      void clear();
    },
  };
}

export const hubCacheGuard = createSessionCacheGuard(sessionOwnerKey, clearHubCache);
