/**
 * Yurt içi mesafe sütunlu listeler ("Desi | Şehir içi | Yakın | Orta | Uzak"), "Aşım" satırının birimi ve
 * ad + kod yan yana yazılan ülke hücreleri ("Germany DEU"). Tüm sayılar uydurmadır; yapı Türk kargo firmalarının
 * herkese açık liste fiyatlarına benzer (Dosya satırı, 1…30 desi, "her ilave desi").
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  checkTariffImport,
  countryNameToIso2,
  distanceZoneCode,
  expectedCharge,
  importWeightSteps,
  overflowUnitStep,
  parseTariffImport,
  readTariffFile,
  scanPdfLayout,
  type ParsedTariffImport,
  type PdfCodeSection,
  type PdfTextItem,
  type TariffImportContext,
  type TariffInput,
} from '../src/index';

const H = 8;
const at = (y: number, cells: [number, string][]): PdfTextItem[] => cells.map(([x, str]) => ({ str, x, y, w: str.length * 4, h: H }));
const page = (lines: [number, string][][]): PdfTextItem[] => lines.flatMap((cells, i) => at(780 - i * 12, cells));

/** buildPdfImport'un yaptığı gibi bölüm tablosunu içe aktarma sayfasına çevirir. */
function sheetOf(s: PdfCodeSection): string[][] {
  return [['Ağırlık (kg)', ...s.table.zones], ...s.table.rows.map((r) => [r.kind === 'additional' ? `İlave ${r.step} kg` : String(r.weight), ...r.cells])];
}

const ctx = (over: Partial<TariffImportContext> = {}): TariffImportContext => ({
  tariffCurrency: 'TRY',
  currentZones: [],
  currentRates: [],
  currentSurcharges: [],
  ...over,
});
const codes = (p: ParsedTariffImport, c: TariffImportContext, sev: string) =>
  checkTariffImport(p, c)
    .filter((x) => x.severity === sev)
    .map((x) => x.code);

