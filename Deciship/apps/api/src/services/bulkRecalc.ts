import crypto from 'node:crypto';
import { prisma, type Prisma } from '../db.ts';
import { audit } from '../lib/audit.ts';
import {
  applyRecompare,
  defaultTariff,
  invoicesWithOtherSettings,
  previewRecompare,
  sameCompareSettings,
  type RecompareComputation,
} from './compare.ts';
import { activeRoundWhere } from './disputes.ts';

/**
 * Toplu "eski faturaları yeni dayanağa geçir" (Mesaj 4): tarife ya da ayar değişince eski dayanakta kalan faturalar
 * önce/sonra gösterilir, onayla dayanağın YALNIZ ilgili parçası güncellenir (`all` kapsamıyla): tarife geçişi `tariff`
 * kipiyle tarife sürümünü, ayar geçişi `rules` kipiyle ayarı. Öbür parça faturada olduğu gibi kalır (tarife geçişi
 * toleransı, ayar geçişi tarife sürümünü taşımaz). Etkin itirazı olan fatura atlanır ve sayılır.
 *
 * Kapsam:
 *  - tarife: bu tarifenin ESKİ sürümüyle hesaplı faturalar, bu tarifeyi seçmiş ama bugünkü sürümünde olmayan faturalar ve
 *    dayanağı hiç yazılmamış (`tariffRevisionId` null) olup bu tarifeyle fiyatlanan faturalar. Hesaptan sonra yalnız bu
 *    tarifenin bugünkü sürümüne geçecek olanlar kalır: başka tarifeye (ör. varsayılanı değişmiş taşıyıcıda) düşecek
 *    fatura bu toplu işlemle taşınmaz, faturadaki "Yeni tarifeyle hesapla" ile taşınır.
 *  - ayar: `compareSettings`'i firmanın bugünkü ayarından farklı, silinmemiş, örnek olmayan faturalar. Tarifesi de
 *    değişmiş fatura eski tarife sürümünde kalır; faturada "Tarife değişti" bandı ayrıca sorar.
 */
export type BulkScope = { kind: 'tariff'; tariffId: string } | { kind: 'settings' };

/** Önizlemedeki fatura listesinin üst sınırı (sayılar tüm kapsamdan). */
export const BULK_LIST_LIMIT = 200;

type Planned = { id: string; invoiceNo: string; carrierName: string; currency: string; comp: RecompareComputation };

/** Fazla ödeme para birimine göre: farklı para birimindeki faturalar toplanmaz. */
export type BulkCurrencyTotal = {
  currency: string;
  /** bu para birimindeki geçirilecek fatura sayısı */
  invoices: number;
  before: { overchargeTotal: number };
  after: { overchargeTotal: number };
};
type BulkPlan = { token: string; moving: Planned[]; skipped: string[] };

export type BulkPreview = {
  token: string;
  invoices: {
    id: string;
    invoiceNo: string;
    carrierName: string;
    currency: string;
    before: { overchargeTotal: number };
    after: { overchargeTotal: number };
    changedLines: number;
  }[];
  /** geçirilecek TÜM faturaların (yalnız listedeki ilk 200'ün değil) para birimine göre toplamı, para birimi sırasıyla */
  totalsByCurrency: BulkCurrencyTotal[];
  changedInvoices: number;
  skippedInDispute: number;
};

/**
 * K4: önizlemeden sonra değiştiği için yazılmayan faturanın kısa kaydı (panel listeler, faturaya bağlanır). `deleted`:
 * fatura bu arada silindi (bağlantı yok).
 */
export type BulkStaleInvoice = { id: string; invoiceNo: string; carrierName: string; deleted?: true };

