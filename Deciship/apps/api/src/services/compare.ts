import crypto from 'node:crypto';
import { t as coreMessage } from '@deciship/core';
import {
  compareLine,
  hardFlags,
  findBestTrackingMatch,
  invoiceHasMixedServices,
  isPakNote,
  normalizeTracking,
  overchargeReconciliation,
  trackingCandidates,
  type ComparisonResult,
  type OverchargeByType,
  type ReconStep,
  type DuplicatePrior,
  type FxRate,
  type MeasurementInput,
  type CarrierCode,
  type PackagingLimits,
  type ParsedInvoiceLine,
  type TariffInput,
  type WeightStep,
  uncheckedSurchargeTotal,
} from '@deciship/core';
import { prisma, Prisma, TX_DEFAULTS } from '../db.ts';
import { DEFAULT_SETTINGS, LEGACY_EDGE_TOL_CM, readSettings, type CompanySettings } from '../lib/settings.ts';
import { activeRoundWhere } from './disputes.ts';
import { fxKey, fxService } from './fx.ts';
import { lineResultChanged, writeLineResults, writeRecalcPending, type LineResultUpdate, type RecalcPendingMark } from './lineWrite.ts';
import { num, numOrNull, sum, yieldToLoop, YIELD_EVERY_ROWS } from '../lib/util.ts';
import { carrierCodeOf, effectivePackagingLimits, packagingOf } from '../lib/packaging.ts';
import { ensureTariffRevision, readAdjustments } from './tariffs.ts';

export type TariffWithRelations = Prisma.TariffGetPayload<{
  include: { zones: true; rates: true; overflow: true; surcharges: true };
}>;

export const tariffInclude = { zones: true, rates: true, overflow: true, surcharges: true } as const;

export function toTariffInput(t: TariffWithRelations): TariffInput {
  return {
    id: t.id,
    currency: t.currency,
    divisor: t.divisor,
    edgeRounding: t.edgeRounding,
    weightSteps: (Array.isArray(t.weightSteps) ? t.weightSteps : []) as WeightStep[],
    discountPct: num(t.discountPct),
    fuelPct: num(t.fuelPct),
    fuelVariable: t.fuelVariable,
    pakDiscountPct: numOrNull(t.pakDiscountPct),
    envelopeDiscountPct: numOrNull(t.envelopeDiscountPct),
    service: t.service,
    zones: Object.fromEntries(t.zones.map((z) => [z.country.toUpperCase(), z.zone])),
    rates: t.rates.map((r) => ({ zone: r.zone, weightUpto: num(r.weightUpto), price: num(r.price), perKg: r.perKg, packaging: r.packaging })),
    overflowPerUnit: t.overflow.length ? Object.fromEntries(t.overflow.map((o) => [o.zone, num(o.perUnit)])) : undefined,
    surcharges: t.surcharges.map((s) => ({ code: s.code, name: s.name, kind: s.kind, amount: num(s.amount) })),
    countryAdjustments: readAdjustments(t.countryAdjustments),
  };
}

/**
 * Taşıyıcının varsayılan tarifesi: etkin ve "Varsayılan" işaretli; yoksa en son güncellenen etkin tarife.
 * Hizmete ya da tarihe göre seçim yapılmaz (fatura tarifesi kullanıcı tarafından değiştirilir).
 */
export function defaultTariff<T extends { active: boolean; isDefault: boolean; updatedAt: Date }>(tariffs: T[]): T | null {
  const active = tariffs.filter((t) => t.active);
  if (!active.length) return null;
  return active.find((t) => t.isDefault) ?? [...active].sort((a, b) => +b.updatedAt - +a.updatedAt)[0]!;
}

/** Tarife bu günde geçerli mi (validFrom/validTo; tarih yoksa geçerli sayılır). */
export function tariffValidOn(t: { validFrom: Date | null; validTo: Date | null }, date: Date | null) {
  return !date || ((!t.validFrom || t.validFrom <= date) && (!t.validTo || t.validTo >= date));
}

/**
 * K2: yeni faturanın tarifesi, istemci tarife vermediyse (`POST /invoices`, başlık düzeltmesinde taşıyıcı değişimi).
 * Fatura gününde geçerli etkin tarife; birden çoksa önce "Varsayılan", sonra geçerlilik tarihi yazılı olan (dönem
 * tarifesi süresizden özeldir), sonra en son güncellenen. O gün geçerli tarife yoksa ya da gün bilinmiyorsa taşıyıcının
 * varsayılanı (`defaultTariff`). Web `src/lib/tariffPick.ts` aynı kuralla önseçer. Kayıtlı faturanın hesabı bu kurala
 * bakmaz (§3.12 `invoiceTariff`).
 */
export function tariffForDate<T extends { active: boolean; isDefault: boolean; updatedAt: Date; validFrom: Date | null; validTo: Date | null }>(
  tariffs: T[],
  date: Date | null,
): T | null {
  if (date) {
    const dated = (t: T) => (t.validFrom || t.validTo ? 1 : 0);
    const valid = tariffs
      .filter((t) => t.active && tariffValidOn(t, date))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || dated(b) - dated(a) || +b.updatedAt - +a.updatedAt);
    if (valid[0]) return valid[0];
  }
  return defaultTariff(tariffs);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Güncel dayanağın tarifesi: faturada seçilen (`fixedTariffId`), yoksa (eski faturalar / silinmiş tarife) taşıyıcının
 * varsayılan tarifesi. Yeni fatura ve "yeni tarifeyle hesapla" bu tarifenin bugünkü sürümüne bağlanır (`resolveCurrentBasis`);
 * kayıtlı faturanın hesabı ise sabit sürümünden yapılır.
 */
export function invoiceTariff<T extends { id: string; active: boolean; isDefault: boolean; updatedAt: Date }>(ctx: {
  tariffs: T[];
  fixedTariffId?: string | null;
}): T | null {
  return (ctx.fixedTariffId ? ctx.tariffs.find((x) => x.id === ctx.fixedTariffId) : null) ?? defaultTariff(ctx.tariffs);
}

/** Satır günü tarifenin geçerliliği dışındaysa satır notuna eklenen uyarı (satır yine de bu tarifeyle fiyatlanır). */
export function validityWarning(t: { name: string; validFrom: Date | null; validTo: Date | null }, date: Date) {
  if (tariffValidOn(t, date)) return null;
  const from = t.validFrom ? isoDay(t.validFrom) : '…';
  const to = t.validTo ? isoDay(t.validTo) : '…';
  return coreMessage('tr', 'stored.tariffNotValid', { name: t.name, date: isoDay(date), from, to });
}

type MeasurementLite = {
  id: string;
  trackingNo: string;
  trackingRaw: string;
  lengthCm: Prisma.Decimal;
  widthCm: Prisma.Decimal;
  heightCm: Prisma.Decimal;
  weightKg: Prisma.Decimal;
  measuredAt: Date;
  /** Zincirdeki sürüm sırası (1 = ilk kayıt, eski sürümü yok). KALANLAR 1.8: ölçüm tekrarı yalnız 1'den büyüklerde aranır. */
  version?: number;
  /** Gönderinin ambalajı (OWN / PAK / ENVELOPE); eski okuma yolunda yoksa kendi ambalajı. */
  packaging?: string;
};

/**
 * Ölçüm dizininin kapsamı (Y81): satır takip no'larının `find` içinde baktığı anahtarlar. `keys` = adayların son 10
 * karakteri (`bySuffix`), `raws` = kırpılmış ham değer (`byRaw`). Kapsamlı dizin yalnız bu anahtarlara dokunan ölçümleri
 * yükler; kapsam dışı bir takip no ile `find` çağrısı hata atar (sessizce "eşleşmedi" demez).
 */
export type MeasurementScope = { keys: Set<string>; raws: Set<string> };

const scopeKeys = (tracking: string) => trackingCandidates(tracking).map((c) => c.slice(-10));

export function measurementScope(trackings: readonly string[]): MeasurementScope {
  const keys = new Set<string>();
  const raws = new Set<string>();
  for (const t of trackings) {
    for (const k of scopeKeys(t)) keys.add(k);
    raws.add(t.trim());
  }
  return { keys, raws };
}

/**
 * Kapsamlı yüklemenin SQL'i, `cleanTracking` (core) ve `String.prototype.trim` kurallarının ASCII karşılığıdır: JS `\s`
 * ve `trim` ASCII'de yalnız bu altı karakteri siler, `toLocaleUpperCase('en-US')` ASCII'de yalnız a-z'yi çevirir
 * (test/measurementIndexScope.test.ts 0-127 arası her karakteri core ile karşılaştırır). ASCII dışı karakter taşıyan ölçüm
 * (büyük harf ve boşluk kuralları veritabanının yerel ayarına bağlı) her zaman yüklenir: küme eksiksiz bir üst kümedir,
 * asıl eşleşme yine bellekte `find` ile, eskisiyle aynı kodla yapılır.
 */
export const SCOPE_SQL_WS = '\t\n\v\f\r ';
export const SCOPE_SQL_SEPARATORS = `${SCOPE_SQL_WS}-`;
const SCOPE_SQL_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const SCOPE_SQL_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** In-memory index of a company's current measurements for tracking-number matching (SPEC 3.3). */
export class MeasurementIndex {
  private bySuffix = new Map<string, MeasurementLite[]>();
  private byRaw = new Map<string, MeasurementLite[]>();
  private readonly scope: MeasurementScope | null;
  /** Dizindeki ölçüm sayısı (test ve günlük için). */
  readonly size: number;
  /**
   * 02-B1: dizindeki ölçüm kimlikleri. Ölçümün her değişikliği kümeyi değiştirir (kayıt ve düzeltme yeni sürüm kimliği
   * getirir, silme kimliği düşürür, geri yükleme geri getirir): aynı kapsamla iki okuma arasında değişen ölçüm `movedMeasurements`.
   */
  readonly ids: ReadonlySet<string>;
  /**
   * KALANLAR 6.7: kimlik → sürüm numarası. Geç gelen eski ölçüm güncel kimliği değiştirmez ama zincire girip güncel sürümün
   * numarasını artırır (ölçüm tekrarı "İncele"yi değiştirir): `movedMeasurements` bunu da değişiklik sayar.
   */
  readonly versions: ReadonlyMap<string, number | null>;
  /** KALANLAR 1.8: eski sürümü olan (sürüm > 1; sürümü bilinmeyen de) ölçümler: ölçüm tekrarı yalnız bunlarda aranır. */
  readonly revisedIds: readonly string[];

  /** `scope` verilirse dizin yalnız o takip no'lar için kurulmuştur (`load(companyId, trackings)`). */
  constructor(items: MeasurementLite[], scope: MeasurementScope | null = null) {
    this.scope = scope;
    this.size = items.length;
    this.ids = new Set(items.map((m) => m.id));
    this.versions = new Map(items.map((m) => [m.id, m.version ?? null]));
    this.revisedIds = items.filter((m) => m.version == null || m.version > 1).map((m) => m.id);
    // newest first so ties resolve to the latest measurement
    for (const m of [...items].sort((a, b) => +b.measuredAt - +a.measuredAt)) {
      for (const c of trackingCandidates(m.trackingNo).concat(trackingCandidates(m.trackingRaw))) {
        const key = c.slice(-10);
        const list = this.bySuffix.get(key) ?? [];
        if (!list.includes(m)) list.push(m);
        this.bySuffix.set(key, list);
      }
      const raw = m.trackingRaw.trim();
      this.byRaw.set(raw, [...(this.byRaw.get(raw) ?? []), m]);
    }
  }

  /**
   * Firmanın güncel ölçümleri. `trackings` verilmezse hepsi; verilirse (Y81) yalnız bu takip no'ların `find` içinde
   * bakacağı anahtarlara dokunanlar (üst küme, yukarıdaki SQL notu). Eşleşme sonucu iki yolda birebir aynıdır
   * (test/measurementIndexScope.test.ts). Sıra iki yolda da ölçüm anı (yeniden eskiye), eşitlikte kimlik. `db`: açık işlemin
   * istemcisi (02-B1: içe aktarma ölçüm kümesini yazım işleminin içinde yeniden okur).
   */
  static async load(companyId: string, trackings?: readonly string[], db: Db = prisma) {
    if (!trackings) {
      const items = await db.measurement.findMany({
        where: { companyId, supersededById: null, deletedAt: null },
        select: {
          id: true,
          trackingNo: true,
          trackingRaw: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
          weightKg: true,
          measuredAt: true,
          version: true,
          packaging: true,
        },
        orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      });
      return new MeasurementIndex(items);
    }
    const scope = measurementScope(trackings);
    if (!scope.keys.size && !scope.raws.size) return new MeasurementIndex([], scope);
    const keys = [...scope.keys];
    const raws = [...scope.raws];
    const clean = (col: Prisma.Sql) => Prisma.sql`right(translate(translate(${col}, ${SCOPE_SQL_SEPARATORS}, ''), ${SCOPE_SQL_LOWER}, ${SCOPE_SQL_UPPER}), 10)`;
    const items = await db.$queryRaw<MeasurementLite[]>`
      SELECT m."id", m."trackingNo", m."trackingRaw", m."lengthCm", m."widthCm", m."heightCm", m."weightKg", m."measuredAt", m."version",
        m."packaging"::text AS "packaging"
      FROM "Measurement" m
      WHERE m."companyId" = ${companyId} AND m."supersededById" IS NULL AND m."deletedAt" IS NULL
        AND (
          octet_length(m."trackingNo") <> char_length(m."trackingNo")
          OR octet_length(m."trackingRaw") <> char_length(m."trackingRaw")
          OR ${clean(Prisma.sql`m."trackingNo"`)} = ANY(${keys}::text[])
          OR ${clean(Prisma.sql`m."trackingRaw"`)} = ANY(${keys}::text[])
          OR btrim(m."trackingRaw", ${SCOPE_SQL_WS}) = ANY(${raws}::text[])
        )
      ORDER BY m."measuredAt" DESC, m."createdAt" DESC, m."id" ASC`;
    return new MeasurementIndex(items, scope);
  }

  find(trackingRaw: string): MeasurementLite | null {
    const scope = this.scope;
    if (scope && (!scope.raws.has(trackingRaw.trim()) || scopeKeys(trackingRaw).some((k) => !scope.keys.has(k)))) {
      // programlama hatası: dizin bu takip no için kurulmadı (buildContext'e satırların ham takip no'ları verilmeli)
      throw new Error('MeasurementIndex.find: takip no dizinin kapsamında değil');
    }
    const pool: MeasurementLite[] = [];
    for (const c of trackingCandidates(trackingRaw)) {
      for (const m of this.bySuffix.get(c.slice(-10)) ?? []) if (!pool.includes(m)) pool.push(m);
    }
    for (const m of this.byRaw.get(trackingRaw.trim()) ?? []) if (!pool.includes(m)) pool.push(m);
    if (!pool.length) return null;
    return findBestTrackingMatch(trackingRaw, pool, (m) => m.trackingNo);
  }
}

/**
 * 02-B1: iki okuma arasında değişen ölçümler (birinde olup öbüründe olmayan kimlikler), sıralı. KALANLAR 6.7: iki okumada da
 * olup sürüm numarası değişen kimlik de (geç gelen eski ölçüm zincire girdi).
 */
export function movedMeasurements(before: MeasurementIndex, after: MeasurementIndex): string[] {
  const out = new Set<string>();
  for (const id of before.ids) if (!after.ids.has(id) || after.versions.get(id) !== before.versions.get(id)) out.add(id);
  for (const id of after.ids) if (!before.ids.has(id)) out.add(id);
  return [...out].sort();
}

/**
 * Firma içi fatura içe aktarmalarının danışma kilidi (`POST /invoices` yazım işlemi özel olarak alır). Ölçüm sonrası
 * karşılaştırma eşleşen satırları ararken, mükerrer işareti de sonraki faturaları seçerken aynı kilidi PAYLAŞIMLI alır
 * (02-B1, 07-B1): süren içe aktarmanın yazım işlemi bitene dek bekler, sonra yeni faturayı görür; ya da içe aktarma onların
 * değişikliğini kilit altında görür. İki taraf aynı adı kullanmalı.
 */
export const importLockName = (companyId: string) => `invoice-import:${companyId}`;

/** Kilidi bekleyen kısa işlem: içe aktarmanın yazım işleminin süresi (120 sn) kadar bekleyebilir. */
const IMPORT_WAIT_TX = { maxWait: TX_DEFAULTS.maxWait, timeout: 130_000 } as const;

/**
 * Paylaşımlı içe aktarma kilidi. Kilit sırası: işlemin İLK kilidi olmalı (fatura satır kilidinden önce). Satır kilidini
 * tutarken beklenirse kilitlenme olur: A faturasının düzeltmesi A'yı tutup bu kilidi bekler (sırada özel kilit isteyen içe
 * aktarma var), B'nin düzeltmesi kilidi almış ve A'ya işaret yazarken (`InvoiceRecheck` yabancı anahtarı) A'yı bekler, içe
 * aktarma da B'yi bekler. Aynı işlemde ikinci kez almak beklemez.
 */
export async function lockImportsShared(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${importLockName(companyId)}, 0))`;
}

/** Özel içe aktarma kilidi (fatura, örnek fatura ve deneme faturasının yazım işlemi; işlemin ilk kilidi). */
export async function lockImportsExclusive(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${importLockName(companyId)}, 0))`;
}

/** Önceki satırların karşılaştırılabilir hâli (anahtar sırası sabit). */
const priorsKey = (m: Map<string, PriorLine[]>) => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * İçe aktarmanın yazım işleminde, özel kilit alındıktan sonra: karşılaştırma kilitten önce yapıldı, bu arada değişen girdi
 * kilit altında yeniden okunur.
 *  - `stalePriors` (07-B1): aynı takip numaralarının önceki faturalardaki görünümü (satır, taşıyıcı, fatura no, para birimi,
 *    tutar) değişti. Yalnız satır sayısına bakmak yetmez: önceki faturanın başlık düzeltmesi sayıyı değiştirmez ama mükerrerin
 *    kesinliğini değiştirir; düzeltmenin kendi işareti (`markLaterDuplicates`) henüz yazılmamış bu faturayı göremedi.
 *  - `movedMarks` (02-B1): değişen ölçümlerin işareti bu işlemde yeniden yazılır (`markMeasurementsPending`).
 * Çağıran, ikisinden biri doluysa fatura yazıldıktan sonra yeniden karşılaştırır. `trackingNos` ve `indexTrackings`
 * `buildContext`'e verilenlerin aynısı olmalı.
 */
export async function importRecheck(
  tx: Prisma.TransactionClient,
  companyId: string,
  ctx: CompareContext,
  trackingNos: string[],
  indexTrackings: readonly string[],
  isSample: boolean,
): Promise<{ stalePriors: boolean; movedMarks: { id: string; pendingAt: Date }[] }> {
  const stalePriors = isSample ? false : priorsKey(await previouslyBilled(companyId, [...new Set(trackingNos)], null, tx)) !== priorsKey(ctx.priorLines);
  const moved = movedMeasurements(ctx.index, await MeasurementIndex.load(companyId, indexTrackings, tx));
  return { stalePriors, movedMarks: await markMeasurementsPending(tx, companyId, moved) };
}

/**
 * Bekleyen işaretin yazılacağı değer: verilen an, ya da satırdaki değer bundan yeniyse ondan 1 ms sonrası. İşaret yalnız aynı
 * değerle boşaldığı için yeni yazılan değer, sürmekte olan eski karşılaştırmanın boşaltmasını her zaman boşa çıkarır.
 */
