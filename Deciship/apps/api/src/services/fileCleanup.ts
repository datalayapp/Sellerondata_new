/**
 * Fatura kaynak dosyalarının temizliği (Mesaj 7, plan §4.12). Veri kaybı riski taşır: her silme firma bağlamında, tek
 * işlemde, satır kilidi altında ve şu denetimlerden sonra yapılır.
 *
 * - Yalnız `INVOICE_SOURCE` dosyaları. Ölçüm fotoğraflarına bu dosyadan hiçbir yol yoktur (sorgular `kind` ile süzülür).
 * - Herhangi bir fatura (silinmiş dahil) `sourceFileId` ile gösteriyorsa önizleme olarak silinmez; son güvence
 *   `Invoice_sourceFileId_fkey ON DELETE RESTRICT`: silme 23503 ile düşerse yakalanır, hiçbir şey silinmez.
 * - Silinen faturanın dosyası yalnız onu gösteren bütün faturalar 30 günden uzun süredir silinmişse temizlenir; satır
 *   durur (`purgedAt`), dosya açılmaz (`routes/files.ts`).
 * - Süren işi (QUEUED/RUNNING, `refType = 'File'`) olan dosyaya dokunulmaz.
 * - Y91: süren PDF okumasına bağlanan üye önizleme dosyasını paylaşır (`File.holders`, `sharePreviewFile`). Kullanıcının
 *   vazgeçmesi paylaşılan dosyada yalnız kendini listeden çıkarır; dosya son tutan vazgeçince silinir.
 * - Disk: önce satır, sonra disk (`maintenance.ts` gerekçesi). Aynı yolu kullanan başka (temizlenmemiş) satır varsa ya da
 *   yol firmanın kendi klasöründe değilse disk dosyası silinmez, yalnız satır işlenir. Disk hatası günlüğe yazılır, turu düşürmez.
 *
 * Bakım (`runFileCleanup`) aday listesini `app.scope = 'maintenance'` ile yalnız okur (migration 20261114120000
 * `maintenance_preview_read`: alt sorgu Invoice ilkesine tabi, canlı faturanın dosyası listeye giremez); her aday
 * kendi firmasının bağlamında yukarıdaki denetimlerden yeniden geçer.
 */
import path from 'node:path';
import { Prisma, prisma, withCompany, withMaintenanceScope } from '../db.ts';
import { env } from '../env.ts';
import { absolutePath, deleteStored } from '../lib/storage.ts';

/** Faturaya bağlanmamış önizleme dosyası bu kadar dokunulmazsa silinir. Migration'daki `interval '24 hours'` ile aynı. */
export const PREVIEW_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Silinen faturanın kaynak dosyası bu kadar sonra diskten kalkar. Migration'daki `interval '30 days'` ile aynı. */
export const DELETED_INVOICE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bakım turu başına en çok aday (önizleme ve silinmiş fatura dosyası için ayrı ayrı). */
export const FILE_CLEANUP_BATCH = 500;

export type CleanupLog = { warn: (obj: unknown, msg: string) => void };
const consoleLog: CleanupLog = { warn: (obj, msg) => console.warn(msg, obj) };

/** Postgres 23503 (yabancı anahtar ihlali), Prisma'nın sardığı biçimlerle. */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: Record<string, unknown>; cause?: unknown; message?: unknown };
  if (e.code === 'P2003' || e.code === '23503') return true;
  const meta = e.meta ?? {};
  if (meta.code === '23503') return true;
  const adapter = meta.driverAdapterError as { cause?: { originalCode?: unknown; kind?: unknown } } | undefined;
  if (adapter?.cause?.originalCode === '23503' || adapter?.cause?.kind === 'ForeignKeyConstraintViolation') return true;
  return e.cause ? isForeignKeyViolation(e.cause) : false;
}

/**
 * Bakım işinin firma listesi (silinenlerin kalıcı temizliği, `services/deletedPurge.ts`): bakım kapsamında yalnız `Company`
 * okunur (migration 20261115090000, hatırlatmayla aynı yol), sıralı. Adaylar her firmanın kendi bağlamında aranır.
 * Kapalı firma listede yoktur: saklama süresinde kaydı tek tek silinmez.
 */
export async function maintenanceCompanyIds(): Promise<string[]> {
  const rows = await withMaintenanceScope(() => prisma.company.findMany({ where: { closedAt: null }, select: { id: true }, orderBy: { id: 'asc' } }));
  return rows.map((r) => r.id);
}