export type BulkApplyResult = {
  invoices: number;
  lines: number;
  /** `inDispute`: etkin itirazı olduğu için geçirilmeyen; `stale`: önizlemeden sonra değiştiği için yazılmayan fatura */
  skipped: { inDispute: number; stale: number };
  /**
   * K4: `stale` > 0 ise var (yoksa alan yok): yazılmayan faturalar atlanma sırasıyla, en çok `BULK_LIST_LIMIT` (silinen
   * dahil, işaretli). Aynı kapsamın yeni önizlemesi bunları (hâlâ eski dayanaktaysalar) yeniden gösterir.
   */
  staleInvoices?: BulkStaleInvoice[];
  /**
   * K4: iş bütünüyle bittiyse ve > 0 ise var: hâlâ kapsamda kalan, etkin itirazı olmayan fatura sayısı (bayat atlananlar,
   * önizlemeden sonra kapsama girenler, itirazı kapananlar; `remainingInScope`). Panel "Yeniden önizle" önerir.
   */
  remaining?: number;
};

/**
 * Uygulamanın sonucu; `stopped`: durdurulunca hiç denenmemiş planlı fatura sayısı (eşzamanlı uç bunu dışarı vermez).
 * `paused`: Y57, yuva başka firmaya bırakıldı (`shouldPause`); iş kaldığı yerden sürecek, sonuç değildir.
 */
export type BulkApplyOutcome = BulkApplyResult & { stopped: number; paused?: true };

/**
 * Uygulamanın sayaçları (Mesaj 7, `Job.counters`). `invoices`, `lines`: yazılan fatura ve satır; `inDispute`: önizlemede
 * itirazda olan + yazım sırasında itiraza giren; `stale`: kendi özeti tutmadığı için yazılmayan. Sonuç bunlardan kurulur.
 */
export type BulkCounters = { invoices: number; lines: number; inDispute: number; stale: number };

/**
 * Uygulamanın kaldığı yeri (Mesaj 7, `Job.checkpoint`): ilk denemede plan doğrulanınca bir kez yazılır. `planned`:
 * yazılacak faturalar sırasıyla, her biri KENDİ özetiyle (`applyRecompare` `expectedToken`). `stale` (K4): bu arada
 * değiştiği için yazılmayan faturalar, en çok `BULK_LIST_LIMIT`; her biri ilerleme ve sayaçlarla aynı çitli işlemde
 * eklenir (`saveStale`), denemeler ve yuva bırakmalar boyunca kaybolmaz.
 */
export type BulkCheckpoint = {
  v: 1;
  verifiedAt: string;
  token: string;
  planned: [invoiceId: string, invoiceToken: string][];
  skippedInDispute: number;
  stale?: string[];
};

/**
 * K4: önizleme işinin kaydettiği plan (`BULK_RECOMPARE_PREVIEW` işinin `Job.checkpoint`'i; dışarı verilmez). `planned`:
 * geçecek faturalar sırasıyla, kendi özetleriyle; `skipped`: itirazda olduğu için atlananlar; `basis`: önizleme
 * başlarken ve biterken aynı olan dayanak anahtarı (`bulkPreviewDedupeKey`). Genel özet `planned` ve `skipped`'ten kurulur
 * (`planDigest`): uygulama planı yeniden hesaplamadan bu listeyi yazar.
 */
export type BulkPreviewPlan = { v: 1; token: string; basis: string; planned: [invoiceId: string, invoiceToken: string][]; skipped: string[] };

/** Sonraki denemenin başlangıcı: kaydedilmiş plan + iş satırının son çitli ilerlemesi (`done` = yazımı biten planlı fatura). */
export type BulkResume = { checkpoint: unknown; done: number; counters: unknown };

