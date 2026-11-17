/** Bugün ekranının kuyruk ve bağlantı durumu. `waiting`: bu oturumun bekleyen + hatalı kayıtları. */
export type ListReloadState = { waiting: number; online: boolean };

/**
 * Sunucu listesi bir kez yeniden istenmeli mi? Aşağı çekmeden de liste kendini toparlasın:
 * - Bağlantı geri geldi: liste bağlantı yokken eskimiş ya da hiç gelmemiş olabilir.
 * - Kuyruk boşaldı ve liste yüklenememişti (`listFailed`: hata kutusu var ya da liste hiç gelmedi): sunucuya ulaşılıyor demektir.
 *   Liste yüklüyse istenmez; gönderilen kayıt yerel satırdan görünür.
 */
export function listReloadNeeded(prev: ListReloadState, next: ListReloadState, listFailed: boolean): boolean {
  if (next.online && !prev.online) return true;
  return listFailed && next.online && prev.waiting > 0 && next.waiting === 0;
}
