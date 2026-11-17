import { describe, expect, it } from 'vitest';
import { checkPdfLines, checkPdfTotals, HARD_ROW_FLAGS, pdfLineEdits, ROW_FLAG_LABELS, rowFlagLabel, SOFT_ROW_FLAGS, type PdfCheckLine } from '../src/index';

/**
 * Mesaj 5 (denetim 05-B2, 05-B4, 05-B16): PDF satırının ağırlığı, ölçüsü ve ek ücretleri metinle denetlenir; satır
 * penceresinde hem X hem X ÷ (1 + oran) basılıysa ve model büyüğünü net dediyse satır "KDV belirsiz"; satır toplamı fatura
 * toplamıyla karşılaştırılır; içe aktarmada gönderilen satırlar yapay zekânın okumasıyla karşılaştırılır.
 */

const T1 = '794812345305';
const T2 = '794812345306';
const codesOf = (r: ReturnType<typeof checkPdfLines>, row = 0) => r.rows.find((x) => x.rowIndex === row)?.codes ?? [];

describe('05-B4: ağırlık, ölçü ve ek ücret PDF metninde aranır (tutarla aynı pencere)', () => {
  const page = [
    'Takip No       Kg    Desi  Ölçü (cm)    Ek ücret             Tutar',
    `${T1}   4,5   12    40x30x20     Uzak bölge 15,00     1.642,50`,
    `${T2}   2     3     10x10x10                          250,00`,
  ].join('\n');
  const line = (o: Partial<PdfCheckLine> = {}): PdfCheckLine => ({
    rowIndex: 0,
    trackingNo: T1,
    netAmount: 1642.5,
    actualKg: 4.5,
    billedKg: 12,
    dims: { l: 40, w: 30, h: 20 },
    surcharges: [{ code: 'REMOTE_AREA', amount: 15 }],
    ...o,
  });

  it('okunan değerler metindeyse bayrak yok', () => {
    expect(checkPdfLines([page], [line(), { rowIndex: 1, trackingNo: T2, netAmount: 250, actualKg: 2, billedKg: 3, dims: { l: 10, w: 10, h: 10 } }]).rows).toEqual([]);
  });

  it('ağırlık (ücretli ya da gerçek) metinde yoksa PDF_WEIGHT_UNVERIFIED', () => {
    expect(codesOf(checkPdfLines([page], [line({ billedKg: 15.2 })]))).toEqual(['PDF_WEIGHT_UNVERIFIED']);
    expect(codesOf(checkPdfLines([page], [line({ actualKg: 4.6 })]))).toEqual(['PDF_WEIGHT_UNVERIFIED']);
  });

  it('ölçülerden biri metinde yoksa PDF_DIMS_UNVERIFIED', () => {
    expect(codesOf(checkPdfLines([page], [line({ dims: { l: 40, w: 35, h: 20 } })]))).toEqual(['PDF_DIMS_UNVERIFIED']);
  });

  it('ek ücret ya da yakıt tutarı metinde yoksa PDF_SURCHARGE_UNVERIFIED; KDV dahil hâli bulunur; 0 denetlenmez', () => {
    expect(codesOf(checkPdfLines([page], [line({ surcharges: [{ code: 'REMOTE_AREA', amount: 51 }] })]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    expect(codesOf(checkPdfLines([page], [line({ fuelAmount: 99.99 })]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    // 15,00 KDV dahil basılı, satırda net 12,50 (× 1,2 = 15,00)
    expect(checkPdfLines([page], [line({ surcharges: [{ code: 'REMOTE_AREA', amount: 12.5 }] })]).rows).toEqual([]);
    expect(checkPdfLines([page], [line({ surcharges: [{ code: 'X', amount: 0 }], fuelAmount: 0 })]).rows).toEqual([]);
  });

  it('boş bırakılan (null) değer denetlenmez; alanı olmayan satır bugünkü gibi', () => {
    expect(checkPdfLines([page], [line({ actualKg: null, billedKg: null, dims: null, surcharges: [], fuelAmount: null })]).rows).toEqual([]);
    expect(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 1642.5 }]).rows).toEqual([]);
  });

  it('sayı biçimleri: tam sayı, tek ondalık, virgül/nokta, binlik', () => {
    const one = (text: string, billedKg: number) => codesOf(checkPdfLines([`${T1} ${text} 100,00`], [{ rowIndex: 0, trackingNo: T1, netAmount: 100, billedKg }]));
    expect(one('12,5 kg', 12.5)).toEqual([]);
    expect(one('12.5 kg', 12.5)).toEqual([]);
    expect(one('12,50 kg', 12.5)).toEqual([]);
    expect(one('Desi 12', 12)).toEqual([]);
    expect(one('1.234,5 kg', 1234.5)).toEqual([]);
    expect(one('1,234.5 kg', 1234.5)).toEqual([]);
    expect(one('4,536', 4.536)).toEqual([]);
    expect(one('12,5 kg', 12.4)).toEqual(['PDF_WEIGHT_UNVERIFIED']);
    // tarih ağırlık sayılmaz
    expect(one('20.10.2026', 20.1)).toEqual(['PDF_WEIGHT_UNVERIFIED']);
  });

  it('lb: basılı lb değeri aranır, kg karşılığı değil (çeviri kodda); model zaten kg yazdıysa da bulunur', () => {
    const text = [`${T1} 10 lb 100,00`];
    const l = (actualKg: number): PdfCheckLine[] => [{ rowIndex: 0, trackingNo: T1, netAmount: 100, actualKg }];
    expect(checkPdfLines(text, l(4.536), { units: { weight: 'lb' } }).rows).toEqual([]);
    // çift çevirmeye karşı korunan değer (4,54 kg, PDF'te "10 lb")
    expect(checkPdfLines(text, l(4.54), { units: { weight: 'lb' } }).rows).toEqual([]);
    // birim kg iken 4,536 metinde yok
    expect(codesOf(checkPdfLines(text, l(4.536), { units: { weight: 'kg' } }))).toEqual(['PDF_WEIGHT_UNVERIFIED']);
    // g: 2500 g → 2,5 kg
    expect(checkPdfLines([`${T1} 2500 g 100,00`], l(2.5), { units: { weight: 'g' } }).rows).toEqual([]);
    // birim bilinmiyor (eski önizleme, karışık gruplar): bütün karşılıklar
    expect(checkPdfLines(text, l(4.536), { units: { weight: 'any' } }).rows).toEqual([]);
  });

  it('in: basılı inç değeri aranır', () => {
    const text = [`${T1} 10x5x2 in 100,00`];
    const l: PdfCheckLine[] = [{ rowIndex: 0, trackingNo: T1, netAmount: 100, dims: { l: 25.4, w: 12.7, h: 5.08 } }];
    expect(checkPdfLines(text, l, { units: { dim: 'in' } }).rows).toEqual([]);
    expect(codesOf(checkPdfLines(text, l, { units: { dim: 'cm' } }))).toEqual(['PDF_DIMS_UNVERIFIED']);
  });

  it('pencere: alt satırın ağırlığı bu satırınki sayılmaz; takip no metinde yoksa bu alanlar denetlenmez', () => {
    expect(codesOf(checkPdfLines([page], [line({ actualKg: 2 }), { rowIndex: 1, trackingNo: T2, netAmount: 250 }]))).toEqual(['PDF_WEIGHT_UNVERIFIED']);
    expect(codesOf(checkPdfLines([page], [line({ trackingNo: '794899999999', billedKg: 77 })]))).toEqual(['PDF_TRACKING_UNVERIFIED']);
  });

  it('inceleme 3: blok düzeni (UPS/FedEx/DHL): ek ücret, ağırlık ve ölçü takip no satırından 3+ satır sonra; sonraki takip no\'ya kadar (en çok 12 satır)', () => {
    const block = [
      '1Z999AA10123456784  Ground  Total 56.25',
      'Reference PO-7781',
      'Weight 4.5 lbs',
      'Dimensions 12x10x8 in',
      'Transportation 45.00',
      'Fuel Surcharge 6.75',
      'Residential Surcharge 4.50',
      '1Z999AA10123456785  Ground  Total 10.00',
    ].join('\n');
    const l: PdfCheckLine = { rowIndex: 0, trackingNo: '1Z999AA10123456784', netAmount: 56.25, actualKg: 2.041, fuelAmount: 6.75, surcharges: [{ code: 'RESIDENTIAL', amount: 4.5 }], dims: { l: 30.48, w: 25.4, h: 20.32 } };
    expect(checkPdfLines([block], [l], { units: { weight: 'lb', dim: 'in' } }).rows).toEqual([]);
    // sonraki takip no'nun bloğundaki değer bu satırınki sayılmaz
    const next = `${block}\nResidential Surcharge 9.99`;
    const both = [{ ...l, surcharges: [{ code: 'RESIDENTIAL', amount: 9.99 }] }, { rowIndex: 1, trackingNo: '1Z999AA10123456785', netAmount: 10 }];
    expect(codesOf(checkPdfLines([next], both, { units: { weight: 'lb', dim: 'in' } }))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    // 12 satırdan uzak değer bulunmaz
    const far = ['1Z999AA10123456784 Total 56.25', ...Array.from({ length: 12 }, (_, i) => `not ${i}`), 'Residential Surcharge 4.50'].join('\n');
    expect(codesOf(checkPdfLines([far], [{ rowIndex: 0, trackingNo: '1Z999AA10123456784', netAmount: 56.25, surcharges: [{ code: 'RESIDENTIAL', amount: 4.5 }] }]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    // net tutarın penceresi değişmedi (3 satır)
    const farNet = ['1Z999AA10123456784 Ground', 'a', 'b', 'c', 'Total 56.25'].join('\n');
    expect(codesOf(checkPdfLines([farNet], [{ rowIndex: 0, trackingNo: '1Z999AA10123456784', netAmount: 56.25 }]))).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });

  it('metin katmanı yoksa denetim yok', () => {
    expect(checkPdfLines([''], [line({ billedKg: 99 })])).toEqual({ method: 'none', checked: 0, rows: [] });
  });

  it('yeni bayraklar sert; TR ve EN etiketi var', () => {
    for (const c of ['PDF_WEIGHT_UNVERIFIED', 'PDF_DIMS_UNVERIFIED', 'PDF_SURCHARGE_UNVERIFIED'] as const) {
      expect(HARD_ROW_FLAGS).toContain(c);
      expect(SOFT_ROW_FLAGS).not.toContain(c);
      expect(ROW_FLAG_LABELS[c]).toBe(rowFlagLabel(c, 'tr'));
      expect(rowFlagLabel(c, 'en')).not.toBe(rowFlagLabel(c, 'tr'));
      expect(rowFlagLabel(c, 'en')).not.toContain('verify.flag');
    }
    expect(rowFlagLabel('PDF_WEIGHT_UNVERIFIED', 'tr')).toBe('Ağırlık PDF metninde bulunamadı');
  });
});

describe('05-B2: satır penceresinde X ve X ÷ (1 + oran) basılı, model büyüğünü net dedi', () => {
  // denetçinin örneği (denetim-05/vat.ts): her satırda KDV hariç, KDV ve toplam basılı
  const kdvPage = [
    'Gönderi No        Desi   Tutar (KDV Hariç)   KDV %20   Toplam',
    '1234567890123     5      150,00              30,00     180,00',
    '1234567890124     3      100,00              20,00     120,00',
  ].join('\n');
  const rows = (a: number, b: number, o: Partial<PdfCheckLine> = {}): PdfCheckLine[] => [
    { rowIndex: 0, trackingNo: '1234567890123', netAmount: a, ...o },
    { rowIndex: 1, trackingNo: '1234567890124', netAmount: b, ...o },
  ];

  it('KDV dahil tutar net diye okundu: iki satır da PDF_VAT_UNCLEAR', () => {
    expect(checkPdfLines([kdvPage], rows(180, 120), { vatFactors: [1.2] }).rows).toEqual([
      { rowIndex: 0, codes: ['PDF_VAT_UNCLEAR'] },
      { rowIndex: 1, codes: ['PDF_VAT_UNCLEAR'] },
    ]);
  });

  it('doğru okuma bayraksız; KDV payının ek ücret diye yazılması bileşen sayılmaz', () => {
    expect(checkPdfLines([kdvPage], rows(150, 100), { vatFactors: [1.2] }).rows).toEqual([]);
    const asSurcharge = checkPdfLines([kdvPage], [{ rowIndex: 0, trackingNo: '1234567890123', netAmount: 180, baseAmount: 150, surcharges: [{ code: 'VAT', name: 'KDV', amount: 30 }] }], { vatFactors: [1.2] });
    expect(codesOf(asSurcharge)).toEqual(['PDF_VAT_UNCLEAR']);
  });

  it('yanlış alarm yok: taşıma 100 + yakıt 20 = net 120 (100 = 120 ÷ 1,2 rastlantı), model bileşenleri okudu', () => {
    const page = ['KDV %20 fatura toplamında', 'Takip No       Taşıma   Yakıt   Tutar', `${T1}   100,00    20,00   120,00`].join('\n');
    expect(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 120, baseAmount: 100, fuelAmount: 20 }]).rows).toEqual([]);
    // indirimli: 125 - 25 + 20 = 120
    const disc = ['KDV %20', `${T1} 125,00 -25,00 20,00 100,00 120,00`].join('\n');
    expect(checkPdfLines([disc], [{ rowIndex: 0, trackingNo: T1, netAmount: 120, baseAmount: 125, discountAmount: 25, fuelAmount: 20 }]).rows).toEqual([]);
    // satırda KDV dahil hâli de basılıysa (144,00) 120 nettir
    const withGross = ['KDV %20', `${T1} 100,00 20,00 120,00 144,00`].join('\n');
    expect(checkPdfLines([withGross], [{ rowIndex: 0, trackingNo: T1, netAmount: 120 }]).rows).toEqual([]);
    // belgede KDV/VAT hiç geçmiyorsa kural çalışmaz (yurt dışı fatura, yakıt tam %20)
    const noVat = ['Tracking  Freight  Fuel  Total', `${T1} 100.00 20.00 120.00`].join('\n');
    expect(checkPdfLines([noVat], [{ rowIndex: 0, trackingNo: T1, netAmount: 120 }]).rows).toEqual([]);
  });

  it('bilinen sınır: model bileşenleri okumadıysa ve satırda yalnız 100 / 20 / 120 varsa satır "İncele" olur', () => {
    const page = ['KDV %20', `${T1} 100,00 20,00 120,00`].join('\n');
    expect(codesOf(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 120 }]))).toEqual(['PDF_VAT_UNCLEAR']);
  });

  it('inceleme 1: model toplamı taşımaya kopyaladıysa (taban = net, başka bileşen yok) bileşen açıklaması sayılmaz', () => {
    const page = ['KDV %20', `${T1}  Tutar 100,00  KDV Dahil 120,00`].join('\n');
    expect(codesOf(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 120, baseAmount: 120 }]))).toEqual(['PDF_VAT_UNCLEAR']);
    // sıfır yakıt da bileşen sayılmaz
    expect(codesOf(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 120, baseAmount: 120, fuelAmount: 0 }]))).toEqual(['PDF_VAT_UNCLEAR']);
  });

  it('inceleme 2: KDV/vergi adlı ek ücret (VAT_AMOUNT, TAX, Vergi) bileşen sayılmaz', () => {
    const page = [`${T1} Navlun 100,00 KDV 20,00 Toplam 120,00`];
    for (const s of [{ code: 'VAT_AMOUNT', name: 'Tax' }, { code: 'TAX', name: 'Vergi' }, { code: 'VAT_20', name: null }, { code: 'X', name: 'K.D.V.' }]) {
      const l = [{ rowIndex: 0, trackingNo: T1, netAmount: 120, baseAmount: 100, surcharges: [{ ...s, amount: 20 }] }];
      expect(codesOf(checkPdfLines(page, l)), JSON.stringify(s)).toContain('PDF_VAT_UNCLEAR');
    }
  });

  it('oran %0 ya da çarpan 1: kural çalışmaz', () => {
    expect(checkPdfLines([kdvPage], rows(180, 120), { vatFactors: [1] }).rows).toEqual([]);
  });
});

