import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import type { Plugin } from 'vite';

/** Her derlemenin kimliği: çalışan sekme eski paketle kaldıysa /deciship/version.json ile fark edilir. */
const BUILD_ID = Date.now().toString(36);
function buildId(): Plugin {
  return {
    name: 'deciship-build-id',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

/**
 * Derleme, paket betiğindeki `blocking="render"` özniteliğini düşürebiliyor. Bu olmadan yeni belgenin ilk karesi kabuksuz çizilir,
 * araçlar arası geçişte ray boş görünür (ARCHITECTURE §8). Çıktıda kesin olsun.
 */
function renderBlockingEntry(): Plugin {
  return {
    name: 'deciship-render-blocking-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module"(?![^>]*\bblocking=)/g, '<script type="module" blocking="render"'),
    },
  };
}

/**
 * Tek köken (ARCHITECTURE §3). Geliştirmede bu sunucu ağ geçidi gibi davranır: `/deciship/*` kendisinde, `/api/account` Hesap'ta,
 * `/api/deciship` DeciShip API'de, geri kalan her şey (`/login`, `/home`, `/account/*`) Merkez'dedir. Böylece Merkez ↔ DeciShip
 * tam sayfa gezintisi aynı kökende çalışır. Mock modunda `/api` çağrılarını servis çalışanı yanıtlar.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const mock = env.VITE_MOCK === '1';
  const apiTarget = env.API_PROXY_TARGET || 'http://localhost:4000';
  const accountTarget = env.ACCOUNT_PROXY_TARGET || 'http://localhost:4100';
  const hubTarget = env.HUB_PROXY_TARGET || 'http://localhost:5180';
  const port = Number(env.DECISHIP_WEB_PORT) || 5173;
  const api = {
    '/api/account': { target: accountTarget, changeOrigin: false },
    '/api/deciship': { target: apiTarget, changeOrigin: false },
  };
  const hub = { '^/(?!deciship(/|$)|api/)': { target: hubTarget, changeOrigin: false } };
  return {
    base: '/deciship/',
    plugins: [react(), buildId(), renderBlockingEntry(), ...(mock ? [msw({ mode: 'worker-only' })] : [])],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    resolve: {
      // Paketler `file:` ile bağlanır; kaynak bağlantı üzerinden çözülür ki React ve i18next tek kopya kalsın.
      preserveSymlinks: true,
      dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', '@tanstack/react-query'],
    },
    optimizeDeps: {
      exclude: ['@sellerondata/shell', '@sellerondata/contracts', '@deciship/core', '@sellerondata/format'],
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'i18next', 'react-i18next', '@tanstack/react-query', 'react-router', ...(mock ? ['msw', 'msw/browser'] : [])],
    },
    server: {
      port,
      strictPort: true,
      proxy: mock ? hub : { ...api, ...hub },
    },
    preview: {
      port: 4173,
      proxy: { ...api, ...hub },
    },
    build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
