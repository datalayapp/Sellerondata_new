import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTariffImport,
  cleanZoneLabel,
  compareWithCurrent,
  expectedCharge,
  fmtRowList,
  OPEN_WEIGHT,
  packagingRowLabel,
  parsePackagingLabel,
  parseTariffImport,
  parseWeightCell,
  rawRowsText,
  readTariffFile,
  tariffImportFixes,
  zoneKey,
  type RawTariffFile,
  type TariffImportContext,
  type TariffInput,
} from '../src/index';

const SAMPLES = path.resolve(import.meta.dirname, '../../../samples');
const IPE = path.join(SAMPLES, 'tariffs/fedex-us-list-ipe.csv');
const TEMPLATE = path.join(SAMPLES, 'tariff-template-example.xlsx');

const codes = (issues: { code: string; severity: string }[], severity?: string) =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

const AtoO = 'ABCDEFGHIJKLMNO'.split('');

function ctx(over: Partial<TariffImportContext> = {}): TariffImportContext {
  return {
    tariffCurrency: 'TRY',
    currentZones: AtoO.map((z, i) => ({ country: ['DE', 'FR', 'GB', 'US', 'JP', 'CN', 'AE', 'SA', 'NL', 'BR', 'AU', 'ZA', 'NG', 'CA', 'MX'][i]!, zone: z })),
    currentRates: [],
    ...over,
  };
}

describe('zoneKey / cleanZoneLabel', () => {
  it.each([
    ['Zone A ', 'A'],
    ['zone  b', 'B'],
    ['ZONE-B', 'B'],
    ['Bölge 3', '3'],
    ['BÖLGE 3', '3'],
    ['bolge_4', '4'],
    ['Region EU', 'EU'],
    ['Zone3', '3'],
    ['Z1', 'Z1'],
    ['EU', 'EU'],
    ['WW', 'WW'],
    ['*', '*'],
    ['Zonealpha', 'ZONEALPHA'],
  ])('%s → %s', (raw, key) => {
    expect(zoneKey(raw)).toBe(key);
  });

  it('görünen ad büyük/küçük harfi korur', () => {
    expect(cleanZoneLabel('  Zone   A  ')).toBe('A');
    expect(cleanZoneLabel('Bölge Avrupa 1')).toBe('Avrupa 1');
  });

  it('ratePrice / taşma "A" eşlemesini "Zone A" fiyatlarıyla eşleştirir', () => {
    const t: TariffInput = {
      id: 't',
      currency: 'TRY',
      divisor: 5000,
      edgeRounding: 'CEIL_CM',
      weightSteps: [],
      discountPct: 0,
      fuelPct: 0,
      zones: { DE: 'A' },
      rates: [
        { zone: 'Zone A ', weightUpto: 1, price: 100 },
        { zone: 'Zone A ', weightUpto: 2, price: 150 },
      ],
      overflowPerUnit: { 'zone a': 10 },
      surcharges: [],
    };
    expect(expectedCharge({ tariff: t, chargeableKg: 1.5, destCountry: 'DE' })).toMatchObject({ ok: true, zone: 'A', total: 150 });
    expect(expectedCharge({ tariff: t, chargeableKg: 4, destCountry: 'DE' })).toMatchObject({ ok: true, total: 170 });
  });
});

describe('parseWeightCell / fmtRowList', () => {
  it('birimli ağırlıklar', () => {
    expect(parseWeightCell('1 lb.')).toBe(1);
    expect(parseWeightCell('2 lbs.')).toBe(2);
    expect(parseWeightCell('0,5')).toBe(0.5);
    expect(parseWeightCell('≤ 2 kg')).toBe(2);
    expect(parseWeightCell('FedEx® Pak 1 lb.')).toBeNull();
    expect(parseWeightCell('FedEx® Envelope up to 8 oz.')).toBeNull();
  });
  it('satır aralıkları', () => {
    expect(fmtRowList([7, 5, 6, 9, 12, 13])).toBe('5–7, 9, 12–13');
  });
});

