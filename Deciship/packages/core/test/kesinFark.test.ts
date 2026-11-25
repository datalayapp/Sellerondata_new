/**
 * Yeni denetim (DENETIM-2) Mesaj 2: karşılaştırma yanlış "kesin fark" demesin.
 * - B1: tarifenin hizmeti boş ya da kısaltmayla ("IE", "IP") yazılmışken karışık hizmetli faturada Priority satırı Economy
 *   fiyatıyla kesin "Fiyat farkı" oluyordu.
 * - B3: taşıyıcının ham kg'ı basamak sınırını tolerans içinde aşınca ağırlık farkı "Fiyat farkı" görünüyordu.
 * - B10: hem fiyat hem ek ücret fazlası olan satır yalnız "Ek ücret farkı" görünüyordu.
 * - B2 (eski Y17, kullanıcı adına karar): değişken yakıtlı tarifede yakıt ayrı yazılmamışsa fiyat farkı "İncele".
 */
import { describe, expect, it } from 'vitest';
import {
  VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW,
  compareLine,
  expectedCharge,
  invoiceHasMixedServices,
  localizeComparison,
  serviceClassWords,
  serviceMismatch,
  sumMoney,
  t,
  tariffHealth,
  type TariffInput,
} from '../src/index';
import { ARAS, FEDEX, TOL, line, meas } from './fixtures';

const at = (tariff: TariffInput, kg: number, destCountry = 'FR', surchargeCodes: string[] = []) => {
  const e = expectedCharge({ tariff, chargeableKg: kg, destCountry, surchargeCodes });
  if (!e.ok) throw new Error('fixture');
  return e;
};

