import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { platformPeers } from "./platform-peers.ts";

/**
 * Tek giriş: index.html → src/main.tsx (Tezgâh). Tailwind yok; stiller düz CSS (src/tezgah/tokens*.css + bileşen CSS'leri).
 *
 * İki yapı (plan §S3, §S8):
 * - Yerel (`pnpm build`, `pnpm dev`): taban `/`, sunucu `/api` (5420), girişsiz, bugünkü üst satır.
 * - Platform (`pnpm build:platform`, `VITE_TAGPRESS_PLATFORM=1`): taban `/tagpress/`, sunucu `/api/tagpress`, ortak kabuk
 *   ve oturum. Geliştirmede (`pnpm dev:platform`, 5423) bu sunucu ağ geçidi gibi davranır: `/tagpress/*` kendisinde,
 *   `/api/account` Hesap'ta (4100), `/api/tagpress` TagPress API'sinde (5422), geri kalanı (`/login`, `/home`, `/account/*`)
 *   Merkez'de (5180). Portlar kayıttaki `deploy.web.dev` / `deploy.api.dev` ile aynı.
 */
const DEV_WEB_PORT = 5423;
const DEV_API_PORT = 5422;

/** Her platform derlemesinin kimliği: açık kalan sekme eski paketle kaldıysa `/tagpress/version.json` ile fark edilir. */
const BUILD_ID = Date.now().toString(36);
function buildId(): Plugin {
  return {
    name: "tagpress-build-id",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const platform = (process.env.VITE_TAGPRESS_PLATFORM ?? env.VITE_TAGPRESS_PLATFORM) === "1";
  const shared = {
    // Platform paketleri (shell, contracts, format) `link:` ile kaynağından okunur; içlerindeki React/i18next içe
    // aktarmaları TagPress'in kopyasına çözülür (`platform-peers.ts`), ikinci kopya yüklenmez.
    resolve: { dedupe: ["react", "react-dom", "i18next", "react-i18next", "react-router", "@tanstack/react-query"] },
    optimizeDeps: { exclude: ["@sellerondata/shell", "@sellerondata/format", "@sellerondata/contracts"] },
    build: { outDir: "dist", emptyOutDir: true },
  };
  if (!platform) {
    const api = `http://127.0.0.1:${process.env.PORT ?? 5420}`;
    return {
      ...shared,
      plugins: [platformPeers(), react()],
      server: { port: 5421, strictPort: true, host: "127.0.0.1", proxy: { "/api": { target: api, changeOrigin: true } } },
    };
  }
  const apiTarget = env.API_PROXY_TARGET || `http://localhost:${DEV_API_PORT}`;
  const accountTarget = env.ACCOUNT_PROXY_TARGET || "http://localhost:4100";
  const hubTarget = env.HUB_PROXY_TARGET || "http://localhost:5180";
  // Geliştirme kapısıyla aynı ad: `<ANAHTAR>_WEB_PORT` (Platform/scripts/dev-gateway-targets.mjs).
  const port = Number(env.TAGPRESS_WEB_PORT) || DEV_WEB_PORT;
  const proxy = {
    "/api/account": { target: accountTarget, changeOrigin: false },
    "/api/tagpress": { target: apiTarget, changeOrigin: false },
    "^/(?!tagpress(/|$)|api/)": { target: hubTarget, changeOrigin: false },
  };
  return {
    ...shared,
    base: "/tagpress/",
    plugins: [platformPeers(), react(), buildId()],
    server: { port, strictPort: true, proxy },
    preview: { port: 4174, proxy },
  };
});
