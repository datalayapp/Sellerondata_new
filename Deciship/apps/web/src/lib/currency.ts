/**
 * Firmanın para birimi: kullanıcı seçmediğinde yeni kayıtların varsayılanı, Merkez'den gelir.
 * Fiyat görmeyen kişiye yanıtta gelmez; o kişi tutar da görmez. Kaydın kendi para birimi varsa o yazılır.
 */
export function firmCurrency(me: { company: { settings: { currency?: string } } } | null | undefined): string {
  return me?.company.settings.currency ?? 'TRY';
}
