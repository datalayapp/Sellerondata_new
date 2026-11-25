import { describe, expect, it } from 'vitest';
import {
  CARRIER_TRACKING_FORMATS,
  checkTracking,
  extractTracking,
  fedexCheckOk,
  normalizeTracking,
  stripScanNoise,
  TRACKING_HARD_MAX,
  TRACKING_HARD_MIN,
} from '../src/index';
import { checkTracking as checkFromSubpath } from '../src/trackingFormat';

// Kaynakta görünmez karakter yazılmaz (depo denetimi K2): kod noktasıyla kurulur.
const GS = String.fromCharCode(0x1d);
const CR = String.fromCharCode(0x0d);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0x00);
const I_DOT = String.fromCharCode(0x130); // büyük noktalı İ
const S_CEDILLA = String.fromCharCode(0x15e); // Ş

const FEDEX34 = '9632001960000000000400794812345305';

describe('stripScanNoise: okuyucunun eklediği görünmez işaretler (kesin kurallar)', () => {
  it('kontrol ve biçim karakterleri silinir (GS, CR, sıfır genişlikli boşluk, BOM, NUL)', () => {
    expect(stripScanNoise(`${BOM}7948${GS}1234${ZWSP}5305${CR}`)).toBe('794812345305');
    expect(stripScanNoise(`${NUL}1Z9X4A710341`)).toBe('1Z9X4A710341');
  });
  it('baştaki AIM simge kimliği (]C1, ]d2, ]Q3, ]E0) silinir', () => {
    expect(stripScanNoise(']C100340434161094042557')).toBe('00340434161094042557');
    expect(stripScanNoise(']d2794812345305')).toBe('794812345305');
    expect(stripScanNoise(']Q31Z9X4A7103410000')).toBe('1Z9X4A7103410000');
    expect(stripScanNoise(']E04006381333931')).toBe('4006381333931');
  });
  it('GS1 okunur yazımındaki AI parantezleri kalkar, içerik kalır', () => {
    expect(stripScanNoise('(00)340434161094042557')).toBe('00340434161094042557');
    expect(stripScanNoise('(00) 3404 3416 1094 0425 57')).toBe('00 3404 3416 1094 0425 57');
  });
  it('GS1 kalıbı olmayan parantez olduğu gibi kalır', () => {
    expect(stripScanNoise('AB(12)')).toBe('AB(12)');
  });
  it('noktalı büyük İ, I olur (Türkçe klavye)', () => {
    expect(stripScanNoise(`${I_DOT}K123456789`)).toBe('IK123456789');
  });
  it('başta ve sonda boşluk kırpılır, aradaki boşluk kalır', () => {
    expect(stripScanNoise('  7948 1234 5305  ')).toBe('7948 1234 5305');
  });
  it('temiz değer değişmez', () => {
    for (const v of ['794812345305', '1Z9X4A710341', 'RR123456789TR', FEDEX34]) expect(stripScanNoise(v)).toBe(v);
  });
});

describe('checkTracking: kesin geçersiz (sunucu 400, telefon kaydetmez)', () => {
  it('boş ya da yalnız işaret', () => {
    expect(checkTracking('').verdict).toBe('invalid');
    expect(checkTracking('   ').reason).toBe('empty');
    expect(checkTracking('---').reason).toBe('empty');
    expect(checkTracking(`${GS}${CR}`).reason).toBe('empty');
  });
  it(`${TRACKING_HARD_MIN} karakterden kısa`, () => {
    expect(checkTracking('12').reason).toBe('tooShort');
    expect(checkTracking('7 9 4 8').reason).toBe('tooShort');
    expect(checkTracking('12345').verdict).not.toBe('invalid');
  });
  it(`${TRACKING_HARD_MAX} karakterden uzun (QR adresi, PDF417 verisi)`, () => {
    expect(checkTracking('1'.repeat(TRACKING_HARD_MAX + 1)).reason).toBe('tooLong');
    expect(checkTracking('1'.repeat(TRACKING_HARD_MAX)).verdict).not.toBe('invalid');
    expect(checkTracking('https://example.com/track?id=1234567890&lang=tr&utm_source=label').reason).toBe('tooLong');
  });
  it('yazdırılabilir ASCII dışı karakter (Ş, emoji)', () => {
    expect(checkTracking(`${S_CEDILLA}1234567890`).reason).toBe('chars');
    expect(checkTracking(`1234567890${String.fromCodePoint(0x1f4e6)}`).reason).toBe('chars');
  });
});

