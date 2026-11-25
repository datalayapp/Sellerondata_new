/**
 * Silinenlerin kalıcı temizliği (kullanıcı kararı 2026-11-12; bulgular 18-B2, 18-B3, 06-B3; bağımsız inceleme ile
 * daraltıldı). VERİ SİLER, geri gelmez. Kurallar `Deciship/SPEC.md` §5.13 "Silinenlerin kalıcı temizliği".
 *
 * Varsayılan KAPALI: `DELETED_INVOICE_PURGE_DAYS`, `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS` boşsa hiçbir şey silinmez
 * (`env.ts` `parsePurgeDays`; en az 7 gün; `off`/`0` kapatır). Canlıda `purge:preview` ile bakılıp 30 yazılarak açılır.
 * Süre veritabanı saatinden ölçülür (`now()`); uygulama saati kullanılmaz. Eski kaynak dosya temizliği (`fileCleanup.ts`,
 * sabit 30 gün) bu değişkenlerden bağımsızdır.
 *
 * Fatura: silinmesinden N gün sonra fatura, satırları (cascade), yeniden hesap işareti (`InvoiceRecheck`, cascade) ve yalnız
 * ona ait kaynak dosya kayıtları silinir; disk dosyaları işlem kapandıktan sonra. Silinmez:
 * - canlı fatura (silinmemiş), ne kadar eski olursa olsun;
 * - itiraz kaydı olan fatura: herhangi bir tur (etkin, geri çekilmiş, yerini bırakmış) ya da satırlarından birine bağlı
 *   itiraz satırı varsa. Biten itirazlı fatura da şimdilik kalır (ayrı karar);
 * - kaynak dosyası başka bir faturanın (canlı ya da silinmiş) da dosyasıysa dosya kaydı ve disk dosyası kalır;
 * - dosyasında süren iş (PDF okuma) varsa fatura bu turda atlanır.
 * Denetim izi (`AuditLog`) kalır; silme `invoice.purge` kaydı bırakır (fatura no, satır sayısı, silinme anı).
 *
 * Ölçüm fotoğrafı: YALNIZ SİLİNMİŞ ölçümün (zincirin en son sürümü silinmiş) kendi fotoğraf satırları. Ölçüm kaydı (ölçü,
 * ağırlık, zaman) ve eski sürümlerin fotoğraf satırları kalır (eski sürüm fotoğrafı ayrı karar; bugün süresiz). Kural tek
 * SQL'de (`photoCandidateSql`; aday listesi, kuru çalışma ve kilit altındaki denetim aynı sorgu). Bir satır ancak:
 * - ölçümü zincirin en son sürümüdür ve N günden uzun süredir silinmiştir (geri yüklenen ölçüm aday olmaktan çıkar);
 * - zincirin (aynı ölçümün bütün sürümleri) hiçbir sürümüne bağlı fatura satırı karar taşımıyor (`OPEN` dışı: itiraz
 *   listesi ya da uyumlu) ve itiraz satırına bağlı değil;
 * - hiçbir itiraz satırı (herhangi bir tur, geri çekilmiş dahil) zincirin bir sürümünü gönderim anındaki kanıt olarak
 *   göstermiyor (`DisputeLine.measurementId`) ve zincirin bir takip no'sunu taşımıyor (kuşkuda silme: doldurmada bağı
 *   bulunamayan eski satır dahil; karşılaştırmanın eşleşmesi gibi son 10 karakteri de, takip no ve ham barkoddan);
 * - aynı yolu gösteren başka her temizlenmemiş satır aynı zincirin fotoğraf satırıdır (fotoğraf olmayan kayıt ya da başka
 *   ölçüm gösteriyorsa satır kalır). Eski sürümle paylaşılan yolun diski kalır;
 * - ölçüme bağlanmamış fotoğraf satırı silinmez.
 * Disk dosyası yalnız onu gösteren son satır silinince ve yol firmanın kendi klasöründeyse silinir.
 *
 * Düzenek: firma listesi bakım kapsamında yalnız okunur (`fileCleanup.ts` `maintenanceCompanyIds`); adaylar her firmanın
 * kendi bağlamında (RLS) aranır, bakım kapsamı genişletilmez. Turda önce fotoğraf adayları alınır, sonra faturalar silinir,
 * sonra alınan fotoğraflar: fatura silinince kalkan koruma bir sonraki tura kalır (kuru çalışma gerçek turla aynı kümeyi
 * sayar). Tur başına sınır (`INVOICE_PURGE_BATCH`, `PHOTO_PURGE_BATCH`); imleç yalnız sınırın dolduğu firmada yazılır,
 * sonraki tur ondan sonrakinden başlar; düşen adaylar süreç içinde sona alınır. Her aday kendi işleminde: satırlar
 * kilitlenir, kural kilit altında yeniden sınanır, satırlar silinir, işlem kapanır; disk dosyaları ancak sonra silinir. Disk
 * hatası yetim dosya bırakır (`npm run storage:orphans` görür), veri tutarlı kalır.
 *
 * Geri dönüş: iki değişken boş ya da `off`. Silinmiş veri geri gelmez.
 *
 * Zincir koruması (`chainProtectedSql`) silinmiş ölçümün elle kalıcı silinmesiyle ortaktır (`measurementPurge.ts`,
 * kullanıcı kararı 2026-11-13): iki yol aynı ölçümü aynı nedenle korur.
 */
