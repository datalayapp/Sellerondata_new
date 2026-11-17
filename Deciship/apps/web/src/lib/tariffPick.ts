/**
 * Faturanın önseçilen tarifesi (K2; tarayıcısız sınanır). Sunucuyla aynı kural: `apps/api/src/services/compare.ts`
 * `tariffForDate`. Tarihler 'YYYY-MM-DD' ile başlayan metin; gün karşılaştırması metinle yapılır.
 */
export type PickableTariff = {
  id: string;
  active: boolean;
  isDefault: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  updatedAt?: string;
};

/** Taşıyıcının varsayılanı: etkin ve "Varsayılan"; yoksa en son güncellenen etkin tarife. */
export function defaultTariffOf<T extends PickableTariff>(list: readonly T[]): T | null {
  const active = list.filter((t) => t.active);
  return active.find((t) => t.isDefault) ?? [...active].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] ?? null;
}

/** Tarife bu gün geçerli mi (başlangıç ve bitiş günü dahil; tarih yoksa sınır yok). */
export function validOn(t: PickableTariff, day: string): boolean {
  return (!t.validFrom || t.validFrom.slice(0, 10) <= day) && (!t.validTo || t.validTo.slice(0, 10) >= day);
}

/**
 * K2: fatura gününde geçerli etkin tarife; birden çoksa önce "Varsayılan", sonra geçerlilik tarihi yazılı olan (dönem
 * tarifesi süresizden özeldir), sonra en son güncellenen. O gün geçerli tarife yoksa ya da gün yoksa varsayılan.
 */
export function tariffForDate<T extends PickableTariff>(list: readonly T[], date?: string | null): T | null {
  const day = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
  if (day) {
    const dated = (t: T) => (t.validFrom || t.validTo ? 1 : 0);
    const valid = list
      .filter((t) => t.active && validOn(t, day))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || dated(b) - dated(a) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    if (valid[0]) return valid[0];
  }
  return defaultTariffOf(list);
}

/**
 * Seçim yenilensin mi. Kişi tarife seçmediyse (boş) önseçilir. Önseçilen tarife kişi dokunmadan duruyorsa ve fatura
 * tarihi değişince başka tarife geçerli olduysa yenilenir; kişinin elle seçtiği tarife korunur.
 * `auto`: son kendiliğinden seçilen tarife (yoksa null).
 */
export function nextAutoPick(value: string, auto: string | null, preferred: string | null): string | null {
  if (!preferred) return null;
  if (!value) return preferred;
  return value === auto && preferred !== value ? preferred : null;
}