const bumpPending = (col: Prisma.Sql, at: Date) =>
  Prisma.sql`CASE WHEN ${col} IS NOT NULL AND ${col} >= ${at}::timestamp(3) THEN ${col} + interval '1 millisecond' ELSE ${at}::timestamp(3) END`;

/**
 * 02-B1: içe aktarmanın yazım işleminde, karşılaştırmadan sonra değiştiği görülen ölçümlerin bekleyen işareti yeniden yazılır
 * (aynı işlemde: fatura yazılırsa işaret de yazılır). Ölçümün kendi karşılaştırması faturayı görmeden işaretini boşaltmış
 * olabilir; yeni değer sıraya girer ya da taramaya kalır, karşılaştırma bu kez faturayı görür. Deneme sayısı sıfırlanır.
 */
export async function markMeasurementsPending(tx: Prisma.TransactionClient, companyId: string, ids: string[]): Promise<{ id: string; pendingAt: Date }[]> {
  if (!ids.length) return [];
  const col = Prisma.sql`"recomparePendingAt"`;
  return tx.$queryRaw<{ id: string; pendingAt: Date }[]>`
    UPDATE "Measurement" SET "recomparePendingAt" = ${bumpPending(col, new Date())}, "recompareAttempts" = 0
    WHERE "companyId" = ${companyId} AND "id" = ANY(${ids}::text[])
    RETURNING "id", "recomparePendingAt" AS "pendingAt"`;
}

export function toMeasurementInput(m: MeasurementLite): MeasurementInput {
  return {
    id: m.id,
    dims: { l: num(m.lengthCm), w: num(m.widthCm), h: num(m.heightCm) },
    actualKg: num(m.weightKg),
    measuredAt: m.measuredAt.toISOString(),
    packaging: packagingOf(m.packaging),
  };
}

type LineRow = Prisma.InvoiceLineGetPayload<object>;
/** Faturanın kendi sütunları (ilişkisiz satır). */
export type InvoiceRow = Prisma.InvoiceGetPayload<object>;

export function lineRowToParsed(l: LineRow): ParsedInvoiceLine {
  const dims =
    l.dimL != null && l.dimW != null && l.dimH != null ? { l: num(l.dimL), w: num(l.dimW), h: num(l.dimH) } : undefined;
  return {
    rowIndex: l.rowIndex,
    trackingNo: l.trackingNo,
    shipDate: l.shipDate ? l.shipDate.toISOString().slice(0, 10) : undefined,
    service: l.service ?? undefined,
    destCountry: l.destCountry ?? undefined,
    actualKg: l.actualKg != null ? num(l.actualKg) : undefined,
    billedKg: l.billedKg != null ? num(l.billedKg) : undefined,
    dims,
    billedDivisor: l.billedDivisor ?? undefined,
    baseAmount: l.baseAmount != null ? num(l.baseAmount) : undefined,
    discountAmount: l.discountAmount != null ? num(l.discountAmount) : undefined,
    fuelAmount: l.fuelAmount != null ? num(l.fuelAmount) : undefined,
    surcharges: (Array.isArray(l.surcharges) ? l.surcharges : []) as ParsedInvoiceLine['surcharges'],
    netAmount: num(l.netAmount),
    currency: l.currency ?? undefined,
    reference: l.reference ?? undefined,
    packaging: l.packaging ?? undefined,
    rawHash: l.rawHash,
  };
}

export function resultToLineData(
  r: ComparisonResult,
  measurementId: string | null,
  tariffId: string | null,
  /** Sonucun hesaplandığı tarife sürümü (`compareAll` çıktısındaki `tariffRevisionId`); verilmezse boş yazılır. */
  tariffRevisionId: string | null = null,
) {
  return {
    measurementId,
    tariffId,
    tariffRevisionId,
    status: r.status,
    diffTypes: r.diffTypes,
    ourChargeableKg: r.ourChargeableKg,
    billedChargeableKg: r.billedChargeableKg,
    expectedAmount: r.expectedAmount,
    diffAmount: r.diffAmount,
    breakdown: r.breakdown,
    pricing: linePricing(r, tariffId != null),
    note: r.note ?? null,
  };
}

/** Satırın `pricing` JSON'u (SPEC §3.8); fiyat bilgisi hiç yoksa null. */
export type LinePricing = {
  basis: ComparisonResult['pricingBasis'];
  rateDeviationPct: number | null;
  confidence: ComparisonResult['confidence'];
  confidenceReason: string | null;
  /** "İncele" gerekçesinin sınıfı (SERVICE, DUPLICATE, …); kesin satırda ve eski kayıtlarda yok. */
  reviewCode?: ComparisonResult['reviewCode'];
  zone: string | null;
  rateKg: number | null;
  mode: 'split' | 'combined' | null;
  adjustmentPct: number;
  /** faturadaki yakıt oranı (%) */
  fuelPct?: number | null;
  /** Y18: hesapta saklı (bayat) kur kullanıldı; o kurun yayın günü (ISO). Yalnız o durumda var. */
  fxStale?: string;
  /** Beklenen taşıyıcı poşeti / zarfı fiyatıyla hesaplandıysa o ambalaj (itiraz metni); kendi ambalajında yok. */
  pricedPackaging?: 'PAK' | 'ENVELOPE';
};

/**
 * Satır bir tarifeyle karşılaştırıldıysa fiyat kaydı her zaman yazılır (fiyat kontrol edilemediyse alanlar boş):
 * böylece "bu özellikten önce karşılaştırılmış" (pricing = null) satır, kontrol edilip fiyatı bulunamayan satırdan ayrılır
 * (ör. ölçümü olmayan, tarifede ülkesi/ağırlığı olmayan satırlar; tarife uyumu raporu bunları "kontrol edilemedi" sayar).
 */
export function linePricing(r: ComparisonResult, withTariff = false): LinePricing | null {
  if (!withTariff && r.pricingBasis == null && r.rate == null && r.confidence === 'HIGH') return null;
  return {
    basis: r.pricingBasis,
    rateDeviationPct: r.rateDeviationPct,
    confidence: r.confidence,
    confidenceReason: r.confidenceReason,
    ...(r.reviewCode ? { reviewCode: r.reviewCode } : {}),
    zone: r.rate?.zone ?? null,
    rateKg: r.rate?.kg ?? null,
    mode: r.rate?.mode ?? null,
    adjustmentPct: r.rate?.adjustmentPct ?? 0,
    fuelPct: r.rate?.fuelPct ?? null,
    ...(r.fxStale ? { fxStale: r.fxStale } : {}),
    ...(r.pricedPackaging ? { pricedPackaging: r.pricedPackaging } : {}),
  };
}

/** DB'deki `pricing` JSON'u; eski satırlarda null. */
export function readLinePricing(v: unknown): LinePricing | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as LinePricing) : null;
}

/** Satır tahmini mi (LOW güven)? Eski satırlar (pricing yok) kesin sayılır. */
export const isEstimated = (pricing: unknown) => readLinePricing(pricing)?.confidence === 'LOW';

export function parsedToLineData(p: ParsedInvoiceLine) {
  const shipDate = p.shipDate ? new Date(`${p.shipDate.slice(0, 10)}T00:00:00.000Z`) : null;
  return {
    rowIndex: p.rowIndex,
    trackingNo: normalizeTracking(p.trackingNo),
    shipDate: shipDate && !Number.isNaN(shipDate.getTime()) ? shipDate : null,
    service: p.service ?? null,
    destCountry: p.destCountry ? p.destCountry.toUpperCase() : null,
    actualKg: p.actualKg ?? null,
    billedKg: p.billedKg ?? null,
    dimL: p.dims?.l ?? null,
    dimW: p.dims?.w ?? null,
    dimH: p.dims?.h ?? null,
    billedDivisor: p.billedDivisor != null ? Math.round(p.billedDivisor) : null,
    baseAmount: p.baseAmount ?? null,
    discountAmount: p.discountAmount ?? null,
    fuelAmount: p.fuelAmount ?? null,
    surcharges: p.surcharges ?? [],
    netAmount: p.netAmount,
    currency: p.currency ?? null,
    reference: p.reference ?? null,
    packaging: p.packaging ?? null,
    rawHash: p.rawHash,
  };
}

export type InvoiceTotals = {
  lines: number;
  match: number;
  diff: number;
  unmatched: number;
  noTariff: number;
  billedTotal: number;
  /**
   * Karşılaştırılan (beklenen tutarı hesaplanan) satırların faturalanan toplamı; tarifede olmayan ek ücretler DAHİL
   * (Beklenen de onları faturadaki tutarıyla içerir, yani ikisi aynı kalemleri kapsar).
   */
  comparedBilledTotal: number;
  /** Pak/zarf (kapsam dışı) satırları: `unmatched` ve `noTariff` sayılarının içindedir; özet cümlesinde ayrı söylenir. */
  pakUnmatched: number;
  pakNoTariff: number;
  expectedTotal: number;
  /** Kesin (HIGH güvenli) fark satırlarının fazlası; tahmini satırlar `estimatedOverchargeTotal`'da. */
  overchargeTotal: number;
  /** SPEC §3.8: tahmini (LOW güvenli) fark satırlarının fazlası; Fazla ödeme'ye girmez. */
  estimatedOverchargeTotal: number;
  /** Tahmini fark satırı sayısı. */
  estimatedLines: number;
  verifiedTotal: number;
  /** Tarifede tanımlı olmayan, Beklenen'e faturadaki tutarıyla eklenen ek ücretlerin toplamı (Fazla ödeme'yi etkilemez). */
  uncheckedSurchargeTotal: number;
  /** SPEC §11: okuma bayrağı olan ve "Kontrol ettim" denmemiş satırlar. */
  /** Fark olup uyumlu sayılan satır. `diff` bunları da sayar: "Fark var" sekmesi çıkarır. */
  acceptedLines: number;
  flaggedLines: number;
  /** SPEC §FX: TCMB yanıt vermediği için kuru alınamayan satırlar (Yeniden karşılaştır ile tekrar denenir). */
  fxMissing: number;
  /**
   * Y18 (inceleme): saklı (bayat) kurla hesaplanan satır (`pricing.fxStale`); "İncele" sayılır, fazla ödemeye girmez.
   * Yalnız sıfırdan büyükse yazılır (eski toplamlar ve toplam karşılaştıran testler değişmez).
   */
  fxStale?: number;
  /** Donmuş (karar verilmiş ya da itirazdaki) satırlardan, yeni hesabı kayıtlı sonuçtan farklı çıkıp bekleyenler (`recalcPending`). */
  pendingLines: number;
  /**
   * Mesaj 5 (08-B10): "Fazla ödeme" rakamının adımları (Faturalanan − Beklenen'den başlayıp `overchargeTotal`'a varır).
   * Adımların toplamı = `overchargeTotal`, kuruşu kuruşuna. Mesaj 5 öncesi kayıtlı toplamlarda yok.
   */
  reconciliation?: { steps: ReconStep[]; overchargeTotal: number };
  /** Fazla ödeme, satırın ilk fark türüne göre (Pano ile aynı), büyükten küçüğe; toplamı = `overchargeTotal`. Eski kayıtlarda yok. */
  overchargeByType?: OverchargeByType[];
};

/** Ağ hatasıyla kuru alınamayan satırın notu (computeTotals bu önekle sayar). */
export const FX_FAILED_NOTE_PREFIX = 'Kur alınamadı';

/** Fazla ödeme kümesi: karşılaştırmada fark çıkmış, kabul edilmemiş, tutarı tahmini olmayan satır. Pano ve toplamlar bunu kullanır. */
export function countsAsOvercharge(l: { status: string; decision: string; pricing?: unknown }): boolean {
  return l.status === 'DIFF' && l.decision !== 'ACCEPTED' && !isEstimated(l.pricing);
}

export function computeTotals(
  lines: {
    status: string;
    netAmount: unknown;
    expectedAmount: unknown;
    diffAmount: unknown;
    breakdown?: unknown;
    decision: string;
    parseFlags?: string[];
    parseChecked?: boolean;
    note?: string | null;
    pricing?: unknown;
    recalcPending?: string | null;
    /** Fazla ödemenin türlere göre kırılımı için (ilk tür sayılır); toplam yazan her yol taşır. */
    diffTypes: readonly string[];
  }[],
): InvoiceTotals {
  const fxStale = lines.filter((l) => readLinePricing(l.pricing)?.fxStale).length;
  const diffPositive = (l: (typeof lines)[number]) => Math.max(0, num(l.diffAmount as number));
  const openDiff = lines.filter((l) => l.status === 'DIFF' && l.decision !== 'ACCEPTED');
  const estimated = openDiff.filter((l) => isEstimated(l.pricing));
  // Açıklama yalnız anlatır: `overchargeTotal` aşağıdaki kuralla hesaplanır, adımlar ona eşit çıkar (testle sabit).
  const explained = overchargeReconciliation(
    lines.map((l) => ({
      status: l.status,
      decision: l.decision,
      expectedAmount: numOrNull(l.expectedAmount as number | null),
      diffAmount: numOrNull(l.diffAmount as number | null),
      diffTypes: l.diffTypes,
      estimated: isEstimated(l.pricing),
    })),
  );
  return {
    lines: lines.length,
    match: lines.filter((l) => l.status === 'MATCH').length,
    diff: lines.filter((l) => l.status === 'DIFF').length,
    unmatched: lines.filter((l) => l.status === 'UNMATCHED').length,
    noTariff: lines.filter((l) => l.status === 'NO_TARIFF').length,
    billedTotal: sum(lines.map((l) => num(l.netAmount as number))),
    comparedBilledTotal: sum(lines.filter((l) => l.expectedAmount != null).map((l) => num(l.netAmount as number))),
    pakUnmatched: lines.filter((l) => l.status === 'UNMATCHED' && isPakNote(l.note)).length,
    pakNoTariff: lines.filter((l) => l.status === 'NO_TARIFF' && isPakNote(l.note)).length,
    expectedTotal: sum(lines.filter((l) => l.expectedAmount != null).map((l) => num(l.expectedAmount as number))),
    overchargeTotal: sum(lines.filter(countsAsOvercharge).map(diffPositive)),
    estimatedOverchargeTotal: sum(estimated.map(diffPositive)),
    estimatedLines: estimated.filter((l) => diffPositive(l) > 0).length,
    verifiedTotal: sum(lines.filter((l) => l.status === 'DIFF' && l.decision === 'VERIFIED').map(diffPositive)),
    // yalnız karşılaştırılan satırlarda oluşur (Beklenen'in içindeki payı)
    uncheckedSurchargeTotal: sum(lines.filter((l) => l.expectedAmount != null).map((l) => uncheckedSurchargeTotal(l.breakdown))),
    acceptedLines: lines.filter((l) => l.status === 'DIFF' && l.decision === 'ACCEPTED').length,
    flaggedLines: lines.filter((l) => hardFlags(l.parseFlags ?? []).length > 0 && !l.parseChecked).length,
    fxMissing: lines.filter((l) => l.status === 'NO_TARIFF' && l.note?.startsWith(FX_FAILED_NOTE_PREFIX)).length,
    ...(fxStale ? { fxStale } : {}),
    pendingLines: lines.filter((l) => l.recalcPending != null).length,
    reconciliation: explained.reconciliation,
    overchargeByType: explained.overchargeByType,
  };
}

/**
 * Faturayı satır kilidiyle kilitler (lockInvoice ile aynı kilit, silinmiş fatura da kilitlenir). Toplam yazan her yol bunu
 * alır: iki karar ya da karar ile yeniden karşılaştırma sıraya girer.
 */
async function lockInvoiceRow(tx: Prisma.TransactionClient, invoiceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
}

/**
 * Fatura toplamını satırlardan yeniden yazar (05-B2). Satırlar fatura kilidi alındıktan sonra okunur: READ COMMITTED'da
 * kilitten sonraki okuma o ana kadar işlenmiş her satır değişikliğini görür. Satırı değiştiren her istek ardından bunu
 * çağırdığı için en son kilidi alan en güncel satırları yazar; kilitsiz okusaydı eski satırları okumuş geç kalan istek
 * yeni toplamın üstüne eskisini yazardı. `tx` verilirse satır değişikliğiyle aynı işlemde çalışır.
 */
export async function refreshTotals(
  invoiceId: string,
  tx?: Prisma.TransactionClient,
  /**
   * Mesaj 5 (Y15): `calculatedAt` = motorun faturayı son koştuğu an. Yalnız `writeRecompare` verir (hesapla aynı işlemde);
   * karar, not, "Kontrol ettim" ve yalnız toplam yazan yollar vermez, damga ilerlemez.
   */
  calculatedAt?: Date,
): Promise<InvoiceTotals> {
  if (!tx) return prisma.$transaction((t) => refreshTotals(invoiceId, t, calculatedAt), TX_DEFAULTS);
  await lockInvoiceRow(tx, invoiceId);
  return (await writeTotalsLocked(tx, invoiceId, calculatedAt)).totals;
}

/**
 * `refreshTotals`'ın gövdesi: fatura kilidi bu işlemde ZATEN alınmış olmalı (`writeRecompare` başta alır). `extra`:
 * aynı güncellemeye eklenen başlık ve dayanak alanları. Güncellenen fatura satırını da döner (uç yeniden okumasın).
 */
async function writeTotalsLocked(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  calculatedAt?: Date,
  extra: Prisma.InvoiceUncheckedUpdateInput = {},
): Promise<{ totals: InvoiceTotals; invoice: InvoiceRow }> {
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    select: {
      status: true,
      netAmount: true,
      expectedAmount: true,
      diffAmount: true,
      breakdown: true,
      decision: true,
      parseFlags: true,
      parseChecked: true,
      note: true,
      pricing: true,
      recalcPending: true,
      diffTypes: true,
    },
  });
  const totals = computeTotals(lines);
  const invoice = await tx.invoice.update({ where: { id: invoiceId }, data: { ...extra, totals, ...(calculatedAt ? { calculatedAt } : {}) } });
  return { totals, invoice };
}

/**
 * Bir takip numarasının daha önceki bir faturadaki görünümü (mükerrer kararı için: taşıyıcı ve tutar). Eksi tutar iadedir
 * (önceki görünüm sayılmaz, `cancelCredits` eşit tutarlı ücreti iptal eder).
 */
/** `description`: satırın açıklaması (`lineDescription`); verilmezse bilinmiyor (aynı sayılır). */
export type PriorLine = { carrierId: string; invoiceNo: string; netAmount: number; currency: string | null; description?: LineDescription };

/** KALANLAR 1.8: satırın açıklaması (`lineDescription`): normalleştirilmiş hizmet adı ve sıralı ek ücret kodları. */
export type LineDescription = { service: string; codes: string[] };

/**
 * KALANLAR 1.8: satırın açıklaması, mükerrer kuralı için: hizmet adı (boşluk ve büyük/küçük harf yok sayılır) + ek ücret
 * kodları (sıralı). Aynı tutarlı iki satırın açıklaması farklıysa (göndericiye iade, ek hizmet) mükerrer kesin sayılmaz
 * (`sameLineDescription`).
 */
const DOTLESS_I = String.fromCharCode(0x131);

