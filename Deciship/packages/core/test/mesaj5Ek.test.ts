/**
 * Mesaj 5 ek turu E1 (Mesaj 3 ilkesi: emin olunmayan fark "kesin" gösterilmez).
 * - Y1: değişken yakıtlı tarifede faturadaki yakıt oranı makul değilse (%60 üstü) satır tarifedeki orana düşer; fark
 *   çıkarsa kesin değil "İncele" (`FUEL_RATE`).
 * - Y6: İngilizce gösterimde kimlik niteliğindeki parametreler (fatura no, takip no, ham hücre, ad) sayı gibi çevrilmez.
 */
import { describe, expect, it } from 'vitest';
import { compareLine, expectedCharge, fmtMoney, localizeComparison, localizeText, sumMoney, t, type TariffInput } from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

const cmp = (l: ReturnType<typeof line>, tariff: TariffInput, extra: Partial<Parameters<typeof compareLine>[0]> = {}) =>
  compareLine({ line: l, measurement: meas(10, 10, 10, 6), tariff, tol: TOL, isDuplicate: false, ...extra });

describe('Y1: olağandışı yakıt oranı "İncele" olur', () => {
  const VAR: TariffInput = { ...FEDEX, fuelVariable: true };
  const atSix = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR' });
  if (!atSix.ok) throw new Error('fixture');
  /** Taşıyıcı sözleşme taşıma fiyatını uygulamış; yakıt sütununda taşımanın %70'i yazıyor (yanlış eşlenmiş sütun olabilir). */
  const fuel70 = Math.round(atSix.freight * 0.7 * 100) / 100;
  const odd = line({ trackingNo: 'Y1A', billedKg: 6, baseAmount: atSix.base, discountAmount: atSix.discount, fuelAmount: fuel70, netAmount: sumMoney([atSix.freight, fuel70]) });

  it('değişken tarife: fark tarifedeki oranla hesaplanır ama kesin değildir (LOW, FUEL_RATE)', () => {
    const r = cmp(odd, VAR);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], expectedAmount: atSix.total, confidence: 'LOW', reviewCode: 'FUEL_RATE' });
    expect(r.diffAmount).toBeCloseTo(fuel70 - atSix.fuel, 2);
    expect(r.confidenceReason).toBe(t('tr', 'compare.confidence.fuelRate', { amount: fmtMoney(fuel70, 'TRY'), max: '%60', tariff: '%25' }));
    expect(r.confidenceReason).toContain('yakıt sütunu yanlış eşlenmiş ya da yakıt indirimsiz liste fiyatından hesaplanmış olabilir');
    const en = localizeComparison(r, 'en').confidenceReason!;
    expect(en).toContain('more than 60% of the freight');
    expect(en).toContain('(25%)');
    expect(en).not.toMatch(/[ığşçöü]/);
  });

  it('İngilizce sonuç da aynı kodu ve çevrilmiş gerekçeyi taşır', () => {
    const r = cmp(odd, VAR, { locale: 'en' });
    expect(r).toMatchObject({ confidence: 'LOW', reviewCode: 'FUEL_RATE' });
    expect(r.confidenceReason).toContain('fuel column may be mapped wrongly');
  });

  it('taşıma bedeli yakıttan ayrılamıyorsa (net − yakıt ≤ 0) da "İncele"', () => {
    const swallowed = line({ trackingNo: 'Y1B', billedKg: 6, baseAmount: atSix.base, discountAmount: atSix.discount, fuelAmount: atSix.total + 50, netAmount: atSix.total + 50 });
    const r = cmp(swallowed, VAR);
    expect(r).toMatchObject({ status: 'DIFF', confidence: 'LOW', reviewCode: 'FUEL_RATE' });
  });

  it('sözleşmede sabit yakıt: kural değişmez, yüksek oran kesin fiyat farkıdır', () => {
    const r = cmp(odd, { ...FEDEX, fuelVariable: false });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH', confidenceReason: null });
    expect(r.reviewCode).toBeUndefined();
  });

  it('makul oran (%27,5) faturadan kabul edilir; satır kesin uyumlu', () => {
    const fuel = Math.round(atSix.freight * 0.275 * 100) / 100;
    const ok = line({ trackingNo: 'Y1C', billedKg: 6, baseAmount: atSix.base, discountAmount: atSix.discount, fuelAmount: fuel, netAmount: sumMoney([atSix.freight, fuel]) });
    expect(cmp(ok, VAR)).toMatchObject({ status: 'MATCH', confidence: 'HIGH', diffAmount: 0 });
  });

  it('oran olağandışı ama satır tarifedeki oranla zaten uyumlu: fark yok, "İncele" de yok', () => {
    // net tarifenin toplamı; yakıt sütunu tutarsız (taşımanın çok üstünde)
    const matching = line({ trackingNo: 'Y1D', billedKg: 6, baseAmount: atSix.base, discountAmount: atSix.discount, fuelAmount: Math.round(atSix.total * 0.7 * 100) / 100, netAmount: atSix.total });
    const r = cmp(matching, VAR);
    expect(r).toMatchObject({ status: 'MATCH', confidence: 'HIGH', diffAmount: 0 });
    expect(r.reviewCode).toBeUndefined();
  });

  it('öncelik: daha temel gerekçe (eşleşme yanlış olabilir) yakıt gerekçesini ezer; FUEL_RATE en sonda', () => {
    // ölçüm 6 kg, fatura 30 kg (oran 5 > 4), taşıyıcı 30 kg'ın sözleşme fiyatını uygulamış, yakıt taşımanın %70'i
    const at30 = expectedCharge({ tariff: FEDEX, chargeableKg: 30, destCountry: 'FR' });
    if (!at30.ok) throw new Error('fixture');
    const fuel = Math.round(at30.freight * 0.7 * 100) / 100;
    const heavy = line({ trackingNo: 'Y1F', billedKg: 30, baseAmount: at30.base, discountAmount: at30.discount, fuelAmount: fuel, netAmount: sumMoney([at30.freight, fuel]) });
    const r = cmp(heavy, VAR);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], confidence: 'LOW', reviewCode: 'EXTREME_WEIGHT', confidenceReason: t('tr', 'compare.confidence.extremeWeight') });
  });

  it('kapsam: yakıttan bağımsız kesin ek ücret farkı İncele olmaz (yalnız PRICE/WEIGHT/DIMENSION)', () => {
    // "Ek elleçleme" faturada 600, tarifede 285; yakıt sütunu olağandışı (taşımanın %60'ından fazla), başka fark yok
    const e = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR', surchargeCodes: ['ADDITIONAL_HANDLING'] });
    if (!e.ok) throw new Error('fixture');
    const fuel = 600;
    const net = sumMoney([atSix.freight, atSix.fuel, 600]);
    const handling = line({
      trackingNo: 'Y1G',
      billedKg: 6,
      baseAmount: atSix.base,
      discountAmount: atSix.discount,
      fuelAmount: fuel,
      surcharges: [{ code: 'ADDITIONAL_HANDLING', name: 'Ek elleçleme', amount: 600 }],
      netAmount: net,
    });
    const r = cmp(handling, VAR);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], confidence: 'HIGH', confidenceReason: null, expectedAmount: e.total });
    expect(r.diffAmount).toBeCloseTo(315, 2);
    expect(r.reviewCode).toBeUndefined();
  });

  it('yakıt yazmayan satırda kural uygulanmaz (bugünkü hesap)', () => {
    const combined = line({ trackingNo: 'Y1E', billedKg: 6, netAmount: odd.netAmount });
    const r = cmp(combined, VAR);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
    expect(r.reviewCode).not.toBe('FUEL_RATE');
  });
});

