import { describe, expect, it } from 'vitest';
import { checkPdfLines, type PdfCheckLine } from '../src/index';

/**
 * Y44: yakıtı yalnız yüzde olarak basan PDF. Model yakıt tutarını yüzdeden hesapladıysa (tutar metinde yok) satır gereksiz
 * "İncele" (`PDF_SURCHARGE_UNVERIFIED`) olmamalı; yüzde metinde yoksa ya da hesap tutmuyorsa bayrak kalır.
 */

const T1 = '794812345305';
const T2 = '794812345306';
const codesOf = (r: ReturnType<typeof checkPdfLines>, row = 0) => r.rows.find((x) => x.rowIndex === row)?.codes ?? [];
const line = (o: Partial<PdfCheckLine> = {}): PdfCheckLine => ({ rowIndex: 0, trackingNo: T1, netAmount: 112.5, baseAmount: 100, fuelAmount: 12.5, ...o });

describe('Y44: yakıt yalnız yüzde olarak basılı', () => {
  it('satırda "Yakıt %12,5" ve navlun 100,00: yakıt 12,50 doğrulanmış (bayrak yok)', () => {
    const page = ['Takip No       Navlun    Yakıt          Tutar', `${T1}   100,00    Yakıt %12,5    112,50`].join('\n');
    expect(checkPdfLines([page], [line()]).rows).toEqual([]);
  });

  it('inceleme 2026-11-13: yüzde yalnız sütunda (satırında yakıt sözcüğü yok) sayılmaz: bayrak kalır', () => {
    // sütun başlığıyla hizası metin katmanında güvenilir değil; başlık "İndirim" de olabilirdi (aşağıdaki indirim örneği)
    const page = ['Takip No       Navlun    Yakıt     Tutar', `${T1}   100,00    %12,5     112,50`].join('\n');
    expect(codesOf(checkPdfLines([page], [line()]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
  });

  it('inceleme 2026-11-13: indirim yüzdesi yakıt kanıtı değil (%15 indirim, model yakıt 15,00 uydurdu)', () => {
    // eskiden: bayrak yok (satır penceresindeki %15 × 100,00 = 15,00 "yakıt" sayılıyordu)
    const page = ['Takip No       Navlun    İndirim   Tutar', `${T1}   135,29    %15       115,00`].join('\n');
    expect(codesOf(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 115, fuelAmount: 15 }]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    expect(codesOf(checkPdfLines([page], [{ rowIndex: 0, trackingNo: T1, netAmount: 115, fuelAmount: 15, baseAmount: 100 }]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    // yakıt sözcüklü satırda da indirim sözcüğünün yanındaki yüzde sayılmaz; yakıtınki sayılır
    const both = `${T1}   100,00   Yakıt %12,5   İndirim %15   115,00`;
    expect(codesOf(checkPdfLines([both], [{ rowIndex: 0, trackingNo: T1, netAmount: 115, fuelAmount: 15, baseAmount: 100 }]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    expect(checkPdfLines([both], [line({ netAmount: 115, fuelAmount: 12.5, discountAmount: 0 })]).rows).toEqual([]);
    const after = `${T1}   100,00   Fuel 5,00   %15 discount   115,00`;
    expect(codesOf(checkPdfLines([after], [{ rowIndex: 0, trackingNo: T1, netAmount: 115, fuelAmount: 15, baseAmount: 100 }]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
  });

  it('yüzde yalnız belge başında yakıt sözcüğüyle ("Fuel surcharge 12.5% applied"): doğrulanmış', () => {
    const page = ['Fuel surcharge 12.5% applied to all shipments', 'Tracking       Freight   Total', `${T1}   100.00    112.50`].join('\n');
    expect(checkPdfLines([page], [line()]).rows).toEqual([]);
  });

  it('indirimli taşıma üstünden yüzde: liste 125 − indirim 25 = 100, %12,5 → 12,50', () => {
    const page = ['Takip No       Liste    İndirim   Yakıt         Tutar', `${T1}   125,00   25,00     Yakıt %12,5   112,50`].join('\n');
    expect(checkPdfLines([page], [line({ baseAmount: 125, discountAmount: 25 })]).rows).toEqual([]);
  });

  it('yüzde metinde yok ya da hesap tutmuyor: bayrak kalır', () => {
    const noPct = ['Takip No       Navlun    Tutar', `${T1}   100,00    112,50`].join('\n');
    expect(codesOf(checkPdfLines([noPct], [line()]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    const otherPct = ['Takip No       Navlun    Yakıt     Tutar', `${T1}   100,00    %11       112,50`].join('\n');
    expect(codesOf(checkPdfLines([otherPct], [line()]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
  });

  it('yakıt sözcüğü olmayan satırdaki belge geneli yüzde sayılmaz (başka satırın penceresi)', () => {
    const page = [`${T2}   %12,5   50,00`, 'Ara satır', `${T1}   100,00    112,50`].join('\n');
    const r = checkPdfLines([page], [line(), { rowIndex: 1, trackingNo: T2, netAmount: 50 }]);
    expect(codesOf(r)).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
  });

  it('KDV oranına eşit yüzde sayılmaz: KDV tutarı yakıt diye yazıldıysa bayrak kalır', () => {
    const page = ['Takip No       Navlun    Yakıt %20   Tutar', `${T1}   100,00    120,00`].join('\n');
    expect(codesOf(checkPdfLines([page], [line({ netAmount: 120, fuelAmount: 20 })]))).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
    // KDV %18 ile denetlenen belgede %20 yakıt yüzdesi sayılır
    expect(checkPdfLines([page], [line({ netAmount: 120, fuelAmount: 20 })], { vatFactors: [1.18] }).rows).toEqual([]);
  });

  it('ek ücretler bu kuraldan geçmez: yalnız yakıt', () => {
    const page = ['Takip No       Navlun    Yakıt     Tutar', `${T1}   100,00    %12,5     127,50`].join('\n');
    const r = checkPdfLines([page], [line({ netAmount: 127.5, surcharges: [{ code: 'REMOTE_AREA', amount: 15 }] })]);
    expect(codesOf(r)).toEqual(['PDF_SURCHARGE_UNVERIFIED']);
  });
});
