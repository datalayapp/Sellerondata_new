/**
 * Y20, Y23, Y31: PDF fatura okumasının saf işlevleri (veritabanı ve yapay zekâ çağrısı yok). Uçtan uca hâli
 * `pdfInvoiceCheck.test.ts` ve `jobKinds.test.ts` içinde.
 */
import { describe, expect, it } from 'vitest';
import type { PdfInvoiceInput } from '../src/services/ai.ts';
import {
  checkInvoicePdfLines,
  findPdfMissedLines,
  parsePdfLines,
  pdfLinesToParsed,
  pdfPreviewValue,
  pdfReadUnits,
  pdfSkippedRows,
  readPdfPreview,
} from '../src/services/invoicePdfCheck.ts';
import { mergePdfParts, type PdfPartResult } from '../src/services/invoicePdfRead.ts';

const blank = {
  shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
  billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null,
};
type AiLine = PdfInvoiceInput['lines'][number];
const aiLine = (trackingNo: string, netAmount: number, o: Partial<AiLine> = {}): AiLine => ({ ...blank, trackingNo, netAmount, ...o });
/** Y20 öncesi yanıt biçimi: `vatPct` ve `weightUnit` hiç yok. */
const invoice = (lines: AiLine[], o: Partial<PdfInvoiceInput> = {}): PdfInvoiceInput => ({ invoiceNo: 'F1', invoiceDate: '2026-10-27', currency: 'TRY', amountsIncludeVat: false, lines, ...o });

describe('Y20: pdfLinesToParsed oran ve birimi okumadan alır', () => {
  it('eski yanıt (alan yok): KDV %20, kg; bugünkü sonuçla aynı', () => {
    const parsed = pdfLinesToParsed(invoice([aiLine('794812345305', 120, { actualKg: 2.5, billedKg: 3 })], { amountsIncludeVat: true }));
    expect(parsed[0]).toMatchObject({ netAmount: 100, actualKg: 2.5, billedKg: 3 });
    expect(pdfReadUnits(invoice([aiLine('X', 1, { actualKg: 1 })], { amountsIncludeVat: true }))).toMatchObject({ vatPct: 20, vatAssumed: true, weightUnit: 'kg', weightAssumed: true });
  });

  it('okunan oran (%10, %0) kullanılır; bileşenler aynı kuralla', () => {
    const at10 = pdfLinesToParsed(invoice([aiLine('794812345305', 110, { baseAmount: 88, fuelAmount: 22 })], { amountsIncludeVat: true, vatPct: 10 }));
    expect(at10[0]).toMatchObject({ netAmount: 100, baseAmount: 80, fuelAmount: 20 });
    expect(pdfLinesToParsed(invoice([aiLine('794812345305', 110)], { amountsIncludeVat: true, vatPct: 0 }))[0]!.netAmount).toBe(110);
    // geçersiz oran (kesir yazımı) okunmamış sayılır: %20
    expect(pdfLinesToParsed(invoice([aiLine('794812345305', 120)], { amountsIncludeVat: true, vatPct: 0.2 }))[0]!.netAmount).toBe(100);
  });

  it('lb → kg: CSV/Excel ile aynı çarpan ve 3 ondalık; kg değişmez; tanınmayan birimde (inceleme 2) ağırlık kullanılmaz', () => {
    const lb = pdfLinesToParsed(invoice([aiLine('794812345305', 10, { actualKg: 10, billedKg: 1 })], { weightUnit: 'LBS' }));
    expect(lb[0]).toMatchObject({ actualKg: 4.536, billedKg: 0.454 });
    expect(pdfLinesToParsed(invoice([aiLine('794812345305', 10, { actualKg: 1.2345 })], { weightUnit: 'kg' }))[0]!.actualKg).toBe(1.2345);
    expect(pdfLinesToParsed(invoice([aiLine('794812345305', 10, { actualKg: 2 })], { weightUnit: 'stone' }))[0]!.actualKg).toBeUndefined();
    expect(pdfReadUnits(invoice([aiLine('X', 1, { actualKg: 2 })], { weightUnit: 'stone' }))).toMatchObject({ weightUnusable: true, weightAssumed: false });
  });

  it('rawHash satır no\'dan bağımsız (yeniden yüklemede mükerrer denetimi değişmez)', () => {
    const a = pdfLinesToParsed(invoice([aiLine('794812345305', 10)]));
    const b = pdfLinesToParsed(invoice([aiLine('', 1), aiLine('794812345305', 10)]));
    expect(a[0]!.rawHash).toBe(b[0]!.rawHash);
  });
});