describe('05-B2: satır toplamı fatura toplamıyla (checkPdfTotals)', () => {
  const text = [
    'Gönderi No        Tutar (KDV Hariç)   KDV %20   Toplam',
    '1234567890123     150,00              30,00     180,00',
    '1234567890124     100,00              20,00     120,00',
    'Toplam (KDV Hariç) 250,00',
    'KDV %20 50,00',
    'Genel Toplam 300,00',
  ].join('\n');
  const totals = { net: 250, vat: 50, gross: 300 };
  const base = { amountsIncludeVat: false, vatPct: 20, vatPctRead: 20 as number | null };

  it('toplam yoksa (eski yanıt) sonuç yok', () => {
    expect(checkPdfTotals([text], { ...base, totals: null, lineAmounts: [150, 100] })).toBeNull();
  });

  it('KDV hariç dendi, satırlar nete eşit: ok; %1 içinde sapma ok', () => {
    expect(checkPdfTotals([text], { ...base, totals, lineAmounts: [150, 100] })).toMatchObject({ status: 'ok', basis: 'net', linesSum: 250 });
    expect(checkPdfTotals([text], { ...base, totals, lineAmounts: [150, 102] })).toMatchObject({ status: 'ok' });
  });

  it('KDV hariç dendi ama satır toplamı brüte eşit: vatSwapped', () => {
    expect(checkPdfTotals([text], { ...base, totals, lineAmounts: [180, 120] })).toMatchObject({ status: 'vatSwapped', basis: 'net', linesSum: 300 });
  });

  it('KDV dahil dendi ama satır toplamı nete eşit: vatSwapped; brüte eşitse ok', () => {
    expect(checkPdfTotals([text], { ...base, amountsIncludeVat: true, totals, lineAmounts: [150, 100] })).toMatchObject({ status: 'vatSwapped', basis: 'gross' });
    expect(checkPdfTotals([text], { ...base, amountsIncludeVat: true, totals, lineAmounts: [180, 120] })).toMatchObject({ status: 'ok', basis: 'gross' });
  });

  it('eksik satır: %1\'den fazla sapma mismatch (yüzdesiyle)', () => {
    const r = checkPdfTotals([text], { ...base, totals, lineAmounts: [150] });
    expect(r).toMatchObject({ status: 'mismatch', linesSum: 150, invoiceAmount: 250 });
    expect(r!.deviationPct).toBeCloseTo(-40, 5);
  });

  it('metinde olmayan toplam kullanılmaz (uydurulmuş olabilir); hepsi düşerse unavailable', () => {
    const r = checkPdfTotals([text], { ...base, totals: { net: 999, vat: null, gross: null }, lineAmounts: [150, 100] });
    expect(r).toMatchObject({ status: 'unavailable', reason: 'notInText' });
    // biri metinde yoksa öbürleriyle sürer
    expect(checkPdfTotals([text], { ...base, totals: { net: 250, vat: 51, gross: 300 }, lineAmounts: [180, 120] })).toMatchObject({ status: 'vatSwapped' });
  });

  it('toplamlar birbirini tutmuyorsa (net + KDV ≠ brüt) güvenilmez', () => {
    expect(checkPdfTotals([text], { ...base, totals: { net: 300, vat: 50, gross: 300 }, lineAmounts: [180, 120] })).toMatchObject({ status: 'unavailable', reason: 'inconsistent' });
  });

  it('basılı değil (model null dedi): unavailable notPrinted', () => {
    expect(checkPdfTotals([text], { ...base, totals: { net: null, vat: null, gross: null }, lineAmounts: [150, 100] })).toMatchObject({ status: 'unavailable', reason: 'notPrinted' });
  });

  it('yalnız brüt okundu: net oranla türetilir ve metinde aranır; metinde yoksa kullanılmaz', () => {
    const g = ['KDV %20', 'Ara Toplam 250,00', 'Genel Toplam 300,00'];
    const only = { net: null, vat: null, gross: 300 };
    expect(checkPdfTotals(g, { ...base, totals: only, lineAmounts: [150, 100] })).toMatchObject({ status: 'ok' });
    expect(checkPdfTotals(g, { ...base, totals: only, lineAmounts: [180, 120] })).toMatchObject({ status: 'vatSwapped' });
    // türetilen net (250) metinde yok: karar verilemez
    expect(checkPdfTotals(['KDV %20 Genel Toplam 300,00'], { ...base, totals: only, lineAmounts: [180, 120] })).toMatchObject({ status: 'unavailable' });
  });

  it('inceleme 4: model brütü net diye okudu, okunan bir toplam metinde yok ya da türetilen toplam metinde yok: ok denmez', () => {
    const t = ['Mal hizmet 1.000,00', 'KDV 200,00', 'Odenecek 1.200,00'];
    // 1.400 metinde yok (düşer), 1.200 + 200 = 1.400 türetilir ama metinde yok
    expect(checkPdfTotals(t, { ...base, totals: { net: 1200, vat: 200, gross: 1400 }, lineAmounts: [1200] })).toMatchObject({ status: 'unavailable', reason: 'notInText' });
    // yalnız net 1.200 okundu: %20 ile brüt 1.440 metinde yok
    expect(checkPdfTotals(t, { ...base, totals: { net: 1200, vat: null, gross: null }, lineAmounts: [1200] })).toMatchObject({ status: 'unavailable', reason: 'notInText' });
    // oran okunmadı ama belgede KDV geçiyor: varsayılan oranla aynı denetim
    expect(checkPdfTotals(t, { ...base, vatPctRead: null, totals: { net: 1200, vat: null, gross: null }, lineAmounts: [1200] })).toMatchObject({ status: 'unavailable' });
    // doğru okuma yine ok
    expect(checkPdfTotals(t, { ...base, totals: { net: 1000, vat: null, gross: null }, lineAmounts: [1000] })).toMatchObject({ status: 'ok' });
  });

  it('inceleme 5: fatura düzeyinde indirim satır toplamını brüte eşitlerse vatSwapped değil, mismatch', () => {
    // 100 + 200 + 300 = 600; 1/6 indirim (100) → net 500, KDV 100, brüt 600
    const t = ['Satirlar toplami 600,00', 'Iskonto 100,00', 'Matrah 500,00', 'KDV %20 100,00', 'Genel Toplam 600,00'];
    expect(checkPdfTotals(t, { ...base, totals: { net: 500, vat: 100, gross: 600 }, lineAmounts: [100, 200, 300] })).toMatchObject({ status: 'mismatch' });
    // indirim yazmayan aynı sayılar: vatSwapped
    const noDisc = ['Matrah 500,00', 'KDV %20 100,00', 'Genel Toplam 600,00'];
    expect(checkPdfTotals(noDisc, { ...base, totals: { net: 500, vat: 100, gross: 600 }, lineAmounts: [100, 200, 300] })).toMatchObject({ status: 'vatSwapped' });
    // brüte eşitlik sıkı payla (binde 2): %1 içinde ama binde 2 dışında kalan vatSwapped değil
    expect(checkPdfTotals(noDisc, { ...base, totals: { net: 500, vat: 100, gross: 600 }, lineAmounts: [100, 200, 304] })).toMatchObject({ status: 'mismatch' });
  });

  it('inceleme 6: belgede KDV/VAT hiç geçmiyorsa oran 0 sayılır (yurt dışı fatura, yalnız "Amount Due")', () => {
    const t = ['Tracking 1Z999AA10123456784 45.00', 'Amount Due 45.00'];
    expect(checkPdfTotals(t, { ...base, vatPctRead: null, totals: { net: null, vat: null, gross: 45 }, lineAmounts: [45] })).toMatchObject({ status: 'ok' });
    expect(checkPdfTotals(t, { ...base, vatPctRead: null, totals: { net: 45, vat: null, gross: null }, lineAmounts: [45] })).toMatchObject({ status: 'ok' });
  });

  it('KDV %0: net = brüt, satırlar eşit: ok (vatSwapped değil)', () => {
    const t = ['Toplam 1.000,00 KDV 0,00 Genel Toplam 1.000,00'];
    expect(checkPdfTotals(t, { ...base, vatPctRead: 0, vatPct: 0, totals: { net: 1000, vat: 0, gross: 1000 }, lineAmounts: [1000] })).toMatchObject({ status: 'ok' });
  });

  it('taranmış belge (metin yok): modelin toplamı denetlenemez ama karşılaştırılır, textChecked false', () => {
    expect(checkPdfTotals([''], { ...base, totals, lineAmounts: [180, 120] })).toMatchObject({ status: 'vatSwapped', textChecked: false });
    expect(checkPdfTotals([text], { ...base, totals, lineAmounts: [150, 100] })).toMatchObject({ textChecked: true });
    // taranmışta tek toplamdan oranla türetilmez: model brütü satırlardan kendisi toplamış olabilir (sahte "KDV belirsiz" olmasın)
    expect(checkPdfTotals([''], { ...base, totals: { net: null, vat: null, gross: 250 }, lineAmounts: [150, 100] })).toMatchObject({ status: 'unavailable', reason: 'ambiguous' });
  });

  it('iade satırı (eksi) toplama işaretiyle girer', () => {
    expect(checkPdfTotals([text], { ...base, totals, lineAmounts: [150, 110, -10] })).toMatchObject({ status: 'ok', linesSum: 250 });
  });
});

