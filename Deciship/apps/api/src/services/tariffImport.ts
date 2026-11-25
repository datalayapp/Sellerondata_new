import { currentLocale, m as msg } from '../i18n/index.ts';
import {
  carrierScope,
  checkTariffImport,
  compareWithCurrent,
  effectiveCurrency,
  effectiveOverflow,
  effectiveZones,
  fmtNumber,
  importHeadline,
  importWeightSteps,
  OPEN_WEIGHT,
  parseTariffImport,
  rawRowsText,
  scopeDivisor,
  scopeFuelVariable,
  tariffImportFixes,
  zoneKey,
  type ImportIssue,
  type ParsedTariffImport,
  type RawTariffFile,
  type TariffImportContext,
  type TariffImportOptions,
  type WeightStep,
} from '@deciship/core';
import { z } from 'zod';
import { prisma } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { aiEnabled } from './ai.ts';
import type { TariffReviewInput } from './aiTariffReview.ts';
import { tariffBody, type TariffBody, type TariffFull } from './tariffs.ts';

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 180;

export const importOptionsSchema = z
  .object({
    convertLbToKg: z.boolean().optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'v.currencyCode')
      .optional()
      .nullable()
      .transform((v) => v ?? undefined),
    /** 01-B6: kullanıcının seçtiği sayı biçimi (NUMBER_FORMAT_UNCLEAR / _ASSUMED düzeltmesi) */
    numberFormat: z.enum(['tr', 'en']).optional(),
    /** 01-B12: biçimsiz 0–1 indirimin anlamı (DISCOUNT_UNCLEAR düzeltmesi) */
    discountUnit: z.enum(['percent', 'ratio']).optional(),
    /** KALANLAR 1.7: işaretsiz açık uçlu satırın okuması (OPEN_BAND_UNCLEAR / _ADDITIONAL düzeltmesi) */
    openBandMode: z.enum(['additional', 'perKg', 'flat']).optional(),
  })
  .prefault({});

/** PDF'ten gelen taslak bilgileri (draft.data.pdf). */
export type PdfDraftInfo = {
  documentId: string;
  sectionIds: string[];
  sectionTitles: string[];
  pages: number[];
  includeCountryZones: boolean;
  verification: {
    /** code: değerler PDF metin katmanından kodla alındı (doğrulama kendiliğinden tam); ai: yapay zekâ okudu, metinle karşılaştırıldı */
    method?: 'code' | 'ai';
    checked: number;
    matched: number;
    unmatched: { zone: string; weight: number; price: number; page: number | null }[];
  } | null;
  /** PDF'e özgü kod kontrolleri (doğrulama, düşen sütunlar, bilinmeyen ülkeler …); her analizde eklenir. */
  issues: ImportIssue[];
  suggestedMeta: { fuelPct?: number; validFrom?: string; currency?: string; divisor?: number; discountPct?: number; service?: string };
  /** belgeden okunan bilgiler (inceleme bağlamı) */
  document: Record<string, unknown>;
  priceType: 'net' | 'list' | 'unknown';
  /** 'listDiscount': fiyatlar liste fiyatı × indirim tablosuyla hesaplandı (yoksa tablodaki fiyat) */
  pricing?: 'table' | 'listDiscount';
};

export type DraftData = {
  raw: RawTariffFile;
  /** varsa: uygulama yeni tarife oluşturur (draft.tariffId null) */
  newTariff?: { name: string | null; service: string | null; sourceTariffId: string | null };
  pdf?: PdfDraftInfo;
};

export type RecentContext = NonNullable<TariffImportContext['recent']> & { services: string[] };

export async function cleanupDrafts() {
  await prisma.tariffImportDraft.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - DRAFT_TTL_MS) } } });
}

