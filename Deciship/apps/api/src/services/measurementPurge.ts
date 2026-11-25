/**
 * Silinmiş ölçümün elle kalıcı silinmesi (kullanıcı kararı 2026-11-13; `Deciship/SPEC.md` §10.1 ve §5.13, KARARLAR
 * "Silinenlerin kalıcı silinmesi"). VERİ SİLER, geri gelmez (yedekten başka yolu yok).
 *
 * Ne silinir: silinmiş (`deletedAt` dolu) ve zincirin en son sürümü olan ölçüm, ona yerini bırakmış bütün eski sürümler
 * (zincirin tamamı) ve bu sürümlere bağlı bütün `File` satırları. Disk dosyası işlem kapandıktan sonra ve yalnız onu
 * gösteren başka satır kalmadıysa (başka ölçümün, fotoğraf olmayan kaydın satırı) ve yol firmanın klasöründeyse silinir;
 * bulunamayan dosya sorun sayılmaz. Disk hatası yetim dosya bırakır (`storage:orphans` görür), veri tutarlı kalır.
 *
 * Ne zaman silinmez (30 günlük fotoğraf temizliğiyle AYNI koruma, `deletedPurge.ts` `chainProtectedSql`; kuşkuda silinmez):
 * - `DISPUTE`: zincirin bir sürümünü gönderim anındaki kanıt olarak gösteren ya da zincirin bir takip no'sunu taşıyan itiraz
 *   satırı (her tur, geri çekilmiş dahil) var ya da zincire bağlı fatura satırı bir itiraz satırına bağlı;
 * - `DECIDED_LINE`: zincirin bir sürümüne bağlı fatura satırında karar var ("İtiraz listesinde" ya da "Uyumlu"; faturası
 *   silinmiş olsa da).
 * İkisi birden varsa `DISPUTE` söylenir.
 *
 * Fatura satırları: zincire bağlı kalan satırlar (yukarıdaki korumadan sonra hepsi kararsız ve itirazsız) ölçümden
 * ayrılır (`measurementId = null`, elle eşleştirme `measurementPinned = false`). Silinmemiş faturaları için aynı işlemde
 * yeniden hesap işareti (`InvoiceRecheck`) yazılır; işlem kapanınca faturalar sabit dayanakla, yalnız açık satırlarla
 * (`pinned` + `open`, neden `MEASUREMENT`) yeniden hesaplanır ve işaret silinir. Hesap düşerse işaret kalır, bakım ve
 * tarama tamamlar (para sonucu ölçümsüz hâline kendiliğinden gelir). Böylece hiçbir satırın sonucu silinmiş ölçüme
 * dayanmaz. Silinmiş faturanın satırı hesaplanmaz, yalnız bağı kalkar.
 *
 * Kilit sırası (eşzamanlı geri yükleme, düzeltme, içe aktarma, yeniden hesap, itiraz ve 30 günlük temizlikle yarış):
 * 1. içe aktarmanın paylaşımlı kilidi (`lockImportsShared`, işlemin ilk kilidi: içe aktarma ölçüm satırına yazar);
 * 2. zincirin takip no'larının danışma kilidi (`lockTracking`: geri yükleme, yeniden ölçüm ve düzeltme ile aynı sıra);
 * 3. zincirin dosya satırları, sonra ölçüm satırları `FOR UPDATE` (30 günlük fotoğraf temizliğiyle aynı sıra: dosya → ölçüm);
 *    kilit altında ölçüm yeniden sınanır (hâlâ silinmiş ve en son sürüm mü, zincir aynı mı);
 * 4. zincire bağlı ya da zincirin takip no'sunu taşıyan fatura satırlarının faturaları, sonra o satırlar `FOR UPDATE`
 *    (yeniden hesapla aynı sıra: fatura → satır). Satır kilidi yeni itiraz satırının yabancı anahtar kilidini de bekletir:
 *    koruma kilit altında sınanır, bu arada gönderilen itiraz ya kapanmadan görülür ya da silmeden sonra (bağsız) yazılır.
 * Yeniden hesap satır sürümünü (`updatedAt`) fatura kilidi altında denetler: silmeden önce başlamış hesap bayat sayılır ve
 * yeniden yapılır.
 *
 * Denetim izi: `measurement.purge` (takip no, sürüm sayısı, fotoğraf sayısı, bağı kalkan satır sayısı, silinme anı).
 * Eski denetim kayıtlarına dokunulmaz. Firma bağlamında (FORCE RLS) çalışır: çağıran isteğin bağlamı.
 */
