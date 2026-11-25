import { describe, expect, it } from 'vitest';
import { parseTariffImport, parseTrNumber } from '@deciship/core';
import { buildPdfImport, cellNumberFormat, numbersOnPage, titleWithZones, type BuildInput } from '../src/services/tariffPdf.ts';

/**
 * buildPdfImport (saf kısım), uydurma sayılarla. Bazı taşıyıcı PDF'lerinde tablonun sağında görünmeyen bir artık
 * sütun ("ZONE X") metin katmanında durur; hücrelerinde #REF! değil anlamsız sayılar olabilir.
 */
const doc: BuildInput['document'] = {
  carrier: 'FedEx',
  validFrom: '2026-01-05',
  currency: 'USD',
  weightUnit: 'kg',
  dimDivisor: 5000,
  fuel: { kind: 'FIXED_PCT', pct: 5 },
  surchargeNotes: [],
  countryZonePages: [3],
  discountPages: [],
  notes: [],
};

const section = (id: string, zones: string[]): BuildInput['sections'][number] => ({
  id,
  title: `RE ihracat · Avrupa (${zones.join('')})`,
  service: 'FedEx Regional Economy (RE)',
  direction: 'export',
  priceType: 'net',
  packaging: 'all',
  zones,
  weightMin: 0.5,
  weightMax: 1000,
  currency: 'USD',
  pages: [2],
  hasAdditionalStep: false,
  hasPerKgBands: true,
});

const row = (kind: 'weight' | 'perKg', label: string, weight: number | null, cells: string[], from: number | null = null) => ({
  kind,
  label,
  weight,
  from,
  step: null,
  cells,
  page: 2,
});

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    fileName: 'uydurma.pdf',
    sections: [section('c1', ['R', 'S', 'X'])],
    extraction: {
      tables: [
        {
          sectionId: 'c1',
          zones: ['R', 'S', 'X'],
          rows: [
            row('weight', '0.5', 0.5, ['10.00', '11.00', '77.70']),
            row('weight', '1', 1, ['12.00', '13.00', '3.30']),
            row('perKg', '71-99', 99, ['1.10', '1.20', '55.50'], 71),
            row('perKg', '1000 +', null, ['1.10', '1.20', ''], 1000),
          ],
        },
      ],
      countries: [
        { name: 'ALMANYA', zone: 'R', page: 3 },
        { name: 'İTALYA', zone: 'S', page: 3 },
        { name: 'FRANSA', zone: 'S', page: 3 },
      ],
      notes: [],
    },
    document: doc,
    pageTexts: ['', '0.5 10.00 11.00 77.70 1 12.00 13.00 3.30 71-99 1.10 1.20 55.50 1000 + 1.10 1.20', 'ALMANYA R İTALYA S FRANSA S'],
    includeCountryZones: true,
    current: null,
    codeSectionIds: new Set(['c1']),
    ...over,
  };
}

