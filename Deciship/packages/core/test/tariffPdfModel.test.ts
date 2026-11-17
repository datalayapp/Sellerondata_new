import { describe, expect, it } from 'vitest';
import {
  checkTariffImport,
  cleanZoneLabel,
  compareWithCurrent,
  countryNameToIso2,
  expectedCharge,
  OPEN_WEIGHT,
  parseStepLabel,
  parseTariffImport,
  parseWeightLabel,
  ratePrice,
  type RawTariffFile,
  type TariffImportContext,
  type TariffInput,
} from '../src/index';

/** Kg başı bantlar, "İlave 0,5 kg" genişletme, aşım/para birimi uyarıları, ülke adları. */

const codes = (issues: { code: string; severity: string }[], severity?: string) =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

function sheet(rows: (string | number)[][]): RawTariffFile {
  return { fileName: 't.xlsx', kind: 'xlsx', prices: rows.map((r) => r.map(String)), zones: null, surcharges: null };
}

/** Taşıyıcı PDF'lerindeki "Diğer ambalaj" tablosu biçiminde küçük tablo (A, B bölgeleri; sayılar uydurma). */
const FEDEX_LIKE = sheet([
  ['AĞIRLIK (KG)', 'A BÖLGESİ', 'B BÖLGESİ'],
  ['0.5', '11.10', '15.30'],
  ['1', '12.40', '16.80'],
  ['10.5', '31.50', '27.20'],
  ['İlave 0,5kg', '3.10', '3.40'],
  ['21', '96.60', '98.60'],
  ['İlave 0,5kg', '2.80', '3.05'],
  ['30', '147.00', '153.50'],
  ['Kg başına ücret (toplam gönderi ağırlığıyla çarpınız)', '', ''],
  ['71-99', '5.20', '5.10'],
  ['100-299', '5.20', '5.10'],
  ['1000 +', '5.20', '5.10'],
]);

const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({
  tariffCurrency: 'USD',
  currentZones: [
    { country: 'CA', zone: 'A' },
    { country: 'DE', zone: 'B' },
  ],
  currentRates: [],
  ...over,
});

function asTariff(rates: TariffInput['rates'], extra: Partial<TariffInput> = {}): TariffInput {
  return {
    id: 't',
    currency: 'USD',
    divisor: 5000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [],
    discountPct: 0,
    fuelPct: 0,
    zones: { CA: 'A', DE: 'B' },
    rates,
    surcharges: [],
    ...extra,
  };
}

describe('ağırlık etiketleri', () => {
  it.each([
    ['0,5', 0.5, false, 'single'],
    ['≤ 2 kg', 2, false, 'single'],
    ['71-99', 99, false, 'range'],
    ['71 – 99 kg', 99, false, 'range'],
    ['71-99 kg başı', 99, true, 'range'],
    ['70,5-99 kg başı', 99, true, 'range'],
    ['1000+', OPEN_WEIGHT, false, 'open'],
    ['1000 +', OPEN_WEIGHT, false, 'open'],
    ['1000+ kg başı', OPEN_WEIGHT, true, 'open'],
    ['1000 kg ve üzeri', OPEN_WEIGHT, false, 'open'],
    ['100-299 per kg', 299, true, 'range'],
  ])('%s', (label, weight, perKg, kind) => {
    expect(parseWeightLabel(label)).toMatchObject({ weight, perKg, kind });
  });

  it('okunamayanlar', () => {
    expect(parseWeightLabel('FedEx Pak')).toBeNull();
    expect(parseWeightLabel('')).toBeNull();
    expect(parseWeightLabel('99-71')).toBeNull();
  });

  it('ilave adımları', () => {
    expect(parseStepLabel('İlave 0,5kg')).toBe(0.5);
    expect(parseStepLabel('ilave 1 kg')).toBe(1);
    expect(parseStepLabel('Additional 0.5 kg')).toBe(0.5);
    expect(parseStepLabel('Her ek 0,5 kg')).toBe(0.5);
    expect(parseStepLabel('Aşım (her ek birim)')).toBeNull();
    expect(parseStepLabel('10,5')).toBeNull();
  });

  it('"A BÖLGESİ" → "A"', () => {
    expect(cleanZoneLabel('A BÖLGESİ')).toBe('A');
    expect(cleanZoneLabel('R Bölgesi')).toBe('R');
    expect(cleanZoneLabel('ZONE X')).toBe('X');
    expect(cleanZoneLabel('Avrupa 1')).toBe('Avrupa 1');
  });
});