import { prisma, Prisma } from '../db.ts';
import { lockImportsShared, recompareInvoice } from './compare.ts';
import { chainProtectedSql, diskIfUnused, removeFromDisk, type PurgeLog, type Removal } from './deletedPurge.ts';
import { lockTracking } from './measurementLocks.ts';

/** Kalıcı silmeyi engelleyen koruma (API `409 MEASUREMENT_PROTECTED`, `details.reason`). */
export type PurgeBlock = 'DISPUTE' | 'DECIDED_LINE';

export type MeasurementPurgeOutcome =
  | { ok: true; trackingNo: string; versions: number; photos: number; unlinkedLines: number; recheckedInvoices: number }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_DELETED' | 'NOT_LATEST_VERSION' | 'CHANGED' | 'RECOMPARE_PENDING' }
  | { ok: false; code: 'PROTECTED'; reason: PurgeBlock };

/** İçe aktarma kilidi 120 sn'ye dek bekleyebilir (`compare.ts` IMPORT_WAIT_TX ile aynı pay). */
const PURGE_TX = { maxWait: 10_000, timeout: 130_000 } as const;

type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Zincir: verilen sürüm ve ona yerini bırakmış bütün eski sürümler (kimlik, takip no). */
async function chainOf(db: RawDb, companyId: string, headId: string): Promise<{ id: string; trackingNo: string }[]> {
  return db.$queryRaw<{ id: string; trackingNo: string }[]>`
    WITH RECURSIVE ch("id", "trackingNo") AS (
      SELECT m."id", m."trackingNo" FROM "Measurement" m WHERE m."id" = ${headId} AND m."companyId" = ${companyId}
      UNION
      SELECT v."id", v."trackingNo" FROM "Measurement" v JOIN ch ON v."supersededById" = ch."id" WHERE v."companyId" = ${companyId}
    )
    SELECT "id", "trackingNo" FROM ch ORDER BY "id"`;
}

/**
 * Kalıcı silmeyi engelleyen koruma (yoksa null). Kural 30 günlük fotoğraf temizliğinin aynısı (`chainProtectedSql`).
 * `headId` zincirin en son sürümü olmalı. İşlem içinde (kilit altında) ya da ayrıntı ekranı için kilitsiz çağrılır.
 */
export async function measurementPurgeBlock(db: RawDb, companyId: string, headId: string): Promise<PurgeBlock | null> {
  const head = {
    id: Prisma.sql`${headId}::text`,
    trackingNo: Prisma.sql`(SELECT h."trackingNo" FROM "Measurement" h WHERE h."id" = ${headId} AND h."companyId" = ${companyId})`,
    trackingRaw: Prisma.sql`(SELECT h."trackingRaw" FROM "Measurement" h WHERE h."id" = ${headId} AND h."companyId" = ${companyId})`,
  };
  const [r] = await db.$queryRaw<{ dispute: boolean; decided: boolean }[]>`
    SELECT ${chainProtectedSql(companyId, head, 'dispute')} AS "dispute", ${chainProtectedSql(companyId, head, 'decided')} AS "decided"`;
  if (r?.dispute) return 'DISPUTE';
  if (r?.decided) return 'DECIDED_LINE';
  return null;
}

/**
 * Bekleyen işaretin değeri (`compare.ts` bumpPending ile aynı kural): verilen an, ya da satırdaki değer bundan yeniyse
 * ondan 1 ms sonrası. Süren eski hesabın işaret silmesi (yalnız aynı değerle) bu işareti boşa çıkaramaz.
 */
const bumpPending = (col: Prisma.Sql, at: Date) =>
  Prisma.sql`CASE WHEN ${col} IS NOT NULL AND ${col} >= ${at}::timestamp(3) THEN ${col} + interval '1 millisecond' ELSE ${at}::timestamp(3) END`;

type Done = { trackingNo: string; versions: number; photos: number; unlinkedLines: number; rechecks: { invoiceId: string; pendingAt: Date }[]; removals: Removal[] };

/**
 * Silinmiş ölçümü zinciri ve fotoğraflarıyla kalıcı siler (kural yukarıda). Firma bağlamında çağrılır. Veritabanı hatası
 * atılır (işlem geri alınmıştır, hiçbir şey silinmez); disk ve yeniden hesap hatası atılmaz, günlüğe yazılır.
 */
