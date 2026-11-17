import { sqlIdent, sqlTableIdent, withMaintenanceScope, withOrg, type SqlDb } from './db.ts';

/**
 * Firmanın kalıcı silinmesi (`org.purged`), DeciShip `apps/api/src/services/companyPurge.ts` ile aynı düzenek, araçtan bağımsız:
 *
 * 1. Olay işlemi (`identity.ts`): `CompanyPurge` kaydı yazılır (tek gerçek: silme istendi) ve firma kapalı işaretlenir. Olay hızlı
 *    biter; büyük firmanın silinmesi olay işleminin süresine bağlanmaz.
 * 2. `purgeOrg`: olay commit'inden sonra arkada başlar; yarıda kalırsa bakım (`runPendingPurges`, varsayılan saatlik) yeniden dener.
 *    - Veritabanı: parça parça, her parça kendi kısa işleminde, firma bağlamında (FORCE RLS; ayrıcalıklı rol yok), aynı kilit
 *      sırasıyla (firma kilidi, silme kaydı denetimi, firma satırı `FOR UPDATE`). Silme kaydı yoksa HİÇBİR ŞEY silinmez (her parçada
 *      yeniden denetlenir). Tablolar verilen sırayla boşaltılır (çocuk tablo önce), en sonda paketin `Member` tablosu; parça başına
 *      en çok `batchSize` satır (anahtarla seçilir). Her silme `"orgId" = <firma>` koşulludur. En son firma satırı, ayrı işlemde: önce
 *      bütün tabloların boş olduğu firma satırı kilitliyken denetlenir (arada yazılmış satır varsa tur yeniden başlar).
 *    - Kaldığı yerden sürer: ilerleme ayrıca tutulmaz, kalan satırlar kendisi ilerlemedir. Çağrı başına süre ve parça sınırı
 *      vardır; dolunca `in-progress` döner, bakım sürdürür.
 *    - Dosyalar: `returning` sütunu olan tablonun silinen satırları parçanın commit'inden SONRA `onRowsDeleted`'a verilir (ör. disk
 *      yolları). Veritabanı bitince `onPurged` (ör. firmanın klasörü). Biri hata atarsa kayıt bitmiş sayılmaz (`cleanup-pending`),
 *      bakım yeniden dener: veritabanı adımı boş geçer, `onPurged` yeniden çağrılır (bu yüzden `onPurged` kalan her şeyi kapsamalı;
 *      `onRowsDeleted` hatasında o parçanın satırları geri gelmez).
 *    - Her şey bitince `CompanyPurge.completedAt` yazılır (silme işlemiyle aynı kilit ve denetimle; RLS yalnız bitmemişi bitmiş
 *      yapmaya izin verir); kayıt kalır.
 *
 * Aracın firma tabloları `"orgId"` sütunu ve `Company`'ye yabancı anahtar taşır (RLS ve silme bu sütunla). `orgId`'siz çocuk tablo
 * ebeveynine `ON DELETE CASCADE` ile bağlanır; yoksa listeye girer. `checkPurgeTables` bu kuralları veritabanı kataloğundan denetler.
 */

export type PurgeTable = {
  /** Aracın şemasındaki tablo; `"orgId"` sütunu taşır. */
  table: string;
  /** Parça seçiminin anahtarı (tekil). Varsayılan `id`. */
  key?: string;
  /** Silinen satırlardan `onRowsDeleted`'a verilecek sütunlar (ör. `["path"]`). */
  returning?: readonly string[];
};

export type PurgeConfig = {
  /**
   * Aracın firma tabloları, silme sırasıyla: yabancı anahtarı olan (çocuk) tablo önce. Paketin `Member` tablosu sona kendiliğinden
   * eklenir, `Company` en son silinir. Eksik tablo firma satırının silinmesini engeller (yabancı anahtar) ya da veri bırakır:
   * `checkPurgeTables` eksikleri söyler (aracın testi `[]` beklesin).
   */
  tables: readonly (string | PurgeTable)[];
  /**
   * Parçanın commit'inden sonra, `returning` sütunlu tablonun silinen satırlarıyla. Hata atarsa kayıt bitmiş sayılmaz. `returning`li
   * tablo varsa zorunlu.
   */
  onRowsDeleted?: (orgId: string, table: string, rows: Record<string, unknown>[]) => Promise<void>;
  /**
   * Veritabanı bittikten sonra, her denemede (ör. firmanın dosya klasörü). Hata atarsa bakım yeniden dener. `returning`li tablo
   * varsa zorunlu ve kalan her şeyi kapsamalı: `onRowsDeleted` düşerse o parçanın satırları geri gelmez, temizliği bu kanca yapar.
   */
  onPurged?: (orgId: string) => Promise<void>;
  /** Parça başına satır. Varsayılan `PURGE_BATCH_SIZE`. */
  batchSize?: number;
};