describe('05-B16: gönderilen satırlar yapay zekânın okumasıyla karşılaştırılır (pdfLineEdits)', () => {
  const ai = [
    { rowIndex: 0, trackingNo: T1, netAmount: 100, billedKg: 5, surcharges: [] },
    { rowIndex: 2, trackingNo: T2, netAmount: 50, dims: { l: 10, w: 10, h: 10 }, surcharges: [{ code: 'X', amount: 5 }] },
    { rowIndex: 3, trackingNo: '794812345307', netAmount: 20, surcharges: [] },
  ];

  it('değişmeyen satır sayılmaz; değişen alanlar, eklenen ve çıkarılan satırlar', () => {
    const sent = [
      { rowIndex: 0, trackingNo: T1, netAmount: 100, billedKg: 6, surcharges: [] },
      { rowIndex: 2, trackingNo: T2, netAmount: 55, dims: { l: 10, w: 10, h: 12 }, surcharges: [{ code: 'X', amount: 5 }] },
      { rowIndex: 9, trackingNo: '794899999999', netAmount: 1, surcharges: [] },
    ];
    expect(pdfLineEdits(ai, sent)).toEqual({ edited: 2, added: 1, removed: 1, fields: { billedKg: 1, netAmount: 1, dims: 1 }, rows: [1, 3] });
    expect(pdfLineEdits(ai, ai.map((l) => ({ ...l })))).toBeNull();
    // para birimi ve takip no yazımı ("TL" → TRY, boşluk) değişiklik sayılmaz; boş metin ile alan yok aynı
    expect(pdfLineEdits([{ ...ai[0]!, currency: 'TRY', shipDate: undefined }], [{ ...ai[0]!, trackingNo: ` ${T1} `, currency: 'TL', shipDate: ' ' }])).toBeNull();
  });
});

