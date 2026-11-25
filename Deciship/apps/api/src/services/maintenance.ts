/**
 * Bakım işi: süresi dolan kayıtları tüm firmalarda temizler. Firma bağlamı yoktur; RLS altında dar yol açar:
 * `app.scope = 'maintenance'` ile yalnız süresi dolmuş satırlar görünür ve silinebilir (migration 20261107000000).
 * Başka tablo görünmez, taze satıra ve güncellemeye izin yoktur.
 *
 * Ayrıca yarıda kalmış ölçüm karşılaştırmalarını tamamlar (03-B4): dar yolda yalnız `RECOMPARE_STALE_MS`'den (2 dk) uzun
 * süredir bekleyen ölçümün kimliği ve firması okunur (migration 20261110120000, süre 20261119090000); karşılaştırma o
 * firmanın bağlamında çalışır.
 *
 * Temizlikten sonra itiraz süresi hatırlatmasını çalıştırır (Mesaj 14, `services/reminders.ts`): bakım kapsamında yalnız
 * firma listesi (`Company`, migration 20261115090000) okunur, adaylar her firmanın kendi bağlamında.
 *
 * Silinenlerin kalıcı temizliği (kullanıcı kararı 2026-11-12, `services/deletedPurge.ts`) de aynı yoldan: firma listesi,
 * sonra her firmanın bağlamında 30 günü dolan silinmiş fatura ve fotoğraf adayları. Bakım kapsamı genişletilmedi.
 *
 * Firmayı kapatma: kapalı firma yeniden hesap, dosya temizliği, silinenlerin temizliği, eski iş temizliği ve
 * hatırlatmada atlanır (her biri kendi sorgusunda). Yarıda kalmış kalıcı firma silmeleri (`org.purged`) burada yeniden denenir
 * (`services/companyPurge.ts`). Süreli geçici kayıtlar (olay kimliği, tarife taslağı ve PDF'i, yapay zekâ önbelleği) kapalı
 * firmada da süresi dolunca gider: kullanıcı verisi değil, geri açılınca yeniden üretilir.
 */
import fs from 'node:fs/promises';
import { prisma, withCompany, withMaintenanceScope } from '../db.ts';
import { absolutePath } from '../lib/storage.ts';
import { settleInvoiceRecheck, settleMeasurementRecompare } from './compare.ts';
import { pendingRecompareCandidates } from './measurementQueue.ts';
import { PURGE_SLICE_MS, purgeCompany, type PurgeOptions } from './companyPurge.ts';
import { runDeletedPurge } from './deletedPurge.ts';
import { runFileCleanup } from './fileCleanup.ts';
import { cleanupFinishedJobs } from './jobs/queue.ts';
import { emptyReminderResult, runDisputeReminders, type ReminderResult } from './reminders.ts';
import { DRAFT_TTL_MS } from './tariffImport.ts';
import { DOCUMENT_TTL_MS } from './tariffPdf.ts';

/** Olay tekrarına karşı. auth-kit en az 10 dakika ister; dağıtıcı yeniden denemelerinden çok daha uzun. */
export const PROCESSED_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Karşılaştırması bu kadar süredir bitmemiş ölçüm yarıda kalmış sayılır (sürmekte olanla yarışılmasın). Migration ile aynı
 * (Y93: 10 dk'dan 2 dk'ya, migration 20261119090000). İsteğin kendi yeniden denemeleri (1 + 5 sn) bundan çok kısa.
 */
export const RECOMPARE_STALE_MS = 2 * 60 * 1000;
/**
 * 07-B7: bekleyen işaretin (ölçüm `recompareAttempts`, fatura `InvoiceRecheck.attempts`) tarama ya da bakımda en çok deneme
 * sayısı. Sayılan yalnız tarama ve bakımın düşen denemesidir (isteğin kendi yeniden denemeleri sayılmaz). Geri çekilme:
 * `attempts` denemesi düşmüş işaret, yaşı `RECOMPARE_STALE_MS × 4^attempts`'i geçince yeniden alınır (2 dk, 8 dk, 32 dk,
 * ~2 sa, ~8,5 sa); 5. düşüşten sonra taramaya girmez, günlükte uyarılır. Yeni değişiklik (işaretin yeniden yazılması) sayacı
 * sıfırlar. Sürekli düşen işaret taramanın ilk sıralarını tıkamaz (eski tarama hep en eski 200'ü alıyordu).
 */
