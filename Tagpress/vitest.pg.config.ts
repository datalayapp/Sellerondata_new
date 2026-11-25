import { configDefaults, defineConfig } from "vitest/config";
import { OLCUM_TESTS } from "./vitest.config.ts";

/**
 * Postgres koşusu (`pnpm test:pg`; plan §7, B5): TagPress sunucu testleri aynı servis koduyla Postgres'te (senkron köprü,
 * `PgTenantDb`, RLS altında uygulama rolü). Küme `TEST_DB_HOST` (5435: `npm run pg:baslat`); her test uygulaması koşunun
 * şablonundan yeni veritabanı alır ve bitişte siler (`apps/server/src/test/pg.ts`).
 * - `*.pg.test.ts`: yalnız Postgres'te anlamlı testler (şema, köprü, RLS); `pnpm test`'e girmez.
 * - Sunucu testleri `TAGPRESS_TEST_DB=pg` ile: `makeApp` Postgres'li uygulama kurar.
 * - Dışlananlar (`PG_EXCLUDED`): SQLite'a özgü (göçler, dosya veritabanı, node:sqlite) ya da yerel kipin kurulum tablosuna
 *   doğrudan dayanan testler. Her satırın nedeni yanında.
 */
export const PG_EXCLUDED = [
  // SQLite göçleri, yedek ve dosya veritabanı (Postgres'te göç `db/pg/migrations`, şema testleri `*.pg.test.ts`).
  "apps/server/src/db/migrations.test.ts",
  "apps/server/src/db/migrations/*.test.ts",
  // SQLite şeması (tetikleyiciler, `sqlite_master`; Postgres karşılığı `db/pg/schema.pg.test.ts`).
  "apps/server/src/org/schema.test.ts",
  // SQLite TenantDb'nin birim testi (kendi `:memory:` veritabanını açar; Postgres karşılığı `db/pg/bridge.pg.test.ts`).
  "apps/server/src/org/tenant-db.test.ts",
];

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...OLCUM_TESTS, ...PG_EXCLUDED],
    testTimeout: 60000,
    hookTimeout: 60000,
    globalSetup: ["apps/server/src/test/pg-global-setup.ts"],
    env: { TAGPRESS_TEST_DB: "pg", TAGPRESS_AUTH: "local" },
    // Her test uygulaması bir veritabanı + bir bağlantı (köprü) açar: kümeyi ve belleği boğmasın.
    maxWorkers: 6,
  },
});
