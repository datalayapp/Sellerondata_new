// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, type SessionClient } from '../src/session/client.ts';
import { SessionProvider, useSessionActions, type LogoutResult } from '../src/session/provider.tsx';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Çıkış isteği `fail` ile dönerse o hatayı fırlatır; yoksa 204 gibi başarılı döner. */
async function runLogout(fail?: unknown) {
  const forgetOrg = vi.fn();
  const post = vi.fn(async () => {
    if (fail !== undefined) throw fail;
    return undefined;
  });
  const announceLogout = vi.fn();
  const client = { post, forgetOrg, announceLogout } as unknown as SessionClient;
  const qc = new QueryClient();
  qc.setQueryData(['x'], 1);
  sessionStorage.setItem('sod_me_cache', '{}');
  let logout!: () => Promise<LogoutResult>;
  function Probe() {
    logout = useSessionActions().logout;
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <SessionProvider client={client}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  );
  let result!: LogoutResult;
  await act(async () => {
    result = await logout();
  });
  act(() => root.unmount());
  return {
    result,
    cleared: forgetOrg.mock.calls.length === 1 && sessionStorage.getItem('sod_me_cache') === null && qc.getQueryData(['x']) === undefined,
    announced: announceLogout.mock.calls.length,
  };
}

const apiErr = (status: number) => new ApiError(status, 'X', 'x');

describe('logout sözleşmesi', () => {
  it('204: sunucu bitirdi, yerel durum silinir, öbür sekmelere bir kez duyurulur', async () => {
    expect(await runLogout()).toEqual({ result: { serverEnded: true }, cleared: true, announced: 1 });
  });
  it('401: sunucu bitirdi sayılır, yerel durum silinir, duyurulur', async () => {
    expect(await runLogout(apiErr(401))).toEqual({ result: { serverEnded: true }, cleared: true, announced: 1 });
  });
  for (const status of [500, 503, 429, 408, 0]) {
    it(`${status}: bitmedi, yerel durum silinmez, duyurulmaz`, async () => {
      expect(await runLogout(apiErr(status))).toEqual({ result: { serverEnded: false }, cleared: false, announced: 0 });
    });
  }
  it('ağ hatası (ApiError değil): bitmedi, fırlatmaz, duyurulmaz', async () => {
    expect(await runLogout(new TypeError('Failed to fetch'))).toEqual({ result: { serverEnded: false }, cleared: false, announced: 0 });
  });
});
