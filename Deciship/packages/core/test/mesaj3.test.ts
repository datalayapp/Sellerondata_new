/**
 * Yol haritası Mesaj 3 (KARARLAR "Emin olunmayan fark kesin gösterilmez", 2026-11-10): yakıt seçimi, karışık hizmet,
 * mükerrer koşulu, parasız fark, bileşen KDV kararının görünürlüğü. Ölçüm sınırı testi `edgeCases.test.ts` içinde.
 */
import { describe, expect, it } from 'vitest';
import {
  compareLine,
  expectedCharge,
  localizeComparison,
  parseRows,
  pctOf,
  serviceClassWords,
  serviceMismatch,
  sumMoney,
  tariffHealth,
  type ColumnMapping,
  type TariffInput,
} from '../src/index';
import { FEDEX, TOL, line, meas } from './fixtures';

const cmp = (l: ReturnType<typeof line>, tariff: TariffInput, extra: Partial<Parameters<typeof compareLine>[0]> = {}) =>
  compareLine({ line: l, measurement: meas(10, 10, 10, 6), tariff, tol: TOL, isDuplicate: false, ...extra });

describe('yakıt: tarifede "değişken" / "sözleşmede sabit"', () => {
  const atSix = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR' });
  if (!atSix.ok) throw new Error('fixture');
  const fuel275 = pctOf(atSix.freight, 27.5);
  /** Taşıyıcı sözleşme fiyatını uygulamış, yalnız yakıtı %25 yerine %27,5 almış. */
  const invoiced = line({
    trackingNo: 'F1',
    billedKg: 6,
    baseAmount: atSix.base,
    discountAmount: atSix.discount,
    fuelAmount: fuel275,
    netAmount: sumMoney([atSix.freight, fuel275]),
  });

  it('sabit (varsayılan): yüksek yakıt oranı kesin fiyat farkıdır', () => {
    const r = cmp(invoiced, FEDEX);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH', expectedAmount: atSix.total });
    expect(r.diffAmount).toBeCloseTo(fuel275 - atSix.fuel, 2);
    expect(r.diffAmount).toBeGreaterThan(TOL.amountTol);
    expect(cmp(invoiced, { ...FEDEX, fuelVariable: false })).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
  });

  it('değişken: faturadaki oran kabul edilir, satır uyumlu; dökümde oran ve tarifedeki oran yazar', () => {
    const r = cmp(invoiced, { ...FEDEX, fuelVariable: true });
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], diffAmount: 0, expectedAmount: invoiced.netAmount });
    expect(r.breakdown.map((b) => b.label)).toContain('Yakıt %27,5 (faturadaki oran; tarifede %25)');
    expect(localizeComparison(r, 'en').breakdown.map((b) => b.label)).toContain('Fuel 27.5% (invoice rate; tariff has 25%)');
  });

  it('değişken ama fatura yakıtı ayrı yazmıyor: tarifedeki oranla beklenir (bugünkü hesap)', () => {
    const combined = line({ trackingNo: 'F2', billedKg: 6, netAmount: invoiced.netAmount });
    const r = cmp(combined, { ...FEDEX, fuelVariable: true });
    expect(r.expectedAmount).toBe(atSix.total);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
  });

  it('değişken: yakıt dışındaki fiyat farkı yine görünür', () => {
    const pricier = { ...invoiced, baseAmount: atSix.base + 100, netAmount: sumMoney([invoiced.netAmount, 100]) };
    const r = cmp(pricier, { ...FEDEX, fuelVariable: true });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'] });
    expect(r.diffAmount!).toBeGreaterThan(90);
  });

  it('fatura başı notu: değişkende "kabul edildi", sabitte itiraz yolu', () => {
    const lines = Array.from({ length: 3 }, () => ({ destCountry: 'FR', service: null, zone: 'A', rateDeviationPct: 0, fx: false, fuelPct: 27.5 }));
    expect(tariffHealth(lines, { tariffFuelPct: 25, tariffFuelVariable: true }).fuelNote).toBe(
      'Bu faturada yakıt oranı %27,5; tarifenizde %25. Tarifede yakıt "değişken" seçili olduğu için faturadaki oran kabul edildi.',
    );
    expect(tariffHealth(lines, { tariffFuelPct: 25 }).fuelNote).toContain('itiraz edilebilir');
  });
});

