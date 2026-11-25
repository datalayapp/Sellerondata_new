import { z } from 'zod';
import { packagingLimitsFor, type CarrierCode, type PackagingLimits } from '@deciship/core';

/**
 * Gönderinin ambalajı (Prisma `Packaging`, core `Packaging` ile aynı değerler): kendi ambalajı (koli), taşıyıcı poşeti (PAK:
 * FedEx Pak, UPS Express Pak, DHL Flyer …), taşıyıcı zarfı (ENVELOPE). Sınırlar ve fiyat kuralı core'da (`packaging.ts`);
 * burada yalnız gövde doğrulaması ve taşıyıcının sınır ayarı.
 */
export const PACKAGING_VALUES = ['OWN', 'PAK', 'ENVELOPE'] as const;
export type PackagingValue = (typeof PACKAGING_VALUES)[number];
export const packagingSchema = z.enum(PACKAGING_VALUES);

/** Kayıtsız (eski satır, eski istemci) ambalaj kendi ambalajıdır. */
export const packagingOf = (v: string | null | undefined): PackagingValue =>
  v === 'PAK' || v === 'ENVELOPE' ? v : 'OWN';

const kg = z.number().positive().max(1000);
const edge = z.number().positive().max(1000);
/**
 * Taşıyıcının poşet / zarf sınırları, firma ayarı (`Carrier.packagingLimits`; core `PackagingLimits`). Alan yok ya da null:
 * o ambalajın sınırı bu ayarda verilmedi (birleştirme kuralı core `packagingLimitsFor`). Bilinmeyen alan reddedilir.
 */
export const packagingLimitsSchema = z
  .object({
    PAK: z.object({ maxKg: kg, maxVolumeCm3: z.number().positive().max(10_000_000).nullable().optional() }).strict().nullable().optional(),
    // zarfın en büyük kenarları (cm), üç pozitif sayı; null = kenar sınırı yok / bilinmiyor
    ENVELOPE: z.object({ maxKg: kg, maxEdgesCm: z.tuple([edge, edge, edge]).nullable().optional() }).strict().nullable().optional(),
  })
  .strict();

/** Kayıtlı ayar (JSON) → sınırlar; boş ya da okunamayan kayıt null (taşıyıcı kodunun varsayılanı geçerli). */
export function readPackagingLimits(v: unknown): PackagingLimits | null {
  if (v == null) return null;
  const p = packagingLimitsSchema.safeParse(v);
  return p.success ? (p.data as PackagingLimits) : null;
}

const CODES = new Set(['fedex', 'ups', 'dhl', 'aras', 'yurtici', 'mng', 'ptt', 'generic']);
/** Taşıyıcı kodu (bilinmeyen kod `generic`). */
export const carrierCodeOf = (code: string | null | undefined): CarrierCode => (code && CODES.has(code) ? (code as CarrierCode) : 'generic');

/** Taşıyıcının etkin sınırları: firma ayarı > taşıyıcı kodunun varsayılanı (core `packagingLimitsFor`). */
export function effectivePackagingLimits(c: { code: string; packagingLimits?: unknown }): PackagingLimits {
  return packagingLimitsFor(carrierCodeOf(c.code), readPackagingLimits(c.packagingLimits));
}
