import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  classifyCharge,
  columnFillCounts,
  detectChargePairs,
  detectDateOrder,
  detectNumberFormat,
  guessInvoiceMeta,
  lengthFactor,
  mappingDiagnostics,
  parseDateAs,
  parseNumberAs,
  parseRows,
  readTable,
  sumMoney,
  suggestMapping,
  tableFromMatrix,
  weightFactor,
  type Table,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../../samples/invoices/fedex-fbo-tr-sample.csv');

describe('FedEx Billing Online (TR arayüz) dışa aktarımı', () => {
  let t: Table;
  beforeAll(async () => {
    t = await readTable('fedex-fbo-tr-sample.csv', new Uint8Array(readFileSync(FIXTURE)));
  });

  it('78 sütunu okur, yinelenen başlıkları belirlenimci biçimde ayırır', () => {
    expect(t.headers).toHaveLength(78);
    expect(t.rows).toHaveLength(8);
    expect(t.headers[16]).toBe('Havayolu Konşimentosu Numarası');
    expect(t.headers[66]).toBe('Havayolu Konşimentosu Ücret Etiketi');
    expect(t.headers[67]).toBe('Havayolu Konşimentosu Ücret Tutarı');
    expect(t.headers[68]).toBe('Havayolu Konşimentosu Ücret Etiketi (2)');
    expect(t.headers[77]).toBe('Havayolu Konşimentosu Ücret Tutarı (6)');
    expect(new Set(t.headers).size).toBe(78);
    expect(columnFillCounts(t)[56]).toBe(0); // MPS Paketi Takip Numarası boş
  });

  it('etiket/tutar çiftlerini bulur', () => {
    const pairs = detectChargePairs(t.headers);
    expect(pairs).toHaveLength(6);
    expect(pairs[0]).toEqual({ label: 'Havayolu Konşimentosu Ücret Etiketi', amount: 'Havayolu Konşimentosu Ücret Tutarı' });
    expect(pairs[5]).toEqual({ label: 'Havayolu Konşimentosu Ücret Etiketi (6)', amount: 'Havayolu Konşimentosu Ücret Tutarı (6)' });
  });

  for (const carrier of ['fedex', 'generic'] as const) {
    it(`elle eşleme olmadan önerir (${carrier})`, () => {
      const { mapping, missing, confidence } = suggestMapping(t.headers, carrier, t.rows);
      expect(missing).toEqual([]);
      expect(confidence).toBeGreaterThan(0.7);
      expect(mapping.trackingNo).toBe('Havayolu Konşimentosu Numarası');
      expect(mapping.netAmount).toBe('Havayolu Konşimentosu Toplam Tutar');
      expect(mapping.shipDate).toBe('Gönderi Tarihi');
      expect(mapping.destCountry).toBe('Alıcının Adresi Ülke/Bölge');
      expect(mapping.actualKg).toBe('Asıl Ağırlık');
      expect(mapping.billedKg).toBe('Ücretlendirilen Ağırlık Miktarı');
      expect([mapping.dimL, mapping.dimW, mapping.dimH]).toEqual(['Boyut Uzunluğu', 'Boyut Genişliği', 'Boyut Yüksekliği']);
      expect(mapping.dimUnit).toBe('Boyut Birimi');
      expect(mapping.actualKgUnit).toBe('Asıl Ağırlık Birimleri');
      expect(mapping.billedKgUnit).toBe('Ücretlendirilen Ağırlık Birimleri');
      expect(mapping.currency).toBe('Faturalanan Para Birimi');
      expect(mapping.chargePairs).toHaveLength(6);
      expect(mapping.surchargeColumns).toEqual([]);
      expect(mapping.dims).toBeUndefined();
      if (carrier === 'fedex') expect(mapping.service).toBe('SvcPkg Etiketi');
    });
  }

  it('satırlar olmadan (yalnız başlıklar) da FedEx kalıbı boş MPS sütununu seçmez', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex');
    expect(mapping.trackingNo).toBe('Havayolu Konşimentosu Numarası');
    expect(mapping.netAmount).toBe('Havayolu Konşimentosu Toplam Tutar');
  });

  it('satırları okur: çiftler, birim dönüşümü, tarih ve sayı biçimi', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    const { lines, errors } = parseRows(t, mapping);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(8);
    expect(sumMoney(lines.map((l) => l.netAmount))).toBe(10180);

    const [a, b, c, d] = lines;
    expect(a).toMatchObject({
      trackingNo: '870000000011',
      shipDate: '2026-10-13',
      service: 'FedEx Intl Priority',
      destCountry: 'IT',
      actualKg: 2.8,
      billedKg: 2.8,
      dims: { l: 31, w: 31, h: 14 },
      baseAmount: 1639.15,
      discountAmount: 1099.91,
      fuelAmount: 29.4,
      netAmount: 680.28,
      currency: 'TRY',
    });
    expect(a!.surcharges).toEqual([
      { code: 'ITHALAT_HIZMET_UCRETI', name: 'İthalat Hizmet Ücreti', amount: 46.35 },
      { code: 'EPH_UCRETI', name: 'EPH ÜCRETİ (%2,35)', amount: 15.45 },
      { code: 'PEAK', name: 'Demand Surcharge', amount: 49.84 },
    ]);
    // inç → cm, lb → kg
    expect(b!.dims).toEqual({ l: 48.26, w: 33.02, h: 30.48 });
    expect(b!.actualKg).toBe(2.812);
    expect(b!.billedKg).toBe(3.175);
    expect(b!.surcharges.map((s) => s.code)).toEqual(['EPH_UCRETI', 'PEAK']);
    // ölçüsüz, sırası karışık satır
    expect(c!.dims).toBeUndefined();
    expect(c).toMatchObject({ baseAmount: 610.4, discountAmount: 410.33, fuelAmount: 8.15, netAmount: 270.87, service: 'FedEx Intl Priority Pak' });
    expect(c!.surcharges.map((s) => s.code).sort()).toEqual(['EPH_UCRETI', 'ITHALAT_HIZMET_UCRETI', 'PEAK']);
    // yalnız 4 çift dolu
    expect(d).toMatchObject({ billedKg: 9.7, baseAmount: 5318.15, discountAmount: 3564.37, fuelAmount: 101.17, netAmount: 1901.3 });
    expect(lines.filter((l) => l.dims)).toHaveLength(5);

    for (const l of lines) {
      const parts = sumMoney([l.baseAmount ?? 0, -(l.discountAmount ?? 0), l.fuelAmount ?? 0, ...l.surcharges.map((s) => s.amount)]);
      expect({ t: l.trackingNo, parts }).toEqual({ t: l.trackingNo, parts: l.netAmount });
      expect(JSON.stringify(l)).not.toMatch(/Sample Street|Test Alıcı|Deneme Sok/);
    }
  });

  it('fatura no / tarih / para birimini sütunlardan tahmin eder', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    expect(guessInvoiceMeta(t, mapping)).toEqual({ invoiceNo: '999000111', invoiceDate: '2026-10-28', currency: 'TRY' });
  });

  it('meta sütunlarını eşlemeye yazar', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    expect(mapping).toMatchObject({ invoiceNo: 'FedEx Fatura Numarası', invoiceDate: 'Fatura Tarihi', invoiceTotal: 'Orijinal Ödenecek Tutar' });
  });

  it('tanılama: yapılandırılmış; doğru eşleme 8/8, boş takip sütunu 0 satır + uyarı', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    const ok = mappingDiagnostics(t, mapping);
    expect(ok).toMatchObject({
      rowCount: 8,
      trackingFilled: 8,
      parsedLines: 8,
      netTotal: 10180,
      numberFormat: 'en',
      numberFormatSource: 'detected',
      dateOrder: 'dmy',
      charges: { pairs: 6, rowsChecked: 8, rowsMatchingNet: 8, tolerance: 0.05 },
      invoiceTotal: { header: 'Orijinal Ödenecek Tutar', value: 10180, linesTotal: 10180, difference: 0 },
      warnings: [],
    });
    expect(ok.fields.trackingNo).toEqual({ header: 'Havayolu Konşimentosu Numarası', filled: 8, distinct: 8 });
    expect(ok.fields.dimL?.filled).toBe(5);
    expect(ok.charges.labels.find((l) => l.label === 'Demand Surcharge')).toEqual({ label: 'Demand Surcharge', kind: 'surcharge', code: 'PEAK', rows: 7 });
    expect(ok.charges.labels.find((l) => l.label === 'Taşıma Ücreti')).toMatchObject({ kind: 'base', rows: 8 });

    const bad = mappingDiagnostics(t, { ...mapping, trackingNo: 'MPS Paketi Takip Numarası' });
    expect(bad.trackingFilled).toBe(0);
    expect(bad.parsedLines).toBe(0);
    expect(bad.warnings.map((w) => w.code)).toContain('TRACKING_EMPTY');
    expect(bad.warnings.find((w) => w.code === 'TRACKING_EMPTY')!.message).toMatch(/hiçbir satırda dolu değil/);

    const totalAsNet = mappingDiagnostics(t, { ...mapping, netAmount: 'Orijinal Ödenecek Tutar' });
    expect(totalAsNet.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['NET_CONSTANT', 'TOTAL_MISMATCH']));
  });

  it('eşleme JSON ipuçları: etiket geçersiz kılma, sabit birim, sayı biçimi', () => {
    const { mapping } = suggestMapping(t.headers, 'fedex', t.rows);
    const json = JSON.parse(
      JSON.stringify({
        ...mapping,
        chargeLabelOverrides: [
          { label: 'EPH Ücreti (%2,35)', kind: 'surcharge', code: 'EPH' },
          { label: 'İthalat Hizmet Ücreti', kind: 'base' },
        ],
        dimUnit: undefined,
        defaultDimUnit: 'in',
        numberFormat: 'en',
      }),
    );
    const { lines } = parseRows(t, json);
    expect(lines[0]!.dims).toEqual({ l: 78.74, w: 78.74, h: 35.56 });
    expect(lines[0]!.baseAmount).toBe(1685.5);
    expect(lines[0]!.surcharges.map((s) => s.code)).toEqual(['EPH', 'PEAK']);
    // KALANLAR 1.4: dosyada İngilizce kanıt var; ipucu aynı yönde olsa da kaynak dosyanın kendisi
    expect(mappingDiagnostics(t, json)).toMatchObject({ numberFormat: 'en', numberFormatSource: 'detected', charges: { rowsMatchingNet: 8 } });
  });
});

