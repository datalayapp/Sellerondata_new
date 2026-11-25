import { localizeComparison, type BreakdownLine, type ImportReport } from '@deciship/core';
import { currentLocale } from '../i18n/index.ts';
import { fxFromBreakdown } from '@deciship/core';
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '../db.ts';
import { fileUrl } from '../lib/storage.ts';
import { num, numOrNull } from '../lib/util.ts';
import { can } from '../lib/access.ts';
import { readSettings } from '../lib/settings.ts';
import { prisma } from '../db.ts';
import { compareSettingsOf, invoiceBasisState, loadBasisInfo, readLinePricing, readPrevResult, type InvoiceBasisState } from './compare.ts';

export const lineInclude = {
  measurement: {
    include: {
      measuredBy: { select: { name: true } },
      files: { select: { id: true, kind: true }, orderBy: { createdAt: 'asc' } },
    },
  },
  tariff: { select: { id: true, name: true } },
} as const satisfies Prisma.InvoiceLineInclude;

export type LineWithMeasurement = Prisma.InvoiceLineGetPayload<{ include: typeof lineInclude }>;

/**
 * Satırın bir adım önceki sonucu (`InvoiceLine.prevResult`). Açık alan seti: fiyat görme izni olmayan kişiye yalnız durum,
 * an ve neden gider; tutarlar, fark türleri ve ücretli ağırlık hiç yazılmaz (app.ts `stripMoney` yalnız son güvencedir).
 * İç kimlikler (ölçüm, tarife sürümü) kimseye gitmez.
 */
export function serializePrevResult(raw: unknown, showMoney: boolean) {
  const p = readPrevResult(raw);
  if (!p) return null;
  const open = { status: p.status, at: p.at, cause: p.cause };
  if (!showMoney) return open;
  return {
    ...open,
    diffTypes: p.diffTypes ?? [],
    expectedAmount: p.expectedAmount ?? null,
    diffAmount: p.diffAmount ?? null,
    ourChargeableKg: p.ourChargeableKg ?? null,
  };
}

