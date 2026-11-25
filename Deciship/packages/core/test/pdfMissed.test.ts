/**
 * Y31: yapay zekânın PDF faturada atladığı satırların izi (`pdfMissedTrackings`) ve Y20: KDV oranı / ağırlık birimi
 * (`resolvePdfReadUnits`). Saf işlevler; sahte olumluya karşı kurallar `src/invoice/pdfMissed.ts` başında.
 */
import { describe, expect, it } from 'vitest';
import {
  buildImportReport,
  INCH_TO_CM,
  LB_TO_KG,
  PDF_DEFAULT_VAT_PCT,
  PDF_MISSED_MAX_LIST,
  PDF_MISSED_MAX_TEXT_CHARS,
  pdfDimUnitOf,
  pdfLbAlreadyKg,
  pdfMissedTrackings,
  pdfReadNote,
  pdfReadNoteWorthy,
  pdfTextHasAmount,
  pdfTextNumbers,
  pdfVatPctOf,
  pdfVatRateCheck,
  pdfVatRatesInText,
  pdfWeightUnitOf,
  readPdfReadNote,
  resolvePdfReadUnits,
} from '../src/index';

const read = (...t: string[]) => t.map((trackingNo) => ({ trackingNo }));
const missed = (text: string | string[], r: { trackingNo: string; reference?: string | null }[], exclude?: string[]) =>
  pdfMissedTrackings(Array.isArray(text) ? text : [text], r, exclude ? { exclude } : {});

/** Tipik yurt dışı fatura sayfası: başlık, tablo, altbilgi. */
const HEADER = [
  'FedEx Express Kargo A.Ş.',
  'Fatura No: 948211735 Fatura Tarihi: 27.10.2026',
  'Vergi Dairesi: Büyük Mükellefler VKN: 3880012345',
  'Tel: 0212 444 0505 Müşteri No: 794800001111',
  'Takip No Tarih Ülke Ağırlık Tutar',
];
const ROWS = ['794812345305 20.10.2026 DE 2,5 1.642,50', '794812345306 21.10.2026 FR 1,0 250,00', '794812345307 22.10.2026 US 4,0 100,00'];
const FOOTER = ['Ara Toplam 1.992,50', 'KDV %20 398,50', 'Genel Toplam 2.391,00', 'IBAN: TR12 0006 4000 0011 2345 6789 01', 'Sayfa 1 / 1'];
const PAGE = [...HEADER, ...ROWS, ...FOOTER].join('\n');

