/**
 * Tartı fotoğrafı (ağırlık adımı, 11-B12). Fotoğraf her zaman taslağa girer (`PHOTO_SCALE`, kanıt); otomatik okuma
 * yalnız çevrimiçiyken yapılır. Çevrimdışıyken düğme kapanmaz: fotoğraf çekilir, satırda "Çevrimdışı. Ağırlığı elle
 * girin." kalır. Düğme yalnız okuma sürerken kapalıdır.
 *
 * Kullanıcı kararı 2026-11-12: ücretli okuma firma ayarıdır (`scaleAiRead`, varsayılan kapalı). Kapalıyken fotoğraf yine
 * çekilir ve kanıt olarak saklanır, hiçbir yere okutulmaz; "otomatik okuma" ile ilgili ileti ya da bekleme görünmez.
 */
export function scaleCameraDisabled(s: { reading: boolean; online: boolean }): boolean {
  return s.reading;
}

/**
 * Çekimden sonra: okuma kapalıysa yalnız saklanır (`keep`, ileti yok); açıksa çevrimiçiyken okunur, çevrimdışıyken
 * saklanır ve elle girilir (`manual`, "Çevrimdışı" iletisi).
 */
export function scaleAfterCapture(online: boolean, aiRead: boolean): 'read' | 'manual' | 'keep' {
  if (!aiRead) return 'keep';
  return online ? 'read' : 'manual';
}

/**
 * Yeni tartı fotoğrafı çekilince önceki okuma geçersizdir (başka fotoğrafın okuması): ekrandaki okuma ve taslaktaki
 * `ocrWeightKg` silinir. Yoksa yeni fotoğrafta "Yapay zekâ okudu" kalır ve aynı değer girilirse yöntem OCR yazılır.
 */
export const SCALE_CAPTURE_RESET = { ocr: null, draft: { ocrWeightKg: null } } as const;

/** Kaydedilen ağırlığın yöntemi: değer şu anki okumayla (0,0005 içinde) aynıysa OCR, değilse elle. */
export function weightMethodOf(value: number, ocrValue: number | null | undefined): 'OCR' | 'MANUAL' {
  return ocrValue !== null && ocrValue !== undefined && Math.abs(ocrValue - value) < 0.0005 ? 'OCR' : 'MANUAL';
}

export type ScaleHintKey = 'weight.offlineAuto' | 'weight.aiRead' | 'weight.photoSaved' | 'weight.autoHint' | 'weight.evidenceHint';

/** Tartı kartının alt satırı (okuma sürmüyor ve hata iletisi yokken). Okuma kapalıyken "otomatik" sözü geçmez. */
export function scaleHintKey(s: { online: boolean; aiRead: boolean; read: boolean; hasPhoto: boolean }): ScaleHintKey {
  if (!s.aiRead) return s.read ? 'weight.aiRead' : s.hasPhoto ? 'weight.photoSaved' : 'weight.evidenceHint';
  if (!s.online) return 'weight.offlineAuto';
  if (s.read) return 'weight.aiRead';
  return s.hasPhoto ? 'weight.photoSaved' : 'weight.autoHint';
}
