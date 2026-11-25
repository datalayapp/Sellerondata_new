import { z } from 'zod';

/**
 * Fatura sütun eşlemesi (ColumnMapping) doğrulaması. Fatura içe aktarma/kontrol uçları ve
 * taşıyıcının kayıtlı eşlemesi (PATCH /carriers/:id defaultMapping) aynı şemayı kullanır.
 */
const optHeader = z.string().trim().optional().nullable().transform((v) => (v ? v : undefined));
export const mappingSchema = z.object({
  trackingNo: optHeader,
  netAmount: optHeader,
  shipDate: optHeader,
  service: optHeader,
  destCountry: optHeader,
  actualKg: optHeader,
  billedKg: optHeader,
  dimL: optHeader,
  dimW: optHeader,
  dimH: optHeader,
  dims: optHeader,
  billedDivisor: optHeader,
  baseAmount: optHeader,
  discountAmount: optHeader,
  fuelAmount: optHeader,
  currency: optHeader,
  reference: optHeader,
  /** Ambalaj sütunu (FedEx "Service Packaging" / "Paketleme", UPS "Package Type" …); core `parsePackaging` okur. */
  packaging: optHeader,
  /** Ambalaj sütunundaki sayısal kodların tablosu; yok = FedEx. */
  packagingCodes: z.enum(['fedex', 'ups']).nullable().optional().transform((v) => v ?? undefined),
  dimUnit: optHeader,
  actualKgUnit: optHeader,
  billedKgUnit: optHeader,
  surchargeColumns: z.array(z.object({ header: z.string().min(1), code: z.string().min(1) })).default([]),
  chargePairs: z.array(z.object({ label: z.string().min(1), amount: z.string().min(1) })).default([]),
  chargeLabelOverrides: z
    .array(z.object({ label: z.string().min(1), kind: z.enum(['base', 'discount', 'fuel', 'surcharge']), code: z.string().min(1).optional() }))
    .default([]),
  defaultDimUnit: z.enum(['cm', 'in']).optional(),
  defaultWeightUnit: z.enum(['kg', 'lb']).optional(),
  numberFormat: z.enum(['tr', 'en', 'auto']).optional(),
  dateOrder: z.enum(['dmy', 'mdy', 'auto']).optional(),
  /** K36: bu dosyanın "1.500" / "1,500" gibi ağırlık hücrelerinin yazımı (`tr`/`en`; tutarları değiştirmez). Taşıyıcının kayıtlı eşlemesine yazılmaz. */
  weightFormat: z.enum(['tr', 'en']).optional(),
  invoiceNo: optHeader,
  invoiceDate: optHeader,
  invoiceTotal: optHeader,
  amountsIncludeVat: z.boolean().default(false),
  // Bileşen sütunları (navlun, indirim, yakıt, ek ücret) da KDV dahil mi. Verilmezse çekirdek başlıktan ve veriden karar verir.
  componentsIncludeVat: z.boolean().optional(),
  vatPct: z.number().min(0).max(100).default(20),
  desiAsWeight: z.boolean().default(false),
});

/**
 * Taşıyıcının kayıtlı eşlemesine yazılacak hâl: K36 ağırlık seçimi (`weightFormat`) dosya başınadır, kaydedilmez ve kayıtlı
 * eşlemeden okunmaz (sonraki dosyada soru yine sorulur).
 */
export function savedMappingOf<T>(m: T): T {
  if (!m || typeof m !== 'object' || Array.isArray(m) || !('weightFormat' in m)) return m;
  const { weightFormat: _drop, ...rest } = m as T & { weightFormat?: unknown };
  return rest as T;
}

/** Kayıtlı eşlemenin JSON boyut sınırı (gerçek eşlemeler birkaç KB). */
export const MAX_SAVED_MAPPING_BYTES = 64 * 1024;