import { Prisma, prisma, withCompany } from '../db.ts';
import { env } from '../env.ts';
import { deleteStored } from '../lib/storage.ts';
import { activeJobOnFile, lockFile, maintenanceCompanyIds, ownedByCompany } from './fileCleanup.ts';

/** Bakım turu başına en çok fatura adayı (bir fatura binlerce satır silebilir). */
export const INVOICE_PURGE_BATCH = 100;
/** Bakım turu başına en çok fotoğraf adayı. */
export const PHOTO_PURGE_BATCH = 500;
/** Büyük faturanın satırları tek işlemde silinir: süre sınırı geniş. */
const PURGE_TX = { maxWait: 10_000, timeout: 300_000 } as const;

export const PHOTO_KINDS = ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER'] as const;
const KINDS_SQL = Prisma.raw(`('PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER')`);

export type PurgeLog = { warn: (obj: unknown, msg: string) => void };
const consoleLog: PurgeLog = { warn: (obj, msg) => console.warn(msg, obj) };

type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Kesim anı veritabanı saatinden: `now() - days gün` (UTC, sütunlarla aynı biçim). */
async function dbCutoff(db: RawDb, days: number): Promise<Date> {
  const [r] = await db.$queryRaw<{ cut: Date }[]>`SELECT ((now() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)) AS cut`;
  return r!.cut;
}

export type Removal = { companyId: string; fileId: string; path: string };

/** İşlem kapandıktan sonra: disk dosyalarını siler; hata yetim dosya bırakır, günlüğe yazılır (atmaz). */
export async function removeFromDisk(removals: Removal[], log: PurgeLog): Promise<number> {
  let removed = 0;
  for (const r of removals) {
    if (!ownedByCompany(r.companyId, r.path)) {
      log.warn({ fileId: r.fileId, companyId: r.companyId }, 'file path is outside the company folder: disk file kept');
      continue;
    }
    try {
      await deleteStored(r.path);
      removed++;
    } catch (err) {
      log.warn({ err, fileId: r.fileId, companyId: r.companyId }, 'disk file could not be deleted (row deleted; orphan file left, see storage:orphans)');
    }
  }
  return removed;
}

