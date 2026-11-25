// @vitest-environment happy-dom
// Firma saat dilimi (rapor Y132). Tarayıcı saati bilerek Tokyo: firma saati atanınca sonuç tarayıcıya bakmamalı,
// atanmamışken bugünkü gibi tarayıcıya bakmalı.
process.env.TZ = 'Asia/Tokyo';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { MeResponse } from '@sellerondata/contracts';
import { formatDate, formatDateRange, formatDateTime, formatHubValue, formatRelative } from '../src/format.ts';
import { setShellTimeZone, shellTimeZone } from '../src/timeZone.ts';
import type { SessionClient } from '../src/session/client.ts';
import { SessionProvider, useMe, useSessionActions } from '../src/session/provider.tsx';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const afterEach: (fn: () => void) => void;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Kabuk testlerinde i18next taslaktır; `setShellLocale` dil değiştirmeyi çağırır.
Object.assign(i18next as object, { language: 'tr', changeLanguage: async () => undefined });

afterEach(() => setShellTimeZone(undefined));

describe('setShellTimeZone', () => {
  it('geçerli ad atanır, geçersiz ya da boş değer temizler', () => {
    expect(shellTimeZone()).toBeUndefined();
    setShellTimeZone('Europe/Berlin');
    expect(shellTimeZone()).toBe('Europe/Berlin');
    setShellTimeZone('Mars/Olympus');
    expect(shellTimeZone()).toBeUndefined();
    setShellTimeZone('America/New_York');
    setShellTimeZone('');
    expect(shellTimeZone()).toBeUndefined();
    setShellTimeZone('UTC');
    setShellTimeZone(null);
    expect(shellTimeZone()).toBeUndefined();
  });
});

describe('kabuk biçimlemesi firma saatinde', () => {
  const AT = '2026-10-27T14:32:10+03:00'; // 11:32Z

  it('atanmamışsa tarayıcı saati (bugünkü davranış)', () => {
    expect(formatDateTime(AT, 'tr')).toBe('27 Eki 2026 20:32'); // Tokyo +09:00
    expect(formatDate(AT, 'en', { hour: '2-digit', minute: '2-digit' })).toBe('20:32');
  });

  it('atanınca firma saati', () => {
    setShellTimeZone('Europe/Istanbul');
    expect(formatDateTime(AT, 'tr')).toBe('27 Eki 2026 14:32');
    expect(formatDateTime(AT, 'en')).toBe('27 Oct 2026, 14:32');
    expect(formatDate(AT, 'tr', { hour: '2-digit', minute: '2-digit' })).toBe('14:32');
    expect(formatHubValue({ value: AT, format: 'datetime' } as never, 'tr')).toBe('27 Eki 2026 14:32');
  });

  it('gün kayması: gece yarısına yakın an firmanın gününe düşer', () => {
    const late = '2026-10-27T22:30:00Z';
    expect(formatDate(late, 'tr')).toBe('28 Eki 2026'); // Tokyo 07:30, 28 Ekim
    setShellTimeZone('Europe/Istanbul');
    expect(formatDate(late, 'tr')).toBe('28 Eki 2026'); // 01:30 TSİ
    expect(formatDate(late, 'en', { day: 'numeric', month: 'short' })).toBe('28 Oct');
    setShellTimeZone('America/Los_Angeles');
    expect(formatDate(late, 'tr')).toBe('27 Eki 2026'); // 15:30 PDT
    expect(formatDate(late, 'tr', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })).toBe('27 Ekim 2026 Salı');
    expect(formatRelative(late, 'tr', Date.parse('2027-01-01T00:00:00Z'))).toBe('27 Eki 2026');
  });

  it('yalnız gün olan değer hiçbir saat diliminde kaymaz', () => {
    for (const tz of [undefined, 'Europe/Istanbul', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      setShellTimeZone(tz);
      expect(formatDate('2026-10-27', 'tr')).toBe('27 Eki 2026');
      expect(formatDate('2026-10-27', 'tr', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })).toBe('27 Ekim 2026 Salı');
      expect(formatHubValue({ value: '2026-10-27', format: 'date' } as never, 'en')).toBe('27 Oct 2026');
      expect(formatDateRange('2026-10-01', '2026-10-27', 'tr')).toBe(formatDateRange('2026-10-01T00:00:00Z', '2026-10-27T23:00:00Z', 'tr'));
      expect(formatDateRange('2026-10-27', '2026-10-27', 'en')).toBe('27 Oct 2026');
    }
  });

  it('yaz saatine geçiş: 2026-03-29 Berlin', () => {
    setShellTimeZone('Europe/Berlin');
    expect(formatDateTime('2026-03-29T00:30:00Z', 'en')).toBe('29 Mar 2026, 01:30'); // +01:00
    expect(formatDateTime('2026-03-29T01:30:00Z', 'en')).toBe('29 Mar 2026, 03:30'); // +02:00
    expect(formatDate('2026-03-28T22:59:00Z', 'tr')).toBe('28 Mar 2026');
    expect(formatDate('2026-03-28T23:00:00Z', 'tr')).toBe('29 Mar 2026');
    expect(formatDate('2026-03-29T22:00:00Z', 'tr')).toBe('30 Mar 2026');
  });

  it('kış saatine dönüş: 2026-11-01 New York', () => {
    setShellTimeZone('America/New_York');
    expect(formatDateTime('2026-11-01T05:30:00Z', 'tr')).toBe('1 Kas 2026 01:30'); // −04:00
    expect(formatDateTime('2026-11-01T06:30:00Z', 'tr')).toBe('1 Kas 2026 01:30'); // −05:00, aynı duvar saati
    expect(formatDate('2026-11-01T03:59:00Z', 'en')).toBe('31 Oct 2026');
    expect(formatDate('2026-11-02T04:59:00Z', 'en')).toBe('1 Nov 2026');
    expect(formatDate('2026-11-02T05:00:00Z', 'en')).toBe('2 Nov 2026');
  });
});