describe('IPE.csv (FedEx U.S. list rates, lb/USD)', () => {
  let raw: RawTariffFile;
  it('okunur, bölgeler A..O olarak temizlenir', async () => {
    raw = await readTariffFile('IPE.csv', new Uint8Array(fs.readFileSync(IPE)));
    expect(raw.kind).toBe('csv');
    const p = parseTariffImport(raw);
    expect(p.priceZones).toEqual(AtoO);
    expect(p.detectedWeightUnit).toBe('lb');
    expect(p.detectedCurrency).toBe('USD');
    expect(p.titleLines[0]).toMatch(/FedEx U\.S\. Package Standard List Rates/);
    expect(p.titleLines[0]).toContain('®'); // Windows-1252 ® doğru çözülür
    const weights = [...new Set(p.rates.map((r) => r.weightUpto))].sort((a, b) => a - b);
    expect(weights[0]).toBe(1);
    expect(weights[weights.length - 1]).toBe(100);
    expect(weights).toHaveLength(100);
    expect(p.rates.find((r) => r.zone === 'A' && r.weightUpto === 1)?.price).toBe(132.61);
    expect(p.rates.find((r) => r.zone === 'B' && r.weightUpto === 88)?.price).toBe(1055.95);
    expect(p.extraTables.length).toBe(3);
    // Envelope / Pak satırları (5–7) atlanmaz: ayrı Pak / Zarf fiyatları (lb tablosunda "8 oz" = 0,5 lb)
    expect(p.skipped.find((s) => s.row >= 5 && s.row <= 7)).toBeUndefined();
    expect(p.packagingRates).toHaveLength(45);
    expect(p.packagingRates.filter((r) => r.zone === 'A').map((r) => [r.packaging, r.weightUpto, r.price, r.row])).toEqual([
      ['ENVELOPE', 0.5, 65.5, 5],
      ['PAK', 1, 109.75, 6],
      ['PAK', 2, 121.25, 7],
    ]);
    expect(p.rates.some((r) => r.packaging != null)).toBe(false);
  });

  it('kontroller: lb + USD hata, A eşlemesiyle bölge eksikliği yok', () => {
    const p = parseTariffImport(raw);
    const issues = checkTariffImport(p, ctx({ recent: { countries: ['DE', 'US'], currencies: ['TRY'] } }));
    const errors = codes(issues, 'error');
    expect(errors).toContain('WEIGHT_UNIT_LB');
    expect(errors).toContain('CURRENCY_MISMATCH');
    expect(errors).not.toContain('ZONE_MAPPING_MISSING');
    // zarf/pak ve açıklama satırları uyarı değil, özet bilgide
    expect(codes(issues, 'warning')).toContain('MULTIPLE_SECTIONS');
    expect(codes(issues, 'warning')).not.toContain('SKIPPED_ROWS');
    expect(codes(issues, 'info')).toContain('SUMMARY');
    expect(issues.filter((i) => i.severity === 'info').length).toBeLessThanOrEqual(3);
    const summary = issues.find((i) => i.code === 'SUMMARY')!;
    expect(summary.detail).toContain('CSV dosyasından yalnız fiyatlar');
    expect(summary.detail).toContain('Bölge adları sadeleştirildi');
    expect(summary.detail).toContain('30 poşet (Pak) ve 15 zarf fiyatı ayrı alındı');
    // sıralama: önce hatalar
    const sev = issues.map((i) => i.severity);
    expect(sev.indexOf('warning')).toBeGreaterThan(sev.lastIndexOf('error'));
    expect(tariffImportFixes(p, ctx()).map((f) => f.id)).toEqual(['convertLbToKg', 'setCurrency']);
  });

  it('seçenekler uygulanınca hatalar kalkar; ağırlıklar kg olur', () => {
    const options = { convertLbToKg: true, currency: 'USD' };
    const p = parseTariffImport(raw, options);
    expect(p.rates.find((r) => r.zone === 'A' && r.price === 132.61)?.weightUpto).toBe(0.454);
    expect(Math.max(...p.rates.map((r) => r.weightUpto))).toBe(45.359);
    expect(p.packagingRates.filter((r) => r.zone === 'A').map((r) => [r.packaging, r.weightUpto, r.price])).toEqual([
      ['ENVELOPE', 0.227, 65.5],
      ['PAK', 0.454, 109.75],
      ['PAK', 0.907, 121.25],
    ]);
    const issues = checkTariffImport(p, ctx({ recent: { countries: ['DE'], currencies: ['TRY'] } }), options);
    expect(codes(issues, 'error')).toEqual([]);
    expect(codes(issues, 'info')).toEqual(expect.arrayContaining(['CONVERSIONS', 'CURRENCY_VS_INVOICES']));
    expect(issues.find((i) => i.code === 'CONVERSIONS')!.title).toContain('USD');
    expect(issues.find((i) => i.code === 'CURRENCY_VS_INVOICES')!.title).toBe('Faturalarınız TRY; karşılaştırmada TCMB kuruyla çevrilir.');
  });

  it('"Zone A" eşlemesi yoksa bölge eksikliği hata', () => {
    const p = parseTariffImport(raw, { convertLbToKg: true, currency: 'USD' });
    const issues = checkTariffImport(p, ctx({ currentZones: [{ country: 'DE', zone: 'A' }, { country: 'JP', zone: 'Z' }] }), { currency: 'USD' });
    const miss = issues.find((i) => i.code === 'ZONE_MAPPING_MISSING');
    expect(miss?.severity).toBe('error');
    expect(miss?.detail).toContain('Z');
    expect(miss?.detail).toContain('Dosyadaki bölgeler: A, B');
  });

  it('ham satır dökümü', () => {
    const r = rawRowsText(raw.prices, 400);
    expect(r.truncated).toBe(false);
    expect(r.text.split('\n')[0]).toMatch(/^1: FedEx U\.S\./);
    const short = rawRowsText(raw.prices, 20);
    expect(short.truncated).toBe(true);
    expect(short.text).toContain('satır atlandı');
  });
});

