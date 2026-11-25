// DENETIM-2 Mesaj 3: tarife tablosunda sayı biçimi (01-B6), lb çevriminde basamak (01-B5), indirim oranı ve işaretsiz
// açık uçlu satır (01-B12). Kural: biçim kanıtla belliyse ona göre oku; değilse eski okuma + kullanıcıya iki okuma.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  chargeableWeight,
  checkTariffImport,
  expectedCharge,
  importWeightSteps,
  lbStepKg,
  overflowUnits,
  openBandReading,
  parseTariffImport,
  ratePrice,
  readTariffFile,
  roundUpToStep,
  tableNumberFormat,
  tariffImportFixes,
  type RawTariffFile,
  type TariffImportContext,
  type TariffImportOptions,
} from '../src/index';

const csv = (prices: string[][]): RawTariffFile => ({ fileName: 'x.csv', kind: 'csv', prices, zones: null, surcharges: null });
const xlsxRaw = (prices: string[][], over: Partial<RawTariffFile> = {}): RawTariffFile => ({ fileName: 'x.xlsx', kind: 'xlsx', prices, zones: null, surcharges: null, ...over });
const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({ tariffCurrency: 'USD', currentZones: [{ country: '*', zone: 'A' }], currentRates: [], ...over });
const rates = (raw: RawTariffFile, o: TariffImportOptions = {}) => parseTariffImport(raw, o).rates.map((r) => [r.weightUpto, r.price]);
const codes = (raw: RawTariffFile, o: TariffImportOptions = {}, c: TariffImportContext = ctx()) =>
  checkTariffImport(parseTariffImport(raw, o), c, o).map((i) => `${i.severity}:${i.code}`);

