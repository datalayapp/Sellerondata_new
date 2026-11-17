import { checkTracking, stripScanNoise } from '@deciship/core/trackingFormat';

/**
 * Barkod ekranında okunan değerle ne yapılacağı (KALANLAR 4.8). Kural core `trackingFormat.ts`'te, sunucu da aynısını kullanır.
 * - `proceed`: takip no gibi görünüyor, akış sürer.
 * - `confirm`: takip no'ya benzemiyor (ürün barkodu, yarım okuma, adres…): tek soru, "Yine de devam et" seçilebilir.
 *   Bilinmeyen biçimli gerçek takip no'lar olabilir; sert engel değildir.
 * - `reject`: kesin geçersiz (çok kısa, çok uzun, yasak karakter): sunucu da reddeder, kayıt "Hatalı" kalırdı; yeniden okutulur.
 * - `ignore`: boş girdi.
 * `code`: taslağa yazılacak ham değer (görünmez işaretler silinmiş, boşluk ve tire okunur kalsın diye durur).
 */
export type ScanDecision = { code: string; action: 'proceed' | 'confirm' | 'reject' | 'ignore' };

export function scanDecision(raw: string, symbology?: string | null): ScanDecision {
  const code = stripScanNoise(raw);
  if (!code) return { code, action: 'ignore' };
  const { verdict } = checkTracking(code, { symbology });
  return { code, action: verdict === 'ok' ? 'proceed' : verdict === 'unusual' ? 'confirm' : 'reject' };
}