export async function loadDraft(id: string, companyId: string) {
  const d = await prisma.tariffImportDraft.findFirst({
    where: { id, companyId, createdAt: { gte: new Date(Date.now() - DRAFT_TTL_MS) } },
  });
  if (!d) throw notFound(msg('tariff.draftNotFound'));
  return d;
}

/** Bu taşıyıcının son 180 gündeki (ve kurulumdaki örnek) fatura satırları: ülkeler, para birimleri, hizmetler, en yüksek kg. */
export async function recentInvoiceContext(companyId: string, carrierId: string): Promise<RecentContext> {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000);
  const lines = await prisma.invoiceLine.findMany({
    // kurulumun örnek faturaları tarihinden bağımsız sayılır (eski bir faturayla da tablo önerisi çalışsın)
    where: { companyId, invoice: { carrierId, deletedAt: null, OR: [{ invoiceDate: { gte: since } }, { isSample: true }] } },
    select: { destCountry: true, currency: true, service: true, billedKg: true, invoice: { select: { currency: true } } },
    take: 20000,
  });
  const countries = new Set<string>();
  const currencies = new Set<string>();
  const services = new Map<string, number>();
  let maxBilledKg: number | null = null;
  for (const l of lines) {
    if (l.destCountry) countries.add(l.destCountry.toUpperCase());
    const cur = (l.currency || l.invoice.currency || '').toUpperCase();
    if (cur) currencies.add(cur);
    if (l.service) services.set(l.service, (services.get(l.service) ?? 0) + 1);
    const kg = l.billedKg == null ? null : Number(l.billedKg);
    if (kg != null && Number.isFinite(kg) && (maxBilledKg == null || kg > maxBilledKg)) maxBilledKg = kg;
  }
  return {
    countries: [...countries].sort(),
    currencies: [...currencies].sort(),
    services: [...services.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s]) => s),
    maxBilledKg,
    lineCount: lines.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Hedef: mevcut tarife ya da yeni tarife

export type CarrierLite = { id: string; name: string; code: string };

export type ImportBase =
  | { kind: 'existing'; current: TariffFull }
  | {
      kind: 'new';
      carrier: CarrierLite;
      /** varsayılan ayarların kopyalandığı tarife (PDF'i mevcut bir tarifeden yükleyip "yeni tarife" seçince) */
      source: TariffFull | null;
      name: string | null;
      service: string | null;
      /** dosyada para birimi yoksa firmanınki */
      defaultCurrency: string;
    };

export type NewTariffDefaults = {
  currency: string;
  divisor: number;
  edgeRounding: 'CEIL_CM' | 'NONE';
  weightSteps: { upto: number | null; step: number }[];
  discountPct: number;
  fuelPct: number;
  /** Yakıt değişken mi (kaynak tarife ya da taşıyıcının kapsamı; KALANLAR 1.1). */
  fuelVariable: boolean;
  name: string | null;
  service: string | null;
};

export function newTariffDefaults(
  base: Extract<ImportBase, { kind: 'new' }>,
  parsed: ParsedTariffImport,
  options: TariffImportOptions,
  pdf?: PdfDraftInfo,
): NewTariffDefaults {
  const src = base.source;
  // yeni tarifenin kapsamı: yurt içi 3000 + sabit yakıt, yurt dışı 5000 + değişken (core `carrierScope`; KALANLAR 1.1)
  const scope = carrierScope(base.carrier);
  return {
    currency: (options.currency ?? parsed.detectedCurrency ?? pdf?.suggestedMeta.currency ?? base.defaultCurrency).toUpperCase(),
    divisor: pdf?.suggestedMeta.divisor ?? src?.divisor ?? scopeDivisor(scope),
    edgeRounding: src?.edgeRounding ?? 'CEIL_CM',
    weightSteps: src && Array.isArray(src.weightSteps) ? (src.weightSteps as NewTariffDefaults['weightSteps']) : [],
    discountPct: parsed.discountPct ?? (pdf?.priceType === 'net' ? 0 : (src?.discountPct ?? 0)),
    fuelPct: pdf?.suggestedMeta.fuelPct ?? src?.fuelPct ?? 0,
    fuelVariable: src?.fuelVariable ?? scopeFuelVariable(scope),
    name: base.name,
    service: base.service ?? src?.service ?? pdf?.suggestedMeta.service ?? null,
  };
}