export function lineDescription(service: string | null | undefined, surcharges: unknown): LineDescription {
  // I/ı/İ/i aynı sayılır (Türkçe ve İngilizce yazım: "INTERNATIONAL" = "international")
  const svc = (service ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR').split(DOTLESS_I).join('i');
  const list = Array.isArray(surcharges) ? surcharges : [];
  const codes = list
    .map((s) => (s && typeof s === 'object' && 'code' in s ? String((s as { code: unknown }).code ?? '').trim().toUpperCase() : ''))
    .filter(Boolean)
    .sort();
  return { service: svc, codes };
}

/**
 * İki açıklama farklı mı? Yalnız iki tarafta da bilinen kısım karşılaştırılır (bağımsız inceleme): bir tarafta hizmet adı
 * boşsa (hizmet sütunu o faturada yok) hizmet, bir tarafta ek ücret kodu yoksa (ek ücret sütunları yalnız birinde eşlenmiş)
 * ek ücretler yok sayılır. Bilinmeyen kısım farklılık sayılmaz: gerçek mükerrer kesin kalır.
 */
export function sameLineDescription(a: LineDescription, b: LineDescription): boolean {
  if (a.service && b.service && a.service !== b.service) return false;
  if (a.codes.length && b.codes.length && a.codes.join(',') !== b.codes.join(',')) return false;
  return true;
}

/**
 * Takip numaralarının firmanın daha önceki (silinmemiş) faturalarındaki satırları, eskiden yeniye. Örnek faturalar sayılmaz.
 * KARARLAR "Mükerrer": kesin sayılması için aynı taşıyıcı ve aynı tutar gerekir; bu yüzden yalnız numara değil satır okunur
 * (indeks: companyId, trackingNo, invoiceId — migration 20261106030000; eşleşen az sayıda satır için tabloya gidilir).
 * Eksi tutarlı (iade / düzeltme) ve sıfır tutarlı (ücretsiz) satırlar da döner ama önceki görünüm sayılmaz (01-B11;
 * kullanıcı kararı 2026-11-13): önce yüklenen iade ya da ücretsiz satır, asıl ücreti mükerrer yapmaz. İade, tutarı eşit önceki ücreti iptal eder (inceleme 2026-11-13, `cancelCredits`).
 */
async function previouslyBilled(companyId: string, trackingNos: string[], before: { id: string; createdAt: Date } | null, db: Db = prisma) {
  const out = new Map<string, PriorLine[]>();
  if (!trackingNos.length) return out;
  const earlier = before
    ? Prisma.sql`AND i."id" <> ${before.id} AND i."createdAt" < (SELECT b."createdAt" FROM "Invoice" b WHERE b."id" = ${before.id})`
    : Prisma.empty;
  const rows = await db.$queryRaw<
    { trackingNo: string; carrierId: string; invoiceNo: string; netAmount: Prisma.Decimal; currency: string | null; service: string | null; surcharges: unknown }[]
  >`
    SELECT l."trackingNo", i."carrierId", i."invoiceNo", l."netAmount", COALESCE(l."currency", i."currency") AS "currency", l."service", l."surcharges"
    FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE l."companyId" = ${companyId} AND l."trackingNo" = ANY(${trackingNos}::text[]) AND i."deletedAt" IS NULL AND NOT i."isSample" ${earlier}
    ORDER BY i."createdAt", i."id", l."rowIndex"`;
  for (const r of rows) {
    const list = out.get(r.trackingNo) ?? [];
    list.push({
      carrierId: r.carrierId,
      invoiceNo: r.invoiceNo,
      netAmount: num(r.netAmount),
      currency: r.currency ? r.currency.toUpperCase() : null,
      description: lineDescription(r.service, r.surcharges),
    });
    out.set(r.trackingNo, list);
  }
  return out;
}

const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Satır para birimiyle tutar (para birimi bilinmiyorsa her para birimine eşleşir). */
export type LineMoney = { amount: number; currency: string | null | undefined };

/**
 * İnceleme 2026-11-13: iptal edilip yeniden faturalanan gönderi mükerrer değildir. Tutarı (mutlak) bir ücrete eşit iade o
 * ücreti iptal eder; ikisi de önceki görünüm sayılmaz. Sıra: önceki faturaların iadeleri (eskiden yeniye) kendilerinden önce
 * gelen aynı taşıyıcının ücretlerini; bu dosyanın iadeleri (`fileCredits`, bu taşıyıcının) önce kalan önceki ücretleri, yoksa
 * bu dosyadaki eşit tutarlı bir ücreti (`fileCancels`: dosyada görünüm sayılmayacak ücret tutarları) iptal eder. İade en son
 * ücreti iptal eder. Hiçbir ücrete eşit olmayan iade `unmatchedCredit` olur (kısmi iade ya da düzeltme): mükerrer kesin
 * sayılmaz. Saf; `charges` yalnız artı tutarlı görünümlerdir: sıfır tutarlı (ücretsiz) satır önceki görünüm sayılmaz
 * (kullanıcı kararı 2026-11-13).
 */
export function cancelCredits(
  priors: readonly PriorLine[],
  fileCredits: readonly LineMoney[],
  fileCharges: readonly LineMoney[],
  carrierId: string | undefined,
): { charges: PriorLine[]; fileCancels: LineMoney[]; unmatchedCredit: boolean } {
  const sameCur = (a: string | null | undefined, b: string | null | undefined) => !a || !b || a === b;
  const charges: PriorLine[] = [];
  let unmatchedCredit = false;
  const cancelPrior = (amount: number, currency: string | null | undefined, carrier: string | undefined) => {
    for (let k = charges.length - 1; k >= 0; k--) {
      const c = charges[k]!;
      if ((!carrier || c.carrierId === carrier) && sameCur(c.currency, currency) && sameMoney(c.netAmount, amount)) {
        charges.splice(k, 1);
        return true;
      }
    }
    return false;
  };
  for (const p of priors) {
    if (p.netAmount > 0) charges.push(p);
    else if (p.netAmount === 0) continue;
    // inceleme 2: yalnız bu taşıyıcının tutmayan iadesi mükerreri "İncele" yapar
    else if (!cancelPrior(-p.netAmount, p.currency, p.carrierId) && (!carrierId || p.carrierId === carrierId)) unmatchedCredit = true;
  }
  const pool = [...fileCharges];
  const fileCancels: LineMoney[] = [];
  for (const c of fileCredits) {
    const amount = Math.abs(c.amount);
    if (cancelPrior(amount, c.currency, carrierId)) continue;
    const k = pool.findIndex((x) => sameCur(x.currency, c.currency) && sameMoney(x.amount, amount));
    if (k >= 0) fileCancels.push(...pool.splice(k, 1));
    else unmatchedCredit = true;
  }
  return { charges, fileCancels, unmatchedCredit };
}

/**
 * Mükerrer satırın dayanağı. Önce kesin eşleşme aranır (aynı dosyada ya da aynı taşıyıcının önceki faturasında aynı tutar);
 * yoksa en yakın görünüm "İncele" gerekçesiyle döner.
 */
function duplicatePriorOf(
  line: Pick<ParsedInvoiceLine, 'netAmount' | 'service' | 'surcharges'>,
  cur: string | undefined,
  inFile: number[],
  priors: PriorLine[],
  carrierId: string | undefined,
  unmatchedCredit = false,
): DuplicatePrior {
  const p = dupPriorOf(line, cur, inFile, priors, carrierId);
  return unmatchedCredit ? { ...p, unmatchedCredit } : p;
}

function dupPriorOf(
  line: Pick<ParsedInvoiceLine, 'netAmount' | 'service' | 'surcharges'>,
  cur: string | undefined,
  inFile: number[],
  priors: PriorLine[],
  carrierId: string | undefined,
): DuplicatePrior {
  const sameCur = (p: PriorLine) => !cur || !p.currency || p.currency === cur;
  if (inFile.some((a) => sameMoney(a, line.netAmount))) return { sameCarrier: true, sameAmount: true, sameFile: true, amount: line.netAmount, currency: cur };
  const ofCarrier = priors.filter((p) => !carrierId || p.carrierId === carrierId);
  // KALANLAR 1.8: aynı tutarlı görünümlerden açıklaması aynı (ya da bilinmeyen) olan kesin; yalnız açıklaması farklılar varsa
  // "İncele" (aynı tutarlı başka ücret: göndericiye iade, ek hizmet)
  const desc = lineDescription(line.service, line.surcharges);
  const sameDesc = (p: PriorLine) => p.description == null || sameLineDescription(p.description, desc);
  const exacts = ofCarrier.filter((p) => sameCur(p) && sameMoney(p.netAmount, line.netAmount));
  const exact = exacts.find(sameDesc) ?? exacts[0];
  if (exact) {
    return {
      sameCarrier: true,
      sameAmount: true,
      invoiceNo: exact.invoiceNo,
      amount: exact.netAmount,
      currency: exact.currency,
      ...(sameDesc(exact) ? {} : { sameDescription: false }),
    };
  }
  if (inFile.length) return { sameCarrier: true, sameAmount: false, sameFile: true, amount: inFile[0]!, currency: cur };
  const near = ofCarrier[0];
  if (near) return { sameCarrier: true, sameAmount: false, invoiceNo: near.invoiceNo, amount: near.netAmount, currency: near.currency };
  const other = priors[0]!;
  return { sameCarrier: false, sameAmount: sameCur(other) && sameMoney(other.netAmount, line.netAmount), invoiceNo: other.invoiceNo, amount: other.netAmount, currency: other.currency };
}

/**
 * Firma para birimindeki tutar toleransının satır para birimindeki karşılığı. Para birimleri aynıysa ya da biri
 * bilinmiyorsa tolerans aynen döner. Y18: kur yoksa null (sabit yedek oran yok; satır "Kur alınamadı/bulunamadı" olur,
 * `compareAll`).
 */
export function amountTolIn(amountTol: number, companyCur: string | undefined, lineCur: string | undefined, rate: FxRate | null | undefined): number | null {
  const from = companyCur?.toUpperCase();
  const to = lineCur?.toUpperCase();
  // sıfır tolerans her para biriminde sıfırdır: kur gerekmez
  if (!from || !to || from === to || amountTol === 0) return amountTol;
  // pozitif tolerans çevrilince 0'a yuvarlanmaz (en az 1 kuruş): yoksa her kuruşluk fark "Fiyat farkı" olurdu
  const cents = (n: number) => (amountTol > 0 ? Math.max(0.01, Math.round(n * 100) / 100) : 0);
  return rate && rate.rate > 0 ? cents(amountTol * rate.rate) : null;
}

// ---------- Hesabın dayanağı: tarife sürümü + o günkü firma ayarı ----------

/** Faturaya yazılan firma ayarı (`Invoice.compareSettings`): toleranslar ve tutar toleransının para birimi. */
export type CompareSettings = {
  edgeTolCm: number;
  weightTolKg: number;
  amountTol: number;
  fxTolerancePct: number;
  unknownSurchargesAsDiff: boolean;
  companyCurrency: string;
};

/** Firmanın bugünkü ayarından hesap ayarı (20261111120000 göçündeki backfill ile aynı alanlar). */
export function compareSettingsOf(s: CompanySettings): CompareSettings {
  return {
    edgeTolCm: s.edgeTolCm,
    weightTolKg: s.weightTolKg,
    amountTol: s.amountTol,
    fxTolerancePct: s.fxTolerancePct,
    unknownSurchargesAsDiff: s.unknownSurchargesAsDiff === true,
    companyCurrency: (s.currency || DEFAULT_SETTINGS.currency).toUpperCase(),
  };
}

/** `Invoice.compareSettings` JSON'u; yoksa ya da nesne değilse null. Eksik alan varsayılanla dolar. */
export function readCompareSettings(raw: unknown): CompareSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    // eksik alan yazıldığı günün varsayılanıyla dolar (kenar 1 cm; yeni firmanın 0,5'i donmuş faturayı değiştirmez)
    edgeTolCm: n(o.edgeTolCm, LEGACY_EDGE_TOL_CM),
    weightTolKg: n(o.weightTolKg, DEFAULT_SETTINGS.weightTolKg),
    // Bilerek sabit 5: faturaya yazılmış ayarın eksik alanı bugünkü para birimi kuralıyla değil, yazıldığı günkü
    // varsayılanla dolar (para birimine göre varsayılan Mesaj 5 E1'de geldi; donmuş fatura sessizce değişmez).
    amountTol: n(o.amountTol, DEFAULT_SETTINGS.amountTol),
    fxTolerancePct: n(o.fxTolerancePct, DEFAULT_SETTINGS.fxTolerancePct),
    unknownSurchargesAsDiff: o.unknownSurchargesAsDiff === true,
    companyCurrency: (typeof o.companyCurrency === 'string' && o.companyCurrency ? o.companyCurrency : DEFAULT_SETTINGS.currency).toUpperCase(),
  };
}

/** İki hesap ayarı aynı mı (anahtar sırasından bağımsız; null hiçbir ayara eşit değildir). */
export function sameCompareSettings(a: CompareSettings | null | undefined, b: CompareSettings | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.edgeTolCm === b.edgeTolCm &&
    a.weightTolKg === b.weightTolKg &&
    a.amountTol === b.amountTol &&
    a.fxTolerancePct === b.fxTolerancePct &&
    a.unknownSurchargesAsDiff === b.unknownSurchargesAsDiff &&
    a.companyCurrency === b.companyCurrency
  );
}

/** Hesabın fiyat kaynağı: canlı tarife değil, tarifenin değişmez sürümü (`TariffRevision`). */
export type PricingTariff = {
  /** Sürümün ait olduğu tarife; tarife silindiyse null (satıra `tariffId` olarak yazılır). */
  tariffId: string | null;
  revisionId: string;
  /** `TariffRevision.tariffName`: tarife silinse de okunur. */
  name: string;
  currency: string;
  validFrom: Date | null;
  validTo: Date | null;
  input: TariffInput;
};

type SnapshotLike = {
  currency?: unknown;
  divisor?: unknown;
  edgeRounding?: unknown;
  weightSteps?: unknown;
  discountPct?: unknown;
  fuelPct?: unknown;
  fuelVariable?: unknown;
  pakDiscountPct?: unknown;
  envelopeDiscountPct?: unknown;
  service?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  zones?: unknown;
  rates?: unknown;
  overflow?: unknown;
  surcharges?: unknown;
  countryAdjustments?: unknown;
};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** Sürümdeki boş olabilen yüzde: yok, null ya da sayı olmayan → null. */
const snapshotPct = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Sürümün `snapshot`'ı (tariffSnapshot / tariffBody biçimi) → hesap girdisi. Canlı tarifeden kurulan `toTariffInput` ile
 * eşdeğerdir (test/frozenResults.test.ts): yalnız `rates` sırası farklıdır (snapshot bölge + ağırlığa göre sıralı), hesap
 * buna duyarsızdır. Doğrulama yapılmaz: backfill'in canlı veriden kurduğu eski sürümler de okunabilmelidir.
 */
export function snapshotToTariffInput(snapshot: unknown, id: string, fallbackCurrency = ''): TariffInput {
  const s = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as SnapshotLike;
  const overflow = arr<{ zone: string; perUnit: unknown }>(s.overflow);
  return {
    id,
    currency: typeof s.currency === 'string' && s.currency ? s.currency : fallbackCurrency,
    divisor: Number(s.divisor),
    edgeRounding: (s.edgeRounding === 'NONE' ? 'NONE' : 'CEIL_CM') as TariffInput['edgeRounding'],
    weightSteps: arr<WeightStep>(s.weightSteps),
    discountPct: Number(s.discountPct ?? 0),
    fuelPct: Number(s.fuelPct ?? 0),
    fuelVariable: s.fuelVariable === true,
    // ambalaj öncesi sürümlerde alan yok: Pak/Zarf indirimi boş (= tarifenin indirimi), her satır kendi ambalajı
    pakDiscountPct: snapshotPct(s.pakDiscountPct),
    envelopeDiscountPct: snapshotPct(s.envelopeDiscountPct),
    service: typeof s.service === 'string' ? s.service : null,
    zones: Object.fromEntries(arr<{ country: string; zone: string }>(s.zones).map((z) => [String(z.country).toUpperCase(), z.zone])),
    rates: arr<{ zone: string; weightUpto: unknown; price: unknown; perKg?: unknown; packaging?: unknown }>(s.rates).map((r) => ({
      zone: r.zone,
      weightUpto: Number(r.weightUpto),
      price: Number(r.price),
      perKg: r.perKg === true,
      packaging: packagingOf(typeof r.packaging === 'string' ? r.packaging : null),
    })),
    overflowPerUnit: overflow.length ? Object.fromEntries(overflow.map((o) => [o.zone, Number(o.perUnit)])) : undefined,
    surcharges: arr<{ code: string; name?: string; kind: TariffInput['surcharges'][number]['kind']; amount: unknown }>(s.surcharges).map((c) => ({
      code: c.code,
      name: c.name ?? '',
      kind: c.kind,
      amount: Number(c.amount),
    })),
    countryAdjustments: readAdjustments(s.countryAdjustments),
  };
}

const snapshotDay = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * `tariff`: sürümün canlı tarifesinin geçerlilik tarihleri (verilmezse ya da tarife silindiyse null). Geçerlilik fiyat
 * içeriğinde değildir (özete girmez, yeni sürüm doğurmaz): tarife duruyorsa tarihler canlı tarifeden, silindiyse sürümdeki
 * tarihten okunur.
 */
type RevisionRow = {
  id: string;
  tariffId: string | null;
  tariffName: string;
  currency: string;
  snapshot: unknown;
  tariff?: { validFrom: Date | null; validTo: Date | null } | null;
};

/** Sürüm içeriği değişmez: dönüştürülmüş girdi sürüm kimliğiyle saklanır (toplu geçişte aynı sürüm yüzlerce kez okunur). */
const revisionInputCache = new Map<string, TariffInput>();
const REVISION_CACHE_MAX = 16;

export function pricingFromRevision(rev: RevisionRow): PricingTariff {
  const s = (rev.snapshot && typeof rev.snapshot === 'object' ? rev.snapshot : {}) as SnapshotLike;
  const key = `${rev.id}:${rev.tariffId ?? ''}`;
  let input = revisionInputCache.get(key);
  if (!input) {
    input = snapshotToTariffInput(rev.snapshot, rev.tariffId ?? rev.id, rev.currency);
    if (revisionInputCache.size >= REVISION_CACHE_MAX) revisionInputCache.delete(revisionInputCache.keys().next().value!);
    revisionInputCache.set(key, input);
  }
  return {
    tariffId: rev.tariffId,
    revisionId: rev.id,
    name: rev.tariffName,
    currency: input.currency,
    validFrom: rev.tariff ? rev.tariff.validFrom : snapshotDay(s.validFrom),
    validTo: rev.tariff ? rev.tariff.validTo : snapshotDay(s.validTo),
    input,
  };
}

type RevisionJoinRow = Omit<RevisionRow, 'tariff'> & {
  hasTariff: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  carrierCode?: string | null;
  carrierLimits?: unknown;
};

/** Karşılaştırmanın okuduğu taşıyıcı alanları (poşet / zarf sınırları için). */
export type CarrierLimitsRow = { code: string; packagingLimits: unknown };

/**
 * Sürümler ve canlı tarifelerinin geçerlilik tarihleri, tek sorguda (Y11: Prisma `include` ikinci sorgu açıyordu). Satır
 * `pricingFromRevision`'ın girdisi: tarife silinmişse `tariff` null (tarihler sürümden okunur).
 */
