import type { CarrierCode, ColumnMapping } from './types';

export type CarrierPreset = {
  name: string;
  defaultDivisor: number;
  synonyms: Partial<Record<keyof ColumnMapping, string[]>>;
};

/** Tüm kalıplarda geçerli TR + EN başlık eş anlamlıları. */
const GENERIC: Partial<Record<keyof ColumnMapping, string[]>> = {
  trackingNo: [
    'tracking id', 'tracking number', 'tracking no', 'tracking nr', 'tracking', 'tracking code', 'package tracking number',
    'express or ground tracking id', 'shipment tracking number', 'awb', 'awb no', 'awb number', 'air waybill', 'air waybill number',
    'airwaybill', 'airwaybill number', 'waybill', 'waybill number', 'waybill no', 'shipment number', 'shipment no', 'consignment number',
    'takip no', 'takip numarasi', 'takip kodu', 'kargo takip no', 'kargo takip numarasi', 'gonderi no', 'gonderi numarasi',
    'gonderi takip no', 'gonderi kodu', 'kargo no', 'kargo kodu', 'barkod', 'barkod no', 'barkod numarasi', 'gonderi barkodu',
    'irsaliye no', 'irsaliye numarasi', 'kargo anahtari', 'havayolu konsimentosu numarasi', 'konsimento no', 'konsimento numarasi',
  ],
  netAmount: [
    'net charge amount', 'net charge', 'net charges', 'net amount', 'net total', 'total charge', 'total charges', 'total amount',
    'total net charge', 'amount due', 'billed amount', 'billed charge', 'invoice amount', 'charge amount', 'amount', 'total',
    'net', 'tutar', 'net tutar', 'toplam', 'toplam tutar', 'genel toplam', 'kdv haric tutar', 'kdv haric toplam', 'tutar kdv haric',
    'kdv haric', 'matrah', 'ucret', 'toplam ucret', 'kargo ucreti toplam', 'fatura tutari', 'odenecek tutar', 'net ucret',
    'total excl vat', 'amount excl vat', 'total amount excl vat', 'havayolu konsimentosu toplam tutar',
  ],
  shipDate: [
    'shipment date', 'ship date', 'shipping date', 'pickup date', 'pick up date', 'date shipped', 'transaction date', 'date',
    'tarih', 'gonderi tarihi', 'gonderim tarihi', 'sevk tarihi', 'cikis tarihi', 'kabul tarihi', 'islem tarihi',
    'teslim alma tarihi', 'alim tarihi', 'kargo tarihi', 'irsaliye tarihi',
  ],
  service: [
    'service type', 'service', 'service name', 'service level', 'product', 'product name', 'product code',
    'hizmet', 'hizmet tipi', 'hizmet turu', 'servis', 'servis tipi', 'urun', 'urun tipi', 'gonderi tipi', 'gonderi turu', 'tasima tipi',
  ],
  destCountry: [
    'recipient country', 'recipient country territory', 'recipient country code', 'destination country', 'destination country code',
    'dest country', 'destination', 'consignee country', 'receiver country', 'ship to country', 'country', 'country code',
    'ulke', 'ulke kodu', 'varis ulkesi', 'alici ulke', 'alici ulkesi', 'hedef ulke', 'teslim ulkesi', 'varis ulke',
  ],
  actualKg: [
    'actual weight', 'actual weight amount', 'actual weight kg', 'weight', 'weight kg', 'gross weight', 'entered weight',
    'scale weight', 'kg', 'gercek kg', 'agirlik', 'agirlik kg', 'gercek agirlik', 'brut agirlik', 'tartim', 'kilo', 'tartilan agirlik',
  ],
  billedKg: [
    'rated weight', 'rated weight amount', 'billed weight', 'billable weight', 'chargeable weight', 'charged weight',
    'ucretli agirlik', 'faturalanan agirlik', 'fiyatlandirilan agirlik', 'hesaplanan agirlik', 'ucretlendirilen agirlik',
    'desi kg', 'kg desi', 'ucretli desi', 'ucretlendirilen desi', 'faturalanan desi', 'desi',
  ],
  dimL: ['dim length', 'dimension length', 'length', 'length cm', 'package length', 'uzunluk', 'en', 'en cm', 'boyut uzunlugu'],
  dimW: ['dim width', 'dimension width', 'width', 'width cm', 'package width', 'genislik', 'boy', 'boy cm', 'boyut genisligi'],
  dimH: ['dim height', 'dimension height', 'height', 'height cm', 'package height', 'yukseklik', 'yukseklik cm', 'boyut yuksekligi'],
  dimUnit: ['dim unit', 'dim units', 'dimension unit', 'dimension units', 'unit of measure', 'boyut birimi', 'olcu birimi'],
  actualKgUnit: ['actual weight units', 'actual weight unit', 'weight unit', 'weight units', 'agirlik birimi', 'asil agirlik birimleri'],
  billedKgUnit: ['rated weight units', 'rated weight unit', 'billed weight unit', 'billed weight units', 'ucretlendirilen agirlik birimleri'],
  dims: [
    'dimensions', 'dimension', 'dims', 'package dimensions', 'dimensions cm', 'olcu', 'olculer', 'ebat', 'ebatlar', 'boyut', 'boyutlar',
    'en boy yukseklik', 'koli olcusu',
  ],
  billedDivisor: ['dim divisor', 'dimensional divisor', 'divisor', 'volumetric divisor', 'bolen', 'hacim boleni', 'desi boleni'],
  baseAmount: [
    'transportation charge', 'transportation charge amount', 'freight charge', 'freight', 'base charge', 'base rate', 'weight charge',
    'published charge', 'list charge', 'navlun', 'navlun tutari', 'navlun ucreti', 'tasima ucreti', 'kargo ucreti', 'liste fiyati', 'baz ucret',
  ],
  discountAmount: ['discount', 'discount amount', 'earned discount', 'incentive amount', 'incentive', 'indirim', 'indirim tutari', 'iskonto', 'iskonto tutari'],
  fuelAmount: ['fuel surcharge', 'fuel surcharge amount', 'fuel', 'fuel charge', 'yakit', 'yakit ek ucreti', 'yakit farki', 'yakit ucreti', 'akaryakit', 'akaryakit farki'],
  currency: ['currency', 'currency code', 'curr', 'cur', 'ccy', 'invoice currency', 'billed currency', 'para birimi', 'doviz', 'doviz cinsi', 'doviz kodu'],
  reference: [
    'reference', 'reference 1', 'customer reference', 'shipper reference', 'reference number', 'ref', 'po number', 'order number', 'order no',
    'referans', 'referans no', 'musteri referansi', 'musteri referans no', 'siparis no', 'siparis numarasi',
  ],
};