/** Yeni tarife için boş "mevcut" tarife: kontroller karşılaştırmasız çalışır. */
function virtualTariff(base: Extract<ImportBase, { kind: 'new' }>, d: NewTariffDefaults): TariffFull {
  return {
    id: '',
    carrierId: base.carrier.id,
    carrier: base.carrier,
    name: d.name ?? '',
    service: d.service,
    currency: d.currency,
    divisor: d.divisor,
    edgeRounding: d.edgeRounding,
    weightSteps: d.weightSteps,
    discountPct: d.discountPct,
    fuelPct: d.fuelPct,
    fuelVariable: d.fuelVariable,
    pakDiscountPct: null,
    envelopeDiscountPct: null,
    validFrom: null,
    validTo: null,
    active: true,
    isDefault: false,
    zones: [],
    rates: [],
    overflow: [],
    surcharges: base.source?.surcharges ?? [],
    countryAdjustments: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as TariffFull;
}

export function importContext(current: TariffFull, recent: RecentContext, isNew = false): TariffImportContext {
  return {
    tariffCurrency: current.currency,
    currentDiscountPct: current.discountPct,
    currentZones: current.zones,
    // fiyat değişimi kontrolleri koli tablosuna bakar: aynı bölge + ağırlıktaki Pak / Zarf fiyatı karışmasın
    currentRates: ownRates(current.rates),
    currentOverflow: current.overflow,
    currentSurcharges: current.surcharges,
    currentWeightSteps: Array.isArray(current.weightSteps) ? (current.weightSteps as WeightStep[]) : [],
    newTariff: isNew,
    // KALANLAR 1.2 incelemesi: `*` yalnız yurt içi yeni tarifede kendiliğinden (yurt dışında her ülke tek bölgeden fiyatlanırdı)
    domestic: carrierScope(current.carrier) === 'domestic',
    recent,
  };
}

export type ImportAnalysis = {
  raw: RawTariffFile;
  parsed: ParsedTariffImport;
  checks: ImportIssue[];
  ctx: TariffImportContext;
  options: TariffImportOptions;
  base: ImportBase;
  /** kontrollerin karşılaştırdığı tarife: mevcut tarife ya da yeni tarifenin boş hâli */
  current: TariffFull;
  defaults: NewTariffDefaults | null;
  pdf?: PdfDraftInfo;
  /** PDF'ten uygulamada otomatik yazılacak ayarlar */
  auto: ReturnType<typeof pdfAutoSettings>;
};

const ORDER = { error: 0, warning: 1, info: 2 } as const;

export function analyze(raw: RawTariffFile, base: ImportBase, recent: RecentContext, options: TariffImportOptions, pdf?: PdfDraftInfo): ImportAnalysis {
  const parsed = parseTariffImport(raw, options);
  const defaults = base.kind === 'new' ? newTariffDefaults(base, parsed, options, pdf) : null;
  const current = base.kind === 'existing' ? base.current : virtualTariff(base, defaults!);
  const ctx = importContext(current, recent, base.kind === 'new');
  const checks = [...checkTariffImport(parsed, ctx, options, currentLocale()), ...(pdf?.issues ?? [])];
  const auto = pdfAutoSettings(base, current, pdf, parsed);
  const pinned = pinnedPackagingDiscounts(parsed, current, auto.values.discountPct);
  if (pinned.length) {
    checks.push({
      severity: 'info',
      code: 'PACKAGING_DISCOUNT_KEPT',
      title: msg('tariff.packagingDiscountKept', { pct: fmtPct(current.discountPct) }),
    });
  }
  if (auto.text) {
    checks.push({
      severity: 'info',
      code: 'PDF_SETTINGS',
      title: auto.text,
      detail: msg('tariff.autoSettingsDetail'),
    });
  }
  checks.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { raw, parsed, checks, ctx, options, base, current, defaults, pdf, auto };
}

const fmtPct = (n: number) =>
  currentLocale() === 'en' ? `${fmtNumber(n, 2, 'en').replace(/\.00$/, '')}%` : `%${fmtNumber(n).replace(/,00$/, '')}`;

/**
 * PDF'ten gelen ayarlar uygulamada otomatik yazılır: net fiyat → indirim %0, sabit yakıt oranı, hacim böleni.
 * Geçerlilik başlangıcı yalnız öneridir (suggestedMeta.validFrom). Yalnız mevcut değerden farklı olanlar listelenir.
 */
export function pdfAutoSettings(base: ImportBase, current: TariffFull, pdf?: PdfDraftInfo, parsed?: ParsedTariffImport) {
  const values: { discountPct?: number; fuelPct?: number; divisor?: number } = {};
  const lines: string[] = [];
  const isNew = base.kind === 'new';
  // Excel ya da CSV: İndirim sütunu tarifenin indirimidir.
  if (!pdf) {
    if (parsed?.discountPct == null) return { values, lines };
    values.discountPct = parsed.discountPct;
    if (isNew || current.discountPct !== parsed.discountPct) lines.push(msg('tariff.auto.discount', { pct: fmtPct(parsed.discountPct) }));
    const fileText = lines.length ? msg('tariff.auto.fromDocument', { items: lines.join(' · ') }) : null;
    return { values, lines, text: fileText ? fileText.charAt(0).toLocaleUpperCase(currentLocale()) + fileText.slice(1) : null };
  }
  const m = pdf.suggestedMeta;
  if (m.discountPct != null) {
    values.discountPct = m.discountPct;
    if (isNew || current.discountPct !== m.discountPct) lines.push(msg('tariff.auto.netPrice', { pct: fmtPct(m.discountPct) }));
  }
  if (m.fuelPct != null) {
    values.fuelPct = m.fuelPct;
    if (isNew || current.fuelPct !== m.fuelPct) lines.push(msg('tariff.auto.fuel', { pct: fmtPct(m.fuelPct) }));
  }
  if (m.divisor != null) {
    values.divisor = m.divisor;
    if (!isNew && current.divisor !== m.divisor) lines.push(msg('tariff.auto.divisor', { from: current.divisor, to: m.divisor }));
  }
  const text = lines.length ? msg('tariff.auto.fromDocument', { items: lines.join(' · ') }) : null;
  return { values, lines, text: text ? text.charAt(0).toLocaleUpperCase(currentLocale()) + text.slice(1) : null };
}

/** Kendi ambalaj (koli) satırları: fiyat karşılaştırması aynı bölge + ağırlıktaki Pak / Zarf fiyatını koli fiyatına karıştırmasın. */
const ownRates = <T extends { packaging?: string | null }>(rates: T[]): T[] => rates.filter((r) => (r.packaging ?? 'OWN') === 'OWN');

const stripRow = <T extends { row?: number; generated?: boolean; perKg?: boolean }>({ row: _r, generated: _g, perKg, ...rest }: T) => ({
  ...rest,
  perKg: !!perKg,
});

export function targetOf(a: ImportAnalysis) {
  return a.base.kind === 'existing'
    ? ({ kind: 'existing', tariffId: a.base.current.id } as const)
    : ({ kind: 'new', carrierId: a.base.carrier.id } as const);
}

export function previewResponse(draftId: string, fileName: string, a: ImportAnalysis) {
  const { parsed, checks, ctx, options, current } = a;
  const flat = [...new Set(parsed.rates.filter((r) => !r.perKg).map((r) => r.weightUpto))].sort((x, y) => x - y);
  const perKg = [...new Set(parsed.rates.filter((r) => r.perKg).map((r) => r.weightUpto))].sort((x, y) => x - y);
  const all = [...flat, ...perKg].sort((x, y) => x - y);
  return {
    draftId,
    fileName,
    kind: a.raw.kind === 'pdf' ? ('pdf' as const) : ('table' as const),
    target: targetOf(a),
    headline: importHeadline(checks, parsed, ctx, options, a.auto.text ? [a.auto.text] : [], currentLocale()),
    summary: {
      weightCount: flat.length,
      perKgBandCount: perKg.length,
      generatedCount: parsed.rates.filter((r) => r.generated).length,
      zoneCount: new Set(parsed.rates.map((r) => zoneKey(r.zone))).size,
      countryCount: effectiveZones(parsed, ctx).length,
      surchargeCount: parsed.sheets.surcharges ? parsed.surcharges.length : current.surcharges.length,
      minWeight: all[0] ?? null,
      /** en yüksek sabit-fiyat ağırlığı (kg başı bantlar hariç; onlar perKgBandCount'ta) */
      maxWeight: flat[flat.length - 1] ?? (perKg.length ? perKg.filter((w) => w < OPEN_WEIGHT).pop() ?? null : null),
      detectedWeightUnit: parsed.detectedWeightUnit,
      detectedCurrency: parsed.detectedCurrency,
      tariffCurrency: effectiveCurrency(ctx, options),
    },
    zones: parsed.zones,
    rates: parsed.rates.map(stripRow),
    /** Poşet / zarf fiyatları (her satırda `packaging`); tarifeye `rates` ile birlikte yazılır. */
    packagingRates: (parsed.packagingRates ?? []).map(stripRow),
    /** Dosyadaki poşet / zarf indirimi (null = tarifenin indirimi ya da dosyada yok). */
    pakDiscountPct: parsed.pakDiscountPct ?? null,
    envelopeDiscountPct: parsed.envelopeDiscountPct ?? null,
    overflow: effectiveOverflow(parsed, ctx),
    overflowFromFile: parsed.overflow.length > 0,
    surcharges: parsed.surcharges,
    checks,
    canApply: !checks.some((c) => c.severity === 'error'),
    fixes: tariffImportFixes(parsed, ctx, currentLocale()),
    comparison: a.base.kind === 'existing' ? compareWithCurrent(ownRates(parsed.rates), ownRates(current.rates)) : null,
    aiAvailable: aiEnabled(),
    ...(a.defaults
      ? {
          suggestedDefaults: {
            currency: a.defaults.currency,
            divisor: a.defaults.divisor,
            edgeRounding: a.defaults.edgeRounding,
            discountPct: a.defaults.discountPct,
            fuelPct: a.defaults.fuelPct,
            fuelVariable: a.defaults.fuelVariable,
            name: a.defaults.name,
            service: a.defaults.service,
          },
        }
      : {}),
    ...(a.pdf
      ? {
          source: { documentId: a.pdf.documentId, sectionTitles: a.pdf.sectionTitles, pages: a.pdf.pages },
          verification: a.pdf.verification ? { method: a.pdf.verification.method ?? 'ai', ...a.pdf.verification } : null,
          // otomatik uygulanan ayarlar (indirim/yakıt/bölen) öneri olarak tekrar gönderilmez
          suggestedMeta: Object.fromEntries(Object.entries(a.pdf.suggestedMeta).filter(([k]) => !(k in a.auto.values))),
        }
      : parsed.discountPct != null
        ? // Tablo dosyasının İndirim sütunu. `suggestedDefaults.discountPct` hep sayıdır, dosyada var mı söylemez.
          { suggestedMeta: { discountPct: parsed.discountPct } }
        : {}),
  };
}

const ymd = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'v.dateFormat')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'v.invalidDate');

