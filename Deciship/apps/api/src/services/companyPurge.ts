/**
 * Firmanın kalıcı silinmesi (`org.purged`). Hesap firmayı 30 günlük saklama süresi
 * dolunca siler ve olayı gönderir; burada firmanın bütün verisi ve depodaki dosyaları geri dönmez biçimde silinir.
 *
 * Düzenek (iki adım, ikisi de tekrar edilebilir):
 * 1. Olay işlemi (`identity.ts`): `CompanyPurge` kaydı yazılır (tek gerçek: silme istendi) ve firma kapalı işaretlenir. Olay
 *    hızlı biter; büyük firmanın silinmesi olay işleminin süresine bağlanmaz.
 * 2. `purgeCompany`: commit'ten sonra olay alıcısı başlatır, yarıda kalırsa saatlik bakım (`maintenance.ts` `runCompanyPurges`)
 *    yeniden dener. Her deneme `CompanyPurge.attemptedAt`'i yazar; bakım önce hiç denenmemiş, sonra en uzun süredir denenmemiş
 *    silmeyi alır (`companyPurgeQueue`): hep düşen silme yenilerini bekletmez.
 *    - Veritabanı: parça parça, her parça kendi kısa işleminde, firma bağlamında (FORCE RLS; ayrıcalıklı rol yok), aynı kilit
 *      sırasıyla (firma kilidi, silme kaydı denetimi, firma satırı `FOR UPDATE`). `CompanyPurge` kaydı yoksa HİÇBİR ŞEY
 *      silinmez: silme yalnız Hesap'ın olayıyla başlar (her parçada yeniden denetlenir). Tablolar `PURGE_TABLES` sırasıyla
 *      boşaltılır (RESTRICT ve NO ACTION anahtarları: çocuk tablo bütünüyle önce), parça başına en çok `batchSize` satır
 *      (birincil anahtarla seçilir). Her silme `"companyId" = <firma>` koşulludur ve bağlam da yalnız o firmayı gösterir:
 *      başka firmaya dokunulamaz. En son firma satırı, ayrı işlemde: önce bütün tabloların boş olduğu firma satırı kilitliyken
 *      denetlenir (arada yazılmış satır varsa tur yeniden başlar).
 *    - Kaldığı yerden sürer: ilerleme ayrıca tutulmaz, her çağrı sıradaki boş olmayan tablodan devam eder (kalan satırlar
 *      kendisi ilerlemedir; firma zaten kapalıdır, silme geri alınmaz). Çağrı başına süre ve parça sınırı vardır
 *      (`PurgeOptions`); dolunca `in-progress` döner, bakım sonraki turda sürdürür. Bakım turunun toplam süresi de sınırlıdır.
 *    - Disk: yalnız ilgili parçanın commit'inden sonra. `File` ve `TariffDocument` parçasının gösterdiği dosya yalnız firmanın
 *      kendi klasöründeyse silinir (`ownedByCompany`); veritabanı bitince klasörün kendisi (`<depo>/<firma>`). Olmayan dosya
 *      sorun değildir. Disk hatasında kayıt bitmiş sayılmaz, bakım yeniden dener (veritabanı adımı o zaman boş geçer, klasör
 *      yeniden silinir).
 *    - Her şey (disk dahil) bitince `CompanyPurge.completedAt` yazılır, silme işleminin içinde (aynı kilit ve kayıt denetimi);
 *      kayıt kalır: gecikmiş olay ya da JIT firmayı yeniden kurmaz (silme sürerken de: kayıt ilk andan beri vardır).
 * Kaydın ilkeleri (migration 20261129090000; product-kit `memberProjectionSql` ile aynı): firma bağlamında okunur; yalnız olay
 * alıcısı ve yalnız bitmemiş, denenmemiş kayıt ekler (olay kapsamı + firma bağlamı); bitiş yalnız bitmemiş kaydı bitmiş yapar (bir
 * kez, geri alınmaz); deneme anı firma bağlamında yalnız bitmemiş kayıtta, kayıt bitmemiş kalır; bakım yalnız okur; silme yok. Uygulama rolü yalnız `completedAt` ve `attemptedAt` sütunlarını güncelleyebilir.
 *
 * Veri sıfırlama (`companyData.ts` `clearCompanyData`) bunun alt kümesidir: üyeleri, ayarları, kolileri ve yapay zekâ
 * kullanımını korur. Burada hepsi gider.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma, TX_DEFAULTS, withCompany, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { deleteStored } from '../lib/storage.ts';
import { ownedByCompany } from './fileCleanup.ts';

/**
 * Firma sütunu (`companyId`) taşıyan bütün tablolar, silme sırasıyla. RESTRICT ve NO ACTION anahtarları yüzünden sıra önemlidir:
 * fatura dosyadan ve taşıyıcıdan, satır sürümden, ölçüm/dosya/itiraz üyeden önce gider; tarife sürümden önce (`currentRevisionId`).
 * `CompanyPurge` listede yoktur (silme kaydı kalır). Yeni firma tablosu eklenince buraya da eklenmeli; firma sütunsuz çocuk tablo
 * ebeveynine `ON DELETE CASCADE` ile bağlanır (ya da listeye girer). `checkPurgeTables` listeyi veritabanının kataloğuyla
 * karşılaştırır (test/companyClose.test.ts `[]` bekler).
 */
