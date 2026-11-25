import { configDefaults, defineConfig } from "vitest/config";
import { platformPeers } from "./apps/web/platform-peers.ts";

/**
 * Ölçüm testleri: gerçek veriye (aktarılmış paket, kullanıcının tasarım dili ve referansları; TAGPRESS_DATA_DIR ya da
 * data/) dayanır, her makinede bulunmaz. Birim testlerine (`pnpm test`) girmez; `pnpm test:olcum` ile koşar ve veri
 * yoksa açık hatayla düşer. Yeni ölçüm testi `*.olcum.test.ts` adını alır; listedeki üç dosya eski adlarıyla duruyor.
 */
export const OLCUM_TESTS = [
  "**/*.olcum.test.ts",
  "packages/learn/src/gercek.test.ts",
  "packages/templates/src/gercek.test.ts",
  "apps/server/src/integration.test.ts",
];

export const TEST_INCLUDE = ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"];

export default defineConfig({
  // Web testleri ortak kabuğu (`@sellerondata/shell`, `link:`) kaynağından yükler; içindeki React/i18next TagPress web'inkine çözülür.
  plugins: [platformPeers()],
  test: {
    include: TEST_INCLUDE,
    // `*.pg.test.ts` yalnız Postgres koşusunda (`pnpm test:pg`, `vitest.pg.config.ts`).
    exclude: [...configDefaults.exclude, ...OLCUM_TESTS, "**/*.pg.test.ts"],
    testTimeout: 30000,
    // Sunucunun varsayılan kipi platform (plan §2.6); testler yerel kipte. Platform kipi testleri kipi kendisi verir.
    env: { TAGPRESS_AUTH: "local" },
  },
});
