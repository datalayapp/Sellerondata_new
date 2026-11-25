/**
 * PDF fatura okumasının incelemesi (2026-11-13), veritabanısız: 05-B10 (tarife ek ücret kodları istemde ve okumadan sonra
 * kodların tarifeye hizalanması), 01-B8 (PDF içe aktarmada para birimi kapısı), iş tekilliğinde taşıyıcı.
 */
import { describe, expect, it } from 'vitest';
import { alignPdfSurchargeCodes, alignPdfSurchargeCodesReport, pdfKnownSurchargeList, PDF_KNOWN_SURCHARGES_MAX } from '../src/services/ai.ts';
import { knownPdfVatPct, pdfCurrencyGate, pdfPreviewValue, pdfReviewFlags, readPdfPreview } from '../src/services/invoicePdfCheck.ts';
import { invoicePdfDedupeKey } from '../src/services/jobs/handlers/invoicePdf.ts';

const sur = (code: string, name: string | null, amount = 10) => ({ code, name, amount });
const doc = (surcharges: ReturnType<typeof sur>[]) => ({ lines: [{ trackingNo: 'T1', surcharges }] });

describe('05-B10: tarife ek ücretleri', () => {
  it('liste: kod normalleştirilir, tekil, sıralı; ad tek satır ve tırnaksız (istem bozulmaz), sınırlı', () => {
    const l = pdfKnownSurchargeList([
      { code: 'uzak bölge', name: 'Uzak\nBölge "ek"' },
      { code: 'UZAK_BOLGE', name: 'ikinci' },
      { code: 'ADDRESS_CORRECTION', name: null },
      { code: '  ', name: 'boş' },
    ]);
    expect(l).toEqual([
      { code: 'ADDRESS_CORRECTION', name: null },
      { code: 'UZAK_BOLGE', name: 'Uzak Bölge ek' },
    ]);
    const many = Array.from({ length: PDF_KNOWN_SURCHARGES_MAX + 10 }, (_, i) => ({ code: `C${String(i).padStart(3, '0')}`, name: null }));
    expect(pdfKnownSurchargeList(many)).toHaveLength(PDF_KNOWN_SURCHARGES_MAX);
  });

  it('hizalama: modelin uydurduğu kod aynı gruptaysa ya da basılı ad tarifedeki adla aynıysa tarifenin kodu', () => {
    const known = pdfKnownSurchargeList([
      { code: 'UZAK_BOLGE', name: 'Uzak Bölge' },
      { code: 'MOBIL', name: 'Mobil Bölge Hizmeti' },
      { code: 'SMS_BILGI', name: 'SMS Bilgilendirme' },
    ]);
    const out = alignPdfSurchargeCodes(
      doc([
        sur('REMOTE_AREA_DELIVERY', 'Remote Area Delivery'), // aynı grup (REMOTE_AREA)
        sur('MOBILE_ZONE_SERVICE', 'Mobil Bölge Hizmeti'), // basılı ad = tarifedeki ad
        sur('SMS', 'SMS'), // tarifedeki adın grubu ("SMS Bilgilendirme" → SMS)
        sur('DUTY_TAX', 'Gümrük Vergisi'), // tarifede yok: model kodu kalır
      ]),
      known,
    );
    expect(out.lines[0]!.surcharges.map((s) => s.code)).toEqual(['UZAK_BOLGE', 'MOBIL', 'SMS_BILGI', 'DUTY_TAX']);
    // tutar ve ad değişmez
    expect(out.lines[0]!.surcharges[1]).toEqual({ code: 'MOBIL', name: 'Mobil Bölge Hizmeti', amount: 10 });
  });

  it('inceleme 2026-11-13: modelin tarife kodu basılı adla uyuşmuyorsa kabul edilmez; kod basılı addan türer (karşılaştırılmaz)', () => {
    // tarife ODA "Out of Delivery Area" 50,00; satırda ODA 50,00 ve "Out of Pickup Area" 40,00, model ikisine de ODA yazdı
    // → eskiden ikisi de ODA: 40,00 kesin ek ücret fazlası itiraz edilirdi
    const known = pdfKnownSurchargeList([{ code: 'ODA', name: 'Out of Delivery Area' }]);
    const out = alignPdfSurchargeCodes(doc([sur('ODA', 'Out of Delivery Area', 50), sur('ODA', 'Out of Pickup Area', 40)]), known);
    expect(out.lines[0]!.surcharges).toEqual([
      { code: 'ODA', name: 'Out of Delivery Area', amount: 50 },
      { code: 'OUT_OF_PICKUP_AREA', name: 'Out of Pickup Area', amount: 40 },
    ]);
    // basılı ad tarifenin koduyla ya da adının grubuyla aynıysa kabul
    const k2 = pdfKnownSurchargeList([{ code: 'UZAK_BOLGE', name: 'Uzak Bölge' }]);
    const ok = alignPdfSurchargeCodes(doc([sur('UZAK_BOLGE', 'UZAK BOLGE'), sur('UZAK_BOLGE', 'Remote Area Surcharge'), sur('UZAK_BOLGE', 'Kapıda Ödeme')]), k2);
    expect(ok.lines[0]!.surcharges.map((s) => s.code)).toEqual(['UZAK_BOLGE', 'UZAK_BOLGE', 'KAPIDA_ODEME']);
  });

  it('inceleme 2: modelin doğru kodu, basılı ad tarifedeki adın bütün sözcüklerini içeriyorsa kalır (uydurma kod yok)', () => {
    // eskiden: REMOTE_AREA "Uzak Bölge Teslimat Ücreti" → UZAK_BOLGE_TESLIMAT (tarifede yok: fazla karşılaştırılmıyordu,
    // katı ayarda tamamı kesin fark oluyordu)
    const known = pdfKnownSurchargeList([
      { code: 'REMOTE_AREA', name: 'Uzak bölge' },
      { code: 'YUK_ELLECLEME', name: 'Elleçleme' },
    ]);
    const d = doc([sur('REMOTE_AREA', 'Uzak Bölge Teslimat Ücreti', 111), sur('YUK_ELLECLEME', 'Ağır Yük Elleçleme Bedeli', 50), sur('REMOTE_AREA', 'Remote Area Delivery Surcharge', 5)]);
    const r = alignPdfSurchargeCodesReport(d, known);
    expect(r.data.lines[0]!.surcharges.map((s) => s.code)).toEqual(['REMOTE_AREA', 'YUK_ELLECLEME', 'REMOTE_AREA']);
    expect(r.unverifiedLines).toEqual([]);
  });

  it('inceleme 2: uyuşmayan kod basılı addan türer ve satır işaretlenir ("Kontrol edilecek")', () => {
    const known = pdfKnownSurchargeList([{ code: 'ODA', name: 'Out of Delivery Area' }]);
    const r = alignPdfSurchargeCodesReport(
      { lines: [{ trackingNo: 'T1', surcharges: [sur('ODA', 'Out of Delivery Area', 50)] }, { trackingNo: 'T2', surcharges: [sur('ODA', 'Out of Pickup Area', 40)] }] },
      known,
    );
    expect(r.data.lines.map((l) => l.surcharges.map((s) => s.code))).toEqual([['ODA'], ['OUT_OF_PICKUP_AREA']]);
    expect(r.unverifiedLines).toEqual([1]);
  });

  it('tarife yoksa ya da değişecek kod yoksa aynı nesne döner (önbellekteki ham çıktı değişmez)', () => {
    const d = doc([sur('X', null)]);
    expect(alignPdfSurchargeCodes(d, [])).toBe(d);
    expect(alignPdfSurchargeCodes(d, pdfKnownSurchargeList([{ code: 'X', name: null }]))).toBe(d);
  });

  it('iş tekilliği taşıyıcıya göre (istem taşıyıcının kodlarını taşır); taşıyıcısız eski anahtar aynı', () => {
    expect(invoicePdfDedupeKey('abc', 'tr', false)).toBe('pdf:abc:tr');
    expect(invoicePdfDedupeKey('abc', 'tr', false, 'c1')).not.toBe(invoicePdfDedupeKey('abc', 'tr', false, 'c2'));
    expect(invoicePdfDedupeKey('abc', 'en', true, 'c1')).toBe('pdf:abc:en:c:c1:fresh');
  });
});

