// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MeResponse } from '@sellerondata/contracts';
import { AppShell } from '../src/AppShell.tsx';
import { ErrorBoundary } from '../src/ErrorBoundary.tsx';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const beforeEach: (fn: () => void) => void;
declare const afterEach: (fn: () => void) => void;
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: MeResponse = {
  person: { id: 'p1', name: 'Elif Kaya', email: 'elif@atlas.test', phone: null, locale: 'tr', emailVerified: true },
  orgs: [{ id: 'o1', name: 'Atlas Ev Tekstil', orgRole: 'OWNER', status: 'ACTIVE' }],
  activeOrg: { id: 'o1', name: 'Atlas Ev Tekstil', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1' },
  products: [{ key: 'deciship', available: true, subscription: null, role: 'ADMIN', permissions: ['deciship.web.access'] }],
};

let host: HTMLDivElement;
let root: Root;
const render = (node: ReactNode) => act(() => root.render(node));
const $ = (sel: string) => host.querySelector<HTMLElement>(sel);

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('patladi');
  return <p id="ok">Sağlam içerik</p>;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('çocuk hata atınca uyarı ekranı görünür; teknik ayrıntı yalnız "ad: ileti"', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Bomb explode />
      </ErrorBoundary>,
    );
    const box = $('[role="alert"][data-sod-boundary]')!;
    expect(box.getAttribute('data-sod-boundary')).toBe('section');
    expect(box.querySelector('h2')).not.toBeNull();
    expect(box.querySelector('button.btn-primary')!.textContent).toBe('boundary.reload');
    expect(box.querySelector('a.btn-secondary')!.getAttribute('href')).toBe('/home');
    expect(box.querySelector('details code')!.textContent).toBe('Error: patladi');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('sayfa sınırı h1 ile çizilir', () => {
    render(
      <ErrorBoundary variant="page">
        <Bomb explode />
      </ErrorBoundary>,
    );
    expect($('[data-sod-boundary="page"] h1')).not.toBeNull();
  });

  it('resetKey değişince çocuk yeniden çizilir; değişmezse hata ekranı kalır', () => {
    const tree = (key: string, explode: boolean) => (
      <ErrorBoundary resetKey={key}>
        <Bomb explode={explode} />
      </ErrorBoundary>
    );
    render(tree('/a', true));
    expect($('[data-sod-boundary]')).not.toBeNull();
    render(tree('/a', false));
    expect($('[data-sod-boundary]')).not.toBeNull();
    render(tree('/b', false));
    expect($('[data-sod-boundary]')).toBeNull();
    expect($('#ok')!.textContent).toBe('Sağlam içerik');
  });

  it('AppShell içinde hata bandı ve menüyü silmez', () => {
    render(
      <AppShell
        currentProduct="hub"
        currentPath="/home"
        me={ME}
        productNav={[{ items: [{ href: '/home', label: 'Genel Bakış' }] }]}
        onLogout={() => undefined}
        onSwitchOrg={() => undefined}
        onChangeLocale={() => undefined}
      >
        <Bomb explode />
      </AppShell>,
    );
    expect($('main [data-sod-boundary="section"]')).not.toBeNull();
    expect($('header.sod-band')).not.toBeNull();
    expect($('.sod-nav')).not.toBeNull();
  });
});