export const applyMetaSchema = z.object({
  name: z.string().trim().min(1, 'v.tariffNameEmpty').max(120, 'v.tariffNameLong').optional(),
  service: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  validFrom: ymd.nullable().optional(),
  validTo: ymd.nullable().optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'v.currencyCode')
    .optional(),
  divisor: z.number().int().min(1000).max(10000).optional(),
  edgeRounding: z.enum(['CEIL_CM', 'NONE']).optional(),
  discountPct: z.number().min(0).max(100).optional(),
  fuelPct: z.number().min(0).max(1000).optional(),
  /** Yeni tarifenin yakıt türü (sihirbazdaki seçim; yoksa taşıyıcının kapsamı ya da kaynak tarife). */
  fuelVariable: z.boolean().optional(),
});
export type ApplyMeta = z.infer<typeof applyMetaSchema>;

function metaScalars(meta: ApplyMeta | undefined) {
  return {
    ...(meta?.name !== undefined ? { name: meta.name } : {}),
    ...(meta?.service !== undefined ? { service: meta.service } : {}),
    ...(meta?.validFrom !== undefined ? { validFrom: meta.validFrom } : {}),
    ...(meta?.validTo !== undefined ? { validTo: meta.validTo } : {}),
    ...(meta?.divisor !== undefined ? { divisor: meta.divisor } : {}),
    ...(meta?.edgeRounding !== undefined ? { edgeRounding: meta.edgeRounding } : {}),
    ...(meta?.discountPct !== undefined ? { discountPct: meta.discountPct } : {}),
    ...(meta?.fuelPct !== undefined ? { fuelPct: meta.fuelPct } : {}),
    ...(meta?.fuelVariable !== undefined ? { fuelVariable: meta.fuelVariable } : {}),
  };
}