export const CARRIER_PRESETS: Record<CarrierCode, CarrierPreset> = {
  fedex: {
    name: 'FedEx',
    defaultDivisor: 5000,
    // FedEx Billing Online (FBO) dışa aktarımı: İngilizce ve Türkçe arayüz başlıkları.
    synonyms: {
      trackingNo: [
        'express or ground tracking id', 'tracking id', 'ground tracking id', 'express tracking id', 'tracking number',
        'havayolu konsimentosu numarasi', 'takip numarasi',
      ],
      netAmount: ['net charge amount', 'net charge', 'total net charge', 'havayolu konsimentosu toplam tutar'],
      shipDate: ['shipment date', 'ship date', 'gonderi tarihi', 'gonderme tarihi bicimlendirilmis'],
      service: ['svcpkg label', 'svcpkg etiketi', 'service type', 'service'],
      destCountry: ['recipient country territory', 'recipient country', 'recipient country code', 'alicinin adresi ulke bolge', 'alici ulke bolge'],
      actualKg: ['actual weight amount', 'actual weight', 'asil agirlik'],
      billedKg: ['rated weight amount', 'rated weight', 'ucretlendirilen agirlik miktari', 'ucretlendirilen agirlik'],
      dimL: ['dim length', 'dimmed length', 'boyut uzunlugu'],
      dimW: ['dim width', 'dimmed width', 'boyut genisligi'],
      dimH: ['dim height', 'dimmed height', 'boyut yuksekligi'],
      billedDivisor: ['dim divisor', 'boyut boleni'],
      baseAmount: ['transportation charge amount', 'transportation charge'],
      discountAmount: ['earned discount', 'discount', 'discount amount'],
      fuelAmount: ['fuel surcharge', 'fuel surcharge amount'],
      currency: ['currency', 'invoice currency code', 'currency code', 'faturalanan para birimi'],
      reference: ['customer reference', 'shipper reference', 'reference', 'original customer reference', 'gonderici referansi 1', 'gonderici referansi'],
      dimUnit: ['dim unit', 'dim units', 'dimension unit', 'boyut birimi'],
      actualKgUnit: ['actual weight units', 'actual weight unit', 'asil agirlik birimleri', 'asil agirlik birimi'],
      billedKgUnit: ['rated weight units', 'rated weight unit', 'ucretlendirilen agirlik birimleri', 'ucretlendirilen agirlik birimi'],
    },
  },
  ups: {
    name: 'UPS',
    defaultDivisor: 5000,
    synonyms: {
      trackingNo: ['tracking number', 'package tracking number', 'lead shipment number', 'shipment number'],
      netAmount: ['net amount', 'net charge', 'net charges', 'billed charge', 'total net'],
      shipDate: ['pickup date', 'shipment date', 'transaction date', 'ship date'],
      service: ['service', 'service level', 'service type'],
      destCountry: ['receiver country', 'ship to country', 'consignee country', 'destination country'],
      actualKg: ['entered weight', 'actual weight'],
      billedKg: ['billed weight', 'billable weight'],
      dims: ['package dimensions', 'dimensions'],
      baseAmount: ['published charge', 'transportation charge', 'freight charge'],
      discountAmount: ['incentive amount', 'incentive', 'discount'],
      fuelAmount: ['fuel surcharge'],
      currency: ['currency', 'invoice currency code'],
      reference: ['reference no 1', 'shipment reference number 1', 'reference'],
    },
  },
  dhl: {
    name: 'DHL Express',
    defaultDivisor: 5000,
    synonyms: {
      trackingNo: ['waybill number', 'airwaybill number', 'air waybill number', 'awb', 'awb number', 'shipment number'],
      netAmount: ['total amount excl vat', 'total charge', 'net amount', 'total amount', 'net charge'],
      shipDate: ['shipment date', 'pickup date', 'ship date'],
      service: ['product', 'product name', 'product code', 'service'],
      destCountry: ['destination country', 'destination country code', 'dest country', 'consignee country'],
      actualKg: ['weight', 'actual weight', 'declared weight'],
      billedKg: ['billed weight', 'chargeable weight', 'weight charged'],
      dims: ['dimensions', 'pieces dimensions'],
      baseAmount: ['weight charge', 'freight charge', 'base charge'],
      discountAmount: ['discount', 'discount amount'],
      fuelAmount: ['fuel surcharge', 'fuel'],
      currency: ['currency', 'billing currency'],
      reference: ['shipper reference', 'reference'],
    },
  },
  aras: {
    name: 'Aras Kargo',
    defaultDivisor: 3000,
    synonyms: {
      trackingNo: ['kargo takip no', 'gonderi kodu', 'takip no', 'irsaliye no', 'barkod', 'barkod no', 'gonderi no'],
      // navlun net tutar değildir (yakıt ve ek ücretler dışarıda kalır); tek tutar sütunu navlunsa `suggestMapping` onu net alır
      netAmount: ['kdv haric tutar', 'tutar', 'toplam', 'ucret', 'net tutar'],
      shipDate: ['cikis tarihi', 'gonderi tarihi', 'tarih', 'irsaliye tarihi'],
      service: ['odeme tipi', 'hizmet', 'urun', 'gonderi tipi'],
      actualKg: ['kg', 'agirlik'],
      billedKg: ['desi', 'desi kg', 'ucretli desi', 'ucretlendirilen desi'],
      dims: ['olcu', 'ebat'],
      reference: ['referans', 'musteri referansi', 'siparis no', 'entegrasyon kodu'],
    },
  },
  yurtici: {
    name: 'Yurtiçi Kargo',
    defaultDivisor: 3000,
    synonyms: {
      trackingNo: ['kargo takip no', 'gonderi no', 'takip no', 'kargo anahtari', 'barkod no', 'barkod', 'gonderi kodu'],
      netAmount: ['kdv haric tutar', 'tutar', 'ucret', 'toplam', 'net tutar', 'toplam ucret'],
      shipDate: ['gonderi tarihi', 'tarih', 'kabul tarihi', 'islem tarihi'],
      service: ['urun', 'hizmet', 'gonderi tipi', 'odeme tipi'],
      actualKg: ['kg', 'agirlik'],
      billedKg: ['desi', 'desi kg', 'ucret desi', 'ucretli desi'],
      dims: ['olcu', 'ebat'],
      reference: ['referans', 'referans no', 'musteri referansi', 'siparis no'],
    },
  },
  mng: {
    name: 'MNG Kargo',
    defaultDivisor: 3000,
    synonyms: {
      trackingNo: ['gonderi no', 'takip no', 'kargo takip no', 'barkod', 'barkod no', 'gonderi barkodu', 'irsaliye no'],
      // 1.5: "Navlun" net tutar değildir ("Navlun; Yakıt; KDV; Genel Toplam" düzeninde yakıt dışarıda kalırdı)
      netAmount: ['kdv haric tutar', 'tutar', 'toplam', 'ucret', 'net tutar'],
      shipDate: ['gonderi tarihi', 'tarih', 'irsaliye tarihi', 'cikis tarihi'],
      service: ['urun', 'hizmet', 'gonderi tipi'],
      actualKg: ['kg', 'agirlik'],
      billedKg: ['desi', 'desi kg', 'kg desi'],
      dims: ['olcu', 'ebat'],
      reference: ['referans', 'siparis no', 'musteri referansi'],
    },
  },
  ptt: {
    name: 'PTT Kargo',
    defaultDivisor: 3000,
    synonyms: {
      trackingNo: ['barkod no', 'barkod', 'gonderi barkodu', 'barkod numarasi', 'takip no', 'gonderi no'],
      netAmount: ['ucret', 'tutar', 'kdv haric tutar', 'toplam', 'net tutar'],
      shipDate: ['kabul tarihi', 'tarih', 'gonderi tarihi'],
      service: ['gonderi turu', 'hizmet', 'urun'],
      actualKg: ['agirlik', 'kg', 'agirlik kg'],
      billedKg: ['desi', 'ucretli desi'],
      dims: ['olcu', 'ebat'],
      reference: ['referans', 'siparis no'],
    },
  },
  generic: {
    name: 'Diğer / Genel',
    defaultDivisor: 5000,
    synonyms: GENERIC,
  },
};