/** Disk dosyası yalnız firmanın kendi klasöründeyse silinir (`storeBuffer`: `<companyId>/<ay>/<uuid>.<uzantı>`). */
export function ownedByCompany(companyId: string, rel: string): boolean {
  try {
    const abs = absolutePath(rel);
    const dir = path.resolve(env.storageDir, companyId);
    return abs.startsWith(dir + path.sep);
  } catch {
    return false;
  }
}

type Removal = { path: string; companyId: string; fileId: string; shared: boolean };

/** İşlem bittikten sonra: disk dosyasını siler, hatayı günlüğe yazar (atmaz). */
async function removeFromDisk(r: Removal, log: CleanupLog): Promise<void> {
  if (r.shared) return;
  if (!ownedByCompany(r.companyId, r.path)) {
    log.warn({ fileId: r.fileId, companyId: r.companyId }, 'file path is outside the company folder: disk file kept');
    return;
  }
  try {
    await deleteStored(r.path);
  } catch (err) {
    log.warn({ err, fileId: r.fileId, companyId: r.companyId }, 'disk file could not be deleted (row processed; orphan file left)');
  }
}

/** Satırı işlemin sonuna kadar kilitler: içe aktarmanın `file.update` / fatura eklemesi ve başka temizlik sıraya girer. */
export async function lockFile(tx: Prisma.TransactionClient, companyId: string, fileId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "File" WHERE "id" = ${fileId} AND "companyId" = ${companyId} FOR UPDATE`;
  return rows.length > 0;
}

export async function activeJobOnFile(tx: Prisma.TransactionClient, companyId: string, fileId: string, exceptJobId?: string): Promise<boolean> {
  const n = await tx.job.count({
    where: { companyId, refType: 'File', refId: fileId, status: { in: ['QUEUED', 'RUNNING'] }, ...(exceptJobId ? { id: { not: exceptJobId } } : {}) },
  });
  return n > 0;
}

/** Aynı yolu kullanan, diski hâlâ gereken başka satır (her tür: fotoğraf dahil). */
async function pathShared(tx: Prisma.TransactionClient, fileId: string, rel: string): Promise<boolean> {
  return (await tx.file.count({ where: { path: rel, id: { not: fileId }, purgedAt: null } })) > 0;
}

export type DiscardOptions = {
  /** Yalnız `updatedAt` bundan eskiyse (bakım: 24 saat). */
  olderThan?: Date;
  /** Bu iş süren iş sayılmaz (işin kendi temizlik kancası). */
  exceptJobId?: string;
  /**
   * Y91: kullanıcının vazgeçmesi (`DELETE /invoices/preview/:fileId`). Önizleme paylaşılıyorsa (`holders` dolu) bu üye
   * listeden çıkar; başka tutan kaldıysa dosya korunur, kalmadıysa aşağıdaki denetimlerle silinir. Verilmezse (bakım, işin
   * temizlik kancası, aynı anda gelen yüklemenin artığı) liste dikkate alınmaz.
   */
  releasedBy?: string;
  log?: CleanupLog;
};

/**
 * Faturaya bağlanmamış önizleme dosyasını siler: önce satır (firma bağlamında, kilit altında, tek işlemde), sonra disk.
 * true: satır silindi. false: böyle bir önizleme yok ya da korundu (faturaya bağlı, süren işi var, taze, başka üye hâlâ
 * tutuyor). Disk hatası atılmaz, günlüğe yazılır. Açık bir işlemin içinden (aynı satırı tutan) çağrılmaz: kendi bağlantısını açar.
 */
export async function discardPreviewFile(companyId: string, fileId: string, o: DiscardOptions = {}): Promise<boolean> {
  const log = o.log ?? consoleLog;
  return withCompany(companyId, async () => {
    let removal: Removal | null;
    try {
      removal = await prisma.$transaction(async (tx) => {
        if (!(await lockFile(tx, companyId, fileId))) return null;
        const file = await tx.file.findFirst({
          where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', invoiceId: null, purgedAt: null, ...(o.olderThan ? { updatedAt: { lt: o.olderThan } } : {}) },
          select: { id: true, path: true, holders: true },
        });
        if (!file) return null;
        // NULL (göç 20261117121000 öncesi elle yazılmış satır) boş liste sayılır
        const holders: string[] = (file.holders as string[] | null) ?? [];
        if (o.releasedBy !== undefined && holders.length > 0) {
          // paylaşılan önizleme: yalnız tutan üye bırakabilir; bırakmış olanın yeniden çağrısı bir şey değiştirmez
          if (!holders.includes(o.releasedBy)) return null;
          const rest = holders.filter((h) => h !== o.releasedBy);
          if (rest.length > 0) {
            await tx.file.updateMany({ where: { id: fileId, companyId }, data: { holders: rest } });
            return null;
          }
          // son tutan bıraktı: bugünkü vazgeçme gibi (korumalar aşağıda; korunursa liste olduğu gibi kalır, bakım siler)
        }
        // silinmiş faturalar dahil: `invoiceId` boş olsa bile fatura bu dosyayı gösteriyorsa önizleme değildir
        if ((await tx.invoice.count({ where: { sourceFileId: fileId, companyId } })) > 0) {
          log.warn({ fileId, companyId }, 'preview file is referenced by an invoice: not deleted');
          return null;
        }
        if (await activeJobOnFile(tx, companyId, fileId, o.exceptJobId)) return null;
        const shared = await pathShared(tx, fileId, file.path);
        const deleted = await tx.file.deleteMany({ where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', invoiceId: null, purgedAt: null } });
        if (deleted.count !== 1) return null;
        return { path: file.path, companyId, fileId, shared };
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        log.warn({ err, fileId, companyId }, 'preview file not deleted: referenced by an invoice (RESTRICT)');
        return false;
      }
      throw err;
    }
    if (!removal) return false;
    await removeFromDisk(removal, log);
    return true;
  });
}

/**
 * Y91: aynı PDF'in süren okumasına bağlanan üye (`POST /invoices/preview` `joined: true`) işin önizleme dosyasını
 * kullanır; dosya artık onun da önizlemesidir. Liste boşsa yükleyen ve bu üye yazılır, doluysa üye eklenir (zaten
 * listedeyse ya da paylaşılmayan dosyanın yükleyeniyse değişmez). `updatedAt` tazelenir (bakımın 24 saati bağlanandan
 * başlar). Tek SQL: aynı anda iki bağlanma birbirini ezmez. Dosya faturaya bağlanmış, temizlenmiş ya da yoksa hiçbir şey
 * yapılmaz. Vazgeçme (`discardPreviewFile` `releasedBy`) listeden çıkarır. Veritabanı hatası çağırana geçer.
 * Bilinen dar yarış: yükleyen tam bu anda vazgeçip satırı silerse güncelleme boşa gider (bağlanan sonra 404 görür).
 */
export async function sharePreviewFile(companyId: string, jobId: string, memberId: string): Promise<void> {
  await withCompany(companyId, async () => {
    const job = await prisma.job.findFirst({ where: { id: jobId, companyId, kind: 'INVOICE_PDF_READ', refType: 'File' }, select: { refId: true } });
    if (!job?.refId) return;
    await prisma.$executeRaw`
      UPDATE "File"
      SET "holders" = CASE WHEN cardinality(COALESCE("holders", ARRAY[]::text[])) = 0 THEN ARRAY["createdById", ${memberId}]::text[]
                           ELSE array_append("holders", ${memberId}::text) END,
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${job.refId} AND "companyId" = ${companyId} AND "kind" = 'INVOICE_SOURCE' AND "invoiceId" IS NULL AND "purgedAt" IS NULL
        AND NOT (${memberId}::text = ANY(COALESCE("holders", ARRAY[]::text[])))
        AND NOT (cardinality(COALESCE("holders", ARRAY[]::text[])) = 0 AND "createdById" = ${memberId}::text)`;
  });
}

/** Üyenin hâlâ tuttuğu önizleme: paylaşılmıyorsa yükleyen, paylaşılıyorsa listedeki üye (Y91; vazgeçen listede yoktur). */
const heldBy = (memberId: string): Prisma.FileWhereInput => ({
  OR: [{ createdById: memberId, holders: { isEmpty: true } }, { holders: { has: memberId } }],
});

/**
 * Y95: açık önizlemede çalışan kullanıcının dosyası 24 saat dolunca silinmesin. Panel, önizleme açıkken ve kullanıcı
 * sayfada bir şey yaptıysa ara ara çağırır (`POST /invoices/preview/:fileId/keep`); `updatedAt` tazelenir. Sekmesi açık
 * kalıp hiçbir şey yapılmayan önizleme tazelenmez, bakım 24 saat sonra yine siler. Yalnız üyenin tuttuğu, faturaya
 * bağlanmamış, temizlenmemiş önizleme; true: tazelendi. Bakım silmesiyle yarış: ikisi de aynı satırı yazar; silme kilit
 * altında `updatedAt`'i yeniden denetler (`discardPreviewFile` `olderThan`), önce tazeleme biterse dosya kalır.
 */
export async function keepPreviewFile(companyId: string, fileId: string, memberId: string): Promise<boolean> {
  return withCompany(companyId, async () => {
    const r = await prisma.file.updateMany({
      where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', invoiceId: null, purgedAt: null, ...heldBy(memberId) },
      data: { updatedAt: new Date() },
    });
    return r.count > 0;
  });
}

/** E2: kaldığı yerden sürdürülebilecek PDF önizlemesi. `reading`: okuma sürüyor; `ready`: okundu, içe aktarılmadı. */
export type ResumablePreview = { fileId: string; name: string; size: number; jobId: string; status: 'reading' | 'ready'; updatedAt: Date };
/** Bantta en çok bu kadar önizleme (en yenisi önce). */
export const RESUMABLE_PREVIEW_MAX = 5;

/**
 * E2 (sürdürme bandı): üyenin okunmuş ya da okunmakta olan, henüz içe aktarılmamış PDF önizlemeleri. Bakımın sileceği
 * (24 saattir dokunulmamış) önizleme listelenmez; faturanın gösterdiği (silinmiş fatura dahil), işi başarısız ya da
 * durdurulmuş olan da. Salt okunur; hiçbir şey yazmaz.
 */
export async function listResumablePreviews(companyId: string, memberId: string, now: number = Date.now()): Promise<ResumablePreview[]> {
  return withCompany(companyId, async () => {
    const files = await prisma.file.findMany({
      where: {
        companyId,
        kind: 'INVOICE_SOURCE',
        mime: 'application/pdf',
        invoiceId: null,
        purgedAt: null,
        updatedAt: { gte: new Date(now - PREVIEW_FILE_TTL_MS) },
        ...heldBy(memberId),
      },
      select: { id: true, originalName: true, size: true, updatedAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: RESUMABLE_PREVIEW_MAX * 2,
    });
    if (!files.length) return [];
    const ids = files.map((f) => f.id);
    const referenced = new Set(
      (await prisma.invoice.findMany({ where: { companyId, sourceFileId: { in: ids } }, select: { sourceFileId: true } })).map((i) => i.sourceFileId),
    );
    const jobs = await prisma.job.findMany({
      where: { companyId, kind: 'INVOICE_PDF_READ', refType: 'File', refId: { in: ids } },
      select: { id: true, refId: true, status: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const latest = new Map<string, { id: string; status: string }>();
    for (const j of jobs) if (j.refId && !latest.has(j.refId)) latest.set(j.refId, j);
    const out: ResumablePreview[] = [];
    for (const f of files) {
      const job = latest.get(f.id);
      if (!job || referenced.has(f.id)) continue;
      const status = job.status === 'SUCCEEDED' ? 'ready' : job.status === 'QUEUED' || job.status === 'RUNNING' ? 'reading' : null;
      if (!status) continue;
      out.push({ fileId: f.id, name: f.originalName ?? 'invoice.pdf', size: f.size, jobId: job.id, status, updatedAt: f.updatedAt });
      if (out.length >= RESUMABLE_PREVIEW_MAX) break;
    }
    return out;
  });
}

/**
 * Silinen faturanın kaynak dosyasını diskten kaldırır, satır kalır (`purgedAt = now`). Yalnız onu gösteren bütün faturalar
 * `now - 30 gün`den önce silinmişse; canlı ya da yakında silinmiş fatura, süren iş varsa dokunulmaz. true: işaretlendi.
 */
export async function purgeInvoiceSourceFile(companyId: string, fileId: string, now: number = Date.now(), o: { log?: CleanupLog } = {}): Promise<boolean> {
  const log = o.log ?? consoleLog;
  const cutoff = new Date(now - DELETED_INVOICE_FILE_TTL_MS);
  return withCompany(companyId, async () => {
    const removal = await prisma.$transaction(async (tx): Promise<Removal | null> => {
      if (!(await lockFile(tx, companyId, fileId))) return null;
      const file = await tx.file.findFirst({ where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', purgedAt: null }, select: { id: true, path: true } });
      if (!file) return null;
      const expired = await tx.invoice.count({ where: { sourceFileId: fileId, companyId, deletedAt: { lt: cutoff } } });
      if (expired === 0) return null;
      // canlı ya da 30 günü dolmamış silinmiş fatura bu dosyayı gösteriyorsa dokunulmaz
      const keep = await tx.invoice.count({ where: { sourceFileId: fileId, companyId, OR: [{ deletedAt: null }, { deletedAt: { gte: cutoff } }] } });
      if (keep > 0) return null;
      if (await activeJobOnFile(tx, companyId, fileId)) return null;
      const shared = await pathShared(tx, fileId, file.path);
      const marked = await tx.file.updateMany({
        where: { id: fileId, companyId, kind: 'INVOICE_SOURCE', purgedAt: null },
        data: { purgedAt: new Date(now), preview: Prisma.DbNull },
      });
      if (marked.count !== 1) return null;
      return { path: file.path, companyId, fileId, shared };
    });
    if (!removal) return false;
    await removeFromDisk(removal, log);
    return true;
  });
}

export type FileCleanupResult = { previews: number; purged: number };

/**
 * Y94: tur başına aday sınırı (`FILE_CLEANUP_BATCH`) korunan adaylarla (faturanın gösterdiği önizleme, süren işi olan
 * dosya, canlı faturanın da gösterdiği dosya) dolarsa sonraki adaylar sonsuza dek beklemesin: liste sırasında (önizleme
 * `updatedAt`, temizlik `createdAt`, eşitlikte `id`) kalınan yer saklanır, sonraki tur oradan sürer. Sayfa dolmadıysa
 * liste bitmiştir: imleç sıfırlanır, sonraki tur baştan başlar (korunanlar o turda yeniden denenir). Korunanlar sorguda
 * elenemez: bakım kapsamı canlı faturayı ve süren işi göremez (göç 20261114120000). İmleç süreç içidir; süreç yeniden
 * başlarsa baştan başlar (en kötü bir tur kayıp).
 */
export type FileCleanupCursor = { previews: CursorAt; purges: CursorAt };
const processCursor: FileCleanupCursor = { previews: null, purges: null };

type CursorAt = { at: Date; id: string } | null;
const afterUpdated = (c: CursorAt): Prisma.FileWhereInput => (c ? { OR: [{ updatedAt: { gt: c.at } }, { updatedAt: c.at, id: { gt: c.id } }] } : {});
const afterCreated = (c: CursorAt): Prisma.FileWhereInput => (c ? { OR: [{ createdAt: { gt: c.at } }, { createdAt: c.at, id: { gt: c.id } }] } : {});

export type FileCleanupOptions = {
  /** Tur başına aday (varsayılan `FILE_CLEANUP_BATCH`). */
  batch?: number;
  /** Kalınan yer (varsayılan süreç içi tek imleç; testler kendi imlecini verir). */
  cursor?: FileCleanupCursor;
};

/** Saatlik bakımdan çağrılır (`maintenance.ts`). Tek adayın hatası turu düşürmez. */
export async function runFileCleanup(now: number = Date.now(), log: CleanupLog = consoleLog, o: FileCleanupOptions = {}): Promise<FileCleanupResult> {
  const previewCutoff = new Date(now - PREVIEW_FILE_TTL_MS);
  const batch = o.batch ?? FILE_CLEANUP_BATCH;
  const cursor = o.cursor ?? processCursor;
  // Dar yol yalnız okur: süzgeç ilkeyle aynı, kod tarafı da (iki saat farkına karşı) aynı süreyi ister.
  const { previews, purges } = await withMaintenanceScope(async () => ({
    previews: await prisma.file.findMany({
      // Kapalı firmanın dosyası saklama süresinde silinmez (bakım kapsamı firma satırını okuyabilir).
      where: { kind: 'INVOICE_SOURCE', invoiceId: null, purgedAt: null, updatedAt: { lt: previewCutoff }, company: { closedAt: null }, ...afterUpdated(cursor.previews) },
      select: { id: true, companyId: true, updatedAt: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: batch,
    }),
    purges: await prisma.file.findMany({
      where: { kind: 'INVOICE_SOURCE', invoiceId: { not: null }, purgedAt: null, company: { closedAt: null }, ...afterCreated(cursor.purges) },
      select: { id: true, companyId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batch,
    }),
  }));
  const lastPreview = previews.length === batch ? previews[previews.length - 1] : undefined;
  const lastPurge = purges.length === batch ? purges[purges.length - 1] : undefined;
  cursor.previews = lastPreview ? { at: lastPreview.updatedAt, id: lastPreview.id } : null;
  cursor.purges = lastPurge ? { at: lastPurge.createdAt, id: lastPurge.id } : null;
  const result: FileCleanupResult = { previews: 0, purged: 0 };
  for (const f of previews) {
    try {
      if (await discardPreviewFile(f.companyId, f.id, { olderThan: previewCutoff, log })) result.previews++;
    } catch (err) {
      log.warn({ err, fileId: f.id }, 'preview file cleanup failed');
    }
  }
  for (const f of purges) {
    try {
      if (await purgeInvoiceSourceFile(f.companyId, f.id, now, { log })) result.purged++;
    } catch (err) {
      log.warn({ err, fileId: f.id }, 'deleted invoice file cleanup failed');
    }
  }
  return result;
}
