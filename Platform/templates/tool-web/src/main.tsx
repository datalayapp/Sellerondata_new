import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
// Yalnız kabuğun kendi stilleri (nötr). Aracın tasarım dili seçilmedi: yazı tipi, araç belirteçleri (`tokens.<anahtar>.css`)
// ve sayfa stilleri seçimden sonra bu listeye, kabuk stillerinin arasına eklenir (sıra: Deciship/apps/web/src/main.tsx).
import '@sellerondata/shell/tokens.css';
import '@sellerondata/shell/shell.css';
import '@sellerondata/shell/primitives.css';
// Yüksek karşıtlık kuralları en sonda: araç ve sayfa kenarlıklarının üstüne yazabilsin.
import '@sellerondata/shell/a11y.css';
import './i18n';
import { App } from './App';

function mount() {
  // Eşzamanlı çizim: görünüm geçişinin yeni karesinde kabuk hazır olsun (ARCHITECTURE §8).
  flushSync(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
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
