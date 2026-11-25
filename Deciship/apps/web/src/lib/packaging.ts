// Ambalaj adları ve seçenekleri. Ad core'dan (`packagingLabel`, taşıyıcıya göre: FedEx Pak, UPS Express Pak, DHL Flyer,
// diğerinde "Kargo poşeti"); kural (sınır, fiyat) panelde yok, API'nin yanıtı gösterilir.
import { packagingLabel, PACKAGINGS, type CarrierCode, type Packaging } from '@deciship/core';
import { getFormatLocale } from './format';

export { PACKAGINGS };
export type { Packaging };

/** Eski sunucu ya da eski kayıt: ambalaj yoksa kendi ambalajı. */
export const packagingOf = (p: string | null | undefined): Packaging => (p === 'PAK' || p === 'ENVELOPE' ? p : 'OWN');

/** Ambalajın taşıyıcıya göre adı, arayüz dilinde. Taşıyıcı bilinmiyorsa genel ad ("Kargo poşeti"). */
export function packagingName(p: Packaging, carrier?: CarrierCode | string | null): string {
  return packagingLabel((carrier ?? null) as CarrierCode | null, p, getFormatLocale());
}

/** Taşıyıcı poşeti ya da zarfı mı (kendi ambalajı değil). */
export const isCarrierPackaging = (p: string | null | undefined): p is 'PAK' | 'ENVELOPE' => p === 'PAK' || p === 'ENVELOPE';
