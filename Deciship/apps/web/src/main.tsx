import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
// Sıra (MESAJ-12 §3.2): ortak belirteçler → DeciShip fark belirteçleri → kabuk (ray, başlık) → ortak bileşenler → DeciShip kuralları ve farkları → sayfalar.
import '@sellerondata/shell/tokens.css';
import './styles/tokens.deciship.css';
import '@sellerondata/shell/shell.css';
import '@sellerondata/shell/primitives.css';
import './styles/app.css';
// Page-specific styles (one file per page area; each page agent edits only its own file).
import './styles/pages/dashboard.css';
import './styles/pages/measurements.css';
import './styles/pages/invoices.css';
import './styles/pages/disputes.css';
import './styles/pages/tariffs.css';
import './styles/pages/settings.css';
import './styles/pages/system.css';
import './styles/pages/onboarding.css';
import './styles/pages/platform.css';
import './styles/pages/bulk.css';
import './styles/pages/upload.css';
import './styles/pages/demo.css';
// Yüksek karşıtlık kuralları en sonda: uygulama ve sayfa kenarlıklarının üstüne yazabilsin (Mesaj 15 P).
import '@sellerondata/shell/a11y.css';
import './i18n';
import { App } from './App';
import { NumberPasteGuard } from './components/NumberPasteGuard';

function mount() {
  // Eşzamanlı çizim: görünüm geçişinin yeni karesinde kabuk hazır olsun (ARCHITECTURE §8).
  flushSync(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
        <NumberPasteGuard />
      </StrictMode>,
    );
  });
}

// Üst düzey await: modül bitene kadar çizim bekler (index.html blocking="render"), mock modunda da ilk kare kabukla gelir.
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  const { startMocks } = await import('./mocks/browser');
  await startMocks();
}
mount();
