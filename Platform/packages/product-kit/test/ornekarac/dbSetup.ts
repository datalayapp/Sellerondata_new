import pg from 'pg';
import { ORNEKARAC } from './product.ts';

/**
 * Örnek Araç'ın veritabanı kurulumu, gerçek araç gibi: rolleri ve şeması kayıttan üretilen init.sql'in SQL'iyle
 * (`Platform/scripts/products-db.mjs` `renderInitSql`, kayda Örnek Araç eklenmiş gibi). Kopya SQL tutulmaz.
 * - Küme: `sod_ornekarac_admin` ve `sod_ornekarac` yoksa init.sql'in `CREATE ROLE` satırıyla açılır (parola ortamdan, yoksa
 *   init.sql gibi `<rol>_dev`); `ALTER ROLE … SET` satırları her koşuda yazılır. Roller kümede kalır (DeciShip'in rolleri gibi).
 *   Gerçek kullanım kümesine test hiç bağlanmaz (`scripts/lib/pg-guard.mjs`).
 * - Test veritabanı: init.sql'in veritabanı başına bölümü (`@db-setup-begin` … `@db-setup-end`): şema göç rolünün, uygulama
 *   rolüne yalnız kullanım ve varsayılan veri hakları. Göç (`migration.sql`) göç rolüyle çalışır: `CREATE SCHEMA` gerekmez.
 */

type ProductsDb = {
  renderInitSql(entries: readonly unknown[], generatedNote: string): string;
  adminRole(key: string): string;
  appRole(key: string): string;
  adminPasswordEnv(key: string): string;
  appPasswordEnv(key: string): string;
};

const PRODUCTS_DB = new URL('../../../../scripts/products-db.mjs', import.meta.url);
const loadProductsDb = async () => (await import(PRODUCTS_DB.href)) as ProductsDb;

export type ToolRole = { name: string; password: string };
export type ToolDbSetup = { admin: ToolRole; app: ToolRole; dbSetupSql: string };

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Kümede aracın iki rolünü açar (yoksa) ve test veritabanına uygulanacak bölümü döner. */
export async function ensureToolRoles(superUrl: string): Promise<ToolDbSetup> {
  const lib = await loadProductsDb();
  const init = lib.renderInitSql([ORNEKARAC], 'product-kit test kurulumu').replace(/\r\n/g, '\n');
  const lines = init.split('\n');
  const key = ORNEKARAC.key;
  const role = (name: string, env: string): ToolRole => ({ name, password: process.env[env] ?? `${name}_dev` });
  const admin = role(lib.adminRole(key), lib.adminPasswordEnv(key));
  const app = role(lib.appRole(key), lib.appPasswordEnv(key));

  const su = new pg.Client({ connectionString: superUrl });
  await su.connect();
  try {
    await su.query('BEGIN');
    // Eşzamanlı koşular rolü aynı anda açmaya ya da ayarını yazmaya çalışmasın (kilit `postgres` veritabanında, işlem sonuna dek).
    await su.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['product-kit:test-roles']);
    for (const r of [admin, app]) {
      const create = lines.find((l) => l.startsWith(`CREATE ROLE ${r.name} `));
      const settings = lines.filter((l) => l.startsWith(`ALTER ROLE ${r.name} SET `));
      const placeholder = `:'${r.name}_password'`;
      if (!create?.includes(placeholder) || settings.length === 0) throw new Error(`init.sql üreteci ${r.name} satırlarını vermedi`);
      if ((await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r.name])).rowCount === 0) {
        await su.query(create.replace(placeholder, literal(r.password)));
      }
      for (const s of settings) await su.query(s);
    }
    await su.query('COMMIT');
  } catch (e) {
    await su.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await su.end();
  }

  const start = init.indexOf('-- @db-setup-begin');
  const end = init.indexOf('-- @db-setup-end');
  if (start < 0 || end < 0) throw new Error('init.sql üretecinde @db-setup işaretleri yok');
  return { admin, app, dbSetupSql: init.slice(start, end) };
}
