/**
 * Örnek veriyle deneme turu (MESAJ-14 §4.3, 13-B3). Boş firmaya örnek taşıyıcı, tarife, ölçüm ve iki fatura yüklenir;
 * "Denemeyi bitir" yalnız örnek veriyi siler. Veri kaybı riski taşır; güvenceler:
 *
 * - Başlatma yalnız boş firmada (`companyHasData`: taşıyıcı, tarife, fatura (silinmiş ve örnek dahil), silinmemiş ölçüm yok).
 *   Denetim ve bayrak yazımı firma satırı kilidi altında, tek işlemde; bayrak (`settings.demo`) yüklemeden ÖNCE yazılır ve
 *   açılacak örnek taşıyıcıların önceden üretilen kimliklerini (`carrierIds`) taşır.
 * - Bitirme "ne varsa" değil "ne yüklendiyse" siler: yalnız `carrierIds` taşıyıcıları ve onlara bağlı tarife, fatura, belge ve
 *   taslaklar, bir de önekli ölçümler. Koruma kaçırsa da (yarış, eski sürüm) sonradan eklenen gerçek taşıyıcı ve kayıtları kalır.
 * - Bayrak açıkken taşıyıcı, tarife ve fatura ekleyen bütün uçlar 409 DEMO_ACTIVE (`DEMO_BLOCKED`, `app.ts` kancası); taşıyıcı
 *   ekleme ayrıca kendi işleminde firma satırını FOR SHARE kilitleyip bayrağı yeniden okur (başlatmayla sıraya girer). Kaçak uç
 *   kalmasın diye test, yazma yöntemli her ucu bu liste ile gerekçeli izin listesine karşı denetler (`test/demoTour.test.ts`).
 * - Ölçüm kaydı serbesttir (telefon). Bitirme yalnız `clientId`'si `DEMO_CLIENT_ID_PREFIX` ile başlayan ölçümleri siler;
 *   çalışanların gerçek ölçümleri, fotoğrafları ve hazır koliler kalır. Önek yalnız sunucunundur (istemci gönderirse 400);
 *   örnek ölçümün düzeltmesi de önekli açılır.
 * - Yükleme sürerken bayrakta `loadingSince` vardır: başka kopyadan gelen bitirme süresi dolmadan (`DEMO_LOADING_TTL_MS`)
 *   409 DEMO_LOADING alır; süresi dolmuş yükleme (düşmüş süreç) bitirmeyle temizlenir. Yükleme sürdükçe işaret tazelenir
 *   (Y130, `DEMO_LOADING_HEARTBEAT_MS`): süre yalnız süreç düşünce dolar.
 * - Eski sürümün `carrierIds` taşımayan bayrağında örnek taşıyıcılar sıkı kuralla bulunur (`legacyDemoCarrierIds`).
 * - Silme tek işlemde, firma satırı kilidi altında, firma bağlamında (RLS) ve her sorguda `companyId` ile; önce satır, sonra
 *   disk. Disk dosyası yalnız firmanın kendi klasöründeyse ve aynı yolu kullanan başka satır yoksa silinir
 *   (`services/fileCleanup.ts` kuralı). Firma klasörü toptan silinmez (gerçek fotoğraflar oradadır).
 * - Ortada hata çıkarsa yüklenen örnek veri aynı silme yoluyla kaldırılır ve bayrak iner; temizlik de düşerse bayrak kalır:
 *   bant görünür, "Denemeyi bitir" sonradan temizler (yarım örnek veri gerçek veri gibi kalmaz).
 * - Aynı firmada başlatma ve bitirme bu süreçte sırayla çalışır (`exclusive`): bitirme yüklemenin ortasına giremez.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { prisma, Prisma, withCompany, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { conflict } from '../errors.ts';
import { m } from '../i18n/index.ts';
import { readSettings, type CompanySettings, type DemoFlag, type OnboardingState } from '../lib/settings.ts';
import { absolutePath, deleteStored } from '../lib/storage.ts';
import { zonedDate } from '../lib/time.ts';
import { loadSampleData, sampleCarrierCodes } from './companyData.ts';
import { abortLocalRun } from './jobs/runner.ts';
import { companyHasData, onboardingAfterDataReset } from './onboarding.ts';
import { importDemoInvoice, sampleInvoice } from './sampleInvoices.ts';

/** Örnek ölçümün `clientId` öneki. Bitirme yalnız bu önekli ölçümleri siler. */
export const DEMO_CLIENT_ID_PREFIX = 'demo:';