async function loadRevisionRows(
  companyId: string,
  revisionIds: (string | null)[],
  /**
   * Verilirse taşıyıcının poşet / zarf alanları da aynı sorguda okunur (Y11 sorgu bütçesi) ve `carrier`'a yazılır; sürüm
   * satırı dönmezse `carrier.row` tanımsız kalır (çağıran ayrıca okur).
   */
  carrier?: { id: string; row?: CarrierLimitsRow | null },
): Promise<Map<string, RevisionRow>> {
  const ids = [...new Set(revisionIds.filter((x): x is string => !!x))];
  const out = new Map<string, RevisionRow>();
  if (!ids.length) return out;
  const carrierJoin = carrier
    ? Prisma.sql`, c."code" AS "carrierCode", c."packagingLimits" AS "carrierLimits", (c."id" IS NOT NULL) AS "hasCarrier"`
    : Prisma.empty;
  const carrierFrom = carrier ? Prisma.sql`LEFT JOIN "Carrier" c ON c."id" = ${carrier.id} AND c."companyId" = r."companyId"` : Prisma.empty;
  const rows = await prisma.$queryRaw<(RevisionJoinRow & { hasCarrier?: boolean })[]>`
    SELECT r."id", r."tariffId", r."tariffName", r."currency", r."snapshot",
      (t."id" IS NOT NULL) AS "hasTariff", t."validFrom", t."validTo" ${carrierJoin}
    FROM "TariffRevision" r
    LEFT JOIN "Tariff" t ON t."id" = r."tariffId" AND t."companyId" = r."companyId"
    ${carrierFrom}
    WHERE r."companyId" = ${companyId} AND r."id" = ANY(${ids}::text[])`;
  if (carrier && rows.length) carrier.row = rows[0]!.hasCarrier ? { code: rows[0]!.carrierCode!, packagingLimits: rows[0]!.carrierLimits ?? null } : null;
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      tariffId: r.tariffId,
      tariffName: r.tariffName,
      currency: r.currency,
      snapshot: r.snapshot,
      tariff: r.hasTariff ? { validFrom: r.validFrom, validTo: r.validTo } : null,
    });
  }
  return out;
}

/** Sürümden fiyat kaynağı; sürüm yoksa (ya da kimlik boşsa) null. */
export async function loadPricingTariff(companyId: string, revisionId: string | null): Promise<PricingTariff | null> {
  if (!revisionId) return null;
  const rev = (await loadRevisionRows(companyId, [revisionId])).get(revisionId);
  return rev ? pricingFromRevision(rev) : null;
}

/** Faturanın hesap dayanağı: `Invoice.tariffRevisionId` + `Invoice.compareSettings`. */
export type InvoiceBasis = { tariffRevisionId: string | null; compareSettings: CompareSettings };
/** Güncel dayanak ve onu veren tarife (faturada seçilen ya da taşıyıcının varsayılanı; yoksa null). */
export type ResolvedBasis = InvoiceBasis & { tariffId: string | null };

/**
 * Güncel dayanak (`current`): faturanın tarifesinin (verilmediyse ya da taşıyıcıda yoksa varsayılan tarifenin) bugünkü
 * sürümü + firmanın bugünkü ayarı. Yeni fatura içe aktarılırken ve "yeni tarifeyle / yeni ayarla hesapla"da kullanılır;
 * dönen `tariffRevisionId` ve `compareSettings` faturaya yazılır. Tarifenin sürümü henüz yoksa burada doğar.
 */
export async function resolveCurrentBasis(companyId: string, carrierId: string, tariffId: string | null = null): Promise<ResolvedBasis> {
  const [tariffs, company] = await Promise.all([
    prisma.tariff.findMany({
      where: { companyId, carrierId },
      select: { id: true, active: true, isDefault: true, updatedAt: true, currentRevisionId: true },
    }),
    prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } }),
  ]);
  const t = invoiceTariff({ tariffs, fixedTariffId: tariffId });
  let tariffRevisionId = t?.currentRevisionId ?? null;
  if (t && !tariffRevisionId) {
    tariffRevisionId = (await prisma.$transaction((tx) => ensureTariffRevision(tx, t.id, companyId), TX_DEFAULTS)).id;
  }
  return { tariffId: t?.id ?? null, tariffRevisionId, compareSettings: compareSettingsOf(readSettings(company.settings)) };
}

export type CompareContext = {
  index: MeasurementIndex;
  /** Fiyat kaynağı (tarife sürümü); null = tarifesiz hesap (satırlar NO_TARIFF). */
  pricing: PricingTariff | null;
  /** Bu bağlamın dayanağı: yeni faturaya (`tariffRevisionId`, `compareSettings`) olarak yazılır. */
  basis: InvoiceBasis;
  /** `amountTol` firmanın para birimindedir; dövizli satırda kurla çevrilir (`amountTolIn`). */
  tol: { edgeTolCm: number; weightTolKg: number; amountTol: number; fxTolerancePct: number; unknownSurchargesAsDiff: boolean };
  /** Takip no → daha önceki faturalardaki satırları (mükerrer kararı). */
  priorLines: Map<string, PriorLine[]>;
  /** Faturanın taşıyıcısı: mükerrer yalnız aynı taşıyıcıda kesindir. */
  carrierId?: string;
  /**
   * Faturanın taşıyıcısının etkin poşet / zarf sınırları (`Carrier.packagingLimits` > taşıyıcı kodunun varsayılanı). Hesap
   * anında okunur, faturanın dayanağına yazılmaz: ayar değişince eski faturalar kendiliğinden değişmez, sonraki yeniden
   * karşılaştırma yeni sınırla hesaplar. Verilmezse core varsayılanı (sınır bilinmiyor).
   */
  packagingLimits?: PackagingLimits;
  /** Faturanın taşıyıcısının kodu (ambalaj adı ve hizmet adından ambalaj çıkarımı için core'a gider). */
  carrierCode?: CarrierCode;
  /** Firmanın para birimi (tutar toleransının birimi). */
  companyCurrency?: string;
  /** Satırında para birimi yazmayan satırlar için fatura para birimi. */
  invoiceCurrency?: string | null;
  /** prefetchFx ile doldurulur: fxKey(tarife, satır, gün) → kur (bulunamadıysa null). */
  fx?: Map<string, FxRate | null>;
  /** prefetchFx: ağ hatasıyla alınamayan kur anahtarları. */
  fxFailed?: Set<string>;
  /**
   * KALANLAR 1.8: zincirinde birden çok bağımsız ölçüm olan güncel ölçümlerin kimlikleri (`remeasuredMeasurements`).
   * Eşleşen ölçüm buradaysa ağırlık/ölçü farkı kesin sayılmaz (çok koli olabilir). Verilmezse boş.
   */
  remeasured?: ReadonlySet<string>;
};

/**
 * KALANLAR 1.8: verilen güncel ölçümlerden zincirinde birden çok bağımsız ölçüm olanlar. Telefonda "Yeniden ölç" aynı takip
 * no'ya yeni ölçüm anıyla yeni sürüm açar (birinciyi ezer); düzeltme (`PATCH`) ölçüm anını korur. Ölçüm anı birden çok olan
 * zincir ya çok kolili gönderinin ikinci kolisidir ya da düzeltme ölçümüdür: hangisi olduğu bilinmez. Yönetici düzeltmede
 * ölçüm anını değiştirirse de sayılır (güvenli yön: yalnız "İncele"). Silinmiş zincirler (güncel sürümü silinmiş) verilmez.
 */