async function xlsxBytes(build: (ws: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('Fiyatlar'));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('01-B6 sayı biçimi tespiti (CSV ve metin hücreleri)', () => {
  // denetçinin dosyası: ağırlıklar "1.000" (1 kg), fiyatlar "1,250" (bin iki yüz elli)
  const english = csv([
    ['Weight (kg)', 'Zone 1'],
    ['0.500', '45.20'],
    ['1.000', '52.10'],
    ['1.500', '58.00'],
    ['2.000', '63.40'],
    ['300', '1,250'],
    ['400', '1,610'],
  ]);

  it('İngilizce CSV: "1.000" 1 kg, "1,250" 1250; eskisinden farklı okunanlar iki okumasıyla gösterilir, biçim seçilmeden uygulanmaz', () => {
    expect(rates(english)).toEqual([
      [0.5, 45.2],
      [1, 52.1],
      [1.5, 58],
      [2, 63.4],
      [300, 1250],
      [400, 1610],
    ]);
    const p = parseTariffImport(english);
    expect(p.numberFormat).toEqual({ format: 'en', certain: false, chosen: false });
    const issues = checkTariffImport(p, ctx());
    const w = issues.find((i) => i.code === 'NUMBER_FORMAT_ASSUMED')!;
    expect(w.severity).toBe('error');
    // biçim seçilince çözülür (İngilizce de Türkçe de)
    for (const numberFormat of ['en', 'tr'] as const) {
      const o = { numberFormat };
      expect(codes(english, o).filter((c) => c.includes('NUMBER_FORMAT'))).toEqual([]);
    }
    expect(w.title).toBe('Sayılar İngilizce biçimde okundu; 5 sayı eskisinden farklı okunuyor');
    expect(w.detail).toContain('satır 3, ağırlık: "1.000" → Türkçe okunursa 1.000, İngilizce okunursa 1');
    expect(w.detail).toContain('satır 6, bölge 1: "1,250" → Türkçe okunursa 1,25, İngilizce okunursa 1.250');
    expect(w.rows).toEqual([3, 4, 5, 6, 7]);
    expect(issues.some((i) => i.code === 'NUMBER_FORMAT_UNCLEAR')).toBe(false);
    expect(tariffImportFixes(p, ctx()).map((f) => `${f.id}:${f.value}`)).toEqual(['numberFormat:tr', 'numberFormat:en']);
  });

  it('bin kat tuzağı: noktalı ağırlıklı Türkçe CSV ("0.5" kg, "1.250" TL) zayıf kanıtla İngilizce okunur ama uygulanmaz', () => {
    const tr = csv([['Ağırlık', 'A'], ['0.5', '1.250'], ['1.5', '1.500'], ['2.5', '1.750']]);
    const p = parseTariffImport(tr);
    expect(p.numberFormat).toMatchObject({ format: 'en', certain: false });
    // İngilizce okuma 1,25 TL: Türkçe dosyada bin kat düşük. Durdurur; Türkçe seçilince eski okuma.
    expect(p.rates.map((r) => r.price)).toEqual([1.25, 1.5, 1.75]);
    expect(codes(tr)).toContain('error:NUMBER_FORMAT_ASSUMED');
    expect(rates(tr, { numberFormat: 'tr' })).toEqual([
      [0.5, 1250],
      [1.5, 1500],
      [2.5, 1750],
    ]);
    expect(codes(tr, { numberFormat: 'tr' }).filter((c) => c.includes('NUMBER_FORMAT'))).toEqual([]);
  });

  it('İngilizce CSV, güçlü kanıt ("1,250.00"): biçim kesin, uyarı yok', () => {
    const p = parseTariffImport(csv([['Weight', 'A'], ['1.000', '1,250.00'], ['1.500', '1,500'], ['2', '1,610.25']]));
    expect(p.numberFormat).toMatchObject({ format: 'en', certain: true });
    expect(p.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [1, 1250],
      [1.5, 1500],
      [2, 1610.25],
    ]);
    expect(p.numberAmbiguities).toEqual([]);
  });

  it('Türkçe CSV: bugünkü okuma aynen (güçlü ve zayıf kanıt), uyarı yok', () => {
    const strong = csv([['Ağırlık', 'A'], ['0,5', '45,20'], ['1', '52,10'], ['1,5', '1.250'], ['2', '1.610,50']]);
    expect(rates(strong)).toEqual([
      [0.5, 45.2],
      [1, 52.1],
      [1.5, 1250],
      [2, 1610.5],
    ]);
    expect(parseTariffImport(strong).numberFormat).toMatchObject({ format: 'tr', certain: true });
    const weak = csv([['Desi', 'A'], ['0,5', '45,20'], ['1,5', '52,10'], ['2,5', '58,00'], ['3', '1.250']]);
    expect(rates(weak)).toEqual([
      [0.5, 45.2],
      [1.5, 52.1],
      [2.5, 58],
      [3, 1250],
    ]);
    expect(parseTariffImport(weak).numberFormat).toMatchObject({ format: 'tr', certain: false });
    for (const raw of [strong, weak]) expect(codes(raw).filter((c) => c.includes('NUMBER_FORMAT'))).toEqual([]);
  });

  it('belirsiz CSV: iki türlü okunan sayı uygulamayı durdurur, iki okuma gösterilir; biçim seçilince çözülür', () => {
    const raw = csv([['Ağırlık', 'A'], ['1', '1,250'], ['2', '1,500'], ['3', '1.750']]);
    const p = parseTariffImport(raw);
    expect(p.numberFormat).toEqual({ format: 'auto', certain: false, chosen: false });
    // eski okuma korunur (biçim bilinmiyor)
    expect(p.rates.map((r) => r.price)).toEqual([1.25, 1.5, 1750]);
    const err = checkTariffImport(p, ctx()).find((i) => i.code === 'NUMBER_FORMAT_UNCLEAR')!;
    expect(err.severity).toBe('error');
    expect(err.title).toBe('3 sayı iki türlü okunabiliyor; dosyanın sayı biçimi belli değil');
    expect(err.detail).toContain('satır 2, bölge A: "1,250" → Türkçe okunursa 1,25, İngilizce okunursa 1.250');
    expect(err.detail).toContain('satır 4, bölge A: "1.750" → Türkçe okunursa 1.750, İngilizce okunursa 1,75');
    expect(checkTariffImport(p, ctx(), {}, 'en').find((i) => i.code === 'NUMBER_FORMAT_UNCLEAR')!.detail).toContain(
      'row 2, zone A: "1,250" → Turkish reading 1.25, English reading 1,250',
    );
    const fixes = tariffImportFixes(p, ctx());
    expect(fixes.map((f) => `${f.id}:${f.value}`)).toEqual(['numberFormat:tr', 'numberFormat:en']);
    expect(fixes[0]!.label).toBe('Sayıları Türkçe oku (1.250 = bin iki yüz elli, 1,25 = bir virgül yirmi beş)');

    expect(rates(raw, { numberFormat: 'en' }).map((r) => r[1])).toEqual([1250, 1500, 1.75]);
    expect(rates(raw, { numberFormat: 'tr' }).map((r) => r[1])).toEqual([1.25, 1.5, 1750]);
    for (const numberFormat of ['tr', 'en'] as const) {
      const o = { numberFormat };
      const c = codes(raw, o);
      expect(c.filter((x) => x.startsWith('error:'))).toEqual([]);
      expect(c).toContain('info:CONVERSIONS');
      // seçim geri alınabilsin: seçenekler görünür kalır
      expect(tariffImportFixes(parseTariffImport(raw, o), ctx()).filter((f) => f.id === 'numberFormat')).toHaveLength(2);
    }
    expect(checkTariffImport(parseTariffImport(raw, { numberFormat: 'en' }), ctx(), { numberFormat: 'en' }).find((i) => i.code === 'CONVERSIONS')!.title).toBe(
      'Sayılar İngilizce biçimde okundu',
    );
  });

  it('belirsiz ağırlık ("1.500" kg mı 1500 kg mı) da durdurur', () => {
    const p = parseTariffImport(csv([['kg', 'A'], ['1', '10'], ['1.500', '12'], ['2', '14']]));
    expect(p.rates.map((r) => r.weightUpto)).toEqual([1, 1500, 2]);
    expect(p.numberAmbiguities).toEqual([{ row: 3, zone: null, text: '1.500', tr: 1500, en: 1.5, used: 1500 }]);
    expect(codes(csv([['kg', 'A'], ['1', '10'], ['1.500', '12'], ['2', '14']]))).toContain('error:NUMBER_FORMAT_UNCLEAR');
  });

  it('karışık dosya (Türkçe ve İngilizce kanıt birlikte): eski okuma, iki türlü okunan sayı durdurur', () => {
    const raw = csv([['Ağırlık', 'A'], ['0,5', '12.50'], ['1', '13,75'], ['2', '1.250']]);
    expect(parseTariffImport(raw).numberFormat.format).toBe('auto');
    expect(rates(raw)).toEqual([
      [0.5, 12.5],
      [1, 13.75],
      [2, 1250],
    ]);
    expect(codes(raw)).toContain('error:NUMBER_FORMAT_UNCLEAR');
    // iki türlü okunan sayı yoksa karışık dosya da eskisi gibi geçer
    expect(codes(csv([['Ağırlık', 'A'], ['0,5', '12.50'], ['1', '13,75']])).filter((c) => c.includes('NUMBER_FORMAT'))).toEqual([]);
  });

  it('tableNumberFormat: saat, yüzde ve tam 3 haneli tek ayırıcı kanıt değil', () => {
    expect(tableNumberFormat(['09.00', '%12.50', '1.250', '1,125', '7']).format).toBe('auto');
    expect(tableNumberFormat(['0.500', '12.5', '13.75'])).toMatchObject({ format: 'en', certain: false });
    expect(tableNumberFormat(['12.5', '13.75'])).toMatchObject({ format: 'auto' });
    expect(tableNumberFormat(['$1,070.06', '12,5'])).toMatchObject({ format: 'auto', certain: false });
  });

  it('PDF taslağı (kodla yazılmış hücreler): tespit yok, bugünkü okuma', () => {
    const raw: RawTariffFile = { fileName: 'x.pdf', kind: 'pdf', prices: [['Ağırlık', 'A'], ['0,5', '45.2'], ['1', '52.1'], ['1,5', '58.25'], ['2', '1,125']], zones: null, surcharges: null };
    const p = parseTariffImport(raw, { numberFormat: 'en' });
    expect(p.rates.map((r) => r.price)).toEqual([45.2, 52.1, 58.25, 1.125]);
    expect(p.numberAmbiguities).toEqual([]);
    expect(p.applied.numberFormat).toBeUndefined();
    expect(tariffImportFixes(p, ctx())).toEqual([]);
  });
});

