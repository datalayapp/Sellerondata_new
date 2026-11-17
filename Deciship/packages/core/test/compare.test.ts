import { describe, expect, it } from 'vitest';
import { PAK_NOTE, billedChargeableKg, compareLine, edgesExceed, isPakService } from '../src/index';
import { ARAS, FEDEX, TOL, line, meas } from './fixtures';

const run = (l: ReturnType<typeof line>, m: ReturnType<typeof meas> | null = meas(40, 30, 25, 4),opts: { isDuplicate?: boolean; tariff?: typeof FEDEX | null } = {}) =>
  compareLine({ line: l, measurement: m, tariff: opts.tariff === undefined ? FEDEX : opts.tariff, tol: TOL, isDuplicate: opts.isDuplicate ?? false });

describe('wiki örnekleri', () => {
  it('#5305 ölçü farkı: 6,0 → 9,5 kg, beklenen 1.184,00, fark +458,50', () => {
    const r = run(line({ trackingNo: '794812345305', netAmount: 1642.5, actualKg: 4, billedKg: 9.5, dims: { l: 45, w: 35, h: 30 } }));
    expect(r).toMatchObject({
      status: 'DIFF',
      diffTypes: ['DIMENSION'],
      ourChargeableKg: 6,
      billedChargeableKg: 9.5,
      expectedAmount: 1184,
      billedAmount: 1642.5,
      diffAmount: 458.5,
    });
    expect(r.breakdown.map((b) => b.amount)).toEqual([1527.75, -580.55, 236.8]);
  });

  it('#5305 faturada ücretli ağırlık yoksa ölçü + gerçek ağırlıktan hesaplanır', () => {
    const r = run(line({ trackingNo: '794812345305', netAmount: 1642.5, actualKg: 4, dims: { l: 45, w: 35, h: 30 } }));
    expect(r.billedChargeableKg).toBe(9.5);
    expect(r.diffTypes).toEqual(['DIMENSION']);
  });

  it('#5299 ağırlık farkı: 4,8 → 5,5 kg, +96,40', () => {
    const r = run(line({ trackingNo: '794812345299', netAmount: 1120, actualKg: 5.5, billedKg: 5.5, dims: { l: 30, w: 25, h: 20 } }), meas(30, 25, 20, 4.8));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['WEIGHT'], ourChargeableKg: 5, billedChargeableKg: 5.5, expectedAmount: 1023.6, diffAmount: 96.4 });
  });

  it("#5293 tarifede olmayan ek ücret (adres düzeltme) 412,00 → varsayılan: Beklenen'e faturadaki tutarıyla girer, satır uyumlu", () => {
    const r = run(
      line({ trackingNo: '794812345293', netAmount: 1377.84, billedKg: 4.5, surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 }] }),
      meas(35, 25, 20, 4.3),
    );
    // Beklenen = tarifeye göre 965,84 + faturadaki 412,00 → Faturalanan ile aynı kalemler, fark yalnız tarifeden
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 1377.84, billedAmount: 1377.84, diffAmount: 0, uncheckedSurchargeTotal: 412 });
    expect(r.diffAmount).toBe(r.billedAmount - r.expectedAmount!);
    expect(r.note).toBe("Tarifede olmayan ek ücretler faturadaki tutarıyla Beklenen'e eklendi: Address Correction 412,00 ₺");
    expect(r.breakdown.at(-1)).toEqual({ label: 'Address Correction', amount: 412, currency: 'TRY', unchecked: true });
  });

  it('#5293 "Tarifede olmayan ek ücretleri fark say" açıkken SURCHARGE', () => {
    const r = compareLine({
      line: line({ trackingNo: '794812345293', netAmount: 1377.84, billedKg: 4.5, surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Address Correction', amount: 412 }] }),
      measurement: meas(35, 25, 20, 4.3),
      tariff: FEDEX,
      tol: { ...TOL, unknownSurchargesAsDiff: true },
      isDuplicate: false,
    });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], expectedAmount: 965.84, diffAmount: 412, uncheckedSurchargeTotal: 0 });
    expect(r.note).toContain('Tarifede olmayan ek ücret');
    expect(r.note).toContain('412,00 ₺');
    expect(r.breakdown.some((b) => b.unchecked)).toBe(false);
  });

  it('#5290 fiyat farkı (yakıt %27,5 yerine %25) +56,30', () => {
    const r = run(line({ trackingNo: '794812345290', netAmount: 2871.3, billedKg: 15 }), meas(50, 40, 30, 14.6));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], ourChargeableKg: 15, expectedAmount: 2815, diffAmount: 56.3 });
  });

  it('#5288 mükerrer: tutarın tamamı fark, beklenen null', () => {
    const r = run(line({ trackingNo: '794812345288', netAmount: 1120, billedKg: 5.5 }), meas(30, 25, 20, 5.4), { isDuplicate: true });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DUPLICATE'], expectedAmount: null, diffAmount: 1120, billedAmount: 1120 });
  });
});