/**
 * Arka plan işinin kancaları (Mesaj 7, plan §4.11). Hiçbiri verilmezse davranış eşzamanlı uçlardakiyle aynıdır.
 *  - `signal`: hesap sırasında kesilirse sinyalin nedeni atılır (hiçbir şey yazılmamıştır); yazım sırasında fatura aralarında
 *    denetlenir, yazılan faturalar kalır, sonuç `stopped` ile döner.
 *  - `onProgress`: aşama `bulkCheck` (n / kapsam) ve `bulkWrite` (n / plan); her faturadan sonra, işlem DIŞINDA.
 *  - `checkpoint`: `save` doğrulanmış planı ve `done = 0`'ı yazar; `load` sonraki denemede onları okur. Plan varsa genel özet
 *    yeniden denetlenmez (kullanıcının onayladığı plan ilk denemede doğrulandı), yazım `done`'dan sürer.
 *  - `fence`: her fatura yazımıyla AYNI işlemde (`applyRecompare` `onWrite`) ilerleme ve sahiplik denetimi; atarsa faturanın
 *    yazımı geri alınır. Fatura yazımı ile "yazıldı" bilgisi birlikte işlenir: her fatura en çok bir kez yazılır.
 */
export type BulkHooks = {
  signal?: AbortSignal;
  onProgress?: (p: { stage: 'bulkCheck' | 'bulkWrite'; done: number; total: number; counters?: BulkCounters }) => Promise<void>;
  /**
   * `saveStale` (K4): değişen faturanın kimliği eklenince tüm `stale` listesi, ilerleme ve sayaçlarla AYNI çitli işlemde
   * yazılır (atarsa hiçbiri yazılmaz; sonraki deneme o faturayı yeniden dener ve bir kez sayar).
   */
  checkpoint?: {
    load(): Promise<BulkResume | null>;
    save(c: BulkCheckpoint, counters: BulkCounters): Promise<void>;
    saveStale?(stale: string[], p: { done: number; counters: BulkCounters }): Promise<void>;
  };
  /**
   * K4: ilk denemede onaylanan önizlemenin kaydedilmiş planı (`load(token)`, `BulkPreviewPlan`). Plan varsa yeniden hesap
   * yok; genel özet yalnız planın bütünlüğü için denetlenir, değişen fatura kendi özetiyle yakalanır (`stale`).
   * `'PREVIEW_STALE'`: dayanak önizlemeden sonra değişti ya da bu önizleme daha önce uygulandı (hiçbir şey yazılmaz).
   * null ya da bozuk plan: eski kural (plan yeniden kurulur, genel özet tutmazsa hiçbir şey yazılmaz).
   */
  previewPlan?: { load(token: string): Promise<unknown> };
  /** Yazımı etkilemeyen ek okumanın (`remaining` sayımı) hatası: iş düşmez, günlüğe yazılır. */
  warn?: (err: unknown, msg: string) => void;
  fence?: (tx: Prisma.TransactionClient, p: { done: number; counters: BulkCounters }) => Promise<void>;
  /**
   * Y57 (adil paylaşım): yazım aşamasında fatura aralarında, bu çalıştırmada en az bir fatura denendikten sonra sorulur.
   * true: döngü durur, sonuç `paused: true` ile döner (yazılanlar kalır, kalanlar sonraki çalıştırmada `done`'dan sürer).
   */
  shouldPause?: () => Promise<boolean>;
};

const displaySelect = { id: true, invoiceNo: true, currency: true, carrier: { select: { name: true } } } as const;
const oldestFirst = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * Tarife kapsamının koşulları; toplu önizleme (`scopeRows`) ve tarife kaydı sonrası sayı (`tariffSaveCounts`) aynı
 * kaynaktan okur.
 *  - `pricedBy`: `current` dayanakta bu tarifeye düşen faturalar (`invoiceTariff` kuralı: faturada seçiliyse; seçim yoksa
 *    ve taşıyıcının varsayılanı buysa). Taşıyıcının öbür faturaları başka tarifeye düşer, bu toplu işlem onları taşımaz.
 *  - `scope`: bunlardan bugünkü sürümde olmayanlar (yukarıdaki üç grup).
 * Tarife yoksa null.
 */