describe('Y23: satır no yapay zekâ çıktısındaki sıra', () => {
  it('alınan ve alınmayan satırlar aynı ölçek (0 tabanlı, ekranda +1)', () => {
    const ai = invoice([aiLine('A1234567', 10), aiLine('', 45), aiLine('B1234567', 20), aiLine('', 0), aiLine('C1234567', 30)]);
    expect(pdfLinesToParsed(ai).map((l) => l.rowIndex)).toEqual([0, 2, 4]);
    expect(pdfSkippedRows(ai)).toEqual([{ rowIndex: 1, reason: 'NO_TRACKING', amount: 45 }]);
  });

  it('takip no\'suz satırın tutarı okunan oranla nete çevrilir', () => {
    expect(pdfSkippedRows(invoice([aiLine('', 118)], { amountsIncludeVat: true, vatPct: 18 }))).toEqual([{ rowIndex: 0, reason: 'NO_TRACKING', amount: 100 }]);
  });
});

describe('Y20: metin denetimi okunan oranla', () => {
  it('KDV dahil basılı tutar okunan oranla aranır', () => {
    const lines = [{ rowIndex: 0, trackingNo: '794812345305', netAmount: 1000 }];
    expect(checkInvoicePdfLines(['794812345305 1.180,00'], lines, 18).unverified).toBe(0);
    expect(checkInvoicePdfLines(['794812345305 1.180,00'], lines).unverified).toBe(1); // varsayılan %20: 1.200,00 aranır
  });
});