describe('veriye duyarlı eşleme', () => {
  it('tüm satırlarda boş takip sütununu atlar', () => {
    const t = tableFromMatrix([
      ['MPS Takip Numarası', 'Paket Takip Numarası Bilgisi', 'Tutar'],
      ['', '111111111111', '10,00'],
      ['', '222222222222', '12,00'],
    ]);
    expect(suggestMapping(t.headers, 'generic').mapping.trackingNo).toBe('MPS Takip Numarası');
    expect(suggestMapping(t.headers, 'generic', t.rows).mapping.trackingNo).toBe('Paket Takip Numarası Bilgisi');
  });

  it('fatura toplamını satır tutarı saymaz', () => {
    const headers = ['Tracking ID', 'Original Amount Due', 'Net Charge Amount'];
    expect(suggestMapping(headers, 'fedex').mapping.netAmount).toBe('Net Charge Amount');
    expect(suggestMapping(['Takip No', 'Orijinal Ödenecek Tutar', 'Toplam Standart Ücretler'], 'generic').mapping.netAmount).toBeUndefined();
  });
});

describe('FedEx Billing Online (EN) başlıkları', () => {
  const H = [
    'Invoice Number', 'Invoice Date', 'Express or Ground Tracking ID', 'Shipment Date', 'Service Type', 'Actual Weight Amount',
    'Actual Weight Units', 'Rated Weight Amount', 'Rated Weight Units', 'Dim Length', 'Dim Width', 'Dim Height', 'Dim Unit',
    'Recipient Country/Territory', 'Original Amount Due', 'Net Charge Amount',
    'Tracking ID Charge Description', 'Tracking ID Charge Amount', 'Tracking ID Charge Description', 'Tracking ID Charge Amount',
    'Tracking ID Charge Description', 'Tracking ID Charge Amount',
  ];
  const t = tableFromMatrix([
    H,
    ['123456789', '10/28/2026', '794800000001', '10/22/2026', 'International Priority', '5.5', 'L', '6', 'L', '12', '10', '8', 'I', 'US', '1,700.00', '1,234.56',
      'Transportation Charge', '1,500.00', 'Earned Discount', '-400.00', 'Fuel Surcharge', '134.56'],
    ['123456789', '10/28/2026', '794800000002', '10/23/2026', 'International Economy', '2', 'K', '2', 'K', '', '', '', '', 'DE', '1,700.00', '465.44',
      'Residential Delivery', '15.44', 'Transportation Charge', '450.00', '', ''],
  ]);

  it('eşler, çiftleri ve birimleri okur, ABD tarih sırasını anlar', () => {
    const { mapping, missing } = suggestMapping(t.headers, 'fedex', t.rows);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({
      trackingNo: 'Express or Ground Tracking ID',
      netAmount: 'Net Charge Amount',
      actualKg: 'Actual Weight Amount',
      actualKgUnit: 'Actual Weight Units',
      billedKg: 'Rated Weight Amount',
      billedKgUnit: 'Rated Weight Units',
      dimL: 'Dim Length',
      dimUnit: 'Dim Unit',
      destCountry: 'Recipient Country/Territory',
    });
    expect(mapping.chargePairs).toHaveLength(3);
    const { lines, errors } = parseRows(t, mapping);
    expect(errors).toEqual([]);
    expect(lines[0]).toMatchObject({
      shipDate: '2026-10-22',
      actualKg: 2.495,
      billedKg: 2.722,
      dims: { l: 30.48, w: 25.4, h: 20.32 },
      baseAmount: 1500,
      discountAmount: 400,
      fuelAmount: 134.56,
      netAmount: 1234.56,
    });
    expect(lines[1]!.surcharges).toEqual([{ code: 'RESIDENTIAL', name: 'Residential Delivery', amount: 15.44 }]);
    expect(guessInvoiceMeta(t, mapping)).toMatchObject({ invoiceNo: '123456789', invoiceDate: '2026-10-28' });
  });
});