describe('karışık hizmet', () => {
  it('hizmet sınıfı sözcükleri', () => {
    expect(serviceClassWords('FedEx Intl Priority Express')).toEqual(['express', 'priority']);
    expect(serviceClassWords('Uluslararası Ekonomi')).toEqual(['economy']);
    expect(serviceClassWords('Yurt içi kargo')).toEqual([]);
  });

  it('yalnız iki ad da sınıf taşıyorsa ve sınıflar farklıysa "farklı hizmet"', () => {
    expect(serviceMismatch('FedEx Intl Priority', 'International Economy')).toBe(true);
    expect(serviceMismatch('Express Saver', 'Economy Select')).toBe(true);
    expect(serviceMismatch('UPS Saver', 'UPS Express Plus')).toBe(true);
    // bağımsız inceleme (2026-11-10): aynı hizmetin farklı yazımları farklı sayılmaz
    expect(serviceMismatch('UPS Express Saver', 'UPS Saver')).toBe(false);
    expect(serviceMismatch('DHL Economy Select', 'DHL Economy')).toBe(false);
    expect(serviceMismatch('International Priority', 'FedEx Express International Priority')).toBe(false);
    expect(serviceMismatch('Economy', 'TNT Express Economy')).toBe(false);
    expect(serviceMismatch('Intl Exp Saver', 'Express Saver')).toBe(false);
    // niteleyici bir tarafta yoksa hüküm verilmez (yanlış alarm, kaçan uyarıdan pahalı)
    expect(serviceMismatch('UPS Express Saver', 'Express')).toBe(false);
    expect(serviceMismatch('FEDEX INTERNATIONAL ECONOMY', 'Intl Economy 2026')).toBe(false);
    expect(serviceMismatch('DHL Express Worldwide', 'Ekspres')).toBe(false);
    // hüküm verilemeyenler farklı sayılmaz
    expect(serviceMismatch('Standart', null)).toBe(false);
    expect(serviceMismatch(undefined, 'Economy')).toBe(false);
    expect(serviceMismatch('Kargo', 'Economy')).toBe(false);
  });

  const economy: TariffInput = { ...FEDEX, service: 'International Economy' };
  const atSix = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR' });
  if (!atSix.ok) throw new Error('fixture');
  /** Priority gönderisi Economy tarifesinden %10 pahalı faturalanmış. */
  const priority = line({ trackingNo: 'S1', billedKg: 6, service: 'FedEx Intl Priority', netAmount: Math.round(atSix.total * 1.1 * 100) / 100 });

  it('hizmet farklıysa fiyat farkı kesin değil: "İncele", gerekçede iki hizmet adı', () => {
    const r = cmp(priority, economy);
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'LOW', reviewCode: 'SERVICE' });
    expect(r.confidenceReason).toBe('Bu satırın hizmeti (FedEx Intl Priority) tarifenizdeki hizmetten (International Economy) farklı; bu hizmet için tarife ekleyin');
    expect(localizeComparison(r, 'en').confidenceReason).toBe(
      'The service on this line (FedEx Intl Priority) differs from the service in your tariff (International Economy); add a tariff for this service',
    );
  });

  it('hizmet aynıysa ya da tarifede hizmet yazmıyorsa bugünkü gibi kesin', () => {
    expect(cmp({ ...priority, service: 'FedEx International Economy' }, economy)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
    expect(cmp(priority, FEDEX)).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], confidence: 'HIGH' });
    expect(cmp(priority, FEDEX).reviewCode).toBeUndefined();
  });

  it('tarife uyumu: farklı hizmet grubunda "itiraz edebilirsiniz" yerine "tarife ekleyin", istisna önerilmez', () => {
    const lines = Array.from({ length: 4 }, () => ({ destCountry: 'FR', service: 'FedEx Intl Priority', zone: 'A', rateDeviationPct: 10, fx: false }));
    const g = tariffHealth(lines, { tariffService: 'International Economy' }).groups[0]!;
    expect(g).toMatchObject({ status: 'pricier', serviceMismatch: true, suggestedAdjustmentPct: null });
    expect(g.message).toBe(
      'Fransa (4 satır): bu satırların hizmeti (FedEx Intl Priority) tarifenizdeki hizmetten (International Economy) farklı; fiyat farkı bundan olabilir. Bu hizmet için tarife ekleyin.',
    );
    const same = tariffHealth(lines, { tariffService: 'Intl Priority' }).groups[0]!;
    expect(same.serviceMismatch).toBe(false);
    expect(same.message).toContain('itiraz edebilirsiniz');
    expect(same.suggestedAdjustmentPct).not.toBeNull();
  });
});