describe('kural sırası', () => {
  it('mükerrer, ölçüm yokken de mükerrerdir', () => {
    const r = compareLine({ line: line({ trackingNo: 'X1234567890', netAmount: 50 }), measurement: null, tariff: null, tol: TOL, isDuplicate: true });
    expect(r.status).toBe('DIFF');
    expect(r.diffTypes).toEqual(['DUPLICATE']);
    expect(r.diffAmount).toBe(50);
  });

  it('ölçüm yok → UNMATCHED, beklenen ve fark null', () => {
    const r = compareLine({ line: line({ trackingNo: '774012346105', netAmount: 677.04, billedKg: 2 }), measurement: null, tariff: FEDEX, tol: TOL, isDuplicate: false });
    expect(r).toMatchObject({ status: 'UNMATCHED', diffTypes: [], expectedAmount: null, diffAmount: null, billedChargeableKg: 2, ourChargeableKg: null });
  });

  it('tarife yok → NO_TARIFF + not', () => {
    const r = run(line({ trackingNo: '1', netAmount: 100 }), meas(40, 30, 25, 4), { tariff: null });
    expect(r.status).toBe('NO_TARIFF');
    expect(r.note).toBe('Taşıyıcının geçerli tarifesi yok');
    expect(r.expectedAmount).toBeNull();
    expect(r.diffAmount).toBeNull();
  });

  it('bölge yok → NO_TARIFF, ourChargeableKg dolu', () => {
    const r = run(line({ trackingNo: '1', netAmount: 100, destCountry: 'AU' }));
    expect(r).toMatchObject({ status: 'NO_TARIFF', ourChargeableKg: 6, note: 'Tarifede AU için bölge yok' });
  });

  it('fiyat satırı yok (tablo üstü, taşma yok) → NO_TARIFF', () => {
    const r = run(line({ trackingNo: '1', netAmount: 100, destCountry: 'GB' }), meas(60, 50, 40, 20));
    expect(r.status).toBe('NO_TARIFF');
  });

  it('para birimi uyuşmuyor → NO_TARIFF', () => {
    const r = run(line({ trackingNo: '1', netAmount: 100, currency: 'USD' }));
    expect(r.status).toBe('NO_TARIFF');
    expect(r.note).toBe('Para birimi uyuşmuyor (fatura USD, tarife TRY)');
  });

  it('para birimi belirtilmemişse tarifeninki varsayılır', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1184, currency: undefined, billedKg: 6 }));
    expect(r.status).toBe('MATCH');
  });
});