describe('01-B6 XLSX: gerçek sayı hücresi biçimden bağımsız, metin hücresi biçimle', () => {
  it('sayı hücreleri (1,234 kg; 1,25 fiyat) İngilizce okunan dosyada da aynen; metin "1,250" 1250', async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(['Weight (kg)', 'A']);
      ws.addRow(['0.500', '45.20']);
      ws.addRow([1.234, 1.25]);
      ws.addRow(['1.500', '52.10']);
      ws.addRow([2, '58.00']);
      ws.addRow(['300', '1,250']);
    });
    const raw = await readTariffFile('x.xlsx', bytes);
    expect(raw.pricesNumeric).toEqual(['00', '00', '11', '00', '10', '00']);
    // taslakta JSON olarak saklanır: gidiş-dönüşte aynı
    const stored = JSON.parse(JSON.stringify(raw)) as RawTariffFile;
    const p = parseTariffImport(stored);
    expect(p.numberFormat).toMatchObject({ format: 'en', certain: false });
    expect(p.rates.map((r) => [r.weightUpto, r.price])).toEqual([
      [0.5, 45.2],
      [1.234, 1.25],
      [1.5, 52.1],
      [2, 58],
      [300, 1250],
    ]);
    // sayı hücreleri ("1,234", "1,25") ne kanıt ne belirsizlik sayılır
    expect(p.numberAmbiguities.map((a) => a.text)).toEqual(['1.500', '1,250']);
  });

  it('yalnız sayı hücreli XLSX (uygulamanın şablonu): soru yok', async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(['Ağırlık (kg/desi) ≤', 'A', 'İndirim %']);
      ws.addRow([0.5, 1.25, 38]);
      ws.addRow([1, 1250, null]);
      ws.addRow([1.5, 1.234, null]);
    });
    const p = parseTariffImport(await readTariffFile('x.xlsx', bytes));
    expect(p.rates.map((r) => r.price)).toEqual([1.25, 1250, 1.234]);
    expect(p.numberFormat.format).toBe('auto');
    expect(p.numberAmbiguities).toEqual([]);
    expect(p.discountPct).toBe(38);
  });
});