describe('buildPdfImport: ülke listesinde hiç ülkesi olmayan sütun', () => {
  it('alınmaz; bilgi notu yazar, uyarı/fiyat sırası gürültüsü çıkmaz', () => {
    const r = buildPdfImport(input());
    const prices = r.raw.prices!;
    expect(prices[1]).toEqual(['Ağırlık (kg)', 'R', 'S']);
    expect(prices.flat()).not.toContain('77.7');
    const notes = r.issues.find((i) => i.code === 'PDF_NOTES');
    expect(notes?.detail).toContain('X sütununa ülke listesinde hiç ülke atanmamış; fiyatları alınmadı');
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('ülke listesi alınmıyorsa ya da bölge adları listeyle örtüşmüyorsa sütun korunur', () => {
    const noList = buildPdfImport(input({ includeCountryZones: false }));
    expect(noList.raw.prices![1]).toEqual(['Ağırlık (kg)', 'R', 'S', 'X']);
    const otherNames = buildPdfImport(
      input({
        extraction: {
          ...input().extraction,
          countries: [
            { name: 'ALMANYA', zone: '1', page: 3 },
            { name: 'İTALYA', zone: '2', page: 3 },
          ],
        },
      }),
    );
    expect(otherNames.raw.prices![1]).toEqual(['Ağırlık (kg)', 'R', 'S', 'X']);
  });
});

describe('buildPdfImport: başlık ve hizmet önerisi', () => {
  const titled = (zones: string[]) => ({ ...section('c1', zones), title: `RE ihracat · Avrupa (${zones[0]}–${zones[zones.length - 1]}) · 0,5–1000 kg · net` });

  it('bölüm başlığındaki bölge aralığı alınan sütunlara göre ("Avrupa (R–X)" → "Avrupa (R–S)")', () => {
    const r = buildPdfImport(input({ sections: [titled(['R', 'S', 'X'])] }));
    expect(r.sectionTitles).toEqual(['RE ihracat · Avrupa (R–S) · 0,5–1000 kg · net']);
    expect(r.raw.prices![0]![0]).toBe('FedEx RE ihracat · Avrupa (R–S) · 0,5–1000 kg · net — fiyatlar USD');
  });

  it('tüm sütunlar alındıysa ya da başlık başka biçimdeyse başlık aynen kalır', () => {
    expect(buildPdfImport(input({ sections: [titled(['R', 'S', 'X'])], includeCountryZones: false })).sectionTitles).toEqual([
      'RE ihracat · Avrupa (R–X) · 0,5–1000 kg · net',
    ]);
    expect(titleWithZones('IPE · Dünya (A–I)', ['B', 'C'], ['B'])).toBe('IPE · Dünya (A–I)');
    expect(titleWithZones('IPE · Dünya (A–C)', ['A', 'B', 'C'], ['A'])).toBe('IPE · Dünya (A)');
  });

  it('seçilen tabloların tek hizmeti tarifenin hizmet adı olarak önerilir; farklı hizmetlerde öneri yok', () => {
    expect(buildPdfImport(input()).suggestedMeta.service).toBe('FedEx Regional Economy (RE)');
    const two = buildPdfImport(
      input({
        sections: [section('c1', ['R', 'S', 'X']), { ...section('c2', ['R', 'S']), service: 'FedEx International Priority® (IP)' }],
      }),
    );
    expect(two.suggestedMeta.service).toBeUndefined();
  });
});

describe('Y27: sayı biçimi fiyat hücrelerinden; belirsizlik ve eski okumadan sapma asla sessiz değil', () => {
  /** Yapay zekâ taraması (kod değil): doğrulama sayfa metniyle yapılır. Tek tablo, R ve S, sayfa 2. */
  const priced = (pageText: string, cells: string[][]) =>
    buildPdfImport(
      input({
        sections: [section('s1', ['R', 'S'])],
        extraction: { tables: [{ sectionId: 's1', zones: ['R', 'S'], rows: cells.map((c, i) => row('weight', String(i + 1), i + 1, c)) }], countries: [], notes: [] },
        pageTexts: ['', pageText],
        includeCountryZones: false,
        codeSectionIds: new Set(),
      }),
    );
  const pricesOf = (r: ReturnType<typeof priced>) => parseTariffImport(r.raw).rates.map((x) => x.price);
  const unclear = (r: ReturnType<typeof priced>) => r.issues.find((x) => x.code === 'PDF_NUMBER_FORMAT_UNCLEAR');
  /** Y27 öncesi uçtan uca okuma (bağımsız model): hücre parseTrNumber, dosyaya String(v), dosya yine parseTrNumber. */
  const legacy = (c: string) => parseTrNumber(String(parseTrNumber(c)));
  const filler = 'Fiyat listesi, gönderi başına, KDV hariç. ';

  it('kanıt yalnız fiyat hücrelerinden; saat, tarih, yüzde ve 3 haneli tek ayırıcı kanıt değil', () => {
    expect(cellNumberFormat(['1.250', '1,125', '2.000', '1500'])).toMatchObject({ format: 'auto', certain: false, strong: { en: 0, tr: 0 }, weak: { en: 0, tr: 0 } });
    expect(cellNumberFormat(['09.00', '18:30', '27.10.2026', '%12,5', '12.5%'])).toMatchObject({ format: 'auto', weak: { en: 0, tr: 0 } });
    expect(cellNumberFormat(['1.250,00'])).toMatchObject({ format: 'tr', certain: true });
    expect(cellNumberFormat(['1,234.56', '45.20'])).toMatchObject({ format: 'en', certain: true });
    // güçlü kanıt + karşı yönde zayıf kanıt: belirsiz
    expect(cellNumberFormat(['1,234.56', '12,50'])).toMatchObject({ format: 'auto', certain: false });
    // zayıf kanıt: tek yönde en az 3 hücre, kesin değil; çelişkili ya da az: belirsiz
    expect(cellNumberFormat(['12,50', '13,75', '14,20'])).toMatchObject({ format: 'tr', certain: false });
    expect(cellNumberFormat(['12,50', '13,75'])).toMatchObject({ format: 'auto' });
    expect(cellNumberFormat(['12,50', '13,75', '14,20', '15.10'])).toMatchObject({ format: 'auto' });
  });

  it('inceleme karşı örneği 1: saatli Türkçe belge, "1.250" → 1250 (eski kod gibi); belirsiz fiyatlar uyarılı', () => {
    const r = priced('Mesai saatleri 09.00 - 18.00, cumartesi 10.00. Desi 1 A 1.250 B 1.500 2 A 1.750 B 2.000', [['1.250', '1.500'], ['1.750', '2.000']]);
    expect(pricesOf(r)).toEqual([1250, 1500, 1750, 2000]);
    expect(unclear(r)).toMatchObject({ severity: 'warning', title: '4 fiyatın yazımı iki türlü okunabiliyor (ör. 1,250 ya da 1.250); okunan değeri kontrol edin' });
    expect(unclear(r)!.detail).toContain('"1.250" → 1.250');
  });

  it('inceleme karşı örneği 2: yalnız noktalı desi değerleri + "1,125": belirsiz, uyarılı (sessiz 1125 değil)', () => {
    const r = priced(`${filler}Desi 0.5 1.5 2.5 A 1,125 B 2,250`, [['1,125', '2,250']]);
    // eski okuma bile tutarsızdı ("1,125" → 1125 ama "2,250" → 2,25): ikisi de adıyla uyarıda
    expect(pricesOf(r)).toEqual([1125, 2.25]);
    expect(unclear(r)!.detail).toContain('"1,125" → 1.125');
    expect(unclear(r)!.detail).toContain('"2,250" → 2,25');
  });

  it('madde numaralı belge + "1.250,00": güçlü Türkçe kanıt, 1250, uyarı yok', () => {
    const r = priced(`${filler}3.1 Kapsam 3.2 Fiyatlar 1 1.250,00 1.500,00 2 1,125 2.000,00`, [['1.250,00', '1.500,00'], ['1,125', '2.000,00']]);
    expect(pricesOf(r)).toEqual([1250, 1500, 1.125, 2000]);
    expect(unclear(r)).toBeUndefined();
    expect(r.verification).toMatchObject({ checked: 4, matched: 4 });
  });

  it('gerçek İngilizce belge ("1,234.56" güçlü kanıt): 1234.56, "1,125" 1125; sahte "bulunamadı" yok', () => {
    const r = priced('International Priority USD Weight Zone R Zone S 1 45.20 1,234.56 2 1,125 2,310.75 Fuel 12.5%', [['45.20', '1,234.56'], ['1,125', '2,310.75']]);
    expect(pricesOf(r)).toEqual([45.2, 1234.56, 1125, 2310.75]);
    expect(unclear(r)).toBeUndefined();
    expect(r.verification).toMatchObject({ checked: 4, matched: 4, unmatched: [] });
  });

  it('küçük Türkçe tarife (10 fiyat "12,50" tarzı): Türkçe, uyarı yok', () => {
    const cells = [['12,50', '13,75'], ['14,20', '15,10'], ['16,40', '17,30'], ['18,90', '19,60'], ['20,10', '21,80']];
    const r = priced(`${filler}${cells.flat().join(' ')}`, cells);
    expect(pricesOf(r)).toEqual([12.5, 13.75, 14.2, 15.1, 16.4, 17.3, 18.9, 19.6, 20.1, 21.8]);
    expect(unclear(r)).toBeUndefined();
  });

  it('zayıf Türkçe kanıt + "1,125": 1,125 okunur ama eski okumadan (1125) saptığı için uyarılı', () => {
    const r = priced(`${filler}12,50 13,75 14,20 15,10 1,125 16,40`, [['12,50', '13,75'], ['14,20', '15,10'], ['1,125', '16,40']]);
    expect(pricesOf(r)).toEqual([12.5, 13.75, 14.2, 15.1, 1.125, 16.4]);
    expect(unclear(r)).toMatchObject({ title: expect.stringContaining('1 fiyatın') });
    expect(unclear(r)!.detail).toContain('"1,125" → 1,125');
  });

  it('yalnız "1.250" tarzı sayılar: belirsiz, eski okuma (binlik), uyarılı', () => {
    const r = priced(`${filler}1 1.250 2.500 2 3.750 4.125`, [['1.250', '2.500'], ['3.750', '4.125']]);
    expect(pricesOf(r)).toEqual([1250, 2500, 3750, 4125]);
    expect(unclear(r)).toMatchObject({ title: expect.stringContaining('4 fiyatın') });
  });

  it('doğrulama biçimden bağımsız: basılı hâl ya da değer; sayfada olmayan fiyat yine "bulunamadı"', () => {
    expect([...numbersOnPage('2 1,234 1.250')]).toEqual(expect.arrayContaining(['1234.00', '1.23', '1250.00', '1.25']));
    // yapay zekâ "1,234"ü "1234.00" yazdı: değerle eşleşir; uydurma "1,239.56" eşleşmez
    const r = priced('International Priority USD 1 45.20 1,234.56 2 1,234 2,310.75', [['45.20', '1,239.56'], ['1234.00', '2,310.75']]);
    expect(r.verification).toMatchObject({ checked: 4, matched: 3 });
    expect(r.verification!.unmatched).toEqual([{ zone: 'S', weight: 1, price: 1239.56, page: 2 }]);
  });

  it('karşılaştırma: eski okumayla aynı girdilerde sonuç kötüleşmez (her sapma ya kesin biçimle ya uyarıyla)', () => {
    const cases: string[][][] = [
      [['1.250', '1.500'], ['1.750', '2.000']],
      [['1,125', '2,250']],
      [['1.250,00', '1.500,00'], ['1,125', '2.000,00']],
      [['45.20', '1,234.56'], ['1,125', '2,310.75']],
      [['12,50', '13,75'], ['14,20', '15,10'], ['1,125', '16,40']],
      [['12.50', '13.75'], ['14.20', '1.250'], ['0,125', '99']],
      [['1,234', '2,500'], ['3.750', '4,125']],
    ];
    for (const cells of cases) {
      const r = priced(`${filler}${cells.flat().join(' ')}`, cells);
      const got = pricesOf(r);
      const fmt = cellNumberFormat(cells.flat());
      const warned = unclear(r)?.detail ?? '';
      cells.flat().forEach((c, k) => {
        if (got[k] === legacy(c)) return;
        // sapma: ya biçim güçlü kanıtla kesin ya da hücre uyarıda adıyla geçiyor
        expect(fmt.certain || warned.includes(`"${c}"`), `${c}: ${legacy(c)} → ${got[k]}`).toBe(true);
      });
    }
  });
});

describe('K36: tarife PDF ağırlık etiketi "1.500" sessiz kalmaz', () => {
  const withLabels = (rows: ReturnType<typeof row>[], pageText: string) =>
    buildPdfImport(
      input({
        sections: [section('s1', ['R', 'S'])],
        extraction: { tables: [{ sectionId: 's1', zones: ['R', 'S'], rows }], countries: [], notes: [] },
        pageTexts: ['', pageText],
        includeCountryZones: false,
        codeSectionIds: new Set(),
      }),
    );
  const weightUnclear = (r: ReturnType<typeof withLabels>) => r.issues.find((x) => x.code === 'PDF_WEIGHT_FORMAT_UNCLEAR');

  it('biçim kesin değilken "1.500" etiketi okunan değerle uyarılır (1,5 kg mı 1.500 kg mı)', () => {
    const r = withLabels([row('weight', '1', 1, ['10.00', '11.00']), row('weight', '1.500', 1.5, ['12.00', '13.00'])], '1 10.00 11.00 1.500 12.00 13.00');
    expect(weightUnclear(r)).toMatchObject({ severity: 'warning', title: '1 ağırlığın yazımı iki türlü okunabiliyor (ör. 1.500 ya da 1,500: 1,5 kg ya da 1.500 kg); okunan değeri kontrol edin' });
    expect(weightUnclear(r)!.detail).toBe('"1.500" → 1,5 kg');
  });

  // "1,500" artık belirsizdir (kullanıcı kararı 2026-11-14; aşağıdaki ayrı test)
  it('kesin biçimde ("1.250,00" fiyatlar) ve belirsiz olmayan etiketlerde ("1,5", "1500", "1.5") uyarı yok', () => {
    const tr = withLabels([row('weight', '1.500', 1500, ['1.250,00', '1.300,00'])], '1.500 1.250,00 1.300,00');
    expect(weightUnclear(tr)).toBeUndefined();
    const plain = withLabels(
      [row('weight', '1,5', 1.5, ['10.00', '11.00']), row('weight', '1500', 1500, ['12.00', '13.00']), row('weight', '1.5', 1.5, ['14.00', '15.00'])],
      '1,5 10.00 11.00 1500 12.00 13.00 1.5 14.00 15.00',
    );
    expect(weightUnclear(plain)).toBeUndefined();
  });

  it('birim ekli "1.500 KGS" de uyarılır (değer o yazımdan okundu); etiketin başka sayısından okunan değer uyarılmaz', () => {
    const kgs = withLabels([row('weight', '1.500 KGS', 1500, ['10.00', '11.00'])], '1.500 KGS 10.00 11.00');
    expect(weightUnclear(kgs)!.detail).toBe('"1.500 KGS" → 1.500 kg');
    // "Zone 1.500" gibi bir etikette okunan ağırlık 3 ise ambiguous yazımla ilgisi yoktur
    const other = withLabels([row('weight', '3 (1.500)', 3, ['10.00', '11.00'])], '3 (1.500) 10.00 11.00');
    expect(weightUnclear(other)).toBeUndefined();
  });
});

// kullanıcı kararı 2026-11-14: virgüllü "1,500" etiketi de iki türlü okunur
describe('K36: tarife PDF ağırlık etiketi "1,500"', () => {
  it('biçim kesin değilken okunan değerle uyarılır', () => {
    const r = buildPdfImport(
      input({
        sections: [section('s1', ['R', 'S'])],
        extraction: { tables: [{ sectionId: 's1', zones: ['R', 'S'], rows: [row('weight', '1,500', 1.5, ['10.00', '11.00'])] }], countries: [], notes: [] },
        pageTexts: ['', '1,500 10.00 11.00'],
        includeCountryZones: false,
        codeSectionIds: new Set(),
      }),
    );
    expect(r.issues.find((x) => x.code === 'PDF_WEIGHT_FORMAT_UNCLEAR')!.detail).toBe('"1,500" → 1,5 kg');
  });
});

describe('buildPdfImport: poşet / zarf bölümleri', () => {
  it('Pak ve zarf satırları ambalaj etiketiyle yazılır; içe aktarma onları ayrı fiyat listesine alır, koli satırları değişmez', () => {
    const pak = { ...section('c2', ['R', 'S']), packaging: 'pak' as const, title: 'RE ihracat · pak', hasPerKgBands: false };
    const env = { ...section('c3', ['R', 'S']), packaging: 'envelope' as const, title: 'RE ihracat · zarf', hasPerKgBands: false };
    const r = buildPdfImport(
      input({
        includeCountryZones: false,
        sections: [section('c1', ['R', 'S']), pak, env],
        extraction: {
          tables: [
            { sectionId: 'c1', zones: ['R', 'S'], rows: [row('weight', '0.5', 0.5, ['10.00', '11.00']), row('weight', '1', 1, ['12.00', '13.00'])] },
            // poşet tablosunda kg başı satırı alınmaz
            { sectionId: 'c2', zones: ['R', 'S'], rows: [row('weight', '0.5', 0.5, ['7.00', '8.00']), row('weight', '1.5', 1.5, ['9.00', '9.50']), row('perKg', '71-99', 99, ['1.00', '1.00'], 71)] },
            { sectionId: 'c3', zones: ['R', 'S'], rows: [row('weight', 'FedEx Envelope', null, ['5.00', '5.50'])] },
          ],
          countries: [],
          notes: [],
        },
        pageTexts: ['', '0.5 10.00 11.00 1 12.00 13.00 0.5 7.00 8.00 1.5 9.00 9.50 FedEx Envelope 5.00 5.50', ''],
        codeSectionIds: new Set(['c1', 'c2', 'c3']),
      }),
    );
    const labels = r.raw.prices!.slice(2).map((row) => row[0]);
    expect(labels).toEqual(['0,5', '1', 'Pak 0,5', 'Pak 1,5', 'Zarf']);
    const parsed = parseTariffImport(r.raw, {});
    expect(parsed.rates.map((x) => [x.zone, x.weightUpto, x.price])).toEqual([
      ['R', 0.5, 10],
      ['S', 0.5, 11],
      ['R', 1, 12],
      ['S', 1, 13],
    ]);
    const packs = parsed.packagingRates.map((x) => [x.packaging, x.zone, x.price]);
    expect(packs).toEqual(
      expect.arrayContaining([
        ['PAK', 'R', 7],
        ['PAK', 'S', 9.5],
        ['ENVELOPE', 'R', 5],
        ['ENVELOPE', 'S', 5.5],
      ]),
    );
    expect(packs).toHaveLength(6);
  });
});
