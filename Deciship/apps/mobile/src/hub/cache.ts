import type { MeResponse } from './contracts';

/**
 * Tek basit önbellek: son veri, cihazda tek kayıt. Çevrimdışında "son güncelleme" ile gösterilir.
 * Sahibi `scope`: kişi + firma + yetkiler. Biri değişince hepsi silinir, başkasının verisi görünmez.
 * Depolama dışarıdan verilir: saf, test edilir.
 */
export type CacheEntry<T = unknown> = { at: number; data: T };
type CacheBlob = { scope: string; me: MeResponse | null; entries: Record<string, CacheEntry> };

/** Önbellekteki kişi elimizdeki jetonun kişi + firması mı? Çevrimdışı gösterimden önce sorulur. */
export function cacheOwnedBy(me: MeResponse | null, scope: { personId: string; orgId: string } | null): boolean {
  return !!me && !!scope && me.person.id === scope.personId && me.activeOrg?.id === scope.orgId;
}

export type CacheStorage = {
  get: () => Promise<unknown>;
  set: (value: unknown) => Promise<void>;
};

const MAX_ENTRIES = 12;

export function createHubCache(storage: CacheStorage, opts: { now?: () => number; maxEntries?: number } = {}) {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? MAX_ENTRIES;
  let blob: CacheBlob = { scope: '', me: null, entries: {} };
  let writing: Promise<void> = Promise.resolve();
  /** Sahip değişince artar. Yolda kalan okuma ve yazma eski sahibin verisini geri getiremez. */
  let generation = 0;

  const persist = (value: unknown) => {
    // Sırayla yazılır; son çağrı kazanır. Yazılamazsa uygulama çalışmaya devam eder.
    writing = writing.then(() => storage.set(value)).catch(() => undefined);
    return writing;
  };

  return {
    generation: () => generation,
    async load(): Promise<void> {
      const startedAt = generation;
      let raw: unknown = null;
      try {
        raw = await storage.get();
      } catch {
        raw = null;
      }
      if (startedAt !== generation) return;
      const b = raw as Partial<CacheBlob> | null;
      if (b && typeof b.scope === 'string' && b.entries && typeof b.entries === 'object') {
        blob = { scope: b.scope, me: b.me ?? null, entries: b.entries };
      }
    },
    /** Son bilinen kişi: açılışta ağ yoksa bununla başlanır. */
    lastMe(): MeResponse | null {
      return blob.me;
    },
    /** Sunucudan güncel kişi geldi. Kapsam değiştiyse kayıtlı veri silinir. @returns silindi mi */
    bind(scope: string, me: MeResponse): boolean {
      const changed = blob.scope !== '' && blob.scope !== scope;
      if (changed) generation++;
      // Sahipsiz kayıt da taşınmaz: yalnız aynı kapsamın verisi kalır.
      blob = { scope, me, entries: blob.scope === scope ? blob.entries : {} };
      void persist(blob);
      return changed;
    },
    read<T>(key: string): CacheEntry<T> | null {
      return (blob.entries[key] as CacheEntry<T> | undefined) ?? null;
    },
    /** `since`: isteğin başladığı `generation`. Bu arada sahip değiştiyse veri yazılmaz. */
    write(key: string, data: unknown, since?: number): number {
      const at = now();
      if (since !== undefined && since !== generation) return at;
      const entries: Record<string, CacheEntry> = { ...blob.entries, [key]: { at, data } };
      const keys = Object.keys(entries);
      if (keys.length > max) {
        keys
          .sort((a, b) => entries[a]!.at - entries[b]!.at)
          .slice(0, keys.length - max)
          .forEach((k) => delete entries[k]);
      }
      blob = { ...blob, entries };
      void persist(blob);
      return at;
    },
    drop(key: string): void {
      if (!(key in blob.entries)) return;
      const entries = { ...blob.entries };
      delete entries[key];
      blob = { ...blob, entries };
      void persist(blob);
    },
    async clear(): Promise<void> {
      generation++;
      blob = { scope: '', me: null, entries: {} };
      await persist(null);
    },
    /** Bekleyen yazımlar bitti mi (testler için). */
    settled: () => writing,
  };
}

export type HubCache = ReturnType<typeof createHubCache>;