async function tariffScopeWhere(companyId: string, tariffId: string) {
  const t = await prisma.tariff.findFirst({ where: { id: tariffId, companyId }, select: { id: true, carrierId: true, currentRevisionId: true } });
  if (!t) return null;
  const carrierTariffs = await prisma.tariff.findMany({ where: { companyId, carrierId: t.carrierId }, select: { id: true, active: true, isDefault: true, updatedAt: true } });
  const isFallback = defaultTariff(carrierTariffs)?.id === t.id;
  const pricedBy: Prisma.InvoiceWhereInput = {
    companyId,
    carrierId: t.carrierId,
    deletedAt: null,
    OR: isFallback ? [{ tariffId: t.id }, { tariffId: null }] : [{ tariffId: t.id }],
  };
  const notCurrent = t.currentRevisionId ? { NOT: { tariffRevisionId: t.currentRevisionId } } : {};
  const scope: Prisma.InvoiceWhereInput = {
    AND: [
      pricedBy,
      {
        OR: [
          { tariffRevision: { tariffId: t.id }, ...notCurrent },
          { tariffId: t.id, tariffRevisionId: { not: null }, ...notCurrent },
          { tariffRevisionId: null },
        ],
      },
    ],
  };
  return { carrierId: t.carrierId, pricedBy, scope };
}

async function scopeRows(companyId: string, scope: BulkScope) {
  if (scope.kind === 'settings') {
    const ids = (await invoicesWithOtherSettings(companyId)).map((x) => x.id);
    if (!ids.length) return [];
    return prisma.invoice.findMany({ where: { companyId, deletedAt: null, isSample: false, id: { in: ids } }, orderBy: oldestFirst, select: displaySelect });
  }
  const w = await tariffScopeWhere(companyId, scope.tariffId);
  if (!w) return [];
  return prisma.invoice.findMany({ where: w.scope, orderBy: oldestFirst, select: displaySelect });
}

/**
 * Tarife kaydı (`PUT`, içe aktarma, geri yükleme) sonrası bildirimin sayıları. `affectedInvoices`: toplu önizlemenin
 * kapsamı (`changedInvoices + skippedInDispute`; "N fatura hesaplandığı günkü tarifeyle duruyor"). `otherInvoices`:
 * taşıyıcının başka tarifeye düşen faturaları (bu tarife onları değiştirmez).
 */
export async function tariffSaveCounts(companyId: string, tariffId: string) {
  const w = await tariffScopeWhere(companyId, tariffId);
  if (!w) return { affectedInvoices: 0, otherInvoices: 0 };
  const [affectedInvoices, pricedBy, carrierInvoices] = await Promise.all([
    prisma.invoice.count({ where: w.scope }),
    prisma.invoice.count({ where: w.pricedBy }),
    prisma.invoice.count({ where: { companyId, carrierId: w.carrierId, deletedAt: null } }),
  ]);
  return { affectedInvoices, otherInvoices: carrierInvoices - pricedBy };
}

/** Toplu geçişin kipi: yalnız adındaki parça güncellenir. */
const basisOf = (scope: BulkScope) => (scope.kind === 'tariff' ? ('tariff' as const) : ('rules' as const));

/**
 * Fatura yeni dayanağa geçer mi: sürüm ya da ayar değişir veya satır sonucu değişir. Satır sonucu `writtenMoneyChanged`
 * ile (görünmeyen küçük kayma da yazılsın); pencerenin "Değişen satır" sayısı `changedLines` (Y32) ayrıdır.
 */
const moves = (c: RecompareComputation) =>
  c.to.tariffRevisionId !== c.from.tariffRevisionId || !sameCompareSettings(c.from.compareSettings, c.to.compareSettings) || c.writtenMoneyChanged > 0;

/**
 * Kapsamdaki her fatura için `tariff` (tarife geçişi) ya da `rules` (ayar geçişi) + `all` önizlemesi (yazmaz). Uzun sürebilir: faturalar sırayla hesaplanır
 * (eski toplu uç gibi; kur indirmesi ve veritabanı havuzu paralel yükü kaldırmaz).
 */