async function xlsx(rows: (string | number)[][], zones?: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fiyatlar');
  for (const r of rows) ws.addRow(r);
  if (zones) {
    const z = wb.addWorksheet('Bölgeler');
    for (const r of zones) z.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('distanceZoneCode', () => {
  it('mesafe başlıklarını kısa koda çevirir; başka başlıklara dokunmaz', () => {
    expect(['Şehir içi', 'ŞEHİR İÇİ', 'Sehir Ici', 'Şehiriçi', 'Yakın', 'YAKIN', 'Yakın Mesafe', 'Orta', 'Orta Mesafe', 'Uzak', 'Uzak Bölge'].map(distanceZoneCode)).toEqual([
      'SEHIRICI',
      'SEHIRICI',
      'SEHIRICI',
      'SEHIRICI',
      'YAKIN',
      'YAKIN',
      'YAKIN',
      'ORTA',
      'ORTA',
      'UZAK',
      'UZAK',
    ]);
    expect(['Kısa Mesafe', 'Uzun Mesafe', 'Mahalli', 'Bölge içi', 'Çok Uzak', 'Şehirlerarası', 'SEHIRICI'].map(distanceZoneCode)).toEqual([
      'KISA',
      'UZUN',
      'MAHALLI',
      'BOLGEICI',
      'COKUZAK',
      'SEHIRLERARASI',
      'SEHIRICI',
    ]);
    expect(['A', 'Zone 1', 'Bölge 3', 'TR', 'Ücret', 'Desi', 'Ortalama'].map(distanceZoneCode)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('PDF (kodla): mesafe sütunlu yurt içi liste', () => {
  // "Desi | Şehir İçi | Yakın | Orta | Uzak" + Dosya satırı + "her ilave desi"
  const items = page([
    [[60, 'ÖRNEK KARGO 2026 YURT İÇİ LİSTE FİYATLARI (KDV HARİÇ, TL)']],
    [[60, 'Desi'], [170, 'Şehir İçi'], [230, 'Yakın'], [290, 'Orta'], [350, 'Uzak']],
    [[60, 'Dosya'], [175, '60,00'], [235, '70,00'], [295, '75,00'], [355, '80,00']],
    [[60, '1'], [175, '90,00'], [235, '100,00'], [295, '110,00'], [355, '120,00']],
    [[60, '2'], [175, '95,00'], [235, '106,00'], [295, '117,00'], [355, '128,00']],
    [[60, '5'], [175, '110,00'], [235, '124,00'], [295, '138,00'], [355, '152,00']],
    [[60, '10'], [175, '140,00'], [235, '160,00'], [295, '180,00'], [355, '200,00']],
    [[60, '30'], [175, '260,00'], [235, '300,00'], [295, '340,00'], [355, '380,00']],
    [[60, 'Her ilave desi'], [175, '8,00'], [235, '9,00'], [295, '10,00'], [355, '11,00']],
  ]);
  const scan = scanPdfLayout([{ items }]);
  const s = scan.sections[0]!;

  it('mesafe başlıkları bölge sütunu olur (kısa kod); yurt içi, Dosya atlanır, aşım satırı okunur', () => {
    expect(scan.sections).toHaveLength(1);
    expect(s).toMatchObject({ zones: ['SEHIRICI', 'YAKIN', 'ORTA', 'UZAK'], direction: 'domestic', packaging: 'all', weightMin: 1, weightMax: 30, hasAdditionalStep: true });
    expect(s.title).toContain('(SEHIRICI–UZAK)');
    expect(s.table.rows.map((r) => [r.kind, r.weight ?? r.step, r.cells.join('|')])).toEqual([
      ['weight', 1, '90,00|100,00|110,00|120,00'],
      ['weight', 2, '95,00|106,00|117,00|128,00'],
      ['weight', 5, '110,00|124,00|138,00|152,00'],
      ['weight', 10, '140,00|160,00|180,00|200,00'],
      ['weight', 30, '260,00|300,00|340,00|380,00'],
      ['additional', 1, '8,00|9,00|10,00|11,00'],
    ]);
    expect(s.notes).toEqual([
      '"Dosya" satırı alınmadı (zarf/dosya fiyatı; koli desisi ölçülür)',
      'mesafe bölgeleri okundu ("Şehir İçi" → SEHIRICI, "Yakın" → YAKIN, "Orta" → ORTA, "Uzak" → UZAK); mesafe bölgelerini fatura satırlarıyla eşlemek için bölge eşlemesini kontrol edin',
    ]);
    expect(scan.document).toMatchObject({ dimDivisor: 3000, weightUnit: 'kg' });
  });

  it('"Kısa / Orta / Uzun Mesafe" ve "Mahalli / Bölge içi / Yakın / Uzak" başlıkları da okunur', () => {
    const a = scanPdfLayout([
      {
        items: page([
          [[60, 'Desi/Kg'], [170, 'Kısa Mesafe'], [240, 'Orta Mesafe'], [310, 'Uzun Mesafe']],
          [[60, '1'], [180, '50,00'], [250, '60,00'], [320, '70,00']],
          [[60, '2'], [180, '55,00'], [250, '66,00'], [320, '77,00']],
        ]),
      },
    ]);
    expect(a.sections[0]).toMatchObject({ zones: ['KISA', 'ORTA', 'UZUN'], direction: 'domestic' });
    const b = scanPdfLayout([
      {
        items: page([
          [[60, 'DESİ'], [170, 'MAHALLİ'], [230, 'BÖLGE İÇİ'], [290, 'YAKIN'], [350, 'UZAK']],
          [[60, '1'], [175, '40,00'], [235, '45,00'], [295, '50,00'], [355, '55,00']],
          [[60, '2'], [175, '44,00'], [235, '49,00'], [295, '54,00'], [355, '59,00']],
        ]),
      },
    ]);
    expect(b.sections[0]).toMatchObject({ zones: ['MAHALLI', 'BOLGEICI', 'YAKIN', 'UZAK'], direction: 'domestic' });
    // büyük harfli "DESİ" (İ) de desi başlığıdır → bölen 3000
    expect(b.document.dimDivisor).toBe(3000);
    // km kademeleri ve il içi / il dışı
    const c = scanPdfLayout([
      {
        items: page([
          [[60, 'Ağırlık (Kg/Ds)'], [160, 'Şehiriçi'], [220, '0-200 KM'], [280, '201-600 KM'], [340, '1000 KM Üzeri']],
          [[60, '1'], [165, '40,00'], [225, '45,00'], [285, '50,00'], [345, '55,00']],
          [[60, '2'], [165, '44,00'], [225, '49,00'], [285, '54,00'], [345, '59,00']],
        ]),
      },
    ]);
    expect(c.sections[0]).toMatchObject({ zones: ['SEHIRICI', '0-200KM', '201-600KM', '1000KM+'], direction: 'domestic' });
    expect(['İl içi', 'İL DIŞI', 'Uzun Hat'].map(distanceZoneCode)).toEqual(['ILICI', 'ILDISI', 'UZUNHAT']);
  });

  it('içe aktarma: otomatik eşleme yapılmaz; DISTANCE_ZONES uyarısı eşlemenin nereden geldiğini söyler', () => {
    const p = parseTariffImport({ fileName: 'liste.pdf', kind: 'pdf', prices: sheetOf(s), zones: null, surcharges: null });
    expect(p.priceZones).toEqual(['SEHIRICI', 'YAKIN', 'ORTA', 'UZAK']);
    expect(p.zones).toEqual([]);
    expect(p.overflow).toEqual([
      { zone: 'SEHIRICI', perUnit: 8 },
      { zone: 'YAKIN', perUnit: 9 },
      { zone: 'ORTA', perUnit: 10 },
      { zone: 'UZAK', perUnit: 11 },
    ]);
    // yeni tarife (eşleme yok): NO_COUNTRY_MAPPING yerine tek, açıklayıcı uyarı
    const fresh = ctx({ newTariff: true });
    expect(codes(p, fresh, 'warning')).toEqual(['DISTANCE_ZONES']);
    const w = checkTariffImport(p, fresh).find((c) => c.code === 'DISTANCE_ZONES')!;
    expect(w.title).toBe('Mesafe bölgeleri okundu (SEHIRICI, YAKIN, ORTA, UZAK); fatura satırlarıyla eşlemek için bölge eşlemesini kontrol edin');
    expect(w.detail).toContain('varış ülkesinden');
    expect(w.detail).toContain('"Tarife yok"');
    // mevcut eşleme * → YAKIN: korunur, yurt içi gönderilerin hepsi Yakın fiyatıyla karşılaştırılır
    const kept = ctx({ currentZones: [{ country: '*', zone: 'YAKIN' }] });
    expect(codes(p, kept, 'error')).toEqual([]);
    expect(checkTariffImport(p, kept).find((c) => c.code === 'DISTANCE_ZONES')!.detail).toContain('* satırındaki "YAKIN" bölgesinin');
    // mevcut eşleme * → TR (eski tek sütunlu tarife): mevcut kontrol hatası (TR fiyatı yok) aynen kalır
    expect(codes(p, ctx({ currentZones: [{ country: '*', zone: 'TR' }] }), 'error')).toEqual(['ZONE_MAPPING_MISSING']);
  });

  it('çok bölgeli normal tablolar ve tek sütunlu yurt içi listeler etkilenmez', () => {
    const scan2 = scanPdfLayout([
      {
        items: page([
          [[60, 'Weight (kg)'], [180, 'Zone A'], [240, 'Zone B']],
          [[60, '1'], [185, '10,00'], [245, '12,00']],
          [[60, '2'], [185, '11,00'], [245, '13,00']],
        ]),
      },
    ]);
    expect(scan2.sections[0]).toMatchObject({ zones: ['A', 'B'], direction: null });
    expect(scan2.sections[0]!.notes).toBeUndefined();
    const p = parseTariffImport({ fileName: 't.xlsx', kind: 'xlsx', prices: [['Desi', 'A', 'B'], ['1', '10', '12']], zones: null, surcharges: null });
    expect(codes(p, ctx(), 'warning')).not.toContain('DISTANCE_ZONES');
  });
});

describe('Excel: mesafe sütunları', () => {
  it('başlıklar PDF ile aynı koda çevrilir ("Bölge içi" artık "içi"ye kısalmaz); not "sadeleştirildi"', async () => {
    const raw = await readTariffFile(
      'mesafe.xlsx',
      await xlsx([
        ['Desi', 'Şehir içi', 'Bölge içi', 'Yakın', 'Uzak'],
        [1, 40, 45, 50, 55],
        [2, 44, 49, 54, 59],
      ]),
    );
    const p = parseTariffImport(raw);
    expect(p.priceZones).toEqual(['SEHIRICI', 'BOLGEICI', 'YAKIN', 'UZAK']);
    expect(p.zoneRenames.map((r) => `${r.from}→${r.to}`)).toEqual(['Şehir içi→SEHIRICI', 'Bölge içi→BOLGEICI', 'Yakın→YAKIN', 'Uzak→UZAK']);
    expect(codes(p, ctx(), 'warning')).toContain('DISTANCE_ZONES');
  });
});

describe('Excel "Aşım" satırının birimi', () => {
  it('overflowUnitStep: kg başı / her ilave kg / desi başı → 1; her ilave 0,5 kg → 0,5; birimsiz → null', () => {
    expect(
      ['Aşım (kg başı)', 'Aşım - her ilave kg', 'AŞIM HER KG', 'Aşım (desi başı)', 'Aşım her ilave desi', 'Overflow per kg', 'Aşım TL/kg', 'Aşım (her ilave lb)'].map(overflowUnitStep),
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(['Aşım (her ilave 0,5 kg)', 'Aşım her ek 0.5 kg', 'Aşım (0,5 kg başı)', 'Aşım (her 2 desi)'].map(overflowUnitStep)).toEqual([0.5, 0.5, 0.5, 2]);
    expect(['Aşım', 'Aşım (her ek birim)', 'Overflow', 'Aşım (TL)'].map(overflowUnitStep)).toEqual([null, null, null, null]);
  });

  it('overflowUnitStep: "30 desi/kg üzeri" eşiktir, 30 kg basamak değil (birim yazmıyor → null)', () => {
    expect(['Aşım (30 desi/kg üzeri)', 'Aşım 30 kg/desi üstü', 'Aşım (30 kg/ds üzeri)'].map(overflowUnitStep)).toEqual([null, null, null]);
    // eşik + birim birlikte: birim okunur
    expect(['Aşım (30 desi/kg üzeri her desi/kg)', 'Aşım (kg/desi başı)', 'Aşım Ücreti / Kg', 'Aşım (30 kg/desi üzeri, kg başı)'].map(overflowUnitStep)).toEqual([1, 1, 1, 1]);
  });

  // Mevcut tarife 0,5 kg basamaklı; taşıyıcı aşımı kg başı 20 TL yazmış. Tablo 2 kg'da bitiyor.
  const current = ctx({ currentWeightSteps: [{ upto: null, step: 0.5 }] });
  const table = (label: string, perUnit = 20): Promise<Uint8Array> =>
    xlsx([['Ağırlık (kg)', 'TR'], [0.5, 50], [1, 55], [1.5, 60], [2, 65], [label, perUnit]], [['Ülke kodu', 'Bölge'], ['*', 'TR']]);
  const quote = (p: ParsedTariffImport, kg: number) => {
    const tariff: TariffInput = {
      id: 't',
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: importWeightSteps(p, current)!,
      discountPct: 0,
      fuelPct: 0,
      zones: { '*': 'TR' },
      rates: p.rates.map((r) => ({ zone: r.zone, weightUpto: r.weightUpto, price: r.price })),
      overflowPerUnit: Object.fromEntries(p.overflow.map((o) => [o.zone, o.perUnit])),
      surcharges: [],
    };
    return expectedCharge({ tariff, chargeableKg: kg, destCountry: 'TR' });
  };

  it('birim yoksa (eski davranış): son basamak 0,5 kullanılır → kg başı 20 TL, 4 kg\'da iki kat (4 × 20); uyarı verilir', async () => {
    const p = parseTariffImport(await readTariffFile('a.xlsx', await table('Aşım')));
    expect(p.overflowStep).toBeNull();
    expect(importWeightSteps(p, current)!.at(-1)).toEqual({ upto: null, step: 0.5 });
    expect(quote(p, 4)).toMatchObject({ ok: true, base: 65 + 4 * 20 });
    const w = checkTariffImport(p, current).find((c) => c.code === 'OVERFLOW_UNIT_MISSING')!;
    expect(w).toMatchObject({ severity: 'warning', rows: [6] });
    expect(w.title).toBe('Aşım satırında birim yazmıyor; tutar 2,0 kg üstünde her 0,5 kg için sayılacak');
    expect(w.detail).toContain('iki kat');
  });

  it('"Aşım (kg başı)": basamak 1 kg → 4 kg = 2 kg fiyatı + 2 × 20; uyarı yok', async () => {
    const p = parseTariffImport(await readTariffFile('b.xlsx', await table('Aşım (kg başı)')));
    expect(p.overflowStep).toBe(1);
    expect(importWeightSteps(p, current)).toEqual([
      { upto: 2, step: 0.5 },
      { upto: null, step: 1 },
    ]);
    expect(quote(p, 4)).toMatchObject({ ok: true, base: 65 + 2 * 20 });
    expect(quote(p, 3.2)).toMatchObject({ ok: true, base: 65 + 2 * 20 }); // 3,2 → 4 kg'a yuvarlanır
    expect(codes(p, current, 'warning')).not.toContain('OVERFLOW_UNIT_MISSING');
  });

  it('"Aşım (her ilave 0,5 kg)" ve "Aşım (desi başı)" birimlerine göre', async () => {
    const half = parseTariffImport(await readTariffFile('c.xlsx', await table('Aşım (her ilave 0,5 kg)', 10)));
    expect(half.overflowStep).toBe(0.5);
    expect(quote(half, 4)).toMatchObject({ ok: true, base: 65 + 4 * 10 });
    const desi = parseTariffImport(await readTariffFile('d.xlsx', await table('Aşım (desi başı)')));
    expect(desi.overflowStep).toBe(1);
    expect(quote(desi, 4)).toMatchObject({ ok: true, base: 65 + 2 * 20 });
  });

  it('birim yok ve basamak 1 kg: uyarı yine verilir ama "iki kat" denmez; şablonun "her ek birim" etiketi uyarı vermez', async () => {
    const sheet = (label: string) => parseTariffImport({ fileName: 'e.xlsx', kind: 'xlsx', prices: [['Desi', 'TR'], ['1', '50'], ['2', '60'], [label, '7']], zones: null, surcharges: null });
    const w = checkTariffImport(sheet('Aşım'), ctx()).find((c) => c.code === 'OVERFLOW_UNIT_MISSING')!;
    expect(w.title).toContain('her 1 kg için');
    expect(w.detail).not.toContain('iki kat');
    // "Aşım (her ek birim)" = tarifenin basamağı başına (DeciShip şablonu, çok bantlı üst basamakta) → bilerek yazılmış
    const tpl = sheet('Aşım (her ek birim)');
    expect(tpl.overflowStep).toBeNull();
    expect(codes(tpl, ctx({ currentWeightSteps: [{ upto: 20, step: 0.5 }, { upto: null, step: 1 }] }), 'warning')).not.toContain('OVERFLOW_UNIT_MISSING');
  });
});

describe('Ülke hücresi: ad + kod yan yana', () => {
  it('"Germany DEU", "DEU Germany", "Almanya - DE", "UNITED KINGDOM GBR"', () => {
    expect(['Germany DEU', 'DEU Germany', 'Almanya - DE', 'UNITED KINGDOM GBR', 'GBR: United Kingdom', 'Fransa (FRA)', 'Amerika Birleşik Devletleri USA'].map(countryNameToIso2)).toEqual([
      'DE',
      'DE',
      'DE',
      'GB',
      'GB',
      'FR',
      'US',
    ]);
  });

  it('ad ile kod çelişirse tahmin edilmez; ad tanınmazsa kod tek başına kabul edilmez', () => {
    expect(countryNameToIso2('Germany FRA')).toBeNull();
    expect(countryNameToIso2('Xyzland DEU')).toBeNull();
    expect(countryNameToIso2('Xyzland VE')).toBeNull();
  });

  it('bölge/zone gibi ülke olmayan metin + kod yanlış pozitif vermez', () => {
    for (const s of ['Bölge 3 TUR', 'Bolge 3 TUR', 'Zone A ARE', 'Zone 3 - IND', 'Region 2 DEU', 'Grup B FRA', 'XYZ AUT']) {
      expect(countryNameToIso2(s), s).toBeNull();
    }
  });

  it('yaygın resmî/eski adlar kodla birlikte okunmaya devam eder (ad sözlükte olmalı)', () => {
    const cases: [string, string][] = [
      ['Slovak Republic SVK', 'SK'],
      ['Kyrgyz Republic KGZ', 'KG'],
      ['Lao PDR LAO', 'LA'],
      ['Syrian Arab Republic SYR', 'SY'],
      ['Holland NLD', 'NL'],
      ['The Gambia GMB', 'GM'],
      ['Bahamas, The BHS', 'BS'],
      ['St. Vincent & Grenadines VCT', 'VC'],
      ['Holy See VAT', 'VA'],
      ['Bonaire BES', 'BQ'],
    ];
    expect(cases.map(([s]) => countryNameToIso2(s))).toEqual(cases.map(([, c]) => c));
  });

  it('"Congo - Kinshasa" (Intl adı) Demokratik Kongo, "Congo - Brazzaville" Kongo', () => {
    expect(['Congo - Kinshasa', 'Kongo - Kinşasa', 'Congo - Brazzaville', 'Kongo - Brazavil'].map(countryNameToIso2)).toEqual(['CD', 'CD', 'CG', 'CG']);
  });

  it('korunan davranışlar: Guinea/Gine/Gürcistan, Georgia GA ve Avusturya AUS null, yalnız kod okunur', () => {
    expect(['Guinea GIN', 'Gine GIN', 'GÜRCİSTAN GEO', 'DEU', 'GBR'].map(countryNameToIso2)).toEqual(['GN', 'GN', 'GE', 'DE', 'GB']);
    expect(['Georgia GA', 'Niger NGA', 'Nigeria NER', 'Avusturya AUS'].map(countryNameToIso2)).toEqual([null, null, null, null]);
  });

  it('Bölgeler sayfası (Excel) "Germany DEU" hücrelerini okur', async () => {
    const raw = await readTariffFile(
      'z.xlsx',
      await xlsx(
        [['Ağırlık (kg)', 'A', 'B'], [1, 10, 20]],
        [['Ülke', 'Bölge'], ['Germany DEU', 'A'], ['France FRA', 'A'], ['United States USA', 'B']],
      ),
    );
    const p = parseTariffImport(raw);
    expect(p.zones).toEqual([
      { country: 'DE', zone: 'A' },
      { country: 'FR', zone: 'A' },
      { country: 'US', zone: 'B' },
    ]);
    expect(p.sheetIssues).toEqual([]);
  });
});