/**
 * Yükleme bundan uzun süren deneme yarım kalmış sayılır (süreç düştü): bitirme temizleyebilir. Yükleme saniyeler sürer; fatura
 * yazımının işlem süresi en çok 2 dakika (`importDemoInvoice`).
 */
export const DEMO_LOADING_TTL_MS = 15 * 60_000;
/** Y130: yükleme sürerken `loadingSince` bu aralıkla tazelenir (süreden çok kısa: birkaç tazeleme kaçsa da süre dolmaz). */
export const DEMO_LOADING_HEARTBEAT_MS = 60_000;

/** Yükleme sürüyor ve süresi dolmadı. Okunamayan ya da çok ileri tarih süresi dolmuş sayılır (temizlenebilir, sonsuza kilitlenmez). */
export function demoLoadingFresh(flag: DemoFlag, now = Date.now()): boolean {
  if (flag.loadingSince === undefined) return false;
  const age = now - Date.parse(flag.loadingSince);
  return Number.isFinite(age) && Math.abs(age) < DEMO_LOADING_TTL_MS;
}

/**
 * Deneme açıkken kapalı uçlar (`METHOD /yol`, API önekisiz, Fastify yol kalıbı): taşıyıcı, tarife ve fatura ekleyen her yol,
 * tarife içe aktarma ve PDF belge uçları, veri sıfırlama. Burada olmayan yazma ucu `test/demoTour.test.ts`'teki gerekçeli
 * izin listesinde olmalı.
 */
export const DEMO_BLOCKED: ReadonlySet<string> = new Set([
  'POST /carriers',
  'POST /tariffs',
  'POST /tariffs/:id/duplicate',
  'POST /tariffs/:id/import',
  'POST /tariff-imports',
  'POST /tariff-imports/:draftId/recheck',
  'POST /tariff-imports/:draftId/review',
  'POST /tariff-imports/:draftId/apply',
  'POST /tariff-documents/:documentId/scan',
  'POST /tariff-documents/:documentId/extract',
  'POST /invoices',
  'POST /invoices/preview',
  'POST /invoices/preview/verify',
  'POST /invoices/preview/ai-mapping',
  'POST /invoices/samples',
  // Yalnız ENABLE_DATA_RESET açıkken kayıtlı. Deneme açıkken sıfırlama bayrağı yarım bırakırdı: önce deneme biter.
  'POST /settings/data/reset',
]);

/** Deneme faturaları: FedEx bugünden 5 gün önce (itiraz için 3 gün kalır), Aras 20 gün önce (süresi dolmuş). */
const DEMO_INVOICES = [
  { id: 'fedex-9-482-11735', daysAgo: 5 },
  { id: 'aras-ARS-2026-004871', daysAgo: 20 },
] as const;

export type DemoStartResult = { carriers: number; tariffs: number; measurements: number; invoices: number };
export type DemoRemoved = { invoices: number; tariffs: number; carriers: number; measurements: number };
export type DemoLog = { warn: (obj: unknown, msg: string) => void };
const consoleLog: DemoLog = { warn: (obj, msg) => console.warn(msg, obj) };

const DAY_MS = 86_400_000;
const dayFrom = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ---------- Aynı firmada sıra ----------

const lanes = new Map<string, Promise<unknown>>();

/** Aynı firmanın başlatma ve bitirme işlerini bu süreçte sıraya koyar. İş firma bağlamında çalışır. */
async function exclusive<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const prev = lanes.get(companyId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => withCompany(companyId, work));
  const tail = run.catch(() => {});
  lanes.set(companyId, tail);
  try {
    return await run;
  } finally {
    if (lanes.get(companyId) === tail) lanes.delete(companyId);
  }
}

// ---------- Ayar satırı ----------

/** Firma satırını işlemin sonuna kadar kilitler ve ayarı okur (PATCH /settings ve kurulum aynı kilidi kullanır). */
async function lockSettings(tx: Tx, companyId: string): Promise<CompanySettings> {
  await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
  const company = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
  return readSettings(company.settings);
}