describe('B1: hizmeti belirsiz tarife, karışık hizmetli fatura', () => {
  /** Priority satırı Economy tarifesinden %25 pahalı (gerçek Priority fiyatı); fark hizmetten. */
  const six = at(FEDEX, 6);
  const priority = line({ trackingNo: 'B1P', billedKg: 6, service: 'FedEx International Priority', netAmount: Math.round(six.total * 1.25 * 100) / 100 });
  const economy = line({ trackingNo: 'B1E', billedKg: 6, service: 'FedEx International Economy', netAmount: Math.round(six.total * 1.1 * 100) / 100 });
  const m = meas(30, 30, 20, 5.6);
  const cmp = (l: ReturnType<typeof line>, service: string | undefined, mixedServices?: boolean) =>
    compareLine({ line: l, measurement: m, tariff: { ...FEDEX, service }, tol: TOL, isDuplicate: false, ...(mixedServices != null ? { mixedServices } : {}) });

  it('FedEx/DHL kısaltmaları hizmet sınıfı sayılır', () => {
    expect(serviceClassWords('IE')).toEqual(['economy']);
    expect(serviceClassWords('IP')).toEqual(['priority']);
    expect(serviceClassWords('FedEx IPF')).toEqual(['freight', 'priority']);
    expect(serviceClassWords('IEF')).toEqual(['economy', 'freight']);
    expect(serviceClassWords('DHL WPX')).toEqual(['express']);
    expect(serviceMismatch('FedEx International Priority', 'IE')).toBe(true);
    expect(serviceMismatch('FedEx Intl Economy', 'IE')).toBe(false);
    expect(serviceMismatch('International Priority', 'IP')).toBe(false);
    expect(serviceMismatch('International Priority Freight', 'IP')).toBe(true);
  });

  it('tarife hizmeti "IE": Priority satırı "İncele" (SERVICE), Economy satırı kesin kalır', () => {
    expect(cmp(priority, 'IE')).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'SERVICE' });
    expect(cmp(economy, 'IE')).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
  });

  it('faturada farklı hizmet sınıfları var mı', () => {
    expect(invoiceHasMixedServices(['FedEx International Economy', 'FedEx International Priority'])).toBe(true);
    expect(invoiceHasMixedServices(['IE', 'International Economy', null, 'FedEx'])).toBe(false);
    // pak/zarf satırları karşılaştırmaya girmez, karışıklık saymaz
    expect(invoiceHasMixedServices(['International Economy', 'FedEx Intl Priority Pak'])).toBe(false);
    expect(invoiceHasMixedServices([])).toBe(false);
    expect(invoiceHasMixedServices(['UPS Express Saver', 'UPS Saver'])).toBe(false);
  });

  it('tarife hizmeti boş ya da tanınmıyor + karışık fatura: fark "İncele" (SERVICE_UNKNOWN), tutar aynı', () => {
    for (const svc of ['', undefined, 'FedEx 2026']) {
      const r = cmp(priority, svc, true);
      expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'SERVICE_UNKNOWN' });
      expect(r.diffAmount).toBe(cmp(priority, svc).diffAmount);
      expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.serviceUnknown'));
    }
    // fark satırının hizmeti Economy olsa da: hangi hizmetin tarifesi olduğu bilinmiyor
    expect(cmp(economy, '', true)).toMatchObject({ confidence: 'LOW', reviewCode: 'SERVICE_UNKNOWN' });
    const en = localizeComparison(cmp(priority, '', true), 'en').confidenceReason!;
    expect(en).toBe(t('en', 'compare.confidence.serviceUnknown'));
    expect(en).not.toMatch(/[ığşçöü]/);
  });

  it('tek hizmetli faturada (karışık değil) boş tarife hizmeti bugünkü gibi kesin', () => {
    expect(cmp(priority, '', false)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
    expect(cmp(priority, undefined)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
  });

  it('karışık faturada uyumlu satır işaretlenmez; tarifede sınıf varsa eski kural', () => {
    const ok = line({ trackingNo: 'B1M', billedKg: 6, service: 'FedEx International Economy', netAmount: six.total });
    const r = cmp(ok, '', true);
    expect(r).toMatchObject({ status: 'MATCH', confidence: 'HIGH' });
    expect(r.reviewCode).toBeUndefined();
    expect(cmp(economy, 'International Economy', true)).toMatchObject({ confidence: 'HIGH' });
    expect(cmp(priority, 'International Economy', true)).toMatchObject({ confidence: 'LOW', reviewCode: 'SERVICE' });
  });

  it('tarife uyumu: hizmeti belirsiz tarifede karışık faturada ülke istisnası önerilmez', () => {
    const lines = Array.from({ length: 4 }, () => ({ destCountry: 'FR', service: 'FedEx International Priority', zone: 'A', rateDeviationPct: 25, fx: false }));
    const g = tariffHealth(lines, { tariffService: '', mixedServices: true }).groups[0]!;
    expect(g).toMatchObject({ status: 'pricier', suggestedAdjustmentPct: null });
    expect(g.message).toBe(t('tr', 'health.serviceUnknown', { head: 'Fransa (4 satır)' }));
    expect(tariffHealth(lines, { tariffService: '', mixedServices: true, locale: 'en' }).groups[0]!.message).not.toMatch(/[ığşçöü]/);
    // tek hizmetli fatura: öneri bugünkü gibi
    expect(tariffHealth(lines, { tariffService: '' }).groups[0]!.suggestedAdjustmentPct).not.toBeNull();
    // uyumlu grup: mesaj değişmez
    const ok = lines.map((l) => ({ ...l, rateDeviationPct: 0 }));
    expect(tariffHealth(ok, { tariffService: '', mixedServices: true }).groups[0]!.message).toBe(tariffHealth(ok, { tariffService: '' }).groups[0]!.message);
  });
});