describe('checkTracking: olağan dışı (telefonda yumuşak uyarı, kaydedilebilir)', () => {
  it('ürün barkodu: EAN/UPC simgesi', () => {
    expect(checkTracking('8690000000005', { symbology: 'ean13' })).toMatchObject({ verdict: 'unusual', reason: 'product' });
    expect(checkTracking('96385074', { symbology: 'ean8' }).reason).toBe('product');
    expect(checkTracking('036000291452', { symbology: 'upc_a' }).reason).toBe('product');
    expect(checkTracking('18690000000008', { symbology: 'itf14' }).reason).toBe('product');
  });
  it('simgesi bilinmeyen (elle, Bluetooth) Türk ürün EAN-13’ü: 868/869 öneki ve geçerli denetim hanesi', () => {
    expect(checkTracking('8690000000005').reason).toBe('product');
    expect(checkTracking('8691234567890').reason).toBe('product');
    // Denetim hanesi tutmuyor: ürün kodu değil, takip no olabilir.
    expect(checkTracking('8691234567893').verdict).toBe('ok');
  });
  it('kısa, uzun, işaretli ya da rakamsız', () => {
    expect(checkTracking('1234567').reason).toBe('short');
    expect(checkTracking('1'.repeat(36)).reason).toBe('long');
    expect(checkTracking('HTTPS://X.CO/A1').reason).toBe('symbols');
    expect(checkTracking('ABCDEFGHIJ').reason).toBe('noDigit');
  });
});

describe('checkTracking: takip no biçimleri', () => {
  const ok: [string, string][] = [
    ['fedex', '794812345305'],
    ['fedex', '9612345678901234567890'],
    ['fedex', FEDEX34],
    ['ups', '1Z9X4A710341000011'],
    ['dhl', '1234567890'],
    ['dhl', 'JJD000390007882713284'],
    ['dhl', '00340434161094042557'],
    ['ptt', 'RR123456789TR'],
    ['ptt', '1234567890123'],
    ['aras', '1234567890123'],
    ['yurtici', '123456789012'],
    ['mng', '123456789'],
  ];
  it.each(ok)('%s: %s tanınır', (carrier, value) => {
    const r = checkTracking(value);
    expect(r.verdict).toBe('ok');
    expect(r.carriers).toContain(carrier);
  });
  it('bilinmeyen ama olağan biçim de geçer (sert engel yok), taşıyıcı boş', () => {
    const r = checkTracking('AB12CD34EF');
    expect(r.verdict).toBe('ok');
    expect(r.carriers).toEqual([]);
  });
  it('biçim tablosu yalnız core’daki taşıyıcı kodlarını taşır', () => {
    expect(Object.keys(CARRIER_TRACKING_FORMATS).sort()).toEqual(['aras', 'dhl', 'fedex', 'mng', 'ptt', 'ups', 'yurtici']);
  });
});