describe('01-B12 (a) İndirim oranı: %1 altı değer', () => {
  const base = [['Ağırlık', 'A', 'İndirim %'], ['1', '10', ''], ['2', '12', '']];
  const withDiscount = (cell: string, over: Partial<RawTariffFile> = {}) => {
    const rows = base.map((r) => [...r]);
    rows[1]![2] = cell;
    return xlsxRaw(rows, over);
  };

  it('biçimsiz 0–1 değer (eski şablonun 0,5\'i): uygulamayı durdurur, iki okuma; seçilince çözülür', () => {
    const raw = withDiscount('0,5', { pricesNumeric: ['', '001'] });
    const p = parseTariffImport(raw);
    expect(p.discountPct).toBeNull();
    expect(p.discountChoice).toEqual({ text: '0,5', asPercent: 0.5, asRatio: 50 });
    const err = checkTariffImport(p, ctx()).find((i) => i.code === 'DISCOUNT_UNCLEAR')!;
    expect(err.severity).toBe('error');
    expect(err.title).toBe('İndirim "0,5" iki türlü okunabiliyor: %0,5 ya da %50');
    expect(checkTariffImport(p, ctx(), {}, 'en').find((i) => i.code === 'DISCOUNT_UNCLEAR')!.title).toBe('Discount "0,5" can be read two ways: 0.5% or 50%');
    expect(codes(raw)).not.toContain('warning:NO_DISCOUNT');
    expect(tariffImportFixes(p, ctx()).map((f) => [f.value, f.label])).toEqual([
      ['percent', 'İndirim "0,5" = %0,5'],
      ['ratio', 'İndirim "0,5" = %50'],
    ]);
    expect(parseTariffImport(raw, { discountUnit: 'percent' }).discountPct).toBe(0.5);
    expect(parseTariffImport(raw, { discountUnit: 'ratio' }).discountPct).toBe(50);
    expect(codes(raw, { discountUnit: 'percent' }).filter((c) => c.startsWith('error:'))).toEqual([]);
    // CSV metni de aynı
    expect(codes(withDiscount('0,25', { kind: 'csv' }))).toContain('error:DISCOUNT_UNCLEAR');
  });

  it('yüzde biçimli Excel hücresi, % işaretli metin ve 1 ve üstü değer sorulmaz', () => {
    expect(parseTariffImport(withDiscount('0,005', { pricesNumeric: ['', '001'], pricesPercent: ['', '001'] })).discountPct).toBe(0.5);
    expect(parseTariffImport(withDiscount('0,38', { pricesNumeric: ['', '001'], pricesPercent: ['', '001'] })).discountPct).toBe(38);
    expect(parseTariffImport(withDiscount('%0,5')).discountPct).toBe(0.5);
    expect(parseTariffImport(withDiscount('0,5%')).discountPct).toBe(0.5);
    expect(parseTariffImport(withDiscount('38')).discountPct).toBe(38);
    expect(parseTariffImport(withDiscount('0')).discountPct).toBe(0);
    for (const cell of ['%0,5', '38', '0']) expect(codes(withDiscount(cell)).filter((c) => c.includes('DISCOUNT'))).toEqual([]);
  });

  it('gerçek XLSX: yüzde biçimi okunur', async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(['Ağırlık', 'A', 'İndirim %']);
      const r = ws.addRow([1, 10, 0.005]);
      r.getCell(3).numFmt = '0.00%';
      ws.addRow([2, 12, null]);
    });
    expect(parseTariffImport(await readTariffFile('x.xlsx', bytes)).discountPct).toBe(0.5);
  });
});