describe('01-B8: PDF içe aktarmada para birimi kapısı', () => {
  const l = (rowIndex: number, currency?: string | null) => ({ rowIndex, trackingNo: `T${rowIndex}`, ...(currency !== undefined ? { currency } : {}) });

  it('yazım farkı ("TL", "₺", "tl") ve para birimi yazmayan satır sayılmaz: kapı yok', () => {
    expect(pdfCurrencyGate([l(0, 'TL'), l(1, '₺'), l(2, 'tl'), l(3), l(4, null)], 'TRY', 'tr')).toBeNull();
  });

  it('USD fatura, 2 EUR + 1 CHF satır: tablo yolunun metniyle sorun, sayılar ve örnekler', () => {
    const g = pdfCurrencyGate([l(0, 'USD'), l(1, 'EUR'), l(2, 'EUR'), l(3, 'CHF')], 'USD', 'tr')!;
    expect(g).toMatchObject({ verdict: 'check', flaggedRows: 3, flagCounts: { CURRENCY_MISMATCH: 3 } });
    expect(g.issues).toEqual(['3 satır faturanın para biriminde değil (2 EUR, 1 CHF; fatura USD). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.']);
    expect(g.examples.map((e) => e.rowIndex)).toEqual([1, 2, 3]);
    expect(pdfCurrencyGate([l(0, 'EUR')], 'USD', 'en')!.issues[0]).toContain('not in the invoice currency (1 EUR; invoice USD)');
  });

  it('bütün satırlar USD, fatura TRY seçildi: hepsi sayılır', () => {
    expect(pdfCurrencyGate([l(0, 'USD'), l(1, 'USD')], 'TRY', 'tr')!.flaggedRows).toBe(2);
  });
});

