import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';

/**
 * Yalnız mock modunda: `/deciship/*` isteklerini geçici DeciShip taslağına verir (dev/deciship-stub).
 * Araçlar arası tam gezintiyi, View Transitions'ı ve kabuğun başka uygulamada çalışmasını doğrulamak içindir.
 * Üretim derlemesine girmez.
 */
function decishipStub(): Plugin {
  return {
    name: 'sod-deciship-stub',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        const accept = req.headers.accept ?? '';
        if (/^\/deciship(\/|$|\?)/.test(url) && (accept.includes('text/html') || accept === '*/*')) {
          req.url = '/dev/deciship-stub/index.html';
        }
        next();
      });
    },
  };
}

/**
 * Vite derlemede giriş betiğinin `blocking` özniteliğini düşürür. Geri koyar: yeni belgenin ilk karesi
 * React çizdikten sonra alınır, yoksa araçlar arası geçişte ray boş çizilir (§8).
 */
function renderBlockingEntry(): Plugin {
  return {
    name: 'sod-render-blocking-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module"(?! blocking)/, '<script type="module" blocking="render"'),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const mock = env.VITE_MOCK === '1';
  const accountTarget = env.ACCOUNT_PROXY_TARGET || 'http://localhost:4100';
  const productTarget = env.API_PROXY_TARGET || 'http://localhost:4000';
  const proxy = {
    '/api/account': { target: accountTarget, changeOrigin: false },
    '/api': { target: productTarget, changeOrigin: false },
  };
  return {
    plugins: [react(), renderBlockingEntry(), ...(mock ? [msw({ mode: 'worker-only' }), decishipStub()] : [])],
    resolve: {
      // Paketler `file:` ile bağlanır; kaynak bağlantı üzerinden çözülür ki React tek kopya kalsın.
      preserveSymlinks: true,
      dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', '@tanstack/react-query'],
    },
    optimizeDeps: {
      exclude: ['@sellerondata/shell', '@sellerondata/contracts', '@sellerondata/format'],
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'i18next', 'react-i18next', '@tanstack/react-query', 'react-router', ...(mock ? ['msw', 'msw/browser'] : [])],
    },
    server: {
      port: 5180,
      strictPort: true,
      proxy: mock ? undefined : proxy,
    },
    preview: { port: 5180, proxy },
    build: {
      sourcemap: false,
      // Yalnız `npm run test:prod`: geçiş testi için DeciShip taslağı ikinci giriş olur. Normal derlemeye girmez.
      ...(process.env.SOD_E2E_STUB ? { rollupOptions: { input: { main: 'index.html', stub: 'dev/deciship-stub/index.html' } } } : {}),
    },
  };
});
