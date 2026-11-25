import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

// Migration sod_deciship_admin ile çalışır (ARCHITECTURE §4). Uygulama (sod_deciship) bu adresi hiç görmez.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://sod_deciship_admin:sod_deciship_admin_dev@localhost:5434/sellerondata?schema=deciship&options=-c%20TimeZone%3DUTC',
  },
});
