/**
 * KALANLAR 1.8: yanlış itiraza karşı güvenlik ağı. Çok kolili gönderi kavramı yok (gerçek çözüm KALANLAR 5.2); şimdilik
 * şüpheli satır kesin fark ya da kesin mükerrer olmaz, "İncele" olur:
 * - takip no aynı dosyada birden çok ücret satırında (`repeatedInFile`): her fark türü, mükerrer dahil;
 * - eşleşen ölçüm birden çok kez ölçülmüş (`remeasured`): ağırlık/ölçü farkı (ölçüm kolilerden biri olabilir);
 * - önceki faturada aynı tutarlı ama açıklaması farklı görünüm (`duplicatePrior.sameDescription: false`).
 * Uyumlu satır işaretlenmez; tutarlar değişmez (yalnız güven).
 */
import { describe, expect, it } from 'vitest';
import { compareLine, expectedCharge, localizeComparison, type CompareLineInput } from '../src/index';
import { ARAS, TOL, line, meas } from './fixtures';

const at = (kg: number) => {
  const e = expectedCharge({ tariff: ARAS, chargeableKg: kg, destCountry: 'TR', surchargeCodes: [] });
  if (!e.ok) throw new Error('fixture');
  return e.total;
};

/** İki koli × 12 desi; fatura tek satırda 24 desi kesiyor, biz bir koliyi ölçtük (40×30×30 = 12 desi, 3 kg). */
const parcel = meas(40, 30, 30, 3);
const total24 = line({ trackingNo: 'MK1', destCountry: 'TR', billedKg: 24, netAmount: at(24) });
const cmp = (p: Partial<CompareLineInput> & { line?: CompareLineInput['line'] } = {}) =>
  compareLine({ line: total24, measurement: parcel, tariff: ARAS, tol: TOL, isDuplicate: false, ...p });

describe('çok koli: ölçüm birden çok kez yapıldı', () => {
  it('bayrak yoksa bugünkü gibi kesin ağırlık/ölçü farkı', () => {
    const r = cmp();
    expect(r.status).toBe('DIFF');
    expect(r.diffTypes[0]).toMatch(/WEIGHT|DIMENSION/);
    expect(r.confidence).toBe('HIGH');
    expect(r.ourChargeableKg).toBe(12);
    expect(r.billedChargeableKg).toBe(24);
  });

  it('ölçüm tekrarlıysa aynı fark "İncele" (MULTI_PARCEL); tutarlar aynı', () => {
    const firm = cmp();
    const r = cmp({ remeasured: true });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: firm.diffTypes, confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    expect(r.diffAmount).toBe(firm.diffAmount);
    expect(r.expectedAmount).toBe(firm.expectedAmount);
    expect(r.confidenceReason).toBe('Bu takip no birden çok kez ölçüldü (son ölçüm kullanıldı); gönderi çok koliliyse faturadaki ağırlık kolilerin toplamı olabilir');
    expect(localizeComparison(r, 'en').confidenceReason).toBe(
      'This tracking number was measured more than once (the latest measurement is used); if the shipment has several parcels, the invoiced weight may be their total',
    );
    expect(cmp({ remeasured: true, locale: 'en' }).confidenceReason).toBe(localizeComparison(r, 'en').confidenceReason);
  });

  it('ölçüm tekrarı yalnız ağırlık/ölçü farkını etkiler: yalnız fiyat farkı kesin kalır, uyumlu satır işaretlenmez', () => {
    // faturada 12 desi ama tarifeden 40 TL pahalı: fark ölçümden bağımsız
    const price = line({ trackingNo: 'MK2', destCountry: 'TR', billedKg: 12, netAmount: at(12) + 40 });
    const r = cmp({ line: price, remeasured: true });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
    const ok = line({ trackingNo: 'MK3', destCountry: 'TR', billedKg: 12, netAmount: at(12) });
    expect(cmp({ line: ok, remeasured: true })).toMatchObject({ status: 'MATCH', confidence: 'HIGH', confidenceReason: null });
  });

  it('daha temel gerekçelerin önündedir (aşırı ağırlık oranı yerine çok koli)', () => {
    // 5 kat ağırlık: tek başına EXTREME_WEIGHT olurdu
    const huge = line({ trackingNo: 'MK4', destCountry: 'TR', billedKg: 60, netAmount: at(60) });
    expect(cmp({ line: huge }).reviewCode).toBe('EXTREME_WEIGHT');
    expect(cmp({ line: huge, remeasured: true }).reviewCode).toBe('MULTI_PARCEL');
  });
});