describe('Y20: önizleme kaydı (File.preview.read)', () => {
  it('yazılır ve okunur; varsayım bayrakları yalnız true iken', () => {
    const v = pdfPreviewValue({ read: { vatPct: 20, weightUnit: 'kg', vatAssumed: true, weightAssumed: false } });
    expect(v).toEqual({ v: 1, read: { vatPct: 20, weightUnit: 'kg', vatAssumed: true } });
    expect(readPdfPreview(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it('eski kayıt (alan yok) ve bozuk alan: read yok sayılır (içe aktarma %20 ile denetler, not yazmaz)', () => {
    expect(readPdfPreview({ v: 1, skipped: [] })).toEqual({ v: 1, skipped: [] });
    for (const read of [{ vatPct: '20', weightUnit: 'kg' }, { vatPct: 20, weightUnit: 'oz' }, { vatPct: 120, weightUnit: 'kg' }, 'x', null]) {
      expect(readPdfPreview({ v: 1, read })?.read, JSON.stringify(read)).toBeUndefined();
    }
    expect(readPdfPreview({ v: 1, read: { vatPct: 18, weightUnit: 'lb', vatAssumed: 'yes' } })?.read).toEqual({ vatPct: 18, weightUnit: 'lb' });
  });
});

describe('Y20: sayfa gruplarının birleştirilmesi', () => {
  const part = (pages: number[], o: Partial<PdfPartResult['data']> = {}): PdfPartResult => ({
    pages,
    data: { invoiceNo: null, invoiceDate: null, currency: null, amountsIncludeVat: null, lines: [], ...o },
  });

  it('oran: okunan değer bütün gruplara; çelişirse 1. sayfanın oranı ve tutarlar KDV dahilse "KDV belirsiz"', () => {
    const one = mergePdfParts([part([1], { amountsIncludeVat: true, vatPct: 18, lines: [aiLine('A', 1)] }), part([2], { lines: [aiLine('B', 2)] })]);
    expect(one.data).toMatchObject({ vatPct: 18, amountsIncludeVat: true });
    expect(one.review.vatUnclear).toBe(false);
    const clash = mergePdfParts([part([1], { amountsIncludeVat: true, vatPct: 20 }), part([2], { amountsIncludeVat: true, vatPct: 10 })]);
    expect(clash.data.vatPct).toBe(20);
    expect(clash.review.vatUnclear).toBe(true);
    // KDV hariç tutarda oran sonucu değiştirmez: belirsiz sayılmaz
    expect(mergePdfParts([part([1], { amountsIncludeVat: false, vatPct: 20 }), part([2], { amountsIncludeVat: false, vatPct: 10 })]).review.vatUnclear).toBe(false);
    // hiçbir grup okumadıysa null (varsayılan %20 sonra uygulanır); eski kayıt alanı taşımaz
    expect(mergePdfParts([part([1], { amountsIncludeVat: false }), part([2])]).data.vatPct).toBeNull();
  });

  it('birim: tek okunan birim bütün gruplara; kg ile lb çelişirse lb grupların ağırlıkları kg\'a çevrilir', () => {
    const lb = mergePdfParts([part([1], { amountsIncludeVat: false, weightUnit: 'lb', lines: [aiLine('A', 1, { actualKg: 10 })] }), part([2], { lines: [aiLine('B', 2, { actualKg: 10 })] })]);
    expect(lb.data.weightUnit).toBe('lb');
    expect(pdfLinesToParsed(lb.data).map((l) => l.actualKg)).toEqual([4.536, 4.536]);
    const mixed = mergePdfParts([
      part([1], { amountsIncludeVat: false, weightUnit: 'kg', lines: [aiLine('A', 1, { actualKg: 10 })] }),
      part([2], { weightUnit: 'lb', lines: [aiLine('B', 2, { actualKg: 10, billedKg: 20 })] }),
    ]);
    expect(mixed.data.weightUnit).toBe('kg');
    expect(pdfLinesToParsed(mixed.data).map((l) => [l.actualKg, l.billedKg])).toEqual([[10, undefined], [4.536, 9.072]]);
    expect(mergePdfParts([part([1], { amountsIncludeVat: false }), part([2])]).data.weightUnit).toBeNull();
  });
});

describe('Y31: findPdfMissedLines', () => {
  it('metin yoksa ya da o an okunamadıysa boş; fatura no aday değil', () => {
    expect(findPdfMissedLines(null, [{ trackingNo: '794812345305' }])).toEqual({ count: 0, trackings: [] });
    expect(findPdfMissedLines([], [{ trackingNo: '794812345305' }])).toEqual({ count: 0, trackings: [] });
    const text = ['794812345305 10,00', '794812345306 12,00', '794800000001 12,00'].join('\n');
    expect(findPdfMissedLines([text], [{ trackingNo: '794812345305' }], '7948-0000-0001')).toEqual({ count: 1, trackings: ['794812345306'] });
  });
});

describe('Y20 incelemesi: çift çevirme, g, ölçü birimi', () => {
  it('lb okundu: metinde lb değeri varsa çevrilir, model zaten kg yazmışsa çevrilmez (satır sayısı notta)', () => {
    const ai = invoice([aiLine('794812345305', 10, { actualKg: 10 }), aiLine('794812345306', 10, { actualKg: 2.27 })], { weightUnit: 'lb' });
    const r = parsePdfLines(ai, { pageTexts: ['794812345305 10 lb 10,00', '794812345306 5 lb 10,00'] });
    expect(r.lines.map((l) => l.actualKg)).toEqual([4.536, 2.27]);
    expect(r.weightKeptLines).toBe(1);
    // metin verilmezse (ya da taranmış) bugünkü gibi çevrilir
    expect(parsePdfLines(ai).lines.map((l) => l.actualKg)).toEqual([4.536, 1.03]);
  });

  it('g → kg (÷ 1000, 3 ondalık)', () => {
    expect(pdfLinesToParsed(invoice([aiLine('794812345305', 10, { actualKg: 2500, billedKg: 1234 })], { weightUnit: 'gr' }))[0]).toMatchObject({ actualKg: 2.5, billedKg: 1.234 });
  });

  it('ölçü: in → cm (× 2,54, 2 ondalık); cm ve okunmadıysa değişmez; tanınmayan birimde ölçü kullanılmaz', () => {
    const box = aiLine('794812345305', 10, { dimL: 10, dimW: 7.5, dimH: 3 });
    expect(pdfLinesToParsed(invoice([box], { dimUnit: 'inch' }))[0]!.dims).toEqual({ l: 25.4, w: 19.05, h: 7.62 });
    expect(pdfLinesToParsed(invoice([box], { dimUnit: 'cm' }))[0]!.dims).toEqual({ l: 10, w: 7.5, h: 3 });
    expect(pdfLinesToParsed(invoice([box]))[0]!.dims).toEqual({ l: 10, w: 7.5, h: 3 });
    expect(pdfLinesToParsed(invoice([box], { dimUnit: 'mm' }))[0]!.dims).toBeUndefined();
    expect(pdfReadUnits(invoice([box]))).toMatchObject({ dimAssumed: true, dimUnit: 'cm' });
  });

  it('kayıt notu: birimler ve kontrol sonuçları', async () => {
    const { pdfReadNoteOf } = await import('../src/services/invoicePdfCheck.ts');
    const r = parsePdfLines(invoice([aiLine('794812345305', 120, { actualKg: 10, dimL: 1, dimW: 1, dimH: 1 })], { amountsIncludeVat: true, vatPct: 10, weightUnit: 'lb', dimUnit: 'in' }));
    expect(pdfReadNoteOf(r, { vatUnverified: true })).toEqual({ vatPct: 10, weightUnit: 'lb', dimUnit: 'in', vatUnverified: true });
  });

  it('sayfa grupları: ölçü birimi çelişirse inç grubun ölçüleri birleştirmede cm\'ye çevrilir, unitsMixed', () => {
    const part = (pages: number[], o: Partial<PdfPartResult['data']> = {}): PdfPartResult => ({
      pages,
      data: { invoiceNo: null, invoiceDate: null, currency: null, amountsIncludeVat: false, lines: [], ...o },
    });
    const m = mergePdfParts([
      part([1], { dimUnit: 'cm', lines: [aiLine('A', 1, { dimL: 10, dimW: 10, dimH: 10 })] }),
      part([2], { dimUnit: 'in', lines: [aiLine('B', 2, { dimL: 10, dimW: 10, dimH: 10 })] }),
    ]);
    expect(m.data.dimUnit).toBe('cm');
    expect(m.review.unitsMixed).toBe(true);
    expect(pdfLinesToParsed(m.data).map((l) => l.dims)).toEqual([{ l: 10, w: 10, h: 10 }, { l: 25.4, w: 25.4, h: 25.4 }]);
    expect(mergePdfParts([part([1], { dimUnit: 'in' }), part([2])]).review.unitsMixed).toBeUndefined();
  });
});