describe('ağırlık / ölçü kuralı', () => {
  it('ağırlık toleransı içinde (≤ 0,1 kg) fark yok', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1184, billedKg: 6.1 }));
    expect(r.status).toBe('MATCH');
  });

  it('ücretli kg değişmiyorsa ölçü sapması fark sayılmaz', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1184, billedKg: 6, dims: { l: 42, w: 31, h: 23 } }));
    expect(r).toMatchObject({ status: 'MATCH', diffTypes: [] });
  });

  it('kenarlar sıralanarak karşılaştırılır (yön önemsiz)', () => {
    expect(edgesExceed({ l: 25, w: 40, h: 30 }, { l: 40, w: 30, h: 25 }, 1)).toBe(false);
    expect(edgesExceed({ l: 26.5, w: 40, h: 30 }, { l: 40, w: 30, h: 25 }, 1)).toBe(true);
    expect(edgesExceed({ l: 41, w: 31, h: 26 }, { l: 40, w: 30, h: 25 }, 1)).toBe(false);
  });

  it('döndürülmüş ama aynı ölçü + fazla ağırlık → WEIGHT', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1642.5, billedKg: 9.5, actualKg: 9.5, dims: { l: 25, w: 40, h: 30 } }));
    expect(r.diffTypes).toEqual(['WEIGHT']);
  });

  it('faturada ölçü yoksa WEIGHT', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1642.5, billedKg: 9.5 }));
    expect(r.diffTypes).toEqual(['WEIGHT']);
  });

  it('kenar toleranstan büyük değil ama faturanın hacimsel ağırlığı ücretli kg\'yi artırıyor → DIMENSION', () => {
    // Bizim: 40×30×25 → 6,0; fatura 41×31×26 (her kenar +1, tolerans içinde) ama bölen 4000 → 8,265 → 8,5
    const r = run(line({ trackingNo: '1', netAmount: 1642.5, billedKg: 8.5, dims: { l: 41, w: 31, h: 26 }, billedDivisor: 4000 }));
    expect(r.diffTypes).toEqual(['DIMENSION']);
  });

  it('faturadaki ölçü + gerçek ağırlık ile billed hesap (billedKg yok, ölçü yok) → gerçek ağırlık basamağa yuvarlanır', () => {
    expect(billedChargeableKg(line({ trackingNo: '1', netAmount: 1, actualKg: 5.2 }), FEDEX)).toBe(5.5);
    expect(billedChargeableKg(line({ trackingNo: '1', netAmount: 1 }), FEDEX)).toBeNull();
  });
});

describe('ek ücret kuralı', () => {
  it('tarifede olan ek ücret doğru faturalanmışsa MATCH ve beklenene eklenir', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1469, billedKg: 6, surcharges: [{ code: 'ADDITIONAL_HANDLING', amount: 285 }] }));
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: 1469, diffAmount: 0 });
    expect(r.breakdown.at(-1)).toEqual({ label: 'Ek elleçleme', amount: 285 });
  });

  it('tarifedeki ek ücret fazla faturalanmışsa SURCHARGE', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1569, billedKg: 6, surcharges: [{ code: 'ADDITIONAL_HANDLING', amount: 385 }] }));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 100 });
    expect(r.note).toMatch(/Tarifeden fazla ek ücret/);
  });

  it('fazla tutar toleransta ise fark değil', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1472, billedKg: 6, surcharges: [{ code: 'ADDITIONAL_HANDLING', amount: 288 }] }));
    expect(r.status).toBe('MATCH');
  });

  it('PER_KG bizim ücretli kg ile', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1295, billedKg: 6, surcharges: [{ code: 'REMOTE_AREA', amount: 111 }] }));
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: 1295 });
  });

  it('ölçü farkı + tarifede olmayan ek ücret → varsayılan: [DIMENSION], ek ücret iki tarafta eşit', () => {
    const r = run(
      line({ trackingNo: '1', netAmount: 2054.5, billedKg: 9.5, dims: { l: 45, w: 35, h: 30 }, surcharges: [{ code: 'ADDRESS_CORRECTION', amount: 412 }] }),
    );
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DIMENSION'], expectedAmount: 1596, diffAmount: 458.5, uncheckedSurchargeTotal: 412 });
    expect(r.note).toContain("faturadaki tutarıyla Beklenen'e eklendi");
  });

  it('ölçü farkı + tarifede olmayan ek ücret, katı ayar → [DIMENSION, SURCHARGE]', () => {
    const r = compareLine({
      line: line({ trackingNo: '1', netAmount: 2054.5, billedKg: 9.5, dims: { l: 45, w: 35, h: 30 }, surcharges: [{ code: 'ADDRESS_CORRECTION', amount: 412 }] }),
      measurement: meas(40, 30, 25, 4),
      tariff: FEDEX,
      tol: { ...TOL, unknownSurchargesAsDiff: true },
      isDuplicate: false,
    });
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['DIMENSION', 'SURCHARGE'], expectedAmount: 1184, diffAmount: 870.5 });
  });

  it('tarifede olan ek ücret fazla + tarifede olmayan ek ücret → SURCHARGE yalnız bilinen için, fark bilinmeyen hariç', () => {
    const r = run(
      line({
        trackingNo: '1',
        netAmount: 1615.35,
        billedKg: 6,
        surcharges: [
          { code: 'ADDITIONAL_HANDLING', amount: 385 },
          { code: 'IMPORT_SERVICE', name: 'İthalat Hizmet Ücreti', amount: 46.35 },
        ],
      }),
    );
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['SURCHARGE'], diffAmount: 100, uncheckedSurchargeTotal: 46.35 });
    expect(r.note).toMatch(/Tarifeden fazla ek ücret/);
    expect(r.note).toContain('İthalat Hizmet Ücreti 46,35 ₺');
  });

  it('taşıma fiyatı farkı tarifede olmayan ek ücretle maskelenmez → PRICE', () => {
    // beklenen 1.184,00; faturalanan 1.184 + 60 (fiyat) + 46,35 (bilinmeyen)
    const r = run(line({ trackingNo: '1', netAmount: 1290.35, billedKg: 6, surcharges: [{ code: 'IMPORT_SERVICE', name: 'İthalat Hizmet Ücreti', amount: 46.35 }] }));
    expect(r).toMatchObject({ status: 'DIFF', diffTypes: ['PRICE'], diffAmount: 60, uncheckedSurchargeTotal: 46.35 });
  });

  it('yurt içi eşdeğer kod (COD ↔ KAPIDA_ODEME)', () => {
    const r = compareLine({
      line: line({ trackingNo: '1', netAmount: 149.5, billedKg: 10, destCountry: undefined, surcharges: [{ code: 'COD', amount: 14.5 }] }),
      measurement: meas(40, 30, 25, 4),
      tariff: ARAS,
      tol: TOL,
      isDuplicate: false,
    });
    expect(r).toMatchObject({ status: 'MATCH', expectedAmount: 149.5 });
  });
});

