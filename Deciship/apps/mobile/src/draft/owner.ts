/**
 * Kapsam (kişi + firma) değişince taslak diskten yeniden okunmalı mı?
 * - Kapsam yok (oturum geçici kapalı): okunmaz, bellekteki taslak korunur.
 * - Bellekteki taslağın sahibi aynı kapsamsa okunmaz: oturum geri geldi, taslak sürer.
 * - Sahip yok (açılış) ya da başka kapsam: okunur. Önceki sahibin taslağı diskte kendi anahtarıyla kalır, silinmez.
 */
export function needsRestore(ownerKey: string | null, currentKey: string | null): boolean {
  return currentKey !== null && ownerKey !== currentKey;
}