/** `req` yoksa (rapor üretimi: dışa aktarma izniyle, tutarlar zaten raporun konusu) tutarlar yazılır. */
export function serializeLine(l: LineWithMeasurement, req: FastifyRequest | null) {
  const showMoney = req ? can(req, 'deciship.prices.view') : true;
  // A pinned measurement that has been deleted keeps `measurementId` (the pin) but is not shown as a match.
  const m = l.measurement && !l.measurement.deletedAt ? l.measurement : null;
  const pricing = readLinePricing(l.pricing);
  // Notlar Türkçe saklanır: gösterirken isteğin diline çevrilir, hesap değişmez.
  const text = localizeComparison({ note: l.note, confidenceReason: pricing?.confidenceReason ?? null, breakdown: l.breakdown as BreakdownLine[] }, currentLocale());
  return {
    id: l.id,
    invoiceId: l.invoiceId,
    rowIndex: l.rowIndex,
    trackingNo: l.trackingNo,
    originalTrackingNo: l.originalTrackingNo,
    shipDate: l.shipDate ? l.shipDate.toISOString().slice(0, 10) : null,
    service: l.service,
    destCountry: l.destCountry,
    actualKg: numOrNull(l.actualKg),
    billedKg: numOrNull(l.billedKg),
    dimL: numOrNull(l.dimL),
    dimW: numOrNull(l.dimW),
    dimH: numOrNull(l.dimH),
    dims: l.dimL != null && l.dimW != null && l.dimH != null ? { l: num(l.dimL), w: num(l.dimW), h: num(l.dimH) } : null,
    billedDivisor: l.billedDivisor,
    baseAmount: numOrNull(l.baseAmount),
    discountAmount: numOrNull(l.discountAmount),
    fuelAmount: numOrNull(l.fuelAmount),
    surcharges: l.surcharges,
    netAmount: num(l.netAmount),
    currency: l.currency,
    reference: l.reference,
    /** Faturadaki ambalaj (OWN / PAK / ENVELOPE); null = faturada bilgi yok. */
    packaging: l.packaging,
    /** SPEC §11: okuma kontrolü bayrakları; `parseChecked` = "Kontrol ettim". */
    parseFlags: l.parseFlags ?? [],
    parseChecked: l.parseChecked ?? false,
    measurementId: l.measurementId,
    measurementPinned: l.measurementPinned,
    tariffId: l.tariffId,
    /** Karşılaştırmada kullanılan tarife (ad, tarife düzenleyicisine bağlantı için id). */
    tariff: l.tariff ? { id: l.tariff.id, name: l.tariff.name } : null,
    status: l.status,
    diffTypes: l.diffTypes,
    ourChargeableKg: numOrNull(l.ourChargeableKg),
    billedChargeableKg: numOrNull(l.billedChargeableKg),
    expectedAmount: numOrNull(l.expectedAmount),
    diffAmount: numOrNull(l.diffAmount),
    breakdown: text.breakdown,
    /** Kur çevrildiyse uygulanan kur (breakdown'daki çevrim kaleminden). */
    fx: fxFromBreakdown(l.breakdown),
    /** SPEC §3.8: fiyat dayanağı, tarifeye göre sapma, güven (eski satırlarda null → kesin). */
    pricingBasis: pricing?.basis ?? null,
    rateDeviationPct: pricing?.rateDeviationPct ?? null,
    confidence: pricing?.confidence ?? 'HIGH',
    confidenceReason: showMoney ? (text.confidenceReason ?? null) : null, // gerekçe metni tutar içerebilir; fiyat izni olmayana kısa neden `reviewCode` ile gider
    /**
     * "İncele" nedeninin sınıfı (core `ReviewCode`: MULTI_PARCEL, SERVICE, SERVICE_UNKNOWN, SERVICE_MISSING, DUPLICATE, TARIFF_ONLY, EXTREME_RATE, EXTREME_WEIGHT, FUEL_RATE, FUEL_UNKNOWN, FUEL_SURCHARGE, FX_STALE, ZONE_DISTANCE,
     * PACKAGING_UNKNOWN, PACKAGING_LIMIT_UNKNOWN, PACKAGING_ENVELOPE, PACKAGING_NEAR_LIMIT);
     * yalnız güveni düşük satırda, yoksa null. Kod tutar taşımaz: fiyat izni olmayan kişi de kısa etiketi görür.
     */
    reviewCode: pricing?.confidence === 'LOW' ? (pricing.reviewCode ?? null) : null,
    /** Beklenen taşıyıcı poşeti / zarfı fiyatıyla hesaplandıysa o ambalaj (PAK / ENVELOPE); kendi ambalajında null. */
    pricedPackaging: pricing?.pricedPackaging ?? null,
    note: text.note ?? null,
    decision: l.decision,
    decisionReason: l.decisionReason,
    decidedAt: l.decidedAt,
    /** Mesaj 4: sonuç değişmeden önceki hâl ("eski fark şuydu"); hiç değişmediyse null. */
    prevResult: serializePrevResult(l.prevResult, showMoney),
    /** Donmuş (kararlı ya da itirazdaki) satırda yeni hesap farklı çıktı ama yazılmadı; üç sınıf: MEASUREMENT | DUPLICATE | OTHER (`prevResult.cause` yedi değer). */
    recalcPending: l.recalcPending,
    recalcPendingAt: l.recalcPendingAt ? l.recalcPendingAt.toISOString() : null,
    measurement: m
      ? {
          id: m.id,
          trackingNo: m.trackingNo,
          lengthCm: num(m.lengthCm),
          widthCm: num(m.widthCm),
          heightCm: num(m.heightCm),
          weightKg: num(m.weightKg),
          dimMethod: m.dimMethod,
          weightMethod: m.weightMethod,
          /** Gönderinin kayıtlı ambalajı (ölçü ekranındaki seçim). */
          packaging: m.packaging,
          measuredAt: m.measuredAt.toISOString(),
          measuredByName: m.measuredBy.name,
          version: m.version,
          photos: req ? m.files.map((f) => ({ id: f.id, kind: f.kind, url: fileUrl(req, f.id, m.companyId) })) : [],
          /** Ölçümün fotoğraf sayısı; rapor üretiminde (`req` yok) bağlantı yazılmasa da sayı doğrudur. */
          photoCount: m.files.filter((f) => f.kind.startsWith('PHOTO_')).length,
        }
      : null,
  };
}