export const PURGE_TABLES = [
  'Job',
  'InvoiceRecheck',
  'DisputeResultLine',
  'DisputeLine',
  'DisputeResult',
  'Dispute',
  'InvoiceLine',
  'Invoice',
  'File',
  'Measurement',
  'TariffDocument',
  'TariffImportDraft',
  'AiResultCache',
  'TariffVersion',
  'TariffZone',
  'TariffRate',
  'TariffOverflow',
  'TariffSurcharge',
  'Tariff',
  'TariffRevision',
  'Carrier',
  'BoxPreset',
  'AuditLog',
  'AiUsage',
  'AiCreditEntry',
  'Member',
] as const;

/** Birincil anahtarı `id` olmayan firma tabloları (parça seçimi birincil anahtarla). */
const PURGE_KEYS: Partial<Record<(typeof PURGE_TABLES)[number], string>> = { InvoiceRecheck: 'invoiceId' };
/** `RETURNING "path"`: parçanın dosyaları commit'ten sonra diskten silinir. */
const PATH_TABLES = new Set<string>(['File', 'TariffDocument']);

/**
 * Silme listesinin kataloğa göre sorunu (`checkPurgeTables`; product-kit `PurgeTableIssue` ile aynı kurallar):
 * - `not-listed`: şemada `"companyId"` sütunlu gerçek tablo (uygulama rolünün yetkisi olmasa da) listede yok;
 * - `missing-table`: listedeki tablo şemada yok;
 * - `missing-column`: anahtar, `"companyId"` ya da (dosya tablosunda) `"path"` sütunu yok;
 * - `no-delete-privilege`: uygulama rolü tablodan silemez;
 * - `no-delete-policy`: tabloda RLS açık ama firma bağlamında (`app.company_id`) silmeye izin veren ilke yok: silme hiçbir satır
 *   bulamaz, satırlar kalır;
 * - `blocking-reference`: listede olmayan tablo (ör. firma sütunsuz çocuk) silinen bir tabloya (listedeki, `Company` ya da onlarla
 *   CASCADE giden listede olmayan tablo; zincir kaç kat olursa olsun) silmeyi engelleyen bağla (NO ACTION, RESTRICT) bağlı: ebeveyn
 *   ya da firma satırı her turda yabancı anahtar hatasıyla silinemez. `SET NULL` / `SET DEFAULT` engellemez;
 * - `order`: listedeki çocuk tablo silmeyi engelleyen bağla ebeveyninden (ya da ebeveynini CASCADE ile götüren tablodan) sonra;
 * - `cascade-returning`: dosya tablosu kendinden önce silinen ebeveyniyle CASCADE gider: dosyaları diskten silinmez.
 */
export type PurgeTableIssue = {
  table: string;
  issue:
    | 'not-listed'
    | 'missing-table'
    | 'missing-column'
    | 'no-delete-privilege'
    | 'no-delete-policy'
    | 'blocking-reference'
    | 'order'
    | 'cascade-returning';
  detail: string;
};

/** Silme kaydı: listeye girmez, `companyId` taşısa da (`not-listed` sayılmaz). */
const PURGE_RECORD_TABLE = 'CompanyPurge';

/**
 * Silme listesini (`PURGE_TABLES`) veritabanı kataloğuyla (pg_catalog) karşılaştırır; sorun yoksa `[]` (test/companyClose.test.ts).
 * Yalnız gerçek tablolar (görünüm ve bölüm sayılmaz). Yetki ve ilkenin rolü `role` (varsayılan bağlantının rolü, yani uygulama
 * rolü). `tables` ve `query` testin bozuk liste ve geçici tabloyla denemesi için.
 */
