import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTariffImport,
  cleanZoneLabel,
  compareWithCurrent,
  expectedCharge,
  fmtRowList,
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
    expect(p.skipped.find((s) => s.row === 5)?.reason).toMatch(/Paket tipi/);
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