describe('İnceleme 2026-11-13: PDF faturanın KDV oranı yalnız metinde KDV sözcüğünün yanında yazıyorsa kabul edilir', () => {
  // USD ihracat faturası, KDV yok; model oranı %20 uydurdu, tutarlar KDV hariç → eskiden eşlemeye %20 yazılıyor,
  // itiraz metni "KDV dahil (%20)" diyordu
  const usd = ['INVOICE 4471  Currency: USD', '794812345305  FR  6.0  135.29', 'Total USD 135.29'];
  it('metinde KDV oranı yok: oran bilinmiyor (null)', () => {
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: usd })).toBeNull();
  });
  it('yalnız bağlamsız yüzde (indirim %20) yetmez', () => {
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: [...usd, 'Discount %20'] })).toBeNull();
  });
  it('metinde "KDV %20" ya da "VAT 18%": oran kabul', () => {
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: ['Ara toplam 100,00', 'KDV %20  20,00'] })).toBe(20);
    expect(knownPdfVatPct({ rawVatPct: 18, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: ['VAT 18%  18.00'] })).toBe(18);
    // metin başka oran söylüyor: okunan kabul edilmez
    expect(knownPdfVatPct({ rawVatPct: 18, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: ['KDV %20'] })).toBeNull();
  });
  it('metin yok (taranmış): basılı oran doğrulanamaz; tutarlar KDV dahil okunduysa nete çevirmedeki oran', () => {
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts: null })).toBeNull();
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: true, usedVatPct: 20, vatUnclear: false, pageTexts: null })).toBe(20);
  });
});

describe('İnceleme 2: kodu doğrulanamayan ek ücretli satır içe aktarmada işaretlenir', () => {
  it('önizleme kaydı takip no\'ları taşır; içe aktarma o satırlara PDF_SURCHARGE_UNVERIFIED koyar', () => {
    const saved = readPdfPreview(pdfPreviewValue({ review: { surchargeCode: ['T2'] } }));
    expect(saved?.review).toEqual({ surchargeCode: ['T2'] });
    const flags = pdfReviewFlags(saved?.review, [{ rowIndex: 0, trackingNo: 'T1' }, { rowIndex: 1, trackingNo: ' t2 ' }], (t) => t.trim().toUpperCase());
    expect([...flags]).toEqual([[1, ['PDF_SURCHARGE_UNVERIFIED']]]);
    expect(readPdfPreview({ v: 1, review: { surchargeCode: [3, 'T9'] } })?.review).toEqual({ surchargeCode: ['T9'] });
  });
});