describe('FedEx biçimi: ilave satırları + kg başı bantlar', () => {
  const parsed = parseTariffImport(FEDEX_LIKE);

  it('açık satırlar olduğu gibi, ara ağırlıklar kuraldan üretilir', () => {
    const a = parsed.rates.filter((r) => r.zone === 'A' && !r.perKg).sort((x, y) => x.weightUpto - y.weightUpto);
    const at = (w: number) => a.find((r) => r.weightUpto === w);
    expect(at(10.5)!.price).toBe(31.5);
    expect(at(11)).toMatchObject({ price: 34.6, generated: true });
    expect(at(20.5)).toMatchObject({ price: 93.5, generated: true });
    expect(at(21)).toMatchObject({ price: 96.6 });
    expect(at(21)!.generated).toBeUndefined();
    expect(at(21.5)!.price).toBe(99.4);
    expect(at(29.5)!.price).toBe(144.2);
    expect(at(30)!.price).toBe(147);
    // 10,5 → 21: 20 ara ağırlık; 21 → 30: 17 ara ağırlık
    expect(a.filter((r) => r.generated)).toHaveLength(37);
    expect(parsed.stepExpansions.filter((e) => e.zone === 'A').map((e) => e.count)).toEqual([20, 17]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.extraTables).toEqual([]);
  });

  it('bantlar kg başı; son bant üst sınırsız', () => {
    const bands = parsed.rates.filter((r) => r.zone === 'A' && r.perKg).map((r) => [r.weightUpto, r.price]);
    expect(bands).toEqual([
      [99, 5.2],
      [299, 5.2],
      [OPEN_WEIGHT, 5.2],
    ]);
    expect(parsed.perKgTitles).toHaveLength(1);
  });

  it('kontroller: kg başı fiyatlar sabit fiyatlarla kıyaslanmaz; bilgi notları', () => {
    const checks = checkTariffImport(parsed, ctx());
    expect(codes(checks, 'error')).toEqual([]);
    expect(codes(checks)).not.toContain('PRICE_DECREASES');
    expect(codes(checks)).not.toContain('MAX_WEIGHT_LOW');
    expect(codes(checks, 'info')).toEqual(['SUMMARY']);
    const sum = checks.find((c) => c.code === 'SUMMARY')!;
    expect(sum.title).toContain('3 kg başı bant');
    expect(sum.detail).toContain('74 ara ağırlık');
  });

  it('ratePrice: tablo, ara ağırlık, kg başı bant', () => {
    const t = asTariff(parsed.rates);
    expect(ratePrice(t, 'A', 0.5)).toMatchObject({ ok: true, price: 11.1 });
    expect(ratePrice(t, 'A', 11)).toMatchObject({ ok: true, price: 34.6 });
    expect(ratePrice(t, 'A', 30)).toMatchObject({ ok: true, price: 147 });
    const band = ratePrice(t, 'A', 75);
    expect(band).toMatchObject({ ok: true, price: 390 });
    expect(band.ok && band.label).toContain('kg başı');
    expect(ratePrice(t, 'B', 1500)).toMatchObject({ ok: true, price: 7650 });
    const e = expectedCharge({ tariff: { ...t, fuelPct: 5 }, chargeableKg: 75, destCountry: 'CA' });
    expect(e).toMatchObject({ ok: true, base: 390, fuel: 19.5, total: 409.5 });
  });

  it('son bant sınırlıysa üstü fiyatlanamaz (taşma kullanılmaz)', () => {
    const t = asTariff(
      [
        { zone: 'A', weightUpto: 10, price: 50 },
        { zone: 'A', weightUpto: 99, price: 5, perKg: true },
      ],
      { overflowPerUnit: { A: 1 } },
    );
    expect(ratePrice(t, 'A', 99)).toMatchObject({ ok: true, price: 495 });
    expect(ratePrice(t, 'A', 120)).toMatchObject({ ok: false });
  });

  it('lb→kg: kg başı fiyat kg başına çevrilir, açık uç korunur', () => {
    const lb = parseTariffImport(
      sheet([
        ['Weight (lb)', 'A'],
        ['1', '10'],
        ['2', '12'],
        ['3-99 kg başı', '9.07'],
        ['100+ kg başı', '9.07'],
      ]),
      { convertLbToKg: true },
    );
    const bands = lb.rates.filter((r) => r.perKg);
    expect(bands.map((r) => r.weightUpto)).toEqual([44.906, OPEN_WEIGHT]);
    expect(bands[0]!.price).toBe(20);
  });

  it('kullanılamayan ve tutarsız ilave kuralları uyarı verir', () => {
    const p = parseTariffImport(
      sheet([
        ['Ağırlık', 'A'],
        ['İlave 0,5 kg', '1'],
        ['1', '10'],
        ['İlave 0,5 kg', '1'],
        ['3', '30'],
      ]),
    );
    const checks = checkTariffImport(p, ctx({ currentZones: [{ country: 'CA', zone: 'A' }] }));
    expect(codes(checks, 'warning')).toEqual(expect.arrayContaining(['STEP_RULE_UNUSED', 'STEP_MISMATCH']));
    expect(p.rates.filter((r) => r.generated).map((r) => [r.weightUpto, r.price])).toEqual([
      [1.5, 11],
      [2, 12],
      [2.5, 13],
    ]);
  });

  it('eski/yeni karşılaştırması yalnız sabit fiyatlarla', () => {
    const cmp = compareWithCurrent(
      [
        { zone: 'A', weightUpto: 1, price: 20 },
        { zone: 'A', weightUpto: 99, price: 7, perKg: true },
      ],
      [{ zone: 'A', weightUpto: 1, price: 10 }],
    );
    expect(cmp).toEqual([{ zone: 'A', oldMedian: 10, newMedian: 20, ratio: 2 }]);
  });
});

