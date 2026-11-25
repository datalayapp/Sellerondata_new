import { SyncPgBridge } from "../../../db/pg/bridge.ts";
import { toPg } from "../../../db/pg/dialect.ts";
import { PgStatement, PgTenantDb } from "../../../db/pg/pg-tenant-db.ts";
import { Tenancy } from "../../../org/tenancy.ts";
import { createTestDb } from "../../../test/pg.ts";
import { type HubHarness, type Insert, MEMBER_NAMES } from "./scenario.ts";

/**
 * Merkez senaryosunun Postgres düzeni (`pnpm test:pg`): koşunun şablonundan yeni veritabanı; satırlar süper kullanıcı
 * bağlantısıyla yazılır (RLS'yi aşar; `orgs` test eki tetikleyicisi `Company` satırını açar), sağlayıcılar uygulama
 * rolüyle `PgTenantDb` üzerinden okur (RLS altında). Aynı senaryo SQLite düzeniyle aynı yanıtları vermeli.
 */
export async function pgHarness(): Promise<HubHarness> {
  const pg = await createTestDb();
  const raw = new SyncPgBridge({ connectionString: pg.superUrl, searchPath: "tagpress, pg_temp", applicationName: "tagpress-test-hub-raw" });
  const app = new SyncPgBridge({ connectionString: pg.appUrl, applicationName: "tagpress-test-hub" });
  const run = (sql: string, ...params: (string | number | null)[]) => new PgStatement(raw, sql, toPg(sql), () => ({ ctx: { org: "", scope: "" }, org: null })).run(...params);
  const insert: Insert = (table, row) => {
    // Üye izi (`member_id`) Postgres'te product-kit `Member`'a yabancı anahtar: senaryonun üyesi bir kez açılır.
    if (typeof row.member_id === "string" && typeof row.org_id === "string") {
      run('INSERT INTO "Member" ("id", "orgId", "name") VALUES (?, ?, ?) ON CONFLICT ("id") DO NOTHING', row.member_id, row.org_id, MEMBER_NAMES[row.member_id] ?? "");
    }
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    run(sql, ...keys.map((k) => row[k] ?? null));
  };
  return {
    db: new PgTenantDb(app, new Tenancy({ mode: "strict" })),
    insert,
    close: async () => {
      await raw.close();
      await app.close();
      await pg.drop();
    },
  };
}