export const RECOMPARE_MAX_ATTEMPTS = 5;
export const recompareBackoffMs = (attempts: number) => RECOMPARE_STALE_MS * 4 ** attempts;

/**
 * Tarama ya da bakımdaki düşen denemeyi sayar (firma bağlamında; işaret bu arada yeniden yazıldıysa sayılmaz). Hak bitince
 * günlüğe uyarı. Sayım da düşerse (veritabanı yok) sessizce geçilir: işaret kalır, sonraki tur yine dener.
 */
export async function recordRecompareFailure(kind: 'measurement' | 'invoice', companyId: string, id: string, pendingAt: Date | null, log?: Log): Promise<void> {
  if (!pendingAt) return;
  try {
    const rows = await withCompany(companyId, () =>
      kind === 'measurement'
        ? prisma.$queryRaw<{ n: number }[]>`
            UPDATE "Measurement" SET "recompareAttempts" = "recompareAttempts" + 1
            WHERE "id" = ${id} AND "companyId" = ${companyId} AND "recomparePendingAt" = ${pendingAt}::timestamp(3) RETURNING "recompareAttempts" AS n`
        : prisma.$queryRaw<{ n: number }[]>`
            UPDATE "InvoiceRecheck" SET "attempts" = "attempts" + 1
            WHERE "invoiceId" = ${id} AND "companyId" = ${companyId} AND "pendingAt" = ${pendingAt}::timestamp(3) RETURNING "attempts" AS n`,
    );
    const n = rows[0]?.n ?? 0;
    if (n >= RECOMPARE_MAX_ATTEMPTS) {
      log?.warn({ kind, companyId, id, attempts: n }, 'recompare gave up after max attempts; pending flag kept, no longer swept');
    }
  } catch {
    // sayılamadı: işaret kalır
  }
}
const DOCUMENT_BATCH = 500;
const RECOMPARE_BATCH = 100;
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * `previews`: silinen unutulmuş önizleme dosyası; `purged`: diskten kaldırılan silinmiş fatura dosyası (Mesaj 7,
 * `services/fileCleanup.ts`); `jobs`: silinen bitmiş eski iş (`services/jobs/queue.ts` `cleanupFinishedJobs`);
 * `reminders`: itiraz süresi hatırlatmasının turu (`services/reminders.ts`; hata verirse boş sonuç).
 */
export type MaintenanceResult = {
  processedEvents: number;
  drafts: number;
  documents: number;
  aiCache: number;
  recompared: number;
  /** 07-B1: tamamlanan mükerrer yeniden hesabı (işaretli fatura) */
  rechecked: number;
  previews: number;
  purged: number;
  /** kalıcı silinen silinmiş fatura (satırları ve kaynak dosyasıyla; `services/deletedPurge.ts`) */
  purgedInvoices: number;
  /** kalıcı silinen ölçüm fotoğrafı satırı (silinmiş ölçüm ya da eski sürüm; ölçüm kaydı kalır) */
  purgedPhotos: number;
  jobs: number;
  reminders: ReminderResult;
  /** kalıcı silmesi bu turda tamamlanan firma (`org.purged`; olay alıcısının silmesi yarıda kaldıysa) */
  purgedCompanies: number;
};
/** `error`: yalnız hatırlatmanın anahtar uyuşmazlığı gibi elle düzeltilmesi gereken durumlar (fastify günlüğü ikisini de taşır). */
type Log = { warn: (obj: unknown, msg: string) => void; error?: (obj: unknown, msg: string) => void };

/** Bakım turu başına en çok bu kadar yarım firma silmesi (her biri kendi kısa parça işlemleriyle). */
const COMPANY_PURGE_BATCH = 20;
/**
 * Bakım turunun firma silmelerine ayrılan toplam süre. Her firma en çok `PURGE_SLICE_MS` alır (kalan süreyle sınırlı): çok büyük
 * bir firma turu saatlerce tutmaz, ondan sonraki firmalar da aynı turda ilerler; yarım kalan sonraki turda kaldığı yerden sürer.
 */