describe('B3: taşıyıcının ham kg\'ı basamağı tolerans içinde aşıyor', () => {
  const m = meas(30, 30, 20, 5.6); // bizim ücretli kg 6,0; paylı ölçüm de 6,0
  const six5 = at(FEDEX, 6.5);
  const cmpF = (billedKg: number, netAmount: number, mm = m) => compareLine({ line: line({ trackingNo: 'B3', billedKg, netAmount }), measurement: mm, tariff: FEDEX, tol: TOL, isDuplicate: false });

  it('6,05 kg ve 6,11 kg (ikisi de 6,5 basamağından fiyatlanmış) aynı sonucu verir: kesin ağırlık farkı', () => {
    const a = cmpF(6.05, six5.total);
    const b = cmpF(6.11, six5.total);
    expect(a).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'HIGH', diffAmount: b.diffAmount, expectedAmount: b.expectedAmount });
    expect(b).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'HIGH' });
    expect(a.diffAmount).toBeCloseTo(six5.total - at(FEDEX, 6).total, 2);
  });

  it('yurt içi ondalıklı desi (5,08 → 6 desi fiyatı): ağırlık farkı', () => {
    const six = at(ARAS, 6, 'TR');
    const r = compareLine({ line: line({ trackingNo: 'B3A', billedKg: 5.08, netAmount: six.total, destCountry: 'TR' }), measurement: meas(10, 10, 10, 4.9), tariff: ARAS, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'HIGH', diffAmount: 9 });
  });

  it('taşıyıcı bizim basamağımızın fiyatını almışsa (6,05 kg yazıp 6,0 fiyatı) bugünkü gibi uyumlu, not yok', () => {
    const r = cmpF(6.05, at(FEDEX, 6).total);
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], confidence: 'HIGH', diffAmount: 0 });
    expect(r.note).toBeUndefined();
  });

  it('bağımsız inceleme: iki basamağın arasındaki fiyat basamak kanıtı değil, bugünkü gibi fiyat farkı (tutar şişmez)', () => {
    const six = at(FEDEX, 6);
    // bizim basamağımıza %10 zam (sabit yakıt): 6,00 kg yazılmış satırla aynı sonuç
    const over = Math.round(six.total * 1.1 * 100) / 100;
    const a = cmpF(6.05, over);
    expect(a).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH', pricingBasis: 'TARIFF' });
    expect(a.diffAmount).toBe(cmpF(6, over).diffAmount);
    // değişken yakıt, güncel %30 yakıt navluna katılmış: fiyat farkı ve "İncele" (FUEL_UNKNOWN), kesin ağırlık farkı değil
    const fuel30 = Math.round(six.freight * 1.3 * 100) / 100;
    const v = compareLine({ line: line({ trackingNo: 'B3V', billedKg: 6.05, netAmount: fuel30 }), measurement: m, tariff: { ...FEDEX, fuelVariable: true }, tol: TOL, isDuplicate: false });
    expect(v).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'FUEL_UNKNOWN', pricingBasis: 'TARIFF' });
    expect(v.diffAmount).toBeCloseTo(fuel30 - six.total, 2);
  });

  it('bağımsız inceleme: yalnız ek ücret farkında taşıyıcının fiyatı bizim kg\'ımızda okunur (6,05 ile 6,00 aynı)', () => {
    const ah = at(FEDEX, 6, 'FR', ['ADDITIONAL_HANDLING']);
    const sur = (billedKg: number) =>
      compareLine({
        line: line({ trackingNo: 'B3S', billedKg, netAmount: sumMoney([ah.total, 100]), surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'AH', amount: 385 }] }),
        measurement: m,
        tariff: FEDEX,
        tol: TOL,
        isDuplicate: false,
      });
    const a = sur(6.05);
    expect(a).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], confidence: 'HIGH', pricingBasis: 'TARIFF', expectedAmount: ah.total });
    expect(a.diffAmount).toBeCloseTo(100, 2);
    expect(a.diffAmount).toBe(sur(6).diffAmount);
  });

  it('basamak ölçüm payının içindeyse: beklenen taşıyıcının basamağında, "ölçüm toleransı içinde" notuyla uyumlu', () => {
    // 40×30×25 → 6,0 kg; her kenara 1 cm pay → 6,61 → 7,0 kg: 6,5 kg payın içinde
    const r = cmpF(6.05, six5.total, meas(40, 30, 25, 4));
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: six5.total, diffAmount: 0, confidence: 'HIGH' });
    expect(r.note).toContain('ölçüm toleransı içinde');
  });
});

