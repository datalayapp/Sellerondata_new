// Geçici DeciShip taslağı. Yalnız mock modunda `/deciship/*` buraya düşer (vite.config.ts), üretime girmez.
// İki amacı var: (1) tam sayfa geçişi ve View Transitions'ı doğrulamak, (2) kabuğun react-router olmadan,
// başka bir uygulamada, kendi hazır sidebar'ıyla ikinci sütun olarak oturduğunu göstermek.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import { AppShell, Icon, Skel, SessionProvider, createSessionClient, currentLocale, initShellI18n, useMe, useSessionActions, type IconName } from '@sellerondata/shell';

initShellI18n();
const client = createSessionClient({ getLocale: currentLocale, onSessionLost: () => window.location.assign('/login') });
const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '/deciship/', label: 'Pano', icon: 'home' },
  { href: '/deciship/measurements', label: 'Ölçümler', icon: 'ruler' },
  { href: '/deciship/invoices', label: 'Faturalar', icon: 'doc' },
  { href: '/deciship/tariffs', label: 'Tarifeler', icon: 'table' },
  { href: '/deciship/settings', label: 'Ayarlar', icon: 'gear' },
];

/** DeciShip'in kendi sidebar'ını temsil eden düğüm: kabuk `productNav` olarak düğüm de kabul eder. */
function ForeignSidebar({ path }: { path: string }) {
  return (
    <nav className="sod-side-nav" aria-label="DeciShip menüsü" data-testid="foreign-sidebar">
      <div className="sod-side-group">
        {NAV.map((n) => {
          const active = n.href === '/deciship/' ? path === '/deciship/' || path === '/deciship' : path.startsWith(n.href);
          return (
            <a key={n.href} href={n.href} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function Stub() {
  const { me } = useMe();
  const { logout, switchOrg, changeLocale } = useSessionActions();
  const [path] = useState(() => window.location.pathname);
  const page = NAV.find((n) => (n.href === '/deciship/' ? path === '/deciship/' || path === '/deciship' : path.startsWith(n.href)))?.label ?? 'Pano';
  return (
    <AppShell
      currentProduct="deciship"
      productNav={<ForeignSidebar path={path} />}
      pageTitle={page}
      currentPath={path}
      me={me}
      onLogout={async () => {
        await logout();
        window.location.assign('/login');
      }}
      onSwitchOrg={(id) => switchOrg(id)}
      onChangeLocale={(l) => changeLocale(l)}
    >
      <div style={{ padding: '32px', maxWidth: 720 }} data-testid="deciship-stub">
        <h1 style={{ fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>{page}</h1>
        <p style={{ marginTop: 8, color: 'var(--text-2)' }}>Geçici DeciShip taslağı. Gerçek DeciShip web bu kabuğa sonraki aşamada takılır.</p>
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skel h={48} />
          <Skel h={200} />
        </div>
      </div>
    </AppShell>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function mount() {
  flushSync(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <SessionProvider client={client}>
            <Stub />
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}

// Geliştirmede sahte API önce açılır; üretim benzeri e2e derlemesinde (SOD_E2E_STUB) doğrudan çizilir.
if (import.meta.env.DEV) void import('../../src/mocks/browser.ts').then((m) => m.startMocks()).then(mount);
else mount();