/**
 * Dosyanın fiyat satırları, ambalaj ambalaj: dosyada satırı olan ambalajın (kendi ambalajı, Pak, Zarf) fiyatları dosyadakilerle
 * değişir, dosyada hiç satırı olmayan ambalajın mevcut satırları korunur. Yalnız koli tablosu olan dosya elle girilmiş ya da
 * başka belgeden alınmış Pak / Zarf fiyatlarını silmez; yalnız Pak tablosu olan dosya koli tablosunu silmez.
 */
export function importedRates(parsed: Pick<ParsedTariffImport, 'rates' | 'packagingRates'>, current: Pick<TariffFull, 'rates'>): TariffBody['rates'] {
  // `rates` yalnız kendi ambalajı; poşet / zarf satırları ayrı listede (`packagingRates`, her satırda `packaging`)
  const rows = [...parsed.rates, ...(parsed.packagingRates ?? [])].map(stripRow) as TariffBody['rates'];
  const inFile = new Set(rows.map((r) => r.packaging ?? 'OWN'));
  const kept = current.rates.filter((r) => !inFile.has(r.packaging ?? 'OWN'));
  return [...rows, ...kept];
}

/** Dosyadaki poşet / zarf indirimleri; dosyada o ambalajın satırı yoksa alan yazılmaz (mevcut değer korunur). */
function packagingDiscounts(parsed: Pick<ParsedTariffImport, 'packagingRates' | 'pakDiscountPct' | 'envelopeDiscountPct'>) {
  const has = (p: 'PAK' | 'ENVELOPE') => (parsed.packagingRates ?? []).some((r) => r.packaging === p);
  return {
    ...(has('PAK') ? { pakDiscountPct: parsed.pakDiscountPct ?? null } : {}),
    ...(has('ENVELOPE') ? { envelopeDiscountPct: parsed.envelopeDiscountPct ?? null } : {}),
  };
}