describe('oturum saat dilimini atar ve temizler', () => {
  const me = (timeZone?: string) =>
    ({
      person: { id: 'p1', name: 'A', locale: 'tr' },
      activeOrg: { id: 'o1', name: 'Firma', ...(timeZone ? { timeZone } : {}) },
      orgs: [],
      products: [],
    }) as unknown as MeResponse;

  function mount(fetched: MeResponse | 'pending') {
    const client = {
      get: vi.fn(() => (fetched === 'pending' ? new Promise(() => undefined) : Promise.resolve(fetched))),
      post: vi.fn(async () => undefined),
      adoptCachedOrg: vi.fn(),
      noteActiveOrg: vi.fn(() => true),
      onOrgAdopted: () => () => undefined,
      forgetOrg: vi.fn(),
      announceLogout: vi.fn(),
    } as unknown as SessionClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let logout!: () => Promise<unknown>;
    let fetchedShown = false;
    function Probe() {
      const q = useMe();
      fetchedShown = q.isSuccess && !q.isPlaceholderData;
      logout = useSessionActions().logout;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <SessionProvider client={client}>
            <Probe />
          </SessionProvider>
        </QueryClientProvider>,
      ),
    );
    return { root, client, logout: () => logout(), fetchedShown: () => fetchedShown };
  }

  const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
  /**
   * Sunucu yanıtı React'e ulaşana kadar bekler. react-query bileşene `setTimeout(0)` ile haber verir; yavaş makinede (CI) bu
   * 20 ms'yi aşabilir. Haber çıkıştan sonra gelirse bileşen silinmiş önbellekte yeni sorgu kurar, taslak `/me` yine
   * New York döner ve saat dilimi geri yazılır. Beklemeden sonra bekleyen haber kalmaz: çıkış tek başına denetlenir.
   */
  async function settleFetched(m: ReturnType<typeof mount>) {
    for (let i = 0; i < 100 && !m.fetchedShown(); i++) await settle();
    expect(m.fetchedShown()).toBe(true);
  }

  it('önbellekteki /me, sunucu yanıtı gelmeden atar', async () => {
    sessionStorage.setItem('sod_me_cache', JSON.stringify(me('Europe/London')));
    const m = mount('pending');
    await settle();
    expect(shellTimeZone()).toBe('Europe/London');
    act(() => m.root.unmount());
  });

  it('gelen /me önbelleği ezer, çıkış temizler', async () => {
    sessionStorage.setItem('sod_me_cache', JSON.stringify(me('Europe/London')));
    const m = mount(me('America/New_York'));
    await settleFetched(m);
    expect(shellTimeZone()).toBe('America/New_York');
    await act(async () => {
      await m.logout();
    });
    expect(shellTimeZone()).toBeUndefined();
    expect(m.client.get).toHaveBeenCalledTimes(1);
    act(() => m.root.unmount());
  });

  it('/me saat dilimi taşımıyorsa tarayıcı saatine dönülür', async () => {
    sessionStorage.removeItem('sod_me_cache');
    setShellTimeZone('Asia/Tokyo');
    const m = mount(me());
    await settleFetched(m);
    expect(shellTimeZone()).toBeUndefined();
    act(() => m.root.unmount());
  });
});