export type SerializedLine = ReturnType<typeof serializeLine>;

export type InvoiceBasisView = {
  state: InvoiceBasisState;
  /** hesabın dayandığı tarifenin adı; tarife silindiyse sürümdeki ad */
  tariffName: string | null;
  /**
   * Motorun faturayı son koştuğu an (`Invoice.calculatedAt`: oluşturma, yeniden karşılaştırma). Karar, not ve "Kontrol ettim"
   * ilerletmez. Sütun boşsa (göçten önce yazılmış satır sayılmaz; göç doldurur) `updatedAt`.
   */
  calculatedAt: string | null;
};

type BasisSource = { id: string; carrierId?: string; tariffRevisionId: string | null; compareSettings: unknown; updatedAt: Date; calculatedAt?: Date | null };

/** Fatura yanıtındaki `basis`: faturanın dayanağı bugünkü tarife ve ayara göre nerede (`invoiceBasisState`). */
export async function invoiceBasisViews(companyId: string, invoices: BasisSource[]): Promise<Map<string, InvoiceBasisView>> {
  const out = new Map<string, InvoiceBasisView>();
  if (!invoices.length) return out;
  const [info, company] = await Promise.all([
    loadBasisInfo(companyId, invoices.map((i) => i.tariffRevisionId)),
    prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } }),
  ]);
  const today = compareSettingsOf(readSettings(company.settings));
  for (const inv of invoices) {
    const rev = inv.tariffRevisionId ? info.get(inv.tariffRevisionId) : undefined;
    out.set(inv.id, {
      state: invoiceBasisState(inv, rev?.tariff ?? null, today),
      tariffName: rev ? (rev.tariff?.name ?? rev.tariffName) : null,
      calculatedAt: (inv.calculatedAt ?? inv.updatedAt).toISOString(),
    });
  }
  return out;
}

export async function invoiceBasisView(companyId: string, invoice: BasisSource): Promise<InvoiceBasisView> {
  return (await invoiceBasisViews(companyId, [invoice])).get(invoice.id)!;
}

/** Fiyat izni olmayana gitmeyen yükleme özeti alanları (tutar ve ham tutar metni). */
const IMPORT_REPORT_MONEY = new Set(['amount', 'rawNet', 'noTrackingAmount']);

/**
 * `GET /invoices/:id` `importReport`: kayıtlı yükleme özeti (core `ImportReport`, version 1); Mesaj 5 öncesi faturada null.
 * Açık alan seti: fiyat görme izni olmayana tutarlar (`amount`, `rawNet`, `noTrackingAmount`) yazılmaz; sayılar ve
 * nedenler gider (app.ts `stripMoney` yalnız son güvencedir). `req` yoksa (rapor) tutarlar yazılır.
 */
export function serializeImportReport(raw: unknown, req: FastifyRequest | null): ImportReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as ImportReport;
  if (r.version !== 1) return null;
  if (!req || can(req, 'deciship.prices.view')) return r;
  const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([k]) => !IMPORT_REPORT_MONEY.has(k))) as T;
  return { ...drop(r), skippedRows: (r.skippedRows ?? []).map(drop) };
}