describe('B10: aynı satırda fiyat ve ek ücret fazlası', () => {
  const ah = at(FEDEX, 6, 'FR', ['ADDITIONAL_HANDLING']);
  const m = meas(40, 30, 25, 6);
  const cmpS = (discountAmount: number, ahAmount: number) =>
    compareLine({
      line: line({
        trackingNo: 'B10',
        billedKg: 6,
        baseAmount: ah.base,
        discountAmount,
        fuelAmount: ah.fuel,
        netAmount: sumMoney([ah.base, -discountAmount, ah.fuel, ahAmount]),
        surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'AH', amount: ahAmount }],
      }),
      measurement: m,
      tariff: FEDEX,
      tol: TOL,
      isDuplicate: false,
    });

  it('navlun 100 TL + ek elleçleme 100 TL fazla: iki tür, notta iki kısım', () => {
    const r = cmpS(ah.discount - 100, 385);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE', 'PRICE'], confidence: 'HIGH', pricingBasis: 'TARIFF' });
    expect(r.diffAmount).toBeCloseTo(200, 1);
    expect(r.note).toContain('Tarifeden fazla ek ücret: ADDITIONAL_HANDLING +100,00 ₺');
    expect(r.note).toContain(t('tr', 'compare.priceExcess', { amount: '100,00 ₺' }));
    expect(localizeComparison(r, 'en').note).toContain(t('en', 'compare.priceExcess', { amount: '₺100.00' }));
  });

  it('yalnız ek ücret fazlası: tek tür kalır', () => {
    const r = cmpS(ah.discount, 385);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], confidence: 'HIGH' });
    expect(r.note).not.toContain(t('tr', 'compare.priceExcess', { amount: '' }).trim());
  });

  it('navlun farkı tolerans içinde: tek tür', () => {
    const r = cmpS(ah.discount - 4, 385);
    expect(r.diffTypes).toEqual(['SURCHARGE']);
  });
});

describe('B2: değişken yakıt, yakıt ayrı yazılmamış', () => {
  const VAR: TariffInput = { ...FEDEX, fuelVariable: true };
  const six = at(FEDEX, 6);
  const m = meas(40, 30, 25, 6);
  /** Taşıyıcı bu hafta %30 yakıtı navluna katmış; tarifede %25. */
  const inFreight = line({ trackingNo: 'B2', billedKg: 6, netAmount: Math.round(six.freight * 1.3 * 100) / 100 });
  const cmp = (l: ReturnType<typeof line>, tariff: TariffInput) => compareLine({ line: l, measurement: m, tariff, tol: TOL, isDuplicate: false });

  it('kural açık', () => {
    expect(VARIABLE_FUEL_WITHOUT_COLUMN_IS_REVIEW).toBe(true);
  });

  it('değişken yakıtta fiyat farkı "İncele" (FUEL_UNKNOWN), tutar aynı', () => {
    const r = cmp(inFreight, VAR);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'FUEL_UNKNOWN' });
    expect(r.diffAmount).toBe(cmp(inFreight, FEDEX).diffAmount);
    expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.fuelUnknown', { tariff: '%25' }));
    const en = localizeComparison(r, 'en').confidenceReason!;
    expect(en).toBe(t('en', 'compare.confidence.fuelUnknown', { tariff: '25%' }));
  });

  it('sabit yakıtta aynı satır kesin "Fiyat farkı" kalır', () => {
    expect(cmp(inFreight, FEDEX)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
  });

  it('uyumlu satır ve ağırlık farkı işaretlenmez; yakıt ayrı yazılmışsa faturadaki oran (bugünkü gibi)', () => {
    expect(cmp(line({ trackingNo: 'B2M', billedKg: 6, netAmount: six.total }), VAR)).toMatchObject({ status: 'MATCH', confidence: 'HIGH' });
    const w = cmp(line({ trackingNo: 'B2W', billedKg: 7.5, netAmount: at(FEDEX, 7.5).total }), VAR);
    expect(w).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'HIGH' });
    const fuel30 = Math.round(six.freight * 0.3 * 100) / 100;
    const split = line({ trackingNo: 'B2S', billedKg: 6, fuelAmount: fuel30, netAmount: sumMoney([six.freight, fuel30]) });
    expect(cmp(split, VAR)).toMatchObject({ status: 'MATCH', confidence: 'HIGH' });
  });
});
