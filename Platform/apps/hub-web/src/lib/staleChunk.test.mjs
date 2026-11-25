// Merkez sayfaları ayrı parça yüklenir (App.tsx `lazyPage`). Yayından sonra açık kalan eski sekmede sayfanın parçası artık
// sunucuda yoktur: "Bir şeyler ters gitti" yerine sayfa bir kez kendiliğinden yenilenir (DeciShip paneliyle aynı kural,
// `Deciship/apps/web/src/components/UpdateBanner.tsx`). Döngüye girmez: bir dakika içinde ikinci kez yenilemez.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { installStaleChunkReload, reloadOnceForStaleChunk, STALE_CHUNK_KEY } from './staleChunk.ts';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), map: m };
}

describe('eski parça: bir kez yenile', () => {
  test('ilk hatada yeniler ve anı yazar; bir dakika içinde ikinci kez yenilemez, sonra yine yeniler', () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reload = () => reloads++;
    assert.equal(reloadOnceForStaleChunk({ storage, reload, now: 1_000_000 }), true);
    assert.equal(reloads, 1);
    assert.equal(storage.map.get(STALE_CHUNK_KEY), '1000000');
    assert.equal(reloadOnceForStaleChunk({ storage, reload, now: 1_000_000 + 59_000 }), false);
    assert.equal(reloads, 1);
    assert.equal(reloadOnceForStaleChunk({ storage, reload, now: 1_000_000 + 61_000 }), true);
    assert.equal(reloads, 2);
  });

  test('oturum deposu yoksa ya da hata atarsa yenilemez (döngü koruması yazılamaz)', () => {
    let reloads = 0;
    assert.equal(reloadOnceForStaleChunk({ storage: null, reload: () => reloads++, now: 1 }), false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.equal(reloadOnceForStaleChunk({ storage: broken, reload: () => reloads++, now: 1 }), false);
    assert.equal(reloads, 0);
  });

  test('vite:preloadError dinlenir: yenilenirse olay bastırılır, yenilenmezse hata sayfaya düşer', () => {
    const listeners = new Map();
    const storage = memoryStorage();
    let reloads = 0;
    const win = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      sessionStorage: storage,
      location: { reload: () => reloads++ },
    };
    installStaleChunkReload(win, () => 5_000_000);
    const fire = () => {
      const ev = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      listeners.get('vite:preloadError')(ev);
      return ev.prevented;
    };
    assert.equal(fire(), true);
    assert.equal(reloads, 1);
    assert.equal(fire(), false);
    assert.equal(reloads, 1);
  });
});
