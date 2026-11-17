/**
 * "Çevrimiçi" = sunucuya ulaşılıyor (KALANLAR 4.9). Saf mantık: `QueueContext` yoklamayı (`pingServer`, DeciShip sağlık ucu)
 * ve bağlantı olaylarını (NetInfo) verir, rozet ve kuyruk bunu okur.
 *
 * Sorun: NetInfo internete bakar. İnternetsiz depo Wi-Fi'ında sunucu (bilgisayar, `adb reverse`, yerel ağ) ayaktayken
 * "çevrimdışı", internet varken sunucu kapalıyken "çevrimiçi" görünüyordu.
 * Kural (pil ve veri dostu):
 * - NetInfo yalnız "hiç bağlantı yok" (uçak modu) için kesin bilgidir: o zaman yoklamadan çevrimdışı.
 * - Bağlantı (tür ya da bağlı/bağsız) değişince önbellek beklenmeden bir kez yoklanır; aynı bağlantının tekrar olayı yoklatmaz.
 * - Sonuç `REACH_FRESH_MS` boyunca önbellektedir; aynı anda gelen denetimler tek yoklamayı paylaşır.
 * - Başarılı gönderim sunucunun ayakta olduğunu gösterir (yoklama gerekmez); gönderimde ağ hatası önbelleği düşürür.
 * - Uygulama öndeyken seyrek yoklama (`pollDelay`): ulaşılamıyorken `REACH_POLL_DOWN_MS`, ayaktayken `REACH_POLL_UP_MS`.
 */

/** Yoklama sonucunun geçerli kaldığı süre. */
export const REACH_FRESH_MS = 30_000;
/** Uygulama öndeyken, sunucuya ulaşılamıyorsa yoklama aralığı (geri gelince kuyruk hemen gönderilir). */
export const REACH_POLL_DOWN_MS = 30_000;
/** Uygulama öndeyken, sunucu ayaktaysa yoklama aralığı (sunucu düşerse rozet en geç bu kadar sonra döner). */
export const REACH_POLL_UP_MS = 3 * 60_000;
/** Sağlık ucunun zaman aşımı. */
export const REACH_TIMEOUT_MS = 5_000;

/** NetInfo'dan yalnız gereken: bağlı mı (bilinmiyorsa null) ve tür (wifi, cellular…). İnternet bilgisi bilerek yok. */
export type NetSnapshot = { connected: boolean | null; kind: string };

export type ReachDeps = {
  /** Sunucu cevap verdi mi. Hata atarsa ulaşılamıyor sayılır. */
  probe: () => Promise<boolean>;
  now?: () => number;
};

export function createReach(deps: ReachDeps) {
  const now = deps.now ?? Date.now;
  // İyimser başlangıç: açılışta "çevrimdışı" yanıp sönmesin; ilk denetim önbellek olmadığı için hemen yoklar.
  let reachable = true;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let linkUp = true;
  let linkKey = '';
  /** Bağlantı her değiştiğinde artar: eski bağlantıda başlamış yoklamanın sonucu yazılmaz. */
  let gen = 0;
  let inflight: { gen: number; p: Promise<boolean> } | null = null;
  const subs = new Set<(r: boolean) => void>();

  const set = (r: boolean) => {
    checkedAt = now();
    if (r === reachable) return;
    reachable = r;
    subs.forEach((fn) => fn(r));
  };

  const probe = (): Promise<boolean> => {
    if (inflight && inflight.gen === gen) return inflight.p;
    const g = gen;
    const p: Promise<boolean> = deps
      .probe()
      .catch(() => false)
      .then((ok) => {
        if (inflight?.p === p) inflight = null;
        if (g !== gen) return inflight ? inflight.p : linkUp && reachable;
        set(ok);
        return ok;
      });
    inflight = { gen: g, p };
    return p;
  };

  return {
    /** Son bilinen durum (rozet). */
    get reachable(): boolean {
      return linkUp && reachable;
    },
    /** Önbellek `maxAgeMs`'den tazeyse onu, değilse yoklamanın sonucunu verir. Bağlantı yoksa yoklamadan `false`. */
    check(maxAgeMs: number = REACH_FRESH_MS): Promise<boolean> {
      if (!linkUp) return Promise.resolve(false);
      if (now() - checkedAt < maxAgeMs) return Promise.resolve(reachable);
      return probe();
    },
    /** NetInfo olayı. */
    network(s: NetSnapshot): void {
      const up = s.connected !== false;
      const key = `${up}|${s.kind}`;
      if (key === linkKey) return;
      linkKey = key;
      gen++;
      linkUp = up;
      if (!up) {
        set(false);
        return;
      }
      checkedAt = Number.NEGATIVE_INFINITY;
      void probe();
    },
    /** Sunucu bir isteği karşıladı. */
    noteSuccess(): void {
      if (linkUp) set(true);
    },
    /** Bir istek ağ hatası aldı: tek hata çevrimdışı demek değildir, önbellek düşer ve hemen yoklanır. */
    noteFailure(): void {
      if (!linkUp) return;
      checkedAt = Number.NEGATIVE_INFINITY;
      void probe();
    },
    /** Öndeyken sonraki yoklamaya kadar beklenecek süre. */
    pollDelay(): number {
      return linkUp && reachable ? REACH_POLL_UP_MS : REACH_POLL_DOWN_MS;
    },
    /** Durum değişince çağrılır. Dönen işlev aboneliği bitirir. */
    subscribe(fn: (r: boolean) => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export type Reach = ReturnType<typeof createReach>;