export async function remeasuredMeasurements(companyId: string, ids: readonly string[], db: Db = prisma): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE ch("head", "id", "measuredAt", "depth") AS (
      SELECT m."id", m."id", m."measuredAt", 0 FROM "Measurement" m WHERE m."companyId" = ${companyId} AND m."id" = ANY(${[...ids]}::text[])
      UNION ALL
      SELECT ch."head", v."id", v."measuredAt", ch."depth" + 1 FROM "Measurement" v JOIN ch ON v."supersededById" = ch."id"
      WHERE v."companyId" = ${companyId} AND ch."depth" < 1000
    )
    SELECT "head" AS "id" FROM ch GROUP BY "head" HAVING count(DISTINCT "measuredAt") > 1`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Karşılaştırma bağlamı. `basis` verilmezse güncel dayanak çözülür (`resolveCurrentBasis`: yeni fatura); verilirse hesap
 * o sürüm ve o ayarla yapılır (sabit dayanak). Fiyat her iki durumda sürümün `snapshot`'ından kurulur.
 */
export async function buildContext(
  companyId: string,
  carrierId: string,
  trackingNos: string[],
  before: { id: string; createdAt: Date } | null,
  fixedTariffId: string | null = null,
  /** örnek fatura (kurulum): mükerrer kontrolü yapılmaz */
  isSample = false,
  basis?: InvoiceBasis,
  /**
   * Y81: ölçüm dizini yalnız bu takip no'lar için yüklenir. `compareAll`'a verilecek satırların `trackingNo` değerleri,
   * AYNEN (içe aktarmada ham, normalize edilmemiş). Verilmezse `trackingNos` (kayıtlı satırlar: ikisi aynıdır).
   * Kapsam dışı bir satır `find`'da hata atar.
   */
  indexTrackings: readonly string[] = trackingNos,
  /**
   * Y11: çağıranın aynı sürüm için zaten okuduğu fiyat kaynağı (yalnız `basis.tariffRevisionId`'ninkiyse kullanılır) ve
   * taşıyıcının poşet / zarf alanları (`carrier` tanımlıysa yeniden okunmaz; null = taşıyıcı yok).
   */
  known?: { pricing: PricingTariff | null; carrier?: CarrierLimitsRow | null },
): Promise<CompareContext> {
  const b: InvoiceBasis = basis ?? (await resolveCurrentBasis(companyId, carrierId, fixedTariffId));
  const reuse = known !== undefined && (known.pricing?.revisionId ?? null) === b.tariffRevisionId;
  const [[index, remeasured], pricing, priorLines, carrier] = await Promise.all([
    // KALANLAR 1.8: ölçüm tekrarı yalnız eski sürümü olan ölçümlerde aranır (çoğu faturada ek sorgu yok)
    MeasurementIndex.load(companyId, indexTrackings).then(async (ix) => [ix, await remeasuredMeasurements(companyId, ix.revisedIds)] as const),
    reuse ? known.pricing : loadPricingTariff(companyId, b.tariffRevisionId),
    isSample ? new Map<string, PriorLine[]>() : previouslyBilled(companyId, [...new Set(trackingNos)], before),
    known?.carrier !== undefined ? known.carrier : prisma.carrier.findFirst({ where: { id: carrierId, companyId }, select: { code: true, packagingLimits: true } }),
  ]);
  const s = b.compareSettings;
  return {
    index,
    remeasured,
    pricing,
    basis: { tariffRevisionId: pricing?.revisionId ?? null, compareSettings: s },
    tol: {
      edgeTolCm: s.edgeTolCm,
      weightTolKg: s.weightTolKg,
      amountTol: s.amountTol,
      fxTolerancePct: s.fxTolerancePct,
      unknownSurchargesAsDiff: s.unknownSurchargesAsDiff,
    },
    priorLines,
    carrierId,
    ...(carrier ? { packagingLimits: effectivePackagingLimits(carrier), carrierCode: carrierCodeOf(carrier.code) } : {}),
    companyCurrency: s.companyCurrency,
  };
}

const tolDate = (invoiceDate: Date) => invoiceDate.toISOString().slice(0, 10);

/** Satırın karşılaştırma günü: sevk tarihi, yoksa fatura tarihi (tarife ve kur seçimi aynı günü kullanır). */
function lineDate(line: ParsedInvoiceLine, invoiceDate: Date): Date {
  const d = line.shipDate ? new Date(`${line.shipDate.slice(0, 10)}T00:00:00Z`) : invoiceDate;
  return Number.isNaN(d.getTime()) ? invoiceDate : d;
}

/** Satırın para birimi; yazmıyorsa fatura para birimi. */
function lineCurrency(line: ParsedInvoiceLine, ctx: CompareContext): string | undefined {
  const c = line.currency?.trim() || ctx.invoiceCurrency?.trim();
  return c ? c.toUpperCase() : undefined;
}

/**
 * Tarife para birimi satırınkinden farklı olan satırlar için gereken (çift, gün) kurlarını önceden toplar
 * (SPEC §FX), tutar toleransının kuruyla birlikte. Günler sırayla, sabırlı (3 deneme, 30 sn) indirilir. Ağ hatası faturayı
 * durdurmaz: saklı en yakın önceki günün kuru kullanılır (en çok 7 gün, `stale`; satır notu "Kur … tarihli"), o da yoksa
 * kur null kalır, satır "Kur alınamadı … TCMB yanıt vermedi" olur ve `totals.fxMissing` sayılır. `patient: false`: arka
 * plan (ölçüm değişikliği) — devre kesici açıkken TCMB beklenmez.
 */
export async function prefetchFx(
  lines: ParsedInvoiceLine[],
  ctx: CompareContext,
  invoiceDate: Date,
  invoiceCurrency?: string | null,
  opts: { patient?: boolean } = {},
) {
  ctx.invoiceCurrency = invoiceCurrency ?? ctx.invoiceCurrency ?? null;
  const reqs: { base: string; quote: string; date: string }[] = [];
  for (const line of lines) {
    const date = lineDate(line, invoiceDate);
    const t = ctx.pricing;
    const cur = lineCurrency(line, ctx);
    const iso = date.toISOString().slice(0, 10);
    if (!t || !cur || t.currency.toUpperCase() === cur) continue;
    reqs.push({ base: t.currency.toUpperCase(), quote: cur, date: iso });
  }
  // Tutar toleransı firma para biriminde: dövizli satırdaki karşılığı için kur. Kaba bir eşik olduğundan satır günü değil
  // fatura günü yeter (para birimi başına tek istek). Y18: satır kurlarıyla aynı toplamada, aynı sabırla ve süre sınırıyla
  // alınır; sabit yedek oran yoktur. Alınamazsa saklı en yakın önceki günün kuru (fx.ts), o da yoksa satır "Kur alınamadı"
  // (`fxFailed`) ya da "Kur bulunamadı" olur. Tarife yoksa karşılaştırma da yoktur; tolerans sıfırsa çevrilecek bir şey yoktur.
  const company = ctx.companyCurrency;
  const tolReqs =
    company && ctx.pricing && ctx.tol.amountTol !== 0
      ? [...new Set(lines.map((l) => lineCurrency(l, ctx)).filter((c): c is string => !!c && c !== company))].map((quote) => ({ base: company, quote, date: tolDate(invoiceDate) }))
      : [];
  const all = [...reqs, ...tolReqs];
  const res = all.length ? await fxService().prefetch(all, opts) : { rates: new Map<string, FxRate | null>(), failed: [] };
  ctx.fx = res.rates;
  ctx.fxFailed = new Set(res.failed);
  return ctx;
}

/**
 * Compares lines in rowIndex order; marks second+ appearances as duplicates.
 * `pinned` (rowIndex → measurement) overrides tracking-number matching for manually matched lines (SPEC 10.2);
 * a `null` value means the pinned measurement is deleted, so the line is compared as unmatched.
 */
export function compareAll(
  lines: ParsedInvoiceLine[],
  ctx: CompareContext,
  invoiceDate: Date,
  pinned: Map<number, MeasurementLite | null> = new Map(),
): ComparedLine[] {
  const one = lineComparer(lines, ctx, invoiceDate, pinned);
  return byRowIndex(lines).map((line) => one(line));
}

/**
 * `compareAll` ile birebir aynı sonuç, `YIELD_EVERY_ROWS` (2.000) satırlık dilimlerle: aralarda olay döngüsü bırakılır
 * (19-B1; 50.000 satırlık faturanın karşılaştırması tek blokta ~0,7 sn sürüyordu). Satır sırası ve durum (dosyada üstte
 * görülen takip no) aynı işlevde tutulur; bağlam (`ctx`) bu istekte kurulmuştur, arada değişmez.
 */
export async function compareAllSliced(
  lines: ParsedInvoiceLine[],
  ctx: CompareContext,
  invoiceDate: Date,
  pinned: Map<number, MeasurementLite | null> = new Map(),
): Promise<ComparedLine[]> {
  const one = lineComparer(lines, ctx, invoiceDate, pinned);
  const sorted = byRowIndex(lines);
  const out: ComparedLine[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && i % YIELD_EVERY_ROWS === 0) await yieldToLoop();
    out.push(one(sorted[i]!));
  }
  return out;
}

function byRowIndex(lines: ParsedInvoiceLine[]): ParsedInvoiceLine[] {
  return [...lines].sort((a, b) => a.rowIndex - b.rowIndex);
}

export type ComparedLine = ReturnType<ReturnType<typeof lineComparer>>;

/** Tek satırın karşılaştırması; satırlar `rowIndex` sırasıyla verilmeli (mükerrer kuralı üstte görüleni sayar). */
function lineComparer(lines: ParsedInvoiceLine[], ctx: CompareContext, invoiceDate: Date, pinned: Map<number, MeasurementLite | null>) {
  /** Bu dosyada üstte görülen takip no → o satırların tutarları. */
  const seen = new Map<string, number[]>();
  // Fiyat kaynağı tarifenin sürümüdür (ctx.pricing); girdi bağlam kurulurken bir kez dönüştürülür.
  const tariffRow = ctx.pricing;
  // DENETIM-2 B1: faturada farklı hizmet sınıfları varsa hizmeti belirsiz tarifeyle çıkan fark kesin sayılmaz (çekirdek)
  const mixedServices = invoiceHasMixedServices(lines.map((l) => l.service));
  // K39: faturanın hiçbir satırında hizmet adı yoksa satırın boş hizmeti "İncele" gerekçesi değildir (çekirdek)
  const invoiceLacksServices = !lines.some((l) => !!l.service?.trim());
  // İnceleme 2026-11-13: iade (eksi satır) eşit tutarlı önceki ücreti iptal eder (`cancelCredits`); takip no başına bir kez,
  // dosyanın TÜM satırlarından (iade yeniden faturanın altında da olabilir)
  const fileMoney = new Map<string, { credits: LineMoney[]; charges: LineMoney[] }>();
  for (const l of lines) {
    const key = normalizeTracking(l.trackingNo);
    const e = fileMoney.get(key) ?? { credits: [], charges: [] };
    if (l.netAmount !== 0) (l.netAmount < 0 ? e.credits : e.charges).push({ amount: l.netAmount, currency: lineCurrency(l, ctx) });
    fileMoney.set(key, e);
  }
  const cancelled = new Map<string, ReturnType<typeof cancelCredits>>();
  /**
   * KALANLAR 1.8: takip no bu dosyada birden çok ücret satırında mı (artı tutarlı; bu dosyanın iadesiyle iptal edilenler
   * düşülür). Çok kolili gönderi ya da ayrı ücret satırı olabilir: çekirdek bu satırların hiçbir farkını kesin saymaz.
   */
  const repeated = new Map<string, boolean>();
  const creditsOf = (key: string) => {
    let c = cancelled.get(key);
    if (!c) {
      const f = fileMoney.get(key);
      c = cancelCredits(ctx.priorLines.get(key) ?? [], f?.credits ?? [], f?.charges ?? [], ctx.carrierId);
      cancelled.set(key, c);
      // `fileCancels` henüz tüketilmedi (satırlar işlenirken azalır): dosyada kalan ücret sayısı burada bir kez sayılır
      repeated.set(key, (f?.charges.length ?? 0) - c.fileCancels.length > 1);
    }
    return c;
  };
  return (line: ParsedInvoiceLine) => {
      const trackingNo = normalizeTracking(line.trackingNo);
      const credit = creditsOf(trackingNo);
      const priors = credit.charges;
      const inFile = seen.get(trackingNo) ?? [];
      // 01-B11: eksi tutarlı (iade) ve sıfır tutarlı (ücretsiz, kullanıcı kararı 2026-11-13) satır çekirdekte mükerrer
      // sayılmaz; sonraki satırlar için de görünüm sayılmaz
      let cancelledByCredit = false;
      if (line.netAmount > 0) {
        // bu dosyanın iadesiyle iptal edilen ücret sonraki satırlar için görünüm sayılmaz ve kendisi de karşılaştırılmaz
        // (inceleme 2: iade edilmiş ücretten fark ve itiraz çıkmaz). Önceki faturadaki iptal edilen ücret o faturada kalır.
        const lc = lineCurrency(line, ctx);
        const k = credit.fileCancels.findIndex((x) => (!x.currency || !lc || x.currency === lc) && sameMoney(x.amount, line.netAmount));
        if (k >= 0) {
          credit.fileCancels.splice(k, 1);
          cancelledByCredit = true;
        } else seen.set(trackingNo, [...inFile, line.netAmount]);
      }
      const isDuplicate = !cancelledByCredit && (priors.length > 0 || inFile.length > 0);
      const m = pinned.has(line.rowIndex) ? pinned.get(line.rowIndex)! : ctx.index.find(line.trackingNo);
      const date = lineDate(line, invoiceDate);
      const warning = tariffRow ? validityWarning(tariffRow, date) : null;
      const cur = lineCurrency(line, ctx);
      const iso = date.toISOString().slice(0, 10);
      const needsFx = Boolean(ctx.fx && tariffRow && cur && tariffRow.currency.toUpperCase() !== cur);
      const key = needsFx ? fxKey(tariffRow!.currency, cur!, iso) : null;
      // Y18: tutar toleransının kuru (firma → satır para birimi, fatura günü). Kur yoksa sabit yedek oran kullanılmaz:
      // çekirdek satırı "kur yok" sınıfına alır (`tolFx.rate` null). Bağlamda kur haritası yoksa (`prefetchFx` koşmadı) da öyle.
      const company = ctx.companyCurrency;
      const tolKey = tariffRow && cur && company && company !== cur && ctx.tol.amountTol !== 0 ? fxKey(company, cur, tolDate(invoiceDate)) : null;
      const tolRate = tolKey ? (ctx.fx?.get(tolKey) ?? null) : null;
      const amountTol = tolKey ? amountTolIn(ctx.tol.amountTol, company, cur, tolRate) : ctx.tol.amountTol;
      const result = compareLine({
        line: cur && cur !== line.currency ? { ...line, currency: cur } : line,
        measurement: m ? toMeasurementInput(m) : null,
        tariff: tariffRow ? tariffRow.input : null,
        ...(ctx.packagingLimits ? { packagingLimits: ctx.packagingLimits } : {}),
        ...(ctx.carrierCode ? { carrier: ctx.carrierCode } : {}),
        tol: amountTol == null || amountTol === ctx.tol.amountTol ? ctx.tol : { ...ctx.tol, amountTol },
        isDuplicate,
        ...(cancelledByCredit ? { cancelledByCredit } : {}),
        ...(mixedServices ? { mixedServices } : {}),
        ...(invoiceLacksServices ? { invoiceLacksServices } : {}),
        // KALANLAR 1.8: çok koli şüphesi (dosyada tekrar, ölçüm tekrarı): fark kesin sayılmaz
        ...(repeated.get(trackingNo) ? { repeatedInFile: true } : {}),
        ...(m && ctx.remeasured?.has(m.id) ? { remeasured: true } : {}),
        ...(isDuplicate ? { duplicatePrior: duplicatePriorOf(line, cur, inFile, priors, ctx.carrierId, credit.unmatchedCredit) } : {}),
        ...(key ? { fx: { date: iso, rate: ctx.fx!.get(key) ?? null } } : {}),
        ...(tolKey ? { tolFx: { base: company!, quote: cur!, date: tolDate(invoiceDate), rate: tolRate } } : {}),
      });
      // Y144: kurun bulunamadığı yapısal işaretten (`result.fxMissing`) okunur, not metnine bakılmaz. Çekirdek önce satır
      // kurunu çözer: o yoksa işaret onundur, değilse tolerans kurunun (Y18).
      const missingKey = result.status === 'NO_TARIFF' && result.fxMissing ? (key && !ctx.fx?.get(key) ? key : tolKey) : null;
      if (missingKey && ctx.fxFailed?.has(missingKey)) {
        result.note = coreMessage('tr', 'stored.fxFailed', result.fxMissing!);
      }
      if (warning) result.note = result.note ? `${result.note} · ${warning}` : warning;
      return {
        line,
        result,
        measurementId: m?.id ?? null,
        tariffId: tariffRow?.tariffId ?? null,
        // tarifesiz sonuç (NO_TARIFF) sürüm taşımaz (göçteki backfill ile aynı kural)
        tariffRevisionId: tariffRow && result.status !== 'NO_TARIFF' ? tariffRow.revisionId : null,
        /** Y18 (inceleme): satır yalnız tutar toleransının kuru eksik olduğu için hesaplanamadı (para sonucu bilinmiyor). */
        tolFxMissing: tolKey != null && missingKey === tolKey,
      };
    };
}

const measurementLiteSelect = {
  id: true,
  trackingNo: true,
  trackingRaw: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  weightKg: true,
  measuredAt: true,
  version: true,
  packaging: true,
  supersededById: true,
  deletedAt: true,
} as const;

/**
 * Latest version of a measurement: follows the `supersededById` chain to its head.
 * Returns null if the measurement does not exist in the company.
 */
export async function resolveLatestVersion(companyId: string, measurementId: string) {
  return (await resolveLatestVersions(companyId, [measurementId])).get(measurementId) ?? null;
}

type MeasurementLiteRow = Prisma.MeasurementGetPayload<{ select: typeof measurementLiteSelect }>;

/**
 * `resolveLatestVersion`'ın toplu hâli: her başlangıç id'si için zincirin başı (yoksa null).
 * Satır başına sorgu yerine zincirin her adımı tek sorgu (yeniden karşılaştırmada sabitlenmiş satırlar).
 */
export async function resolveLatestVersions(companyId: string, measurementIds: string[]) {
  const out = new Map<string, MeasurementLiteRow | null>();
  const ids = [...new Set(measurementIds)];
  if (!ids.length) return out;
  const byId = new Map<string, MeasurementLiteRow>();
  const load = async (list: string[]) => {
    const rows = await prisma.measurement.findMany({ where: { id: { in: list }, companyId }, select: measurementLiteSelect });
    for (const m of rows) byId.set(m.id, m);
  };
  await load(ids);
  for (const id of ids) out.set(id, byId.get(id) ?? null);
  // zincirin sonraki sürümü bulunamayanlar (tekil sürümdeki `break`) mevcut sürümde kalır
  const stuck = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const pending = [...out.entries()].filter(([id, cur]) => cur?.supersededById && !stuck.has(id));
    if (!pending.length) break;
    const missing = [...new Set(pending.map(([, cur]) => cur!.supersededById!))].filter((id) => !byId.has(id));
    if (missing.length) await load(missing);
    for (const [id, cur] of pending) {
      const next = byId.get(cur!.supersededById!);
      if (next) out.set(id, next);
      else stuck.add(id);
    }
  }
  return out;
}

/** All ids of a measurement's version chain (older and newer versions, including itself). */
export async function measurementChainIds(companyId: string, measurementId: string): Promise<string[]> {
  const ids = [measurementId];
  let cursor = measurementId;
  for (let i = 0; i < 100; i++) {
    const prev = await prisma.measurement.findFirst({ where: { supersededById: cursor, companyId }, select: { id: true } });
    if (!prev) break;
    ids.push(prev.id);
    cursor = prev.id;
  }
  let cur = await prisma.measurement.findFirst({ where: { id: measurementId, companyId }, select: { supersededById: true } });
  for (let i = 0; cur?.supersededById && i < 100; i++) {
    ids.push(cur.supersededById);
    cur = await prisma.measurement.findFirst({ where: { id: cur.supersededById, companyId }, select: { supersededById: true } });
  }
  return [...new Set(ids)];
}

// ---------- Yeniden karşılaştırma: tek motor (hesapla → kilit altında yaz) ----------

/**
 * Dayanak kipi. Dayanak iki parçadır (tarife sürümü + ayar); her kip yalnız kendi parçasını günceller, öbürü faturadaki
 * gibi kalır.
 *  - `pinned`: faturanın kayıtlı sürümü ve ayarı.
 *  - `tariff`: tarifenin bugünkü sürümü (§3.12 kuralıyla bulunan tarife) + faturanın ayarı ("Yeni tarifeyle hesapla",
 *    tarife toplu geçişi, başlıkta taşıyıcı / tarife değişimi).
 *  - `rules`: faturanın tarife sürümü + bugünkü ayar ("Yeni ayarla hesapla", ayar toplu geçişi).
 */
export type RecompareBasis = 'pinned' | 'tariff' | 'rules';
/** `open`: yalnız donmamış satırlar yazılır. `all`: karar verilmiş satırlar da (etkin itirazdakiler hiçbir zaman). */
export type RecompareScope = 'open' | 'all';
/**
 * Yeniden hesabın nedeni: `prevResult.cause` ve denetim kaydı (`invoice.recalculate`). `TRACKING` / `MATCH` satır
 * düzeltmesi (takip no, elle eşleştirme); `TARIFF` / `RULES` yeni tarife sürümüne / bugünkü ayara geçiş.
 */
export type RecalcCause = 'MEASUREMENT' | 'DUPLICATE' | 'TRACKING' | 'MATCH' | 'TARIFF' | 'RULES' | 'OTHER';
/**
 * Donmuş satırda bekleyen değişikliğin sınıfı (`InvoiceLine.recalcPending`): yalnız üç değer (web sözlüğü de üç).
 * Satıra özgü nedenler (TRACKING, MATCH) yalnız düzeltilen satırda geçerlidir ve o satır her zaman yazılır; aynı hesapta
 * işaretlenen öbür satırın değişikliği o düzeltmeden gelmez, `OTHER` olur. TARIFF / RULES (`current`) etkin itirazı olan
 * faturada reddedilir, itirazsız faturada da her satır yazılır: işarete düşmez, düşerse `OTHER`.
 */
export type RecalcPendingCause = 'MEASUREMENT' | 'DUPLICATE' | 'OTHER';

export function pendingCauseOf(c: RecalcCause): RecalcPendingCause {
  return c === 'MEASUREMENT' || c === 'DUPLICATE' ? c : 'OTHER';
}

/**
 * İşaretin üstüne yazma kuralı: yeni neden ancak kayıtlı olandan daha belirliyse yazılır (OTHER < DUPLICATE < MEASUREMENT).
 * Ölçüm en üsttedir, satırdaki eylem ("Yeni ölçümle hesapla") ona göre seçilir. Eşit ya da daha genel neden işareti ve
 * `recalcPendingAt`'i olduğu gibi bırakır (satır boşuna yazılmaz). Tanınmayan eski değer `OTHER` sayılır.
 */
const PENDING_RANK: Record<RecalcPendingCause, number> = { OTHER: 0, DUPLICATE: 1, MEASUREMENT: 2 };
const pendingRank = (v: string) => PENDING_RANK[v as RecalcPendingCause] ?? 0;

export type RecompareOptions = {
  /** varsayılan `pinned` */
  basis?: RecompareBasis;
  /** varsayılan `open` */
  scope?: RecompareScope;
  /** Kullanıcının düzelttiği satırlar: karar verilmiş olsa da yazılır (etkin itirazdaki satır yine yazılmaz). */
  forceLineIds?: string[];
  /**
   * Yalnız bu satırlar yazılır, karar verilmiş olsalar da ("yeni ölçümle hesapla"); diğer satırlara dokunulmaz. Yalnız
   * `pinned` ile: satır seçimli hesap faturanın dayanağını değiştirmez (dayanaksız faturada tarife benimsenmez).
   */
  lineIds?: string[];
  /**
   * Verilmezse: `tariff` kipinde sürüm değişiyorsa `TARIFF`, `rules` kipinde ayar değişiyorsa `RULES`; öbür durumda
   * `OTHER`.
   */
  cause?: RecalcCause;
  /** Kur indirmesi sabırlı mı (kullanıcı isteği) yoksa arka plan mı; `prefetchFx`. */
  patient?: boolean;
};

/** Önizleme: fatura bu alanları değişmiş gibi hesaplanır, yazılmaz. Yalnız `pinned` ile (taşıyıcı / tarife değişirse `tariff`'e yükselir). */
export type InvoicePatch = { carrierId?: string; tariffId?: string | null; invoiceDate?: Date; currency?: string };

/** Satırın para sonucu (önce/sonra karşılaştırması ve `prevResult`). */
export type MoneyResult = {
  status: string;
  diffTypes: string[];
  expectedAmount: number | null;
  diffAmount: number | null;
  ourChargeableKg: number | null;
  measurementId: string | null;
  tariffRevisionId: string | null;
};
/** `InvoiceLine.prevResult`: sonuç değişmeden önceki hâl (yalnız bir adım). */
export type PrevResult = MoneyResult & { at: string; cause: RecalcCause };

export function readPrevResult(v: unknown): PrevResult | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as PrevResult) : null;
}

/** `write`: satır yazılır. `pending`: donmuş, yazılmaz, `recalcPending` işaretlenir. `skip`: etkin itirazda, yazılmaz. */
export type RecompareLineAction = 'write' | 'pending' | 'skip';

export type RecompareLineChange = {
  id: string;
  rowIndex: number;
  trackingNo: string;
  decision: string;
  inDispute: boolean;
  action: RecompareLineAction;
  before: MoneyResult;
  after: MoneyResult;
};

export type RecompareBasisInfo = { tariffRevisionId: string | null; tariffName: string | null; compareSettings: CompareSettings | null };

/** Yazılamayan istek: çağıran 409 döner (toplu yollar atlar ve sayar). */
export type RecompareRefusal = 'LINE_IN_DISPUTE' | 'INVOICE_HAS_DISPUTE';

type LineResultData = ReturnType<typeof resultToLineData>;
type ComputedLine = {
  row: LineRow;
  data: LineResultData;
  /** herhangi bir alan değişti (not, döküm dahil): yazılabilir satır yeniden yazılır */
  changed: boolean;
  /** para sonucu değişti: durum, fark türleri, beklenen, fark ya da ölçüm (aynı ölçümün yeni sürümü sayılmaz) */
  moneyChanged: boolean;
  /** rakam değişti (ölçüm kimliği hariç): eski sonuç `prevResult`'a gider */
  figuresChanged: boolean;
  /** Y18 (inceleme): yeni sonuç yalnız tutar toleransının kuru eksik olduğu için hesaplanamadı (`compareAll`). */
  tolFxMissing?: boolean;
};
type PlanAction = 'write' | 'mark' | 'clear' | 'none';
type PlannedLine = { c: ComputedLine; decision: string; inDispute: boolean; selected: boolean; action: PlanAction; pendingAfter: string | null };

export type RecompareComputation = {
  invoiceId: string;
  companyId: string;
  /** uygulanan dayanak kipi (`patch` taşıyıcıyı ya da tarifeyi değiştiriyorsa `tariff`) */
  basis: RecompareBasis;
  scope: RecompareScope;
  cause: RecalcCause;
  /** faturanın bugün kayıtlı dayanağı */
  from: RecompareBasisInfo;
  /** hesabın yapıldığı dayanak; `from`'dan farklıysa uygulanınca faturaya yazılır */
  to: RecompareBasisInfo;
  totals: { before: InvoiceTotals; after: InvoiceTotals };
  /** yazılacak satırlardan görünür biçimde değişenler (Y32, `visiblyChanged`): pencerenin "Değişen satır" sayısı */
  changedLines: number;
  /**
   * yazılacak satırlardan para sonucu (rakam ya da ölçüm) değişenler, görünür olsun olmasın. Toplu geçişin "fatura
   * taşınır mı" kararı bunu kullanır (Y32 sayımı yazma kararını değiştirmez).
   */
  writtenMoneyChanged: number;
  /**
   * Uygulanınca dokunulacak satır: sonucu yazılan, "yeniden hesap bekliyor" işareti konan ya da silinen (görünür
   * değişiklik olsun olmasın; `planToken`'ın satır kümesi). `changedLines` 0 iken bu > 0 ise web sormadan uygular: ör.
   * kararlı satırın aynı desili yeni ölçümü (işaret silinir, satır yeni ölçüme bağlanır) ya da tolerans içinde kalan
   * Beklenen kayması (Y32 gerilemesi: "değişiklik yok" deyip uygulamamak işareti kalıcı bırakıyordu).
   */
  writeLines: number;
  /** karar verilmiş (itirazda olmayan) satırlardan para sonucu değişenler: `all`/`lineIds`'te yazılır, `open`'da işaretlenir */
  frozenChanged: number;
  /** etkin itirazda olduğu için yazılmayan, para sonucu farklı çıkan satırlar */
  skippedInDispute: number;
  /** etkin itirazdaki satır sayısı (sonucu değişsin değişmesin) */
  inDisputeLines: number;
  /** para sonucu değişen satırlar, satır sırasıyla (tamamı; uç ilk 200'ü döndürür) */
  lines: RecompareLineChange[];
  /** hesaplanan "sonra" sonuçlarının, yazma planının ve hedef dayanağın özeti (sha256) */
  token: string;
};

type ComputeInternals = {
  /** dayanaksız faturada tarife kendiliğinden benimsendi (`pinned` + tümü): kilit altında itiraz yeniden denetlenir */
  implicitAdopt: boolean;
  invoiceUpdatedAt: number;
  readAt: Map<string, number>;
  computed: ComputedLine[];
  rows: LineRow[];
  target: InvoiceBasis;
  writeBasis: boolean;
  effective: { carrierId: string; tariffId: string | null; invoiceDate: Date; currency: string };
  /** başlık değişikliği (yalnız değişen alanlar); `applyRecompare` bunları satırlarla aynı işlemde, kilit altında yazar */
  patch: InvoicePatch;
  opts: NormalizedOptions;
};
const internals = new WeakMap<RecompareComputation, ComputeInternals>();

type NormalizedOptions = { basis: RecompareBasis; scope: RecompareScope; cause: RecalcCause; force: Set<string>; lineIds: Set<string> | null; patient?: boolean };
function normalizeOptions(o: RecompareOptions): NormalizedOptions {
  // Çağıran (uç) gövdeyi doğrular (400); burası programlama hatasına karşı.
  if (o.lineIds && o.basis && o.basis !== 'pinned') throw new Error(`recompare: lineIds requires basis pinned (${o.basis})`);
  return {
    basis: o.basis ?? 'pinned',
    scope: o.scope ?? 'open',
    cause: o.cause ?? 'OTHER',
    force: new Set(o.forceLineIds ?? []),
    lineIds: o.lineIds ? new Set(o.lineIds) : null,
    patient: o.patient,
  };
}

/** Kuruş altı fark aynı sayılır: kayıtlı tutar sütun ölçeğine (2 basamak) yuvarlanmıştır. */
const sameAmount = (a: Prisma.Decimal | null, b: number | null) => (a == null ? b == null : b != null && Math.abs(num(a) - b) < 0.006);

function figuresChanged(row: LineRow, d: LineResultData): boolean {
  return !(
    row.status === d.status &&
    row.diffTypes.join(',') === d.diffTypes.join(',') &&
    sameAmount(row.expectedAmount, d.expectedAmount) &&
    sameAmount(row.diffAmount, d.diffAmount)
  );
}

const moneyOfRow = (l: LineRow): MoneyResult => ({
  status: l.status,
  diffTypes: l.diffTypes,
  expectedAmount: numOrNull(l.expectedAmount),
  diffAmount: numOrNull(l.diffAmount),
  ourChargeableKg: numOrNull(l.ourChargeableKg),
  measurementId: l.measurementId,
  tariffRevisionId: l.tariffRevisionId,
});
const moneyOfData = (d: LineResultData): MoneyResult => ({
  status: d.status,
  diffTypes: d.diffTypes,
  expectedAmount: d.expectedAmount,
  diffAmount: d.diffAmount,
  ourChargeableKg: d.ourChargeableKg,
  measurementId: d.measurementId,
  tariffRevisionId: d.tariffRevisionId,
});

/** Eski sonucu olan satır: beklenen tutarı dolu ya da karşılaştırılmış (Fark var / Uyumlu). */
const hadResult = (row: LineRow) => row.expectedAmount != null || row.status === 'DIFF' || row.status === 'MATCH';

type Db = Prisma.TransactionClient | typeof prisma;

/** Etkin itiraz turundaki satırlar (itiraz tarafıyla aynı koşul: `activeRoundWhere`, `assertLineNotInActiveDispute`). */
async function activeDisputeLineIds(db: Db, companyId: string, invoiceId: string): Promise<Set<string>> {
  const rows = await db.disputeLine.findMany({
    where: { companyId, dispute: { invoiceId, ...activeRoundWhere } },
    select: { invoiceLineId: true },
  });
  return new Set(rows.map((r) => r.invoiceLineId));
}

async function hasActiveRound(db: Db, companyId: string, invoiceId: string): Promise<boolean> {
  return (await db.dispute.findFirst({ where: { companyId, invoiceId, ...activeRoundWhere }, select: { id: true } })) != null;
}

/**
 * Y11: `activeDisputeLineIds` + `hasActiveRound` tek sorguda (hesap ve kilit altındaki yeniden okuma ikisini de ister).
 * Koşul `activeRoundWhere` ile aynı (geri çekilmemiş, yerini başka tura bırakmamış tur); `activeRoundWhere` değişirse
 * burası da değişir (test/recalcQueries.test.ts iki yolu karşılaştırır).
 */
async function activeDisputeState(db: Db, companyId: string, invoiceId: string): Promise<{ lineIds: Set<string>; hasRound: boolean }> {
  const rows = await db.$queryRaw<{ lineId: string | null }[]>`
    SELECT dl."invoiceLineId" AS "lineId"
    FROM "Dispute" d
    LEFT JOIN "DisputeLine" dl ON dl."disputeId" = d."id" AND dl."companyId" = ${companyId}
    WHERE d."companyId" = ${companyId} AND d."invoiceId" = ${invoiceId} AND d."withdrawnAt" IS NULL AND d."supersededAt" IS NULL`;
  return { hasRound: rows.length > 0, lineIds: new Set(rows.flatMap((r) => (r.lineId ? [r.lineId] : []))) };
}

/** Testler için: birleşik sorgu eski iki sorguyla aynı sonucu verir mi. */
export async function activeDisputeStateForTest(companyId: string, invoiceId: string) {
  const [merged, lineIds, hasRound] = await Promise.all([
    activeDisputeState(prisma, companyId, invoiceId),
    activeDisputeLineIds(prisma, companyId, invoiceId),
    hasActiveRound(prisma, companyId, invoiceId),
  ]);
  return { merged: { lineIds: [...merged.lineIds].sort(), hasRound: merged.hasRound }, separate: { lineIds: [...lineIds].sort(), hasRound } };
}

/**
 * Dondurma kuralı, satır başına. Donmuş satır = kararı OPEN olmayan ya da etkin itiraz turunda olan satır.
 *  - Etkin itirazdaki satır hiçbir kipte yazılmaz.
 *  - Karar verilmiş satır yalnız `scope: 'all'`, `lineIds` ya da `forceLineIds` ile yazılır (karar durumu değişmez).
 *  - Yazılmayan donmuş satırın para sonucu farklı çıktıysa `recalcPending` işaretlenir; aynı çıktıysa işaret silinir.
 *  - `lineIds` verildiyse onun dışındaki satırlara hiç dokunulmaz.
 */
/**
 * Kayıtlı satır bayat kurla hesaplanmıştı, yeni hesap taze kurla (`pricing.fxStale` kalktı); aynı tarife sürümü, aynı
 * ölçüm ve aynı tarife (donmuş satırın dayanağı yer değiştirmez).
 */
const staleCleared = (c: ComputedLine) =>
  Boolean(readLinePricing(c.row.pricing)?.fxStale) &&
  !readLinePricing(c.data.pricing)?.fxStale &&
  c.row.tariffRevisionId === (c.data.tariffRevisionId ?? null) &&
  c.row.tariffId === c.data.tariffId &&
  c.row.measurementId === c.data.measurementId;

function planLine(c: ComputedLine, decision: string, inDispute: boolean, o: NormalizedOptions): PlannedLine {
  const id = c.row.id;
  const pending = c.row.recalcPending;
  const base = { c, decision, inDispute };
  if (o.lineIds && !o.lineIds.has(id)) return { ...base, selected: false, action: 'none', pendingAfter: pending };
  const writable = !inDispute && (decision === 'OPEN' || o.scope === 'all' || o.lineIds != null || o.force.has(id));
  if (writable) return { ...base, selected: true, action: c.changed ? 'write' : pending != null ? 'clear' : 'none', pendingAfter: null };
  // Y18 (inceleme): yalnız tolerans kuru eksik diye para sonucu bilinmeyen donmuş satır işaretlenmez, işareti de silinmez
  // (yeni sonuç yok: kur gelince bir sonraki hesap karar verir). Önizleme sayımına da girmez.
  if (c.tolFxMissing) return { ...base, selected: false, action: 'none', pendingAfter: pending };
  // Y18 (inceleme, 5): rakamı aynı kalan donmuş satırda bayat kur işareti taze kurla kalkar (not, döküm, güven yazılır;
  // tutar, durum ve karar değişmez). Etkin itirazdaki satıra dokunulmaz.
  if (!inDispute && !c.moneyChanged && staleCleared(c)) return { ...base, selected: true, action: 'write', pendingAfter: null };
  if (!c.moneyChanged) return { ...base, selected: true, action: pending != null ? 'clear' : 'none', pendingAfter: null };
  // İşaret zaten varsa korunur; yalnız daha belirli neden üstüne yazar (PENDING_RANK).
  const mark = pendingCauseOf(o.cause);
  if (pending != null && pendingRank(pending) >= PENDING_RANK[mark]) return { ...base, selected: true, action: 'none', pendingAfter: pending };
  return { ...base, selected: true, action: 'mark', pendingAfter: mark };
}

const sortedSettings = (s: CompareSettings | null) =>
  s ? [s.edgeTolCm, s.weightTolKg, s.amountTol, s.fxTolerancePct, s.unknownSurchargesAsDiff, s.companyCurrency] : null;
const cents = (n: number | null) => (n == null ? null : Math.round(n * 100));

function planToken(i: ComputeInternals, plan: PlannedLine[]): string {
  const payload = {
    v: 1,
    invoice: [i.effective.carrierId, i.effective.tariffId, i.effective.invoiceDate.toISOString(), i.effective.currency],
    to: [i.target.tariffRevisionId, sortedSettings(i.target.compareSettings)],
    scope: i.opts.lineIds ? null : i.opts.scope,
    lineIds: i.opts.lineIds ? [...i.opts.lineIds].sort() : null,
    lines: plan
      .filter((p) => p.action !== 'none')
      .sort((a, b) => (a.c.row.id < b.c.row.id ? -1 : 1))
      .map((p) => [p.c.row.id, p.action, p.c.data.status, p.c.data.diffTypes.join(','), cents(p.c.data.expectedAmount), cents(p.c.data.diffAmount), p.c.data.measurementId]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Satırın fazla ödemeye katkısı, kuruşla: `[kesin, tahmini]`. Fark çıkmış satırda `max(0, fark)`; tahmini (LOW güvenli)
 * satırınki ikinci kovaya düşer (toplamdaki `overchargeTotal` / `estimatedOverchargeTotal` ayrımı). Karar bakılmaz:
 * yeniden hesap kararı değiştirmez, uyumlu sayılmış satırın farkı da önce/sonra listesinde görünür.
 */
function overchargeShare(status: string, diffAmount: Prisma.Decimal | number | null, pricing: unknown): [number, number] {
  if (status !== 'DIFF') return [0, 0];
  const c = Math.max(0, Math.round(num(diffAmount ?? 0) * 100));
  return isEstimated(pricing) ? [0, c] : [c, 0];
}

/**
 * Y32: önce/sonra penceresinde "değişen satır". Yalnız durum ya da fark türleri değiştiyse veya fazla ödemeye katkısı
 * (kesin ya da tahmini, `overchargeShare`) en az 0,01 değiştiyse. Tolerans içinde kalan küçük kayma (uyumlu satırın
 * farkı 0,00 → 4,93), eksik faturalama (eksi fark) ve yalnız ölçüm sürümü değişimi sayılmaz. Yazma kuralını değiştirmez:
 * satır yine yazılır (`changed`), donmuş satır yine işaretlenir (`moneyChanged`); yalnız sayım ve liste.
 */
function visiblyChanged(row: LineRow, d: LineResultData): boolean {
  if (row.status !== d.status || row.diffTypes.join(',') !== d.diffTypes.join(',')) return true;
  const [a1, a2] = overchargeShare(row.status, row.diffAmount, row.pricing);
  const [b1, b2] = overchargeShare(d.status, d.diffAmount, d.pricing);
  return a1 !== b1 || a2 !== b2;
}

/** Planın sonuçları: sayılar, değişen satırlar ve yazıldıktan sonraki toplam (yazmadan hesaplanır). */
function summarizePlan(plan: PlannedLine[]) {
  const lines: RecompareLineChange[] = [];
  let changedLines = 0;
  let writtenMoneyChanged = 0;
  let frozenChanged = 0;
  let skippedInDispute = 0;
  const after = plan.map((p) => {
    const { row, data } = p.c;
    if (p.selected && p.c.moneyChanged && p.action === 'write') writtenMoneyChanged++;
    // Yazılan satır yalnız görünür değişiklikle sayılır (Y32); yazılmayan (işaretlenen ya da itirazda atlanan) satır
    // "Yeniden hesap bekliyor" işaretini aldığı için eskisi gibi para sonucu değişince sayılır: sayı işaretle tutar.
    if (p.selected && p.c.moneyChanged && (p.action !== 'write' || visiblyChanged(row, data))) {
      const action: RecompareLineAction = p.action === 'write' ? 'write' : p.inDispute ? 'skip' : 'pending';
      if (action === 'write') changedLines++;
      if (p.inDispute) skippedInDispute++;
      else if (p.decision !== 'OPEN') frozenChanged++;
      lines.push({ id: row.id, rowIndex: row.rowIndex, trackingNo: row.trackingNo, decision: p.decision, inDispute: p.inDispute, action, before: moneyOfRow(row), after: moneyOfData(data) });
    }
    const base = { netAmount: row.netAmount, decision: p.decision, parseFlags: row.parseFlags, parseChecked: row.parseChecked, recalcPending: p.pendingAfter };
    return p.action === 'write'
      ? { ...base, status: data.status, diffTypes: data.diffTypes, expectedAmount: data.expectedAmount, diffAmount: data.diffAmount, breakdown: data.breakdown, pricing: data.pricing, note: row.noteManual ? row.note : data.note }
      : { ...base, status: row.status, diffTypes: row.diffTypes, expectedAmount: row.expectedAmount, diffAmount: row.diffAmount, breakdown: row.breakdown, pricing: row.pricing, note: row.note };
  });
  lines.sort((a, b) => a.rowIndex - b.rowIndex);
  return {
    lines,
    changedLines,
    writtenMoneyChanged,
    writeLines: plan.filter((p) => p.action !== 'none').length,
    frozenChanged,
    skippedInDispute,
    inDisputeLines: plan.filter((p) => p.inDispute).length,
    totalsAfter: computeTotals(after),
  };
}

/**
 * Sürüm bu taşıyıcının mı: sürümün kendi taşıyıcısı (`snapshot.carrierId`; taşıyıcı özete girer, tarifenin taşıyıcısı
 * değişince yeni sürüm doğar, eski sürüm eski taşıyıcının kalır). Sürümde alan yoksa tarifenin bugünkü taşıyıcısı; o da
 * yoksa (tarife silinmiş) true. Sürüm yoksa false.
 */
async function revisionOfCarrier(companyId: string, revisionId: string, carrierId: string): Promise<boolean> {
  const rev = await prisma.tariffRevision.findFirst({
    where: { id: revisionId, companyId },
    select: { snapshot: true, tariff: { select: { carrierId: true } } },
  });
  if (!rev) return false;
  const own = snapshotCarrierId(rev.snapshot);
  if (own) return own === carrierId;
  return rev.tariff ? rev.tariff.carrierId === carrierId : true;
}

/** Sürümün taşıyıcısı (`snapshot.carrierId`); okunamıyorsa null. */
export function snapshotCarrierId(snapshot: unknown): string | null {
  const s = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : {};
  return typeof s.carrierId === 'string' && s.carrierId ? s.carrierId : null;
}

/** Firmanın bugünkü hesap ayarı (dayanağın ayar parçası). */
export async function currentCompareSettings(companyId: string): Promise<CompareSettings> {
  const company = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
  return compareSettingsOf(readSettings(company.settings));
}

/** Faturanın etkin itiraz turu var mı (itiraz tarafıyla aynı koşul). */
export function invoiceHasActiveRound(companyId: string, invoiceId: string): Promise<boolean> {
  return hasActiveRound(prisma, companyId, invoiceId);
}

/** Dayanak tarafı: sürümün adı `loadRevisionRows`'tan (sürüm bulunamadıysa null). */
function basisInfoOf(b: { tariffRevisionId: string | null; compareSettings: CompareSettings | null }, revisions: Map<string, RevisionRow>): RecompareBasisInfo {
  const tariffName = b.tariffRevisionId ? (revisions.get(b.tariffRevisionId)?.tariffName ?? null) : null;
  return { tariffRevisionId: b.tariffRevisionId, tariffName, compareSettings: b.compareSettings };
}

/**
 * Yeniden karşılaştırmanın hesabı. Faturaya ve satırlarına hiçbir şey yazmaz (tek yan etki: sürümü henüz yazılmamış
 * tarifede güncel sürüm çözülürken sürümün doğması). Her satır için önce/sonra sonucu, dondurma kuralına göre yazma
 * planını, önce/sonra toplamı ve hedef dayanağı döndürür. Donmuş satır kümesi burada kilitsiz okunur (önizleme);
 * `applyRecompare` aynı kümeyi fatura kilidi altında yeniden okur.
 *
 * Dayanak iki parçadır; her parça ya faturadaki gibi kalır ya bugünküne geçer:
 *  - Tarife sürümü: `tariff` kipinde (ya da `patch` taşıyıcıyı / tarifeyi değiştiriyorsa) `resolveCurrentBasis` ile
 *    faturanın (patch sonrası) BUGÜNKÜ taşıyıcısı ve tarifesinden. Güncel tarife bulunamazsa (tarife silinmiş, taşıyıcının
 *    etkin tarifesi yok) faturanın sürümü yalnız şu durumda korunur: tarife seçimi değişmiyor ve sürüm faturanın
 *    taşıyıcısına ait (`revisionOfCarrier`). Öbür durumda dayanak boşalır, satırlar `NO_TARIFF` olur: başka taşıyıcının
 *    fiyatı kullanılmaz. Öbür kiplerde faturadaki sürüm kalır.
 *  - Ayar: `rules` kipinde bugünkü ayar; öbür kiplerde faturadaki ayar. Ayarı hiç yazılmamış fatura (`compareSettings`
 *    null: dayanak yazmayan eski bir yolla açılmış) her kipte bugünkü ayarla hesaplanır ve ona bağlanır (fark sayılmaz).
 *  - Dayanaksız fatura (`tariffRevisionId` null): kullanıcının başlattığı `pinned` hesap (`scope: 'all'`, `lineIds` yok)
 *    ve ayarı hiç yazılmamış fatura bugünkü tarife sürümünü benimser; otomatik tetikleyici ve satır seçimli hesap
 *    benimsemez (tarifesiz hesap). Etkin itiraz turu varsa hiç benimsenmez (talep o rakamlarla yazıldı).
 *
 * Fatura yoksa ya da silinmişse null. `lineIds` içinde etkin itirazdaki satır varsa `'LINE_IN_DISPUTE'`; `tariff` /
 * `rules` ya da `patch` istenmiş ve faturanın etkin itiraz turu varsa `'INVOICE_HAS_DISPUTE'`. `lineIds` ve `patch` yalnız
 * `pinned` ile (programlama hatası: fırlatır).
 */
export async function computeRecompare(
  invoiceId: string,
  options: RecompareOptions & { patch?: InvoicePatch } = {},
  /**
   * `allowDisputedLines`: `lineIds` içindeki itirazdaki satır reddedilmez (yalnız okuyan çağıran: not geri yükleme).
   * `invoice`: çağıranın az önce okuduğu fatura satırı (Y11; uç zaten okuyor). Yalnız satırlar okunur; Prisma `include`
   * da faturayı ve satırları iki ayrı sorguda okuyordu, aynı anlık görüntü değildi. Bayatlık kilit altında `updatedAt`
   * ile denetlenir (`writeRecompare`).
   */
  internal: { allowDisputedLines?: boolean; invoice?: InvoiceRow } = {},
): Promise<RecompareComputation | RecompareRefusal | null> {
  const head = internal.invoice && internal.invoice.id === invoiceId ? internal.invoice : await prisma.invoice.findFirst({ where: { id: invoiceId } });
  if (!head || head.deletedAt) return null;
  const invoice = { ...head, lines: await prisma.invoiceLine.findMany({ where: { invoiceId: head.id } }) };
  const o = normalizeOptions(options);
  const companyId = invoice.companyId;
  const patch = options.patch ?? {};
  const hasPatch = patch.carrierId !== undefined || patch.tariffId !== undefined || patch.invoiceDate !== undefined || patch.currency !== undefined;
  if (hasPatch && o.basis !== 'pinned') throw new Error(`recompare: patch requires basis pinned (${o.basis})`);
  const effective = {
    carrierId: patch.carrierId ?? invoice.carrierId,
    tariffId: patch.tariffId !== undefined ? patch.tariffId : invoice.tariffId,
    invoiceDate: patch.invoiceDate ?? invoice.invoiceDate,
    currency: patch.currency ?? invoice.currency,
  };
  const tariffMoved = effective.carrierId !== invoice.carrierId || effective.tariffId !== invoice.tariffId;
  const basis: RecompareBasis = tariffMoved ? 'tariff' : o.basis;

  // Y11: satırlar ve turun varlığı tek sorguda (eskiden ikincisi gerektiğinde ayrı sorguydu; sonuç aynı)
  const disputeState = await activeDisputeState(prisma, companyId, invoice.id);
  const inDispute = disputeState.lineIds;
  if (o.lineIds && !internal.allowDisputedLines && [...o.lineIds].some((id) => inDispute.has(id))) return 'LINE_IN_DISPUTE';
  const disputed = () => disputeState.hasRound;
  if ((basis !== 'pinned' || hasPatch) && disputed()) return 'INVOICE_HAS_DISPUTE';

  const stored = { tariffRevisionId: invoice.tariffRevisionId, compareSettings: readCompareSettings(invoice.compareSettings) };
  const implicitAdopt =
    basis === 'pinned' && !o.lineIds && stored.tariffRevisionId == null && (stored.compareSettings == null || o.scope === 'all') && !disputed();
  let tariffRevisionId = stored.tariffRevisionId;
  if (basis === 'tariff' || implicitAdopt) {
    const cur = await resolveCurrentBasis(companyId, effective.carrierId, effective.tariffId);
    const keepStored =
      cur.tariffRevisionId == null &&
      stored.tariffRevisionId != null &&
      effective.tariffId === invoice.tariffId &&
      (await revisionOfCarrier(companyId, stored.tariffRevisionId, effective.carrierId));
    tariffRevisionId = cur.tariffRevisionId ?? (keepStored ? stored.tariffRevisionId : null);
  }
  const compareSettings = basis === 'rules' || stored.compareSettings == null ? await currentCompareSettings(companyId) : stored.compareSettings;
  const target: InvoiceBasis = { tariffRevisionId, compareSettings };
  const revisionMoves = target.tariffRevisionId !== stored.tariffRevisionId;
  const settingsMove = !sameCompareSettings(target.compareSettings, stored.compareSettings);
  const writeBasis = revisionMoves || settingsMove;
  if (options.cause === undefined) {
    // ayarı hiç yazılmamış faturanın ilk bağlanması ayar değişikliği sayılmaz
    if (basis === 'tariff') o.cause = revisionMoves ? 'TARIFF' : 'OTHER';
    else if (basis === 'rules') o.cause = settingsMove && stored.compareSettings != null ? 'RULES' : 'OTHER';
  }

  const parsed = invoice.lines.map(lineRowToParsed);
  // Y11: hedef sürümün fiyatı ve kayıtlı sürümün adı tek sorguda (eskiden fiyat iki, ad bir sorgu)
  const carrierRead: { id: string; row?: CarrierLimitsRow | null } = { id: effective.carrierId };
  const revisions = await loadRevisionRows(companyId, [target.tariffRevisionId, stored.tariffRevisionId], carrierRead);
  const targetRevision = target.tariffRevisionId ? revisions.get(target.tariffRevisionId) : undefined;
  const ctx = await buildContext(
    companyId,
    effective.carrierId,
    invoice.lines.map((l) => l.trackingNo),
    { id: invoice.id, createdAt: invoice.createdAt },
    effective.tariffId,
    invoice.isSample,
    target,
    undefined,
    { pricing: targetRevision ? pricingFromRevision(targetRevision) : null, ...(carrierRead.row !== undefined ? { carrier: carrierRead.row } : {}) },
  );
  await prefetchFx(parsed, ctx, effective.invoiceDate, effective.currency, { patient: o.patient });
  const pinned = new Map<number, MeasurementLite | null>();
  const pinnedHeadId = new Map<number, string | null>();
  const pinnedLines = invoice.lines.filter((l) => l.measurementPinned && l.measurementId);
  const heads = await resolveLatestVersions(companyId, pinnedLines.map((l) => l.measurementId!));
  for (const l of pinnedLines) {
    const head = heads.get(l.measurementId!) ?? null;
    pinned.set(l.rowIndex, head && !head.deletedAt ? head : null);
    pinnedHeadId.set(l.rowIndex, head?.id ?? null);
  }
  // KALANLAR 1.8: elle eşlenen ölçüm dizinde olmayabilir; ölçüm tekrarı onun zincirinden de okunur
  const pinnedLive = [...pinned.values()]
    .filter((h): h is MeasurementLite => h != null && (h.version == null || h.version > 1) && !ctx.remeasured?.has(h.id))
    .map((h) => h.id);
  if (pinnedLive.length) {
    const extra = await remeasuredMeasurements(companyId, [...new Set(pinnedLive)]);
    if (extra.size) ctx.remeasured = new Set([...(ctx.remeasured ?? []), ...extra]);
  }
  // 19-B1: dilimli karşılaştırma ve aşamalar arasında olay döngüsü molası (sonuç aynı)
  const results = await compareAllSliced(parsed, ctx, effective.invoiceDate, pinned);
  await yieldToLoop();
  const byRow = new Map(invoice.lines.map((l) => [l.rowIndex, l]));
  const drafts = results.map(({ line, result, measurementId, tariffId, tariffRevisionId, tolFxMissing }) => {
    const row = byRow.get(line.rowIndex)!;
    const data = resultToLineData(result, pinnedHeadId.has(line.rowIndex) ? pinnedHeadId.get(line.rowIndex)! : measurementId, tariffId, tariffRevisionId);
    return { row, data, figures: figuresChanged(row, data), tolFxMissing };
  });
  // Ölçüm kimliği: aynı ölçümün yeni sürümü (düzeltme zinciri) rakamı değiştirmediyse para sonucu değişmiş sayılmaz
  // (ölçüm eski hâline döndürülünce donmuş satırdaki işaret silinir); başka bir ölçüm ya da eşleşmenin kopması sayılır.
  const moved = drafts.filter((d) => !d.figures && d.row.measurementId !== d.data.measurementId);
  const movedHeads = await resolveLatestVersions(companyId, moved.flatMap((d) => (d.row.measurementId ? [d.row.measurementId] : [])));
  const sameMeasurement = (d: (typeof drafts)[number]) =>
    d.row.measurementId === d.data.measurementId ||
    (d.row.measurementId != null && d.data.measurementId != null && movedHeads.get(d.row.measurementId)?.id === d.data.measurementId);
  await yieldToLoop();
  const computed: ComputedLine[] = drafts.map((d) => ({
    row: d.row,
    data: d.data,
    changed: lineResultChanged(d.row, d.data),
    figuresChanged: d.figures,
    moneyChanged: d.figures || !sameMeasurement(d),
    ...(d.tolFxMissing ? { tolFxMissing: true } : {}),
  }));

  const plan = computed.map((c) => planLine(c, c.row.decision, inDispute.has(c.row.id), o));
  const summary = summarizePlan(plan);
  const inner: ComputeInternals = {
    implicitAdopt,
    invoiceUpdatedAt: +invoice.updatedAt,
    readAt: new Map(invoice.lines.map((l) => [l.id, +l.updatedAt])),
    computed,
    rows: invoice.lines,
    target,
    writeBasis,
    effective,
    patch: hasPatch ? patch : {},
    opts: o,
  };
  const [from, to] = [basisInfoOf(stored, revisions), basisInfoOf(target, revisions)];
  const out: RecompareComputation = {
    invoiceId: invoice.id,
    companyId,
    basis,
    scope: o.scope,
    cause: o.cause,
    from,
    to,
    totals: { before: computeTotals(invoice.lines), after: summary.totalsAfter },
    changedLines: summary.changedLines,
    writtenMoneyChanged: summary.writtenMoneyChanged,
    writeLines: summary.writeLines,
    frozenChanged: summary.frozenChanged,
    skippedInDispute: summary.skippedInDispute,
    inDisputeLines: summary.inDisputeLines,
    lines: summary.lines,
    token: planToken(inner, plan),
  };
  internals.set(out, inner);
  return out;
}

/**
 * Önizleme ucu için: hiçbir şey yazmaz. Dönen `token` onay isteğinde `applyRecompare`'a `expectedToken` olarak verilir.
 * `patch`: taşıyıcı / tarife / tarih / para birimi değişikliğinin önizlemesi (fatura o alanlar değişmiş gibi hesaplanır).
 * Varsayılan `pinned` + `all`.
 */
export function previewRecompare(
  invoiceId: string,
  options: { basis?: RecompareBasis; scope?: RecompareScope; lineIds?: string[]; patch?: InvoicePatch; patient?: boolean; invoice?: InvoiceRow } = {},
): Promise<RecompareComputation | RecompareRefusal | null> {
  return computeRecompare(
    invoiceId,
    { basis: options.basis ?? 'pinned', scope: options.scope ?? 'all', lineIds: options.lineIds, patch: options.patch, patient: options.patient ?? true },
    options.invoice ? { invoice: options.invoice } : {},
  );
}

/** Denetim kaydı (`invoice.recalculate`) için özet; kaydı yazmak çağıranın işidir. */
export type RecompareSummary = {
  basis: RecompareBasis;
  cause: RecalcCause;
  revisionFrom: string | null;
  revisionTo: string | null;
  totalsBefore: InvoiceTotals;
  totalsAfter: InvoiceTotals;
  changedLines: number;
};

export type ApplyRecompareResult = {
  /** Y11: yazımdan sonraki fatura satırı (aynı işlemin son güncellemesinin dönüşü; ilişkisiz) */
  invoice: InvoiceRow;
  totals: InvoiceTotals;
  summary: RecompareSummary;
  /** yazılan satır (para sonucu değişmeyip notu / dökümü değişenler dahil) */
  writtenLines: number;
  frozenChanged: number;
  skippedInDispute: number;
  /** yazımdan sonra `recalcPending` taşıyan satır (= totals.pendingLines) */
  pendingLines: number;
};

const RECOMPARE_ATTEMPTS = 3;

/**
 * Yeniden karşılaştırmayı uygular: hesap kilitsiz yapılır (`computeRecompare`; kur indirmesi uzun sürebilir), satırlar,
 * faturanın dayanağı ve toplam fatura kilidi altında tek işlemde yazılır (05-B2). Donmuş satır kümesi (karar + etkin
 * itiraz turu) kilit altında, yazmadan hemen önce yeniden okunur: itiraz gönderimi ve kararla yarışmaz.
 *
 * Bayat girdi: hesap ile kilit arasında fatura ya da satırlarından biri değiştiyse sonuç yazılmaz, hesap baştan yapılır
 * (en çok 3 deneme). Son denemede yine de yazılır (değişikliği yapan istek kendi karşılaştırmasını ardından çalıştırır);
 * `expectedToken` verilmişse yazılmaz, `'PREVIEW_STALE'` döner.
 *
 * `expectedToken`: önizlemenin `token`'ı. Kilit altında yeniden kurulan özet tutmuyorsa (ölçüm, karar, tarife, ayar ya da
 * satır bu arada değişti) hiçbir şey yazılmaz, `'PREVIEW_STALE'` döner.
 *
 * `patch`: fatura başlığı düzeltmesi (`PATCH /invoices/:id`). Hesap fatura bu alanlar değişmiş gibi yapılır; alanlar
 * satırlar, dayanak ve toplamla aynı işlemde, fatura kilidi altında yazılır. Etkin itiraz turu varsa (hesap sırasında ya
 * da kilit altındaki yeniden okumada) hiçbir şey yazılmaz, `'INVOICE_HAS_DISPUTE'` döner: başlık ile hesap ya birlikte
 * yazılır ya hiç.
 * `onWrite`: aynı işlemde, kilit ve itiraz denetiminden sonra, satırlardan önce çalışır (başlığın hesabı etkilemeyen
 * alanları, denetim kaydı). İkinci bağımsız değişken yazılacak dayanaktır (`target`; aynı işlemde faturaya yazılır).
 * Üçüncüsü kilit altında kurulan planın özetidir: `frozenChanged` = önizlemedeki sayıyla aynı kural, kararı verilmiş
 * (itirazda olmayan) ve sonucu değişen satır (Y123: karar izni olmayanın başlık düzeltmesi buna bakar).
 * Hata fırlatırsa işlemin tamamı geri alınır ve hata çağırana gider.
 */
export type RecompareOnWrite = (tx: Prisma.TransactionClient, target: InvoiceBasis, plan: { frozenChanged: number }) => Promise<void>;

export async function applyRecompare(
  invoiceId: string,
  options: RecompareOptions & {
    expectedToken?: string;
    patch?: InvoicePatch;
    onWrite?: RecompareOnWrite;
    /**
     * Yazım işleminin başında, fatura kilidinden ÖNCE (kilit sırası: `onWrite` içe aktarma kilidini alacaksa onu burada
     * alır; bkz. `lockImportsShared`).
     */
    beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
    /** Y11: çağıranın az önce okuduğu fatura satırı; yalnız ilk denemede kullanılır (bayatsa kilit altında yakalanır) */
    invoice?: InvoiceRow;
  } = {},
): Promise<ApplyRecompareResult | RecompareRefusal | 'PREVIEW_STALE' | null> {
  const { invoice: preloaded, beforeLock, ...opts } = options;
  for (let attempt = 1; ; attempt++) {
    const comp = await computeRecompare(invoiceId, opts, attempt === 1 && preloaded ? { invoice: preloaded } : {});
    if (comp === null || typeof comp === 'string') return comp;
    if (options.expectedToken !== undefined && comp.token !== options.expectedToken) return 'PREVIEW_STALE';
    const result = await writeRecompare(comp, options.expectedToken, attempt < RECOMPARE_ATTEMPTS, options.onWrite, beforeLock);
    if (result !== 'stale') return result;
  }
}

/** Başlık düzeltmesinin yazılan alanları (yalnız verilenler). */
function patchData(p: InvoicePatch): Prisma.InvoiceUncheckedUpdateInput {
  return {
    ...(p.carrierId !== undefined ? { carrierId: p.carrierId } : {}),
    ...(p.tariffId !== undefined ? { tariffId: p.tariffId } : {}),
    ...(p.invoiceDate !== undefined ? { invoiceDate: p.invoiceDate } : {}),
    ...(p.currency !== undefined ? { currency: p.currency } : {}),
  };
}

async function writeRecompare(
  comp: RecompareComputation,
  expectedToken: string | undefined,
  retryOnStale: boolean,
  onWrite?: RecompareOnWrite,
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<ApplyRecompareResult | RecompareRefusal | 'PREVIEW_STALE' | 'stale' | null> {
  const inner = internals.get(comp)!;
  const o = inner.opts;
  const header = patchData(inner.patch);
  const hasPatch = Object.keys(header).length > 0;
  return prisma.$transaction(async (tx) => {
    if (beforeLock) await beforeLock(tx);
    // Y11: kilit ve başlık okuması tek ifadede (FOR UPDATE kilidi bekler, ardından satırın son işlenmiş hâlini döner)
    const [head] = await tx.$queryRaw<{ updatedAt: Date; deletedAt: Date | null }[]>`
      SELECT "updatedAt", "deletedAt" FROM "Invoice" WHERE "id" = ${comp.invoiceId} FOR UPDATE`;
    if (!head || head.deletedAt) return null;
    const current = await tx.invoiceLine.findMany({ where: { invoiceId: comp.invoiceId }, select: { id: true, updatedAt: true, decision: true } });
    const stale = +head.updatedAt !== inner.invoiceUpdatedAt || current.length !== inner.readAt.size || current.some((l) => inner.readAt.get(l.id) !== +l.updatedAt);
    if (stale) {
      if (retryOnStale) return 'stale' as const;
      if (expectedToken !== undefined) return 'PREVIEW_STALE' as const;
    }
    // Donmuş satır kümesi: kilit altında, yazmadan hemen önce (plan riski 5).
    const disputeState = await activeDisputeState(tx, comp.companyId, comp.invoiceId);
    const inDispute = disputeState.lineIds;
    if (o.lineIds && [...o.lineIds].some((id) => inDispute.has(id))) return 'LINE_IN_DISPUTE' as const;
    // `comp.basis`: patch taşıyıcıyı / tarifeyi değiştirince `current`'a yükselmiş kip; patch kendisi de kilitlidir.
    const locks = comp.basis !== 'pinned' || hasPatch || inner.implicitAdopt;
    const disputed = locks && disputeState.hasRound;
    if ((comp.basis !== 'pinned' || hasPatch) && disputed) return 'INVOICE_HAS_DISPUTE' as const;
    // Dayanaksız faturanın tarife benimsemesi de itiraz kilidine tabi: hesaptan sonra itiraz gönderildiyse benimseme
    // yazılmaz; hesap itirazı görerek (benimsemeden) baştan yapılır, önizlemeli onayda plan değiştiği için bayattır.
    if (inner.implicitAdopt && disputed) return expectedToken !== undefined ? ('PREVIEW_STALE' as const) : ('stale' as const);
    const decisions = new Map(current.map((l) => [l.id, l.decision as string]));
    // Bu arada silinmiş satır yazılmaz; kararı kilit altındaki okumadan alınır.
    const plan = inner.computed.filter((c) => decisions.has(c.row.id)).map((c) => planLine(c, decisions.get(c.row.id)!, inDispute.has(c.row.id), o));
    if (expectedToken !== undefined && planToken(inner, plan) !== expectedToken) return 'PREVIEW_STALE' as const;
    const sum = summarizePlan(plan);
    if (onWrite) await onWrite(tx, inner.target, { frozenChanged: sum.frozenChanged });

    const at = new Date().toISOString();
    const updates: LineResultUpdate[] = [];
    const marks: RecalcPendingMark[] = [];
    for (const p of plan) {
      const { row, data } = p.c;
      if (p.action === 'write') {
        updates.push({
          id: row.id,
          keepNote: row.noteManual,
          ...data,
          // yalnız bir adım geri: rakam değişmediyse (not, döküm, ölçüm sürümü) önceki kayıt olduğu gibi kalır
          ...(p.c.figuresChanged && hadResult(row) ? { prevResult: { ...moneyOfRow(row), at, cause: o.cause } } : {}),
        });
      } else if (p.action === 'mark') marks.push({ id: row.id, cause: pendingCauseOf(o.cause) });
      else if (p.action === 'clear') marks.push({ id: row.id, cause: null });
    }
    await writeLineResults(updates, tx);
    await writeRecalcPending(marks, tx);
    // Motor bu faturada koştu: son hesap anı toplamla aynı işlemde (hiçbir satır değişmese de hesap yapıldı). Y11: başlık
    // ve dayanak toplamla aynı güncellemede (eskiden ayrı bir güncelleme); kilit bu işlemin başında alındı.
    const { totals, invoice } = await writeTotalsLocked(tx, comp.invoiceId, new Date(), {
      ...header,
      ...(inner.writeBasis ? { tariffRevisionId: inner.target.tariffRevisionId, compareSettings: inner.target.compareSettings } : {}),
    });
    return {
      invoice,
      totals,
      summary: {
        basis: comp.basis,
        cause: o.cause,
        revisionFrom: comp.from.tariffRevisionId,
        revisionTo: inner.target.tariffRevisionId,
        totalsBefore: comp.totals.before,
        totalsAfter: totals,
        changedLines: sum.changedLines,
      },
      writtenLines: updates.length,
      frozenChanged: sum.frozenChanged,
      skippedInDispute: sum.skippedInDispute,
      pendingLines: totals.pendingLines,
    };
  }, TX_DEFAULTS);
}

/** `recompareInvoice` yazamadığında (yalnız `lineIds`, `tariff` / `rules` kipi ya da `patch` ile olur) fırlatılır. */
export class RecompareRefusedError extends Error {
  readonly code: RecompareRefusal | 'PREVIEW_STALE';
  constructor(code: RecompareRefusal | 'PREVIEW_STALE') {
    super(`recompare refused: ${code}`);
    this.code = code;
  }
}

/**
 * Faturayı yeniden karşılaştırır ve yeni toplamı döndürür (fatura yoksa / silinmişse null). Varsayılan güvenli kiptir:
 * `pinned` + `open` — faturanın kayıtlı tarife sürümü ve ayarıyla, yalnız donmamış satırlar; karar durumu hiçbir yolda
 * değişmez. Sabitlenmiş (elle eşleştirilmiş) satır ölçümünün son sürümünü izler; son sürüm silinmişse satır UNMATCHED
 * olur ama eşleşme durur. Yöneticinin yazdığı not (`noteManual`) karşılaştırma notuyla ezilmez.
 * Önizleme / onay akışı ve reddedilebilen kipler için `previewRecompare` + `applyRecompare` kullanın.
 */
export async function recompareInvoice(invoiceId: string, opts: RecompareOptions = {}): Promise<InvoiceTotals | null> {
  const r = await applyRecompare(invoiceId, opts);
  if (r === null) return null;
  if (typeof r === 'string') throw new RecompareRefusedError(r);
  return r.totals;
}

/**
 * Elle not silinince karşılaştırma notu geri gelir; hiçbir satırın para sonucu değişmez (not yazmak / silmek rakam
 * değiştirmez, §3.14). Satır faturanın sabit dayanağıyla, yazmadan hesaplanır: para sonucu kayıtlıyla aynıysa yalnız
 * not yazılır; farklıysa (satır eski ölçümde, kurda ya da mükerrer durumunda) not boş kalır, rakam ve işaret olduğu gibi
 * kalır. Fatura kilidi altında, satır hesaptan sonra değişmediyse ve hâlâ elle notsuzsa yazılır; toplam (not, kur ve
 * pak sayılarına girer) aynı işlemde yenilenir. Yazıldıysa true.
 */
export async function restoreComparisonNote(invoiceId: string, lineId: string): Promise<boolean> {
  const comp = await computeRecompare(invoiceId, { basis: 'pinned', scope: 'open', lineIds: [lineId], patient: true }, { allowDisputedLines: true });
  if (comp === null || typeof comp === 'string') return false;
  const c = internals.get(comp)!.computed.find((x) => x.row.id === lineId);
  if (!c || c.moneyChanged || c.row.noteManual || c.row.note === c.data.note) return false;
  return prisma.$transaction(async (tx) => {
    await lockInvoiceRow(tx, invoiceId);
    const n = await tx.invoiceLine.updateMany({ where: { id: lineId, noteManual: false, note: null, updatedAt: c.row.updatedAt }, data: { note: c.data.note } });
    if (!n.count) return false;
    await refreshTotals(invoiceId, tx);
    return true;
  }, TX_DEFAULTS);
}

/**
 * After a measurement is created/corrected/deleted/restored: recompare invoices whose lines may match it.
 * `measurementIds` should contain every version of the measurement's chain so lines pinned to (or matched with)
 * any version are refreshed. Sabit dayanak, yalnız açık satırlar: karar verilmiş / itirazdaki satır yazılmaz,
 * sonucu farklı çıkarsa `recalcPending = 'MEASUREMENT'` ile işaretlenir.
 */
export async function recompareForTracking(companyId: string, trackingNos: string[], measurementIds: string[] = []) {
  const candidates = [...new Set(trackingNos.flatMap((t) => trackingCandidates(t)))];
  if (!candidates.length && !measurementIds.length) return [];
  const suffixes = [...new Set(candidates.map((c) => c.slice(-10)).filter((c) => c.length >= 10))];
  // "son 10 karakteri şu olan" (= endsWith, sonek tam 10 karakter) ifade indeksiyle aranır
  // (migration 20261106020000); önce satırlar, sonra silinmemiş faturalar — 600 bin satırda ~200 ms → ~1 ms.
  // 02-B1: arama içe aktarmanın kilidini paylaşımlı alır. Süren içe aktarmanın yazım işlemi bitene dek bekler ve yeni faturayı
  // görür; ya da arama önce biter ve içe aktarma (kilidi aldıktan sonra ölçüm kümesini yeniden okuyup) bu ölçümü kendisi görür.
  // Bekleme en çok o yazım işlemi kadardır (büyük faturada saniyeler); sorgu süresi sınırını aşarsa karşılaştırma düşer ve
  // işaret kalır (yeniden deneme, tarama).
  const lines = await prisma.$transaction(async (tx) => {
    await lockImportsShared(tx, companyId);
    return tx.$queryRaw<{ invoiceId: string }[]>`
      WITH m AS MATERIALIZED (
        SELECT DISTINCT l."invoiceId" FROM "InvoiceLine" l
        WHERE l."companyId" = ${companyId}
          AND (l."trackingNo" = ANY(${candidates}::text[])
            OR right(l."trackingNo", 10) = ANY(${suffixes}::text[])
            OR l."measurementId" = ANY(${measurementIds}::text[]))
      )
      SELECT m."invoiceId" FROM m JOIN "Invoice" i ON i."id" = m."invoiceId"
      WHERE i."deletedAt" IS NULL
      ORDER BY i."createdAt", i."id"`;
  }, IMPORT_WAIT_TX);
  const ids = lines.map((l) => l.invoiceId);
  // arka plan: TCMB kapalıyken ölçüm kaydı uzun beklemesin (devre kesici açık)
  const opts: RecompareOptions = { basis: 'pinned', scope: 'open', cause: 'MEASUREMENT', patient: false };
  for (const id of ids) await recompareInvoice(id, opts);
  // Aynı kolide paralel ölçüm: bu istek ölçüm listesini diğerinin işleminden önce okuyup sonra yazmış olabilir. Satır eski
  // sürümde kaldıysa yeniden karşılaştırılır; bu okuma yazmadan sonra olduğu için son sürümü görür.
  // Donmuş satır (karar verilmiş; etkin itirazdaki satır da karar verilmiştir) bilerek eski ölçüm sürümünü gösterir:
  // sayılmaz, yoksa her ölçümde üç boş tur atılır (plan riski 3).
  for (let round = 0; round < 3 && ids.length; round++) {
    const stale = await prisma.$queryRaw<{ invoiceId: string }[]>`
      SELECT DISTINCT l."invoiceId" FROM "InvoiceLine" l JOIN "Measurement" m ON m."id" = l."measurementId"
      WHERE l."companyId" = ${companyId} AND l."invoiceId" = ANY(${ids}::text[]) AND m."supersededById" IS NOT NULL
        AND l."decision" = 'OPEN' AND l."recalcPending" IS NULL`;
    if (!stale.length) break;
    for (const { invoiceId } of stale) await recompareInvoice(invoiceId, opts);
  }
  return ids;
}

/**
 * 03-B4: ölçüm değişikliğinin (kayıt, yeniden ölçüm, düzeltme, silme, geri yükleme) faturalarla yeniden karşılaştırması.
 * Değişikliği yazan işlem `recomparePendingAt`i doldurur; karşılaştırma başarıyla bitince işaret, yalnız aynı değeri
 * taşıyorsa boşaltılır (bu arada gelen yeni değişikliğin işareti kalır). Karşılaştırma hata verirse işaret kalır: aynı
 * ölçümün tekrar gönderimi ya da bakım işi bu işlevi yeniden çağırır. Takip numaraları ölçümün ve bir önceki sürümünün
 * numarasıdır (düzeltme numarayı değiştirdiyse eskisi de); zincirin her sürümüne bağlı satırlar da yenilenir.
 */
export async function settleMeasurementRecompare(companyId: string, measurementId: string, pendingAt: Date | null) {
  await settleMeasurementRecompares(companyId, [{ measurementId, pendingAt }]);
}

/**
 * 19-B2: aynı firmanın birden çok ölçümü tek karşılaştırmada (sıra, `services/measurementQueue.ts`). Takip numaraları ve
 * zincirler birleşir; her fatura bir kez yeniden hesaplanır (her hesap ölçümlerin o anki son hâlini okur: sonuç, ölçümleri tek
 * tek karşılaştırmanın son hâliyle aynıdır). İşaretler ancak hepsi bitince, her biri kendi değeriyle boşalır; hata olursa hiçbiri
 * boşalmaz. Deneme sayısı (07-B7) işaret boşalınca sıfırlanır.
 */
export async function settleMeasurementRecompares(companyId: string, items: { measurementId: string; pendingAt: Date | null }[]) {
  if (!items.length) return;
  const ids = [...new Set(items.map((i) => i.measurementId))];
  const chains = new Set<string>();
  for (const id of ids) for (const c of await measurementChainIds(companyId, id)) chains.add(c);
  const versions = await prisma.measurement.findMany({
    where: { companyId, OR: [{ id: { in: ids } }, { supersededById: { in: ids } }] },
    select: { trackingNo: true, trackingRaw: true },
  });
  await recompareForTracking(companyId, versions.flatMap((v) => [v.trackingNo, v.trackingRaw]), [...chains]);
  for (const { measurementId, pendingAt } of items) {
    if (!pendingAt) continue;
    await prisma.measurement.updateMany({ where: { id: measurementId, companyId, recomparePendingAt: pendingAt }, data: { recomparePendingAt: null, recompareAttempts: 0 } });
  }
}

/**
 * 07-B1: sonraki faturalara "Mükerrer yeniden hesabı bekliyor" işareti (`InvoiceRecheck`), değişikliği yazan işlemin içinde.
 * Fatura silindi ya da başlığı (taşıyıcı, para birimi, fatura no) ya da bir satırının takip no'su düzeltildi: aynı numaraları
 * taşıyan, bu faturadan SONRA yüklenmiş silinmemiş faturalar seçilir (`recompareLaterDuplicates` ile aynı küme). İçe
 * aktarmanın kilidi paylaşımlı alınır: süren içe aktarma ya önce biter (yeni fatura burada seçilir) ya da bu işlemin
 * değişikliğini kendi kilidi altında görür (silmede `stalePriors`). Hesap yanıttan sonra yapılır (`settleInvoiceRecheck`).
 */
export async function markLaterDuplicates(tx: Prisma.TransactionClient, companyId: string, invoiceId: string, trackingNos: string[] | null): Promise<{ invoiceId: string; pendingAt: Date }[]> {
  await lockImportsShared(tx, companyId);
  const own = trackingNos ?? (await tx.invoiceLine.findMany({ where: { invoiceId, companyId }, select: { trackingNo: true }, distinct: ['trackingNo'] })).map((l) => l.trackingNo);
  if (!own.length) return [];
  const col = Prisma.sql`r."pendingAt"`;
  const at = new Date();
  return tx.$queryRaw<{ invoiceId: string; pendingAt: Date }[]>`
    WITH later AS (
      SELECT DISTINCT i."id" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE l."companyId" = ${companyId} AND l."trackingNo" = ANY(${own}::text[])
        AND i."deletedAt" IS NULL AND NOT i."isSample" AND i."id" <> ${invoiceId}
        AND i."createdAt" > (SELECT b."createdAt" FROM "Invoice" b WHERE b."id" = ${invoiceId})
    )
    INSERT INTO "InvoiceRecheck" AS r ("invoiceId", "companyId", "pendingAt", "attempts")
    SELECT later."id", ${companyId}, ${at}::timestamp(3), 0 FROM later
    ON CONFLICT ("invoiceId") DO UPDATE SET "pendingAt" = ${bumpPending(col, at)}, "attempts" = 0
    RETURNING r."invoiceId", r."pendingAt"`;
}

/**
 * 07-B1: işaretli faturanın mükerrer yeniden hesabı (`recompareLaterDuplicates`'in tek fatura adımı: sabit dayanak, yalnız
 * açık satırlar, donmuş satır `recalcPending = 'DUPLICATE'`). Başarıyla bitince işaret yalnız aynı değerle silinir; bu arada
 * yeniden işaretlendiyse kalır ve hesap yeniden yapılır. Fatura silinmişse işaret silinir (yapacak hesap yok).
 */
export async function settleInvoiceRecheck(companyId: string, invoiceId: string, pendingAt: Date | null) {
  await recompareInvoice(invoiceId, { basis: 'pinned', scope: 'open', cause: 'DUPLICATE', patient: false });
  if (pendingAt) await prisma.invoiceRecheck.deleteMany({ where: { invoiceId, companyId, pendingAt } });
}

/**
 * Bir faturadaki takip numarası artık "önceki fatura" sayılmıyorsa (fatura silindi) ya da yeni sayılıyorsa (satır düzeltildi)
 * sonraki faturaların mükerrer sonucu değişir. Yalnız aynı numarayı taşıyan sonraki faturalar, eskiden yeniye yeniden
 * karşılaştırılır: sabit dayanak, yalnız açık satırlar; donmuş satır `recalcPending = 'DUPLICATE'` ile işaretlenir.
 */
export async function recompareLaterDuplicates(companyId: string, invoiceId: string, trackingNos: string[]) {
  if (!trackingNos.length) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT i."id", i."createdAt" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
    WHERE l."companyId" = ${companyId} AND l."trackingNo" = ANY(${trackingNos}::text[])
      AND i."deletedAt" IS NULL AND NOT i."isSample" AND i."id" <> ${invoiceId}
      AND i."createdAt" > (SELECT b."createdAt" FROM "Invoice" b WHERE b."id" = ${invoiceId})
    ORDER BY i."createdAt", i."id"`;
  for (const { id } of rows) await recompareInvoice(id, { basis: 'pinned', scope: 'open', cause: 'DUPLICATE', patient: false });
  return rows.map((r) => r.id);
}

