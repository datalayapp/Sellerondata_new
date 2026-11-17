// @vitest-environment happy-dom
// Çıkış ya da firma değişimi anında süren `/me` (KALANLAR 6.19): yanıt geçişten sonra gelirse önceki kişinin bilgisi
// tarayıcının oturum belleğine geri yazılmamalı, saat dilimi ve dil yeniden atanmamalı, ekranda görünmemeli.
// Ortak bilgisayarda bir sonraki kişi önceki kişinin adını, firmasını ve saatini görürdü.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { MeResponse } from '@sellerondata/contracts';
import { setShellTimeZone, shellTimeZone } from '../src/timeZone.ts';
import { ApiError, createSessionClient, type SessionClient } from '../src/session/client.ts';
import { SessionProvider, beginOrgChange, beginSession, useMe, useSessionActions } from '../src/session/provider.tsx';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const afterEach: (fn: () => void) => void;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const changeLanguage = vi.fn(async () => undefined);
Object.assign(i18next as object, { language: 'tr', changeLanguage });

const ME_CACHE = 'sod_me_cache';
const personA = {
  person: { id: 'pA', name: 'Ayşe', locale: 'en' },
  activeOrg: { id: 'oA', name: 'Ayşe Ltd', timeZone: 'America/New_York' },
  orgs: [],
  products: [],
} as unknown as MeResponse;

afterEach(() => {
  setShellTimeZone(undefined);
  sessionStorage.clear();
  localStorage.clear();
  changeLanguage.mockClear();
  vi.unstubAllGlobals();
});

type Deferred = { resolve: (v: MeResponse) => void; reject: (e: unknown) => void };