/** Satırı silinen dosya için disk adayı: aynı yolu gösteren başka temizlenmemiş satır kalmadıysa (işlemin içinde). */
export async function diskIfUnused(tx: Prisma.TransactionClient, companyId: string, fileId: string, rel: string): Promise<Removal | null> {
  if ((await tx.file.count({ where: { companyId, path: rel, purgedAt: null } })) > 0) return null;
  return { companyId, fileId, path: rel };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fatura
// ---------------------------------------------------------------------------------------------------------------------

/** İtiraz kaydı olmayan, `cut`'tan önce silinmiş faturalar (firma bağlamında). Kesin denetim kilit altında. */
function invoiceCandidateWhere(companyId: string, cut: Date): Prisma.InvoiceWhereInput {
  return { companyId, deletedAt: { lt: cut }, disputes: { none: {} }, lines: { none: { disputeLines: { some: {} } } } };
}

async function invoiceCandidates(companyId: string, days: number, take: number): Promise<string[]> {
  const cut = await dbCutoff(prisma, days);
  const rows = await prisma.invoice.findMany({
    where: invoiceCandidateWhere(companyId, cut),
    select: { id: true },
    orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
    take,
  });
  return rows.map((r) => r.id);
}

export type PurgeOptions = {
  /** Gün; verilmezse ortamdaki değer (`null` = kapalı). */
  days?: number | null;
  log?: PurgeLog;
};

/**
 * Silinen faturayı kalıcı siler (yukarıdaki kural). true: silindi. false: böyle bir fatura yok, süresi dolmadı, itiraz
 * kaydı var, süren iş var ya da kapalı. Veritabanı hatası atılır (işlem geri alınmıştır); disk hatası atılmaz.
 */
export async function purgeDeletedInvoice(companyId: string, invoiceId: string, o: PurgeOptions = {}): Promise<boolean> {
  const days = o.days !== undefined ? o.days : env.deletedInvoicePurgeDays;
  if (days == null) return false;
  const log = o.log ?? consoleLog;
  return withCompany(companyId, async () => {
    const removals = await prisma.$transaction(async (tx): Promise<Removal[] | null> => {
      // fatura satırı kilidi: itiraz gönderme, silme ve düzeltmelerle aynı satır (`disputes.ts` `lockInvoice`)
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} FOR UPDATE`;
      if (!locked.length) return null;
      const cut = await dbCutoff(tx, days);
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId, ...invoiceCandidateWhere(companyId, cut) },
        select: { id: true, invoiceNo: true, deletedAt: true, sourceFileId: true },
      });
      if (!inv?.deletedAt) return null;
      // faturaya ait dosya kayıtları: kaynak dosya ve faturaya bağlanmış diğer kaynak dosyalar
      const bound = await tx.file.findMany({ where: { companyId, invoiceId, kind: 'INVOICE_SOURCE' }, select: { id: true } });
      const fileIds = [...new Set([inv.sourceFileId, ...bound.map((f) => f.id)])].sort();
      for (const id of fileIds) await lockFile(tx, companyId, id);
      for (const id of fileIds) {
        if (await activeJobOnFile(tx, companyId, id)) {
          log.warn({ invoiceId, fileId: id, companyId }, 'deleted invoice not purged: a job is running on its file');
          return null;
        }
      }
      const lines = await tx.invoiceLine.count({ where: { companyId, invoiceId } });
      // satırlar, yeniden hesap işareti cascade ile; itiraz satırı yok (yukarıda denetlendi)
      const deleted = await tx.invoice.deleteMany({ where: { id: invoiceId, ...invoiceCandidateWhere(companyId, cut) } });
      if (deleted.count !== 1) return null;
      const out: Removal[] = [];
      let files = 0;
      for (const id of fileIds) {
        const f = await tx.file.findFirst({ where: { id, companyId, kind: 'INVOICE_SOURCE' }, select: { id: true, path: true } });
        if (!f) continue;
        // başka bir fatura (canlı ya da silinmiş) bu dosyayı gösteriyorsa kayıt ve disk kalır
        if ((await tx.invoice.count({ where: { companyId, sourceFileId: id } })) > 0) continue;
        await tx.file.deleteMany({ where: { id, companyId, kind: 'INVOICE_SOURCE' } });
        files++;
        const disk = await diskIfUnused(tx, companyId, id, f.path);
        if (disk) out.push(disk);
      }
      await tx.auditLog.create({
        data: {
          companyId,
          userId: null,
          action: 'invoice.purge',
          entity: 'Invoice',
          entityId: invoiceId,
          data: { invoiceNo: inv.invoiceNo, lines, files, deletedAt: inv.deletedAt.toISOString() },
        },
      });
      return out;
    }, PURGE_TX);
    if (!removals) return false;
    await removeFromDisk(removals, log);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Silinmiş ölçümün fotoğrafı
// ---------------------------------------------------------------------------------------------------------------------

/** Zincir korumasının nedeni: itiraz kaydı (kanıt, itirazdaki satır, takip no) ya da kararlı fatura satırı. */
export type ChainProtection = 'any' | 'dispute' | 'decided';

/**
 * Zincir koruması (kural yukarıda; fotoğraf temizliği ve elle kalıcı silme aynı SQL'i kullanır, `measurementPurge.ts`).
 * `head` zincirin en son sürümünün kimliği ve takip no'su (dış sorgunun sütunu ya da parametre). `ch` o sürüm ve ona
 * yerini bırakmış bütün eski sürümler. Sonuç `EXISTS (…)`: true ise zincir korunur, silinmez.
 * - `decided`: zincirin bir sürümüne bağlı fatura satırında karar var (`OPEN` dışı; faturası silinmiş olsa da);
 * - `dispute`: zincirin bir sürümüne bağlı fatura satırı itiraz satırına bağlı ya da bir itiraz satırı (her tur, geri
 *   çekilmiş dahil) zincirin bir sürümünü gönderim anındaki kanıt olarak gösteriyor ya da bir takip no'sunu taşıyor;
 * - `any`: ikisinden biri.
 */
export function chainProtectedSql(companyId: string, head: { id: Prisma.Sql; trackingNo: Prisma.Sql; trackingRaw: Prisma.Sql }, which: ChainProtection): Prisma.Sql {
  const decided = Prisma.sql`EXISTS (
            SELECT 1 FROM "InvoiceLine" l
            WHERE l."companyId" = ${companyId} AND l."measurementId" = ch."id" AND l."decision" <> 'OPEN')`;
  // Takip no: tam eşitlik ve karşılaştırmanın eşleşmesi gibi son 10 karakter (takip no ve ham barkoddan; kuşkuda silinmez).
  const dispute = Prisma.sql`EXISTS (
            SELECT 1 FROM "InvoiceLine" l
            WHERE l."companyId" = ${companyId} AND l."measurementId" = ch."id"
              AND EXISTS (SELECT 1 FROM "DisputeLine" d WHERE d."companyId" = ${companyId} AND d."invoiceLineId" = l."id"))
          OR EXISTS (
            SELECT 1 FROM "DisputeLine" d
            WHERE d."companyId" = ${companyId} AND (d."measurementId" = ch."id" OR d."trackingNo" = ch."trackingNo"
              OR right(d."trackingNo", 10) = right(ch."trackingNo", 10)
              OR right(d."trackingNo", 10) = right(upper(regexp_replace(ch."trackingRaw", '[[:space:]-]', '', 'g')), 10)))`;
  const cond = which === 'decided' ? decided : which === 'dispute' ? dispute : Prisma.sql`${decided} OR ${dispute}`;
  return Prisma.sql`EXISTS (
        WITH RECURSIVE ch("id", "trackingNo", "trackingRaw") AS (
          SELECT ${head.id}, ${head.trackingNo}, ${head.trackingRaw}
          UNION
          SELECT v."id", v."trackingNo", v."trackingRaw" FROM "Measurement" v JOIN ch ON v."supersededById" = ch."id" WHERE v."companyId" = ${companyId}
        )
        SELECT 1 FROM ch
        WHERE ${cond})`;
}

/**
 * Silinebilir fotoğraf satırları (kural yukarıda; tek kaynak). Zincir koruması `chainProtectedSql` (en son sürüm `m`).
 * `fileId`: yalnız o satır (kilit altındaki denetim). `count`: sayı ve bayt (kuru çalışma).
 */
function photoCandidateSql(companyId: string, cut: Date, o: { fileId?: string; take?: number; count?: boolean }): Prisma.Sql {
  const head = o.count ? Prisma.sql`SELECT count(*)::int AS n, COALESCE(sum(f."size"), 0)::float8 AS bytes` : Prisma.sql`SELECT f."id"`;
  return Prisma.sql`${head}
    FROM "File" f
    JOIN "Measurement" m ON m."id" = f."measurementId" AND m."companyId" = f."companyId"
    WHERE f."companyId" = ${companyId} AND f."kind" IN ${KINDS_SQL} AND f."purgedAt" IS NULL
      ${o.fileId ? Prisma.sql`AND f."id" = ${o.fileId}` : Prisma.empty}
      AND m."supersededById" IS NULL AND m."deletedAt" IS NOT NULL AND m."deletedAt" < ${cut}::timestamp(3)
      AND NOT ${chainProtectedSql(companyId, { id: Prisma.sql`m."id"`, trackingNo: Prisma.sql`m."trackingNo"`, trackingRaw: Prisma.sql`m."trackingRaw"` }, 'any')}
      AND NOT EXISTS (
        SELECT 1 FROM "File" x
        WHERE x."companyId" = ${companyId} AND x."path" = f."path" AND x."id" <> f."id" AND x."purgedAt" IS NULL
          AND NOT (x."kind" IN ${KINDS_SQL} AND x."measurementId" IS NOT NULL AND x."measurementId" IN (
            WITH RECURSIVE ch2("id") AS (
              SELECT m."id"
              UNION
              SELECT v."id" FROM "Measurement" v JOIN ch2 ON v."supersededById" = ch2."id" WHERE v."companyId" = ${companyId}
            )
            SELECT "id" FROM ch2)))
    ${o.count ? Prisma.empty : Prisma.sql`ORDER BY f."createdAt" ASC, f."id" ASC LIMIT ${o.take ?? 1}::int`}`;
}

async function photoCandidates(companyId: string, days: number, take: number): Promise<string[]> {
  const cut = await dbCutoff(prisma, days);
  const rows = await prisma.$queryRaw<{ id: string }[]>(photoCandidateSql(companyId, cut, { take }));
  return rows.map((r) => r.id);
}

/**
 * Silinmiş ölçümün bir fotoğraf satırını kalıcı siler (yukarıdaki kural, kilit altında). true: satır silindi (disk de,
 * son satırsa). false: aday değil ya da kapalı. Veritabanı hatası atılır; disk hatası atılmaz.
 */
export async function purgeMeasurementPhoto(companyId: string, fileId: string, o: PurgeOptions = {}): Promise<boolean> {
  const days = o.days !== undefined ? o.days : env.deletedMeasurementPhotoPurgeDays;
  if (days == null) return false;
  const log = o.log ?? consoleLog;
  return withCompany(companyId, async () => {
    const removal = await prisma.$transaction(async (tx): Promise<Removal | null | false> => {
      const [file] = await tx.$queryRaw<{ id: string; path: string; measurementId: string | null }[]>`
        SELECT "id", "path", "measurementId" FROM "File"
        WHERE "id" = ${fileId} AND "companyId" = ${companyId} AND "purgedAt" IS NULL AND "kind" IN ${KINDS_SQL} FOR UPDATE`;
      if (!file?.measurementId) return false;
      // ölçüm satırı: geri yükleme ve silme bu işlem bitene dek bekler; bağlı fatura satırları: karar ve itiraz da
      await tx.$queryRaw`SELECT "id" FROM "Measurement" WHERE "id" = ${file.measurementId} AND "companyId" = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "InvoiceLine" WHERE "companyId" = ${companyId} AND "measurementId" = ${file.measurementId} FOR SHARE`;
      // kural kilit altında, aday listesiyle aynı SQL, kesim anı yine veritabanı saatinden
      const cut = await dbCutoff(tx, days);
      const still = await tx.$queryRaw<{ id: string }[]>(photoCandidateSql(companyId, cut, { fileId }));
      if (!still.length) return false;
      const deleted = await tx.file.deleteMany({ where: { id: fileId, companyId, purgedAt: null, kind: { in: [...PHOTO_KINDS] } } });
      if (deleted.count !== 1) return false;
      return diskIfUnused(tx, companyId, fileId, file.path);
    }, PURGE_TX);
    if (removal === false) return false;
    if (removal) await removeFromDisk([removal], log);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Bakım turu ve kuru çalışma
// ---------------------------------------------------------------------------------------------------------------------

export type DeletedPurgeResult = { invoices: number; photos: number };
/**
 * Süreç içi tur durumu. `invoices`/`photos`: sınırın dolduğu son firma (kimlik sırası); sonraki tur ondan sonrakinden
 * başlar, sınır dolmadıysa boştur ve tur baştan başlar. `failed`: düşen aday kimlikleri: sonraki turlarda firmasının
 * listesinin sonuna alınır (aynı aday turu tıkamaz); başarıyla silinince listeden çıkar.
 */
export type PurgeCursor = { invoices: string | null; photos: string | null; failed: Set<string> };
const processCursor: PurgeCursor = { invoices: null, photos: null, failed: new Set() };
/** Düşen adayları sona almak için firma başına fazladan okunan aday sayısının üst sınırı. */
const FAILED_LOOKAHEAD = 100;

export type DeletedPurgeOptions = {
  invoiceDays?: number | null;
  photoDays?: number | null;
  invoiceBatch?: number;
  photoBatch?: number;
  /** Yalnız bu firmalar (testler); verilmezse bütün firmalar. */
  companyIds?: string[];
  cursor?: PurgeCursor;
};

function rotate(all: string[], after: string | null): string[] {
  if (!after) return all;
  const at = all.findIndex((id) => id > after);
  return at > 0 ? [...all.slice(at), ...all.slice(0, at)] : all;
}

/**
 * Firmaları imleçten sonra dolaşıp en çok `budget` aday toplar; düşmüş adaylar firmasının sonuna. İmleç yalnız sınırın
 * dolduğu firmada yazılır.
 */
async function collect(
  all: string[],
  after: string | null,
  budget: number,
  failed: Set<string>,
  list: (companyId: string, take: number) => Promise<string[]>,
  log: PurgeLog,
  what: string,
): Promise<{ picked: { companyId: string; id: string }[]; cursor: string | null }> {
  const picked: { companyId: string; id: string }[] = [];
  let cursor: string | null = null;
  for (const companyId of rotate(all, after)) {
    if (budget <= 0) break;
    let ids: string[];
    try {
      ids = await withCompany(companyId, () => list(companyId, budget + Math.min(failed.size, FAILED_LOOKAHEAD)));
    } catch (err) {
      log.warn({ err, companyId }, `${what}: candidate list failed`);
      continue;
    }
    const ordered = [...ids.filter((id) => !failed.has(id)), ...ids.filter((id) => failed.has(id))].slice(0, budget);
    for (const id of ordered) picked.push({ companyId, id });
    budget -= ordered.length;
    if (budget <= 0) cursor = companyId;
  }
  return { picked, cursor };
}

/** Saatlik bakımdan çağrılır (`maintenance.ts`). Tek adayın ya da firmanın hatası turu düşürmez. */
export async function runDeletedPurge(log: PurgeLog = consoleLog, o: DeletedPurgeOptions = {}): Promise<DeletedPurgeResult> {
  const invoiceDays = o.invoiceDays !== undefined ? o.invoiceDays : env.deletedInvoicePurgeDays;
  const photoDays = o.photoDays !== undefined ? o.photoDays : env.deletedMeasurementPhotoPurgeDays;
  const result: DeletedPurgeResult = { invoices: 0, photos: 0 };
  if (invoiceDays == null && photoDays == null) return result;
  const cursor = o.cursor ?? (o.companyIds ? { invoices: null, photos: null, failed: new Set<string>() } : processCursor);
  const all = [...(o.companyIds ?? (await maintenanceCompanyIds()))].sort();

  // 1. Fotoğraf adayları fatura silinmeden ÖNCE: fatura silinince kalkan koruma bu turda zincirleme silme açmaz.
  const photos =
    photoDays == null
      ? { picked: [], cursor: null }
      : await collect(all, cursor.photos, o.photoBatch ?? PHOTO_PURGE_BATCH, cursor.failed, (c, take) => photoCandidates(c, photoDays, take), log, 'measurement photo purge');
  cursor.photos = photos.cursor;

  // 2. Faturalar
  if (invoiceDays != null) {
    const invoices = await collect(all, cursor.invoices, o.invoiceBatch ?? INVOICE_PURGE_BATCH, cursor.failed, (c, take) => invoiceCandidates(c, invoiceDays, take), log, 'deleted invoice purge');
    cursor.invoices = invoices.cursor;
    for (const { companyId, id } of invoices.picked) {
      try {
        if (await purgeDeletedInvoice(companyId, id, { days: invoiceDays, log })) result.invoices++;
        cursor.failed.delete(id);
      } catch (err) {
        cursor.failed.add(id);
        log.warn({ err, invoiceId: id, companyId }, 'deleted invoice purge failed (rolled back; retried next run)');
      }
    }
  }

  // 3. Önceden alınan fotoğraflar (her biri kilit altında yeniden sınanır)
  for (const { companyId, id } of photos.picked) {
    try {
      if (await purgeMeasurementPhoto(companyId, id, { days: photoDays, log })) result.photos++;
      cursor.failed.delete(id);
    } catch (err) {
      cursor.failed.add(id);
      log.warn({ err, fileId: id, companyId }, 'measurement photo purge failed (rolled back; retried next run)');
    }
  }
  return result;
}

export type PurgePreviewRow = { companyId: string; invoices: number; invoicesKeptForDispute: number; photos: number; photoBytes: number };
export type PurgePreview = {
  invoiceDays: number | null;
  photoDays: number | null;
  companies: PurgePreviewRow[];
  totals: Omit<PurgePreviewRow, 'companyId'>;
};

/**
 * Kuru çalışma: bugün kaç fatura ve fotoğraf aday (bakımın aday sorgularının aynısı, aynı veritabanı saatiyle), itiraz
 * kaydı yüzünden kaç silinmiş fatura korunuyor. Gerçek tur fotoğraf adaylarını fatura silmeden önce aldığı için sayılar
 * gerçek turla aynıdır (tur sınırı içinde). Her firma salt okunur işlemde (`SET TRANSACTION READ ONLY`): yazan ifade 25006
 * ile düşer. Yalnız adayı olan firmalar listelenir.
 */
export async function previewDeletedPurge(o: { invoiceDays?: number | null; photoDays?: number | null; companyIds?: string[] } = {}): Promise<PurgePreview> {
  const invoiceDays = o.invoiceDays !== undefined ? o.invoiceDays : env.deletedInvoicePurgeDays;
  const photoDays = o.photoDays !== undefined ? o.photoDays : env.deletedMeasurementPhotoPurgeDays;
  const companies: PurgePreviewRow[] = [];
  const totals = { invoices: 0, invoicesKeptForDispute: 0, photos: 0, photoBytes: 0 };
  for (const companyId of o.companyIds ?? (await maintenanceCompanyIds())) {
    const row = await withCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const r: PurgePreviewRow = { companyId, invoices: 0, invoicesKeptForDispute: 0, photos: 0, photoBytes: 0 };
        if (invoiceDays != null) {
          const cut = await dbCutoff(tx, invoiceDays);
          r.invoices = await tx.invoice.count({ where: invoiceCandidateWhere(companyId, cut) });
          r.invoicesKeptForDispute = (await tx.invoice.count({ where: { companyId, deletedAt: { lt: cut } } })) - r.invoices;
        }
        if (photoDays != null) {
          const cut = await dbCutoff(tx, photoDays);
          const [c] = await tx.$queryRaw<{ n: number; bytes: number }[]>(photoCandidateSql(companyId, cut, { count: true }));
          r.photos = Number(c?.n ?? 0);
          r.photoBytes = Number(c?.bytes ?? 0);
        }
        return r;
      }),
    );
    if (row.invoices || row.invoicesKeptForDispute || row.photos) companies.push(row);
    totals.invoices += row.invoices;
    totals.invoicesKeptForDispute += row.invoicesKeptForDispute;
    totals.photos += row.photos;
    totals.photoBytes += row.photoBytes;
  }
  return { invoiceDays, photoDays, companies, totals };
}
