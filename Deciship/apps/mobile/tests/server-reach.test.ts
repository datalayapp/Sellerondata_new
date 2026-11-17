import { describe, expect, it } from 'vitest';
import { createReach, REACH_FRESH_MS, REACH_POLL_DOWN_MS, REACH_POLL_UP_MS } from '../src/queue/reach';

/** Elle sürülen saat ve yoklama: her yoklama bir söz; test sonucu `answer` ile verir. */
function harness() {
  let t = 1_000_000;
  const calls: ((ok: boolean | Error) => void)[] = [];
  const reach = createReach({
    now: () => t,
    probe: () =>
      new Promise<boolean>((resolve, reject) => {
        calls.push((ok) => (ok instanceof Error ? reject(ok) : resolve(ok)));
      }),
  });
  const changes: boolean[] = [];
  reach.subscribe((r) => changes.push(r));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    reach,
    changes,
    get probes() {
      return calls.length;
    },
    answer: async (ok: boolean | Error, i = calls.length - 1) => {
      calls[i]!(ok);
      await flush();
    },
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('sunucuya ulaşılıyor mu (KALANLAR 4.9): internete değil sunucunun sağlık ucuna bakar', () => {
  it('ilk denetim yoklar; sonuç önbellekte durur, taze iken yeniden yoklanmaz', async () => {
    const h = harness();
    const p = h.reach.check();
    expect(h.probes).toBe(1);
    await h.answer(true);
    expect(await p).toBe(true);
    h.tick(REACH_FRESH_MS - 1);
    expect(await h.reach.check()).toBe(true);
    expect(h.probes).toBe(1);
    h.tick(1);
    void h.reach.check();
    expect(h.probes).toBe(2);
  });

  it('aynı anda gelen denetimler tek yoklamayı paylaşır', async () => {
    const h = harness();
    const a = h.reach.check();
    const b = h.reach.check(0);
    expect(h.probes).toBe(1);
    await h.answer(false);
    expect([await a, await b]).toEqual([false, false]);
    expect(h.reach.reachable).toBe(false);
    expect(h.changes).toEqual([false]);
  });

  it('yoklama hatası ulaşılamıyor sayılır; durum değişince haber verilir, aynı kalınca verilmez', async () => {
    const h = harness();
    void h.reach.check();
    await h.answer(new Error('ağ'));
    h.tick(REACH_FRESH_MS);
    void h.reach.check();
    await h.answer(false);
    h.tick(REACH_FRESH_MS);
    void h.reach.check();
    await h.answer(true);
    expect(h.changes).toEqual([false, true]);
  });

  it('bağlantı yoksa (uçak modu) yoklamadan çevrimdışı; denetim de yoklamaz', async () => {
    const h = harness();
    h.reach.network({ connected: false, kind: 'none' });
    expect(h.reach.reachable).toBe(false);
    expect(await h.reach.check(0)).toBe(false);
    expect(h.probes).toBe(0);
  });

  it('bağlantı değişince önbellek beklenmeden yoklanır; aynı bağlantının tekrar olayı yoklatmaz', async () => {
    const h = harness();
    void h.reach.check();
    await h.answer(true);
    h.reach.network({ connected: true, kind: 'wifi' });
    expect(h.probes).toBe(2);
    await h.answer(true);
    h.reach.network({ connected: true, kind: 'wifi' });
    expect(h.probes).toBe(2);
    h.reach.network({ connected: true, kind: 'cellular' });
    expect(h.probes).toBe(3);
  });

  it('internet yok ama sunucu yerel ağda: sağlık ucu cevap verdiyse çevrimiçi', async () => {
    const h = harness();
    // NetInfo'nun "internete ulaşılamıyor" bilgisi bağlantı türünü değiştirmez: yalnız sunucunun cevabı sayılır.
    h.reach.network({ connected: true, kind: 'wifi' });
    await h.answer(true);
    expect(h.reach.reachable).toBe(true);
  });

  it('bağlantı arada değiştiyse eski yoklamanın sonucu yazılmaz', async () => {
    const h = harness();
    const first = h.reach.check();
    h.reach.network({ connected: true, kind: 'cellular' });
    expect(h.probes).toBe(2);
    await h.answer(true, 1);
    await h.answer(false, 0);
    expect(h.reach.reachable).toBe(true);
    expect(await first).toBe(true);
  });

  it('başarılı gönderim sunucunun ayakta olduğunu gösterir: yoklama gerekmez', async () => {
    const h = harness();
    void h.reach.check();
    await h.answer(false);
    h.reach.noteSuccess();
    expect(h.reach.reachable).toBe(true);
    expect(await h.reach.check()).toBe(true);
    expect(h.probes).toBe(1);
    expect(h.changes).toEqual([false, true]);
  });

  it('gönderimde ağ hatası: önbellek düşer, hemen yoklanır (tek ağ hatası çevrimdışı demek değildir)', async () => {
    const h = harness();
    void h.reach.check();
    await h.answer(true);
    h.reach.noteFailure();
    expect(h.probes).toBe(2);
    expect(h.reach.reachable).toBe(true);
    await h.answer(false);
    expect(h.reach.reachable).toBe(false);
  });

  it('arka plan yoklama aralığı: ulaşılamıyorken sık, ayaktayken seyrek', async () => {
    const h = harness();
    expect(h.reach.pollDelay()).toBe(REACH_POLL_UP_MS);
    void h.reach.check();
    await h.answer(false);
    expect(h.reach.pollDelay()).toBe(REACH_POLL_DOWN_MS);
    expect(REACH_POLL_DOWN_MS).toBeGreaterThanOrEqual(REACH_FRESH_MS);
    expect(REACH_POLL_UP_MS).toBeGreaterThan(REACH_POLL_DOWN_MS);
  });
});