// K36 (kullanıcı kararı 2026-11-14; inceleme): yapay zekâ "1.500" kg'ı düz sayı (1,5 ya da 1500) döndürür; metin denetimi iki
// okumayı da kabul ettiği için satır işaretlenmezdi. Ağırlık penceresinde iki türlü okunan basılı yazımla eşleşirse satır
// `weightAmbiguity` taşır (bayrak değil; API seçimsiz içe aktarmaz).
describe('K36: PDF\'te basılı "1.500" ağırlık sorulur', () => {
  const page = [`${T1}   1.500   2,5   100,00`, `${T2}   1,5   3   200,00`].join('\n');
  const row0 = (o: Partial<PdfCheckLine> = {}): PdfCheckLine => ({ rowIndex: 0, trackingNo: T1, netAmount: 100, actualKg: 1.5, billedKg: 2.5, ...o });

  it.each([1.5, 1500])('yapay zekâ %s dese de satır iki okumayla işaretlenir; doğrulama bayrağı çıkmaz', (kg) => {
    // ikinci satır da denetlenir: penceresi kendi takip no'sunda başlar (yoksa "1,5" birinci satırın penceresinde kalır)
    const r = checkPdfLines([page], [row0({ actualKg: kg }), { rowIndex: 1, trackingNo: T2, netAmount: 200, actualKg: 1.5, billedKg: 3 }]);
    expect(r.rows).toEqual([{ rowIndex: 0, codes: [], weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } } }]);
  });

  it('belirsiz olmayan basılı yazım ("1,5", "2,5") sorulmaz', () => {
    const r = checkPdfLines([page], [row0({ actualKg: 2.5, billedKg: 2.5 }), { rowIndex: 1, trackingNo: T2, netAmount: 200, actualKg: 1.5, billedKg: 3 }]);
    expect(r.rows).toEqual([]);
  });

  // kullanıcı kararı 2026-11-14: virgüllü "1,500" de iki türlü okunur (Türkçe 1,5 / İngilizce 1500); PDF'in dili kanıt değildir
  it.each([1.5, 1500])('basılı "1,500" (yapay zekâ %s): aynı soru', (kg) => {
    const r = checkPdfLines([`${T1}   1,500 kg   100,00`], [row0({ actualKg: kg, billedKg: undefined })]);
    expect(r.rows).toEqual([{ rowIndex: 0, codes: [], weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: ',', text: '1,500' } } }]);
    // para işaretli ya da tek türlü de basılıysa yine sorulmaz
    expect(checkPdfLines([`${T1}   1,5 kg   1,500 TL`], [row0({ actualKg: 1.5, billedKg: undefined, netAmount: 1500 })]).rows.filter((x) => x.weightAmbiguity)).toEqual([]);
  });

  it('lb basılı "1.500": kg karşılıklarıyla', () => {
    const lb = checkPdfLines([`${T1}   1.500 lb   100,00`], [row0({ actualKg: 0.68, billedKg: undefined })], { units: { weight: 'lb' } });
    expect(lb.rows[0]!.weightAmbiguity).toEqual({ actualKg: { decimal: 0.68, thousands: 680.389, sep: '.', text: '1.500' } });
  });
});