export type PurgeOptions = {
  batchSize?: number;
  /** Bu çağrıda en çok bu kadar veritabanı işlemi (parça); testler yarıda kesmek için kullanır. */
  maxBatches?: number;
  /** Bu çağrının süresi, ms (varsayılan `PURGE_SLICE_MS`); başlamış parça biter, sonrakine geçilmez. */
  budgetMs?: number;
};

export type PurgeRunOptions = PurgeOptions & {
  /** Turun toplam süresi, ms (varsayılan `PURGE_RUN_MS`). */
  runBudgetMs?: number;
  /** Tur başına en çok bu kadar firma (varsayılan `PURGE_RUN_LIMIT`). */
  limit?: number;
};

export type PurgeResult =
  /** silme kaydı yok: hiçbir şey yapılmadı */
  | { state: 'not-requested' }
  /** veritabanı ve dosyalar tamam, `completedAt` yazıldı */
  | { state: 'completed'; rows: Record<string, number> }
  /** veritabanı tamam, `onRowsDeleted` ya da `onPurged` bitmedi: bakım yeniden dener */
  | { state: 'cleanup-pending'; rows: Record<string, number> }
  /** süre ya da parça sınırı doldu: bakım kaldığı yerden sürdürür */
  | { state: 'in-progress'; rows: Record<string, number> };

export type PurgeLog = { warn: (obj: unknown, msg: string) => void };

/** Parça başına satır: kısa işlem. */
export const PURGE_BATCH_SIZE = 500;
/** Tek çağrının (olay alıcısı ya da bakımın bir firması) süresi. */
export const PURGE_SLICE_MS = 2 * 60_000;
/** Bakım turunun toplam süresi: çok büyük firma turu saatlerce tutmaz, sonraki firmalar da ilerler. */
export const PURGE_RUN_MS = 5 * 60_000;
export const PURGE_RUN_LIMIT = 20;
const PURGE_STATEMENT_TIMEOUT = '60s';
/** Paketin kendi tabloları: araç listesine yazılmaz. */
const KIT_TABLES = new Set(['Company', 'Member', 'ProcessedEvent', 'CompanyPurge']);

type Table = { name: string; ref: string; key: string; returning: readonly string[] };

/**
 * Silme listesinin kataloğa göre sorunu (`checkPurgeTables`):
 * - `not-listed`: şemada `"orgId"` sütunlu gerçek tablo (uygulama rolünün yetkisi olmasa da) listede yok;
 * - `missing-table`: listedeki tablo şemada yok;
 * - `missing-column`: anahtar, `"orgId"` ya da `returning` sütunu yok;
 * - `no-delete-privilege`: uygulama rolü (bağlantının rolü) tablodan silemez;
 * - `blocking-reference`: listede olmayan tablo silinen bir tabloya (listedeki, `Company`, `Member` ya da onlarla CASCADE giden
 *   listede olmayan tablo; zincir kaç kat olursa olsun) silmeyi engelleyen bağla (NO ACTION, RESTRICT) bağlı: firma satırı ya da
 *   ebeveyn her turda yabancı anahtar hatasıyla silinemez. `SET NULL` / `SET DEFAULT` engellemez;
 * - `order`: listedeki çocuk tablo silmeyi engelleyen bağla (NO ACTION, RESTRICT) ebeveyninden sonra;
 * - `cascade-returning`: `returning`li tablo, kendinden önce silinen ebeveyniyle CASCADE gider: satırları kancaya ulaşmaz.
 */
export type PurgeTableIssue = {
  table: string;
  issue: 'not-listed' | 'missing-table' | 'missing-column' | 'no-delete-privilege' | 'blocking-reference' | 'order' | 'cascade-returning';
  detail: string;
};