describe('çok koli: takip no aynı dosyada birden çok satırda', () => {
  it('ilk satırın farkı da kesin değil (her fark türü)', () => {
    const r = cmp({ repeatedInFile: true });
    expect(r).toMatchObject({ status: 'DIFF', confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    expect(r.confidenceReason).toBe('Bu takip no aynı dosyada birden çok satırda; çok kolili gönderi ya da ayrı ücret satırı olabilir, fark kesin değil');
    const price = line({ trackingNo: 'MK2', destCountry: 'TR', billedKg: 12, netAmount: at(12) + 40 });
    expect(cmp({ line: price, repeatedInFile: true })).toMatchObject({ diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'MULTI_PARCEL' });
    const ok = line({ trackingNo: 'MK3', destCountry: 'TR', billedKg: 12, netAmount: at(12) });
    expect(cmp({ line: ok, repeatedInFile: true })).toMatchObject({ status: 'MATCH', confidence: 'HIGH' });
  });

  it('aynı dosyada aynı tutarlı ikinci satır mükerrer ama kesin değil (koli başına ayrı satır olabilir)', () => {
    const second = line({ trackingNo: 'MK1', destCountry: 'TR', rowIndex: 1, billedKg: 12, netAmount: at(12) });
    const r = cmp({
      line: second,
      isDuplicate: true,
      repeatedInFile: true,
      duplicatePrior: { sameCarrier: true, sameAmount: true, sameFile: true, amount: at(12), currency: 'TRY' },
    });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: at(12), confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(r.confidenceReason).toBe('Bu takip no aynı dosyada birden çok satırda; çok kolili gönderi ya da ayrı ücret satırı olabilir, satırları birlikte kontrol edin');
    expect(localizeComparison(r, 'en').confidenceReason).toBe(
      'This tracking number is on more than one line in the same file; it may be a multi-parcel shipment or a separate charge line, check the lines together',
    );
  });

  it('önceki faturanın kesin mükerreri de dosyada tekrar varsa kesin değil', () => {
    const r = cmp({ isDuplicate: true, repeatedInFile: true, duplicatePrior: { sameCarrier: true, sameAmount: true, invoiceNo: 'F-1', amount: at(24), currency: 'TRY' } });
    expect(r).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'LOW', reviewCode: 'DUPLICATE' });
  });

  it('farklı tutarlı ikinci satır bugünkü gerekçesini korur', () => {
    const r = cmp({ isDuplicate: true, repeatedInFile: true, duplicatePrior: { sameCarrier: true, sameAmount: false, sameFile: true, amount: 50, currency: 'TRY' } });
    expect(r.confidenceReason).toBe('Bu takip no aynı dosyada bir kez daha var, tutarı farklı (50,00 ₺); ek ücret satırı olabilir');
  });
});

describe('mükerrer: önceki faturada aynı tutar, farklı açıklama', () => {
  const prior = { sameCarrier: true, sameAmount: true, invoiceNo: 'F-7', amount: at(24), currency: 'TRY' };

  it('açıklama aynıysa (ya da bilinmiyorsa) kesin mükerrer kalır', () => {
    expect(cmp({ isDuplicate: true, duplicatePrior: prior })).toMatchObject({ diffTypes: ['DUPLICATE'], confidence: 'HIGH', confidenceReason: null });
    expect(cmp({ isDuplicate: true, duplicatePrior: { ...prior, sameDescription: true } })).toMatchObject({ confidence: 'HIGH' });
  });

  it('açıklama farklıysa "İncele": başka bir ücret olabilir (göndericiye iade)', () => {
    const r = cmp({ isDuplicate: true, duplicatePrior: { ...prior, sameDescription: false } });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: at(24), confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(r.confidenceReason).toBe('Bu takip no F-7 numaralı faturada aynı tutarla var ama açıklaması (hizmet ya da ek ücret) farklı; başka bir ücret olabilir');
    expect(localizeComparison(r, 'en').confidenceReason).toBe(
      'This tracking number is on invoice F-7 with the same amount but a different description (service or surcharge); it may be a different charge',
    );
  });
});