describe('01-B12 (b) işaretsiz açık uçlu satır ("31+ | 8"); KALANLAR 1.7 ilave okuması', () => {
  const tariffOf = (raw: RawTariffFile, o: TariffImportOptions = {}) => {
    const p = parseTariffImport(raw, o);
    const overflowPerUnit = Object.fromEntries(p.overflow.map((x) => [x.zone, x.perUnit]));
    const weightSteps = importWeightSteps(p, ctx({ tariffCurrency: 'TRY' })) ?? [];
    return { p, tariff: { rates: p.rates, overflowPerUnit, weightSteps, zones: { '*': 'A' } } as never };
  };

  it('fiyat önceki satırdan çok düşük: her ilave birim (aşım fiyatı), uyarıyla; kg başı seçilebilir', () => {
    const { p, tariff } = tariffOf(xlsxRaw([['Desi', 'A'], ['1', '50'], ['30', '200'], ['31+', '8']]));
    expect(p.rates.find((r) => r.row === 4)).toBeUndefined();
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 8 }]);
    expect(p.overflowStep).toBe(1);
    // 50 desilik koli 200 + 20 × 8 = 360 (eskiden kg başı 8 × 50 = 400)
    expect(ratePrice(tariff, 'A', 50)).toMatchObject({ ok: true, price: 360 });
    const issues = checkTariffImport(p, ctx({ tariffCurrency: 'TRY' }));
    const w = issues.find((i) => i.code === 'OPEN_BAND_ADDITIONAL')!;
    expect(w.severity).toBe('warning');
    expect(w.detail).toBe('satır 4, bölge A: "31+" 8,00 → 30,0 kg üstünde her ilave birim 8,00; 35,0 kg: 200,00 + 5 × 8,00 = 240,00 (kg başı okunsaydı 280,00)');
    expect(issues.some((i) => i.code === 'PRICE_DECREASES' || i.code === 'OPEN_BAND_UNCLEAR')).toBe(false);
    expect(tariffImportFixes(p, ctx()).filter((f) => f.id === 'openBandMode').map((f) => f.value)).toEqual(['additional', 'perKg', 'flat']);
  });

  it('kişi "kg başı" seçerse eski okuma: fiyat × toplam ağırlık, uyarısız', () => {
    const { p, tariff } = tariffOf(xlsxRaw([['Desi', 'A'], ['1', '50'], ['30', '200'], ['31+', '8']]), { openBandMode: 'perKg' });
    expect(p.rates.find((r) => r.row === 4)).toMatchObject({ weightUpto: 99999, price: 8, perKg: true });
    expect(ratePrice(tariff, 'A', 50)).toMatchObject({ ok: true, price: 400 });
    const c = codes(xlsxRaw([['Desi', 'A'], ['1', '50'], ['30', '200'], ['31+', '8']]), { openBandMode: 'perKg' });
    expect(c.filter((x) => x.includes('OPEN_BAND'))).toEqual([]);
    // seçim geri alınabilsin: iki seçenek seçimden sonra da
    expect(tariffImportFixes(p, ctx()).filter((f) => f.id === 'openBandMode')).toHaveLength(3);
  });

  it('kg başı okuması da olağandışıysa (20 × 31 = 620) eskiden sorulurdu; artık ilave okunur (200 + k × 20)', () => {
    const p = parseTariffImport(xlsxRaw([['Desi', 'A'], ['1', '50'], ['30', '200'], ['31+', '20']]));
    expect(p.rates.find((r) => r.row === 4)).toBeUndefined();
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 20 }]);
    expect(checkTariffImport(p, ctx()).some((i) => i.code === 'OPEN_BAND_UNCLEAR')).toBe(false);
  });

  it('bugünkü okumalar değişmez: işaretli satır, PDF satırı, az düşen fiyat, artan fiyat', () => {
    expect(parseTariffImport(xlsxRaw([['Desi', 'A'], ['30', '200'], ['31+ kg başı', '8']])).openBands).toEqual([]);
    const pdf: RawTariffFile = { fileName: 'x.pdf', kind: 'pdf', prices: [['Ağırlık', 'A'], ['30', '200'], ['31+ kg başı', '8']], zones: null, surcharges: null };
    expect(parseTariffImport(pdf).rates.find((r) => r.weightUpto === 99999)).toMatchObject({ price: 8, perKg: true });
    // önceki satırdan pahalı açık uç sabit kalır; ucuzu (%25–%100) artık sorulur (KALANLAR 1.7 incelemesi), "sabit" seçilebilir
    const dear = parseTariffImport(xlsxRaw([['Ağırlık', 'A'], ['1', '100'], ['1000+', '250']]));
    expect(dear.rates.find((r) => r.weightUpto === 99999)).toMatchObject({ price: 250 });
    expect(dear.rates.find((r) => r.weightUpto === 99999)?.perKg).toBeUndefined();
    expect(dear.openBands).toEqual([]);
    const cheap = xlsxRaw([['Ağırlık', 'A'], ['1', '100'], ['1000+', '50']]);
    expect(parseTariffImport(cheap).openBands.map((b) => [b.reading, b.why])).toEqual([['unclear', 'cheaper']]);
    expect(parseTariffImport(cheap, { openBandMode: 'flat' }).rates.find((r) => r.weightUpto === 99999)).toMatchObject({ price: 50 });
    expect(openBandReading(8, 200, 31)).toBe('additional');
    expect(openBandReading(8, 200, 31, 30)).toBe('additional');
    expect(openBandReading(8, 200, 30, 30)).toBe('additional');
    expect(openBandReading(3.99, 450, 100)).toBe('additional');
    expect(openBandReading(8, 200, 50, 30)).toBe('unclear');
    expect(openBandReading(8, 200, 20, 30)).toBe('unclear');
    expect(openBandReading(8, 200, 50, 30, 'perKg')).toBe('perKg');
    expect(openBandReading(8, 200, 50, 30, 'additional')).toBe('additional');
    expect(openBandReading(50, 100, 1000)).toBe('flat');
    expect(openBandReading(50, 100, 1000, 1, 'perKg')).toBe('flat');
    expect(openBandReading(8, null, 31)).toBe('flat');
  });
});