describe('pdfMissedTrackings: atlanan satır yakalanır', () => {
  it('ortadaki satır okunmamış: o takip no raporlanır', () => {
    expect(missed(PAGE, read('794812345305', '794812345307'))).toEqual({ count: 1, trackings: ['794812345306'] });
  });

  it('ilk ve son satır da yakalanır; hepsi okunduysa boş', () => {
    expect(missed(PAGE, read('794812345306')).trackings).toEqual(['794812345305', '794812345307']);
    expect(missed(PAGE, read('794812345305', '794812345306', '794812345307'))).toEqual({ count: 0, trackings: [] });
  });

  it('çok sayfa: başka sayfadaki atlanan satır da bulunur, sıra metin sırası', () => {
    const p2 = ['794812345401 23.10.2026 IT 1,0 80,00', '794812345402 23.10.2026 IT 1,0 81,00'].join('\n');
    expect(missed([PAGE, p2], read('794812345305', '794812345306', '794812345307', '794812345402')).trackings).toEqual(['794812345401']);
  });

  it('boşlukla bölünmüş yazım: okunanlar "7948 1234 5305" biçimindeyse aynı biçimli aday da', () => {
    const text = ['7948 1234 5305 20.10.2026 1.642,50', '7948 1234 5306 21.10.2026 250,00', '7948 1234 5307 22.10.2026 100,00'].join('\n');
    expect(missed(text, read('794812345305', '794812345307')).trackings).toEqual(['794812345306']);
  });

  it('harfli takip no (UPS "1Z…"): aynı rakam/harf deseni', () => {
    const text = ['1Z999AA10123456784 Standard 12,40', '1Z999AA10123456785 Standard 13,40', '1Z999AA10123456786 Express 99,90'].join('\n');
    expect(missed(text, read('1Z999AA10123456784', '1Z999AA10123456786')).trackings).toEqual(['1Z999AA10123456785']);
  });

  it('hücreleri ayrı metin satırlarına düşen tablo: tutar en çok 3 satır sonra', () => {
    const text = ['794812345305', '20.10.2026', '1.642,50', '794812345306', '21.10.2026', '250,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual(['794812345306']);
  });

  it('"Takip:7948…" gibi iki noktayla bitişik yazım da parça sayılır', () => {
    const text = ['Takip:794812345305 1.642,50', 'Takip:794812345306 250,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual(['794812345306']);
  });

  it('sayı tamdır, liste en çok 200', () => {
    const rows = Array.from({ length: 260 }, (_, i) => `7948${String(10000000 + i)} 20.10.2026 ${i + 1},00`);
    const r = missed(rows.join('\n'), read(rows[0]!.split(' ')[0]!));
    expect(r.count).toBe(259);
    expect(r.trackings).toHaveLength(PDF_MISSED_MAX_LIST);
    expect(r.trackings[0]).toBe('794810000001');
  });
});

describe('pdfMissedTrackings: sahte olumlu yok', () => {
  it('fatura no, VKN, telefon, müşteri no, IBAN, tutar ve tarih aday değil', () => {
    // müşteri no 12 haneli ve 7948 ile başlıyor (takip no biçiminde) ama önünde etiket var; satırında tutar da yok
    expect(missed(PAGE, read('794812345305', '794812345306', '794812345307'))).toEqual({ count: 0, trackings: [] });
  });

  it('etiketli numara, satırında tutar olsa da aday değil (VKN, fatura no, sipariş, referans, telefon)', () => {
    const text = [
      '794812345305 1.642,50',
      'VKN: 794800000001 Toplam 1.642,50',
      'Fatura No 794800000002 100,00',
      'Sipariş No: 794800000003 12,00',
      'Referans 794800000004 12,00',
      'Tel 794800000005 12,00',
      'T.C. Kimlik No 79480000000 12,00',
    ].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('tutar ve tarih yazımları (nokta/virgüllü) parça değil', () => {
    // 12 haneli tutar "7.948.123.453,06" ve tarih biçimli sayı takip no'ya dönüşmez
    const text = ['794812345305 1.642,50', 'Devreden 7.948.123.453,06', '7948.1234.5306 12,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('okunan satırın aynı metin satırındaki başka numara (referans sütunu) aday değil', () => {
    const text = ['794812345305 794800009999 1.642,50', '794812345306 794800009998 250,00'].join('\n');
    expect(missed(text, read('794812345305', '794812345306')).trackings).toEqual([]);
  });

  it('okunan satırın tutarından önce alt satıra düşen sütun (sarılmış referans) aday değil', () => {
    const text = ['794812345305', '794800009999', '20.10.2026', '1.642,50', '794812345306', '794800009998', '250,00'].join('\n');
    expect(missed(text, read('794812345305', '794812345306')).trackings).toEqual([]);
  });

  it('yapay zekânın referans olarak okuduğu değer ve fatura no (exclude) aday değil', () => {
    const text = ['794812345305 1.642,50', 'Sipariş özeti', '794800009999 250,00', '794800001234 12,00'].join('\n');
    expect(missed(text, [{ trackingNo: '794812345305', reference: '7948-0000-9999' }], ['794800001234']).trackings).toEqual([]);
  });

  it('tutarı olmayan satır (başlık, adres, özet listesi) aday değil', () => {
    const text = ['794812345305 1.642,50', 'Gönderici 794800007777 İstanbul', 'Not', 'Açıklama', 'Son'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('biçimi farklı sayılar: 10 haneli VKN / telefon, 11 haneli TCKN, 13 haneli sayı 12 haneli takip no ile karışmaz', () => {
    const text = ['794812345305 1.642,50', '3880012345 12,00', '05321234567 12,00', '12345678901 12,00', '7948123453061 12,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('IBAN ve uzun hesap no: aynı uzunlukta komşu gruplar daha büyük sayının parçası', () => {
    const text = ['7948 1234 5305 1.642,50', 'Ödeme TR12 0006 4000 0011 2345 6789 01 12,00', 'Hesap 0006 4000 0011 2345 12,00', '1111 2222 3333 4444 5555 12,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('okunan takip no ile aynı ya da soneki/uzantısı (FedEx 34 haneli barkod) aday değil', () => {
    const fedexLong = `9622001900000000000000${'794812345305'}`; // 34 hane, son 12'si takip no
    const text = ['794812345305 1.642,50', `${fedexLong} 1.642,50`, '7948-1234-5305 1.642,50'].join('\n');
    expect(fedexLong).toHaveLength(34);
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('okunan hiçbir takip no metinde yoksa (taranmış, yanlış okuma) ya da metin boşsa aday aranmaz', () => {
    expect(missed(PAGE, read('111122223333'))).toEqual({ count: 0, trackings: [] });
    expect(missed('', read('794812345305'))).toEqual({ count: 0, trackings: [] });
    expect(missed([], read('794812345305'))).toEqual({ count: 0, trackings: [] });
    expect(missed(PAGE, [])).toEqual({ count: 0, trackings: [] });
  });

  it('8 karakterden kısa takip no\'lardan biçim öğrenilmez', () => {
    const text = ['AB12345 10,00', 'AB12346 11,00'].join('\n');
    expect(missed(text, read('AB12345')).trackings).toEqual([]);
  });

  it('satır sonu olmayan metin (bütün sayfa tek satır): okunan satırla aynı satırda kalır, raporlanmaz', () => {
    expect(missed(ROWS.join(' '), read('794812345305')).trackings).toEqual([]);
  });

  it('aynı takip no iki kez geçerse bir kez sayılır', () => {
    const text = ['794812345305 1.642,50', '794812345306 250,00', '794812345306 250,00'].join('\n');
    expect(missed(text, read('794812345305'))).toEqual({ count: 1, trackings: ['794812345306'] });
  });
});

describe('pdfMissedTrackings: büyük metin', () => {
  // Süre sınırı (maliyet doğrusal) kapı dışında: pdfMissed.perf.test.ts (`npm run test:perf`).
  it('5.000 satırlık metin (1 atlanmış): yalnız atlanan bulunur', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `${7948_0000_0000 + i} 20.10.2026 DE 1,0 ${(i % 900) + 10},50 Ref ${1000000 + i}`);
    const reads = rows.map((r) => r.split(' ')[0]!).filter((_, i) => i !== 2500);
    const r = missed(rows.join('\n'), read(...reads));
    expect(r.trackings).toEqual([String(7948_0000_0000 + 2500)]);
  });
});

describe('pdfTextHasAmount', () => {
  it('yalnız sıfırdan büyük iki ondalıklı tutar', () => {
    expect(pdfTextHasAmount('Tutar 1.642,50')).toBe(true);
    expect(pdfTextHasAmount('12.50 USD')).toBe(true);
    expect(pdfTextHasAmount('0,00')).toBe(false);
    expect(pdfTextHasAmount('20.10.2026 12 desi 1,5')).toBe(false);
  });
});

describe('Y20: resolvePdfReadUnits', () => {
  it('okunan oran ve birim kullanılır; varsayım yok', () => {
    expect(resolvePdfReadUnits({ vatPct: 18, weightUnit: 'lb', dimUnit: 'in', amountsIncludeVat: true, hasWeights: true, hasDims: true })).toEqual({
      vatPct: 18,
      vatAssumed: false,
      weightUnit: 'lb',
      weightAssumed: false,
      weightUnusable: false,
      weightFactor: LB_TO_KG,
      dimUnit: 'in',
      dimAssumed: false,
      dimUnusable: false,
      dimFactor: INCH_TO_CM,
    });
    expect(resolvePdfReadUnits({ vatPct: 0, weightUnit: 'KG', amountsIncludeVat: true, hasWeights: true })).toMatchObject({ vatPct: 0, vatAssumed: false, weightUnit: 'kg', weightFactor: 1 });
  });

  it('okunamadıysa bugünkü varsayılan (KDV %20, kg); not yalnız sonucu etkiliyorsa', () => {
    // tutarlar KDV dahil: oran sonucu etkiler → varsayım notu
    expect(resolvePdfReadUnits({ vatPct: null, weightUnit: null, amountsIncludeVat: true, hasWeights: true, hasDims: true })).toEqual({
      vatPct: PDF_DEFAULT_VAT_PCT,
      vatAssumed: true,
      weightUnit: 'kg',
      weightAssumed: true,
      weightUnusable: false,
      weightFactor: 1,
      dimUnit: 'cm',
      dimAssumed: true,
      dimUnusable: false,
      dimFactor: 1,
    });
    // KDV hariç tutarlar ve ağırlıksız satırlar: oran ve birim önemsiz, not yok
    expect(resolvePdfReadUnits({ amountsIncludeVat: false, hasWeights: false })).toMatchObject({ vatPct: 20, vatAssumed: false, weightUnit: 'kg', weightAssumed: false });
  });

  it('eski önbellek / eski yanıt: alanlar hiç yoksa da okunur (varsayılan)', () => {
    expect(resolvePdfReadUnits({ amountsIncludeVat: true, hasWeights: true })).toMatchObject({ vatPct: 20, vatAssumed: true, weightUnit: 'kg', weightAssumed: true });
  });

  it('geçersiz oran okunmamış sayılır (kesir yazımı, aralık dışı, sayı değil)', () => {
    for (const v of [0.2, -1, 51, 120, Number.NaN, Number.POSITIVE_INFINITY]) expect(pdfVatPctOf(v), String(v)).toBeNull();
    expect(pdfVatPctOf(20)).toBe(20);
    expect(pdfVatPctOf(1)).toBe(1);
    expect(pdfVatPctOf(18.25)).toBe(18.25);
  });

  it('birim yazımları: lb/lbs/pound → lb; kg/kgs/kilo/desi → kg; g/gr → g; tanınmayan → other; boş → okunmamış', () => {
    for (const u of ['lb', 'LBS', 'Pounds', ' lb. ']) expect(pdfWeightUnitOf(u), u).toBe('lb');
    for (const u of ['kg', 'KGS', 'kilo', 'Kilogram', 'desi', 'Desi']) expect(pdfWeightUnitOf(u), u).toBe('kg');
    for (const u of ['g', 'gr', 'GRAM', 'grams']) expect(pdfWeightUnitOf(u), u).toBe('g');
    for (const u of ['oz', 'ton', 'stone']) expect(pdfWeightUnitOf(u), u).toBe('other');
    for (const u of ['', '  ', null, undefined]) expect(pdfWeightUnitOf(u), String(u)).toBeNull();
    for (const u of ['in', 'inch', 'Inches', 'inç']) expect(pdfDimUnitOf(u), u).toBe('in');
    for (const u of ['cm', 'CM', 'santim']) expect(pdfDimUnitOf(u), u).toBe('cm');
    for (const u of ['mm', 'm', 'ft']) expect(pdfDimUnitOf(u), u).toBe('other');
    expect(pdfDimUnitOf(null)).toBeNull();
  });

  it('g → ÷1000; oz ve tanınmayan birim kullanılmaz (sessizce kg sayılmaz); ölçüde mm kullanılmaz', () => {
    expect(resolvePdfReadUnits({ weightUnit: 'gr', amountsIncludeVat: false, hasWeights: true })).toMatchObject({ weightUnit: 'g', weightFactor: 0.001, weightUnusable: false, weightAssumed: false });
    expect(resolvePdfReadUnits({ weightUnit: 'oz', amountsIncludeVat: false, hasWeights: true })).toMatchObject({ weightUnusable: true, weightAssumed: false });
    expect(resolvePdfReadUnits({ weightUnit: 'oz', amountsIncludeVat: false, hasWeights: false }).weightUnusable).toBe(false);
    expect(resolvePdfReadUnits({ dimUnit: 'mm', amountsIncludeVat: false, hasWeights: false, hasDims: true })).toMatchObject({ dimUnusable: true, dimAssumed: false, dimFactor: 1 });
  });
});

describe('Y20/Y31: içe aktarma raporu', () => {
  const base = { source: 'pdf' as const, rowsInFile: 2, linesImported: 2, errors: [], skipped: [] };

  it('okunmamış olabilecek takip no\'lar ayrı alanda; alınmayan satır sayısına girmez', () => {
    const rep = buildImportReport({ ...base, pdfMissed: { count: 2, trackings: ['794812345306', '794812345307'] } });
    expect(rep.pdfMissed).toEqual({ count: 2, trackings: ['794812345306', '794812345307'] });
    expect(rep.skippedCount).toBe(0);
    expect(buildImportReport({ ...base, pdfMissed: { count: 0, trackings: [] } }).pdfMissed).toBeUndefined();
  });

  it('varsayım notu yalnız söylenecek bir şey varsa', () => {
    expect(buildImportReport({ ...base, pdfRead: { vatPct: 20, weightUnit: 'kg', vatAssumed: false, weightAssumed: false } }).pdfRead).toBeUndefined();
    expect(buildImportReport({ ...base, pdfRead: { vatPct: 20, weightUnit: 'kg', vatAssumed: true, weightAssumed: false } }).pdfRead).toEqual({ vatPct: 20, weightUnit: 'kg', vatAssumed: true });
    expect(buildImportReport({ ...base, pdfRead: { vatPct: 18, weightUnit: 'lb' } }).pdfRead).toEqual({ vatPct: 18, weightUnit: 'lb' });
    expect(buildImportReport({ ...base, pdfRead: { vatPct: 20, weightUnit: 'kg', weightAssumed: true } }).pdfRead).toEqual({ vatPct: 20, weightUnit: 'kg', weightAssumed: true });
  });
});

describe('İnceleme 1: KDV oranı PDF metninde doğrulanır', () => {
  const chk = (text: string | null, vatPct: number, o: { assumed?: boolean; incl?: boolean } = {}) =>
    pdfVatRateCheck(text == null ? null : [text], { vatPct, assumed: o.assumed ?? false, amountsIncludeVat: o.incl ?? true });

  it('yazımlar: "%20", "% 20", "20%", "KDV 20", "KDV (%18)", "K.D.V. %18", "KDV Oranı: %10", "VAT 20%", "%8 KDV"', () => {
    expect([...pdfVatRatesInText(['KDV %20']).vat]).toEqual([20]);
    expect([...pdfVatRatesInText(['Toplam KDV 20']).vat]).toEqual([20]);
    expect([...pdfVatRatesInText(['KDV (%18) 180,00']).vat]).toEqual([18]);
    expect([...pdfVatRatesInText(['K.D.V. %18']).vat]).toEqual([18]);
    expect([...pdfVatRatesInText(['KDV Oranı: %10']).vat]).toEqual([10]);
    expect([...pdfVatRatesInText(['KDV ORANI %10']).vat]).toEqual([10]);
    expect([...pdfVatRatesInText(['VAT 20%']).vat]).toEqual([20]);
    expect([...pdfVatRatesInText(['VAT rate: 20 %']).vat]).toEqual([20]);
    expect([...pdfVatRatesInText(['%8 KDV']).vat]).toEqual([8]);
    expect([...pdfVatRatesInText(['Yakıt % 25']).percents]).toEqual([25]);
    expect([...pdfVatRatesInText(['20% indirim']).percents]).toEqual([20]);
  });

  it('tutar ve tarih oran sayılmaz ("KDV 398,50", "KDV Tutarı 1.234,56", "KDV 20.10.2026")', () => {
    expect(pdfVatRatesInText(['KDV 398,50', 'KDV Tutarı 1.234,56', 'KDV 1.234,56', 'KDV 20.10.2026']).vat.size).toBe(0);
  });

  it('oran 10 okundu, metinde "KDV %20": güvenilmez (satırlar KDV belirsiz)', () => {
    expect(chk('FATURA KDV %20 1.200,00', 10)).toEqual({ trusted: false, reason: 'contradicted' });
    // "%10 indirim" KDV bağlamındaki %20'yi geçersiz kılmaz
    expect(chk('İndirim %10\nKDV %20', 10)).toEqual({ trusted: false, reason: 'contradicted' });
    expect(chk('FATURA KDV %20 1.200,00', 20)).toEqual({ trusted: true });
  });

  it('okunan oran metinde hiç yoksa güvenilmez; bağlamsız yüzde de doğrular', () => {
    expect(chk('794812345305 1.200,00', 20)).toEqual({ trusted: false, reason: 'notInText' });
    expect(chk('Oran %18 · 794812345305 1.180,00', 18)).toEqual({ trusted: true });
  });

  it('olağan dışı oran (ör. 25) metinde yazsa da güvenilmez; metin yoksa olağan oran güvenilir', () => {
    expect(chk('KDV %25', 25)).toEqual({ trusted: false, reason: 'unusual' });
    expect(chk(null, 25)).toEqual({ trusted: false, reason: 'unusual' });
    expect(chk(null, 10)).toEqual({ trusted: true });
    expect(chk('   ', 10)).toEqual({ trusted: true });
  });

  it('varsayılan %20 (okunmadı): yalnız metin KDV bağlamında başka oran söylüyorsa güvenilmez', () => {
    expect(chk('794812345305 1.200,00', 20, { assumed: true })).toEqual({ trusted: true });
    expect(chk('KDV %10', 20, { assumed: true })).toEqual({ trusted: false, reason: 'contradicted' });
    expect(chk('KDV %20', 20, { assumed: true })).toEqual({ trusted: true });
  });

  it('tutarlar KDV hariçse oran sonucu etkilemez: her zaman güvenilir', () => {
    expect(chk('KDV %20', 10, { incl: false })).toEqual({ trusted: true });
    expect(chk(null, 33, { incl: false })).toEqual({ trusted: true });
  });
});

describe('İnceleme 2: lb çift çevirme denetimi', () => {
  it('metindeki sayılar: TR ve EN yazımı, tarih alınmaz', () => {
    const n = pdfTextNumbers(['1.234,56 kg 4,54 20.10.2026', '1,234.56 10 lb']);
    expect(n).toContain(1234.56);
    expect(n).toContain(4.54);
    expect(n).toContain(10);
    expect(n).not.toContain(20.1);
  });

  it('lb okundu: değer metinde lb olarak yazıyorsa çevrilir; kg karşılığı (model çevirmiş) yazıyorsa çevrilmez', () => {
    const onlyLb = pdfTextNumbers(['794812345305 10 lb 100,00']);
    expect(pdfLbAlreadyKg(onlyLb, 10)).toBe(false); // ham lb değeri: çevrilir
    expect(pdfLbAlreadyKg(onlyLb, 4.54)).toBe(true); // model zaten 10 lb → 4,54 kg yaptı: ikinci kez çevrilmez
    expect(pdfLbAlreadyKg(onlyLb, 4.536)).toBe(true);
    const both = pdfTextNumbers(['794812345305 10 lb 4,54 kg 100,00']);
    expect(pdfLbAlreadyKg(both, 10)).toBe(false); // lb değeri verildi, kg karşılığı da metinde: çevrilir
    expect(pdfLbAlreadyKg(both, 4.54)).toBe(true);
    // metin yok ya da iki karşılık da yok: bugünkü gibi çevrilir
    expect(pdfLbAlreadyKg([], 4.54)).toBe(false);
    expect(pdfLbAlreadyKg(pdfTextNumbers(['794812345305 100,00']), 7)).toBe(false);
  });
});

describe('İnceleme: okuma notu (kayıt ve rapor)', () => {
  it('yalnız true bayraklar ve 0\'dan büyük sayı yazılır; söylenecek bir şey yoksa rapora girmez', () => {
    expect(pdfReadNote({ vatPct: 20, weightUnit: 'kg', dimUnit: 'cm', vatAssumed: false, weightKeptLines: 0 })).toEqual({ vatPct: 20, weightUnit: 'kg', dimUnit: 'cm' });
    expect(pdfReadNoteWorthy({ vatPct: 20, weightUnit: 'kg', dimUnit: 'cm' })).toBe(false);
    for (const n of [
      { vatPct: 20, weightUnit: 'kg' as const, vatUnverified: true as const },
      { vatPct: 20, weightUnit: 'g' as const },
      { vatPct: 20, weightUnit: 'kg' as const, dimUnit: 'in' as const },
      { vatPct: 20, weightUnit: 'lb' as const, weightKeptLines: 2 },
      { vatPct: 20, weightUnit: 'kg' as const, unitsMixed: true as const },
    ]) expect(pdfReadNoteWorthy(n), JSON.stringify(n)).toBe(true);
  });

  it('kayıttan okuma: eski biçim (dimUnit yok) okunur, bozuk alan reddedilir', () => {
    expect(readPdfReadNote({ vatPct: 20, weightUnit: 'kg', vatAssumed: true })).toEqual({ vatPct: 20, weightUnit: 'kg', vatAssumed: true });
    expect(readPdfReadNote({ vatPct: 18, weightUnit: 'lb', dimUnit: 'in', weightKeptLines: 3, vatUnverified: 'yes' })).toEqual({ vatPct: 18, weightUnit: 'lb', dimUnit: 'in', weightKeptLines: 3 });
    for (const raw of [null, 'x', [], { vatPct: '20', weightUnit: 'kg' }, { vatPct: 20, weightUnit: 'oz' }, { vatPct: 20, weightUnit: 'kg', dimUnit: 'mm' }, { vatPct: 99, weightUnit: 'kg' }]) {
      expect(readPdfReadNote(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('rapor: tooLarge notu sayı olmadan yazılır', () => {
    const rep = buildImportReport({ source: 'pdf', rowsInFile: 1, linesImported: 1, errors: [], skipped: [], pdfMissed: { count: 0, trackings: [], tooLarge: true } });
    expect(rep.pdfMissed).toEqual({ count: 0, trackings: [], tooLarge: true });
    const rd = buildImportReport({ source: 'pdf', rowsInFile: 1, linesImported: 1, errors: [], skipped: [], pdfRead: { vatPct: 10, weightUnit: 'kg', dimUnit: 'cm', vatUnverified: true } });
    expect(rd.pdfRead).toEqual({ vatPct: 10, weightUnit: 'kg', dimUnit: 'cm', vatUnverified: true });
  });
});

describe('İnceleme 4–5: Y31 sınır ve sahte uyarılar', () => {
  it('metin sınırın üstündeyse tarama yapılmaz (tooLarge), sınırın altında yapılır', () => {
    const row = '794812345305 20.10.2026 1.642,50\n';
    const big = row.repeat(Math.ceil(PDF_MISSED_MAX_TEXT_CHARS / row.length) + 1) + '794812345306 250,00';
    expect(pdfMissedTrackings([big], read('794812345305'))).toEqual({ count: 0, trackings: [], tooLarge: true });
    expect(missed(['794812345305 1.642,50', '794812345306 250,00'].join('\n'), read('794812345305')).tooLarge).toBeUndefined();
  });

  it('etiket üç sözcük geride: "Vergi Dairesi Kadıköy 123456789012 1.790,44" aday değil', () => {
    const text = ['794812345305 1.642,50', 'Vergi Dairesi Kadıköy 123456789012 1.790,44'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('toplam satırı: "Ara Toplam 600123456789 1.790,44", "600123456789 Genel Toplam 12,00" aday değil', () => {
    const text = ['794812345305 1.642,50', 'Ara Toplam 600123456789 1.790,44', '600123456780 Genel Toplam 12,00', 'TOTAL 600123456781 5,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });

  it('etiketsiz Türkiye telefonu ("902125551234", "05321234567") aday değil; okunanlar bu biçimdeyse aday', () => {
    const text = ['794812345305 1.642,50', '902125551234 12,00', '905321234567 12,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
    const elevenDigit = ['79481234530 1.642,50', '05321234567 12,00'].join('\n');
    expect(missed(elevenDigit, read('79481234530')).trackings).toEqual([]);
    // takip no'lar 90'la başlayan 12 hane ise (taşıyıcının biçimi) aynı biçimli aday raporlanır
    const ninety = ['902100000001 10,00', '902100000002 11,00'].join('\n');
    expect(missed(ninety, read('902100000001')).trackings).toEqual(['902100000002']);
  });

  it('bilinen sınır: satır sonunda bölünmüş takip no yakalanmaz (sessiz)', () => {
    const text = ['794812345305 1.642,50', '7948123', '45306 250,00'].join('\n');
    expect(missed(text, read('794812345305')).trackings).toEqual([]);
  });
});