describe('örnek şablon (temiz dosya)', () => {
  it('hata yok', async () => {
    const raw = await readTariffFile('ornek.xlsx', new Uint8Array(fs.readFileSync(TEMPLATE)));
    const p = parseTariffImport(raw);
    expect(p.sheets).toEqual({ prices: true, zones: true, surcharges: true });
    expect(p.detectedWeightUnit).toBe('kg');
    const issues = checkTariffImport(p, ctx({ currentZones: [], recent: { countries: [], currencies: ['TRY'] } }));
    expect(codes(issues, 'error')).toEqual([]);
    expect(p.rates.length).toBeGreaterThan(50);
  });
});

describe('yapısal hatalar', () => {
  const sheet = (rows: string[][]): RawTariffFile => ({ fileName: 'x.csv', kind: 'csv', prices: rows, zones: null, surcharges: null });
  const c = ctx({ currentZones: [{ country: 'DE', zone: 'A' }, { country: 'GB', zone: 'B' }] });

  it('mükerrer ağırlık, okunamayan fiyat, düşen fiyat, sıçrama, eksik bölge', () => {
    const p = parseTariffImport(
      sheet([
        ['Ağırlık', 'A', 'C'],
        ['1', '100', '120'],
        ['2', '90', 'abc'],
        ['2', '95', '130'],
        ['3', '400', '-5'],
        [''],
        ['Not: KDV hariç', '', ''],
      ]),
    );
    const issues = checkTariffImport(p, c);
    expect(codes(issues, 'error')).toEqual(expect.arrayContaining(['DUPLICATE_WEIGHT', 'INVALID_PRICE', 'ZONE_MAPPING_MISSING']));
    expect(issues.find((i) => i.code === 'INVALID_PRICE')?.rows).toEqual([3, 5]);
    expect(codes(issues, 'warning')).toEqual(expect.arrayContaining(['PRICE_DECREASES', 'PRICE_JUMP', 'MAX_WEIGHT_LOW']));
    // "Not: KDV hariç" açıklama satırı → uyarı değil
    expect(codes(issues, 'warning')).not.toContain('SKIPPED_ROWS');
  });

  it('ağırlığı okunamayan fiyat satırı uyarıdır', () => {
    const p = parseTariffImport(sheet([['Ağırlık', 'A'], ['1', '100'], ['iki', '120'], ['3', '140']]));
    const w = checkTariffImport(p, c).find((i) => i.code === 'SKIPPED_ROWS')!;
    expect(w).toMatchObject({ severity: 'warning', rows: [3] });
  });

  it('fiyat yok / bölge sütunu yok', () => {
    expect(codes(checkTariffImport(parseTariffImport(sheet([['', ''], []])), c), 'error')).toContain('NO_RATES');
    expect(codes(checkTariffImport(parseTariffImport(sheet([['Ağırlık', ''], ['1', '']])), c), 'error')).toEqual(['NO_ZONE_COLUMNS']);
  });

  it('eşleme yok, son fatura ülkeleri, para birimi, büyük değişim', () => {
    const p = parseTariffImport(sheet([['kg', 'A', 'B'], ['1', '100', '110'], ['40', '900', '990'], ['Aşım', '10', '12']]));
    expect(codes(checkTariffImport(p, ctx({ currentZones: [] })), 'warning')).toContain('NO_COUNTRY_MAPPING');
    const issues = checkTariffImport(
      p,
      { ...c, currentRates: [{ zone: 'Zone A', weightUpto: 1, price: 30 }, { zone: 'B', weightUpto: 1, price: 105 }], recent: { countries: ['DE', 'FR', 'IT'], currencies: ['EUR'] } },
    );
    expect(codes(issues, 'warning')).toEqual(expect.arrayContaining(['RECENT_COUNTRIES_UNMAPPED', 'BIG_CHANGE_VS_CURRENT']));
    expect(codes(issues, 'info')).toContain('CURRENCY_VS_INVOICES');
    expect(issues.find((i) => i.code === 'RECENT_COUNTRIES_UNMAPPED')?.detail).toContain('FR, IT');
    expect(compareWithCurrent(p.rates, [{ zone: 'Zone A', weightUpto: 1, price: 50 }])).toEqual([{ zone: 'A', oldMedian: 50, newMedian: 100, ratio: 2 }]);
  });
});

