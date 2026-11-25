import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { SUPER_URL, TEST_DB_NAME, TEST_MIGRATE_URL, TEST_SUPER_DB_URL } from './testEnv.ts';

const API_ROOT = path.resolve(import.meta.dirname, '..');
const PRODUCTS_DB = pathToFileURL(path.resolve(API_ROOT, '../../scripts/products-db.mjs'));

type ProductsDb = { renderInitSql(entries: readonly unknown[], note: string): string };

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Test veritabanı üretimle aynı rol ve haklarla (kopya SQL yok): roller ve veritabanı bölümü kayıttan üretilen init.sql'den
 * (`Platform/scripts/products-db.mjs`, kiracılar platform + ai). Kümede rol yoksa init.sql'in `CREATE ROLE` satırıyla açılır (parola
 * ortamdan, yoksa `<rol>_dev`), `ALTER ROLE … SET` satırları her koşuda yazılır; roller kümede kalır (diğer servislerin rolleri gibi).
 * Göç `sod_ai_admin` ile `prisma migrate deploy`.
 */
export default async function setup() {
  const lib = (await import(PRODUCTS_DB.href)) as ProductsDb;
  const init = lib.renderInitSql([], 'ai-api test kurulumu').replace(/\r\n/g, '\n');
  const lines = init.split('\n');

  const su = new pg.Client({ connectionString: SUPER_URL });
  await su.connect();
  try {
    await su.query('BEGIN');
    await su.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ai-api:test-roles']);
    for (const create of lines.filter((l) => l.startsWith('CREATE ROLE '))) {
      const m = /^CREATE ROLE (\S+) LOGIN PASSWORD :'(\S+)'/.exec(create);
      if (!m) throw new Error(`init.sql üreteci beklenmeyen CREATE ROLE satırı verdi: ${create.slice(0, 60)}`);
      const [, name, psqlVar] = m as unknown as [string, string, string];
      const envName = lines.find((l) => l.startsWith(`\\getenv ${psqlVar} `))?.split(' ')[2];
      const password = (envName && process.env[envName]) || `${name}_dev`;
      if ((await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount === 0) {
        await su.query(create.replace(`:'${psqlVar}'`, literal(password)));
      }
    }
    for (const s of lines.filter((l) => /^ALTER ROLE sod_ai(_admin)? SET /.test(l))) await su.query(s);
    await su.query('COMMIT');
    await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [TEST_DB_NAME]);
    await su.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await su.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } catch (e) {
    await su.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await su.end();
  }

  const start = init.indexOf('-- @db-setup-begin');
  const end = init.indexOf('-- @db-setup-end');
  if (start < 0 || end < 0) throw new Error('init.sql üretecinde @db-setup işaretleri yok');
  const db = new pg.Client({ connectionString: TEST_SUPER_DB_URL });
  await db.connect();
  try {
    await db.query(init.slice(start, end));
  } finally {
    await db.end();
  }

  execSync('npx prisma migrate deploy', {
    cwd: API_ROOT,
    env: { ...process.env, MIGRATE_DATABASE_URL: TEST_MIGRATE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });

  return async () => {
    if (process.env.AI_TEST_KEEP_DB) return;
    const c = new pg.Client({ connectionString: SUPER_URL });
    await c.connect();
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [TEST_DB_NAME]);
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await c.end();
  };
}