describe('aşım fiyatları ve para birimi (önceki tur QA)', () => {
  const flat = sheet([
    ['Ağırlık', 'A', 'B'],
    ['1', '10', '12'],
    ['2', '12', '14'],
  ]);

  it('dosyada aşım yoksa mevcut aşım korunur ve bildirilir', () => {
    const p = parseTariffImport(flat);
    const checks = checkTariffImport(p, ctx({ currentOverflow: [{ zone: 'A', perUnit: 3 }] }));
    const kept = checks.find((c) => c.code === 'OVERFLOW_KEPT');
    expect(kept).toMatchObject({ severity: 'warning' });
    expect(kept!.detail).toContain('Bölge A: 3,00');
    expect(codes(checks)).not.toContain('MAX_WEIGHT_LOW');
  });

  it('dosyadaki aşım mevcudu değiştirir/kaldırırsa uyarı', () => {
    const p = parseTariffImport(sheet([...flat.prices!, ['Aşım (her ek birim)', '4', '']]));
    const checks = checkTariffImport(
      p,
      ctx({
        currentOverflow: [
          { zone: 'A', perUnit: 3 },
          { zone: 'B', perUnit: 5 },
        ],
      }),
    );
    const w = checks.find((c) => c.code === 'OVERFLOW_CHANGED')!;
    expect(w.severity).toBe('warning');
    expect(w.detail).toContain('Bölge A: 3,00 → 4,00');
    expect(w.detail).toContain('Bölge B: 5,00 → kaldırılıyor');
  });

  it('para birimi değişince sabit ek ücretler ve aşım eski para biriminde kalır → uyarı', () => {
    const p = parseTariffImport(flat, { currency: 'USD' });
    const checks = checkTariffImport(
      p,
      ctx({
        tariffCurrency: 'TRY',
        currentOverflow: [{ zone: 'A', perUnit: 3 }],
        currentSurcharges: [
          { code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'FIXED', amount: 250 },
          { code: 'FUEL_X', name: 'Yüzde', kind: 'PCT', amount: 10 },
          { code: 'HEAVY', name: 'Ağır koli', kind: 'PER_KG', amount: 4 },
        ],
      }),
      { currency: 'USD' },
    );
    const w = checks.find((c) => c.code === 'SURCHARGES_OTHER_CURRENCY')!;
    expect(w.severity).toBe('warning');
    // ne yapılacağını açıkça söyler; tutarlar çevrilmez
    expect(w.title).toBe('Ek ücretler ve aşım fiyatları TRY; tarife artık USD — ek ücretleri kontrol edin');
    expect(w.detail).toContain('3 sabit tutar TRY olarak yazılı');
    expect(w.detail).toContain('Otomatik çevrilmez');
    expect(w.suggestion).toContain('Ek ücretler bölümünde ve Fiyat tablosunun aşım satırında bu tutarları USD karşılıklarıyla değiştirip kaydedin');
    expect(w.detail).toContain('Uzak bölge: 250,00 TRY');
    expect(w.detail).toContain('Ağır koli: 4,00 TRY / kg');
    expect(w.detail).not.toContain('Yüzde');
    // yalnız ek ücret kaldıysa başlık yalnız ek ücretleri söyler
    const onlySc = checkTariffImport(
      p,
      ctx({ tariffCurrency: 'TRY', currentSurcharges: [{ code: 'REMOTE_AREA', name: 'Uzak bölge', kind: 'FIXED', amount: 250 }] }),
      { currency: 'USD' },
    ).find((c) => c.code === 'SURCHARGES_OTHER_CURRENCY')!;
    expect(onlySc.title).toBe('Ek ücretler TRY; tarife artık USD — ek ücretleri kontrol edin');
    expect(onlySc.suggestion).toContain('Ek ücretler bölümünde');
    // yeni tarifede bu uyarı yok
    expect(codes(checkTariffImport(p, ctx({ tariffCurrency: 'TRY', newTariff: true, currentSurcharges: [{ code: 'X', name: 'X', kind: 'FIXED', amount: 1 }] }), { currency: 'USD' }))).not.toContain(
      'SURCHARGES_OTHER_CURRENCY',
    );
  });
});