/** `/me` istekleri elle yanıtlanır: ilki geçişten sonra döner, sonrakiler hiç dönmez (giriş sayfasına gidiliyor). */
function mount(client?: SessionClient) {
  const pending: Deferred[] = [];
  const get = vi.fn(() => new Promise<MeResponse>((resolve, reject) => pending.push({ resolve, reject })));
  const fake = {
    get,
    post: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    adoptCachedOrg: vi.fn(),
    noteActiveOrg: vi.fn(() => true),
    onOrgAdopted: () => () => undefined,
    forgetOrg: vi.fn(),
    announceLogout: vi.fn(),
    resetLost: vi.fn(),
  } as unknown as SessionClient;
  const used = client ? Object.assign(client, { get }) : fake;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let actions!: ReturnType<typeof useSessionActions>;
  let shown: MeResponse | null = null;
  function Probe() {
    shown = useMe().me;
    actions = useSessionActions();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <SessionProvider client={used}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  return { root, client: used, get, pending, actions: () => actions, shown: () => shown };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

/** Önceki kişiden hiçbir iz kalmadı mı. */
function expectNoTrace(m: ReturnType<typeof mount>) {
  expect(sessionStorage.getItem(ME_CACHE)).toBeNull();
  expect(shellTimeZone()).toBeUndefined();
  expect(changeLanguage).not.toHaveBeenCalledWith('en');
  expect(m.shown()).toBeNull();
}

describe('geçişten sonra dönen eski /me yan etki bırakmaz', () => {
  it('çıkış: geç gelen yanıt oturum belleğine yazılmaz, saat ve dil atanmaz', async () => {
    const m = mount();
    await settle();
    expect(m.pending).toHaveLength(1);
    await act(async () => {
      await m.actions().logout();
    });
    await act(async () => {
      m.pending[0].resolve(personA);
    });
    await settle();
    expectNoTrace(m);
    act(() => m.root.unmount());
  });

  it('çıkış: geç gelen yanıtın bekleyen dili hesaba yeniden yazdırmaz', async () => {
    const m = mount();
    await settle();
    await act(async () => {
      await m.actions().logout();
    });
    // Sonraki kişi dil seçti, kaydı bekliyor: eski yanıt onun seçimini önceki kişinin hesabına göndermemeli.
    localStorage.setItem('sod_locale_pending', JSON.stringify({ locale: 'tr', at: Date.now() }));
    await act(async () => {
      m.pending[0].resolve(personA);
    });
    await settle();
    expect((m.client.patch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect(localStorage.getItem('sod_locale_pending')).not.toBeNull();
    act(() => m.root.unmount());
  });

  for (const step of ['switchOrg', 'createOrg', 'leaveOrg'] as const) {
    it(`${step}: sayfa yeniden yüklenmeden dönen eski firma yanıtı oturum belleğine yazılmaz`, async () => {
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, assign });
      const m = mount();
      await settle();
      await act(async () => {
        const a = m.actions();
        if (step === 'switchOrg') await a.switchOrg('oB');
        else if (step === 'createOrg') await a.createOrg({ name: 'Yeni' } as never);
        else await a.leaveOrg();
      });
      expect(assign).toHaveBeenCalledTimes(1);
      await act(async () => {
        m.pending[0].resolve(personA);
      });
      await settle();
      expect(sessionStorage.getItem(ME_CACHE)).toBeNull();
      expect(shellTimeZone()).toBeUndefined();
      expect(changeLanguage).not.toHaveBeenCalledWith('en');
      act(() => m.root.unmount());
    });
  }

  it('uygulamanın kendi firma geçişi (firma kapatma, uyarıdan yenile): eski firma yanıtı oturum belleğine yazılmaz', async () => {
    const m = mount();
    await settle();
    // Merkez `useReloadSession` ve kabuk uyarısı: önbellek silinir, sayfa baştan yüklenir.
    beginOrgChange();
    await act(async () => {
      m.pending[0].resolve(personA);
    });
    await settle();
    expect(sessionStorage.getItem(ME_CACHE)).toBeNull();
    expect(shellTimeZone()).toBeUndefined();
    expect(changeLanguage).not.toHaveBeenCalledWith('en');
    act(() => m.root.unmount());
  });

  it('başka sekmede çıkış: geç gelen yanıt bu sekmenin oturum belleğine yazılmaz', async () => {
    const onSessionLost = vi.fn();
    const client = createSessionClient({ fetchImpl: vi.fn(), onSessionLost });
    const m = mount(client);
    await settle();
    const other = new BroadcastChannel('sod-session');
    other.postMessage({ type: 'logout' });
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
    other.close();
    await act(async () => {
      m.pending[0].resolve(personA);
    });
    await settle();
    expect(sessionStorage.getItem(ME_CACHE)).toBeNull();
    expect(shellTimeZone()).toBeUndefined();
    expect(changeLanguage).not.toHaveBeenCalledWith('en');
    act(() => m.root.unmount());
  });

  it('giriş: çıkış yapılmış sekmenin geç gelen 401 yanıtı yeni kişinin belleğini, saatini ve firmasını silmez', async () => {
    // Çıkış yapılmış sekme: önbellek boş, /me sürüyor (çerez yok, 401 dönecek).
    const m = mount();
    await settle();
    expect(m.pending).toHaveLength(1);
    // Yeni kişi giriş yaptı (Merkez `useAfterAuth`), yeni /me geldi ve yazıldı.
    beginSession(m.client);
    const personB = {
      ...personA,
      person: { ...personA.person, id: 'pB', name: 'Barış' },
      activeOrg: { id: 'oB', name: 'Barış AŞ', timeZone: 'Europe/Istanbul' },
    };
    sessionStorage.setItem(ME_CACHE, JSON.stringify(personB));
    setShellTimeZone('Europe/Istanbul');
    const forgetOrg = m.client.forgetOrg as unknown as { mock: { calls: unknown[] } };
    const before = forgetOrg.mock.calls.length;
    await act(async () => {
      m.pending[0].reject(new ApiError(401, 'TOKEN_MISSING', 'x'));
    });
    await settle();
    expect(JSON.parse(sessionStorage.getItem(ME_CACHE) ?? 'null')?.person.id).toBe('pB');
    expect(shellTimeZone()).toBe('Europe/Istanbul');
    expect(forgetOrg.mock.calls).toHaveLength(before);
    act(() => m.root.unmount());
  });

  it('geçiş yoksa yanıt bugünkü gibi yazılır (denetim)', async () => {
    const m = mount();
    await settle();
    await act(async () => {
      m.pending[0].resolve(personA);
    });
    for (let i = 0; i < 100 && !m.shown(); i++) await settle();
    expect(m.shown()?.person.id).toBe('pA');
    expect(JSON.parse(sessionStorage.getItem(ME_CACHE) ?? 'null')?.person.id).toBe('pA');
    expect(shellTimeZone()).toBe('America/New_York');
    act(() => m.root.unmount());
  });
});