describe('fiyat farkı ve uyum', () => {
  it('fark tolerans içinde (+5,00) → MATCH', () => {
    expect(run(line({ trackingNo: '1', netAmount: 1189, billedKg: 6 })).status).toBe('MATCH');
  });
  it('fark +5,01 → PRICE', () => {
    expect(run(line({ trackingNo: '1', netAmount: 1189.01, billedKg: 6 })).diffTypes).toEqual(['PRICE']);
  });
  it('lehimize fark → MATCH + not', () => {
    const r = run(line({ trackingNo: '1', netAmount: 1172, billedKg: 6 }));
    expect(r).toMatchObject({ status: 'MATCH', diffAmount: -12, note: 'Lehimize fark' });
  });
  it('-5,00 lehimize not almaz', () => {
    expect(run(line({ trackingNo: '1', netAmount: 1179, billedKg: 6 })).note).toBeUndefined();
  });
  it('ağırlık farkı varken PRICE eklenmez', () => {
    const r = run(line({ trackingNo: '1', netAmount: 2000, billedKg: 9.5 }));
    expect(r.diffTypes).toEqual(['WEIGHT']);
  });
});

describe('pak/zarf satırları (kapsam dışı)', () => {
  it('hizmet adından tanınır; "Paket" gibi kelimeler değil', () => {
    expect(isPakService('FedEx Intl Priority Pak')).toBe(true);
    expect(isPakService('FedEx Envelope')).toBe(true);
    expect(isPakService('UPS Express Zarf')).toBe(true);
    expect(isPakService('FedEx Intl Priority')).toBe(false);
    expect(isPakService('Standart Paket')).toBe(false);
    expect(isPakService(undefined)).toBe(false);
  });

  it('ölçüm yoksa notu "kapsam dışı"; ölçülmüşse koli tarifesiyle karşılaştırılmaz (Tarife yok)', () => {
    const l = line({ trackingNo: '794800000001', netAmount: 321.5, billedKg: 1, service: 'FedEx Intl Priority Pak' });
    expect(run(l, null)).toMatchObject({ status: 'UNMATCHED', note: PAK_NOTE });
    const measured = run(l, meas(30, 20, 2, 0.4));
    expect(measured).toMatchObject({ status: 'NO_TARIFF', expectedAmount: null, diffAmount: null });
    expect(measured.note).toContain(PAK_NOTE);
    // koli satırı eskisi gibi
    expect(run(line({ trackingNo: '794800000002', netAmount: 500, billedKg: 1, service: 'FedEx Intl Priority' }), null).note).toBe('Bu takip no için ölçüm yok');
  });
});