// ---------- Faturanın dayanak durumu ve toplu geçiş kapsamı ----------

export type InvoiceBasisState = 'CURRENT' | 'TARIFF_CHANGED' | 'TARIFF_REMOVED' | 'RULES_CHANGED' | 'NONE';

/**
 * Faturanın dayanağı bugünkü tarife ve ayara göre nerede (saf). Öncelik: dayanak yok → `NONE`; sürümün tarifesi silinmiş
 * ya da artık başka taşıyıcının → `TARIFF_REMOVED`; tarifenin bugünkü sürümü başka → `TARIFF_CHANGED`; faturanın ayarı
 * bugünkü ayardan farklı → `RULES_CHANGED`; yoksa `CURRENT`. Tarife hem değişmiş hem ayar farklıysa `TARIFF_CHANGED`:
 * "Yeni tarifeyle hesapla" yalnız tarife sürümünü günceller, ardından durum `RULES_CHANGED` olur ve "Yeni ayarla
 * hesapla" sorulur (iki parça ayrı ayrı onaylanır).
 *
 * `tariff`: faturanın SÜRÜMÜNÜN ait olduğu tarife (`TariffRevision.tariffId`), silinmişse null — `loadBasisInfo` verir.
 * `settings`: firmanın bugünkü ayarı (`CompanySettings` ya da `CompareSettings`).
 */
