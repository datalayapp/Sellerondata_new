import { configDefaults, defineConfig } from "vitest/config";
import { OLCUM_TESTS } from "./vitest.config.ts";

/** Ölçüm testleri (`pnpm test:olcum`): yalnız gerçek veriye dayananlar; ayrıntı `vitest.config.ts`. */
export default defineConfig({
  test: {
    include: OLCUM_TESTS,
    exclude: configDefaults.exclude,
    testTimeout: 30000,
    // Aktarılmış paketin açılışta yüklenmesi varsayılan kapalı; ölçüm testleri sahibin verisiyle çalıştığı için açar.
    env: { TAGPRESS_BOOTSTRAP: "1" },
  },
});
