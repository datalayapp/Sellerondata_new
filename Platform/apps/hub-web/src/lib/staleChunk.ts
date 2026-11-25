// Merkez sayfaları ayrı parça yüklenir (App.tsx `lazyPage`). Yayından sonra açık kalan eski sekmede sayfanın parçası (eski adlı
// dosya) artık sunucuda yoktur ve içe aktarma düşer. Hata ekranı yerine sayfa bir kez kendiliğinden yenilenir: yeni sürüm gelir.
// DeciShip paneliyle aynı kural (`Deciship/apps/web/src/components/UpdateBanner.tsx` `reloadOnceForStaleChunk`).
// Döngü koruması: bir dakika içinde ikinci kez yenilenmez (parça gerçekten yoksa hata ekranı görünür, "Yenile" düğmesiyle).

export const STALE_CHUNK_KEY = 'hub.chunkReloadAt';
const GUARD_MS = 60_000;

type SessionLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Son yenilemeden bu yana bir dakika geçtiyse anı yazar ve yeniler. Depo yoksa (gizli pencere, engel) yenilemez. */
export function reloadOnceForStaleChunk(opts: { storage: SessionLike | null; reload: () => void; now?: number }): boolean {
  const now = opts.now ?? Date.now();
  try {
    if (!opts.storage) return false;
    const last = Number(opts.storage.getItem(STALE_CHUNK_KEY) ?? 0);
    if (now - last < GUARD_MS) return false;
    opts.storage.setItem(STALE_CHUNK_KEY, String(now));
  } catch {
    return false;
  }
  opts.reload();
  return true;
}

type WindowLike = {
  addEventListener: (type: 'vite:preloadError', fn: (e: { preventDefault: () => void }) => void) => void;
  sessionStorage: SessionLike;
  location: { reload: () => void };
};

/** Vite parça yükleyemeyince `vite:preloadError` atar; yenileme başladıysa olay bastırılır. */
export function installStaleChunkReload(win: WindowLike, clock: () => number = Date.now): void {
  win.addEventListener('vite:preloadError', (e) => {
    let storage: SessionLike | null = null;
    try {
      storage = win.sessionStorage;
    } catch {
      storage = null;
    }
    if (reloadOnceForStaleChunk({ storage, reload: () => win.location.reload(), now: clock() })) e.preventDefault();
  });
}