describe('mükerrer: aynı taşıyıcı + aynı tutar kesin, değilse "İncele"', () => {
  const l = line({ trackingNo: 'D1', netAmount: 1120, billedKg: 6 });
  const dup = (prior?: Parameters<typeof compareLine>[0]['duplicatePrior']) => cmp(l, FEDEX, { isDuplicate: true, duplicatePrior: prior });

  it('önceki görünüm bilgisi yoksa ya da aynı taşıyıcı + aynı tutarsa kesin', () => {
    expect(dup()).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 1120, confidence: 'HIGH', confidenceReason: null });
    expect(dup({ sameCarrier: true, sameAmount: true, invoiceNo: 'F-1', amount: 1120 })).toMatchObject({ confidence: 'HIGH', confidenceReason: null });
  });

  it('tutar farklıysa "İncele": ek fatura olabilir; önceki fatura no ve tutarı yazar', () => {
    const r = dup({ sameCarrier: true, sameAmount: false, invoiceNo: '9-482-11735', amount: 1642.5, currency: 'TRY' });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], diffAmount: 1120, confidence: 'LOW', reviewCode: 'DUPLICATE' });
    expect(r.confidenceReason).toBe('Bu takip no 9-482-11735 numaralı faturada da var, tutarı farklı (1.642,50 ₺); ek fatura olabilir');
    expect(localizeComparison(r, 'en').confidenceReason).toBe(
      'This tracking number is also on invoice 9-482-11735 with a different amount (₺1,642.50); it may be a supplementary invoice',
    );
  });

  it('aynı dosyada farklı tutarla ikinci satır: ek ücret satırı olabilir', () => {
    const r = dup({ sameCarrier: true, sameAmount: false, sameFile: true, amount: 300, currency: 'TRY' });
    expect(r.confidence).toBe('LOW');
    expect(r.confidenceReason).toBe('Bu takip no aynı dosyada bir kez daha var, tutarı farklı (300,00 ₺); ek ücret satırı olabilir');
  });

  it('başka taşıyıcının faturasındaysa "İncele" (tutar aynı olsa da)', () => {
    const r = dup({ sameCarrier: false, sameAmount: true, invoiceNo: 'UPS-77' });
    expect(r.confidence).toBe('LOW');
    expect(r.confidenceReason).toBe('Bu takip no başka bir taşıyıcının faturasında da var (UPS-77); aynı gönderi olmayabilir');
  });
});

describe('parasız fark', () => {
  /** 5 kg'a kadar tek fiyat: ağırlık farkı tutarı değiştirmez. */
  const flat: TariffInput = {
    id: 'flat',
    currency: 'TRY',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 1 }],
    discountPct: 0,
    fuelPct: 0,
    zones: { '*': 'A' },
    rates: [
      { zone: 'A', weightUpto: 5, price: 100 },
      { zone: 'A', weightUpto: 10, price: 180 },
    ],
    surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme', kind: 'FIXED', amount: 10 }],
  };
  const three = meas(10, 10, 10, 3);
  const run = (l: ReturnType<typeof line>) => compareLine({ line: l, measurement: three, tariff: flat, tol: TOL, isDuplicate: false });

  it('taşıyıcı daha yüksek ağırlık yazmış ama fiyat aynı: uyumlu, notla', () => {
    const r = run(line({ trackingNo: 'P1', netAmount: 100, billedKg: 5 }));
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], ourChargeableKg: 3, billedChargeableKg: 5, diffAmount: 0, note: 'Ağırlık farklı yazılmış, tutara etkisi yok' });
    expect(localizeComparison(r, 'en').note).toBe('Weight is stated differently; no effect on the amount');
  });

  it('ağırlık farkı parayı değiştiriyorsa kesin fark kalır', () => {
    expect(run(line({ trackingNo: 'P2', netAmount: 180, billedKg: 6 }))).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], diffAmount: 80, confidence: 'HIGH' });
  });

  it('ağırlık farkıyla birlikte ek ücret fazlası varsa satır fark olarak kalır', () => {
    const r = run(line({ trackingNo: 'P3', netAmount: 130, billedKg: 5, surcharges: [{ code: 'KAPIDA_ODEME', name: 'Kapıda ödeme', amount: 30 }] }));
    expect(r.status).toBe('DIFF');
    expect(r.diffTypes).toContain('SURCHARGE');
    expect(r.diffAmount).toBe(20);
  });
});

describe('bileşen KDV kararı görünür', () => {
  const table = { headers: ['Takip', 'Tutar', 'Ek'], rows: [['123456789012', '120', '24']] };
  const mapping = (extra: Partial<ColumnMapping> = {}): ColumnMapping =>
    ({ trackingNo: 'Takip', netAmount: 'Tutar', surchargeColumns: [{ header: 'Ek', code: 'ADRES' }], chargePairs: [], amountsIncludeVat: true, vatPct: 20, desiAsWeight: false, ...extra }) as ColumnMapping;

  it('kanıt yoksa "varsayıldı" diye bildirilir (KDV hariç); toplam yine KDV’den arındırılır', () => {
    const r = parseRows(table, mapping());
    expect(r.componentsVat).toEqual({ value: false, source: 'default', hasComponents: true });
    expect(r.lines[0]).toMatchObject({ netAmount: 100, surcharges: [{ amount: 24 }] });
  });

  it('kullanıcı seçerse o uygulanır ve dayanak "mapping" olur', () => {
    const r = parseRows(table, mapping({ componentsIncludeVat: true }));
    expect(r.componentsVat).toEqual({ value: true, source: 'mapping', hasComponents: true });
    expect(r.lines[0]).toMatchObject({ netAmount: 100, surcharges: [{ amount: 20 }] });
  });

  it('toplam KDV dahil değilse karar gerekmez', () => {
    expect(parseRows(table, mapping({ amountsIncludeVat: false })).componentsVat).toMatchObject({ source: 'none', value: false });
  });
});