/**
 * Dosyada satırı olmayan, korunan poşet / zarf satırlarının indirimi (para kuralı, inceleme): ambalajın kendi indirimi boşsa
 * tarifenin indirimini kullanır; içe aktarma tarifenin indirimini değiştirirse korunan fiyatlara yeni indirim uygulanırdı.
 * Bu ambalajların indirimi içe aktarmadan önceki etkin değerinde (eski `discountPct`) sabitlenir. İndirim değişmiyorsa
 * hiçbir şey yazılmaz (sürüm özeti değişmesin). Dönen: sabitlenecek ambalajlar.
 */
export function pinnedPackagingDiscounts(
  parsed: Pick<ParsedTariffImport, 'packagingRates'>,
  current: Pick<TariffFull, 'rates' | 'discountPct' | 'pakDiscountPct' | 'envelopeDiscountPct'>,
  nextDiscountPct: number | undefined,
): ('PAK' | 'ENVELOPE')[] {
  if (nextDiscountPct === undefined || nextDiscountPct === current.discountPct) return [];
  const inFile = new Set((parsed.packagingRates ?? []).map((r) => r.packaging));
  return (['PAK', 'ENVELOPE'] as const).filter(
    (p) => !inFile.has(p) && current.rates.some((r) => r.packaging === p) && (p === 'PAK' ? current.pakDiscountPct : current.envelopeDiscountPct) == null,
  );
}