describe('ülke adı → ISO-2', () => {
  it.each([
    ['ALMANYA', 'DE'],
    ['AMERİKA BİRLEŞİK DEVLETLERİ', 'US'],
    ['AMERİKA\nBİRLEŞİK\nDEVLETLERİ', 'US'],
    ['İTALYA', 'IT'],
    ['İSPANYA', 'ES'],
    ['BİRLEŞİK KRALLIK', 'GB'],
    ['ANTIGUA & BARBUDA', 'AG'],
    ['TRİNİDAD VE TOBAGO', 'TT'],
    ['SİNT MAARTEN (Hollanda kısmı)', 'SX'],
    ['SAİNT MARTİN (Fransız kısmı)', 'MF'],
    ['KOSOVA - ISO KODSUZ - YALNIZCA TNT', 'XK'],
    ['BEYAZ RUSYA', 'BY'],
    ['FİLDİŞİ SAHİLİ', 'CI'],
    ['DEMOKRATİK KONGO CUMHURİYETİ', 'CD'],
    ['KONGO', 'CG'],
    ['BONAIRE, SABA, St.EUSTATIUS', 'BQ'],
    ['VANUATU', 'VU'],
    ['ZİMBABVE', 'ZW'],
    ['HONG KONG', 'HK'],
    ['KORE, GÜNEY', 'KR'],
    ['Germany', 'DE'],
    ['United States', 'US'],
    ['Malta', 'MT'],
    ['UK', 'GB'],
    ['de', 'DE'],
  ])('%s → %s', (name, iso) => {
    expect(countryNameToIso2(name)).toBe(iso);
  });

  it('bilinmeyen ad → null', () => {
    expect(countryNameToIso2('Atlantis Krallığı')).toBeNull();
    expect(countryNameToIso2('')).toBeNull();
  });
});
