// Rol kapanınca açık sekme: önbellek taze sayıldığı için istek gitmez, ürün API'si de olay gelene dek eski jetonu kabul eder.
// Kesin bilgi Hesap'ın /me yanıtında: gezinmede ve sekmeye dönüşte sorulur, yetki azalınca ekranda olmayan veri atılır.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { ACCESS_RECHECK_GAP_MS, dropInactiveData, permissionLost, recheckAccess } from '../src/lib/accessCache.ts';

const ME_KEY = ['sod', 'me'];
const isSession = (key: readonly unknown[]) => key[0] === 'sod' || (key[0] === 'deciship' && key[1] === 'me');

/** Kabuktaki gibi: /me sürekli dinlenir, 60 saniye taze sayılır. */
async function sessionWatched(me: unknown = { products: [] }) {
  let calls = 0;
  let release: () => void = () => undefined;
  let hold = false;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(qc, {
    queryKey: ME_KEY,
    staleTime: 60_000,
    queryFn: async () => {
      calls += 1;
      if (hold) await new Promise<void>((r) => (release = r));
      return me;
    },
  });
  const stop = observer.subscribe(() => undefined);
  await qc.fetchQuery({ queryKey: ME_KEY, staleTime: 60_000, queryFn: async () => me });
  calls = 0;
  return {
    qc,
    stop,
    calls: () => calls,
    holdNext: () => {
      hold = true;
    },
    release: () => release(),
    updatedAt: () => qc.getQueryState(ME_KEY)!.dataUpdatedAt,
  };
}

const idle = (qc: QueryClient) => new Promise<void>((resolve) => {
  const check = () => (qc.isFetching() === 0 ? resolve() : setTimeout(check, 1));
  check();
});

describe('erişim yeniden denetimi', () => {
  it('/me hâlâ taze sayılırken de aralık dolunca sorulur: kapanan rol 60 saniye beklemez', async () => {
    const s = await sessionWatched();
    assert.equal(recheckAccess(s.qc, ME_KEY, s.updatedAt() + ACCESS_RECHECK_GAP_MS), true);
    await idle(s.qc);
    assert.equal(s.calls(), 1);
    s.stop();
  });

  it('aralık içinde sunucuya gidilmez', async () => {
    const s = await sessionWatched();
    assert.equal(recheckAccess(s.qc, ME_KEY, s.updatedAt() + ACCESS_RECHECK_GAP_MS - 1), false);
    await idle(s.qc);
    assert.equal(s.calls(), 0);
    s.stop();
  });

  it('süren istek kesilmez, ikinci istek açılmaz', async () => {
    const s = await sessionWatched();
    s.holdNext();
    const later = s.updatedAt() + ACCESS_RECHECK_GAP_MS;
    assert.equal(recheckAccess(s.qc, ME_KEY, later), true);
    assert.equal(recheckAccess(s.qc, ME_KEY, later), false);
    s.release();
    await idle(s.qc);
    assert.equal(s.calls(), 1);
    s.stop();
  });

  it('oturum yoksa ya da /me henüz gelmediyse sorulmaz', async () => {
    const empty = new QueryClient();
    assert.equal(recheckAccess(empty, ME_KEY), false);
    const anon = await sessionWatched(null);
    assert.equal(recheckAccess(anon.qc, ME_KEY, anon.updatedAt() + ACCESS_RECHECK_GAP_MS), false);
    anon.stop();
  });
});

describe('yetki azalınca önbellek', () => {
  it('yalnız kaybedilen izin sayılır', () => {
    assert.equal(permissionLost(['a', 'b'], ['a']), true);
    assert.equal(permissionLost(['a', 'b'], []), true);
    assert.equal(permissionLost(['a'], ['a', 'b']), false);
    assert.equal(permissionLost([], ['a']), false);
    assert.equal(permissionLost(['a', 'b'], ['b', 'a']), false);
  });

  it('ekranda olmayan veri atılır: dönüşte eski rakam çizilemez; oturum sorguları kalır', () => {
    const qc = new QueryClient();
    qc.setQueryData(['dashboard', '2026-11'], { overcharge: 141.3 });
    qc.setQueryData(['invoices'], { items: [] });
    qc.setQueryData(['sod', 'me'], { products: [] });
    qc.setQueryData(['deciship', 'me', 'o1'], { company: {} });
    dropInactiveData(qc, isSession);
    assert.equal(qc.getQueryData(['dashboard', '2026-11']), undefined);
    assert.equal(qc.getQueryData(['invoices']), undefined);
    assert.ok(qc.getQueryData(['sod', 'me']));
    assert.ok(qc.getQueryData(['deciship', 'me', 'o1']));
  });

  it('açık sayfanın verisine dokunulmaz: yarım form ezilmez', () => {
    const qc = new QueryClient();
    qc.setQueryData(['tariff', 't1'], { id: 't1' });
    const stop = new QueryObserver(qc, { queryKey: ['tariff', 't1'], enabled: false }).subscribe(() => undefined);
    dropInactiveData(qc, isSession);
    assert.ok(qc.getQueryData(['tariff', 't1']));
    stop();
    dropInactiveData(qc, isSession);
    assert.equal(qc.getQueryData(['tariff', 't1']), undefined);
  });
});