async function buildPlan(companyId: string, scope: BulkScope, hooks: BulkHooks = {}): Promise<BulkPlan> {
  hooks.signal?.throwIfAborted();
  const rows = await scopeRows(companyId, scope);
  let moving: Planned[] = [];
  const skipped: string[] = [];
  await hooks.onProgress?.({ stage: 'bulkCheck', done: 0, total: rows.length });
  for (const [i, row] of rows.entries()) {
    // durdurma ya da kira kaybı: hesap yarıda bırakılır, hiçbir şey yazılmamıştır
    hooks.signal?.throwIfAborted();
    const comp = await previewRecompare(row.id, { basis: basisOf(scope), scope: 'all' });
    await hooks.onProgress?.({ stage: 'bulkCheck', done: i + 1, total: rows.length });
    if (comp === null) continue;
    // Dayanak değişimi istendi: etkin itiraz turu olan fatura reddedilir (INVOICE_HAS_DISPUTE); toplu işlem atlar ve sayar.
    if (typeof comp === 'string') {
      skipped.push(row.id);
      continue;
    }
    if (!moves(comp)) continue;
    moving.push({ id: row.id, invoiceNo: row.invoiceNo, carrierName: row.carrier.name, currency: row.currency, comp });
  }
  if (scope.kind === 'tariff') {
    // sürüm önizleme sırasında doğmuş olabilir (`resolveCurrentBasis`): bugünkü sürüm hesaptan sonra okunur
    const t = await prisma.tariff.findFirst({ where: { id: scope.tariffId, companyId }, select: { currentRevisionId: true } });
    moving = moving.filter((p) => t?.currentRevisionId != null && p.comp.to.tariffRevisionId === t.currentRevisionId);
  }
  return { token: planDigest(scope, moving.map((p) => [p.id, p.comp.token]), skipped), moving, skipped };
}

