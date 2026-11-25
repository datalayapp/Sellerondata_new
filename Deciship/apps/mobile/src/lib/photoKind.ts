import type { PhotoKind } from '../api/endpoints';

/** Fotoğrafın nereden geldiği: kameradan çekim ya da galeriden seçim. */
export type PhotoSource = 'camera' | 'gallery';

/**
 * Sunucu yalnız `PHOTO_BOX` türünü koli kanıtı sayar. Galeriden seçilen fotoğrafın ne zaman çekildiği belli değildir:
 * koli fotoğrafı sayılmaz, "diğer fotoğraf" olur. Kamera çekimi koli fotoğrafıdır.
 */
export function photoKindFor(source: PhotoSource): PhotoKind {
  return source === 'gallery' ? 'PHOTO_OTHER' : 'PHOTO_BOX';
}
