import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// Göç sod_ai_admin ile çalışır (ARCHITECTURE §4). Uygulama bu adresi hiç görmez.
// `prisma migrate dev` gölge veritabanı ister, rolde CREATEDB yoktur: SHADOW_DATABASE_URL süper kullanıcıyla verilir.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://sod_ai_admin:sod_ai_admin_dev@localhost:5434/sellerondata?schema=ai',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