export function invoiceBasisState(
  invoice: { tariffRevisionId: string | null; compareSettings: unknown; carrierId?: string },
  tariff: { currentRevisionId: string | null; carrierId?: string } | null,
  settings: CompanySettings | CompareSettings,
): InvoiceBasisState {
  if (!invoice.tariffRevisionId) return 'NONE';
  if (!tariff) return 'TARIFF_REMOVED';
  // tarife başka taşıyıcıya taşındı: bu faturanın taşıyıcısı için tarife yok, fatura eski sürümün fiyatlarıyla durur
  if (tariff.carrierId && invoice.carrierId && tariff.carrierId !== invoice.carrierId) return 'TARIFF_REMOVED';
  if (tariff.currentRevisionId !== invoice.tariffRevisionId) return 'TARIFF_CHANGED';
  const today = 'companyCurrency' in settings ? settings : compareSettingsOf(settings);
  const own = readCompareSettings(invoice.compareSettings);
  // ayarı hiç yazılmamış fatura ilk hesapta bugünkü ayara bağlanır: fark sayılmaz
  if (own && !sameCompareSettings(own, today)) return 'RULES_CHANGED';
  return 'CURRENT';
}

export type RevisionInfo = {
  revisionId: string;
  /** sürümdeki ad: tarife silinse de okunur */
  tariffName: string;
  /** sürümün tarifesi; silinmişse null */
  tariff: { id: string; name: string; carrierId: string; currentRevisionId: string | null } | null;
  createdAt: Date;
};

