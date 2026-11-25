import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Platform paketleri (`@sellerondata/shell`, `contracts`, `format`) `link:` ile kaynağından okunur; kendi klasörlerinde
 * (`Platform/packages/<ad>/node_modules`) React, i18next, sorgu ve yönlendirici kurulu değil, birbirlerini de bulamazlar.
 * Bu eklenti o paketlerin içinden gelen çıplak içe aktarmaları TagPress web'in içinden yapılmış gibi çözer: tek React,
 * tek i18next kopyası; yerelde, imajda ve testte aynı. (DeciShip npm `file:` + `preserveSymlinks` kullanır; pnpm'de
 * `preserveSymlinks` pnpm'in kendi iç bağımlılıklarını bozar.)
 */
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const FROM = path.join(WEB_DIR, "src", "main.tsx");
const PEERS = /^(react|react-dom|react-i18next|i18next|react-router|@tanstack\/react-query|@sellerondata\/(?:contracts|format|shell))(\/.*)?$/;
const PLATFORM_PACKAGES = /[\\/]Platform[\\/]packages[\\/](?:shell|contracts|format)[\\/]/;

export function platformPeers(): Plugin {
  return {
    name: "tagpress-platform-peers",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !PEERS.test(source) || !PLATFORM_PACKAGES.test(importer)) return null;
      return this.resolve(source, FROM, { ...options, skipSelf: true });
    },
  };
}
