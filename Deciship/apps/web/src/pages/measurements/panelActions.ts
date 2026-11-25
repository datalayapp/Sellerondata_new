/**
 * Ölçüm panelinin alt eylem satırında ne görünür (MeasurementPanel):
 * - `none`: yetki yok (`deciship.measurements.manage`), kayıt yükleniyor ya da sunucu düzenlemeye kapatmış (`canEdit: false`)
 * - `restore`: silinmiş kayıt; tek eylem "Geri yükle"
 * - `edit`: çöp kutusu (Ölçümü sil, onay penceresiyle) + "Düzenle"
 * Silme API'si de aynı izni ister (apps/api routes/measurements.ts); düğme yalnız izni olana çıkar.
 */
export type PanelActions = 'none' | 'restore' | 'edit';

export function panelActions(canManage: boolean, m: { deleted?: boolean; deletedAt?: string | null; canEdit?: boolean } | undefined): PanelActions {
  if (!canManage || !m) return 'none';
  if (m.deleted || m.deletedAt) return 'restore';
  return m.canEdit === false ? 'none' : 'edit';
}
