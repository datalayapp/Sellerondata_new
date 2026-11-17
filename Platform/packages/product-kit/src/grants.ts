import { sqlIdent, type SqlDb } from './db.ts';

/**
 * `memberProjectionSql`'in uygulama rolüne verdiği haklar (tablo düzeyi). Bundan fazlası hak kaymasıdır: ör. aracın göçündeki
 * toplu `GRANT … ON ALL TABLES IN SCHEMA` (products-lists.mjs reddeder) ya da init.sql'in varsayılan haklarını geri almayan
 * elle yazılmış blok. `CompanyPurge` tablo düzeyinde güncellenmez; yalnız `completedAt` sütunu (`PROJECTION_COLUMN_UPDATES`).
 */
export const PROJECTION_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Company: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  Member: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  ProcessedEvent: ['SELECT', 'INSERT', 'DELETE'],
  CompanyPurge: ['SELECT', 'INSERT'],
});

/** Tablo düzeyinde güncelleme hakkı olmayan şablon tablolarında güncellenebilen sütunlar. */
export const PROJECTION_COLUMN_UPDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  CompanyPurge: ['completedAt'],
});

const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** `checkGrants` bulgusu. `privilege`: tablo hakkı; `column`: yalnız sütun güncellemesinde. */
export type GrantIssue = {
  table: string;
  issue: 'missing-table' | 'missing-privilege' | 'extra-privilege';
  privilege?: string;
  column?: string;
};

/**
 * Bağlantının rolünün (aracın uygulama rolü) şablon tablolarındaki hakları beklenenle aynı mı. Yalnız katalog okur; RLS ve
 * firma bağlamı gerekmez. Aracın kendi tabloları denetlenmez (onların hakkı aracın göçünde).
 */
export async function checkProjectionGrants(db: SqlDb, schema: string): Promise<GrantIssue[]> {
  sqlIdent(schema, 'schema');
  const tables = Object.keys(PROJECTION_TABLE_PRIVILEGES);
  const tablePrivs = await db.query<{ t: string; priv: string; has: boolean }>(
    `SELECT c.relname AS t, p.priv, has_table_privilege(c.oid, p.priv) AS has
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN unnest($3::text[]) AS p(priv)
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')`,
    [schema, tables, ALL_PRIVILEGES],
  );
  const columnUpdates = await db.query<{ t: string; col: string }>(
    `SELECT c.relname AS t, a.attname AS col
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege(c.oid, a.attnum, 'UPDATE')`,
    [schema, tables],
  );
  const issues: GrantIssue[] = [];
  for (const table of tables) {
    const rows = tablePrivs.filter((r) => r.t === table);
    if (rows.length === 0) {
      issues.push({ table, issue: 'missing-table' });
      continue;
    }
    const expected = PROJECTION_TABLE_PRIVILEGES[table]!;
    for (const r of rows) {
      if (r.has && !expected.includes(r.priv)) issues.push({ table, issue: 'extra-privilege', privilege: r.priv });
      if (!r.has && expected.includes(r.priv)) issues.push({ table, issue: 'missing-privilege', privilege: r.priv });
    }
    // Tablo düzeyinde UPDATE yoksa yalnız listedeki sütunlar güncellenebilir (tablo düzeyindeki UPDATE her sütunu kapsar).
    // Fazladan tablo düzeyinde UPDATE zaten bildirildi; sütunları ayrıca saymaya gerek yok.
    if (!expected.includes('UPDATE') && !rows.some((r) => r.priv === 'UPDATE' && r.has)) {
      const allowed = PROJECTION_COLUMN_UPDATES[table] ?? [];
      const actual = columnUpdates.filter((r) => r.t === table).map((r) => r.col);
      for (const col of actual) if (!allowed.includes(col)) issues.push({ table, issue: 'extra-privilege', privilege: 'UPDATE', column: col });
      for (const col of allowed) if (!actual.includes(col)) issues.push({ table, issue: 'missing-privilege', privilege: 'UPDATE', column: col });
    }
  }
  return issues;
}
