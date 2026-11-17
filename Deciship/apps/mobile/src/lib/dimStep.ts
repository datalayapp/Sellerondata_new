/**
 * Ölçü alanının − / + düğmesi (DimField). Saf: hızlı ardışık basışta her basış bir öncekinin sonucuna uygulanır;
 * ekrandaki (henüz yeniden çizilmemiş) değer kullanılmaz (G3 ile aynı kural).
 */
export type DimStepOptions = { step: number; min: number; max: number };

/**
 * `current`: alanın son değeri (boşsa null). `overMax`: alanda sınırın üstünde bir değer yazılı (geçersiz, null);
 * o zaman − düğmesi sınırdan başlar.
 */
export function stepDim(current: number | null, dir: 1 | -1, { step, min, max }: DimStepOptions, overMax = false): number {
  const base = current ?? (overMax ? max : 0);
  return Math.min(max, Math.max(min, Math.round((base + dir * step) * 10) / 10));
}
