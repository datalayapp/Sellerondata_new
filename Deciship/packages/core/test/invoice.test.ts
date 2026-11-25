import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CARRIER_PRESETS,
  detectDelimiter,
  detectFormat,
  emptyMapping,
  findHeaderRow,
  parseDims,
  parseRows,
  rawHash,
  readTable,
  sha256Hex,
  suggestMapping,
  surchargeCodeForHeader,
  type CarrierCode,
  type ColumnMapping,
} from '../src/index';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sha256 / rawHash', () => {
  it('bilinen vektörler (node:crypto ile aynı)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const s of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Gönderi No;Tutar ₺ 1.184,00'.repeat(20)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
  it('aynı satır aynı özet, sondaki boş hücreler önemsiz', () => {
    expect(rawHash(['a', ' b ', ''])).toBe(rawHash(['a', 'b']));
    expect(rawHash(['a', 'b'])).not.toBe(rawHash(['a', 'b', 'c']));
    expect(rawHash(['ab', 'c'])).not.toBe(rawHash(['a', 'bc']));
  });
});

describe('detectFormat', () => {
  it('imzalara ve uzantıya göre', () => {
    expect(detectFormat('a.pdf', enc('%PDF-1.7 ...'))).toBe('pdf');
    expect(detectFormat('fatura', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('xlsx');
    expect(detectFormat('a.csv', enc('a;b\n1;2'))).toBe('csv');
    expect(detectFormat('a.txt', enc('a\tb\n1\t2'))).toBe('csv');
    expect(detectFormat('a.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toBe('unknown');
    expect(detectFormat('a.bin', new Uint8Array([0, 1, 2, 3, 0, 0]))).toBe('unknown');
    expect(detectFormat('a.csv', new Uint8Array([]))).toBe('unknown');
  });
});

describe('CSV okuma', () => {
  it('ayırıcı tahmini', () => {
    expect(detectDelimiter('a;b;c\n1,5;2,5;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a,b,c\n1.5,2.5,3\n"x,y",5,6')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1,5\t2\t3')).toBe('\t');
  });

  it('; ayırıcılı, BOM\'lu, Türkçe sayı/tarih, başlık öncesi satırlar ve toplam satırı', async () => {
    const csv =
      '\uFEFFMNG Kargo Fatura Dökümü\nFatura No: MNG-1\n\n' +
      'Gönderi No;Tarih;Alıcı Adı;Gerçek Kg;Desi;Tutar;Kapıda Ödeme;KDV;Toplam\n' +
      '571088001201;22.10.2026;Zeynep Şahin;7,30;10;1.141,30;;228,26;1.369,56\n' +
      '571088001212;23.10.2026;Mustafa Öztürk;4,00;7;128,45;15,00;25,69;154,14\n' +
      ';;TOPLAM;;;1.269,75;15,00;253,95;1.523,70\n';
    const t = await readTable('mng.csv', enc(csv));
    expect(t.headers).toEqual(['Gönderi No', 'Tarih', 'Alıcı Adı', 'Gerçek Kg', 'Desi', 'Tutar', 'Kapıda Ödeme', 'KDV', 'Toplam']);
    expect(t.rows).toHaveLength(3);
    const s = suggestMapping(t.headers, 'mng');
    expect(s.missing).toEqual([]);
    expect(s.mapping).toMatchObject({ trackingNo: 'Gönderi No', netAmount: 'Tutar', billedKg: 'Desi', actualKg: 'Gerçek Kg', shipDate: 'Tarih', desiAsWeight: true, amountsIncludeVat: false });
    expect(s.mapping.surchargeColumns).toEqual([{ header: 'Kapıda Ödeme', code: 'KAPIDA_ODEME' }]);
    const { lines, errors } = parseRows(t, s.mapping);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ trackingNo: '571088001201', shipDate: '2026-10-22', actualKg: 7.3, billedKg: 10, netAmount: 1141.3 });
    expect(lines[1]!.surcharges).toEqual([{ code: 'KAPIDA_ODEME', name: 'Kapıda Ödeme', amount: 15 }]);
    expect(JSON.stringify(lines)).not.toContain('Zeynep');
  });

  it(', ayırıcılı, nokta ondalık, tırnaklı alanlar', async () => {
    const csv =
      'Tracking ID,Shipment Date,Recipient Name,Recipient Country/Territory,Actual Weight,Rated Weight,Dim Length,Dim Width,Dim Height,Dim Divisor,Transportation Charge Amount,Discount,Fuel Surcharge,Net Charge Amount,Currency\r\n' +
      '794812345305,2026-10-22,"Dupont, Jean",FR,4.0,9.5,45,35,30,5000,"2,119.35",-805.35,328.50,1642.50,TRY\r\n';
    const t = await readTable('fedex.csv', enc(csv));
    const { mapping } = suggestMapping(t.headers, 'fedex');
    const { lines } = parseRows(t, mapping);
    expect(lines[0]).toMatchObject({
      trackingNo: '794812345305',
      destCountry: 'FR',
      actualKg: 4,
      billedKg: 9.5,
      dims: { l: 45, w: 35, h: 30 },
      billedDivisor: 5000,
      baseAmount: 2119.35,
      discountAmount: 805.35,
      fuelAmount: 328.5,
      netAmount: 1642.5,
      currency: 'TRY',
    });
  });

  it('sekme ayırıcılı ve Windows-1254 kodlu dosya', async () => {
    const latin = new Uint8Array([...enc('Takip No\tTutar\tAl'), 0xfd /* ı */, ...enc('c'), 0xfd, ...enc('\n123456789012\t10,5\tX\n')]);
    const t = await readTable('a.txt', latin);
    expect(t.headers).toEqual(['Takip No', 'Tutar', 'Alıcı']);
    expect(t.rows[0]).toEqual(['123456789012', '10,5', 'X']);
  });

  it('başlık satırı: ilk 20 satırda en çok metin hücresi olan', () => {
    expect(findHeaderRow([['Fatura', '9-482'], ['', ''], ['Takip', 'Tutar', 'Tarih'], ['1', '2', '27.10.2026']])).toBe(2);
  });

  it('boş ve tekrarlı başlıklar benzersizleştirilir', async () => {
    const t = await readTable('a.csv', enc('Takip No;;Tutar;Tutar\n1234567890;x;1;2\n'));
    expect(t.headers).toEqual(['Takip No', 'Sütun 2', 'Tutar', 'Tutar (2)']);
  });
});

describe('XLSX okuma (exceljs fikstürü)', () => {
  async function makeXlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  it('sayısal hücreler, Date hücreleri, formül sonuçları, ön satırlar ve ilk dolu sayfa', async () => {
    const bytes = await makeXlsx((wb) => {
      wb.addWorksheet('Boş');
      const ws = wb.addWorksheet('Fatura');
      ws.addRow(['Yurtiçi Kargo — Fatura YK-2026-118833']);
      ws.addRow([]);
      ws.addRow(['Takip No', 'Gönderi Tarihi', 'Alıcı Adı', 'En', 'Boy', 'Yükseklik', 'Gerçek Ağırlık (kg)', 'Desi', 'Kapıda Ödeme Hizmeti', 'Tutar (KDV Hariç)', 'KDV (%20)', 'Genel Toplam']);
      ws.addRow([620031840101, new Date(Date.UTC(2026, 9, 19)), 'Fatma Demir', 28, 22, 18, 2.5, 4, null, 92.8, 18.56, { formula: 'J4+K4', result: 111.36 }]);
      ws.addRow(['620031840123', 46315, 'Ali', 38, 30, 20, 1.234, 8, 16, 145.81, 29.16, 174.97]);
      ws.addRow([null, null, 'GENEL TOPLAM', null, null, null, null, null, null, 238.61, 47.72, 286.33]);
    });
    expect(detectFormat('yk.xlsx', bytes)).toBe('xlsx');
    const t = await readTable('yk.xlsx', bytes);
    expect(t.headers[0]).toBe('Takip No');
    expect(t.rows[0]!.slice(0, 2)).toEqual(['620031840101', '2026-10-19']);
    expect(t.rows[0]![11]).toBe('111,36');
    const s = suggestMapping(t.headers, 'yurtici');
    expect(s.mapping).toMatchObject({
      trackingNo: 'Takip No',
      shipDate: 'Gönderi Tarihi',
      dimL: 'En',
      dimW: 'Boy',
      dimH: 'Yükseklik',
      actualKg: 'Gerçek Ağırlık (kg)',
      billedKg: 'Desi',
      netAmount: 'Tutar (KDV Hariç)',
      amountsIncludeVat: false,
      desiAsWeight: true,
    });
    const { lines, errors } = parseRows(t, s.mapping);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ trackingNo: '620031840101', shipDate: '2026-10-19', dims: { l: 28, w: 22, h: 18 }, actualKg: 2.5, billedKg: 4, netAmount: 92.8 });
    expect(lines[1]).toMatchObject({ shipDate: '2026-10-20', actualKg: 1.234, surcharges: [{ code: 'KAPIDA_ODEME', amount: 16 }] });
  });

  it('metin hücreli Türkçe sayılar, tek hücre ölçü ve KDV dahil toplam', async () => {
    const bytes = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('Döküm');
      ws.addRow(['ARAS KARGO']);
      ws.addRow(['Fatura No', 'ARS-2026-004871']);
      ws.addRow(['Gönderi No', 'Çıkış Tarihi', 'Alıcı', 'Ölçü (cm)', 'Kg', 'Desi', 'Navlun', 'KDV', 'Toplam', 'Referans']);
      ws.addRow(['3412550010231', '21.10.2026', 'Ayşe Yılmaz', '40x30x25', '6,20', '10', '1.139,79', '227,96', '1.367,75', 'SIP-0231']);
    });
    const t = await readTable('aras.xlsx', bytes);
    const s = suggestMapping(t.headers, 'aras');
    expect(s.mapping).toMatchObject({ trackingNo: 'Gönderi No', netAmount: 'Toplam', amountsIncludeVat: true, dims: 'Ölçü (cm)', billedKg: 'Desi', actualKg: 'Kg' });
    const { lines } = parseRows(t, s.mapping);
    expect(lines[0]).toMatchObject({ dims: { l: 40, w: 30, h: 25 }, actualKg: 6.2, billedKg: 10, netAmount: 1139.79, shipDate: '2026-10-21', reference: 'SIP-0231' });
  });
});