/**
 * Uygulanacak tam tarife gövdesi: dosyadaki fiyatlar + (varsa) bölgeler/ek ücretler; dosyada aşım satırı
 * yoksa mevcut aşım fiyatları korunur; dosyada Pak / Zarf satırı yoksa mevcut Pak / Zarf satırları korunur
 * (`importedRates`); diğer ayarlar korunur (meta ile değiştirilebilir).
 */
export function appliedBody(a: ImportAnalysis, meta: ApplyMeta | undefined, opts: { isDefault?: boolean } = {}): TariffBody {
  const { parsed, options, current } = a;
  const { id: _id, carrier: _c, createdAt: _ca, updatedAt: _ua, ...rest } = current;
  const isNew = a.base.kind === 'new';
  if (isNew && !meta?.name?.trim()) {
    throw badRequest('VALIDATION', msg('tariff.nameRequired'), [{ path: 'meta.name', message: msg('v.required') }]);
  }
  const currency = meta?.currency ?? options.currency ?? (isNew ? a.defaults!.currency : current.currency);
  const body = tariffBody.parse({
    ...rest,
    // ağırlık yuvarlama fiyat tablosundan (geri alma: içe aktarma öncesi sürüm)
    weightSteps: importWeightSteps(parsed, a.ctx) ?? (Array.isArray(rest.weightSteps) ? rest.weightSteps : []),
    currency,
    rates: importedRates(parsed, current),
    overflow: effectiveOverflow(parsed, a.ctx),
    // Bölgeler sayfası ya da mevcut eşleme; ikisi de yoksa tek bölgeli tabloda `*` (core `effectiveZones`; KALANLAR 1.2)
    zones: effectiveZones(parsed, a.ctx),
    surcharges: parsed.sheets.surcharges ? parsed.surcharges : current.surcharges,
    // Poşet / zarf indirimi: dosyada o ambalajın satırı varsa dosyadaki (null = tarifenin indirimi), yoksa mevcut değer kalır
    ...packagingDiscounts(parsed),
    ...(isNew ? { isDefault: !!opts.isDefault, active: true } : {}),
    // PDF'ten: net → indirim %0, yakıt, bölen, geçerlilik (meta verilirse o geçerli)
    ...a.auto.values,
    ...metaScalars(meta),
  });
  // korunan poşet / zarf fiyatlarının indirimi eski etkin değerinde kalır (`pinnedPackagingDiscounts`)
  for (const p of pinnedPackagingDiscounts(parsed, current, body.discountPct)) {
    if (p === 'PAK') body.pakDiscountPct = current.discountPct;
    else body.envelopeDiscountPct = current.discountPct;
  }
  return body;
}