// İkinci doğrulama: tutar ya da başka sayı "N.NNN" yazıldı diye tek türlü basılı ağırlık sorulmaz (önceden alınan PDF'ler kilitlenmesin).
describe('K36: PDF\'te yalnız ağırlığın kendi yazımı iki türlü okunuyorsa sorulur', () => {
  const at = (text: string, kg: number) => checkPdfLines([text], [{ rowIndex: 0, trackingNo: T1, netAmount: 100, actualKg: kg }]).rows[0]?.weightAmbiguity;

  it.each([
    [`${T1}   2 kg   2.000 TL   100,00`, 2],
    [`${T1}   1,5 kg   1.500 TL   100,00`, 1.5],
    [`${T1}   1,5   ₺1.500   100,00`, 1.5],
    [`${T1}   2   2.000   100,00`, 2],
    [`${T1}   1500   1.500 EUR   100,00`, 1500],
  ])('%j (ağırlık %s): soru yok', (text, kg) => {
    expect(at(text, kg)).toBeUndefined();
  });

  it('ağırlık yalnız "1.500" yazımıyla basılıysa (birimli ya da birimsiz) sorulur', () => {
    expect(at(`${T1}   1.500 kg   100,00`, 1.5)).toEqual({ actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } });
    expect(at(`${T1}   1.500   100,00`, 1500)).toEqual({ actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } });
  });
});

