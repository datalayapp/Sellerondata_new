/**
 * Sayısal tuş takımının saf mantığı (NumPad). Değer Türkçe ondalık (virgül) ile metin olarak tutulur.
 *
 * Hızlı basışta rakam kaybolmasın diye (G3) tuş, ekrandaki son değere değil bir önceki basışın sonucuna uygulanır:
 * `numKeyUpdater` React'in işlevsel güncellemesine (`setState(prev => …)`) verilir; aynı karede gelen basışlar da sırayla
 * birbirinin üstüne eklenir.
 */

export type NumKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ',' | 'del';

export type NumKeyOptions = { maxDecimals: number; maxLength: number };

/**
 * Ağırlığın (kg) ondalık sınırı: tuş takımı, tartı okuması ve taslaktan geri yükleme aynısını kullanır. Geri yükleme daha az
 * ondalıkla yapılırsa kaydedilen ağırlık sessizce yuvarlanır.
 */
export const WEIGHT_DECIMALS = 3;

/** Tek tuşu değere uygular. Kabul edilmeyen basış (ikinci virgül, ondalık ya da uzunluk sınırı) değeri değiştirmez. */
export function applyNumKey(value: string, key: NumKey, { maxDecimals, maxLength }: NumKeyOptions): string {
  if (key === 'del') return value.slice(0, -1);
  if (key === ',') {
    if (value.includes(',') || maxDecimals === 0) return value;
    return (value || '0') + ',';
  }
  const dec = value.split(',')[1];
  if (dec !== undefined && dec.length >= maxDecimals) return value;
  if (value.length >= maxLength) return value;
  if (value === '0') return key;
  return value + key;
}

/** İşlevsel güncelleme: `onChange(numKeyUpdater(k, o))` önceki basışların sonucunu görür. */
export const numKeyUpdater =
  (key: NumKey, options: NumKeyOptions) =>
  (prev: string): string =>
    applyNumKey(prev, key, options);