export type OrgPurge = {
  purgeOrg(orgId: string, opts?: PurgeOptions): Promise<PurgeResult>;
  runPendingPurges(opts?: PurgeRunOptions): Promise<number>;
  /** Silme listesinin veritabanı kataloğuna göre sorunları (`PurgeTableIssue`). Aracın testi `[]` beklesin. */
  checkPurgeTables(): Promise<PurgeTableIssue[]>;
};

export function createOrgPurge(opts: {
  db: SqlDb;
  schema: string;
  config: PurgeConfig | undefined;
  lockOrg: (tx: SqlDb, orgId: string) => Promise<unknown>;
  log?: PurgeLog;
}): OrgPurge {
  const { db, log } = opts;
  const s = sqlIdent(opts.schema, 'schema');
  const config = opts.config ?? { tables: [] };
  const seen = new Set<string>();
  const tables: Table[] = [...config.tables, { table: 'Member' }].map((entry, i, all) => {
    const t = typeof entry === 'string' ? { table: entry } : entry;
    const isKitMember = i === all.length - 1;
    if (!isKitMember && KIT_TABLES.has(t.table)) throw new Error(`product-kit purge: "${t.table}" paketin tablosu, listeye yazılmaz`);
    if (seen.has(t.table)) throw new Error(`product-kit purge: "${t.table}" listede iki kez`);
    seen.add(t.table);
    const key = t.key ?? 'id';
    const returning = t.returning ?? [];
    sqlTableIdent(key, 'purge key');
    for (const c of returning) sqlTableIdent(c, 'purge returning');
    return { name: t.table, ref: `${s}.${sqlTableIdent(t.table, 'purge table')}`, key, returning };
  });
  const defaultBatch = config.batchSize ?? PURGE_BATCH_SIZE;
  if (tables.some((t) => t.returning.length)) {
    if (!config.onRowsDeleted) throw new Error('product-kit purge: `returning` sütunlu tablo var ama onRowsDeleted yok (silinen satırlar kimseye ulaşmaz)');
    if (!config.onPurged) {
      throw new Error('product-kit purge: `returning` sütunlu tablo var ama onPurged yok (onRowsDeleted düşerse kalan dosyaları silecek kanca)');
    }
  }

  /** Silmenin tek işlemi: firma bağlamında, firma kilidi → silme kaydı → firma satırı `FOR UPDATE`. Kayıt yoksa `null`. */
  function inPurgeTx<T>(orgId: string, work: (tx: SqlDb) => Promise<T>): Promise<T | null> {
    return withOrg(db, orgId, async (tx) => {
      await opts.lockOrg(tx, orgId);
      if (!(await tx.query(`SELECT 1 FROM ${s}."CompanyPurge" WHERE "orgId" = $1`, [orgId])).length) return null;
      await tx.query(`SET LOCAL statement_timeout = '${PURGE_STATEMENT_TIMEOUT}'`);
      await tx.query(`SELECT "id" FROM ${s}."Company" WHERE "id" = $1 FOR UPDATE`, [orgId]);
      return work(tx);
    });
  }

  async function deleteBatch(tx: SqlDb, orgId: string, t: Table, limit: number): Promise<Record<string, unknown>[]> {
    const key = `"${t.key}"`;
    const cols = [key, ...t.returning.map((c) => `"${c}"`)].join(', ');
    // Tablo ve sütun adı yalnız açılışta denetlenen listeden; firma değeri ve sınır parametre. Dış silme de firma koşullu.
    return tx.query<Record<string, unknown>>(
      `DELETE FROM ${t.ref} WHERE "orgId" = $1 AND ${key} IN (SELECT ${key} FROM ${t.ref} WHERE "orgId" = $1 LIMIT $2) RETURNING ${cols}`,
      [orgId, limit],
    );
  }

  /** Firma satırı kilitliyken bütün tablolar boşsa firma satırı silinir; arada yazılmış satır varsa o tablo döner. */
  async function finishRows(tx: SqlDb, orgId: string): Promise<{ leftover: string | null; company: number }> {
    for (const t of tables) {
      if ((await tx.query(`SELECT 1 FROM ${t.ref} WHERE "orgId" = $1 LIMIT 1`, [orgId])).length) return { leftover: t.name, company: 0 };
    }
    return { leftover: null, company: (await tx.query(`DELETE FROM ${s}."Company" WHERE "id" = $1 RETURNING "id"`, [orgId])).length };
  }

  async function purgeOrg(orgId: string, o: PurgeOptions = {}): Promise<PurgeResult> {
    const batchSize = Math.max(1, Math.floor(o.batchSize ?? defaultBatch));
    const maxBatches = Math.max(1, o.maxBatches ?? Number.POSITIVE_INFINITY);
    const deadline = Date.now() + (o.budgetMs ?? PURGE_SLICE_MS);
    const rows: Record<string, number> = Object.fromEntries([...tables.map((t) => t.name), 'Company'].map((n) => [n, 0]));
    let batches = 0;
    let cleanupOk = true;
    // İlk parça her zaman çalışır: silme kaydı denetimi onunla yapılır.
    const mayContinue = () => batches === 0 || (batches < maxBatches && Date.now() < deadline);

    for (;;) {
      for (const t of tables) {
        for (;;) {
          if (!mayContinue()) return { state: 'in-progress', rows };
          batches++;
          const deleted = await inPurgeTx(orgId, (tx) => deleteBatch(tx, orgId, t, batchSize));
          if (!deleted) return { state: 'not-requested' };
          rows[t.name]! += deleted.length;
          if (deleted.length && t.returning.length && config.onRowsDeleted) {
            try {
              await config.onRowsDeleted(orgId, t.name, deleted);
            } catch (err) {
              cleanupOk = false;
              log?.warn({ err, orgId, table: t.name }, 'product-kit purge: onRowsDeleted failed; maintenance retries onPurged');
            }
          }
          if (deleted.length < batchSize) break;
        }
      }
      if (!mayContinue()) return { state: 'in-progress', rows };
      batches++;
      const done = await inPurgeTx(orgId, (tx) => finishRows(tx, orgId));
      if (!done) return { state: 'not-requested' };
      rows.Company! += done.company;
      if (!done.leftover) break;
    }

    if (config.onPurged) {
      try {
        await config.onPurged(orgId);
      } catch (err) {
        cleanupOk = false;
        log?.warn({ err, orgId }, 'product-kit purge: onPurged failed; maintenance retries');
      }
    }
    if (!cleanupOk) return { state: 'cleanup-pending', rows };
    const marked = await inPurgeTx(orgId, (tx) =>
      tx.query(`UPDATE ${s}."CompanyPurge" SET "completedAt" = now() WHERE "orgId" = $1 AND "completedAt" IS NULL RETURNING "orgId"`, [orgId]),
    );
    if (!marked) return { state: 'not-requested' };
    return { state: 'completed', rows };
  }

  /** Bitmemiş silmeler (bakım kapsamı yalnız `completedAt` boş kayıtları görür), eskiden yeniye. Tamamlanan firma sayısı. */
  async function runPendingPurges(o: PurgeRunOptions = {}): Promise<number> {
    const { runBudgetMs = PURGE_RUN_MS, budgetMs = PURGE_SLICE_MS, limit = PURGE_RUN_LIMIT, ...purgeOpts } = o;
    const deadline = Date.now() + runBudgetMs;
    const pending = await withMaintenanceScope(db, (tx) =>
      tx.query<{ orgId: string }>(`SELECT "orgId" FROM ${s}."CompanyPurge" WHERE "completedAt" IS NULL ORDER BY "createdAt", "orgId" LIMIT $1`, [limit]),
    );
    let done = 0;
    for (const { orgId } of pending) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        if ((await purgeOrg(orgId, { ...purgeOpts, budgetMs: Math.min(budgetMs, left) })).state === 'completed') done++;
      } catch (err) {
        log?.warn({ err, orgId }, 'product-kit purge failed; next maintenance run retries');
      }
    }
    return done;
  }

  /** Katalog (pg_catalog) okunur: uygulama rolünün yetkisi olmayan tablolar da görünür; görünüm ve bölüm (partition) sayılmaz. */
  async function checkPurgeTables(): Promise<PurgeTableIssue[]> {
    const issues: PurgeTableIssue[] = [];
    const order = new Map(tables.map((t, i) => [t.name, i]));
    const byName = new Map(tables.map((t) => [t.name, t]));
    const rels = await db.query<{ name: string; cols: string[]; canDelete: boolean }>(
      `SELECT c.relname AS "name", has_table_privilege(c.oid, 'DELETE') AS "canDelete",
              ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS "cols"
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
      [opts.schema],
    );
    const relByName = new Map(rels.map((r) => [r.name, r]));
    for (const r of rels) {
      if (r.cols.includes('orgId') && !order.has(r.name) && !KIT_TABLES.has(r.name)) {
        issues.push({ table: r.name, issue: 'not-listed', detail: '"orgId" sütunlu tablo silme listesinde yok' });
      }
    }
    for (const t of tables) {
      const r = relByName.get(t.name);
      if (!r) {
        issues.push({ table: t.name, issue: 'missing-table', detail: `şemada "${opts.schema}"."${t.name}" yok` });
        continue;
      }
      for (const c of new Set([t.key, 'orgId', ...t.returning])) {
        if (!r.cols.includes(c)) issues.push({ table: t.name, issue: 'missing-column', detail: `"${c}" sütunu yok` });
      }
      if (!r.canDelete) issues.push({ table: t.name, issue: 'no-delete-privilege', detail: 'uygulama rolü bu tablodan silemez' });
    }
    // Bu şemadaki tablolara bağlanan bütün yabancı anahtarlar (çocuk hangi şemada olursa olsun).
    const fks = await db.query<{ child: string; childSchema: string; parent: string; action: string; name: string }>(
      `SELECT ch.relname AS "child", chn.nspname AS "childSchema", p.relname AS "parent", con.confdeltype::text AS "action", con.conname AS "name"
         FROM pg_constraint con
         JOIN pg_class ch ON ch.oid = con.conrelid JOIN pg_namespace chn ON chn.oid = ch.relnamespace
         JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE con.contype = 'f' AND pn.nspname = $1`,
      [opts.schema],
    );
    // Her tablonun silindiği sıra: listedeki kendi yerinde, `Company` en son; listede olmayan CASCADE çocuğu en erken ebeveyniyle
    // (zincir boyunca, kaç kat olursa olsun; paketin tabloları hariç).
    const deletedAt = new Map<string, number>([...order, ['Company', Number.POSITIVE_INFINITY]]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const fk of fks) {
        if (fk.action !== 'c' || fk.childSchema !== opts.schema || fk.child === fk.parent || order.has(fk.child) || KIT_TABLES.has(fk.child)) continue;
        const at = deletedAt.get(fk.parent);
        const cur = deletedAt.get(fk.child);
        if (at !== undefined && (cur === undefined || at < cur)) {
          deletedAt.set(fk.child, at);
          changed = true;
        }
      }
    }
    const blocks = (action: string) => action === 'a' || action === 'r';
    for (const fk of fks) {
      const parentAt = deletedAt.get(fk.parent);
      if (parentAt === undefined) continue;
      const sameSchema = fk.childSchema === opts.schema;
      if (sameSchema && fk.child === fk.parent) continue;
      const childIndex = sameSchema ? order.get(fk.child) : undefined;
      if (childIndex === undefined) {
        // Listede olmayan çocuk (paketin tabloları hariç): CASCADE ile ebeveyniyle gider, SET NULL / SET DEFAULT bağı boşaltır;
        // başka yoldan daha önce silinen çocuk da engellemez.
        if (sameSchema && KIT_TABLES.has(fk.child)) continue;
        if (!blocks(fk.action)) continue;
        const childAt = sameSchema ? deletedAt.get(fk.child) : undefined;
        if (childAt !== undefined && childAt < parentAt) continue;
        const via = order.has(fk.parent) || fk.parent === 'Company' ? '' : ' (CASCADE ile silinen)';
        issues.push({
          table: sameSchema ? fk.child : `${fk.childSchema}.${fk.child}`,
          issue: 'blocking-reference',
          detail: `"${fk.parent}"${via} tablosuna ON DELETE CASCADE olmadan bağlı (${fk.name}): listeye ekle ya da CASCADE yap`,
        });
        continue;
      }
      // Company ve Member en son silinir; listedeki her çocuk onlardan önce gider.
      if (childIndex < parentAt) continue;
      if (fk.action === 'c') {
        if (byName.get(fk.child)!.returning.length) {
          issues.push({
            table: fk.child,
            issue: 'cascade-returning',
            detail: `"${fk.parent}" önce silinince CASCADE ile gider (${fk.name}): satırları onRowsDeleted'a ulaşmaz; listede ebeveyninden önce yaz`,
          });
        }
      } else if (blocks(fk.action)) {
        issues.push({ table: fk.child, issue: 'order', detail: `"${fk.parent}" tablosundan sonra yazılmış (${fk.name}): çocuk tablo önce silinmeli` });
      }
    }
    return issues;
  }

  return { purgeOrg, runPendingPurges, checkPurgeTables };
}