export async function purgeDeletedMeasurement(companyId: string, measurementId: string, userId: string | null, log: PurgeLog): Promise<MeasurementPurgeOutcome> {
  let done: Done | Exclude<MeasurementPurgeOutcome, { ok: true }>;
  try {
    done = await purgeTx(companyId, measurementId, userId);
  } catch (err) {
    // Kilitlenme (40P01): ör. sabitlenmiş satırın yeniden hesabı ya da elle eşleştirme aynı satırlara ters sırayla yazdı.
    // İşlem geri alındı, hiçbir şey silinmedi; bir kez yeniden denenir (koşullar kilit altında baştan sınanır).
    if (!isDeadlock(err)) throw err;
    log.warn({ err, measurementId, companyId }, 'measurement purge deadlocked; retrying once');
    done = await purgeTx(companyId, measurementId, userId);
  }
  if ('ok' in done) return done;
  return afterCommit(companyId, done, log);
}

/** Postgres kilitlenmesi (40P01), sürücü ve Prisma sarmalarının içinde de. */
export function isDeadlock(err: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (e: unknown, depth: number): boolean => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 6) return false;
    seen.add(e);
    const o = e as { code?: unknown; originalCode?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
    if (o.code === '40P01' || o.originalCode === '40P01' || o.code === 'P2034') return true;
    if (typeof o.message === 'string' && /40P01|deadlock detected/i.test(o.message)) return true;
    return walk(o.meta, depth + 1) || walk(o.cause, depth + 1);
  };
  return walk(err, 0);
}