export const GENERIC_SYNONYMS = GENERIC;

/**
 * Ambalaj sütunu başlıkları (normalleştirilmiş, tam eşleşme; sıra önceliktir): FedEx FBO "Service Packaging" / TR
 * "Paketleme", UPS "Package Type" / "Container Type", genel "Packaging Type", "Ambalaj".
 */
export const PACKAGING_SYNONYMS: readonly string[] = [
  'service packaging', 'paketleme', 'packaging type', 'packaging', 'package type', 'container type', 'packaging code',
  'pkg type', 'paketleme tipi', 'paketleme turu', 'ambalaj', 'ambalaj tipi', 'ambalaj turu', 'paket tipi', 'paket turu',
];


/**
 * Etiket/tutar sütun çiftlerinin başlıkları (normalleştirilmiş; sonda yinelenme eki " 2" olabilir).
 * Etiket sütunundan hemen sonra tutar sütunu gelmelidir.
 */
export const CHARGE_PAIR_HEADERS: { label: string[]; amount: string[] } = {
  label: ['tracking id charge description', 'charge description', 'charge label', 'charge type', 'havayolu konsimentosu ucret etiketi', 'ucret etiketi', 'ucret aciklamasi', 'ucret turu'],
  amount: ['tracking id charge amount', 'charge amount', 'havayolu konsimentosu ucret tutari', 'ucret tutari', 'ucret miktari'],
};