describe('checkTracking: değer eşleşmeyle aynı kuraldan geçer', () => {
  it('value = normalizeTracking(stripScanNoise(raw)); fatura tarafı da normalizeTracking kullanır', () => {
    for (const raw of [' 7948-1234-5305 ', `]C1${FEDEX34}`, `7948${GS}12345305`, '(00)340434161094042557', '1z9x 4a71 0341 0000 11']) {
      expect(checkTracking(raw).value).toBe(normalizeTracking(stripScanNoise(raw)));
    }
    expect(checkTracking(`]C1${FEDEX34}`).value).toBe('794812345305');
    // Temiz değerde (bugüne dek kaydedilenler) sonuç eskisiyle aynı: kayıtlı ölçümler faturayla yine eşleşir.
    for (const raw of ['7948 1234 5305', '1Z9X-4A71-0341', FEDEX34, 'abc 123']) expect(checkTracking(raw).value).toBe(normalizeTracking(raw));
  });
  it('alt yol aynı işlevi verir (mobil hafif alt yoldan alır)', () => {
    expect(checkFromSubpath).toBe(checkTracking);
  });
});

describe('extractTracking: barkod içinden yalnız takip no', () => {
  it('96 dışı önekli 34 haneli FedEx Express barkodu: denetim hanesi tutarsa son 12 hane (sahibin etiketi, TRK# 8796 9898 6192)', () => {
    expect(fedexCheckOk('879698986192')).toBe(true);
    expect(extractTracking('1221589660610965643600879698986192')).toEqual({ value: '879698986192', source: 'fedex96' });
    // denetim hanesi tutmayan 34 hane kısaltılmaz (yanlış numara almaktansa hiç almaz)
    expect(fedexCheckOk('879698986193')).toBe(false);
    expect(extractTracking('1221589660610965643600879698986193').value).toBe('1221589660610965643600879698986193');
  });

  const RS = String.fromCharCode(0x1e);
  const EOT = String.fromCharCode(0x04);
  /** Kayıtları RS ile, alanları GS ile birleştirir: `[)>RS01GS02GS…RS06GS…RSEOT`. */
  const mh10 = (...records: string[][]) => `[)>${RS}${records.map((r) => r.join(GS)).join(RS)}${RS}${EOT}`;
  // FedEx Express (FDE) PDF417: sürüm 02, posta kodu, ülke (792 Türkiye), hizmet, takip no, SCAC, hesap, Jülyen gün, parça, ağırlık, adres.
  const fedexExpress = mh10(
    ['01', '02', '34394', '792', '001', '794812345305', 'FDE', '510087020', '329', '1/1', '2.50KG', 'N', 'BUYUKDERE CAD 1', 'ISTANBUL', 'IS', 'ACME LTD'],
    ['06', '10ZED008', '11ZACME LTD', '12Z902120000000', '15Z123456789', '20Z0', '31Z9632001960000000000400794812345305'],
  );
  // FedEx Ground (FDEG) PDF417: 15 haneli takip no.
  const fedexGround = mh10([
    '01',
    '02',
    '38017',
    '840',
    '020',
    '123456789012345',
    'FDEG',
    '1234567',
    '304',
    '1/1',
    '5.0LB',
    'N',
    '123 MAIN ST',
    'COLLIERVILLE',
    'TN',
    'JOHN DOE',
  ]);

  it('FedEx Express PDF417 (MH10.8.3 "01" kaydı): yalnız 12 haneli takip no', () => {
    expect(extractTracking(fedexExpress)).toEqual({ value: '794812345305', source: 'mh10' });
    expect(checkTracking(extractTracking(fedexExpress).value)).toMatchObject({ verdict: 'ok', carriers: expect.arrayContaining(['fedex']) });
  });
  it('FedEx Ground PDF417: 15 haneli takip no; AIM öneki ve baştaki boşluk engel değil', () => {
    expect(extractTracking(fedexGround).value).toBe('123456789012345');
    expect(extractTracking(`]L2${fedexGround}`).value).toBe('123456789012345');
    expect(extractTracking(` ${fedexGround}`).value).toBe('123456789012345');
  });
  it('takip no alanında 34 haneli "96" barkodu varsa son 12 hane', () => {
    const msg = mh10(['01', '02', '34394', '792', '001', FEDEX34, 'FDE', '510087020']);
    expect(extractTracking(msg).value).toBe('794812345305');
  });
  it('SCAC alanı yerinden kaymışsa da önündeki alan alınır', () => {
    const msg = mh10(['01', '02', '34394', '792', '794812345305', 'FDE', '510087020']);
    expect(extractTracking(msg).value).toBe('794812345305');
  });
  it('FedEx SCAC önündeki alan FedEx biçimine uymuyorsa ayıklanmaz (yanlış numara alınmaz)', () => {
    const msg = mh10(['01', '02', '34394', '792', '001', 'ABC123', 'FDE', '510087020', '329', '1/1', '2.50KG', 'N', 'BUYUKDERE CAD 1']);
    const r = extractTracking(msg);
    expect(r.source).toBe('none');
    expect(checkTracking(r.value).verdict).toBe('invalid');
  });
  it('UPS 2D (UPSN): tam 1Z takip no alınır; yarım 1Z alanı alınmaz', () => {
    expect(extractTracking(mh10(['01', '96', '1Z9X4A710341000011', 'UPSN', '9X4A71', '159']))).toEqual({ value: '1Z9X4A710341000011', source: 'mh10' });
    expect(extractTracking(mh10(['01', '96', '1Z00004951', 'UPSN', '06X610', '159', '1234567', '1/1', '10', 'Y', '', 'ATLANTA', 'GA'])).source).toBe('none');
  });
  it('SCAC yoksa 6. alan yalnız bilinen biçimdeyse alınır', () => {
    expect(extractTracking(mh10(['01', '02', '34394', '792', '001', '794812345305'])).value).toBe('794812345305');
    expect(extractTracking(mh10(['01', '02', '34394', '792', '001', 'X1'])).source).toBe('none');
  });
  it('ayraçları kaybolmuş FedEx Express iletisi: "FDE" önündeki 12 hane', () => {
    expect(extractTracking('[)>010234394792001794812345305FDE510087020329').value).toBe('794812345305');
    // FDEG (Ground) yapışık iletide 12 mi 15 mi belli değil: ayıklanmaz.
    expect(extractTracking('[)>010238017840020123456789012345FDEG1234567').source).toBe('none');
  });
  it('FedEx "96" barkodu: 34 hane → son 12, 22 hane → son 15', () => {
    expect(extractTracking(FEDEX34)).toEqual({ value: '794812345305', source: 'fedex96' });
    expect(extractTracking(`]C1${FEDEX34}${CR}`).value).toBe('794812345305');
    expect(extractTracking('9611 0190 1234 5671 2345 67')).toEqual({ value: '012345671234567', source: 'fedex96' });
    // Kısaltma eşleşme anahtarını değiştirmez (34 hane zaten son 12'ye iner) ya da sonek eşleşmesi tutar (22 hane).
    expect(normalizeTracking(extractTracking(FEDEX34).value)).toBe(normalizeTracking(FEDEX34));
  });
  it('GS1-128 "420 + posta kodu GS takip no": GS sonrası IMpb takip no', () => {
    expect(extractTracking(`42038017${GS}9261290100130435082762`)).toEqual({ value: '9261290100130435082762', source: 'gs1Postal' });
    // Yalnız posta kodu barkodu ya da IMpb olmayan alan: bugünkü davranış.
    expect(extractTracking('42038017').source).toBe('none');
    expect(extractTracking(`42038017${GS}ABC`).source).toBe('none');
  });
  it('tanınmayan biçim: stripScanNoise ile aynı (UPS, DHL, PTT, Türk taşıyıcıları bozulmaz)', () => {
    for (const v of [
      '794812345305',
      '1Z9X4A710341000011',
      'JJD000390007882713284',
      '00340434161094042557',
      'RR123456789TR',
      '1234567890123',
      '7948 1234 5305',
      `]C1${'00340434161094042557'}`,
      `7948${GS}12345305`,
      '8690000000005',
    ]) {
      expect(extractTracking(v)).toEqual({ value: stripScanNoise(v), source: 'none' });
    }
  });
});