async function writeSettings(tx: Tx, companyId: string, settings: CompanySettings): Promise<void> {
  await tx.company.update({ where: { id: companyId }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
}

/**
 * Bayrağı kaldırılmış ayar. Deneme bitti: kurulum baştan (`onboardingAfterDataReset`). Başlatma düştü: kurulum başlamadan
 * önceki hâline döner (`restore`).
 */
function withoutDemo(s: CompanySettings, restore?: { onboarding: OnboardingState | undefined }): CompanySettings {
  const { demo: _demo, onboarding: _onboarding, ...rest } = s;
  const onboarding = restore ? restore.onboarding : onboardingAfterDataReset(s, false);
  return onboarding === undefined ? rest : { ...rest, onboarding };
}

/**
 * Y130: yükleme sürerken `loadingSince`'i tazeler: yalnız bayrak hâlâ bu denemenin (`startedAt`) ve yükleme işaretini
 * taşıyorsa, firma satırı kilidi altında. Tazeleme düşerse günlüğe yazılır (sonraki tur yeniden dener). `stop()` süren
 * tazelemeyi de bekler: dönüşünden sonra yazım olmaz.
 */
function startLoadingHeartbeat(companyId: string, startedAt: string, log: DemoLog, intervalMs: number): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const touch = async () => {
    try {
      await withCompany(companyId, () =>
        prisma.$transaction(async (tx) => {
          const s = await lockSettings(tx, companyId);
          if (stopped || !s.demo || s.demo.startedAt !== startedAt || s.demo.loadingSince === undefined) return;
          await writeSettings(tx, companyId, { ...s, demo: { ...s.demo, loadingSince: new Date().toISOString() } });
        }),
      );
    } catch (err) {
      log.warn({ err, companyId }, 'demo loading heartbeat failed');
    }
  };
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(touch);
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

/** Deneme açık mı (koruma kancası her kapalı uçta bunu okur). Firma bağlamında çağrılır. */
export async function demoActive(companyId: string): Promise<boolean> {
  const company = await prisma.company.findFirst({ where: { id: companyId }, select: { settings: true } });
  return Boolean(company && readSettings(company.settings).demo);
}

// ---------- Başlatma ----------

/**
 * Örnek veriyi yükler. 409 DEMO_ACTIVE: zaten açık. 409 DEMO_NOT_EMPTY: firmada veri var. Yükleme düşerse örnek veri
 * kaldırılır, bayrak iner ve hata yeniden atılır (500).
 */
export async function startDemo(companyId: string, memberId: string, o: { now?: Date; log?: DemoLog; heartbeatMs?: number } = {}): Promise<DemoStartResult> {
  const log = o.log ?? consoleLog;
  return exclusive(companyId, async () => {
    const startedAt = new Date().toISOString();
    // Taşıyıcı kimlikleri önceden: bayrak yüklenecek olanı baştan bilir, yarım kalan yükleme de yalnız bunları temizler.
    const codes = sampleCarrierCodes();
    const carrierIds = codes.map(() => crypto.randomUUID());
    // 1. Bayrak önce: koruma, bu andan sonra gelen taşıyıcı, tarife ve fatura eklemesini keser. `loadingSince`: yükleme sürüyor.
    const settings = await prisma.$transaction(async (tx) => {
      const s = await lockSettings(tx, companyId);
      if (s.demo) throw conflict('DEMO_ACTIVE', m('err.demoActive'));
      if (await companyHasData(companyId, tx)) throw conflict('DEMO_NOT_EMPTY', m('err.demoNotEmpty'));
      await writeSettings(tx, companyId, { ...s, demo: { startedAt, byMemberId: memberId, carrierIds, loadingSince: startedAt } });
      return s;
    });

    let flagLost = false;
    // Y130: yükleme sürdükçe `loadingSince` tazelenir; süresi yalnız süreç düşünce (tazeleme durunca) dolar. Böylece çok yavaş
    // ama sürmekte olan yüklemeyi başka kopyanın bitirmesi temizleyemez (temizlerse arkadan gelen örnek veri kalırdı).
    const heartbeat = startLoadingHeartbeat(companyId, startedAt, log, o.heartbeatMs ?? DEMO_LOADING_HEARTBEAT_MS);
    try {
      // 2. Taşıyıcılar (önceden üretilen kimliklerle), tarifeler ve ölçümler (önekli), 3. iki fatura (gerçek içe aktarma yolu).
      const loaded = await loadSampleData(companyId, { fallbackUserId: memberId, clientIdPrefix: DEMO_CLIENT_ID_PREFIX, carrierIds });
      const today = zonedDate(o.now ?? new Date(), settings.timeZone);
      for (const inv of DEMO_INVOICES) {
        const sample = sampleInvoice(inv.id);
        // Taşıyıcı koda göre değil bu denemenin kimliğiyle: aynı kodlu başka taşıyıcıya fatura yazılmaz.
        const carrierId = carrierIds[codes.indexOf(sample.carrierCode)];
        if (!carrierId) throw new Error(`Örnek taşıyıcı yok: ${sample.carrierCode}`);
        await importDemoInvoice(companyId, sample, dayFrom(today, -inv.daysAgo), memberId, { carrierId });
      }
      // 4. Kurulum tamamlanmış sayılır, `loadingSince` kalkar; bayrak hâlâ bu denemenin mi (başka kopya süresi dolmuş
      // yüklemeyi temizlemiş olabilir) kilit altında bakılır.
      await heartbeat.stop();
      const still = await prisma.$transaction(async (tx) => {
        const s = await lockSettings(tx, companyId);
        if (!s.demo || s.demo.startedAt !== startedAt) return false;
        const { loadingSince: _loading, ...flag } = s.demo;
        await writeSettings(tx, companyId, { ...s, demo: flag, onboarding: onboardingAfterDataReset(s, true) });
        return true;
      });
      if (!still) {
        // Bu süreçte olamaz (`exclusive`). Başka kopya süresi dolmuş yüklemeyi temizlediyse (yükleme `DEMO_LOADING_TTL_MS`'den
        // uzun sürdü) yeni bir deneme açılmış olabilir: onun önekli ölçümlerini silmemek için temizlik yapılmaz, günlüğe yazılır.
        flagLost = true;
        log.warn({ companyId }, 'demo flag changed while sample data was loading: sample data left in place');
        throw conflict('DEMO_NOT_ACTIVE', m('err.demoNotActive'));
      }
      return { ...loaded, invoices: DEMO_INVOICES.length };
    } catch (err) {
      await heartbeat.stop();
      if (!flagLost) {
        try {
          await removeDemoData(companyId, { expectStartedAt: startedAt, restore: { onboarding: settings.onboarding }, log });
        } catch (cleanupErr) {
          // Bayrak kalır: bant görünür, "Denemeyi bitir" sonradan temizler.
          log.warn({ err: cleanupErr, companyId }, 'demo start failed and cleanup failed: demo flag kept');
        }
      }
      throw err;
    }
  });
}

// ---------- Bitirme ----------

/**
 * Örnek veriyi siler, bayrağı kaldırır, kurulumu baştan açar. 409 DEMO_NOT_ACTIVE: deneme açık değil. 409 DEMO_LOADING:
 * başka kopyada yükleme sürüyor (süresi dolmadı).
 */
export async function endDemo(companyId: string, o: { log?: DemoLog } = {}): Promise<DemoRemoved> {
  return exclusive(companyId, async () => {
    const removed = await removeDemoData(companyId, { log: o.log });
    if (!removed) throw conflict('DEMO_NOT_ACTIVE', m('err.demoNotActive'));
    return removed;
  });
}

type DiskRemoval = { path: string; kind: 'file' | 'document' };

/**
 * Bayraktaki örnek taşıyıcı kimlikleri. Liste yoksa (Y130: `carrierIds`'ten önceki sürümün bayrağı) örnek taşıyıcılar
 * `legacyDemoCarrierIds` kuralıyla bulunur; kurala uymayan taşıyıcı silinmez.
 */
async function flagCarrierIds(tx: Tx, flag: DemoFlag, companyId: string, log: DemoLog): Promise<string[]> {
  if (!Array.isArray(flag.carrierIds)) return legacyDemoCarrierIds(tx, flag, companyId, log);
  return flag.carrierIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Eski biçim bayrakta örnek kaydın oluşma penceresinin başı: uygulama ile veritabanı saati arasındaki küçük kayma payı. */
export const DEMO_LEGACY_SKEW_MS = 5 * 60_000;

/**
 * Y130: `carrierIds` taşımayan (eski sürümün yazdığı) bayrakta örnek taşıyıcılar. Eskiden hiçbir taşıyıcı silinmiyordu, örnek
 * taşıyıcı, tarife ve faturalar gerçek veri gibi kalıyordu. Taşıyıcı ancak HEPSİ tutarsa örnek sayılır (biri tutmazsa kalır):
 * - kodu örnek taşıyıcılardan biri ve o koddan bu pencerede tek taşıyıcı açılmış (iki aday: hangisi örnek bilinmez, ikisi de kalır);
 * - kendisi, bütün tarifeleri ve bütün faturaları denemenin yükleme penceresinde açılmış: [`startedAt` − kayma payı,
 *   `startedAt` + `DEMO_LOADING_TTL_MS`] (örnek veri o sürede yüklenir; deneme açıkken taşıyıcı, tarife, fatura ekleyen uçlar kapalı);
 * - bütün faturaları örnek fatura numarasını taşıyor (o kodun deneme faturaları); başka numaralı fatura gerçek sayılır.
 * Başlangıcı okunamayan bayrakta hiçbir taşıyıcı silinmez. Silinmeyen her şey günlüğe yazılır.
 */
async function legacyDemoCarrierIds(tx: Tx, flag: DemoFlag, companyId: string, log: DemoLog): Promise<string[]> {
  const started = Date.parse(flag.startedAt);
  if (!Number.isFinite(started)) {
    log.warn({ companyId }, 'legacy demo flag has no readable start: sample carriers, tariffs and invoices kept');
    return [];
  }
  const from = new Date(started - DEMO_LEGACY_SKEW_MS);
  const to = new Date(started + DEMO_LOADING_TTL_MS);
  const inWindow = (d: Date) => d >= from && d <= to;
  const codes = sampleCarrierCodes();
  const sampleNos = new Map<string, Set<string>>();
  for (const inv of DEMO_INVOICES) {
    const s = sampleInvoice(inv.id);
    sampleNos.set(s.carrierCode, (sampleNos.get(s.carrierCode) ?? new Set()).add(s.invoiceNo));
  }
  const candidates = await tx.carrier.findMany({
    where: { companyId, code: { in: codes }, createdAt: { gte: from, lte: to } },
    select: { id: true, code: true, createdAt: true },
  });
  const ids: string[] = [];
  let kept = 0;
  for (const code of codes) {
    const own = candidates.filter((c) => c.code === code);
    if (own.length !== 1) {
      kept += own.length;
      continue;
    }
    const c = own[0]!;
    const [tariffs, invoices] = await Promise.all([
      tx.tariff.findMany({ where: { companyId, carrierId: c.id }, select: { createdAt: true } }),
      tx.invoice.findMany({ where: { companyId, carrierId: c.id }, select: { createdAt: true, invoiceNo: true } }),
    ]);
    const nos = sampleNos.get(code) ?? new Set<string>();
    if (tariffs.every((t) => inWindow(t.createdAt)) && invoices.every((i) => inWindow(i.createdAt) && nos.has(i.invoiceNo))) ids.push(c.id);
    else kept++;
  }
  if (kept > 0) log.warn({ companyId, kept }, 'legacy demo flag: carriers not matching the sample rule kept');
  return ids;
}

/**
 * Deneme verisini tek işlemde siler. null: deneme açık değil (ya da `expectStartedAt` verildi ve bayrak başka denemenin).
 * 409 DEMO_LOADING: yükleme sürüyor ve süresi dolmadı (yükleyenin kendi temizliği, `expectStartedAt`, beklemez).
 * Silinenler (sıra `clearCompanyData` ile aynı, kapsam bayraktaki taşıyıcılar):
 * - bu taşıyıcıların faturaları (satırlar, itirazlar cascade) ve onların kaynak dosyaları;
 * - bu taşıyıcıların tarifeleri (bölge, fiyat, ek ücret, geri alma sürümleri cascade), bu tarifelerin fiyat sürümleri ve
 *   bu faturaların kullandığı, tarifesi silinmiş fiyat sürümleri;
 * - bu taşıyıcılar (içe aktarma taslakları ve tarife PDF'leri; PDF dosyaları diskten);
 * - yalnız önekli ölçümler ve onlara bağlı fotoğraf satırları;
 * - bu kayıtlara bağlı arka plan işleri (dosya, tarife belgesi, tarife) ve deneme başladıktan sonra açılan firma çapında
 *   toplu yeniden hesap işleri.
 * Kalanlar: listede olmayan taşıyıcılar ve onların tarife ve faturaları, öneksiz ölçümler ve fotoğrafları, hazır koliler,
 * ayarlar, üyeler, denetim kaydı, yapay zekâ kullanımı, faturaya bağlanmamış eski önizleme dosyaları (kendi temizliğinde),
 * deneme sırasında silinen örnek tarifenin faturaya bağlanmamış fiyat sürümleri.
 */
export async function removeDemoData(
  companyId: string,
  o: { expectStartedAt?: string; restore?: { onboarding: OnboardingState | undefined }; log?: DemoLog } = {},
): Promise<DemoRemoved | null> {
  const log = o.log ?? consoleLog;
  return withCompany(companyId, async () => {
    const done = await prisma.$transaction(async (tx) => {
      const s = await lockSettings(tx, companyId);
      const flag = s.demo;
      if (!flag || (o.expectStartedAt !== undefined && flag.startedAt !== o.expectStartedAt)) return null;
      // Başka kopyada yükleme sürüyor: ortasına girilirse yüklenmeye devam eden örnek veri gerçek veri gibi kalırdı.
      if (o.expectStartedAt === undefined && demoLoadingFresh(flag)) throw conflict('DEMO_LOADING', m('err.demoLoading'));

      const carrierIds = await flagCarrierIds(tx, flag, companyId, log);
      const invoices = await tx.invoice.findMany({ where: { companyId, carrierId: { in: carrierIds } }, select: { id: true, sourceFileId: true, tariffRevisionId: true } });
      const invoiceIds = invoices.map((i) => i.id);
      const tariffIds = (await tx.tariff.findMany({ where: { companyId, carrierId: { in: carrierIds } }, select: { id: true } })).map((t) => t.id);
      const lineRevisions = invoiceIds.length
        ? await tx.invoiceLine.findMany({ where: { companyId, invoiceId: { in: invoiceIds }, tariffRevisionId: { not: null } }, select: { tariffRevisionId: true }, distinct: ['tariffRevisionId'] })
        : [];
      const usedRevisionIds = [...invoices.map((i) => i.tariffRevisionId), ...lineRevisions.map((l) => l.tariffRevisionId)].filter((id): id is string => Boolean(id));
      // Faturanın kullandığı sürüm yalnız tarifesi silinmişse (deneme sırasında silinen örnek tarife); başka tarifenin sürümü kalır.
      const revisionIds = (
        await tx.tariffRevision.findMany({ where: { companyId, OR: [{ tariffId: { in: tariffIds } }, { id: { in: usedRevisionIds }, tariffId: null }] }, select: { id: true } })
      ).map((r) => r.id);
      const since = new Date(flag.startedAt);
      const measurementIds = (
        await tx.measurement.findMany({ where: { companyId, clientId: { startsWith: DEMO_CLIENT_ID_PREFIX } }, select: { id: true } })
      ).map((x) => x.id);
      const files = await tx.file.findMany({
        where: {
          companyId,
          OR: [
            { kind: 'INVOICE_SOURCE', id: { in: invoices.map((i) => i.sourceFileId) } },
            { kind: 'INVOICE_SOURCE', invoiceId: { in: invoiceIds } },
            { measurementId: { in: measurementIds } },
          ],
        },
        select: { id: true, path: true, purgedAt: true },
      });
      const fileIds = files.map((f) => f.id);
      const documents = await tx.tariffDocument.findMany({ where: { companyId, carrierId: { in: carrierIds } }, select: { id: true, path: true } });
      const documentIds = documents.map((d) => d.id);
      // KALANLAR 6.18: tarife incelemesi işinin konusu taslaktır
      const draftIds = (await tx.tariffImportDraft.findMany({ where: { companyId, carrierId: { in: carrierIds } }, select: { id: true } })).map((d) => d.id);

      // Bu kayıtlara bağlı işler (süren dahil): süren işin sonraki yazımı satırı bulamaz, kira kaybı sayılır (`clearCompanyData` gibi).
      const jobs = await tx.job.findMany({
        where: {
          companyId,
          OR: [
            { refType: 'File', refId: { in: fileIds } },
            { refType: 'TariffDocument', refId: { in: documentIds } },
            { refType: 'Tariff', refId: { in: tariffIds } },
            { refType: 'TariffImportDraft', refId: { in: draftIds } },
            // Firma çapındaki toplu yeniden hesap yalnız deneme başladıktan sonra açıldıysa (öncekiler denemeye ait değil).
            ...(Number.isNaN(since.getTime())
              ? []
              : [{ refType: 'Company', refId: companyId, kind: { in: ['BULK_RECOMPARE_PREVIEW' as const, 'BULK_RECOMPARE_APPLY' as const] }, createdAt: { gte: since } }]),
          ],
        },
        select: { id: true, status: true },
      });

      await tx.job.deleteMany({ where: { companyId, id: { in: jobs.map((j) => j.id) } } });
      const removedInvoices = await tx.invoice.deleteMany({ where: { companyId, id: { in: invoiceIds } } });
      // Kaynak dosya faturadan sonra (Invoice_sourceFileId_fkey RESTRICT), fotoğraf satırı ölçümden önce (ölçüm silinince SET NULL olurdu).
      await tx.file.deleteMany({ where: { companyId, id: { in: fileIds } } });
      const removedMeasurements = await tx.measurement.deleteMany({ where: { companyId, id: { in: measurementIds }, clientId: { startsWith: DEMO_CLIENT_ID_PREFIX } } });
      await tx.tariffDocument.deleteMany({ where: { companyId, id: { in: documentIds } } });
      await tx.tariffImportDraft.deleteMany({ where: { companyId, carrierId: { in: carrierIds } } });
      await tx.tariffVersion.deleteMany({ where: { companyId, tariffId: { in: tariffIds } } });
      const removedTariffs = await tx.tariff.deleteMany({ where: { companyId, id: { in: tariffIds } } });
      // Fiyat sürümleri tarifelerden ve faturalardan sonra (currentRevisionId ve fatura bağları NO ACTION).
      await tx.tariffRevision.deleteMany({ where: { companyId, id: { in: revisionIds } } });
      const removedCarriers = await tx.carrier.deleteMany({ where: { companyId, id: { in: carrierIds } } });
      await writeSettings(tx, companyId, withoutDemo(s, o.restore));

      const disk: DiskRemoval[] = [
        ...files.filter((f) => !f.purgedAt).map((f) => ({ path: f.path, kind: 'file' as const })),
        ...documents.map((d) => ({ path: d.path, kind: 'document' as const })),
      ];
      return {
        removed: { invoices: removedInvoices.count, tariffs: removedTariffs.count, carriers: removedCarriers.count, measurements: removedMeasurements.count },
        activeJobIds: jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').map((j) => j.id),
        disk,
      };
    });
    if (!done) return null;

    for (const jobId of done.activeJobIds) abortLocalRun(jobId);
    await removeFromDisk(companyId, done.disk, log);
    return done.removed;
  });
}

/** Disk dosyası yalnız firmanın kendi klasöründeyse (`storeBuffer`: `<companyId>/<ay>/<uuid>.<uzantı>`). */
function ownedByCompany(companyId: string, rel: string): boolean {
  try {
    return absolutePath(rel).startsWith(path.resolve(env.storageDir, companyId) + path.sep);
  } catch {
    return false;
  }
}

/** İşlem bittikten sonra: yolu hâlâ kullanan satır yoksa ve yol firmanın klasöründeyse siler. Hata günlüğe yazılır, atılmaz. */
async function removeFromDisk(companyId: string, items: DiskRemoval[], log: DemoLog): Promise<void> {
  for (const rel of [...new Set(items.map((i) => i.path))]) {
    try {
      const stillUsed =
        (await prisma.file.count({ where: { companyId, path: rel, purgedAt: null } })) + (await prisma.tariffDocument.count({ where: { companyId, path: rel } }));
      if (stillUsed > 0) continue;
      if (!ownedByCompany(companyId, rel)) {
        log.warn({ companyId }, 'demo file path is outside the company folder: disk file kept');
        continue;
      }
      await deleteStored(rel);
    } catch (err) {
      log.warn({ err, companyId }, 'demo disk file could not be deleted (row removed; orphan file left)');
    }
  }
}
