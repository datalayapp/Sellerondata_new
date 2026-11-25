/** Ücret kalemleri toplamı ile net tutar arasındaki izin verilen fark. */
export const CHARGE_TOLERANCE = 0.05;

type ChargeLine = { baseAmount?: number; discountAmount?: number; fuelAmount?: number; surcharges: { amount: number }[]; netAmount: number };

/**
 * Navlun − indirim + yakıt + ek ücretler = net mi? "Tutarlar KDV dahil" seçiliyken bileşen sütunları
 * zaten KDV hariç olabilir (ör. Aras: Navlun KDV hariç, Toplam KDV dahil); o durumda bileşenler KDV ile
 * bölünmeden de karşılaştırılır.
 */
export function chargesMatchNet(l: ChargeLine, vatFactor = 1): boolean {
  const parts = Math.round(
    ((l.baseAmount ?? 0) - (l.discountAmount ?? 0) + (l.fuelAmount ?? 0) + l.surcharges.reduce((a, s) => a + s.amount, 0)) * 100,
  ) / 100;
  if (Math.abs(parts - l.netAmount) <= CHARGE_TOLERANCE + 1e-9) return true;
  return vatFactor !== 1 && Math.abs(parts * vatFactor - l.netAmount) <= CHARGE_TOLERANCE * vatFactor + 1e-9;
}