describe('01-B5 lb tarifesi mevcut 0,5 kg basamaklı tarifeye', () => {
  const lbRows: string[][] = [['Weight (lb)', 'A']];
  for (let lb = 1; lb <= 10; lb++) lbRows.push([String(lb), String(10 + lb)]);
  lbRows.push(['Additional 1 lb', '2']);
  const raw = xlsxRaw(lbRows);
  const o = { convertLbToKg: true, currency: 'USD' };
  const halfKg = ctx({ currentWeightSteps: [{ upto: null, step: 0.5 }] });

  // Elle doğrulanmış beklenenler: liste n lb = 10 + n (1–10 lb), üstü her ilave 1 lb 2. Taşıyıcı ağırlığı lb'ye yukarı
  // yuvarlar: kg → lb (÷ 0,45359237) → yukarı tam lb → satır ya da 20 + 2 × (lb − 10).
  const HAND: [kg: number, lb: string, price: number][] = [
    [0.3, '0,66 lb → 1 lb', 11],
    [0.88, '1,94 lb → 2 lb', 12],
    [0.907, 'tam 2 lb (faturada 2 lb)', 12],
    [0.908, '2,002 lb → 3 lb', 13],
    [4.536, 'tam 10 lb: son satır', 20],
    [4.537, '10,002 lb → 11 lb: son satırın hemen üstü', 22],
    [4.99, 'tam 11 lb', 22],
    [4.991, '11,003 lb → 12 lb', 24],
    [6.536, '14,41 lb → 15 lb', 30],
    [6.804, 'tam 15 lb', 30],
    [45.359, 'tam 100 lb', 200],
    [100, '220,46 lb → 221 lb: çok üstü', 442],
  ];

  it('eski kg basamağı korunmaz: lb basamağı; tablo içi ve aşım taşıyıcının lb yuvarlamasıyla (elle doğrulanmış)', () => {
    const p = parseTariffImport(raw, o);
    const steps = importWeightSteps(p, halfKg)!;
    expect(steps).toEqual([{ upto: null, step: 0.45359237 }]);
    // aşım dosyadaki gibi lb başına (eskiden kg başına 4,41'e çevrilip 1 kg birimle sayılıyordu: 6,536 kg → 28,82)
    expect(p.overflow).toEqual([{ zone: 'A', perUnit: 2 }]);
    const tariff = { rates: p.rates, overflowPerUnit: { A: 2 }, weightSteps: steps, zones: { '*': 'A' } } as never;
    for (const [kg, why, price] of HAND) {
      expect(ratePrice(tariff, 'A', roundUpToStep(kg, steps)), `${kg} kg: ${why}`).toMatchObject({ ok: true, price });
    }
    // düzenleyicide 3 haneye yuvarlanmış adım (0,454) aynı sonucu verir
    const edited = { rates: p.rates, overflowPerUnit: { A: 2 }, weightSteps: [{ upto: null, step: 0.454 }], zones: { '*': 'A' } } as never;
    for (const [kg, why, price] of HAND) {
      expect(ratePrice(edited, 'A', roundUpToStep(kg, [{ upto: null, step: 0.454 }])), `0,454: ${kg} kg: ${why}`).toMatchObject({ price });
    }
  });

  it('hesap motoru yolu (expectedCharge + chargeableWeight) aynı tutarı verir', () => {
    const p = parseTariffImport(raw, o);
    const steps = importWeightSteps(p, halfKg)!;
    const tariff = { rates: p.rates, overflowPerUnit: { A: 2 }, weightSteps: steps, zones: { '*': 'A' }, discountPct: 0, fuelPct: 0, surcharges: [], divisor: 5000 } as never;
    for (const [kg, why, price] of HAND) {
      const { chargeable } = chargeableWeight({ dims: { l: 1, w: 1, h: 1 }, actualKg: kg, divisor: 5000, steps });
      expect(expectedCharge({ tariff, chargeableKg: chargeable, destCountry: 'US' }), `${kg} kg: ${why}`).toMatchObject({ ok: true, total: price });
    }
  });

  it('yarım lb satırlı liste: basamak 0,5 lb, üstü aşımın 1 lb birimi', () => {
    const rows: string[][] = [['Weight (lb)', 'A']];
    for (let i = 1; i <= 6; i++) rows.push([String(i / 2).replace('.', ','), String(5 + i)]); // 0,5 lb = 6 … 3 lb = 11
    rows.push(['Additional 1 lb', '2']);
    const p = parseTariffImport(xlsxRaw(rows), o);
    const steps = importWeightSteps(p, halfKg)!;
    expect(steps).toEqual([
      { upto: 1.361, step: 0.226796185 },
      { upto: null, step: 0.45359237 },
    ]);
    const tariff = { rates: p.rates, overflowPerUnit: { A: 2 }, weightSteps: steps, zones: { '*': 'A' } } as never;
    const price = (kg: number) => (ratePrice(tariff, 'A', roundUpToStep(kg, steps)) as { price: number }).price;
    expect(price(0.2)).toBe(6); // 0,44 lb → 0,5 lb
    expect(price(0.25)).toBe(7); // 0,55 lb → 1 lb
    expect(price(1.361)).toBe(11); // tam 3 lb
    expect(price(1.4)).toBe(13); // 3,09 lb → 4 lb: 11 + 1 × 2
    expect(price(2.0)).toBe(15); // 4,41 lb → 5 lb: 11 + 2 × 2
  });

  it('aşım dosyada yok, mevcut tarifeden kalıyor: üstü mevcut basamakla (fiyatı eski birim başına)', () => {
    const rows = lbRows.slice(0, -1);
    const p = parseTariffImport(xlsxRaw(rows), o);
    const c = ctx({ currentWeightSteps: [{ upto: null, step: 0.5 }], currentOverflow: [{ zone: 'A', perUnit: 3 }] });
    const steps = importWeightSteps(p, c)!;
    expect(steps).toEqual([
      { upto: 4.536, step: 0.45359237 },
      { upto: null, step: 0.5 },
    ]);
    const tariff = { rates: p.rates, overflowPerUnit: { A: 3 }, weightSteps: steps, zones: { '*': 'A' } } as never;
    // 5 kg: 5,0'a yuvarlanır, 4,536'nın üstünde 1 yarım kg → 20 + 3
    expect(ratePrice(tariff, 'A', roundUpToStep(5, steps))).toMatchObject({ price: 23 });
    expect(ratePrice(tariff, 'A', roundUpToStep(0.88, steps))).toMatchObject({ price: 12 });
  });

  it('kg basamakları lb basamağı sanılmaz (kg tarifeleri değişmez)', () => {
    for (const s of [0.001, 0.01, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 5, 10, 20, 50]) expect(lbStepKg(s), String(s)).toBeNull();
    for (const s of [0.45359237, 0.454, 0.227, 0.907, 2.268, 4.536]) expect(lbStepKg(s), String(s)).not.toBeNull();
    // kg yolu: bugünkü sayım
    expect(overflowUnits(31.2, 30, 0.5)).toBe(3);
    expect(overflowUnits(30.001, 30, 1)).toBe(1);
  });

  it('bağımsız inceleme: lb aşımı son satırdan sayılır (son satır aşım biriminin katı değilse) ve 3 · 4 lb birimi tanınır', () => {
    // Elle doğrulanmış: liste n lb = 10 + n. Taşıyıcı: kg → lb, yukarı tam lb, son satırın üstü "her ilave X lb" blokları.
    // Eskiden basamak sıfırdan sayılıyordu (11 lb satırından sonra 2 lb'lik basamak 12 · 14 lb) ve 3 / 4 lb kg basamağı
    // sanılıyordu (1,361 kg'ın katları): ikisinde de bir aşım birimi fazla beklenirdi.
    const list = (n: number, extra: string[]) => {
      const r: string[][] = [['Weight (lb)', 'A']];
      for (let lb = 1; lb <= n; lb++) r.push([String(lb), String(10 + lb)]);
      return [...r, extra];
    };
    const priceOf = (rows: string[][]) => {
      const p = parseTariffImport(xlsxRaw(rows), o);
      const steps = importWeightSteps(p, ctx())!;
      const tariff = { rates: p.rates, overflowPerUnit: { A: p.overflow[0]!.perUnit }, weightSteps: steps, zones: { '*': 'A' } } as never;
      return (kg: number) => (ratePrice(tariff, 'A', roundUpToStep(kg, steps)) as { price: number }).price;
    };
    const two = priceOf(list(11, ['Additional 2 lb', '4'])); // 11 lb = 21
    expect(two(4.991)).toBe(25); // 11,003 lb → 13 lb: 1 birim (eskiden 12 lb, yine 1 birim)
    expect(two(5.67)).toBe(25); // 12,5 lb → 13 lb: 1 birim (eskiden 14 lb → 2 birim, 29)
    expect(two(5.897)).toBe(25); // tam 13 lb
    expect(two(5.898)).toBe(29); // 13,003 lb → 15 lb: 2 birim
    const three = priceOf(list(10, ['Additional 3 lb', '4'])); // 10 lb = 20
    expect(three(5.5)).toBe(24); // 12,13 lb → 13 lb: 1 birim (eskiden 6,805 kg → 2 birim, 28)
    expect(three(5.897)).toBe(24); // tam 13 lb
    expect(three(5.898)).toBe(28); // 13,003 lb → 16 lb: 2 birim
    const four = priceOf(list(10, ['Additional 4 lb', '4']));
    expect(four(5.5)).toBe(24); // 12,13 lb → 14 lb: 1 birim (eskiden 7,256 kg → 2 birim, 28)
    expect(four(6.35)).toBe(24); // tam 14 lb
    expect(four(6.351)).toBe(28); // 14,001 lb → 18 lb: 2 birim
    // yarım lb satırları 1,5 lb'de biter, üstü her ilave 1 lb: 2,5 · 3,5 lb … (sıfırdan sayılsa 3 · 4 lb)
    const half = priceOf([['Weight (lb)', 'A'], ['0,5', '6'], ['1', '7'], ['1,5', '8'], ['Additional 1 lb', '2']]);
    expect(half(1.0)).toBe(10); // 2,2 lb → 2,5 lb: 1 birim (eskiden 3 lb → 2 birim, 12)
    expect(half(1.134)).toBe(10); // tam 2,5 lb
    expect(half(1.135)).toBe(12); // 2,502 lb → 3,5 lb: 2 birim
    // yeni tanınan 3 · 4 lb; 0,75 · 1,5 lb'nin kg karşılığı (0,34 · 0,68) kg basamağı olabilir, tanınmaz
    expect(lbStepKg(1.361)).toBeCloseTo(3 * 0.45359237, 9);
    expect(lbStepKg(1.814)).toBeCloseTo(4 * 0.45359237, 9);
    for (const s of [0.34, 0.68, 0.75, 1.5, 4.5]) expect(lbStepKg(s), String(s)).toBeNull();
    // kg bandından sonraki lb bandı sıfırdan sayılmaya devam eder (20 kg bir lb ağırlığı değil)
    expect(roundUpToStep(20.3, [{ upto: 20, step: 0.5 }, { upto: null, step: 0.45359237 }])).toBe(20.412);
  });

  it('kontrol listesi basamağın lb çevriminden sonra nasıl ayarlandığını söyler', () => {
    const p = parseTariffImport(raw, o);
    const w = checkTariffImport(p, halfKg, o).find((i) => i.code === 'LB_WEIGHT_STEPS')!;
    expect(w.severity).toBe('warning');
    expect(w.title).toBe('lb çevriminden sonra ağırlık yuvarlaması değişiyor: her 0,5 kg → her 0,454 kg');
    expect(w.detail).toContain('Aşım fiyatı dosyadaki gibi lb başınadır');
    // basamak zaten yoksa söylenecek değişiklik yok
    expect(checkTariffImport(p, ctx(), o).some((i) => i.code === 'LB_WEIGHT_STEPS')).toBe(false);
    // çevrilmeyen dosyada (hata: lb) yok
    expect(checkTariffImport(parseTariffImport(raw), halfKg).some((i) => i.code === 'LB_WEIGHT_STEPS')).toBe(false);
  });
});