// İnceleme: Türkçe PDF'te 3 ondalıklı kg ("1,500 kg") her satırda sorulmasın: belgenin açık sayı biçimi kanıtı karar verir.
describe('K36: PDF belgesinin sayı biçimi kanıtı', () => {
  const at = (text: string, kg: number) => checkPdfLines([text], [{ rowIndex: 0, trackingNo: T1, netAmount: 1234.56, actualKg: kg }]).rows[0]?.weightAmbiguity;
  // açık kanıt: tek yönde en az iki yazım (gruplu iki ayırıcılı ya da para işaretli iki ondalıklı)
  const TR = '1.234,56   2.345,67';
  const EN = '1,234.56   2,345.67';

  it('Türkçe belge: "1,500" = 1,5 kg sorulmaz; yapay zekâ 1500 dediyse (çelişki) sorulur', () => {
    expect(at(`${T1}   1,500 kg   ${TR}`, 1.5)).toBeUndefined();
    expect(at(`${T1}   1,500 kg   ${TR}`, 1500)).toEqual({ actualKg: { decimal: 1.5, thousands: 1500, sep: ',', text: '1,500' } });
    expect(at(`${T1}   1,500 kg   250,00 TL   80,00 TL`, 1.5)).toBeUndefined();
    // Türkçe belgede "1.500" binliktir: 1500 kg sorulmaz
    expect(at(`${T1}   1.500 kg   ${TR}`, 1500)).toBeUndefined();
  });

  it('İngilizce belge: "1.500" = 1,5 kg sorulmaz; "1,500" = 1500', () => {
    expect(at(`${T1}   1.500 kg   ${EN}`, 1.5)).toBeUndefined();
    expect(at(`${T1}   1,500 kg   ${EN}`, 1500)).toBeUndefined();
    expect(at(`${T1}   1,500 kg   ${EN}`, 1.5)).toMatchObject({ actualKg: { sep: ',' } });
  });

  // son doğrulama: karar penceredeki ilk yazıma göre verilmez; birim bitişik yazım satırın ağırlığıdır
  it.each([
    [`${T1}   1.500   1,500 kg   ${TR}`, 'Türkçe, birimsiz "1.500" önde'],
    [`${T1}   1,500 kg   1.500   ${TR}`, 'Türkçe, birimli önde'],
    [`${T1}   1,500   1.500 kg   ${EN}`, 'İngilizce ayna'],
  ])('%s (%s): yapay zekâ 1500 → sorulur (birimli yazım belgenin biçiminde 1,5 kg)', (text) => {
    expect(at(text, 1500)).toMatchObject({ actualKg: { decimal: 1.5, thousands: 1500 } });
  });

  it('birimsiz yazımların hepsi belgenin biçiminde aynı değeri veriyorsa sorulmaz; biri uymuyorsa sorulur', () => {
    expect(at(`${T1}   1.500   ${TR}`, 1500)).toBeUndefined();
    expect(at(`${T1}   1.500   1,500   ${TR}`, 1500)).toMatchObject({ actualKg: { sep: ',' } });
  });

  it('kanıt yoksa, tek kanıt varsa ya da iki yönde kanıt varsa sorulur', () => {
    expect(at(`${T1}   1,500 kg   100`, 1.5)).toMatchObject({ actualKg: { sep: ',' } });
    // tek kanıt ("Kur 34.50 TL" ya da kapaktaki tek toplam) belgeye karar vermez
    expect(at(`${T1}   1,500 kg   1.234,56`, 1.5)).toMatchObject({ actualKg: { sep: ',' } });
    expect(at(`${T1}   1.500 kg   Kur 34.50 TL`, 1.5)).toMatchObject({ actualKg: { sep: '.' } });
    expect(at(`${T1}   1,500 kg   ${TR}   9,876.54`, 1.5)).toMatchObject({ actualKg: { sep: ',' } });
  });
});