const COMPANY_PURGE_RUN_MS = 5 * 60_000;

export type CompanyPurgeRunOptions = PurgeOptions & {
  /** turun toplam süresi, ms (varsayılan `COMPANY_PURGE_RUN_MS`) */
  runBudgetMs?: number;
};

/**
 * Bakımın sıradaki bitmemiş silmeleri (bakım kapsamı yalnız `completedAt` boş kayıtları okur, migration 20261125090000): önce hiç
 * denenmemiş, sonra en uzun süredir denenmemiş (`attemptedAt`, her denemede yazılır; migration 20261128090000), eşitse eskiden
 * yeniye. Hep düşen silmeler sıranın başını tutup yenilerini bekletmez: denendikleri için sona geçerler.
 */
export async function companyPurgeQueue(take = COMPANY_PURGE_BATCH): Promise<string[]> {
  const rows = await withMaintenanceScope(() =>
    prisma.companyPurge.findMany({
      where: { completedAt: null },
      select: { companyId: true },
      orderBy: [{ attemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take,
    }),
  );
  return rows.map((r) => r.companyId);
}

/**
 * Saatlik bakım: bitmemiş silmeler `companyPurgeQueue` sırasıyla, her biri kendi firma bağlamında. Tek firmanın hatası turu
 * düşürmez. Tamamlanan firma sayısını döner.
 */
export async function runCompanyPurges(log?: Log, opts: CompanyPurgeRunOptions = {}): Promise<number> {
  const { runBudgetMs = COMPANY_PURGE_RUN_MS, budgetMs = PURGE_SLICE_MS, ...purgeOpts } = opts;
  const deadline = Date.now() + runBudgetMs;
  const pending = await companyPurgeQueue();
  let done = 0;
  for (const companyId of pending) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      if ((await purgeCompany(companyId, log, { ...purgeOpts, budgetMs: Math.min(budgetMs, left) })).state === 'completed') done++;
    } catch (err) {
      log?.warn({ err, companyId }, 'company purge failed; next maintenance run retries');
    }
  }
  return done;
}

