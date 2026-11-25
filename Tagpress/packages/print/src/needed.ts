import { preferredLabelExtra } from "./label.ts";
import type { PrintKind, PrintRules } from "./types.ts";

/**
 * Raf göstergesi için bir siparişin basılacak adedi ("36 → 40 (+4)"): adet + kurala göre fazlalık.
 * - Etiket: fazlalık siparişin büyüklüğüne göre [labelExtraMin, labelExtraMax] aralığında ölçeklenir.
 * - Sticker: en az `stickerExtraMin` (satıra yuvarlama ve sayfa tamamlama sticker boyutuna bağlı olduğundan gerçek
 *   basılan adet planlayıcıdan gelir; bu değer garanti edilen alt sınırdır).
 * Sayfa kapasitesi bilinmediğinden kapasite kırpması ve yukarı yuvarlama yoktur: gösterge amaçlıdır, plan değil.
 * Adedi sıfır ve altı olan için 0.
 */
export function neededCount(quantity: number, rules: PrintRules, kind: PrintKind): number {
  if (!(quantity > 0)) return 0;
  return quantity + (kind === "label" ? preferredLabelExtra(quantity, rules) : rules.stickerExtraMin);
}