describe('Y6: kimlik niteliğindeki parametreler İngilizcede olduğu gibi kalır', () => {
  it('mükerrer gerekçesindeki fatura no sayı gibi çevrilmez, tutar çevrilir', () => {
    const carrier = t('tr', 'compare.confidence.duplicateCarrier', { invoice: '123.456' });
    expect(localizeText(carrier, 'en')).toBe(t('en', 'compare.confidence.duplicateCarrier', { invoice: '123.456' }));
    const amount = t('tr', 'compare.confidence.duplicateAmount', { invoice: '2026,15', amount: '1.234,50 ₺' });
    expect(localizeText(amount, 'en')).toBe(t('en', 'compare.confidence.duplicateAmount', { invoice: '2026,15', amount: '₺1,234.50' }));
  });

  it('karşılaştırmanın kendisi (locale: en) de fatura no\'yu korur', () => {
    const l = line({ trackingNo: 'D1', billedKg: 6, netAmount: 1000 });
    const r = compareLine({
      line: l,
      measurement: meas(10, 10, 10, 6),
      tariff: FEDEX,
      tol: TOL,
      isDuplicate: true,
      duplicatePrior: { sameCarrier: true, sameAmount: false, invoiceNo: '1.234.567', amount: 1234.5, currency: 'TRY' },
      locale: 'en',
    });
    expect(r.confidenceReason).toBe('This tracking number is also on invoice 1.234.567 with a different amount (₺1,234.50); it may be a supplementary invoice');
  });

  it('okuma hatasındaki ham hücre değeri, tarife adı ve sütun başlığı olduğu gibi kalır', () => {
    expect(localizeText(t('tr', 'parse.badTracking', { row: 3, value: '1.234,5' }), 'en')).toBe(t('en', 'parse.badTracking', { row: 3, value: '1.234,5' }));
    expect(localizeText(t('tr', 'parse.badNet', { row: 4, value: '12,5x' }), 'en')).toBe(t('en', 'parse.badNet', { row: 4, value: '12,5x' }));
    const notValid = t('tr', 'stored.tariffNotValid', { name: 'FedEx 2026.1', date: '2026-10-01', from: '2026-01-01', to: '2026-06-30' });
    expect(localizeText(notValid, 'en')).toBe(t('en', 'stored.tariffNotValid', { name: 'FedEx 2026.1', date: '2026-10-01', from: '2026-01-01', to: '2026-06-30' }));
    expect(localizeText(t('tr', 'stored.pdf.priceColumn', { header: 'Fiyat 1,5 kg' }), 'en')).toBe(t('en', 'stored.pdf.priceColumn', { header: 'Fiyat 1,5 kg' }));
  });

  it('sayı ve yüzde taşıyan parametreler yine çevrilir', () => {
    expect(localizeText(t('tr', 'compare.invoiceBasis', { pct: '−%14,7' }), 'en')).toBe(t('en', 'compare.invoiceBasis', { pct: '−14.7%' }));
    expect(localizeText(t('tr', 'compare.noPriceAtKg', { kg: '6,5 kg' }), 'en')).toBe(t('en', 'compare.noPriceAtKg', { kg: '6.5 kg' }));
  });
});