export async function checkPurgeTables(
  opts: {
    tables?: readonly string[];
    query?: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
    role?: string;
  } = {},
): Promise<PurgeTableIssue[]> {
  const tables = opts.tables ?? PURGE_TABLES;
  const query = opts.query ?? ((sql: string, params: unknown[]) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params));
  const issues: PurgeTableIssue[] = [];
  const order = new Map(tables.map((t, i) => [t, i]));
  const rels = (await query(
    `SELECT c.relname::text AS "name", has_table_privilege(COALESCE($2::text, current_user::text), c.oid, 'DELETE') AS "canDelete",
            c.relrowsecurity AS "rls",
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polcmd IN ('d', '*') AND p.polpermissive
                       AND (0::oid = ANY (p.polroles)
                            OR (SELECT r.oid FROM pg_roles r WHERE r.rolname = COALESCE($2::text, current_user::text)) = ANY (p.polroles))
                       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS "companyDelete",
            ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS "cols"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    ['deciship', opts.role ?? null],
  )) as { name: string; canDelete: boolean; rls: boolean; companyDelete: boolean; cols: string[] }[];
  const relByName = new Map(rels.map((r) => [r.name, r]));
  for (const r of rels) {
    if (r.cols.includes('companyId') && !order.has(r.name) && r.name !== PURGE_RECORD_TABLE) {
      issues.push({ table: r.name, issue: 'not-listed', detail: 'table with a "companyId" column is not in PURGE_TABLES' });
    }
  }
  for (const t of tables) {
    const r = relByName.get(t);
    if (!r) {
      issues.push({ table: t, issue: 'missing-table', detail: `no table "deciship"."${t}"` });
      continue;
    }
    const key = PURGE_KEYS[t as PurgeTable] ?? 'id';
    for (const c of new Set([key, 'companyId', ...(PATH_TABLES.has(t) ? ['path'] : [])])) {
      if (!r.cols.includes(c)) issues.push({ table: t, issue: 'missing-column', detail: `column "${c}" is missing` });
    }
    if (!r.canDelete) issues.push({ table: t, issue: 'no-delete-privilege', detail: 'the application role cannot delete from this table' });
    if (r.rls && !r.companyDelete) {
      issues.push({ table: t, issue: 'no-delete-policy', detail: 'row level security is on but no policy lets the company context delete rows' });
    }
  }
  // Bu şemadaki tablolara bağlanan bütün yabancı anahtarlar (çocuk hangi şemada olursa olsun).
  const fks = (await query(
    `SELECT ch.relname::text AS "child", chn.nspname::text AS "childSchema", p.relname::text AS "parent", con.confdeltype::text AS "action",
            con.conname::text AS "name"
       FROM pg_constraint con
       JOIN pg_class ch ON ch.oid = con.conrelid JOIN pg_namespace chn ON chn.oid = ch.relnamespace
       JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE con.contype = 'f' AND pn.nspname = $1
      ORDER BY 2, 1, 5`,
    ['deciship'],
  )) as { child: string; childSchema: string; parent: string; action: string; name: string }[];
  // Her tablonun silindiği sıra: listedeki kendi yerinde, `Company` en son; listede olmayan CASCADE çocuğu en erken ebeveyniyle
  // (zincir boyunca, kaç kat olursa olsun).
  const deletedAt = new Map<string, number>([...order, ['Company', Number.POSITIVE_INFINITY]]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const fk of fks) {
      if (fk.action !== 'c' || fk.childSchema !== 'deciship' || fk.child === fk.parent || order.has(fk.child) || fk.child === 'Company') continue;
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
    const sameSchema = fk.childSchema === 'deciship';
    if (sameSchema && fk.child === fk.parent) continue;
    const childIndex = sameSchema ? order.get(fk.child) : undefined;
    if (childIndex === undefined) {
      // Listede olmayan çocuk: CASCADE ile ebeveyniyle gider, SET NULL / SET DEFAULT bağı boşaltır; başka yoldan daha önce
      // silinen çocuk da engellemez.
      if (!blocks(fk.action)) continue;
      const childAt = sameSchema ? deletedAt.get(fk.child) : undefined;
      if (childAt !== undefined && childAt < parentAt) continue;
      const via = order.has(fk.parent) || fk.parent === 'Company' ? '' : ' (deleted by CASCADE)';
      issues.push({
        table: sameSchema ? fk.child : `${fk.childSchema}.${fk.child}`,
        issue: 'blocking-reference',
        detail: `references "${fk.parent}"${via} without ON DELETE CASCADE (${fk.name}): add it to PURGE_TABLES or make it CASCADE`,
      });
      continue;
    }
    // Company en son silinir; listedeki her çocuk ondan önce gider.
    if (childIndex < parentAt) continue;
    if (fk.action === 'c') {
      if (PATH_TABLES.has(fk.child)) {
        issues.push({
          table: fk.child,
          issue: 'cascade-returning',
          detail: `cascades from "${fk.parent}" deleted earlier (${fk.name}): its files would stay on disk; list it before its parent`,
        });
      }
    } else if (blocks(fk.action)) {
      issues.push({ table: fk.child, issue: 'order', detail: `listed after "${fk.parent}" (${fk.name}): a child table must be deleted first` });
    }
  }
  return issues;
}

/** Parça başına satır: kısa işlem (kademeli `SET NULL` güncellemeleri dahil saniyeler). */
export const PURGE_BATCH_SIZE = 500;
/** Parça işleminin sınırları: büyük firmada da her işlem kısa; kilitler uzun tutulmaz. */
const PURGE_TX_TIMEOUT_MS = 120_000;
const PURGE_STATEMENT_TIMEOUT = '60s';
/** Tek çağrının (olay alıcısı ya da bakımın bir firması) süresi; dolunca `in-progress`, bakım sürdürür. */
export const PURGE_SLICE_MS = 2 * 60_000;

export type PurgeOptions = {
  /** parça başına satır (varsayılan `PURGE_BATCH_SIZE`) */
  batchSize?: number;
  /** bu çağrıda en çok bu kadar veritabanı işlemi (parça); testler yarıda kesmek için kullanır */
  maxBatches?: number;
  /** bu çağrının süresi, ms (varsayılan `PURGE_SLICE_MS`); bir parça başladıysa biter, sonrakine geçilmez */
  budgetMs?: number;
};

/**
 * Disk klasörü adı olarak güvenli firma kimliği (Hesap kimliği UUID'dir). Değilse klasöre dokunulmaz: nokta ve ayırıcı yok, en az
 * 16 karakter (deponun firma dışı klasörleri, ör. kur önbelleği `fx`, hiçbir zaman eşleşmez).
 */
const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export type PurgeLog = { warn: (obj: unknown, msg: string) => void; error?: (obj: unknown, msg: string) => void };

export type CompanyPurgeResult =
  /** silme kaydı yok: hiçbir şey yapılmadı */
  | { state: 'not-requested' }
  /** veritabanı silindi (ya da zaten silinmişti), disk temizliği tamam */
  | { state: 'completed'; rows: Record<string, number>; files: number }
  /** veritabanı silindi, disk temizliği bitmedi: bakım yeniden dener */
  | { state: 'files-pending'; rows: Record<string, number>; files: number }
  /** süre ya da parça sınırı doldu, veritabanı silmesi sürüyor: bakım kaldığı yerden sürdürür */
  | { state: 'in-progress'; rows: Record<string, number>; files: number };

/** Firmanın olaylarını ve silmesini sıraya koyar (aynı işlemde: olay alıcısı, JIT, kalıcı silme). */
export async function lockCompanyEvents(tx: Pick<Tx, '$executeRaw'>, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`company-events:${companyId}`}, 0))`;
}

/** Silme istenmiş mi (`CompanyPurge` kaydı). Çağıranın işleminde firma bağlamı olmalı. */
export async function isCompanyPurged(tx: Pick<Tx, '$queryRaw'>, companyId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS "one" FROM "CompanyPurge" WHERE "companyId" = ${companyId}`;
  return rows.length > 0;
}

type PurgeTable = (typeof PURGE_TABLES)[number];

/**
 * Silmenin tek işlemi: firma bağlamında, bugünkü kilit sırasıyla (firma kilidi, silme kaydı, firma satırı `FOR UPDATE`: olay dışı
 * yazımlar, ör. ayar ve kurulum, silmeyle yarışmasın). Silme kaydı yoksa `null`: hiçbir şey yapılmaz.
 */
async function inPurgeTx<T>(companyId: string, work: (tx: Tx) => Promise<T>): Promise<T | null> {
  return withCompany(companyId, () =>
    prisma.$transaction(
      async (tx) => {
        await lockCompanyEvents(tx, companyId);
        if (!(await isCompanyPurged(tx, companyId))) return null;
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${PURGE_STATEMENT_TIMEOUT}'`);
        await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${companyId} FOR UPDATE`;
        return work(tx);
      },
      { ...TX_DEFAULTS, timeout: PURGE_TX_TIMEOUT_MS },
    ),
  );
}

/** Tablonun en çok `limit` satırı (birincil anahtarla seçilir). Dosya tablolarında silinen satırların yolları döner. */
async function deleteBatch(tx: Tx, companyId: string, table: PurgeTable, limit: number): Promise<{ count: number; paths: string[] }> {
  const key = PURGE_KEYS[table] ?? 'id';
  // Tablo ve sütun adı yalnız yukarıdaki sabit listelerden; firma değeri ve sınır parametre. Dış silme de firma koşullu.
  const sql =
    `DELETE FROM "deciship"."${table}" WHERE "companyId" = $1 AND "${key}" IN ` +
    `(SELECT "${key}" FROM "deciship"."${table}" WHERE "companyId" = $1 LIMIT $2)`;
  if (PATH_TABLES.has(table)) {
    const deleted = await tx.$queryRawUnsafe<{ path: string }[]>(`${sql} RETURNING "path"`, companyId, limit);
    return { count: deleted.length, paths: deleted.map((r) => r.path) };
  }
  return { count: await tx.$executeRawUnsafe(sql, companyId, limit), paths: [] };
}

/**
 * Son adım: firma satırı kilitliyken bütün tablolar boşsa firma satırı silinir. Arada yazılmış satır varsa (ör. silme başlamadan
 * çalışan bir işin yazımı) o tablo döner, firma satırına dokunulmaz: tur baştan sürer.
 */
async function finishRows(tx: Tx, companyId: string): Promise<{ leftover: PurgeTable | null; company: number }> {
  for (const table of PURGE_TABLES) {
    const any = await tx.$queryRawUnsafe<{ one: number }[]>(`SELECT 1 AS "one" FROM "deciship"."${table}" WHERE "companyId" = $1 LIMIT 1`, companyId);
    if (any.length) return { leftover: table, company: 0 };
  }
  return { leftover: null, company: await tx.$executeRaw`DELETE FROM "Company" WHERE "id" = ${companyId}` };
}

/** Commit'i bitmiş parçanın dosyaları: yalnız firmanın kendi klasöründekiler. Hata atmaz. */
async function removeFiles(companyId: string, paths: string[], log?: PurgeLog): Promise<{ ok: boolean; files: number }> {
  // Güvensiz kimlikte diske hiç dokunulmaz (klasör adımı da atlanır, aşağıda).
  if (!SAFE_DIR.test(companyId)) return { ok: true, files: 0 };
  let ok = true;
  let files = 0;
  for (const rel of new Set(paths)) {
    // Başka firmanın ya da ortak klasörün dosyası silinmez (yalnız kayıt gider).
    if (!ownedByCompany(companyId, rel)) continue;
    try {
      await deleteStored(rel);
      files++;
    } catch (err) {
      ok = false;
      log?.warn({ err, companyId, path: rel }, 'company purge: stored file could not be removed');
    }
  }
  return { ok, files };
}

/** Veritabanı bittikten sonra: firmanın klasörü (kayda bağlı olmayan yetim ve geçici dosyalar da orada). Hata atmaz. */
async function removeCompanyFolder(companyId: string, log?: PurgeLog): Promise<boolean> {
  if (!SAFE_DIR.test(companyId)) {
    log?.error?.({ companyId }, 'company purge: unsafe company id, storage folder left untouched');
    return true;
  }
  const dir = path.resolve(env.storageDir, companyId);
  if (path.dirname(dir) !== path.resolve(env.storageDir)) return true;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log?.warn({ err, companyId }, 'company purge: storage folder could not be removed');
    return false;
  }
}

/**
 * Firmayı kalıcı siler (yukarıdaki düzenek). Silme kaydı yoksa hiçbir şey yapmaz. Tekrar çağrılabilir ve kaldığı yerden sürer:
 * biten tablolar boş geçer, disk temizliği yeniden denenir. Süre ya da parça sınırı dolarsa `in-progress` döner. Veritabanı
 * hatası atılır (kayıt bitmemiş kalır, bakım yeniden dener; o ana dek commit olan parçalar silinmiş kalır).
 */
export async function purgeCompany(companyId: string, log?: PurgeLog, opts: PurgeOptions = {}): Promise<CompanyPurgeResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? PURGE_BATCH_SIZE));
  const maxBatches = Math.max(1, opts.maxBatches ?? Number.POSITIVE_INFINITY);
  const deadline = Date.now() + (opts.budgetMs ?? PURGE_SLICE_MS);
  const rows: Record<string, number> = Object.fromEntries([...PURGE_TABLES, 'Company'].map((t) => [t, 0]));
  let batches = 0;
  let files = 0;
  let filesOk = true;
  // İlk parça her zaman çalışır: silme kaydı denetimi onunla yapılır.
  const mayContinue = () => batches === 0 || (batches < maxBatches && Date.now() < deadline);
  // Deneme anı, silmeden önce: düşen ya da yarıda kalan silme bakım sırasının sonuna geçer (`companyPurgeQueue`). Silmenin kendi kısa
  // işleminde (aynı kilit sırası ve kayıt denetimi, firma bağlamı; ilke `purge_attempt`, migration 20261129090000: yalnız bitmemiş
  // kayıt, bitmemiş kalır). İlk parçanın işleminden ayrı: o parça düşse de deneme anı kalır. Silme bitmişse satır yoktur.
  const attempt = await inPurgeTx(companyId, (tx) => tx.companyPurge.updateMany({ where: { companyId, completedAt: null }, data: { attemptedAt: new Date() } }));
  if (!attempt) return { state: 'not-requested' };

  for (;;) {
    // Bu turda silinen satır: tur hiç silmeden biterken kalan satır varsa (silme ilkesi ya da yetkisi eksik) yeniden denemek boşa
    // döner; hata yazılır, bakım sonraki turda yeniden dener (`checkPurgeTables` nedeni söyler).
    let deletedThisRound = 0;
    for (const table of PURGE_TABLES) {
      for (;;) {
        if (!mayContinue()) return { state: 'in-progress', rows, files };
        batches++;
        const batch = await inPurgeTx(companyId, (tx) => deleteBatch(tx, companyId, table, batchSize));
        if (!batch) return { state: 'not-requested' };
        rows[table]! += batch.count;
        deletedThisRound += batch.count;
        if (batch.paths.length) {
          const disk = await removeFiles(companyId, batch.paths, log);
          files += disk.files;
          filesOk &&= disk.ok;
        }
        if (batch.count < batchSize) break;
      }
    }
    if (!mayContinue()) return { state: 'in-progress', rows, files };
    batches++;
    const done = await inPurgeTx(companyId, (tx) => finishRows(tx, companyId));
    if (!done) return { state: 'not-requested' };
    rows.Company! += done.company;
    if (!done.leftover) break;
    if (deletedThisRound === 0) {
      const msg = 'company purge: rows are left that this round could not delete; see checkPurgeTables';
      if (log?.error) log.error({ companyId, table: done.leftover }, msg);
      else log?.warn({ companyId, table: done.leftover }, msg);
      return { state: 'in-progress', rows, files };
    }
  }

  // Bir dosya silinemediyse de klasör denenir; bitmiş sayılmaz, bakım klasörü yeniden siler (veritabanı adımı boş geçer).
  const folderOk = await removeCompanyFolder(companyId, log);
  if (!filesOk || !folderOk) return { state: 'files-pending', rows, files };
  // Bitiş silme işleminin içinde: aynı kilit sırası ve kayıt denetimi (ilke `purge_complete`: yalnız bitmemiş kayıt bitmiş olur).
  const marked = await inPurgeTx(companyId, (tx) => tx.companyPurge.updateMany({ where: { companyId, completedAt: null }, data: { completedAt: new Date() } }));
  if (!marked) return { state: 'not-requested' };
  return { state: 'completed', rows, files };
}

/** Olay alıcısının başlattığı silmeler (testler ve kapanış bekleyebilsin). */
const inflight = new Set<Promise<unknown>>();

/** Olay commit'inden sonra arkada başlatır; hata günlüğe yazılır, bakım yeniden dener. */
export function startCompanyPurge(companyId: string, log?: PurgeLog): void {
  const run = purgeCompany(companyId, log)
    .catch((err: unknown) => log?.warn({ err, companyId }, 'company purge failed; maintenance will retry'))
    .finally(() => inflight.delete(run));
  inflight.add(run);
}

/** Süren silmelerin bitmesini bekler. */
export async function settleCompanyPurges(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
