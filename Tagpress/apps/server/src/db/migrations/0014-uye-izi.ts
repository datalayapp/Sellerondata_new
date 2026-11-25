import type { DatabaseSync } from "node:sqlite";
import type { MigrationEnv } from "./types.ts";

// 14: üye izi (2. aşama; plan §2.6, §S4). Merkez etkinlik akışında "kim" ve yapay zekâ geçidiyle eşleşme için boş olabilir
// sütunlar; Postgres şemasında (`db/pg/migrations/0001-tagpress.sql`) aynı adlarla vardır (şema eşliği testi).
// - `job_log.member_id`, `print_exports.member_id`, `design_sessions.member_id`, `ai_calls.member_id`: işi başlatan üye
//   (platform kipinde Hesap üyeliği; yerel kipte ve eski satırlarda boş).
// - `ai_calls.gateway_call_id`: yapay zekâ geçidinin çağrı kimliği (`x-sod-ai-call-id`; yerel kipte boş).
// Var olan satırlara dokunulmaz. İkinci koşu hata vermez, bir şey değiştirmez.

export const MIGRATION_14_COLUMNS = [
  ["job_log", "member_id"],
  ["print_exports", "member_id"],
  ["design_sessions", "member_id"],
  ["ai_calls", "member_id"],
  ["ai_calls", "gateway_call_id"],
] as const;

export function migration(db: DatabaseSync, _env: MigrationEnv): void {
  for (const [table, column] of MIGRATION_14_COLUMNS) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`);
  }
}