describe('değer yardımcıları', () => {
  it('sayı biçimi tespiti ve okuma', () => {
    expect(detectNumberFormat(['1,639.15', '-266,873.36', '0.5'])).toBe('en');
    expect(detectNumberFormat(['1.639,15', '4,0'])).toBe('tr');
    expect(detectNumberFormat(['12', '1,234'])).toBe('auto');
    expect(parseNumberAs('1,010', 'en')).toBe(1010);
    expect(parseNumberAs('2.500', 'en')).toBe(2.5);
    expect(parseNumberAs('-1,099.91', 'en')).toBe(-1099.91);
    expect(parseNumberAs('2.500', 'tr')).toBe(2500);
  });

  it('tarih biçimleri', () => {
    expect(parseDateAs('20261013', 'dmy')).toBe('2026-10-13');
    expect(parseDateAs('28-Oct-2026', 'dmy')).toBe('2026-10-28');
    expect(detectDateOrder(['10/27/2026', '11/02/2026'])).toBe('mdy');
    expect(detectDateOrder(['27/10/2026', '02/11/2026'])).toBe('dmy');
    expect(parseDateAs('11/02/2026', 'mdy')).toBe('2026-11-02');
    expect(parseDateAs('11/02/2026', 'dmy')).toBe('2026-02-11');
  });

  it('birimler', () => {
    expect(lengthFactor('I')).toBe(2.54);
    expect(lengthFactor('C')).toBe(1);
    expect(lengthFactor('')).toBe(1);
    expect(weightFactor('L')).toBe(0.45359237);
    expect(weightFactor('LBS')).toBe(0.45359237);
    expect(weightFactor('K')).toBe(1);
  });

  it('ücret etiketi sınıflandırma (TR + EN)', () => {
    expect(classifyCharge('Taşıma Ücreti').kind).toBe('base');
    expect(classifyCharge('Transportation Charge').kind).toBe('base');
    expect(classifyCharge('İndirim').kind).toBe('discount');
    expect(classifyCharge('Performance Pricing', -20).kind).toBe('discount');
    expect(classifyCharge('Yakıt Ek Ücreti').kind).toBe('fuel');
    expect(classifyCharge('Fuel Surcharge').kind).toBe('fuel');
    expect(classifyCharge('Demand Surcharge')).toEqual({ kind: 'surcharge', code: 'PEAK', name: 'Demand Surcharge' });
    expect(classifyCharge('Address Correction')).toMatchObject({ kind: 'surcharge', code: 'ADDRESS_CORRECTION' });
    expect(classifyCharge('Bilinmeyen Ücret X')).toEqual({ kind: 'surcharge', code: 'BILINMEYEN_UCRET_X', name: 'Bilinmeyen Ücret X' });
  });
});