describe('poşet / zarf (Pak / Envelope) satırları, bütün taşıyıcılar', () => {
  const sheet = (rows: string[][], kind: RawTariffFile['kind'] = 'csv'): RawTariffFile => ({ fileName: 'x.csv', kind, prices: rows, zones: null, surcharges: null });
  const c = ctx({ currentZones: [{ country: 'DE', zone: 'A' }, { country: 'GB', zone: 'B' }] });

  it('etiketler: FedEx, UPS, DHL, yurt içi; birim, aralık, ağırlıksız; kutu ve non-documents poşet/zarf değil', () => {
    expect(parsePackagingLabel('FedEx® Envelope up to 8 oz.')).toEqual({ packaging: 'ENVELOPE', weight: 8, unit: 'oz', anyWeight: false });
    expect(parsePackagingLabel('FedEx® Pak 1 lb.')).toEqual({ packaging: 'PAK', weight: 1, unit: 'lb', anyWeight: false });
    expect(parsePackagingLabel('UPS Express Envelope')).toEqual({ packaging: 'ENVELOPE', weight: null, unit: null, anyWeight: true });
    expect(parsePackagingLabel('UPS Express Pak 1 kg')).toEqual({ packaging: 'PAK', weight: 1, unit: 'kg', anyWeight: false });
    expect(parsePackagingLabel('UPS Letter')).toMatchObject({ packaging: 'ENVELOPE', anyWeight: true });
    expect(parsePackagingLabel('DHL Flyer 0,5 - 2 kg')).toEqual({ packaging: 'PAK', weight: 2, unit: 'kg', anyWeight: false });
    // "Document" belge ürünüdür, zarf değil (DHL Documents 0,5–2 kg); açıkça "Envelope" yazan zarftır
    expect(parsePackagingLabel('DHL Express Document 0,5')).toBeNull();
    expect(parsePackagingLabel('DHL Express Envelope 0,3 kg')).toEqual({ packaging: 'ENVELOPE', weight: 0.3, unit: 'kg', anyWeight: false });
    // dışlama / olumsuzlama: kendi ambalajı
    expect(parsePackagingLabel('Your Packaging (non-Pak) 1')).toBeNull();
    expect(parsePackagingLabel('Pak hariç 1 kg')).toBeNull();
    expect(parsePackagingLabel('Pak 1 kg (KDV hariç)')).toMatchObject({ packaging: 'PAK' });
    expect(parsePackagingLabel('Dosya')).toMatchObject({ packaging: 'ENVELOPE', anyWeight: true });
    expect(parsePackagingLabel('Evrak')).toMatchObject({ packaging: 'ENVELOPE', anyWeight: true });
    expect(parsePackagingLabel('Poşet 2 kg')).toMatchObject({ packaging: 'PAK', weight: 2 });
    expect(parsePackagingLabel("Zarf 0,5 kg'a kadar")).toMatchObject({ packaging: 'ENVELOPE', weight: 0.5, unit: 'kg' });
    // ikisi birden: hangisi belli değil; sayı var ama okunamıyor: ağırlıksız sayılmaz
    expect(parsePackagingLabel('Zarf/Pak 0,5')).toMatchObject({ packaging: null });
    expect(parsePackagingLabel('IP Pak 2 lbs')).toEqual({ packaging: 'PAK', weight: null, unit: null, anyWeight: false });
    expect(parsePackagingLabel('UPS Express Box 10 kg')).toBeNull();
    expect(parsePackagingLabel('Non-documents 0,5')).toBeNull();
    expect(parsePackagingLabel('2')).toBeNull();
    expect(packagingRowLabel('PAK', '0,5')).toBe('Pak 0,5');
    expect(packagingRowLabel('ENVELOPE')).toBe('Zarf');
  });

  it('ara başlıklı bölümler (FedEx TR düzeni): zarf / poşet / diğer ambalaj; İndirim sütunu ambalaja göre', () => {
    const p = parseTariffImport(
      sheet([
        ['Ağırlık (kg)', 'A', 'B', 'İndirim %'],
        ['Zarf/Pak (0,5 - 2,5 kg) kullanıldığında ücretler', '', '', ''],
        ['Envelope', '', '', ''],
        ['0,5', '9,10', '9,90', '50'],
        ['Pak', '', '', ''],
        ['0,5', '9,20', '9,95', '51'],
        ['1', '10,00', '11,00', '51'],
        ['Diğer ambalaj malzemeleri kullanıldığında ücretler', '', '', ''],
        ['0,5', '11,10', '15,30', '60'],
        ['1', '12,40', '16,80', '60'],
      ]),
    );
    expect(p.rates.map((r) => [r.zone, r.weightUpto, r.price])).toEqual([
      ['A', 0.5, 11.1],
      ['B', 0.5, 15.3],
      ['A', 1, 12.4],
      ['B', 1, 16.8],
    ]);
    expect(p.packagingRates.map((r) => [r.packaging, r.zone, r.weightUpto, r.price])).toEqual([
      ['ENVELOPE', 'A', 0.5, 9.1],
      ['ENVELOPE', 'B', 0.5, 9.9],
      ['PAK', 'A', 0.5, 9.2],
      ['PAK', 'B', 0.5, 9.95],
      ['PAK', 'A', 1, 10],
      ['PAK', 'B', 1, 11],
    ]);
    expect([p.discountPct, p.pakDiscountPct, p.envelopeDiscountPct]).toEqual([60, 51, 50]);
    expect(p.extraTables).toEqual([]);
    const issues = checkTariffImport(p, c);
    expect(codes(issues, 'error')).toEqual([]);
    expect(codes(issues, 'warning')).not.toContain('SKIPPED_ROWS');
  });

  it('UPS / DHL düzeni: etiketli satırlar; "Documents" bölümü zarf değil (uyarıyla alınmaz); "Non-documents" kendi ambalajına döner; kutu satırı alınmaz', () => {
    const p = parseTariffImport(
      sheet([
        ['Weight (kg)', 'Zone A', 'Zone B'],
        ['UPS Express Envelope', '20,00', '22,00'],
        ['UPS Express Pak 1 kg', '30,00', '33,00'],
        ['UPS Express Box 10 kg', '90,00', '99,00'],
        ['Documents', '', ''],
        ['0,5', '25,00', '27,00'],
        ['Non-documents', '', ''],
        ['0,5', '40,00', '44,00'],
        ['1', '45,00', '49,00'],
      ]),
    );
    expect(p.rates.map((r) => [r.zone, r.weightUpto, r.price])).toEqual([
      ['A', 0.5, 40],
      ['B', 0.5, 44],
      ['A', 1, 45],
      ['B', 1, 49],
    ]);
    expect(p.packagingRates.filter((r) => r.zone === 'A').map((r) => [r.packaging, r.weightUpto, r.price])).toEqual([
      ['ENVELOPE', OPEN_WEIGHT, 20],
      ['PAK', 1, 30],
    ]);
    expect(p.skipped.find((x) => x.row === 4)?.reason).toMatch(/Paket tipi/);
    const issues = checkTariffImport(p, c);
    const summary = issues.find((i) => i.code === 'SUMMARY')!;
    expect(summary.detail).toContain('2 poşet (Pak) ve 2 zarf fiyatı ayrı alındı');
    expect(summary.detail).toContain('2 poşet/zarf fiyatında ağırlık yazmıyor');
    const w = issues.find((i) => i.code === 'SKIPPED_ROWS')!;
    expect(w).toMatchObject({ severity: 'warning', rows: [6] });
    expect(w.detail).toContain('belge (documents) bölümü');
  });

  it('kendi ambalajı başlığı Pak / Zarf kelimesinden önce: "dışında", "non-", "dahil tüm" kendi ambalajıdır', () => {
    // (a) dışlayan başlık kendi ambalajı tablosunu atlatmaz
    const a = parseTariffImport(
      sheet([
        ['Ağırlık', 'A'],
        ['Envelope', ''],
        ['0,5', '9'],
        ['Diğer ambalaj malzemeleri (Zarf/Pak dışında) kullanıldığında', ''],
        ['0,5', '11'],
        ['1', '12'],
      ]),
    );
    expect(a.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [0.5, 11],
      [1, 12],
    ]);
    expect(a.packagingRates.map((r) => [r.packaging, r.weightUpto, r.price])).toEqual([['ENVELOPE', 0.5, 9]]);
    // (b) "Your Packaging (non-Pak)" altı Pak değil
    const b = parseTariffImport(
      sheet([
        ['Weight (kg)', 'Zone A'],
        ['FedEx Pak', ''],
        ['0,5', '20'],
        ['Your Packaging (non-Pak)', ''],
        ['0,5', '30'],
        ['1', '35'],
      ]),
    );
    expect(b.rates.map((r) => r.price)).toEqual([30, 35]);
    expect(b.packagingRates.map((r) => [r.packaging, r.price])).toEqual([['PAK', 20]]);
    // (c) tablonun ortasındaki "Pak dahil tüm gönderiler" başlığı altı kendi ambalajı; tablo bitmez
    const c3 = parseTariffImport(sheet([['Ağırlık', 'A'], ['0,5', '10'], ['1', '12'], ['Pak dahil tüm gönderiler', ''], ['1,5', '14'], ['2', '16']]));
    expect(c3.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [0.5, 10],
      [1, 12],
      [1.5, 14],
      [2, 16],
    ]);
    expect(c3.packagingRates).toEqual([]);
    // dışlama bitişik olmalı: "Pak (KDV hariç)" Pak bölümüdür
    const d = parseTariffImport(sheet([['Ağırlık', 'A'], ['Pak (KDV hariç)', ''], ['0,5', '7'], ['Diğer ambalaj', ''], ['0,5', '10'], ['1', '12']]));
    expect(d.packagingRates.map((r) => [r.packaging, r.price])).toEqual([['PAK', 7]]);
  });

  it('Pak bölümünden sonra tanınmayan başlık (koli satırları alındıktan sonra da) tabloyu bitirmez; altı uyarıyla alınmaz', () => {
    const p = parseTariffImport(sheet([['Ağırlık', 'A'], ['0,5', '10'], ['1', '12'], ['Pak', ''], ['0,5', '7'], ['Özel fiyatlar', ''], ['1,5', '14']]));
    expect(p.rates.map((r) => r.price)).toEqual([10, 12]);
    expect(p.packagingRates.map((r) => r.price)).toEqual([7]);
    const w = checkTariffImport(p, ctx({ currentZones: [{ country: 'DE', zone: 'A' }] })).find((i) => i.code === 'SKIPPED_ROWS')!;
    expect(w).toMatchObject({ severity: 'warning', rows: [7] });
  });

  it('emin olunamayan satır alınmaz, uyarıda görünür: ikisi birden, okunamayan ağırlık, bölümden sonra tanınmayan başlık', () => {
    const p = parseTariffImport(
      sheet([
        ['Ağırlık', 'A'],
        ['Pak', ''],
        ['0,5', '7'],
        ['Özel fiyatlar', ''],
        ['1', '8'],
        ['Diğer ambalaj', ''],
        ['0,5', '10'],
        ['1', '12'],
        ['Zarf/Pak 0,5', '5'],
        ['IP Pak 2 lbs', '6'],
      ]),
    );
    expect(p.rates.map((r) => r.price)).toEqual([10, 12]);
    expect(p.packagingRates.map((r) => [r.packaging, r.weightUpto, r.price])).toEqual([['PAK', 0.5, 7]]);
    const w = checkTariffImport(p, ctx({ currentZones: [{ country: 'DE', zone: 'A' }] })).find((i) => i.code === 'SKIPPED_ROWS')!;
    expect(w).toMatchObject({ severity: 'warning', rows: [5, 9, 10] });
    expect(w.detail).toContain('zarf mı pak mı belli değil');
    expect(w.detail).toContain('zarf/pak satırının ağırlığı okunamadı');
  });

  it('poşet satırlarının indirimi kendi içinde farklıysa indirim hatası (yanlış indirimle hesaplanmaz)', () => {
    const p = parseTariffImport(
      sheet([
        ['Ağırlık', 'A', 'İndirim'],
        ['Pak 0,5', '9', '30'],
        ['Pak 1', '10', '31'],
        ['0,5', '10', '40'],
        ['1', '12', '40'],
      ]),
    );
    expect(p.discountPct).toBe(40);
    expect(p.pakDiscountPct).toBeNull();
    expect(p.discountIssue).toEqual({ kind: 'mixed', values: ['Pak: 30', 'Pak: 31'] });
    expect(codes(checkTariffImport(p, ctx({ currentZones: [{ country: 'DE', zone: 'A' }] })), 'error')).toContain('MIXED_DISCOUNT');
    // aynı indirim: ayrı oran yok (null = tarifenin indirimi)
    const same = parseTariffImport(sheet([['Ağırlık', 'A', 'İndirim'], ['Pak 0,5', '9', '40'], ['0,5', '10', '40'], ['1', '12', '40']]));
    expect([same.discountPct, same.pakDiscountPct, same.discountIssue]).toEqual([40, null, null]);
  });

  it('kodla yazılan taslak (PDF): packagingRowLabel satırları aynı tarifede poşet / zarf; lb → kg', () => {
    const rows = [
      ['Ağırlık (lb)', 'A'],
      ['1', '10'],
      ['2', '12'],
      [packagingRowLabel('ENVELOPE', '0,5'), '5'],
      [packagingRowLabel('PAK', '1'), '7'],
      [packagingRowLabel('ENVELOPE'), '4'],
    ];
    const p = parseTariffImport(sheet(rows, 'pdf'), { convertLbToKg: true });
    expect(p.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [0.454, 10],
      [0.907, 12],
    ]);
    expect(p.packagingRates.map((r) => [r.packaging, r.weightUpto, r.price])).toEqual([
      ['ENVELOPE', 0.227, 5],
      ['PAK', 0.454, 7],
      ['ENVELOPE', OPEN_WEIGHT, 4],
    ]);
  });
});