async function purgeTx(companyId: string, measurementId: string, userId: string | null): Promise<Done | Exclude<MeasurementPurgeOutcome, { ok: true }>> {
  return prisma.$transaction(async (tx): Promise<Done | Exclude<MeasurementPurgeOutcome, { ok: true }>> => {
    await lockImportsShared(tx, companyId);
    const before = await chainOf(tx, companyId, measurementId);
    if (!before.length) return { ok: false, code: 'NOT_FOUND' };
    await lockTracking(tx, companyId, before.map((c) => c.trackingNo));
    const ids = before.map((c) => c.id);
    await tx.$queryRaw`SELECT "id" FROM "File" WHERE "companyId" = ${companyId} AND "measurementId" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
    const rows = await tx.$queryRaw<{ id: string; supersededById: string | null; deletedAt: Date | null; recomparePendingAt: Date | null }[]>`
      SELECT "id", "supersededById", "deletedAt", "recomparePendingAt" FROM "Measurement" WHERE "companyId" = ${companyId} AND "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
    const head = rows.find((r) => r.id === measurementId);
    if (!head) return { ok: false, code: 'NOT_FOUND' };
    if (head.supersededById) return { ok: false, code: 'NOT_LATEST_VERSION' };
    if (!head.deletedAt) return { ok: false, code: 'NOT_DELETED' };
    // Silinmiş son sürümün zinciri değişmez (yeni sürüm yalnız canlı son sürümden doğar); yine de kilit altında aynı mı.
    const chain = await chainOf(tx, companyId, measurementId);
    if (chain.length !== before.length || chain.some((c, i) => c.id !== before[i]!.id)) return { ok: false, code: 'CHANGED' };
    // Silmenin (ya da önceki bir değişikliğin) faturalarla karşılaştırması bitmedi: bağlı açık satır hâlâ bu ölçümün
    // rakamını taşıyor olabilir. Bağı koparıp sonucu hesaba bırakmak yerine reddedilir; karşılaştırma bitince yeniden denenir.
    if (rows.some((r) => r.recomparePendingAt)) return { ok: false, code: 'RECOMPARE_PENDING' };
    const trackings = [...new Set(chain.map((c) => c.trackingNo))];

    // Fatura satırları: önce faturaları, sonra satırlar (yeniden hesapla aynı sıra).
    const touched = await tx.$queryRaw<{ invoiceId: string }[]>`
      SELECT DISTINCT "invoiceId" FROM "InvoiceLine"
      WHERE "companyId" = ${companyId} AND ("measurementId" = ANY(${ids}::text[]) OR "trackingNo" = ANY(${trackings}::text[]))`;
    const invoiceIds = touched.map((r) => r.invoiceId).sort();
    const invoices = invoiceIds.length
      ? await tx.$queryRaw<{ id: string; deletedAt: Date | null }[]>`
          SELECT "id", "deletedAt" FROM "Invoice" WHERE "companyId" = ${companyId} AND "id" = ANY(${invoiceIds}::text[]) ORDER BY "id" FOR UPDATE`
      : [];
    const lines = await tx.$queryRaw<{ id: string; invoiceId: string; measurementId: string | null }[]>`
      SELECT "id", "invoiceId", "measurementId" FROM "InvoiceLine"
      WHERE "companyId" = ${companyId} AND ("measurementId" = ANY(${ids}::text[]) OR "trackingNo" = ANY(${trackings}::text[]))
      ORDER BY "id" FOR UPDATE`;

    // Koruma kilit altında (30 günlük temizlikle aynı SQL).
    const block = await measurementPurgeBlock(tx, companyId, measurementId);
    if (block) return { ok: false, code: 'PROTECTED', reason: block };

    // Zincire bağlı satırlar ölçümden ayrılır; silinmemiş faturalarına yeniden hesap işareti.
    const inChain = new Set(ids);
    const linked = lines.filter((l) => l.measurementId && inChain.has(l.measurementId));
    if (linked.length) {
      await tx.invoiceLine.updateMany({ where: { companyId, id: { in: linked.map((l) => l.id) } }, data: { measurementId: null, measurementPinned: false } });
    }
    const liveInvoice = new Set(invoices.filter((i) => !i.deletedAt).map((i) => i.id));
    const recheckIds = [...new Set(linked.map((l) => l.invoiceId))].filter((id) => liveInvoice.has(id)).sort();
    const at = new Date();
    const rechecks = recheckIds.length
      ? await tx.$queryRaw<{ invoiceId: string; pendingAt: Date }[]>`
          INSERT INTO "InvoiceRecheck" AS r ("invoiceId", "companyId", "pendingAt", "attempts")
          SELECT x, ${companyId}, ${at}::timestamp(3), 0 FROM unnest(${recheckIds}::text[]) AS x
          ON CONFLICT ("invoiceId") DO UPDATE SET "pendingAt" = ${bumpPending(Prisma.sql`r."pendingAt"`, at)}, "attempts" = 0
          RETURNING r."invoiceId", r."pendingAt"`
      : [];

    // Dosya satırları (kilit altında yeniden okunur), sonra ölçümler.
    const files = await tx.$queryRaw<{ id: string; path: string; purgedAt: Date | null }[]>`
      SELECT "id", "path", "purgedAt" FROM "File" WHERE "companyId" = ${companyId} AND "measurementId" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
    if (files.length) await tx.file.deleteMany({ where: { companyId, id: { in: files.map((f) => f.id) } } });
    const removed = await tx.measurement.deleteMany({ where: { companyId, id: { in: ids } } });
    if (removed.count !== ids.length) throw new Error(`measurement purge: ${removed.count}/${ids.length} versions deleted`);

    // Disk: aynı yolu gösteren başka temizlenmemiş satır kalmadıysa (başka ölçümün ya da kaydın dosyası silinmez).
    const removals: Removal[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      if (f.purgedAt || seen.has(f.path)) continue;
      seen.add(f.path);
      const disk = await diskIfUnused(tx, companyId, f.id, f.path);
      if (disk) removals.push(disk);
    }

    const trackingNo = chain.find((c) => c.id === measurementId)!.trackingNo;
    await tx.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'measurement.purge',
        entity: 'Measurement',
        entityId: measurementId,
        data: {
          trackingNo,
          versions: ids.length,
          photos: files.length,
          unlinkedLines: linked.length,
          deletedAt: head.deletedAt.toISOString(),
          versionIds: ids,
          invoiceIds: [...new Set(linked.map((l) => l.invoiceId))].sort(),
        },
      },
    });
    return { trackingNo, versions: ids.length, photos: files.length, unlinkedLines: linked.length, rechecks, removals };
  }, PURGE_TX);
}

async function afterCommit(companyId: string, done: Done, log: PurgeLog): Promise<MeasurementPurgeOutcome> {
  // İşlem kapandı: önce disk, sonra bağı kalkan satırların faturaları (işaret düşen hesapta kalır, bakım tamamlar).
  await removeFromDisk(done.removals, log);
  for (const r of done.rechecks) {
    try {
      await recompareInvoice(r.invoiceId, { basis: 'pinned', scope: 'open', cause: 'MEASUREMENT', patient: false });
      await prisma.invoiceRecheck.deleteMany({ where: { invoiceId: r.invoiceId, companyId, pendingAt: r.pendingAt } });
    } catch (err) {
      log.warn({ err, invoiceId: r.invoiceId, companyId }, 'recompare after measurement purge failed; pending flag kept for sweep');
    }
  }
  return { ok: true, trackingNo: done.trackingNo, versions: done.versions, photos: done.photos, unlinkedLines: done.unlinkedLines, recheckedInvoices: done.rechecks.length };
}