/** Planın genel özeti: kapsam + geçecek faturalar (kendi özetleriyle) + itirazda atlananlar; sıra özeti değiştirmez. */
function planDigest(scope: BulkScope, planned: readonly (readonly [string, string])[], skipped: readonly string[]): string {
  const payload = {
    v: 1,
    scope: scope.kind === 'tariff' ? ['tariff', scope.tariffId] : ['settings'],
    moving: planned.map(([id, token]) => [id, token]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    skipped: [...skipped].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Geçirilecek faturaların fazla ödemesi para birimine göre (kuruşla toplanır). */
export function currencyTotals(moving: { currency: string; before: number; after: number }[]): BulkCurrencyTotal[] {
  const by = new Map<string, { invoices: number; before: number; after: number }>();
  for (const p of moving) {
    const t = by.get(p.currency) ?? { invoices: 0, before: 0, after: 0 };
    t.invoices++;
    t.before += Math.round(p.before * 100);
    t.after += Math.round(p.after * 100);
    by.set(p.currency, t);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, t]) => ({ currency, invoices: t.invoices, before: { overchargeTotal: cents(t.before / 100) }, after: { overchargeTotal: cents(t.after / 100) } }));
}

/**
 * Önizleme (salt okuma). İş olarak da aynı işlev çalışır; kaldığı yerden sürmez, baştan hesaplar (`signal`, `onProgress`).
 * `savePlan` (K4): yanıttan önce planın tamamı (uygulama onu yazar); yanıt yalnız ilk 200 faturayı taşır.
 */
export async function previewBulk(
  companyId: string,
  scope: BulkScope,
  hooks: Pick<BulkHooks, 'signal' | 'onProgress'> & { savePlan?: (p: Omit<BulkPreviewPlan, 'v' | 'basis'>) => Promise<void> } = {},
): Promise<BulkPreview> {
  const plan = await buildPlan(companyId, scope, hooks);
  await hooks.savePlan?.({ token: plan.token, planned: plan.moving.map((p) => [p.id, p.comp.token]), skipped: plan.skipped });
  return {
    token: plan.token,
    invoices: plan.moving.slice(0, BULK_LIST_LIMIT).map((p) => ({
      id: p.id,
      invoiceNo: p.invoiceNo,
      carrierName: p.carrierName,
      currency: p.currency,
      before: { overchargeTotal: p.comp.totals.before.overchargeTotal },
      after: { overchargeTotal: p.comp.totals.after.overchargeTotal },
      changedLines: p.comp.changedLines,
    })),
    totalsByCurrency: currencyTotals(
      plan.moving.map((p) => ({ currency: p.currency, before: p.comp.totals.before.overchargeTotal, after: p.comp.totals.after.overchargeTotal })),
    ),
    changedInvoices: plan.moving.length,
    skippedInDispute: plan.skipped.length,
  };
}

/**
 * Onay. Plan (K4): önizleme işinin kaydettiği plan (`previewPlan`; dayanak değişmediyse ve genel özet planı tutuyorsa)
 * olduğu gibi alınır, yeniden hesaplanmaz. Kayıt yoksa (eski ya da temizlenmiş önizleme, kancasız çağrı) tüm önizleme
 * yeniden hesaplanır; toplu özet `token` ile tutmuyorsa (kapsam, rakam ya da itiraz durumu değişti) hiçbir fatura
 * yazılmaz, `'PREVIEW_STALE'` döner. Sonra faturalar sırayla, her biri önizlemedeki KENDİ özetiyle (`applyRecompare`
 * `expectedToken`) fatura kilidi altında yazılır; bu arada değişen fatura yazılmaz, `skipped.stale` olarak sayılır ve
 * `staleInvoices`'ta listelenir (yazılmış öbür faturalar geri alınmaz). Her yazılan fatura için `invoice.recalculate`
 * denetim kaydı.
 *
 * Kancalarla (arka plan işi, `BulkHooks`): doğrulanmış plan bir kez kaydedilir; sonraki deneme kaydedilmiş planın
 * `done`'dan sonrasını yazar (her fatura yine kendi özetiyle korunur; bu arada değişen `stale`, itiraza giren `inDispute`
 * sayılır). Önizlemeden sonra kapsama giren fatura plana girmediği için taşınmaz.
 */
export async function applyBulk(companyId: string, userId: string | null, scope: BulkScope, token: string, hooks: BulkHooks = {}): Promise<BulkApplyOutcome | 'PREVIEW_STALE'> {
  const resumed = await loadResume(hooks, token);
  let planned: BulkCheckpoint['planned'];
  let start = 0;
  let counters: BulkCounters;
  let stale: string[];
  if (resumed) {
    planned = resumed.checkpoint.planned;
    start = resumed.done;
    counters = resumed.counters;
    stale = resumed.stale;
  } else {
    const stored = await loadPreviewPlan(hooks, scope, token);
    if (stored === 'PREVIEW_STALE') return 'PREVIEW_STALE';
    let skippedInDispute: number;
    if (stored) {
      planned = stored.planned;
      skippedInDispute = stored.skipped.length;
    } else {
      const plan = await buildPlan(companyId, scope, hooks);
      if (plan.token !== token) return 'PREVIEW_STALE';
      planned = plan.moving.map((p) => [p.id, p.comp.token]);
      skippedInDispute = plan.skipped.length;
    }
    counters = { invoices: 0, lines: 0, inDispute: skippedInDispute, stale: 0 };
    stale = [];
    await hooks.onProgress?.({ stage: 'bulkWrite', done: 0, total: planned.length, counters });
    await hooks.checkpoint?.save({ v: 1, verifiedAt: new Date().toISOString(), token, planned, skippedInDispute }, counters);
  }
  const via = scope.kind === 'tariff' ? { kind: 'tariff', tariffId: scope.tariffId } : { kind: 'settings' };
  const cause = scope.kind === 'tariff' ? 'TARIFF' : 'RULES';
  let i = start;
  let paused = false;
  for (; i < planned.length; i++) {
    // fatura aralarında: durdurulunca yazılan faturalar yeni hâlinde kalır, kalanlar denenmez
    if (hooks.signal?.aborted) break;
    // Y57: bu çalıştırmada en az bir fatura denendi; başka firma bekliyorsa yuva bırakılır (kaldığı yer çitli ilerlemede)
    if (i > start && hooks.shouldPause && (await hooks.shouldPause())) {
      paused = true;
      break;
    }
    const [id, invoiceToken] = planned[i]!;
    const done = i + 1;
    const base = counters;
    const written: { counters: BulkCounters | null } = { counters: null };
    const r = await applyRecompare(id, {
      basis: basisOf(scope),
      scope: 'all',
      cause,
      expectedToken: invoiceToken,
      patient: true,
      // Fatura kilidi ve özet denetiminden sonra, satırlarla aynı işlemde: satır sayısı kilit altında (= yazım sonrası
      // `totals.lines`; yazım satır eklemez, silmez). Çit atarsa (kira bu çalıştırmada değil) faturanın yazımı geri alınır.
      onWrite: async (tx) => {
        const lines = await tx.invoiceLine.count({ where: { invoiceId: id } });
        written.counters = { ...base, invoices: base.invoices + 1, lines: base.lines + lines };
        await hooks.fence?.(tx, { done, counters: written.counters });
      },
    });
    if (r === null || r === 'PREVIEW_STALE') {
      counters = { ...base, stale: base.stale + 1 };
      // K4: listeye eklenir; liste dolduysa yalnız sayılır (sayaç ilerlemeyle birlikte yazılır)
      if (stale.length < BULK_LIST_LIMIT && !stale.includes(id)) {
        stale = [...stale, id];
        await hooks.checkpoint?.saveStale?.(stale, { done, counters });
      }
    } else if (typeof r === 'string') counters = { ...base, inDispute: base.inDispute + 1 };
    else {
      counters = written.counters ?? { ...base, invoices: base.invoices + 1, lines: base.lines + r.totals.lines };
      await audit(companyId, userId, 'invoice.recalculate', 'Invoice', id, { ...r.summary, via });
    }
    await hooks.onProgress?.({ stage: 'bulkWrite', done, total: planned.length, counters });
  }
  const stopped = planned.length - i;
  // K4: iş bütünüyle bittiyse (durdurulmadı, yuva bırakılmadı) kapsamda kalan fatura sayısı
  // Sayım düşerse iş düşmez ve yeniden denenmez (bütün faturalar yazıldı): alan yazılmaz, günlüğe uyarı
  let remaining = 0;
  if (!paused && stopped === 0) {
    try {
      remaining = await remainingInScope(companyId, scope);
    } catch (err) {
      hooks.warn?.(err, 'bulk recompare remaining count failed');
    }
  }
  return {
    invoices: counters.invoices,
    lines: counters.lines,
    skipped: { inDispute: counters.inDispute, stale: counters.stale },
    ...(counters.stale > 0 ? { staleInvoices: await staleList(companyId, stale) } : {}),
    ...(remaining > 0 ? { remaining } : {}),
    stopped,
    ...(paused ? { paused: true as const } : {}),
  };
}

/** K4: atlanan faturaların kısa kaydı, atlanma sırasıyla; bu arada silinen `deleted: true` ile (bağlantısız gösterilir). */
async function staleList(companyId: string, ids: string[]): Promise<BulkStaleInvoice[]> {
  if (!ids.length) return [];
  const rows = await prisma.invoice.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true, invoiceNo: true, deletedAt: true, carrier: { select: { name: true } } },
  });
  const by = new Map(
    rows.map((r) => [r.id, { id: r.id, invoiceNo: r.invoiceNo, carrierName: r.carrier.name, ...(r.deletedAt ? { deleted: true as const } : {}) }]),
  );
  return ids.flatMap((id) => by.get(id) ?? []);
}