/**
 * Ücret etiketi sözlüğü (TR + EN, normalleştirilmiş). `fuel` ve `discount` kelime olarak geçerse,
 * `base` etiketin başında geçerse eşleşir. Diğer etiketler ek ücrettir (bkz. surcharges.ts eş anlamlıları).
 */
export const CHARGE_LABELS: { fuel: string[]; discount: string[]; base: string[] } = {
  fuel: ['yakit', 'akaryakit', 'fuel'],
  discount: ['indirim', 'indirimi', 'indirimler', 'iskonto', 'discount', 'discounts', 'incentive', 'rebate', 'earned'],
  base: [
    'tasima', 'tasima ucreti', 'tasima bedeli', 'navlun', 'navlun ucreti', 'navlun tutari', 'kargo ucreti',
    'transportation', 'transportation charge', 'freight', 'freight charge', 'base charge', 'base rate', 'weight charge', 'published charge',
  ],
};

/** Fatura düzeyi (meta) sütun eş anlamlıları (normalleştirilmiş, tam eşleşme). */
export const META_SYNONYMS: Record<'invoiceNo' | 'invoiceDate' | 'invoiceTotal', string[]> = {
  invoiceNo: [
    'invoice number', 'invoice no', 'invoice nr', 'invoice num', 'inv number', 'inv no', 'inv nr', 'inv num',
    'bill number', 'bill no', 'bill nr', 'billing number', 'billing no',
    'fatura no', 'fatura nr', 'fatura numarasi', 'fedex fatura numarasi', 'rechnungsnummer', 'rechnungs nr',
  ],
  invoiceDate: [
    'invoice date', 'inv date', 'invoiced date', 'date of invoice', 'bill date', 'billing date', 'issue date',
    'fatura tarihi', 'duzenleme tarihi', 'fatura duzenleme tarihi', 'rechnungsdatum',
  ],
  invoiceTotal: [
    'original amount due', 'invoice total', 'invoice amount due', 'total invoice amount',
    'orijinal odenecek tutar', 'fatura toplami', 'fatura genel toplami',
  ],
};