export function reviewInput(
  a: ImportAnalysis,
  fileName: string,
  companyName: string,
  carrier: { name: string; code: string },
  recent: RecentContext,
): TariffReviewInput {
  const { parsed, checks, ctx, options, current } = a;
  const flat = parsed.rates.filter((r) => !r.perKg);
  const weights = [...new Set(flat.map((r) => r.weightUpto))].sort((x, y) => x - y);
  const byZone = new Map<string, { weightUpto: number; price: number }[]>();
  for (const r of flat) byZone.set(r.zone, [...(byZone.get(r.zone) ?? []), { weightUpto: r.weightUpto, price: r.price }]);
  const samplePrices = [...byZone.entries()].slice(0, 20).map(([zone, list]) => {
    const s = [...list].sort((x, y) => x.weightUpto - y.weightUpto);
    const idx = [...new Set([0, 1, Math.floor(s.length / 4), Math.floor(s.length / 2), Math.floor((s.length * 3) / 4), s.length - 1])].filter(
      (i) => i >= 0 && i < s.length,
    );
    return { zone, prices: idx.map((i) => s[i]!) };
  });
  const perKgSample = [...new Map(parsed.rates.filter((r) => r.perKg).map((r) => [`${r.zone}|${r.weightUpto}`, r])).values()]
    .slice(0, 30)
    .map((r) => ({ zone: r.zone, weightUpto: r.weightUpto >= OPEN_WEIGHT ? null : r.weightUpto, pricePerKg: r.price }));
  return {
    companyName,
    carrier,
    tariff: {
      name: a.base.kind === 'new' ? (a.defaults?.name ?? '(yeni tarife)') : current.name,
      service: current.service,
      currency: current.currency,
      divisor: current.divisor,
      discountPct: current.discountPct,
      fuelPct: current.fuelPct,
      validFrom: current.validFrom,
      validTo: current.validTo,
    },
    isNewTariff: a.base.kind === 'new',
    fileName,
    rawRows: rawRowsText(a.raw.prices, 400),
    options,
    parsed: {
      zones: parsed.priceZones,
      weightCount: weights.length,
      minWeight: weights[0] ?? null,
      maxWeight: weights[weights.length - 1] ?? null,
      detectedWeightUnit: parsed.detectedWeightUnit,
      detectedCurrency: parsed.detectedCurrency,
      resultingCurrency: effectiveCurrency(ctx, options),
      samplePrices,
      perKgBands: perKgSample,
      generatedFromAdditionalSteps: parsed.rates.filter((r) => r.generated).length,
      overflow: effectiveOverflow(parsed, ctx),
      countryMappingCount: effectiveZones(parsed, ctx).length,
    },
    checks,
    comparison: a.base.kind === 'existing' ? compareWithCurrent(ownRates(parsed.rates), ownRates(current.rates)) : null,
    recent: { lineCount: recent.lineCount ?? 0, services: recent.services, currencies: recent.currencies, countries: recent.countries.slice(0, 60) },
    ...(a.pdf ? { pdfSource: { sectionTitles: a.pdf.sectionTitles, pages: a.pdf.pages, document: a.pdf.document, verification: a.pdf.verification } } : {}),
  };
}

/** İncelemenin hangi seçeneklerle yapıldığı (uygulamada aynı değilse inceleme yok sayılır). */
export function optionsKey(o: TariffImportOptions): string {
  // yeni seçenekler yalnız verildiyse anahtara girer: önceden kaydedilmiş incelemelerin anahtarı değişmez
  return JSON.stringify({
    convertLbToKg: !!o.convertLbToKg,
    currency: o.currency?.toUpperCase() ?? null,
    ...(o.numberFormat ? { numberFormat: o.numberFormat } : {}),
    ...(o.discountUnit ? { discountUnit: o.discountUnit } : {}),
    ...(o.openBandMode ? { openBandMode: o.openBandMode } : {}),
  });
}