/**
 * K4: uygulamadan sonra kapsamda (hâlâ eski dayanakta) kalan, etkin itirazı OLMAYAN fatura sayısı: bayat atlananlar,
 * önizlemeden sonra kapsama girenler ve önizlemede itirazdayken itirazı kapananlar. Yeni önizleme bunları gösterir
 * (hesapta başka tarifeye düşen fatura sayılır ama önizlemeye girmez; sayı üst sınırdır). Yalnız sayım, hesap yok.
 */
async function remainingInScope(companyId: string, scope: BulkScope): Promise<number> {
  const free: Prisma.InvoiceWhereInput = { NOT: { disputes: { some: activeRoundWhere } } };
  if (scope.kind === 'settings') {
    const ids = (await invoicesWithOtherSettings(companyId)).map((x) => x.id);
    if (!ids.length) return 0;
    return prisma.invoice.count({ where: { companyId, deletedAt: null, isSample: false, id: { in: ids }, ...free } });
  }
  const w = await tariffScopeWhere(companyId, scope.tariffId);
  return w ? prisma.invoice.count({ where: { AND: [w.scope, free] } }) : 0;
}

const isPlanned = (p: unknown): p is [string, string] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string';

/**
 * K4: önizlemenin kaydedilmiş planı bu onayın mı. Kanca `'PREVIEW_STALE'` dönerse (dayanak değişti, önizleme zaten
 * uygulandı) o geçer. Plan okunamıyorsa ya da genel özeti `token`'ı tutmuyorsa null: plan yeniden kurulur. Böylece yazılan
 * her fatura, kullanıcının onayladığı genel özetin içindeki kendi özetiyle yazılır.
 */