/**
 * Fatura yanıtı için: sürüm kimliği → ad ve tarifesi. `invoiceBasisState`'in `tariff` girdisi buradan. Y11: sürüm ve
 * tarifesi tek sorguda (eskiden iki sorgu; koşullar aynı: ikisi de firmanın).
 */
export async function loadBasisInfo(companyId: string, revisionIds: (string | null)[]): Promise<Map<string, RevisionInfo>> {
  const ids = [...new Set(revisionIds.filter((x): x is string => !!x))];
  const out = new Map<string, RevisionInfo>();
  if (!ids.length) return out;
  const rows = await prisma.$queryRaw<
    { id: string; tariffName: string; createdAt: Date; tId: string | null; tName: string | null; tCarrierId: string | null; tCurrentRevisionId: string | null }[]
  >`
    SELECT r."id", r."tariffName", r."createdAt",
      t."id" AS "tId", t."name" AS "tName", t."carrierId" AS "tCarrierId", t."currentRevisionId" AS "tCurrentRevisionId"
    FROM "TariffRevision" r
    LEFT JOIN "Tariff" t ON t."id" = r."tariffId" AND t."companyId" = ${companyId}
    WHERE r."companyId" = ${companyId} AND r."id" = ANY(${ids}::text[])`;
  for (const r of rows) {
    const tariff = r.tId ? { id: r.tId, name: r.tName!, carrierId: r.tCarrierId!, currentRevisionId: r.tCurrentRevisionId } : null;
    out.set(r.id, { revisionId: r.id, tariffName: r.tariffName, tariff, createdAt: r.createdAt });
  }
  return out;
}

/**
 * Toplu "yeni tarifeyle hesapla" kapsamı: bu tarifenin ESKİ sürümleriyle hesaplı (bugünkü sürümünde olmayan), silinmemiş
 * faturalar, eskiden yeniye.
 */
export async function invoicesOnOldRevisions(companyId: string, tariffId: string) {
  const t = await prisma.tariff.findFirst({ where: { id: tariffId, companyId }, select: { currentRevisionId: true } });
  if (!t) return [];
  return prisma.invoice.findMany({
    where: {
      companyId,
      deletedAt: null,
      tariffRevision: { tariffId },
      ...(t.currentRevisionId ? { tariffRevisionId: { not: t.currentRevisionId } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, _count: { select: { lines: true } } },
  });
}

/**
 * Toplu "yeni ayara geçir" kapsamı: `compareSettings`'i firmanın bugünkü ayarından farklı, silinmemiş faturalar, eskiden
 * yeniye. Karşılaştırma jsonb eşitliğidir (anahtar sırasından ve sayının yazımından bağımsız: 5 = 5.0). Ayarı hiç
 * yazılmamış (null) fatura sayılmaz: ilk hesabında bugünkü ayara bağlanır.
 */
export async function invoicesWithOtherSettings(companyId: string): Promise<{ id: string; lines: number }[]> {
  const company = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
  const today = JSON.stringify(compareSettingsOf(readSettings(company.settings)));
  const rows = await prisma.$queryRaw<{ id: string; lines: bigint }[]>`
    SELECT i."id", (SELECT count(*) FROM "InvoiceLine" l WHERE l."invoiceId" = i."id") AS "lines"
    FROM "Invoice" i
    WHERE i."companyId" = ${companyId} AND i."deletedAt" IS NULL
      AND i."compareSettings" IS NOT NULL AND i."compareSettings" <> ${today}::jsonb
    ORDER BY i."createdAt", i."id"`;
  return rows.map((r) => ({ id: r.id, lines: Number(r.lines) }));
}
