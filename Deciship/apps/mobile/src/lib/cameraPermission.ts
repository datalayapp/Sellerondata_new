/**
 * Kamera izni yokken ne gösterilir (G2 / 11-B6). Barkod ekranı ve fotoğraf penceresi aynı kuralı kullanır.
 *
 * - İzin henüz okunmadı (`null`) ya da verildi: istem yok.
 * - Yeniden sorulabilir (`canAskAgain`): düğme izni ister ("Kameraya izin ver").
 * - Kalıcı reddedildi (`!canAskAgain`): sistem artık sormaz, düğme hiçbir şey yapmazdı. Düğme telefonun uygulama
 *   ayarlarını açar ("Ayarlarda izin ver"), metin yolu söyler.
 *
 * Anahtarlar `measure` sözlüğündedir.
 */
export type CameraPermLike = { granted: boolean; canAskAgain: boolean } | null | undefined;

export type CameraPermAction = 'ask' | 'settings';

export function cameraPermAction(perm: CameraPermLike): CameraPermAction | null {
  if (!perm || perm.granted) return null;
  return perm.canAskAgain ? 'ask' : 'settings';
}

export type CameraPermButtonKey = 'scan.permButton' | 'scan.permSettingsButton';

export function cameraPermButtonKey(action: CameraPermAction): CameraPermButtonKey {
  return action === 'settings' ? 'scan.permSettingsButton' : 'scan.permButton';
}

/** Açıklama: barkod ekranında elle yazma seçeneği de söylenir. */
export type CameraPermTextKey = 'scan.permText' | 'scan.permSettingsText' | 'ui.cameraPerm' | 'ui.cameraPermSettings';

export function cameraPermTextKey(action: CameraPermAction, place: 'scan' | 'photo'): CameraPermTextKey {
  if (place === 'scan') return action === 'settings' ? 'scan.permSettingsText' : 'scan.permText';
  return action === 'settings' ? 'ui.cameraPermSettings' : 'ui.cameraPerm';
}
