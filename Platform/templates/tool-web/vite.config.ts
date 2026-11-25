import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import type { Plugin } from 'vite';

// Araç şablonu (Platform/templates/tool-web/README.md). Karşılığı: Deciship/apps/web/vite.config.ts.
// Anahtar, adres öneki ve portlar araç kaydıyla aynı olmalı (contracts/src/products.ts `deploy.web.dev`, `deploy.api.dev`).
const TOOL = 'ornekarac';
const DEV_WEB_PORT = 5174;
const DEV_API_PORT = 4200;

/** Her derlemenin kimliği: açık kalan sekme eski paketle kaldıysa /<anahtar>/version.json ile fark edilir. */
const BUILD_ID = Date.now().toString(36);
function buildId(): Plugin {
  return {
    name: `${TOOL}-build-id`,
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

/** Derleme `blocking="render"` özniteliğini düşürebiliyor; olmadan araçlar arası geçişte ray boş çizilir (ARCHITECTURE §8). */
function renderBlockingEntry(): Plugin {
  return {
    name: `${TOOL}-render-blocking-entry`,
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module"(?![^>]*\bblocking=)/g, '<script type="module" blocking="render"'),
    },
  };
}

/**
 * Tek köken (ARCHITECTURE §3). Geliştirmede bu sunucu ağ geçidi gibi davranır: `/<anahtar>/*` kendisinde, `/api/account` Hesap'ta,
 * `/api/<anahtar>` aracın API'sinde, geri kalan her şey (`/login`, `/home`, `/account/*`) Merkez'dedir.
 * Mock modunda `/api` çağrılarını servis çalışanı yanıtlar.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const mock = env.VITE_MOCK === '1';
  const apiTarget = env.API_PROXY_TARGET || `http://localhost:${DEV_API_PORT}`;
  const accountTarget = env.ACCOUNT_PROXY_TARGET || 'http://localhost:4100';
  const hubTarget = env.HUB_PROXY_TARGET || 'http://localhost:5180';
  // Geliştirme kapısıyla aynı ad: `<ANAHTAR>_WEB_PORT` (Platform/scripts/dev-gateway-targets.mjs).
  const port = Number(env.ORNEKARAC_WEB_PORT) || DEV_WEB_PORT;
  const api = {
    '/api/account': { target: accountTarget, changeOrigin: false },
    [`/api/${TOOL}`]: { target: apiTarget, changeOrigin: false },
  };
  const hub = { [`^/(?!${TOOL}(/|$)|api/)`]: { target: hubTarget, changeOrigin: false } };
  return {
    base: `/${TOOL}/`,
    plugins: [react(), buildId(), renderBlockingEntry(), ...(mock ? [msw({ mode: 'worker-only' })] : [])],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    resolve: {
      // Paketler `file:` ile bağlanır; kaynak bağlantı üzerinden çözülür ki React ve i18next tek kopya kalsın.
      preserveSymlinks: true,
      dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', '@tanstack/react-query'],
    },
    optimizeDeps: {
      exclude: ['@sellerondata/shell', '@sellerondata/contracts', '@sellerondata/format'],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'i18next',
        'react-i18next',
        '@tanstack/react-query',
        'react-router',
        ...(mock ? ['msw', 'msw/browser'] : []),
      ],
    },
    server: { port, strictPort: true, proxy: mock ? hub : { ...api, ...hub } },
    preview: { port: 4173, proxy: { ...api, ...hub } },
    build: { sourcemap: false },
  };
});
