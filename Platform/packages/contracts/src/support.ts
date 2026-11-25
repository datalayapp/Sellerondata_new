/** Destek adresi (Mesaj 14 §4.6). Destek yalnız e-postayla; Merkez, kabuk ve mobil buradan okur. */
export const SUPPORT_EMAIL = 'destek@sellerondata.com';

/**
 * Konu satırı dolu `mailto:` bağlantısı. Boş parçalar atlanır, kalanlar ` · ` ile birleşir
 * (ör. `[t('shell:support.subject'), orgName, document.title]`). Metin çağıranın sözlüğünden gelir.
 */
export function supportMailto(subjectParts: readonly (string | null | undefined)[] = []): string {
  const subject = subjectParts.map((p) => p?.trim()).filter(Boolean).join(' · ');
  return subject ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}` : `mailto:${SUPPORT_EMAIL}`;
}