describe('bağımsız inceleme düzeltmeleri (2026-11-10)', () => {
  it('değişken yakıt: navlun sütunu liste fiyatı, indirim sütunu yok; sözleşme fiyatını uygulayan satır uyumlu', () => {
    const tariff: TariffInput = { ...FEDEX, discountPct: 10, fuelVariable: true };
    const e = expectedCharge({ tariff, chargeableKg: 6, destCountry: 'FR' });
    if (!e.ok) throw new Error('fixture');
    // faturada yalnız liste fiyatı ve yakıt sütunu var; net = (liste − %10) + %25 yakıt
    const l = line({ trackingNo: 'R1', billedKg: 6, baseAmount: e.base, fuelAmount: e.fuel, netAmount: e.total });
    expect(cmp(l, tariff)).toMatchObject({ status: 'MATCH', diffAmount: 0, expectedAmount: e.total });
    // aynı satır "sabit" tarifede de uyumlu
    expect(cmp(l, { ...tariff, fuelVariable: false })).toMatchObject({ status: 'MATCH', diffAmount: 0 });
  });

  it('parasız fark kur toleransını kullanmaz: dövizli satırda tutarı etkileyen ağırlık fazlası fark olarak kalır', () => {
    const usd: TariffInput = {
      id: 'usd',
      currency: 'USD',
      divisor: 5000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [{ upto: null, step: 1 }],
      discountPct: 0,
      fuelPct: 0,
      zones: { '*': 'A' },
      rates: [{ zone: 'A', weightUpto: 200, price: 3.8, perKg: true }],
      surcharges: [],
    };
    // 100 kg ölçüm → 380 USD × 40 = 15.200 TL; fatura 101 kg → 15.352 TL (fark 152 TL, beklenenin %1'i)
    const r = compareLine({
      line: line({ trackingNo: 'R2', billedKg: 101, netAmount: 15352, currency: 'TRY' }),
      measurement: meas(10, 10, 10, 100),
      tariff: usd,
      tol: TOL,
      isDuplicate: false,
      fx: { date: '2026-10-15', rate: { base: 'USD', quote: 'TRY', rate: 40, date: '2026-10-15', source: 'TCMB' } as never },
    });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], expectedAmount: 15200, diffAmount: 152 });
    expect(r.note ?? '').not.toContain('tutara etkisi yok');
  });

  it('ölçüm payı sınırı basamaklı ağırlıkla: 6,1 kg faturalanıp 6,5 kg fiyatı alınmışsa pay (6,0) aşılmıştır', () => {
    // ölçüm 30×30×30 = 5,4 → 5,5 kg; paylı 31³ = 5,96 → 6,0 kg
    const m = meas(30, 30, 30, 2);
    const at = (kg: number) => expectedCharge({ tariff: FEDEX, chargeableKg: kg, destCountry: 'FR' });
    const e55 = at(5.5);
    const e60 = at(6);
    const e65 = at(6.5);
    if (!e55.ok || !e60.ok || !e65.ok) throw new Error('fixture');
    const over = compareLine({ line: line({ trackingNo: 'R3', billedKg: 6.1, netAmount: e65.total }), measurement: m, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(over).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], ourChargeableKg: 5.5, expectedAmount: e55.total });
    expect(over.note ?? '').not.toContain('ölçüm toleransı');
    // tam sınırda (6,0 kg) pay içinde: taşıyıcının ağırlığı kabul edilir
    const within = compareLine({ line: line({ trackingNo: 'R4', billedKg: 6, netAmount: e60.total }), measurement: m, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(within).toMatchObject({ status: 'MATCH', expectedAmount: e60.total, diffAmount: 0 });
  });

  it('hizmeti farklı satır uyumlu çıksa da uyarı notta görünür', () => {
    const economy: TariffInput = { ...FEDEX, service: 'International Economy' };
    const e = expectedCharge({ tariff: FEDEX, chargeableKg: 6, destCountry: 'FR' });
    if (!e.ok) throw new Error('fixture');
    const r = cmp(line({ trackingNo: 'R5', billedKg: 6, service: 'FedEx Intl Priority', netAmount: e.total }), economy);
    expect(r).toMatchObject({ status: 'MATCH', confidence: 'LOW', reviewCode: 'SERVICE' });
    expect(r.note).toContain('bu hizmet için tarife ekleyin');
  });
});