export async function runMaintenance(now = Date.now(), log?: Log): Promise<MaintenanceResult> {
  const cleaned = await withMaintenanceScope(async () => {
    const before = (ttl: number) => ({ createdAt: { lt: new Date(now - ttl) } });
    const events = await prisma.processedEvent.deleteMany({ where: before(PROCESSED_EVENT_TTL_MS) });
    const drafts = await prisma.tariffImportDraft.deleteMany({ where: before(DRAFT_TTL_MS) });
    // yapay zekâ önbelleği: süresi kendi satırında (AI_CACHE_TTL_DAYS); dar yol yalnız süresi geçmişi gösterir (migration 20261113120000)
    const aiCache = await prisma.aiResultCache.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    const documents = await prisma.tariffDocument.findMany({ where: before(DOCUMENT_TTL_MS), select: { id: true, path: true }, take: DOCUMENT_BATCH });
    // Önce kayıt, sonra dosya: dosya silinemezse kayıt da kalsaydı bir sonraki turda boşuna denenirdi; yetim dosya zararsız.
    if (documents.length) await prisma.tariffDocument.deleteMany({ where: { id: { in: documents.map((d) => d.id) } } });
    for (const d of documents) await fs.rm(absolutePath(d.path), { force: true }).catch(() => undefined);
    return { processedEvents: events.count, drafts: drafts.count, documents: documents.length, aiCache: aiCache.count };
  });
  const pending = await pendingRecompareCandidates(now, RECOMPARE_BATCH);
  let recompared = 0;
  for (const m of pending.measurements) {
    try {
      await withCompany(m.companyId, () => settleMeasurementRecompare(m.companyId, m.id, m.recomparePendingAt));
      recompared++;
    } catch (err) {
      // işaret kalır, sonraki tur yeniden dener (07-B7: deneme sayılır, geri çekilir)
      log?.warn({ err, measurementId: m.id }, 'ölçüm karşılaştırması tamamlanamadı');
      await recordRecompareFailure('measurement', m.companyId, m.id, m.recomparePendingAt, log);
    }
  }
  // 07-B1: yarıda kalmış "Mükerrer" yeniden hesapları (fatura silme, başlık ya da takip no düzeltmesi)
  let rechecked = 0;
  for (const r of pending.invoices) {
    try {
      await withCompany(r.companyId, () => settleInvoiceRecheck(r.companyId, r.invoiceId, r.pendingAt));
      rechecked++;
    } catch (err) {
      log?.warn({ err, invoiceId: r.invoiceId }, 'mükerrer yeniden hesabı tamamlanamadı');
      await recordRecompareFailure('invoice', r.companyId, r.invoiceId, r.pendingAt, log);
    }
  }
  // Fatura kaynak dosyaları: adaylar dar yoldan okunur, her biri kendi firmasının bağlamında denetlenip silinir.
  // Geri dönüş (veri kaybı şüphesinde): bu çağrıyı kaldırmak yeter (plan §6 risk 1).
  const files = await runFileCleanup(now, log).catch((err) => {
    log?.warn({ err }, 'dosya temizliği başarısız');
    return { previews: 0, purged: 0 };
  });
  // Silinenlerin kalıcı temizliği (kullanıcı kararı 2026-11-12): süresi dolan silinmiş fatura ve silinmiş ölçümün fotoğrafları;
  // itiraz kaydı ve kanıtı korunur. Adaylar firma bağlamında (services/deletedPurge.ts). Geri dönüş: iki değişken boş/`off`.
  // Varsayılan kapalı (değişkenler boş); süre veritabanı saatinden, bu turun `now`'ı kullanılmaz.
  const purge = await runDeletedPurge(log).catch((err) => {
    log?.warn({ err }, 'silinenlerin kalıcı temizliği başarısız');
    return { invoices: 0, photos: 0 };
  });
  // biten ve 7 günden eski işler (dar yol yalnız onları gösterir ve siler)
  const jobs = await cleanupFinishedJobs(now).catch((err) => {
    log?.warn({ err }, 'eski iş temizliği başarısız');
    return 0;
  });
  // İtiraz süresi hatırlatması (Mesaj 14): hatası bakımın geri kalanını düşürmez. Adres boşsa hiçbir şey okumaz.
  // Buraya yalnız veritabanı hatası düşer; bildirim hataları turun içinde yakalanır ve anahtarsız yazılır (reminders.ts).
  const reminders = await runDisputeReminders(new Date(now), { log }).catch((err) => {
    log?.warn({ err }, 'itiraz hatırlatması başarısız');
    return emptyReminderResult();
  });
  // Yarıda kalmış kalıcı firma silmeleri (bitmemiş `CompanyPurge` kaydı; silme yalnız Hesap'ın olayıyla başlar).
  const purgedCompanies = await runCompanyPurges(log).catch((err) => {
    log?.warn({ err }, 'kalıcı firma silmesi başarısız');
    return 0;
  });
  return {
    ...cleaned,
    recompared,
    rechecked,
    previews: files.previews,
    purged: files.purged,
    purgedInvoices: purge.invoices,
    purgedPhotos: purge.photos,
    jobs,
    reminders,
    purgedCompanies,
  };
}

/**
 * Saatte bir. Birden çok kopyada da güvenlidir: yalnız süresi dolmuşu siler. Süreci açık tutmaz. Dönen işlev yeni turu
 * durdurur ve süren turun bitişini bekleyen bir söz verir (sınırı çağıran koyar: `services/background.ts`).
 */
export function startMaintenance(log: Log): () => Promise<void> {
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const run: Promise<void> = runMaintenance(Date.now(), log)
      .then(() => undefined)
      .catch((err) => log.warn({ err }, 'bakım işi başarısız'))
      .finally(() => inflight.delete(run));
    inflight.add(run);
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, INTERVAL_MS);
  first.unref();
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    await Promise.all([...inflight]);
  };
}