describe('parseRows', () => {
  const headers = ['Takip No', 'Tutar', 'Tarih', 'Ülke', 'Para Birimi', 'Ölçü', 'Adres Düzeltme'];
  const m: ColumnMapping = {
    ...emptyMapping(),
    trackingNo: 'Takip No',
    netAmount: 'Tutar',
    shipDate: 'Tarih',
    destCountry: 'Ülke',
    currency: 'Para Birimi',
    dims: 'Ölçü',
    surchargeColumns: [{ header: 'Adres Düzeltme', code: 'ADDRESS_CORRECTION' }],
  };

  it('boş takip no ve toplam satırları atlanır, hatalar raporlanır', () => {
    const { lines, errors } = parseRows(
      {
        headers,
        rows: [
          ['7948 1234 5305', '1.642,50', '27.10.2026', 'Fransa', 'TL', '45 × 35 × 30 cm', ''],
          ['', '10', '', '', '', '', ''],
          ['Toplam', '1.642,50', '', '', '', '', ''],
          ['794812345306', 'abc', '', '', '', '', ''],
          ['794812345307', '100', '99.99.2026', 'XX', 'TRY', 'yok', '412,00'],
        ],
      },
      m,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ rowIndex: 0, trackingNo: '794812345305', netAmount: 1642.5, shipDate: '2026-10-27', destCountry: 'FR', currency: 'TRY', dims: { l: 45, w: 35, h: 30 }, surcharges: [] });
    expect(lines[1]).toMatchObject({ rowIndex: 4, destCountry: 'XX', surcharges: [{ code: 'ADDRESS_CORRECTION', name: 'Adres Düzeltme', amount: 412 }] });
    expect(lines[1]!.shipDate).toBeUndefined();
    expect(errors.map((e) => e.rowIndex)).toEqual([3, 4]);
    expect(lines[0]!.rawHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('KDV dahil tutarlar net / (1 + kdv/100)', () => {
    const { lines } = parseRows(
      { headers, rows: [['1234567890', '1.420,80', '', '', '', '', '120']] },
      { ...m, amountsIncludeVat: true, vatPct: 20 },
    );
    expect(lines[0]!.netAmount).toBe(1184);
    // 04-B5: ek ücret sütunu KDV dahil olduğu bilinmedikçe KDV hariç sayılır (bölünmez)
    expect(lines[0]!.surcharges[0]!.amount).toBe(120);
    const incl = parseRows(
      { headers, rows: [['1234567890', '1.420,80', '', '', '', '', '120']] },
      { ...m, amountsIncludeVat: true, vatPct: 20, componentsIncludeVat: true },
    );
    expect(incl.lines[0]!.surcharges[0]!.amount).toBe(100);
  });

  it('zorunlu sütun eşlenmemişse hata', () => {
    expect(parseRows({ headers, rows: [] }, { ...emptyMapping(), netAmount: 'Tutar' }).errors[0]!.message).toMatch(/Takip no/);
    expect(parseRows({ headers, rows: [] }, { ...emptyMapping(), trackingNo: 'Takip No' }).errors[0]!.message).toMatch(/Net tutar/);
  });

  it('parseDims biçimleri', () => {
    expect(parseDims('40x30x25')).toEqual({ l: 40, w: 30, h: 25 });
    expect(parseDims('40,5 X 30 X 25')).toEqual({ l: 40.5, w: 30, h: 25 });
    expect(parseDims('40*30*25 cm')).toEqual({ l: 40, w: 30, h: 25 });
    expect(parseDims('40x30')).toBeUndefined();
  });
});

describe('suggestMapping — taşıyıcı kalıpları', () => {
  const cases: { carrier: CarrierCode; headers: string[]; expect: Partial<ColumnMapping>; surcharges?: string[] }[] = [
    {
      carrier: 'fedex',
      headers: [
        'Bill to Account Number', 'Invoice Date', 'Invoice Number', 'Express or Ground Tracking ID', 'Shipment Date', 'Service Type', 'Recipient Name',
        'Recipient Company', 'Recipient Address Line 1', 'Recipient Country/Territory', 'Actual Weight Amount', 'Actual Weight Units', 'Rated Weight Amount',
        'Rated Weight Units', 'Dim Length', 'Dim Width', 'Dim Height', 'Dim Divisor', 'Transportation Charge Amount', 'Earned Discount', 'Fuel Surcharge',
        'Address Correction', 'Residential Surcharge', 'Net Charge Amount', 'Currency', 'Original Customer Reference',
      ],
      expect: {
        trackingNo: 'Express or Ground Tracking ID', netAmount: 'Net Charge Amount', shipDate: 'Shipment Date', service: 'Service Type',
        destCountry: 'Recipient Country/Territory', actualKg: 'Actual Weight Amount', billedKg: 'Rated Weight Amount', dimL: 'Dim Length',
        dimW: 'Dim Width', dimH: 'Dim Height', billedDivisor: 'Dim Divisor', baseAmount: 'Transportation Charge Amount', discountAmount: 'Earned Discount',
        fuelAmount: 'Fuel Surcharge', currency: 'Currency', reference: 'Original Customer Reference',
      },
      surcharges: ['ADDRESS_CORRECTION', 'RESIDENTIAL'],
    },
    {
      carrier: 'ups',
      headers: ['Account Number', 'Invoice Number', 'Pickup Date', 'Lead Shipment Number', 'Tracking Number', 'Service', 'Ship To Country', 'Entered Weight', 'Billed Weight', 'Package Dimensions', 'Published Charge', 'Incentive Amount', 'Fuel Surcharge', 'Delivery Area Surcharge', 'Net Amount', 'Currency', 'Reference No 1'],
      expect: { trackingNo: 'Tracking Number', netAmount: 'Net Amount', shipDate: 'Pickup Date', destCountry: 'Ship To Country', actualKg: 'Entered Weight', billedKg: 'Billed Weight', dims: 'Package Dimensions', baseAmount: 'Published Charge', discountAmount: 'Incentive Amount', fuelAmount: 'Fuel Surcharge' },
      surcharges: ['DELIVERY_AREA'],
    },
    {
      carrier: 'dhl',
      headers: ['Invoice Number', 'Air Waybill Number', 'Shipment Date', 'Product Name', 'Consignee Name', 'Origin Country', 'Destination Country Code', 'Weight (kg)', 'Chargeable Weight', 'Weight Charge', 'Discount', 'Fuel Surcharge', 'Remote Area Delivery', 'Total Amount (excl. VAT)', 'VAT', 'Total Amount (incl. VAT)', 'Currency'],
      expect: { trackingNo: 'Air Waybill Number', netAmount: 'Total Amount (excl. VAT)', destCountry: 'Destination Country Code', actualKg: 'Weight (kg)', billedKg: 'Chargeable Weight', baseAmount: 'Weight Charge', service: 'Product Name', amountsIncludeVat: false },
      surcharges: ['REMOTE_AREA'],
    },
    {
      carrier: 'aras',
      headers: ['Kargo Takip No', 'İrsaliye Tarihi', 'Alıcı Adı', 'Alıcı Adresi', 'Ağırlık', 'Desi', 'Navlun', 'Mobil Bölge Ücreti', 'KDV Hariç Tutar', 'KDV', 'Toplam'],
      expect: { trackingNo: 'Kargo Takip No', netAmount: 'KDV Hariç Tutar', shipDate: 'İrsaliye Tarihi', actualKg: 'Ağırlık', billedKg: 'Desi', baseAmount: 'Navlun', amountsIncludeVat: false, desiAsWeight: true },
      surcharges: ['MOBIL_BOLGE'],
    },
    {
      carrier: 'yurtici',
      headers: ['Gönderi No', 'Kabul Tarihi', 'Gönderici', 'Alıcı', 'Kg', 'Desi', 'Ücret', 'KDV', 'Genel Toplam'],
      expect: { trackingNo: 'Gönderi No', netAmount: 'Ücret', shipDate: 'Kabul Tarihi', actualKg: 'Kg', billedKg: 'Desi', amountsIncludeVat: false },
    },
    {
      carrier: 'mng',
      headers: ['Barkod', 'Gönderi Tarihi', 'Alıcı', 'Desi/Kg', 'Tutar', 'KDV', 'Toplam', 'Sipariş No'],
      expect: { trackingNo: 'Barkod', netAmount: 'Tutar', shipDate: 'Gönderi Tarihi', billedKg: 'Desi/Kg', reference: 'Sipariş No', desiAsWeight: true },
    },
    {
      carrier: 'ptt',
      headers: ['Barkod No', 'Kabul Tarihi', 'Gönderi Türü', 'Ağırlık', 'Desi', 'Ücret', 'Alıcı Adı'],
      expect: { trackingNo: 'Barkod No', netAmount: 'Ücret', shipDate: 'Kabul Tarihi', service: 'Gönderi Türü', actualKg: 'Ağırlık', billedKg: 'Desi' },
    },
    {
      carrier: 'generic',
      headers: ['TAKİP NUMARASI', 'TARİH', 'ÜLKE', 'AĞIRLIK', 'ÖLÇÜLER', 'TOPLAM TUTAR (KDV DAHİL)', 'PARA BİRİMİ'],
      expect: { trackingNo: 'TAKİP NUMARASI', shipDate: 'TARİH', destCountry: 'ÜLKE', actualKg: 'AĞIRLIK', dims: 'ÖLÇÜLER', netAmount: 'TOPLAM TUTAR (KDV DAHİL)', currency: 'PARA BİRİMİ', amountsIncludeVat: true },
    },
  ];

  it.each(cases)('$carrier', (c) => {
    const r = suggestMapping(c.headers, c.carrier);
    expect(r.missing).toEqual([]);
    expect(r.mapping).toMatchObject(c.expect);
    expect(r.mapping.surchargeColumns.map((s) => s.code).sort()).toEqual((c.surcharges ?? []).sort());
    expect(r.confidence).toBeGreaterThan(0.6);
    const mapped = Object.values(r.mapping).filter((v) => typeof v === 'string');
    expect(mapped.some((h) => /Recipient (Name|Company|Address)|Consignee Name|^Alıcı( Adı| Adresi)?$|Gönderici/i.test(h as string))).toBe(false);
  });

  it('bilinmeyen kalıp generic kullanır', () => {
    const r = suggestMapping(['Takip No', 'Tutar'], 'xyz' as CarrierCode);
    expect(r.mapping).toMatchObject({ trackingNo: 'Takip No', netAmount: 'Tutar' });
  });

  it('eksik zorunlu alanlar ve düşük güven', () => {
    const r = suggestMapping(['Alıcı', 'Şehir', 'Not'], 'generic');
    expect(r.missing).toEqual(['trackingNo', 'netAmount']);
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('ek ücret başlıkları', () => {
    expect(surchargeCodeForHeader('Kapıda Ödeme Bedeli')).toBe('KAPIDA_ODEME');
    expect(surchargeCodeForHeader('Large Package Surcharge')).toBe('LARGE_PACKAGE');
    expect(surchargeCodeForHeader('Peak Surcharge')).toBe('PEAK');
    expect(surchargeCodeForHeader('Fuel Surcharge')).toBeNull();
    expect(surchargeCodeForHeader('KDV')).toBeNull();
    expect(surchargeCodeForHeader('Alıcı Adı')).toBeNull();
  });

  it('her kalıbın adı ve varsayılan böleni var', () => {
    expect(Object.keys(CARRIER_PRESETS).sort()).toEqual(['aras', 'dhl', 'fedex', 'generic', 'mng', 'ptt', 'ups', 'yurtici']);
    expect(CARRIER_PRESETS.fedex.defaultDivisor).toBe(5000);
    expect(CARRIER_PRESETS.aras.defaultDivisor).toBe(3000);
  });
});