async function loadPreviewPlan(hooks: BulkHooks, scope: BulkScope, token: string): Promise<{ planned: [string, string][]; skipped: string[] } | 'PREVIEW_STALE' | null> {
  const r = await hooks.previewPlan?.load(token);
  if (r === 'PREVIEW_STALE') return r;
  const c = r as Partial<BulkPreviewPlan> | null | undefined;
  if (!c || c.v !== 1 || c.token !== token || !Array.isArray(c.planned) || !Array.isArray(c.skipped)) return null;
  if (!c.planned.every(isPlanned) || !c.skipped.every((x) => typeof x === 'string')) return null;
  if (new Set(c.planned.map((p) => p[0])).size !== c.planned.length) return null;
  if (planDigest(scope, c.planned, c.skipped) !== token) return null;
  return { planned: c.planned, skipped: c.skipped };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Kaydedilmiş plan bu onayın mı ve okunabilir mi. Değilse (bozuk kayıt, başka özet) yok sayılır: genel özet baştan
 * denetlenir; yazılmış fatura varsa özet tutmaz, hiçbir şey yazılmaz (`PREVIEW_STALE`). Çift yazım bu yoldan da doğmaz.
 */
async function loadResume(hooks: BulkHooks, token: string): Promise<{ checkpoint: BulkCheckpoint; done: number; counters: BulkCounters; stale: string[] } | null> {
  const r = await hooks.checkpoint?.load();
  if (!r) return null;
  const c = r.checkpoint as Partial<BulkCheckpoint> | null;
  if (!c || c.v !== 1 || c.token !== token || !isCount(c.skippedInDispute) || !Array.isArray(c.planned)) return null;
  if (!c.planned.every(isPlanned)) return null;
  if (!isCount(r.done) || r.done > c.planned.length) return null;
  const k = (r.counters ?? {}) as Partial<BulkCounters>;
  const counters =
    isCount(k.invoices) && isCount(k.lines) && isCount(k.inDispute) && isCount(k.stale)
      ? { invoices: k.invoices, lines: k.lines, inDispute: k.inDispute, stale: k.stale }
      : { invoices: 0, lines: 0, inDispute: c.skippedInDispute, stale: 0 };
  // K4: atlananlar listesi (eski kayıtta yok); bozuksa boş liste, sayı sayaçta kalır
  const stale = Array.isArray(c.stale) && c.stale.every((x) => typeof x === 'string') ? [...new Set(c.stale)].slice(0, BULK_LIST_LIMIT) : [];
  return { checkpoint: c as BulkCheckpoint, done: r.done, counters, stale };
}
