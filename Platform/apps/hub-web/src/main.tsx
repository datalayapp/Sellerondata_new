import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './i18n.ts';
import { ErrorBoundary } from '@sellerondata/shell';
import { App } from './App.tsx';
import { installStaleChunkReload } from './lib/staleChunk.ts';

// Yayından sonra açık kalan eski sekme: eksik sayfa parçasında bir kez yenilenir (hata ekranı yerine yeni sürüm).
installStaleChunkReload(window);

async function enableMocks() {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    // glob: üretim tip denetimi mock dosyalarını izlemesin (tsconfig.build.json). Tam denetim `npm run typecheck`te.
    const load = import.meta.glob<{ startMocks: () => Promise<void> }>('./mocks/browser.ts');
    const { startMocks } = await load['./mocks/browser.ts']!();
    await startMocks();
  }
}

function mount() {
  // Eşzamanlı çizim: görünüm geçişinin yeni karesinde kabuk hazır olsun (§8).
  flushSync(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary variant="page">
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  });
}

if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') void enableMocks().then(mount);
else mount();
