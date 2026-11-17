import { chargeableWeight, desi } from '@deciship/core/calc';

/**
 * Ölçüm ekranındaki canlı hesap (SPEC §3.1 ve §6 madde 4). Bilerek iki ayrı bölen:
 * - **Desi**: firma böleni (`ayarlar.desiDivisor`, varsayılan 3000).
 * - **Hacimsel kg** ve **Ücretli ağırlık**: sabit 5000 (`VOLUMETRIC_DIVISOR`); ücretli = büyük olan (gerçek kg ya da
 *   hacimsel kg), basamaksız. Firma böleni ücretli ağırlığı değiştirmez (G5: bölen 3000'de "Desi 40" ile "Ücretli 24 kg"
 *   tanım gereği birlikte görünür).
 */
export const VOLUMETRIC_DIVISOR = 5000;

export type LiveCalcInput = { l: number | null; w: number | null; h: number | null; kg: number | null; desiDivisor: number };

export function computeLive({ l, w, h, kg, desiDivisor }: LiveCalcInput) {
  if (!l || !w || !h) return null;
  const dims = { l, w, h };
  const actualKg = kg ?? 0;
  const c = chargeableWeight({ dims, actualKg, divisor: VOLUMETRIC_DIVISOR, steps: [] });
  return { desi: desi(dims, desiDivisor), volumetric: c.volumetric, chargeable: c.chargeable, basis: c.basis };
}
